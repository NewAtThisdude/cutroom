// Committee item 39 (feedback and polish), measured in headless WebKit in both motion modes: all ten rail tabs on a
// short window, portrait posters with their text for 9:16 projects, text drag snapping (centre / other text / safe
// margin, ⌘ to move freely) with a guide line, the main-track insertion line, clickable / draggable keyframe diamonds.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node polish_e2e.mjs     (never the real 4610 window)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const before = { p: new Set((await get('/api/projects')).map(x => x.id)), m: new Set((await get('/api/media')).map(x => x.id)) };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-polish-`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x404040:s=640x360:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${tmp}/polish-gray.mp4`]);
const GRAY = await (await fetch(`${B}/api/import?name=polish-gray.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(`${tmp}/polish-gray.mp4`) })).json();

const b = await webkit.launch();
try {
  for (const rm of ['no-preference', 'reduce']) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 800 }, reducedMotion: rm, deviceScaleFactor: rm === 'reduce' ? 2 : 1 }), page = await ctx.newPage(); // (reduce runs as a Retina screen, like his Mac)
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
    await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
    await page.goto(`${B}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
    const ev = (f, a) => page.evaluate(f, a);
    await ev(() => loadMedia());
    await page.waitForFunction(id => M.get(id)?.ready, GRAY.id, { timeout: 60000 });

    // 1. rail tabs on short windows
    const rail = () => ev(() => { const n = $('.rail'), r = n.getBoundingClientRect(), bs = [...n.querySelectorAll('button')]; return { n: bs.length, vis: bs.filter(x => { const q = x.getBoundingClientRect(); return q.top >= r.top - 0.5 && q.bottom <= r.bottom + 0.5; }).length, label: getComputedStyle(bs[0].querySelector('span')).display, fade: n.className, scroll: n.scrollHeight > n.clientHeight + 1 }; });
    const r800 = await rail();
    check(`${rm}: 1440x800 shows all ${r800.n} rail tabs, with their names`, r800.n === 10 && r800.vis === 10 && r800.label !== 'none', JSON.stringify(r800));
    await page.setViewportSize({ width: 1440, height: 760 }); await page.waitForTimeout(150);
    const r760 = await rail();
    check(`${rm}: 1440x760 (below 780): icons only, all ten visible`, r760.vis === 10 && r760.label === 'none', JSON.stringify(r760));
    await page.setViewportSize({ width: 1440, height: 560 }); await page.waitForTimeout(150);
    const r560 = await rail();
    await ev(() => { const n = $('.rail'); n.scrollTop = 9999; }); await page.waitForTimeout(100);
    const r560b = await rail();
    check(`${rm}: a rail that scrolls fades where tabs are hidden (bottom, then top once scrolled)`, r560.scroll && /\bfb\b/.test(r560.fade) && !/\bft\b/.test(r560.fade) && /\bft\b/.test(r560b.fade) && !/\bfb\b/.test(r560b.fade), `${r560.fade} -> ${r560b.fade}`);
    await page.setViewportSize({ width: 1440, height: 800 }); await page.waitForTimeout(150);

    // 3. text drag snapping
    await ev(() => { setProject(newProject('16:9')); P.name = 'Polish snap (scratch)'; renderAll(); });
    await ev(() => REMOTE.add_text({ text: 'Title A', start: 0, duration: 5, x: 0.3, y: 0.3 }));
    await ev(() => REMOTE.add_text({ text: 'Other B', start: 0, duration: 5, x: 0.72, y: 0.7 }));
    await ev(async () => { S.t = 1; S.sel = null; S.dirty = true; await waitFrame(); });
    const geo = () => ev(() => { const cv = $('#cv'), r = cv.getBoundingClientRect(), px = cv.width / r.width, k = cv.width / P.w, A = P.text[0], Bt = P.text[1], hA = hits.find(h => h.id === A.id), hB = hits.find(h => h.id === Bt.id); const s = h => ({ cx: r.left + (h.x0 + h.x1) / 2 / px, cy: r.top + (h.y0 + h.y1) / 2 / px, l: r.left + h.x0 / px }); return { r: { l: r.left, t: r.top, w: r.width, h: r.height }, px, k, A: s(hA), B: s(hB), ax: A.x, ay: A.y, boxCy: (hB.y0 + hB.y1) / 2 / k / P.h, boxAw: (hA.x1 - hA.x0) / 2 / k / P.w }; });
    const hold = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8); await page.waitForTimeout(60); };
    let g = await geo();
    const und0 = await ev(() => undo.length);
    await hold({ x: g.A.cx, y: g.A.cy }, { x: g.r.l + g.r.w / 2 + 4, y: g.A.cy });
    const mid = await ev(() => ({ x: P.text[0].x, guide: S.guides }));
    await page.mouse.up(); await page.waitForTimeout(60);
    const aft = await ev(() => ({ x: P.text[0].x, guide: S.guides, und: undo.length }));
    check(`${rm}: a title dragged to 4 px from the centre lands at x=0.5, with a guide while snapped, one undo step`, aft.x === 0.5 && mid.guide?.x === 0.5 && aft.guide === null && aft.und === und0 + 1, JSON.stringify({ mid, aft }));
    g = await geo();
    await page.keyboard.down('Meta');
    await hold({ x: g.A.cx, y: g.A.cy }, { x: g.A.cx + 4, y: g.A.cy });
    const free = await ev(() => ({ x: P.text[0].x, guide: S.guides }));
    await page.mouse.up(); await page.keyboard.up('Meta'); await page.waitForTimeout(60);
    const want = 0.5 + (4 * g.px) / g.k / 1920;
    check(`${rm}: with ⌘ held it moves freely (no snap, no guide)`, Math.abs(free.x - 0.5) > 0.001 && free.guide?.x == null, `x ${free.x.toFixed(4)} (free move ~${want.toFixed(4)})`);
    g = await geo();
    await hold({ x: g.A.cx, y: g.A.cy }, { x: g.r.l + 0.25 * g.r.w, y: g.B.cy + 3 }); // y 3 px off the other text's centre, x well away from everything
    const oth = await ev(() => { const k = $('#cv').width / P.w, h = hits.find(q => q.id === P.text[0].id); return { cy: (h.y0 + h.y1) / 2 / k / P.h, guide: S.guides }; });
    await page.mouse.up(); await page.waitForTimeout(60);
    check(`${rm}: snaps to the other text's centre line`, Math.abs(oth.cy - g.boxCy) < 1e-6 && Math.abs(oth.guide?.y - g.boxCy) < 1e-6, JSON.stringify({ ...oth, want: g.boxCy }));
    g = await geo();
    const safeL = g.r.l + 0.05 * g.r.w;
    await hold({ x: g.A.cx, y: g.A.cy }, { x: g.A.cx - (g.A.l - safeL) + 3, y: g.r.t + 0.4 * g.r.h }); // left edge 3 px inside the 5 % safe margin
    const safe = await ev(() => { const k = $('#cv').width / P.w, h = hits.find(q => q.id === P.text[0].id); return { left: h.x0 / k / P.w, guide: S.guides }; });
    await page.mouse.up(); await page.waitForTimeout(60);
    check(`${rm}: snaps its left edge to the 5 % safe margin`, Math.abs(safe.left - 0.05) < 0.002 && safe.guide?.x === 0.05, JSON.stringify(safe));

    // 4. main-track reorder insertion line
    await ev(id => { setProject(newProject('16:9')); P.name = 'Polish reorder (scratch)'; for (let i = 0; i < 3; i++) { addMedia(id, 'main'); Object.assign(P.main.at(-1), { in: 0, out: 2 }); } packMain(); S.sel = null; S.pps = 80; renderAll(); }, GRAY.id);
    await page.waitForTimeout(200);
    const ids = await ev(() => P.main.map(c => c.id));
    const c0 = await page.locator(`.clip[data-lane="main"][data-id="${ids[0]}"]`).boundingBox();
    await hold({ x: c0.x + c0.width / 2, y: c0.y + c0.height / 2 }, { x: c0.x + c0.width / 2 + c0.width * 1.3, y: c0.y + c0.height / 2 });
    const dl = await ev(() => { const l = $('#lane-main .dropline'); if (!l) return null; const cs = getComputedStyle(l); return { i: +l.dataset.i, left: parseFloat(l.style.left), end1: (P.main[1].start + tdur(P.main[1], 'main')) * S.pps, w: l.getBoundingClientRect().width, tr: cs.transitionDuration }; });
    await page.mouse.up(); await page.waitForTimeout(100);
    const order = await ev(() => ({ ids: P.main.map(c => c.id), line: !!$('#lane-main .dropline') }));
    check(`${rm}: dragging a main clip shows a 2 px line at the drop index, and it lands there`, dl && dl.i === 1 && Math.abs(dl.left - dl.end1) < 0.5 && Math.round(dl.w) === 2 && order.ids.join() === [ids[1], ids[0], ids[2]].join() && !order.line, JSON.stringify({ dl, order: order.ids.map(x => ids.indexOf(x)) }));
    check(`${rm}: the line ${rm === 'reduce' ? 'jumps (no transition)' : 'glides'}`, rm === 'reduce' ? parseFloat(dl?.tr) === 0 : parseFloat(dl?.tr) > 0, dl?.tr);

    // 5. keyframe diamonds
    await ev(() => { const c = P.main[1]; change(() => { c.kf = [{ t: 0, ...propsAt(c, 0) }, { t: 1, ...propsAt(c, 1), scale: 1.5 }]; }); S.sel = null; seekTo(0); renderAll(); });
    const cid = await ev(() => P.main[1].id), dsel = `.clip[data-lane="main"][data-id="${cid}"] .kfm[data-k="1"]`;
    const pe = await page.locator(dsel).evaluate(x => getComputedStyle(x).pointerEvents);
    await page.locator(dsel).click({ force: true }); await page.waitForTimeout(80);
    const sk = await ev(() => ({ t: S.t, want: P.main[1].start + P.main[1].kf[1].t, fps: P.fps }));
    check(`${rm}: clicking a keyframe diamond seeks to c.start + f.t`, pe !== 'none' && Math.abs(sk.t - sk.want) <= 0.5 / sk.fps + 1e-9, JSON.stringify({ pe, ...sk }));
    const u0 = await ev(() => undo.length), d = await page.locator(dsel).boundingBox();
    await hold({ x: d.x + d.width / 2, y: d.y + d.height / 2 }, { x: d.x + d.width / 2 + 27, y: d.y + d.height / 2 });
    await page.mouse.up(); await page.waitForTimeout(80);
    const mv = await ev(() => { const c = P.main[1]; return { t: c.kf.map(f => f.t), scale: c.kf.map(f => f.scale), fps: P.fps, pps: S.pps, und: undo.length, st: S.t, want: c.start + c.kf[1].t }; });
    const f1 = mv.t[1], onFrame = Math.abs(f1 * mv.fps - Math.round(f1 * mv.fps)) < 1e-6;
    check(`${rm}: dragging it moves that keyframe on frames, one undo step`, onFrame && Math.abs(f1 - (1 + 27 / mv.pps)) <= 1 / mv.fps && mv.scale[1] === 1.5 && mv.und === u0 + 1, JSON.stringify(mv));
    await ev(() => restore(undo, redo));
    const un = await ev(() => P.main[1].kf.map(f => f.t));
    check(`${rm}: one undo puts it back`, un[1] === 1, JSON.stringify(un));

    // 2. portrait posters with their text
    {
      const made = [];
      for (let i = 0; i < 4; i++) {
        made.push(await ev(async ([id, i]) => {
          setProject(newProject('9:16')); P.name = `Polish poster ${i + 1} (scratch)`;
          if (i % 2) { addMedia(id, 'main'); Object.assign(P.main[0], { in: 0, out: 3 }); packMain(); }
          await REMOTE.add_text({ text: `POSTER ${i + 1}`, start: 0, duration: 3, x: 0.5, y: 0.5, style: { color: '#ff00ff' } });
          S.sel = null; S.t = 1.5; S.dirty = true; await waitFrame(); await saveNow();
          return [P.id, $('#cv').height];
        }, [GRAY.id, i]));
      }
      await ev(() => { setProject(newProject('16:9')); P.name = 'Polish after (scratch)'; renderAll(); }); // leaving the 4th
      await page.waitForTimeout(800);
      const shots = await ev(async ids => Promise.all(ids.map(async id => {
        const r = await fetch(`/api/projects/${id}/poster.jpg`); if (!r.ok) return { id, status: r.status };
        const im = await createImageBitmap(await r.blob()), c = new OffscreenCanvas(im.width, im.height), x = c.getContext('2d'); x.drawImage(im, 0, 0);
        const d = x.getImageData(0, 0, im.width, im.height).data; let mag = 0;
        for (let j = 0; j < d.length; j += 4) if (d[j] > 180 && d[j + 1] < 90 && d[j + 2] > 180) mag++;
        return { w: im.width, h: im.height, mag };
      })), made.map(m => m[0]));
      const cvH = made[0][1]; // the poster is the preview's own pixels: 480 px tall on a Retina screen, the canvas height below that
      const okp = shots.filter(s => s.h > s.w && Math.abs(s.h / s.w - 16 / 9) < 0.02 && s.h === Math.min(480, cvH) && s.mag > 200).length;
      check(`${rm}: 4 of 4 9:16 projects get portrait posters showing their text`, okp === 4, `${okp}/4, canvas ${cvH} px tall ${JSON.stringify(shots)}`);
      const list = await ev(() => api('/api/projects'));
      check(`${rm}: ...and the projects screen lists them with a picture`, made.every(([id]) => list.find(p => p.id === id)?.pic));
      const bad = await ev(id => fetch(`/api/projects/${id}/poster`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ jpg: btoa('not a jpeg') }) }).then(r => r.status), made[0][0]);
      check(`${rm}: the server refuses a poster that is not a JPEG`, bad === 400, bad);
    }
    check(`${rm}: no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
    await ev(() => clearTimeout(saveTimer));
    await ctx.close();
  }
} catch (e) { check('the suite ran to the end', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

// ---------- tidy (browser closed first: a pagehide save would bring a trashed project back) ----------
await b.close();
fs.rmSync(tmp, { recursive: true });
const after = { p: await get('/api/projects'), m: await get('/api/media') };
const madeP = after.p.filter(x => !before.p.has(x.id)), madeM = after.m.filter(x => !before.m.has(x.id));
for (const p of madeP) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of madeM) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed; trashed ${madeP.length} projects, ${madeM.length} media`);
process.exit(res.includes(false) ? 1 : 0);
