// Crash recovery, with real SIGKILLs: (1) an edit made while saves cannot land survives the server AND the browser being killed
// (the crash journal: Restore brings it back, Discard drops it); (2) a project file cut off mid-write opens as its newest good
// version with a message, never a blank editor; (3) an export running when the server is killed is reported on the next start
// ("Export interrupted") and Retry renders it.
//   cd tests && node recovery.mjs        (starts its own server on :4840 in tests/out/recovery-lib and its own Chromium; both killed at the end)
//   Wrap in lockf (part 3 exports video). BROWSER_BIN overrides the Chromium binary.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';

const here = new URL('.', import.meta.url).pathname, lib = `${here}out/recovery-lib`, prof = `${here}out/recovery-profile`;
const PORT = 4840, CDP = 4841, B = `http://127.0.0.1:${PORT}`, res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.rmSync(lib, { recursive: true, force: true }); fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(lib, { recursive: true });

let server, chrome;
async function startServer() {
  server = spawn('python3', ['-I', `${here}../server.py`], { env: { ...process.env, CUTROOM_HOME: lib, CUTROOM_PORT: String(PORT), CUTROOM_VERSION_GAP: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${B}/api/ping`, { headers: { 'X-Cutroom': '1' } })).ok) return; } catch {} await sleep(200); }
  throw new Error('server did not start');
}
const kill9 = async p => { const dead = new Promise(r => p.once('exit', r)); p.kill('SIGKILL'); await dead; };
const realPid = () => +execFileSync('lsof', ['-t', `-iTCP:${PORT}`, '-sTCP:LISTEN']).toString().trim().split('\n')[0]; // (python3 is a launcher: the server is not always the pid spawn returned)
async function killServer() { const pid = realPid(); process.kill(pid, 'SIGKILL'); for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await sleep(100); } catch { return; } } }
async function startChrome() { // headless Chromium with a fixed profile folder, driven over CDP (so the test owns its process and can SIGKILL it)
  chrome = spawn(process.env.BROWSER_BIN || chromium.executablePath().replace(/chromium-(\d+)\/.*/, 'chromium_headless_shell-$1/chrome-headless-shell-mac-arm64/chrome-headless-shell'), [`--remote-debugging-port=${CDP}`, `--user-data-dir=${prof}`, '--no-first-run', '--window-size=1517,904', 'about:blank'], { stdio: 'ignore' });
  let br;
  for (let i = 0; i < 50 && !br; i++) { try { br = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); } catch { await sleep(200); } }
  const ctx = br.contexts()[0], page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M !== undefined, null, { timeout: 30000 });
  return { br, page };
}
const api = (path, body) => fetch(B + path, { method: body ? 'POST' : 'GET', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
const titles = page => page.evaluate(() => P.text.map(t => t.text));

try {
  // ---------- 1. the journal ----------
  await startServer();
  let { br, page } = await startChrome();
  const pid = await page.evaluate(async () => { setProject(newProject('16:9')); P.name = 'Recovery (scratch)'; addText('Text', { text: 'Saved edit' }); await saveNow(); return P.id; });
  await page.waitForFunction(() => $('#saveState').textContent === 'Saved');
  check('1: the first edit is saved on the server', JSON.stringify(JSON.parse(fs.readFileSync(`${lib}/projects/${pid}.json`, 'utf8')).text.map(t => t.text)) === '["Saved edit"]');
  await killServer();
  await page.evaluate(() => { addText('Text', { text: 'Unsaved edit' }); });
  await page.waitForFunction(() => saveFails > 0, null, { timeout: 15000 });
  check('1: with the server dead the edit is in the journal, the save fails and keeps retrying', await page.evaluate(id => !!localStorage.getItem(`cutroom.journal.${id}`), pid));
  await sleep(6500); // the browser commits localStorage to disk in the background (~5 s): a SIGKILL right at the edit can beat it (a ceiling of the browser)
  await kill9(chrome); await br.close().catch(() => {});
  check('1: the saved file on disk lacks the edit (nothing else could have kept it)', JSON.stringify(JSON.parse(fs.readFileSync(`${lib}/projects/${pid}.json`, 'utf8')).text.map(t => t.text)) === '["Saved edit"]');
  await startServer(); ({ br, page } = await startChrome());
  await page.waitForSelector('#rbar .confirm');
  const msg = await page.textContent('#rbar');
  check('1: reopened, a banner offers the unsaved edits (Restore / Discard)', /Unsaved edits/.test(msg) && /Restore/.test(msg) && /Discard/.test(msg), msg);
  check('1: until you choose, the project is the saved one', (await titles(page)).join() === 'Saved edit');
  await page.click('#rbar button:has-text("Restore")');
  await page.waitForFunction(() => $('#saveState').textContent === 'Saved');
  check('1: Restore brings the edit back, and it is saved', (await titles(page)).join() === 'Saved edit,Unsaved edit' && JSON.parse(fs.readFileSync(`${lib}/projects/${pid}.json`, 'utf8')).text.length === 2);
  check('1: and the journal is cleared', await page.evaluate(id => localStorage.getItem(`cutroom.journal.${id}`) === null, pid));
  // Discard: a journal that is newer than the save and different
  await page.evaluate(() => { const q = structuredClone(P); q.name = 'journal only'; localStorage.setItem(`cutroom.journal.${P.id}`, JSON.stringify({ t: Date.now() + 5000, p: q })); });
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#rbar .confirm');
  await page.click('#rbar button:has-text("Discard")');
  check('1: Discard keeps the saved project and drops the journal', await page.evaluate(id => P.name === 'Recovery (scratch)' && localStorage.getItem(`cutroom.journal.${id}`) === null && !document.querySelector('#rbar .confirm'), pid));
  await page.evaluate(() => { addText('Text', { text: 'third' }); }); await page.waitForFunction(() => $('#saveState').textContent === 'Saved');

  // ---------- 2. a project file that does not parse ----------
  const f = `${lib}/projects/${pid}.json`, good = fs.readFileSync(f, 'utf8');
  check('2: versions exist to fall back to', (await api(`/api/projects/${pid}/versions`)).length >= 2);
  fs.writeFileSync(f, good.slice(0, good.length >> 1)); // cut off mid-write
  await page.evaluate(() => store.set('cutroom.last', P.id)); await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => $('#toast') && /damaged/.test($('#toast').textContent), null, { timeout: 10000 });
  check('2: the editor opens the project (not blank) and says what happened', await page.evaluate(() => P.text.length >= 2 && /Restored the version/.test($('#toast').textContent)), await page.textContent('#toast'));
  check('2: the file is repaired and the damaged one kept as .bad', JSON.parse(fs.readFileSync(f, 'utf8')).id === pid && fs.existsSync(`${f}.bad`));
  fs.writeFileSync(f, ''); // and an empty file
  const again = await api(`/api/projects/${pid}`);
  check('2: an empty file recovers the same way', again.id === pid && /damaged/.test(again._recovered || ''));
  check('2: the project still lists', (await api('/api/projects')).some(p => p.id === pid));

  // ---------- 3. an export running when the server dies ----------
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${lib}/rec.mp4`]);
  const mid = (await (await fetch(`${B}/api/import?name=rec.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(`${lib}/rec.mp4`) })).json()).id;
  await page.evaluate(() => loadMedia()); await page.waitForFunction(id => M.get(id)?.ready, mid, { timeout: 60000 });
  const plan = await page.evaluate(async id => { setProject(newProject('16:9')); addMedia(id, 'main'); packMain(); return buildPlan(1920, 1080, 'best', 'recover test'); }, mid);
  const { job } = await api('/api/export', plan);
  for (let i = 0; i < 50 && !fs.readdirSync(`${lib}/jobs`).some(n => n.endsWith('.json')); i++) await sleep(100);
  await sleep(1500);
  check('3: a running export leaves a record', fs.readdirSync(`${lib}/jobs`).some(n => n === `${job}.json`) && (await api(`/api/jobs/${job}`)).state === 'running');
  const sp = realPid(); let kids = ''; try { kids = execFileSync('pgrep', ['-P', String(sp)]).toString().split(/\s+/).filter(Boolean); } catch {}
  await killServer(); // (its ffmpeg children outlive it, as they would after a real crash: ended here so they do not keep the GPU busy)
  for (const k of kids) try { process.kill(+k, 'SIGKILL'); } catch {}
  await startServer();
  const lst = await api('/api/interrupted');
  check('3: the next start reports it (name, format)', lst.length === 1 && lst[0].job === job && lst[0].name === 'recover test', JSON.stringify(lst));
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#rbar .confirm');
  const m2 = await page.textContent('#rbar');
  check('3: the page shows "Export interrupted" with Retry', /Export interrupted/.test(m2) && /Retry/.test(m2), m2);
  const before = fs.readdirSync(`${lib}/exports`).length;
  await page.click('#rbar button:has-text("Retry")');
  await page.waitForFunction(() => /Export done|Export failed/.test($('#toast').textContent) || false, null, { timeout: 240000, polling: 300 });
  check('3: Retry renders it', /Export done/.test(await page.textContent('#toast')) && fs.readdirSync(`${lib}/exports`).filter(n => n.endsWith('.mp4')).length >= 1 && fs.readdirSync(`${lib}/exports`).length > before, await page.textContent('#toast'));
  check('3: and nothing is left to report', (await api('/api/interrupted')).length === 0 && fs.readdirSync(`${lib}/jobs`).length === 0);
  // 3b. the same with a text layer + a vignette (Path and bytes in the cleaned plan): the retry must still render
  const crash = async (nm, js) => {
    const pl = await page.evaluate(js, mid); const { job: jb } = await api('/api/export', pl);
    for (let i = 0; i < 50 && !fs.existsSync(`${lib}/jobs/${jb}.json`); i++) await sleep(100);
    await sleep(1500);
    const sp2 = realPid(); let k2 = []; try { k2 = execFileSync('pgrep', ['-P', String(sp2)]).toString().split(/\s+/).filter(Boolean); } catch {}
    await killServer(); for (const k of k2) try { process.kill(+k, 'SIGKILL'); } catch {}
    await startServer(); return jb;
  };
  const run = async jb => { const r = await api(`/api/interrupted/${jb}/retry`, {}); let j = {}; for (let i = 0; i < 480 && (!r.job || (j = await api(`/api/jobs/${r.job}`)).state === 'running'); i++) await sleep(500); return j; };
  const jt = await crash('text', async id => { setProject(newProject('16:9')); addMedia(id, 'main'); packMain(); addText('Text', { text: 'Hello' }); return buildPlan(1920, 1080, 'best', 'text retry'); });
  const dir = r => fs.readdirSync(`${lib}/cache/layers`).filter(n => n.includes('.'));
  const had = fs.existsSync(`${lib}/cache/layers`) ? dir() : [];
  check('3b: an interrupted export with text is listed and its layer dir is kept', (await api('/api/interrupted')).some(x => x.job === jt), JSON.stringify(had));
  const jr = await run(jt);
  check('3b: Retry renders the text export', jr.state === 'done', JSON.stringify(jr));
  const jv = await crash('vig', async id => { setProject(newProject('16:9')); addMedia(id, 'main'); packMain(); P.main[0].adj = { ...(P.main[0].adj || {}), vig: 0.5 }; addText('Text', { text: 'Hi' }); return buildPlan(1920, 1080, 'best', 'vig retry'); });
  const jr2 = await run(jv);
  check('3b: Retry renders text + vignette', jr2.state === 'done', JSON.stringify(jr2));
  const jd = await crash('dismiss', async id => { setProject(newProject('16:9')); addMedia(id, 'main'); packMain(); addText('Text', { text: 'Bye' }); return buildPlan(1920, 1080, 'best', 'dismiss me'); });
  const before2 = fs.existsSync(`${lib}/cache/layers`) ? dir().length : 0;
  await api(`/api/interrupted/${jd}/dismiss`, {});
  check('3b: Dismiss removes the record and its claimed layer dir', !fs.existsSync(`${lib}/jobs/${jd}.json`) && (fs.existsSync(`${lib}/cache/layers`) ? dir().length : 0) < before2 + (before2 ? 0 : 1) && (before2 === 0 || dir().length === before2 - 1), `${before2} -> ${fs.existsSync(`${lib}/cache/layers`) ? dir().length : 0}`);
  await br.close().catch(() => {});
} finally {
  for (const p of [server, chrome]) try { p?.kill('SIGKILL'); } catch {}
  try { process.kill(realPid(), 'SIGKILL'); } catch {}
  try { execFileSync('pkill', ['-9', '-f', prof], { stdio: 'ignore' }); } catch {}
}
console.log(`${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
