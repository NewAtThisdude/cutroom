# Cutroom

A local, CapCut-style video editor for Mac. Everything runs on this Mac: no account, no uploads,
no watermark, and no cloud AI (CapCut's captions go to its servers; Cutroom's don't).

## Run it

- Double-click **~/Applications/Cutroom.app**: a native Mac window (AppKit + WebKit). If a Cutroom server
  is already running it uses it; otherwise it starts one and stops it again when you quit (never at login).
  Rebuild it after editing `app/Cutroom.swift` with `app/build.sh`. `~/cutroom/cutroom` still opens the
  editor in a Chrome app window instead.
- Self-check after any engine change: `env -u PYTHONPATH python3 -I server.py --selftest` (about 3 min).
  It renders synthetic projects through both render paths and checks the results pixel by pixel:
  all 31 transitions, video effects (frame-exact ranges, per-frame values), keyframes (deep, eased and partially eased),
  opacity, blend modes, chroma key, masks, HDR, colour tags, every export format, beats, voiceover, freeze frames,
  silence detection and caption timing.

Requirements: Homebrew `ffmpeg` and `whisper-cpp`, and the Xcode command-line tools (`swiftc`) for the app
and the Apple Vision helpers (built automatically on first use). Chrome is only needed for the
`cutroom` launcher. The whisper model is reused from Voicify (`ggml-large-v3-turbo-q5_0.bin`); override it
with `CUTROOM_MODEL=/path/to/ggml-*.bin`. `CUTROOM_PORT` and `CUTROOM_HOME` work for the app, the launcher
and the server.

Data lives in `~/Movies/Cutroom/`:
- `media/`: imported copies (a file opened from this Mac is an APFS clone: instant, no extra space)
- `projects/`: one JSON per project
- `exports/`
- `cache/`: filmstrips, waveforms, proxies, transcripts, beats
- `sfx/`: the synthesized sound effects (made on first use)
- `packs/`: the CC0 sound and music library (`index.json`: each file's source URL, licence and SHA-256)
- `models/`: Silero VAD
- `trash/`: deleted projects and media, recoverable
- `server.log`

## Heavy footage and smaller Macs

Cutroom adapts to the Mac it runs on (cores and memory, read at start; `CUTROOM_CORES` / `CUTROOM_RAM_GB` fake a smaller
one for testing). `tests/perf_heavy.mjs` measures import, playback, seeking and a 1080p export on any files.

- **Proxies** (CapCut's "proxy media"): 4K and anything past 1080p60, all HDR, ProRes, camera 4:2:2 and 10-bit H.264
  (Sony XAVC S-I, Canon, Panasonic) get a 720p H.264 copy with a keyframe every second for the preview. Exports always
  read the originals. An HDR proxy is tone-mapped by the export's own chain, so the preview shows the export's colours.
  Proxies are decoded by the media engine (VideoToolbox) except for H.264 on 12+ core Macs, where the CPU is faster;
  every import job runs at low priority (`nice`), one at a time on smaller Macs (two on big ones). The library shows
  how far each file has got. An import interrupted by quitting is finished at the next start.
- **Imports** from the app's Import button, drag and drop, Finder and the Dock are APFS clones (instant, no extra disk);
  folders (a camera card's DCIM) bring in the media inside them. Filmstrips of files past a minute decode keyframes only.
- **Exports** with many clips render in chunks sized to the memory: 6 main clips per ffmpeg graph on 8 GB, 12 on 16 GB,
  24 above. Decoders run by the media engine get one ffmpeg thread (more only held frames). On smaller Macs, 4K inputs
  decode on the media engine and the cores do the filtering.
- **Playback** waits for the main video when WebKit stalls it, instead of running on and seeking it again (that loop
  showed 15-18 of 30 frames a second on a plain 1080p clip); the other tracks wait with it. The timeline renders only
  what's in view.
- **Sound in the preview** doesn't come from the video elements. Routed through Web Audio (needed for volumes over
  100 % and the voice effects), a `<video>`'s sound starts ~0.3 s late in WebKit and holds the picture meanwhile: an
  edit of 2 s shots stalled 280 ms at every cut (49 of 60 frames a second). Videos play muted; each clip's sound is
  4 s Web Audio buffers of a 48 kHz PCM copy made at import (`/media/<id>?pcm=<tempo>`; a kept-pitch speed gets the
  export's `atempo` copy), started on the audio clock at the moment it reaches the speakers. The clock picks up where
  the picture really is when it starts or drifts, and the next cut's video starts 0.3 s early, unseen.
  `tests/av_sync.mjs` checks a flash-and-beep clip across a jump cut and a 2x clip: within 45 ms, mostly under 15.
- **Feel**: `tests/perf_feel.mjs` times input to picture on a real project (scrub, jump, play, select, sliders, drags,
  undo, tabs, zoom). On the 16-shot 4K60 night-drive edit: 59 of 60 frames a second with no stall over 100 ms; every
  interaction without a frame over 50 ms. The ruler's ticks were a CSS repeating gradient, which WebKit repaints
  stripe by stripe: after playback, zooming the timeline froze for 0.6-1.5 s at a time. They're an SVG pattern now.
- **On-device AI** picks the language model that fits (qwen3.5:4b below 16 GB, 9b above) and unloads it right after
  on small Macs; image generation needs 12 GB or more (setup skips its download below that); ProPainter starts at
  512 px in smaller batches below 16 GB.

Measured on this M4 Max (14 cores, 36 GB) with synthetic camera files: a DJI-style 4K60 100 Mbit/s H.264 clip (30 s),
an iPhone-style 4K60 10-bit HLG HEVC clip (30 s), 4K30 ProRes 422 HQ (10 s) and a 10-minute 1080p30 file. "Small-Mac
settings" is this Mac running with an 8-core, 8 GB Mac's settings: same chip, so the speeds are this Mac's; the memory
and CPU shares are what carry over.

| | Before | After (this Mac) | After (small-Mac settings) |
|---|---|---|---|
| Import all four at once | 46.7 s, 2.4 GB peak in ffmpeg | 14.9 s, 0.75 GB | 35 s, 2.6 cores, 0.26 GB |
| Play the 4K60 DJI clip | 24-37 of 60 frames/s | 57-60 of 60, 0.4 cores | 60 of 60, 0.45 cores |
| Play the 4K60 HDR clip | 33 of 60, 1.6 cores | 51-60 of 60, 0.4 cores | 59 of 60, 0.45 cores |
| Play the plain 1080p30 file | 15-18 of 30, 0.9 cores | 30 of 30, 0.45 cores | 30 of 30, 0.45 cores |
| Export all four back to back (11 min) at 1080p30 | 59 s, 7.3 cores, 1.5 GB | 62 s, 6.6 cores, 1.3 GB | 71 s, 5.2 cores, 0.7 GB |
| Export 40 cuts of 4K + a 4K overlay at 1080p | 4.5 GB peak | 4.5 GB, 28 s | 1.3 GB, 40 s |
| Edit a 1,200-clip timeline (one change) | 116 ms | 6 ms | 6 ms |

## Features

The preview and the export share one geometry, colour and text pipeline. Rendering the same frame both ways
and comparing pixels gave 0–2 levels of difference for transitions, clip animations, filters, masks and
blend modes, about 2.6 levels for text, and 0.5–5 levels for the video effects, in Chrome and in WebKit (the app's engine).

The window works like CapCut's: a library rail on the left (Media, Audio, Text, Stickers, Effects, Transitions,
Filters, Captions, Script, AI), each opening a gallery whose tiles show what they do (effects and transitions animate; with
Reduce motion on they show a still and move when you point at them), the preview with its transport in the middle,
the selected clip's settings on the right, and the timeline with a toolbar (split, delete, duplicate, freeze, reverse,
mirror, rotate, remove pauses and fillers, fit) below.

| | Feature | How |
|---|---|---|
| Edit | **On-canvas handles**: drag a corner of the selected text, sticker or clip to scale it, the knob above it to rotate (snaps to straight; ⌥ for free) | One undo step per drag; with keyframes, the change lands on the keyframe under the playhead |
| | **Right-click menus** on clips, cuts and the preview; **multi-select** (⇧ / ⌘-click: delete, copy or drag several clips at once); ⌘A selects all | |
| | **Copy / cut / paste** clips (⌘C ⌘X ⌘V, at the playhead) and **paste look** (⌥⌘V: filter, adjustments, animations, mask, key; or a text's style) | |
| | **Q / W**: delete what is left / right of the playhead in a clip; **F**: theater view (the preview fills the window) | |
| | **Edit by script**: the main track's words; click a word to jump there, select words or a pause and press ⌫ to cut them out of the video. Captions made from speech re-make themselves after every cut (also after Remove pauses / fillers) | Words from the cached on-device transcript, mapped through each clip's in/out/speed; cuts land at the middle of the pauses around the words |
| | **Tracks**: drag overlay, audio, text and effect clips up or down onto other tracks (a higher overlay track draws on top); hide (mute) or lock any track | A clip keeps its track; one that would overlap another there moves a track up. Hidden tracks leave the preview and the export alike |
| | **Multicam**: 2-6 recordings of the same moment, synced by their sound; play and press 1-6 to cut between angles | GCC-PHAT on the samples (numpy, in the AI venv): within a sample on clean audio, robust across different mics. One continuous sound track from angle 1 |
| | **Compound clips**: select clips (main ones next to each other, plus overlays/text over them) and make them one; Break apart puts them back | Rendered once into the library (Apple's hardware encoder): one video to decode instead of several, lighter on the Mac. The originals ride along in the compound for Break apart |
| | Magnetic main track, plus overlay, audio, text and caption tracks | Overlapping clips stack into rows. Drag to move or reorder; edge-drag to trim. Both snap to the playhead, clip edges, markers and beats. Keyframes, volume envelopes and word timings stay on their content when you trim, split, change speed, remove pauses, ramp or freeze |
| | 31 transitions in an animated gallery: dissolve, dip to black / white / grey, noise, pixelate, blur, zoom, wipe and soft wipe and slide in 4 directions, squeeze, circle open and close, clock, doors, split open, diagonals, slices, blinds. Click one to put it on the selected cut (or the one nearest the playhead), or on every cut | The clips overlap (`xfade` + `acrossfade`). The preview reimplements xfade's per-pixel maths from its source (weights, noise, block sampling, box blur), within 0.2–3.4 levels of the export |
| | **30 video effects** on their own Effects track, with strength: shake, earthquake, beat zoom (follows detected beats), slow zoom, flash, strobe, blink, dreamy glow, VHS, old film, film grain, black & white, sepia, glitch, RGB split, pixelate, blur, invert, mirror, split ×4, snow, rain, sparkles, hearts, confetti, bubbles, cinema bars, camcorder, vignette, film strip | Each effect is pixel steps the export runs on everything under the text layer, on exact frame ranges (`enable='between(n,a,b)'`, per-frame values through `sendcmd` or expressions), and/or an overlay drawn into the text layer by the same canvas code as the preview. Grain is random in both, so it matches in strength, not pixel for pixel |
| | Keyframes for scale, position, opacity and rotation, linear or eased per keyframe, with previous/next jumps | ffmpeg per-frame expressions built as a balanced tree (ffmpeg's parser stops at about 100 nesting levels), so tracking with hundreds of points exports fine. Cutting through an eased segment keeps the exact curve |
| | Clip In/Out animations: fade, zoom in/out, slide in 4 directions, rotate, spin, each with its own length | Applied live in the preview and baked into per-frame keyframes for the export, on top of your own keyframes |
| | Speed 0.1×–10× on a continuous slider, optional pitch change; speed ramps; reverse; freeze frame | Change pitch uses `asetrate` in the export and `preservesPitch=false` in the preview |
| | Typed values | Click any slider's value to type an exact number |
| Look | Canvas 9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 21:9; fit, fill or blurred-background fill | One geometry function drives the preview and the export |
| | 17 filters in a gallery that shows them on the frame at the playhead, with strength; brightness, contrast, saturation, temperature, tint | One colour matrix shared by the preview and the export. A filter tile applies to the selected clip, or to the whole main track |
| | **Auto adjust** (one click: exposure, contrast, white balance) and **Match colour** to another clip | Solved from the clip's own pixels with the preview's exact grading maths (contrast/exposure for the brightness spread, then temperature/tint for the colour balance); auto adjust stays gentle and goes 70% of the way on white balance |
| | Crop, mirror, rotation, opacity on any clip, chroma key with a colour picker | The picker reads the clip's own graded pixel under the click. The key uses ffmpeg `colorkey`'s exact formula |
| | Masks: circle, rectangle, linear, mirror; feather and invert; **keyframed** (Animate the mask) | One canvas routine draws the preview and the export's mask PNG; a keyframed mask exports as a frame sequence (repeats reused) |
| | **Colour grading** (Color tab): shadows / midtones / highlights wheels with levels, curves (luma, R, G, B), HSL for 8 colours, imported **.cube LUTs** with strength, and **strength over time** for all of a clip's colour | Baked into one 33-point 3D LUT that the preview applies on the GPU and the export through `lut3d` (trilinear both): the same table, so they agree by construction (parity 0.8-1.7 levels) |
| | **Scopes**: waveform, histogram, vectorscope over the preview | Drawn from a 256 px copy of the frame, only while open |
| | **Beauty** (smooth skin), per-clip **blur**, **glow / neon** around cutouts, **body effects** (blur, mono or dim the background behind a person; glow or neon around them) | Skin: luma bilateral mixed in by a skin-colour key (`bilateral` + `chromakey` in the export, one GPU pass in the preview). Body effects cut the person out with Apple Vision (only the part of the clip used) onto the track above |
| | Overlay blend modes (11) and bring forward / send backward | Canvas `globalCompositeOperation` in the preview; the export runs the same W3C formulas through `lut2` (ffmpeg's own `blend` modes differ) |
| | Stabilize, auto reframe, HDR iPhone footage | `deshake` plus an 8% zoom; Apple Vision faces as eased keyframes; HLG/PQ tone-mapped by VideoToolbox, freeze frames too |
| Text | 8 **text templates** (title + subtitle, lower third, countdown, subscribe, quote, big number, breaking news, hook): several animated layers at once | Plain text clips: every layer stays editable |
| | 15 text styles shown as tiles (title, neon, glow, gradient, retro, comic, marker, bubble, minimal...), 4 bundled fonts plus system fonts with their real weights | Italic, alignment, letter spacing, line height, outline, shadow (colour, opacity, blur, offset), background (colour, opacity, roundness, padding), gradient fill. One `drawText()` renders the preview and the export layer |
| | In/out animations (pop, fade, slide, zoom, drop, typewriter) with adjustable length, and loops (bounce, pulse, wiggle) | |
| | Stickers: about 190 emoji in 7 groups, plus AI stickers (describe it; drawn on this Mac and cut out) | Emoji are text clips, so they animate like text |
| | Auto-captions with word-by-word highlight and pop, 4 styles, 18 languages plus auto-detect; every line editable in a list | whisper.cpp on-device, with DTW word timing and a Silero VAD filter. It asks before replacing captions on the timeline |
| AI and audio | Remove background (people), motion tracking | Apple Vision segmentation (transparent VP9 WebM) and object tracking (keyframes that keep the clip's rotation) |
| | Voiceover from the Mac's voices or the microphone | `say`; MediaRecorder while the timeline plays muted |
| | Beat detection and beat sync | Onsets, tempo and dynamic-programming beat tracking |
| | 19 sound effects (whoosh, swish, riser, boom, bass drop, pop, click, ding, notification, correct, wrong buzzer, camera shutter, typing, heartbeat, glitch, cash register, drum roll, applause, tick tock), each with a listen button | Synthesized on this Mac by `server.py` (band-passed noise sweeps, FM bells, pitch-swept sines), deterministic, no sample packs or downloads. Added once to the library, then reused |
| | **Sound library**: 606 CC0 sound effects in 9 categories (impacts, footsteps, interface, clicks, game, sci-fi, casino, foley, jingles) and 22 CC0 music tracks in 10 moods, with search, categories, listen and duration | Downloaded once (`server.py --packs`, `ai/setup.sh`, or the Audio rail's button; ~100 MB): Kenney's audio packs (each zip pinned by SHA-256 and its CC0 `License.txt` checked) and Komiku / Loyalty Freak Music tracks from archive.org (the item's CC0 licence re-read and each file's SHA-256 checked at install). A source that no longer matches is left out. `packs.json` pins them; the library item keeps its source and licence |
| | **AI music** from a description or a style (upbeat pop, lo-fi, cinematic, hip hop, EDM, acoustic, corporate, ambient, funk, trap), 4-60 s; smart combine can make its own ("AI music, made to fit": the style's sound, as long as the edit) | MusicGen on this Mac, faster than real time. Detected beats drive the cuts like any song's |
| | Volume in dB (mute to +20 dB), fades you can hear in the preview (drag the round knobs on a clip's top corners, or the Fade sliders), auto-duck from −6 to −24 dB under speech on any track | The duck envelope multiplies the clip volume, so the Volume slider keeps working after auto-duck |
| | Remove pauses, reduce noise, export loudness −14 (social) / −16 (podcast) / −23 LUFS (EBU) or off, detach audio, smooth slow-mo | `silencedetect`, `afftdn`, `loudnorm`, `minterpolate` |
| | **Sound per clip**: voice effects (chipmunk, deep, robot, echo, hall, telephone), pitch in semitones that keeps the timing, 3-band EQ (bass 100 Hz, mid 1 kHz, treble 8 kHz, ±12 dB), pan, volume points you set at the playhead (drawn on the clip), **split into stems** (vocals, drums, bass, other: four clips in sync) | The preview runs the export's chain in Web Audio: the EQ shelves are the Web Audio spec's biquads, sent to ffmpeg's `biquad` as coefficients (its own `bass`/`treble` overshoot); pan is StereoPanner's equal-power formula as `pan`; the hall is one seeded impulse response for both `ConvolverNode` and `afir`. Exported WAV vs the preview's own chain rendered offline: 64-86 dB SNR for every setting (`tests/audio_e2e.mjs`). Pitch: an AudioWorklet in the preview, `asetrate`+`atempo` in the export (same note, not the same samples). Stems: Demucs htdemucs; they add back up to the original at 24 dB SNR |
| | **Studio voice** (off / on / with the music removed first) and **8 voice characters**: elf, giant, monster, alien (pitch and formants moved apart), radio, megaphone, cave, underwater | Rendered on this Mac into the clip's sound file, which the preview plays and the export reads (export vs preview: 184-188 dB SNR, the same samples). Studio voice: RNNoise (lag taken out), rumble cut, de-ess, a downward expander, a compressor, presence EQ, one gain to −16 LUFS; nothing looks ahead (0 samples of delay). Studio + remove music runs Demucs first. Characters: the WORLD vocoder (pyworld) for elf/giant/monster/alien, ffmpeg filters for the rest; each is set back to the loudness (LUFS) it went in at, true peak under −1.5 dBTP (`tests/audio_packs.mjs`) |
| Timeline | Markers (M), mute/hide per track, Home/End, frame steps | |
| Output | MP4 (H.264, HEVC), MOV (ProRes 422), GIF, MP3, WAV, PNG still; 720p to 4K; three quality levels (VideoToolbox constant quality) or a custom bitrate; 23.976 to 60 fps | Composited in RGB like the canvas, then one tagged BT.709 conversion, so players show the right colours. PNG and GIF stay RGB |
| Library | Templates, project duplicate and delete, media delete (to trash), proxies for ProRes, MKV, AV1, GIF and footage past 1080p60 (720p; exports read the original), HEIC import | |
| Pro colour and motion | Exposure, highlights, shadows, fade, vignette; combo motion (Ken Burns in/out, drift, pulse, shake, sway, float); typewriter / backspace text | One 256-entry tone curve: an `feComponentTransfer` table in the preview, `lut1d` in the export. Vignette: the same multiplier map drawn by the browser |
| Cleanup | Remove filler words (um, uh, er, hmm), split at scene changes, speed up to 100× | Fillers come from the on-device transcript and are cut at the middle of the pauses around them |
| On-device AI | Text-to-image and stickers, natural AI voiceover in 9 languages, background removal for photos (any subject) | Z-Image-Turbo (4-bit, MLX), Kokoro-82M (MLX), Apple Vision subject lifting. All on this Mac; see below |
| | **Remove object** from video: drag a box round it at any frame; Best first shows SAM 2's outline of it on that frame (tinted pink, about 2 s). A box is ambiguous between a part and the whole (hair, head, head and neck): Cutroom picks the outline that fills the box without spilling out of it, **Smaller / Bigger** step through the others, and a click on the picture adds a spot (⌥-click leaves one out); a spot outside the box takes in what's there too, like the beard under a head box. Remove it then follows exactly that outline through the clip | **Best:** SAM 2 traces the object's exact outline from the box, through the whole clip and behind things that cover it. On a still camera the hole is filled with the real background from the frames that show it (exact, sharp), and ProPainter fills what no frame shows; on a moving camera ProPainter fills it all, its optical flow handling parallax and blur. **Fast:** the box tracked by Apple Vision, filled from other frames with texture synthesis for the rest, in seconds. Poisson blending hides exposure seams. `ai/remove.py` |
| | **Cut out object**: any subject, not only people | Box it once; SAM 2 follows its outline through the clip and the clip becomes it on a transparent background (soft edges, VP9 alpha) |
| | **Isolate voice / Remove voice** | Demucs (htdemucs) splits a clip's sound into the voice and everything else; the result goes on the audio track, locked to the clip, and the clip is muted |
| | **AI video**: animate a photo, or a video's frame, into ~5 s of video | Wan 2.2 14B image-to-video (Lightning, 4 steps) on the RTX 4090 PC through an SSH tunnel, so the Mac stays cool: about 2 minutes, plus a minute to start ComfyUI there. Cutroom stops that ComfyUI 10 minutes after the last video, and when it quits |
| | Subtitles: import SRT / WebVTT onto the captions track, export SRT; **relink** clips whose file left the library (restore from trash, another file, or a library item) | |
| | **Smart combine**: tick several clips and get one edit | Every scene of every clip is scored 4× a second for sharpness and exposure (ffmpeg `blurdetect`, `signalstats`), and the local vision model describes its best frame. Cutroom keeps the best window of each scene, orders the shots (a story from what they show, or as filmed), fits them to the length, snaps the cuts to the music's beats and picks each transition from what changes: a hard cut inside one take, a dip to black or white on a big brightness jump, the style's transition between places. Shots of another shape fill the canvas with face reframing. Styles: balanced, energetic, calm, cinematic |
| | **Long video → Shorts**, caption translation, hook titles | A local language model (Ollama, qwen3.5:9b) reads the on-device transcript. Shorts: its picks snap to sentence edges, and each becomes a 9:16 project with face reframing, captions and a hook title. Translation works on whole sentences, then re-cuts them into captions over the same time (by character for Chinese and Japanese) |
| Claude Code control | Tell Claude Code in VS Code what to do and it edits the open project | The Cutroom MCP server (see below) |

## Control it from Claude Code (MCP)

`mcp/cutroom_mcp.py` is an MCP server (stdlib only). It is registered for every Claude Code session on this Mac:

    claude mcp add -s user cutroom -- env -u PYTHONPATH /opt/homebrew/bin/python3 -I ~/cutroom/mcp/cutroom_mcp.py

Then ask in plain words, for example "open the demo project, remove the pauses, add bold captions, put a dip-to-white
between every clip and export 1080p". Claude reads the timeline, edits, looks at the result (the `snapshot` tool returns
the preview frame as an image), and exports. The 41 tools cover projects, media import, clips (add, update any setting,
split, delete, duplicate, move), text, transitions, video effects (`add_effect`), sound effects (`add_sound_effect`), the main track's words
(`main_transcript`) and ripple cuts by time (`cut_timeline`, so "cut the sentence about X" works), captions, pause and filler removal, voiceovers, the smart tools,
undo/redo, snapshots, export, on-device image, voice and music generation (`generate_music`), object removal (`remove_object`: Claude reads the
object's position off a snapshot, and `preview_object` returns the frame with the outline it would take tinted pink), `cut_out_object`, voice isolation (`clip_tool`), `smart_combine`, `transcript`, `make_shorts`, `translate_captions` and `hook_titles`.

How it works: tool calls go to Cutroom's server (`/api/remote`), which hands them to the open editor page. The page runs
them with the same functions as the buttons, so every change is visible live and is one undo step. Delivery is
acknowledged, so a page reload can't lose a command. If no editor is open, the first call opens the app. The app keeps the
editor running while it is behind other windows (WebKit would otherwise suspend it), and `snapshot` renders the frame
with the export engine, so it shows exactly what the export will, even while the window is hidden.

## On-device AI

Everything runs on this Mac (M4 Max, 36 GB); nothing is uploaded. One-time setup: `ai/setup.sh`. The image model
downloads about 32 GB once; after the 4-bit copy is saved (5.5 GB in `~/Movies/Cutroom/ai`) the originals are deleted, so
about 6 GB stays. The language-model features use Ollama (`ollama pull qwen3.5:9b`, 6.6 GB); Cutroom starts it when needed.
`setup.sh` also installs SAM 2 (Meta, Apache-2.0) and ProPainter (S-Lab licence: personal, non-commercial use) from their
official repos at pinned commits into `ai/vendor` (0.7 GB with weights, every weight file checked by SHA-256), Demucs,
pyworld 0.3.5 (MIT; the WORLD vocoder, for the voice characters), the CC0 sound library (`server.py --packs`),
and for AI enhance (`ai/enhance.py`) RIFE 4.25, Real-ESRGAN x4v3 and Depth Anything V2 Small (about 130 MB, also checked).

| | Model | Measured here |
|---|---|---|
| Text to image (AI tab, `generate_image`) | Z-Image-Turbo 6B, 4-bit, via mflux on MLX | 1024² in about 48 s (8 steps); a 4-step draft in about 27 s |
| Stickers | the image above + Apple Vision subject lifting | the prompt asks for a plain backdrop so the cut-out is clean |
| Natural voiceover (AI tab, `ai_voiceover`) | Kokoro-82M via mlx-audio, 54 voices in 9 languages | 7.7 s of speech in about 5 s, most of it model load |
| AI music (Audio tab, `generate_music`, smart combine "AI music, made to fit") | MusicGen small (Meta; weights CC-BY-NC 4.0, so personal use) via transformers on the GPU; past 30 s it continues from the last 10 s | 10 s in 11 s and 45 s in 41 s, model load included; asked for 120 BPM, the beat measured 121 |
| Background removal for photos | Apple Vision `VNGenerateForegroundInstanceMaskRequest` | under a second; any subject, not only people |
| Remove object, Best | SAM 2.1 small (bf16 on the GPU, about 5 frames/s) + ProPainter (half precision, about 0.6 s per frame of a 720 px crop) | 4 s of 720p: about 30 s on a still camera, 1-2 min on a moving one. SAM 2's outline of a walking fox: 0.94 IoU against the true silhouette. Fills against the clean footage: 41-44 dB where other frames show the background; a handheld shot of a cyclist behind trees came out clean |
| Remove object, Fast | Apple Vision tracking + OpenCV (no model) | 4 s of 720p in about 11 s; 40-44 dB on still or planar shots, seams on real handheld pans, texture synthesis for hidden areas |
| Cut out object | SAM 2.1 small | 4 s of 720p in about 23 s; alpha vs the true silhouette: 0.94 IoU |
| Isolate voice | Demucs htdemucs (GPU) | 20 s of sound in about 3 s; speech under loud music went from -7.9 to 12 dB SI-SDR, the music tones down 30-44 dB |
| Smooth slow-mo, AI (Tools tab, `clip_tool smooth_slowmo`) | RIFE 4.25 (Practical-RIFE, MIT; model file from vs-rife, MIT), half precision on the GPU; Fast = ffmpeg `minterpolate` | real iPhone 120 fps clips with every other frame dropped, the frames made back vs the dropped ones: a person walking 39.1 dB / SSIM 0.976 (minterpolate 32.4 / 0.949), a handheld portrait 44.2 / 0.985 (43.4 / 0.984); 4x of 1.5 s of 1080x1920 60 fps in 22-29 s |
| AI upscale 2x / 4x (Tools tab, `clip_tool ai_upscale`) | Real-ESRGAN general x4v3 + its -wdn twin (BSD-3); 2x = the 4x result averaged | a GAN: sharper edges, lower fidelity than lanczos on a clean shrink (2x 40.2 vs 41.5 dB, 4x 36.8 vs 37.0 dB; fine detail 0.67x / 0.50x of the truth vs lanczos 0.54x / 0.35x); 270x480 -> 1080x1920 at 12 fps, 1080x1920 -> 4K at 1.6 fps |
| Relight (Tools tab, `clip_tool relight`) | Depth Anything V2 Small (Apache-2.0) per frame; a point light falling off in 3D on the surfaces facing it, or brighten subject / darken background, made to follow the picture's edges (guided filter) | 1080x1920 at about 10 fps; on a still shot it adds no flicker beyond the encoder's own (32 px blocks, 4 levels worst either way). Preview frame shows one frame first |
| Smart combine | ffmpeg picture statistics + qwen3.5:9b looking at one frame per scene | three clips (5 scenes): analysed and described in about 15 s the first time (cached after that), the edit built in about 3 s |
| Shorts, translation, hooks | qwen3.5:9b (Q4) on Ollama, thinking off | a 94 s talk: 3 shorts picked and built in about 8 s; 6 sentences translated in about 3 s |

The full-precision image model needs more than 30 GB while it loads and pushes a 36 GB Mac into swap (about 9 minutes
per image). That is why Cutroom keeps a 4-bit copy, which loads in about 4 s.


## How CapCut works (teardown of /Applications/CapCut.app 9.7.1)

Static triage only: bundle layout, linked frameworks, string literals and my own project file.
No decompiling and no CapCut code or assets copied. Cutroom is a clean-room build.

| CapCut layer | What the bundle shows | Cutroom's version |
|---|---|---|
| App shell | 217 KB launcher over 1.7 GB of frameworks. UI is **Qt 6.2.2 / QML**, plus ByteDance **Lynx** panels and an embedded **Chromium** (454 MB) for the asset-store web panels. Sparkle updates | HTML/CSS/JS in a Chrome app window (`web/`) |
| Edit engine | ByteDance **VE SDK**: `libVECreator` (352 MB), `libvideoeditor` (86 MB), `libcccreator` (132 MB business layer), separate `VEHelper.app` process | `server.py` builds one ffmpeg filtergraph per export |
| Decode / encode | **FFmpeg** dylibs, ByteDance's own **ByteVC1** decoder, dav1d | Homebrew ffmpeg + VideoToolbox |
| GPU render | **AGFX** on **Metal** plus **ANGLE** (`libGLESv2`), so mobile GLSL effects run on the Mac | canvas 2D in the preview, ffmpeg filters in the export |
| Effects | downloaded, encrypted packages (`libEffectPlatform`, `libres_pool`, `libvecryptor`) | built-in looks, transitions and presets |
| Project format | `com.lveditor.draft/<name>/draft_info.json`: plain JSON in **microseconds**. `tracks[] → segments[]`, each with `source_timerange` / `target_timerange`, referencing a `materials{}` registry of 55 kinds. Every draft also stores the Mac's `mac_address` / `hard_disk_id` | `projects/<id>.json`: lanes of clips referencing media by id, in seconds. Main clips snap to whole frames |
| On-device AI | ~75 `.model` files on ByteDance's **ByteNN** engine: matting, tracking, depth, frame interpolation, beats, denoise | Apple Vision (segmentation, tracking), whisper.cpp, Silero VAD, ffmpeg DSP |
| Auto captions | **cloud ASR** (`asr_online`, `/api/v1/asr/ws`). No speech model in the bundle | on-device whisper.cpp |
| Cloud | cloud drafts, uploads, AIGC, C2PA credentials, an AI agent on a bundled **Bun** runtime | none |

The design idea carried over is a plain declarative timeline that one engine renders. Cutroom splits that
engine in two. The browser draws the preview and the **text layer** as PNGs, using the same `drawText()` call
for both. ffmpeg composites and encodes. This Homebrew ffmpeg has no libass/freetype, and drawing text
once in the browser also guarantees the export matches the preview.

## Engineering notes (each one bit once and is now pinned by the self-check)

- **Caption timing:** whisper's default token times smear words into pauses (one word landed 0.9 s into
  a silence, so after pause removal its caption sat on the wrong clip). Cutroom uses DTW timing
  (`-dtw large.v3.turbo`, which needs `-nfa`), plus Silero VAD run separately. whisper invents text over
  music ("The end of the day is the end of the day."), and its own `--vad` reports DTW times on the
  silence-stripped timeline.
- **Keyframed size:** any pixel-format conversion **after** a per-frame `scale` freezes at the first
  frame's size and crops every later frame. Convert to `yuva420p` before the scale.
- **HDR:** VideoToolbox frames can't go through software autorotate, so it uses `-noautorotate` and
  applies `transpose` by hand. `-autorotate 0` is wrong: the flag is boolean, so the `0` becomes an
  output file.
- **Alpha:** the Vision matte is straight alpha (never pass `alpha=premultiplied`). Its colour tags are
  relabelled to the source's, or ffmpeg shifts the person's colours. VP9 alpha needs the `libvpx-vp9`
  decoder; the native one drops the alpha plane.
- **Transitions:** chain inputs need identical timebases (`settb=AVTB`). The clamp
  (≤ half the shorter clip) is shared by `trF()` (UI) and `overlap()` (server).
- **Colour:** the graph composites in RGB (`gbrp`) like the canvas, then converts once to tagged
  BT.709 YUV. It used to mix BT.601 conversions with untagged output, so players shifted colours.
  swscale's default *decoder* is about 4 levels off at widths like 270 or 1080, so the selftest reads
  pixels with `accurate_rnd`.
- **Opacity over time** is per-frame `colorchannelmixer` values fed by `sendcmd`, not a per-pixel `geq`.
- **WebKit** (the app) has no `ctx.filter` and drops VP9's alpha. Filters, the blur fill and mask
  feathering are done by hand there (`colorPass`, `featherAlpha`; the exported mask PNG is drawn the
  same way), and transparent clips get an HEVC-with-alpha preview copy (`/media/<id>?alpha=hevc`).
  WebKit also draws a `<video>` with plain source-over whatever the blend mode is, so blended overlays go through
  an offscreen canvas first; and on a frame's exact edge (5.3 - 5.0 = 0.2999…) it shows the frame before, so paused
  seeks land 0.1 ms in.
- **Untagged HD in the export** is relabelled BT.709 with `setparams`, followed by a bare `scale`: without it the RGB
  conversions ffmpeg inserts later (looks, colour, keys) still read the frames as BT.601 and every look shifted hues.
- **Rotation** fills with `black@0`, not `c=none`: "none" leaves an old frame in the corners, ghosts while it turns.
- **Preview vs export, pictures:** `tests/video_parity.mjs` grabs 147 frames both ways (every look, colour setting,
  blend, mask, transition, effect, text preset and clip animation): 0.2-3.1 levels apart on average. Blur, pixelate and the
  blurred background are close approximations in WebKit (2.4-8.5); grain and noise match in their block averages.
- **Every control:** `tests/fuzz_ui.mjs` works every inspector control for each kind of clip (sliders at both ends,
  every dropdown option), every gallery tile, context-menu item, shortcut, drag and window, and the Export window's own
  render; after each one: no uncaught error, console error, failed request or leaked error toast, the project still sane,
  the preview still paints, one undo puts it back exactly. Slow AI endpoints answer with a stub error there (their error
  paths), about 2,000 actions in 40 min.
- **Every MCP command:** `tests/mcp_e2e.mjs` runs each one as the remote loop does, with the real on-device models,
  and checks the result in the project, the library and the files (ffprobe): 101 checks in about 6 min. Tools that fail
  now say so: they used to show the error in the window and report success to the MCP caller.
- **The app restarts its server** if it dies (a crash, or killed to load new `server.py` code); the page carries on.
- **SAM 2 / ProPainter on the Mac:** ProPainter imports its own modules, so it runs with `-E -s`, not `-I`. SAM 2's
  progress bars can fill a pipe nobody reads, so they're off and the server reads one merged stream. The first run at
  a new size compiles GPU kernels (3x slower once). Picking the engine: when the camera holds still the copy from other
  frames is exact, but a moving camera changes blur and exposure between frames and the copies show seams, so moving
  shots go to ProPainter. A tight outline lets the walking object's own edges into the camera estimate and fakes
  parallax: the estimate excludes the outline's box. PyPI's `sam2` is not Meta's package.
- **GPU memory on a Mac is system memory:** PyTorch's GPU cache may grow to 1.7x the GPU budget before it frees
  anything, and stock ProPainter (full precision, 80-frame batches) took 30 GB on a head-sized hole and swapped the Mac
  for 15 minutes. Every AI job runs with `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.45` (the cache is freed at the cap, and a
  job that really needs more fails instead of swapping); ProPainter runs in half precision (the same fill: 0.1/255
  apart) in 40-frame batches, 3 s of 720p in about a minute, and again at 512 px if it still runs out.
- **Object removal:** OpenCV 5's `seamlessClone` overwrites the mask you pass it (the paste mask became a thin ring
  and the object stayed), so it gets a copy. Patch matching runs in BGR: in YUV it under-weights colour and pastes
  wrong-coloured chunks. Vision's tracking box drifts smaller, so the hole never shrinks below the box you drew.
- **Covered window:** while the app's window is behind others, WebKit decodes no video and throttles timers (a 40 ms
  sleep took about a second), so preview waits are bounded by wall-clock time and `preview_object` draws its outline
  onto the export renderer's frame.
- **Video effects:** a step that only covers part of the edit uses the filter's timeline switch on frame numbers
  (`enable='between(n,a,b)'`), not times: exact on every frame rate. Steps whose filters have no switch (mirror,
  split, zoom/shake, glow, grain) process a copy and overlay it with that switch. `rgbashift` moves the red plane right
  for a positive `rh`, and `pixelize` truncates its block averages; the preview does both the same way. Reading one
  frame back with input `-ss t` gives the first frame at or after t, so the self-check reads frame n at (n - 0.25)/fps.
- **Blend modes:** ffmpeg's `blend` filter disagrees with the W3C formulas that the canvas uses:
  soft-light is off by up to 31 levels, dodge and burn miss the edge cases, and "overlay" versus
  "hard-light" depends on input order. `lut2` with the W3C expressions matches within 0.5 levels, except colour
  burn, which follows WebKit (a clip at 0 wins over a backdrop at 255).

## Files

- `server.py`: stdlib-only Python, including `--selftest`. It covers the media library, byte-range
  serving, the ffmpeg render engine (`graph()`), whisper and VAD, beats, TTS, silence detection and the
  Vision jobs. It binds to 127.0.0.1 only and checks the Host header. Writes require `X-Cutroom: 1`,
  which forces a CORS preflight, so other websites can't drive it.
- `web/app.js`: the timeline model, undo, the preview engine (alternating `<video>` elements, transition
  layers, Web Audio), the editing UI and the export plan builder.
- `web/index.html`, `web/style.css`, `web/fonts/` (OFL fonts from Google Fonts).
- `tools/matte.swift`, `tools/track.swift`, `tools/faces.swift`: Apple Vision helpers, compiled on first use.
- `app/Cutroom.swift`, `app/build.sh`: the native app.
- `mcp/cutroom_mcp.py`: the MCP server for Claude Code.
- `ai/setup.sh`: installs the on-device AI (venv in `ai/.venv`, gitignored). `ai/remove.py`: the object-removal
  engine (runs in that venv). `tools/lift.swift`: Vision subject lifting.
- `cutroom`: the Chrome-window launcher (also downloads the VAD model if missing).

## Limits (honest)

- **Preview-only differences:** noise reduction and loudness are applied on export only, and are
  labelled that way. In the app (WebKit), the blurred background is a fast approximation; the export
  blurs for real. Chrome shows HDR its own way, while the export is tone-mapped.
- **Background removal:** people only (Vision person segmentation), frame by frame. Expect some edge
  flicker. It was verified on a 3D-avatar clip, not on a real person; hair edges are unverified. A cutout
  of HDR footage is not tone-mapped.
- **Motion tracking:** follows position only (not the target's scale or rotation). Verified on synthetic
  motion only.
- **HDR:** verified on synthetic HLG, including rotation. Real iPhone Dolby Vision metadata is ignored
  (its HLG base layer is used).
- **Speed ramps** are stepped (8 parts), and speed tops out at 10× (CapCut goes to 100×). Masks and filters
  are static (not keyframeable). A chroma key on a clip that is already transparent replaces its alpha in
  the export.
- **Stabilize** is ffmpeg `deshake`: basic, and it zooms in 8%. **Auto reframe** follows faces only.
- **Mic recording** is untested end to end: the test browsers have no microphone.
- **The app's** confirm/prompt dialogs, file picker, drag and drop, export player window and microphone
  prompt are wired up but were not clicked through on screen. Ad-hoc signing means macOS may ask for the
  microphone again after each rebuild. Quitting the app mid-export stops the export if the app started
  the server.
- **On-device AI:** image quality is close to the cloud generators, but each image takes 25-50 s. Kokoro sounds
  best in English; the other languages have fewer, plainer voices. A subject cut-out can drop thin details (steam,
  smoke). Video generation (image-to-video) is not built: on this Mac it would take minutes per few-second clip,
  well below CapCut's cloud quality. The 4090 box (Wan 2.2) is the better place for that.
- **Remove object:** Best is slower than CapCut's cloud on long clips (minutes for a 10 s handheld shot). ProPainter
  works on the crop at up to 720 px, so on 4K the filled area is a little softer than its surroundings. What no frame
  shows is the model's invention: convincing on walls, foliage, roads and shelves, but it can't know what was really
  there. The outline grows by 6 % of the object's size (at least 1.2 % of the frame) to take soft edges, stray hairs and contact
  shadows; long shadows and reflections stay. Something that never moves out of the way (a talking head) leaves only
  the model's guess of what was behind it: a plain wall comes out clean, the neck under a beard comes out a soft blur. Fast is
  the tracked box with texture synthesis, which repeats on busy detail. Tested on synthetic composites with ground
  truth, one real handheld clip (ProPainter's sample) and a talking head, not yet on your phone footage.
- **Cut out object:** edges come from SAM 2's mask at up to 1024 px, smoothed when scaled up, so fine hair on 4K is
  softer than a dedicated matting model would give.
- **Isolate voice** keeps singing as "voice"; Remove voice keeps everything else, including sound effects.
- **Audio timing:** ffmpeg's input seek in M4A files lands 800-2700 samples off (differently at each point), and MP3 seeks are approximate, so the export reads audio files from a lossless FLAC copy made at import (`cache/<id>.exact.flac`); MP4/MOV video sound seeks exactly. `atempo=1` is skipped (it wandered 7 ms on speech).
- **Preview pitch shift** adds up to 50 ms of delay while it is on, and is a simpler algorithm than the export's.
- **Edit by script** follows the main track only (not voiceovers on the audio track). Caption text you edited by hand is
  re-made from the transcript after a cut (undo brings your edits back). Words are as good as whisper's timing: a cut
  can clip a fast word's tail.
- **Auto adjust** looks at one frame (the playhead's, or the clip's middle), so a clip whose lighting changes a lot
  gets a grade for that moment. Match colour copies brightness and colour balance, not a full look.
- **Video effects:** 30, against CapCut's downloadable library of hundreds. In the app (WebKit) the blur and glow
  previews are a close stand-in (box blurs at reduced size; there is no `ctx.filter`), and grain is random, so the preview
  and the export match in look, not pixel for pixel. Effect and transition tiles show stand-in footage (a drawn sunset
  and night sea), not your clip; the filter tiles do show your frame.
- **Sound effects**: the 19 built-in ones are synthesized: punchy and clean for UI-style sounds (pop, click, ding,
  whoosh, riser, boom), plainer for applause and typing. The CC0 library adds recorded foley (Kenney), but no
  ambiences, crowds or weather, and 22 music tracks is a short list next to CapCut's catalogue.
- **Voice characters** are a vocoder's: WORLD re-synthesis is buzzier than the voice was, and it follows one voice;
  music or two people talking at once come out garbled. Studio voice without Demucs leaves music in (RNNoise is for noise).
- **Smart combine** judges a shot by sharpness and exposure and by what one frame of it shows; it doesn't hear speech or
  follow action, and the story order is the 9B model's call. Cuts move to the nearest beat. Transitions don't follow the
  camera's motion direction. The edit runs at the footage's frame rate (60 fps camera clips stay 60). Verified on synthetic
  clips and on real camera footage: three DJI 4K60 100 Mbit/s night-drive clips (7 min) made a 15-shot, 30 s edit in
  2.7 min (5 s again, cached), exported at 1080p60 in 13 s. Not yet on iPhone HDR footage.
- **Language model:** a 9B local model. Its picks for shorts were right on a clear multi-topic talk; hook titles sometimes
  ignore the word limit (two-clause titles are cut to the first clause). Translation is good in Spanish and Russian;
  Japanese had an occasional wrong word (Chinese 咖啡 for "coffee").
- **MCP control** needs the editor open (it opens the app itself). Commands run one at a time.
- **Not built:** AI avatars (a talking person from a photo and a voice): it needs a lip-sync model (Wan 2.2 S2V on the 4090 PC, or a paid cloud service).
- **The Apple GPU does the preview's per-pixel work** (colour, grade, key, mask, vignette, skin smoothing) in one WebGL2 pass; clip blur and the blurred background still run as small box blurs on the CPU at reduced size. Smooth skin finds skin by colour, not faces: skin-coloured walls get smoothed too.
- **Remove object** processes only the clip's range and only a crop around the object; ProPainter runs only over the frames that have something to fill (plus context), and the cleaned copy is encoded by Apple's hardware encoder. Reverse, stabilize and slow-mo renders use it too.
