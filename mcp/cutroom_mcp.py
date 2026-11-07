#!/usr/bin/env python3
"""Cutroom MCP server: Claude Code drives the open Cutroom editor (stdio JSON-RPC, stdlib only).

Commands go to Cutroom's local server, which hands them to the editor page; the page runs them with the
same functions the buttons use, so every edit shows up live and is one undo step. If no editor is open,
the first tool call opens ~/Applications/Cutroom.app.

Register:  claude mcp add -s user cutroom -- env -u PYTHONPATH /opt/homebrew/bin/python3 -I ~/cutroom/mcp/cutroom_mcp.py
"""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request

BASE = f"http://127.0.0.1:{os.environ.get('CUTROOM_PORT', '4610')}"
APP = os.path.expanduser('~/Applications/Cutroom.app')
OUT = threading.Lock()

INSTRUCTIONS = """Cutroom is the user's own CapCut-style video editor, running in a window on this Mac. These tools drive
the open editor live: the user watches every change, and each change is one undo step (history undo).
Typical flow: timeline (see tracks and clip ids) -> edit -> snapshot (look at the frame) -> export when asked.
Times are seconds on the timeline; a clip's in/out are seconds in its source file. Tracks: main (magnetic,
clips play back to back), overlay (picture-in-picture, free start), audio, text, captions.
Call options for valid values (transitions, looks, animations, text and caption presets, fonts, voices, formats).
Exports land in ~/Movies/Cutroom/exports."""

CLIP_PROPS = """Clip properties (objects merge, null deletes a key):
speed 0.1-100 | volume 0-10 (1 = 100%) | pitch bool (speed changes pitch) | fit fit|fill|blur (blur = blurred background, main only)
scale (1 = fitted size) | x, y: offset in canvas fractions, 0 = centred (text clips: 0..1 position, 0.5 = centre) | rot degrees | opacity 0-1
blend (overlay only): normal|multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion
fadeIn, fadeOut seconds | flip bool (mirror) | denoise bool (export)
adj: {b, c, s: brightness/contrast/saturation, 1 = neutral; temp, tint: -1..1; ex: exposure EV -2..2; hi, sh: highlights/shadows -1..1; fade 0..1; vig: vignette 0..1}
look: {name: vivid|mono|sepia|warm|cool|teal, amount 0..1} | crop: {l, r, t, b: fractions 0..0.45}
key: {color '#00ff00', sim 0..1, blend 0..0.5} chroma key | mask: {type circle|rect|linear|mirror, x, y -0.5..0.5, w, h, rot, feather, invert}
anim: {in, out: none|fade|grow|shrink|left|right|up|down|rotate|spin; ind, outd seconds; loop: none|kbin|kbout|drift|pulse|shake|sway|float; amt strength}
text clips: text, style {font, weight, size (px at 1080), color, stroke, strokeW, shadow, shc, sha, shb, shx, shy, box, boxColor, boxAlpha, boxR, boxPad,
  align left|center|right, ls letter spacing, lh line height, maxW, upper, italic, anim pop|fade|slide|type, out pop|fade|slide|type, loop bounce|pulse|wiggle, animT, outT}
start, dur (overlay/audio/text) | in, out (source seconds) | kf: keyframes [{t, scale, x, y, opacity, rot, ease}] (replaces them)"""


def http(path, body=None, timeout=30):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'POST',
                                 headers={'X-Cutroom': '1', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'{}')


def connected():
    try:
        return bool(http('/api/remote/status', timeout=3).get('connected'))
    except OSError:
        return False


def ensure_editor():
    """Commands run inside the editor page: open the app if no editor is listening yet."""
    if connected():
        return
    if os.path.exists(APP):
        subprocess.run(['open', APP], check=False)
    for _ in range(80):
        time.sleep(0.5)
        if connected():
            return
    raise RuntimeError('Cutroom is not open and did not start. Open ~/Applications/Cutroom.app and try again.')


def remote(cmd, args, timeout=900):
    ensure_editor()
    r = http('/api/remote', {'cmd': cmd, 'args': args, 'timeout': timeout}, timeout=timeout + 15)
    if not r.get('ok'):
        raise RuntimeError(str(r.get('result') or 'the editor reported an error') + (f" ({'; '.join(r['log'])})" if r.get('log') else ''))
    return r


def S(props=None, required=()):  # JSON schema shorthand
    return {'type': 'object', 'properties': props or {}, 'required': list(required), 'additionalProperties': False}


num, txt, boo = {'type': 'number'}, {'type': 'string'}, {'type': 'boolean'}
obj = {'type': 'object'}
TOOLS = [
    ('status', 'Current project (name, size, fps, duration), playhead, selection and clip counts per track.', S(), 'status'),
    ('options', 'Valid values: canvas ratios, transitions, looks, blend modes, clip/text animations, presets, fonts, voices, export formats and resolutions.', S(), 'options'),
    ('timeline', 'Every clip on every track with its id, timing and non-default settings. Call this before editing to get clip ids.', S(), 'timeline'),
    ('media', 'The media library (id, name, kind, duration, size).', S(), 'media'),
    ('import_media', 'Import a file from this Mac into the library (copied). Optionally put it on a track right away.',
     S({'path': {**txt, 'description': 'absolute path or ~/...'}, 'add_to': {'type': 'string', 'enum': ['main', 'overlay', 'audio']}, 'start': num}, ['path']), None),
    ('projects', 'List saved projects.', S(), 'projects'),
    ('open_project', 'Open a project by id or (part of its) name.', S({'project': txt}, ['project']), 'open_project'),
    ('new_project', 'Start a new empty project.', S({'ratio': {**txt, 'description': '9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 21:9'}, 'name': txt}), 'new_project'),
    ('set_project', 'Change project settings: name, ratio, fps, bg (hex colour), capStyle (caption style object).', S({'set': obj}, ['set']), 'set_project'),
    ('add_clip', 'Put a library item on a track. Main clips append (or insert at start); overlay/audio clips start at start (default: playhead).',
     S({'media': {**txt, 'description': 'media id or (part of its) name'}, 'lane': {'type': 'string', 'enum': ['main', 'overlay', 'audio']}, 'start': num, 'in': num, 'out': num}, ['media']), 'add_clip'),
    ('update_clip', 'Change any clip setting. ' + CLIP_PROPS, S({'id': txt, 'set': obj}, ['id', 'set']), 'update_clip'),
    ('split_clip', 'Split a clip at a timeline time (seconds). Keyframes, volume envelopes and animations follow their halves.', S({'id': txt, 'at': num}, ['id', 'at']), 'split_clip'),
    ('delete_clip', 'Delete a clip (main-track clips close the gap).', S({'id': txt}, ['id']), 'delete_clip'),
    ('duplicate_clip', 'Duplicate a clip (placed right after it).', S({'id': txt}, ['id']), 'duplicate_clip'),
    ('move_clip', 'Move a clip: main-track order (index), start time (other tracks), or between the main and overlay tracks (lane).',
     S({'id': txt, 'start': num, 'index': {'type': 'integer'}, 'lane': {'type': 'string', 'enum': ['main', 'overlay']}}, ['id']), 'move_clip'),
    ('add_text', 'Add a text clip. Presets: Title, Subtitle, Label, Outline, Headline, Typewriter, Sticker. style takes the text style keys listed in update_clip.',
     S({'text': txt, 'preset': txt, 'start': num, 'duration': num, 'x': num, 'y': num, 'style': obj}, ['text']), 'add_text'),
    ('set_transition', 'Transition at the cut after main-track clip `after` (or every cut with all=true). type none removes it.',
     S({'after': txt, 'type': txt, 'duration': num, 'all': boo}, ['type']), 'set_transition'),
    ('auto_captions', 'Transcribe speech on this Mac (whisper.cpp) and lay word-timed captions on the captions track (replaces existing ones).',
     S({'lang': {**txt, 'description': 'auto or a 2-letter code'}, 'words': {'type': 'integer', 'description': 'words per caption (1-6)'}, 'style': {**txt, 'description': 'a caption preset'}, 'audio': {**boo, 'description': 'include the audio track'}}),
     'auto_captions'),
    ('remove_pauses', 'Cut silent gaps longer than min seconds out of main-track clips (jump cuts).', S({'min': num}), 'remove_pauses'),
    ('remove_fillers', 'Cut um / uh / er / hmm out of main-track clips (on-device transcript).', S(), 'remove_fillers'),
    ('voiceover', "Text to speech with the Mac's voices, added on the audio track at `at` (default: playhead).", S({'text': txt, 'voice': txt, 'rate': num, 'at': num}, ['text']), 'voiceover'),
    ('clip_tool', 'Run a smart tool on a clip: remove_background, stabilize, reverse, auto_reframe, freeze_frame (at), smooth_slowmo, detach_audio, split_scenes, '
                  'auto_duck (depth: 0.5 = -6 dB, 0.25 = -12 dB), detect_beats, beat_sync (every: beats per cut), speed_ramp (ramp name).',
     S({'id': txt, 'action': txt, 'depth': num, 'every': {'type': 'integer'}, 'ramp': txt, 'at': num}, ['id', 'action']), 'clip_tool'),
    ('generate_image', 'Generate an image ON THIS MAC (Z-Image-Turbo, about 25-50 s) and put it on the timeline. sticker=true cuts the subject out (transparent PNG). '
                       'shape canvas|1:1|16:9|9:16|4:5; steps 4 (draft) or 8 (best); put overlay|main|library; start/duration in seconds.',
     S({'prompt': txt, 'shape': txt, 'sticker': boo, 'steps': {'type': 'integer'}, 'seed': {'type': 'integer'}, 'put': txt, 'start': num, 'duration': num}, ['prompt']), 'ai_image'),
    ('ai_voiceover', 'Natural voiceover generated ON THIS MAC (Kokoro), added on the audio track at `at` (default: playhead). '
                     'voice ids: first letter = language (a US, b UK English, e Spanish, f French, h Hindi, i Italian, j Japanese, p Portuguese, z Chinese), '
                     'second = f/m; e.g. af_heart, af_bella, am_michael, bf_emma, bm_george. speed 0.5-2.',
     S({'text': txt, 'voice': txt, 'speed': num, 'at': num}, ['text']), 'ai_voiceover'),
    ('seek', 'Move the playhead (seconds).', S({'t': num}, ['t']), 'seek'),
    ('history', 'Undo or redo the last edit.', S({'action': {'type': 'string', 'enum': ['undo', 'redo']}}, ['action']), 'history'),
    ('snapshot', 'Look at the preview: returns the frame at time t (default: playhead) as an image.', S({'t': num, 'max': {'type': 'integer', 'description': 'longest side in px (default 720)'}}), 'snapshot'),
    ('export', 'Render the project. format mp4|hevc|prores|gif|mp3|wav|png (png = still at `at`); resolution 720p|1080p|1440p|4K; quality fast|best; bitrate 1|1.6|2.5.',
     S({'format': txt, 'resolution': txt, 'quality': txt, 'bitrate': num, 'name': txt, 'loudness': boo, 'at': num}), 'export'),
]
SCHEMAS = [{'name': n, 'description': d, 'inputSchema': s} for n, d, s, _ in TOOLS]
CMD = {n: c for n, _, _, c in TOOLS}


def call_tool(name, args):
    if name not in CMD:
        raise RuntimeError(f'unknown tool {name}')
    if name == 'import_media':
        ensure_editor()
        m = http('/api/import_path', {'path': args['path']}, timeout=600)
        remote('media', {})  # refresh the editor's library
        out = {'imported': {k: m.get(k) for k in ('id', 'name', 'kind', 'duration', 'w', 'h')}}
        if args.get('add_to'):
            out['clip'] = remote('add_clip', {'media': m['id'], 'lane': args['add_to'], **({'start': args['start']} if 'start' in args else {})})['result']
        return [{'type': 'text', 'text': json.dumps(out)}]
    long = name in ('export', 'auto_captions', 'remove_fillers', 'clip_tool', 'voiceover', 'remove_pauses', 'generate_image', 'ai_voiceover')
    r = remote(CMD[name], args, timeout=3600 if long else 120)
    res, log = r.get('result'), r.get('log') or []
    if name == 'snapshot':
        return [{'type': 'image', 'data': res['image'], 'mimeType': 'image/png'}, {'type': 'text', 'text': f"preview at {res['t']} s"}]
    text = json.dumps(res, ensure_ascii=False)
    if log:
        text += '\neditor said: ' + ' | '.join(dict.fromkeys(log))
    return [{'type': 'text', 'text': text}]


def send(obj):
    with OUT:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()


def handle(msg):
    mid, method, params = msg.get('id'), msg.get('method'), msg.get('params') or {}
    if method == 'initialize':
        return send({'jsonrpc': '2.0', 'id': mid, 'result': {'protocolVersion': params.get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}},
                                                              'serverInfo': {'name': 'cutroom', 'version': '1.0'}, 'instructions': INSTRUCTIONS}})
    if method == 'tools/list':
        return send({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': SCHEMAS}})
    if method == 'tools/call':
        try:
            content, err = call_tool(params.get('name'), params.get('arguments') or {}), False
        except (RuntimeError, OSError, KeyError, ValueError, urllib.error.URLError) as e:
            content, err = [{'type': 'text', 'text': f'Error: {e}'}], True
        return send({'jsonrpc': '2.0', 'id': mid, 'result': {'content': content, 'isError': err}})
    if method == 'ping':
        return send({'jsonrpc': '2.0', 'id': mid, 'result': {}})
    if mid is not None:  # requests we don't implement; notifications need no answer
        send({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'method not found: {method}'}})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get('method') == 'tools/call':  # long tools (export, captions) run alongside pings and other calls
            threading.Thread(target=handle, args=(msg,), daemon=True).start()
        else:
            handle(msg)


if __name__ == '__main__':
    main()
