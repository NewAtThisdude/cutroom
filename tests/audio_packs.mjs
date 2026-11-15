import { requireHome } from './runtime.mjs';
// Audio round 2026-11-10, end to end on a scratch server: (1) the CC0 sound + music library (download, licences, the
// Audio rail: search, categories, listen, add), (2) Studio voice (speech-band SNR on talk-with-music and podcast-episode,
// onset delay, preview == export), (3) the 8 voice characters (pitch / formant / band checks, preview == export),
// (4) export loudness targets -14 / -16 / -23 / off, (5) beats() on a 3 minute song (time, same grid as before).
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node audio_packs.mjs [packs|studio|voices|loud|beats]   (never 4610)
// Its talk clips are made here (OS speech over music / noise, fixtures speechClip). The library download needs the internet:
// offline, or a source that won't download, is a SKIP (not a failure of the app). Demucs ("remove music") runs only with
// run_all --ai; the WORLD characters and the numpy beats need the AI tools' Python (ai/.venv), else SKIP.
import { PYTHON } from './runtime.mjs';
import { speechClip } from './fixtures.mjs';
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const LIB = requireHome();
const B = process.env.B, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2], SR = 48000;
if (!B || /:4610\b/.test(B)) throw new Error('run this on a scratch server (B=...), not on 4610');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const post = async (p, body) => (await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const run = name => !only || name === only;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AI = process.env.CUTROOM_TEST_AI === '1', AI_PY = `${ROOT}ai/.venv/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`, WORLD = fs.existsSync(AI_PY);

// ---------- signal helpers ----------
const mono = buf => { const x = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1), n = x.length >> 1, y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = (x[2 * i] + x[2 * i + 1]) / 65536; return y; };
const pcmOf = async (id, fx = '') => { const r = await fetch(`${B}/media/${id}?pcm=1${fx ? `&fx=${encodeURIComponent(fx)}` : ''}`); if (!r.ok) throw new Error(`pcm ${fx}: ${r.status} ${await r.text()}`); return mono(Buffer.from(await r.arrayBuffer())); };
const fileMono = f => mono(execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 's16le', '-ac', '2', '-ar', `${SR}`, '-'], { maxBuffer: 1 << 30 }));
const biquad = (x, type, f0, q = Math.SQRT1_2) => { // RBJ cookbook high / low pass
  const w = 2 * Math.PI * f0 / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2], a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
};
const band = (x, lo, hi) => biquad(biquad(biquad(biquad(x, 'hp', lo), 'hp', lo), 'lp', hi), 'lp', hi);
const frames = (x, fr = 960) => { const e = []; for (let i = 0; i + fr <= x.length; i += fr) { let s = 0; for (let k = i; k < i + fr; k++) s += x[k] * x[k]; e.push(s / fr); } return e; };
const energy = x => { let s = 0; for (const v of x) s += v * v; return s / x.length; };
const dB = v => 10 * Math.log10(v + 1e-20);
const mean = a => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const median = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const speechGap = (x, sp) => { // speech-band (300-3400 Hz) energy in the VAD's speech frames over the gaps between them (80 ms guard)
  const e = frames(band(x, 300, 3400)), act = [], gap = [];
  e.forEach((v, i) => { const t = (i + 0.5) * 0.02; if (sp.some(([a, b]) => t > a && t < b)) act.push(v); else if (!sp.some(([a, b]) => t > a - 0.08 && t < b + 0.08)) gap.push(v); });
  return { db: dB(mean(act)) - dB(mean(gap)), act: act.length, gap: gap.length };
};
const xlag = (a, b, max = 480) => { // the shift of b against a (samples) at the loudest 2 s of a
  let best = 0, at = 0;
  for (let i = 0; i + 96000 < a.length; i += 4800) { let s = 0; for (let k = i; k < i + 96000; k += 8) s += a[k] * a[k]; if (s > best) { best = s; at = i; } }
  let bl = 0, bv = -Infinity;
  for (let L = -max; L <= max; L++) { let s = 0; for (let k = at + max; k < at + 96000 - max; k += 2) s += a[k] * b[k + L]; if (s > bv) { bv = s; bl = L; } }
  return bl;
};
const snr = (a, b, from, to) => { let s = 0, e = 0; for (let i = from; i < to; i++) { s += a[i] * a[i]; e += (a[i] - b[i]) ** 2; } return 10 * Math.log10(s / (e + 1e-15)); };
const pitch = x => { // median f0 (Hz) of the louder voiced 40 ms frames: normalised autocorrelation at 12 kHz, 50-700 Hz
  const d = [], y = biquad(biquad(x, 'lp', 4000), 'lp', 4000);
  for (let i = 0; i < y.length; i += 4) d.push(y[i]);
  const sr = SR / 4, N = 480, f = [], es = [];
  for (let i = 0; i + 2 * N < d.length; i += N) es.push(energy(d.slice(i, i + N)));
  const loud = median(es);
  for (let j = 0, i = 0; i + 2 * N < d.length; i += N, j++) {
    if (es[j] < loud) continue;
    let bl = 0, bv = 0;
    for (let L = Math.floor(sr / 700); L <= Math.ceil(sr / 50); L++) { let s = 0, p = 0, q = 0; for (let k = i; k < i + N; k++) { s += d[k] * d[k + L]; p += d[k] * d[k]; q += d[k + L] * d[k + L]; } const r = s / Math.sqrt(p * q + 1e-20); if (r > bv) { bv = r; bl = L; } }
    if (bv > 0.7) f.push(sr / bl);
  }
  return { f0: median(f), n: f.length };
};
const fft = (re, im) => { // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), xr = re[i + k + len / 2] * c - im[i + k + len / 2] * s, xi = re[i + k + len / 2] * s + im[i + k + len / 2] * c; re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; } }
};
const ltas = x => { // long-term average spectrum (dB) of the louder half of 2048-point frames: the spectral envelope (harmonics smear out)
  const N = 2048, es = [], p = new Float64Array(N / 2);
  for (let i = 0; i + N <= x.length; i += N / 2) es.push(energy(x.subarray(i, i + N)));
  const loud = median(es);
  for (let j = 0, i = 0; i + N <= x.length; i += N / 2, j++) {
    if (es[j] < loud) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = x[i + k] * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / N));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) p[k] += re[k] * re[k] + im[k] * im[k];
  }
  const hz = SR / N, sm = []; // smoothed over a third of an octave
  for (let k = 0; k < N / 2; k++) { const lo = Math.max(1, Math.floor(k / 1.12)), hi = Math.min(N / 2 - 1, Math.ceil(k * 1.12)); let s = 0; for (let q = lo; q <= hi; q++) s += p[q]; sm.push(10 * Math.log10(s / (hi - lo + 1) + 1e-20)); }
  return f => { const b = f / hz, k = Math.floor(b), w = b - k; return sm[k] * (1 - w) + sm[k + 1] * w; };
};
const warp = (a, b) => { // the envelope stretch: alpha for which b(f) best matches a(f / alpha), 400 Hz - 4 kHz (log-spaced)
  const A = ltas(a), Bf = ltas(b), fs = []; for (let f = 400; f < 4000; f *= 1.02) fs.push(f);
  let best = 1, bv = -Infinity;
  for (let al = 0.6; al <= 1.6; al += 0.01) {
    const u = fs.map(f => A(f / al)), v = fs.map(f => Bf(f)), mu = mean(u), mv = mean(v);
    const c = u.reduce((s, x, i) => s + (x - mu) * (v[i] - mv), 0) / Math.sqrt(u.reduce((s, x) => s + (x - mu) ** 2, 0) * v.reduce((s, x) => s + (x - mv) ** 2, 0));
    if (c > bv) { bv = c; best = al; }
  }
  return best;
};
const envLag = (a, b) => { // the shift (samples, 1 ms steps) of b's loudness envelope against a's: timing, whatever the pitch
  const env = x => { const y = biquad(biquad(x.map(Math.abs), 'lp', 40), 'lp', 40), d = []; for (let i = 0; i < y.length; i += 48) d.push(y[i]); return d; };
  const p = env(a), q = env(b), m = mean(p), n = mean(q);
  let bl = 0, bv = -Infinity;
  for (let L = -50; L <= 50; L++) { let s = 0; for (let k = 50; k < p.length - 50; k++) s += (p[k] - m) * (q[k + L] - n); if (s > bv) { bv = s; bl = L; } }
  return bl * 48;
};
const lufs = f => { const r = spawnSync('ffmpeg', ['-v', 'info', '-i', f, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; const j = JSON.parse(r.slice(r.lastIndexOf('{'), r.lastIndexOf('}') + 1)); return { i: +j.input_i, tp: +j.input_tp }; };

// ---------- the page ----------
const b = await browser.launch();
const open = async rm => {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  page.errs = []; page.on('pageerror', e => page.errs.push(e.message)); page.on('dialog', d => d.accept());
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  return page;
};
const page = await open('no-preference'), ev = (f, a) => page.evaluate(f, a);
// the talk clips: a voice that stops ~9.4 s in (the cave's tail is read just after it), one over music, a 22 s podcast over room noise
// The music sits 10 dB under where it first was: the voice ~19 dB over it in the speech band, a vlog's music bed.
// Studio voice over this music at other levels: the sweep in section 2 (it made the voice LESS clear with the music within
// ~6-10 dB of it until 2026-11-15: bed 0 dB -2.85 dB speech/gap, -2 dB -2.17, -4 dB -0.22). Studio + remove music (Demucs)
// is the tool for such a mix.
const SAY = 'We drove up the coast at sunset. [[slnc 900]] Then we ate dinner at a little cafe by the harbour. [[slnc 900]] The mountain trail was steep and the snow was deep.';
const MUSIC = 'aevalsrc=0.06*(sin(2*PI*262*t)+sin(2*PI*330*t)+sin(2*PI*392*t))*(0.6+0.4*sin(2*PI*2*t))+0.08*sin(2*PI*65*t)*exp(-10*mod(t\\,0.5)):s=48000,volume=-10dB';
// talk.mp4 in a female voice on Windows too, like macOS's default (Samantha, f0 ~176 Hz; Zira ~182 Hz): over Windows' default
// male voice (David, ~93 Hz) the alien's 38 Hz ring modulation hides the period from the pitch tracker (2 voiced frames)
const clips = { 'talk.mp4': [SAY, { lead: 0.5, dur: 12, ...(process.platform === 'win32' && { voice: 'Microsoft Zira Desktop' }) }], 'talk-with-music.mp4': [SAY, { lead: 0.8, dur: 12, bed: MUSIC }],
  'podcast-episode.mp4': [`${SAY} [[slnc 900]] Back at the beach we talked about the drive home. [[slnc 900]] Next week we try the desert road, early, before the heat.`,
    { lead: 0.4, dur: 22, bed: 'anoisesrc=c=pink:r=48000:seed=9:amplitude=0.02' }] };
const truth = {}, ids = {};
for (const [name, [text, o]] of Object.entries(clips)) {
  const c = speechClip(name, text, o);
  if (!c) { console.log('SKIP audio packs suite: no OS speech service for its talk clips'); await b.close(); process.exit(0); }
  const m = await (await fetch(`${B}/api/import?name=${name}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(c.file) })).json();
  truth[m.id] = c.speech; ids[name] = m.id;
}
await ev(() => loadMedia());
await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), Object.values(ids), { timeout: 120000 });
const media = await get('/api/media'), byName = n => media.find(m => m.id === ids[n]);
const TALK = byName('talk.mp4'), TWM = byName('talk-with-music.mp4'), POD = byName('podcast-episode.mp4');
const made = [];
const fresh = name => ev(name => { setProject(newProject('16:9')); P.name = `${name} (scratch)`; S.t = 0; renderAll(); return P.id; }, name).then(id => (made.push(id), id));
const exportWav = name => ev(async name => (await REMOTE.export({ format: 'wav', name })).file, name).then(f => `${LIB}/exports/${f}`);
const select = async (lane, id) => { await ev(([lane, id]) => { S.sel = { lane, id }; renderAll(); }, [lane, id]); const t = page.locator('[data-itab="Audio"]'); if (await t.count()) await t.first().click(); };
const rows = p => p.evaluate(() => [...document.querySelectorAll('#sfxList .sfxrow')].map(r => [r.querySelector('b').textContent, r.querySelector('span').textContent, r.querySelector('b').title]));

// ---------- 1. the CC0 library ----------
let packsOffline = '';
const NET = /urlopen error|timed out|Connection (reset|refused|aborted)|Network is unreachable|IncompleteRead|RemoteDisconnected|Remote end closed/i;
const UPSTREAM = /HTTP Error|SHA-256 differs|changed upstream|no CC0 licence|no longer lists it as CC0/i;
if (run('packs')) {
  let idx = await get('/api/packs');
  if (!idx.installed) { // the button in the Audio rail, as a user would (the sources must be reachable first: offline is a SKIP)
    const down = (await Promise.all(['https://kenney.nl/', 'https://archive.org/'].map(u => fetch(u, { signal: AbortSignal.timeout(20000) }).then(r => (r.body?.cancel(), r.status < 500 ? '' : `${u} ${r.status}`), e => `${u} ${e.cause?.code || e.message}`)))).filter(Boolean);
    if (down.length) packsOffline = `the CC0 sources are unreachable (${down.join(', ')})`;
    else {
      await page.click('[data-tab="audio"]');
      const t0 = Date.now();
      await page.click('#btnPacks');
      await page.waitForFunction(() => G.snd?.installed || /nothing could be downloaded|failed|could not/i.test(document.querySelector('#toast')?.textContent), null, { timeout: 900000 });
      idx = await get('/api/packs');
      // the sources answered a moment ago: only a network-level failure (no connection, DNS, a timeout) is "offline". An HTTP
      // status (link rot), a changed SHA-256 or a lost CC0 licence is the library breaking upstream: a FAIL, never a SKIP
      const net = (idx.skipped || []).filter(x => NET.test(x)), toast = await page.textContent('#toast');
      if (!idx.installed) {
        if (NET.test(toast) && !UPSTREAM.test(toast)) packsOffline = `the network failed during the download: ${toast.slice(0, 300)}`;
        else check('library downloads from the Audio rail button', false, toast.slice(0, 400));
      } else {
        check('library downloads from the Audio rail button', true, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
        if (net.length) packsOffline = `the network failed for some sources: ${net.join('; ').slice(0, 300)}`;
      }
    }
  }
  if (idx.installed) { const bad = (idx.skipped || []).filter(x => !NET.test(x)); check('no source changed or lost its CC0 licence upstream (SHA-256, licence, HTTP status)', !bad.length, bad.join('; ').slice(0, 400)); }
  if (packsOffline) console.log(`SKIP CC0 sound library: ${packsOffline}`);
}
if (run('packs') && !packsOffline) {
  const idx = await get('/api/packs');
  const src = JSON.parse(fs.readFileSync(`${ROOT}packs.json`, 'utf8'));
  const sfx = idx.items.filter(x => x.kind === 'sfx'), mus = idx.items.filter(x => x.kind === 'music');
  const cats = new Set(sfx.map(x => x.cat)), moods = new Set(mus.map(x => x.cat));
  check('>= 150 CC0 sound effects in categories', sfx.length >= 150 && cats.size >= 6, `${sfx.length} sounds in ${cats.size} categories: ${[...cats].map(c => `${c} ${sfx.filter(x => x.cat === c).length}`).join(', ')}`);
  check('>= 20 CC0 music tracks across moods', mus.length >= 20 && moods.size >= 6, `${mus.length} tracks, ${moods.size} moods: ${[...moods].join(', ')}; ${(mus.reduce((s, x) => s + x.dur, 0) / 60).toFixed(0)} min`);
  check('every file records its source and a CC0 licence', idx.items.every(x => x.licence === 'CC0 1.0' && /^https:\/\/(kenney\.nl|archive\.org)\//.test(x.src) && /^[0-9a-f]{64}$/.test(x.sha256)), `${idx.items.length} rows; skipped: ${idx.skipped.join('; ') || 'none'}`);
  const pins = new Set([...src.sfx, ...src.music].map(x => x.sha256));
  check('each row\'s SHA-256 is a pinned source in packs.json', idx.items.every(x => pins.has(x.sha256)));
  check('every file is on disk with its duration', idx.items.every(x => fs.existsSync(`${LIB}/packs/${x.file}`) && x.dur > 0), `${(idx.items.reduce((s, x) => s + fs.statSync(`${LIB}/packs/${x.file}`).size, 0) / 1e6).toFixed(0)} MB`);
  const lic = fs.readdirSync(`${LIB}/packs/sfx`).every(d => /publicdomain\/zero\/1\.0/.test(fs.readFileSync(`${LIB}/packs/sfx/${d}/License.txt`, 'utf8')));
  check('each Kenney pack keeps its CC0 License.txt', lic);
  for (const rm of ['no-preference', 'reduce']) {
    const p = rm === 'reduce' ? await open('reduce') : page;
    await p.click('[data-tab="audio"]');
    await p.waitForFunction(() => G.snd?.installed && document.querySelectorAll('#sfxList .sfxrow').length > 0);
    const s = await p.evaluate(() => ({ chips: [...document.querySelectorAll('#sndCats button')].map(b => b.textContent), rows: document.querySelectorAll('#sfxList .sfxrow').length, basics: G.sfx.length }));
    check(`[${rm}] rail: chips All, Music, Basics + the pack categories; the 19 synthesized sounds kept`, s.chips[0] === 'All' && s.chips.includes('Music') && s.chips.includes('Basics') && s.basics === 19 && s.chips.length >= 9, `${s.chips.join(' | ')}; ${s.rows} rows shown`);
    await p.fill('#sndSearch', 'footstep');
    const f = await rows(p);
    check(`[${rm}] search "footstep" lists only footsteps`, f.length > 10 && f.every(([n]) => /footstep/i.test(n)), `${f.length} rows`);
    await p.fill('#sndSearch', '');
    await p.click('#sndCats button:text-is("Music")');
    const m = await rows(p);
    check(`[${rm}] Music: every track with mood, duration and its licence + source on hover`, m.length === mus.length && m.every(([, d, t]) => /\d:\d\d|\d s/.test(d) && /CC0 1\.0 · https:\/\/archive\.org/.test(t)), m.slice(0, 2).map(x => x.slice(0, 2).join(' ')).join('; '));
    await p.click('#sndCats button:text-is("Sci-fi")');
    const sc = await p.evaluate(() => [document.querySelectorAll('#sfxList .sfxrow').length, G.snd.items.filter(x => x.cat === 'Sci-fi').length]);
    check(`[${rm}] Sci-fi category`, sc[0] === Math.min(60, sc[1]), `${sc[0]} of ${sc[1]}`);
    if (sc[1] > 60) { await p.click('[data-sndmore]'); check(`[${rm}] "Show more" pages through the rest`, (await p.evaluate(() => document.querySelectorAll('#sfxList .sfxrow').length)) === sc[1]); }
    await p.click('#sfxList .sfxrow .pl >> nth=0');
    const pl = await p.waitForFunction(() => G.audio && G.audio.dataset.src.startsWith('/packs/') && !G.audio.paused && G.audio.currentTime > 0, null, { timeout: 10000 }).then(() => true, () => false);
    check(`[${rm}] the play button previews the sound`, pl, await p.evaluate(() => G.audio?.dataset.src));
    const box = await p.evaluate(() => { const l = document.querySelector('#sfxList').getBoundingClientRect(), pane = document.querySelector('#tab-audio').getBoundingClientRect(); return { l: [l.left, l.right, l.height], pane: [pane.left, pane.right], over: [...document.querySelectorAll('#sfxList .sfxrow')].filter(r => r.scrollWidth > r.clientWidth + 1).length }; });
    check(`[${rm}] the list stays inside the panel (capped height, no row overflow)`, box.l[0] >= box.pane[0] && box.l[1] <= box.pane[1] && box.l[2] <= 341 && !box.over, JSON.stringify(box));
    if (rm === 'reduce') await p.context().close();
  }
  // add: a pack sound and a music track onto the audio track, imported once
  await fresh('Packs add');
  await page.click('#sndCats button:text-is("Impacts")');
  await page.click('#sfxList .sfxrow .add >> nth=0');
  await page.waitForFunction(() => P.audio.length === 1, null, { timeout: 20000 });
  const a1 = await ev(() => { const c = P.audio[0], m = M.get(c.media); return { media: c.media, pack: m.pack, licence: m.licence, src: m.src }; });
  await page.click('#sfxList .sfxrow .add >> nth=0');
  await page.waitForFunction(() => P.audio.length === 2, null, { timeout: 20000 });
  const a2 = await ev(() => P.audio[1].media);
  check('+ adds a pack sound; its library item keeps source + licence; added twice = one import', a1.pack && a1.licence === 'CC0 1.0' && /kenney\.nl/.test(a1.src) && a2 === a1.media, JSON.stringify(a1).slice(0, 200));
  await page.click('#sndCats button:text-is("Music")');
  await page.click('#sfxList .sfxrow .add >> nth=0');
  await page.waitForFunction(() => P.audio.length === 3, null, { timeout: 30000 });
  const tr = await ev(() => { const c = P.audio[2]; return { len: tdur(c, 'audio'), m: M.get(c.media) }; });
  const want = idx.items.find(x => x.id === tr.m.pack);
  check('a music track goes on the audio track at its full length', want?.kind === 'music' && Math.abs(tr.len - want.dur) < 0.1, `${tr.m.name}: ${tr.len.toFixed(2)} s vs ${want?.dur} s`);
  const lib = await ev(() => REMOTE.sound_library({ query: 'laser' }));
  check('MCP sound_library searches the packs', lib.installed && lib.total > 0 && lib.results.every(r => /laser/i.test(r.name)), `${lib.total} lasers`);
  const added = await ev(id => REMOTE.add_sound({ name: id, at: 5 }), lib.results[0].id);
  check('add_sound_effect(<pack id>) adds it', added?.lane === 'audio' && Math.abs(added.start - 5) < 1e-6, JSON.stringify(added).slice(0, 160));
  const tools = spawnSync(PYTHON, ['-X', 'utf8', '-I', `${ROOT}mcp/cutroom_mcp.py`], { input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', encoding: 'utf8', timeout: 10000 }).stdout;
  check('MCP lists sound_library; export takes a loudness target', /"sound_library"/.test(tools) && /-23 \(EBU broadcast\)/.test(tools));
}

// ---------- 2. Studio voice ----------
if (run('studio')) {
  const out = {}, FXS = AI ? ['dn', 'sv', 'svm'] : ['dn', 'sv'];
  if (!AI) console.log('SKIP Studio voice + remove music (svm, Demucs): AI models excluded (run_all --ai to enable)');
  for (const m of [TWM, POD]) {
    const sp = (await post('/api/speech', { media: m.id })).speech || truth[m.id], raw = await pcmOf(m.id), r0 = speechGap(raw, sp); // (no VAD: where the voice was put)
    out[m.name] = { raw: r0.db };
    for (const fx of FXS) {
      const t0 = Date.now(), y = await pcmOf(m.id, fx), r = speechGap(y, sp);
      out[m.name][fx] = { db: r.db, gain: r.db - r0.db, s: (Date.now() - t0) / 1000, len: y.length === raw.length, lag: xlag(raw, y) };
    }
    const o = out[m.name];
    console.log(`     ${m.name}: speech/gap ${o.raw.toFixed(1)} dB; ` + FXS.map(k => `${k} ${o[k].db.toFixed(1)} (+${o[k].gain.toFixed(1)}) lag ${o[k].lag} made ${o[k].s.toFixed(1)} s`).join('; ') + ` (VAD: ${r0.act} speech / ${r0.gap} gap frames)`);
  }
  const pod = out['podcast-episode.mp4'], twm = out['talk-with-music.mp4'];
  check('podcast-episode: Studio voice raises the speech-band SNR (speech over gaps) by > 3 dB', pod.sv.gain > 3, `+${pod.sv.gain.toFixed(2)} dB (Reduce noise alone +${pod.dn.gain.toFixed(2)})`);
  if (AI) check('talk-with-music: Studio + remove music raises it by > 10 dB', twm.svm.gain > 10, `+${twm.svm.gain.toFixed(2)} dB (Studio voice without Demucs +${twm.sv.gain.toFixed(2)}: RNNoise leaves music)`);
  check('talk-with-music: Studio voice alone still improves it', twm.sv.gain > 0.3, `+${twm.sv.gain.toFixed(2)} dB`);
  check('processed sound keeps the source length (sample exact)', Object.values(out).every(o => FXS.every(k => o[k].len)));
  check('podcast: no delay (cross-correlation lag within 2 ms) for dn / sv / svm', FXS.every(k => Math.abs(pod[k].lag) <= 96), FXS.map(k => `${k} ${pod[k].lag}`).join(', ') + ' samples');
  // onset: speech-like bursts (sharp starts) over a noise floor; each start through Studio voice, against the input
  const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-sv-`), f = `${tmp}/studio-onsets.wav`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.004*(random(0)-0.5)+if(lt(mod(t\\,1.5)\\,0.6)*gt(t\\,0.5)\\,0.5*(random(1)-0.5)*(1+0.6*sin(2*PI*180*t))*(0.6+0.4*sin(2*PI*4*t))\\,0):s=48000:d=9', '-ac', '2', f]);
  const burst = await (await fetch(`${B}/api/import?name=studio-onsets.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
  const x = await pcmOf(burst.id), y = await pcmOf(burst.id, 'sv');
  const onsets = s => { // first sample over 20 % of the peak in each burst
    const k = 48, e = []; for (let i = 0; i + k < s.length; i += k) { let m = 0; for (let j = i; j < i + k; j++) m = Math.max(m, Math.abs(s[j])); e.push(m); }
    const pk = Math.max(...e), on = [];
    for (let i = 1; i < e.length; i++) if (e[i] > 0.2 * pk && e[i - 1] <= 0.2 * pk && (!on.length || i * k - on.at(-1) > SR)) { let j = (i - 1) * k; while (Math.abs(s[j]) < 0.2 * pk) j++; on.push(j); }
    return on;
  };
  const lagAt = (a, b, o) => { let bl = 0, bv = -Infinity; for (let L = -480; L <= 480; L++) { let s = 0; for (let k = o; k < o + 2400; k++) s += a[k] * b[k + L]; if (s > bv) { bv = s; bl = L; } } return bl; }; // its first 50 ms
  const o1 = onsets(x), d = o1.map(o => lagAt(x, y, o));
  check('Studio voice: every burst starts within 2 ms of the input (no look-ahead)', o1.length >= 5 && d.every(v => Math.abs(v) <= 96), `${o1.length} bursts at ${o1.map(o => (o / SR).toFixed(2)).join(', ')} s; shift of each burst's first 50 ms: ${d.join(', ')} samples`);
  await post(`/api/media/${burst.id}/trash`, {});
  // Studio voice never makes the speech worse than it came in. The voice is mixed here over beds at known levels, so its speech
  // regions are known (speechClip's) and the clean voice is the reference. Every documented bed level of the 2026-11-14 sweep
  // (OS speech over MUSIC with its volume at 0 dB = the voice ~9.5 dB over it), denser points around where it went wrong
  // (0 to -8 dB), louder music, other beds (drums + bass + lead, pink noise), clean speech (a -70 dB floor), one breath of
  // continuous speech, two voices, and no speech at all. Per mix: the speech-band speech/gap change (>= 0: zero measured
  // degradation), the speech kept (speech/gap alone rewards a gate that eats quiet syllables: the share of voiced 20 ms frames
  // whose clean-voice component, <y,s>^2/|s|^2, fell 10 dB below the typical one), the length, the lag and the true peak.
  {
    const ffmix = (out, ins, graph) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...ins.flatMap(i => i.startsWith('aevalsrc') || i.startsWith('anoisesrc') ? ['-f', 'lavfi', '-i', i] : ['-i', i]),
      '-filter_complex', graph, '-ac', '2', '-ar', `${SR}`, '-c:a', 'pcm_s16le', '-t', '12', out]);
    const CONT = 'We drove up the coast at sunset and then we ate dinner at a little cafe by the harbour while the boats came in';
    const SAY2 = 'Did you see the lighthouse? [[slnc 1500]] I think the road was closed after the storm.';
    const v1 = speechClip('sv-voice.wav', SAY, { lead: 0.8, dur: 12, video: false });
    const vc = speechClip('sv-voice-cont.wav', CONT, { lead: 0.8, dur: 12, video: false });
    const v2 = speechClip('sv-voice2.wav', SAY2, { lead: 2.6, dur: 12, video: false, voice: process.platform === 'win32' ? 'Microsoft David Desktop' : 'Daniel' });
    const tmp2 = fs.mkdtempSync(`${os.tmpdir()}/cutroom-svsweep-`);
    const BED = { music: L => MUSIC.replace('volume=-10dB', `volume=${L}dB`),
      drums: L => `aevalsrc=0.3*(random(0)-0.5)*exp(-25*mod(t\\,0.25))+0.25*sin(2*PI*55*t)*exp(-6*mod(t\\,0.5))+0.04*sin(2*PI*(440+220*gt(mod(t\\,1)\\,0.5))*t):s=48000,volume=${L}dB`,
      pink: L => `anoisesrc=c=pink:r=48000:seed=5:amplitude=0.05,volume=${L}dB`, floor: () => 'anoisesrc=c=pink:r=48000:seed=7:amplitude=0.0006' };
    const mix = (voices, bed, L) => [[...voices.map(v => v.file), BED[bed](L)], voices.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[v${i}]`).join(';') +
      `;[${voices.length}:a]aformat=sample_rates=48000:channel_layouts=stereo[b];${voices.map((_, i) => `[v${i}]`).join('')}[b]amix=inputs=${voices.length + 1}:normalize=0:duration=first`];
    const cases = [...[15, 6, 3, 0, -1, -2, -3, -4, -5, -6, -7, -8, -10, -15, -20].map(L => [`music ${L} dB`, [v1], 'music', L]), ['drums +12 dB', [v1], 'drums', 12],
      ['drums 0 dB', [v1], 'drums', 0], ['drums -6 dB', [v1], 'drums', -6], ['pink noise +6 dB', [v1], 'pink', 6], ['pink noise -6 dB', [v1], 'pink', -6],
      ['clean speech', [v1], 'floor'], ['continuous speech, music -4 dB', [vc], 'music', -4], ['two voices, music 0 dB', [v1, v2], 'music', 0], ['two voices, drums -3 dB', [v1, v2], 'drums', -3]];
    const keptLost = (y, s, sp) => { // % of voiced frames (clean voice within 20 dB of its median) whose voice component fell 10 dB under the typical one
      const Y = band(y, 300, 3400), S = band(s, 300, 3400), es = frames(S), idx = es.map((v, i) => i).filter(i => sp.some(([a, b]) => (i + 0.5) * 0.02 > a && (i + 0.5) * 0.02 < b));
      const med = median(idx.map(i => es[i])), use = idx.filter(i => es[i] > med / 100), r = use.map(i => { let p = 0; for (let k = i * 960; k < (i + 1) * 960; k++) p += Y[k] * S[k]; return p * p / (es[i] * 960) / 960 / es[i]; });
      const G = median(r); return 100 * r.filter(v => v < G / 10).length / Math.max(1, r.length);
    };
    const tpOf = async (id, fx) => { const f = `${tmp2}/tp.raw`; fs.writeFileSync(f, Buffer.from(await (await fetch(`${B}/media/${id}?pcm=1&fx=${fx}`)).arrayBuffer())); const r = spawnSync('ffmpeg', ['-v', 'info', '-f', 's16le', '-ar', `${SR}`, '-ac', '2', '-i', f, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; return +JSON.parse(r.slice(r.lastIndexOf('{'), r.lastIndexOf('}') + 1)).input_tp; };
    const asIs = (x, y) => { // y is x times one gain (to 40 dB SNR): the sound as it was, at most lowered for its peak
      let xy = 0, xx = 0; for (let i = 0; i < x.length; i++) { xy += x[i] * y[i]; xx += x[i] * x[i]; }
      const k = xx / Math.max(1e-20, xy); return x.length === y.length && snr(x, y.map(v => v * k), 0, x.length) > 40;
    };
    const rows = [];
    for (const [name, voices, bed, L] of cases) {
      const f = `${tmp2}/sv-${rows.length}.wav`, [ins, graph] = mix(voices, bed, L);
      ffmix(f, ins, graph);
      const s = voices.length === 1 ? fileMono(voices[0].file) : (ffmix(`${f}.clean.wav`, voices.map(v => v.file), `${graph.split(';[' + voices.length)[0]};${voices.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voices.length}:normalize=0:duration=first`), fileMono(`${f}.clean.wav`));
      const sp = voices.flatMap(v => v.speech);
      const m = await (await fetch(`${B}/api/import?name=sv-sweep-${rows.length}.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
      const x = await pcmOf(m.id);
      // a stale result where an earlier Studio voice kept its processed sound (1x, a speed's span, a character on top): zeros
      // the length of the sound. The cache key carries the processing's version, so none of them may come back
      if (!rows.length) for (const k of ['sv', 'sv.1.5.0-12', 'sv+cave']) fs.writeFileSync(`${LIB}/cache/${m.id}.${k}.pcm`, Buffer.alloc(x.length * 4));
      const y = await pcmOf(m.id, 'sv'), g0 = speechGap(x, sp), g1 = speechGap(y, sp);
      if (!rows.length) {
        const sped = mono(Buffer.from(await (await fetch(`${B}/media/${m.id}?pcm=1.5&a=0&b=12&fx=sv`)).arrayBuffer())), cave = await pcmOf(m.id, 'sv+cave'), live = a => a.length > SR && a.some(v => v !== 0);
        check('a Studio voice result cached before this version is not reused (1x, at 1.5x, with a character on top)', live(y) && live(sped) && live(cave), `samples ${y.length} / ${sped.length} / ${cave.length}`);
      }
      // the gate test: a hard gate on the mix (its quietest half of 20 ms speech-band frames zeroed) wins speech/gap and loses speech
      if (name === 'music -10 dB') {
        const e = frames(band(x, 300, 3400)), cut = median(e), gx = x.map((v, i) => e[Math.floor(i / 960)] < cut ? 0 : v);
        check('speech kept catches what speech/gap rewards: a hard gate on the music -10 dB mix', speechGap(gx, sp).db > g0.db + 3 && keptLost(gx, s, sp) > keptLost(x, s, sp) + 1, // (+1: the speech-kept tolerance below: that gate would fail it)
          `speech/gap ${g0.db.toFixed(1)} -> ${speechGap(gx, sp).db.toFixed(1)} dB; voiced frames lost ${keptLost(x, s, sp).toFixed(1)} -> ${keptLost(gx, s, sp).toFixed(1)} %`);
      }
      rows.push({ name, gain: g1.db - g0.db, raw: g0.db, lost0: keptLost(x, s, sp), lost: keptLost(y, s, sp), lostDn: keptLost(await pcmOf(m.id, 'dn'), s, sp), len: x.length === y.length, lag: xlag(x, y), tp: await tpOf(m.id, 'sv'), same: asIs(x, y) });
      await post(`/api/media/${m.id}/trash`, {});
    }
    const show = r => `${r.name} ${r.raw.toFixed(1)}${r.gain >= 0 ? '+' : ''}${r.gain.toFixed(2)}`;
    console.log(`     Studio voice sweep (speech/gap in, change; voiced frames lost in -> out, Reduce noise; lag; dBTP):\n       ` + rows.map(r => `${show(r)} lost ${r.lost0.toFixed(1)}->${r.lost.toFixed(1)}% (dn ${r.lostDn.toFixed(1)}) lag ${r.lag} tp ${r.tp.toFixed(1)}${r.same ? ' (as it was)' : ''}`).join('\n       '));
    check(`Studio voice never lowers the speech-band speech/gap (${rows.length} mixes: music +15 to -20 dB, drums, pink noise, clean, continuous, two voices)`, rows.every(r => r.gain >= -0.01), rows.filter(r => r.gain < -0.01).map(show).join('; ') || `worst ${show(rows.reduce((a, r) => r.gain < a.gain ? r : a))}`);
    // where it can't make the voice clearer (music 15 dB or drums 12 dB over where they started: the voice 0-5 dB over them), the
    // sound comes back as it was (only lowered to keep the true peak under -1.5 dBTP)
    const kept = rows.filter(r => /^(music 15|drums \+12) dB/.test(r.name));
    check('Studio voice leaves a mix it would not make clearer as it was (music +15 dB, drums +12 dB)', kept.length === 2 && kept.every(r => r.same), kept.map(r => `${r.name}: ${r.same ? 'as it was' : `processed, ${r.gain.toFixed(2)} dB`}`).join('; '));
    // RNNoise (its first stage, = Reduce noise) takes some masked syllables under loud music down >10 dB (2-4 % of voiced frames,
    // as before 2026-11-15); what Studio voice adds on top of it (expander, EQ, de-esser) must take no more than 1 point more
    check('Studio voice keeps the speech: voiced frames lost <= Reduce noise alone (or the input) + 1 point in every mix', rows.every(r => r.lost <= Math.max(r.lostDn, r.lost0) + 1),
      rows.filter(r => r.lost > Math.max(r.lostDn, r.lost0) + 1).map(r => `${r.name} in ${r.lost0.toFixed(1)} dn ${r.lostDn.toFixed(1)} sv ${r.lost.toFixed(1)}`).join('; ') || `worst sv - max(dn, in): ${Math.max(...rows.map(r => r.lost - Math.max(r.lostDn, r.lost0))).toFixed(1)} points`);
    check('Studio voice sweep: sample-exact length, lag within 2 ms, true peak <= -1.4 dBTP', rows.every(r => r.len && Math.abs(r.lag) <= 96 && r.tp <= -1.4), rows.filter(r => !r.len || Math.abs(r.lag) > 96 || r.tp > -1.4).map(r => `${r.name} len ${r.len} lag ${r.lag} tp ${r.tp}`).join('; '));
    // no speech at all (room noise; digital silence): nothing to make clearer, so the sound comes back as it was
    const quiet = [];
    for (const [name, src] of [['room noise', 'anoisesrc=c=pink:r=48000:seed=3:amplitude=0.02'], ['digital silence', 'anullsrc=r=48000:cl=stereo']]) {
      const f = `${tmp2}/none-${quiet.length}.wav`;
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-ac', '2', '-ar', `${SR}`, '-c:a', 'pcm_s16le', '-t', '6', f]);
      const m = await (await fetch(`${B}/api/import?name=sv-none-${quiet.length}.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
      const x = await pcmOf(m.id), y = await pcmOf(m.id, 'sv');
      quiet.push([name, x.length === y.length && x.every((v, i) => v === y[i]), dB(energy(y)) - dB(energy(x))]);
      await post(`/api/media/${m.id}/trash`, {});
    }
    check('no speech (room noise, digital silence): Studio voice leaves the sound exactly as it was', quiet.every(q => q[1]), quiet.map(([n, same, d]) => `${n}: ${same ? 'unchanged' : `changed, ${d.toFixed(1)} dB`}`).join('; '));
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
  // preview == export, through the inspector's button
  await fresh('Studio voice parity');
  await ev(id => { addMedia(id, 'main', 0); const c = P.main[0]; c.out = Math.min(c.out, 20); renderAll(); }, POD.id);
  await select('main', await ev(() => P.main[0].id));
  await page.click('[data-studio="on"]');
  await page.waitForFunction(() => P.main[0].studio === true, null, { timeout: 120000 });
  const on = await ev(() => document.querySelector('[data-studio="on"]').classList.contains('on'));
  const ex = fileMono(await exportWav(`Studio voice parity ${Date.now()}`)), ref = await pcmOf(POD.id, 'sv');
  const s = snr(ref, ex, 0.1 * SR, 19.9 * SR);
  check('Studio voice: the export is the sound the preview plays (inspector button)', s > 40 && on, `${s.toFixed(1)} dB SNR, export vs the preview's PCM; button on ${on}`);
  await page.click('[data-studio="off"]');
  check('Studio voice off again', await ev(() => !P.main[0].studio));
}

// ---------- 3. voice characters ----------
if (run('voices')) {
  const raw = await pcmOf(TALK.id), p0 = pitch(raw);
  const hp = x => biquad(biquad(x, 'hp', 1200), 'hp', 1200), out = {}, AI = ['elf', 'giant', 'monster', 'alien'];
  if (!WORLD) console.log(`SKIP voice characters elf, giant, monster, alien (WORLD vocoder): no AI tools Python at ${AI_PY}`);
  for (const v of [...(WORLD ? AI : []), 'radio', 'megaphone', 'cave', 'underwater']) {
    const t0 = Date.now(), y = await pcmOf(TALK.id, v);
    out[v] = { y, s: (Date.now() - t0) / 1000, len: y.length === raw.length, rms: dB(energy(y)) - dB(energy(raw)), p: pitch(y), warp: warp(raw, y), lag: AI.includes(v) ? envLag(raw, y) : xlag(band(raw, 100, 1000), band(y, 100, 1000), 960),
      high: dB(energy(band(y, 6000, 12000))) - dB(energy(band(y, 300, 3000))) - dB(energy(band(raw, 6000, 12000))) + dB(energy(band(raw, 300, 3000))), above: dB(energy(hp(y))) - dB(energy(hp(raw))) };
    const o = out[v];
    console.log(`     ${v}: made in ${o.s.toFixed(1)} s, level ${o.rms.toFixed(1)} dB, f0 ${o.p.f0?.toFixed(0)} Hz vs ${p0.f0.toFixed(0)} (x${(o.p.f0 / p0.f0).toFixed(2)}, ${o.p.n} frames), envelope x${o.warp.toFixed(2)}, 6-12 kHz ${o.high.toFixed(1)} dB, >1.2 kHz ${o.above.toFixed(1)} dB, lag ${o.lag}`);
  }
  check('all 8 characters keep the length', Object.values(out).every(o => o.len));
  const r = v => out[v].p.f0 / p0.f0;
  const ok = (v, f0, fr) => Math.abs(r(v) / f0 - 1) < 0.15 && Math.abs(out[v].warp / fr - 1) < 0.1, say = v => `pitch x${r(v).toFixed(2)}, spectral envelope x${out[v].warp.toFixed(2)}`;
  if (WORLD) {
    check('elf: pitch x1.65 and formants x1.2 (pitch +-15 %, envelope +-10 %)', ok('elf', 1.65, 1.2), say('elf'));
    check('giant: pitch x0.6 and formants x0.8', ok('giant', 0.6, 0.8), say('giant'));
    check('monster: pitch x0.5 and formants x0.72', ok('monster', 0.5, 0.72), say('monster'));
    check('alien: pitch x1.25 (with vibrato) and formants x1.12', ok('alien', 1.25, 1.12), say('alien'));
  }
  check('formant-aware: a reverb (cave) leaves the envelope where it was (x1 +-5 %)', Math.abs(out.cave.warp - 1) <= 0.05, `cave x${out.cave.warp.toFixed(2)}`);
  const peak = y => y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  check('no character clips: peaks under -1.5 dBFS (the export limiter at -1 dBFS then changes nothing)', Object.values(out).every(o => peak(o.y) < 0.85), Object.entries(out).map(([k, o]) => `${k} ${(20 * Math.log10(peak(o.y))).toFixed(1)}`).join(', ') + ' dBFS');
  { // the band limit on a broadband probe (pink noise): the OS voice's own 6-12 kHz (Windows' voices have ~7-9 dB less than macOS's)
    // sets how far it can fall, under the distortion the drive adds (the same samples on both systems: 111-230 dB SNR, 2026-11-14)
    const f = `${os.tmpdir()}/cutroom-band-probe.wav`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:seed=3:amplitude=0.1:d=4', '-ac', '2', f]);
    const pm = await (await fetch(`${B}/api/import?name=band-probe.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
    fs.rmSync(f, { force: true });
    const praw = await pcmOf(pm.id), hi = y => dB(energy(band(y, 6000, 12000))) - dB(energy(band(y, 300, 3000))) - dB(energy(band(praw, 6000, 12000))) + dB(energy(band(praw, 300, 3000)));
    const radio = hi(await pcmOf(pm.id, 'radio')), mega = hi(await pcmOf(pm.id, 'megaphone'));
    await post(`/api/media/${pm.id}/trash`, {});
    check('band-limited against the voice band (300 Hz - 3 kHz), on pink noise: radio 6-12 kHz down > 25 dB, megaphone (3.8 kHz horn) > 18 dB', radio < -25 && mega < -18, `radio ${radio.toFixed(1)}, megaphone ${mega.toFixed(1)} dB (on the voice: ${out.radio.high.toFixed(1)}, ${out.megaphone.high.toFixed(1)})`);
  }
  check('underwater: muffled (energy above 1.2 kHz down > 20 dB)', out.underwater.above < -20, `${out.underwater.above.toFixed(1)} dB`);
  const end = truth[TALK.id].at(-1)[1], tail = x => { let e = 0; for (let i = Math.round((end + 0.15) * SR); i < Math.min(x.length, Math.round((end + 0.45) * SR)); i++) e += x[i] * x[i]; return e; }; // where the voice stopped (its own timing: the OS voices differ by 1.7 s)
  const cave = dB(tail(out.cave.y)) - dB(tail(raw));
  check('cave: a reverb tail where the voice has stopped', cave > 10, `${cave.toFixed(1)} dB more in ${(end + 0.15).toFixed(2)}-${(end + 0.45).toFixed(2)} s`);
  check('characters are not delayed: within 2 ms (waveform; WORLD ones by their loudness envelope, 1 ms steps)', Object.values(out).every(o => Math.abs(o.lag) <= 96), Object.entries(out).map(([k, o]) => `${k} ${o.lag}`).join(', ') + ' samples');
  // preview == export through the inspector's voice buttons; a character on top of Studio voice too
  for (const [v, studio] of [['elf', false], ['cave', false], ['giant', true]].filter(([v]) => WORLD || !AI.includes(v))) {
    await fresh(`Voice ${v} parity`);
    await ev(id => addMedia(id, 'main', 0), TALK.id);
    await select('main', await ev(() => P.main[0].id));
    if (studio) { await page.click('[data-studio="on"]'); await page.waitForFunction(() => P.main[0].studio === true, null, { timeout: 120000 }); }
    await page.click(`[data-voice="${v}"]`);
    await page.waitForFunction(v => P.main[0].au?.voice === v, v, { timeout: 120000 });
    const on = await ev(v => document.querySelector(`[data-voice="${v}"]`).classList.contains('on'), v);
    const fx = studio ? `sv+${v}` : v, ex = fileMono(await exportWav(`Voice ${v} parity ${Date.now()}`)), ref = await pcmOf(TALK.id, fx), n = Math.min(ex.length, ref.length);
    const s = snr(ref, ex, 0.1 * SR, n - 0.1 * SR);
    check(`${fx}: the export is the sound the preview plays (inspector button)`, s > 40 && on, `${s.toFixed(1)} dB SNR; button on ${on}`);
  }
}

// ---------- 4. loudness targets ----------
if (run('loud')) {
  // three tones under a slow swell, crest factor ~6 dB: every target is reachable under the -1.5 dBTP ceiling (the podcast's
  // and the CC0 songs' peaks hold them at -17..-21 LUFS: loudness_gain() never pushes the true peak past -1.5 dBTP)
  const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-loud-`), f = `${tmp}/loudness-tones.wav`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.05*(sin(2*PI*300*t)+sin(2*PI*800*t)+sin(2*PI*2000*t))*(0.7+0.3*sin(2*PI*0.5*t)):s=48000:d=20', '-ac', '2', f]);
  const tones = await (await fetch(`${B}/api/import?name=loudness-tones.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready && M.get(id).duration > 19, tones.id, { timeout: 30000 });
  await fresh('Loudness targets');
  await ev(id => { addMedia(id, 'audio', 0); renderAll(); }, tones.id);
  const got = {};
  for (const L of [false, -14, -16, -23]) {
    const f = await ev(async L => (await REMOTE.export({ format: 'wav', name: `Loudness ${L} ${Date.now()}`, loudness: L })).file, L);
    got[L] = lufs(`${LIB}/exports/${f}`);
  }
  console.log('     ' + Object.entries(got).map(([k, v]) => `${k}: ${v.i.toFixed(2)} LUFS, ${v.tp.toFixed(2)} dBTP`).join('; '));
  for (const L of [-14, -16, -23]) check(`export loudness ${L} LUFS (within 0.5 LU)`, Math.abs(got[L].i - L) <= 0.5 && got[L].tp <= -1.4, `${got[L].i.toFixed(2)} LUFS, ${got[L].tp.toFixed(2)} dBTP`);
  check('loudness off: the mix as it is (not moved to a target)', [-14, -16, -23].every(L => Math.abs(got.false.i - L) > 0.3), `${got.false.i.toFixed(2)} LUFS`);
  await ev(() => openExport());
  await page.waitForSelector('#exLoud');
  const sel = await ev(() => [...document.querySelector('#exLoud').options].map(o => `${o.value}=${o.textContent}`));
  await page.selectOption('#exPreset', 'tiktok');
  const tk = await ev(() => document.querySelector('#exLoud').value);
  await page.selectOption('#exPreset', 'master');
  const ms = await ev(() => document.querySelector('#exLoud').value);
  check('export dialog: loudness off / -14 social / -16 podcast / -23 broadcast; presets set it', sel.length === 4 && tk === '-14' && ms === 'off', `${sel.join(', ')}; TikTok ${tk}, Master ${ms}`);
  await page.keyboard.press('Escape');
  await post(`/api/media/${tones.id}/trash`, {});
}

// ---------- 5. beats on a 3 minute song ----------
if (run('beats')) {
  const song = (await get('/api/packs')).items?.find(x => x.name === 'Sunglasses');
  if (!song && packsOffline) console.log(`SKIP beats on the pack song: ${packsOffline}`);
  else if (!song) check('beats: the pack song Sunglasses is installed', false);
  else {
    const m = await post('/api/packs/add', { id: song.id });
    for (let k = 0; k < 60 && !(await get('/api/media')).find(x => x.id === m.id)?.peaks; k++) await new Promise(r => setTimeout(r, 500)); // its preview PCM is made at import
    const ts = [], decs = [], src = `${LIB}/media/${(await get('/api/media')).find(x => x.id === m.id).file}`, raw = `${os.tmpdir()}/cutroom-beats-${m.id}.raw`;
    let r;
    for (let k = 0; k < 4; k++) { // interleaved with the old way's decode, so a load spike on this busy Mac hits both
      fs.rmSync(`${LIB}/cache/${m.id}.beats.json`, { force: true });
      let t0 = performance.now(); r = await post('/api/beats', { media: m.id }); ts.push((performance.now() - t0) / 1000);
      t0 = performance.now(); execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', raw]); decs.push((performance.now() - t0) / 1000);
    }
    const gaps = r.beats.slice(1).map((v, i) => v - r.beats[i]), sd = Math.sqrt(mean(gaps.map(g => (g - mean(gaps)) ** 2)));
    // the same run, the same bytes: the per-sample loops beats() had before (fbe3c4a, verbatim below) vs ai/beats.py (numpy,
    // what the app runs) vs server.py's stdlib fallback; the old one end to end = its MP3 decode + its loops
    const dec = Math.min(...decs);
    const OLD = `import sys, math, statistics, time, json
from array import array
x = array('h'); x.frombytes(open(sys.argv[1], 'rb').read())
def old():
    sr, hop = 8000, 128
    n, fps = len(x) // hop, sr / hop
    env = [math.log1p(sum(v * v for v in x[i * hop:(i + 1) * hop]) / hop / 1e4) for i in range(n)]
    on = [0.0] + [max(0.0, env[i] - env[i - 1]) for i in range(1, n)]
    sd = statistics.pstdev(on) or 1.0
    on = [v / sd for v in on]
    prior = lambda L: math.exp(-0.5 * math.log2(60 * fps / L / 120) ** 2)
    period = max(range(int(60 * fps / 180), int(60 * fps / 60) + 1), key=lambda L: prior(L) * sum(on[i] * on[i - L] for i in range(L, n)))
    score, back = on[:], [-1] * n
    for t in range(n):
        best, arg = -1e9, -1
        for prev in range(max(0, t - 2 * period), max(0, t - period // 2)):
            v = score[prev] - 100 * math.log((t - prev) / period) ** 2
            if v > best:
                best, arg = v, prev
        if arg >= 0:
            score[t], back[t] = on[t] + best, arg
    t = max(range(max(0, n - period), n), key=lambda i: score[i])
    grid = []
    while t >= 0:
        grid.append(t)
        t = back[t]
    return {'bpm': round(60 * fps / period, 1), 'beats': [round(i / fps, 3) for i in reversed(grid)]}
ts = []
for _ in range(2):
    a = time.perf_counter(); out = old(); ts.append(time.perf_counter() - a)
print(json.dumps({'t': min(ts), 'out': out}))`;
    const NEW = `import sys, io, time, runpy, json
data = open(sys.argv[2], 'rb').read(); ts = []
for _ in range(5):
    sys.stdin = io.TextIOWrapper(io.BytesIO(data)); so, sys.stdout = sys.stdout, io.StringIO()
    a = time.perf_counter(); runpy.run_path(sys.argv[1]); ts.append(time.perf_counter() - a)
    out, sys.stdout = sys.stdout.getvalue(), so
print(json.dumps({'t': min(ts), 'out': json.loads(out)}))`;
    const FALLBACK = `import sys, os, time, json
os.environ['CUTROOM_BEATS_STDLIB'] = '1'
sys.path.insert(0, sys.argv[1]); import server
f = server.CACHE / (sys.argv[2] + '.beats.json'); ts = []
for _ in range(3):
    f.unlink(missing_ok=True); a = time.perf_counter(); out = server.beats(sys.argv[2]); ts.append(time.perf_counter() - a)
f.unlink(missing_ok=True)
print(json.dumps({'t': min(ts), 'out': out}))`;
    const py = (exe, code, ...a) => JSON.parse(execFileSync(exe, ['-I', '-c', code, ...a], { env: { ...process.env, CUTROOM_HOME: LIB, PYTHONPATH: '' }, maxBuffer: 1 << 26 }).toString());
    const old = py(PYTHON, OLD, raw), np = WORLD ? py(AI_PY, NEW, `${ROOT}ai/beats.py`, raw) : null, sl = py(PYTHON, FALLBACK, ROOT, m.id);
    fs.rmSync(raw, { force: true });
    const same = o => JSON.stringify(o) === JSON.stringify(r);
    check('beats on a 2:50 song: the app grid == the old per-sample loops on the same song (117.2 BPM, 335 beats)', same(old.out) && r.bpm === 117.2 && r.beats.length === 335, `${r.bpm} BPM, ${r.beats.length} beats, gap sd ${(sd * 1000).toFixed(1)} ms; old ${old.out.bpm} BPM ${old.out.beats.length} beats`);
    if (!np) console.log(`SKIP beats with numpy (ai/beats.py): no AI tools Python at ${AI_PY}`);
    else check('beats: numpy (ai/beats.py) and the stdlib fallback give that same grid', same(np.out) && same(sl.out), `numpy ${np.out.bpm}/${np.out.beats.length}, stdlib ${sl.out.bpm}/${sl.out.beats.length}`);
    if (np) check('beats: the computation >= 5x faster than the old loops (same bytes, same run)', old.t / np.t >= 5, `old loops ${old.t.toFixed(3)} s, numpy ${np.t.toFixed(4)} s: ${(old.t / np.t).toFixed(1)}x; stdlib fallback end to end ${sl.t.toFixed(3)} s`);
    // end to end the ffmpeg decode is the floor (5x is not reachable): the old way's MP3 decode alone is ~0.17 s on a quiet
    // Mac, the cached PCM's resample ~0.09 s, and the app's beats() is that resample + ~40 ms. 1.6-4.1x measured under load
    const e2eOld = dec + old.t, e2e = Math.min(...ts);
    check('beats: end to end through the app >= 1.5x faster than the old way (not 5x: the ffmpeg decode is the floor)', e2eOld / e2e >= 1.5, `old ${dec.toFixed(3)} s decode + ${old.t.toFixed(3)} s loops = ${e2eOld.toFixed(3)} s; app ${ts.map(t => t.toFixed(3)).join(', ')} s (HTTP included): ${(e2eOld / e2e).toFixed(1)}x`);
  }
}

const errs = page.errs.filter(e => !/AbortError|The operation was aborted/.test(e));
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
await b.close();
for (const id of made) await post(`/api/projects/${id}/trash`, {}).catch(() => {});
const n = res.filter(Boolean).length;
console.log(`\n${n}/${res.length} passed`);
process.exit(n === res.length ? 0 : 1);
