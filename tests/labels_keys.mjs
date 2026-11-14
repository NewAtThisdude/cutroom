// Clip colour labels and your own shortcuts, in headless WebKit with real clicks and keys, both motion modes.
// Labels: set from the inspector, the clip menu and ⌘/Ctrl+digit; the bar is drawn on the clip (DOM and pixels);
// "Select clips with this label" picks exactly them; undo / redo; the export plan and the file (md5) are the same with
// and without labels. Shortcuts: remap split S -> D in the sheet (?), D splits and S does nothing, a clash is reported
// and settled (keep / swap), reset one and reset all, the remap survives a reload.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node labels_keys.mjs     (a scratch server, never 4610)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
const B = process.env.B || 'http://127.0.0.1:4610', HOME = process.env.CUTROOM_HOME;
if (!HOME) throw new Error('CUTROOM_HOME: the server\'s (scratch) library, to read the exports');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const fmd5 = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'framemd5', '-'], { maxBuffer: 1 << 26 }).toString().split('\n').filter(l => l && !l.startsWith('#')).join('\n');
const md5 = f => createHash('md5').update(fs.readFileSync(f)).digest('hex');
const made = [];

const b = await webkit.launch();
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => { if (!/\/poster /.test(e.message)) errs.push(e.message); }); // (the reload cuts off the old page's poster upload) page.on('dialog', d => d.accept());
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // no MCP commands from elsewhere
  const boot = async () => { await page.goto(B + '/', { waitUntil: 'load' }); await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 }); };
  await boot();
  const ev = (f, a) => page.evaluate(f, a);
  // a short project of our own: the fox clip three times on the main track
  const pid = await ev(async () => {
    const src = (await api('/api/projects')).find(p => /Remove object example/.test(p.name));
    const p = await api(`/api/projects/${src.id}`), c = p.main[0];
    p.id = hex12(); p.name = 'Labels test (scratch)'; p.main = [0, 1, 2].map(() => ({ ...structuredClone(c), id: hex12() }));
    await api(`/api/projects/${p.id}`, p, 'PUT'); await openProject(p.id); fitTimeline(); return p.id;
  });
  await page.waitForTimeout(800);
  const ids = await ev(() => P.main.map(c => c.id)), clip = id => `.clip.main[data-id="${id}"]`;

  // ---- labels ----
  await page.click(clip(ids[0]));
  await page.click('#inspector .labrow [data-label="red"]');
  await page.click(clip(ids[1]), { button: 'right' });
  await page.click('.ctxmenu button:has-text("Label…")');
  await page.click('.ctxmenu button:has-text("Red")');
  let L = await ev(() => P.main.map(c => c.label || ''));
  check(`${rm}: the inspector and the clip menu label two clips`, L[0] === 'red' && L[1] === 'red' && !L[2], L.join(','));
  const bars = await ev(ids => ids.map(id => { const e = document.querySelector(`.clip.main[data-id="${id}"] .lab`); return e ? getComputedStyle(e).backgroundColor : ''; }), ids);
  check(`${rm}: a bar on each labelled clip, none on the other`, bars[0] && bars[0] === bars[1] && !bars[2], bars.join(' | '));
  const px = async id => { // the clip's foot, as WebKit painted it
    const r = await page.locator(clip(id)).boundingBox();
    const png = await page.screenshot({ clip: { x: r.x + r.width / 2 - 4, y: r.y + r.height - 3, width: 8, height: 2 } });
    return ev(async b64 => { const i = new Image(); i.src = `data:image/png;base64,${b64}`; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data].slice(0, 3); }, png.toString('base64'));
  };
  const want = [0xd0, 0x62, 0x5c], near = (a, q) => a.every((v, i) => Math.abs(v - q[i]) <= 14), p0 = await px(ids[0]), p2 = await px(ids[2]);
  check(`${rm}: the bar's pixels are the label colour (and not on the unlabelled clip)`, near(p0, want) && !near(p2, want), `${p0} vs ${p2}`);
  await page.click(clip(ids[2]));
  await page.keyboard.press('Control+Digit3');
  const k1 = await ev(() => P.main[2].label);
  await page.keyboard.press('Control+Digit3');
  const k2 = await ev(() => P.main[2].label);
  check(`${rm}: Ctrl+3 labels the selected clip yellow, again takes it off`, k1 === 'yellow' && k2 === undefined, `${k1} / ${k2}`);
  await page.click(clip(ids[0]), { button: 'right' });
  await page.click('.ctxmenu button:has-text("Select clips with this label")');
  let sel = await ev(() => selection().map(([c]) => c.id).sort());
  check(`${rm}: select clips with this label picks exactly the two`, JSON.stringify(sel) === JSON.stringify([ids[0], ids[1]].sort()), sel.join(','));
  await page.click(clip(ids[2])); await page.click('#inspector .labrow [data-label="blue"]');
  await page.click(clip(ids[0])); await page.click('#inspector [data-sellabel]');
  sel = await ev(() => selection().map(([c]) => c.id).sort());
  check(`${rm}: the inspector's select button does the same`, JSON.stringify(sel) === JSON.stringify([ids[0], ids[1]].sort()), sel.join(','));
  await page.keyboard.press('Meta+z');
  const u1 = await ev(() => [P.main[2].label, !!document.querySelector(`.clip.main[data-id="${P.main[2].id}"] .lab`)]);
  await page.keyboard.press('Meta+Shift+z');
  const r1 = await ev(() => P.main[2].label);
  check(`${rm}: undo takes the last label off (bar too), redo puts it back`, u1[0] === undefined && !u1[1] && r1 === 'blue', `${u1} / ${r1}`);
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === 'Saved', null, { timeout: 5000 }).catch(() => {});
  const saved = await ev(async id => (await api(`/api/projects/${id}`)).main.map(c => c.label || ''), pid);
  check(`${rm}: labels are saved in the project`, saved.join(',') === 'red,red,blue', saved.join(','));
  const rem = await ev(async id => { const a = await REMOTE.update_clip({ id, set: { label: 'green' } }); let bad = ''; try { await REMOTE.update_clip({ id, set: { label: 'pink' } }); } catch (e) { bad = e.message; } const n = await REMOTE.update_clip({ id, set: { label: null } }); return { a: a.label, bad, n: n.label }; }, ids[2]);
  check(`${rm}: update_clip sets, refuses a bad name, clears; brief() lists it`, rem.a === 'green' && /label must be one of/.test(rem.bad) && rem.n === undefined, JSON.stringify(rem));
  const plans = await ev(async () => { // the export plan with the labels and with none: identical
    const go = async () => { const p = await buildPlan(640, 360, 'fast', 'labels', false, 'prores'); delete p.name; return JSON.stringify(p); };
    const a = await go(), keep = P; P = structuredClone(P); for (const c of P.main) delete c.label; const z = await go(); P = keep; return [a, z, a.includes('label')];
  });
  check(`${rm}: the export plan is the same with and without labels`, plans[0] === plans[1] && !plans[2], `${plans[0].length} chars`);
  if (rm === 'no-preference') { // and the file itself (ProRes: a deterministic encoder)
    const files = await ev(async () => {
      const run = async () => { const plan = await buildPlan(640, 360, 'fast', `labels ${hex12()}`, false, 'prores'); const { job } = await api('/api/export', plan); for (;;) { await sleep(300); const j = await api(`/api/jobs/${job}`); if (j.state !== 'running') { if (j.state !== 'done') throw new Error(j.error); return j.file; } } };
      const a = await run(), keep = P; P = structuredClone(P); for (const c of P.main) delete c.label; const z = await run(); P = keep; return [a, z];
    });
    const [fa, fz] = files.map(f => `${HOME}/exports/${f}`); made.push(fa, fz);
    check('export: same file md5 and same frames with and without labels', md5(fa) === md5(fz) && fmd5(fa) === fmd5(fz), `${md5(fa)} / ${md5(fz)}`);
  }

  // ---- shortcuts ----
  // ? is a read-only quick view; keys are changed in Settings > Shortcuts (its Edit in Settings button)
  const sheet = async () => { await page.waitForSelector('#modal .keysheet'); await page.click('#modal [data-settings]'); await page.waitForSelector('#setKeys [data-keyfor]'); };
  await page.keyboard.press('Escape');
  await page.keyboard.press('?'); await page.waitForSelector('#modal .keysheet');
  const ro = await ev(() => [$$('#modal .keysheet .keys tr').length === KEYMAP0.length, $$('#modal .keysheet [data-keyfor], #modal .keysheet [data-keyreset], #modal .keysheet [data-keyall]').length, !!$('#modal .keysheet [data-settings]')]);
  check(`${rm}: ? opens a read-only sheet, every action a row, with Edit in Settings`, ro[0] && ro[1] === 0 && ro[2], ro.join(','));
  await sheet();
  check(`${rm}: Edit in Settings opens the editable list, every action a row`, await page.locator('#setKeys [data-keyfor]').count() === await ev(() => KEYMAP0.length));
  await page.click('[data-keyfor="split"]');
  const waiting = await page.textContent('[data-keyfor="split"]');
  await page.keyboard.press('d');
  check(`${rm}: click Split, press D: the sheet shows D`, /Press a key/.test(waiting) && (await page.textContent('[data-keyfor="split"]')).startsWith('D'), await page.textContent('#keyMsg'));
  await page.keyboard.press('Escape');
  const n = () => ev(() => P.main.length), at = () => ev(() => { S.t = P.main.at(-1).start + 1.5; placePlayhead(); }); // inside the last clip, away from any cut
  await at(); const n0 = await n();
  await page.keyboard.press('s'); const n1 = await n();
  await page.keyboard.press('d'); const n2 = await n();
  check(`${rm}: D splits, the old S does nothing`, n1 === n0 && n2 === n0 + 1, `${n0} -> S ${n1} -> D ${n2}`);
  check(`${rm}: the clip menu and the split button show D`, (await page.getAttribute('#btnSplit', 'title')).endsWith('(D)') && await ev(() => clipMenu(P.main[0], 'main')[0][2]) === 'D');
  await page.keyboard.press('?'); await sheet();
  await page.click('[data-keyfor="split"]'); await page.keyboard.press('m');
  const conf = await page.textContent('.keyconf').catch(() => '');
  await page.click('[data-keykeep]');
  const kept = await ev(() => [keysOf('split')[0], keysOf('marker')[0]]);
  check(`${rm}: M for split is reported as marker's; keep leaves both`, /M is already the key for marker/.test(conf) && kept.join() === 'KeyD,KeyM', `${conf} | ${kept}`);
  await page.click('[data-keyfor="split"]'); await page.keyboard.press('m'); await page.click('[data-keyswap]');
  const sw = await ev(() => [keysOf('split')[0], keysOf('marker')[0]]);
  check(`${rm}: swap gives split M and marker D`, sw.join() === 'KeyM,KeyD', sw.join());
  await page.click('[data-keyreset="split"]');
  const rs = await ev(() => [keysOf('split').join(' '), keysOf('marker')[0], !!KEYOWN.split]);
  check(`${rm}: reset one brings split back to S and ⌘B`, rs[0] === 'KeyS Mod+KeyB' && rs[1] === 'KeyD' && !rs[2], rs.join(','));
  await page.click('[data-keyall]');
  const ra = await ev(() => [keysOf('marker')[0], Object.keys(KEYOWN).length, store.get('cutroom.keys')]);
  check(`${rm}: reset all: marker back to M, nothing kept`, ra[0] === 'KeyM' && ra[1] === 0 && ra[2] === '{}', ra.join(','));
  await page.click('[data-keyfor="split"]'); await page.keyboard.press('d');
  await page.click('[data-keyfor="stop"]'); await page.keyboard.press('Shift+KeyX');
  await page.keyboard.press('Escape');
  await boot(); await ev(id => openProject(id), pid); await page.waitForTimeout(500);
  await at(); const m0 = await n();
  await page.keyboard.press('s'); const m1 = await n();
  await page.keyboard.press('d'); const m2 = await n();
  check(`${rm}: after a reload the remap holds (D splits, S doesn't; ⇧X stops)`, m1 === m0 && m2 === m0 + 1 && await ev(() => KEYBY.get('Shift+KeyX')) === 'stop' && !(await ev(() => KEYBY.get('KeyK'))), `${m0} -> ${m1} -> ${m2}, ${await ev(() => store.get('cutroom.keys'))}`);
  await page.keyboard.press('?'); await sheet(); await page.click('[data-keyall]'); await page.keyboard.press('Escape');
  check(`${rm}: reset all again: S splits`, await ev(() => KEYBY.get('KeyS')) === 'split');
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
  await ev(async id => { await api(`/api/projects/${id}/trash`, {}); }, pid);
  await ctx.close();
}
for (const f of made) fs.rmSync(f, { force: true });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
await b.close();
process.exit(res.every(Boolean) ? 0 : 1);
