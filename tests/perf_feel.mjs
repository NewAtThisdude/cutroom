// How the editor FEELS: input -> visible response, on a real project (default: the night-drive edit).
// Reports per interaction the latency to a settled, painted frame and the main-thread frames over 50 ms (jank).
//   B=http://127.0.0.1:4620 node perf_feel.mjs [project name regex]
import { webkit } from 'playwright';
const B = process.env.B || 'http://127.0.0.1:4610', want = new RegExp(process.argv[2] || 'Midnight Highway');
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
const t0 = Date.now();
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined' && M.size > 0, null, { timeout: 30000 });
console.log(`app ready ${Date.now() - t0} ms`);
const ev = (f, a) => page.evaluate(f, a);
await ev(() => {
  window.J = []; // rAF gaps
  let last = performance.now();
  const loop = n => { J.push(n - last); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.PT = []; // paints: [time, S.t, lead currentTime]
  const op = paint; paint = () => { op(); PT.push([performance.now(), S.t, S.lead?.currentTime ?? -1]); };
  window.settled = () => new Promise(res => { // the lead video sits on the frame for S.t and that frame has been painted
    const t = performance.now();
    const chk = () => {
      const v = S.lead, ok = !S.dirty && (!v || (!v.seeking && v.readyState >= 2 && (S.playing || Math.abs(v.currentTime - (v._want ?? v.currentTime)) < 0.6 / P.fps)));
      const lp = PT.at(-1);
      if (ok && lp && (!v || Math.abs(lp[2] - v.currentTime) < 1e-3)) return res(performance.now());
      if (performance.now() - t > 3000) return res(-1);
      requestAnimationFrame(chk);
    };
    requestAnimationFrame(chk);
  });
});
const stat = a => { a = a.filter(x => x >= 0).sort((x, y) => x - y); return a.length ? `median ${a[a.length >> 1].toFixed(0)} ms, p95 ${a[Math.floor(a.length * 0.95)].toFixed(0)} ms, max ${a.at(-1).toFixed(0)} ms` : 'n/a'; };
const jank = async () => ev(() => { const j = J.splice(0).slice(1); return `${j.filter(x => x > 50).length} frames >50 ms (worst ${Math.max(0, ...j).toFixed(0)} ms)`; });
const row = (n, s) => console.log(`${n.padEnd(34)} ${s}`);
const twoFrames = a => ev(async a => (await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), performance.now() - a), a);
const now = () => ev(() => performance.now());

const projs = await ev(() => api('/api/projects')), src = projs.find(p => want.test(p.name)) || projs[0];
let t = Date.now();
const pid = await ev(async id => { const p = await api(`/api/projects/${id}`); p.id = hex12(); p.name = 'feel (scratch copy)'; setProject(p); renderAll(); await settled(); return P.id; }, src.id);
row(`open "${src.name}"`, `${Date.now() - t} ms`);
await page.waitForTimeout(1500); await jank();
const box = async sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

// 1. scrub the ruler like a hand: 60 moves, 33 ms apart
const rb = await box('#ruler');
await ev(() => { window.MV = []; window._mv = () => MV.push(performance.now()); window.addEventListener('pointermove', _mv, true); PT.length = 0; });
await page.mouse.move(rb.x + 30, rb.y + rb.h / 2); await page.mouse.down();
for (let i = 0; i <= 60; i++) { await page.mouse.move(rb.x + 30 + i * 12, rb.y + rb.h / 2); await page.waitForTimeout(33); }
await page.mouse.up();
const end = await ev(() => settled());
const sc = await ev(e => {
  window.removeEventListener('pointermove', _mv, true);
  const frames = new Set(PT.map(p => p[2].toFixed(3))).size;
  // per move: when did the picture first show a frame for that move's time (paint whose video time changed after it)
  const lag = MV.map(m => { const i = PT.findIndex(q => q[0] > m); if (i < 0) return -1; const v0 = PT[Math.max(0, i - 1)][2]; const p = PT.slice(i).find(q => Math.abs(q[2] - v0) > 1e-4); return p ? p[0] - m : -1; });
  return { frames, moves: MV.length, tail: e - MV.at(-1), lag };
}, end);
row('scrub: distinct frames shown', `${sc.frames} for ${sc.moves} moves; settles ${sc.tail.toFixed(0)} ms after the hand stops`);
row('scrub: move -> new picture', stat(sc.lag));
row('scrub jank', await jank());

// 2. click to jump: 12 clicks along the ruler
const jumps = [];
for (let i = 0; i < 12; i++) {
  const x = rb.x + 40 + ((i * 397) % Math.max(100, rb.w - 80)), a = await now();
  await page.mouse.click(x, rb.y + rb.h / 2);
  jumps.push(await ev(async a => { const s = await settled(); return s < 0 ? -1 : s - a; }, a));
}
row('click on ruler -> frame shown', stat(jumps));
row('jump jank', await jank());

// 3. play: space -> moving picture; then 8 s across the cuts
await ev(() => { S.t = 0; S.dirty = true; }); await ev(() => settled());
await ev(() => { PT.length = 0; window._k = performance.now(); });
await page.keyboard.press('Space');
await page.waitForTimeout(8000);
const pl = await ev(() => {
  const k = _k, first = PT.find(p => p[1] > 0.001); let uniq = 0, prev = -9; const gaps = []; let lastT = null;
  for (const p of PT) if (Math.abs(p[2] - prev) > 1e-4) { uniq++; if (lastT !== null) gaps.push(p[0] - lastT); lastT = p[0]; prev = p[2]; }
  const T = S.t; pause();
  return { start: first ? first[0] - k : -1, fps: uniq / 8, stalls: gaps.filter(g => g > 100).length, worst: Math.max(0, ...gaps), cuts: P.main.filter(c => c.start > 0 && c.start < T).length, fpsP: P.fps };
});
row('space -> picture moves', `${pl.start.toFixed(0)} ms`);
row('playback', `${pl.fps.toFixed(1)} new frames/s of ${pl.fpsP}, ${pl.stalls} stalls >100 ms (worst ${pl.worst.toFixed(0)} ms) across ${pl.cuts} cuts`);
row('playback jank', await jank());

// 4. click a clip -> selected with inspector
const sel = [];
for (let i = 0; i < 6; i++) {
  const c = await box(`.clip.main:nth-of-type(${i % 2 ? 4 : 6})`), a = await now();
  await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
  sel.push(await twoFrames(a));
}
row('click a clip -> inspector', stat(sel));
row('select jank', await jank());

// 5. drag a slider in the inspector
const sl = await page.$('#inspector input[type=range]');
if (sl) {
  const s = await sl.boundingBox(); await ev(() => { PT.length = 0; });
  await page.mouse.move(s.x + 5, s.y + s.height / 2); await page.mouse.down();
  for (let i = 0; i <= 40; i++) { await page.mouse.move(s.x + 5 + i * (s.width - 10) / 40, s.y + s.height / 2); await page.waitForTimeout(25); }
  await page.mouse.up();
  row('drag an inspector slider (1 s)', `${await ev(() => PT.length)} preview repaints · ${await jank()}`);
}

// 6. drag a clip along the timeline, then trim an edge
const cb = await box('.clip.main:nth-of-type(4)');
await page.mouse.move(cb.x + cb.w / 2, cb.y + cb.h / 2); await page.mouse.down();
for (let i = 0; i <= 40; i++) { await page.mouse.move(cb.x + cb.w / 2 + i * 6, cb.y + cb.h / 2); await page.waitForTimeout(25); }
await page.mouse.up();
row('drag a clip (1 s)', await jank());
await page.keyboard.press('Meta+z');
const c2 = await box('.clip.main:nth-of-type(5)');
await page.mouse.move(c2.x + c2.w - 2, c2.y + c2.h / 2); await page.mouse.down();
for (let i = 0; i <= 30; i++) { await page.mouse.move(c2.x + c2.w - 2 - i * 3, c2.y + c2.h / 2); await page.waitForTimeout(25); }
await page.mouse.up();
row('trim an edge (0.75 s)', await jank());

// 7. undo / redo
const ur = [];
for (let i = 0; i < 6; i++) { const a = await now(); await page.keyboard.press(i % 2 ? 'Meta+Shift+z' : 'Meta+z'); ur.push(await ev(async a => { const s = await settled(); return s < 0 ? -1 : s - a; }, a)); }
row('undo/redo -> frame shown', stat(ur));

// 8. library tabs
const tabs = await page.$$eval('.rail button[data-tab]', bs => bs.map(b => b.dataset.tab));
const tt = [];
for (const tb of [...tabs, 'media']) { const a = await now(); await page.click(`.rail button[data-tab="${tb}"]`); tt.push(`${tb} ${(await twoFrames(a)).toFixed(0)}`); }
row('library tab -> drawn (ms)', tt.join(', '));
row('tabs jank', await jank());

// 9. zoom the timeline with the slider
const z = await box('#zoom');
await page.mouse.move(z.x + 2, z.y + z.h / 2); await page.mouse.down();
for (let i = 0; i <= 40; i++) { await page.mouse.move(z.x + 2 + i * (z.w - 4) / 40, z.y + z.h / 2); await page.waitForTimeout(25); }
await page.mouse.up();
row('drag the zoom slider (1 s)', await jank());

// 10. the projects screen
const a = await now();
await ev(() => openProjects());
row('projects screen', `${(await twoFrames(a)).toFixed(0)} ms · ${await jank()}`);

await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await b.close();
