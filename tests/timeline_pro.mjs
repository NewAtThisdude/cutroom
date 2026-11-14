// Pro timeline round: keyframe easing (presets + custom cubic-bezier graph), Ripple all, slip / slide / roll, the new mask
// shapes (heart, star, polygon, pen) and the AI subject mask (SAM 2), and the preview quality setting. Preview == export is
// checked by rendering the same frame both ways (MCP snapshot: canvas vs /api/still_frame), like video_parity.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node timeline_pro.mjs [only]   (never the 4610 server)
// only: ease | ripple | tools | mask | ai | quality (default: all). PHOTOS=<dir with iPhone MOVs> for ai + quality.
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4753', only = process.argv[2];
if (/:4610\b/.test(B)) throw new Error('run this on a scratch server, not 4610');
const PHOTOS = process.env.PHOTOS || `${process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch'}/photos`;
const on = k => !only || only === k;
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-tlpro-`);
const gen = (name, args) => { const f = `${tmp}/${name}`; execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return f; };
const files = {
  A: gen('tlpro-a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15']),
  W: gen('tlpro-white.png', ['-f', 'lavfi', '-i', 'color=white:s=640x360', '-frames:v', '1']),
  Snd: gen('tlpro-tone.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=3']),
};
const ids = {};
const post = (p, body) => fetch(`${B}${p}`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
for (const [k, f] of Object.entries(files)) ids[k] = (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id;
if ((on('ai') || on('quality')) && fs.existsSync(`${PHOTOS}/IMG_4654.MOV`)) ids.R = (await post('/api/import_path', { path: `${PHOTOS}/IMG_4654.MOV` })).id; // 4K120 HLG, an exhaust tip
fs.rmSync(tmp, { recursive: true });

const b = await browser.launch();
const pids = new Set();
async function openPage(rm = 'no-preference', dpr = 1) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm, deviceScaleFactor: dpr })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
  await page.evaluate(() => loadMedia());
  await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 600000 });
  await page.evaluate(ids => { Object.assign(window, ids); window.fresh = (r = '16:9') => { setProject(newProject(r)); P.name = 'Timeline pro (scratch)'; S.sel = null; S.multi.clear(); renderAll(); return P.id; }; window.main = id => { addMedia(id, 'main'); return P.main.at(-1); }; }, ids);
  page.errs = errs;
  return page;
}
// the same frame both ways: mean / worst 10x10 block difference in levels at 160x90, and pixels at fractions of the frame
const SHOOT = async T => {
  const ex = await REMOTE.snapshot({ t: T, max: 640 }), pv = await REMOTE.snapshot({ t: T, max: 640, preview: true });
  const load = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
  const [a, bb] = [await load(ex.image), await load(pv.image)];
  let sum = 0, worst = 0;
  for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) {
    let s = 0;
    for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 160 + x) * 4 + k; s += Math.abs(a[i] - bb[i]); }
    sum += s; worst = Math.max(worst, s / 300);
  }
  const at = (d, fx, fy) => { const i = (Math.min(89, Math.floor(fy * 90)) * 160 + Math.min(159, Math.floor(fx * 160))) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
  const full = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height); };
  const edges = d => [0.3, 0.5, 0.7].map(fy => { const y = Math.floor(fy * d.height); for (let x = 0; x < d.width; x++) { const i = (y * d.width + x) * 4; if (d.data[i] + d.data[i + 1] + d.data[i + 2] > 60) return x; } return -1; }); // the clip's left edge on 3 rows (full size)
  const [ee, pe] = [edges(await full(ex.image)), edges(await full(pv.image))];
  window.lastShot = { ex: a, pv: bb, at, edge: Math.max(...ee.map((v, i) => Math.abs(v - pe[i]))) };
  return { mean: +(sum / (160 * 90 * 3)).toFixed(2), worst: +worst.toFixed(1), t: ex.t, edge: window.lastShot.edge };
};
// Chrome / Edge (Skia) put a scaled clip's fractional edges a little differently from WebKit: the custom ease (overshooting) frame
// measures mean 3.95-4.06, worst block 31.3-31.5 there (WebKit 3.13 / 25.4), on a Mac's Chromium and Windows' Edge alike
const SKIA = (process.env.BROWSER || 'webkit') !== 'webkit';
const parityOk = (r, scaled) => r.mean <= (SKIA && scaled ? 4.5 : 4) && r.worst <= (SKIA && scaled ? 33 : 28);
const shoot = (page, T) => page.evaluate(`(${SHOOT})(${T})`);
const lum = (page, fx, fy) => page.evaluate(([fx, fy]) => [lastShot.at(lastShot.ex, fx, fy), lastShot.at(lastShot.pv, fx, fy)].map(v => Math.round(v)), [fx, fy]);
const ev = (page, f, a) => page.evaluate(f, a);

// ---------- 1. keyframe easing ----------
if (on('ease')) for (const rm of ['no-preference', 'reduce']) {
  const page = await openPage(rm);
  if (rm === 'no-preference') {
    const eases = { linear: null, in: null, out: null, inout: null, custom: [0.3, 1.6, 0.7, 1.2] }, xs = {};
    for (const [k, bz] of Object.entries(eases)) {
      pids.add(await ev(page, ([k, bz]) => { const id = fresh(); const c = main(A); c.kf = [{ t: 0, scale: 0.5, x: -0.3, y: 0, opacity: 1, rot: 0 }, { t: 2, scale: 1, x: 0.25, y: 0.1, opacity: 1, rot: 0 }]; if (bz) { c.kf[0].ease = true; c.kf[0].bz = bz; } else setEase(c, c.kf[0], k); renderAll(); return id; }, [k, bz]));
      const r = await shoot(page, 0.6);
      xs[k] = await ev(page, () => +propsAt(P.main[0], 0.6).x.toFixed(4));
      check(`ease ${k}: preview == export at u=0.3`, parityOk(r, true) && r.edge <= 1, `mean ${r.mean}, worst block ${r.worst}, clip edge ${r.edge} px apart, x=${xs[k]}`);
    }
    check('the five eases put the clip in five different places', new Set(Object.values(xs)).size === 5, JSON.stringify(xs));
    const ov = await ev(page, () => { const c = P.main[0]; return Math.max(...Array.from({ length: 41 }, (_, i) => propsAt(c, i / 20).x)); });
    check('a custom curve with y > 1 overshoots past the end keyframe', ov > 0.25 + 0.01, `peak x ${ov.toFixed(3)} vs end 0.25`);
    // a split inside an eased bezier segment keeps the exact curve on both halves (eu0 / eu1), in preview and export
    await ev(page, () => { const c = P.main[0]; S.t = 0.8; S.sel = { lane: 'main', id: c.id }; split(); renderAll(); });
    const sp = await ev(page, () => ({ k: P.main[1].kf[0], x: +propsAt(P.main[1], 0.4).x.toFixed(5) }));
    const r2 = await shoot(page, 1.2);
    check('split inside a bezier segment: the second half keeps bz + its part [eu0, eu1], preview == export', sp.k.bz?.[1] === 1.6 && Math.abs(sp.k.eu0 - 0.4) < 1e-6 && Math.abs(sp.x - xs.custom) > 0 && parityOk(r2, true), `eu0 ${sp.k.eu0?.toFixed(3)} eu1 ${sp.k.eu1?.toFixed(3)}, mean ${r2.mean}, worst ${r2.worst}`);
  }
  // the graph editor: drag a handle -> a custom cubic-bezier, one undo step, saved, and back after a reload
  const pid = await ev(page, () => { const id = fresh(); const c = main(A); c.kf = [{ t: 0, scale: 0.6, x: -0.2, y: 0, opacity: 1, rot: 0 }, { t: 2, scale: 1, x: 0.2, y: 0, opacity: 1, rot: 0 }]; S.sel = { lane: 'main', id: c.id }; seekTo(0.5); renderAll(); return id; });
  pids.add(pid);
  await page.click('#inspector [data-ease="out"]');
  const k1 = await ev(page, () => ({ kind: easeKind(P.main[0], P.main[0].kf[0]), bz: P.main[0].kf[0].bz }));
  check(`${rm}: the Ease out preset sets cubic-bezier(0, 0, 0.58, 1)`, k1.kind === 'out' && JSON.stringify(k1.bz) === '[0,0,0.58,1]', JSON.stringify(k1));
  await page.locator('#kfGraph').scrollIntoViewIfNeeded();
  const box = await ev(page, () => { const c = P.main[0], cv = $('#kfGraph'), r = cv.getBoundingClientRect(), h = kgHandles(c, kgGeo(c, cv))[0]; return { hx: r.left + cv.clientLeft + h[2], hy: r.top + cv.clientTop + h[3], width: cv.clientWidth, height: cv.clientHeight }; }), u0 = await ev(page, () => undo.length);
  const { hx, hy } = box; // handle 1 of ease-out sits at (0, 0) of the segment
  await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx + box.width * 0.2, hy - box.height * 0.3, { steps: 6 }); await page.mouse.up();
  const k2 = await ev(page, () => ({ kind: easeKind(P.main[0], P.main[0].kf[0]), bz: P.main[0].kf[0].bz, undos: undo.length, drawn: $('#kfGraph')?.width > 0 }));
  check(`${rm}: dragging a handle makes a custom curve in one undo step`, k2.kind === 'custom' && k2.undos === u0 + 1 && k2.bz[0] > 0.1 && k2.bz[1] > 0.3 && k2.drawn, JSON.stringify(k2));
  await ev(page, () => flushSave());
  await page.waitForTimeout(600);
  const saved = (await (await fetch(`${B}/api/projects/${pid}`, { headers: { 'X-Cutroom': '1' } })).json()).main[0].kf[0].bz;
  await ev(page, id => openProject(id), pid); await page.waitForTimeout(800);
  const back = await ev(page, () => P.main[0].kf[0].bz);
  check(`${rm}: the custom bezier round-trips (saved file, reopened project)`, JSON.stringify(saved) === JSON.stringify(k2.bz) && JSON.stringify(back) === JSON.stringify(k2.bz), JSON.stringify(saved));
  const r3 = await shoot(page, 0.9);
  check(`${rm}: the reopened custom curve renders the same in the export (clip edge within 1 px)`, r3.mean <= 4 && r3.edge <= 1, `mean ${r3.mean}, worst block ${r3.worst} (a scaled clip's bar edges land a pixel apart), left edge off by ${r3.edge} px at 640 wide`);
  if (rm === 'no-preference') {
    const m = await ev(page, async () => { const c = P.main[0]; try { await REMOTE.update_clip({ id: c.id, set: { kf: [{ t: 0, x: -0.2, ease: 'ease-in' }, { t: 2, x: 0.2 }] } }); } catch (e) { return e.message; } const a = P.main[0].kf[0]; let bad = ''; try { await REMOTE.update_clip({ id: c.id, set: { kf: [{ t: 0, ease: 'bouncy' }, { t: 1 }] } }); } catch (e) { bad = e.message; } return { kind: easeKind(P.main[0], a), bz: a.bz, bad }; });
    check('MCP update_clip takes ease names and refuses unknown ones', m.kind === 'in' && /ease must be/.test(m.bad), JSON.stringify(m));
  }
  check(`${rm}: no page errors (ease)`, !page.errs.length, page.errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 2. ripple all ----------
if (on('ripple')) {
  const page = await openPage();
  const setup = `(() => { const id = fresh(); for (const [a, o] of [[0, 2], [2, 4], [4, 6]]) { const c = main(A); c.in = a; c.out = o; }
    P.unlinked = true; P.rippleAll = true; packMain();
    const T = (start, dur, text) => { S.t = start; addText('Title', { start, dur, text }); };
    T(2.5, 1, 'over B'); T(1.5, 1, 'across the cut'); T(4.5, 1, 'over C');
    addMedia(W, 'overlay', 4.2); const o = P.overlay.at(-1); o.start = 4.2;
    addMedia(Snd, 'audio', 7); const au = P.audio.at(-1); au.start = 7;
    S.sel = null; renderAll(); return id; })()`;
  const state = () => ev(page, () => ({ text: P.text.map(x => [x.text, +x.start.toFixed(3), +x.dur.toFixed(3)]), ov: +P.overlay[0]?.start.toFixed(3), au: +P.audio[0]?.start.toFixed(3), main: +packMain().toFixed(3) }));
  pids.add(await ev(page, setup));
  await page.click('#btnRipple'); await page.click('#btnRipple'); // off and on again through the button
  const btn = await ev(page, () => [P.rippleAll, $('#btnRipple').classList.contains('on')]);
  check('the Ripple button toggles P.rippleAll and shows it', btn[0] === true && btn[1], JSON.stringify(btn));
  await ev(page, () => { S.sel = { lane: 'main', id: P.main[1].id }; del(); });
  const s1 = await state();
  check('ripple delete (unlinked): later items on every track move up 2 s', s1.ov === 2.2 && s1.au === 5 && s1.text.some(([t, s]) => t === 'over C' && s === 2.5), JSON.stringify(s1));
  check('ripple delete: an item over the removed picture goes, one across the cut is trimmed to it', !s1.text.some(([t]) => t === 'over B') && s1.text.some(([t, s, d]) => t === 'across the cut' && s === 1.5 && d === 0.5), JSON.stringify(s1.text));
  await ev(page, () => restore(undo, redo));
  const s0 = await state();
  check('undo brings it all back in one step', s0.ov === 4.2 && s0.au === 7 && s0.text.length === 3 && s0.main === 6, JSON.stringify(s0));
  // ripple trim with the mouse: drag the first clip's right edge 0.5 s left
  await ev(page, () => { S.pps = 100; renderTimeline(); });
  const e1 = await page.locator('.clip[data-lane="main"]').first().boundingBox();
  await page.mouse.move(e1.x + e1.width - 3, e1.y + e1.height - 8); await page.mouse.down(); await page.mouse.move(e1.x + e1.width - 3 - 50, e1.y + e1.height - 8, { steps: 8 }); await page.mouse.up();
  const s2 = await state();
  check('ripple trim (mouse): items after the trim move 0.5 s left on every track', Math.abs(s2.ov - 3.7) < 0.04 && Math.abs(s2.au - 6.5) < 0.04 && s2.main === 5.5, JSON.stringify(s2));
  await ev(page, () => restore(undo, redo));
  await ev(page, () => { delete P.rippleAll; S.sel = { lane: 'main', id: P.main[1].id }; del(); });
  const s3 = await state();
  check('control: ripple off + unlinked, the other tracks stay put', s3.ov === 4.2 && s3.au === 7 && s3.text.length === 3, JSON.stringify(s3));
  const mc = await ev(page, async () => { await REMOTE.set_project({ set: { rippleAll: true } }); return P.rippleAll; });
  check('MCP set_project rippleAll', mc === true);
  check('no page errors (ripple)', !page.errs.length, page.errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 3. slip / slide / roll ----------
if (on('tools')) for (const rm of ['no-preference', 'reduce']) {
  const page = await openPage(rm);
  pids.add(await ev(page, () => { const id = fresh(); for (const [a, o] of [[0, 2], [2, 4], [4.5, 6.5]]) { const c = main(A); c.in = a; c.out = o; } S.pps = 100; renderAll(); return id; }));
  const st = () => ev(page, () => ({ c: P.main.map(c => [+c.in.toFixed(3), +c.out.toFixed(3), +c.start.toFixed(3)]), total: +packMain().toFixed(3), undos: undo.length }));
  const s0 = await st();
  if (rm === 'no-preference') {
    const run = (action, by, side) => ev(page, async ([a, by, side]) => { await REMOTE.clip_tool({ id: P.main[1].id, action: a, by, side }); }, [action, by, side]);
    await run('slip', 0.5);
    const a = await st();
    check('MCP slip +0.5 s: in/out 0.5 s earlier, same place and length', JSON.stringify(a.c[1]) === JSON.stringify([1.5, 3.5, 2]) && a.total === s0.total && a.undos === s0.undos + 1, JSON.stringify(a.c));
    await run('slide', 0.4);
    const b2 = await st();
    check('MCP slide +0.4 s: the clip moves, neighbours give and take, total unchanged', JSON.stringify(b2.c[1]) === JSON.stringify([1.5, 3.5, 2.4]) && b2.c[0][1] === 2.4 && b2.c[2][0] === 4.9 && b2.total === s0.total, JSON.stringify(b2.c));
    await run('roll', -0.3, 'end');
    const c2 = await st();
    check('MCP roll -0.3 s at its end: one clip shorter, the next longer, total unchanged', c2.c[1][1] === 3.2 && c2.c[2][0] === 4.6 && c2.total === s0.total, JSON.stringify(c2.c));
    const bad = await ev(page, async () => { try { await REMOTE.clip_tool({ id: P.main[0].id, action: 'slide', by: 1 }); return 'no error'; } catch (e) { return e.message; } });
    check('slide refuses the first clip (no left neighbour), with a reason', /each side/.test(bad), bad);
    for (let i = 0; i < 3; i++) await ev(page, () => restore(undo, redo));
  }
  // the tool keys + mouse: Y = slip, drag the middle clip 40 px right (0.4 s); ⌥ on a cut = roll
  await page.mouse.click(5, 300); await page.keyboard.press('KeyY');
  const tool = await ev(page, () => [S.tool, $('#tlTool').value, $('#tlInner').dataset.tool]);
  check(`${rm}: Y picks the slip tool (picker + cursor follow)`, tool.every(x => x === 'slip'), tool.join(','));
  const mid = await page.locator('.clip[data-lane="main"]').nth(1).boundingBox();
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2); await page.mouse.down(); await page.mouse.move(mid.x + mid.width / 2 + 40, mid.y + mid.height / 2, { steps: 8 }); await page.mouse.up();
  const d = await st();
  check(`${rm}: slip drag (+0.4 s): earlier picture, same start, same total, one undo step`, Math.abs(d.c[1][0] - 1.6) < 0.02 && d.c[1][2] === 2 && d.total === s0.total && d.undos === s0.undos + 1, JSON.stringify(d.c[1]));
  await ev(page, () => restore(undo, redo));
  await page.keyboard.press('KeyV');
  const first = await page.locator('.clip[data-lane="main"]').first().boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(first.x + first.width - 3, first.y + first.height - 8); await page.mouse.down(); await page.mouse.move(first.x + first.width - 3 + 30, first.y + first.height - 8, { steps: 8 }); await page.mouse.up();
  await page.keyboard.up('Alt');
  const r = await st();
  check(`${rm}: ⌥-drag a cut rolls it (+0.3 s): one longer, the next shorter, total unchanged`, Math.abs(r.c[0][1] - 2.3) < 0.02 && Math.abs(r.c[1][0] - 2.3) < 0.02 && r.total === s0.total && r.undos === s0.undos + 1, JSON.stringify(r.c));
  await page.keyboard.press('KeyU');
  const sl = await ev(page, () => S.tool);
  const m2 = await page.locator('.clip[data-lane="main"]').nth(1).boundingBox();
  await page.mouse.move(m2.x + m2.width / 2, m2.y + m2.height / 2); await page.mouse.down(); await page.mouse.move(m2.x + m2.width / 2 - 20, m2.y + m2.height / 2, { steps: 8 }); await page.mouse.up();
  const s5 = await st();
  check(`${rm}: U + drag slides the middle clip 0.2 s left between its neighbours`, sl === 'slide' && Math.abs(s5.c[1][2] - (r.c[1][2] - 0.2)) < 0.02 && s5.c[1][0] === r.c[1][0] && s5.total === s0.total, JSON.stringify(s5.c));
  await page.keyboard.press('KeyV');
  check(`${rm}: no page errors (tools)`, !page.errs.length, page.errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 4. mask shapes ----------
if (on('mask')) {
  const page = await openPage();
  // a white picture filling the frame over black: inside the mask white, outside black (fractions of the frame, mask 0.6 x 0.6 at the centre)
  const cases = [['heart', {}, [[0.5, 0.5], [0.35, 0.33]], [[0.5, 0.29], [0.2, 0.75]]], ['star', { n: 5, inner: 0.45 }, [[0.5, 0.5], [0.5, 0.26]], [[0.641, 0.305], [0.3, 0.75]]],
    ['polygon', { n: 6 }, [[0.5, 0.5], [0.5, 0.24]], [[0.64, 0.25], [0.83, 0.5]]], ['pen', {}, [[0.5, 0.5], [0.5, 0.26]], [[0.77, 0.77], [0.23, 0.23]]]];
  for (const [type, extra, ins, outs] of cases) {
    for (const v of [{ feather: 0, invert: false }, { feather: 0.12, invert: true }]) {
      pids.add(await ev(page, ([type, extra, v]) => { const id = fresh(); P.bg = '#000000'; const c = main(W); c.mask = { type, x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, ...v, ...extra }; if (type === 'pen') c.mask.pts = PEN0.map(q => [...q]); renderAll(); return id; }, [type, extra, v]));
      const r = await shoot(page, 0.5);
      let shape = '';
      if (!v.invert) {
        const a = await Promise.all(ins.map(([x, y]) => lum(page, x, y))), o = await Promise.all(outs.map(([x, y]) => lum(page, x, y)));
        const ok = a.every(p => p.every(q => q > 200)) && o.every(p => p.every(q => q < 50));
        shape = ok ? '' : `inside ${JSON.stringify(a)} outside ${JSON.stringify(o)}`;
        check(`mask ${type}: the shape (inside white, outside black) in preview and export`, ok, shape || `inside ${JSON.stringify(a)} outside ${JSON.stringify(o)}`);
      }
      check(`mask ${type}${v.invert ? ' feathered + inverted' : ''}: preview == export`, parityOk(r), `mean ${r.mean}, worst block ${r.worst}`);
    }
  }
  // keyframed star: the mask moves between its keyframes, same in the export
  pids.add(await ev(page, () => { const id = fresh(); P.bg = '#000000'; const c = main(W); c.mask = { type: 'star', x: -0.25, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0.05, invert: false, n: 6 }; c.mkf = [{ t: 0, x: -0.25, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0.05 }, { t: 2, x: 0.25, y: 0, w: 0.5, h: 0.5, rot: 90, feather: 0.05 }]; renderAll(); return id; }));
  const rk = await shoot(page, 1);
  const kc = await lum(page, 0.5, 0.5);
  check('mask star keyframed, half way: at the centre then, preview == export', parityOk(rk) && kc.every(q => q > 200), `mean ${rk.mean}, worst ${rk.worst}, centre ${kc}`);
  // pen: drag a point on the preview with the mouse (one undo step), the export follows
  pids.add(await ev(page, () => { const id = fresh(); P.bg = '#000000'; const c = main(W); c.mask = { type: 'pen', x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 0, invert: false, pts: PEN0.map(q => [...q]) }; S.sel = { lane: 'main', id: c.id }; seekTo(0.5); renderAll(); return id; }));
  await page.waitForTimeout(400);
  await ev(page, () => waitFrame());
  const pt = await ev(page, () => { const c = P.main[0], h = hits.find(q => q.id === c.id), [x, y] = penMap(c, h).to(c.mask.pts[1]), cv = $('#cv'), r = cv.getBoundingClientRect(), k = cv.width / r.width; return { x: r.left + x / k, y: r.top + y / k, u: undo.length, k }; });
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.move(pt.x + 60, pt.y + 20, { steps: 6 }); await page.mouse.up();
  const after = await ev(page, () => ({ p: P.main[0].mask.pts[1], u: undo.length, sel: S.sel?.id === P.main[0].id }));
  check('pen: dragging a dot on the preview moves that point (one undo step)', after.p[0] > 0.85 + 0.2 && after.u === pt.u + 1 && after.sel, JSON.stringify(after));
  const rp = await shoot(page, 0.5);
  check('pen after the drag: preview == export', parityOk(rp), `mean ${rp.mean}, worst ${rp.worst}`);
  const add = await ev(page, () => { const n = P.main[0].mask.pts.length; document.querySelector('#inspector [data-act="penadd"]').click(); return [n, P.main[0].mask.pts.length]; });
  check('pen: Add a point adds one', add[1] === add[0] + 1, add.join(' -> '));
  check('no page errors (masks)', !page.errs.length, page.errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 5. AI subject mask (SAM 2 on real iPhone footage) ----------
if (on('ai') && ids.R) {
  const page = await openPage();
  pids.add(await ev(page, () => { const id = fresh('16:9'); const c = main(R); c.in = 1; c.out = 2.5; renderAll(); return id; }));
  const t0 = Date.now();
  const r = await ev(page, async () => { const c = P.main[0]; try { const o = await REMOTE.cut_out_object({ id: c.id, box: { x: 0.4, y: 0.27, w: 0.25, h: 0.43 }, t: 0.5, as_mask: true }); return { o, mask: P.main[0].mask, media: P.main[0].media === R }; } catch (e) { return { err: e.message }; } });
  const secs = (Date.now() - t0) / 1000;
  check('AI mask (cut_out_object as_mask): SAM 2 masks the clip, its own file stays', !r.err && r.mask?.type === 'ai' && r.mask.n >= 40 && r.media, r.err || `${r.mask?.n} frames at ${r.mask?.fps} fps in ${secs.toFixed(1)} s`);
  if (!r.err) {
    for (const T of [0.3, 1.2]) { // the camera moves: at 1.2 s the pipe is elsewhere, so the lit area is checked against that frame's own mask
      const p = await shoot(page, T);
      const cov = await ev(page, async T => {
        let i = 0, o = 0, ni = 0, no = 0, lit = 0;
        for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) { const v = lastShot.at(lastShot.ex, x / 160, y / 90) > 12, inb = x >= 0.4 * 160 && x < 0.65 * 160 && y >= 0.27 * 90 && y < 0.7 * 90; lit += v; if (inb) { ni++; i += v; } else { no++; o += v; } }
        const c = P.main[0], mk = maskAt(c, T), im = aiImg(mk, mk.fi); await im.decode();
        const cv = new OffscreenCanvas(im.naturalWidth, im.naturalHeight), g = cv.getContext('2d'); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data; let on = 0; for (let k = 3; k < d.length; k += 4) on += d[k] > 127;
        const g2 = geom(M.get(c.media), c, P.w, P.h), want = (on / (d.length / 4)) * (g2.w * g2.h) / (P.w * P.h); // the mask's share of the clip, as a share of the frame
        return { inside: +(i / ni).toFixed(2), outside: +(o / no).toFixed(3), lit: +(lit / 14400).toFixed(3), want: +want.toFixed(3), fi: mk.fi };
      }, T);
      const ok = T < 1 ? cov.inside > 0.4 && cov.outside < 0.1 : Math.abs(cov.lit - cov.want) < 0.3 * cov.want && cov.want > 0.01;
      check(`AI mask at ${T}s: preview == export, the subject kept, the rest black`, parityOk(p) && ok, `mean ${p.mean}, worst ${p.worst}, lit inside the box ${cov.inside}, outside ${cov.outside}; lit ${cov.lit} of the frame vs mask frame ${cov.fi} ${cov.want}`);
    }
    await ev(page, () => { const c = P.main[0]; c.mask.invert = true; c.mask.feather = 0.05; renderAll(); });
    const pi = await shoot(page, 0.8);
    check('AI mask feathered + inverted: preview == export', parityOk(pi), `mean ${pi.mean}, worst ${pi.worst}`);
  }
  check('no page errors (AI mask)', !page.errs.length, page.errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 6. preview quality ----------
if (on('quality') && ids.R) {
  const page = await openPage('no-preference', 2); // a Retina screen, like his
  pids.add(await ev(page, () => { const id = fresh('16:9'); [P.w, P.h] = [3840, 2160]; fitStage(); const c = main(R); c.in = 1; c.out = 4; renderAll(); return id; }));
  const bench = (mode, fx) => ev(page, async ([mode, fx]) => {
    const c = P.main[0];
    if (fx) Object.assign(c, { mask: { type: 'star', x: 0, y: 0, w: 0.8, h: 0.8, rot: 0, feather: 0.08, invert: false }, adj: { b: 1.1, c: 1.2, s: 0.8, vig: 0.5 } }); else { delete c.mask; c.adj = { b: 1, c: 1, s: 1 }; }
    setPQ(mode); seekTo(1); await waitFrame(); await sleep(300);
    const ts = [];
    for (let i = 0; i < 9; i++) { const a = performance.now(); for (let j = 0; j < 10; j++) { maskCache.clear(); paint(); } ts.push((performance.now() - a) / 10); } // maskCache cleared: every frame of a moving mask is new; 10 a batch (WebKit's clock is coarse)
    ts.sort((x, y) => x - y);
    return { ms: +ts[4].toFixed(2), w: $('#cv').width, h: $('#cv').height };
  }, [mode, fx]);
  for (const fx of [false, true]) {
    const runs = [];
    for (let rep = 0; rep < 2; rep++) runs.push([await bench('full', fx), await bench('quarter', fx)]); // the Mac is loaded: twice, the better ratio stands
    const [full, quarter] = runs.sort((x, y) => y[0].ms / y[1].ms - x[0].ms / x[1].ms)[0], k = full.ms / Math.max(0.01, quarter.ms);
    check(`quality Quarter vs Full on a 4K timeline${fx ? ' (mask + adjust + vignette)' : ' (plain clip)'}: paint ${k.toFixed(1)}x faster`, fx ? k > 2 : quarter.ms <= full.ms * 1.1,
      `full ${full.w}x${full.h} ${full.ms} ms, quarter ${quarter.w}x${quarter.h} ${quarter.ms} ms (median of 9 batches of 10, runs ${runs.map(([a, q]) => `${a.ms}/${q.ms}`).join(', ')})${fx ? '' : '; plain = one drawImage, little to save'}`);
  }
  const half = await ev(page, async () => { setPQ('half'); await sleep(100); return $('#cv').width / parseFloat($('#cv').style.width); });
  check('Half = half the canvas pixels per CSS pixel (2x screen -> 1)', Math.abs(half - 1) < 0.02, half.toFixed(3));
  const auto = await ev(page, async () => { const c = P.main[0]; c.media = A; c.in = 0; c.out = 6; delete c.mask; setPQ('auto'); seekTo(0); await waitFrame(); const w0 = $('#cv').width; play(); await sleep(700); const op = paint; paint = () => { const a = performance.now(); while (performance.now() - a < 120); op(); }; await sleep(1500); paint = op; const w1 = $('#cv').width, low = S.pqLow, t = S.t, miss = S.miss.length; pause(); await sleep(200); return { w0, w1, low, w2: $('#cv').width, after: S.pqLow, t: +t.toFixed(2), miss }; });
  check('Auto: missed frames while playing drop the canvas to half, pause restores full', auto.low && Math.abs(auto.w1 - auto.w0 / 2) <= 1 && auto.w2 === auto.w0 && !auto.after, JSON.stringify(auto));
  const sel = await ev(page, () => { setPQ('full'); const s = $('#pqSel'); s.value = 'quarter'; s.dispatchEvent(new Event('change')); return [store.get('cutroom.pq'), $('#cv').width]; });
  check('the Preview quality picker sets it (remembered per viewer)', sel[0] === 'quarter', JSON.stringify(sel));
  await ev(page, () => setPQ('auto'));
  check('no page errors (quality)', !page.errs.length, page.errs.slice(0, 2).join(' | '));
  await page.context().close();
}

await b.close();
for (const pid of pids) await post(`/api/projects/${pid}/trash`, {}).catch(() => {});
for (const id of Object.values(ids)) await post(`/api/media/${id}/trash`, {}).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
