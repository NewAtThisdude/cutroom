// Face and body retouch (tools/retouch.swift landmarks + pose, ai/retouch.py render) end to end, with measured numbers:
// landmarks found per frame, face slim narrowing the re-detected jaw, teeth whitening the mouth and nothing else, a still
// head not flickering (smoothed vs raw landmarks), body slim / longer legs from the re-detected pose, the live preview
// matching the rendered copy, and the inspector (sliders -> preview on the paused frame -> Apply -> Reset) in headless
// WebKit in both motion modes, plus REMOTE.retouch (the MCP tool). Before/after PNGs go to tests/out.
//   CUTROOM_HOME=<library> B=http://127.0.0.1:4755 [PHOTOS=<dir with talk-with-music.mp4, IMG_4700.MOV>] node tests/retouch.mjs
import { browser } from './browser.mjs';
import { requireHome, exitAfterFetch } from './runtime.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const LIB = requireHome(), B = process.env.B || 'http://127.0.0.1:4610';
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, ROOT = fileURLToPath(new URL('..', import.meta.url)), OUT = `${ROOT}tests/out`;
const TOOL = `${ROOT}tools/retouch`, PY = `${ROOT}ai/.venv/bin/python`;
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const post = async (p, body) => { const r = await (await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json(); if (r.error) throw new Error(r.error); return r; };
const runJob = async (p, body) => { const { job } = await post(p, body); for (;;) { const s = await get(`/api/jobs/${job}`); if (s.state !== 'running') { if (s.state !== 'done') throw new Error(s.error || s.state); return s; } await new Promise(z => setTimeout(z, 300)); } };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-retouch-`);
fs.mkdirSync(OUT, { recursive: true });
const before = new Set((await get('/api/media')).map(m => m.id)), projects0 = new Set((await get('/api/projects')).map(p => p.id));
const file = m => `${LIB}/media/${m.file}`;
const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
const grab = (f, t, png) => { ff(['-ss', t.toFixed(4), '-i', f, '-frames:v', '1', '-sws_flags', 'accurate_rnd+full_chroma_int', png]); return png; };
const img = png => { const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png]).toString().trim().split(',').map(Number); return { w, h, px: ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']) }; };
const lm = png => JSON.parse(execFileSync(TOOL, [png], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop());
const pts = (a, w, h) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push([a[i] * w, a[i + 1] * h]); return o; };
const big = d => d.faces.slice().sort((a, b) => b.box[2] - a.box[2])[0];
const jaw = (f, w, h) => { const C = pts(f.pts.contour, w, h); return [3, 4, 5].reduce((s, i) => s + Math.hypot(C[i][0] - C[C.length - 1 - i][0], C[i][1] - C[C.length - 1 - i][1]), 0) / 3; };
const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };
const Lstar = (r, g, b) => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const Y = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y; };
const side = (a, b, o) => ff(['-i', a, '-i', b, '-filter_complex', '[0]scale=-2:720[x];[1]scale=-2:720[y];[x][y]hstack', o]); // before | after
const pv = async (media, t, p, png) => { const r = await post('/api/retouch_preview', { media, t, p }); if (png) fs.writeFileSync(png, Buffer.from(r.png, 'base64')); return r; };

// Retouch is Apple Vision (landmarks, pose): a PC refuses it by design (server.py NOT_YET), and says so
const off = (await get('/api/ai/caps')).jobs.find(j => j.kind === 'retouch')?.refused;
if (/needs Apple Silicon/.test(off || '')) { console.log(`SKIP retouch: ${off}`); fs.rmSync(tmp, { recursive: true, force: true }); await exitAfterFetch(0); }
// the test footage: a real face talking (no stand-in has the landmarks, teeth and skin these numbers are about); from PHOTOS if not in the library
let media = await get('/api/media');
if (!media.some(m => m.name === 'talk-with-music.mp4') && process.env.PHOTOS && fs.existsSync(`${process.env.PHOTOS}/talk-with-music.mp4`)) {
  await post('/api/import_path', { path: `${process.env.PHOTOS}/talk-with-music.mp4` });
  for (let i = 0; i < 600 && !(media = await get('/api/media')).find(m => m.name === 'talk-with-music.mp4')?.ready; i++) await new Promise(z => setTimeout(z, 500));
}
const TWM = media.find(m => m.name === 'talk-with-music.mp4' && m.kind === 'video');
if (!TWM) { console.log(`SKIP retouch: real footage missing: talk-with-music.mp4 (a face talking) is not in this library or in PHOTOS (${process.env.PHOTOS || 'unset'})`); fs.rmSync(tmp, { recursive: true, force: true }); await exitAfterFetch(0); }
const fps = TWM.fps || 30;

// 1. landmarks on every frame (the Swift tool the job runs)
await pv(TWM.id, 1, {}); // builds tools/retouch if needed
const t1 = performance.now(), lines = execFileSync(TOOL, [file(TWM), '0', String(TWM.duration)], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).toString().trim().split('\n').map(JSON.parse);
const hit = lines.filter(d => d.faces.length).length;
check('landmarks found in > 95 % of frames (talk-with-music)', hit / lines.length > 0.95, `${hit}/${lines.length} frames = ${(100 * hit / lines.length).toFixed(1)} %, ${((performance.now() - t1) / 1000).toFixed(1)} s for ${TWM.duration.toFixed(1)} s`);
const POD = media.find(m => m.name === 'podcast-episode.mp4' && m.kind === 'video');
if (POD) {
  const L2 = execFileSync(TOOL, [file(POD), '0', '20'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).toString().trim().split('\n').map(JSON.parse);
  const h2 = L2.filter(d => d.faces.length).length;
  check('landmarks found in > 95 % of frames (podcast-episode, first 20 s)', h2 / L2.length > 0.95, `${h2}/${L2.length} = ${(100 * h2 / L2.length).toFixed(1)} %`);
}

// 2. face slim 30 %: the jaw width re-detected on the output vs the source, same frames
const T0 = 4, T1 = 6;
const slim = await runJob('/api/retouch', { media: TWM.id, t0: T0, t1: T1, p: { slim: 0.3 } });
const SL = (await get('/api/media')).find(m => m.id === slim.media);
const ratios = [];
for (const k of [0.25, 0.65, 1.05, 1.45, 1.85]) {
  const tc = (Math.round(k * fps) + 0.25) / fps, a = lm(grab(file(TWM), T0 + tc, `${tmp}/a.png`)), b = lm(grab(file(SL), tc, `${tmp}/b.png`));
  if (a.faces.length && b.faces.length) ratios.push(1 - jaw(big(b), 1280, 720) / jaw(big(a), 1280, 720));
}
const narrow = 100 * ratios.reduce((s, x) => s + x, 0) / Math.max(1, ratios.length);
check('face slim 30 % narrows the re-detected jaw by 10-20 %', ratios.length === 5 && narrow >= 10 && narrow <= 20, `${narrow.toFixed(1)} % (frames: ${ratios.map(x => (100 * x).toFixed(1)).join(', ')})`);
side(grab(file(TWM), T0 + 1.25 / fps + 1, `${OUT}/retouch_slim30_before.png`), grab(file(SL), 1 + 1.25 / fps, `${OUT}/retouch_slim30_after.png`), `${OUT}/retouch_slim30_before_after.png`);

// 3. teeth whiten: mouth L* up, everything away from the mouth within 2 levels of the source
const teeth = await runJob('/api/retouch', { media: TWM.id, t0: T0, t1: T1, p: { teeth: 1 } });
const TE = (await get('/api/media')).find(m => m.id === teeth.media);
const tr = [];
for (const k of [0.5, 1.0, 1.5]) {
  const tc = (Math.round(k * fps) + 0.25) / fps, A = grab(file(TWM), T0 + tc, `${tmp}/ta.png`), Bf = grab(file(TE), tc, `${tmp}/tb.png`);
  const f = big(lm(A)), a = img(A), b = img(Bf), { w, h } = a, il = pts(f.pts.ilips, w, h), ol = pts(f.pts.olips, w, h);
  const xs = ol.map(p => p[0]), ys = ol.map(p => p[1]), bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys), bw = bx1 - bx0, bh = by1 - by0;
  let la = 0, lb = 0, n = 0, out = 0, near = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (x > bx0 - bw / 2 && x < bx1 + bw / 2 && y > by0 - bh && y < by1 + bh) { if (inPoly(x, y, il)) { la += Lstar(a.px[i], a.px[i + 1], a.px[i + 2]); lb += Lstar(b.px[i], b.px[i + 1], b.px[i + 2]); n++; } continue; }
    out++;
    if (Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2])) <= 2) near++;
  }
  tr.push({ dL: (lb - la) / n, L0: la / n, keep: near / out });
}
const dL = tr.reduce((s, x) => s + x.dL, 0) / tr.length, keep = Math.min(...tr.map(x => x.keep));
check('teeth whiten raises the mouth region L*', dL > 3, tr.map(x => `L* ${x.L0.toFixed(1)} -> ${(x.L0 + x.dL).toFixed(1)}`).join(', '));
check('teeth whiten leaves > 90 % of the pixels outside the mouth within 2 levels', keep > 0.9, tr.map(x => `${(100 * x.keep).toFixed(1)} %`).join(', '));
side(grab(file(TWM), T0 + 1.25 / fps + 1, `${OUT}/retouch_teeth_before.png`), grab(file(TE), 1 + 1.25 / fps, `${OUT}/retouch_teeth_after.png`), `${OUT}/retouch_teeth_before_after.png`);

// 4. a still head: one frame held for 3 s with fresh sensor-like noise per frame (Vision's landmarks jitter on it)
const still = `${tmp}/still-head.mp4`;
ff(['-loop', '1', '-i', grab(file(TWM), 5 + 0.25 / fps, `${tmp}/head.png`), '-t', '3', '-r', '30', '-vf', 'noise=alls=5:allf=t,format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', still]);
const SH = await post('/api/import_path', { path: still });
fs.writeFileSync(`${tmp}/still.lm`, execFileSync(TOOL, [still, '0', '3'], { stdio: ['ignore', 'pipe', 'ignore'] }));
const jit = JSON.parse(execFileSync(PY, ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT + 'ai')}); import numpy as np, retouch as R
L = [json.loads(x) for x in open(${JSON.stringify(tmp + '/still.lm')})]; T = np.array([d['t'] for d in L])
raw = np.array([np.array(d['faces'][0]['pts']['contour']).reshape(-1, 2) * [1280, 720] for d in L]); v, _ = R.tracks(L, T, 30)[0]
C = np.array([R.split(x)['contour'] * [1280, 720] for x in v]); f = lambda A: float(np.abs(np.diff(A, axis=0)).mean())
print(json.dumps({'raw': f(raw), 'smooth': f(C), 'found': sum(1 for d in L if d['faces']), 'n': len(L)}))`]).toString());
check('still head: landmark jitter smoothed (frame-to-frame contour motion, px)', jit.smooth * 4 < jit.raw, `raw ${jit.raw.toFixed(3)} -> smoothed ${jit.smooth.toFixed(3)} px/frame (${(jit.raw / jit.smooth).toFixed(1)}x), faces ${jit.found}/${jit.n}`);
const P2 = { slim: 0.3, eyes: 0.4, nose: -0.3 };
const sj = await runJob('/api/retouch', { media: SH.id, t0: 0, t1: 3, p: P2 });
const SJ = (await get('/api/media')).find(m => m.id === sj.media);
const face = big(lm(`${tmp}/head.png`)).box, [rx, ry, rw, rh] = [face[0] - 0.3 * face[2], face[1] - 0.3 * face[3], 1.6 * face[2], 1.6 * face[3]].map((v, i) => 2 * Math.round(v * (i % 2 ? 360 : 640))); // even: a crop of 4:2:0 rounds odd sizes
const flick = (f, blur = 2) => { // mean frame-to-frame change inside the face box
  const buf = ff(['-i', f, '-vf', `crop=${rw}:${rh}:${rx}:${ry}${blur ? `,gblur=sigma=${blur}` : ''},format=gray`, '-f', 'rawvideo', '-']), n = rw * rh, k = Math.floor(buf.length / n);
  let s = 0; for (let j = 1; j < k; j++) for (let i = 0; i < n; i++) s += Math.abs(buf[j * n + i] - buf[(j - 1) * n + i]);
  return s / ((k - 1) * n);
};
const fi = flick(still), fo = flick(file(SJ));
check('still head: the retouched clip changes frame to frame no more than its input', fo / fi < 1.15, `input ${fi.toFixed(3)}, retouched ${fo.toFixed(3)} levels/frame (blurred: the noise averages out)`);
// the warp alone: the noisy frames' landmarks applied to the same frame WITHOUT noise, smoothed and not (ai/retouch.py's 'raw')
const clean = `${tmp}/clean-head.mp4`, wj = {};
ff(['-loop', '1', '-i', `${tmp}/head.png`, '-t', '3', '-r', '30', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', clean]);
for (const raw of [false, true]) {
  fs.writeFileSync(`${tmp}/w.json`, JSON.stringify({ src: clean, out: `${tmp}/w${raw}.mp4`, t0: 0, dur: 3, fps: 30, w: 1280, h: 720, dec: [], vf: '', tags: [], mat: '709', p: P2, lm: `${tmp}/still.lm`, raw }));
  execFileSync(PY, ['-I', `${ROOT}ai/retouch.py`, `${tmp}/w.json`], { stdio: 'ignore' });
  wj[raw] = flick(`${tmp}/w${raw}.mp4`, 0);
}
const wc = flick(clean, 0);
check('still head: no flicker of the warp (smoothed landmarks move it < half as much as raw ones)', wj.false < 0.5 * wj.true && wj.false < 0.1, `frame-to-frame change in the face: input ${wc.toFixed(3)}, warp from smoothed landmarks ${wj.false.toFixed(3)}, from raw landmarks ${wj.true.toFixed(3)} levels (${(wj.true / wj.false).toFixed(1)}x)`);

// 5. the live preview is the render: the preview PNG of a frame vs the copy's frame
const PF = { smooth: 0.6, bright: 0.5, eyes: 0.3, teeth: 0.8, slim: 0.3, lips: 0.4, blush: 0.4 };
const full = await runJob('/api/retouch', { media: TWM.id, t0: T0, t1: T1, p: PF });
const FU = (await get('/api/media')).find(m => m.id === full.media);
const t5 = (Math.round(1.2 * fps) + 0.25) / fps;
const pr = await pv(TWM.id, T0 + t5, PF, `${tmp}/pv.png`);
const a5 = img(`${tmp}/pv.png`), b5 = img(grab(file(FU), t5, `${OUT}/retouch_face_after.png`));
let d5 = 0; for (let i = 0; i < a5.px.length; i++) d5 += Math.abs(a5.px[i] - b5.px[i]);
check('the preview frame matches the rendered copy', pr.faces === 1 && d5 / a5.px.length < 2, `mean ${(d5 / a5.px.length).toFixed(2)} levels over the frame`);
side(grab(file(TWM), T0 + t5, `${OUT}/retouch_face_before.png`), `${OUT}/retouch_face_after.png`, `${OUT}/retouch_face_before_after.png`);
await pv(TWM.id, T0 + t5, { lips: 0.8, lipc: '#9e1030', blush: 0.8, blushc: '#ff5577' }, `${tmp}/mk.png`);
side(`${OUT}/retouch_face_before.png`, `${tmp}/mk.png`, `${OUT}/retouch_makeup_before_after.png`);

// 6. body: slim body + longer legs on real iPhone footage (4K120 HLG), re-detected pose
let BODY = media.find(m => m.name === 'IMG_4700.MOV');
if (!BODY && process.env.PHOTOS && fs.existsSync(`${process.env.PHOTOS}/IMG_4700.MOV`)) BODY = await post('/api/import_path', { path: `${process.env.PHOTOS}/IMG_4700.MOV` });
if (!BODY) console.log('SKIP body: no IMG_4700.MOV in the library (set PHOTOS=<dir>)');
else {
  const tb = performance.now(), bj = await runJob('/api/retouch', { media: BODY.id, t0: 1, t1: 2, p: { body: 0.6, legs: 0.6 } }), secs = (performance.now() - tb) / 1000;
  const BC = (await get('/api/media')).find(m => m.id === bj.media), bf = (Math.round(0.5 * BODY.fps) + 0.25) / BODY.fps;
  await pv(BODY.id, 1 + bf, {}, `${OUT}/retouch_body_before.png`);
  ff(['-ss', bf.toFixed(4), '-i', file(BC), '-frames:v', '1', '-vf', `scale=${img(`${OUT}/retouch_body_before.png`).w}:-2`, `${OUT}/retouch_body_after.png`]);
  const pa = lm(`${OUT}/retouch_body_before.png`).bodies[0], pb = lm(`${OUT}/retouch_body_after.png`).bodies[0];
  const hipW = p => Math.abs(p.left_upLeg_joint[0] - p.right_upLeg_joint[0]) * 9 / 16, leg = p => ((p.left_foot_joint[1] + p.right_foot_joint[1]) - (p.left_upLeg_joint[1] + p.right_upLeg_joint[1])) / 2;
  const ok = pa && pb && ['left_upLeg_joint', 'right_upLeg_joint', 'left_foot_joint', 'right_foot_joint'].every(k => pa[k] && pb[k]);
  check('body slim narrows the re-detected hips', ok && hipW(pb) < 0.97 * hipW(pa), ok ? `hip width ${(100 * (1 - hipW(pb) / hipW(pa))).toFixed(1)} % narrower` : 'pose not found');
  check('longer legs lengthen the re-detected hip-to-foot distance', ok && leg(pb) > 1.03 * leg(pa), ok ? `legs ${(100 * (leg(pb) / leg(pa) - 1)).toFixed(1)} % longer; 1 s of 4K120 HLG rendered in ${secs.toFixed(1)} s` : 'pose not found');
  side(`${OUT}/retouch_body_before.png`, `${OUT}/retouch_body_after.png`, `${OUT}/retouch_body_before_after.png`);
}

// 7. the inspector in headless WebKit, both motion modes: sliders preview the paused frame, Apply renders, Reset restores
const br = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await br.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  const cid = await ev(id => { setProject(newProject('16:9')); P.name = 'retouch test (scratch)'; addMedia(id, 'main'); S.t = 5; S.sel = { lane: 'main', id: P.main[0].id }; S.itab = 'Look'; renderAll(); return P.main[0].id; }, TWM.id);
  await ev(() => waitFrame());
  const mean = () => ev(() => { const c = $('#cv'), x = document.createElement('canvas').getContext('2d'); x.canvas.width = 160; x.canvas.height = 90; x.drawImage(c, 0, 0, 160, 90); return [...x.getImageData(0, 0, 160, 90).data]; });
  const m0 = await mean();
  const sl = page.locator('#inspector input[data-k="rt.slim"]');
  check(`${rm}: the Retouch sliders are in the inspector`, await sl.count() === 1 && await page.locator('#inspector input[data-k^="rt."]').count() >= 14, `${await page.locator('#inspector input[data-k^="rt."]').count()} controls`);
  await sl.scrollIntoViewIfNeeded();
  const t0 = performance.now();
  await sl.evaluate(el => { el.value = 0.6; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => S.rtPv?.img?.naturalWidth > 0, null, { timeout: 30000 }).catch(() => {});
  const lag = performance.now() - t0;
  await ev(() => waitFrame());
  const m1 = await mean();
  let dd = 0; for (let i = 0; i < m0.length; i++) dd += Math.abs(m0[i] - m1[i]);
  check(`${rm}: moving a slider previews the retouch on the paused frame`, await ev(() => !!S.rtPv) && dd / m0.length > 0.3, `${Math.round(lag)} ms to the preview; canvas changed ${(dd / m0.length).toFixed(2)} levels on average`);
  check(`${rm}: the project is not changed by a draft`, await ev(id => !P.main[0].rt && P.main[0].media === id, TWM.id));
  await page.click('#inspector [data-act="retouch"]');
  await page.waitForFunction(() => P.main[0].rt, null, { timeout: 120000 }).catch(() => {});
  const ap = await ev(() => ({ rt: P.main[0].rt, media: P.main[0].media, in: P.main[0].in, out: P.main[0].out }));
  check(`${rm}: Apply renders a copy the clip plays`, ap.rt?.copy === ap.media && ap.rt.src === TWM.id && ap.rt.p.slim === 0.6, JSON.stringify(ap).slice(0, 200));
  await page.click('#inspector [data-act="rtreset"]');
  const rs = await ev(() => ({ rt: P.main[0].rt, media: P.main[0].media, in: P.main[0].in, out: P.main[0].out }));
  check(`${rm}: Reset puts the original back`, !rs.rt && rs.media === TWM.id && Math.abs(rs.in - 0) < 1e-6 && Math.abs(rs.out - TWM.duration) < 0.05, JSON.stringify(rs));
  if (rm === 'reduce') {
    const r = await ev(id => REMOTE.retouch({ id, teeth: 0.7, slim: 0.2 }), cid);
    check('REMOTE.retouch (MCP) applies and reports the values', r.retouch?.teeth === 0.7 && r.retouch?.slim === 0.2 && r.retouch?.smooth === 0, JSON.stringify(r.retouch));
    const bad = await ev(id => REMOTE.retouch({ id, wings: 1 }).then(() => 'ok', e => e.message), cid);
    check('REMOTE.retouch rejects unknown values', /unknown retouch value wings/.test(bad), bad);
    const snap = await ev(() => REMOTE.snapshot({ t: 5, max: 640 }));
    fs.writeFileSync(`${tmp}/snap.png`, Buffer.from(snap.image, 'base64'));
    check('the export engine renders the retouched clip', img(`${tmp}/snap.png`).w === 640);
    const off = await ev(id => REMOTE.retouch({ id, reset: true }), cid);
    check('REMOTE.retouch reset restores the original', off.media === TWM.name && !off.retouch, JSON.stringify(off).slice(0, 200));
  }
  check(`${rm}: no page errors`, !errs.length, errs.join(' | '));
  await page.close();
}
await br.close();

// tidy by id lists (never by time): the copies and imports this run made, its scratch projects
for (const p of await get('/api/projects')) if (!projects0.has(p.id)) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
const made = (await get('/api/media')).filter(m => !before.has(m.id));
for (const m of made) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed; trashed ${made.length} media; before/after PNGs in ${OUT}`);
process.exit(res.every(Boolean) ? 0 : 1);
