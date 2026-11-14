// Shared effect / transition files (.cutroom-fx): web/fxpack.js (fxFile, fxRegister), server.py (fx_check, /api/fx), the Import button,
// drag and drop, and the MCP import_fx command.
//  1. save: a built-in effect and transition become files; every built-in is accepted by the server's checker (the checker and the
//     compiler agree on the language) and the three examples/fx files import.
//  2. round trip: on a FRESH library (a second scratch server this test starts), the files imported through the button, a drop
//     and REMOTE.import_fx show up in the effects / transitions lists, survive a reload, and the applied copy exports the same
//     frames (the export renderer's still, byte for byte) as the built-in it was saved from.
//  3. removal: Remove from library empties the lists and the folder.
//  4. a malicious file is refused with a plain message and nothing is stored: unknown function, quotes / ; / other characters,
//     a name the compiler doesn't know, a bad version, too big a file, too long an expression, bracketed or reserved def names,
//     a def tower that doubles at every step (the compiler's budget stops it and the import is rolled back).
//   B=<server on a scratch library> node fx_share.mjs      (never 4610; it starts its own second server on B2PORT, default B's port + 1)
import { browser } from './browser.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B;
if (!B || /:4610\b/.test(B)) { console.log('SKIP: set B to a scratch server (never 4610)'); process.exit(0); }
const B2PORT = +(process.env.B2PORT || +new URL(B).port + 1), B2 = `http://127.0.0.1:${B2PORT}`, ROOT = fileURLToPath(new URL('../', import.meta.url));
const res = [], check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, sleep = ms => new Promise(r => setTimeout(r, ms));
const post = async (base, p, body) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (base, p) => (await fetch(base + p, { headers: { 'X-Cutroom': '1' } })).json();

const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-fxshare-`), lib2 = `${tmp}/lib2`;
fs.mkdirSync(lib2);
const srv = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', '-I', 'server.py'], { cwd: ROOT, env: { ...process.env, CUTROOM_HOME: lib2, CUTROOM_PORT: String(B2PORT) }, stdio: 'ignore' });
let browserH;
const done = code => { try { srv.kill(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
try {
  for (let i = 0; i < 50; i++) { try { await fetch(B2 + '/api/media'); break; } catch { await sleep(200); } }

  // two clips on each library
  const clips = {};
  for (const [k, vf] of [['A', ''], ['B', ',hue=h=140,negate']]) {
    clips[k] = `${tmp}/fxshare-${k}.mp4`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=4${vf}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', clips[k]]);
  }
  const upload = async base => { const o = {}; for (const k of ['A', 'B']) o[k] = (await (await fetch(`${base}/api/import?name=fxshare-${k}.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(clips[k]) })).json()).id; return o; };
  const idsA = await upload(B), idsB = await upload(B2);

  browserH = await browser.launch();
  const open = async (base, ids) => {
    const page = await (await browserH.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
    await page.route(u => u.pathname === '/api/remote/next', async r => { await sleep(15000); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
    page.errs = []; page.on('pageerror', e => page.errs.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0 && typeof FXSHARED !== 'undefined', null, { timeout: 20000 });
    await page.evaluate(() => loadMedia());
    await page.waitForFunction(ids => Object.values(ids).every(id => M.get(id)?.ready), ids, { timeout: 120000 });
    return page;
  };
  // the scene, built in the page from keys: one clip with an effect, or two clips with a transition; returns the export renderer's still
  const SCENE = `async ([ids, kind, key]) => {
    setProject(newProject('16:9')); P.name = 'fx share (scratch)'; S.sel = null; S.multi.clear();
    const main = id => { addMedia(id, 'main'); return P.main.at(-1); };
    let t;
    if (kind === 'fx') { main(ids.A); P.fx.push({ id: hex12(), fx: key, start: 0, dur: 3, amt: 1 }); t = 1.1; }
    else { main(ids.A).tr = { type: key, d: 1 }; main(ids.B); packMain(); t = P.main[1].start + 0.5 - 0.5 / P.fps; }
    packMain(); renderAll();
    return (await REMOTE.snapshot({ t, max: 640 })).image;
  }`;
  const still = (page, ids, kind, key) => page.evaluate(`(${SCENE})(${JSON.stringify([ids, kind, key])})`);

  // ---- 1 + 2: save on library A, import on a fresh library B
  const pa = await open(B, idsA);
  const BUILT = { effect: 'posterize', transition: 'wave' };
  const files = {};
  for (const [kind, key] of Object.entries(BUILT)) files[kind] = await pa.evaluate(([k, key]) => fxFile(k, key), [kind, key]);
  const orig = { effect: await still(pa, idsA, 'fx', BUILT.effect), transition: await still(pa, idsA, 'tr', BUILT.transition) };
  const parsed = Object.fromEntries(Object.entries(files).map(([k, t]) => [k, JSON.parse(t)]));
  check('save: a small versioned JSON file with name, kind, expressions, parameters, author', Object.values(parsed).every(d => d.cutroom_fx === 1 && d.name && d.kind && d.expressions?.e && 'parameters' in d && 'author' in d) && parsed.effect.kind === 'effect' && parsed.transition.kind === 'transition' && files.effect.length < 4096, `${files.effect.length} + ${files.transition.length} bytes`);
  check('save: the first library stays empty of imports', (await get(B, '/api/fx')).length === 0);
  const allBuilt = await pa.evaluate(() => [...Object.keys(EXF).map(k => ['effect', k]), ...Object.keys(TRX).map(k => ['transition', k])].map(([k, key]) => [k, key, fxFile(k, key)]));
  await pa.context().close();

  const pb = await open(B2, idsB);
  check('fresh library: no imported effects yet', (await get(B2, '/api/fx')).length === 0 && !(await pb.evaluate(() => Object.keys(FX).some(k => k.startsWith('u_')))));
  // the button: a file chosen in the effects tab
  fs.writeFileSync(`${tmp}/posterize.cutroom-fx`, files.effect);
  fs.writeFileSync(`${tmp}/wave.cutroom-fx`, files.transition);
  check('the Import effect file button is in the effects and transitions tabs', (await pb.locator('[data-fximport]').count()) === 2);
  await pb.locator('#fxFileIn').setInputFiles(`${tmp}/posterize.cutroom-fx`);
  await pb.waitForFunction(() => Object.keys(FX).some(k => k.startsWith('u_')), null, { timeout: 15000 });
  // a drop on the window
  await pb.evaluate(async t => {
    const dt = new DataTransfer(); dt.items.add(new File([t], 'wave.cutroom-fx', { type: '' }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files.transition);
  await pb.waitForFunction(() => TRANSITIONS.some(t => t[0].startsWith('u_')), null, { timeout: 15000 });
  const lists = await pb.evaluate(() => ({ fx: Object.entries(FX).filter(([k]) => k.startsWith('u_')).map(([k, d]) => [k, d.n]), tr: TRANSITIONS.filter(t => t[0].startsWith('u_')), opt: null }));
  const opts = await pb.evaluate(() => REMOTE.options());
  const [[fxKey, fxName]] = lists.fx, [[trKey, trName]] = lists.tr;
  check('imported effect and transition are in the lists next to the built-ins', fxName === 'Posterize' && trName === 'Wave' && opts.effects[fxKey] && opts.transitions.includes(trKey) && opts.effects.posterize && opts.transitions.includes('wave'), `${fxKey} ${trKey}`);
  await pb.evaluate(() => { G.fxCat = 'shared'; renderEffects(); renderTransitions(); });
  check('the gallery shows them (Imported chip, tiles)', (await pb.locator(`#fxGrid [data-fx="${fxKey}"]`).count()) === 1 && (await pb.locator(`#trGrid [data-trset="${trKey}"]`).count()) === 1 && (await pb.locator('#fxCats [data-fxcat="shared"]').count()) === 1);
  const got = { effect: await still(pb, idsB, 'fx', fxKey), transition: await still(pb, idsB, 'tr', trKey) };
  check('applied effect exports the same frame as the built-in it was saved from', got.effect === orig.effect && got.effect.length > 1000, `${got.effect.length} base64 chars`);
  check('applied transition exports the same frame as the built-in it was saved from', got.transition === orig.transition && got.transition.length > 1000, `${got.transition.length} base64 chars`);
  const mid = await still(pb, idsB, 'fx', 'u_000000000000');
  check('a clip using an effect that is not installed still renders (it is just not applied)', mid.length > 1000);

  // MCP/REMOTE command and the examples
  const ex = fs.readdirSync(`${ROOT}examples/fx`).filter(f => f.endsWith('.cutroom-fx'));
  const exRes = [];
  for (const f of ex) exRes.push(await pb.evaluate(t => REMOTE.import_fx({ text: t }), fs.readFileSync(`${ROOT}examples/fx/${f}`, 'utf8')).catch(e => ({ error: e.message })));
  check(`REMOTE.import_fx takes the ${ex.length} example files`, ex.length >= 2 && exRes.every(r => r.id?.startsWith('u_')), JSON.stringify(exRes.map(r => r.name || r.error)));
  const exStill = await still(pb, idsB, 'fx', exRes.find(r => r.kind === 'effect').id);
  check('an example effect renders', exStill.length > 1000 && exStill !== orig.effect);
  const exTr = await still(pb, idsB, 'tr', exRes.find(r => r.kind === 'transition').id);
  check('an example transition renders', exTr.length > 1000);

  // survives a reload
  await pb.reload({ waitUntil: 'load' });
  await pb.waitForFunction(() => typeof FXSHARED !== 'undefined' && FXSHARED.size > 0 && typeof P !== 'undefined' && P, null, { timeout: 20000 });
  check('imported files survive a reload', (await pb.evaluate(() => FXSHARED.size)) === 2 + exRes.length && (await get(B2, '/api/fx')).length === 2 + exRes.length);
  check('the saved copy of an imported effect round-trips to the same id', await pb.evaluate(async k => { const t = fxFile('effect', k); const d = await api('/api/fx', { text: t }); return `u_${d.id}` === k; }, fxKey));

  // ---- 3: removal
  await pb.evaluate(([a, b]) => { S.sel = null; return Promise.all([fxRemove(a), fxRemove(b)]); }, [fxKey, trKey]);
  for (const r of exRes) await pb.evaluate(k => fxRemove(k), r.id);
  check('removal: gone from the lists and the library folder', !(await pb.evaluate(() => Object.keys(FX).some(k => k.startsWith('u_')) || TRANSITIONS.some(t => t[0].startsWith('u_')))) && (await get(B2, '/api/fx')).length === 0 && !fs.readdirSync(`${lib2}/fx`).some(f => f.endsWith('.cutroom-fx')));
  check('removal: kept in the trash (reversible)', fs.readdirSync(`${lib2}/trash/fx`).length >= 2);

  // ---- 1b: every built-in is accepted by the server's checker, then compiled by the page
  const bad = [];
  for (const [kind, key, text] of allBuilt) { const r = await post(B2, '/api/fx', { text }); if (!r.ok) bad.push(`${kind} ${key}: ${r.j.error}`); else await post(B2, `/api/fx/${r.j.id}/trash`, {}); }
  check(`all ${allBuilt.length} built-in effects and transitions pass the server's checker`, !bad.length, bad.slice(0, 3).join(' | '));

  // ---- 4: malicious files
  const mk = (over = {}, ex = {}) => JSON.stringify({ cutroom_fx: 1, name: 'x', kind: 'effect', author: '', parameters: {}, expressions: { defs: {}, e: 's(X,Y)', ...ex }, ...over });
  const E = 's(X,Y)';
  const evil = {
    'unknown function': mk({}, { e: 'system(1)' }),
    'a quote to leave the filter option': mk({}, { e: `${E}'` }),
    'a semicolon (geq st/ld)': mk({}, { e: `st(0,1);${E}` }),
    'a colon (a second filter option)': mk({}, { e: `${E}:r=0` }),
    'a name the compiler does not know': mk({}, { e: `${E}*foo` }),
    'a transition-only fetch in an effect': mk({}, { e: 'a(X,Y)' }),
    'JS in a name': mk({}, { e: 'constructor(1)' }),
    'a bracket / backtick': mk({}, { e: '`${1}`' }),
    'a unicode lookalike name': mk({}, { e: 'ｓ(X,Y)' }),
    'a def that calls an unknown function': mk({}, { defs: { q: 'readFile(1)' }, e: 'q' }),
    'a bracketed def name (a macro)': mk({}, { defs: { 'f(x)': 'x' }, e: 'f(1)' }),
    'a def named like a built-in': mk({}, { defs: { sin: '1' }, e: 'sin(1)' }),
    'a def with a quote in its name': mk({}, { defs: { "q'": '1' }, e: '1' }),
    'unbalanced brackets': mk({}, { e: '(s(X,Y)' }),
    'an expression over the length cap': mk({}, { e: `${'1+'.repeat(3000)}1` }),
    'a file over the size cap': mk({ author: 'x'.repeat(70000) }),
    'a newer format': mk({ cutroom_fx: 2 }),
    'not JSON': 'function(){ return 1 }',
    'a JSON array': '[1,2,3]',
    'an unknown kind': mk({ kind: 'script' }),
    'a parameter that is not a number': mk({ parameters: { k: '1+1' } }, {}),
    'a parameter named like a built-in': mk({ parameters: { X: 1 } }, {}),
    'a missing name': mk({ name: '' }),
    'HTML in the name': mk({ name: '<img src=x onerror=window.__pwn=1>' }),
    'HTML in the author': mk({ author: '"><script>1</script>' }),
  };
  const refused = [];
  for (const [what, text] of Object.entries(evil)) {
    const r = await post(B2, '/api/fx', { text });
    const plain = typeof r.j.error === 'string' && r.j.error.length > 8 && r.j.error.length < 300 && !/Traceback|File "/.test(r.j.error);
    if (r.ok || r.status !== 400 || !plain) refused.push(`${what}: ${r.status} ${r.j.error || 'ACCEPTED'}`);
  }
  check(`${Object.keys(evil).length} malicious files are refused with a plain message`, !refused.length, refused.slice(0, 3).join(' | '));
  check('refused files left nothing in the library', (await get(B2, '/api/fx')).length === 0 && !fs.readdirSync(`${lib2}/fx`).some(f => f.endsWith('.cutroom-fx')));
  // a file edited by hand on disk into something unsafe is never served or registered
  fs.writeFileSync(`${lib2}/fx/aaaaaaaaaaaa.cutroom-fx`, mk({}, { e: 'system(1)' }));
  check('an unsafe file placed in the folder by hand is not listed', (await get(B2, '/api/fx')).length === 0);
  fs.rmSync(`${lib2}/fx/aaaaaaaaaaaa.cutroom-fx`);
  // a doubling tower passes the token check but the compiler's budget stops it; the page rolls the import back
  const tower = { defs: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`d${i}`, i ? `d${i - 1}*d${i - 1}+sin(d${i - 1})` : 'X'])), e: 's(X,Y)*d29' };
  const t0 = Date.now(), tr = await pb.evaluate(t => importFxText(t).then(() => 'imported', e => e.message), mk({}, tower));
  check('a def tower that doubles each step is refused by the compiler (and rolled back)', /too complex/.test(tr) && (await get(B2, '/api/fx')).length === 0 && Date.now() - t0 < 10000, `${tr} in ${Date.now() - t0} ms`);
  // the button's own size cap
  fs.writeFileSync(`${tmp}/big.cutroom-fx`, mk({ author: 'x'.repeat(70000) }));
  await pb.locator('#fxFileIn').setInputFiles(`${tmp}/big.cutroom-fx`);
  await pb.waitForFunction(() => /too big/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => {});
  check('the Import button refuses a big file before reading it', (await get(B2, '/api/fx')).length === 0 && /too big/.test(await pb.evaluate(() => document.body.innerText)));
  // page layer: even if a hostile name got past the server, the transition inspector must not build elements from it
  const xss = await pb.evaluate(() => {
    const k = Object.keys(TRX)[0], d = JSON.parse(fxFile('transition', k));
    d.name = '<img src=x onerror=window.__pwn=1>'; d.id = 'xss000000001';
    fxRegister(d);
    setProject(newProject('16:9')); const c = { media: 'm', tr: { type: 'u_xss000000001' } }; P.main.push(c);
    const box = document.createElement('div'); box.innerHTML = trPanel(c); fxUnregister('u_xss000000001');
    return { img: !!box.querySelector('img'), btns: box.querySelectorAll('button[data-tr]').length };
  });
  check('a hostile transition name is escaped in the inspector (no element created)', !xss.img && xss.btns > 0, JSON.stringify(xss));
  check('no page errors', !pb.errs.length, pb.errs.slice(0, 3).join(' | '));
} catch (e) {
  check('test ran to the end', false, String(e.stack || e).split('\n').slice(0, 3).join(' | '));
}
await browserH?.close().catch(() => {});
console.log(`${res.filter(Boolean).length}/${res.length} passed`);
done(res.every(Boolean) && res.length ? 0 : 1);
