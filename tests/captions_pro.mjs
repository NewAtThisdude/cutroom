// Captions pro (2026-11-10): the dynamic caption presets, bilingual second line, keyword highlight, emoji, lyrics from a song
// and speaker labels, end to end in headless WebKit against a scratch server, with measured numbers.
//   tiles     every preset is a tile drawn by drawText; still until hovered, then it plays (both reduced-motion modes);
//             an export with every preset keeps the layer workers (S.layerMode 'workers')
//   keywords  podcast-episode: whisper captions -> the local model picks 1-2 key words each (+ an emoji per sentence);
//             preview == export on a marked caption
//   bilingual the same captions translated (local model) into a second line; preview == export, and the line is in the export
//   lyrics    a song made here (MusicGen music + Kokoro vocals at known times): lyric captions via Demucs vocals + whisper,
//             word recall and line timing, against plain captions of the same mix
//   speakers  2-voice fixtures (two Kokoro voices, lines in a known order): caption-level speaker accuracy
// Fixtures are cached in tests/out/captions_pro/.   B=http://127.0.0.1:4771 CUTROOM_HOME=<scratch lib> node captions_pro.mjs [section]
import { browser } from './browser.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
const B = process.env.B, LIB = process.env.CUTROOM_HOME, only = process.argv[2], OUT = new URL('./out/captions_pro/', import.meta.url).pathname;
if (!B || !LIB || B.endsWith(':4610')) throw new Error('run on a scratch server: B=http://127.0.0.1:<port> CUTROOM_HOME=<its library>');
fs.mkdirSync(OUT, { recursive: true });
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, res = [], made = { media: [], projects: [] };
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const run = name => !only || only === name;
const post = async (p, body) => { const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
const job = async (p, body) => { const { job: id } = await post(p, body); for (;;) { await new Promise(z => setTimeout(z, 400)); const j = await (await fetch(`${B}/api/jobs/${id}`)).json(); if (j.state === 'done') return j; if (j.state !== 'running') throw new Error(j.error); } };
const mediaFile = async id => `${LIB}/media/${(await (await fetch(`${B}/api/media`)).json()).find(m => m.id === id).file}`;
const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const dur = f => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString();
const onset = f => { // first sample louder than -40 dBFS, seconds (the TTS clip's own lead-in)
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 }), n = raw.length / 2;
  for (let i = 0; i < n; i++) if (Math.abs(raw.readInt16LE(i * 2)) > 328) return i / 16000;
  return 0;
};
const imp = async f => { const m = await (await fetch(`${B}/api/import?name=${encodeURIComponent(f.split('/').pop())}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json(); made.media.push(m.id); return m; };
const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
function lcs(a, b) { // longest common subsequence of two word lists -> matched index pairs
  const D = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) D[i][j] = a[i] === b[j] ? D[i + 1][j + 1] + 1 : Math.max(D[i + 1][j], D[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) { if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (D[i + 1][j] >= D[i][j + 1]) i++; else j++; }
  return pairs;
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const secs = t0 => ((performance.now() - t0) / 1000).toFixed(1);

const b = await browser.launch();
const open = async (rm = false) => {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm ? 'reduce' : 'no-preference' })).newPage();
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  page.on('dialog', d => d.accept());
  await page.route(u => u.pathname === '/api/remote/next', async q => { await new Promise(z => setTimeout(z, 15000)); q.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.goto(B + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
  return page;
};
const page = await open();
const ev = (f, a) => page.evaluate(f, a);
const fresh = async name => { const id = await ev(n => { setProject(newProject('16:9')); P.name = `${n} (scratch)`; S.t = 0; renderAll(); return P.id; }, name); made.projects.push(id); return id; };
const pixDiff = (t, max = 640) => ev(async ([t, max]) => { // preview vs export at t: mean and worst 10x10 block (0-255), at 160x90 like video_parity
  const ex = await REMOTE.snapshot({ t, max }), pv = await REMOTE.snapshot({ t, max, preview: true });
  const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
  const [a, q] = [await px(ex.image), await px(pv.image)];
  let sum = 0, worst = 0;
  for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) { let s = 0; for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 160 + x) * 4 + k; s += Math.abs(a[i] - q[i]); } sum += s; worst = Math.max(worst, s / 300); }
  return { mean: +(sum / (160 * 90 * 3)).toFixed(2), worst: +worst.toFixed(1), t: ex.t, ex: ex.image, mode: S.layerMode };
}, [t, max]);
const exportPx = t => ev(async t => { const r = await REMOTE.snapshot({ t, max: 640 }); const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0); return [...g.getImageData(0, 0, im.width, im.height).data]; }, t);

try {
// ---------- tiles ----------
if (run('tiles')) {
  for (const rm of [false, true]) {
    const pg = rm ? await open(true) : page;
    await pg.evaluate(() => { setProject(newProject('16:9')); P.name = 'tiles (scratch)'; renderAll(); window.__pid = P.id; });
    made.projects.push(await pg.evaluate(() => window.__pid));
    await pg.click('.rail button[data-tab="captions"]');
    await pg.waitForTimeout(300);
    const grab = n => pg.evaluate(n => { const c = document.querySelector(`.tile[data-cap="${n}"] canvas`); return [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data].reduce((h, v, i) => (h * 31 + v * (i % 7 + 1)) >>> 0, 7); }, n);
    const names = await pg.evaluate(() => Object.keys(CAP_PRESETS)), blank = await pg.evaluate(() => { const c = document.createElement('canvas'); c.width = TILE_W; c.height = TILE_H; c.getContext('2d').drawImage(sampleScene(TILE_W, TILE_H, 1), 0, 0); return [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data].reduce((h, v, i) => (h * 31 + v * (i % 7 + 1)) >>> 0, 7); });
    const hs = []; for (const n of names) { await pg.locator(`.tile[data-cap="${n}"]`).scrollIntoViewIfNeeded(); await pg.waitForTimeout(60); hs.push(await grab(n)); } // tiles draw when scrolled into view
    check(`${rm ? '[reduced motion] ' : ''}${names.length} caption presets, each a drawn tile with its caption on it`, names.length >= 20 && hs.every(h => h !== blank) && new Set(hs).size === names.length, `${names.length} presets, ${new Set(hs).size} distinct tiles`);
    const s0 = await grab('Bounce'); await pg.waitForTimeout(400);
    check(`${rm ? '[reduced motion] ' : ''}tiles are still until hovered`, s0 === await grab('Bounce'));
    await pg.hover('.tile[data-cap="Bounce"]');
    const seen = new Set(); for (let i = 0; i < 12; i++) { await pg.waitForTimeout(200); seen.add(await grab('Bounce')); } // one 2.2 s loop and a bit
    check(`${rm ? '[reduced motion] ' : ''}the hovered tile plays`, seen.size >= 4, `${seen.size} different frames in 2.4 s`);
    await pg.mouse.move(5, 5); await pg.waitForTimeout(300);
    await pg.click('.tile[data-cap="Karaoke"]');
    check(`${rm ? '[reduced motion] ' : ''}clicking a tile restyles the captions`, await pg.evaluate(() => P.capStyle.kar === 'sweep' && document.querySelector('.tile[data-cap="Karaoke"]').classList.contains('on')));
    if (rm) await pg.close();
  }
  // every preset in one export: the text layer must stay in the workers
  await fresh('Presets');
  const r = await ev(async () => {
    const v = [...M.values()].find(m => m.kind === 'video' && m.ready && m.duration >= 6);
    addMedia(v.id, 'main');
    const W3 = [{ w: 'every', s: 0, e: 0.3 }, { w: 'word', s: 0.3, e: 0.6 }, { w: 'counts', s: 0.6, e: 0.9 }];
    P.captions = Object.keys(CAP_PRESETS).map((n, i) => ({ id: hex12(), start: i * 0.25, dur: 0.9, text: 'every word counts', words: W3, emoji: '🎉', tr: 'cada palabra', kw: [1], spk: i % 2, style: { ...CAP_PRESETS[n], bi: true, kw: true, spk: true } }));
    renderAll();
    const plan = await buildPlan(640, 360, 'fast', 'captions_pro presets', false, 'mp4');
    return { mode: S.layerMode, why: S.layerStats.why || '', pngs: plan.text.n, frames: plan.text.frames.length };
  });
  check('an export with all the presets (and every extra) draws its text layer in the workers', r.mode === 'workers', JSON.stringify(r));
}

// ---------- a real mp4 export: emoji on a caption without word timing, and the active word on a speaker's colour ----------
if (run('export')) {
  await fresh('Emoji export');
  const t = 1.5, r = await ev(async t => {
    const v = [...M.values()].find(m => m.kind === 'video' && m.ready && m.duration >= 4);
    addMedia(v.id, 'main');
    P.capStyle = { ...capPreset('Emoji'), y: 0.6 };
    P.captions = [{ id: hex12(), start: 0.5, dur: 2, text: 'No word timing here', emoji: '⭐' }]; // words dropped (e.g. its text edited), emoji kept
    S.sel = null; renderAll();
    const pv = await REMOTE.snapshot({ t, max: 1280, preview: true }), im = await createImageBitmap(await (await fetch(`data:image/png;base64,${pv.image}`)).blob());
    const c = new OffscreenCanvas(640, 360), g = c.getContext('2d'); g.drawImage(im, 0, 0, 640, 360);
    const ex = await REMOTE.export({ format: 'mp4', resolution: '720p', name: 'captions_pro emoji (scratch)' });
    return { pv: [...g.getImageData(0, 0, 640, 360).data], file: ex.file, fps: P.fps, mode: S.layerMode };
  }, t);
  const f = `${LIB}/exports/${r.file}`, raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', `${t + 0.25 / r.fps}`, '-i', f, '-frames:v', '1', '-vf', 'scale=640:360', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  fs.mkdirSync(`${LIB}/trash/exports`, { recursive: true }); fs.renameSync(f, `${LIB}/trash/exports/${r.file}`);
  const star = (d, n) => { let c = 0; for (let i = 0; i < 640 * 360; i++) if (d[i * n] > 180 && d[i * n + 1] > 110 && d[i * n] - d[i * n + 2] > 100) c++; return c; }; // the yellow star's pixels (the words are white)
  const se = star(raw, 3), sp = star(r.pv, 4);
  check('emoji caption without word timing: the exported mp4 shows the emoji popped in, as big as the preview', sp > 100 && se / sp > 0.7 && se / sp < 1.4 && r.mode === 'workers', `${se} star px in the export, ${sp} in the preview (640x360), ${r.mode}`);
  // speaker 1's colour is Bold's highlight yellow: the active word must still stand out (drawn in the caption's own white)
  // the video under the caption is whatever the library has first (export_formats' colour bars have a yellow bar): only pixels
  // yellow with the caption and not yellow without it count
  const k = await ev(async () => {
    const W = [{ w: 'one', s: 0, e: 0.5 }, { w: 'two', s: 0.5, e: 1 }, { w: 'three', s: 1, e: 1.5 }];
    const grab = async () => { const r = await REMOTE.snapshot({ t: 1.25, max: 640 }), im = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height); };
    P.captions = []; renderAll();
    const bg = (await grab()).data, Y = (d, i) => d[i] > 235 && d[i + 1] > 190 && d[i + 1] < 230 && d[i + 2] < 40;
    window.__capY = (d, i) => Y(d, i) && !Y(bg, i); // the caption's own yellow
    P.capStyle = { ...capPreset('Bold'), y: 0.6, spk: true };
    P.captions = [{ id: hex12(), start: 0.5, dur: 1.5, text: 'one two three', words: W, spk: 0 }]; renderAll();
    const im = await grab(), d = im.data, n = { yellow: 0, white: 0 };
    for (let y = Math.round(im.height * 0.45); y < im.height * 0.75; y++) for (let x = 0; x < im.width; x++) { const i = (y * im.width + x) * 4; if (__capY(d, i)) n.yellow++; }
    P.capStyle.spk = false; renderAll(); // the same frame without speakers: white words, yellow active word
    return n;
  });
  const [wy, wo] = await ev(async () => { // pixels of the active word, colour-tested against the frame with speakers off
    const grab = async () => { const r = await REMOTE.snapshot({ t: 1.25, max: 640 }), im = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height); };
    const off = await grab(); P.capStyle.spk = true; renderAll(); const on = await grab();
    let word = 0, still = 0; // the active word's yellow pixels with speakers off: with speakers on they must not be yellow any more
    for (let i = 0; i < off.data.length; i += 4) if (__capY(off.data, i)) { word++; if (__capY(on.data, i)) still++; }
    return [word, still];
  });
  check("speaker labels: the active word stands out from speaker 1's caption colour", wy > 200 && wo / wy < 0.2 && k.yellow > wy, `${wy} active-word px, ${wo} still yellow with speakers on; ${k.yellow} yellow px in the speaker's caption`);
}

// ---------- keywords (and emoji) on podcast-episode ----------
const pod = await ev(() => [...M.values()].find(m => /podcast-episode/.test(m.name))?.id);
if ((run('keywords') || run('bilingual')) && pod) {
  await fresh('Podcast captions');
  await ev(id => { addMedia(id, 'main'); renderAll(); }, pod);
  let t0 = performance.now();
  const cap = await ev(() => REMOTE.auto_captions({ lang: 'en', words: 3, style: 'Bold' }));
  console.log(`  captions: ${cap.captions} in ${secs(t0)} s (${cap.status})`);
  if (run('keywords')) {
    t0 = performance.now();
    const kw = await ev(() => REMOTE.caption_extras({ keywords: true }));
    const tk = secs(t0);
    const stat = await ev(() => {
      // small words (a caption of only these, like "back to the", has nothing to mark)
      const STOP = new Set('a about all am an and are as at be been but by can could did do does for from get got had has have he her here his i im if in into is it its just me my no not of on or our out over she so some than that thats the their them then there they this to too up us very was we were what will with would you your'.split(' '));
      const nw = w => w.toLowerCase().replace(/[^\w]/g, ''), caps = P.captions, picks = caps.flatMap(c => (c.kw || []).map(i => c.text.split(/\s+/)[i] || '?'));
      const content = caps.filter(c => c.text.split(/\s+/).some(w => nw(w) && !STOP.has(nw(w))));
      const gs = capGroups();
      return { sents: gs.length, sentsWith: gs.filter(g => g.some(c => c.kw?.length)).length, missed: content.filter(c => !c.kw?.length).map(c => c.text).slice(0, 12), n: caps.length, content: content.length, with: content.filter(c => c.kw?.length).length, any: caps.filter(c => c.kw?.length).length, picks: picks.length, two: caps.filter(c => c.kw?.length === 2).length,
        stop: picks.filter(w => STOP.has(nw(w))).length, bad: caps.filter(c => (c.kw || []).some(i => i >= c.text.split(/\s+/).length)).length };
    });
    console.log(`  keyword picks in ${tk} s:`, kw.keywords.sample.map(([t, w]) => `"${t}" -> ${w.join('+') || '-'}`).join(' | '));
    check('keywords: every podcast sentence gets key words (>= 90 % of sentences, >= 60 % of captions with a content word, 1-2 a caption, none a small word)',
      stat.sentsWith / stat.sents >= 0.9 && stat.with / stat.content >= 0.6 && stat.stop === 0 && stat.bad === 0,
      `${stat.sentsWith}/${stat.sents} sentences; ${stat.with}/${stat.content} captions with a content word (${(100 * stat.with / stat.content).toFixed(0)} %; ${stat.any}/${stat.n} of all), ${stat.picks} words (${stat.two} captions with 2), ${stat.stop} small words, ${tk} s; unmarked e.g. ${stat.missed.join(' / ')}`);
    t0 = performance.now();
    const em = await ev(() => REMOTE.caption_extras({ emoji: true }));
    console.log(`  emoji in ${secs(t0)} s:`, em.emoji.sample.map(([t, e]) => `${e || '-'} ${t.slice(0, 40)}`).join(' | '));
    check('emoji: one per sentence from the local model', em.emoji.marked / em.emoji.of >= 0.8, `${em.emoji.marked}/${em.emoji.of} sentences`);
    const at = await ev(() => { const c = P.captions.find(x => x.kw?.length && x.words?.length > 1); return c.start + c.words.at(-1).s + 0.05; });
    await ev(() => { P.capStyle = { ...capPreset('Emoji'), kw: true }; renderAll(); });
    const d = await pixDiff(at);
    fs.writeFileSync(`${OUT}keywords_export.png`, Buffer.from(d.ex, 'base64'));
    check('keywords + emoji: preview == export on a marked caption', d.mean <= 4 && d.worst <= 28 && d.mode === 'workers', `mean ${d.mean}, worst block ${d.worst} @${d.t}s, ${d.mode}`);
  }
  if (run('bilingual')) {
    t0 = performance.now();
    const tr = await ev(() => REMOTE.translate_captions({ to: 'Spanish', bilingual: true }));
    const tt = secs(t0);
    const n = await ev(() => [P.captions.filter(c => c.tr).length, P.captions.length, P.captions.every(c => c.words?.length)]);
    console.log(`  translated in ${tt} s:`, tr.first.map(([a, x]) => `"${a}" / "${x}"`).join(' | '));
    check('bilingual: every caption keeps its words and timing and gets its share of the translation', n[0] / n[1] >= 0.9 && n[2], `${n[0]}/${n[1]} captions with a second line, ${tr.sentences} sentences, ${tt} s`);
    // the caption with the longest second line (the model's wording varies run to run; a short one in Subtitle's small type is few pixels)
    const [at, trLen] = await ev(() => { const c = P.captions.filter(x => x.tr).reduce((a, x) => x.tr.length > a.tr.length ? x : a); return [c.start + c.dur / 2, c.tr.length]; });
    for (const preset of ['Bold', 'Subtitle', 'Karaoke']) {
      await ev(p => { P.capStyle = { ...capPreset(p), bi: true, biColor: '#9ff0ff' }; renderAll(); }, preset);
      const d = await pixDiff(at);
      fs.writeFileSync(`${OUT}bilingual_${preset}_export.png`, Buffer.from(d.ex, 'base64'));
      const on = await exportPx(at);
      await ev(() => { P.capStyle.bi = false; renderAll(); });
      const off = await exportPx(at);
      let changed = 0; // pixels the second line adds to the export
      for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > 60) changed++;
      check(`bilingual (${preset}): preview == export, and the second line is in the export`, d.mean <= 4 && d.worst <= 28 && changed > 12 * trLen, `mean ${d.mean}, worst block ${d.worst} @${d.t}s, ${changed} px from the second line (${trLen} characters)`);
    }
  }
} else if (run('keywords') || run('bilingual')) check('podcast-episode in the library', false);

// ---------- lyrics: a song made here ----------
if (run('lyrics')) {
  const LYR = ['Lights are shining on the open road', 'We keep on singing till the morning comes', 'Hold my hand and never let it go', 'Every heartbeat sounds like a drum',
    'Dancing slowly under silver skies', 'This is the moment we were waiting for'];
  const song = `${OUT}song.wav`, mus = `${OUT}song_music.wav`, voc = `${OUT}song_vocals.wav`, truthF = `${OUT}song.json`;
  if (!fs.existsSync(mus) || !fs.existsSync(voc) || !fs.existsSync(truthF)) { // the two stems, kept: the mix below is made from them every run
    const t0 = performance.now();
    const music = await job('/api/ai/music', { prompt: 'upbeat pop song, bright synths, punchy drums, bass, 110 bpm', dur: 26, seed: 7 });
    made.media.push(music.media);
    const parts = [], truth = [];
    for (const [i, line] of LYR.entries()) {
      const v = await job('/api/ai/voice', { text: line, voice: 'af_bella', speed: 0.9 }); made.media.push(v.media);
      const f = await mediaFile(v.media), at = 1.5 + i * 3.9;
      parts.push([f, at]); truth.push({ line, at: +(at + onset(f)).toFixed(3), end: +(at + dur(f)).toFixed(3) });
    }
    ff(['-i', await mediaFile(music.media), '-ar', '44100', '-ac', '2', '-t', '25', mus]);
    const fc = parts.map(([, at], i) => `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(at * 1000)}:all=1[v${i}]`).join(';') + `;${parts.map((_, i) => `[v${i}]`).join('')}amix=inputs=${parts.length}:normalize=0,apad[o]`;
    ff([...parts.flatMap(p => ['-i', p[0]]), '-filter_complex', fc, '-map', '[o]', '-t', '25', voc]);
    fs.writeFileSync(truthF, JSON.stringify({ truth, made: secs(t0) }));
  }
  const { truth } = JSON.parse(fs.readFileSync(truthF, 'utf8'));
  // the vocals sit 6 dB under the music (louder than most pop mixes put them below): plain whisper loses words there
  const rms = f => +String(spawnSync('ffmpeg', ['-v', 'info', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']).stderr).match(/mean_volume: (-?[\d.]+) dB/)?.[1];
  const mdb = rms(mus), vdb = rms(voc), gain = 10 ** ((mdb - 6 - vdb) / 20);
  ff(['-i', mus, '-i', voc, '-filter_complex', `[1:a]volume=${gain.toFixed(4)}[v];[0:a][v]amix=inputs=2:normalize=0,alimiter=limit=0.95[o]`, '-map', '[o]', song]);
  console.log(`  song: music ${mdb} dB, vocals ${(vdb + 20 * Math.log10(gain)).toFixed(1)} dB mean volume (vocal stem includes the gaps between lines)`);
  const before = new Set((await (await fetch(`${B}/api/media`)).json()).map(m => m.id));
  const sm = await imp(song);
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, sm.id, { timeout: 60000 });
  const tw = truth.flatMap((t, li) => t.line.split(' ').map(w => ({ w: norm(w), li })));
  const score = caps => { // word recall against the lyrics, and each line's onset error (its first heard word)
    const hw = caps.flatMap(c => c.words.map(w => ({ w: norm(w.w), t: c.start + w.s }))), pairs = lcs(tw.map(x => x.w), hw.map(x => x.w)), errs = [];
    for (const [li, t] of truth.entries()) { const p = pairs.find(([i]) => tw[i].li === li && tw[i - 1]?.li !== li); if (p) errs.push(Math.abs(hw[p[1]].t - t.at)); } // a line's first word, when it was heard
    return { recall: pairs.length / tw.length, heard: hw.length, lines: errs.length, onset: med(errs), worst: Math.max(...errs) };
  };
  const out = {};
  for (const lyrics of [false, true]) {
    await fresh(lyrics ? 'Lyrics' : 'Song plain');
    await ev(id => { addMedia(id, 'audio', 0); renderAll(); }, sm.id);
    const t0 = performance.now();
    await ev(l => REMOTE.auto_captions({ lang: 'en', words: 4, audio: true, lyrics: l }), lyrics);
    out[lyrics ? 'lyrics' : 'plain'] = { ...score(await ev(() => P.captions)), s: secs(t0) };
  }
  for (const m of await (await fetch(`${B}/api/media`)).json()) if (!before.has(m.id)) made.media.push(m.id); // the separated vocals too
  const L = out.lyrics, Pn = out.plain, f2 = x => (x * 100).toFixed(0);
  console.log(`  plain captions of the mix: recall ${f2(Pn.recall)} %, median line onset error ${Pn.onset?.toFixed(2)} s (${Pn.s} s)`);
  check('lyrics: Demucs vocals + whisper hear the sung lines (word recall >= 85 %, first words within 0.3 s median, 0.6 s worst)', L.recall >= 0.85 && L.onset <= 0.3 && L.worst <= 0.6,
    `recall ${f2(L.recall)} % (${L.heard} words heard), ${L.lines}/${truth.length} lines, onset median ${L.onset?.toFixed(2)} s, worst ${L.worst?.toFixed(2)} s, ${L.s} s; plain whisper: ${f2(Pn.recall)} %`);
}

// ---------- speakers ----------
if (run('speakers')) {
  const LINES = [[0, 'So I tried the new editor this morning.'], [1, 'Did the captions come out right?'], [0, 'Mostly yes, the timing was spot on.'], [0, 'It even caught the names of the towns.'],
    [1, 'That sounds better than the cloud version we used last year.'], [1, 'How long did the export take?'], [0, 'About twenty seconds for a five minute video.'], [1, 'Wow, that is fast.'],
    [0, 'And nothing left my laptop at all.'], [1, 'Can it tell the two of us apart?'], [0, 'That is exactly what we are testing right now.'], [1, 'Then I will say something long so it has plenty of my voice to hear.'],
    [0, 'Fine, here is a longer sentence with many ordinary words in it.'], [1, 'Great.'], [0, 'Okay, see you tomorrow at the studio.'], [1, 'Bye for now, and thanks.']];
  for (const [va, vb] of [['af_heart', 'am_michael'], ['am_adam', 'am_michael'], ['af_heart', 'af_bella']]) {
    const fx = `${OUT}talk_${va}_${vb}.wav`, tf = `${OUT}talk_${va}_${vb}.json`;
    if (!fs.existsSync(fx) || !fs.existsSync(tf)) {
      const parts = [];
      let at = 0.3;
      for (const [s, line] of LINES) {
        const v = await job('/api/ai/voice', { text: line, voice: s ? vb : va }); made.media.push(v.media);
        const f = await mediaFile(v.media), d = dur(f);
        parts.push({ f, s, at, end: at + d }); at += d + 0.35;
      }
      const fc = parts.map((p, i) => `[${i}:a]aresample=24000,adelay=${Math.round(p.at * 1000)}:all=1[a${i}]`).join(';') + `;${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:normalize=0[o]`;
      ff([...parts.flatMap(p => ['-i', p.f]), '-filter_complex', fc, '-map', '[o]', '-ac', '1', fx]);
      fs.writeFileSync(tf, JSON.stringify(parts.map(({ s, at: a, end }) => ({ s, at: a, end }))));
    }
    const truth = JSON.parse(fs.readFileSync(tf, 'utf8')), m = await imp(fx);
    await ev(() => loadMedia());
    await page.waitForFunction(id => M.get(id)?.ready, m.id, { timeout: 60000 });
    await fresh(`Speakers ${va} ${vb}`);
    await ev(id => { addMedia(id, 'audio', 0); renderAll(); }, m.id);
    await ev(() => REMOTE.auto_captions({ lang: 'en', words: 3, audio: true }));
    for (const n of [0, 2]) {
      const t0 = performance.now();
      const r = await ev(n => REMOTE.caption_extras({ speakers: n || true }), n), ts = secs(t0);
      const caps = await ev(() => P.captions.map(c => ({ mid: c.start + c.dur / 2, spk: c.spk ?? -1, text: c.text })));
      const want = caps.map(c => (truth.find(t => c.mid >= t.at - 0.2 && c.mid <= t.end + 0.2) || truth.reduce((a, t) => (Math.abs(t.at - c.mid) < Math.abs(a.at - c.mid) ? t : a))).s);
      const acc = Math.max(...[[0, 1], [1, 0]].map(([x, y]) => caps.filter((c, i) => (c.spk === 0 ? x : c.spk === 1 ? y : -1) === want[i]).length)) / caps.length;
      const flip = caps.filter((c, i) => c.spk === want[i]).length < caps.length / 2, wrong = caps.filter((c, i) => (flip ? 1 - c.spk : c.spk) !== want[i]).map(c => c.text).slice(0, 4);
      if (process.env.DEBUG) console.log(caps.map((c, i) => `${c.mid.toFixed(1)} ${want[i]}/${c.spk} ${c.text}`).join('\n'));
      const msg = `${(acc * 100).toFixed(1)} % of ${caps.length} captions, ${r.speakers.speakers} speakers, ${ts} s, last merges ${JSON.stringify(r.speakers.merges.slice(-3))}${acc < 1 ? `; wrong e.g. ${wrong.join(' / ')}` : ''}`;
      // af_heart + af_bella: two US female Kokoro voices WavLM hears as 0.89 alike (0.96 within one): measured and shown, not gated
      if (vb === 'af_bella') console.log(`INFO speakers (${va} + ${vb}, ${n ? '2 given' : 'auto count'}), the near-identical pair: ${msg}`);
      else check(`speakers (${va} + ${vb}, ${n ? '2 given' : 'auto count'}): >= 90 % of captions labelled right`, acc >= 0.9 && (n || r.speakers.speakers === 2), msg);
    }
    if (va === 'af_heart' && vb === 'am_michael') { // the labels on the frame, preview == export
      await ev(() => { P.capStyle = { ...capPreset('Bold'), spk: true, spkNames: ['Host'] }; renderAll(); });
      const d = await pixDiff(await ev(() => P.captions[3].start + 0.1));
      fs.writeFileSync(`${OUT}speakers_export.png`, Buffer.from(d.ex, 'base64'));
      check('speaker labels: preview == export', d.mean <= 4 && d.worst <= 28, `mean ${d.mean}, worst block ${d.worst}`);
    }
  }
}
} finally {
  await b.close();
  for (const id of made.projects) await fetch(`${B}/api/projects/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  for (const id of made.media) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
