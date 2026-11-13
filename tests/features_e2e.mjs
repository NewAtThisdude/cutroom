// The features added 2026-11-07/08, end to end in headless WebKit: tracks (drag between them, hide, mute, lock),
// SRT import/export, relink, colour grading (HSL, curves, wheels, .cube LUTs) and scopes, keyframed masks and
// filters, compound clips, multicam, beauty, body effects. Each section uses real mouse/keyboard input where the user
// would, and checks the export (still frames / files) as well as the preview.   node features_e2e.mjs [section]
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const LIB = process.env.CUTROOM_HOME || `${os.homedir()}/Movies/Cutroom`; // the library the server under test uses
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2], EXP = `${LIB}/exports`;
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const before = { l: new Set((await get('/api/luts')).map(x => x.id)), p: new Set((await get('/api/projects')).map(x => x.id)), m: new Set((await get('/api/media')).map(x => x.id)), e: new Set(fs.readdirSync(EXP)) };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-feat-`);
const gen = (name, args) => { const f = `${tmp}/${name}`; execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return f; };
const imp = async f => (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json());
const V = await imp(gen('feat-v.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']));
const RED = await imp(gen('feat-red.png', ['-f', 'lavfi', '-i', 'color=c=red:s=320x320:d=1', '-frames:v', '1']));
const BLUE = await imp(gen('feat-blue.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=320x320:d=1', '-frames:v', '1']));
const TONE = await imp(gen('feat-tone.wav', ['-f', 'lavfi', '-i', 'sine=f=300:d=6']));
const MEDIA = { V, RED, BLUE, TONE };

const b = await browser.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), Object.values(MEDIA).map(m => m.id), { timeout: 60000 });
const fresh = name => ev(([name, M0]) => { setProject(newProject('16:9')); P.name = `${name} (scratch)`; window.MD = M0; S.t = 0; renderAll(); return P.id; }, [name, MEDIA]);
const run = name => !only || name.includes(only);
const box = async sel => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded().catch(() => {}); return l.boundingBox(); };
const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 10, from.y + (to.y - from.y) * i / 10); await page.mouse.up(); await page.waitForTimeout(100); };
const still = (t, max = 320) => ev(async ([t, max]) => { const r = await REMOTE.snapshot({ t, max }); const i = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.image}`)).blob()); const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); return { w: i.width, h: i.height, px: [...g.getImageData(0, 0, i.width, i.height).data] }; }, [t, max]);
const at = (img, fx, fy) => { const i = (Math.round(fy * (img.h - 1)) * img.w + Math.round(fx * (img.w - 1))) * 4; return img.px.slice(i, i + 3); };

try { // the tidy below runs even if a section throws
// ---------- tracks ----------
if (run('tracks')) {
  await fresh('Tracks');
  const ids = await ev(() => { addMedia(MD.V.id, 'main'); addMedia(MD.RED.id, 'overlay', 0); const a = P.overlay.at(-1); Object.assign(a, { fit: 'fit', scale: 0.5 }); addMedia(MD.BLUE.id, 'overlay', 0); const b = P.overlay.at(-1); Object.assign(b, { fit: 'fit', scale: 0.5 }); S.sel = null; renderAll(); return [a.id, b.id]; });
  const rowOfId = id => ev(id => rows('overlay').row.get(id) || 0, id);
  check('two overlapping overlays sit on two tracks; the later one on top', await rowOfId(ids[0]) === 0 && await rowOfId(ids[1]) === 1 && await ev(() => document.querySelectorAll('#heads .th').length) >= 7);
  let img = await still(1);
  check('the top track draws on top (blue over red)', at(img, 0.5, 0.5)[2] > 200 && at(img, 0.5, 0.5)[0] < 60, at(img, 0.5, 0.5));
  const red = await box(`.clip[data-id="${ids[0]}"]`), lane = await box('#lane-overlay');
  await drag({ x: red.x + red.width / 2, y: red.y + red.height / 2 }, { x: red.x + red.width / 2, y: lane.y + lane.height + 20 }); // below the top track: a new one
  check('dragging the red clip down puts it on a new top track', await rowOfId(ids[0]) === 2, await rowOfId(ids[0]));
  img = await still(1);
  check('...and now it draws on top (red over blue), in the export too', at(img, 0.5, 0.5)[0] > 200 && at(img, 0.5, 0.5)[2] < 60, at(img, 0.5, 0.5));
  await page.click('[data-tk="overlay:2"]');
  img = await still(1);
  check('hiding its track hides the red clip in the export', at(img, 0.5, 0.5)[2] > 200 && at(img, 0.5, 0.5)[0] < 60, at(img, 0.5, 0.5));
  const pv = await ev(async () => { S.t = 1; await waitFrame(); return hits.map(h => h.id); });
  check('...and in the preview', !pv.includes(ids[0]) && pv.includes(ids[1]));
  await page.click('[data-tk="overlay:2"]');
  await page.click('[data-lk="overlay:1"]');
  const b1 = await box(`.clip[data-id="${ids[1]}"]`);
  await page.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
  check('a clip on a locked track can\'t be selected', await ev(id => S.sel?.id !== id, ids[1]));
  await page.keyboard.press('Meta+a');
  check('⌘A leaves the locked track out', await ev(id => !selection().some(([c]) => c.id === id), ids[1]));
  await page.keyboard.press('Escape');
  await page.click('[data-tk="audio:0"]');
  const plan = await ev(async () => { addMedia(MD.TONE.id, 'audio', 0); const p = await buildPlan(320, 180, 'fast', 'x', false); return p.audio.length; });
  check('a muted audio track leaves the export', plan === 0, plan);
  const undone = await ev(() => { const n = undo.length; for (let i = 0; i < 4; i++) restore(undo, redo); return !P.tracks['audio:0'] && n >= 4; });
  check('undo walks the track changes back', undone);
  const mcp = await ev(async id => { await REMOTE.set_track({ lane: 'overlay', track: 0, hidden: true }); const r = await REMOTE.update_clip({ id, set: { track: 3 } }); return [P.tracks['overlay:0']?.off, r.track]; }, ids[1]);
  check('MCP set_track and update_clip track', mcp[0] === true && mcp[1] >= 3, JSON.stringify(mcp));
}

// ---------- subtitles ----------
if (run('srt')) {
  await fresh('Subtitles');
  await ev(() => { addMedia(MD.V.id, 'main'); renderAll(); openTab('captions'); });
  const srt = '1\n00:00:00,500 --> 00:00:01,750\nHello <i>there</i>\n\n2\n00:00:02,000 --> 00:00:03,250\nSecond line\nwith two rows\n\n';
  fs.writeFileSync(`${tmp}/feat.srt`, srt);
  await page.setInputFiles('#subsIn', `${tmp}/feat.srt`);
  await page.waitForFunction(() => P.captions.length === 2, null, { timeout: 5000 }).catch(() => {});
  const caps = await ev(() => P.captions.map(c => [c.start, +c.dur.toFixed(3), c.text, c.words.length]));
  check('importing an SRT puts its cues on the captions track (tags dropped)', JSON.stringify(caps) === JSON.stringify([[0.5, 1.25, 'Hello there', 2], [2, 1.25, 'Second line with two rows', 5]]), JSON.stringify(caps));
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500 align:start\nVTT cue\n\nNOTE skip me\n\n01:00:00.000 --> 01:00:01.000\nAn hour in\n';
  const vr = await ev(v => REMOTE.import_subtitles({ srt: v, name: 'x.vtt' }), vtt);
  check('WebVTT too, with hours and cue settings (MCP import_subtitles)', vr.captions === 2 && vr.first[1][0] === 3600, JSON.stringify(vr));
  await ev(s0 => importSubs(s0, 'feat.srt'), srt);
  await page.click('#btnExport'); await page.selectOption('#exFmt', 'srt'); await page.click('#exGo');
  await page.waitForSelector('#exDone [data-reveal]', { timeout: 10000 }).catch(async () => console.log('export window said:', await page.textContent('#exStatus')));
  const f = await page.getAttribute('#exDone [data-reveal]', 'data-reveal'), out = fs.readFileSync(`${EXP}/${f}`, 'utf8');
  check('the Export window saves the captions as SRT, times to the millisecond', out === '1\n00:00:00,500 --> 00:00:01,750\nHello there\n\n2\n00:00:02,000 --> 00:00:03,250\nSecond line with two rows\n', JSON.stringify(out));
  await ev(() => closeModal());
  const r2 = await ev(() => REMOTE.export({ format: 'srt', name: 'feat-mcp' }));
  check('MCP export format srt', /feat-mcp.*\.srt$/.test(r2.file) && fs.readFileSync(`${EXP}/${r2.file}`, 'utf8').includes('00:00:02,000 --> 00:00:03,250'), r2.file);
  const bad = await ev(() => { try { importSubs('nothing here', 'junk.srt'); return 'no error'; } catch (e) { return e.message; } });
  check('a file with no cues is refused clearly', /no subtitles found in junk\.srt/.test(bad), bad);
}

// ---------- relink ----------
if (run('relink')) {
  await fresh('Relink');
  const X = await imp(gen('feat-relink.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']));
  await ev(() => loadMedia());
  const pid = await ev(async id => { addMedia(id, 'main'); addMedia(id, 'overlay', 1); await api(`/api/projects/${P.id}`, P, 'PUT'); return P.id; }, X.id);
  await fetch(`${B}/api/media/${X.id}/trash`, { method: 'POST', headers: H, body: '{}' });
  await ev(async pid => { await loadMedia(); await openProject(pid); }, pid);
  await page.waitForFunction(() => document.querySelectorAll('.clip.missing').length === 2, null, { timeout: 8000 }).catch(() => {});
  check('a clip whose file left the library shows as missing on the timeline', await page.locator('.clip.missing').count() === 2, JSON.stringify(await ev(([pid, id]) => ({ open: P.id === pid, clips: P.main.map(c => c.media), has: M.has(id), x: id }), [pid, X.id])));
  await page.locator('.clip.missing').first().click();
  check('its inspector offers restore / relink', await page.locator('#inspector [data-act="restore"]').count() === 1 && await page.locator('#inspector [data-relink]').count() === 1);
  await page.click('#inspector [data-act="restore"]');
  await page.waitForFunction(id => M.get(id) && !document.querySelector('.clip.missing'), X.id, { timeout: 20000 }).catch(() => {});
  check('Restore from trash brings the file back and the clips play it', await page.locator('.clip.missing').count() === 0 && await ev(id => !!M.get(id), X.id), await ev(() => ($('#clipStatus')?.textContent || '') + ' | ' + document.querySelectorAll('.clip.missing').length));
  await fetch(`${B}/api/media/${X.id}/trash`, { method: 'POST', headers: H, body: '{}' });
  await ev(async pid => { await loadMedia(); await openProject(pid); }, pid);
  await page.locator('.clip.missing').first().click();
  await page.setInputFiles('#inspector [data-relink]', gen('feat-relink2.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']));
  await page.waitForFunction(() => !document.querySelector('.clip.missing'), null, { timeout: 15000 }).catch(() => {});
  const r = await ev(() => [P.main[0].media, P.overlay[0].media, M.get(P.main[0].media)?.name, +P.main[0].out.toFixed(2)]);
  check('Relink to a file fixes every clip that used it (out kept inside the new file)', r[0] === r[1] && r[2] === 'feat-relink2.mp4' && r[3] <= 3, JSON.stringify(r));
  const viaMcp = await ev(async ([from, to]) => { const c = P.main[0], was = c.media; c.media = from; renderAll(); const out = await REMOTE.relink_media({ missing: from, media: to }); return [out.relinked, P.main[0].media === M.get(to)?.id || P.main[0].media === to, was]; }, [X.id, V.id]);
  check('MCP relink_media', viaMcp[0] === 1 && viaMcp[1], JSON.stringify(viaMcp));
}

// ---------- colour grading and scopes ----------
if (run('grade')) {
  await fresh('Grade');
  const cid = await ev(() => { addMedia(MD.V.id, 'main'); S.t = 1.5; S.sel = { lane: 'main', id: P.main[0].id }; S.itab = 'Color'; renderAll(); return P.main[0].id; });
  check('the preview colours on the GPU (WebGL2)', await ev(() => !!gpu()));
  const base = await still(1.5);
  const mean = img => { let s = [0, 0, 0]; for (let i = 0; i < img.px.length; i += 4) for (let k = 0; k < 3; k++) s[k] += img.px[i + k]; return s.map(v => v / (img.px.length / 4)); };
  const w = await box('canvas[data-wheel="gain"]');
  await drag({ x: w.x + w.width / 2, y: w.y + w.height / 2 }, { x: w.x + w.width * 0.9, y: w.y + w.height / 2 }); // towards red
  const g1 = await ev(id => P.main.find(c => c.id === id).grade?.gain, cid);
  const warm = await still(1.5), m0 = mean(base), m1 = mean(warm);
  check('dragging the Highlights wheel towards red warms the export', g1?.x > 0.5 && Math.abs(g1.y) < 0.1 && (m1[0] - m1[2]) - (m0[0] - m0[2]) > 8, `${JSON.stringify(g1)} rgb ${m0.map(Math.round)} -> ${m1.map(Math.round)}`);
  check('one undo step for the drag', await ev(() => { restore(undo, redo); const ok = !P.main[0].grade?.gain; restore(redo, undo); return ok; }));
  const cv = await box('#curveSvg');
  await drag({ x: cv.x + cv.width * 0.5, y: cv.y + cv.height * 0.5 }, { x: cv.x + cv.width * 0.5, y: cv.y + cv.height * 0.3 }); // lift the middle of the luma curve
  const crv = await ev(id => P.main.find(c => c.id === id).grade?.curves?.m, cid);
  check('clicking the curve adds a point and dragging lifts it', crv?.length === 3 && crv[1][1] > 0.65, JSON.stringify(crv));
  const pt = await box('#curveSvg circle[data-pt="1"]');
  await page.mouse.dblclick(pt.x + pt.width / 2, pt.y + pt.height / 2);
  check('double-clicking a point removes it', (await ev(id => P.main.find(c => c.id === id).grade?.curves?.m?.length, cid)) === 2);
  await page.click('[data-hband="green"]');
  await page.locator('#inspector input[data-k="c.grade.hsl.green.s"]').evaluate(e => { e.value = -1; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  check('HSL: the green band desaturated', (await ev(id => P.main.find(c => c.id === id).grade?.hsl?.green?.s, cid)) === -1);
  const cube = 'TITLE "invert"\nLUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n';
  fs.writeFileSync(`${tmp}/invert.cube`, cube);
  await ev(id => change(() => { P.main.find(c => c.id === id).grade = {}; }), cid);
  await page.setInputFiles('#inspector [data-lutin]', `${tmp}/invert.cube`);
  await page.waitForFunction(id => P.main.find(c => c.id === id).grade?.lut?.id, cid, { timeout: 5000 }).catch(() => {});
  const inv = await still(1.5), mi = mean(inv);
  check('an imported .cube LUT (invert) inverts the export', mi.every((v, i) => Math.abs(v - (255 - m0[i])) < 6), `${m0.map(Math.round)} -> ${mi.map(Math.round)}`);
  const pv = await ev(async () => { await waitFrame(); const cv = $('#cv'), x = document.createElement('canvas').getContext('2d'); x.canvas.width = 32; x.canvas.height = 18; x.drawImage(cv, 0, 0, 32, 18); const d = x.getImageData(0, 0, 32, 18).data; let s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]; return s.map(v => v / 576); });
  check('...and the preview', pv.every((v, i) => Math.abs(v - mi[i]) < 12), `${pv.map(Math.round)} vs ${mi.map(Math.round)}`);
  await page.locator('#inspector input[data-k="c.grade.lut.amount"]').evaluate(e => { e.value = 0.5; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const half = mean(await still(1.5));
  check('LUT strength 50% lands half way (grey)', half.every(v => Math.abs(v - 127.5) < 12), half.map(Math.round));
  await ev(() => { S.t = 0.2; renderInspector(); });
  await page.locator('#lkHere').evaluate(e => { e.value = 0; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  await ev(() => { S.t = 3; renderInspector(); });
  await page.locator('#lkHere').evaluate(e => { e.value = 1; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const lk = await ev(id => P.main.find(c => c.id === id).lkf, cid), early = mean(await still(0.2)), late = mean(await still(3));
  check('strength points: no colour at 0.2 s, full at 3 s', lk?.length === 2 && early.every((v, i) => Math.abs(v - m0[i]) < 6) && late.every((v, i) => Math.abs(v - (m0[i] + 255 - m0[i]) / 2) < 14), `${JSON.stringify(lk)} ${early.map(Math.round)} ${late.map(Math.round)}`);
  await ev(id => change(() => { delete P.main.find(c => c.id === id).grade; delete P.main.find(c => c.id === id).lkf; }), cid);
  await page.click('#btnScope');
  const sc = [];
  for (const k of ['wave', 'hist', 'vec']) { await page.click(`[data-scope="${k}"]`); sc.push(await ev(async () => { await waitFrame(); const d = $('#scopeCv').getContext('2d').getImageData(0, 0, 256, 150).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++; return lit; })); }
  check('scopes draw a waveform, a histogram and a vectorscope', sc.every(n => n > 50), sc.join(', '));
  await page.click('#btnScope');
  const L = await ev(c => REMOTE.import_lut({ cube: c, name: 'mcp.cube' }), cube);
  const r = await ev(([id, lid]) => REMOTE.update_clip({ id, set: { lkf: null, grade: { lut: { id: lid, amount: 1 }, hsl: { red: { h: 0.5 } } } } }), [cid, L.id]);
  check('MCP import_lut + update_clip grade', L.id && r.grade?.lut?.id === L.id && mean(await still(1.5)).every((v, i) => Math.abs(v - (255 - m0[i])) < 12), JSON.stringify(r.grade));
  const bad = await ev(id => REMOTE.update_clip({ id, set: { grade: { hsl: { teal: { h: 1 } } } } }).then(() => 'ok', e => e.message), cid);
  check('a malformed grade is refused clearly', /^grade: /.test(bad), bad);
}

// ---------- compound clips ----------
if (run('compound')) {
  await fresh('Compound');
  await ev(() => { addMedia(MD.V.id, 'main'); P.main[0].out = 2; addMedia(MD.V.id, 'main'); Object.assign(P.main[1], { in: 3, out: 5, tr: undefined }); P.main[0].tr = { type: 'dissolve', d: 0.5 }; addMedia(MD.V.id, 'main'); P.main[2].out = 1.5;
    addMedia(MD.RED.id, 'overlay', 0.5); Object.assign(P.overlay[0], { fit: 'fit', scale: 0.3, x: 0.3 }); S.t = 1; addText('Title'); S.sel = null; renderAll(); });
  const before = await still(1.2), sel = await ev(() => [['main', P.main[0].id], ['main', P.main[1].id], ['overlay', P.overlay[0].id], ['text', P.text[0].id]]);
  await ev(sel => { S.sel = { lane: sel[0][0], id: sel[0][1] }; S.multi = new Set(sel.slice(1).map(([l, id]) => `${l}:${id}`)); renderAll(); }, sel);
  await page.locator(`.clip[data-id="${sel[0][1]}"]`).click({ button: 'right' });
  await page.locator('.ctxmenu button', { hasText: 'Make compound clip' }).click();
  await page.waitForFunction(() => P.main.some(c => c.compound), null, { timeout: 60000 }).catch(() => {});
  const r = await ev(() => ({ main: P.main.length, ov: P.overlay.length, text: P.text.length, cc: P.main.find(c => c.compound) && { dur: +len(P.main[0]).toFixed(2), n: P.main[0].compound.main.length, tr: P.main[0].tr?.type } }));
  check('the right-click menu makes 2 main clips + an overlay + a title into one compound clip', r.main === 2 && r.ov === 0 && r.text === 0 && r.cc?.n === 2 && r.cc.dur > 3, JSON.stringify(r));
  const after = await still(1.2);
  let diff = 0; for (let i = 0; i < before.px.length; i += 4) diff += Math.abs(before.px[i] - after.px[i]) + Math.abs(before.px[i + 1] - after.px[i + 1]) + Math.abs(before.px[i + 2] - after.px[i + 2]);
  diff /= before.px.length / 4 * 3;
  check('the compound looks like what it was made of (export, mid-transition, with the overlay and title)', diff < 6, `mean diff ${diff.toFixed(2)} levels`);
  await page.locator('.clip.main').first().click();
  await page.click('#inspector [data-itab="Tools"]').catch(() => {});
  await page.click('#inspector [data-act="breakcompound"]');
  const back = await ev(() => ({ main: P.main.length, ov: P.overlay.length, text: P.text.length, tr: P.main[0].tr?.type, ovStart: P.overlay[0]?.start }));
  check('Break apart puts the clips back (transition, overlay start, title)', back.main === 3 && back.ov === 1 && back.text === 1 && back.tr === 'dissolve' && Math.abs(back.ovStart - 0.5) < 1e-6, JSON.stringify(back));
  const m = await ev(async () => { const ids = [P.main[1].id, P.main[2].id]; const r = await REMOTE.compound_clip({ ids }); const n = P.main.length; await REMOTE.break_compound({ id: r.id }); return [r.compound, n, P.main.length]; });
  check('MCP compound_clip and break_compound', m[0] === 2 && m[1] === 2 && m[2] === 3, JSON.stringify(m));
  const bad = await ev(() => REMOTE.compound_clip({ ids: [P.overlay[0].id, P.text[0].id] }).then(() => 'ok', e => e.message));
  check('a compound without a main clip is refused clearly', /needs a main-track clip/.test(bad), bad);
}

// ---------- multicam ----------
if (run('multicam')) {
  await fresh('Multicam');
  execFileSync('say', ['-o', `${tmp}/mc.aiff`, 'One. Two, three. This is the multicam test, with words to line up the cameras. Four, five, six. Done.']);
  const cam = (name, colour, cut, delay) => gen(name, ['-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=30:d=9`, '-i', `${tmp}/mc.aiff`, '-filter_complex', `[1:a]${cut ? `atrim=start=${cut},asetpts=PTS-STARTPTS` : `adelay=${delay}:all=1`},apad=whole_dur=9[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '9']);
  const A1 = await imp(cam('mc-red.mp4', 'red', 0, 1000)), A2 = await imp(cam('mc-green.mp4', 'lime', 0.8, 0)), A3 = await imp(cam('mc-blue.mp4', 'blue', 0, 2300)); // green started 1.8 s earlier in the speech, blue 1.3 s later
  await ev(() => loadMedia());
  await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), [A1.id, A2.id, A3.id], { timeout: 60000 });
  await ev(() => openTab('media'));
  await page.click('#btnMulticam');
  for (const id of [A1.id, A2.id, A3.id]) await page.check(`#modal input[value="${id}"]`);
  await page.click('#mcGo');
  await page.waitForFunction(() => P.main.some(c => c.mc), null, { timeout: 60000 }).catch(() => {});
  const mc = await ev(() => { const c = P.main.find(x => x.mc); return c && { offs: c.mc.angles.map(a => a.off), in: c.in, out: c.out, audio: P.audio.filter(a => a.mcAudio === c.mc.g).length }; });
  check('Multicam… syncs the angles by sound (offsets within 15 ms)', mc && Math.abs(mc.offs[1] + 1.8) < 0.015 && Math.abs(mc.offs[2] - 1.3) < 0.015 && mc.audio === 1, JSON.stringify(mc));
  await ev(() => { S.t = 2; renderAll(); document.activeElement?.blur(); });
  await page.keyboard.press('2');
  await ev(() => { S.t = 4; });
  await page.keyboard.press('3');
  const parts = await ev(() => P.main.map(c => [c.mc?.a, +c.start.toFixed(2), +c.in.toFixed(3)]));
  check('keys 2 then 3 cut to those angles at the playhead, in sync', parts.length === 3 && parts[1][0] === 1 && parts[2][0] === 2 && Math.abs(parts[1][2] - (parts[0][2] + 2 - 1.8)) < 0.01 && Math.abs(parts[2][2] - (parts[0][2] + 4 + 1.3)) < 0.01, JSON.stringify(parts));
  const colours = [];
  for (const t of [1, 3, 5]) colours.push(at(await still(t), 0.5, 0.5));
  check('the export shows red, then green, then blue', colours[0][0] > 200 && colours[1][1] > 200 && colours[2][2] > 200 && colours[0][1] < 60 && colours[1][0] < 60 && colours[2][0] < 60, JSON.stringify(colours));
  const m = await ev(async () => { await REMOTE.multicam_cut({ angle: 1, at: 5 }); return P.main.map(c => c.mc?.a); });
  check('MCP multicam_cut', JSON.stringify(m) === '[0,1,2,0]', JSON.stringify(m));
  const bad = await ev(() => REMOTE.multicam({ media: [MD.V.id] }).then(() => 'ok', e => e.message));
  check('a one-angle multicam is refused clearly', /2 to 6 videos/.test(bad), bad);
}

// ---------- beauty, blur, glow, body effects ----------
if (run('beauty')) {
  await fresh('Beauty');
  const SK = await imp(gen('feat-skin.mp4', ['-f', 'lavfi', '-i', 'color=c=0xC89682:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=0x2850C8:s=640x360:r=30:d=3', '-filter_complex', '[0:v][1:v]hstack,noise=alls=40:allf=t,scale=640:360', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12']));
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, SK.id, { timeout: 30000 });
  await ev(id => { addMedia(id, 'main'); S.t = 1; S.sel = { lane: 'main', id: P.main[0].id }; S.itab = 'Look'; renderAll(); }, SK.id);
  const vari = (img, x0, x1) => { let n = 0, s = 0, s2 = 0; for (let y = Math.round(img.h * 0.2); y < img.h * 0.8; y++) for (let x = Math.round(img.w * x0); x < img.w * x1; x++) { const i = (y * img.w + x) * 4, v = img.px[i + 1]; n++; s += v; s2 += v * v; } return s2 / n - (s / n) ** 2; };
  const pvImg = () => ev(async () => { await waitFrame(); const cv = $('#cv'), x = document.createElement('canvas').getContext('2d'); x.canvas.width = 320; x.canvas.height = 180; x.drawImage(cv, 0, 0, 320, 180); return { w: 320, h: 180, px: [...x.getImageData(0, 0, 320, 180).data] }; });
  const e0 = await still(1, 640), p0 = await pvImg();
  await page.locator('#inspector input[data-k="c.beauty.amt"]').evaluate(e => { e.value = 1; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const e1 = await still(1, 640), p1 = await pvImg();
  const r = [vari(e1, 0.05, 0.45) / vari(e0, 0.05, 0.45), vari(e1, 0.55, 0.95) / vari(e0, 0.55, 0.95), vari(p1, 0.05, 0.45) / vari(p0, 0.05, 0.45), vari(p1, 0.55, 0.95) / vari(p0, 0.55, 0.95)];
  check('Smooth skin evens out the skin-coloured half and leaves the blue half (export and preview)', r[0] < 0.6 && r[1] > 0.85 && r[2] < 0.6 && r[3] > 0.85, r.map(v => v.toFixed(2)).join(' '));
  await ev(() => change(() => { delete P.main[0].beauty; }));
  await page.locator('#inspector input[data-k="c.adj.blur"]').evaluate(e => { e.value = 0.5; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const e2 = await still(1, 640), p2 = await pvImg();
  check('the clip Blur slider blurs it (export and preview)', vari(e2, 0.05, 0.45) / vari(e0, 0.05, 0.45) < 0.2 && vari(p2, 0.05, 0.45) / vari(p0, 0.05, 0.45) < 0.2, [vari(e2, 0.05, 0.45) / vari(e0, 0.05, 0.45), vari(p2, 0.05, 0.45) / vari(p0, 0.05, 0.45)].map(v => v.toFixed(3)).join(' '));
  const CUT = await imp(gen('feat-cut.png', ['-f', 'lavfi', '-i', 'color=c=white@0.0:s=400x400,format=rgba,drawbox=x=150:y=100:w=100:h=200:color=red@1:t=fill', '-frames:v', '1']));
  await ev(() => loadMedia());
  await ev(id => { change(() => { delete P.main[0].adj.blur; }); addMedia(id, 'overlay', 0); Object.assign(P.overlay[0], { fit: 'fit' }); S.sel = { lane: 'overlay', id: P.overlay[0].id }; S.itab = 'Look'; renderAll(); }, CUT.id);
  await page.click('#inspector [data-glowkind="neon"]');
  const g = await still(1, 640), pg = await pvImg(), halo = img => at(img, 0.5 + 60 / 640, 0.5)[2];
  check('Neon on a cutout: a cyan halo around it, export and preview', await ev(() => P.overlay[0].glow?.neon) && halo(g) > 150 && halo(pg) > 150, `${halo(g)} ${halo(pg)}`);
  const tm = (await get('/api/media')).find(m => m.name === 'talk-with-music.mp4');
  if (tm) {
    await ev(id => { setProject(newProject('16:9')); P.name = 'Body (scratch)'; addMedia(id, 'main'); Object.assign(P.main[0], { in: 2, out: 4 }); renderAll(); }, tm.id);
    const r2 = await ev(async () => { try { const cut = await bodyEffect(P.main[0], 'main', 'blur'); return { ok: true, ov: P.overlay.length, dur: +len(cut).toFixed(2), alpha: !!(M.get(cut.media)?.alpha || M.get(cut.media)?.trans), blur: P.main[0].adj.blur, mdur: +M.get(cut.media).duration.toFixed(1) }; } catch (e) { return { ok: false, e: e.message }; } });
    check('Blur background: the person cut out (only the 2 s used) on the track above, the main clip blurred', r2.ok && r2.ov === 1 && r2.alpha && r2.blur > 0 && Math.abs(r2.dur - 2) < 0.05 && r2.mdur <= 2.2, JSON.stringify(r2));
    const ex = await ev(() => REMOTE.export({ format: 'mp4', resolution: '720p', name: 'feat-body' }).then(r => r.file, e => 'ERR ' + e.message));
    check('...and it exports', !/^ERR/.test(ex), ex);
  }
}

} catch (e) { check('the suite ran to the end', false, String(e.message).split('\n')[0]); }

// ---------- tidy ----------
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
await ev(() => clearTimeout(saveTimer));
await b.close();
fs.rmSync(tmp, { recursive: true });
const after = { p: await get('/api/projects'), m: await get('/api/media') };
const made = { p: after.p.filter(x => !before.p.has(x.id)), m: after.m.filter(x => !before.m.has(x.id)), e: fs.readdirSync(EXP).filter(f => !before.e.has(f)) };
for (const p of made.p) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const L of (await get('/api/luts')).filter(x => !before.l.has(x.id))) await fetch(`${B}/api/luts/${L.id}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.mkdirSync(`${LIB}/trash/exports`, { recursive: true });
for (const f of made.e) fs.renameSync(`${EXP}/${f}`, `${LIB}/trash/exports/${f}`);
console.log(`\n${res.filter(Boolean).length}/${res.length} passed; trashed ${made.p.length} projects, ${made.m.length} media, ${made.e.length} exports`);
process.exit(res.includes(false) ? 1 : 0);
