// AI enhance, measured on real iPhone footage (4K120 HLG, tone mapped to 1080x1920 SDR here, like the editor's proxy):
//   interp    RIFE vs minterpolate on held-out real frames: a 120 fps clip with every other frame dropped (60 fps), each
//             method makes the missing frames back (2x), PSNR / SSIM against the dropped ones; then a 4x slow-mo of a 60 fps 1080p clip renders
//   upscale   Real-ESRGAN 2x / 4x vs lanczos on a downscaled-then-upscaled truth (PSNR / SSIM), and its speed (frames per second)
//   relight   before/after PNGs of a portrait-ish frame (tests/out/ai_enhance/), and flicker on a still shot (32x32 block means of what
//             the relight adds, frame to frame: at most FLICKER level over what the encoder alone does, the light off)
//   deflicker brightness pumping put on a still shot, then the tool: frame-to-frame change of the mean brightness, before / after
//   sharpen   Adjust > Sharpen: preview == export (video_parity's measure at 1280 px) and both visibly sharper than without
//   ui        the Tools tab's new controls in both reduced-motion modes: Preview frame shows a picture, Deflicker switches the clip
// node ai_enhance.mjs [section]    (B = a scratch server, CUTROOM_HOME = its library; never 4610)
import { webkit } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4754', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2];
const PH = process.env.PHOTOS || `${process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch'}/photos`;
const OUT = new URL('./out/ai_enhance/', import.meta.url).pathname, FLICKER = 1;
fs.mkdirSync(OUT, { recursive: true });
const NEED = ['IMG_4700.MOV', 'IMG_4581.MOV', 'IMG_4703.MOV'].filter(f => !fs.existsSync(`${PH}/${f}`)); // real iPhone clips (people walking, handheld, a car on a lift)
if (NEED.length) { console.log(`SKIP: real footage missing in ${PH}: ${NEED.join(', ')}`); process.exit(0); }
const res = [], made = new Set(), pids = new Set();
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const note = s => console.log(`     ${s}`);
const run = name => !only || name === only;
const api = async (p, body) => { const r = await (await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json(); if (r.error) throw new Error(r.error); return r; };
const meta = async id => (await (await fetch(`${B}/api/media`)).json()).find(m => m.id === id);
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-enh-`);
const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const imp = async f => { const m = await api('/api/import_path', { path: f }); made.add(m.id); return m; };
const file = async id => `${process.env.CUTROOM_HOME}/media/${(await meta(id)).file}`;
async function job(p, body) { // a server job to the end: [result, seconds]
  const t0 = Date.now(), { job: j } = await api(p, body);
  for (;;) {
    await new Promise(z => setTimeout(z, 500));
    const s = await (await fetch(`${B}/api/jobs/${j}`)).json();
    if (s.state === 'done') { if (s.media) made.add(s.media); return [s, (Date.now() - t0) / 1000]; }
    if (s.state !== 'running') throw new Error(s.error || s.state);
  }
}
const probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-of', 'json', f])).streams[0];
function cmp(a, b, sel) { // PSNR (dB, luma+chroma average) and SSIM (All) of a's frames vs b's, at the frame numbers sel picks
  const g = `[0]select='${sel}',setpts=N/TB[a];[1]select='${sel}',setpts=N/TB[b];[a][b]`;
  const e = f => spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', g + f, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return { psnr: +e('psnr').match(/PSNR .*average:([\d.]+)/)[1], ssim: +e('ssim').match(/SSIM .*All:([\d.]+)/)[1] };
}
const fmt = r => `PSNR ${r.psnr.toFixed(2)} dB, SSIM ${r.ssim.toFixed(4)}`;
// HLG 4K -> SDR 1080x1920 at 120 fps the editor's way (VideoToolbox tone map, then turned upright), x264 near-lossless
const VT = 'scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,scale,';
const sdr = (src, ss, t, out, extra = '') => { ff(['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate', '-display_rotation', '0', '-ss', ss, '-t', t, '-i', src,
  '-vf', `${VT}transpose=clock,scale=1080:1920:flags=lanczos,setpts=N/120/TB${extra}`, '-r', '120', '-an', '-c:v', 'libx264', '-crf', '10', '-preset', 'fast', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', out]); return out; };
const enc = (src, vf, out, r) => { ff(['-i', src, '-vf', vf, ...(r ? ['-r', String(r)] : []), '-an', '-c:v', 'libx264', '-crf', '10', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', out]); return out; };
const gray = (f, w, h) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 }); const n = w * h, fr = []; for (let i = 0; i + n <= b.length; i += n) fr.push(b.subarray(i, i + n)); return fr; };

try {
// ---------- interp: RIFE vs minterpolate on held-out real frames ----------
if (run('interp')) {
  for (const [clip, ss, what] of [['IMG_4700.MOV', '3', 'a person walking (locked-off)'], ['IMG_4581.MOV', '2', 'two people, handheld']]) {
    const truth = sdr(`${PH}/${clip}`, ss, '1.5', `${tmp}/truth_${clip}.mp4`);
    const half = enc(truth, "select='not(mod(n\\,2))',setpts=N/60/TB", `${tmp}/half_${clip}.mp4`, 60);
    const H60 = await imp(half), N = probe(half).nb_read_frames | 0, out = {};
    for (const engine of ['ai', 'fast']) {
      const [r, s] = await job('/api/slowmo', { media: H60.id, t0: 0, t1: N / 60, factor: 2, engine });
      const f = await file(r.media), p = probe(f);
      out[engine] = { odd: cmp(f, truth, `mod(n\\,2)*lt(n\\,${2 * N - 2})`), even: cmp(f, truth, `not(mod(n\\,2))*lt(n\\,${2 * N - 2})`), s, frames: +p.nb_read_frames, fps: p.r_frame_rate };
    }
    note(`${clip} (${what}), ${N} frames at 60 -> 120 fps; made frames vs the dropped real ones:`);
    for (const e of ['ai', 'fast']) note(`  ${e === 'ai' ? 'RIFE        ' : 'minterpolate'} ${fmt(out[e].odd)}   (real frames passed through: ${fmt(out[e].even)}; ${out[e].frames} frames ${out[e].fps}; ${out[e].s.toFixed(1)} s)`);
    check(`${clip}: the RIFE copy keeps the frame grid (${2 * N} frames at 120 fps, the real frames > 40 dB: both copies line up with the truth)`, out.ai.frames === 2 * N && out.ai.fps === '120/1' && out.ai.even.psnr > 40 && out.fast.even.psnr > 40, JSON.stringify(out));
    check(`${clip}: RIFE's made-up frames beat minterpolate's (PSNR and SSIM)`, out.ai.odd.psnr > out.fast.odd.psnr && out.ai.odd.ssim > out.fast.odd.ssim, `${fmt(out.ai.odd)} vs ${fmt(out.fast.odd)}`);
    if (clip === 'IMG_4700.MOV') { // 4x slow-mo of a 60 fps 1080p clip, timed twice (the Mac is busy)
      for (let i = 0; i < 2; i++) {
        const [r, s] = await job('/api/slowmo', { media: H60.id, t0: 0, t1: N / 60, factor: 4, engine: 'ai' }), p = probe(await file(r.media));
        check(`4x AI slow-mo of 1080x1920 at 60 fps renders (run ${i + 1})`, +p.nb_read_frames === 4 * N && p.r_frame_rate === '240/1' && p.width === 1080 && p.height === 1920,
          `${p.nb_read_frames} frames ${p.r_frame_rate} ${p.width}x${p.height} in ${s.toFixed(1)} s = ${(3 * (N - 1) / s).toFixed(1)} made frames/s`);
      }
    }
  }
}

// ---------- upscale: Real-ESRGAN vs lanczos on a downscaled truth ----------
if (run('upscale')) {
  const truth = sdr(`${PH}/IMG_4581.MOV`, '2', '0.25', `${tmp}/up_truth.mp4`), n = probe(truth).nb_read_frames | 0;
  for (const s of [2, 4]) {
    const low = enc(truth, `scale=${1080 / s}:${1920 / s}:flags=area`, `${tmp}/low${s}.mp4`), L = await imp(low);
    const lz = `${tmp}/lanczos${s}.mp4`; // the baseline through the same encoder as the AI copy (VideoToolbox, -q:v 68)
    ff(['-i', low, '-vf', 'scale=1080:1920:flags=lanczos', '-c:v', 'h264_videotoolbox', '-q:v', '68', '-pix_fmt', 'yuv420p', lz]);
    const times = [];
    let r;
    for (let i = 0; i < 2; i++) { const [x, t] = await job('/api/upscale', { media: L.id, t0: 0, t1: n / 120, scale: s }); r = x; times.push(t); }
    const f = await file(r.media), p = probe(f), all = `lt(n\\,${n})`, ai = cmp(f, truth, all), lc = cmp(lz, truth, all);
    const edge = x => { const g = gray(x, 1080, 1920)[0]; let e = 0; for (let y = 1; y < 1919; y++) for (let q = 1; q < 1079; q++) { const i = y * 1080 + q; e += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - 1080] - g[i + 1080]); } return e; };
    const et = edge(truth); // fine detail (|Laplacian|) as a share of the truth's: 1 = as detailed, under 1 = soft
    note(`${s}x from ${1080 / s}x${1920 / s} (${n} frames): Real-ESRGAN ${fmt(ai)}, detail ${(edge(f) / et).toFixed(2)}x   lanczos ${fmt(lc)}, detail ${(edge(lz) / et).toFixed(2)}x   AI ${times.map(t => `${(n / t).toFixed(1)}`).join(' / ')} fps with model load`);
    check(`${s}x upscale renders ${p.width}x${p.height}, ${p.nb_read_frames} frames`, p.width === 1080 && p.height === 1920 && +p.nb_read_frames === n, JSON.stringify(p));
    if (s === 4) fs.writeFileSync(`${OUT}upscale4x_lanczos_vs_ai.png`, execFileSync('ffmpeg', ['-v', 'error', '-i', lz, '-i', f, '-i', truth, '-lavfi', '[0]crop=360:360:360:700[a];[1]crop=360:360:360:700[b];[2]crop=360:360:360:700[c];[a][b][c]hstack=3', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { maxBuffer: 1 << 28 }));
  }
  const T = await imp(truth), [r, t] = await job('/api/upscale', { media: T.id, t0: 0, t1: n / 120, scale: 2 }), p = probe(await file(r.media));
  check('2x of the 1080x1920 clip renders 2160x3840 (4K)', p.width === 2160 && p.height === 3840, `${(n / t).toFixed(1)} fps with model load`);
}

// ---------- relight ----------
if (run('relight')) {
  const port = sdr(`${PH}/IMG_4581.MOV`, '1', '1', `${tmp}/portrait.mp4`), P1 = await imp(port);
  const frame0 = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { maxBuffer: 1 << 28 });
  const looks = { light: { preset: 'light', x: 0.15, y: 0.25, color: '#ffc890', strength: 0.8 }, subject: { preset: 'subject', strength: 0.7, color: '#ffffff' }, background: { preset: 'background', strength: 0.8, color: '#ffffff' } };
  for (const [k, light] of Object.entries(looks)) {
    const [r, s] = await job('/api/relight', { media: P1.id, t0: 0, t1: 1, light }), f = await file(r.media), p = probe(f);
    fs.writeFileSync(`${OUT}relight_${k}_before.png`, frame0(port)); fs.writeFileSync(`${OUT}relight_${k}_after.png`, frame0(f));
    const a = gray(port, 68, 120)[0], b = gray(f, 68, 120)[0];
    let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(b[i] - a[i]);
    check(`relight '${k}' renders ${p.width}x${p.height}, ${p.nb_read_frames} frames, and changes the picture`, p.width === 1080 && +p.nb_read_frames === 120 && d / a.length > 3, `mean change ${(d / a.length).toFixed(1)} levels; ${s.toFixed(1)} s (${(120 / s).toFixed(1)} fps)`);
  }
  ff(['-i', `${OUT}relight_light_before.png`, ...Object.keys(looks).flatMap(k => ['-i', `${OUT}relight_${k}_after.png`]), '-lavfi', 'hstack=4', `${OUT}relight_sheet_before_light_subject_background.png`]);
  const pv = await api('/api/relight_preview', { media: P1.id, t: 0.2, light: looks.light });
  fs.writeFileSync(`${OUT}relight_preview_frame.png`, Buffer.from(pv.png, 'base64'));
  check('Preview frame returns a PNG', Buffer.from(pv.png, 'base64').subarray(1, 4).toString() === 'PNG');
  // still shot: one real frame held 2 s with sensor-like noise (each frame different); then a real tripod-ish clip
  const still = `${tmp}/still.mp4`;
  ff(['-loop', '1', '-t', '2', '-r', '30', '-i', `${OUT}relight_light_before.png`, '-vf', 'noise=alls=4:allf=t,format=yuv420p', '-c:v', 'libx264', '-crf', '12', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', still]);
  // what the copy adds to the source, frame to frame, per 32x32 block; the light at strength 0 goes through the same decode and
  // encode, so its number is the floor the encoder alone makes (re-encoding noise moves block means 3-5 levels already)
  const shimmer = async (src, S1, strength) => {
    const [r] = await job('/api/relight', { media: S1.id, t0: 0, t1: Math.min(2, (await meta(S1.id)).duration), light: { ...looks.light, strength } });
    const a = gray(src, 34, 60), b = gray(await file(r.media), 34, 60), n = Math.min(a.length, b.length);
    let worst = 0, sum = 0, k = 0;
    for (let t = 1; t < n; t++) for (let i = 0; i < a[t].length; i++) { const j = Math.abs((b[t][i] - a[t][i]) - (b[t - 1][i] - a[t - 1][i])); worst = Math.max(worst, j); sum += j; k++; }
    return { worst, mean: sum / k, n };
  };
  for (const [name, src] of [['still frame + noise', still], ['real clip IMG_4703 (car on a lift, handheld)', sdr(`${PH}/IMG_4703.MOV`, '2', '1', `${tmp}/lift.mp4`)]]) {
    const S1 = await imp(src), off = await shimmer(src, S1, 0), on = await shimmer(src, S1, looks.light.strength);
    const msg = `per 32x32 block, frame to frame: relit mean ${on.mean.toFixed(2)} / worst ${on.worst} levels; light off (encoder floor) mean ${off.mean.toFixed(2)} / worst ${off.worst}; ${on.n} frames`;
    if (name.startsWith('still')) check(`relight is steady on a still shot (adds <= ${FLICKER} level over the encoder's floor anywhere, <= 0.25 on average)`, on.worst <= off.worst + FLICKER && on.mean <= off.mean + 0.25, msg);
    else note(`${name}: ${msg} (moving camera: reported, not gated)`);
  }
}

// ---------- deflicker ----------
if (run('deflicker')) {
  const src = `${tmp}/flicker.mp4`;
  ff(['-i', sdr(`${PH}/IMG_4703.MOV`, '2', '0.02', `${tmp}/one.mp4`), '-frames:v', '1', `${tmp}/one.png`]);
  ff(['-loop', '1', '-t', '3', '-r', '30', '-i', `${tmp}/one.png`, '-vf', "eq=brightness='0.04*sin(n*2.3)+0.03*sin(n*0.9)':eval=frame,format=yuv420p", '-c:v', 'libx264', '-crf', '12', src]);
  const F1 = await imp(src), [r, s] = await job('/api/deflicker', { media: F1.id, t0: 0, t1: 3 });
  const pump = f => { const fr = gray(f, 54, 96), m = fr.map(x => x.reduce((a, v) => a + v, 0) / x.length); let d = 0; for (let i = 1; i < m.length; i++) d += Math.abs(m[i] - m[i - 1]); return d / (m.length - 1); };
  const before = pump(src), after = pump(await file(r.media));
  check('deflicker evens out brightness pumping on a still shot (at least halved)', after < before / 2, `mean frame-to-frame brightness change ${before.toFixed(2)} -> ${after.toFixed(2)} levels; ${s.toFixed(1)} s for 3 s`);
}

// ---------- sharpen + ui (the page) ----------
if (run('sharpen') || run('ui')) {
  const vid = sdr(`${PH}/IMG_4581.MOV`, '1', '3', `${tmp}/page.mp4`), V1 = await imp(vid);
  const tsrc = `${tmp}/tsrc.mp4`;
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tsrc]);
  const T1 = await imp(tsrc), V2 = await imp(enc(vid, 'transpose=cclock', `${tmp}/page_wide.mp4`)); // the same footage turned on its side: a 16:9 preview
  for (const reduced of ['no-preference', 'reduce']) {
    if (reduced === 'reduce' && !run('ui')) break;
    const br = await webkit.launch(), page = await (await br.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: reduced })).newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
    await page.goto(`${B}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
    const ev = (f, a) => page.evaluate(f, a);
    await ev(() => loadMedia());
    await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), [V1.id, T1.id], { timeout: 120000 });
    if (run('sharpen') && reduced === 'no-preference') {
      for (const [name, id, ratio] of [['real footage 1920x1080', V2.id, '16:9'], ['testsrc2 1920x1080', T1.id, '16:9'], ['real footage 1080x1920 in a 9:16 preview 253 px wide', V1.id, '9:16']]) {
        const r = await ev(async ([id, ratio]) => {
          setProject(newProject(ratio)); P.name = 'Sharpen (scratch)'; addMedia(id, 'main'); const c = P.main.at(-1); c.adj = { ...c.adj, sharp: 1e-6 }; S.sel = null; renderAll(); // the baseline: the same drawing path, no sharpening
          let size = null; // both compared at the preview's own size (the export shrunk to it: what the preview can show of it)
          const grab = async preview => { const s = await REMOTE.snapshot({ t: 1, max: 1280, preview }); const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${s.image}`)).blob()); size ??= [im.width, im.height]; const cv = new OffscreenCanvas(...size), g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, ...size); return { w: size[0], h: size[1], src: `${im.width}x${im.height}`, d: g.getImageData(0, 0, ...size).data }; };
          const lap = ({ w, h, d }) => { let s = 0; for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = (y * w + x) * 4 + 1; s += Math.abs(4 * d[i] - d[i - 4] - d[i + 4] - d[i - 4 * w] - d[i + 4 * w]); } return s / ((w - 2) * (h - 2)); };
          const p0 = await grab(true), e0 = await grab(false);
          c.adj = { ...c.adj, sharp: 0.8 }; renderAll(); await sleep(300);
          const p1 = await grab(true), e1 = await grab(false);
          const W = e1.w, Hh = e1.h, diff = (e, p) => { let sum = 0, worst = 0;
            for (let by = 0; by + 16 <= Hh; by += 16) for (let bx = 0; bx + 16 <= W; bx += 16) { let s = 0; for (let y = by; y < by + 16; y++) for (let x = bx; x < bx + 16; x++) for (let k = 0; k < 3; k++) { const i = (y * W + x) * 4 + k; s += Math.abs(e.d[i] - p.d[i]); } sum += s; worst = Math.max(worst, s / 768); }
            return [sum / (Math.floor(W / 16) * Math.floor(Hh / 16) * 768), worst]; };
          const [mean, worst] = diff(e1, p1), [mean0, worst0] = diff(e0, p0);
          return { pid: P.id, size: `${W}x${Hh} (export ${e1.src}, preview ${p1.src})`, mean, worst, mean0, worst0, le0: lap(e0), le1: lap(e1), lp0: lap(p0), lp1: lap(p1) };
        }, [id, ratio]);
        pids.add(r.pid);
        // at the preview's size the two differ a little already without it (how each shrinks the footage): sharpen may not add to that
        const ge = r.le1 / r.le0, gp = r.lp1 / r.lp0; // fine detail (|Laplacian|) gained
        const m1 = `mean ${r.mean.toFixed(2)} / worst block ${r.worst.toFixed(1)} levels; unsharpened ${r.mean0.toFixed(2)} / ${r.worst0.toFixed(1)}`, m2 = `export x${ge.toFixed(2)} (${r.le0.toFixed(2)} -> ${r.le1.toFixed(2)}), preview x${gp.toFixed(2)} (${r.lp0.toFixed(2)} -> ${r.lp1.toFixed(2)})`;
        if (ratio === '9:16') { note(`${name} (a 4x shrink; reported, not gated): ${m1}; detail ${m2}`); continue; }
        check(`sharpen on ${name}: preview == export at ${r.size} (no further apart than unsharpened + 1 level, worst block <= 28)`, r.mean <= r.mean0 + 1 && r.worst <= Math.max(28, r.worst0 + 4), m1);
        check(`sharpen on ${name}: the preview gains the detail the export does (both up >= 10 %, within 0.1 of each other)`, ge > 1.1 && gp > 1.1 && Math.abs(ge - gp) <= 0.1, m2);
      }
    }
    if (run('ui')) {
      const pid = await ev(id => { setProject(newProject('9:16')); P.name = 'Enhance UI (scratch)'; addMedia(id, 'main'); const c = P.main.at(-1); c.speed = 0.5; S.sel = { lane: 'main', id: c.id }; S.t = 0.5; renderAll(); return P.id; }, V1.id);
      pids.add(pid);
      await page.click('[data-itab="Tools"]');
      const ctl = await ev(() => ['[data-act="upscale"]', '#upScale', '[data-act="deflicker"]', '[data-rlp="subject"]', '[data-rl="color"]', '[data-rl="strength"]', '[data-rl="x"]', '[data-act="rlprev"]', '[data-act="relight"]', '#smEngine'].filter(s => !document.querySelector(s)));
      check(`[${reduced}] the Tools tab has upscale, deflicker, relight and the slow-mo engine`, !ctl.length, ctl.join(' '));
      await page.locator('[data-rl="x"]').fill('0.8');
      await page.locator('[data-act="rlprev"]').scrollIntoViewIfNeeded();
      await page.click('[data-act="rlprev"]');
      await page.waitForFunction(() => { const i = document.querySelector('#rlImg'); return i && !i.hidden && i.naturalWidth > 0; }, null, { timeout: 120000 }).catch(() => {});
      const pvw = await ev(() => ({ w: document.querySelector('#rlImg')?.naturalWidth, x: S.rl?.x }));
      check(`[${reduced}] Preview frame shows the relit frame in the panel (light moved to x 0.8)`, pvw.w > 100 && pvw.x === 0.8, JSON.stringify(pvw));
      await page.locator("#rlImg").scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}tools_tab_${reduced}.png` });
      const was = await ev(() => P.main[0].media);
      await page.click('[data-act="deflicker"]');
      await page.waitForFunction(w => P.main[0].media !== w || /fail|error/i.test(document.querySelector('#clipStatus')?.textContent || ''), was, { timeout: 120000 }).catch(() => {});
      const now = await ev(() => ({ media: P.main[0].media, name: M.get(P.main[0].media)?.name, status: document.querySelector('#clipStatus')?.textContent }));
      if (now.media !== was) made.add(now.media);
      check(`[${reduced}] Deflicker from the panel switches the clip to its copy`, now.media !== was && /deflickered/.test(now.name), JSON.stringify(now));
      if (reduced === 'no-preference') { // the MCP's clip_tool (REMOTE in the page): each new action, a bad one refused
        await ev(() => { const c = P.main[0]; c.out = c.in + 0.4; renderAll(); }); // 0.4 s of 120 fps: the 4K upscale runs ~2 frames/s
        for (const [action, extra, re] of [['relight', { preset: 'subject', strength: 0.5 }, /relit/], ['smooth_slowmo', { engine: 'ai' }, /smooth 2x/], ['deflicker', {}, /deflickered/], ['ai_upscale', { scale: 2 }, /upscaled 2x/]]) {
          const r = await ev(async ([action, extra]) => { const id = P.main[0].id; try { const o = await REMOTE.clip_tool({ id, action, ...extra }); return { name: M.get(P.main[0].media)?.name, media: P.main[0].media, ok: !!o.clip }; } catch (e) { return { err: e.message }; } }, [action, extra]);
          if (r.media) made.add(r.media);
          check(`MCP clip_tool ${action} renders the copy the clip plays`, r.ok && re.test(r.name || ''), JSON.stringify(r));
        }
        const bad = await ev(async () => { try { await REMOTE.clip_tool({ id: P.main[0].id, action: 'relight', color: 'red; rm', x: 9 }); return 'accepted'; } catch (e) { return e.message; } });
        check('MCP relight with a light off the frame is refused (the server checks it)', /outside/.test(bad), bad);
      }
      check(`[${reduced}] no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
    }
    await br.close();
  }
}
} finally { // tidy by id (projects first: a page's last save can't bring one back after its browser is closed)
  for (const pid of pids) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  for (const id of made) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed; pictures in ${OUT}`);
process.exit(res.includes(false) ? 1 : 0);
