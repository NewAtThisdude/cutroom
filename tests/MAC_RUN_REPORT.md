# Cross-platform harness: Mac validation record

Status: implementation committed, release validation blocked. This is **not** a passing release gate.

On 2026-11-13 (America/Los_Angeles), `node tests/run_all.mjs` attempted all 22 default entries, serially, under the shared `lockf` GPU lock. Every entry used a fresh scratch library below `tests/out/runs/` and a scratch Python server. The runner exited **1**. No AI model tests were run. No application server or test used port 4610 or the personal media library.

All entries failed before executing their test assertions. The installed Playwright WebKit 2388 process aborted while fixture seeding tried to launch the browser. Every row had the same first failure line:

```text
FAIL harness: browserType.launch: Target page, context or browser has been closed
```

The browser exited 134 / SIGABRT (`Abort trap: 6`). The macOS diagnostic trace ends in `_RegisterApplication`, `GetCurrentProcess`, and `NSApplication init`; Playwright also logged `kill EPERM`. This is consistent with the restricted execution environment preventing macOS application registration. The precise underlying OS restriction was not independently established. Repeated browser attempts would not establish product correctness, so no product checks or thresholds were changed to work around this launch failure.

| Test | Result | Seconds | Reason |
| --- | --- | ---: | --- |
| ui_smoke | FAIL | 2.7 | WebKit launch aborted before fixture project creation |
| ui_audit | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| tour | FAIL | 3.0 | WebKit launch aborted before fixture project creation |
| platforms | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| history | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| curves | FAIL | 2.4 | WebKit launch aborted before fixture project creation |
| scopes | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| jlcuts | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| meter | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| versions | FAIL | 2.6 | WebKit launch aborted before fixture project creation |
| labels_keys | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| export_light | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| export_formats quick | FAIL | 2.8 | WebKit launch aborted before fixture project creation |
| layer_parity | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| package | FAIL | 2.8 | WebKit launch aborted before fixture project creation |
| this_computer | FAIL | 3.1 | WebKit launch aborted before fixture project creation |
| fade_handles | FAIL | 2.6 | WebKit launch aborted before fixture project creation |
| features_e2e | FAIL | 2.6 | WebKit launch aborted before fixture project creation |
| interchange | FAIL | 2.6 | WebKit launch aborted before fixture project creation |
| timeline_pro | FAIL | 2.8 | WebKit launch aborted before fixture project creation |
| video_parity | FAIL | 2.3 | WebKit launch aborted before fixture project creation |
| audio_e2e | FAIL | 2.3 | WebKit launch aborted before fixture project creation |

Raw evidence is retained locally at `tests/out/runs/2026-11-14T02-32-35-862Z-8086/` (`summary.json`, `summary.md`, and per-entry server/test logs), plus `tests/out/gate-console.log`. Generated outputs and logs are intentionally ignored by Git. After this run, fixture seeding was moved into a managed subprocess and given a 300-second timeout; the full run above predates that cleanup hardening.

## Checks completed without a browser

- All 63 `tests/*.mjs` modules passed `node --check`; `git diff --check` passed.
- Invalid port range containing 4610, a personal-library `CUTROOM_HOME`, and AI selection without `--ai` were rejected with exit code 1.
- Missing `CUTROOM_HOME`, protected library descendants (including a symlinked home), and an unregistered model test were rejected by the shared guards.
- Generated testsrc2/smptebars and sine/noise inputs imported and became ready through each scratch server API before browser launch failed.
- Separate generation under the GPU lock succeeded for the synthetic phone fixture. `ffprobe` confirmed HEVC, 3840x2160, 60/1 fps, yuv420p10le, bt2020nc, bt2020, and arib-std-b67.
- macOS speech generation succeeded, and two calls with identical inputs reused byte-identical cached WAV audio. Windows SAPI execution remains unverified.
- Embedded Windows Job Object Python code passed syntax validation only; no Windows runtime verification was performed.
- All ports 4810 through 4819 were bindable after cleanup. Server processes exited, and Playwright reported its aborted processes exited. No started server was left listening.

## Skips and remaining limits

The AI suites were excluded by default as requested. Optional speech, HLG, and within-suite AI/real-footage skips were not reached by the blocked full run. The synthetic HLG and speech checks above succeeded separately.

On a functioning browser, the default gate explicitly skips stem separation and neural body effects unless `--ai`; the timeline subject mask also requires its real reference footage, and its optional 4K preview-quality benchmark needs `IMG_4654.MOV`. Missing speech services or usable HEVC encoding produce explicit SKIP lines. Other format checks still run with the SDR stand-in when HLG generation is unavailable.

Multicam alignment in `features_e2e` also requires the product's `ai/.venv` Python with NumPy, even though it loads no AI model. A fresh installation without that product dependency will fail the existing multicam checks; the harness does not conceal that failure or install product dependencies. The setup README calls this out.

The six optional AI suites need installed tools/models and, in some cases, specialized reference footage; generic patterns cannot replace their human/semantic ground truth. Legacy benchmark and reference scripts outside the release registry still have specialized media requirements. In particular, source_viewer needs named library clips, ramp_play and ai_worker use historical project/media IDs, and the original HDR reference comparisons need real rotated iPhone sources. They are not included in the default 22-entry gate.

The supplied Windows run reported CRLF subtitle/interchange output, curve double-click handling, color-burn preview parity, skin-smoothing preview parity, and a few timing/parity limit failures. Those are unchanged product concerns; this run did not revalidate them. `server.py` and `web/` were not edited.

## Files changed

- `tests/MAC_RUN_REPORT.md`
- `tests/README.md`
- `tests/allmacs.mjs`
- `tests/audio_e2e.mjs`
- `tests/audio_packs.mjs`
- `tests/audio_tools.mjs`
- `tests/batch.mjs`
- `tests/brand.mjs`
- `tests/browser.mjs`
- `tests/export_formats.mjs`
- `tests/export_hdr_alpha.mjs`
- `tests/fade_handles.mjs`
- `tests/features_e2e.mjs`
- `tests/fixtures.mjs`
- `tests/fonts_captions.mjs`
- `tests/fuzz_ui.mjs`
- `tests/hdr_iphone.mjs`
- `tests/labels_keys.mjs`
- `tests/layer_race.mjs`
- `tests/make_starters.mjs`
- `tests/mcp_e2e.mjs`
- `tests/package.json`
- `tests/package.mjs`
- `tests/retouch.mjs`
- `tests/run_all.mjs`
- `tests/runtime.mjs`
- `tests/settings.mjs`
- `tests/templates.mjs`
- `tests/this_computer.mjs`
- `tests/timeline_pro.mjs`
- `tests/tracking.mjs`
- `tests/voice_dub.mjs`
