// Heavy camera footage, end to end: import (proxies, filmstrips, waveforms), playback, seeking and a 1080p export,
// with the CPU and memory each step takes. Run it against a SCRATCH server so the library stays untouched:
//   CUTROOM_HOME=/tmp/x CUTROOM_PORT=4620 python3 -I server.py &   then   B=http://127.0.0.1:4620 node perf_heavy.mjs a.mp4 b.mov ...
// Cores = CPU seconds per wall second (WebKit + server + its ffmpeg children). Peak MB = the server's ffmpegs together.
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const B = process.env.B || 'http://127.0.0.1:4620', PORT = new URL(B).port, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const files = process.argv.slice(2).map(f => path.resolve(f));
const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H })).json();
const srv = execFileSync('sh', ['-c', `lsof -t -nP -iTCP:${PORT} -sTCP:LISTEN`]).toString().trim();
const kids = () => { try { return execFileSync('pgrep', ['-P', srv]).toString().split(/\s+/).filter(Boolean); } catch { return []; } };
const ps = l => { if (!l.length) return []; try { return execFileSync('ps', ['-o', 'rss=,time=', '-p', l.join(',')]).toString().trim().split('\n').map(x => x.trim().split(/\s+/)); } catch { return []; } };
const secs = t => { const [m, s] = t.split(':'); return +m * 60 + +s; };
const watch = () => { // samples the server's children every 250 ms: peak memory together, and the most running at once
  const w = { peak: 0, most: 0, seen: new Map() };
  w.id = setInterval(() => { const k = kids(), r = ps(k); w.peak = Math.max(w.peak, r.reduce((s, x) => s + +x[0], 0) / 1024); w.most = Math.max(w.most, r.length); k.forEach((p, i) => r[i] && w.seen.set(p, secs(r[i][1]))); }, 250);
  w.stop = () => { clearInterval(w.id); return { peak: Math.round(w.peak), most: w.most, cpu: [...w.seen.values()].reduce((a, b) => a + b, 0) }; };
  return w;
};
const self = () => { const r = ps([srv])[0]; return r ? secs(r[1]) : 0; };
const log = s => console.log(s);

// 1. import everything at once, as when a card's worth of clips is dropped in
let w = watch(), t0 = Date.now(), c0 = self();
const ids = await Promise.all(files.map(f => api('/api/import_path', { path: f }).then(m => { if (m.error) throw new Error(m.error); return m.id; })));
for (;;) { const ms = await api('/api/media'); if (ids.every(id => ms.find(m => m.id === id)?.ready)) break; await new Promise(r => setTimeout(r, 300)); }
let r = w.stop(), el = (Date.now() - t0) / 1000;
log(`import ${files.length} files: ${el.toFixed(1)} s, ${((r.cpu + self() - c0) / el).toFixed(1)} cores, peak ${r.peak} MB in ffmpeg, ${r.most} at once`);
const ms = (await api('/api/media')).filter(m => ids.includes(m.id));
for (const m of ms) log(`  ${m.name}: ${m.w}x${m.h} ${m.fps} fps ${m.codec}${m.hdr ? ' HDR' : ''} -> ${m.proxy ? 'proxy' : 'original'} in the preview`);

// 2. playback and seeking, per clip, in WebKit (the app's engine)
const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
await page.route(u => u.pathname === '/api/remote/next', async q => { await new Promise(z => setTimeout(z, 15000)); q.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
const wk = () => { try { return execFileSync('pgrep', ['-f', 'ms-playwright/webkit']).toString().split(/\s+/).filter(Boolean); } catch { return []; } };
const cpuAll = () => ps([...wk(), srv, ...kids()]).reduce((s, x) => s + secs(x[1]), 0);
const pids = [];
for (const m of ms) {
  pids.push(await ev(id => { setProject(newProject('16:9')); P.name = 'perf heavy (scratch)'; addMedia(id, 'main'); P.fps = Math.min(60, M.get(id).fps || 30); S.sel = null; renderAll(); return P.id; }, m.id));
  await ev(() => waitFrame());
  await ev(() => { // frames that reached the preview: a paint whose video shows a different source frame than the last one did
    window.__f = 0; window.__last = -1; window.__op ??= paint;
    paint = () => { __op(); const v = [...(S.live || [])][0], n = v ? Math.round(v.currentTime * (M.get(P.main[0].media).fps || 30)) : -1; if (n !== __last) { __f++; __last = n; } };
    S.t = 0; play(); });
  await page.waitForTimeout(1500);
  const a = cpuAll(), f0 = await ev(() => __f), t1 = Date.now();
  await page.waitForTimeout(6000);
  const s = (Date.now() - t1) / 1000, fr = (await ev(() => __f) - f0) / s, cores = (cpuAll() - a) / s;
  await ev(() => pause());
  const seek = await ev(async () => { const D = M.get(P.main[0].media).duration, l = []; for (let i = 0; i < 8; i++) { S.t = ((i * 0.37) % 1) * (D - 0.5); const t = performance.now(); await waitFrame(); l.push(performance.now() - t); } l.sort((x, y) => x - y); return [l[4], l[7]]; });
  log(`play ${m.name}: ${fr.toFixed(1)} of ${Math.min(60, m.fps)} video frames/s shown, ${cores.toFixed(2)} cores; seek median ${seek[0].toFixed(0)} ms, worst ${seek[1].toFixed(0)} ms`);
}

// 3. one 1080p export of every clip back to back
pids.push(await ev(ids => { setProject(newProject('16:9')); P.name = 'perf heavy export (scratch)'; for (const id of ids) addMedia(id, 'main'); P.fps = 30; S.sel = null; renderAll(); return P.id; }, ids));
w = watch(); t0 = Date.now(); c0 = self();
const ex = await ev(() => REMOTE.export({ resolution: '1080p', name: 'perf heavy' }).catch(e => ({ error: e.message })));
r = w.stop(); el = (Date.now() - t0) / 1000;
const dur = await ev(() => total());
log(`export 1080p30 of ${dur.toFixed(0)} s: ${el.toFixed(1)} s, ${((r.cpu + self() - c0) / el).toFixed(1)} cores, peak ${r.peak} MB in ffmpeg${ex.error ? ' ERROR ' + ex.error : ''}`);
await b.close();
for (const p of pids) await api(`/api/projects/${p}/trash`, {});
for (const id of ids) await api(`/api/media/${id}/trash`, {});
