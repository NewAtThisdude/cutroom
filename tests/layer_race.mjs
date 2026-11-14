// Text-layer uploads (POST /api/layer/<id>/<i>, then the plan names them) can't be lost without the export failing. An export
// that finishes always has every picture of its text layer; a picture that is missing or damaged makes it fail loudly.
// ffmpeg itself drops an unreadable picture without an error (the concat stream ends, the overlay passes the video through:
// a VP9 export once came out with no text at all), so each way it could happen is tried:
//   a cut-off / non-PNG upload; a plan whose upload is incomplete; one upload named by two plans at once; a picture deleted or
//   damaged mid-render; a second server starting on the same library mid-export (its startup cleanup); 4 exports + 8 still
//   frames at once, each its own upload; and through the page: an export with snapshots taken while it renders.
// Every finished export / still is checked picture by picture (each span's colour at its box).
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> [SERVER_PY=<server.py for the second server>] node layer_race.mjs   (never 4610)
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B, HOME = process.env.CUTROOM_HOME, SERVER_PY = process.env.SERVER_PY || fileURLToPath(new URL('../server.py', import.meta.url));
if (!B || !HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const H = { 'X-Cutroom': '1' };
const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const ff = (args, input) => { const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { input, maxBuffer: 1 << 28 }); if (r.status) throw new Error(`ffmpeg: ${r.stderr}`); return r.stdout; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex12 = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

// the layer: 6 pictures of a 160x120 box at (200, 100): clear, then one colour per span
const W = 640, Hh = 360, F = 30, D = 12, BOX = [200, 100, 160, 120];
const COLS = [null, [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
const PNGS = COLS.map(c => ff(['-f', 'lavfi', '-i', `color=c=${c ? '0x' + c.map(v => v.toString(16).padStart(2, '0')).join('') : 'black@0'}:s=${BOX[2]}x${BOX[3]},format=rgba`, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-']));
const SPANS = [[0, 0, 1], [1, 1, 3], [2, 3, 5], [3, 5, 7], [4, 7, 9], [5, 9, D]].map(([i, start, end]) => ({ i, start, end }));
const PROBES = [[2, 1], [4, 2], [6, 3], [8, 4], [10.5, 5]]; // [t, picture] (all after the first: a missing later one also ends the earlier spans)
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-race-`);
ff(['-y', '-f', 'lavfi', '-i', `color=c=0x203040:s=${W}x${Hh}:r=${F}:d=${D}`, '-f', 'lavfi', '-i', `sine=d=${D}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `${tmp}/race-bg.mp4`]);
const media = (await (await fetch(`${B}/api/import?name=race-bg.mp4`, { method: 'POST', headers: H, body: fs.readFileSync(`${tmp}/race-bg.mp4`) })).json()).id;
const upload = async (lid, i, buf = PNGS[i]) => (await fetch(`${B}/api/layer/${lid}/${i}`, { method: 'POST', headers: H, body: buf })).status;
const layer = async (n = PNGS.length) => { const lid = hex12(); for (let i = 0; i < n; i++) if (await upload(lid, i) !== 200) throw new Error('upload refused'); return lid; };
const plan = (lid, o = {}) => ({ w: W, h: Hh, fps: F, duration: D, bg: '#000000', name: `layer_race ${o.format || 'mp4'}`, format: 'mp4', quality: 'best', overlay: [], audio: [],
  main: [{ media, in: 0, out: D, frames: D * F, geom: { x: 0, y: 0, w: W, h: Hh } }], text: { layer: lid, n: PNGS.length, box: BOX, frames: SPANS }, ...o });
const job = async id => { for (;;) { const j = await (await fetch(`${B}/api/jobs/${id}`, { headers: H })).json(); if (j.state !== 'running') return j; await sleep(100); } };
const near = (px, c) => px.every((v, k) => Math.abs(v - c[k]) < 60);
const rgb = (args, input) => [...ff([...args, '-vf', `format=rgb24,crop=1:1:${BOX[0] + 80}:${BOX[1] + 60}`, '-frames:v', '1', '-f', 'rawvideo', '-'], input).subarray(0, 3)];
const pictures = file => PROBES.map(([t, i]) => [t, rgb(['-ss', String(t), '-i', file])]).filter(([t, px], k) => !near(px, COLS[PROBES[k][1]])); // the spans whose colour is wrong
const layersOf = lid => (fs.existsSync(`${HOME}/cache/layers`) ? fs.readdirSync(`${HOME}/cache/layers`) : []).filter(d => d.startsWith(lid)).map(d => `${HOME}/cache/layers/${d}`);
const done = async (r, what) => { // an export's outcome: [state, wrong spans]
  if (r.status !== 200) return [`refused ${r.status}: ${r.j.error}`, null];
  const j = await job(r.j.job);
  if (j.state !== 'done') return [`${j.state}: ${j.error}`, null];
  const f = `${HOME}/exports/${j.file}`, bad = pictures(f);
  fs.rmSync(f);
  return ['done', bad];
};

// ---- uploads: only whole PNGs are stored
{
  const lid = hex12(), cut = await upload(lid, 1, PNGS[1].subarray(0, PNGS[1].length - 20)), junk = await upload(lid, 1, Buffer.from('not a png at all')), whole = await upload(lid, 1);
  check('a cut-off or non-PNG layer picture is refused, a whole one stored', cut === 400 && junk === 400 && whole === 200, `cut ${cut}, junk ${junk}, whole ${whole}`);
  layersOf(lid).forEach(d => fs.rmSync(d, { recursive: true }));
}
// ---- a plan whose upload is incomplete is refused before any rendering
{
  const lid = await layer(PNGS.length - 1), r = await post('/api/export', plan(lid));
  check('an export naming an incomplete upload is refused', r.status === 400 && /incomplete/.test(r.j.error), `${r.status} ${r.j.error || r.j.job}`);
  const lid2 = await layer(), d = layersOf(lid2)[0];
  fs.writeFileSync(`${d}/t3.png`, PNGS[3].subarray(0, 200)); // damaged on disk after the upload
  const r2 = await post('/api/export', plan(lid2));
  check('an export naming a damaged picture is refused', r2.status === 400 && /damaged/.test(r2.j.error), `${r2.status} ${r2.j.error || r2.j.job}`);
}
// ---- one upload, two plans at once: one renders it (all of it), the other is refused
{
  const lid = await layer(), [a, b2] = await Promise.all([post('/api/export', plan(lid, { format: 'webm' })), post('/api/export', plan(lid))]);
  const out = await Promise.all([done(a), done(b2)]), ok = out.filter(([s]) => s === 'done'), no = out.filter(([s]) => /^refused 400/.test(s));
  check('one upload named by two exports: one exports every picture, the other is refused', ok.length === 1 && no.length === 1 && ok[0][1].length === 0, JSON.stringify(out));
  const lid2 = await layer(), [s, e] = await Promise.all([post('/api/still_frame', plan(lid2, { format: 'png', still: 4 })), post('/api/export', plan(lid2))]);
  const eo = await done(e), sOk = s.status === 200 && near(rgb(['-i', '-'], Buffer.from(s.j.image || '', 'base64')), COLS[2]);
  check('one upload named by a still frame and an export: one gets it whole, the other is refused', (sOk && /^refused 400/.test(eo[0])) || (s.status === 400 && eo[0] === 'done' && eo[1].length === 0), `still ${s.status} ${s.j.error || 'image'}, export ${JSON.stringify(eo)}`);
}
// ---- pictures deleted / damaged while the export renders: it fails (it never finishes without them)
for (const [how, harm] of [['deleted', d => fs.rmSync(`${d}/t5.png`)], ['damaged', d => fs.writeFileSync(`${d}/t5.png`, PNGS[5].subarray(0, 100))]]) {
  const lid = await layer(), r = await post('/api/export', plan(lid, { format: 'webm' }));
  const d = layersOf(lid)[0];
  harm(d); // t5 is first read at 9 s of the timeline: the render is well under way
  const [st, bad] = await done(r);
  check(`a picture ${how} mid-render: the export fails`, /^error: .*text layer/.test(st), `${st}${bad ? ` wrong at ${JSON.stringify(bad)}` : ''}`);
}
// ---- a second server starting on this library (its startup cleanup) while an export renders
{
  const lid = await layer(), r = await post('/api/export', plan(lid, { format: 'webm', w: 1280, h: 720, main: [{ media, in: 0, out: D, frames: D * F, geom: { x: 0, y: 0, w: 1280, h: 720 } }] }));
  const env = { ...process.env, CUTROOM_HOME: HOME, CUTROOM_PORT: new URL(B).port }; // the same port: it clears what it clears, then can't listen and exits
  delete env.PYTHONPATH;
  const second = spawn('python3', ['-I', SERVER_PY], { env, stdio: 'ignore' });
  const exited = await Promise.race([new Promise(ok => second.on('exit', ok)), sleep(30000).then(() => 'timeout')]);
  if (exited === 'timeout') second.kill();
  const still = layersOf(lid).length, [st, bad] = await done(r);
  check('a second server starting on the library mid-export: the export keeps every picture', exited !== 'timeout' && still === 1 && st === 'done' && bad.length === 0, `second server ${exited}, layer dir ${still ? 'kept' : 'GONE'}, ${st}${bad?.length ? ` wrong at ${JSON.stringify(bad)}` : ''}`);
}
// ---- 4 exports and 8 still frames at once, each its own upload
{
  const lids = await Promise.all(Array.from({ length: 12 }, () => layer()));
  const exp = lids.slice(0, 4).map((lid, k) => post('/api/export', plan(lid, { format: ['webm', 'mp4', 'av1webm', 'prores'][k] }))), stills = lids.slice(4).map((lid, k) => post('/api/still_frame', plan(lid, { format: 'png', still: PROBES[k % 5][0] })));
  const eo = await Promise.all(exp.map(async p => done(await p))), so = await Promise.all(stills.map(async (p, k) => { const s = await p; return s.status === 200 && near(rgb(['-i', '-'], Buffer.from(s.j.image, 'base64')), COLS[PROBES[k % 5][1]]); }));
  check('4 exports + 8 still frames at once: every export has every picture, every still its own', eo.every(([s, bad]) => s === 'done' && bad.length === 0) && so.every(Boolean), `${JSON.stringify(eo)} stills ${so.map(Number).join('')}`);
  check('nothing of theirs left in cache/layers', lids.every(lid => layersOf(lid).length === 0), lids.filter(lid => layersOf(lid).length).join(' '));
}
// ---- through the page: the workers' layer, an export with snapshots taken while it renders (each its own upload)
{
  const b = await browser.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: 'reduce' })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
  await page.evaluate(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, media, { timeout: 180000 });
  const SRT = '1\n00:00:00,500 --> 00:00:02,250\nHello from Cutroom\n\n2\n00:00:03,000 --> 00:00:05,125\nSecond line, with a comma\n\n3\n00:00:06,000 --> 00:00:09,500\nThe end\n';
  const out = await page.evaluate(async ({ media, SRT }) => {
    await REMOTE.new_project({ ratio: '16:9', name: 'Layer race (scratch)' });
    await REMOTE.set_project({ set: { fps: 60 } });
    await REMOTE.add_clip({ media, in: 0, out: 10 });
    await REMOTE.add_text({ text: 'Formats', start: 1, duration: 3 });
    importSubs(SRT, 'race.srt');
    const ex = REMOTE.export({ format: 'webm', resolution: '720p', name: 'layer_race page' });
    const shots = [];
    for (const t of [1.5, 3.5, 7]) shots.push(await REMOTE.snapshot({ t, max: 640 }).then(s => s.image));
    return { ex: await ex, shots, mode: S.layerMode, pid: P.id };
  }, { media, SRT });
  const white = (args, input) => { let n = 0; for (const v of ff([...args, '-vf', 'scale=480:270,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], input)) if (v > 200) n++; return n; };
  const f = `${HOME}/exports/${out.ex.file}`, we = [1.5, 3.5, 7].map(t => white(['-ss', String(t), '-i', f])), ws = out.shots.map(s => white(['-i', '-'], Buffer.from(s, 'base64')));
  check('page: an export with 3 snapshots taken while it renders: title and captions in all of them (layer workers)', we.every(n => n > 50) && ws.every(n => n > 50) && out.mode === 'workers' && !errs.length,
    `export white px ${we}, snapshots ${ws}, ${out.mode}${errs.length ? `, errors ${errs.slice(0, 2).join(' | ')}` : ''}`);
  fs.rmSync(f);
  await b.close();
  await post(`/api/projects/${out.pid}/trash`, {});
}
fs.rmSync(tmp, { recursive: true });
await post(`/api/media/${media}/trash`, {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
