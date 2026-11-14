// 3D zoom (Tools tab on a photo clip, clip_tool zoom_3d): a still photo becomes a short silent clip where the camera pushes in, pulls out,
// slides or orbits and the near things move more than the far ones. Uses the depth model (Depth Anything V2 Small): an AI test (--ai).
// The photo is synthetic: a shaded red ball (near) on a blue noise wall (far, no red anywhere), so what moved is measurable:
//   render   each direction at 1280x720: frame count, the start (or end, for "out") equals the photo, no frozen frames, the ball moves more than
//            the wall behind it (centroid vs block-matched wall patch), and the gap behind the ball's edge shows wall, not a red smear
//   refuse   a bad direction, a video, and the switch in Settings each answer in words
//   page     both motion modes: the Tools tab controls, a render from the panel, the MCP command, preview == export, undo / redo, reload, no page errors
//   B=<scratch server> CUTROOM_HOME=<its library> node tests/zoom3d.mjs   (never 4610)
import { browser } from './browser.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const B = process.env.B, HOME = process.env.CUTROOM_HOME, OUT = fileURLToPath(new URL('./out/zoom3d/', import.meta.url));
if (!B || !HOME) { console.error('FAIL: set B and CUTROOM_HOME to a scratch server (never 4610)'); process.exit(1); }
if (/:4610\b/.test(B) || /Movies\/Cutroom/.test(HOME)) { console.error('FAIL: never the personal server or library'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = 1280, HH = 720;

// ---- the photo ----
const PHOTO = `${OUT}zoom3d_photo.jpg`;
{
  const px = Buffer.alloc(W * HH * 3);
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const blocks = Array.from({ length: 82 * 47 }, () => rnd());
  const cx = 420, cy = 380, R = 170;
  for (let y = 0; y < HH; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, d = Math.hypot(x - cx, y - cy);
    let r, g, b;
    if (d < R) {
      const sh = Math.max(0.15, 1 - Math.hypot(x - cx + 50, y - cy + 50) / (1.6 * R)), st = 0.85 + 0.15 * Math.sin(x / 9);
      [r, g, b] = [0.95 * sh * st, 0.25 * sh, 0.1 * sh];
    } else {
      const v = blocks[Math.floor(y / 16) * 82 + Math.floor(x / 16)], gr = ((Math.floor(x / 40) + Math.floor(y / 40)) % 2) * 0.08;
      [r, g, b] = [0.15 + 0.1 * v + gr, 0.35 + 0.25 * v + gr, 0.55 + 0.2 * v + gr];
    }
    px[i] = Math.min(255, r * 255); px[i + 1] = Math.min(255, g * 255); px[i + 2] = Math.min(255, b * 255);
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${HH}`, '-i', '-', '-q:v', '2', PHOTO], { input: px });
}
const CLIP = `${OUT}zoom3d_video.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', CLIP]);
for (const f of [PHOTO, CLIP]) {
  const n = f.split('/').pop();
  if (!(await api('/api/media')).some(m => m.name === n)) await fetch(`${B}/api/import?name=${n}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) });
}
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const lib = await api('/api/media'), ph = lib.find(m => m.name === 'zoom3d_photo.jpg'), vid = lib.find(m => m.name === 'zoom3d_video.mp4');
const made = new Set();
async function job(body) { // a render to the end: the new media's meta
  const r = await api('/api/zoom3d', body);
  if (r.error) throw new Error(r.error);
  for (;;) {
    await sleep(400);
    const s = await api(`/api/jobs/${r.job}`);
    if (s.state === 'done') { made.add(s.media); return (await api('/api/media')).find(m => m.id === s.media); }
    if (s.state !== 'running') throw new Error(s.error || s.state);
  }
}
const frames = f => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 }), n = W * HH * 3, o = []; for (let i = 0; i + n <= b.length; i += n) o.push(b.subarray(i, i + n)); return o; };
const gray = fr => { const g = new Float32Array(W * HH); for (let i = 0; i < g.length; i++) g[i] = (fr[i * 3] + fr[i * 3 + 1] + fr[i * 3 + 2]) / 3; return g; };
const redMask = fr => { const m = new Uint8Array(W * HH); for (let i = 0; i < m.length; i++) m[i] = fr[i * 3] > fr[i * 3 + 2] + 25 && fr[i * 3] > fr[i * 3 + 1] + 25 ? 1 : 0; return m; };
function ball(fr) { const m = redMask(fr); let n = 0, sx = 0, sy = 0; for (let i = 0; i < m.length; i++) if (m[i]) { n++; sx += i % W; sy += (i / W) | 0; } const cx = sx / n, cy = sy / n, r = Math.sqrt(n / Math.PI); let tail = 0; for (let i = 0; i < m.length; i++) if (m[i] && Math.hypot(i % W - cx, ((i / W) | 0) - cy) > 1.15 * r) tail++; return { cx, cy, r, n, tail }; }
function shift(a, b, x0, y0, S = 40, K = 90) { // where the wall patch at (x0, y0) in a went in b (SAD over +-K px)
  let best = 1e18, bx = 0, by = 0;
  for (let dy = -K; dy <= K; dy++) for (let dx = -K; dx <= K; dx++) {
    let s = 0;
    for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) s += Math.abs(a[(y0 + y) * W + x0 + x] - b[(y0 + y + dy) * W + x0 + x + dx]);
    if (s < best) { best = s; bx = dx; by = dy; }
  }
  return { dx: bx, dy: by, d: Math.hypot(bx, by) };
}
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const photoFr = frames(PHOTO)[0];

// ---- each direction ----
const AMT = 0.8, DUR = 2, FPS = 30;
const copies = {};
for (const dir of ['in', 'out', 'left', 'right', 'orbit']) {
  const t0 = Date.now(), m = await job({ media: ph.id, direction: dir, amount: AMT, dur: DUR, fps: FPS });
  copies[dir] = m;
  const f = `${HOME}/media/${m.file}`, fr = frames(f), n = fr.length;
  check(`${dir}: a ${W}x${HH} silent video of ${DUR * FPS} frames`, m.kind === 'video' && m.w === W && m.h === HH && n === DUR * FPS && !m.hasAudio, `${m.w}x${m.h} ${n} frames, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const hold = dir === 'out' ? n - 1 : 0, rest = dir === 'orbit' ? 15 : n - 1;
  const a = fr[dir === 'out' ? n - 1 : 0];
  check(`${dir}: the ${dir === 'out' ? 'last' : 'first'} frame is the photo (mean difference under 4 levels)`, mad(a, photoFr) < 4, `${mad(a, photoFr).toFixed(2)}`);
  let run = 1, worst = 1; for (let i = 1; i < n; i++) { run = Buffer.compare(fr[i], fr[i - 1]) === 0 ? run + 1 : 1; worst = Math.max(worst, run); }
  const moving = [10, 20, 30, 40, 50].every(i => mad(fr[i], fr[i - 8]) > 0.3);
  check(`${dir}: no frozen frames (no 3 identical in a row; every 8 frames the picture changes)`, worst <= 2 && moving, `longest run ${worst}`);
  const from = fr[hold === 0 ? 0 : 0], to = fr[rest], gA = gray(from), gB = gray(to), b0 = ball(from), b1 = ball(to);
  const zoomy = dir === 'in' || dir === 'out', wall = zoomy ? shift(gA, gB, 860, 340) : shift(gA, gB, 400, 20); // a wall patch at the ball's mirror place (zoom), or as far from the middle sideways as the ball and above it (slides)
  const mv = [b1.cx - b0.cx, b1.cy - b0.cy], rel = zoomy ? Math.hypot(...mv) - wall.d : Math.hypot(mv[0] - wall.dx, mv[1] - wall.dy); // slides: the ball against the wall (the base zoom moves both outward); zoom: the ball's move beyond the wall's
  check(`${dir}: the ball moves more than the wall behind it (by ${rel.toFixed(1)} px; ball ${mv.map(v => v.toFixed(0))}, wall ${wall.dx},${wall.dy})`, rel > (zoomy ? 8 : 12), `ball (${b0.cx.toFixed(0)},${b0.cy.toFixed(0)}) -> (${b1.cx.toFixed(0)},${b1.cy.toFixed(0)})`);
  const tail = Math.max(...[rest, Math.floor(rest / 2)].map(i => ball(fr[i]).tail / b0.n));
  check(`${dir}: no red smear off the ball's edge (red beyond 1.15 radii under 1.5 % of the ball)`, tail < 0.015, `${(tail * 100).toFixed(2)} %; at the start ${(b0.tail / b0.n * 100).toFixed(2)} %`);
  if (process.env.SAVE) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-vf', `select='eq(n,0)+eq(n,${rest})',scale=640:-1,tile=2x1`, '-frames:v', '1', `${OUT}sheet_${dir}.png`]);
}

// ---- refusals in words ----
const bad = async (body, re, what) => { const r = await api('/api/zoom3d', body); let msg = r.error || ''; if (r.job) { for (;;) { await sleep(300); const s = await api(`/api/jobs/${r.job}`); if (s.state !== 'running') { msg = s.error || s.state; if (s.media) made.add(s.media); break; } } } check(what, re.test(msg), msg); };
await bad({ media: ph.id, direction: 'sideways' }, /direction must be one of/, 'a bad direction is refused in words');
await bad({ media: vid.id, direction: 'in' }, /works on a photo/, 'a video is refused: 3D zoom works on a photo');
await api('/api/settings', { 'ai.zoom3d': false });
await bad({ media: ph.id, direction: 'in' }, /turned off in Settings/, 'turned off in Settings: refused in words');
await api('/api/settings', { 'ai.zoom3d': null });
const caps = await api('/api/ai/caps');
check('the budget row is listed for this computer (backend, size, memory, speed)', caps.jobs.some(j => j.kind === 'zoom3d' && (j.refused || (j.size && j.gb && j.rate))), JSON.stringify(caps.jobs.find(j => j.kind === 'zoom3d')));

// ---- the page ----
const b = await browser.launch();
const pids = new Set();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => { if (!/\/poster/.test(e.message)) errs.push(e.message); }); // (leaving a page sends its poster with keepalive: the reload)
  const ev = (f, a) => page.evaluate(f, a);
  const open = async () => { await page.goto(`${B}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0 && typeof SET === 'object', null, { timeout: 30000 }); await page.waitForTimeout(300); if (await page.$('#tour')) await page.keyboard.press('Escape'); };
  await open();
  const pid = await ev(async id => { await REMOTE.new_project({ ratio: '16:9', name: 'zoom3d test' }); await REMOTE.add_clip({ media: id }); undo.length = 0; redo.length = 0; renderAll(); return P.id; }, ph.id);
  pids.add(pid);
  const cid = await ev(() => P.main[0].id);
  await ev(id => { S.sel = { lane: 'main', id }; renderInspector(); }, cid);
  await page.click('[data-itab="Tools"]');
  const ctl = await ev(() => ['[data-z3d="in"]', '[data-z3d="out"]', '[data-z3d="left"]', '[data-z3d="right"]', '[data-z3d="orbit"]', '[data-z3="amount"]', '[data-z3="dur"]', '[data-act="zoom3d"]'].filter(s => !document.querySelector(s)));
  check(`[${rm}] the Tools tab has the camera, amount, length and Make 3D zoom`, !ctl.length, ctl.join(' '));
  // from the panel: Left, 2 seconds
  await page.click('[data-z3d="left"]');
  await page.locator('[data-z3="dur"]').fill('2');
  await page.click('[data-act="zoom3d"]');
  await page.waitForFunction(() => P.main[0].z3 || /fail|error|needs|turned off/i.test(document.querySelector('#clipStatus')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
  let s = await ev(() => { const c = P.main[0]; return { media: c.media, z3: c.z3, len: c.out - c.in, kind: M.get(c.media)?.kind, status: document.querySelector('#clipStatus')?.textContent }; });
  if (s.media !== ph.id) made.add(s.media);
  check(`[${rm}] Make 3D zoom switches the clip to the rendered video (left, 2 s)`, s.kind === 'video' && s.z3?.dir === 'left' && s.z3.src === ph.id && Math.abs(s.len - 2) < 0.01, JSON.stringify(s));
  check(`[${rm}] the panel offers Remove 3D zoom now`, !!(await page.$('[data-act="z3off"]')));
  // preview == export on the rendered clip (160x90 block means, like video_parity)
  const cmp = await ev(async () => {
    const grab = async preview => { const r = await REMOTE.snapshot({ t: 1.0, max: 640, preview }); const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
    const e = await grab(false), p = await grab(true); let sum = 0, worst = 0;
    for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) { let q = 0; for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) q += Math.abs(e[(y * 160 + x) * 4 + k] - p[(y * 160 + x) * 4 + k]); sum += q; worst = Math.max(worst, q / 300); }
    return { mean: sum / (16 * 9 * 300), worst };
  });
  check(`[${rm}] preview == export at 1.0 s (mean under 2.5 levels, worst block under 12)`, cmp.mean < 2.5 && cmp.worst < 12, JSON.stringify(cmp));
  // the clip's picture really is the parallax: the playhead moves it
  const moved = await ev(async () => { const g = async t => { const r = await REMOTE.snapshot({ t, max: 320, preview: true }); return r.image; }; return (await g(0.05)) !== (await g(1.9)); });
  check(`[${rm}] the preview differs between the start and the end`, moved);
  // undo / redo / reload
  await ev(() => restore(undo, redo));
  await page.waitForTimeout(300);
  let u = await ev(() => ({ media: P.main[0].media, z3: !!P.main[0].z3 }));
  check(`[${rm}] undo is one step back to the photo`, u.media === ph.id && !u.z3, JSON.stringify(u));
  await ev(() => restore(redo, undo));
  await page.waitForTimeout(300);
  u = await ev(() => ({ media: P.main[0].media, z3: P.main[0].z3?.dir }));
  check(`[${rm}] redo brings the 3D zoom back`, u.media !== ph.id && u.z3 === 'left', JSON.stringify(u));
  await ev(() => new Promise(r => { const t = setInterval(() => { if (!S.dirty && !S.saving) { clearInterval(t); r(); } }, 100); setTimeout(r, 4000); }));
  await sleep(800);
  await open();
  const rl = await ev(id => P.id === id ? { z3: P.main[0].z3, media: P.main[0].media, kind: M.get(P.main[0].media)?.kind } : { other: P.id }, pid);
  check(`[${rm}] after a reload the clip still plays its 3D zoom`, rl.z3?.dir === 'left' && rl.kind === 'video', JSON.stringify(rl));
  // the MCP command, then Remove from the panel
  await ev(id => { S.sel = { lane: 'main', id }; renderInspector(); }, cid);
  const r = await ev(async id => { try { const o = await REMOTE.clip_tool({ id, action: 'zoom_3d', direction: 'orbit', amount: 0.5, duration: 1.5 }); const c = P.main[0]; return { ok: !!o.clip, z3: c.z3, len: c.out - c.in, zoom3d: o.clip?.zoom3d }; } catch (e) { return { err: e.message }; } }, cid);
  if (r.z3?.copy) made.add(r.z3.copy);
  check(`[${rm}] MCP clip_tool zoom_3d renders from the photo again (orbit, 0.5, 1.5 s)`, r.ok && r.z3?.dir === 'orbit' && r.z3.src === ph.id && Math.abs(r.len - 1.5) < 0.01 && r.zoom3d?.direction === 'orbit', JSON.stringify(r));
  const badc = await ev(async id => { try { await REMOTE.clip_tool({ id, action: 'zoom_3d', direction: 'up' }); return 'accepted'; } catch (e) { return e.message; } }, cid);
  check(`[${rm}] MCP zoom_3d with a bad direction is refused in words`, /direction must be one of/.test(badc), badc);
  await ev(id => { S.sel = { lane: 'main', id }; renderInspector(); }, cid);
  await page.click('[data-itab="Tools"]');
  await page.click('[data-act="z3off"]');
  await page.waitForTimeout(300);
  u = await ev(() => ({ media: P.main[0].media, z3: !!P.main[0].z3 }));
  check(`[${rm}] Remove 3D zoom puts the photo back`, u.media === ph.id && !u.z3, JSON.stringify(u));
  check(`[${rm}] no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
  await ctx.close();
}
await b.close();
for (const pid of pids) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
for (const id of made) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
