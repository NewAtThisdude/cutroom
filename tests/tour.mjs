// First-start tour (web/tour.js): shown once on an empty library, each step's ring on a visible part and its card inside the
// window and off the ring, Back / Next / Esc / keys, remembered after it ends, replayed from the shortcut sheet, never on a
// library that has media; both motion modes, no page errors. Screenshots of every step go to tests/out/tour/.
//   B=<server on an EMPTY scratch library> [B2=<server on a scratch library with media>] node tour.mjs   (never 4610)
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const B = process.env.B, B2 = process.env.B2, OUT = fileURLToPath(new URL('./out/tour/', import.meta.url));
if (!B || /:4610\b/.test(B)) { console.log('SKIP: set B to a scratch server on an empty library (never 4610)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const open = async url => { await page.goto(`${url}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 }); await page.waitForTimeout(400); };
  await open(B);
  // the three setup questions first: YouTube, extra smooth, English
  const q1 = await page.evaluate(() => $('#setupQ')?.textContent);
  check(`${rm}: an empty library on a first start asks the setup questions first`, q1 === 'What do you make most?', q1);
  await page.click('#tour .sopt[data-s="youtube"]'); await page.keyboard.press('ArrowDown'); // (arrows move between answers)
  await page.click('#tour .sopt[data-s="60"]'); await page.click('#tour .sopt[data-s="en"]');
  const set = await page.evaluate(() => ({ prefs: JSON.parse(store.get('cutroom.prefs') || '{}'), w: P.w, h: P.h, fps: P.fps, lang: $('#capLang').value, at: tourAt }));
  check(`${rm}: the answers set the defaults: a 16:9 60 fps project, YouTube 1080p export, English captions; then the tour`,
    set.prefs.ratio === '16:9' && set.prefs.preset === 'yt1080' && set.prefs.fps === 60 && set.w === 1920 && set.h === 1080 && set.fps === 60 && set.lang === 'en' && set.at === 1, JSON.stringify(set));
  await page.evaluate(async () => { await REMOTE.add_text({ text: 'Setup check', start: 0, duration: 2 }); openExport(); }); // (Export needs something on the timeline)
  const ex = await page.evaluate(() => [$('#exPreset')?.value, $('#exFps')?.value]);
  await page.evaluate(() => { closeModal(); P.text = []; renderAll(); scheduleSave(); }); // (the check's text off again)
  check(`${rm}: the Export dialog starts on the YouTube 1080p preset`, ex[0] === 'yt1080', JSON.stringify(ex));
  await page.evaluate(() => tourShow(0));
  const n = await page.evaluate(() => TOUR.length), TOUR_EL = await page.evaluate(() => TOUR.map(s => !!s.el)), bad = [];
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(rm === 'reduce' ? 50 : 300); // (the ring glides there without reduced motion)
    const g = await page.evaluate(() => {
      const r = x => x && !x.hidden ? x.getBoundingClientRect().toJSON() : null, ring = r($('#tour .tring')), card = r($('#tour .tcard'));
      const s = TOUR[tourAt], el = s.el && $(s.el), er = el ? el.getBoundingClientRect() : null;
      return { i: tourAt, ring, card, er, step: $('#tour .tstep').textContent, focus: document.activeElement?.dataset.t };
    });
    await page.screenshot({ path: `${OUT}${rm}-${i + 1}.png` });
    const inside = c => c && c.left >= 0 && c.top >= 0 && c.right <= 1517 && c.bottom <= 904;
    const apart = !g.ring || g.card.right <= g.ring.left + 4 || g.card.left >= g.ring.right - 4 || g.card.bottom <= g.ring.top + 4 || g.card.top >= g.ring.bottom - 4;
    const ringOn = !g.er || (g.ring && Math.abs(g.ring.left - (g.er.left - 4)) < 1 && Math.abs(g.ring.width - (g.er.width + 8)) < 1);
    if (!(g.i === i && inside(g.card) && (TOUR_EL[i] ? g.ring : !g.ring) && ringOn && g.focus === 'next' && g.step === `${i + 1} of ${n}`)) bad.push(JSON.stringify(g));
    if (i === n - 1 && !(await page.evaluate(() => /github\.com/.test($('#tour .tlink a')?.href || '') && !$('#tour .tlink').hidden))) bad.push('the last step has no GitHub link');
    if (i > 0 && TOUR_EL[i] && !apart && !/timeline/.test(await page.evaluate(() => TOUR[tourAt].el))) bad.push(`step ${i + 1}: the card covers the part it points at`);
    if (i === 2) { // Back returns; Space presses the focused Next (as on any button) and never reaches the editor (no playing)
      await page.keyboard.press('ArrowLeft'); const back = await page.evaluate(() => tourAt);
      await page.keyboard.press('Space'); await page.waitForTimeout(100);
      const [at, playing] = await page.evaluate(() => [tourAt, S.playing]);
      if (back !== 1 || at !== 2 || playing) bad.push(`back ${back}, after Space ${at}, playing ${playing}`);
    }
    await page.click('#tour [data-t="next"]');
  }
  check(`${rm}: ${n} steps, each ring on its part, the card inside the window and beside it, Next focused, Back and keys right`, !bad.length, bad.join(' | ').slice(0, 600));
  const stored = await page.evaluate(() => store.get('cutroom.tour')), gone = !(await page.$('#tour'));
  await open(B);
  check(`${rm}: the last step closes it and it stays closed after a reload`, gone && stored === 'done' && !(await page.$('#tour')), `stored ${stored}`);
  await page.keyboard.press('?'); await page.click('#modal [data-tour]');
  check(`${rm}: the shortcut sheet replays it`, await page.isVisible('#tour .tcard') && (await page.evaluate(() => tourAt)) === 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('?'); await page.click('#modal [data-setup]');
  const again = await page.evaluate(() => $('#setupQ')?.textContent); await page.click('#tour [data-x="skip"]');
  check(`${rm}: the shortcut sheet asks the setup questions again; Skip keeps the answers`, again === 'What do you make most?' && JSON.parse(await page.evaluate(() => store.get('cutroom.prefs'))).ratio === '16:9');
  if (await page.$('#tour')) await page.keyboard.press('Escape');
  check(`${rm}: Esc closes it (skipped)`, !(await page.$('#tour')) && (await page.evaluate(() => store.get('cutroom.tour'))) === 'skipped');
  if (B2) { // a fresh Mac (nothing stored) on a library that already has media: no tour
    const c2 = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), p2 = await c2.newPage();
    await p2.goto(`${B2}/`, { waitUntil: 'load' }); await p2.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 }); await p2.waitForTimeout(400);
    check(`${rm}: a library with media opens straight into the editor`, !(await p2.$('#tour')));
    await c2.close();
  }
  check(`${rm}: no page errors`, !errs.length, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
