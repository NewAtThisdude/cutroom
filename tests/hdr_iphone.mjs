// Real iPhone footage end to end: 4K 120 fps HLG HEVC, portrait by rotation metadata. Imports two clips by path, then checks
// the 720p proxy (upright pixels, no rotation left in the file, BT.709 labels), the WebKit copy's labels, preview == export on
// HDR frames (headless WebKit, both motion modes), a 1080x1920 60 fps export that decodes end to end, and its colours against
// VideoToolbox's own scale_vt output (read as BT.709) and AVFoundation's SDR rendering (Apple's own tone mapping, documented).
// Skips cleanly when the clips aren't there.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node hdr_iphone.mjs     (a scratch server, never 4610)
//   PHOTOS=<dir of .MOV files> overrides where the clips are read from (they are cloned, never modified)
import { browser } from './browser.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', HOME = process.env.CUTROOM_HOME || `${os.homedir()}/Movies/Cutroom`;
const DIR = process.env.PHOTOS || `${process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch'}/photos`;
const CLIPS = ['IMG_4705.MOV', 'IMG_4697.MOV'];
if (!CLIPS.every(f => fs.existsSync(`${DIR}/${f}`))) { console.log(`SKIP: iPhone clips not found in ${DIR}`); process.exit(0); }
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : {})).json();
const probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
  'stream=width,height,avg_frame_rate,r_frame_rate,nb_read_frames,color_space,color_primaries,color_transfer:stream_side_data=rotation', '-of', 'json', f])).streams[0];
const rotated = st => (st.side_data_list || []).some(d => d.rotation);
const cmp = (a, b) => { // mean |difference| per value, and each channel's mean shift (a - b), in 0-255 levels
  let s = 0; const d = [0, 0, 0];
  for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); d[i % 3] += a[i] - b[i]; }
  return { mean: s / a.length, shift: d.map(x => x / (a.length / 3)) };
};
const VT = ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate', '-threads', '1'];
const SV = 'scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,format=yuv420p';
const area = b64 => { // a PNG area-averaged to 90x160 RGB by ffmpeg (the browser's drawImage aliases on detailed footage)
  const f = `${os.tmpdir()}/cutroom-hdr-${process.pid}.png`; fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  const r = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'scale=90:160:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); fs.rmSync(f); return r;
};
const grey = px => { const g = new Float64Array(px.length / 3); for (let i = 0; i < g.length; i++) g[i] = (px[3 * i] + px[3 * i + 1] + px[3 * i + 2]) / 3; return g; };
const near = (src, st) => { // the original's frames around st (VideoToolbox's tone map, upright), 90x160 grey, with their times
  const r = spawnSync('ffmpeg', ['-v', 'info', ...VT, '-ss', String(st - 0.03), '-i', src, '-frames:v', '8', '-vf', `${SV},transpose=clock,scale=90:160:flags=area,showinfo`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  const pts = [...r.stderr.toString().matchAll(/pts_time:([\d.]+)/g)].map(m => st - 0.03 + +m[1]), n = 90 * 160 * 3;
  return pts.map((t, i) => ({ t, g: grey(r.stdout.subarray(i * n, (i + 1) * n)) }));
};
const best = (g, frames) => frames.map(f => ({ t: f.t, d: g.reduce((s, v, i) => s + Math.abs(v - f.g[i]), 0) / g.length })).sort((a, b) => a.d - b.d)[0];
const f2 = x => x.toFixed(2), sh = d => d.map(x => (x >= 0 ? '+' : '') + f2(x)).join('/');

// 1. import by path (an APFS clone) and wait for the proxy
const ids = [], mine = [];
for (const f of CLIPS) {
  const t0 = Date.now(), m = await api('/api/import_path', { path: `${DIR}/${f}` }), t1 = Date.now();
  if (m.error) { check(`import ${f}`, false, m.error); process.exit(1); }
  if (!m.ready) mine.push(m.id); // already in the library (same file): reused, not trashed at the end
  let mm = m;
  while (!mm.ready) { await new Promise(r => setTimeout(r, 500)); mm = (await api('/api/media')).find(x => x.id === m.id); }
  ids.push(m.id);
  check(`import ${f}: HDR, portrait, ~120 fps, proxied`, mm.hdr && mm.w === 2160 && mm.h === 3840 && Math.abs(mm.fps - 120) < 1 && mm.proxy,
    `request ${t1 - t0} ms, ready after ${((Date.now() - t0) / 1000).toFixed(1)} s${mine.includes(m.id) ? '' : ' (already imported)'}, ${mm.w}x${mm.h} ${mm.fps} fps rot ${mm.rot}`);
  const px = probe(`${HOME}/cache/${m.id}.proxy.mp4`);
  check(`${f}: proxy upright 406x720, no rotation left in it, BT.709 labels`, px.width < px.height && px.height === 720 && !rotated(px)
    && px.color_space === 'bt709' && px.color_primaries === 'bt709' && px.color_transfer === 'bt709', JSON.stringify(px));
  const wk = `${os.tmpdir()}/cutroom-hdr-wk-${m.id}.mov`;
  fs.writeFileSync(wk, Buffer.from(await (await fetch(`${B}/media/${m.id}?wk=1`)).arrayBuffer()));
  const wp = probe(wk); fs.rmSync(wk);
  check(`${f}: WebKit copy labelled BT.709 matrix + sRGB transfer`, wp.color_space === 'bt709' && wp.color_transfer === 'iec61966-2-1' && wp.height === 720 && !rotated(wp),
    `${wp.width}x${wp.height} ${wp.color_space}/${wp.color_primaries}/${wp.color_transfer}`);
}

// 2. a 9:16 60 fps project: 3 s of each clip (120 fps footage in a 60 fps project), preview vs export frames in WebKit
const IN = [2, 1], LEN = 3, T = [0.4, 1.5, 2.9, 3.6, 5.5]; // T: project times (clip A 0-3 s, clip B 3-6 s)
const b = await browser.launch();
let pid = null, file = null;
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  await ev(() => loadMedia());
  await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), ids, { timeout: 60000 });
  pid = await ev(([ids, IN, LEN]) => {
    setProject(newProject('9:16')); P.name = 'HDR iPhone (scratch)'; P.fps = 60;
    ids.forEach((id, i) => { addMedia(id, 'main'); Object.assign(P.main.at(-1), { in: IN[i], out: IN[i] + LEN }); });
    packMain(); S.sel = null; renderAll(); return P.id;
  }, [ids, IN, LEN]);
  for (const t of rm === 'reduce' ? T.slice(1, 3) : T) {
    const r = await ev(async t => ({ ex: (await REMOTE.snapshot({ t, max: 640 })).image, pv: (await REMOTE.snapshot({ t, max: 640, preview: true })).image }), t);
    const a = area(r.ex), p = area(r.pv);
    let sum = 0, worst = 0; const d = [0, 0, 0];
    for (let by = 0; by < 160; by += 10) for (let bx = 0; bx < 90; bx += 10) {
      let s = 0;
      for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 90 + x) * 3 + k; s += Math.abs(a[i] - p[i]); d[k] += a[i] - p[i]; }
      sum += s; worst = Math.max(worst, s / 300);
    }
    const n = t < LEN ? 0 : 1, st = IN[n] + t - n * LEN, fr = near(`${DIR}/${CLIPS[n]}`, st), be = best(grey(a), fr), bp = best(grey(p), fr);
    // which source frame each shows, judged where the picture moves (> 2 levels frame to frame): within one source frame (8.3 ms).
    // Not exact: iPhone frames sit off the 1/fps grid (VFR), and the export's input seek assumes the grid (see the report)
    const motion = fr.slice(1).reduce((s, f, i) => s + f.g.reduce((q, v, j) => q + Math.abs(v - fr[i].g[j]), 0) / f.g.length, 0) / (fr.length - 1);
    const shift = d.map(x => x / (90 * 160)), same = motion < 2 || Math.abs(be.t - bp.t) < 0.009;
    // colour: mean shift per channel (the parity this test is about); detail: the 720p proxy drawn on a 253x451 canvas vs the
    // 4K original, so the per-pixel mean is looser than video_parity's synthetic 4
    const mean = sum / (90 * 160 * 3), ok = Math.max(...shift.map(Math.abs)) <= 1.5 && mean <= 6 && worst <= 28 && same;
    check(`${rm}: preview == export at ${t}s (HDR, rotated, 120 in 60 fps)`, ok, `colour shift ${sh(shift)}, mean |d| ${f2(mean)}, worst block ${worst.toFixed(1)}; `
      + `source frame: export ${be.t.toFixed(4)} s, preview ${bp.t.toFixed(4)} s for ${st} s${motion < 2 ? ' (static: not judged)' : ''}`);
    if (!ok || process.env.SAVE) { const o = new URL('./out/parity/', import.meta.url).pathname; fs.mkdirSync(o, { recursive: true }); for (const k of ['ex', 'pv']) fs.writeFileSync(`${o}hdr_${rm}_${t}_${k}.png`, Buffer.from(r[k], 'base64')); }
  }
  if (rm === 'no-preference') { // 3. the real export, twice (a regression chain shares this Mac: times are noisy)
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now(), out = await ev(() => REMOTE.export({ resolution: '1080p', name: 'HDR iPhone test' }));
      console.log(`     export ${k + 1}: ${((Date.now() - t0) / 1000).toFixed(1)} s for ${2 * LEN} s of 4K120 HLG -> 1080x1920 60 fps`);
      file = `${HOME}/exports/${out.file}`;
      if (k === 0) fs.renameSync(file, `${file}.first.mp4`), mine.push(`file:${file}.first.mp4`);
    }
  }
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();

// 4. the export: size, rate, labels, plays to the end
const ep = probe(file), dec = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
check('export is 1080x1920, 60 fps, 360 frames, BT.709 labels, no rotation', ep.width === 1080 && ep.height === 1920 && ep.r_frame_rate === '60/1' && +ep.nb_read_frames === 2 * LEN * 60
  && ep.color_space === 'bt709' && ep.color_primaries === 'bt709' && ep.color_transfer === 'bt709' && !rotated(ep), JSON.stringify(ep));
check('export decodes end to end without errors', dec.trim() === '', dec.slice(0, 200));

// 5. colours, compared as the 4:2:0 pixels themselves (1080x1920): ffmpeg 9's swscale colour-manages its own RGB conversions
// (transfer and primaries, not only the matrix), so an RGB read of the same pixels differs 2-3 levels by route; players read
// the file by its labels. References straight from the original: VideoToolbox's scale_vt (what the export uses), and
// AVFoundation's own SDR frame (Apple's tone mapping), the latter compared through AVFoundation on both sides.
const yuv = args => { // per-plane means and the planes
  const n = 1080 * 1920, b = execFileSync('ffmpeg', ['-v', 'error', ...args, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 64 << 20 }).subarray(0, n * 1.5);
  return [b.subarray(0, n), b.subarray(n, n * 1.25), b.subarray(n * 1.25)];
};
const pcmp = (a, b) => { const m = a.map((p, k) => { let s = 0, d = 0; for (let i = 0; i < p.length; i++) { s += Math.abs(p[i] - b[k][i]); d += p[i] - b[k][i]; } return [s / p.length, d / p.length]; }); return { mean: m.map(x => x[0]), shift: m.map(x => x[1]) }; };
let av = null;
try { // AVFoundation's own SDR frame (rotation applied), built once into tests/out
  const bin = new URL('./out/avref', import.meta.url).pathname, src = new URL('./out/avref.swift', import.meta.url).pathname;
  fs.mkdirSync(new URL('./out/', import.meta.url).pathname, { recursive: true });
  if (!fs.existsSync(bin)) {
    fs.writeFileSync(src, `import AVFoundation
import CoreGraphics
import Foundation
let a = CommandLine.arguments
let gen = AVAssetImageGenerator(asset: AVURLAsset(url: URL(fileURLWithPath: a[1])))
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
let sem = DispatchSemaphore(value: 0)
var img: CGImage?
gen.generateCGImageAsynchronously(for: CMTime(seconds: Double(a[2])!, preferredTimescale: 6000)) { im, _, _ in img = im; sem.signal() }
sem.wait()
guard let im = img else { exit(1) }
let w = Int(a[3])!, h = Int(a[4])!
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.itur_709)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.interpolationQuality = .high
ctx.draw(im, in: CGRect(x: 0, y: 0, width: w, height: h))
let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
var out = [UInt8]()
for i in 0..<(w * h) { out += [p[i * 4], p[i * 4 + 1], p[i * 4 + 2]] }
FileManager.default.createFile(atPath: a[5], contents: Data(out))
`);
    execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'ignore' });
  }
  av = (f, t) => { const o = `${os.tmpdir()}/cutroom-avref.rgb`; execFileSync(bin, [f, String(t), '270', '480', o]); const r = fs.readFileSync(o); fs.rmSync(o); return r; };
} catch (e) { console.log(`     (AVFoundation reference unavailable: ${String(e.message).split('\n')[0]})`); }
for (const [n, ot] of [[0, 1.5], [1, 4.5]]) { // output frame -> the source frame shown there (the last one at or before its time)
  const st = IN[n] + (ot - n * LEN), src = `${DIR}/${CLIPS[n]}`, at = [...VT, '-ss', String(st - 0.004), '-i', src];
  const got = yuv(['-i', file, '-vf', `select=eq(n\\,${Math.round(ot * 60)})`]);
  const ref = yuv([...at, '-vf', `${SV},transpose=clock,scale=1080:1920`]); // scale_vt's own pixels, upright, at the export's size
  // the RGB path before the fix: the same pixels read as the bt2020nc they stayed tagged, written out as BT.709
  const old = yuv([...at, '-vf', `${SV},transpose=clock,scale=1080:1920,format=gbrp,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`]);
  const c = pcmp(got, ref), o = pcmp(old, ref);
  check(`colours at ${ot}s (${CLIPS[n]} @${st}s) = scale_vt's own output (Y/U/V)`, Math.max(...c.shift.map(Math.abs)) < 0.5 && Math.max(...c.mean) < 6, // |d|: H.264 at the fast bitrate on detailed footage
    `mean |d| ${c.mean.map(f2).join('/')}, shift ${sh(c.shift)}; read as BT.2020 (the old RGB path) it shifts ${sh(o.shift)}`);
  if (av) {
    const e = av(file, ot), r = av(src, st), a = cmp(e, r), cast = [a.shift[0] - a.shift[1], a.shift[2] - a.shift[1]];
    check(`colours at ${ot}s vs AVFoundation's own SDR frame: no colour cast (R-G, B-G within 3 levels)`, Math.max(...cast.map(Math.abs)) < 3,
      `mean |d| ${f2(a.mean)}, export - AVFoundation RGB shift ${sh(a.shift)}, cast ${sh(cast)}`);
  }
}

for (const id of mine) if (id.startsWith('file:')) fs.rmSync(id.slice(5), { force: true }); else await api(`/api/media/${id}/trash`, {});
if (pid) await api(`/api/projects/${pid}/trash`, {});
if (file && !process.env.KEEP) fs.renameSync(file, `${HOME}/trash/${file.split('/').pop()}`);
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
