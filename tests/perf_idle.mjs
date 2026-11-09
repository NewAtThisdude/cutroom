// CPU use of the editor (headless WebKit, the app's engine) + the server: idle, effects gallery open, playing.
// CPU seconds per wall second over 20 s windows (1.00 = one core busy). Needs the server on 127.0.0.1:4610.
//   node perf_idle.mjs [--reduce]
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
const PORT = process.env.PORT || '4610';
const reduce = process.argv.includes('--reduce'), WIN = 20000;
const pids = () => execFileSync('sh', ['-c', `pgrep -f 'ms-playwright/webkit' ; lsof -t -nP -iTCP:${PORT} -sTCP:LISTEN`]).toString().split(/\s+/).filter(Boolean);
const cpu = list => execFileSync('ps', ['-o', 'time=', '-p', list.join(',')]).toString().trim().split('\n')
  .reduce((s, t) => { const [m, sec] = t.trim().split(':'); return s + +m * 60 + +sec; }, 0);
const server = () => execFileSync('sh', ['-c', 'lsof -t -nP -iTCP:'+PORT+' -sTCP:LISTEN']).toString().trim();
const b = await webkit.launch();
const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: reduce ? 'reduce' : 'no-preference' })).newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const measure = async name => {
  const all = pids(), sv = server(), a = cpu(all), s0 = cpu([sv]);
  await page.waitForTimeout(WIN);
  const tot = (cpu(all) - a) / (WIN / 1000), srv = (cpu([sv]) - s0) / (WIN / 1000);
  console.log(`${name.padEnd(34)} ${tot.toFixed(3)} cores  (server ${srv.toFixed(3)}, page+WebKit ${(tot - srv).toFixed(3)})`);
  return tot;
};
await page.waitForTimeout(8000); // settle: thumbnails, fonts, first frame
const out = { idle: await measure('idle, Media panel') };
await page.click('.rail button[data-tab="effects"]');
out.effects = await measure(`idle, Effects gallery${reduce ? ' (reduced motion)' : ''}`);
await page.click('.rail button[data-tab="media"]');
await page.evaluate(() => { if (P.main.length) play(); });
out.playing = await measure('playing the open project');
await page.evaluate(() => pause());
out.paused = await measure('paused again');
console.log(JSON.stringify(out));
await b.close();
