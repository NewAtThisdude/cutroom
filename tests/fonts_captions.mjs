// Committee item 43a, headless WebKit in both motion modes: an imported .ttf (into <library>/fonts, a FontFace in the page)
// and a font installed on this Mac draw the same in the preview and the export, and survive a reload; the font picker lists
// them; one caption restyled leaves the others alone, the export matches, 'Apply to all' copies it to every caption.
// Then loudness: the two-pass linear export holds one gain across the edit, and the sound is as long as the picture.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node fonts_captions.mjs     (never the real 4610 window)
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B, HOME = process.env.CUTROOM_HOME, H = { 'X-Cutroom': '1' };
if (!HOME || !B || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port>');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const web = fileURLToPath(new URL('../web/fonts/', import.meta.url)), tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-fonts-`);
const FACE = 'Cutroom Test Face', UIFACE = 'Cutroom UI Face', NONE = 'No Such Face 9';
// a font every computer of that kind has, and the picker's group for them (off the Mac the page says 'This computer')
const [MAC, SYSGROUP] = process.platform === 'darwin' ? ['Chalkduster', 'This Mac'] : ['Comic Sans MS', 'This computer'];
const font = await (await fetch(`${B}/api/fonts?name=${encodeURIComponent(FACE)}.ttf`, { method: 'POST', headers: H, body: fs.readFileSync(`${web}Anton.ttf`) })).json(); // Anton's bytes under a name no Mac has
check('a .ttf imports into the library under its file name', font.family === FACE && fs.existsSync(`${HOME}/fonts/${font.file}`), JSON.stringify(font));
const bad = await fetch(`${B}/api/fonts?name=x.ttf`, { method: 'POST', headers: H, body: 'not a font' });
check('a file that is not a font is refused', bad.status >= 400, bad.status);
// 10 s: pink noise at -32 dB for 5 s, then 20 dB louder; single-pass loudnorm rode the gain between them
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x303848:s=640x360:r=30:d=10', '-f', 'lavfi', '-i', "anoisesrc=c=pink:r=48000:a=0.5:d=10:seed=7,volume='if(lt(t,5),0.025,0.25)':eval=frame",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest', `${tmp}/fonts-bg.mp4`]);
const BG = await (await fetch(`${B}/api/import?name=fonts-bg.mp4`, { method: 'POST', headers: H, body: fs.readFileSync(`${tmp}/fonts-bg.mp4`) })).json();
const pids = new Set();

const b = await browser.launch();
try {
  for (const rm of ['no-preference', 'reduce']) {
    const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
    const ev = (f, a) => page.evaluate(f, a);
    const boot = async () => {
      await page.goto(`${B}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0 && G.sysFonts, null, { timeout: 30000 });
      await ev(() => loadMedia());
      await page.waitForFunction(id => M.get(id)?.ready, BG.id, { timeout: 60000 });
    };
    await boot();
    // preview vs export of the frame at t, both shrunk to 160x90 (as video_parity): mean and worst 10x10 block in 0-255 levels; `against` = another export
    const cmp = (t, against) => ev(async ([t, against]) => {
      S.sel = null; renderAll();
      const ex = await REMOTE.snapshot({ t, max: 640 }), pv = against ? { image: against } : await REMOTE.snapshot({ t, max: 640, preview: true });
      const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
      const [a, q] = [await px(ex.image), await px(pv.image)];
      let sum = 0, worst = 0;
      for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) { let s = 0; for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 160 + x) * 4 + k; s += Math.abs(a[i] - q[i]); } sum += s; worst = Math.max(worst, s / 300); }
      return { mean: +(sum / (160 * 90 * 3)).toFixed(2), worst: +worst.toFixed(1), ex: ex.image };
    }, [t, against]);
    const ok = r => r.mean <= 4 && r.worst <= 28; // video_parity's limits
    const titled = f => ev(async ([f, id]) => { setProject(newProject('16:9')); P.name = 'Fonts (scratch)'; addMedia(id, 'main'); await REMOTE.add_text({ text: 'Fonts 123 Wg', start: 0, duration: 5, style: { font: f, size: 150, weight: 400 } }); return P.id; }, [f, BG.id]);

    // 1. imported font + a Mac font
    for (const pass of ['first load', 'after reload']) {
      if (pass === 'after reload') await boot();
      const st = await ev(f => ({ listed: G.fonts.some(x => x.family === f), face: [...document.fonts].find(x => x.family.replace(/"/g, '') === f)?.status }), FACE);
      check(`${rm}, ${pass}: the imported font is registered and loaded`, st.listed && st.face === 'loaded', JSON.stringify(st));
      pids.add(await titled(FACE));
      const imp = await cmp(1);
      pids.add(await titled('Anton')); const anton = await cmp(1, imp.ex); // the same glyphs through the bundled @font-face
      pids.add(await titled(NONE)); const none = await cmp(1, imp.ex); // what an unregistered name falls back to
      check(`${rm}, ${pass}: imported .ttf preview == export`, ok(imp), `mean ${imp.mean}, worst block ${imp.worst}`);
      check(`${rm}, ${pass}: it is really that font (export = Anton's bytes, unlike the fallback)`, anton.mean < 0.5 && none.mean > 2, `vs Anton mean ${anton.mean}, vs fallback mean ${none.mean} worst ${none.worst}`);
    }
    pids.add(await titled(MAC)); const mac = await cmp(1);
    pids.add(await titled(NONE)); const macNone = await cmp(1, mac.ex);
    check(`${rm}: a system font (${MAC}) preview == export, and it is not the fallback`, ok(mac) && macNone.mean > 2, `mean ${mac.mean}, worst ${mac.worst}; vs fallback ${macNone.mean}`);

    // 2. the picker, and importing through it
    pids.add(await titled('Montserrat'));
    const pk = await ev(async () => { S.sel = { lane: 'text', id: P.text[0].id }; renderInspector(); await new Promise(r => setTimeout(r)); /* off the Mac, platWatch renames the groups in a MutationObserver */ const s = $('#inspector select[data-k="c.style.font"]'); return Object.fromEntries([...s.querySelectorAll('optgroup')].map(g => [g.label, [...g.querySelectorAll('option')].map(o => o.value)])); });
    check(`${rm}: font picker lists Cutroom, imported and this computer's fonts (${SYSGROUP})`, pk.Cutroom?.includes('Montserrat') && pk.Imported?.includes(FACE) && pk[SYSGROUP]?.length > 50 && pk[SYSGROUP].includes(MAC), `${Object.entries(pk).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
    await page.setInputFiles('#inspector input[data-fontin]', { name: `${UIFACE}.ttf`, mimeType: 'font/ttf', buffer: fs.readFileSync(`${web}BebasNeue.ttf`) });
    await page.waitForFunction(f => P.text[0].style.font === f, UIFACE, { timeout: 10000 }).catch(() => {});
    const ui = await ev(f => ({ font: P.text[0].style.font, listed: G.fonts.some(x => x.family === f), face: [...document.fonts].find(x => x.family.replace(/"/g, '') === f)?.status }), UIFACE);
    const uip = await cmp(1);
    check(`${rm}: Import font… in the inspector imports it and sets it on the text; preview == export`, ui.font === UIFACE && ui.listed && ui.face === 'loaded' && ok(uip), `${JSON.stringify(ui)}, mean ${uip.mean}, worst ${uip.worst}`);

    // 3. one caption restyled
    const pid = await ev(async id => {
      setProject(newProject('16:9')); P.name = 'Caption style (scratch)'; addMedia(id, 'main');
      change(() => { P.captions = ['first one here', 'second one here', 'third one here'].map((text, i) => ({ id: hex12(), start: i * 1.5, dur: 1.5, text })); });
      return P.id;
    }, BG.id);
    pids.add(pid);
    const before = await cmp(0.7), cap0 = await ev(() => JSON.stringify(P.capStyle));
    await ev(() => { S.sel = { lane: 'captions', id: P.captions[1].id }; renderInspector(); });
    await ev(() => { const set = (k, v) => { const el = $(`#inspector [data-k="${k}"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }; set('c.style.color', '#ff3030'); set('c.style.size', 120); set('c.style.font', 'Anton'); });
    const one = await ev(() => ({ styles: P.captions.map(c => c.style || null), same: JSON.stringify(P.capStyle), eff: P.captions.map(c => textStyle(c, 'captions').color) }));
    check(`${rm}: one caption restyled, the others and the shared style untouched`, one.styles[0] === null && one.styles[2] === null && one.styles[1]?.color === '#ff3030' && one.styles[1].size === 120 && one.same === cap0 && one.eff.join() === `${JSON.parse(cap0).color},#ff3030,${JSON.parse(cap0).color}`, JSON.stringify(one));
    const c1 = await cmp(2.2), c0 = await cmp(0.7), c0was = await cmp(0.7, before.ex);
    check(`${rm}: the restyled caption's export matches its preview`, ok(c1), `mean ${c1.mean}, worst ${c1.worst}`);
    check(`${rm}: the first caption looks exactly as before (export) and matches its preview`, c0was.mean === 0 && ok(c0), `export vs before ${c0was.mean}, preview vs export ${c0.mean}/${c0.worst}`);
    const red = await ev(async () => { const im = (await REMOTE.snapshot({ t: 2.2, max: 640 })).image, bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${im}`)).blob()), c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n; });
    check(`${rm}: the export draws that caption red`, red > 500, `${red} red pixels`);
    await ev(() => { S.sel = { lane: 'captions', id: P.captions[1].id }; renderInspector(); });
    await page.click('#inspector button[data-act="capall"]');
    const all = await ev(() => ({ styles: P.captions.map(c => c.style || null), cs: P.capStyle, eff: [...new Set(P.captions.map(c => JSON.stringify(textStyle(c, 'captions'))))].length }));
    const a0 = await cmp(0.7);
    check(`${rm}: Apply to all: every caption takes that style, overrides cleared, export matches`, all.styles.every(s => !s) && all.cs.color === '#ff3030' && all.cs.size === 120 && all.cs.font === 'Anton' && all.eff === 1 && ok(a0), `${JSON.stringify(all.styles)} ${all.cs.color} ${all.eff} styles; mean ${a0.mean}`);
    const un = await ev(() => { restore(undo, redo); return { c1: P.captions[1].style?.color, c0: P.captions[0].style || null, cs: P.capStyle.color }; }).catch(e => ({ err: e.message }));
    check(`${rm}: one undo brings the single restyled caption back`, un.c1 === '#ff3030' && un.c0 === null && un.cs !== '#ff3030', JSON.stringify(un));
    check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 3).join(' | '));

    // 4. loudness (once): one gain across the edit, sound as long as the picture
    if (rm === 'no-preference') {
      pids.add(await ev(id => { setProject(newProject('16:9')); P.name = 'Loudness (scratch)'; addMedia(id, 'main'); return P.id; }, BG.id));
      const out = {};
      for (const loudness of [false, true]) out[loudness] = `${HOME}/exports/${(await ev(l => REMOTE.export({ format: 'mp4', resolution: '720p', loudness: l, name: `Loudness ${l ? 'on' : 'off'} (scratch)` }), loudness)).file}`;
      const pcm = (f, af = 'anull') => { const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-af', af, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }); return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); };
      const win = a => { const n = 19200, o = []; for (let i = 0; i + n <= a.length; i += n) { let s = 0; for (let j = i; j < i + n; j++) s += a[j] * a[j]; o.push(10 * Math.log10(s / n + 1e-20)); } return o; }; // 400 ms RMS, dB
      const spread = (x, y) => { const d = x.map((v, i) => y[i] - v).slice(1, -1); return { min: Math.min(...d), max: Math.max(...d), spread: Math.max(...d) - Math.min(...d) }; };
      const raw = win(pcm(out.false)), lin = win(pcm(out.true)), single = win(pcm(out.false, 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000'));
      const g = spread(raw, lin), g0 = spread(raw, single);
      const durs = f => Object.fromEntries(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim().split('\n').map(l => l.split(',')).map(([k, v]) => [k, +v]));
      const dOn = durs(out.true), dOff = durs(out.false);
      check('loudness on: export gain varies < 1 dB across the edit (400 ms windows vs the plain export)', g.spread < 1, `linear ${g.min.toFixed(2)}..${g.max.toFixed(2)} dB (spread ${g.spread.toFixed(2)}); the old single-pass loudnorm spread ${g0.spread.toFixed(2)} dB`);
      check('loudness on: audio length equals video length (within one AAC frame, 21 ms)', Math.abs(dOn.audio - dOn.video) <= 1024 / 48000 + 1e-6, `on: audio ${dOn.audio} video ${dOn.video}; off: audio ${dOff.audio} video ${dOff.video}`);
      const meter = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', out.true, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
      if (meter.error || meter.status !== 0) throw meter.error || new Error(meter.stderr);
      const m = meter.stderr.split(/\r?\n/).filter(line => /^ +(I|Peak):/.test(line)).slice(-2).join(' ').replace(/\s+/g, ' ').trim();
      console.log(`     loudness-on export meter: ${m}`);
      fs.mkdirSync(`${HOME}/trash`, { recursive: true }); // (a fresh library has none yet)
      for (const f of Object.values(out)) fs.renameSync(f, `${HOME}/trash/${f.split('/').pop()}`);
    }
    await page.context().close();
  }
} finally {
  await b.close();
  for (const pid of pids) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  await fetch(`${B}/api/media/${BG.id}/trash`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  fs.rmSync(tmp, { recursive: true });
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
