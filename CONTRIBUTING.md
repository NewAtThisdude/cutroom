# Contributing

Cutroom is a small codebase on purpose: one Python file for the engine (`server.py`, standard library only), plain
JavaScript for the editor (`web/`), a thin Swift shell (`app/`). No build step, no framework.

## Run it from source

    ./install.sh          # tools check, speech models, builds ~/Applications/Cutroom.app
    ./cutroom             # or: the editor in a browser window

On Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`, then `cutroom.cmd`. Keep `install.ps1` and
`cutroom.ps1` plain ASCII and Windows PowerShell 5.1 compatible (that is what every Windows has).

## Rules that keep it honest

- **Preview equals export.** Anything drawn in the preview must come out the same in the file. If you add an effect,
  add its case to `tests/video_parity.mjs`.
- **Run the checks.** `python3 -I server.py --selftest` after engine changes (about 3 minutes, pixel checks; on Windows
  `python -X utf8 -I server.py --selftest` with an ffmpeg full build on PATH; the AI parts skip, saying so, without the venv);
  `node tests/ui_smoke.mjs` and `node tests/ui_audit.mjs` after UI changes. Tests need a server on a scratch library:
  `CUTROOM_HOME=/tmp/cutroom-test CUTROOM_PORT=4620 python3 -I server.py`, then `B=http://127.0.0.1:4620 node tests/...`.
  The UI tests drive WebKit (the Mac app's engine); `BROWSER=chromium` (or `msedge`, `chrome`: the installed browser, no
  download) runs them in Chromium, which is what Windows uses, and `PLATFORM=Win32` makes the page think it is on Windows,
  to check the Ctrl+ labels on a Mac. Tests that only make sense on a Mac (`allmacs`, `photos_button`, `perf_*`) print
  SKIP elsewhere. Use `fileURLToPath`, not `URL.pathname`, for paths in tests (Windows). Never point tests at your real library. Tests that need real footage (iPhone HDR clips and the like) read it from
  `$CUTROOM_SCRATCH/photos` (default `/tmp/cutroom-scratch/photos`) and skip when it isn't there.
- **Light on the machine.** Heavy jobs go through the one queue (`ai_slot`) and get a row in the budget table
  (`AI_BUDGET`) for each kind of computer that can run them (Apple Silicon, NVIDIA, CPU), or a plain refusal; nothing
  polls in the background; models unload when idle. `server.py --profiles` shows every job on simulated Macs and PCs.
- **Mac and Windows.** Every video encode goes through `venc()` (VideoToolbox on a Mac, NVENC / Quick Sync / AMF / x264 on
  a PC), every hardware decode through `hw_dec()` / `hdr_decode()`, every file path inside a filtergraph through `fpath()`
  (Windows drive colons), every replace / move of a file the player may have open through `retry()`. Anything Mac-only
  (Swift tools, `say`, `sips`) has a Windows path or reports "unavailable on this computer" with the reason.
  `tests/this_computer.mjs` checks the AI tab's panel (start the server with `CUTROOM_PROFILE=win:cuda:12:32` to see a PC's).
- **Everything local.** No telemetry, no accounts, no network calls except downloads the user starts, each pinned
  and checksummed, with its licence recorded in `THIRD_PARTY.md`.
- **Text drawing lives in `web/draw.js`** (the export's workers use it too): anything `drawText` needs goes there.

## Pull requests

One change per PR, with what you measured. Screenshots for UI changes, in both normal and reduced-motion modes.
Contributions are accepted under the project's licence, GPL v3 or later.
