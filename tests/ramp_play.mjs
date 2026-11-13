// Speed ramps = one clip with a curve, rendered into a library copy played at 1x (item 40). Checks, on a scratch server:
//  - playback of the 4K60 night-drive project with Bullet / Hero ramps on 4 shots: no backward clock snaps, no stalls
//  - preview == export on the ramped shots; the copy's frames == the source frames the curve says (60 fps test pattern)
//  - the curve saves and reloads, Remove ramp restores the range, undo restores the media
//  - the ramp editor (chips + curve drag) in both reduced-motion modes: the draft never touches the project or undo
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:4701 node tests/ramp_play.mjs   (needs project ab4bbf27d216 in that library)
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', RUNS = +(process.env.RUNS || 3), PROJ = process.env.PROJ || 'ab4bbf27d216';
if (/:4610\b/.test(B)) throw new Error('run this on a scratch server (B=...), never the real library on 4610');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-ramp-`), fx = `${tmp}/ramp-truth.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', fx]);
const FX = (await (await fetch(`${B}/api/import?name=ramp-truth.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(fx) })).json()).id;
fs.rmSync(tmp, { recursive: true });
const made = new Set([FX]), pids = [];

const b = await browser.launch();
const page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined' && M.size > 0, null, { timeout: 30000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => { window.PT = []; const op = paint; paint = () => { op(); PT.push([performance.now(), S.t, S.lead?.currentTime ?? -1]); }; });
// frame compare like video_parity: both images to 160x90, mean |a-b| and the worst 10x10 block, in 0-255 levels
await ev(() => {
  window.cmp = async (x, y) => {
    const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
    const [a, b] = [await px(x), await px(y)];
    let sum = 0, worst = 0;
    for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) { let s = 0; for (let yy = by; yy < by + 10; yy++) for (let xx = bx; xx < bx + 10; xx++) for (let k = 0; k < 3; k++) { const i = (yy * 160 + xx) * 4 + k; s += Math.abs(a[i] - b[i]); } sum += s; worst = Math.max(worst, s / 300); }
    return { mean: sum / (160 * 90 * 3), worst };
  };
});

// ---------- playback + parity on the real 4K60 project ----------
for (const rp of ['none', 'bullet', 'hero']) { // none = the same project unramped: the baseline the ramped runs are read against
  const t0 = Date.now();
  const setup = await ev(async ([rp, PROJ]) => {
    const p = await api(`/api/projects/${PROJ}`); p.id = hex12(); p.name = `ramp ${rp} (scratch)`; setProject(p); renderAll();
    const ids = [4, 3, 2, 1].map(i => P.main[i].id), n0 = P.main.length;
    if (rp !== 'none') for (const id of ids) await applyRamp(P.main.find(c => c.id === id), 'main', rampPts(rp));
    packMain(); S.t = 0; S.dirty = true; await saveNow();
    const r = P.main.filter(c => c.ramp);
    return { pid: P.id, n0, n: P.main.length, ramped: r.length, copies: r.map(c => c.media), lens: r.map(c => +len(c).toFixed(2)), starts: r.map(c => +c.start.toFixed(2)) };
  }, [rp, PROJ]);
  pids.push(setup.pid); setup.copies.forEach(m => made.add(m));
  if (rp !== 'none') check(`${rp}: 4 shots ramped, each still one clip`, setup.n === setup.n0 && setup.ramped === 4, `${setup.n0} -> ${setup.n} clips, lengths ${setup.lens.join(', ')} s, ${((Date.now() - t0) / 1000).toFixed(0)} s to render`);
  for (let run = 0; run < RUNS; run++) {
    await ev(() => { S.t = 0; S.dirty = true; }); await page.waitForTimeout(1500);
    await ev(() => { PT.length = 0; window.SNAP = []; let pt = null, pw = null; const poll = n => { if (!S.playing) return; if (pt !== null) { const d = (S.t - pt) - (n - pw) / 1000; if (Math.abs(d) > 0.008 && S.t < S.end) SNAP.push([+pt.toFixed(3), +(d * 1000).toFixed(0)]); } pt = S.t; pw = n; requestAnimationFrame(poll); }; play(); requestAnimationFrame(poll); });
    await page.waitForTimeout(9000);
    const r = await ev(() => {
      const T = S.t; pause();
      // the first 0.1 s is AVPlayer's start latency (the unramped baseline has the same 35-60 ms there): reported, not judged
      let prev = -9, lastT = null, worst = 0, at = 0, start = 0;
      for (const p of PT) if (Math.abs(p[2] - prev) > 1e-4) { if (lastT !== null) { const g = p[0] - lastT; if (p[1] < 0.1) start = Math.max(start, g); else if (g > worst) { worst = g; at = p[1]; } } lastT = p[0]; prev = p[2]; }
      const back = SNAP.filter(s => s[1] < -50 && s[0] >= 0.1);
      return { reached: +T.toFixed(2), snaps: back.length, first: back.slice(0, 4), worst: Math.round(worst), at: +at.toFixed(2), start: Math.round(start), startSnap: Math.min(0, ...SNAP.filter(s => s[0] < 0.1).map(s => s[1])) };
    });
    if (rp === 'none') console.log(`     baseline run ${run + 1}: ${JSON.stringify(r)}`);
    else check(`${rp} run ${run + 1}: plays 9 s smoothly`, r.reached >= 8.9 && r.snaps === 0 && r.worst < 40, JSON.stringify(r));
  }
  if (rp === 'none') continue;
  const par = await ev(async () => {
    const out = [], r = P.main.filter(c => c.ramp);
    for (const c of r) for (const f of [0.3, 0.7]) out.push(+(c.start + f * len(c)).toFixed(3));
    const pick = [out[0], out[2], out[3], out[5], out[7]], got = [];
    for (const t of pick) { const ex = await REMOTE.snapshot({ t, max: 640 }), pv = await REMOTE.snapshot({ t, max: 640, preview: true }); got.push({ t, ...(await cmp(ex.image, pv.image)) }); }
    return got;
  });
  for (const p of par) check(`${rp}: preview == export at ${p.t} s`, p.mean <= 10 && p.worst <= 70, `mean ${p.mean.toFixed(2)}, block ${p.worst.toFixed(1)}`);
}

// ---------- curve truth: the copy's frame at t == the source frame the curve maps t to ----------
const CUSTOM = [[0, 1], [0.35, 0.3], [0.65, 3], [1, 1]];
const truth = await ev(async ([FX, CUSTOM]) => {
  setProject(newProject('16:9')); P.name = 'ramp truth (scratch)'; P.fps = 60; addMedia(FX, 'main'); const c = P.main[0]; c.in = 1; c.out = 4; renderAll();
  const tbl = rampMap(CUSTOM, 3);
  await applyRamp(c, 'main', CUSTOM); packMain(); await saveNow();
  const pid = P.id, ts = [0.2, 1.1, 2.6, 3.9, len(c) - 0.3].map(t => +(Math.round(t * 60) / 60).toFixed(4)), out = [], copy = c.media;
  for (const t of ts) {
    const ex = await REMOTE.snapshot({ t, max: 640 }), s = 1 + mapAt(tbl, t, 1, 0), was = JSON.stringify(P);
    setProject(newProject('16:9')); P.fps = 60; addMedia(FX, 'main'); Object.assign(P.main[0], { in: s, out: s + 0.5 }); packMain();
    const pl = await REMOTE.snapshot({ t: 0, max: 640 });
    setProject(JSON.parse(was));
    out.push({ t, s: +s.toFixed(3), ...(await cmp(ex.image, pl.image)) });
  }
  return { pid, copy, out, d: +len(P.main[0]).toFixed(3), want: +tbl.at(-1)[1].toFixed(3) };
}, [FX, CUSTOM]);
pids.push(truth.pid); made.add(truth.copy);
check('custom curve: the clip is as long as the curve says', Math.abs(truth.d - truth.want) <= 1 / 60 + 1e-3, `${truth.d} s vs ${truth.want} s`);
for (const o of truth.out) check(`custom curve: copy at ${o.t} s == source at ${o.s} s`, o.mean <= 4, `mean ${o.mean.toFixed(2)}, block ${o.worst.toFixed(1)}`);

// ---------- round trip: save + reload, Remove ramp, undo ----------
const rt = await ev(async ([pid, CUSTOM, FX]) => {
  const p = await api(`/api/projects/${pid}`), c0 = p.main[0];
  setProject(p); renderAll();
  const c = P.main[0], m = M.get(c.media), want = rampMap(c.ramp.pts, c.ramp.out - c.ramp.in).at(-1)[1];
  const r = { saved: JSON.stringify(c0.ramp?.pts) === JSON.stringify(CUSTOM), dur: +(m.duration - want).toFixed(4), media: c.media };
  removeRamp(c);
  Object.assign(r, { off: c.media === FX && !c.ramp && Math.abs(c.in - 1) <= 1 / 60 && Math.abs(c.out - 4) <= 1 / 60, inOut: [+c.in.toFixed(4), +c.out.toFixed(4)] });
  REMOTE.history({ action: 'undo' });
  const u = P.main[0]; r.undo = u.media === r.media && JSON.stringify(u.ramp?.pts) === JSON.stringify(CUSTOM);
  return r;
}, [truth.pid, CUSTOM, FX]);
check('round trip: the curve is saved verbatim', rt.saved);
check('round trip: the copy is as long as rampMap says (1 frame)', Math.abs(rt.dur) <= 1 / 60 + 1e-3, `${rt.dur} s off`);
check('round trip: Remove ramp restores the source range (1 frame)', rt.off, `in/out ${rt.inOut.join('..')}`);
check('round trip: undo brings the ramp back', rt.undo);
const again = await ev(async ([CUSTOM]) => { const c = P.main[0], m0 = c.media, t0 = performance.now(); removeRamp(c); await applyRamp(c, 'main', CUSTOM); return { same: c.media === m0, ms: Math.round(performance.now() - t0) }; }, [CUSTOM]);
check('the same curve again reuses the rendered copy', again.same, `${again.ms} ms`);
await ev(() => saveNow());

// ---------- the speed slider keeps every kind of keyframe on its frame (it used to skip strength and mask points) ----------
const sib = await ev(([FX]) => {
  setProject(newProject('16:9')); addMedia(FX, 'main'); const c = P.main[0]; S.sel = { lane: 'main', id: c.id }; c.out = c.in + 4;
  c.kf = [{ t: 0, x: 0, y: 0, scale: 1, opacity: 1, rot: 0 }, { t: 2, x: 0.1, y: 0, scale: 1, opacity: 1, rot: 0 }]; c.vkf = [{ t: 2, v: 0.5 }]; c.lkf = [{ t: 2, v: 0.5 }];
  c.mask = { type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0 }; c.mkf = [{ t: 2, x: 0, y: 0, w: 0.5, h: 0.5 }];
  const el = Object.assign(document.createElement('input'), { type: 'range', min: '-1', max: '2', step: 'any' }); el.dataset.k = 'c.speed'; el.dataset.log = ''; el.value = String(Math.log10(2)); apply(el);
  return { speed: c.speed, t: ['kf', 'vkf', 'lkf', 'mkf'].map(k => c[k].at(-1).t) };
}, [FX]);
check('speed 1x -> 2x moves keyframe, volume, strength and mask points at 2 s to 1 s', sib.speed === 2 && sib.t.every(t => t === 1), JSON.stringify(sib));

// ---------- the editor: chips + drag, both motion modes ----------
for (const rm of ['no-preference', 'reduce']) {
  await page.emulateMedia({ reducedMotion: rm });
  pids.push(await ev(([FX]) => { setProject(newProject('16:9')); P.name = 'ramp ui (scratch)'; addMedia(FX, 'main'); S.sel = { lane: 'main', id: P.main[0].id }; renderAll(); return P.id; }, [FX]));
  await page.waitForTimeout(400);
  await page.locator('#inspector .itabs button', { hasText: 'Tools' }).click();
  const svg = page.locator('#rampSvg');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox(), at = ([u, y], dy = 0) => [box.x + (16 + u * 200) / 222 * box.width, box.y + (6 + (1 - y) * 100) / 112 * box.height - dy]; // #rampSvg viewBox -16 -6 222 112
  const before = await ev(() => ({ P: JSON.stringify(P), undo: undo.length, len: $('#rampLen').textContent }));
  await page.locator('[data-rampp="hero"]').click();
  const hero = await ev(() => ({ on: $('[data-rampp="hero"]').classList.contains('on'), len: $('#rampLen').textContent, n: S.rampDraft.pts.length }));
  check(`${rm}: a preset chip loads its curve`, hero.on && hero.n === 10 && hero.len !== before.len, `${hero.len}`);
  // drag the middle point (u 0.5) of Hero (0.25x there) up to about 2x
  const p5 = await ev(() => { const q = S.rampDraft.pts[5]; return [q[0], rampY(q[1])]; });
  await page.mouse.move(...at(p5));
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(...at(p5, k * box.height * 0.08));
  const mid = await ev(() => ({ len: $('#rampLen').textContent, hot: !!$('#rampSvg circle.hot') }));
  await page.mouse.up();
  const after = await ev(() => ({ P: JSON.stringify(P), undo: undo.length, s: S.rampDraft.pts[5][1], chip: $$('#inspector [data-rampp].on').length }));
  check(`${rm}: dragging a point raises its speed live`, after.s > 1 && mid.hot && /×/.test(mid.len), `${mid.len}, speed now ${after.s}`);
  check(`${rm}: the draft stays out of the project and undo`, after.P === before.P && after.undo === before.undo && after.chip === 0);
  // a double-click removes an inner point, a click on the line adds one
  const n0 = await ev(() => S.rampDraft.pts.length), p3 = await ev(() => { const q = S.rampDraft.pts[3]; return [q[0], rampY(q[1])]; });
  await page.mouse.dblclick(...at(p3));
  const n1 = await ev(() => S.rampDraft.pts.length);
  check(`${rm}: double-click removes a point`, n1 === n0 - 1, `${n0} -> ${n1}`);
  const fits = await ev(() => { const r = $('#rampSvg').getBoundingClientRect(), i = $('#inspector').getBoundingClientRect(); return r.left >= i.left - 1 && r.right <= i.right + 1 && r.width > 150; });
  check(`${rm}: the curve box fits the inspector`, fits);
  await page.screenshot({ path: new URL(`./out/ramp_editor_${rm}.png`, import.meta.url).pathname, clip: { x: box.x - 20, y: box.y - 140, width: box.width + 40, height: box.height + 240 } }).catch(() => {});
}
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

// tidy by id lists (close the browser first: its pagehide save would bring a trashed project back)
await b.close();
for (const id of pids) await fetch(`${B}/api/projects/${id}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1' } });
for (const id of made) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1' } });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
