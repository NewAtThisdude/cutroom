// Headless WebKit: the export dialog's Light toggle (VideoToolbox decode) is there, off by default, off for sound-only and
// subtitle formats, sent as plan.light, and a Light export of a plain-cut project finishes. Both motion modes.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node export_light.mjs     (a scratch server, never 4610)
import { browser } from './browser.mjs';
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto((process.env.B || 'http://127.0.0.1:4610') + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  const id = (await ev(() => api('/api/projects'))).find(p => /Remove object example/.test(p.name)).id; // one plain clip: the 4:2:0 path
  await ev(id => openProject(id), id); await page.waitForTimeout(1500);
  await page.click('#btnExport'); await page.waitForSelector('#exLight');
  check(`${rm}: Light toggle in the dialog, off by default`, await page.isVisible('#exLight') && !(await page.isChecked('#exLight')));
  const dis = {};
  for (const f of ['mp3', 'wav', 'srt', 'gif', 'png', 'mp4']) { await page.selectOption('#exFmt', f); dis[f] = await page.isDisabled('#exLight'); }
  check(`${rm}: off for sound-only and subtitles, on for picture formats`, dis.mp3 && dis.wav && dis.srt && !dis.gif && !dis.png && !dis.mp4, JSON.stringify(dis));
  let sent = null;
  await page.route('**/api/export', r => { sent = r.request().postDataJSON(); r.continue(); });
  await page.check('#exLight');
  await page.selectOption('#exRes', '0'); // 720p, the smallest: quick
  await page.click('#exGo');
  await page.waitForFunction(() => !S.exporting && /Saved/.test(document.querySelector('#exStatus')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
  const st = await page.textContent('#exStatus');
  check(`${rm}: plan.light sent and the Light export finishes`, sent?.light === true && /Saved/.test(st), `light ${sent?.light}, ${st}`);
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
