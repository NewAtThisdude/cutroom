// Text/effect layer cost: buildPlan time ("Rendering text layer…"), layer PNG count, the JSON plan body, and (FULL=1)
// the export wall time and the ffmpeg part of it. Cases: the 30 s 1080p60 "Midnight Highway" project bare / + 10 s Snow
// (1080p and 4K), a synthetic 60 s 1080x1920 60 fps Bold-captioned short (~150 words), and the "Idling truck" short
// repeated N times (LONG=10,70: 70 copies = 30 min). RSS = the WebKit page process's peak memory while building.
//   B=http://127.0.0.1:4721 CUTROOM_HOME=<scratch lib> node perf_layer.mjs [case,...]   (N=3 runs; never the real 4610 server)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
const B = process.env.B || 'http://127.0.0.1:4721', FULL = !!process.env.FULL, N = +process.env.N || 3, only = process.argv[2]?.split(',');
const LONG = (process.env.LONG || '10').split(',').map(Number);
const procs = () => execFileSync('ps', ['-A', '-o', 'pid=,rss=,command=']).toString().trim().split('\n').map(l => l.trim().split(/\s+/)).filter(r => /WebContent/.test(r.slice(2).join(' '))).map(r => [+r[0], +r[1]]);
const before = new Set(procs().map(r => r[0])); // WebContent is an XPC service (parent launchd): ours are the ones that appear after the launch
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log('console.' + m.type(), m.text()); });
await page.route(u => u.pathname === '/api/remote/next', async q => { await new Promise(z => setTimeout(z, 15000)); q.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined' && M.size > 0, null, { timeout: 30000 });
const ev = (f, a) => page.evaluate(f, a);
if (process.env.LAYER) await ev(m => { S.layerForce = m; }, process.env.LAYER); // LAYER=page: the main-thread fallback
const projs = await ev(() => api('/api/projects'));
const pid = re => projs.find(p => re.test(p.name)).id;
const HW = pid(/Midnight Highway/), TRUCK = pid(/Idling truck/);
const rss = () => { try { return Math.max(0, ...procs().filter(r => !before.has(r[0])).map(r => r[1])) / 1024; } catch { return 0; } }; // approximate: another chain's browser starting meanwhile counts too

const cases = {
  none: [HW, 'P => {}', [1920, 1080]],
  snow: [HW, `P => P.fx.push({ id: hex12(), fx: 'snow', start: 0, dur: 10, amt: 1 })`, [1920, 1080]],
  snow4k: [HW, `P => P.fx.push({ id: hex12(), fx: 'snow', start: 0, dur: 10, amt: 1 })`, [3840, 2160]],
  short60: [TRUCK, `P => { // 60 s at 60 fps, 30 Bold captions of 5 words, a word every 0.4 s
    P.fps = 60; const m0 = P.main[0], d = (m0.out - m0.in) / (m0.speed || 1); P.main = []; P.text = []; P.captions = [];
    for (let t = 0; t < 60 - 1e-6; t += d) { const c = { ...structuredClone(m0), id: hex12() }; if (60 - t < d) c.out = c.in + (60 - t) * (c.speed || 1); P.main.push(c); }
    const W = ('here is something most truck drivers never think about when they park for the night they leave the engine running to keep the cab warm '
      + 'and that one habit quietly burns close to three thousand dollars of diesel every single year an idling engine uses almost a gallon an hour '
      + 'it wears the injectors it fouls the oil and it puts hours on the motor without moving a single mile of freight so what can you do instead '
      + 'a small diesel heater costs a few hundred dollars runs all night on a cup of fuel and pays for itself in the first month of winter '
      + 'an auxiliary power unit does the same for the air conditioning in summer and many fleets now pay drivers a bonus for low idle time '
      + 'so next time you stop for the night shut it down plug in or heat the cab the smart way your wallet and your engine will thank you').split(' ');
    for (let k = 0; k < 30; k++) P.captions.push({ id: hex12(), start: k * 2, dur: 2, text: '', words: Array.from({ length: 5 }, (_, i) => ({ w: W[(k * 5 + i) % W.length], s: i * 0.4, e: i * 0.4 + 0.4 })) });
    P.captions.forEach(c => { c.text = c.words.map(w => w.w).join(' '); });
    P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS.Bold, y: 0.72 }; }`, [1080, 1920]],
};
for (const n of LONG) cases[`long${n}`] = [TRUCK, `P => { const m0 = P.main[0], d = (m0.out - m0.in) / (m0.speed || 1), caps = P.captions; P.main = []; P.captions = []; P.text = [];
    for (let k = 0; k < ${n}; k++) { P.main.push({ ...structuredClone(m0), id: hex12() });
      for (const c of caps) { const q = structuredClone(c); q.id = hex12(); q.start += k * d; if (q.words) q.words = q.words.map((w, i) => ({ ...w, w: i === 0 ? w.w + ' ' + k : w.w })); q.text = (q.text || '') + ' ' + k; P.captions.push(q); } } }`, [1080, 1920]];

for (const [name, [src, setup, [w, h]]] of Object.entries(cases)) {
  if (only && !only.includes(name)) continue;
  for (let run = 0; run < (name.startsWith('long') ? Math.min(N, name === 'long70' ? 1 : N) : N); run++) {
    await ev(async ([src, setup]) => { const p = await api(`/api/projects/${src}`); p.id = hex12(); p.name = 'perf_layer scratch'; setProject(p); (0, eval)(`(${setup})`)(P); renderAll(); }, [src, setup]);
    let peak = rss();
    const iv = setInterval(() => { peak = Math.max(peak, rss()); }, 500);
    const r = await ev(async ([w, h, full]) => {
      let bars = 0; const ui = window.exportUI; window.exportUI = (...a) => { bars++; return ui(...a); };
      S.exporting = { pct: 0 }; // as runExport sets it: the layer phase moves the bar
      const out = { dur: +total().toFixed(1) };
      try {
        const t0 = performance.now(), plan = await buildPlan(w, h, 'fast', 'perf_layer', false, 'mp4'), t1 = performance.now(), js = JSON.stringify(plan);
        Object.assign(out, { buildMs: Math.round(t1 - t0), pngs: plan.text ? (plan.text.n ?? plan.text.pngs.length) : 0, box: plan.text?.box || null, bodyMB: +(js.length / 1e6).toFixed(2), mode: S.layerMode, stats: S.layerStats, bars });
        if (full) {
          const t2 = performance.now(), { job } = await api('/api/export', plan);
          for (;;) { await new Promise(z => setTimeout(z, 250)); const j = await api(`/api/jobs/${job}`); if (j.state !== 'running') { out.export = j.state === 'done' ? j.file : j.error; break; } }
          out.ffmpegS = +((performance.now() - t2) / 1000).toFixed(1); out.wallS = +((performance.now() - t0) / 1000).toFixed(1);
        }
      } catch (e) { out.error = e.message; }
      window.exportUI = ui; S.exporting = null;
      return out;
    }, [w, h, FULL]);
    clearInterval(iv);
    console.log(`${name} ${w}x${h} #${run + 1}`.padEnd(24), JSON.stringify({ ...r, rssMB: Math.round(peak) }));
  }
}
await b.close();
