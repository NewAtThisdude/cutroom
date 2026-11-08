// Preview == export, for pictures: every look, colour setting, transform, mask, blend mode, transition, effect, text preset,
// clip animation and keyframe, on synthetic moving footage. Each frame is grabbed twice through the MCP snapshot tool:
// the preview canvas (preview: true) and the export renderer (/api/still_frame); both are shrunk to 160x90 and compared.
// Reports the mean difference and the worst 10x10 block, in 0-255 levels. Side-by-sides of failures go to out/parity/.
//   node video_parity.mjs [filter]   (server on 127.0.0.1:4610)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = 'http://127.0.0.1:4610', OUT = new URL('./out/parity/', import.meta.url).pathname, only = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const MEAN = 4, BLOCK = 28, NOISY = /transition dissolve|effect (vhs|oldfilm|grain)/; // 28: a scaled or turning clip's edges land a pixel apart
const APPROX = /effect (blur|pixelate)|transition pixelize|blur bg/; // WebKit has no ctx.filter: the preview's blur and block grid are close, not exact // levels; tight enough to catch a wrong formula, a shifted frame or a misplaced box
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-parity-`);
const gen = (name, args) => { const f = `${tmp}/${name}`; execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return f; };
const files = {
  A: gen('parity-a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15']),
  B: gen('parity-b.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6,hue=h=140,negate', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15']),
  I: gen('parity-i.png', ['-f', 'lavfi', '-i', 'testsrc=s=640x480:d=1', '-frames:v', '1']),
};
const ids = {};
for (const [k, f] of Object.entries(files)) ids[k] = (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id;
fs.rmSync(tmp, { recursive: true });

const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 60000 });
const opt = await ev(() => REMOTE.options());

// scenarios: [name, setup code run in the page with A, B, I (media ids) and main/ov/text helpers; it sets T, the time to look at]
const S0 = [];
const add = (name, code) => S0.push([name, code]);
add('plain', 'main(A); T = 1.5');
add('speed 2x', 'main(A).speed = 2; T = 1.2');
add('speed 0.5x', 'main(A).speed = 0.5; T = 3.1');
add('trimmed in', 'Object.assign(main(A), { in: 2.2 }); T = 0.7');
for (const l of opt.looks) add(`look ${l}`, `main(A).look = { name: '${l}', amount: 1 }; T = 1.5`);
add('look at 50%', `main(A).look = { name: 'teal', amount: 0.5 }; T = 1.5`);
for (const [k, a] of Object.entries({ 'b/c/s': { b: 1.25, c: 1.3, s: 0.4 }, 'temp/tint': { b: 1, c: 1, s: 1, temp: 0.6, tint: -0.4 }, 'exposure/hi/sh': { b: 1, c: 1, s: 1, ex: 0.8, hi: -0.6, sh: 0.6 }, 'fade/vignette': { b: 1, c: 1, s: 1, fade: 0.5, vig: 0.8 } }))
  add(`adjust ${k}`, `main(A).adj = ${JSON.stringify(a)}; T = 1.5`);
add('crop', 'main(A).crop = { l: 0.1, r: 0.2, t: 0.1, b: 0.05 }; T = 1.5');
add('flip', 'main(A).flip = true; T = 1.5');
add('scale/move/rotate', 'Object.assign(main(A), { scale: 0.6, x: 0.2, y: -0.1, rot: 20 }); T = 1.5');
add('opacity', 'main(A).opacity = 0.5; T = 1.5');
add('fade in, half way', 'main(A).fadeIn = 1; T = 0.5');
add('image on main', 'main(I); T = 1');
add('fit in 9:16', 'ratio("9:16"); main(A); T = 1.5');
add('fill in 9:16', 'ratio("9:16"); main(A).fit = "fill"; T = 1.5');
add('blur bg in 9:16', 'ratio("9:16"); main(A).fit = "blur"; T = 1.5');
add('keyframes, half way', 'const c = main(A); c.kf = [{ t: 0, scale: 1, x: 0, y: 0, opacity: 1, rot: 0 }, { t: 2, scale: 1.8, x: 0.3, y: 0.2, opacity: 0.6, rot: 30 }]; T = 1');
add('overlay picture-in-picture', 'main(A); Object.assign(ov(B), { scale: 0.45, x: 0.22, y: -0.2, rot: 12, opacity: 0.8 }); T = 1.5');
add('overlay image', 'main(A); Object.assign(ov(I), { fit: "fit", scale: 0.5, x: -0.2 }); T = 1.5');
for (const bl of opt.blends) add(`blend ${bl}`, `main(A); ov(B).blend = '${bl}'; T = 1.5`);
for (const mk of opt.masks.filter(x => x !== 'none')) add(`mask ${mk}`, `main(B); ov(A).mask = { type: '${mk}', x: 0.1, y: -0.05, w: 0.5, h: 0.4, rot: 15, feather: 0.2, invert: false }; T = 1.5`);
add('mask inverted', `main(B); ov(A).mask = { type: 'circle', x: 0, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0, invert: true }; T = 1.5`);
add('chroma key', `main(B); ov(A).key = { color: '#ffffff', sim: 0.25, blend: 0.1 }; T = 1.5`);
for (const tr of opt.transitions) add(`transition ${tr}`, `main(A).tr = { type: '${tr}', d: 1 }; main(B); packMain(); T = P.main[1].start + 0.3`); // 30 %: at 50 % Zoom has zoomed into one pixel
for (const fx of Object.keys(opt.effects)) add(`effect ${fx}`, `main(A); P.fx.push({ id: hex12(), fx: '${fx}', start: 0, dur: 4, amt: 1 }); T = 1.5`);
for (const tp of opt.textPresets) add(`text ${tp}`, `main(A); text('${tp}'); T = 1.5`);
for (const an of opt.clipIn.filter(x => x !== 'none')) add(`clip in ${an}`, `main(B); ov(A).anim = { in: '${an}', ind: 1, out: 'none', outd: 0.5, loop: 'none', amt: 1 }; T = 0.5`);
for (const lp of opt.comboMotion.filter(x => x !== 'none')) add(`motion ${lp}`, `main(B); Object.assign(ov(A), { scale: 0.6 }).anim = { in: 'none', out: 'none', ind: 0.5, outd: 0.5, loop: '${lp}', amt: 1 }; T = 1.7`);
const SC = S0.filter(([n]) => !only || n.includes(only));

const shoot = (code) => ev(async ([code, ids]) => {
  const { A, B, I } = ids;
  setProject(newProject('16:9')); P.name = 'Parity (scratch)'; S.sel = null; S.multi.clear();
  const ratio = r => { setProject(newProject(r)); P.name = 'Parity (scratch)'; };
  const main = id => { addMedia(id, 'main'); return P.main.at(-1); };
  const ov = id => { addMedia(id, 'overlay', 0); const c = P.overlay.at(-1); c.start = 0; return c; };
  const text = name => { S.t = 0; addText(name, { text: 'Parity 123' }); };
  let T = 0;
  eval(code); // eslint-disable-line no-eval
  S.sel = null; renderAll();
  const ex = await REMOTE.snapshot({ t: T, max: 640 }), pv = await REMOTE.snapshot({ t: T, max: 640, preview: true });
  const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
  const [a, b] = [await px(ex.image), await px(pv.image)];
  let sum = 0, worst = 0, csum = 0, cworst = 0; // fine: |a-b| per pixel; coarse: |mean a - mean b| per block (grain averages out)
  for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) {
    let s = 0; const ds = [0, 0, 0];
    for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 160 + x) * 4 + k; s += Math.abs(a[i] - b[i]); ds[k] += a[i] - b[i]; }
    sum += s; worst = Math.max(worst, s / 300);
    const cd = (Math.abs(ds[0]) + Math.abs(ds[1]) + Math.abs(ds[2])) / 300; csum += cd; cworst = Math.max(cworst, cd);
  }
  const pid = P.id;
  return { mean: sum / (160 * 90 * 3), worst, cmean: csum / 144, cworst, t: ex.t, ex: ex.image, pv: pv.image, pid };
}, [code, ids]);

const res = [], pids = [];
for (const [name, code] of SC) {
  let r;
  try { r = await shoot(code); } catch (e) { console.log(`ERR  ${name}: ${String(e.message).split('\n')[0]}`); res.push(false); continue; }
  pids.push(r.pid);
  const noisy = NOISY.test(name), [mn, wb] = noisy ? [r.cmean, r.cworst] : [r.mean, r.worst];
  const approx = APPROX.test(name), ok = mn <= (approx ? 2.5 : 1) * MEAN && wb <= (approx ? 2.5 : 1) * BLOCK;
  res.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} mean ${mn.toFixed(2).padStart(5)}  worst block ${wb.toFixed(1).padStart(5)}  @${r.t}s${noisy ? '  (random grain: block averages)' : approx ? '  (approximate in the WebKit preview)' : ''}`);
  if (!ok || process.env.SAVE) { const f = `${OUT}${name.replace(/[^a-z0-9]+/gi, '_')}`; fs.writeFileSync(`${f}_export.png`, Buffer.from(r.ex, 'base64')); fs.writeFileSync(`${f}_preview.png`, Buffer.from(r.pv, 'base64')); }
}
if (errs.length) console.log('page errors:', errs.slice(0, 5));
for (const pid of new Set(pids)) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
for (const id of Object.values(ids)) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} match (mean <= ${MEAN}, worst block <= ${BLOCK} levels; approximations x2.5)${res.includes(false) ? `; side-by-sides in ${OUT}` : ''}`);
process.exit(res.includes(false) ? 1 : 0);
