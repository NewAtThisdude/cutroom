import { requireHome } from './runtime.mjs';
// Voice clone, AI dubbing, lip sync and talking photo, end to end in headless WebKit with the real models:
// Chatterbox (clone + Spanish dub, this Mac), WavLM (speaker similarity), whisper (captions), the local LLM (translation),
// LatentSync 1.6 (lip sync of real footage) and Wan 2.2 S2V (talking photo) on the RTX 4090 PC. Acceptance, measured on the files:
//   clone: speaker-embedding cosine to the reference above the closest stock voice; consent is required
//   dub: a 30 s English clip into Spanish, every sentence's speech inside its slot +-150 ms (energy of the dub WAV), tempo 0.8-1.25x
//   lip sync: two 40 s clips of a real face (podcast-episode) dubbed into Spanish: each keeps its length and place; the mouth
//     (Vision inner-lip opening) follows the new speech's envelope: r above the 90th percentile of 40 controls (the same speech
//     circularly shifted 1-38 s) and 0.1 above the original mouth's r; outside the face, PSNR > 40 dB against the original frames
//   talking photo: imported, decodes, plays; a photo clip keeps its length; past 30 s it is refused and nothing moves
//   the 4090 unreachable: a plain refusal within seconds (a second server pointed at a host that does not exist)
//   gating: lip sync / talking photo (buttons and MCP tools) show only while the GPU PC is set up and answering; when it is
//     not, their sections print SKIP and the hidden state, the hint and the MCP refusal are checked instead
// Needs: ai/setup.sh, Ollama, the PC on (ai/gpu_setup.sh). ~30 min.   CUTROOM_HOME=<lib> B=http://127.0.0.1:<port> node voice_dub.mjs [section]
import { PYTHON, spawnManaged, stopChild } from './runtime.mjs';
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const LIB = requireHome();
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2];
const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
// how well a mouth follows a speech: correlation of the inner-lip opening with the speech envelope (best over lags -0.25..+0.15 s),
// next to the same with the speech circularly shifted by 1 s .. dur-1 s (controls = what chance gives on THIS footage and speech)
const lipScore = (vid, wav, a0, dur, nctl = 40) => {
  const m = mouth(vid).filter(x => Number.isFinite(x.o) && x.t < dur), ts = m.map(x => x.t), o = m.map(x => x.o), a = pcm(wav, a0, dur);
  const E = env(a, Array.from({ length: Math.ceil(dur * 100) }, (_, i) => i / 100)), at = t => E[Math.round((((t % dur) + dur) % dur) * 100) % E.length];
  const best = off => Math.max(...[-0.25, -0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15].map(l => corr(o, ts.map(t => at(t + off + l)))));
  const ctl = Array.from({ length: nctl }, (_, k) => best(1 + k * (dur - 2) / (nctl - 1))).sort((x, y) => x - y), q = p => ctl[Math.min(nctl - 1, Math.floor(p * nctl))];
  return { r: +best(0).toFixed(3), med: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +ctl.at(-1).toFixed(3), frames: m.length, controls: nctl };
};
// PSNR of the frames OUTSIDE the face (Vision's face box grown to forehead..neck) between two videos, on frames sampled every `step` s
const outsidePSNR = (a, b, dur, step = 1) => {
  const faces = execFileSync(`${ROOT}tools/retouch`, [a, '0', `${dur}`], { maxBuffer: 1 << 28 }).toString().trim().split('\n').map(l => JSON.parse(l));
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', a]).toString().trim().split(',').map(Number);
  const grab = (f, t) => execFileSync('ffmpeg', ['-v', 'error', '-ss', `${t}`, '-i', f, '-frames:v', '1', '-sws_flags', 'accurate_rnd+full_chroma_int', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const out = [];
  for (let t = 0.5; t < dur - 0.2; t += step) {
    const fr = faces.reduce((p, x) => Math.abs(x.t - t) < Math.abs(p.t - t) ? x : p), f = fr.faces[0];
    if (!f) continue;
    const [bx, by, bw, bh] = f.box, x0 = (bx - 0.4 * bw) * w, x1 = (bx + 1.4 * bw) * w, y0 = (by - 0.4 * bh) * h, y1 = (by + 1.5 * bh) * h;
    const A = grab(a, fr.t + 0.001), Bb = grab(b, fr.t + 0.001);
    let se = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (x >= x0 && x < x1 && y >= y0 && y < y1) continue; const i = 3 * (y * w + x); for (let c = 0; c < 3; c++) { const d = A[i + c] - Bb[i + c]; se += d * d; } n += 3; }
    out.push(10 * Math.log10(255 * 255 / Math.max(se / n, 1e-9)));
  }
  return { min: +Math.min(...out).toFixed(1), median: +out.sort((x, y) => x - y)[out.length >> 1].toFixed(1), frames: out.length };
};
const SCRIPT = 'Welcome back to the workshop. Today we are swapping the turbochargers on this engine. First, we drain the coolant and take off the intake pipes. ' +
  'Then the downpipes come off, which is the hardest part of the whole job. The old turbos are worn out, and you can see the damaged blades on both of them. ' +
  'The new ones go in with fresh gaskets and new oil lines. After that, we fill the coolant, start the car, and check for leaks. ' +
  'We also replace two coolant hoses, because one of them was leaking a little. Every bolt gets torqued to the number in the manual. ' +
  'Finally, we take it for a long test drive and log the boost, to be sure that everything is right.';
const b = await browser.launch(), ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: 'reduce' }), page = await ctx.newPage();
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
const skip = (name, why) => console.log(`SKIP ${name}  [${why}]`);
let GPU = (await get('/api/ai/status')).gpu; // the server's cached check of the GPU PC (its first one runs at start, ~3 s when the PC is off)
for (let i = 0; i < 20 && GPU.configured && !GPU.checked; i++) { await new Promise(r => setTimeout(r, 500)); GPU = (await get('/api/ai/status')).gpu; }
const GPU_ON = !!GPU.reachable;
// Chatterbox (clone, dub) is MLX: a PC refuses it by design (server.py NOT_YET), and the AI tab says why
const CLONE_OFF = ((await get('/api/ai/caps')).jobs.find(j => j.kind === 'clone')?.refused || '').match(/.*needs Apple Silicon.*/)?.[0];
// the hint where the GPU tools are hidden: the GPU PC is opted in to (CUTROOM_GPU_HOST) but not answering, or there is none
const GPU_HINT = GPU.configured ? /^Needs the GPU PC \(.+\): it is off or not answering/ : /NVIDIA GPU .* or a GPU PC you opt in to \(CUTROOM_GPU_HOST/;
try {
// ---------- fixtures: a 30 s English talk (a Kokoro voice that is not one of the stock baselines) on a video ----------
ORIG = (await get('/api/media')).find(m => m.name === 'voice-dub-30s-v3.mp4');
if (!ORIG) { // one Kokoro take per sentence, its silences trimmed, 0.6 s apart: one take of the whole script came out with whisper hearing commas for most full stops
  // (Kokoro is not bit-exact run to run), so the dub had 3 sentence slots instead of 10; separate takes end each sentence clearly, so
  // whisper hears the full stops (its word times often run on over the 0.6 s pauses, so they alone do not split the slots)
  const parts = [];
  for (const text of SCRIPT.split(/(?<=\.)\s+/)) parts.push((await job('/api/ai/voice', { text, voice: 'am_eric', speed: 1 })).media);
  const f = `${tmp}/voice-dub-30s-v3.mp4`, ins = [];
  for (const id of parts) ins.push('-i', await file(id));
  const fc = parts.map((_, i) => `[${i + 1}:a]aresample=24000,silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.6[a${i}]`).join(';') + ';' + parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1[a]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', ...ins, '-filter_complex', fc, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
  ORIG = await (await fetch(`${B}/api/import?name=voice-dub-30s-v3.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
  for (const id of parts) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' });
}
await ready([ORIG.id]);
await ev(() => loadMedia());
check('the English test clip is 26-40 s (10 sentences)', ORIG.duration > 26 && ORIG.duration < 40, ORIG.duration);
let voice = null, dub = null, talk = null;

// ---------- clone ----------
if (run('clone') || run('dub') || run('lip')) {
  await fresh('Voice clone');
  await ev(id => { addMedia(id, 'main'); S.t = 2; G.tab = 'ai'; renderAll(); }, ORIG.id);
  await page.click('.rail [data-tab="ai"]');
  await page.locator('#btnClone').scrollIntoViewIfNeeded();
  check('the AI tab shows the clone and dub controls (consent off by default)', await page.locator('#btnClone').isVisible() && await page.locator('#btnDub').isVisible() && !(await page.locator('#vcConsent').isChecked())
    && await ev(() => $('#dubLang').options.length) >= 20, await ev(() => $('#dubLang').options.length));
  if (CLONE_OFF) {
    const st = await ev(() => ({ off: $('#btnClone').disabled && $('#btnDub').disabled, text: $('#dubStatus').textContent }));
    check('Clone / dub on this computer: the buttons are off and the AI tab says why', st.off && st.text === CLONE_OFF, JSON.stringify(st));
    const viaMcp = await ev(() => REMOTE.clone_voice({}).then(() => 'cloned', e => e.message));
    check('...the MCP command still asks for consent first (it throws)', /consent/.test(viaMcp), viaMcp);
    const asked = await ev(() => REMOTE.clone_voice({ consent: true }).then(() => 'cloned', e => e.message));
    check('...and with consent it refuses in words', asked.includes('needs Apple Silicon'), asked);
    skip('voice clone and dubbing', CLONE_OFF);
  } else {
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
// ---------- the GPU PC's tools are gated: shown only while it is set up and answering ----------
if (run('gpu') || run('lip') || run('talk') || !only) {
  const t0 = Date.now(), st = await get('/api/ai/status'), ms = Date.now() - t0;
  check('the AI status answers at once whatever the GPU PC does (cached check)', ms < 1000 && 'reachable' in st.gpu, `${ms} ms, ${JSON.stringify(st.gpu)}`);
  await ev(() => loadAI());
  await page.click('.rail [data-tab="ai"]');
  const ui = await ev(() => ({ tools: !$('#gpuTools').hidden, hint: $('#gpuHint').hidden ? '' : $('#gpuHint').textContent, lip: $('#btnLipSync').getBoundingClientRect().width > 0 }));
  check(`the AI tab: lip sync / talking photo ${GPU_ON ? 'shown (the PC answers)' : 'hidden, with a hint (the PC does not answer)'}`,
    GPU_ON ? ui.tools && ui.lip && !ui.hint : !ui.tools && !ui.lip && GPU_HINT.test(ui.hint), JSON.stringify(ui));
  if (!GPU_ON) {
    const r = await ev(() => Promise.all([REMOTE.lip_sync({}), REMOTE.talking_photo({})].map(p => p.then(() => 'ran', e => e.message))));
    check('...and the MCP commands refuse in words, at once', r.every(x => GPU_HINT.test(x)), r.join(' | '));
  }
  const mcp = spawnManaged(PYTHON, ['-X', 'utf8', '-I', `${ROOT}mcp/cutroom_mcp.py`], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH')), CUTROOM_PORT: new URL(B).port }, stdio: ['pipe', 'pipe', 'ignore'] });
  const listed = await new Promise((res, rej) => { let buf = ''; mcp.stdout.on('data', d => { buf += d; const l = buf.split('\n').find(x => x.includes('"id": 2') || x.includes('"id":2')); if (l) res(JSON.parse(l).result.tools.map(t => t.name)); }); setTimeout(() => rej(new Error('no MCP answer')), 15000);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'); }).finally(() => mcp.kill());
  const has = ['lip_sync', 'talking_photo'].filter(n => listed.includes(n));
  check(`the MCP tool list ${GPU_ON ? 'has' : 'leaves out'} lip_sync / talking_photo (clone_voice and dub_video always there)`,
    (GPU_ON ? has.length === 2 : !has.length) && listed.includes('clone_voice') && listed.includes('dub_video'), `${listed.length} tools; GPU tools listed: ${has.join(', ') || 'none'}`);
}
if (!GPU_ON && (run('talk') || run('lip'))) skip('talking photo and lip sync on the GPU PC', `${GPU.host} is ${GPU.configured ? 'not answering' : 'not set up'}`);
if (GPU_ON && dub && (run('talk') || run('lip'))) {
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
    const log = await ev(() => window.SAID['#lsStatus']);
    check('...it showed progress on the GPU PC', log.some(x => /on the GPU PC… \d+ ?(%|s)/.test(x)), log.filter(x => /GPU/.test(x)).slice(-1).join(''));
  }
  // past 30 s: refused in words, before any GPU work, and nothing on the timeline moves
  const long = await ev(async ([img, d]) => {
    setProject(newProject('16:9')); P.name = 'Talking photo 40 s (scratch)';
    addMedia(img, 'main'); P.main[0].out = 40; addMedia(img, 'main'); P.main[1].out = 5; addMedia(d, 'audio', 0); packMain(); renderAll();
    const was = JSON.stringify(P.main.map(c => [c.media, c.start, c.in, c.out]));
    const r = await REMOTE.talking_photo({ clip: P.main[0].id }).then(() => 'made', e => e.message);
    return { r, same: JSON.stringify(P.main.map(c => [c.media, c.start, c.in, c.out])) === was };
  }, [PORTRAIT.id, dub.media]);
  check('Talking photo on a 40 s photo clip: refused in words (30 s at most), the timeline untouched', /30 s at most/.test(long.r) && long.same, JSON.stringify(long));
}

// ---------- lip sync (4090, LatentSync) on real footage: two 40 s clips of a face (podcast-episode) dubbed into Spanish ----------
// both clips are past the 30 s that one GPU piece holds: each must keep its length, and nothing else on the timeline may move.
// Acceptance, on the files: the new mouth follows the Spanish speech (r above the 90th percentile of 40 time-shifted controls,
// and above the original mouth's r), and the frames outside the face are the original's (PSNR > 40 dB)
if (GPU_ON && voice && run('lip')) {
  const POD = (await get('/api/media')).find(m => m.name === 'podcast-episode.mp4');
  check('the podcast-episode fixture (a face talking, 94 s) is in the library', POD && POD.duration > 85, POD?.duration);
  if (POD) {
    await fresh('Lip sync');
    await ev(id => { addMedia(id, 'main', 0, [0, 40]); addMedia(id, 'main', 40, [40, 80]); packMain(); S.t = 0; renderAll(); }, POD.id);
    const d = await ev(() => dubVideo({ lang: 'es', original: 'mute' }).then(x => x, e => ({ err: e.message })));
    check('...dubbed into Spanish (80 s of it)', !d.err && d.sentences?.length >= 8, d.err || `${d.sentences.length} sentences`);
    if (!d.err) {
      const shape = () => ev(() => ({ main: P.main.map(c => ({ id: c.id, media: c.media, start: +c.start.toFixed(4), len: +len(c).toFixed(4) })), total: +total().toFixed(4) }));
      const before = await shape(), runs = [];
      for (const k of [0, 1]) {
        const t0 = Date.now();
        const r = await ev(id => REMOTE.lip_sync({ clip: id }).then(x => x, e => ({ err: e.message })), before.main[k].id);
        runs.push({ ...r, secs: (Date.now() - t0) / 1000 });
        check(`Lip sync clip ${k + 1} (40 s): done, in pieces, a face in most frames`, !r.err && r.pieces >= 2 && r.faces > 0.9 * r.frames,
          r.err || `${r.pieces} pieces, faces in ${r.faces}/${r.frames} frames, ${runs.at(-1).secs.toFixed(0)} s`);
      }
      const after = await shape();
      check('...both clips kept their 40 s and their places, the edit its length (only the media changed)', after.main.length === 2 && after.total === before.total
        && after.main.every((c, i) => c.id === before.main[i].id && c.start === before.main[i].start && c.len === before.main[i].len && c.media !== POD.id),
        JSON.stringify({ before, after }));
      const dubf = await file(d.media), orig = await file(POD.id);
      for (const [k, r] of runs.entries()) {
        if (r.err) continue;
        const f = await file(r.media), a0 = 40 * k;
        const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate', '-of', 'json', f]).toString()).streams[0];
        check(`...clip ${k + 1}: a whole 1280x720 30 fps video of 1200 frames`, pr.width === 1280 && pr.height === 720 && pr.r_frame_rate === '30/1' && +pr.nb_read_frames === 1200, JSON.stringify(pr));
        const now = lipScore(f, dubf, a0, 40);
        const cut = `${tmp}/src${k}.mp4`; // the original span, near-lossless: its mouth against the same Spanish speech (the pauses line up), and its frames
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', `${a0}`, '-i', orig, '-t', '40', '-an', '-c:v', 'libx264', '-crf', '4', cut]);
        const base = lipScore(cut, dubf, a0, 40);
        console.log(`   clip ${k + 1}: mouth vs the Spanish speech r = ${now.r} over ${now.frames} frames; ${now.controls} shifted controls: median ${now.med}, p90 ${now.p90}, max ${now.max}; the original mouth r = ${base.r}`);
        check(`...clip ${k + 1}: the mouth follows the new speech (r above the controls' 90th percentile and the original's)`, now.frames >= 1100 && now.r > now.p90 && now.r > base.r + 0.1,
          `r ${now.r}, p90 ${now.p90}, original ${base.r}, n ${now.frames}`);
        const q = outsidePSNR(cut, f, 40, 2);
        check(`...clip ${k + 1}: outside the face the frames are the original's (PSNR > 40 dB)`, q.frames >= 15 && q.min > 40, JSON.stringify(q));
      }
    }
  }
}

// ---------- the 4090 unreachable: a second server pointed at a host that does not exist, its own tunnel port ----------
if (run('offline')) {
  let img = PORTRAIT?.id || (await get('/api/media')).find(m => m.kind === 'image')?.id;
  if (!img) { // a fresh library has no picture (the portrait is only made with the PC on): any still will do, the job must refuse before using it
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=512x512', '-frames:v', '1', `${tmp}/still.png`]);
    img = (await (await fetch(`${B}/api/import?name=voice-dub-still.png`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(`${tmp}/still.png`) })).json()).id;
  }
  const port = process.env.P2 ? Number(process.env.P2) : Number(new URL(B).port) + 1;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4610 || (process.platform === 'darwin' && (port < 4810 || port > 4819))) throw new Error('set P2 to a free scratch port (4810-4819 on macOS, never 4610)');
  const srv = spawnManaged(PYTHON, ['-X', 'utf8', '-I', `${ROOT}server.py`], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH')), CUTROOM_HOME: LIB, CUTROOM_PORT: `${port}`, CUTROOM_GPU_HOST: 'cutroom-no-such-pc.invalid', CUTROOM_COMFY_PORT: '18199' }, stdio: 'ignore' });
  const B2 = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 40; i++) { try { if ('cloneReady' in await (await fetch(`${B2}/api/ai/status`)).json()) break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    const aud =dub?.media || (await get('/api/media')).find(m => m.kind === 'audio')?.id;
    const t0 = Date.now(), j = await job('/api/ai/talk', { image: img, audio: aud, a0: 0, a1: 3 }, B2), secs = (Date.now() - t0) / 1000;
    check('PC off: the talking photo / lip sync job refuses in a plain sentence, fast', j.state === 'error' && /not reachable/.test(j.error) && secs < 30, `${secs.toFixed(1)} s: ${j.error}`);
    let g2 = {};
    for (let i = 0; i < 20 && !g2.checked; i++) { await new Promise(r => setTimeout(r, 500)); g2 = (await (await fetch(`${B2}/api/ai/status`)).json()).gpu; }
    check('...and its AI status says configured, not reachable (so the tools stay hidden)', g2.configured && g2.checked && !g2.reachable, JSON.stringify(g2));
  } finally { await stopChild(srv); }
}
} catch (e) { check('the suite ran to the end', false, String(e.message).split('\n')[0]); }

// ---------- the other reduced-motion mode: the new controls render and fit ----------
const ctx2 = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: 'no-preference' }), p2 = await ctx2.newPage();
await p2.route(u => u.pathname === '/api/remote/next', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
await p2.goto(`${B}/`, { waitUntil: 'load' });
await p2.waitForFunction(() => typeof G !== 'undefined' && G.ai, null, { timeout: 30000 });
await p2.click('.rail [data-tab="ai"]');
await p2.locator('#btnDub').scrollIntoViewIfNeeded();
const fit = await p2.evaluate(() => { const pane = $('#tab-ai'), r = pane.getBoundingClientRect(); return ['#btnClone', '#btnVcDel', '#vcVoice', '#dubLang', '#btnDub', ...($('#gpuTools').hidden ? ['#gpuHint'] : ['#btnLipSync', '#btnTalk'])].every(s => { const q = $(s).getBoundingClientRect(); return q.width > 20 && q.left >= r.left - 1 && q.right <= r.right + 1; }) && pane.scrollWidth <= pane.clientWidth + 1; });
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
