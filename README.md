# Cutroom

A local, CapCut-style video editor for Mac. Timeline editing, on-device auto-captions with
word highlighting, pause removal, picture-in-picture, text, music, and hardware-encoded export.
Everything runs on this Mac. No account, no uploads, no watermark.

## Run it

- Double-click **~/Applications/Cutroom.app**, or run `~/cutroom/cutroom`.
  This starts the server on demand (never at login) and opens the editor as a Chrome app window.
- Self-check after any engine change: `env -u PYTHONPATH python3 -I server.py --selftest`
  (renders synthetic projects through both render paths and asserts frames, pixels, audio,
  silence detection and caption timing).

Requirements: Homebrew `ffmpeg` and `whisper-cpp`, Google Chrome. The whisper model is reused from
Voicify (`ggml-large-v3-turbo-q5_0.bin`); override it with `CUTROOM_MODEL=/path/to/ggml-*.bin`.

Data lives in `~/Movies/Cutroom/`: `media/` (imported copies), `projects/` (one JSON per project),
`exports/`, `cache/` (filmstrips, waveforms, proxies, transcripts), `models/` (Silero VAD), `server.log`.

## What it does

| Feature | How |
|---|---|
| Import video / audio / images (drag anywhere, HEIC too) | copied into the library; filmstrip, waveform and (for ProRes/MKV) a 720p preview proxy are built in the background |
| Magnetic main track + overlay, audio, text and caption tracks | drag to move or reorder, edge-drag to trim (edges snap to the playhead and clip edges), S splits, ⌫ deletes, ⌘D duplicates, ⌘Z / ⇧⌘Z |
| Canvas 9:16, 16:9, 1:1, 4:5; fit / fill / blurred-background fill | the same geometry function drives the preview and the export |
| Speed 0.25×–4×, volume, fades, brightness / contrast / saturation | export filters use the same math as the preview's CSS filters |
| Picture-in-picture / B-roll | overlay track with scale, position and opacity; drag it on the preview |
| Auto captions, word-by-word highlight with "pop" | whisper.cpp on-device, 4 presets, words per caption, editable text |
| Remove pauses (jump cuts) | ffmpeg `silencedetect`, keeps 0.1 s of air around speech |
| Text clips | 6 presets, Montserrat / Poppins / Anton / Bebas Neue bundled (OFL), plus system fonts |
| Export MP4 at 720p to 4K | H.264 via Apple VideoToolbox (fast) or x264 (best), progress bar, Show in Finder |

## How CapCut works (teardown of /Applications/CapCut.app 9.7.1)

Static triage only: bundle layout, linked frameworks, string literals and my own project file.
No decompiling and no CapCut code or assets copied. Cutroom is a clean-room build.

| CapCut layer | What the bundle shows | Cutroom's version |
|---|---|---|
| App shell | 217 KB launcher over 1.7 GB of frameworks. UI is **Qt 6.2.2 / QML** (`Resources/qml`), plus ByteDance **Lynx** panels and an embedded **Chromium** (454 MB) for the asset-store web panels (`image_h5_*`). Sparkle updates | HTML/CSS/JS in a Chrome app window (`web/`) |
| Edit engine | ByteDance **VE SDK**: `libVECreator` (352 MB), `libvideoeditor` (86 MB), `libcccreator` (132 MB business layer), separate `VEHelper.app` process | `server.py` builds one ffmpeg filtergraph per export |
| Decode / encode | **FFmpeg** dylibs (`libavcodec`, `libavfilter`, …), ByteDance's own **ByteVC1** decoder, dav1d | Homebrew ffmpeg + VideoToolbox |
| GPU render | **AGFX** abstraction on **Metal** (`VEMetalBinary_Mac.bundle`) and **ANGLE** (`libGLESv2`, `libEGL`), so mobile GLSL effects run on the Mac | canvas 2D for preview, ffmpeg filters for export |
| Effects, filters, stickers | downloaded, encrypted packages (`libEffectPlatform`, `libres_pool`, `libvecryptor`), not built into the app | built-in adjustments and text presets |
| Project format | `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<name>/draft_info.json`: plain JSON, times in **microseconds**, `canvas_config` + `fps` + `tracks[] → segments[]`, each segment with `source_timerange` / `target_timerange`, pointing into a `materials{}` registry of 55 kinds via `material_id` + `extra_material_refs`. Every draft also stores the Mac's `mac_address` / `hard_disk_id` | `projects/<id>.json`: lanes of clips referencing media by id, times in seconds; main clips snap to whole frames |
| On-device AI | ~75 `.model` files run by ByteDance's **ByteNN** engine: matting (background removal), face / body / hand tracking, depth, object tracking, frame interpolation (smooth slow-mo), beat detection, audio denoise / echo cancel, music matching | not built (see below) |
| Auto captions | **cloud ASR**: `libspeechsdk` with `asr_online` and a `/api/v1/asr/ws` WebSocket. No speech model ships in the bundle | **on-device** whisper.cpp large-v3-turbo with DTW word timing + Silero VAD |
| Cloud | cloud drafts (`libever_cloud_sdk`), uploads, AIGC, C2PA content credentials (`libtt_c2pa_sdk`), an AI agent stack (`libdeepagents_capi`) on a bundled **Bun** runtime | none |

The key design idea carried over: the project is a plain declarative timeline (tracks → clips →
media) and one engine renders it. Cutroom splits that engine in two. The browser renders the
preview and the **text layer** (as PNGs from the same `drawText()` call). ffmpeg composites and
encodes. This Homebrew ffmpeg has no libass/freetype, and drawing text once in the browser also
guarantees the export matches the preview exactly.

## Caption timing notes

whisper.cpp's default token timestamps smear words across pauses (one word landed 0.9 s into the
silence after it, which put captions on the wrong clip after pause removal). Cutroom uses
**DTW alignment** instead (`-dtw large.v3.turbo`, which needs `-nfa`). It also runs **Silero VAD**
separately and drops words outside detected speech, because whisper invents text over music
("The end of the day is the end of the day."). Whisper's own `--vad` is not usable here: it reports
DTW times on the silence-stripped timeline. Both failures are covered by the self-check.

## Files

- `server.py`: stdlib-only Python. Media library, byte-range serving for `<video>`, ffmpeg render
  engine (`graph()`), whisper and VAD, silence detection, export jobs, `--selftest`.
  Binds 127.0.0.1 only, checks the Host header (DNS rebinding) and requires `X-Cutroom: 1` on writes,
  which forces a CORS preflight, so other websites can't drive it.
- `web/app.js`: timeline model, undo, preview engine (two alternating `<video>` elements on the main
  track so the next cut is pre-seeked), editing UI, export plan builder.
- `web/index.html`, `web/style.css`, `web/fonts/` (OFL fonts from Google Fonts).
- `cutroom`: launcher. `~/Applications/Cutroom.app` just calls it.

## Not built yet (known limits)

- Transitions between clips (fades to black only), keyframes, text animations.
- CapCut's AI effects: background removal, motion tracking, beat sync, text-to-speech.
- HDR iPhone footage (HLG / Dolby Vision) is untested. This ffmpeg has no zscale, so exports are not
  tone-mapped and will likely look flat. Tone mapping via `scale_vt` is the likely fix.
- One track per lane. Overlapping clips on a lane still render (later on top) and mix.
- No project delete or rename-in-list yet. Delete JSON files from `~/Movies/Cutroom/projects/`.
- Preview volume is capped at 100%. Export honours up to 200%.
