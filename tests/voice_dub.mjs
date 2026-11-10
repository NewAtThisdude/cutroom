// Voice clone, AI dubbing, lip sync and talking photo, end to end in headless WebKit with the real models:
// Chatterbox (clone + Spanish dub, this Mac), WavLM (speaker similarity), whisper (captions), the local LLM (translation),
// Wan 2.2 S2V on the RTX 4090 PC (talking photo, lip sync). Acceptance, measured on the files, not on what the server says:
//   clone: speaker-embedding cosine to the reference above the closest stock voice; consent is required
//   dub: a 30 s English clip into Spanish, every sentence's speech inside its slot +-150 ms (energy of the dub WAV)
//   talking photo / lip sync: imported, decodes, plays (export-engine frame of a face, the playhead moves); how well the
//     mouth follows the speech is measured and printed (Vision inner-lip height vs the audio envelope), not gated: too noisy on 8 s
//   the 4090 unreachable: a plain refusal within seconds (a second server pointed at a host that does not exist)
// Needs: ai/setup.sh, Ollama, the PC on (ai/gpu_setup.sh). ~12 min.   CUTROOM_HOME=<lib> B=http://127.0.0.1:<port> node voice_dub.mjs [section]
import { webkit } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
const LIB = process.env.CUTROOM_HOME || `${os.homedir()}/Movies/Cutroom`;
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2];
const ROOT = new URL('..', import.meta.url).pathname;
const res = [], t00 = Date.now();
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const post = async (p, body, base = B) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const job = async (p, body, base = B) => { const { job: id } = await post(p, body, base); for (;;) { await new Promise(r => setTimeout(r, 1000)); const j = await (await fetch(`${base}/api/jobs/${id}`)).json(); if (j.state !== 'running') return j; } };
const before = { p: new Set((await get('/api/projects')).map(x => x.id)), m: new Set((await get('/api/media')).map(x => x.id)), v: new Set((await get('/api/ai/status')).clones.map(v => v.id)) };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-voice-`);
const file = async id => `${LIB}/media/${(await get('/api/media')).find(m => m.id === id).file}`;
const pcm = (f, ss = 0, t = 600) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-ss', `${ss}`, '-t', `${t}`, '-i', f, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 }); return new Int16Array(b.buffer, b.byteOffset, b.length >> 1); };
const corr = (a, b) => { const n = Math.min(a.length, b.length), ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n, mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n; let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sab / Math.sqrt(sa * sb || 1); };
const mouth = f => { // inner-lip opening / face height per frame (Vision, tools/retouch), and the frame times
  const out = execFileSync(`${ROOT}tools/retouch`, [f, '0', '60'], { maxBuffer: 1 << 28 }).toString().trim().split('\n').map(l => JSON.parse(l));
  return out.map(r => { const fc = r.faces[0], p = fc?.pts?.ilips; if (!p) return { t: r.t, o: NaN }; const ys = p.filter((_, i) => i % 2); return { t: r.t, o: (Math.max(...ys) - Math.min(...ys)) / fc.box[3] }; });
};
const env = (a, ts, w = 1 / 16) => ts.map(t => { const i0 = Math.max(0, Math.round((t - w / 2) * 16000)), i1 = Math.min(a.length, Math.round((t + w / 2) * 16000)); let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); });
const lipScore = (vid, wav, a0, dur) => { // correlation of the mouth with the speech, best over lags -0.25..+0.15 s, next to the same with the speech
  // shifted 0.6-12 s (20 controls: what chance gives). Reported only: on 8 s (128 frames) this measure is too noisy to gate on.
  const m = mouth(vid).filter(x => Number.isFinite(x.o) && x.t < dur), ts = m.map(x => x.t), o = m.map(x => x.o), a = pcm(wav, a0, dur + 13);
  const best = off => Math.max(...[-0.25, -0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15].map(l => corr(o, env(a, ts.map(t => t + off + l)))));
  const ctl = Array.from({ length: 20 }, (_, k) => best((k + 1) * 0.6)).sort((x, y) => x - y);
  return { r: +best(0).toFixed(3), med: +ctl[10].toFixed(3), p90: +ctl[18].toFixed(3), frames: m.length };
};
const SCRIPT = 'Welcome back to the workshop. Today we are swapping the turbochargers on this engine. First, we drain the coolant and take off the intake pipes. ' +
  'Then the downpipes come off, which is the hardest part of the whole job. The old turbos are worn out, and you can see the damaged blades on both of them. ' +
  'The new ones go in with fresh gaskets and new oil lines. After that, we fill the coolant, start the car, and check for leaks. ' +
  'We also replace two coolant hoses, because one of them was leaking a little. Every bolt gets torqued to the number in the manual. ' +
  'Finally, we take it for a long test drive and log the boost, to be sure that everything is right.';
const b = await webkit.launch(), ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: 'reduce' }), page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof G !== 'undefined' && G.ai, null, { timeout: 30000 });
const ev = (f, a) => page.evaluate(f, a);
const fresh = name => ev(name => { setProject(newProject('16:9')); P.name = `${name} (scratch)`; S.t = 0; renderAll(); return P.id; }, name);
const said = sel => ev(sel => { window.SAID ??= {}; const log = window.SAID[sel] = []; new MutationObserver(() => log.push($(sel).textContent)).observe($(sel), { childList: true, characterData: true, subtree: true }); }, sel);
const run = name => !only || name.includes(only);
const ready = ids => page.waitForFunction(ids => { loadMedia(); return ids.every(id => M.get(id)?.ready); }, ids, { timeout: 120000, polling: 2000 });

let ORIG = null, PORTRAIT = null;
try {
// ---------- fixtures: a 30 s English talk (a Kokoro voice that is not one of the stock baselines) on a video ----------
ORIG = (await get('/api/media')).find(m => m.name === 'voice-dub-30s-v2.mp4');
if (!ORIG) {
  const v = await job('/api/ai/voice', { text: SCRIPT, voice: 'am_eric', speed: 1 });
  const f = `${tmp}/voice-dub-30s-v2.mp4`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-i', await file(v.media), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
  ORIG = await (await fetch(`${B}/api/import?name=voice-dub-30s-v2.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
  await fetch(`${B}/api/media/${v.media}/trash`, { method: 'POST', headers: H, body: '{}' });
}
await ready([ORIG.id]);
await ev(() => loadMedia());
check('the English test clip is about 30 s', ORIG.duration > 26 && ORIG.duration < 36, ORIG.duration);
let voice = null, dub = null, talk = null;

// ---------- clone ----------
if (run('clone') || run('dub') || run('lip')) {
  await fresh('Voice clone');
  await ev(id => { addMedia(id, 'main'); S.t = 2; G.tab = 'ai'; renderAll(); }, ORIG.id);
  await page.click('.rail [data-tab="ai"]');
  await page.locator('#btnClone').scrollIntoViewIfNeeded();
  check('the AI tab shows the clone and dub controls (consent off by default)', await page.locator('#btnClone').isVisible() && await page.locator('#btnDub').isVisible() && !(await page.locator('#vcConsent').isChecked())
    && await ev(() => $('#dubLang').options.length) >= 20, await ev(() => $('#dubLang').options.length));
  await page.click('#btnClone');
  await page.waitForFunction(() => /consent/.test($('#dubStatus').textContent), null, { timeout: 5000 }).catch(() => {});
  check('Clone without the consent box: refused, in words', /consent/.test(await ev(() => $('#dubStatus').textContent)), await ev(() => $('#dubStatus').textContent));
  const viaMcp = await ev(() => REMOTE.clone_voice({}).then(() => 'cloned', e => e.message));
  check('...and through the MCP command (it throws)', /consent/.test(viaMcp), viaMcp);
  await said('#dubStatus');
  await page.check('#vcConsent');
  const t0 = Date.now();
  await page.click('#btnClone');
  await page.waitForFunction(() => /^Cloned|failed|not|error/i.test($('#dubStatus').textContent) && !$('#btnClone').disabled, null, { timeout: 600000 });
  voice = (await get('/api/ai/status')).clones.find(v => !before.v.has(v.id));
  const log = await ev(() => window.SAID['#dubStatus']);
  check('Clone voice from clip: a voice, its similarity above the closest stock voice', voice && voice.similarity > voice.baseline,
    voice && `similarity ${voice.similarity}, stock ${JSON.stringify(voice.stock)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check('...it showed progress, then the result', log.some(x => /Cloning the voice… \d+ (s|%)/.test(x)) && /similarity/.test(log.at(-1)), log.slice(-2).join(' | '));
  check('...and it is picked in the Voice list', voice && await ev(id => $('#vcVoice').value === id, voice.id));
}

// ---------- dub ----------
if (voice && (run('dub') || run('lip'))) {
  await said('#dubStatus');
  const t0 = Date.now();
  const r = await ev(() => dubVideo({ lang: 'es', original: 'duck' }).then(x => x, e => ({ err: e.message })));
  check('Dub the video into Spanish: done', !r.err && r.sentences?.length >= 5, r.err || `${r.sentences?.length} sentences, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!r.err) {
    dub = r;
    const a = pcm(await file(r.media)), win = 320, loud = [];
    for (let i = 0; i + win <= a.length; i += win) { let m = 0; for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(a[j])); if (m > 0.02 * 32767) loud.push(i / 16000); }
    // where the server says each sentence went ([a, b]) has to be where the WAV has sound, and nowhere else; [a, b] inside the slot +-150 ms
    const S_ = r.sentences, has = (t0, t1) => loud.some(t => t >= t0 && t < t1);
    const per = S_.map(s => ({ start: +(s.a - s.s).toFixed(3), end: +(s.b - s.e).toFixed(3), heard: has(s.a, s.a + 0.3) && has(s.b - 0.35, s.b) }));
    const outside = loud.filter(t => !S_.some(s => t >= s.a - 0.02 && t + 0.02 <= s.b + 0.02));
    console.log('   sentences (slot; speech start / end vs slot, s; tempo):', S_.map((s, i) => `${s.s.toFixed(2)}-${s.e.toFixed(2)} ${per[i].start}/${per[i].end} x${s.tempo}${s.shorter ? ' shorter' : ''}`).join('; '));
    check('every sentence of the dub speaks inside its slot +-150 ms (sound in the WAV only there)', !outside.length && per.every(p => p.heard && Math.abs(p.start) <= 0.15 && p.end <= 0.15),
      `${outside.length} loud 20 ms frames outside; worst start ${Math.max(...per.map(p => Math.abs(p.start))).toFixed(3)} s, worst end ${Math.max(...per.map(p => p.end)).toFixed(3)} s, all heard ${per.every(p => p.heard)}`);
    check('...every time-fit within 0.8-1.25x', S_.every(s => s.tempo >= 0.8 - 1e-6 && s.tempo <= 1.25 + 1e-6), S_.map(s => s.tempo).join(' '));
    const tl = await ev(() => ({ dub: P.audio.filter(a => a.dub === 'es').map(a => ({ start: a.start, media: a.media })), vol: P.main[0].volume, cap: P.captions.slice(0, 3).map(c => c.text).join(' ') }));
    check('...on the audio track at 0, the original voice ducked to 20 %, the captions now Spanish', tl.dub.length === 1 && tl.dub[0].start === 0 && tl.vol === 0.2 && /\b(el|la|los|las|de|que|y|en)\b/i.test(tl.cap), JSON.stringify(tl));
    const heard = await post('/api/transcript', { media: r.media, lang: 'es' });
    const words = heard.sentences.map(s => s.text).join(' ');
    check('...and whisper hears Spanish in the dub', (words.match(/\b(el|la|los|las|de|que|y|en|con|un|una|del)\b/gi) || []).length >= 8, words.slice(0, 200));
    const log = await ev(() => window.SAID['#dubStatus']);
    check('...it showed progress while dubbing', log.some(x => /Dubbing… \d+%/.test(x)), log.filter(x => /Dubbing/.test(x)).slice(-2).join(' | '));
  }
}

// ---------- talking photo (4090) ----------
PORTRAIT = (await get('/api/media')).find(m => m.name.startsWith('AI image - studio portrait, voice-dub test'));
if (dub && (run('talk') || run('lip'))) {
  if (!PORTRAIT) {
    const j = await job('/api/ai/image', { prompt: 'studio portrait, voice-dub test: a friendly man in his thirties looking straight at the camera, head and shoulders, mouth closed, soft light, plain grey background', w: 832, h: 1216, seed: 7 });
    PORTRAIT = { id: j.media };
  }
  await ready([PORTRAIT.id]);
  await fresh('Talking photo');
  const photo = await ev(([img, d]) => { addMedia(img, 'main'); P.main[0].out = 8; const p = P.main[0].id; addMedia(d, 'audio', 0); P.audio[0].out = 8; S.sel = { lane: 'main', id: p }; renderAll(); return p; }, [PORTRAIT.id, dub.media]);
  await said('#lsStatus');
  const t0 = Date.now();
  await page.click('#btnTalk');
  await page.waitForFunction(() => /^Done|not|refused|error|failed/i.test($('#lsStatus').textContent) && !$('#btnTalk').disabled, null, { timeout: 1800000 });
  const st = await ev(id => { const c = P.main.find(x => x.id === id); return { kind: M.get(c.media)?.kind, media: c.media, vol: c.volume, dur: +len(c).toFixed(2), status: $('#lsStatus').textContent }; }, photo);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  check('Talking photo: the photo clip became a talking video (muted: the audio track speaks)', st.kind === 'video' && st.vol === 0 && Math.abs(st.dur - 8) < 0.2, `${JSON.stringify(st)}, ${secs} s`);
  if (st.kind === 'video') {
    talk = st.media;
    const f = await file(talk), probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', f]).toString();
    const p = JSON.parse(probe);
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']);
    check('...a whole H.264 + AAC file that decodes', p.streams.some(s => s.codec_type === 'audio') && p.streams.some(s => s.codec_type === 'video') && Math.abs(+p.format.duration - 8) < 0.2, probe.replace(/\s+/g, ' '));
    const im = await ev(async () => { const r = await REMOTE.snapshot({ t: 4, max: 320 }); const i = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, i.width, i.height).data; let s = 0, s2 = 0; for (let k = 0; k < d.length; k += 4) { s += d[k]; s2 += d[k] * d[k]; } const n = d.length / 4; return Math.sqrt(s2 / n - (s / n) ** 2); });
    check('...it plays in the edit (export-engine frame at 4 s is a picture, not blank)', im > 20, `luma spread ${im.toFixed(1)}`);
    const played = await ev(async () => { S.t = 1; play(); await sleep(1500); const t = S.t; pause(); return t; }).catch(e => 'ERR ' + e.message);
    check('...and the preview plays it (the playhead moves)', typeof played === 'number' && played > 1.5, played);
    const ls = lipScore(f, await file(dub.media), 0, 8);
    console.log(`   measured, not gated: mouth opening vs its speech r = ${ls.r}; vs the same speech shifted 1-12 s: median ${ls.med}, 90th percentile ${ls.p90}`);
    const log = await ev(() => window.SAID['#lsStatus']);
    check('...it showed progress on the GPU PC', log.some(x => /on the GPU PC… \d+ ?(%|s)/.test(x)), log.filter(x => /GPU/.test(x)).slice(-1).join(''));
  }
}

// ---------- lip sync (4090): the talking video (it says the dub's first 8 s) re-synced to the dub's next 8 s ----------
if (talk && run('lip')) {
  await fresh('Lip sync');
  const cid = await ev(([v, d]) => { addMedia(v, 'main'); const c = P.main[0].id; addMedia(d, 'audio', 0); Object.assign(P.audio[0], { in: 8, out: 16, dub: 'es' }); S.sel = { lane: 'main', id: c }; renderAll(); return c; }, [talk, dub.media]);
  const t0 = Date.now();
  const r = await ev(id => REMOTE.lip_sync({ clip: id }).then(x => x, e => ({ err: e.message })), cid);
  check('Lip sync clip: the clip switched to a re-synced video', !r.err && r.media && r.media !== talk && r.clip?.volume === 0, r.err || `${JSON.stringify(r.clip).slice(0, 200)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!r.err) {
    const f = await file(r.media), now = lipScore(f, await file(dub.media), 8, 8), old = lipScore(f, await file(dub.media), 0, 8);
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']);
    const im = await ev(async () => { const r = await REMOTE.snapshot({ t: 4, max: 320 }); const i = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, i.width, i.height).data; let s = 0, s2 = 0; for (let k = 0; k < d.length; k += 4) { s += d[k]; s2 += d[k] * d[k]; } const n = d.length / 4; return Math.sqrt(s2 / n - (s / n) ** 2); });
    check('...the re-synced video decodes and plays in the edit (export-engine frame at 4 s is a picture)', im > 20, `luma spread ${im.toFixed(1)}`);
    console.log(`   measured, not gated: mouth vs the new speech (dub 8-16 s) r = ${now.r} (controls median ${now.med}, p90 ${now.p90}); vs the old speech (0-8 s) r = ${old.r}`);
  }
}

// ---------- the 4090 unreachable: a second server pointed at a host that does not exist, its own tunnel port ----------
if (run('offline')) {
  const port = await new Promise(r => { const q = net.createServer().listen(0, '127.0.0.1', () => { const p = q.address().port; q.close(() => r(p)); }); }); // a free port (another agent's server may hold any fixed one)
  const srv = spawn('python3', ['-I', `${ROOT}server.py`], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH')), CUTROOM_HOME: LIB, CUTROOM_PORT: `${port}`, CUTROOM_GPU_HOST: 'cutroom-no-such-pc.invalid', CUTROOM_COMFY_PORT: '18199' }, stdio: 'ignore' });
  const B2 = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 40; i++) { try { if ('cloneReady' in await (await fetch(`${B2}/api/ai/status`)).json()) break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    const img = PORTRAIT?.id || (await get('/api/media')).find(m => m.kind === 'image')?.id, aud = dub?.media || (await get('/api/media')).find(m => m.kind === 'audio')?.id;
    const t0 = Date.now(), j = await job('/api/ai/talk', { image: img, audio: aud, a0: 0, a1: 3 }, B2), secs = (Date.now() - t0) / 1000;
    check('PC off: the talking photo / lip sync job refuses in a plain sentence, fast', j.state === 'error' && /not reachable/.test(j.error) && secs < 30, `${secs.toFixed(1)} s: ${j.error}`);
  } finally { srv.kill(); }
}
} catch (e) { check('the suite ran to the end', false, String(e.message).split('\n')[0]); }

// ---------- the other reduced-motion mode: the new controls render and fit ----------
const ctx2 = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: 'no-preference' }), p2 = await ctx2.newPage();
await p2.route(u => u.pathname === '/api/remote/next', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
await p2.goto(`${B}/`, { waitUntil: 'load' });
await p2.waitForFunction(() => typeof G !== 'undefined' && G.ai, null, { timeout: 30000 });
await p2.click('.rail [data-tab="ai"]');
await p2.locator('#btnDub').scrollIntoViewIfNeeded();
const fit = await p2.evaluate(() => { const pane = $('#tab-ai'), r = pane.getBoundingClientRect(); return ['#btnClone', '#btnVcDel', '#vcVoice', '#dubLang', '#btnDub', '#btnLipSync', '#btnTalk'].every(s => { const q = $(s).getBoundingClientRect(); return q.width > 20 && q.left >= r.left - 1 && q.right <= r.right + 1; }) && pane.scrollWidth <= pane.clientWidth + 1; });
check('reduced motion off too: the clone / dub / lip sync controls show and fit the pane', fit);
await ctx2.close();

// ---------- tidy ----------
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
await ev(() => clearTimeout(saveTimer)).catch(() => {});
await b.close();
fs.rmSync(tmp, { recursive: true });
const after = { p: await get('/api/projects'), m: await get('/api/media'), v: (await get('/api/ai/status')).clones };
const keep = new Set([ORIG?.id, PORTRAIT?.id]); // the fixtures stay for the next run (in the library under test)
const made = { p: after.p.filter(x => !before.p.has(x.id)), m: after.m.filter(x => !before.m.has(x.id) && !keep.has(x.id)), v: after.v.filter(x => !before.v.has(x.id)) };
for (const p of made.p) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const v of made.v) await fetch(`${B}/api/ai/clones/${v.id}/trash`, { method: 'POST', headers: H, body: '{}' });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed in ${((Date.now() - t00) / 60000).toFixed(1)} min; trashed ${made.p.length} projects, ${made.m.length} media, ${made.v.length} voices`);
process.exit(res.includes(false) ? 1 : 0);
