// J and L cuts on the main track: a clip's own sound starting before its picture (sndLead) or running on after it (sndTail).
// One source with 30 ms beeps at 1, 3 and 5 s (PCM audio, so every sample is where it was written). Two main clips,
// A = 2-4 s and B = 1.5-3.5 s at 30 fps: A's beep at 3 s lands at 1.0, B's at 3.5. With B's sound 0.8 s early (J) its
// beep at 1 s lands 0.5 s before the cut (1.5); with A's sound running on 1.5 s (L) its beep at 5 s lands at 3.0.
// Checks the exported WAV to the sample, the preview's scheduled Web Audio starts against it, the same edit with the J/L
// off (only the two body beeps), the knob drag + undo, the inspector fields and the drawn extension in both motion modes.
//   B=http://127.0.0.1:4704 CUTROOM_HOME=<scratch lib> node tests/jlcuts.mjs
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const B = process.env.B || 'http://127.0.0.1:4610', HOME = process.env.CUTROOM_HOME, SR = 48000, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
if (!HOME || HOME.includes('Movies/Cutroom')) throw new Error('set CUTROOM_HOME to the scratch library the server uses');
const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H })).json();
const dir = mkdtempSync(join(tmpdir(), 'jlcuts-')), f = join(dir, 'beeps.mov');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=10', '-f', 'lavfi', '-i',
  "aevalsrc='0.8*cos(2*PI*1000*t)*(between(t,1,1.03)+between(t,3,3.03)+between(t,5,5.03))':s=48000:d=10:c=stereo",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', f]);
const tf = join(dir, 'tone.mov'); // a steady 440 Hz: where a piece hands over to the clip's own sound there must be no 3 ms dip
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=gray:s=320x180:r=30:d=10', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=10:c=stereo",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', tf]);
const imp = async p => {
  const r = await api('/api/import_path', { path: p });
  if (r.error) throw new Error(r.error);
  for (let i = 0; !(await api('/api/media')).find(x => x.id === r.id)?.ready; i++) { if (i > 300) throw new Error('import stuck'); await new Promise(q => setTimeout(q, 200)); }
  return r;
};
const m = await imp(f), tone = await imp(tf);
let fails = 0;
const check = (ok, what) => { fails += !ok; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const pcmOf = file => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(HOME, 'exports', file), '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-ac', '1', '-ar', `${SR}`, '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length >> 2);
};
const onsets = file => { // sample index of each beep's first sample (left channel)
  const x = pcmOf(file), out = [];
  for (let i = 0, quiet = 1e9; i < x.length; i++) { if (Math.abs(x[i]) > 0.3) { if (quiet > 2400) out.push(i); quiet = 0; } else quiet++; }
  return out;
};
const b = await browser.launch();
const pids = [];
for (const motion of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: motion })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(B + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined', null, { timeout: 30000 });
  const ids = await page.evaluate(async id => {
    await loadMedia();
    setProject(newProject('16:9')); P.name = 'jl cuts (scratch)'; P.fps = 30;
    const base = { media: id, volume: 1, speed: 1, fadeIn: 0, fadeOut: 0, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } };
    P.main = [{ ...base, id: hex12(), in: 2, out: 4 }, { ...base, id: hex12(), in: 1.5, out: 3.5 }];
    packMain(); renderAll();
    await REMOTE.update_clip({ id: P.main[1].id, set: { sndLead: 0.8 } });
    await REMOTE.update_clip({ id: P.main[0].id, set: { sndTail: 1.5 } });
    return { pid: P.id, a: P.main[0].id, b: P.main[1].id };
  }, m.id);
  pids.push(ids.pid);
  check(await page.evaluate(() => JSON.stringify([jlOf(0), jlOf(1)])) === JSON.stringify([[0, 1.5], [0.8, 0]]), `${motion}: J/L in whole frames, where they apply [${await page.evaluate(() => JSON.stringify([jlOf(0), jlOf(1)]))}]`);

  if (motion === 'no-preference') {
    // export: every beep to the sample
    const want = [1.0, 1.5, 3.0, 3.5].map(t => Math.round(t * SR)), plain = [1.0, 3.5].map(t => Math.round(t * SR));
    const e1 = await page.evaluate(async () => (await REMOTE.export({ format: 'wav', name: `jlcuts-${Date.now()}` })).file);
    const got = onsets(e1);
    check(JSON.stringify(got) === JSON.stringify(want), `export: beeps at samples ${got.join(', ')} (want ${want.join(', ')}: J 0.5 s before the cut, L 1.0 s after it)`);
    // the preview: the Web Audio buffer starts it schedules, mapped to where each beep is heard on the timeline
    await page.evaluate(() => {
      window.STARTS = [];
      const st = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when, off = 0, dur = Infinity) { STARTS.push({ buf: this.buffer, when, off, dur, a0: S.aA0, t0: S.aT0, r: this.playbackRate.value }); return st.call(this, when, off, dur); };
      S.t = 0.9; S.dirty = true;
    });
    await page.waitForTimeout(800);
    await page.keyboard.press('Space');
    await page.waitForTimeout(3600);
    const heard = await page.evaluate(() => {
      pause();
      const k = new Map();
      for (const [key, p] of pcmBufs) if (p.buf) k.set(p.buf, +key.split('|')[3]);
      const out = [];
      for (const s of STARTS) {
        if (!k.has(s.buf) || s.r !== 1) continue;
        const src = k.get(s.buf) * PCM_S + s.off, end = src + Math.min(s.dur, s.buf.duration - s.off), tl = s.when - s.a0 + s.t0;
        for (const bs of [1, 3, 5]) if (bs >= src && bs < end) out.push(tl + (bs - src));
      }
      return out.sort((x, y) => x - y);
    });
    const uniq = heard.filter((t, i) => !i || t - heard[i - 1] > 1e-3), match = want.map(w => uniq.find(t => Math.abs(t * SR - w) < 0.5));
    check(uniq.length === want.length && match.every(x => x !== undefined),
      `preview schedules the beeps at ${uniq.map(t => (t * SR).toFixed(2)).join(', ')} samples (the export's ${want.join(', ')})`);
    // J/L off: the plain cut, as before
    await page.evaluate(async ([a, b]) => { await REMOTE.update_clip({ id: b, set: { sndLead: 0 } }); await REMOTE.update_clip({ id: a, set: { sndTail: 0 } }); }, [ids.a, ids.b]);
    const e2 = await page.evaluate(async () => (await REMOTE.export({ format: 'wav', name: `jlcuts-off-${Date.now()}` })).file), got2 = onsets(e2);
    check(JSON.stringify(got2) === JSON.stringify(plain), `J/L off: only the clips' own beeps, at ${got2.join(', ')} (want ${plain.join(', ')})`);
    await page.evaluate(async ([a, b]) => { await REMOTE.update_clip({ id: b, set: { sndLead: 0.8 } }); await REMOTE.update_clip({ id: a, set: { sndTail: 1.5 } }); }, [ids.a, ids.b]);
    // the hand-overs: tone A's L tail runs on from its own sound at 2.0, tone C's J lead runs into its own sound at 4.0
    const e3 = await page.evaluate(async ([tone, sil]) => {
      const base = { volume: 1, speed: 1, fadeIn: 0, fadeOut: 0, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } }, keep = P.main;
      P.main = [{ ...base, id: hex12(), media: tone, in: 2, out: 4, sndTail: 1 }, { ...base, id: hex12(), media: sil, in: 6, out: 8 }, { ...base, id: hex12(), media: tone, in: 5, out: 7, sndLead: 0.5 }];
      packMain();
      const file = (await REMOTE.export({ format: 'wav', name: `jlcuts-seam-${Date.now()}` })).file;
      P.main = keep; packMain(); renderAll();
      return file;
    }, [tone.id, m.id]);
    const x = pcmOf(e3), dip = t => { let lo = 1; for (let i = Math.round((t - 0.05) * SR); i < (t + 0.05) * SR; i += 48) { let pk = 0; for (let j = i; j < i + 120; j++) pk = Math.max(pk, Math.abs(x[j])); lo = Math.min(lo, pk); } return lo; };
    check(dip(2) > 0.45 && dip(4) > 0.45, `the J and L pieces hand over to the clip's own sound with no dip (lowest 2.5 ms peak near the seams: ${dip(2).toFixed(3)}, ${dip(4).toFixed(3)} of 0.5)`);
    // a transition at the cut: the sound crossfades instead, no J/L
    check(await page.evaluate(() => { P.main[0].tr = { type: 'fade', d: 0.5 }; const r = jlOf(1)[0] + jlOf(0)[1]; delete P.main[0].tr; return r; }) === 0, 'a transition at the cut turns J/L off there');
  }

  // UI: the drawn extension, the inspector fields, the knob drag and its undo
  await page.evaluate(id => { S.sel = { lane: 'main', id }; S.pps = 100; renderAll(); }, ids.b);
  await page.waitForTimeout(300);
  const ui = await page.evaluate(() => ({ jlx: [...document.querySelectorAll('.jlx')].map(e => Math.round(e.getBoundingClientRect().width)),
    fields: [...document.querySelectorAll('#inspector [data-k="c.sndLead"], #inspector [data-k="c.sndTail"]')].length, label: document.querySelector('#inspector')?.textContent.includes('Sound starts early') }));
  check(ui.jlx.length === 2 && ui.jlx.includes(80) && ui.jlx.includes(150), `${motion}: the timeline draws the J and L sound past the edges [${ui.jlx}] px`);
  check(ui.fields === 2 && ui.label, `${motion}: inspector has "Sound starts early" and "Sound runs on"`);
  await page.evaluate(() => { document.querySelector('.clip.sel .jh.l').style.display = 'block'; });
  const kb = await page.locator('.clip.sel .jh.l').boundingBox();
  await page.mouse.move(kb.x + 4, kb.y + 4); await page.mouse.down();
  await page.mouse.move(kb.x - 30, kb.y + 4, { steps: 4 }); await page.mouse.move(kb.x - 46, kb.y + 4, { steps: 4 }); await page.mouse.up();
  const dragged = await page.evaluate(() => P.main[1].sndLead);
  check(Math.abs(dragged - 1.3) < 0.04 && Math.abs(dragged * 30 - Math.round(dragged * 30)) < 1e-9, `${motion}: dragging the sound knob 50 px further out adds 0.5 s, in frames (0.8 -> ${dragged} s)`);
  await page.keyboard.press('Meta+z');
  check(await page.evaluate(() => P.main[1].sndLead) === 0.8, `${motion}: one undo puts it back`);
  await page.screenshot({ path: join(process.env.CUTROOM_SCRATCH || dir, `jlcuts-${motion}.png`) });
  check(!errs.length, `${motion}: no page errors ${errs.join('; ')}`);
  await page.close();
}
for (const pid of pids) await api(`/api/projects/${pid}/trash`, {});
for (const x of [m, tone]) await api(`/api/media/${x.id}/trash`, {});
await b.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
