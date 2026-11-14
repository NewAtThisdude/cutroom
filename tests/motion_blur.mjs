// Motion blur (committee item 35): the clip setting (tmix in the export, the GPU mix of the same frames in the preview),
// the Motion blur / Zoom blur effects and the Whip left / Whip right / Zoom blur transitions. Checks the plan and the
// export picture, the UI in both motion modes, and the paint rate while playing a 1080p60 project (paints per second =
// frames the preview drew; it paints once per project frame, so 60 is the ceiling). Preview == export pictures are in
// video_parity.mjs ("motion blur", "transition whip", "transition zoomblur", "effect motionblur", "effect zoomblur").
//   B=http://127.0.0.1:<scratch port> node motion_blur.mjs
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const res = [], check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-mb-`), f = `${tmp}/mb-1080p60.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', f]);
const V = await (await fetch(`${B}/api/import?name=mb-1080p60.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
fs.rmSync(tmp, { recursive: true });
const b = await browser.launch(), pids = [];
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // (not the MCP's editor)
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (fn, a) => page.evaluate(fn, a);
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, V.id, { timeout: 60000 });
  // three 2x main clips, motion blur 0.5 on all of them, 60 fps
  pids.push(await ev(id => { setProject(newProject('16:9')); P.name = 'Motion blur (scratch)'; P.fps = 60;
    for (const at of [0, 5.5, 11]) { addMedia(id, 'main'); Object.assign(P.main.at(-1), { in: at, out: at + 5, speed: 2, mb: 0.5 }); } // 2.5 s each: playback runs 7.5 s
    packMain(); S.sel = null; renderAll(); return P.id; }, V.id));
  if (rm === 'no-preference') {
    const plan = await ev(async () => (await buildPlan(640, 360, 'fast', 'mb', false, 'png')).main.map(c => c.mb));
    check('a 2x clip at motion blur 0.5 asks the export for a 3-frame mix', plan.every(n => n === 3), JSON.stringify(plan));
    const diff = await ev(async () => { // the export's frame with and without it: tmix changes the moving parts
      const px = async b64 => { const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
      const a = await px((await REMOTE.snapshot({ t: 1.0, max: 640 })).image);
      const keep = P.main.map(c => c.mb); P.main.forEach(c => { c.mb = 0; });
      const z = await px((await REMOTE.snapshot({ t: 1.0, max: 640 })).image);
      P.main.forEach((c, i) => { c.mb = keep[i]; });
      let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - z[i]) + Math.abs(a[i + 1] - z[i + 1]) + Math.abs(a[i + 2] - z[i + 2]);
      return s / (160 * 90 * 3);
    });
    check('the exported frame is mixed (differs from the unblurred one)', diff > 1, `mean difference ${diff.toFixed(2)} levels`);
  }
  // the inspector's slider and the galleries
  const slider = await ev(async () => { S.sel = { lane: 'main', id: P.main[0].id }; renderAll(); await sleep(100); const sl = document.querySelector('input[data-k="c.mb"]'); S.sel = null; renderAll(); return sl && +sl.value; });
  await page.click('.rail button[data-tab="transitions"]'); await page.waitForTimeout(400);
  const tr = await ev(() => ['whipleft', 'whipright', 'zoomblur'].map(k => !!document.querySelector(`#tab-transitions .tile[data-trset="${k}"]`)));
  await page.click('.rail button[data-tab="effects"]'); await page.waitForTimeout(400);
  const fx = await ev(() => ['motionblur', 'zoomblur'].map(k => !!document.querySelector(`#tab-effects .tile[data-fx="${k}"]`)));
  const ui = { slider, tr, fx };
  check(`${rm}: Motion blur slider in the clip panel`, ui.slider === 0.5, `value ${ui.slider}`);
  check(`${rm}: Whip left, Whip right and Zoom blur in the transitions gallery`, ui.tr.every(Boolean), JSON.stringify(ui.tr));
  check(`${rm}: Motion blur and Zoom blur in the effects gallery`, ui.fx.every(Boolean), JSON.stringify(ui.fx));
  // playback with motion blur on every main clip
  const run = async () => ev(async () => {
    S.t = 0; await waitFrame(); play(); await sleep(3000); pause(); // once through first: a clip's first load stalls WebKit (not the effect)
    S.t = 0; await waitFrame(); play(); await sleep(1200);
    const op = paint; let n = 0, inTr = 0, trWall = 0, last = performance.now(); const ov = P.main.slice(1).map(c => [c.start, c.start + trF(P.main.indexOf(c) - 1) / P.fps]);
    let js = 0;
    paint = () => { const now = performance.now(), tr = ov.some(([a, z]) => S.t >= a && S.t < z); n++; if (tr) { inTr++; trWall += now - last; } last = now; op(); js += performance.now() - now; };
    const t0 = performance.now(); await sleep(4500); const wall = (performance.now() - t0) / 1000;
    pause(); paint = op;
    return { fps: n / wall, ms: js / n, trFps: trWall ? inTr / (trWall / 1000) : 0, inTr, gpu: !!GPU.gl && !!GPU.mb };
  });
  const p1 = await run();
  await ev(() => { P.main.forEach(c => { c.mb = 0; }); renderAll(); });
  const p0 = await run(); // the same without it, for scale (the machine may be busy)
  check(`${rm}: playback with motion blur on all main clips paints 58+ per second`, p1.fps >= 58 && p1.gpu, `${p1.fps.toFixed(1)}/s, paint ${p1.ms.toFixed(2)} ms JS (without: ${p0.fps.toFixed(1)}/s, ${p0.ms.toFixed(2)} ms), GPU mix ${p1.gpu}`);
  // the three blur transitions between the clips (0.5 s each)
  await ev(() => { ['whipleft', 'whipright'].forEach((t, i) => { P.main[i].tr = { type: t, d: 0.5 }; }); P.main.forEach(c => { c.mb = 0; }); packMain(); renderAll(); });
  const p2 = await run();
  await ev(() => { P.main[0].tr = P.main[1].tr = { type: 'zoomblur', d: 0.5 }; packMain(); renderAll(); });
  const p3 = await run();
  check(`${rm}: whip transitions play at 55+ paints per second`, p2.trFps >= 55 && p2.inTr > 20, `${p2.trFps.toFixed(1)}/s over ${p2.inTr} transition frames, paint ${p2.ms.toFixed(2)} ms JS`);
  check(`${rm}: zoom blur transitions play at 55+ paints per second`, p3.trFps >= 55 && p3.inTr > 20, `${p3.trFps.toFixed(1)}/s over ${p3.inTr} transition frames, paint ${p3.ms.toFixed(2)} ms JS`);
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();
for (const pid of pids) await fetch(`${B}/api/projects/${pid}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
await fetch(`${B}/api/media/${V.id}/trash`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
