// The text/effect layer three ways, compared frame by frame (ffmpeg framemd5 of a ProRes export): the layer workers, the
// page fallback (S.layerForce = 'page') and the old full-frame PNG path (text.pngs, rebuilt here as buildPlan made it before
// the crop). All three must give the same frames: crop + upload change where the pixels travel, not what they are.
// Twice: with the effects (the box is the whole frame) and text only (a real crop). Project: 4 s of 1080p30 footage with titles in Cutroom's fonts (in/out/loop animations, shadow, box, letter spacing), an
// imported font, a Mac font, Bold captions with word highlights and Snow, VHS and Camcorder overlays.
//   B=http://127.0.0.1:4721 CUTROOM_HOME=<scratch lib> node layer_parity.mjs
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const B = process.env.B || 'http://127.0.0.1:4721', HOME = process.env.CUTROOM_HOME;
if (!HOME || B.endsWith(':4610')) throw new Error('run on a scratch server: B=... CUTROOM_HOME=<its library>');
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
page.on('console', m => { if (m.type() === 'warning') console.log('console.warn', m.text()); });
await page.route(u => u.pathname === '/api/remote/next', async q => { await new Promise(z => setTimeout(z, 15000)); q.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined' && M.size > 0, null, { timeout: 30000 });
const ev = (f, a) => page.evaluate(f, a);
const fonts = await ev(async () => { await loadFonts(); return G.fonts.map(f => f.family); });
await ev(async fam => {
  const v = [...M.values()].find(m => m.kind === 'video' && m.ready && m.w >= 1280 && (m.dur ?? m.duration ?? 9) >= 4);
  const p = await api(`/api/projects/${(await api('/api/projects')).find(x => /Midnight Highway/.test(x.name)).id}`);
  p.id = hex12(); p.name = 'layer_parity scratch'; p.fps = 30; p.main = [{ ...p.main[0], id: hex12(), out: p.main[0].in + 4, speed: 1 }]; delete p.main[0].tr;
  const T = (text, y, style, extra = {}) => ({ id: hex12(), start: 0.2, dur: 3.4, text, x: 0.5, y, style, ...extra });
  p.text = [T('Title pop', 0.15, { ...TEXT_PRESETS.Title, anim: 'pop', out: 'fade' }), T('Neon slide', 0.3, { ...TEXT_PRESETS.Neon, anim: 'slide', loop: 'pulse' }),
    T('Boxed label', 0.42, { ...TEXT_PRESETS.Label, anim: 'type' }), T('MINIMAL SPACED', 0.52, { ...TEXT_PRESETS.Minimal }), T('Anton outline', 0.62, { ...TEXT_PRESETS.Outline, loop: 'wiggle' }),
    T(`Imported ${fam[0] || ''}`, 0.08, { font: fam[0] || 'Montserrat', weight: 400, size: 60 }), T('Georgia italic', 0.9, { font: 'Georgia', weight: 700, italic: true, size: 56 },
      { kf: [{ t: 0, scale: 1, x: 0.4, y: 0.9, opacity: 1 }, { t: 2, scale: 1.3, x: 0.6, y: 0.88, opacity: 0.6 }] })];
  p.captions = [{ id: hex12(), start: 0.5, dur: 1.6, text: 'three bold words', words: [{ w: 'three', s: 0, e: 0.5 }, { w: 'bold', s: 0.5, e: 1 }, { w: 'words', s: 1, e: 1.6 }] },
    { id: hex12(), start: 2.2, dur: 1.4, text: 'and some more', words: [{ w: 'and', s: 0, e: 0.4 }, { w: 'some', s: 0.4, e: 0.9 }, { w: 'more', s: 0.9, e: 1.4 }], style: { font: 'Poppins', weight: 900 } }];
  // the dynamic caption styles (karaoke sweep, word entrances, one word, emoji, second line, speaker name, keywords), drawn every frame
  const W3 = [{ w: 'every', s: 0, e: 0.45 }, { w: 'word', s: 0.45, e: 0.9 }, { w: 'counts', s: 0.9, e: 1.5 }];
  p.captions.push({ id: hex12(), start: 0.3, dur: 1.5, text: 'every word counts', words: W3, tr: 'cada palabra cuenta', spk: 0, style: { ...CAP_PRESETS.Karaoke, bi: true, spk: true } },
    { id: hex12(), start: 1.9, dur: 1.5, text: 'every word counts', words: W3, kw: [2], emoji: '🔥', spk: 1, style: { ...CAP_PRESETS.Emoji, kw: true, spk: true } },
    { id: hex12(), start: 0.2, dur: 1.5, text: 'every word counts', words: W3, style: { ...CAP_PRESETS['One Word'] } },
    { id: hex12(), start: 1.8, dur: 1.5, text: 'every word counts', words: W3, style: { ...CAP_PRESETS['Shadow Stack'], wanim: 'bounce' } },
    { id: hex12(), start: 2.0, dur: 1.5, text: 'every word counts', words: W3, style: { ...CAP_PRESETS.Typewriter } });
  p.capStyle = { ...TEXT_BASE, ...CAP_PRESETS.Bold, y: 0.72 };
  p.fx = [{ id: hex12(), fx: 'snow', start: 0, dur: 1.5, amt: 1 }, { id: hex12(), fx: 'vhs', start: 1.5, dur: 1.2, amt: 1 }, { id: hex12(), fx: 'rec', start: 2.7, dur: 1.3, amt: 1 }];
  setProject(p); renderAll(); S.t = 1.6;
}, fonts);

const md5 = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'framemd5', '-'], { maxBuffer: 1 << 26 }).toString().split('\n').filter(l => l && !l.startsWith('#'));
const run = async mode => {
  const r = await ev(async mode => {
    S.layerForce = mode === 'page' ? 'page' : undefined;
    const plan = await buildPlan(1920, 1080, 'fast', `layer_parity ${mode}`, false, 'prores');
    const info = { mode: S.layerMode, n: plan.text.n, box: plan.text.box, spans: plan.text.frames.length };
    if (mode === 'old') { // buildPlan's text layer before the crop: one full-frame PNG per distinct picture, sent in the plan
      const cv = new OffscreenCanvas(1920, 1080), ctx = cv.getContext('2d', { willReadFrequently: true }), pngs = [], seen = new Map(), spans = [], k = 1920 / P.w;
      const fr = [...new Set(plan.text.frames.flatMap(s => [Math.round(s.start * P.fps), Math.round(s.end * P.fps)]))].sort((a, b) => a - b);
      for (let i = 0; i + 1 < fr.length; i++) {
        const a = fr[i] / P.fps; ctx.clearRect(0, 0, 1920, 1080); drawTexts(ctx, a, k, false);
        const key = layerScan(ctx, k, [fr[i]])[0][1];
        let idx = seen.get(key);
        if (idx === undefined) { idx = pngs.push(await blobURL(await cv.convertToBlob({ type: 'image/png' }))) - 1; seen.set(key, idx); }
        const last = spans.at(-1);
        if (last && last.i === idx) last.end = fr[i + 1] / P.fps; else spans.push({ i: idx, start: a, end: fr[i + 1] / P.fps });
      }
      plan.text = { pngs, frames: spans }; info.n = pngs.length; info.mode = 'old';
    }
    const { job } = await api('/api/export', plan);
    for (;;) { await new Promise(z => setTimeout(z, 300)); const j = await api(`/api/jobs/${job}`); if (j.state !== 'running') { if (j.state !== 'done') throw new Error(j.error); return { ...info, file: j.file }; } }
  }, mode);
  return { ...r, md5: md5(path.join(HOME, 'exports', r.file)) };
};
let fails = 0;
for (const scene of ['with overlays', 'text only']) {
if (scene === 'text only') await ev(() => { P.fx = []; renderAll(); }); // the box is then the text's, not the whole frame
const W = await run('workers'), Pg = await run('page'), O = await run('old');
const cmp = (a, b2) => { const d = a.md5.map((l, i) => l === b2.md5[i] ? -1 : i).filter(i => i >= 0); return { frames: a.md5.length, differ: d.length + Math.abs(a.md5.length - b2.md5.length), first: d.slice(0, 5) }; };
for (const [n, a, b2] of [['workers vs page', W, Pg], ['workers vs old full-frame', W, O]]) {
  const c = cmp(a, b2); if (c.differ || !c.frames) fails++;
  console.log(`${c.differ || !c.frames ? 'FAIL' : 'PASS'} ${scene}, ${n}: ${c.frames} frames, ${c.differ} differ ${c.first.length ? `(first: ${c.first})` : ''}`);
}
console.log(`modes: ${W.mode} / ${Pg.mode} / ${O.mode}; PNGs ${W.n} / ${Pg.n} / ${O.n}; box ${JSON.stringify(W.box)}; files ${W.file}, ${Pg.file}, ${O.file}`);
if (W.mode !== 'workers') { fails++; console.log('FAIL the workers did not run: S.layerMode', W.mode); }
}
// the probe: workers without the page's fonts must hand the layer to the page
const fb = await ev(async () => { const f0 = layerFontList; layerFontList = async () => []; S.layerForce = undefined;
  try { await buildPlan(1920, 1080, 'fast', 'x', false, 'prores'); return { mode: S.layerMode, why: S.layerStats.why }; } finally { layerFontList = f0; } });
if (fb.mode !== 'page' || !/^font probe/.test(fb.why)) fails++;
console.log(`${fb.mode === 'page' && /^font probe/.test(fb.why) ? 'PASS' : 'FAIL'} workers without the fonts -> page fallback (${fb.mode}: ${fb.why})`);
await b.close();
process.exit(fails ? 1 : 0);
