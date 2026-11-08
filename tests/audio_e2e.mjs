// Audio end to end, headless WebKit + the real export: every sound setting (EQ, pan, pitch, voice effects, volume
// points) is exported to WAV and also rendered through the preview's own Web Audio chain (soundChain/setSound, offline)
// on the same test signal; the two must match. Then the Audio inspector by real clicks, and Split into stems.
//   node audio_e2e.mjs     (server on 127.0.0.1:4610)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
const B = 'http://127.0.0.1:4610', SR = 48000, N = 3 * SR, res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
// test signal: 100 Hz + 1 kHz + 8 kHz tones (right channel at half level), a click at 1.0 s
const L = new Float32Array(N), R = new Float32Array(N);
for (let i = 0; i < N; i++) { const t = i / SR, x = 0.08 * (Math.sin(2 * Math.PI * 100 * t) + Math.sin(2 * Math.PI * 1000 * t) + Math.sin(2 * Math.PI * 8000 * t)); L[i] = x; R[i] = 0.5 * x; }
L[SR] += 0.3; R[SR] += 0.3;
const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { wav.writeInt16LE(Math.round(L[i] * 32767), 44 + i * 4); wav.writeInt16LE(Math.round(R[i] * 32767), 46 + i * 4); }
const media = await (await fetch(`${B}/api/import?name=audio-e2e-tones.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: wav })).json();
const pcm = f => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '2', '-ar', `${SR}`, '-'], { maxBuffer: 1 << 30 }); const a = new Float32Array(b.buffer, b.byteOffset, b.length / 4); const l = new Float32Array(a.length / 2), r = new Float32Array(a.length / 2); for (let i = 0; i < l.length; i++) { l[i] = a[2 * i]; r[i] = a[2 * i + 1]; } return [l, r]; };
const tone = (x, f, a = 0.4 * SR, n = 0.5 * SR) => { let re = 0, im = 0; for (let i = a; i < a + n; i++) { re += x[i] * Math.cos(2 * Math.PI * f * i / SR); im += x[i] * Math.sin(2 * Math.PI * f * i / SR); } return 2 * Math.hypot(re, im) / n; }; // amplitude at f
const db = x => 20 * Math.log10(x + 1e-12);
const snr = (a, b, from = 0.1 * SR, to = 2.8 * SR) => { let s = 0, e = 0; for (let i = from; i < to; i++) { s += a[i] * a[i]; e += (a[i] - b[i]) ** 2; } return s < 1e-6 && e < 1e-6 ? 99 : 10 * Math.log10(s / (e + 1e-15)); }; // both silent = a match
const rms = (x, a = 0.4 * SR, n = 0.5 * SR) => { let s = 0; for (let i = a; i < a + n; i++) s += x[i] * x[i]; return Math.sqrt(s / n); };

const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
const made = [], stemIds = [];
// export one audio clip with these settings, and render the same through the preview chain offline
const both = async (au, vkf) => {
  const r = await ev(async ([id, au, vkf]) => {
    setProject(newProject('16:9')); P.name = 'Audio e2e (scratch)'; addMedia(id, 'audio', 0);
    const c = P.audio[0]; if (au) c.au = au; if (vkf) c.vkf = vkf;
    const ex = await REMOTE.export({ format: 'wav', name: `audio-e2e-${Date.now()}` });
    const off = new OfflineAudioContext(2, 3 * 48000, 48000);
    await off.audioWorklet.addModule('/pitch.js');
    const buf = await off.decodeAudioData(await (await fetch(`/media/${id}`)).arrayBuffer());
    const ir = await off.decodeAudioData(await (await fetch('/ir/hall.wav')).arrayBuffer());
    const keep = [pitchReady, hallIR]; pitchReady = true; hallIR = ir;
    const src = off.createBufferSource(); src.buffer = buf;
    const n = soundChain(null, off, src); setSound(n, c.au);
    if (c.vkf) { const g = n.out.gain; g.setValueAtTime(c.vkf[0].v, 0); for (const f of c.vkf) g.linearRampToValueAtTime(f.v, f.t); } // the envelope, as the preview's gain follows volAt()
    src.start(); const out = await off.startRendering(); [pitchReady, hallIR] = keep;
    const enc = a => { const u = new Uint8Array(a.buffer); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); };
    return { file: ex.file, pid: P.id, l: enc(out.getChannelData(0)), r: enc(out.getChannelData(1)) };
  }, [media.id, au, vkf]);
  made.push(r.pid);
  const dec = s => { const u = Buffer.from(s, 'base64'); return new Float32Array(u.buffer, u.byteOffset, u.length / 4); };
  return { ex: pcm(`${os.homedir()}/Movies/Cutroom/exports/${r.file}`), pv: [dec(r.l), dec(r.r)], file: r.file };
};
const plain = await both(null);
check('a plain clip exports as it went in', snr(L, plain.ex[0]) > 40 && snr(R, plain.ex[1]) > 40, `${snr(L, plain.ex[0]).toFixed(1)} dB SNR`);
for (const [name, au, sane] of [
  ['bass +12 dB', { bass: 12 }, ([l]) => db(tone(l, 100)) - db(tone(L, 100)) > 5 && Math.abs(db(tone(l, 8000)) - db(tone(L, 8000))) < 0.5],
  ['mid -12 dB', { mid: -12 }, ([l]) => db(tone(l, 1000)) - db(tone(L, 1000)) < -10 && Math.abs(db(tone(l, 100)) - db(tone(L, 100))) < 1],
  ['treble +9 dB', { treb: 9 }, ([l]) => db(tone(l, 8000)) - db(tone(L, 8000)) > 4],
  ['pan 60 % right', { pan: 0.6 }, ([l, r]) => rms(l) < 0.7 * rms(L) && rms(r) > rms(R)],
  ['pan 100 % left', { pan: -1 }, ([l, r]) => rms(r) < 0.01 && rms(l) > rms(L)],
  ['telephone', { voice: 'telephone' }, ([l]) => db(tone(l, 100)) - db(tone(L, 100)) < -15 && db(tone(l, 8000)) - db(tone(L, 8000)) < -15 && Math.abs(db(tone(l, 1000)) - db(tone(L, 1000))) < 2],
  ['echo', { voice: 'echo' }, ([l]) => { const k = SR + 0.25 * SR; return Math.abs(l[k] - 0.8 * (L[k] + 0.5 * L[SR])) < 0.015; }],
  ['hall reverb', { voice: 'hall' }, ([l]) => rms(l, 1.05 * SR, 0.2 * SR) > rms(L, 1.05 * SR, 0.2 * SR) * 1.02],
  ['EQ + pan + echo together', { bass: -6, treb: 6, pan: -0.3, voice: 'echo' }, () => true],
]) {
  const r = await both(au), [s0, s1] = [snr(r.ex[0], r.pv[0]), snr(r.ex[1], r.pv[1])];
  check(`${name}: preview = export`, Math.min(s0, s1) > 30, `${s0.toFixed(1)} / ${s1.toFixed(1)} dB SNR`);
  check(`${name}: sounds right`, sane(r.ex));
}
for (const semi of [6, -5]) { // pitch keeps the timing; preview and export land on the same note
  const r = await both({ semi }), f = 1000 * 2 ** (semi / 12);
  const gain = x => db(tone(x, f, 0.6 * SR, 0.8 * SR)) - db(tone(x, 1000, 0.6 * SR, 0.8 * SR));
  check(`pitch ${semi > 0 ? '+' : ''}${semi}: the 1 kHz tone moves to ${f.toFixed(0)} Hz in both`, gain(r.ex[0]) > 15 && gain(r.pv[0]) > 15, `export ${gain(r.ex[0]).toFixed(1)} dB, preview ${gain(r.pv[0]).toFixed(1)} dB`);
  check(`pitch ${semi}: same length`, Math.abs(r.ex[0].length - N) < SR * 0.05, `${(r.ex[0].length / SR).toFixed(3)} s`);
}
{ const r = await both({ voice: 'robot' }), side = x => db(tone(x, 1050, 0.6 * SR, 0.8 * SR)) - db(tone(x, 1000, 0.6 * SR, 0.8 * SR));
  check('robot: 50 Hz ring modulation in both (1 kHz -> 950 + 1050 Hz)', side(r.ex[0]) > 15 && side(r.pv[0]) > 15, `export ${side(r.ex[0]).toFixed(1)} dB, preview ${side(r.pv[0]).toFixed(1)} dB`); }
{ const vkf = [{ t: 0, v: 1 }, { t: 1.5, v: 0.25 }, { t: 2.5, v: 0.25 }], r = await both(null, vkf);
  const at = (x, t) => rms(x, t * SR, 0.05 * SR) / rms(L, t * SR, 0.05 * SR);
  check('volume points: 0 dB, ramp to -12 dB, hold', Math.abs(db(at(r.ex[0], 0.3)) - db(1 - 0.75 * 0.3 / 1.5)) < 0.7 && Math.abs(db(at(r.ex[0], 2.0)) + 12) < 0.7 && Math.abs(db(at(r.pv[0], 2.0)) + 12) < 0.7,
    `export ${db(at(r.ex[0], 0.3)).toFixed(1)} / ${db(at(r.ex[0], 2.0)).toFixed(1)} dB, preview at 2 s ${db(at(r.pv[0], 2.0)).toFixed(1)} dB`); }

// the Audio inspector by real clicks
await ev(id => { setProject(newProject('16:9')); P.name = 'Audio e2e UI (scratch)'; addMedia(id, 'audio', 0); S.sel = { lane: 'audio', id: P.audio[0].id }; renderAll(); }, media.id);
made.push(await ev(() => P.id));
await page.click('#inspector .itabs button[data-itab="Audio"]');
await page.click('#inspector button[data-voice="chipmunk"]');
check('Voice effect "Chipmunk" sets +6 semitones', await ev(() => P.audio[0].au?.semi === 6 && P.audio[0].au.voice === 'none'));
await page.click('#inspector button[data-voice="hall"]');
check('"Hall" adds the reverb, keeps the pitch', await ev(() => P.audio[0].au.voice === 'hall' && P.audio[0].au.semi === 6));
const setRange = async (k, v) => page.$eval(`#inspector input[data-k="${k}"]`, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
await setRange('c.au.bass', 6); await setRange('c.au.pan', -0.5);
check('Bass and Pan sliders', await ev(() => P.audio[0].au.bass === 6 && P.audio[0].au.pan === -0.5), await ev(() => JSON.stringify(P.audio[0].au)));
check('slider labels read in dB / L-R', (await page.$eval('#inspector input[data-k="c.au.pan"] + output', o => o.textContent)) === '50% L');
await ev(() => { S.t = 1; renderInspector(); });
await setRange('vk.here', -12);
await ev(() => { S.t = 2; renderInspector(); });
await setRange('vk.here', 0);
const pts = await ev(() => P.audio[0].vkf);
check('two volume points from the Level slider', pts?.length === 2 && Math.abs(pts[0].v - 0.2512) < 0.01 && pts[1].v === 1, JSON.stringify(pts));
check('the timeline draws the volume line', await page.$('.clip.audio svg.env polyline') !== null);
await page.click('#inspector button[data-act="vkprev"]');
check('◀ Point jumps to the previous point', await ev(() => Math.abs(S.t - 1) < 0.02), await ev(() => S.t.toFixed(3)));
await page.click('#inspector button[data-act="vkdel"]');
check('Delete point', await ev(() => P.audio[0].vkf?.length === 1));
await page.click('#inspector button[data-act="soundreset"]');
check('Reset sound clears the effects', await ev(() => !P.audio[0].au));
check('MCP: update_clip takes au', await ev(async () => { const c = P.audio[0]; await REMOTE.update_clip({ id: c.id, set: { au: { voice: 'echo', treb: 3 } } }); return c.au.voice === 'echo' && c.au.treb === 3; }));
// Split into stems on a mix with a voice (the library's talk-with-music)
const mix = await ev(() => [...M.values()].find(m => /^talk-with-music\.mp4$/.test(m.name))?.id);
if (mix) {
  await ev(id => { setProject(newProject('16:9')); P.name = 'Audio e2e stems (scratch)'; addMedia(id, 'main'); S.sel = { lane: 'main', id: P.main[0].id }; renderAll(); }, mix);
  made.push(await ev(() => P.id));
  await page.click('#inspector .itabs button[data-itab="Audio"]');
  const t0 = Date.now();
  await page.click('#inspector button[data-act="stems"]');
  await page.waitForFunction(() => P.audio.length === 4, null, { timeout: 600000, polling: 500 });
  const st = await ev(() => ({ names: P.audio.map(c => M.get(c.media).name), main: P.main[0].volume, sync: P.audio.every(c => c.start === P.main[0].start && c.in === P.main[0].in && c.out === P.main[0].out) }));
  check('Split into stems: four clips in sync, the source muted', st.names.length === 4 && st.main === 0 && st.sync, `${st.names.map(n => n.replace(/.*\((.*)\).*/, '$1')).join(', ')} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const ex = await ev(() => REMOTE.export({ format: 'wav', name: `audio-e2e-stems-${Date.now()}` }));
  const file = (await (await fetch(`${B}/api/media`)).json()).find(m => m.id === mix).file;
  const [sl] = pcm(`${os.homedir()}/Movies/Cutroom/exports/${ex.file}`), [ol] = pcm(`${os.homedir()}/Movies/Cutroom/media/${file}`);
  const s = snr(ol, sl, 0, Math.min(ol.length, sl.length) - 1);
  check('the four stems add back up to the original', s > 12, `${s.toFixed(1)} dB SNR`);
  stemIds.push(...await ev(() => P.audio.map(c => c.media))); // trashed at the end (the cache re-splits when they're gone)
}
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
for (const id of made) await fetch(`${B}/api/projects/${id}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
{ const X = `${os.homedir()}/Movies/Cutroom/exports/`; for (const f of fs.readdirSync(X).filter(f => f.startsWith('audio-e2e-'))) fs.renameSync(X + f, `${X}../trash/exports/${f}`); } // its exports, to the trash
for (const id of stemIds) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await fetch(`${B}/api/media/${media.id}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
