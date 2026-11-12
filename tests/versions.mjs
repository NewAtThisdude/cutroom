// Project version history: snapshots at the right cadence, named versions survive pruning, restore brings back the exact
// JSON and is itself reversible, trash takes the history along; then the Versions dialog in both motion modes.
//   CUTROOM_VERSION_GAP=2 CUTROOM_HOME=<scratch lib> python3 -I server.py, then B=... CUTROOM_HOME=<same lib> node versions.mjs
import { webkit } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const B = process.env.B || 'http://127.0.0.1:4610', HOME = process.env.CUTROOM_HOME;
if (!HOME) throw new Error('CUTROOM_HOME: the server\'s (scratch) library, to look at the files');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
  const r = await fetch(B + path, { method, headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const vfile = (id, v) => JSON.parse(gunzipSync(readFileSync(`${HOME}/projects/${id}.versions/${v}.json.gz`)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the engine ----
const id = hex(), texts = n => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, start: i, dur: 1, text: `T${i}` }));
const proj = (name, n = 0) => ({ id, name, w: 1080, h: 1920, fps: 30, main: [], overlay: [], audio: [], text: texts(n), captions: [], fx: [] });
const put = p => api(`/api/projects/${id}`, p, 'PUT');
const list = () => api(`/api/projects/${id}/versions`);
await put(proj('A'));
check('the first save keeps a snapshot', (await list()).length === 1);
await put(proj('A2'));
check('an edit right after keeps none', (await list()).length === 1);
await sleep(2200); // CUTROOM_VERSION_GAP=2 stands in for 5 minutes
await put(proj('A3'));
let vs = await list();
check('an edit after the gap keeps the state saved', vs.length === 2 && vs[0].name === null && vfile(id, vs[0].id).p.name === 'A3', `${vs.length} versions`);
await put(proj('A4'));
await put(proj('B', 6));
vs = await list();
check('a big change (6 clips) keeps the state before it', vs.length === 3 && same(vfile(id, vs[0].id).p, proj('A4')), vs.map(v => v.clips).join(','));
await sleep(2200); await put(proj('A5', 6)); await put(proj('C')); // A5 is kept for the gap; the big change after it would keep A5 again
check('the same state is not kept twice', (await list()).length === 4);
check('the list gives time, duration and clip count', vs.every(v => v.t > 1e9 && typeof v.dur === 'number' && typeof v.clips === 'number'));
const named = await api(`/api/projects/${id}/versions`, { name: 'Keep me' });
check('a named version is saved', named.id.endsWith('n') && (await list())[0].name === 'Keep me' && same(vfile(id, named.id).p, proj('C')));
for (let i = 0; i < 66; i++) await put(proj(`X${i}`, i % 2 ? 6 : 0)); // every save is a big change: an automatic version each
vs = await list();
const autos = vs.filter(v => !v.named);
check('pruning keeps the last 60 automatic versions', autos.length === 60, `${autos.length} automatic`);
check('a named version survives pruning', vs.some(v => v.id === named.id));
const disk = readFileSync(`${HOME}/projects/${id}.json`, 'utf8');
const target = autos[30], want = vfile(id, target.id).p;
const back = await api(`/api/projects/${id}/versions/${target.id}/restore`, {});
check('restore brings back the exact JSON', same(back, want) && same(await api(`/api/projects/${id}`), want) && same(JSON.parse(readFileSync(`${HOME}/projects/${id}.json`, 'utf8')), want));
vs = await list();
const before = vs.find(v => v.name === 'Before restore');
check('restore keeps the state it replaced as a version', before && same(vfile(id, before.id).p, JSON.parse(disk)));
await api(`/api/projects/${id}/versions/${before.id}/restore`, {});
check('restoring that undoes the restore, exactly', readFileSync(`${HOME}/projects/${id}.json`, 'utf8') === disk);
await api(`/api/projects/${id}/versions/${named.id}/delete`, {});
check('a named version can be deleted', !(await list()).some(v => v.id === named.id));
let bad = 0; try { await api(`/api/projects/${id}/versions/1234/restore`, {}); } catch { bad = 1; }
check('a malformed version id is refused', bad);
const nv = readdirSync(`${HOME}/projects/${id}.versions`).length;
await api(`/api/projects/${id}/trash`, {});
const tv = readdirSync(`${HOME}/trash`).filter(f => f.startsWith(id) && f.endsWith('.versions'));
check('trash takes the history along', !existsSync(`${HOME}/projects/${id}.versions`) && tv.length && readdirSync(`${HOME}/trash/${tv.at(-1)}`).length === nv, tv.join(','));

// ---- the editor ----
const src = (await api('/api/projects')).find(p => p.clips > 0 && p.pic);
const b = await webkit.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  const pid = await ev(async s => { const p = await api(`/api/projects/${s}`); p.id = hex12(); p.name = 'Versions test'; await api(`/api/projects/${p.id}`, p, 'PUT'); await openProject(p.id); return p.id; }, src.id);
  await page.click('#btnVersions');
  await page.waitForSelector('.vrow');
  check(`${rm}: Versions lists the snapshot of a new project`, await page.locator('.vrow').count() >= 1 && /just now/.test(await page.locator('.vrow small').first().textContent()));
  await page.fill('#verName', 'Rough cut');
  await page.click('[data-vsave]');
  await page.waitForFunction(() => [...document.querySelectorAll('.vrow b')].some(b => b.textContent === 'Rough cut'));
  check(`${rm}: Save version adds it to the list`, true);
  await page.click('[data-close]');
  const n0 = await ev(() => P.main.length);
  await ev(() => { window.stay = 1; change(() => { P.name = 'Edited'; P.main.pop(); }); });
  await ev(() => flushSave());
  await page.click('#btnVersions');
  await page.waitForSelector('.vrow');
  await page.locator('.vrow', { hasText: 'Rough cut' }).locator('[data-vrestore]').click();
  await page.waitForFunction(() => $('#modal').hidden && P.name === 'Versions test');
  check(`${rm}: Restore reloads the editor without a page reload`, await ev(() => window.stay === 1 && P.main.length) === n0);
  await page.waitForFunction(() => !saveTimer && $('#saveState').textContent === 'Saved');
  const vid = (await api(`/api/projects/${pid}/versions`)).find(v => v.name === 'Rough cut').id;
  check(`${rm}: the saved project is that version, exactly`, same(await api(`/api/projects/${pid}`), vfile(pid, vid).p));
  await page.keyboard.press('Meta+z');
  check(`${rm}: Undo takes the restore back`, await ev(() => P.name === 'Edited' && P.main.length) === n0 - 1);
  await page.click('#btnProjects');
  await page.waitForSelector(`[data-versions="${pid}"]`, { state: 'attached' });
  await page.hover(`.pcard:has([data-versions="${pid}"])`);
  await page.click(`[data-versions="${pid}"]`);
  await page.waitForFunction(() => document.querySelector('.dialog h2')?.textContent === 'Versions');
  const rows = await page.locator('.vrow b').allTextContents();
  check(`${rm}: the project card opens its versions`, rows.includes('Before restore') && rows.includes('Rough cut'), rows.slice(0, 4).join(', '));
  const op = await page.locator('.dialog').evaluate(d => getComputedStyle(d).opacity);
  check(`${rm}: the dialog is visible`, op === '1', `opacity ${op}`);
  await page.click('[data-close]');
  const rem = await ev(async () => { await REMOTE.versions({ action: 'save', name: 'From Claude' }); const l = await REMOTE.versions({}); const v = l.find(x => x.name === 'Rough cut'); await REMOTE.versions({ action: 'restore', version: v.id }); return { names: l.map(x => x.name), name: P.name, undo: undo.length }; });
  check(`${rm}: the MCP command lists, saves and restores`, rem.names[0] === 'From Claude' && rem.name === 'Versions test' && rem.undo > 0, JSON.stringify(rem).slice(0, 120));
  await ev(() => flushSave());
  await api(`/api/projects/${pid}/trash`, {});
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
