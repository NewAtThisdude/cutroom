#!/usr/bin/env python3
"""Cutroom: a local CapCut-style editor. Stdlib-only backend.

  python3 -I server.py             UI on http://127.0.0.1:4610
  python3 -I server.py --selftest  render synthetic projects through ffmpeg and assert the output

Same split as CapCut (see README): the browser owns the timeline model, preview and text
rendering; this process is the engine. ffmpeg decodes/composites/encodes, whisper.cpp
transcribes on-device (CapCut sends audio to its cloud ASR), text arrives as a PNG timeline
rasterized by the same canvas code as the preview, so export matches what you saw.
"""
import base64, json, mimetypes, os, re, shutil, subprocess, sys, tempfile, threading, time, uuid
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
PREVIEW_CODECS, PREVIEW_EXT = {'h264', 'hevc', 'vp8', 'vp9', 'av1'}, {'.mp4', '.mov', '.m4v', '.webm'}
CTYPES = {'.mov': 'video/mp4', '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.js': 'text/javascript', '.ttf': 'font/ttf'}
ID = re.compile(r'[a-f0-9]{12}')
HEX = re.compile(r'#[0-9a-fA-F]{6}')
JOBS = {}


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
        info.update(w=w, h=h, codec=v['codec_name'])
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
    kind = 'image' if ext in IMAGE_EXT else 'video' if 'w' in info else 'audio' if info['hasAudio'] else None
    if not kind or (kind == 'image' and 'w' not in info):
        dst.unlink()
        raise ValueError('no audio or video in this file')
    if kind == 'image':
        info.update(duration=0, hasAudio=False)
    m = {'id': mid, 'name': Path(name).name[:200], 'file': dst.name, 'kind': kind, **info, 'ready': kind == 'image', 'added': time.time()}
    save_meta(m)
    if kind != 'image':
        threading.Thread(target=prepare, args=(m,), daemon=True).start() if background else prepare(m)
    return m


def prepare(m):
    """Timeline assets, like CapCut's material cache: filmstrip, waveform, preview proxy."""
    src, mid, d = str(MEDIA / m['file']), m['id'], max(m['duration'], 0.1)
    if m['kind'] == 'video':
        n = max(4, min(60, round(d / 1.5)))
        if not sh(['ffmpeg', '-v', 'error', '-y', '-hwaccel', 'videotoolbox', '-i', src, '-vf', f'fps={n}/{d:.3f},scale=-2:72,tile={n}x1',
                   '-frames:v', '1', '-q:v', '5', str(CACHE / f'{mid}.strip.jpg')]).returncode:
            m['stripN'] = n
        if m.get('codec') not in PREVIEW_CODECS or Path(m['file']).suffix.lower() not in PREVIEW_EXT:  # e.g. ProRes, MKV
            m['proxy'] = not sh(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'h264_videotoolbox', '-b:v', '5M',
                                 '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(CACHE / f'{mid}.proxy.mp4')]).returncode
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


def silences(mid, noise=-35.0, mind=0.5):
    m = meta(mid)
    r = sh(['ffmpeg', '-hide_banner', '-nostats', '-i', str(MEDIA / m['file']), '-vn', '-af', f'silencedetect=noise={noise:g}dB:d={mind:g}', '-f', 'null', '-'])
    st = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', r.stderr)]
    en = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', r.stderr)]
    en += [m['duration']] * (len(st) - len(en))  # silence running to EOF has no end line
    return [[max(0.0, a), b] for a, b in zip(st, en)]


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
           'quality': 'best' if p.get('quality') == 'best' else 'fast',
           'name': re.sub(r'[^\w\- ]', '', str(p.get('name', '')))[:80].strip() or 'Cutroom export'}

    def clip(c, timed):
        m = meta(c['media'])
        k = {'path': str(MEDIA / m['file']), 'kind': m['kind'], 'hasAudio': m['hasAudio'],
             'in': fnum(c.get('in', 0), -1e6, 1e6), 'out': fnum(c.get('out', 0), -1e6, 1e6),
             'speed': fnum(c.get('speed', 1), 0.1, 10), 'volume': fnum(c.get('volume', 1), 0, 4),
             'frames': int(fnum(c['frames'], 1, 1e8)), 'fadeIn': fnum(c.get('fadeIn', 0), 0, 60), 'fadeOut': fnum(c.get('fadeOut', 0), 0, 60),
             'fit': c.get('fit') if c.get('fit') in ('fit', 'fill', 'blur') else 'fit', 'opacity': fnum(c.get('opacity', 1), 0, 1),
             'adj': {a: fnum((c.get('adj') or {}).get(a, 1), 0, 4) for a in 'bcs'}}
        if m['kind'] != 'image' and not 0 <= k['in'] < k['out']:
            raise ValueError('empty clip')
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
    lut = f"'clip((val*{b:.4f}-127.5)*{k:.4f}+127.5,0,255)'"
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
            ins.append(['-ss', f"{c['in']:.6f}", '-t', f"{c['out'] - c['in']:.6f}", '-i', c['path']])
        return len(ins) - 1

    def video(i, c, n):  # retimed, exactly n frames, adjusted
        sp = 1 if c['kind'] == 'image' else c['speed']
        return f"[{i}:v]setpts=(PTS-STARTPTS)/{sp:.6f},fps={F:g},tpad=stop_mode=clone:stop_duration=2,trim=end_frame={n}{adjust(c)}"

    def audio(i, c, dur, delay=0.0):
        live = c['hasAudio'] and c['kind'] != 'image' and c['volume'] > 0
        a = f"[{i}:a]asetpts=PTS-STARTPTS,{atempo(c['speed'])},volume={c['volume']:.3f}" if live else 'anullsrc=r=48000:cl=stereo'
        a += f',aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={dur:.6f},atrim=end={dur:.6f}'
        if c['fadeIn']:
            a += f",afade=t=in:d={c['fadeIn']:.3f}"
        if c['fadeOut']:
            a += f",afade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}"
        if delay:
            a += f',adelay={round(delay * 1000)}:all=1'
        return a

    for k, c in enumerate(p['main']):  # magnetic main track -> one concat stream
        n = c['frames']
        dur = n / F
        i = inp(c, dur)
        g = c['geom']
        x, y, w, h = even(g['x']), even(g['y']), max(2, even(g['w'])), max(2, even(g['h']))
        v = video(i, c, n)
        if c['fit'] == 'blur':
            v += (f',split=2[f{k}][b{k}];[b{k}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur={max(2, W // 40)}:3[bb{k}];'
                  f'[f{k}]scale={w}:{h}[ff{k}];[bb{k}][ff{k}]overlay={x}:{y}')
        else:
            cx, cy = max(0, -x), max(0, -y)
            cw, ch = min(w - cx, W - max(0, x)), min(h - cy, H - max(0, y))
            v += (f',scale={w}:{h},crop={cw}:{ch}:{cx}:{cy},pad={W}:{H}:{max(0, x)}:{max(0, y)}:color={BG}' if cw >= 2 and ch >= 2
                  else f',scale={W}:{H},drawbox=c={BG}:t=fill')  # dragged fully off-canvas
        if c['fadeIn']:
            v += f",fade=t=in:st=0:d={c['fadeIn']:.3f}"
        if c['fadeOut']:
            v += f",fade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}"
        fg.append(v + f',format=yuv420p,setsar=1[v{k}]')
        fg.append(audio(i, c, dur) + f'[a{k}]')
    if p['main']:
        fg.append(''.join(f'[v{k}][a{k}]' for k in range(len(p['main']))) + f"concat=n={len(p['main'])}:v=1:a=1[vm][am]")
        mix.append('[am]')

    fg.append(f'color=c={BG}:s={W}x{H}:r={F:g}:d={D:.6f},format=yuv420p[L0]')
    cur = ['L0']

    def over(src, x=0, y=0):
        nxt = f'L{len(fg)}'
        fg.append(f'[{cur[0]}][{src}]overlay={x}:{y}:eof_action=pass[{nxt}]')
        cur[0] = nxt

    if p['main']:
        over('vm')
    for k, c in enumerate(p['overlay']):
        n = c['frames']
        dur = n / F
        i = inp(c, dur)
        g = c['geom']
        v = video(i, c, n) + f",scale={max(2, even(g['w']))}:{max(2, even(g['h']))},format=rgba"
        if c['opacity'] < 1:
            v += f",colorchannelmixer=aa={c['opacity']:.3f}"
        if c['fadeIn']:
            v += f",fade=t=in:st=0:d={c['fadeIn']:.3f}:alpha=1"
        if c['fadeOut']:
            v += f",fade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}:alpha=1"
        fg.append(v + f",setpts=PTS+{c['start']:.6f}/TB[o{k}]")  # shifted to its timeline start
        over(f'o{k}', even(g['x']), even(g['y']))
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
    fg.append('[sil]' + ''.join(mix) + f'amix=inputs={len(mix) + 1}:duration=first:normalize=0:dropout_transition=0[aout]')
    fg.append(f'[{cur[0]}]format=yuv420p[vout]')
    return sum(ins, []), ';'.join(fg)


def ffmpeg_cmd(p, td, out, intermediate=False):
    ins, fg = graph(p, td)
    W, H, F = p['w'], p['h'], p['fps']
    if intermediate:
        enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'pcm_s16le']
    elif p['quality'] == 'best':
        enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k']
    else:
        enc = ['-c:v', 'h264_videotoolbox', '-b:v', f'{max(2000, round(W * H * F * 0.2 / 1000))}k', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '192k']
    return (['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *ins,
             '-filter_complex', fg, '-map', '[vout]', '-map', '[aout]', *enc, '-pix_fmt', 'yuv420p', '-r', f'{F:g}', '-fps_mode', 'cfr',
             '-t', f"{p['duration']:.6f}"] + ([] if intermediate else ['-movflags', '+faststart']) + [str(out)])


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
                frames = sum(c['frames'] for c in part)
                sub = {**p, 'main': part, 'overlay': [], 'audio': [], 'frames': [], 'pngs': [], 'duration': frames / F}
                f = Path(td) / f'chunk{n}.mkv'
                run_ffmpeg(ffmpeg_cmd(sub, td, f, True), frames / F, lambda x, n=n: st.update(progress=(n + x) / steps))
                chunks[n] = {'path': str(f), 'kind': 'video', 'hasAudio': True, 'in': 0, 'out': frames / F, 'speed': 1, 'volume': 1,
                             'frames': frames, 'fadeIn': 0, 'fadeOut': 0, 'fit': 'fit', 'opacity': 1, 'adj': {'b': 1, 'c': 1, 's': 1},
                             'geom': {'x': 0, 'y': 0, 'w': p['w'], 'h': p['h']}}
            if chunks:
                p = {**p, 'main': chunks}
            out = unique(EXPORTS / f"{p['name']}.mp4")
            run_ffmpeg(ffmpeg_cmd(p, td, out), p['duration'], lambda x: st.update(progress=(steps - 1 + x) / steps))
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
            if path == '/api/ping':
                return self.reply({'ok': True, 'whisper': bool(shutil.which(WHISPER)) and Path(MODEL).exists()})
            if path == '/api/media':
                return self.reply(sorted((json.loads(f.read_text()) for f in MEDIA.glob('*.json')), key=lambda m: -m.get('added', 0)))
            if path == '/api/projects':
                return self.reply(list_projects())
            if m := re.fullmatch(r'/api/projects/([a-f0-9]{12})', path):
                return self.file(PROJ / f'{m[1]}.json')
            if m := re.fullmatch(r'/api/jobs/([a-f0-9]{12})', path):
                return self.reply(JOBS.get(m[1], {'state': 'missing'}))
            if m := re.fullmatch(r'/media/([a-f0-9]{12})', path):
                proxy = CACHE / f'{m[1]}.proxy.mp4'
                return self.file(proxy if proxy.exists() else MEDIA / meta(m[1])['file'])
            if m := re.fullmatch(r'/cache/([a-f0-9]{12}\.(?:strip\.jpg|wave\.png))', path):
                return self.file(CACHE / m[1])
            if m := re.fullmatch(r'/exports/([^/]+\.mp4)', path):
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
            if u.path == '/api/silences':
                return self.reply({'silences': silences(body['media'], fnum(body.get('noise', -35), -90, 0), fnum(body.get('min', 0.5), 0.05, 30))})
            if u.path == '/api/export':
                p, job = clean_plan(body), uuid.uuid4().hex[:12]
                JOBS[job] = {'state': 'running', 'progress': 0.0}
                threading.Thread(target=export, args=(job, p), daemon=True).start()
                return self.reply({'job': job})
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
        m = re.fullmatch(r'/api/projects/([a-f0-9]{12})', urlparse(self.path).path)
        if not m:
            return self.reply({'error': 'not found'}, 404)
        try:
            body = self.body()
            if not isinstance(body, dict):
                raise ValueError('project must be an object')
            tmp = PROJ / f'.{m[1]}.tmp'
            tmp.write_text(json.dumps(body))
            tmp.replace(PROJ / f'{m[1]}.json')  # atomic: a crash mid-save never truncates the project
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
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(f), '-frames:v', '1', '-vf', f'format=rgb24,crop=1:1:{x}:{y}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
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
    sil = silences(ids['gap.m4a']['id'], -35, 0.5)
    assert len(sil) == 1 and abs(sil[0][0] - 1) < 0.1 and abs(sil[0][1] - 2) < 0.1, sil
    print('silence detection ok:', sil)
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
