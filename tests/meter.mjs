// Loudness meter vs ffmpeg: a clip whose sound is 6 s of a 1 kHz sine at -20 dBFS then 6 s of pink noise, played in
// headless WebKit with the meter shown (both motion modes), against ebur128 / astats on the WAV export of the same project.
// Momentary (median over each steady part) and integrated within 0.5 LU, per-channel sample peaks within 0.5 dB; the
// meter's state is remembered across a reload, and a hidden meter has no audio nodes and gets no blocks.
//   B=http://127.0.0.1:4705 CUTROOM_HOME=<scratch lib> node meter.mjs   (never 4610)
import { browser } from './browser.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const B = process.env.B || 'http://127.0.0.1:4705', HOME = process.env.CUTROOM_HOME, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
if (!HOME || B.endsWith(':4610')) throw new Error('needs a scratch server and CUTROOM_HOME (never the real library)');
const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H })).json();
let fails = 0;
const check = (name, ok, info = '') => { fails += !ok; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  [${info}]` : ''}`); };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

const f = join(mkdtempSync(join(tmpdir(), 'meter-')), 'sine-pink.mov');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=30:d=12',
  '-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*1000*t)':s=48000:d=6", '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:r=48000:a=0.3:seed=7',
  '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', f]);
const m = await api('/api/import_path', { path: f });
if (m.error) throw new Error(m.error);
for (let i = 0; !(await api('/api/media')).find(x => x.id === m.id)?.ready; i++) { if (i > 300) throw new Error('import stuck'); await new Promise(r => setTimeout(r, 200)); }

const b = await browser.launch();
let pid, ref;
for (const rm of ['reduce', 'no-preference']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage(), errs = [];
  let reloading = false; // WebKit reports a fetch cut off by our own reload as a page error ('... due to access control checks')
  page.on('pageerror', e => { if (!(reloading && /access control checks/.test(e.message))) errs.push(e.message); });
  const ev = (fn, a) => page.evaluate(fn, a);
  await page.goto(B + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined', null, { timeout: 30000 });
  pid = await ev(async id => {
    await loadMedia();
    setProject(newProject('16:9')); P.name = 'meter (scratch)'; P.fps = 30;
    P.main = [{ media: id, id: hex12(), in: 0, out: 12, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } }];
    packMain(); renderAll(); S.t = 0; S.dirty = true; await saveNow();
    return P.id;
  }, m.id);
  check(`${rm}: meter hidden by default`, await ev(() => $('#meter').hidden && !MTR.node));
  await page.click('#btnMeter');
  await page.waitForFunction(() => MTR.node, null, { timeout: 10000 }).catch(() => {});
  check(`${rm}: the button shows it and taps the master bus`, await ev(() => !$('#meter').hidden && !!MTR.node && actx.bus.gain.value === 1 && $('#btnMeter').getAttribute('aria-pressed') === 'true'));
  reloading = true;
  await page.reload({ waitUntil: 'load' });
  reloading = false;
  await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined', null, { timeout: 30000 });
  check(`${rm}: shown again after a reload (remembered)`, await ev(() => !$('#meter').hidden));
  await ev(async id => { await openProject(id); S.t = 0; S.dirty = true; }, pid);
  await page.mouse.move(700, 300); await page.waitForTimeout(300); // any input wakes the audio context; the meter builds on it
  await page.waitForFunction(() => MTR.node && actx.state === 'running', null, { timeout: 10000 }).catch(() => {});
  await ev(() => { window.LOG = []; const t = meterTick; meterTick = d => { t(d); LOG.push([S.t, MTR.M, MTR.S]); }; S.t = 0; meterReset(); });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => S.t > 9, null, { timeout: 30000 });
  await page.screenshot({ path: join(process.env.CUTROOM_SCRATCH || tmpdir(), `meter-${rm}.png`), clip: await ev(() => { const q = $('#stage').getBoundingClientRect(); return { x: q.x, y: q.y, width: q.width, height: q.height }; }) });
  await page.waitForFunction(() => !S.playing, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const r = await ev(() => ({ log: LOG, I: MTR.I, hold: MTR.hold, clip: MTR.clip, M: $('#mtM').textContent, I_txt: $('#mtI').textContent, L: $$('#meter .mpk b')[0].textContent, sr: actx.sampleRate }));
  if (process.env.DUMP) console.log(JSON.stringify(r.log.map(q => [+q[0].toFixed(2), +q[1].toFixed(2)])));
  check(`${rm}: blocks came in while playing (numbers update)`, r.log.length > 100 && r.M !== '' && r.I_txt !== '–' && r.L !== '–', `${r.log.length} blocks at ${r.sr} Hz; shows M ${r.M} I ${r.I_txt} L ${r.L}`);

  if (!ref) { // the same project exported (WAV, loudness off), measured by ffmpeg once
    const x = await ev(() => REMOTE.export({ format: 'wav', name: 'meter ref' }).catch(e => ({ error: e.message })));
    if (x.error) throw new Error(x.error);
    const out = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-v', 'verbose', '-i', `${HOME}/exports/${x.file}`, '-af', 'ebur128=framelog=verbose,astats=measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const fr = [...out.matchAll(/t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+)/g)].map(q => [+q[1], +q[2]]);
    ref = { fr, I: +out.match(/Integrated loudness:\s*I:\s*(-?[\d.]+)/)[1], pk: [...out.matchAll(/Peak level dB:\s*(-?[\d.]+)/g)].map(q => +q[1]).slice(0, 2) };
    console.log(`     ffmpeg on the export: I ${ref.I} LUFS, peaks ${ref.pk.join(' / ')} dBFS`);
  }
  // the export's frame at t covers [t - 0.4, t]; the meter's block at S.t is heard at about S.t: steady parts compared by median
  for (const [what, a, z] of [['sine', 2, 5.5], ['pink noise', 8, 11.5]]) {
    const mine = median(r.log.filter(q => q[0] >= a && q[0] <= z).map(q => q[1])), theirs = median(ref.fr.filter(q => q[0] >= a && q[0] <= z).map(q => q[1]));
    const ms = r.log.filter(q => q[0] >= a && q[0] <= z).map(q => q[1]);
    check(`${rm}: momentary on ${what} within 0.5 LU of ebur128`, Math.abs(mine - theirs) <= 0.5, `meter ${mine.toFixed(2)} (${Math.min(...ms).toFixed(1)}..${Math.max(...ms).toFixed(1)}, n ${ms.length}) vs ${theirs.toFixed(2)}`);
  }
  check(`${rm}: integrated within 0.5 LU of ebur128`, Math.abs(r.I - ref.I) <= 0.5, `meter ${r.I.toFixed(2)} vs ${ref.I}`);
  check(`${rm}: sample peaks L / R within 0.5 dB of astats`, ref.pk.length === 2 && r.hold.every((p, c) => Math.abs(p - ref.pk[c]) <= 0.5), `meter ${r.hold.map(p => p.toFixed(2)).join(' / ')} vs ${ref.pk.join(' / ')}`);
  check(`${rm}: no clip warning under -1 dBFS`, !r.clip && (await ev(() => $('#mtClip').hidden)));
  const mc = await ev(async () => ({ a: await REMOTE.meter({ target: -23 }), bad: await REMOTE.meter({ target: -12 }).catch(e => e.message), mark: $('#meter .mbar b.on').dataset.t }));
  check(`${rm}: MCP meter reads the same and sets the target`, mc.a.shown && mc.a.target === -23 && mc.mark === '-23' && Math.abs(mc.a.integrated - r.I) < 0.06 && /-14, -16 or -23/.test(mc.bad), JSON.stringify(mc.a));
  const clip = await ev(() => { meterTick([0, 0, 0.95, 0.1]); const c = MTR.clip && !$('#mtClip').hidden; meterReset(); return c && !MTR.clip; });
  check(`${rm}: a peak over -1 dBFS warns until reset`, clip);
  await page.click('#btnMeter');
  const off = await ev(async () => { let n = 0; const t = meterTick; meterTick = d => { n++; t(d); }; S.t = 0; play(); await sleep(1000); pause(); return { n, node: MTR.node, hidden: $('#meter').hidden }; });
  check(`${rm}: hidden: no audio nodes, no blocks while playing`, off.n === 0 && off.node === null && off.hidden, `${off.n} blocks`);
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}
await api(`/api/projects/${pid}/trash`, {}); await api(`/api/media/${m.id}/trash`, {});
await b.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
