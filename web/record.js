// SPDX-License-Identifier: GPL-3.0-or-later
// Recorder: the screen (whole screen, a window or an area), the camera and the mic, each saved as its OWN file and placed in
// sync at the playhead (screen on the main track, camera on the overlay track as a picture-in-picture you can move or resize
// later, the mic on the audio track), with a teleprompter that scrolls by the camera and is never in the recording.
//
// Capture path, per platform (why this one):
// - Mac app (WKWebView): getDisplayMedia works there once the app answers WebKit's display-capture request (app/Cutroom.swift);
//   macOS then shows its own screen / window picker, which is also the permission. So one code path with the browser, and no
//   native recorder to keep in step with this one. While recording the app hides its own window from screen capture
//   (NSWindow.sharingType = .none, which ScreenCaptureKit honours, and WebKit records through ScreenCaptureKit): the
//   teleprompter, countdown and camera preview are never in the recording, even of the whole screen.
// - Windows (Edge) and other browsers: getDisplayMedia with the browser's picker. A page can't hide its own window from a
//   whole-screen capture, so the dialog says so (record a window, or keep this window on another screen).
//   ponytail: a small native prompter window with SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) would close that gap on Windows.
// - Camera and mic: getUserMedia everywhere.
// Sync: the screen and camera recorders start in the same task and their files count from start() (measured: a flash at
// start + 1 s lands at 1.00-1.03 s in WebKit and Chromium; WebKit's first frame sits 43 ms in, which the server's remux reports
// as 'lead'). The mic is the voiceover's sample-stamped capture (REC_JS in app.js): the countdown's blips, heard by the mic,
// measure its delay, as for a voiceover (with headphones: the last measured delay).
let RC = null; // the recording under way: { phase: 'open' | 'area' | 'count' | 'rec' | 'saving', ... }
const RC_TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
const RC_APP = () => window.webkit?.messageHandlers?.record; // the Mac app: hides its window from screen capture while recording
const rcHtml = (el, h) => el.replaceChildren(document.createRange().createContextualFragment(h)); // (fixed markup; user text goes in by textContent)
function rcOpts() {
  let o = {};
  try { o = JSON.parse(store.get('cutroom.rec') || '{}'); } catch { /* defaults */ }
  return { screen: 'screen', cam: true, mic: true, camDev: '', micDev: '', script: '', speed: 3, size: 34, mirror: false, ...o }; // (kept in this computer's browser storage: devices are per computer)
}
function rcRead() { // the dialog -> the options (remembered for next time)
  const o = { screen: $('#rcScreen').value, cam: $('#rcCam').checked, mic: $('#rcMic').checked, camDev: $('#rcCamDev').value, micDev: $('#rcMicDev').value, script: $('#rcScript').value, speed: +$('#rcSpeed').value, size: +$('#rcSize').value, mirror: $('#rcMirror').checked };
  store.set('cutroom.rec', JSON.stringify(o));
  return o;
}
function rcSay(msg) { const s = $('#rcStatus'); if (s) s.textContent = msg; else toast(msg); }
function openRecorder() {
  if (RC) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return toast('Recording needs a newer browser: Edge or Chrome on Windows, or the Cutroom app on a Mac');
  const o = rcOpts(), opt1 = (v, t) => `<option value="${v}"${o.screen === v ? ' selected' : ''}>${t}</option>`;
  modal(`<h2>Record</h2>
    <label class="row"><span>Screen</span><select id="rcScreen">${opt1('screen', 'Entire screen')}${opt1('window', 'A window')}${opt1('area', 'An area of the screen')}${opt1('none', 'No screen')}</select></label>
    <label class="row chk"><span>Camera</span><input id="rcCam" type="checkbox"${o.cam ? ' checked' : ''}></label>
    <label class="row"><span>Which camera</span><select id="rcCamDev"><option value="">System default</option></select></label>
    <label class="row chk"><span>Microphone</span><input id="rcMic" type="checkbox"${o.mic ? ' checked' : ''}></label>
    <label class="row"><span>Which microphone</span><select id="rcMicDev"><option value="">System default</option></select></label>
    <p id="rcHide" class="hint" hidden>This browser can't keep its own window out of a whole-screen recording: if this window is on the recorded screen, the teleprompter is in the recording too. Record a window, or move this one to another screen.</p>
    <h4>Teleprompter</h4>
    <textarea id="rcScript" rows="5" spellcheck="true" placeholder="Paste the script to read. It scrolls by the camera while you record and is never in the recording."></textarea>
    <label class="row"><span>Speed</span><input id="rcSpeed" type="range" min="1" max="10" step="1" value="${+o.speed || 3}"><output>${+o.speed || 3}</output></label>
    <label class="row"><span>Text size</span><select id="rcSize">${[[24, 'Small'], [34, 'Medium'], [46, 'Large']].map(([v, t]) => `<option value="${v}"${+o.size === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="row chk"><span>Mirror the text (for a teleprompter glass)</span><input id="rcMirror" type="checkbox"${o.mirror ? ' checked' : ''}></label>
    <p class="hint">A countdown, then it records. Space pauses the teleprompter, the arrow keys change its speed, Esc stops. Screen, camera and sound are saved as separate files and placed in sync at the playhead, so you can rearrange them later.</p>
    <p id="rcStatus" class="muted" role="status"></p>
    <div class="actions"><button data-close>Cancel</button><button id="rcGo" class="primary">Start recording</button></div>`, 'recd');
  $('#rcScript').value = o.script;
  const sp = $('#rcSpeed'), hide = () => { $('#rcHide').hidden = !!RC_APP() || $('#rcScreen').value !== 'screen'; };
  fill(sp); hide();
  sp.addEventListener('input', () => { fill(sp); sp.nextElementSibling.textContent = sp.value; });
  $('#rcScreen').addEventListener('change', hide);
  rcDevices(o);
  $('#rcGo').addEventListener('click', rcStart);
}
async function rcDevices(o) { // the camera and mic lists (names show once the browser has been allowed a device), the remembered one picked
  const list = await navigator.mediaDevices.enumerateDevices?.().catch(() => []) || [];
  for (const [kind, sel, id, word] of [['videoinput', '#rcCamDev', o.camDev, 'Camera'], ['audioinput', '#rcMicDev', o.micDev, 'Microphone']]) {
    const el = $(sel);
    if (!el) return;
    list.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default').forEach((d, i) => el.add(new Option(d.label || `${word} ${i + 1}`, d.deviceId)));
    el.value = [...el.options].some(x => x.value === id) ? id : ''; // gone (unplugged): the system default
  }
}
function rcWhy(what, e) { // a refused or failed device, in words: what to do about it
  const n = e?.name;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `No ${what} found: connect one, or turn it off here`;
  if (n === 'NotReadableError' || n === 'AbortError') return `The ${what} could not start: another app may be using it`;
  if (n !== 'NotAllowedError' && n !== 'SecurityError') return `The ${what} could not start: ${e?.message || e}`;
  const pane = { screen: 'Screen & System Audio Recording', camera: 'Camera', microphone: 'Microphone', 'camera and microphone': 'Camera, then Microphone' }[what]; // (two separate pages, on both systems)
  if (IS_WIN) return what === 'screen' ? 'Screen sharing was cancelled or blocked. Press Start recording again, pick a screen or a window and press Share. If Edge does not ask, allow screen sharing for this page (the icon left of the address)'
    : `The ${what} is blocked. In Windows: Settings > Privacy & security > ${pane}, let desktop apps use it. In Edge: allow it for this page (the icon left of the address)`;
  if (RC_APP()) return what === 'screen' ? 'Screen recording was cancelled or is not allowed. If you did not cancel it: System Settings > Privacy & Security > Screen & System Audio Recording, turn on Cutroom, then quit and reopen Cutroom'
    : `The ${what} is not allowed. System Settings > Privacy & Security > ${pane}: turn on Cutroom, then try again`;
  return `The ${what} is blocked: allow it for this page in the browser (the icon left of the address)${IS_MAC ? `, and in System Settings > Privacy & Security > ${pane} for the browser` : ''}`;
}
async function rcStart() {
  const o = rcRead();
  if (o.screen === 'none' && !o.cam && !o.mic) return rcSay('Turn on something to record: the screen, the camera or the microphone');
  const r = (RC = { o, phase: 'open', speed: o.speed, y: 0, paused: false });
  $('#rcGo').disabled = true;
  try {
    RC_APP()?.postMessage(true); // the Mac app's window leaves screen capture before the picker opens (teleprompter, countdown, preview)
    if (o.screen !== 'none') {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error(RC_APP() && !IS_WIN ? 'This version of macOS does not let Cutroom record the screen: update macOS, or record the camera alone (Screen: No screen)'
        : 'This browser cannot record the screen: use Edge or Chrome, or the Cutroom app on a Mac. The camera alone still works (Screen: No screen)');
      const pick = surface => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, cursor: 'always', displaySurface: surface }, audio: false }).catch(e => { throw new Error(rcWhy('screen', e)); });
      r.screen = await pick(o.screen === 'window' ? 'window' : 'monitor');
      // a browser can't keep its own window out of a whole-screen capture: with the teleprompter on, say so before the countdown
      while (!RC_APP() && o.script.trim() && rcSurface(r.screen, o) === 'monitor') {
        const k = await rcWarn(r);
        if (k === 'go') break;
        r.screen.getTracks().forEach(t => t.stop());
        if (k === 'cancel') return rcEnd(r, 'Cancelled: nothing recorded');
        r.screen = await pick('window');
        o.screen = 'window';
      }
      r.phase = 'open';
    }
    if (o.cam || o.mic) {
      const what = o.cam && o.mic ? 'camera and microphone' : o.cam ? 'camera' : 'microphone';
      try { r.user = await navigator.mediaDevices.getUserMedia({ video: o.cam && { ...(o.camDev && { deviceId: o.camDev }), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: o.mic && { ...(o.micDev && { deviceId: o.micDev }), echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); } catch (e) { throw new Error(rcWhy(what, e)); } // (echo cancelling would take the blips out)
    }
    if (o.screen === 'area') {
      r.crop = await rcArea(r);
      if (!r.crop) return rcEnd(r, 'Cancelled: nothing recorded');
    }
    await rcRun(r);
  } catch (e) {
    rcEnd(r);
    if ($('#rcStatus')) { rcSay(e.message); $('#rcGo').disabled = false; } else { closeModal(); toast(e.message); }
  }
}
const rcSurface = (s, o) => s.getVideoTracks()[0]?.getSettings().displaySurface || (o.screen === 'window' ? 'window' : 'monitor'); // (WebKit doesn't say: what was asked for)
function rcWarn(r) { // -> 'go' | 'window' | 'cancel'
  return new Promise(done => {
    r.phase = 'warn';
    const d = $('#modal .dialog');
    rcHtml(d, `<h2>The teleprompter will be in this recording</h2>
      <p class="hint">You are recording the whole screen, and a browser can't keep its own window out of that: if this window is on the recorded screen, the script shows in the recording. Capture a window instead (the app you are showing), or move this window to another screen.</p>
      <div class="actions"><button data-rcwarn="cancel">Cancel</button><button data-rcwarn="go">Record anyway</button><button data-rcwarn="window" class="primary">Capture a window instead</button></div>`);
    d.addEventListener('click', e => { const k = e.target.dataset?.rcwarn; if (k) done(k); }, { once: false });
    r.cancel = () => done('cancel');
  });
}
function rcArea(r) { // drag over the live screen: the part to keep (a crop on the clip, so it can be widened later) -> {l,t,r,b} | {} (all) | null
  return new Promise(done => {
    r.phase = 'area';
    const d = $('#modal .dialog');
    d.classList.add('wide');
    rcHtml(d, `<h2>Drag over the area to record</h2><div class="rcarea"><video autoplay muted playsinline></video><div class="rcbox" hidden></div></div>
      <p class="hint">The whole screen is recorded and the clip is cropped to this area, so you can widen it later.</p>
      <div class="actions"><button data-rcarea="cancel">Cancel</button><button data-rcarea="all">Whole screen</button><button data-rcarea="ok" class="primary" disabled>Record this area</button></div>`);
    const v = $('video', d), wrap = $('.rcarea', d), box = $('.rcbox', d), ok = $('[data-rcarea="ok"]', d);
    v.srcObject = r.screen; v.play().catch(() => {});
    let a = null;
    wrap.addEventListener('pointerdown', e => {
      const R = wrap.getBoundingClientRect(), at = ev => [clamp((ev.clientX - R.left) / R.width, 0, 1), clamp((ev.clientY - R.top) / R.height, 0, 1)], [x0, y0] = at(e);
      wrap.setPointerCapture(e.pointerId);
      const mv = ev => {
        const [x1, y1] = at(ev);
        a = { l: Math.min(x0, x1), t: Math.min(y0, y1), r: 1 - Math.max(x0, x1), b: 1 - Math.max(y0, y1) };
        Object.assign(box.style, { left: `${a.l * 100}%`, top: `${a.t * 100}%`, right: `${a.r * 100}%`, bottom: `${a.b * 100}%` });
        box.hidden = false; ok.disabled = 1 - a.l - a.r < 0.05 || 1 - a.t - a.b < 0.05;
      };
      wrap.addEventListener('pointermove', mv);
      wrap.addEventListener('pointerup', () => wrap.removeEventListener('pointermove', mv), { once: true });
    });
    const end = k => { v.srcObject = null; done(k === 'cancel' ? null : k === 'all' ? {} : a); };
    d.addEventListener('click', e => { const k = e.target.dataset?.rcarea; if (k) end(k); });
    r.cancel = () => end('cancel');
  });
}
function rcRecorder(stream, bps, fail) { // a MediaRecorder sending its file to the server a second at a time (record_part in server.py)
  const type = RC_TYPES.find(t => MediaRecorder.isTypeSupported(t)), ext = /mp4/.test(type) ? 'mp4' : 'webm', id = hex12(), url = `/api/record/${id}.${ext}`;
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bps });
  let chain = Promise.resolve();
  const send = (b, q = '') => { // in order; a refused part (disk full, the size cap) leaves what came before it whole
    const p = chain.then(async () => {
      const x = await fetch(url + q, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: b }), j = await x.json().catch(() => ({}));
      if (!x.ok) throw new Error(j.error || 'saving the recording failed');
      return j;
    });
    chain = p.catch(() => {});
    return p;
  };
  mr.addEventListener('dataavailable', e => { if (e.data.size) send(e.data).catch(fail); });
  const stopped = new Promise(z => mr.addEventListener('stop', z, { once: true }));
  return {
    mr,
    async finish(name) { if (mr.state !== 'inactive') mr.stop(); await stopped; const m = await send(new Blob([]), `?done=1&name=${encodeURIComponent(name)}`); this.done = true; return m; },
    abort() { // given up (cancelled, failed): the server drops the part now. A page closed mid-take can't say so: the server sweeps those (record_part)
      try { if (mr.state !== 'inactive') mr.stop(); } catch { /* stopped already */ }
      if (!this.done) fetch(`${url}?abort=1`, { method: 'POST', headers: { 'X-Cutroom': '1' }, keepalive: true }).catch(() => {});
      this.done = true;
    },
  };
}
const rcPx = r => r.speed * 0.18 * r.o.size; // teleprompter speed 1-10 -> pixels a second (3 at Medium: about a line every 2.5 s)
async function rcRun(r) {
  const o = r.o, d = $('#modal .dialog'), lines = o.script.trim();
  r.phase = 'count';
  d.className = 'dialog recd recording';
  rcHtml(d, `<div class="rcprompt${o.mirror ? ' mirror' : ''}" style="--rcsize:${+o.size}px"${lines ? '' : ' hidden'}><div class="rctext"></div></div>
    <div class="rccount" aria-live="assertive"></div>
    <div class="rcbar"><span class="rcdot" aria-hidden="true"></span><span class="rctime" title="Recording time">0:00</span><video class="rccam" muted playsinline hidden></video>
      <label class="rcspeed"${lines ? '' : ' hidden'}><span>Speed</span><input type="range" min="1" max="10" step="1" value="${+r.speed}" aria-label="Teleprompter speed"></label>
      <button data-rc="pause"${lines ? '' : ' hidden'}>Pause text</button><button data-rc="stop" class="primary">Stop</button></div>`);
  $('.rctext', d).textContent = lines;
  const cam = r.user?.getVideoTracks().length ? new MediaStream(r.user.getVideoTracks()) : null, sp = $('.rcspeed input', d);
  if (cam) { const v = $('.rccam', d); v.hidden = false; v.srcObject = cam; v.play().catch(() => {}); }
  fill(sp);
  sp.addEventListener('input', () => { r.speed = +sp.value; fill(sp); });
  d.addEventListener('click', e => { const k = e.target.dataset?.rc; if (k === 'stop') rcStop(r); else if (k === 'pause') rcPause(r); });
  // the mic, from before the count-in: its blips measure the mic's delay
  audioOn();
  await actx.resume();
  const A = actx, sr = A.sampleRate, au = r.user?.getAudioTracks() || [];
  if (au.length) {
    await (recMod ??= A.audioWorklet.addModule(URL.createObjectURL(new Blob([REC_JS], { type: 'text/javascript' }))));
    const m = (r.mic = { parts: [], f1: 0 });
    m.src = A.createMediaStreamSource(new MediaStream(au)); m.node = new AudioWorkletNode(A, 'cutroom-rec');
    m.node.port.onmessage = ({ data: [f, x] }) => {
      if (m.f0 === undefined) m.f0 = m.f1 = f;
      if (f > m.f1) m.parts.push(new Float32Array(f - m.f1)); // a block the graph skipped: silence keeps the time
      m.parts.push(x); m.f1 = f + x.length;
    };
    m.src.connect(m.node).connect(A.destination);
  }
  const tpl = blip(sr), bb = new AudioBuffer({ length: tpl.length, sampleRate: sr, numberOfChannels: 1 }), at0 = A.currentTime + 0.3;
  bb.copyToChannel(tpl, 0);
  r.blips = { tpl, at0 };
  for (let k = 0; k < 3; k++) { const s = A.createBufferSource(); s.buffer = bb; s.connect(A.destination); s.start(at0 + k); }
  const cnt = $('.rccount', d);
  for (let k = 0; k < 3; k++) {
    await sleep(Math.max(0, (at0 + k - A.currentTime) * 1000));
    if (RC !== r) return;
    cnt.textContent = String(3 - k);
  }
  await sleep(Math.max(0, (at0 + 3 - A.currentTime) * 1000));
  if (RC !== r) return;
  cnt.textContent = '';
  // the recorders, in one task: their files share a start
  r.recs = [];
  const fail = e => { if (r.phase === 'rec' && !r.why) { r.why = e.message; rcStop(r); } }; // a part refused: stop, keep what was recorded, say why
  if (r.screen) r.recs.push({ kind: 'screen', rec: rcRecorder(r.screen, 10e6, fail) });
  if (cam) r.recs.push({ kind: 'camera', rec: rcRecorder(cam, 4e6, fail) });
  r.T0 = performance.now(); r.wall0 = Date.now();
  for (const x of r.recs) x.rec.mr.start(1000);
  if (r.screen && o.screen !== 'window') r.cur = api('/api/cursor', { on: true, t0: r.wall0 }).catch(() => null); // auto zoom's data (a window's place on the screen isn't known)
  r.ts = A.getOutputTimestamp();
  r.phase = 'rec';
  r.screen?.getVideoTracks()[0]?.addEventListener('ended', () => rcStop(r)); // "Stop sharing" in the system's bar
  const tm = $('.rctime', d);
  r.timer = setInterval(() => { tm.textContent = fmtDur((performance.now() - r.T0) / 1000); }, 250);
  const box = $('.rcprompt', d);
  let last = performance.now();
  const roll = now => { // the teleprompter: scrolls at its speed until paused (the same in both motion modes: reading it is the point)
    if (RC !== r || r.phase !== 'rec') return;
    if (!r.paused) { r.y = Math.min(r.y + rcPx(r) * Math.min(0.1, (now - last) / 1000), box.scrollHeight); box.scrollTop = r.y; }
    last = now;
    requestAnimationFrame(roll);
  };
  requestAnimationFrame(roll);
}
function rcPause(r) {
  r.paused = !r.paused;
  const b = $('[data-rc="pause"]');
  if (b) b.textContent = r.paused ? 'Resume text' : 'Pause text';
}
function rcEnd(r, msg) { // let go of every device; the Mac app shows its window to screen capture again
  for (const s of [r.screen, r.user]) s?.getTracks().forEach(t => t.stop());
  r.mic?.src.disconnect(); r.mic?.node.disconnect();
  clearInterval(r.timer);
  for (const x of r.recs || []) x.rec.abort(); // (a finished one is kept)
  if (r.cur) { r.cur = null; api('/api/cursor', { on: false }).catch(() => {}); }
  RC_APP()?.postMessage(false);
  if (RC === r) RC = null;
  if (msg) { closeModal(); toast(msg); }
}
async function rcStop(r) {
  if (r.phase === 'count') return rcEnd(r, 'Stopped during the countdown: nothing recorded');
  if (r.phase !== 'rec') return;
  r.phase = 'saving';
  rcStop.last = {};
  const secs = (performance.now() - r.T0) / 1000, name = `Recording ${new Date().toLocaleTimeString().replace(/:/g, '.')}`;
  const d = $('#modal .dialog');
  if (d) rcHtml(d, '<h2>Saving the recording…</h2><p class="hint">Each source is saved as its own file.</p>');
  try {
    for (const x of r.recs) if (x.rec.mr.state !== 'inactive') x.rec.mr.stop();
    const parts = [];
    for (const x of r.recs) {
      const m = await x.rec.finish(`${name} ${x.kind}`);
      parts.push({ media: m.id, kind: x.kind, lead: m.lead || 0, dur: m.duration, w: m.w, h: m.h });
    }
    if (r.mic) parts.push(await rcMicTake(r, `${name} mic`));
    const sp = parts.find(p => p.kind === 'screen');
    if (r.cur && sp) await rcCursorSave(r, sp).catch(() => {}); // (a recording without it still lands, without auto zoom)
    await loadMedia();
    rcStop.last = { ...rcStop.last, T0: r.T0, O: rcPlace(parts, r.crop) }; // (for tests: the timeline time of the recorders' start)
    rcEnd(r);
    closeModal();
    const scr = parts.some(p => p.kind === 'screen');
    toast(`${r.why ? `Stopped: ${r.why}. ` : ''}Recorded ${fmtDur(secs)}: ${[scr && 'screen on the main track', parts.some(p => p.kind === 'camera') && (scr ? 'camera as a picture-in-picture (drag it on the preview to move it)' : 'camera on the main track'), r.mic && 'sound on the audio track'].filter(Boolean).join(', ')}`);
  } catch (e) { rcEnd(r, `The recording could not be saved: ${e.message}`); }
}
async function rcMicTake(r, name) { // the mic's samples from the recorders' start, as a WAV, its delay corrected
  const m = r.mic, sr = actx.sampleRate;
  m.src.disconnect(); m.node.disconnect();
  if (m.f0 === undefined) throw new Error('no sound came in from the microphone');
  const x = new Float32Array(m.f1 - m.f0), c0 = m.f0 / sr, lags = [];
  for (let o = 0, i = 0; i < m.parts.length; o += m.parts[i++].length) x.set(m.parts[i], o);
  for (let k = 0; k < 3; k++) { // each blip in the take: the mic's delay (speakers to graph), unless headphones kept them out
    const i0 = Math.round((r.blips.at0 + k - c0) * sr), [l, q] = i0 >= 0 ? blipLag(x, i0, r.blips.tpl, Math.round(0.4 * sr)) : [0, 0];
    if (q > 0.3) lags.push(l / sr);
  }
  lags.sort((a, b) => a - b);
  const heard = lags.length === 3 && lags[2] - lags[0] < 0.002;
  if (heard) store.set('cutroom.micDelay', lags[1]);
  const lat = heard ? lags[1] : +(store.get('cutroom.micDelay') ?? r.user.getAudioTracks()[0]?.getSettings().latency ?? 0) || 0;
  // a sample at context time c was heard at the wall time the speakers played c - lat; the recorders started at r.T0
  const w0 = r.ts.performanceTime + (c0 - lat - r.ts.contextTime) * 1000, k0 = Math.max(0, Math.round(((r.T0 - w0) / 1000) * sr));
  const take = x.subarray(k0), lead = (w0 - r.T0) / 1000 + k0 / sr;
  if (take.length < sr * 0.1) throw new Error('the microphone recorded nothing after the countdown');
  const f = await uploadOne(new File([wavMono(take, sr)], `${name}.wav`, { type: 'audio/wav' }));
  Object.assign(rcStop.last, { lat, heard, lead });
  return { media: f.id, kind: 'mic', lead, dur: take.length / sr };
}
function rcPlace(parts, crop) { // one undo step: the screen (else the camera) at the playhead on the main track, the rest in sync with it
  const clip = p => ({ id: hex12(), media: p.media, start: 0, in: 0, out: p.dur, speed: 1, volume: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } });
  const main = parts.find(p => p.kind === 'screen') || parts.find(p => p.kind === 'camera');
  change(() => {
    let base = S.t, O = S.t;
    if (main) {
      packMain();
      const i = P.main.filter(x => x.start + tdur(x, 'main') / 2 < S.t).length, mc = clip(main);
      if (crop && main.kind === 'screen' && Object.keys(crop).length) mc.crop = { l: crop.l, r: crop.r, t: crop.t, b: crop.b };
      P.main.splice(i, 0, mc);
      packMain();
      base = mc.start; O = base - main.lead; // O: the timeline time of the recorders' start
      S.sel = { lane: 'main', id: mc.id };
    }
    for (const p of parts) {
      if (p === main) continue;
      const lane = p.kind === 'mic' ? 'audio' : 'overlay', c = clip(p), T = O + p.lead;
      c.in = Math.max(0, base - T); c.start = T + c.in;
      if (lane === 'overlay') { // a picture-in-picture, bottom right: 28 % of the frame's short side tall
        const W = P.w, H = P.h, s0 = Math.min(W / p.w, H / p.h), h = 0.28 * Math.min(W, H), w = (h * p.w) / p.h, mg = 0.03 * Math.min(W, H);
        Object.assign(c, { scale: h / (p.h * s0), x: ((W - w) / 2 - mg) / W, y: ((H - h) / 2 - mg) / H });
      }
      P[lane].push(c);
    }
    rcPlace.O = O;
  }, 'Record');
  renderAll();
  return rcPlace.O;
}
async function rcCursorSave(r, sp) { // the pointer during the take (server.py cursor_poll) -> the screen file's cursor track, in its time and frame (0..1)
  r.cur = null;
  const c = await api('/api/cursor', { on: false }), st = r.screen.getVideoTracks()[0]?.getSettings() || {}, a = (st.width || 16) / (st.height || 9);
  const s = (c.screens || []).reduce((b, q) => (!b || Math.abs(q[2] / q[3] - a) < Math.abs(b[2] / b[3] - a) - 1e-3 ? q : b), null); // the recorded screen: the first of its shape
  if (!s || !c.pts?.length) return; // ponytail: two screens of one shape -> the main one; the picker doesn't say which was picked
  const at = (t, x, y) => [+(t - sp.lead).toFixed(4), +((x - s[0]) / s[2]).toFixed(5), +((y - s[1]) / s[3]).toFixed(5)];
  await api(`/api/cursor/${sp.media}`, { track: { pts: c.pts.map(p => at(...p)), ev: c.ev.map(([t, k, x, y]) => { const [T, u, v] = at(t, x, y); return [T, k, u, v]; }) } });
}
// ---------- auto zoom: a screen recording zooms in toward clicks and typing, follows the cursor, zooms out when it rests or leaves ----------
// The result is plain keyframes on the clip (scale, x, y): editable, one undo step, drawn by the transform every clip uses (preview == export).
const AZ = () => { try { return { amount: 2, smooth: 0.5, ...JSON.parse(store.get('cutroom.az') || '{}') }; } catch { return { amount: 2, smooth: 0.5 }; } };
function azPanel(c) { // the inspector's section, for a screen recording with a cursor track
  const o = AZ(), r = (id, v, min, max, st, out) => `<input id="${id}" type="range" min="${min}" max="${max}" step="${st}" value="${v}" style="--p:${((v - min) / (max - min)) * 100}%"><output>${out}</output>`;
  return `<h4>Auto zoom</h4><p class="hint">Zooms in toward clicks and typing, follows the cursor, and zooms out when it rests or moves away. Makes keyframes you can edit.</p>
    <label class="row"><span>Zoom</span>${r('azAmt', o.amount, 1.25, 3, 0.05, `${o.amount}×`)}</label>
    <label class="row"><span>Smoothness</span>${r('azSmooth', o.smooth, 0, 1, 0.05, `${Math.round(o.smooth * 100)}%`)}</label>
    <div class="actions"><button data-act="autozoom">Auto zoom</button></div>`;
}
function azKeyframes(c, m, tr, amount = 2, smooth = 0.5) { // the clip's cursor track -> { kf, zooms }; amount 1.25-3, smooth 0-1
  const cr = c.crop || {}, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0), sp = c.speed || 1, D = (c.out - c.in) / sp;
  const loc = (t, u, v) => [(t - c.in) / sp, (u - (cr.l || 0)) / fx, (v - (cr.t || 0)) / fy]; // file time and frame -> clip time and the clip's (cropped) picture
  const pts = tr.pts.map(p => loc(...p)).sort((a, b) => a[0] - b[0]);
  const ev = tr.ev.map(([t, , u, v]) => loc(t, u, v)).filter(e => e[0] >= 0 && e[0] <= D && e[1] >= 0 && e[1] <= 1 && e[2] >= 0 && e[2] <= 1).sort((a, b) => a[0] - b[0]);
  if (!ev.length || pts.length < 2) return { kf: null, zooms: [] };
  const R = 0.35 + 0.9 * smooth, SIG = 0.1 + 0.5 * smooth, IDLE = 1.2, FAR = 0.6 / amount, ss = u => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
  const end = (T, u, v) => { // a zoom lasts until the cursor rests IDLE s, or leaves the view around the event
    let moved = T, prev = null;
    for (const p of pts) {
      if (p[0] <= T) { prev = p; continue; }
      if (prev && Math.hypot(p[1] - prev[1], p[2] - prev[2]) > 0.002) moved = p[0];
      if (p[0] - moved >= IDLE || Math.abs(p[1] - u) > FAR || Math.abs(p[2] - v) > FAR) return Math.min(D, p[0]);
      prev = p;
    }
    return D;
  };
  const zooms = [];
  for (const [T, u, v] of ev) {
    const z = zooms.at(-1);
    if (z && T <= z.b + 2 * R) z.b = Math.max(z.b, end(T, u, v)); // close after the last one: stays in and pans
    else zooms.push({ a: T, u, v, b: end(T, u, v) });
  }
  while (zooms.length > AZ_MAX) { // a long, busy recording: the closest two zooms become one (it stays in and pans), so the keyframes fit the export
    let at = 0;
    for (let i = 1; i < zooms.length - 1; i++) if (zooms[i + 1].a - zooms[i].b < zooms[at + 1].a - zooms[at].b) at = i;
    zooms[at].b = zooms[at + 1].b; zooms.splice(at + 1, 1);
  }
  const sm = T => { // the cursor, smoothed both ways in time (no lag)
    let su = 0, sv = 0, sw = 0, lo = 0, hi = pts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < T - 3 * SIG) lo = mid + 1; else hi = mid; } // (from the first sample in reach: an hour's track stays quick)
    for (let i = lo; i < pts.length; i++) { const p = pts[i], d = p[0] - T; if (d > 3 * SIG) break; const w = Math.exp(-(d * d) / (2 * SIG * SIG)); su += w * p[1]; sv += w * p[2]; sw += w; }
    if (sw) return [su / sw, sv / sw];
    const p = pts.reduce((b, q) => (Math.abs(q[0] - T) < Math.abs(b[0] - T) ? q : b));
    return [p[1], p[2]];
  };
  const W = P.w, H = P.h, mw = m.w * fx, mh = m.h * fy, s1 = (c.fit === 'fill' ? Math.max : Math.min)(W / mw, H / mh), bs = c.scale ?? 1, bx = c.x ?? 0, by = c.y ?? 0;
  const wb = mw * s1 * bs, hb = mh * s1 * bs, xb = (W - wb) / 2 + bx * W, yb = (H - hb) / 2 + by * H;
  const props = (t, k, [u, v]) => { // zoom k on picture point u, v: that point to the middle of the clip's own frame, the frame kept covered
    const w = wb * k, h = hb * k, X = clamp(xb + wb / 2 - u * w, xb + wb - w, xb), Y = clamp(yb + hb / 2 - v * h, yb + hb - h, yb);
    return { t: +t.toFixed(4), scale: +(bs * k).toFixed(5), x: +((X - (W - w) / 2) / W).toFixed(5), y: +((Y - (H - h) / 2) / H).toFixed(5), opacity: c.opacity ?? 1, rot: c.rot ?? 0, ease: false };
  };
  const zp = (t, k, at) => { // part way in or out: the straight blend of 1x and fully in (a zoom about one fixed point: keeps the frame covered, and eases exactly)
    const a = props(t, 1, at), b = props(t, amount, at), q = (k - 1) / (amount - 1), f = x => +x.toFixed(5);
    return { ...b, scale: f(a.scale + (b.scale - a.scale) * q), x: f(a.x + (b.x - a.x) * q), y: f(a.y + (b.y - a.y) * q) };
  };
  // Each zoom: in (one eased keyframe pair: the picture point stays put, so x and y ease exactly with the zoom), held while the view
  // follows the cursor (it stays put while the cursor is in its middle half, then is pushed along: calm, few keyframes), out (eased, the view held).
  const kf = [props(0, 1, [0.5, 0.5])], dense = [kf[0]], half = 0.5 / amount;
  for (const z of zooms) {
    const a0 = Math.max(0, z.a - R), b1 = Math.min(D, z.b + R), cam = [];
    for (let T = z.a, cu = z.u, cv = z.v; T < z.b + 1 / 15; T += 1 / 15) {
      const [u, v] = sm(Math.min(T, z.b)), push = (c0, x) => c0 + Math.max(0, Math.abs(x - c0) - half / 2) * Math.sign(x - c0);
      cu = push(cu, u); cv = push(cv, v);
      cam.push([cu, cv]);
    }
    const cs = cam.map((_, i) => { // the pushes, smoothed (±0.4 s); it still starts on the click
      if (!i) return cam[0];
      let su = 0, sv = 0, sw = 0;
      for (let j = Math.max(0, i - 6); j <= Math.min(cam.length - 1, i + 6); j++) { const w = Math.exp(-((j - i) ** 2) / 18); su += w * cam[j][0]; sv += w * cam[j][1]; sw += w; }
      return [su / sw, sv / sw];
    });
    const at = T => { // the view's centre (picture point) at clip time T
      if (T <= z.a) return [z.u, z.v];
      const f = (Math.min(T, z.b) - z.a) * 15, i = Math.min(cs.length - 2, Math.floor(f)), q = clamp(f - i, 0, 1);
      return cs.length < 2 ? cs[0] : [cs[i][0] + (cs[i + 1][0] - cs[i][0]) * q, cs[i][1] + (cs[i + 1][1] - cs[i][1]) * q];
    };
    const k = T => 1 + (amount - 1) * (T < z.a ? (z.a > a0 ? ss((T - a0) / (z.a - a0)) : 1) : T <= z.b ? 1 : ss(1 - (T - z.b) / R));
    const add = (T, ease, pin) => { // (at the time of the last one, e.g. a zoom from the clip's start: that one eases instead)
      const l = kf.at(-1);
      if (T > l.t + 1e-4) kf.push({ ...zp(T, k(T), at(T)), ease, ...(pin && { pin: 1 }) });
      else if (ease) Object.assign(l, { ease, pin: 1 });
    };
    add(a0, true, 1); add(z.a, false, 1);
    for (let T = z.a + 1 / 15; T < z.b - 1e-4; T += 1 / 15) add(T, false);
    add(Math.min(z.b, D), true, 1); add(b1, false, 1);
    for (let T = a0; T < b1; T += 1 / 30) dense.push(zp(T, k(T), at(T))); // (the motion as meant, for tests)
  }
  if (kf.at(-1).t < D - 1e-4) kf.push(props(D, 1, [0.5, 0.5]));
  return { kf: azThin(kf, W, H), dense, zooms };
}
const AZ_MAX = 200; // separate zooms in one clip: 4 keyframes each, well under the export's 2000 with room for following the cursor
// ponytail: the 1500-keyframe cap (export refuses > 2000) means a very busy long take follows the cursor more loosely
// (30 min of a jump and click every ~1.25 s: up to ~290 px off at 1080p); a smarter fit (spline keyframes) if that matters.
function azThin(kf, W, H, cap = 1500) { // the held stretches' 15-a-second samples -> the few that draw the same motion (within a pixel and 0.2 %
  // zoom; Douglas-Peucker). The zooms' edges always stay (their eased segments have nothing between them). A recording busy throughout loosens
  // it until it fits under the export's 2000 keyframes.
  for (let tol = 1; ; tol *= 1.5) {
    const keep = new Uint8Array(kf.length), err = (a, b, i) => { // how far keyframe i is off the line a..b, in tolerances
      const u = (kf[i].t - kf[a].t) / (kf[b].t - kf[a].t || 1), d = k => Math.abs(kf[i][k] - (kf[a][k] + (kf[b][k] - kf[a][k]) * u));
      return Math.max(d('scale') / (0.002 * tol), (d('x') * W) / tol, (d('y') * H) / tol);
    };
    kf.forEach((f, i) => { if (f.pin) keep[i] = 1; });
    keep[0] = keep[kf.length - 1] = 1;
    for (const st = [[0, kf.length - 1]]; st.length;) {
      const [a, b] = st.pop();
      let w = 0, at = -1;
      for (let i = a + 1; i < b; i++) { const e = keep[i] ? Infinity : err(a, b, i); if (e > w) { w = e; at = i; } } // (a pinned one splits first)
      if (w > 1) { keep[at] = 1; st.push([a, at], [at, b]); }
    }
    const out = kf.filter((_, i) => keep[i]).map(({ pin, ...f }) => f);
    if (out.length <= cap || tol > 1e6) return out;
  }
}
async function autoZoom(c, { amount, smooth } = {}) {
  const m = M.get(c?.media), o = AZ();
  amount = clamp(+(amount ?? o.amount) || 2, 1.25, 3); smooth = clamp(+(smooth ?? o.smooth) || 0, 0, 1);
  if (!m || m.kind !== 'video' || !m.cursor) throw new Error('Auto zoom works on screen recordings made in Cutroom (the whole screen or an area): it follows the cursor recorded with them');
  const tr = await api(`/api/cursor/${m.id}`, {}), { kf, zooms } = azKeyframes(c, m, tr, amount, smooth);
  if (!kf) throw new Error('No clicks or typing in this clip: nothing to zoom in on');
  change(() => { c.kf = kf; }, `Auto zoom ${stepClip(...cfind(c.id))}`);
  toast(`Auto zoom: ${zooms.length} zoom${zooms.length === 1 ? '' : 's'} as keyframes on the clip (they replace its position and size keyframes)`);
  return { zooms: zooms.map(z => ({ at: +(c.start + z.a).toFixed(3), until: +(c.start + z.b).toFixed(3) })), keyframes: kf.length };
}
REMOTE.auto_zoom = async ({ id, amount, smooth } = {}) => autoZoom(id ? cfind(id)[0] : selClip(), { amount, smooth });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id !== 'azAmt' && t.id !== 'azSmooth') return;
  fill(t);
  t.nextElementSibling.textContent = t.id === 'azAmt' ? `${+t.value}×` : `${Math.round(t.value * 100)}%`;
  store.set('cutroom.az', JSON.stringify({ amount: +$('#azAmt').value, smooth: +$('#azSmooth').value }));
});
document.addEventListener('click', e => {
  if (!e.target.closest?.('#inspector [data-act="autozoom"]')) return;
  autoZoom(selClip(), { amount: +$('#azAmt').value, smooth: +$('#azSmooth').value }).catch(err => toast(err.message));
});
addEventListener('keydown', e => { // while recording: Space pauses the teleprompter, the arrows change its speed, Esc stops (before the editor's keys)
  const r = RC;
  if (!r || r.phase === 'open' || r.phase === 'saving') return;
  if (e.key === 'Escape') { if (r.phase === 'area' || r.phase === 'warn') r.cancel(); else rcStop(r); }
  else if (r.phase === 'rec' && e.code === 'Space') rcPause(r);
  else if (r.phase === 'rec' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    r.speed = clamp(r.speed + (e.key === 'ArrowUp' ? 1 : -1), 1, 10);
    const sp = $('.rcspeed input'); if (sp) { sp.value = r.speed; fill(sp); }
  } else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
$('#btnRecord')?.addEventListener('click', openRecorder);
