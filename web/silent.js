// SPDX-License-Identifier: GPL-3.0-or-later
// Test and scratch servers (any port but the app's 4610) serve pages that make no sound: headless test browsers
// play through the Mac's speakers, and the test tones, pink noise and scrub audio came out as random static.
// Everything still runs (clocks, taps, analysers): only the final output is silenced. localStorage cutroomSound=1 opts back in.
// ponytail: keyed on the port, not on CUTROOM_HOME; a real library on another port is silent until cutroomSound is set.
(() => {
  let on = false;
  try { on = location.port === '4610' || localStorage.getItem('cutroomSound') === '1'; } catch (e) {}
  if (on || typeof BaseAudioContext === 'undefined') return;
  const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination').get, zero = new WeakMap();
  Object.defineProperty(BaseAudioContext.prototype, 'destination', {
    configurable: true,
    get() {
      const d = real.call(this);
      if (typeof OfflineAudioContext !== 'undefined' && this instanceof OfflineAudioContext) return d; // renders, never plays
      let g = zero.get(this);
      if (!g) { g = this.createGain(); g.gain.value = 0; g.connect(d); zero.set(this, g); }
      return g;
    },
  });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { this.muted = true; return play.call(this); };
})();
