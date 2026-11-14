// Automatic B-roll (Smart tools › B-roll from your library, and the auto_broll MCP command): what the main track says ->
// the library's own shots on the overlay track over those sentences, one undo step, each shown with swap and remove.
// Deterministic: a stub transcript (the words cache whisper would write) and a stub smart-search index (no vectors, so no
// model runs). REAL=1 adds one small real run: nomic-embed-text vectors for the index, sentences sharing no word with it.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:4830 node tests/broll.mjs      (never 4610; best on an empty library)
import { browser } from './browser.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const B = process.env.B, HOME = process.env.CUTROOM_HOME, OUT = fileURLToPath(new URL('./out/broll/', import.meta.url));
if (!B || /:4610\b/.test(B) || !HOME) { console.log('SKIP: set B and CUTROOM_HOME to a scratch server (never 4610)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the library: a talking clip for the main track, and shots to illustrate it with ----
const CLIPS = [['br-talk.mp4', 16, true], ['br-coast.mp4', 8], ['br-mountain.mp4', 2], ['br-forest.mp4', 6], ['br-city.mp4', 6], ['br-cafe.jpg'], ['br-beach.jpg']];
for (const [n, d, snd] of CLIPS) {
  if (!fs.existsSync(OUT + n)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30${d ? `:duration=${d}` : ''}`,
    ...(snd ? ['-f', 'lavfi', '-i', `sine=frequency=300:duration=${d}`, '-c:a', 'aac', '-shortest'] : []), ...(d ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-frames:v', '1']), OUT + n]);
  if (!(await api('/api/media')).some(m => m.name === n)) await api('/api/import_path', { path: OUT + n });
}
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const lib = await api('/api/media'), id = n => lib.find(m => m.name === n)?.id;
await api('/api/settings', { 'ai.captions': null, 'ai.llm': null });
for (const n of CLIPS.map(c => c[0])) fs.rmSync(`${HOME}/cache/${id(n)}.index.json`, { force: true }); // (a rerun starts unindexed)

// what whisper "heard" on the talking clip: the words cache transcribe() reads (no whisper run)
const SAID = [[0.2, 'We drove up the coast at sunset.'], [3.0, 'Then we ate dinner at a little cafe.'], [5.8, 'Um, yeah.'], [6.5, 'The mountain trail was steep.'],
  [9.7, 'My dog loves the snow.'], [12.5, 'Back at the beach by the coast again.']];
const words = [];
for (const [t, s] of SAID) { const ws = s.split(' '), step = s === 'Um, yeah.' ? 0.25 : Math.min(0.6, 2.6 / ws.length); ws.forEach((w, i) => words.push({ w, s: +(t + i * step).toFixed(3), e: +(t + (i + 1) * step - 0.02).toFixed(3) })); }
fs.writeFileSync(`${HOME}/cache/${id('br-talk.mp4')}.auto.words.json`, JSON.stringify({ have: [[0, 16]], words }));
// what the vision model "saw": the smart-search index (cache/<id>.index.json, no embedding vectors)
const part = (a, b, desc, tags = []) => ({ a, b, t: (a + b) / 2, desc, things: [], people: 0, faces: 0, setting: 'outdoor', light: 'day', tags });
const INDEX = {
  'br-talk.mp4': [part(0, 16, 'a man talking about the coast at sunset')], // the main track's own clip: never its own B-roll
  'br-coast.mp4': [part(0, 4, 'a busy city street'), part(4, 8, 'a rocky coast with waves at sunset')],
  'br-mountain.mp4': [part(0, 2, 'a steep mountain trail', ['hiking'])],
  'br-forest.mp4': [part(0, 6, 'a forest trail in the mountains')],
  'br-city.mp4': [part(0, 6, 'traffic lights at night')],
  'br-cafe.jpg': [part(0, 0, 'a cozy cafe table with dinner plates')],
  'br-beach.jpg': [part(0, 0, 'a sandy beach with umbrellas')],
};
const writeIndex = vec => { for (const [n, parts] of Object.entries(INDEX)) fs.writeFileSync(`${HOME}/cache/${id(n)}.index.json`, JSON.stringify({ v: 1, vision: true, kind: lib.find(m => m.name === n).kind, parts: parts.map(p => ({ ...p, ...(vec ? { v: vec[p.desc] } : {}) })), speech: [] })); };

const b = await browser.launch();
const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: 'reduce' }), page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
const ev = (f, a) => page.evaluate(f, a);
const open = async () => { await page.goto(`${B}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0 && typeof SET === 'object', null, { timeout: 30000 }); await page.waitForTimeout(300); if (await page.$('#tour')) await page.keyboard.press('Escape'); };
await open();
const fresh = () => ev(async ({ talk, dog }) => { // a project: the talk on the main track, an overlay the user put over "my dog loves the snow"
  await REMOTE.new_project({ ratio: '16:9', name: 'broll test' }); await REMOTE.add_clip({ media: talk }); await REMOTE.add_clip({ media: dog, lane: 'overlay', start: 9.5, in: 0, out: 2.5 });
  undo.length = 0; redo.length = 0; renderAll();
}, { talk: id('br-talk.mp4'), dog: id('br-city.mp4') });
const tab = async () => { await page.click('[data-tab="ai"]').catch(() => ev(() => $('[data-tab="ai"]').click())); await page.waitForSelector('#btnBroll', { state: 'visible', timeout: 5000 }); };
const click = async () => { await page.click('#btnBroll'); await page.waitForFunction(() => !$('#btnBroll').disabled && $('#brStatus').textContent && !/Reading|Looking/.test($('#brStatus').textContent), null, { timeout: 60000 }); return ev(() => $('#brStatus').textContent); };

// ---- 1. nothing indexed: a plain message, nothing placed ----
await fresh(); await tab();
const m0 = await click(), ov0 = await ev(() => P.overlay.length);
check('an unindexed library says so plainly and places nothing', /looked inside yet/.test(m0) && ov0 === 1, m0);

// ---- 2. the button: one undo step, the right shots over the right sentences ----
writeIndex();
const u0 = await ev(() => undo.length), m1 = await click();
const p = JSON.parse(await ev(() => JSON.stringify(P))), u1 = await ev(() => undo.length);
const ov = p.overlay.filter(c => c.media !== id('br-city.mp4')).sort((x, y) => x.start - y.start), nm = c => lib.find(m => m.id === c.media)?.name;
const at = (n, t) => ov.find(c => nm(c) === n && Math.abs(c.start - t) < 0.01);
const coast = at('br-coast.mp4', 0.2), cafe = at('br-cafe.jpg', 3.0), mtn = at('br-mountain.mp4', 6.5), beach = at('br-beach.jpg', 12.5);
check('B-roll lands over the sentences it shows: coast, cafe, mountain trail, beach', ov.length === 4 && coast && cafe && mtn && beach, `${m1} · ${ov.map(c => `${nm(c)}@${c.start}`).join(' ')}`);
check('each library item is used once (the second "coast" sentence gets the beach), never the main track\'s own clip',
  new Set(ov.map(c => c.media)).size === ov.length && !ov.some(c => nm(c) === 'br-talk.mp4'));
check('a span that already has an overlay ("my dog", 9.5-12) and a short filler ("Um, yeah.") are left alone', !ov.some(c => c.start > 5.7 && c.start < 6.4) && !ov.some(c => c.start >= 9 && c.start < 12));
const len = c => c.out - c.in;
check('each shot fits its sentence: as long as it is said, shorter only when the file is (mountain clip 2 s)',
  Math.abs(len(coast) - 2.6) < 0.05 && Math.abs(len(cafe) - 2.6) < 0.05 && Math.abs(len(mtn) - 2) < 0.01, ov.map(c => `${nm(c)} ${len(c).toFixed(2)}`).join(', '));
check('the video moment is the matching part (coast 4-8 s, not the city street 0-4 s), within the file', coast.in >= 4 - 0.01 && coast.out <= 8 + 0.01 && mtn.in === 0, `coast ${coast.in}-${coast.out}`);
check('B-roll is muted and fills the frame', ov.every(c => c.volume === 0 && c.fit === 'fill'));
check('placed as ONE undo step; undo takes all of it back, redo puts it back', u1 === u0 + 1 && await ev(() => { restore(undo, redo); const n = P.overlay.length; restore(redo, undo); return n === 1 && P.overlay.length === 5; }), `undo ${u0} -> ${u1}`);

// ---- 3. what was matched, with swap and remove ----
const rows = await ev(() => $$('#brList [data-br]').map(r => r.textContent));
check('the matches are listed with the sentence each one shows', rows.length === 4 && rows.some(r => /br-coast\.mp4/.test(r) && /drove up the coast/.test(r)), rows.join(' | '));
const mtnRow = `#brList [data-br="${mtn.id}"]`;
await page.click(`${mtnRow} [data-bract="swap"]`);
const sw = await ev(i => { const c = P.overlay.find(x => x.id === i); return { media: c.media, n: undo.length, row: $(`#brList [data-br="${i}"]`).textContent }; }, mtn.id);
check('Swap puts the next match in (forest trail for "the mountain trail was steep"), one undo step', sw.media === id('br-forest.mp4') && sw.n === u1 + 1 && /br-forest/.test(sw.row), JSON.stringify(sw));
await page.click(`#brList [data-br="${cafe.id}"] [data-bract="remove"]`);
const rm = await ev(i => ({ gone: !P.overlay.some(x => x.id === i), rows: $$('#brList [data-br]').length, n: undo.length }), cafe.id);
check('Remove takes that shot off the overlay track and the list, one undo step', rm.gone && rm.rows === 3 && rm.n === u1 + 2, JSON.stringify(rm));
await ev(() => restore(undo, redo));
check('undoing the remove brings the shot and its row back', await ev(i => P.overlay.some(x => x.id === i) && $$('#brList [data-br]').length === 4, cafe.id));

// ---- 4. again, through the MCP command: every sentence is covered now, so it says so ----
const again = await api('/api/remote', { cmd: 'auto_broll', args: {} });
check('auto_broll (MCP) with every sentence already covered places nothing and says why', !again.ok && /already has an overlay/.test(again.result), JSON.stringify(again).slice(0, 300));
await fresh();
const mcp = await api('/api/remote', { cmd: 'auto_broll', args: {} });
check('auto_broll (MCP) on a fresh project places the same four shots and lists what each shows', mcp.ok && mcp.result.placed.length === 4 && mcp.result.placed.every(x => x.lane === 'overlay' && x.said && x.shows), JSON.stringify(mcp).slice(0, 400));
const none = await api('/api/broll', { phrases: [{ start: 0, end: 3, text: 'Quantum physics homework tonight.' }] });
check('nothing in the library matches: a plain message', none.picks?.length === 0 && /Nothing in the library matches/.test(none.msg), JSON.stringify(none));

// ---- 5. Settings › AI: auto captions off refuses it everywhere and hides the button; the language model off refuses index=true only ----
await api('/api/settings', { 'ai.captions': false }); await open(); await fresh();
const offR = await api('/api/remote', { cmd: 'auto_broll', args: {} }), offS = await api('/api/broll', { phrases: [{ start: 0, end: 3, text: 'the rocky coast' }] });
const hid = await ev(() => getComputedStyle($('#btnBroll')).display === 'none');
check('auto captions off: the MCP command and the server both refuse, and the button is gone', !offR.ok && /turned off in Settings/.test(offR.result) && /turned off in Settings/.test(offS.error || '') && hid, JSON.stringify({ offR, offS, hid }));
await api('/api/settings', { 'ai.captions': null, 'ai.llm': false }); await open(); await fresh();
const llmI = await api('/api/remote', { cmd: 'auto_broll', args: { index: true } }), llmN = await api('/api/remote', { cmd: 'auto_broll', args: {} });
check('language model off: index=true is refused; the existing index still gives B-roll', !llmI.ok && /turned off in Settings/.test(llmI.result) && llmN.ok && llmN.result.placed.length === 4, JSON.stringify({ llmI, n: llmN.result?.placed?.length }));
await api('/api/settings', { 'ai.llm': null });

// ---- 6. (REAL=1) one small real run: nomic-embed-text vectors; sentences that share no word with the index still match ----
if (process.env.REAL) {
  const emb = async (texts, pre) => (await (await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: texts.map(t => pre + t) }) })).json()).embeddings
    .map(v => { const n = Math.hypot(...v); return v.map(x => x / n); });
  const descs = Object.values(INDEX).flat().map(x => x.desc), vs = await emb(descs, 'search_document: ');
  writeIndex(Object.fromEntries(descs.map((d, i) => [d, vs[i]])));
  // (measured: shoreline -> the coast 0.64; unrelated sentences 0.34-0.50 against every shot, and so is "espresso at a bistro" -> the cafe, 0.50: missed, precision first)
  const t0 = Date.now(), r = await api('/api/broll', { phrases: [{ start: 0, end: 3, text: 'We drove along the shoreline as the sun went down.' },
    { start: 8, end: 11, text: 'Quarterly tax filing deadlines are confusing.' }], skip: [id('br-talk.mp4')] });
  check(`REAL: embeddings match without a shared word (shoreline -> the coast clip); an unrelated sentence gets nothing (${Date.now() - t0} ms)`,
    r.picks?.length === 1 && r.picks[0].media === id('br-coast.mp4') && r.picks[0].start === 0, JSON.stringify(r.picks?.map(x => [x.said, x.name, x.score, x.alts.map(a => `${a.name}:${a.score}`)]) || r));
  writeIndex();
}

check('no page errors', !errs.length, errs.join(' | '));
await b.close();
const n = res.filter(Boolean).length;
console.log(`\n${n}/${res.length} passed`);
process.exit(n === res.length ? 0 : 1);
