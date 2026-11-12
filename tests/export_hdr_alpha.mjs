// HDR and transparent exports through the real dialog, headless WebKit, both motion modes.
// HDR: a real iPhone clip (4K 120 fps HLG, portrait by rotation) trimmed + faded in, in a 120 fps 9:16 project, exported
// as HEVC Main 10 HLG and PQ: labels, 10-bit, upright, 120 fps, hvc1, and its luma against the source at 5 frames (10-bit
// codes). Known values: a lossless HLG patch clip exported HLG keeps its code values, exported PQ lands on BT.2100's maths.
// Honest labels: the preview says it is SDR, the dialog says what forces SDR. Alpha: text + sticker (PNG) + cut-out clip
// (VP9 alpha) on a transparent background, as ProRes 4444, WebM VP9, GIF and a PNG sequence: alpha in the file, 0 where
// nothing is, 255 on the text / sticker / cut-out, frame counts; the preview shows a checkerboard where the file is clear.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node export_hdr_alpha.mjs     (a scratch server, never 4610)
//   PHOTOS=<dir of .MOV files> overrides where IMG_4705.MOV is read from (cloned, never modified)
import { webkit } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', HOME = process.env.CUTROOM_HOME || `${os.homedir()}/Movies/Cutroom`;
const DIR = process.env.PHOTOS || `${process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch'}/photos`, SRC = `${DIR}/IMG_4705.MOV`;
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : {})).json();
const ff = (args, input) => spawnSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 512 << 20, input });
const probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,codec_tag_string,profile,pix_fmt,width,height,'
  + 'r_frame_rate,nb_read_frames,color_space,color_primaries,color_transfer:stream_tags=alpha_mode:stream_side_data=rotation:format=duration', '-of', 'json', f]));
const TMP = fs.mkdtempSync(`${os.tmpdir()}/cutroom-hdra-`), mine = [], files = [], pids = [];
const pct = x => `${(x * 100).toFixed(2)} %`;

// HLG -> PQ, BT.2100 (as server.py hlg_to_pq): HLG 0.75 = 203 nits = PQ 0.5806
const hlgToPq = rgb => {
  const a = 0.17883277, b = 0.28466892, c = 0.55991073, E = rgb.map(x => (x <= 0.5 ? x * x / 3 : (Math.exp((x - c) / a) + b) / 12));
  const Ys = 0.2627 * E[0] + 0.678 * E[1] + 0.0593 * E[2], k = Ys > 0 ? 1000 * Ys ** 0.2 : 0;
  const m1 = 2610 / 16384, m2 = 2523 / 4096 * 128, c1 = 3424 / 4096, c2 = 2413 / 4096 * 32, c3 = 2392 / 4096 * 32;
  return E.map(e => { const y = (k * e / 10000) ** m1; return ((c1 + c2 * y) / (1 + c3 * y)) ** m2; });
};
const ycc = ([r, g, b]) => { const y = 0.2627 * r + 0.678 * g + 0.0593 * b; return [64 + 876 * y, 512 + 896 * (b - y) / 1.8814, 512 + 896 * (r - y) / 1.4746]; };

// fixtures: a lossless HLG patch clip (8 stripes of known HLG values), a cut-out clip (VP9 alpha), a sticker (PNG alpha)
const PATS = [[0, 0, 0], [0.25, 0.25, 0.25], [0.5, 0.5, 0.5], [0.75, 0.75, 0.75], [1, 1, 1], [0.75, 0.2, 0.2], [0.2, 0.75, 0.2], [0.2, 0.2, 0.75]];
{
  const W = 1080, Hh = 1920, buf = Buffer.alloc(W * Hh * 3);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) buf.writeUInt16LE(Math.round(ycc(PATS[Math.floor(x * 8 / W)])[0]), (y * W + x) * 2);
  for (let k = 1; k <= 2; k++) for (let y = 0; y < Hh / 2; y++) for (let x = 0; x < W / 2; x++) buf.writeUInt16LE(Math.round(ycc(PATS[Math.floor(2 * x * 8 / W)])[k]), W * Hh * 2 + (k - 1) * W * Hh / 2 + (y * W / 2 + x) * 2);
  fs.writeFileSync(`${TMP}/p.yuv`, buf);
  ff(['-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s', `${W}x${Hh}`, '-r', '30', '-i', `${TMP}/p.yuv`, // labelled BT.2020 HLG on the way in: untagged, ffmpeg re-matrixes it to the output's BT.2020 (it moved the colour patches 20-50 codes)
    '-vf', 'setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67:range=tv,loop=29:1:0', '-frames:v', '30', '-c:v', 'libx265',
    '-x265-params', 'lossless=1:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67',
    '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', `${TMP}/hlg-patches.mp4`]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x200:r=30:d=3,format=rgba,pad=400:400:100:100:color=black@0', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', `${TMP}/cut-out.webm`]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=150x150,format=rgba,pad=300:300:75:75:color=black@0', '-frames:v', '1', `${TMP}/sticker.png`]);
}
const ids = {};
for (const [k, f] of [['hdr', SRC], ['pat', `${TMP}/hlg-patches.mp4`], ['cut', `${TMP}/cut-out.webm`], ['stk', `${TMP}/sticker.png`]]) {
  if (!fs.existsSync(f)) { console.log(`SKIP: ${f} not found`); process.exit(0); }
  const m = await api('/api/import_path', { path: f });
  if (m.error) { check(`import ${f}`, false, m.error); process.exit(1); }
  if (!m.ready) mine.push(m.id);
  ids[k] = m.id;
}
for (let t = 0; t < 600; t++) { const ms = await api('/api/media'); if (Object.values(ids).every(id => ms.find(x => x.id === id)?.ready)) break; await new Promise(r => setTimeout(r, 500)); }

const b = await webkit.launch();
const out = {};
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  await ev(() => loadMedia());
  await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 60000 });
  const heavy = rm === 'no-preference'; // the real exports once; the UI in both modes
  const close = () => ev(() => { if (!$('#modal').hidden) $('#modal [data-close]')?.click(); });
  const dialog = async () => { await close(); await page.click('#btnExport'); await page.waitForSelector('#exHdr'); };
  const run = async (fmt, hdr) => { // one export through the dialog's own button; the saved file
    await page.selectOption('#exFmt', fmt);
    if (hdr) await page.selectOption('#exHdr', hdr);
    await page.click('#exGo');
    await page.waitForFunction(() => !S.exporting && /Saved|failed/.test(document.querySelector('#exStatus')?.textContent || ''), null, { timeout: 600000 });
    const st = await page.textContent('#exStatus'), f = st.match(/Saved (.+?) in /)?.[1];
    if (f) files.push(`${HOME}/exports/${f}`);
    return { file: f && `${HOME}/exports/${f}`, st };
  };

  // 1. HDR project: the iPhone clip, 2-4 s, 0.5 s fade in, 9:16 at 120 fps; HDR chosen in the Project panel (the UI)
  pids.push(await ev(id => {
    setProject(newProject('9:16')); P.name = 'HDR export (scratch)'; P.fps = 120;
    addMedia(id, 'main'); Object.assign(P.main[0], { in: 2, out: 4, fadeIn: 0.5 }); packMain(); S.sel = null; renderAll(); return P.id;
  }, ids.hdr));
  await page.selectOption('select[data-k="p.hdr"]', 'hlg');
  const tag = await ev(() => ({ hdr: P.hdr, shown: !$('#hdrTag').hidden && $('#hdrTag').offsetWidth > 0, text: $('#hdrTag').textContent }));
  check(`${rm}: Project panel sets HDR HLG; the preview says it is SDR`, tag.hdr === 'hlg' && tag.shown && /preview shown in SDR/.test(tag.text), JSON.stringify(tag));
  await dialog();
  const dlg = {};
  for (const f of ['mp4', 'prores', 'gif', 'webm']) { await page.selectOption('#exFmt', f); dlg[f] = { dis: await page.isDisabled('#exHdr'), hint: await page.textContent('#exHint'), hdr: await page.textContent('#exHdrHint') }; }
  check(`${rm}: dialog: HDR from the project, MP4 = HEVC Main 10, ProRes = 422 HQ, GIF / WebM can't be HDR`, await page.inputValue('#exHdr') === 'hlg' && /HEVC Main 10/.test(dlg.mp4.hint)
    && /HDR · HLG, 10-bit/.test(dlg.mp4.hdr) && /preview shows SDR/.test(dlg.mp4.hdr) && /422 HQ/.test(dlg.prores.hint) && dlg.gif.dis && dlg.webm.dis && !dlg.mp4.dis, JSON.stringify(dlg.mp4));
  await page.selectOption('#exFmt', 'mp4');
  if (heavy) {
    for (const hk of ['hlg', 'pq']) {
      const t0 = Date.now(), r = await run('mp4', hk);
      out[hk] = r.file;
      check(`export HDR ${hk} through the dialog`, r.file && !/SDR/.test(r.st), `${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.st}`);
    }
  }
  await ev(() => { addText('Title'); S.sel = null; });
  await page.selectOption('#exFmt', 'prores'); await page.selectOption('#exFmt', 'mp4');
  const why = await page.textContent('#exHdrHint');
  check(`${rm}: with a text layer the dialog says it exports SDR and why`, /^Exports SDR: text, captions or stickers/.test(why), why);
  if (heavy) {
    const r = await run('mp4', 'hlg'), p = r.file && probe(r.file).streams[0];
    check('the server agrees: text -> SDR file, and the done message says why', p && p.color_transfer === 'bt709' && p.pix_fmt === 'yuv420p' && /in SDR: text/.test(r.st), `${p?.pix_fmt} ${p?.color_transfer}; ${r.st}`);
  }

  // 2. known values: the lossless HLG patch clip, 1080x1920 30 fps, exported HLG (kept) and PQ (BT.2100 maths)
  if (heavy) {
    pids.push(await ev(id => { setProject(newProject('9:16')); P.name = 'HDR patches (scratch)'; P.fps = 30; P.hdr = 'hlg'; addMedia(id, 'main'); Object.assign(P.main[0], { in: 0, out: 1 }); packMain(); S.sel = null; renderAll(); return P.id; }, ids.pat));
    for (const hk of ['hlg', 'pq']) {
      await ev(hk => { P.hdr = hk; }, hk);
      const r = await ev(async () => REMOTE.export({ format: 'hevc', resolution: '1080p', name: `HDR patches ${P.hdr}` }));
      const f = `${HOME}/exports/${r.file}`; files.push(f);
      const raw = ff(['-i', f, '-vf', 'select=eq(n\\,15)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-']).stdout, W = 1080, Hh = 1920;
      let worst = 0; const got = [];
      PATS.forEach((p, i) => {
        const x = Math.round((i + 0.5) * W / 8), y = 960, want = ycc(hk === 'pq' ? hlgToPq(p) : p);
        const g = [raw.readUInt16LE((y * W + x) * 2), raw.readUInt16LE(W * Hh * 2 + ((y / 2) * W / 2 + x / 2 | 0) * 2), raw.readUInt16LE(W * Hh * 2.5 + ((y / 2) * W / 2 + x / 2 | 0) * 2)];
        worst = Math.max(worst, ...g.map((v, k) => Math.abs(v - want[k]))); got.push(g[0]);
      });
      const pr = probe(f).streams[0];
      check(`known values, HLG patches -> ${hk.toUpperCase()}: Y'CbCr within 3 of 876 codes (${hk === 'pq' ? 'BT.2100 HLG -> PQ, 1000 nits' : 'kept as they were'})`,
        worst <= 3 && pr.color_transfer === (hk === 'pq' ? 'smpte2084' : 'arib-std-b67') && pr.pix_fmt === 'yuv420p10le', `worst ${worst.toFixed(2)} codes; Y ${got.join(' ')}`);
    }
  }

  // 3. transparent background: text + sticker + cut-out clip, no main track; the preview's checkerboard
  await close();
  pids.push(await ev(([stk, cut]) => {
    setProject(newProject('9:16')); P.name = 'Transparent export (scratch)'; P.fps = 30;
    addMedia(cut, 'overlay', 0); Object.assign(P.overlay.at(-1), { fit: 'fit', scale: 0.5, y: 0.15, out: 3 });
    addMedia(stk, 'overlay', 0); Object.assign(P.overlay.at(-1), { fit: 'fit', scale: 0.3, y: -0.3, out: 3 });
    S.t = 0; addText('Title'); S.sel = null; seekTo(1.5); renderAll(); return P.id;
  }, [ids.stk, ids.cut]));
  await page.click('input[data-k="p.alpha"]');
  await page.waitForTimeout(400);
  const cb = await ev(() => { // the checkerboard: two neighbouring squares in an empty corner, and the empty bottom (export pixel 540, 1700)
    const cv = $('#cv'), x = cv.getContext('2d'), q = Math.max(6, Math.round(cv.width / 40)), px = (a, b) => [...x.getImageData(Math.round(a), Math.round(b), 1, 1).data].slice(0, 3);
    return { alpha: P.alpha, a: px(q / 2, q / 2), b: px(q * 1.5, q / 2), bottom: px(cv.width / 2, cv.height * 1700 / 1920) };
  });
  const chk = c => ['60,60,60', '90,90,90'].includes(c.join(','));
  check(`${rm}: Transparent background ticked: the preview shows a checkerboard where nothing is`, cb.alpha && chk(cb.a) && chk(cb.b) && cb.a.join() !== cb.b.join() && chk(cb.bottom), JSON.stringify(cb));
  await dialog();
  await page.selectOption('#exFmt', 'webm');
  check(`${rm}: dialog says the background stays clear`, /stays clear/.test(await page.textContent('#exHdrHint')), await page.textContent('#exHdrHint'));
  if (heavy) for (const f of ['prores4444', 'webm', 'gif', 'pngseq']) { const r = await run(f); out[f] = r.file; check(`export ${f} through the dialog`, !!r.file, r.st); }
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();

// 4. the HDR files: labels, 10-bit, upright 1080x1920, 120 fps, 240 frames, hvc1, no rotation left; luma vs the source
const area = (file, ss, n, pre = []) => { // n frames from ss: luma at 108x192 (area-averaged), 10-bit codes, with their times
  const r = spawnSync('ffmpeg', ['-v', 'info', ...pre, '-ss', String(ss), '-i', file, '-frames:v', String(n), '-vf', 'scale=108:192:flags=area,showinfo', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-'], { maxBuffer: 256 << 20 });
  const sz = 108 * 192 * 3, pts = [...r.stderr.toString().matchAll(/\] n:\s*\d+ pts:\s*\d+ pts_time:([\d.]+)/g)].map(m => +m[1]).slice(0, r.stdout.length / sz);
  return pts.map((t, i) => ({ t, y: Array.from({ length: 108 * 192 }, (_, j) => r.stdout.readUInt16LE(i * sz + j * 2)) }));
};
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const avcheck = () => avcheck.bin ??= (() => { // a tiny AVFoundation reader, compiled once (skipped without swiftc)
  fs.writeFileSync(`${TMP}/av.swift`, `import AVFoundation
let a = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1])), s = DispatchSemaphore(value: 0)
Task {
  do {
    let p = try await a.load(.isPlayable), t = try await a.loadTracks(withMediaType: .video)[0]
    let hdr = try await t.load(.mediaCharacteristics).contains(.containsHDRVideo), sz = try await t.load(.naturalSize), tf = try await t.load(.preferredTransform)
    let ext = CMFormatDescriptionGetExtensions(try await t.load(.formatDescriptions)[0]) as? [String: Any] ?? [:]
    let r = try AVAssetReader(asset: a), o = AVAssetReaderTrackOutput(track: t, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange])
    r.add(o); r.startReading(); var n = 0
    while o.copyNextSampleBuffer() != nil { n += 1 }
    print("playable \\(p), HDR \\(hdr), \\(Int(sz.width))x\\(Int(sz.height)) transform \\(tf.a),\\(tf.b),\\(tf.c),\\(tf.d), transfer \\(ext["CVImageBufferTransferFunction"] ?? "?"), decoded \\(n) frames, status \\(r.status.rawValue)")
  } catch { print("error \\(error)") }
  s.signal()
}
s.wait()
`);
  return spawnSync('swiftc', ['-O', '-o', `${TMP}/av`, `${TMP}/av.swift`]).status === 0 ? `${TMP}/av` : '';
})();
for (const hk of ['hlg', 'pq']) {
  const f = out[hk];
  if (!f) { check(`HDR ${hk} file`, false, 'no export'); continue; }
  const p = probe(f), v = p.streams[0];
  check(`HDR ${hk}: HEVC Main 10, hvc1, yuv420p10le, BT.2020 / ${hk === 'pq' ? 'PQ (smpte2084)' : 'HLG (arib-std-b67)'}, upright 1080x1920, 120 fps, 240 frames, no rotation`,
    v.codec_name === 'hevc' && v.profile === 'Main 10' && v.codec_tag_string === 'hvc1' && v.pix_fmt === 'yuv420p10le' && v.color_space === 'bt2020nc' && v.color_primaries === 'bt2020'
    && v.color_transfer === (hk === 'pq' ? 'smpte2084' : 'arib-std-b67') && v.width === 1080 && v.height === 1920 && v.r_frame_rate === '120/1' && +v.nb_read_frames === 240
    && !(v.side_data_list || []).some(d => d.rotation) && Math.abs(+p.format.duration - 2) < 0.05, JSON.stringify(v));
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  check(`HDR ${hk}: decodes end to end without errors`, dec.trim() === '', dec.slice(0, 200));
  if (avcheck()) { // what QuickTime sees: AVFoundation plays it, calls it HDR, reads every frame as 10-bit
    const a = spawnSync(avcheck(), [f], { encoding: 'utf8' }).stdout.trim();
    check(`HDR ${hk}: AVFoundation (QuickTime): playable, HDR, ${hk === 'pq' ? 'PQ' : 'HLG'}, upright, 240 frames`, new RegExp(`playable true, HDR true, 1080x1920 transform 1.0,0.0,0.0,1.0, transfer ${hk === 'pq' ? 'SMPTE_ST_2084_PQ' : 'ITU_R_2100_HLG'}, decoded 240 frames`).test(a), a);
  }
  if (hk !== 'hlg') continue;
  for (const n of [70, 100, 140, 180, 230]) { // after the fade: the source's 10-bit luma (best of its frames near that time: iPhone frames are VFR)
    const e = area(f, (n - 0.25) / 120, 1)[0].y, src = area(SRC, 2 + n / 120 - 0.02, 6);
    const best = src.map(s => ({ t: s.t, d: mean(s.y.map((x, i) => Math.abs(x - e[i]))) })).sort((a, b) => a.d - b.d)[0], s = src.find(x => x.t === best.t).y;
    const shift = (mean(e) - mean(s)) / 876, mad = best.d / 876, worst = Math.max(...s.map((x, i) => Math.abs(x - e[i]))) / 876;
    check(`HDR hlg frame ${n}: luma = the source's within 1 % of the 10-bit range`, Math.abs(shift) < 0.01 && mad < 0.01,
      `mean shift ${pct(shift)}, mean |d| ${pct(mad)}, worst 10x10 block ${pct(worst)}; mean Y ${mean(e).toFixed(1)} vs ${mean(s).toFixed(1)}`);
  }
  const e = area(f, (30 - 0.25) / 120, 1)[0].y, s = area(SRC, 2 + 30 / 120 - 0.02, 6).map(x => mean(x.y)), share = (mean(e) - 64) / (mean(s) - 64);
  check('HDR hlg frame 30: the fade (half way) is half the signal above black', share > 0.35 && share < 0.65, `(Y - 64) at ${share.toFixed(2)} of the source's`);
}

// 5. the transparent files: alpha in the format, 0 where nothing is, 255 on text / sticker / cut-out, frame counts
const rgbaAt = (file, n, W, dec = []) => { // frame n with its alpha; read at export-pixel coordinates (the GIF is 640 px wide)
  const r = ff([...dec, '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']).stdout, k = W / 1080;
  return (x, y) => { const i = (Math.round(y * k) * W + Math.round(x * k)) * 4; return [...r.subarray(i, i + 4)]; };
};
for (const [fmt, frames, kind] of [['prores4444', 90, 'yuva444p'], ['webm', 90, 'alpha_mode'], ['gif', 45, 'bgra'], ['pngseq', 90, 'rgba']]) {
  const f = out[fmt];
  if (!f) { check(`alpha ${fmt} file`, false, 'no export'); continue; }
  let pxk, info, n, dur, w;
  if (fmt === 'pngseq') {
    const names = execFileSync('unzip', ['-Z1', f], { encoding: 'utf8' }).trim().split('\n').filter(x => x.endsWith('.png')).sort();
    fs.writeFileSync(`${TMP}/f45.png`, execFileSync('unzip', ['-p', f, names[45]], { maxBuffer: 64 << 20 }));
    const v = probe(`${TMP}/f45.png`).streams[0];
    info = v.pix_fmt; n = names.length; dur = n / 30; w = `${v.width}x${v.height}`; pxk = rgbaAt(`${TMP}/f45.png`, 0, 1080);
  } else {
    const p = probe(f), v = p.streams[0];
    info = v.pix_fmt + (v.tags?.alpha_mode === '1' ? ' + alpha_mode 1' : ''); n = +v.nb_read_frames; dur = +p.format.duration; w = `${v.width}x${v.height}`;
    pxk = rgbaAt(f, Math.round(frames / 2), v.width, fmt === 'webm' ? ['-c:v', 'libvpx-vp9'] : []); // 1.5 s
  }
  let text = 0;
  for (let y = 740; y < 880; y += 2) for (let x = 100; x < 980; x += 2) { const q = pxk(x, y); if (q[3] === 255 && Math.min(q[0], q[1], q[2]) > 200) text++; }
  const clear = [pxk(5, 5), pxk(540, 1700), pxk(450, 1050)], stk = pxk(540, 384), cut = pxk(540, 1248);
  check(`${fmt}: alpha in the file (${info}), ${frames} frames, 3 s, clear = 0, text / sticker / cut-out = 255`, info.includes(kind) && n === frames && Math.abs(dur - 3) < 0.1
    && clear.every(c => c[3] === 0) && text > 50 && stk[3] === 255 && stk[2] > 180 && cut[3] === 255 && cut[0] > 180,
    `${w}, ${n} frames, ${dur.toFixed(2)} s; clear alpha ${clear.map(c => c[3]).join('/')}, ${text} opaque white text samples, sticker ${stk}, cut-out ${cut}`);
}

for (const id of mine) await api(`/api/media/${id}/trash`, {});
for (const pid of pids) await api(`/api/projects/${pid}/trash`, {});
if (!process.env.KEEP) for (const f of files) if (fs.existsSync(f)) fs.renameSync(f, `${HOME}/trash/${f.split('/').pop()}`);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
