# Contributing

Cutroom is a small codebase on purpose: one Python file for the engine (`server.py`, standard library only), plain
JavaScript for the editor (`web/`), a thin Swift shell (`app/`). No build step, no framework.

## Run it from source

    ./install.sh          # tools check, speech models, builds ~/Applications/Cutroom.app
    ./cutroom             # or: the editor in a browser window

## Rules that keep it honest

- **Preview equals export.** Anything drawn in the preview must come out the same in the file. If you add an effect,
  add its case to `tests/video_parity.mjs`.
- **Run the checks.** `python3 -I server.py --selftest` after engine changes (about 3 minutes, pixel checks);
  `node tests/ui_smoke.mjs` and `node tests/ui_audit.mjs` after UI changes. Tests need a server on a scratch library:
  `CUTROOM_HOME=/tmp/cutroom-test CUTROOM_PORT=4620 python3 -I server.py`, then `B=http://127.0.0.1:4620 node tests/...`.
  Never point tests at your real library. Tests that need real footage (iPhone HDR clips and the like) read it from
  `$CUTROOM_SCRATCH/photos` (default `/tmp/cutroom-scratch/photos`) and skip when it isn't there.
- **Light on the machine.** Heavy jobs go through the one queue (`ai_slot`) and get a row in the budget table
  (`AI_BUDGET`); nothing polls in the background; models unload when idle.
- **Everything local.** No telemetry, no accounts, no network calls except downloads the user starts, each pinned
  and checksummed, with its licence recorded in `THIRD_PARTY.md`.
- **Text drawing lives in `web/draw.js`** (the export's workers use it too): anything `drawText` needs goes there.

## Pull requests

One change per PR, with what you measured. Screenshots for UI changes, in both normal and reduced-motion modes.
Contributions are accepted under the project's licence, GPL v3 or later.
