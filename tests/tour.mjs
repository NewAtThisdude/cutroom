// First-start tour (web/tour.js): shown once on an empty library, each step's ring on a visible part and its card inside the
// window and off the ring, Back / Next / Esc / keys, remembered after it ends, replayed from the shortcut sheet, never on a
// library that has media; both motion modes, no page errors. Screenshots of every step go to tests/out/tour/.
//   B=<server on an EMPTY scratch library> [B2=<server on a scratch library with media>] node tour.mjs   (never 4610)
import { webkit } from 'playwright';
import fs from 'node:fs';
const B = process.env.B, B2 = process.env.B2, OUT = new URL('./out/tour/', import.meta.url).pathname;
if (!B || /:4610\b/.test(B)) { console.log('SKIP: set B to a scratch server on an empty library (never 4610)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const b = await webkit.launch();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const open = async url => { await page.goto(`${url}/`, { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 }); await page.waitForTimeout(400); };
  await open(B);
  check(`${rm}: an empty library on a first start opens the tour`, await page.isVisible('#tour .tcard'));
  const n = await page.evaluate(() => TOUR.length), bad = [];
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
    if (!(g.i === i && inside(g.card) && (i === 0 ? !g.ring : g.ring) && ringOn && g.focus === 'next' && g.step === `${i + 1} of ${n}`)) bad.push(JSON.stringify(g));
    if (i > 0 && !apart && !/timeline/.test(await page.evaluate(() => TOUR[tourAt].el))) bad.push(`step ${i + 1}: the card covers the part it points at`);
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
