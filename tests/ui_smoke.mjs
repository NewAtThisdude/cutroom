// Headless WebKit smoke test of the on-demand preview: nothing redraws at rest, a seek draws the frame, playback paints at
// the project frame rate and stops on pause, gallery tiles are still and only the hovered one plays. Both motion modes.
//   node ui_smoke.mjs     (server on 127.0.0.1:4610)
import { webkit } from 'playwright';
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const b = await webkit.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto((process.env.B || 'http://127.0.0.1:4610') + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  const id = (await ev(() => api('/api/projects'))).find(p => /cinematic/.test(p.name)).id;
  await ev(id => openProject(id), id); await page.waitForTimeout(3000);
  await ev(() => { window.N = 0; const op = paint; paint = () => { N++; op(); }; });
  await page.waitForTimeout(3000);
  check(`${rm}: nothing redraws at rest`, await ev(() => N) === 0, `${await ev(() => N)} paints in 3 s`);
  const seek = await ev(async () => { N = 0; S.t = 4.2; S.dirty = true; await waitFrame(); const v = [...S.live][0], x = document.createElement('canvas').getContext('2d'); x.canvas.width = 16; x.canvas.height = 9; x.drawImage(document.querySelector('#cv'), 0, 0, 16, 9); const d = x.getImageData(0, 0, 16, 9).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return { n: N, lit: s / (16 * 9 * 3), at: v && Math.abs(v.currentTime - (v._want ?? v.currentTime)) }; });
  check(`${rm}: a seek draws that frame`, seek.n >= 1 && seek.lit > 5 && seek.at < 0.05, `${seek.n} paints, mean ${seek.lit.toFixed(0)}, video ${seek.at?.toFixed(3)} s off`);
  const pl = await ev(async () => { N = 0; S.t = 0; play(); await sleep(3000); pause(); const n = N, t = S.t; await sleep(1000); const m = N; await sleep(1500); return { rate: n / 3, after: N - m, fps: P.fps, t, busy: busyN }; }); // pause snaps to a frame: a few settling paints, then none
  check(`${rm}: playback paints at the project frame rate`, pl.rate > pl.fps * 0.8 && pl.rate < pl.fps * 1.2 && pl.t > 2.5, `${pl.rate.toFixed(1)}/s at ${pl.fps} fps, playhead ${pl.t.toFixed(2)} s`);
  check(`${rm}: pause stops drawing and releases the App Nap hold`, pl.after <= 2 && pl.busy === 0, `${pl.after} paints after pause, busy ${pl.busy}`);
  await page.click('.rail button[data-tab="effects"]'); await page.waitForTimeout(500);
  const tiles = page.locator('#tab-effects .tile[data-fx]');
  const sig = i => tiles.nth(i).evaluate(t => t.firstElementChild.toDataURL().length + ':' + t.firstElementChild.toDataURL().slice(-40));
  const s0 = [await sig(0), await sig(1)];
  await tiles.nth(0).hover(); await page.waitForTimeout(700);
  const s1 = [await sig(0), await sig(1)];
  check(`${rm}: the hovered tile plays, the others stay still`, s1[0] !== s0[0] && s1[1] === s0[1]);
  await page.mouse.move(5, 5); await page.waitForTimeout(300);
  check(`${rm}: no gallery loop once the pointer leaves`, await ev(() => !G.raf));
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
