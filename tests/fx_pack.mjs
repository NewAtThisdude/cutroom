// The effects pack (web/fxpack.js, its FX entries in web/draw.js): every new transition, video effect and film look.
//  0. the compiled expressions alone: one 480x270 picture (two for transitions) through the GPU shader and through
//     ffmpeg's geq: they must agree to the level (mean < 1, under 1 % of values more than 2 apart: float32 vs double
//     truncating a value just under a whole level). Then the export's own worker where there is no Metal, tools/fxexpr.py, on
//     every backend this computer has (NumPy; CUDA too where PyTorch sees a GPU), against the same preview pixels and limits,
//     and its lets-in-branches / window / stacking / alpha handling against geq. GET /api/fx/backend names the export's backend.
//  1. preview == export: the preview canvas vs the export renderer (/api/still_frame) on the same frame, both shrunk to
//     320x180: mean |difference| and the worst 10x10 block, in 0-255 levels. Transitions at 25 / 50 / 75 %, effects at two
//     moments, looks on sharp synthetic footage and on real iPhone footage (HLG, when the scratchpad has it).
//  2. playback at 1080p60: frames painted per second playing through each new transition and effect (pass: the median of
//     3 plays in a fresh page >= 55 fps), beside what was there before (cut, dissolve, whip, shake, RGB split, B&W), with
//     one paused frame's synced paint time. Wall clock on a shared Mac: the load average is printed with them.
//  3. gallery tiles, in both motion modes: every new tile drawn (not blank, not just one scene), hovered tiles animate,
//     the film-look tiles show the selected clip's own frame through their table.
//  4. what the export pays: seconds for a 1080p30 export with the heaviest new transitions / effects vs a dissolve.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node fx_pack.mjs [exact|parity|perf|tiles|export ...]   (never 4610)
// The HLG footage: $CUTROOM_SCRATCH/photos/IMG_0324.MOV (a real iPhone clip) when there, else a synthetic 4K60 HLG HEVC
// clip with a camera's detail: the test pattern drawn at 1920x1080 and scaled to 4K (detail above the preview's 720p
// proxy, without the per-pixel random colour of a pattern drawn at 4K, which no camera records); else a SKIP line.
// It found the HDR export's VideoToolbox shrink aliasing (server.py gpu_size: at most half size on the GPU now).
import { browser } from './browser.mjs';
import { cachedMedia } from './fixtures.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['exact', 'parity', 'perf', 'tiles', 'export'];
if (!B || /:4610\b/.test(B)) throw new Error('set B to a scratch server (never 4610)');
const PHONE = `${process.env.CUTROOM_SCRATCH || os.tmpdir()}/photos/IMG_0324.MOV`;
const hlgStandIn = () => {
  try {
    return cachedMedia('fxpack-hlg-4k60-1080up-v1.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=5', '-vf', 'scale=3840:2160:flags=bicubic,format=p010le,'
      + 'setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc', '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '22',
      '-x265-params', 'pools=4:frame-threads=2:log-level=error', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1']);
  } catch (e) { console.log(`SKIP film looks on HLG footage: no iPhone clip, and libx265 could not make the stand-in (${String(e.stderr || e.message).trim().slice(-200)})`); return null; }
};
const REAL = parts.includes('parity') ? (fs.existsSync(PHONE) ? PHONE : hlgStandIn()) : null; // read-only: uploaded as a copy
if (REAL) console.log(`HLG footage: ${REAL}`);
const OUT = fileURLToPath(new URL('./out/fx_pack/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const NEW_TR = ['blurfade', 'whipup', 'whipdown', 'flashwhite', 'flashblack', 'lightleak', 'filmburn', 'cube', 'flip', 'punchin', 'zoomout', 'spin', 'glitchcut', 'rgbsplit',
  'lumafade', 'stretch', 'ink', 'heart', 'star', 'diamond', 'pagecurl', 'wave', 'tiles'];
const NEW_FX = ['handheld', 'beatshake', 'leaks', 'flare', 'edges', 'dust', 'halftone', 'posterize', 'oldtv', 'nightvision', 'thermal', 'chroma', 'kaleido', 'tunnel', 'datamosh'];
// documented approximations (x2.5 the limits): camera moves (sub-pixel offsets a pixel apart),
// detail in whole pixels at the export size drawn at the preview's size (dots, scan lines, edge taps). NOISY: random grain, by block averages
const APPROX = /^fx (handheld|beatshake|halftone|edges|oldtv|nightvision|kaleido|posterize)/, NOISY = /^fx (oldtv|nightvision|halftone)/; // (halftone's dots shrunk to 320 px make moiré: block averages too)
const MEAN = 4, BLOCK = 28;
const res = [], check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); };

const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-fxpack-`), ids = {};
for (const [k, vf] of [['A', ''], ['B', ',hue=h=140,negate']]) {
  const f = `${tmp}/fxpack-${k}.mp4`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=60:d=8${vf}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', f]);
  ids[k] = (await (await fetch(`${B}/api/import?name=fxpack-${k}.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id;
}
fs.rmSync(tmp, { recursive: true });
if (REAL) ids.R = (await (await fetch(`${B}/api/import?name=fxpack-real.mov`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(REAL) })).json()).id;

const b = await browser.launch(), pids = new Set();
const open = async (rm = 'no-preference', scale = 1) => {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, deviceScaleFactor: scale, reducedMotion: rm })).newPage();
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // not an MCP target
  page.errs = []; page.on('pageerror', e => page.errs.push(e.message)); page.on('console', m => { if (m.type() === 'warning' && /GPU|effect|transition/i.test(m.text())) page.errs.push(m.text()); });
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  await page.evaluate(() => loadMedia());
  await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 300000 });
  return page;
};
// a scene from data, built in the page: { tr, p } | { fx, t } | { look, media, amount }; returns the time to look at
const build = `(ids, c) => {
  setProject(newProject('16:9')); P.name = 'Effects pack (scratch)'; S.sel = null; S.multi.clear();
  const main = id => { addMedia(id, 'main'); return P.main.at(-1); };
  let T;
  if (c.tr) { main(ids.A).tr = { type: c.tr, d: 1 }; main(ids.B); packMain(); T = P.main[1].start + c.p - 0.5 / P.fps; }
  else if (c.fx) { main(ids.A); P.fx.push({ id: hex12(), fx: c.fx, start: 0, dur: 4, amt: 1 }); T = c.t; }
  else if (c.adj) { main(ids.A); P.fx.push({ id: hex12(), fx: 'adjust', start: 0, dur: 4, amt: 1, look: { name: c.adj, amount: 1 } }); T = 1.5; } // a film look on an adjustment layer (no grade object)
  else { main(ids[c.media]).look = { name: c.look, amount: c.amount }; T = c.media === 'R' ? 3 : 1.5; }
  if (c.fps) P.fps = c.fps;
  if (c.len) P.main.forEach(x => { x.out = x.in + c.len; });
  packMain(); S.sel = null; renderAll();
  return T;
}`;

if (parts.includes('parity')) {
  const page = await open();
  await page.addScriptTag({ content: `window.buildScene = ${build};` });
  const cases = [];
  for (const tr of NEW_TR) for (const p of [0.25, 0.5, 0.75]) cases.push([`tr ${tr} at ${p * 100}%`, { tr, p }]);
  for (const fx of NEW_FX) for (const t of [0.5, 1.7]) cases.push([`fx ${fx} at ${t}s`, { fx, t }]);
  for (const look of await page.evaluate(() => Object.keys(LOOK_LUT))) {
    cases.push([`look ${look}`, { look, media: 'A', amount: 1 }]);
    if (['tealorange', 'bleach'].includes(look)) cases.push([`look ${look} on an adjustment layer`, { adj: look }]);
    if (ids.R) cases.push([`look ${look} (iPhone HLG)`, { look, media: 'R', amount: 0.8 }]);
  }
  console.log(`-- preview vs export: ${cases.length} frames (320x180, 10x10 blocks)`);
  for (const [name, c] of cases) {
    let r;
    try {
      r = await page.evaluate(async ([ids, c]) => {
        const T = buildScene(ids, c);
        const ex = await REMOTE.snapshot({ t: T, max: 960 }), pv = await REMOTE.snapshot({ t: T, max: 960, preview: true });
        const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const cv = new OffscreenCanvas(320, 180), g = cv.getContext('2d'); g.drawImage(im, 0, 0, 320, 180); return g.getImageData(0, 0, 320, 180).data; };
        const [a, b] = [await px(ex.image), await px(pv.image)];
        let sum = 0, worst = 0, csum = 0, cworst = 0;
        for (let by = 0; by < 180; by += 10) for (let bx = 0; bx < 320; bx += 10) {
          let s = 0; const ds = [0, 0, 0];
          for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 320 + x) * 4 + k; s += Math.abs(a[i] - b[i]); ds[k] += a[i] - b[i]; }
          sum += s; worst = Math.max(worst, s / 300);
          const cd = (Math.abs(ds[0]) + Math.abs(ds[1]) + Math.abs(ds[2])) / 300; csum += cd; cworst = Math.max(cworst, cd);
        }
        return { mean: sum / (320 * 180 * 3), worst, cmean: csum / 576, cworst, ex: ex.image, pv: pv.image, pid: P.id };
      }, [ids, c]);
    } catch (e) { check(name, false, String(e.message).split('\n')[0].slice(0, 200)); continue; }
    pids.add(r.pid);
    const noisy = NOISY.test(name), ap = APPROX.test(name), [mn, wb] = noisy ? [r.cmean, r.cworst] : [r.mean, r.worst], k = ap ? 2.5 : 1, ok = mn <= MEAN * k && wb <= BLOCK * k;
    check(name.padEnd(34), ok, `mean ${mn.toFixed(2).padStart(5)}  worst block ${wb.toFixed(1).padStart(5)}${noisy ? '  (grain: block averages)' : ap ? '  (approximation)' : ''}`);
    if (!ok || process.env.SAVE) { const f = `${OUT}${name.replace(/[^a-z0-9]+/gi, '_')}`; fs.writeFileSync(`${f}_export.png`, Buffer.from(r.ex, 'base64')); fs.writeFileSync(`${f}_preview.png`, Buffer.from(r.pv, 'base64')); }
  }
  check('parity: no page errors or GPU warnings', !page.errs.length, page.errs.slice(0, 3).join(' | '));
  const fb = await (await fetch(`${B}/api/fx/backend`, { headers: H })).json(); // which tool made those export frames, and that none fell back
  check(`parity: export expressions on ${fb.backend}, none fell back to geq`, fb.backend === 'geq' || (Object.entries(fb.used).some(([k, n]) => k !== 'fallback' && n > 0) && !fb.used.fallback), `stages run: ${JSON.stringify(fb.used)}`);
  await page.context().close();
}

if (parts.includes('exact')) { // the compiled expressions alone: the same input pictures through the GPU (preview) and through ffmpeg (export)
  const D = fs.mkdtempSync(`${os.tmpdir()}/cutroom-fxexact-`), Wd = 480, Ht = 270;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${Wd}x${Ht}`, '-frames:v', '1', `${D}/a.png`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${Wd}x${Ht},hue=h=140,negate`, '-frames:v', '1', `${D}/b.png`]);
  const page = await open();
  const got = await page.evaluate(async ([a64, b64, NEW_TR, Wd, Ht]) => {
    const load = async s => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()); const c = document.createElement('canvas'); c.width = Wd; c.height = Ht; c.getContext('2d').drawImage(im, 0, 0); return c; };
    const A = await load(a64), Bc = await load(b64), out = {}, C = document.createElement('canvas'); C.width = Wd; C.height = Ht;
    const x = C.getContext('2d', { willReadFrequently: true }), raw = () => { const d = x.getImageData(0, 0, Wd, Ht).data.filter((_, i) => i % 4 !== 3); let t = ''; for (let i = 0; i < d.length; i += 0x8000) t += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000)); return btoa(t); }; // (base64: 71 plain arrays ran node out of memory)
    P.bg = '#000000';
    for (const k of NEW_TR.filter(k => TRX[k])) for (const p of [0.3, 0.5, 0.7]) { transition(x, A, Bc, k, p); out[`tr ${k} ${p}`] = { px: raw(), e: trxFF(k, '#000000') }; }
    for (const k of Object.keys(EXF)) { x.drawImage(A, 0, 0); runOps(x, Wd, Ht, [{ op: 'expr', k, amt: 1, n: 7 }]); out[`fx ${k}`] = { px: raw(), e: fxGeq(k, 1) }; }
    return out;
  }, [fs.readFileSync(`${D}/a.png`).toString('base64'), fs.readFileSync(`${D}/b.png`).toString('base64'), NEW_TR, Wd, Ht]);
  console.log(`-- compiled expressions, GPU vs ffmpeg on the same ${Wd}x${Ht} pictures (mean levels, % of values more than 2 apart)`);
  for (const [name, g] of Object.entries(got)) {
    const [, k, p] = name.split(' ');
    g.px = Buffer.from(g.px, 'base64');
    let graph, ins = ['-i', `${D}/a.png`];
    if (name.startsWith('tr')) { // 10 frames of a over b through geq, as the export does: frame i has p = i/10
      ins = ['-loop', '1', '-r', '10', '-t', '2', '-i', `${D}/a.png`, '-loop', '1', '-r', '10', '-t', '2', '-i', `${D}/b.png`];
      graph = `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]vstack,geq=interpolation=nearest:${['r', 'g', 'b'].map(c => `${c}='${g.e[`e${c}`].replace(/\bTO\b/g, '10')}'`).join(':')},crop=${Wd}:${Ht}:0:0,select='eq(n,${Math.round(+p * 10)})',format=rgb24[o]`;
    } else graph = `[0:v]format=gbrp,geq=interpolation=nearest:${['r', 'g', 'b'].map(c => `${c}='${g.e[`e${c}`].replace(/\bLF\b/g, '(N+7)')}'`).join(':')},format=rgb24[o]`;
    fs.writeFileSync(`${D}/g.txt`, graph);
    const f = execFileSync('ffmpeg', ['-v', 'error', ...ins, '-/filter_complex', `${D}/g.txt`, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-']);
    let sum = 0, big = 0;
    for (let i = 0; i < f.length; i++) { const d = Math.abs(f[i] - g.px[i]); sum += d; if (d > 2) big++; }
    const mean = sum / f.length, pct = (100 * big) / f.length;
    check(name.padEnd(24), f.length === g.px.length && mean < 1 && pct < 1, `mean ${mean.toFixed(3)}  ${pct.toFixed(2)} % off by more than 2`);
  }
  // The export's own expression worker (tools/fxexpr.py: NumPy, and CUDA where PyTorch sees a GPU; a Mac exports on Metal) on the
  // same pictures, every backend this computer has, against the same preview pixels and limits; then what geq and Metal leave
  // to it alone: st() inside branches only some pixels take, frames outside an effect's window, two effects on one frame, alpha.
  const fxb = await (await fetch(`${B}/api/fx/backend`, { headers: H })).json();
  console.log(`-- export expressions here: ${fxb.backend}; tools/fxexpr.py: ${fxb.worker ? `${fxb.worker.backend} (${fxb.worker.command.join(' ')})` : 'no Python with NumPy'}`);
  if (!fxb.worker) console.log('SKIP tools/fxexpr.py: no Python with NumPy on this computer (exports use Metal or geq)');
  const gbrp = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-pix_fmt', 'gbrp', '-f', 'rawvideo', '-']);
  const [Ap, Bp] = [gbrp(`${D}/a.png`), gbrp(`${D}/b.png`)], PL = Wd * Ht;
  const worker = (be, w, h, planes, exprs, wins, input) => { // -> [output frames, seconds, its own last line]
    fs.writeFileSync(`${D}/w.json`, JSON.stringify(exprs));
    const t = Date.now(), [py, ...args] = fxb.worker.command;
    const r = spawnSync(py, [...args, String(w), String(h), String(planes), `${D}/w.json`, wins.map(x => x.join(',')).join(';')],
      { input, env: { ...process.env, CUTROOM_FX_BACKEND: be }, maxBuffer: 1 << 30 });
    if (r.status) throw new Error(`fxexpr ${be} exit ${r.status}: ${String(r.stderr).slice(-300)}`);
    return [r.stdout, (Date.now() - t) / 1000, String(r.stderr).trim().split(/\r?\n/).at(-1)];
  };
  const rgbOf = (buf, off, n, st) => { const o = Buffer.alloc(n * 3); for (let i = 0; i < n; i++) { o[3 * i] = buf[off + 2 * st + i]; o[3 * i + 1] = buf[off + i]; o[3 * i + 2] = buf[off + st + i]; } return o; }; // gbrp (planes st apart) -> rgb24, the first n pixels
  const diff = (a, b) => { let sum = 0, big = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > 2) big++; } return [sum / a.length, (100 * big) / a.length]; };
  for (const be of !fxb.worker ? [] : fxb.worker.backend === 'cuda' ? ['numpy', 'cuda'] : ['numpy']) {
    try {
      const trs = Object.entries(got).filter(([n]) => n.startsWith('tr')), fxs = Object.entries(got).filter(([n]) => n.startsWith('fx'));
      // transitions: 10 stacked frames each (a over b, H doubled), frame i at p = i/10; effects: 8 frames each, LF = 7 on the last
      const stk = Buffer.concat([0, 1, 2].flatMap(p => [Ap.subarray(p * PL, (p + 1) * PL), Bp.subarray(p * PL, (p + 1) * PL)]));
      const kinds = [...new Map(trs.map(([n, g]) => [n.split(' ')[1], g.e])).entries()];
      const [to, ts, tl] = worker(be, Wd, 2 * Ht, 3, kinds.map(([, e]) => ['r', 'g', 'b'].map(c => e[`e${c}`].replace(/\bTO\b/g, '10'))), kinds.map((_, k) => [10 * k, 10 * k + 10]), Buffer.concat(Array(10 * kinds.length).fill(stk)));
      const [fo, fsec, fl] = worker(be, Wd, Ht, 3, fxs.map(([, g]) => ['r', 'g', 'b'].map(c => g.e[`e${c}`])), fxs.map((_, k) => [8 * k, 8 * k + 8]), Buffer.concat(Array(8 * fxs.length).fill(Ap)));
      let wm = 0, wp = 0, bad = 0;
      const one = (name, px, g) => { const [m, pct] = diff(px, g.px); wm = Math.max(wm, m); wp = Math.max(wp, pct); if (!(m < 1 && pct < 1)) { bad++; check(`fxexpr ${be} ${name}`, false, `mean ${m.toFixed(3)}  ${pct.toFixed(2)} % off by more than 2`); } };
      trs.forEach(([name, g]) => { const [, k, pr] = name.split(' '); one(name, rgbOf(to, (10 * kinds.findIndex(x => x[0] === k) + Math.round(+pr * 10)) * 6 * PL, PL, 2 * PL), g); }); // (the top half: the crop the export makes)
      fxs.forEach(([name, g], k) => one(name, rgbOf(fo, (8 * k + 7) * 3 * PL, PL, PL), g));
      check(`fxexpr ${be}: ${kinds.length} transitions x3 + ${fxs.length} effects == preview`, !bad, `worst mean ${wm.toFixed(3)}, ${wp.toFixed(2)} % off by more than 2; transitions ${ts.toFixed(1)} s, effects ${fsec.toFixed(1)} s (${tl} | ${fl})`);
      // its own semantics against geq: lets set inside branches, a frame outside the window, two effects stacked on one frame, alpha
      const sem = [['r(X,Y)*0+if(lt(X,W/2),st(0,r(W-1-X,Y)),st(0,b(X,Y)*0.5));if(gt(Y,H/2),st(1,ld(0)+40),st(1,255-ld(0)));ld(1)', 'if(lt(mod(X,64),32),g(X,Y),255-g(X,Y))', 'ifnot(between(Y,50,120),b(X,Y),st(2,X);ld(2))'],
        ['255-r(X,Y)', 'g(X*0.5,Y*0.5)', 'b(W-1-X,H-1-Y)']].map(e => e.map(x => `clip(${x},0,255)`)); // (clipped as the pack's are: geq stores 256 as 0)
      const ref = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gbrp', '-s', `${Wd}x${Ht}`, '-i', '-', '-vf', sem.map(e => `geq=interpolation=nearest:${['r', 'g', 'b'].map((c, i) => `${c}='${e[i]}'`).join(':')}`).join(','), '-f', 'rawvideo', '-pix_fmt', 'gbrp', '-'], { input: Ap });
      const Aa = Buffer.concat([Ap, Buffer.alloc(PL, 77)]); // gbrap: alpha 77
      const [so] = worker(be, Wd, Ht, 4, sem, [[1, 2], [1, 2]], Buffer.concat([Aa, Aa, Aa]));
      const [m1, p1] = diff(so.subarray(4 * PL, 7 * PL), ref), same0 = so.subarray(0, 4 * PL).equals(Aa) && so.subarray(8 * PL).equals(Aa), alpha = so.subarray(7 * PL, 8 * PL).every(v => v === 77);
      check(`fxexpr ${be}: lets in branches, windows, stacked, alpha`, m1 < 1 && p1 < 1 && same0 && alpha, `vs geq mean ${m1.toFixed(3)}, ${p1.toFixed(2)} % off by more than 2; frames outside the window untouched ${same0}; alpha kept ${alpha}`);
    } catch (e) { check(`fxexpr ${be}`, false, String(e.message).split('\n')[0].slice(0, 300)); }
  }
  fs.rmSync(D, { recursive: true });
  await page.context().close();
}

if (parts.includes('perf')) { // like trperf.mjs: a 60 fps edit, the preview at 2x (Retina), frames painted per second inside the 4 s window
  // Each item gets its own page: after a canvas-path blur transition (whip left, already in main, and the new blur ones) has played,
  // every later canvas-drawn effect in that page runs ~47 fps until a reload (plain playback stays 60; cause not found, in WebKit).
  // Three plays per page; the MEDIAN is the item's rate (a blur transition plays 60 once, then ~47), one fresh page more if short.
  const fresh = async () => {
    const page = await open('no-preference', 2);
    pids.add(await page.evaluate(([A, Bm]) => { setProject(newProject('16:9')); P.name = 'Effects pack perf (scratch)'; P.fps = 60; addMedia(A, 'main'); addMedia(Bm, 'main'); S.sel = null; renderAll(); return P.id; }, [ids.A, ids.B]));
    return page;
  };
  const play = (page, kind, k) => page.evaluate(async ([kind, k]) => {
    P.fx = []; delete P.main[0].tr;
    if (kind === 'tr' && k !== 'cut') P.main[0].tr = { type: k, d: 4 };
    packMain();
    const t0 = kind === 'tr' ? P.main[1].start : 1;
    if (kind === 'fx') P.fx.push({ id: hex12(), fx: k, start: t0, dur: 4, amt: 1 });
    S.sel = null; renderAll();
    S.t = t0 + 1.2; await waitFrame(); paint(); // (compiles its program before the clock starts)
    const cx = $('#cv').getContext('2d'), ms = [];
    for (let i = 0; i < 15; i++) { const s = performance.now(); paint(); cx.getImageData(0, 0, 1, 1); ms.push(performance.now() - s); } // synced: waits for the GPU's part too
    ms.sort((a, b) => a - b);
    S.t = t0 - 0.5; await waitFrame();
    let n = 0, worst = 0, last = 0, gpu = 0; const op = paint, og = trGPU;
    trGPU = (...a) => { const r = og(...a); if (r) gpu++; return r; };
    paint = () => { op(); if (S.playing && S.t > t0 + 0.2 && S.t < t0 + 3.8) { const now = performance.now(); if (last) worst = Math.max(worst, now - last); last = now; n++; } };
    play(); await sleep(5000); pause();
    paint = op; trGPU = og;
    return { fps: n / 3.6, worst, gpu, ms: ms[7], size: `${$('#cv').width}x${$('#cv').height}` };
  }, [kind, k]);
  const item = async (kind, k) => {
    const page = await fresh(), rs = [];
    for (let i = 0; i < 3; i++) rs.push(await play(page, kind, k));
    if (page.errs.length) errs.push(...page.errs);
    await page.context().close();
    rs.sort((a, b) => a.fps - b.fps);
    return { ...rs[1], all: rs.map(r => r.fps.toFixed(0)).join('/') };
  };
  const errs = [];
  console.log(`-- playback, 1080p60 sources, preview at 2x, ${os.cpus().length} cores, load average ${os.loadavg()[0].toFixed(1)}; pass = median of 3 plays >= 55 fps`);
  const BASE = ['tr cut', 'tr fade', 'tr dissolve', 'tr whipleft', 'fx shake', 'fx rgb', 'fx bw']; // what was there before: the same paths under the same load
  for (const [kind, k] of [...BASE.map(x => x.split(' ')), ...NEW_TR.map(x => ['tr', x]), ...NEW_FX.map(x => ['fx', x])].filter(([kind, k]) => !process.env.ONLY || new RegExp(process.env.ONLY).test(`${kind} ${k}`))) { // ONLY=<regex>: some of them
    let r = await item(kind, k);
    if (r.fps < 55) r = await item(kind, k); // a busy moment on a shared Mac: one fresh page more
    const base = BASE.includes(`${kind} ${k}`);
    check(`${kind} ${k}`.padEnd(22), base || r.fps >= 55, `playing ${r.fps.toFixed(1)} fps (plays ${r.all}), paint ${r.ms.toFixed(1)} ms, worst gap ${r.worst.toFixed(0)} ms, canvas ${r.size}${kind === 'tr' && !base ? (r.gpu ? ', GPU' : ', canvas path') : ''}${base ? `  (baseline${r.fps < 55 ? ', < 55' : ''})` : ''}`);
  }
  if (!process.env.ONLY) { // the page stays fast after the blur transitions (on the canvas path they left later canvas effects at ~47 fps)
    const page = await fresh(), rs = [];
    for (const [kind, k] of [['tr', 'whipleft'], ['tr', 'blurfade'], ['tr', 'whipup'], ['fx', 'dust'], ['fx', 'bw']]) rs.push([k, (await play(page, kind, k)).fps]);
    await page.context().close();
    const after = rs.slice(3);
    check('perf: dust and B&W after 3 blur transitions', after.every(([, f]) => f >= 55), rs.map(([k, f]) => `${k} ${f.toFixed(0)}`).join(', '));
  }
  check('perf: no page errors or GPU warnings', !errs.length, errs.slice(0, 3).join(' | '));
}

if (parts.includes('tiles')) {
  for (const rm of ['no-preference', 'reduce']) {
    const page = await open(rm);
    const r = await page.evaluate(async ([ids, NEW_TR, NEW_FX]) => {
      setProject(newProject('16:9')); P.name = 'Effects pack tiles (scratch)'; addMedia(ids.A, 'main'); addMedia(ids.B, 'main'); packMain();
      S.sel = { lane: 'main', id: P.main[0].id }; S.t = 1.5; renderAll(); await waitFrame();
      const sig = cv => { const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data; const s = []; for (let y = 4; y < 148; y += 12) for (let x = 4; x < 264; x += 12) { const i = (y * cv.width + x) * 4; s.push(d[i], d[i + 1], d[i + 2]); } return s; };
      const dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length, flat = s => Math.max(...s) - Math.min(...s) < 8;
      const out = { tr: [], fx: [], look: [], anim: [] }, scA = sig(sampleScene(264, 148, 0)), scB = sig(sampleScene(264, 148, 1));
      openTab('transitions'); await sleep(200);
      for (const k of NEW_TR) { const b = $(`.tile[data-trset="${k}"]`); if (!b) { out.tr.push(`${k} (missing)`); continue; } b.scrollIntoView(); drawTiles(true); const s = sig(b.firstElementChild); if (flat(s) || dist(s, scA) < 1 || dist(s, scB) < 1) out.tr.push(`${k} ${dist(s, scA).toFixed(1)}/${dist(s, scB).toFixed(1)}`); }
      openTab('effects'); await sleep(200);
      for (const k of NEW_FX) { const b = $(`.tile[data-fx="${k}"]`); if (!b) { out.fx.push(`${k} (missing)`); continue; } b.scrollIntoView(); drawTiles(true); const s = sig(b.firstElementChild); if (flat(s) || (dist(s, scA) < 0.2 && !['handheld', 'beatshake'].includes(k))) out.fx.push(`${k} ${dist(s, scA).toFixed(2)}`); } // (camera moves: onion-skinned stills)
      for (const [tab, sel, k] of [['transitions', '.tile[data-trset="pagecurl"]', 'tr'], ['effects', '.tile[data-fx="kaleido"]', 'fx']]) { // hovered: it plays
        openTab(tab); await sleep(100);
        const b = $(sel); b.scrollIntoView(); G.hover = b; drawTiles(false, 1000); const s1 = sig(b.firstElementChild); drawTiles(false, 1700); const s2 = sig(b.firstElementChild); G.hover = null;
        if (dist(s1, s2) < 1) out.anim.push(k);
      }
      openTab('filters'); await sleep(300);
      const none = sig($('.tile[data-lookset="none"]').firstElementChild), seen = [];
      for (const k of Object.keys(LOOK_LUT)) { const s = sig($(`.tile[data-lookset="${k}"]`).firstElementChild); const near = Math.min(...seen.map(x => dist(x, s))); if (dist(s, none) < 2 || near < 0.5) out.look.push(`${k} ${near.toFixed(2)}`); seen.push(s); }
      out.label = $('.tile[data-lookset="tealorange"] span').textContent;
      out.noneVsScene = dist(none, scA); // the tiles start from the clip's own frame, not the stand-in scene
      out.pid = P.id;
      return out;
    }, [ids, NEW_TR, NEW_FX]);
    pids.add(r.pid);
    await page.screenshot({ path: `${OUT}tiles_filters_${rm}.png` });
    await page.evaluate(() => openTab('transitions')); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}tiles_transitions_${rm}.png` });
    await page.evaluate(() => openTab('effects')); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}tiles_effects_${rm}.png` });
    check(`${rm}: ${NEW_TR.length} new transition tiles drawn`, !r.tr.length, r.tr.join(', '));
    check(`${rm}: ${NEW_FX.length} new effect tiles drawn`, !r.fx.length, r.fx.join(', '));
    check(`${rm}: hovered new tiles animate`, !r.anim.length, r.anim.join(', '));
    check(`${rm}: film-look tiles from the clip's own frame, each its own`, !r.look.length && r.noneVsScene > 5 && r.label === 'Teal & orange', `${r.look.join(', ')} none-vs-scene ${r.noneVsScene.toFixed(1)} label ${r.label}`);
    check(`${rm}: no page errors`, !page.errs.length, page.errs.slice(0, 3).join(' | '));
    await page.context().close();
  }
}

if (parts.includes('export')) {
  const page = await open();
  await page.addScriptTag({ content: `window.buildScene = ${build};` });
  console.log(`-- export cost, 1080p30, two 3.5 s clips with a 1 s transition, or one with a 4 s effect (load average ${os.loadavg()[0].toFixed(1)})`);
  for (const [name, c] of [['cut', { fx: 'none', t: 0 }], ['dissolve', { tr: 'fade', p: 0 }], ['pagecurl', { tr: 'pagecurl', p: 0 }], ['tiles', { tr: 'tiles', p: 0 }], ['halftone', { fx: 'halftone', t: 0 }], ['kaleido', { fx: 'kaleido', t: 0 }]]) {
    const r = await page.evaluate(async ([ids, c]) => {
      buildScene(ids, { ...c, fps: 30, len: 3.5 });
      if (c.fx === 'none') P.fx = [];
      const t0 = performance.now(), ex = await REMOTE.export({ resolution: '1080p', fps: 30, name: `fxpack-${Date.now()}` });
      return { s: (performance.now() - t0) / 1000, file: ex.file, pid: P.id };
    }, [ids, c]).catch(e => ({ err: e.message }));
    if (r.pid) pids.add(r.pid);
    check(`export ${name}`.padEnd(22), !r.err, r.err || `${r.s.toFixed(1)} s`);
  }
  await page.context().close();
}

await b.close();
for (const pid of pids) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
for (const id of Object.values(ids)) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed (mean <= ${MEAN}, worst block <= ${BLOCK} levels; approximations x2.5; playback >= 55 fps)`);
process.exit(res.includes(false) ? 1 : 0);
