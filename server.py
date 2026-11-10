#!/usr/bin/env python3
"""Cutroom: a local CapCut-style editor. Stdlib-only backend.

  python3 -I server.py             UI on http://127.0.0.1:4610
  python3 -I server.py --selftest  render synthetic projects through ffmpeg and assert the output

Same split as CapCut (see README): the browser owns the timeline model, preview and text
rendering; this process is the engine. ffmpeg decodes/composites/encodes, whisper.cpp
transcribes on-device (CapCut sends audio to its cloud ASR), text arrives as a PNG timeline
rasterized by the same canvas code as the preview, so export matches what you saw.
"""
import base64, bisect, json, math, mimetypes, os, queue, re, shutil, statistics, subprocess, sys, tempfile, threading, time, urllib.request, uuid, zipfile
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
# Reduce noise = RNNoise (ffmpeg arnndn), model "conjoined-burgers" (general sound, recording noise) from
# GregorR/rnnoise-models @3eee541a (not subject to copyright, per its README), bundled and checked by SHA-256
RNN = (Path(__file__).resolve().parent / 'ai' / 'rnnoise-cb.rnnn', 'f1357c4e5be9dee8467bead486dfced2d75b640c26ad0b594fa7f102322371d9')
RNN_LAG = 480  # arnndn's output trails its input by one 10 ms frame (measured: exactly 480 samples at 48 kHz)
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'}
PREVIEW_CODECS, PREVIEW_EXT = {'h264', 'hevc', 'vp8', 'vp9'}, {'.mp4', '.mov', '.m4v', '.webm'}  # AV1 gets a proxy: WebKit shows paused AV1 frames empty
RANGE_CAP = 8 << 20
CTYPES = {'.mov': 'video/mp4', '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.js': 'text/javascript', '.ttf': 'font/ttf'}
XFADES = {'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown',
          'circleopen', 'circleclose', 'zoomin', 'dissolve', 'pixelize', 'radial', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
          'vertopen', 'horzopen', 'diagtl', 'diagbr', 'hlslice', 'vuslice', 'hblur', 'fadegrays', 'squeezeh', 'squeezev',
          'whipleft', 'whipright', 'zoomblur', 'whipup', 'whipdown', 'blurfade'}  # the UI mirrors these per pixel
# blur transitions: an xfade underneath, then a blur that peaks half way (sin(pi p)) on those frames; the UI's transition() does the same
TR_BLUR = {'whipleft': 'slideleft', 'whipright': 'slideright', 'zoomblur': 'fade', 'whipup': 'slideup', 'whipdown': 'slidedown', 'blurfade': 'fade'}
WHIP, ZOOMB, ZB_K, BLURF = 0.04, 0.25, 8, 0.02  # whip: sigma, x frame width (height for up/down); zoom blur: the last copy's extra zoom; copies averaged; blur dissolve: boxblur radius x height
FX_OPS = {'matrix', 'negate', 'blur', 'pixelize', 'rgbshift', 'noise', 'mirror', 'grid', 'transform', 'glow', 'hblur', 'zblur', 'lut', 'expr'}  # video effects: the UI expands each one into these
# per-pixel expressions from web/fxpack.js (geq: transitions on their stacked overlap frames, effects on the composite): only these names, numbers and + - * / ( ) , ;
XNAMES = {'X', 'Y', 'W', 'H', 'N', 'PI', 'LF', 'if', 'ifnot', 'lt', 'lte', 'gt', 'gte', 'eq', 'between', 'min', 'max', 'abs', 'floor', 'ceil', 'trunc',
          'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'atan', 'atan2', 'mod', 'pow', 'clip', 'hypot', 'r', 'g', 'b', 'st', 'ld', 'TO'}
BLENDS = {  # overlay blend modes = the canvas's W3C formulas as lut2 expressions; x = backdrop, y = clip, 0..255 (ffmpeg's own blend modes differ)
    'multiply': 'x*y/255', 'screen': 'x+y-x*y/255', 'darken': 'min(x,y)', 'lighten': 'max(x,y)',
    'overlay': 'if(lte(x,127.5),2*x*y/255,255-2*(255-x)*(255-y)/255)',
    'hard-light': 'if(lte(y,127.5),2*x*y/255,255-2*(255-x)*(255-y)/255)',
    'soft-light': 'if(lte(y,127.5),x-(255-2*y)*x*(255-x)/65025,x+(2*y-255)*(if(lte(x,63.75),((16*x/255-12)*x/255+4)*x/255,sqrt(x/255))*255-x)/255)',
    'color-dodge': 'if(eq(x,0),0,if(eq(y,255),255,min(255,x*255/(255-y))))',
    'color-burn': 'if(eq(y,0),0,255-min(255,(255-x)*255/y))',  # WebKit tests the clip's 0 before the backdrop's 255 (W3C the other way): match what the preview shows
    'difference': 'abs(x-y)', 'exclusion': 'x+y-2*x*y/255'}
NOVELTY_VOICES = {'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox'}
ID = re.compile(r'[a-f0-9]{12}')
HEX = re.compile(r'#[0-9a-fA-F]{6}')
JOBS = {}
# CUTROOM_CORES / CUTROOM_RAM_GB: test a smaller Mac's choices (decoder, models, how much at once) on this one
CORES = int(os.environ.get('CUTROOM_CORES') or os.cpu_count() or 8)
RAM_GB = float(os.environ.get('CUTROOM_RAM_GB') or int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True).stdout.strip() or 8 << 30) / 2 ** 30)
BIG_MAC = CORES >= 12 and RAM_GB >= 24  # Pro/Max chips: CPU decoding is faster there; a base M1 (8 cores, 8 GB) leans on the media engine
PREP = threading.BoundedSemaphore(2 if BIG_MAC else 1)  # imports prepared at once: each 4K proxy takes ~500 MB, four took 2.4 GB together
# main clips per ffmpeg graph (longer main tracks pre-render in chunks): every open decoder runs ahead and holds frames, so
# 40 cuts of 4K footage peaked at 4.5 GB with 24 to a graph. ponytail: by memory, not by each clip's resolution
CHUNK = 24 if RAM_GB >= 24 else 12 if RAM_GB >= 16 else 6
REMOTE_Q, REMOTE_WAIT, REMOTE_SEEN, REMOTE_SENT = queue.Queue(), {}, [0.0], {}  # commands from the Cutroom MCP server; the open editor page runs them


def remote_reoffer(m):  # sent but never acknowledged (the page reloaded mid-poll): offer it again while its caller still waits
    if REMOTE_SENT.pop(m['id'], None) and m['id'] in REMOTE_WAIT:
        REMOTE_Q.put(m)


def sh(cmd, low=False):
    """low: background work (import proxies, filmstrips): nice'd, so the editor and its playback win the CPU."""
    return subprocess.run(['nice', '-n', '10', *cmd] if low else cmd, capture_output=True, text=True, errors='replace')


def meta(mid):
    if not ID.fullmatch(str(mid)):
        raise ValueError('bad media id')
    return json.loads((MEDIA / f'{mid}.json').read_text())


def save_meta(m):
    if m.get('file') and not (MEDIA / m['file']).exists():  # removed from the library while it was being prepared: don't bring back an empty entry
        return
    (MEDIA / f"{m['id']}.json").write_text(json.dumps(m))


def gop(path):
    """The longest gap between keyframes in a video's first 30 s. A phone's 10 s GOP made every seek decode up to 10 s
    of frames (a scrub step 184-205 ms, a jump 327 ms); such files get a proxy with a keyframe every second."""
    r = sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0',
            '-read_intervals', '%+30', str(path)])
    ts = sorted(float(x) for x in re.findall(r'^-?[\d.]+', r.stdout, re.M))
    if not ts:
        return 0.0
    end = min(30.0, float(sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]).stdout.strip() or 0) or 30.0)
    return round(max([b - a for a, b in zip(ts, ts[1:])] + [end - ts[-1] if len(ts) == 1 else 0.0]), 2)


def probe(path):
    r = sh(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)])
    if r.returncode:
        raise ValueError('unsupported file')
    j = json.loads(r.stdout)
    v = next((s for s in j['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')), None)
    info = {'hasAudio': any(s['codec_type'] == 'audio' for s in j['streams']), 'duration': float(j['format'].get('duration') or 0)}
    if v:
        rot = v.get('tags', {}).get('rotate') or next((d['rotation'] for d in v.get('side_data_list', []) if 'rotation' in d), 0)
        if not rot and v['codec_name'] in ('mjpeg', 'png', 'webp', 'tiff') and info['duration'] < 0.2:  # a photo: EXIF orientation is on its frame
            f = sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-of', 'json', str(path)])
            fr = (json.loads(f.stdout or '{}').get('frames') or [{}])[0]
            rot = next((d['rotation'] for d in fr.get('side_data_list', []) if 'rotation' in d), 0)
        w, h = int(v['width']), int(v['height'])
        if abs(int(float(rot))) % 180 == 90:  # phone footage: ffmpeg and the browser both auto-rotate
            w, h = h, w
        fr = v.get('avg_frame_rate', '0/1').split('/')
        info['fps'] = round(int(fr[0]) / int(fr[1]), 3) if len(fr) == 2 and fr[1] not in ('', '0') else 30
        info['trans'] = v.get('pix_fmt', '') in ('rgba', 'bgra', 'argb', 'abgr', 'ya8', 'pal8', 'yuva420p') or v['codec_name'] == 'gif'
        info.update(w=w, h=h, codec=v['codec_name'], rot=int(float(rot)),
                    hdr=v.get('color_transfer') in ('arib-std-b67', 'smpte2084'),  # HLG / PQ (iPhone HDR is HLG)
                    cs=v.get('color_space', ''), pix=v.get('pix_fmt', ''), trc=v.get('color_transfer', ''),
                    alpha=v['codec_name'] == 'vp9' and v.get('tags', {}).get('alpha_mode') == '1')
    return info


def find_key(key):  # the library item made from this source key (a re-imported file, a rendered ramp), if its file is there
    for f in MEDIA.glob('*.json'):
        try:
            m = json.loads(f.read_text())
        except ValueError:
            continue
        if m.get('srckey') == key and (MEDIA / m.get('file', '')).is_file():
            return m


def import_file(name, stream, length, background=True, src=None, key=None):
    if src:  # the same file imported again (a card plugged in twice): the item already there, not a second copy and proxy
        st = Path(src).stat()
        key = f'{Path(src).name}|{st.st_size}|{int(st.st_mtime)}'
        if m := find_key(key):
            return {**m, 'dup': True}
    mid = uuid.uuid4().hex[:12]
    ext = Path(name).suffix.lower()
    ext = ext if re.fullmatch(r'\.[a-z0-9]{1,5}', ext) else '.bin'
    dst = MEDIA / f'{mid}{ext}'
    if src:  # a file on this Mac: an APFS clone, instant and taking no space (a 4 GB camera clip copied took 4 GB more); a copy elsewhere
        if sh(['cp', '-c', str(src), str(dst)]).returncode:
            dst.unlink(missing_ok=True)
            raise ValueError(f'could not copy {Path(src).name}')
    else:
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
    m = {'id': mid, 'name': Path(name).name[:200], 'file': dst.name, 'kind': kind, **info, 'ready': kind == 'image', 'added': time.time(), **({'srckey': key} if key else {})}
    save_meta(m)
    if kind != 'image':
        threading.Thread(target=prepare, args=(m,), daemon=True).start() if background else prepare(m)
    return m


def photo_copy(m, size):
    """A photo at most `size` px on its long edge, for the library card (320) and the preview (2560): sixty full-size
    camera photos as card backgrounds took 742-867 MB in WebKit and scrolled at 117 ms a step. The export reads the original."""
    if max(m.get('w') or 0, m.get('h') or 0) <= size:
        return MEDIA / m['file']
    fmt = 'png' if m.get('trans') else 'jpeg'
    out = CACHE / f"{m['id']}.{size}.{'png' if m.get('trans') else 'jpg'}"
    if not out.exists():
        tmp = out.with_name(f'{uuid.uuid4().hex[:8]}.{out.name}')  # (two requests at once each write their own)
        if sh(['sips', '-Z', str(size), '-s', 'format', fmt, str(MEDIA / m['file']), '--out', str(tmp)], low=True).returncode or not tmp.exists():
            tmp.unlink(missing_ok=True)
            return MEDIA / m['file']
        tmp.replace(out)
    return out


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


WK_LOCK = threading.Lock()  # ponytail: one re-label at a time; per-file locks if many big files arrive at once


def wk_copy(m):
    """Video for WebKit (the Mac app): the same stream re-labelled, not re-encoded. macOS colour-manages video in WebKit
    and lifts BT.709's mid-tones (grey 128 shows as 139); labelled with the sRGB transfer it shows the decoded values,
    which is what the export and Chrome use. Primaries BT.709 (no gamut mapping); the matrix the export reads it with."""
    src = CACHE / f"{m['id']}.proxy.mp4"
    if heavy(m) and not src.exists():  # its proxy is on the way (the page reloads when it's ready): no 4 GB re-labelled copy meanwhile
        return MEDIA / m['file']
    codec = 'h264' if src.exists() else m.get('codec')
    if m.get('hdr') and not src.exists():  # WebKit's own HDR rendering until the tone-mapped proxy exists
        return MEDIA / m['file']
    src = src if src.exists() else MEDIA / m['file']
    if codec not in ('h264', 'hevc'):
        return src
    out = CACHE / f"{m['id']}.wk.mov"
    with WK_LOCK:
        if not out.exists():
            cs = m.get('cs') or ''
            matrix = 1 if m.get('hdr') else (  # HDR is always its proxy here: tone mapped to BT.709 (hdr_decode)
                6 if cs in ('smpte170m', 'bt470bg') or (cs in ('', 'unknown') and max(m['w'], m['h']) < 720) else 9 if cs.startswith('bt2020') else 1)
            tmp = out.with_suffix('.tmp.mov')
            # the container's labels too: a tagged source (every VideoToolbox proxy) kept its BT.709 transfer in the 'colr' atom,
            # which is what WebKit reads, and the preview showed lifted mid-tones (7 levels over the export on iPhone HDR)
            if sh(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-bsf:v',
                   f'{codec}_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients={matrix}',
                   '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', {1: 'bt709', 6: 'smpte170m', 9: 'bt2020nc'}[matrix],
                   '-movflags', '+faststart', str(tmp)]).returncode == 0:
                tmp.replace(out)
    return out if out.exists() else src


def hw_pix(m):
    """Pixel formats the Mac's media engine plays: 8-bit 4:2:0, and 10-bit 4:2:0 for HEVC. Camera 4:2:2 (Sony XAVC S-I,
    Canon, Panasonic 10-bit) either fails in WebKit (HEVC 4:2:2) or decodes on the CPU there (H.264 4:2:2): proxied."""
    p = m.get('pix')
    return not p or p in ('yuv420p', 'yuvj420p', 'nv12') or (m.get('codec') == 'hevc' and p in ('yuv420p10le', 'p010le'))


def heavy(m):
    """Camera footage past 1080p60 (a DJI 4K60 clip is 100 Mbit/s), and all HDR: previewed, and looked at by smart combine,
    through a 720p proxy (CapCut's proxy media). An HDR proxy is tone mapped by the export's own chain (hdr_decode), so the
    preview shows the colours the export makes, not WebKit's own HDR rendering, and 4K60 10-bit isn't uploaded per frame.
    Exports always read the original."""
    return m.get('kind') == 'video' and not (m.get('alpha') or m.get('trans')) and (
        m.get('hdr') or m.get('w', 0) * m.get('h', 0) * (m.get('fps') or 30) > 1920 * 1080 * 60)


EXACT_LOCK = threading.Lock()


def exact_audio(m):
    """What the export reads an audio file from: the file itself when it seeks to the sample (WAV, AIFF, FLAC), else a
    lossless FLAC copy made once. ffmpeg's input seek in M4A files came out 800-2700 samples off, differently at every
    point (AAC priming and edit lists), and MP3 seeks are approximate; the preview's browser seeks them exactly."""
    src = MEDIA / m['file']
    if src.suffix.lower() in ('.wav', '.aif', '.aiff', '.flac'):
        return src
    out = CACHE / f"{m['id']}.exact.flac"
    with EXACT_LOCK:
        if not out.exists():
            tmp = out.with_suffix('.tmp.flac')
            if sh(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-vn', '-map', '0:a:0', '-c:a', 'flac', str(tmp)]).returncode:
                return src
            tmp.replace(out)
    return out


PCM_LOCKS = {}  # one lock per output file: a play waiting for its own sound never waits behind another file's decode
PCM_LOCKS_LOCK = threading.Lock()


RNN_OK = []


def rnn_model():
    """The bundled RNNoise model, its checksum verified once."""
    if not RNN_OK:
        import hashlib
        if not RNN[0].is_file() or hashlib.sha256(RNN[0].read_bytes()).hexdigest() != RNN[1]:
            raise RuntimeError('the noise reduction model (ai/rnnoise-cb.rnnn) is missing or damaged')
        RNN_OK.append(str(RNN[0]))
    return RNN_OK[0]


NOISE_FX = ('dn', 'sv', 'svm')  # Reduce noise (RNNoise) | Studio voice | Studio voice, the music taken out first (Demucs)
AI_CHARS = ('elf', 'giant', 'monster', 'alien')  # ai/voicefx.py: WORLD vocoder, the pitch and the formants moved apart
FF_CHARS = {  # voice characters as ffmpeg filters (n: the length in samples, for the reverb's tail); the drive before the band (no vibrato: its delay line made the voice 4 ms late)
    'radio': lambda n: 'acompressor=threshold=0.08:ratio=6:attack=1:release=60:makeup=3,asoftclip=type=tanh,'
                       'highpass=f=350:p=2,highpass=f=350:p=2,lowpass=f=3200:p=2,lowpass=f=3200:p=2,lowpass=f=3200:p=2,equalizer=f=1500:t=q:w=1:g=4',
    'megaphone': lambda n: 'volume=4,asoftclip=type=atan,highpass=f=700:p=2,highpass=f=700:p=2,lowpass=f=3800:p=2,lowpass=f=3800:p=2,lowpass=f=3800:p=2,'
                           'equalizer=f=2000:t=q:w=1.4:g=10',
    'cave': lambda n: (f"asplit=2[cd][cw];amovie={hall_ir('cave')},aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[ci];"
                       f"[cw][ci]afir=irnorm=-1:gtype=none,lowpass=f=3000[cx];[cd][cx]amix=inputs=2:normalize=0:weights=0.8 1,atrim=end_sample={n}"),
    'underwater': lambda n: 'lowpass=f=500:p=2,lowpass=f=500:p=2,aphaser=type=t:speed=0.6:decay=0.5,chorus=0.7:0.9:55|70:0.4|0.32:0.25|0.4:2|1.3,tremolo=f=5:d=0.25'}
VOICE_CHARS = (*AI_CHARS, *FF_CHARS)
# Studio voice after RNNoise: rumble cut, less mud, de-ess, a downward expander for the gaps (at most -14 dB), a gentle
# compressor, presence and air, then one gain to -16 LUFS
# (podcast loudness). None of these looks ahead: the voice is not delayed (the onset stays within 2 ms)
STUDIO = ('highpass=f=80:p=2,equalizer=f=250:t=q:w=1:g=-2,deesser=i=0.4:m=0.5:f=0.5,agate=threshold=0.025:ratio=2:range=0.2:attack=3:release=250,'
          'acompressor=threshold=0.1:ratio=3:attack=5:release=150:makeup=2,'
          'equalizer=f=3500:t=q:w=1.2:g=3,equalizer=f=10000:t=q:w=1:g=1.5')


def fx_ok(fx):
    """A clip's sound processing as the PCM file's key: '', a noise step, a character, or 'noise+character'."""
    p = fx.split('+') if fx else []
    return len(p) <= 2 and len(set(p)) == len(p) and all(x in NOISE_FX or x in VOICE_CHARS for x in p) and not (len(p) == 2 and (p[0] not in NOISE_FX or p[1] in NOISE_FX))


def clip_fx(c, m):
    """The same key as the page's sndFx(c): Studio voice wins over Reduce noise; a character from c.au.voice."""
    if not m.get('hasAudio') or m.get('kind') == 'image':
        return ''
    v = (c.get('au') or {}).get('voice') if isinstance(c.get('au'), dict) else None
    return '+'.join(x for x in ('svm' if c.get('studio') == 'music' else 'sv' if c.get('studio') else 'dn' if c.get('denoise') else '',
                                v if v in VOICE_CHARS else '') if x)


def pcm_lufs(f, fmt='s16le'):
    """Integrated loudness (LUFS) and true peak (dBTP) of a raw PCM file, from loudnorm's meter; (-99, -99) for silence."""
    r = sh(['ffmpeg', '-v', 'info', '-f', fmt, '-ar', '48000', '-ac', '2', '-i', str(f), '-af', 'loudnorm=print_format=json', '-f', 'null', '-'])
    try:
        j = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])
        i, tp = float(j['input_i']), float(j['input_tp'])
    except ValueError:
        return -99.0, -99.0
    return (i, tp) if math.isfinite(i) and math.isfinite(tp) else (-99.0, -99.0)


def fx_pcm(m, fx, tmp, st=None):
    """The 1x PCM through a clip's sound processing, its last step on the PCM of the steps before it (each one cached):
    the preview plays this file and the export reads it, so both hear the same samples. Same length as the source.
    Each step renders in float, then ONE gain sets its level (Studio voice -16 LUFS; a character the loudness it came
    in at) with the true peak under -1.5 dBTP: a clipped file played clipped in the preview while the export's limiter
    (at -1 dBFS) changed it (the cave's reverb: 22 dB apart)."""
    *pre, step = fx.split('+')
    raw = pcm(m)
    if not raw:
        return False
    n = raw.stat().st_size // 4
    if step == 'svm':  # Demucs keeps the voice only (cached as the clip's "Isolate voice" item); same length as the source
        base = pcm(meta(isolate(st if st is not None else {}, m['id'], 'voice')['media']))
    else:
        base = pcm(m, fx='+'.join(pre))
    if not base:
        return False
    raw_in = lambda f, fmt='s16le': ['-f', fmt, '-ar', '48000', '-ac', '2', '-i', str(f)]
    run = lambda af, src, dst, fmt='s16le': not sh(['ffmpeg', '-v', 'error', '-y', *src, '-filter_complex', f'[0:a]{af}[o]', '-map', '[o]', '-ac', '2', '-f', fmt, str(dst)]).returncode
    rnn = f"apad=whole_len={n + RNN_LAG},arnndn=m='{rnn_model()}',atrim=start_sample={RNN_LAG}:end_sample={n + RNN_LAG}"  # its 10 ms lag taken back out
    if step == 'dn':  # (afftdn was 25 ms late and took only 1-5 dB)
        return run(rnn, raw_in(base), tmp)
    mid, i0 = tmp.with_suffix('.f32'), pcm_lufs(base)[0]
    try:
        if step in NOISE_FX:  # first to -20 LUFS: RNNoise and the expander's threshold then see a known level
            ok, want = run(f'aformat=sample_fmts=flt,volume={max(-20, min(30, -20 - i0)) if i0 > -70 else 0:.2f}dB,{rnn},{STUDIO}', raw_in(base), mid, 'f32le'), -16
        elif step in FF_CHARS:
            ok, want = run(f'aformat=sample_fmts=flt,{FF_CHARS[step](n)},apad=whole_len={n},atrim=end_sample={n}', raw_in(base), mid, 'f32le'), i0
        else:
            if not (AI_BIN / 'python').exists():
                raise RuntimeError('the voice characters elf, giant, monster and alien need the on-device AI tools (README: On-device AI)')
            r = subprocess.run([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'voicefx.py'), step, str(base), str(mid)], capture_output=True, text=True, env=AI_ENV)
            if r.returncode:
                raise RuntimeError(f'the {step} voice failed: ' + (r.stderr.strip().splitlines() or ['no output'])[-1][-300:])
            ok, want = True, i0
        if not ok:
            return False
        i, tp = pcm_lufs(mid, 'f32le')
        g = min(want - i if i > -70 and want > -70 else 0.0, -1.5 - tp)
        return run(f'volume={g:.3f}dB', raw_in(mid, 'f32le'), tmp)
    finally:
        mid.unlink(missing_ok=True)


def sound_prep(st, mid, fx):
    m = meta(mid)
    if not m.get('hasAudio') or not pcm(m, fx=fx, st=st):
        raise RuntimeError('this clip has no sound to process')
    return {'ok': True}


def pcm(m, tempo=1.0, a=0, b=0, dn=False, fx='', st=None):
    """The preview's sound: raw 16-bit 48 kHz stereo, decoded once from the start (sample-exact). The page reads byte
    ranges of it into Web Audio buffers. A <video>'s own sound routed through Web Audio started ~0.3 s late in WebKit and
    held the picture meanwhile: a stall at every cut. A clip that keeps its pitch at another speed gets the export's
    atempo over just its source seconds [a, b] (whole seconds, cut by atrim on decoded samples, so exact): a whole-file
    copy per speed made 3.5 GB from one 5-minute clip whose speed slider was swept. The 4 newest per file are kept.
    fx: the clip's sound processing (fx_ok: Reduce noise, Studio voice, a voice character), made by fx_pcm() on the 1x
    copy; the export reads this same file (dn=True is fx='dn')."""
    fx = fx or ('dn' if dn else '')
    if not fx_ok(fx):
        raise ValueError(f'unknown sound processing {fx!r}')
    one = abs(tempo - 1) < 1e-6
    out = CACHE / (f"{m['id']}{'.' + fx if fx else ''}.pcm" if one else f"{m['id']}{'.' + fx if fx else ''}.{tempo:g}.{a}-{b}.pcm")
    with PCM_LOCKS_LOCK:
        lock = PCM_LOCKS.setdefault(out.name, threading.Lock())
    with lock:
        if not out.exists():
            src = exact_audio(m) if m.get('kind') == 'audio' else MEDIA / m['file']
            tmp = out.with_suffix('.tmp')
            if one and fx:
                try:
                    ok = fx_pcm(m, fx, tmp, st)
                except Exception:
                    tmp.unlink(missing_ok=True)
                    raise
                if not ok or not tmp.exists():
                    tmp.unlink(missing_ok=True)
                    return None
                tmp.replace(out)
                return out
            trim = '' if one else f"atrim=start={a}{f':end={b}' if b > a else ''},asetpts=PTS-STARTPTS,"
            # a span at another speed is cut from the 1x copy (raw samples: the seek is exact and instant); from the source
            # it decoded everything before the span first: 1.6 s of silence on a sped-up clip 5 minutes in
            base = None if one else pcm(m, fx=fx)
            if fx and not base:
                return None
            cmd = (['-f', 's16le', '-ar', '48000', '-ac', '2', '-ss', str(a), *(['-t', str(b - a)] if b > a else []), '-i', str(base), '-af', atempo(tempo)]
                   if base else ['-i', str(src), '-vn', '-map', '0:a:0', '-af', f'{trim}aresample=48000,{atempo(tempo)}'])
            if sh(['ffmpeg', '-v', 'error', '-y', *cmd, '-ac', '2', '-f', 's16le', str(tmp)], low=not base).returncode:
                tmp.unlink(missing_ok=True)
                return None
            tmp.replace(out)
            if not one:
                for old in sorted(CACHE.glob(f"{m['id']}.*-*.pcm"), key=lambda f: f.stat().st_mtime)[:-4]:
                    old.unlink(missing_ok=True)
    return out


def prepare(m):
    """Timeline assets, like CapCut's material cache: preview proxy, filmstrip, waveform. One or two files at a time (PREP),
    at low priority: a card's worth of 4K clips dropped in at once mustn't take the Mac's memory and every core."""
    PREP_PCT[m['id']] = -1  # waiting for its turn
    try:
        with PREP:
            PREP_PCT[m['id']] = 0
            prepare_(m)
    finally:
        PREP_PCT.pop(m['id'], None)


PREP_PCT = {}  # media id -> how far its preparation is (0-1; -1 = waiting), shown in the library while it's "preparing"


def proxy(m, src, out, sw=False):
    # written aside and moved in when done: the player, strips and posters used the half-written file (a 4K clip showed
    # black, 4-15 fps, for its whole 30-250 s build) where the original plays fine meanwhile
    tmp = out.with_name(out.stem + '.tmp' + out.suffix)
    cmd = proxy_cmd(m, src, tmp, sw)
    cmd[1:1] = ['-nostdin', '-progress', 'pipe:1', '-nostats']
    try:
        run_ffmpeg(['nice', '-n', '10', *cmd], max(m['duration'], 0.1), lambda f: PREP_PCT.__setitem__(m['id'], round(0.9 * f, 3)))
        tmp.replace(out)
        (CACHE / f"{m['id']}.wk.mov").unlink(missing_ok=True)  # WebKit's copy was of the original: remade from the proxy
        return True
    except RuntimeError:
        tmp.unlink(missing_ok=True)
        return False


def proxy_cmd(m, src, out, sw=False):
    """720p H.264 with a keyframe every second (quick seeks while editing). Decoding by the media engine (VideoToolbox)
    took a tenth of the CPU of ffmpeg's decoder threads on a DJI 4K60 clip (0.6 cores vs 6.3, 2x the time on a 14-core M4
    Max), so only big Macs decode H.264 in software. HDR goes through the export's tone mapping."""
    dec, vf = hdr_decode(m)
    if not dec and not sw and not (BIG_MAC and m.get('codec') == 'h264'):
        dec = ['-hwaccel', 'videotoolbox', '-threads', '1']  # one thread: ffmpeg's frame threads would only hold frames
    tall = 720 if heavy(m) else 1080  # 4K60 at 720p (decoding speed); a long-GOP 1080p phone clip keeps its size
    # each frame keeps its own time: on a 1/fps time base iPhone 120 fps frames (on a 1/600 s grid, with gaps) moved up to a
    # frame, and the preview showed a later frame than the export (which reads the original) at 3 of 5 test times
    return ['ffmpeg', '-v', 'error', '-y', *dec, '-i', src, '-vf', f"{vf}scale=-2:'min({tall},ih)'", '-fps_mode:v', 'passthrough', '-enc_time_base:v', 'demux',
            '-c:v', 'h264_videotoolbox', '-b:v', '5M' if tall == 720 else '8M',
            '-g', str(max(1, round(m.get('fps') or 30))), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(out)]


def prepare_(m):
    src, mid, d = str(MEDIA / m['file']), m['id'], max(m['duration'], 0.1)
    if m['kind'] == 'video':
        if m.get('trans') and not m.get('alpha'):  # e.g. GIF: preview proxy keeps transparency (VP9 alpha WebM)
            tmp = CACHE / f'{mid}.proxy.tmp.webm'
            m['proxy'] = not sh(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', "scale=-2:'min(720,ih)',format=yuva420p", '-c:v', 'libvpx-vp9', '-b:v', '0',
                                 '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-an', str(tmp)], low=True).returncode
            if m['proxy']:
                tmp.replace(CACHE / f'{mid}.proxy.webm')
        elif (m.get('codec') not in PREVIEW_CODECS or Path(m['file']).suffix.lower() not in PREVIEW_EXT or heavy(m) or not hw_pix(m)  # e.g. ProRes, MKV, 4K60
              or m.setdefault('gop', gop(src)) > 2):  # a keyframe only every few seconds: seeks decode all of it
            out = CACHE / f'{mid}.proxy.mp4'
            m['proxy'] = proxy(m, src, out) or proxy(m, src, out, sw=True)
        n = max(4, min(60, round(d / 1.5)))
        px = CACHE / f'{mid}.proxy.mp4'
        # past a minute, keyframes only: a 10-minute 1080p file's strip took 60 s decoding every frame, 4 s this way. Short
        # files (or ones with too few keyframes for the strip: x264 puts one every 250 frames) decode every frame.
        strip = CACHE / f'{mid}.strip.jpg'
        for skip in ((['-skip_frame', 'nokey'],) if d > 60 else ()) + ([],):
            strip.unlink(missing_ok=True)
            if not sh(['ffmpeg', '-v', 'error', '-y', *skip, '-i', str(px) if px.exists() else src, '-vf', f'fps={n}/{d:.3f},scale=-2:72,tile={n}x1',
                       '-frames:v', '1', '-q:v', '5', str(strip)], low=True).returncode and strip.exists():
                m['stripN'] = n
                break
    if m['kind'] == 'video' and (m.get('alpha') or m.get('trans')):
        alpha_mov(m)
    if m['kind'] == 'audio':
        exact_audio(m)  # made now, so the first export doesn't wait for it
    if m['hasAudio']:
        pcm(m)  # the preview's sound, so the first play doesn't wait for it
        m['wave'] = not sh(['ffmpeg', '-v', 'error', '-y', '-i', src, '-filter_complex',
                            'aformat=channel_layouts=mono,showwavespic=s=1600x80:colors=0x7ee0c3:scale=sqrt',
                            '-frames:v', '1', str(CACHE / f'{mid}.wave.png')], low=True).returncode
    timeline_assets(m)
    m['ready'] = True
    save_meta(m)


def timeline_assets(m):
    """What the timeline draws a clip with when zoomed in: a grid of frames at their own shape, about one a second (up
    to 300), and the sound's peak per 10 ms. The old strip (at most 60 frames stretched over the clip) and waveform
    (one 1600 px picture) went blocky and blurred as soon as you zoomed in."""
    mid, d, changed = m['id'], max(m.get('duration') or 0.1, 0.1), False
    if m['kind'] == 'video' and not m.get('grid'):
        px = CACHE / f'{mid}.proxy.mp4'
        src = px if px.exists() else MEDIA / m['file']
        n = max(4, min(300, round(d)))
        cols = min(n, 20)
        out, tmp = CACHE / f'{mid}.grid.jpg', CACHE / f'{mid}.grid.tmp.jpg'
        for skip in ((['-skip_frame', 'nokey'],) if d > 60 else ()) + ([],):
            if not sh(['ffmpeg', '-v', 'error', '-y', *skip, '-i', str(src), '-vf', f'fps={n}/{d:.3f},scale=-2:72,tile={cols}x{math.ceil(n / cols)}',
                       '-frames:v', '1', '-q:v', '5', str(tmp)], low=True).returncode and tmp.exists():
                w = int(sh(['ffprobe', '-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', str(tmp)]).stdout.strip() or 0)
                tmp.replace(out)
                m['grid'] = {'n': n, 'cols': cols, 'tw': w // cols, 'th': 72}
                changed = True
                break
        tmp.unlink(missing_ok=True)
    if m.get('hasAudio') and not m.get('peaks') and (f := pcm(m)):
        raw = array('h')
        with open(f, 'rb') as fh:
            raw.frombytes(fh.read())
        if sys.byteorder != 'little':
            raw.byteswap()
        step = 960  # 10 ms of 48 kHz stereo samples
        out = bytes(min(255, round(max(max(raw[i:i + step]), -min(raw[i:i + step])) / 128)) for i in range(0, len(raw) - 1, step))
        (CACHE / f'{mid}.peaks').write_bytes(out)
        m['peaks'] = True
        changed = True
    return changed


TX_LOCKS, TX_PCT = {}, {}  # one whisper run per file at a time (Captions + Script at once ran it twice); media id -> progress 0-1


def spans(rs, dur, pad=0.0):
    """[a, b] spans merged where they touch, each padded and kept inside [0, dur]."""
    out = []
    for a, b in sorted((max(0.0, a - pad), min(dur, b + pad)) for a, b in rs if b > a):
        if out and a <= out[-1][1] + 1e-3:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def transcribe(mid, lang='auto', ranges=None):
    """Word-level timestamps for a media file, on-device whisper.cpp (CapCut uses cloud ASR). ranges: the source [in, out]
    spans in use; only those (+1 s) are listened to, from the preview's PCM copy, and each span heard is cached with its
    words (a 30 s edit of 431 s of night drives listened to all 431). No ranges: the whole file."""
    lang = lang if re.fullmatch(r'auto|[a-z]{2,3}', str(lang)) else 'auto'
    m, cache = meta(mid), CACHE / f'{mid}.{lang}.words.json'
    dur = m['duration']
    want = spans([[fnum(a, 0, dur), fnum(b, 0, dur)] for a, b in ranges] if ranges else [[0, dur]], dur, 1.0)
    with PCM_LOCKS_LOCK:
        lock = TX_LOCKS.setdefault(cache.name, threading.Lock())
    with lock:
        doc = json.loads(cache.read_text()) if cache.exists() else {'have': [], 'words': []}
        if isinstance(doc, list):  # a cache from before spans: the whole file
            doc = {'have': [[0, dur]], 'words': doc}
        todo = []
        for a, b in want:  # what is wanted and not heard yet (have: sorted, merged)
            for x, y in doc['have']:
                if x < b and y > a:
                    if x - a > 0.3:
                        todo.append([a, x])
                    a = max(a, y)
            if b - a > 0.3:
                todo.append([a, b])
        if todo:
            if not shutil.which(WHISPER) or not Path(MODEL).exists():
                raise RuntimeError('whisper.cpp is not set up: brew install whisper-cpp, and point CUTROOM_MODEL at a ggml model')
            if not (f := pcm(m)):
                raise RuntimeError('could not read audio')
            total, done = sum(b - a for a, b in todo), 0.0
            try:
                for a, b in todo:
                    ws = listen(f, a, b, lang, lambda x: TX_PCT.__setitem__(mid, round((done + x * (b - a)) / total, 3)))
                    # ponytail: a word cut by a span's edge stays cut (the 1 s pad keeps edges out of the used part)
                    doc['words'] = [w for w in doc['words'] if not a <= (w['s'] + w['e']) / 2 < b] + ws
                    doc['have'] = spans(doc['have'] + [[a, b]], dur)
                    done += b - a
            finally:
                TX_PCT.pop(mid, None)
                if done:
                    doc['words'].sort(key=lambda w: w['s'])
                    cache.write_text(json.dumps(doc))
    return doc['words']


def listen(f, a, b, lang, prog):
    """whisper.cpp on [a, b] seconds of a PCM copy (s16 48 kHz stereo): words in source time. prog(0..1) as it goes."""
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        wav, base = Path(td) / 'a.wav', Path(td) / 'out'
        if sh(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', '48000', '-ac', '2', '-ss', f'{a:.3f}', '-t', f'{b - a:.3f}', '-i', str(f),
               '-ac', '1', '-ar', '16000', str(wav)]).returncode:
            raise RuntimeError('could not read audio')
        preset = re.search(r'ggml-(tiny|base|small|medium|large-v[123](?:-turbo)?)(\.en)?', Path(MODEL).name)
        dtw = ['-nfa', '-dtw', preset[1].replace('-', '.') + (preset[2] or '')] if preset else []  # DTW needs flash-attn off
        p = subprocess.Popen([WHISPER, '-m', MODEL, '-f', str(wav), '-l', lang, '-ojf', '-of', str(base), '-np', '-pp', *dtw],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors='replace')
        err = []
        for line in p.stderr:
            err = (err + [line])[-40:]
            if hit := re.search(r'progress =\s*(\d+)%', line):
                prog(int(hit[1]) / 100)
        if p.wait():
            raise RuntimeError(plain('Transcribing', ''.join(err), p.returncode))
        # surrogateescape: non-Latin characters can be split across tokens; bytes are rejoined per word below
        segs = json.loads(base.with_suffix('.json').read_text(encoding='utf-8', errors='surrogateescape'))['transcription']
        speech = None  # Silero VAD runs separately: whisper's own --vad reports DTW times on the silence-stripped timeline
        if Path(VAD).exists() and shutil.which('whisper-vad-speech-segments'):
            v = sh(['whisper-vad-speech-segments', '-vm', VAD, '-f', str(wav)])
            speech = [(float(x) / 100, float(y) / 100) for x, y in re.findall(r'start = ([\d.]+), end = ([\d.]+)', v.stdout)] if not v.returncode else None
    words = words_from_tokens([t for s in segs for t in s.get('tokens', [])], b - a)
    if speech is not None:  # whisper hallucinates on music ("The end of the day..."): keep only words VAD hears as speech
        words = [w for w in words if any(x - 0.2 <= (w['s'] + w['e']) / 2 <= y + 0.2 for x, y in speech)]
    return [{**w, 's': round(w['s'] + a, 3), 'e': round(w['e'] + a, 3)} for w in words]


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
            raise RuntimeError(plain('Speaking', r.stderr, r.returncode))
        with open(out, 'rb') as fh:
            return import_file(f"Voiceover - {' '.join(text.split()[:5])}.aiff", fh, out.stat().st_size)


def beats(mid):
    """Beat grid for a music file (CapCut's 'Beats'): onset envelope -> tempo (autocorrelation, 120 BPM prior)
    -> dynamic-programming beat tracking (Ellis 2007), so the grid follows small tempo drifts."""
    m, cache = meta(mid), CACHE / f'{mid}.beats.json'
    if cache.exists():
        return json.loads(cache.read_text())
    sr, hop = 8000, 128  # 62.5 onset frames per second
    # the preview's 48 kHz PCM when it exists: raw samples resample in a third of an MP3/AAC decode (which was ~2/3 of the time).
    # Same BPM on all 22 pack songs; 2 of them had 2 beats each 2-3 frames off the grid read from the file itself
    f = CACHE / f'{mid}.pcm'
    src = ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', str(f)] if f.exists() else ['-i', str(MEDIA / m['file']), '-vn']
    # numpy in the AI venv (ai/beats.py, the same grid) starts first: Python and numpy load while ffmpeg decodes, then ~8 ms
    fast = None if os.environ.get('CUTROOM_BEATS_STDLIB') or not (AI_BIN / 'python').exists() else subprocess.Popen(
        [str(AI_BIN / 'python'), '-I', str(AI_DIR / 'beats.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=AI_ENV)
    raw = subprocess.run(['ffmpeg', '-v', 'error', *src, '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'], capture_output=True).stdout
    if fast:
        try:
            out = json.loads(fast.communicate(raw)[0])
        except (ValueError, OSError):
            out = None  # a broken venv: the stdlib loops below
        if out and out.get('error'):
            raise ValueError(out['error'])
        if out:
            cache.write_text(json.dumps(out))
            return out
    x = array('h')
    x.frombytes(raw[:len(raw) // 2 * 2])
    n, fps = len(x) // hop, sr / hop
    if n < fps * 4:
        raise ValueError('need at least 4 seconds of audio')
    # no venv: the loops run in C (map/sum over slices, max/index), the same sums in the same order: the grid is identical
    # to the per-sample Python loops they replaced (CUTROOM_BEATS_STDLIB=1 forces this path; tests/audio_packs.mjs times both)
    from operator import mul, sub
    env = [math.log1p(sum(map(mul, b, b)) / hop / 1e4) for b in (x[i * hop:(i + 1) * hop] for i in range(n))]
    on = [0.0] + [max(0.0, e - d) for d, e in zip(env, env[1:])]
    sd = statistics.pstdev(on) or 1.0
    on = [v / sd for v in on]
    prior = lambda L: math.exp(-0.5 * math.log2(60 * fps / L / 120) ** 2)
    period = max(range(int(60 * fps / 180), int(60 * fps / 60) + 1), key=lambda L: prior(L) * sum(map(mul, on[L:], on)))
    score, back = on[:], [-1] * n
    pen = [100 * math.log(d / period) ** 2 for d in range(2 * period, period // 2, -1)]  # pen[j]: a jump of 2 * period - j frames
    for t in range(n):
        lo, hi = max(0, t - 2 * period), max(0, t - period // 2)
        if hi > lo:  # the best previous beat: the first maximum, as the loop's strict > kept
            v = list(map(sub, score[lo:hi], pen[2 * period - t + lo:]))
            best = max(v)
            score[t], back[t] = on[t] + best, lo + v.index(best)
    t = max(range(max(0, n - period), n), key=lambda i: score[i])
    grid = []
    while t >= 0:
        grid.append(t)
        t = back[t]
    out = {'bpm': round(60 * fps / period, 1), 'beats': [round(i / fps, 3) for i in reversed(grid)]}
    cache.write_text(json.dumps(out))
    return out


# VideoToolbox HDR (HLG/PQ) -> SDR BT.709. scale_vt converts the pixels but leaves the frames tagged bt2020nc, so every RGB
# conversion after it (and the proxy's own labels) read BT.709 data as BT.2020: setparams retags them, and the bare scale
# makes the link take the new tags (without it ffmpeg's auto RGB conversion still reads them wrong)
VT_SDR = ('scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,format=yuv420p,'
          'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,scale,')


def hdr_decode(m):
    """HLG/PQ -> SDR BT.709 the way the export does it (VideoToolbox; rotation by hand, autorotate can't touch hw
    frames): ffmpeg input args + filters ending in ','. Empty for SDR."""
    if not m.get('hdr') or m.get('alpha'):
        return [], ''
    tr = {90: 'transpose=clock,', 180: 'hflip,vflip,', 270: 'transpose=cclock,'}.get(-m.get('rot', 0) % 360, '')
    # -display_rotation 0: the pixels are turned by hand, so files made from them must not carry the phone's rotation too
    return (['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate', '-display_rotation', '0', '-threads', '1'], VT_SDR + tr)


def still(mid, t):
    """Freeze frame: grab one frame as a new image in the library."""
    m = meta(mid)
    if m.get('duration'):  # the playhead at a clip's very end asks for the time after the last frame: take the last frame
        t = max(0.0, min(t, math.floor((m['duration'] - 1 / (m.get('fps') or 30)) * 1000) / 1000))  # floored: -ss 19.967 is past a frame at 19.96667
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        f, src = Path(td) / 'frame.png', str(MEDIA / m['file'])
        dec, vf = hdr_decode(m)
        out = ['-vf', f'{vf}format=rgb24'] if dec else []  # HDR: tone-map like video(), or the still imports as 16-bit HLG and breaks the export
        grab = lambda seek, last=False: sh(['ffmpeg', '-v', 'error', '-y', *dec, *seek, '-i', src, *out, *([] if last else ['-frames:v', '1']), '-update', '1', str(f)])
        if grab(['-ss', f'{t:.3f}']).returncode or not f.exists():  # past the video's last frame (its stream can end before the file's duration): the last frame
            if grab(['-sseof', '-1'], last=True).returncode or not f.exists():
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
            raise RuntimeError(plain(f'Building the {name} tool', r.stderr, r.returncode))
    return str(exe)


SYS_FONTS = []  # the Mac's font families, listed once per server run


def system_fonts():
    if not SYS_FONTS:
        r = sh([build_tool('fonts')])
        SYS_FONTS.extend(json.loads(r.stdout or '[]') if r.returncode == 0 else [])
    return SYS_FONTS


FONT_MAGIC = {b'\x00\x01\x00\x00': '.ttf', b'true': '.ttf', b'OTTO': '.otf', b'wOF2': '.woff2'}


def import_font(name, data):
    """A .ttf / .otf / .woff2 into <library>/fonts for every project; the page registers it (FontFace) under `family`."""
    ext = FONT_MAGIC.get(data[:4])
    if not ext or len(data) > 32 << 20:
        raise ValueError('not a font file (.ttf, .otf or .woff2)')
    d = HOME / 'fonts'
    d.mkdir(parents=True, exist_ok=True)
    import hashlib
    fid = hashlib.sha256(data).hexdigest()[:12]  # the same file twice is one font
    if (d / f'{fid}.json').exists():
        return json.loads((d / f'{fid}.json').read_text())
    base = re.sub(r'[^\w\- ]', '', Path(name).stem).strip()[:60] or 'Font'  # no quotes: it goes into a CSS font string
    taken, fam, n = {json.loads(f.read_text())['family'] for f in d.glob('*.json')}, base, 2
    while fam in taken:
        fam, n = f'{base} {n}', n + 1
    (d / f'{fid}{ext}').write_bytes(data)
    info = {'id': fid, 'family': fam, 'file': f'{fid}{ext}'}
    (d / f'{fid}.json').write_text(json.dumps(info))
    return info


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


def track(st, mid, t0, t1, box, path=None, span=(0.0, 1.0)):
    """Follow a box (normalized, display orientation) from t0 to t1 with Vision; returns per-frame boxes."""
    proc = subprocess.Popen([build_tool('track'), str(path or MEDIA / meta(mid)['file']), f'{t0:.4f}', f'{t1:.4f}', *(f'{box[k]:.5f}' for k in 'xywh')],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    pts, lost = [], False
    for line in proc.stdout:
        d = json.loads(line)
        if d.get('lost'):
            lost = True
            continue
        pts.append({k: d[k] for k in ('t', 'x', 'y', 'w', 'h')})
        st['progress'] = span[0] + (span[1] - span[0]) * min(1.0, (d['t'] - t0) / max(t1 - t0, 0.01))
    err = proc.stderr.read()
    if proc.wait() or not pts:
        raise RuntimeError(err.strip()[-300:] or 'tracking failed')
    return {'points': pts, 'lost': lost}


def follow(st, mid, t0, t1, box, t=None):
    """Motion tracking for attaching things and blurring: position, scale and rotation (ai/track.py, OpenCV corners), both
    ways from the picked frame t. Points {t, cx, cy, x, y, w, h, s, r}: s and r (clockwise degrees) relative to that frame.
    Without the AI tools (or with too little detail in the box) Vision follows the box forward: scale = its width, no turn."""
    m = meta(mid)
    t = t0 if t is None else min(max(t, t0), t1)
    if (AI_BIN / 'python').exists():
        dec, vf = hdr_decode(m)
        proc = subprocess.Popen([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'track.py'), str(MEDIA / m['file']), f'{t0:.4f}', f'{t1:.4f}', f'{t:.4f}',
                                 str(float(m.get('fps') or 30)), *(f'{box[k]:.5f}' for k in 'xywh'), json.dumps(dec), vf],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=AI_ENV)
        pts, lost = [], [False, False]
        for line in proc.stdout:
            d = json.loads(line)
            if 'p' in d:
                st['progress'] = d['p']
            elif 'lost' in d:
                lost = d['lost']
            else:
                pts.append(d)
        err = proc.stderr.read()
        if not proc.wait() and pts:
            return {'points': pts, 'lost': any(lost), 'engine': 'corners'}
        if 'too little detail' not in err:
            raise RuntimeError(err.strip().splitlines()[-1][-300:] if err.strip() else 'tracking failed')
    r = track(st, mid, t, t1, box)
    w0 = r['points'][0]['w'] or 1
    return {**r, 'engine': 'vision', 'points': [{**p, 'cx': p['x'] + p['w'] / 2, 'cy': p['y'] + p['h'] / 2, 's': p['w'] / w0, 'r': 0} for p in r['points']]}


def remove_object(st, mid, t, t0, t1, box, quality='best', mode='remove', seed=None):
    """CapCut's "Remove object" for video, on this Mac: Vision follows the box both ways from t, then every frame of
    [t0, t1] gets the background filled in (ai/remove.py; best = SAM 2 outline + ProPainter when installed)
    -> a new library item covering just that range."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('pick a video clip')
    if not (AI_BIN / 'python').exists():
        raise RuntimeError('the on-device AI tools are not installed (README: On-device AI)')
    fps = float(m.get('fps') or 30)
    if mode == 'mask':  # an AI mask: SAM 2's outline frames for the clip's mask, at most 30 a second (the mask holds between them)
        fps = min(fps, 30.0)
    t0, t1 = fnum(t0, 0, m['duration']), fnum(t1, 0, m['duration'])
    if t1 - t0 < 2 / fps:
        raise ValueError('the clip is too short')
    t, b = fnum(t, t0, t1), {k: fnum((box or {}).get(k), 0, 1) for k in 'xywh'}
    if b['w'] < 0.004 or b['h'] < 0.004:
        raise ValueError('draw a box around the object')
    src, pts, lost = str(MEDIA / m['file']), [{'t': t, **b}], False
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        if mode in ('cutout', 'mask'):  # SAM 2 follows the subject itself
            pass
        elif t1 - t > 1 / fps:
            r = track(st, mid, t, t1, b, span=(0.0, 0.15))
            pts, lost = pts + r['points'], r['lost']
        if mode not in ('cutout', 'mask') and t - t0 > 1 / fps:  # Vision only tracks forward: track a reversed proxy of [t0, t]
            rev = Path(td) / 'rev.mp4'
            if sh(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t0:.6f}', '-t', f'{t - t0 + 1 / fps:.6f}', '-i', src, '-vf', 'scale=-2:480,reverse', '-an',
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', str(rev)]).returncode:
                raise RuntimeError('could not read the clip')
            r = track(st, mid, 0, t - t0, b, path=rev, span=(0.15, 0.3))
            pts, lost = pts + [{**p, 't': t - p['t']} for p in r['points']], lost or r['lost']
        pts.sort(key=lambda p: p['t'])
        times, n, boxes = [p['t'] for p in pts], max(2, round((t1 - t0) * fps)), []
        for i in range(n):  # one box per output frame: the nearest tracked one (held where tracking was lost)
            ti, j = t0 + i / fps, bisect.bisect_left(times, t0 + i / fps)
            p = min((pts[q] for q in (j - 1, j) if 0 <= q < len(pts)), key=lambda p: abs(p['t'] - ti))
            w, h = max(p['w'], b['w']), max(p['h'], b['h'])  # Vision's box drifts smaller; never cover less than was drawn
            boxes.append([p['x'] + p['w'] / 2 - w / 2, p['y'] + p['h'] / 2 - h / 2, w, h])
        dec, vf = hdr_decode(m)
        tags = src_tags(m, dec)
        key = uuid.uuid4().hex[:12]
        out, jf = CACHE / f'{key}.aimask' if mode == 'mask' else Path(td) / ('cut.webm' if mode == 'cutout' else 'clean.mp4'), Path(td) / 'job.json'
        seed_png = None
        if seed:  # the outline confirmed in the preview (a PNG mask of the picked frame): SAM 2 follows exactly that
            seed_png = Path(td) / 'seed.png'
            seed_png.write_bytes(base64.b64decode(str(seed).split(',')[-1]))
            if not seed_png.read_bytes().startswith(b'\x89PNG'):
                raise ValueError('seed must be a PNG mask')
        jf.write_text(json.dumps({'src': src, 'out': str(out), 't0': t0, 'dur': t1 - t0, 'fps': fps, 'w': m['w'], 'h': m['h'],
                                  'boxes': boxes, 'pick': round((t - t0) * fps), 'box': [b['x'], b['y'], b['w'], b['h']], 'mode': mode,
                                  'engine': 'fast' if quality == 'fast' else 'best', 'dec': dec, 'vf': vf, 'tags': tags, 'seed': str(seed_png) if seed_png else None}))
        proc = subprocess.Popen([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'remove.py'), str(jf)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors='replace', env=AI_ENV)  # one pipe: model warnings can't fill a second one and stall it
        engine, said = 'classical', []
        for line in proc.stdout:
            if line.startswith('progress '):
                st['progress'] = 0.3 + 0.68 * float(line.split()[1])
            elif line.startswith('engine '):
                engine = line.split()[1]
            elif line.strip():
                said = (said + [line.strip()])[-5:]
        if proc.wait() or not out.exists():
            if mode == 'mask':
                shutil.rmtree(out, ignore_errors=True)
            raise RuntimeError({'cutout': 'cutting out', 'mask': 'the AI mask'}.get(mode, 'object removal') + ' failed: ' + (said[-1][-300:] if said else 'no output'))
        if mode == 'mask':  # PNGs, white with SAM 2's soft outline as alpha, one per frame from t0 (served from /cache/<key>.aimask/)
            return {'mask': key, 'n': len(list(out.glob('*.png'))), 'fps': fps, 't0': t0, 'frames': n, 'engine': engine}
        with open(out, 'rb') as fh:
            res = import_file(f"{Path(m['name']).stem} ({'cutout' if mode == 'cutout' else 'object removed'}).{out.suffix[1:]}", fh, out.stat().st_size,
                              background=False)
    return {'media': res['id'], 'frames': n, 'lost': lost, 'engine': engine}


def sync_media(ids):
    """Multicam: offsets that line the recordings up by their sound (ai/sync.py, numpy in the AI venv). offset k =
    time in k - time in the first, for the same moment."""
    ms = [meta(i) for i in ids]
    if not 2 <= len(ms) <= 6:
        raise ValueError('pick 2 to 6 recordings')
    if any(not m.get('hasAudio') for m in ms):
        raise ValueError('every angle needs its own sound to be synced: ' + ', '.join(m['name'] for m in ms if not m.get('hasAudio')))
    if not (AI_BIN / 'python').exists():
        raise ValueError('syncing needs the on-device AI tools (ai/setup.sh)')
    r = subprocess.run([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'sync.py'), *[str(MEDIA / m['file']) for m in ms]], capture_output=True, text=True, env=AI_ENV, timeout=600)
    if r.returncode:
        raise RuntimeError((r.stderr or 'sync failed').strip().splitlines()[-1])
    return json.loads(r.stdout.strip().splitlines()[-1])


def mask_preview(mid, t, box, points=None, purpose='remove'):
    """The exact outline (SAM 2) of what a box covers on one frame: the user checks it before Best removal runs.
    purpose 'remove' also offers (and picks) everything SAM 2 is sure of together; 'cutout' keeps to one outline."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('pick a video clip')
    if not (AI_BIN / 'python').exists() or not (AI_DIR / 'vendor' / 'sam2' / 'checkpoints' / 'sam2.1_hiera_small.pt').exists():
        raise RuntimeError('SAM 2 is not installed (README: On-device AI)')
    t, b = fnum(t, 0, m['duration']), {k: fnum((box or {}).get(k), 0, 1) for k in 'xywh'}
    if b['w'] < 0.004 or b['h'] < 0.004:
        raise ValueError('draw a box around the object')
    pts = [[fnum(q[0], 0, 1), fnum(q[1], 0, 1), 1 if q[2] else 0] for q in (points or [])[:20]]  # clicked spots: keep (1) / leave out (0)
    dec, vf = hdr_decode(m)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        r = ai_worker('preview', job={'src': str(MEDIA / m['file']), 'out': str(Path(td) / 'mask.png'), 't': t, 'w': m['w'], 'h': m['h'], 'dec': dec, 'vf': vf,
                                      'box': [b['x'], b['y'], b['w'], b['h']], 'points': pts, 'purpose': 'cutout' if purpose == 'cutout' else 'remove'})
        files = [Path(td) / f'mask{i}.png' for i in range(len(r['areas']))]
        if not all(f.exists() for f in files):
            raise RuntimeError('finding the object failed')
        # every candidate outline (smallest first: part ... whole) and the one that fits the box; the client steps through them
        masks = [base64.b64encode(f.read_bytes()).decode() for f in files]
        return {'masks': masks, 'areas': r['areas'], 'scores': r['scores'], 'pick': r['pick'], 'area': r['areas'][r['pick']], 'mask': masks[r['pick']], 'unsure': r['unsure']}


def isolate(st, mid, keep='voice'):
    """CapCut's "Isolate voice", and its reverse (the music and ambience without the voice), on this Mac: Demucs
    (htdemucs, Defossez / Meta) splits the sound -> a new audio library item the length of the source, cached."""
    m, keep = meta(mid), keep if keep in ('voice', 'music', 'stems') else 'music'
    if not m.get('hasAudio'):
        raise ValueError('this clip has no sound')
    if not (AI_BIN / 'python').exists():
        raise RuntimeError('the on-device AI tools are not installed (README: On-device AI)')
    memo = CACHE / f'{mid}.isolate.json'
    done = json.loads(memo.read_text()) if memo.exists() else {}
    if keep == 'stems' and done.get('stems') and all((MEDIA / f'{x}.json').exists() for x in done['stems'].values()):
        return {'stems': done['stems']}
    if keep != 'stems' and done.get(keep) and (MEDIA / f"{done[keep]}.json").exists():
        return {'media': done[keep]}
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        wav = Path(td) / 'in.wav'
        if sh(['ffmpeg', '-v', 'error', '-y', '-i', str(MEDIA / m['file']), '-vn', '-ac', '2', '-ar', '44100', str(wav)]).returncode:
            raise RuntimeError('could not read the sound')
        two = [] if keep == 'stems' else ['--two-stems', 'vocals']  # stems: vocals, drums, bass, other
        proc = subprocess.Popen([str(AI_BIN / 'python'), '-I', '-m', 'demucs', *two, '-d', 'mps', '-o', td, str(wav)],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', env={**AI_ENV, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'})
        tail = ''
        while chunk := proc.stdout.read(256):  # tqdm "11.7/23.4 [" (seconds of audio) -> progress
            tail = (tail + chunk)[-2000:]
            if hit := re.findall(r'([\d.]+)/([\d.]+) \[', tail):
                st['progress'] = 0.9 * float(hit[-1][0]) / max(0.01, float(hit[-1][1]))
        if keep == 'stems':
            if proc.wait():
                raise RuntimeError('splitting into stems failed: ' + tail.strip()[-300:])
            stems = {}
            for name in ('vocals', 'drums', 'bass', 'other'):
                out = Path(td) / f'{name}.m4a'
                if sh(['ffmpeg', '-v', 'error', '-y', '-i', str(Path(td) / 'htdemucs' / 'in' / f'{name}.wav'), '-c:a', 'aac', '-b:a', '192k', str(out)]).returncode:
                    raise RuntimeError(f'encoding the {name} stem failed')
                with open(out, 'rb') as fh:
                    stems[name] = import_file(f"{Path(m['name']).stem} ({name}).m4a", fh, out.stat().st_size, background=False)['id']
            memo.write_text(json.dumps({**done, 'stems': stems}))
            return {'stems': stems}
        stem = Path(td) / 'htdemucs' / 'in' / ('vocals.wav' if keep == 'voice' else 'no_vocals.wav')
        if proc.wait() or not stem.exists():
            raise RuntimeError('voice separation failed: ' + tail.strip()[-300:])
        out = Path(td) / 'out.m4a'
        if sh(['ffmpeg', '-v', 'error', '-y', '-i', str(stem), '-c:a', 'aac', '-b:a', '192k', str(out)]).returncode:
            raise RuntimeError('encoding the separated sound failed')
        with open(out, 'rb') as fh:
            res = import_file(f"{Path(m['name']).stem} ({'voice' if keep == 'voice' else 'no voice'}).m4a", fh, out.stat().st_size, background=False)
    memo.write_text(json.dumps({**done, keep: res['id']}))
    return {'media': res['id']}


def matte(st, mid, t0=None, t1=None):
    """Remove the background (Vision person segmentation) -> VP9+alpha WebM, a new library item.
    WebM/VP9 alpha plays transparent in Chrome and is ~30x smaller than the ProRes 4444 the tool writes.
    With t0/t1 only that range (the part a clip uses) is processed, and the cutout starts at t0."""
    m = meta(mid)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        pro, out, src = Path(td) / 'cut.mov', Path(td) / 'cut.webm', MEDIA / m['file']
        if t0 is not None and t1 is not None and (t0 > 0.05 or t1 < m['duration'] - 0.05):  # cut the range first (Apple's encoder, near lossless)
            rng = Path(td) / 'range.mov'
            r = sh(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t0:.6f}', '-t', f'{t1 - t0:.6f}', '-i', str(src), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'h264_videotoolbox', '-q:v', '80',
                    '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', str(rng)])
            if r.returncode:
                raise RuntimeError(plain('Cutting the range', r.stderr, r.returncode))
            src = rng
        proc = subprocess.Popen([build_tool('matte'), str(src), str(pro), 'balanced'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
        r = sh(['ffmpeg', '-v', 'error', '-y', '-i', str(pro), '-i', str(src), '-map', '0:v', '-map', '1:a?', '-vf', f'{relabel},{MATTE_VF}',
                '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
                '-c:a', 'libopus', '-b:a', '128k', str(out)])
        if r.returncode:
            raise RuntimeError(plain('Encoding the cutout', r.stderr, r.returncode))
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
                    *(['-vf', 'reverse', '-c:v', 'h264_videotoolbox', '-q:v', '70'] if video else ['-vn']),
                    *(['-af', 'areverse', '-c:a', 'pcm_s16le'] if m['hasAudio'] else ['-an']), str(f)])
            if r.returncode:
                raise RuntimeError(plain('Reversing', r.stderr, r.returncode))
            parts.append(f)
            st['progress'] = 0.9 * (i + 1) / n
        (Path(td) / 'list.txt').write_text(''.join(f"file '{f}'\n" for f in reversed(parts)))
        out = Path(td) / ('rev.mp4' if video else 'rev.m4a')
        r = sh(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(Path(td) / 'list.txt'), *(['-c:v', 'copy'] if video else []),
                *(['-c:a', 'aac', '-b:a', '192k'] if m['hasAudio'] else []), '-movflags', '+faststart', str(out)])
        if r.returncode:
            raise RuntimeError(plain('Joining the reversed pieces', r.stderr, r.returncode))
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
                    '-vf', vf, '-c:v', 'h264_videotoolbox', '-q:v', '68', '-c:a', 'copy', '-movflags', '+faststart', str(out)],
                   m['duration'], lambda x: st.update(progress=0.95 * x))
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (stabilized).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def denoise(st, mid, t0, t1, strength='light'):
    """A noise-reduced copy of the clip's range (night footage's grain), spatial and across frames. It is a file,
    so the preview and the export show the same frames; HDR is tone mapped like the proxy."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('only video has picture noise to reduce')
    dec, vf = hdr_decode(m)
    # averaged across 9 / 15 frames where little changes, then hqdn3d: on DJI night footage the light one takes 62 % of the
    # frame-to-frame noise out (3 s of 4K60 in 9 s); hqdn3d alone took 10 %
    t = (0.2, 0.4, 15, '6:4.5:20:15') if strength == 'strong' else (0.12, 0.24, 9, '4:3:12:9')
    nr = f"atadenoise=0a={t[0]}:0b={t[1]}:1a={t[0]}:1b={t[1]}:2a={t[0]}:2b={t[1]}:s={t[2]},hqdn3d={t[3]}"
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'denoised.mp4'
        run_ffmpeg(['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *dec, '-ss', f'{t0:.6f}', '-t', f'{t1 - t0:.6f}',
                    '-i', str(MEDIA / m['file']), '-map', '0:v:0', '-map', '0:a:0?', '-vf', f'{vf}{nr}', '-c:v', 'h264_videotoolbox', '-q:v', '72', '-c:a', 'copy',
                    '-movflags', '+faststart', str(out)], t1 - t0, lambda x: st.update(progress=0.95 * x), 'Reducing the noise')
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (denoised).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def faces(st, mid, t0, t1, mode='largest', rate=5, span=(0.0, 1.0)):
    """Faces over time (Apple Vision). largest: the biggest face per sample, for auto-reframe. all: every face, grouped into
    one track per face (nearest box in the last 0.5 s), for blur-all-faces. subject: auto-reframe's target, the largest face
    when the clip has faces in 40 % of its samples, else Vision's saliency (the salient object that carries on from the last one)."""
    if mode == 'subject':
        r = faces(st, mid, t0, t1, 'samples', rate, (0.0, 0.5))
        n = len(r['samples']) or 1
        if sum(1 for s in r['samples'] if s['f']) >= 0.4 * n:
            big = [{'t': s['t'], **dict(zip('xywh', max(s['f'], key=lambda b: b[2] * b[3])))} for s in r['samples'] if s['f']]
            return {'points': big, 'kind': 'face'}
        sal, pts, last = faces(st, mid, t0, t1, 'salient', rate, (0.5, 1.0))['samples'], [], None
        for s in sal:
            if not s['f']:
                continue
            b = max(s['f'], key=lambda b: b[4] * math.sqrt(b[2] * b[3]) + (iou(b, last) if last else 0))
            last = b
            pts.append({'t': s['t'], **dict(zip('xywh', b[:4]))})
        if not pts:
            raise RuntimeError('found no face and no clear subject in this clip')
        return {'points': pts, 'kind': 'subject'}
    proc = subprocess.Popen([build_tool('faces'), str(MEDIA / meta(mid)['file']), f'{t0:.4f}', f'{t1:.4f}', str(rate), 'all' if mode == 'samples' else mode],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)  # samples: every face per sample, as found
    pts = []
    for line in proc.stdout:
        d = json.loads(line)
        pts.append(d if 'f' in d else {k: d[k] for k in ('t', 'x', 'y', 'w', 'h')})
        st['progress'] = span[0] + (span[1] - span[0]) * min(1.0, (d['t'] - t0) / max(t1 - t0, 0.01))
    err = proc.stderr.read()
    if proc.wait():
        raise RuntimeError(err.strip()[-300:] or 'face detection failed')
    if mode in ('salient', 'samples'):
        return {'samples': pts}
    if mode == 'all':
        tracks = []
        for s in pts:
            for b in sorted(s['f'], key=lambda b: -b[2] * b[3]):
                near = [k for k in tracks if s['t'] - k[-1]['t'] <= 0.5 and k[-1]['t'] < s['t'] and
                        math.hypot(k[-1]['x'] + k[-1]['w'] / 2 - b[0] - b[2] / 2, k[-1]['y'] + k[-1]['h'] / 2 - b[1] - b[3] / 2) < 0.6 * max(b[2], b[3], k[-1]['w'])]
                k = min(near, key=lambda k: math.hypot(k[-1]['x'] - b[0], k[-1]['y'] - b[1]), default=None)
                if k is None:
                    tracks.append(k := [])
                k.append({'t': s['t'], **dict(zip('xywh', b))})
        tracks = [k for k in tracks if len(k) >= 2 or len(pts) < 3]  # one stray hit is a false face; a still photo has one sample
        if not tracks:
            raise RuntimeError('no face found in this clip')
        return {'samples': pts, 'tracks': tracks}
    if not pts:
        raise RuntimeError('no face found in this clip')
    return {'points': pts}


def iou(a, b):
    """Overlap of two [x, y, w, h] boxes (intersection over union)."""
    w = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    return w * h / max(1e-9, a[2] * a[3] + b[2] * b[3] - w * h)


# Retouch (CapCut's face and body retouch): slider -> range. Colours are '#rrggbb'. ai/retouch.py does the work.
RETOUCH = {'smooth': (0, 1), 'bright': (0, 1), 'eyes': (0, 1), 'teeth': (0, 1), 'slim': (0, 1), 'width': (-1, 1), 'cheek': (-1, 1),
           'jaw': (-1, 1), 'chin': (-1, 1), 'nose': (-1, 1), 'lips': (0, 1), 'blush': (0, 1), 'body': (0, 1), 'legs': (0, 1)}


def retouch_params(p):
    p = p if isinstance(p, dict) else {}
    out = {k: round(fnum(p.get(k, 0), *r), 4) for k, r in RETOUCH.items()}
    for k, d in (('lipc', '#b8283f'), ('blushc', '#f2647a')):
        out[k] = p[k] if re.fullmatch(r'#[0-9a-fA-F]{6}', str(p.get(k, ''))) else d
    return out


def retouch_job(m, t0, dur, p, out, lm, still=False):
    dec, vf = hdr_decode(m)
    tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'] if dec else []
    if not dec:  # keep the source's colour labels (untagged stays untagged, so it previews and exports the same)
        for opt, key in (('-colorspace', 'cs'), ('-color_trc', 'trc')):
            if m.get(key) not in (None, '', 'unknown', 'reserved'):
                tags += [opt, m[key]]
    return {'src': str(MEDIA / m['file']), 'out': str(out), 't0': t0, 'dur': dur, 'fps': float(m.get('fps') or 30), 'w': m['w'], 'h': m['h'],
            'dec': dec, 'vf': vf, 'tags': tags, 'mat': '601' if not dec and m.get('cs') in ('bt470bg', 'smpte170m') else '709',
            'p': p, 'lm': str(lm), 'still': still, 'detect': build_tool('retouch'), 'max': 1920}


def run_retouch(jf, what):
    r = subprocess.run([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'retouch.py'), str(jf)], capture_output=True, text=True, env=AI_ENV, timeout=120)
    if r.returncode:
        raise RuntimeError(f'{what} failed: ' + ((r.stderr or r.stdout).strip().splitlines() or ['no output'])[-1][-300:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def retouch_preview(mid, t, p):
    """One frame retouched (the paused frame), as a PNG: the sliders' live preview. The frame's landmarks are cached."""
    m = meta(mid)
    if m['kind'] != 'video' or not (AI_BIN / 'python').exists():
        raise ValueError('retouch works on video clips (and needs the on-device AI tools: ai/setup.sh)')
    t = fnum(t, 0, max(0.0, m['duration'] - 1 / (m.get('fps') or 30)))
    lm = CACHE / f'rt_{mid}_{t:.4f}.lm'
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        jf, out = Path(td) / 'job.json', Path(td) / 'frame.png'
        jf.write_text(json.dumps(retouch_job(m, t, 0, retouch_params(p), out, lm, still=True)))
        r = run_retouch(jf, 'The retouch preview')
        return {'png': base64.b64encode(out.read_bytes()).decode(), 'faces': r['faces'], 'bodies': r['bodies'], 't': t}


def retouch(st, mid, t0, t1, p):
    """A retouched copy of the clip's range: Vision finds the face landmarks and body pose on every frame (tools/retouch),
    ai/retouch.py smooths them over time and renders skin, eyes, teeth, makeup, face shape and body. The same clip and
    sliders again are the same copy (no render)."""
    import hashlib
    m, p = meta(mid), retouch_params(p)
    if m['kind'] != 'video' or m.get('alpha') or m.get('trans'):
        raise ValueError('retouch works on video clips without transparency')
    if not (AI_BIN / 'python').exists():
        raise RuntimeError('the on-device AI tools are not installed (README: On-device AI)')
    t0, t1 = fnum(t0, 0, m['duration']), fnum(t1, 0, m['duration'])
    if t1 - t0 < 1 / (m.get('fps') or 30):
        raise ValueError('the clip is too short')
    key = 'retouch:' + hashlib.sha1(json.dumps([mid, round(t0, 6), round(t1, 6), p], sort_keys=True).encode()).hexdigest()
    if hit := find_key(key):
        return {'media': hit['id'], 'cached': True}
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        lm, out, jf = Path(td) / 'lm.jsonl', Path(td) / 'retouched.mp4', Path(td) / 'job.json'
        proc = subprocess.Popen([build_tool('retouch'), str(MEDIA / m['file']), f'{t0:.6f}', f'{t1:.6f}'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        n = found = 0
        with open(lm, 'w') as f:
            for line in proc.stdout:
                f.write(line)
                d = json.loads(line)
                n, found = n + 1, found + bool(d['faces'] or d['bodies'])
                st['progress'] = 0.3 * min(1.0, (d['t'] - t0) / max(t1 - t0, 0.01))
        err = proc.stderr.read()
        if proc.wait():
            raise RuntimeError('finding the faces failed: ' + err.strip()[-300:])
        if not found:
            raise RuntimeError('no face or body found in this clip')
        jf.write_text(json.dumps(retouch_job(m, t0, t1 - t0, p, out, lm)))
        proc = subprocess.Popen([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'retouch.py'), str(jf)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors='replace', env=AI_ENV)
        said = []
        for line in proc.stdout:
            if line.startswith('progress '):
                st['progress'] = 0.3 + 0.68 * float(line.split()[1])
            elif line.strip():
                said = (said + [line.strip()])[-5:]
        if proc.wait() or not out.exists():
            raise RuntimeError('retouching failed: ' + (said[-1][-300:] if said else 'no output'))
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (retouched).mp4", fh, out.stat().st_size, background=False, key=key)
    return {'media': new['id'], 'frames': n, 'found': found}


def src_tags(m, dec):
    """Colour labels for a copy of m's frames: BT.709 after an HDR tone map, else the source's own (untagged stays untagged,
    so it previews and exports the same)."""
    if dec:
        return ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
    p = json.loads(sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer',
                       '-of', 'json', str(MEDIA / m['file'])]).stdout or '{}').get('streams', [{}])[0]
    return [x for opt, key in (('-colorspace', 'color_space'), ('-color_primaries', 'color_primaries'), ('-color_trc', 'color_transfer'))
            if p.get(key) not in (None, '', 'unknown', 'reserved') for x in (opt, p[key])]


def enhance(st, mid, t0, t1, op, opt):
    """AI enhance on this Mac's GPU (ai/enhance.py): RIFE frames between frames (Smooth slow-mo), Real-ESRGAN upscale, depth
    relight -> a copy of the range [t0, t1] in the library, which the clip then plays (preview == export: it is a file)."""
    m = meta(mid)
    if m['kind'] != 'video' or m.get('alpha'):
        raise ValueError('AI enhance works on video without transparency')
    if not (AI_BIN / 'python').exists() or not (AI_DIR / 'vendor' / 'enhance' / 'flownet_v4.25.pkl').exists():
        raise RuntimeError('AI enhance needs the on-device AI tools (run ai/setup.sh)')
    fps = float(m.get('fps') or 30)
    t0, t1 = fnum(t0, 0, m['duration']), fnum(t1, 0, m['duration'])
    if t1 - t0 < 2 / fps:
        raise ValueError('the range is too short')
    if op == 'upscale' and max(m['w'], m['h']) * opt['scale'] > 7680:
        raise ValueError(f"{opt['scale']}x of {m['w']}x{m['h']} is bigger than 8K")
    dec, vf = hdr_decode(m)
    name = {'interp': f"smooth {opt.get('factor')}x", 'upscale': f"upscaled {opt.get('scale')}x", 'relight': 'relit'}[op]
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out, jf = Path(td) / 'enhanced.mp4', Path(td) / 'job.json'
        jf.write_text(json.dumps({'op': op, 'src': str(MEDIA / m['file']), 'out': str(out), 't0': t0, 'dur': t1 - t0, 'fps': fps, 'w': even(m['w']), 'h': even(m['h']),
                                  'dec': dec, 'vf': vf, 'tags': src_tags(m, dec), **opt}))
        proc = subprocess.Popen([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'enhance.py'), str(jf)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors='replace', env={**AI_ENV, 'HF_HUB_OFFLINE': '1'})  # one pipe, as with removal; weights come from setup.sh
        said = []
        for line in proc.stdout:
            if line.startswith('progress '):
                st['progress'] = 0.97 * float(line.split()[1])
            elif line.strip():
                said = (said + [line.strip()])[-5:]
        if proc.wait() or not out.exists():
            raise RuntimeError('AI enhance failed: ' + (said[-1][-300:] if said else 'no output'))
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} ({name}).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def light_opts(L):
    """A relight's light, checked (it goes into a JSON file for enhance.py): preset light | subject | background, x and y on
    the frame (0..1, a little past the edges allowed), colour '#rrggbb', strength 0..1."""
    L = L if isinstance(L, dict) else {}
    col = str(L.get('color', '#ffffff'))
    return {'preset': L.get('preset') if L.get('preset') in ('subject', 'background') else 'light', 'x': fnum(L.get('x', 0.25), -0.5, 1.5),
            'y': fnum(L.get('y', 0.3), -0.5, 1.5), 'color': col if re.fullmatch(r'#[0-9a-fA-F]{6}', col) else '#ffffff', 'strength': fnum(L.get('strength', 0.6), 0, 1)}


def relight_preview(mid, t, light):
    """One frame of a relight as a PNG (base64), to place the light before the clip renders (ai/worker.py keeps the model)."""
    m = meta(mid)
    if m['kind'] != 'video' or m.get('alpha'):
        raise ValueError('relight works on video without transparency')
    if not (AI_BIN / 'python').exists():
        raise RuntimeError('relight needs the on-device AI tools (run ai/setup.sh)')
    dec, vf = hdr_decode(m)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        f = Path(td) / 'relit.png'
        ai_worker('relight', job={'src': str(MEDIA / m['file']), 'out': str(f), 't': fnum(t, 0, m['duration']), 'w': even(m['w']), 'h': even(m['h']),
                                  'dec': dec, 'vf': vf, 'light': light})
        if not f.exists():
            raise RuntimeError('the relight preview made no picture')
        return {'png': base64.b64encode(f.read_bytes()).decode()}


def deflicker(st, mid, t0, t1):
    """A copy of the range with its frame-to-frame brightness pumping evened out (timelapses, lights on mains power, auto
    exposure hunting): ffmpeg deflicker, each frame's brightness pulled to the power mean of 9 around it (luma only)."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('only video flickers')
    dec, vf = hdr_decode(m)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'deflickered.mp4'
        run_ffmpeg(['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *dec, '-ss', f'{t0:.6f}', '-t', f'{t1 - t0:.6f}',
                    '-i', str(MEDIA / m['file']), '-map', '0:v:0', '-map', '0:a:0?', '-vf', f'{vf}format=yuv444p,deflicker=size=9:mode=pm', '-c:v', 'h264_videotoolbox',
                    '-q:v', '72', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', str(out)], t1 - t0, lambda x: st.update(progress=0.95 * x), 'Deflickering')
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (deflickered).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def slowmo(st, mid, t0, t1, factor, engine='fast'):
    """Smooth slow motion (CapCut 'smooth slow-mo'): motion-interpolated copy of a range at factor x the frame rate,
    so playing it at 1/factor speed still shows a fresh frame every frame. engine 'ai' = RIFE (enhance), 'fast' = minterpolate."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError('only video')
    if engine == 'ai':  # whole multiples only (each real frame stays where it was), up to 240 fps
        return enhance(st, mid, t0, t1, 'interp', {'factor': max(2, min(factor, int(240 // (m.get('fps') or 30))))})
    fps = min(240, m.get('fps', 30) * factor)
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'smooth.mp4'
        run_ffmpeg(['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-ss', f'{t0:.4f}', '-t', f'{t1 - t0:.4f}',
                    '-i', str(MEDIA / m['file']), '-vf', f'minterpolate=fps={fps:g}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1',
                    '-c:v', 'h264_videotoolbox', '-q:v', '68', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(out)],
                   t1 - t0, lambda x: st.update(progress=0.95 * x))
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (smooth {factor}x).mp4", fh, out.stat().st_size, background=False)
    return {'media': new['id']}


def ramp_copy(st, mid, t0, t1, mp, fps):
    """Speed ramp (CapCut's curve): the range t0..t1 retimed by a knot table mp = [[source s, copy t], ...] (s from t0,
    made by the editor's rampMap) into a silent copy at the project's fps, played at 1x: no inner cuts, so it plays
    smoothly and the preview and the export show the same frames. The same curve again is the same copy (no render)."""
    import hashlib
    key = 'ramp:' + hashlib.sha1(json.dumps([mid, t0, t1, fps, mp]).encode()).hexdigest()
    if m := find_key(key):
        return {'media': m['id']}
    m = meta(mid)
    if m['kind'] != 'video' or m.get('alpha') or m.get('trans'):
        raise ValueError('speed ramps work on video without transparency')
    sf = m.get('fps') or 30
    s0 = math.floor(t0 * sf + 1e-6) / sf  # from the frame the preview shows at the in point; lead = how far into it t0 is
    lead, n = t0 - s0, round(mp[-1][1] * fps)
    dec, vf = hdr_decode(m)
    G = pw([{'t': s, 'v': t} for s, t in mp], 'v', f'((PTS-STARTPTS)*TB-{lead:.6f})')
    vf += f"setpts='({G})/TB',fps={fps:g}:round=up,tpad=stop_mode=clone:stop_duration=2,trim=end_frame={n}"
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out = Path(td) / 'ramp.mp4'
        run_ffmpeg(['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *dec, '-ss', f'{s0:.6f}', '-t', f'{t1 - s0 + 1 / sf:.6f}',
                    '-i', str(MEDIA / m['file']), '-map', '0:v:0', '-an', '-vf', vf, '-c:v', 'h264_videotoolbox', '-q:v', '72', '-g', f'{round(fps)}',
                    '-movflags', '+faststart', str(out)], mp[-1][1], lambda x: st.update(progress=0.9 * x), 'Rendering the ramp')
        with open(out, 'rb') as fh:
            new = import_file(f"{Path(m['name']).stem} (ramp).mp4", fh, out.stat().st_size, background=False, key=key)
    return {'media': new['id']}


MATTE_VF = 'format=yuva444p'  # matte writes straight alpha (set to 'unpremultiply=inplace=1,...' if that ever changes)


def silences(mid, noise=-35.0, mind=0.5):
    """Pauses (silencedetect) read from the preview's PCM copy and cached per (noise, min): on a 4 GB 4K original every
    Remove pauses click decoded the whole file again (1.2-1.4 s)."""
    m = meta(mid)
    cache = CACHE / f'{mid}.sil{noise:g}_{mind:g}.json'
    if cache.exists():
        return json.loads(cache.read_text())
    f = pcm(m) if m.get('hasAudio') else None
    src = ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', str(f)] if f else ['-i', str(MEDIA / m['file']), '-vn']
    r = sh(['ffmpeg', '-hide_banner', '-nostats', *src, '-af', f'silencedetect=noise={noise:g}dB:d={mind:g}', '-f', 'null', '-'])
    st = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', r.stderr)]
    en = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', r.stderr)]
    en += [m['duration']] * (len(st) - len(en))  # silence running to EOF has no end line
    out = [[max(0.0, a), b] for a, b in zip(st, en)]
    if f and not r.returncode:
        cache.write_text(json.dumps(out))
    return out


def speech(mid):
    """Where someone talks in a file, [[start, end], ...] seconds: Silero VAD (as captions use) on the preview's PCM, cached
    per file. Auto-duck used loudness (silencedetect) and heard the road under a night drive as talk: 99 % of the song
    ducked; and it read the whole original each time (19 s on 4K clips). VAD over the 48 kHz PCM: ~1 s per 5 minutes."""
    m, out = meta(mid), CACHE / f'{mid}.speech.json'
    if out.exists():
        return json.loads(out.read_text())
    if not (Path(VAD).exists() and shutil.which('whisper-vad-speech-segments')):
        raise RuntimeError('speech detection needs whisper-cpp and the Silero VAD model (models/ggml-silero-v5.1.2.bin)')
    if not m.get('hasAudio') or not (src := pcm(m)):
        return []
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        wav = Path(td) / 'a.wav'
        if sh(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', str(src), '-ac', '1', '-ar', '16000', str(wav)]).returncode:
            raise RuntimeError('could not read the sound')
        v = sh(['whisper-vad-speech-segments', '-vm', VAD, '-f', str(wav)])
    if v.returncode:
        raise RuntimeError(plain('Finding speech', v.stderr, v.returncode))
    segs = [[float(a) / 100, float(b) / 100] for a, b in re.findall(r'start = ([\d.]+), end = ([\d.]+)', v.stdout)]  # centiseconds
    tmp = out.with_suffix('.tmp')
    tmp.write_text(json.dumps(segs))
    tmp.replace(out)
    return segs


AI_DIR = Path(__file__).resolve().parent / 'ai'
AI_BIN = AI_DIR / '.venv' / 'bin'
# PyTorch's GPU cache grows to 1.7x the GPU budget (~48 GB on this 36 GB Mac) before it frees anything, and on a Mac that is
# system memory: stock ProPainter on a head-sized hole took 30 GB and swapped for 15 minutes. Capped, the cache is freed instead
# (that job in half precision: 54-55 s at a cap of 0.35 or 0.6), and a job that really needs more fails fast rather than swap.
AI_ENV = {**{k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}, 'VIRTUAL_ENV': str(AI_DIR / '.venv'), 'PATH': f"{AI_BIN}:{os.environ.get('PATH', '/usr/bin:/bin')}",
          'PYTORCH_MPS_HIGH_WATERMARK_RATIO': '0.45', 'PYTORCH_MPS_LOW_WATERMARK_RATIO': '0.35'}
KOKORO = 'mlx-community/Kokoro-82M-bf16'
HUB = Path.home() / '.cache' / 'huggingface' / 'hub'
AI_LOCK = threading.Lock()  # one generation at a time: two image models at once would push the Mac into swap
WORKER = {'proc': None, 'n': 0, 'lock': threading.Lock()}


def ai_worker(op, timeout=180, **req):
    """Ask the long-lived AI process (ai/worker.py), started on demand: it keeps SAM 2's image model, the frame it last
    embedded and Kokoro loaded, so a second outline click on a frame is milliseconds instead of a 3-36 s model load.
    It quits after 5 idle minutes, at once on a Mac under 16 GB. A worker that died (or just timed out idle) is restarted once."""
    with WORKER['lock']:
        for again in (False, True):
            p = WORKER['proc']
            if p is None or p.poll() is not None:
                with open(CACHE / 'ai-worker.log', 'w') as log:
                    p = WORKER['proc'] = subprocess.Popen([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'worker.py'), '300' if RAM_GB >= 16 else '0'],
                                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, env=AI_ENV)
            WORKER['n'] += 1
            hung = []
            kill = threading.Timer(timeout, lambda: (hung.append(1), p.kill()))
            kill.start()
            try:
                p.stdin.write(json.dumps({'id': WORKER['n'], 'op': op, **req}) + '\n')
                p.stdin.flush()
                while (line := p.stdout.readline()) and json.loads(line).get('id') != WORKER['n']:
                    pass
            except (BrokenPipeError, ValueError):
                line = ''
            finally:
                kill.cancel()
            if line:
                r = json.loads(line)
                if 'error' in r:
                    raise RuntimeError(r['error'])
                return r['result']
            p.kill()
            p.wait()
            WORKER['proc'] = None
            if again or hung:
                break
        log = (CACHE / 'ai-worker.log').read_text(errors='replace').strip().splitlines()
        raise RuntimeError('the AI worker stopped: ' + (log or ['no output'])[-1][-300:])


# ---------- sound effects: synthesized on this Mac, deterministic (no sample packs, nothing downloaded) ----------
SR = 48000
SFX = {  # id: (name, seconds)
    'whoosh': ('Whoosh', 0.9), 'swish': ('Swish', 0.4), 'riser': ('Riser', 2.4), 'boom': ('Boom', 1.8), 'drop': ('Bass drop', 1.6),
    'pop': ('Pop', 0.15), 'click': ('Click', 0.06), 'ding': ('Ding', 1.6), 'chime': ('Notification', 1.1), 'correct': ('Correct', 0.7),
    'buzzer': ('Wrong buzzer', 0.75), 'shutter': ('Camera shutter', 0.4), 'typing': ('Typing', 2.2), 'heartbeat': ('Heartbeat', 1.4),
    'glitch': ('Glitch', 0.7), 'coins': ('Cash register', 1.2), 'drumroll': ('Drum roll', 2.6), 'applause': ('Applause', 3.2), 'ticktock': ('Tick tock', 2.0)}


def _bp(x, f0, f1, q=0.7, curve=None):
    """State-variable band-pass whose centre sweeps from f0 to f1 Hz (exponentially, shaped by curve(u))."""
    out, low, band, f, n = [], 0.0, 0.0, 0.0, max(1, len(x))
    for i, v in enumerate(x):
        if i % 16 == 0:
            fc = f0 * (f1 / f0) ** (curve(i / n) if curve else i / n)
            f = 2 * math.sin(math.pi * min(fc, SR / 8) / SR)
        low += f * band
        band += f * (v - low - q * band)
        out.append(band)
    return out


def sfx_render(sid):
    """Stereo float buffers for one sound, from its recipe."""
    import random
    rnd, dur = random.Random(sid), SFX[sid][1]
    n = int(SR * dur)
    L, R = [0.0] * n, [0.0] * n

    def add(x, at=0.0, g=1.0, pan=0.0):  # equal-power pan, -1 left .. 1 right
        o, gl, gr = int(at * SR), g * math.cos((pan + 1) * math.pi / 4), g * math.sin((pan + 1) * math.pi / 4)
        for i, v in enumerate(x[:max(0, n - o)]):
            L[o + i] += v * gl
            R[o + i] += v * gr

    noise = lambda sec: [rnd.uniform(-1, 1) for _ in range(int(SR * sec))]
    env = lambda x, fn: [v * fn(i / SR) for i, v in enumerate(x)]

    def osc(sec, freq, shape=math.sin):  # freq(t) in Hz, phase-accumulated so sweeps stay smooth
        out, ph = [], 0.0
        for i in range(int(SR * sec)):
            ph += 2 * math.pi * freq(i / SR) / SR
            out.append(shape(ph))
        return out

    def hit(sec, f0, q, k, tone=0.0, tf=0.0):  # a struck noise: band-passed burst with exponential decay, plus an optional body tone
        x = env(_bp(noise(sec), f0, f0, q), lambda t: math.exp(-k * t))
        if tone:
            x = [v + tone * math.sin(2 * math.pi * tf * i / SR) * math.exp(-k * 0.8 * i / SR) for i, v in enumerate(x)]
        return x

    def bell(sec, fc, ratio=3.5, idx=2.2, k=2.2):  # FM bell
        return [math.sin(2 * math.pi * fc * t + idx * math.exp(-3 * t) * math.sin(2 * math.pi * fc * ratio * t)) * math.exp(-k * t)
                * min(1.0, t / 0.002) for t in (i / SR for i in range(int(SR * sec)))]

    def note(sec, f, k):  # soft sine note with two harmonics
        return [(math.sin(2 * math.pi * f * t) + 0.3 * math.sin(4 * math.pi * f * t) + 0.12 * math.sin(6 * math.pi * f * t)) * math.exp(-k * t)
                * min(1.0, t / 0.003) for t in (i / SR for i in range(int(SR * sec)))]

    if sid in ('whoosh', 'swish'):
        f0, f1, q = (260, 2600, 0.8) if sid == 'whoosh' else (900, 6500, 0.6)
        x = env(_bp(noise(dur), f0, f1, q, lambda u: math.sin(math.pi * u)), lambda t: math.sin(math.pi * min(1.0, t / dur)) ** 2)
        for i, v in enumerate(x):  # moves left to right
            th = i / n * math.pi / 2
            L[i] += v * math.cos(th)
            R[i] += v * math.sin(th)
    elif sid == 'riser':
        add(env(_bp(noise(dur), 300, 7000, 0.7, lambda u: u ** 1.6), lambda t: (t / dur) ** 2.2 * min(1.0, (dur - t) / 0.03)), pan=-0.3)
        add(env(_bp(noise(dur), 320, 7400, 0.7, lambda u: u ** 1.6), lambda t: (t / dur) ** 2.2 * min(1.0, (dur - t) / 0.03)), pan=0.3)
        add(env(osc(dur, lambda t: 120 * 10 ** (t / dur)), lambda t: 0.25 * (t / dur) ** 2 * min(1.0, (dur - t) / 0.03)))
    elif sid == 'boom':
        sub = env(osc(dur, lambda t: 38 + 50 * math.exp(-9 * t)), lambda t: math.exp(-2.6 * t) * min(1.0, t / 0.004))
        add([math.tanh(1.6 * v) for v in sub])
        lp, y = [], 0.0
        for v in noise(0.4):
            y += 0.11 * (v - y)
            lp.append(y)
        add(env(lp, lambda t: 2.2 * math.exp(-18 * t)))
    elif sid == 'drop':
        add([math.tanh(2 * v) * 0.8 for v in env(osc(dur, lambda t: 520 * (38 / 520) ** ((t / dur) ** 0.6)), lambda t: min(1.0, t / 0.01) * (1 - t / dur) ** 0.5)])
    elif sid == 'pop':
        add(env(osc(dur, lambda t: 1100 * math.exp(-28 * t) + 260), lambda t: math.exp(-35 * t) * min(1.0, t / 0.001)))
        add(env(noise(0.003), lambda t: 0.3))
    elif sid == 'click':
        add(hit(dur, 3200, 0.5, 300, 0.4, 3200))
    elif sid == 'ding':
        add(bell(dur, 1567.98))
        add(env(osc(dur, lambda t: 1567.98 * 2.76), lambda t: 0.25 * math.exp(-6 * t) * min(1.0, t / 0.002)))
    elif sid in ('chime', 'correct'):
        (f1, f2), gap, k = ((1046.5, 1568.0), 0.13, 4) if sid == 'chime' else ((1318.5, 1975.5), 0.11, 7)
        add(note(dur, f1, k), pan=-0.15)
        add(note(dur - gap, f2, k), gap, pan=0.15)
    elif sid == 'buzzer':
        sq = lambda ph: 1.0 if math.sin(ph) >= 0 else -1.0
        x = [a + b for a, b in zip(osc(dur, lambda t: 146, sq), osc(dur, lambda t: 154, sq))]
        lp, y = [], 0.0
        for v in x:
            y += 0.19 * (v - y)
            lp.append(y)
        add(env(lp, lambda t: 0.5 * min(1.0, t / 0.01, (dur - t) / 0.04)))
    elif sid == 'shutter':
        for at in (0.0, 0.11):
            add(hit(0.2, 2500, 0.4, 120, 0.4, 180), at)
    elif sid == 'typing':
        t = 0.02
        while t < dur - 0.1:
            space = rnd.random() < 0.12
            add(hit(0.06, 900 if space else rnd.uniform(1800, 3200), 0.5, 120 if space else 180), t, rnd.uniform(0.5, 1), rnd.uniform(-0.3, 0.3))
            t += rnd.uniform(0.07, 0.18)
    elif sid == 'heartbeat':
        for at, g in ((0.0, 1.0), (0.28, 0.75)):
            add(env(osc(0.3, lambda t: 45 + 25 * math.exp(-20 * t)), lambda t: math.exp(-14 * t) * min(1.0, t / 0.003)), at, g)
    elif sid == 'glitch':
        t = 0.0
        while t < dur:
            seg, kind = rnd.uniform(0.025, 0.07), rnd.choice(('square', 'crush', 'square', 'gap'))
            if kind == 'square':
                fr = rnd.uniform(80, 1600)
                add(osc(seg, lambda _t: fr, lambda ph: 1.0 if math.sin(ph) >= 0 else -1.0), t, 0.45, rnd.uniform(-0.6, 0.6))
            elif kind == 'crush':
                hold, x = rnd.randint(8, 40), noise(seg)
                add([x[i - i % hold] for i in range(len(x))], t, 0.6, rnd.uniform(-0.6, 0.6))
            t += seg
    elif sid == 'coins':
        add(hit(0.15, 4200, 0.5, 60), 0.0, 0.8)
        add(bell(dur - 0.08, 2093.0, 2.4, 1.6, 3.0), 0.08)
        for _ in range(9):
            add(bell(0.25, rnd.uniform(3000, 6000), 1.7, 1.0, 14), rnd.uniform(0.08, 0.5), 0.3, rnd.uniform(-0.7, 0.7))
    elif sid == 'drumroll':
        t, i = 0.0, 0
        while t < 2.0:
            add(hit(0.15, 1800, 0.5, 45, 0.3, 190), t, 0.4 + 0.6 * t / 2.0, 0.2 if i % 2 else -0.2)
            t += 0.09 - 0.055 * t / 2.0
            i += 1
        hp, y, prev = [], 0.0, 0.0
        for v in noise(dur - 2.0):
            y = 0.9 * (y + v - prev)
            prev = v
            hp.append(y)
        add(env(hp, lambda t: 0.8 * math.exp(-3.5 * t)), 2.0)
    elif sid == 'applause':
        t = 0.0
        while t < dur - 0.05:
            u = t / dur
            add(hit(0.05, rnd.uniform(900, 2500), 0.6, 70), t, rnd.uniform(0.3, 1.0) * math.sin(math.pi * u) ** 0.6, rnd.uniform(-0.8, 0.8))
            t += rnd.expovariate(60 * max(0.15, math.sin(math.pi * u) ** 0.6))
        add(env(_bp(noise(dur), 1400, 1400, 1.2), lambda t: 0.12 * math.sin(math.pi * t / dur) ** 0.8))  # the crowd's wash
    elif sid == 'ticktock':
        for i, at in enumerate((0.0, 0.5, 1.0, 1.5)):
            add(hit(0.08, 2600 if i % 2 == 0 else 1900, 0.4, 250, 0.3, 2600 if i % 2 == 0 else 1900), at)
    return L, R


def sfx_file(sid):
    """The sound as a WAV in Movies/Cutroom/sfx, made on first use."""
    import wave
    if sid not in SFX:
        raise ValueError('no such sound')
    f = HOME / 'sfx' / f'{sid}.wav'
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        L, R = sfx_render(sid)
        g = 0.89 / max(1e-9, max(map(abs, L)), max(map(abs, R)))  # peak at -1 dBFS
        pcm = array('h', (int(max(-1.0, min(1.0, v * g)) * 32767) for pair in zip(L, R) for v in pair))
        tmp = f.with_suffix('.part')
        with wave.open(str(tmp), 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        tmp.replace(f)
    return f


def sfx_media(sid):
    """The sound in the media library (imported once, then reused)."""
    for j in MEDIA.glob('*.json'):
        m = json.loads(j.read_text())
        if m.get('sfx') == sid and (MEDIA / m['file']).exists():
            return m
    f = sfx_file(sid)
    with open(f, 'rb') as fh:
        m = import_file(f'{SFX[sid][0]}.wav', fh, f.stat().st_size)
    m['sfx'] = sid
    save_meta(m)
    return m


# ---------- sound and music library: CC0 packs downloaded once (packs.json pins each source, licence and SHA-256) ----------
PACKS_SRC = Path(__file__).resolve().parent / 'packs.json'
CC0_URL = 'creativecommons.org/publicdomain/zero/1.0'
PACKS_LOCK = threading.Lock()  # one download at a time (a second click waits, then finds it installed)


def packs_index():
    f = HOME / 'packs' / 'index.json'
    return json.loads(f.read_text()) if f.exists() else None


def pack_name(stem):
    """'impactWood_medium_003' -> 'Impact wood medium 3'."""
    words = re.sub(r'([a-z])([A-Z0-9])', r'\1 \2', stem).replace('_', ' ').replace('-', ' ').split()
    words = [str(int(w)) if w.isdigit() else w.lower() for w in words]
    return ' '.join(words)[:1].upper() + ' '.join(words)[1:]


def install_packs(st):
    """Download the packs.json sources into <library>/packs (sound effects as 48 kHz WAV, music as the MP3 it came as) and
    write packs/index.json: one row per file with its source URL and licence. A source whose hash or licence no longer
    matches is left out (and named in 'skipped'), the rest still install. Already installed: the index as it is."""
    with PACKS_LOCK:
        if (idx := packs_index()) and idx.get('items'):
            return {'items': len(idx['items']), 'skipped': idx.get('skipped', [])}
        return install_packs_(st)


def install_packs_(st):
    import hashlib, http.cookiejar, io, wave
    from urllib.parse import quote
    src, d = json.loads(PACKS_SRC.read_text()), HOME / 'packs'
    d.mkdir(parents=True, exist_ok=True)
    jar = http.cookiejar.CookieJar()
    web = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    web.addheaders = [('User-Agent', 'Mozilla/5.0 (Macintosh) Cutroom')]
    get = lambda url, ref=None: web.open(urllib.request.Request(url, headers={'Referer': ref} if ref else {}), timeout=120).read()
    items, skipped, todo = [], [], len(src['sfx']) + len(src['music'])
    for k, p in enumerate(src['sfx']):
        st['progress'] = k / todo
        page = f"https://kenney.nl/assets/{p['pack']}"
        try:  # Kenney hands out a signed link per visit: the asset page first (its cookie), then the link, then the zip
            get(page)
            link = json.loads(get(f"https://kenney.nl/download-link/{('assets/' + p['pack']).encode().hex()}", page))['url']
            data = get(link, page)
        except (OSError, ValueError, KeyError) as e:
            skipped.append(f"{p['title']}: download failed ({e})")
            continue
        if hashlib.sha256(data).hexdigest() != p['sha256']:
            skipped.append(f"{p['title']}: the zip changed upstream (SHA-256 differs from packs.json)")
            continue
        z = zipfile.ZipFile(io.BytesIO(data))
        lic = next((n for n in z.namelist() if n.lower().endswith('license.txt')), None)
        if not lic or CC0_URL not in z.read(lic).decode(errors='replace'):
            skipped.append(f"{p['title']}: no CC0 licence in the zip")
            continue
        out = d / 'sfx' / p['pack']
        out.mkdir(parents=True, exist_ok=True)
        (out / 'License.txt').write_bytes(z.read(lic))
        for n in sorted(z.namelist()):
            if not n.lower().endswith(('.ogg', '.wav')) or not n.startswith('Audio/'):  # Preview.ogg: the pack's demo reel
                continue
            stem = Path(n).stem
            f = out / f'{re.sub(r"[^A-Za-z0-9_-]", "_", stem)}.wav'
            r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'pipe:0', '-ar', '48000', '-c:a', 'pcm_s16le', str(f)], input=z.read(n), capture_output=True)
            if r.returncode:
                continue
            with wave.open(str(f)) as w:
                dur = w.getnframes() / w.getframerate()
            sub = Path(n).parent.name if Path(n).parent.name != 'Audio' else ''  # music-jingles: '8-Bit jingles/jingles_NES00.ogg' -> '8-Bit jingle 1'
            num = int(re.sub(r'\D', '', stem) or 0) + 1
            cat = next(c for pre, c in p['cats'] if stem.lower().startswith(pre))
            items.append({'id': f"{p['pack']}/{f.stem}", 'name': f'{sub[:-1]} {num}' if sub else pack_name(stem), 'cat': cat,
                          'kind': 'sfx', 'dur': round(dur, 3), 'file': f'sfx/{p["pack"]}/{f.name}', 'author': 'Kenney (kenney.nl)',
                          'licence': 'CC0 1.0', 'src': f'{page} ({p["title"]}: {n})', 'sha256': p['sha256']})
    meta_cache = {}
    for k, t in enumerate(src['music']):
        st['progress'] = (len(src['sfx']) + k) / todo
        try:
            md = meta_cache.get(t['item']) or meta_cache.setdefault(t['item'], json.loads(get(f"https://archive.org/metadata/{t['item']}")))
            if CC0_URL not in str(md.get('metadata', {}).get('licenseurl', '')):
                skipped.append(f"{t['title']}: archive.org no longer lists it as CC0")
                continue
            url = f"https://archive.org/download/{t['item']}/{quote(t['file'])}"
            data = get(url)
        except (OSError, ValueError) as e:
            skipped.append(f"{t['title']}: download failed ({e})")
            continue
        if hashlib.sha256(data).hexdigest() != t['sha256']:
            skipped.append(f"{t['title']}: the file changed upstream (SHA-256 differs from packs.json)")
            continue
        f = d / 'music' / f"{re.sub(r'[^A-Za-z0-9]+', '-', t['artist'] + ' ' + t['title']).strip('-').lower()}.mp3"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        dur = float(sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(f)]).stdout.strip() or 0)
        items.append({'id': f'music/{f.stem}', 'name': t['title'], 'artist': t['artist'], 'cat': t['mood'], 'kind': 'music', 'dur': round(dur, 2),
                      'file': f'music/{f.name}', 'licence': 'CC0 1.0', 'src': url, 'sha256': t['sha256']})
    if not items:
        raise RuntimeError('nothing could be downloaded: ' + '; '.join(skipped)[:400])
    tmp = d / 'index.tmp'
    tmp.write_text(json.dumps({'items': items, 'skipped': skipped, 'installed': time.time()}))
    tmp.replace(d / 'index.json')
    return {'items': len(items), 'skipped': skipped}


def pack_media(pid):
    """A pack sound or track in the media library (imported once, then reused), its source and licence in its metadata."""
    it = next((x for x in (packs_index() or {}).get('items', []) if x['id'] == pid), None)
    if not it:
        raise ValueError('no such sound in the library packs')
    for j in MEDIA.glob('*.json'):
        m = json.loads(j.read_text())
        if m.get('pack') == pid and (MEDIA / m['file']).exists():
            return m
    f = HOME / 'packs' / it['file']
    with open(f, 'rb') as fh:
        m = import_file(f"{it['name']}{f.suffix}", fh, f.stat().st_size)
    m.update(pack=pid, licence=it['licence'], src=it['src'])
    save_meta(m)
    return m


def ai_status():
    """Which on-device generators are installed (weights already on disk: a status call never starts a download)."""
    venv = (AI_BIN / 'python').exists()
    manifests = Path.home() / '.ollama' / 'models' / 'manifests'
    return {'voice': venv and (HUB / f"models--{KOKORO.replace('/', '--')}" / 'snapshots').exists(),
            'image': venv and (HOME / 'ai' / 'z-image-turbo-4bit' / 'mflux_model.json').exists(),
            'llm': Path(OLLAMA).exists() and manifests.is_dir() and any(f.is_file() for f in manifests.rglob('*')),
            'music': venv and (HUB / 'models--facebook--musicgen-small' / 'snapshots').exists()}


def ai_music(st, prompt, dur=20, seed=None):
    """Music from a description, on this Mac (MusicGen small; weights CC-BY-NC, personal use) -> a library item."""
    prompt = ' '.join(str(prompt).split())[:300]
    if not prompt:
        raise ValueError('describe the music')
    job = {'prompt': prompt, 'dur': fnum(dur, 4, 60), 'seed': None if seed is None else int(fnum(seed, 0, 2 ** 31))}
    with AI_LOCK, tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        out, jf = Path(td) / 'music.wav', Path(td) / 'job.json'
        jf.write_text(json.dumps({**job, 'out': str(out)}))
        proc = subprocess.Popen([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'music.py'), str(jf)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors='replace', env={**AI_ENV, 'HF_HUB_OFFLINE': '1'})  # one pipe, as with removal; never a download mid-job
        said = []
        for line in proc.stdout:
            if line.startswith('progress '):
                st['progress'] = 0.95 * float(line.split()[1])
            elif line.strip():
                said = (said + [line.strip()])[-5:]
        if proc.wait() or not out.exists():
            raise RuntimeError('music generation failed: ' + (said[-1][-300:] if said else 'no output'))
        with open(out, 'rb') as fh:
            m = import_file(f'AI music - {prompt[:40]}.wav', fh, out.stat().st_size, background=False)
    return {'media': m['id']}


def ai_voices():
    return sorted({f.stem for f in (HUB / f"models--{KOKORO.replace('/', '--')}" / 'snapshots').glob('*/voices/*.safetensors')})


def ai_voice(st, text, voice='af_heart', speed=1.0):
    """Natural speech on this Mac (Kokoro-82M on MLX) -> a library item. The voice prefix picks the language (a = US English, b = UK...)."""
    text = ' '.join(str(text).split())[:5000]
    if not text:
        raise ValueError('nothing to say')
    voice = voice if re.fullmatch(r'[a-z]{2}_[a-z]+', str(voice)) else 'af_heart'
    with AI_LOCK, tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        f = Path(td) / 'v.wav'  # Kokoro stays loaded in the AI worker between voiceovers
        try:
            ai_worker('voice', timeout=600, text=text, voice=voice, speed=round(fnum(speed, 0.5, 2), 2), out=str(f))
        except RuntimeError as e:
            raise RuntimeError(f'voice generation failed: {e}') from None
        st['progress'] = 0.9
        with open(f, 'rb') as fh:
            m = import_file(f'AI voice - {text[:40]}.wav', fh, f.stat().st_size, background=False)
    return {'media': m['id']}


# ---------- AI video: image to video on the RTX 4090 PC (ComfyUI + Wan 2.2 14B, Lightning 4 steps), through an SSH tunnel ----------
GPU_HOST = os.environ.get('CUTROOM_GPU_HOST', 'win4090')  # ~/.ssh/config alias; ComfyUI listens on that PC's 127.0.0.1:8188 only
COMFY = {'proc': None, 'port': int(os.environ.get('CUTROOM_COMFY_PORT', '18188')), 'log': [], 'lock': threading.Lock()}
COMFY_DIR = r'B:\AI\ComfyUI_windows_portable'
VIDEO_NEG = ('blurry, low quality, distorted, deformed, warped face, melting, extra limbs, extra fingers, flicker, jitter, morphing, '
             'watermark, text, subtitles, static frame')


def comfy(path, body=None, timeout=60, raw=False):
    url = f"http://127.0.0.1:{COMFY['port']}{path}"
    req = urllib.request.Request(url, data=body if isinstance(body, bytes) or body is None else json.dumps(body).encode(),
                                 headers={} if isinstance(body, bytes) or body is None else {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read() if raw else json.loads(r.read() or b'{}')


def comfy_up(st):
    """ComfyUI reachable through the tunnel: started on the PC (foreground in this ssh session) if it isn't running.
    The tunnel and that ComfyUI end with Cutroom's server, which frees the PC's GPU."""
    with COMFY['lock']:
        try:
            comfy('/system_stats', timeout=3)
            return
        except OSError:
            pass
        p = COMFY['proc']
        if not p or p.poll() is not None:
            launch = f'cd /d {COMFY_DIR} && python_embeded\\python.exe -s ComfyUI\\main.py --port 8188 --disable-auto-launch'
            p = COMFY['proc'] = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes',
                                                  '-L', f"{COMFY['port']}:127.0.0.1:8188", GPU_HOST, f'cmd /c "{launch}"'],
                                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
            COMFY['log'] = []
            threading.Thread(target=lambda: [COMFY['log'].append(x) for x in p.stdout], daemon=True).start()  # drained, or the pipe fills and ComfyUI stalls
        for i in range(240):  # first start: ComfyUI loads its nodes (~1 min)
            st['progress'] = min(0.1, i / 2400)
            try:
                comfy('/system_stats', timeout=3)
                return
            except OSError:
                if p.poll() is not None:
                    raise RuntimeError(f'the GPU PC ({GPU_HOST}) did not start ComfyUI: ' + ''.join(COMFY['log'][-6:]).strip()[-300:])
                time.sleep(1)
        raise RuntimeError('ComfyUI on the GPU PC did not answer in 4 minutes')


def comfy_down():
    """Stop the ComfyUI this server started on the PC (its unique --disable-auto-launch flag: never another ComfyUI or
    the PC's other Python services) and the tunnel: the GPU's memory is free again. Closing ssh alone leaves it running."""
    p, COMFY['proc'] = COMFY['proc'], None
    if not p:
        return
    ps = ("$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and "
          "$_.CommandLine -like '*main.py --port 8188 --disable-auto-launch*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }")
    try:
        subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', GPU_HOST, 'powershell -NoProfile -EncodedCommand ' + base64.b64encode(ps.encode('utf-16-le')).decode()],
                       capture_output=True, timeout=40)
    except (OSError, subprocess.TimeoutExpired):
        pass
    if p.poll() is None:
        p.terminate()


def comfy_idle():  # 10 minutes after the last AI video, the PC gets its GPU back
    t = COMFY.get('idle')
    if t:
        t.cancel()
    COMFY['idle'] = threading.Timer(600, comfy_down)
    COMFY['idle'].daemon = True
    COMFY['idle'].start()


def ai_video(st, image, prompt, ratio='9:16', quality='fast', seed=None):
    try:
        return ai_video_(st, image, prompt, ratio, quality, seed)
    finally:
        comfy_idle()


def ai_video_(st, image, prompt, ratio='9:16', quality='fast', seed=None):
    """Image to video on the 4090 PC: Wan 2.2 14B fp8 + the Lightning LoRA (4 steps), 81 frames at 16 fps (~5 s), 720p
    (best: x2 RealESRGAN). The picture is a library image, or a video's frame (pass its still). -> a library item."""
    m = meta(image)
    if m['kind'] != 'image':
        raise ValueError('start from a picture (a photo, a generated image, or a video frame made with Freeze frame)')
    prompt = ' '.join(str(prompt).split())[:1500] or 'gentle natural motion, cinematic'
    w, h = (720, 1280) if ratio == '9:16' else (1280, 720) if ratio == '16:9' else (960, 960)
    seed = int(fnum(seed, 0, 2 ** 31)) if seed is not None else int(time.time() * 1000) % 2 ** 31
    comfy_up(st)
    name = f'cutroom_{uuid.uuid4().hex[:8]}'
    boundary = uuid.uuid4().hex
    data = (MEDIA / m['file']).read_bytes()
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}{Path(m["file"]).suffix}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + data + \
        f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(f"http://127.0.0.1:{COMFY['port']}/upload/image", data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=120) as r:
        up = json.loads(r.read())
    wf = {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', 'weight_dtype': 'default'}},
        '2': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': 'wan22_lightning\\high_noise.safetensors', 'strength_model': 1.0}},
        '3': {'class_type': 'ModelSamplingSD3', 'inputs': {'model': ['2', 0], 'shift': 5.0}},
        '4': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', 'weight_dtype': 'default'}},
        '5': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['4', 0], 'lora_name': 'wan22_lightning\\low_noise.safetensors', 'strength_model': 1.0}},
        '6': {'class_type': 'ModelSamplingSD3', 'inputs': {'model': ['5', 0], 'shift': 5.0}},
        '7': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'type': 'wan'}},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['7', 0]}},
        '9': {'class_type': 'CLIPTextEncode', 'inputs': {'text': VIDEO_NEG, 'clip': ['7', 0]}},
        '10': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'wan_2.1_vae.safetensors'}},
        '11': {'class_type': 'LoadImage', 'inputs': {'image': up.get('name', name)}},
        '12': {'class_type': 'WanImageToVideo', 'inputs': {'positive': ['8', 0], 'negative': ['9', 0], 'vae': ['10', 0], 'width': w, 'height': h, 'length': 81, 'batch_size': 1, 'start_image': ['11', 0]}},
        '13': {'class_type': 'KSamplerAdvanced', 'inputs': {'model': ['3', 0], 'add_noise': 'enable', 'noise_seed': seed, 'steps': 4, 'cfg': 1.0, 'sampler_name': 'euler', 'scheduler': 'simple',
                                                             'positive': ['12', 0], 'negative': ['12', 1], 'latent_image': ['12', 2], 'start_at_step': 0, 'end_at_step': 2, 'return_with_leftover_noise': 'enable'}},
        '14': {'class_type': 'KSamplerAdvanced', 'inputs': {'model': ['6', 0], 'add_noise': 'disable', 'noise_seed': seed, 'steps': 4, 'cfg': 1.0, 'sampler_name': 'euler', 'scheduler': 'simple',
                                                             'positive': ['12', 0], 'negative': ['12', 1], 'latent_image': ['13', 0], 'start_at_step': 2, 'end_at_step': 4, 'return_with_leftover_noise': 'disable'}},
        '15': {'class_type': 'VAEDecode', 'inputs': {'samples': ['14', 0], 'vae': ['10', 0]}},
    }
    last = ['15', 0]
    if quality == 'best':
        wf['16'] = {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': 'RealESRGAN_x2plus.pth'}}
        wf['17'] = {'class_type': 'ImageUpscaleWithModel', 'inputs': {'upscale_model': ['16', 0], 'image': ['15', 0]}}
        last = ['17', 0]
    wf['18'] = {'class_type': 'VHS_VideoCombine', 'inputs': {'images': last, 'frame_rate': 16, 'loop_count': 0, 'filename_prefix': name, 'format': 'video/h264-mp4', 'pingpong': False, 'save_output': True}}
    pid = comfy('/prompt', {'prompt': wf, 'client_id': 'cutroom'})['prompt_id']
    t0 = time.time()
    while time.time() - t0 < 1800:
        h_ = comfy(f'/history/{pid}')
        if pid in h_:
            outs = [g for o in h_[pid].get('outputs', {}).values() for g in o.get('gifs', []) + o.get('videos', [])]
            if not outs:
                err = h_[pid].get('status', {}).get('messages', [])
                raise RuntimeError('the GPU PC made no video: ' + json.dumps(err)[-300:])
            o = outs[0]
            vid = comfy(f"/view?filename={urllib.parse.quote(o['filename'])}&subfolder={urllib.parse.quote(o.get('subfolder', ''))}&type={o.get('type', 'output')}", raw=True, timeout=300)
            with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
                f = Path(td) / 'v.mp4'
                f.write_bytes(vid)
                with open(f, 'rb') as fh:
                    cut = import_file(f"AI video - {prompt[:40]}.mp4", fh, f.stat().st_size, background=False)
            return {'media': cut['id'], 'seed': seed}
        st['progress'] = 0.1 + 0.85 * min(1, (time.time() - t0) / (240 if quality == 'best' else 150))
        time.sleep(3)
    raise RuntimeError('the GPU PC took over 30 minutes')


def ai_image(st, prompt, w=1024, h=1024, seed=None, steps=8, sticker=False):
    """Text to image on this Mac (Z-Image-Turbo, 4-bit, MLX) -> a library item. sticker: the subject is cut out (Vision)."""
    prompt = ' '.join(str(prompt).split())[:2000]
    if not prompt:
        raise ValueError('describe the image')
    model = HOME / 'ai' / 'z-image-turbo-4bit'
    if not (model / 'mflux_model.json').exists():
        raise RuntimeError('the on-device image model is not installed (README: On-device AI)')
    if RAM_GB < 12:  # the 4-bit model alone is 5.5 GB: on 8 GB it swaps for minutes and stalls the whole Mac
        raise RuntimeError(f'making images needs a Mac with 16 GB of memory (this one has {RAM_GB:.0f} GB)')
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
            raise RuntimeError(plain('Lifting the subject', r.stderr, r.returncode))
        with open(out, 'rb') as fh:
            c = import_file(f"{Path(m['name']).stem} (cutout).png", fh, out.stat().st_size, background=False)
    return {'media': c['id']}


OLLAMA = shutil.which('ollama') or '/opt/homebrew/bin/ollama'
LLM_URL = 'http://127.0.0.1:11434'
LLM_LOCK = threading.Lock()


def ollama_up():
    """The local language model server (Ollama): reuse a running one, else start it for as long as Cutroom runs."""
    def alive():
        try:
            urllib.request.urlopen(LLM_URL + '/api/tags', timeout=1).read()
            return True
        except OSError:
            return False
    if alive():
        return True
    if not Path(OLLAMA).exists():
        return False
    subprocess.Popen([OLLAMA, 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, 'OLLAMA_HOST': '127.0.0.1:11434'})
    for _ in range(60):
        time.sleep(0.25)
        if alive():
            return True
    return False


LLM_MAX_B = 4 if RAM_GB < 16 else 9 if RAM_GB < 48 else 99  # billions of parameters that fit beside the editor: 9B takes 6.6 GB
LLM_HINT = 'ollama pull qwen3.5:4b' if RAM_GB < 16 else 'ollama pull qwen3.5:9b'


def llm_model():
    names = [m['name'] for m in json.loads(urllib.request.urlopen(LLM_URL + '/api/tags', timeout=3).read()).get('models', [])]
    want = os.environ.get('CUTROOM_LLM')
    size = lambda n: float(b[1]) if (b := re.search(r':(\d+(?:\.\d+)?)b', n)) else 0
    fit = sorted((n for n in names if size(n) <= LLM_MAX_B), key=size, reverse=True)  # the biggest that fits this Mac's memory
    pick = [n for n in names if n == want] or [n for n in fit if n.startswith('qwen3.5')] or [n for n in fit if n.startswith('qwen')] or fit
    return pick[0] if pick else None


def llm(system, user, ctx=8192, images=None):
    """One JSON answer from the local model (Ollama on this Mac; thinking off: answers in seconds, not minutes).
    images: base64 JPEGs for a vision model (qwen3.5 sees)."""
    if not ollama_up():
        raise RuntimeError(f'the local language model is not available (install Ollama, then {LLM_HINT})')
    model = llm_model()
    if not model:
        raise RuntimeError(f'Ollama has no model that fits this Mac\'s {RAM_GB:.0f} GB of memory: {LLM_HINT}')
    body = {'model': model, 'stream': False, 'format': 'json', 'options': {'temperature': 0.2, 'num_ctx': int(ctx)},
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user, **({'images': images} if images else {})}]}
    if 'qwen3' in model:
        body['think'] = False
    if RAM_GB < 16:  # unload right after: Ollama keeps a model in memory for 5 minutes, and the next AI step needs that memory
        body['keep_alive'] = 0
    with LLM_LOCK:
        r = json.loads(urllib.request.urlopen(urllib.request.Request(LLM_URL + '/api/chat', data=json.dumps(body).encode(),
                                                                    headers={'Content-Type': 'application/json'}), timeout=900).read())
    try:
        return json.loads(r['message']['content'])
    except (KeyError, ValueError):
        raise RuntimeError('the local model did not answer in JSON')


def sentences(words, gap=0.6):
    """Timed words -> sentences (punctuation or a pause ends one)."""
    out, cur = [], []
    for w in words:
        if cur and (w['s'] - cur[-1]['e'] > gap or re.search(r'[.?!]$', cur[-1]['w'])):
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return [{'s': round(c[0]['s'], 2), 'e': round(c[-1]['e'], 2), 'text': ' '.join(x['w'] for x in c)} for c in out]


def shots(st, mid, span=(0.0, 1.0)):
    """What is in a video, for smart combine (cached): its scenes (long takes in parts of up to 10 s), how every moment
    looks (sharpness, exposure, colour, motion; 4 samples a second, from ffmpeg) and, with the local vision model,
    what the best frame of each part shows."""
    m = meta(mid)
    if m['kind'] != 'video':
        raise ValueError(f"{m['name']} is not a video")
    cache = CACHE / f'{mid}.shots.json'
    if cache.exists() and ((res := json.loads(cache.read_text()))['vision'] or not ai_status()['llm']):
        return res  # analysed without the model while it was unavailable: describe now
    src, dur = str(MEDIA / m['file']), m['duration']
    if heavy(m) and (px := CACHE / f'{mid}.proxy.mp4').exists():  # 4K60: the same looks from the 720p proxy, 11x faster
        src = str(px)
    dec, vf = hdr_decode(m) if src == str(MEDIA / m['file']) else ([], '')  # an HDR proxy is already tone mapped and upright
    r = sh(['ffmpeg', '-v', 'error', *dec, '-i', src, '-an', '-vf',
            f'{vf}fps=4,scale=320:-2,blurdetect=block_width=32:block_height=32,signalstats,metadata=print:file=-', '-f', 'null', '-'])
    fr = []
    for block in r.stdout.split('frame:')[1:]:
        kv, pt = dict(re.findall(r'lavfi\.([\w.]+)=([-\d.e]+)', block)), re.search(r'pts_time:([\d.]+)', block)
        if pt:
            blur, y = float(kv.get('blur', 8)), float(kv.get('signalstats.YAVG', 128))
            q = max(0.0, min(1.0, (9.5 - blur) / 3)) * (1 - min(1.0, abs(y - 120) / 140))  # sharp and well exposed
            fr.append({'t': round(float(pt.group(1)), 3), 'q': round(q, 3), 'y': round(y, 1), 'm': round(float(kv.get('signalstats.YDIF', 0)), 2),
                       'sat': round(float(kv.get('signalstats.SATAVG', 0)), 1)})
    if not fr:
        raise RuntimeError(f"could not read {m['name']}")
    cuts = [0.0, *[c for c in scenes(mid) if 0.3 < c < dur - 0.3], dur]
    parts = []
    for a, b in zip(cuts, cuts[1:]):
        k = max(1, math.ceil((b - a) / 10))
        parts += [(a + (b - a) * i / k, a + (b - a) * (i + 1) / k, len(parts) + i) for i in range(k)]
    out, vision = [], True
    for n, (a, b, _) in enumerate(parts):
        inside = [f for f in fr if a <= f['t'] < b] or [min(fr, key=lambda f: abs(f['t'] - a))]
        best = max(inside, key=lambda f: f['q'])
        sc = {'a': round(a, 3), 'b': round(b, 3), 'kt': best['t'], 'take': next(i for i, c in enumerate(cuts) if c > a) - 1}
        if vision:
            try:
                jpg = subprocess.run(['ffmpeg', '-v', 'error', *dec, '-ss', f"{best['t']:.3f}", '-i', src, '-frames:v', '1', '-vf', f'{vf}scale=384:-2',
                                      '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], capture_output=True).stdout
                d = llm('You describe video shots for an editor. Reply with JSON only.',
                        'Describe this video frame. Return {"desc": "max 10 words", "place": "1-3 words", "shot": "wide|medium|close", '
                        '"subject": "1-3 words", "energy": "calm|lively|intense", "quality": 1-5}', ctx=4096, images=[base64.b64encode(jpg).decode()])
                sc.update({k: str(d.get(k, ''))[:80] for k in ('desc', 'place', 'shot', 'subject', 'energy')}, look=int(fnum(d.get('quality', 3), 1, 5)))
            except (RuntimeError, OSError, ValueError, AttributeError):
                vision = False  # no vision model: order as shot, transitions from the picture statistics only
        out.append(sc)
        st['progress'] = span[0] + (span[1] - span[0]) * (n + 1) / len(parts)
    res = {'frames': fr, 'scenes': out, 'vision': vision}
    cache.write_text(json.dumps(res))
    return res


COMBINE_STYLES = {  # shot length range (s), transition for a change of place, its length
    'balanced': (2.0, 3.5, 'fade', 0.4), 'energetic': (1.0, 2.0, 'slideleft', 0.25), 'calm': (3.0, 5.0, 'fade', 0.8), 'cinematic': (3.0, 5.5, 'fadeblack', 0.7)}


def combine(st, mids, target=0, style='balanced', order='auto', music=None, sound=False):
    """Smart combine (CapCut's AutoCut), on this Mac: the best-looking moment of every scene across the clips, in an
    order (as shot, or a story the local model picks from what each shot shows), fitted to the length, with transitions
    picked from what changes between shots: a hard cut inside one take, a dip on a big brightness jump, the style's
    transition between places. Returns the edit; the editor builds the project (and beat-syncs it to the music)."""
    style = style if style in COMBINE_STYLES else 'balanced'
    lo, hi, change_tr, trd = COMBINE_STYLES[style]
    mids = list(dict.fromkeys(str(x) for x in mids))[:40]
    if not mids:
        raise ValueError('pick some videos')
    target = fnum(target, 0, 3600)
    info = [(mid, shots(st, mid, (0.75 * i / len(mids), 0.75 * (i + 1) / len(mids)))) for i, mid in enumerate(mids)]
    cands = []
    for mi, (mid, sh_) in enumerate(info):
        fr = sh_['frames']
        take_end = {}
        for sc in sh_['scenes']:
            take_end[sc['take']] = max(take_end.get(sc['take'], 0), sc['b'])
        for sc in sh_['scenes']:
            a, b = sc['a'] + 0.15, sc['b'] - 0.15  # stay clear of the cuts
            if b - a < min(lo, 1.0):
                continue
            L = min(b - a, max(lo, min(hi, 0.6 * (b - a))))
            pts = [f for f in fr if a <= f['t'] <= b]
            score = lambda s0: statistics.fmean([f['q'] for f in pts if s0 <= f['t'] <= s0 + L] or [0])
            s0 = max([f['t'] for f in pts if f['t'] + L <= b + 1e-6] or [a], key=score)
            win = [f for f in pts if s0 <= f['t'] <= s0 + L] or pts[:1] or fr[:1]
            mot = statistics.fmean(f['m'] for f in win)
            q = score(s0) * (0.6 + 0.08 * sc.get('look', 3)) * ((1 + min(mot, 20) / 40) if style == 'energetic' else (1 - min(mot, 30) / 90))
            cands.append({'media': mid, 'in': round(s0, 3), 'out': round(s0 + L, 3), 'base': a, 'lim': take_end[sc['take']] - 0.15, 'q': round(q, 3),
                          'y0': win[0]['y'], 'y1': win[-1]['y'],
                          'take': (mi, sc['take']), 'mi': mi, **{k: sc[k] for k in ('desc', 'place', 'shot', 'subject', 'energy') if k in sc}})
    if not cands:
        raise RuntimeError('no usable shots (the clips are too short, too dark or too blurry)')
    title = ''
    vision = all(s['vision'] for _, s in info)
    if order == 'story' or (order == 'auto' and vision and len(mids) > 1):
        if vision:
            lines = '\n'.join(f"{k + 1}: {c.get('desc', '')} | {c.get('place', '')} | {c.get('shot', '')} shot | {c.get('energy', '')}" for k, c in enumerate(cands))
            try:
                ans = llm('You are a video editor. Reply with JSON only.',
                          'Put these shots in the best order for one short edit: open with a striking or establishing shot, keep shots of the same '
                          'place together, build up, and end on a strong closing shot. Use every number once. '
                          'Return {"order": [numbers], "title": "a title, max 5 words"}.\n' + lines, ctx=8192)
                seq = [int(x) - 1 for x in ans.get('order', []) if str(x).isdigit() and 0 < int(x) <= len(cands)]
                seq = list(dict.fromkeys(seq)) + [k for k in range(len(cands)) if k not in seq]
                cands, title = [cands[k] for k in seq], str(ans.get('title') or '').strip()[:60]
            except RuntimeError:
                pass
    else:
        cands.sort(key=lambda c: (c['mi'], c['in']))
    st['progress'] = 0.85
    tot = lambda cs: sum(c['out'] - c['in'] for c in cs) - trd * 0.5 * max(0, len(cs) - 1)
    if target:
        while tot(cands) > target and len(cands) > 2:  # drop the weakest shots until it fits
            cands.remove(min(cands, key=lambda c: c['q']))
        if tot(cands) < target * 0.9:  # stretch toward the target, never past the scene's own end
            f = min(1.6, target / max(tot(cands), 0.1))
            for c in cands:
                c['out'] = round(min(c['lim'], c['in'] + (c['out'] - c['in']) * f), 3)
    if sound:  # their sound stays in: never start or end a shot in the middle of a spoken word (on-device transcript)
        words = {}
        for mid in {c['media'] for c in cands}:
            try:
                words[mid] = [(w['s'], w['e'], w['w']) for w in transcribe(mid, 'auto', [[c['in'], c['out']] for c in cands if c['media'] == mid])] if meta(mid).get('hasAudio') else []
            except (RuntimeError, OSError, ValueError):
                words[mid] = []
        def between(ws, t, lo, hi):  # t moved to the nearer edge of the word it falls in (padding at most half the gap, so
            for i, (w0, w1, _) in enumerate(ws):  # back-to-back words are cut exactly between them), kept inside [lo, hi]
                if w0 < t < w1:
                    before = w0 - min(0.08, max(0.0, w0 - (ws[i - 1][1] if i else w0 - 1)) / 2)
                    after = w1 + min(0.12, max(0.0, (ws[i + 1][0] if i + 1 < len(ws) else w1 + 1) - w1) / 2)
                    ok = [x for x in (before, after) if lo <= x <= hi]
                    return min(ok, key=lambda x: abs(x - t)) if ok else t
            return t
        def sentence(ws, t, lo, hi, ends):  # the nearest sentence start / end in [lo, hi] (punctuation from the transcript)
            pts = [w0 - 0.05 for i, (w0, _, _) in enumerate(ws) if i == 0 or re.search(r'[.?!]$', ws[i - 1][2])] if not ends else \
                  [w1 + 0.12 for w0, w1, tx in ws if re.search(r'[.?!]$', tx)]
            pts = [x for x in pts if lo <= x <= hi]
            return min(pts, key=lambda x: abs(x - t)) if pts else None
        for c in cands:
            ws = sorted(words.get(c['media']) or [])
            if ws:  # whole sentences when one is close, else at least whole words
                a0 = sentence(ws, c['in'], max(c['base'], c['in'] - 1.0), c['in'] + 1.0, False)
                c['in'] = round(a0 if a0 is not None else between(ws, c['in'], c['base'], c['out'] - 1.0), 3)
                b0 = sentence(ws, c['out'], max(c['in'] + 1.0, c['out'] - 1.0), min(c['lim'], c['out'] + 1.5), True)
                c['out'] = round(b0 if b0 is not None else between(ws, c['out'], c['in'] + 1.0, min(c['lim'], c['out'] + 0.8)), 3)
            c['speech'] = bool(ws) and any(w0 < c['out'] and w1 > c['in'] for w0, w1, _ in ws)
    for k, c in enumerate(cands):  # transitions from what changes
        n = cands[k + 1] if k + 1 < len(cands) else None
        if not n:
            continue
        same_take, same_place = c['take'] == n['take'], bool(c.get('place')) and c.get('place', '').lower() == n.get('place', '').lower()
        if same_take and n['in'] >= c['out'] - 0.05:
            continue  # the same take moving on: hard cut
        if abs(c['y1'] - n['y0']) > 70:
            c['tr'] = {'type': 'fadewhite' if n['y0'] > c['y1'] else 'fadeblack', 'd': max(trd, 0.5)}
        elif style == 'energetic':
            if not same_place:
                c['tr'] = {'type': ('slideleft', 'zoomin', 'slideup', 'wiperight')[k % 4], 'd': trd}
        elif same_place:
            c['tr'] = {'type': 'fade', 'd': round(trd * 0.6, 2)}
        else:
            c['tr'] = {'type': change_tr, 'd': trd}
    every = 1
    if music:
        bp = beats(music)
        beat = 60 / max(40, bp.get('bpm') or 120)
        every = max(1, round(((lo + hi) / 2) / beat))  # cuts every N beats, near the style's shot length
    keep = ('media', 'in', 'out', 'lim', 'tr', 'desc', 'place', 'speech')
    return {'shots': [{k: c[k] for k in keep if k in c} for c in cands], 'title': title, 'every': every, 'vision': vision}


def hook_text(s):
    """A model-written title as a hook: small models often write two clauses ("Stop X: do Y") -> keep the first."""
    s = str(s or '').strip().strip('"\'').rstrip('.')
    head = re.split(r'\s*[:;|\u2013\u2014]\s*', s)[0]
    return (head if len(head.split()) >= 2 else s)[:80]


def highlights(st, mid, lang='auto', count=3, lo=15.0, hi=45.0):
    """Long video -> the best self-contained moments for shorts (CapCut's long-video-to-shorts), all on this Mac:
    the transcript goes to the local language model; its picks are snapped to sentence edges and checked."""
    count, lo, hi = int(fnum(count, 1, 10)), fnum(lo, 3, 300), fnum(hi, 5, 600)
    sents = sentences(transcribe(mid, lang))
    if not sents:
        raise ValueError('no speech found in this video')
    st['progress'] = 0.3
    lines = '\n'.join(f"[{x['s']:.1f}-{x['e']:.1f}] {x['text']}" for x in sents)
    ans = llm('You are a short-form video editor. Reply with JSON only.',
              f'From this timestamped transcript (seconds), pick the {count} best self-contained moments for vertical shorts, {lo:g}-{hi:g} s each, '
              'starting and ending on sentence boundaries. Prefer moments that open with a strong line; skip greetings, filler and calls to subscribe; no overlaps. '
              'Return {"clips":[{"start":seconds,"end":seconds,"title":"punchy hook, 3-6 words, one phrase, same language as the transcript","reason":"max 12 words"}]}.\n\n' + lines,
              ctx=min(32768, 3000 + len(lines) // 3))
    n, dur, out = len(sents), meta(mid)['duration'], []
    for c in (ans.get('clips') or [])[:count * 2]:
        try:
            a, b = float(c['start']), float(c['end'])
        except (KeyError, TypeError, ValueError):
            continue
        i = min(range(n), key=lambda q: abs(sents[q]['s'] - a))  # the model's times, snapped to real sentence edges
        k = min(range(n), key=lambda q: abs(sents[q]['e'] - b))
        # a little air around the words, never into the neighbouring sentences (at most half the pause)
        a = max(0.0, sents[i]['s'] - 0.12, (sents[i - 1]['e'] + sents[i]['s']) / 2 if i else 0.0)
        b = min(dur, sents[k]['e'] + 0.3, (sents[k]['e'] + sents[k + 1]['s']) / 2 if k + 1 < n else dur)
        if not (min(lo, 5) * 0.6 <= b - a <= hi * 1.6) or any(a < o['end'] and b > o['start'] for o in out):
            continue
        out.append({'start': round(a, 3), 'end': round(b, 3), 'title': hook_text(c.get('title')), 'reason': str(c.get('reason') or '').strip()[:160]})
    if not out:
        raise RuntimeError('the model found no usable moments (try another length range)')
    return {'clips': sorted(out, key=lambda o: o['start'])[:count]}


def translate(st, texts, to):
    """Lines (whole sentences, not caption fragments) into another language with the local model. Numbered, so a line
    the model drops or merges is caught and asked again; one it still skips keeps its original text."""
    to = str(to).strip()
    if not re.fullmatch(r'[A-Za-z][A-Za-z ()-]{1,30}', to):
        raise ValueError('name the language, e.g. Spanish')
    texts = [str(t)[:500] for t in texts][:2000]
    out = [None] * len(texts)
    for i in range(0, len(texts), 30):
        for _ in range(3):
            todo = [j for j in range(i, min(i + 30, len(texts))) if out[j] is None]
            if not todo:
                break
            ans = llm('You translate video subtitles. Reply with JSON only.',
                      f'Translate each numbered line into {to}: natural, same meaning, about the same length, no notes. '
                      'Return {"1": "...", "2": "..."} with exactly the same numbers.\n' + json.dumps({str(k + 1): texts[j] for k, j in enumerate(todo)}, ensure_ascii=False))
            if isinstance(ans, dict) and len(ans) == 1 and isinstance(v := next(iter(ans.values())), (dict, list)):
                ans = v  # {"t": {...}} or {"translations": [...]}
            if isinstance(ans, list):
                ans = {str(k + 1): v for k, v in enumerate(ans)}
            for k, j in enumerate(todo):
                v = ans.get(str(k + 1)) if isinstance(ans, dict) else None
                if isinstance(v, str) and v.strip():
                    out[j] = v.strip()
        st['progress'] = min(1.0, (i + 30) / max(1, len(texts)))
    if texts and all(o is None for o in out):
        raise RuntimeError('the local model did not translate; try again')
    return {'texts': [o if o is not None else texts[j] for j, o in enumerate(out)], 'kept': sum(o is None for o in out)}


CAP_STOP = set(('a about all am an and are as at be been but by can could did do does for from get got had has have he her here his i im if in into is it '
                'its just me my no not of on or our out over she so some than that thats the their them then there they this to too up us very was we were what '
                'will with would you your').split())  # as cap_marks normalises words (no apostrophes)


def first_emoji(v):
    """The first emoji in a model's answer (with its variation selector, skin tone or ZWJ sequence), else ''."""
    import unicodedata
    out = ''
    for ch in str(v).strip():
        o = ord(ch)
        pict = unicodedata.category(ch) == 'So' and o > 0x2000
        if pict or (out and (o in (0x200D, 0xFE0F) or 0x1F3FB <= o <= 0x1F3FF or out[-1] == '‍')):
            out += ch
        elif out:
            break
    return out[:8]


def cap_marks(st, texts, kind='keywords'):
    """Caption sentences marked by the local model. texts: one per sentence, its captions as a list (or one string).
    'keywords' = a word to highlight in each caption, picked with the whole sentence in view, returned as indices into the
    sentence's words (in caption order: a caption's first index is its pick); 'emoji' = one emoji per sentence. Numbered, so a
    sentence the model drops is asked again; one it still skips stays unmarked."""
    emo = kind == 'emoji'
    sents = [[str(c)[:200] for c in (t if isinstance(t, list) else [t])][:40] for t in texts][:3000]
    out = [None] * len(sents)
    norm = lambda w: re.sub(r'[^\w]', '', w.lower())
    # keyed captions inside their sentence ("3b"): asked for bare per-caption lists the model picked words of the NEXT
    # caption; asked per sentence it marked too few. A pick landing in a neighbour caption is moved there by position.
    ask = ('For each numbered sentence from a video, pick ONE emoji that fits its meaning or mood. Return {"1": "🔥", "2": "😂"} with exactly the same numbers.\n'
           if emo else 'These are the captions of a video, sentence by sentence; each caption has its own key ("3b" = sentence 3, caption b). For EVERY caption key, '
           'pick the 1 word in that caption a viewer should notice most (a name, number, key noun, main verb or strong adjective), or [] when the caption '
           'is only small words like "back to the". Copy it exactly from that caption. Return {"1": {"1a": ["word"], "1b": []}, "2": {...}} with every key.\n')
    key = lambda k, c: f'{k + 1}{chr(97 + c % 26)}{c // 26 or ""}'
    for i in range(0, len(sents), 15):
        for _ in range(3):
            todo = [j for j in range(i, min(i + 15, len(sents))) if out[j] is None]
            if not todo:
                break
            q = {str(k + 1): ' '.join(sents[j]) if emo else {key(k, c): p for c, p in enumerate(sents[j])} for k, j in enumerate(todo)}
            ans = llm('You mark up video captions. Reply with JSON only.', ask + json.dumps(q, ensure_ascii=False))
            if isinstance(ans, dict) and len(ans) == 1 and isinstance(v := next(iter(ans.values())), (dict, list)) and str(len(todo)) not in ans:
                ans = v  # {"answers": {...}}
            if isinstance(ans, list):
                ans = {str(k + 1): v for k, v in enumerate(ans)}
            ans = ans if isinstance(ans, dict) else {}
            flat = {**ans, **{kk: vv for vv0 in ans.values() if isinstance(vv0, dict) for kk, vv in vv0.items()}}  # the caption keys, nested or not
            for k, j in enumerate(todo):
                v = ans.get(str(k + 1))
                if emo:
                    if v is not None:
                        out[j] = first_emoji(v)
                    continue
                picks = [flat.get(key(k, c)) for c in range(len(sents[j]))]
                if all(p is None for p in picks):
                    continue
                ws, got = [norm(w) for c in sents[j] for w in c.split()], []
                for p0 in picks:
                    for p in (p0 if isinstance(p0, list) else [p0] if p0 else []):
                        for w in str(p).split():
                            n = norm(w)
                            hit = next((x for x, y in enumerate(ws) if y == n and x not in got), None)
                            if n and n not in CAP_STOP and hit is not None:
                                got.append(hit)
                out[j] = got
        st['progress'] = min(1.0, (i + 15) / max(1, len(sents)))
    if sents and all(o is None for o in out):
        raise RuntimeError('the local model did not answer; try again')
    return {'marks': [o if o is not None else ('' if emo else []) for o in out]}


SPK_MODEL = AI_DIR / 'vendor' / 'wavlm-base-plus-sv'


def speakers(st, items, n=0):
    """Who says each caption (speaker diarization on this Mac): ai/diarize.py embeds each caption's own sound with WavLM
    (microsoft/wavlm-base-plus-sv) and clusters the voices. items: [{media, s, e} source seconds | None] -> labels 0.. (-1 = none)."""
    if not (AI_BIN / 'python').exists() or not (SPK_MODEL / 'pytorch_model.bin').exists():
        raise RuntimeError('the speaker model is not installed (run ai/setup.sh)')
    segs, files = [], {}
    for it in list(items)[:5000]:
        if not it:
            segs.append(None)
            continue
        mid = str(it.get('media'))
        m = meta(mid)
        if mid not in files:
            if not m.get('hasAudio') or not (f := pcm(m)):
                raise RuntimeError(f"could not read the sound of {m['name']}")
            files[mid] = str(f)
        segs.append([files[mid], *(min(max(fnum(it.get(k, 0), -1e6, 1e6), 0.0), m['duration']) for k in ('s', 'e'))])
    st['progress'] = 0.1
    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
        jf = Path(td) / 'job.json'
        jf.write_text(json.dumps({'model': str(SPK_MODEL), 'segs': segs, 'speakers': int(fnum(n, 0, 12))}))
        r = subprocess.run([str(AI_BIN / 'python'), '-I', str(AI_DIR / 'diarize.py'), str(jf)], capture_output=True, text=True, env={**AI_ENV, 'HF_HUB_OFFLINE': '1'}, timeout=1800)
    if r.returncode:
        raise RuntimeError('finding the speakers failed: ' + r.stderr.strip()[-300:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def hooks(st, ranges, lang='auto'):
    """Three hook titles for the edit, from the on-device transcript of the clips' ranges (local model)."""
    words = []
    for r in list(ranges)[:50]:
        a, b = fnum(r.get('in', 0), 0, 1e6), fnum(r.get('out', 0), 0, 1e6)
        words += [w['w'] for w in transcribe(r['media'], lang, [[a, b]]) if a <= w['s'] < b]
    if not words:
        raise ValueError('no speech found on the main track')
    ans = llm('You write hooks for short videos. Reply with JSON only.',
              'Write 3 different punchy hook titles (3-6 words each, one phrase, no hashtags, no emoji) for a vertical video with this transcript, '
              'in the same language as the transcript. Return {"hooks":["...","...","..."]}.\n\n' + ' '.join(words)[:12000])
    hs = [h for h in map(hook_text, ans.get('hooks') or []) if h][:3]
    if not hs:
        raise RuntimeError('the model wrote no hooks')
    return {'hooks': hs}


FILLER = re.compile(r'(u+h+m*|u+m+|e+r+m*|h+m+|a+h+|e+h+|m{2,})', re.I)


def fillers(mid, lang='auto', ranges=None):
    """Filler words (um, uh, er, hmm) from the on-device transcript, cut from the middle of the pause before to the
    middle of the pause after: DTW word edges are approximate, pause midpoints make clean jump cuts."""
    words, sil = transcribe(mid, lang, ranges), silences(mid, -35, 0.08)
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


# ---------- command bar (⌘K): plain language -> the MCP's own commands, planned by the local model ----------
_MCP = []
PILOT_OFF = {'status', 'options', 'timeline', 'media', 'import_media', 'projects', 'open_project', 'new_project', 'snapshot', 'preview_object', 'transcript',
             'main_transcript', 'remove_object', 'cut_out_object', 'blur_region', 'track_motion', 'import_subtitles', 'import_lut', 'relink_media', 'compound_clip',
             'break_compound', 'make_shorts', 'smart_combine', 'multicam', 'multicam_cut', 'add_clip', 'generate_video', 'pilot', 'search_media'}  # need a box, a path or a picture to look at, or only read
PILOT_ENUM = {('auto_captions', 'style'): 'captionPresets', ('add_text', 'preset'): 'textPresets', ('set_transition', 'type'): 'transitions', ('add_effect', 'type'): 'effects',
              ('add_sound_effect', 'name'): 'sounds', ('export', 'preset'): 'exportPresets', ('export', 'format'): 'formats', ('clip_tool', 'ramp'): 'speedRamps',
              ('auto_reframe', 'ratio'): 'ratios'}


def mcp_tools():
    """{name: (description, schema, editor command)} from mcp/cutroom_mcp.py: the command bar plans with the MCP's tools as they are."""
    if not _MCP:
        import importlib.util
        spec = importlib.util.spec_from_file_location('cutroom_mcp', Path(__file__).resolve().parent / 'mcp' / 'cutroom_mcp.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _MCP.append({n: (d, s, c) for n, d, s, c in mod.TOOLS if n not in PILOT_OFF and c})
    return _MCP[0]


def pilot_system():
    lines = []
    for n, (d, s, _) in mcp_tools().items():
        args = ', '.join(f"{k}{'*' if k in s['required'] else ''} ({p.get('type', 'any')}{', ' + '|'.join(p['enum']) if p.get('enum') else ''})" for k, p in s['properties'].items())
        lines.append(f'- {n}({args}): {d}')
    return ('You plan edits in Cutroom, a video editor, from the user\'s instruction. Reply with JSON only:\n'
            '{"steps": [{"tool": "<name>", "args": {...}, "each": "cut" or "clip" (optional), "say": "what the step does, 3-8 words"}], "cant": "the part you cannot do and why, else empty"}\n'
            'Rules:\n- Use only the tools below and their arguments (* = required). Clip ids come from the project below: "the third clip" is main clip #3.\n'
            '- "each" only when the user says every/each/all and the tool works on ONE time or clip: "cut" repeats the step at every cut between main clips '
            '(fills at/start with the cut time); "clip" repeats it for every main clip (fills id). Tools that already work on the whole edit (remove_pauses, auto_captions, export) never get "each".\n'
            '- One step per action; prefer the one tool made for it (remove_pauses for silences, auto_captions for captions, export with a preset for a platform).\n'
            '- One clip\'s own settings (mute = volume 0, speed, filter/look, position, animation) are update_clip with set {...}; set_track is for a whole track. '
            'A slow zoom through a whole clip is set {anim: {loop: "kbin"}} (Ken Burns; kbout zooms out). Reframing for another shape is auto_reframe (ratio), once per clip.\n'
            '- Use option values exactly as listed (the user says the name in the app). Leave out arguments you do not need.\n'
            '- If the instruction asks for something these tools cannot do, do not guess or substitute: leave it out of steps and explain it in "cant". If nothing fits, steps is [].\n'
            'Examples (ids are made up):\n'
            '"square format, reframed" -> {"steps": [{"tool": "auto_reframe", "args": {"ratio": "1:1"}, "each": "clip", "say": "Reframe every clip for 1:1"}], "cant": ""}\n'
            '"ken burns on clip 2, then remove the ums" -> {"steps": [{"tool": "update_clip", "args": {"id": "b2", "set": {"anim": {"loop": "kbin"}}}, "say": "Slow zoom in on clip 2"}, '
            '{"tool": "remove_fillers", "args": {}, "say": "Cut the filler words"}], "cant": ""}\n'
            '"turn her into a cartoon" -> {"steps": [], "cant": "Cutroom has no tool that restyles a person as a cartoon"}\n'
            'Tools:\n' + '\n'.join(lines))


def pilot_context(c):
    p, out = c.get('project') or {}, []
    out.append(f"Project: {p.get('ratio', '?')} canvas {p.get('w')}x{p.get('h')}, {p.get('fps')} fps, {p.get('duration')} s long, playhead at {p.get('playhead')} s")
    out.append('Main track (plays in this order):' if c.get('main') else 'Main track: empty')
    for i, m in enumerate(c.get('main') or []):
        out.append(f"  #{i + 1} id={m['id']} \"{m.get('name', '')}\" {m.get('kind', '')}{' with speech/sound' if m.get('sound') else ''}, {m.get('start')}-{m.get('end')} s"
                   + (f", speed {m['speed']}" if m.get('speed', 1) != 1 else ''))
    if c.get('cuts'):
        out.append('Cuts between main clips at: ' + ', '.join(f'{t} s' for t in c['cuts']))
    for k, v in (c.get('tracks') or {}).items():
        out.append(f'{k}: ' + ('; '.join(f"id={x['id']} {x.get('label', '')} {x.get('start')}-{x.get('end')} s" for x in v[:20]) if v else 'empty'))
    out.append(f"captions: {c.get('captions') or 0} on the captions track")
    out.append(f"Selected clip: {c.get('selected') or 'none'}")
    for k, v in (c.get('options') or {}).items():
        out.append(f'{k} (name in the app -> value to use): ' + ', '.join(f'{lab} -> {x}' for x, lab in v.items()) if isinstance(v, dict) else f'{k}: ' + ', '.join(map(str, v)))
    return '\n'.join(out)


def pilot_check(ans, c, text=""):
    """The model's plan -> steps the editor can run (arguments checked against the MCP schemas, option names made exact,
    'each' expanded, clip numbers turned into ids) and what it can't do, in words. Nothing is guessed: a bad step becomes a 'can't'."""
    tools, main, opts = mcp_tools(), c.get('main') or [], c.get('options') or {}
    ids = {x['id'] for x in main} | set(c.get('ids') or [])
    cant, out = [str(ans.get('cant') or '').strip()] if isinstance(ans, dict) else [], []
    norm = lambda s: re.sub(r'[\s_\-]+', '', str(s).lower())
    one = re.search(r'\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|selected)\b|#\d|\bclip\s*\d|\b\d+(\.\d+)?\s*(s|secs?|seconds?)\b', text, re.I)

    def canon(en, v, k):  # en: names, or {name: label} (a transition called by its label: Dissolve = fade)
        names = {**{norm(re.sub(r'\s*\(.*', '', str(lab))): x for x, lab in en.items()}, **{norm(x): x for x in en}} if isinstance(en, dict) else {norm(x): x for x in en}
        hit = names.get(norm(v))
        if hit is None:
            raise ValueError(f'{k} "{v}" is not one of {", ".join(map(str, list(en)[:40]))}')
        return hit

    def ref(v):  # a clip id, or #3 / 3 / clip 3 = the third main clip
        v = str(v).strip()
        if v in ids:
            return v
        n = re.fullmatch(r'(?:#|clip\s*|main\s*)?(\d+)', v, re.I)
        if n and 1 <= int(n[1]) <= len(main):
            return main[int(n[1]) - 1]['id']
        raise ValueError(f'there is no clip {v}')

    def coerce(p, v, k):
        t = p.get('type')
        if t in ('number', 'integer'):
            x = float(v) if not isinstance(v, bool) else None
            if x is None or not math.isfinite(x):
                raise ValueError(f'{k} must be a number')
            return int(round(x)) if t == 'integer' else x
        if t == 'boolean':
            return v if isinstance(v, bool) else str(v).lower() in ('true', '1', 'yes')
        if t == 'string':
            return str(v)
        if (t == 'object' and not isinstance(v, dict)) or (t == 'array' and not isinstance(v, list)):
            raise ValueError(f'{k} must be {"an object" if t == "object" else "a list"}')
        return v

    for st in (ans.get('steps') if isinstance(ans, dict) else None) or []:
        if not isinstance(st, dict):
            continue
        name, say = str(st.get('tool') or ''), str(st.get('say') or '').strip()[:80]
        if name in ('', 'say', 'none'):  # a note, not a step
            continue
        try:
            if name not in tools:
                raise ValueError(f'there is no tool "{name}" for that')
            _, s, cmd = tools[name]
            props = s['properties']
            raw = dict(st.get('args')) if isinstance(st.get('args'), dict) else {}
            if 'set' in props and not isinstance(raw.get('set'), dict) and (loose := {k: v for k, v in raw.items() if k not in props}):
                raw = {**{k: v for k, v in raw.items() if k in props}, 'set': loose}  # update_clip {id, speed: 2} = {id, set: {speed: 2}}
            raw.pop('show', None)  # an export never opens the Mac's player unasked
            args = {}
            for k, v in raw.items():
                if k not in props or v is None:
                    continue
                v = coerce(props[k], v, k)
                en = props[k].get('enum') or opts.get(PILOT_ENUM.get((name, k)) or '')
                args[k] = canon(en, v, k) if en and isinstance(v, str) else v
            vs = (c.get('voices') or {}).get({'voiceover': 'mac', 'ai_voiceover': 'ai'}.get(name, ''))
            if 'voice' in args and isinstance(vs, list) and args['voice'] not in vs:
                del args['voice']  # a voice of the other engine (Kokoro's af_heart for the Mac's say): the default voice instead
            if name == 'voiceover' and args.get('rate', 185) < 80:
                del args['rate']  # words a minute, not a multiplier
            for k in ('id', 'after', 'ref'):
                if k in args:
                    args[k] = ref(args[k])
            if 'ids' in args:
                args['ids'] = [ref(x) for x in args['ids']]
            if name in ('set_project', 'update_clip') and isinstance(args.get('set'), dict):  # the option names inside set {...}
                sv = args['set']
                if 'ratio' in sv and opts.get('ratios'):
                    sv['ratio'] = canon(opts['ratios'], sv['ratio'], 'ratio')
                if isinstance(sv.get('look'), dict) and sv['look'].get('name') and opts.get('looks'):
                    sv['look']['name'] = canon(opts['looks'], sv['look']['name'], 'look')
                for ak, ok in (('in', 'clipAnimIn'), ('out', 'clipAnimIn'), ('loop', 'clipLoops')):
                    if isinstance(sv.get('anim'), dict) and isinstance(sv['anim'].get(ak), str) and opts.get(ok):
                        sv['anim'][ak] = canon(opts[ok], sv['anim'][ak], f'anim {ak}')
                if 'mute' in sv:  # there is no mute setting: muted = volume 0
                    sv['volume'] = 0 if sv.pop('mute') else 1
            each = str(st.get('each') or '').lower()
            reps, each = [args], 'cut' if 'cut' in each else 'clip' if 'clip' in each or each in ('all', 'every', 'each') else None
            if 'id' in s['required'] and 'id' not in args and not each:  # no clip named: every clip when the user said so, else the selected one
                if re.search(r'\b(every|all|each)\b', text, re.I):
                    each = 'clip'
                elif c.get('selected') in ids:
                    args['id'] = c['selected']
            key = next((k for k in ('at', 'start', 'after') if k in props), None)
            # a tool without a time or clip (remove_pauses) runs once: 'each' is ignored. So is a time or clip the step names when the
            # model listed this tool more than once (four reframes with ids and each:clip were 16 steps) or the user named one
            # ("duplicate the first clip" duplicated every clip); a lone step's id is the model's filler and 'each' fills it
            mine = (key if each == 'cut' else 'id') in args and (sum(isinstance(x, dict) and x.get('tool') == name for x in ans['steps']) > 1 or one)
            if each == 'cut' and key and not mine:
                if not (cuts := c.get('cuts') or []):
                    raise ValueError('there are no cuts (one clip on the main track)')
                reps = [{**args, key: main[i]['id'] if key == 'after' else round(t, 3)} for i, t in enumerate(cuts)]
            elif each == 'clip' and 'id' in props and not mine:
                reps = [{**args, 'id': x['id']} for x in main if x.get('kind') in ('video', 'image')]
            for a in reps:
                if miss := [k for k in s['required'] if k not in a]:
                    raise ValueError(f'{name} needs {", ".join(miss)}')
                out.append({'tool': name, 'cmd': cmd, 'args': a, 'say': say or name.replace('_', ' ')})
        except (ValueError, TypeError) as e:
            cant.append(f"{say or name.replace('_', ' ')}: {e}")
    return out, [x for x in cant if x]


def pilot_plan(text, ctx):
    text = ' '.join(str(text).split())[:600]
    if not text:
        raise ValueError('say what to do')
    t0 = time.time()
    ans = llm(pilot_system(), pilot_context(ctx if isinstance(ctx, dict) else {}) + f'\n\nInstruction: {text}', ctx=16384)
    steps, cant = pilot_check(ans, ctx if isinstance(ctx, dict) else {}, text)
    return {'steps': steps, 'cant': cant, 'secs': round(time.time() - t0, 1)}


# ---------- smart search: what is in each library item (the local vision model), what is said in it (whisper), and how many people ----------
EMBED = 'nomic-embed-text:v1.5'  # Apache-2.0, 137M parameters, 274 MB in Ollama (ai/setup.sh pulls it)
INDEX_V = 1
STOP = set('a an the of in on at to and or with for from by is are was were be it its this that there here some any me my show find clip clips video videos where when who what scene shot footage'.split())


def embed(texts, query=False):
    """Text -> unit vectors (nomic-embed-text in Ollama, ~20 ms per query once loaded); None when it is not installed."""
    if not texts or not ollama_up():
        return None
    body = {'model': EMBED, 'input': [('search_query: ' if query else 'search_document: ') + t[:2000] for t in texts], 'keep_alive': '10m'}
    try:
        r = json.loads(urllib.request.urlopen(urllib.request.Request(LLM_URL + '/api/embed', data=json.dumps(body).encode(),
                                                                     headers={'Content-Type': 'application/json'}), timeout=300).read())
    except (OSError, ValueError):
        return None
    return [[round(x / (math.sqrt(sum(y * y for y in v)) or 1), 5) for x in v] for v in r.get('embeddings') or []] or None


def index_media(st, mid, span=(0.0, 1.0)):
    """What a library item shows and says, for search (cached cache/<id>.index.json): every scene (long takes in parts of up
    to 8 s, at most 48 parts) described by the local vision model with its people and faces, and its speech in sentences."""
    m, cache = meta(mid), CACHE / f'{mid}.index.json'
    if cache.exists() and (d := json.loads(cache.read_text())).get('v') == INDEX_V and (d['vision'] or not ai_status()['llm']):
        return d
    parts, vision, look = [], True, m['kind'] in ('video', 'image')
    if m['kind'] == 'video':
        dur = m['duration']
        cuts, step = [0.0, *[x for x in scenes(mid) if 0.3 < x < dur - 0.3], dur], max(8.0, dur / 48)
        for a, b in zip(cuts, cuts[1:]):
            k = max(1, math.ceil((b - a) / step))
            parts += [{'a': round(a + (b - a) * i / k, 3), 'b': round(a + (b - a) * (i + 1) / k, 3)} for i in range(k)]
        src = str(MEDIA / m['file'])
        if heavy(m) and (px := CACHE / f'{mid}.proxy.mp4').exists():
            src = str(px)
        dec, vf = hdr_decode(m) if src == str(MEDIA / m['file']) else ([], '')
    elif m['kind'] == 'image':
        parts, src, dec, vf = [{'a': 0, 'b': 0}], str(MEDIA / m['file']), [], ''
    for n, p in enumerate(parts):
        p['t'] = round((p['a'] + p['b']) / 2, 3)
        if look and vision:
            try:
                jpg = subprocess.run(['ffmpeg', '-v', 'error', *dec, *(['-ss', f"{p['t']:.3f}"] if m['kind'] == 'video' else []), '-i', src, '-frames:v', '1',
                                      '-vf', f'{vf}scale=448:-2', '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], capture_output=True).stdout
                d = llm('You describe video frames for a search index. Reply with JSON only.',
                        'Describe this frame. Return {"desc": "one sentence", "things": ["every clear object, person and animal, with its colour, e.g. red car"], '
                        '"people": number of people, "faces": number of faces you can see, "setting": "indoor|outdoor", "light": "day|night|dark|bright", '
                        '"tags": ["5-10 words: place, action, mood, weather"]}', ctx=4096, images=[base64.b64encode(jpg).decode()])
                p.update(desc=str(d.get('desc', ''))[:200], things=[str(x)[:40] for x in (d.get('things') or [])][:12] if isinstance(d.get('things'), list) else [],
                         people=int(fnum(d.get('people') or 0, 0, 999)), faces=int(fnum(d.get('faces') or 0, 0, 999)),
                         setting=str(d.get('setting', ''))[:20], light=str(d.get('light', ''))[:20], tags=[str(x)[:30] for x in (d.get('tags') or [])][:12] if isinstance(d.get('tags'), list) else [])
            except (RuntimeError, OSError, ValueError, AttributeError):
                vision = False  # no vision model: the index keeps the speech and is redone when the model is there
        st['progress'] = span[0] + (span[1] - span[0]) * 0.8 * (n + 1) / len(parts)
    speech = []
    if m.get('hasAudio') and m['kind'] in ('video', 'audio') and m['duration'] >= 2 and not m.get('sfx'):
        try:
            speech = sentences(transcribe(mid, 'auto'))
        except (RuntimeError, OSError, ValueError):
            speech = []
    texts = [ptext(p) for p in parts] + [s['text'] for s in speech]
    vec = embed(texts) or []
    for x, v in zip(parts + speech, vec):
        x['v'] = v
    d = {'v': INDEX_V, 'vision': vision, 'kind': m['kind'], 'parts': parts if vision else [], 'speech': speech}
    cache.write_text(json.dumps(d))
    st['progress'] = span[1]
    return d


def ptext(p):
    return '. '.join(x for x in (p.get('desc', ''), ', '.join(p.get('things') or []), f"{p.get('setting', '')} {p.get('light', '')}".strip(),
                                 ', '.join(p.get('tags') or []), {0: 'no people'}.get(p.get('people'), f"{p.get('people')} people")) if x)


def index_many(st, mids):
    done, errs = 0, []  # no ids: every item not indexed yet
    mids = [x for x in dict.fromkeys(map(str, mids or [f.stem for f in MEDIA.glob('*.json') if not (CACHE / f'{f.stem}.index.json').exists()]))
            if (MEDIA / f'{x}.json').exists()][:500]
    for i, mid in enumerate(mids):
        try:
            index_media(st, mid, (i / len(mids), (i + 1) / len(mids)))
            done += 1
        except (RuntimeError, OSError, ValueError, KeyError) as e:
            errs.append(f"{meta(mid).get('name', mid)}: {e}")
    return {'indexed': done, 'errors': errs[:20]}


WORD_NUM = {'no': 0, 'zero': 0, 'nobody': 0, 'one': 1, 'a': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6}


def stem(w):
    return re.sub(r'(ies|es|s|ing|ed)$', '', w) if len(w) > 4 else w


def search(q, mids=None):
    """Library items by what is in them (picture), what is said (speech) and how many people: one best moment per item,
    best first. Scores: embedding similarity + shared words + the people count asked for."""
    q = ' '.join(str(q).split())[:200]
    ql = q.lower()
    words = [stem(w) for w in re.findall(r"[\w']+", ql) if w not in STOP]
    want = None  # how many people the query asks for: (low, high)
    if n := re.search(r"\b(no|zero|one|a|two|three|four|five|six|\d+)\s+(?:people|persons?|men|women|guys|kids|faces?|man|woman|person)\b", ql):
        k = WORD_NUM.get(n[1], int(n[1]) if n[1].isdigit() else 1)
        want = (k, k)
    elif re.search(r'\b(nobody|empty|no one|without people)\b', ql):
        want = (0, 0)
    elif re.search(r'\b(people|crowd|group|friends|family|couple)\b', ql):
        want = (2, 999)
    elif re.search(r'\b(person|someone|man|woman|guy|girl|boy|face|selfie|portrait)\b', ql):
        want = (1, 999)
    talk = bool(re.search(r'\b(talk|talking|speak|speaking|says?|said|saying|interview|conversation|podcast|chat)', ql))
    qv = (embed([q], query=True) or [None])[0]
    cos = lambda v: sum(a * b for a, b in zip(qv, v)) if qv and v else 0.0
    have = lambda text: sum(1 for w in words if w and w in {stem(x) for x in re.findall(r"[\w']+", text.lower())}) / max(1, len(words))
    out, unindexed = [], 0
    for f in MEDIA.glob('*.json'):
        mid = f.stem
        if mids and mid not in mids:
            continue
        try:
            m = json.loads(f.read_text())
        except ValueError:
            continue
        if not m.get('file') or not (MEDIA / m['file']).exists():
            continue
        cache = CACHE / f'{mid}.index.json'
        if not cache.exists():
            unindexed += 1
            continue
        d = json.loads(cache.read_text())
        best = None
        for p in d.get('parts') or []:
            s = cos(p.get('v')) + 0.3 * have(ptext(p))
            if want:
                s += 0.15 if want[0] <= max(p.get('people', 0), p.get('faces', 0)) <= want[1] else -0.15
            if talk and any(x['s'] < p['b'] and x['e'] > p['a'] for x in d.get('speech') or []):
                s += 0.12
            if not best or s > best['score']:
                best = {'score': s, 't': p['t'], 'a': p['a'], 'b': p['b'], 'why': 'picture', 'text': p.get('desc', '')}
        for x in d.get('speech') or []:
            s = 0.85 * cos(x.get('v')) + 0.35 * have(x['text']) + (0.5 if len(ql) > 3 and ql in x['text'].lower() else 0)
            if talk:
                s += 0.05
            if not best or s > best['score']:
                best = {'score': s, 't': x['s'], 'a': x['s'], 'b': x['e'], 'why': 'speech', 'text': x['text']}
        if best:
            if words and have(m.get('name', '')) == 1:
                best['score'] += 0.2
            out.append({'media': mid, 'name': m.get('name'), 'kind': m.get('kind'), **best, 'score': round(best['score'], 3)})
    out.sort(key=lambda r: -r['score'])
    top = out[0]['score'] if out else 0
    return {'results': [r for r in out if r['score'] >= max(0.45, top - 0.25)][:30], 'unindexed': unindexed, 'semantic': qv is not None}


# ---------- render engine: validated plan -> one ffmpeg filtergraph ----------

def fnum(v, lo, hi):
    try:
        x = float(v)
    except (TypeError, ValueError):  # a missing number (None) reached the user as Python's "float() argument must be..."
        raise ValueError(f'value {v!r} is not a number')
    if not lo <= x <= hi:  # also rejects NaN
        raise ValueError(f'value {v!r} outside [{lo}, {hi}]')
    return x


def clean_plan(p):
    """Validate the client's render plan; media ids resolve to files server-side (the client never sends paths)."""
    W, H = int(fnum(p['w'], 16, 8192)), int(fnum(p['h'], 16, 8192))
    if W * H > 4096 * 2304 and RAM_GB < 16 and p.get('format') not in SOUND:  # an 8K export of two 4K clips peaked at 5.8 GB (HEVC) to 9.2 GB (x264)
        raise ValueError(f'an export above 4K needs a Mac with 16 GB of memory (this one has {RAM_GB:.0f} GB): choose 4K')
    out = {'w': W - W % 2, 'h': H - H % 2, 'fps': fnum(p['fps'], 1, 120), 'duration': fnum(p['duration'], 0.04, 6 * 3600),
           'bg': p['bg'] if HEX.fullmatch(str(p.get('bg', ''))) else '#000000',
           'quality': 'best' if p.get('quality') == 'best' else 'fast', 'loud': bool(p.get('loud')), 'lufs': p.get('lufs') if p.get('lufs') in LUFS else -14,
           'format': p.get('format') if p.get('format') in FORMATS else 'mp4', 'hdr': p.get('hdr') if p.get('hdr') in ('hlg', 'pq') else None, 'library': bool(p.get('library')), 'light': bool(p.get('light')), 'still': fnum(p.get('still', 0), 0, 1e6), 'rate': fnum(p.get('rate', 1), 0.5, 4),
           'efps': p['efps'] if p.get('efps') in EXPORT_FPS else 0, 'mbps': fnum(p.get('mbps') or 0, 0, 400),  # 0 = the project's fps / bitrate from the preset
           'name': re.sub(r'[^\w\- ]', '', str(p.get('name', '')))[:80].strip() or 'Cutroom export'}

    def clip(c, timed):
        m = meta(c['media'])
        k = {'path': str(exact_audio(m) if m['kind'] == 'audio' else MEDIA / m['file']), 'kind': m['kind'], 'hasAudio': m['hasAudio'],
             'in': fnum(c.get('in', 0), -1e6, 1e6), 'out': fnum(c.get('out', 0), -1e6, 1e6),
             'speed': fnum(c.get('speed', 1), 0.1, 100), 'volume': fnum(c.get('volume', 1), 0, 10),
             'frames': int(fnum(c['frames'], 1, 1e8)), 'fadeIn': fnum(c.get('fadeIn', 0), 0, 60), 'fadeOut': fnum(c.get('fadeOut', 0), 0, 60),
             'fit': c.get('fit') if c.get('fit') in ('fit', 'fill', 'blur') else 'fit', 'opacity': fnum(c.get('opacity', 1), 0, 1),
             'adj': {a: fnum((c.get('adj') or {}).get(a, 1), 0, 4) for a in 'bcs'}}
        if m['kind'] != 'image' and not 0 <= k['in'] < k['out']:
            raise ValueError('empty clip')
        k['sfps'] = fnum(m.get('fps') or 0, 0, 1000)  # the source's frame rate: its frame grid (see ss())
        if not Path(k['path']).is_file():  # said up front by name, not as ffmpeg's error halfway through the render
            raise ValueError(f"{m.get('name') or 'A clip'} has lost its file (moved or deleted): relink it from the clip's panel")
        tr = c.get('tr') or {}
        k['tr'] = tr.get('type') if tr.get('type') in XFADES else 'custom' if tr.get('expr') else None
        if k['tr'] == 'custom':  # an effects-pack transition (web/fxpack.js): geq's red, green, blue, checked token by token
            k['trx'] = {c: xexpr((tr['expr'] or {}).get(c)) for c in ('er', 'eg', 'eb')}
        k['trf'] = int(fnum(tr.get('frames', 0), 0, 1e6)) if k['tr'] else 0
        k.update(hdr=bool(m.get('hdr')) and not m.get('alpha'), rot=int(m.get('rot', 0)), alpha=bool(m.get('alpha')),  # VT decode would drop alpha
                 trc=m.get('hdr') and (m.get('trc') or sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer',
                                                          '-of', 'csv=p=0', k['path']]).stdout.strip()),  # HLG / PQ (items imported before 'trc' was kept: read from the file)
                 flip=bool(c.get('flip')), denoise=bool(c.get('denoise')), pitch=bool(c.get('pitch')), heavy=heavy(m))
        k['studio'] = c.get('studio') if c.get('studio') in (True, 'music') else False
        if fx := clip_fx(c, m):  # the sound the preview plays: the same processed PCM file (Reduce noise, Studio voice, a character)
            if not (f := pcm(m, fx=fx)):
                raise ValueError(f"{m.get('name') or 'A clip'}: processing its sound failed")
            k['dn'] = str(f)
        au = c.get('au') if isinstance(c.get('au'), dict) else {}
        k['au'] = {'voice': au.get('voice') if au.get('voice') in VOICE_FX else 'none', 'semi': round(fnum(au.get('semi', 0), -12, 12)),
                   **{b: fnum(au.get(b, 0), -15, 15) for b in ('bass', 'mid', 'treb')}, 'pan': fnum(au.get('pan', 0), -1, 1)}
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
                    'u0': fnum(f.get('u0', 0), 0, 1), 'u1': fnum(f.get('u1', 1), 0, 1),
                    'bz': [fnum(v, *((0, 1) if i % 2 == 0 else (-5, 5))) for i, v in enumerate(f['bz'])] if isinstance(f.get('bz'), list) and len(f['bz']) == 4 else None}
                   for f in kf] or None
        k['angle'] = fnum(c.get('angle', 0), -3600, 3600)
        k['blend'] = c.get('blend') if c.get('blend') in BLENDS else None
        k['trans'] = bool(m.get('trans'))
        k['untagged_hd'] = m['kind'] == 'video' and m.get('cs') in ('', 'unknown') and max(m.get('w', 0), m.get('h', 0)) >= 720 and not m.get('hdr')
        # decodes as BT.709 frames tagged so; HDR too (VT_SDR tone maps to BT.709 and retags the frames)
        k['bt709'] = m['kind'] == 'video' and (m.get('cs') == 'bt709' or k['untagged_hd'] or k['hdr'])
        k['vkf'] = [{'t': fnum(f['t'], -1e5, 1e5), 'v': fnum(f['v'], 0, 10), 'e': 1 if f.get('e') else 0} for f in (c.get('vkf') or [])[:5000]] or None
        if m['kind'] != 'audio':  # source size after crop, in display pixels: rotation and keyframe placement need it
            k['mw'], k['mh'] = m['w'] * (1 - k['crop']['l'] - k['crop']['r']), m['h'] * (1 - k['crop']['t'] - k['crop']['b'])
        k['grade'] = base64.b64decode(str(c['grade'])) if c.get('grade') else None  # the UI's grade (wheels, curves, HSL, LUT) as a 33^3 table, uint16
        if k['grade'] is not None and len(k['grade']) != 33 ** 3 * 3 * 2:
            raise ValueError('grade must be a 33-point 3D table')
        k['lkf'] = [{'t': fnum(f['t'], -1e5, 1e5), 'v': fnum(f['v'], 0, 1)} for f in (c.get('lkf') or [])[:2000]] or None  # filter strength keyframes
        k['blur'] = int(fnum(c.get('blur', 0), 0, 400)) or None  # px in the source
        k['pix'] = int(fnum(c.get('pix', 0), 0, 400)) // 2 * 2 or None  # mosaic block, px in the source (even: whole chroma samples)
        sp = c.get('sharp') or {}  # sharpen: unsharp's binomial radius in source px (1-11) and its amount
        k['sharp'] = {'r': int(fnum(sp.get('r', 2), 1, 11)), 'amt': fnum(sp.get('amt', 0), 0, 5)} if sp.get('amt') else None
        mb = int(fnum(c.get('mb', 0), 0, 9))  # motion blur: frames mixed
        k['mb'] = mb if mb > 1 and m['kind'] == 'video' else None
        b = c.get('beauty') or {}
        k['beauty'] = {'amt': fnum(b.get('amt', 0), 0, 1), 'sigma': fnum(b.get('sigma', 4), 0.1, 512)} if b.get('amt') else None
        g = c.get('glow') or {}
        k['glow'] = {'color': g['color'] if HEX.fullmatch(str(g.get('color', ''))) else '#ffffff', 'sigma': fnum(g.get('sigma', 8), 0.1, 512), 'gain': fnum(g.get('gain', 1), 0.1, 8)} if g.get('sigma') else None
        k['tone'] = [int(fnum(v, 0, 255)) for v in c['tone']] if c.get('tone') else None  # 256-entry curve made by the UI (exposure, highlights...)
        if k['tone'] is not None and len(k['tone']) != 256:
            raise ValueError('tone curve must have 256 entries')
        k['vig'] = base64.b64decode(c['vig'].split(',')[-1]) if c.get('vig') else None  # vignette multiplier PNG drawn by the UI
        if k['vig'] is not None and not k['vig'].startswith(b'\x89PNG'):
            raise ValueError('vignette must be PNG')
        k['mask'] = base64.b64decode(c['mask'].split(',')[-1]) if c.get('mask') else None
        if c.get('maskSeq'):  # keyframed mask: PNGs + runs of frames that cover the clip
            ms = c['maskSeq']
            pngs = [base64.b64decode(str(x).split(',')[-1]) for x in (ms.get('pngs') or [])[:20000]]
            spans = [{'i': int(fnum(q['i'], 0, len(pngs) - 1)), 'n': int(fnum(q['n'], 1, 1e8))} for q in (ms.get('spans') or [])[:200000]]
            if not pngs or not spans or any(not x.startswith(b'\x89PNG') for x in pngs):
                raise ValueError('maskSeq must be PNG frames with runs')
            k['mask_seq'] = {'pngs': pngs, 'spans': spans}
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
    if t.get('layer'):  # uploaded before the plan (POST /api/layer/<id>/<i>): PNGs of one crop box, laid at its corner
        if not re.fullmatch(r'[0-9a-f]{12}', str(t['layer'])) or len(t.get('box') or []) != 4:
            raise ValueError('bad text layer')
        d = CACHE / 'layers' / t['layer']
        out['pngs'] = [d / f't{i}.png' for i in range(int(fnum(t['n'], 1, 200000)))]
        if not all(f.is_file() for f in out['pngs']):
            raise ValueError('text layer upload incomplete')
        out['box'] = [int(fnum(v, 0, 8192)) for v in t['box']]
        out['layer_dir'] = d
    else:
        out['pngs'] = [base64.b64decode(s.split(',')[-1]) for s in t.get('pngs', [])]
    if any(not isinstance(b, Path) and not b.startswith(b'\x89PNG') for b in out['pngs']):
        raise ValueError('text layer must be PNG')
    out['frames'] = [{'i': int(fnum(f['i'], 0, len(out['pngs']) - 1)), 'start': fnum(f['start'], 0, 1e6), 'end': fnum(f['end'], 0, 1e6)}
                     for f in t.get('frames', [])]
    out['fx'] = [fx_op(f, out['w'], out['h']) for f in (p.get('fx') or [])[:300]]
    hv = {'mp4': 'hevc'}.get(out['format'], out['format'])  # HDR in an MP4 is HEVC Main 10 (H.264 has no 10-bit hardware encoder)
    if out['hdr'] and (why := hdr_why({**out, 'format': hv})):  # exported in SDR (the format chosen), and the job says why
        out['hdr'], out['sdr'] = None, why
    elif out['hdr']:
        out['format'] = hv
    out['alpha'] = bool(p.get('alpha')) and out['format'] in ALPHA_FORMATS  # transparent background
    return out


def fx_op(f, W, H):
    """One video-effect step on frames [a, b) of the composite (the UI computes every value, per frame where it moves)."""
    op = f.get('op')
    if op not in FX_OPS:
        raise ValueError(f'unknown effect step {op!r}')
    a = int(fnum(f['a'], 0, 1e8))
    k = {'op': op, 'a': a, 'b': int(fnum(f['b'], a + 1, 1e8))}
    n = k['b'] - k['a']
    per = lambda key, lo, hi: [fnum(v, lo, hi) for v in f[key]] if isinstance(f.get(key), list) else fnum(f.get(key, 0), lo, hi)
    if op == 'matrix':
        k['m'] = [fnum(v, -3, 3) for v in f['m']]
        k['k'] = per('k', 0, 4) if f.get('k') is not None else 1.0  # brightness flicker: a factor per frame
        if len(k['m']) != 9:
            raise ValueError('matrix needs 9 values')
    elif op in ('blur', 'hblur'):
        k['sigma'] = fnum(f['sigma'], 0.1, 500)
    elif op == 'zblur':
        k['s'] = fnum(f['s'], 0, 2)
    elif op == 'pixelize':
        k['size'] = int(fnum(f['size'], 2, 1024))
    elif op == 'rgbshift':
        k['rh'], k['bh'] = per('rh', -255, 255), per('bh', -255, 255)
    elif op == 'noise':
        k['s'] = int(fnum(f['s'], 1, 100))
    elif op == 'transform':  # zoom and offset of the whole frame, one value per frame
        k['z'], k['x'], k['y'] = per('z', 1, 8), per('x', -W, W), per('y', -H, H)
    elif op == 'glow':
        k['sigma'], k['amt'] = fnum(f['sigma'], 0.1, 500), fnum(f['amt'], 0, 2)
    elif op == 'expr':  # an effects-pack effect: geq's red, green and blue expressions (web/fxpack.js), LF = frames since its start
        k.update({'e' + c: xexpr(f.get('e' + c)) for c in 'rgb'})  # er, eg, eb (a and b are its frames)
    elif op == 'lut':  # an adjustment layer: its whole colour stage as one 33^3 table (uint16, like a clip's grade)
        k['lut'] = base64.b64decode(str(f.get('lut') or ''))
        if len(k['lut']) != 33 ** 3 * 3 * 2:
            raise ValueError('lut must be a 33-point 3D table')
    for key in ('k', 'rh', 'bh', 'z', 'x', 'y'):
        if isinstance(k.get(key), list) and len(k[key]) != n:
            raise ValueError(f'{op}.{key} needs one value per frame ({n})')
    return k


def even(x):
    return int(round(x / 2)) * 2


def xexpr(s):
    """A per-pixel expression from the page (web/fxpack.js compiles each one): nothing but XNAMES, numbers, + - * / ( ) ,
    and ; (st/ld sequences), so it can't leave its quoted filter option, and every parenthesis closes."""
    s, depth = str(s or ''), 0
    if not s or len(s) > 100000:
        raise ValueError('expression missing or too long')
    for t in re.findall(r'[A-Za-z_]\w*|\d+\.?\d*|\.\d+|\S', s):
        depth += (t == '(') - (t == ')')
        if depth < 0 or not (t in XNAMES or t[0].isdigit() or t[0] == '.' and len(t) > 1 or t in '+-*/(),;'):
            raise ValueError(f'bad expression token {t!r}')
    if depth:
        raise ValueError('unbalanced expression')
    return s


def zoom_blur(tag, z, W, H):
    """Zoom blur of a W x H stream: ZB_K copies zoomed 1 .. 1+z about the centre, averaged (the preview's zblurInPlace).
    z is an expression; n there is the frame number in this stream (scale eval=frame), so a transition can ramp it."""
    s = f"split={2 * ZB_K - 1}[{tag}o0]" + ''.join(f'[{tag}a{i}][{tag}b{i}]' for i in range(1, ZB_K))
    for i in range(1, ZB_K):  # each zoomed copy over the frame it came from (it covers it all), centred
        s += (f";[{tag}b{i}]scale=w='2*trunc({W}*(1+({z})*{i / (ZB_K - 1):.6f})/2)':h=-2:eval=frame:flags=bilinear[{tag}s{i}]"
              f";[{tag}a{i}][{tag}s{i}]overlay=x='({W}-overlay_w)/2':y='({H}-overlay_h)/2':eval=frame:format=gbrp[{tag}o{i}]")
    return s + ';' + ''.join(f'[{tag}o{i}]' for i in range(ZB_K)) + f'mix=inputs={ZB_K}'


def ss3(x):
    return x * x * (3 - 2 * x)


def bez_coef(bz):
    x1, y1, x2, y2 = (float(v) for v in bz)
    cx = 3 * x1
    bx = 3 * (x2 - x1) - cx
    cy = 3 * y1
    by = 3 * (y2 - y1) - cy
    return 1 - cx - bx, bx, cx, 1 - cy - by, by, cy


def bez(bz, u):
    """cubic-bezier(x1, y1, x2, y2) at time u, s by 16 halvings: the same doubles as the UI's bezE() and bez_expr()."""
    ax, bx, cx, ay, by, cy = bez_coef(bz)
    s, h = 0.0, 1.0
    for _ in range(16):
        h /= 2
        q = s + h
        if ((ax * q + bx) * q + cx) * q < u:
            s = q
    s += h / 2
    return ((ay * s + by) * s + cy) * s


def bez_expr(bz, w):
    """bez() as an ffmpeg expression of w (st/ld registers 0-1; each halving is one flat term, so no deep nesting)."""
    ax, bx, cx, ay, by, cy = bez_coef(bz)
    terms, h = [f'st(0,{w})', 'st(1,0)'], 1.0
    for _ in range(16):
        h /= 2
        q = f'(ld(1)+{h!r})'
        terms.append(f'st(1,ld(1)+{h!r}*lt((({ax!r}*{q}+{bx!r})*{q}+{cx!r})*{q},ld(0)))')
    m = f'(ld(1)+{h / 2!r})'
    return '(' + '+'.join(f'0*{x}' for x in terms) + f'+(({ay!r}*{m}+{by!r})*{m}+{cy!r})*{m})'


def pw(kf, key, var='t'):
    """Keyframe curve as an ffmpeg expression (same interpolation as the UI's propsAt): linear, or smoothstep
    per segment when the segment's first keyframe has e=1 (its cubic-bezier when it also has bz). Segments are chosen by a balanced if() tree: ffmpeg's
    expression parser gives up past ~100 nesting levels, and tracking or ducking easily makes hundreds of points."""
    segs = list(zip(kf, kf[1:]))
    if not segs:
        return f'{kf[0][key]:.4f}'

    def seg(a, b):  # clip() also holds the end values outside the segment, so the outer leaves cover t < first and t > last
        u = f"clip(({var}-{a['t']:.6f})/{max(b['t'] - a['t'], 1e-6):.6f},0,1)"
        if a.get('e') and a.get('bz'):  # a cubic-bezier ease (or the part [u0, u1] of it a cut left)
            r0, r1, bz = a.get('u0', 0), a.get('u1', 1), a['bz']
            d = bez(bz, r1) - bez(bz, r0)
            if (r0, r1) == (0, 1):
                u = bez_expr(bz, u)
            elif abs(d) > 1e-9:
                u = f"(({bez_expr(bz, f'({r0!r}+{u}*{r1 - r0!r})')})-{bez(bz, r0)!r})/{d!r}"
        elif a.get('e'):  # smoothstep, or the part [u0, u1] of it that a cut left this segment with
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
                E = (lambda v: bez(a['bz'], v)) if a.get('bz') else ss3
                d = E(r1) - E(r0)
                u = (E(r0 + u * (r1 - r0)) - E(r0)) / d if abs(d) > 1e-9 else u
            return a[key] + (b[key] - a[key]) * u
    return kf[-1][key]


def rotation(c):
    """Rotate before scaling: the frame grows to its diagonal with transparent corners (positive = clockwise, like canvas)."""
    kf = c.get('kf')
    angles = {f['a'] for f in kf} if kf else {c.get('angle', 0)}
    if all(abs(a) < 0.01 for a in angles):
        return ''
    a = f"({pw(kf, 'a')})*PI/180" if len(angles) > 1 else f'{next(iter(angles)) * math.pi / 180:.6f}'
    return f",format=rgba,rotate=a='{a}':ow='hypot(iw,ih)':oh=ow:c=black@0"  # not c=none: that leaves old frames in the corners (ghosts while it turns)


def look(c):
    if not c.get('look'):
        return ''
    m = c['look']
    return ',colorchannelmixer=' + ':'.join(f'{n}={v:.4f}' for n, v in zip(('rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'), m))


def overlap(a, b):
    """Frames two adjacent main clips share in a transition (0 = hard cut). Same clamp as the UI's trF()."""
    return min(a['trf'], a['frames'] // 2, b['frames'] // 2) if a['tr'] else 0


VOICE_FX = ('none', 'robot', 'echo', 'hall', 'telephone', *VOICE_CHARS)  # characters are in the clip's PCM (fx_pcm), not afx()
AFX_N = __import__('itertools').count()  # unique filter labels (a hall reverb needs a few)


def afx(au, n):
    """A clip's sound settings as ffmpeg filters, the same maths as the preview's Web Audio chain (app.js soundChain):
    pitch in semitones keeping the length, 3-band EQ (RBJ shelves / peak, like BiquadFilterNode), a voice effect, and an
    equal-power pan (StereoPannerNode's formula for stereo input). Empty when the clip is untouched."""
    au = au or {}
    if not (au.get('semi') or au.get('bass') or au.get('mid') or au.get('treb') or au.get('pan') or au.get('voice', 'none') not in ('none', *VOICE_CHARS)):
        return ''
    f = ['aresample=48000', 'aformat=channel_layouts=stereo']  # the preview's chain runs in stereo too (mono doubled)
    if au.get('semi'):
        r = 2 ** (au['semi'] / 12)
        f += [f'asetrate={48000 * r:.3f}', 'aresample=48000', atempo(1 / r)]
    if au.get('bass'):
        f.append(shelf(100, au['bass'], low=True))
    if au.get('mid'):
        f.append(f"equalizer=f=1000:t=q:w=1:g={au['mid']:.2f}")
    if au.get('treb'):
        f.append(shelf(8000, au['treb'], low=False))
    v = au.get('voice')
    if v == 'telephone':
        f += ['highpass=f=400:p=2:t=q:w=0.7071', 'lowpass=f=3200:p=2:t=q:w=0.7071']
    elif v == 'robot':  # ring modulation by 50 Hz
        f.append("aeval='val(ch)*sin(2*PI*50*t)':c=same")
    elif v == 'echo':  # three taps, 250 / 500 / 750 ms
        f.append('aecho=1:0.8:250|500|750:0.5|0.25|0.125')
    elif v == 'hall':  # the dry sound plus its convolution with the hall's impulse response (the same file the preview uses)
        f.append(f"asplit=2[hd{n}][hw{n}];amovie={hall_ir()},aformat=sample_rates=48000:channel_layouts=stereo[hi{n}];"
                 f"[hw{n}][hi{n}]afir=irnorm=-1:gtype=none[hx{n}];[hd{n}][hx{n}]amix=inputs=2:normalize=0")
    p = au.get('pan', 0)
    if p:
        import math
        x = p + 1 if p <= 0 else p
        gl, gr = math.cos(x * math.pi / 2), math.sin(x * math.pi / 2)
        f.append(f'pan=stereo|c0=c0+{gl:.6f}*c1|c1={gr:.6f}*c1' if p <= 0 else f'pan=stereo|c0={gl:.6f}*c0|c1=c1+{gr:.6f}*c0')
    return ',' + ','.join(f)


def shelf(f0, g, low, sr=48000):
    """A shelving EQ with the Web Audio spec's coefficients (BiquadFilterNode lowshelf / highshelf, slope 1) as an ffmpeg
    biquad: ffmpeg's own bass / treble filters overshoot (+12.7 dB at 50 Hz and -0.7 dB at 200 Hz for +12 dB at 100 Hz)."""
    import math
    A, w = 10 ** (g / 40), 2 * math.pi * f0 / sr
    c, al = math.cos(w), math.sin(w) / 2 * math.sqrt(2)
    k = 2 * al * math.sqrt(A)
    if low:
        b = [A * ((A + 1) - (A - 1) * c + k), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - k)]
        a = [(A + 1) + (A - 1) * c + k, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - k]
    else:
        b = [A * ((A + 1) + (A - 1) * c + k), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - k)]
        a = [(A + 1) - (A - 1) * c + k, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - k]
    return 'biquad=' + ':'.join(f'{n}={v / a[0]:.10f}' for n, v in zip(('b0', 'b1', 'b2', 'a0', 'a1', 'a2'), b + a))


IRS = {'hall': (2.2, 1.8, 7, 0.035, ()),  # seconds, RT60, seed, level, early echoes (s, level)
       'cave': (3.2, 3.0, 11, 0.03, ((0.06, 0.45), (0.11, 0.3), (0.19, 0.22), (0.29, 0.15)))}


def hall_ir(kind='hall'):
    """The hall reverb's impulse response: 2.2 s of seeded noise per channel under an exponential decay (RT60 ~1.8 s),
    5 ms pre-delay, 48 kHz stereo WAV in the cache. Deterministic, so the preview (ConvolverNode) and export (afir) match.
    'cave' (the voice character): longer, with four discrete early echoes off the walls."""
    length, rt, seed, level, taps = IRS[kind]
    out = CACHE / f'{kind}_ir.wav'
    if not out.exists():
        import math, random, struct, wave
        rnd, sr, n = random.Random(seed), 48000, int(length * 48000)
        fr = bytearray()
        for i in range(n):
            t = i / sr
            env = 0 if t < 0.005 else math.exp(-6.9 * (t - 0.005) / rt) * min(1, (t - 0.005) / 0.01)
            fr += struct.pack('<hh', *(int(max(-1, min(1, rnd.gauss(0, 1) * env * level)) * 32767) for _ in range(2)))
        for at, g in taps:
            struct.pack_into('<hh', fr, 4 * int(at * sr), int(g * 32767), int(g * 32767))
        tmp = out.with_suffix('.tmp')
        with wave.open(str(tmp), 'wb') as w:
            w.setnchannels(2), w.setsampwidth(2), w.setframerate(sr), w.writeframes(bytes(fr))
        tmp.replace(out)
    return out


def atempo(s):
    if abs(s - 1) < 1e-6:  # atempo=1 is not a pass-through: its overlap-add wandered 7 ms on speech
        return 'anull'
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


RGB_NEEDS = (('kf', 'keyframes'), ('alpha', 'a transparent clip'), ('trans', 'a transparent clip'), ('key', 'chroma key'), ('mask', 'a mask'),
             ('mask_seq', 'a mask'), ('vig', 'a vignette'), ('look', 'a filter'), ('tone', 'adjustments'), ('grade', 'a colour grade'),
             ('lkf', 'filter keyframes'), ('beauty', 'beauty'), ('blur', 'blur'), ('pix', 'mosaic'), ('sharp', 'sharpen'))


def rgb_need(c):
    """What in a main clip needs the RGB composite ('' = nothing: it can stay 4:2:0 YUV)."""
    return ('a blurred background' if c['fit'] == 'blur' else 'opacity' if c['opacity'] < 1 else 'a transition other than Dissolve' if c.get('tr') not in (None, 'fade')
            else 'brightness / contrast / saturation' if adjust(c) else 'rotation' if rotation(c) else next((n for k, n in RGB_NEEDS if c.get(k)), ''))


def yuv_ok(p):
    """Nothing in the plan needs RGB: plain cuts, dissolves and fades on the main track only, into a 4:2:0 file. Those stay
    in yuv420p from decode to encode, no base-frame overlay (1 min of 1080p60 from 4K: 245 -> 170 CPU-s, 46 dB vs the RGB path).
    An HDR export takes this path only (10-bit, any format). A transparent plan (and its 'mp4' chunks) needs RGBA. p['rgb'] (selftest only) forces the RGB path."""
    return bool(p['main']) and not (p.get('rgb') or p.get('alpha') or p['overlay'] or p['frames'] or p.get('fx')) and (p.get('format', 'mp4') in ('mp4', 'hevc', 'av1', 'av1webm', 'webm') or p.get('hdr')) and not any(map(rgb_need, p['main']))


def hdr_why(p):
    """Why an HDR export comes out SDR ('' = it stays HDR). HDR keeps the 10-bit YUV path from decode to encode: cuts, trims,
    speed, crop, flip, fades and dissolves of HLG / PQ video on the main track. Everything else composites in 8-bit RGB as
    BT.709 (overlays, text, stickers, effects, colour), and an SDR clip would need an SDR -> HDR conversion: those export SDR."""
    if p['format'] not in ('hevc', 'prores'):
        return 'HDR is made as HEVC (MP4) or ProRes 422 HQ only'
    if not p['main']:
        return 'there is no main track'
    why = ('overlay clips' if p['overlay'] else 'text, captions or stickers' if p['frames'] else 'effects' if p.get('fx') else
           next((f'a clip with {n}' for c in p['main'] if (n := rgb_need(c))), '') or
           next(('a photo or SDR clip on the main track' for c in p['main'] if not c['hdr']), '') or
           next(('PQ footage (it exports as PQ only)' for c in p['main'] if p['hdr'] == 'hlg' and c['trc'] == 'smpte2084'), ''))
    return why


def graph(p, td):
    """Return (input args, filtergraph). Layer order matches the preview: bg, main, overlays, text."""
    W, H, F, D, BG = p['w'], p['h'], p['fps'], p['duration'], p['bg'].replace('#', '0x')
    ins, fg, mix = [], [], []
    yuv, hdr, A = yuv_ok(p), p.get('hdr'), p.get('alpha')  # hdr: clean_plan kept it only where yuv holds (hdr_why)
    if A:  # transparent background: the composite carries alpha (gbrap) from the base frame to the file
        BG = 'black@0'
    RGB = 'gbrap' if A else 'gbrp'

    def inp(c, dur):  # (see ss() for where a video input starts)
        if c['kind'] == 'image':
            ins.append(['-loop', '1', '-framerate', f'{F:g}', '-t', f'{dur:.6f}', '-i', c['path']])
        else:  # input seek: each clip decodes only its own range
            # VideoToolbox inputs get ONE ffmpeg thread: the media engine decodes, and ffmpeg's default frame threads only held
            # frames (a 4K60 input: 478 MB -> 137 MB, same speed). 4K on a smaller Mac decodes there too; the cores filter.
            dec = (['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate', '-display_rotation', '0', '-threads', '1'] if c.get('hdr')
                   else ['-c:v', 'libvpx-vp9'] if c.get('alpha')  # native vp9 decoder drops the alpha plane
                   else ['-hwaccel', 'videotoolbox', '-threads', '1'] if c['kind'] == 'video' and (c.get('heavy') and not BIG_MAC or p.get('light'))  # Light export: the media engine decodes, the cores stay free
                   else [])
            ins.append([*dec, '-ss', f"{ss(c):.6f}", '-t', f"{c['out'] - ss(c):.6f}", '-i', c['path']])
        return len(ins) - 1

    def ss(c):  # an in point between two source frames starts on the earlier one, the frame the preview shows there (from
        # the in point itself, ffmpeg began one frame later: 14 of 15 cuts in a real edit); the sound still starts at the in point
        f = c.get('sfps') or 0
        return math.floor(c['in'] * f + 1e-6) / f if f and c['kind'] != 'image' else c['in']

    def video(i, c, n):  # tone-mapped, retimed, exactly n frames, cropped, flipped, adjusted, graded
        sp = 1 if c['kind'] == 'image' else c['speed']
        v = f'[{i}:v]'
        if c.get('untagged_hd'):  # what Chrome / QuickTime assume for untagged HD, and what the preview shows
            # the explicit scale makes the link take the new tags: without it, the RGB conversions ffmpeg inserts later
            # (looks, colour, keys, rotation) still read the frames as BT.601 and shift every colour a look touches
            v += 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,scale,'
        if c.get('hdr'):  # VideoToolbox HDR (HLG/PQ) -> SDR BT.709, or kept as 10-bit HDR; rotation by hand since autorotate can't touch hw frames
            v += 'hwdownload,format=p010le,format=yuv420p10le,' if hdr else VT_SDR
            v += {90: 'transpose=clock,', 180: 'hflip,vflip,', 270: 'transpose=cclock,'}.get(-c['rot'] % 360, '')
        # round=up: each output frame shows the last source frame at or before its time, as the preview's <video> does
        # (nearest put 59.94 fps footage in a 60 fps project one frame early for half of every 16.7 s)
        # timed from the in point itself (decoding began on the frame before it, see ss()): that frame sits just before 0,
        # and slot 0 shows it, as the preview does at the clip's start (also in slow motion, where timing from the earlier
        # frame would show the next source frame a step early)
        lead = c['in'] - ss(c)
        pts = f'(PTS-STARTPTS-{lead:.6f}/TB)/{sp:.6f}' if lead > 1e-6 else f'(PTS-STARTPTS)/{sp:.6f}'
        v += f"setpts={pts},fps={F:g}:round=up" + (',trim=start=0,setpts=PTS-STARTPTS' if lead > 1e-6 else '') + f",tpad=stop_mode=clone:stop_duration=2,trim=end_frame={n}"
        cr = c.get('crop') or {}
        if any(cr.values()):
            v += (f",crop=w='trunc(iw*{1 - cr['l'] - cr['r']:.5f}/2)*2':h='trunc(ih*{1 - cr['t'] - cr['b']:.5f}/2)*2'"
                  f":x='iw*{cr['l']:.5f}':y='ih*{cr['t']:.5f}'")
        if c.get('flip'):
            v += ',hflip'
        col = adjust(c) + tone(c) + look(c) + grade(c)
        if col and c.get('lkf'):  # filter strength keyframes: the original and the graded picture mixed by the curve
            tag = f'lk{next(AFX_N)}'
            v += f",format=gbrp,split[{tag}a][{tag}b];[{tag}b]{col[1:]},format=gbrp[{tag}g];[{tag}a][{tag}g]blend=all_expr='A+(B-A)*({pw(c['lkf'], 'v', 'T')})'"
        else:
            v += col
        if c.get('beauty'):  # smooth skin: luma bilateral, mixed in where the colour is skin's (chromakey's distance), by strength
            t, b = f'bt{next(AFX_N)}', c['beauty']
            v += (f",format=yuv444p,split[{t}o][{t}b];[{t}b]bilateral=sigmaS={b['sigma']:.3f}:sigmaR=0.1[{t}s];"
                  f"[{t}o]format=yuva444p,chromakey=color=0xC89682:similarity=0.10:blend=0.12,lut=a='255-(255-val)*{b['amt']:.4f}'[{t}k];[{t}s][{t}k]overlay=format=yuv444")
        if c.get('blur'):  # the clip's own blur: boxblur, 3 passes (a Gaussian), radius in source pixels
            v += f",boxblur=luma_radius={c['blur']}:luma_power=3:chroma_radius={c['blur']}:chroma_power=3"
        if sp := c.get('sharp'):  # sharpen: ffmpeg unsharp on R, G and B alike (the preview's fxGPU mode 8: this kernel at its own scale); alpha untouched
            n = 2 * sp['r'] + 1
            v += f",format={'gbrap' if c.get('alpha') or c.get('trans') else 'gbrp'},unsharp={n}:{n}:{sp['amt']:.4f}:{n}:{n}:{sp['amt']:.4f}"
        if c.get('pix'):  # mosaic: block averages from the top-left corner (the preview's pixelInPlace)
            v += f",format=gbrp,pixelize=width={c['pix']}:height={c['pix']}"
        if c.get('key'):  # chroma key -> alpha (same formula as the preview's keyed())
            v += f",format=rgba,colorkey=color={c['key']['color'].replace('#', '0x')}:similarity={c['key']['sim']:.4f}:blend={c['key']['blend']:.4f}"
        if c.get('mb'):  # motion blur: each output frame the plain mean of it and the mb-1 before it (the preview mixes the same frames)
            v += f",tmix=frames={c['mb']}:weights='{' '.join(['1'] * c['mb'])}'"
        return v

    def audio(i, c, dur, delay=0.0, joins=(False, False)):
        live = c['hasAudio'] and c['kind'] != 'image' and (c['volume'] > 0 or c.get('vkf'))
        # envelope (ducking, volume points) evaluated every 64 samples: per 1024-sample frame it was a staircase of 4 dB steps
        vol = f"asetnsamples=n=64:p=0,volume='{c['volume']:.4f}*({pw(c['vkf'], 'v')})':eval=frame" if c.get('vkf') else f"volume={c['volume']:.3f}"
        tempo = f"aresample=48000,asetrate={48000 * c['speed']:.3f},aresample=48000" if c.get('pitch') and c['speed'] != 1 else atempo(c['speed'])
        lead = c['in'] - ss(c)
        if live and c.get('dn'):  # Reduce noise: its own input, the denoised PCM (raw samples: the seek is exact)
            ins.append(['-f', 's16le', '-ar', '48000', '-ac', '2', '-ss', f"{ss(c):.6f}", '-t', f"{c['out'] - ss(c):.6f}", '-i', c['dn']])
            i = len(ins) - 1
        a = f"[{i}:a]" + (f'atrim=start={lead:.6f},' if lead > 1e-6 else '') + f"asetpts=PTS-STARTPTS,{tempo}" + afx(c.get('au'), next(AFX_N)) + f',{vol}' if live else 'anullsrc=r=48000:cl=stereo'
        a += f',aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={dur:.6f},atrim=end={dur:.6f}'
        # 3 ms in and out at a hard edge (a cut from one sample value to another, or to silence, clicks), as the preview
        # does; not where the clip carries on from the same file (a split), which plays straight through
        if c['fadeIn']:
            a += f",afade=t=in:d={c['fadeIn']:.3f}"
        elif live and not joins[0]:
            a += ',afade=t=in:d=0.003:curve=hsin'
        if c['fadeOut']:
            a += f",afade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}"
        elif live and not joins[1]:  # ending where the sound itself ends: a clip a part of a frame shorter than its frames was padded with silence after a hard stop
            end = min(dur, (c['out'] - c['in']) / c['speed'])
            a += f",afade=t=out:st={max(0, end - 0.003):.6f}:d=0.003:curve=hsin"
        if delay:
            a += f',adelay={round(delay * 1000)}:all=1'
        return a

    def grade(c, fmt=',format=rgb24,'):  # the UI's grade table as a .cube for lut3d (trilinear, like the preview's 3D texture)
        if not c.get('grade'):
            return ''
        a = array('H')
        a.frombytes(c['grade'])
        if sys.byteorder != 'little':
            a.byteswap()
        f = Path(td) / f'grade{len(list(Path(td).glob("grade*.cube")))}.cube'
        f.write_text('LUT_3D_SIZE 33\n' + ''.join(f'{a[i] / 65535:.6f} {a[i + 1] / 65535:.6f} {a[i + 2] / 65535:.6f}\n' for i in range(0, len(a), 3)))
        return f"{fmt}lut3d=file='{f}':interp=trilinear"

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

    def glowed(v, c):  # a cutout's glow / neon outline: its alpha blurred and coloured, under it (canvas shadowBlur in the preview)
        if not c.get('glow'):
            return v
        t, g = f'gl{next(AFX_N)}', c['glow']
        return v + (f",format=rgba,split=3[{t}c][{t}a][{t}f];[{t}f]drawbox=x=0:y=0:w=iw:h=ih:color={g['color'].replace('#', '0x')}:t=fill[{t}fc];"
                    f"[{t}a]alphaextract,gblur=sigma={g['sigma']:.3f},lut=y='min(255,val*{g['gain']:.3f})'[{t}ga];[{t}fc][{t}ga]alphamerge[{t}g];[{t}g][{t}c]overlay=format=auto")

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
        if not c.get('mask') and not c.get('mask_seq'):
            return v
        if c.get('mask_seq'):  # keyframed: the browser's frames as runs, played by the concat demuxer, one per output frame
            ms, lines = c['mask_seq'], ['ffconcat version 1.0']
            for q, png in enumerate(ms['pngs']):
                (Path(td) / f'mask_{tag}_{q}.png').write_bytes(png)
            for sp in ms['spans']:
                lines += [f"file 'mask_{tag}_{sp['i']}.png'", f"duration {sp['n'] / F:.6f}"]
            lines.append(f"file 'mask_{tag}_{ms['spans'][-1]['i']}.png'")
            lf = Path(td) / f'mask_{tag}.ffconcat'
            lf.write_text('\n'.join(lines) + '\n')
            ins.append(['-f', 'concat', '-safe', '0', '-i', str(lf)])
            msrc = f'[{len(ins) - 1}:v]fps={F:g},format=gray'
        else:
            f = Path(td) / f'mask_{tag}.png'
            f.write_bytes(c['mask'])
            ins.append(['-loop', '1', '-framerate', f'{F:g}', '-t', f'{dur:.6f}', '-i', str(f)])
            msrc = f'[{len(ins) - 1}:v]format=gray'
        # the mask (made at most 1280 px, or 720 for keyframed ones) scaled to the clip with scale's reference input:
        # scale2ref=w=main_w:h=main_h leaves it at its own size in ffmpeg 9, and alphamerge then fails on any clip
        # whose cropped size isn't the PNG's (every source over 1280 px)
        if c.get('key'):  # key alpha x mask (alphamerge alone would throw the key's alpha away)
            return v + (f',format=rgba,split=3[{tag}c][{tag}k][{tag}r];[{tag}k]alphaextract[{tag}a];{msrc}[{tag}m];'
                        f'[{tag}m][{tag}r]scale=w=rw:h=rh[{tag}ms];[{tag}a][{tag}ms]blend=all_mode=multiply[{tag}am];'
                        f'[{tag}c][{tag}am]alphamerge')
        return v + (f',format=rgba,split[{tag}c][{tag}r];{msrc}[{tag}m];[{tag}m][{tag}r]scale=w=rw:h=rh[{tag}ms];'
                    f'[{tag}c][{tag}ms]alphamerge')

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

    def joined(a, b):  # b carries on a's sound: same file, speed and level, from where a stops, with no transition between
        return (all(a.get(x) == b.get(x) for x in ('path', 'speed', 'volume', 'au', 'pitch', 'denoise', 'studio')) and not a.get('vkf') and not b.get('vkf')
                and not overlap(a, b) and abs(a['in'] + a['frames'] / F * a['speed'] - b['in']) < 0.5 / F)

    ao = p.get('format') in SOUND  # sound only: no picture is built (a WAV of 30 s took 13 s and 139 CPU-s doing it)
    for k, c in enumerate(p['main']):  # magnetic main track -> one concat stream
        n = c['frames']
        dur = n / F
        i = inp(c, dur)
        snd = audio(i, c, dur, joins=(k > 0 and joined(p['main'][k - 1], c), k + 1 < len(p['main']) and joined(c, p['main'][k + 1]))) + f'[a{k}]'
        if ao:
            fg.append(snd)
            continue
        g = c['geom']
        x, y, w, h = even(g['x']), even(g['y']), max(2, even(g['w'])), max(2, even(g['h']))
        v, kf, rot = video(i, c, n), c.get('kf'), rotation(c)
        if c['fit'] == 'blur' or kf or rot or c.get('alpha') or c.get('trans') or c.get('key') or c.get('mask') or c.get('mask_seq') or c.get('vig') or c['opacity'] < 1:  # composite onto a base frame
            if c['fit'] == 'blur':
                v += (f',split=2[f{k}][b{k}];[b{k}]scale={even(W * 1.08)}:{even(H * 1.08)}:force_original_aspect_ratio=increase,crop={W}:{H},'  # 8% overscan, as the preview
                      f'boxblur={max(2, W // 40)}:3[bb{k}];[f{k}]null')
            else:
                v += f'[f{k}];color=c={BG}:s={W}x{H}:r={F:g}:d={dur:.6f}' + (',format=gbrap' if A else '') + f'[bb{k}];[f{k}]null'
            sc, px_, py_ = place(c, 't')
            v = masked(vignetted(v, c, f'mv{k}', dur), c, f'm{k}', dur) + rot + opacity(c, f'mop{k}', n) + sc + f'[ff{k}];[bb{k}][ff{k}]overlay=x={px_}:y={py_}:shortest=1:format=gbrp'
        else:
            cx, cy = max(0, -x), max(0, -y)
            cw, ch = min(w - cx, W - max(0, x)), min(h - cy, H - max(0, y))
            v += (',format=gbrap' if A else '') + (f',scale={w}:{h},crop={cw}:{ch}:{cx}:{cy},pad={W}:{H}:{max(0, x)}:{max(0, y)}:color={BG}' if cw >= 2 and ch >= 2
                  else f',scale={W}:{H},' + ('colorchannelmixer=aa=0' if A else f'drawbox=c={BG}:t=fill'))  # dragged fully off-canvas
        fa = ':alpha=1' if A else ''  # on a transparent background a fade fades to clear (the preview shows the checkerboard through it)
        if c['fadeIn']:
            v += f",fade=t=in:st=0:d={c['fadeIn']:.3f}{fa}"
        if c['fadeOut']:
            v += f",fade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}{fa}"
        # RGB like the canvas; xfade needs identical timebases on both inputs. The 4:2:0 path passes BT.709 video through as
        # is; anything else (SD BT.601, pictures) goes through RGB as on the RGB path: swscale's direct 601->709 was 2 levels off
        fg.append(v + (hdr_tail(c, hdr) if hdr else ('' if c.get('bt709') else ',format=gbrp') + ',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p' if yuv else f',format={RGB}')
                  + f',setsar=1,settb=AVTB[v{k}]')
        fg.append(snd)
    if p['main']:  # cuts concatenate; transitions overlap the two clips (xfade + acrossfade), like CapCut
        cv, ca, n = 'v0', 'a0', p['main'][0]['frames']
        for k in range(1, len(p['main'])):
            prev, c = p['main'][k - 1], p['main'][k]
            o = overlap(prev, c)
            if ao:
                fg.append(f'[{ca}][a{k}]acrossfade=d={o / F:.6f}[ma{k}]' if o else f'[{ca}][a{k}]concat=n=2:v=0:a=1[ma{k}]')
            elif o:
                tr, n0 = prev['tr'], n - o  # the overlap is main-stream frames n0 .. n-1; its frame i is at p = i/o
                if tr == 'custom':  # the overlap's frames of a over b, through geq (threaded, with lets), between the frames before and after
                    ex = ':'.join(f"{c}='" + re.sub(r'\bTO\b', str(o), prev['trx']['e' + c]) + "'" for c in 'rgb')
                    fg.append(f'[{cv}]split[ca{k}][cb{k}];[ca{k}]trim=end_frame={n0}[cp{k}];[cb{k}]trim=start_frame={n0},setpts=PTS-STARTPTS[oa{k}];'
                              f'[v{k}]split[va{k}][vb{k}];[va{k}]trim=end_frame={o},setpts=PTS-STARTPTS[ob{k}];[vb{k}]trim=start_frame={o},setpts=PTS-STARTPTS[cq{k}];'
                              f'[oa{k}][ob{k}]vstack,geq=interpolation=nearest:{ex},crop={W}:{H}:0:0[ov{k}];[cp{k}][ov{k}][cq{k}]concat=n=3:v=1:a=0[mv{k}]')
                else:
                    fg.append(f"[{cv}][v{k}]xfade=transition={TR_BLUR.get(tr, tr)}:duration={o / F:.6f}:offset={n0 / F:.6f}[mv{k}]")
                if tr == 'zoomblur':
                    zb = zoom_blur(f'zt{k}', f'{ZOOMB}*sin(PI*n/{o})', W, H)
                    fg.append(f'[mv{k}]split[zt{k}m][zt{k}c];[zt{k}c]trim=start_frame={n0}:end_frame={n},{zb}[zt{k}e];[zt{k}m][zt{k}e]overlay=eof_action=pass:format=gbrp[mb{k}]')
                elif tr in TR_BLUR:  # whips: a sideways (or up-down) blur per frame; blur dissolve: a 3-pass box blur
                    sw = lambda i: math.sin(math.pi * i / o)
                    one = (lambda i: f"boxblur={round(BLURF * H * sw(i))}:3:enable='eq(n,{n0 + i})'" if round(BLURF * H * sw(i)) >= 1 else '') if tr == 'blurfade' else \
                        (lambda i: f"gblur=sigma=0:sigmaV={WHIP * H * sw(i):.3f}:steps=3:enable='eq(n,{n0 + i})'") if tr in ('whipup', 'whipdown') else \
                        (lambda i: f"gblur=sigma={WHIP * W * sw(i):.3f}:sigmaV=0:steps=3:enable='eq(n,{n0 + i})'")
                    steps = [x for x in map(one, range(1, o)) if x]
                    fg.append(f'[mv{k}]' + ','.join(steps) + f'[mb{k}]' if steps else f'[mv{k}]null[mb{k}]')
                fg.append(f'[{ca}][a{k}]acrossfade=d={o / F:.6f}[ma{k}]')
            else:
                fg.append(f'[{cv}][{ca}][v{k}][a{k}]concat=n=2:v=1:a=1[mv{k}][ma{k}]')
            n += c['frames'] - o
            cv, ca = f"m{'b' if o and not ao and prev['tr'] in TR_BLUR else 'v'}{k}", f'ma{k}'
        if not ao:
            fg.append(f'[{cv}]null[vm]')
        fg.append(f'[{ca}]anull[am]')
        mix.append('[am]')

    if not ao and not yuv:
        fg.append(f'color=c={BG}:s={W}x{H}:r={F:g}:d={D:.6f},format={RGB}[L0]')
    cur = ['L0']
    if yuv:  # no base frame to lay the main track on: past its end (sound runs on) the background is padded on
        fg.append(f'[vm]tpad=stop_duration={D - n / F:.6f}:color={BG}[vp]' if D * F > n + 0.5 else '[vm]null[vp]')
        cur[0] = 'vp'

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

    if p['main'] and not ao and not yuv:
        over('vm')
    for k, c in enumerate(p['overlay']):
        n = c['frames']
        dur = n / F
        sound = c['kind'] == 'video' and c['hasAudio'] and c['volume'] > 0
        if ao and not sound:
            continue
        i = inp(c, dur)
        if sound:
            fg.append(audio(i, c, dur, c['start']) + f'[oa{k}]')
            mix.append(f'[oa{k}]')
        if ao:
            continue
        g, kf = c['geom'], c.get('kf')
        sc, ox, oy = place(c, f"(t-{c['start']:.6f})")
        v = glowed(masked(vignetted(video(i, c, n), c, f'ov{k}', dur), c, f'o{k}', dur), c) + rotation(c) + ('' if kf else sc) + ',format=rgba' + opacity(c, f'oop{k}', n)
        if c['fadeIn']:
            v += f",fade=t=in:st=0:d={c['fadeIn']:.3f}:alpha=1"
        if c['fadeOut']:
            v += f",fade=t=out:st={max(0, dur - c['fadeOut']):.3f}:d={c['fadeOut']:.3f}:alpha=1"
        if kf:  # size changes per frame: last step (see place())
            v += sc
        # shifted to its timeline start, on a whole output frame: the preview shows it from the first frame at or after its
        # start; a start between frames (91/30 s written as 3.033333) put every frame one off
        fg.append(v + f",setpts=PTS+round({math.ceil(c['start'] * F - 1e-6)}/({F:g}*TB))[o{k}]")
        if c.get('blend'):
            blended(f'o{k}', ox, oy, c['blend'])
        else:
            over(f'o{k}', ox, oy)
    for k, c in enumerate(p['audio']):
        dur = c['frames'] / F
        fg.append(audio(inp(c, dur), c, dur, c['start']) + f'[x{k}]')
        mix.append(f'[x{k}]')
    def frame_cmds(f, tag, target, vals):  # per-frame values -> sendcmd lines, only where they change (like opacity())
        lines, last = [], None
        for i in range(f['b'] - f['a']):
            v = vals(i)
            if v != last:
                lines.append(f"{max(0.0, (f['a'] + i - 0.5) / F):.6f} " + ', '.join(f'{target} {kk} {vv}' for kk, vv in v) + ';')
                last = v
        path = Path(td) / f'{tag}.cmd'
        path.write_text('\n'.join(lines) + '\n')
        return f"sendcmd=f='{path}',"

    for j, f in enumerate([] if ao else p.get('fx') or []):  # video effects, in order, on everything below the text layer
        op, tag, nxt = f['op'], f'fx{j}', f'X{j}'
        en = f"enable='between(n,{f['a']},{f['b'] - 1})'"  # frame numbers: exact, unlike times
        if op == 'zblur':  # only its own frames go through the copies (trim keeps their times), laid back over the rest
            zb = zoom_blur(tag, f"{f['s']:.4f}", W, H)
            fg.append(f"[{cur[0]}]split[{tag}a][{tag}b];[{tag}b]trim=start_frame={f['a']}:end_frame={f['b']},{zb}[{tag}e];"
                      f"[{tag}a][{tag}e]overlay=eof_action=pass:format=gbrp[{nxt}]")
        elif op in ('matrix', 'negate', 'blur', 'hblur', 'pixelize', 'rgbshift', 'lut', 'expr'):  # filters with timeline support: in place, on those frames only
            pre = ''
            if op == 'expr':  # nearest pixels, like the preview's texel fetches; LF = this frame's number since the effect began
                lf = f"(N-{f['a']})"
                body = 'geq=interpolation=nearest:' + ':'.join(c + "='" + re.sub(r'\bLF\b', lf, f['e' + c]) + "'" for c in 'rgb') + (":a='alpha(X,Y)'" if A else '') + ':'
            elif op == 'lut':  # adjustment layer: the composite (gbrp, lut3d takes it as is) through the table
                body = grade({'grade': f['lut']}, '') + ':'
            elif op == 'matrix':
                names, m, kk = ('rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'), f['m'], f['k']
                if isinstance(kk, list):
                    pre = frame_cmds(f, tag, f'colorchannelmixer@{tag}', lambda i: tuple((nm, round(v * kk[i], 4)) for nm, v in zip(names, m)))
                k0 = kk[0] if isinstance(kk, list) else kk
                body = f'colorchannelmixer@{tag}=' + ':'.join(f'{nm}={v * k0:.4f}' for nm, v in zip(names, m)) + ':'
            elif op == 'negate':
                body = 'negate='
            elif op == 'blur':
                body = f"gblur=sigma={f['sigma']:.3f}:"
            elif op == 'hblur':  # sideways only (motion blur)
                body = f"gblur=sigma={f['sigma']:.3f}:sigmaV=0:steps=3:"
            elif op == 'pixelize':
                body = f"pixelize=w={f['size']}:h={f['size']}:"
            else:
                rh, bh = f['rh'], f['bh']
                pick = lambda v, i: v[i] if isinstance(v, list) else v  # either one may move per frame
                if isinstance(rh, list) or isinstance(bh, list):
                    pre = frame_cmds(f, tag, f'rgbashift@{tag}', lambda i: (('rh', int(pick(rh, i))), ('bh', int(pick(bh, i)))))
                    rh, bh = pick(rh, 0), pick(bh, 0)
                body = f'rgbashift@{tag}=rh={int(rh)}:bh={int(bh)}:'
            fg.append(f'[{cur[0]}]{pre}{body}{en}[{nxt}]')
        else:  # a processed copy of the frame, shown over those frames
            x, y, ev = '0', '0', ''
            if op == 'noise':  # luma grain: noise on Y only
                body = f"format=yuv444p,noise=c0s={f['s']}:c0f=t,format=gbrp"
            elif op == 'mirror':
                body = f'crop=iw/2:ih:0:0,split[{tag}l][{tag}r];[{tag}r]hflip[{tag}f];[{tag}l][{tag}f]hstack'
            elif op == 'grid':
                body = (f'scale={W // 2}:{H // 2},split=4[{tag}1][{tag}2][{tag}3][{tag}4];[{tag}1][{tag}2]hstack[{tag}t];'
                        f'[{tag}3][{tag}4]hstack[{tag}u];[{tag}t][{tag}u]vstack')
            elif op == 'glow':  # screen a blurred copy over the frame, by amt (the canvas's 'screen' at that alpha)
                body = f"split[{tag}p][{tag}q];[{tag}q]gblur=sigma={f['sigma']:.3f}[{tag}g];[{tag}p][{tag}g]blend=all_expr='A+{f['amt']:.4f}*(B-A*B/255)'"
            else:  # transform: the frame zoomed by z about its centre and moved by x, y (export pixels), per frame
                vals = [f[q] if isinstance(f[q], list) else [f[q]] * (f['b'] - f['a']) for q in ('z', 'x', 'y')]
                kf = [{'t': (f['a'] + i) / F, 'z': z, 'x': dx, 'y': dy} for i, (z, dx, dy) in enumerate(zip(*vals))]
                body = f"scale=w='2*trunc({W}*({pw(kf, 'z')})/2)':h=-2:eval=frame"
                x, y, ev = f"'({W}-overlay_w)/2+({pw(kf, 'x')})'", f"'({H}-overlay_h)/2+({pw(kf, 'y')})'", ':eval=frame'
            fg.append(f'[{cur[0]}]split[{tag}a][{tag}b];[{tag}b]{body}[{tag}e];[{tag}a][{tag}e]overlay=x={x}:y={y}{ev}:format=gbrp:{en}[{nxt}]')
        cur[0] = nxt
    if p['frames'] and not ao:  # text layer: PNG per interval, played back as a VFR stream by the concat demuxer
        files = []
        for j, b in enumerate(p['pngs']):
            if isinstance(b, Path):  # uploaded (CACHE/layers)
                files.append(b)
                continue
            files.append(Path(td) / f't{j}.png')
            files[-1].write_bytes(b)
        lines, rate = ['ffconcat version 1.0'], {23.976: '24000/1001', 29.97: '30000/1001', 59.94: '60000/1001'}.get(round(F, 3), f'{F:g}')
        for fr in p['frames']:  # the project's frame rate as the time base: frame-exact spans stay exact (the default 25 fps rounds them)
            lines += [f"file '{files[fr['i']]}'", f'option framerate {rate}', f"duration {max(0.001, fr['end'] - fr['start']):.9f}"]
        lines += [f"file '{files[p['frames'][-1]['i']]}'", f'option framerate {rate}']  # concat demuxer ignores the last duration otherwise
        (Path(td) / 'text.ffconcat').write_text('\n'.join(lines) + '\n')
        ins.append(['-f', 'concat', '-safe', '0', '-i', str(Path(td) / 'text.ffconcat')])
        fg.append(f'[{len(ins) - 1}:v]format=rgba[tx]')
        over('tx', *p.get('box', (0, 0))[:2])  # a crop: everything outside its box is transparent in every frame
    fg.append(f'anullsrc=r=48000:cl=stereo,atrim=end={D:.6f}[sil]')
    # loudness (p['lufs']: -14 LUFS reels/YouTube, -16 podcast, -23 EBU broadcast): export() measures the whole mix first ('measure'), then sets ONE gain
    # in dB for all of it (two-pass, linear: single-pass loudnorm rode the gain and pumped up the quiet parts). Otherwise a
    # look-ahead limiter at -1 dBFS (it changes nothing below that): the sound effects at their default level, or music at
    # +6 dB, clipped the file
    lp = p.get('loud')
    loud = (',loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json' if lp == 'measure' else f',volume={lp:.3f}dB' if type(lp) is float
            else ',alimiter=limit=0.891:attack=1:release=50:level=false:latency=1')
    fg.append('[sil]' + ''.join(mix) + f'amix=inputs={len(mix) + 1}:duration=first:normalize=0:dropout_transition=0{loud}[aout]')
    fmt = p.get('format', 'mp4')
    if not ao and A and fmt == 'mp4':  # a chunk of a transparent export (ffmpeg_cmd intermediate): RGBA as it is
        fg.append(f'[{cur[0]}]format=gbrap[vout]')
    elif not ao and hdr:  # 10-bit HDR as it came (or as PQ): only the labels are set
        fg.append(f"[{cur[0]}]format={'yuv422p10le' if fmt == 'prores' else 'p010le' if fmt == 'hevc' else 'yuv420p10le'},setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc={HDR_TRC[hdr]}:range=tv[vout]")
    elif not ao:
        fg.append(f"[{cur[0]}]format={'rgba' if A else 'rgb24'}[vout]" if fmt in ('png', 'gif', 'pngseq') else  # stills and GIFs stay RGB: no 4:2:0 round trip
                  f"[{cur[0]}]scale=out_color_matrix=bt709:out_range=tv,format={OUT_PIX.get((fmt, bool(A)), 'yuv420p')},"
                  'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]')
    return sum(ins, []), ';'.join(fg)


FORMATS = {'mp4': '.mp4', 'hevc': '.mp4', 'av1': '.mp4', 'av1webm': '.webm', 'webm': '.webm', 'prores': '.mov', 'prores4444': '.mov', 'gif': '.gif', 'pngseq': '.zip',
           'mp3': '.mp3', 'wav': '.wav', 'm4a': '.m4a', 'png': '.png'}
SOUND = ('mp3', 'wav', 'm4a')  # sound-only formats: graph() builds no picture
EXPORT_FPS = (24, 25, 30, 50, 60, 120)  # an export frame rate apart from the project's (resampled at the end of the graph)
ALPHA_FORMATS = ('prores4444', 'webm', 'pngseq', 'gif', 'png')  # the ones that keep a transparent background
OUT_PIX = {('prores4444', True): 'yuva444p10le', ('prores4444', False): 'yuv444p10le', ('webm', True): 'yuva420p'}  # (format, alpha) -> encoder input
HDR_TRC = {'hlg': 'arib-std-b67', 'pq': 'smpte2084'}


def hlg_to_pq(r, g, b):
    """One HLG signal (BT.2100, non-linear R'G'B' 0-1) as PQ on the 1000-nit display HLG is mastered for (BT.2100 / BT.2408):
    inverse OETF -> scene light, OOTF (system gamma 1.2 on the luminance, black level 0) -> display light, PQ inverse EOTF.
    HLG 0.75 (reference white) -> 203 cd/m2 -> PQ 0.5806; HLG 1.0 -> 1000 cd/m2 -> PQ 0.7518."""
    a, b_, c = 0.17883277, 0.28466892, 0.55991073
    E = [x * x / 3 if x <= 0.5 else (math.exp((x - c) / a) + b_) / 12 for x in (max(0.0, min(1.0, v)) for v in (r, g, b))]
    Ys = 0.2627 * E[0] + 0.6780 * E[1] + 0.0593 * E[2]
    k = 1000 * Ys ** 0.2 if Ys > 0 else 0.0
    m1, m2, c1, c2, c3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
    return [((c1 + c2 * y ** m1) / (1 + c3 * y ** m1)) ** m2 for y in (k * e / 10000 for e in E)]


def hlg_pq_cube():
    """hlg_to_pq as a 65-point 3D table (lut3d, tetrahedral), made once into the cache."""
    f = CACHE / 'hlg_to_pq_65.cube'
    if not f.exists():
        n = 65
        rows = (hlg_to_pq(r / (n - 1), g / (n - 1), b / (n - 1)) for b in range(n) for g in range(n) for r in range(n))  # red fastest (.cube order)
        tmp = f.with_suffix('.part')
        tmp.write_text(f'LUT_3D_SIZE {n}\n' + ''.join(f'{x:.7f} {y:.7f} {z:.7f}\n' for x, y, z in rows))
        tmp.replace(f)
    return f


def hdr_tail(c, hdr):
    """The end of an HDR main clip's chain: nothing (its 10-bit YUV as it came), or HLG -> PQ through the table in 16-bit RGB."""
    if hdr != 'pq' or not c.get('hdr') or c.get('trc') != 'arib-std-b67':  # PQ footage, or a chunk already made PQ
        return ''
    return (f",scale=in_color_matrix=bt2020:in_range=tv,format=gbrp16le,lut3d=file='{hlg_pq_cube()}':interp=tetrahedral,"
            'scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le')


def h264_level(W, H, F):
    """The lowest H.264 level whose frame size and macroblock rate fit (1080p60 needs 4.2, 4K60 5.2)."""
    fs = math.ceil(W / 16) * math.ceil(H / 16)
    for lv, max_fs, max_mbps in (('4.1', 8192, 245760), ('4.2', 8704, 522240), ('5.1', 36864, 983040), ('5.2', 36864, 2073600)):
        if fs <= max_fs and fs * F <= max_mbps:
            return lv
    return '0'  # past 5.2 (8K): VideoToolbox's own choice (it lists nothing higher)


def ffmpeg_cmd(p, td, out, intermediate=False):
    ins, fg = graph(p, td)
    W, H, fmt = p['w'], p['h'], 'mp4' if intermediate else p.get('format', 'mp4')
    hdr, A = p.get('hdr'), p.get('alpha')
    vmap, amap = ['-map', '[vout]'], ['-map', '[aout]']
    F = p['fps'] if intermediate or fmt in ('gif', 'png', *SOUND) or not p.get('efps') else p['efps']
    if F != p['fps']:  # the export's own frame rate: output frame k shows the project frame at or before k/F (round=up), so 60 -> 120 doubles each frame
        fg += f";[vout]fps=fps={F:g}:round=up[vfps]"
        vmap = ['-map', '[vfps]']
    mb = p.get('mbps') or 0  # a custom bitrate (Mbps) replaces Standard / High / Very high
    br = f'{round(mb * 1000)}k' if mb else f"{max(2000, round(W * H * F * 0.2 * p.get('rate', 1) / 1000))}k"
    kb = lambda k, lo: br if mb else f'{max(lo, round(int(br[:-1]) * k))}k'  # the codecs that need fewer bits for the same look
    pf, cs = 'yuv420p', ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
    if hdr:
        cs = ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', HDR_TRC[hdr], '-color_range', 'tv']
    if intermediate:  # chunks of a long main track: near-lossless, 10-bit HDR or lossless with alpha where the final pass needs it
        enc = (['-c:v', 'ffv1', '-c:a', 'pcm_s16le'] if A else ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'pcm_s16le'])
        pf = 'gbrap' if A else 'yuv420p10le' if hdr else pf
    elif fmt == 'gif':  # one-graph palette: palettegen + paletteuse; 15 fps keeps files sane
        # at most 640 px across: a 1080p GIF of 30 s was ~60 MB and ffmpeg held 1.5 GB of frames for the palette.
        # Transparent: one palette entry is kept for clear pixels; alpha below half is clear (GIF has no partial alpha)
        fg += (f";[vout]fps={min(F, 15):g},scale='min(640,iw)':-2:flags=lanczos,split[g1][g2];[g1]palettegen=stats_mode=diff{':reserve_transparent=1' if A else ''}[gp];"
               f"[g2][gp]paletteuse=dither=bayer:bayer_scale=4{':alpha_threshold=128' if A else ''}[gout];[aout]anullsink")
        vmap, amap, enc = ['-map', '[gout]'], [], ['-loop', '0']
    elif fmt == 'pngseq':  # numbered PNGs (RGBA when transparent), zipped by export()
        fg += ';[aout]anullsink'
        amap, enc = [], ['-c:v', 'png', '-f', 'image2', '-start_number', '0']
        (Path(td) / 'seq').mkdir(exist_ok=True)
        out = Path(td) / 'seq' / 'frame_%06d.png'
    elif fmt == 'png':  # still frame at p['still']
        fg += ';[aout]anullsink'
        amap, enc = [], ['-ss', f"{p['still']:.6f}", '-frames:v', '1', '-update', '1']  # (ffmpeg takes the frame NEAREST to it: the frame's own time)
    elif fmt in SOUND:  # graph() built no picture
        vmap, enc = [], {'mp3': ['-c:a', 'libmp3lame', '-q:a', '2'], 'wav': ['-c:a', 'pcm_s16le'], 'm4a': ['-c:a', 'aac', '-b:a', '256k']}[fmt]
    elif fmt == 'prores':  # 422 HQ when HDR (10-bit, the HDR mastering format)
        enc, pf = ['-c:v', 'prores_ks', '-profile:v', '3' if hdr else '2', '-c:a', 'pcm_s16le'], 'yuv422p10le'
    elif fmt == 'prores4444':  # ProRes 4444 + 16-bit alpha: what Final Cut / Premiere / Resolve read as a transparent clip
        enc, pf = ['-c:v', 'prores_ks', '-profile:v', '4', '-alpha_bits', '16', '-vendor', 'apl0', '-c:a', 'pcm_s16le'], OUT_PIX[(fmt, bool(A))]
    elif fmt == 'hevc':  # "smaller": about half H.264's bitrate for the same look. HDR: Main 10
        enc = ['-c:v', 'hevc_videotoolbox', '-b:v', kb(0.55, 1200), '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '192k']
        if hdr:
            enc[2:2], pf = ['-profile:v', 'main10'], 'p010le'
    elif fmt in ('av1', 'av1webm'):  # SVT-AV1 preset 8, VBR to about HEVC's bitrate
        enc = ['-c:v', 'libsvtav1', '-preset', '8', '-b:v', f"{min(100000, int(kb(0.5, 1000)[:-1]))}k",  # (SVT-AV1 takes at most 100 Mbps)
               *(['-c:a', 'libopus', '-b:a', '160k'] if fmt == 'av1webm' else ['-c:a', 'aac', '-b:a', '192k'])]
    elif fmt == 'webm':  # VP9 + Opus: row-mt spreads one frame over the cores, cpu-used 4 = the usual speed / size trade. Transparent: VP9 alpha (alt-ref frames can't carry it)
        enc, pf = ['-c:v', 'libvpx-vp9', '-b:v', kb(0.6, 1200), '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', *(['-auto-alt-ref', '0'] if A else []),
                   '-c:a', 'libopus', '-b:a', '160k'], 'yuva420p' if A else 'yuv420p'
    elif p['quality'] == 'best' or max(W, H) > 4096:  # the media engine's H.264 stops at 4096 px (8K = error -12903): x264 there
        enc = ['-c:v', 'libx264', '-preset', 'medium' if p['quality'] == 'best' else 'veryfast', *(['-threads', '8'] if max(W, H) > 4096 else []),  # 8K: 12.5 -> 9.2 GB, 8 % slower
               *(['-crf', '18'] if p['quality'] == 'best' and not mb else ['-b:v', br]), '-c:a', 'aac', '-b:a', '192k']
    else:
        enc = ['-c:v', 'h264_videotoolbox', '-b:v', br, '-profile:v', 'high', '-level', h264_level(W, H, F), '-c:a', 'aac', '-b:a', '192k']
    video = fmt not in SOUND
    pix = ['-pix_fmt', pf] + (cs if pf != 'gbrap' else []) if video and fmt not in ('gif', 'png', 'pngseq') else []
    rate = ['-r', f'{F:g}', '-fps_mode', 'cfr'] if video and fmt not in ('gif', 'png') else []
    gf = Path(td) / f'graph{len(list(Path(td).glob("graph*.txt")))}.txt'
    gf.write_text(fg)
    return (['ffmpeg', '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *ins, '-/filter_complex', str(gf),
             *vmap, *amap, *enc, *pix, *rate] + ([] if fmt == 'png' else ['-t', f"{p['duration']:.6f}"])
            + (['-movflags', '+faststart'] if FORMATS[fmt] in ('.mp4', '.m4a') and not intermediate else []) + [str(out)])


def plain(what, err, code=0):
    """A tool's failure as one sentence for the UI: the cause in plain words and the clip by its name, no temp paths, hex
    or filter names (it showed raw ffmpeg stderr cut mid-word). The raw text goes to the server log."""
    print(f'{what} failed ({code}): {err[-1500:]}', file=sys.stderr, flush=True)

    def name(x):
        f = Path(x)
        if f.parent == MEDIA and ID.fullmatch(f.stem):
            try:
                return meta(f.stem).get('name') or f.name
            except (OSError, ValueError):
                pass
        return f.name
    files = [name(x) for x in re.findall(r"(/[^\s:'\"]+\.\w{2,5})\b", err) if not x.startswith(('/private/', '/var/folders/', '/tmp/'))]
    of, e = f' ({files[-1]})' if files else '', err.lower()
    if 'no space left' in e:
        why = 'the disk is full; free some space and try again'
    elif code in (-9, -15, 137, 143) or 'received signal' in e:
        why = 'it was stopped before it finished'
    elif 'no such file' in e or 'does not exist' in e:
        why = f'a file is missing{of}'
    elif any(k in e for k in ('moov atom not found', 'invalid data found', 'error while decoding', 'corrupt', 'truncat', 'end of file')):
        why = f'a file is damaged or incomplete{of}'
    elif 'permission denied' in e or 'not permitted' in e:
        why = f'macOS did not allow reading or writing a file{of}'
    else:
        last = next((x for x in reversed(err.strip().splitlines()) if x.strip()), '')
        last = re.sub(r'\[[^\]]*@[^\]]*\]|0x[0-9a-fA-F]+', '', re.sub(r"(/[^\s:'\"]+)", lambda m_: name(m_[1]), last))
        why = re.sub(r'\s+', ' ', last).strip(' :.!')[:160] or 'it stopped with an error'
    return f'{what} failed: {why}.'


PROCS = {}  # job id -> its running ffmpeg (Cancel kills it)


def run_ffmpeg(cmd, dur, report, what='Rendering', job=None):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors='replace')
    if job:
        PROCS[job] = proc
    err = []
    t = threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith('out_time_us=') and line[12:].strip().isdigit():
            report(min(1.0, int(line[12:]) / 1e6 / dur))
    t.join()
    PROCS.pop(job, None)
    if job and JOBS.get(job, {}).get('cancel'):
        raise RuntimeError('cancelled')
    if proc.wait():
        raise RuntimeError(plain(what, ''.join(err), proc.returncode))
    return ''.join(err)


def unique(path):
    n, base = 2, path
    while path.exists():
        path = base.with_name(f'{base.stem} ({n}){base.suffix}')
        n += 1
    return path


def still_cut(p):
    """A still frame needs only what is on screen then: a still at 178 s of a 90-clip project rendered all 90 clips first
    (173 s). The plan starts at the main clip under the earliest thing still showing at that frame; everything shifts
    back by that many whole frames (clip-relative timing - keyframes, fades, masks - is untouched)."""
    F, main = p['fps'], p['main']
    n = math.floor(p['still'] * F + 1e-6)  # the frame
    if n >= math.floor(p['duration'] * F + 1e-6):  # past the end: left as it is (it fails: no such frame)
        return p
    st, f0 = [], 0
    for k, c in enumerate(main):  # each main clip's first frame on the timeline
        st.append(f0)
        f0 += c['frames'] - (overlap(c, main[k + 1]) if k + 1 < len(main) else 0)
    ovs = [c for c in p['overlay'] if (a := math.ceil(c['start'] * F - 1e-6)) <= n < a + c['frames']]
    first = min([n] + [math.ceil(c['start'] * F - 1e-6) for c in ovs])
    k0 = next((k for k, c in enumerate(main) if st[k] + c['frames'] > first), len(main))
    keep = [c for k, c in enumerate(main) if k >= k0 and st[k] <= n]
    n0 = st[k0] if keep else first
    T0 = n0 / F
    fx = [{**f, 'a': f['a'] - n0, 'b': f['b'] - n0} for f in p.get('fx') or [] if f['a'] <= n < f['b']]
    spans = [{**fr, 'start': max(0.0, fr['start'] - T0), 'end': fr['end'] - T0} for fr in p.get('frames') or [] if fr['end'] > T0 + 1e-9]
    still = (n - n0) / F
    return {**p, 'main': keep, 'overlay': [{**c, 'start': c['start'] - T0} for c in ovs], 'audio': [], 'fx': fx, 'frames': spans if p.get('frames') else [],
            'still': still, 'duration': still + 2 / F}


LUFS = (-14, -16, -23)  # export loudness targets: social (reels, YouTube), podcast, EBU R128 broadcast


def loud_gain(p, td, job):
    """Loudness pass one: the mix alone through loudnorm's meter. One gain to the target (p['lufs']: -14 / -16 / -23 LUFS)
    for the whole edit, held down so the true peak stays at -1.5 dBTP (what loudnorm's linear mode does; past that it would
    ride the gain)."""
    cmd = ffmpeg_cmd({**p, 'format': 'wav', 'loud': 'measure'}, td, 'x')
    cmd[cmd.index('-loglevel') + 1] = 'info'  # loudnorm prints its numbers at info level
    err = run_ffmpeg(cmd[:-1] + ['-f', 'null', '-'], p['duration'], lambda _x: None, 'Measuring loudness', job)
    j = json.loads(err[err.rindex('{'):err.rindex('}') + 1])
    i, tp = float(j['input_i']), float(j['input_tp'])
    return 0.0 if not (math.isfinite(i) and math.isfinite(tp)) or i < -70 else round(min(p.get('lufs', -14) - i, -1.5 - tp), 3)  # silence: as it is


def export(job, p):
    st = JOBS[job]
    try:
        if p.get('format') == 'png' and not p.get('library'):
            p = still_cut(p)
        with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
            F, main = p['fps'], p['main']
            chunks = [main[i:i + CHUNK] for i in range(0, len(main), CHUNK)] if len(main) > CHUNK else []
            steps = len(chunks) + 1
            for n, part in enumerate(chunks):  # long main tracks: render chunks to near-lossless intermediates first
                if st.get('cancel'):
                    raise RuntimeError('cancelled')
                frames = sum(c['frames'] for c in part) - sum(overlap(a, b) for a, b in zip(part, part[1:]))
                sub = {**p, 'main': part, 'overlay': [], 'audio': [], 'frames': [], 'pngs': [], 'fx': [], 'duration': frames / F, 'format': 'mp4'}  # chunks: YUV video (10-bit HDR, or RGBA)
                f = Path(td) / f'chunk{n}.mkv'
                run_ffmpeg(ffmpeg_cmd(sub, td, f, True), frames / F, lambda x, n=n: st.update(progress=(n + x) / steps), 'The export', job)
                chunks[n] = {'path': str(f), 'kind': 'video', 'hasAudio': True, 'in': 0, 'out': frames / F, 'speed': 1, 'volume': 1,
                             'frames': frames, 'fadeIn': 0, 'fadeOut': 0, 'fit': 'fit', 'opacity': 1, 'adj': {'b': 1, 'c': 1, 's': 1},
                             'geom': {'x': 0, 'y': 0, 'w': p['w'], 'h': p['h']},
                             'bt709': True, 'tr': part[-1]['tr'], 'trf': part[-1]['trf'], 'trx': part[-1].get('trx')}  # a transition into the next chunk still happens in the final pass
            if chunks:
                p = {**p, 'main': chunks}
            if p.get('loud') is True and p.get('format') not in ('png', 'gif'):
                p = {**p, 'loud': loud_gain(p, td, job)}
            lib = p.get('library')  # a compound clip: rendered into the library, not the exports folder
            # rendered aside and moved in when complete: a failed or stopped export left an unplayable file under its name
            out = Path(td) / f"render{FORMATS[p.get('format', 'mp4')]}"
            run_ffmpeg(ffmpeg_cmd(p, td, out), p['duration'], lambda x: st.update(progress=(steps - 1 + x) / steps), 'The export', job)
            if p.get('format') == 'pngseq':  # the frames, stored (PNG is compressed already) in a folder named after the export
                with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
                    for f in sorted((Path(td) / 'seq').glob('*.png')):
                        z.write(f, f"{p['name']}/{f.name}")
            if not out.exists() or not out.stat().st_size:
                raise RuntimeError('ffmpeg finished without writing a file')
            if lib:
                stem = re.sub(r'[\\/:*?"<>|]', '', p['name'])[:80] or 'Compound'
                m = import_file(stem + out.suffix, None, 0, background=False, src=out)
                st.update(state='done', progress=1.0, media=m['id'])
                return
            dst = unique(EXPORTS / f"{p['name']}{out.suffix}")
            shutil.move(out, dst)
        st.update(state='done', progress=1.0, file=dst.name, **({'sdr': p['sdr']} if p.get('sdr') else {}))
    except Exception as e:  # surfaced to the UI (a cancelled one leaves nothing: it rendered in the temporary folder)
        if st.get('cancel'):
            st.update(state='cancelled')
        else:
            st.update(state='error', error=str(e))
    finally:
        if p.get('layer_dir'):  # the uploaded text layer (still_cut and the chunk plans keep the key)
            shutil.rmtree(p['layer_dir'], ignore_errors=True)


def has_file(mid):  # a library item whose file is there (not trashed or moved)
    try:
        return (MEDIA / meta(mid)['file']).is_file()
    except (OSError, ValueError, KeyError):
        return False


def list_projects():
    out = []
    for f in PROJ.glob('*.json'):
        try:
            j = json.loads(f.read_text())
        except ValueError:
            continue
        span = lambda c: c.get('dur') or (c.get('out', 0) - c.get('in', 0)) / (c.get('speed') or 1)
        dur = max([sum(span(c) for c in j.get('main', []))] + [c.get('start', 0) + span(c) for k in ('overlay', 'audio', 'text', 'captions') for c in j.get(k, [])])
        out.append({'id': f.stem, 'name': j.get('name', 'Untitled'), 'w': j.get('w'), 'h': j.get('h'), 'updated': f.stat().st_mtime, 'dur': round(dur, 2),
                    'clips': sum(len(j.get(k, [])) for k in ('main', 'overlay', 'audio', 'text', 'captions')),
                    'pic': (CACHE / f'poster_{f.stem}.jpg').exists() or any(has_file(c.get('media')) for c in j.get('main', []) + j.get('overlay', []))})  # it can have a poster (else the card asks and gets a 404)
    return sorted(out, key=lambda p: -p['updated'])


def poster(pid):
    """The projects screen's card picture: the editor's preview as you left the project (POST .../poster), else a frame a
    little into the first clip you'd see, 480 px wide, remade when the project changes. None when nothing visual is in it yet."""
    f = PROJ / f'{pid}.json'
    out = CACHE / f'poster_{pid}.jpg'
    if out.exists() and out.stat().st_mtime >= f.stat().st_mtime - 2:  # (the editor sends its poster and the last save together: either may land first)
        return out
    j = json.loads(f.read_text())
    for c in j.get('main', []) + j.get('overlay', []):
        try:
            m = meta(c['media'])
        except (OSError, ValueError, KeyError):
            continue
        if m.get('kind') not in ('video', 'image') or not (MEDIA / m['file']).is_file():
            continue
        prx = CACHE / f"{m['id']}.proxy.mp4"
        src = prx if prx.exists() else MEDIA / m['file']
        seek = [] if m['kind'] == 'image' else ['-ss', f"{c.get('in', 0) + min(1.0, (c.get('out', 0) - c.get('in', 0)) / 3):.3f}"]
        if sh(['ffmpeg', '-v', 'error', '-y', *seek, '-i', str(src), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', str(out)], low=True).returncode == 0 and out.exists():
            return out
    return None


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
        try:
            self.wfile.write(b)
        except (BrokenPipeError, ConnectionResetError):  # the page went away mid-answer (a reload during a long poll): a remote command is re-offered
            pass

    def file(self, path):
        fh = open(path, 'rb')  # opened before the headers: a file trashed or replaced meanwhile can't break an answer half-sent
        try:
            self._file(fh, path)
        finally:
            fh.close()

    def _file(self, fh, path):
        size = os.fstat(fh.fileno()).st_size
        start, end = 0, size - 1
        rng = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
        if rng and (rng[1] or rng[2]):  # <video> seeking needs byte ranges
            start, end = (int(rng[1]), int(rng[2] or end)) if rng[1] else (max(0, size - int(rng[2])), end)
            # at most RANGE_CAP per answer (a 206 may be shorter than asked; the player asks for the rest). WebKit asks for the
            # whole rest of the file at every seek and drops it at the next: scrubbing streamed hundreds of MB it threw away
            end = min(end, size - 1, start + RANGE_CAP - 1)
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
        fh.seek(start)
        left = end - start + 1
        while left > 0:
            b = fh.read(min(left, 1 << 20))
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
            if path == '/api/media':  # entries whose file is gone (an interrupted removal) are left out
                return self.reply(sorted(({**m, 'prep': PREP_PCT[m['id']]} if m['id'] in PREP_PCT and not m.get('ready') else m
                                          for m in (json.loads(f.read_text()) for f in MEDIA.glob('*.json')) if (MEDIA / m.get('file', '')).is_file()), key=lambda m: -m.get('added', 0)))
            if path == '/api/projects':
                return self.reply(list_projects())
            if path == '/api/voices':
                return self.reply(voices())
            if m := re.fullmatch(r'/api/projects/([a-f0-9]{12})', path):
                return self.file(PROJ / f'{m[1]}.json')
            if (m := re.fullmatch(r'/api/projects/([a-f0-9]{12})/poster\.jpg', path)) and (PROJ / f'{m[1]}.json').exists():
                if f := poster(m[1]):
                    return self.file(f)
                return self.reply({'error': 'nothing to show yet'}, 404)
            if m := re.fullmatch(r'/api/media/([a-f0-9]{12})/uses', path):  # the projects a library item is in (asked before removing it)
                out = []
                for f in PROJ.glob('*.json'):
                    t = f.read_text()
                    if m[1] in t:
                        try:
                            j = json.loads(t)
                        except ValueError:
                            continue
                        if any(m[1] in (c.get('media'), (c.get('ramp') or {}).get('src'), (c.get('rt') or {}).get('src')) for k in ('main', 'overlay', 'audio') for c in j.get(k, [])):  # a ramped clip can go back to its source
                            out.append({'id': f.stem, 'name': j.get('name', 'Untitled')})
                return self.reply(out)
            if m := re.fullmatch(r'/api/jobs/([a-f0-9]{12})', path):
                return self.reply(JOBS.get(m[1], {'state': 'missing'}))
            if m := re.fullmatch(r'/media/([a-f0-9]{12})', path):
                q, mm = parse_qs(urlparse(self.path).query), meta(m[1])
                if q.get('pcm') and mm.get('hasAudio'):
                    tempo = fnum(q['pcm'][0], 0.1, 100)
                    a, b = (int(fnum(q.get(k, ['0'])[0], 0, 1e7)) for k in ('a', 'b'))
                    if f := pcm(mm, tempo, a, b, dn=q.get('dn') == ['1'], fx=q.get('fx', [''])[0]):
                        return self.file(f)
                    return self.reply({'error': 'no sound in this file'}, 404)
                if 'hevc' in q.get('alpha', []) and mm.get('kind') == 'video' and (mm.get('alpha') or mm.get('trans')):
                    if mov := alpha_mov(mm):  # made at import; older library items get it on first request
                        return self.file(mov)
                if mm.get('kind') == 'image' and (q.get('thumb') or q.get('view')):
                    return self.file(photo_copy(mm, 320 if q.get('thumb') else 2560))
                if q.get('wk') and mm.get('kind') == 'video' and not (mm.get('alpha') or mm.get('trans')):
                    return self.file(wk_copy(mm))  # the app's preview: colour labels WebKit shows as decoded
                proxy = next((f for f in (CACHE / f'{m[1]}.proxy.mp4', CACHE / f'{m[1]}.proxy.webm') if f.exists()), None)
                return self.file(proxy or MEDIA / meta(m[1])['file'])
            if path == '/api/sfx':
                return self.reply([{'id': k, 'name': v[0], 'dur': v[1]} for k, v in SFX.items()])
            if path == '/api/packs':  # the sound and music library (installed: its rows; else what a download would bring)
                idx = packs_index()
                if idx:
                    return self.reply({'installed': True, 'items': idx['items'], 'skipped': idx.get('skipped', [])})
                src = json.loads(PACKS_SRC.read_text())
                return self.reply({'installed': False, 'mb': round(sum(x['size'] for x in src['sfx'] + src['music']) / 1e6), 'tracks': len(src['music']), 'packs': len(src['sfx'])})
            if path.startswith('/packs/'):
                root = (HOME / 'packs').resolve()
                f = (root / unquote(path[7:])).resolve()
                if f.is_relative_to(root) and f.is_file() and f.suffix in ('.wav', '.mp3'):
                    return self.file(f)
            if path == '/ir/hall.wav':  # the hall reverb's impulse response (the preview's ConvolverNode reads it)
                return self.file(hall_ir())
            if m := re.fullmatch(r'/sfx/([a-z]+)\.wav', path):
                return self.file(sfx_file(m[1]))
            if path == '/api/luts':  # imported .cube LUTs
                return self.reply(sorted((json.loads(f.read_text()) for f in (HOME / 'luts').glob('*.json')), key=lambda x: x.get('name', '').lower()))
            if m := re.fullmatch(r'/luts/([a-f0-9]{12})\.cube', path):
                return self.file(HOME / 'luts' / f'{m[1]}.cube')
            if path == '/api/fonts':  # imported fonts
                return self.reply(sorted((json.loads(f.read_text()) for f in (HOME / 'fonts').glob('*.json')), key=lambda x: x['family'].lower()))
            if path == '/api/fonts/system':  # the Mac's installed families (drawn by name; nothing to load)
                return self.reply(system_fonts())
            if m := re.fullmatch(r'/fonts/([a-f0-9]{12}\.(?:ttf|otf|woff2))', path):
                return self.file(HOME / 'fonts' / m[1])
            if path == '/api/templates':
                return self.reply(sorted((json.loads(f.read_text()) for f in (HOME / 'templates').glob('*.json')), key=lambda t: t.get('name', '')))
            if m := re.fullmatch(r'/cache/([a-f0-9]{12}\.(?:strip\.jpg|wave\.png|grid\.jpg|peaks))', path):
                return self.file(CACHE / m[1])
            if m := re.fullmatch(r'/cache/([a-f0-9]{12}\.aimask/\d{5}\.png)', path):  # AI mask frames
                return self.file(CACHE / m[1])
            if m := re.fullmatch(r'/exports/([^/]+\.(?:mp4|mov|webm|gif|mp3|wav|m4a|png|srt|vtt|txt))', path):
                return self.file(EXPORTS / m[1])
            f = (WEB / (path.lstrip('/') or 'index.html')).resolve()
            if WEB in f.parents and f.is_file():
                return self.file(f)
            self.reply({'error': 'not found'}, 404)
        except (FileNotFoundError, ValueError, KeyError):
            self.reply({'error': 'not found'}, 404)
        except Exception as e:  # an answer, not a dropped connection and a traceback in the log
            self.reply({'error': str(e)}, 500)

    def do_POST(self):
        if not self.allowed(True):
            return
        u = urlparse(self.path)
        try:
            if u.path == '/api/import':
                name = parse_qs(u.query).get('name', ['file'])[0]
                return self.reply(import_file(name, self.rfile, int(self.headers.get('Content-Length') or 0)))
            if u.path == '/api/fonts':  # the font file's bytes
                n = int(self.headers.get('Content-Length') or 0)
                if n > 32 << 20:
                    raise ValueError('font file too big (32 MB at most)')
                return self.reply(import_font(parse_qs(u.query).get('name', ['Font'])[0], self.rfile.read(n)))
            if m := re.fullmatch(r'/api/layer/([0-9a-f]{12})/(\d{1,6})', u.path):  # one text-layer PNG, raw: the export's layer workers upload them as they go
                n = int(self.headers.get('Content-Length') or 0)
                if n > 300 << 20:
                    raise ValueError('request too large')
                data = self.rfile.read(n)
                if not data.startswith(b'\x89PNG'):
                    raise ValueError('text layer must be PNG')
                d = CACHE / 'layers' / m[1]
                d.mkdir(parents=True, exist_ok=True)
                (d / f't{int(m[2])}.png').write_bytes(data)
                return self.reply({'ok': True})
            body = self.body()
            if u.path == '/api/transcribe':
                return self.reply({'words': transcribe(body['media'], body.get('lang', 'auto'), (body.get('ranges') or [])[:500])})
            if u.path == '/api/transcribe/progress':  # how far whisper is on that file (null: not listening)
                return self.reply({'p': TX_PCT.get(body.get('media'))})
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
                p = still_cut(clean_plan({**body, 'format': 'png'}))  # only what is on screen at that frame
                try:
                    with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
                        out = Path(td) / 'frame.png'
                        run_ffmpeg(ffmpeg_cmd(p, td, out), p['duration'], lambda _x: None)
                        if not out.exists():
                            raise RuntimeError('no frame rendered')
                        return self.reply({'image': base64.b64encode(out.read_bytes()).decode()})
                finally:
                    if p.get('layer_dir'):
                        shutil.rmtree(p['layer_dir'], ignore_errors=True)
            if u.path == '/api/luts':  # import a .cube LUT (its text): kept in Movies/Cutroom/luts for every project
                text, name = str(body.get('text', '')), str(body.get('name') or 'LUT')
                if len(text) > 64 << 20 or not re.search(r'^\s*LUT_(3D|1D)_SIZE\s+\d+', text, re.M):
                    raise ValueError('not a .cube LUT (no LUT_3D_SIZE / LUT_1D_SIZE line)')
                (HOME / 'luts').mkdir(parents=True, exist_ok=True)
                lid = uuid.uuid4().hex[:12]
                (HOME / 'luts' / f'{lid}.cube').write_text(text)
                info = {'id': lid, 'name': re.sub(r'\.cube$', '', Path(name).name, flags=re.I)[:80] or 'LUT'}
                (HOME / 'luts' / f'{lid}.json').write_text(json.dumps(info))
                return self.reply(info)
            if m := re.fullmatch(r'/api/luts/([a-f0-9]{12})/trash', u.path):  # reversible: to trash/luts
                (HOME / 'trash' / 'luts').mkdir(parents=True, exist_ok=True)
                for f in (HOME / 'luts' / f'{m[1]}.cube', HOME / 'luts' / f'{m[1]}.json'):
                    if f.exists():
                        shutil.move(str(f), str(unique(HOME / 'trash' / 'luts' / f.name)))
                return self.reply({'ok': True})
            if (m := re.fullmatch(r'/api/projects/([a-f0-9]{12})/poster', u.path)) and (PROJ / f'{m[1]}.json').exists():  # the editor's preview as a JPEG, sent when you leave the project
                jpg = base64.b64decode(str(body.get('jpg', '')), validate=True)
                if not jpg.startswith(b'\xff\xd8') or len(jpg) > 4 << 20:
                    raise ValueError('not a JPEG')
                CACHE.mkdir(parents=True, exist_ok=True)
                tmp = CACHE / f'.poster_{m[1]}.{uuid.uuid4().hex[:8]}.tmp'  # (two leaves at once each write their own)
                tmp.write_bytes(jpg)
                tmp.replace(CACHE / f'poster_{m[1]}.jpg')
                return self.reply({'ok': True})
            if u.path == '/api/save_subs':  # subtitles (SRT / WebVTT / timed TXT made by the editor) into the exports folder
                text = str(body.get('text', ''))
                if not text.strip() or len(text) > 20 << 20:
                    raise ValueError('nothing to save')
                stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '', str(body.get('name') or 'subtitles')).strip(' .')[:120] or 'subtitles'
                EXPORTS.mkdir(parents=True, exist_ok=True)
                f = unique(EXPORTS / f"{stem}.{body.get('ext') if body.get('ext') in ('vtt', 'txt') else 'srt'}")
                f.write_text(text, encoding='utf-8')
                return self.reply({'file': f.name})
            if u.path == '/api/sfx/add':  # a sound effect into the library (made on first use)
                return self.reply(sfx_media(str(body.get('id', ''))))
            if u.path == '/api/packs/add':  # a pack sound or track into the media library
                return self.reply(pack_media(str(body.get('id', ''))))
            if u.path == '/api/packs/install':
                return self.reply({'job': run_job(install_packs)})
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
                return self.reply(import_file(f.name, None, 0, src=f))
            if u.path == '/api/ai/music':
                return self.reply({'job': run_job(ai_music, body.get('prompt', ''), body.get('dur', 20), body.get('seed'))})
            if u.path == '/api/ai/voice':
                return self.reply({'job': run_job(ai_voice, body.get('text', ''), body.get('voice', 'af_heart'), body.get('speed', 1))})
            if u.path == '/api/ai/video':
                return self.reply({'job': run_job(ai_video, str(body.get('image', '')), body.get('prompt', ''), body.get('ratio', '9:16'), body.get('quality', 'fast'), body.get('seed'))})
            if u.path == '/api/ai/image':
                return self.reply({'job': run_job(ai_image, body.get('prompt', ''), body.get('w', 1024), body.get('h', 1024), body.get('seed'),
                                                  body.get('steps', 8), bool(body.get('sticker')))})
            if u.path == '/api/lift':
                return self.reply(lift(body['media']))
            if u.path == '/api/sound_prep':  # a clip's processed sound made before the clip uses it (Studio voice, characters): a job
                return self.reply({'job': run_job(sound_prep, body['media'], str(body.get('fx', '')))})
            if u.path == '/api/isolate':
                return self.reply({'job': run_job(isolate, body['media'], body.get('keep', 'voice'))})
            if u.path == '/api/retouch':
                return self.reply({'job': run_job(retouch, body['media'], body.get('t0', 0), body.get('t1', 0), body.get('p'))})
            if u.path == '/api/retouch_preview':
                return self.reply(retouch_preview(body['media'], body.get('t', 0), body.get('p')))
            if u.path == '/api/mask_preview':  # one frame's SAM 2 outline, a second or two: shown before Best removal runs
                return self.reply(mask_preview(body['media'], body.get('t', 0), body.get('box'), body.get('points'), body.get('mode', 'remove')))
            if u.path == '/api/remove_object':
                return self.reply({'job': run_job(remove_object, body['media'], body.get('t', 0), body.get('t0', 0), body.get('t1', 0), body.get('box'),
                                                  body.get('quality', 'best'), body.get('mode') if body.get('mode') in ('cutout', 'mask') else 'remove', body.get('seed'))})
            if u.path == '/api/ai/combine':
                return self.reply({'job': run_job(combine, body.get('media') or [], body.get('target', 0), body.get('style', 'balanced'),
                                                  body.get('order', 'auto'), body.get('music'), bool(body.get('sound')))})
            if u.path == '/api/ai/highlights':
                return self.reply({'job': run_job(highlights, body['media'], body.get('lang', 'auto'), body.get('count', 3), body.get('min', 15), body.get('max', 45))})
            if u.path == '/api/ai/translate':
                return self.reply({'job': run_job(translate, body.get('texts') or [], body.get('to', ''))})
            if u.path == '/api/ai/capmarks':
                return self.reply({'job': run_job(cap_marks, body.get('texts') or [], body.get('kind', 'keywords'))})
            if u.path == '/api/ai/speakers':
                return self.reply({'job': run_job(speakers, body.get('items') or [], body.get('speakers', 0))})
            if u.path == '/api/ai/hooks':
                return self.reply({'job': run_job(hooks, body.get('ranges') or [], body.get('lang', 'auto'))})
            if u.path == '/api/plan':  # the command bar: an instruction + the project in brief -> checked steps
                return self.reply(pilot_plan(body.get('text', ''), body.get('ctx') or {}))
            if u.path == '/api/index':  # smart search: describe these library items (job; cached per item)
                return self.reply({'job': run_job(index_many, body.get('media') or [])})
            if u.path == '/api/search':
                return self.reply(search(body.get('q', ''), set(map(str, body['media'])) if body.get('media') else None))
            if u.path == '/api/transcript':  # timestamped sentences (the MCP transcript tool)
                return self.reply({'sentences': sentences(transcribe(body['media'], body.get('lang', 'auto')))})
            if u.path == '/api/fillers':
                return self.reply({'fillers': fillers(body['media'], body.get('lang', 'auto'), (body.get('ranges') or [])[:500])})
            if u.path == '/api/sync':
                return self.reply(sync_media([str(x) for x in body.get('media') or []]))
            if u.path == '/api/scenes':
                return self.reply({'times': scenes(body['media'], fnum(body.get('thr', 0.3), 0.05, 0.9))})
            if u.path == '/api/silences':
                return self.reply({'silences': silences(body['media'], fnum(body.get('noise', -35), -90, 0), fnum(body.get('min', 0.5), 0.05, 30))})
            if u.path == '/api/speech':
                return self.reply({'speech': speech(body['media'])})
            if m := re.fullmatch(r'/api/jobs/([a-f0-9]{12})/cancel', u.path):  # an export: its ffmpeg killed at once (TERM left it running 45 s)
                if m[1] in JOBS:
                    JOBS[m[1]]['cancel'] = True
                    if pr := PROCS.get(m[1]):
                        pr.kill()
                return self.reply({'ok': True})
            if u.path == '/api/export':
                p, job = clean_plan(body), uuid.uuid4().hex[:12]
                JOBS[job] = {'state': 'running', 'progress': 0.0}
                threading.Thread(target=export, args=(job, p), daemon=True).start()
                return self.reply({'job': job})
            if u.path == '/api/matte':
                return self.reply({'job': run_job(matte, body['media'], *([fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6)] if body.get('t1') else []))})
            if u.path == '/api/denoise':
                return self.reply({'job': run_job(denoise, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), 'strong' if body.get('strength') == 'strong' else 'light')})
            if u.path in ('/api/reverse', '/api/stabilize'):
                return self.reply({'job': run_job(reverse if u.path == '/api/reverse' else stabilize, body['media'])})
            if u.path == '/api/faces':
                mode = body.get('mode') if body.get('mode') in ('largest', 'all', 'subject') else 'largest'
                return self.reply({'job': run_job(faces, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), mode, int(fnum(body.get('rate', 5), 1, 60)))})
            if u.path == '/api/track':
                b = body.get('box') or {}
                box = {k: fnum(b.get(k), 0, 1) for k in 'xywh'}
                return self.reply({'job': run_job(follow, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), box,
                                                  fnum(body['t'], 0, 1e6) if body.get('t') is not None else None)})
            if u.path == '/api/beats':
                return self.reply(beats(body['media']))
            if u.path == '/api/still':
                return self.reply(still(body['media'], fnum(body.get('t', 0), 0, 1e6)))
            if u.path == '/api/tts':
                return self.reply(tts(body.get('text', ''), body.get('voice', 'Samantha'), body.get('rate', 185)))
            if m := re.fullmatch(r'/api/media/([a-f0-9]{12})/trash', u.path):  # reversible: file + metadata move to trash/media
                info = meta(m[1])
                (HOME / 'trash' / 'media').mkdir(parents=True, exist_ok=True)
                for f in (MEDIA / info['file'], MEDIA / f'{m[1]}.json', CACHE / f'{m[1]}.wk.mov'):
                    if f.exists():
                        shutil.move(str(f), str(unique(HOME / 'trash' / 'media' / f.name)))
                for f in CACHE.glob(f'{m[1]}*.pcm'):  # the preview's sound is remade from the file if it's restored
                    f.unlink(missing_ok=True)
                return self.reply({'ok': True})
            if m := re.fullmatch(r'/api/media/([a-f0-9]{12})/restore', u.path):  # undo a library removal: file + metadata back from trash/media
                tr = HOME / 'trash' / 'media'
                js = sorted(tr.glob(f'{m[1]}*.json'), key=lambda f: f.stat().st_mtime)
                if not js or (MEDIA / f'{m[1]}.json').exists():
                    raise ValueError('not in the trash' if not js else 'already in the library')
                info = json.loads(js[-1].read_text())
                src = next((f for f in sorted(tr.glob(f'{Path(info["file"]).stem}*{Path(info["file"]).suffix}'), key=lambda f: -f.stat().st_mtime) if f.suffix != '.json'), None)
                if not src:
                    raise ValueError('its file is not in the trash')
                shutil.move(str(src), str(MEDIA / info['file']))
                shutil.move(str(js[-1]), str(MEDIA / f'{m[1]}.json'))
                return self.reply({'ok': True, 'id': m[1]})
            if u.path == '/api/ramp':  # the knot table is checked here: it goes into an ffmpeg expression
                t0, t1, fps, mp = fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), fnum(body['fps'], 1, 120), body['map']
                if not (0 < t1 - t0 <= 600) or not isinstance(mp, list) or not 2 <= len(mp) <= 1024 or not all(isinstance(q, list) and len(q) == 2 for q in mp):
                    raise ValueError('a ramp needs 0-600 s of the clip and 2-1024 knots')
                mp = [[fnum(s, 0, 1e6), fnum(t, 0, 1e6)] for s, t in mp]
                if mp[0] != [0, 0] or abs(mp[-1][0] - (t1 - t0)) > 1e-3 or any(b[0] <= a[0] or b[1] <= a[1] for a, b in zip(mp, mp[1:])):
                    raise ValueError('the ramp knots must start at 0, 0, rise in both columns and end at the range length')
                return self.reply({'job': run_job(ramp_copy, body['media'], t0, t1, mp, fps)})
            if u.path == '/api/slowmo':
                return self.reply({'job': run_job(slowmo, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), int(fnum(body.get('factor', 4), 2, 8)),
                                                  'ai' if body.get('engine') == 'ai' else 'fast')})
            if u.path == '/api/deflicker':
                return self.reply({'job': run_job(deflicker, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6))})
            if u.path == '/api/upscale':
                return self.reply({'job': run_job(enhance, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), 'upscale', {'scale': 4 if body.get('scale') == 4 else 2})})
            if u.path == '/api/relight':
                return self.reply({'job': run_job(enhance, body['media'], fnum(body['t0'], 0, 1e6), fnum(body['t1'], 0, 1e6), 'relight', {'light': light_opts(body.get('light'))})})
            if u.path == '/api/relight_preview':
                return self.reply(relight_preview(body['media'], body.get('t', 0), light_opts(body.get('light'))))
            if m := re.fullmatch(r'/api/(projects|templates)/([a-f0-9]{12})/trash', u.path):  # reversible: moved, not deleted
                f = (PROJ if m[1] == 'projects' else HOME / 'templates') / f'{m[2]}.json'
                if f.exists():
                    (HOME / 'trash').mkdir(exist_ok=True)
                    shutil.move(str(f), str(unique(HOME / 'trash' / f.name)))
                return self.reply({'ok': True})
            if u.path == '/api/reveal':  # Show in Finder, or play: open it in the Mac's default player (QuickTime)
                f = EXPORTS / Path(str(body.get('file', ''))).name
                if f.is_file():
                    subprocess.Popen(['open', str(f)] if body.get('play') else ['open', '-R', str(f)])
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
            if m[1] == 'projects' and not (folder / f'{m[2]}.json').exists() and next((HOME / 'trash').glob(f'{m[2]}*.json'), None):
                return self.reply({'ok': True, 'trashed': True})  # a save still on its way for a project just put in the trash: it stays there
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
    # sound processing keys (noise step first, one character last) and pack names; tests/audio_packs.mjs checks the sound
    assert fx_ok('') and fx_ok('dn') and fx_ok('svm') and fx_ok('sv+elf') and fx_ok('cave') and fx_ok('dn+underwater')
    assert not (fx_ok('elf+sv') or fx_ok('dn+sv') or fx_ok('elf+cave') or fx_ok('sv+sv') or fx_ok('x') or fx_ok('dn+'))
    assert clip_fx({'studio': True, 'denoise': True, 'au': {'voice': 'giant'}}, {'hasAudio': True}) == 'sv+giant'
    assert clip_fx({'au': {'voice': 'robot'}}, {'hasAudio': True}) == '' and pack_name('impactWood_medium_003') == 'Impact wood medium 3'
    # language-model features with a stub model: picks snap to sentence edges, padding stops halfway into a pause,
    # overlapping / malformed picks are dropped, two-clause titles keep the first clause, translations keep the line count
    # command bar: 'each' never multiplies steps the model listed itself, nor overrides a clip or time the user named
    pc = {'main': [{'id': 'a1', 'kind': 'video'}, {'id': 'a2', 'kind': 'video'}], 'cuts': [3.0]}
    run = lambda *st: [(x['tool'], x['args'].get('id', x['args'].get('at'))) for x in pilot_check({'steps': list(st)}, pc, 'x')[0]]
    assert run(*({'tool': 'auto_reframe', 'args': {'id': i}, 'each': 'clip'} for i in ('a1', 'a2'))) == [('auto_reframe', 'a1'), ('auto_reframe', 'a2')]
    assert [(x['tool'], x['args']['id']) for x in pilot_check({'steps': [{'tool': 'duplicate_clip', 'args': {'id': 'a1'}, 'each': 'clip'}]}, pc,
                                                              'duplicate the first clip')[0]] == [('duplicate_clip', 'a1')]
    assert run({'tool': 'auto_reframe', 'args': {}, 'each': 'clip'}) == run({'tool': 'auto_reframe', 'args': {'id': 'a1'}, 'each': 'clip'}) == [('auto_reframe', 'a1'), ('auto_reframe', 'a2')]
    assert [x['args']['at'] for x in pilot_check({'steps': [{'tool': 'add_sound_effect', 'args': {'name': 'pop', 'at': 1}, 'each': 'cut'}]}, pc, 'a pop at 1 s')[0]] == [1]
    assert run({'tool': 'add_sound_effect', 'args': {'name': 'whoosh'}, 'each': 'cut'}) == [('add_sound_effect', 3.0)]
    keep = {k: globals()[k] for k in ('transcribe', 'meta', 'llm', 'shots')}
    words = [{'w': w, 's': a, 'e': b} for w, a, b in (('Intro.', 0, 1), ('First', 2, 2.4), ('point', 2.5, 3), ('here.', 3.1, 20), ('Second', 20.2, 20.6), ('one.', 20.7, 40), ('Bye.', 41, 42))]
    answer = {'clips': [{'start': 1.7, 'end': 20.3, 'title': 'Big claim: details.'}, {'start': 5, 'end': 25}, {'start': 'x'}, {'start': 20, 'end': 40.5, 'title': 'Two'}],
              'hooks': ['One: two three', '', 'Fine hook here.']}

    def fake_llm(system, user, ctx=8192):  # translations answer what was sent (renumbered on retry); 'three' is never translated
        if 'numbered line' not in user:
            return answer
        return {k: {'one': 'uno', 'two': 'dos'}[v] for k, v in json.loads(user.rsplit('\n', 1)[1]).items() if v in ('one', 'two')}
    globals().update(transcribe=lambda mid, lang='auto', ranges=None: words, meta=lambda mid: {'duration': 43.0}, llm=fake_llm)
    try:
        got = [(c['start'], c['end'], c['title']) for c in highlights({}, 'm', count=3, lo=10, hi=30)['clips']]
        assert got == [(1.88, 20.1, 'Big claim'), (20.1, 40.3, 'Two')], got
        assert hooks({}, [{'media': 'm', 'in': 0, 'out': 10}])['hooks'] == ['One: two three', 'Fine hook here']
        assert translate({}, ['one', 'two'], 'Spanish')['texts'] == ['uno', 'dos']
        assert translate({}, ['one', 'two', 'three'], 'Spanish') == {'texts': ['uno', 'dos', 'three'], 'kept': 1}  # never answered: kept
        try:
            translate({}, ['a', 'b'], 'Spanish; rm -rf')
            raise AssertionError('translate accepted a bad language name')
        except ValueError:
            pass
        # smart combine on stubbed shot analysis: the window skips a blurry start, one take moving on is a hard cut,
        # big brightness jumps dip to black / white, the target length drops the weakest shots, stretching stops at the scene end
        fr = lambda a, b, y=120, q=0.9: [{'t': round(a + i * 0.25, 3), 'q': q, 'y': y, 'm': 1.0, 'sat': 10} for i in range(int((b - a) / 0.25))]
        fake = {'A': {'frames': fr(0, 6) + fr(6, 12, y=30), 'vision': True, 'scenes': [{'a': 0, 'b': 6, 'kt': 1, 'take': 0, 'place': 'beach', 'look': 4},
                                                                                     {'a': 6, 'b': 12, 'kt': 7, 'take': 1, 'place': 'city', 'look': 4}]},
                'B': {'frames': fr(0, 1, q=0.1) + fr(1, 8), 'vision': True, 'scenes': [{'a': 0, 'b': 4, 'kt': 2, 'take': 0, 'place': 'hill', 'look': 3},
                                                                                     {'a': 4, 'b': 8, 'kt': 6, 'take': 0, 'place': 'hill', 'look': 3}]}}
        globals()['shots'] = lambda st, mid, span=(0, 1): fake[mid]
        sh_ = combine({}, ['A', 'B'], 0, 'balanced', 'shot')['shots']
        assert [x['media'] for x in sh_] == ['A', 'A', 'B', 'B'] and sh_[2]['in'] >= 1.0, sh_
        assert [x.get('tr', {}).get('type') for x in sh_] == ['fadeblack', 'fadewhite', None, None], sh_
        fit = combine({}, ['A', 'B'], 6, 'balanced', 'shot')['shots']
        assert len(fit) == 2 and sum(x['out'] - x['in'] for x in fit) <= 7.5, fit
        long = combine({}, ['A'], 30, 'calm', 'shot')['shots']
        assert all(x['out'] <= x['lim'] + 1e-6 for x in long), long
        words[:] = [{'w': 'mid', 's': 2.0, 'e': 4.0}]  # one word across the first shot's end (0.25-3.67 s), no sentence end near
        globals()['meta'] = lambda mid: {'duration': 43.0, 'hasAudio': True}
        talk = combine({}, ['A'], 0, 'balanced', 'shot', None, True)['shots']
        assert talk[0]['out'] >= 4.0 and talk[0]['speech'] and not talk[1]['speech'], talk
    finally:
        globals().update(keep)
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
    # the preview's sound: made at import, 48 kHz s16 stereo from the very start; a kept-pitch 2x copy is half as long
    p1, p2, p3 = CACHE / f"{A['id']}.pcm", pcm(A, 2.0, 0, 10), pcm(A, 2.0, 2, 6)
    n1, n2, n3 = (p.stat().st_size // 4 for p in (p1, p2, p3))
    assert abs(n1 - 10 * 48000) < 2400 and abs(n2 - n1 / 2) < 2400 and abs(n3 - 2 * 48000) < 2400, (n1, n2, n3)
    x = array('h', p1.read_bytes()[4 * 24000:4 * 24000 + 4800])  # 0.5 s in: the 220 Hz sine, same on both sides (little-endian, as on every Apple Silicon Mac)
    assert max(x) > 2000 and x[0::2] == x[1::2], max(x)  # lavfi sine peaks at 1/8 (4096)
    print(f'preview sound ok: {n1} frames, 2x kept-pitch {n2}, its 2-6 s range {n3}')

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
    for chunk in (24, 2):  # an uploaded layer (POST /api/layer/<id>/<i>): one red 32x24 crop laid at (40, 60), removed after the export
        CHUNK = chunk
        lid, ld = f'{chunk:012x}', CACHE / 'layers' / f'{chunk:012x}'
        ld.mkdir(parents=True, exist_ok=True)
        sh(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=32x24', '-frames:v', '1', str(ld / 't0.png')])
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan({**plan, 'text': {'layer': lid, 'n': 1, 'box': [40, 60, 32, 24], 'frames': [{'i': 0, 'start': 0, 'end': 9}]}}))
        assert JOBS['t']['state'] == 'done', JOBS['t']
        out = EXPORTS / JOBS['t']['file']
        r, g, b = pixel(out, 8.0, 50, 70)
        assert r > 200 and g < 40 and b < 40, ('uploaded layer box missing', r, g, b)
        assert max(pixel(out, 8.0, 30, 50)) < 40 and max(pixel(out, 8.0, 80, 70)) < 40, 'uploaded layer drawn outside its box'
        assert not ld.exists(), 'uploaded layer left behind'
        print(f'uploaded layer ok (chunk={chunk})')
    def imp(f):
        with open(HOME / f, 'rb') as fh:
            return import_file(f, fh, (HOME / f).stat().st_size, background=False)

    def render(plan, frames, **force):
        JOBS['t'] = {'state': 'running'}
        export('t', {**clean_plan(plan), **force})
        assert JOBS['t']['state'] == 'done', JOBS['t']
        out = EXPORTS / JOBS['t']['file']
        got = int(json.loads(sh(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v', '-print_format', 'json', '-show_streams', str(out)]).stdout)['streams'][0]['nb_read_frames'])
        assert got == frames, (plan['name'], got, frames)
        return out

    # more formats on the mixed project: AV1 (MP4, WebM), VP9 WebM, AAC M4A; tags, frames, length, picture vs H.264 (PSNR)
    probe = lambda f: json.loads(sh(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(f)]).stdout)
    ref = render({**plan, 'quality': 'best', 'name': 'ref h264'}, 270)
    for fmt, vc, ac in (('av1', 'av1', 'aac'), ('av1webm', 'av1', 'opus'), ('webm', 'vp9', 'opus'), ('m4a', None, 'aac')):
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan({**plan, 'format': fmt, 'name': f'fmt {fmt}'}))
        assert JOBS['t']['state'] == 'done', (fmt, JOBS['t'])
        out = EXPORTS / JOBS['t']['file']
        j = probe(out)
        st = {s['codec_type']: s for s in j['streams']}
        assert out.suffix == FORMATS[fmt] and st['audio']['codec_name'] == ac and abs(float(j['format']['duration']) - 9) < 0.1, (fmt, out.name, st['audio']['codec_name'], j['format']['duration'])
        if not vc:
            assert set(st) == {'audio'} and int(st['audio']['bit_rate']) > 200e3, (fmt, st['audio'].get('bit_rate'))  # AAC 256k, no picture
            continue
        v = st['video']
        got = (v['codec_name'], v['pix_fmt'], v.get('color_space'), v.get('color_primaries'), v.get('color_transfer'), int(v['nb_read_frames']), v['avg_frame_rate'])
        assert got == (vc, 'yuv420p', 'bt709', 'bt709', 'bt709', 270, '30/1'), (fmt, got)
        e = sh(['ffmpeg', '-hide_banner', '-i', str(out), '-i', str(ref), '-lavfi', '[0]settb=1/30,setpts=N[a];[1]settb=1/30,setpts=N[b];[a][b]psnr', '-f', 'null', '-']).stderr  # by frame number: WebM's 1 ms clock rounds 1/30 s down
        db = float(re.search(r'average:([\d.]+|inf)', e)[1].replace('inf', '99'))
        assert db > 38, (fmt, 'PSNR vs H.264', db)
        print(f'{fmt}: {vc}+{ac} yuv420p bt709 270 frames 9 s, {db:.1f} dB vs H.264')
    # export fps apart from the project: frame k shows the project frame at or before k/fps (60 doubles, 24 drops 1 in 5)
    small = lambda f: subprocess.run(['ffmpeg', '-v', 'error', '-i', str(f), '-vf', 'scale=48:84,format=gray', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    n_ = 48 * 84
    fr_ = lambda raw: [raw[i:i + n_] for i in range(0, len(raw), n_)]
    d_ = lambda a, b: sum(abs(x - y) for x, y in zip(a, b)) / n_
    rf = fr_(small(ref))
    assert sum(d_(rf[k], rf[k + 1]) for k in range(60)) / 60 > 2, 'the first 2 s must move (else the fps check proves nothing)'
    for e in (60, 24):
        of = fr_(small(render({**plan, 'quality': 'best', 'efps': e, 'name': f'fps {e}'}, 9 * e)))
        worst = max(d_(of[k], rf[math.floor(k * 30 / e + 1e-9)]) for k in range(len(of)))
        assert worst < 1.5, (e, 'fps resample: a frame shows the wrong project frame', worst)
        print(f'export at {e} fps from a 30 fps project: {9 * e} frames, each the project frame at or before its time (worst {worst:.2f}/255)')
    out = render({**plan, 'quality': 'best', 'mbps': 0.1, 'name': 'custom bitrate'}, 270)  # mostly still pictures: x264's ABR stays under it, never over
    kbps = int(next(s for s in probe(out)['streams'] if s['codec_type'] == 'video')['bit_rate']) / 1000
    with tempfile.TemporaryDirectory() as td_:
        vt, big = ffmpeg_cmd(clean_plan({**plan, 'mbps': 0.1}), td_, 'x.mp4'), ffmpeg_cmd(clean_plan({**plan, 'w': 7680, 'h': 4320}), td_, 'x.mp4')
    assert kbps < 130 and vt[vt.index('-b:v') + 1] == '100k', ('custom bitrate 0.1 Mbps', kbps)
    assert big[big.index('-c:v') + 1] == 'libx264', '8K H.264 must use x264 (VideoToolbox H.264 stops at 4096 px)'
    ram, globals()['RAM_GB'] = RAM_GB, 8
    try:
        clean_plan({**plan, 'w': 7680, 'h': 4320})
        raise AssertionError('8K on an 8 GB Mac must be refused')
    except ValueError as e:
        assert '16 GB' in str(e), e
    finally:
        globals()['RAM_GB'] = ram
    assert clean_plan({**plan, 'w': 3840, 'h': 2160, 'format': 'webm'})['w'] == 3840  # 4K stays allowed
    print(f'custom bitrate {kbps:.0f} kb/s for 0.1 Mbps; 8K H.264 goes to x264')
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
    for tr in sorted(XFADES - {'fade', 'wipeleft', 'wipeup', 'slideright', 'circleclose', 'fadewhite'}):  # every other type renders, and ends on b
        out = render({**tplan, 'name': tr, 'duration': 3, 'main': [still_clip(R, {'type': tr, 'frames': 30}), still_clip(B)]}, 90)
        assert pixel(out, 0.5, 135, 240)[0] > 180 and pixel(out, 2.5, 135, 240)[2] > 180, tr
    print(f'transitions ok: {len(XFADES) - 6} more types render from a to b')
    tx = {'er': 'if(lt(Y,H/2),r(X,clip(Y,0,H/2-1)+H/2),0)', 'eg': 'if(lt(Y,H/2),clip(N/TO*200,0,255),0)', 'eb': 'if(lt(Y,H/2),b(X,clip(Y,0,H/2-1)),0)'}  # b's red, a ramp, a's blue
    for chunk in (24, 1):
        CHUNK = chunk
        out = render({**tplan, 'name': 'tr-custom', 'duration': 3, 'main': [still_clip(B, {'type': 'cube', 'frames': 30, 'expr': tx}), still_clip(R)]}, 90)
        c0, c1, c2 = pixel(out, 0.5, 135, 240), pixel(out, 1.5, 135, 240), pixel(out, 2.5, 135, 240)  # blue, then (b's red, 100, a's blue) half way, then red
        assert c0[2] > 200 and c0[0] < 50 and c1[0] > 200 and abs(c1[1] - 100) <= 10 and c1[2] > 200 and c2[0] > 200 and c2[2] < 50, ('effects-pack transition (geq on a over b)', chunk, c0, c1, c2)
    CHUNK = 24
    print('transitions ok: an effects-pack transition (geq on the stacked overlap), single graph and chunked')
    # plain cuts stay 4:2:0 (yuv_ok): BT.709 and untagged HD video (passed through), untagged SD (BT.601), a letterboxed
    # clip and an RGB picture, a dissolve, fades and a background past the main track give the RGB path's picture,
    # BT.709-tagged; Light (VideoToolbox decode) the same again
    gen('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', str(HOME / 'tagged709.mp4'))
    gen('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=1', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', str(HOME / 'untagged720.mp4'))
    V7, U7 = imp('tagged709.mp4'), imp('untagged720.mp4')
    yplan = {'w': W, 'h': H, 'fps': F, 'duration': 9, 'bg': '#204060', 'name': 'yuv', 'overlay': [],
             'audio': [{'media': A['id'], 'start': 0, 'in': 0, 'out': 9, 'frames': 270}],
             'main': [{'media': V7['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(V7)}, {'media': U7['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(U7)},
                      {'media': L['id'], 'in': 1, 'out': 3, 'frames': 60, 'geom': geom(L), 'fadeIn': 0.3, 'tr': {'type': 'fade', 'frames': 15}},
                      {'media': T['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(T, scale=0.8)},
                      {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'fadeOut': 0.5}]}  # main ends at 7.5 s
    yp = clean_plan(yplan)
    assert [c['bt709'] for c in yp['main']] == [True, True, False, False, False], [c['bt709'] for c in yp['main']]
    assert yuv_ok(yp) and not yuv_ok({**yp, 'rgb': True}) and not yuv_ok({**yp, 'main': [{**yp['main'][0], 'tr': 'wipeleft'}]}), 'plain cuts take the 4:2:0 path'
    assert not yuv_ok({**yp, 'main': [{**yp['main'][0], 'adj': {'b': 1.1, 'c': 1, 's': 1}}]}) and not yuv_ok({**yp, 'format': 'prores'})
    outs = {k: render({**yplan, 'name': f'yuv {k}'}, 270, **kw) for k, kw in (('rgb', {'rgb': True}), ('yuv', {}), ('light', {'light': True}))}
    for k in ('yuv', 'light'):
        ps = float(re.search(r'PSNR y:([\d.]+|inf)', sh(['ffmpeg', '-hide_banner', '-i', str(outs['rgb']), '-i', str(outs[k]), '-lavfi', 'psnr', '-f', 'null', '-']).stderr)[1])
        tags = json.loads(sh(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_streams', '-of', 'json', str(outs[k])]).stdout)['streams'][0]
        assert ps > 42 and (tags['pix_fmt'], tags['color_space'], tags['color_primaries'], tags['color_transfer']) == ('yuv420p', 'bt709', 'bt709', 'bt709'), (k, ps, tags)
        for t, x, y in ((0.5, 135, 240), (0.5, 135, 20), (1.5, 135, 240), (3.0, 135, 240), (5.0, 135, 240), (5.0, 10, 240), (6.5, 135, 240), (8.5, 135, 240)):
            # tagged 709, letterbox, untagged HD, untagged SD, tall, pillarbox, picture, past the end
            a, b = pixel(outs['rgb'], t, x, y), pixel(outs[k], t, x, y)
            assert max(abs(u - v) for u, v in zip(a, b)) <= 6, (k, t, x, y, a, b)
        assert max(abs(u - v) for u, v in zip(pixel(outs[k], 8.5, 135, 240), (0x20, 0x40, 0x60))) <= 4, 'background past the main track'
        print(f'4:2:0 path ok ({k}): luma {ps:.1f} dB vs the RGB path, BT.709 tags, background padded')
    # video effects: steps on exact frame ranges of the composite; per-frame values through sendcmd / expressions
    gen('-f', 'lavfi', '-i', 'color=red:s=320x320,drawbox=x=160:y=0:w=160:h=320:color=blue:t=fill', '-frames:v', '1', str(HOME / 'split.png'))
    SP = imp('split.png')  # filled onto 270x480: red | blue at x = 135
    fx = [{'op': 'negate', 'a': 10, 'b': 20}, {'op': 'matrix', 'a': 30, 'b': 40, 'm': [.213, .715, .072] * 3, 'k': [1.0] * 5 + [0.5] * 5},
          {'op': 'rgbshift', 'a': 40, 'b': 50, 'rh': [20] * 5 + [0] * 5, 'bh': 0},
          {'op': 'transform', 'a': 50, 'b': 60, 'z': [1.5] * 10, 'x': [40.0] * 10, 'y': 0}]
    out = render({**tplan, 'name': 'effects', 'duration': 2, 'main': [still_clip(SP)], 'fx': fx}, 60)
    at = lambda n, x=100: pixel(out, max(0.0, n - 0.25) / F, x, 240)  # input -ss gives the first frame at or after t
    assert at(9)[0] > 200 and at(10)[0] < 50 and at(10)[2] > 200 and at(19)[2] > 200 and at(20)[0] > 200, ('negate on frames 10-19 only', at(9), at(10), at(19), at(20))
    g1, g2 = at(32), at(37)
    assert abs(g1[0] - g1[1]) < 8 and 40 < g1[0] < 70 and 18 < g2[0] < 40, ('matrix with a per-frame factor', g1, g2)
    assert at(42, 145)[0] > 200 and at(42, 145)[2] > 200 and at(47, 145)[0] < 50, ('red moved 20 px right, then back', at(42, 145), at(47, 145))
    assert at(55, 160)[0] > 200 and at(55, 190)[2] > 200, ('zoom 1.5 about the centre, moved 40 px right: the seam goes to x = 135 + 40', at(55, 160), at(55, 190))
    out = render({**tplan, 'name': 'fx-expr', 'duration': 1, 'main': [{**still_clip(SP), 'frames': 30}], 'fx': [{'op': 'expr', 'a': 10, 'b': 20, 'er': '0', 'eg': 'clip(LF*20,0,255)', 'eb': 'b(X,Y)'}]}, 30)
    e5, e15, e15b, e25 = at(5), at(15), at(15, 200), at(25)  # LF = frames since the step began (5 at frame 15)
    assert e5[0] > 200 and max(abs(u - v) for u, v in zip(e15, (0, 100, 0))) <= 3 and e15b[2] > 200 and e15b[0] < 10 and e25[0] > 200, ('geq expression on frames 10-19 only', e5, e15, e15b, e25)
    for bad in ("1'", 'foo(1)', 'r(X,Y', 'X:Y', 'X[0]', 'r(X,Y))'):  # page expressions are checked token by token: nothing can leave the quoted option
        try:
            xexpr(bad)
            raise AssertionError(f'expression {bad!r} accepted')
        except ValueError:
            pass
    print('effects-pack expressions ok: geq on its frames, LF counts from its start, bad tokens refused')
    gen('-f', 'lavfi', '-i', 'color=red:s=320x320,drawbox=x=200:y=0:w=120:h=320:color=blue:t=fill', '-frames:v', '1', str(HOME / 'box.png'))
    out = render({**tplan, 'name': 'fx-zblur', 'duration': 1, 'main': [{**still_clip(imp('box.png')), 'frames': 30}], 'fx': [{'op': 'zblur', 's': 0.5, 'a': 10, 'b': 20}]}, 30)
    z5, z15, z25 = at(5, 210), at(15, 210), at(25, 210)  # blue from x = 195; zoomed copies (up to 1.5x about x = 135) push it out to 225
    assert z5[2] > 200 and z5[0] < 50 and 40 < z15[0] < 200 and z25[0] < 50, ('zoom blur on frames 10-19 only: red pulled over the blue', z5, z15, z25)
    gen('-f', 'lavfi', '-i', 'color=black:s=320x320:r=30:d=1,geq=lum=40+N*6:cb=128:cr=128', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', str(HOME / 'ramp.mp4'))
    RP = imp('ramp.mp4')  # flat grey, 6 levels brighter every frame
    outs = [render({**tplan, 'name': f'mb{k}', 'duration': 1, 'main': [{**still_clip(RP), 'out': 1, 'frames': 30, 'mb': k}]}, 30) for k in (0, 3)]
    g0, g3 = ([pixel(o, max(0.0, n - 0.25) / F, 135, 240)[1] for n in (0, 1, 2, 10)] for o in outs)
    want = [g0[0], (2 * g0[0] + g0[1]) / 3, (g0[0] + g0[1] + g0[2]) / 3, g0[3] - (g0[2] - g0[1])]  # tmix repeats the first frame before it
    assert all(abs(a - b) <= 2 for a, b in zip(g3, want)), ('motion blur 3 = mean of the frame and the 2 before', g0, g3, want)
    print(f'motion blur ok: zoom blur on its frames only; tmix of 3 frames = their mean ({g0} -> {g3})')
    out = render({**tplan, 'name': 'mosaic', 'duration': 1, 'main': [{**still_clip(SP), 'out': 1, 'frames': 30, 'pix': 64}]}, 30)
    mo = [pixel(out, 0.5, x, 240) for x in (40, 135, 230)]  # source blocks of 64 px from x = 0: [128, 192) spans the red | blue seam at 160
    assert mo[0][0] > 200 and mo[0][2] < 50 and 90 < mo[1][0] < 165 and 90 < mo[1][2] < 165 and mo[2][2] > 200 and mo[2][0] < 50, ('mosaic = block averages in the source', mo)
    print(f'mosaic ok: 64 px source blocks, the seam block averaged {mo[1]}')
    swap = base64.b64encode(array('H', [round(v * 65535 / 32) for b in range(33) for g in range(33) for r in range(33) for v in (b, g, r)]).tobytes()).decode()
    out = render({**tplan, 'name': 'fx-lut', 'duration': 1, 'main': [{**still_clip(SP), 'frames': 30}], 'fx': [{'op': 'lut', 'lut': swap, 'a': 10, 'b': 20}]}, 30)
    l5, l15, l25 = at(5, 60), at(15, 60), at(15, 200)
    assert l5[0] > 200 and l15[2] > 200 and l15[0] < 50 and l25[0] > 200 and l25[2] < 50, ('adjustment layer table on frames 10-19 only: red and blue swapped', l5, l15, l25)
    for op in ({'op': 'blur', 'sigma': 4}, {'op': 'hblur', 'sigma': 8}, {'op': 'pixelize', 'size': 16}, {'op': 'noise', 's': 20}, {'op': 'mirror'}, {'op': 'grid'}, {'op': 'glow', 'sigma': 6, 'amt': 0.6}):
        out = render({**tplan, 'name': f"fx-{op['op']}", 'duration': 1, 'main': [{**still_clip(SP), 'frames': 30}], 'fx': [{**op, 'a': 0, 'b': 30}]}, 30)
        if op['op'] == 'mirror':
            assert pixel(out, 0.5, 260, 240)[0] > 200, 'mirror: the right edge shows the (red) left edge'
        if op['op'] == 'grid':
            assert pixel(out, 0.5, 20, 240)[0] > 200 and pixel(out, 0.5, 120, 240)[2] > 200 and pixel(out, 0.5, 155, 240)[0] > 200, 'split x4: red|blue twice per row'
    print('effects ok: frame-exact ranges, per-frame values, and every step type renders')
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
    # an overlay starting between frames (91/30 s as the UI stores it): from output frame 91 to 105, like the preview
    out = render({'w': W, 'h': H, 'fps': F, 'duration': 4, 'bg': '#000000', 'name': 'ovframe', 'audio': [], 'main': [],
                  'overlay': [{'media': R['id'], 'start': 91 / 30, 'in': 0, 'out': 0.5, 'frames': 15, 'geom': geom(R)}]}, 120)
    nth = lambda n: tuple(subprocess.run(['ffmpeg', '-v', 'error', '-i', str(out), '-vf', f'select=eq(n\\,{n}),format=rgb24,crop=1:1:135:240', '-frames:v', '1',
                                          '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout[:3])
    got = [nth(n) for n in (90, 91, 105, 106)]
    assert max(got[0]) < 40 and got[1][0] > 200 and got[2][0] > 200 and max(got[3]) < 40, ('overlay on whole output frames 91-105', got)
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
    bz_kf = [{**ease_kf[0], 'bz': [0, 0, 0.58, 1]}, ease_kf[1]]  # ease-out as a cubic-bezier (st/ld halvings in the expression): ahead of linear
    edge = round(67.5 * (1 - bez(bz_kf[0]['bz'], 0.25)))
    out = one('ease-bezier', {'media': I['id'], 'in': 0, 'out': 2, 'frames': 60, 'geom': geom(I), 'kf': bz_kf})
    assert max(pixel(out, 0.5, edge - 4, 240)) < 40 and pixel(out, 0.5, edge + 10, 240)[0] > 200, f'cubic-bezier easing: the edge must sit near {edge} px'
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
    df = meta(deflicker({}, L['id'], 0, 1)['media'])
    assert abs(df['duration'] - 1) < 0.1 and df['w'] == L['w'], df
    if (AI_DIR / 'vendor' / 'enhance' / 'flownet_v4.25.pkl').exists():  # RIFE (tests/ai_enhance.mjs measures it on real footage)
        sm = meta(slowmo({}, L['id'], 0, 1, 4, 'ai')['media'])
        assert abs(sm['fps'] - 120) < 1 and abs(sm['duration'] - 1) < 0.1, ('AI slow-mo', sm)
    rmap = [[0, 0], [0.5, 1], [1, 1.25]]  # speed ramp: 0.5x for the first half second of source, then 2x
    rp = ramp_copy({}, L['id'], 0, 1, rmap, 30)
    rm_, nm = meta(rp['media']), len(list(MEDIA.glob('*.json')))
    nfr = int(sh(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', str(MEDIA / rm_['file'])]).stdout)
    assert abs(rm_['duration'] - 1.25) <= 1 / 30 + 1e-6 and nfr == 38 and not rm_['hasAudio'], ('ramp copy length', rm_, nfr)
    assert ramp_copy({}, L['id'], 0, 1, rmap, 30) == rp and len(list(MEDIA.glob('*.json'))) == nm, 'the same ramp again must be the same copy'
    frame = lambda f, t: subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.4f}', '-i', str(f), '-frames:v', '1', '-sws_flags', 'accurate_rnd+full_chroma_int', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                                        capture_output=True, check=True).stdout
    fa, fb = frame(MEDIA / rm_['file'], (33 - 0.25) / 30), frame(MEDIA / L['file'], (21 - 0.25) / 30)  # copy 1.1 s = source 0.5 + 0.1 * 2 = 0.7 s
    rdiff = sum(abs(x - y) for x, y in zip(fa, fb)) / len(fa)
    assert len(fa) == len(fb) and rdiff < 1, ('ramp copy frame at 1.1 s vs the source at 0.7 s', rdiff)
    print('volume envelope + 6 export formats + animated GIF + smooth slow-mo + speed ramp ok')
    snd = {}  # a WAV is built from the sound alone: the same sound as the video's track (AAC there: levels, not samples)
    for fmt in ('wav', 'mp4'):
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan({**plan, 'format': fmt, 'name': f'sound {fmt}'}))
        assert JOBS['t']['state'] == 'done', (fmt, JOBS['t'])
        snd[fmt] = EXPORTS / JOBS['t']['file']
    lv = lambda f, a, b: float(re.search(r'mean_volume: (-?[\d.]+)', sh(['ffmpeg', '-hide_banner', '-ss', str(a), '-to', str(b), '-i', str(f), '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr.replace('-inf', '-200'))[1])
    for a, b in ((0.2, 1), (1, 3), (3, 6), (6, 8.8)):
        assert abs(lv(snd['wav'], a, b) - lv(snd['mp4'], a, b)) < 0.5, ('sound-only WAV vs the video track', a, b, lv(snd['wav'], a, b), lv(snd['mp4'], a, b))
    print('sound-only WAV matches the video export track')
    real_cut, md5 = still_cut, lambda f: sh(['ffmpeg', '-v', 'error', '-i', str(f), '-f', 'md5', '-']).stdout.strip()
    for base, at in ((tplan, (0.5, 1.5, 2.5, 3.5)), (plan, (0.2, 1.2, 4.0, 5.5))):  # in clips, inside both transitions, under the overlay and text
        for t_ in at:
            got = []
            for cut in (real_cut, lambda q: q):
                globals()['still_cut'] = cut
                JOBS['t'] = {'state': 'running'}
                export('t', clean_plan({**base, 'format': 'png', 'still': t_, 'name': f'still {t_}'}))
                assert JOBS['t']['state'] == 'done', (t_, JOBS['t'])
                got.append(md5(EXPORTS / JOBS['t']['file']))
            globals()['still_cut'] = real_cut
            assert got[0] == got[1], ('a still cut to its frame differs from the whole render', base['name'], t_, got)
    print('stills: cut to their frame, the same pixels as from the whole plan')
    plan['loud'] = True
    plan['main'][0].update(crop={'l': 0.1, 'r': 0.1, 't': 0, 'b': 0.2}, flip=True, look=[.393, .769, .189, .349, .686, .168, .272, .534, .131], denoise=True, sharp={'r': 2, 'amt': 1.2})
    render(plan, 270)
    print('smoke ok: crop + flip + look + denoise + sharpen + loudness')
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
    # colours: the export's 4:2:0 pixels = scale_vt's own (compared as Y/U/V: ffmpeg 9's swscale colour-manages RGB reads by
    # route), on both paths. Read as the bt2020nc scale_vt leaves them tagged, saturated colours moved: luma |d| 6.7 (fixed 0.2-2.1)
    hr = imp('hlg_rot.mp4')
    dec, vf = hdr_decode(hr)
    yuv = lambda args, f, pre='': subprocess.run(['ffmpeg', '-v', 'error', *args, '-ss', '0.5', '-i', str(f), '-frames:v', '1', '-vf', f'{pre}scale={W}:{H}',
                                                   '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], capture_output=True, check=True).stdout
    planes = lambda b: [b[:W * H], b[W * H:W * H * 5 // 4], b[W * H * 5 // 4:]]
    ref = planes(yuv(dec, HOME / 'hlg_rot.mp4', vf))
    hplan = {'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#000000', 'name': 'hdr colour', 'overlay': [], 'audio': [],
             'main': [{'media': hr['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(hr)}]}
    assert yuv_ok(clean_plan(hplan)), 'a plain HDR cut takes the 4:2:0 path'
    for k, kw in (('yuv', {}), ('rgb', {'rgb': True})):
        got = planes(yuv([], render({**hplan, 'name': f'hdr colour {k}'}, 30, **kw)))
        d = [(sum(a) - sum(b)) / len(b) for a, b in zip(got, ref)]
        luma = sum(abs(a - b) for a, b in zip(got[0], ref[0])) / len(ref[0])  # read as BT.2020, saturated colours' luma moves (6.7 here)
        assert max(map(abs, d)) < 1 and luma < 3.5, ('HDR colours vs scale_vt (Y, U, V mean shift; luma |d|)', k, d, luma)
        print(f'hdr colour ok ({k}): Y/U/V mean shift vs scale_vt {", ".join(f"{x:+.2f}" for x in d)}, luma |d| {luma:.2f}')
    fz = still(imp('hlg.mp4')['id'], 0.5)
    assert not fz['hdr'], fz
    render({'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#000000', 'name': 'hdrstill', 'overlay': [], 'audio': [],
            'main': [{'media': fz['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(fz)}]}, 30)
    print(f'hdr ok: HLG tone-mapped to SDR, rotated clip matches the SDR path at {float(ps[1]):.1f} dB PSNR; HDR freeze frame exports')
    # HDR export (10-bit, no SDR round trip): the rotated HLG clip trimmed + faded in -> HEVC Main 10 HLG, PQ (through the
    # table), ProRes 422 HQ; upright, labelled, its luma = the source's; what can't stay HDR exports SDR and says why
    vst = lambda f: json.loads(sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,codec_tag_string,profile,pix_fmt,width,height,'
                                   'color_space,color_primaries,color_transfer,nb_read_frames:stream_tags=alpha_mode:stream_side_data=rotation:format=duration', '-of', 'json', str(f)]).stdout)
    y10 = lambda f, n, pre='': array('H', subprocess.run(['ffmpeg', '-v', 'error', '-i', str(f), '-vf', f"select=eq(n\\,{n}),{pre}format=yuv420p10le", '-frames:v', '1',
                                                          '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-'], capture_output=True, check=True).stdout[:W * H * 2])
    hcl = {'media': hr['id'], 'in': 0.2, 'out': 0.8, 'frames': 18, 'geom': geom(hr), 'fadeIn': 0.2}
    hbase = {**hplan, 'duration': 0.6, 'main': [hcl]}
    src = [y10(HOME / 'hlg_rot.mp4', 6 + n, f'scale={W}:{H},') for n in (3, 9, 12, 15, 17)]  # the source frames under export frames 3 (fading), 9-17
    for hk, fmt, pix, prof in (('hlg', 'hevc', 'yuv420p10le', 'Main 10'), ('pq', 'hevc', 'yuv420p10le', 'Main 10'), ('hlg', 'prores', 'yuv422p10le', 'HQ')):
        assert clean_plan({**hbase, 'hdr': hk, 'format': fmt}).get('hdr') == hk, ('HDR kept for a plain cut + fade', hk, fmt)
        out = render({**hbase, 'name': f'hdr {hk} {fmt}', 'hdr': hk, 'format': fmt}, 18)
        v = vst(out)['streams'][0]
        assert (v['pix_fmt'], v['profile'], v['color_space'], v['color_primaries'], v['color_transfer'], v['width'], v['height']) == (
            pix, prof, 'bt2020nc', 'bt2020', HDR_TRC[hk], W, H) and not v.get('side_data_list') and (fmt != 'hevc' or v['codec_tag_string'] == 'hvc1'), ('HDR export', hk, fmt, v)
        if hk == 'hlg':  # the same code values as the source (10-bit), the fade a share of them
            got = [y10(out, n) for n in (3, 9, 12, 15, 17)]
            mean = lambda a: sum(a) / len(a)
            shift = max(abs(mean(g) - mean(s)) / 876 for g, s in zip(got[1:], src[1:]))
            mad = max(sum(abs(a - b) for a, b in zip(g, s)) / len(s) / 876 for g, s in zip(got[1:], src[1:]))
            share = (mean(got[0]) - 64) / (mean(src[0]) - 64)
            assert shift < 0.01 and mad < 0.01 and 0.3 < share < 0.7, ('HDR luma vs source', hk, fmt, shift, mad, share)
            print(f'hdr export ok ({hk} {fmt}): {pix} {prof} {v["color_transfer"]}, upright {W}x{H}, 18 frames; luma vs source at 4 frames: '
                  f'mean shift {shift * 100:.2f} %, mean |d| {mad * 100:.2f} % of the 10-bit range; fade frame at {share:.2f} of the source')
        else:
            print(f'hdr export ok ({hk} {fmt}): {pix} {prof} {v["color_transfer"]}, upright {W}x{H}, 18 frames')
    CHUNK = 1  # the chunked path keeps HDR too (10-bit intermediates)
    out = render({**hbase, 'name': 'hdr chunks', 'duration': 1.2, 'hdr': 'hlg', 'format': 'hevc', 'main': [hcl, {**hcl, 'fadeIn': 0}]}, 36)
    CHUNK = 24
    v = vst(out)['streams'][0]
    assert (v['pix_fmt'], v['color_transfer']) == ('yuv420p10le', 'arib-std-b67'), ('HDR chunks', v)
    # HLG -> PQ at known values: greys and saturated patches, BT.2100 maths (reference white HLG 0.75 = 203 nits = PQ 0.58)
    pats = [(0, 0, 0), (.25, .25, .25), (.5, .5, .5), (.75, .75, .75), (1, 1, 1), (.75, .2, .2), (.2, .75, .2), (.2, .2, .75)]
    ycc = lambda r, g, b: (lambda y: (64 + 876 * y, 512 + 896 * (b - y) / 1.8814, 512 + 896 * (r - y) / 1.4746))(.2627 * r + .678 * g + .0593 * b)
    pw_, ph_ = 256, 16
    yy = [round(ycc(*pats[x * 8 // pw_])[0]) for _ in range(ph_) for x in range(pw_)]
    uv = [[round(ycc(*pats[2 * x * 8 // pw_])[k]) for _ in range(ph_ // 2) for x in range(pw_ // 2)] for k in (1, 2)]
    o = array('H', subprocess.run(['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s', f'{pw_}x{ph_}', '-i', '-', '-vf', 'setparams=range=tv'
                                   + hdr_tail({'hdr': True, 'trc': 'arib-std-b67'}, 'pq'), '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-'],
                                  input=array('H', yy + uv[0] + uv[1]).tobytes(), capture_output=True, check=True).stdout)
    q = pw_ * ph_
    worst = max(max(abs(a - b) for a, b in zip((o[8 * pw_ + x], o[q + 4 * pw_ // 2 + x // 2], o[q * 5 // 4 + 4 * pw_ // 2 + x // 2]), ycc(*hlg_to_pq(*pats[i]))))
                for i, x in ((i, int((i + 0.5) * pw_ / 8)) for i in range(8)))
    assert abs(hlg_to_pq(.75, .75, .75)[0] - 0.5806) < 0.001 and abs(hlg_to_pq(1, 1, 1)[0] - 0.7518) < 0.001 and worst < 2, ('HLG -> PQ', worst)
    print(f'hlg -> pq ok: 8 known patches within {worst:.2f} 10-bit codes (HLG 0.75 -> PQ {hlg_to_pq(.75, .75, .75)[0]:.4f}, 1.0 -> {hlg_to_pq(1, 1, 1)[0]:.4f})')
    for extra, why in (({'text': plan['text']}, 'text, captions or stickers'), ({'main': [{**hcl, 'opacity': 0.5}]}, 'a clip with opacity'),
                       ({'main': [hcl, {'media': R['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(R)}]}, 'a photo or SDR clip on the main track'), ({'format': 'gif'}, 'HDR is made as')):
        cp = clean_plan({**hbase, 'hdr': 'hlg', 'format': 'hevc', **extra})
        assert cp['hdr'] is None and cp['sdr'].startswith(why), ('SDR because', why, cp.get('sdr'))
    print('hdr ok: text / opacity / photos / GIF export SDR and say why')
    # transparent background: a cut-out clip (VP9 alpha), a sticker (PNG alpha) and a text layer, no main track, in each alpha format
    gen('-f', 'lavfi', '-i', 'color=c=red:s=60x60:r=30:d=1,format=rgba,pad=120:120:30:30:color=black@0', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', str(HOME / 'cut.webm'))
    gen('-f', 'lavfi', '-i', 'color=c=blue:s=50x50,format=rgba,pad=100:100:25:25:color=black@0', '-frames:v', '1', str(HOME / 'stk.png'))
    gen('-f', 'lavfi', '-i', f'color=c=white:s=100x40,format=rgba,pad={W}:{H}:20:20:color=black@0', '-frames:v', '1', str(HOME / 'txt.png'))
    cut, stk = imp('cut.webm'), imp('stk.png')
    assert cut['alpha'] and stk['trans'], (cut, stk)
    aplan = {'w': W, 'h': H, 'fps': F, 'duration': 1, 'bg': '#101010', 'name': 'alpha', 'alpha': True, 'main': [], 'audio': [],
             'overlay': [{'media': cut['id'], 'start': 0, 'in': 0, 'out': 1, 'frames': 30, 'geom': {'x': 150, 'y': 300, 'w': 120, 'h': 120}},
                         {'media': stk['id'], 'start': 0, 'in': 0, 'out': 0.5, 'frames': 15, 'geom': {'x': 20, 'y': 200, 'w': 100, 'h': 100}}],  # gone after 0.5 s
             'text': {'pngs': [png('txt')], 'frames': [{'i': 0, 'start': 0, 'end': 1}]}}
    pts = {'clear': (5, 5, 0), 'text': (70, 40, 255), 'sticker': (70, 250, 255), 'cut-out': (210, 360, 255), 'cut-out edge': (155, 305, 0)}

    def rgba(f, n, dec=()):  # frame n decoded with its alpha, straight RGBA
        b = subprocess.run(['ffmpeg', '-v', 'error', *dec, '-i', str(f), '-vf', f"select=eq(n\\,{n})", '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                           capture_output=True, check=True).stdout
        return lambda x, y: tuple(b[(y * W + x) * 4:(y * W + x) * 4 + 4])
    for fmt, frames, pixa in (('prores4444', 30, 'yuva444p'), ('webm', 30, 'alpha_mode'), ('gif', 15, 'bgra'), ('pngseq', 30, 'rgba')):
        JOBS['t'] = {'state': 'running'}
        export('t', clean_plan({**aplan, 'name': f'alpha {fmt}', 'format': fmt}))
        assert JOBS['t']['state'] == 'done', JOBS['t']
        out = EXPORTS / JOBS['t']['file']
        dec = ['-c:v', 'libvpx-vp9'] if fmt == 'webm' else []  # the native VP9 decoder drops the alpha
        if fmt == 'pngseq':
            with zipfile.ZipFile(out) as z:
                names = sorted(z.namelist())
                for k in (12, 24):
                    (HOME / f'seq{k}.png').write_bytes(z.read(names[k]))
            assert len(names) == frames, ('PNG sequence frames', len(names))
            v, dur = vst(HOME / 'seq12.png')['streams'][0], len(names) / F
            px, late = rgba(HOME / 'seq12.png', 0), rgba(HOME / 'seq24.png', 0)
        else:
            j = vst(out)
            v, dur = j['streams'][0], float(j['format']['duration'])
            assert int(v['nb_read_frames']) == frames, (fmt, v['nb_read_frames'])
            px, late = rgba(out, frames * 12 // 30, dec), rgba(out, frames * 24 // 30, dec)  # at 0.4 s and 0.8 s
        kind = v['pix_fmt'] + (' + alpha_mode 1' if v.get('tags', {}).get('alpha_mode') == '1' else '')
        assert pixa in kind and abs(dur - 1) < 0.08, ('alpha format', fmt, v, dur)
        got = {k: px(x, y) for k, (x, y, _) in pts.items()}
        assert all(abs(got[k][3] - a) <= 2 for k, (_, _, a) in pts.items()), ('alpha', fmt, got)
        assert got['sticker'][2] > 180 and got['cut-out'][0] > 180 and min(got['text'][:3]) > 200, ('colours under alpha', fmt, got)
        assert late(70, 250)[3] <= 2 and late(70, 40)[3] >= 253, ('a sticker that ended leaves clear pixels', fmt, late(70, 250))
        print(f"alpha ok ({fmt}): {kind}, {frames} frames, {dur:.2f} s; alpha clear {got['clear'][3]}, text {got['text'][3]}, sticker {got['sticker'][3]} "
              f"(after it ends {late(70, 250)[3]}), cut-out {got['cut-out'][3]} (edge {got['cut-out edge'][3]})")
    out = render({**aplan, 'name': 'alpha main', 'format': 'webm', 'overlay': [], 'text': None, 'main': [{'media': L['id'], 'in': 0, 'out': 1, 'frames': 30, 'geom': geom(L), 'fadeOut': 0.5}]}, 30)
    px = rgba(out, 5, ['-c:v', 'libvpx-vp9'])
    assert px(135, 20)[3] <= 2 and px(135, 240)[3] >= 253, ('letterbox of a main clip is clear', px(135, 20), px(135, 240))
    assert 90 < rgba(out, 22, ['-c:v', 'libvpx-vp9'])(135, 240)[3] < 200, 'a fade on a clear background fades the alpha'
    CHUNK = 1  # chunked: the intermediates keep the alpha (FFV1 RGBA)
    lc = {'media': L['id'], 'in': 0, 'out': 0.5, 'frames': 15, 'geom': geom(L)}
    px = rgba(render({**aplan, 'name': 'alpha chunks', 'format': 'webm', 'overlay': [], 'text': None, 'main': [lc, lc]}, 30), 20, ['-c:v', 'libvpx-vp9'])
    CHUNK = 24
    assert px(135, 20)[3] <= 2 and px(135, 240)[3] >= 253, ('alpha through chunks', px(135, 20), px(135, 240))
    print('alpha ok (main track): letterbox clear, picture opaque, fade-out fades to clear; chunked too')
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
        d = sp['duration']  # first only the last words in use: whisper hears that span + 1 s, then the rest when all is asked for
        part, have = transcribe(sp['id'], 'en', [[d - 0.6, d]]), json.loads((CACHE / f"{sp['id']}.en.words.json").read_text())['have']
        assert part and not any('caption' in w['w'].lower() for w in part) and len(have) == 1 and abs(have[0][0] - (d - 1.6)) < 0.01, (part, have)
        words = transcribe(sp['id'], 'en')
        assert any('caption' in w['w'].lower() for w in words) and all(w['e'] > w['s'] for w in words), words
        assert sum('mac' in w['w'].lower() for w in words) == 1, ('a span heard twice', words)
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
    # the app's preview copy: same decoded pixels, only the colour labels change (sRGB transfer: WebKit shows them unlifted)
    gen('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(HOME / 'hd.mp4'))
    hd = imp('hd.mp4')
    md5 = lambda f: re.findall(r'[0-9a-f]{32}', sh(['ffmpeg', '-v', 'error', '-i', str(f), '-map', '0:v', '-f', 'framemd5', '-']).stdout)
    for src in (hd, V7):  # untagged, and labelled BT.709 in its container (as every proxy is): the container's labels change too
        wk = wk_copy(src)
        tags = json.loads(sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_primaries,color_transfer', '-of', 'json',
                              str(wk)]).stdout)['streams'][0]
        assert wk.name.endswith('.wk.mov') and tags == {'color_space': 'bt709', 'color_primaries': 'bt709', 'color_transfer': 'iec61966-2-1'}, (src['name'], tags)
        assert md5(wk) == md5(MEDIA / src['file']), 'the WebKit copy decodes differently'
    print('webkit preview copy ok: identical frames, labelled bt709 + sRGB transfer')
    if (AI_BIN / 'python').exists():  # object removal end to end: Vision tracks a moving square both ways, the fill must match the clean shot
        gen('-f', 'lavfi', '-i', 'testsrc2=s=480x270', '-frames:v', '1', str(HOME / 'bg.png'))
        gen('-loop', '1', '-i', str(HOME / 'bg.png'), '-t', '2', '-r', '30', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', str(HOME / 'clean.mp4'))
        gen('-loop', '1', '-i', str(HOME / 'bg.png'), '-f', 'lavfi', '-i', 'color=c=0xff00ff:s=40x40', '-filter_complex', "[0][1]overlay=x='60+t*120':y=110:shortest=1",
            '-t', '2', '-r', '30', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', str(HOME / 'dirty.mp4'))
        dirty, sq = imp('dirty.mp4'), {'x': 180 / 480, 'y': 110 / 270, 'w': 40 / 480, 'h': 40 / 270}
        rm = remove_object({}, dirty['id'], 1.0, 0, 2, sq)
        worst = 99.0
        for t in (0.2, 1.0, 1.8):  # the square's own spot vs the clean shot
            x = int(60 + 120 * t)
            got, want = (subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(f), '-frames:v', '1', '-vf', f'crop=40:40:{x}:110', '-f', 'rawvideo',
                                         '-pix_fmt', 'gray', '-'], capture_output=True).stdout for f in (MEDIA / meta(rm['media'])['file'], HOME / 'clean.mp4'))
            mse = sum((a - b) ** 2 for a, b in zip(got, want)) / max(1, len(want))
            worst = min(worst, 10 * math.log10(255 ** 2 / max(mse, 1e-9)))
        assert rm['frames'] == 60 and worst > 30, ('object removal', rm, worst)
        print(f"object removal ok ({rm['engine']}): followed both ways, fill vs clean shot >= {worst:.1f} dB")
        if (AI_DIR / 'vendor' / 'sam2' / 'checkpoints' / 'sam2.1_hiera_small.pt').exists():  # any-subject cutout: opaque on it, clear around it
            cut = remove_object({}, dirty['id'], 1.0, 0, 2, sq, mode='cutout')
            a = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-ss', '1.0', '-i', str(MEDIA / meta(cut['media'])['file']), '-frames:v', '1',
                                '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
            on = [a[y * 480 + x] for y in range(116, 145) for x in range(186, 215)]
            off = [a[y * 480 + x] for y in list(range(0, 90)) + list(range(170, 270)) for x in range(0, 480, 7)]
            assert min(on) > 200 and max(off) < 30, ('cutout alpha', min(on), max(off))
            print(f'cutout ok: alpha {min(on)}+ on the subject, {max(off)} or less around it')
            for purpose in ('cutout', 'remove'):  # the outline shown before it runs: the square at t=1 is x 180-220, y 110-150
                t0_ = time.monotonic()
                pv = mask_preview(dirty['id'], 1.0, sq, purpose=purpose)
                (HOME / 'pv.png').write_bytes(base64.b64decode(pv['mask']))
                g = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(HOME / 'pv.png'), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
                on = [g[y * 480 + x] for y in range(115, 146) for x in range(185, 216)]
                off = [g[y * 480 + x] for y in range(0, 270, 5) for x in range(0, 480, 5) if not (170 <= x <= 230 and 100 <= y <= 160)]
                # a cutout keeps exactly the square; a removal may also take what SAM 2 is sure of round it (filled exactly anyway)
                assert (0.008 < pv['area'] < 0.02 if purpose == 'cutout' else pv['area'] < 0.03) and min(on) == 255 and max(off) == 0, (
                    'outline preview', purpose, pv['area'], min(on), max(off))
                print(f"outline preview ok ({purpose}, {time.monotonic() - t0_:.2f} s): {pv['area']:.4f} of the frame, all of the square")
        if Path(AI_BIN / 'python').exists() and subprocess.run([str(AI_BIN / 'python'), '-I', '-c', 'import demucs'], capture_output=True).returncode == 0:
            # isolate voice: speech over a loud 55 Hz hum + 220 Hz tone; the voice track must lose the music
            subprocess.run(['say', '-o', str(HOME / 'talk.aiff'), 'Cutroom keeps the voice and drops the music underneath it, all on this Mac.'], check=True)
            gen('-i', str(HOME / 'talk.aiff'), '-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*55*t)+0.2*sin(2*PI*220*t):s=44100:d=6', '-filter_complex',
                '[0]aresample=44100,apad[a];[a][1]amix=inputs=2:normalize=0:duration=shortest', '-c:a', 'aac', str(HOME / 'noisy.m4a'))
            vo = isolate({}, imp('noisy.m4a')['id'], 'voice')

            def tone_db(path, hz):  # level of one frequency against the speech band
                raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-t', '5', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], capture_output=True).stdout
                x = array('h'); x.frombytes(raw[:len(raw) // 2 * 2])
                pw = lambda f: abs(sum(v * complex(math.cos(2 * math.pi * f * i / 8000), -math.sin(2 * math.pi * f * i / 8000)) for i, v in enumerate(x)))
                return 20 * math.log10(pw(hz) / max(1.0, statistics.fmean(pw(f) for f in (500, 700, 900, 1100))))
            drop = tone_db(HOME / 'noisy.m4a', 55) - tone_db(MEDIA / meta(vo['media'])['file'], 55)
            assert drop > 20, ('isolate voice kept the hum', drop)
            print(f'isolate voice ok: the 55 Hz hum dropped {drop:.0f} dB')
    shutil.rmtree(HOME)
    print('selftest OK')


def resume_prepare():
    """Imports the app was quit in the middle of (they'd stay 'preparing' for good), and heavy footage that has no proxy
    yet (HDR imported before HDR got one): finished in the background, one at a time like any import."""
    for f in sorted(MEDIA.glob('*.json')):
        try:
            m = json.loads(f.read_text())
        except ValueError:
            continue
        if m.get('kind') == 'video' and 'gop' not in m and m.get('ready') and m.get('file') and (MEDIA / m['file']).is_file() and not m.get('trans'):
            m['gop'] = gop(MEDIA / m['file'])  # measured once for items imported before it was
            save_meta(m)
        px = CACHE / f"{m.get('id')}.proxy.mp4"
        if m.get('hdr') and px.exists() and 'bt2020' in sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space',
                                                              '-of', 'csv=p=0', str(px)]).stdout:
            # an HDR proxy from before 2026-11-09: BT.709 pixels labelled BT.2020, and upright pixels that still carried the
            # phone's rotation (portrait clips previewed sideways). Remade below with its filmstrip and WebKit copy
            for f in (px, CACHE / f"{m['id']}.wk.mov"):
                f.unlink(missing_ok=True)
            m.pop('grid', None)
        wk = CACHE / f"{m.get('id')}.wk.mov"
        if wk.exists() and 'iec61966-2-1' not in sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer',
                                                       '-of', 'csv=p=0', str(wk)]).stdout:
            wk.unlink()  # from before its container was relabelled too (WebKit showed it lifted): remade on the next request
        if m.get('kind') in ('video', 'audio') and m.get('file') and (MEDIA / m['file']).is_file() and (
                not m.get('ready') or ((heavy(m) or m.get('gop', 0) > 2) and not (CACHE / f"{m['id']}.proxy.mp4").exists())):
            m['ready'] = False  # the page polls until it's ready again, then reloads its players onto the proxy
            save_meta(m)
            prepare(m)
        elif m.get('ready') and m.get('hasAudio') and m.get('file') and (MEDIA / m['file']).is_file() and not (CACHE / f"{m['id']}.pcm").exists():
            with PREP:  # library items from before the preview played its sound from PCM: made now, not on the first play
                pcm(m)
        if m.get('ready') and m.get('file') and (MEDIA / m['file']).is_file() and (
                (m.get('kind') == 'video' and not m.get('grid')) or (m.get('hasAudio') and not m.get('peaks'))):
            with PREP:  # the zoomable filmstrip and waveform, once, for items from before them
                if timeline_assets(m):
                    save_meta(m)


def main():
    if '--selftest' in sys.argv:
        return selftest()
    if '--packs' in sys.argv:  # ai/setup.sh: the CC0 sound and music library, downloaded once into this library
        r = install_packs({})
        print(f"{r['items']} sounds and tracks in {HOME / 'packs'}" + ''.join(f'\n  left out: {s}' for s in r['skipped']))
        return
    for d in (MEDIA, PROJ, EXPORTS, CACHE):
        d.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(CACHE / 'layers', ignore_errors=True)  # ponytail: uploads of a plan that never ran stay until the next start
    ThreadingHTTPServer.request_queue_size = 128  # a burst of connections was reset at the default backlog of 5
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), App)
    print(f'Cutroom on http://127.0.0.1:{PORT}  (data: {HOME})', flush=True)
    threading.Thread(target=resume_prepare, daemon=True).start()
    import signal
    signal.signal(signal.SIGTERM, lambda *_: (comfy_down(), os._exit(0)))  # the app quitting: the PC's ComfyUI goes too
    try:
        srv.serve_forever()
    finally:
        comfy_down()


if __name__ == '__main__':
    main()
