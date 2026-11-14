// Command bar (⌘K: the local model plans the MCP's commands, the page runs them, one undo step each) and smart search
// (Media panel: what the picture shows, what is said, how many people). Real local models (Ollama qwen3.5 + nomic-embed-text,
// whisper), headless WebKit, on a SCRATCH server with its library:
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:4774 node tests/pilot_search.mjs      (ONLY=pilot | search)
// Acceptance: 15 instructions -> >= 12 with the expected edit, every step undoable, a clear "can't" instead of a guess;
// 10 library queries -> >= 8 with the right clip first (and the right moment where one is asked for).
import { browser } from './browser.mjs';
import fs from 'node:fs';
const B = process.env.B || 'http://127.0.0.1:4774', HOME = process.env.CUTROOM_HOME, ONLY = process.env.ONLY || '';
const PHOTOS = process.env.PHOTOS || `${process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch'}/photos`;
if (/:4610\b/.test(B) || !HOME) throw new Error('run on a scratch server (B=, CUTROOM_HOME=), never 4610');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (p, b) => {
  const r = await fetch(B + p, { method: b ? 'POST' : 'GET', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
};
const lib = await api('/api/media'), byName = n => lib.find(m => m.name === n)?.id;
const b = await browser.launch();
const open = async rm => {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
  return [page, errs, (f, a) => page.evaluate(f, a)];
};

// ---------- 1. command bar ----------
if (ONLY !== 'search') {
  const [page, errs, ev] = await open('no-preference');
  const clips = ['talk.mp4', 'beach-and-city.mp4', 'cafe-and-dinner.mp4', 'mountain-hike.mp4'].map(byName);
  await ev(async ids => { await REMOTE.new_project({ ratio: '16:9', name: 'pilot test' }); for (const id of ids) await REMOTE.add_clip({ media: id }); packMain(); }, clips);
  const base = await ev(() => JSON.stringify(P)), p0 = JSON.parse(base);
  const len = c => (c.out - c.in) / (c.speed || 1), dur = p => p.main.reduce((s, c) => s + len(c), 0);
  const cuts = p0.main.slice(0, -1).map((c, i) => p0.main.slice(0, i + 1).reduce((s, x) => s + len(x), 0));
  const exp0 = () => new Set(fs.readdirSync(`${HOME}/exports`));
  const named = (p, re) => p.audio.filter(c => re.test(lib.find(m => m.id === c.media)?.name || ''));
  const CASES = [
    ['cut the silences', p => [p.main.length > 4 && dur(p) < dur(p0) - 0.5, `${p0.main.length} -> ${p.main.length} clips, ${dur(p0).toFixed(1)} -> ${dur(p).toFixed(1)} s`]],
    ['add captions in Bold', p => [p.captions.length > 0 && p.capStyle.font === 'Montserrat' && p.capStyle.weight === 900 && p.capStyle.upper, `${p.captions.length} captions, ${p.capStyle.font} ${p.capStyle.weight}`]],
    ['make it 9:16 and reframe', p => { const n = p.main.filter(c => c.fit === 'fill' && c.kf?.length).length; return [p.w === 1080 && p.h === 1920 && n >= 3, `${p.w}x${p.h}, ${n}/4 clips reframed`]; }],
    ['speed ramp the third clip hero', p => { const c = p.main.find(x => x.id === p0.main[2].id), lo = c?.ramp ? Math.min(...c.ramp.pts.map(q => q[1])) : null; return [lo !== null && Math.abs(lo - 0.25) < 0.05 && p.main.filter(x => x.ramp).length === 1, `ramp min speed ${lo}`]; }],
    ['add a whoosh on every cut', p => { const w = named(p, /^Whoosh/); return [w.length === cuts.length && cuts.every(t => w.some(c => Math.abs(c.start - t) < 0.6)), `${w.length} whooshes at ${w.map(c => c.start.toFixed(2))} for cuts ${cuts.map(t => t.toFixed(2))}`]; }],
    ['export for TikTok', (p, x) => { const f = [...exp0()].filter(n => !x.files.has(n) && /\.mp4$/.test(n)); return [f.length === 1 && fs.statSync(`${HOME}/exports/${f[0]}`).size > 1e5, f.join(', ') || 'no new file']; }],
    ['put a title that says Summer Trip at the start', p => { const t = p.text.find(c => /summer trip/i.test(c.text)); return [t && t.start < 0.5, t ? `"${t.text}" at ${t.start}` : 'no title']; }],
    ['use the vivid filter on every clip', p => [p.main.every(c => c.look?.name === 'vivid'), p.main.map(c => c.look?.name || '-').join(' ')]],
    ['dissolve between all the clips', p => [p.main.slice(0, -1).every(c => c.tr?.type === 'fade'), p.main.map(c => c.tr?.type || '-').join(' ')]],
    ['mute the second clip', p => [p.main[1].volume === 0 && p.main.filter(c => c.volume === 0).length === 1, p.main.map(c => c.volume ?? 1).join(' ')]],
    ['make the first clip twice as fast', p => [p.main[0].speed === 2 && p.main.slice(1).every(c => (c.speed || 1) === 1), p.main.map(c => c.speed || 1).join(' ')]],
    ['add a VHS effect for the first 3 seconds', p => { const f = p.fx.find(c => c.fx === 'vhs'); return [f && f.start < 0.2 && Math.abs(f.dur - 3) < 0.2, f ? `vhs ${f.start}-${f.start + f.dur}` : 'none']; }],
    ['add a voiceover that says welcome to my channel', p => [p.audio.length === p0.audio.length + 1, `${p.audio.length} audio clips`]],
    ['slowly zoom in on the last clip', p => { const c = p.main.at(-1), kf = c.kf || []; return [c.anim?.loop === 'kbin' || (kf.length >= 2 && kf.at(-1).scale > kf[0].scale), JSON.stringify(c.anim || c.kf || null)]; }],
    ['make the man in the video wave at the camera', (p, x) => [!x.steps && x.cant.length > 0 && JSON.stringify(p) === base, x.cant.join(' | ') || 'no "can\'t"']],
  ];
  let good = 0, undoOk = 0, undoN = 0, cantOk = 0;
  const times = [];
  for (const [text, ok] of CASES) {
    await ev(b => { setProject(JSON.parse(b)); undo.length = 0; redo.length = 0; S.t = 0; renderAll(); }, base);
    const before = await ev(() => JSON.stringify(P)), files = exp0(), t0 = Date.now();
    await page.keyboard.press('Meta+KeyK');
    await page.fill('#pilotQ', text);
    await page.press('#pilotQ', 'Enter');
    await page.waitForFunction(() => !$('#pilotGo').disabled && !/Planning/.test($('#pilotMsg').textContent), null, { timeout: 600000 });
    const plan = await ev(() => ({ steps: $$('#pilotSteps li[data-i]').length, cant: $$('#pilotSteps li.cant').map(x => x.textContent), msg: $('#pilotMsg').textContent, list: $$('#pilotSteps li[data-i] code').map(x => x.textContent) }));
    const tPlan = (Date.now() - t0) / 1000;
    if (plan.steps) {
      await page.press('#pilotQ', 'Enter');
      await page.waitForFunction(() => !$('#pilotGo').disabled && / done/.test($('#pilotMsg').textContent), null, { timeout: 900000 });
    }
    const run = await ev(() => ({ msg: $('#pilotMsg').textContent, failed: $$('#pilotSteps li.fail').length }));
    times.push(tPlan);
    await page.keyboard.press('Escape');
    const after = JSON.parse(await ev(() => JSON.stringify(P)));
    const [pass, detail] = ok(after, { files, steps: plan.steps, cant: plan.cant });
    good += !!pass;
    check(`"${text}"`, pass, `${detail} · plan ${tPlan.toFixed(1)} s, ${plan.steps} step(s), run ${((Date.now() - t0) / 1000 - tPlan).toFixed(1)} s${run.failed ? `, ${run.failed} failed` : ''} · ${plan.list.join(' ; ').slice(0, 300)}${plan.cant.length ? ` · ${plan.cant.join(' | ')}` : ''}`);
    if (plan.steps) { // every step is one undo: as many undo steps as steps that changed something, and undoing them all gives the project back
      undoN++;
      const u = await ev(() => undo.length), back = await ev(n => { for (let i = 0; i < n; i++) restore(undo, redo); return JSON.stringify(P); }, u);
      const same = back === before;
      undoOk += same && u <= plan.steps;
      if (!same || u > plan.steps) check(`  undo of "${text}"`, false, `${u} undo steps for ${plan.steps} steps, project back: ${same}`);
    }
    if (plan.cant.length && !pass) console.log(`     (said: ${plan.cant.join(' | ')})`);
    cantOk += !plan.steps ? +(plan.cant.length > 0) : 0;
  }
  check(`command bar: ${good}/15 instructions made the expected edit (>= 12)`, good >= 12);
  check(`command bar: every step undoable (${undoOk}/${undoN} instructions back to the project with ⌘Z, one per step)`, undoOk === undoN);
  times.sort((a, b) => a - b);
  console.log(`     planning time median ${times[times.length >> 1].toFixed(1)} s, max ${times.at(-1).toFixed(1)} s`);
  check('command bar: no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
  // the other motion mode: the bar opens, plans, shows the plan, Escape closes it without running
  const [p2, errs2, ev2] = await open('reduce');
  const u0 = await ev2(() => undo.length);
  await p2.keyboard.press('Meta+KeyK');
  await p2.fill('#pilotQ', 'add a pop sound at 2 seconds');
  await p2.press('#pilotQ', 'Enter');
  await p2.waitForFunction(() => !$('#pilotGo').disabled && !/Planning/.test($('#pilotMsg').textContent), null, { timeout: 600000 });
  const sh = await ev2(() => ({ n: $$('#pilotSteps li[data-i]').length, go: $('#pilotGo').textContent, code: $('#pilotSteps code')?.textContent || '' }));
  await p2.keyboard.press('Escape');
  check('reduced motion: ⌘K plans and shows the steps before running anything', sh.n >= 1 && sh.go === 'Run' && /add_sound_effect/.test(sh.code) && await ev2(() => $('#modal').hidden) && await ev2(() => undo.length) === u0, JSON.stringify(sh));
  check('reduced motion: no page errors', errs2.length === 0, errs2.slice(0, 2).join(' | '));
  await p2.context().close();
}

// ---------- 2. smart search ----------
const NEED = ['IMG_4581.MOV', 'IMG_4663.MOV', 'IMG_3032.MOV'].filter(f => !fs.existsSync(`${PHOTOS}/${f}`)); // real iPhone clips the search is judged on
if (NEED.length && ONLY !== 'pilot') console.log(`SKIP smart search: real footage missing in ${PHOTOS}: ${NEED.join(', ')}`);
else if (ONLY !== 'pilot') {
  const imp = {};
  for (const f of ['IMG_4581.MOV', 'IMG_4663.MOV', 'IMG_3032.MOV']) imp[f] = (await api('/api/import_path', { path: `${PHOTOS}/${f}` })).id;
  const id = { bday: imp['IMG_4581.MOV'], mech: imp['IMG_4663.MOV'], cars: imp['IMG_3032.MOV'], bmx: byName('bmx-trees.mp4'), cafe: byName('cafe-and-dinner.mp4'), hike: byName('mountain-hike.mp4'),
    beach: byName('beach-and-city.mp4'), night: byName('DJI_0482_007.MP4'), pod: byName('podcast-episode.mp4'), talk: byName('talk.mp4'), fox: byName('fox-walk.mp4'),
    twm: byName('talk-with-music.mp4'), broll: byName('broll.mp4'), bay: byName('IMG_4697.MOV') };
  const t0 = Date.now(), { job } = await api('/api/index', { media: Object.values(id) });
  let j;
  for (;;) { await new Promise(r => setTimeout(r, 2000)); j = await api(`/api/jobs/${job}`); if (j.state !== 'running') break; }
  check(`index ${Object.keys(id).length} library items (vision + speech, cached)`, j.state === 'done' && j.indexed === Object.keys(id).length, `${((Date.now() - t0) / 1000).toFixed(0)} s, ${JSON.stringify(j.errors || j.error)}`);
  const Q = [ // [query, right clip, the moment it is in (source seconds) or null]
    ['two people with a birthday cake', id.bday, null], ['someone riding a bike past graffiti', id.bmx, null], ['coffee being poured', id.cafe, [0, 4.2]],
    ['friends laughing at dinner', id.cafe, [4.1, 11.2]], ['hiker above the clouds', id.hike, null], ['waves on a beach', id.beach, [0, 5.9]],
    ['driving at night', id.night, null], ['how much fuel an idling truck burns', [id.pod, id.twm], [10, 21]], ['captions appear word by word', id.talk, [7, 11]], // talk-with-music = the podcast's first 20 s under music (same words)
    ['mechanic working on an engine', id.mech, null]];
  let right = 0;
  const ms = [];
  for (const [q, want, at] of Q) {
    const s0 = performance.now(), r = await api('/api/search', { q, media: Object.values(id) }), top = r.results[0];
    ms.push(performance.now() - s0);
    const ok = [want].flat().includes(top?.media) && (!at || (top.t >= at[0] && top.t <= at[1]));
    right += ok;
    check(`search "${q}"`, ok, `${r.results.slice(0, 3).map(x => `${x.name} @${x.t} ${x.score} ${x.why}`).join(' · ')}`);
  }
  check(`search: ${right}/${Q.length} queries put the right clip first (>= 8 of 10)`, Q.length === 10 && right >= 8, `median ${ms.sort((a, b) => a - b)[5].toFixed(0)} ms per query (warm)`);
  // the panel: Enter searches, a result opens the source viewer at its moment, in both motion modes
  for (const rm of ['no-preference', 'reduce']) {
    const [page, errs, ev] = await open(rm);
    await page.click('.rail button[data-tab="media"]');
    await page.fill('#mediaSearch', 'coffee being poured');
    await page.press('#mediaSearch', 'Enter');
    await page.waitForSelector('#mediaHits .hit', { timeout: 30000 });
    const first = await ev(() => { const h = $('#mediaHits .hit'); return { media: h.dataset.hit, t: +h.dataset.t, fits: $('#mediaHits').scrollWidth <= $('#mediaHits').clientWidth + 1 }; });
    await page.click('#mediaHits .hit');
    const src = await ev(() => S.src && { id: S.src.id, t: S.src.t });
    check(`${rm}: Media search Enter -> the coffee shot first, a click opens it in the source viewer at ${first.t} s`, first.media === id.cafe && src?.id === id.cafe && Math.abs(src.t - first.t) < 0.05 && first.fits, JSON.stringify({ first, src }));
    await page.fill('#mediaSearch', 'coffee');
    check(`${rm}: typing again hides the results (name filter as before)`, await ev(() => $('#mediaHits').hidden));
    check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
    await page.context().close();
  }
}
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
process.exit(res.every(Boolean) ? 0 : 1);
