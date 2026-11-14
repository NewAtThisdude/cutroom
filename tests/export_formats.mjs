// Export formats + settings, through the real dialog in headless WebKit, on a 10 s mixed 60 fps project (real iPhone 4K HLG
// clip + a synthetic 4K60 clip on the main track, a 1080p picture-in-picture, a title, captions):
//   presets fill the fields (still editable), the 8K / fps / 9:16 notes, which settings each format enables (both motion modes);
//   then real exports: H.264 (the reference), AV1 MP4, AV1 WebM, VP9 WebM, AAC M4A, MP3, WAV: ffprobe codec / pix_fmt / colour tags /
//   fps / frames / length and PSNR vs H.264; 120 fps from the 60 fps project (each frame twice); 8K of the 4K sources; a custom
//   bitrate; SRT / VTT / TXT round-trip through the subtitle importer; the MCP export with preset + fps + light.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> [SERVER_PID=<pid>] [LOW_B=<same lib, CUTROOM_RAM_GB=8>] node export_formats.mjs [quick]   (never 4610)
import { browser } from './browser.mjs';
import { cachedMedia, ensurePhoneFixture } from './fixtures.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const B = process.env.B || 'http://127.0.0.1:4732', HOME = process.env.CUTROOM_HOME, QUICK = process.argv[2] === 'quick';
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const EXP = `${HOME}/exports`, PHONE = ensurePhoneFixture();
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (route, body) => {
  const response = await fetch(B + route, { ...(body ? { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'X-Cutroom': '1' } }), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`${route}: ${result.error || response.status}`);
  return result;
};
const ff = (bin, args, opt = {}) => execFileSync(bin, args, { maxBuffer: 1 << 28, ...opt });
const probe = f => JSON.parse(ff('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', f]).toString());
const psnr = (a, b, fps, scale = '') => { // by frame number (WebM's 1 ms clock), the first file scaled to the second's size when asked
  const e = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', a, '-i', b, '-lavfi', `[0]settb=1/${fps},setpts=N${scale}[a];[1]settb=1/${fps},setpts=N[b];[a][b]psnr`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return +(/average:([\d.]+|inf)/.exec(e)?.[1] || '0').replace('inf', '99');
};
const small = f => { const raw = ff('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']), n = 64 * 36, out = []; for (let i = 0; i + n <= raw.length; i += n) out.push(raw.subarray(i, i + n)); return out; };
const dif = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// Cached synthetic sources, plus PHONE or a generated HLG HEVC source. The SDR source
// keeps the format/settings checks running if this ffmpeg cannot encode HEVC.
const up = async file => {
  const item = await api('/api/import_path', { path: file });
  if (!item.id) throw new Error(`import returned no media id: ${path.basename(file)}`);
  return item.id;
};
const ids = {
  k4: await up(cachedMedia('formats-4k60-v1.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=60:d=5', '-f', 'lavfi', '-i', 'sine=f=330:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])),
  pip: await up(cachedMedia('formats-pip-v1.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=1920x1080:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])),
};
ids.phone = PHONE ? await up(PHONE) : ids.k4;
// Check preparation outside the page so invalid ids and failed imports cannot turn
// into the former three-minute wait for M.get(undefined).
const readyUntil = Date.now() + 120000;
for (;;) {
  // A media JSON file can be briefly unreadable while preparation writes it.
  const response = await fetch(B + '/api/media', { headers: { 'X-Cutroom': '1' }, signal: AbortSignal.timeout(30000) });
  const media = response.ok ? await response.json() : [];
  if (Object.values(ids).every(id => media.find(m => m.id === id)?.ready)) break;
  const broken = media.find(m => Object.values(ids).includes(m.id) && m.error);
  if (broken || Date.now() > readyUntil) throw new Error(`format fixture preparation failed: ${broken?.error || 'timed out after 120 seconds'}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

const b = await browser.launch();
let page, ev, errs;
const open = async (rm, base = B) => {
  page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  ev = (f, a) => page.evaluate(f, a);
  await ev(() => loadMedia());
  await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 20000 });
};
const SRT = '1\n00:00:00,500 --> 00:00:02,250\nHello from Cutroom\n\n2\n00:00:03,000 --> 00:00:05,125\nSecond line, with a comma\n\n3\n00:00:06,000 --> 00:00:09,500\nThe end\n';
const build = () => ev(async ({ ids, SRT }) => { // the 10 s mixed project
  await REMOTE.new_project({ ratio: '16:9', name: 'Formats test (scratch)' });
  await REMOTE.set_project({ set: { fps: 60 } });
  await REMOTE.add_clip({ media: ids.phone, in: 0, out: 5 });
  await REMOTE.add_clip({ media: ids.k4, in: 0, out: 5 });
  const pip = await REMOTE.add_clip({ media: ids.pip, lane: 'overlay', start: 2, in: 0, out: 3 });
  await REMOTE.update_clip({ id: pip.id, set: { scale: 0.35, x: 0.25, y: -0.2 } });
  await REMOTE.add_text({ text: 'Formats', start: 1, duration: 3 });
  importSubs(SRT, 'test.srt');
  return REMOTE.status();
}, { ids, SRT });

// ---- the dialog, both motion modes
for (const rm of ['no-preference', 'reduce']) {
  await open(rm);
  const st = await build();
  check(`${rm}: 10 s mixed project at 60 fps`, Math.abs(st.project.duration - 10) < 0.02 && st.project.fps === 60 && st.clips.main === 2 && st.clips.overlay === 1 && st.clips.captions === 3, JSON.stringify(st.clips) + ` ${st.project.duration} s`);
  await page.click('#btnExport'); await page.waitForSelector('#exPreset');
  const val = () => ev(() => ({ res: exportSizes()[+$('#exRes').value][0], fmt: $('#exFmt').value, q: $('#exQ').value, fps: +$('#exFps').value, rate: $('#exRate').value, mbps: +$('#exMbps').value, loud: $('#exLoud').value !== 'off', hint: $('#exHint').textContent, mbpsShown: getComputedStyle($('#exMbpsRow')).display !== 'none', cancelShown: getComputedStyle($('#exCancel')).display !== 'none' }));
  let v;
  const want = { tiktok: ['1080p', 'mp4', 60, 15, true], reels: ['1080p', 'mp4', 60, 12, true], shorts: ['1080p', 'mp4', 60, 12, true], yt1080: ['1080p', 'mp4', 60, 12, true], yt4k: ['4K', 'mp4', 60, 68, true], master: ['4K', 'prores', 0, null, false] };
  for (const [k, [r, f, fps, mbps, loud]] of Object.entries(want)) {
    await page.selectOption('#exPreset', k);
    v = await val();
    const ok = v.res === r && v.fmt === f && v.fps === fps && v.loud === loud && (mbps ? v.rate === 'custom' && v.mbps === mbps && v.mbpsShown : v.rate !== 'custom');
    check(`${rm}: preset ${k} fills the fields`, ok, `${v.res} ${v.fmt} ${v.fps || 'project'} fps ${v.rate === 'custom' ? v.mbps + ' Mbps' : v.rate} loud ${v.loud}`);
    if (['tiktok', 'reels', 'shorts'].includes(k)) check(`${rm}: ${k} says the 16:9 project is not 9:16`, /wants a vertical 9:16 canvas/.test(v.hint), v.hint.slice(-90));
  }
  await page.selectOption('#exPreset', ''); await page.selectOption('#exFmt', 'mp4'); await page.selectOption('#exRate', '1');
  v = await val();
  check(`${rm}: Mbps field and Cancel export hidden while Standard / idle`, !v.mbpsShown && !v.cancelShown, `mbps ${v.mbpsShown} cancel ${v.cancelShown}`);
  await page.selectOption('#exPreset', 'tiktok');
  await page.selectOption('#exRes', String(await ev(() => exportSizes().findIndex(x => x[0] === '720p'))));
  await page.selectOption('#exFps', '30'); await page.fill('#exMbps', '6');
  v = await val();
  check(`${rm}: after a preset every field can still be changed`, v.res === '720p' && v.fps === 30 && v.mbps === 6 && /6 Mbps/.test(v.hint), `${v.res} ${v.fps} ${v.mbps} | ${v.hint.slice(0, 60)}`);
  await page.selectOption('#exPreset', ''); await page.selectOption('#exFmt', 'mp4');
  await page.selectOption('#exRes', String(await ev(() => exportSizes().findIndex(x => x[0] === '8K'))));
  v = await val();
  const opts = await ev(() => [...$('#exRes').options].map(o => o.textContent));
  check(`${rm}: 8K offered (7680×4320), above the 4K sources with a note`, opts.some(o => /8K · 7680×4320/.test(o)) && /above the largest source \((3840×2160|2160×3840)\)/.test(v.hint) && /x264/.test(v.hint), v.hint);
  await page.selectOption('#exFps', '120'); v = await val();
  check(`${rm}: 120 fps from 60 says it repeats frames`, /120 fps from a 60 fps project repeats frames/.test(v.hint), v.hint.slice(0, 120));
  const dis = {};
  for (const f of ['mp4', 'av1', 'av1webm', 'webm', 'prores', 'gif', 'png', 'm4a', 'mp3', 'wav', 'srt', 'vtt', 'txt']) {
    await page.selectOption('#exFmt', f);
    dis[f] = await ev(() => ['#exRes', '#exFps', '#exRate', '#exLoud', '#exLight', '#exQ'].map(s => $(s).disabled ? 0 : 1).join(''));
  }
  // res fps rate loud light q: 1 = enabled
  const wantDis = { mp4: '111111', av1: '111110', av1webm: '111110', webm: '111110', prores: '110110', gif: '100010', png: '100010', m4a: '000100', mp3: '000100', wav: '000100', srt: '000000', vtt: '000000', txt: '000000' };
  check(`${rm}: each format enables only its settings`, Object.entries(wantDis).every(([f, w]) => dis[f] === w), JSON.stringify(Object.fromEntries(Object.entries(dis).filter(([f, w]) => wantDis[f] !== w))));
  check(`${rm}: no page errors (dialog)`, errs.length === 0, errs.slice(0, 2).join(' | '));
  if (rm === 'reduce') break;
  const pid0 = await ev(() => P.id);
  await page.context().close();
  await api(`/api/projects/${pid0}/trash`, {}).catch(() => {});
}

// ---- real exports through the dialog (reduced-motion page, the one left open)
const run = async (o, label) => { // o: {fmt, res, fps, mbps}
  await ev(() => { if (!document.querySelector('#exFmt')) openExport(); });
  await page.selectOption('#exPreset', '');
  await page.selectOption('#exFmt', o.fmt);
  if (o.res) await page.selectOption('#exRes', String(await ev(r => exportSizes().findIndex(x => x[0] === r), o.res)));
  if (o.fps !== undefined) await page.selectOption('#exFps', String(o.fps));
  if (o.mbps) { await page.selectOption('#exRate', 'custom'); await page.fill('#exMbps', String(o.mbps)); } else await ev(() => { $('#exRate').value = '1'; $('#exRate').dispatchEvent(new Event('change')); });
  await ev(() => { $('#exLoud').value = 'off'; });
  await page.fill('#exName', `fmt ${label}`);
  const t0 = Date.now();
  await page.click('#exGo');
  await page.waitForFunction(() => !S.exporting && /Saved|failed/.test(document.querySelector('#exStatus')?.textContent || ''), null, { timeout: 900000 });
  const s = await page.textContent('#exStatus'), file = /Saved (.+?) in /.exec(s)?.[1];
  return { file: file && `${EXP}/${file}`, secs: (Date.now() - t0) / 1000, status: s };
};
const vinfo = f => { const j = probe(f), v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.find(s => s.codec_type === 'audio'); return { j, v, a, dur: +j.format.duration }; };
const ref = await run({ fmt: 'mp4', res: '1080p', fps: 0 }, 'h264');
const R = vinfo(ref.file);
check('H.264 reference: 1920x1080 60 fps 600 frames 10 s', R.v.codec_name === 'h264' && R.v.width === 1920 && +R.v.nb_read_frames === 600 && R.v.avg_frame_rate === '60/1' && Math.abs(R.dur - 10) < 0.05, `${R.v.width}x${R.v.height} ${R.v.nb_read_frames} ${R.v.avg_frame_rate} ${R.dur} s, ${ref.secs.toFixed(1)} s`);
const speed = { h264: ref.secs };
for (const [fmt, vc, ac, ext] of [['av1', 'av1', 'aac', '.mp4'], ['av1webm', 'av1', 'opus', '.webm'], ['webm', 'vp9', 'opus', '.webm']]) {
  const r = await run({ fmt, res: '1080p', fps: 0 }, fmt);
  if (!r.file) { check(`${fmt}: exported`, false, r.status); continue; }
  const x = vinfo(r.file), db = psnr(r.file, ref.file, 60);
  speed[fmt] = r.secs;
  const got = [x.v.codec_name, x.v.pix_fmt, x.v.color_space, x.v.color_primaries, x.v.color_transfer, +x.v.nb_read_frames, x.v.avg_frame_rate, x.a?.codec_name].join(' ');
  check(`${fmt}: ${vc}+${ac} ${ext}, yuv420p bt709, 600 frames at 60 fps, 10 s, PSNR vs H.264 >= 38 dB`, r.file.endsWith(ext) && got === `${vc} yuv420p bt709 bt709 bt709 600 60/1 ${ac}` && Math.abs(x.dur - 10) < 0.05 && db >= 38,
    `${got}, ${x.dur.toFixed(3)} s, ${db.toFixed(1)} dB, ${(fs.statSync(r.file).size / 1e6).toFixed(1)} MB, ${r.secs.toFixed(1)} s`);
}
console.log(`speed (10 s of 1080p60 incl. the text layer; x6 = one minute): ${Object.entries(speed).map(([k, s]) => `${k} ${s.toFixed(1)} s (${(s * 6 / 60).toFixed(1)} min per minute)`).join(', ')}`);
for (const [fmt, ac, ext] of [['m4a', 'aac', '.m4a'], ['mp3', 'mp3', '.mp3'], ['wav', 'pcm_s16le', '.wav']]) {
  const r = await run({ fmt }, fmt);
  const x = r.file && probe(r.file), a = x?.streams.find(s => s.codec_type === 'audio');
  check(`${fmt}: sound only (${ac}), 10 s`, r.file?.endsWith(ext) && x.streams.length === 1 && a.codec_name === ac && Math.abs(+x.format.duration - 10) < 0.06 && (fmt !== 'm4a' || +a.bit_rate > 200e3),
    `${r.file ? `${a.codec_name} ${a.bit_rate} b/s ${(+x.format.duration).toFixed(3)} s` : r.status}`);
}
const hfps = await run({ fmt: 'mp4', res: '1080p', fps: 120 }, '120fps');
{
  const x = vinfo(hfps.file), A = small(hfps.file), Rf = small(ref.file);
  let worst = 0, k0 = 0; for (let k = 0; k < A.length; k++) { const d = dif(A[k], Rf[k >> 1]); if (d > worst) { worst = d; k0 = k; } }
  let alt = 0; for (let k = 1; k < A.length; k += 2) alt += dif(A[k], Rf[Math.min(Rf.length - 1, (k >> 1) + 1)]);
  alt /= A.length / 2;
  check('120 fps from the 60 fps project: 1200 frames, frames 2k and 2k+1 both = project frame k', x.v.avg_frame_rate === '120/1' && +x.v.nb_read_frames === 1200 && Math.abs(x.dur - 10) < 0.05 && worst < 2.5 && alt > worst / 2,
    `${x.v.avg_frame_rate} ${x.v.nb_read_frames} frames ${x.dur.toFixed(3)} s, worst ${worst.toFixed(2)}/255 at frame ${k0}, mean vs the NEXT project frame ${alt.toFixed(2)}`);
}
const cb = await run({ fmt: 'hevc', res: '1080p', fps: 0, mbps: 4 }, 'custom bitrate');
{ const x = vinfo(cb.file), kb = +x.v.bit_rate / 1000; check('custom bitrate 4 Mbps (HEVC): within 30 % (VideoToolbox averages loosely over 10 s)', kb > 2800 && kb < 5200, `${kb.toFixed(0)} kb/s`); }
for (const kind of ['srt', 'vtt', 'txt']) { // subtitles out and back in
  const r = await run({ fmt: kind }, `subs ${kind}`), txt = fs.readFileSync(r.file, 'utf8');
  const back = await ev(t => { const keep = P.captions, before = keep.map(c => [c.start, c.dur, c.text]); const n = importSubs(t, 'x'); const after = P.captions.map(c => [c.start, c.dur, c.text]); P.captions = keep; return { n, before, after }; }, txt);
  const same = back.n === 3 && back.after.every((c, i) => Math.abs(c[0] - back.before[i][0]) < 0.0011 && Math.abs(c[1] - back.before[i][1]) < 0.0011 && c[2] === back.before[i][2]);
  check(`${kind}: exported and imported back: same 3 cues, times within 1 ms`, r.file?.endsWith(`.${kind}`) && same && (kind !== 'vtt' || txt.startsWith('WEBVTT')), JSON.stringify(txt.split('\n').slice(0, kind === 'txt' ? 1 : 4)));
}
if (!QUICK) { // 8K of the 4K sources (ffmpeg memory watched when SERVER_PID is given)
  let peak = 0;
  const pid = process.env.SERVER_PID, watch = pid && process.platform !== 'win32' && setInterval(() => {
    try { const kids = ff('pgrep', ['-P', pid]).toString().trim().split('\n'); const rss = ff('ps', ['-o', 'rss=', '-p', kids.join(',')]).toString().trim().split('\n').reduce((s, x) => s + +x, 0); peak = Math.max(peak, rss); } catch { /* none running */ }
  }, 500);
  const r = await run({ fmt: 'mp4', res: '8K', fps: 0 }, '8k');
  if (watch) clearInterval(watch);
  if (!r.file) check('8K export of the 4K sources (or refused for memory)', /memory/.test(r.status), r.status);
  else {
    const x = vinfo(r.file), db = psnr(r.file, ref.file, 60, ',scale=1920:1080:flags=area');
    check('8K export of the 4K sources: 7680x4320 h264, 600 frames, 10 s; shrunk to 1080p it is within 35 dB of the 1080p export', x.v.width === 7680 && x.v.height === 4320 && +x.v.nb_read_frames === 600 && Math.abs(x.dur - 10) < 0.05 && db >= 35, // up then down: resampled twice
      `${x.v.codec_name} ${x.v.width}x${x.v.height} ${x.v.nb_read_frames} ${x.dur.toFixed(3)} s, ${db.toFixed(1)} dB, ${(fs.statSync(r.file).size / 1e6).toFixed(0)} MB, ${r.secs.toFixed(0)} s${peak ? `, ffmpeg peak ${(peak / 1048576).toFixed(1)} GB` : ''}`);
  }
}
// the MCP export: a preset fills what the call leaves out; fps / light go through
await ev(() => closeModal());
const m = await ev(() => REMOTE.export({ preset: 'shorts', resolution: '720p', fps: 30, light: true, name: 'fmt mcp' }).catch(e => ({ error: e.message })));
if (m.error) check('MCP export with a preset', false, m.error);
else {
  const x = vinfo(`${EXP}/${m.file}`);
  check('MCP export: preset shorts at 720p, fps 30, light: 1280x720 30 fps 300 frames, 12 Mbps asked', x.v.width === 1280 && x.v.avg_frame_rate === '30/1' && +x.v.nb_read_frames === 300 && m.mbps === 12 && m.fps === 30, `${x.v.width}x${x.v.height} ${x.v.avg_frame_rate} ${x.v.nb_read_frames}, ${JSON.stringify(m)}`);
}
const bad = await ev(() => REMOTE.export({ fps: 33 }).catch(e => e.message));
check('MCP export refuses fps 33 with the valid list', /fps must be one of 24, 25, 30, 50, 60, 120/.test(String(bad)), String(bad));
check('no page errors (exports)', errs.length === 0, errs.slice(0, 2).join(' | '));
const pids = [await ev(() => P.id)];
if (process.env.LOW_B) { // a second server on the same library started with CUTROOM_RAM_GB=8: 8K is refused with the reason, in the dialog
  await open('reduce', process.env.LOW_B); await build(); pids.push(await ev(() => P.id));
  const r = await run({ fmt: 'mp4', res: '8K', fps: 0 }, '8k low');
  check('8K on an 8 GB Mac: refused in the dialog with the reason', !r.file && /needs a Mac with 16 GB of memory \(this one has 8 GB\): choose 4K/.test(r.status), r.status);
}
// the scratch projects go to the trash (by id) after the browser closed (its pagehide save would bring them back)
await b.close();
for (const id of pids) await api(`/api/projects/${id}/trash`, {}).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
