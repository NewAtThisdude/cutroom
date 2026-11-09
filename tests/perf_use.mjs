// CPU while using the editor (headless WebKit + server), on the 15-clip 60 fps night-drive edit: scrubbing the ruler,
// dragging a clip, zooming the timeline; plus what one timeline / inspector rebuild costs. Cores = CPU s per wall s.
//   node perf_use.mjs
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
const PORT = process.env.PORT || '4610';
const pids = () => execFileSync('sh', ['-c', `pgrep -f 'ms-playwright/webkit' ; lsof -t -nP -iTCP:${PORT} -sTCP:LISTEN`]).toString().split(/\s+/).filter(Boolean);
const cpu = l => execFileSync('ps', ['-o', 'time=', '-p', l.join(',')]).toString().trim().split('\n').reduce((s, t) => { const [m, x] = t.trim().split(':'); return s + +m * 60 + +x; }, 0);
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
const src = (await ev(() => api('/api/projects'))).find(p => /Midnight Highway/.test(p.name)) || (await ev(() => api('/api/projects')))[0];
const pid = await ev(async id => { const p = await api(`/api/projects/${id}`); p.id = hex12(); p.name = 'perf (scratch copy)'; setProject(p); renderAll(); return P.id; }, src.id);
await page.waitForTimeout(3000);
const run = async (name, fn) => {
  await ev(() => { window.NP = 0; window.NT = 0; if (!window._wp) { window._wp = paint; window._wt = renderTimeline; paint = () => { NP++; _wp(); }; renderTimeline = () => { NT++; _wt(); }; } });
  const l = pids(), a = cpu(l), t0 = Date.now();
  await fn();
  const s = (Date.now() - t0) / 1000, c = (cpu(l) - a) / s, k = await ev(() => [NP, NT]);
  console.log(`${name.padEnd(30)} ${c.toFixed(2)} cores over ${s.toFixed(1)} s · ${k[0]} paints, ${k[1]} timeline rebuilds`);
};
const box = async sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const rb = await box('#ruler');
await run('scrub the ruler (4 s)', async () => { await page.mouse.move(rb.x + 20, rb.y + rb.h / 2); await page.mouse.down(); for (let i = 0; i <= 120; i++) { await page.mouse.move(rb.x + 20 + i * 7, rb.y + rb.h / 2); await page.waitForTimeout(33); } await page.mouse.up(); });
const cb = await box('.clip.main:nth-of-type(3)');
await run('drag a clip (2 s)', async () => { await page.mouse.move(cb.x + cb.w / 2, cb.y + cb.h / 2); await page.mouse.down(); for (let i = 0; i <= 60; i++) { await page.mouse.move(cb.x + cb.w / 2 + i * 4, cb.y + cb.h / 2); await page.waitForTimeout(33); } await page.mouse.up(); });
await run('zoom the timeline (40 steps)', async () => { for (let i = 0; i < 40; i++) { await page.$eval('#zoom', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, 1 + (i % 20) * 0.2); await page.waitForTimeout(40); } });
await run('idle after all that (3 s)', () => page.waitForTimeout(3000));
console.log(await ev(() => { const n = 30; let t = performance.now(); for (let i = 0; i < n; i++) _wt(); const tl = (performance.now() - t) / n; S.sel = { lane: 'main', id: P.main[0].id }; t = performance.now(); for (let i = 0; i < n; i++) renderInspector(); const ins = (performance.now() - t) / n; return `one timeline rebuild ${tl.toFixed(1)} ms, one inspector rebuild ${ins.toFixed(1)} ms (${P.main.length} main clips)`; }));
await fetch(`http://127.0.0.1:${PORT}/api/projects/${pid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await b.close();
