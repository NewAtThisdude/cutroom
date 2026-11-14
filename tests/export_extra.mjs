// Export size caps + embedded subtitles. Run through run_all outside the restricted sandbox.
// Requires B and CUTROOM_HOME; seeds its own media, both motion modes, no personal library/4610.
import { browser } from './browser.mjs';
import { requireHome } from './runtime.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const B = process.env.B, HOME = requireHome();
if (!B || new URL(B).port === '4610') throw new Error('B must name a scratch server, never port 4610');
const OUT = path.join(HOME, 'export-extra-fixtures');
fs.mkdirSync(OUT, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}`); };
const ff = (name, args) => execFileSync(name, args, { maxBuffer: 128 << 20 });
const probe = f => JSON.parse(ff('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]));
const api = async (url, body) => {
  const r = await fetch(B + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
};
const noise = path.join(OUT, 'noise.mp4'), plain = path.join(OUT, 'plain.mp4');
ff('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=12,noise=alls=100:allf=t:all_seed=17',
  '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-crf', '8', '-c:a', 'aac', '-shortest', noise]);
ff('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x304050:s=1280x720:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', plain]);
const ids = {};
for (const [name, file] of Object.entries({ noise, plain })) ids[name] = (await api('/api/import_path', { path: file })).id;
const until = Date.now() + 120000;
for (;;) {
  const media = await api('/api/media');
  if (Object.values(ids).every(id => media.some(m => m.id === id && m.ready))) break;
  if (Date.now() > until) throw new Error('fixture preparation timed out');
  await new Promise(r => setTimeout(r, 250));
}
const SRT = '1\n00:00:00,500 --> 00:00:02,250\nHello from Cutroom\n\n2\n00:00:03,000 --> 00:00:05,125\nSecond line\n';
const srtCues = text => text.trim().replace(/\r/g, '').split(/\n\s*\n/).map(b => b.split('\n').slice(1).join('\n'));
const subText = (file, i) => ff('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:s:${i}`, '-f', 'srt', '-']).toString();
const pixels = (file, t = 1) => ff('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=320:180', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
const diff = (a, b) => { if (a.length !== b.length) return Infinity; let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
const b = await browser.launch({ headless: true });
try {
  for (const motion of ['no-preference', 'reduce']) {
    const ctx = await b.newContext({ viewport: { width: 1517, height: 1100 }, reducedMotion: motion }), page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const open = async () => {
      await page.goto(B + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof SET === 'object', null, { timeout: 30000 });
      if (await page.$('#tour')) await page.keyboard.press('Escape');
      await ev(() => loadMedia());
      await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids);
    };
    await open();
    const fresh = async media => ev(async ({ media, SRT }) => {
      await REMOTE.new_project({ ratio: '16:9', name: 'Export extra scratch' });
      await REMOTE.set_project({ set: { fps: 24 } });
      await REMOTE.add_clip({ media });
      importSubs(SRT, 'extra.srt');
      change(() => {
        P.captionLanguage = 'eng'; P.translationLanguage = 'spa';
        P.capStyle = { ...capPreset('Subtitle'), bi: true, y: 0.72 };
        P.captions.forEach((c, i) => { c.tr = i ? 'Segunda línea' : 'Hola desde Cutroom'; c.lang = 'eng'; c.trLang = 'spa'; });
      });
      undo.length = 0; redo.length = 0;
    }, { media, SRT });
    await fresh(ids.noise);
    await page.click('#btnExport');
    check(`${motion}: old project defaults to burned captions and no cap`, await ev(() => $('#exSubs').value === 'burned' && $('#exFit').value === 'off'));
    await page.selectOption('#exFit', 'discord');
    check(`${motion}: size preference is one undo step`, await ev(() => undo.length === 1 && P.exportExtra.fit === 'discord'));
    check(`${motion}: undo and redo restore export preferences`, await ev(() => { restore(undo, redo); const absent = !P.exportExtra; restore(redo, undo); return absent && P.exportExtra.fit === 'discord'; }));
    await page.selectOption('#exSubs', 'file');
    await ev(() => saveNow());
    const pid = await ev(() => P.id);
    await open(); await ev(id => openProject(id), pid); await page.click('#btnExport');
    check(`${motion}: saved size/subtitle preferences reload`, await ev(() => $('#exFit').value === 'discord' && $('#exSubs').value === 'file'));

    const run = async ({ format = 'mp4', fit = 'off', mb = 10, subtitles = 'file', res = '720p', name = 'extra', quality = 'best' } = {}) => {
      await ev(() => { if (!$('#exFmt')) openExport(); });
      await page.selectOption('#exPreset', ''); await page.selectOption('#exFmt', format);
      await page.selectOption('#exRes', String(await ev(r => exportSizes().findIndex(x => x[0] === r), res)));
      if (await page.isEnabled('#exQ')) await page.selectOption('#exQ', quality);
      await page.selectOption('#exFit', fit);
      if (fit === 'custom') { await page.fill('#exFitMB', String(mb)); await page.locator('#exFitMB').blur(); }
      await page.selectOption('#exSubs', subtitles);
      await page.fill('#exName', `${motion} ${name}`);
      await ev(() => { $('#exLoud').value = 'off'; $('#exHdr').value = 'sdr'; });
      await page.click('#exGo');
      await page.waitForFunction(() => !S.exporting && /Saved|failed/.test($('#exStatus')?.textContent || ''), null, { timeout: 900000 });
      const status = await page.textContent('#exStatus');
      if (!status.startsWith('Saved')) throw new Error(status);
      const job = await ev(() => S.q.at(-1).job), result = await api(`/api/jobs/${job}`), file = path.join(HOME, 'exports', result.file);
      check(`${motion}: result reports exact final bytes`, result.bytes === fs.statSync(file).size && status.includes('bytes'), `${result.bytes}`);
      return { file, result, info: probe(file), status };
    };

    for (const [fit, mb] of [['discord', 10], ['nitro', 50], ['email', 25], ['whatsapp', 100]]) {
      const r = await run({ fit, name: fit });
      const v = r.info.streams.find(s => s.codec_type === 'video');
      check(`${motion}: ${fit} is 90–100% of ${mb} MB`, r.result.bytes <= mb * 1e6 && r.result.bytes >= mb * 0.9e6, `${r.result.bytes} bytes`);
      check(`${motion}: ample bitrate preserves selected resolution`, v.width === 1280 && v.height === 720 && !r.result.notes.some(n => /Resolution lowered/.test(n)), `${v.width}x${v.height}`);
    }
    const small = await run({ fit: 'custom', mb: 0.5, res: '1080p', name: 'small' }), sv = small.info.streams.find(s => s.codec_type === 'video');
    check(`${motion}: low budget lowers resolution and explains it`, small.result.bytes <= 500000 && sv.height < 1080 && /Resolution lowered/.test(small.status), `${small.result.bytes} bytes, ${sv.width}x${sv.height}`);
    const refusal = await api('/api/export', { w: 1920, h: 1080, fps: 24, duration: 7200, format: 'mp4', targetBytes: 10000000, bg: '#000000', main: [] }).then(() => '', e => e.message);
    check(`${motion}: impossible target refused in words`, /cannot fit/.test(refusal) && /larger size|shorten/.test(refusal), refusal);

    await page.keyboard.press('Escape'); await fresh(ids.plain);
    await ev(() => REMOTE.add_text({ text: 'Title stays', start: 0, duration: 6, y: 0.18 }));
    const sidecar = await ev(async () => { const file = await saveSRT('extra reference'); return { file, text: toSRT(), translation: subtitleText(subtitleTracks()[1].cues) }; });
    check(`${motion}: reference sidecar has original cue text/times`, JSON.stringify(srtCues(fs.readFileSync(path.join(HOME, 'exports', sidecar.file), 'utf8'))) === JSON.stringify(srtCues(SRT)));
    const files = {};
    for (const [format, codec] of [['mp4', 'mov_text'], ['prores', 'mov_text'], ['webm', 'webvtt'], ['mkv', 'subrip']]) {
      const r = await run({ format, name: format }); files[format] = r.file;
      const streams = r.info.streams.filter(s => s.codec_type === 'subtitle');
      check(`${motion}: ${format} has two ${codec} streams, tags and first default`, streams.length === 2 && streams.every(s => s.codec_name === codec) && streams.map(s => s.tags.language).join(',') === 'eng,spa' && streams.map(s => s.disposition.default).join(',') === '1,0');
      for (const [i, expected] of [sidecar.text, sidecar.translation].entries()) check(`${motion}: ${format} track ${i} matches sidecar cues`, JSON.stringify(srtCues(subText(r.file, i))) === JSON.stringify(srtCues(expected)));
    }
    const burned = await run({ subtitles: 'burned', name: 'burned' });
    const both = await run({ subtitles: 'both', name: 'both' });
    const off = await run({ subtitles: 'off', name: 'off' });
    check(`${motion}: both stores tracks and the same burned pixels`, both.info.streams.filter(s => s.codec_type === 'subtitle').length === 2 && diff(pixels(both.file), pixels(burned.file)) < 0.5);
    check(`${motion}: off and soft-only preserve titles but omit burned captions`, !off.info.streams.some(s => s.codec_type === 'subtitle') && diff(pixels(off.file), pixels(files.mp4)) < 0.5 && diff(pixels(off.file), pixels(burned.file)) > 1);
    // Same preview renderer at a frame with both language lines; compare the actual encoded picture.
    const pv = await ev(() => REMOTE.snapshot({ t: 1, max: 1280, preview: true })), png = path.join(OUT, `${motion}-preview.png`);
    fs.writeFileSync(png, Buffer.from(pv.image, 'base64'));
    check(`${motion}: preview matches burned export`, diff(pixels(png, 0), pixels(burned.file)) < 4);
    // Force the page fallback too: workers and fallback must both omit only captions in soft-only mode.
    await ev(() => { S.layerForce = 'page'; });
    const fallback = await run({ subtitles: 'file', name: 'fallback' });
    check(`${motion}: soft-only page fallback matches workers`, diff(pixels(fallback.file), pixels(files.mp4)) < 0.5);
    await ev(() => { S.layerForce = undefined; });
    const gif = await run({ format: 'gif', subtitles: 'off', fit: 'custom', mb: 0.1, name: 'gif' });
    check(`${motion}: GIF fits and reports palette/fps/dimensions`, gif.result.bytes <= 100000 && /GIF fitted/.test(gif.status));
    check(`${motion}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} finally { await b.close(); }
console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exitCode = checks.every(Boolean) ? 0 : 1;
