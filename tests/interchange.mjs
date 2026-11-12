// Timeline hand-off: FCPXML 1.10, CMX3600 EDL and YouTube chapters (POST /api/interchange, and the Export dialog in headless WebKit).
// A known project (library media: a video with sound, a still, two sounds) at 30 fps:
//   main  A: video 1-3 s, volume 0.5, 0.5 s dissolve into B | B: video 2-6 s at 2x, opacity 0.6 | C: still, 20 s
//   overlay: video at 1 s for 2 s | audio: 4 s at 0.5 s (volume 0.25) and 1 s at 1 s (overlaps: a second lane) | a title, a caption
// The expected frames below are worked out by hand from the editor's rules (frames = round(seconds x fps), a dissolve overlaps its
// clips, FCPXML splits it round the cut), not from server.py. FCPXML is read with the browser's DOMParser; every media-rep must be
// a file that exists. EDL at 25 fps and at 29.97 drop-frame, line by line. Chapters: names, the 0:00 rule, the 10 s rule.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node interchange.mjs   (never 4610)
import { webkit } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const B = process.env.B || 'http://127.0.0.1:4702', HOME = process.env.CUTROOM_HOME;
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { ok: r.ok, ...(await r.json()) }; };
const media = await (await fetch(`${B}/api/media`, { headers: { 'X-Cutroom': '1' } })).json();
const vid = media.find(m => m.kind === 'video' && m.hasAudio && m.duration >= 7 && m.ready), img = media.find(m => m.kind === 'image' && m.ready);
const snd = media.filter(m => m.kind === 'audio' && m.duration >= 4 && m.ready);
if (!vid || !img || snd.length < 1) throw new Error('the scratch library needs a video with sound (7 s+), a picture and a sound (4 s+)');
let n = 0;
const mk = (media, o) => ({ id: `c0ffee${String(++n).padStart(6, '0')}`, media, start: 0, speed: 1, volume: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 }, ...o });
const project = (fps, cOut = 20) => ({
  id: 'abcdef012345', name: `Hand-off ${fps} (scratch)`, w: 1920, h: 1080, fps, bg: '#000000',
  main: [mk(vid.id, { in: 1, out: 3, volume: 0.5, tr: { type: 'fade', d: 0.5 } }), mk(vid.id, { in: 2, out: 6, speed: 2, opacity: 0.6 }), mk(img.id, { in: 0, out: cOut })],
  overlay: [mk(vid.id, { start: 1, in: 0, out: 2, fit: 'fill', scale: 0.4 })],
  audio: [mk(snd[0].id, { start: 0.5, in: 0, out: 4, volume: 0.25 }), mk(snd.at(-1).id, { start: 1, in: 0, out: 1 })],
  text: [{ id: 'aaaaaaaaaaaa', start: 0, dur: 2, text: 'Hello title', style: { font: 'Montserrat' }, x: 0.5, y: 0.2 }],
  captions: [{ id: 'bbbbbbbbbbbb', start: 3, dur: 1.5, text: 'A caption & <more>' }], fx: [], markers: [0.4, 11, 21], tracks: {}, mute: {},
});
const assets = new Set([vid.id, img.id, snd[0].id, snd.at(-1).id]).size;

const b = await webkit.launch();
const page = await (await b.newContext({ reducedMotion: 'reduce' })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });

// ---------- FCPXML at 30 fps ----------
const P30 = project(30), r = await post('/api/interchange', { format: 'fcpxml', project: P30 });
check('FCPXML written to the exports folder', r.ok && r.file.endsWith('.fcpxml') && fs.existsSync(`${HOME}/exports/${r.file}`), r.file || r.error);
const X = await page.evaluate(xml => { // -> the parts as plain data, times in frames of 1/30 s
  const d = new DOMParser().parseFromString(xml, 'application/xml'), q = s => [...d.querySelectorAll(s)];
  if (d.querySelector('parsererror')) return { err: d.querySelector('parsererror').textContent };
  const f = s => { if (!s) return null; const m = /^(\d+)(?:\/(\d+))?s$/.exec(s); return m ? (+m[1] / (+m[2] || 1)) * 30 : NaN; };
  const at = e => [...e.parentElement.parentElement.children].indexOf(e.parentElement); // which spine item it hangs from
  const el = e => ({ tag: e.tagName, lane: +(e.getAttribute('lane') || 0), off: f(e.getAttribute('offset')), start: f(e.getAttribute('start') || '0s'), dur: f(e.getAttribute('duration')),
    vol: e.querySelector(':scope > adjust-volume')?.getAttribute('amount'), blend: e.querySelector(':scope > adjust-blend')?.getAttribute('amount'),
    map: [...e.querySelectorAll(':scope > timeMap > timept')].map(t => [f(t.getAttribute('time')), f(t.getAttribute('value'))]), text: e.querySelector('text-style')?.textContent,
    parent: e.parentElement.tagName === 'spine' ? null : at(e) });
  return { version: d.documentElement.getAttribute('version'), fd: q('resources > format')[0].getAttribute('frameDuration'), seqDur: f(q('sequence')[0].getAttribute('duration')),
    spine: [...q('spine')[0].children].map(el), conn: q('spine > * > *[lane]').map(el), markers: q('marker').map(m => [m.getAttribute('value'), f(m.getAttribute('start')), at(m)]),
    srcs: q('media-rep').map(m => m.getAttribute('src')), assets: q('asset').length, effects: q('effect').map(e => e.getAttribute('name')) };
}, fs.readFileSync(`${HOME}/exports/${r.file}`, 'utf8'));
check('FCPXML parses (DOMParser), version 1.10, frame 1/30 s', !X.err && X.version === '1.10' && X.fd === '1/30s', X.err || `${X.version} ${X.fd}`);
const sp = X.spine.map(e => [e.tag, e.off, e.dur, e.start]);
// A 60 frames, B 60 (4 s of file at 2x), C 600; the 15-frame dissolve starts at B's first frame (45) and the cut sits 7 frames in
check('spine: A | dissolve | B | C, offset / duration / start in frames', JSON.stringify(sp) === JSON.stringify([['asset-clip', 0, 52, 30], ['transition', 45, 15, 0], ['asset-clip', 52, 53, 37], ['video', 105, 600, 0]]), JSON.stringify(sp));
check('spine has no holes, sequence = 705 frames', X.spine.filter(e => e.tag !== 'transition').every((e, i, a) => !i || a[i - 1].off + a[i - 1].dur === e.off) && X.seqDur === 705, `${X.seqDur}`);
check('A plays its whole 1-3 s through the dissolve (start 30 + 52 + 8 handle = 90)', X.spine[0].start + X.spine[0].dur + (15 - 7) === 90);
check('A volume 0.5 = -6.02dB', X.spine[0].vol === '-6.02dB', X.spine[0].vol);
check('B speed 2 as a time map (file time = 2 x clip time), opacity 0.6', X.spine[2].map.length === 2 && X.spine[2].map[0][1] === 0 && Math.abs(X.spine[2].map[1][1] / X.spine[2].map[1][0] - 2) < 1e-9 && X.spine[2].blend === '0.6', JSON.stringify(X.spine[2]));
const by = (tag, lane) => X.conn.find(c => c.tag === tag && c.lane === lane);
const ov = by('asset-clip', 1), a1 = by('asset-clip', -1), a2 = by('asset-clip', -2), ti = by('title', 2), ca = by('title', 3);
check('overlay: lane 1 on A, offset 60 (A starts at file frame 30, overlay at frame 30), 60 frames', ov && ov.parent === 0 && ov.off === 60 && ov.dur === 60 && ov.start === 0, JSON.stringify(ov));
check('sounds: lanes -1 / -2 (they overlap), offsets 45 / 60, 120 / 30 frames, -12.04dB', a1 && a2 && a1.off === 45 && a1.dur === 120 && a1.vol === '-12.04dB' && a2.off === 60 && a2.dur === 30, JSON.stringify([a1, a2]));
check('title: Basic Title on lane 2 with its text', ti && ti.off === 30 && ti.dur === 60 && ti.text === 'Hello title' && X.effects.includes('Basic Title'), JSON.stringify(ti));
check('caption: a title on lane 3, on B (37 + 90 - 52 = 75), text escaped and back', ca && ca.parent === 2 && ca.off === 75 && ca.dur === 45 && ca.text === 'A caption & <more>', JSON.stringify(ca));
check('dissolve is a Cross Dissolve', X.effects.includes('Cross Dissolve'));
check('assets: one per file, every media-rep a file:// URL of an existing library file', X.assets === assets && X.srcs.length === assets && X.srcs.every(s => s.startsWith('file:///') && fs.existsSync(fileURLToPath(s))), X.srcs.join(' '));
check('markers: 0.4 s on A, 11 s and 21 s on C, named after the title or numbered', JSON.stringify(X.markers) === JSON.stringify([['Hello title', 42, 0], ['Marker 2', 225, 3], ['Marker 3', 525, 3]]), JSON.stringify(X.markers));
for (const [fps, num, den] of [[29.97, 1001, 30000], [23.976, 1001, 24000], [59.94, 1001, 60000], [25, 1, 25]]) {
  const x = await post('/api/interchange', { format: 'fcpxml', project: project(fps) });
  const t = fs.readFileSync(`${HOME}/exports/${x.file}`, 'utf8'), fr = s => { const [a, c = 1] = s.split('/').map(Number); return (a / c) * den / num; };
  const times = [...t.matchAll(/ (?:offset|duration)="([\d/]+)s"/g)].map(m => fr(m[1]));
  check(`FCPXML at ${fps} fps: frame ${num}/${den} s, every offset and duration a whole frame`, t.includes(`frameDuration="${num === 1 ? `1/${den}` : `${num}/${den}`}s"`) && times.length > 10 && times.every(v => Math.abs(v - Math.round(v)) < 1e-9), `${times.length} times`);
}

// ---------- EDL ----------
const edl = async fps => { const x = await post('/api/interchange', { format: 'edl', project: project(fps, 70) }); return { ...x, lines: fs.readFileSync(`${HOME}/exports/${x.file}`, 'utf8').split('\n') }; };
const ev = l => /^\d{3} /.test(l);
const e25 = await edl(25); // A 50 frames, 13-frame dissolve (12.5 rounds up, like the editor), B 50, C 1750
check('EDL 25 fps: header, non-drop', e25.lines[0] === 'TITLE: Hand-off 25 (scratch)' && e25.lines[1] === 'FCM: NON-DROP FRAME', e25.lines.slice(0, 2).join(' / '));
const want25 = ['001  AX       V     C        00:00:01:00 00:00:02:12 00:00:00:00 00:00:01:12',
  '002  AX       V     C        00:00:02:12 00:00:02:12 00:00:01:12 00:00:01:12',
  '002  AX       V     D    013 00:00:02:00 00:00:06:00 00:00:01:12 00:00:03:12',
  '003  AX       V     C        00:00:00:00 00:01:10:00 00:00:03:12 00:01:13:12'];
check('EDL 25 fps: events, dissolve, source and record timecodes', JSON.stringify(e25.lines.filter(ev)) === JSON.stringify(want25), e25.lines.filter(ev).join(' | '));
check('EDL 25 fps: M2 speed 050.0 for B, clip names, a note about the other tracks', e25.lines.includes('M2   AX       050.0                00:00:02:00') && e25.lines.filter(l => l.startsWith('* FROM CLIP NAME: ')).length === 3 && /main track only/.test(e25.notes.join(' ')), e25.notes.join(' '));
const e30 = await edl(29.97); // A 60 frames, 15-frame dissolve, B 60, C 2098 (70 s x 29.97)
check('EDL 29.97: drop frame', e30.lines[1] === 'FCM: DROP FRAME');
const want30 = ['001  AX       V     C        00:00:01;00 00:00:02;15 00:00:00;00 00:00:01;15',
  '002  AX       V     C        00:00:02;15 00:00:02;15 00:00:01;15 00:00:01;15',
  '002  AX       V     D    015 00:00:02;00 00:00:06;00 00:00:01;15 00:00:03;15',
  '003  AX       V     C        00:00:00;00 00:01:10;00 00:00:03;15 00:01:13;15']; // frame 2098 = 01:10;00, 2203 = 01:13;15 (;00 and ;01 dropped at 1:00)
check('EDL 29.97 drop-frame: events and timecodes past the first minute', JSON.stringify(e30.lines.filter(ev)) === JSON.stringify(want30), e30.lines.filter(ev).join(' | '));
check('EDL 29.97: M2 speed 059.9', e30.lines.includes('M2   AX       059.9                00:00:02;00'));

// ---------- YouTube chapters ----------
const c1 = await post('/api/interchange', { format: 'chapters', project: P30 });
check('chapters: one line per marker, named after the text on screen', c1.text === '0:00 Hello title\n0:11 Chapter 2\n0:21 Chapter 3\n' && fs.readFileSync(`${HOME}/exports/${c1.file}`, 'utf8') === c1.text, JSON.stringify(c1.text));
check('chapters: the last one (0:21 to 0:23) is under 10 s, said', c1.notes.length === 1 && c1.notes[0].includes('0:21 to 0:23'), c1.notes.join(' '));
const c2 = await post('/api/interchange', { format: 'chapters', project: { ...P30, markers: [5, 15] } });
check('chapters: no marker at 0:00 -> "0:00 Intro" added and said; 0:00 to 0:05 too short', c2.text === '0:00 Intro\n0:05 Chapter 2\n0:15 Chapter 3\n' && /Added "0:00 Intro"/.test(c2.notes[0]) && c2.notes.some(x => x.includes('0:00 to 0:05')), JSON.stringify(c2));
const c3 = await post('/api/interchange', { format: 'chapters', project: { ...P30, markers: [0, 12] } });
check('chapters: two only -> "at least three" said', c3.notes.some(x => /at least three/.test(x)), c3.notes.join(' '));
const c4 = await post('/api/interchange', { format: 'chapters', project: { ...P30, markers: [] } });
check('chapters: no markers -> refused with how to add them', !c4.ok && /no markers/.test(c4.error), c4.error);
const c5 = await post('/api/interchange', { format: 'xml', project: P30 });
check('unknown format refused', !c5.ok && /format must be one of fcpxml, edl, chapters/.test(c5.error), c5.error);
await b.close();

// ---------- the Export dialog and the MCP export, both motion modes ----------
const bw = await webkit.launch(), ids = [];
for (const rm of ['reduce', 'no-preference']) {
  const pg = await (await bw.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const er = []; pg.on('pageerror', e => er.push(e.message));
  await pg.goto(`${B}/`, { waitUntil: 'load' });
  await pg.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  ids.push(await pg.evaluate(p => { setProject({ ...structuredClone(p), id: hex12(), name: 'Hand-off UI (scratch)' }); return P.id; }, P30));
  await pg.evaluate(() => openExport());
  const opts = await pg.$$eval('#exFmt option', o => o.map(x => x.value));
  check(`[${rm}] dialog lists fcpxml, edl, chapters`, ['fcpxml', 'edl', 'chapters'].every(f => opts.includes(f)));
  await pg.selectOption('#exFmt', 'fcpxml');
  const st = await pg.evaluate(() => ({ hint: $('#exHint').textContent, res: $('#exRes').disabled, fps: $('#exFps').disabled }));
  check(`[${rm}] FCPXML: hint says what carries over, picture settings off`, /FCPXML 1\.10/.test(st.hint) && /Effects, masks, keyframes and text styling stay/.test(st.hint) && st.res && st.fps, st.hint);
  await pg.click('#exGo');
  await pg.waitForFunction(() => /Saved/.test($('#exStatus')?.textContent || ''), null, { timeout: 15000 });
  const saved = await pg.evaluate(() => $('#exStatus').textContent), f = /Saved (.+\.fcpxml)/.exec(saved)?.[1];
  check(`[${rm}] Export writes the .fcpxml (Show in Finder offered)`, f && fs.existsSync(`${HOME}/exports/${f}`) && !!(await pg.$('#exDone [data-reveal]')), saved);
  await pg.selectOption('#exFmt', 'chapters');
  check(`[${rm}] chapters hint counts the markers`, /3 markers as YouTube chapters/.test(await pg.evaluate(() => $('#exHint').textContent)));
  const m = await pg.evaluate(() => REMOTE.export({ format: 'chapters' }));
  check(`[${rm}] MCP export chapters returns the text and the notes`, m.text === '0:00 Hello title\n0:11 Chapter 2\n0:21 Chapter 3\n' && m.notes.length === 1, JSON.stringify(m));
  const sm = await pg.evaluate(async () => { await REMOTE.set_project({ set: { markers: [0, 30, 60] } }); return P.markers; });
  check(`[${rm}] MCP set_project markers`, JSON.stringify(sm) === '[0,30,60]', JSON.stringify(sm));
  const tick = await pg.evaluate(() => new Promise(r => { const t0 = performance.now(); requestAnimationFrame(() => r(performance.now() - t0)); }));
  check(`[${rm}] page not frozen, no page errors`, tick < 1000 && er.length === 0, er.slice(0, 2).join(' | '));
  await pg.close();
}
await bw.close();
for (const id of ids) await post(`/api/projects/${id}/trash`, {}).catch(() => {});
check('no page errors (API part)', errs.length === 0, errs.slice(0, 2).join(' | '));
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
