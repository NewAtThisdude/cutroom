// Package project / Open package: a project with a video (LUT graded), a photo, a sound, a title in an imported font ->
// one stored .cutroom whose entries and manifest are right; opened into an EMPTY library (a second server this test starts)
// it renders the same frames as the original and lasts as long; "Trim to what is used" makes smaller files (stream copy for
// the MP4, a re-encode for the MP3) whose used ranges still render the same; zips with ../ names are refused; an identical
// file is reused; the dialogs in both motion modes, no page errors.
//   CUTROOM_HOME=<scratch lib> CUTROOM_PORT=4714 python3 -I server.py, then
//   B=http://127.0.0.1:4714 CUTROOM_HOME=<same lib> CUTROOM_SCRATCH=<scratch dir> node package.mjs   (its own server on port+1, or P2)
import { browser } from './browser.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const B = process.env.B || 'http://127.0.0.1:4714', HOME = process.env.CUTROOM_HOME, SCR = process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch';
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const PORT2 = +(process.env.P2 || +new URL(B).port + 1), B2 = `http://127.0.0.1:${PORT2}`, ROOT = fileURLToPath(new URL('..', import.meta.url));
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (base, path, body) => {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH'));
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args], { env, encoding: 'utf8' });
const ff = (...a) => execFileSync('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-y', ...a], { env });
const ZIPINFO = `import json, sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({'names': z.namelist(), 'stored': all(i.compress_type == 0 for i in z.infolist()), 'sizes': {i.filename: i.file_size for i in z.infolist()},
  'manifest': json.loads(z.read('manifest.json')), 'project': json.loads(z.read('project.json')),
  'sha': {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if '/' in n}}))`;

// ---- fixtures: made here, imported by path ----
const FX = mkdtempSync(`${SCR}/pkg-fixtures-`);
ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=12', '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `${FX}/clip.mp4`);
ff('-f', 'lavfi', '-i', 'testsrc=s=480x320', '-frames:v', '1', `${FX}/still.png`);
ff('-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*220*t)+if(between(t,3,3.002),0.7,0)':s=48000:d=10", '-c:a', 'libmp3lame', '-b:a', '192k', `${FX}/tone.mp3`); // a click at 3 s
const click = f => { // seconds to the first sample over the sine, decoded from the file's start (no seek)
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { env, maxBuffer: 1 << 26 });
  for (let i = 0; i < pcm.length / 2; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > 0.5 * 32767) return i / 48000;
  return null;
};
const corners = []; for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) corners.push(`${b} ${g} ${r}`); // red and blue swapped
writeFileSync(`${FX}/swap.cube`, `TITLE "swap"\nLUT_3D_SIZE 2\n${corners.join('\n')}\n`);
const imp = async path => api(B, '/api/import_path', { path });
const [V, I, A] = [await imp(`${FX}/clip.mp4`), await imp(`${FX}/still.png`), await imp(`${FX}/tone.mp3`)];
const font = await (await fetch(`${B}/api/fonts?name=Package%20Face.ttf`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: readFileSync(`${ROOT}/web/fonts/BebasNeue.ttf`) })).json();
const L = await api(B, '/api/luts', { name: 'swap.cube', text: readFileSync(`${FX}/swap.cube`, 'utf8') });
for (let i = 0; i < 120; i++) { const m = await api(B, '/api/media'); if ([V, A].every(x => m.find(y => y.id === x.id)?.ready)) break; await sleep(500); }
{ const f = `${HOME}/media/${A.id}.json`; writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), pack: 'test-pack-tone', sfx: 'test-sfx', licence: 'CC0', src: 'https://example.org/tone' })); } // the MP3 as a sound-library item

// ---- the second server: an empty library ----
const HOME2 = mkdtempSync(`${SCR}/lib2-package-empty-`);
const srv2 = spawn('nice', ['-n', '5', 'python3', '-I', `${ROOT}/server.py`], { env: { ...env, CUTROOM_HOME: HOME2, CUTROOM_PORT: String(PORT2) }, stdio: 'ignore' });
let gone = false; srv2.on('exit', () => { gone = true; });
for (let i = 0; i < 60 && !gone; i++) { try { await api(B2, '/api/ping'); break; } catch { await sleep(500); } }
await sleep(1000); // (a port someone else holds: ours exits, theirs answers)
if (gone || (await api(B2, '/api/media')).length) { srv2.kill(); throw new Error(`port ${PORT2} is taken: set P2 to a free port`); }

const b = await browser.launch();
const errs = [];
const open = async (base, rm = 'reduce') => {
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: rm })).newPage();
  page.on('pageerror', e => errs.push(`${base} ${rm}: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE !== 'undefined', null, { timeout: 20000 });
  await page.evaluate(() => { if (tourAt >= 0) tourGo('skip'); });
  return page;
};
const R = (page, cmd, args = {}) => page.evaluate(([c, a]) => REMOTE[c](a), [cmd, args]);
const shot = async (page, t) => (await R(page, 'snapshot', { t, max: 640 })).image;
const diff = (page, a, c) => page.evaluate(async ([a, c]) => { // mean RGB difference of two PNGs, in levels
  const px = async s => { const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()), cv = new OffscreenCanvas(bm.width, bm.height), x = cv.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height).data; };
  const [p, q] = [await px(a), await px(c)];
  if (p.length !== q.length) return 999;
  let s = 0, n = 0; for (let i = 0; i < p.length; i += 4) { s += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]); n += 3; }
  return s / n;
}, [a, c]);

// ---- the project: video 5-8 s graded with the LUT, the photo, the MP3 at 2-5 s under it, a title in the imported font ----
const pa = await open(B);
await R(pa, 'new_project', { ratio: '16:9', name: 'Package test' });
const cv = await R(pa, 'add_clip', { media: V.id, lane: 'main', in: 5, out: 8 });
await R(pa, 'update_clip', { id: cv.id, set: { grade: { lut: { id: L.id, amount: 1 } } } });
await R(pa, 'add_clip', { media: I.id, lane: 'main' });
await R(pa, 'add_clip', { media: A.id, lane: 'audio', start: 0, in: 2, out: 5 });
await R(pa, 'add_text', { text: 'PACKED', start: 0, duration: 5, style: { font: font.family, size: 160 } });
const pid = await pa.evaluate(async () => { await flushSave(); return P.id; });
const dur = await pa.evaluate(() => total());
const T = [1, 2.9, 4]; // the graded video with the title, its last frames, the photo
const orig = []; for (const t of T) orig.push(await shot(pa, t));
check('the three frames differ (title and graded video, then the photo)', await diff(pa, orig[0], orig[2]) > 10);

// ---- package it (the MCP command): entries, stored, manifest, checksums ----
const whole = await R(pa, 'package_project', {});
const zf = `${HOME}/exports/${whole.file}`;
const Z = JSON.parse(py(ZIPINFO, zf)), man = Z.manifest;
const want = ['manifest.json', 'project.json', `media/${V.id}.mp4`, `media/${I.id}.png`, `media/${A.id}.mp3`, `fonts/${font.file}`, `luts/${L.id}.cube`].sort();
check('the package holds the project, its 3 files, the font, the LUT and a manifest, nothing else', JSON.stringify([...Z.names].sort()) === JSON.stringify(want), Z.names.join(' '));
check('every entry is stored, not recompressed', Z.stored);
check('the manifest lists each file with its size and SHA-256', man.format === 'cutroom-package' && man.media.length === 3 && [...man.media, ...man.fonts, ...man.luts].every(r => Z.sha[r.file] === r.sha256 && Z.sizes[r.file] === r.size));
check('whole files are the library\'s bytes', man.media.every(r => r.size === statSync(`${HOME}/media/${r.id}${r.file.slice(r.file.lastIndexOf('.'))}`).size));
check('the manifest names the font family and the LUT', man.fonts[0]?.family === font.family && man.luts[0]?.id === L.id && man.project.name === 'Package test', JSON.stringify(man.fonts));
check('project.json is the saved project', JSON.stringify(Z.project) === JSON.stringify(await api(B, `/api/projects/${pid}`)));
check('the result says each file went in whole', whole.items.length === 3 && whole.items.every(x => x.how === 'whole') && /3 files/.test(whole.summary), whole.summary);

// ---- open it in the empty library: dropped on the window ----
const pb = await open(B2);
const pkg = readFileSync(zf).toString('base64');
await pb.evaluate(async s => {
  const f = new File([await (await fetch(`data:application/zip;base64,${s}`)).blob()], 'Package test.cutroom'), dt = new DataTransfer();
  dt.items.add(f);
  dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, pkg);
await pb.waitForFunction(() => P.name === 'Package test' && M.size === 3 && [...M.values()].every(m => m.ready), null, { timeout: 120000 });
const lib2 = await api(B2, '/api/media');
check('dropping the .cutroom fills the empty library with its 3 files', lib2.length === 3 && lib2.every(m => m.sha256), lib2.map(m => m.name).join(', '));
check('a whole sound-library item keeps its pack, sound effect, licence and source', lib2.some(m => m.pack === 'test-pack-tone' && m.sfx === 'test-sfx' && m.licence === 'CC0' && m.src), JSON.stringify(lib2.map(m => [m.name, m.pack])));
check('its font and LUT came along', (await api(B2, '/api/fonts')).some(f => f.family === font.family) && (await api(B2, '/api/luts')).some(x => x.id === L.id));
check('the opened project points only at the new library', await pb.evaluate(() => LANES.every(Ln => P[Ln.key].every(c => !c.media || M.has(c.media)))));
check('durations are equal', Math.abs(await pb.evaluate(() => total()) - dur) < 1e-6, `${dur}`);
for (const [i, t] of T.entries()) {
  const d = await diff(pb, orig[i], await shot(pb, t));
  check(`the frame at ${t} s renders the same (within 2 levels)`, d <= 2, d.toFixed(2));
}

// ---- open it again (the MCP command, by path): identical files are reused ----
const again = await R(pb, 'open_package', { path: zf });
check('opening it again reuses every file already there', again.reused === 3 && (await api(B2, '/api/media')).length === 3 && (await api(B2, '/api/projects')).length >= 2, JSON.stringify({ media: again.media, reused: again.reused }));

// ---- trim to what is used ----
const trim = await R(pa, 'package_project', { trim: true });
const ZT = JSON.parse(py(ZIPINFO, `${HOME}/exports/${trim.file}`)), mt = ZT.manifest;
const vcut = mt.media.find(r => r.cut?.from === V.id), acut = mt.media.find(r => r.cut?.from === A.id);
check('trim: the video is cut by stream copy at the keyframe before its handle', vcut?.cut.how === 'copy' && vcut.cut.at === 4 && vcut.size < statSync(`${HOME}/media/${V.id}.mp4`).size * 0.6, JSON.stringify(vcut?.cut));
check('trim: the MP3 is re-encoded (its cut would drift), and smaller', acut?.cut.how === 'encode' && acut.file.endsWith('.m4a') && acut.size < statSync(`${HOME}/media/${A.id}.mp3`).size, JSON.stringify(acut?.cut));
check('trim: the photo goes in whole', mt.media.some(r => r.id === I.id && !r.cut));
check('trim: the result says which', trim.items.find(x => x.name === 'clip.mp4')?.how === 'copy' && trim.items.find(x => x.name === 'tone.mp3')?.how === 'encode' && /stream copy/.test(trim.summary) && /re-encoded/.test(trim.summary), trim.summary);
check('trim: clip in/out move with the cut', ZT.project.main[0].in === 1 && ZT.project.main[0].out === 4 && ZT.project.audio[0].in === 1 && ZT.project.audio[0].out === 4, JSON.stringify([ZT.project.main[0].in, ZT.project.main[0].out, ZT.project.audio[0].in]));
check('trim: the package is smaller', statSync(`${HOME}/exports/${trim.file}`).size < statSync(zf).size * 0.7, `${statSync(`${HOME}/exports/${trim.file}`).size} vs ${statSync(zf).size}`);
const n2 = (await api(B2, '/api/media')).length;
await pb.click('#btnProjects');
await pb.setInputFiles('#pkgIn', `${HOME}/exports/${trim.file}`);
await pb.waitForFunction(n => M.size === n + 2 && [...M.values()].every(m => m.ready) && P.audio[0]?.in === 1, n2, { timeout: 120000 });
check('trim: Open package… brings in the two cut files (the photo is reused)', (await api(B2, '/api/media')).length === n2 + 2);
check('trim: durations are equal', Math.abs(await pb.evaluate(() => total()) - dur) < 1e-6);
for (const [i, t] of T.entries()) {
  const d = await diff(pb, orig[i], await shot(pb, t));
  check(`trim: the frame at ${t} s still renders the same (within 2 levels)`, d <= 2, d.toFixed(2));
}
const lib2t = await api(B2, '/api/media'), am = lib2t.find(m => m.name.startsWith('tone') && m.name.endsWith('.m4a'));
check('trim: the cut sound keeps its licence and source but is not the pack sound or sound effect (else adding those again gives the fragment)', am && am.licence === 'CC0' && am.src && !('pack' in am) && !('sfx' in am) && !('pack' in acut) && !('sfx' in acut), JSON.stringify(am ? { pack: am.pack, sfx: am.sfx, licence: am.licence } : lib2t.map(m => m.name)));
check('trim: the cut sound covers its used range', am && am.duration >= 4 - 0.05, `${am?.duration}`);
const c0 = click(`${HOME}/media/${A.id}.mp3`), c1 = am && click(`${HOME2}/media/${am.file}`);
check('trim: the cut sound is where the clip expects it (the click 1 s earlier, within 1 ms)', c0 && c1 != null && Math.abs(c0 - 1 - c1) < 0.001, `${c0?.toFixed(5)} -> ${c1?.toFixed(5)}`);

// ---- zip-slip and junk: refused, nothing written outside ----
const bad = (names, out) => py(`import zipfile, json, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('manifest.json', json.dumps({'format': 'cutroom-package', 'v': 1, 'media': [], 'fonts': [], 'luts': []}))
    z.writestr('project.json', '{}')
    for n in sys.argv[2:]: z.writestr(n, 'x')`, out, ...names);
const evil = [['../evil.txt'], ['media/../../evil.mp4'], ['/tmp/evil-abs.txt']];
for (const [i, names] of evil.entries()) {
  const f = `${FX}/evil${i}.cutroom`; bad(names, f);
  const { job } = await (await fetch(`${B2}/api/package/open?name=evil.cutroom`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: readFileSync(f) })).json();
  let j; for (let k = 0; k < 40 && (j = await api(B2, `/api/jobs/${job}`)).state === 'running'; k++) await sleep(250);
  check(`a zip holding ${names[0]} is refused`, j.state === 'error' && /not a Cutroom package/.test(j.error) && !existsSync(`${HOME2}/../evil.txt`) && !existsSync(`${SCR}/evil.mp4`), j.error);
}
const junk = `${FX}/junk.cutroom`; writeFileSync(junk, 'not a zip');
let jerr = ''; try { await R(pb, 'open_package', { path: junk }); } catch (e) { jerr = e.message; }
check('a file that is not a zip says so', /not a zip/.test(jerr), jerr);

// ---- the dialogs, both motion modes ----
mkdirSync(`${SCR}/pkg-shots`, { recursive: true });
for (const rm of ['no-preference', 'reduce']) {
  const p = await open(B, rm);
  await p.evaluate(id => openProject(id), pid);
  await p.click('#btnProjects');
  await p.waitForSelector(`.pcard [data-pkg="${pid}"]`, { state: 'attached' });
  await p.hover(`.pcard:has([data-pkg="${pid}"])`);
  await p.click(`[data-pkg="${pid}"]`);
  await p.waitForSelector('#pkGo');
  await p.check('#pkTrim');
  await p.click('#pkGo');
  await p.waitForSelector('#pkDone [data-reveal]', { timeout: 120000 });
  const txt = await p.textContent('#pkStatus');
  check(`${rm}: the card's Package dialog packages it and says how`, /^Saved Package test.*\.cutroom .* MB\) in .*stream copy/.test(txt), txt);
  await p.screenshot({ path: `${SCR}/pkg-shots/package-${rm}.png` });
  await p.click('[data-close]');
  await p.click('#btnExport');
  check(`${rm}: the Export dialog offers Package project…`, await p.locator(`#exActions [data-pkg="${pid}"]`).isVisible());
  await p.click('#exActions [data-close]');
  await p.click('#btnProjects');
  check(`${rm}: Projects offers Open package…`, await p.locator('label:has(#pkgIn)').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await p.screenshot({ path: `${SCR}/pkg-shots/projects-${rm}.png` });
  const ticks = await p.evaluate(() => new Promise(r => { let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); }));
  check(`${rm}: the page keeps drawing`, ticks === 10);
  await p.context().close();
}
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));

await b.close();
srv2.kill();
rmSync(HOME2, { recursive: true, force: true });
rmSync(FX, { recursive: true, force: true });
const fails = res.filter(x => !x).length;
console.log(`\n${res.length - fails}/${res.length} passed`);
process.exit(fails ? 1 : 0);
