// Tracking (2026-11-10): motion tracking with position, scale and rotation; follow-blur (blur / mosaic a tracked region,
// blur every face); auto reframe for any subject. Acceptance numbers against synthetic or independent truth, in headless
// WebKit on a scratch server:  CUTROOM_HOME=<lib> B=http://127.0.0.1:<port> node tests/tracking.mjs [section]
//   track   a patch that moves, grows 1 -> 2 and turns 0 -> 45 deg: the attached sticker / text keyframes within 3 % scale, 3 deg
//   blur    a box drawn on it (real mouse): the export's detail inside the true patch is gone in >= 95 % of frames, preview = export
//   faces   blur faces on talk-with-music: every face Vision finds on the source frames is blurred in >= 95 % of them
//   reframe bmx-trees (no face) to 9:16: the rider (SAM 2 cutout centre) inside the crop in >= 95 % of frames; fox-walk, the fox boxed
//   ui      the new buttons in both reduced-motion modes; the panel still fits
import { browser } from './browser.mjs';
import { requireHome } from './runtime.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const LIB = requireHome();
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2], EXP = `${LIB}/exports`;
const res = [], nums = {};
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const before = { p: new Set((await get('/api/projects')).map(x => x.id)), m: new Set((await get('/api/media')).map(x => x.id)), e: new Set(fs.readdirSync(EXP)) };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-track-`);
const env = { ...process.env }; delete env.PYTHONPATH;
const truth = (...a) => JSON.parse(execFileSync(`${ROOT}/ai/.venv/bin/python`, ['-I', `${ROOT}/tests/track_truth.py`, ...a], { env, maxBuffer: 1 << 26 }).toString());
const gen = (name, args) => { const f = `${tmp}/${name}`; execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return f; };
const imp = async f => (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json());
const run = name => !only || name.includes(only);
const syn = truth('synth', `${tmp}/synth.mp4`);
fs.writeFileSync(`${tmp}/synth.json`, JSON.stringify(syn));
const SYN = await imp(`${tmp}/synth.mp4`), RED = await imp(gen('trk-red.png', ['-f', 'lavfi', '-i', 'color=c=red:s=320x320:d=1', '-frames:v', '1']));
const lib = await get('/api/media'), byName = n => lib.find(m => m.name === n);
const MEDIA = { SYN, RED, BMX: byName('bmx-trees.mp4'), FOX: lib.find(m => m.id === '87cf24520932'), TALK: byName('talk-with-music.mp4') };

const b = await browser.launch();
const errs = [];
async function open(reduce = 'no-preference') {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: reduce })).newPage();
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  await page.evaluate(() => loadMedia());
  await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), [SYN.id, RED.id], { timeout: 60000 });
  return page;
}
const page = await open();
const ev = (f, a) => page.evaluate(f, a);
const fresh = (name, ratio = '16:9') => ev(([name, M0, ratio]) => { setProject(newProject(ratio)); P.name = `${name} (scratch)`; window.MD = M0; S.t = 0; renderAll(); return P.id; }, [name, MEDIA, ratio]);
// x264 (quality best), not the default VideoToolbox: the synth background's fine detail is ~1.5 grey levels, and the hardware
// encoder's rate control keeps a different share of it on every export of the SAME project (ring median 0.48 / 0.76 / 0.76 in a row),
// so the ring check measured the encoder, not where the blur is. x264 gives the same file every time.
const exportMp4 = name => ev(n => REMOTE.export({ format: 'mp4', resolution: '720p', name: n, quality: 'best' }).then(r => r.file, e => 'ERR ' + e.message), name);
const still = (t, max = 640) => ev(async ([t, max]) => { const r = await REMOTE.snapshot({ t, max }); const i = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); return { w: i.width, h: i.height, px: [...g.getImageData(0, 0, i.width, i.height).data] }; }, [t, max]);
const pvImg = t => ev(async t => { seekTo(t); await waitFrame(); const cv = $('#cv'), x = document.createElement('canvas').getContext('2d'); x.canvas.width = 640; x.canvas.height = 360; x.drawImage(cv, 0, 0, 640, 360); return { w: 640, h: 360, px: [...x.getImageData(0, 0, 640, 360).data] }; }, t);
const at = (img, fx, fy) => { const i = (Math.round(fy * (img.h - 1)) * img.w + Math.round(fx * (img.w - 1))) * 4; return img.px.slice(i, i + 3); };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r2 = x => Math.round(x * 100) / 100;
const S0 = syn.truth[0], BOX = { x: syn.box[0] / syn.w, y: syn.box[1] / syn.h, w: syn.box[2] / syn.w, h: syn.box[3] / syn.h }; // canvas fractions = source fractions (same 16:9)

try {
// ---------- motion tracking: position, scale, rotation ----------
if (run('track')) {
  await fresh('Track');
  const ids = await ev(async ([S0, w, h]) => {
    addMedia(MD.SYN.id, 'main'); addMedia(MD.RED.id, 'overlay', 0);
    const st = P.overlay.at(-1); Object.assign(st, { fit: 'fit', scale: 0.15, out: 4, x: S0[0] / w - 0.5, y: S0[1] / h - 0.5 });
    const tx = await REMOTE.add_text({ text: 'TAG', start: 0, duration: 4, x: S0[0] / w + 0.1, y: S0[1] / h });
    renderAll(); return [st.id, tx.id];
  }, [S0, syn.w, syn.h]);
  const t0 = Date.now(), r = await ev(([id, box]) => REMOTE.track_motion({ id, box, t: 0 }), [ids[0], BOX]), secs = (Date.now() - t0) / 1000;
  await ev(([id, box]) => REMOTE.track_motion({ id, box, t: 0 }), [ids[1], BOX]);
  const kf = await ev(ids => ids.map(id => { const [c] = cfind(id); return Array.from({ length: 120 }, (_, i) => propsAt(c, i / 30 - c.start)); }), ids);
  const es = [], er = [], ep = [], et = [];
  for (let i = 0; i < 120; i++) {
    const g = syn.truth[i], k = g[2] / S0[2], p = kf[0][i], q = kf[1][i], rad = ((g[3] - S0[3]) * Math.PI) / 180;
    es.push(Math.abs(p.scale / kf[0][0].scale / k - 1) * 100); er.push(Math.abs(p.rot - kf[0][0].rot - (g[3] - S0[3])));
    ep.push(Math.hypot((0.5 + p.x) * 1920 - g[0] * 1.5, (0.5 + p.y) * 1080 - g[1] * 1.5)); // canvas px (1920 / 1280 = 1.5)
    const ox = 0.1 * 1920 * k * Math.cos(rad), oy = 0.1 * 1920 * k * Math.sin(rad); // the text sat 0.1 canvas widths right of the patch centre: it orbits with it
    et.push(Math.hypot(q.x * 1920 - (g[0] * 1.5 + ox), q.y * 1080 - (g[1] * 1.5 + oy)));
  }
  nums.track = { secs: r2(secs), frames: r.frames, scaleMaxPct: r2(Math.max(...es)), rotMaxDeg: r2(Math.max(...er)), posMaxPx: r2(Math.max(...ep)), textOrbitMaxPx: r2(Math.max(...et)) };
  check('tracked every frame of the patch both ways (OpenCV corners, RANSAC similarity)', r.frames === 120 && !r.lost, JSON.stringify(r));
  check('the sticker grows with the patch: scale error < 3 % on every frame', Math.max(...es) < 3, `max ${r2(Math.max(...es))} %, p95 ${r2(pct(es, 0.95))} %`);
  check('...and turns with it: rotation error < 3 deg on every frame', Math.max(...er) < 3, `max ${r2(Math.max(...er))} deg`);
  check('...and stays on it: centre within 1 % of the canvas width', Math.max(...ep) < 19.2, `max ${r2(Math.max(...ep))} px of 1920`);
  check('text placed beside the patch orbits with it (kept its place on the turning, growing target)', Math.max(...et) < 25, `max ${r2(Math.max(...et))} px`);
  const e3 = await still(3), p3 = await pvImg(3), g3 = syn.truth[90], fx = g3[0] / 1280, fy = g3[1] / 720;
  check('the export shows the sticker on the patch at 3 s (red at the true centre)', at(e3, fx, fy)[0] > 200 && at(e3, fx, fy)[1] < 60, at(e3, fx, fy));
  check('...and so does the preview', at(p3, fx, fy)[0] > 200 && at(p3, fx, fy)[1] < 60, at(p3, fx, fy));
}

// ---------- follow-blur: a region boxed with the mouse, blurred where it goes ----------
if (run('blur')) {
  await fresh('Blur none');
  await ev(() => { addMedia(MD.SYN.id, 'main'); renderAll(); });
  const plain = truth('blur', `${EXP}/${await exportMp4('trk-plain')}`, `${tmp}/synth.json`), ring0 = pct(plain.ring, 0.5); // the export's own detail loss, without any blur
  for (const style of ['blur', 'mosaic']) {
    await fresh(`Blur ${style}`);
    await ev(() => { addMedia(MD.SYN.id, 'main'); S.sel = { lane: 'main', id: P.main[0].id }; S.itab = 'Tools'; seekTo(2); renderAll(); });
    await page.waitForTimeout(300);
    await page.selectOption('#blurStyle', style).catch(() => {});
    await page.click('#inspector [data-act="blurregion"]');
    const g = syn.truth[60], cv = await page.locator('#cv').boundingBox(), k = cv.width / 1280, half = (syn.box[2] * g[2]) / 2 * 0.95;
    await page.mouse.move(cv.x + (g[0] - half) * k, cv.y + (g[1] - half) * k); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cv.x + (g[0] - half + (2 * half * i) / 8) * k, cv.y + (g[1] - half + (2 * half * i) / 8) * k);
    await page.mouse.up();
    await page.waitForFunction(() => P.overlay.some(c => c.blurs), null, { timeout: 120000 });
    const info = await ev(() => { const c = P.overlay.find(x => x.blurs), q = maskAt(c, 2); return { n: c.mkf?.length, type: c.mask.type, blur: c.adj.blur, pix: c.adj.pix, dur: +len(c).toFixed(2), at2: [q.x + 0.5, q.y + 0.5, q.w, q.rot].map(v => +v.toFixed(3)) }; });
    info.truth2 = [g[0] / 1280, g[1] / 720, (syn.box[2] * g[2]) / 1280].map(v => +v.toFixed(3));
    check(`${style}: a masked ${style} copy of the clip on the overlay track, its mask keyframed every frame`, info.n >= 100 && (style === 'blur' ? info.blur > 0 : info.pix > 0) && Math.abs(info.dur - 4) < 0.05, JSON.stringify(info));
    const t0 = Date.now(), f = await exportMp4(`trk-${style}`), xs = (Date.now() - t0) / 1000;
    check(`${style}: exports`, !/^ERR/.test(f), f);
    const m = truth('blur', `${EXP}/${f}`, `${tmp}/synth.json`);
    nums[style] = { framesOnTarget: m.on, frames: m.frames, insideP95: pct(m.inside, 0.95), ringMedian: pct(m.ring, 0.5), exportSecs: r2(xs) };
    check(`${style}: the true patch is blurred in >= 95 % of the export's frames`, m.on >= 0.95, `${(m.on * 100).toFixed(1)} % of ${m.frames}; detail kept inside p95 ${pct(m.inside, 0.95)}`);
    check(`${style}: the picture around it stays as sharp as a plain export (ring detail within 0.05)`, pct(m.ring, 0.5) > ring0 - 0.05, `median ${pct(m.ring, 0.5)} vs ${ring0} plain`);
    const d = [];
    for (const t of [0.5, 2, 3.5]) { // preview == export, where the blur is (around the true patch)
      const e = await still(t), p = await pvImg(t), gi = syn.truth[Math.round(t * 30)];
      for (let dy = -0.03; dy <= 0.031; dy += 0.015) for (let dx = -0.02; dx <= 0.021; dx += 0.01) { const fx = gi[0] / 1280 + dx, fy = gi[1] / 720 + dy, a = at(e, fx, fy), q = at(p, fx, fy); d.push(Math.max(...a.map((v, i) => Math.abs(v - q[i])))); }
    }
    nums[style].previewVsExportP90 = pct(d, 0.9);
    check(`${style}: the preview shows what the export renders (p90 channel diff over the blurred patch <= 24)`, pct(d, 0.9) <= 24, `p90 ${pct(d, 0.9)}, max ${Math.max(...d)}`);
  }
}

// ---------- blur all faces ----------
if (run('faces') && MEDIA.TALK) {
  await fresh('Faces');
  await ev(() => { addMedia(MD.TALK.id, 'main'); Object.assign(P.main[0], { in: 0, out: 4 }); renderAll(); });
  const r = await ev(() => REMOTE.blur_faces({ id: P.main[0].id }).then(x => x, e => ({ err: e.message })));
  check('blur faces: one tracked blur per face on the overlay track', r.faces >= 1 && !r.err, JSON.stringify(r));
  const f = await exportMp4('trk-faces');
  const src = `${LIB}/media/${MEDIA.TALK.file}`, fj = `${tmp}/faces.jsonl`;
  fs.writeFileSync(fj, execFileSync(`${ROOT}/tools/faces`, [src, '0', '3.99', '30', 'all']));
  const m = truth('faces', `${EXP}/${f}`, src, fj);
  nums.faces = { faces: r.faces, samples: m.faces, on: m.on };
  check('every face Vision finds on the source (30 a second) is blurred in >= 95 % of frames', m.on >= 0.95 && m.faces > 60, `${(m.on * 100).toFixed(1)} % of ${m.faces} face-frames`);
}

// ---------- auto reframe, any subject ----------
if (run('reframe')) {
  const inside = async (id, centres) => ev(([id, C]) => { // per frame: is the subject's centre inside the canvas (the crop)?
    const [c] = cfind(id), m = M.get(c.media), fps = m.fps || 30;
    return C.map((q, i) => { if (!q) return null; const lt = i / fps - c.start; if (lt < 0 || lt > len(c)) return null; const g = geom(m, c, P.w, P.h, propsAt(c, lt)), x = g.x + q[0] * g.w, y = g.y + q[1] * g.h; return [x / P.w, y / P.h]; }).filter(Boolean);
  }, [id, centres]);
  if (MEDIA.BMX) {
    const cut = await (await fetch(`${B}/api/remove_object`, { method: 'POST', headers: H, body: JSON.stringify({ media: MEDIA.BMX.id, t: 0, t0: 0, t1: MEDIA.BMX.duration, box: { x: 0.43, y: 0.25, w: 0.22, h: 0.5 }, mode: 'cutout' }) })).json();
    let j; for (;;) { await new Promise(z => setTimeout(z, 1000)); j = await get(`/api/jobs/${cut.job}`); if (j.state !== 'running') break; }
    const tr = j.state === 'done' ? truth('alpha', `${LIB}/media/${(await get('/api/media')).find(m => m.id === j.media).file}`).centres : [];
    check('truth for bmx-trees: SAM 2 cut out the rider on its frames', tr.filter(Boolean).length > 60, `${tr.filter(Boolean).length} frames`);
    await fresh('Reframe bmx');
    const id = await ev(() => { addMedia(MD.BMX.id, 'main'); renderAll(); return P.main[0].id; });
    const r = await ev(id => REMOTE.auto_reframe({ id, ratio: '9:16' }).then(x => x, e => ({ err: e.message })), id);
    const pos = await inside(id, tr), ok = pos.filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1).length / pos.length;
    nums.reframeBmx = { kind: r.kind, canvas: r.canvas, inside: r2(ok), frames: pos.length, worstX: r2(Math.max(...pos.map(([x]) => Math.abs(x - 0.5)))) };
    const kf0 = await ev(id => { const c = cfind(id)[0], k = c.kf; delete c.kf; return k; }, id), still0 = await inside(id, tr); // control: a plain centred 9:16 crop
    await ev(([id, k]) => { cfind(id)[0].kf = k; }, [id, kf0]);
    nums.reframeBmx.centredCropInside = r2(still0.filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1).length / still0.length);
    check('bmx-trees has no face: the reframe follows Vision saliency, canvas 9:16', r.kind === 'subject' && r.canvas?.[0] === 1080 && r.canvas?.[1] === 1920, JSON.stringify(r));
    check('...and the rider stays inside the 9:16 crop in >= 95 % of frames', ok >= 0.95, `${(ok * 100).toFixed(1)} % of ${pos.length}; worst |x - 0.5| = ${nums.reframeBmx.worstX}`);
    const kf = await ev(id => cfind(id)[0].kf.map(f => f.x), id), jerk = kf.slice(2).map((x, i) => Math.abs(x - 2 * kf[i + 1] + kf[i]));
    console.log('  camera x per look', kf.map(x => +x.toFixed(3)).join(' '));
    nums.reframeBmx.maxSecondDiff = +Math.max(...jerk).toFixed(4);
    const turns = kf.slice(2).filter((x, i) => (x - kf[i + 1]) * (kf[i + 1] - kf[i]) < 0).length;
    nums.reframeBmx.reversals = turns;
    check('...on a smooth camera path (second difference < 5 % of the width per look, at most 2 turnarounds)', Math.max(...jerk) < 0.05 && turns <= 2, `max ${Math.max(...jerk).toFixed(4)}, ${turns} turnarounds over ${kf.length} looks`);
  }
  if (MEDIA.FOX && lib.some(m => m.id === 'd83ef70ebbad')) {
    const tr = truth('fox', LIB).centres;
    await fresh('Reframe fox');
    const id = await ev(() => { addMedia(MD.FOX.id, 'main'); renderAll(); return P.main[0].id; });
    const f0 = tr.findIndex(Boolean), q = tr[f0], box = { x: q[0] - 0.06, y: q[1] - 0.09, w: 0.12, h: 0.18 }; // the fox (a face is in this shot too: auto would pick it)
    const r = await ev(([id, box, t]) => REMOTE.auto_reframe({ id, ratio: '9:16', box, t }).then(x => x, e => ({ err: e.message })), [id, box, f0 / 30]);
    const pos = await inside(id, tr), ok = pos.filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1).length / pos.length;
    nums.reframeFox = { inside: r2(ok), frames: pos.length, worstX: r2(Math.max(...pos.map(([x]) => Math.abs(x - 0.5)))) };
    check('fox-walk reframed on the boxed fox (tracked): it stays inside the 9:16 crop in >= 95 % of frames', !r.err && ok >= 0.95, `${(ok * 100).toFixed(1)} % of ${pos.length} ${r.err || ''}`);
  }
}

// ---------- the buttons, both motion modes ----------
if (run('ui')) {
  for (const mode of ['reduce', 'no-preference']) {
    const pg = mode === 'no-preference' ? page : await open('reduce');
    await pg.evaluate(([M0]) => { setProject(newProject('16:9')); P.name = 'Track UI (scratch)'; addMedia(M0.SYN.id, 'main'); addMedia(M0.RED.id, 'overlay', 0); Object.assign(P.overlay[0], { fit: 'fit', scale: 0.15, out: 4 }); S.sel = { lane: 'main', id: P.main[0].id }; S.itab = 'Tools'; renderAll(); }, [MEDIA]);
    await pg.waitForTimeout(300);
    const vis = await pg.evaluate(() => ['reframe', 'reframepick', 'blurregion', 'blurfaces'].map(a => !!document.querySelector(`#inspector [data-act="${a}"]`)?.offsetWidth).concat(!!$('#reframeRatio')?.offsetWidth, !!$('#blurStyle')?.offsetWidth));
    check(`${mode}: Auto reframe (+ shape), Reframe on, Blur a region, Blur faces (+ style) are in the clip tools`, vis.every(Boolean), vis);
    await pg.evaluate(() => { S.sel = { lane: 'overlay', id: P.overlay[0].id }; renderAll(); });
    await pg.click('#inspector [data-act="track"]');
    const cv = await pg.locator('#cv').boundingBox(), k = cv.width / 1280;
    await pg.mouse.move(cv.x + syn.box[0] * k, cv.y + syn.box[1] * k); await pg.mouse.down();
    for (let i = 1; i <= 8; i++) await pg.mouse.move(cv.x + (syn.box[0] + (syn.box[2] * i) / 8) * k, cv.y + (syn.box[1] + (syn.box[3] * i) / 8) * k);
    await pg.mouse.up();
    await pg.waitForFunction(() => P.overlay[0].kf?.length > 100, null, { timeout: 60000 });
    const sc = await pg.evaluate(() => { const c = P.overlay[0]; return [propsAt(c, 0).scale, propsAt(c, 119 / 30).scale, propsAt(c, 119 / 30).rot]; });
    check(`${mode}: Track motion with a dragged box: the sticker doubles and turns 45 deg`, Math.abs(sc[1] / sc[0] - 2) < 0.06 && Math.abs(sc[2] - 45) < 3, sc.map(r2));
    if (pg !== page) await pg.context().close();
  }
}
} catch (e) { check('the suite ran to the end', false, String(e.message).split('\n')[0]); }

// ---------- tidy ----------
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
await ev(() => clearTimeout(saveTimer));
await b.close();
fs.rmSync(tmp, { recursive: true });
const after = { p: await get('/api/projects'), m: await get('/api/media') };
const made = { p: after.p.filter(x => !before.p.has(x.id)), m: after.m.filter(x => !before.m.has(x.id)), e: fs.readdirSync(EXP).filter(f => !before.e.has(f)) };
for (const p of made.p) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.mkdirSync(`${LIB}/trash/exports`, { recursive: true });
for (const f of made.e) fs.renameSync(`${EXP}/${f}`, `${LIB}/trash/exports/${f}`);
console.log(`\nnumbers ${JSON.stringify(nums)}`);
console.log(`${res.filter(Boolean).length}/${res.length} passed; trashed ${made.p.length} projects, ${made.m.length} media, ${made.e.length} exports`);
process.exit(res.includes(false) ? 1 : 0);
