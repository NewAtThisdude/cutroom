// Item 43b: the adjustment layer, animation tiles that play their span once, resizable panes. Headless WebKit, both motion modes.
//   B=http://127.0.0.1:<scratch port> node adjust_panes.mjs     (never 4610)
// 1. one 'adjust' clip over 16 main shots grades every one of them (preview AND export), one change re-grades all 16, and
//    the export frame matches the preview (mean / worst 10x10 block in 0-255 levels, like video_parity).
// 2. picking an animation tile (Pop on a text clip, Zoom in on a video clip) plays its span once and stops where it ends (fully in);
//    under reduced motion the playhead jumps to the end and nothing plays.
// 3. dragged pane sizes persist across a reload; double-click resets; the preview keeps room at 1440x800.
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-adj-`), f = `${tmp}/adjust-shots.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', f]);
const mid = (await (await fetch(`${B}/api/import?name=adjust-shots.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id;
fs.rmSync(tmp, { recursive: true });
const b = await browser.launch(), pids = new Set();
const open = async (rm, vp = { width: 1517, height: 904 }, ctx) => {
  ctx ??= await b.newContext({ viewport: vp, reducedMotion: rm });
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  return { page, errs, ev: (fn, a) => page.evaluate(fn, a) };
};

// ---------- 1. adjustment layer ----------
{
  const { page, errs, ev } = await open('no-preference');
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, mid, { timeout: 60000 });
  const r = await ev(async id => {
    setProject(newProject('16:9')); P.name = 'Adjust (scratch)';
    for (let i = 0; i < 16; i++) { addMedia(id, 'main'); Object.assign(P.main.at(-1), { in: i * 0.5, out: i * 0.5 + 0.5 }); }
    packMain(); S.t = 0;
    const f = addEffect('adjust', 0, total());
    renderAll();
    const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
    const diff = (a, b) => { let sum = 0, worst = 0; for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) { let s = 0; for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 160 + x) * 4 + k; s += Math.abs(a[i] - b[i]); } sum += s; worst = Math.max(worst, s / 300); } return [sum / (160 * 90 * 3), worst]; };
    const shots = async () => Promise.all(P.main.map(async c => { const t = c.start + 0.25; return [await px((await REMOTE.snapshot({ t, max: 640, preview: true })).image), await px((await REMOTE.snapshot({ t, max: 640 })).image)]; }));
    const plain = []; for (const c of P.main) plain.push(await px((await REMOTE.snapshot({ t: c.start + 0.25, max: 640, preview: true })).image)); // nothing set yet: no change
    change(() => { f.adj = { b: 1, c: 1.25, s: 0.4, temp: 0.5 }; f.look = { name: Object.keys(LOOKS)[0], amount: 0.6 }; f.grade = { gain: { x: 0.3, y: 0, l: 0.1 }, curves: { m: [[0, 0], [0.5, 0.6], [1, 1]] } }; });
    const g1 = []; for (const c of P.main) { const t = c.start + 0.25; g1.push([await px((await REMOTE.snapshot({ t, max: 640, preview: true })).image), await px((await REMOTE.snapshot({ t, max: 640 })).image)]); }
    change(() => { f.adj.b = 0.6; }); // ONE change on the one clip
    const g2 = []; for (const c of P.main) { const t = c.start + 0.25; g2.push([await px((await REMOTE.snapshot({ t, max: 640, preview: true })).image), await px((await REMOTE.snapshot({ t, max: 640 })).image)]); }
    const keep = FXG.gl; FXG.gl = null; FXG.failed = true; // no WebGL2: the CPU lookup (lutPass)
    const cpu = await px((await REMOTE.snapshot({ t: P.main[3].start + 0.25, max: 640, preview: true })).image);
    FXG.gl = keep; FXG.failed = false;
    const plan = await buildPlan(P.w, P.h, 'draft', 'x');
    return { n: P.main.length, pid: P.id, steps: plan.fx.map(s => [s.op, s.a, s.b, s.lut?.length]),
      graded: g1.map(([p], i) => diff(p, plain[i])[0]), regraded: g2.map(([p], i) => diff(p, g1[i][0])[0]),
      cpu: diff(cpu, g2[3][1]), parity1: g1.map(([p, e]) => diff(p, e)), parity2: g2.map(([p, e]) => diff(p, e)), sel: (S.sel = { lane: 'fx', id: f.id }, renderAll(), $('#inspector h3').textContent), tabs: [...$$('#inspector .itabs button')].map(x => x.textContent) };
  }, mid);
  pids.add(r.pid);
  const mn = a => Math.min(...a).toFixed(1), mx = a => Math.max(...a).toFixed(2);
  check('adjust: 16 shots, one adjust clip, one LUT step over all their frames', r.n === 16 && r.steps.length === 1 && r.steps[0][0] === 'lut' && r.steps[0][1] === 0 && r.steps[0][2] === 240, JSON.stringify(r.steps));
  check('adjust: every shot is graded in the preview', r.graded.every(d => d > 8), `mean change ${mn(r.graded)}..${mx(r.graded)} levels`);
  check('adjust: one change re-grades all 16', r.regraded.every(d => d > 8), `mean change ${mn(r.regraded)}..${mx(r.regraded)} levels`);
  const pm = [...r.parity1, ...r.parity2];
  check('adjust: export = preview on all 32 frames (mean <= 4, worst block <= 28)', pm.every(([m, w]) => m <= 4 && w <= 28), `mean <= ${mx(pm.map(x => x[0]))}, worst block <= ${mx(pm.map(x => x[1]))}`);
  check('adjust: without WebGL2 (CPU lookup) export = preview too', r.cpu[0] <= 4 && r.cpu[1] <= 28, `mean ${r.cpu[0].toFixed(2)}, worst block ${r.cpu[1].toFixed(1)}`);
  check('adjust: inspector shows the layer with Adjust / Color / Mask tabs', r.sel === 'Adjustment layer' && r.tabs.join() === 'Adjust,Color,Mask', `${r.sel} · ${r.tabs}`);
  // the UI path: the Effects tab button adds one
  await page.click('.rail button[data-tab="effects"]');
  const before = await ev(() => P.fx.length);
  await page.click('#btnAdjust');
  check('adjust: "Add adjustment layer" puts one on the Effects track', await ev(n => P.fx.length === n + 1 && P.fx.at(-1).fx === 'adjust' && S.sel.lane === 'fx', before));
  check('adjust: no page errors', !errs.length, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 2. animation tiles ----------
for (const rm of ['no-preference', 'reduce']) {
  const { page, errs, ev } = await open(rm);
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, mid, { timeout: 60000 });
  const pid = await ev(id => { setProject(newProject('16:9')); P.name = 'Anim tiles (scratch)'; addMedia(id, 'main'); S.t = 1; addText('Title', { text: 'Pop me' }); const t = P.text.at(-1); t.start = 1; t.dur = 3; S.sel = { lane: 'text', id: t.id }; S.itab = 'Animate'; renderAll(); return P.id; }, mid);
  pids.add(pid);
  const watch = () => ev(() => { window.PL = []; const id = window.PLid = (window.PLid || 0) + 1, t0 = performance.now(); const tick = () => { if (window.PLid !== id) return; PL.push([performance.now() - t0, S.playing, S.t]); if (PL.length < 400) requestAnimationFrame(tick); }; tick(); });
  const playOnce = async (sel, a0, want) => {
    await watch();
    await page.click(sel);
    await page.waitForTimeout(Math.max(1500, want * 1000 + 1200));
    return ev(([a0]) => { const on = PL.filter(x => x[1]); const starts = PL.filter((x, i) => x[1] && !(PL[i - 1]?.[1])).length; return { playedFor: on.length ? on.at(-1)[0] - on[0][0] : 0, starts, minT: Math.min(...on.map(x => x[2])), t: S.t, playing: S.playing, end: S.end, a0 }; }, [a0]);
  };
  const tx = await ev(() => { const t = P.text.at(-1); return { start: t.start, n: animLen({ anim: 'pop' }, false) }; });
  const p = await playOnce('#inspector [data-animk="c.style.anim"][data-animv="pop"]', tx.start, tx.n);
  const tend = tx.start + tx.n, set = await ev(() => textStyle(P.text.at(-1), 'text').anim);
  if (rm === 'reduce') check(`${rm}: picking Pop jumps to its end, no playback`, set === 'pop' && p.starts === 0 && Math.abs(p.t - tend) < 0.02, `anim ${set}, ${p.starts} plays, playhead ${p.t.toFixed(3)} (end ${tend.toFixed(3)})`);
  else check(`${rm}: picking Pop plays its span once`, set === 'pop' && p.starts === 1 && !p.playing && p.minT >= tx.start - 1e-3 && Math.abs(p.t - tend) < 0.02 && Math.abs(p.playedFor / 1000 - (tend - tx.start)) < 0.25,
    `anim ${set}, ${p.starts} play from ${p.minT.toFixed(2)}, ${(p.playedFor / 1000).toFixed(2)} s for a ${(tend - tx.start).toFixed(2)} s span, stopped at ${p.t.toFixed(3)}`);
  // a video clip's In animation (Zoom in, 0.5 s)
  await ev(() => { S.sel = { lane: 'main', id: P.main[0].id }; S.itab = 'Animate'; renderAll(); });
  const v = await playOnce('#inspector [data-animk="c.anim.in"][data-animv="grow"]', 0, 0.5);
  const vend = 0.5, vset = await ev(() => P.main[0].anim?.in);
  if (rm === 'reduce') check(`${rm}: picking a clip In tile jumps to its end`, vset === 'grow' && v.starts === 0 && Math.abs(v.t - vend) < 0.02, `anim ${vset}, ${v.starts} plays, playhead ${v.t.toFixed(3)}`);
  else check(`${rm}: picking a clip In tile plays its span once`, vset === 'grow' && v.starts === 1 && !v.playing && Math.abs(v.t - vend) < 0.02, `anim ${vset}, ${v.starts} play, ${(v.playedFor / 1000).toFixed(2)} s, stopped at ${v.t.toFixed(3)}`);
  check(`${rm}: the picked tile shows as on`, await ev(() => !!$('#inspector [data-animk="c.anim.in"][data-animv="grow"].on')));
  check(`${rm}: no page errors`, !errs.length, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------- 3. resizable panes ----------
{
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 } });
  let { page, errs, ev } = await open('no-preference', null, ctx);
  await ev(() => { try { localStorage.removeItem('cutroom.panes'); } catch {} });
  await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
  const sizes = () => ev(() => ({ lw: $('.left').getBoundingClientRect().width, rw: $('#inspector').getBoundingClientRect().width, th: $('.timeline').getBoundingClientRect().height, stage: $('#stage').getBoundingClientRect().width }));
  const s0 = await sizes();
  const drag = async (k, dx, dy) => { const bb = await page.locator(`.gut[data-gut="${k}"]`).boundingBox(); const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2; await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y + dy / 2); await page.mouse.move(x + dx, y + dy); await page.mouse.up(); };
  await drag('lw', 60, 0); await drag('rw', -50, 0); await drag('th', 0, -80);
  const s1 = await sizes();
  check('panes: the three handles resize library, inspector and timeline', Math.abs(s1.lw - s0.lw - 60) <= 2 && Math.abs(s1.rw - s0.rw - 50) <= 2 && Math.abs(s1.th - s0.th - 80) <= 2,
    `library ${s0.lw}->${s1.lw}, inspector ${s0.rw}->${s1.rw}, timeline ${s0.th}->${s1.th}`);
  await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
  const s2 = await sizes();
  check('panes: sizes persist across a reload', ['lw', 'rw', 'th'].every(k => Math.abs(s2[k] - s1[k]) <= 1), `after reload ${s2.lw} / ${s2.rw} / ${s2.th}`);
  await page.locator('.gut[data-gut="lw"]').dblclick();
  const s3 = await sizes();
  check('panes: double-click resets that one', Math.abs(s3.lw - s0.lw) <= 1 && Math.abs(s3.rw - s1.rw) <= 1, `library ${s3.lw}, inspector ${s3.rw}`);
  await drag('lw', 900, 0); // far too wide: the preview keeps its room
  const s4 = await sizes();
  check('panes: the preview keeps at least 360 px', s4.stage >= 358, `library ${s4.lw}, stage ${s4.stage}`);
  check('panes: no page errors', !errs.length, errs.slice(0, 2).join(' | '));
  await ev(() => { try { localStorage.removeItem('cutroom.panes'); } catch {} });
  await ctx.close();
}
for (const pid of pids) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await fetch(`${B}/api/media/${mid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
