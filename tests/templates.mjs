// Templates you make and share: a project with a video (LUT graded), a photo, a sticker, two texts (one in an imported
// font), an effect and a synthesized sound -> Save as template (name, a placeholder, one text editable, the sticker kept);
// the gallery shows it with a poster and a preview that plays while pointed at (rendered once on slates, which then go);
// filling by drag and by selection, the part of a longer clip a slot uses (the middle, then slid), a new text: the project
// keeps the template's timing with the new media and words; REMOTE list_templates / use_template, a starter too; Share
// writes a .cutroom-template (no slot media) that imports into an EMPTY library (a second server) and works there; bad
// zips are refused; the dialogs in both motion modes, no page errors.
//   CUTROOM_HOME=<scratch lib> CUTROOM_PORT=4751 python3 -I server.py, then
//   B=http://127.0.0.1:4751 CUTROOM_HOME=<same lib> CUTROOM_SCRATCH=<scratch dir> node templates.mjs   (its own server on port+1, or P2)
import { PYTHON, execNiceSync, spawnManaged, stopChild } from './runtime.mjs';
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const B = process.env.B || 'http://127.0.0.1:4751', HOME = process.env.CUTROOM_HOME, SCR = process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch';
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
const py = (code, ...args) => execFileSync(PYTHON, ['-X', 'utf8', '-I', '-c', code, ...args], { env, encoding: 'utf8' });
const ff = (...a) => execNiceSync('ffmpeg', [ '-v', 'error', '-y', ...a], { env });
const probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f], { env, encoding: 'utf8' }));

// ---- fixtures ----
const FX = mkdtempSync(`${SCR}/tpl-fixtures-`);
ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${FX}/source.mp4`);
ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=12,hue=h=120', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${FX}/longer.mp4`);
ff('-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=10,hue=h=240', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${FX}/third.mp4`);
ff('-f', 'lavfi', '-i', 'testsrc=s=480x320', '-frames:v', '1', `${FX}/photo.png`);
ff('-f', 'lavfi', '-i', 'smptebars=s=480x320', '-frames:v', '1', `${FX}/photo2.png`);
ff('-f', 'lavfi', '-i', 'color=c=0xff3d7f:s=200x200,format=rgba,geq=r=255:g=61:b=127:a=if(lt(hypot(X-100\\,Y-100)\\,80)\\,255\\,0)', '-frames:v', '1', `${FX}/sticker.png`);
const corners = []; for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) corners.push(`${b} ${g} ${r}`);
writeFileSync(`${FX}/swap.cube`, `TITLE "swap"\nLUT_3D_SIZE 2\n${corners.join('\n')}\n`);
const imp = (base, path) => api(base, '/api/import_path', { path });
const ready = async (base, ids) => { for (let i = 0; i < 120; i++) { const m = await api(base, '/api/media'); if (ids.every(id => m.find(y => y.id === id)?.ready)) return; await sleep(500); } };
mkdirSync(`${SCR}/tpl-shots`, { recursive: true });
const media = {};
for (const n of ['source.mp4', 'longer.mp4', 'third.mp4', 'photo.png', 'photo2.png', 'sticker.png']) media[n] = await imp(B, `${FX}/${n}`);
await ready(B, Object.values(media).map(m => m.id));
const font = await (await fetch(`${B}/api/fonts?name=Template%20Face.ttf`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: readFileSync(`${ROOT}/web/fonts/BebasNeue.ttf`) })).json();
const L = await api(B, '/api/luts', { name: 'swap.cube', text: readFileSync(`${FX}/swap.cube`, 'utf8') });
check('the sticker is a transparent picture (kept by default)', media['sticker.png'].trans === true);

// ---- the second server: an empty library ----
const HOME2 = mkdtempSync(`${SCR}/lib2-templates-empty-`);
const srv2 = spawnManaged(PYTHON, ['-X', 'utf8', '-I', `${ROOT}/server.py`], { env: { ...env, CUTROOM_HOME: HOME2, CUTROOM_PORT: String(PORT2) }, stdio: 'ignore' });
let b;
try {
let gone = false; srv2.on('exit', () => { gone = true; });
for (let i = 0; i < 60 && !gone; i++) { try { await api(B2, '/api/ping'); break; } catch { await sleep(500); } }
await sleep(1000);
if (gone || (await api(B2, '/api/media')).length) { srv2.kill(); throw new Error(`port ${PORT2} is taken: set P2 to a free port`); }

b = await browser.launch();
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
const posterShown = (page, id) => page.waitForFunction(id => { const i = document.querySelector(`.tplcard[data-tcard="${id}"] img`); return i && i.complete && i.naturalWidth > 0; }, id, { timeout: 240000 }).then(() => true, () => false);
const plays = async (page, id) => { // pointed at: its preview plays, moved away: it stops
  await page.hover(`.tplcard[data-tcard="${id}"] .pthumb`);
  const on = await page.waitForFunction(id => { const v = document.querySelector(`.tplcard[data-tcard="${id}"] video`); return v && !v.paused && v.currentTime > 0.3 && getComputedStyle(v).opacity === '1'; }, id, { timeout: 15000 }).then(() => true, () => false);
  await page.mouse.move(5, 5);
  const off = await page.waitForFunction(id => document.querySelector(`.tplcard[data-tcard="${id}"] video`)?.paused, id, { timeout: 5000 }).then(() => true, () => false);
  return on && off;
};

// ---- the source project ----
for (const t of await api(B, '/api/templates')) if (t.name === 'Promo test') await api(B, `/api/templates/${t.id}/trash`, {}); // (an earlier run's: it runs again on the same library)
const pa = await open(B, 'no-preference');
await R(pa, 'new_project', { ratio: '9:16', name: 'Template source' });
const cv = await R(pa, 'add_clip', { media: media['source.mp4'].id, lane: 'main', in: 2, out: 5 });
await R(pa, 'update_clip', { id: cv.id, set: { grade: { lut: { id: L.id, amount: 1 } } } });
await R(pa, 'add_clip', { media: media['photo.png'].id, lane: 'main' });
await R(pa, 'add_clip', { media: media['sticker.png'].id, lane: 'overlay', start: 0.5 });
await R(pa, 'add_text', { text: 'BIG SALE', start: 0, duration: 4, style: { font: font.family, size: 150 } });
await R(pa, 'add_text', { text: 'Fixed line', start: 4, duration: 2, y: 0.8 });
await R(pa, 'add_effect', { type: 'vignette', start: 0, duration: 6 });
await R(pa, 'add_sound', { name: 'whoosh', at: 2.9 });
await pa.evaluate(() => flushSave());
const orig = await pa.evaluate(() => { packMain(); return { P: structuredClone(P), dur: total() }; });

// ---- Save as template (the dialog), pressed while a starter's preview is being made (its plan borrows the open project) ----
if (existsSync(`${HOME}/templates`)) for (const f of readdirSync(`${HOME}/templates`)) if (/^cafe0000a\d{3}\.(jpg|mp4)$/.test(f)) unlinkSync(`${HOME}/templates/${f}`); // (as on a fresh library)
await pa.click('#btnTemplates');
await pa.waitForFunction(() => S.hold && TPL.busy, null, { polling: 'raf', timeout: 120000 });
check('Save is pressed while a starter preview holds a borrowed project', await pa.evaluate(() => { const h = S.hold && P.name !== 'Template source'; document.querySelector('[data-savetpl]').click(); return h; }));
await pa.waitForSelector('#tsName');
await pa.fill('#tsName', 'Promo test');
check('Save as template: the sticker defaults to "Keep in template", the footage to slots', await pa.evaluate(([s, v, i]) => [s, v, i].map(id => document.querySelector(`[data-tskeep="${id}"]`)?.value).join() === 'keep,slot,slot', [media['sticker.png'].id, media['source.mp4'].id, media['photo.png'].id]));
await pa.fill(`[data-tslabel="${media['source.mp4'].id}"]`, 'Hero shot');
await pa.uncheck(`[data-tstext="${orig.P.text[1].id}"]`);
await pa.screenshot({ path: `${SCR}/tpl-shots/save-dialog.png` });
await pa.click('[data-savetplgo]');
await pa.waitForSelector('.tplcard');
const T = (await api(B, '/api/templates')).find(t => t.name === 'Promo test');
check('the template is saved: 2 slots (the video\'s 3 s, the photo), the placeholder, one editable text', T && T.slots.length === 2 && T.slots[0].kind === 'video' && T.slots[0].need === 3 && T.slots[0].label === 'Hero shot' && T.slots[1].kind === 'image' && T.texts.length === 1 && T.texts[0].id === orig.P.text[0].id, JSON.stringify(T?.slots));
check('the slot\'s clip starts at 0 of its used part; the sticker is kept; the sound by name', T.project.main[0].media === 'slot:0' && T.project.main[0].in === 0 && T.project.main[0].out === 3 && T.project.overlay[0].media === media['sticker.png'].id && T.project.audio[0].media === 'sfx:whoosh', JSON.stringify([T.project.main[0], T.project.audio[0].media]));
const starters = (await api(B, '/api/templates')).filter(t => t.starter);
check('4 starters ship with Cutroom', starters.length === 4 && ['Vlog intro', 'Product showcase', 'Podcast clip', 'Travel montage'].every(n => starters.some(t => t.name === n)), starters.map(t => t.name).join(', '));

// ---- the gallery: poster, preview, slates gone ----
check('the gallery shows its poster (made once, after the starters\')', await posterShown(pa, T.id));
const T1 = (await api(B, '/api/templates')).find(t => t.id === T.id);
const pr = probe(`${HOME}/templates/${T.id}.mp4`);
check('its preview: the whole template at 270×480', T1.poster && T1.preview && pr.streams[0].width === 270 && pr.streams[0].height === 480 && Math.abs(+pr.format.duration - orig.dur) < 0.1, `${pr.streams[0].width}x${pr.streams[0].height} ${pr.format.duration} vs ${orig.dur}`);
const pj = await fetch(`${B}/api/templates/${T.id}/poster.jpg`);
check('its poster is a JPEG', pj.ok && (await pj.arrayBuffer()).byteLength > 1000 && /jpeg/.test(pj.headers.get('content-type')));
check('the slates are gone from the library and were never listed', !readdirSync(`${HOME}/media`).filter(f => f.endsWith('.json')).some(f => JSON.parse(readFileSync(`${HOME}/media/${f}`, 'utf8')).slate) && !(await api(B, '/api/media')).some(m => m.slate));
for (const s of starters) check(`starter "${s.name}" gets its poster too`, await posterShown(pa, s.id));
check('no-preference: pointing at a card plays its preview, leaving stops it', await plays(pa, T.id));
await pa.screenshot({ path: `${SCR}/tpl-shots/gallery-no-preference.png` });

// ---- fill: by drag, the part used, by selection, a text ----
await pa.click(`[data-tpl="${T.id}"]`);
await pa.waitForSelector('#tslots .tslot');
await pa.dragAndDrop(`[data-tlm="${media['longer.mp4'].id}"]`, '[data-tslot="0"]');
const say0 = () => pa.textContent('[data-tslot="0"] .tuse small');
check('a drag fills slot 1; a 12 s clip gives its middle 3 s', await pa.evaluate(id => TPL.fill.pick[0] === id, media['longer.mp4'].id) && /uses 4\.5 s–7\.5 s of 12\.0 s/.test(await say0()), await say0());
await pa.fill('[data-tstart="0"]', '1');
check('the slider picks another part', /uses 1\.0 s–4\.0 s/.test(await say0()), await say0());
await pa.click('[data-tclear="0"]');
await pa.click(`[data-tlm="${media['longer.mp4'].id}"]`);
await pa.click(`[data-tlm="${media['photo2.png'].id}"]`);
check('selected items show their order', (await pa.textContent(`[data-tlm="${media['photo2.png'].id}"] i`)) === '2');
await pa.click('[data-tplfill]');
check('Fill from selection: the items in the order picked', await pa.evaluate(ids => TPL.fill.pick.join() === ids.join(), [media['longer.mp4'].id, media['photo2.png'].id]));
await pa.fill('[data-tstart="0"]', '1');
check('only the editable text is offered, in its font', (await pa.locator('[data-ttext]').count()) === 1 && (await pa.evaluate(() => getComputedStyle(document.querySelector('[data-ttext]')).fontFamily)).includes(font.family));
await pa.fill('[data-ttext]', 'NEW PRICE');
await pa.screenshot({ path: `${SCR}/tpl-shots/fill-no-preference.png` });
await pa.click('[data-usetpl]');
await pa.waitForFunction(() => P.name.startsWith('Promo test'));
const made = await pa.evaluate(() => { packMain(); return { P: structuredClone(P), dur: total() }; });
const same = (a, b, keys) => keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
check('the project keeps the template\'s timing', Math.abs(made.dur - orig.dur) < 1e-6 && ['main', 'overlay', 'audio', 'text', 'fx'].every(Ln => made.P[Ln].length === orig.P[Ln].length && made.P[Ln].every((c, i) => Math.abs(c.start - orig.P[Ln][i].start) < 1e-6)), `${made.dur} vs ${orig.dur}`);
check('slot 1 has the new video from 1 s (3 s of it), graded like the original', made.P.main[0].media === media['longer.mp4'].id && made.P.main[0].in === 1 && made.P.main[0].out === 4 && made.P.main[0].grade?.lut?.id === L.id, JSON.stringify([made.P.main[0].in, made.P.main[0].out]));
check('slot 2 has the new photo for as long', made.P.main[1].media === media['photo2.png'].id && made.P.main[1].out - made.P.main[1].in === orig.P.main[1].out - orig.P.main[1].in);
check('the edited text has the new words in the same style; the other is as it was', made.P.text[0].text === 'NEW PRICE' && same(made.P.text[0], orig.P.text[0], ['style', 'x', 'y', 'dur']) && made.P.text[1].text === 'Fixed line');
check('the sticker, the effect and the sound are as they were', made.P.overlay[0].media === media['sticker.png'].id && same(made.P.fx[0], orig.P.fx[0], ['fx', 'start', 'dur']) && made.P.audio[0].media === orig.P.audio[0].media);
const snap = (await R(pa, 'snapshot', { t: 1, max: 320 })).image;
check('the new project renders (export engine)', snap?.length > 1000);

// ---- REMOTE / MCP ----
const list = await R(pa, 'list_templates');
const lt = list.find(t => t.id === T.id);
check('list_templates: slots with kind and length, the editable text', lt && lt.slots[0].need === 3 && lt.slots[0].label === 'Hero shot' && lt.texts.length === 1 && lt.texts[0].text === 'BIG SALE' && list.filter(t => t.starter).length === 4, JSON.stringify(lt));
const u = await R(pa, 'use_template', { id: 'Promo test', media: ['third.mp4', media['photo.png'].id], texts: { 1: 'VIA CLAUDE' } });
check('use_template: by name, media by name or id, text by number; a 10 s clip gives its middle', await pa.evaluate(() => P.text[0].text === 'VIA CLAUDE') && u.slots[0]?.media === 'third.mp4' && u.slots[0].in === 3.5 && u.slots[0].out === 6.5, JSON.stringify(u.slots));
const vlog = starters.find(t => t.name === 'Vlog intro');
await R(pa, 'use_template', { id: vlog.id, media: ['source.mp4', 'longer.mp4', 'third.mp4'], texts: { 1: 'Our trip' } });
const sv = await pa.evaluate(() => { packMain(); return { dur: total(), sounds: P.audio.map(c => M.get(c.media)?.sfx), text: P.text[0].text }; });
check('a starter: its whoosh and swish are made on this Mac, the timing is its own', Math.abs(sv.dur - vlog.dur) < 1e-6 && sv.sounds.join() === 'whoosh,swish' && sv.text === 'Our trip', JSON.stringify(sv));
let err = ''; try { await R(pa, 'use_template', { id: T.id, media: [] }); } catch (e) { err = e.message; }
check('use_template without media for a slot says which', /fill slot 1/.test(err), err);

// ---- share and import into an empty library ----
await pa.click('#btnTemplates');
await pa.waitForSelector(`.tplcard[data-tcard="${T.id}"]`);
await pa.hover(`.tplcard[data-tcard="${T.id}"]`);
await pa.click(`[data-tplshare="${T.id}"]`);
await pa.waitForSelector('#tplStatus [data-reveal]');
const file = await pa.getAttribute('#tplStatus [data-reveal]', 'data-reveal');
const zf = `${HOME}/exports/${file}`;
const Z = JSON.parse(py(`import json, sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1]); t = json.loads(z.read('template.json'))
print(json.dumps({'names': sorted(z.namelist()), 't': t, 'ok': all(hashlib.sha256(z.read(r['file'])).hexdigest() == r['sha256'] for r in t['files'])}))`, zf));
const want = ['template.json', 'poster.jpg', 'preview.mp4', `media/${media['sticker.png'].id}.png`, `fonts/${font.file}`, `luts/${L.id}.cube`].sort();
check('Share: a .cutroom-template with the template, poster, preview, the kept sticker, the font and the LUT', file.endsWith('.cutroom-template') && JSON.stringify(Z.names) === JSON.stringify(want), Z.names.join(' '));
check('it holds no slot media, and every file matches its checksum', !Z.names.some(n => n.includes(media['source.mp4'].id) || n.includes(media['photo.png'].id)) && Z.ok && Z.t.format === 'cutroom-template');
const pb = await open(B2, 'reduce');
await pb.click('#btnTemplates');
await pb.setInputFiles('#tplIn', zf);
await pb.waitForFunction(() => tplCache.some(t => t.name === 'Promo test'), null, { timeout: 30000 });
const T2 = (await api(B2, '/api/templates')).find(t => t.name === 'Promo test'), lib2 = await api(B2, '/api/media');
check('imported into the empty library: the template, with its poster and preview (not made again)', T2 && T2.poster && T2.preview && T2.id !== T.id && await posterShown(pb, T2.id));
check('its sticker came along and the template points at it', lib2.length === 1 && lib2[0].name === 'sticker.png' && T2.project.overlay[0].media === lib2[0].id);
check('its font and LUT came along', (await api(B2, '/api/fonts')).some(f => f.family === T2.project.text[0].style.font) && (await api(B2, '/api/luts')).some(x => x.id === T2.project.main[0].grade.lut.id));
const m2 = {}; for (const n of ['longer.mp4', 'photo2.png']) m2[n] = await imp(B2, `${FX}/${n}`);
await ready(B2, Object.values(m2).map(m => m.id));
await R(pb, 'media');
await R(pb, 'use_template', { id: T2.id, media: [m2['longer.mp4'].id, m2['photo2.png'].id], texts: { 1: 'ELSEWHERE' } });
const p2 = await pb.evaluate(() => { packMain(); return { dur: total(), text: P.text[0].text, in: P.main[0].in, sfx: M.get(P.audio[0].media)?.sfx }; });
check('used there: same timing, the middle of the clip, its whoosh made there', Math.abs(p2.dur - orig.dur) < 1e-6 && p2.text === 'ELSEWHERE' && p2.in === 4.5 && p2.sfx === 'whoosh', JSON.stringify(p2));
check('and it renders there (export engine)', (await R(pb, 'snapshot', { t: 1, max: 320 })).image?.length > 1000);

// ---- bad files: refused, nothing written outside ----
const bad = (names, out, t = {}) => py(`import zipfile, json, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('template.json', json.dumps({'format': 'cutroom-template', 'v': 2, 'name': 'Evil', 'slots': [], 'project': {}, 'files': [], **json.loads(sys.argv[2])}))
    for n in sys.argv[3:]: z.writestr(n, b'x' * (5 << 20) if n == 'poster.jpg' else 'x')`, out, JSON.stringify(t), ...names);
const up = async f => { const r = await fetch(`${B2}/api/templates/import?name=x.cutroom-template`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: readFileSync(f) }); return [r.status, (await r.json()).error]; };
const n0 = (await api(B2, "/api/templates")).length, k0 = (await api(B2, "/api/media")).filter(m => !m.sfx).length; // (the starters' previews, made meanwhile, bring their synthesized sounds)
for (const [i, names] of [['../evil.txt'], ['media/../../evil.png'], ['/tmp/evil-abs.txt'], ['media/0123456789ab.png', 'project.json']].entries()) {
  const f = `${FX}/evil${i}.cutroom-template`; bad(names, f);
  const [st, e] = await up(f);
  check(`a zip holding ${names.at(-1)} is refused`, st === 400 && /not a Cutroom template/.test(e) && !existsSync(`${HOME2}/../evil.txt`) && !existsSync(`${SCR}/evil.png`), e);
}
{ const f = `${FX}/big.cutroom-template`; bad(['poster.jpg'], f); const [st, e] = await up(f); check('an entry over its size cap is refused', st === 400 && /not a Cutroom template/.test(e), e); }
{ const f = `${FX}/sum.cutroom-template`; bad(['fonts/0123456789ab.ttf'], f, { files: [{ file: 'fonts/0123456789ab.ttf', id: '0123456789ab', sha256: '0'.repeat(64) }] }); const [st, e] = await up(f); check('a file that does not match its checksum is refused', st === 400 && /damaged/.test(e), e); }
{ const f = `${FX}/junk.cutroom-template`; writeFileSync(f, 'not a zip'); const [st, e] = await up(f); check('a file that is not a zip says so', st === 400 && /not a zip/.test(e), e); }
check('nothing was added by the bad files', (await api(B2, '/api/templates')).length === n0 && (await api(B2, "/api/media")).filter(m => !m.sfx).length === k0);

// ---- both motion modes ----
for (const rm of ['no-preference', 'reduce']) {
  const p = await open(B, rm);
  await p.click('#btnTemplates');
  check(`${rm}: the gallery lists the template with its poster`, await posterShown(p, T.id));
  check(`${rm}: its preview plays while pointed at`, await plays(p, T.id));
  await p.screenshot({ path: `${SCR}/tpl-shots/gallery-${rm}.png` });
  await p.click(`[data-tpl="${T.id}"]`);
  await p.click(`[data-tlm="${media['longer.mp4'].id}"]`);
  await p.click('[data-tplfill]');
  check(`${rm}: the fill dialog shows the part used`, /uses 4\.5 s–7\.5 s/.test(await p.textContent('[data-tslot="0"] .tuse small')));
  await p.screenshot({ path: `${SCR}/tpl-shots/fill-${rm}.png` });
  const ticks = await p.evaluate(() => new Promise(r => { let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); }));
  check(`${rm}: the page keeps drawing`, ticks === 10);
  await p.context().close();
}
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));

} finally {
  try { await b?.close(); } finally { await stopChild(srv2); }
}
const n = res.filter(Boolean).length;
console.log(`\n${n}/${res.length} passed`);
process.exit(n === res.length ? 0 : 1);
