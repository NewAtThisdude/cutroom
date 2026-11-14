// Split-screen layouts and the audio visualizer, in headless WebKit (both motion modes), preview against the export engine.
// Layouts: four coloured clips in a grid with a white gap and rounded corners: every cell's centre shows its clip, the gaps
// and the corners show the gap colour, in the preview AND the export engine's frame; changing the layout (grid -> side by
// side -> one big + two -> grid) and the canvas shape (16:9 -> 9:16) re-flows the cells and keeps every clip; pan / zoom in a
// cell (REMOTE and a real drag in the preview); a cell sliding in; media dropped on an empty cell; undo, redo, reload.
// Visualizer: beeps at known times (1 kHz 0.5-1.0 s, 4 kHz 2.0-2.5 s, 200 Hz 3.0-3.5 s): the expected bar peaks on the
// expected frames, silence is flat, the drawn bars match between preview and export, the numbers are the same after the caches
// are dropped and two exports agree; source = one clip vs the whole mix; brand colours by default; every style; undo, reload.
//   CUTROOM_HOME=<scratch lib> CUTROOM_PORT=4753 python3 -I server.py, then
//   B=http://127.0.0.1:4753 CUTROOM_HOME=<same lib> CUTROOM_SCRATCH=<scratch dir> node layouts_viz.mjs
import { execNiceSync } from './runtime.mjs';
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
const B = process.env.B || 'http://127.0.0.1:4753', HOME = process.env.CUTROOM_HOME, SCR = process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch';
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const api = async (path, body) => {
  const r = await fetch(B + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH'));
const ff = (...a) => execNiceSync('ffmpeg', ['-v', 'error', '-y', ...a], { env });
const near = (p, q, tol = 48) => p.every((v, i) => Math.abs(v - q[i]) <= tol);
const RED = [255, 0, 0], GREEN = [0, 200, 0], BLUE = [0, 0, 255], YEL = [255, 255, 0], WHITE = [255, 255, 255], BLACK = [0, 0, 0];

// ---- fixtures ----
mkdirSync(SCR, { recursive: true });
const FX = mkdtempSync(`${SCR}/layouts-viz-`), tok = FX.slice(-6);
const vid = (n, c, s, hz) => ff('-f', 'lavfi', '-i', `color=c=${c}:s=${s}:r=30:d=3`, ...(hz ? ['-f', 'lavfi', '-i', `sine=f=${hz}:d=3:sample_rate=48000`, '-c:a', 'aac', '-shortest'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${FX}/${n}-${tok}.mp4`);
vid('red', '0xff0000', '640x360'); vid('green', '0x00c800', '360x640', 600); vid('yellow', '0xffff00', '640x360', 700); // green and yellow have sound
ff('-f', 'lavfi', '-i', 'color=c=0x0000ff:s=400x400', '-frames:v', '1', `${FX}/blue-${tok}.png`);
ff('-f', 'lavfi', '-i', 'color=c=0xff0000:s=400x400', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=400x400', '-filter_complex', '[0][1]hstack', '-frames:v', '1', `${FX}/split-${tok}.png`); // left red, right blue
const TONES = [[1000, 0.5, 1.0], [4000, 2.0, 2.5], [200, 3.0, 3.5]];
ff('-f', 'lavfi', '-i', `aevalsrc=${TONES.map(([f, a, b]) => `0.5*sin(2*PI*${f}*t)*between(t\\,${a}\\,${b})`).join('+')}:s=48000:d=4`, '-ac', '2', `${FX}/beeps-${tok}.wav`);
ff('-f', 'lavfi', '-i', 'sine=f=500:d=4:sample_rate=48000', '-ac', '2', `${FX}/tone-${tok}.wav`);
ff('-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*3000*t)*between(t\\,55\\,56):s=48000:d=70', '-ac', '2', `${FX}/long-${tok}.wav`); // 70 s: a 3 kHz tone at 55-56 s, past the server's 8 MiB (~44 s) per range answer
const imp = n => api('/api/import_path', { path: `${FX}/${n}` });
const MD = {};
for (const [k, n] of [['red', 'red.mp4'], ['green', 'green.mp4'], ['yellow', 'yellow.mp4'], ['blue', 'blue.png'], ['split', 'split.png'], ['beeps', 'beeps.wav'], ['tone', 'tone.wav'], ['long', 'long.wav']]) MD[k] = (await imp(n.replace('.', `-${tok}.`))).id;
for (let i = 0; i < 120; i++) { const m = await api('/api/media'); if (Object.values(MD).every(x => m.find(y => y.id === x)?.ready)) break; await sleep(500); }
const brand0 = await api('/api/brand');

const b = await browser.launch();
const errs = [];
const open = async rm => {
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: rm })).newPage();
  page.on('pageerror', e => errs.push(`${rm}: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.route(u => u.pathname === '/api/remote/next', async q => { await sleep(15000); q.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE !== 'undefined' && typeof REMOTE.layout === 'function', null, { timeout: 20000 });
  await page.evaluate(() => { if (typeof tourAt !== 'undefined' && tourAt >= 0) tourGo('skip'); });
  await page.evaluate(() => loadMedia());
  return page;
};
const R = (page, cmd, args = {}) => page.evaluate(([c, a]) => REMOTE[c](a), [cmd, args]);
// a snapshot as {w, h, d: RGBA}: the preview (preview = true) or the export engine's frame
const shot = async (page, t, preview, max = 640) => page.evaluate(async ([t, preview, max]) => {
  const r = await REMOTE.snapshot({ t, max, preview }), bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob());
  const cv = new OffscreenCanvas(bm.width, bm.height), x = cv.getContext('2d'); x.drawImage(bm, 0, 0);
  return { w: bm.width, h: bm.height, d: [...x.getImageData(0, 0, bm.width, bm.height).data], png: r.image };
}, [t, preview, max]);
const at = (s, u, v, r = 1) => { // mean RGB around fractional point (u, v)
  const x0 = Math.round(u * s.w - 0.5), y0 = Math.round(v * s.h - 0.5), o = [0, 0, 0];
  let n = 0;
  for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) { if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue; const i = (y * s.w + x) * 4; for (let k = 0; k < 3; k++) o[k] += s.d[i + k]; n++; }
  return o.map(q => Math.round(q / n));
};
const diff = (a, z) => { // mean abs difference on a 64 x 64 grid of fractional points
  let t = 0;
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) { const p = at(a, (i + 0.5) / 64, (j + 0.5) / 64, 0), q = at(z, (i + 0.5) / 64, (j + 0.5) / 64, 0); t += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
  return t / (64 * 64 * 3);
};
const both = async (page, t) => [await shot(page, t, true), await shot(page, t, false)];
const filePx = (f, t, u, v, W, H) => { // a frame of an exported file at t, sampled at fractional (u, v)
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { env, maxBuffer: 1 << 26 });
  const x = Math.round(u * W - 0.5), y = Math.round(v * H - 0.5);
  return [0, 1, 2].map(k => raw[(y * W + x) * 3 + k]);
};

const pa = await open('reduce');
// ===================================== layouts =====================================
const P1 = (await R(pa, 'new_project', { ratio: '16:9', name: 'Layouts test', branded: false })).id ?? await pa.evaluate(() => P.id);
const info = await R(pa, 'layout', { type: '4', media: [MD.red, MD.green, MD.blue, MD.yellow], gap: 0.03, color: '#ffffff', corners: 0.03, start: 0 });
const COLS = [RED, GREEN, BLUE, YEL], g = 0.03 * 1080, cw = 0.5 * (1920 - g) - g, ch = 0.5 * (1080 - g) - g;
check('a grid of four: four cells (one clip each) and the gap colour under them', info.cells.length === 4 && info.cells.every(c => c.clips.length === 1) && info.bg && info.color === '#ffffff'
  && Math.abs(info.cells[0].rect[0] - g) < 0.1 && Math.abs(info.cells[0].rect[2] - cw) < 0.2 && Math.abs(info.cells[3].rect[1] - (g + 0.5 * (1080 - g))) < 0.2 && Math.abs(info.cells[3].rect[3] - ch) < 0.2, JSON.stringify(info.cells.map(c => c.rect)));
const lay = await pa.evaluate(() => ({ n: P.overlay.length, cells: P.overlay.filter(c => c.cell).length, L: P.layouts.length, track: P.overlay.map(c => c.track) }));
check('the cells are plain overlay clips (they stay editable)', lay.n === 5 && lay.cells === 4 && lay.L === 1, JSON.stringify(lay));
const ctr = (rect, W = 1920, H = 1080) => [(rect[0] + rect[2] / 2) / W, (rect[1] + rect[3] / 2) / H];
const cellsOk = (s, inf, cols, W, H) => inf.cells.map((c, i) => [at(s, ...ctr(c.rect, W, H), 3), cols[i]]).filter(([p, q]) => !near(p, q));
let [pv, ex] = await both(pa, 1);
for (const [s, what] of [[pv, 'preview'], [ex, 'export']]) {
  check(`${what}: each cell shows its clip`, !cellsOk(s, info, COLS, 1920, 1080).length, JSON.stringify(cellsOk(s, info, COLS, 1920, 1080)));
  const gaps = [at(s, 0.5, 0.5), at(s, 0.5, 0.25), at(s, 0.25, 0.5), at(s, 2 / 640, 0.25), at(s, 0.75, 1 - 2 / 360)];
  check(`${what}: the gaps (between and round the cells) are the gap colour`, gaps.every(p => near(p, WHITE)), JSON.stringify(gaps));
  const [x0, y0] = info.cells[0].rect, corner = at(s, (x0 + 2) / 1920, (y0 + 2) / 1080, 0), edge = at(s, (x0 + 60) / 1920, (y0 + 4) / 1080, 0);
  check(`${what}: rounded corners (the corner shows the gap colour, the edge beside it the clip)`, near(corner, WHITE, 60) && near(edge, RED), JSON.stringify({ corner, edge }));
}
check('preview == export (whole frame)', diff(pv, ex) < 6, diff(pv, ex).toFixed(2));

// change the layout: re-flow, keep every clip
const flow = async (type, cols, label) => {
  const r = await R(pa, 'layout', { id: info.id, type });
  const [p, e] = await both(pa, 1), all = await pa.evaluate(id => P.overlay.filter(c => c.cell?.L === id).length, info.id);
  check(`${label}: ${r.cells.length} cells shown, ${r.parked.length} clips kept aside, all ${all} still on the timeline`, all === 4 && r.cells.length + r.parked.length === 4 && !cellsOk(p, r, cols, 1920, 1080).length && !cellsOk(e, r, cols, 1920, 1080).length && diff(p, e) < 6,
    JSON.stringify({ pv: cellsOk(p, r, cols, 1920, 1080), ex: cellsOk(e, r, cols, 1920, 1080), d: diff(p, e).toFixed(2) }));
  return r;
};
const r2 = await flow('2h', [RED, GREEN], 'side by side');
// a parked clip is not heard: the preview's scheduler plays the shown cell's sound and not the parked one's; the export leaves it out
const hear = async () => { // play 1.2 s from 0.5 s: which clips got a voice in the audio scheduler
  await pa.evaluate(() => { pause(); voices.clear(); seekTo(0.5); });
  await pa.keyboard.press('Space'); await pa.waitForTimeout(1200);
  return pa.evaluate(() => { pause(); return [...voices.keys()]; });
};
const ids = await pa.evaluate(id => Object.fromEntries(P.overlay.filter(c => c.cell?.L === id).map(c => [c.cell.i, c.id])), info.id);
const h2 = await hear(), plan2 = await pa.evaluate(() => buildPlan(320, 180, 'fast', 'parked', false, 'png').then(p => p.overlay.map(o => o.media)));
check('side by side: the shown cell is heard, the parked one is silent in the preview and left out of the export', h2.includes(ids[1]) && !h2.includes(ids[3]) && !plan2.includes(MD.yellow) && plan2.includes(MD.green), JSON.stringify({ h2, ids }));
check('side by side: the left half is the first clip, the right the second', r2.cells[0].rect[0] < 40 && r2.cells[1].rect[0] > 960);
await flow('3', [RED, GREEN, BLUE], 'one big, two small');
await flow('4', COLS, 'back to the grid');
const h4 = await hear();
check('back to the grid: that clip is heard again', h4.includes(ids[1]) && h4.includes(ids[3]), JSON.stringify(h4));

// the canvas shape: 9:16 re-flows the cells
await R(pa, 'set_project', { set: { ratio: '9:16' } });
const tall = await R(pa, 'layout', { id: info.id });
[pv, ex] = await both(pa, 1);
check('9:16: the cells re-flow to the new shape', Math.abs(tall.cells[1].rect[0] - (0.03 * 1080 + 0.5 * (1080 - 0.03 * 1080))) < 0.2 && Math.abs(tall.cells[2].rect[1] - (0.03 * 1080 + 0.5 * (1920 - 0.03 * 1080))) < 0.2, JSON.stringify(tall.cells.map(c => c.rect)));
check('9:16: every clip shows in its cell, preview and export', !cellsOk(pv, tall, COLS, 1080, 1920).length && !cellsOk(ex, tall, COLS, 1080, 1920).length && diff(pv, ex) < 6,
  JSON.stringify({ pv: cellsOk(pv, tall, COLS, 1080, 1920), ex: cellsOk(ex, tall, COLS, 1080, 1920), d: diff(pv, ex).toFixed(2) }));
await R(pa, 'history', { action: 'undo' });
check('undo: back to 16:9 and its cells', await pa.evaluate(([id, u]) => P.w === 1920 && Math.abs(P.overlay.find(c => c.cell?.L === id && c.cell.i === 1).x - (u - 0.5)) < 1e-6, [info.id, ctr(info.cells[1].rect)[0]]));

// a cell slides in (the clip's own In animation)
await pa.evaluate(id => { const c = P.overlay.find(x => x.cell?.L === id && x.cell.i === 1); change(() => { c.anim = { in: 'right', ind: 1 }; }); }, info.id);
[pv, ex] = await both(pa, 0.3);
const sl = [at(pv, ...ctr(info.cells[1].rect), 3), at(ex, ...ctr(info.cells[1].rect), 3)];
check('a cell sliding in: on its way at 0.3 s (its cell not yet covered), the same in the export', !near(sl[0], GREEN) && diff(pv, ex) < 6, JSON.stringify({ sl, d: diff(pv, ex).toFixed(2) }));
[pv, ex] = await both(pa, 1.2);
check('...and in its cell once it has arrived', near(at(pv, ...ctr(info.cells[1].rect), 3), GREEN) && near(at(ex, ...ctr(info.cells[1].rect), 3), GREEN));

// an exported MP4: the grid, gaps and corners
const ex1 = await R(pa, 'export', { format: 'mp4', resolution: '720p', name: 'layouts grid test' }), f1 = `${HOME}/exports/${ex1.file}`;
const mp = [...info.cells.map(c => filePx(f1, 1.5, ...ctr(c.rect), 1280, 720)), filePx(f1, 1.5, 0.5, 0.5, 1280, 720)];
check('the exported MP4: four clips in their cells, the gap colour between them', mp.slice(0, 4).every((p, i) => near(p, COLS[i])) && near(mp[4], WHITE), JSON.stringify(mp));

// pan and zoom inside a cell
await R(pa, 'new_project', { ratio: '16:9', name: 'Layout pan test', branded: false });
const pl = await R(pa, 'layout', { type: '2h', media: [MD.split, MD.blue], gap: 0, color: null, start: 0, duration: 2 });
const c0 = pl.cells[0].clips[0], mid0 = ctr(pl.cells[0].rect);
const pan = async (p, label, want) => {
  await R(pa, 'layout', { id: pl.id, cell: 0, pan: p });
  const [a, z] = await both(pa, 0.5), v = [at(a, ...mid0, 3), at(z, ...mid0, 3)];
  check(`pan ${label}: the cell shows the ${want === RED ? 'left (red)' : 'right (blue)'} part, preview and export`, near(v[0], want) && near(v[1], want) && diff(a, z) < 6, JSON.stringify({ v, d: diff(a, z).toFixed(2) }));
};
await pan([-1, 0], 'left', RED);
await pan([1, 0], 'right', BLUE);
await R(pa, 'layout', { id: pl.id, cell: 0, zoom: 3, pan: [0, 0] });
[pv, ex] = await both(pa, 0.5);
const zc = await pa.evaluate(id => P.overlay.find(c => c.id === id).crop, c0);
check('zoom 3x: a third of the picture, still filling the cell exactly (preview == export)', Math.abs((1 - zc.l - zc.r) - (pl.cells[0].rect[2] / 1080 / 2) / 3) < 1e-3 && diff(pv, ex) < 6, JSON.stringify({ zc, d: diff(pv, ex).toFixed(2) }));
await R(pa, 'layout', { id: pl.id, cell: 0, zoom: 1, pan: [0, 0] });
// a real drag in the preview pans the picture with the pointer (content goes right = the crop goes left)
await pa.evaluate(id => { S.sel = { lane: 'overlay', id }; seekTo(0.5); renderAll(); S.dirty = true; }, c0);
await pa.waitForTimeout(300);
const cvb = await pa.locator('#cv').boundingBox(), n0 = await pa.evaluate(() => undo.length);
const sx = cvb.x + cvb.width * mid0[0], sy = cvb.y + cvb.height * mid0[1];
await pa.mouse.move(sx, sy); await pa.mouse.down();
for (let i = 1; i <= 10; i++) await pa.mouse.move(sx + 8 * i, sy);
await pa.mouse.up(); await pa.waitForTimeout(150);
const dg = await pa.evaluate(id => ({ px: P.overlay.find(c => c.id === id).cell.px, n: undo.length, x: P.overlay.find(c => c.id === id).x }), c0);
check('a drag inside the cell pans its picture (one undo step), the clip stays in its cell', dg.px < -0.05 && dg.n === n0 + 1 && Math.abs(dg.x - (mid0[0] - 0.5)) < 1e-6, JSON.stringify(dg));
// corner handle: zoom
const hz = await pa.evaluate(id => { S.dirty = true; paint(); const h = hits.find(q => q.id === id), cv = $('#cv'); return h && { x: h.x1 / cv.width, y: h.y1 / cv.height }; }, c0);
await pa.mouse.move(cvb.x + cvb.width * hz.x - 1, cvb.y + cvb.height * hz.y - 1); await pa.mouse.down();
for (let i = 1; i <= 8; i++) await pa.mouse.move(cvb.x + cvb.width * hz.x + 6 * i, cvb.y + cvb.height * hz.y + 6 * i);
await pa.mouse.up(); await pa.waitForTimeout(150);
check('dragging a corner handle zooms inside the cell', await pa.evaluate(id => P.overlay.find(c => c.id === id).cell.z > 1.05, c0));
// media dropped on an empty cell fills it
await R(pa, 'layout', { id: pl.id, type: '3' });
const dropped = await pa.evaluate(async mid => {
  const cv = $('#cv'), r = cv.getBoundingClientRect(), L = P.layouts[0], [x, y, w, h] = layoutCells(L, P.w, P.h)[2], dt = new DataTransfer();
  dt.setData('text/cutroom-media', mid);
  const at = { clientX: r.left + ((x + w / 2) / P.w) * r.width, clientY: r.top + ((y + h / 2) / P.h) * r.height, dataTransfer: dt, bubbles: true, cancelable: true };
  const over = new DragEvent('dragover', at); cv.dispatchEvent(over);
  cv.dispatchEvent(new DragEvent('drop', at));
  return { took: over.defaultPrevented, cell: P.overlay.find(c => c.cell?.L === L.id && c.cell.i === 2)?.media };
}, MD.yellow);
check('media dragged from the library onto an empty cell fills it', dropped.took && dropped.cell === MD.yellow, JSON.stringify(dropped));

// the Layouts tab and the inspector
await pa.evaluate(id => { S.sel = { lane: 'overlay', id }; openTab('layouts'); renderAll(); }, c0);
const ui = await pa.evaluate(() => ({ tiles: $$('#layTiles [data-layout]').length, on: $('#layTiles .on')?.dataset.layout, rows: !!$('#inspector [data-k="lay.gap"]') && !!$('#inspector [data-k="c.cell.z"]'), col: !!$('#inspector [data-laycol]') }));
check('the Layouts tab: six layouts drawn at the project shape, the selected one marked; the inspector has gap, corners, colour, zoom', ui.tiles === 6 && ui.on === '3' && ui.rows && ui.col, JSON.stringify(ui));
await pa.click('#layTiles [data-layout="2v"]');
await pa.waitForFunction(() => P.layouts[0].type === '2v');
check('picking a tile changes the selected layout', await pa.evaluate(() => P.overlay.filter(c => c.cell && !c.cell.off).length === 2));
await pa.evaluate(() => { const s = $('#inspector [data-k="lay.gap"]'); s.value = 0.05; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
check('the gap slider re-flows the cells', await pa.evaluate(() => Math.abs(layoutCells(P.layouts[0], P.w, P.h)[0][0] - 0.05 * 1080) < 0.1 && Math.abs(P.overlay.find(c => c.cell?.i === 0).y - (0.05 * 1080 + (0.5 * (1080 - 54) - 54) / 2) / 1080 + 0.5) < 1e-3));
await pa.screenshot({ path: `${FX}/layouts-reduce.png` });

// undo / redo the whole layout, then reload
await R(pa, 'open_project', { project: P1 });
const nU = await pa.evaluate(() => undo.length);
await R(pa, 'new_project', { ratio: '16:9', name: 'Layouts undo test', branded: false });
await R(pa, 'layout', { type: 'pip', media: [MD.red, MD.blue], corners: 0.04, corner: 'tl', start: 0 });
const pip = await pa.evaluate(() => ({ L: P.layouts.length, n: P.overlay.length, bg: P.overlay.some(c => c.layBg) }));
[pv, ex] = await both(pa, 1);
const pipPts = [at(pv, 0.75, 0.75, 3), at(pv, 0.2, 0.2, 3), at(ex, 0.75, 0.75, 3), at(ex, 0.2, 0.2, 3)];
check('picture in picture: the second clip in the top left corner over the first (no gap colour)', pip.n === 2 && !pip.bg && near(pipPts[0], RED) && near(pipPts[1], BLUE) && near(pipPts[2], RED) && near(pipPts[3], BLUE) && diff(pv, ex) < 6, JSON.stringify({ pip, pipPts }));
await R(pa, 'history', { action: 'undo' });
check('undo removes the layout and its clips in one step', await pa.evaluate(() => !P.layouts?.length && !P.overlay.length));
await R(pa, 'history', { action: 'redo' });
check('redo brings them back', await pa.evaluate(() => P.layouts.length === 1 && P.overlay.length === 2));
await R(pa, 'open_project', { project: P1 });
await pa.evaluate(() => flushSave());
await sleep(500);

// ===================================== visualizer =====================================
await api('/api/brand', { ...brand0, colors: ['#ff8800', '#0088ff'] });
await pa.evaluate(() => loadBrand());
await R(pa, 'new_project', { ratio: '16:9', name: 'Visualizer test', branded: false });
const P2 = await pa.evaluate(() => P.id);
const beeps = await R(pa, 'add_clip', { media: MD.beeps, lane: 'audio', start: 0 });
const vz = await R(pa, 'visualizer', { style: 'bars', bars: 16, smoothing: 0, start: 0, duration: 4, x: 0.5, y: 0.5, w: 0.8, h: 0.5 });
check('a visualizer takes the brand colours by default', vz.viz.c1 === '#ff8800' && vz.viz.c2 === '#0088ff', JSON.stringify(vz.viz));
const N = 16, barOf = f => Math.floor((Math.floor((64 * Math.log(f / 40)) / Math.log(400)) * N) / 64); // 64 log bands 40 Hz-16 kHz, grouped into N bars
const lev = await pa.evaluate(id => { const L = vizLevels(P.text.find(x => x.id === id)); return L && { f0: L.f0, nF: L.nF, n: L.n, lv: [...L.lv] }; }, vz.id);
const row = t => lev.lv.slice((Math.round(t * 30) - lev.f0) * N, (Math.round(t * 30) - lev.f0 + 1) * N), peak = r => r.indexOf(Math.max(...r));
for (const [f, a, z] of TONES) {
  const r = row((a + z) / 2), far = r.filter((_, i) => Math.abs(i - barOf(f)) > 2);
  check(`${f} Hz beep at ${a}-${z} s: bar ${barOf(f)} peaks, bars away from it stay low`, peak(r) === barOf(f) && r[barOf(f)] > 0.8 && Math.max(...far) < 0.35, `${r.map(x => x.toFixed(2)).join(' ')}`);
}
const quiet = [0.2, 1.5, 2.8, 3.8].map(row);
check('silence: every bar flat (0) between the beeps', quiet.every(r => r.every(x => x === 0)), JSON.stringify(quiet.map(r => Math.max(...r))));
check('the beep starts on its frame: 0.40 s flat, 0.53 s lit', Math.max(...row(0.4)) === 0 && row(17 / 30)[barOf(1000)] > 0.5, `${Math.max(...row(0.4))} ${row(17 / 30)[barOf(1000)]}`);
// the drawn bars: bar i spans [0.1 + 0.8 i / N + 0.8/N * 0.14, ...]; the box is y 0.25..0.75
const barU = i => 0.1 + (0.8 * (i + 0.5)) / N, lit = (s, i, v) => Math.max(...at(s, barU(i), v, 0)) > 120;
for (const [t, f] of [[0.75, 1000], [2.25, 4000], [3.25, 200]]) {
  [pv, ex] = await both(pa, t);
  const k = barOf(f), far = (k + 8) % N, v = 0.75 - 0.5 * 0.6; // 60 % up the box
  const got = [lit(pv, k, v), lit(pv, far, v), lit(ex, k, v), lit(ex, far, v)];
  check(`${t} s: bar ${k} drawn tall, bar ${far} short, preview and export (whole frame agrees)`, got[0] && !got[1] && got[2] && !got[3] && diff(pv, ex) < 4, JSON.stringify({ got, d: diff(pv, ex).toFixed(2) }));
}
[pv, ex] = await both(pa, 1.5);
const flat = s => [...Array(N).keys()].every(i => !lit(s, i, 0.6) && lit(s, i, 0.75 - 0.005));
check('1.5 s (silence): a flat row of bars, preview and export', flat(pv) && flat(ex), JSON.stringify([...Array(N).keys()].map(i => at(ex, barU(i), 0.745, 0))));
// deterministic: the caches dropped, the numbers again; two export-engine frames; two MP4s
const again = await pa.evaluate(id => { vzSpec.clear(); vzLv.clear(); return null; }, vz.id);
await pa.evaluate(() => vizReady());
const lev2 = await pa.evaluate(id => [...vizLevels(P.text.find(x => x.id === id)).lv], vz.id);
check('the levels are the same numbers when worked out again from the sound', again === null && lev2.length === lev.lv.length && lev2.every((x, i) => x === lev.lv[i]));
const e1 = await shot(pa, 0.75, false), e2 = await shot(pa, 0.75, false);
check('two export-engine frames are identical', e1.png === e2.png);
const xa = await R(pa, 'export', { format: 'mp4', resolution: '720p', name: 'viz test a' }), xb = await R(pa, 'export', { format: 'mp4', resolution: '720p', name: 'viz test b' });
const fa = `${HOME}/exports/${xa.file}`, fb = `${HOME}/exports/${xb.file}`;
const smp = f => [0.75, 1.5, 2.25, 3.25].flatMap(t => [barOf(1000), barOf(4000), barOf(200)].map(i => filePx(f, t + 0.01, barU(i), 0.45, 1280, 720)));
const sa = smp(fa), sb = smp(fb);
check('two exports agree frame by frame', sa.every((p, i) => near(p, sb[i], 6)), JSON.stringify({ sa: sa.slice(0, 3), sb: sb.slice(0, 3) }));
check('the exported MP4 lights the 1 kHz bar at 0.75 s and not at 1.5 s', Math.max(...sa[0]) > 120 && Math.max(...sa[3]) < 60, JSON.stringify([sa[0], sa[3]]));
// source: one clip vs the whole mix (a steady 500 Hz tone on another track)
await R(pa, 'add_clip', { media: MD.tone, lane: 'audio', start: 0 });
await pa.evaluate(() => vizReady());
const mixed = await pa.evaluate(id => { const L = vizLevels(P.text.find(x => x.id === id)); return [...L.lv.slice((45 - L.f0) * L.n, (46 - L.f0) * L.n)]; }, vz.id);
await R(pa, 'visualizer', { id: vz.id, source: beeps.id });
const solo = await pa.evaluate(id => { const L = vizLevels(P.text.find(x => x.id === id)); return [...L.lv.slice((45 - L.f0) * L.n, (46 - L.f0) * L.n)]; }, vz.id);
check('source = the whole mix: the 500 Hz tone shows at 1.5 s; source = the beeps clip: flat there', mixed[barOf(500)] > 0.6 && solo.every(x => x === 0), JSON.stringify({ mixed: mixed[barOf(500)], solo: Math.max(...solo) }));
// every style draws the same in the preview and the export
for (const style of ['mirror', 'line', 'circle']) {
  await R(pa, 'visualizer', { id: vz.id, style });
  [pv, ex] = await both(pa, 0.75);
  let ink = 0; // pixels drawn in the visualizer's box
  for (let y = Math.round(0.25 * pv.h); y < 0.75 * pv.h; y++) for (let x = Math.round(0.1 * pv.w); x < 0.9 * pv.w; x++) { const i = (y * pv.w + x) * 4; if (Math.max(pv.d[i], pv.d[i + 1], pv.d[i + 2]) > 100) ink++; }
  check(`${style}: drawn, and preview == export`, ink > 200 && diff(pv, ex) < 4, `${ink} px lit, diff ${diff(pv, ex).toFixed(2)}`);
}
await R(pa, 'visualizer', { id: vz.id, style: 'bars' });
// a source longer than one range answer (70 s, the tone at 55-56 s): read in pieces, lit on the right frames, preview == export
await R(pa, 'new_project', { ratio: '16:9', name: 'Visualizer long test', branded: false });
await R(pa, 'add_clip', { media: MD.long, lane: 'audio', start: 0 });
const vl = await R(pa, 'visualizer', { style: 'bars', bars: 16, smoothing: 0, start: 0, duration: 70, x: 0.5, y: 0.5, w: 0.8, h: 0.5 });
const ll = await pa.evaluate(id => { const L = vizLevels(P.text.find(x => x.id === id)); return [50, 54.9, 55.5, 55.9, 57].map(t => [...L.lv.slice((Math.round(t * 30) - L.f0) * L.n, (Math.round(t * 30) - L.f0 + 1) * L.n)]); }, vl.id);
const b3 = barOf(3000);
check(`70 s source: the 3 kHz tone lights bar ${b3} at 55.5 and 55.9 s; 50, 54.9 and 57 s are flat`, peak(ll[2]) === b3 && ll[2][b3] > 0.8 && ll[3][b3] > 0.8 && [0, 1, 4].every(i => ll[i].every(x => x === 0)), JSON.stringify(ll.map(r => Math.max(...r).toFixed(2))));
[pv, ex] = await both(pa, 55.5);
check('70 s source at 55.5 s: the bar is drawn in the preview and the export', lit(pv, b3, 0.45) && lit(ex, b3, 0.45) && !lit(ex, (b3 + 8) % N, 0.45) && diff(pv, ex) < 4, diff(pv, ex).toFixed(2));
await R(pa, 'open_project', { project: P2 });
await pa.evaluate(() => vizReady());
const levSaved = await pa.evaluate(id => [...vizLevels(P.text.find(x => x.id === id)).lv], vz.id);
// undo / redo
const nT = await pa.evaluate(() => P.text.length);
await pa.evaluate(() => openTab('audio'));
await pa.click('#vizTiles [data-viz="circle"]');
const added = await pa.evaluate(() => ({ n: P.text.length, sel: selClip()?.viz?.style, c1: selClip()?.viz?.c1, insp: !!$('#inspector [data-k="c.viz.n"]') && !!$('#inspector select[data-k="c.viz.src"]') }));
check('the Audio tab adds a visualizer at the playhead (brand colours), the inspector shows its controls', added.n === nT + 1 && added.sel === 'circle' && added.c1 === '#ff8800' && added.insp, JSON.stringify(added));
await R(pa, 'history', { action: 'undo' });
check('undo removes it in one step', await pa.evaluate(n => P.text.length === n, nT));
await R(pa, 'history', { action: 'redo' });
check('redo puts it back', await pa.evaluate(n => P.text.length === n + 1, nT));
await R(pa, 'history', { action: 'undo' });
await pa.screenshot({ path: `${FX}/viz-reduce.png` });
await pa.evaluate(() => flushSave());
await sleep(500);

// ===================================== reload (the other motion mode) =====================================
const pb = await open('no-preference');
await R(pb, 'open_project', { project: P2 });
await pb.evaluate(() => vizReady());
const rl = await pb.evaluate(() => { const it = P.text.find(x => x.viz); return { viz: it.viz, lv: [...vizLevels(it).lv] }; });
check('reload: the visualizer is there with its settings', rl.viz.src === beeps.id && rl.viz.n === 16 && rl.viz.style === 'bars' && rl.viz.c1 === '#ff8800', JSON.stringify(rl.viz));
[pv, ex] = await both(pb, 0.75);
check('reload: it draws the same in the preview and the export', lit(pv, barOf(1000), 0.45) && lit(ex, barOf(1000), 0.45) && diff(pv, ex) < 4, diff(pv, ex).toFixed(2));
check('reload: the same numbers as before the reload', rl.lv.length === levSaved.length && rl.lv.every((x, i) => x === levSaved[i]));
await R(pb, 'open_project', { project: P1 });
const back = await R(pb, 'layout', { id: info.id });
[pv, ex] = await both(pb, 1);
check('reload: the layout and its four cells are back, preview and export', back.cells.every(c => c.clips.length === 1) && !cellsOk(pv, back, COLS, 1920, 1080).length && !cellsOk(ex, back, COLS, 1920, 1080).length,
  JSON.stringify({ pv: cellsOk(pv, back, COLS, 1920, 1080), ex: cellsOk(ex, back, COLS, 1920, 1080) }));
await pb.evaluate(() => openTab('layouts'));
await pb.screenshot({ path: `${FX}/layouts-no-preference.png` });
check('no-preference: the Layouts tab draws its six tiles', await pb.evaluate(() => $$('#layTiles [data-layout]').length === 6));

await b.close();
await api('/api/brand', brand0);
check('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\nscreenshots in ${FX}\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
