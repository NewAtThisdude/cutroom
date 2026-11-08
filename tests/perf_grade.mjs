// CPU while playing a graded 1080p clip (look + adjustments + grade + vignette + mask), with the GPU colour pass and
// with it switched off (the per-pixel JavaScript fallback). Cores = CPU seconds per wall second of WebKit + the server.
//   node perf_grade.mjs   (server on 127.0.0.1:4610)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-perf-`), f = `${tmp}/perf-1080.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
const V = await (await fetch(`${B}/api/import?name=perf-1080.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
fs.rmSync(tmp, { recursive: true });
const pids = () => execFileSync('sh', ['-c', "pgrep -f 'ms-playwright/webkit' ; lsof -t -nP -iTCP:4610 -sTCP:LISTEN"]).toString().split(/\s+/).filter(Boolean);
const cpu = () => pids().reduce((s, p) => { try { const t = execFileSync('ps', ['-o', 'time=', '-p', p]).toString().trim(); const [a, b] = t.split(':'); return s + (+a) * 60 + parseFloat(b); } catch { return s; } }, 0);
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (fn, a) => page.evaluate(fn, a);
await ev(() => loadMedia());
await page.waitForFunction(id => M.get(id)?.ready, V.id, { timeout: 60000 });
const pid = await ev(id => { setProject(newProject('16:9')); P.name = 'Perf (scratch)'; addMedia(id, 'main'); Object.assign(P.main[0], { look: { name: 'teal', amount: 0.8 }, adj: { b: 1.05, c: 1.1, s: 1.1, ex: 0.2, vig: 0.4 },
  grade: { gain: { x: 0.2, y: 0.1, l: 0.1 }, curves: { m: [[0, 0.05], [0.5, 0.55], [1, 1]] }, hsl: { blue: { s: -0.4 } } }, mask: { type: 'rect', x: 0, y: 0, w: 0.95, h: 0.95, rot: 0, feather: 0.02, invert: false } }); S.sel = null; renderAll(); return P.id; }, V.id);
const run = async label => {
  await ev(() => { S.t = 0; play(); });
  await page.waitForTimeout(1500);
  await ev(() => { window.__n = 0; window.__op ??= paint; paint = () => { __n++; __op(); }; });
  const c0 = cpu(), t0 = Date.now();
  await page.waitForTimeout(8000);
  const c1 = cpu(), fr = await ev(() => __n);
  await ev(() => { pause(); paint = __op; });
  console.log(`${label.padEnd(22)} ${((c1 - c0) / ((Date.now() - t0) / 1000)).toFixed(2)} cores, ${(fr / 8).toFixed(1)} frames drawn per second`);
};
await run('GPU colour pass');
await ev(() => { GPU.gl = null; GPU.failed = true; });
await run('JavaScript fallback');
await b.close();
await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' });
await fetch(`${B}/api/media/${V.id}/trash`, { method: 'POST', headers: H, body: '{}' });
