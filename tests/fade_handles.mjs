// Fade knobs on timeline clips, end to end in headless WebKit: drag the round knobs on a clip's top corners, check the
// fade values, the cap (fade in + fade out <= the clip), undo/redo, that the edge below the knob still trims, then
// export a WAV and measure the fade ramps in the file.   node fade_handles.mjs   (server on 127.0.0.1:4610)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
const B = 'http://127.0.0.1:4610', SR = 48000, N = 4 * SR, res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
// a steady 440 Hz tone, 4 s, so the level over time is the fade curve
const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { const s = Math.round(0.25 * Math.sin(2 * Math.PI * 440 * i / SR) * 32767); wav.writeInt16LE(s, 44 + i * 4); wav.writeInt16LE(s, 46 + i * 4); }
const media = await (await fetch(`${B}/api/import?name=fade-e2e-tone.wav`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: wav })).json();

const b = await webkit.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
await page.waitForFunction(id => M.get(id)?.ready, media.id, { timeout: 20000 });
const pid = await ev(id => { setProject(newProject('16:9')); P.name = 'Fade e2e (scratch)'; addMedia(id, 'audio', 0); S.pps = 120; S.sel = { lane: 'audio', id: P.audio[0].id }; renderAll(); return P.id; }, media.id);
const clip = () => ev(() => { const c = P.audio[0]; return { fi: c.fadeIn, fo: c.fadeOut, in: c.in, out: c.out, ramps: document.querySelectorAll(`.clip[data-id="${c.id}"] svg.fade path`).length, slider: [...document.querySelectorAll('#inspector input[data-k="c.fadeIn"]')].map(x => +x.value)[0] }; });
const box = sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, r: r.right, t: r.top, b: r.bottom }; });
const dragTo = async (from, x, y = from.y) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (x - from.x) * i / 10, y); await page.mouse.up(); await page.waitForTimeout(100); };
const cb = await box('.clip.audio');
await page.mouse.move(cb.x, cb.y);
check('knobs show on a selected clip', await page.$eval('.clip.audio .fh.l', e => getComputedStyle(e).display !== 'none'));

await dragTo(await box('.clip.audio .fh.l'), cb.l + 1.0 * 120);
let c = await clip();
check('left knob dragged 1 s in = fade in 1 s', Math.abs(c.fi - 1) < 0.051, `fadeIn ${c.fi}`);
check('the ramp is drawn on the clip', c.ramps === 1);
check('inspector Fade in follows', c.slider !== undefined ? Math.abs(c.slider - c.fi) < 0.051 : true, `slider ${c.slider}`);
await dragTo(await box('.clip.audio .fh.r'), cb.r - 1.5 * 120);
c = await clip();
check('right knob dragged 1.5 s in = fade out 1.5 s', Math.abs(c.fo - 1.5) < 0.051 && c.ramps === 2, `fadeOut ${c.fo}`);
await dragTo(await box('.clip.audio .fh.l'), cb.r + 50);
c = await clip();
check('fade in stops where fade out starts', Math.abs(c.fi + c.fo - 4) < 0.051, `${c.fi} + ${c.fo}`);
await page.keyboard.press('Meta+z'); await page.waitForTimeout(100);
c = await clip();
check('undo puts the fade in back', Math.abs(c.fi - 1) < 0.051, `fadeIn ${c.fi}`);
await page.keyboard.press('Meta+Shift+z'); await page.waitForTimeout(100);
check('redo', Math.abs((await clip()).fi - 2.5) < 0.051);
await page.keyboard.press('Meta+z'); await page.waitForTimeout(100);
const e0 = await box('.clip.audio');
await dragTo({ x: e0.r - 3, y: e0.b - 6 }, e0.r - 3 - 0.5 * 120); // the bottom of the right edge, under the knob
c = await clip();
check('the edge below the knob still trims', Math.abs(c.out - 3.5) < 0.05 && Math.abs(c.fo - 1.5) < 0.051, `out ${c.out.toFixed(2)}, fadeOut ${c.fo}`);
await page.keyboard.press('Meta+z'); await page.waitForTimeout(100);

// the export carries the fades: 1 s linear fade in, 1.5 s fade out from 2.5 s
const ex = await ev(() => REMOTE.export({ format: 'wav', name: `fade-e2e-${Date.now()}` }));
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', `${os.homedir()}/Movies/Cutroom/exports/${ex.file}`, '-f', 'f32le', '-ac', '1', '-ar', `${SR}`, '-'], { maxBuffer: 1 << 28 });
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const lvl = t => { let s = 0; const a = Math.round((t - 0.025) * SR), n = Math.round(0.05 * SR); for (let i = a; i < a + n; i++) s += x[i] * x[i]; return Math.sqrt(s / n); };
const full = lvl(2.0); // the level between the fades = 1
const want = t => Math.min(1, t / 1, (4 - t) / 1.5);
const pts = [0.1, 0.5, 0.9, 1.5, 2.4, 3.0, 3.5, 3.9].map(t => [t, lvl(t) / full, want(t)]);
check('exported level follows both fades', pts.every(([, g, w]) => Math.abs(g - w) < 0.06), pts.map(([t, g, w]) => `${t}s ${g.toFixed(2)}/${w.toFixed(2)}`).join(' '));
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));

execFileSync('mv', [`${os.homedir()}/Movies/Cutroom/exports/${ex.file}`, `${os.homedir()}/Movies/Cutroom/trash/exports/`]);
for (const u of [`/api/projects/${pid}/trash`, `/api/media/${media.id}/trash`]) await fetch(B + u, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
await b.close();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.includes(false) ? 1 : 0);
