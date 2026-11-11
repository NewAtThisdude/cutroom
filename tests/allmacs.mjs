// Every Mac: each AI / heavy feature on servers that act as smaller Macs (CUTROOM_RAM_GB=8 and 16, CUTROOM_CORES=8; "36" = this
// Mac as it is). Each job must either run within its budget (server.py AI_BUDGET, the tier /api/ai/caps names for that Mac) or be
// refused with the reason; never an out-of-memory failure, never a swap storm (vm_stat pageouts during the job). Measured per job:
// seconds, load average, the peak memory of the server's process tree (+ Ollama's runner): the most they held at once, or
// one process's own phys_footprint peak if higher (GPU memory included), from `footprint`. Also: two heavy jobs at once queue on every Mac, a long job carries a time
// estimate, the server + an open editor page idle for 60 s use ~0 % CPU and GPU, and the AI tab's "This Mac" panel renders
// (both reduced-motion modes, nothing overflowing).
//   node tests/allmacs.mjs [rams, default 8,16] [feature names, a regex: 'remove|interp|idle']     results: tests/out/allmacs.json
// STRICTLY one job at a time: before each heavy job the GPU must be under 20 % for 10 s (ioreg AGXAccelerator); one server
// at a time (ports 4813, 4814; scratch libraries); never 4610. The jobs run on THIS Mac's hardware: memory sizes are the
// smaller Mac's, times are this Mac's (the panel scales its estimates by GPU cores).
import { webkit } from 'playwright';
import { execFileSync, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const REPO = new URL('..', import.meta.url).pathname, OUT = new URL('./out/', import.meta.url).pathname;
const SCR = process.env.SCR || '/private/tmp/claude-501/-Users-marat/827eb4bf-5aee-4497-950b-e90b10220711/scratchpad';
const RAMS = (process.argv[2] || '8,16').split(',').map(Number), only = process.argv[3], want = n => !only || new RegExp(`^(${only})$`).test(n);
const FIX = `${SCR}/allmacs-fixtures`, PAGE = 16384, SWAP_MB = 256; // a job may page out at most this much (other agents share this Mac)
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const res = [], rows = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ff = (out, args) => { if (!fs.existsSync(`${FIX}/${out}`)) execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, `${FIX}/${out}`]); return `${FIX}/${out}`; };

// ---------- fixtures (made once, kept in the scratchpad) ----------
if (!fs.existsSync(`${FIX}/speech.aiff`)) execFileSync('say', ['-v', 'Samantha', '-o', `${FIX}/speech.aiff`, 'Welcome back to the channel. Today we test every Mac, from eight gigabytes to thirty six. ' +
  'The editor picks a model that fits, or it tells you why it cannot. Nothing is uploaded, and nothing swaps.']);
const MIX = ff('mix.m4a', ['-i', `${FIX}/speech.aiff`, '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*55*t)*exp(-12*mod(t,0.5))+0.08*sin(2*PI*220*t)+0.06*sin(2*PI*277*t)':s=44100:d=10",
  '-filter_complex', '[0]aresample=44100,apad[a];[a][1]amix=inputs=2:duration=shortest:normalize=0', '-t', '10', '-c:a', 'aac', '-b:a', '192k']);
const TALK = ff('talk.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-i', `${FIX}/speech.aiff`, '-af', 'apad', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
// a red box moving over a still picture, 1080p30 (remove, cut out, track, slow-mo, relight)
const V = ff('box1080.mp4', ['-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080:r=30:d=3', '-vf', "noise=alls=12:allf=p,drawbox=x='400+200*t':y=380:w=260:h=260:color=red@1:t=fill",
  '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']);
const SMALL = ff('small540.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=960x540:r=30:d=1', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']);
const V4K = ff('uhd60.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=60:d=2', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p']);
if (!fs.existsSync(`${FIX}/face.png`)) { // a face for Retouch: Z-Image on this Mac, once (the same tool as Generate image)
  const env = { ...process.env, VIRTUAL_ENV: `${REPO}ai/.venv`, PATH: `${REPO}ai/.venv/bin:${process.env.PATH}` };
  delete env.PYTHONPATH;
  execFileSync(`${REPO}ai/.venv/bin/mflux-generate-z-image-turbo`, ['--model', `${os.homedir()}/Movies/Cutroom/ai/z-image-turbo-4bit`, '--prompt', 'passport photo of a smiling woman, face centred, looking at the camera, plain background, soft light',
    '--width', '768', '--height', '768', '--steps', '8', '--seed', '7', '--output', `${FIX}/face.png`], { env, stdio: 'ignore' });
}
const FACE = ff('face.mp4', ['-loop', '1', '-i', `${FIX}/face.png`, '-vf', "zoompan=z='1+0.002*on':d=1:s=720x720:fps=30", '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

// ---------- memory: the server's process tree (+ Ollama's model runner), by footprint ----------
function tree(root) {
  const ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().trim().split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kids = new Map();
  for (const [, p, pp] of ps) kids.set(+pp, [...(kids.get(+pp) || []), +p]);
  const out = new Set([root]);
  for (const p of out) for (const k of kids.get(p) || []) out.add(k);
  for (const [, p, , cmd] of ps) if (/ollama runner|ollama\/llama-server/.test(cmd)) out.add(+p); // shared with anything else using Ollama on this Mac
  return [...out];
}
const foot = pids => new Promise(r => execFile('footprint', ['-f', 'bytes', '--noCategories', ...pids.flatMap(p => ['-p', String(p)])], { maxBuffer: 1 << 24 }, (_e, so) => {
  const m = new Map();
  for (const b of String(so || '').matchAll(/\[(\d+)\]:[\s\S]*?phys_footprint: (\d+) B\s+phys_footprint_peak: (\d+) B/g)) m.set(+b[1], { cur: +b[2], peak: +b[3] });
  r(m);
}));
const gpuUtil = () => +(execFileSync('ioreg', ['-r', '-d', '1', '-c', 'AGXAccelerator']).toString().match(/"Device Utilization %"=(\d+)/)?.[1] ?? 0);
async function gpuQuiet(maxS = 900) { // under 20 % for 10 s in a row (the Mac overheated when GPU jobs stacked up)
  const t0 = Date.now();
  for (let ok = 0; ok < 10;) {
    if (Date.now() - t0 > maxS * 1000) throw new Error(`the GPU stayed busy for ${maxS} s (${gpuUtil()} %): not starting another job`);
    ok = gpuUtil() < 20 ? ok + 1 : 0;
    await sleep(1000);
  }
}
const cpuSecs = pids => { // cumulative CPU seconds of these processes (ps time = [h:]m:ss.cc)
  if (!pids.length) return 0;
  let out = '';
  try { out = execFileSync('ps', ['-o', 'time=', '-p', pids.join(',')]).toString(); } catch (e) { out = String(e.stdout || ''); }
  return out.trim().split(/\s+/).filter(Boolean).reduce((a, t) => a + t.split(':').reduce((x, y) => x * 60 + +y, 0), 0);
};
const pageouts = () => +execFileSync('vm_stat').toString().match(/Pageouts:\s+(\d+)/)[1];
async function measured(root, fn) { // [result | error, seconds, peak GB, pageouts MB, load average]
  const base = await foot(tree(root)), seen = new Map(), names = new Map(), po = pageouts(), t0 = Date.now(), load = os.loadavg()[0];
  let on = true, together = 0, llmGB = 0; // llmGB: Ollama's own count of its loaded models (llama.cpp maps its weights: footprint misses them)
  const sampler = (async () => {
    while (on) {
      const pids = tree(root);
      for (const p of pids) if (!names.has(p)) try { names.set(p, execFileSync('ps', ['-o', 'command=', '-p', String(p)]).toString().trim().split(/\s+/).filter(w => !w.startsWith('-')).slice(0, 2).map(w => path.basename(w)).join(' ')); } catch {}
      let sum = 0;
      for (const [p, f] of await foot(pids)) {
        const s = seen.get(p) || { cur: 0, peak: 0 }, b0 = base.get(p);
        seen.set(p, { cur: Math.max(s.cur, f.cur), peak: Math.max(s.peak, b0 ? f.cur - b0.cur : f.peak) });
        sum += Math.max(0, f.cur - (b0?.cur || 0));
      }
      together = Math.max(together, sum);
      try { llmGB = Math.max(llmGB, ((await (await fetch('http://127.0.0.1:11434/api/ps')).json()).models || []).reduce((a, m) => a + (m.size || 0), 0) / 2 ** 30); } catch {}
      await sleep(300);
    }
  })();
  let out;
  try { out = { ok: await fn() }; } catch (e) { out = { err: e.message }; }
  on = false;
  await sampler;
  // the job's peak: the most its processes held at the same moment (sampled every ~0.3 s), or one process's own exact peak
  // (phys_footprint_peak) when that is higher. Summing every process's peak overcounted retries and steps that run in turn.
  let peak = Math.max(together, llmGB * 2 ** 30);
  const by = [];
  for (const [p, s] of seen) { const g = Math.max(0, s.peak); peak = Math.max(peak, g); by.push([g, names.get(p) || p]); }
  const top = by.sort((a, b) => b[0] - a[0]).slice(0, 3).filter(x => x[0] > 0.2 * 2 ** 30).map(([g, n]) => `${n} ${(g / 2 ** 30).toFixed(2)}`).join(', ');
  return { ...out, secs: (Date.now() - t0) / 1000, gb: peak / 2 ** 30, top, swapMB: (pageouts() - po) * PAGE / 2 ** 20, load: (load + os.loadavg()[0]) / 2 };
}

// ---------- one server per Mac size ----------
async function server(ram, port) {
  const env = { ...process.env, CUTROOM_HOME: `${SCR}/lib-allmacs-${ram}`, CUTROOM_PORT: String(port) };
  delete env.PYTHONPATH;
  delete env.CUTROOM_RAM_GB;
  delete env.CUTROOM_CORES;
  if (ram !== 36) Object.assign(env, { CUTROOM_RAM_GB: String(ram), CUTROOM_CORES: '8' });
  // a fresh scratch library each run: cached transcripts / stems / outlines would measure nothing. The ai link (the image
  // model, read only) is unlinked first so nothing can follow it into ~/Movies/Cutroom.
  try { if (fs.lstatSync(`${env.CUTROOM_HOME}/ai`).isSymbolicLink()) fs.unlinkSync(`${env.CUTROOM_HOME}/ai`); } catch {}
  if (!env.CUTROOM_HOME.startsWith(SCR)) throw new Error('scratch libraries only');
  fs.rmSync(env.CUTROOM_HOME, { recursive: true, force: true });
  fs.mkdirSync(env.CUTROOM_HOME, { recursive: true });
  if (!fs.existsSync(`${env.CUTROOM_HOME}/ai`)) fs.symlinkSync(`${os.homedir()}/Movies/Cutroom/ai`, `${env.CUTROOM_HOME}/ai`); // the image model's weights (read only)
  const p = spawn('python3', ['-I', 'server.py'], { cwd: REPO, env, stdio: ['ignore', 'ignore', fs.openSync(`${SCR}/allmacs-${ram}.log`, 'w')] });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${B}/api/ping`); return { p, B }; } catch { await sleep(200); } }
  throw new Error(`the ${ram} GB server did not start (${SCR}/allmacs-${ram}.log)`);
}

const results = {}, idle = {};
for (const [i, ram] of RAMS.entries()) {
  const { p: srv, B } = await server(ram, 4813 + i), H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
  const api = async (u, body) => { const r = await (await fetch(B + u, { method: 'POST', headers: H, body: JSON.stringify(body) })).json(); if (r.error) throw new Error(r.error); return r; };
  const get = async u => (await fetch(B + u)).json();
  const job = async (u, body, seen) => { // to the end; seen(state) gets every poll
    const { job: j } = await api(u, body);
    for (;;) { await sleep(400); const s = await get(`/api/jobs/${j}`); seen?.(s); if (s.state === 'done') return s; if (s.state !== 'running') throw new Error(s.error || s.state); }
  };
  const imp = async (f, wait = true) => { const m = await api('/api/import_path', { path: f }); while (wait && !(await get('/api/media')).find(x => x.id === m.id)?.ready) await sleep(300); return m; };
  try {
    const caps = await get('/api/ai/caps'), cap = k => caps.jobs.find(j => j.kind === k);
    console.log(`\n=== ${ram === 36 ? 'this Mac' : `as a ${ram} GB Mac`}: ${caps.ram} GB, ${caps.cores} cores, ${caps.gpu} GPU cores, ffmpeg threads ${caps.threads}; ${caps.queue}`);
    const MV = await imp(V), MS = await imp(SMALL), MT = await imp(TALK), MM = await imp(MIX), MF = await imp(FACE);
    let M4K, voiceId = '';
    const box = { x: 0.2, y: 0.33, w: 0.2, h: 0.3 }; // around the red box at t = 1 s (x 600-860 px of 1920)
    const plan = (w, h, m, dur) => ({ w, h, fps: 30, duration: dur, name: `allmacs ${w}x${h}`, main: [{ media: m.id, in: 0, out: dur, frames: Math.round(dur * 30), geom: { x: 0, y: 0, w, h } }] });
    const exportJob = async pl => { const r = await job('/api/export', pl); if (r.file) fs.rmSync(`${SCR}/lib-allmacs-${ram}/exports/${r.file}`, { force: true }); return r; };
    const F = [ // name, AI_BUDGET kind (null: not gated), the call
      ['proxy4k', 'proxy4k', async () => { M4K = await imp(V4K); return (await get('/api/media')).find(x => x.id === M4K.id); }], // later jobs use M4K
      ['image', 'image', () => job('/api/ai/image', { prompt: 'a red apple on a wooden table, studio light', w: 1024, h: 1024, steps: 2 })],
      ['voice', 'voice', () => job('/api/ai/voice', { text: 'Every Mac can make this voiceover, from eight gigabytes up.', voice: 'af_heart' })],
      ['voice clone', 'clone', async () => { const r = await job('/api/ai/clone', { media: MT.id, t0: 0, t1: 8, name: 'allmacs', consent: true }); voiceId = r.voice.id;
        check(`${ram} GB · voice clone: sounds more like the speaker than any stock voice (${r.voice.similarity} vs ${r.voice.baseline})`, r.voice.similarity > r.voice.baseline + 0.05);
        return r; }],
      ['dubbing', 'clone', () => job('/api/ai/dub', { voice: voiceId, lang: 'es', items: [{ s: 0, e: 3, text: 'Bienvenidos de nuevo al canal.' }, { s: 3.2, e: 6, text: 'Hoy probamos cada Mac.' }] })],
      ['captions', 'captions', () => api('/api/transcribe', { media: MT.id })],
      ['isolate', 'isolate', () => job('/api/isolate', { media: MM.id, keep: 'voice' })],
      ['remove', 'remove', () => job('/api/remove_object', { media: MV.id, t: 1, t0: 0, t1: 2, box, quality: 'best' })],
      ['remove fast', null, () => job('/api/remove_object', { media: MV.id, t: 1, t0: 0, t1: 2, box, quality: 'fast' })],
      ['cutout', 'cutout', () => job('/api/remove_object', { media: MV.id, t: 1, t0: 0, t1: 2, box, mode: 'cutout' })],
      ['outline preview', 'cutout', () => api('/api/mask_preview', { media: MV.id, t: 1, box })],
      ['interp', 'interp', () => job('/api/slowmo', { media: MV.id, t0: 0, t1: 1, factor: 4, engine: 'ai' })],
      ['upscale', 'upscale', () => job('/api/upscale', { media: MS.id, t0: 0, t1: 1, scale: 2 })],
      ['upscale to 8K', 'export8k', () => job('/api/upscale', { media: M4K.id, t0: 0, t1: 0.25, scale: 2 })],
      ['relight', 'relight', () => job('/api/relight', { media: MV.id, t0: 0, t1: 1, light: { preset: 'subject' } })],
      ['music', 'music', () => job('/api/ai/music', { prompt: 'calm piano with soft strings', dur: 8 })],
      ['hooks (llm)', 'llm', () => job('/api/ai/hooks', { ranges: [{ media: MT.id, in: 0, out: 10 }] })],
      ['translate (llm)', 'llm', () => job('/api/ai/translate', { texts: ['Every Mac can run this editor.', 'Nothing is uploaded.'], to: 'es' })],
      ['command bar (llm)', 'llm', () => api('/api/plan', { text: 'make the first clip black and white', ctx: { main: [{ id: 'c1', media: MV.id, in: 0, out: 3 }] } })],
      ['search (embed)', 'embed', () => api('/api/search', { q: 'a red box' })],
      ['speakers', 'speakers', () => job('/api/ai/speakers', { items: [{ media: MT.id, s: 0, e: 3 }, { media: MT.id, s: 3, e: 6 }, { media: MT.id, s: 6, e: 9 }] })],
      ['remove background', 'matte', () => job('/api/matte', { media: MF.id, t0: 0, t1: 1 })],
      ['find faces', 'faces', () => job('/api/faces', { media: MF.id, t0: 0, t1: 2, mode: 'all' })],
      ['retouch', 'retouch', () => job('/api/retouch', { media: MF.id, t0: 0, t1: 1, p: { smooth: 0.6, eyes: 0.3 } })],
      ['track', 'track', () => job('/api/track', { media: MV.id, t0: 0, t1: 2, t: 0, box: { x: 0.2, y: 0.35, w: 0.135, h: 0.24 } })],
      ['beats', 'beats', () => api('/api/beats', { media: MM.id })],
      ['export 4K', 'export', () => exportJob(plan(3840, 2160, M4K, 1))],
      ['export 8K', 'export8k', () => exportJob(plan(7680, 4320, M4K, 1))],
    ];
    results[ram] = [];
    if (!want('proxy4k')) M4K = await imp(V4K); // the 4K clip the upscale / export jobs read, when the proxy job is filtered out
    for (const [name, kind, fn] of F) {
      if (!want(name)) continue;
      await gpuQuiet();
      const c = kind && cap(kind), r = await measured(srv.pid, fn);
      const row = { mac: ram, name, kind, size: c?.size, budget: c?.gb, secs: +r.secs.toFixed(1), peakGB: +r.gb.toFixed(2), swapMB: +r.swapMB.toFixed(0), load: +r.load.toFixed(1), top: r.top, ...(r.err ? { error: r.err } : {}) };
      results[ram].push(row);
      const tag = `${ram} GB · ${name}`, info = `${row.secs} s, peak ${row.peakGB} GB${c?.gb ? ` of ${c.gb}` : ''}${r.top ? ` (${r.top})` : ''}, paged out ${row.swapMB} MB, load ${row.load}`;
      if (c?.refused) check(`${tag}: refused with the reason`, r.err?.includes(c.refused), r.err || 'it ran');
      else if (r.err) check(`${tag}: ${/out of memory|MPS backend|Killed|signal|-9\b/i.test(r.err) ? 'OUT OF MEMORY' : /not installed|setup\.sh|ollama pull/.test(r.err) ? 'refused: not installed here' : 'failed'}`,
        !/out of memory|MPS backend|Killed|signal/i.test(r.err) && /not installed|setup\.sh|ollama pull|no face/.test(r.err), r.err);
      else check(`${tag}: ran within its budget (${info})`, !c?.gb || r.gb <= c.gb * 1.25 + 0.3, c?.size);
      check(`${tag}: no swap storm`, r.swapMB <= SWAP_MB, `${row.swapMB} MB paged out`);
      if (!r.err && r.gb > caps.room) check(`${tag}: fits beside macOS and the editor (${caps.room} GB)`, false, `${row.peakGB} GB`);
    }
    // ---------- two heavy jobs at once: on EVERY Mac the second waits ("Waiting for AI music (1 ahead)"), never both at once ----------
    if (want('queue')) {
      await gpuQuiet();
      const { job: ja } = await api('/api/ai/music', { prompt: 'slow ambient pad', dur: 6 });
      await sleep(150);
      const { job: jb } = await api('/api/ai/voice', { text: 'Second in line.', voice: 'af_heart' });
      let note = '', overlap = false, etaSeen = 0, order = [];
      for (;;) {
        await sleep(250);
        const [sa, sb] = await Promise.all([get(`/api/jobs/${ja}`), get(`/api/jobs/${jb}`)]);
        if (sb.note) note = sb.note;
        etaSeen = Math.max(etaSeen, sa.eta || 0);
        overlap ||= sa.state === 'running' && sb.state === 'running' && !sa.note && !sb.note;
        for (const [k, s_] of [['a', sa], ['b', sb]]) if (s_.state !== 'running' && !order.includes(k)) order.push(k);
        if (sa.state !== 'running' && sb.state !== 'running') { check(`${ram} GB · queue: both jobs finish, in the order they came`, sa.state === 'done' && sb.state === 'done' && order.join('') === 'ab', `${sa.error || ''} ${sb.error || ''} ${order}`); break; }
      }
      check(`${ram} GB · queue: the second heavy job waits for the first and says so, never both at once`, /^Waiting for AI music \(1 ahead\)$/.test(note) && !overlap, `note "${note}", ran together ${overlap}`);
      check(`${ram} GB · the music job carries a time estimate (${etaSeen} s)`, etaSeen > 0);
    }
    // ---------- the "This Mac" panel ----------
    if (want('panel')) {
      const br = await webkit.launch();
      for (const rm of ['reduce', 'no-preference']) {
        const page = await (await br.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        await page.route(u => u.pathname === '/api/remote/next', async r => { await sleep(15000); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
        await page.goto(`${B}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
        await page.click('.rail [data-tab="ai"]');
        await page.waitForFunction(n => document.querySelectorAll('#macCaps .mc').length === n, caps.jobs.length, { timeout: 15000 }).catch(() => {});
        await page.locator('#macCaps').scrollIntoViewIfNeeded();
        const ui = await page.evaluate(() => {
          const c = document.querySelector('#macCaps'), pane = c.closest('.pane'), r = c.getBoundingClientRect(), pr = pane.getBoundingClientRect();
          return { n: c.querySelectorAll('.mc').length, off: [...c.querySelectorAll('.mc.off')].map(e => e.dataset.cap), sum: document.querySelector('#macSum').textContent,
            wide: [...c.querySelectorAll('.mc, .mc *')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible') || r.right > pr.right + 1 || pane.scrollWidth > pane.clientWidth + 1,
            text: [...c.querySelectorAll('.mc')].map(e => e.innerText.replace(/\s+/g, ' ')) };
        });
        const want = caps.jobs.filter(j => j.refused).map(j => j.kind);
        check(`${ram} GB · panel (${rm}): every AI job listed, the refused ones say why`, ui.n === caps.jobs.length && JSON.stringify(ui.off) === JSON.stringify(want) && ui.text.filter(t => t.includes('Not on this Mac')).length === want.length,
          `${ui.n} rows, off ${ui.off}`);
        check(`${ram} GB · panel (${rm}): the summary names this Mac and how it queues`, ui.sum.includes(`${caps.ram} GB`) && ui.sum.includes(caps.queue.slice(1, 20)) && (!caps.fake || ui.sum.includes('Simulated')), ui.sum);
        check(`${ram} GB · panel (${rm}): fits the AI pane (no sideways overflow), no page errors`, !ui.wide && !errs.length, errs.join(' | '));
        if (rm === 'reduce') await page.locator('#tab-ai').screenshot({ path: `${OUT}allmacs-panel-${ram}.png` }).catch(() => {});
        await page.close();
      }
      await br.close();
    }
    // ---------- idle: the server and an open editor page, 60 s untouched: ~0 % CPU, ~0 % GPU (no timers, no polling, workers gone) ----------
    if (want('idle')) {
      const base = []; // the GPU with no editor page open: the rest of this Mac (its screen, other apps) uses some
      for (let k = 0; k < 30; k++) { base.push(gpuUtil()); await sleep(1000); }
      const gBase = base.reduce((a, b) => a + b, 0) / base.length;
      const before = new Set(execFileSync('ps', ['-A', '-o', 'pid=']).toString().split(/\s+/).filter(Boolean).map(Number));
      const br = await webkit.launch();
      const page = await (await br.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
      await page.goto(`${B}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
      const web = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n').map(l => l.trim().match(/^(\d+)\s+(.*)$/))
        .filter(m => m && !before.has(+m[1]) && /webkit|playwright/i.test(m[2])).map(m => +m[1]);
      await sleep(40000); // the AI worker's 30 s idle exit (180 s past 16 GB), page load work settles
      const live = () => tree(srv.pid);
      const cmd = p => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(p)]).toString().trim(); } catch { return ''; } };
      const workers = live().filter(p => p !== srv.pid && !/ollama/.test(cmd(p)));
      const s0 = cpuSecs(live()), w0 = cpuSecs(web), gpu = [];
      for (let k = 0; k < 60; k++) { gpu.push(gpuUtil()); await sleep(1000); }
      const sCpu = (cpuSecs(live()) - s0) / 60 * 100, wCpu = (cpuSecs(web) - w0) / 60 * 100, gMean = gpu.reduce((a, b) => a + b, 0) / gpu.length;
      idle[ram] = { serverCpuPct: +sCpu.toFixed(2), pageCpuPct: +wCpu.toFixed(2), gpuMeanPct: +gMean.toFixed(1), gpuBasePct: +gBase.toFixed(1), gpuMax: Math.max(...gpu), children: workers.length };
      console.log(`idle 60 s: server ${sCpu.toFixed(2)} % CPU, page (WebKit, ${web.length} processes) ${wCpu.toFixed(2)} % CPU, GPU mean ${gMean.toFixed(1)} % (max ${Math.max(...gpu)}; ${gBase.toFixed(1)} % before the page opened), server children ${workers.length}`);
      check(`${ram} GB · idle: no AI worker or model process left running`, workers.length === 0, workers.map(cmd).join(' | ').slice(0, 300));
      check(`${ram} GB · idle 60 s: server ~0 % CPU`, sCpu < 0.5, `${sCpu.toFixed(2)} %`);
      check(`${ram} GB · idle 60 s: editor page ~0 % CPU`, wCpu < 2, `${wCpu.toFixed(2)} %`);
      check(`${ram} GB · idle 60 s: the editor adds ~0 % GPU (whole Mac ${gMean.toFixed(1)} % vs ${gBase.toFixed(1)} % without it)`, gMean - gBase < 3, `max ${Math.max(...gpu)} %`);
      await br.close();
    }
  } finally {
    srv.kill();
  }
}
fs.writeFileSync(`${OUT}allmacs.json`, JSON.stringify({ results, idle }, null, 1));
console.log('\nmac  feature               s       peak GB  budget  paged MB  load  result');
for (const r of Object.values(results).flat()) console.log(`${String(r.mac).padEnd(4)} ${r.name.padEnd(20)} ${String(r.secs).padStart(6)}  ${String(r.peakGB).padStart(7)}  ${String(r.budget ?? '').padStart(6)}  ${String(r.swapMB).padStart(8)}  ${String(r.load).padStart(4)}  ${r.error ? r.error.slice(0, 90) : 'ran'}${r.top ? `  [${r.top}]` : ''}`);
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
