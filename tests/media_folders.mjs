// Media folders (bins) in the library, in headless WebKit with real clicks and real drag and drop, both motion modes: nested folders
// (New folder, breadcrumb), media dragged in (one card, then several selected with ctrl-click), moved by the MCP command and the
// Move to menu, rename, delete (the media stay, moved up), smart folders (kind, used in this project, not used anywhere, added
// today / this week) with the right items, search inside a folder and across all, the same folders after a reload and in a second
// project, two editors changing folders at once keep both changes, the MCP listing reports folders, no page errors.
//   B=<server on a scratch library> CUTROOM_HOME=<that library> node tests/media_folders.mjs   (never 4610)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browser } from './browser.mjs';
const B = process.env.B, HOME = process.env.CUTROOM_HOME, OUT = fileURLToPath(new URL('./out/media_folders/', import.meta.url));
if (!B || !HOME || /:4610\b/.test(B)) { console.log('FAIL: set B (a scratch server, never 4610) and CUTROOM_HOME'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// seed: two videos, a sound, a photo (own names, so a busy library does not matter)
const FILES = [['fold-alpha.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest']],
  ['fold-beta.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30']],
  ['fold-gamma.wav', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2']], ['fold-gamma (voice).wav', ['-f', 'lavfi', '-i', 'sine=frequency=550:duration=2']], ['fold-delta.png', ['-f', 'lavfi', '-i', 'testsrc2=size=200x120:rate=1', '-frames:v', '1']]];
for (const [n, a] of FILES) {
  if (!fs.existsSync(OUT + n)) execFileSync('ffmpeg', ['-v', 'error', '-y', ...a, OUT + n]);
  if (!(await api('/api/media')).some(m => m.name === n)) await fetch(`${B}/api/import?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(OUT + n) });
}
for (let i = 0; i < 120 && (await api('/api/media')).some(m => !m.ready); i++) await sleep(500);
const lib = await api('/api/media'), id = Object.fromEntries(FILES.map(([n]) => [n.slice(5, -4), lib.find(m => m.name === n)?.id]));
if (Object.values(id).some(x => !x)) { console.log('FAIL seeding the library', JSON.stringify(id)); process.exit(1); }
const ALL = Object.values(id);
const reset = async () => { for (const k of Object.keys((await api('/api/folders')).folders)) await api('/api/folders', { op: 'delete', id: k }).catch(() => {}); };

const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  console.log(`--- reducedMotion: ${rm}`);
  await reset();
  const ctx = await b.newContext({ viewport: { width: 1517, height: 1500 }, reducedMotion: rm }), page = await ctx.newPage(), errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await sleep(15000); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  const ev = (f, a) => page.evaluate(f, a);
  const open = async pg => { await pg.goto(`${B}/`, { waitUntil: 'load' }); await pg.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0 && typeof FD === 'object', null, { timeout: 20000 }); if (await pg.$('#tour')) await pg.keyboard.press('Escape'); };
  await open(page);
  await ev(() => store.set('cutroom.tour', 'done'));
  const cards = () => ev(() => $$('#mediaList .mitem[data-media]').map(x => M.get(x.dataset.media).name));
  const foldNames = () => ev(() => $$('#folderList .fold b').map(x => x.textContent));
  const crumbs = () => ev(() => $$('#folderBar .crumbs button').map(x => x.textContent).join(' > '));
  const mk = async name => { await page.click('#fdNew'); await page.fill('#fdName', name); await page.keyboard.press('Enter'); await page.waitForSelector('#fdForm', { state: 'detached' }); };
  const drag = (from, to) => page.dragAndDrop(from, to);
  const card = n => `#mediaList .mitem[data-media="${id[n]}"]`;
  const smartN = async label => +(await ev(l => [...document.querySelectorAll('.smart button')].find(x => x.firstChild.textContent === l).querySelector('small').textContent, label));
  const smartOpen = async label => { await page.click(`.smart button:has-text("${label}")`); await page.waitForTimeout(250); };
  await ev(() => { setProject(newProject('16:9')); P.name = 'Folders A'; renderAll(); });

  // ---- create, nest, breadcrumb ----
  await mk('Interviews');
  check(`${rm}: New folder makes Interviews at the top`, (await foldNames()).join() === 'Interviews' && (await crumbs()) === 'All media');
  await page.click('.fold b'); await page.waitForTimeout(100);
  await mk('B-roll');
  check(`${rm}: opening Interviews then New folder nests B-roll inside it; breadcrumb reads All media > Interviews`, (await crumbs()) === 'All media > Interviews' && (await foldNames()).join() === 'B-roll');
  await page.click('.fold b'); await page.waitForTimeout(100);
  check(`${rm}: B-roll opens: breadcrumb All media > Interviews > B-roll, empty folder says so`, (await crumbs()) === 'All media > Interviews > B-roll' && (await cards()).length === 0 && /empty/i.test(await ev(() => $('#mediaList .hint')?.textContent || '')));
  await page.click('#folderBar .crumbs button:has-text("Interviews")'); await page.waitForTimeout(100);
  check(`${rm}: the breadcrumb goes back up`, (await crumbs()) === 'All media > Interviews');
  await page.click('#folderBar .crumbs button:has-text("All media")'); await page.waitForTimeout(100);
  // duplicate name refused
  await page.click('#fdNew'); await page.fill('#fdName', 'interviews'); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
  const dupMsg = await ev(() => $('#fdErr')?.textContent || ''); await page.keyboard.press('Escape'); if (await page.$('#fdForm')) await page.click('#modal [data-close]');
  check(`${rm}: a second folder with the same name there is refused in words`, /already/.test(dupMsg) && (await foldNames()).length === 1, dupMsg);

  // ---- drag one card in, then several selected ----
  await drag(card('alpha'), '.fold[data-go]'); await page.waitForTimeout(400);
  let st = await api('/api/folders'), inter = Object.keys(st.folders).find(k => st.folders[k].name === 'Interviews'), broll = Object.keys(st.folders).find(k => st.folders[k].name === 'B-roll');
  check(`${rm}: dragging a card onto a folder files it (server state)`, st.of[id.alpha] === inter, JSON.stringify(st.of));
  check(`${rm}: the card is still in All media and the folder shows its count`, (await cards()).includes('fold-alpha.mp4') && (await ev(() => $('.fold small').textContent)) === '1');
  await page.click(card('beta'), { modifiers: ['Control'] }); await page.click(card('gamma'), { modifiers: ['Control'] });
  check(`${rm}: ctrl-click selects cards (2 selected)`, /2 selected/.test(await ev(() => $('.fdsel')?.textContent || '')));
  await drag(card('beta'), '.fold[data-go]'); await page.waitForTimeout(400);
  st = await api('/api/folders');
  check(`${rm}: dragging one of the selected cards moves all selected`, st.of[id.beta] === inter && st.of[id.gamma] === inter && !st.of[id.delta], JSON.stringify(st.of));
  await page.click('#folderList .fold b'); await page.waitForTimeout(150);
  check(`${rm}: inside Interviews: its three items`, (await cards()).sort().join() === 'fold-alpha.mp4,fold-beta.mp4,fold-gamma.wav', (await cards()).join());

  // ---- the Move to menu: back out to a subfolder and to no folder ----
  await page.click(card('gamma'), { modifiers: ['Control'] });
  await page.selectOption('#fdMoveTo', broll); await page.waitForTimeout(400);
  st = await api('/api/folders');
  check(`${rm}: the Move to menu moves the selection into B-roll`, st.of[id.gamma] === broll && st.of[id.alpha] === inter);
  await page.click('#folderBar .crumbs button:has-text("All media")'); await page.waitForTimeout(100);
  await drag(card('beta'), '#folderBar .crumbs button:has-text("All media")'); await page.waitForTimeout(400); // out: onto the All media crumb
  check(`${rm}: dragging a card onto the All media crumb takes it out of its folder`, !(await api('/api/folders')).of[id.beta]);

  // ---- by command (what MCP calls) ----
  const cmd = a => ev(a => REMOTE.media_folders(a), a);
  await cmd({ action: 'move', media: ['fold-delta.png'], to: 'Interviews/B-roll' });
  let ls = await cmd({ action: 'list' }), mlist = await ev(() => REMOTE.media());
  check(`${rm}: the move command files a photo by name into the folder path; the media listing reports folder paths`,
    mlist.find(m => m.name === 'fold-delta.png').folder === 'Interviews/B-roll' && mlist.find(m => m.name === 'fold-gamma.wav').folder === 'Interviews/B-roll' && mlist.find(m => m.name === 'fold-beta.mp4').folder === null, JSON.stringify(mlist.filter(m => m.name.startsWith('fold-')).map(m => [m.name, m.folder])));
  check(`${rm}: the command's listing has folders with counts, the smart folders and the unfiled count`,
    ls.folders.find(f => f.path === 'Interviews/B-roll')?.items === 2 && ls.folders.find(f => f.path === 'Interviews')?.total === 3 && 'Not used anywhere' in ls.smart && typeof ls.unfiled === 'number', JSON.stringify(ls.folders));
  const made = await cmd({ action: 'create', path: 'Music/Beds' });
  await cmd({ action: 'rename', path: 'Music/Beds', name: 'Loops' });
  check(`${rm}: the create command builds a path; rename by path`, made.folders.some(f => f.path === 'Music/Beds') && (await cmd({})).folders.some(f => f.path === 'Music/Loops'));
  let refused = ''; try { await cmd({ action: 'move', media: ['nothing-like-this'], to: 'Music' }); } catch (e) { refused = e.message; }
  check(`${rm}: moving media that does not exist is refused in words`, /no media/.test(refused), refused);

  // ---- rename and delete in the UI ----
  await page.click('#folderBar .crumbs button:has-text("All media")'); await page.waitForTimeout(100);
  await page.hover('.fold b'); await page.click('.fold [data-frn]'); await page.fill('#fdName', 'Talks'); await page.keyboard.press('Enter'); await page.waitForSelector('#fdForm', { state: 'detached' });
  check(`${rm}: Rename on a folder tile renames it`, (await foldNames()).includes('Talks') && !(await foldNames()).includes('Interviews'), (await foldNames()).join());
  const before = (await api('/api/media')).length;
  await cmd({ action: 'create', path: 'Talks/Old' }); await cmd({ action: 'move', media: ['fold-beta.mp4'], to: 'Talks/Old' });
  await page.click('#folderList .fold:has(b:text-is("Talks")) b'); await page.waitForTimeout(150);
  await page.hover('.fold:has(b:text-is("Old")) b'); await page.click('.fold:has(b:text-is("Old")) [data-fdel]'); await page.waitForTimeout(500);
  st = await api('/api/folders'); const oldId = Object.keys(st.folders).find(k => st.folders[k].name === 'Old');
  check(`${rm}: deleting the folder Old inside Talks keeps its media (moved up into Talks), nothing else lost`, !oldId && st.of[id.beta] === Object.keys(st.folders).find(k => st.folders[k].name === 'Talks') && (await api('/api/media')).length === before, JSON.stringify(st.of));
  await page.click('#folderBar .crumbs button:has-text("All media")'); await page.waitForTimeout(100);

  // ---- smart folders ----
  const media = await api('/api/media'), n = k => media.filter(m => m.kind === k).length;
  check(`${rm}: smart folders by kind count the whole library (${n('video')} videos, ${n('audio')} audio, ${n('image')} photos)`, (await smartN('Videos')) === n('video') && (await smartN('Audio')) === n('audio') && (await smartN('Photos')) === n('image'));
  await smartOpen('Audio');
  check(`${rm}: Audio smart folder lists exactly the audio, and the breadcrumb says so`, (await cards()).sort().join() === media.filter(m => m.kind === 'audio').map(m => m.name).sort().join() && /Audio$/.test(await crumbs()));
  await smartOpen('Audio'); // again: back to all
  await ev(async a => { addMedia(a, 'main'); await flushSave(); }, id.alpha); await page.waitForTimeout(200);
  await smartOpen('Used in this project');
  check(`${rm}: "Used in this project" shows what the open project uses`, (await cards()).join() === 'fold-alpha.mp4', (await cards()).join());
  await smartOpen('Not used anywhere');
  const un = await cards();
  check(`${rm}: "Not used anywhere" leaves out the used clip and lists the rest of my media`, !un.includes('fold-alpha.mp4') && ['fold-beta.mp4', 'fold-gamma.wav', 'fold-delta.png'].every(x => un.includes(x)), un.join());
  await smartOpen('Added today'); const today = await cards();
  await smartOpen('Added this week'); const week = await cards();
  check(`${rm}: Added today / this week list the files imported now`, ['fold-alpha.mp4', 'fold-delta.png'].every(x => today.includes(x) && week.includes(x)) && (await smartN('Added today')) === today.length);
  await smartOpen('Added this week'); // closes it
  await page.screenshot({ path: `${OUT}${rm}.png` });

  // ---- search inside a folder and across all ----
  await page.click('#folderList .fold:has(b:text-is("Talks")) b'); await page.waitForTimeout(150); // Talks
  await cmd({ action: 'move', media: ['fold-delta.png'], to: '' }); // an item of mine in no folder
  await cmd({ action: 'move', media: ['fold-beta'], to: 'Talks/B-roll' }); // beta in a subfolder of Talks
  await page.fill('#mediaSearch', 'beta');
  const inFolder = await cards(); await page.fill('#mediaSearch', 'delta'); const none = await cards();
  await page.click('#folderBar .crumbs button:has-text("All media")'); await page.waitForTimeout(100);
  const across = await cards(); await page.fill('#mediaSearch', 'fold');
  await page.click('#mediaFilter [data-mfilter="audio"]'); await page.click('#folderList .fold:has(b:text-is("Talks")) b'); await page.waitForTimeout(100);
  const filt = await cards(); await page.click('#mediaFilter [data-mfilter="all"]');
  check(`${rm}: search inside Talks finds beta (in a subfolder), not delta (in no folder); across all media it finds delta; the Audio chip works inside a folder`,
    inFolder.join() === 'fold-beta.mp4' && none.length === 0 && across.includes('fold-delta.png') && filt.join() === 'fold-gamma.wav', `${inFolder} | ${none} | ${across} | ${filt}`);
  await page.fill('#mediaSearch', ''); await page.click('#folderBar .crumbs button:has-text("All media")');

  // ---- reload, a second project, a second editor ----
  const snap = async pg => pg.evaluate(() => JSON.stringify([Object.values(FD.folders).map(f => f.name).sort(), Object.keys(FD.of).length]));
  const s1 = await snap(page);
  await open(page);
  check(`${rm}: after a reload the folders and their media are the same`, (await snap(page)) === s1 && (await foldNames()).includes('Talks'), s1);
  await ev(() => { setProject(newProject('9:16')); P.name = 'Folders B'; renderAll(); });
  await page.waitForTimeout(200);
  check(`${rm}: a second project sees the same folders`, (await snap(page)) === s1 && (await foldNames()).includes('Talks'));
  await smartOpen('Not used anywhere'); const un2 = await cards(); await smartOpen('Not used anywhere');
  check(`${rm}: in the second project "Not used anywhere" still leaves out what project A uses (saved)`, !un2.includes('fold-alpha.mp4') && un2.includes('fold-gamma.wav'), un2.join());
  const page2 = await (await b.newContext({ viewport: { width: 1517, height: 1500 }, reducedMotion: rm })).newPage();
  page2.on('pageerror', e => errs.push(e.message));
  await page2.route(u => u.pathname === '/api/remote/next', async r => { await sleep(15000); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await open(page2);
  const bothMade = await Promise.all([page.evaluate(() => fdOp({ op: 'create', name: 'From one' }).then(() => 1)), page2.evaluate(() => fdOp({ op: 'create', name: 'From two' }).then(() => 1)),
    api('/api/folders', { op: 'move', media: [id.delta], folder: null }), api('/api/folders', { op: 'create', name: 'From three' })]);
  const fin = await api('/api/folders'), names = Object.values(fin.folders).map(f => f.name);
  check(`${rm}: two editors and a script changing folders at once lose nothing`, ['From one', 'From two', 'From three', 'Talks'].every(x => names.includes(x)) && !fin.of[id.delta] && bothMade.length === 4, names.join());
  await page.evaluate(() => fdLoad()); await page2.evaluate(() => fdLoad());
  check(`${rm}: both editors show all of them after refreshing`, (await snap(page)) === (await snap(page2)), `${await snap(page)} | ${await snap(page2)}`);

  // ---- folder names and paths: "/" refused, names cleaned the same on both sides, media found like every other command ----
  const nF = async () => Object.keys((await api('/api/folders')).folders).length, n0 = await nF();
  const bad = await api('/api/folders', { op: 'create', name: 'A/B' }), badRn = await api('/api/folders', { op: 'rename', id: Object.keys((await api('/api/folders')).folders)[0], name: 'x/y' }), dots = await api('/api/folders', { op: 'create', name: '..' });
  check(`${rm}: the server refuses a folder name with / (create and rename) or ".." in words, and makes nothing`, [bad, badRn, dots].every(r => /cannot contain/.test(r.error || '')) && (await nF()) === n0, JSON.stringify([bad, badRn, dots]).slice(0, 200));
  const long = 'x'.repeat(70), want = `Two Spaces/${'x'.repeat(60)}`;
  await cmd({ action: 'move', media: ['fold-gamma (voice)'], to: `Two   Spaces/${long}` });
  const again = await cmd({ action: 'move', media: ['fold-gamma (voice)'], to: `Two  Spaces/${long}` });
  check(`${rm}: a path with doubled spaces and a segment over 60 characters makes exactly its two folders (cleaned like the server does), and the same raw path finds them again`,
    (await nF()) === n0 + 2 && again.folders.filter(f => f.path === want).length === 1 && !again.folders.some(f => f.path === 'x'.repeat(70)) && (await api('/api/folders')).of[id['gamma (voice)']] === again.folders.find(f => f.path === want).id, again.folders.map(f => f.path.slice(0, 30)).join(' | '));
  let rej = ''; try { await cmd({ action: 'create', path: 'Fresh/..' }); } catch (e) { rej = e.message; }
  check(`${rm}: a path with .. is refused before anything is made`, /cannot be/.test(rej) && !(await cmd({})).folders.some(f => f.path === 'Fresh'), rej);
  await cmd({ action: 'move', media: ['fold-gamma'], to: 'Mix' });
  st = await api('/api/folders');
  check(`${rm}: media given by name resolves like every other command: "fold-gamma" is fold-gamma.wav, not "fold-gamma (voice).wav"`, st.of[id.gamma] === Object.keys(st.folders).find(k => st.folders[k].name === 'Mix') && st.of[id['gamma (voice)']] !== st.of[id.gamma], JSON.stringify(st.of));
  // ---- neighbours of the feature stay whole: library still lists everything, old media untouched ----
  check(`${rm}: all my media is still in the library`, (await api('/api/media')).filter(m => ALL.includes(m.id)).length === ALL.length);
  check(`${rm}: no page errors`, errs.length === 0, errs.join(' | '));
  await page2.context().close(); await ctx.close();
}
await reset();
await b.close();
const bad = res.filter(x => !x).length;
console.log(`${res.length - bad}/${res.length} checks passed`);
process.exit(bad ? 1 : 0);
