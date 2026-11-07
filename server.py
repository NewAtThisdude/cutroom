#!/usr/bin/env python3
"""Cutroom: a local CapCut-style editor. Stdlib-only backend.

  python3 -I server.py             UI on http://127.0.0.1:4610
  python3 -I server.py --selftest  render synthetic projects through ffmpeg and assert the output

Same split as CapCut (see README): the browser owns the timeline model, preview and text
rendering; this process is the engine. ffmpeg decodes/composites/encodes, whisper.cpp
transcribes on-device (CapCut sends audio to its cloud ASR), text arrives as a PNG timeline
rasterized by the same canvas code as the preview, so export matches what you saw.
"""
import base64, json, math, mimetypes, os, queue, re, shutil, statistics, subprocess, sys, tempfile, threading, time, uuid
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

PORT = int(os.environ.get('CUTROOM_PORT', '4610'))
HOME = Path(os.environ.get('CUTROOM_HOME', Path.home() / 'Movies' / 'Cutroom'))
WEB = (Path(__file__).resolve().parent / 'web').resolve()
MEDIA, PROJ, EXPORTS, CACHE = (HOME / d for d in ('media', 'projects', 'exports', 'cache'))
WHISPER = os.environ.get('CUTROOM_WHISPER', 'whisper-cli')
MODEL = os.environ.get('CUTROOM_MODEL', str(Path.home() / 'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin'))
VAD = os.environ.get('CUTROOM_VAD', str(HOME / 'models' / 'ggml-silero-v5.1.2.bin'))
CHUNK = 24  # ponytail: main tracks with >24 clips pre-render in chunks so ffmpeg never opens more decoders than this
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'}
PREVIEW_CODECS, PREVIEW_EXT = {'h264', 'hevc', 'vp8', 'vp9'}, {'.mp4', '.mov', '.m4v', '.webm'}  # AV1 gets a proxy: WebKit shows paused AV1 frames empty
CTYPES = {'.mov': 'video/mp4', '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.js': 'text/javascript', '.ttf': 'font/ttf'}
XFADES = {'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown',
          'circleopen', 'circleclose', 'zoomin'}  # the UI mirrors these per pixel
BLENDS = {  # overlay blend modes = the canvas's W3C formulas as lut2 expressions; x = backdrop, y = clip, 0..255 (ffmpeg's own blend modes differ)
    'multiply': 'x*y/255', 'screen': 'x+y-x*y/255', 'darken': 'min(x,y)', 'lighten': 'max(x,y)',
    'overlay': 'if(lte(x,127.5),2*x*y/255,255-2*(255-x)*(255-y)/255)',
    'hard-light': 'if(lte(y,127.5),2*x*y/255,255-2*(255-x)*(255-y)/255)',
    'soft-light': 'if(lte(y,127.5),x-(255-2*y)*x*(255-x)/65025,x+(2*y-255)*(if(lte(x,63.75),((16*x/255-12)*x/255+4)*x/255,sqrt(x/255))*255-x)/255)',
    'color-dodge': 'if(eq(x,0),0,if(eq(y,255),255,min(255,x*255/(255-y))))',
    'color-burn': 'if(eq(x,255),255,if(eq(y,0),0,255-min(255,(255-x)*255/y)))',
    'difference': 'abs(x-y)', 'exclusion': 'x+y-2*x*y/255'}
NOVELTY_VOICES = {'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox'}
ID = re.compile(r'[a-f0-9]{12}')
HEX = re.compile(r'#[0-9a-fA-F]{6}')
JOBS = {}
REMOTE_Q, REMOTE_WAIT, REMOTE_SEEN, REMOTE_SENT = queue.Queue(), {}, [0.0], {}  # commands from the Cutroom MCP server; the open editor page runs them


def remote_reoffer(m):  # sent but never acknowledged (the page reloaded mid-poll): offer it again while its caller still waits
    if REMOTE_SENT.pop(m['id'], None) and m['id'] in REMOTE_WAIT:
        REMOTE_Q.put(m)


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, errors='replace')


def meta(mid):
    if not ID.fullmatch(str(mid)):
        raise ValueError('bad media id')
    return json.loads((MEDIA / f'{mid}.json').read_text())


def save_meta(m):
    (MEDIA / f"{m['id']}.json").write_text(json.dumps(m))


def probe(path):
    r = sh(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)])
    if r.returncode:
        raise ValueError('unsupported file')
    j = json.loads(r.stdout)
    v = next((s for s in j['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')), None)
    info = {'hasAudio': any(s['codec_type'] == 'audio' for s in j['streams']), 'duration': float(j['format'].get('duration') or 0)}
    if v:
        rot = v.get('tags', {}).get('rotate') or next((d['rotation'] for d in v.get('side_data_list', []) if 'rotation' in d), 0)
        w, h = int(v['width']), int(v['height'])
        if abs(int(float(rot))) % 180 == 90:  # phone footage: ffmpeg and the browser both auto-rotate
            w, h = h, w
        fr = v.get('avg_frame_rate', '0/1').split('/')
        info['fps'] = round(int(fr[0]) / int(fr[1]), 3) if len(fr) == 2 and fr[1] not in ('', '0') else 30
        info['trans'] = v.get('pix_fmt', '') in ('rgba', 'bgra', 'argb', 'abgr', 'ya8', 'pal8', 'yuva420p') or v['codec_name'] == 'gif'
        info.update(w=w, h=h, codec=v['codec_name'], rot=int(float(rot)),
                    hdr=v.get('color_transfer') in ('arib-std-b67', 'smpte2084'),  # HLG / PQ (iPhone HDR is HLG)
                    cs=v.get('color_space', ''),
                    alpha=v['codec_name'] == 'vp9' and v.get('tags', {}).get('alpha_mode') == '1')
    return info


def import_file(name, stream, length, background=True):
    mid = uuid.uuid4().hex[:12]
    ext = Path(name).suffix.lower()
    ext = ext if re.fullmatch(r'\.[a-z0-9]{1,5}', ext) else '.bin'
    dst = MEDIA / f'{mid}{ext}'
    with open(dst, 'wb') as f:
        while length > 0:
            b = stream.read(min(length, 1 << 20))
            if not b:
                break
            f.write(b)
            length -= len(b)
    if ext == '.heic':  # Chrome can't decode HEIC; sips ships with macOS
        jpg = dst.with_suffix('.jpg')
        sh(['sips', '-s', 'format', 'jpeg', str(dst), '--out', str(jpg)])
        dst.unlink()
        dst, ext = jpg, '.jpg'
    try:
        info = probe(dst)
    except ValueError:
        dst.unlink()
        raise
    animated = ext == '.gif' and info['duration'] > 0.15  # animated GIF stickers behave like (transparent) video
    kind = 'image' if ext in IMAGE_EXT and not animated else 'video' if 'w' in info else 'audio' if info['hasAudio'] else None
    if not kind or (kind == 'image' and 'w' not in info):
        dst.unlink()
        raise ValueError('no audio or video in this file')
    if kind == 'image':
        info.update(duration=0, hasAudio=False, hdr=False)
    m = {'id': mid, 'name': Path(name).name[:200], 'file': dst.name, 'kind': kind, **info, 'ready': kind == 'image', 'added': time.time()}
    save_meta(m)
    if kind != 'image':
        threading.Thread(target=prepare, args=(m,), daemon=True).start() if background else prepare(m)
    return m


def alpha_mov(m):
    """Transparent media for WebKit (the Mac app): HEVC with alpha, which it decodes with transparency (it drops
    VP9's alpha). Chrome keeps using the VP9 WebM; exports always read the original file."""
    out = CACHE / f"{m['id']}.alpha.mov"
    if not out.exists():
        dec = ['-c:v', 'libvpx-vp9'] if m.get('alpha') else []
        tmp = out.with_suffix('.tmp.mov')
        if sh(['ffmpeg', '-v', 'error', '-y', *dec, '-i', str(MEDIA / m['file']), '-vf', "scale=-2:'min(720,ih)',format=bgra", '-c:v', 'hevc_videotoolbox',
               '-alpha_quality', '0.75', '-tag:v', 'hvc1', '-an', str(tmp)]).returncode == 0:
            tmp.replace(out)
    return out if out.exists() else None


def prepare(m):
    """Timeline assets, like CapCut's material cache: filmstrip, waveform, preview proxy."""
    src, mid, d = str(MEDIA / m['file']), m['id'], max(m['duration'], 0.1)
    if m['kind'] == 'video':
        n = max(4, min(60, round(d / 1.5)))
        if not sh(['ffmpeg', '-v', 'error', '-y', '-hwaccel', 'videotoolbox', '-i', src, '-vf', f'fps={n}/{d:.3f},scale=-2:72,tile={n}x1',
                   '-frames:v', '1', '-q:v', '5', str(CACHE / f'{mid}.strip.jpg')]).returncode:
            m['stripN'] = n
        if m.get('trans') and not m.get('alpha'):  # e.g. GIF: preview proxy keeps transparency (VP9 alpha WebM)
            m['proxy'] = not sh(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', "scale=-2:'min(720,ih)',format=yuva420p", '-c:v', 'libvpx-vp9', '-b:v', '0',
                                 '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-an', str(CACHE / f'{mid}.proxy.webm')]).returncode
        elif m.get('codec') not in PREVIEW_CODECS or Path(m['file']).suffix.lower() not in PREVIEW_EXT:  # e.g. ProRes, MKV
            m['proxy'] = not sh(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'h264_videotoolbox', '-b:v', '5M',
                                 '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(CACHE / f'{mid}.proxy.mp4')]).returncode
    if m['kind'] == 'video' and (m.get('alpha') or m.get('trans')):
        alpha_mov(m)
    if m['hasAudio']:
        m['wave'] = not sh(['ffmpeg', '-v', 'error', '-y', '-i', src, '-filter_complex',
                            'aformat=channel_layouts=mono,showwavespic=s=1600x80:colors=0x7ee0c3:scale=sqrt',
                            '-frames:v', '1', str(CACHE / f'{mid}.wave.png')]).returncode
    m['ready'] = True
    save_meta(m)


def transcribe(mid, lang='auto'):
    """Word-level timestamps for a media file, cached. On-device whisper.cpp (CapCut uses cloud ASR)."""
    lang = lang if re.fullmatch(r'auto|[a-z]{2,3}', str(lang)) else 'auto'
    m, cache = meta(mid), CACHE / f'{mid}.{lang}.words.json'
    if cache.exists():
        return json.loads(cache.read_text())
    if not shutil.which(WHISPER) or not Path(MODEL).exists():
        raise RuntimeError('whisper.cpp is not set up: brew install whisper-cpp, and point CUTROOM_MODEL at a ggml model')
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        wav, base = Path(td) / 'a.wav', Path(td) / 'out'
        if sh(['ffmpeg', '-v', 'error', '-y', '-i', str(MEDIA / m['file']), '-vn', '-ac', '1', '-ar', '16000', str(wav)]).returncode:
            raise RuntimeError('could not read audio')
        preset = re.search(r'ggml-(tiny|base|small|medium|large-v[123](?:-turbo)?)(\.en)?', Path(MODEL).name)
        dtw = ['-nfa', '-dtw', preset[1].replace('-', '.') + (preset[2] or '')] if preset else []  # DTW needs flash-attn off
        r = sh([WHISPER, '-m', MODEL, '-f', str(wav), '-l', lang, '-ojf', '-of', str(base), '-np', *dtw])
        if r.returncode:
            raise RuntimeError('whisper failed: ' + r.stderr[-300:])
        # surrogateescape: non-Latin characters can be split across tokens; bytes are rejoined per word below
        segs = json.loads(base.with_suffix('.json').read_text(encoding='utf-8', errors='surrogateescape'))['transcription']
        speech = None  # Silero VAD runs separately: whisper's own --vad reports DTW times on the silence-stripped timeline
        if Path(VAD).exists() and shutil.which('whisper-vad-speech-segments'):
            v = sh(['whisper-vad-speech-segments', '-vm', VAD, '-f', str(wav)])
            speech = [(float(a) / 100, float(b) / 100) for a, b in re.findall(r'start = ([\d.]+), end = ([\d.]+)', v.stdout)] if not v.returncode else None
    words = words_from_tokens([t for s in segs for t in s.get('tokens', [])], m['duration'])
    if speech is not None:  # whisper hallucinates on music ("The end of the day..."): keep only words VAD hears as speech
        words = [w for w in words if any(a - 0.2 <= (w['s'] + w['e']) / 2 <= b + 0.2 for a, b in speech)]
    cache.write_text(json.dumps(words))
    return words


def words_from_tokens(toks, dur):
    """Group whisper tokens into timed words. whisper's default token times smear words across pauses
    (seen: a word placed 0.9 s into the silence after it), so timing comes from DTW alignment points,
    which land near each token's centre: a word spans halfway to its neighbours, at most 0.25 s past its tokens."""
    raw = lambda s: s.encode('utf-8', 'surrogateescape').decode('utf-8', 'ignore')
    ws = []
    for t in toks:
        txt = t['text']
        if re.match(r'\s*(\[_|<\|)', txt):  # [_BEG_], [_TT_n] timestamp/special tokens
            continue
        at = t['t_dtw'] / 100 if t.get('t_dtw', -1) >= 0 else (t['offsets']['from'] + t['offsets']['to']) / 2000
        if txt.startswith(' ') or not ws:
            ws.append({'parts': [txt.lstrip()], 'a': at, 'z': at})
        else:
            ws[-1]['parts'].append(txt)
            if re.search(r'\w', raw(txt)):  # punctuation keeps the word's timing
                ws[-1]['z'] = at
    out = []
    for i, w in enumerate(ws):
        text = ''.join(w['parts']).encode('utf-8', 'surrogateescape').decode('utf-8', 'replace').strip()
        if not re.search(r'\w', text) or re.fullmatch(r'\[.*\]|\(.*\)', text):  # [BLANK_AUDIO], (music)
            continue
        s = w['a'] - 0.25 if i == 0 else max(w['a'] - 0.25, (ws[i - 1]['z'] + w['a']) / 2)
        e = w['z'] + 0.25 if i + 1 == len(ws) else min(w['z'] + 0.25, (w['z'] + ws[i + 1]['a']) / 2)
        s = max(0.0, s)
        e = max(e, s + 0.05)
        out.append({'w': text, 's': round(min(s, dur - 0.05) if dur else s, 3), 'e': round(min(e, dur) if dur else e, 3)})
    return out


def voices():
    found = {}
    for line in sh(['say', '-v', '?']).stdout.splitlines():
        m = re.match(r'(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#', line)
        if m and m[1] not in NOVELTY_VOICES:
            found[m[1]] = m[2]
    return [{'name': n, 'lang': l} for n, l in sorted(found.items(), key=lambda v: (v[1] != 'en_US', v[1], v[0]))]


def tts(text, voice, rate):
    """CapCut's text-to-speech, using the Mac's own voices (say)."""
    text = str(text).strip()[:5000]
    if not text:
        raise ValueError('nothing to say')
    if voice not in {v['name'] for v in voices()}:
        raise ValueError('unknown voice')
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        script, out = Path(td) / 'script.txt', Path(td) / 'voice.aiff'
        script.write_text(text)
        r = sh(['say', '-v', voice, '-r', str(int(fnum(rate, 90, 400))), '-o', str(out), '-f', str(script)])
        if r.returncode or not out.exists():
            raise RuntimeError('say failed: ' + r.stderr[-200:])
        with open(out, 'rb') as fh:
            return import_file(f"Voiceover - {' '.join(text.split()[:5])}.aiff", fh, out.stat().st_size)


def beats(mid):
    """Beat grid for a music file (CapCut's 'Beats'): onset envelope -> tempo (autocorrelation, 120 BPM prior)
    -> dynamic-programming beat tracking (Ellis 2007), so the grid follows small tempo drifts."""
    m, cache = meta(mid), CACHE / f'{mid}.beats.json'
    if cache.exists():
        return json.loads(cache.read_text())
    sr, hop = 8000, 128  # 62.5 onset frames per second
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(MEDIA / m['file']), '-vn', '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'], capture_output=True).stdout
    x = array('h')
    x.frombytes(raw[:len(raw) // 2 * 2])
    n, fps = len(x) // hop, sr / hop
    if n < fps * 4:
        raise ValueError('need at least 4 seconds of audio')
    env = [math.log1p(sum(v * v for v in x[i * hop:(i + 1) * hop]) / hop / 1e4) for i in range(n)]
    on = [0.0] + [max(0.0, env[i] - env[i - 1]) for i in range(1, n)]
    sd = statistics.pstdev(on) or 1.0
    on = [v / sd for v in on]
    prior = lambda L: math.exp(-0.5 * math.log2(60 * fps / L / 120) ** 2)
    period = max(range(int(60 * fps / 180), int(60 * fps / 60) + 1), key=lambda L: prior(L) * sum(on[i] * on[i - L] for i in range(L, n)))
    score, back = on[:], [-1] * n
    for t in range(n):
        best, arg = -1e9, -1
        for prev in range(max(0, t - 2 * period), max(0, t - period // 2)):
            v = score[prev] - 100 * math.log((t - prev) / period) ** 2
            if v > best:
                best, arg = v, prev
        if arg >= 0:
            score[t], back[t] = on[t] + best, arg
    t = max(range(max(0, n - period), n), key=lambda i: score[i])
    grid = []
    while t >= 0:
        grid.append(t)
        t = back[t]
    out = {'bpm': round(60 * fps / period, 1), 'beats': [round(i / fps, 3) for i in reversed(grid)]}
    cache.write_text(json.dumps(out))
    return out


def still(mid, t):
    """Freeze frame: grab one frame as a new image in the library."""
    m = meta(mid)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        f, src = Path(td) / 'frame.png', str(MEDIA / m['file'])
        if m.get('hdr') and not m.get('alpha'):  # tone-map like video(), or the still imports as 16-bit HLG and breaks the export
            tr = {90: 'transpose=clock,', 180: 'hflip,vflip,', 270: 'transpose=cclock,'}.get(-m.get('rot', 0) % 360, '')
            cmd = ['ffmpeg', '-v', 'error', '-y', '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate', '-ss', f'{t:.3f}', '-i', src,
                   '-vf', f'scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,format=yuv420p,{tr}format=rgb24',
                   '-frames:v', '1', '-update', '1', str(f)]
        else:
            cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', src, '-frames:v', '1', '-update', '1', str(f)]
        if sh(cmd).returncode or not f.exists():
            raise RuntimeError('could not grab that frame')
        with open(f, 'rb') as fh:
            return import_file(f"{Path(m['name']).stem} frame {t:.2f}s.png", fh, f.stat().st_size, background=False)


TOOLS = Path(__file__).resolve().parent / 'tools'


def build_tool(name):
    """Swift helpers (Apple Vision) compile on first use, and again whenever the source changes."""
    src, exe = TOOLS / f'{name}.swift', TOOLS / name
    if not exe.exists() or exe.stat().st_mtime < src.stat().st_mtime:
        r = sh(['swiftc', '-O', str(src), '-o', str(exe)])
        if r.returncode:
            raise RuntimeError(f'could not build {name}: ' + r.stderr[-300:])
    return str(exe)


def run_job(fn, *args):
    job = uuid.uuid4().hex[:12]
    JOBS[job] = {'state': 'running', 'progress': 0.0}

    def go():
        try:
            JOBS[job].update(state='done', progress=1.0, **fn(JOBS[job], *args))
        except Exception as e:  # surfaced to the UI
            JOBS[job].update(state='error', error=str(e))
    threading.Thread(target=go, daemon=True).start()
    return job


def track(st, mid, t0, t1, box):
    """Follow a box (normalized, display orientation) from t0 to t1 with Vision; returns per-frame boxes."""
    proc = subprocess.Popen([build_tool('track'), str(MEDIA / meta(mid)['file']), f'{t0:.4f}', f'{t1:.4f}', *(f'{box[k]:.5f}' for k in 'xywh')],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    pts, lost = [], False
    for line in proc.stdout:
        d = json.loads(line)
        if d.get('lost'):
            lost = True
            continue
        pts.append({k: d[k] for k in ('t', 'x', 'y', 'w', 'h')})
        st['progress'] = min(1.0, (d['t'] - t0) / max(t1 - t0, 0.01))
    err = proc.stderr.read()
    if proc.wait() or not pts:
        raise RuntimeError(err.strip()[-300:] or 'tracking failed')
    return {'points': pts, 'lost': lost}


def matte(st, mid):
    """Remove the background (Vision person segmentation) -> VP9+alpha WebM, a new library item.
    WebM/VP9 alpha plays transparent in Chrome and is ~30x smaller than the ProRes 4444 the tool writes."""
    m = meta(mid)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        pro, out = Path(td) / 'cut.mov', Path(td) / 'cut.webm'
        proc = subprocess.Popen([build_tool('matte'), str(MEDIA / m['file']), str(pro), 'balanced'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in proc.stdout:
            if line.startswith('progress '):
                st['progress'] = 0.9 * float(line.split()[1])
        err = proc.stderr.read()
        if proc.wait() or not pro.exists():
            raise RuntimeError(err.strip()[-300:] or 'background removal failed')
        tags = json.loads(sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer',
                              '-of', 'json', str(MEDIA / m['file'])]).stdout or '{}').get('streams', [{}])[0]
        # the matte is tagged bt709 even for untagged sources; relabel it like the source or ffmpeg shifts the person's colours
        relabel = f"setparams=colorspace={tags.get('color_space', 'unknown')}:color_primaries={tags.get('color_primaries', 'unknown')}:color_trc={tags.get('color_transfer', 'unknown')}"
        r = sh(['ffmpeg', '-v', 'error', '-y', '-i', str(pro), '-i', str(MEDIA / m['file']), '-map', '0:v', '-map', '1:a?', '-vf', f'{relabel},{MATTE_VF}',
                '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
                '-c:a', 'libopus', '-b:a', '128k', str(out)])
        if r.returncode:
            raise RuntimeError('encoding the cutout failed: ' + r.stderr[-300:])
        with open(out, 'rb') as fh:
            cut = import_file(f"{Path(m['name']).stem} (cutout).webm", fh, out.stat().st_size, background=False)
    return {'media': cut['id']}


def reverse(st, mid):
    """Reversed copy (CapCut 'Reverse'): 2 s pieces reversed (bounded memory), joined last-to-first."""
    m = meta(mid)
    if m['kind'] == 'image':
        raise ValueError('an image has no direction')
    video = m['kind'] == 'video'
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        n, parts = max(1, math.ceil(m['duration'] / 2)), []
        for i in range(n):
            f = Path(td) / f'r{i:04d}.mkv'
            r = sh(['ffmpeg', '-v', 'error', '-y', '-ss', f'{i * 2:.3f}', '-t', '2', '-i', str(MEDIA / m['file']),
                    *(['-vf', 'reverse', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14'] if video else ['-vn']),
                    *(['-af', 'areverse', '-c:a', 'pcm_s16le'] if m['hasAudio'] else ['-an']), str(f)])
            if r.returncode:
                raise RuntimeError('reverse failed: ' + r.stderr[-300:])
            parts.append(f)
            st['progress'] = 0.9 * (i + 1) / n
        (Path(td) / 'list.txt').write_text(''.join(f"file '{f}'\n" for f in reversed(parts)))
        out = Path(td) / ('rev.mp4' if video else 'rev.m4a')
        r = sh(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(Path(td) / 'list.txt'), *(['-c:v', 'copy'] if video else []),
                *(['-c:a', 'aac', '-b:a', '192k'] if m['hasAudio'] else []), '-movflags', '+faststart', str(out)])
        if r.returncode:
            raise RuntimeError('joining the reversed pieces failed: ' + r.stderr[-300:])
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (reversed){out.suffix}", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def stabilize(st, mid):
    """Stabilized copy: ffmpeg deshake, then an 8% zoom to hide the moving edges (no vidstab in this build)."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('only video can be stabilized')
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'stab.mp4'
        vf = f"deshake=rx=48:ry=48:edge=mirror,crop=trunc(iw*0.92/2)*2:trunc(ih*0.92/2)*2,scale={even(m['w'])}:{even(m['h'])}"
        run_ffmpeg(['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', str(MEDIA / m['file']),
                    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'copy', '-movflags', '+faststart', str(out)],
                   m['duration'], lambda x: st.update(progress=0.95 * x))
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (stabilized).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def faces(st, mid, t0, t1):
    """Largest face over time (Apple Vision), for auto-reframe."""
    proc = subprocess.Popen([build_tool('faces'), str(MEDIA / meta(mid)['file']), f'{t0:.4f}', f'{t1:.4f}', '5'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    pts = []
    for line in proc.stdout:
        d = json.loads(line)
        pts.append({k: d[k] for k in ('t', 'x', 'y', 'w', 'h')})
        st['progress'] = min(1.0, (d['t'] - t0) / max(t1 - t0, 0.01))
    err = proc.stderr.read()
    if proc.wait():
        raise RuntimeError(err.strip()[-300:] or 'face detection failed')
    if not pts:
        raise RuntimeError('no face found in this clip')
    return {'points': pts}


def slowmo(st, mid, t0, t1, factor):
    """Smooth slow motion (CapCut 'smooth slow-mo'): motion-interpolated copy of a range at factor x the frame rate,
    so playing it at 1/factor speed still shows a fresh frame every frame."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('only video')
    fps = min(240, m.get('fps', 30) * factor)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'smooth.mp4'
        run_ffmpeg(['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-ss', f'{t0:.4f}', '-t', f'{t1 - t0:.4f}',
                    '-i', str(MEDIA / m['file']), '-vf', f'minterpolate=fps={fps:g}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(out)],
                   t1 - t0, lambda x: st.update(progress=0.95 * x))
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (smooth {factor}x).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


MATTE_VF = 'format=yuva444p'  # matte writes straight alpha (set to 'unpremultiply=inplace=1,...' if that ever changes)


def silences(mid, noise=-35.0, mind=0.5):
    m = meta(mid)
    r = sh(['ffmpeg', '-hide_banner', '-nostats', '-i', str(MEDIA / m['file']), '-vn', '-af', f'silencedetect=noise={noise:g}dB:d={mind:g}', '-f', 'null', '-'])
    st = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', r.stderr)]
    en = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', r.stderr)]
    en += [m['duration']] * (len(st) - len(en))  # silence running to EOF has no end line
    return [[max(0.0, a), b] for a, b in zip(st, en)]


AI_DIR = Path(__file__).resolve().parent / 'ai'
AI_BIN = AI_DIR / '.venv' / 'bin'
AI_ENV = {**{k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}, 'VIRTUAL_ENV': str(AI_DIR / '.venv'), 'PATH': f"{AI_BIN}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
KOKORO = 'mlx-community/Kokoro-82M-bf16'
HUB = Path.home() / '.cache' / 'huggingface' / 'hub'
AI_LOCK = threading.Lock()  # one generation at a time: two image models at once would push the Mac into swap


def ai_status():
    """Which on-device generators are installed (weights already on disk: a status call never starts a download)."""
    venv = (AI_BIN / 'python').exists()
    return {'voice': venv and (HUB / f"models--{KOKORO.replace('/', '--')}" / 'snapshots').exists(),
            'image': venv and (HOME / 'ai' / 'z-image-turbo-4bit' / 'mflux_model.json').exists()}


def ai_voices():
    return sorted({f.stem for f in (HUB / f"models--{KOKORO.replace('/', '--')}" / 'snapshots').glob('*/voices/*.safetensors')})


def ai_voice(st, text, voice='af_heart', speed=1.0):
    """Natural speech on this Mac (Kokoro-82M on MLX) -> a library item. The voice prefix picks the language (a = US English, b = UK...)."""
    text = ' '.join(str(text).split())[:5000]
    if not text:
        raise ValueError('nothing to say')
    voice = voice if re.fullmatch(r'[a-z]{2}_[a-z]+', str(voice)) else 'af_heart'
    with AI_LOCK, tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        r = subprocess.run([str(AI_BIN / 'python'), '-I', '-m', 'mlx_audio.tts.generate', '--model', KOKORO, '--text', text, '--voice', voice,
                            '--speed', f'{fnum(speed, 0.5, 2):.2f}', '--lang_code', voice[0], '--output_path', td, '--file_prefix', 'v',
                            '--audio_format', 'wav', '--join_audio'], env=AI_ENV, capture_output=True, text=True, errors='replace')
        f = Path(td) / 'v.wav'
        if r.returncode or not f.exists():
            raise RuntimeError('voice generation failed: ' + (r.stderr or r.stdout)[-300:])
        st['progress'] = 0.9
        with open(f, 'rb') as fh:
            m = import_file(f'AI voice - {text[:40]}.wav', fh, f.stat().st_size, background=False)
    return {'media': m['id']}


def ai_image(st, prompt, w=1024, h=1024, seed=None, steps=8, sticker=False):
    """Text to image on this Mac (Z-Image-Turbo, 4-bit, MLX) -> a library item. sticker: the subject is cut out (Vision)."""
    prompt = ' '.join(str(prompt).split())[:2000]
    if not prompt:
        raise ValueError('describe the image')
    model = HOME / 'ai' / 'z-image-turbo-4bit'
    if not (model / 'mflux_model.json').exists():
        raise RuntimeError('the on-device image model is not installed (README: On-device AI)')
    w, h = (int(fnum(v, 256, 2048)) // 16 * 16 for v in (w, h))
    seed = int(fnum(seed, 0, 2 ** 31)) if seed is not None else int(time.time() * 1000) % 1000000
    full = prompt + (', isolated on a plain light grey background' if sticker else '')  # a plain backdrop lifts cleanly
    with AI_LOCK, tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'img.png'
        proc = subprocess.Popen([str(AI_BIN / 'mflux-generate-z-image-turbo'), '--model', str(model), '--prompt', full, '--width', str(w), '--height', str(h),
                                 '--steps', str(int(fnum(steps, 1, 20))), '--seed', str(seed), '--output', str(out)],
                                env=AI_ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
        tail = ''
        while chunk := proc.stdout.read(128):  # tqdm "3/8 [" -> job progress
            tail = (tail + chunk)[-600:]
            if hit := re.findall(r'(\d+)/(\d+) \[', tail):
                st['progress'] = 0.95 * int(hit[-1][0]) / max(1, int(hit[-1][1]))
        if proc.wait() or not out.exists():
            raise RuntimeError('image generation failed: ' + tail[-300:])
        if sticker:
            cut = Path(td) / 'cut.png'
            if sh([build_tool('lift'), str(out), str(cut)]).returncode == 0 and cut.exists():
                out = cut
        with open(out, 'rb') as fh:
            m = import_file(f"AI {'sticker' if sticker else 'image'} - {prompt[:40]}.png", fh, out.stat().st_size, background=False)
    return {'media': m['id'], 'seed': seed}


def lift(mid):
    """Background removal for photos (any subject: Vision subject lifting) -> a new transparent PNG in the library."""
    m = meta(mid)
    if m['kind'] != 'image':
        raise ValueError('subject lifting is for photos; videos use Remove background (people)')
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'cut.png'
        r = sh([build_tool('lift'), str(MEDIA / m['file']), str(out)])
        if r.returncode == 2:
            raise ValueError('no subject found in this image')
        if r.returncode or not out.exists():
            raise RuntimeError('subject lifting failed: ' + r.stderr[-200:])
        with open(out, 'rb') as fh:
            c = import_file(f"{Path(m['name']).stem} (cutout).png", fh, out.stat().st_size, background=False)
    return {'media': c['id']}


FILLER = re.compile(r'(u+h+m*|u+m+|e+r+m*|h+m+|a+h+|e+h+|m{2,})', re.I)


def fillers(mid, lang='auto'):
    """Filler words (um, uh, er, hmm) from the on-device transcript, cut from the middle of the pause before to the
    middle of the pause after: DTW word edges are approximate, pause midpoints make clean jump cuts."""
    words, sil = transcribe(mid, lang), silences(mid, -35, 0.08)
    def edge(t, before):  # the pause holding t, or the nearest one within 0.25 s on the outer side
        near = [(a, b) for a, b in sil if a - (0.05 if before else 0.25) <= t <= b + (0.25 if before else 0.05)]
        if not near:
            return t
        a, b = (max if before else min)(near, key=lambda ab: ab[1] if before else ab[0])
        return (a + b) / 2
    out = []
    for w in words:
        if FILLER.fullmatch(re.sub(r'\W', '', w['w'])):
            a, b = edge(w['s'], True), edge(w['e'], False)
            if b - a > 0.08:
                out.append({'w': w['w'], 's': round(a, 3), 'e': round(b, 3)})
    return out


def scenes(mid, thr=0.3):
    """Hard cuts inside a video (CapCut's scene detection): ffmpeg's scene score on a small copy, cached."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('scene detection needs a video')
    cache = CACHE / f'{mid}.scenes{thr:.2f}.json'
    if cache.exists():
        return json.loads(cache.read_text())
    r = sh(['ffmpeg', '-hide_banner', '-nostats', '-i', str(MEDIA / m['file']), '-an', '-vf', f"scale=160:-2,select='gt(scene,{thr:.3f})',showinfo", '-f', 'null', '-'])
    times = sorted({round(float(x), 3) for x in re.findall(r'pts_time:([\d.]+)', r.stderr)})
    cache.write_text(json.dumps(times))
    return times


# ---------- render engine: validated plan -> one ffmpeg filtergraph ----------

def fnum(v, lo, hi):
    x = float(v)
    if not lo <= x <= hi:  # also rejects NaN
        raise ValueError(f'value {v!r} outside [{lo}, {hi}]')
    return x


def clean_plan(p):
    """Validate the client's render plan; media ids resolve to files server-side (the client never sends paths)."""
    W, H = int(fnum(p['w'], 16, 8192)), int(fnum(p['h'], 16, 8192))
    out = {'w': W - W % 2, 'h': H - H % 2, 'fps': fnum(p['fps'], 1, 120), 'duration': fnum(p['duration'], 0.04, 6 * 3600),
           'bg': p['bg'] if HEX.fullmatch(str(p.get('bg', ''))) else '#000000',
           'quality': 'best' if p.get('quality') == 'best' else 'fast', 'loud': bool(p.get('loud')),
           'format': p.get('format') if p.get('format') in FORMATS else 'mp4', 'still': fnum(p.get('still', 0), 0, 1e6), 'rate': fnum(p.get('rate', 1), 0.5, 4),
           'name': re.sub(r'[^\w\- ]', '', str(p.get('name', '')))[:80].strip() or 'Cutroom export'}

    def clip(c, timed):
        m = meta(c['media'])
        k = {'path': str(MEDIA / m['file']), 'kind': m['kind'], 'hasAudio': m['hasAudio'],
             'in': fnum(c.get('in', 0), -1e6, 1e6), 'out': fnum(c.get('out', 0), -1e6, 1e6),
             'speed': fnum(c.get('speed', 1), 0.1, 100), 'volume': fnum(c.get('volume', 1), 0, 10),
             'frames': int(fnum(c['frames'], 1, 1e8)), 'fadeIn': fnum(c.get('fadeIn', 0), 0, 60), 'fadeOut': fnum(c.get('fadeOut', 0), 0, 60),
             'fit': c.get('fit') if c.get('fit') in ('fit', 'fill', 'blur') else 'fit', 'opacity': fnum(c.get('opacity', 1), 0, 1),
             'adj': {a: fnum((c.get('adj') or {}).get(a, 1), 0, 4) for a in 'bcs'}}
        if m['kind'] != 'image' and not 0 <= k['in'] < k['out']:
            raise ValueError('empty clip')
        tr = c.get('tr') or {}
        k['tr'] = tr.get('type') if tr.get('type') in XFADES else None
        k['trf'] = int(fnum(tr.get('frames', 0), 0, 1e6)) if k['tr'] else 0
        k.update(hdr=bool(m.get('hdr')) and not m.get('alpha'), rot=int(m.get('rot', 0)), alpha=bool(m.get('alpha')),  # VT decode would drop alpha
                 flip=bool(c.get('flip')), denoise=bool(c.get('denoise')), pitch=bool(c.get('pitch')))
        cr = c.get('crop') or {}
        k['crop'] = {s: fnum(cr.get(s, 0), 0, 0.9) for s in 'lrtb'}
        if k['crop']['l'] + k['crop']['r'] > 0.95 or k['crop']['t'] + k['crop']['b'] > 0.95:
            raise ValueError('crop too large')
        k['look'] = [fnum(v, -3, 3) for v in c['look']] if c.get('look') else None
        if k['look'] is not None and len(k['look']) != 9:
            raise ValueError('look must be a 3x3 matrix')
        ck = c.get('key')
        k['key'] = {'color': ck['color'] if HEX.fullmatch(str(ck.get('color', ''))) else '#00ff00', 'sim': fnum(ck.get('sim', 0.3), 0.01, 1),
                    'blend': fnum(ck.get('blend', 0.1), 0, 1)} if ck else None
        kf = c.get('kf') or []
        if len(kf) > 2000:
            raise ValueError('too many keyframes')
        k['kf'] = [{**{a: fnum(f[a], -1e5, 1e5) for a in ('t', 'w', 'x', 'y', 'op')}, 'a': fnum(f.get('a', 0), -3600, 3600), 'e': 1 if f.get('e') else 0,
                    'u0': fnum(f.get('u0', 0), 0, 1), 'u1': fnum(f.get('u1', 1), 0, 1)}
                   for f in kf] or None
        k['angle'] = fnum(c.get('angle', 0), -3600, 3600)
        k['blend'] = c.get('blend') if c.get('blend') in BLENDS else None
        k['trans'] = bool(m.get('trans'))
        k['untagged_hd'] = m['kind'] == 'video' and m.get('cs') in ('', 'unknown') and max(m.get('w', 0), m.get('h', 0)) >= 720 and not m.get('hdr')
        k['vkf'] = [{'t': fnum(f['t'], -1e5, 1e5), 'v': fnum(f['v'], 0, 10), 'e': 1 if f.get('e') else 0} for f in (c.get('vkf') or [])[:5000]] or None
        if m['kind'] != 'audio':  # source size after crop, in display pixels: rotation and keyframe placement need it
            k['mw'], k['mh'] = m['w'] * (1 - k['crop']['l'] - k['crop']['r']), m['h'] * (1 - k['crop']['t'] - k['crop']['b'])
        k['tone'] = [int(fnum(v, 0, 255)) for v in c['tone']] if c.get('tone') else None  # 256-entry curve made by the UI (exposure, highlights...)
        if k['tone'] is not None and len(k['tone']) != 256:
            raise ValueError('tone curve must have 256 entries')
        k['vig'] = base64.b64decode(c['vig'].split(',')[-1]) if c.get('vig') else None  # vignette multiplier PNG drawn by the UI
        if k['vig'] is not None and not k['vig'].startswith(b'\x89PNG'):
            raise ValueError('vignette must be PNG')
        k['mask'] = base64.b64decode(c['mask'].split(',')[-1]) if c.get('mask') else None
        if k['mask'] is not None and not k['mask'].startswith(b'\x89PNG'):
            raise ValueError('mask must be PNG')
        if timed:
            k['start'] = fnum(c['start'], 0, 6 * 3600)
        if m['kind'] != 'audio' and 'geom' in c:
            k['geom'] = {a: fnum(c['geom'][a], -1e5, 1e5) for a in ('x', 'y', 'w', 'h')}
        elif m['kind'] != 'audio':
            raise ValueError('visual clip without geometry')
        return k

    out['main'] = [clip(c, False) for c in p.get('main', [])]
    out['overlay'] = [clip(c, True) for c in p.get('overlay', [])]
    out['audio'] = [clip(c, True) for c in p.get('audio', [])]
    t = p.get('text') or {}
    out['pngs'] = [base64.b64decode(s.split(',')[-1]) for s in t.get('pngs', [])]
    if any(not b.startswith(b'\x89PNG') for b in out['pngs']):
        raise ValueError('text layer must be PNG')
    out['frames'] = [{'i': int(fnum(f['i'], 0, len(out['pngs']) - 1)), 'start': fnum(f['start'], 0, 1e6), 'end': fnum(f['end'], 0, 1e6)}
                     for f in t.get('frames', [])]
    return out


def even(x):
    return int(round(x / 2)) * 2


def ss3(x):
    return x * x * (3 - 2 * x)


def pw(kf, key, var='t'):
    """Keyframe curve as an ffmpeg expression (same interpolation as the UI's propsAt): linear, or smoothstep
    per segment when the segment's first keyframe has e=1. Segments are chosen by a balanced if() tree: ffmpeg's
    expression parser gives up past ~100 nesting levels, and tracking or ducking easily makes hundreds of points."""
    segs = list(zip(kf, kf[1:]))
    if not segs:
        return f'{kf[0][key]:.4f}'

    def seg(a, b):  # clip() also holds the end values outside the segment, so the outer leaves cover t < first and t > last
        u = f"clip(({var}-{a['t']:.6f})/{max(b['t'] - a['t'], 1e-6):.6f},0,1)"
        if a.get('e'):  # smoothstep, or the part [u0, u1] of it that a cut left this segment with
            r0, r1 = a.get('u0', 0), a.get('u1', 1)
            if (r0, r1) == (0, 1):
                u = f'({u}*{u}*(3-2*{u}))'
            elif ss3(r1) - ss3(r0) > 1e-9:
                w = f'({r0:.6f}+{u}*{r1 - r0:.6f})'
                u = f'(({w}*{w}*(3-2*{w})-{ss3(r0):.6f})/{ss3(r1) - ss3(r0):.6f})'
        return f"{a[key]:.4f}+({b[key] - a[key]:.4f})*{u}"

    def tree(lo, hi):
        if hi - lo == 1:
            return seg(*segs[lo])
        mid = (lo + hi) // 2
        return f"if(lt({var},{segs[mid][0]['t']:.6f}),{tree(lo, mid)},{tree(mid, hi)})"
    return tree(0, len(segs))


def pw_at(kf, key, t):
    """pw() evaluated in Python (per-frame opacity commands)."""
    for a, b in zip(kf, kf[1:]):
        if t < b['t']:
            u = min(1.0, max(0.0, (t - a['t']) / max(b['t'] - a['t'], 1e-6)))
            if a.get('e'):
                r0, r1 = a.get('u0', 0), a.get('u1', 1)
                d = ss3(r1) - ss3(r0)
                u = (ss3(r0 + u * (r1 - r0)) - ss3(r0)) / d if d > 1e-9 else u
            return a[key] + (b[key] - a[key]) * u
    return kf[-1][key]


def rotation(c):
    """Rotate before scaling: the frame grows to its diagonal with transparent corners (positive = clockwise, like canvas)."""
    kf = c.get('kf')
    angles = {f['a'] for f in kf} if kf else {c.get('angle', 0)}
    if all(abs(a) < 0.01 for a in angles):
        return ''
    a = f"({pw(kf, 'a')})*PI/180" if len(angles) > 1 else f'{next(iter(angles)) * math.pi / 180:.6f}'
    return f",format=rgba,rotate=a='{a}':ow='hypot(iw,ih)':oh=ow:c=none"


def look(c):
    if not c.get('look'):
        return ''
    m = c['look']
    return ',colorchannelmixer=' + ':'.join(f'{n}={v:.4f}' for n, v in zip(('rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'), m))


def overlap(a, b):
    """Frames two adjacent main clips share in a transition (0 = hard cut). Same clamp as the UI's trF()."""
    return min(a['trf'], a['frames'] // 2, b['frames'] // 2) if a['tr'] else 0


def atempo(s):
    f = []
    while s < 0.5:
        f.append('atempo=0.5')
        s *= 2
    while s > 2:
        f.append('atempo=2')
        s /= 2
    return ','.join(f + [f'atempo={s:.5f}'])


def adjust(c):
    """Same math as the preview's CSS brightness() contrast() saturate(), applied in sRGB."""
    b, k, s = c['adj']['b'], c['adj']['c'], c['adj']['s']
    if (b, k, s) == (1, 1, 1):
        return ''
    lut = f"'clip((min(val*{b:.4f},255)-127.5)*{k:.4f}+127.5,0,255)'"
    mix = (f'rr={.213 + .787 * s:.4f}:rg={.715 - .715 * s:.4f}:rb={.072 - .072 * s:.4f}:'
           f'gr={.213 - .213 * s:.4f}:gg={.715 + .285 * s:.4f}:gb={.072 - .072 * s:.4f}:'
           f'br={.213 - .213 * s:.4f}:bg={.715 - .715 * s:.4f}:bb={.072 + .928 * s:.4f}')
    return f',format=rgb24,lutrgb=r={lut}:g={lut}:b={lut},colorchannelmixer={mix}'


def graph(p, td):
    """Return (input args, filtergraph). Layer order matches the preview: bg, main, overlays, text."""
    W, H, F, D, BG = p['w'], p['h'], p['fps'], p['duration'], p['bg'].replace('#', '0x')
    ins, fg, mix = [], [], []

    def inp(c, dur):
        if c['kind'] == 'image':
            ins.append(['-loop', '1', '-framerate', f'{F:g}', '-t', f'{dur:.6f}', '-i', c['path']])
        else:  # input seek: each clip decodes only its own range
            dec = (['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate'] if c.get('hdr')
                   else ['-c:v', 'libvpx-vp9'] if c.get('alpha') else [])  # native vp9 decoder drops the alpha plane
            ins.append([*dec, '-ss', f"{c['in']:.6f}", '-t', f"{c['out'] - c['in']:.6f}", '-i', c['path']])
        return len(ins) - 1

    def video(i, c, n):  # tone-mapped, retimed, exactly n frames, cropped, flipped, adjusted, graded
        sp = 1 if c['kind'] == 'image' else c['speed']
        v = f'[{i}:v]'
        if c.get('untagged_hd'):  # what Chrome / QuickTime assume for untagged HD, and what the preview shows
            v += 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,'
        if c.get('hdr'):  # VideoToolbox HDR (HLG/PQ) -> SDR BT.709; rotation applied by hand since autorotate can't touch hw frames
            v += 'scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,format=yuv420p,'
            v += {90: 'transpose=clock,', 180: 'hflip,vflip,', 270: 'transpose=cclock,'}.get(-c['rot'] % 360, '')
        v += f"setpts=(PTS-STARTPTS)/{sp:.6f},fps={F:g},tpad=stop_mode=clone:stop_duration=2,trim=end_frame={n}"
        cr = c.get('crop') or {}
        if any(cr.values()):
            v += (f",crop=w='trunc(iw*{1 - cr['l'] - cr['r']:.5f}/2)*2':h='trunc(ih*{1 - cr['t'] - cr['b']:.5f}/2)*2'"
                  f":x='iw*{cr['l']:.5f}':y='ih*{cr['t']:.5f}'")
        if c.get('flip'):
            v += ',hflip'
        v += adjust(c) + tone(c) + look(c)
        if c.get('key'):  # chroma key -> alpha (same formula as the preview's keyed())
            v += f",format=rgba,colorkey=color={c['key']['color'].replace('#', '0x')}:similarity={c['key']['sim']:.4f}:blend={c['key']['blend']:.4f}"
        return v

    def audio(i, c, dur, delay=0.0):
        live = c['hasAudio'] and c['kind'] != 'image' and (c['volume'] > 0 or c.get('vkf'))
        vol = f"volume='{c['volume']:.4f}*({pw(c['vkf'], 'v')})':eval=frame" if c.get('vkf') else f"volume={c['volume']:.3f}"  # envelope: ducking, fades
        tempo = f"aresample=48000,asetrate={48000 * c['speed']:.3f},aresample=48000" if c.get('pitch') and c['speed'] != 1 else atempo(c['speed'])
        a = f"[{i}:a]asetpts=PTS-STARTPTS,{tempo},{vol}" if live else 'anullsrc=r=48000:cl=stereo'
        if live and c.get('denoise'):
            a += ',afftdn=nr=15:nf=-40:tn=1'
        a += f',aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={dur:.6f},atrim=end={dur:.6f}'
        if c['fadeIn']:
            a += f",afade=t=in:d={c['fadeIn']:.3f}"
        if c['fadeOut']:
            a += f",afade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}"
        if delay:
            a += f',adelay={round(delay * 1000)}:all=1'
        return a

    def tone(c):  # the UI's curve as a 1D LUT (exact at 8-bit inputs, like the preview's feComponentTransfer table)
        if not c.get('tone'):
            return ''
        f = Path(td) / f'tone{len(list(Path(td).glob("tone*.cube")))}.cube'
        f.write_text('LUT_1D_SIZE 256\n' + ''.join(f'{v / 255:.6f} {v / 255:.6f} {v / 255:.6f}\n' for v in c['tone']))
        return f",format=rgb24,lut1d=file='{f}':interp=linear"

    def vignetted(v, c, tag, dur):  # RGB x the UI's multiplier image, alpha untouched (cutouts stay cut out)
        if not c.get('vig'):
            return v
        f = Path(td) / f'vig_{tag}.png'
        f.write_bytes(c['vig'])
        ins.append(['-loop', '1', '-framerate', f'{F:g}', '-t', f'{dur:.6f}', '-i', str(f)])
        j = len(ins) - 1
        return v + (f',format=gbrap,split[{tag}c][{tag}r];[{j}:v]format=gbrap[{tag}g];[{tag}g][{tag}r]scale=w=rw:h=rh[{tag}gs];'  # scale2ref fails on gbrap
                    f'[{tag}c][{tag}gs]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply:c3_mode=normal')

    def opacity(c, tag, n):
        kf = c.get('kf')
        if kf and len({f['op'] for f in kf}) > 1:
            cmds, last = [], None
            for i in range(n):
                v = round(min(1.0, max(0.0, pw_at(kf, 'op', i / F))), 4)
                if v != last:
                    cmds.append(f'{max(0.0, (i - 0.5) / F):.6f} colorchannelmixer@{tag} aa {v};')
                    last = v
            f = Path(td) / f'{tag}.cmd'
            f.write_text('\n'.join(cmds) + '\n')
            return f",format=rgba,sendcmd=f='{f}',colorchannelmixer@{tag}=aa={pw_at(kf, 'op', 0):.4f}"
        op = kf[0]['op'] if kf else c['opacity']
        return f',format=rgba,colorchannelmixer=aa={op:.4f}' if op < 1 else ''

    def masked(v, c, tag, dur):  # mask = PNG drawn by the browser's maskCanvas(); its luma becomes alpha
        if not c.get('mask'):
            return v
        f = Path(td) / f'mask_{tag}.png'
        f.write_bytes(c['mask'])
        ins.append(['-loop', '1', '-framerate', f'{F:g}', '-t', f'{dur:.6f}', '-i', str(f)])
        j = len(ins) - 1
        if c.get('key'):  # key alpha x mask (alphamerge alone would throw the key's alpha away)
            return v + (f',format=rgba,split[{tag}c][{tag}k];[{tag}k]alphaextract[{tag}a];[{j}:v]format=gray[{tag}m];'
                        f'[{tag}m][{tag}a]scale2ref=w=main_w:h=main_h[{tag}ms][{tag}as];[{tag}as][{tag}ms]blend=all_mode=multiply[{tag}am];'
                        f'[{tag}c][{tag}am]alphamerge')
        return v + (f',format=rgba[{tag}c];[{j}:v]format=gray[{tag}m];[{tag}m][{tag}c]scale2ref=w=main_w:h=main_h[{tag}ms][{tag}cs];'
                    f'[{tag}cs][{tag}ms]alphamerge')

    def place(c, var):
        """Foreground scale + position: (scale filters, x, y). One formula for static, keyframed and rotated clips:
        the rect's centre is kept, and a rotated frame is its diagonal (E) wide. Keyframed size changes every
        frame, so convert to rgba BEFORE that scale: a converter after it would keep frame 1's size and crop."""
        g, kf, mw, mh = c['geom'], c.get('kf'), c['mw'], c['mh']
        Ew, Eh = (math.hypot(mw, mh),) * 2 if rotation(c) else (mw, mh)
        if kf:
            S = lambda v_: f"(({pw(kf, 'w', v_)})/{mw:.4f})"
            return (f",format=rgba,scale=w='2*trunc(iw*{S('t')}/2)':h=-2:eval=frame",
                    f"'({pw(kf, 'x', var)})+({pw(kf, 'w', var)})/2-{Ew:.3f}*{S(var)}/2'",
                    f"'({pw(kf, 'y', var)})+({pw(kf, 'w', var)})*{mh / mw:.6f}/2-{Eh:.3f}*{S(var)}/2':eval=frame")
        sw, sh = max(2, even(Ew * g['w'] / mw)), max(2, even(Eh * g['w'] / mw))
        return f',scale={sw}:{sh}', even(g['x'] + g['w'] / 2 - sw / 2), even(g['y'] + g['h'] / 2 - sh / 2)

    for k, c in enumerate(p['main']):  # magnetic main track -> one concat stream
        n = c['frames']
        dur = n / F
        i = inp(c, dur)
        g = c['geom']
        x, y, w, h = even(g['x']), even(g['y']), max(2, even(g['w'])), max(2, even(g['h']))
        v, kf, rot = video(i, c, n), c.get('kf'), rotation(c)
        if c['fit'] == 'blur' or kf or rot or c.get('alpha') or c.get('trans') or c.get('key') or c.get('mask') or c.get('vig') or c['opacity'] < 1:  # composite onto a base frame
            if c['fit'] == 'blur':
                v += (f',split=2[f{k}][b{k}];[b{k}]scale={even(W * 1.08)}:{even(H * 1.08)}:force_original_aspect_ratio=increase,crop={W}:{H},'  # 8% overscan, as the preview
                      f'boxblur={max(2, W // 40)}:3[bb{k}];[f{k}]null')
            else:
                v += f'[f{k}];color=c={BG}:s={W}x{H}:r={F:g}:d={dur:.6f}[bb{k}];[f{k}]null'
            sc, px_, py_ = place(c, 't')
            v = masked(vignetted(v, c, f'mv{k}', dur), c, f'm{k}', dur) + rot + opacity(c, f'mop{k}', n) + sc + f'[ff{k}];[bb{k}][ff{k}]overlay=x={px_}:y={py_}:shortest=1:format=gbrp'
        else:
            cx, cy = max(0, -x), max(0, -y)
            cw, ch = min(w - cx, W - max(0, x)), min(h - cy, H - max(0, y))
            v += (f',scale={w}:{h},crop={cw}:{ch}:{cx}:{cy},pad={W}:{H}:{max(0, x)}:{max(0, y)}:color={BG}' if cw >= 2 and ch >= 2
                  else f',scale={W}:{H},drawbox=c={BG}:t=fill')  # dragged fully off-canvas
        if c['fadeIn']:
            v += f",fade=t=in:st=0:d={c['fadeIn']:.3f}"
        if c['fadeOut']:
            v += f",fade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}"
        fg.append(v + f',format=gbrp,setsar=1,settb=AVTB[v{k}]')  # RGB like the canvas; xfade needs identical timebases on both inputs
        fg.append(audio(i, c, dur) + f'[a{k}]')
    if p['main']:  # cuts concatenate; transitions overlap the two clips (xfade + acrossfade), like CapCut
        cv, ca, n = 'v0', 'a0', p['main'][0]['frames']
        for k in range(1, len(p['main'])):
            prev, c = p['main'][k - 1], p['main'][k]
            o = overlap(prev, c)
            if o:
                fg.append(f"[{cv}][v{k}]xfade=transition={prev['tr']}:duration={o / F:.6f}:offset={(n - o) / F:.6f}[mv{k}]")
                fg.append(f'[{ca}][a{k}]acrossfade=d={o / F:.6f}[ma{k}]')
            else:
                fg.append(f'[{cv}][{ca}][v{k}][a{k}]concat=n=2:v=1:a=1[mv{k}][ma{k}]')
            n += c['frames'] - o
            cv, ca = f'mv{k}', f'ma{k}'
        fg.append(f'[{cv}]null[vm]')
        fg.append(f'[{ca}]anull[am]')
        mix.append('[am]')

    fg.append(f'color=c={BG}:s={W}x{H}:r={F:g}:d={D:.6f},format=gbrp[L0]')
    cur = ['L0']

    def over(src, x=0, y=0):
        nxt = f'L{len(fg)}'
        fg.append(f'[{cur[0]}][{src}]overlay={x}:{y}:eof_action=pass:format=gbrp[{nxt}]')
        cur[0] = nxt

    def blended(src, x, y, mode):  # place the clip on a clear full frame, blend its RGB with the layers below, mix by its alpha
        e, t = f"'{BLENDS[mode]}+0.5'", f'B{len(fg)}'
        fg.append(f'color=c=black@0:s={W}x{H}:r={F:g}:d={D:.6f},format=rgba[{t}e];[{t}e][{src}]overlay={x}:{y}:eof_action=pass:format=auto,format=gbrap[{t}o];'
                  f'[{cur[0]}]split[{t}b][{t}k];[{t}b]format=gbrap[{t}g];[{t}g][{t}o]lut2=c0={e}:c1={e}:c2={e}:c3=y[{t}l]')
        cur[0] = f'{t}k'
        over(f'{t}l')

    if p['main']:
        over('vm')
    for k, c in enumerate(p['overlay']):
        n = c['frames']
        dur = n / F
        i = inp(c, dur)
        g, kf = c['geom'], c.get('kf')
        sc, ox, oy = place(c, f"(t-{c['start']:.6f})")
        v = masked(vignetted(video(i, c, n), c, f'ov{k}', dur), c, f'o{k}', dur) + rotation(c) + ('' if kf else sc) + ',format=rgba' + opacity(c, f'oop{k}', n)
        if c['fadeIn']:
            v += f",fade=t=in:st=0:d={c['fadeIn']:.3f}:alpha=1"
        if c['fadeOut']:
            v += f",fade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}:alpha=1"
        if kf:  # size changes per frame: last step (see place())
            v += sc
        fg.append(v + f",setpts=PTS+{c['start']:.6f}/TB[o{k}]")  # shifted to its timeline start
        if c.get('blend'):
            blended(f'o{k}', ox, oy, c['blend'])
        else:
            over(f'o{k}', ox, oy)
        if c['kind'] == 'video' and c['hasAudio'] and c['volume'] > 0:
            fg.append(audio(i, c, dur, c['start']) + f'[oa{k}]')
            mix.append(f'[oa{k}]')
    for k, c in enumerate(p['audio']):
        dur = c['frames'] / F
        fg.append(audio(inp(c, dur), c, dur, c['start']) + f'[x{k}]')
        mix.append(f'[x{k}]')
    if p['frames']:  # text layer: PNG per interval, played back as a VFR stream by the concat demuxer
        files = []
        for j, b in enumerate(p['pngs']):
            files.append(Path(td) / f't{j}.png')
            files[-1].write_bytes(b)
        lines = ['ffconcat version 1.0']
        for fr in p['frames']:
            lines += [f"file '{files[fr['i']]}'", f"duration {max(0.001, fr['end'] - fr['start']):.6f}"]
        lines.append(f"file '{files[p['frames'][-1]['i']]}'")  # concat demuxer ignores the last duration otherwise
        (Path(td) / 'text.ffconcat').write_text('\n'.join(lines) + '\n')
        ins.append(['-f', 'concat', '-safe', '0', '-i', str(Path(td) / 'text.ffconcat')])
        fg.append(f'[{len(ins) - 1}:v]format=rgba[tx]')
        over('tx')
    fg.append(f'anullsrc=r=48000:cl=stereo,atrim=end={D:.6f}[sil]')
    loud = ',loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' if p.get('loud') else ''  # -14 LUFS, the reels/YouTube target
    fg.append('[sil]' + ''.join(mix) + f'amix=inputs={len(mix) + 1}:duration=first:normalize=0:dropout_transition=0{loud}[aout]')
    fg.append(f'[{cur[0]}]format=rgb24[vout]' if p.get('format') in ('png', 'gif') else  # stills and GIFs stay RGB: no 4:2:0 round trip
              f'[{cur[0]}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]')
    return sum(ins, []), ';'.join(fg)


FORMATS = {'mp4': '.mp4', 'hevc': '.mp4', 'prores': '.mov', 'gif': '.gif', 'mp3': '.mp3', 'wav': '.wav', 'png': '.png'}


def ffmpeg_cmd(p, td, out, intermediate=False):
    ins, fg = graph(p, td)
    W, H, F, fmt = p['w'], p['h'], p['fps'], 'mp4' if intermediate else p.get('format', 'mp4')
    vmap, amap, br = ['-map', '[vout]'], ['-map', '[aout]'], f"{max(2000, round(W * H * F * 0.2 * p.get('rate', 1) / 1000))}k"  # Bitrate: Standard / High / Very high
    if intermediate:
        enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'pcm_s16le']
    elif fmt == 'gif':  # one-graph palette: palettegen + paletteuse; 15 fps keeps files sane
        fg += f';[vout]fps={min(F, 15):g},split[g1][g2];[g1]palettegen=stats_mode=diff[gp];[g2][gp]paletteuse=dither=bayer:bayer_scale=4[gout];[aout]anullsink'
        vmap, amap, enc = ['-map', '[gout]'], [], ['-loop', '0']
    elif fmt == 'png':  # still frame at p['still']
        fg += ';[aout]anullsink'
        amap, enc = [], ['-ss', f"{p['still']:.4f}", '-frames:v', '1', '-update', '1']
    elif fmt in ('mp3', 'wav'):
        fg += ';[vout]nullsink'
        vmap, enc = [], ['-c:a', 'libmp3lame', '-q:a', '2'] if fmt == 'mp3' else ['-c:a', 'pcm_s16le']
    elif fmt == 'prores':
        enc = ['-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le']
    elif fmt == 'hevc':
        enc = ['-c:v', 'hevc_videotoolbox', '-b:v', br, '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '192k']
    elif p['quality'] == 'best':
        enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k']
    else:
        enc = ['-c:v', 'h264_videotoolbox', '-b:v', br, '-profile:v', 'high', '-c:a', 'aac', '-b:a', '192k']
    video = fmt not in ('mp3', 'wav')
    pix = (['-pix_fmt', 'yuv422p10le' if fmt == 'prores' else 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
           if video and fmt not in ('gif', 'png') else [])
    rate = ['-r', f'{F:g}', '-fps_mode', 'cfr'] if video and fmt not in ('gif', 'png') else []
    gf = Path(td) / f'graph{len(list(Path(td).glob("graph*.txt")))}.txt'
    gf.write_text(fg)
    return (['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *ins, '-/filter_complex', str(gf),
             *vmap, *amap, *enc, *pix, *rate] + ([] if fmt == 'png' else ['-t', f"{p['duration']:.6f}"])
            + (['-movflags', '+faststart'] if fmt in ('mp4', 'hevc') and not intermediate else []) + [str(out)])


def run_ffmpeg(cmd, dur, report):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors='replace')
    err = []
    t = threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith('out_time_us=') and line[12:].strip().isdigit():
            report(min(1.0, int(line[12:]) / 1e6 / dur))
    t.join()
    if proc.wait():
        raise RuntimeError(''.join(err)[-1500:].strip() or 'ffmpeg failed')


def unique(path):
    n, base = 2, path
    while path.exists():
        path = base.with_name(f'{base.stem} ({n}){base.suffix}')
        n += 1
    return path


def export(job, p):
    st = JOBS[job]
    try:
        with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
            F, main = p['fps'], p['main']
            chunks = [main[i:i + CHUNK] for i in range(0, len(main), CHUNK)] if len(main) > CHUNK else []
            steps = len(chunks) + 1
            for n, part in enumerate(chunks):  # long main tracks: render chunks to near-lossless intermediates first
                frames = sum(c['frames'] for c in part) - sum(overlap(a, b) for a, b in zip(part, part[1:]))
                sub = {**p, 'main': part, 'overlay': [], 'audio': [], 'frames': [], 'pngs': [], 'duration': frames / F, 'format': 'mp4'}  # chunks are always YUV video
                f = Path(td) / f'chunk{n}.mkv'
                run_ffmpeg(ffmpeg_cmd(sub, td, f, True), frames / F, lambda x, n=n: st.update(progress=(n + x) / steps))
                chunks[n] = {'path': str(f), 'kind': 'video', 'hasAudio': True, 'in': 0, 'out': frames / F, 'speed': 1, 'volume': 1,
                             'frames': frames, 'fadeIn': 0, 'fadeOut': 0, 'fit': 'fit', 'opacity': 1, 'adj': {'b': 1, 'c': 1, 's': 1},
                             'geom': {'x': 0, 'y': 0, 'w': p['w'], 'h': p['h']},
                             'tr': part[-1]['tr'], 'trf': part[-1]['trf']}  # a transition into the next chunk still happens in the final pass
            if chunks:
                p = {**p, 'main': chunks}
            out = unique(EXPORTS / f"{p['name']}{FORMATS[p.get('format', 'mp4')]}")
            run_ffmpeg(ffmpeg_cmd(p, td, out), p['duration'], lambda x: st.update(progress=(steps - 1 + x) / steps))
            if not out.exists() or not out.stat().st_size:
                raise RuntimeError('ffmpeg finished without writing a file')
        st.update(state='done', progress=1.0, file=out.name)
    except Exception as e:  # surfaced to the UI
        st.update(state='error', error=str(e))


def list_projects():
    out = []
    for f in PROJ.glob('*.json'):
        try:
            j = json.loads(f.read_text())
        except ValueError:
            continue
        out.append({'id': f.stem, 'name': j.get('name', 'Untitled'), 'w': j.get('w'), 'h': j.get('h'), 'updated': f.stat().st_mtime,
                    'clips': sum(len(j.get(k, [])) for k in ('main', 'overlay', 'audio', 'text', 'captions'))})
    return sorted(out, key=lambda p: -p['updated'])


# ---------- HTTP ----------

class App(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def allowed(self, mutating):
        # Host check stops DNS rebinding; the custom header forces a CORS preflight we never grant,
        # so other websites can't drive this server even though it listens on localhost.
        ok = self.headers.get('Host') in (f'127.0.0.1:{PORT}', f'localhost:{PORT}') and (not mutating or self.headers.get('X-Cutroom') == '1')
        if not ok:
            self.reply({'error': 'forbidden'}, 403)
        return ok

    def reply(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b)

    def file(self, path):
        size = path.stat().st_size
        start, end = 0, size - 1
        rng = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
        if rng and (rng[1] or rng[2]):  # <video> seeking needs byte ranges
            start, end = (int(rng[1]), int(rng[2] or end)) if rng[1] else (max(0, size - int(rng[2])), end)
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        self.send_header('Content-Type', CTYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                b = f.read(min(left, 1 << 20))
                if not b:
                    break
                try:
                    self.wfile.write(b)
                except (BrokenPipeError, ConnectionResetError):  # the browser aborts ranges it no longer needs
                    return
                left -= len(b)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 300 << 20:
            raise ValueError('request too large')
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if not self.allowed(False):
            return
        path = unquote(urlparse(self.path).path)
        try:
            if path == '/api/remote/next':  # the editor page long-polls for the next command (header required: no other site may take them)
                if self.headers.get('X-Cutroom') != '1':
                    return self.reply({'error': 'forbidden'}, 403)
                REMOTE_SEEN[0] = time.time()
                try:
                    m = REMOTE_Q.get(timeout=20)
                except queue.Empty:
                    m = {}
                REMOTE_SEEN[0] = time.time()
                if m:  # the page acknowledges at once; a write to a page that just went away doesn't fail, so don't trust it
                    REMOTE_SENT[m['id']] = m
                    threading.Timer(5, remote_reoffer, (m,)).start()
                return self.reply(m)
            if path == '/api/ai/status':
                return self.reply({**ai_status(), 'voices': ai_voices()})
            if path == '/api/remote/status':
                return self.reply({'connected': time.time() - REMOTE_SEEN[0] < 30})
            if path == '/api/ping':
                return self.reply({'ok': True, 'whisper': bool(shutil.which(WHISPER)) and Path(MODEL).exists()})
            if path == '/api/media':
                return self.reply(sorted((json.loads(f.read_text()) for f in MEDIA.glob('*.json')), key=lambda m: -m.get('added', 0)))
            if path == '/api/projects':
                return self.reply(list_projects())
            if path == '/api/voices':
                return self.reply(voices())
            if m := re.fullmatch(r'/api/projects/([a-f0-9]{12})', path):
                return self.file(PROJ / f'{m[1]}.json')
            if m := re.fullmatch(r'/api/jobs/([a-f0-9]{12})', path):
                return self.reply(JOBS.get(m[1], {'state': 'missing'}))
            if m := re.fullmatch(r'/media/([a-f0-9]{12})', path):
                if 'hevc' in parse_qs(urlparse(self.path).query).get('alpha', []) and (mm := meta(m[1])).get('kind') == 'video' and (mm.get('alpha') or mm.get('trans')):
                    if mov := alpha_mov(mm):  # made at import; older library items get it on first request
                        return self.file(mov)
                proxy = next((f for f in (CACHE / f'{m[1]}.proxy.mp4', CACHE / f'{m[1]}.proxy.webm') if f.exists()), None)
                return self.file(proxy or MEDIA / meta(m[1])['file'])
            if path == '/api/templates':
                return self.reply(sorted((json.loads(f.read_text()) for f in (HOME / 'templates').glob('*.json')), key=lambda t: t.get('name', '')))
            if m := re.fullmatch(r'/cache/([a-f0-9]{12}\.(?:strip\.jpg|wave\.png))', path):
                return self.file(CACHE / m[1])
            if m := re.fullmatch(r'/exports/([^/]+\.(?:mp4|mov|gif|mp3|wav|png))', path):
                return self.file(EXPORTS / m[1])
            f = (WEB / (path.lstrip('/') or 'index.html')).resolve()
            if WEB in f.parents and f.is_file():
                return self.file(f)
            self.reply({'error': 'not found'}, 404)
        except (FileNotFoundError, ValueError):
            self.reply({'error': 'not found'}, 404)

    def do_POST(self):
        if not self.allowed(True):
            return
        u = urlparse(self.path)
        try:
            if u.path == '/api/import':
                name = parse_qs(u.query).get('name', ['file'])[0]
                return self.reply(import_file(name, self.rfile, int(self.headers.get('Content-Length') or 0)))
            body = self.body()
            if u.path == '/api/transcribe':
                return self.reply({'words': transcribe(body['media'], body.get('lang', 'auto'))})
            if u.path == '/api/remote':  # from the MCP server: hand a command to the editor page and wait for its result
                if time.time() - REMOTE_SEEN[0] > 30:
                    return self.reply({'ok': False, 'result': 'the Cutroom editor is not open'})
                rid, ev = uuid.uuid4().hex[:12], threading.Event()
                REMOTE_WAIT[rid] = {'ev': ev}
                REMOTE_Q.put({'id': rid, 'cmd': str(body.get('cmd', '')), 'args': body.get('args') or {}})
                done = ev.wait(fnum(body.get('timeout', 900), 1, 7200))
                w = REMOTE_WAIT.pop(rid, {})
                return self.reply(w.get('res') if done else {'ok': False, 'result': 'timed out waiting for the editor'})
            if u.path == '/api/still_frame':  # one frame from the export renderer, returned inline (the MCP snapshot tool)
                p = clean_plan({**body, 'format': 'png'})
                with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
                    out = Path(td) / 'frame.png'
                    run_ffmpeg(ffmpeg_cmd(p, td, out), p['duration'], lambda _x: None)
                    if not out.exists():
                        raise RuntimeError('no frame rendered')
                    return self.reply({'image': base64.b64encode(out.read_bytes()).decode()})
            if u.path == '/api/remote/ack':  # the editor page got the command
                REMOTE_SENT.pop(str(body.get('id')), None)
                return self.reply({'ok': True})
            if u.path == '/api/remote/result':  # from the editor page
                REMOTE_SENT.pop(str(body.get('id')), None)
                w = REMOTE_WAIT.get(str(body.get('id')))
                if w:
                    w['res'] = {'ok': bool(body.get('ok')), 'result': body.get('result'), 'log': body.get('log') or []}
                    w['ev'].set()
                return self.reply({'ok': True})
            if u.path == '/api/import_path':  # the MCP server imports a file from this Mac by its path
                f = Path(os.path.expanduser(str(body.get('path', '')))).resolve()
                if not f.is_file():
                    raise ValueError(f'no such file: {f}')
                with open(f, 'rb') as fh:
                    return self.reply(import_file(f.name, fh, f.stat().st_size))
            if u.path == '/api/ai/voice':
                return self.reply({'job': run_job(ai_voice, body.get('text', ''), body.get('voice', 'af_heart'), body.get('speed', 1))})
            if u.path == '/api/ai/image':
                return self.reply({'job': run_job(ai_image, body.get('prompt', ''), body.get('w', 1024), body.get('h', 1024), body.get('seed'),
                                                  body.get('steps', 8), bool(body.get('sticker')))})
            if u.path == '/api/lift':
                return self.reply(lift(body['media']))
            if u.path == '/api/fillers':
                return self.reply({'fillers': fillers(body['media'], body.get('lang', 'auto'))})
            if u.path == '/api/scenes':
                return self.reply({'times': scenes(body['media'], fnum(body.get('thr', 0.3), 0.05, 0.9))})
            if u.path == '/api/silences':
                return self.reply({'silences': silences(body['media'], fnum(body.get('noise', -35), -90, 0), fnum(body.get('min', 0.5), 0.05, 30))})
            if u.path == '/api/export':
                p, job = clean_plan(body), uuid.uuid4().hex[:12]
                JOBS[job] = {'state': 'running', 'progress': 0.0}
                threading.Thread(target=export, args=(job, p), daemon=True).start()
                return self.reply({'job': job})
            if u.path == '/api/matte':
                return self.reply({'job': run_job(matte, body['media'])})
            if u.path in ('/api/reverse', '/api/stabilize'):
                return self.reply({'job': run_job(reverse if u.path == '/api/reverse' else stabilize, body['media'])})
            if u.path == '/api/faces':
                return self.reply({'job': run_job(faces, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6))})
            if u.path == '/api/track':
                b = body.get('box') or {}
                box = {k: fnum(b.get(k), 0, 1) for k in 'xywh'}
                return self.reply({'job': run_job(track, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), box)})
            if u.path == '/api/beats':
                return self.reply(beats(body['media']))
            if u.path == '/api/still':
                return self.reply(still(body['media'], fnum(body.get('t', 0), 0, 1e6)))
            if u.path == '/api/tts':
                return self.reply(tts(body.get('text', ''), body.get('voice', 'Samantha'), body.get('rate', 185)))
            if m := re.fullmatch(r'/api/media/([a-f0-9]{12})/trash', u.path):  # reversible: file + metadata move to trash/media
                info = meta(m[1])
                (HOME / 'trash' / 'media').mkdir(parents=True, exist_ok=True)
                for f in (MEDIA / info['file'], MEDIA / f'{m[1]}.json'):
                    if f.exists():
                        shutil.move(str(f), str(unique(HOME / 'trash' / 'media' / f.name)))
                return self.reply({'ok': True})
            if u.path == '/api/slowmo':
                return self.reply({'job': run_job(slowmo, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), int(fnum(body.get('factor', 4), 2, 8)))})
            if m := re.fullmatch(r'/api/(projects|templates)/([a-f0-9]{12})/trash', u.path):  # reversible: moved, not deleted
                f = (PROJ if m[1] == 'projects' else HOME / 'templates') / f'{m[2]}.json'
                if f.exists():
                    (HOME / 'trash').mkdir(exist_ok=True)
                    shutil.move(str(f), str(unique(HOME / 'trash' / f.name)))
                return self.reply({'ok': True})
            if u.path == '/api/reveal':
                f = EXPORTS / Path(str(body.get('file', ''))).name
                if f.is_file():
                    subprocess.Popen(['open', '-R', str(f)])
                return self.reply({'ok': f.is_file()})
            self.reply({'error': 'not found'}, 404)
        except (ValueError, KeyError, TypeError, FileNotFoundError) as e:
            self.reply({'error': str(e)}, 400)
        except Exception as e:
            self.reply({'error': str(e)}, 500)

    def do_PUT(self):
        if not self.allowed(True):
            return
        m = re.fullmatch(r'/api/(projects|templates)/([a-f0-9]{12})', urlparse(self.path).path)
        if not m:
            return self.reply({'error': 'not found'}, 404)
        try:
            body = self.body()
            if not isinstance(body, dict):
                raise ValueError('expected an object')
            folder = PROJ if m[1] == 'projects' else HOME / 'templates'
            folder.mkdir(exist_ok=True)
            tmp = folder / f'.{m[2]}.tmp'
            tmp.write_text(json.dumps(body))
            tmp.replace(folder / f'{m[2]}.json')  # atomic: a crash mid-save never truncates the file
            self.reply({'ok': True})
        except ValueError as e:
            self.reply({'error': str(e)}, 400)


# ---------- self-check ----------

def selftest():
    """Render synthetic projects end-to-end (single graph + chunked path) and check timing, layers, audio."""
    global HOME, MEDIA, PROJ, EXPORTS, CACHE, CHUNK
    HOME = Path(tempfile.mkdtemp(prefix='cutroom-test-'))
    MEDIA, PROJ, EXPORTS, CACHE = (HOME / d for d in ('media', 'projects', 'exports', 'cache'))
    for d in (MEDIA, PROJ, EXPORTS, CACHE):
        d.mkdir(parents=True)

    def gen(*a):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', *a], check=True)

    gen('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(HOME / 'land.mp4'))
    gen('-f', 'lavfi', '-i', 'testsrc=s=360x640:r=25:d=4', '-c:v', 'libx264', str(HOME / 'tall.mp4'))  # no audio stream
    gen('-f', 'lavfi', '-i', 'color=c=0xff8000:s=400x400', '-frames:v', '1', str(HOME / 'pic.png'))
    gen('-f', 'lavfi', '-i', 'sine=f=220:d=10', '-c:a', 'aac', str(HOME / 'music.m4a'))
    gen('-f', 'lavfi', '-i', 'sine=f=300:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=1',
        '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'aac', str(HOME / 'gap.m4a'))
    W, H, F = 270, 480, 30
    for name, color in (('blank', 'black@0.0'), ('red', 'red@0.6')):
        gen('-f', 'lavfi', '-i', f'color=c={color}:s={W}x{H},format=rgba', '-frames:v', '1', str(HOME / f'{name}.png'))
    ids = {}
    for f in ('land.mp4', 'tall.mp4', 'pic.png', 'music.m4a', 'gap.m4a'):
        with open(HOME / f, 'rb') as fh:
            ids[f] = import_file(f, fh, (HOME / f).stat().st_size, background=False)
    L, T, I, A = ids['land.mp4'], ids['tall.mp4'], ids['pic.png'], ids['music.m4a']
    assert (CACHE / f"{L['id']}.strip.jpg").exists() and L['wave'] and (L['w'], L['h']) == (640, 360), L

    def geom(m, fit='fit', scale=1.0, x=0.0, y=0.0):
        s = (max if fit == 'fill' else min)(W / m['w'], H / m['h']) * scale
        return {'x': (W - m['w'] * s) / 2 + x * W, 'y': (H - m['h'] * s) / 2 + y * H, 'w': m['w'] * s, 'h': m['h'] * s}

    png = lambda n: 'data:image/png;base64,' + base64.b64encode((HOME / f'{n}.png').read_bytes()).decode()
    plan = {'w': W, 'h': H, 'fps': F, 'duration': 9, 'bg': '#101010', 'name': 'selftest',
            'main': [{'media': L['id'], 'in': 1, 'out': 4, 'speed': 2, 'frames': 45, 'fit': 'blur', 'geom': geom(L), 'fadeIn': 0.3, 'adj': {'b': 1.1, 'c': 1.2, 's': 0.5}},
                     {'media': T['id'], 'in': 0, 'out': 3, 'frames': 90, 'fit': 'fill', 'geom': geom(T, 'fill', 1.2)},
                     {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'fadeOut': 0.5}],  # main ends at 6.5 s
            'overlay': [{'media': L['id'], 'start': 0.5, 'in': 0, 'out': 2, 'frames': 60, 'opacity': 0.8, 'geom': geom(L, scale=0.4, y=-0.3)}],
            'audio': [{'media': A['id'], 'start': 1, 'in': 0, 'out': 8, 'frames': 240, 'volume': 0.5, 'fadeIn': 1, 'fadeOut': 2}],
            'text': {'pngs': [png('blank'), png('red')], 'frames': [{'i': 0, 'start': 0, 'end': 1}, {'i': 1, 'start': 1, 'end': 3}, {'i': 0, 'start': 3, 'end': 9}]}}

    def pixel(f, t, x, y):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(f), '-frames:v', '1', '-sws_flags', 'accurate_rnd+full_chroma_int', '-vf', f'format=rgb24,crop=1:1:{x}:{y}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                             capture_output=True, check=True).stdout
        return tuple(raw[:3])

    for chunk in (24, 2):  # 2 forces the chunked pre-render path
        CHUNK = chunk
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan(plan))
        assert JOBS['t']['state'] == 'done', JOBS['t']
        out = EXPORTS / JOBS['t']['file']
        pr = json.loads(sh(['ffprobe', '-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', str(out)]).stdout)['streams']
        v, a = next(s for s in pr if s['codec_type'] == 'video'), next(s for s in pr if s['codec_type'] == 'audio')
        assert (v['width'], v['height'], int(v['nb_read_frames'])) == (W, H, 270), v
        assert abs(float(a['duration']) - 9) < 0.1, a['duration']
        r, g, b = pixel(out, 2.0, 135, 400)  # main clip 2 + 60% red text layer (1-3 s)
        assert r > 150 and r > g + 60, ('text layer missing', r, g, b)
        r, g, b = pixel(out, 5.0, 135, 240)  # image clip, orange
        assert r > 200 and 90 < g < 170 and b < 60, ('image clip wrong', r, g, b)
        assert max(pixel(out, 8.0, 135, 240)) < 40, 'background after main track should be #101010'
        print(f'export ok (chunk={chunk}): {out.name} {W}x{H} 270 frames, audio {float(a["duration"]):.2f}s')
    def imp(f):
        with open(HOME / f, 'rb') as fh:
            return import_file(f, fh, (HOME / f).stat().st_size, background=False)

    def render(plan, frames):
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan(plan))
        assert JOBS['t']['state'] == 'done', JOBS['t']
        out = EXPORTS / JOBS['t']['file']
        got = int(json.loads(sh(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v', '-print_format', 'json', '-show_streams', str(out)]).stdout)['streams'][0]['nb_read_frames'])
        assert got == frames, (plan['name'], got, frames)
        return out

    for name, col in (('red', 'red'), ('blue', 'blue')):
        gen('-f', 'lavfi', '-i', f'color=c={col}:s=320x320', '-frames:v', '1', str(HOME / f'{name}.png'))
    R, B = imp('red.png'), imp('blue.png')
    still_clip = lambda m, tr=None: {'media': m['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(m, 'fill'), 'tr': tr}
    tplan = {'w': W, 'h': H, 'fps': F, 'duration': 4, 'bg': '#000000', 'name': 'transitions', 'overlay': [], 'audio': [],
             'main': [still_clip(R, {'type': 'fade', 'frames': 30}), still_clip(B, {'type': 'wipeleft', 'frames': 30}), still_clip(R)]}
    for chunk in (24, 1):  # 1 = every clip its own chunk: transitions must survive the chunked path too
        CHUNK = chunk
        out = render(tplan, 120)  # 3 x 60 frames - 2 x 30 overlap
        r, g, b = pixel(out, 1.5, 135, 240)
        assert 90 < r < 165 and 90 < b < 165 and g < 40, ('dissolve midpoint should be purple', r, g, b)
        assert pixel(out, 2.5, 40, 240)[2] > 200 and pixel(out, 2.5, 230, 240)[0] > 200, 'wipe should split blue|red at half way'
    print('transitions ok: dissolve + wipe, single graph and chunked')
    CHUNK = 24
    for tr, at, want in (('wipeup', (135, 400), 'b'), ('wipeup', (135, 60), 'a'), ('slideright', (40, 240), 'b'), ('circleclose', (135, 240), 'a'),
                         ('fadewhite', (135, 240), 'white')):  # dip to white peaks at 30% (xfade's formula is asymmetric)
        out = render({**tplan, 'name': tr, 'duration': 3, 'main': [still_clip(R, {'type': tr, 'frames': 30}), still_clip(B)]}, 90)
        r, g, b = pixel(out, 1.3 if tr == 'fadewhite' else 1.5, *at)  # a = red, b = blue
        ok = {'a': r > 180 and b < 80, 'b': b > 180 and r < 80, 'white': min(r, g, b) > 200}[want]
        assert ok, (tr, at, want, (r, g, b))
    print('transitions ok: wipe up, slide right, circle close, dip to white')
    CHUNK = 24
    kplan = {'w': W, 'h': H, 'fps': F, 'duration': 2, 'bg': '#000000', 'name': 'keyframes', 'audio': [],
             'main': [{'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I),  # zoom 0.5x -> 1x
                       'kf': [{'t': 0, 'w': 135, 'x': 67.5, 'y': 172.5, 'op': 1}, {'t': 2, 'w': 270, 'x': 0, 'y': 105, 'op': 1}]}],
             'overlay': [{'media': R['id'], 'start': 0, 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(R),  # grows, slides right, fades in
                          'kf': [{'t': 0, 'w': 60, 'x': 0, 'y': 0, 'op': 0.3}, {'t': 2, 'w': 120, 'x': 150, 'y': 0, 'op': 1}]}]}
    out = render(kplan, 60)
    # sample points that only the FULL-size frames cover: a regression once cropped every frame to the first frame's size
    assert max(pixel(out, 0.05, 250, 300)) < 40 and pixel(out, 1.95, 250, 300)[0] > 200, 'main zoom keyframes'
    assert pixel(out, 0.05, 30, 30)[0] < 120 and pixel(out, 1.95, 255, 100)[0] > 200 and max(pixel(out, 1.95, 30, 30)) < 40, 'overlay grow/move/fade keyframes'
    print('keyframes ok: zoom on main, move + opacity on overlay')
    deep = [{'t': i / 30, 'w': 60, 'x': (i % 40) * 4, 'y': 0, 'op': 1} for i in range(300)]  # tracking-style: one point per frame
    out = render({'w': W, 'h': H, 'fps': F, 'duration': 2, 'bg': '#000000', 'name': 'deep', 'audio': [], 'main': [],
                  'overlay': [{'media': R['id'], 'start': 0, 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(R), 'kf': deep}]}, 60)
    assert pixel(out, 1.0, 150, 30)[0] > 200 and max(pixel(out, 1.0, 60, 30)) < 40, 'deep keyframes: at t=1 s the overlay spans x 120-180'
    mfade = [{'t': 0, 'w': 270, 'x': 0, 'y': 105, 'op': 0}, {'t': 1, 'w': 270, 'x': 0, 'y': 105, 'op': 1}]
    out = render({'w': W, 'h': H, 'fps': F, 'duration': 2, 'bg': '#ffffff', 'name': 'mainop', 'audio': [], 'overlay': [],
                  'main': [{'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'kf': mfade}]}, 60)
    assert min(pixel(out, 0.0, 135, 240)) > 230 and pixel(out, 1.5, 135, 240)[2] < 60, 'main opacity keyframes fade the clip in over the canvas colour'
    out = render({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#ff7a45', 'name': 'bt709', 'audio': [], 'overlay': [], 'main': []}, 30)
    tags = sh(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=color_space', '-of', 'csv=p=0', str(out)]).stdout.strip()
    got = pixel(out, 0.5, 135, 240)
    assert tags == 'bt709' and all(abs(a - b) <= 6 for a, b in zip(got, (255, 122, 69))), ('colour tags / BT.709 maths', tags, got)
    JOBS['t'] = {'state': 'running'}
    export('t', clean_plan({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#000000', 'name': 'late', 'format': 'png', 'still': 1, 'audio': [], 'overlay': [],
                            'main': [{'media': I['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(I)}]}))
    assert JOBS['t']['state'] == 'error', ('a still past the end must fail, not report done', JOBS['t'])
    print('deep keyframes + main opacity + BT.709 tags + missing-output check ok')
    gen('-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x320', '-vf', 'drawbox=x=110:y=110:w=100:h=100:color=red:t=fill', '-frames:v', '1', str(HOME / 'green.png'))
    G = imp('green.png')
    out = render({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#0000ff', 'name': 'chroma', 'overlay': [], 'audio': [],
                  'main': [{'media': G['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(G), 'key': {'color': '#00ff00', 'sim': 0.3, 'blend': 0.1}}]}, 30)
    assert pixel(out, 0.5, 20, 150)[2] > 200 and pixel(out, 0.5, 135, 240)[0] > 200, 'chroma key: green must turn transparent, red stays'
    print('chroma key ok')
    for name, col in (('base', '0xc87828'), ('top', '0x3c648c')):
        gen('-f', 'lavfi', '-i', f'color=c={col}:s=320x320', '-frames:v', '1', str(HOME / f'{name}.png'))
    Ba, To = imp('base.png'), imp('top.png')
    bov = lambda mode, op, x: {'media': To['id'], 'start': 0, 'in': 0, 'out': 1, 'frames': 30, 'opacity': op, 'blend': mode, 'geom': {'x': x, 'y': 0, 'w': 90, 'h': 90}}
    out = render({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#000000', 'name': 'blend', 'audio': [],
                  'main': [{'media': Ba['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(Ba, 'fill')}],
                  'overlay': [bov('multiply', 1, 0), bov('soft-light', 0.5, 90), bov('color-dodge', 1, 180)]}, 30)
    w3c = {'multiply': lambda b, s: b * s,  # the canvas formulas, written independently of the lut2 expressions
           'soft-light': lambda b, s: b - (1 - 2 * s) * b * (1 - b) if s <= 0.5 else b + (2 * s - 1) * ((((16 * b - 12) * b + 4) * b if b <= 0.25 else math.sqrt(b)) - b),
           'color-dodge': lambda b, s: 0 if b == 0 else 1 if s >= 1 else min(1, b / (1 - s))}
    for mode, op, x in (('multiply', 1, 45), ('soft-light', 0.5, 135), ('color-dodge', 1, 225)):
        want = [round(b * (1 - op) + 255 * w3c[mode](b / 255, s / 255) * op) for b, s in zip((200, 120, 40), (60, 100, 140))]
        got = pixel(out, 0.5, x, 45)
        assert all(abs(g - w) <= 8 for g, w in zip(got, want)), (mode, got, want)
    assert all(abs(g - w) <= 8 for g, w in zip(pixel(out, 0.5, 135, 300), (200, 120, 40))), 'blend: outside the clips the base stays'
    print('blend modes ok: multiply, soft-light at 50%, color dodge match the canvas formulas')
    one = lambda name, clip: render({'w': W, 'h': H, 'fps': F, 'duration': 2, 'bg': '#000000', 'name': name, 'overlay': [], 'audio': [], 'main': [clip]}, 60)
    out = one('rotate', {'media': R['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(R), 'angle': 45})
    assert max(pixel(out, 1, 8, 112)) < 40 and pixel(out, 1, 135, 240)[0] > 200, 'rotation: the square corner must turn into background'
    gen('-f', 'lavfi', '-i', 'color=c=black:s=320x320', '-vf', "format=gray,geq=lum='if(lt(hypot(X-160,Y-160),110),255,0)'", '-frames:v', '1', str(HOME / 'circle.png'))
    out = one('mask', {'media': B['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(B), 'mask': png('circle')})
    assert pixel(out, 1, 135, 240)[2] > 200 and max(pixel(out, 1, 8, 112)) < 40, 'mask: centre kept, corner cut'
    ease_kf = [{'t': 0, 'w': 135, 'x': 67.5, 'y': 172.5, 'op': 1, 'e': 1}, {'t': 2, 'w': 270, 'x': 0, 'y': 105, 'op': 1}]
    out = one('ease', {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'kf': ease_kf})
    assert max(pixel(out, 0.5, 54, 240)) < 40 and pixel(out, 0.5, 70, 240)[0] > 200, 'easing: at u=.25 the eased edge (57 px) must lag linear (51 px)'
    part = [{**ease_kf[0], 'u0': 0.5, 'u1': 1.0}, ease_kf[1]]  # the second half of a smoothstep (what a split leaves): at u=.25 the edge is at 43 px
    assert abs(pw_at(part, 'x', 0.5) - (67.5 - 67.5 * (ss3(0.625) - 0.5) / 0.5)) < 1e-6
    out = one('ease-part', {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'kf': part})
    assert max(pixel(out, 0.5, 36, 240)) < 40 and pixel(out, 0.5, 50, 240)[0] > 200, 'partial easing: the edge must sit near 43 px'
    gen('-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=30:d=4', '-vf', 'fade=t=in:st=0:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(HOME / 'ramp.mp4'))
    rv = meta(reverse({}, imp('ramp.mp4')['id'])['media'])
    assert pixel(MEDIA / rv['file'], 0.1, 32, 32)[0] > 200 and pixel(MEDIA / rv['file'], 3.8, 32, 32)[0] < 60 and abs(rv['duration'] - 4) < 0.2, rv
    sb = meta(stabilize({}, L['id'])['media'])
    assert (sb['w'], sb['h']) == (L['w'], L['h']) and abs(sb['duration'] - L['duration']) < 0.2, sb
    print('rotation + mask + easing + reverse + stabilize ok')
    inv = [255 - i for i in range(256)]  # tone curve = inverse: the orange image must come out blue-ish
    out = one('tone', {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'tone': inv})
    r_, g_, b_ = pixel(out, 1, 135, 240)
    assert r_ < 40 and 90 < g_ < 160 and b_ > 220, ('tone curve (lut1d)', r_, g_, b_)
    gen('-f', 'lavfi', '-i', 'color=c=black:s=320x320', '-vf', "format=gray,geq=lum='255*(1-0.8*min(1,hypot(X-160,Y-160)/226))'", '-frames:v', '1', str(HOME / 'vig.png'))
    out = one('vignette', {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'vig': png('vig')})
    mid, corner = pixel(out, 1, 135, 240), pixel(out, 1, 8, 108)
    assert mid[0] > 230 and corner[0] < 110, ('vignette multiply', mid, corner)
    print('tone curve + vignette ok')
    vplan = {'w': W, 'h': H, 'fps': F, 'duration': 2, 'bg': '#000000', 'name': 'envelope', 'main': [], 'overlay': [],
             'audio': [{'media': A['id'], 'start': 0, 'in': 0, 'out': 2, 'frames': 60, 'volume': 1, 'vkf': [{'t': 0, 'v': 1}, {'t': 2, 'v': 0}]}]}
    out = render(vplan, 60)
    db = lambda a, b: float(re.search(r'mean_volume: (-?[\d.]+|-inf)', sh(['ffmpeg', '-hide_banner', '-ss', str(a), '-to', str(b), '-i', str(out), '-af', 'volumedetect', '-f', 'null', '-']).stderr.replace('-inf', '-200'))[1])
    assert db(0, 0.4) - db(1.6, 2) > 10, ('volume envelope', db(0, 0.4), db(1.6, 2))
    for fmt, codec in (('gif', 'gif'), ('mp3', 'mp3'), ('wav', 'pcm_s16le'), ('png', 'png'), ('prores', 'prores'), ('hevc', 'hevc')):
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan({**tplan, 'format': fmt, 'still': 1.5, 'name': f'fmt {fmt}'}))
        assert JOBS['t']['state'] == 'done', (fmt, JOBS['t'])
        got = sh(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', str(EXPORTS / JOBS['t']['file'])]).stdout.split()
        assert got and got[0] == codec, (fmt, got)
    gen('-f', 'lavfi', '-i', 'testsrc=s=120x120:r=10:d=1', str(HOME / 'sticker.gif'))
    gf = imp('sticker.gif')
    assert gf['kind'] == 'video' and gf['trans'] and gf.get('proxy') and (CACHE / f"{gf['id']}.proxy.webm").exists(), gf
    sm = meta(slowmo({}, L['id'], 0, 1, 4)['media'])
    assert abs(sm['fps'] - 120) < 1 and abs(sm['duration'] - 1) < 0.1, sm
    print('volume envelope + 6 export formats + animated GIF + smooth slow-mo ok')
    plan['loud'] = True
    plan['main'][0].update(crop={'l': 0.1, 'r': 0.1, 't': 0, 'b': 0.2}, flip=True, look=[.393, .769, .189, .349, .686, .168, .272, .534, .131], denoise=True)
    render(plan, 270)
    print('smoke ok: crop + flip + look + denoise + loudness')
    # HDR: HLG clip + a portrait-rotated copy (iPhone-style). The rotated one must match the same content
    # rendered through the normal SDR autorotate path (wrong orientation would collapse the PSNR).
    hlg = ['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
           '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc']
    gen('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', *hlg, str(HOME / 'hlg.mp4'))
    gen('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(HOME / 'sdr.mp4'))
    for f in ('hlg', 'sdr'):
        gen('-display_rotation', '90', '-i', str(HOME / f'{f}.mp4'), '-c', 'copy', str(HOME / f'{f}_rot.mp4'))
    outs = {}
    for f, dims in (('hlg.mp4', (320, 180)), ('hlg_rot.mp4', (180, 320)), ('sdr_rot.mp4', (180, 320))):
        hm = imp(f)
        assert hm['hdr'] == f.startswith('hlg') and (hm['w'], hm['h']) == dims, hm
        outs[f] = render({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#000000', 'name': f, 'overlay': [], 'audio': [],
                          'main': [{'media': hm['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(hm)}]}, 30)
    trc = sh(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', str(outs['hlg_rot.mp4'])]).stdout.strip()
    ps = re.search(r'average:([\d.]+|inf)', sh(['ffmpeg', '-hide_banner', '-i', str(outs['hlg_rot.mp4']), '-i', str(outs['sdr_rot.mp4']), '-lavfi', 'psnr', '-f', 'null', '-']).stderr)
    assert trc != 'arib-std-b67' and ps and float(ps[1]) > 22, ('HDR tone map / rotation', trc, ps and ps[1])
    fz = still(imp('hlg.mp4')['id'], 0.5)
    assert not fz['hdr'], fz
    render({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#000000', 'name': 'hdrstill', 'overlay': [], 'audio': [],
            'main': [{'media': fz['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(fz)}]}, 30)
    print(f'hdr ok: HLG tone-mapped to SDR, rotated clip matches the SDR path at {float(ps[1]):.1f} dB PSNR; HDR freeze frame exports')
    gen('-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*55*t)*exp(-25*mod(t,0.5))':s=44100:d=12", '-c:a', 'aac', str(HOME / 'kick.m4a'))
    bt = beats(imp('kick.m4a')['id'])
    err = max(abs(b - round(b * 2) / 2) for b in bt['beats'][1:-1])
    assert abs(bt['bpm'] - 120) < 4 and err < 0.06, (bt['bpm'], err)
    print(f"beats ok: {bt['bpm']} BPM, grid error {err * 1000:.0f} ms")
    vs = voices()
    vo = tts('Cutroom voiceover test.', vs[0]['name'], 185)
    assert vo['kind'] == 'audio' and vo['duration'] > 0.5 and still(L['id'], 1.0)['kind'] == 'image', vo
    print(f"voiceover + freeze frame ok ({len(vs)} voices, used {vs[0]['name']})")
    sil = silences(ids['gap.m4a']['id'], -35, 0.5)
    assert len(sil) == 1 and abs(sil[0][0] - 1) < 0.1 and abs(sil[0][1] - 2) < 0.1, sil
    print('silence detection ok:', sil)
    gen('-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1',
        '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(HOME / 'cuts.mp4'))
    sc = scenes(imp('cuts.mp4')['id'])
    assert len(sc) == 2 and abs(sc[0] - 1) < 0.05 and abs(sc[1] - 2) < 0.05, ('scene detection', sc)
    print(f'scene detection ok: {sc}')
    if shutil.which(WHISPER) and Path(MODEL).exists() and shutil.which('say'):
        subprocess.run(['say', '-o', str(HOME / 'speech.aiff'), 'Cutroom makes captions automatically. [[slnc 1300]] Right on your Mac.'], check=True)
        with open(HOME / 'speech.aiff', 'rb') as fh:
            sp = import_file('speech.aiff', fh, (HOME / 'speech.aiff').stat().st_size, background=False)
        words = transcribe(sp['id'], 'en')
        assert any('caption' in w['w'].lower() for w in words) and all(w['e'] > w['s'] for w in words), words
        gaps = silences(sp['id'], -35, 0.5)
        smear = max((min(w['e'], b) - max(w['s'], a) for w in words for a, b in gaps), default=0)
        assert gaps and smear < 0.3, ('word timing runs into a pause', smear, words, gaps)
        if Path(VAD).exists():  # pure tones: whisper alone hallucinates words here, VAD must drop them
            junk = transcribe(A['id'], 'en')
            assert junk == [], ('hallucinated captions on music', junk)
        print(f'captions ok (max {smear:.2f}s into a pause):', ' '.join(f"{w['w']}@{w['s']:.2f}" for w in words))
        subprocess.run(['say', '-o', str(HOME / 'fill.aiff'), 'So, um, I think, uh, we should, um, start the video now.'], check=True)
        fl = fillers(imp('fill.aiff')['id'], 'en')
        assert len(fl) >= 2 and all(f['e'] - f['s'] > 0.15 for f in fl), ('filler words', fl)
        print('filler words ok:', ' '.join(f"{f['w']}@{f['s']:.2f}-{f['e']:.2f}" for f in fl))
    else:
        print('captions skipped (whisper-cli or model missing)')
    shutil.rmtree(HOME)
    print('selftest OK')


def main():
    if '--selftest' in sys.argv:
        return selftest()
    for d in (MEDIA, PROJ, EXPORTS, CACHE):
        d.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), App)
    print(f'Cutroom on http://127.0.0.1:{PORT}  (data: {HOME})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
