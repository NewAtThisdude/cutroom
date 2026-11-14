// Paste attributes (a checklist of what of the copied clip goes onto the selected clips) and Before / after (the picture without
// its colour work on one side of a draggable line), both motion modes, in headless WebKit.
//  paste attributes: every category lands right and ONLY it (the rest of the target is exactly as it was); undo restores all
//  targets in one step (redo again); keyframes scale to the target's length or keep their times; a sound / title target takes what
//  applies and the rest is skipped with a note; the checklist (and the keyframe choice) is remembered across a reload; the key,
//  the context menu and REMOTE.paste_attributes work; the export of the target equals the export of the source's look on the
//  same media; save + reload keeps it.
//  before / after: left of the line equals an ungraded render, right equals the graded one (GPU pass and JS fallback, the line
//  anywhere); the selected clip only vs the whole frame; side by side; effects optional; exports unaffected; the line drags; it
//  keeps showing while playing.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node attrs_compare.mjs   (never the 4610 server)
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const B = process.env.B, OUT = fileURLToPath(new URL('./out/attrs/', import.meta.url));
if (!B || /:4610\b/.test(B)) { console.log('SKIP: set B to a scratch server (never 4610)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-attrs-`), file = `${tmp}/attrs-a.mp4`, pic = `${tmp}/attrs-i.png`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-shortest', file]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-frames:v', '1', pic]);
const imp = async f => (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id;
const A = await imp(file), I = await imp(pic);
fs.rmSync(tmp, { recursive: true });

const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => { if (!/\/luts\/L1\.cube/.test(e.message)) errs.push(e.message); }); // the paste checks copy a LUT reference (id L1) that is not in this scratch library: its fetch is refused, by design
  const ev = (f, a) => page.evaluate(f, a);
  const open = async () => {
    await page.goto(`${B}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
    await ev(() => { store.set('cutroom.tour', 'done'); return loadMedia(); });
    await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), [A, I], { timeout: 60000 });
    if (await page.$('#tour')) await page.keyboard.press('Escape');
  };
  await open();

  // ---------------- paste attributes ----------------
  // the source has every attribute; the targets have their own, different ones. Source: 3 s at 1.5x (2 s); targets: 2 s at 1x (2 s), so
  // keyframe retiming is the identity in these checks and a length change only happens where a test makes one.
  const setup = () => ev(async A => {
    setProject(newProject('16:9')); P.name = 'Attrs (scratch)'; S.sel = null; S.multi.clear(); store.set('cutroom.attrs', '');
    const mk = () => { addMedia(A, 'main'); return P.main.at(-1); };
    const s = mk();
    Object.assign(s, { in: 0, out: 3, speed: 1.5, pitch: true, volume: 0.5, denoise: true, studio: 'on', au: { semi: 2, bass: 3, mid: 0, treb: 0, pan: 0.2 }, vkf: [{ t: 0, v: 1 }, { t: 1.5, v: 0.5 }],
      adj: { b: 1.1, c: 1.2, s: 0.8, temp: 0.3, tint: -0.1, ex: 0.2, hi: -0.2, sh: 0.3, fade: 0.1, vig: 0.4, blur: 0.2, pix: 0.1, sharp: 0.3 },
      look: { name: 'teal', amount: 0.8 }, lkf: [{ t: 0, v: 0.2 }, { t: 1.5, v: 1 }],
      grade: { lift: { x: 0.3, y: -0.2, l: 0.1 }, gamma: { x: 0, y: 0.1, l: 0.2 }, gain: { x: -0.2, y: 0.2, l: 0 }, curves: { m: [[0, 0.1], [1, 0.9]] }, hsl: { red: { h: 0.5, s: 0.2, l: 0 } }, lut: { id: 'L1', amount: 0.5 } },
      beauty: { amt: 0.5 }, glow: { color: '#00ffff', size: 0.3 }, key: { color: '#00ff00', sim: 0.3, blend: 0.1 }, mb: 0.3,
      mask: { type: 'circle', x: 0.1, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0.1, invert: false }, mkf: [{ t: 0, x: 0.1, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0.1 }, { t: 1.5, x: -0.1, y: 0.1, w: 0.6, h: 0.5, rot: 10, feather: 0.1 }],
      fit: 'fill', scale: 0.8, x: 0.1, y: -0.1, rot: 10, opacity: 0.9, crop: { l: 0.1, r: 0.1, t: 0, b: 0 }, flip: true,
      anim: { in: 'fade', ind: 0.5, out: 'none', outd: 0.5, loop: 'none', amt: 1 }, fadeIn: 0.3, fadeOut: 0.2, tr: { type: 'fade', d: 0.5 },
      kf: [{ t: 0, scale: 0.8, x: 0.1, y: -0.1, rot: 10, opacity: 0.9 }, { t: 1.5, scale: 1, x: 0, y: 0, rot: 0, opacity: 1 }] });
    const tg = [];
    for (let i = 0; i < 3; i++) {
      const c = mk();
      Object.assign(c, { in: 0, out: 2, speed: 1, volume: 1.2 + i * 0.1, adj: { b: 0.9, c: 0.9, s: 1.1, temp: -0.2 + i * 0.1 }, look: { name: 'warm', amount: 0.5 }, grade: { gain: { x: 0.1, y: 0.1, l: 0.1 } },
        scale: 0.5 + i * 0.1, x: -0.2, fadeIn: 0.1, anim: { in: 'grow', ind: 0.3, out: 'none', outd: 0.5, loop: 'none', amt: 1 }, mask: { type: 'rect', x: 0, y: 0, w: 0.9, h: 0.9, rot: 0, feather: 0, invert: false } });
      tg.push(c);
    }
    packMain(); renderAll();
    return { s: s.id, tg: tg.map(c => c.id) };
  }, A);
  const CATS = { adjust: ['adj.b', 'adj.c', 'adj.s', 'adj.temp', 'adj.tint', 'adj.ex', 'adj.hi', 'adj.sh', 'adj.fade'], look: ['look', 'lkf', 'grade.lut'], grade: ['grade.lift', 'grade.gamma', 'grade.gain'], curves: ['grade.curves'], hsl: ['grade.hsl'],
    effects: ['adj.vig', 'adj.blur', 'adj.pix', 'adj.sharp', 'beauty', 'glow', 'key', 'mb'], masks: ['mask', 'mkf'], transform: ['fit', 'scale', 'x', 'y', 'rot', 'opacity', 'crop', 'flip'], speed: ['speed', 'pitch'],
    audio: ['volume', 'denoise', 'studio', 'au', 'vkf'], anim: ['anim', 'fadeIn', 'fadeOut'], trans: ['tr'], kf: ['kf'] };
  // a category on its own: its fields (and no others) now equal the source's; everything else is exactly as before
  const one = (k, fields, ids) => ev(async ([k, fields, ids]) => {
    const src = P.main.find(c => c.id === ids.s), tgt = P.main.find(c => c.id === ids.tg[0]), before = structuredClone(tgt);
    const get = (o, p) => p.split('.').reduce((x, q) => x?.[q], o);
    const setp = (o, p, v) => { const q = p.split('.'), l = q.pop(), t = q.reduce((x, y) => (x[y] ??= {}), o); if (v === undefined) delete t[l]; else t[l] = structuredClone(v); };
    const exp = structuredClone(before);
    for (const f of fields) setp(exp, f, get(src, f));
    if (exp.grade && !Object.keys(exp.grade).length) delete exp.grade;
    const n = undo.length;
    await REMOTE.paste_attributes({ from: ids.s, to: [ids.tg[0]], categories: [k] });
    const got = P.main.find(c => c.id === ids.tg[0]), changed = fields.every(f => JSON.stringify(get(got, f)) === JSON.stringify(get(src, f)));
    const gt = JSON.parse(JSON.stringify(got)), ex = JSON.parse(JSON.stringify(exp)), rest = JSON.stringify(gt) === JSON.stringify(ex), steps = undo.length - n;
    restore(undo, redo);
    const back = JSON.stringify(P.main.find(c => c.id === ids.tg[0])) === JSON.stringify(before);
    return { changed, rest, steps, back, diff: rest ? '' : Object.keys({ ...gt, ...ex }).filter(x => JSON.stringify(gt[x]) !== JSON.stringify(ex[x])).join(',') };
  }, [k, fields, ids]);
  let ids = await setup();
  const bad = [];
  for (const [k, fields] of Object.entries(CATS)) {
    const r = await one(k, fields, ids);
    if (!(r.changed && r.rest && r.steps === 1 && r.back)) bad.push(`${k}: ${JSON.stringify(r)}`);
  }
  check(`${rm}: each of the 13 categories alone lands exactly its fields, leaves the rest untouched, is one undo step that undo restores`, !bad.length, bad.join(' | '));

  // several targets, several categories, ONE undo step; redo brings it back
  const multi = await ev(async ids => {
    const before = JSON.stringify(P), n = undo.length;
    const r = await REMOTE.paste_attributes({ from: ids.s, to: ids.tg, categories: ['adjust', 'look', 'masks', 'transform', 'audio'] });
    const after = JSON.stringify(P), steps = undo.length - n;
    const ok = ids.tg.every(id => { const c = P.main.find(x => x.id === id); return c.adj.b === 1.1 && c.look.name === 'teal' && c.mask.type === 'circle' && c.scale === 0.8 && c.volume === 0.5 && c.grade.gain.x === 0.1 && c.anim.in === 'grow'; });
    restore(undo, redo); const undone = JSON.stringify(P) === before;
    restore(redo, undo); const redone = JSON.stringify(P) === after;
    restore(undo, redo);
    return { r, steps, ok, undone, redone };
  }, ids);
  check(`${rm}: three targets at once, five categories: one undo step; undo restores all three, redo reapplies`, multi.steps === 1 && multi.ok && multi.undone && multi.redone && multi.r.clips.length === 3, JSON.stringify(multi));

  // keyframes: scaled to a shorter target, or kept at the same times
  const kfs = await ev(async ids => {
    const out = {};
    for (const mode of ['scale', 'abs']) {
      const t = P.main.find(c => c.id === ids.tg[0]); t.out = 1; t.speed = 1; packMain(); // 1 s: half the source's 2 s
      await REMOTE.paste_attributes({ from: ids.s, to: [t.id], categories: ['kf', 'masks', 'audio'], keyframes: mode });
      const c = P.main.find(x => x.id === ids.tg[0]); out[mode] = { kf: c.kf.map(k => [k.t, +k.scale.toFixed(3)]), mkf: c.mkf.map(k => k.t), vkf: c.vkf.map(k => k.t) };
      restore(undo, redo);
    }
    P.main.find(c => c.id === ids.tg[0]).out = 2;
    return out;
  }, ids);
  const sc = kfs.scale, ab = kfs.abs;
  check(`${rm}: keyframes scale to a half-length target (0 and 1.5 s -> 0 and 0.75 s) or keep their times (the one past the end is dropped, the cut keeps where it was heading)`,
    sc.kf.length === 2 && sc.kf[0][0] === 0 && Math.abs(sc.kf[1][0] - 0.75) < 1e-3 && sc.mkf.join() === '0,0.75' && sc.vkf.join() === '0,0.75'
    && ab.kf.length === 2 && ab.kf[0][0] === 0 && Math.abs(ab.kf[1][0] - 1) < 1e-3 && ab.kf[1][1] > 0.8 && ab.kf[1][1] < 1 && ab.mkf.join() === '0' && ab.vkf.join() === '0', JSON.stringify(kfs));

  // across clip kinds: a title and a sound clip take what applies, the rest is skipped with a note
  const kinds = await ev(async ([ids, A]) => {
    S.t = 0; addText('Title', { text: 'Hello' });
    const txt = P.text.at(-1); const au = { id: hex12(), media: A, start: 0, in: 0, out: 2, speed: 1, volume: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } }; P.audio.push(au);
    const r = await REMOTE.paste_attributes({ from: ids.s, to: [txt.id, au.id], categories: ['adjust', 'transform', 'speed', 'audio', 'kf', 'masks'] });
    const a = P.audio.find(c => c.id === au.id), t = P.text.find(c => c.id === txt.id);
    const ok = a.speed === 1.5 && a.volume === 0.5 && a.au.bass === 3 && !a.adj?.temp && !a.mask && !a.kf && !t.adj?.temp && !t.mask && !t.kf?.length;
    return { r, ok };
  }, [ids, A]);
  const skippedTxt = JSON.stringify(kinds.r.skipped);
  check(`${rm}: a sound clip takes speed and sound, a title takes nothing a picture copy has; what was skipped is named`,
    kinds.ok && kinds.r.pasted.includes('speed') && kinds.r.pasted.includes('volume and sound') && /adjust on sound clips/.test(skippedTxt) && /masks on titles/.test(skippedTxt) && /transform on sound clips/.test(skippedTxt), JSON.stringify(kinds));
  await ev(() => { P.text.length = 0; P.audio.length = 0; renderAll(); });

  // the dialog: key, checklist, remembered, context menu
  ids = await setup();
  const select = (src, tg) => ev(([src, tg]) => { S.sel = { lane: 'main', id: src }; S.multi.clear(); copySel(); S.sel = { lane: 'main', id: tg[0] }; S.multi = new Set(tg.slice(1).map(id => `main:${id}`)); renderAll(); }, [src, tg]);
  await select(ids.s, ids.tg);
  const n0 = await ev(() => undo.length);
  await page.keyboard.press('Meta+Alt+KeyV');
  const dlg = await page.waitForSelector('#modal .dialog.attrdlg', { timeout: 5000 }).then(() => true, () => false);
  const boxes = dlg ? await ev(() => $$('[data-attr]').map(x => [x.dataset.attr, x.checked, x.disabled])) : [];
  check(`${rm}: Cmd/Ctrl+Alt+V opens the checklist: 13 categories, all ticked the first time, keyframes scaled by default`, dlg && boxes.length === 13 && boxes.every(([, c, d]) => c && !d) && (await ev(() => $('#attrKf .on').dataset.kfm)) === 'scale', JSON.stringify(boxes.filter(x => !x[1])));
  await page.screenshot({ path: `${OUT}paste-${rm}.png` });
  await page.click('[data-attr="masks"]'); await page.click('[data-attr="trans"]'); await page.click('[data-kfm="abs"]');
  await page.click('[data-attrgo]'); await page.waitForSelector('#modal', { state: 'hidden' });
  await page.waitForFunction(() => P.main.slice(1).every(c => c.look?.name === 'teal'));
  const pasted = await ev(ids => ids.tg.map(id => { const c = P.main.find(x => x.id === id); return [c.look.name, c.mask.type, !!c.tr, c.scale]; }), ids);
  check(`${rm}: unticking masks and transition and pasting: the other categories land on all three clips, masks and transition stay, one undo step`,
    pasted.every(p => p[0] === 'teal' && p[1] === 'rect' && p[2] === false && p[3] === 0.8) && (await ev(() => undo.length)) === n0 + 1, JSON.stringify(pasted));
  await ev(() => restore(undo, redo));
  await page.keyboard.press('Meta+Alt+KeyV'); await page.waitForSelector('#modal .dialog.attrdlg');
  const again = await ev(() => ({ off: $$('[data-attr]').filter(x => !x.checked).map(x => x.dataset.attr).sort().join(), kf: $('#attrKf .on').dataset.kfm }));
  await ev(() => closeModal());
  check(`${rm}: the dialog remembers the last checklist and the keyframe choice`, again.off === 'masks,trans' && again.kf === 'abs', JSON.stringify(again));
  await open();
  await ev(([A]) => { addMedia(A, 'main'); addMedia(A, 'main'); P.main[0].look = { name: 'teal', amount: 1 }; S.sel = { lane: 'main', id: P.main[0].id }; copySel(); S.sel = { lane: 'main', id: P.main[1].id }; renderAll(); }, [A]);
  await page.keyboard.press('Meta+Alt+KeyV'); await page.waitForSelector('#modal .dialog.attrdlg');
  const reloaded = await ev(() => ({ off: $$('[data-attr]').filter(x => !x.checked).map(x => x.dataset.attr).sort().join(), kf: $('#attrKf .on').dataset.kfm }));
  await ev(() => closeModal());
  check(`${rm}: ...and across a reload`, reloaded.off === 'masks,trans' && reloaded.kf === 'abs', JSON.stringify(reloaded));

  ids = await setup(); await select(ids.s, ids.tg);
  await page.click(`.clip[data-id="${ids.tg[0]}"]`, { button: 'right' });
  const mi = await page.$$eval('.ctxmenu button', bs => bs.map(x => [x.textContent, x.disabled]));
  const item = mi.find(([t]) => /Paste attributes/.test(t));
  check(`${rm}: the right-click menu has Paste attributes, with its key`, item && !item[1] && /V/.test(item[0]), JSON.stringify(item));
  await ev(() => closeMenu());

  // export of a target == export of the source's look on the same media (same clip, same time in it)
  ids = await setup();
  const xp = await ev(async ids => {
    const s = P.main.find(c => c.id === ids.s); delete s.tr; delete s.grade.lut; delete s.glow; delete s.key; s.in = 0; s.out = 3;
    P.main = P.main.filter(c => c.id === ids.s || c.id === ids.tg[0]); const t = P.main[1]; t.in = 0; t.out = 3; packMain();
    await REMOTE.paste_attributes({ from: ids.s, to: [t.id], categories: ['adjust', 'look', 'grade', 'curves', 'hsl', 'effects', 'masks', 'transform', 'speed', 'anim', 'kf'] });
    packMain(); S.sel = null; renderAll();
    const t1 = P.main[0].start + 0.5, t2 = P.main[1].start + 0.5;
    const a = await REMOTE.snapshot({ t: t1, max: 640 }), c = await REMOTE.snapshot({ t: t2, max: 640 });
    const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), o = new OffscreenCanvas(320, 180), g = o.getContext('2d'); g.drawImage(im, 0, 0, 320, 180); return g.getImageData(0, 0, 320, 180).data; };
    const [p, q] = [await px(a.image), await px(c.image)]; let sum = 0, mx = 0, flat = 0;
    for (let i = 0; i < p.length; i += 4) for (let k = 0; k < 3; k++) { const dd = Math.abs(p[i + k] - q[i + k]); sum += dd; mx = Math.max(mx, dd); }
    for (let i = 4; i < p.length; i += 4) flat += Math.abs(p[i] - p[i - 4]);
    return { mean: sum / (320 * 180 * 3), mx, flat: flat / (320 * 180), lens: P.main.map(c => +len(c).toFixed(3)), id: P.id, look: t.look?.name, mask: t.mask?.type, scale: t.scale };
  }, ids);
  check(`${rm}: the export of the pasted-on clip equals the export of the source's look on the same media (mean ${xp.mean.toFixed(2)}, worst ${xp.mx} of 255)`, xp.mean < 0.8 && xp.mx < 40 && xp.flat > 0.5 && xp.lens[0] === xp.lens[1], JSON.stringify(xp));
  await page.waitForTimeout(1500);
  await open();
  const back = await ev(async id => { await openProject(id); return P.main[1] && { look: P.main[1].look?.name, mask: P.main[1].mask?.type, scale: P.main[1].scale }; }, xp.id).catch(e => ({ err: e.message }));
  check(`${rm}: the pasted attributes survive save and reload`, back && back.look === xp.look && back.mask === xp.mask && back.scale === xp.scale, JSON.stringify({ xp: [xp.look, xp.mask, xp.scale], back }));

  // ---------------- before / after ----------------
  await ev(async ([A, I]) => {
    setProject(newProject('16:9')); P.name = 'Compare (scratch)'; S.sel = null; S.multi.clear();
    addMedia(A, 'main'); addMedia(A, 'main'); addMedia(I, 'overlay', 0); packMain();
    Object.assign(P.overlay[0], { start: 0, scale: 0.4, x: -0.3, y: 0.3, fit: 'fit' });
    P.main[0].look = { name: 'teal', amount: 0.9 }; P.main[0].adj = { b: 1.2, c: 1.2, s: 0.5, temp: 0.4 };
    P.main[0].grade = { gain: { x: 0.3, y: 0, l: 0.1 }, curves: { m: [[0, 0.1], [0.5, 0.6], [1, 1]] }, hsl: { red: { h: 0.5, s: 0.3 } } };
    P.main[1].adj = { b: 1, c: 1, s: 1, vig: 0.5, blur: 0.15 };
    P.main[1].grade = { lift: { x: -0.3, y: 0.2, l: 0.1 } };
    P.overlay[0].mask = { type: 'circle', x: 0, y: 0, w: 0.8, h: 0.8, rot: 0, feather: 0.1, invert: false };
    P.overlay[0].grade = { gain: { x: 0.4, y: 0.4, l: 0 } };
    renderAll();
  }, [A, I]);
  const T1 = 0.6, wait = () => page.waitForTimeout(250);
  const grab = (t = T1) => ev(async t => (await REMOTE.snapshot({ t, max: 640, preview: true })).image, t);
  const px = img => ev(async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), o = new OffscreenCanvas(im.width, im.height), g = o.getContext('2d'); g.drawImage(im, 0, 0); return { w: im.width, h: im.height, d: g.getImageData(0, 0, im.width, im.height).data }; }, img).then(r => ({ ...r, d: Object.values(r.d) }));
  const region = (a, c, x0, x1) => { let s = 0, mx = 0, n = 0; for (let y = 0; y < a.h; y++) for (let x = x0; x < x1; x++) for (let k = 0; k < 3; k++) { const i = (y * a.w + x) * 4 + k, d = Math.abs(a.d[i] - c.d[i]); s += d; mx = Math.max(mx, d); n++; } return { mean: s / Math.max(1, n), mx }; };
  // the ungraded reference, made by hand (what the before side must look like): `which` = 'all' | 'main0'
  const plainOf = async (which, fx = false) => {
    await ev(([which, fx]) => { REMOTE.compare({ on: false }); window.__keep = JSON.stringify(P); const sel = S.sel;
      for (const c of [...P.main, ...P.overlay]) { if (which === 'main0' && c !== P.main[0]) continue; delete c.look; delete c.grade; delete c.lkf; c.adj = { b: 1, c: 1, s: 1, ...(fx ? {} : Object.fromEntries(['vig', 'blur', 'pix', 'sharp'].filter(k => c.adj?.[k] !== undefined).map(k => [k, c.adj[k]]))) }; }
      S.sel = null; S.dirty = true; window.__sel = sel; }, [which, fx]);
    await wait(); const r = await px(await grab());
    await ev(() => { const p = JSON.parse(window.__keep); for (const k of Object.keys(p)) P[k] = p[k]; S.sel = window.__sel; S.dirty = true; });
    await wait(); return r;
  };

  for (const [label, jsOnly] of [['GPU pass', false], ['JS fallback', true]]) {
    if (jsOnly) await ev(() => { GPU.gl = null; GPU.failed = true; });
    await ev(() => { S.sel = { lane: 'main', id: P.main[0].id }; S.multi.clear(); REMOTE.compare({ on: false }); }); await wait();
    const graded = await px(await grab()), plain = await plainOf('all');
    await ev(() => REMOTE.compare({ on: true, mode: 'split', scope: 'frame', x: 0.5, effects: false })); await wait();
    const cmp = await px(await grab()), line = Math.round(cmp.w * 0.5);
    const L = region(cmp, plain, 0, line - 2), R = region(cmp, graded, line + 2, cmp.w), diff = region(graded, plain, 0, cmp.w).mean;
    check(`${rm}, ${label}: before/after (whole frame): left of the line equals an ungraded render, right equals the graded one`, L.mean < 0.5 && R.mean < 0.5 && diff > 3, `left ${L.mean.toFixed(2)}/${L.mx}, right ${R.mean.toFixed(2)}/${R.mx}, graded vs plain ${diff.toFixed(1)}`);
    await ev(() => REMOTE.compare({ x: 0.3 })); await wait();
    const c3 = await px(await grab()), l3 = Math.round(c3.w * 0.3);
    check(`${rm}, ${label}: the line anywhere (30 %): left ungraded, right graded`, region(c3, plain, 0, l3 - 2).mean < 0.5 && region(c3, graded, l3 + 2, c3.w).mean < 0.5);
    // the selected clip only: the overlay (masked grade) stays graded on the left
    await ev(() => { S.sel = { lane: 'main', id: P.main[0].id }; S.multi.clear(); REMOTE.compare({ on: false }); }); await wait();
    const refSel = await plainOf('main0');
    await ev(() => REMOTE.compare({ on: true, scope: 'clip', x: 0.5 })); await wait();
    const selc = await px(await grab()), l5 = Math.round(selc.w * 0.5), lc = region(selc, refSel, 0, l5 - 2), rc = region(selc, graded, l5 + 2, selc.w), sep = region(refSel, plain, 0, l5).mean;
    check(`${rm}, ${label}: "Selected clip" takes the colour off only that clip (the overlay's masked grade stays graded on the left)`, lc.mean < 0.5 && rc.mean < 0.5 && sep > 0.3, `left ${lc.mean.toFixed(2)}, right ${rc.mean.toFixed(2)}, vs whole-frame ${sep.toFixed(2)}`);
    await ev(() => REMOTE.compare({ on: false }));
  }
  await ev(() => { GPU.failed = false; });

  // effects optional: vignette and blur on the second clip stay on the left unless "Effects too"
  const fxT = await ev(async () => {
    S.sel = null; const t = len(P.main[0]) + 0.6, snap = async () => (await REMOTE.snapshot({ t, max: 640, preview: true })).image;
    REMOTE.compare({ on: false }); const on = await snap();
    REMOTE.compare({ on: true, mode: 'split', scope: 'frame', x: 0.5, effects: false }); const noFx = await snap();
    REMOTE.compare({ effects: true }); const withFx = await snap();
    REMOTE.compare({ on: false, effects: false });
    return { on, noFx, withFx };
  });
  const [pOn, pNo, pFx] = [await px(fxT.on), await px(fxT.noFx), await px(fxT.withFx)], lx = Math.round(pOn.w * 0.5);
  const leftFx = region(pNo, pFx, 0, lx - 2).mean, rightSame = region(pNo, pOn, lx + 2, pOn.w).mean + region(pFx, pOn, lx + 2, pOn.w).mean;
  check(`${rm}: "Effects too" also takes vignette and blur off the left (left changes by ${leftFx.toFixed(1)}); the right is the finished picture either way`, leftFx > 1.5 && rightSame < 1, `${leftFx.toFixed(2)} ${rightSame.toFixed(2)}`);

  // side by side: left half = the ungraded picture at half size, right half = the finished one at half size
  const sbs = await ev(async () => {
    S.sel = null; const t = 0.6, snap = async () => (await REMOTE.snapshot({ t, max: 640, preview: true })).image;
    REMOTE.compare({ on: false }); const whole = await snap(); REMOTE.compare({ on: true, mode: 'side', scope: 'frame', effects: false }); const side = await snap(); REMOTE.compare({ on: false, mode: 'split' });
    const ld = async s => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()), [W, S2] = [await ld(whole), await ld(side)], w = W.width / 2, h = W.height / 2;
    const half = (im, sx, sy, sw, sh) => { const o = new OffscreenCanvas(w, h), g = o.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(im, sx, sy, sw, sh, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
    const a = half(S2, w, h / 2, w, h), c = half(W, 0, 0, W.width, W.height), l = half(S2, 0, h / 2, w, h); let s = 0, sl = 0;
    for (let i = 0; i < a.length; i += 4) { s += Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2]); sl += Math.abs(l[i] - c[i]) + Math.abs(l[i + 1] - c[i + 1]) + Math.abs(l[i + 2] - c[i + 2]); }
    return { right: s / (w * h * 3), left: sl / (w * h * 3) };
  });
  check(`${rm}: side by side: the right half is the finished picture at half size (diff ${sbs.right.toFixed(2)}), the left half is the ungraded one (differs ${sbs.left.toFixed(1)})`, sbs.right < 2.5 && sbs.left > 3, JSON.stringify(sbs));

  // key, button, overlay, drag; keeps showing while playing; exports unaffected
  await ev(() => { document.activeElement?.blur?.(); });
  await page.keyboard.press('Backslash'); await wait();
  const keyOn = await ev(() => ({ on: CMP.on, shown: !$('#cmpOv').hidden, pressed: $('#btnCmp').getAttribute('aria-pressed') }));
  const box = await ev(() => { const r = $('#cmpGrab').getBoundingClientRect(), c = $('#cv').getBoundingClientRect(); return { gx: r.x + r.width / 2, gy: r.y + r.height / 2, cx: c.x, cw: c.width }; });
  await page.mouse.move(box.gx, box.gy); await page.mouse.down(); await page.mouse.move(box.cx + box.cw * 0.25, box.gy, { steps: 4 }); await page.mouse.up();
  const dragged = await ev(() => CMP.x), hit = await ev(b => document.elementFromPoint(b.gx, b.gy)?.closest('#cmpGrab') ? 'grab' : document.elementFromPoint(b.gx, b.gy)?.id || document.elementFromPoint(b.gx, b.gy)?.className, box);
  await page.screenshot({ path: `${OUT}compare-${rm}.png` });
  check(`${rm}: the \\ key shows it, dragging the line moves it (x ${dragged.toFixed(2)}, key ${JSON.stringify(keyOn)}, hit ${hit}); the preview button toggles it`, keyOn.on && keyOn.shown && keyOn.pressed === 'true' && Math.abs(dragged - 0.25) < 0.03
    && (await (async () => { await page.click('#btnCmp'); return ev(() => !CMP.on && $('#cmpOv').hidden); })()));
  const play = await ev(async () => {
    REMOTE.compare({ on: true, mode: 'split', scope: 'frame', x: 0.5 }); S.t = 0; S.sel = null; play();
    await new Promise(r => setTimeout(r, 900)); const during = CMP.on && S.playing, t1 = S.t; pause();
    const cv = $('#cv'), g = cv.getContext('2d'), W = cv.width, H = cv.height, l = g.getImageData(4, 4, 40, H - 8).data, r = g.getImageData(W - 44, 4, 40, H - 8).data;
    return { during, t1, painted: l.some(v => v > 0) && r.some(v => v > 0) };
  });
  check(`${rm}: it keeps showing while playing`, play.during && play.t1 > 0.3 && play.painted, JSON.stringify(play));
  const ex = await ev(async () => {
    REMOTE.compare({ on: true, mode: 'split', scope: 'frame', x: 0.5 });
    const t = 0.6, a = (await REMOTE.snapshot({ t, max: 640 })).image, plan = JSON.stringify(await buildPlan(640, 360, 'fast', 'snapshot', false, 'png'));
    REMOTE.compare({ on: false }); const b2 = (await REMOTE.snapshot({ t, max: 640 })).image, plan2 = JSON.stringify(await buildPlan(640, 360, 'fast', 'snapshot', false, 'png'));
    return { same: a === b2, planSame: plan === plan2, proj: !/cmp/i.test(JSON.stringify(P)) };
  });
  check(`${rm}: exports are unaffected (the export frame and the export plan are identical with it on or off; nothing is saved in the project)`, ex.same && ex.planSame && ex.proj, JSON.stringify(ex));

  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}
await b.close();
const pass = res.filter(Boolean).length;
console.log(`\n${pass}/${res.length} passed`);
process.exit(pass === res.length ? 0 : 1);
