// Every control, headless WebKit: each inspector control for every kind of clip (all tabs; sliders at both ends, every
// option of every dropdown), every gallery tile and pane button, every context-menu item, the keyboard shortcuts, timeline
// and preview drags, the modals. After each action it checks: no uncaught error, no console error, no failed request, no
// toast that leaks an internal error, the project still sane (finite numbers, clips with length, every clip drawn), the
// preview still paints, and one undo puts the project back exactly. Slow AI endpoints answer with a stub error, so their
// error paths are exercised (the real models are covered by mcp_e2e.mjs). Scratch media/projects are trashed after.
//   node fuzz_ui.mjs [only-section]   (server on 127.0.0.1:4610)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const LIB = process.env.CUTROOM_HOME || `${os.homedir()}/Movies/Cutroom`; // the library the server under test uses
const B = 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2];
const STUB = /\/api\/(matte|isolate|remove_object|mask_preview|ai\/|track$|faces|stabilize|reverse|slowmo|transcribe|transcript|fillers|lift|tts)/;
const get = async p => (await fetch(B + p)).json();
const EXP = `${LIB}/exports`;
const before = { p: new Set((await get('/api/projects')).map(x => x.id)), m: new Set((await get('/api/media')).map(x => x.id)), t: new Set((await get('/api/templates')).map(x => x.id)), e: new Set(fs.readdirSync(EXP)) };

const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-fuzz-`);
const gen = (name, args) => { const f = `${tmp}/${name}`; execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); return f; };
const files = [
  gen('fuzz-v.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  gen('fuzz-i.png', ['-f', 'lavfi', '-i', 'testsrc=s=480x480:d=1', '-frames:v', '1']),
  gen('fuzz-a.wav', ['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*80*t)*exp(-30*mod(t,0.5))':d=8:s=44100"]),
];
const ids = [];
for (const f of files) ids.push((await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json()).id);
fs.rmSync(tmp, { recursive: true });

const b = await webkit.launch(), ctx = await b.newContext({ viewport: { width: 1517, height: 904 } }), page = await ctx.newPage();
const errs = [], findings = [];
let inflight = 0;
page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error' && !/status of 500|stubbed/.test(m.text())) errs.push(`console: ${m.text()}`); });
page.on('dialog', d => d.dismiss()); // confirm() answers no: nothing in the library is removed
page.on('request', r => { if (r.url().includes('/api/') && !r.url().includes('/api/remote/next')) inflight++; });
for (const ev of ['requestfinished', 'requestfailed']) page.on(ev, r => { if (r.url().includes('/api/') && !r.url().includes('/api/remote/next')) inflight--; });
page.on('response', r => { if (r.status() >= 400 && !STUB.test(new URL(r.url()).pathname)) errs.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
await page.route(u => STUB.test(u.pathname), r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"stubbed in the UI fuzz"}' }));
await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // don't take the real app's MCP commands

await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), ids, { timeout: 60000 });
await ev(() => { // toasts are collected; waitFrame calls are counted, so the fuzz waits for frame-reading actions (auto adjust, freeze) to finish
  const ot = toast; window.__toasts = []; toast = m => { __toasts.push(String(m)); ot(m); };
  const ow = waitFrame; window.__wf = 0; waitFrame = async (...a) => { __wf++; try { return await ow(...a); } finally { __wf--; } };
});

const build = ([V, I, A]) => {
  setProject(newProject('16:9')); P.name = 'Fuzz (scratch)'; S.sel = null; S.multi.clear(); undo.length = 0; redo.length = 0;
  addMedia(V, 'main'); addMedia(V, 'main'); P.main[0].tr = { type: 'fade', d: 0.5 }; packMain();
  addMedia(I, 'overlay', 1); addMedia(V, 'overlay', 2); addMedia(A, 'audio', 0);
  S.t = 0.5; addText('Subtitle'); S.t = 3; addEffect(Object.keys(FX)[0]);
  P.captions.push({ id: hex12(), start: 0.2, dur: 1.2, text: 'one two three', words: [{ w: 'one', s: 0, e: 0.4 }, { w: 'two', s: 0.4, e: 0.8 }, { w: 'three', s: 0.8, e: 1.2 }] },
    { id: hex12(), start: 1.5, dur: 1, text: 'four five', words: [{ w: 'four', s: 0, e: 0.5 }, { w: 'five', s: 0.5, e: 1 }] });
  S.t = 1.6; S.sel = null; undo.length = 0; redo.length = 0; renderAll(); scheduleSave();
  return P.id;
};
await ev(build, ids);
const contexts = await ev(() => ({ project: null, main: { lane: 'main', id: P.main[0].id }, transition: { lane: 'tr', id: P.main[0].id }, 'overlay image': { lane: 'overlay', id: P.overlay[0].id },
  'overlay video': { lane: 'overlay', id: P.overlay[1].id }, audio: { lane: 'audio', id: P.audio[0].id }, text: { lane: 'text', id: P.text[0].id }, caption: { lane: 'captions', id: P.captions[0].id }, effect: { lane: 'fx', id: P.fx[0].id } }));

const settle = async () => {
  await page.waitForTimeout(80);
  for (let i = 0; i < 300 && (inflight > 0 || await ev(() => __wf || busyN)); i++) await page.waitForTimeout(50);
  await page.waitForTimeout(40);
};
const SUSPECT = /undefined|NaN|\[object|TypeError|ReferenceError|is not a function|Cannot read|not iterable|null is not|Traceback|Infinity/;
const check = async label => { // the state after one action
  const r = await ev(() => {
    if (S.playing) pause();
    closeModal(); closeMenu(); S.pick = null; S.keyPick = null; S.pickRect = null;
    if (!$('#confirmBar').hidden) endPreview(null);
    const bad = [];
    const walk = (o, p) => { if (typeof o === 'number' && !Number.isFinite(o)) bad.push(`${p} = ${o}`); else if (o && typeof o === 'object') for (const k in o) walk(o[k], `${p}.${k}`); };
    walk(P, 'P');
    for (const L of LANES) for (const c of P[L.key]) {
      const d = tdur(c, L.key);
      if (!(d > 0)) bad.push(`${L.key} clip ${c.id} lasts ${d}`);
      if (c.media && !(c.out > c.in)) bad.push(`${L.key} clip ${c.id} in ${c.in} out ${c.out}`);
      if (c.start < -1e-6) bad.push(`${L.key} clip ${c.id} starts at ${c.start}`);
      if (c.media && !M.get(c.media)) bad.push(`${L.key} clip ${c.id} has missing media`);
      const [wa, wb] = S.tlWin || [-Infinity, Infinity]; // the timeline draws what's in view, plus a screen either side
      if ((c.start + d) * S.pps >= wa && c.start * S.pps <= wb && !document.querySelector(`.clip[data-id="${c.id}"]`)) bad.push(`${L.key} clip ${c.id} not drawn on the timeline`);
    }
    try { paint(); } catch (e) { bad.push(`paint: ${e.message}`); }
    const t = __toasts.splice(0);
    return { bad, toasts: t, json: JSON.stringify(P) };
  });
  const sus = r.toasts.filter(t => SUSPECT.test(t) && !/stubbed/.test(t));
  const e = errs.splice(0);
  if (r.bad.length || e.length || sus.length) findings.push({ label, bad: r.bad, errs: e, toasts: sus });
  return r.json;
};
const undoBack = async (label, was) => { // one undo returns exactly what was there
  const now = await ev(() => JSON.stringify(P));
  if (now === was) return;
  const back = await ev(was => { restore(undo, redo); return JSON.stringify(P) === was; }, was);
  if (!back) { findings.push({ label, bad: ['one undo did not restore the project'], errs: [], toasts: [] }); await ev(was => { P = JSON.parse(was); undo.length = 0; redo.length = 0; S.sel = null; renderAll(); }, was); }
  await check(`${label} → undo`);
};
let actions = 0;
const act = async (label, fn) => {
  const was = await ev(() => JSON.stringify(P));
  try { await fn(); } catch (e) { findings.push({ label, bad: [`could not interact: ${String(e.message).split('\n')[0]}`], errs: [], toasts: [] }); }
  await settle();
  await check(label);
  await undoBack(label, was);
  actions++;
};
const run = name => !only || name.includes(only);

// ---------- inspector, for every kind of clip ----------
if (run('inspector')) for (const [cname, sel] of Object.entries(contexts)) {
  const focus = async tab => ev(([sel, tab]) => { S.sel = sel && { ...sel }; S.multi.clear(); if (tab) S.itab = tab; renderAll(); }, [sel, tab]);
  await focus();
  const tabs = await ev(() => [...document.querySelectorAll('#inspector .itabs button')].map(x => x.dataset.itab));
  for (const tab of tabs.length ? tabs : [null]) {
    await focus(tab);
    const n = await ev(() => document.querySelectorAll('#inspector :is(button,input,select,textarea,output):not(.itabs button)').length);
    for (let i = 0; i < n; i++) {
      await focus(tab);
      const el = page.locator('#inspector :is(button,input,select,textarea,output):not(.itabs button)').nth(i);
      const info = await el.evaluate(e => ({ tag: e.tagName, type: e.type, k: e.dataset.k, vis: !!e.offsetParent && !e.disabled, txt: (e.textContent || e.closest('label')?.querySelector('span')?.textContent || '').trim().slice(0, 30),
        sec: e.closest('.isec')?.querySelector('h4')?.textContent, min: e.min, max: e.max, opts: e.tagName === 'SELECT' ? [...e.options].map(o => o.value) : [] })).catch(() => null);
      if (!info || !info.vis) continue;
      const base = `${cname} › ${tab || '-'} › ${info.k || info.txt || info.tag}`;
      if (info.tag === 'INPUT' && info.type === 'range') {
        for (const v of [info.max, info.min]) await act(`${base} = ${v}`, () => el.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v));
      } else if (info.tag === 'SELECT') {
        for (const o of info.opts.slice(0, 40)) await act(`${base} = ${o}`, async () => { await focus(tab); await page.locator('#inspector :is(button,input,select,textarea,output):not(.itabs button)').nth(i).selectOption(o); });
      } else if (info.tag === 'INPUT' && info.type === 'color') {
        await act(`${base} = #ff0080`, () => el.evaluate(e => { e.value = '#ff0080'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }));
      } else if (info.tag === 'TEXTAREA' || (info.tag === 'INPUT' && info.type === 'text')) {
        await act(`${base} typed`, async () => { await el.fill('Fuzz ✓ <b>&amp; 123</b>'); await el.evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true }))); });
        await act(`${base} emptied`, async () => { await focus(tab); const e2 = page.locator('#inspector :is(button,input,select,textarea,output):not(.itabs button)').nth(i); await e2.fill(''); await e2.evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true }))); });
      } else if (info.tag === 'OUTPUT') {
        await act(`${base} typed value`, async () => { await el.click(); await page.keyboard.type('42'); await page.keyboard.press('Enter'); });
      } else {
        await act(base, () => el.click({ timeout: 3000 }));
      }
    }
  }
}

// ---------- every pane: tabs, tiles, buttons, selects ----------
if (run('panes')) {
  const tabsR = await ev(() => [...document.querySelectorAll('.rail [data-tab]')].map(x => x.dataset.tab));
  for (const tab of tabsR) for (const selCtx of [null, contexts.main, contexts['overlay video']]) {
    const focus = () => ev(([tab, sel]) => { S.sel = sel && { ...sel }; S.multi.clear(); renderAll(); openTab(tab); }, [tab, selCtx]);
    await focus();
    await settle();
    const q = `#tab-${tab} :is(button, select, input[type=checkbox])`;
    const n = await page.locator(q).count();
    for (let i = 0; i < n; i++) {
      await focus();
      const el = page.locator(q).nth(i);
      const info = await el.evaluate(e => ({ tag: e.tagName, vis: !!e.offsetParent && !e.disabled, id: e.id, d: JSON.stringify(e.dataset), txt: (e.textContent || e.title || '').trim().slice(0, 30), opts: e.tagName === 'SELECT' ? [...e.options].map(o => o.value) : [] })).catch(() => null);
      if (!info || !info.vis) continue;
      if (['btnRec'].includes(info.id) || /openproj/.test(info.d)) continue; // the mic; opening another project
      const base = `pane ${tab}${selCtx ? ` (with ${selCtx.lane} selected)` : ''} › ${info.id || info.txt || info.d}`;
      if (info.tag === 'SELECT') { for (const o of info.opts.slice(0, 3)) await act(`${base} = ${o}`, async () => { await focus(); await page.locator(q).nth(i).selectOption(o); }); }
      else await act(base, () => el.click({ timeout: 3000 }));
    }
    if (!/media|audio|ai|filters|transitions/.test(tab)) break; // the selection only matters to these
  }
}

// ---------- context menus ----------
if (run('menus')) for (const [cname, sel] of Object.entries(contexts)) {
  const open = async () => {
    await ev(sel => { S.sel = sel && { ...sel }; S.multi.clear(); renderAll(); }, sel);
    const el = sel ? page.locator(sel.lane === 'tr' ? `.trh[data-tr-for="${sel.id}"]` : `.clip[data-id="${sel.id}"]`) : page.locator('#ruler');
    await el.first().scrollIntoViewIfNeeded().catch(() => {});
    await el.first().click({ button: 'right', timeout: 3000, force: true });
  };
  await open();
  const n = await page.locator('.ctxmenu [data-mi]').count();
  for (let i = 0; i < n; i++) {
    await open();
    const it = page.locator('.ctxmenu [data-mi]').nth(i), txt = (await it.textContent()).trim();
    if (await it.isDisabled()) continue;
    await act(`menu ${cname} › ${txt}`, () => it.click({ timeout: 3000 }));
  }
  await ev(() => closeMenu());
}

// ---------- keyboard ----------
if (run('keys')) {
  const KEYS = ['s', 'Meta+b', 'Delete', 'Backspace', 'Meta+d', 'Meta+c', 'Meta+x', 'Meta+v', 'Alt+Meta+v', 'Meta+a', 'q', 'w', 'm', 'f', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Home', 'End', 'Space', 'Escape'];
  for (const [cname, sel] of Object.entries(contexts)) for (const k of KEYS) {
    await act(`key ${k} with ${cname} selected`, async () => {
      await ev(sel => { S.sel = sel && { ...sel }; S.multi.clear(); S.t = 1.6; renderAll(); document.activeElement?.blur(); if (document.body.classList.contains('theater')) toggleTheater(false); }, sel);
      if (k === 'Meta+v' || k === 'Alt+Meta+v') await page.keyboard.press('Meta+c');
      await page.keyboard.press(k);
      if (k === 'Space') { await page.waitForTimeout(400); await page.keyboard.press('Space'); }
      if (k === 'f') await page.keyboard.press('Escape');
    });
  }
}

// ---------- timeline and preview drags ----------
if (run('drags')) {
  const box = async sel => page.locator(sel).first().boundingBox();
  const drag = async (from, dx, dy = 0) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + dx * i / 8, from.y + dy * i / 8); await page.mouse.up(); };
  for (const [cname, sel] of Object.entries(contexts).filter(([, s]) => s && s.lane !== 'tr')) {
    const pick = () => ev(sel => { S.sel = { ...sel }; S.multi.clear(); renderAll(); }, sel);
    for (const [part, fx, dx] of [['body', 0.5, 60], ['body', 0.5, -400], ['left edge', 0.005, 40], ['left edge', 0.005, -80], ['right edge', 0.995, -40], ['right edge', 0.995, 300]]) {
      await act(`drag ${cname} ${part} by ${dx}px`, async () => { await pick(); const r = await box(`.clip[data-id="${sel.id}"]`); await drag({ x: r.x + r.width * fx, y: r.y + r.height * 0.75 }, dx); });
    }
    if (['main', 'overlay video', 'overlay image', 'audio'].includes(cname)) for (const [k, dx] of [['l', 50], ['r', -50], ['l', 2000]]) {
      await act(`drag ${cname} fade knob ${k} by ${dx}px`, async () => { await pick(); const r = await box(`.clip[data-id="${sel.id}"] .fh.${k}`); await drag({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, dx); });
    }
  }
  await act('drag the transition handle', async () => { const r = await box('.trh'); await drag({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, 30); });
  await act('scrub the ruler', async () => { const r = await box('#ruler'); await drag({ x: r.x + 20, y: r.y + 5 }, 300); });
  await act('zoom slider to both ends', async () => { await page.locator('#zoom').evaluate(e => { for (const v of [e.min, e.max, 2]) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } }); });
  await act('⌘-wheel zoom on the timeline', async () => { const r = await box('#tlScroll'); await page.mouse.move(r.x + 200, r.y + 40); await page.keyboard.down('Meta'); await page.mouse.wheel(0, -400); await page.mouse.wheel(0, 900); await page.keyboard.up('Meta'); });
  await act('rubber-band select on the timeline', async () => { const r = await box('#lanes'); await drag({ x: r.x + 5, y: r.y + r.height - 4 }, 400, -r.height + 8); });
  for (const [cname, sel] of Object.entries(contexts).filter(([n]) => ['main', 'overlay image', 'text', 'caption'].includes(n))) {
    await act(`drag ${cname} on the preview`, async () => { await ev(sel => { S.sel = { ...sel }; S.t = sel.lane === 'captions' ? 0.6 : 2.2; renderAll(); }, sel); await page.waitForTimeout(300); const r = await box('#cv'); await drag({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, 60, 30); });
    await act(`drag ${cname}'s corner handle on the preview`, async () => {
      await ev(sel => { S.sel = { ...sel }; S.t = sel.lane === 'captions' ? 0.6 : 2.2; renderAll(); paint(); }, sel);
      const h = await ev(() => { const s = hits.find(x => x.id === S.sel.id), cv = $('#cv'), r = cv.getBoundingClientRect(), k = r.width / cv.width; return s && { x: r.left + s.x1 * k, y: r.top + s.y1 * k }; });
      if (h) await drag(h, 40, 20);
    });
  }
  await act('click empty preview deselects', async () => { const r = await box('#cv'); await page.mouse.click(r.x + 3, r.y + 3); });
}

// ---------- modals ----------
if (run('modals')) {
  const home = await ev(() => P.id);
  for (const [name, open] of [['Projects', '#btnProjects'], ['Templates', '#btnTemplates'], ['Export', '#btnExport']]) {
    await act(`${name} opens and closes`, async () => { await page.click(open); await page.waitForSelector('#modal:not([hidden]) .dialog'); await page.keyboard.press('Escape'); });
    await page.click(open); await page.waitForSelector('#modal:not([hidden]) .dialog'); await settle();
    const q = '#modal .dialog :is(button, select, input)', n = await page.locator(q).count();
    for (let i = 0; i < n; i++) {
      await ev(() => closeModal());
      await page.click(open).catch(() => {}); await page.waitForSelector('#modal:not([hidden]) .dialog').catch(() => {}); await settle();
      const el = page.locator(q).nth(i), info = await el.evaluate(e => ({ tag: e.tagName, type: e.type, id: e.id, d: { ...e.dataset }, txt: (e.textContent || e.name || '').trim().slice(0, 30), vis: !!e.offsetParent && !e.disabled, opts: e.tagName === 'SELECT' ? [...e.options].map(o => o.value) : [] })).catch(() => null);
      if (!info?.vis) continue;
      const d = info.d;
      if (d.open || d.dup || d.reveal || d.play || 'savetpl' in d || d.deltpl || d.trash || info.id === 'exGo') continue; // the user's own projects, Finder, players, a real export
      const base = `${name} › ${info.id || info.txt || JSON.stringify(d)}`;
      if (info.tag === 'SELECT') { for (const o of info.opts.slice(0, 8)) await act(`${base} = ${o}`, async () => { await ev(() => closeModal()); await page.click(open); await settle(); await page.locator(q).nth(i).selectOption(o); }); }
      else await act(base, async () => { await el.click({ timeout: 3000 }); await settle(); if (d.new || 'newsel' in d || d.usetpl) await ev(id => P.id === id || openProject(id), home); });
    }
    await ev(() => closeModal());
    await ev(id => P.id === id || openProject(id), home);
  }
  for (const f of ['png', 'mp4', 'wav']) await act(`Export window renders ${f}`, async () => { // the window's own render path, start to "Show in Finder"
    await page.click('#btnExport'); await page.selectOption('#exFmt', f); if (f !== 'wav') await page.selectOption('#exRes', '0');
    await page.click('#exGo'); await page.waitForSelector('#exDone [data-reveal]', { timeout: 180000 });
    const file = await page.getAttribute('#exDone [data-reveal]', 'data-reveal');
    if (!fs.existsSync(`${EXP}/${file}`)) throw new Error(`${file} is not in the exports folder`);
  });
}

// ---------- the whole history: undo to the start and redo to the end ----------
if (run('history')) {
  const r = await ev(async () => {
    S.t = 2; addText('Title'); S.sel = { lane: 'main', id: P.main[1].id }; split(); change(() => { P.main[0].tr = { type: 'slide', d: 0.4 }; }); change(() => { P.main[0].speed = 2; }); addEffect(Object.keys(FX)[2]);
    const end = JSON.stringify(P), n = undo.length;
    for (let i = 0; i < n; i++) restore(undo, redo);
    const atStart = undo.length === 0;
    for (let i = 0; i < n; i++) restore(redo, undo);
    return { n, atStart, back: JSON.stringify(P) === end };
  });
  if (!r.atStart || !r.back) findings.push({ label: 'history', bad: [`undo ${r.n} steps then redo: ${JSON.stringify(r)}`], errs: [], toasts: [] });
  await check('history');
}

// ---------- tidy: what this run made goes to the trash ----------
await ev(() => { clearTimeout(saveTimer); });
await b.close();
const after = { p: await get('/api/projects'), m: await get('/api/media'), t: await get('/api/templates') };
const made = { p: after.p.filter(x => !before.p.has(x.id)), m: after.m.filter(x => !before.m.has(x.id)), t: after.t.filter(x => !before.t.has(x.id)), e: fs.readdirSync(EXP).filter(f => !before.e.has(f)) };
fs.mkdirSync(`${LIB}/trash/exports`, { recursive: true });
for (const f of made.e) fs.renameSync(`${EXP}/${f}`, `${LIB}/trash/exports/${f}`);
for (const p of made.p) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const t of made.t) await fetch(`${B}/api/templates/${t.id}/trash`, { method: 'POST', headers: H, body: '{}' });

for (const f of findings) console.log(`FAIL ${f.label}\n     ${[...f.bad, ...f.errs, ...f.toasts.map(t => `toast: ${t}`)].join('\n     ')}`);
console.log(`\n${actions} actions, ${findings.length} problems; trashed ${made.p.length} projects, ${made.m.length} media, ${made.t.length} templates`);
process.exit(findings.length ? 1 : 0);
