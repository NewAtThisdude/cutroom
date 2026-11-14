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
  return { screen: 'screen', cam: true, mic: true, script: '', speed: 3, size: 34, mirror: false, ...o };
}
function rcRead() { // the dialog -> the options (remembered for next time)
  const o = { screen: $('#rcScreen').value, cam: $('#rcCam').checked, mic: $('#rcMic').checked, script: $('#rcScript').value, speed: +$('#rcSpeed').value, size: +$('#rcSize').value, mirror: $('#rcMirror').checked };
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
    <label class="row chk"><span>Microphone</span><input id="rcMic" type="checkbox"${o.mic ? ' checked' : ''}></label>
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
  $('#rcGo').addEventListener('click', rcStart);
}
function rcWhy(what, e) { // a refused or failed device, in words: what to do about it
  const n = e?.name;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `No ${what} found: connect one, or turn it off here`;
  if (n === 'NotReadableError' || n === 'AbortError') return `The ${what} could not start: another app may be using it`;
  if (n !== 'NotAllowedError' && n !== 'SecurityError') return `The ${what} could not start: ${e?.message || e}`;
  const pane = { screen: 'Screen & System Audio Recording', camera: 'Camera', microphone: 'Microphone', 'camera and microphone': 'Camera and Microphone' }[what];
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
    if (o.screen !== 'none') {
      try { r.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, cursor: 'always', displaySurface: o.screen === 'window' ? 'window' : 'monitor' }, audio: false }); } catch (e) { throw new Error(rcWhy('screen', e)); }
    }
    if (o.cam || o.mic) {
      const what = o.cam && o.mic ? 'camera and microphone' : o.cam ? 'camera' : 'microphone';
      try { r.user = await navigator.mediaDevices.getUserMedia({ video: o.cam && { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: o.mic && { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); } catch (e) { throw new Error(rcWhy(what, e)); } // (echo cancelling would take the blips out)
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
function rcRecorder(stream, bps) { // a MediaRecorder sending its file to the server a second at a time (record_part in server.py)
  const type = RC_TYPES.find(t => MediaRecorder.isTypeSupported(t)), ext = /mp4/.test(type) ? 'mp4' : 'webm', id = hex12();
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bps });
  let chain = Promise.resolve();
  const send = (b, q = '') => (chain = chain.then(async () => {
    const x = await fetch(`/api/record/${id}.${ext}${q}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: b }), j = await x.json().catch(() => ({}));
    if (!x.ok) throw new Error(j.error || 'saving the recording failed');
    return j;
  }));
  mr.addEventListener('dataavailable', e => { if (e.data.size) send(e.data); });
  const stopped = new Promise(z => mr.addEventListener('stop', z, { once: true }));
  return { mr, async finish(name) { if (mr.state !== 'inactive') mr.stop(); await stopped; return send(new Blob([]), `?done=1&name=${encodeURIComponent(name)}`); } };
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
  RC_APP()?.postMessage(true);
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
  if (r.screen) r.recs.push({ kind: 'screen', rec: rcRecorder(r.screen, 10e6) });
  if (cam) r.recs.push({ kind: 'camera', rec: rcRecorder(cam, 4e6) });
  r.T0 = performance.now();
  for (const x of r.recs) x.rec.mr.start(1000);
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
    await loadMedia();
    rcStop.last = { ...rcStop.last, T0: r.T0, O: rcPlace(parts, r.crop) }; // (for tests: the timeline time of the recorders' start)
    rcEnd(r);
    closeModal();
    const scr = parts.some(p => p.kind === 'screen');
    toast(`Recorded ${fmtDur(secs)}: ${[scr && 'screen on the main track', parts.some(p => p.kind === 'camera') && (scr ? 'camera as a picture-in-picture (drag it on the preview to move it)' : 'camera on the main track'), r.mic && 'sound on the audio track'].filter(Boolean).join(', ')}`);
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
addEventListener('keydown', e => { // while recording: Space pauses the teleprompter, the arrows change its speed, Esc stops (before the editor's keys)
  const r = RC;
  if (!r || r.phase === 'open' || r.phase === 'saving') return;
  if (e.key === 'Escape') { if (r.phase === 'area') r.cancel(); else rcStop(r); }
  else if (r.phase === 'rec' && e.code === 'Space') rcPause(r);
  else if (r.phase === 'rec' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    r.speed = clamp(r.speed + (e.key === 'ArrowUp' ? 1 : -1), 1, 10);
    const sp = $('.rcspeed input'); if (sp) { sp.value = r.speed; fill(sp); }
  } else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
$('#btnRecord')?.addEventListener('click', openRecorder);
