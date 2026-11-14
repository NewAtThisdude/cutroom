// Library source viewer (committee item 33), in headless WebKit with real mouse/keyboard input, in both reduced-motion
// modes: hover skim on a video card (preview follows the pointer, timeline untouched), click to open it, I/O mark a range,
// + adds just that range at the playhead, library search / sort / "This project", and Replace clip.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node tests/source_viewer.mjs
import { browser } from './browser.mjs';
import { importNamedMedia } from './fixtures.mjs';
const B = process.env.B, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
if (!B || /:4610\b/.test(B) || !process.env.CUTROOM_HOME) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> (never 4610)');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const before = new Set((await get('/api/projects')).map(x => x.id));
// the clips it names (a 5:27 drone file, a talk, a hike, a podcast) and enough others that sorting means something (> 10 items)
const vid = (d, src = 'testsrc2', snd = 0) => ['-f', 'lavfi', '-i', `${src}=s=640x360:r=30:d=${d}`, ...(snd ? ['-f', 'lavfi', '-i', `sine=f=${snd}:r=48000:d=${d}`, '-c:a', 'aac', '-shortest'] : []),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart'];
const still = src => ['-f', 'lavfi', '-i', `${src}=s=640x360`, '-frames:v', '1'];
await importNamedMedia(B, { 'DJI_0482_001.MP4': vid(327), 'talk.mp4': vid(16, 'testsrc', 300), 'mountain-hike.mp4': vid(9, 'smptehdbars'), 'podcast-episode.mp4': vid(12, 'rgbtestsrc', 200),
  'beach-day.mp4': vid(5, 'yuvtestsrc'), 'city-night.mp4': vid(7, 'testsrc2', 500), 'forest.png': still('testsrc'), 'harbor.jpg': still('smptebars') });
const lib = await get('/api/media'), by = n => lib.find(m => m.name === n);
const DJI = by('DJI_0482_001.MP4'), TALK = by('talk.mp4'), HIKE = by('mountain-hike.mp4');
if (!DJI || !TALK || !HIKE) { console.log('FAIL the scratch library did not get DJI_0482_001.MP4, talk.mp4 and mountain-hike.mp4'); process.exit(1); }
const b = await browser.launch();

for (const reducedMotion of ['reduce', 'no-preference']) {
  console.log(`--- reducedMotion: ${reducedMotion}`);
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  try {
    await ev(([talk]) => { setProject(newProject('16:9')); P.name = 'Source viewer (scratch)'; addMedia(talk, 'main'); S.sel = null; renderAll(); seekTo(total()); }, [TALK.id]);
    const names = () => ev(() => [...document.querySelectorAll('#mediaList .mitem[data-media]')].map(x => M.get(x.dataset.media).name));

    // search
    await page.click('#mediaSearch'); await page.keyboard.type('pod');
    let n = await names();
    // (its own copies, e.g. 'podcast-episode (voice).m4a' from Isolate voice in an earlier test, match too)
    check("typing 'pod' in search leaves only podcast-episode", n.includes('podcast-episode.mp4') && n.every(x => x.startsWith('podcast-episode')), n.join(', '));
    await page.fill('#mediaSearch', 'DJI_0482_001');
    n = await names();
    check('searching DJI_0482_001 finds its card (and only names with it)', n.includes('DJI_0482_001.MP4') && n.every(x => x.includes('DJI_0482_001')), n.join(', ')); // freeze-frame stills of it match too

    // hover skim
    const tl0 = await ev(() => JSON.stringify([P, S.t]));
    const card = await page.locator(`#mediaList .mitem[data-media="${DJI.id}"]`).boundingBox();
    const errsT = [];
    let skimDrawn = true;
    for (let i = 0; i < 10; i++) {
      const x = Math.round(card.x + ((i + 0.5) / 10) * card.width), want = ((x - card.x) / card.width) * DJI.duration; // whole pixels: WebKit reports clientX as an integer (one pixel = 2.5 s of this 5:27 file)
      await page.mouse.move(x, card.y + 30, { steps: 3 });
      await page.waitForTimeout(150); // 100 ms at rest, then the preview seeks
      const r = await ev(async id => { await waitFrame(); const v = pool.get('src'), cv = document.querySelector(`#mediaList .mitem[data-media="${id}"] .skim`);
        let lit = false; if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let k = 3; k < d.length; k += 4 * 97) if (d[k]) { lit = true; break; } }
        return { ct: v?.currentTime, drawn: S.live?.has(v) && v.readyState >= 2, skim: S.skim?.t, lit }; }, DJI.id);
      errsT.push(+(Math.abs(r.ct - want)).toFixed(2));
      if (!r.drawn || !r.lit) skimDrawn = false;
    }
    check('hover at 10 positions: the preview frame time is within 1 s of the pointer\'s time at each', errsT.every(e => e < 1), `errors (s): ${errsT.join(' ')}`);
    check('...the card shows the grid frame and the pointer line, the preview draws the source', skimDrawn);
    check('...and the timeline did not change (project and playhead)', (await ev(() => JSON.stringify([P, S.t]))) === tl0);
    await page.mouse.move(700, 300);
    await page.waitForTimeout(50);
    check('leaving the card puts the preview back on the timeline', await ev(() => !S.skim && !S.src));

    // click to open, I at 60 s, O at 62 s, + adds 2 s at the playhead
    await page.mouse.click(card.x + card.width * 0.2, card.y + 30);
    await page.mouse.move(700, 300); // off the card: I / O take the viewer's time, not the skimmed one
    check('clicking the card opens the source viewer', await ev(() => !$('#srcBar').hidden && S.src?.id) === DJI.id);
    await ev(() => { const r = $('#srcPos'); r.value = 60; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await ev(() => waitFrame());
    check('the viewer slider seeks the source (60 s)', Math.abs(await ev(() => pool.get('src').currentTime) - 60) < 0.05, await ev(() => pool.get('src').currentTime));
    await page.keyboard.press('i');
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('o');
    const rg = await ev(() => ({ i: S.src.i, o: S.src.o, txt: $('#srcRange').textContent, mark: !!document.querySelector('#mediaList .mitem.src .srng') }));
    check('I at 60 s, ⇧→ ⇧→, O at 62 s', rg.i === 60 && rg.o === 62 && rg.mark, JSON.stringify(rg));
    const t0 = await ev(() => S.t), n0 = await ev(() => P.main.length);
    await page.mouse.move(card.x + card.width / 2, card.y + 30);
    await page.click(`#mediaList [data-add="${DJI.id}"]`);
    const add = await ev(([id, t0]) => { packMain(); const c = P.main.find(x => x.media === id); return c && { n: P.main.length, start: c.start, in: c.in, out: c.out, dur: tdur(c, 'main'), t: S.t, at: Math.abs(c.start - t0) < 1e-6 }; }, [DJI.id, t0]);
    check("'+' adds a 2 s clip (60-62 s of the file) at the playhead", add && add.n === n0 + 1 && add.in === 60 && add.out === 62 && Math.abs(add.dur - 2) < 1e-6 && add.at, JSON.stringify(add));
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    check('Esc closes the viewer', await ev(() => !S.src && $('#srcBar').hidden));

    // This project / sort
    await page.fill('#mediaSearch', '');
    await page.click('[data-mfilter="proj"]');
    n = await names();
    check("'This project' lists only the media the project uses", n.length === 2 && n.includes('talk.mp4') && n.includes('DJI_0482_001.MP4'), n.join(', '));
    await page.click('[data-mfilter="all"]');
    await page.selectOption('#mediaSort', 'name');
    n = await names();
    const sorted = [...n].sort((a, c) => a.localeCompare(c, undefined, { numeric: true }));
    check('sort by name', n.length > 10 && n.join() === sorted.join());
    await page.selectOption('#mediaSort', 'dur');
    n = await ev(() => [...document.querySelectorAll('#mediaList .mitem[data-media]')].map(x => M.get(x.dataset.media).duration || 0));
    check('sort by length, longest first', n.every((d, i) => !i || n[i - 1] >= d));
    await page.selectOption('#mediaSort', 'new');

    // Replace clip
    const cid = await ev(id => { const c = P.main.find(x => x.media === id); change(() => { c.adj = { b: 1.3, c: 1.1, s: 0.8 }; c.fadeIn = 0.5; c.flip = true; c.kf = [{ t: 0, scale: 1, x: 0, y: 0, opacity: 1 }, { t: 1, scale: 1.5, x: 0, y: 0, opacity: 1 }]; }); renderAll(); return c.id; }, DJI.id);
    const keep = await ev(id => { const c = P.main.find(x => x.id === id); return JSON.stringify([c.adj, c.fadeIn, c.flip, c.kf, c.speed, c.volume]); }, cid);
    const cb = await page.locator(`.clip[data-id="${cid}"]`).boundingBox();
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2, { button: 'right' });
    await page.locator('button[data-mi]', { hasText: 'Replace' }).click();
    await page.click('#repQ'); await page.keyboard.type('mountain');
    const vis = await ev(() => [...document.querySelectorAll('#modal [data-rep]')].filter(x => !x.hidden).map(x => M.get(x.dataset.rep).name));
    check('the Replace picker searches the library', vis.length === 1 && vis[0] === 'mountain-hike.mp4', vis.join(', '));
    await page.locator('#modal [data-rep]:not([hidden])').first().click();
    const rp = await ev(id => { packMain(); const c = P.main.find(x => x.id === id); return { media: c.media, dur: tdur(c, 'main'), in: c.in, out: c.out, keep: JSON.stringify([c.adj, c.fadeIn, c.flip, c.kf, c.speed, c.volume]) }; }, cid);
    check('Replace: c.media changes, duration and effects/keyframes kept', rp.media === HIKE.id && Math.abs(rp.dur - 2) < 1e-6 && rp.keep === keep && rp.out <= HIKE.duration + 1e-6, JSON.stringify(rp));
    await ev(() => restore(undo, redo));
    check('...and one undo puts the old media back', await ev(([id, m]) => P.main.find(x => x.id === id)?.media === m, [cid, DJI.id]));
  } catch (e) { check('the suite ran to the end', false, String(e.message).split('\n')[0]); }
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  await ev(() => clearTimeout(saveTimer)).catch(() => {});
  await page.context().close();
}
await b.close();
for (const p of (await get('/api/projects')).filter(x => !before.has(x.id))) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
