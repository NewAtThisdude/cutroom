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
import { execFileSync, spawnSync } from 'node:child_process';
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
for (const [k, trc] of [['hlg', 'arib-std-b67'], ['pq', 'smpte2084']]) { // real HDR sources (10-bit HEVC tagged BT.2020 HLG / PQ)
  if (!fs.existsSync(`${OUT}hdr-${k}.mp4`)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-vf', `format=p010le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=${trc}:range=tv`, '-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', `${OUT}hdr-${k}.mp4`]);
  if (!(await api('/api/media')).some(m => m.name === `hdr-${k}.mp4`)) await fetch(`${B}/api/import?name=hdr-${k}.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(`${OUT}hdr-${k}.mp4`) });
}
for (const n of [CLIP, PIC]) if (!(await api('/api/media')).some(m => m.name === n)) await fetch(`${B}/api/import?name=${n}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(OUT + n) });
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const media = await api('/api/media'), hdrIds = Object.fromEntries(['hlg', 'pq'].map(k => [k, media.find(m => m.name === `hdr-${k}.mp4`).id])), clipId = media.find(m => m.name === CLIP).id, picId = media.find(m => m.name === PIC).id;

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
  await ev(() => { setScope({ on: true }); meterSet(true); });
  const vis0 = await ev(() => [getComputedStyle($('#scope')).display, getComputedStyle($('#meter')).display]);
  await page.click('#btnFullscreen'); await page.waitForTimeout(200);
  const vis1 = await ev(() => [getComputedStyle($('#scope')).display, getComputedStyle($('#meter')).display]);
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
  await ev(() => { setScope({ on: false }); meterSet(false); });
  check(`${rm}: the scopes and the loudness meter hide in full screen (picture alone) and come back after it`, vis0.every(d => d !== 'none') && vis1.every(d => d === 'none') && await ev(() => !document.body.classList.contains('fs')), JSON.stringify({ vis0, vis1 }));
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
  const uBase = await ev(() => undo.length);
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
  check(`${rm}: next and previous walk the matches (wrapping), the playhead and selection go to the caption`, JSON.stringify(nav.map(n => n[0])) === '["2 of 3","3 of 3","1 of 3","3 of 3"]' && nav.every(n => n[2]) && nav[3][1] >= 2, JSON.stringify(nav));
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
  const r3x = await api('/api/remote', { cmd: 'caption_find_replace', args: { find: 'Hello', replace: 'Hi', wholeWord: true, matchCase: true }, timeout: 30 });
  const rem = await ev(() => [P.captions[0].text, undo.length]);
  check(`${rm}: the MCP command lists matches (2) without replace, replaces with it (match case honoured: HELLO finds none, Hello 1), one undo step`,
    r1.ok && r1.result.matches === 2 && r1.result.first.length === 2 && r2.ok && r2.result.replaced === 0 && r3x.ok && r3x.result.replaced === 1 && rem[0] === 'Hi world, hello there' && rem[1] === u4 + 1, JSON.stringify({ r1, r2, r3x, rem }));
  await ev(u => { while (undo.length > u) restore(undo, redo); }, uBase);

  // ---- 3. cover image ----
  const EXD = `${HOME}/exports`, probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:stream_disposition=attached_pic', '-of', 'json', f]).toString()).streams;
  const rgb = f => [...execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
  const sim = (a, b2) => { const r = spawnSync('ffmpeg', ['-i', a, '-i', b2, '-lavfi', '[1:v][0:v]scale2ref[y][x];[x][y]ssim', '-f', 'null', '-'], { encoding: 'utf8' }); return +(/All:([\d.]+)/.exec(r.stderr)?.[1] || 0); };
  const doExport = async (fmt, o) => { // through the dialog: the cover options, then Export; -> the status text and the saved file name
    await page.click('#btnExport'); await page.waitForSelector('#exFmt');
    await page.fill('#exName', o.name); await page.selectOption('#exRes', '0'); await page.selectOption('#exFmt', fmt);
    if (o.hdr) await page.selectOption('#exHdr', o.hdr);
    const on = await page.isEnabled('#exCover');
    if (on) {
      await page.setChecked('#exCover', o.cover !== false);
      if (o.cover !== false) { await page.selectOption('#exCvSrc', o.src || 'frame'); if (o.img) await page.selectOption('#exCvImg', o.img); await page.fill('#exCvTitle', o.title || ''); await page.selectOption('#exCvPreset', o.preset || 'Title'); await page.selectOption('#exCvFmt', o.cfmt || 'jpg'); }
    }
    await page.click('#exGo');
    await page.waitForFunction(() => /Saved|failed/.test($('#exStatus')?.textContent || ''), null, { timeout: 180000 });
    const out = await ev(() => ({ s: $('#exStatus').textContent, f: $('#exStatus b')?.textContent }));
    await page.keyboard.press('Escape');
    return { ...out, on };
  };
  await ev(() => { while (P.captions.length) P.captions.pop(); S.t = 1; });
  const nogif = await (async () => { await page.click('#btnExport'); await page.waitForSelector('#exFmt'); await page.selectOption('#exFmt', 'gif'); const d = await page.isDisabled('#exCover'), hid = await ev(() => $('#exCoverBox').hidden); await page.keyboard.press('Escape'); return d && hid; })();
  const nm = `qcover-${rm}`;
  const plain = await doExport('mp4', { name: `${nm}-plain`, cover: false });
  const withT = await doExport('mp4', { name: `${nm}-title`, title: 'COVER TITLE', cfmt: 'jpg' });
  const sA = probe(`${EXD}/${nm}-title.mp4`), sP = probe(`${EXD}/${nm}-plain.mp4`);
  const pic = `${EXD}/${nm}-title.jpg`, magic = fs.existsSync(pic) ? fs.readFileSync(pic).subarray(0, 3).toString('hex') : '';
  check(`${rm}: Export with a cover: the MP4 carries it as its attached_pic (ffprobe: mjpeg, attached_pic 1), a JPG lands next to it; without the option there is neither`,
    plain.f === `${nm}-plain.mp4` && withT.f === `${nm}-title.mp4` && sA.some(s => s.codec_name === 'mjpeg' && s.disposition.attached_pic === 1) && sA.filter(s => s.codec_type === 'video').length === 2 && magic === 'ffd8ff' && !sP.some(s => s.disposition.attached_pic) && !fs.existsSync(`${EXD}/${nm}-plain.jpg`) && nogif, JSON.stringify({ plain, withT, sA, magic, nogif }));
  // the title is drawn: the same frame without a title differs
  const noT = await doExport('mp4', { name: `${nm}-notitle`, cfmt: 'png' });
  const s1 = sim(pic, `${EXD}/${nm}-notitle.png`);
  check(`${rm}: the title is drawn on the cover (same frame with and without it: similarity ${s1.toFixed(3)} < 0.995), and a PNG cover embeds as png`,
    s1 > 0 && s1 < 0.995 && probe(`${EXD}/${nm}-notitle.mp4`).some(s => s.codec_name === 'png' && s.disposition.attached_pic === 1) && noT.on, String(s1));
  // a library picture as the cover
  const im = await doExport('mp4', { name: `${nm}-image`, src: 'image', img: picId, cfmt: 'png' });
  const [r, g, bl] = rgb(`${EXD}/${nm}-image.png`);
  check(`${rm}: a picture from the library as the cover (the blue 800x800 picture fills the frame: rgb ${r},${g},${bl}), embedded`,
    Math.abs(r - 34) < 14 && Math.abs(g - 85) < 14 && Math.abs(bl - 170) < 14 && probe(`${EXD}/${nm}-image.mp4`).some(s => s.disposition.attached_pic === 1), JSON.stringify({ im, rgb: [r, g, bl] }));
  // a MOV cannot carry one: the picture is saved beside it, and the dialog says so
  const mov = await doExport('prores', { name: `${nm}-mov`, title: 'MOV' });
  check(`${rm}: a ProRes MOV gets the picture beside it only (ffmpeg's MOV writer has no cover), and the dialog says so`,
    fs.existsSync(`${EXD}/${nm}-mov.mov`) && fs.existsSync(`${EXD}/${nm}-mov.jpg`) && !probe(`${EXD}/${nm}-mov.mov`).some(s => s.disposition.attached_pic) && /MOV cannot carry/.test(mov.s), mov.s);
  // a cover never replaces another export: an existing picture of the same name survives, and two exports of one name keep their own covers
  fs.writeFileSync(`${EXD}/${nm}-keep.png`, 'earlier still export');
  const keep = await doExport('mp4', { name: `${nm}-keep`, title: 'KEEP', cfmt: 'png' });
  const md5 = f => execFileSync('md5', ['-q', f]).toString().trim();
  check(`${rm}: an earlier still export of the same name survives (the new MP4 and its cover take "(2)")`,
    fs.readFileSync(`${EXD}/${nm}-keep.png`, 'utf8') === 'earlier still export' && keep.f === `${nm}-keep (2).mp4` && fs.existsSync(`${EXD}/${nm}-keep (2).png`) && fs.statSync(`${EXD}/${nm}-keep (2).png`).size > 1000, JSON.stringify(keep));
  const same1 = await doExport('mp4', { name: `${nm}-same`, title: 'ONE' }), h1 = md5(`${EXD}/${nm}-same.jpg`);
  const same2 = await doExport('prores', { name: `${nm}-same`, title: 'TWO' });
  check(`${rm}: the same name as MP4 then ProRes keeps both covers (${nm}-same.jpg untouched; the MOV and its cover are "(2)")`,
    same1.f === `${nm}-same.mp4` && same2.f === `${nm}-same (2).mov` && md5(`${EXD}/${nm}-same.jpg`) === h1 && fs.existsSync(`${EXD}/${nm}-same (2).jpg`) && md5(`${EXD}/${nm}-same (2).jpg`) !== h1, JSON.stringify({ one: same1.f, two: same2.f }));
  // the cover remux (-c copy) keeps the HDR tags
  const tags = f => JSON.stringify(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,codec_tag_string,pix_fmt,color_space,color_transfer,color_primaries,color_range:stream_side_data_list', '-of', 'json', f]).toString()).streams);
  const hdrRes = [], pid0 = await ev(() => P.id);
  for (const k of ['hlg', 'pq']) {
    await ev(async id => { await REMOTE.new_project({ ratio: '16:9', name: 'qhdr' }); addMedia(id, 'main'); }, hdrIds[k]);
    const isHdr = await ev(id => !!M.get(id).hdr, hdrIds[k]);
    await doExport('hevc', { name: `${nm}-${k}-plain`, cover: false, hdr: k }); await doExport('hevc', { name: `${nm}-${k}-cover`, title: k, hdr: k });
    hdrRes.push([k, isHdr, tags(`${EXD}/${nm}-${k}-plain.mp4`), tags(`${EXD}/${nm}-${k}-cover.mp4`), probe(`${EXD}/${nm}-${k}-cover.mp4`).some(x => x.disposition.attached_pic === 1)]);
  }
  await ev(id => openProject(id), pid0); await page.waitForTimeout(500);
  check(`${rm}: a cover keeps the HDR tags (real HLG and PQ sources, HEVC Main 10: codec, tag, pixel format, primaries, transfer, matrix, range and side data identical with and without a cover; the cover is attached)`,
    hdrRes.every(([k, isHdr, a, b2, att]) => isHdr && a === b2 && att && a.includes(k === 'hlg' ? 'arib-std-b67' : 'smpte2084') && a.includes('bt2020') && a.includes('yuv420p10le')), JSON.stringify(hdrRes));
  // remembered per project: saved with it, back after a reload
  await ev(id => { P.cover = { on: true, src: 'image', media: id, title: 'Remembered', preset: 'Title', fmt: 'png' }; scheduleSave(); }, picId);
  await page.waitForTimeout(1500); await open();
  await page.click('#btnExport'); await page.waitForSelector('#exFmt');
  const mem = await ev(() => ({ on: $('#exCover').checked, src: $('#exCvSrc').value, title: $('#exCvTitle').value, fmt: $('#exCvFmt').value, box: !$('#exCoverBox').hidden, p: P.cover?.title }));
  await page.screenshot({ path: `${OUT}${rm}-cover.png` });
  await page.keyboard.press('Escape');
  check(`${rm}: the cover options are kept with the project (on, picture, title "Remembered", PNG) after a reload`, mem.on && mem.src === 'image' && mem.title === 'Remembered' && mem.fmt === 'png' && mem.box && mem.p === 'Remembered', JSON.stringify(mem));
  await ev(() => { delete P.cover; });

  check(`${rm}: no page errors`, !errs.length, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
