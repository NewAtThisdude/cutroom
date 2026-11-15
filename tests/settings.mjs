// Settings window (web/settings.js), in headless WebKit with real clicks and keys, both motion modes: the gear and ⌘, / Ctrl+,
// open it; search filters (shortcuts too); one option in each section is honoured by the code that reads it (new project shape,
// frame rate and name; snapping; preview quality; loop; motion override; the Export dialog's preset, name, Light and folder, and
// a real export landing in the chosen folder; a remapped shortcut; an AI feature turned off loses its button and its MCP command
// refuses; clear preview cache removes only regenerable files and the editor makes them again; About); the MCP settings command;
// everything survives a reload; Reset this section and Reset all bring the defaults back; no page errors.
//   B=<server on a scratch library> node settings.mjs   (never 4610; it imports two 3 s test clips, best on an empty library)
import path from 'node:path';
import os from 'node:os';
import { browser } from './browser.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const B = process.env.B, OUT = fileURLToPath(new URL('./out/settings/', import.meta.url));
if (!B || /:4610\b/.test(B)) { console.log('SKIP: set B to a scratch server (never 4610)'); process.exit(0); }
fs.mkdirSync(`${OUT}exdir`, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// two small clips (picture + sound), imported once
const CLIPS = [['settings-wide.mp4', '640x360'], ['settings-tall.mp4', '360x640']];
for (const [n, size] of CLIPS) {
  if (!fs.existsSync(OUT + n)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=3`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', OUT + n]);
  if (!(await api('/api/media')).some(m => m.name === n)) await fetch(`${B}/api/import?name=${n}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(OUT + n) });
}
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const info = await api('/api/settings'), HOME = info.home, ids = (await api('/api/media')).filter(m => CLIPS.some(([n]) => n === m.name)).map(m => m.id);
await api('/api/settings', { versionsKeep: null, versionsGap: null, exportDir: null, proxy: null, llm: null }); // a clean start

const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const ev = (f, a) => page.evaluate(f, a);
  const open = async () => { await page.goto(`${B}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof SET === 'object', null, { timeout: 20000 }); await page.waitForTimeout(300); if (await page.$('#tour')) await page.keyboard.press('Escape'); };
  const isOpen = () => page.waitForSelector('#modal .dialog.settings', { timeout: 5000 }).then(() => true, () => false);
  const keyOpen = async () => { await page.keyboard.press('Meta+Comma'); return isOpen(); };
  const shown = () => ev(() => $$('.setmain .setrow').filter(r => r.getClientRects().length).map(r => r.dataset.key || r.dataset.find));
  const section = async s => { await page.click(`[data-setsec="${s}"]`); await page.waitForTimeout(50); };
  await open();
  await ev(() => store.set('cutroom.tour', 'done'));

  // ---- opening ----
  await page.click('#btnSettings'); await isOpen();
  const secs = await ev(() => $$('.setnav button').map(x => x.textContent));
  check(`${rm}: the gear opens Settings: ${secs.length} sections, General first`, secs.length === 8 && secs[0] === 'General' && (await shown()).includes('ratio'), secs.join(', '));
  await page.screenshot({ path: `${OUT}${rm}-general.png` });
  await page.keyboard.press('Escape');
  const meta = await keyOpen(); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Comma'); const ctrl = await isOpen();
  check(`${rm}: ⌘, and Ctrl+, open it, Esc closes it`, meta && ctrl);

  // ---- search ----
  await page.fill('#setQ', 'snap'); const s1 = await shown();
  await page.fill('#setQ', 'split'); const s2 = await ev(() => $$('#setKeys .keys tr').filter(r => r.getClientRects().length).map(r => r.textContent));
  await page.fill('#setQ', 'this computer'); const s3 = await shown();
  await page.fill('#setQ', ''); const s4 = await shown();
  check(`${rm}: search filters: "snap" shows the two snapping rows, "split" the shortcut, a section name all of it; cleared, General again`,
    s1.join() === 'snap,snapPx' && s2.length >= 1 && s2.every(t => /split/i.test(t)) && s3.length > 3 && s4.includes('ratio') && !s4.includes('snap'), `${s1} | ${s2.length} | ${s3.length} | ${s4.length}`);

  // ---- General: the new project's shape, frame rate and name ----
  await page.selectOption('#set-ratio', '16:9'); await page.selectOption('#set-fps', '60');
  await page.fill('#set-newName', 'Settings check {date}'); await page.press('#set-newName', 'Tab');
  await page.selectOption('#set-versionsKeep', '120'); await page.waitForTimeout(300);
  const lib1 = await api('/api/settings'), file = JSON.parse(fs.readFileSync(`${HOME}/settings.json`, 'utf8'));
  await page.keyboard.press('Escape');
  await page.click('#btnProjects'); await page.waitForSelector('#newRatio');
  const sel = await page.inputValue('#newRatio'); await page.click('[data-newsel]');
  const np = await ev(() => ({ w: P.w, h: P.h, fps: P.fps, name: P.name }));
  check(`${rm}: General: Projects > New starts 16:9 at 60 fps named by the pattern; versions kept goes to the library's settings.json`,
    sel === '16:9' && np.w === 1920 && np.h === 1080 && np.fps === 60 && np.name === `Settings check ${new Date().toLocaleDateString()}` && lib1.lib.versionsKeep === 120 && file.versionsKeep === 120, JSON.stringify({ sel, np, lib: lib1.lib }));
  await ev(async ids => { for (const id of ids) addMedia(id, 'main'); await REMOTE.add_text({ text: 'Settings', start: 0, duration: 2 }); }, ids);

  // ---- Editing: snapping, text length, a transition on new cuts ----
  const snapOn = await ev(() => magnet(S.t + 3 / S.pps)[1]);
  await keyOpen(); await section('editing');
  await page.click('#set-snap'); await page.selectOption('#set-textDur', '5'); await page.selectOption('#set-trType', 'fadeblack');
  const ed = await ev(ids => { const off = magnet(S.t + 3 / S.pps)[1]; addText('Subtitle'); const d = P.text.at(-1).dur; restore(undo, redo); addMedia(ids[0], 'main'); const tr = P.main.at(-2).tr; restore(undo, redo); return { off, d, tr }; }, ids);
  check(`${rm}: Editing: snapping off stops a drag 3 px from the playhead snapping (it did); new text lasts 5 s; a new cut gets the dip to black`,
    snapOn < Infinity && ed.off === Infinity && ed.d === 5 && ed.tr?.type === 'fadeblack' && ed.tr.d === 0.5, JSON.stringify({ snapOn, ...ed }));

  // ---- Playback: preview quality, loop, the motion override ----
  await section('playback');
  await page.selectOption('#set-pq', 'full'); const wFull = await ev(() => $('#cv').width);
  await page.selectOption('#set-pq', 'half'); const pq = await ev(() => [$('#pqSel').value, $('#cv').width]);
  await page.click('#set-loop');
  const tr0 = await ev(() => getComputedStyle($('#btnExport')).transitionDuration);
  await page.selectOption('#set-motion', rm === 'reduce' ? 'full' : 'reduce');
  const tr1 = await ev(() => [document.documentElement.dataset.motion, getComputedStyle($('#btnExport')).transitionDuration]);
  await page.keyboard.press('Escape');
  await ev(() => { S.t = Math.max(0, total() - 0.15); play(); });
  await page.waitForTimeout(900);
  const lp = await ev(() => { const r = [S.playing, S.t]; pause(); return r; });
  const flip = rm === 'reduce' ? tr1[1] !== '0s' : tr1[1] === '0s';
  check(`${rm}: Playback: Half shows in the preview menu and halves the canvas; playback loops at the end; motion ${rm === 'reduce' ? 'Full brings transitions back' : 'Reduce turns them off'}`,
    pq[0] === 'half' && Math.abs(pq[1] / wFull - 0.5) < 0.02 && lp[0] && lp[1] < 1 && (rm === 'reduce' ? tr0 === '0s' : tr0 !== '0s') && flip, JSON.stringify({ wFull, pq, lp, tr0, tr1 }));

  // ---- Export: the dialog starts on the preset, name, Light and folder; a real export lands in that folder ----
  await keyOpen(); await section('export');
  await page.selectOption('#set-preset', 'yt1080'); await page.fill('#set-exName', '{project} final'); await page.press('#set-exName', 'Tab');
  await page.click('#set-light'); await page.fill('#set-exportDir', `${OUT}exdir`); await page.press('#set-exportDir', 'Tab'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}${rm}-export.png` });
  await page.keyboard.press('Escape');
  await page.click('#btnExport');
  const exd = await ev(() => ({ preset: $('#exPreset').value, name: $('#exName').value, light: $('#exLight').checked, dir: $('#exDir')?.textContent, P: P.name }));
  await page.keyboard.press('Escape');
  for (const f of fs.readdirSync(`${OUT}exdir`)) fs.unlinkSync(`${OUT}exdir/${f}`);
  const ex = await api('/api/remote', { cmd: 'export', args: { format: 'png', name: `settings-${rm}` }, timeout: 120 });
  const landed = fs.existsSync(`${OUT}exdir/settings-${rm}.png`) && !fs.existsSync(`${HOME}/exports/settings-${rm}.png`);
  check(`${rm}: Export: the dialog starts on YouTube 1080p, "<project> final", Light, the chosen folder; an export lands there`,
    exd.preset === 'yt1080' && exd.name === `${exd.P} final` && exd.light && /exdir/.test(exd.dir) && ex.ok && landed && /exdir/.test(ex.result?.path), JSON.stringify({ exd, ex: ex.result, landed }));

  // ---- Shortcuts: the remap sheet is here; the ? sheet links to it ----
  await keyOpen(); await section('keys');
  await page.click('#setKeys [data-keyfor="split"]'); await page.keyboard.press('d'); await page.waitForTimeout(50);
  const km = await ev(() => [KEYBY.get('KeyD'), $('#setKeys [data-keyfor="split"]').textContent, !!$('#modal .dialog.settings')]);
  await page.keyboard.press('Escape'); await page.keyboard.press('?'); await page.click('#modal [data-settings]'); await page.waitForSelector('#modal .dialog.settings #setKeys [data-keyfor]');
  const back = await ev(() => [$('.setnav .on')?.textContent, $$('#setKeys [data-keyfor]').length === KEYMAP0.length]);
  await page.screenshot({ path: `${OUT}${rm}-keys.png` });
  check(`${rm}: Shortcuts: click Split, press D: D splits, Settings stays open; the ? sheet's Edit in Settings opens this section`,
    km[0] === 'split' && km[1].startsWith('D') && km[2] && back[0] === 'Shortcuts' && back[1], JSON.stringify({ km, back }));

  // ---- AI: a feature turned off loses its button and its MCP command refuses ----
  await section('ai');
  await page.waitForFunction(() => /GB memory/.test($('#setMacSum')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const caps = await ev(() => $$('[data-capfor]').filter(x => x.textContent).length);
  await page.click('#set-ai-music'); await page.click('#set-ai-llm'); await page.click('#set-ai-image');
  await page.screenshot({ path: `${OUT}${rm}-ai.png` });
  await page.keyboard.press('Escape');
  const hid = await ev(() => ['#btnMusic', '#btnAsk', '#btnAiVoice', '#btnAiImage', '#btnStickerAI'].map(s => getComputedStyle($(s)).display));
  const ref = await api('/api/remote', { cmd: 'generate_music', args: { prompt: 'lofi' } }), ref2 = await api('/api/remote', { cmd: 'pilot', args: { text: 'add captions' } }), ref3 = await api('/api/remote', { cmd: 'ai_image', args: {} }); // ai_image = the MCP generate_image; no prompt, so only the switch can refuse it with this text
  check(`${rm}: AI: the panel lists what this computer runs (${caps} features); AI music, image generation and the language model off: their buttons are gone, the MCP refuses them`,
    caps >= 8 && hid[0] === 'none' && hid[1] === 'none' && hid[2] !== 'none' && hid[3] === 'none' && hid[4] === 'none' && !ref3.ok && /turned off in Settings/.test(ref3.result) && !ref.ok && /turned off in Settings/.test(ref.result) && !ref2.ok && /turned off in Settings/.test(ref2.result), JSON.stringify({ caps, hid, ref, ref2, ref3 }));

  // the language model off also covers the caption extras it makes (keywords, emoji, bilingual), not their show / hide
  const ce = await api('/api/remote', { cmd: 'caption_extras', args: { keywords: true } }), cb = await api('/api/remote', { cmd: 'caption_extras', args: { bilingual: 'es' } });
  const cs = await api('/api/remote', { cmd: 'caption_extras', args: { show: { kw: true } } });
  const kwHidden = await ev(() => getComputedStyle($('#capKw').closest('label')).display === 'none' && getComputedStyle($('#capEmoji').closest('label')).display === 'none' && getComputedStyle($('#trBi').closest('label')).display === 'none');
  check(`${rm}: AI: with the language model off, caption keywords / bilingual are refused and their toggles hidden; showing layers still works`,
    !ce.ok && /turned off in Settings/.test(ce.result) && !cb.ok && /turned off in Settings/.test(cb.result) && !/turned off in Settings/.test(String(cs.result)) && kwHidden, JSON.stringify({ ce, cb, cs, kwHidden }));
  // captions off covers every way to transcribe: main_transcript (edit by script) too, and the Script tab goes
  await keyOpen(); await section('ai');
  await page.click('#set-ai-captions'); await page.keyboard.press('Escape');
  const mt = await api('/api/remote', { cmd: 'main_transcript', args: {} }), scHidden = await ev(() => getComputedStyle($('[data-tab="script"]')).display === 'none');
  const missing = await ev(() => SET.missing);
  const libSet = (await api('/api/settings')).lib; // the switches live in the library's settings.json, so the server keeps them across a restart
  check(`${rm}: AI: the switches are kept with the library (settings.json), where the server reads them`, libSet['ai.captions'] === false && libSet['ai.llm'] === false, JSON.stringify(libSet));
  // and the server itself: a path the page doesn't gate (a direct /api/fillers call) is refused in the job queue, before whisper
  let vid = await ev(() => [...M.values()].find(m => m.kind === 'video' && m.hasAudio)?.id);
  if (!vid) { // an empty library: one short clip with sound to aim at
    const f = path.join(os.tmpdir(), `settings-tone-${process.pid}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
    vid = (await api('/api/import_path', { path: f })).id;
  }
  const fil = vid ? await api('/api/fillers', { media: vid, lang: 'auto', ranges: [[0, 1]] }) : { error: 'no video with sound' };
  const sc = await api('/api/remote', { cmd: 'smart_combine', args: { media: ['x'] } }), rf = await api('/api/remote', { cmd: 'remove_fillers', args: {} });
  check(`${rm}: AI: switched off in the server too: a direct /api/fillers call is refused before whisper runs; smart_combine and remove_fillers refuse`,
    /turned off in Settings/.test(JSON.stringify(fil)) && !sc.ok && /turned off in Settings/.test(sc.result) && !rf.ok && /turned off in Settings/.test(rf.result), JSON.stringify({ fil, sc, rf }));
  check(`${rm}: AI: auto captions off refuses main_transcript and hides the Script tab; every AI switch names a real command`,
    !mt.ok && /turned off in Settings/.test(mt.result) && scHidden && !missing.length, JSON.stringify({ mt, scHidden, missing }));

  // ---- MCP: settings get / set ----
  const g = await api('/api/remote', { cmd: 'settings', args: {} }), s = await api('/api/remote', { cmd: 'settings', args: { set: { thumbs: false } } });
  const bad = await api('/api/remote', { cmd: 'settings', args: { set: { pq: 'huge' } } });
  check(`${rm}: the MCP settings command lists every option and sets one (timeline thumbnails off); a bad value is refused`,
    g.ok && g.result.snap.value === false && g.result.versionsKeep.kept === 'this library' && s.ok && s.result.thumbs.value === false && (await ev(() => opt('thumbs'))) === false && !bad.ok && /one of/.test(bad.result), JSON.stringify({ g: g.ok, s: s.ok, bad }));

  // ---- Storage: clear preview cache removes only what can be made again; the editor makes it again ----
  const REGEN = /\.(proxy\.mp4|proxy\.webm|wk\.mov|an\.mp4|strip\.jpg|grid\.jpg|wave\.png|peaks|320\.jpg|320\.png|2560\.jpg|2560\.png)$/;
  const list = d => fs.readdirSync(d).filter(f => !f.startsWith('.')).sort();
  const before = { cache: list(`${HOME}/cache`), media: list(`${HOME}/media`).map(f => `${f}:${fs.statSync(`${HOME}/media/${f}`).size}`).filter(x => !x.includes('.json')), proj: list(`${HOME}/projects`) };
  await keyOpen(); await section('storage');
  await page.waitForFunction(() => /MB|GB/.test($('#setCache')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const sizes = await ev(() => [$('#setCache').textContent, $('#setTrash').textContent]);
  await page.screenshot({ path: `${OUT}${rm}-storage.png` });
  await page.click('[data-setdo="clearcache"]');
  await page.waitForFunction(() => /^Cleared/.test($('#toast').textContent), null, { timeout: 15000 });
  const after = { cache: list(`${HOME}/cache`), media: list(`${HOME}/media`).map(f => `${f}:${fs.statSync(`${HOME}/media/${f}`).size}`).filter(x => !x.includes('.json')), proj: list(`${HOME}/projects`) };
  const keptOther = before.cache.filter(f => !REGEN.test(f) && !/\.tmp\./.test(f)).every(f => after.cache.includes(f)), gone = before.cache.filter(f => REGEN.test(f) && ids.some(id => f.startsWith(id)));
  let rebuilt = false;
  // the test's clips (3 s: made first, shortest first); the rest of a full library keeps being made in the background (minutes for 4K)
  for (let i = 0; i < 120 && !rebuilt; i++) { await sleep(500); rebuilt = ids.every(id => ['grid.jpg', 'wave.png', 'peaks'].every(x => fs.existsSync(`${HOME}/cache/${id}.${x}`))) && (await api('/api/media')).filter(m => ids.includes(m.id)).every(m => m.ready); }
  await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), ids, { timeout: 15000 }).catch(() => {});
  const ui = await ev(ids => ids.every(id => M.get(id)?.grid && M.get(id)?.peaks), ids);
  check(`${rm}: Storage: sizes shown (${sizes.join(' · ')}); Clear preview cache takes only regenerable files (${gone.length} of the test clips'), media, projects and transcripts stay; the filmstrips and waveforms are made again`,
    /MB|GB/.test(sizes[0]) && gone.length >= 4 && keptOther && JSON.stringify(after.media) === JSON.stringify(before.media) && JSON.stringify(after.proj) === JSON.stringify(before.proj) && rebuilt && ui, JSON.stringify({ gone: gone.length, keptOther, rebuilt, ui }));
  page.once('dialog', d => d.accept());
  await page.click('[data-setdo="emptytrash"]');
  await page.waitForFunction(() => /^Trash emptied/.test($('#toast').textContent), null, { timeout: 15000 }).catch(() => {});
  check(`${rm}: Empty trash asks first, then the trash is empty`, (await api('/api/settings/storage')).trash === 0);

  // ---- About ----
  await section('about'); await page.click('[data-setdo="third"]');
  await page.waitForFunction(() => $('#setThird').textContent && !$('#setThird').hidden, null, { timeout: 5000 }).catch(() => {});
  const ab = await ev(() => [$('[data-sec="about"] .setrow b').textContent, $('#setThird').textContent.slice(0, 40), $('[data-sec="about"]').textContent.includes('General Public License v3')]);
  check(`${rm}: About: version, the GPL v3 licence, the third-party list, where the log is`, /Cutroom 1\./.test(ab[0]) && /Third-party/.test(ab[1]) && ab[2], JSON.stringify(ab));
  await page.keyboard.press('Escape');

  // ---- a reload keeps it all ----
  await open();
  await keyOpen();
  const kept = await ev(() => ({ ratio: $('#set-ratio').value, gen: $('#set-versionsKeep').value, snap: opt('snap'), pq: $('#pqSel').value, loop: opt('loop'), music: opt('ai.music'), d: KEYBY.get('KeyD'), dir: opt('exportDir'), musicBtn: getComputedStyle($('#btnMusic')).display }));
  check(`${rm}: after a reload every choice is still there (and AI music's button still gone)`,
    kept.ratio === '16:9' && kept.gen === '120' && kept.snap === false && kept.pq === 'half' && kept.loop === true && kept.music === false && kept.d === 'split' && /exdir/.test(kept.dir) && kept.musicBtn === 'none', JSON.stringify(kept));

  // ---- reset this section, then reset all ----
  await section('editing'); await page.click('[data-setdo="resetsec"]'); await page.waitForTimeout(200);
  const r1 = await ev(() => ({ snap: opt('snap'), td: opt('textDur'), tr: opt('trType'), thumbs: opt('thumbs'), pq: opt('pq'), ratio: opt('ratio'), box: $('#set-snap').checked }));
  await page.click('[data-setdo="resetall"]'); await page.waitForTimeout(800);
  const r2 = await ev(() => ({ pq: $('#pqSel').value, ratio: opt('ratio'), fps: opt('fps'), loop: opt('loop'), music: opt('ai.music'), musicBtn: getComputedStyle($('#btnMusic')).display, d: KEYBY.get('KeyD') ?? null, s: KEYBY.get('KeyS'), motion: document.documentElement.dataset.motion ?? null, preset: opt('preset') }));
  const lib2 = (await api('/api/settings')).lib;
  check(`${rm}: Reset this section brings Editing back (snapping on, 3 s text, no transition) and leaves Playback; Reset all brings everything back`,
    r1.snap && r1.box && r1.td === 3 && r1.tr === 'none' && r1.thumbs && r1.pq === 'half' && r1.ratio === '16:9'
    && r2.pq === 'auto' && r2.ratio === '9:16' && r2.fps === 30 && !r2.loop && r2.music && r2.musicBtn !== 'none' && r2.d === null && r2.s === 'split' && r2.motion === null && r2.preset === '' && !Object.keys(lib2).length,
    JSON.stringify({ r1, r2, lib2 }));
  await page.screenshot({ path: `${OUT}${rm}-reset.png` });
  check(`${rm}: no page errors`, !errs.length, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
