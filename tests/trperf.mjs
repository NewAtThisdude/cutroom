// Cost of the per-pixel transitions in the preview (dissolve, pixelize, hblur, radial, fadegrays; fade = the cheap
// baseline): ms per transition frame paused (transition() alone and the whole paint, synced with the GPU process), and
// frames drawn per second playing a 60 fps edit through a 4 s transition; each type on
// the GPU path (web/grade.js trGPU) and on the JS one (GPU.trOff), whose pictures must agree. LOAD=n adds n busy loops.
// Numbers are wall clock on a shared Mac: run twice and compare, the load average is printed with them.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node trperf.mjs [types]
import { webkit } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const TYPES = (process.argv[2] || 'fade,dissolve,pixelize,hblur,radial,fadegrays').split(',');
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-trperf-`), ids = [];
for (const [n, vf] of [['tr-a', ''], ['tr-b', ',hue=h=140']]) {
  const f = `${tmp}/${n}.mp4`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=60:d=10${vf}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '60', f]);
  ids.push((await (await fetch(`${B}/api/import?name=${n}.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id);
}
fs.rmSync(tmp, { recursive: true });
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, deviceScaleFactor: 2 })).newPage();
await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (fn, a) => page.evaluate(fn, a);
await ev(() => loadMedia());
await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), ids, { timeout: 120000 });
const pid = await ev(([a, b]) => { setProject(newProject('16:9')); P.name = 'Transition perf (scratch)'; P.fps = 60; addMedia(a, 'main'); addMedia(b, 'main'); S.sel = null; renderAll(); return P.id; }, ids);
const size = await ev(() => `${$('#cv').width}x${$('#cv').height}`);
const load = n => [...Array(n)].map(() => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
const med = a => a.reduce((s, x) => s + x, 0) / a.length; // a mean: WebKit's clock ticks in whole ms
console.log(`(means of 25 paused frames, wall clock; noisy under load: run twice)\npreview canvas ${size}, ${os.cpus().length} cores, load average ${os.loadavg()[0].toFixed(1)}${process.env.LOAD ? `, +${process.env.LOAD} busy loops while playing` : ''}`);
const run = async (type, js) => {
  const r = await ev(async ([type, js]) => {
    GPU.trOff = js; P.main[0].tr = { type, d: 4 }; packMain(); S.sel = null; renderAll();
    const t0 = P.main[1].start, cv = $('#cv'), cx = cv.getContext('2d');
    S.t = t0 + 1.2; await waitFrame(); // paused at 30 %
    const sync = () => cx.getImageData(0, 0, 1, 1); // waits for the GPU process to finish the frame
    const tr = [], pt = [], ot = transition, og = trGPU;
    let gpu = 0;
    transition = (...a) => { const s = performance.now(); ot(...a); sync(); tr.push(performance.now() - s); };
    trGPU = (...a) => { const s = performance.now(), r = og(...a); sync(); if (r) { gpu++; tr.push(performance.now() - s); } return r; };
    for (let i = 0; i < 25; i++) { const s = performance.now(); paint(); sync(); pt.push(performance.now() - s); }
    transition = ot; trGPU = og;
    return { tr, pt, t0, gpu: gpu && !js, px: Array.from(cx.getImageData(0, 0, cv.width, cv.height).data.filter((_, i) => i % 4 !== 3)) };
  }, [type, js]);
  const L = process.env.LOAD ? load(+process.env.LOAD) : [];
  const fps = await ev(async t0 => { // play from 0.5 s before the cut to 0.5 s past the transition; count what paint() draws inside it
    S.t = t0 - 0.5; await waitFrame();
    let n = 0, worst = 0, last = 0; const op = paint;
    paint = () => { op(); if (S.playing && S.t > t0 + 0.2 && S.t < t0 + 3.8) { const now = performance.now(); if (last) worst = Math.max(worst, now - last); last = now; n++; } };
    play();
    await sleep(5000);
    pause(); paint = op;
    return { fps: n / 3.6, worst };
  }, r.t0);
  L.forEach(p => p.kill());
  console.log(`${type.padEnd(10)} ${r.gpu ? 'GPU' : 'JS '}  transition ${med(r.tr).toFixed(1).padStart(5)} ms (max ${Math.max(...r.tr).toFixed(1).padStart(4)})  whole paint ${med(r.pt).toFixed(1).padStart(5)} ms  playing ${fps.fps.toFixed(1)} fps (worst gap ${fps.worst.toFixed(0)} ms)`);
  return r;
};
let bad = 0;
for (const type of TYPES) {
  const G = await run(type, false), j = (await run(type, true)).px, g = G.px;
  let sum = 0, big = 0;
  for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - j[i]); sum += d; if (d > 2) big++; }
  const mean = sum / g.length, ok = (type === 'fade' || G.gpu) && mean < 2; // a flipped, shifted or black frame is 30+; what is left is the picture's
  // own scaling (2D drawImage vs the texture's bilinear): video_parity found the GPU path a little closer to the export
  if (!ok) bad++;
  console.log(`${''.padEnd(10)} GPU vs JS: mean ${mean.toFixed(2)} levels, ${(100 * big / g.length).toFixed(2)} % of values off by more than 2${ok ? '' : '  FAIL'}`);
}
if (errs.length) console.log('page errors:', errs.slice(0, 5));
await b.close();
await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const id of ids) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' });
process.exit(bad ? 1 : 0);
