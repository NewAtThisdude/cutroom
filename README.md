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
  transitions, keyframes (deep, eased and partially eased), opacity, blend modes, chroma key, masks, HDR,
  colour tags, every export format, beats, voiceover, freeze frames, silence detection and caption timing.

Requirements: Homebrew `ffmpeg` and `whisper-cpp`, and the Xcode command-line tools (`swiftc`) for the app
and the Apple Vision helpers (built automatically on first use). Chrome is only needed for the
`cutroom` launcher. The whisper model is reused from Voicify (`ggml-large-v3-turbo-q5_0.bin`); override it
with `CUTROOM_MODEL=/path/to/ggml-*.bin`. `CUTROOM_PORT` and `CUTROOM_HOME` work for the app, the launcher
and the server.

Data lives in `~/Movies/Cutroom/`:
- `media/`: imported copies
- `projects/`: one JSON per project
- `exports/`
- `cache/`: filmstrips, waveforms, proxies, transcripts, beats
- `models/`: Silero VAD
- `trash/`: deleted projects and media, recoverable
- `server.log`

## Features

The preview and the export share one geometry, colour and text pipeline. Rendering the same frame both ways
and comparing pixels gave 0–2 levels of difference for transitions, clip animations, filters, masks and
blend modes, and about 2.6 levels for text, in Chrome and in WebKit (the app's engine).

| | Feature | How |
|---|---|---|
| Edit | Magnetic main track, plus overlay, audio, text and caption tracks | Overlapping clips stack into rows. Drag to move or reorder; edge-drag to trim. Both snap to the playhead, clip edges, markers and beats. Keyframes, volume envelopes and word timings stay on their content when you trim, split, change speed, remove pauses, ramp or freeze |
| | 14 transitions: dissolve, dip to black or white, wipe and slide in 4 directions, circle open and close, zoom | The clips overlap (`xfade` + `acrossfade`). The preview reimplements xfade's per-pixel maths |
| | Keyframes for scale, position, opacity and rotation, linear or eased per keyframe, with previous/next jumps | ffmpeg per-frame expressions built as a balanced tree (ffmpeg's parser stops at about 100 nesting levels), so tracking with hundreds of points exports fine. Cutting through an eased segment keeps the exact curve |
| | Clip In/Out animations: fade, zoom in/out, slide in 4 directions, rotate, spin, each with its own length | Applied live in the preview and baked into per-frame keyframes for the export, on top of your own keyframes |
| | Speed 0.1×–10× on a continuous slider, optional pitch change; speed ramps; reverse; freeze frame | Change pitch uses `asetrate` in the export and `preservesPitch=false` in the preview |
| | Typed values | Click any slider's value to type an exact number |
| Look | Canvas 9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 21:9; fit, fill or blurred-background fill | One geometry function drives the preview and the export |
| | Filters with strength; brightness, contrast, saturation, temperature, tint | One colour matrix shared by the preview and the export |
| | Crop, mirror, rotation, opacity on any clip, chroma key with a colour picker | The picker reads the clip's own graded pixel under the click. The key uses ffmpeg `colorkey`'s exact formula |
| | Masks: circle, rectangle, linear, mirror; feather and invert | One canvas routine draws the preview and the export's mask PNG |
| | Overlay blend modes (11) and bring forward / send backward | Canvas `globalCompositeOperation` in the preview; the export runs the same W3C formulas through `lut2` (ffmpeg's own `blend` modes differ) |
| | Stabilize, auto reframe, HDR iPhone footage | `deshake` plus an 8% zoom; Apple Vision faces as eased keyframes; HLG/PQ tone-mapped by VideoToolbox, freeze frames too |
| Text | Text clips with presets and emoji stickers, 4 bundled fonts plus system fonts with their real weights | Italic, alignment, letter spacing, line height, outline, shadow (colour, opacity, blur, offset), background (colour, opacity, roundness, padding). One `drawText()` renders the preview and the export layer |
| | In/out animations (pop, fade, slide) with adjustable length, and loops (bounce, pulse, wiggle) | |
| | Auto-captions with word-by-word highlight and pop, 4 styles, 18 languages plus auto-detect | whisper.cpp on-device, with DTW word timing and a Silero VAD filter. It asks before replacing captions on the timeline |
| AI and audio | Remove background (people), motion tracking | Apple Vision segmentation (transparent VP9 WebM) and object tracking (keyframes that keep the clip's rotation) |
| | Voiceover from the Mac's voices or the microphone | `say`; MediaRecorder while the timeline plays muted |
| | Beat detection and beat sync | Onsets, tempo and dynamic-programming beat tracking |
| | Volume in dB (mute to +20 dB), fades you can hear in the preview, auto-duck from −6 to −24 dB under speech on any track | The duck envelope multiplies the clip volume, so the Volume slider keeps working after auto-duck |
| | Remove pauses, reduce noise, loudness −14 LUFS, detach audio, smooth slow-mo | `silencedetect`, `afftdn`, `loudnorm`, `minterpolate` |
| Timeline | Markers (M), mute/hide per track, Home/End, frame steps | |
| Output | MP4 (H.264, HEVC), MOV (ProRes 422), GIF, MP3, WAV, PNG still; 720p to 4K; three bitrates; 23.976 to 60 fps | Composited in RGB like the canvas, then one tagged BT.709 conversion, so players show the right colours. PNG and GIF stay RGB |
| Library | Templates, project duplicate and delete, media delete (to trash), proxies for ProRes, MKV, AV1 and GIF, HEIC import | |
| Pro colour and motion | Exposure, highlights, shadows, fade, vignette; combo motion (Ken Burns in/out, drift, pulse, shake, sway, float); typewriter / backspace text | One 256-entry tone curve: an `feComponentTransfer` table in the preview, `lut1d` in the export. Vignette: the same multiplier map drawn by the browser |
| Cleanup | Remove filler words (um, uh, er, hmm), split at scene changes, speed up to 100× | Fillers come from the on-device transcript and are cut at the middle of the pauses around them |
| On-device AI | Text-to-image and stickers, natural AI voiceover in 9 languages, background removal for photos (any subject) | Z-Image-Turbo (4-bit, MLX), Kokoro-82M (MLX), Apple Vision subject lifting. All on this Mac; see below |
| Claude Code control | Tell Claude Code in VS Code what to do and it edits the open project | The Cutroom MCP server (see below) |

## Control it from Claude Code (MCP)

`mcp/cutroom_mcp.py` is an MCP server (stdlib only). It is registered for every Claude Code session on this Mac:

    claude mcp add -s user cutroom -- env -u PYTHONPATH /opt/homebrew/bin/python3 -I ~/cutroom/mcp/cutroom_mcp.py

Then ask in plain words, for example "open the demo project, remove the pauses, add bold captions, put a dip-to-white
between every clip and export 1080p". Claude reads the timeline, edits, looks at the result (the `snapshot` tool returns
the preview frame as an image), and exports. The 28 tools cover projects, media import, clips (add, update any setting,
split, delete, duplicate, move), text, transitions, captions, pause and filler removal, voiceovers, the smart tools,
undo/redo, snapshots, export, and on-device image and voice generation.

How it works: tool calls go to Cutroom's server (`/api/remote`), which hands them to the open editor page. The page runs
them with the same functions as the buttons, so every change is visible live and is one undo step. Delivery is
acknowledged, so a page reload can't lose a command. If no editor is open, the first call opens the app. The app keeps the
editor running while it is behind other windows (WebKit would otherwise suspend it), and `snapshot` renders the frame
with the export engine, so it shows exactly what the export will, even while the window is hidden.

## On-device AI

Everything runs on this Mac (M4 Max, 36 GB); nothing is uploaded. One-time setup: `ai/setup.sh` (about 32 GB of
downloads into `~/.cache/huggingface`, plus a 5.5 GB 4-bit copy in `~/Movies/Cutroom/ai`).

| | Model | Measured here |
|---|---|---|
| Text to image (AI tab, `generate_image`) | Z-Image-Turbo 6B, 4-bit, via mflux on MLX | 1024² in about 48 s (8 steps); a 4-step draft in about 27 s |
| Stickers | the image above + Apple Vision subject lifting | the prompt asks for a plain backdrop so the cut-out is clean |
| Natural voiceover (AI tab, `ai_voiceover`) | Kokoro-82M via mlx-audio, 54 voices in 9 languages | 7.7 s of speech in about 5 s, most of it model load |
| Background removal for photos | Apple Vision `VNGenerateForegroundInstanceMaskRequest` | under a second; any subject, not only people |

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
- **Blend modes:** ffmpeg's `blend` filter disagrees with the W3C formulas that the canvas uses:
  soft-light is off by up to 31 levels, dodge and burn miss the edge cases, and "overlay" versus
  "hard-light" depends on input order. `lut2` with the W3C expressions matches within 0.5 levels.

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
- `ai/setup.sh`: installs the on-device AI (venv in `ai/.venv`, gitignored). `tools/lift.swift`: Vision subject lifting.
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
- **MCP control** needs the editor open (it opens the app itself). Commands run one at a time.
- **Not built:** multi-camera, user-drawn curves, keyframeable masks and filters, and AI video generation.
