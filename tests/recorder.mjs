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
const WIN = process.platform === 'win32'; // the page's words follow its OS: Windows' Settings and Edge, even with the Mac app's handler stubbed
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
  // the cursor poll (server.py cursor_poll reads the real pointer): synthetic here. Recorder time t (s); screens in points, the
  // recorded one (16:9, like the fake screen) second: the cursor rests, moves to (1180, 640) by 1 s, clicks at 1.3, types at 1.6, rests
  const CURPOS = t => (t < 0.6 ? [300, 250] : t < 1 ? [300 + ((t - 0.6) / 0.4) * 880, 250 + ((t - 0.6) / 0.4) * 390] : [1180, 640]);
  const CUR = { on: 0, off: 0, t0: 0 };
  await page.route(u => u.pathname === '/api/cursor', async q => {
    const body = JSON.parse(q.request().postData() || '{}');
    if (body.on) { CUR.on++; CUR.t0 = body.t0; return q.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }); }
    CUR.off++;
    const pts = Array.from({ length: 30 * 9 }, (_, i) => [i / 30, ...CURPOS(i / 30).map(v => v + 0)]).map(([t, x, y]) => [t, x, y]);
    q.fulfill({ contentType: 'application/json', body: JSON.stringify({ pts, ev: [[1.3, 'c', 1180, 640], [1.6, 'k', 1180, 640]], screens: [[-1920, 0, 1920, 1200], [0, 0, 1600, 900]] }) });
  });
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
      setInterval(() => { // a dark grid with a few blocks (zooming shows), white during a flash
        const now = performance.now(), on = FLASH.some(t => now >= t && now < t + 150);
        x.fillStyle = on ? '#fff' : bg; x.fillRect(0, 0, w, h);
        if (on) return;
        x.fillStyle = '#4a4a4a'; for (let i = 0; i < w; i += 40) x.fillRect(i, 0, 2, h); for (let j = 0; j < h; j += 40) x.fillRect(0, j, w, 2);
        x.fillStyle = '#7a2a2a'; x.fillRect(w * 0.7, h * 0.65, w * 0.08, h * 0.1); x.fillStyle = '#2a6a3a'; x.fillRect(w * 0.15, h * 0.2, w * 0.1, h * 0.12);
      }, 5);
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
    DEV.list ??= [['videoinput', 'cam-a', 'FaceTime HD Camera'], ['videoinput', 'cam-b', 'Desk camera'], ['audioinput', 'default', 'Default'], ['audioinput', 'mic-a', 'Built-in microphone'], ['audioinput', 'mic-b', 'USB microphone']];
    Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', { configurable: true, value: async () => DEV.list.map(([kind, deviceId, label]) => ({ kind, deviceId, label, groupId: '' })) });
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: async c => {
      if (DEV.fail.user) throw no(DEV.fail.user);
      DEV.userAsked = c;
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
  await page.waitForFunction(() => $('#rcCamDev').options.length === 3 && $('#rcMicDev').options.length === 3, null, { timeout: 5000 }).catch(() => {});
  const devs = await ev(() => [$$('#rcCamDev option').map(o => o.textContent), $$('#rcMicDev option').map(o => o.textContent), $('#rcCamDev').value, $('#rcMicDev').value]);
  await page.selectOption('#rcCamDev', 'cam-b'); await page.selectOption('#rcMicDev', 'mic-b');
  check(`${rm}: the dialog offers entire screen, a window, an area or none, camera and mic on; no browser warning in the Mac app`, dlg.opts.join() === 'screen,window,area,none' && dlg.cam && dlg.mic && dlg.hide, JSON.stringify(dlg));

  // ---- countdown, then recording ----
  await page.click('#rcGo');
  await page.waitForFunction(() => RC?.phase === 'count' && $('.rccount')?.textContent === '3', null, { timeout: 10000 });
  const cd = await ev(() => ({ app: APP.slice(), prompt: !!$('.rcprompt:not([hidden])'), mirror: getComputedStyle($('.rctext')).transform }));
  await page.waitForFunction(() => RC?.phase === 'rec', null, { timeout: 10000 });
  const asked = await ev(() => [DEV.userAsked.video?.deviceId, DEV.userAsked.audio?.deviceId]);
  check(`${rm}: camera and mic pickers list this computer's devices after the system default (picked first); the ones picked are the ones opened`,
    devs[0].join() === 'System default,FaceTime HD Camera,Desk camera' && devs[1].join() === 'System default,Built-in microphone,USB microphone' && devs[2] === '' && devs[3] === '' && asked.join() === 'cam-b,mic-b', JSON.stringify({ devs, asked }));
  check(`${rm}: a 3-2-1 countdown; the app hid its window from screen capture before the screen picker opened`, cd.app.length === 1 && cd.app[0][0] === true && cd.app[0][1] === 'open', JSON.stringify(cd.app));
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
  await page.waitForTimeout(2600);
  const timeText = await ev(() => $('.rctime').textContent);
  const before = await ev(() => ({ main: P.main.length, overlay: P.overlay.length, audio: P.audio.length, undo: undo.length, ids: [...M.keys()] }));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !RC && $('#modal').hidden, null, { timeout: 60000 });
  const after = await ev(() => ({ main: P.main.length, overlay: P.overlay.length, audio: P.audio.length, undo: undo.length, media: M.size, app: APP.slice(), last: rcStop.last, toast: $('#toast').textContent,
    ended: [...DEV.user.getTracks(), ...DEV.screen.getTracks()].every(t => t.readyState === 'ended') }));
  check(`${rm}: the time runs (${timeText}); Esc stops: the app shows its window again, the devices are let go`, /^0:0[3-5]$/.test(timeText) && after.app.length === 2 && after.app[1][0] === false && after.ended, JSON.stringify({ timeText, app: after.app, ended: after.ended }));
  const cl = await ev(() => { const g = (l, c) => ({ ...c, kind: M.get(c.media).kind, name: M.get(c.media).name, file: M.get(c.media).file, w: M.get(c.media).w, h: M.get(c.media).h, rect: l === 'overlay' ? geom(M.get(c.media), c, P.w, P.h) : null });
    return { main: P.main.map(c => g('main', c)), ov: g('overlay', P.overlay.at(-1)), au: g('audio', P.audio.at(-1)), W: P.w, H: P.h }; });
  const scr = cl.main[1], cam = cl.ov, mic = cl.au;
  made.m.push(scr.media, cam.media, mic.media);
  check(`${rm}: three separate files: screen on the main track at the playhead (after the clip there), camera on the overlay track, mic on the audio track; one undo step`,
    after.main === before.main + 1 && after.overlay === before.overlay + 1 && after.audio === before.audio + 1 && after.undo === before.undo + 1 && [scr.media, cam.media, mic.media].every(id => !before.ids.includes(id))
    && cl.main[0].media === V.id && Math.abs(scr.start - 3) < 1e-6 && scr.kind === 'video' && scr.w === 640 && cam.kind === 'video' && cam.w === 320 && mic.kind === 'audio' && new Set([scr.media, cam.media, mic.media]).size === 3,
    `${after.toast} | ${scr.name}, ${cam.name}, ${mic.name} | ${JSON.stringify({ before: { ...before, ids: before.ids.length }, after: { ...after, app: undefined, last: undefined }, start: scr.start, w: [scr.w, cam.w], kinds: [scr.kind, cam.kind, mic.kind], first: cl.main[0].media === V.id })}`);
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

  // ---- auto zoom: from the cursor track recorded with the screen ----
  await install();
  const track = await api(`/api/cursor/${scr.media}`, {});
  check(`${rm}: the screen file got its cursor track: on the recorded screen (the second, 16:9), in the file's time and frame`, CUR.on >= 1 && Math.abs(CUR.t0 - Date.now()) < 120000 && track.pts?.length > 200 && Math.abs(track.pts[0][1] - 300 / 1600) < 1e-3 && track.ev.length === 2 && Math.abs(track.ev[0][2] - 1180 / 1600) < 1e-3 && Math.abs(track.ev[0][3] - 640 / 900) < 1e-3,
    JSON.stringify({ on: CUR.on, pts: track.pts?.length, first: track.pts?.[0], ev: track.ev }));
  await ev(id => { S.sel = { lane: 'main', id }; S.t = 0; renderAll(); }, scr.id);
  await page.click('#inspector [data-itab="Tools"]');
  const azShown = await page.isVisible('#azAmt');
  await ev(() => { for (const [id, v] of [['azAmt', 2], ['azSmooth', 0.5]]) { const x = $(`#${id}`); x.value = v; x.dispatchEvent(new Event('input', { bubbles: true })); } });
  const u0 = await ev(() => undo.length);
  await page.click('#inspector [data-act="autozoom"]');
  await page.waitForFunction(id => P.main.find(c => c.id === id)?.kf?.length > 4, scr.id, { timeout: 10000 });
  const R = 0.35 + 0.9 * 0.5, Wd = await ev(() => [P.w, P.h]);
  const zs = await ev(([id, O, Rr]) => {
    const c = P.main.find(x => x.id === id), m = M.get(c.media), ct = t => O + t - c.start; // recorder time -> clip time
    const at = (t, u, v) => { const g = geom(m, c, P.w, P.h, propsAt(c, ct(t))); return { scale: propsAt(c, ct(t)).scale, px: Math.hypot(g.x + u * g.w - P.w / 2, g.y + v * g.h - P.h / 2) }; };
    return { n: c.kf.length, undo: undo.length, before: at(1.3 - Rr - 0.05, 0, 0).scale, ramp: at(1.3 - Rr / 2, 0, 0).scale, click: at(1.3, 1180 / 1600, 640 / 900), key: at(1.6, 1180 / 1600, 640 / 900), held: at(2.7, 0, 0).scale, out: at(2.8 + Rr + 0.05, 0, 0).scale, t: ct(1.5) + c.start, cc: ct(1.3) };
  }, [scr.id, after.last.O, R]);
  check(`${rm}: Auto zoom (Tools): fully in (2×) by the click and centred on it (${zs.click.px.toFixed(1)} px), on the typing (${zs.key.px.toFixed(1)} px); 1× before the ramp; one undo step`,
    azShown && zs.undo === u0 + 1 && Math.abs(zs.before - 1) < 1e-3 && zs.ramp > 1.05 && zs.ramp < 1.95 && Math.abs(zs.click.scale - 2) < 1e-3 && zs.click.px <= 4 && zs.key.px <= 12, JSON.stringify(zs));
  check(`${rm}: Auto zoom: still in while the cursor has rested under 1.2 s, back out after it rests`, Math.abs(zs.held - 2) < 1e-3 && Math.abs(zs.out - 1) < 1e-3, JSON.stringify({ held: zs.held, out: zs.out }));
  const far = await ev(id => { // the same clicks, but the cursor leaves for the far corner at 2.0 s: out sooner than resting
    const c = P.main.find(x => x.id === id), m = M.get(c.media);
    return api(`/api/cursor/${m.id}`, {}).then(tr => {
      const rest = azKeyframes(c, m, tr, 2, 0.5).zooms, leave = azKeyframes(c, m, { ...tr, pts: tr.pts.map(([t, u, v]) => (t > 2.0 ? [t, Math.max(0.05, u - (t - 2.0) * 3), Math.max(0.05, v - (t - 2.0) * 3)] : [t, u, v])) }, 2, 0.5).zooms;
      const smooth0 = azKeyframes(c, m, tr, 2.5, 0).kf, big = smooth0.reduce((b, f) => Math.max(b, f.scale), 0);
      return { rest, leave, big, first: smooth0[smooth0.findIndex(f => f.scale > 1.001) - 1]?.t }; // (first: where its ramp starts)
    });
  }, scr.id);
  check(`${rm}: Auto zoom: leaving the view zooms out at once (${far.leave[0]?.b.toFixed(2)} s, resting: ${far.rest[0]?.b.toFixed(2)} s); Zoom 2.5× and Smoothness 0 give 2.5× and a later, shorter ramp`,
    far.rest.length === 1 && far.leave.length === 1 && far.leave[0].b < 2.3 && far.rest[0].b > 2.5 && Math.abs(far.big - 2.5) < 1e-3 && far.first > zs.cc - R + 0.2 && far.first < zs.cc, JSON.stringify(far));
  const pe = await ev(async T => {
    S.sel = null; renderAll();
    const grab = async (t, preview) => { const s = await REMOTE.snapshot({ t, max: 640, preview }); const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${s.image}`)).blob()), c = new OffscreenCanvas(160, 90), g = c.getContext('2d'); g.drawImage(im, 0, 0, 160, 90); return g.getImageData(0, 0, 160, 90).data; };
    const [a, b, z0] = [await grab(T, false), await grab(T, true), await grab(T - 1.1, false)];
    let sum = 0, worst = 0, moved = 0;
    for (let by = 0; by < 90; by += 10) for (let bx = 0; bx < 160; bx += 10) { let s = 0; for (let y = by; y < by + 10; y++) for (let x = bx; x < bx + 10; x++) for (let k = 0; k < 3; k++) { const i = (y * 160 + x) * 4 + k; s += Math.abs(a[i] - b[i]); moved += Math.abs(a[i] - z0[i]); } sum += s; worst = Math.max(worst, s / 300); }
    return { mean: sum / (160 * 90 * 3), worst, moved: moved / (160 * 90 * 3) };
  }, zs.t);
  check(`${rm}: Auto zoom: preview == export while zoomed (mean ${pe.mean.toFixed(2)}, worst block ${pe.worst.toFixed(1)}); the zoom shows (vs 1×: ${pe.moved.toFixed(1)})`, pe.mean <= 4 && pe.worst <= 28 && pe.moved > 3, JSON.stringify(pe));
  await ev(() => restore(undo, redo));
  const az0 = await ev(id => !P.main.find(c => c.id === id).kf, scr.id);
  check(`${rm}: Auto zoom undoes in one step`, az0);
  const rz = await ev(id => REMOTE.auto_zoom({ id, amount: 1.5 }).catch(e => ({ error: e.message })), scr.id);
  const nz = await ev(id => P.main.find(c => c.id === id)?.kf?.reduce((b, f) => Math.max(b, f.scale), 0), scr.id).catch(() => 0);
  const bad = await ev(id => REMOTE.auto_zoom({ id }).then(() => 'no error', e => e.message), cl.main[0].id);
  check(`${rm}: REMOTE auto_zoom (the MCP's) zooms 1.5×; a clip without a cursor track is refused in words`, Math.abs(nz - 1.5) < 1e-3 && /screen recordings made in Cutroom/.test(bad), JSON.stringify({ rz, nz, bad }));

  // ---- area mode: a crop on the clip; Esc in the countdown records nothing ----
  await install();
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen');
  await page.selectOption('#rcScreen', 'area'); await page.click('#rcGo');
  await page.waitForSelector('.rcarea video');
  await page.waitForFunction(() => document.querySelector('.rcarea video').videoWidth > 0); // the box takes the picture's height once it loads (Edge: a moment later)
  await page.waitForTimeout(100);
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
  const nAll2 = await ev(() => [P.main.length, P.overlay.length, P.audio.length, undo.length]);
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen');
  await page.selectOption('#rcScreen', 'screen'); await page.click('#rcGo');
  await page.waitForFunction(() => RC?.phase === 'count', null, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !RC, null, { timeout: 10000 });
  const none = await ev(() => ({ n: [P.main.length, P.overlay.length, P.audio.length, undo.length], toast: $('#toast').textContent, ended: [...DEV.user.getTracks(), ...DEV.screen.getTracks()].every(t => t.readyState === 'ended'), app: APP.at(-1) }));
  check(`${rm}: Esc during the countdown: nothing recorded, the devices let go, the window shown again`, none.n.join() === nAll2.join() && /nothing recorded/.test(none.toast) && none.ended && none.app[0] === false, JSON.stringify(none));

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
  await ev(() => { Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { configurable: true, value: undefined }); });
  const rg = await refused({});
  await install(); // (the fake screen back)
  check(`${rm}: refused permissions say where to allow them: screen, camera; a missing device says so; no screen recording at all says what to do`,
    (WIN ? /allow screen sharing for this page/.test(rs[0]) : /Screen & System Audio Recording/.test(rs[0])) && /cancelled/.test(rs[0]) && /Privacy & Security > Camera\b/i.test(rc[0]) && /^No camera( and microphone)? found/.test(rn[0]) && !rs[1] && rs[2] && !rc[1]
    && (WIN ? /cannot record the screen.*The camera alone still works/ : /update macOS, or record the camera alone/).test(rg[0]) && !/macOS/.test(WIN ? rs[0] + rc[0] + rg[0] : '') && !/TypeError/.test(rg[0]), `${rs[0]} | ${rc[0]} | ${rn[0]} | ${rg[0]}`);

  // ---- a part the server refuses (disk full, the size cap): the take stops there, what was recorded is kept and placed ----
  let parts = 0;
  await page.route(u => /^\/api\/record\/[0-9a-f]{12}\.(mp4|webm)$/.test(u.pathname), async q => {
    const u = new URL(q.request().url());
    if (u.searchParams.get('done') || u.searchParams.get('abort') || parts++ < 4) return q.continue();
    q.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'the disk is nearly full: the recording stopped there, and what was recorded is kept' }) });
  });
  const nF = await ev(() => [P.main.length, P.overlay.length, P.audio.length]);
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.selectOption('#rcScreen', 'screen'); await page.click('#rcGo');
  await page.waitForFunction(() => !RC && $('#modal').hidden, null, { timeout: 30000 });
  const full = await ev(() => ({ n: [P.main.length, P.overlay.length, P.audio.length], toast: $('#toast').textContent, d: M.get(P.main.find(c => c.id === S.sel?.id)?.media)?.duration }));
  await page.unrouteAll({ behavior: 'ignoreErrors' }); // (then the two routes the rest needs, again)
  check(`${rm}: a refused part stops the take by itself, says why, and keeps and places what was recorded`, /^Stopped: the disk is nearly full/.test(full.toast) && full.n[0] === nF[0] + 1 && full.n[1] === nF[1] + 1 && full.d > 0.5, JSON.stringify(full));

  // ---- a page closed mid-take can't tell the server: its parts are swept once stale (at the next take, or the server's start) ----
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); });
  await page.route(u => u.pathname === '/api/cursor', q => q.fulfill({ contentType: 'application/json', body: '{"ok":true,"pts":[],"ev":[],"screens":[]}' }));
  const take = async ms => {
    await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.click('#rcGo');
    await page.waitForFunction(() => RC?.phase === 'rec', null, { timeout: 10000 });
    await page.waitForTimeout(ms);
  };
  const recs = () => fs.readdirSync(`${HOME}/cache`).filter(f => f.startsWith('rec-'));
  await take(2300);
  const midway = recs();
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
  await install();
  await new Promise(z => setTimeout(z, 1500));
  const left = recs(), old = (Date.now() - 11 * 60000) / 1000;
  for (const f of left) fs.utimesSync(`${HOME}/cache/${f}`, old, old); // (as if 11 minutes went by)
  await take(2600);
  const during = recs();
  await page.click('[data-rc="stop"]'); await page.waitForFunction(() => !RC && $('#modal').hidden, null, { timeout: 30000 });
  check(`${rm}: a page closed mid-take leaves its parts (${left.length}); the next take sweeps them once stale; a finished take leaves none (${recs().length})`,
    midway.length === 2 && left.length === 2 && during.length === 2 && !during.some(f => left.includes(f)) && recs().length === 0, JSON.stringify({ midway, left, during, end: recs() }));

  // ---- in a browser (not the Mac app): a whole-screen take with the teleprompter on warns before the countdown ----
  await ev(() => { delete window.webkit; });
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.selectOption('#rcScreen', 'screen'); await page.click('#rcGo');
  await page.waitForSelector('[data-rcwarn="window"]');
  const wtext = await ev(() => [$('#modal h2').textContent, RC?.phase]);
  await page.click('[data-rcwarn="window"]');
  await page.waitForFunction(() => RC?.phase === 'count', null, { timeout: 10000 });
  const asked2 = await ev(() => DEV.screenAsked.video.displaySurface);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !RC, null, { timeout: 10000 });
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.selectOption('#rcScreen', 'screen'); await page.click('#rcGo');
  await page.waitForSelector('[data-rcwarn="go"]'); await page.click('[data-rcwarn="go"]');
  const anyway = await page.waitForFunction(() => RC?.phase === 'count', null, { timeout: 10000 }).then(() => true, () => false);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !RC, null, { timeout: 10000 });
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.selectOption('#rcScreen', 'screen'); await page.click('#rcGo');
  await page.waitForSelector('[data-rcwarn="cancel"]'); await page.keyboard.press('Escape');
  await page.waitForFunction(() => !RC, null, { timeout: 10000 });
  const cancelled = await ev(() => [$('#toast').textContent, DEV.screen.getTracks().every(t => t.readyState === 'ended')]);
  check(`${rm}: in a browser, a whole-screen take with the teleprompter warns before the countdown ("${wtext[0]}"): capture a window instead (asks for a window), record anyway, or Esc cancels`,
    wtext[1] === 'warn' && /teleprompter will be in this recording/.test(wtext[0]) && asked2 === 'window' && anyway && /nothing recorded/.test(cancelled[0]) && cancelled[1], JSON.stringify({ wtext, asked2, anyway, cancelled }));
  await page.click('#btnRecord'); await page.waitForSelector('#rcScreen'); await page.selectOption('#rcScreen', 'screen');
  const warn = await ev(() => !$('#rcHide').hidden && /teleprompter is in the recording/.test($('#rcHide').textContent));
  await page.selectOption('#rcScreen', 'window'); const warn2 = await ev(() => $('#rcHide').hidden);
  const kept = await ev(() => [$('#rcScript').value.split('\n').length, $('#rcMirror').checked]);
  await page.waitForFunction(() => $('#rcCamDev').options.length === 3, null, { timeout: 5000 }).catch(() => {});
  const devKept = await ev(() => [$('#rcCamDev').value, $('#rcMicDev').value]);
  await page.keyboard.press('Escape');
  await ev(() => { DEV.list = DEV.list.filter(d => d[1] !== 'cam-b'); }); // unplugged
  await page.click('#btnRecord'); await page.waitForSelector('#rcCamDev');
  await page.waitForFunction(() => $('#rcCamDev').options.length === 2, null, { timeout: 5000 }).catch(() => {});
  const devGone = await ev(() => [$('#rcCamDev').value, $('#rcMicDev').value]);
  await page.keyboard.press('Escape');
  check(`${rm}: the picked camera and mic are remembered; an unplugged one falls back to the system default`, devKept.join() === 'cam-b,mic-b' && devGone.join() === ',mic-b', JSON.stringify({ devKept, devGone }));
  check(`${rm}: in a browser (not the Mac app) a whole-screen recording warns the teleprompter would show; a window doesn't; the script and options are remembered`, warn && warn2 && kept[0] === 40 && kept[1] === (rm === 'reduce'), JSON.stringify({ warn, warn2, kept }));
  if (rm === 'no-preference') { // ---- a long recording (5.5 min, busy): its keyframes thin to well under the export's 2000, the motion unchanged, and it exports ----
    const L = `${tmp}/rec-long.mp4`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=330', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', L]);
    const LV = await (await fetch(`${B}/api/import?name=rec-long.mp4`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(L) })).json();
    made.m.push(LV.id);
    const pts = [], evs = [];
    let seed = 7, from = [0.5, 0.5], to = from, t0 = 0;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i <= 330 * 30; i++) { // working: every 4 s the cursor goes somewhere new, clicks, types, and wobbles a little in between
      const t = i / 30;
      if (t >= t0 + 4) { from = to; to = [0.08 + 0.84 * rnd(), 0.08 + 0.84 * rnd()]; t0 = t; }
      const q = Math.min(1, (t - t0) / 0.5), e = q * q * (3 - 2 * q), u = from[0] + (to[0] - from[0]) * e + 0.01 * Math.sin(t * 3), v = from[1] + (to[1] - from[1]) * e + 0.01 * Math.cos(t * 2.3);
      pts.push([t, +u.toFixed(5), +v.toFixed(5)]);
      if (i % 120 === 24) evs.push([t, 'c', +u.toFixed(5), +v.toFixed(5)]);
      if (i % 120 === 54) evs.push([t, 'k', +u.toFixed(5), +v.toFixed(5)]);
    }
    await api(`/api/cursor/${LV.id}`, { track: { pts, ev: evs } });
    await ev(() => loadMedia());
    await page.waitForFunction(id => M.get(id)?.ready && M.get(id).cursor, LV.id, { timeout: 120000 });
    const lr = await ev(async id => {
      setProject(newProject('16:9')); P.name = 'Recorder long test (scratch)'; P.fps = 24; renderAll(); addMedia(id, 'main', 0);
      const c = P.main[0], m = M.get(id), r = await REMOTE.auto_zoom({ id: c.id, amount: 2, smooth: 0.5 });
      const dense = azKeyframes(c, m, await api(`/api/cursor/${id}`, {}), 2, 0.5).dense;
      let worst = 0;
      for (const f of dense) { const a = geom(m, c, P.w, P.h, propsAt(c, f.t)), b = geom(m, c, P.w, P.h, f); worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w)); }
      return { pid: P.id, n: c.kf.length, dense: dense.length, zooms: r.zooms.length, worst, W: P.w };
    }, LV.id);
    made.p.push(lr.pid);
    const lx = await ev(() => REMOTE.export({ format: 'mp4', resolution: '720p', name: `recorder-long-${Date.now()}` }).catch(e => ({ error: e.message })));
    const lf = lx.file && `${HOME}/exports/${lx.file}`, ld = lf && fs.existsSync(lf) ? +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', lf], { encoding: 'utf8' }) : 0;
    check(`${rm}: a 5.5 min recording, a click and typing every 4 s all over the screen: ${lr.zooms} zooms in ${lr.n} keyframes (from ${lr.dense} samples; the export takes 2000), within ${lr.worst.toFixed(2)} px of the full motion; it exports (${ld.toFixed(1)} s)`,
      lr.n <= 1500 && lr.dense > 2000 && lr.worst <= 1 && Math.abs(ld - 330) < 1, JSON.stringify({ ...lr, lx }));
    if (lf && fs.existsSync(lf)) fs.unlinkSync(lf);
  }
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
  await ev(() => localStorage.removeItem('cutroom.rec'));
  await page.context().close();
}
await b.close();
// a recording's cursor track goes to the trash with it and comes back on restore (emptying the trash purges it)
const sid = made.m[1], side = `${HOME}/media/${sid}.cursor`, hadSide = fs.existsSync(side);
await fetch(`${B}/api/media/${sid}/trash`, { method: 'POST', headers: H, body: '{}' });
const inTrash = !fs.existsSync(side) && fs.existsSync(`${HOME}/trash/media/${sid}.cursor`);
await fetch(`${B}/api/media/${sid}/restore`, { method: 'POST', headers: H, body: '{}' });
const back = fs.existsSync(side) && (await api('/api/media')).find(m => m.id === sid)?.cursor === true;
for (const p of made.p) await fetch(`${B}/api/projects/${p}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.rmSync(tmp, { recursive: true, force: true });
check('a screen recording\'s cursor track goes to the trash with it and comes back on restore', hadSide && inTrash && back, JSON.stringify({ hadSide, inTrash, back }));
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
