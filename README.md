# Cutroom

A local, CapCut-style video editor for Mac. Everything runs on this Mac: no account, no uploads,
no watermark, and no cloud AI (CapCut's captions go to its servers; Cutroom's don't).

## Run it

- Double-click **~/Applications/Cutroom.app**, or run `~/cutroom/cutroom`.
  This starts the server on demand (never at login) and opens the editor as a Chrome app window.
- Self-check after any engine change: `env -u PYTHONPATH python3 -I server.py --selftest`
  (~2 min). It renders synthetic projects through both render paths and checks the result pixel by pixel.
  It covers transitions, keyframes, chroma key, all clip options, HDR + rotation, beats, voiceover,
  freeze frame, silence detection and caption timing.

Requirements: Homebrew `ffmpeg` and `whisper-cpp`, Google Chrome, Xcode command-line tools (`swiftc`) for
the two Apple Vision helpers (built automatically on first use). The whisper model is reused from Voicify
(`ggml-large-v3-turbo-q5_0.bin`); override it with `CUTROOM_MODEL=/path/to/ggml-*.bin`.

Data lives in `~/Movies/Cutroom/`:
- `media/`: imported copies
- `projects/`: one JSON per project
- `exports/`
- `cache/`: filmstrips, waveforms, proxies, transcripts, beats
- `models/`: Silero VAD
- `trash/`: deleted projects and media, recoverable
- `server.log`

## Features

| | Feature | How |
|---|---|---|
| Edit | Magnetic main track, plus overlay, audio, text and caption tracks | Overlapping clips stack into rows. Drag to move or reorder, and edge-drag to trim; both snap to the playhead, clip edges and beat marks. S splits, ⌫ deletes, ⌘D duplicates, ⌘Z / ⇧⌘Z undo and redo. Clips move between the main and overlay tracks |
| | Transitions: dissolve, dip to black, wipe, slide, circle, zoom | The two clips overlap (`xfade` + `acrossfade`). The preview reimplements xfade's per-pixel math |
| | Keyframes for scale, position, opacity and rotation, linear or eased | Identical curves in the preview and the export (ffmpeg per-frame expressions, smoothstep easing). Used for zoom, pan and punch-in |
| | Speed ramps (montage, hero, bullet, jump cut, flash in, flash out) and reverse | A ramp splits the clip into 8 editable parts. Reverse renders a reversed copy |
| | Speed 0.25×–4×, volume up to 200%, fades, freeze frame | The preview uses Web Audio gain, so above-100% volume and transition crossfades are audible |
| Look | Canvas 9:16, 16:9, 1:1, 4:5; fit, fill or blurred-background fill | One geometry function drives the preview and the export |
| | Filters (vivid, mono, sepia, warm, cool, teal) with strength; brightness, contrast, saturation | Colour matrices: an SVG `feColorMatrix` in the preview, `colorchannelmixer` in the export |
| | Crop, mirror, rotation, chroma key (green screen) | The preview's key uses ffmpeg `colorkey`'s exact formula |
| | Masks: circle, rectangle, linear, mirror; feather and invert | Drawn by one canvas routine for both the preview and the export PNG (`alphamerge`). Combined with a chroma key, the alphas multiply |
| | Stabilize, auto reframe | Stabilize: `deshake` plus an 8% zoom. Auto reframe: Apple Vision faces, written as eased keyframes |
| | HDR iPhone footage (HLG/PQ) | Tone-mapped to SDR by VideoToolbox (`scale_vt`), with rotation handled |
| Text | Text clips with 7 presets (including emoji stickers), 4 bundled OFL fonts plus system fonts | Pop, fade or slide-in animations. Keyframed position and scale |
| | Auto-captions with word-by-word highlight, 4 styles | whisper.cpp on-device, with DTW word timing and a Silero VAD filter |
| AI and audio | Remove background (people) | Apple Vision person segmentation, saved as a transparent VP9 WebM |
| | Motion tracking | Drag a box on the preview and the text or overlay follows it (Apple Vision object tracker, written as keyframes) |
| | Voiceover (text-to-speech) | The Mac's own voices (`say`), added on the audio track |
| | Beat detection and beat sync | Onsets, tempo and dynamic-programming beat tracking. Main-track cuts snap to every 1, 2, 4 or 8 beats |
| | Remove pauses (jump cuts), reduce noise, loudness normalization (−14 LUFS), detach audio | `silencedetect`, `afftdn`, `loudnorm` |
| Output | MP4 export from 720p to 4K | H.264 via VideoToolbox (fast) or x264 (best), with a progress bar and Show in Finder |
| Library | Proxies for ProRes and MKV, HEIC import, project and media delete (to trash) | |

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

## Files

- `server.py`: stdlib-only Python, including `--selftest`. It covers the media library, byte-range
  serving, the ffmpeg render engine (`graph()`), whisper and VAD, beats, TTS, silence detection and the
  Vision jobs. It binds to 127.0.0.1 only and checks the Host header. Writes require `X-Cutroom: 1`,
  which forces a CORS preflight, so other websites can't drive it.
- `web/app.js`: the timeline model, undo, the preview engine (alternating `<video>` elements, transition
  layers, Web Audio), the editing UI and the export plan builder.
- `web/index.html`, `web/style.css`, `web/fonts/` (OFL fonts from Google Fonts).
- `tools/matte.swift`, `tools/track.swift`, `tools/faces.swift`: Apple Vision helpers, compiled on first use.
- `cutroom`: the launcher. `~/Applications/Cutroom.app` just calls it.

## Limits (honest)

- **Preview-only differences:** noise reduction and loudness are applied on export only. Chrome shows
  HDR its own way, while the export is tone-mapped. The blurred background edge differs slightly.
- **Background removal:** people only (Vision person segmentation), frame by frame. Expect some edge
  flicker. It was verified on a 3D-avatar clip, not on a real person; hair edges are unverified. A cutout
  of HDR footage is not tone-mapped.
- **Motion tracking:** follows position only (not scale or rotation), and needs the target visible on a
  main-track video at the playhead. Verified on synthetic motion.
- **HDR:** verified on synthetic HLG, including rotation. Real iPhone Dolby Vision metadata is ignored
  (its HLG base layer is used).
- **Speed ramps** are stepped (8 parts), not a continuous curve. Masks and filters are static (not
  keyframed). Easing is per clip (all segments), not per keyframe.
- **Stabilize** is ffmpeg `deshake`: basic, and it zooms in 8%. **Auto reframe** follows faces only,
  verified on a 3D-avatar clip.
- **Not built:** multi-camera, templates, AI generation (CapCut's AIGC is cloud-based).
