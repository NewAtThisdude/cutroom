// Batch editing, in headless WebKit, both motion modes. Five short synthetic videos with two silences each (tone 1 s,
// silence 1 s, tone 1 s, silence 1.2 s, tone 1.2 s) plus a sixth whose file is broken after import:
//   no-preference: the Batch window, "Select this import", a recipe of trim silences + loudness -14 + 9:16 and 16:9 at 720p,
//   saved, then run: five projects named after their videos, ten files (720x1280 and 1280x720, each shortened by the
//   silences, about -14 LUFS), the broken one failed alone, every export rendered one after another. After a reload the
//   saved recipe fills the window again.
//   reduce: REMOTE.batch with the saved recipe's name on three videos, the 2nd cancelled from its row: the other two finish.
//   Then a run with no exports (shapes []) of template + captions + brand: the template's edit with the video in its slot,
//   captions from speech-to-text STUBBED here (the page's /api/transcribe answered by the test: no whisper runs), styled,
//   and the brand kit step skipped with its reason when this version has none.
//   CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port> node batch.mjs   (never 4610)
import { webkit } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4753', HOME = process.env.CUTROOM_HOME, OUT = process.env.CUTROOM_SCRATCH || os.tmpdir();
if (!HOME || /:4610\b/.test(B)) throw new Error('run on a scratch server: CUTROOM_HOME=<scratch lib> B=http://127.0.0.1:<port>');
const EXP = `${HOME}/exports`, res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (path, body) => (await fetch(B + path, body ? { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'X-Cutroom': '1' } })).json();
const ff = (bin, args) => execFileSync(bin, args, { maxBuffer: 1 << 28 });
const probe = f => JSON.parse(ff('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).toString());
const lufs = f => +(spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/I:\s+(-?[\d.]+) LUFS/g)?.at(-1).match(/-?[\d.]+/)[0] ?? 0);

// five 5.2 s videos: tone 0-1, silence 1-2, tone 2-3, silence 3-4.2, tone 4.2-5.2 (a different picture and pitch each)
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-batch-`), tag = Math.random().toString(36).slice(2, 7), D = 5.2;
const files = [1, 2, 3, 4, 5, 6].map(i => {
  const f = `${tmp}/batch-${tag}-${i}.mp4`;
  ff('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${D}`, '-f', 'lavfi', '-i', `sine=f=${300 + i * 70}:d=${D}:sample_rate=48000`,
    '-af', "volume=0:enable='between(t,1,2)+between(t,3,4.2)'", '-vf', `hue=h=${i * 50}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
  return f;
});
const up = async f => (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json());
const media = [];
for (const f of files) media.push(await up(f));
const ids = media.map(m => m.id), good = ids.slice(0, 5), broken = media[5];
for (let i = 0; i < 120 && !(await api('/api/media')).filter(m => ids.includes(m.id)).every(m => m.ready); i++) await new Promise(r => setTimeout(r, 500));
fs.writeFileSync(`${HOME}/media/${broken.file}`, Buffer.alloc(4096, 7)); // broken after import: the library item is there, its file is junk
check('six videos imported', media.every(m => m.id && m.kind === 'video'), media.map(m => m.name).join(', '));

const expect = D - 0.8 - 1.0; // the two pauses less Remove pauses' 0.1 s of air on each side
const b = await webkit.launch(), made = [], projects = [];
let recipeId = null;
const jobsOf = items => items.flatMap(it => it.steps.filter(s => s.q).map(s => s.q.job));
const settled = async (page, timeout = 600000) => page.waitForFunction(() => !BATCH.running, null, { timeout, polling: 500 });
async function inOrder(page, label) { // each export starts after the one before it ended (the server's times)
  const js = await Promise.all((await page.evaluate(() => BATCH.items.flatMap(it => it.steps.filter(s => s.q).map(s => s.q.job)))).map(j => api(`/api/jobs/${j}`)));
  const ran = js.filter(j => j.started).sort((a, c) => a.started - c.started), gaps = ran.slice(1).map((j, i) => j.started - ran[i].ended);
  check(`${label}: renders one after another`, ran.length > 1 && ran.every(j => j.ended) && gaps.every(g => g >= -0.01), `${ran.length} renders, gaps ${gaps.map(g => g.toFixed(2)).join(', ')} s`);
}
async function filesOk(label, rows) { // a done video: its project and two files of the right size, shorter by the pauses
  for (const r of rows) {
    const p = await api(`/api/projects/${r.project}`);
    projects.push(r.project);
    check(`${label} ${r.name}: its project, named after it, the pauses cut`, p.name === r.name.replace(/\.mp4$/, '') && p.main?.length === 3 && p.main.every(c => c.media === r.media), `"${p.name}", ${p.main?.length} main clips`);
    for (const x of r.files) {
      const f = `${EXP}/${x.file}`, j = probe(f), v = j.streams.find(s => s.codec_type === 'video'), d = +j.format.duration, L = lufs(f);
      const [w, h] = x.shape === '9:16' ? [720, 1280] : [1280, 720];
      made.push(f);
      check(`${label} ${r.name} ${x.shape}: ${w}x${h}, ${expect.toFixed(1)} s (from ${D}), -14 LUFS`, v.width === w && v.height === h && Math.abs(d - expect) < 0.2 && Math.abs(L + 14) < 1.5, `${v.width}x${v.height}, ${d.toFixed(2)} s, ${L} LUFS`);
    }
  }
}

for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const open = async () => {
    await page.goto(`${B}/`, { waitUntil: 'load' });
    await page.waitForFunction(ids => typeof P !== 'undefined' && P && ids.every(id => M.has(id)), ids, { timeout: 30000 });
    await page.evaluate(() => { $('#tour')?.remove(); });
  };
  await open();
  const ev = (f, a) => page.evaluate(f, a);

  if (rm === 'no-preference') {
    await page.click('#btnBatch'); await page.waitForSelector('#bList');
    await page.click('[data-bimport="0"]');
    const picked = await ev(() => $$('#bList input:checked').map(x => x.value));
    check('window: "Select this import" ticks the six just imported', ids.every(x => picked.includes(x)), `${picked.length} ticked`);
    await ev(ids => { for (const x of $$('#bList input:checked')) if (!ids.includes(x.value)) x.click(); }, ids); // (an earlier run within 2 minutes is the same import)
    check('window: the brand kit says why it is off (or is offered)', await ev(() => (typeof applyBrand === 'function') === !$('#bs_brand').disabled));
    await page.check('#bs_pauses'); await page.uncheck('#bs_captions'); await page.check('#bs_loudness'); await page.selectOption('#bLufs', '-14');
    await page.check('#bShapes input[value="9:16"]'); await page.check('#bShapes input[value="16:9"]');
    await page.selectOption('#bRes', '720p'); await page.selectOption('#bMin', '0.5');
    await page.fill('#bName', `Batch test ${tag}`); await page.click('#bSave');
    await page.waitForFunction(() => /Saved/.test($('#bStatus').textContent));
    recipeId = await ev(() => $('#bRecipe').value);
    check('window: the recipe is saved and selected', /^[a-f0-9]{12}$/.test(recipeId) && (await api('/api/batch/recipes')).some(r => r.id === recipeId && r.shapes.join() === '9:16,16:9'));
    await page.click('#bGo');
    await page.waitForFunction(() => BATCH.running && $$('#bRun .brun').length === 6, null, { timeout: 30000 });
    await page.waitForFunction(() => BATCH.items.some(it => it.steps.some(s => s.q)), null, { timeout: 60000 });
    await page.screenshot({ path: `${OUT}/batch-${rm}.png` });
    await settled(page);
    const st = await ev(() => BATCH.items.map(it => ({ media: it.media, name: it.name, state: it.state, error: it.error, project: it.project, say: it.el.querySelector('small').textContent,
      steps: it.steps.map(s => [s.name, s.state, s.el.textContent]), files: it.steps.filter(s => s.kind === 'export' && s.state === 'done').map(s => ({ shape: s.shape, file: s.q.st.file })) })));
    const ok = st.filter(x => x.state === 'done'), bad = st.find(x => x.media === broken.id);
    check('run: five done, the broken one failed alone', ok.length === 5 && ok.every(x => good.includes(x.media)) && bad?.state === 'failed', st.map(x => `${x.name.replace(`batch-${tag}-`, '#')} ${x.state}`).join(' | '));
    check('run: the failure says what failed, on its own row', bad && /^Failed: /.test(bad.say) && bad.steps.some(s => s[1] === 'failed'), bad?.say);
    check('run: every step shown per video (trim, loudness, two exports)', ok.every(x => x.steps.map(s => s[0]).join() === 'Trim silences,Loudness,Export 9:16,Export 16:9' && x.steps.every(s => s[1] === 'done')), ok[0]?.steps.map(s => s[2]).join(' | '));
    check('run: ten files', ok.reduce((n, x) => n + x.files.length, 0) === 10);
    await filesOk(rm, ok);
    await inOrder(page, rm);
    check('window: Run is back, Cancel all hidden', await ev(() => !$('#bGo').disabled && $('#bCancelAll').hidden));
    await page.screenshot({ path: `${OUT}/batch-${rm}-done.png` });
    // the saved recipe in a freshly loaded editor (a second page: navigating this one away sends its poster with keepalive,
    // which headless WebKit reports as an error of its own)
    await page.keyboard.press('Escape');
    const p2 = await ctx.newPage();
    p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(`${B}/`, { waitUntil: 'load' });
    await p2.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
    await p2.evaluate(() => { $('#tour')?.remove(); });
    await p2.click('#btnBatch'); await p2.waitForSelector('#bList');
    const f = await p2.evaluate(() => ({ sel: $('#bRecipe').value, form: bForm() }));
    check('reload: the saved recipe fills the window', f.form.steps.map(s => s.step).join() === 'pauses,loudness' && f.form.shapes.join() === '9:16,16:9' && f.form.res === '720p' && f.form.steps[1].lufs === -14 && f.sel === recipeId,
      JSON.stringify(f.form));
    await p2.screenshot({ path: `${OUT}/batch-${rm}-reload.png` });
    await p2.keyboard.press('Escape');
  } else {
    // REMOTE.batch by the recipe's name; the 2nd video cancelled from its row in the window
    const run = ev(([v, name]) => { window.__b = REMOTE.batch({ media: v, recipe: name }); return true; }, [good.slice(0, 3), `Batch test ${tag}`]);
    await run;
    await page.waitForFunction(() => BATCH.running && BATCH.items.length === 3, null, { timeout: 30000 });
    await page.click('#btnBatch'); await page.waitForSelector('#bRun .brun [data-bcancel="1"]');
    await page.click('#bRun .brun [data-bcancel="1"]');
    await page.screenshot({ path: `${OUT}/batch-${rm}.png` });
    const r = await ev(() => window.__b);
    check('REMOTE.batch: 1st and 3rd done, the cancelled 2nd has no files', r.done === 2 && r.cancelled === 1 && r.videos[1].state === 'cancelled' && !r.videos[1].files.length && r.videos[0].files.length === 2 && r.videos[2].files.length === 2,
      r.videos.map(x => `${x.state} ${x.files.length} files`).join(' | '));
    check('REMOTE.batch: per-video results with each step', r.videos[0].steps.map(s => s.step).join() === 'pauses,loudness,export 9:16,export 16:9' && r.videos[0].files.every(x => /^\d+x\d+$/.test(x.size)), JSON.stringify(r.videos[0].steps));
    await filesOk(rm, r.videos.filter(x => x.state === 'done'));
    if (r.videos[1].project) projects.push(r.videos[1].project);
    await inOrder(page, rm);
    // template + captions (speech-to-text stubbed) + brand, no exports
    const words = [{ w: 'Hello', s: 0.1, e: 0.5 }, { w: 'there.', s: 0.55, e: 0.9 }, { w: 'Batch', s: 2.2, e: 2.6 }, { w: 'works', s: 2.65, e: 2.95 }];
    let asked = 0;
    await page.route('**/api/transcribe', route => { asked++; route.fulfill({ contentType: 'application/json', body: JSON.stringify({ words }) }); });
    const tid = 'b0' + Math.random().toString(16).slice(2, 12).padEnd(10, '0');
    await fetch(`${B}/api/templates/${tid}`, { method: 'PUT', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tid, name: `Batch tpl ${tag}`, w: 1080, h: 1080,
      slots: [{ kind: 'video', name: 'x', need: 5 }], project: { w: 1080, h: 1080, fps: 30, main: [{ id: 'a00000000001', media: 'slot:0', start: 0, in: 0, out: 5.2, speed: 1, volume: 1, fit: 'fill', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } }],
        overlay: [], audio: [], text: [{ id: 'a00000000002', start: 0, dur: 2, text: 'From the template', style: {} }], captions: [], fx: [], markers: [] } }) });
    const t = await ev(([v, tid]) => REMOTE.batch({ media: [v], recipe: { steps: [{ step: 'captions', style: 'Boxed', lang: 'en' }, 'brand', { step: 'template', id: tid }, 'pauses'], shapes: [] } }), [good[3], tid]);
    const v = t.videos[0], p = v.project && await api(`/api/projects/${v.project}`);
    if (v.project) projects.push(v.project);
    const brandOn = await ev(() => typeof applyBrand === 'function');
    check('template first, whatever the order: 1:1, its title, the video in its slot', p && p.w === 1080 && p.h === 1080 && p.text?.[0]?.text === 'From the template' && p.main.every(c => c.media === good[3]), p && `${p.w}x${p.h}, ${p.main.length} main, text "${p.text?.[0]?.text}"`);
    check('captions from the (stubbed) transcript, styled', asked >= 1 && p?.captions.length >= 2 && p.capStyle?.box === true && v.steps.find(s => s.step === 'captions').state === 'done', `${asked} transcribe calls, ${p?.captions.length} captions: ${p?.captions.map(c => c.text).join(' / ')}`);
    check('brand kit: skipped with its reason when there is none', brandOn || v.steps.find(s => s.step === 'brand')?.state === 'skipped' && /brand/.test(v.steps.find(s => s.step === 'brand').note), JSON.stringify(v.steps));
    check('the step order: template, pauses, captions, brand', v.steps.map(s => s.step).join() === 'template,pauses,captions,brand' && v.state === 'done' && !v.files.length, v.steps.map(s => `${s.step} ${s.state}`).join(', '));
    await fetch(`${B}/api/templates/${tid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: '{}' });
    // the editor's own Remove pauses and Auto captions, which now share their code with the batch (whisper still stubbed)
    const e = await ev(async v => {
      await REMOTE.new_project({ ratio: '16:9', name: 'Batch shared paths' }); await REMOTE.add_clip({ media: v });
      const rp = await REMOTE.remove_pauses({ min: 0.5 }); await REMOTE.auto_captions({ lang: 'en', words: 3 });
      return { rp, caps: P.captions.map(c => [c.text, +c.start.toFixed(2), c.words.length]), id: P.id };
    }, good[4]);
    projects.push(e.id);
    check('Remove pauses (shared silenceMap): 1.8 s out, three clips', Math.abs(e.rp.removedSeconds - 1.8) < 0.05 && e.rp.clips === 3, JSON.stringify(e.rp));
    check('Auto captions (shared capsFromWords): two lines, words placed through the cut', e.caps.length === 2 && e.caps[0][0] === 'Hello there.' && e.caps[1][0] === 'Batch works' && Math.abs(e.caps[1][1] - (2.2 - 0.8)) < 0.05, JSON.stringify(e.caps));
    const bad = await ev(() => REMOTE.batch({ media: ['x'], recipe: { steps: ['nope'] } }).then(() => '', e => e.message));
    check('REMOTE.batch: a wrong step is refused with the valid ones', /steps must be of template, pauses, captions, loudness, brand/.test(bad), bad);
  }
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}
await b.close();
if (recipeId) await api(`/api/batch/recipes/${recipeId}/delete`, {});
for (const id of new Set(projects)) await api(`/api/projects/${id}/trash`, {}).catch(() => {});
for (const f of made) fs.rmSync(f, { force: true });
fs.rmSync(tmp, { recursive: true, force: true });
const bad = res.filter(x => !x).length;
console.log(`\n${res.length - bad}/${res.length} passed`);
process.exit(bad ? 1 : 0);
