// Picture vs sound while playing: a clip that flashes white and beeps on every whole second (in the source), cut into
// three timeline clips (a jump inside the file, and a 2x clip that keeps its pitch), played in headless WebKit.
// The flash is read off the preview canvas; the beep off a tap on the clips' Web Audio chains, put on the page clock
// with getOutputTimestamp(). Passes when every flash has its beep within 45 ms (1.4 frames at 30 fps) and none is lost.
//   B=http://127.0.0.1:4620 node av_sync.mjs   (a scratch server: CUTROOM_HOME=... CUTROOM_PORT=4620 python3 server.py)
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const api = async (p, body) => (await fetch(B + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H })).json();
const f = join(mkdtempSync(join(tmpdir(), 'avsync-')), 'flashbeep.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=black:s=640x360:r=30:d=12,geq=lum='if(lt(mod(N\\,30)\\,4)\\,235\\,16)':cb=128:cr=128",
  '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t\\,1)\\,0.03)\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=12", '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
const m = await api('/api/import_path', { path: f });
if (m.error) throw new Error(m.error);
for (let i = 0; !(await api('/api/media')).find(x => x.id === m.id)?.ready; i++) { if (i > 200) throw new Error('import stuck'); await new Promise(r => setTimeout(r, 200)); }
const b = await browser.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
await page.goto(B + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof M !== 'undefined', null, { timeout: 30000 });
const pid = await page.evaluate(async id => {
  await loadMedia();
  setProject(newProject('16:9')); P.name = 'av sync (scratch)'; P.fps = 30;
  const base = { media: id, volume: 1, fadeIn: 0, fadeOut: 0, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } };
  P.main = [{ ...base, id: hex12(), in: 0, out: 4, speed: 1 }, { ...base, id: hex12(), in: 6, out: 10, speed: 1 }, { ...base, id: hex12(), in: 0, out: 4, speed: 2 }];
  packMain(); renderAll(); S.t = 0.5; S.dirty = true;
  // the beeps: every clip chain's output also feeds one tap
  window.BEEP = []; window.FLASH = [];
  const tapOn = () => {
    if (window.TAP || !actx) return;
    const tap = actx.createScriptProcessor(1024, 2, 2), mute = actx.createGain(); mute.gain.value = 0;
    let quiet = 1e9;
    tap.onaudioprocess = e => { const x = e.inputBuffer.getChannelData(0), ts = actx.getOutputTimestamp();
      for (let i = 0; i < x.length; i++) { if (Math.abs(x[i]) > 0.2) { if (quiet > 2400) { const ct = e.playbackTime + i / actx.sampleRate; BEEP.push(ts.performanceTime + (ct - ts.contextTime) * 1000); } quiet = 0; } else quiet++; } };
    tap.connect(mute).connect(actx.destination); window.TAP = tap;
  };
  const sc = soundChain; soundChain = (...a) => { const n = sc(...a); tapOn(); n.out.connect(TAP); return n; };
  const pp = paint; let lit = false; paint = () => { pp(); if (!S.playing) return; const cv = $('#cv'), d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data[0];
    if (d > 128 && !lit) FLASH.push([performance.now(), S.t]); lit = d > 128; };
  return P.id;
}, m.id);
await page.waitForTimeout(1500);
// play a moment and pause: with no input for audioNap (1 s here) the audio context sleeps (no CPU while paused); the measured play below must wake it
await page.evaluate(() => { audioNap = 1000; });
await page.keyboard.press('Space'); await page.waitForTimeout(1200); await page.keyboard.press('Space');
await page.waitForTimeout(2500);
const slept = await page.evaluate(() => { const s = actx.state; S.t = 0.5; S.dirty = true; BEEP.length = 0; FLASH.length = 0; return s; });
console.log(`${slept === 'suspended' ? 'ok  ' : 'FAIL'} the audio context sleeps when nothing happens  [${slept}]`);
await page.waitForTimeout(500);
await page.keyboard.press('Space');
await page.waitForTimeout(10500);
const r = await page.evaluate(() => { pause(); return { beep: BEEP, flash: FLASH }; });
const pairs = r.flash.map(([ft, T]) => { const bt = r.beep.reduce((a, x) => (Math.abs(x - ft) < Math.abs(a - ft) ? x : a), Infinity); return { T, d: bt - ft }; });
let bad = 0;
for (const p of pairs) { const ok = Math.abs(p.d) <= 45; bad += !ok; console.log(`${ok ? 'ok  ' : 'FAIL'} flash at ${p.T.toFixed(2)} s: sound ${p.d >= 0 ? '+' : ''}${p.d.toFixed(0)} ms`); }
const want = 11; // 1,2,3 | 4,5,6,7 | 8,8.5,9,9.5
console.log(`${r.flash.length} flashes (want ${want}), ${r.beep.length} beeps; ${bad} out of sync`);
await api(`/api/projects/${pid}/trash`, {}); await api(`/api/media/${m.id}/trash`, {});
await b.close();
process.exit(bad || r.flash.length !== want || slept !== 'suspended' ? 1 : 0); // (a beep can start on a clip's very last sample: counted, not failed)
