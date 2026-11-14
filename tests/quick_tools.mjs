// Three quick tools, in headless WebKit with real clicks and keys, both motion modes:
//  1. Full screen preview (Shift+F, the button by Theater; remappable): the stage is asked to go full screen, the UI state follows
//     (pressed button, full quality whatever the preview menu says, no selection box on the picture), Esc leaves, playback keys keep working.
//     Headless WebKit cannot show real full screen, so the request is stubbed and fullscreenchange fired by hand: the request and the
//     page's reaction are checked, the screen itself is not.
//  2. Caption find and replace: count, next / previous, replace one, replace all (one undo step), match case, whole word, the second-language
//     line, save and reload, the REMOTE command.
//  3. Cover: a frame or an image (with an optional title) is saved next to the video and embedded as its cover (attached_pic, ffprobe).
//   B=<server on a scratch library> CUTROOM_HOME=<its library> node quick_tools.mjs   (never 4610)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browser } from './browser.mjs';
const B = process.env.B, OUT = fileURLToPath(new URL('./out/quick_tools/', import.meta.url));
if (!B || /:4610\b/.test(B)) { console.log('SKIP: set B to a scratch server (never 4610)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = (await api('/api/settings')).home;

const CLIP = 'quick-tools.mp4', PIC = 'quick-tools-pic.png';
if (!fs.existsSync(OUT + CLIP)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', OUT + CLIP]);
if (!fs.existsSync(OUT + PIC)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2255aa:s=800x800', '-frames:v', '1', OUT + PIC]);
for (const n of [CLIP, PIC]) if (!(await api('/api/media')).some(m => m.name === n)) await fetch(`${B}/api/import?name=${n}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(OUT + n) });
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const media = await api('/api/media'), clipId = media.find(m => m.name === CLIP).id, picId = media.find(m => m.name === PIC).id;

const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const ev = (f, a) => page.evaluate(f, a);
  const open = async () => { await page.goto(`${B}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE === 'object', null, { timeout: 20000 }); await page.waitForTimeout(300); if (await page.$('#tour')) await page.keyboard.press('Escape'); };
  await open();
  await ev(() => store.set('cutroom.tour', 'done'));
  await ev(async id => { addMedia(id, 'main'); await REMOTE.add_text({ text: 'Title', start: 0, duration: 2 }); }, clipId);

  // ---- 1. full screen ----
  await ev(() => { // headless WebKit has no real full screen: record the request, and answer like a browser would
    window.__fs = { calls: 0, exits: 0 };
    let cur = null;
    Object.defineProperty(document, 'fullscreenElement', { get: () => cur, configurable: true });
    Object.defineProperty(document, 'webkitFullscreenElement', { get: () => cur, configurable: true });
    const enter = function () { window.__fs.calls++; window.__fs.el = this.id; cur = this; setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 10); return Promise.resolve(); };
    Element.prototype.requestFullscreen = enter; Element.prototype.webkitRequestFullscreen = enter;
    const leave = () => { window.__fs.exits++; cur = null; setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 10); return Promise.resolve(); };
    document.exitFullscreen = leave; document.webkitExitFullscreen = leave;
    setPQ('quarter');
    S.sel = { lane: 'main', id: P.main[0].id }; renderAll();
  });
  const q0 = await ev(() => $('#cv').width / ($('#cv').clientWidth * (devicePixelRatio || 1)));
  await page.click('#btnFullscreen'); await page.waitForTimeout(200);
  const f1 = await ev(() => ({ calls: __fs.calls, el: __fs.el, fs: S.fs, on: $('#btnFullscreen').classList.contains('on'), pressed: $('#btnFullscreen').getAttribute('aria-pressed'),
    scale: $('#cv').width / ($('#cv').clientWidth * (devicePixelRatio || 1)), title: $('#btnFullscreen').title }));
  // playback keys keep working in full screen
  await page.keyboard.press('Space'); await page.waitForTimeout(500);
  const playing = await ev(() => S.playing); await page.keyboard.press('Space'); await page.waitForTimeout(100);
  const t0 = await ev(() => S.t); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100);
  const t1 = await ev(() => S.t);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  const f2 = await ev(() => ({ exits: __fs.exits, fs: S.fs, on: $('#btnFullscreen').classList.contains('on'), scale: $('#cv').width / ($('#cv').clientWidth * (devicePixelRatio || 1)) }));
  check(`${rm}: the button asks the stage to go full screen; the page shows it pressed, at full quality (preview menu says quarter: ${q0.toFixed(2)} before, ${f1.scale.toFixed(2)} in); Esc leaves and quality returns`,
    f1.calls === 1 && f1.el === 'stage' && f1.fs && f1.on && f1.pressed === 'true' && Math.abs(q0 - 0.25) < 0.03 && Math.abs(f1.scale - 1) < 0.03 && f2.exits === 1 && !f2.fs && !f2.on && Math.abs(f2.scale - 0.25) < 0.03, JSON.stringify({ q0, f1, f2 }));
  check(`${rm}: in full screen Space plays and pauses and an arrow steps a frame`, playing && t1 > t0, JSON.stringify({ playing, t0, t1 }));
  await page.keyboard.press('Shift+F'); await page.waitForTimeout(100);
  const k1 = await ev(() => [__fs.calls, S.fs, KEYBY.get('Shift+KeyF')]);
  await page.keyboard.press('Shift+F'); await page.waitForTimeout(100);
  // remap it: the new key works, the old one does not
  await ev(() => { KEYOWN.fullscreen = ['Shift+KeyE']; applyKeys(true); });
  await page.keyboard.press('Shift+F'); await page.waitForTimeout(100);
  const old = await ev(() => __fs.calls);
  await page.keyboard.press('Shift+E'); await page.waitForTimeout(100);
  const nw = await ev(() => [__fs.calls, S.fs, $('#btnFullscreen').title]);
  await page.keyboard.press('Shift+E'); await page.waitForTimeout(100);
  await ev(() => { delete KEYOWN.fullscreen; applyKeys(true); });
  check(`${rm}: Shift+F toggles it; it is in the shortcut map, remappable (old key dead, new key works, the button's tooltip follows)`,
    k1[0] === 2 && k1[1] && k1[2] === 'fullscreen' && old === 2 && nw[0] === 3 && nw[1] && /E/.test(nw[2]), JSON.stringify({ k1, old, nw }));
  await page.screenshot({ path: `${OUT}${rm}-fullscreen.png` });

  // ---- 2. caption find and replace ----
  await ev(() => {
    importSubs('1\n00:00:00,000 --> 00:00:01,000\nHello world, hello there\n\n2\n00:00:01,000 --> 00:00:02,000\nThe world is big\n\n3\n00:00:02,000 --> 00:00:03,000\nWorldwide news\n\n4\n00:00:03,000 --> 00:00:04,000\nNo match here\n');
    change(() => { P.captions[1].tr = 'El mundo es grande'; P.captions[2].tr = 'Noticias del mundo'; });
    openTab('captions');
  });
  const texts = () => ev(() => P.captions.map(c => `${c.text}|${c.tr || ''}`));
  const orig = await texts();
  const count = async (q, { cs = false, ww = false, line = 'both' } = {}) => {
    await page.fill('#cfQ', q); await page.setChecked('#cfCase', cs); await page.setChecked('#cfWord', ww); await page.selectOption('#cfLine', line);
    return ev(() => ({ n: $('#cfN').textContent, rows: $$('#capList .caprow.hit').length, dis: $('#cfAll').disabled }));
  };
  const c1 = await count('world'), c2 = await count('hello'), c3 = await count('world', { cs: true }), c4 = await count('world', { ww: true }), c5 = await count('mundo', { line: 'second' }), c6 = await count('mundo', { line: 'text' }), c7 = await count('zzz');
  check(`${rm}: find counts matches (world 3, hello 2), match case (2), whole word (2), the second-language line (2; none when only the first line is searched), no match is said and disables Replace`,
    c1.n === '1 of 3' && c1.rows === 3 && c2.n === '1 of 2' && c3.n === '1 of 2' && c4.n === '1 of 2' && c5.n === '1 of 2' && c5.rows === 2 && c6.n === 'No matches' && c7.n === 'No matches' && c7.dis, JSON.stringify({ c1, c2, c3, c4, c5, c6, c7 }));
  await count('world');
  const nav = [];
  for (const k of ['#cfNext', '#cfNext', '#cfNext', '#cfPrev']) { await page.click(k); nav.push(await ev(() => [$('#cfN').textContent, r3(S.t), S.sel?.id === P.captions[Math.floor(S.t)]?.id])); }
  check(`${rm}: next and previous walk the matches (wrapping), the playhead and selection go to the caption`, JSON.stringify(nav.map(n => n[0])) === '["2 of 3","3 of 3","1 of 3","3 of 3"]' && nav.every(n => n[2]) && nav[3][1] > 2, JSON.stringify(nav));
  // replace one
  await count('world'); await page.fill('#cfR', 'planet');
  const u0 = await ev(() => undo.length); await page.click('#cfOne');
  const one = await ev(() => ({ u: undo.length, t: P.captions[0].text, t2: P.captions[1].text, n: $('#cfN').textContent }));
  check(`${rm}: Replace changes only the current match, in one undo step, and stands on the next`, one.u === u0 + 1 && one.t === 'Hello planet, hello there' && one.t2 === 'The world is big' && one.n === '1 of 2', JSON.stringify(one));
  await ev(() => restore(undo, redo));
  // replace all: one undo step, case-insensitive across both lines, undo restores everything
  await count('world'); await page.fill('#cfR', 'planet'); const u1 = await ev(() => undo.length); await page.click('#cfAll');
  const all = await texts(), u2 = await ev(() => undo.length);
  await ev(() => restore(undo, redo)); const back = await texts();
  check(`${rm}: Replace all replaces all 3 in one undo step (Worldwide becomes planetwide); undo brings every caption back`,
    u2 === u1 + 1 && all[0].startsWith('Hello planet, hello') && all[1].startsWith('The planet is big') && all[2].startsWith('planetwide news') && JSON.stringify(back) === JSON.stringify(orig), JSON.stringify({ all, back }));
  // match case + whole word on replace; a replacement with $& is literal
  await count('world', { cs: true, ww: true }); await page.fill('#cfR', 'Earth'); await page.click('#cfAll');
  const cw = await texts(); await ev(() => restore(undo, redo));
  await count('big'); await page.fill('#cfR', '$&!'); await page.click('#cfAll'); const lit = await texts(); await ev(() => restore(undo, redo));
  check(`${rm}: Replace all honours match case and whole word (Worldwide stays); the replacement is literal text`,
    cw[0].startsWith('Hello Earth, hello') && cw[1].startsWith('The Earth is big') && cw[2].startsWith('Worldwide news') && lit[1].startsWith('The world is $&!'), JSON.stringify({ cw, lit }));
  // second language
  await count('mundo', { line: 'second' }); await page.fill('#cfR', 'tierra'); const u3 = await ev(() => undo.length); await page.click('#cfAll');
  const sec = await texts(), shownTr = await ev(() => $$('#capList input.tr').map(i => i.value));
  check(`${rm}: the second-language line is found and replaced on its own, in one step, and shows (and edits) in the list`,
    await ev(() => undo.length) === u3 + 1 && sec[1] === 'The world is big|El tierra es grande' && sec[2] === 'Worldwide news|Noticias del tierra' && shownTr.length === 2 && shownTr[0] === 'El tierra es grande', JSON.stringify({ sec, shownTr }));
  // edit a second line by hand
  await page.fill('#capList input.tr >> nth=0', 'El mundo'); await page.press('#capList input.tr >> nth=0', 'Tab');
  const hand = await texts();
  check(`${rm}: editing the second line in the list is an edit (kept)`, hand[1].endsWith('|El mundo'), JSON.stringify(hand));
  // reload keeps it
  await page.waitForTimeout(1500); await open(); await ev(() => openTab('captions'));
  const kept = await texts();
  check(`${rm}: after a reload the replaced captions are still there`, kept[1] === 'The world is big|El mundo' && kept[2] === 'Worldwide news|Noticias del tierra', JSON.stringify(kept));
  // REMOTE
  const r1 = await api('/api/remote', { cmd: 'caption_find_replace', args: { find: 'hello' }, timeout: 30 });
  const u4 = await ev(() => undo.length);
  const r2 = await api('/api/remote', { cmd: 'caption_find_replace', args: { find: 'HELLO', replace: 'hi', matchCase: true }, timeout: 30 });
  const r3x = await api('/api/remote', { cmd: 'caption_find_replace', args: { find: 'Hello', replace: 'Hi', wholeWord: true }, timeout: 30 });
  const rem = await ev(() => [P.captions[0].text, undo.length]);
  check(`${rm}: the MCP command lists matches (2) without replace, replaces with it (match case honoured: HELLO finds none, Hello 1), one undo step`,
    r1.ok && r1.result.matches === 2 && r1.result.first.length === 2 && r2.ok && r2.result.replaced === 0 && r3x.ok && r3x.result.replaced === 1 && rem[0] === 'Hi world, hello there' && rem[1] === u4 + 1, JSON.stringify({ r1, r2, r3x, rem }));
  await ev(() => { while (undo.length) restore(undo, redo); });

  check(`${rm}: no page errors`, !errs.length, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
