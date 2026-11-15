// The playback clock at starts and cuts (launch plan piece 2). A 60 fps project of two test-pattern files with sound, cut onto
// clips that start at their file's first frame (nothing before them to preroll through), onto a clip with a handle, a 2x clip,
// and through a crossfade; played from 0 twice, from inside a clip (after a seek), and from 1.0 s. Each run must have:
//  - no hold of the picture over 40 ms after its first 0.1 s (as ramp_play judges: Chromium's audio renderer used to hold
//    each new element 40-60 ms, and the clock waited two frames more for it),
//  - no backward clock snap over 50 ms, and a clock that never goes before where play started,
//  - at every cut, the incoming clip's first painted picture within its first 3 source frames (nothing skipped).
// Plus the server half: ?an=1 hands Chromium's players the picture alone, the plain URL keeps the sound.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node tests/play_clock.mjs   (never 4610)
import { browser } from './browser.mjs';
import { cachedMedia } from './fixtures.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B;
if (!B || /:4610\b/.test(B)) throw new Error('run this on a scratch server (B=...), never the real library on 4610');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const ids = [];
for (const [k, vf] of ['', ',hue=h=140'].entries()) {
  const f = cachedMedia(`clock-720p60-${k}-v1.mp4`, ['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=60:d=6${vf}`, '-f', 'lavfi', '-i', `sine=f=${300 + 200 * k}:r=48000:d=6`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-shortest', '-movflags', '+faststart']);
  ids.push((await (await fetch(`${B}/api/import_path`, { method: 'POST', headers: H, body: JSON.stringify({ path: f }) })).json()).id);
}

// ---------- the server: the picture alone on ?an=1, the file as it is without ----------
const streams = async q => {
  const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-clock-`), f = `${tmp}/m.mp4`;
  fs.writeFileSync(f, Buffer.from(await (await fetch(`${B}/media/${ids[0]}${q}`)).arrayBuffer()));
  const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f], { encoding: 'utf8' })).streams.map(x => x.codec_type);
  fs.rmSync(tmp, { recursive: true });
  return s.sort().join('+');
};
const [plain, an] = [await streams(''), await streams('?an=1')];
check('server: ?an=1 is the video stream alone, the plain URL keeps its sound', plain === 'audio+video' && an === 'video', `plain ${plain}, an ${an}`);

const b = await browser.launch();
const page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined', null, { timeout: 30000 });
const ev = (f, a) => page.evaluate(f, a);
await page.waitForFunction(ids => { loadMedia(); return ids.every(id => M.get(id)?.ready); }, ids, { timeout: 120000, polling: 500 });
const plan = await ev(([A, Bm]) => {
  setProject(newProject('16:9')); P.name = 'clock (scratch)'; P.fps = 60;
  const base = { volume: 1, fadeIn: 0, fadeOut: 0, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } }, c = (media, i, o, speed = 1, tr) => ({ ...base, id: hex12(), media, in: i, out: o, speed, ...(tr && { tr }) });
  P.main = [c(A, 0, 1.5), c(Bm, 0, 1.5), c(A, 2, 3.5), c(Bm, 0.5, 2, 2, { type: 'fade', d: 0.4 }), c(A, 0, 1.5), c(Bm, 0, 1)]; // first-frame cut, handle, 2x, crossfade, first-frame cuts
  packMain(); renderAll(); S.t = 0; S.dirty = true;
  window.PT = []; const op = paint; paint = () => { op(); if (S.playing) PT.push([performance.now(), S.t, S.lead?.currentTime ?? -1, P.main.indexOf(S.leadClip)]); };
  return { cuts: P.main.slice(1).map((x, i) => ({ i: i + 1, start: x.start, in: x.in, speed: x.speed, tr: !!P.main[i].tr })), end: total() };
}, ids);

const run = async (from, ms, label) => {
  await ev(t => { seekTo(t); }, from); await page.waitForTimeout(1200);
  await ev(() => { PT.length = 0; window.SNAP = []; let pt = null, pw = null; const poll = n => { if (!S.playing) return; if (pt !== null) { const d = (S.t - pt) - (n - pw) / 1000; if (Math.abs(d) > 0.008 && S.t < S.end) SNAP.push([+pt.toFixed(3), +(d * 1000).toFixed(0)]); } pt = S.t; pw = n; requestAnimationFrame(poll); }; play(); requestAnimationFrame(poll); });
  await page.waitForTimeout(ms);
  const r = await ev(([from, cuts]) => {
    const t0 = from; if (S.playing) pause();
    let prev = -9, last = null, worst = 0, at = 0;
    for (const p of PT) if (Math.abs(p[2] - prev) > 1e-4) { if (last !== null && p[1] >= t0 + 0.1 && p[0] - last > worst) { worst = p[0] - last; at = p[1]; } last = p[0]; prev = p[2]; }
    const back = SNAP.filter(s => s[1] < -50 && s[0] >= t0 + 0.1);
    const firsts = cuts.filter(c => c.start > t0 + 0.05 && !c.tr).map(c => { const p = PT.find(x => x[3] === c.i); return p ? +(((p[2] - c.in) / c.speed) * 60).toFixed(2) : null; }).filter(x => x !== null);
    return { worst: Math.round(worst), at: +at.toFixed(2), snaps: back.length, minT: +Math.min(...PT.map(p => p[1])).toFixed(4), reached: +(PT.at(-1)?.[1] ?? 0).toFixed(2), firsts };
  }, [from, plan.cuts]);
  check(`${label}: no picture hold over 40 ms`, r.worst < 40, `worst ${r.worst} ms at ${r.at} s, reached ${r.reached}`);
  check(`${label}: no backward snaps, never before ${from} s`, r.snaps === 0 && r.minT >= from - 1e-6, `${r.snaps} snaps, from ${r.minT}`);
  check(`${label}: each cut shows its clip from its first frames`, r.firsts.length > 0 && r.firsts.every(f => f >= -1.5 && f <= 3), `first frame at each cut (in project frames from the clip's in): ${r.firsts.join(', ')}`);
};
await run(0, (plan.end + 0.6) * 1000, 'play from 0');
await run(0, (plan.end + 0.6) * 1000, 'play from 0 again');
await run(2.0, 2000, 'play from 2.0 (inside a first-frame clip, after a seek)');
await run(1.0, 1500, 'play from 1.0');
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
const pid = await ev(() => P.id);
await b.close();
await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
for (const id of ids) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
