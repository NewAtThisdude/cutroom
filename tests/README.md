# Release tests

From the repository root, run:

```sh
node tests/run_all.mjs
```

The runner starts a separate Python server and fresh scratch library for each test, imports generated media, creates the expected projects through the editor/server APIs, runs the test, and stops its server and browser. Tests run one at a time. No personal media library or running Cutroom app is needed.

Install Node.js 22 or newer, Python 3, and an ffmpeg build with `ffprobe`, H.264/AAC encoding, and the filters used by the editor. Both `ffmpeg` and `ffprobe` must be on `PATH`. Python must be available as `python3` on macOS or `python` on Windows.

The product's multicam alignment also requires NumPy in `ai/.venv` (Unix: `bin/python`; Windows: `Scripts/python.exe`). It loads no AI model, but `features_e2e` retains its existing multicam failures if that product dependency is absent. The runner installs no dependencies.

Install the test dependencies once:

```sh
npm ci --prefix tests
```

On macOS, install Playwright's WebKit browser:

```sh
npx --prefix tests playwright install webkit
```

On Windows, install Microsoft Edge. The runner defaults to Edge on Windows and WebKit on macOS. An explicit browser selection is also supported; in PowerShell:

```powershell
$env:BROWSER = 'msedge'
node tests/run_all.mjs
```

The default gate covers `ui_smoke`, `ui_audit`, `tour`, `platforms`, `history`, `curves`, `scopes`, `jlcuts`, `meter`, `versions`, `labels_keys`, `export_light`, `export_formats quick`, `layer_parity`, `package`, `this_computer`, `fade_handles`, `features_e2e`, `interchange`, `timeline_pro`, `video_parity`, and `audio_e2e`. The tour gets both an empty library and a second library containing media. The package test gets a second reserved port for its own empty-library server. Versions uses `CUTROOM_VERSION_GAP=2`.

Useful options:

```sh
node tests/run_all.mjs --list
node tests/run_all.mjs --tests ui_smoke,package --ports 4810-4819
node tests/run_all.mjs --timeout 1800
```

The timeout is per test in seconds, with a default of 1200. Server startup has a separate 60-second limit and fixture seeding runs in its own managed child process with a 300-second limit. The port range is inclusive and must contain at least two ports. Occupied ports are left alone. Port 4610 is always refused; on macOS only ports 4810–4819 are allowed. Any inherited `CUTROOM_HOME` inside the user's personal `Movies/Cutroom` directory is refused, including through a symlink. The runner always supplies its own fresh `CUTROOM_HOME` under `tests/out/runs/`; directly running a test without an explicit `CUTROOM_HOME` is an error.

On macOS the runner takes a `lockf` lock for the whole run, including fixture generation and exports. It uses the shared worktree GPU lock when present, otherwise the system temporary directory's `cutroom-gpu.lock`. `CUTROOM_GPU_LOCK` selects another shared lock. If an external command already holds that same lock, set `CUTROOM_GPU_LOCK_HELD=1` to avoid taking it twice. Windows uses no Mac command. Windows child processes run inside a Job Object so browser and secondary-server descendants are terminated when their test exits; POSIX uses process groups and the shared browser cleanup handlers.

Generated inputs are cached in `tests/out/fixtures/`. Each run retains its libraries, exports, server logs, individual test logs, and `summary.md` / `summary.json` in the printed `tests/out/runs/<timestamp>-<pid>/` directory. The final table reports PASS, FAIL, or SKIP. A partially skipped test remains PASS when its executed checks pass; its exact SKIP lines are printed below the table. Any failing check line, nonzero test exit, startup failure, or timeout makes the gate exit nonzero, including tests that previously printed FAIL but exited zero.

Speech fixtures use macOS `say` or Windows PowerShell `System.Speech`, with an explicit SKIP if neither works. `export_formats` uses a supplied `PHONE` clip when run directly, or the shared synthetic 4K60 HLG HEVC fixture in the release gate. If the local ffmpeg cannot encode that fixture, the phone section prints SKIP and the other export checks continue.

AI models are excluded by default, including optional AI sections within otherwise ordinary tests. `--ai` explicitly permits those sections and adds `ai_worker`, `ai_enhance`, `captions_pro`, `tracking`, `retouch`, and `voice_dub`. These optional suites may require installed models or specialized reference footage beyond the synthetic release fixtures, and report skips or failures accordingly. The default gate neither installs nor loads those models.

`--tests` accepts names in the default list or these six AI suites. Specialized legacy benchmarks and tools remain standalone. See [the Mac validation record](MAC_RUN_REPORT.md) for the attempted run, its browser-launch blocker, and unverified Windows behavior.
