#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
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
clips play back to back), overlay (picture-in-picture, free start), audio, text, captions, fx (video effects: they change
everything under them for their duration; text stays on top). Call options for valid values (transitions, looks, effects,
sound effects, animations, text and caption presets, fonts, voices, formats).
Exports land in the library's exports folder (~/Movies/Cutroom/exports unless CUTROOM_HOME says otherwise)."""

CLIP_PROPS = """Clip properties (objects merge, null deletes a key):
speed 0.1-100 | volume 0-10 (1 = 100%) | pitch bool (speed changes pitch) | fit fit|fill|blur (blur = blurred background, main only)
scale (1 = fitted size) | x, y: offset in canvas fractions, 0 = centred (text clips: 0..1 position, 0.5 = centre) | rot degrees | opacity 0-1
blend (overlay only): normal|multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion
fadeIn, fadeOut seconds | flip bool (mirror) | denoise bool (RNNoise, heard in preview and export)
studio: false | true (Studio voice: RNNoise, de-ess, compressor, presence EQ, -16 LUFS) | 'music' (the same after Demucs takes the music out); wins over denoise
au: {voice none|robot|echo|hall|telephone|elf|giant|monster|alien|radio|megaphone|cave|underwater (elf..alien move pitch and formants apart, WORLD vocoder), semi -12..12 (pitch in semitones, timing kept; chipmunk = 6, deep = -5), bass, mid, treb: EQ dB -12..12 (100 Hz / 1 kHz / 8 kHz), pan -1 (left)..1 (right)}
vkf: [{t: seconds into the clip, v: volume multiplier}] volume points (linear ramps; one point = the whole clip)
adj: {b, c, s: brightness/contrast/saturation, 1 = neutral; temp, tint: -1..1; ex: exposure EV -2..2; hi, sh: highlights/shadows -1..1; fade 0..1; vig: vignette 0..1; blur 0..1; sharp: sharpen 0..1}
look: {name: a filter from options().looks (colour matrices such as vivid, mono, teal; film looks such as tealorange, bleach, print, portra, noir, cinema), amount 0..1} | crop: {l, r, t, b: fractions 0..0.45}
key: {color '#00ff00', sim 0..1, blend 0..0.5} chroma key | mask: {type circle|rect|linear|mirror|heart|star|polygon|pen, x, y -0.5..0.5, w, h, rot, feather, invert;
  star/polygon: n points/sides 3-12, star: inner 0.1-0.9; pen: pts [[u, v], ...] -1..1 in the mask's box (a smooth closed curve)} (an AI subject mask: cut_out_object as_mask)
anim: {in, out: none|fade|grow|shrink|left|right|up|down|rotate|spin; ind, outd seconds; loop: none|kbin|kbout|drift|pulse|shake|sway|float; amt strength}
text clips: text, style {font, weight, size (px at 1080), color, stroke, strokeW, shadow, shc, sha, shb, shx, shy, box, boxColor, boxAlpha, boxR, boxPad,
  align left|center|right, ls letter spacing, lh line height, maxW, upper, italic, anim pop|fade|slide|type, out pop|fade|slide|type, loop bounce|pulse|wiggle, animT, outT}
track: overlay/audio/text/fx clips sit on tracks 0, 1, 2... (higher overlay tracks draw on top) | start, dur (overlay/audio/text/fx) | in, out (source seconds) | kf: keyframes [{t, scale, x, y, opacity, rot, ease, bz}] (replaces them;
  ease = the segment after it: linear|ease-in|ease-out|ease-in-out (or true/false); bz: [x1, y1, x2, y2] a custom cubic-bezier, x 0..1)
effect clips (fx track): fx (the effect, from options().effects), amt strength 0.1-2 (1 = default)
grade (colour grading, video/photo clips): {lift|gamma|gain: {x, y: colour wheel offset -1..1 (x = towards red, y = towards green-yellow), l: level -1..1},
  curves: {m|r|g|b: [[x, y], ...] points 0..1 (m = luma)}, hsl: {red|orange|yellow|green|aqua|blue|purple|magenta: {h, s, l} -1..1},
  lut: {id (import_lut / options().luts), amount 0..1}} | lkf: [{t, v 0..1}] strength of all the clip's colour (filter, adjust, grade) over time"""


def http(path, body=None, timeout=30):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'POST',
                                 headers={'X-Cutroom': '1', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'{}')


GPU_TOOLS = ('lip_sync', 'talking_photo')  # run on the GPU PC only: listed while it is set up and answering


def gpu_up():  # the server's cached check (never a wait on a sleeping PC); no server = not listed
    try:
        g = http('/api/ai/status', timeout=3).get('gpu', {})
        if g.get('configured') and (g.get('stale') or not g.get('checked')):  # a check is out (stale cache): its answer, once
            time.sleep(4.5)
            g = http('/api/ai/status', timeout=3).get('gpu', {})
        return bool(g.get('reachable'))
    except (OSError, ValueError):
        return False


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
    ('set_project', 'Change project settings: name, ratio, fps, bg (hex colour), capStyle (caption style object), markers (list of seconds: the timeline markers, also the YouTube chapter starts), rippleAll (bool: main-track cuts and trims move every track after them, linked or not), unlinked (bool).', S({'set': obj}, ['set']), 'set_project'),
    ('add_clip', 'Put a library item on a track. Main clips append (or insert at start); overlay/audio clips start at start (default: playhead).',
     S({'media': {**txt, 'description': 'media id or (part of its) name'}, 'lane': {'type': 'string', 'enum': ['main', 'overlay', 'audio']}, 'start': num, 'in': num, 'out': num}, ['media']), 'add_clip'),
    ('update_clip', 'Change any clip setting. ' + CLIP_PROPS, S({'id': txt, 'set': obj}, ['id', 'set']), 'update_clip'),
    ('split_clip', 'Split a clip at a timeline time (seconds). Keyframes, volume envelopes and animations follow their halves.', S({'id': txt, 'at': num}, ['id', 'at']), 'split_clip'),
    ('set_track', 'Hide (mute, for audio) or lock one track. lane main|overlay|audio|text|captions|fx; track = 0, 1, 2... (overlay, audio, text and fx have several, see timeline track numbers).',
     S({'lane': txt, 'track': {'type': 'integer'}, 'hidden': boo, 'locked': boo}, ['lane']), 'set_track'),
    ('delete_clip', 'Delete a clip (main-track clips close the gap).', S({'id': txt}, ['id']), 'delete_clip'),
    ('duplicate_clip', 'Duplicate a clip (placed right after it).', S({'id': txt}, ['id']), 'duplicate_clip'),
    ('move_clip', 'Move a clip: main-track order (index), start time (other tracks), or between the main and overlay tracks (lane).',
     S({'id': txt, 'start': num, 'index': {'type': 'integer'}, 'lane': {'type': 'string', 'enum': ['main', 'overlay']}}, ['id']), 'move_clip'),
    ('add_text', 'Add a text clip. Presets: Title, Subtitle, Label, Outline, Headline, Typewriter, Sticker. style takes the text style keys listed in update_clip.',
     S({'text': txt, 'preset': txt, 'start': num, 'duration': num, 'x': num, 'y': num, 'style': obj}, ['text']), 'add_text'),
    ('set_transition', 'Transition at the cut after main-track clip `after` (or every cut with all=true). type none removes it.',
     S({'after': txt, 'type': txt, 'duration': num, 'all': boo}, ['type']), 'set_transition'),
    ('add_effect', 'Add a video effect on the effects track at `start` (default: playhead) for `duration` seconds; it changes everything under it, text stays on top. '
                   'type: shake, quake, pulse (beat zoom: follows detected beats), zoomin, flash, strobe, blink, glow, vhs, oldfilm, grain, bw, sepia, glitch, rgb (RGB split), '
                   'pixelate, blur, invert, mirror, split4, snow, rain, sparkle, hearts, confetti, bubbles, bars (cinema bars), rec (camcorder frame), vignette, film (film strip). '
                   'strength 0.1-2 (1 = default). Change it later with update_clip (fx, amt, start, dur).',
     S({'type': txt, 'start': num, 'duration': num, 'strength': num}, ['type']), 'add_effect'),
    ('add_sound_effect', 'Add a sound effect or library music track on the audio track at `at` (default: playhead). Synthesized on this Mac: whoosh, swish, riser, boom, '
                         'bass drop, pop, click, ding, notification, correct, wrong buzzer, camera shutter, typing, heartbeat, glitch, cash register, drum roll, applause, '
                         'tick tock. Any other name or id is looked up in the CC0 sound library (see sound_library).',
     S({'name': txt, 'at': num}, ['name']), 'add_sound'),
    ('sound_library', 'Search the CC0 sound and music library: 600+ sound effects (Kenney packs: impacts, footsteps, interface, clicks, game, sci-fi, casino, foley, '
                      'jingles) and 22 music tracks by mood (hip-hop, lo-fi, chill, electronic, upbeat, happy, cinematic, emotional, tense, playful), each CC0 with its '
                      'source recorded. category = one of the returned categories, or sfx / music. install=true downloads the library first (~100 MB, once). '
                      'Add a result with add_sound_effect(name=<id>).',
     S({'query': txt, 'category': txt, 'install': boo}), 'sound_library'),
    ('auto_captions', 'Transcribe speech on this Mac (whisper.cpp) and lay word-timed captions on the captions track (replaces existing ones).',
     S({'lang': {**txt, 'description': 'auto or a 2-letter code'}, 'words': {'type': 'integer', 'description': 'words per caption (1-6)'}, 'style': {**txt, 'description': 'a caption preset'}, 'audio': {**boo, 'description': 'include the audio track'},
        'lyrics': {**boo, 'description': 'music: separate the vocals first (Demucs) and caption the lyrics'}}),
     'auto_captions'),
    ('remove_pauses', 'Cut silent gaps longer than min seconds out of main-track clips (jump cuts).', S({'min': num}), 'remove_pauses'),
    ('remove_fillers', 'Cut um / uh / er / hmm out of main-track clips (on-device transcript).', S(), 'remove_fillers'),
    ('voiceover', "Text to speech with the Mac's voices, added on the audio track at `at` (default: playhead).", S({'text': txt, 'voice': txt, 'rate': num, 'at': num}, ['text']), 'voiceover'),
    ('clip_tool', 'Run a smart tool on a clip: remove_background, stabilize, reverse, auto_reframe, freeze_frame (at), smooth_slowmo (a clip slower than 1x; engine ai = RIFE frames, '
                  'fast = ffmpeg minterpolate), detach_audio, split_scenes, deflicker (even out brightness pumping), ai_upscale (scale 2|4, Real-ESRGAN), '
                  'relight (preset light|subject|background, x, y 0..1 where the light is on the frame, color "#rrggbb", strength 0..1; depth from Depth Anything; '
                  'these four render a copy of the clip range on this Mac that the clip then plays), '
                  'auto_duck (depth: 0.5 = -6 dB, 0.25 = -12 dB), isolate_voice (keep only speech, Demucs on this Mac), remove_voice (keep music/ambience), split_stems (vocals, drums, bass, other: four audio clips in sync), '
                  'body_blur, body_mono, body_dim (background blurred / black and white / darker, the person cut out above it), body_glow, body_neon (a glow / neon line around the person), '
                  'detect_beats, beat_sync (every: beats per cut), speed_ramp (ramp: a preset name, or curve: 2-12 [u, speed] points, u 0..1 through the clip, speed 0.1-10; rendered into a silent copy the clip plays, one clip), auto_adjust (exposure, contrast, white balance from the picture; '
                  'ref = another clip id to match its colours instead), slip (by seconds: new in/out, same place and length), slide (by: a main clip moves between its neighbours), '
                  'roll (by: moves the cut at the clip\'s side end|start). slip/slide/roll keep the rest of the timeline as it is. deflicker, ai_upscale (scale 2|4), relight (preset light|subject|background, x, y, color, strength).',
     S({'id': txt, 'action': txt, 'depth': num, 'every': {'type': 'integer'}, 'ramp': txt, 'curve': {'type': 'array', 'items': {'type': 'array', 'items': num}}, 'at': num, 'ref': txt, 'by': num, 'side': txt,
        'engine': txt, 'scale': {'type': 'integer'}, 'preset': txt, 'x': num, 'y': num, 'color': txt, 'strength': num}, ['id', 'action']), 'clip_tool'),
    ('track_motion', 'Motion tracking: an overlay, sticker or text clip (id) follows what is inside box on the main-track video at time t, '
                     'moving, growing and turning with it (keyframes for x, y, scale, rot). box = {x, y, w, h} fractions of the canvas (look with snapshot first). '
                     'scale / rotate false: follow position only.',
     S({'id': txt, 'box': obj, 't': num, 'scale': boo, 'rotate': boo}, ['id', 'box']), 'track_motion'),
    ('blur_region', 'Blur (or mosaic) a moving region of a video clip: a number plate, a face, a logo. box = {x, y, w, h} canvas fractions at time t; '
                    'it is tracked both ways through the clip and a blurred copy of the clip, masked to it, goes on the overlay track. '
                    'shape rect|circle, style blur|mosaic, amount 0.05-1.',
     S({'id': txt, 'box': obj, 't': num, 'shape': txt, 'style': txt, 'amount': num}, ['id', 'box']), 'blur_region'),
    ('blur_faces', 'Blur (or mosaic) every face in a video clip (Apple Vision): each face gets its own tracked blur on the overlay track. style blur|mosaic, amount 0.05-1.',
     S({'id': txt, 'style': txt, 'amount': num}, ['id']), 'blur_faces'),
    ('auto_reframe', 'Auto reframe a video clip for another shape: keeps the largest face, or with none the main subject (Vision saliency), in frame with a smooth camera path. '
                     'ratio 9:16|1:1|4:5|16:9|3:4|4:3|21:9 changes the canvas first; box = {x, y, w, h} canvas fractions at time t picks the subject (it is tracked).',
     S({'id': txt, 'ratio': txt, 'box': obj, 't': num}, ['id']), 'auto_reframe'),
    ('retouch', 'Face and body retouch of a video clip (Apple Vision face landmarks + body pose on every frame, smoothed over time; rendered on this Mac into a copy the clip plays). '
                'Each value is a slider: smooth (skin), bright (eyes), eyes (enlarge), teeth (whiten), slim (face), lips, blush, body (slim), legs (longer): 0..1; '
                'width, cheek (cheekbones), jaw, chin (longer), nose (bigger): -1..1 (negative = narrower / shorter / smaller). lipc, blushc = #rrggbb. '
                'Values not given are 0. reset=true puts the original back. Check the result with snapshot.',
     S({'id': txt, **{k: num for k in ('smooth', 'bright', 'eyes', 'teeth', 'slim', 'width', 'cheek', 'jaw', 'chin', 'nose', 'lips', 'blush', 'body', 'legs')},
        'lipc': txt, 'blushc': txt, 'reset': boo}, ['id']), 'retouch'),
    ('main_transcript', "The main track's speech as it plays on the timeline: sentences with start/end seconds, and every word timed. "
                        'Use it to decide what to cut, then cut_timeline. Transcribes on this Mac the first time (cached).', S({'lang': txt}), 'main_transcript'),
    ('cut_timeline', 'Ripple-delete ranges from the main track: ranges = [[start, end], ...] in timeline seconds (e.g. a sentence from main_transcript). '
                     'Later clips move up; captions made from speech are re-made so they stay on their words. One undo step.',
     S({'ranges': {'type': 'array', 'items': {'type': 'array', 'items': num}}}, ['ranges']), 'cut_timeline'),
    ('generate_image', 'Generate an image ON THIS MAC (Z-Image-Turbo, about 25-50 s) and put it on the timeline. sticker=true cuts the subject out (transparent PNG). '
                       'shape canvas|1:1|16:9|9:16|4:5; steps 4 (draft) or 8 (best); put overlay|main|library; start/duration in seconds.',
     S({'prompt': txt, 'shape': txt, 'sticker': boo, 'steps': {'type': 'integer'}, 'seed': {'type': 'integer'}, 'put': txt, 'start': num, 'duration': num}, ['prompt']), 'ai_image'),
    ('generate_video', 'Animate a picture into a ~5 s video (Wan 2.2 image-to-video on the user\'s RTX 4090 PC over SSH, ~2 min; the Mac stays cool). '
                       'image = a library picture (id or name); or clip = a clip id (a video clip gives its frame at the playhead); or nothing = the selected clip. '
                       'prompt = what happens (motion, camera); ratio 9:16|16:9|1:1 (default: the picture\'s); quality fast (720p) | best (1440p); put main|overlay|library.',
     S({'prompt': txt, 'image': txt, 'clip': txt, 'ratio': txt, 'quality': txt, 'put': txt, 'at': num, 'seed': {'type': 'integer'}}), 'generate_video'),
    ('generate_music', 'Make music ON THIS MAC (MusicGen, about as long as the music takes to play) from a description or a style '
                       '(Upbeat pop, Lo-fi, Cinematic, Hip hop, EDM, Acoustic, Corporate, Ambient, Funk, Trap) and put it on the audio track at `at`. '
                       'duration 4-60 s; add=false keeps it in the library only. smart_combine also takes music="ai" to make music to fit the edit.',
     S({'prompt': txt, 'duration': num, 'at': num, 'seed': {'type': 'integer'}, 'add': boo}, ['prompt']), 'generate_music'),
    ('ai_voiceover', 'Natural voiceover generated ON THIS MAC (Kokoro), added on the audio track at `at` (default: playhead). '
                     'voice ids: first letter = language (a US, b UK English, e Spanish, f French, h Hindi, i Italian, j Japanese, p Portuguese, z Chinese), '
                     'second = f/m; e.g. af_heart, af_bella, am_michael, bf_emma, bm_george. speed 0.5-2.',
     S({'text': txt, 'voice': txt, 'speed': num, 'at': num}, ['text']), 'ai_voiceover'),
    ('cut_out_object', 'Keep only one subject of a video clip, any kind (person, car, pet, product), on a transparent background: box = where it '
                       'is on the canvas as fractions {x, y, w, h} at time t; SAM 2 follows its exact outline through the clip. '
                       'as_mask=true: the outline becomes the clip\'s mask instead (AI subject mask: the file stays, feather / invert / move it like any mask).',
     S({'id': txt, 'box': {'type': 'object', 'properties': {k: num for k in 'xywh'}, 'required': list('xywh')}, 't': num, 'as_mask': boo}, ['id', 'box']), 'cut_out_object'),
    ('smart_combine', 'Smart combine (CapCut AutoCut), on this Mac: from several videos, the best-looking part of every scene, ordered '
                      '(order: auto | story = by what each shot shows | shot = as filmed), fitted to length seconds (0 = all the good parts), '
                      'cut to the music\'s beats, transitions chosen from what changes between shots. style: balanced | energetic | calm | cinematic. '
                      'Builds and opens a new project.', S({'media': {'type': 'array', 'items': txt}, 'length': num, 'style': txt, 'order': txt, 'music': txt,
                                                            'ratio': txt, 'sound': boo, 'title': boo}, ['media']), 'smart_combine'),
    ('preview_object', 'Before remove_object / cut_out_object: SAM 2 outlines what the box covers at time t and the editor shows it tinted pink on the frame. '
                       'Returns that frame as an image plus the outlined area, so you can check the pick (and adjust the box) before the slow job runs.',
     S({'id': txt, 'box': {'type': 'object', 'properties': {k: num for k in 'xywh'}, 'required': list('xywh')}, 't': num, 'mode': {'type': 'string', 'enum': ['remove', 'cutout']},
        'candidate': {'type': 'integer', 'description': 'which outline: 0 = smallest part ... last = the whole thing (default: the best fit for the box)'},
        'points': {'type': 'array', 'items': {'type': 'array', 'items': num}, 'description': 'spots as [x, y, 1 = take it in | 0 = leave it out], canvas fractions; one outside the box grows it (a beard under a head box)'}},
       ['id', 'box']), 'preview_object'),
    ('remove_object', 'Remove an object from a video clip, on this Mac: box = where it is on the canvas as fractions {x, y, w, h} '
                      '(read it off a snapshot at time t); it is tracked through the whole clip and the background filled in. '
                      'After preview_object with the same box it takes exactly the outline shown. The clip switches to a cleaned copy. quality: best (SAM 2 exact outline + ProPainter, about a minute per 4 s) | fast (seconds).',
     S({'id': txt, 'box': {'type': 'object', 'properties': {k: num for k in 'xywh'}, 'required': list('xywh')}, 't': num, 'quality': txt}, ['id', 'box']), 'remove_object'),
    ('transcript', "Timestamped sentences of a library item's speech (on-device whisper, cached). Use it to pick moments yourself, then add_clip with in/out.",
     S({'media': txt, 'lang': txt}, ['media']), 'transcript'),
    ('make_shorts', 'Long video -> shorts on this Mac: a local language model picks the best moments; each becomes a new 9:16 project with captions, face reframing and a hook title. '
                    'min/max = length range in seconds.',
     S({'media': txt, 'count': {'type': 'integer'}, 'min': num, 'max': num, 'captions': boo, 'reframe': boo, 'title': boo, 'lang': txt}, ['media']), 'make_shorts'),
    ('translate_captions', 'Translate the captions on the timeline into another language (local model). Word highlight keeps working. '
                           'bilingual=true keeps the original and adds the translation as a second line under each caption.', S({'to': txt, 'bilingual': boo}, ['to']), 'translate_captions'),
    ('caption_extras', 'Smart caption layers, made on this Mac: keywords=true (the local model picks 1-2 key words per caption, drawn in the highlight colour), '
                       'emoji=true (one emoji per sentence, above its first caption), speakers=true or a count (who speaks each caption: local speaker embeddings, '
                       "'Speaker 1/2' label + a colour each), bilingual=<language> (second translated line). show={kw, emoji, spk, bi} turns made layers on or off.",
     S({'keywords': boo, 'emoji': boo, 'speakers': {'type': ['boolean', 'integer']}, 'bilingual': txt, 'show': obj}), 'caption_extras'),
    ('clone_voice', 'Clone the voice in a clip ON THIS MAC (Chatterbox, MIT): ~10 s of its speech from the playhead (or the clip start). consent=true is REQUIRED and means '
                    'the speaker agreed to be cloned; never set it on your own, ask the user. clip = a clip id (default: the selected one). '
                    'Returns the voice with similarity (speaker-embedding cosine to the clip) and baseline (the closest stock voice).',
     S({'clip': txt, 'consent': boo, 'name': txt}, ['consent']), 'clone_voice'),
    ('voices', 'The cloned voices (id, name, similarity) and the languages dub_video speaks (code: name).', S({}), 'voices'),
    ('dub_video', 'AI dubbing ON THIS MAC: captions (made first if there are none) -> translated -> spoken in a cloned voice, each sentence fitted to its '
                  'time (0.8-1.25x; too long = said shorter), as a new audio clip; the clips\' own sound is ducked (original=duck) or muted (mute). '
                  'lang = a code from voices (es, fr, de, ...); voice = a cloned voice id (default: the one picked in the AI tab). The captions become the translation.',
     S({'lang': txt, 'voice': txt, 'original': {'type': 'string', 'enum': ['duck', 'mute']}}, ['lang']), 'dub_video'),
    ('lip_sync', "Lip sync a main-track video clip to the dub under it, on the user's RTX 4090 PC (LatentSync 1.6): only the mouth region of the ORIGINAL "
                 'footage is re-made and pasted back, so the shot, its motion and everything outside the face stay as filmed. Any length (long clips run in '
                 'pieces); the clip keeps its length and switches to the new video (muted: the dub plays the sound). Fails clearly when the PC is off.',
     S({'clip': txt}), 'lip_sync'),
    ('talking_photo', "Make a portrait photo talk, on the user's RTX 4090 PC (Wan 2.2 S2V re-animates the still: head, face and all; ~1 min per 5 s, 30 s at most): "
                      'image + audio (library ids or names), or clip = a photo clip on the timeline (30 s at most, it keeps its length), which speaks the audio '
                      'clip under it and becomes the talking video. prompt = how they move.',
     S({'image': txt, 'audio': txt, 'clip': txt, 'prompt': txt, 'at': num, 'seed': {'type': 'integer'}}), 'talking_photo'),
    ('hook_titles', 'Three hook-title suggestions for the edit from its transcript (local model); add=true puts the first one at the start.', S({'add': boo}), 'hook_titles'),
    ('import_subtitles', 'Put an SRT or WebVTT subtitle file from this Mac on the captions track (replaces the captions there).', S({'path': txt}, ['path']), 'import_subtitles'),
    ('import_lut', 'Import a .cube colour LUT from this Mac (3D or 1D); then use it on a clip with update_clip grade.lut {id, amount}.', S({'path': txt}, ['path']), 'import_lut'),
    ('relink_media', 'Point every clip that uses a missing media id (it left the library) at another library item (id or name).', S({'missing': txt, 'media': txt}, ['missing', 'media']), 'relink_media'),
    ('multicam', 'Multicam: 2-6 recordings of the same moment (ids or names), lined up by their sound, as one main clip plus one continuous audio clip (the first one\'s sound). Then multicam_cut switches angles.',
     S({'media': {'type': 'array', 'items': txt}}, ['media']), 'multicam'),
    ('multicam_cut', 'Cut a multicam clip to angle (1-6) from time `at` (default: playhead) on: a split there, in sync.', S({'angle': {'type': 'integer'}, 'at': num}, ['angle']), 'multicam_cut'),
    ('compound_clip', 'Make several clips (ids; at least one main-track clip, the main ones next to each other) into one compound clip: rendered once into the library, one video to play instead of many. break_compound undoes it.',
     S({'ids': {'type': 'array', 'items': txt}}, ['ids']), 'compound_clip'),
    ('break_compound', 'Put a compound clip\'s original clips back where they were.', S({'id': txt}, ['id']), 'break_compound'),
    ('pilot', 'The editor\'s own command bar (⌘K): a plain-language instruction ("cut the silences, add captions in Bold") planned by the LOCAL model '
              '(qwen3.5 on this Mac) into these same tools and run step by step; called here the whole run is one undo step (in the editor\'s bar, one per step). run=false returns the plan only. '
              'Returns what was done, what failed and what it could not do (cant).', S({'text': txt, 'run': boo}, ['text']), 'pilot'),
    ('search_media', 'Smart search of the library by content: what the picture shows ("red car", "night", "two people"), what is said (transcripts) and how many people. '
                     'Returns the best moment per item (media id, t seconds, why picture|speech, text), best first, and how many items are not indexed yet; '
                     'index=true first describes those with the local vision model (slow the first time, cached).',
     S({'q': txt, 'index': boo}, ['q']), 'search_media'),
    ('seek', 'Move the playhead (seconds).', S({'t': num}, ['t']), 'seek'),
    ('scopes', 'Read the levels of the frame the preview shows (at the playhead): luma low/median/high in IRE (1st, 50th, 99th percentile), '
               'the share of clipped black and white pixels (%) and the mean R, G, B (0-255). Use it to judge exposure and colour casts before and after a grade. '
               'show=true/false opens or closes the scopes panel in the editor; kind wave|parade|vec|hist picks the scope shown.',
     S({'show': boo, 'kind': {'type': 'string', 'enum': ['wave', 'parade', 'vec', 'hist']}}), 'scopes'),
    ('history', 'Undo or redo the last edit.', S({'action': {'type': 'string', 'enum': ['undo', 'redo']}}, ['action']), 'history'),
    ('snapshot', 'Look at the video: returns the frame at time t (default: playhead) as an image, rendered by the export engine (exactly what the export will show). '
                 'preview=true returns the live editor canvas instead (faster, but blank video while the window is hidden).',
     S({'t': num, 'max': {'type': 'integer', 'description': 'longest side in px (default 720)'}, 'preview': boo}), 'snapshot'),
    ('export', 'Render the project. format mp4|hevc|av1 (AV1 in MP4)|av1webm|webm (VP9 + Opus)|prores|gif|mp3|m4a (AAC 256k)|wav|png|srt|vtt|txt|fcpxml|edl|chapters '
               '(png = still at `at`; srt/vtt = the captions, or the text clips, as subtitles; txt = one "[start --> end] text" line per caption; '
               'fcpxml = the whole timeline for Final Cut Pro / DaVinci Resolve; edl = a CMX3600 EDL of the main track; '
               'chapters = YouTube chapter lines from the markers, returned as `text`, with `notes` when YouTube would refuse them); '
               'resolution 720p|1080p|1440p|4K|8K (8K needs 16 GB of memory); quality fast|best; bitrate 1|1.6|2.5, or mbps = a custom bitrate in Mbps; '
               'fps 24|25|30|50|60|120 = the export frame rate (default the project\'s; above it frames repeat); light=true decodes on the media engine (less CPU); '
               'preset tiktok|reels|shorts|yt1080|yt4k|master fills format/resolution/fps/mbps/loudness, anything given explicitly wins. '
               'loudness: false | true (-14 LUFS) | -14 (social) | -16 (podcast) | -23 (EBU broadcast): one gain for the whole edit. '
               'show=true opens the result in the Mac\'s player when it is done.',
     S({'format': txt, 'resolution': txt, 'quality': txt, 'bitrate': num, 'mbps': num, 'fps': num, 'light': boo, 'preset': txt, 'name': txt,
        'loudness': {'type': ['boolean', 'number'], 'description': 'false, true (= -14), -14, -16 or -23 LUFS'}, 'at': num, 'show': boo}), 'export'),
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
    if name == 'import_lut':
        path = os.path.expanduser(args['path'])
        with open(path, encoding='utf-8-sig', errors='replace') as f:
            args = {'cube': f.read(), 'name': os.path.basename(path)}
    if name == 'import_subtitles':
        path = os.path.expanduser(args['path'])
        with open(path, encoding='utf-8-sig', errors='replace') as f:
            args = {'srt': f.read(), 'name': os.path.basename(path)}
    long = name in ('generate_video', 'multicam', 'compound_clip', 'export', 'generate_music', 'auto_captions', 'main_transcript', 'preview_object', 'cut_timeline', 'remove_fillers', 'clip_tool', 'clone_voice', 'dub_video', 'lip_sync', 'talking_photo', 'caption_extras', 'retouch', 'voiceover', 'remove_pauses', 'generate_image', 'ai_voiceover', 'make_shorts', 'translate_captions', 'hook_titles', 'transcript', 'remove_object', 'smart_combine', 'cut_out_object', 'track_motion', 'blur_region', 'blur_faces', 'auto_reframe', 'pilot', 'search_media')
    r = remote(CMD[name], args, timeout=3600 if long else 120)
    res, log = r.get('result'), r.get('log') or []
    if name == 'snapshot':
        return [{'type': 'image', 'data': res['image'], 'mimeType': 'image/png'}, {'type': 'text', 'text': f"preview at {res['t']} s"}]
    if name == 'preview_object':
        return [{'type': 'image', 'data': res['image'], 'mimeType': 'image/png'}, {'type': 'text', 'text': json.dumps({k: v for k, v in res.items() if k != 'image'})}]
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
        return send({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': [t for t in SCHEMAS if t['name'] not in GPU_TOOLS or gpu_up()]}})
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
