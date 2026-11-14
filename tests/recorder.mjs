// The recorder (web/record.js), in headless WebKit with real clicks and keys, both motion modes. No real screen, camera or mic
// in a test: getDisplayMedia is a canvas (dark grey, a white flash at known times), the camera another canvas (blue, the same
// flashes), the mic a MediaStreamDestination of the app's AudioContext with a beep at each flash, plus the "room": everything
// the app sends to its speakers (web/silent.js's gate), so the countdown's blips measure the mic's delay (WebKit delivers such a
// stream ~47 ms late), as in voiceover.mjs. The Mac app's message handler is stubbed to log what the page tells it.
// Checks: the dialog (options remembered, the browser warning off in the app); countdown, then recording with a running time;
// the teleprompter scrolls, Space pauses and resumes it, the arrows change its speed, mirror flips it; the app hides its window
// for the whole take; Esc stops; screen, camera and mic land as three separate library files on the main, overlay (a
// bottom-right picture-in-picture) and audio tracks; the flashes and beeps line up within one frame (30 fps) in the files as
// placed on the timeline AND in an export; area mode crops the clip; one undo step; save + reload; Esc in the countdown
// records nothing and frees the devices; refused permissions say where to allow them; no page errors.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:4811 node recorder.mjs   (never 4610)
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B, H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
if (!B || /:4610\b/.test(B)) { console.log('FAIL set B to a scratch server (never 4610)'); process.exit(1); }
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const api = async (p, body) => (await fetch(B + p, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-rec-`), f = `${tmp}/rec-base.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
const V = await (await fetch(`${B}/api/import?name=rec-base.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json();
const HOME = (await api('/api/settings')).home, FPS = 30, FRAME = 1 / FPS;
const made = { p: [], m: [V.id] };

// onsets in a file: luma crossing 128 upwards (in a region, if given) and the beeps (|x| > 0.3, 0.3 s apart)
const flashes = (file, crop) => {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${crop ? `crop=${crop},` : ''}signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const ts = [...out.matchAll(/pts_time:([\d.]+)/g)].map(m => +m[1]), ys = [...out.matchAll(/YAVG=([\d.]+)/g)].map(m => +m[1]), on = [];
  for (let i = 1; i < ys.length; i++) if (ys[i] > 128 && ys[i - 1] <= 128) on.push(ts[i]);
  return { on, first: ts[0], dark: ys.filter(y => y <= 128) };
};
const beeps = file => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 256 << 20 }), on = [];
  for (let i = 0; i < b.length / 2; i++) if (Math.abs(b.readInt16LE(i * 2)) > 0.3 * 32768) { on.push(i / 48000); i += 48000 * 0.3; }
  return on;
};

const b = await browser.launch();
for (const rm of ['no-preference', 'reduce']) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // (not the MCP's editor)
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0 && typeof openRecorder === 'function', null, { timeout: 20000 });
  const ev = (fn, a) => page.evaluate(fn, a);
  if (await page.$('#tour')) await page.keyboard.press('Escape');
  const install = () => ev(() => { // the fake devices and the Mac app's handler (again after a reload)
    window.APP = [];
    window.webkit = { messageHandlers: { record: { postMessage: v => APP.push([v, RC?.phase ?? null]) } } };
    window.FLASH = [];
    const canvas = (w, h, bg) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      setInterval(() => { const now = performance.now(), on = FLASH.some(t => now >= t && now < t + 150); x.fillStyle = on ? '#fff' : bg; x.fillRect(0, 0, w, h); }, 5);
      return c.captureStream();
    };
    window.DEV = { fail: {} };
    const room = () => { // the mic: beeps at FLASH times, and the speakers (silent.js's gain) as heard in the room
      if (DEV.dst) return DEV.dst;
      audioOn();
      const A = actx, dst = A.createMediaStreamDestination(), z = A.destination;
      if (z instanceof AudioDestinationNode) throw new Error('the page has sound: run on a test port');
      z.disconnect(); z.gain.value = 1; z.connect(dst);
      DEV.beep = W => { const ts = A.getOutputTimestamp(), g = ts.contextTime + (W - ts.performanceTime) / 1000, o = A.createOscillator(), k = A.createGain(); o.frequency.value = 1000; k.gain.value = 0.6; o.connect(k); k.connect(dst); o.start(g); o.stop(g + 0.05); };
      return (DEV.dst = dst);
    };
    const no = n => Object.assign(new Error('denied'), { name: n });
    Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { configurable: true, value: async c => {
      if (DEV.fail.screen) throw no(DEV.fail.screen);
      DEV.screenAsked = c; return (DEV.screen = canvas(640, 360, '#303030'));
    } });
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: async c => {
      if (DEV.fail.user) throw no(DEV.fail.user);
      const t = [];
      if (c.video) t.push(...(DEV.cam = canvas(320, 240, '#1d3a8a')).getVideoTracks());
      if (c.audio) t.push(...room().stream.getAudioTracks());
      return (DEV.user = new MediaStream(t));
    } });
  });
  await install();
  await ev(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, V.id, { timeout: 60000 });
  made.p.push(await ev(id => { setProject(newProject('16:9')); P.name = 'Recorder test (scratch)'; P.fps = 30; renderAll(); addMedia(id, 'main', 0); S.t = 3; return P.id; }, V.id));

  // ---- the dialog ----
  await page.click('.rail button[data-tab="media"]');
  await page.click('#btnRecord');
  await page.waitForSelector('#modal .dialog.recd');
  const dlg = await ev(() => ({ opts: $$('#rcScreen option').map(o => o.value), hide: $('#rcHide').hidden, cam: $('#rcCam').checked, mic: $('#rcMic').checked }));
  const script = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the script, read to the camera.`).join('\n');
  await page.fill('#rcScript', script);
  await page.selectOption('#rcScreen', 'screen');
  if (rm === 'reduce') await page.click('#rcMirror');
  check(`${rm}: the dialog offers entire screen, a window, an area or none, camera and mic on; no browser warning in the Mac app`, dlg.opts.join() === 'screen,window,area,none' && dlg.cam && dlg.mic && dlg.hide, JSON.stringify(dlg));

  // ---- countdown, then recording ----
  await page.click('#rcGo');
  await page.waitForFunction(() => RC?.phase === 'count' && $('.rccount')?.textContent === '3', null, { timeout: 10000 });
  const cd = await ev(() => ({ app: APP.slice(), prompt: !!$('.rcprompt:not([hidden])'), mirror: getComputedStyle($('.rctext')).transform }));
  await page.waitForFunction(() => RC?.phase === 'rec', null, { timeout: 10000 });
  check(`${rm}: a 3-2-1 countdown; the app hides its window from screen capture before it starts`, cd.app.length === 1 && cd.app[0][0] === true && cd.app[0][1] === 'count', JSON.stringify(cd.app));
  check(`${rm}: the teleprompter shows ${rm === 'reduce' ? 'mirrored' : 'unmirrored'}`, cd.prompt && (rm === 'reduce' ? /matrix\(-1/.test(cd.mirror) : cd.mirror === 'none'), cd.mirror);
  const wall = await ev(() => { const n = performance.now(); FLASH.push(n + 900, n + 1800, n + 2700); for (const t of FLASH) DEV.beep(t); return FLASH.slice(); });
  const sc = () => ev(() => $('.rcprompt').scrollTop);
  const s0 = await sc(); await page.waitForTimeout(700); const s1 = await sc();
  await page.keyboard.press('Space'); await page.waitForTimeout(100); const p0 = await sc(); await page.waitForTimeout(500); const p1 = await sc();
  const pausedLabel = await ev(() => $('[data-rc="pause"]').textContent);
  await page.keyboard.press('Space');
  const sp0 = await ev(() => RC.speed); await page.keyboard.press('ArrowUp'); const sp1 = await ev(() => [RC.speed, +$('.rcspeed input').value]);
  await page.waitForTimeout(500); const s2 = await sc();
  check(`${rm}: the teleprompter scrolls (${(s1 - s0).toFixed(0)} px in 0.7 s), Space pauses it ("${pausedLabel}") and resumes, ↑ speeds it up`, s1 - s0 > 8 && Math.abs(p1 - p0) < 0.5 && pausedLabel === 'Resume text' && s2 > p1 + 5 && sp1[0] === sp0 + 1 && sp1[1] === sp0 + 1, JSON.stringify({ s0, s1, p0, p1, s2, sp0, sp1 }));
  await page.waitForTimeout(1500);
  const timeText = await ev(() => $('.rctime').textContent);
  const before = await ev(() => ({ main: P.main.length, overlay: P.overlay.length, audio: P.audio.length, undo: undo.length, media: M.size }));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !RC && $('#modal').hidden, null, { timeout: 60000 });
  const after = await ev(() => ({ main: P.main.length, overlay: P.overlay.length, audio: P.audio.length, undo: undo.length, media: M.size, app: APP.slice(), last: rcStop.last, toast: $('#toast').textContent,
    ended: [...DEV.user.getTracks(), ...DEV.screen.getTracks()].every(t => t.readyState === 'ended') }));
  check(`${rm}: the time runs (${timeText}); Esc stops: the app shows its window again, the devices are let go`, timeText === '0:03' && after.app.length === 2 && after.app[1][0] === false && after.ended, JSON.stringify({ timeText, app: after.app, ended: after.ended }));
  const cl = await ev(() => { const g = (l, c) => ({ ...c, kind: M.get(c.media).kind, name: M.get(c.media).name, file: M.get(c.media).file, w: M.get(c.media).w, h: M.get(c.media).h, rect: l === 'overlay' ? geom(M.get(c.media), c, P.w, P.h) : null });
    return { main: P.main.map(c => g('main', c)), ov: g('overlay', P.overlay.at(-1)), au: g('audio', P.audio.at(-1)), W: P.w, H: P.h }; });
  const scr = cl.main[1], cam = cl.ov, mic = cl.au;
  made.m.push(scr.media, cam.media, mic.media);
  check(`${rm}: three separate files: screen on the main track at the playhead (after the clip there), camera on the overlay track, mic on the audio track; one undo step`,
    after.main === before.main + 1 && after.overlay === before.overlay + 1 && after.audio === before.audio + 1 && after.undo === before.undo + 1 && after.media === before.media + 3
    && cl.main[0].media === V.id && Math.abs(scr.start - 3) < 1e-6 && scr.kind === 'video' && scr.w === 640 && cam.kind === 'video' && cam.w === 320 && mic.kind === 'audio' && new Set([scr.media, cam.media, mic.media]).size === 3,
    `${after.toast} | ${scr.name}, ${cam.name}, ${mic.name}`);
  const r = cam.rect;
  check(`${rm}: the camera is a picture-in-picture in the bottom-right corner (movable: an ordinary overlay clip)`, r.h > 0.2 * cl.H && r.h < 0.35 * cl.H && r.x + r.w > 0.9 * cl.W && r.x + r.w <= cl.W && r.y + r.h > 0.9 * cl.H && r.y + r.h <= cl.H, JSON.stringify(r));

  // ---- sync, in the files as placed on the timeline (clip start + file time - clip in) ----
  const tl = (c, t) => c.start + t - c.in, fs1 = flashes(`${HOME}/media/${scr.file}`), fc = flashes(`${HOME}/media/${cam.file}`), fb = beeps(`${HOME}/media/${mic.file}`);
  const S1 = fs1.on.map(t => tl(scr, t)), C1 = fc.on.map(t => tl(cam, t)), A1 = fb.map(t => tl(mic, t));
  const d1 = S1.map((t, i) => [C1[i] - t, A1[i] - t]), w1 = Math.max(...d1.flat().map(Math.abs));
  const truth = wall.map(W => after.last.O + (W - after.last.T0) / 1000), err = [S1, C1, A1].map(x => x.map((t, i) => ((t - truth[i]) * 1000).toFixed(1)).join(' '));
  check(`${rm}: in sync on the timeline: camera and mic within one frame of the screen at each of the 3 flashes`, S1.length === 3 && C1.length === 3 && A1.length === 3 && w1 <= FRAME,
    `vs when it happened (ms): screen ${err[0]}, camera ${err[1]}, mic ${err[2]}; camera, mic - screen (ms): ${d1.map(x => x.map(v => (v * 1000).toFixed(1)).join(' / ')).join(', ')}; mic delay ${(after.last.lat * 1000).toFixed(1)} ms heard ${after.last.heard}; leads ${[scr, cam, mic].map(c => `${c.start.toFixed(3)}@${c.in.toFixed(3)}`).join(' ')}`);
  check(`${rm}: the teleprompter is not in the recorded screen (only the fake screen's two levels in its frames)`, fs1.dark.every(y => Math.abs(y - fs1.dark[0]) < 3), `${fs1.dark.length} dark frames`);

  // ---- the same in an export ----
  const ex = await ev(async () => (await REMOTE.export({ format: 'mp4', resolution: '720p', name: `recorder-${Date.now()}` })));
  const ef = `${HOME}/exports/${ex.file}`, k = 720 / cl.H, er = { x: Math.round(r.x * k) + 8, y: Math.round(r.y * k) + 8, w: Math.round(r.w * k) - 16, h: Math.round(r.h * k) - 16 };
  const E = flashes(ef, '400:200:40:40').on.filter(t => t > 3), EC = flashes(ef, `${er.w}:${er.h}:${er.x}:${er.y}`).on.filter(t => t > 3), EA = beeps(ef).filter(t => t > 3.05);
  const d2 = E.map((t, i) => [EC[i] - t, EA[i] - t]), w2 = Math.max(...d2.flat().map(Math.abs));
  check(`${rm}: in sync in the export: the picture-in-picture's flash and the beep within one frame of the screen's`, E.length === 3 && EC.length === 3 && EA.length === 3 && w2 <= FRAME + 0.001,
    `pip, beep - screen (ms): ${d2.map(x => x.map(v => (v * 1000).toFixed(1)).join(' / ')).join(', ')}; screen flashes ${E.map(t => t.toFixed(3))} vs timeline ${S1.map(t => t.toFixed(3))}`);
  fs.rmSync(ef, { force: true });

  // ---- undo, redo, save and reload ----
  const ur = await ev(() => { const n = [P.main.length, P.overlay.length, P.audio.length]; restore(undo, redo); const u = [P.main.length, P.overlay.length, P.audio.length]; restore(redo, undo); return { n, u, r: [P.main.length, P.overlay.length, P.audio.length] }; });
  check(`${rm}: one undo takes all three clips away, redo brings them back`, ur.u.join() === [ur.n[0] - 1, ur.n[1] - 1, ur.n[2] - 1].join() && ur.r.join() === ur.n.join(), JSON.stringify(ur));
  await ev(() => flushSave());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(id => typeof P !== 'undefined' && P?.id === id, made.p.at(-1), { timeout: 20000 }).catch(() => {});
  const back = await ev(ids => ({ id: P.id, ok: P.main.some(c => c.media === ids[0]) && P.overlay.some(c => c.media === ids[1] && c.scale < 0.6) && P.audio.some(c => c.media === ids[2]) }), [scr.media, cam.media, mic.media]);
  check(`${rm}: the recording's clips come back after a reload`, back.id === made.p.at(-1) && back.ok, JSON.stringify(back));

  // ---- area mode: a crop on the clip; Esc in the countdown records nothing ----
  await install();
  const nAll = await ev(() => [P.main.length, M.size]);
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen');
  await page.selectOption('#rcScreen', 'area'); await page.click('#rcGo');
  await page.waitForSelector('.rcarea video');
  const box = await (await page.$('.rcarea')).boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7, { steps: 5 }); await page.mouse.up();
  await page.click('[data-rcarea="ok"]');
  await page.waitForFunction(() => RC?.phase === 'rec', null, { timeout: 10000 });
  await page.waitForTimeout(1200);
  await page.click('[data-rc="stop"]');
  await page.waitForFunction(() => !RC && $('#modal').hidden, null, { timeout: 60000 });
  const area = await ev(() => { const c = P.main.find(x => x.id === S.sel.id); return { crop: c.crop, media: [c.media, P.overlay.at(-1).media, P.audio.at(-1).media] }; });
  made.m.push(...area.media);
  const cr = area.crop || {};
  check(`${rm}: an area: the whole screen is kept, the clip cropped to the box dragged (widen it any time)`, Math.abs(cr.l - 0.25) < 0.02 && Math.abs(cr.r - 0.25) < 0.02 && Math.abs(cr.t - 0.2) < 0.02 && Math.abs(cr.b - 0.3) < 0.02, JSON.stringify(cr));
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen');
  await page.selectOption('#rcScreen', 'screen'); await page.click('#rcGo');
  await page.waitForFunction(() => RC?.phase === 'count', null, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !RC, null, { timeout: 10000 });
  const none = await ev(() => ({ n: [P.main.length, M.size], toast: $('#toast').textContent, ended: [...DEV.user.getTracks(), ...DEV.screen.getTracks()].every(t => t.readyState === 'ended'), app: APP.at(-1) }));
  check(`${rm}: Esc during the countdown: nothing recorded, the devices let go, the window shown again`, none.n[0] === nAll[0] + 1 && none.n[1] === nAll[1] + 3 && /nothing recorded/.test(none.toast) && none.ended && none.app[0] === false, JSON.stringify(none));

  // ---- refused permissions, in words ----
  const refused = async (fail, opts = {}) => {
    await ev(f => { DEV.fail = f; }, fail);
    await page.click('#btnRecord'); await page.waitForSelector('#rcScreen');
    await page.selectOption('#rcScreen', opts.screen || 'screen');
    if (opts.noMic) await page.click('#rcMic');
    await page.click('#rcGo');
    await page.waitForFunction(() => $('#rcStatus')?.textContent, null, { timeout: 10000 });
    const t = await ev(() => [$('#rcStatus').textContent, !!RC, !$('#rcGo').disabled]);
    if (opts.noMic) await page.click('#rcMic');
    await page.keyboard.press('Escape');
    await ev(() => { DEV.fail = {}; });
    return t;
  };
  const rs = await refused({ screen: 'NotAllowedError' }), rc = await refused({ user: 'NotAllowedError' }, { screen: 'none', noMic: true }), rn = await refused({ user: 'NotFoundError' }, { screen: 'none' });
  check(`${rm}: refused permissions say where to allow them: screen, camera; a missing device says so`,
    /Screen & System Audio Recording/.test(rs[0]) && /cancelled/.test(rs[0]) && /Privacy & Security > Camera\b/.test(rc[0]) && /^No camera( and microphone)? found/.test(rn[0]) && !rs[1] && rs[2] && !rc[1], `${rs[0]} | ${rc[0]} | ${rn[0]}`);
  await ev(() => { delete window.webkit; });
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.selectOption('#rcScreen', 'screen');
  const warn = await ev(() => !$('#rcHide').hidden && /teleprompter is in the recording/.test($('#rcHide').textContent));
  await page.selectOption('#rcScreen', 'window'); const warn2 = await ev(() => $('#rcHide').hidden);
  const kept = await ev(() => [$('#rcScript').value.split('\n').length, $('#rcMirror').checked]);
  await page.keyboard.press('Escape');
  check(`${rm}: in a browser (not the Mac app) a whole-screen recording warns the teleprompter would show; a window doesn't; the script and options are remembered`, warn && warn2 && kept[0] === 40 && kept[1] === (rm === 'reduce'), JSON.stringify({ warn, warn2, kept }));
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
  await ev(() => localStorage.removeItem('cutroom.rec'));
  await page.context().close();
}
await b.close();
for (const p of made.p) await fetch(`${B}/api/projects/${p}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
