import { requireHome } from './runtime.mjs';
// Reduce noise and auto duck, measured. Headless WebKit + the real export, on a scratch server:
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node audio_tools.mjs
// Denoise: speech (say) + pink noise -> export WAV: the cleaned speech must sit where the clean speech is (lag), the noise
// between words must drop >= 10 dB, and the preview must play the same denoised samples (&fx=dn). Duck: a night drive (road
// noise, nobody talking) must leave the song alone; on talk + music, trimming 2 s off the talk moves every dip 2 s.
// Everything it uses is made here (OS speech, ffmpeg). The night drive judges the Silero VAD itself, so it runs only where
// speech detection is installed; elsewhere the talk clip gets its speech cache from the speech's own timing (no model).
import { makeSpeech, speechClip, cachedMedia } from './fixtures.mjs';
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
const LIB = requireHome();
const B = process.env.B, SR = 48000, res = [];
if (!B || /:4610\b/.test(B)) throw new Error('set B to a scratch server (never 4610)');
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
// the left channel (-ac 1 sums equal channels at +3 dB)
const f32 = (args) => { const b = execFileSync('ffmpeg', ['-v', 'error', ...args, '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-ar', `${SR}`, '-'], { maxBuffer: 1 << 30 }); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const db = x => 20 * Math.log10(x + 1e-12);
const rmsAt = (x, idx) => { let s = 0; for (const i of idx) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, idx.length)); };
const wavOf = (L) => { // mono -> 16-bit stereo WAV
  const N = L.length, w = Buffer.alloc(44 + N * 4);
  w.write('RIFF', 0); w.writeUInt32LE(36 + N * 4, 4); w.write('WAVEfmt ', 8); w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(2, 22);
  w.writeUInt32LE(SR, 24); w.writeUInt32LE(SR * 4, 28); w.writeUInt16LE(4, 32); w.writeUInt16LE(16, 34); w.write('data', 36); w.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) { const v = Math.round(Math.max(-1, Math.min(1, L[i])) * 32767); w.writeInt16LE(v, 44 + i * 4); w.writeInt16LE(v, 46 + i * 4); }
  return w;
};
const imp = async (name, buf) => (await fetch(`${B}/api/import?name=${name}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: buf })).json();
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
const pink = (N, lvl) => { // Paul Kellet's filter, scaled to an RMS of lvl
  const b = [0, 0, 0, 0, 0, 0, 0], o = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = rnd();
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852; b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898; o[i] = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362; b[6] = w * 0.115926;
  }
  let s = 0; for (const v of o) s += v * v; const k = lvl / Math.sqrt(s / N); for (let i = 0; i < N; i++) o[i] *= k;
  return o;
};
const lagOf = (ref, x, max = 2400) => { // samples x trails ref by (cross-correlation peak)
  let best = -Infinity, at = 0;
  for (let L = -max; L <= max; L++) { let s = 0; for (let i = max; i < ref.length - max; i += 3) s += ref[i] * (x[i + L] || 0); if (s > best) { best = s; at = L; } }
  return at;
};

// ---- test signals: speech with gaps, in pink noise; tone bursts in pink noise
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-at-`);
if (!makeSpeech(`${tmp}/sp.wav`, 'The quick brown fox jumps over the lazy dog. [[slnc 700]] Cutroom cleans up noisy sound right on this Mac. [[slnc 700]] One more sentence to finish.')) { fs.rmSync(tmp, { recursive: true }); process.exit(0); }
const sp = f32(['-i', `${tmp}/sp.wav`]), lead = SR; // 1 s of noise before the speech
{ // peaks at -3.3 dBFS: the OS voices differ (macOS say -1.8 dBFS, Windows SAPI at full scale, clipping once the noise is added), and over
  // -1 dBFS the export's limiter (server.py: alimiter at 0.891) changes the samples, which the preview (no limiter) plays as they are
  let pk = 0; for (const v of sp) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < sp.length; i++) sp[i] *= 0.68 / pk;
}
const clean = new Float32Array(lead + sp.length + SR); clean.set(sp, lead);
const noise = pink(clean.length, 0.03), noisy = clean.map((v, i) => v + noise[i]);
const quiet = [], loud = [];
for (let i = 2400; i < clean.length - 2400; i += 5) { let q = true; for (let j = i - 2400; j <= i + 2400; j += 60) if (Math.abs(clean[j]) > 1e-4) { q = false; break; } if (q) quiet.push(i); else if (Math.abs(clean[i]) > 0.02) loud.push(i); }
const tone = new Float32Array(4 * SR); for (let i = 0; i < tone.length; i++) tone[i] = i % (SR / 2) < SR / 5 ? 0.25 * Math.sin(2 * Math.PI * 440 * i / SR) : 0;
const tnoise = pink(tone.length, 0.03), tnoisy = tone.map((v, i) => v + tnoise[i]);
const sm = await imp('audio-tools-speech-noise.wav', wavOf(noisy)), tm = await imp('audio-tools-tone-noise.wav', wavOf(tnoisy));

const b = await browser.launch(), ctx = await b.newContext({ viewport: { width: 1517, height: 904 } });
let page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
const open = async () => { await page.goto(`${B}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 }); await page.evaluate(() => loadMedia()); };
await open();
const ev = (f, a) => page.evaluate(f, a);
const made = [], madeMedia = [];

// ---- Reduce noise
const IN = 0.5, AT = 0.25; // the clip starts 0.5 s into the file, 0.25 s into the timeline
const exportDn = async (id, dn) => {
  const r = await ev(async ([id, dn, IN, AT]) => {
    setProject(newProject('16:9')); P.name = 'Audio tools (scratch)'; addMedia(id, 'audio', AT);
    const c = P.audio[0]; c.in = IN; c.start = AT; c.denoise = dn;
    const ex = await REMOTE.export({ format: 'wav', name: `audio-tools-${Date.now()}` });
    return { file: ex.file, pid: P.id };
  }, [id, dn, IN, AT]);
  made.push(r.pid);
  return f32(['-i', `${LIB}/exports/${r.file}`]);
};
const t0 = Date.now(), ex = await exportDn(sm.id, true), dnCold = (Date.now() - t0) / 1000;
const plainEx = await exportDn(sm.id, false);
const ref = new Float32Array(ex.length); // the clean speech where the timeline puts it
for (let i = 0; i < ref.length; i++) { const s = i - AT * SR + IN * SR; ref[i] = s >= 0 && s < clean.length ? clean[s] : 0; }
const lag = lagOf(ref, ex), plag = lagOf(ref, plainEx);
check('denoised speech lands on the picture (within 2 ms)', Math.abs(lag) <= 0.002 * SR, `${(lag / SR * 1000).toFixed(2)} ms (no denoise ${(plag / SR * 1000).toFixed(2)} ms; afftdn was 25 ms)`);
const sh = i => i + Math.round((AT - IN) * SR), qi = quiet.map(sh).filter(i => i >= 0 && i < ex.length), li = loud.map(sh).filter(i => i >= 0 && i < ex.length);
const drop = db(rmsAt(ex, qi)) - db(rmsAt(plainEx, qi)), keep = db(rmsAt(ex, li)) - db(rmsAt(plainEx, li));
check('noise between words drops >= 10 dB, the speech stays', drop <= -10 && keep > -1.5, `noise ${drop.toFixed(1)} dB, speech ${keep.toFixed(1)} dB, first export ${dnCold.toFixed(1)} s incl. denoising`);
// the preview's sound for a denoised clip = that same file
const pv = await ev(async ([id]) => {
  const p = pcmChunk(id, 1, 0, undefined, 'dn'); await p; const L = p.buf.getChannelData(0);
  const u = new Uint8Array(L.buffer); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s);
}, [sm.id]);
const pvL = (u => new Float32Array(u.buffer, u.byteOffset, u.length / 4))(Buffer.from(pv, 'base64'));
let se = 0, ss = 0; for (let t = Math.round(AT * SR) + 2400; t < Math.min(ex.length, Math.round(AT * SR) + 3.5 * SR); t++) { const s = t - Math.round(AT * SR) + IN * SR; ss += ex[t] ** 2; se += (ex[t] - pvL[s]) ** 2; }
const pvRef = new Float32Array(ex.length); for (let t = 0; t < ex.length; t++) { const s = t - Math.round(AT * SR) + IN * SR; pvRef[t] = s >= 0 && s < pvL.length ? pvL[s] : 0; }
check('the preview plays the same denoised samples as the export', 10 * Math.log10(ss / (se + 1e-15)) > 60, `${(10 * Math.log10(ss / (se + 1e-15))).toFixed(1)} dB SNR, offset ${lagOf(pvRef.subarray(0, 4 * SR), ex.subarray(0, 4 * SR))} samples`);
// and playback asks for them
const asked = [];
page.on('request', r => { if (/pcm=.*fx=dn\b/.test(r.url())) asked.push(r.url()); });
await ev(async ([id]) => { pcmBufs.clear(); setProject(newProject('16:9')); P.name = 'Audio tools play (scratch)'; addMedia(id, 'audio', 0); P.audio[0].denoise = true; touched(); S.t = 0; audioAwake?.(); play(); await sleep(1500); pause(); }, [sm.id]);
made.push(await ev(() => P.id));
check('playing a denoised clip fetches the denoised PCM', asked.length > 0, `${asked.length} requests`);
// tones (not speech): RNNoise is a speech denoiser, it takes the tone down with the noise (info, not a pass/fail)
{
  const exT = async dn => { const r = await ev(async ([id, dn]) => { setProject(newProject('16:9')); P.name = 'Audio tools tone (scratch)'; addMedia(id, 'audio', 0); P.audio[0].denoise = dn; const ex = await REMOTE.export({ format: 'wav', name: `audio-tools-${Date.now()}` }); return { file: ex.file, pid: P.id }; }, [tm.id, dn]); made.push(r.pid); return f32(['-i', `${LIB}/exports/${r.file}`]); };
  const x = await exT(true), x0 = await exT(false), gaps = [], on = [];
  for (let i = 0; i < tone.length; i += 7) { const ph = i % (SR / 2); if (ph > SR / 5 + 2400 && ph < SR / 2 - 2400) gaps.push(i); else if (ph > 2400 && ph < SR / 5 - 2400) on.push(i); }
  const g = (y, i) => { let re = 0, im = 0; for (let j = i - 96; j < i; j++) { re += y[j] * Math.cos(2 * Math.PI * 440 * j / SR); im += y[j] * Math.sin(2 * Math.PI * 440 * j / SR); } return Math.hypot(re, im); }; // 440 Hz over the last 2 ms
  // first rise: 440 Hz above twice its loudest in the 50 ms before the burst (a level relative to the burst itself moved with
  // RNNoise's gain, which falls during a steady tone, and read as onsets 3-5 ms EARLY: a causal filter can't be early)
  const onset = (y, a) => { let fl = 0; for (let i = a - 2400; i < a - 100; i += 4) fl = Math.max(fl, g(y, i)); for (let i = a - 100; i < a + 4800; i++) if (g(y, i) > 2 * fl) return i; return NaN; };
  const late = []; for (let k = 1; k < 8; k++) late.push((onset(x, k * SR / 2) - onset(x0, k * SR / 2)) / SR * 1000);
  const worst = Math.max(...late.map(Math.abs));
  check('denoised tone onsets within 2 ms of the undenoised ones', worst <= 2, `${late.map(v => v.toFixed(2)).join(' ')} ms`);
  console.log(`INFO tone + pink noise: noise ${(db(rmsAt(x, gaps)) - db(rmsAt(x0, gaps))).toFixed(1)} dB, tone ${(db(rmsAt(x, on)) - db(rmsAt(x0, on))).toFixed(1)} dB (RNNoise keeps speech; a steady tone is noise to it)`);
}

// ---- Auto duck
const impFile = async (name, file) => { const m = await imp(name, fs.readFileSync(file)); madeMedia.push(m.id); return m.id; };
const ready = async ids => { await ev(() => loadMedia()); await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), ids, { timeout: 120000 }); };
// speech detection here? (a WAV with speech in it; the answer is cached either way)
const vad = await (await fetch(`${B}/api/speech`, { method: 'POST', headers: H, body: JSON.stringify({ media: sm.id }) })).json();
let night = null, song = null;
if (vad.error) console.log(`SKIP night drive auto duck (judges the VAD itself): ${vad.error}`);
else {
  night = await impFile('DJI_0482_001.mp4', cachedMedia('night-drive-road-125s-v1.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=125,eq=brightness=-0.35',
    '-f', 'lavfi', '-i', 'anoisesrc=c=brown:r=48000:d=125:seed=5:amplitude=0.5', '-f', 'lavfi', '-i', 'aevalsrc=0.06*sin(2*PI*(55+3*sin(2*PI*0.05*t))*t)*(1+0.3*sin(2*PI*0.7*t)):s=48000:d=125',
    '-filter_complex', '[1:a]lowpass=f=400,volume=4[r];[r][2:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]', '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']));
  song = await impFile('beat-120bpm.m4a', cachedMedia('beat-120bpm-64s-v1.m4a', ['-f', 'lavfi', '-i',
    'aevalsrc=0.5*sin(2*PI*60*t)*exp(-12*mod(t\\,0.5))+0.12*(sin(2*PI*220*t)+sin(2*PI*330*t))*(0.6+0.4*sin(2*PI*0.25*t)):s=48000:d=64', '-ac', '2', '-c:a', 'aac']));
}
const TALK = speechClip('talk.mp4', 'We drove up the coast at sunset. [[slnc 1400]] Then we ate dinner at a little cafe. [[slnc 1400]] The mountain trail was steep. [[slnc 1400]] Back at the beach again.', { lead: 0.6, dur: 12 });
const talk = TALK && await impFile('talk.mp4', TALK.file);
const music = await impFile('music.m4a', cachedMedia('music-bed-20s-v1.m4a', ['-f', 'lavfi', '-i', 'aevalsrc=0.1*(sin(2*PI*262*t)+sin(2*PI*330*t)+sin(2*PI*392*t))*(0.7+0.3*sin(2*PI*2*t)):s=48000:d=20', '-ac', '2', '-c:a', 'aac']));
await ready([night, song, talk, music].filter(Boolean));
if (talk && vad.error) fs.writeFileSync(`${LIB}/cache/${talk}.speech.json`, JSON.stringify(TALK.speech)); // what the VAD would cache: where the voice is
const ducked = c => { let n = 0, d = 0; for (let t = 0; t < c.dur; t += 0.01) { d++; if (c.env(t) < 0.99) n++; } return n / d; };
if (night && song) {
  for (const id of [night]) fs.rmSync(`${LIB}/cache/${id}.speech.json`, { force: true }); // cold: no cached speech
  const run = () => ev(async ([night, song]) => {
    setProject(newProject('16:9')); P.name = 'Audio tools night duck (scratch)'; addMedia(night, 'main'); P.main[0].out = 120; packMain();
    addMedia(song, 'audio', 0); addMedia(song, 'audio', 60); touched();
    const t0 = performance.now();
    for (const c of P.audio) await autoDuck(c, 0.25);
    const ms = performance.now() - t0;
    return { ms, pid: P.id, clips: P.audio.map(c => ({ dur: len(c), vkf: c.vkf, duck: c.duck })) };
  }, [night, song]);
  const cold = await run(); made.push(cold.pid);
  let frac = 0; for (const c of cold.clips) frac += ducked({ dur: c.dur, env: t => envAt(c, t) }) / cold.clips.length;
  // what loudness alone said (the old auto duck: silencedetect at -35 dB, gaps under 0.6 s merged)
  const sil = (await (await fetch(`${B}/api/silences`, { method: 'POST', headers: H, body: JSON.stringify({ media: night, noise: -35, min: 0.3 }) })).json()).silences;
  let loudS = 0, cur = 0; for (const [a, b] of sil) { if (a >= 120) break; loudS += Math.max(0, Math.min(a, 120) - cur); cur = Math.max(cur, b); } loudS += Math.max(0, 120 - cur);
  check('night drive: the song ducks under 5 % of its length', frac < 0.05 && cold.clips.every(c => c.duck?.depth === 0.25), `${(frac * 100).toFixed(1)} % ducked; loudness called ${(loudS / 1.2).toFixed(0)} % of the drive sound; cold run ${(cold.ms / 1000).toFixed(2)} s`);
  await open(); // a fresh page: nothing cached in the client, the server has the speech
  const warm = await run(); made.push(warm.pid);
  check('warm auto duck under 1 s', warm.ms < 1000, `${warm.ms.toFixed(0)} ms (fresh page, server cache)`);
}
function envAt(c, lt) { const k = c.vkf; if (!k?.length) return 1; let i = 0; while (i + 1 < k.length && k[i + 1].t <= lt) i++; const a = k[i], b = k[i + 1]; return b ? a.v + (b.v - a.v) * Math.min(1, Math.max(0, (lt - a.t) / Math.max(1e-6, b.t - a.t))) : a.v; }
if (talk && music) {
  const r = await ev(async ([talk, music]) => {
    setProject(newProject('16:9')); P.name = 'Audio tools talk duck (scratch)'; P.unlinked = true; // the song stays put on the timeline
    addMedia(talk, 'main'); addMedia(music, 'audio', 0); touched();
    const c = P.audio[0];
    await autoDuck(c, 0.25);
    const before = structuredClone(c.vkf), sp = (await api('/api/speech', { media: talk })).speech;
    change(() => { P.main[0].in += 2; }); // trim 2 s off the talk's start: its speech moves 2 s earlier
    const after = structuredClone(c.vkf);
    const plan = await buildPlan(640, 360, 'fast', 'x', false, 'wav');
    return { before, after, sp, plan: plan.audio?.[0]?.vkf, pid: P.id };
  }, [talk, music]);
  made.push(r.pid);
  const moved = r.before.filter(f => f.t > 2.5 + 1e-6); // dips the trim doesn't cut into (speech cut off at 2 s leaves points up to its end + 0.5 s ramp)
  const ok = moved.length >= 4 && moved.every(f => r.after.some(g => Math.abs(g.t - (f.t - 2)) < 1e-3 && g.v === f.v));
  check('talk + music: trimming 2 s off the talk moves every duck point 2 s', ok, `${moved.length} points moved, speech ${r.sp.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(', ')}`);
  check('the export gets the re-made points', JSON.stringify(r.plan) === JSON.stringify(r.after));
  // a volume point set by hand turns the rule off (the dips become the clip's own points)
  const off = await ev(() => { const c = P.audio[0]; S.sel = { lane: 'audio', id: c.id }; S.t = 1; change(() => volPoint(c, -3)); return !c.duck && c.vkf.length > 0; });
  check('a hand-set point takes over from auto duck', off);
}
// the Audio inspector: Duck off by a click, in both motion modes
for (const motion of ['reduce', 'no-preference']) {
  await page.emulateMedia({ reducedMotion: motion });
  await ev(async ([talk, music]) => { setProject(newProject('16:9')); P.name = 'Audio tools ui (scratch)'; addMedia(talk, 'main'); addMedia(music, 'audio', 0); touched(); S.sel = { lane: 'audio', id: P.audio[0].id }; renderAll(); }, [talk, music]);
  made.push(await ev(() => P.id));
  await page.click('#inspector .itabs button[data-itab="Audio"]').catch(() => {});
  await page.click('#inspector button[data-act="duck"]');
  await page.waitForFunction(() => P.audio[0].duck && P.audio[0].vkf?.length > 1, null, { timeout: 30000 });
  await page.waitForSelector('#inspector button[data-act="unduck"]', { timeout: 5000 });
  await page.click('#inspector button[data-act="unduck"]');
  check(`Audio inspector: auto duck on, then Duck off (${motion})`, await ev(() => !P.audio[0].duck && !P.audio[0].vkf));
}
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close(); // before trashing: the page's save-on-leave would bring a trashed project back
for (const id of made) await fetch(`${B}/api/projects/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
{ const X = `${LIB}/exports/`; fs.mkdirSync(`${X}../trash/exports`, { recursive: true }); for (const f of fs.readdirSync(X).filter(f => f.startsWith('audio-tools-'))) fs.renameSync(X + f, `${X}../trash/exports/${f}`); }
for (const m of [sm, tm, ...madeMedia.map(id => ({ id }))]) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
