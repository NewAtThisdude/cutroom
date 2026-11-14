// Masked grades (2026-11-14): a clip's mask can limit its colour (Colour only, Invert = everything but it), and an adjustment
// layer carries a mask of its own: a shape, a pen outline, the AI subject of the video under it (its outline frames, timed
// like that clip), or a shape that follows something (tracking). Several stack. Checked: the graded and ungraded areas on
// the preview and in the export renderer (REMOTE.snapshot, /api/still_frame) agree within 3 levels; keyframed and AI masks
// move frame by frame both sides; the Mask tab and the Colour only tick (one undo step each); pen points drag on the canvas;
// grade_mask (the MCP command); save + reload keeps it; old adjustment layers plan as before. Both motion modes, no page errors.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node tests/mask_grade.mjs   (never 4610)
import { browser } from './browser.mjs';
import { requireHome } from './runtime.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const HOME = requireHome(), B = process.env.B;
if (!B || /:4610\b/.test(B)) throw new Error('B must be a scratch server (never 4610)');
const OUT = fileURLToPath(new URL('./out/mask_grade/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 600)}]` : ''}`); };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ff = (args, out) => { if (!fs.existsSync(OUT + out)) execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, OUT + out]); return OUT + out; };

// ---- media: a flat-coloured video (the colour changes are easy to measure) and a textured patch moving right (to track) ----
ff(['-f', 'lavfi', '-i', 'color=c=0x9090b0:s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-qp', '0'], 'mg-flat.mp4'); // (4:2:0: a 4:4:4 file makes the server build a proxy mid-test)
ff(['-f', 'lavfi', '-i', 'color=c=0x606060:s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=96x96:r=30:d=2', '-filter_complex', "[0][1]overlay=x='80+200*t':y=132", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12'], 'mg-move.mp4');
for (const f of ['mg-flat.mp4', 'mg-move.mp4']) if (!(await api('/api/media')).some(m => m.name === f)) await api('/api/import_path', { path: OUT + f });
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const lib = await api('/api/media'), FLAT = lib.find(m => m.name === 'mg-flat.mp4').id, MOVE = lib.find(m => m.name === 'mg-move.mp4').id;
// an AI subject mask as SAM 2 leaves it (cache/<key>.aimask/NNNNN.png: white, alpha = the outline), 4 frames at 2 fps: the left half, then the right
const AI = 'a1a1a1a1a1a1', aid = `${HOME}/cache/${AI}.aimask`;
fs.mkdirSync(aid, { recursive: true });
for (let i = 0; i < 4; i++) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=640x360', '-vf', `format=rgba,geq=r=255:g=255:b=255:a='if(${i < 2 ? 'lt' : 'gte'}(X,W/2),255,0)'`, '-frames:v', '1', `${aid}/${String(i).padStart(5, '0')}.png`]);

// in the page: the mean colour of a box (fractions of the frame) in a PNG (base64)
const MEAN = `window.__mean = async (b64, [x, y, w, h]) => {
  const im = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()), c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const d = g.getImageData(Math.round(x * im.width), Math.round(y * im.height), Math.max(1, Math.round(w * im.width)), Math.max(1, Math.round(h * im.height))).data, s = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k];
  return s.map(v => v / (d.length / 4));
};`;
const BOX = { L: [0.08, 0.3, 0.2, 0.4], R: [0.72, 0.3, 0.2, 0.4], C: [0.42, 0.4, 0.16, 0.2], K: [0.02, 0.04, 0.08, 0.1] }; // left, right, centre, corner
const ORIG = [0x90, 0x90, 0xb0];

const b = await browser.launch();
const errs = [];
for (const [rm, dpr] of [['no-preference', 1], ['reduce', 2]]) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm, deviceScaleFactor: dpr })).newPage();
  page.on('pageerror', e => errs.push(`${rm}: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.addInitScript({ content: MEAN });
  await page.route(u => u.pathname === '/api/remote/next', async r => { await sleep(15000); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  const ev = (f, a) => page.evaluate(f, a);
  const boot = async () => {
    await page.goto(`${B}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
    await ev(() => loadMedia());
  };
  await boot();
  // both sides at T: { pv: {L, R, C, K}, ex: {...} } mean colours
  const both = T => ev(async ([T, boxes]) => {
    const out = {}, ex = await REMOTE.snapshot({ t: T, max: 640 });
    const pv = await REMOTE.snapshot({ t: T, max: 640, preview: true });
    for (const [side, im] of [['ex', ex.image], ['pv', pv.image]]) { out[side] = {}; for (const [k, bx] of Object.entries(boxes)) out[side][k] = (await window.__mean(im, bx)).map(v => Math.round(v * 10) / 10); }
    return out;
  }, [T, BOX]);
  const dmax = (a, c) => Math.max(...a.map((v, i) => Math.abs(v - c[i])));
  const agree = s => Math.max(...Object.keys(s.pv).map(k => dmax(s.pv[k], s.ex[k]))); // preview vs export, worst box
  const dark = (v, ref = ORIG) => ref.every((x, i) => v[i] < x - 25), same = (v, ref = ORIG) => dmax(v, ref) <= 4, bright = (v, ref = ORIG) => ref.every((x, i) => v[i] > x + 20);
  const show = s => JSON.stringify({ pv: s.pv, ex: s.ex });

  const clip = await ev(async FLAT => {
    await REMOTE.new_project({ ratio: '16:9', name: 'Masked grade (scratch)' });
    const r = await REMOTE.add_clip({ media: FLAT });
    const c = P.main[0]; c.adj = { b: 0.5, c: 1, s: 1 }; c.mask = { type: 'circle', x: 0, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0, invert: false, grade: true };
    undo.length = 0; redo.length = 0; renderAll(); return r.id;
  }, FLAT);

  // ---- A: a clip's mask limits its colour (the picture stays whole), Invert keeps it out ----
  let s = await both(0.5);
  check(`${rm}: Colour only: darker inside the circle, the clip untouched (and not cut out) outside, preview = export`, dark(s.pv.C) && same(s.pv.K) && dark(s.ex.C) && same(s.ex.K) && agree(s) <= 3, show(s));
  await ev(() => { P.main[0].mask.invert = true; S.dirty = true; });
  s = await both(0.5);
  check(`${rm}: Invert: the colour changes everywhere but the circle, preview = export`, same(s.pv.C) && dark(s.pv.K) && agree(s) <= 3, show(s));
  await ev(() => { P.main[0].mask.invert = false; P.main[0].grade = { lift: { x: 0.4, y: 0, l: 0 } }; P.main[0].lkf = [{ t: 0, v: 0 }, { t: 2, v: 1 }]; S.dirty = true; });
  s = await both(1.5);
  check(`${rm}: with colour wheels and filter-strength keyframes too, still only inside, preview = export`, !same(s.pv.C) && same(s.pv.K) && agree(s) <= 3, show(s));

  // the Colour only tick in the inspector: one undo step
  await ev(id => { const c = P.main[0]; delete c.grade; delete c.lkf; S.sel = { lane: 'main', id }; S.itab = 'Adjust'; seekTo(0.5); renderAll(); }, clip);
  const tickSel = '#inspector input[data-k="c.mask.grade"]';
  await page.waitForSelector(tickSel, { state: 'attached' });
  const sec = await ev(sel => document.querySelector(sel).closest('.isec')?.dataset.sec, tickSel);
  if (sec) await page.click(`#inspector [data-itab="${sec}"]`);
  const u0 = await ev(() => undo.length);
  await page.locator(tickSel).scrollIntoViewIfNeeded();
  await page.click(tickSel);
  const t1 = await ev(() => ({ grade: !!P.main[0].mask.grade, n: undo.length }));
  await ev(() => REMOTE.history({ action: 'undo' }));
  const t2 = await ev(() => !!P.main[0].mask.grade);
  check(`${rm}: the Colour only tick (${sec} tab) turns it off in one undo step; undo brings it back`, !t1.grade && t1.n === u0 + 1 && t2, JSON.stringify({ t1, t2, u0 }));

  // ---- B, C: adjustment layers with masks, two stacked ----
  const [fa, fb] = await ev(() => {
    const c = P.main[0]; c.adj = { b: 1, c: 1, s: 1 }; delete c.mask;
    const a = addEffect('adjust', 0, 2), b2 = addEffect('adjust', 0, 2);
    a.adj = { b: 0.5, c: 1, s: 1 }; a.mask = { type: 'rect', x: -0.25, y: 0, w: 0.5, h: 1, rot: 0, feather: 0, invert: false };
    b2.adj = { b: 1.5, c: 1, s: 1 }; b2.mask = { type: 'rect', x: 0.25, y: 0, w: 0.5, h: 1, rot: 0, feather: 0, invert: false };
    S.dirty = true; return [a.id, b2.id];
  });
  s = await both(0.5);
  check(`${rm}: two masked adjustment layers stacked: left darker, right brighter, preview = export`, dark(s.pv.L) && bright(s.pv.R) && dark(s.ex.L) && bright(s.ex.R) && agree(s) <= 3, show(s));
  const plain = await ev(async id => { const f = P.fx.find(x => x.id === id), m = f.mask; delete f.mask; const p = await fxPlan(640, 360); f.mask = m; return p.map(o => Object.keys(o).sort().join()); }, fb);
  check(`${rm}: an adjustment layer without a mask plans as before (no mask fields)`, plain.some(k => k === 'a,b,lut,op'), JSON.stringify(plain));

  // ---- D: a keyframed mask on a layer that starts late (the export's mask frames line up with it) ----
  await ev(([a, b2]) => { P.fx = P.fx.filter(x => x.id !== b2); const f = P.fx.find(x => x.id === a); f.start = 0.5; f.dur = 1.5; f.mkf = [{ t: 0, x: -0.25, y: 0, w: 0.5, h: 1, rot: 0, feather: 0 }, { t: 1, x: 0.25, y: 0, w: 0.5, h: 1, rot: 0, feather: 0 }]; S.dirty = true; }, [fa, fb]);
  const s1 = await both(0.6), s2 = await both(1.5), s0 = await both(0.2);
  check(`${rm}: keyframed layer mask: left at its start, right a second later, nothing before the layer; preview = export`,
    dark(s1.pv.L) && same(s1.pv.R) && same(s2.pv.L) && dark(s2.pv.R) && dark(s2.ex.R) && same(s0.ex.L) && same(s0.pv.L) && Math.max(agree(s1), agree(s2), agree(s0)) <= 3, `${show(s1)} ${show(s2)}`);

  // ---- E: the AI subject of the video under the layer (its outline frames, timed like the clip) via grade_mask ----
  await ev(([a, AI]) => { const c = P.main[0]; c.mask = { type: 'ai', src: AI, n: 4, fps: 2, t0: 0, x: 0, y: 0, w: 1, h: 1, rot: 0, feather: 0, invert: false, grade: true }; const f = P.fx.find(x => x.id === a); f.start = 0.5; f.dur = 1.5; delete f.mask; delete f.mkf; }, [fa, AI]);
  const gm = await ev(a => REMOTE.grade_mask({ id: a, t: 0.6 }), fa);
  const sa = await both(0.75), sb = await both(1.25);
  check(`${rm}: grade_mask on a layer copies the subject mask of the clip under it; it changes with the clip's outline frames, preview = export`,
    gm.mask === 'ai' && dark(sa.pv.L) && same(sa.pv.R) && same(sb.pv.L) && dark(sb.pv.R) && dark(sb.ex.R) && same(sb.ex.L) && Math.max(agree(sa), agree(sb)) <= 3, `${JSON.stringify(gm).slice(0, 120)} ${show(sa)} ${show(sb)}`);
  const e29 = await both(29 / 30), e30 = await both(30 / 30); // the outline switches between these two frames: the export switches on the same one
  check(`${rm}: the subject mask switches on the same frame in the preview and the export`, dark(e29.ex.L) && same(e29.ex.R) && dark(e30.ex.R) && same(e30.ex.L) && Math.max(agree(e29), agree(e30)) <= 3, `${show(e29)} ${show(e30)}`);
  const inv = await ev(a => REMOTE.grade_mask({ id: a, invert: true }), fa), si = await both(0.75);
  check(`${rm}: grade_mask invert: the layer grades everything but the subject`, inv.grades === 'outside the mask' && same(si.pv.L) && dark(si.pv.R) && agree(si) <= 3, show(si));

  // ---- grade_mask on a clip: a shape over a box, then off ----
  const gc = await ev(id => { const c = P.main[0]; delete c.mask; c.adj = { b: 0.5, c: 1, s: 1 }; P.fx = []; return REMOTE.grade_mask({ id, shape: 'rect', box: { x: 0.5, y: 0, w: 0.5, h: 1 }, t: 0.5 }); }, clip);
  const sc = await both(0.5);
  check(`${rm}: grade_mask on a clip with a shape over a box: only there, preview = export`, gc.mask === 'rect' && same(sc.pv.L) && dark(sc.pv.R) && agree(sc) <= 3, `${JSON.stringify(gc).slice(0, 160)} ${show(sc)}`);
  const off = await ev(id => REMOTE.grade_mask({ id, off: true }).then(() => P.main[0].mask), clip);
  check(`${rm}: grade_mask off removes the colour-only mask`, off === undefined);
  const bad = await ev(id => REMOTE.grade_mask({ id, follow: true, box: { x: 0, y: 0, w: 0.2, h: 0.2 } }).then(() => 'ok', e => e.message), clip);
  check(`${rm}: follow on a clip is refused with the reason`, /adjustment layer/.test(bad), bad);

  // ---- the Mask tab of an adjustment layer: a shape in one undo step; pen points drag on the canvas ----
  const f2 = await ev(() => { P.main[0].adj = { b: 1, c: 1, s: 1 }; const f = addEffect('adjust', 0, 2); f.adj = { b: 0.5, c: 1, s: 1 }; S.sel = { lane: 'fx', id: f.id }; S.itab = 'Mask'; seekTo(0.5); renderAll(); undo.length = 0; return f.id; });
  await page.waitForSelector('#inspector [data-sec="Mask"] [data-mask="circle"]', { state: 'visible' });
  const tabs = await ev(() => ({ ai: !!$('#inspector [data-act="adjaimask"]'), hint: $('#inspector [data-sec="Mask"]').textContent.includes('Pick a mask') }));
  await page.click('#inspector [data-sec="Mask"] [data-mask="pen"]');
  const pen = await ev(id => ({ type: P.fx.find(x => x.id === id).mask?.type, n: undo.length, follow: !!$('#inspector [data-act="adjfollow"]') }), f2);
  check(`${rm}: the layer's Mask tab: AI subject and shapes; Pen sets a pen mask in one undo step, Follow something offered`, tabs.ai && tabs.hint && pen.type === 'pen' && pen.n === 1 && pen.follow, JSON.stringify({ tabs, pen }));
  await ev(() => { S.dirty = true; });
  await page.waitForFunction(() => !!S.penHit, null, { timeout: 5000 });
  const pt = await ev(id => { const f = P.fx.find(x => x.id === id), cv = $('#cv'), r = cv.getBoundingClientRect(), k = cv.width / r.width, [x, y] = penMap(f, S.penHit).to(f.mask.pts[0]); return { x: r.left + x / k, y: r.top + y / k, p0: [...f.mask.pts[0]] }; }, f2);
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.move(pt.x + 20, pt.y + 30, { steps: 5 }); await page.mouse.up();
  const moved = await ev(id => ({ p: P.fx.find(x => x.id === id).mask.pts[0], n: undo.length }), f2);
  check(`${rm}: a pen point of the layer's mask drags on the canvas (one more undo step)`, moved.p[1] > pt.p0[1] + 0.05 && moved.n === 2, JSON.stringify({ was: pt.p0, now: moved.p }));
  const sp = await both(0.5);
  check(`${rm}: the pen-masked layer: preview = export`, agree(sp) <= 3 && dark(sp.pv.C), show(sp));

  // ---- save + reload ----
  const keep = await ev(async () => { await flushSave(); return { id: P.id, fx: JSON.stringify(P.fx.map(f => f.mask)) }; });
  await boot();
  await ev(id => openProject(id), keep.id);
  const back = await ev(() => JSON.stringify(P.fx.map(f => f.mask)));
  const sr = await both(0.5);
  check(`${rm}: save + reload keeps the layer's mask and its look`, back === keep.fx && dark(sr.pv.C) && agree(sr) <= 3, `${back.slice(0, 160)} ${show(sr)}`);

  // ---- F: a mask that follows something (tracking, Apple Vision; Mac only) ----
  if (rm === 'no-preference' && process.platform === 'darwin') {
    const tr = await ev(async MOVE => {
      await REMOTE.new_project({ ratio: '16:9', name: 'Masked grade follow (scratch)' });
      await REMOTE.add_clip({ media: MOVE });
      const f = addEffect('adjust', 0, 2); f.adj = { b: 1.6, c: 1, s: 1 };
      const r = await REMOTE.grade_mask({ id: f.id, follow: true, shape: 'circle', t: 0.2, box: { x: (80 + 40) / 640, y: 132 / 360, w: 96 / 640, h: 96 / 360 } });
      const g = P.fx.find(x => x.id === f.id), at = lt => maskAt(g, lt);
      return { r, a: at(0.2), b: at(1.8), n: g.mkf?.length };
    }, MOVE);
    const want = t => (80 + 200 * t + 48) / 640 - 0.5;
    check('follow: the layer mask tracks the moving patch (centre within 3 % of the canvas at 0.2 s and 1.8 s)', tr.n > 10 && Math.abs(tr.a.x - want(0.2)) < 0.03 && Math.abs(tr.b.x - want(1.8)) < 0.03 && Math.abs(tr.b.y - (180 / 360 - 0.5)) < 0.03,
      JSON.stringify({ n: tr.n, x0: tr.a.x, want0: want(0.2), x1: tr.b.x, want1: want(1.8), y1: tr.b.y }));
  }
  await ev(async () => { await flushSave(); });
  await page.context().close();
}
await b.close();
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
const failed = res.filter(x => !x).length;
console.log(`${res.length - failed}/${res.length} passed`);
process.exit(failed ? 1 : 0);
