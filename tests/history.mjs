// The History panel: a scripted series of real edits (split, move, trim, speed, add text, delete) is listed newest first
// with the right names; jumping back 3 steps gives exactly the project JSON of that moment, forward again restores it,
// an edit after a jump drops the redo branch; the MCP's list / goto; the stack stays at 200. Both motion modes.
//   CUTROOM_HOME=<scratch lib> python3 -I server.py, then B=... node history.mjs
import { browser } from './browser.mjs';
const B = process.env.B || 'http://127.0.0.1:4610';
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };

const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && [...M.values()].some(m => m.kind === 'video' && m.duration >= 4), null, { timeout: 20000 });
  const ev = (f, a) => page.evaluate(f, a);
  const names = () => page.locator('#histList .hrow b').allTextContents();
  await ev(() => {
    const v = [...M.values()].find(m => m.kind === 'video' && m.duration >= 4);
    setProject(newProject('16:9')); P.name = 'History test (scratch)';
    for (let i = 0; i < 3; i++) addMedia(v.id, 'main');
    undo.length = 0; redo.length = 0; S.sel = null; renderAll();
  });
  const snaps = [await ev(() => JSON.stringify(P))]; // snaps[k] = the project just after step k
  const edit = async f => { await ev(f); await ev(() => document.activeElement?.blur()); snaps.push(await ev(() => JSON.stringify(P))); };
  const key = async k => { await ev(() => document.activeElement?.blur()); await page.keyboard.press(k); };
  // 1 split clip 2 (the S key), 2 move clip 1 to the end of the three (the MCP's move), 3 trim clip 2's end (W),
  // 4 speed 2x on clip 1 (the inspector slider), 5 add a title (Text > Add), 6 delete clip 3 (⌫)
  await ev(() => { packMain(); const c = P.main[1]; S.sel = { lane: 'main', id: c.id }; S.t = snap(c.start + tdur(c, 'main') / 2); renderAll(); }); await key('s'); snaps.push(await ev(() => JSON.stringify(P)));
  await edit(() => REMOTE.move_clip({ id: P.main[0].id, index: 3 }));
  await ev(() => { packMain(); const c = P.main[1]; S.sel = { lane: 'main', id: c.id }; S.t = snap(c.start + tdur(c, 'main') / 2); renderAll(); }); await key('w'); snaps.push(await ev(() => JSON.stringify(P)));
  await edit(() => {
    S.sel = { lane: 'main', id: P.main[0].id }; renderInspector();
    const el = document.querySelector('#inspector [data-k="c.speed"]');
    el.value = String(Math.log10(2)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await edit(() => addText('Title'));
  await ev(() => { S.sel = { lane: 'main', id: P.main[2].id }; renderAll(); }); await key('Backspace'); snaps.push(await ev(() => JSON.stringify(P)));
  check(`${rm}: six edits, six steps`, await ev(() => undo.length === 6 && !redo.length), await ev(() => `${undo.length} / ${redo.length}`));

  await key('h');
  await page.waitForSelector('#histList .hrow');
  const want = ['Deleted clip 3', 'Added title "Your title"', 'Speed 2x on clip 1', 'Trimmed clip 2', 'Moved clip 4', 'Split clip 2', 'Start'];
  let got = await names();
  check(`${rm}: H opens the panel, newest first, with plain names`, JSON.stringify(got) === JSON.stringify(want), got.join(' | '));
  check(`${rm}: each step says how long ago`, (await page.locator('#histList .hrow small').allTextContents()).slice(0, 6).every(t => /just now/.test(t)));
  check(`${rm}: the current step is marked`, await page.locator('#histList .hrow[aria-current="step"] b').textContent() === 'Deleted clip 3' && await ev(() => document.activeElement?.dataset.hgo) === '6');
  const op = await page.locator('.dialog').evaluate(d => getComputedStyle(d).opacity);
  check(`${rm}: the panel is visible`, op === '1', `opacity ${op}`);

  await page.locator('#histList [data-hgo="3"]').click();
  check(`${rm}: back 3 steps = exactly the project of that moment`, await ev(() => JSON.stringify(P)) === snaps[3]);
  got = await names();
  check(`${rm}: the panel stays open, the later steps undone but listed`, JSON.stringify(got) === JSON.stringify(want) && await page.locator('#histList .hrow.undone').count() === 3
    && await page.locator('#histList .hrow[aria-current="step"] b').textContent() === 'Trimmed clip 2');
  await page.locator('#histList [data-hgo="6"]').click();
  check(`${rm}: forward again restores it`, await ev(() => JSON.stringify(P)) === snaps[6]);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  check(`${rm}: ↓ steps back`, await ev(() => JSON.stringify(P)) === snaps[3] && await ev(() => undo.length === 3 && redo.length === 3));
  await page.keyboard.press('ArrowUp');
  check(`${rm}: ↑ steps forward`, await ev(() => JSON.stringify(P)) === snaps[4]);
  await page.keyboard.press('ArrowDown');
  await page.locator('#histList [data-hgo="0"]').click();
  check(`${rm}: Start = the state before the first edit`, await ev(() => JSON.stringify(P)) === snaps[0]);
  await page.locator('#histList [data-hgo="3"]').click();
  await page.keyboard.press('Escape');
  check(`${rm}: Esc closes it`, await ev(() => $('#modal').hidden));

  await ev(() => { S.sel = { lane: 'main', id: P.main[0].id }; renderAll(); });
  await page.click('#btnMirror');
  const L = await ev(() => REMOTE.history({ action: 'list' }));
  check(`${rm}: an edit after a jump drops the redo branch`, L.position === 4 && L.steps.length === 4 && !L.steps.some(s => s.undone) && await ev(() => !redo.length)
    && JSON.stringify(L.steps.map(s => s.name)) === JSON.stringify(['Changed mirror on clip 1', 'Trimmed clip 2', 'Moved clip 4', 'Split clip 2']), L.steps.map(s => s.name).join(' | '));
  const mirrored = await ev(() => JSON.stringify(P));
  await ev(() => REMOTE.history({ action: 'goto', step: 1 }));
  const at1 = await ev(() => JSON.stringify(P));
  await ev(() => REMOTE.history({ action: 'goto', step: 4 }));
  const bad = await ev(() => REMOTE.history({ action: 'goto', step: 9 }).then(() => '', e => e.message));
  check(`${rm}: the MCP's goto goes back and forward exactly, and refuses a step that isn't there`, at1 === snaps[1] && await ev(() => JSON.stringify(P)) === mirrored && /0-4/.test(bad), bad);

  await page.click('#btnHistory');
  await page.waitForSelector('#histList .hrow');
  check(`${rm}: the top bar button opens it`, (await names())[0] === 'Changed mirror on clip 1');
  await page.click('[data-close]');
  const n = await ev(() => { for (let i = 0; i < 205; i++) change(() => { P.name = `N${i}`; }); return undo.length; });
  check(`${rm}: the stack stays at 200 steps`, n === 200, `${n}`);
  check(`${rm}: an unlabeled project edit is named`, await ev(() => historyRows().at(-1).name) === 'Renamed the project');
  await ev(async () => { await flushSave(); await api(`/api/projects/${P.id}/trash`, {}); });
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
