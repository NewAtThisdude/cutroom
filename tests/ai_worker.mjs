// The long-lived AI worker and what it feeds (committee item 38), on a SCRATCH library that holds the test media
// (fox-walk + its clean plate talk-with-music, the night-drive project "Midnight Highway Journey"):
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node tests/ai_worker.mjs [api] [remove] [voice] [ui] [captions] [pauses]
// api: outline clicks after the first on a frame < 300 ms; the 2 %-margin fox box covers >= 95 % of the true fox and its legs.
// remove: Best removal seeded with that outline, every one of the 120 frames' worst 8 px block < 20 levels off the clean plate.
// ui (both motion modes): an older outline answer arriving late is dropped; a low-confidence box says so; a refine click's time.
// voice: Kokoro voiceovers through the worker. captions: the night-drive project transcribes only its used spans (+1 s), not
// the 431 s of source. pauses: warm click < 0.3 s. Fixtures: tests/fox_truth.py (AI venv) scores outlines and fills.
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', HOME = process.env.CUTROOM_HOME;
if (!HOME || /4610$/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port>');
const PY = path.join(import.meta.dirname, '..', 'ai', '.venv', 'bin', 'python'), TRUTH = path.join(import.meta.dirname, 'fox_truth.py');
const FOX = '87cf24520932', DRIVE = 'ab4bbf27d216', BOX = { x: 0.21, y: 0.62, w: 0.16, h: 0.26 }; // the fox at 1 s, ~2 % margin
const LOOSE = { x: 0.18, y: 0.596, w: 0.2258, h: 0.3167 }; // 5 % margin round it: SAM 2's box-only candidates hold no fox
const want = process.argv.slice(2), run = n => !want.length || want.includes(n);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-ai38-'));
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (p, body) => {
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
};
const timed = async f => { const a = performance.now(), r = await f(); return [r, performance.now() - a]; };
const pyEnv = { ...process.env }; delete pyEnv.PYTHONPATH; // the shell's brew PYTHONPATH shadows the venv's packages
const truth = (...a) => JSON.parse(execFileSync(PY, ['-I', TRUTH, ...a], { env: pyEnv }).toString());

let outline;
if (run('api') || run('remove')) {
  const ask = (extra = {}) => timed(() => api('/api/mask_preview', { media: FOX, t: 1, box: BOX, ...extra }));
  const [r0, cold] = await ask(), [, warm1] = await ask(), [, warm2] = await ask(), [r3, click] = await ask({ points: [[0.29, 0.73, 1]] });
  outline = r0;
  check('outline clicks after the first on a frame < 300 ms', Math.max(warm1, warm2, click) < 300,
    `first ${cold.toFixed(0)} ms, again ${warm1.toFixed(0)} / ${warm2.toFixed(0)} ms, + a click ${click.toFixed(0)} ms (${r3.masks.length} candidates)`);
  fs.writeFileSync(path.join(tmp, 'pick.png'), Buffer.from(r0.mask, 'base64'));
  const t = truth('mask', HOME, '1', path.join(tmp, 'pick.png'));
  check('the 2 %-margin fox box covers 95 %+ of the true fox and its legs', t.fox >= 0.95 && t.legs >= 0.95,
    `fox ${(t.fox * 100).toFixed(1)} %, legs ${(t.legs * 100).toFixed(1)} %, ${t.extra_px} px of background; pick ${r0.pick} of ${r0.areas.length}, scores ${r0.scores}, unsure ${r0.unsure}`);
  const [cut] = await ask({ mode: 'cutout' });
  fs.writeFileSync(path.join(tmp, 'cut.png'), Buffer.from(cut.mask, 'base64'));
  const tc = truth('mask', HOME, '1', path.join(tmp, 'cut.png'));
  check('a cutout keeps to one outline (no union of candidates)', cut.areas.length <= r0.areas.length && tc.fox > 0.9, `fox ${(tc.fox * 100).toFixed(1)} %, ${tc.extra_px} px extra`);
  const [loose] = await ask({ box: LOOSE });
  fs.writeFileSync(path.join(tmp, 'loose.png'), Buffer.from(loose.mask, 'base64'));
  const tl = truth('mask', HOME, '1', path.join(tmp, 'loose.png'));
  check('a 5 %-margin box: the centre point still finds the fox, and it is flagged unsure', tl.fox >= 0.95 && loose.unsure,
    `covers ${(tl.fox * 100).toFixed(1)} % of the fox (+${tl.extra_px} px), unsure ${loose.unsure}, scores ${loose.scores}`);
}
if (run('remove')) {
  const { job } = await api('/api/remove_object', { media: FOX, t: 1, t0: 0, t1: 4, box: BOX, quality: 'best', mode: 'remove', seed: outline.mask });
  let j; const a = performance.now();
  for (;;) { await new Promise(z => setTimeout(z, 1000)); j = await api(`/api/jobs/${job}`); if (j.state !== 'running') break; }
  if (j.state !== 'done') check('Best removal ran', false, j.error);
  else {
    const m = (await api('/api/media')).find(x => x.id === j.media), f = truth('fill', HOME, path.join(HOME, 'media', m.file));
    check('Best removal: every frame\'s worst 8 px block < 20 levels off the clean plate', f.frames === 120 && f.over20 === 0,
      `${f.frames} frames, ${f.over20} over 20, ${f.over40} over 40, worst ${Math.max(...f.worst)}; ${j.engine}, ${((performance.now() - a) / 1000).toFixed(0)} s, media ${j.media}`);
  }
}

if (run('voice')) { // Kokoro stays loaded in the worker: the second voiceover skips the model load
  const say = async text => {
    const { job } = await api('/api/ai/voice', { text, voice: 'af_heart', speed: 1 }), a = performance.now();
    let j; for (;;) { await new Promise(z => setTimeout(z, 200)); j = await api(`/api/jobs/${job}`); if (j.state !== 'running') break; }
    return { ms: performance.now() - a, j, m: (await api('/api/media')).find(x => x.id === j.media) };
  };
  const v1 = await say('Idling burns a gallon an hour. Shut it off.'), v2 = await say('Shut it off and save the fuel.');
  check('AI voiceovers through the worker', v1.m?.duration > 1 && v2.m?.duration > 1, `${(v1.ms / 1000).toFixed(1)} s then ${(v2.ms / 1000).toFixed(1)} s for ${v1.m?.duration?.toFixed(2)} / ${v2.m?.duration?.toFixed(2)} s of speech${v1.j.error ? ' ' + v1.j.error : ''}`);
}

if (run('ui') || run('captions') || run('pauses')) {
  const b = await webkit.launch();
  for (const rm of (run('ui') ? ['no-preference', 'reduce'] : ['reduce'])) {
    const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
    await page.route(u => u.pathname === '/api/remote/next', r => setTimeout(() => r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}), 15000));
    await page.goto(B + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
    const inPage = (f, a) => page.evaluate(f, a);
    if (run('ui')) {
      await inPage(id => { setProject(newProject('16:9')); P.name = 'ai worker test (scratch)'; addMedia(id, 'main'); S.sel = null; renderAll(); seekTo(1); }, FOX);
      let n = 0; // the first outline answer arrives late, after the second (a quick refine click): the second must win
      await page.route(u => u.pathname === '/api/mask_preview', async r => { if (n++ === 0) await new Promise(z => setTimeout(z, 1500)); r.continue(); });
      const late = await inPage(async box => {
        const c = P.main[0], rect = { x: box.x * P.w, y: box.y * P.h, w: box.w * P.w, h: box.h * P.h };
        const a = maskPreview(c, 'main', rect, 1, 'remove'); await sleep(100);
        const b = maskPreview(c, 'main', rect, 1, 'remove', [[0.29, 0.73, 1]]);
        const [ra, rb] = await Promise.all([a, b]);
        return { dropped: ra === null, shown: !!rb, points: S.maskPreview.points.length };
      }, BOX);
      await page.unroute(u => u.pathname === '/api/mask_preview');
      check(`${rm}: an older outline answer arriving late is dropped`, late.dropped && late.shown && late.points === 1, JSON.stringify(late));
      const ui = await inPage(async ([box, loose]) => { // the confirm bar through the real flow; then a click on the fox, timed to the new outline
        S.maskPreview = null; const c = P.main[0]; S.pick = { c, lane: 'main', remove: true, mode: 'remove' };
        await finishRemove({ x: box.x * P.w, y: box.y * P.h, w: box.w * P.w, h: box.h * P.h });
        const sure = $('#confirmBar span').textContent, before = S.maskPreview, a = performance.now();
        await refinePreview(0.29 * P.w, 0.73 * P.h, true);
        const ms = performance.now() - a, changed = S.maskPreview !== before;
        endPreview('cancel');
        S.pick = { c, lane: 'main', remove: true, mode: 'remove' };
        await finishRemove({ x: loose.x * P.w, y: loose.y * P.h, w: loose.w * P.w, h: loose.h * P.h });
        const unsure = { flag: S.maskPreview?.unsure, text: $('#confirmBar span').textContent };
        endPreview('cancel');
        return { sure, ms, changed, unsure, hidden: $('#confirmBar').hidden };
      }, [BOX, LOOSE]);
      check(`${rm}: a sure outline asks to remove the pink part`, /Remove the pink part/.test(ui.sure), ui.sure);
      check(`${rm}: a refine click on the frame redraws the outline < 300 ms`, ui.changed && ui.ms < 300, `${ui.ms.toFixed(0)} ms`);
      check(`${rm}: a box SAM 2 is unsure of says so`, ui.unsure.flag && /Not sure what you boxed/.test(ui.unsure.text), JSON.stringify(ui.unsure));
      const demo = (await inPage(() => api('/api/projects'))).find(p => /Cutroom demo/.test(p.name)).id; // edit by script: words of the used spans
      await inPage(id => openProject(id), demo); await page.waitForTimeout(1500);
      let asks = 0; const count = r => { if (r.url().endsWith('/api/transcribe')) asks++; }; page.on('request', count);
      const sc = await inPage(async () => { await renderScript(); const n = SC.words?.length || 0; await renderScript(); return { n, text: SC.words.map(w => w.w).join(' ').slice(0, 80) }; });
      page.off('request', count);
      check(`${rm}: edit by script gets the main track's words, once`, sc.n > 5 && asks <= 1, `${sc.n} words, ${asks} transcribe asks: ${sc.text}`);
    }
    if (run('captions')) { // the real night-drive edit: what whisper listens to, from the words caches' heard spans
      const used = JSON.parse(fs.readFileSync(path.join(HOME, 'projects', `${DRIVE}.json`))), heard = () => Object.fromEntries(
        [...new Set([...used.main, ...used.audio].map(c => c.media))].map(id => { const f = path.join(HOME, 'cache', `${id}.auto.words.json`); const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
          return [id, d ? (Array.isArray(d) ? Infinity : d.have.reduce((s, [a, z]) => s + z - a, 0)) : 0]; }));
      const dji = ['979a851bf114', '1640ec308499', '6d11bd2694f2'], wf = id => path.join(HOME, 'cache', `${id}.auto.words.json`);
      // a whole-file cache from before spans would answer without listening (heard = Infinity): park it for this check, put it back after
      const parked = dji.filter(id => fs.existsSync(wf(id)) && Array.isArray(JSON.parse(fs.readFileSync(wf(id)))));
      for (const id of parked) fs.renameSync(wf(id), wf(id) + '.parked');
      const before = heard();
      await inPage(id => openProject(id), DRIVE); await page.waitForTimeout(2000);
      await page.click('.rail button[data-tab="captions"]'); await inPage(() => { $('#capLang').value = 'auto'; });
      const pct = []; const poll = setInterval(async () => { pct.push(await page.$eval('#capStatus', e => e.textContent).catch(() => '')); }, 500);
      const [, ms] = await timed(async () => { await page.click('#btnCaptions'); await page.waitForTimeout(300); await page.waitForFunction(() => !$('#btnCaptions').disabled, null, { timeout: 900000, polling: 200 }); });
      clearInterval(poll);
      const after = heard(), src = await inPage(() => [...P.main, ...($('#capAudio').checked ? P.audio : [])].reduce((s, c) => s + c.out - c.in, 0));
      for (const id of parked) fs.renameSync(wf(id) + '.parked', wf(id));
      const newly = dji.reduce((s, id) => s + after[id] - before[id], 0);
      check('captions on the night-drive project listen to the used spans only', dji.every(id => Number.isFinite(after[id])) && newly < 80,
        `DJI: ${newly.toFixed(1)} s heard (${dji.map(id => `${id.slice(0, 4)} ${before[id].toFixed(0)}->${after[id].toFixed(0)}`).join(', ')}), used ${src.toFixed(1)} s incl. the music track, source 431 s, ${(ms / 1000).toFixed(1)} s; status ${[...new Set(pct.filter(Boolean))].slice(-3).join(' / ')}`);
    }
    if (run('pauses')) { // Remove pauses on a 4 GB 4K original: first click reads its PCM copy, later ones the cache
      await inPage(id => { setProject(newProject('16:9')); P.name = 'pauses test (scratch)'; addMedia(id, 'main'); renderAll(); }, '979a851bf114');
      let asked = 0; page.on('request', r => { if (r.url().endsWith('/api/silences')) asked++; });
      const click = () => inPage(async () => { // each click on the same clip: the cut (if any) is undone before the next
        const n = undo.length, a = performance.now(); await removePauses(0.7).catch(() => {}); const ms = performance.now() - a;
        const cut = undo.length > n; if (cut) restore(undo, redo); return { ms, cut, clips: P.main.length };
      });
      const cold = await click(), warm = [await click(), await click()];
      check('Remove pauses, warm click < 0.3 s', asked === 3 && warm.every(w => w.clips === 1) && Math.max(...warm.map(w => w.ms)) < 300,
        `first ${cold.ms.toFixed(0)} ms, then ${warm.map(w => w.ms.toFixed(0)).join(' / ')} ms; ${asked} server asks, cut: ${cold.cut}`);
    }
    check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
    await page.context().close();
  }
  await b.close();
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
