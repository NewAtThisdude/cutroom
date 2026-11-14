// Export for every platform + the export queue, in headless WebKit, both motion modes. One 4 s 9:16 project (a 16:9 clip
// filled, a picture-in-picture from 2 s, a title near the bottom from 1 to 3 s) exported as 9:16 + 1:1 + 16:9 in one go:
//   no-preference: through the Export dialog ("Also export as" ticked, the dialog closed while they render: the Exports panel
//   carries on); reduce: through REMOTE.export({also}). Each file: its size, 120 frames, 4 s, sound; the main clip filled
//   around the centre (PSNR against the source cropped that way); the title inside the frame. The three render one after
//   another (the server's start / end times), and cancelling a queued one (its panel button) removes only it.
//   Also the layout rule itself (reshape): a reframe-style path keeps its subject, a picture-in-picture scales with the short side.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node platforms.mjs   (never 4610)
import { browser } from './browser.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4711', HOME = process.env.CUTROOM_HOME, OUT = process.env.CUTROOM_SCRATCH || os.tmpdir();
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const EXP = `${HOME}/exports`, res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (path, body) => (await fetch(B + path, body ? { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'X-Cutroom': '1' } })).json();
const ff = (bin, args) => execFileSync(bin, args, { maxBuffer: 1 << 28 });
const probe = f => JSON.parse(ff('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', f]).toString());
const loud = f => +(spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+)/)?.[1] ?? -99);
const gray = (f, t, w, h, vf = '') => ff('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', `${vf}${vf ? ',' : ''}scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-']);
const psnr = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return 10 * Math.log10(255 ** 2 / Math.max(1e-9, s / a.length)); };

// media: smpte bars (static, so a frame difference is the title) with a tone, and a picture for the picture-in-picture
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-platforms-`);
const SRC = `${tmp}/platforms-bars.mp4`, PIC = `${tmp}/platforms-pip.png`;
ff('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080:r=30:d=5', '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);
ff('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=1', '-frames:v', '1', PIC]);
const up = async f => (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id;
const ids = { bars: await up(SRC), pic: await up(PIC) };

const b = await browser.launch();
const done = [];
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  await ev(() => loadMedia());
  await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 120000 });
  const name = `Platforms ${rm}`;
  const st = await ev(async ({ ids, name }) => {
    await REMOTE.new_project({ ratio: '9:16', name });
    await REMOTE.set_project({ set: { fps: 30 } });
    const m = await REMOTE.add_clip({ media: ids.bars, in: 0, out: 4 });
    await REMOTE.update_clip({ id: m.id, set: { fit: 'fill' } });
    const o = await REMOTE.add_clip({ media: ids.pic, lane: 'overlay', start: 2, in: 0, out: 2 });
    await REMOTE.update_clip({ id: o.id, set: { scale: 0.4, x: 0.2, y: -0.3 } });
    await REMOTE.add_text({ text: 'Every platform', start: 1, duration: 2, y: 0.85 });
    return REMOTE.status();
  }, { ids, name });
  check(`${rm}: 4 s 9:16 project`, Math.abs(st.project.duration - 4) < 0.02 && st.clips.main === 1 && st.clips.overlay === 1 && st.clips.text === 1, `${JSON.stringify(st.clips)} ${st.project.duration} s`);

  if (rm === 'no-preference') { // the layout rule, on copies (reshape never touches the project)
    const r = await ev(() => {
      const c = P.main[0], m = M.get(c.media), p0 = structuredClone(P);
      p0.main[0].kf = [{ t: 0, scale: 1, x: 0.3, y: 0, opacity: 1, rot: 0 }, { t: 3, scale: 1, x: -0.9, y: 0, opacity: 1, rot: 0 }]; // a reframe-style pan
      const u = (p, f) => { const g = geom(m, p.main[0], p.w, p.h, { scale: 1, x: 0, y: 0 }); return 0.5 - f.x / (g.w / p.w); }; // the source point at the canvas centre
      const q = reshape(p0, 1080, 1080), o0 = p0.overlay[0], o1 = q.overlay[0], mo = M.get(o0.media);
      const w0 = geom(mo, o0, p0.w, p0.h).w, w1 = geom(mo, o1, 1080, 1080, { scale: o1.scale, x: o1.x, y: o1.y }).w, z = reshape(p0, 1920, 1080);
      return { u0: u(p0, p0.main[0].kf[0]), u1: u(q, q.main[0].kf[0]), x2: q.main[0].kf[1].x, lim: (geom(m, q.main[0], 1080, 1080, { scale: 1, x: 0, y: 0 }).w / 1080 - 1) / 2,
        wide: z.main[0].kf.map(f => f.x), ow: [w0, w1], oxy: [o1.x, o1.y], same: JSON.stringify(P.main[0].kf || null) };
    });
    check('reshape: a reframe-style path keeps the source point at the centre', Math.abs(r.u0 - r.u1) < 1e-9, `${r.u0.toFixed(4)} -> ${r.u1.toFixed(4)}`);
    check('reshape: past the new canvas it stops at the edge (no bars)', Math.abs(r.x2 + r.lim) < 1e-9, `${r.x2.toFixed(4)} vs ${r.lim.toFixed(4)}`);
    check('reshape: at 16:9 a 16:9 fill clip shows the whole picture', r.wide.every(x => x === 0), r.wide.join(', '));
    check('reshape: the picture-in-picture keeps its place and scales with the short side', Math.abs(r.ow[0] - r.ow[1]) < 1e-6 && r.oxy[0] === 0.2 && r.oxy[1] === -0.3, `${r.ow.map(Math.round).join(' -> ')} px, at ${r.oxy}`);
    check('reshape: the project itself is untouched', r.same === 'null', r.same);
  }

  const n0 = await ev(() => S.q.length);
  let rows;
  if (rm === 'no-preference') { // the dialog: tick 1:1 and 16:9, export, close the dialog while they render
    await page.click('#btnExport'); await page.waitForSelector('#exAlso');
    const shapes = await ev(() => $$('#exAlso input').map(x => x.value));
    check('dialog: Also export as offers the other shapes', shapes.join() === '16:9,1:1,4:5', shapes.join());
    await page.selectOption('#exRes', String(await ev(() => exportSizes().findIndex(x => x[0] === '720p'))));
    await page.fill('#exName', name);
    await page.check('#exAlso input[value="1:1"]'); await page.check('#exAlso input[value="16:9"]');
    check('dialog: the hint says where they go', /Exports panel/.test(await page.textContent('#exHint')));
    await page.selectOption('#exFmt', 'wav');
    check('dialog: shapes are off for a sound-only format', await ev(() => $$('#exAlso input').every(x => x.disabled)));
    await page.selectOption('#exFmt', 'mp4');
    await page.click('#exGo');
    await page.waitForFunction(n => S.q.length === n + 3, n0, { timeout: 60000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('panel: stays when the dialog closes, one row per export', await ev(() => $('#modal').hidden && !$('#exq').hidden && $$('#exq .qrow').length === 3));
    await page.screenshot({ path: `${OUT}/platforms-${rm}.png` });
    await page.waitForFunction(n => S.q.slice(n).every(q => q.st.state !== 'running'), n0, { timeout: 300000 });
    rows = await ev(n => S.q.slice(n).map(q => ({ shape: q.row.querySelector('small').textContent.split(' · ')[0], ...q.st, say: q.say.textContent, reveal: !q.reveal.hidden })), n0);
  } else {
    const r = await ev(name => REMOTE.export({ resolution: '720p', name, also: ['1:1', '16:9'] }), name);
    check('REMOTE.export: also lists the extra files', r.also?.length === 2 && r.also[0].shape === '1:1' && r.also[0].size === '720x720' && r.also[1].size === '1280x720', JSON.stringify(r.also));
    rows = await ev(n => S.q.slice(n).map(q => ({ shape: q.row.querySelector('small').textContent.split(' · ')[0], ...q.st, say: q.say.textContent, reveal: !q.reveal.hidden })), n0);
  }
  check(`${rm}: three exports, all saved, Show in Finder on each`, rows.length === 3 && rows.every(x => x.state === 'done' && /^Saved( · |$)/.test(x.say) && x.reveal), rows.map(x => `${x.shape} ${x.state} ${x.say}`).join(' | '));
  const order = rows.map((x, i) => i && x.started - rows[i - 1].ended).slice(1);
  check(`${rm}: one after another (each starts after the one before ends)`, rows.every(x => x.started && x.ended) && order.every(g => g >= -0.01), order.map(g => `${g.toFixed(2)} s`).join(', '));
  const want = { '9:16': [720, 1280, 'crop=ih*9/16:ih', 'crop=ih*9/16:ih:(iw-ow)/2+iw*0.05'], '1:1': [720, 720, 'crop=ih:ih', 'crop=ih:ih:(iw-ow)/2+iw*0.05'], '16:9': [1280, 720, '', 'crop=iw*0.9:ih*0.9'] }; // the right crop, and one 5 % off
  for (const x of rows) {
    const f = `${EXP}/${x.file}`, j = probe(f), v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.find(s => s.codec_type === 'audio'), [w, h, crop, off] = want[x.shape];
    check(`${rm} ${x.shape}: ${w}x${h}, 120 frames, 4 s, sound`, v.width === w && v.height === h && +v.nb_read_frames === 120 && Math.abs(+j.format.duration - 4) < 0.05 && a && loud(f) > -40,
      `${v.width}x${v.height} ${v.nb_read_frames} frames ${(+j.format.duration).toFixed(3)} s, ${a ? `${loud(f)} dB` : 'no sound'}`);
    const p = psnr(gray(f, 0.5, w / 8, h / 8), gray(SRC, 0.5, w / 8, h / 8, crop)), po = psnr(gray(f, 0.5, w / 8, h / 8), gray(SRC, 0.5, w / 8, h / 8, off));
    check(`${rm} ${x.shape}: the 16:9 clip fills it around the centre`, p > 27 && p > po + 5, `${p.toFixed(1)} dB vs the source ${crop || 'whole'}, ${po.toFixed(1)} dB vs 5 % off`);
    if (x.shape === '1:1') { // the title: what changes between 0.5 s (none) and 1.5 s (it shows), all inside the frame
      const A = gray(f, 0.5, w, h), T = gray(f, 1.5, w, h);
      let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - T[i]) > 40) { const px = i % w, py = Math.floor(i / w); n++; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
      check(`${rm} 1:1: the title is inside the frame`, n > 500 && x0 > 2 && y0 > 2 && x1 < w - 3 && y1 < h - 3, `${n} px in ${x0}..${x1} x ${y0}..${y1} of ${w}x${h}`);
    }
    done.push(f);
  }

  if (rm === 'reduce') { // cancel a queued one: three of the same plan (no title layer: each export removes its own), the 2nd cancelled while it waits
    const n1 = await ev(() => S.q.length);
    await ev(async () => { P.mute.text = true; const pl = await buildPlan(720, 1280, 'fast', 'Platforms queue', false, 'mp4'); P.mute.text = false; for (let i = 0; i < 3; i++) await enqueue(pl, '9:16'); });
    const id2 = await ev(n => S.q[n + 1].job, n1), s2 = await api(`/api/jobs/${id2}`), waiting = s2.state === 'running' && !s2.started && /ahead/.test(s2.note || '');
    await page.click(`#exq .qrow[data-q="${id2}"] [data-qcancel]`);
    await page.waitForFunction(n => S.q.slice(n).every(q => q.st.state !== 'running'), n1, { timeout: 120000 });
    const q = await ev(n => S.q.slice(n).map(q => ({ ...q.st, say: q.say.textContent })), n1);
    check('cancel: the queued one is cancelled, the others saved', waiting && q[0].state === 'done' && q[1].state === 'cancelled' && q[1].say === 'Cancelled' && !q[1].file && q[2].state === 'done',
      q.map(x => `${x.state}${x.file ? ` ${x.file}` : ''}`).join(' | ') + (waiting ? '' : ' (the 2nd was not waiting)'));
    check('cancel: the 3rd started after the 1st ended', q[2].started >= q[0].ended - 0.01, `${(q[2].started - q[0].ended).toFixed(2)} s`);
    for (const x of q) if (x.file) done.push(`${EXP}/${x.file}`);
    await page.screenshot({ path: `${OUT}/platforms-${rm}.png` });
    await page.click('#exqClear');
    check('panel: Clear takes the finished ones off, then it hides', await ev(() => S.q.length === 0 && $('#exq').hidden));
  }
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  const pid = await ev(() => P.id);
  await page.context().close();
  await api(`/api/projects/${pid}/trash`, {}).catch(() => {});
}
await b.close();
for (const f of done) fs.rmSync(f, { force: true });
fs.rmSync(tmp, { recursive: true, force: true });
const bad = res.filter(x => !x).length;
console.log(`\n${res.length - bad}/${res.length} passed`);
process.exit(bad ? 1 : 0);
