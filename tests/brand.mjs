// Brand kit: a brand with a logo, three colours, an imported heading font, a caption style, an intro and an outro. Its text and
// caption presets come first and carry its colours and fonts; a new project starts branded; "Apply brand" puts the intro first,
// the outro last and the logo on a locked top overlay track (pixel checks in the preview AND the export engine's frame, and in
// an exported MP4), in one undo step; "Add watermark" on an unbranded project's export shows the logo there only; a package
// carries the brand (an empty library adopts it); the Brand panel in both motion modes; no page errors. No AI step is involved.
//   CUTROOM_HOME=<scratch lib> CUTROOM_PORT=4752 python3 -I server.py, then
//   B=http://127.0.0.1:4752 CUTROOM_HOME=<same lib> CUTROOM_SCRATCH=<scratch dir> node brand.mjs
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const B = process.env.B || 'http://127.0.0.1:4752', HOME = process.env.CUTROOM_HOME, SCR = process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch';
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (path, body) => {
  const r = await fetch(B + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH'));
const ff = (...a) => execFileSync('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-y', ...a], { env });
const near = (p, q, tol = 40) => p.every((v, i) => Math.abs(v - q[i]) <= tol);
const MAG = [255, 0, 255], RED = [255, 0, 0], GREEN = [0, 192, 0], BLUE = [0, 0, 255];

// ---- fixtures: a 200x120 magenta logo, a red intro, a blue outro, a green body clip (1, 1, 2 s at 640x360) ----
const FX = mkdtempSync(`${SCR}/brand-fixtures-`), tok = FX.slice(-6); // (unique names: the intro is picked by name below)
ff('-f', 'lavfi', '-i', 'color=c=0xff00ff:s=200x120', '-frames:v', '1', `${FX}/logo-${tok}.png`);
for (const [n, c, d] of [['intro', '0xff0000', 1], ['outro', '0x0000ff', 1], ['body', '0x00c000', 2]])
  ff('-f', 'lavfi', '-i', `color=c=${c}:s=640x360:r=30:d=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${FX}/${n}-${tok}.mp4`);
const imp = path => api('/api/import_path', { path });
const [L, I, O, V] = [await imp(`${FX}/logo-${tok}.png`), await imp(`${FX}/intro-${tok}.mp4`), await imp(`${FX}/outro-${tok}.mp4`), await imp(`${FX}/body-${tok}.mp4`)];
for (let i = 0; i < 120; i++) { const m = await api('/api/media'); if ([L, I, O, V].every(x => m.find(y => y.id === x.id)?.ready)) break; await sleep(500); }
const font = await (await fetch(`${B}/api/fonts?name=Brand%20Face.ttf`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: readFileSync(`${ROOT}/web/fonts/BebasNeue.ttf`) })).json();
const before = await api('/api/brand'); // put back at the end (a scratch library may have one)

const b = await webkit.launch();
const errs = [];
const open = async rm => {
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: rm })).newPage();
  page.on('pageerror', e => errs.push(`${rm}: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE !== 'undefined', null, { timeout: 20000 });
  await page.evaluate(() => { if (tourAt >= 0) tourGo('skip'); });
  return page;
};
const R = (page, cmd, args = {}) => page.evaluate(([c, a]) => REMOTE[c](a), [cmd, args]);
const px = (page, b64, x, y) => page.evaluate(async ([s, x, y]) => { // mean RGB of the 5x5 pixels around (x, y) of a PNG
  const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()), cv = new OffscreenCanvas(bm.width, bm.height), c = cv.getContext('2d');
  c.drawImage(bm, 0, 0);
  const d = c.getImageData(x - 2, y - 2, 5, 5).data, o = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) o[k] += d[i + k] / 25;
  return o.map(Math.round);
}, [b64, x, y]);
const filePx = (f, t, x, y) => { // the same from an exported file's frame at t, scaled to 640x360
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=640:360', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { env, maxBuffer: 1 << 24 });
  const o = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let k = 0; k < 3; k++) o[k] += raw[((y + dy) * 640 + x + dx) * 3 + k] / 25;
  return o.map(Math.round);
};
// the logo in the top-right corner of a 640x360 frame: 20 % of the width (128 px, 76.8 tall), 4 % of the short side in (14.4 px)
const LOGO = [Math.round(640 - 14.4 - 64), Math.round(14.4 + 38.4)], BACK = [120, 260];

const pa = await open('reduce');
// ---- the brand (the MCP command) ----
const COLS = ['#e03c31', '#1d4ed8', '#fafafa'];
const br = await R(pa, 'brand', { action: 'set', set: { logo: L.id, intro: `intro-${tok}.mp4`, outro: O.id, colors: COLS, head: { font: font.family }, body: { font: 'Poppins' }, cap: 'Boxed', wm: { on: true, corner: 'tr', size: 0.2, opacity: 1 } } });
check('brand set: logo, intro (by name), outro, 3 colours, fonts, caption style, watermark', br.logo === L.id && br.intro === I.id && br.outro === O.id && JSON.stringify(br.colors) === JSON.stringify(COLS)
  && br.head.font === font.family && br.body.font === 'Poppins' && br.cap === 'Boxed' && br.wm.on && br.wm.corner === 'tr' && br.auto, JSON.stringify(br));
check('it is stored in the library (brand/brand.json)', JSON.parse(readFileSync(`${HOME}/brand/brand.json`, 'utf8')).logo === L.id);
const opts = await R(pa, 'options');
check('text presets offer the brand first', JSON.stringify(opts.textPresets.slice(0, 3)) === JSON.stringify(['Brand title', 'Brand text', 'Brand label']), opts.textPresets.slice(0, 4).join(', '));
check('caption presets offer the brand first', opts.captionPresets[0] === 'Brand', opts.captionPresets.slice(0, 3).join(', '));

// ---- a new project starts branded ----
const np = await R(pa, 'new_project', { ratio: '16:9', name: 'Branded from the start' });
const A0 = await pa.evaluate(() => ({ main: P.main.map(c => c.brand || c.media), wm: !!wmOf(), brand: !!P.brand }));
check('a new project starts branded: intro, outro, watermark', np.branded && JSON.stringify(A0.main) === '["intro","outro"]' && A0.wm && A0.brand, JSON.stringify(A0));
await R(pa, 'add_clip', { media: V.id, lane: 'main' });
const A1 = await pa.evaluate(() => ({ main: P.main.map(c => c.brand || 'clip'), wm: [wmOf().start, len(wmOf())], tot: total() }));
check('a clip added to it goes before the outro, and the watermark follows the edit', JSON.stringify(A1.main) === '["intro","clip","outro"]' && A1.wm[0] === 0 && Math.abs(A1.wm[1] - A1.tot) < 1e-6 && Math.abs(A1.tot - 4) < 0.01, JSON.stringify(A1));

// ---- the text tab and the inspector: brand colours and fonts first ----
await pa.evaluate(() => openTab('text'));
const tile = await pa.evaluate(() => { const b0 = $('#textPresets button'), s = b0.querySelector('span'); return { n: b0.dataset.addtext, color: getComputedStyle(s).color, font: getComputedStyle(s).fontFamily }; });
check('the first text style tile is the brand title, in the brand colour and font', tile.n === 'Brand title' && tile.color === 'rgb(224, 60, 49)' && tile.font.includes(font.family), JSON.stringify(tile));
const tx = await R(pa, 'add_text', { text: 'BRAND', preset: 'Brand title', start: 0, duration: 2 });
await pa.evaluate(id => { S.sel = { lane: 'text', id }; renderInspector(); }, tx.id);
const insp = await pa.evaluate(() => ({ sw: $$('#inspector .bsw').map(x => x.dataset.brandc), group: $('#inspector select[data-k="c.style.font"] optgroup')?.label, first: $('#inspector select[data-k="c.style.font"] optgroup option')?.value,
  list: $('#inspector input[data-k="c.style.color"]')?.getAttribute('list'), dl: $$('#brandColours option').map(o => o.value), style: selClip().style }));
check('a brand title text is in the brand colour and heading font', insp.style.color === COLS[0] && insp.style.font === font.family, JSON.stringify(insp.style));
check('the inspector offers the brand colours (swatches, picker suggestions) and fonts first', JSON.stringify(insp.sw) === JSON.stringify(COLS) && insp.list === 'brandColours' && JSON.stringify(insp.dl) === JSON.stringify(COLS)
  && insp.group === 'Brand' && insp.first === font.family, JSON.stringify(insp));
await pa.click(`#inspector .bsw[data-brandc="${COLS[1]}"]`);
check('a brand swatch recolours the text', await pa.evaluate(() => selClip().style.color) === COLS[1]);
await pa.evaluate(() => openTab('captions'));
check('the first caption style tile is the brand\'s', await pa.evaluate(() => $('#capPresets .tile')?.dataset.cap) === 'Brand');

// ---- an unbranded project: Add watermark for one export ----
const nb = await R(pa, 'new_project', { ratio: '16:9', name: 'Unbranded', branded: false });
await R(pa, 'add_clip', { media: V.id, lane: 'main' });
check('branded=false starts plain', !nb.branded && await pa.evaluate(() => P.main.length === 1 && !P.overlay.length && !P.brand));
await pa.evaluate(() => openExport());
check('the export dialog offers Add watermark (the project has none)', await pa.evaluate(() => !!$('#exWm') && !$('#exWm').checked));
await pa.evaluate(() => closeModal());
const ex = await R(pa, 'export', { format: 'mp4', resolution: '720p', watermark: true, name: 'brand watermark test' });
const exf = `${HOME}/exports/${ex.file}`, wpx = filePx(exf, 1, ...LOGO), wbg = filePx(exf, 1, ...BACK);
check('the export with Add watermark shows the logo in its corner', near(wpx, MAG) && near(wbg, GREEN), JSON.stringify({ logo: wpx, back: wbg }));
check('the project itself stays without it', await pa.evaluate(() => !P.overlay.length && !wmOf()));
const plainShot = (await R(pa, 'snapshot', { t: 1, max: 640 })).image;
check('its own frame has no logo', near(await px(pa, plainShot, ...LOGO), GREEN), JSON.stringify(await px(pa, plainShot, ...LOGO)));

// ---- Apply brand: one undo step ----
const cap0 = await pa.evaluate(() => JSON.stringify(P.capStyle)), n0 = await pa.evaluate(() => undo.length);
await R(pa, 'brand', { action: 'apply' });
const A2 = await pa.evaluate(() => { const w = wmOf(); return { main: P.main.map(c => c.brand || 'clip'), w: w && [w.start, len(w), w.media, w.opacity], tot: total(), locked: w && locked('overlay', w), cap: [P.capStyle.font, P.capStyle.hl, P.capStyle.box], brand: P.brand?.logo, n: undo.length }; });
check('apply: the intro first, the outro last', JSON.stringify(A2.main) === '["intro","clip","outro"]', JSON.stringify(A2.main));
check('apply: the watermark spans the edit on a locked overlay track', A2.w && A2.w[0] === 0 && Math.abs(A2.w[1] - A2.tot) < 1e-6 && A2.w[2] === L.id && A2.w[3] === 1 && A2.locked, JSON.stringify(A2));
check('apply: the brand caption style (Boxed in the heading font, the first colour as highlight)', A2.cap[0] === font.family && A2.cap[1] === COLS[0] && A2.cap[2] === true, JSON.stringify(A2.cap));
check('apply is one undo step named "Apply brand"', A2.n === n0 + 1 && (await R(pa, 'history', { action: 'list' })).steps[0].name === 'Apply brand');
for (const [t, bg, what] of [[0.5, RED, 'intro'], [2, GREEN, 'clip'], [3.5, BLUE, 'outro']]) {
  const pv = (await R(pa, 'snapshot', { t, max: 640, preview: true })).image, eg = (await R(pa, 'snapshot', { t, max: 640 })).image;
  const v = [await px(pa, pv, ...LOGO), await px(pa, pv, ...BACK), await px(pa, eg, ...LOGO), await px(pa, eg, ...BACK)];
  check(`the ${what} at ${t} s with the logo top right: preview and export engine`, near(v[0], MAG) && near(v[1], bg) && near(v[2], MAG) && near(v[3], bg), JSON.stringify(v));
}
const ex2 = await R(pa, 'export', { format: 'mp4', resolution: '720p', name: 'brand applied test' }), ef2 = `${HOME}/exports/${ex2.file}`;
const e2 = [filePx(ef2, 0.5, ...BACK), filePx(ef2, 2, ...LOGO), filePx(ef2, 3.6, ...BACK), filePx(ef2, 3.6, ...LOGO)];
check('the exported MP4: intro, logo, outro', near(e2[0], RED) && near(e2[1], MAG) && near(e2[2], BLUE) && near(e2[3], MAG), JSON.stringify(e2));
await pa.evaluate(() => openExport());
check('a branded project\'s export dialog has no Add watermark (it has one)', await pa.evaluate(() => !$('#exWm')));
await pa.evaluate(() => closeModal());

// ---- undo removes all of it in one step; redo puts it back ----
await R(pa, 'history', { action: 'undo' });
const U = await pa.evaluate(() => ({ main: P.main.map(c => c.brand || 'clip'), ov: P.overlay.length, brand: !!P.brand, cap: JSON.stringify(P.capStyle), lock: Object.values(P.tracks).some(t => t.lock), n: undo.length }));
check('undo: intro, outro, watermark, track lock, caption style and brand all gone in one step', JSON.stringify(U.main) === '["clip"]' && !U.ov && !U.brand && !U.lock && U.cap === cap0 && U.n === n0, JSON.stringify({ ...U, cap: U.cap === cap0 }));
await R(pa, 'history', { action: 'redo' });
check('redo: branded again', await pa.evaluate(() => P.main.length === 3 && !!wmOf() && !!P.brand));
await pa.evaluate(() => flushSave());

// ---- packages carry the brand: an empty brand adopts it ----
const pk = await R(pa, 'package_project', {});
const man = JSON.parse(execFileSync('python3', ['-I', '-c', 'import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"m":json.loads(z.read("manifest.json")),"p":json.loads(z.read("project.json"))}))', `${HOME}/exports/${pk.file}`], { env, encoding: 'utf8' }));
check('the package holds the logo, intro, outro, the clip and the brand font, and the brand', [L, I, O, V].every(x => man.m.media.some(r => r.id === x.id)) && man.m.fonts.some(f => f.family === font.family) && man.p.brand?.logo === L.id,
  `${man.m.media.length} media, fonts ${man.m.fonts.map(f => f.family)}`);
await api('/api/brand', {});
const op = await R(pa, 'open_package', { path: `${HOME}/exports/${pk.file}` });
const adopted = await api('/api/brand');
check('opened where there is no brand, the package\'s brand becomes the library\'s', op.reused === 4 && adopted.logo === L.id && adopted.head.font === font.family && JSON.stringify(adopted.colors) === JSON.stringify(COLS), JSON.stringify({ reused: op.reused, logo: adopted.logo }));
await R(pa, 'brand', { action: 'get' });

// ---- the Brand panel, both motion modes ----
const panel = async (page, rm) => {
  await page.evaluate(() => openTab('text'));
  await page.click('#btnBrandText');
  await page.waitForSelector('#modal .dialog select[data-bk="logo"]');
  const u = await page.evaluate(() => ({ logo: $('#modal select[data-bk="logo"]').value, cols: $$('#modal input[data-bc]').map(x => x.value), corner: $('#modal [data-bcorner].on')?.dataset.bcorner, apply: !$('#modal [data-brand="apply"]').disabled }));
  check(`${rm}: the Brand panel shows the brand`, u.logo === L.id && JSON.stringify(u.cols) === JSON.stringify(COLS) && u.corner === 'tr' && u.apply, JSON.stringify(u));
  await page.screenshot({ path: `${FX}/brand-panel-${rm}.png` });
  await page.click('#modal [data-bcorner="bl"]');
  await page.waitForFunction(() => G.brand.wm.corner === 'bl' && $('#modal [data-bcorner="bl"].on'));
  check(`${rm}: a corner picked in the panel is saved`, (await api('/api/brand')).wm.corner === 'bl');
  await page.click('#modal [data-bcorner="tr"]');
  await page.waitForFunction(() => G.brand.wm.corner === 'tr' && $('#modal [data-bcorner="tr"].on'));
  await page.click('#modal [data-close]');
  check(`${rm}: Close closes it`, await page.evaluate(() => $('#modal').hidden));
};
await panel(pa, 'reduce');
const pb = await open('no-preference');
await panel(pb, 'no-preference');
check('no-preference: the brand presets are there after a reload', await pb.evaluate(() => Object.keys(TEXT_PRESETS)[0] === 'Brand title' && Object.keys(CAP_PRESETS)[0] === 'Brand'));

await b.close();
await api('/api/brand', before);
check('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\nscreenshots in ${FX}\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
