// Voiceover recording from the mic, in headless WebKit with a synthetic mic (no real mic in tests): getUserMedia is
// stubbed to return a MediaStreamDestination of the app's own AudioContext. Into it go (a) beeps "spoken" at known
// project times (scheduled on the app's audio clock at the wall time the playhead shows that time), and (b) the room:
// everything the app sends to its speakers (web/silent.js's gate in front of them), as a mic without headphones hears it (so the count-in blips measure the
// delay, and "hear the project" bleeds in). WebKit delivers such a stream ~47-50 ms late, Edge on Windows ~21 ms: the mic's delay to measure.
// Checks: each beep lands within 5 ms of its spoken time on the timeline (clip start + file time - clip in, the file read
// as the export reads it), at two playhead start positions, with the measured and the remembered delay; the "hear the
// project while recording" toggle (off by default, headphone warning) in both motion modes.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node voiceover.mjs   (never 4610)
import { requireHome } from './runtime.mjs';
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
requireHome();
const B = process.env.B, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
if (!B || /:4610\b/.test(B)) throw new Error('set B to a scratch server (never 4610)');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-vo-`), f = `${tmp}/vo-v.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
const V = await (await fetch(`${B}/api/import?name=vo-v.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
const made = { p: [], m: [V.id] };
const wavAt = async id => { // the take as the export reads it (a WAV is read as is): 16-bit mono
  const b = Buffer.from(await (await fetch(`${B}/media/${id}`)).arrayBuffer()), sr = b.readUInt32LE(24);
  let o = 12; while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  const n = b.readUInt32LE(o + 4) / 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
  return { x, sr };
};
const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // (not the MCP's editor)
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (fn, a) => page.evaluate(fn, a);
  await page.evaluate(() => { // the synthetic mic
    window.ROOM = { loop: true };
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: async () => { // (on the prototype: the instance's property doesn't take in WebKit)
      const A = actx, dst = A.createMediaStreamDestination();
      const z = A.destination; // web/silent.js on test ports: a zero gain in front of the speakers. It becomes the room instead (still no sound out)
      if (z instanceof AudioDestinationNode) throw new Error('the page has sound: run on a test port');
      z.disconnect(); z.gain.value = ROOM.loop ? 1 : 0; z.connect(dst); // loop off = headphones: the mic doesn't hear the speakers (still connected: the graph pulls what reaches it)
      const plan = ROOM.plan || [], done = new Set();
      ROOM.log = [];
      const tick = setInterval(() => { // each beep is spoken when the playhead shows its time: scheduled 120 ms ahead on the wall clock the playhead runs on
        if (!S.playing || S.stuck) return;
        for (const T of plan) if (!done.has(T) && S.t > T - 0.12) {
          done.add(T);
          const W = S.wall0 + ((T - S.t0) * 1000) / S.rate, ts = A.getOutputTimestamp(), g = ts.contextTime + (W - ts.performanceTime) / 1000;
          const o = A.createOscillator(), k = A.createGain(); o.frequency.value = 1000; k.gain.value = 0.6;
          o.connect(k); k.connect(dst); o.start(g); o.stop(g + 0.02);
          ROOM.log.push({ T, ahead: g - A.currentTime });
        }
      }, 5);
      dst.stream.getAudioTracks()[0].addEventListener('ended', () => clearInterval(tick));
      return dst.stream;
    } });
  });
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, V.id, { timeout: 60000 });
  made.p.push(await ev(id => { setProject(newProject('16:9')); P.name = 'Voiceover test (scratch)'; renderAll(); addMedia(id, 'main', 0); S.t = 0; return P.id; }, V.id));
  await page.click(`.rail button[data-tab="${(await ev(() => $('#btnRec').closest('section').id)).slice(4)}"]`); await page.waitForTimeout(400);
  check(`${rm}: "hear the project" is off by default, no headphone warning`, await ev(() => !$('#recHear').checked && $('#recHearHint').hidden));
  const take = async (t0, hear, loop) => { // a take from t0 by the real buttons; beeps at t0 + 0.7, 1.4, 2.1
    const plan = [0.7, 1.4, 2.1].map(d => +(t0 + d).toFixed(3));
    await ev(([t0, plan, loop]) => { pause(); S.t = t0; S.dirty = true; ROOM.plan = plan; ROOM.loop = loop; }, [t0, plan, loop]);
    if (await page.isChecked('#recHear') !== hear) await page.click('#recHear');
    const hint = await page.isVisible('#recHearHint');
    await page.click('#btnRec');
    await page.waitForFunction(T => S.playing && S.t > T, plan.at(-1) + 0.4, { timeout: 15000, polling: 20 }).catch(async e => { console.log(await ev(() => ({ toast: $('#toast').textContent, rec: !!rec, playing: S.playing, t: S.t, total: total(), actx: actx?.state }))); throw e; });
    const during = await ev(() => { let g = 0; for (const v of voices.values()) g = Math.max(g, v.n.out.gain.value); return { mute: S.recMute, gain: g }; });
    await page.click('#btnRec');
    await page.waitForFunction(() => !rec && toggleRecord.last?.done !== true, null, { timeout: 15000 }).catch(async e => { console.log(await ev(() => ({ toast: $('#toast').textContent, rec: !!rec }))); throw e; });
    await page.waitForTimeout(300);
    const r = await ev(() => { const c = P.audio.at(-1), L = toggleRecord.last; L.done = true; return { c: { start: c.start, in: c.in, out: c.out, media: c.media }, L, log: ROOM.log }; });
    made.m.push(r.c.media);
    const { x, sr } = await wavAt(r.c.media), errsMs = [];
    for (const T of plan) { // the beep's onset: the first sample past 0.3 near where it should be
      let i = Math.max(0, Math.round((r.c.in + T - r.c.start - 0.15) * sr)); const e = Math.round((r.c.in + T - r.c.start + 0.15) * sr);
      while (i < e && Math.abs(x[i]) < 0.3) i++;
      errsMs.push(i < e ? (r.c.start + i / sr - r.c.in - T) * 1000 : NaN);
    }
    let q = 0; const a0 = Math.round((r.c.in + plan[0] - r.c.start + 0.1) * sr), n = Math.round(0.4 * sr); // between beeps: silence, or the project's sound when heard
    for (let i = a0; i < a0 + n; i++) q += x[i] * x[i];
    await ev(() => { change(() => { P.audio.pop(); }); });
    return { ...r, errsMs, bleed: Math.sqrt(q / n), hint, during };
  };
  let measured = 0;
  for (const t0 of [0.5, 3.0]) {
    const r = await take(t0, false, true), worst = Math.max(...r.errsMs.map(Math.abs));
    measured = r.L.lat;
    check(`${rm}: beeps land within 5 ms, playhead from ${t0} s`, worst <= 5, `errors ${r.errsMs.map(e => e.toFixed(2)).join(', ')} ms; mic delay measured ${(r.L.lat * 1000).toFixed(1)} ms (heard ${r.L.heard}), clip at ${r.c.start.toFixed(3)} in ${r.c.in.toFixed(3)}, ${r.L.frames} frames`);
    check(`${rm}: muted project while recording, nothing bleeds in (from ${t0} s)`, r.during.mute && r.during.gain < 0.01 && r.bleed < 0.003, `rms ${r.bleed.toFixed(4)}`);
  }
  const h = await take(1.5, true, true), hw = Math.max(...h.errsMs.map(Math.abs));
  check(`${rm}: "hear the project" on: the warning shows, the project sounds (and bleeds into the speakers' mic)`, h.hint && !h.during.mute && h.during.gain > 0.5 && h.bleed > 0.03, `gain ${h.during.gain.toFixed(2)}, rms ${h.bleed.toFixed(4)}`);
  check(`${rm}: with the project heard, beeps still within 5 ms`, hw <= 5, `errors ${h.errsMs.map(e => e.toFixed(2)).join(', ')} ms`);
  const hp = await take(2.0, true, false), hpw = Math.max(...hp.errsMs.map(Math.abs));
  check(`${rm}: headphones (blips not heard): the remembered delay keeps beeps within 5 ms`, !hp.L.heard && hpw <= 5, `heard ${hp.L.heard}, delay ${(hp.L.lat * 1000).toFixed(1)} ms, errors ${hp.errsMs.map(e => e.toFixed(2)).join(', ')} ms`);
  await ev(() => localStorage.removeItem('cutroom.micDelay')); // control: nothing measured or remembered, so the mic's delay goes uncorrected
  const nc = await take(2.0, true, false);
  // with nothing measured or remembered the take trusts what the browser reports (WebKit: nothing; Chromium: 10 ms), so the beeps land
  // the rest of the measured delay late (WebKit ~47 ms, Edge on Windows ~11 ms)
  const late = (measured - nc.L.lat) * 1000;
  check(`${rm}: control: with no delay known the beeps land as late as the blips measured, less what the browser reports (the delay is real)`, !nc.L.heard && late > 5 && nc.errsMs.every(e => Math.abs(e - late) < 5), `errors ${nc.errsMs.map(e => e.toFixed(2)).join(', ')} ms; measured ${(measured * 1000).toFixed(1)} ms, reported ${(nc.L.lat * 1000).toFixed(1)} ms`);
  await page.click('#recHear');
  check(`${rm}: toggling off hides the warning`, await ev(() => !$('#recHear').checked && $('#recHearHint').hidden));
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();
for (const p of made.p) await fetch(`${B}/api/projects/${p}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
