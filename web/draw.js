// Cutroom: the text and effect-overlay layer's drawing, shared by the preview, the page's export path and the layer
// workers (web/layer.js importScripts it). Plain script, no DOM at load: P and shown() are the page's (or the worker's own).
'use strict';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const alike = (a, b) => /^#[0-9a-f]{6}/i.test(a) && /^#[0-9a-f]{6}/i.test(b) && [1, 3, 5].reduce((d, i) => d + Math.abs(parseInt(a.substr(i, 2), 16) - parseInt(b.substr(i, 2), 16)), 0) < 96; // two #rrggbb colours too close to tell apart
const hexA = (hex, a = 1) => `${hex}${Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0')}`;
const TEXT_BASE = { font: 'Montserrat', weight: 800, size: 72, color: '#ffffff', stroke: '#000000', strokeW: 0, shadow: false, box: false, boxColor: '#000000', boxAlpha: 0.72, upper: false, hl: '#ffd400', pop: false, maxW: 0.86, lh: 1.15,
  italic: false, align: 'center', ls: 0, shc: '#000000', sha: 0.55, shb: 0.18, shx: 0, shy: 0.04, boxR: 0.18, boxPad: 0.3 };

const animLen = (st, out) => (out ? st.outT : st.animT) ?? ((out ? st.out : st.anim) === 'type' ? 1.2 : ANIM_T); // text in/out length; typing takes longer
const wob = t => 0.5 * Math.sin(t) + 0.3 * Math.sin(2.3 * t + 1.7) + 0.2 * Math.sin(4.1 * t + 3.1); // smooth deterministic jitter (the export bakes the same)
const ANIM_T = 0.3; // default text in/out animation length, seconds
const WORD_T = 0.22; // a caption word's own entrance (pop, bounce, rise...), seconds
const SPK_C = ['#ffd400', '#4fd8ff', '#ff6fa8', '#7dff8b', '#c79bff', '#ff9f43']; // speaker colours, in order
const capLive = st => !!(st.kar || st.wanim || st.reveal === 'char' || st.emoji); // a caption style that changes every frame (the export draws each one)
const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const ss3 = x => x * x * (3 - 2 * x);
// keyframe easing: ease = true is the smoothstep (ease-in-out, = cubic-bezier(1/3, 0, 2/3, 1)); bz = [x1, y1, x2, y2] makes it that cubic-bezier instead
const EASES = { linear: null, in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1], inout: [1 / 3, 0, 2 / 3, 1] };
function bezE(bz, u) { // cubic-bezier at time u: s by 16 halvings, the very steps the server's pw() writes into ffmpeg (same doubles both sides)
  const [x1, y1, x2, y2] = bz, cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  let s = 0, h = 1;
  for (let i = 0; i < 16; i++) { h /= 2; const q = s + h; if (((ax * q + bx) * q + cx) * q < u) s = q; }
  s += h / 2;
  return ((ay * s + by) * s + cy) * s;
}
const easeU = (u, r0, r1, bz) => { const E = bz ? v => bezE(bz, v) : ss3, d = E(r1) - E(r0); return Math.abs(d) > 1e-9 ? (E(r0 + u * (r1 - r0)) - E(r0)) / d : u; }; // part [r0, r1] of the curve, rescaled to 0..1
function propsAt(c, lt) { // keyframed scale/x/y/opacity at clip-local time: linear, exactly like the server's pw()
  const k = c.kf;
  if (!k?.length) return { scale: c.scale ?? 1, x: c.x ?? 0, y: c.y ?? 0, opacity: c.opacity ?? 1, rot: c.rot ?? 0 };
  let i = 0;
  while (i + 1 < k.length && k[i + 1].t <= lt) i++;
  const a = k[i], b = k[i + 1];
  if (!b) return { scale: a.scale, x: a.x, y: a.y, opacity: a.opacity, rot: a.rot ?? 0 }; // never leak a keyframe's own t
  let u = clamp((lt - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
  if (a.ease ?? c.ease) u = easeU(u, a.eu0 ?? 0, a.eu1 ?? 1, a.bz); // smoothstep (or its cubic-bezier) from this keyframe (or clip default), same as pw() with e=1
  const mix = p => (a[p] ?? 0) + ((b[p] ?? 0) - (a[p] ?? 0)) * u;
  return { scale: mix('scale'), x: mix('x'), y: mix('y'), opacity: mix('opacity'), rot: mix('rot') };
}

const rnd = (i, s = 0) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); }; // deterministic noise: preview and export agree
const ID3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const lerpM = (A, B, t) => A.map((v, i) => v + (B[i] - v) * t);
const fxFrame = lt => Math.floor(lt * P.fps + 1e-6);
const clock = s => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const shake = (a, fx, fy) => (W, H, u, lt, f) => { const s = a * f.amt; return [{ op: 'transform', z: 1 + 2 * s + 0.01, x: W * s * wob(lt * fx), y: H * s * wob(lt * fy + 5) }]; };
function particles(n, fn) { for (let i = 0; i < n; i++) fn(i); }
// px(): steps the export runs on the composite (same numbers here and in ffmpeg); layer(): drawn into the text layer, so it renders exactly as previewed.
// rate: how often a layer changes: 'frame', n per second, 'edges' (animated only near its ends) or 0 (static).
const FX = {
  shake: { n: 'Shake', cat: 'camera', d: 1.5, px: shake(0.035, 17, 14) },
  quake: { n: 'Earthquake', cat: 'camera', d: 1.5, px: shake(0.07, 31, 27) },
  pulse: { n: 'Beat zoom', cat: 'camera', d: 2, px: (W, H, u, lt, f) => [{ op: 'transform', z: 1 + 0.14 * f.amt * Math.exp(-sinceBeat(f, lt) / 0.12), x: 0, y: 0 }] },
  zoomin: { n: 'Slow zoom', cat: 'camera', d: 3, px: (W, H, u, lt, f) => [{ op: 'transform', z: 1 + 0.2 * f.amt * clamp(lt / f.dur, 0, 1), x: 0, y: 0 }] },
  motionblur: { n: 'Motion blur', cat: 'camera', d: 1.5, px: (W, H, u, lt, f) => [{ op: 'hblur', sigma: +Math.max(0.5, 24 * u * f.amt).toFixed(2) }] }, // sideways streaks: pans, passing cars
  zoomblur: { n: 'Zoom blur', cat: 'camera', d: 1.5, px: (W, H, u, lt, f) => [{ op: 'zblur', s: +clamp(0.12 * f.amt, 0, 2).toFixed(4) }] },
  flash: { n: 'Flash', cat: 'light', d: 0.6, rate: 'frame', layer: (x, W, H, u, lt, f) => { x.fillStyle = `rgba(255,255,255,${Math.min(1, f.amt) * (1 - Math.abs(2 * lt / f.dur - 1)) ** 1.5})`; x.fillRect(0, 0, W, H); } },
  strobe: { n: 'Strobe', cat: 'light', d: 1.5, rate: 'frame', layer: (x, W, H, u, lt, f) => { if (fxFrame(lt) % 4 === 0) { x.fillStyle = `rgba(255,255,255,${0.85 * Math.min(1, f.amt)})`; x.fillRect(0, 0, W, H); } } },
  blink: { n: 'Blink', cat: 'light', d: 1, rate: 'frame', layer: (x, W, H, u, lt, f) => { // eyelids close and open again
    const c = Math.sin(Math.PI * clamp(lt / f.dur, 0, 1)) ** 2 * Math.min(1, f.amt), h = c * H * 0.56;
    x.fillStyle = '#000';
    if (c > 0.97) return x.fillRect(0, 0, W, H);
    if (h < 0.5) return;
    for (const [y0, s] of [[0, 1], [H, -1]]) { x.beginPath(); x.moveTo(0, y0); x.lineTo(W, y0); x.lineTo(W, y0 + s * h * 0.7); x.quadraticCurveTo(W / 2, y0 + s * h * 1.3, 0, y0 + s * h * 0.7); x.closePath(); x.fill(); }
  } },
  glow: { n: 'Dreamy glow', cat: 'light', d: 3, px: (W, H, u, lt, f) => [{ op: 'glow', sigma: 16 * u, amt: Math.min(1, 0.6 * f.amt) }] },
  vhs: { n: 'VHS', cat: 'retro', d: 3, rate: 1,
    px: (W, H, u, lt, f) => { const s = Math.max(1, Math.round(4 * u * f.amt)); return [{ op: 'rgbshift', rh: -s, bh: s }, { op: 'noise', s: Math.round(clamp(10 * f.amt, 1, 60)) }]; },
    layer: (x, W, H, u, lt) => {
      x.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = 0; y < H; y += Math.max(2, 4 * u)) x.fillRect(0, y, W, Math.max(1, 1.5 * u));
      x.font = `700 ${40 * u}px Menlo, monospace`; x.fillStyle = '#fff'; x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = 4 * u;
      x.textBaseline = 'top'; x.fillText('PLAY ▶', 48 * u, 48 * u);
      x.textBaseline = 'bottom'; x.fillText(`SP ${clock(Math.floor(lt))}`, 48 * u, H - 48 * u);
    } },
  oldfilm: { n: 'Old film', cat: 'retro', d: 3, rate: 'frame',
    px: (W, H, u, lt, f) => [{ op: 'matrix', m: lerpM(ID3, LOOKS.sepia, Math.min(1, f.amt)), k: +(0.9 + 0.1 * rnd(fxFrame(lt), 7)).toFixed(3) }, { op: 'noise', s: Math.round(clamp(14 * f.amt, 1, 60)) }],
    layer: (x, W, H, u, lt) => { // scratches and dust, new every frame
      const g = fxFrame(lt);
      x.strokeStyle = 'rgba(30,20,10,0.35)'; x.lineWidth = Math.max(1, 1.5 * u);
      for (let i = 0; i < Math.floor(rnd(g, 1) * 3); i++) { const xx = rnd(g, 10 + i) * W; x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx + (rnd(g, 20 + i) - 0.5) * 20 * u, H); x.stroke(); }
      x.fillStyle = 'rgba(20,15,10,0.5)';
      for (let i = 0; i < Math.floor(rnd(g, 2) * 7); i++) { x.beginPath(); x.arc(rnd(g, 30 + i) * W, rnd(g, 40 + i) * H, (1 + 3 * rnd(g, 50 + i)) * u, 0, 6.2832); x.fill(); }
    } },
  grain: { n: 'Film grain', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [{ op: 'noise', s: Math.round(clamp(16 * f.amt, 1, 80)) }] },
  bw: { n: 'Black & white', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [{ op: 'matrix', m: sat(1 - Math.min(1, f.amt)) }] },
  sepia: { n: 'Sepia', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [{ op: 'matrix', m: lerpM(ID3, LOOKS.sepia, Math.min(1, f.amt)) }] },
  glitch: { n: 'Glitch', cat: 'distort', d: 1.5, px: (W, H, u, lt, f) => { const g = fxFrame(lt), s = Math.round(u * f.amt * (rnd(g, 2) > 0.7 ? 22 : 7) * (rnd(g, 1) * 2 - 1)); return [{ op: 'rgbshift', rh: s, bh: -s }]; } },
  rgb: { n: 'RGB split', cat: 'distort', d: 2, px: (W, H, u, lt, f) => { const s = Math.max(1, Math.round(8 * u * f.amt)); return [{ op: 'rgbshift', rh: -s, bh: s }]; } },
  pixelate: { n: 'Pixelate', cat: 'distort', d: 2, px: (W, H, u, lt, f) => [{ op: 'pixelize', size: Math.max(2, Math.round(28 * u * f.amt)) }] },
  blur: { n: 'Blur', cat: 'distort', d: 2, px: (W, H, u, lt, f) => [{ op: 'blur', sigma: +Math.max(0.5, 12 * u * f.amt).toFixed(2) }] },
  invert: { n: 'Invert', cat: 'distort', d: 1, px: () => [{ op: 'negate' }] },
  mirror: { n: 'Mirror', cat: 'distort', d: 3, px: () => [{ op: 'mirror' }] },
  split4: { n: 'Split ×4', cat: 'distort', d: 3, px: () => [{ op: 'grid' }] },
  snow: { n: 'Snow', cat: 'party', d: 4, rate: 'frame', layer: (x, W, H, u, lt, f) => {
    x.fillStyle = '#fff';
    particles(Math.round(110 * f.amt), i => {
      const v = 0.05 + 0.09 * rnd(i, 2), yy = ((rnd(i, 4) + lt * v) % 1.08) - 0.04, xx = rnd(i, 1) + 0.02 * Math.sin(lt * 1.3 + 6.28 * rnd(i, 5));
      x.globalAlpha = 0.5 + 0.5 * rnd(i, 6); x.beginPath(); x.arc(xx * W, yy * H, (1.5 + 4.5 * rnd(i, 3)) * u, 0, 6.2832); x.fill();
    });
  } },
  rain: { n: 'Rain', cat: 'party', d: 4, rate: 'frame', layer: (x, W, H, u, lt, f) => {
    x.strokeStyle = 'rgba(200,220,255,0.45)'; x.lineWidth = 2 * u; x.lineCap = 'round'; x.beginPath();
    particles(Math.round(90 * f.amt), i => {
      const yy = ((rnd(i, 4) + lt * (1.1 + 0.6 * rnd(i, 2))) % 1.2) - 0.1, xx = rnd(i, 1) - yy * 0.12, L = (40 + 40 * rnd(i, 3)) * u;
      x.moveTo(xx * W, yy * H); x.lineTo(xx * W - 0.25 * L, yy * H + L);
    });
    x.stroke();
  } },
  sparkle: { n: 'Sparkles', cat: 'party', d: 3, rate: 'frame', layer: (x, W, H, u, lt, f) => {
    particles(Math.round(34 * f.amt), i => {
      const s = Math.max(0, Math.sin(lt * (2 + 3 * rnd(i, 3)) + 6.28 * rnd(i, 4))) ** 3, r = (8 + 18 * rnd(i, 5)) * u * s;
      if (s < 0.02) return;
      x.save(); x.translate(rnd(i, 1) * W, rnd(i, 2) * H); x.rotate(rnd(i, 6) * 0.8); x.globalAlpha = s; x.fillStyle = '#fff'; x.shadowColor = '#ffe9a8'; x.shadowBlur = r * 1.2;
      x.beginPath(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, rr = k % 2 ? r * 0.18 : r; x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } x.closePath(); x.fill(); x.restore();
    });
  } },
  hearts: { n: 'Hearts', cat: 'party', d: 3, rate: 'frame', layer: (x, W, H, u, lt, f) => {
    const col = ['#ff3d7f', '#ff6b9d', '#e6004c', '#ff9ec4'];
    particles(Math.round(16 * f.amt), i => {
      const yy = 1.08 - ((rnd(i, 4) + lt * (0.12 + 0.12 * rnd(i, 2))) % 1.2), xx = rnd(i, 1) + 0.03 * Math.sin(lt * 2 + 6.28 * rnd(i, 5)), s = (18 + 26 * rnd(i, 3)) * u;
      x.save(); x.translate(xx * W, yy * H); x.rotate((rnd(i, 6) - 0.5) * 0.6); x.globalAlpha = 0.85; x.fillStyle = col[i % 4];
      x.beginPath(); x.moveTo(0, s * 0.35); x.bezierCurveTo(-s, -s * 0.35, -s * 0.45, -s * 1.05, 0, -s * 0.45); x.bezierCurveTo(s * 0.45, -s * 1.05, s, -s * 0.35, 0, s * 0.35); x.fill(); x.restore();
    });
  } },
  confetti: { n: 'Confetti', cat: 'party', d: 3, rate: 'frame', layer: (x, W, H, u, lt, f) => {
    const col = ['#ffd400', '#ff3d7f', '#3dd6ff', '#7cff6b', '#b49bff', '#ff8a3d'];
    particles(Math.round(80 * f.amt), i => {
      const yy = ((rnd(i, 4) + lt * (0.18 + 0.2 * rnd(i, 2))) % 1.15) - 0.07, xx = rnd(i, 1) + 0.04 * Math.sin(lt * 1.7 + 6.28 * rnd(i, 5));
      x.save(); x.translate(xx * W, yy * H); x.rotate(lt * (2 + 4 * rnd(i, 6)) + 6.28 * rnd(i, 7)); x.scale(1, Math.cos(lt * (3 + 5 * rnd(i, 8)) + 6.28 * rnd(i, 9)));
      x.fillStyle = col[i % col.length]; x.fillRect(-5 * u, -8 * u, 10 * u, 16 * u); x.restore();
    });
  } },
  bubbles: { n: 'Bubbles', cat: 'party', d: 4, rate: 'frame', layer: (x, W, H, u, lt, f) => {
    x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = 2 * u;
    particles(Math.round(22 * f.amt), i => {
      const yy = 1.1 - ((rnd(i, 4) + lt * (0.08 + 0.1 * rnd(i, 2))) % 1.25), xx = rnd(i, 1) + 0.025 * Math.sin(lt * 1.5 + 6.28 * rnd(i, 5)), r = (10 + 30 * rnd(i, 3)) * u;
      x.globalAlpha = 0.55; x.beginPath(); x.arc(xx * W, yy * H, r, 0, 6.2832); x.stroke();
      x.globalAlpha = 0.35; x.beginPath(); x.arc(xx * W - r * 0.35, yy * H - r * 0.35, r * 0.22, 0, 6.2832); x.fill();
    });
  } },
  bars: { n: 'Cinema bars', cat: 'frame', d: 4, rate: 'edges', layer: (x, W, H, u, lt, f) => { // 2.39:1 letterbox, sliding in and out
    const hb = Math.min(1.5, f.amt) * (W > H ? Math.max(H * 0.08, (H - W / 2.39) / 2) : H * 0.11), s = ss3(clamp(lt / 0.4, 0, 1)) * ss3(clamp((f.dur - lt) / 0.4, 0, 1));
    x.fillStyle = '#000'; x.fillRect(0, 0, W, hb * s); x.fillRect(0, H - hb * s, W, hb * s);
  } },
  rec: { n: 'Camcorder', cat: 'frame', d: 4, rate: 2, layer: (x, W, H, u, lt) => { // the dot blinks and the clock ticks: two changes a second
    const m = 40 * u, L = 70 * u, q = Math.floor(lt * 2) / 2;
    x.strokeStyle = '#fff'; x.lineWidth = 4 * u; x.globalAlpha = 0.9; x.beginPath();
    for (const [cx, cy, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) { x.moveTo(cx, cy + sy * L); x.lineTo(cx, cy); x.lineTo(cx + sx * L, cy); }
    x.stroke();
    x.font = `600 ${34 * u}px Menlo, monospace`; x.textBaseline = 'middle'; x.fillStyle = '#fff';
    if (q % 1 < 0.5) { x.fillStyle = '#ff2d2d'; x.beginPath(); x.arc(m + 34 * u, m + 46 * u, 11 * u, 0, 6.2832); x.fill(); x.fillStyle = '#fff'; }
    x.fillText('REC', m + 54 * u, m + 46 * u);
    x.strokeRect(W - m - 92 * u, m + 32 * u, 60 * u, 28 * u); x.fillRect(W - m - 30 * u, m + 40 * u, 5 * u, 12 * u);
    for (let i = 0; i < 3; i++) x.fillRect(W - m - 86 * u + i * 19 * u, m + 37 * u, 15 * u, 18 * u);
    x.textAlign = 'right'; x.fillText(clock(Math.floor(q)), W - m - 24 * u, H - m - 44 * u);
  } },
  vignette: { n: 'Vignette', cat: 'frame', d: 4, rate: 0, layer: (x, W, H, u, lt, f) => {
    const g = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${Math.min(0.95, 0.75 * f.amt)})`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  } },
  film: { n: 'Film strip', cat: 'frame', d: 4, rate: 'frame', layer: (x, W, H, u, lt) => { // sprocket holes running past
    const bw = 60 * u, hole = 26 * u, gap = 64 * u, off = (lt * 240 * u) % gap;
    x.fillStyle = '#0b0b0b'; x.fillRect(0, 0, bw, H); x.fillRect(W - bw, 0, bw, H);
    x.fillStyle = 'rgba(235,235,225,0.9)'; x.beginPath();
    for (let y = -gap + off; y < H + gap; y += gap) { x.roundRect((bw - hole) / 2, y, hole, hole * 1.4, 5 * u); x.roundRect(W - bw + (bw - hole) / 2, y, hole, hole * 1.4, 5 * u); }
    x.fill();
  } },
};
// the effects pack: expression steps ('expr', compiled by web/fxpack.js on the page: GLSL in the preview, geq in the export), the
// transform op, and two drawn overlays (in the text layer, so the export workers draw them too)
Object.assign(FX, {
  handheld: { n: 'Handheld', cat: 'camera', d: 3, px: shake(0.012, 1.9, 1.5) }, // slow sway, like a held camera
  beatshake: { n: 'Beat shake', cat: 'camera', d: 2, px: (W, H, u, lt, f) => { const s = 0.045 * f.amt * Math.exp(-sinceBeat(f, lt) / 0.16); return [{ op: 'transform', z: 1 + 2 * s + 0.01, x: W * s * wob(lt * 29), y: H * s * wob(lt * 23 + 5) }]; } },
  leaks: { n: 'Light leaks', cat: 'light', d: 4, px: (W, H, u, lt, f) => [xop('leaks', f, lt)] },
  flare: { n: 'Lens flare', cat: 'light', d: 4, rate: 'frame', layer: (x, W, H, u, lt, f) => { // a source drifting across the top, its halo, a streak and ghosts through the centre
    const a = Math.min(1, 0.85 * f.amt), sx = W * (0.22 + 0.5 * clamp(lt / f.dur, 0, 1)), sy = H * 0.26, R = Math.min(W, H);
    x.globalCompositeOperation = 'lighter';
    const halo = x.createRadialGradient(sx, sy, 0, sx, sy, R * 0.42);
    halo.addColorStop(0, `rgba(255,250,235,${a})`); halo.addColorStop(0.08, `rgba(255,220,170,${0.7 * a})`); halo.addColorStop(0.35, `rgba(255,170,90,${0.18 * a})`); halo.addColorStop(1, 'rgba(255,150,80,0)');
    x.fillStyle = halo; x.fillRect(0, 0, W, H);
    const st = x.createLinearGradient(sx - W * 0.45, 0, sx + W * 0.45, 0);
    st.addColorStop(0, 'rgba(160,200,255,0)'); st.addColorStop(0.5, `rgba(200,225,255,${0.55 * a})`); st.addColorStop(1, 'rgba(160,200,255,0)');
    x.fillStyle = st; x.fillRect(sx - W * 0.45, sy - 2.5 * u, W * 0.9, 5 * u);
    for (const [t, r, col, al] of [[0.45, 0.05, '120,255,180', 0.22], [0.8, 0.025, '255,200,120', 0.3], [1.25, 0.09, '140,170,255', 0.16], [1.55, 0.04, '255,140,200', 0.24], [1.9, 0.13, '120,200,255', 0.1]]) {
      const gx = sx + (W / 2 - sx) * t, gy = sy + (H / 2 - sy) * t, g = x.createRadialGradient(gx, gy, 0, gx, gy, r * R);
      g.addColorStop(0, `rgba(${col},${al * a * 0.6})`); g.addColorStop(0.85, `rgba(${col},${al * a})`); g.addColorStop(1, `rgba(${col},0)`);
      x.fillStyle = g; x.beginPath(); x.arc(gx, gy, r * R, 0, 6.2832); x.fill();
    }
  } },
  edges: { n: 'Edge glow', cat: 'light', d: 3, px: (W, H, u, lt, f) => [xop('edges', f, lt)] },
  dust: { n: 'Dust & scratches', cat: 'retro', d: 3, rate: 'frame', layer: (x, W, H, u, lt, f) => { // new specks, hairs and scratches every frame
    const g = fxFrame(lt), a = Math.min(1, f.amt);
    x.lineCap = 'round';
    for (let i = 0; i < 1 + Math.floor(rnd(g, 1) * 3); i++) { // scratches: long thin lines, light or dark
      const xx = rnd(g, 10 + i) * W, lite = rnd(g, 15 + i) > 0.5;
      x.strokeStyle = lite ? `rgba(240,235,220,${0.35 * a})` : `rgba(25,20,15,${0.4 * a})`; x.lineWidth = Math.max(1, (0.8 + 1.4 * rnd(g, 20 + i)) * u);
      x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx + (rnd(g, 25 + i) - 0.5) * 30 * u, H); x.stroke();
    }
    for (let i = 0; i < Math.floor(rnd(g, 2) * 14 * a); i++) { // specks
      x.fillStyle = rnd(g, 60 + i) > 0.35 ? `rgba(20,15,10,${0.6 * a})` : `rgba(250,245,230,${0.55 * a})`;
      x.beginPath(); x.arc(rnd(g, 30 + i) * W, rnd(g, 40 + i) * H, (0.8 + 3.5 * rnd(g, 50 + i) ** 3) * u * 2, 0, 6.2832); x.fill();
    }
    if (rnd(g, 3) < 0.25 * a) { // a hair
      const hx = rnd(g, 70) * W, hy = rnd(g, 71) * H, L = (30 + 60 * rnd(g, 72)) * u;
      x.strokeStyle = `rgba(15,10,8,${0.55 * a})`; x.lineWidth = Math.max(1, 1.2 * u);
      x.beginPath(); x.moveTo(hx, hy); x.bezierCurveTo(hx + L * (rnd(g, 73) - 0.5), hy + L * 0.6, hx + L * (rnd(g, 74) - 0.2), hy - L * 0.3, hx + L * 0.7, hy + L * (rnd(g, 75) - 0.5)); x.stroke();
    }
  } },
  halftone: { n: 'Halftone', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [xop('halftone', f, lt)] },
  posterize: { n: 'Posterize', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [xop('posterize', f, lt)] },
  oldtv: { n: 'Old TV', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [xop('oldtv', f, lt), { op: 'noise', s: Math.round(clamp(9 * f.amt, 1, 60)) }] },
  nightvision: { n: 'Night vision', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [xop('nightvision', f, lt), { op: 'noise', s: Math.round(clamp(14 * f.amt, 1, 60)) }] },
  thermal: { n: 'Thermal', cat: 'retro', d: 3, px: (W, H, u, lt, f) => [xop('thermal', f, lt)] },
  chroma: { n: 'Chromatic aberration', cat: 'distort', d: 2, px: (W, H, u, lt, f) => [xop('chroma', f, lt)] },
  kaleido: { n: 'Kaleidoscope', cat: 'distort', d: 3, px: (W, H, u, lt, f) => [xop('kaleido', f, lt)] },
  tunnel: { n: 'Mirror tunnel', cat: 'distort', d: 3, px: (W, H, u, lt, f) => [xop('tunnel', f, lt)] },
  datamosh: { n: 'Datamosh', cat: 'distort', d: 2, px: (W, H, u, lt, f) => [xop('datamosh', f, lt)] }, // an approximation: block smears, no real motion vectors
});

const fxOn = (f, t) => t >= f.start && t < f.start + f.dur;
function drawFxLayers(ctx, t, k) { // effect overlays: under the text, in the text layer (preview and export draw them the same way)
  if (P.mute.fx) return;
  const W = P.w * k, H = P.h * k, u = Math.min(W, H) / 1080;
  for (const f of shown('fx')) if (fxOn(f, t) && FX[f.fx]?.layer) { ctx.save(); FX[f.fx].layer(ctx, W, H, u, t - f.start, f); ctx.restore(); }
}

const scratchCv = new Map();
function scratch(W, H, tag) { // reusable offscreen canvases, one per size and purpose
  const key = `${tag}:${W}x${H}`;
  let c = scratchCv.get(key);
  if (!c) { c = typeof document === 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas'); c.width = W; c.height = H; scratchCv.set(key, c); if (scratchCv.size > 64) scratchCv.delete(scratchCv.keys().next().value); }
  return c;
}

// emoji are pictures: colour-emoji text drawn in a layer worker came out differently draw after draw (WebKit), so the page
// draws each one once (256 px, the glyph at 200 px) and the workers get those pixels in the snapshot (P.emoji: ImageData)
const emojiCv = new Map();
function emojiPic(e) {
  let c = emojiCv.get(e);
  if (c) return c;
  c = new OffscreenCanvas(256, 256);
  const x = c.getContext('2d');
  if (P.emoji?.[e]) x.putImageData(P.emoji[e], 0, 0);
  else { x.font = '200px "Apple Color Emoji", "Noto Color Emoji", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(e, 128, 136); }
  emojiCv.set(e, c);
  return c;
}
function textStyle(it, lane) { return { ...TEXT_BASE, ...(lane === 'captions' ? { ...P.capStyle, ...it.style } : it.style) }; }
function drawTexts(ctx, t, k, preview) {
  drawFxLayers(ctx, t, k);
  for (const lane of ['text', 'captions']) if (!P.mute[lane]) for (const it of shown(lane)) if (t >= it.start && t < it.start + it.dur) drawText(ctx, it, lane, t - it.start, k, preview);
}

function drawText(ctx, it, lane, lt, k, preview) { // shared by preview and export: what you see is what renders
  const st = textStyle(it, lane), pr = lane === 'captions' ? { scale: 1, x: 0.5, y: P.capStyle.y, opacity: 1, rot: 0 } : propsAt(it, lt);
  const u = (Math.min(P.w, P.h) / 1080) * k * pr.scale, size = st.size * u;
  const timed = it.words?.length ? it.words : null;
  let active = -1, now = 0; // now: the word being said (the last one started), whatever the highlight
  if (timed) timed.forEach((w, i) => { if (lt >= w.s) now = i; });
  if (timed && st.hl) active = timed.findLastIndex(w => lt >= w.s);
  // words as [text, index into the timed words]; one-word captions show only the word being said
  const paras = timed ? [(st.one ? [now] : timed.map((_, i) => i)).map(i => [timed[i].w, i])] : String(it.text ?? '').split('\n').map(p => p.split(/\s+/).filter(Boolean).map(w => [w, -1]));
  ctx.save();
  ctx.font = `${st.italic ? 'italic ' : ''}${st.weight} ${size}px "${st.font}", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const LS = (st.ls || 0) * size; // letter spacing, drawn letter by letter so it works in every engine (WebKit has no ctx.letterSpacing everywhere)
  const meas = w => (LS ? [...w].reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) + LS * ([...w].length - 1) : ctx.measureText(w).width);
  const put = (stroke, w, x0, y0) => {
    if (!LS) return stroke ? ctx.strokeText(w, x0, y0) : ctx.fillText(w, x0, y0);
    let xx = x0;
    for (const ch of w) { if (stroke) ctx.strokeText(ch, xx, y0); else ctx.fillText(ch, xx, y0); xx += ctx.measureText(ch).width + LS; }
  };
  const cjk = /[぀-ヿ㐀-鿿＀-￯　-〿]/.test(paras.map(q => q.map(x => x[0]).join('')).join('')); // Chinese / Japanese words are characters: no gaps
  const sp = (cjk ? 0 : ctx.measureText(' ').width) + LS, maxW = st.maxW * P.w * k, lines = [];
  const grow = timed && st.wanim === 'scale' ? 1.25 : timed && st.pop ? 1.12 : 1; // every word reserves its popped width: no overlap, and the line doesn't jitter
  let idx = 0;
  for (const para of paras) {
    let ln = { ws: [], w: 0 };
    for (let [w, ti] of para) {
      if (st.upper) w = w.toUpperCase();
      const ww = meas(w);
      if (ln.ws.length && ln.w + sp + ww * grow > maxW) { lines.push(ln); ln = { ws: [], w: 0 }; }
      ln.w += (ln.ws.length ? sp : 0) + ww * grow;
      ln.ws.push({ w, ww, i: idx++, ti });
    }
    lines.push(ln);
  }
  const lh = size * st.lh, x = pr.x * P.w * k, y = pr.y * P.h * k;
  const top = y - (lines.length * lh) / 2, padX = size * (st.boxPad ?? 0.3), BW = Math.max(0, ...lines.map(l => l.w));
  const lx = ln => (st.align === 'left' ? x - BW / 2 : st.align === 'right' ? x + BW / 2 - ln.w : x - ln.w / 2); // line start for the alignment
  if (pr.rot) { ctx.translate(x, y); ctx.rotate((pr.rot * Math.PI) / 180); ctx.translate(-x, -y); }
  const av = st.anim && st.anim !== 'none' ? clamp(lt / animLen(st, false), 0, 1) : 1; // "in" animation progress
  ctx.globalAlpha = pr.opacity * (st.anim === 'type' ? 1 : st.anim === 'pop' ? Math.min(1, av * 2) : st.anim === 'drop' ? Math.min(1, av * 3) : av);
  if (av < 1 && st.anim === 'pop') { const s = 0.6 + 0.4 * easeOutBack(av); ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
  if (av < 1 && st.anim === 'slide') ctx.translate(0, (1 - av) ** 3 * lh * 0.8);
  if (av < 1 && st.anim === 'zoom') { const s = 1.6 - 0.6 * (1 - (1 - av) ** 3); ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
  if (av < 1 && st.anim === 'drop') ctx.translate(0, -(1 - easeOutBack(av)) * lh * 1.6);
  const ao = st.out && st.out !== 'none' ? clamp((it.dur - lt) / animLen(st, true), 0, 1) : 1; // "out" animation, mirrored
  if (ao < 1) {
    if (st.out !== 'type') ctx.globalAlpha *= st.out === 'pop' ? Math.min(1, ao * 2) : ao;
    if (st.out === 'pop') { const s = 0.6 + 0.4 * ao; ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
    if (st.out === 'slide') ctx.translate(0, -((1 - ao) ** 2) * lh * 0.8);
    if (st.out === 'zoom') { const s = 1 + 0.6 * (1 - ao) ** 2; ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
  }
  if (st.loop === 'bounce') ctx.translate(0, -Math.abs(Math.sin(lt * Math.PI * 2)) * size * 0.15);
  if (st.loop === 'pulse') { const s = 1 + 0.06 * Math.sin(lt * Math.PI * 4); ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
  if (st.loop === 'wiggle') { ctx.translate(x, y); ctx.rotate(0.06 * Math.sin(lt * Math.PI * 6)); ctx.translate(-x, -y); }
  const nch = lines.map(l => l.ws.reduce((n2, w) => n2 + [...w.w].length, 0)), before = nch.map((_, i) => nch.slice(0, i).reduce((x2, y2) => x2 + y2, 0));
  const all = before.at(-1) + nch.at(-1);
  let shown = Infinity; // typewriter: characters typed so far; backspace: characters still left
  if (st.anim === 'type' && av < 1) shown = Math.floor(av * all);
  if (st.out === 'type' && ao < 1) shown = Math.min(shown, Math.floor(ao * all));
  let left = shown;
  // WebKit draws shadowed text at full strength whatever globalAlpha says (the default Title popped on instead of fading,
  // in the preview and the export): such text is drawn solid on a scratch canvas, then laid on at the fade
  const main = ctx, fade = ctx.globalAlpha;
  if (st.shadow && fade < 1) {
    const sx = scratch(main.canvas.width, main.canvas.height, 'txa').getContext('2d');
    sx.setTransform(1, 0, 0, 1, 0, 0); sx.clearRect(0, 0, sx.canvas.width, sx.canvas.height);
    sx.setTransform(main.getTransform()); sx.font = main.font; sx.textBaseline = 'middle'; sx.lineJoin = 'round';
    ctx = sx;
  }
  let gradFill = null; // gradient text: top colour to bottom colour over the whole block
  if (st.grad) { gradFill = ctx.createLinearGradient(0, top, 0, top + lines.length * lh); gradFill.addColorStop(0, st.color); gradFill.addColorStop(1, st.grad); }
  if (st.box) {
    ctx.fillStyle = hexA(st.boxColor, st.boxAlpha);
    for (const [li, ln] of lines.entries()) if (ln.ws.length && shown > before[li]) { ctx.beginPath(); ctx.roundRect(lx(ln) - padX, top + li * lh, ln.w + padX * 2, lh, Math.min(lh / 2, size * (st.boxR ?? 0.18))); ctx.fill(); }
  }
  const spkC = st.spk && it.spk != null ? st.spkc?.[it.spk] || SPK_C[it.spk % SPK_C.length] : null, baseC = spkC || st.color; // a speaker's captions in their colour
  const vs = c => spkC && alike(spkC, c) ? [st.color, '#ffffff', '#101010'].find(k => !alike(k, spkC)) : c; // a highlight that would vanish into the speaker's colour
  const hl = vs(st.hl), kwC = vs(st.kwc || (st.hl && st.hl !== st.color ? st.hl : '#ffd400'));
  if (spkC) gradFill = null;
  for (const [li, ln] of lines.entries()) {
    let cx = lx(ln);
    const cy = top + li * lh + lh / 2;
    for (const w of ln.ws) {
      const tw = timed?.[w.ti], on = tw && w.ti === active, wx = cx + (w.ww * grow - w.ww) / 2, chars = [...w.w];
      let vis = left >= chars.length ? w.w : chars.slice(0, Math.max(0, left)).join('');
      left -= chars.length;
      if (tw && lt < tw.s && (st.reveal || (st.wanim && st.wanim !== 'scale'))) vis = ''; // revealed as it is said
      if (vis && tw && st.reveal === 'char') vis = chars.slice(0, Math.ceil(clamp((lt - tw.s) / Math.max(0.05, tw.e - tw.s), 0, 1) * chars.length)).join(''); // typed over its own time
      if (!vis) { cx += w.ww * grow + sp; continue; } // not typed yet: its place stays reserved
      ctx.save();
      const mx = wx + w.ww / 2, around = s => { ctx.translate(mx, cy); ctx.scale(s, s); ctx.translate(-mx, -cy); };
      if (on && st.pop && st.wanim !== 'scale') around(grow);
      if (tw && st.wanim) { // each word's own entrance, from the moment it is said
        const wu = clamp((lt - tw.s) / WORD_T, 0, 1), A = st.wanim;
        if (A === 'pop') { around(0.45 + 0.55 * easeOutBack(wu)); ctx.globalAlpha *= Math.min(1, wu * 2.5); }
        else if (A === 'bounce') { ctx.translate(0, -Math.sin(Math.PI * wu) * 0.35 * size); ctx.globalAlpha *= Math.min(1, wu * 4); }
        else if (A === 'rise') { ctx.translate(0, (1 - ss3(wu)) * 0.55 * size); ctx.globalAlpha *= wu; }
        else if (A === 'fade') ctx.globalAlpha *= wu;
        else if (A === 'slam') { around(1 + 1.3 * (1 - wu) ** 2); ctx.globalAlpha *= Math.min(1, wu * 3); }
        else if (A === 'scale' && on) around(1 + (grow - 1) * ss3(clamp((lt - tw.s) / 0.15, 0, 1)));
      }
      let fill = gradFill || baseC; // two-tone: every other word in the second colour; keywords in the highlight
      if (st.color2 && (w.ti >= 0 ? w.ti : w.i) % 2) fill = st.color2;
      if (st.kw && tw && it.kw?.includes(w.ti)) fill = kwC;
      if (on && !st.wbox && !st.kar) fill = hl;
      if (on && st.wbox) { ctx.fillStyle = hl; ctx.beginPath(); ctx.roundRect(wx - size * 0.16, cy - size * 0.62, w.ww + size * 0.32, size * 1.24, size * 0.2); ctx.fill(); }
      if (st.stack > 0) { // shadow stack: hard copies stepping down-right, the furthest first
        ctx.fillStyle = ctx.strokeStyle = st.shc || '#000000'; ctx.lineWidth = st.strokeW * u * 2;
        for (let j = Math.round(st.stack); j > 0; j--) { const o = j * size * 0.03; if (st.strokeW > 0) put(true, vis, wx + o, cy + o); put(false, vis, wx + o, cy + o); }
      }
      if (st.shadow) { ctx.shadowColor = hexA(st.shc || '#000000', st.sha ?? 0.55); ctx.shadowBlur = size * (st.shb ?? 0.18); ctx.shadowOffsetX = size * (st.shx || 0); ctx.shadowOffsetY = size * (st.shy ?? 0.04); }
      if (st.strokeW > 0) { ctx.lineWidth = st.strokeW * u * 2; ctx.strokeStyle = st.stroke; put(true, vis, wx, cy); ctx.shadowColor = 'transparent'; }
      ctx.fillStyle = fill;
      put(false, vis, wx, cy);
      const kp = st.kar && tw ? clamp((lt - tw.s) / Math.max(0.05, tw.e - tw.s), 0, 1) : 0; // karaoke: the highlight sweeps through the word as it is said
      if (kp > 0) {
        ctx.shadowColor = 'transparent'; ctx.beginPath(); ctx.rect(wx - size, cy - size * 1.5, size + w.ww * kp, size * 3); ctx.clip();
        ctx.fillStyle = hl; put(false, vis, wx, cy);
      }
      ctx.restore();
      cx += w.ww * grow + sp;
    }
  }
  let yTop = top, yBot = top + lines.length * lh; // extras around the block: speaker name and emoji above, the translation below
  if (st.bi && it.tr) {
    let bs = size * (st.biSize ?? 0.6);
    const bf = s => `${st.italic ? 'italic ' : ''}${Math.min(st.weight, 700)} ${s}px "${st.biFont || st.font}", system-ui, sans-serif`;
    ctx.font = bf(bs);
    const tw2 = ctx.measureText(it.tr).width;
    if (tw2 > maxW) { bs *= maxW / tw2; ctx.font = bf(bs); } // one line: shrunk to fit
    const bw2 = Math.min(maxW, tw2), by = yBot + bs * 0.75, bx = st.align === 'left' ? x - BW / 2 : st.align === 'right' ? x + BW / 2 - bw2 : x - bw2 / 2;
    if (st.box) { ctx.fillStyle = hexA(st.boxColor, st.boxAlpha); ctx.beginPath(); ctx.roundRect(bx - padX * 0.7, by - bs * 0.7, bw2 + padX * 1.4, bs * 1.4, bs * 0.3); ctx.fill(); }
    if (st.strokeW > 0) { ctx.lineWidth = st.strokeW * u * 2 * (st.biSize ?? 0.6); ctx.strokeStyle = st.stroke; ctx.strokeText(it.tr, bx, by); }
    ctx.fillStyle = st.biColor || '#ffe27a'; ctx.fillText(it.tr, bx, by);
    yBot = by + bs * 0.75;
  }
  if (st.spk && it.spk != null) {
    const ls = size * 0.42;
    ctx.font = `700 ${ls}px "${st.font}", system-ui, sans-serif`;
    const name = st.spkNames?.[it.spk] || `Speaker ${it.spk + 1}`, nw = ctx.measureText(name).width, ny = yTop - ls * 0.8;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(x - nw / 2 - ls * 0.45, ny - ls * 0.68, nw + ls * 0.9, ls * 1.36, ls * 0.68); ctx.fill();
    ctx.fillStyle = baseC; ctx.fillText(name, x - nw / 2, ny);
    yTop = ny - ls * 0.8;
  }
  if (st.emoji && it.emoji) { // the caption's emoji pops in above it
    const es = size * 1.05, eu = clamp(lt / 0.25, 0, 1), ey = yTop - es * 0.62;
    const s = (es / 200) * (0.3 + 0.7 * easeOutBack(eu));
    ctx.save(); ctx.translate(x, ey); ctx.scale(s, s); ctx.rotate(-0.12 * (1 - eu)); ctx.drawImage(emojiPic(it.emoji), -128, -128); ctx.restore();
    yTop = ey - es * 0.6;
  }
  if (ctx !== main) { main.setTransform(1, 0, 0, 1, 0, 0); main.globalAlpha = fade; main.drawImage(ctx.canvas, 0, 0); ctx = main; }
  ctx.restore();
  if (preview) {
    const bw = Math.max(size, ...lines.map(l => l.w)) / 2 + padX;
    hits.push({ lane, id: it.id, x0: x - bw, y0: yTop, x1: x + bw, y1: yBot, rot: pr.rot || 0 });
  }
}

// ---------- the export's text layer (buildPlan's textLayer): the same functions run in the layer workers and, as the fallback, on the page ----------
function layerDraw(ctx, k, f) { // frame f drawn: its pixels, their hash and ink box ([x0, y0, x1, y1], ends exclusive; null = nothing shows)
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  drawTexts(ctx, f / P.fps, k, false); // exactly what the preview draws on that frame (same function, same time)
  // the same picture again (a looping title comes back every half second) is found by its pixels, not encoded again
  const img = ctx.getImageData(0, 0, w, h), px = new Uint32Array(img.data.buffer);
  let h1 = 2166136261, h2 = 0x9e3779b9, x0 = w, y0 = -1, x1 = -1, y1 = -1;
  for (let y = 0, j = 0; y < h; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++, j++) { const v = px[j]; h1 = Math.imul(h1 ^ v, 16777619); h2 = Math.imul(h2 ^ v, 2246822519) ^ (h2 >>> 13); if (v) { if (a < 0) a = x; b = x; } }
    if (a >= 0) { if (y0 < 0) y0 = y; y1 = y; x0 = Math.min(x0, a); x1 = Math.max(x1, b); }
  }
  return { img, key: `${h1 >>> 0}:${h2 >>> 0}`, bb: y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1] };
}
function layerScan(ctx, k, frames) { // [frame, hash, ...ink box or null] per frame
  return frames.map(f => { const { key, bb } = layerDraw(ctx, k, f); return [f, key, ...(bb || [null])]; });
}
async function layerEncode(ctx, k, box, items, lid, onDone) { // items [index, frame, scan hash]: drawn again, cut to the box, PNG, uploaded; 2 uploads in flight
  const [bx, by, bw, bh] = box, crop = new OffscreenCanvas(bw, bh), cx = crop.getContext('2d', { willReadFrequently: true }), busy = new Set();
  const inBox = bb => !bb || (bb[0] >= bx && bb[1] >= by && bb[2] <= bx + bw && bb[3] <= by + bh);
  let redrawn = 0;
  for (const [i, f, key] of items) {
    // a picture is taken when two drawings of it agree: WebKit workers drawing at the same time now and then draw one
    // differently (a title at another size, a box edge off; 2+ workers, also in the scan). This one matching the scan,
    // or two redraws matching each other (the scan was the odd one), and its ink inside the box
    let d = layerDraw(ctx, k, f), last = null;
    for (let n = 0; d.key !== key && !(last?.key === d.key && inBox(d.bb)); n++, redrawn++) {
      if (n === 4) throw new Error(`text layer frame ${f} drew differently every time`);
      last = d; d = layerDraw(ctx, k, f);
    }
    cx.putImageData(d.img, -bx, -by, bx, by, bw, bh); // the box of the very pixels hashed
    const png = await (await crop.convertToBlob({ type: 'image/png' })).arrayBuffer(); // bytes, not the Blob: a Blob body arrives empty under Playwright request interception (WebKit)
    const up = fetch(`/api/layer/${lid}/${i}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: png })
      .then(async r => { if (!r.ok) throw new Error(`text layer upload: ${(await r.json().catch(() => ({}))).error || r.status}`); onDone(i); }).finally(() => busy.delete(up));
    busy.add(up);
    if (busy.size >= 2) await Promise.race(busy);
  }
  await Promise.all(busy);
  return redrawn;
}
function probeText(font) { // a line of text in that font, for the page and the workers to compare (do the workers have the page's fonts?)
  const x = new OffscreenCanvas(480, 96).getContext('2d', { willReadFrequently: true });
  x.font = font; x.fillStyle = '#fff'; x.textBaseline = 'middle';
  x.fillText('Hamburgefonstiv 0123 ÄÖ', 4, 48);
  return x.getImageData(0, 0, 480, 96).data;
}
