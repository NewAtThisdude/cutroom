// The Media panel's "Photos" button (import from Apple Photos): shown only inside the Mac app, where the page has the app's
// `photos` message handler, and a click posts 'pick' to it (the app then opens the system Photos picker as a sheet).
// Headless WebKit with window.webkit.messageHandlers stubbed; the real picker is native and not exercised here. Both motion modes.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node photos_button.mjs     (never 4610)
import { browser, macOnly } from './browser.mjs';
macOnly('photos_button: the Mac app\'s Photos picker');
const B = process.env.B;
if (!B || /:4610\b/.test(B) || !process.env.CUTROOM_HOME) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> (never 4610)');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  for (const app of [false, true]) {
    const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm });
    if (app) await ctx.addInitScript(() => { window.__posted = []; window.webkit = { messageHandlers: { photos: { postMessage(m) { window.__posted.push(m); } } } }; });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(B + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
    const where = app ? 'in the app' : 'in a browser';
    const btn = page.locator('#btnPhotos');
    const shown = await btn.isVisible();
    check(`${rm}, ${where}: Photos button ${app ? 'shown' : 'hidden'}`, shown === app, `visible=${shown}`);
    if (app) {
      const [i, p] = [await page.locator('label.import').boundingBox(), await btn.boundingBox()];
      check(`${rm}: it sits next to Import, same row and height`, Math.abs(i.y - p.y) < 1 && Math.abs(i.height - p.height) < 1 && p.x > i.x + i.width,
        `import ${i.x.toFixed(0)},${i.y.toFixed(0)} ${i.width.toFixed(0)}x${i.height.toFixed(0)}; photos ${p.x.toFixed(0)},${p.y.toFixed(0)} ${p.width.toFixed(0)}x${p.height.toFixed(0)}`);
      await btn.click();
      const posted = await page.evaluate(() => window.__posted);
      check(`${rm}: a click posts 'pick' to the app's photos handler`, JSON.stringify(posted) === '["pick"]', JSON.stringify(posted));
      const chooser = await page.evaluate(() => document.activeElement?.type === 'file');
      check(`${rm}: the click doesn't open the browser file chooser`, !chooser);
    }
    check(`${rm}, ${where}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
process.exit(res.every(Boolean) ? 0 : 1);
