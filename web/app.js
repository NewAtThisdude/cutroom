// Cutroom: timeline model, preview engine and editing UI. No build step, no dependencies.
// The project is a CapCut-style draft: lanes of clips that reference media by id, times in seconds.
// The server turns it into one ffmpeg graph; drawText() renders text for preview AND export.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const hex12 = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const even = x => Math.round(x / 2) * 2;
const hexA = (hex, a = 1) => `${hex}${Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0')}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: only "reopen last project" is lost */ } },
};

async function api(path, body, method = body === undefined ? 'GET' : 'POST', keepalive = false) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(path, { method, headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: json, keepalive: keepalive && json.length < 6e4 }); // keepalive: the page may be going away (64 KB cap)
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

const LANES = [
  { key: 'fx', label: 'Effects', h: 28 },
  { key: 'text', label: 'Text', h: 30 },
  { key: 'captions', label: 'Captions', h: 30 },
  { key: 'overlay', label: 'Overlay', h: 42 },
  { key: 'main', label: 'Main', h: 58 },
  { key: 'audio', label: 'Audio', h: 42 },
];
const RATIOS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440], '4:3': [1440, 1080], '21:9': [2520, 1080] };
const FONTS = ['Montserrat', 'Poppins', 'Anton', 'Bebas Neue', 'Helvetica Neue', 'Arial Black', 'Impact', 'Futura', 'Avenir Next', 'Georgia', 'Marker Felt', 'American Typewriter', 'Menlo'];
const TEXT_BASE = { font: 'Montserrat', weight: 800, size: 72, color: '#ffffff', stroke: '#000000', strokeW: 0, shadow: false, box: false, boxColor: '#000000', boxAlpha: 0.72, upper: false, hl: '#ffd400', pop: false, maxW: 0.86, lh: 1.15,
  italic: false, align: 'center', ls: 0, shc: '#000000', sha: 0.55, shb: 0.18, shx: 0, shy: 0.04, boxR: 0.18, boxPad: 0.3 };
const TEXT_PRESETS = {
  Title: { font: 'Montserrat', weight: 900, size: 116, shadow: true },
  Subtitle: { font: 'Poppins', weight: 800, size: 64, shadow: true },
  Label: { font: 'Montserrat', weight: 800, size: 58, box: true },
  Outline: { font: 'Anton', weight: 400, size: 124, strokeW: 7, upper: true },
  Headline: { font: 'Bebas Neue', weight: 400, size: 150, color: '#ffd400', shadow: true },
  Typewriter: { font: 'American Typewriter', weight: 600, size: 60, box: true, boxColor: '#111111', boxAlpha: 0.85 },
  Sticker: { font: 'Montserrat', weight: 400, size: 230, anim: 'pop' }, // emoji render through the system emoji font
  Neon: { font: 'Poppins', weight: 800, size: 96, color: '#ffffff', shadow: true, shc: '#ff2bd6', sha: 1, shb: 0.5, shx: 0, shy: 0 },
  Glow: { font: 'Montserrat', weight: 800, size: 96, color: '#fff7c2', shadow: true, shc: '#ffb800', sha: 1, shb: 0.55, shx: 0, shy: 0 },
  Gradient: { font: 'Montserrat', weight: 900, size: 118, color: '#ffe259', grad: '#ff5e7e', shadow: true },
  Retro: { font: 'Bebas Neue', weight: 400, size: 150, color: '#ffd400', shadow: true, shc: '#e4002b', sha: 1, shb: 0, shx: 0.05, shy: 0.05 },
  Comic: { font: 'Marker Felt', weight: 400, size: 104, color: '#ffffff', stroke: '#111111', strokeW: 6, shadow: true, shc: '#111111', sha: 1, shb: 0, shx: 0.04, shy: 0.05 },
  Marker: { font: 'Montserrat', weight: 800, size: 62, color: '#111111', box: true, boxColor: '#ffd400', boxAlpha: 1, boxR: 0.06 },
  Bubble: { font: 'Poppins', weight: 800, size: 64, color: '#ffffff', box: true, boxColor: '#ff3d7f', boxAlpha: 1, boxR: 1, boxPad: 0.55 },
  Minimal: { font: 'Helvetica Neue', weight: 300, size: 64, ls: 0.22, upper: true },
};
const CAP_PRESETS = {
  Bold: { font: 'Montserrat', weight: 900, size: 78, color: '#ffffff', stroke: '#000000', strokeW: 7, hl: '#ffd400', upper: true, pop: true },
  Clean: { font: 'Poppins', weight: 800, size: 62, color: '#ffffff', strokeW: 0, hl: '#ffffff', shadow: true },
  Boxed: { font: 'Montserrat', weight: 800, size: 58, color: '#ffffff', strokeW: 0, hl: '#ff7a45', box: true, boxAlpha: 0.75 },
  Neon: { font: 'Anton', weight: 400, size: 96, color: '#ffffff', stroke: '#000000', strokeW: 6, hl: '#3dff8b', upper: true, pop: true },
};
const ICON = {
  play: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>',
  expand: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  shrink: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
};

const TRANSITIONS = [['none', 'None'], ['fade', 'Dissolve'], ['fadeblack', 'Dip to black'], ['fadewhite', 'Dip to white'], ['fadegrays', 'Fade to grey'], ['dissolve', 'Noise'],
  ['pixelize', 'Pixelate'], ['hblur', 'Blur'], ['zoomin', 'Zoom'], ['whipleft', 'Whip left'], ['whipright', 'Whip right'], ['zoomblur', 'Zoom blur'], ['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['wipeup', 'Wipe up'], ['wipedown', 'Wipe down'],
  ['smoothleft', 'Soft wipe left'], ['smoothright', 'Soft wipe right'], ['smoothup', 'Soft wipe up'], ['smoothdown', 'Soft wipe down'], ['slideleft', 'Slide left'], ['slideright', 'Slide right'],
  ['slideup', 'Slide up'], ['slidedown', 'Slide down'], ['squeezeh', 'Squeeze'], ['squeezev', 'Squeeze sideways'], ['circleopen', 'Circle open'], ['circleclose', 'Circle close'],
  ['radial', 'Clock'], ['vertopen', 'Doors'], ['horzopen', 'Split open'], ['diagtl', 'Diagonal'], ['diagbr', 'Diagonal back'], ['hlslice', 'Slices'], ['vuslice', 'Blinds']];
const ANIMS = [['none', 'None'], ['pop', 'Pop in'], ['fade', 'Fade in'], ['slide', 'Slide up'], ['zoom', 'Zoom in'], ['drop', 'Drop in'], ['type', 'Typewriter']];
const OUTS = [['none', 'None'], ['pop', 'Pop out'], ['fade', 'Fade out'], ['slide', 'Slide out'], ['zoom', 'Zoom out'], ['type', 'Backspace']];
const animLen = (st, out) => (out ? st.outT : st.animT) ?? ((out ? st.out : st.anim) === 'type' ? 1.2 : ANIM_T); // text in/out length; typing takes longer
const LOOP_ANIMS = [['none', 'None'], ['kbin', 'Ken Burns in'], ['kbout', 'Ken Burns out'], ['drift', 'Drift'], ['pulse', 'Pulse'], ['shake', 'Shake'], ['sway', 'Sway'], ['float', 'Float']];
const wob = t => 0.5 * Math.sin(t) + 0.3 * Math.sin(2.3 * t + 1.7) + 0.2 * Math.sin(4.1 * t + 3.1); // smooth deterministic jitter (the export bakes the same)
const LOOPS = [['none', 'None'], ['bounce', 'Bounce'], ['pulse', 'Pulse'], ['wiggle', 'Wiggle']];
const FORMATS = [['mp4', 'MP4 · H.264'], ['hevc', 'MP4 · HEVC (smaller)'], ['prores', 'MOV · ProRes 422 (for editing)'], ['gif', 'GIF'], ['mp3', 'Audio · MP3'], ['wav', 'Audio · WAV'], ['png', 'Still frame at playhead (PNG)'], ['srt', 'Subtitles · SRT (captions)']];
const ANIM_T = 0.3; // default text in/out animation length, seconds
const KF_PROPS = ['scale', 'x', 'y', 'opacity', 'rot'];
const MASKS = [['none', 'None'], ['circle', 'Circle'], ['rect', 'Rectangle'], ['linear', 'Linear'], ['mirror', 'Mirror']];
const BLENDS = [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], // canvas modes; the export runs the same formulas
  ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'], ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'], ['exclusion', 'Exclusion']];
const CLIP_ANIMS = [['none', 'None'], ['fade', 'Fade'], ['grow', 'Zoom in'], ['shrink', 'Zoom out'], ['left', 'Slide left'], ['right', 'Slide right'], ['up', 'Slide up'], ['down', 'Slide down'], ['rotate', 'Rotate'], ['spin', 'Spin']];
const WEIGHTS = { Montserrat: [400, 500, 600, 700, 800, 900], Poppins: [800, 900], Anton: [400], 'Bebas Neue': [400], 'Helvetica Neue': [300, 400, 500, 700], 'Arial Black': [900], Impact: [400],
  Futura: [500, 700], 'Avenir Next': [400, 500, 600, 700, 800], Georgia: [400, 700], 'Marker Felt': [400], 'American Typewriter': [400, 700], Menlo: [400, 700] }; // weights each font really has
const WEIGHT_NAMES = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
const CANVAS_FILTER = 'filter' in CanvasRenderingContext2D.prototype; // WebKit (the Mac app) has no ctx.filter: filters and feathering are done by hand
const ALPHA_Q = navigator.vendor.startsWith('Apple') ? '?alpha=hevc' : ''; // WebKit plays VP9 alpha opaque; the server hands it an HEVC-alpha copy
const WK_Q = navigator.vendor.startsWith('Apple') ? '?wk=1' : ''; // WebKit colour-manages video (BT.709 mid-tones lifted): a re-labelled copy shows it as exported
const RAMPS = { // speed multipliers over 8 equal parts of the clip (CapCut's curve presets, baked into editable parts)
  montage: [1, 1.6, 0.5, 2, 1, 0.5, 1.8, 1], hero: [1, 1, 0.5, 0.25, 0.25, 0.5, 1, 1], bullet: [2, 2, 0.35, 0.2, 0.35, 2, 2, 2],
  jumpcut: [1, 1, 3, 3, 1, 1, 3, 3], flashin: [4, 3, 2, 1.5, 1, 1, 1, 1], flashout: [1, 1, 1, 1, 1.5, 2, 3, 4],
};
const RAMP_NAMES = { montage: 'Montage', hero: 'Hero', bullet: 'Bullet', jumpcut: 'Jump cut', flashin: 'Flash in', flashout: 'Flash out' };
const sat = s => [.213 + .787 * s, .715 - .715 * s, .072 - .072 * s, .213 - .213 * s, .715 + .285 * s, .072 - .072 * s, .213 - .213 * s, .715 - .715 * s, .072 + .928 * s];
const LOOKS = { // 3x3 RGB matrices: the preview uses them as SVG feColorMatrix, the export as colorchannelmixer
  vivid: sat(1.45), mono: sat(0), sepia: [.393, .769, .189, .349, .686, .168, .272, .534, .131],
  warm: [1.1, .05, 0, 0, 1.02, 0, 0, -.04, .86], cool: [.88, 0, .04, 0, .98, .05, .04, .06, 1.12], teal: [1.12, .06, -.18, -.06, 1.02, .04, -.16, .12, 1.1],
  film: [1.02, .1, -.04, .04, .96, .02, -.02, .08, .84], golden: [1.18, .1, -.06, .04, 1.04, -.04, -.1, -.04, .78], punch: [1.245, -.186, -.019, -.053, 1.071, -.018, -.051, -.172, 1.183],
  rose: [1.1, .04, .06, 0, .94, .04, .04, 0, 1.02], dusk: [1.1, 0, .1, 0, .88, .08, .1, .05, 1], emerald: [.86, .08, 0, .02, 1.08, 0, 0, .1, .94],
  arctic: [.85, .05, .1, .05, .95, .1, .1, .1, 1.15], night: [.7, .05, .1, .02, .8, .12, .04, .12, 1.1], retro: [.95, .15, 0, .1, .9, .05, .05, .15, .7],
  silver: [.331, .608, .061, .181, .758, .061, .2, .62, .26],
};
const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

let P = null;                        // current project
const M = new Map();                 // media id -> server metadata
const S = { sel: null, multi: new Set(), t: 0, playing: false, rate: 1, back: 0, pps: 60, t0: 0, wall0: 0, end: 0, exporting: false }; // multi: more selected clips ('lane:id')
let rafId = 0; // the preview draws only when something changed or it plays: an always-on 60 Hz loop kept 8 % of a core busy at rest
const kick = () => { if (!rafId) rafId = requestAnimationFrame(frame); };
{ let d = true; Object.defineProperty(S, 'dirty', { get: () => d, set: v => { d = v; if (v) kick(); }, enumerable: true }); }
let undo = [], redo = [], pending = null, saveTimer = 0, hits = [];
const uploads = [], pool = new Map(), imgs = new Map();

// ---------- time ----------
const len = c => c.dur ?? (c.out - c.in) / c.speed;
const frames = c => Math.max(1, Math.round(len(c) * P.fps));
const tdur = (c, lane) => (lane === 'main' ? frames(c) / P.fps : len(c)); // main clips snap to whole frames, like the export
// motion blur: frames mixed (the export's tmix), 0 = off; and the clip's own frame number at clip time lt (0 = its first frame)
const mbN = c => (c.mb > 0 && M.get(c.media)?.kind === 'video' ? 1 + Math.max(1, Math.round(c.mb * 4)) : 0);
const clipFrame = (c, lt) => Math.max(0, Math.floor((c.start + lt) * P.fps + 1e-6) - Math.ceil(c.start * P.fps - 1e-6));
const mbSig = c => JSON.stringify([c.media, c.start, c.in, c.speed, c.adj, c.look, c.grade, c.key, c.mask, c.mkf, c.lkf, c.beauty, c.flip, c.crop, P.fps]); // what the held frames depend on
function trF(i) { // frames main clip i shares with i+1 in a transition (0 = hard cut); same clamp as server overlap()
  const c = P.main[i], n = P.main[i + 1];
  return c?.tr && n ? clamp(Math.round((+c.tr.d || 0.5) * P.fps), 1, Math.floor(Math.min(frames(c), frames(n)) / 2)) : 0;
}
function packMain() { let f = 0; P.main.forEach((c, i) => { c.start = f / P.fps; f += frames(c) - trF(i); }); return f / P.fps; }
function total() { packMain(); let t = 0; for (const L of LANES) for (const c of P[L.key]) t = Math.max(t, c.start + tdur(c, L.key)); return t; }
const snap = t => Math.round(t * P.fps) / P.fps;
function tc(t) { const fps = Math.round(P.fps), f = Math.round(t * P.fps), s = Math.floor(f / fps); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f % fps).padStart(2, '0')}`; }
const mss = t => { const d = Math.round(t * 10) / 10; return `${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, '0')}`; }; // m:ss.s outside the transport (00:04:12 read as minutes or frames)
const fmtDur = s => (s > 0 && s < 1 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`); // a sound effect under a second isn't "0:00"

const ss3 = x => x * x * (3 - 2 * x);
const easeU = (u, r0, r1) => { const d = ss3(r1) - ss3(r0); return d > 1e-9 ? (ss3(r0 + u * (r1 - r0)) - ss3(r0)) / d : u; }; // part [r0, r1] of a smoothstep, rescaled to 0..1
function propsAt(c, lt) { // keyframed scale/x/y/opacity at clip-local time: linear, exactly like the server's pw()
  const k = c.kf;
  if (!k?.length) return { scale: c.scale ?? 1, x: c.x ?? 0, y: c.y ?? 0, opacity: c.opacity ?? 1, rot: c.rot ?? 0 };
  let i = 0;
  while (i + 1 < k.length && k[i + 1].t <= lt) i++;
  const a = k[i], b = k[i + 1];
  if (!b) return { scale: a.scale, x: a.x, y: a.y, opacity: a.opacity, rot: a.rot ?? 0 }; // never leak a keyframe's own t
  let u = clamp((lt - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
  if (a.ease ?? c.ease) u = easeU(u, a.eu0 ?? 0, a.eu1 ?? 1); // smoothstep from this keyframe (or clip default), same as pw() with e=1
  const mix = p => (a[p] ?? 0) + ((b[p] ?? 0) - (a[p] ?? 0)) * u;
  return { scale: mix('scale'), x: mix('x'), y: mix('y'), opacity: mix('opacity'), rot: mix('rot') };
}
function envAt(c, lt) { // volume envelope (auto-duck) as a multiplier of the clip volume, linear like the server's
  const k = c.vkf;
  if (!k?.length) return 1;
  let i = 0;
  while (i + 1 < k.length && k[i + 1].t <= lt) i++;
  const a = k[i], b = k[i + 1];
  return b ? a.v + (b.v - a.v) * clamp((lt - a.t) / Math.max(1e-6, b.t - a.t), 0, 1) : a.v;
}
const volAt = (c, lt) => c.volume * envAt(c, lt);
const fadeAt = (c, lt, d) => clamp(c.fadeIn > 0 ? lt / c.fadeIn : 1, 0, 1) * clamp(c.fadeOut > 0 ? (d - lt) / c.fadeOut : 1, 0, 1); // = ffmpeg's two chained fades
function animSpans(c, d) { // in/out animation lengths, capped so the two never overlap
  const A = c.anim || {}, hi = !!A.in && A.in !== 'none', ho = !!A.out && A.out !== 'none', cap = hi && ho ? d / 2 : d;
  return { ind: hi ? Math.min(A.ind ?? 0.5, cap) : 0, outd: ho ? Math.min(A.outd ?? 0.5, cap) : 0 };
}
function clipAnim(c, lt, d, pr) { // CapCut-style clip in/out animation on top of the keyframed props (preview live; export gets it baked by bakeKf)
  if (!c.anim) return pr;
  const { ind, outd } = animSpans(c, d), r = { ...pr };
  const one = (type, q, dir) => { // q: 1 = fully away .. 0 = at rest; dir: -1 arriving, +1 leaving (names say which way it moves)
    if (type === 'fade') r.opacity *= 1 - q;
    else if (type === 'grow' || type === 'shrink') { r.scale *= 1 + (type === 'grow' ? dir : -dir) * 0.6 * q; r.opacity *= 1 - q; }
    else if (type === 'rotate') { r.rot += dir * 90 * q; r.scale *= 1 - 0.5 * q; r.opacity *= 1 - q; }
    else if (type === 'spin') { r.rot += dir * 360 * q; r.scale *= 1 - 0.7 * q; r.opacity *= 1 - q; }
    else { const [vx, vy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[type] || [0, 0]; r.x += vx * q * dir; r.y += vy * q * dir; }
  };
  if (ind > 0 && lt < ind) one(c.anim.in, (1 - clamp(lt / ind, 0, 1)) ** 3, -1); // ease out on arrival
  if (outd > 0 && lt > d - outd) one(c.anim.out, clamp((lt - (d - outd)) / outd, 0, 1) ** 3, 1); // ease in on the way out
  const L = c.anim.loop, s = c.anim.amt ?? 1, u = d > 0 ? clamp(lt / d, 0, 1) : 0; // whole-clip motion
  if (L === 'kbin') r.scale *= 1 + 0.15 * s * u;
  else if (L === 'kbout') r.scale *= 1 + 0.15 * s * (1 - u);
  else if (L === 'drift') { r.scale *= 1 + 0.08 * s; r.x += 0.04 * s * (2 * u - 1); }
  else if (L === 'pulse') r.scale *= 1 + 0.04 * s * Math.sin((2 * Math.PI * lt) / 1.2);
  else if (L === 'shake') { r.x += 0.012 * s * wob(lt * 11); r.y += 0.012 * s * wob(lt * 13 + 5); }
  else if (L === 'sway') r.rot += 3 * s * Math.sin((2 * Math.PI * lt) / 2);
  else if (L === 'float') r.y += 0.015 * s * Math.sin((2 * Math.PI * lt) / 2.5);
  return r;
}
function bakeKf(c, lane) { // export keyframes: the user's, plus in/out animations sampled at every frame (exact at frame times)
  const uk = c.kf || [], d = tdur(c, lane), { ind, outd } = animSpans(c, d), ease = f => ((f.ease ?? c.ease) ? 1 : 0);
  const loop = !!c.anim?.loop && c.anim.loop !== 'none';
  if (!ind && !outd && !loop) return uk.length ? uk.map(f => ({ ...f, e: ease(f) })) : null;
  const R = [];
  for (let [s0, e0] of (loop ? [[0, d]] : [ind ? [0, ind] : null, outd ? [d - outd, d] : null]).filter(Boolean)) {
    for (let i = 0; i + 1 < uk.length; i++) if (uk[i].t < e0 && uk[i + 1].t > s0) { s0 = Math.min(s0, uk[i].t); e0 = Math.max(e0, uk[i + 1].t); } // whole user segments: the rest stays exact
    const prev = R.at(-1);
    if (prev && s0 <= prev[1]) prev[1] = Math.max(prev[1], e0); else R.push([s0, e0]);
  }
  const inR = t => R.some(([a, b]) => t > a + 1e-6 && t < b - 1e-6), pts = new Map(), F = P.fps;
  for (const [a, b] of R) {
    const step = Math.max(1, Math.ceil(((b - a) * F) / 1500)); // ponytail: very long animated stretches get sampled every few frames
    pts.set(a, 0);
    for (let j = Math.ceil(a * F - 1e-6); j / F < b; j += step) pts.set(j / F, 0);
    pts.set(b, 0);
  }
  const own = new Map();
  for (const f of uk) if (!inR(f.t + 1e-4)) { pts.set(f.t, ease(f)); own.set(f.t, f); } // the segment after it is outside the sampled stretch: keep its easing
  return [...pts].sort((x, y) => x[0] - y[0]).map(([t, e]) => ({ t, ...clipAnim(c, t, d, propsAt(c, t)), e, eu0: own.get(t)?.eu0, eu1: own.get(t)?.eu1 }));
}
function sliceKf(c, t0, t1, k = 1) { // keyframes for the part of c between clip-local t0..t1 (split, ramps, pauses, freeze); k = old speed / new speed
  if (!c.kf?.length) return undefined;
  const K = c.kf, pts = [{ ...propsAt(c, t0), t: t0 }, ...K.filter(f => f.t > t0 + 1e-6 && f.t < t1 - 1e-6).map(f => ({ ...f })), { ...propsAt(c, t1), t: t1 }];
  for (let i = 0; i + 1 < pts.length; i++) { // each new segment sits inside one original segment: keep its exact curve (the matching part of the smoothstep)
    const p = pts[i], q = pts[i + 1], o = K.findLast(f => f.t <= p.t + 1e-9), n = o && K[K.indexOf(o) + 1];
    delete p.eu0; delete p.eu1;
    if (!o || !n || !(o.ease ?? c.ease)) { p.ease = false; continue; }
    const r0 = o.eu0 ?? 0, r1 = o.eu1 ?? 1, span = n.t - o.t, ua = (p.t - o.t) / span, ub = (q.t - o.t) / span;
    Object.assign(p, { ease: true, eu0: r0 + ua * (r1 - r0), eu1: r0 + ub * (r1 - r0) });
  }
  return pts.map(p => ({ ...p, t: (p.t - t0) * k }));
}
function sliceEnv(c, t0, t1, k = 1) {
  if (!c.vkf?.length) return undefined;
  return [{ t: 0, v: envAt(c, t0) }, ...c.vkf.filter(f => f.t > t0 + 1e-6 && f.t < t1 - 1e-6).map(f => ({ ...f, t: (f.t - t0) * k })), { t: (t1 - t0) * k, v: envAt(c, t1) }];
}
const partAnim = (a, first, last) => a && { ...a, in: first ? a.in : 'none', out: last ? a.out : 'none' }; // In stays on the first part, Out on the last
function geom(m, c, W, H, pr = propsAt(c, 0)) { // media rect on the canvas: crop, fit/fill, then scale and offset (fractions of canvas)
  const cr = c.crop || {}, mw = m.w * (1 - (cr.l || 0) - (cr.r || 0)), mh = m.h * (1 - (cr.t || 0) - (cr.b || 0));
  const s = (c.fit === 'fill' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh)) * pr.scale;
  const w = mw * s, h = mh * s;
  return { x: (W - w) / 2 + pr.x * W, y: (H - h) / 2 + pr.y * H, w, h };
}
function lookMatrix(c) { // filter preset blended with identity by strength, then temperature / tint: one 3x3 for the preview and the export
  const p = c.look && LOOKS[c.look.name], a = c.look?.amount ?? 1, tp = c.adj?.temp || 0, tn = c.adj?.tint || 0;
  let M = p ? p.map((v, i) => (i % 4 === 0 ? 1 : 0) + (v - (i % 4 === 0 ? 1 : 0)) * a) : null;
  if (tp || tn) { // warm = more red, less blue; positive tint = magenta (less green). Diagonal, so it scales M's rows
    const T = [1 + 0.2 * tp + 0.05 * tn, 1 - 0.12 * tn, 1 - 0.2 * tp + 0.05 * tn];
    M = (M || [1, 0, 0, 0, 1, 0, 0, 0, 1]).map((v, i) => v * T[Math.floor(i / 3)]);
  }
  return M;
}
const s2l = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), l2s = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
function monotone(pts) { // Fritsch-Carlson monotone cubic through the points: a smooth curve with no overshoot
  const n = pts.length, x = pts.map(q => q[0]), y = pts.map(q => q[1]), d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return v => {
    let i = 0;
    while (i < n - 2 && v > x[i + 1]) i++;
    const h = x[i + 1] - x[i], t = (v - x[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
const toneCache = new Map();
function toneLUT(c) { // exposure (in linear light), highlights, shadows, fade: one 256-entry curve the preview and the export both apply
  const a = c.adj || {}, ex = a.ex || 0, hi = a.hi || 0, sh = a.sh || 0, fd = a.fade || 0;
  if (!ex && !hi && !sh && !fd) return null;
  const key = [ex, hi, sh, fd].join('|');
  if (!toneCache.has(key)) {
    const ys = [0.22 * fd, 0.25 + 0.12 * sh, 0.5 + 0.03 * (sh + hi), 0.75 + 0.12 * hi, 1 - 0.06 * fd];
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1]); // keep it monotone
    const f = monotone([0, 0.25, 0.5, 0.75, 1].map((x, i) => [x, ys[i]]));
    toneCache.set(key, Array.from({ length: 256 }, (_, i) => {
      const v = ex ? l2s(clamp(s2l(i / 255) * 2 ** ex, 0, 1)) : i / 255;
      return Math.round(clamp(f(v), 0, 1) * 255);
    }));
  }
  return toneCache.get(key);
}
const toneIds = new Map();
function toneFilter(t) { // canvas filter url() for the curve: an feComponentTransfer table, exact at 8-bit inputs like ffmpeg's lut1d
  const key = t.join(',');
  if (!toneIds.has(key)) {
    const id = `tn${toneIds.size}`, vals = t.map(v => (v / 255).toFixed(5)).join(' ');
    $('#looks').insertAdjacentHTML('beforeend', `<filter id="${id}" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="table" tableValues="${vals}"/><feFuncG type="table" tableValues="${vals}"/><feFuncB type="table" tableValues="${vals}"/></feComponentTransfer></filter>`);
    toneIds.set(key, id);
  }
  return `url(#${toneIds.get(key)})`;
}
const vigCache = new Map();
function vigMap(amt, W, H) { // RGB multiplier: 1 in the middle, 1 - amt in the corners (elliptical, smooth); preview and export PNG use the same map
  const key = `${amt}|${W}x${H}`;
  if (!vigCache.has(key)) {
    const m = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = clamp((Math.hypot((2 * x + 1) / W - 1, (2 * y + 1) / H - 1) / Math.SQRT2 - 0.3) / 0.75, 0, 1);
      m[y * W + x] = 1 - amt * u * u * (3 - 2 * u);
    }
    if (vigCache.size > 8) vigCache.delete(vigCache.keys().next().value);
    vigCache.set(key, m);
  }
  return vigCache.get(key);
}
async function vigPNG(c, m) { // export: the multiplier as a grey PNG at the cropped source aspect (blend multiply, alpha untouched)
  const cr = c.crop || {}, mw = m.w * (1 - (cr.l || 0) - (cr.r || 0)), mh = m.h * (1 - (cr.t || 0) - (cr.b || 0)), sc = Math.min(1, 1280 / Math.max(mw, mh));
  const W = Math.round(mw * sc), H = Math.round(mh * sc), cv = new OffscreenCanvas(W, H), x = cv.getContext('2d'), img = x.createImageData(W, H), mm = vigMap(c.adj.vig, W, H);
  for (let i = 0; i < mm.length; i++) { const g = Math.round(mm[i] * 255); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0);
  return blobURL(await cv.convertToBlob({ type: 'image/png' }));
}
const lookIds = new Map();
function lookFilter(m) { // canvas filter url() for a colour matrix, in sRGB like ffmpeg
  const key = m.map(v => v.toFixed(3)).join(' ');
  if (!lookIds.has(key)) {
    const id = `lk${lookIds.size}`, rows = [0, 1, 2].map(r => `${m[r * 3]} ${m[r * 3 + 1]} ${m[r * 3 + 2]} 0 0`).join(' ');
    $('#looks').insertAdjacentHTML('beforeend', `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${rows} 0 0 0 1 0"/></filter>`);
    lookIds.set(key, id);
  }
  return `url(#${lookIds.get(key)})`;
}

// ---------- history + save ----------
const selClip = () => S.sel && P[S.sel.lane === 'tr' ? 'main' : S.sel.lane]?.find(c => c.id === S.sel.id); // 'tr' = transition after a main clip
function setProp(c, key, v) { // with keyframes, an edit lands on the keyframe under the playhead (added if missing)
  if (!c.kf?.length) { c[key] = v; return; }
  const lt = snap(clamp(S.t - c.start, 0, len(c)));
  let f = c.kf.find(x => Math.abs(x.t - lt) < 0.5 / P.fps);
  if (!f) { f = { t: lt, ...propsAt(c, lt) }; c.kf.push(f); c.kf.sort((a, b) => a.t - b.t); }
  f[key] = v;
}
function change(fn) { undo.push(JSON.stringify(P)); if (undo.length > 200) undo.shift(); redo = []; const an = anchors(); fn(); reanchor(an, true); touched(); }
// Linkage (on unless the timeline's link button is off): a clip on another track stays over the same picture of the main
// track when that track is cut, trimmed or reordered. Each one is placed by the source time of the main clip under its start.
function anchors() {
  if (P.unlinked || !P.main.length) return [];
  packMain();
  const out = [];
  for (const L of LANES) if (L.key !== 'main') for (const x of P[L.key]) {
    const h = P.main.find(m => x.start >= m.start - 1e-6 && x.start < m.start + tdur(m, 'main') - 1e-6);
    if (h) out.push([x, x.start, h.id, h.media, h.in + (x.start - h.start) * h.speed, L.key]);
  }
  out.ids = new Set(P.main.map(m => m.id)); // the main clips before the edit: a part split off one is new, another copy of the file is not
  return out;
}
function reanchor(list, keepMoved) { // keepMoved: a clip the edit itself moved stays where it was put
  if (!list.length) return;
  packMain();
  const gone = new Set();
  for (const [x, s, hid, media, src, lane] of list) {
    if (keepMoved && Math.abs(x.start - s) > 1e-9) continue;
    const has = m => m.media === media && src >= m.in - 1e-6 && src < m.out - 1e-6; // that picture is still there (a split, a reorder)
    const at = m => m.start + (src - m.in) / m.speed;
    const h = P.main.find(m => m.id === hid && has(m)) || P.main.filter(m => !list.ids?.has(m.id) && has(m)).sort((a, b) => Math.abs(at(a) - s) - Math.abs(at(b) - s))[0];
    if (h) x.start = snap(Math.max(0, at(h)));
    else if (lane === 'captions' && keepMoved) gone.add(x); // the words it showed were cut out with their picture (an edit, not mid-drag)
    // else (that picture was cut out) it stays where it is
  }
  if (gone.size) P.captions = P.captions.filter(x => !gone.has(x));
}
function touched() { reduck(); S.dirty = true; audioStop(); scheduleSave(); renderAll(); }
const syncHistory = () => { $('#btnUndo').disabled = !undo.length; $('#btnRedo').disabled = !redo.length; }; // nothing to undo: the button says so
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(P));
  P = JSON.parse(from.pop());
  if (S.sel && !selClip()) S.sel = null;
  S.multi.clear();
  fitStage(); touched();
}
let saveFails = 0;
function scheduleSave(wait = 400) {
  $('#saveState').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, wait);
}
function flushSave(leaving) { if (saveTimer) return saveNow(leaving); } // now, not in 400 ms: a quit, reload or project switch right after an edit lost it
async function saveNow(leaving) {
  clearTimeout(saveTimer); saveTimer = 0;
  if (!P) return;
  if (S.hold) return scheduleSave();
  const p = P;
  try { await api(`/api/projects/${p.id}`, p, 'PUT', leaving); saveFails = 0; if (p === P && !saveTimer) $('#saveState').textContent = 'Saved'; }
  catch (e) { // tried again until it goes through (the server restarting, say): an edit is never just dropped
    if (p !== P) return;
    $('#saveState').textContent = 'Not saved';
    if (!saveFails++) toast(`Save failed: ${e.message}. Trying again…`);
    if (!saveTimer) scheduleSave([1000, 2000, 5000][Math.min(saveFails, 3) - 1]);
  }
}
addEventListener('pagehide', () => { flushSave(true); sendPoster(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushSave(true); sendPoster(true); } });

// ---------- rendering: chrome ----------
function renderAll() {
  renderTimeline(); renderInspector();
  $('#ratioLabel').textContent = `${P.w}×${P.h} · ${+P.fps.toFixed(3)} fps`;
  if (document.activeElement !== $('#projName')) $('#projName').value = P.name;
  $('#btnLink').classList.toggle('on', !P.unlinked);
  syncHistory();
}

function renderTimeline() {
  if (!P) return;
  const D = total(), pps = S.pps, sc = $('#tlScroll'), W = Math.max(sc.clientWidth, (D + 6) * pps);
  $('#tlInner').style.width = `${W}px`;
  const step = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s * pps >= 70) ?? 600;
  // only what's in view, plus a screen either side (re-rendered on scroll): 1200 clips took 119 ms a rebuild, so every edit lagged
  const vw = sc.clientWidth || 1500, wa = sc.scrollLeft - vw, wb = sc.scrollLeft + 2 * vw;
  S.tlWin = [wa, wb];
  const sel = new Set([...S.multi, S.sel && `${S.sel.lane}:${S.sel.id}`]);
  const near = (L, c) => sel.has(`${L}:${c.id}`) || ((c.start + tdur(c, L)) * pps >= wa && c.start * pps <= wb);
  let ruler = '';
  for (let i = Math.max(0, Math.floor(wa / (step * pps))); i * step * pps < Math.min(W, wb); i++) ruler += `<span style="left:${i * step * pps}px">${step < 1 ? (i * step).toFixed(1) : fmtDur(i * step)}</span>`;
  ruler += P.markers.map(t => `<b class="mk" style="left:${t * pps}px" title="Marker ${mss(t)}"></b>`).join('');
  // minor ticks: an SVG pattern over the drawn window only. A repeating-linear-gradient of 1 px stripes the whole ruler wide
  // was WebKit's most expensive paint (FillRectWithGradient took 88 % of the GPU process): frames of 0.6-1.5 s while zooming
  const mi = (step * pps) / 5, x0 = Math.max(0, wa), x1 = Math.min(W, wb);
  if (x1 > x0) ruler += `<svg class="ticks" style="left:${x0}px;width:${x1 - x0}px" aria-hidden="true"><pattern id="tk" patternUnits="userSpaceOnUse" width="${mi}" height="6" x="${-x0 % mi}"><rect width="1" height="6"/></pattern><rect width="100%" height="6" fill="url(#tk)"/></svg>`;
  $('#ruler').innerHTML = ruler;
  let heads = '';
  for (const L of LANES) {
    const multi = MULTI.includes(L.key), R0 = multi ? rows(L.key) : { row: new Map(), n: 1 }, R = { ...R0, n: R0.n + (S.dragLane === L.key ? 1 : 0) }, el = $(`#lane-${L.key}`); // dragging: an empty track to drop on
    const h = !P[L.key].length && S.dragLane !== L.key && L.key !== 'main' ? 24 : L.h; // an empty track stays a thin drop target: the room goes to the clips
    el.style.height = `${h * R.n}px`;
    const snd = L.key === 'main' || L.key === 'audio', lockSvg = '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
    for (let r = 0; r < R.n; r++) {
      const T = trk(L.key, r), off = multi ? !!T.off || !!P.mute[L.key] : !!P.mute[L.key], name = r ? `${L.label} ${r + 1}` : L.label;
      heads += `<div class="th${h < L.h ? ' thin' : ''}" style="height:${h}px"><span title="${name}">${name}</span><span class="tb"><button class="lt${off ? ' on' : ''}" data-${multi ? 'tk' : 'lt'}="${multi ? `${L.key}:${r}` : L.key}" title="${snd ? 'Mute' : 'Hide'} ${name}" aria-pressed="${off}">${snd ? 'M' : 'H'}</button>`
        + `<button class="lt lk${T.lock ? ' on' : ''}" data-lk="${L.key}:${r}" title="Lock ${name}" aria-label="Lock ${name}" aria-pressed="${!!T.lock}">${lockSvg}</button></span></div>`;
    }
    el.innerHTML = P[L.key].filter(c => near(L.key, c)).map(c => clipHTML(L.key, c, (R.row.get(c.id) || 0) * L.h, L.h)).join('') + (L.key === 'main' ? trHandles(wa, wb) : '');
    if (multi) for (const [k, v] of Object.entries(P.tracks || {})) if (k.startsWith(`${L.key}:`) && (v.off || v.lock)) { const r = +k.split(':')[1]; if (r < R.n) el.insertAdjacentHTML('beforeend', `<div class="tshade${v.off ? ' off' : ''}${v.lock ? ' lock' : ''}" style="top:${r * h}px;height:${h}px"></div>`); }
    else if (P.tracks?.[`${L.key}:0`]?.lock) el.insertAdjacentHTML('beforeend', `<div class="tshade lock" style="top:0;height:${h}px"></div>`);
  }
  $('#heads').innerHTML = heads;
  placePlayhead();
  drawStrips();
}
// The filmstrip and waveform of the part of each clip in view, at this zoom: frames at their own shape, each the one at
// its own time, and the sound's peaks per 10 ms shaded by the clip's volume and fades (stretched pictures went blocky)
const gridImgs = new Map(), peakData = new Map();
function gridImg(m) {
  let i = gridImgs.get(m.id);
  if (!i) { i = new Image(); i.onload = () => requestAnimationFrame(drawStrips); i.src = `/cache/${m.id}.grid.jpg`; gridImgs.set(m.id, i); }
  return i;
}
function peaksOf(m) {
  if (!peakData.has(m.id)) {
    peakData.set(m.id, null);
    fetch(`/cache/${m.id}.peaks`).then(r => (r.ok ? r.arrayBuffer() : null)).then(b => { if (b) { peakData.set(m.id, new Uint8Array(b)); requestAnimationFrame(drawStrips); } }).catch(() => {});
  }
  return peakData.get(m.id);
}
function drawStrips() {
  if (!P) return;
  const [wa, wb] = S.tlWin || [0, 0], pps = S.pps, dpr = devicePixelRatio || 1;
  for (const cv of document.querySelectorAll('#lanes canvas.cstrip')) {
    const el = cv.parentElement, lane = el.dataset.lane, c = P[lane]?.find(x => x.id === el.dataset.id), m = c && M.get(c.media);
    if (!m) continue;
    const left = c.start * pps, d = tdur(c, lane), x0 = Math.max(0, wa - left), x1 = Math.min(d * pps, wb - left), h = el.clientHeight;
    if (x1 <= x0 || !h) { cv.width = 0; continue; }
    const cw = Math.ceil(x1 - x0);
    cv.style.left = `${x0}px`; cv.style.width = `${cw}px`; cv.style.height = `${h}px`;
    if (cv.width !== Math.ceil(cw * dpr)) cv.width = Math.ceil(cw * dpr);
    if (cv.height !== Math.ceil(h * dpr)) cv.height = Math.ceil(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, h);
    const wave = m.peaks && (lane === 'audio' || lane === 'main'), vh = m.kind === 'video' && lane !== 'audio' ? (wave ? Math.round(h * 0.68) : h) : 0;
    if (vh && m.grid) {
      const G = m.grid, img = gridImg(m);
      if (img.complete && img.naturalWidth) {
        const dw = (vh * G.tw) / G.th;
        for (let i = Math.floor(x0 / dw); i * dw < x1; i++) {
          const k = clamp(Math.floor(((c.in + (((i + 0.5) * dw) / pps) * c.speed) / m.duration) * G.n), 0, G.n - 1);
          g.drawImage(img, (k % G.cols) * G.tw, Math.floor(k / G.cols) * G.th, G.tw, G.th, i * dw - x0, 0, dw, vh);
        }
      }
    }
    const pk = wave && peaksOf(m);
    if (pk) {
      const wh = h - vh, mid = vh + wh / 2;
      const path = new Path2D(); // one fill for all the columns (a fillRect each doubled the timeline's render time)
      for (let x = 0; x < cw; x++) {
        const lt = (x0 + x) / pps, s0 = c.in + lt * c.speed, b0 = Math.floor(s0 * 100), b1 = Math.max(b0 + 1, Math.ceil((s0 + c.speed / pps) * 100));
        let v = 0;
        for (let b = b0; b < b1 && b < pk.length; b++) if (pk[b] > v) v = pk[b];
        const a = (Math.sqrt(Math.min(1, (v / 255) * volAt(c, lt) * fadeAt(c, lt, d))) * wh) / 2;
        if (a > 0.25) path.rect(x, mid - a, 1, a * 2);
      }
      g.fillStyle = '#7ee0c3'; g.fill(path);
    }
  }
}
const MULTI = ['overlay', 'audio', 'text', 'fx']; // lanes with several tracks
function rows(lane) { // each clip on its track (c.track: dragged up or down); one that would overlap another there goes a track further. Later in the array = drawn on top
  const placed = [], row = new Map();
  for (const c of P[lane]) {
    const s = c.start, e = s + tdur(c, lane);
    let r = c.track || 0;
    while (placed.some(p => p.r === r && p.s < e - 1e-6 && s < p.e - 1e-6)) r++;
    placed.push({ r, s, e });
    row.set(c.id, r);
  }
  return { row, n: Math.max(1, ...placed.map(p => p.r + 1)) };
}
const trk = (lane, r = 0) => P.tracks?.[`${lane}:${r}`] || {};
function shown(lane) { // the lane's clips without those on hidden (muted) tracks: what the preview and the export play
  if (!Object.entries(P.tracks || {}).some(([k, v]) => v.off && k.startsWith(`${lane}:`))) return P[lane];
  const R = rows(lane).row;
  return P[lane].filter(c => !trk(lane, R.get(c.id) || 0).off);
}
function locked(lane, c) { // a locked track: its clips can't be selected, moved or changed from the timeline or the preview
  if (lane === 'tr') return false;
  if (!Object.entries(P.tracks || {}).some(([k, v]) => v.lock && k.startsWith(`${lane}:`))) return false;
  return !!trk(lane, MULTI.includes(lane) ? rows(lane).row.get(c.id) || 0 : 0).lock;
}
function restackTracks(lane) { // the array follows the tracks, so a higher track draws on top (stable within a track)
  const R = rows(lane).row, idx = new Map(P[lane].map((c, i) => [c, i]));
  P[lane].sort((a, b) => (R.get(a.id) || 0) - (R.get(b.id) || 0) || idx.get(a) - idx.get(b));
}
function trHandles(wa = -Infinity, wb = Infinity) {
  return P.main.slice(0, -1).map((c, i) => P.main[i + 1].start * S.pps < wa || P.main[i + 1].start * S.pps > wb ? '' : `<button class="trh${c.tr ? ' on' : ''}${S.sel?.lane === 'tr' && S.sel.id === c.id ? ' sel' : ''}" data-tr-for="${c.id}" style="left:${(P.main[i + 1].start + trF(i) / P.fps / 2) * S.pps}px" title="Transition" aria-label="Transition"></button>`).join('');
}

function clipHTML(lane, c, top = 0, h = 42) {
  const pps = S.pps, m = M.get(c.media), layers = []; // [image, size, position, repeat]
  let label = c.fx ? FX[c.fx]?.n || c.fx : c.media ? 'Missing media' : c.text;
  if (m) {
    label = m.name + (c.speed !== 1 ? ` · ${c.speed}×` : '');
    const full = (m.duration / c.speed) * pps, off = (-c.in / c.speed) * pps, wave = m.wave && (lane === 'audio' || lane === 'main');
    if (m.kind === 'video' && m.stripN && !m.grid && lane !== 'audio') layers.push([`url(/cache/${m.id}.strip.jpg)`, `${full}px ${wave ? '68%' : '100%'}`, `${off}px 0`, 'no-repeat']); // (older items until their grid is made)
    if (m.kind === 'image') layers.push([`url(/media/${m.id}?thumb=1)`, 'auto 100%', '0 0', 'repeat-x']); // a 320 px copy: full-size photos cost WebKit ~12 MB each
    if (wave && !m.peaks) layers.push([`url(/cache/${m.id}.wave.png)`, `${full}px ${lane === 'main' ? '32%' : '100%'}`, `${off}px 100%`, 'no-repeat']);
  }
  const bg = layers.length ? `background-image:${layers.map(l => l[0])};background-size:${layers.map(l => l[1])};background-position:${layers.map(l => l[2])};background-repeat:${layers.map(l => l[3])};` : '';
  const env = c.vkf?.length ? (() => { // the volume points as a line over the clip (0 dB in the middle, -40 dB at the bottom)
    const w = Math.max(3, tdur(c, lane) * pps), y = v => (1 - clamp((dB(v) + 40) / 52, 0, 1)) * 100, pts = c.vkf.map(f => `${clamp(f.t * pps, 0, w)},${y(f.v)}`);
    return `<svg class="env" viewBox="0 0 ${w} 100" preserveAspectRatio="none"><polyline points="0,${y(c.vkf[0].v)} ${pts.join(' ')} ${w},${y(c.vkf.at(-1).v)}"/>${c.vkf.map(f => `<circle cx="${clamp(f.t * pps, 0, w)}" cy="${y(f.v)}" r="2.5"/>`).join('')}</svg>`;
  })() : '';
  const fades = m ? (() => { // fade ramps shaded over the clip, plus round knobs on its top corners to drag them
    const w = Math.max(3, tdur(c, lane) * pps), a = (c.fadeIn || 0) * pps, b = (c.fadeOut || 0) * pps;
    return (a || b ? `<svg class="fade" viewBox="0 0 ${w} 100" preserveAspectRatio="none">${a ? `<path d="M0,0H${a}L0,100Z"/>` : ''}${b ? `<path d="M${w},0H${w - b}L${w},100Z"/>` : ''}</svg>` : '')
      + `<i class="fh l" style="left:${clamp(a - 5, 0, w - 10)}px" title="Drag to fade in"></i><i class="fh r" style="right:${clamp(b - 5, 0, w - 10)}px" title="Drag to fade out"></i>`;
  })() : '';
  const marks = env + fades + (c.kf || []).map((f, i) => `<b class="kfm" data-k="${i}" style="left:${f.t * pps}px" title="Keyframe: click to go to it, drag to move it"></b>`).join('')
    + (c.beats || []).filter(b => b >= c.in && b <= c.out).map(b => `<b class="bm" style="left:${((b - c.in) / c.speed) * pps}px"></b>`).join('');
  return `<div class="clip ${lane}${isSel(lane, c.id) ? ' sel' : ''}${c.media && !m ? ' missing' : ''}" data-lane="${lane}" data-id="${c.id}" style="left:${c.start * pps}px;width:${Math.max(3, tdur(c, lane) * pps)}px;top:${top + 3}px;height:${h - 6}px;${bg}">${m && ((m.grid && m.kind === 'video' && lane !== 'audio') || (m.peaks && (lane === 'audio' || lane === 'main'))) ? '<canvas class="cstrip"></canvas>' : ''}<span class="lbl">${esc(label)}</span>${marks}<i class="h l"></i><i class="h r"></i></div>`;
}

function placePlayhead() { $('#playhead').style.transform = `translateX(${S.t * S.pps}px)`; }
function seekTo(t) { // paused seek used by arrows, Home/End and the transport buttons
  if (S.playing) pause();
  closeSource();
  S.t = snap(clamp(t, 0, total()));
  placePlayhead(); follow(); S.dirty = true;
  if (S.sel) renderInspector(); // keyframed values at the new time
}
function shuttle(dir) { // L: play, then 2x, 4x; J: backwards at 1x, 2x, 4x (paused seeks, 20 a second); K: stop
  if (dir > 0) {
    if (S.back) return shuttleBack(0);
    if (!S.playing) return play();
    S.rate = Math.min(4, S.rate * 2); S.t0 = S.t; S.wall0 = performance.now(); // re-anchored at the new speed
  } else shuttleBack(S.back ? Math.min(4, S.back * 2) : 1);
}
function shuttleBack(r) {
  clearInterval(S.backT); S.back = r;
  if (!r) return;
  if (S.playing) pause();
  S.back = r; S.backT = setInterval(() => { if (S.t <= 0) return shuttleBack(0); S.t = snap(Math.max(0, S.t - 0.05 * S.back)); placePlayhead(); follow(); S.dirty = true; }, 50);
}
function editPoints() { // every clip edge on every track, the markers, the start and the end
  packMain();
  const s = new Set([0, total(), ...P.markers]);
  for (const L of LANES) for (const c of P[L.key]) { s.add(c.start); s.add(c.start + tdur(c, L.key)); }
  return [...s].map(snap).sort((a, b) => a - b);
}
function nudge(d) { // ⌥← / ⌥→: the selected clips one frame (main clips are packed: they move by reordering)
  const sel = selection().filter(([, lane]) => lane !== 'main' && lane !== 'tr');
  if (sel.length) change(() => { for (const [c] of sel) c.start = snap(Math.max(0, c.start + d / P.fps)); });
}
const KEYS = [['Space', 'Play / pause'], ['J  K  L', 'Backwards · stop · forwards (press again: 2x, 4x)'], ['← →', 'One frame (⇧: one second)'], ['↑ ↓', 'Previous / next cut or marker'],
  ['Home  End', 'Start / end'], ['S  or  ⌘B', 'Split at the playhead'], ['Q  W', 'Trim the clip\'s start / end to the playhead'], ['M', 'Marker'], ['I  O', 'Source viewer (click a video in the library): mark in / out'], ['⌥← ⌥→', 'Nudge the selected clips one frame'],
  ['⌘=  ⌘−', 'Zoom the timeline in / out'], ['⇧Z', 'Fit the timeline'], ['⌘C ⌘X ⌘V', 'Copy · cut · paste (⌥⌘V: paste the look)'], ['⌘D', 'Duplicate'], ['⌘A', 'Select all'],
  ['⌘Z  ⇧⌘Z', 'Undo / redo'], ['⌫', 'Delete'], ['F', 'Big preview'], ['1 – 6', 'Multicam: cut to that angle'], ['⇧A', 'Sound while scrubbing on / off'], ['Esc', 'Deselect / cancel'], ['?', 'These shortcuts']];
function shortcuts() { modal(`<h3>Keyboard shortcuts</h3><table class="keys">${KEYS.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table><div class="actions"><button data-close>Close</button></div>`); }
function follow() { const sc = $('#tlScroll'), x = S.t * S.pps; if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = x - 60; }

function thumbStyle(m) {
  if (m.kind === 'image') return `background-image:url(/media/${m.id}?thumb=1)`;
  if (m.stripN) return `background-image:url(/cache/${m.id}.strip.jpg);background-size:auto 100%;background-position:0 0;background-repeat:repeat-x`; // frames at their own shape (portrait ones side by side)
  if (m.wave) return `background-image:url(/cache/${m.id}.wave.png);background-size:100% 100%`;
  return '';
}
function renderMediaList() {
  const up = uploads.map(u => `<div class="mitem up"><div class="thumb"></div><div class="meta"><b>${esc(u.name)}</b><span>Uploading ${Math.round(u.pct * 100)}%</span></div></div>`).join('');
  const q = $('#mediaSearch')?.value.trim().toLowerCase(), used = G.mfilter === 'proj' && P ? new Set(LANES.flatMap(L => P[L.key].map(c => c.media))) : null; // null, not false: false?.has is undefined, and calling it threw
  const by = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), dur: (a, b) => (b.duration || 0) - (a.duration || 0) }[$('#mediaSort')?.value]; // 'new': the server's order
  const list = [...M.values()].filter(m => (G.mfilter === 'all' || m.kind === G.mfilter || used?.has(m.id)) && (!q || m.name.toLowerCase().includes(q)));
  if (by) list.sort(by);
  const items = list.map(m => { const r = srcRange(m.id); return `<div class="mitem${S.src?.id === m.id ? ' src' : ''}" draggable="true" data-media="${m.id}" title="${m.kind === 'video' ? 'Hover to skim · click to mark a range · drag onto a track' : 'Drag onto a track'}">
      <div class="thumb" style="${thumbStyle(m)}"><span>${m.kind}</span>${r ? `<i class="srng" style="left:${(r[0] / m.duration) * 100}%;width:${((r[1] - r[0]) / m.duration) * 100}%"></i>` : ''}</div>
      <div class="meta"><b>${esc(m.name)}</b><span>${m.kind === 'image' ? `${m.w}×${m.h}` : fmtDur(m.duration)}${m.ready ? '' : m.prep === -1 ? ' · waiting to prepare' : m.prep > 0 ? ` · preparing ${Math.round(m.prep * 100)} %` : ' · preparing'}</span></div>
      <span class="mbtns"><button class="add" data-add="${m.id}" title="Add to timeline" aria-label="Add ${esc(m.name)} to timeline">+</button><button class="add rm" data-rm="${m.id}" title="Remove from library" aria-label="Remove ${esc(m.name)} from library">×</button></span></div>`; }).join('');
  $('#mediaList').innerHTML = up + items || '<p class="hint">Nothing imported yet.</p>';
  if (!up && !items && M.size) $('#mediaList .hint').textContent = 'Nothing matches.';
  const sc = $('#scList'), picked = new Set([...(sc?.querySelectorAll('input:checked') || [])].map(x => x.value)), mu = $('#scMusic'), mkeep = mu?.value;
  if (sc) sc.innerHTML = [...M.values()].filter(x => x.kind === 'video').map(x => `<label class="row chk"><span title="${esc(x.name)}">${esc(x.name)}</span><small>${fmtDur(x.duration)}</small><input type="checkbox" value="${x.id}"${picked.has(x.id) ? ' checked' : ''}></label>`).join('') || '<p class="hint">Import some videos first.</p>';
  if (mu) { mu.innerHTML = '<option value="">No music</option>' + (G.ai?.music ? '<option value="ai">AI music, made to fit</option>' : '') + [...M.values()].filter(x => x.kind === 'audio').map(x => `<option value="${x.id}" title="${esc(x.name)}">${esc(short(x.name))}</option>`).join(''); if (mkeep) mu.value = mkeep; }
  const hl = $('#hlSrc'), keep = hl?.value; // Shorts source: videos with sound
  if (hl) { hl.innerHTML = [...M.values()].filter(x => x.kind === 'video' && x.hasAudio).map(x => `<option value="${x.id}" title="${esc(x.name)}">${esc(short(x.name, 22))} · ${fmtDur(x.duration)}</option>`).join('') || '<option value="">Import a video with speech</option>'; if (keep) hl.value = keep; }
}

// ---------- source viewer: a library video on its own in the preview. Hovering its card skims it, a click opens it to
// mark a range (I, O) that + or a drag adds. The timeline is untouched until then.
function srcRange(id) { // the marked [in, out] of library item id, or null
  const s = S.src, m = M.get(id);
  if (!s || s.id !== id || !m || (s.i == null && s.o == null)) return null;
  const a = s.i ?? 0, b = s.o ?? m.duration;
  return b - a >= 0.05 ? [a, b] : null;
}
function openSource(id, t) {
  const m = M.get(id);
  if (m?.kind !== 'video') return;
  if (S.playing) pause();
  if (S.src?.id !== id) S.src = { id, t: 0, i: null, o: null };
  const r = $('#srcPos');
  r.max = m.duration; r.step = 'any';
  $('#srcName').textContent = m.name; $('#srcBar').hidden = false;
  srcSeek(t); srcInfo(); renderMediaList();
}
function closeSource() { if (!S.src) return; S.src = null; $('#srcBar').hidden = true; S.dirty = true; renderMediaList(); }
function srcSeek(t) { const s = S.src, r = $('#srcPos'); s.t = clamp(t, 0, M.get(s.id)?.duration || 0); r.value = s.t; fill(r); S.dirty = true; }
function srcMark(k) { // I / O: at the skimmed frame while the pointer is on the card, else where the viewer is
  const s = S.src;
  if (S.skim?.id === s.id) srcSeek(S.skim.t);
  s[k] = +s.t.toFixed(3);
  if (s.i != null && s.o != null && s.o <= s.i) s[k === 'i' ? 'o' : 'i'] = null; // an in after the out starts a new range
  srcInfo(); renderMediaList();
}
function srcInfo() { const r = srcRange(S.src.id); $('#srcRange').textContent = r ? `In ${tc(r[0])} · Out ${tc(r[1])} · ${(r[1] - r[0]).toFixed(2)} s` : 'I and O mark a range · ← → step'; }
function paintSource(V) { // the viewer's frame, fitted to the canvas (the pooled 'src' element: the timeline's own stay loaded)
  const m = M.get(V.id), cv = $('#cv'), ctx = cv.getContext('2d');
  if (!m) { S.skim = null; closeSource(); return; }
  const el = vidFor('src', m);
  sync(el, V.t, 1);
  S.live = new Set([el]); S.pics = []; hits = [];
  for (const v of pool.values()) if (v !== el && !v.paused) v.pause();
  $('#tc').textContent = `${tc(V.t)} / ${tc(m.duration)}`;
  if (el.readyState < 2) return; // the last frame stays up until 'loadeddata' / 'seeked' repaint
  const w = el.videoWidth, h = el.videoHeight, s = Math.min(cv.width / w, cv.height / h);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(el, (cv.width - w * s) / 2, (cv.height - h * s) / 2, w * s, h * s);
}
function skimAt(e) { // pointer over a video card: its frame from the 1-per-second grid at once, the real frame in the preview after 100 ms at rest
  const it = e.target.closest('.mitem[data-media]'), m = it && M.get(it.dataset.media);
  if (G.skimId && G.skimId !== m?.id) skimEnd();
  if (m?.kind !== 'video' || !m.grid) return;
  const r = it.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1), t = f * m.duration, th = it.querySelector('.thumb');
  let cv = th.querySelector('.skim');
  if (!cv) { cv = document.createElement('canvas'); cv.className = 'skim'; th.append(cv); }
  G.skimId = m.id;
  const dpr = devicePixelRatio || 1, w = th.clientWidth, h = th.clientHeight, img = gridImg(m), Gd = m.grid, g = cv.getContext('2d');
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (img.complete && img.naturalWidth) {
    const k = clamp(Math.floor((t / m.duration) * Gd.n), 0, Gd.n - 1), s = Math.max(w / Gd.tw, h / Gd.th);
    g.drawImage(img, (k % Gd.cols) * Gd.tw, Math.floor(k / Gd.cols) * Gd.th, Gd.tw, Gd.th, (w - Gd.tw * s) / 2, (h - Gd.th * s) / 2, Gd.tw * s, Gd.th * s);
  }
  g.fillStyle = '#fff'; g.fillRect(Math.round(f * w) - 1, 0, 2, h); // where the pointer is in the file
  clearTimeout(G.skimT);
  G.skimT = setTimeout(() => { if (G.skimId === m.id && !S.playing) { S.skim = { id: m.id, t }; S.dirty = true; } }, 100);
}
function skimEnd() {
  clearTimeout(G.skimT);
  $(`#mediaList .mitem[data-media="${G.skimId}"] .skim`)?.remove();
  G.skimId = null;
  if (S.skim) { S.skim = null; S.dirty = true; }
}
function replaceClip(c, id) { // the clip plays another library item: same place and length, its effects, keyframes and settings kept
  const m = M.get(id);
  if (!m) throw new Error(`no media ${id} in the library`);
  const span = c.out - c.in;
  change(() => {
    c.media = id;
    if (m.kind === 'image') { c.in = 0; c.out = span; }
    else { c.in = clamp(c.in, 0, Math.max(0, m.duration - span)); c.out = Math.min(c.in + span, m.duration); }
  });
  if (c.out - c.in < span - 1e-3) toast(`${m.name} is shorter, so the clip is too`);
}
function replaceMenu(c, lane) {
  const snd = lane === 'audio', list = [...M.values()].filter(m => m.id !== c.media && m.ready && (snd ? m.kind === 'audio' || (m.kind === 'video' && m.hasAudio) : m.kind !== 'audio'));
  modal(`<h3>Replace clip</h3><p class="hint">It plays in the same place for the same time, keeping this clip's effects, keyframes and settings.</p>
    <input id="repQ" type="search" placeholder="Search the library" aria-label="Search the library">
    <div class="media-list rep">${list.map(m => `<button class="mitem" data-rep="${m.id}" title="${esc(m.name)}"><div class="thumb" style="${thumbStyle(m)}"><span>${m.kind}</span></div><div class="meta"><b>${esc(m.name)}</b><span>${m.kind === 'image' ? `${m.w}×${m.h}` : fmtDur(m.duration)}</span></div></button>`).join('') || '<p class="hint">Nothing in the library fits this track.</p>'}</div>
    <div class="actions"><button data-close>Cancel</button></div>`);
  const d = $('#modal .dialog');
  d.querySelector('.rep').addEventListener('click', e => { const b = e.target.closest('[data-rep]'); if (b) { closeModal(); replaceClip(c, b.dataset.rep); } });
  $('#repQ').addEventListener('input', e => { const q = e.target.value.trim().toLowerCase(); for (const b of d.querySelectorAll('[data-rep]')) b.hidden = !!q && !M.get(b.dataset.rep).name.toLowerCase().includes(q); });
}

const short = (n, max = 26) => { // a long file name for a dropdown: start … end, extension kept (a select can't draw an ellipsis in WebKit)
  if (n.length <= max) return n;
  const dot = n.lastIndexOf('.'), ext = dot > 0 && n.length - dot <= 5 ? n.slice(dot) : '', stem = n.slice(0, n.length - ext.length), keep = max - ext.length - 1;
  return `${stem.slice(0, Math.ceil(keep * 0.7))}…${stem.slice(stem.length - Math.floor(keep * 0.3))}${ext}`;
};

// ---------- inspector ----------
const fmt = (v, unit) => (unit === '%' ? `${Math.round(v * 100)}%` : unit === 's' ? `${(+v).toFixed(2)}s` : unit === '°' ? `${Math.round(v)}°`
  : unit === 'x' ? `${(10 ** v).toFixed(2)}×` : unit === 'st' ? (+v ? `${v > 0 ? '+' : ''}${+v} st` : '0') : unit === 'pan' ? (Math.abs(v) < 0.01 ? 'Centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'L' : 'R'}`) : unit === 'dB' ? (v <= -60 ? 'Muted' : `${v > 0 ? '+' : ''}${(+v).toFixed(1)} dB`) : `${Math.round(v * 10) / 10}`);
const fill = el => el.style.setProperty('--p', `${(el.value - el.min) / (el.max - el.min) * 100}%`); // slider track fill
const slider = (k, label, v, min, max, step, unit = '', extra = '') => `<label class="row"><span>${label}</span><input type="range" data-k="${k}" data-unit="${unit}"${extra} min="${min}" max="${max}" step="${step}" value="${v}" style="--p:${clamp((v - min) / (max - min), 0, 1) * 100}%"><output title="Click to type a value">${fmt(v, unit)}</output></label>`;
const pick = (k, label, v, opts) => `<label class="row"><span>${label}</span><select data-k="${k}"${typeof opts[0][0] === 'number' ? ' data-num' : ''}>${opts.map(([val, txt]) => `<option value="${val}"${String(val) === String(v) ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select></label>`;
const colour = (k, label, v) => `<label class="row"><span>${label}</span><input type="color" data-k="${k}" value="${v}"></label>`;
const tick = (k, label, v) => `<label class="row chk"><span>${label}</span><input type="checkbox" data-k="${k}"${v ? ' checked' : ''}></label>`;
const segs = (attr, label, v, opts) => `<div class="row"><span>${label}</span><div class="seg">${opts.map(([val, txt]) => `<button data-${attr}="${val}" class="${val === v ? 'on' : ''}">${txt}</button>`).join('')}</div></div>`;

function renderInspector() {
  const c = selClip();
  pending = null;
  $('#inspector').innerHTML = !c ? projectPanel() : S.sel.lane === 'tr' ? trPanel(c) : S.sel.lane === 'fx' ? fxPanel(c) : c.media ? mediaPanel(c, S.sel.lane) : textPanel(c, S.sel.lane);
  if (c?.media && $('#curveSvg')) { drawWheels(c); drawCurve(c); }
  syncToolbar();
  if (G.tab === 'transitions' || G.tab === 'filters') renderPane(); // they act on the selection
  else if (G.tab === 'script' && !SC.busy) renderScript(false); // the words follow edits of the main track
  else if (G.tab === 'captions' && !document.activeElement?.matches('#capList input')) renderCapList();
  if (selection().length > 1) $('#inspector').insertAdjacentHTML('afterbegin', `<p class="multi">${selection().length} clips selected · ⌫ deletes them, ⌘C copies, drag moves them together</p><div class="actions"><button data-act="compound">Make compound clip</button></div>`);
}
function trPanel(c) {
  const i = P.main.indexOf(c), next = P.main[i + 1], cur = c.tr?.type || 'none';
  return `<h3>Transition</h3><p class="muted">${esc(M.get(c.media)?.name || 'clip')} → ${esc(M.get(next?.media)?.name || 'clip')}</p>
    <div class="presets small">${TRANSITIONS.map(([v, n]) => `<button data-tr="${v}" class="${cur === v ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${c.tr ? `${slider('c.tr.d', 'Duration', c.tr.d, 0.1, 2, 0.05, 's')}<p class="hint">Using ${(trF(i) / P.fps).toFixed(2)} s here (at most half the shorter clip). The clips overlap, so the video gets that much shorter.</p>` : ''}
    <div class="actions"><button data-act="trall">Apply to all cuts</button>${c.tr ? '<button data-act="delete">Remove</button>' : ''}</div>`;
}
function kfRow(c, lane) {
  const lt = S.t - c.start, on = c.kf?.find(f => Math.abs(f.t - lt) < 0.5 / P.fps), inside = lt >= 0 && lt <= tdur(c, lane);
  const eased = on && (on.ease ?? c.ease);
  return `<h4>Keyframes</h4><div class="actions">${c.kf?.length ? '<button data-act="kfprev" title="Previous keyframe" aria-label="Previous keyframe">‹</button><button data-act="kfnext" title="Next keyframe" aria-label="Next keyframe">›</button>' : ''}${on ? `<button data-act="kfdel">Remove keyframe</button><button data-act="kfease">${eased ? 'Linear from here' : 'Ease from here'}</button>` : `<button data-act="kfadd"${inside ? '' : ' disabled'}>Add keyframe at playhead</button>`}${c.kf?.length ? `<button data-act="kfclear">Clear ${c.kf.length}</button>` : ''}</div>${c.kf?.length ? tick('c.ease', 'Ease all segments', c.ease) : ''}
    <p class="hint">${c.kf?.length ? 'Scale, position and opacity animate between the diamonds. Changing them at the playhead edits or adds a keyframe there.' : 'Add a keyframe, move the playhead, then change scale or position: zoom, pan, punch-in.'}</p>`;
}
const RATIO_NAMES = { '9:16': 'TikTok', '16:9': 'YouTube', '1:1': 'Square', '4:5': 'Instagram', '3:4': 'Portrait', '4:3': 'Classic', '21:9': 'Cinema' };
function projectPanel() {
  const ratio = Object.keys(RATIOS).find(r => RATIOS[r][0] === P.w && RATIOS[r][1] === P.h), n = LANES.reduce((s, L) => s + P[L.key].length, 0);
  const tile = r => { const [w, h] = RATIOS[r], q = 24 / Math.max(w, h); return `<button data-ratio="${r}" class="${r === ratio ? 'on' : ''}" title="${r} · ${RATIO_NAMES[r]}"><span class="ri"><i style="width:${Math.round(w * q)}px;height:${Math.round(h * q)}px"></i></span><b>${r}</b><span>${RATIO_NAMES[r]}</span></button>`; };
  return `<h3>Project</h3>
    <div class="pinfo"><div><b>${fmtDur(total())}</b><span>Length</span></div><div><b>${P.w}×${P.h}</b><span>Size</span></div><div><b>${n}</b><span>Clips</span></div></div>
    <h4>Canvas</h4><div class="ratios">${Object.keys(RATIOS).map(tile).join('')}</div>
    <h4>Frame rate</h4><div class="seg full">${[24, 25, 30, 50, 60].map(f => `<button data-fps="${f}" class="${f === P.fps ? 'on' : ''}">${f} fps</button>`).join('')}</div>
    ${colour('p.bg', 'Background', P.bg)}
    <h4>Shortcuts</h4><p class="hint" title="⇧←/→ one second · Home/End · ⇧⌘Z redo · ⌘+scroll zooms the timeline">Space play · S split · ⌫ delete · ⌘D duplicate · ←/→ frame · M marker · ⌘Z undo</p>`;
}
function tabbed(sections) { // inspector tabs; empty tabs are hidden and the open tab survives re-renders
  const live = sections.filter(x => x[1]), cur = live.some(x => x[0] === S.itab) ? S.itab : live[0][0];
  return `<div class="itabs">${live.map(([n]) => `<button data-itab="${n}" class="${n === cur ? 'on' : ''}">${n}</button>`).join('')}</div>`
    + live.map(([n, h]) => `<div class="isec${n === cur ? ' on' : ''}" data-sec="${n}">${h}</div>`).join('');
}
const dB = v => (v > 0 ? Math.max(-60, 20 * Math.log10(v)) : -60);
const VOICES = [['none', 'None'], ['chipmunk', 'Chipmunk'], ['deep', 'Deep'], ['robot', 'Robot'], ['echo', 'Echo'], ['hall', 'Hall'], ['telephone', 'Telephone']];
const voiceOf = a => (a.voice !== 'none' ? a.voice : a.semi === 6 ? 'chipmunk' : a.semi === -5 ? 'deep' : 'none'); // chipmunk / deep are pitch presets
function setVoice(c, k) {
  change(() => {
    const a = { ...AU0, ...c.au };
    if (k === 'chipmunk' || k === 'deep') Object.assign(a, { voice: 'none', semi: k === 'chipmunk' ? 6 : -5 });
    else if (k === 'none') Object.assign(a, { voice: 'none', semi: 0 });
    else a.voice = k;
    c.au = a;
  });
  renderInspector();
}
function volPoint(c, db) { // set the envelope at the playhead (a new point, or the one already there)
  const lt = clamp(S.t - c.start, 0, len(c)), v = db <= -40 ? 0 : +(10 ** (db / 20)).toFixed(4), near = f => Math.abs(f.t - lt) < 0.5 / P.fps;
  const k = (c.vkf || []).filter(f => !near(f));
  delete c.duck; // a point set by hand: the auto-duck points become this clip's own
  c.vkf = [...k, { t: +lt.toFixed(4), v }].sort((a, b) => a.t - b.t);
}
function editOutput(out) { // click a slider's value to type an exact one (in the units shown)
  const r = out.parentElement.querySelector('input[type=range]');
  if (!r) return;
  const box = document.createElement('input');
  let done = false;
  box.className = 'numedit';
  box.value = out.textContent.replace('−', '-').replace(/[^\d.+-]/g, '');
  out.replaceWith(box); box.focus(); box.select();
  const finish = ok => {
    if (done) return;
    done = true;
    let v = parseFloat(box.value);
    if (ok && Number.isFinite(v)) {
      const u = r.dataset.unit;
      if (u === '%') v /= 100; else if (u === 'x') v = Math.log10(clamp(v, 0.1, 100));
      r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (box.isConnected) box.replaceWith(out);
    out.textContent = fmt(+r.value, r.dataset.unit);
  };
  box.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  box.addEventListener('blur', () => finish(true));
}
function restack(c, dir) { // bring forward / send backward past the next overlay clip it actually overlaps
  const a = P.overlay, hits2 = x => x !== c && x.start < c.start + len(c) && c.start < x.start + len(x), i = a.indexOf(c);
  const t = (dir > 0 ? a.slice(i + 1) : a.slice(0, i).reverse()).find(hits2);
  if (!t) return toast(dir > 0 ? 'Already in front of the clips it overlaps' : 'Already behind the clips it overlaps');
  change(() => { a.splice(a.indexOf(c), 1); a.splice(a.indexOf(t) + (dir > 0 ? 1 : 0), 0, c); });
}
function mediaPanel(c, lane) {
  const m = M.get(c.media);
  if (!m) { // its file left the library: put it back from the trash, point it at another file, or at something in the library
    const n = LANES.reduce((k, L) => k + P[L.key].filter(x => x.media === c.media).length, 0), lib = [...M.values()].filter(x => x.kind !== 'audio' || lane === 'audio');
    return `<h3>Missing media</h3><p class="muted">The file for ${n > 1 ? `these ${n} clips` : 'this clip'} isn't in the library any more. Relinking fixes every clip that used it.</p>
      <div class="actions"><button data-act="restore" class="primary">Restore from trash</button><label class="btn"><input type="file" data-relink hidden accept="video/*,audio/*,image/*,.heic,.mkv,.gif">Relink to a file…</label></div>
      ${lib.length ? `<div class="row"><span>Or use</span><select id="relinkSel">${lib.map(x => `<option value="${x.id}">${esc(short(x.name))}</option>`).join('')}</select></div><div class="actions"><button data-act="relinklib">Use it</button><button data-act="delete">Delete</button></div>` : '<div class="actions"><button data-act="delete">Delete</button></div>'}<p id="clipStatus" class="muted"></p>`;
  }
  const d = tdur(c, lane), pr = propsAt(c, S.t - c.start), cr = c.crop || {}, vis = m.kind !== 'audio', vid = m.kind === 'video', mk = maskAt(c, clamp(S.t - c.start, 0, d)), A = c.anim || {}, a = c.adj || {};
  const head = `<h3>${esc(m.name)}</h3><p class="muted">${lane} track · ${mss(d)}${m.kind === 'image' ? '' : ` of ${mss(m.duration)}`}${m.hdr ? ' · HDR, tone-mapped on export' : ''}${m.alpha || m.trans ? ' · transparent' : ''}</p>`;
  const fmax = Math.max(0.05, Math.min(3, d), c.fadeIn || 0, c.fadeOut || 0), amax = Math.max(0.2, Math.min(3, d));
  let basic = m.kind !== 'image' ? slider('c.speed', 'Speed', Math.log10(c.speed), -1, 2, 0.005, 'x', ' data-log') + (m.hasAudio ? tick('c.pitch', 'Change pitch with speed', c.pitch) : '') : '';
  if (vid) basic += slider('c.mb', 'Motion blur', c.mb || 0, 0, 1, 0.01, '%', ' title="Each frame mixed with the ones before it: streaks on fast pans and speed-ups"');
  if (c.mc) basic = `<h4>Multicam</h4><div class="seg wrap mcangles">${c.mc.angles.map((A, i) => `<button data-mcangle="${i}" class="${i === c.mc.a ? 'on' : ''}" title="${esc(M.get(A.media)?.name || '')}">${i + 1} · ${esc(short(M.get(A.media)?.name || 'missing', 14))}</button>`).join('')}</div><p class="hint">Press 1–${c.mc.angles.length} while it plays to cut to that angle at that moment (the sound stays on one track).</p>` + basic;
  if (vis) {
    basic += segs('fit', 'Fit', c.fit, [['fit', 'Fit'], ['fill', 'Fill'], ...(lane === 'main' ? [['blur', 'Blur bg']] : [])]);
    basic += `<h4>Transform</h4>${slider('c.scale', 'Scale', pr.scale, 0.1, 4, 0.01, '%')}${slider('c.x', 'Position X', pr.x, -1, 1, 0.005, '%')}${slider('c.y', 'Position Y', pr.y, -1, 1, 0.005, '%')}`
      + slider('c.rot', 'Rotate', pr.rot, -180, 180, 1, '°') + slider('c.opacity', 'Opacity', pr.opacity, 0, 1, 0.01, '%')
      + (lane === 'overlay' ? pick('c.blend', 'Blend', c.blend || 'normal', BLENDS) : '') + kfRow(c, lane);
  }
  basic += `<h4>Fade</h4>${slider('c.fadeIn', 'Fade in', c.fadeIn, 0, fmax, 0.05, 's')}${slider('c.fadeOut', 'Fade out', c.fadeOut, 0, fmax, 0.05, 's')}`
    + (vis ? `<p class="hint">${lane === 'main' ? 'Main-track fades go through black.' : 'Overlay fades turn see-through.'}</p>` : '');
  const animate = vis ? `<h4>In</h4>${pick('c.anim.in', 'Animation', A.in || 'none', CLIP_ANIMS)}${A.in && A.in !== 'none' ? slider('c.anim.ind', 'Duration', A.ind ?? 0.5, 0.1, amax, 0.05, 's') : ''}`
    + `<h4>Out</h4>${pick('c.anim.out', 'Animation', A.out || 'none', CLIP_ANIMS)}${A.out && A.out !== 'none' ? slider('c.anim.outd', 'Duration', A.outd ?? 0.5, 0.1, amax, 0.05, 's') : ''}`
    + `<h4>Combo</h4>${pick('c.anim.loop', 'Motion', A.loop || 'none', LOOP_ANIMS)}${A.loop && A.loop !== 'none' ? slider('c.anim.amt', 'Strength', A.amt ?? 1, 0.1, 3, 0.05, '%') : ''}`
    + '<p class="hint">Plays on top of keyframes, the same in the preview and the export. Splitting keeps In on the first part and Out on the last.</p>' : '';
  let look = '';
  if (vis) {
    look += `<h4>Filter</h4><div class="presets small">${['none', ...Object.keys(LOOKS)].map(n => `<button data-look="${n}" class="${(c.look?.name || 'none') === n ? 'on' : ''}">${n[0].toUpperCase() + n.slice(1)}</button>`).join('')}</div>${c.look ? slider('c.look.amount', 'Strength', c.look.amount ?? 1, 0, 1, 0.01, '%') : ''}`;
    const others = [...P.main, ...P.overlay].filter(x => x !== c && M.get(x.media) && M.get(x.media).kind !== 'audio');
    look += `<h4>Adjust</h4><div class="actions"><button data-act="autoadj" title="Exposure, contrast and white balance from the clip's own picture">Auto adjust</button>${others.length ? `<select id="matchRef" title="The clip whose colours to copy">${others.map(x => `<option value="${x.id}">${esc(M.get(x.media).name)} @ ${tc(x.start).slice(0, 5)}</option>`).join('')}</select><button data-act="matchcol">Match colour</button>` : ''}</div>`
      + `${slider('c.adj.b', 'Brightness', a.b ?? 1, 0, 2, 0.01, '%')}${slider('c.adj.c', 'Contrast', a.c ?? 1, 0, 2, 0.01, '%')}${slider('c.adj.s', 'Saturation', a.s ?? 1, 0, 3, 0.01, '%')}`
      + slider('c.adj.temp', 'Temperature', a.temp || 0, -1, 1, 0.01, '%') + slider('c.adj.tint', 'Tint', a.tint || 0, -1, 1, 0.01, '%')
      + slider('c.adj.ex', 'Exposure', a.ex || 0, -2, 2, 0.05) + slider('c.adj.hi', 'Highlights', a.hi || 0, -1, 1, 0.01, '%') + slider('c.adj.sh', 'Shadows', a.sh || 0, -1, 1, 0.01, '%')
      + slider('c.adj.fade', 'Fade', a.fade || 0, 0, 1, 0.01, '%') + slider('c.adj.vig', 'Vignette', a.vig || 0, 0, 1, 0.01, '%') + slider('c.adj.blur', 'Blur', a.blur || 0, 0, 1, 0.01, '%');
    look += `<h4>Beauty</h4>${slider('c.beauty.amt', 'Smooth skin', c.beauty?.amt || 0, 0, 1, 0.01, '%')}<p class="hint">Evens out skin texture (skin-coloured areas only); edges, eyes and hair stay sharp.</p>`;
    if (m.alpha || m.trans) look += `<h4>Glow</h4>${segs('glowkind', 'Style', !c.glow ? 'none' : c.glow.neon ? 'neon' : 'glow', [['none', 'None'], ['glow', 'Glow'], ['neon', 'Neon']])}`
      + (c.glow ? colour('c.glow.color', 'Colour', c.glow.color) + slider('c.glow.size', 'Size', c.glow.size, 0.05, 1, 0.01, '%') : '');
    const [L, R] = c.flip ? ['r', 'l'] : ['l', 'r']; // with Mirror on, "Left" still means the left of what you see
    look += `<h4>Crop</h4>${slider(`c.crop.${L}`, 'Left', cr[L] || 0, 0, 0.45, 0.005, '%')}${slider(`c.crop.${R}`, 'Right', cr[R] || 0, 0, 0.45, 0.005, '%')}${slider('c.crop.t', 'Top', cr.t || 0, 0, 0.45, 0.005, '%')}${slider('c.crop.b', 'Bottom', cr.b || 0, 0, 0.45, 0.005, '%')}${tick('c.flip', 'Mirror', c.flip)}`;
    look += `<h4>Mask</h4><div class="presets small">${MASKS.map(([v, n]) => `<button data-mask="${v}" class="${(mk?.type || 'none') === v ? 'on' : ''}">${n}</button>`).join('')}</div>`
      + (mk ? slider('c.mask.x', 'Centre X', mk.x, -0.5, 0.5, 0.005, '%') + slider('c.mask.y', 'Centre Y', mk.y, -0.5, 0.5, 0.005, '%')
        + (['circle', 'rect'].includes(mk.type) ? slider('c.mask.w', 'Width', mk.w, 0.05, 1.5, 0.01, '%') : '')
        + (mk.type !== 'linear' ? slider('c.mask.h', mk.type === 'mirror' ? 'Band' : 'Height', mk.h, 0.02, 1.5, 0.01, '%') : '')
        + slider('c.mask.rot', 'Rotate', mk.rot, -180, 180, 1, '°') + slider('c.mask.feather', 'Feather', mk.feather, 0, 0.3, 0.005, '%') + tick('c.mask.invert', 'Invert', mk.invert)
        + `<div class="actions">${c.mkf?.length ? '<button data-act="mkfprev" title="Previous mask keyframe" aria-label="Previous mask keyframe">‹</button><button data-act="mkfnext" title="Next mask keyframe" aria-label="Next mask keyframe">›</button>' : ''}<button data-act="mkfadd">${c.mkf?.length ? 'Mask keyframe here' : 'Animate the mask'}</button>${c.mkf?.length ? `<button data-act="mkfdel">Remove here</button><button data-act="mkfclear">Clear ${c.mkf.length}</button>` : ''}</div>`
        + `<p class="hint">${c.mkf?.length ? 'The mask moves between its keyframes; changing it at the playhead edits or adds one there.' : 'Animate the mask to follow something: add a keyframe, move the playhead, move the mask.'}</p>` : '');
    look += `<h4>Chroma key</h4>${c.key ? `${colour('c.key.color', 'Key colour', c.key.color)}${slider('c.key.sim', 'Strength', c.key.sim, 0.01, 1, 0.01, '%')}${slider('c.key.blend', 'Softness', c.key.blend, 0, 0.5, 0.01, '%')}<div class="actions"><button data-act="keypick">Pick colour from preview</button><button data-act="keyoff">Turn off</button></div>`
      : '<div class="actions"><button data-act="keyon">Remove green screen</button></div>'}`;
  }
  let audio = '';
  if (m.hasAudio) {
    audio += slider('c.volume', 'Volume', dB(c.volume), -60, 20, 0.5, 'dB', ' data-db') + tick('c.denoise', 'Reduce noise', c.denoise)
      + `<p class="hint">RNNoise on this Mac, heard in the preview too. For the strongest cut, Isolate voice below keeps only the voice.</p>`
      + `<h4>Separate</h4><div class="actions">${lane !== 'audio' && c.volume > 0 ? '<button data-act="detach">Detach audio</button>' : ''}<button data-act="isovoice" title="Keep only the voice (Demucs, on this Mac): the strongest noise reduction">Isolate voice</button><button data-act="novoice" title="Keep the music and ambience, drop the voice">Remove voice</button><button data-act="stems" title="Vocals, drums, bass and the rest as four audio clips (Demucs, on this Mac)">Split into stems</button></div>`;
  }
  if (m.hasAudio) { // CapCut's voice effects, pitch, equalizer, pan; volume points; stems
    const a = { ...AU0, ...c.au }, lt = clamp(S.t - c.start, 0, len(c)), vk = voiceOf(a);
    audio += `<h4>Voice effect</h4><div class="seg wrap voices">${VOICES.map(([k, n]) => `<button data-voice="${k}" class="${vk === k ? 'on' : ''}">${n}</button>`).join('')}</div>`
      + slider('c.au.semi', 'Pitch', a.semi, -12, 12, 1, 'st')
      + `<h4>Equalizer</h4>` + slider('c.au.bass', 'Bass', a.bass, -12, 12, 0.5, 'dB') + slider('c.au.mid', 'Mid', a.mid, -12, 12, 0.5, 'dB')
      + slider('c.au.treb', 'Treble', a.treb, -12, 12, 0.5, 'dB') + slider('c.au.pan', 'Pan', a.pan, -1, 1, 0.05, 'pan')
      + (c.au ? '<div class="actions"><button data-act="soundreset">Reset sound</button></div>' : '')
      + `<h4>Volume points</h4><p class="hint">${c.vkf?.length ? `${c.vkf.length} point${c.vkf.length > 1 ? 's' : ''}, on top of the volume above. ` : ''}The level at the playhead; points ramp into each other, and the first one sets the whole clip.</p>`
      + slider('vk.here', 'Level here', +dB(envAt(c, lt)).toFixed(1), -40, 6, 0.5, 'dB', ' id="vkHere"')
      + `<div class="actions"><button data-act="vkprev" title="Previous volume point">◀ Point</button><button data-act="vknext" title="Next volume point">Point ▶</button>${c.vkf?.length ? '<button data-act="vkdel">Delete point</button><button data-act="vkfclear">Clear all</button>' : ''}</div>`
      + (lane === 'audio' ? `<div class="row"><span>Duck by</span><select id="duckDepth">${[[0.5, 6], [0.25, 12], [0.125, 18], [0.0625, 24]].map(([v, n]) => `<option value="${v}"${(c.duck?.depth ?? 0.25) === v ? ' selected' : ''}>−${n} dB</option>`).join('')}</select></div>`
        + `<div class="actions"><button data-act="duck" title="Lower this clip wherever another clip has speech, and keep following it through later edits">${c.duck ? 'Set depth' : 'Auto duck under speech'}</button>${c.duck ? '<button data-act="unduck">Duck off</button>' : ''}</div>`
        + (c.duck ? '<p class="hint">Auto duck is on: the dips follow the speech through every edit.</p>' : '') : '');
  }
  if (lane === 'audio') {
    audio += `<h4>Beats</h4>${c.beats ? `<p class="muted">${c.bpm} BPM · ${c.beats.length} beats marked; edits snap to them</p>
      <div class="row"><span>Cut main every</span><select id="beatEvery"><option value="1">beat</option><option value="2" selected>2 beats</option><option value="4">4 beats</option><option value="8">8 beats</option></select></div>
      <div class="actions"><button data-act="beatsync">Sync main cuts to beats</button></div>` : '<div class="actions"><button data-act="beats">Detect beats</button></div>'}`;
  }
  const acts = ['<button data-act="split">Split</button>', '<button data-act="dup">Duplicate</button>'];
  if (vid) acts.push('<button data-act="freeze">Freeze frame</button>', '<button data-act="reverse">Reverse</button>');
  if (vid && c.speed < 1) acts.push('<button data-act="slowmo">Smooth slow-mo</button>');
  if (lane === 'main' || lane === 'overlay') acts.push(`<button data-act="movelane">Move to ${lane === 'main' ? 'overlay' : 'main'} track</button>`);
  if (lane === 'overlay') acts.push('<button data-act="back">Send backward</button>', '<button data-act="fwd">Bring forward</button>');
  if (c.compound) acts.unshift('<button data-act="breakcompound" title="Put back the clips it was made of">Break apart</button>');
  acts.push('<button data-act="reset">Reset</button>', '<button data-act="delete">Delete</button>');
  let tools = vid ? `<h4>Smart tools</h4><div class="actions"><button data-act="matte"${m.alpha ? ' disabled' : ''}>Remove background</button><button data-act="removeobj">Remove object</button><select id="rmQuality" title="Best: SAM 2 traces the exact outline and ProPainter fills it (about a minute per 4 s). Fast: the tracked box, filled in seconds"><option value="best">Best</option><option value="fast">Fast</option></select><button data-act="cutobj" title="Any subject (SAM 2): box it once, the clip becomes it on a transparent background">Cut out object</button><button data-act="reframe">Auto reframe</button><button data-act="stabilize">Stabilize</button><button data-act="denoise" title="A cleaned copy of this clip's range (night grain)">Reduce image noise</button><select id="dnStrength" title="How much noise to take out"><option value="light">Light</option><option value="strong">Strong</option></select><button data-act="scenes">Split at scene changes</button>${lane === 'overlay' ? '<button data-act="track">Track motion</button>' : ''}</div>
    <h4>Speed ramp</h4><div class="row"><span>Curve</span><select id="rampSel">${Object.keys(RAMPS).map(n => `<option value="${n}">${RAMP_NAMES[n]}</option>`).join('')}</select></div>
    <div class="actions"><button data-act="ramp">Apply ramp</button></div><p class="hint">Splits the clip into 8 parts with ramped speeds; every part stays editable and keeps its keyframes.</p>` : '';
  if (vid) tools += `<h4>Body effects</h4><div class="actions">${BODY.map(([k, n, t]) => `<button data-body="${k}" title="${t}">${n}</button>`).join('')}</div><p class="hint">The person is cut out (on this Mac) onto the track above, in sync, and the background or the person gets the effect.</p>`;
  if (m.kind === 'image') tools += '<h4>Smart tools</h4><div class="actions"><button data-act="matte">Remove background</button></div><p class="hint">Cuts out the main subject (any object, not only people) into a new transparent image.</p>';
  tools += `<h4>Clip</h4><div class="actions">${acts.join('')}</div>`;
  return head + '<p id="clipStatus" class="muted"></p>' + tabbed([['Basic', basic], ['Animate', animate], ['Look', look], ['Color', vis ? colorPanel(c) : ''], ['Audio', audio], ['Tools', tools]]); // status above the tabs: below them it was off screen on 5 of 6
}
const WHEELS = [['lift', 'Shadows'], ['gamma', 'Midtones'], ['gain', 'Highlights']], CURVE_CH = [['m', 'Luma'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
function colorPanel(c) { // colour wheels, curves, HSL, an imported LUT, and the strength of all colour over time
  const g = c.grade || {}, ch = S.curveCh || 'm', band = S.hband || 'red', hb = g.hsl?.[band] || {}, lt = clamp(S.t - c.start, 0, len(c));
  const luts = G.luts || [];
  return `<h4>Colour wheels</h4><div class="wheels">${WHEELS.map(([k, n]) => `<div class="wheel"><canvas data-wheel="${k}" width="168" height="168" title="Drag to tint the ${n.toLowerCase()}; double-click resets"></canvas><span>${n}</span></div>`).join('')}</div>`
    + WHEELS.map(([k, n]) => slider(`c.grade.${k}.l`, n, g[k]?.l || 0, -1, 1, 0.01, '%')).join('')
    + `<h4>Curves</h4>${segs('curvech', 'Channel', ch, CURVE_CH)}<div class="curvebox"><svg id="curveSvg" viewBox="0 0 100 100" preserveAspectRatio="none" data-ch="${ch}"></svg></div><p class="hint">Drag a point; click the curve to add one; double-click a point to remove it.</p><div class="actions"><button data-act="curvereset">Reset ${CURVE_CH.find(x => x[0] === ch)[1].toLowerCase()} curve</button></div>`
    + `<h4>HSL</h4><div class="hslbands">${HSL_BANDS.map(([k, , col]) => `<button data-hband="${k}" class="${k === band ? 'on' : ''}${g.hsl?.[k] && (g.hsl[k].h || g.hsl[k].s || g.hsl[k].l) ? ' set' : ''}" style="--c:${col}" title="${k[0].toUpperCase() + k.slice(1)}" aria-label="${k}"></button>`).join('')}</div>`
    + slider(`c.grade.hsl.${band}.h`, 'Hue', hb.h || 0, -1, 1, 0.01, '%') + slider(`c.grade.hsl.${band}.s`, 'Saturation', hb.s || 0, -1, 1, 0.01, '%') + slider(`c.grade.hsl.${band}.l`, 'Lightness', hb.l || 0, -1, 1, 0.01, '%')
    + `<h4>LUT</h4><div class="row"><span>LUT</span><select id="lutSel"><option value="">None</option>${luts.map(L => `<option value="${L.id}"${g.lut?.id === L.id ? ' selected' : ''}>${esc(short(L.name, 24))}</option>`).join('')}</select></div>`
    + `<div class="actions"><label class="btn"><input type="file" data-lutin hidden accept=".cube">Import .cube…</label></div>${g.lut?.id ? slider('c.grade.lut.amount', 'Strength', g.lut.amount ?? 1, 0, 1, 0.01, '%') : ''}`
    + `<h4>Strength over time</h4><p class="hint">${c.lkf?.length ? `${c.lkf.length} point${c.lkf.length > 1 ? 's' : ''}: filters, adjustments and grade fade by them. ` : 'Fade all of this clip\'s colour (filter, adjust, grade) in or out: set a level at the playhead, move, set another.'}</p>`
    + slider('lk.here', 'Strength here', +strengthAt(c, lt).toFixed(2), 0, 1, 0.01, '%', ' id="lkHere"')
    + `<div class="actions"><button data-act="lkprev" title="Previous strength point">◀ Point</button><button data-act="lknext" title="Next strength point">Point ▶</button>${c.lkf?.length ? '<button data-act="lkdel">Delete point</button><button data-act="lkclear">Clear all</button>' : ''}</div>`
    + (gradeOn(g) || c.lkf?.length ? '<div class="actions"><button data-act="gradereset">Reset colour</button></div>' : '');
}
function strengthPoint(c, v) { // the strength curve at the playhead: a new point, or the one already there
  const lt = clamp(S.t - c.start, 0, len(c)), near = f => Math.abs(f.t - lt) < 0.5 / P.fps;
  c.lkf = [...(c.lkf || []).filter(f => !near(f)), { t: +lt.toFixed(4), v: +clamp(v, 0, 1).toFixed(3) }].sort((a, b) => a.t - b.t);
}
function drawWheels(c) { // hue rings with the clip's offset as a dot
  for (const cv of document.querySelectorAll('#inspector canvas[data-wheel]')) {
    const x = cv.getContext('2d'), W = cv.width, R = W / 2 - 6, k = cv.dataset.wheel, w = c.grade?.[k] || {};
    x.clearRect(0, 0, W, W);
    for (let a = 0; a < 360; a += 2) { x.beginPath(); x.moveTo(W / 2, W / 2); x.arc(W / 2, W / 2, R, (-(a + 2.5) * Math.PI) / 180, (-a * Math.PI) / 180); x.closePath(); x.fillStyle = `hsl(${a},70%,50%)`; x.fill(); }
    const gr = x.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, R); gr.addColorStop(0, 'rgba(40,40,46,1)'); gr.addColorStop(1, 'rgba(40,40,46,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(W / 2, W / 2, R, 0, 6.2832); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.25)'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(W / 2 - 8, W / 2); x.lineTo(W / 2 + 8, W / 2); x.moveTo(W / 2, W / 2 - 8); x.lineTo(W / 2, W / 2 + 8); x.stroke();
    const px = W / 2 + (w.x || 0) * R, py = W / 2 - (w.y || 0) * R;
    x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 2; x.beginPath(); x.arc(px, py, 7, 0, 6.2832); x.fill(); x.stroke();
  }
}
function drawCurve(c) {
  const svg = $('#curveSvg');
  if (!svg) return;
  const ch = svg.dataset.ch, pts = c.grade?.curves?.[ch] || [[0, 0], [1, 1]], f = curveFn(pts) || (v => v), col = { m: '#fff', r: '#ff5c5c', g: '#4cd964', b: '#5b8cff' }[ch];
  const path = Array.from({ length: 101 }, (_, i) => `${i ? 'L' : 'M'}${i},${(100 - f(i / 100) * 100).toFixed(2)}`).join('');
  svg.innerHTML = '<path d="M25,0V100M50,0V100M75,0V100M0,25H100M0,50H100M0,75H100" class="grid"/><path d="M0,100L100,0" class="diag"/>'
    + `<path d="${path}" class="crv" style="stroke:${col}"/>` + pts.map(([x, y], i) => `<circle cx="${x * 100}" cy="${100 - y * 100}" r="3.2" data-pt="${i}"/>`).join('');
}
async function importLutFile(f) { // a .cube from this Mac into Movies/Cutroom/luts (checked here first)
  const text = await f.text();
  parseCube(text);
  const L = await api('/api/luts', { name: f.name, text });
  G.luts = await api('/api/luts');
  toast(`LUT "${L.name}" imported`);
  return L;
}
const BODY = [['blur', 'Blur background', 'Person sharp, background blurred'], ['mono', 'Mono background', 'Person in colour, background black and white'], ['dim', 'Dim background', 'Background darkened'],
  ['glow', 'Glow', 'A soft white glow around the person'], ['neon', 'Neon outline', 'A bright neon line around the person']];
async function bodyEffect(c, lane, kind) { // CapCut's body effects: the person (Vision) cut out onto the track above, in sync; the background or the person treated
  if (M.get(c.media)?.kind !== 'video') throw new Error('body effects work on video clips');
  if (!BODY.some(b => b[0] === kind)) throw new Error(`kind must be one of ${BODY.map(b => b[0]).join(', ')}`);
  try {
    const j = await job('/api/matte', { media: c.media, t0: c.in, t1: c.out }, 'Finding the person');
    await loadMedia();
    let cut;
    change(() => {
      packMain();
      cut = { ...structuredClone(c), id: hex12(), media: j.media, in: 0, out: c.out - c.in, start: c.start, volume: 0, body: kind };
      for (const k of ['tr', 'vkf', 'mask', 'mkf', 'key', 'blend', 'au', 'denoise', 'duck', 'compound', 'mc', 'track']) delete cut[k];
      if (cut.adj) delete cut.adj.blur;
      if (lane === 'overlay') P.overlay.splice(P.overlay.indexOf(c) + 1, 0, cut); else P.overlay.push(cut);
      if (kind === 'blur') c.adj = { ...c.adj, blur: 0.45 };
      else if (kind === 'mono') c.adj = { ...c.adj, s: 0 };
      else if (kind === 'dim') c.adj = { ...c.adj, b: 0.45 };
      else cut.glow = kind === 'neon' ? { color: '#00e5ff', size: 0.35, neon: true } : { color: '#ffffff', size: 0.6 };
      S.sel = { lane: 'overlay', id: cut.id };
    });
    toast(`${BODY.find(b => b[0] === kind)[1]}: the person is on the overlay track above`);
    return cut;
  } catch (e) { setStatus(e.message); throw e; }
}
function fontPick(k, v) { // Cutroom's own fonts, the imported ones, then every family on this Mac
  const mine = (G.fonts || []).map(f => f.family), mac = (G.sysFonts || []).filter(f => !FONTS.includes(f) && !mine.includes(f)), all = [...FONTS, ...mine, ...mac];
  const grp = (label, fs) => (fs.length ? `<optgroup label="${label}">${fs.map(f => `<option value="${esc(f)}"${f === v ? ' selected' : ''}>${esc(f)}</option>`).join('')}</optgroup>` : '');
  return `<label class="row"><span>Font</span><select data-k="${k}">${all.includes(v) ? '' : `<option value="${esc(v)}" selected>${esc(v)}</option>`}${grp('Cutroom', FONTS)}${grp('Imported', mine)}${grp('This Mac', mac)}</select></label>`
    + '<div class="actions"><label class="btn"><input type="file" data-fontin hidden accept=".ttf,.otf,.woff2">Import font…</label></div>';
}
const fontsOn = new Set();
async function loadFonts() { // imported fonts (Movies/Cutroom/fonts) registered with the page, so preview and export draw them alike
  G.fonts = await api('/api/fonts').catch(() => G.fonts || []);
  await Promise.all(G.fonts.filter(f => !fontsOn.has(f.id)).map(f => {
    fontsOn.add(f.id);
    WEIGHTS[f.family] ??= [400];
    const ff = new FontFace(f.family, `url(/fonts/${f.file})`, { weight: '1 1000' }); // one face for every weight: never a faked bold
    document.fonts.add(ff);
    return ff.load().catch(() => {});
  }));
}
async function importFont(f) {
  const r = await fetch(`/api/fonts?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: f });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  await loadFonts();
  toast(`Font "${j.family}" imported`);
  return j;
}
function textPanel(c, lane) {
  const cap = lane === 'captions', st = textStyle(c, lane), r = 'c.style', pr = cap ? null : propsAt(c, S.t - c.start), ws = WEIGHTS[st.font] || [400, 700];
  const style = `<textarea data-k="c.text" rows="3" spellcheck="false">${esc(c.text)}</textarea>`
    + (cap ? `<p class="hint">Presets restyle every caption; the settings below restyle this one.</p><div class="presets small">${Object.keys(CAP_PRESETS).map(n => `<button data-cappreset="${n}">${n}</button>`).join('')}</div>`
      + `<div class="actions"><button data-act="capall" title="Every caption takes this caption's style">Apply to all captions</button></div>`
      : `<div class="presets small">${Object.keys(TEXT_PRESETS).map(n => `<button data-textpreset="${n}">${n}</button>`).join('')}</div>`)
    + fontPick(`${r}.font`, st.font) + pick(`${r}.weight`, 'Weight', ws.includes(st.weight) ? st.weight : ws[0], ws.map(w => [w, WEIGHT_NAMES[w] || String(w)]))
    + tick(`${r}.italic`, 'Italic', st.italic) + slider(`${r}.size`, 'Size', st.size, 16, 260, 1) + colour(`${r}.color`, 'Colour', st.color)
    + (cap ? colour(`${r}.hl`, 'Highlight', st.hl) + tick(`${r}.pop`, 'Pop active word', st.pop) : '')
    + `<h4>Layout</h4>${segs('align', 'Align', st.align || 'center', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])}`
    + slider(`${r}.ls`, 'Letter spacing', st.ls || 0, -0.05, 0.5, 0.005, '%') + slider(`${r}.lh`, 'Line height', st.lh, 0.8, 2.2, 0.01) + slider(`${r}.maxW`, 'Max width', st.maxW, 0.2, 1, 0.01, '%') + tick(`${r}.upper`, 'All caps', st.upper)
    + `<h4>Outline</h4>${slider(`${r}.strokeW`, 'Width', st.strokeW, 0, 20, 0.5)}${colour(`${r}.stroke`, 'Colour', st.stroke)}`
    + `<h4>Shadow</h4>${tick(`${r}.shadow`, 'Shadow', st.shadow)}${st.shadow ? colour(`${r}.shc`, 'Colour', st.shc) + slider(`${r}.sha`, 'Opacity', st.sha, 0, 1, 0.01, '%') + slider(`${r}.shb`, 'Blur', st.shb, 0, 1, 0.01, '%')
      + slider(`${r}.shx`, 'Offset X', st.shx, -0.5, 0.5, 0.005, '%') + slider(`${r}.shy`, 'Offset Y', st.shy, -0.5, 0.5, 0.005, '%') : ''}`
    + `<h4>Background</h4>${tick(`${r}.box`, 'Background', st.box)}${st.box ? colour(`${r}.boxColor`, 'Colour', st.boxColor) + slider(`${r}.boxAlpha`, 'Opacity', st.boxAlpha, 0, 1, 0.01, '%')
      + slider(`${r}.boxR`, 'Roundness', st.boxR, 0, 1, 0.01, '%') + slider(`${r}.boxPad`, 'Padding', st.boxPad, 0, 1.5, 0.01, '%') : ''}`;
  const anim = pick(`${r}.anim`, 'In', st.anim || 'none', ANIMS) + (st.anim && st.anim !== 'none' ? slider(`${r}.animT`, 'In length', animLen(st, false), 0.1, 5, 0.05, 's') : '')
    + pick(`${r}.out`, 'Out', st.out || 'none', OUTS) + (st.out && st.out !== 'none' ? slider(`${r}.outT`, 'Out length', animLen(st, true), 0.1, 5, 0.05, 's') : '')
    + pick(`${r}.loop`, 'Loop', st.loop || 'none', LOOPS);
  const pos = cap ? slider('cap.y', 'Position Y', P.capStyle.y - 0.5, -0.5, 0.5, 0.005, '%', ' data-off="0.5"') + '<p class="hint">Captions share one position; drag any caption on the preview to move them all.</p>'
    : slider('c.x', 'Position X', pr.x - 0.5, -0.5, 0.5, 0.005, '%', ' data-off="0.5"') + slider('c.y', 'Position Y', pr.y - 0.5, -0.5, 0.5, 0.005, '%', ' data-off="0.5"') + slider('c.scale', 'Scale', pr.scale, 0.2, 4, 0.01, '%')
      + slider('c.rot', 'Rotate', pr.rot, -180, 180, 1, '°') + slider('c.opacity', 'Opacity', pr.opacity, 0, 1, 0.01, '%') + kfRow(c, lane);
  return `<h3>${cap ? 'Caption' : 'Text'}</h3>` + tabbed([['Style', style], ['Animate', anim], ['Position', pos]])
    + `<div class="actions"><button data-act="split">Split</button>${cap ? '' : '<button data-act="dup">Duplicate</button><button data-act="track">Track motion</button>'}<button data-act="delete">Delete</button>${cap ? '<button data-act="clearcaps">Delete all captions</button>' : ''}</div><p id="clipStatus" class="muted"></p>`;
}
function apply(el) { // data-k="c.adj.b" -> selected clip .adj.b ; "cap.size" -> caption style ; "p.fps" -> project
  if (el.dataset.k === 'vk.here') { const c = selClip(); if (c) volPoint(c, +el.value); return; }
  if (el.dataset.k === 'lk.here') { const c = selClip(); if (c) strengthPoint(c, +el.value); return; }
  const [root, ...path] = el.dataset.k.split('.'), last = path.pop();
  let o = root === 'c' ? selClip() : root === 'cap' ? P.capStyle : P;
  if (!o) return;
  let v = el.type === 'checkbox' ? el.checked : el.type === 'range' || 'num' in el.dataset ? +el.value : el.value;
  if ('log' in el.dataset) { v = 10 ** v; v = Math.abs(v - 1) < 0.02 ? 1 : +v.toFixed(2); } // speed: log slider, 1x has a detent
  if ('db' in el.dataset) v = v <= -60 ? 0 : +(10 ** (v / 20)).toFixed(4); // volume: dB slider
  if (el.dataset.off) v += +el.dataset.off; // text position is shown as an offset from the centre
  if (el.dataset.k === 'c.speed' && o.speed && v !== o.speed) { const f = o.speed / v; o.kf?.forEach(x => { x.t *= f; }); o.vkf?.forEach(x => { x.t *= f; }); } // they stay on their frames
  if (el.dataset.k === 'c.ease') o.kf?.forEach(x => delete x.ease); // "ease all segments" really means all
  if (root === 'c' && !path.length && KF_PROPS.includes(last)) return setProp(o, last, v);
  if (root === 'c' && path.length === 1 && path[0] === 'mask' && o.mkf?.length && MKF.includes(last)) { maskPoint(o)[last] = v; return; }
  for (const q of path) o = o[q] ??= {};
  o[last] = v;
  if (last === 'font' && WEIGHTS[v]) { const w = o.weight ?? textStyle(selClip() || {}, S.sel?.lane).weight, ws = WEIGHTS[v]; if (!ws.includes(w)) o.weight = ws.reduce((x, y) => (Math.abs(y - w) < Math.abs(x - w) ? y : x)); }
  if (el.dataset.k === 'c.text') retext(selClip());
}
function relink(from, to) { // every clip that played the missing `from` plays library item `to` instead (same in/out, kept inside it)
  const m = M.get(to);
  if (!m) throw new Error(`no media ${to} in the library`);
  let n = 0;
  change(() => { for (const L of LANES) for (const c of P[L.key]) if (c.media === from) { c.media = to; n++; if (m.kind === 'image') { c.in = 0; c.out = Math.max(c.out - c.in, 0.1); } else { c.out = Math.min(c.out, m.duration); c.in = Math.min(c.in, Math.max(0, c.out - 0.1)); } } });
  toast(`Relinked ${n} clip${n === 1 ? '' : 's'} to ${m.name}`);
  return n;
}
function retext(c) { // keep word timings when the word count still matches, otherwise it becomes plain text
  if (!c.words) return;
  const ws = c.text.trim().split(/\s+/);
  if (ws.length === c.words.length) c.words.forEach((w, i) => { w.w = ws[i]; });
  else { delete c.words; toast('The word count changed, so this caption lost its word timing (no highlight or pop). Undo brings it back.'); }
}

// ---------- preview engine ----------
function fitStage() {
  if (!P) return;
  const st = $('#stage').getBoundingClientRect(), cv = $('#cv'), dpr = devicePixelRatio || 1;
  const s = Math.max(0.01, Math.min((st.width - 24) / P.w, (st.height - 24) / P.h));
  cv.style.width = `${Math.round(P.w * s)}px`;
  cv.style.height = `${Math.round(P.h * s)}px`;
  cv.width = Math.max(2, Math.round(P.w * s * dpr));
  cv.height = Math.max(2, Math.round(P.h * s * dpr));
  S.dirty = true;
}
const POOL_MAX = 8; // video elements kept loaded (720p copies): jumping back to a clip finds its file still there
function vidFor(key, m) {
  let v = pool.get(key);
  if (v) { pool.delete(key); pool.set(key, v); } // most recently used last
  else {
    v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.muted = true; // the sound plays from Web Audio buffers (audioTick), not from the element
    // WebKit hands drawImage the new frame a moment after 'seeked'. (Not requestVideoFrameCallback: it never fires for these
    // off-screen elements once a WebGL pass has read a video, and waiting on it left the preview on a stale frame.)
    v.addEventListener('seeked', () => { v._t0 = undefined; S.dirty = true; setTimeout(() => { S.dirty = true; }, 50); });
    v.addEventListener('loadeddata', () => { v._t0 = undefined; S.dirty = true; });
    $('#mediaPool').append(v);
    pool.set(key, v);
    for (const [k2, old] of pool) { // the least recently used ones go (never one on screen)
      if (pool.size <= POOL_MAX) break;
      if (k2 === key || S.live?.has(old)) continue;
      old.pause(); old.removeAttribute('src'); old.load(); old.remove(); pool.delete(k2);
    }
  }
  if (v.dataset.media !== m.id) { v.dataset.media = m.id; v._t0 = undefined; v.src = `/media/${m.id}${m.alpha || m.trans ? ALPHA_Q : m.hdr && !m.proxy ? '' : WK_Q}`; }
  return v;
}
function imgFor(m) {
  let i = imgs.get(m.id);
  if (!i) { i = new Image(); i.onload = () => { S.dirty = true; }; i.src = `/media/${m.id}?view=1`; imgs.set(m.id, i); } // at most 2560 px: the canvas never shows more
  return i;
}
let actx;
let pitchReady = false, hallIR = null;
function audioOn() { // needs a user gesture; loads the pitch shifter and the hall's impulse response once
  try {
    if (!actx) {
      actx = new AudioContext();
      actx.audioWorklet?.addModule('/pitch.js').then(() => { pitchReady = true; resound(); }).catch(() => {});
      fetch('/ir/hall.wav').then(r => r.arrayBuffer()).then(b => actx.decodeAudioData(b)).then(buf => { hallIR = buf; resound(); }).catch(() => {});
    }
    if (actx.state !== 'running') actx.resume().catch(() => {});
  } catch { actx = null; }
}
// Starting the audio device holds the video back 40-70 ms (first play 65-96 ms to a moving picture vs 2-28 ms with it
// already running), and a running one costs ~0.05 cores doing nothing. So it wakes while you work (any key, click or
// mouse move) and sleeps after audioNap ms with no input and nothing playing.
let audioNap = 10000, napTimer = 0, wokeAt = 0;
function audioAwake() {
  const now = performance.now();
  if (now - wokeAt < 500) return; // pointermove fires 60-120 times a second
  wokeAt = now; audioNapLater();
  if (actx?.state !== 'running') audioOn();
}
function audioNapLater() { clearTimeout(napTimer); napTimer = setTimeout(() => S.playing || rec || actx?.suspend(), audioNap); } // (a voiceover take runs on past the end)
for (const e of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(e, audioAwake, { capture: true, passive: true });
function resound() { for (const v of voices.values()) v.n.key = ''; S.dirty = true; } // re-apply every clip's sound settings
const AU0 = { voice: 'none', semi: 0, bass: 0, mid: 0, treb: 0, pan: 0 };
function soundChain(v, A = actx, src = A.createMediaElementSource(v)) { // per media element, the export's afx() in Web Audio: [pitch] > bass > mid > treble > [telephone band] > [robot] > dry + [echo | hall] > pan > volume
  const bq = (type, f, q) => { const b = A.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const n = { A, src, head: A.createGain(), bass: bq('lowshelf', 100, 0), mid: bq('peaking', 1000, 1), treb: bq('highshelf', 8000, 0),
    hp: bq('allpass', 400, -3.0103), lp: bq('allpass', 3200, -3.0103), ring: A.createGain(), dry: A.createGain(), sum: A.createGain(), pan: A.createStereoPanner(), out: A.createGain(), key: '' };
  Object.assign(n.head, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }); // mono doubled to stereo, like the export's aformat
  n.src.connect(n.head).connect(n.bass).connect(n.mid).connect(n.treb).connect(n.hp).connect(n.lp).connect(n.ring).connect(n.dry).connect(n.sum).connect(n.pan).connect(n.out).connect(A.destination);
  return n; // highpass/lowpass Q is in dB in Web Audio: -3.01 dB = Q 0.707, the export's Butterworth
}
function setSound(n, au) { // a clip's sound settings onto its element's chain (skipped when unchanged); effects that are off are disconnected, so they cost nothing
  const s = { ...AU0, ...au }, key = JSON.stringify([s, pitchReady, !!hallIR]);
  if (n.key === key) return;
  n.key = key;
  const A = n.A;
  n.bass.gain.value = s.bass; n.mid.gain.value = s.mid; n.treb.gain.value = s.treb; n.pan.pan.value = s.pan;
  const tel = s.voice === 'telephone';
  n.hp.type = tel ? 'highpass' : 'allpass'; n.lp.type = tel ? 'lowpass' : 'allpass';
  n.head.disconnect();
  if (s.semi && pitchReady) { // semitones keeping the timing
    n.pitch ??= new AudioWorkletNode(A, 'cutroom-pitch', { outputChannelCount: [2] });
    n.pitch.parameters.get('ratio').value = 2 ** (s.semi / 12);
    n.pitch.disconnect(); n.head.connect(n.pitch).connect(n.bass);
  } else n.head.connect(n.bass);
  if (s.voice === 'robot') { // ring modulation by 50 Hz
    if (!n.osc) { n.osc = A.createOscillator(); n.osc.frequency.value = 50; n.osc.start(); }
    n.ring.gain.value = 0; n.osc.disconnect(); n.osc.connect(n.ring.gain);
  } else { n.osc?.disconnect(); n.ring.gain.value = 1; }
  n.ring.disconnect(); n.ring.connect(n.dry);
  n.dry.gain.value = s.voice === 'echo' ? 0.8 : 1; // aecho=1:0.8:250|500|750:0.5|0.25|0.125
  if (s.voice === 'echo') {
    n.taps ??= [0.25, 0.5, 0.75].map((d, i) => { const dl = A.createDelay(1), g = A.createGain(); dl.delayTime.value = d; g.gain.value = 0.8 * 0.5 / 2 ** i; dl.connect(g).connect(n.sum); return dl; });
    for (const dl of n.taps) n.ring.connect(dl);
  }
  if (s.voice === 'hall' && hallIR) { // dry + the convolution with the same impulse response the export's afir uses
    if (!n.conv) { n.conv = A.createConvolver(); n.conv.normalize = false; n.conv.buffer = hallIR; n.conv.connect(n.sum); }
    n.ring.connect(n.conv);
  }
}
// ---------- preview sound: Web Audio buffers of the server's PCM, scheduled on the audio clock ----------
// Each element's sound used to go through Web Audio (volumes over 100 %, the voice effects). WebKit starts such a sound
// ~0.3 s late and holds the element's picture meanwhile: Midnight Highway (2 s shots) stalled 280 ms at every cut, 49 of
// 60 frames/s. Now videos play muted and each clip's sound is 4 s buffers of /media/<id>?pcm=<tempo> (48 kHz s16
// stereo, the export's atempo when the pitch is kept), cut to the clip's range and started at exact audio-clock times.
const PCM_S = 4, PCM_BYTES = PCM_S * 48000 * 4, pcmBufs = new Map(), voices = new Map(), pcmWait = [];
let pcmBusy = 0;
const pcmSlot = () => new Promise(go => { const run = () => { pcmBusy++; go(() => { pcmBusy--; pcmWait.shift()?.(); }); }; if (pcmBusy < 2) run(); else pcmWait.push(run); });
const pcmSpan = (c, tempo) => (tempo === 1 ? [0, 0] : [Math.floor(c.in), Math.ceil(c.out)]); // a kept-pitch speed's PCM covers the clip's whole seconds
function pcmChunk(id, tempo, k, [a, b] = [0, 0], dn = false) { // a promise with .buf once loaded (null: no sound there); the last 24 kept (~37 MB)
  dn = !!dn; // Reduce noise: the server's denoised copy, the same file the export reads
  const key = `${id}|${tempo}|${a}-${b}|${k}|${dn}`;
  let p = pcmBufs.get(key);
  if (p) { pcmBufs.delete(key); pcmBufs.set(key, p); return p; }
  // two at a time: WebKit has 6 connections to the server, and a first play of a long file waits for its PCM to be made
  // (seconds): unthrottled, those waits filled every connection and the projects list or a save queued behind them
  p = pcmSlot().then(release => fetch(`/media/${id}?pcm=${tempo}${tempo === 1 ? '' : `&a=${a}&b=${b}`}${dn ? '&dn=1' : ''}`, { headers: { Range: `bytes=${k * PCM_BYTES}-${(k + 1) * PCM_BYTES - 1}` } })
    .then(r => (r.status === 206 || r.status === 200 ? r.arrayBuffer() : null)).finally(release)).then(b => {
      const n = b ? b.byteLength >> 2 : 0;
      if (!n) return (p.buf = null);
      const x = new Int16Array(b, 0, n * 2), buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: 48000 }), L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < n; i++) { L[i] = x[2 * i] / 32768; R[i] = x[2 * i + 1] / 32768; }
      return (p.buf = buf);
    }).catch(() => (p.buf = null));
  pcmBufs.set(key, p);
  while (pcmBufs.size > 24) pcmBufs.delete(pcmBufs.keys().next().value);
  return p;
}
function clipGain(c, lane, t) { // what paint used to give the element: volume points x fades x the transition's crossfade
  if (S.recMute || P.mute[lane]) return 0;
  const lt = t - c.start, d = tdur(c, lane);
  let g = volAt(c, lt) * fadeAt(c, lt, d);
  if (lane === 'main') { // like acrossfade: the outgoing clip falls as the incoming one rises
    const i = P.main.indexOf(c), nx = P.main[i + 1], f0 = i > 0 ? trF(i - 1) : 0, f1 = nx ? trF(i) : 0;
    if (f1 > 0 && t >= nx.start) g *= 1 - clamp((t - nx.start) / (f1 / P.fps), 0, 1);
    if (f0 > 0) g *= clamp(lt / (f0 / P.fps), 0, 1);
  }
  return g;
}
function audioStop() { // stops what's scheduled, 5 ms down rather than a click; the chains stay for the next play
  const now = actx?.currentTime ?? 0;
  for (const v of voices.values()) { for (const n of v.srcs.values()) if (n) { n.g.gain.setTargetAtTime(0, now, 0.0015); n.stop(now + 0.008); } v.srcs.clear(); }
  S.aA0 = undefined;
}
function joined(a, b) { // b carries on a's sound (a split): it plays straight through, no edge fades (the export's joined())
  return !!a && !!b && a.media === b.media && a.speed === b.speed && a.volume === b.volume && !a.vkf?.length && !b.vkf?.length && !!a.pitch === !!b.pitch
    && !!a.denoise === !!b.denoise && JSON.stringify(a.au || {}) === JSON.stringify(b.au || {}) && !trF(P.main.indexOf(a))
    && Math.abs(a.in + tdur(a, 'main') * a.speed - b.in) < 0.5 / P.fps;
}
function audioTick(wall) { // while playing: (re)anchor timeline to audio clock, schedule the next second of every sounding clip
  if (!actx || actx.state !== 'running' || !S.playing || S.stuck || S.rate !== 1) return audioStop(); // a held clock: the sound waits with the picture (and a shuttle is silent)
  // the audio-clock time whose sample leaves the speakers at the frame's wall time: so the sound of S.t is HEARD at S.t
  // (scheduling on currentTime alone put it outputLatency late, 40-75 ms behind the picture)
  const ts = actx.getOutputTimestamp(), out = ts.performanceTime ? ts.contextTime + (wall - ts.performanceTime) / 1000 : actx.currentTime, now = actx.currentTime;
  rec?.offs.push(S.t - out); // a voiceover take: timeline time minus the audio-clock time heard now (toggleRecord)
  if (S.aA0 === undefined || Math.abs(S.aT0 + (out - S.aA0) - S.t) > 0.04) { audioStop(); S.aA0 = out; S.aT0 = S.t; } // a hold, a seek or clock drift
  const seen = new Set(), t1 = S.t + 1;
  packMain();
  for (const [lane, list] of [['main', P.main], ['overlay', shown('overlay')], ['audio', shown('audio')]]) for (const c of list) {
    const m = M.get(c.media), d = tdur(c, lane);
    if (!m?.hasAudio || !(c.volume > 0) || c.start >= t1 || c.start + d <= S.t) continue;
    seen.add(c.id);
    let v = voices.get(c.id);
    if (!v) { v = { n: soundChain(null, actx, actx.createGain()), srcs: new Map() }; v.n.out.gain.value = clipGain(c, lane, Math.max(S.t, c.start)); voices.set(c.id, v); }
    setSound(v.n, c.au);
    if (S.t >= c.start) v.n.out.gain.setTargetAtTime(clipGain(c, lane, S.t), now, 0.012);
    const tempo = c.pitch || Math.abs(c.speed - 1) < 1e-6 ? 1 : +c.speed.toFixed(4), pbr = c.speed / tempo;
    const sp = pcmSpan(c, tempo), f = t => (c.in - sp[0] + (t - c.start) * c.speed) / tempo, tl = x => c.start + (x * tempo + sp[0] - c.in) / c.speed; // timeline <-> PCM seconds
    const a = Math.max(S.t, c.start), b = Math.min(t1, c.start + d), i = lane === 'main' ? P.main.indexOf(c) : -1;
    for (let k = Math.floor(f(Math.max(a, t1)) / PCM_S); k * PCM_S < f(Math.min(S.t + 3, c.start + d)); k++) pcmChunk(c.media, tempo, k, sp, c.denoise); // fetched 3 s ahead
    for (let k = Math.floor(f(a) / PCM_S); k * PCM_S < f(b); k++) {
      if (v.srcs.has(k)) continue;
      const p = pcmChunk(c.media, tempo, k, sp, c.denoise);
      if (p.buf === undefined) continue; // loading: picked up by a later frame
      if (!p.buf) { v.srcs.set(k, null); continue; }
      let s0 = Math.max(tl(k * PCM_S), c.start, S.t), when = S.aA0 + (s0 - S.aT0);
      const s1 = Math.min(tl(k * PCM_S + p.buf.duration), c.start + d), late = when < now;
      // 3 ms in where sound starts from nothing (play, a re-sync, a clip's start after a cut) and out at a clip's end, like
      // the export: a hard edge clicks. Not between chunks, nor across a split where the same sound carries on
      const fadeIn = late || s0 === S.t || (s0 === c.start ? !(i > 0 && joined(P.main[i - 1], c)) : s0 !== tl(k * PCM_S));
      if (late) { s0 += now - when; when = now; }
      if (s1 - s0 < 1e-3) { v.srcs.set(k, null); continue; }
      const n = actx.createBufferSource(), g = n.g = actx.createGain(), e = when + (s1 - s0);
      n.buffer = p.buf; n.playbackRate.value = pbr; n.connect(g).connect(v.n.src);
      if (fadeIn) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.003); }
      if (s1 === c.start + d && !(i >= 0 && joined(c, P.main[i + 1]))) { g.gain.setValueAtTime(1, Math.max(when + 0.003, e - 0.003)); g.gain.linearRampToValueAtTime(0, e); }
      n.start(when, f(s0) - k * PCM_S, (s1 - s0) * pbr);
      v.srcs.set(k, n);
    }
  }
  for (const [id, v] of voices) if (!seen.has(id)) { for (const n of v.srcs.values()) n?.stop(); v.n.osc?.stop(); v.n.out.disconnect(); voices.delete(id); }
}
function warmTempo(c) { // a kept-pitch speed's sound (its own copy of the clip's seconds), from the playhead on
  if (!c?.media || c.pitch || Math.abs(c.speed - 1) < 1e-6 || !M.get(c.media)?.hasAudio) return;
  const tempo = +c.speed.toFixed(4), sp = pcmSpan(c, tempo), at = (c.in - sp[0] + Math.max(0, S.t - c.start) * c.speed) / tempo;
  pcmChunk(c.media, tempo, Math.floor(at / PCM_S), sp, c.denoise);
}
function audioWarm() { // paused: the chunks at the playhead, so play starts with sound at once
  for (const [lane, list] of [['main', P.main], ['overlay', P.overlay], ['audio', P.audio]]) for (const c of list) {
    const m = M.get(c.media);
    // normal-pitch sound only: a kept-pitch speed's copy is made when it plays, not for every value a slider passes through
    if (m?.hasAudio && c.volume > 0 && (c.pitch || Math.abs(c.speed - 1) < 1e-6) && S.t >= c.start && S.t < c.start + tdur(c, lane)) pcmChunk(c.media, 1, Math.floor((c.in + (S.t - c.start) * c.speed) / PCM_S), undefined, c.denoise);
  }
}
const layerCv = [];
function layer(n) {
  const cv = $('#cv');
  const L = layerCv[n] ??= document.createElement('canvas');
  if (L.width !== cv.width || L.height !== cv.height) { L.width = cv.width; L.height = cv.height; }
  return L;
}
// blur transitions (the server's TR_BLUR): a slide or a dissolve, blurred most half way through (sin(pi p)), like the export
const TR_BLUR = { whipleft: 'slideleft', whipright: 'slideright', zoomblur: 'fade' }, WHIP = 0.04, ZOOMB = 0.25, ZB_K = 8;
function transition(ctx, A, B, type, p) { // per-pixel math of ffmpeg's xfade, whose progress P runs 1 -> 0
  const W = A.width, H = A.height, P1 = clamp(1 - p, 0, 1);
  if (TR_BLUR[type]) {
    transition(ctx, A, B, TR_BLUR[type], p);
    const s = Math.sin(Math.PI * clamp(p, 0, 1));
    if (type === 'zoomblur') zblurInPlace(ctx, W, H, ZOOMB * s); else hblurInPlace(ctx, W, H, WHIP * W * s);
    return;
  }
  ctx.save();
  if (type === 'fadeblack') { // mix(mix(a,black,ss(.8,1,P)), mix(black,b,ss(.2,1,P)), P) with black = 0
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = smoothstep(0.8, 1, P1) * P1; ctx.drawImage(A, 0, 0);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = (1 - smoothstep(0.2, 1, P1)) * (1 - P1); ctx.drawImage(B, 0, 0);
  } else if (type === 'wipeleft') { // x > W*P shows b
    ctx.drawImage(A, 0, 0);
    const z = Math.floor(W * P1) + 1;
    ctx.beginPath(); ctx.rect(z, 0, W - z, H); ctx.clip(); ctx.drawImage(B, 0, 0);
  } else if (type === 'slideleft') { // b enters from the right, a leaves to the left
    const z = Math.trunc(P1 * W);
    ctx.drawImage(A, z - W, 0); ctx.drawImage(B, z, 0);
  } else if (type === 'circleopen') { // b = 1 - smoothstep(0,1, r/R + (P-.5)*3), a soft radial reveal
    ctx.drawImage(A, 0, 0);
    const C = scratch(W, H, 'trc'), cx = C.getContext('2d'), R = Math.hypot(W / 2, H / 2), q = (P1 - 0.5) * 3;
    cx.globalCompositeOperation = 'copy'; cx.drawImage(B, 0, 0);
    const g = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R);
    for (let s = 0; s <= 16; s++) g.addColorStop(s / 16, `rgba(0,0,0,${1 - smoothstep(0, 1, s / 16 + q)})`);
    cx.globalCompositeOperation = 'destination-in'; cx.fillStyle = g; cx.fillRect(0, 0, W, H);
    cx.globalCompositeOperation = 'source-over';
    ctx.drawImage(C, 0, 0);
  } else if (type === 'zoomin') { // magnify a by 1/ss(.5,1,P), then cross-fade to b over the second half
    const zf = Math.max(smoothstep(0.5, 1, P1), 1 / W), sw = W * zf, sh = H * zf;
    ctx.drawImage(A, (W - sw) / 2, (H - sh) / 2, sw, sh, 0, 0, W, H);
    ctx.globalAlpha = 1 - smoothstep(0, 0.5, P1); ctx.drawImage(B, 0, 0);
  } else if (type === 'fadewhite') { // mix(mix(a,white,ss(.8,1,P)), mix(white,b,ss(.2,1,P)), P), summed with 'lighter'
    const s1 = smoothstep(0.8, 1, P1), s2 = smoothstep(0.2, 1, P1);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = s1 * P1; ctx.drawImage(A, 0, 0);
    ctx.globalAlpha = (1 - s2) * (1 - P1); ctx.drawImage(B, 0, 0);
    ctx.globalAlpha = (1 - s1) * P1 + s2 * (1 - P1); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  } else if (type === 'wiperight') { // x <= W*(1-P) shows b
    ctx.drawImage(A, 0, 0);
    const z = Math.trunc(W * (1 - P1)) + 1;
    ctx.beginPath(); ctx.rect(0, 0, z, H); ctx.clip(); ctx.drawImage(B, 0, 0);
  } else if (type === 'wipeup') { // y > H*P shows b
    ctx.drawImage(A, 0, 0);
    const z = Math.trunc(H * P1) + 1;
    ctx.beginPath(); ctx.rect(0, z, W, H - z); ctx.clip(); ctx.drawImage(B, 0, 0);
  } else if (type === 'wipedown') { // y <= H*(1-P) shows b
    ctx.drawImage(A, 0, 0);
    const z = Math.trunc(H * (1 - P1)) + 1;
    ctx.beginPath(); ctx.rect(0, 0, W, z); ctx.clip(); ctx.drawImage(B, 0, 0);
  } else if (type === 'slideright') { // b at -z, a at W-z
    const z = Math.trunc(P1 * W);
    ctx.drawImage(B, -z, 0); ctx.drawImage(A, W - z, 0);
  } else if (type === 'slideup') { // b at z, a at z-H
    const z = Math.trunc(P1 * H);
    ctx.drawImage(A, 0, z - H); ctx.drawImage(B, 0, z);
  } else if (type === 'slidedown') { // b at -z, a at H-z
    const z = Math.trunc(P1 * H);
    ctx.drawImage(B, 0, -z); ctx.drawImage(A, 0, H - z);
  } else if (type === 'circleclose') { // b*ss + a*(1-ss), ss = smoothstep(0,1, r/R + (0.5-P)*3)
    ctx.drawImage(B, 0, 0);
    const C = scratch(W, H, 'trc'), cx = C.getContext('2d'), R = Math.hypot(W / 2, H / 2), q = (0.5 - P1) * 3;
    cx.globalCompositeOperation = 'copy'; cx.drawImage(A, 0, 0);
    const g = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R);
    for (let s = 0; s <= 16; s++) g.addColorStop(s / 16, `rgba(0,0,0,${1 - smoothstep(0, 1, s / 16 + q)})`);
    cx.globalCompositeOperation = 'destination-in'; cx.fillStyle = g; cx.fillRect(0, 0, W, H);
    cx.globalCompositeOperation = 'source-over';
    ctx.drawImage(C, 0, 0);
  } else if (TR_MASK[type]) maskTr(ctx, A, B, TR_MASK[type], P1);
  else if (['dissolve', 'pixelize', 'hblur', 'fadegrays'].includes(type)) pixelTr(ctx, A, B, type, P1);
  else if (type === 'squeezeh' || type === 'squeezev') { // a squeezed into a band P wide through the middle, b around it
    ctx.drawImage(B, 0, 0);
    if (type === 'squeezeh' && H * P1 >= 1) ctx.drawImage(A, 0, (H - H * P1) / 2, W, H * P1);
    if (type === 'squeezev' && W * P1 >= 1) ctx.drawImage(A, (W - W * P1) / 2, 0, W * P1, H);
  } else { // fade: a*P + b*(1-P)
    ctx.drawImage(A, 0, 0); ctx.globalAlpha = 1 - P1; ctx.drawImage(B, 0, 0);
  }
  ctx.restore();
}
const srcFrame = (v, x) => Math.floor(x * (M.get(v.dataset.media)?.fps || P.fps) + 1e-3); // which of its file's frames a time shows
function sync(v, src, rate) { // the wall clock is the master; media elements follow it
  if (S.playing && S.stuck && v !== S.lead) { if (!v.paused) v.pause(); return; }
  if (S.playing) {
    const err = src - v.currentTime, pr = Math.min(16, rate * S.rate); // browsers stop at 16x; above that the clock keeps re-seeking the element
    if (v.playbackRate !== pr) v.playbackRate = pr; // (no steering by rate: AVPlayer's clock jumps at every rate change)
    if (v.paused) {
      if (v.ended || src >= v.duration - 0.02) return; // at its file's end: play() would start it again from 0, and the clock would follow it back
      if (Math.abs(err) > 0.05) v.currentTime = src; v._run = false; v._ct = v.currentTime; v.play().catch(() => {});
    }
    else if (Math.abs(err) > 0.3) v.currentTime = src;
    else if (v.currentTime !== v._ct) { v._ct = v.currentTime; v._run = true; } // really moving (a prerolled next cut)
  } else {
    if (!v.paused) v.pause();
    v._run = false;
    v._want = src; // waitFrame checks the element really got here
    // by source frame, not by half a project frame: in slow motion that tolerance spans source frames (0.25x showed the
    // wrong one and skipped some on frame steps). +1e-4: 5.3 - 5.0 = 0.29999…, and on a frame's edge WebKit shows the one before
    if (!v.seeking && srcFrame(v, v.currentTime) !== srcFrame(v, src)) v.currentTime = src + 1e-4;
  }
}
function paint() {
  if (S.hold) return;
  const V = !S.playing && (S.skim || S.src);
  if (V) return paintSource(V);
  // at (or past) the very end every clip has ended: show the last frame, not black (End, or play to the end)
  const cv = $('#cv'), ctx = cv.getContext('2d'), k = cv.width / P.w, end = total(), t = S.t < end ? S.t : Math.max(0, end - 0.5 / P.fps), live = new Set();
  const act = [];
  P.main.forEach((c, i) => { if (t >= c.start && t < c.start + tdur(c, 'main')) act.push(i); });
  const mi = act.length ? act[act.length - 1] : -1;
  const tr = act.length > 1 ? { type: P.main[act[0]].tr?.type || 'fade', p: clamp((t - P.main[act[1]].start) / (trF(act[0]) / P.fps), 0, 1) } : null;
  // an element per file and side: two alternate (the next cut pre-seeked, transitions show both), and a jump back to a
  // file already loaded finds it ready (keyed by side alone, every jump to another file reloaded it: 16-116 ms of black)
  const layers = act.map(i => ['main', P.main[i], `m${i % 2}${P.main[i].media}`, i]);
  for (const c of shown('overlay')) if (t >= c.start && t < c.start + len(c)) layers.push(['overlay', c, `o${c.id}`]);
  if (!S.playing) { // paused on a picture still loading: the last frame stays up until it's there ('loadeddata' / 'seeked' repaint)
    const need = layers.filter(([, c]) => M.get(c.media) && M.get(c.media).kind !== 'image')
      .map(([lane, c, key, i]) => {
        const el = vidFor(key, M.get(c.media));
        sync(el, c.in + (t - c.start) * c.speed, c.speed);
        if (lane === 'main' && i === mi) { S.lead = el; S.leadClip = c; } // the clock and play() go by the element that's coming, not the last one painted
        return el;
      });
    const pics = layers.filter(([, c]) => M.get(c.media)?.kind === 'image').map(([, c]) => imgFor(M.get(c.media)));
    S.pics = pics;
    if (need.some(el => el.readyState < 2 && el.getAttribute('src') && !el.error && performance.now() - (el._t0 ??= performance.now()) < 1500) // (not for ever: a broken file)
      || pics.some(i => !i.complete && performance.now() - (i._t0 ??= performance.now()) < 1500)) {
      S.live = new Set([...(S.live || []), ...need]); // waitFrame waits for these
      clearTimeout(paint.retry); paint.retry = setTimeout(() => { S.dirty = true; }, 100);
      return;
    }
  }
  hits = []; S.lead = null;
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  for (const [lane, c, key, i] of layers) {
    const m = M.get(c.media);
    if (!m) continue;
    let el;
    if (m.kind === 'image') el = imgFor(m);
    else { el = vidFor(key, m); live.add(el); if (lane === 'main' && i === mi) { S.lead = el; S.leadClip = c; } sync(el, c.in + (t - c.start) * c.speed, c.speed); }
    if (lane === 'overlay' && P.mute.overlay) continue;
    if (tr && lane === 'main') { // each side renders its full frame into a layer, then the transition composites them
      const L = layer(i === act[0] ? 0 : 1), lx = L.getContext('2d');
      lx.fillStyle = P.bg; lx.fillRect(0, 0, L.width, L.height);
      drawMedia(lx, lane, c, m, el, t - c.start, k);
      if (i === act[1]) transition(ctx, layer(0), L, tr.type, tr.p);
    } else drawMedia(ctx, lane, c, m, el, t - c.start, k);
  }
  const nx = mi >= 0 && P.main[mi + 1], nm = nx && M.get(nx.media);
  if (nm && nm.kind !== 'image' && nx.start - t < 1.5) {
    const v = vidFor(`m${(mi + 1) % 2}${nx.media}`, nm), lead = nx.start - t, PRE = 0.3;
    if (!live.has(v)) {
      live.add(v);
      // playing: the next cut's element starts PRE early (unseen), so at the cut it's already running in step and the
      // clock needn't wait for it to start (that wait was a gap in the sound at every cut)
      if (S.playing && lead <= PRE && nx.in - lead * nx.speed >= 0) sync(v, nx.in - lead * nx.speed, nx.speed);
      else {
        const at = S.playing ? Math.max(0, nx.in - PRE * nx.speed) : nx.in;
        if (!v.paused) v.pause();
        v._want = at;
        if (!v.seeking && Math.abs(v.currentTime - at) > 0.04) v.currentTime = at;
      }
    }
  }
  for (const v of pool.values()) if (!live.has(v) && !v.paused) v.pause();
  S.live = live;
  fxPixels(ctx, t);
  drawTexts(ctx, t, k, true);
  const mp = S.maskPreview, mh = mp && Math.abs(t - mp.T) < 0.5 / P.fps && hits.find(q => q.id === mp.id);
  if (mh) overlayMask(ctx, mp, mh); // what Best removal (or a cutout) will take, on the frame it was drawn on
  if (S.pickRect) {
    const R = S.pickRect, d = devicePixelRatio || 1;
    ctx.save(); ctx.strokeStyle = '#3dff8b'; ctx.lineWidth = 2 * d; ctx.setLineDash([5 * d, 4 * d]);
    ctx.strokeRect(R.x * k, R.y * k, R.w * k, R.h * k); ctx.restore();
  }
  const sel = selection(), byId = new Map(hits.map(q => [q.id, q]));
  for (const [x, lane] of sel) { // the selection: a box that turns with the clip, with handles when one clip is selected
    const h = byId.get(x.id);
    if (h) drawSel(ctx, h, sel.length === 1 && canHandle(lane));
  }
  if (S.guides) { // dragged text is snapped: the line it snapped to
    const d = devicePixelRatio || 1, { x: gx, y: gy } = S.guides;
    ctx.save(); ctx.strokeStyle = '#ff3d9a'; ctx.lineWidth = 1 * d; ctx.beginPath();
    if (gx != null) { ctx.moveTo(gx * P.w * k, 0); ctx.lineTo(gx * P.w * k, cv.height); }
    if (gy != null) { ctx.moveTo(0, gy * P.h * k); ctx.lineTo(cv.width, gy * P.h * k); }
    ctx.stroke(); ctx.restore();
  }
  if (!S.playing) audioWarm();
  if (G.tab === 'script') scriptNow(t);
  if (SCOPE.on) drawScope();
  $('#tc').textContent = `${tc(S.t)} / ${tc(S.playing ? S.end : end)}`;
  const vh = !S.playing && $('#vkHere'), vc = vh && selClip(); // the volume-point slider follows the playhead
  if (vc && document.activeElement !== vh) { const x = +dB(envAt(vc, clamp(t - vc.start, 0, len(vc)))).toFixed(1); if (+vh.value !== x) { vh.value = x; fill(vh); vh.nextElementSibling.textContent = fmt(x, 'dB'); } }
}
function drawMedia(ctx, lane, c, m, el, lt, k) {
  if (el.tagName === 'VIDEO' ? el.readyState < 2 : !(el.complete && el.naturalWidth)) return;
  const d = tdur(c, lane), pr = clipAnim(c, lt, d, propsAt(c, lt)), g = geom(m, c, P.w, P.h, pr), a = c.adj || {}, cr = c.crop || {};
  const f = fadeAt(c, lt, d);
  const vw = el.videoWidth || el.naturalWidth, vh = el.videoHeight || el.naturalHeight, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0);
  const lm = lookMatrix(c); // same order and math as the server's adjust() then look()
  const ab = a.b ?? 1, ac = a.c ?? 1, as = a.s ?? 1, tn = toneLUT(c); // same order as the export: adjust, tone curve, look
  const filt = [ab !== 1 || ac !== 1 || as !== 1 ? `brightness(${ab}) contrast(${ac}) saturate(${as})` : '', tn ? toneFilter(tn) : '', lm ? lookFilter(lm) : ''].filter(Boolean).join(' ');
  const rad = ((pr.rot || 0) * Math.PI) / 180, graded = gradeOn(c.grade) || !!c.lkf?.length || c.beauty?.amt > 0 || a.blur > 0, sk = strengthAt(c, lt);
  const draw = (x, y, w, h, fgr = true) => { // crop = source rect; mirror flips inside the rect; rotation spins about its centre
    ctx.save();
    if (fgr && rad) { ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rad); ctx.translate(-(x + w / 2), -(y + h / 2)); }
    const blendVid = lane === 'overlay' && c.blend && c.blend !== 'normal' && el.tagName === 'VIDEO'; // WebKit draws a <video> as plain source-over, whatever the blend mode: blend from a canvas
    if (fgr && (c.key || c.mask || a.vig > 0 || graded || mbN(c) > 1 || (filt && (!CANVAS_FILTER || gpu())) || blendVid)) { // needs pixels: colour + mirror + key + mask + vignette (one GPU pass; by hand without one)
      const oc = offscreen(el, c, [(cr.l || 0) * vw, (cr.t || 0) * vh, fx * vw, fy * vh], w, h, filt, lt);
      ctx.filter = 'none'; glowDraw(ctx, c, h, () => ctx.drawImage(oc, x, y, w, h)); ctx.restore();
      return;
    }
    if (c.flip) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }
    glowDraw(ctx, c, fgr ? h : 0, () => ctx.drawImage(el, (cr.l || 0) * vw, (cr.t || 0) * vh, fx * vw, fy * vh, x, y, w, h));
    ctx.restore();
  };
  ctx.save();
  if (lane === 'main' && c.fit === 'blur') {
    const mw = m.w * fx, mh = m.h * fy, s = Math.max(P.w / mw, P.h / mh) * 1.08, r = (P.w / 40) * k;
    const bx = ((P.w - mw * s) / 2) * k, by = ((P.h - mh * s) / 2) * k, bw = mw * s * k, bh = mh * s * k;
    if (CANVAS_FILTER && !graded && !gpu()) { ctx.filter = `${filt} blur(${r}px)`.trim(); draw(bx, by, bw, bh, false); }
    else { // no ctx.filter: the export's 3 box blurs, run at 1/(r/4) size (radius 4 there) and scaled back up
      const q = Math.max(1, r / 4), tw = Math.max(2, Math.round(bw / q)), th = Math.max(2, Math.round(bh / q)), tx = blurCv.getContext('2d', { willReadFrequently: true });
      if (blurCv.width !== tw || blurCv.height !== th) { blurCv.width = tw; blurCv.height = th; }
      const gp = (filt || graded) && gpuPass(el, [(cr.l || 0) * vw, (cr.t || 0) * vh, fx * vw, fy * vh], tw, th, { ...c, flip: false }, { k: sk, mask: null, noKey: true, noVig: true });
      if (gp) { tx.clearRect(0, 0, tw, th); tx.drawImage(gp[0], 0, gp[1], tw, th, 0, 0, tw, th); }
      else { tx.drawImage(el, (cr.l || 0) * vw, (cr.t || 0) * vh, fx * vw, fy * vh, 0, 0, tw, th); if (filt || graded) colorPass(tx, tw, th, c, sk); }
      boxBlurRGB(tx, tw, th, Math.max(1, Math.round(r / q)));
      ctx.imageSmoothingQuality = 'high'; ctx.drawImage(blurCv, bx, by, bw, bh);
    }
  }
  ctx.filter = gpu() || graded ? 'none' : filt || 'none'; // the GPU pass (or offscreen) has done the colour
  if (lane === 'overlay') { ctx.globalAlpha = pr.opacity * f; if (c.blend && c.blend !== 'normal') ctx.globalCompositeOperation = c.blend; }
  else if (pr.opacity < 1) ctx.globalAlpha = pr.opacity; // main clips fade over the canvas colour, as in the export
  draw(g.x * k, g.y * k, g.w * k, g.h * k);
  ctx.restore();
  if (lane === 'main' && f < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - f})`; ctx.fillRect(0, 0, P.w * k, P.h * k); } // ffmpeg fade = to black
  hits.push({ lane, id: c.id, x0: g.x * k, y0: g.y * k, x1: (g.x + g.w) * k, y1: (g.y + g.h) * k, rot: pr.rot || 0 });
}
const blurCv = document.createElement('canvas');
function glowDraw(ctx, c, h, draw) { // a cutout's glow: canvas shadow (a Gaussian of its alpha, sigma = shadowBlur / 2), like the export's gblur
  if (!c.glow || !h) return draw();
  ctx.shadowColor = c.glow.color; ctx.shadowBlur = 2 * c.glow.size * 0.04 * h; ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
  for (let i = 0; i < (c.glow.neon ? 2 : 1); i++) draw(); // neon: the glow twice as strong
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  if (c.glow.neon) draw(); // the person itself once more, on top of the doubled glow
}
function blurInPlace(x, W, H, r) { // the export's boxblur (3 passes), run small (radius 4 there) and scaled back: ffmpeg's blur at a fraction of the cost
  // and never over ~480 px wide in JS: a small blur ran at full size (11-12 fps at 1080p)
  const q = Math.max(1, r / 4, Math.max(W, H) / 480), tw = Math.max(2, Math.round(W / q)), th = Math.max(2, Math.round(H / q)), rr = Math.max(1, Math.round(r / q));
  if (gpu()) { // the same box passes on the GPU: no read-back of the frame (that alone was 10-20 ms)
    const s = scratch(tw, th, 'cblurg'), sx = s.getContext('2d');
    sx.globalCompositeOperation = 'copy'; sx.drawImage(x.canvas, 0, 0, tw, th);
    const g = fxGPU(s, tw, th, [0, 1, 2].flatMap(() => [{ mode: 5, dir: [1, 0], r: rr }, { mode: 5, dir: [0, 1], r: rr }]));
    if (g) { x.save(); x.globalCompositeOperation = 'source-atop'; x.imageSmoothingQuality = 'high'; x.drawImage(g[0], 0, g[1], tw, th, 0, 0, W, H); x.restore(); return; }
  }
  const t = scratch(tw, th, 'cblur'), tx = t.getContext('2d', { willReadFrequently: true });
  tx.clearRect(0, 0, tw, th); tx.drawImage(x.canvas, 0, 0, tw, th);
  boxBlurRGB(tx, tw, th, rr);
  x.save(); x.globalCompositeOperation = 'source-atop'; x.imageSmoothingQuality = 'high'; x.drawImage(t, 0, 0, W, H); x.restore();
}
function hblurInPlace(x, W, H, sigma) { // the export's gblur sigmaV=0 (sideways only), close to it, on 2D canvases only (3 box passes through
  // fxGPU matched as well but cost 9 ms a frame in WebKit, the canvas upload and read-back: whips dropped to 45 fps). Halved k times (an
  // exact 2:1 shrink averages pixel pairs; WebKit's one-step shrink skips pixels), stretched back (bilinear: a tent), variance f²/4 with
  // f = 2^k; what is still missing comes from a 1/4 1/2 1/4 smear of the narrow copy (variance d²/2)
  const k = Math.floor(Math.log2(2 * sigma));
  if (k < 1) return; // under a pixel or so
  const cv = [scratch(W, H, 'hblurA'), scratch(W, H, 'hblurB')]; // fixed canvases, drawn into their left part (one per width churned the scratch cache)
  let src = x.canvas, w = W;
  for (let i = 0; i < k && w > 2; i++) {
    const nw = Math.round(w / 2), s = cv[i % 2], sx = s.getContext('2d');
    sx.globalCompositeOperation = 'copy'; sx.imageSmoothingQuality = 'low'; sx.drawImage(src, 0, 0, w, H, 0, 0, nw, H);
    src = s; w = nw;
  }
  const f = W / w, d = Math.sqrt(Math.max(0, 2 * (sigma * sigma - (f * f) / 4))) / f; // the rest, in narrow pixels
  if (d > 0.05) {
    const s = src === cv[0] ? cv[1] : cv[0], sx = s.getContext('2d');
    sx.globalCompositeOperation = 'copy'; sx.globalAlpha = 1; sx.drawImage(src, 0, 0, w, H, 0, 0, w, H);
    sx.globalCompositeOperation = 'source-over'; sx.globalAlpha = 1 / 3; sx.drawImage(src, 0, 0, w, H, -d, 0, w, H);
    sx.globalAlpha = 1 / 4; sx.drawImage(src, 0, 0, w, H, d, 0, w, H); sx.globalAlpha = 1;
    src = s;
  }
  x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'copy'; x.imageSmoothingQuality = 'low';
  x.drawImage(src, 0, 0, w, H, 0, 0, W, H);
  x.restore();
}
function zblurInPlace(x, W, H, z) { // zoom blur, like the server's zoom_blur(): ZB_K copies zoomed 1 .. 1+z about the centre, averaged
  if (z < 1e-3) return;
  const C = scratch(W, H, 'zblur'), c = C.getContext('2d');
  c.globalCompositeOperation = 'copy'; c.drawImage(x.canvas, 0, 0); c.globalCompositeOperation = 'source-over';
  x.save(); x.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 1; i < ZB_K; i++) { const k = 1 + (z * i) / (ZB_K - 1), w = W * k, h = H * k; x.globalAlpha = 1 / (i + 1); x.drawImage(C, (W - w) / 2, (H - h) / 2, w, h); } // a running mean
  x.restore();
}
function colorPass(x, W, H, c, mixK = 1) { // the GPU pass's colour on the CPU (no WebGL2): brightness, contrast, saturate, tone, look, grade LUT, strength
  const a = c.adj || {}, b = a.b ?? 1, k = a.c ?? 1, s = a.s ?? 1, L = lookMatrix(c), T = toneLUT(c), GR = gradeLUT(c), q = v => (v < 0 ? 0 : v > 255 ? 255 : v), r8 = v => Math.round(q(v));
  const M = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  const img = x.getImageData(0, 0, W, H), d = img.data, Gd = GR && { n: GN, d: GR.d };
  for (let i = 0; i < d.length; i += 4) {
    const r = q((q(d[i] * b) - 127.5) * k + 127.5), g = q((q(d[i + 1] * b) - 127.5) * k + 127.5), u = q((q(d[i + 2] * b) - 127.5) * k + 127.5);
    let R = q(M[0] * r + M[1] * g + M[2] * u), G = q(M[3] * r + M[4] * g + M[5] * u), B = q(M[6] * r + M[7] * g + M[8] * u);
    if (T) { R = T[Math.round(R)]; G = T[Math.round(G)]; B = T[Math.round(B)]; }
    if (L) { const R2 = L[0] * R + L[1] * G + L[2] * B, G2 = L[3] * R + L[4] * G + L[5] * B; B = L[6] * R + L[7] * G + L[8] * B; R = R2; G = G2; }
    if (GR || mixK !== 1) {
      R = r8(R); G = r8(G); B = r8(B);
      if (Gd) { const o = sampleLUT(Gd, R / 255, G / 255, B / 255); R = r8(o[0] * 255); G = r8(o[1] * 255); B = r8(o[2] * 255); }
      R = d[i] + (R - d[i]) * mixK; G = d[i + 1] + (G - d[i + 1]) * mixK; B = d[i + 2] + (B - d[i + 2]) * mixK;
    }
    d[i] = R; d[i + 1] = G; d[i + 2] = B; // Uint8ClampedArray clamps and rounds
  }
  x.putImageData(img, 0, 0);
}
function boxBlurRGB(x, W, H, r) { // ffmpeg boxblur=r:3 by hand: 3 running-sum box passes each way, edges clamped
  const img = x.getImageData(0, 0, W, H), d = img.data, n = 2 * r + 1, a = new Float32Array(W * H), t = new Float32Array(W * H);
  const box = (src, dst, len, step, lines, lineStep) => {
    for (let l = 0; l < lines; l++) {
      const o = l * lineStep, at = i => src[o + (i < 0 ? 0 : i >= len ? len - 1 : i) * step];
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < len; i++) { dst[o + i * step] = sum / n; sum += at(i + r + 1) - at(i - r); }
    }
  };
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + ch];
    for (let p = 0; p < 3; p++) { box(a, t, W, 1, H, W); box(t, a, H, W, W, 1); }
    for (let i = 0; i < a.length; i++) d[i * 4 + ch] = a[i];
  }
  x.putImageData(img, 0, 0);
}
function featherAlpha(x, W, H, sigma) { // maskCanvas's blur(sigma) by hand: 3 box blurs ~ a Gaussian, on alpha (the mask is white)
  const img = x.getImageData(0, 0, W, H), d = img.data, a = new Float32Array(W * H), t = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)), n = 2 * r + 1;
  const box = (src, dst, len, step, lines, lineStep) => { // running sum along one axis, edges clamped
    for (let l = 0; l < lines; l++) {
      const o = l * lineStep, at = i => src[o + (i < 0 ? 0 : i >= len ? len - 1 : i) * step];
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < len; i++) { dst[o + i * step] = sum / n; sum += at(i + r + 1) - at(i - r); }
    }
  };
  for (let p = 0; p < 3; p++) { box(a, t, W, 1, H, W); box(t, a, H, W, W, 1); }
  for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = a[i]; }
  x.putImageData(img, 0, 0);
}
const keyCv = document.createElement('canvas'), keyCvG = document.createElement('canvas'), hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function mbFill(c, src, w, h, filt, lt, j, miss) { // paused: draw the motion-blurred clip's frames before the playhead into its held ones
  const key = `${c.id}:${j}:${w}x${h}:${mbSig(c)}`;
  if (S.mbFill || mbFill.last === key) return; // one at a time (the repaint after it asks again for what is still missing), once per frame (a broken file)
  mbFill.last = key;
  const m = M.get(c.media), v = vidFor('mbfill', m);
  S.mbFill = (async () => {
    for (const k of miss) {
      const lk = Math.max(0, lt - (j - k) / P.fps), at = c.in + lk * c.speed; // that frame, at the same point in it as the playhead
      if (v.readyState < 2 || srcFrame(v, v.currentTime) !== srcFrame(v, at)) v.currentTime = at + 1e-4;
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && !(v.readyState >= 2 && !v.seeking && srcFrame(v, v.currentTime) === srcFrame(v, at))) await sleep(15);
      await sleep(40); // WebKit hands drawImage the new frame a moment after 'seeked'
      if (S.playing) break;
      offscreen(v, c, src, w, h, filt, lk, k);
    }
  })().finally(() => { S.mbFill = null; S.dirty = true; });
}
function offscreen(el, c, src, w, h, filt, lt = 0, store = null) { // colour + mirror, then chroma key (colorkey's formula) x mask, vignette, like the export
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  if (keyCv.width !== W || keyCv.height !== H) { keyCv.width = W; keyCv.height = H; }
  const x = keyCv.getContext('2d', { willReadFrequently: true });
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, W, H);
  const sk = strengthAt(c, lt), mk = maskAt(c, lt), N = mbN(c);
  let gp = gpuPass(el, src, W, H, c, { k: sk, mask: mk }); // Apple GPU: one shader pass instead of per-pixel JavaScript
  if (gp && N > 1) { // motion blur: this frame and the clip's N-1 before it, mixed on the GPU (store: only keep this one, for mbFill)
    const j = store ?? clipFrame(c, lt), r = gpuMotion(c.id, mbSig(c), j, N, W, H, store != null);
    if (store != null) return null;
    if (r) { gp = r.gp; if (r.miss.length && !S.playing) mbFill(c, src, w, h, filt, lt, j, r.miss); }
  }
  if (gp) { // kept on the GPU: drawn into keyCv (CPU-backed, for the by-hand path below) every graded frame was read back, 10-20 ms
    if (keyCvG.width !== W || keyCvG.height !== H) { keyCvG.width = W; keyCvG.height = H; }
    const g = keyCvG.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none'; g.globalCompositeOperation = 'copy'; g.drawImage(gp[0], 0, gp[1], W, H, 0, 0, W, H); g.globalCompositeOperation = 'source-over';
    if (c.adj?.blur > 0) blurInPlace(g, W, H, c.adj.blur * 0.03 * Math.min(W, H));
    return keyCvG;
  }
  x.filter = gradeOn(c.grade) || c.lkf?.length ? 'none' : filt || 'none';
  if (c.flip) { x.translate(W, 0); x.scale(-1, 1); }
  x.drawImage(el, ...src, 0, 0, W, H);
  x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none';
  if ((filt && !CANVAS_FILTER) || gradeOn(c.grade) || c.lkf?.length) colorPass(x, W, H, c, sk);
  if (c.key) { // alpha *= clip((dist - similarity) / blend)
    const img = x.getImageData(0, 0, W, H), d = img.data, [kr, kg, kb] = hexRgb(c.key.color), sim = c.key.sim, bl = c.key.blend;
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb, diff = Math.sqrt((dr * dr + dg * dg + db * db) / 195075);
      d[i + 3] *= bl > 0.0001 ? clamp((diff - sim) / bl, 0, 1) : diff > sim ? 1 : 0;
    }
    x.putImageData(img, 0, 0);
  }
  if (mk) { x.globalCompositeOperation = 'destination-in'; x.drawImage(maskCanvas(mk, W, H), 0, 0); x.globalCompositeOperation = 'source-over'; }
  if (c.adj?.vig > 0) { // vignette: RGB x the multiplier map, alpha untouched (the export multiplies by the same map as a PNG)
    const img = x.getImageData(0, 0, W, H), d = img.data, mm = vigMap(c.adj.vig, W, H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { d[i] *= mm[j]; d[i + 1] *= mm[j]; d[i + 2] *= mm[j]; }
    x.putImageData(img, 0, 0);
  }
  return keyCv;
}
const MKF = ['x', 'y', 'w', 'h', 'rot', 'feather'];
function maskAt(c, lt) { // the mask at clip time lt: its keyframes (c.mkf) interpolated linearly, or the mask as set
  const k = c.mkf, mk = c.mask;
  if (!mk || !k?.length) return mk;
  let a = k[0], b = k[0], u = 0;
  if (lt >= k.at(-1).t) a = b = k.at(-1);
  else if (lt > k[0].t) for (let i = 0; i + 1 < k.length; i++) if (lt < k[i + 1].t) { a = k[i]; b = k[i + 1]; u = (lt - a.t) / Math.max(1e-6, b.t - a.t); break; }
  const o = { ...mk };
  for (const p of MKF) o[p] = +((a[p] ?? mk[p]) + ((b[p] ?? mk[p]) - (a[p] ?? mk[p])) * u).toFixed(5);
  return o;
}
function maskPoint(c) { // the mask keyframe under the playhead (added, from the mask there, if missing)
  const lt = snap(clamp(S.t - c.start, 0, len(c)));
  let f = c.mkf.find(x => Math.abs(x.t - lt) < 0.5 / P.fps);
  if (!f) { const m = maskAt(c, lt); f = { t: +lt.toFixed(4), ...Object.fromEntries(MKF.map(p => [p, m[p]])) }; c.mkf.push(f); c.mkf.sort((a, b) => a.t - b.t); }
  return f;
}
const maskCache = new Map();
function maskCanvas(mk, w, h) { // white = keep. Same drawing for the preview and the exported mask PNG
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h)), key = `${W}x${H}${JSON.stringify(mk)}`;
  if (maskCache.has(key)) return maskCache.get(key);
  const cv = new OffscreenCanvas(W, H), x = cv.getContext('2d'), big = 4 * Math.hypot(W, H);
  const rw = (mk.w * W) / 2, rh = (mk.h * H) / 2, f = mk.feather * Math.min(W, H);
  x.fillStyle = '#fff';
  if (f > 0.5) x.filter = `blur(${f}px)`;
  x.translate(W * (0.5 + mk.x), H * (0.5 + mk.y)); x.rotate((mk.rot * Math.PI) / 180);
  x.beginPath();
  if (mk.type === 'circle') x.ellipse(0, 0, Math.max(1, rw), Math.max(1, rh), 0, 0, Math.PI * 2);
  else if (mk.type === 'rect') x.rect(-rw, -rh, rw * 2, rh * 2);
  else if (mk.type === 'linear') x.rect(-big, 0, big * 2, big); // keep everything below the line
  else x.rect(-big, -rh, big * 2, rh * 2); // mirror: a band through the centre
  x.fill();
  if (f > 0.5 && !CANVAS_FILTER) { x.setTransform(1, 0, 0, 1, 0, 0); featherAlpha(x, W, H, f); } // the exported mask PNG is drawn here too
  if (mk.invert) { x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none'; x.globalCompositeOperation = 'xor'; x.fillRect(0, 0, W, H); }
  if (maskCache.size > 12) maskCache.delete(maskCache.keys().next().value);
  maskCache.set(key, cv);
  return cv;
}
async function maskPNG(c, m, mk = c.mask, side = 1280) { // export: opaque greyscale (luma -> alpha via alphamerge) at the cropped source aspect
  const cr = c.crop || {}, mw = m.w * (1 - (cr.l || 0) - (cr.r || 0)), mh = m.h * (1 - (cr.t || 0) - (cr.b || 0)), s = Math.min(1, side / Math.max(mw, mh));
  const W = Math.round(mw * s), H = Math.round(mh * s), cv = new OffscreenCanvas(W, H), x = cv.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.drawImage(maskCanvas(mk, W, H), 0, 0);
  return blobURL(await cv.convertToBlob({ type: 'image/png' }));
}
async function maskSeq(c, m) { // keyframed mask: one PNG per frame where it changes (repeats reused), as runs of frames
  const n = frames(c), pngs = [], seen = new Map(), spans = [];
  for (let f = 0; f < n; f++) {
    const mk = maskAt(c, f / P.fps), key = JSON.stringify(mk);
    let i = seen.get(key);
    if (i === undefined) { i = pngs.push(await maskPNG(c, m, mk, 720)) - 1; seen.set(key, i); }
    const last = spans.at(-1);
    if (last && last.i === i) last.n++; else spans.push({ i, n: 1 });
  }
  return { pngs, spans };
}

// ---------- video effects (the Effects track) ----------
// px(): steps the export runs on the composite (same numbers here and in ffmpeg); layer(): drawn into the text layer, so it renders exactly as previewed.
// rate: how often a layer changes: 'frame', n per second, 'edges' (animated only near its ends) or 0 (static).
const rnd = (i, s = 0) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); }; // deterministic noise: preview and export agree
const ID3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const lerpM = (A, B, t) => A.map((v, i) => v + (B[i] - v) * t);
const fxFrame = lt => Math.floor(lt * P.fps + 1e-6);
const clock = s => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const FX_CATS = [['all', 'All'], ['camera', 'Camera'], ['light', 'Light'], ['retro', 'Retro'], ['distort', 'Distort'], ['party', 'Party'], ['frame', 'Frame']];
function beatTimes() { const out = []; for (const a of P.audio) for (const b of a.beats || []) if (b >= a.in && b <= a.out) out.push(a.start + (b - a.in) / a.speed); return out.sort((x, y) => x - y); }
function sinceBeat(f, lt) { // beat zoom follows detected beats (Audio > Detect beats), else 120 BPM from the effect's start
  const t = f.start + lt, b = f.gallery ? [] : beatTimes().filter(x => x <= t + 1e-6 && x >= f.start - 0.6);
  return b.length ? t - b.at(-1) : lt % 0.5;
}
const shake = (a, fx, fy) => (W, H, u, lt, f) => { const s = a * f.amt; return [{ op: 'transform', z: 1 + 2 * s + 0.01, x: W * s * wob(lt * fx), y: H * s * wob(lt * fy + 5) }]; };
function particles(n, fn) { for (let i = 0; i < n; i++) fn(i); }
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
const fxOn = (f, t) => t >= f.start && t < f.start + f.dur;
function drawFxLayers(ctx, t, k) { // effect overlays: under the text, in the text layer (preview and export draw them the same way)
  if (P.mute.fx) return;
  const W = P.w * k, H = P.h * k, u = Math.min(W, H) / 1080;
  for (const f of shown('fx')) if (fxOn(f, t) && FX[f.fx]?.layer) { ctx.save(); FX[f.fx].layer(ctx, W, H, u, t - f.start, f); ctx.restore(); }
}
function fxPixels(ctx, t) { // effect steps on what is on the canvas so far (video and overlays)
  if (P.mute.fx) return;
  const W = ctx.canvas.width, H = ctx.canvas.height, u = Math.min(W, H) / 1080;
  // every active effect's steps in one list, in order: a run of per-pixel steps across effects is one GPU pass, not one each
  runOps(ctx, W, H, shown('fx').filter(f => fxOn(f, t) && FX[f.fx]?.px).flatMap(f => FX[f.fx].px(W, H, u, t - f.start, f)));
}
const scratchCv = new Map();
function scratch(W, H, tag) { // reusable offscreen canvases, one per size and purpose
  const key = `${tag}:${W}x${H}`;
  let c = scratchCv.get(key);
  if (!c) { c = document.createElement('canvas'); c.width = W; c.height = H; scratchCv.set(key, c); if (scratchCv.size > 64) scratchCv.delete(scratchCv.keys().next().value); }
  return c;
}
function blurred(C, W, H, sigma) { // Gaussian blur of a canvas (ctx.filter where there is one; WebKit: down- and up-scaling, close to it)
  const B = scratch(W, H, 'fxb'), b = B.getContext('2d');
  b.globalCompositeOperation = 'copy';
  if (CANVAS_FILTER) { b.filter = `blur(${sigma}px)`; b.drawImage(C, 0, 0); b.filter = 'none'; }
  else {
    const f = Math.max(1, sigma / 1.6), w = Math.max(1, Math.round(W / f)), h = Math.max(1, Math.round(H / f)), T = scratch(w, h, 'fxt'), tx = T.getContext('2d');
    tx.globalCompositeOperation = 'copy'; tx.imageSmoothingQuality = 'high'; tx.drawImage(C, 0, 0, w, h);
    b.imageSmoothingQuality = 'high'; b.drawImage(T, 0, 0, W, H);
  }
  b.globalCompositeOperation = 'source-over';
  return B;
}
function matrixPass(x, W, H, m) { // a 3x3 colour matrix, like colorchannelmixer
  const img = x.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = m[0] * r + m[1] * g + m[2] * b; d[i + 1] = m[3] * r + m[4] * g + m[5] * b; d[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
  x.putImageData(img, 0, 0);
}
function runOps(x, W, H, ops) { // the export's effect steps, on a canvas: same order, same numbers
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (FX_GPU[o.op]) { // a run of per-pixel steps in one go on the GPU (fxGPU), drawn back once
      let j = i;
      while (FX_GPU[ops[j + 1]?.op]) j++;
      const g = fxGPU(x.canvas, W, H, ops.slice(i, j + 1).flatMap(q => FX_GPU[q.op](q)));
      if (g) { x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'copy'; x.drawImage(g[0], 0, g[1], W, H, 0, 0, W, H); x.restore(); i = j; continue; }
    }
    if (o.op === 'negate') { x.save(); x.globalCompositeOperation = 'difference'; x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.restore(); continue; }
    if (o.op === 'matrix') { matrixPass(x, W, H, o.m.map(v => v * (o.k ?? 1))); continue; }
    if (o.op === 'hblur') { hblurInPlace(x, W, H, o.sigma); continue; }
    if (o.op === 'zblur') { zblurInPlace(x, W, H, o.s); continue; }
    if (['mirror', 'grid', 'transform', 'glow', 'blur'].includes(o.op)) {
      const C = scratch(W, H, 'fxc'), c = C.getContext('2d');
      c.globalCompositeOperation = 'copy'; c.drawImage(x.canvas, 0, 0); c.globalCompositeOperation = 'source-over';
      x.save();
      if (o.op === 'mirror') { const w2 = Math.floor(W / 2); x.translate(W, 0); x.scale(-1, 1); x.drawImage(C, 0, 0, w2, H, 0, 0, w2, H); } // right half = the left half, flipped
      else if (o.op === 'grid') { const w2 = Math.floor(W / 2), h2 = Math.floor(H / 2); for (const [a, b] of [[0, 0], [w2, 0], [0, h2], [w2, h2]]) x.drawImage(C, a, b, w2, h2); }
      else if (o.op === 'transform') { const sw = 2 * Math.trunc(W * o.z / 2), sh = sw * H / W; x.drawImage(C, (W - sw) / 2 + o.x, (H - sh) / 2 + o.y, sw, sh); }
      else { const B = blurred(C, W, H, o.sigma); if (o.op === 'blur') x.globalCompositeOperation = 'copy'; else { x.globalCompositeOperation = 'screen'; x.globalAlpha = o.amt; } x.drawImage(B, 0, 0); }
      x.restore();
      continue;
    }
    const img = x.getImageData(0, 0, W, H), d = img.data;
    if (o.op === 'rgbshift') { // red and blue planes moved sideways, edges smeared (rgbashift)
      const s = new Uint8ClampedArray(d);
      for (let y = 0; y < H; y++) for (let xx = 0, i = y * W * 4, r = y * W; xx < W; xx++, i += 4) { d[i] = s[(r + clamp(xx - o.rh, 0, W - 1)) * 4]; d[i + 2] = s[(r + clamp(xx - o.bh, 0, W - 1)) * 4 + 2]; }
    } else if (o.op === 'pixelize') { // block averages from the top-left, like pixelize
      const n = o.size;
      for (let by = 0; by < H; by += n) for (let bx = 0; bx < W; bx += n) {
        const bw = Math.min(n, W - bx), bh = Math.min(n, H - by), c = [0, 0, 0];
        for (let y = by; y < by + bh; y++) for (let xx = bx, i = (y * W + bx) * 4; xx < bx + bw; xx++, i += 4) { c[0] += d[i]; c[1] += d[i + 1]; c[2] += d[i + 2]; }
        const q = bw * bh, r = Math.floor(c[0] / q), g = Math.floor(c[1] / q), b = Math.floor(c[2] / q); // pixelize truncates
        for (let y = by; y < by + bh; y++) for (let xx = bx, i = (y * W + bx) * 4; xx < bx + bw; xx++, i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; }
      }
    } else if (o.op === 'noise') { // grain on brightness (the export adds random noise to luma)
      for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 2 - 1) * o.s; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
    }
    x.putImageData(img, 0, 0);
  }
}
function addEffect(type, start = S.t, dur, amt = 1) {
  const d = FX[type];
  if (!d) throw new Error(`effect must be one of ${Object.keys(FX).join(', ')}`);
  let c;
  change(() => { c = { id: hex12(), fx: type, start: snap(Math.max(0, start)), dur: Math.max(1 / P.fps, snap(dur ?? d.d)), amt: clamp(+amt || 1, 0.1, 2) }; P.fx.push(c); S.sel = { lane: 'fx', id: c.id }; });
  return c;
}
function fxPlan(w, h) { // the effect steps for the export, sampled at every frame they cover (on the frame grid, as the preview shows them)
  const out = [], u = Math.min(w, h) / 1080, nF = Math.round(total() * P.fps);
  if (P.mute.fx) return out;
  for (const f of shown('fx')) {
    const d = FX[f.fx], a = Math.ceil(f.start * P.fps - 1e-6), b = Math.min(nF, Math.ceil((f.start + f.dur) * P.fps - 1e-6));
    if (!d?.px || b <= a) continue;
    const per = [];
    for (let i = a; i < b; i++) per.push(d.px(w, h, u, i / P.fps - f.start, f));
    per[0].forEach((o, j) => {
      const step = { op: o.op, a, b };
      for (const key of Object.keys(o)) if (key !== 'op') { const vals = per.map(s => s[j][key]), one = JSON.stringify(vals[0]); step[key] = vals.every(v => JSON.stringify(v) === one) ? vals[0] : vals; }
      out.push(step);
    });
  }
  return out;
}
function fxPanel(c) {
  const d = FX[c.fx] || { n: c.fx };
  return `<h3>${esc(d.n)}</h3><p class="muted">Effects track · ${mss(c.dur)} · changes everything under it (text stays on top)</p>
    ${slider('c.amt', 'Strength', c.amt ?? 1, 0.1, 2, 0.01, '%')}${pick('c.fx', 'Effect', c.fx, Object.entries(FX).map(([k, v]) => [k, v.n]))}
    <p class="hint">Drag its edges on the timeline to change how long it lasts. More effects are in the library on the left.</p>
    <div class="actions"><button data-act="split">Split</button><button data-act="dup">Duplicate</button><button data-act="delete">Delete</button></div>`;
}

const fract = a => a - Math.floor(a);
const TR_MASK = { // xfade's per-pixel weight of the incoming clip (its mix(b, a, ss) puts ss on b); P is xfade's progress, 1 -> 0
  radial: (x, y, W, H, P) => smoothstep(0, 1, Math.atan2(x - W / 2, y - H / 2) - (P - 0.5) * Math.PI * 2.5),
  smoothleft: (x, y, W, H, P) => smoothstep(0, 1, 1 + x / W - P * 2),
  smoothright: (x, y, W, H, P) => smoothstep(0, 1, 1 + (W - 1 - x) / W - P * 2),
  smoothup: (x, y, W, H, P) => smoothstep(0, 1, 1 + y / H - P * 2),
  smoothdown: (x, y, W, H, P) => smoothstep(0, 1, 1 + (H - 1 - y) / H - P * 2),
  vertopen: (x, y, W, H, P) => smoothstep(0, 1, 2 - Math.abs((x - W / 2) / (W / 2)) - P * 2),
  horzopen: (x, y, W, H, P) => smoothstep(0, 1, 2 - Math.abs((y - H / 2) / (H / 2)) - P * 2),
  diagtl: (x, y, W, H, P) => smoothstep(0, 1, 1 + (x / W) * (y / H) - P * 2),
  diagbr: (x, y, W, H, P) => smoothstep(0, 1, 1 + ((W - 1 - x) / W) * ((H - 1 - y) / H) - P * 2),
  hlslice: (x, y, W, H, P) => (smoothstep(-0.5, 0, x / W - P * 1.5) <= fract(10 * x / W) ? 0 : 1),
  vuslice: (x, y, W, H, P) => (smoothstep(-0.5, 0, y / H - P * 1.5) <= fract(10 * y / H) ? 0 : 1),
};
function maskTr(ctx, A, B, fn, P1) { // b drawn over a through the per-pixel weight
  const W = A.width, H = A.height, M = scratch(W, H, 'trm'), mx = M.getContext('2d'), img = mx.createImageData(W, H), d = img.data;
  for (let y = 0, i = 3; y < H; y++) for (let x = 0; x < W; x++, i += 4) d[i] = fn(x, y, W, H, P1) * 255;
  mx.putImageData(img, 0, 0);
  const C = scratch(W, H, 'trc'), cx = C.getContext('2d');
  cx.globalCompositeOperation = 'copy'; cx.drawImage(B, 0, 0);
  cx.globalCompositeOperation = 'destination-in'; cx.drawImage(M, 0, 0); cx.globalCompositeOperation = 'source-over';
  ctx.drawImage(A, 0, 0); ctx.drawImage(C, 0, 0);
}
const frandCache = new Map();
function frandMap(W, H) { // xfade's frand(x, y): the noise behind 'dissolve'
  const key = `${W}x${H}`;
  if (!frandCache.has(key)) {
    const r = new Float32Array(W * H);
    for (let y = 0, j = 0; y < H; y++) for (let x = 0; x < W; x++, j++) r[j] = fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.545);
    if (frandCache.size > 4) frandCache.clear();
    frandCache.set(key, r);
  }
  return frandCache.get(key);
}
function pixelTr(ctx, A, B, type, P1) { // the transitions that need every pixel of both frames (xfade's formulas; it truncates, so do we)
  const W = A.width, H = A.height, a = A.getContext('2d').getImageData(0, 0, W, H).data, b = B.getContext('2d').getImageData(0, 0, W, H).data;
  const out = ctx.createImageData(W, H), o = out.data;
  o.fill(255);
  if (type === 'dissolve') {
    const R = frandMap(W, H);
    for (let j = 0, i = 0; j < R.length; j++, i += 4) { const s = R[j] >= 1 - P1 ? a : b; o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; }
  } else if (type === 'pixelize') {
    const dist = Math.ceil(Math.min(P1, 1 - P1) * 50) / 50, sq = 2 * dist * Math.min(W, H) / 20;
    for (let y = 0, i = 0; y < H; y++) {
      const sy = dist > 0 ? Math.trunc(Math.min((Math.floor(y / sq) + 0.5) * sq, H - 1)) : y;
      for (let x = 0; x < W; x++, i += 4) {
        const k = (sy * W + (dist > 0 ? Math.trunc(Math.min((Math.floor(x / sq) + 0.5) * sq, W - 1)) : x)) * 4;
        for (let c = 0; c < 3; c++) o[i + c] = (a[k + c] * P1 + b[k + c] * (1 - P1)) | 0;
      }
    }
  } else if (type === 'hblur') { // both frames box-blurred along rows, the box growing to half the width at the middle, cross-faded
    const prog = P1 <= 0.5 ? P1 * 2 : (1 - P1) * 2, size = Math.trunc(1 + Math.trunc(W / 2) * prog);
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) {
      const r = y * W * 4 + c;
      let s0 = 0, s1 = 0, cnt = size;
      for (let x = 0; x < size; x++) { s0 += a[r + x * 4]; s1 += b[r + x * 4]; }
      for (let x = 0; x < W; x++) {
        o[r + x * 4] = ((s0 / cnt) * P1 + (s1 / cnt) * (1 - P1)) | 0;
        if (x + size < W) { s0 += a[r + (x + size) * 4] - a[r + x * 4]; s1 += b[r + (x + size) * 4] - b[r + x * 4]; } else { s0 -= a[r + x * 4]; s1 -= b[r + x * 4]; cnt--; }
      }
    }
  } else { // fadegrays: each side fades through its own grey version
    const s1 = smoothstep(0.8, 1, P1), s2 = smoothstep(0.2, 1, P1);
    for (let i = 0; i < o.length; i += 4) {
      const ga = Math.trunc((a[i] + a[i + 1] + a[i + 2]) / 3), gb = Math.trunc((b[i] + b[i + 1] + b[i + 2]) / 3);
      for (let c = 0; c < 3; c++) o[i + c] = ((a[i + c] * s1 + ga * (1 - s1)) * P1 + (gb * s2 + b[i + c] * (1 - s2)) * (1 - P1)) | 0;
    }
  }
  ctx.putImageData(out, 0, 0);
}

// ---------- the library panel: galleries of effects, transitions, filters, text styles, stickers and sounds ----------
const G = { tab: 'media', fxCat: 'all', stCat: 'Smileys', mfilter: 'all', hover: null, raf: 0, frame: 0, sfx: [], audio: null };
const EMOJI = {
  Smileys: '😀😂🤣😊😍🥰😘😎🤩🥳😇🙂😉😜🤪🤔🙄😴🤤😭😡🤯😱🥶🤡👻💀👽🤖😺',
  Hands: '👍👎👏🙌🙏💪✌️🤞👌🤙👋☝️👉👈👆👇✊👊🤝🫶✍️💅',
  Hearts: '❤️🧡💛💚💙💜🖤🤍🤎💖💘💝💗💓💔❤️‍🔥❣️💯💋💌',
  Party: '🔥✨⭐🌟⚡💥🎉🎊🎈🎁🏆🥇👑💎💰💸🚀🎯🎮🎤🎧📸🎬',
  Nature: '🌸🌹🌻🌷🌈☀️🌙❄️🌊🍀🍁🌴🌵🐶🐱🦄🐝🦋🐼🦊🐸🐙',
  Food: '🍕🍔🍟🌮🍣🍩🍪🍰🧁🍓🍉🍑🥑🌶️☕🍿🧋🍾🥂🍺',
  Signs: '⬆️⬇️⬅️➡️↗️🔄✅❌⚠️❓❗💬💭🔔📍📌🎵🎶⏰💡🆕🆒🆓',
};
const graphemes = s => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
const TILE_W = 264, TILE_H = 148; // tile canvases (drawn at 2x)
const tileCv = () => `<canvas width="${TILE_W}" height="${TILE_H}"></canvas>`;
const cap1 = s => s[0].toUpperCase() + s.slice(1);
function sampleScene(W, H, v) { // the stand-in footage of effect and transition tiles: a sunset (0) and a night sea (1)
  const c = scratch(W, H, `scene${v}`);
  if (c._done) return c;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, H);
  for (const [o, col] of v ? [[0, '#0c2a52'], [0.6, '#1b6b8f'], [1, '#0a1f2e']] : [[0, '#ff9a5a'], [0.55, '#ff5e7e'], [1, '#3a1d4f']]) g.addColorStop(o, col);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = v ? '#e8f4ff' : '#ffe4a3'; x.beginPath(); x.arc(W * (v ? 0.72 : 0.3), H * 0.36, H * 0.15, 0, 6.2832); x.fill();
  for (const [col, pts] of [[v ? '#0d3b4f' : '#5a2346', [0.72, 0.25, 0.5, 0.45, 0.68, 0.7, 0.45, 1, 0.66]], [v ? '#06202c' : '#2a1030', [0.86, 0.2, 0.7, 0.55, 0.82, 0.85, 0.66, 1, 0.8]]]) {
    x.fillStyle = col; x.beginPath(); x.moveTo(0, H); x.lineTo(0, H * pts[0]);
    for (let i = 1; i < pts.length; i += 2) x.lineTo(W * pts[i], H * pts[i + 1]);
    x.lineTo(W, H); x.closePath(); x.fill();
  }
  c._done = true;
  return c;
}
function openTab(tab) {
  G.tab = tab;
  $$('.rail button').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
  $$('.pane').forEach(p => p.classList.toggle('on', p.id === `tab-${tab}`));
  renderPane();
}
function renderPane() { // the open gallery, refreshed (cheap: called on tab change and edits)
  const t = G.tab;
  if (t === 'effects') renderEffects();
  else if (t === 'transitions') renderTransitions();
  else if (t === 'filters') renderFilters();
  else if (t === 'stickers') renderStickers();
  else if (t === 'audio') renderAudio();
  else if (t === 'text') renderTextTiles();
  else if (t === 'script') renderScript();
  else if (t === 'captions') renderCapList();
}
function renderEffects() {
  $('#fxCats').innerHTML = FX_CATS.map(([k, n]) => `<button data-fxcat="${k}" class="${G.fxCat === k ? 'on' : ''}">${n}</button>`).join('');
  $('#fxGrid').innerHTML = Object.entries(FX).filter(([, d]) => G.fxCat === 'all' || d.cat === G.fxCat)
    .map(([k, d]) => `<button class="tile" data-fx="${k}" title="Add ${esc(d.n)} at the playhead">${tileCv()}<span>${esc(d.n)}</span></button>`).join('');
  drawTiles(true);
}
function cutTarget() { // the cut transition tiles apply to: the selected cut, the selected clip's outgoing cut, else the cut nearest the playhead
  packMain();
  if (P.main.length < 2) return null;
  const c = selClip();
  if (S.sel?.lane === 'tr' && c) return c;
  if (S.sel?.lane === 'main' && c && P.main.indexOf(c) < P.main.length - 1) return c;
  let best = P.main[0], bd = Infinity;
  P.main.slice(0, -1).forEach((x, i) => { const d = Math.abs(P.main[i + 1].start - S.t); if (d < bd) { bd = d; best = x; } });
  return best;
}
const clipName = c => M.get(c?.media)?.name || 'clip';
function renderTransitions() {
  const c = cutTarget(), nx = c && P.main[P.main.indexOf(c) + 1];
  $('#trTarget').textContent = c ? `On the cut ${clipName(c)} → ${clipName(nx)}${S.sel?.lane === 'tr' || S.sel?.lane === 'main' ? '' : ', nearest the playhead (click a ◆ to pick another)'}`
    : 'Put two clips on the main track first: a transition goes on the cut between them.';
  $('#trGrid').innerHTML = TRANSITIONS.filter(t => t[0] !== 'none').map(([k, n]) => `<button class="tile${c?.tr?.type === k ? ' on' : ''}" data-trset="${k}" title="${esc(n)}">${tileCv()}<span>${esc(n)}</span></button>`).join('');
  $('#btnTrNone').disabled = !c?.tr;
  drawTiles(true);
}
function applyTransition(type, all = false) {
  const c = cutTarget(), d = +$('#trDur').value || 0.5;
  if (!c) return toast('Put two clips on the main track first');
  change(() => {
    for (const x of all ? P.main.slice(0, -1) : [c]) { if (type === 'none') delete x.tr; else x.tr = { type, d }; }
    if (!all) S.sel = { lane: 'tr', id: c.id };
  });
  G.lastTr = type;
  toast(type === 'none' ? 'Transition removed' : `${TRANSITIONS.find(t => t[0] === type)[1]}${all ? ' on every cut' : ''}`);
  renderPane();
}
function lookTargets() { const c = selClip(), m = c && M.get(c.media); return c && m && m.kind !== 'audio' && S.sel.lane !== 'tr' ? { sel: true, list: [c] } : { sel: false, list: P.main.filter(x => M.get(x.media)?.kind !== 'audio') }; }
function frameThumb(W, H, clips) { // the frame at the playhead as rendered (no selection box, these clips without their filter), cropped to a tile
  const C = scratch(W, H, 'thumb'), x = C.getContext('2d'), cv = $('#cv');
  if (total() <= 0 || !cv.width) { x.drawImage(sampleScene(W, H, 0), 0, 0); return C; }
  const sel = S.sel, saved = clips.map(c => c.look);
  S.sel = null; clips.forEach(c => delete c.look);
  try { paint(); } finally { S.sel = sel; clips.forEach((c, i) => { if (saved[i]) c.look = saved[i]; }); S.dirty = true; }
  const s = Math.max(W / cv.width, H / cv.height);
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  x.drawImage(cv, (W - cv.width * s) / 2, (H - cv.height * s) / 2, cv.width * s, cv.height * s);
  return C;
}
function renderFilters() {
  const tg = lookTargets(), cur = tg.list[0]?.look?.name || 'none';
  $('#lookTarget').textContent = tg.sel ? 'Applies to the selected clip.' : tg.list.length ? 'No clip selected: applies to every clip on the main track.' : 'Add a clip first: filters change its colours.';
  $('#lookGrid').innerHTML = ['none', ...Object.keys(LOOKS)].map(n => `<button class="tile${cur === n ? ' on' : ''}" data-lookset="${n}">${tileCv()}<span>${n === 'none' ? 'None' : cap1(n)}</span></button>`).join('');
  let src = frameThumb(TILE_W, TILE_H, tg.list);
  { const d = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, TILE_W, TILE_H).data; let y = 0; for (let i = 0; i < d.length; i += 4) y += d[i] + d[i + 1] + d[i + 2];
    if (y / (d.length / 4) / 3 < 28) src = sampleScene(TILE_W, TILE_H, 0); } // a near-black frame (night footage) shows no filter's difference: the sample scene does
  for (const b of $$('#lookGrid .tile')) { const x = b.firstElementChild.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0); if (b.dataset.lookset !== 'none') matrixPass(x, TILE_W, TILE_H, LOOKS[b.dataset.lookset]); }
}
function applyLook(name) {
  const tg = lookTargets(), amt = +$('#lookAmt').value;
  if (!tg.list.length) return toast('Add a clip first');
  change(() => { for (const c of tg.list) { if (name === 'none') delete c.look; else c.look = { name, amount: amt }; } });
  toast(name === 'none' ? 'Filter removed' : `${cap1(name)} on ${tg.sel ? 'the selected clip' : `${tg.list.length} clip${tg.list.length > 1 ? 's' : ''}`}`);
  renderPane();
}
function renderStickers() {
  $('#stCats').innerHTML = Object.keys(EMOJI).map(k => `<button data-stcat="${k}" class="${G.stCat === k ? 'on' : ''}">${k}</button>`).join('');
  $('#stGrid').innerHTML = graphemes(EMOJI[G.stCat]).map(e => `<button data-emoji="${e}" title="Add ${e} at the playhead">${e}</button>`).join('');
}
async function renderAudio() {
  if (!G.sfx.length) G.sfx = await api('/api/sfx').catch(() => []);
  $('#sfxList').innerHTML = G.sfx.map(s => `<div class="sfxrow"><button class="pl" data-sfxplay="${s.id}" title="Listen" aria-label="Listen to ${esc(s.name)}">${ICON.play}</button><b>${esc(s.name)}</b><span class="muted">${s.dur.toFixed(1)} s</span><button class="add" data-sfx="${s.id}" title="Add at the playhead" aria-label="Add ${esc(s.name)} at the playhead">+</button></div>`).join('');
  const aud = [...M.values()].filter(m => m.kind === 'audio' && !m.sfx);
  $('#audioList').innerHTML = aud.map(m => `<div class="sfxrow"><button class="pl" data-mplay="${m.id}" title="Listen" aria-label="Listen to ${esc(m.name)}">${ICON.play}</button><b title="${esc(m.name)}">${esc(m.name)}</b><span class="muted">${fmtDur(m.duration)}</span><button class="add" data-addaudio="${m.id}" title="Add at the playhead" aria-label="Add ${esc(m.name)} at the playhead">+</button></div>`).join('')
    || '<p class="hint">Import music or drop audio files anywhere; it shows up here.</p>';
}
function listen(src, btn) { // one preview player for the whole panel; clicking again stops it
  const a = G.audio ??= new Audio(), same = a.dataset.src === src && !a.paused;
  a.pause(); $$('.sfxrow .pl.on').forEach(b => { b.classList.remove('on'); b.innerHTML = ICON.play; });
  if (same) return;
  a.dataset.src = src; a.src = src; a.currentTime = 0; a.play().catch(() => {});
  btn.classList.add('on'); btn.innerHTML = ICON.pause;
  a.onended = () => { btn.classList.remove('on'); btn.innerHTML = ICON.play; };
}
async function addSfx(id, at = S.t) {
  const m = await api('/api/sfx/add', { id });
  if (!M.has(m.id)) await loadMedia();
  addMedia(m.id, 'audio', at);
  toast(`${m.name.replace(/\.wav$/, '')} added at ${mss(at)}`);
  return brief(...cfind(S.sel.id));
}
function textSwatch(n, s0) { // the style drawn with CSS: close to drawText, for the tile only
  const s = { ...TEXT_BASE, ...s0 }, px = 22;
  const css = [`font-family:'${s.font}'`, `font-weight:${s.weight}`, `color:${s.color}`, s.italic ? 'font-style:italic' : '', s.upper ? 'text-transform:uppercase' : '', s.ls ? `letter-spacing:${s.ls}em` : '',
    s.strokeW ? `-webkit-text-stroke:${Math.min(3, s.strokeW / 3)}px ${s.stroke};paint-order:stroke fill` : '',
    s.shadow && !s.grad ? `text-shadow:${s.shx * px}px ${s.shy * px}px ${s.shb * px}px ${hexA(s.shc || '#000000', s.sha ?? 0.55)}` : '',
    s.box ? `background:${hexA(s.boxColor, s.boxAlpha)};padding:2px 10px;border-radius:${Math.round(s.boxR * 18)}px` : '',
    s.grad ? `background:linear-gradient(${s.color},${s.grad});-webkit-background-clip:text;background-clip:text;color:transparent` : ''].filter(Boolean).join(';');
  return `<span style="${css}">${n === 'Sticker' ? '🔥' : n}</span>`;
}
function renderTextTiles() {
  $('#tplList').innerHTML = Object.entries(TEXT_TEMPLATES).map(([n, layers]) => `<button data-tpl="${esc(n)}" title="Add ${esc(n)} at the playhead">${textSwatch(n, { ...TEXT_PRESETS[layers[0][0]], ...layers[0][2], size: 60, maxW: 1 })}<i>${layers.length} layer${layers.length > 1 ? 's' : ''}</i></button>`).join('');
  $('#textPresets').innerHTML = Object.entries(TEXT_PRESETS).map(([n, s]) => `<button data-addtext="${n}" title="Add ${n} text at the playhead">${textSwatch(n, s)}</button>`).join(''); }
function drawTiles(force, now = performance.now()) { // still tiles; the one under the pointer plays (every tile playing took a third of a core)
  const pane = $(`#tab-${G.tab}`), pr = pane?.getBoundingClientRect();
  if (!pr) return;
  for (const b of $$('.tile[data-fx], .tile[data-trset]', pane)) {
    const r = b.getBoundingClientRect();
    if (r.bottom < pr.top || r.top > pr.bottom) continue;
    const moving = G.hover === b;
    if (!force && !moving) continue;
    const x = b.firstElementChild.getContext('2d', { willReadFrequently: true }), tsec = moving ? now / 1000 : null;
    x.save();
    if (b.dataset.fx) {
      const k = b.dataset.fx, d = FX[k], f = { fx: k, start: 0, dur: d.d, amt: 1, gallery: true }, u = TILE_H / 540;
      const one = (lt, a) => { // the scene with the effect at lt, laid over the tile at alpha a
        const T = scratch(TILE_W, TILE_H, 'tile1'), tx = T.getContext('2d', { willReadFrequently: true });
        tx.drawImage(sampleScene(TILE_W, TILE_H, 0), 0, 0);
        if (d.px) runOps(tx, TILE_W, TILE_H, d.px(TILE_W, TILE_H, u, lt, f));
        if (d.layer) { tx.save(); d.layer(tx, TILE_W, TILE_H, u, lt, f); tx.restore(); }
        x.globalAlpha = a; x.drawImage(T, 0, 0); x.globalAlpha = 1;
      };
      if (tsec !== null) one(tsec % d.d, 1);
      else if (d.cat === 'camera') [0.04, 0.16, 0.4].forEach((s, i) => one(s * (k === 'zoomin' ? 7 : 1), i ? 0.45 : 1)); // a still of motion: three moments, onion-skinned
      else one(d.d * 0.35, 1);
    } else {
      const ph = tsec === null ? (b.dataset.trset === 'zoomin' ? 0.62 : 0.95) : tsec % 2.2; // still frame: part way through (zoom: before it fills the tile)
      transition(x, sampleScene(TILE_W, TILE_H, 0), sampleScene(TILE_W, TILE_H, 1), b.dataset.trset, clamp((ph - 0.4) / 1.4, 0, 1));
    }
    x.restore();
  }
}
function galleryLoop(now) {
  G.raf = 0;
  if ((G.tab !== 'effects' && G.tab !== 'transitions') || !G.hover) return;
  if (++G.frame % 2 === 0) drawTiles(false, now); // 30 fps is plenty for thumbnails
  G.raf = requestAnimationFrame(galleryLoop);
}
function aiTool(name) { // the smart tools, from the AI panel: on the selected clip, else the main clip under the playhead
  if (name === 'captions') { openTab('captions'); return autoCaptions(); }
  let c = selClip(), lane = S.sel?.lane;
  if (!c?.media || lane === 'tr') { packMain(); c = P.main.find(x => S.t >= x.start && S.t < x.start + tdur(x, 'main')) || P.main[0]; lane = 'main'; if (c) { S.sel = { lane, id: c.id }; renderAll(); } }
  if (!c) return toast('Add a clip to the timeline first');
  const kind = M.get(c.media)?.kind;
  if (['removeobj', 'cutobj', 'reframe', 'stabilize', 'scenes'].includes(name) && kind !== 'video') return toast('That works on video clips: select one first');
  if (['isovoice', 'novoice'].includes(name) && !M.get(c.media)?.hasAudio) return toast('That clip has no sound');
  return ({ removeobj: () => startRemove(c, lane), cutobj: () => startRemove(c, lane, 'cutout'), matte: () => removeBackground(c), reframe: () => autoReframe(c), stabilize: () => remake(c, 'stabilize'),
    isovoice: () => isolateVoice(c, lane, 'voice'), novoice: () => isolateVoice(c, lane, 'music'), scenes: () => sceneSplit(c, lane) })[name]?.();
}
function syncToolbar() { // timeline toolbar buttons enabled for what is selected
  const c = selClip(), lane = S.sel?.lane, m = c && M.get(c.media), vis = !!m && m.kind !== 'audio', vid = m?.kind === 'video';
  $('#btnDup').disabled = !c || lane === 'tr'; $('#btnDelete').disabled = !c;
  $('#btnFreeze').disabled = !vid; $('#btnReverse').disabled = !vid; $('#btnMirror').disabled = !vis; $('#btnRotate').disabled = !(vis || lane === 'text');
}
function rotate90(c) { const pr = propsAt(c, S.t - c.start); change(() => setProp(c, 'rot', ((Math.round(pr.rot) + 90 + 180) % 360 + 360) % 360 - 180)); }
function fitTimeline() { const sc = $('#tlScroll'); setZoom((sc.clientWidth - 60) / Math.max(1, total())); sc.scrollLeft = 0; }


// ---------- editing like a pro: multi-select, clipboard, trim to playhead, right-click menus, on-canvas handles ----------
const selKey = (lane, id) => `${lane}:${id}`;
function selection() { // the selected clips as [clip, lane]: the primary one plus any ⇧-clicked ones
  const out = [], seen = new Set();
  const add = (lane, id) => { const k = selKey(lane, id), c = P[lane]?.find(x => x.id === id); if (c && !seen.has(k)) { seen.add(k); out.push([c, lane]); } };
  if (S.sel && S.sel.lane !== 'tr') add(S.sel.lane, S.sel.id);
  for (const k of S.multi) { const i = k.indexOf(':'); add(k.slice(0, i), k.slice(i + 1)); }
  return out;
}
const isSel = (lane, id) => (S.sel?.lane === lane && S.sel.id === id) || S.multi.has(selKey(lane, id));
function selectAll() { // ⌘A: every clip on every track
  S.multi.clear();
  const all = LANES.flatMap(L => P[L.key].filter(c => !locked(L.key, c)).map(c => [L.key, c.id]));
  if (!all.length) return;
  S.sel = { lane: all[0][0], id: all[0][1] };
  for (const [l, id] of all.slice(1)) S.multi.add(selKey(l, id));
  renderTimeline(); renderInspector(); S.dirty = true;
  toast(`${all.length} clips selected`);
}
let clipboard = null;
function copySel(cut = false) {
  const many = selection();
  if (!many.length) return toast('Select a clip first');
  packMain();
  const order = ([c, lane]) => (lane === 'main' ? P.main.indexOf(c) : 1e6 + c.start); // pasted in timeline order, not click order
  clipboard = { items: [...many].sort((a, b) => order(a) - order(b)).map(([c, lane]) => ({ lane, c: structuredClone(c) })), t0: Math.min(...many.map(([c]) => c.start)) };
  if (cut) del(); else toast(`Copied ${many.length} clip${many.length > 1 ? 's' : ''}: ⌘V pastes at the playhead, ⌥⌘V pastes the look`);
}
function paste(at = S.t) { // main clips insert at the playhead's cut; the others keep their spacing, starting at the playhead
  if (!clipboard) return toast('Nothing to paste: copy a clip first (⌘C)');
  change(() => {
    packMain();
    let mi = P.main.filter(x => x.start + tdur(x, 'main') / 2 <= at).length, last = null;
    S.multi.clear();
    for (const { lane, c } of clipboard.items) {
      const b = { ...structuredClone(c), id: hex12() };
      if (lane === 'main') { delete b.tr; P.main.splice(mi++, 0, b); } else { b.start = Math.max(0, at + c.start - clipboard.t0); P[lane].push(b); }
      if (last) S.multi.add(selKey(last.lane, last.id));
      last = { lane, id: b.id };
    }
    S.sel = last;
  });
  toast(`Pasted ${clipboard.items.length} clip${clipboard.items.length > 1 ? 's' : ''}`);
}
const LOOK_ATTRS = ['look', 'adj', 'anim', 'mask', 'key', 'blend', 'crop', 'flip', 'fit'];
function pasteLook() { // ⌥⌘V: the copied clip's filter, adjustments, animations, mask and key (or a text's style) onto the selection
  const src = clipboard?.items[0]?.c;
  if (!src) return toast('Copy a clip first (⌘C), then select others and paste its look (⌥⌘V)');
  const targets = selection().filter(([c, lane]) => !!c.media === !!src.media && !c.fx && !src.fx && !locked(lane, c));
  if (!targets.length) return toast(src.media ? 'Select video or photo clips to paste onto' : 'Select text clips to paste the style onto');
  change(() => {
    for (const [c, lane] of targets) {
      if (!src.media) { if (lane === 'text') c.style = structuredClone(src.style); continue; }
      for (const k of LOOK_ATTRS) { if (src[k] !== undefined) c[k] = structuredClone(src[k]); else delete c[k]; }
    }
  });
  toast(`Pasted the look onto ${targets.length} clip${targets.length > 1 ? 's' : ''}`);
}
function trimTo(side) { // Q / W: delete what is left / right of the playhead in the clip (CapCut's trim left / right)
  packMain();
  const t = S.t, inside = (x, lane) => t > x.start + 1e-6 && t < x.start + tdur(x, lane) - 1e-6;
  let lane = S.sel?.lane === 'tr' ? 'main' : S.sel?.lane, c = selClip();
  if (!c || !inside(c, lane)) { lane = 'main'; c = P.main.find(x => inside(x, 'main')); }
  if (!c) return toast('Put the playhead over a clip first');
  if (locked(lane, c)) return toast('That track is locked: click its lock to edit it');
  let kept;
  change(() => {
    const b = splitClip(c, lane, lane === 'main' ? snap(t) : t);
    kept = side === 'left' ? b : c;
    P[lane] = P[lane].filter(x => x !== (side === 'left' ? c : b));
    S.sel = { lane, id: kept.id }; S.multi.clear();
  });
  if (side === 'left' && lane === 'main') { packMain(); seekTo(kept.start); } // the playhead stays on the same picture
}
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; removeEventListener('pointerdown', menuAway, true); }
const menuAway = e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
function openMenu(x, y, items) { // items: [label, fn, shortcut, disabled] or '-'
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctxmenu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-mi="${i}" role="menuitem"${it[3] ? ' disabled' : ''}><span>${esc(it[0])}</span><kbd>${esc(it[2] || '')}</kbd></button>`)).join('');
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${clamp(x, 8, innerWidth - r.width - 8)}px`; m.style.top = `${clamp(y, 8, innerHeight - r.height - 8)}px`;
  m.addEventListener('click', e => { const b = e.target.closest('[data-mi]'); if (b && !b.disabled) { closeMenu(); items[+b.dataset.mi][1](); } });
  menuEl = m;
  setTimeout(() => addEventListener('pointerdown', menuAway, true));
  m.querySelector('button:not([disabled])')?.focus();
}
function clipMenu(c, lane) { // what a right-click on a clip offers
  const m = M.get(c.media), vid = m?.kind === 'video', vis = !!m && m.kind !== 'audio', many = selection().length > 1;
  const items = [['Split', split, 'S'], ['Duplicate', dup, '⌘D'], ['Copy', () => copySel(), '⌘C'], ['Cut', () => copySel(true), '⌘X'], ['Paste', () => paste(), '⌘V', !clipboard],
    ['Paste look', pasteLook, '⌥⌘V', !clipboard], '-', ['Trim start to playhead', () => trimTo('left'), 'Q'], ['Trim end to playhead', () => trimTo('right'), 'W']];
  if (vid || vis) items.push('-');
  if (m && !many && !c.mc && !c.compound) items.push(['Replace…', () => replaceMenu(c, lane)]);
  if (vid) items.push(['Freeze frame', () => quiet(freeze(c, lane))], ['Reverse', () => quiet(remake(c, 'reverse'))]);
  if (vid && lane !== 'audio' && m.hasAudio && c.volume > 0) items.push(['Detach audio', () => detachAudio(c)]);
  if (vid) items.push(['Remove object…', () => startRemove(c, lane)], ['Cut out object…', () => startRemove(c, lane, 'cutout')]);
  if (vis) items.push(['Remove background', () => quiet(removeBackground(c))], ['Auto adjust colour', () => autoAdjust(c, lane).catch(() => {})]);
  if (lane === 'main' || lane === 'overlay') items.push(['Mirror', () => change(() => { c.flip = !c.flip; })], ['Rotate 90°', () => rotate90(c)], [`Move to ${lane === 'main' ? 'overlay' : 'main'} track`, () => moveLane(c, lane)]);
  if (lane === 'overlay') items.push(['Bring forward', () => restack(c, 1)], ['Send backward', () => restack(c, -1)]);
  if (many) items.push('-', ['Make compound clip', () => makeCompound().catch(e => toast(e.message))]);
  if (c.compound) items.push('-', ['Break apart', () => breakCompound(c)]);
  items.push('-', [many ? `Delete ${selection().length} clips` : 'Delete', del, '⌫']);
  return items;
}
function selBox(h) { return { cx: (h.x0 + h.x1) / 2, cy: (h.y0 + h.y1) / 2, hw: (h.x1 - h.x0) / 2, hh: (h.y1 - h.y0) / 2, rad: ((h.rot || 0) * Math.PI) / 180 }; }
function handlePts(h) { // corner handles and the rotate knob, in canvas pixels (they turn with the clip)
  const b = selBox(h), d = devicePixelRatio || 1, cs = Math.cos(b.rad), sn = Math.sin(b.rad), at = (u, v) => [b.cx + u * cs - v * sn, b.cy + u * sn + v * cs];
  return [['nw', ...at(-b.hw, -b.hh)], ['ne', ...at(b.hw, -b.hh)], ['sw', ...at(-b.hw, b.hh)], ['se', ...at(b.hw, b.hh)], ['rot', ...at(0, -b.hh - 26 * d)]];
}
const handleAt = (h, x, y) => handlePts(h).find(([, hx, hy]) => Math.hypot(x - hx, y - hy) <= 11 * (devicePixelRatio || 1))?.[0];
const canHandle = lane => lane === 'text' || lane === 'overlay' || lane === 'main';
function drawSel(ctx, h, handles) {
  const b = selBox(h), d = devicePixelRatio || 1;
  ctx.save(); ctx.translate(b.cx, b.cy); ctx.rotate(b.rad);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * d; ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 3 * d;
  if (!handles) ctx.setLineDash([5 * d, 4 * d]);
  ctx.strokeRect(-b.hw, -b.hh, b.hw * 2, b.hh * 2);
  if (handles) {
    ctx.beginPath(); ctx.moveTo(0, -b.hh); ctx.lineTo(0, -b.hh - 20 * d); ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.roundRect(u * b.hw - 5 * d, v * b.hh - 5 * d, 10 * d, 10 * d, 2.5 * d); ctx.fill(); }
    ctx.beginPath(); ctx.arc(0, -b.hh - 26 * d, 6 * d, 0, 6.2832); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.strokeStyle = '#8b5cf6'; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(0, -b.hh - 26 * d, 3 * d, -2.2, 2.4); ctx.stroke();
  }
  ctx.restore();
}
function handleDrag(e, h, kind, cv) { // corner: scale about the centre; knob: rotate (snaps to straight; ⌥ for free)
  const c = selClip(), before = JSON.stringify(P), b = selBox(h), pr0 = propsAt(c, S.t - c.start), r = cv.getBoundingClientRect(), px = cv.width / r.width;
  const pt = ev => [(ev.clientX - r.left) * px, (ev.clientY - r.top) * px], [x0, y0] = pt(e);
  const d0 = Math.max(1, Math.hypot(x0 - b.cx, y0 - b.cy)), a0 = Math.atan2(y0 - b.cy, x0 - b.cx);
  const move = ev => {
    const [x, y] = pt(ev);
    if (kind === 'rot') {
      let deg = pr0.rot + ((Math.atan2(y - b.cy, x - b.cx) - a0) * 180) / Math.PI;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      if (!ev.altKey) for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(deg - s) < 4) deg = s;
      setProp(c, 'rot', Math.round(deg * 10) / 10);
    } else setProp(c, 'scale', +clamp((pr0.scale * Math.hypot(x - b.cx, y - b.cy)) / d0, 0.05, 10).toFixed(3));
    S.dirty = true;
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); } };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function toggleTheater(on = !document.body.classList.contains('theater')) { // the preview fills the window (F, Esc to leave)
  document.body.classList.toggle('theater', on);
  $('#btnTheater').innerHTML = on ? ICON.shrink : ICON.expand;
  $('#btnTheater').title = on ? 'Back to the editor (F or Esc)' : 'Theater view (F)';
  requestAnimationFrame(() => { fitStage(); renderTimeline(); });
}

// ---------- edit by script: the main track's words; delete words or pauses to cut the video ----------
const SC = { words: null, sel: null, anchor: null, drag: false, now: -1, busy: false };
const wordCache = new Map(); // `${media}:${lang}` -> words in source time
const wordHave = new Map(); // same key -> the source [in, out] spans asked for: only the parts in use are transcribed
const usedSpans = (id, clips) => clips.filter(c => c.media === id).map(c => [c.in, c.out]);
const hasWords = (id, lang, rs) => rs.every(([a, b]) => (wordHave.get(`${id}:${lang}`) || []).some(([x, y]) => x <= a && b <= y));
async function fetchWords(id, lang, ranges, say) { // whisper on those spans of one file (the server keeps what it heard), its progress meanwhile
  const k = `${id}:${lang}`, tick = say && setInterval(() => api('/api/transcribe/progress', { media: id }).then(r => { if (r.p != null) say(` ${Math.round(r.p * 100)} %`); }).catch(() => {}), 800);
  try { wordCache.set(k, (await api('/api/transcribe', { media: id, lang, ranges })).words); } finally { clearInterval(tick); }
  wordHave.set(k, [...(wordHave.get(k) || []), ...ranges]);
  return wordCache.get(k);
}
async function loadWords(ids, status) {
  const lang = $('#capLang').value;
  for (const [i, id] of ids.entries()) {
    const rs = usedSpans(id, P.main), msg = `Transcribing ${i + 1}/${ids.length} on this Mac: ${M.get(id)?.name}…`;
    if (hasWords(id, lang, rs)) continue;
    if (status) status(msg);
    await fetchWords(id, lang, rs, status && (p => status(msg + p)));
  }
}
function scriptWords() { // the main track's words on the timeline, each with its clip and source times
  packMain();
  const lang = $('#capLang').value, out = [];
  for (const c of P.main) {
    const ws = wordCache.get(`${c.media}:${lang}`);
    if (!ws) continue;
    for (const w of ws) {
      if (w.e <= c.in || w.s >= c.out) continue;
      const t0 = c.start + (Math.max(w.s, c.in) - c.in) / c.speed, t1 = c.start + (Math.min(w.e, c.out) - c.in) / c.speed;
      if (t1 - t0 > 0.02) out.push({ w: w.w, t0, t1, s: w.s, e: w.e, c });
    }
  }
  return out;
}
async function renderScript(load = true) {
  const body = $('#scriptBody'), st = t => { $('#scriptStatus').textContent = t; };
  const ids = [...new Set(P.main.filter(c => M.get(c.media)?.hasAudio).map(c => c.media))];
  if (!ids.length) { SC.words = null; body.innerHTML = '<p class="hint">Put a clip with speech on the main track: its words show up here, and deleting words cuts them out of the video.</p>'; st(''); return; }
  const lang = $('#capLang').value, missing = ids.filter(id => !hasWords(id, lang, usedSpans(id, P.main)));
  if (missing.length) {
    if (!load || SC.busy) return;
    SC.busy = true;
    try { await loadWords(missing, st); } catch (e) { st(e.message); return; } finally { SC.busy = false; }
  }
  const ws = SC.words = scriptWords();
  if (SC.sel && (Array.isArray(SC.sel) ? SC.sel[1] >= ws.length : SC.sel.gap >= ws.length)) SC.sel = null;
  let html = '<p>';
  ws.forEach((w, i) => {
    const p = ws[i - 1], gap = p ? w.t0 - p.t1 : 0;
    if (p && (p.c !== w.c || (gap > 0.9 && /[.?!]$/.test(p.w)))) html += '</p><p>';
    if (p && gap >= 0.5) html += `<span class="gap" data-g="${i}" title="Pause: click it, then ⌫ to cut it">${gap.toFixed(1)} s</span> `;
    html += `<span class="w" data-i="${i}">${esc(w.w)}</span> `;
  });
  body.innerHTML = ws.length ? `${html}</p>` : '';
  body.hidden = !ws.length; // no speech: no empty box
  st(ws.length ? `${ws.length} words. Click a word to jump there; drag or ⇧-click to select; ⌫ cuts it out of the video.` : 'No speech found on the main track.');
  SC.now = -1;
  markScript();
}
function markScript() {
  const s = SC.sel, on = i => Array.isArray(s) && i >= s[0] && i <= s[1];
  for (const el of $$('#scriptBody .w')) el.classList.toggle('on', on(+el.dataset.i));
  for (const el of $$('#scriptBody .gap')) el.classList.toggle('on', !!s && !Array.isArray(s) && s.gap === +el.dataset.g);
  $('#btnScriptCut').disabled = !s;
}
function scriptNow(t) { // the word under the playhead, highlighted while it plays
  const ws = SC.words;
  if (!ws?.length) return;
  let lo = 0, hi = ws.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ws[mid].t0 <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k >= 0 && t > ws[k].t1 + 0.25) k = -1;
  if (k === SC.now) return;
  $(`#scriptBody .w[data-i="${SC.now}"]`)?.classList.remove('now');
  SC.now = k;
  const el = k >= 0 && $(`#scriptBody .w[data-i="${k}"]`);
  if (el) { el.classList.add('now'); if (S.playing) el.scrollIntoView({ block: 'nearest' }); }
}
function timelineCuts(ranges) { // timeline ranges -> source ranges per main clip
  packMain();
  const rm = new Map();
  for (const [a, b] of ranges) for (const c of P.main) {
    const s = Math.max(a, c.start), e = Math.min(b, c.start + tdur(c, 'main'));
    if (e - s > 1e-3) (rm.get(c.id) || rm.set(c.id, []).get(c.id)).push([c.in + (s - c.start) * c.speed, c.in + (e - c.start) * c.speed]);
  }
  return rm;
}
async function applyCut(rm, what) { // ripple cut of the main track, then captions re-made from the (cached) words so they stay on their speech
  if (!rm.size) { toast('Nothing to cut there'); return 0; }
  const before = packMain(), next = cutMain(rm, 0, c => c.id, 0.02, true);
  if (JSON.stringify(next) === JSON.stringify(P.main)) { toast('Nothing to cut there'); return 0; }
  change(() => { P.main = next; S.sel = null; S.multi.clear(); });
  S.t = clamp(S.t, 0, total());
  const cut = before - packMain();
  toast(`Cut ${what} (${cut.toFixed(1)} s)`);
  await resyncCaptions();
  return cut;
}
async function resyncCaptions() { // captions made from speech follow a cut of the main track
  if (P.captions.some(c => c.words?.length)) { await autoCaptions(true).catch(() => {}); toast('Captions moved with the cut'); }
}
function cutScript() {
  const ws = SC.words, sel = SC.sel;
  if (!ws || !sel) return;
  const rm = new Map(), put = (c, a, b) => { if (b - a > 0.02) (rm.get(c.id) || rm.set(c.id, []).get(c.id)).push([a, b]); };
  let what;
  if (!Array.isArray(sel)) { // a pause: keep a little air on both sides
    const p = ws[sel.gap - 1], w = ws[sel.gap];
    if (p && w && p.c === w.c) put(w.c, p.e + 0.08, w.s - 0.08);
    what = 'a pause'; if (p) S.t = p.t1;
  } else { // the words, cut at the middle of the pauses around them, in runs within one clip
    for (let i = sel[0]; i <= sel[1];) {
      const c = ws[i].c;
      let j = i;
      while (j + 1 <= sel[1] && ws[j + 1].c === c) j++;
      const prev = ws[i - 1]?.c === c ? ws[i - 1] : null, next = ws[j + 1]?.c === c ? ws[j + 1] : null;
      put(c, prev ? (prev.e + ws[i].s) / 2 : c.in, next ? (ws[j].e + next.s) / 2 : c.out);
      i = j + 1;
    }
    const n = sel[1] - sel[0] + 1;
    what = n === 1 ? `"${ws[sel[0]].w}"` : `${n} words`; S.t = ws[sel[0]].t0;
  }
  SC.sel = null;
  return applyCut(rm, what);
}
function renderCapList() { // every caption as an editable line; click the time to jump there
  const el = $('#capList');
  if (!el) return;
  el.innerHTML = P.captions.length ? P.captions.map(c => `<div class="caprow"><button class="ct" data-capgo="${c.id}" title="Go there">${tc(c.start).slice(0, 5)}</button><input data-capid="${c.id}" value="${esc(c.text)}" spellcheck="true" aria-label="Caption at ${tc(c.start)}"></div>`).join('')
    : '<p class="hint">Generate captions and every line shows up here, to fix words.</p>';
}

// ---------- auto adjust and colour match: a few numbers, solved from the clip's own pixels ----------
async function rawFrame(c, lane) { // the clip's own pixels (before its adjustments), at the playhead or its middle, as a small RGBA buffer
  const m = M.get(c.media), d = tdur(c, lane), lt = S.t - c.start;
  if (!(lt >= 0 && lt < d)) seekTo(c.start + d / 2);
  await waitFrame();
  const el = m.kind === 'image' ? imgFor(m) : [...(S.live || [])].find(v => v.dataset.media === m.id && v.readyState >= 2);
  if (!el) throw new Error('the clip is not on screen yet: try again');
  const W = 64, H = Math.max(8, Math.round((64 * m.h) / m.w)), x = scratch(W, H, 'raw').getContext('2d', { willReadFrequently: true });
  x.drawImage(el, 0, 0, W, H);
  return x.getImageData(0, 0, W, H).data;
}
function gradeStats(d, c) { // colorPass's maths on a pixel buffer, then the numbers auto adjust aims at
  const a = c.adj || {}, b = a.b ?? 1, k = a.c ?? 1, M3 = sat(a.s ?? 1), L = lookMatrix(c), T = toneLUT(c), q = v => (v < 0 ? 0 : v > 255 ? 255 : v), n = d.length / 4, Y = new Float32Array(n);
  let R = 0, Gr = 0, B = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = q((q(d[i] * b) - 127.5) * k + 127.5), g = q((q(d[i + 1] * b) - 127.5) * k + 127.5), u = q((q(d[i + 2] * b) - 127.5) * k + 127.5);
    let r2 = q(M3[0] * r + M3[1] * g + M3[2] * u), g2 = q(M3[3] * r + M3[4] * g + M3[5] * u), b2 = q(M3[6] * r + M3[7] * g + M3[8] * u);
    if (T) { r2 = T[Math.round(r2)]; g2 = T[Math.round(g2)]; b2 = T[Math.round(b2)]; }
    if (L) { const r3 = q(L[0] * r2 + L[1] * g2 + L[2] * b2), g3 = q(L[3] * r2 + L[4] * g2 + L[5] * b2); b2 = q(L[6] * r2 + L[7] * g2 + L[8] * b2); r2 = r3; g2 = g3; }
    R += r2; Gr += g2; B += b2; Y[j] = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
  }
  Y.sort();
  const at = p => Y[Math.min(n - 1, Math.floor(p * n))];
  return { r: R / n, g: Gr / n, b: B / n, p5: at(0.05), p50: at(0.5), p95: at(0.95) };
}
function solveAdj(d, base, target) { // contrast + exposure for the brightness spread, then temperature + tint for the colour balance
  let best = null;
  const tp50 = target?.p50 ?? 118, tsp = target?.spread ?? 190, [k0, k1, e1] = target ? [0.7, 1.5, 1.5] : [0.85, 1.3, 1]; // auto adjust stays gentle; matching may move further
  for (let k = k0; k <= k1 + 1e-3; k += 0.05) for (let ex = -e1; ex <= e1 + 1e-3; ex += 0.1) {
    const kk = +k.toFixed(2), e = +ex.toFixed(2), s = gradeStats(d, { adj: { ...base, c: kk, ex: e } });
    const err = ((s.p50 - tp50) / 30) ** 2 + ((s.p95 - s.p5 - tsp) / 50) ** 2 + (target ? 0.05 * e * e : 0.35 * e * e + 0.4 * ((kk - 1) / 0.3) ** 2); // small moves unless matching
    if (!best || err < best.err) best = { err, c: kk, ex: e };
  }
  const s0 = gradeStats(d, { adj: { ...base, c: best.c, ex: best.ex } });
  const goal = target ? [target.r, target.g, target.b].map(v => (3 * v) / (target.r + target.g + target.b)) : [1, 1, 1];
  let wb = { err: Infinity, temp: 0, tint: 0 };
  for (let tp = -0.8; tp <= 0.801; tp += 0.05) for (let tn = -0.8; tn <= 0.801; tn += 0.05) {
    const T = [1 + 0.2 * tp + 0.05 * tn, 1 - 0.12 * tn, 1 - 0.2 * tp + 0.05 * tn], m3 = [s0.r * T[0], s0.g * T[1], s0.b * T[2]], y = (m3[0] + m3[1] + m3[2]) / 3 || 1;
    const err = m3.reduce((sum, v, i) => sum + (v / y - goal[i]) ** 2, 0) + 0.01 * (tp * tp + tn * tn);
    if (err < wb.err) wb = { err, temp: tp, tint: tn };
  }
  const f = target ? 1 : 0.7; // grey-world over-corrects scenes that really are warm or green: go most of the way
  return { c: best.c, ex: best.ex, temp: +(wb.temp * f).toFixed(2), tint: +(wb.tint * f).toFixed(2) };
}
async function autoAdjust(c, lane, refId) { // CapCut's auto adjust, and colour match against another clip
  const m = M.get(c.media);
  if (!m || m.kind === 'audio') { toast('Auto adjust works on video and photo clips'); return null; }
  try {
    let target = null;
    if (refId) {
      const ref = P.main.find(x => x.id === refId) || P.overlay.find(x => x.id === refId);
      if (!ref) throw new Error('pick the clip to match');
      const s = gradeStats(await rawFrame(ref, P.main.includes(ref) ? 'main' : 'overlay'), ref);
      target = { r: s.r, g: s.g, b: s.b, p50: s.p50, spread: s.p95 - s.p5 };
    }
    const d = await rawFrame(c, lane), a = c.adj || {}, r = solveAdj(d, { b: a.b ?? 1, s: a.s ?? 1, hi: a.hi || 0, sh: a.sh || 0, fade: a.fade || 0 }, target);
    change(() => { c.adj = { ...c.adj, c: r.c, ex: r.ex, temp: r.temp, tint: r.tint }; });
    const ev = r.ex ? `exposure ${r.ex > 0 ? '+' : ''}${r.ex}` : 'exposure kept', wb = Math.abs(r.temp) < 0.03 ? '' : r.temp > 0 ? ', warmer' : ', cooler';
    toast(refId ? `Matched the colours (${ev}, contrast ${r.c}${wb})` : `Auto adjust: ${ev}, contrast ${r.c}${wb}`);
    return { contrast: r.c, exposure: r.ex, temperature: r.temp, tint: r.tint };
  } catch (e) { toast(e.message); throw e; }
}

// ---------- text templates: a few layers that work together ----------
const TEXT_TEMPLATES = {
  'Title + subtitle': [['Title', { text: 'Your big title', y: 0.4 }, { anim: 'pop' }], ['Subtitle', { text: 'and the line that explains it', y: 0.5 }, { anim: 'fade', animT: 0.6 }]],
  'Lower third': [['Label', { text: 'Your Name', y: 0.8, dur: 4 }, { anim: 'slide', boxColor: '#8b5cf6', boxAlpha: 1, size: 56 }], ['Minimal', { text: 'Founder · Your Company', y: 0.86, dur: 4 }, { size: 36, anim: 'fade', animT: 0.7 }]],
  'Countdown': [['Headline', { text: '3', dur: 1, y: 0.45 }, { size: 300, anim: 'zoom', out: 'fade', outT: 0.2 }], ['Headline', { text: '2', dur: 1, y: 0.45, at: 1 }, { size: 300, anim: 'zoom', out: 'fade', outT: 0.2 }],
    ['Headline', { text: '1', dur: 1, y: 0.45, at: 2 }, { size: 300, anim: 'zoom', out: 'fade', outT: 0.2 }]],
  'Subscribe': [['Bubble', { text: 'SUBSCRIBE 🔔', y: 0.8, dur: 3 }, { boxColor: '#e4002b', anim: 'pop', loop: 'pulse' }]],
  'Quote': [['Minimal', { text: '“Make it simple, but significant.”', y: 0.44, dur: 4 }, { font: 'Georgia', weight: 400, italic: true, upper: false, ls: 0, size: 68, anim: 'fade', animT: 0.8 }],
    ['Minimal', { text: '— Your Name', y: 0.56, dur: 4 }, { size: 38, anim: 'fade', animT: 1.3 }]],
  'Big number': [['Headline', { text: '1,000,000', y: 0.44 }, { anim: 'zoom' }], ['Subtitle', { text: 'views in one week', y: 0.54 }, { anim: 'fade', animT: 0.8 }]],
  'Breaking news': [['Label', { text: 'BREAKING', y: 0.79, dur: 4 }, { boxColor: '#e4002b', boxAlpha: 1, size: 50, anim: 'slide' }], ['Label', { text: 'Your headline goes right here', y: 0.85, dur: 4 }, { boxColor: '#111827', size: 42, anim: 'slide', animT: 0.5 }]],
  'Hook': [['Neon', { text: 'Wait for it…', y: 0.3, dur: 2.5 }, { anim: 'drop', loop: 'wiggle' }]],
};
function addTemplate(name) {
  const t0 = S.t;
  change(() => {
    for (const [preset, props, style] of TEXT_TEMPLATES[name]) {
      const { at = 0, ...p } = props, c = { id: hex12(), start: t0 + at, dur: 3, text: 'Your text', x: 0.5, y: 0.42, ...p, style: { ...TEXT_PRESETS[preset], ...style } };
      P.text.push(c);
      S.sel = { lane: 'text', id: c.id };
    }
  });
  toast(`${name} added: click a line to change its words`);
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
  const paras = timed ? [timed.map(w => w.w)] : String(it.text ?? '').split('\n').map(p => p.split(/\s+/).filter(Boolean));
  let active = -1;
  if (timed && st.hl) timed.forEach((w, i) => { if (lt >= w.s) active = i; });
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
  const cjk = /[぀-ヿ㐀-鿿＀-￯　-〿]/.test(paras.flat().join('')); // Chinese / Japanese words are characters: no gaps
  const sp = (cjk ? 0 : ctx.measureText(' ').width) + LS, maxW = st.maxW * P.w * k, lines = [];
  const grow = timed && st.pop ? 1.12 : 1; // every word reserves its popped width: no overlap, and the line doesn't jitter
  let idx = 0;
  for (const para of paras) {
    let ln = { ws: [], w: 0 };
    for (let w of para) {
      if (st.upper) w = w.toUpperCase();
      const ww = meas(w);
      if (ln.ws.length && ln.w + sp + ww * grow > maxW) { lines.push(ln); ln = { ws: [], w: 0 }; }
      ln.w += (ln.ws.length ? sp : 0) + ww * grow;
      ln.ws.push({ w, ww, i: idx++ });
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
  for (const [li, ln] of lines.entries()) {
    let cx = lx(ln);
    const cy = top + li * lh + lh / 2;
    for (const w of ln.ws) {
      const on = w.i === active, wx = cx + (w.ww * grow - w.ww) / 2, chars = [...w.w], vis = left >= chars.length ? w.w : chars.slice(0, Math.max(0, left)).join('');
      left -= chars.length;
      if (!vis) { cx += w.ww * grow + sp; continue; } // not typed yet: its place stays reserved
      ctx.save();
      if (on && st.pop) { ctx.translate(wx + w.ww / 2, cy); ctx.scale(grow, grow); ctx.translate(-(wx + w.ww / 2), -cy); }
      if (st.shadow) { ctx.shadowColor = hexA(st.shc || '#000000', st.sha ?? 0.55); ctx.shadowBlur = size * (st.shb ?? 0.18); ctx.shadowOffsetX = size * (st.shx || 0); ctx.shadowOffsetY = size * (st.shy ?? 0.04); }
      if (st.strokeW > 0) { ctx.lineWidth = st.strokeW * u * 2; ctx.strokeStyle = st.stroke; put(true, vis, wx, cy); ctx.shadowColor = 'transparent'; }
      ctx.fillStyle = on ? st.hl : gradFill || st.color;
      put(false, vis, wx, cy);
      ctx.restore();
      cx += w.ww * grow + sp;
    }
  }
  if (ctx !== main) { main.setTransform(1, 0, 0, 1, 0, 0); main.globalAlpha = fade; main.drawImage(ctx.canvas, 0, 0); ctx = main; }
  ctx.restore();
  if (preview) {
    const bw = Math.max(size, ...lines.map(l => l.w)) / 2 + padX;
    hits.push({ lane, id: it.id, x0: x - bw, y0: top, x1: x + bw, y1: top + lines.length * lh, rot: pr.rot || 0 });
  }
}
function frame(now) {
  rafId = 0;
  if (!P) return;
  if (S.playing) {
    // the clock waits while the main video stalls (starting, seeking, or WebKit re-buffering, which it does ~0.5 s into a fresh
    // load while still reporting HAVE_ENOUGH_DATA): a clock that ran on left it behind, re-seeked it and stalled it again, every
    // 0.7 s (a 1080p30 clip showed 18 of 30 frames/s). At most 1.5 s per stall, so a video that never moves can't stop playback.
    // A video that has started but not moved yet doesn't count: the clock picks up where the picture really is once it
    // moves (and when it drifts 60 ms off), because the sound is scheduled from the clock: picture and sound start together.
    const v = S.lead, dt = now - (S.last ?? now), was = S.stuck;
    S.last = now;
    if (v !== S.vEl) { S.vEl = v; S.vt = v?.currentTime; S.vAt = now; S.vMoved = !!v?._run; }
    const moved = v && v.currentTime !== S.vt;
    if (moved) { S.vt = v.currentTime; S.vAt = now; }
    const first = moved && !S.vMoved;
    if (moved) S.vMoved = true;
    const stuck = v && !v.ended && (!S.vMoved || v.paused || v.seeking || v.readyState < 3 || now - S.vAt > 80);
    if (stuck && (S.held += dt) < 1500) S.wall0 += dt; else if (!stuck) S.held = 0;
    S.stuck = stuck && S.held < 1500; // the other tracks wait too (sync), instead of running ahead and being seeked back
    S.t = Math.min(S.t0 + ((now - S.wall0) / 1000) * S.rate, S.end); // S.rate: L shuttles at 2x, 4x
    const lc = S.leadClip;
    if (moved && !S.stuck && lc && M.get(lc.media)?.kind !== 'image') {
      const tl = lc.start + (v.currentTime - lc.in) / lc.speed;
      if ((first || was || Math.abs(tl - S.t) > 0.06 * S.rate) && tl >= lc.start && tl < lc.start + tdur(lc, 'main')) { S.wall0 -= ((tl - S.t) * 1000) / S.rate; S.t = Math.min(tl, S.end); }
    }
    if (S.t >= S.end) pause();
    const f = Math.floor(S.t * P.fps); // a new picture when the project's next frame is due, not every display refresh
    if (f !== S.shown || !S.playing) { S.shown = f; S.dirty = true; placePlayhead(); follow(); }
    audioTick(now);
    kick();
  }
  if (S.dirty) { S.dirty = false; paint(); }
}
function play() {
  const D = total();
  if (D <= 0) return;
  if (S.t >= D - 1e-3) S.t = 0;
  closeSource();
  audioOn();
  if (!S.playing) busy(1);
  shuttleBack(0);
  Object.assign(S, { playing: true, rate: 1, end: D, t0: S.t, wall0: performance.now(), last: undefined, held: 0, stuck: false, vAt: performance.now(), vEl: undefined, dirty: true });
  $('#btnPlay').innerHTML = ICON.pause;
}
function pause() { shuttleBack(0); if (S.playing) busy(-1); S.playing = false; S.rate = 1; audioStop(); audioWarm(); audioNapLater(); S.t = snap(S.t); S.dirty = true; $('#btnPlay').innerHTML = ICON.play; placePlayhead(); if (S.sel) renderInspector(); }

// ---------- edits ----------
function addMedia(id, lane, t, range) { // range: [in, out] marked in the source viewer
  const m = M.get(id);
  if (!m) return;
  lane = m.kind === 'audio' ? 'audio' : lane === 'overlay' ? 'overlay' : 'main';
  const c = { id: hex12(), media: id, start: 0, in: range ? range[0] : 0, out: range ? range[1] : m.kind === 'image' ? 3 : m.duration, speed: 1, volume: 1, fit: lane === 'overlay' ? 'fill' : 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } };
  change(() => {
    if (lane === 'main') { packMain(); P.main.splice(t === undefined ? P.main.length : P.main.filter(x => x.start + tdur(x, 'main') / 2 < t).length, 0, c); }
    else { c.start = Math.max(0, t ?? S.t); P[lane].push(c); }
    S.sel = { lane, id: c.id };
  });
}
// ---------- multicam: angles lined up by their sound, cut between while it plays (keys 1-6) ----------
async function makeMulticam(list) {
  const ms = [...new Set(list.map(q => mediaBy(q)))];
  if (ms.length < 2 || ms.length > 6 || ms.some(m => m.kind !== 'video')) throw new Error('pick 2 to 6 videos for a multicam');
  const { offsets, confidence } = await api('/api/sync', { media: ms.map(m => m.id) });
  const angles = ms.map((m, i) => ({ media: m.id, off: offsets[i] }));
  const lo = Math.max(0, ...angles.map(a => -a.off)), hi = Math.min(...angles.map((a, i) => ms[i].duration - a.off)); // master time every angle has
  if (hi - lo < 1) throw new Error('the recordings barely overlap: nothing to cut between');
  const g = hex12(), base = { speed: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } };
  change(() => {
    const start = packMain(), v = { ...base, id: hex12(), media: ms[0].id, start, in: lo, out: hi, volume: 0, mc: { g, angles, a: 0 } };
    P.main.push(v);
    P.audio.push({ ...base, id: hex12(), media: ms[0].id, start, in: lo, out: hi, volume: 1, mcAudio: g }); // one continuous sound: angle 1's
    S.sel = { lane: 'main', id: v.id }; S.multi.clear();
  });
  toast(`Multicam: ${ms.length} angles synced by sound. Play it and press 1-${ms.length} to cut between them`);
  return { angles: ms.map((m, i) => ({ angle: i + 1, media: m.name, offset: offsets[i], confidence: confidence[i] })), clip: brief(...cfind(S.sel.id)) };
}
function mcCut(j, at = S.t) { // from the playhead on, the multicam shows angle j (a split, unless the playhead is at the clip's start)
  packMain();
  const c = P.main.find(x => x.mc && at >= x.start - 1e-6 && at < x.start + tdur(x, 'main'));
  if (!c) { toast('Put the playhead on a multicam clip'); return null; }
  const A = c.mc.angles[j];
  if (!A) { toast(`This multicam has ${c.mc.angles.length} angles`); return null; }
  if (j === c.mc.a) return c;
  const lt = at - c.start, m0 = c.in + lt * c.speed - c.mc.angles[c.mc.a].off, src = M.get(A.media), d = (c.out - c.in) - lt * c.speed;
  if (!src || m0 + A.off < -1e-3 || m0 + A.off + d > src.duration + 1e-3) { toast(`Angle ${j + 1} has no footage there`); return null; }
  let t;
  change(() => {
    t = lt > 1 / P.fps ? splitClip(c, 'main', snap(at)) : c;
    const span = t.out - t.in, mm = t.in - t.mc.angles[t.mc.a].off;
    Object.assign(t, { media: A.media, in: Math.max(0, mm + A.off), mc: { ...t.mc, a: j } });
    t.out = t.in + span;
    S.sel = { lane: 'main', id: t.id };
  });
  return t;
}
function openMulticam() {
  const vids = [...M.values()].filter(m => m.kind === 'video' && m.hasAudio);
  modal(`<h2>Multicam</h2><p class="hint">Tick the recordings of the same moment (2 to 6). They are lined up by their sound, so each needs its own; the first one ticked is angle 1 and gives the sound.</p>
    <div class="mclist">${vids.map(m => `<label class="row chk"><span title="${esc(m.name)}">${esc(m.name)}</span><small>${fmtDur(m.duration)}</small><input type="checkbox" value="${m.id}"></label>`).join('') || '<p class="hint">Import videos with sound first.</p>'}</div>
    <p id="mcStatus" class="muted"></p><div class="actions"><button data-close>Close</button><button id="mcGo" class="primary">Sync and add</button></div>`);
  const order = [];
  $('#modal .mclist').addEventListener('change', e => { const v = e.target.value; if (e.target.checked) order.push(v); else order.splice(order.indexOf(v), 1); });
  $('#mcGo').addEventListener('click', async () => {
    $('#mcGo').disabled = true; $('#mcStatus').textContent = 'Listening to the recordings…';
    try { await makeMulticam(order); closeModal(); } catch (e) { $('#mcStatus').textContent = e.message; } finally { const b = $('#mcGo'); if (b) b.disabled = false; }
  });
}
// ---------- compound clips: several clips rendered into one (one video to decode instead of many), and back apart ----------
async function makeCompound(sel = selection()) {
  const items = sel.filter(([, L]) => !['tr', 'captions'].includes(L)), mains = items.filter(([, L]) => L === 'main').map(([c]) => c);
  if (items.length < 2) throw new Error('select two or more clips (⇧-click) to make a compound clip');
  if (!mains.length) throw new Error('a compound clip needs a main-track clip in it: it becomes one main clip');
  if (items.some(([c]) => c.media && !M.get(c.media))) throw new Error('a selected clip has missing media: relink it first');
  packMain();
  const idx = mains.map(c => P.main.indexOf(c)).sort((a, b) => a - b);
  if (idx.at(-1) - idx[0] !== idx.length - 1) throw new Error('the main-track clips in it must be next to each other');
  const t0 = P.main[idx[0]].start, inner = { main: idx.map(i => structuredClone(P.main[i])), overlay: [], audio: [], text: [], fx: [] };
  for (const [c, L] of items) if (L !== 'main') inner[L].push({ ...structuredClone(c), start: c.start - t0 });
  const lastTr = inner.main.at(-1).tr;
  delete inner.main.at(-1).tr;
  const P0 = P, name = `Compound ${new Date().toLocaleTimeString().replace(/:\d\d\s/, ' ')}`;
  const sub = migrate({ ...structuredClone(P0), id: hex12(), name, ...inner, captions: [], markers: [], tracks: {}, mute: {} });
  let plan;
  S.hold = true; // the preview and autosave leave the borrowed project alone
  try { P = sub; packMain(); plan = await buildPlan(even(P.w), even(P.h), 'fast', name, false, 'mp4'); }
  finally { P = P0; S.hold = false; S.dirty = true; }
  Object.assign(plan, { library: true, rate: 2.5 });
  const j = await job('/api/export', plan, 'Making the compound clip');
  await loadMedia();
  const m = M.get(j.media);
  if (!m) throw new Error('the compound render did not reach the library');
  change(() => {
    const ids = new Set(items.map(([c]) => c.id));
    for (const L of LANES) P[L.key] = P[L.key].filter(c => !ids.has(c.id));
    const cc = { id: hex12(), media: m.id, start: t0, in: 0, out: m.duration, speed: 1, volume: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 }, compound: { ...inner, lastTr } };
    if (lastTr) cc.tr = lastTr;
    P.main.splice(idx[0], 0, cc);
    S.sel = { lane: 'main', id: cc.id }; S.multi.clear();
  });
  toast(`${items.length} clips are one compound clip now (Break apart gets them back)`);
  return brief(...cfind(S.sel.id));
}
function breakCompound(c) { // the clips it was made of, back where they were (edits made to the compound itself are dropped)
  const k = c?.compound;
  if (!k) throw new Error('that is not a compound clip');
  change(() => {
    packMain();
    const i = P.main.indexOf(c), t0 = c.start, mains = k.main.map(x => ({ ...structuredClone(x), id: hex12() }));
    if (c.tr) mains.at(-1).tr = c.tr; else delete mains.at(-1).tr;
    P.main.splice(i, 1, ...mains);
    for (const L of ['overlay', 'audio', 'text', 'fx']) for (const x of k[L] || []) P[L].push({ ...structuredClone(x), id: hex12(), start: x.start + t0 });
    S.sel = { lane: 'main', id: mains[0].id }; S.multi.clear();
  });
  toast('Broken apart into its clips');
}
function addText(name, props = {}, style = {}) { // one undo step, whatever it starts with
  change(() => {
    const c = { id: hex12(), start: S.t, dur: 3, text: { Title: 'Your title', Sticker: '🔥' }[name] || 'Your text', x: 0.5, y: 0.42, ...props, style: { ...TEXT_PRESETS[name], ...style } };
    P.text.push(c);
    S.sel = { lane: 'text', id: c.id };
  });
}
function editText() { const t = $('#inspector textarea[data-k="c.text"]'); t?.focus(); t?.select(); } // typing after Add text goes into the text, not the shortcuts (it split the video)
function split() {
  packMain();
  const t = S.t, inside = (x, lane) => t > x.start + 1e-6 && t < x.start + tdur(x, lane) - 1e-6;
  let lane = S.sel?.lane === 'tr' ? 'main' : S.sel?.lane, c = selClip();
  if (!c || !inside(c, lane)) { lane = 'main'; c = P.main.find(x => inside(x, 'main')); }
  if (!c) return toast('Put the playhead over a clip to split it');
  if (locked(lane, c)) return toast('That track is locked: click its lock to edit it'); // (S, Q, W went through on a locked track)
  change(() => { S.sel = { lane, id: splitClip(c, lane, t).id }; });
}
function splitClip(c, lane, t) { // cut c at timeline time t; returns the right half, inserted after c
  {
    const lt = t - c.start, b = structuredClone(c);
    b.id = hex12();
    b.start = t;
    delete c.tr; // the outgoing transition now belongs to the second half
    const d = tdur(c, lane); // keyframes, envelope and animations follow their halves (an interpolated keyframe on both sides of the cut)
    if (c.kf) { b.kf = sliceKf(c, lt, d); c.kf = sliceKf(c, 0, lt); }
    if (c.vkf) { b.vkf = sliceEnv(c, lt, d); c.vkf = sliceEnv(c, 0, lt); }
    if (c.anim) { b.anim = partAnim(c.anim, false, true); c.anim = partAnim(c.anim, true, false); }
    if (c.media) { const at = c.in + lt * c.speed; c.out = at; b.in = at; c.fadeOut = 0; b.fadeIn = 0; }
    else {
      b.dur = c.dur - lt; c.dur = lt;
      if (c.words) {
        c.words = c.words.filter(w => w.s < lt);
        b.words = b.words.filter(w => w.s >= lt).map(w => ({ ...w, s: w.s - lt, e: w.e - lt }));
        c.text = c.words.map(w => w.w).join(' ');
        b.text = b.words.map(w => w.w).join(' ');
      }
    }
    P[lane].splice(P[lane].indexOf(c) + 1, 0, b);
    return b;
  }
}
function del() {
  const many = selection().filter(([x, lane]) => !locked(lane, x));
  if (many.length > 1) { change(() => { for (const [x, lane] of many) P[lane] = P[lane].filter(y => y !== x); S.sel = null; S.multi.clear(); }); return toast(`Deleted ${many.length} clips`); }
  const c = selClip();
  if (!c) return;
  if (locked(S.sel.lane, c)) return toast('That track is locked: click its lock to edit it');
  if (S.sel.lane === 'tr') return change(() => { delete c.tr; });
  change(() => { P[S.sel.lane] = P[S.sel.lane].filter(x => x !== c); S.sel = null; });
}
function dup() {
  const many = selection().filter(([x, l]) => !locked(l, x));
  if (many.length > 1) { // all of them (it duplicated just the one clicked last)
    change(() => {
      packMain();
      for (const [x, l] of many) { const b = { ...structuredClone(x), id: hex12() }; if (l === 'main') { delete b.tr; P.main.splice(P.main.indexOf(x) + 1, 0, b); } else { b.start = x.start + tdur(x, l); P[l].push(b); } }
    });
    return toast(`Duplicated ${many.length} clips`);
  }
  const c = selClip(), lane = S.sel?.lane;
  if (!c || lane === 'tr') return;
  if (locked(lane, c)) return toast('That track is locked: click its lock to edit it');
  change(() => {
    const b = { ...structuredClone(c), id: hex12() };
    if (lane !== 'main') b.start = c.start + tdur(c, lane);
    P[lane].splice(P[lane].indexOf(c) + 1, 0, b);
    S.sel = { lane, id: b.id };
  });
}

function cutMain(rm, pad = 0, key = c => c.media, min = 0.1, drop = false) { // main clips without the given source ranges (pauses, filler words, script cuts): jump cuts; keyframes, envelopes, animations kept
  return P.main.flatMap(c => {
    const ss = rm.get(key(c));
    if (!ss?.length) return [c];
    const keep = [];
    let cur = c.in;
    for (const [a, b] of [...ss].sort((x, y) => x[0] - y[0])) {
      const s0 = Math.max(a + pad, c.in), e = Math.min(b - pad, c.out); // pad > 0 keeps a little air around speech
      if (e - s0 < min) continue;
      if (s0 > cur) keep.push([cur, s0]);
      cur = Math.max(cur, e);
    }
    if (c.out > cur) keep.push([cur, c.out]);
    const parts = keep.filter(([a, b]) => (b - a) / c.speed >= 2 / P.fps);
    if (!parts.length) return drop ? [] : [c]; // a script cut of every word removes the clip
    if (parts.length === 1 && parts[0][0] === c.in && parts[0][1] === c.out) return [c];
    const last = parts.length - 1; // jump cuts are hard cuts: only the last piece keeps the clip's outgoing transition
    return parts.map(([a, b], i) => ({ ...structuredClone(c), id: i ? hex12() : c.id, in: a, out: b, fadeIn: i ? 0 : c.fadeIn, fadeOut: i === last ? c.fadeOut : 0, tr: i === last ? c.tr : undefined,
      kf: sliceKf(c, (a - c.in) / c.speed, (b - c.in) / c.speed), vkf: sliceEnv(c, (a - c.in) / c.speed, (b - c.in) / c.speed), anim: partAnim(c.anim, i === 0, i === last) }));
  });
}
async function removeFillers() { // um / uh / er / hmm from the on-device transcript, cut at the middle of the pauses around them
  const ids = [...new Set(P.main.filter(c => M.get(c.media)?.hasAudio).map(c => c.media))];
  if (!ids.length) return toast('Remove fillers works on main-track clips with speech');
  const btn = $('#btnFillers');
  btn.disabled = true;
  try {
    const rm = new Map();
    for (const [i, id] of ids.entries()) {
      toast(`Listening for filler words ${i + 1}/${ids.length}…`);
      rm.set(id, (await api('/api/fillers', { media: id, lang: $('#capLang').value, ranges: usedSpans(id, P.main) })).fillers.map(f => [f.s, f.e]));
    }
    packMain();
    const hit = P.main.reduce((n, c) => n + (rm.get(c.media) || []).filter(([a, b]) => b > c.in && a < c.out).length, 0), before = packMain(), next = cutMain(rm);
    if (!hit || JSON.stringify(next) === JSON.stringify(P.main)) return toast('No filler words found');
    change(() => { P.main = next; });
    toast(`Removed ${hit} filler word${hit === 1 ? '' : 's'} (${(before - packMain()).toFixed(1)} s)`);
    await resyncCaptions();
  } catch (e) { toast(e.message); throw e; }
  finally { btn.disabled = false; }
}
async function removePauses(minSec) { // CapCut's "remove pauses": silencedetect, then split main clips around the gaps
  const ids = [...new Set(P.main.filter(c => M.get(c.media)?.hasAudio).map(c => c.media))];
  if (!ids.length) return toast('Remove pauses works on main-track clips with sound');
  const min = typeof minSec === 'number' ? minSec : +$('#pauseLen').value, pad = 0.1, btn = $('#btnPauses');
  btn.disabled = true;
  try {
    const sil = new Map();
    for (const id of ids) sil.set(id, (await api('/api/silences', { media: id, noise: -35, min })).silences);
    const next = cutMain(sil, pad);
    const before = packMain();
    if (JSON.stringify(next) === JSON.stringify(P.main)) return toast(`No pauses longer than ${min} s`);
    change(() => { P.main = next; });
    toast(`Removed ${(before - packMain()).toFixed(1)} s of pauses`);
    await resyncCaptions();
  } catch (e) { toast(e.message); throw e; }
  finally { btn.disabled = false; }
}

const setStatus = msg => { if (remoteLog) remoteLog.push(String(msg)); const s = $('#clipStatus'); if (s) s.textContent = msg; else toast(msg); };
const sayIn = sel => msg => { const e = $(sel); if (e) e.textContent = msg; else setStatus(msg); }; // a panel's own status line (job progress toasts sat on the transport)
let busyN = 0; // the Mac app keeps App Nap off only while this is above 0
const busy = d => { const was = busyN > 0; busyN = Math.max(0, busyN + d); if (was !== busyN > 0) window.webkit?.messageHandlers?.busy?.postMessage(busyN > 0); };
const running = new Set(); // clip jobs in flight: a second click (nothing showed progress) reversed the wrong range into a second copy
async function job(path, body, label, say = setStatus) { // start a server job and poll it, showing progress next to the clip (or where say puts it)
  const key = body?.media && `${path}:${body.media}:${body.t0 ?? ''}:${body.t1 ?? ''}`;
  if (running.has(key)) throw new Error(`Already ${label.toLowerCase()} this clip`);
  if (key) running.add(key);
  busy(1);
  const t0 = performance.now();
  let last = -1, still = t0;
  try {
    const { job: id } = await api(path, body);
    for (;;) {
      await new Promise(r => setTimeout(r, 500));
      const j = await api(`/api/jobs/${id}`);
      if (j.state === 'done') return j;
      if (j.state !== 'running') throw new Error(j.error || `${label} failed`); // already one plain sentence
      const pct = Math.round((j.progress || 0) * 100), secs = Math.round((performance.now() - t0) / 1000);
      if (pct !== last) { last = pct; still = performance.now(); }
      say(pct && performance.now() - still < 1000 ? `${label}… ${pct}%` : `${label}… ${secs} s`); // a step without progress steps (a model loading) still shows it's alive
    }
  } finally { busy(-1); running.delete(key); }
}
function kfOp(c, lane, op) {
  const lt = snap(clamp(S.t - c.start, 0, tdur(c, lane))), near = x => Math.abs(x.t - lt) < 0.5 / P.fps;
  change(() => {
    if (op === 'add') c.kf = [...(c.kf || []).filter(x => !near(x)), { t: lt, ...propsAt(c, lt) }].sort((a, b) => a.t - b.t);
    else if (op === 'del') { c.kf = c.kf.filter(x => !near(x)); if (!c.kf.length) delete c.kf; }
    else { Object.assign(c, propsAt(c, lt)); delete c.kf; } // clear: keep the values under the playhead
  });
}
async function detectBeats(c) {
  setStatus('Detecting beats…');
  try { const r = await api('/api/beats', { media: c.media }); change(() => { c.beats = r.beats; c.bpm = r.bpm; }); }
  catch (e) { setStatus(e.message); throw e; }
}
function beatSync(c, every) { // every main clip ends on a beat mark (CapCut's beat sync)
  const marks = c.beats.filter(b => b >= c.in && b <= c.out).map(b => c.start + (b - c.in) / c.speed).filter((_, i) => i % every === 0);
  if (marks.length < 2) return toast('Not enough beats under the music clip');
  let short = 0;
  change(() => {
    for (const x of P.main) {
      packMain();
      const end = marks.find(mk => mk > x.start + 0.25), m = M.get(x.media);
      if (end === undefined || !m) continue;
      const want = (end - x.start) * x.speed;
      if (m.kind === 'image' || x.in + want <= m.duration) x.out = x.in + want; else short++;
    }
  });
  toast(`Main cuts now land on every ${every > 1 ? `${every} beats` : 'beat'}${short ? ` (${short} clip${short > 1 ? 's are' : ' is'} too short to reach the next beat and kept ${short > 1 ? 'their' : 'its'} length)` : ''}`);
}
async function sceneSplit(c, lane) { // CapCut's scene detection: cut the clip at every hard cut in its source
  setStatus('Finding scene changes…');
  try {
    const { times } = await api('/api/scenes', { media: c.media });
    packMain();
    const cuts = times.filter(t => t > c.in + 2 / P.fps && t < c.out - 2 / P.fps).map(t => snap(c.start + (t - c.in) / c.speed)).sort((x, y) => y - x);
    if (!cuts.length) return setStatus('No scene changes inside this clip');
    change(() => { for (const t of cuts) splitClip(c, lane, t); }); // last cut first: c stays the first part
    setStatus(`Split into ${cuts.length + 1} scenes`);
  } catch (e) { setStatus(e.message); throw e; }
}
async function freeze(c, lane) {
  const lt = S.t - c.start;
  if (lt < 0 || lt > tdur(c, lane)) return toast('Put the playhead over the clip');
  setStatus('Grabbing frame…');
  try {
    const img = await api('/api/still', { media: c.media, t: c.in + lt * c.speed });
    await loadMedia();
    change(() => {
      const pr = propsAt(c, lt), fr = { ...structuredClone(c), id: hex12(), media: img.id, start: S.t, in: 0, out: 2, speed: 1, fadeIn: 0, fadeOut: 0,
        scale: pr.scale, x: pr.x, y: pr.y, opacity: pr.opacity, rot: pr.rot }; // the still holds the frame exactly where it was
      delete fr.kf; delete fr.tr; delete fr.vkf; delete fr.duck; delete fr.anim;
      if (lane !== 'main') P[lane].push(fr);
      else {
        const i = P.main.indexOf(c);
        if (lt > 1 / P.fps && lt < tdur(c, 'main') - 1 / P.fps) {
          const d = tdur(c, 'main'), b = { ...structuredClone(c), id: hex12(), in: c.in + lt * c.speed, fadeIn: 0, kf: sliceKf(c, lt, d), vkf: sliceEnv(c, lt, d), anim: partAnim(c.anim, false, true) };
          Object.assign(c, { kf: sliceKf(c, 0, lt), vkf: sliceEnv(c, 0, lt), anim: partAnim(c.anim, true, false) });
          c.out = b.in; c.fadeOut = 0; delete c.tr;
          P.main.splice(i + 1, 0, fr, b);
        } else P.main.splice(lt <= 1 / P.fps ? i : i + 1, 0, fr);
      }
      S.sel = { lane, id: fr.id };
    });
  } catch (e) { setStatus(e.message); throw e; }
}
function moveLane(c, lane) {
  const to = lane === 'main' ? 'overlay' : 'main';
  change(() => {
    packMain();
    const st = c.start;
    P[lane] = P[lane].filter(x => x !== c);
    delete c.tr;
    if (to === 'overlay') { c.start = st; P.overlay.push(c); } else P.main.splice(P.main.filter(x => x.start < st).length, 0, c);
    S.sel = { lane: to, id: c.id };
  });
}
async function removeBackground(c) { // Apple Vision: person segmentation for video, subject lifting (any subject) for photos
  try {
    const pid = P.id, was = c.media, t0 = c.in, img = M.get(c.media)?.kind === 'image', j = img ? await api('/api/lift', { media: c.media }) : await job('/api/matte', { media: c.media, t0: c.in, t1: c.out }, 'Removing background');
    await loadMedia();
    c = live(c, pid, was);
    const d = M.get(j.media)?.duration ?? Infinity; // the cutout covers the part the clip used when it started: a trim meanwhile maps onto it
    change(() => { if (!img) { c.in = clamp(c.in - t0, 0, d); c.out = clamp(c.out - t0, c.in + 1 / P.fps, d); } c.media = j.media; });
    toast('Background removed. Put it on the overlay track over B-roll.');
  } catch (e) { setStatus(e.message); throw e; }
}
function ramp(c, lane, name) { // speed curve baked into 8 editable parts (inner cuts are hard cuts)
  const curve = RAMPS[name], n = curve.length, step = (c.out - c.in) / n;
  change(() => {
    const parts = curve.map((s, i) => ({ ...structuredClone(c), id: i ? hex12() : c.id, in: c.in + i * step, out: c.in + (i + 1) * step, speed: clamp(c.speed * s, 0.1, 100),
      fadeIn: i ? 0 : c.fadeIn, fadeOut: i === n - 1 ? c.fadeOut : 0, tr: i === n - 1 ? c.tr : undefined, anim: partAnim(c.anim, i === 0, i === n - 1),
      kf: sliceKf(c, (i * step) / c.speed, ((i + 1) * step) / c.speed, c.speed / clamp(c.speed * s, 0.1, 100)),
      vkf: sliceEnv(c, (i * step) / c.speed, ((i + 1) * step) / c.speed, c.speed / clamp(c.speed * s, 0.1, 100)) }));
    if (lane !== 'main') { let t = c.start; for (const p of parts) { p.start = t; t += len(p); } }
    P[lane].splice(P[lane].indexOf(c), 1, ...parts);
    S.sel = { lane, id: c.id };
  });
  toast(`${RAMP_NAMES[name]} ramp applied`);
}
function detachAudio(c) { // the clip's sound moves to the audio track at the same time; the clip goes silent
  change(() => {
    packMain();
    const a = { id: hex12(), media: c.media, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, denoise: c.denoise,
      fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } };
    P.audio.push(a);
    c.volume = 0;
    S.sel = { lane: 'audio', id: a.id };
  });
}
async function splitStems(c, lane) { // Demucs, four stems: vocals, drums, bass, other -> four audio clips in sync, the source muted
  try {
    const j = await job('/api/isolate', { media: c.media, keep: 'stems' }, 'Splitting into stems');
    await loadMedia();
    let first;
    change(() => {
      packMain();
      for (const [name, id] of Object.entries(j.stems)) {
        const a = { ...structuredClone(c), id: hex12(), media: id, volume: c.volume || 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } };
        for (const k of ['tr', 'kf', 'anim', 'look', 'mask', 'key', 'crop', 'flip', 'blend', 'fx', 'text']) delete a[k];
        P.audio.push(a);
        first ??= a;
      }
      if (lane === 'audio') P.audio.splice(P.audio.indexOf(c), 1); else c.volume = 0;
      S.sel = { lane: 'audio', id: first.id };
    });
    toast('Split into vocals, drums, bass and the rest: four clips on the audio track, in sync');
    return j.stems;
  } catch (e) { setStatus(e.message); throw e; }
}
async function isolateVoice(c, lane, keep = 'voice') { // Demucs on this Mac: the voice alone, or everything but the voice
  try {
    const pid = P.id, was = c.media, j = await job('/api/isolate', { media: c.media, keep }, keep === 'voice' ? 'Isolating the voice' : 'Removing the voice');
    await loadMedia();
    c = live(c, pid, was);
    change(() => {
      if (lane === 'audio') { c.media = j.media; return; } // same length as the source, so the timing holds
      packMain();
      const a = { id: hex12(), media: j.media, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume || 1, fadeIn: c.fadeIn, fadeOut: c.fadeOut, pitch: c.pitch,
        ...(c.vkf ? { vkf: structuredClone(c.vkf) } : {}), fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, adj: { b: 1, c: 1, s: 1 } };
      P.audio.push(a);
      c.volume = 0;
      S.sel = { lane: 'audio', id: a.id };
    });
    toast(keep === 'voice' ? 'Voice isolated: the clean voice is on the audio track and the clip is muted' : 'Voice removed: the music and ambience are on the audio track and the clip is muted');
  } catch (e) { setStatus(e.message); throw e; }
}
function live(c, pid, media) { // after a job: the clip as it is NOW (an undo meanwhile made a new copy of it; another project may be open)
  if (P.id !== pid) throw new Error('Done, but another project is open now: the result is in the library');
  const f = LANES.map(L => P[L.key].find(x => x.id === c.id)).find(Boolean);
  if (!f) throw new Error('Done, but that clip is gone now: the result is in the library');
  if (media && f.media !== media) throw new Error('Done, but that clip shows another file now: the result is in the library');
  return f;
}
async function remake(c, kind) { // reverse / stabilize render a new library item; the clip switches to it
  try {
    const pid = P.id, was = c.media, j = await job(`/api/${kind}`, { media: c.media }, kind === 'reverse' ? 'Reversing' : 'Stabilizing');
    await loadMedia();
    c = live(c, pid, was); // (a relink meanwhile: don't flip a range the result wasn't made for)
    const d = M.get(j.media).duration;
    change(() => {
      if (kind === 'reverse') { const a = c.in, b = c.out; c.in = Math.max(0, d - b); c.out = Math.min(d, d - a); }
      c.media = j.media;
    });
    toast(kind === 'reverse' ? 'Reversed' : 'Stabilized');
  } catch (e) { setStatus(e.message); throw e; }
}
async function denoiseVideo(c, strength = 'light') { // night grain: the clip switches to a cleaned copy of its range
  try {
    const m = M.get(c.media), fps = m?.fps || P.fps, pid = P.id, was = c.media, t0 = Math.floor(c.in * fps + 1e-6) / fps; // from the frame the preview shows at the in point
    const j = await job('/api/denoise', { media: c.media, t0, t1: c.out, strength }, strength === 'strong' ? 'Reducing the noise (strong)' : 'Reducing the noise');
    await loadMedia();
    c = live(c, pid, was);
    const d = M.get(j.media)?.duration ?? Infinity;
    change(() => { c.in = clamp(c.in - t0, 0, d); c.out = clamp(c.out - t0, c.in + 1 / P.fps, d); c.media = j.media; });
    toast('Noise reduced: the clip plays the cleaned copy (undo goes back)');
  } catch (e) { setStatus(e.message); throw e; }
}
async function autoReframe(c) { // keep the largest face centred (CapCut's auto reframe), as eased keyframes
  const m = M.get(c.media);
  try {
    const pid = P.id, was = c.media, j = await job('/api/faces', { media: c.media, t0: c.in, t1: c.out }, 'Finding faces');
    c = live(c, pid, was);
    change(() => {
      c.fit = 'fill';
      const base = propsAt(c, 0), g0 = geom(m, c, P.w, P.h, { ...base, x: 0, y: 0 }), cr = c.crop || {}, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0);
      const mx = Math.max(0, (g0.w - P.w) / 2 / P.w), my = Math.max(0, (g0.h - P.h) / 2 / P.h);
      const pts = j.points.map(p => {
        let u = (p.x + p.w / 2 - (cr.l || 0)) / fx;
        if (c.flip) u = 1 - u;
        const v = (p.y + p.h / 2 - (cr.t || 0)) / fy;
        return { t: (p.t - c.in) / c.speed, x: clamp((0.5 * P.w - (g0.x + u * g0.w)) / P.w, -mx, mx), y: clamp((0.42 * P.h - (g0.y + v * g0.h)) / P.h, -my, my) };
      }).filter(p => p.t >= 0 && p.t <= len(c));
      const avg = (i, k) => { const w = pts.slice(Math.max(0, i - 2), i + 3); return w.reduce((s, q) => s + q[k], 0) / w.length; }; // smooth the jitter
      c.kf = pts.map((p, i) => ({ t: p.t, scale: base.scale, opacity: base.opacity, rot: base.rot, x: avg(i, 'x'), y: avg(i, 'y') })).filter((_, i, a) => i % 2 === 0 || i === a.length - 1);
      c.ease = true;
    });
    toast(`Reframed from ${j.points.length} face samples`);
  } catch (e) { setStatus(e.message); throw e; }
}
// Auto duck is a rule: c.duck = { depth }, and its volume points are re-made from where the other clips have speech after
// every edit (touched) and before an export, so they follow trims and moves. Speech = Silero VAD per file (/api/speech,
// cached there and here); loudness (silencedetect) heard road noise as talk and ducked 99 % of a night-drive song.
const SPEECH = new Map(); // media id -> [[a, b], ...] source seconds, or the promise while it loads
function loadSpeech(id) {
  let s = SPEECH.get(id);
  if (!s) { s = api('/api/speech', { media: id }).then(r => { SPEECH.set(id, r.speech); return r.speech; }); s.catch(() => SPEECH.delete(id)); SPEECH.set(id, s); }
  return Promise.resolve(s);
}
const duckSrc = c => ['main', 'overlay', 'audio'].flatMap(L => (P.mute[L] ? [] : P[L])).filter(x => x !== c && x.media && M.get(x.media)?.hasAudio && x.volume > 0);
function duckSpeech(c) { // the other clips' speech on the timeline, merged across short gaps; null while a file's is loading
  const speech = [];
  let missing = false;
  for (const x of duckSrc(c)) {
    const s = SPEECH.get(x.media);
    if (!Array.isArray(s)) { missing = true; loadSpeech(x.media).then(() => { if (reduck()) { scheduleSave(); renderAll(); } }, () => {}); continue; }
    for (const [a0, b0] of s) { const a = Math.max(a0, x.in), b = Math.min(b0, x.out); if (b - a > 0.05) speech.push([x.start + (a - x.in) / x.speed, x.start + (b - x.in) / x.speed]); }
  }
  if (missing) return null;
  speech.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const s of speech) { const l = merged.at(-1); if (l && s[0] <= l[1] + 0.6) l[1] = Math.max(l[1], s[1]); else merged.push([...s]); }
  return merged.filter(([a, b]) => b > c.start && a < c.start + len(c));
}
function reduck() { // every ducked clip's points from the current edit: dips of c.duck.depth with 0.3 s / 0.5 s ramps; true if any moved
  const ducked = ['main', 'overlay', 'audio'].flatMap(L => P[L].filter(c => c.duck));
  let moved = false;
  if (ducked.length) packMain();
  for (const c of ducked) {
    const sp = duckSpeech(c);
    if (!sp) continue;
    const v1 = c.duck.depth, end = len(c), pts = [{ t: 0, v: 1 }]; // multipliers of the clip volume
    for (const [a, b] of sp) { const s = a - c.start, e = b - c.start; pts.push({ t: Math.max(0, s - 0.3), v: 1 }, { t: Math.max(0, s), v: v1 }, { t: Math.min(end, e), v: v1 }, { t: Math.min(end, e + 0.5), v: 1 }); }
    const vkf = sp.length ? pts.sort((p, q) => p.t - q.t).filter((p, i, arr) => i === 0 || p.t > arr[i - 1].t + 1e-3).map(p => ({ t: +p.t.toFixed(4), v: p.v })) : undefined; // no speech: no points
    if (JSON.stringify(vkf) !== JSON.stringify(c.vkf)) { if (vkf) c.vkf = vkf; else delete c.vkf; moved = true; }
  }
  return moved;
}
async function duckReady() { // before an export: the speech of every file under a ducked clip, then the points
  const ids = new Set();
  for (const L of ['main', 'overlay', 'audio']) for (const c of P[L]) if (c.duck) for (const x of duckSrc(c)) ids.add(x.media);
  await Promise.all([...ids].map(id => loadSpeech(id).catch(() => {})));
  reduck();
}
async function autoDuck(c, depth = 0.25) { // music dips (default 12 dB) wherever another clip has speech
  const src = duckSrc(c);
  if (!src.length) return toast('No other clips with sound to duck under');
  setStatus('Finding speech…');
  try {
    await Promise.all([...new Set(src.map(x => x.media))].map(loadSpeech));
    change(() => { c.duck = { depth }; }); // touched() re-makes the points
    const n = duckSpeech(c)?.length || 0;
    toast(`Music ducks ${Math.round(-20 * Math.log10(depth))} dB under ${n} speech passage${n === 1 ? '' : 's'}`);
  } catch (e) { setStatus(e.message); throw e; }
}
async function smoothSlowmo(c) { // interpolated frames for slow clips (rendered copy of just this range)
  const factor = clamp(Math.round(1 / c.speed), 2, 8);
  try {
    const j = await job('/api/slowmo', { media: c.media, t0: c.in, t1: c.out, factor }, 'Interpolating frames');
    await loadMedia();
    change(() => { const d = c.out - c.in; c.media = j.media; c.in = 0; c.out = Math.min(d, M.get(j.media).duration); });
    toast(`Smooth slow-mo: ${factor}× frames`);
  } catch (e) { setStatus(e.message); throw e; }
}
function toggleMarker() {
  const i = P.markers.findIndex(t => Math.abs(t - S.t) < 0.5 / P.fps);
  change(() => { if (i >= 0) P.markers.splice(i, 1); else P.markers.push(S.t); });
}
let tplCache = [];
async function saveTemplate(name = prompt('Template name', P.name)) { // media become numbered slots
  if (!name) return;
  const t = structuredClone(P), slots = [], idx = new Map();
  for (const L of LANES) for (const c of t[L.key]) {
    if (!c.media) continue;
    if (!idx.has(c.media)) { const m = M.get(c.media); idx.set(c.media, slots.length); slots.push({ kind: m?.kind || 'video', name: m?.name || 'media', need: 0 }); }
    const s = idx.get(c.media);
    slots[s].need = Math.max(slots[s].need, c.out);
    c.media = `slot:${s}`;
  }
  const id = hex12();
  await api(`/api/templates/${id}`, { id, name, slots, w: t.w, h: t.h, project: t }, 'PUT');
  toast(`Template "${name}" saved with ${slots.length} media slot${slots.length === 1 ? '' : 's'}`);
}
async function openTemplates() {
  tplCache = await api('/api/templates').catch(() => []);
  modal(`<h2>Templates</h2><p class="hint">A template keeps the edit (cuts, timing, text, caption style, effects) and swaps in new media.</p>
    <div class="actions"><button data-savetpl>Save this project as a template</button></div>
    <div class="plist">${tplCache.map(t => `<div class="prow"><button class="pitem" data-tpl="${t.id}"><b>${esc(t.name)}</b><span>${t.w}×${t.h} · ${t.slots.length} media slots</span></button><button class="pdel" data-deltpl="${t.id}">Delete</button></div>`).join('') || '<p class="hint">No templates yet.</p>'}</div>
    <div id="tplSlots"></div><div class="actions"><button data-close>Close</button></div>`);
}
function showTemplate(id) {
  const t = tplCache.find(x => x.id === id);
  const opts = kind => [...M.values()].filter(m => m.kind === kind || (kind !== 'audio' && m.kind !== 'audio')).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#tplSlots').innerHTML = `<h4>${esc(t.name)}: choose media</h4>${t.slots.map((s, i) => `<label class="row"><span>${i + 1}. ${esc(s.kind)}, ${fmtDur(s.need)}+</span><select data-slot="${i}">${opts(s.kind)}</select></label>`).join('')}
    <div class="actions"><button class="primary" data-usetpl="${t.id}">Create project</button></div>`;
}
function useTemplate(id) {
  const t = tplCache.find(x => x.id === id), pick = $$('[data-slot]').map(s => s.value);
  if (pick.some(v => !v)) return toast('Import media for every slot first');
  const p = structuredClone(t.project);
  p.id = hex12();
  p.name = `${t.name} ${new Date().toLocaleDateString()}`;
  for (const L of LANES) for (const c of p[L.key] || []) { // templates made before a lane existed don't have it
    if (typeof c.media !== 'string' || !c.media.startsWith('slot:')) continue;
    const m = M.get(pick[+c.media.slice(5)]);
    c.media = m.id;
    if (m.kind !== 'image') { c.out = Math.min(c.out, m.duration); c.in = Math.min(c.in, Math.max(0, c.out - 0.1)); }
    delete c.beats;
  }
  setProject(p); scheduleSave(); closeModal();
  toast('Project created from the template');
}
async function uploadOne(file) {
  const r = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: file });
  const m = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(m.error || 'import failed');
  await loadMedia();
  return m;
}
// ---------- voiceover from the mic ----------
// The take is the mic's samples as the audio graph receives them (an AudioWorklet stamps the first one's frame), not a
// MediaRecorder file: its first sample lands an unknown 40-50 ms after start(). A sample that reached the graph at
// context time c was spoken when the speakers played context time c - lat, and audioTick logs S.t - out (timeline time
// minus the context time heard) every frame, so its timeline time is c - lat + off. lat, the mic's delay, is measured on
// every take: three count-in blips from the speakers, found in the take. With headphones the mic doesn't hear them:
// then the last measured delay, else what the browser reports, else 0.
// ponytail: one offset per take (the median frame); a video stall mid-take (the clock holds up to 1.5 s) shifts the part
// before it. Raw float samples in memory: ~12 MB a minute.
let rec = null, recMod;
const REC_JS = `registerProcessor('cutroom-rec', class extends AudioWorkletProcessor { process([i]) {
  const d = new Float32Array(i.length ? i[0].length : 128); // no channels = an input sending nothing (yet): silence keeps the time
  for (const ch of i) for (let k = 0; k < d.length; k++) d[k] += ch[k] / i.length;
  this.port.postMessage([currentFrame, d], [d.buffer]); return true; } });`;
const BLIPS = 3, BLIP_S = 0.45;
function blip(sr) { // 10 ms chirp 1-4 kHz: one sharp correlation peak
  const n = Math.round(sr / 100), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; b[i] = 0.5 * Math.sin(2 * Math.PI * (1000 * t + 150000 * t * t)) * Math.sin((Math.PI * i) / n); }
  return b;
}
function blipLag(x, i0, tpl, w) { // the lag (samples) past i0 where x best matches tpl, and how well (normalised correlation)
  let e = 0, best = 0, at = 0;
  for (const v of tpl) e += v * v;
  for (let l = 0; l < w && i0 + l + tpl.length <= x.length; l++) {
    let s = 0, q = 0;
    for (let j = 0; j < tpl.length; j++) { const v = x[i0 + l + j]; s += v * tpl[j]; q += v * v; }
    const r = s / Math.sqrt(e * q + 1e-12);
    if (r > best) { best = r; at = l; }
  }
  return [at, best];
}
function wavMono(x, sr) { // 16-bit PCM: the export seeks a WAV to the sample
  const b = new DataView(new ArrayBuffer(44 + x.length * 2)), str = (o, s) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); b.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) b.setInt16(44 + i * 2, Math.round(clamp(x[i], -1, 1) * 32767), true);
  return b.buffer;
}
async function toggleRecord() { // the timeline plays muted (unless "hear the project" is on) so it doesn't bleed in
  const btn = $('#btnRec');
  if (rec) return rec.stop();
  if (S.playing) pause();
  const r = (rec = { offs: [], parts: [], f1: 0, hear: $('#recHear').checked, stop() {} }); // a click while the mic opens does nothing
  let stream, src, node;
  try {
    audioOn();
    await actx.resume();
    await (recMod ??= actx.audioWorklet.addModule(URL.createObjectURL(new Blob([REC_JS], { type: 'text/javascript' }))));
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); // echo cancelling would take the blips out
    const A = actx, sr = A.sampleRate, go = A.currentTime + 0.3 + BLIPS * BLIP_S; // count-in, then the timeline plays
    src = A.createMediaStreamSource(stream); node = new AudioWorkletNode(A, 'cutroom-rec');
    node.port.onmessage = ({ data: [f, d] }) => {
      if (r.f0 === undefined) r.f0 = r.f1 = f;
      if (f > r.f1) r.parts.push(new Float32Array(f - r.f1)); // a block the graph skipped: silence keeps the time
      r.parts.push(d); r.f1 = f + d.length;
    };
    src.connect(node).connect(A.destination);
    const tpl = blip(sr), bb = new AudioBuffer({ length: tpl.length, sampleRate: sr, numberOfChannels: 1 }), at0 = go - BLIPS * BLIP_S;
    bb.copyToChannel(tpl, 0);
    for (let k = 0; k < BLIPS; k++) { const s = A.createBufferSource(); s.buffer = bb; s.connect(A.destination); s.start(at0 + k * BLIP_S); }
    const stopped = new Promise(done => { r.stop = () => { r.stopped = true; done(); }; });
    S.recMute = !r.hear; btn.textContent = 'Stop recording';
    if (r.hear) toast('Hearing the project: wear headphones, or the mic records it too');
    await Promise.race([stopped, sleep((go - A.currentTime) * 1000)]);
    if (r.stopped) return toast('Stopped during the count-in: nothing recorded');
    play(); r.t0 = S.t;
    await stopped;
    if (S.playing) pause();
    if (r.f0 === undefined) throw new Error('no sound came in');
    const x = new Float32Array(r.f1 - r.f0), c0 = r.f0 / sr, lags = [];
    for (let o = 0, i = 0; i < r.parts.length; o += r.parts[i++].length) x.set(r.parts[i], o);
    for (let k = 0; k < BLIPS; k++) {
      const i0 = Math.round((at0 + k * BLIP_S - c0) * sr), [l, q] = i0 >= 0 ? blipLag(x, i0, tpl, Math.round(0.4 * sr)) : [0, 0];
      if (q > 0.3) lags.push(l / sr);
    }
    lags.sort((a, b) => a - b);
    const heard = lags.length === BLIPS && lags[BLIPS - 1] - lags[0] < 0.002;
    if (heard) store.set('cutroom.micDelay', lags[1]);
    const lat = heard ? lags[1] : +(store.get('cutroom.micDelay') ?? stream.getAudioTracks()[0]?.getSettings().latency ?? 0) || 0;
    const off = r.offs.length ? r.offs.sort((a, b) => a - b)[r.offs.length >> 1] : r.t0 - go, z = c0 - lat + off, start = Math.max(r.t0, z); // z: the timeline time of the take's first sample
    if (x.length / sr - (start - z) < 0.1) return toast('Stopped as the playback started: nothing recorded');
    const m = await uploadOne(new File([wavMono(x, sr)], `Recording ${new Date().toLocaleTimeString().replace(/:/g, '.')}.wav`, { type: 'audio/wav' }));
    addMedia(m.id, 'audio', start, [start - z, x.length / sr]);
    toggleRecord.last = { lat, heard, start, in: start - z, frames: r.offs.length }; // for tests
  } catch (e) { toast(`Microphone: ${e.message}`); }
  finally {
    src?.disconnect(); node?.disconnect(); stream?.getTracks().forEach(tr => tr.stop());
    rec = null; S.recMute = false; btn.textContent = 'Record voiceover (mic)';
  }
}
function startTrack(c, lane) { // pick a target on the main-track video; the clip then follows it via keyframes
  packMain();
  const host = P.main.find(x => S.t >= x.start && S.t < x.start + tdur(x, 'main'));
  if (!host || M.get(host.media)?.kind !== 'video') return toast('Move the playhead to where the thing to follow is visible on a main-track video');
  if (S.playing) pause();
  S.pick = { c, lane, host };
  toast('Drag a box around what this clip should follow');
}
function canvasToSrc(c, T) { // project-canvas point -> normalized source-frame point of clip c at timeline time T (undoes fit, crop, flip)
  const g = geom(M.get(c.media), c, P.w, P.h, propsAt(c, T - c.start)), cr = c.crop || {}, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0);
  return (cx, cy) => { let u = (cx - g.x) / g.w; if (c.flip) u = 1 - u; return [(cr.l || 0) + u * fx, (cr.t || 0) + ((cy - g.y) / g.h) * fy]; };
}
function startRemove(c, lane, mode = 'remove') { // CapCut's "Remove object" / cutout: box it at any frame; it is followed both ways through the clip
  if (S.t < c.start || S.t >= c.start + tdur(c, lane)) return toast(`Move the playhead to a frame of this clip where the ${mode === 'cutout' ? 'subject' : 'object'} shows`);
  if (S.playing) pause();
  S.pick = { c, lane, remove: true, mode };
  toast(mode === 'cutout' ? 'Drag a box around what to keep (Esc cancels)' : 'Drag a box around the object to remove (Esc cancels)');
}
function srcBox(c, rect, T) { // a box on the project canvas -> the same box in the clip's source frame (normalized)
  const toSrc = canvasToSrc(c, T), [sx, sy] = toSrc(rect.x, rect.y), [ex, ey] = toSrc(rect.x + rect.w, rect.y + rect.h);
  return { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
}
async function tintMask(b64) { // the grey outline PNG as a pink see-through overlay
  const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = `data:image/png;base64,${b64}`; });
  const cv = document.createElement('canvas'), x = cv.getContext('2d', { willReadFrequently: true });
  cv.width = im.width; cv.height = im.height; x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, cv.width, cv.height);
  for (let i = 0; i < d.data.length; i += 4) { const a = d.data[i]; d.data[i] = 255; d.data[i + 1] = 61; d.data[i + 2] = 127; d.data[i + 3] = a; }
  x.putImageData(d, 0, 0);
  return cv;
}
async function maskPreview(c, lane, rect, T, mode, points = []) { // SAM 2's outlines of the box on this frame (part ... whole), the best fit tinted on the preview
  const seq = S.mpSeq = (S.mpSeq || 0) + 1; // only the latest ask is shown: an older answer arriving after it is dropped
  const r = await api('/api/mask_preview', { media: c.media, t: c.in + (T - c.start) * c.speed, box: srcBox(c, rect, T), points, mode });
  const imgs = await Promise.all(r.masks.map(tintMask));
  if (seq !== S.mpSeq) return null;
  S.maskPreview = { id: c.id, c, lane, rect, T, mode, points, b64: r.masks, areas: r.areas, pick: r.pick, unsure: r.unsure, imgs };
  Object.defineProperty(S.maskPreview, 'img', { get() { return this.imgs[this.pick]; } });
  S.dirty = true;
  markPreview();
  return r;
}
function previewFor(c, r) { // the outline previewed for this clip and (about) this box, if any: another box means another object
  const m = S.maskPreview, near = (k, d) => Math.abs(m.rect[k] - r[k]) < 0.02 * d;
  return m?.id === c.id && near('x', P.w) && near('w', P.w) && near('y', P.h) && near('h', P.h) ? m : null;
}
function markPreview() { // the confirm bar's question and its Smaller / Bigger follow the candidates
  const mp = S.maskPreview, bar = $('#confirmBar');
  if (!mp || !bar) return;
  bar.querySelector('span').textContent = mp.unsure ? 'Not sure what you boxed: click on it (⌥-click leaves a spot out)' : mp.mode === 'cutout' ? 'Keep only the pink part?' : 'Remove the pink part from the whole clip?';
  bar.querySelector('[data-smaller]').disabled = mp.pick <= 0;
  bar.querySelector('[data-bigger]').disabled = mp.pick >= mp.imgs.length - 1;
}
function stepPreview(d) { const mp = S.maskPreview; if (!mp) return; mp.pick = clamp(mp.pick + d, 0, mp.imgs.length - 1); S.dirty = true; markPreview(); }
async function refinePreview(cx, cy, keep) { // a click on the frame: include that spot (or, with ⌥, leave it out), and outline again
  const mp = S.maskPreview, [sx, sy] = canvasToSrc(mp.c, mp.T)(cx, cy);
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return;
  setStatus(keep ? 'Adding that spot…' : 'Leaving that spot out…');
  mp.points = [...mp.points, [sx, sy, keep ? 1 : 0]]; // a second quick click builds on this one, not on the last answer
  try { if (await maskPreview(mp.c, mp.lane, mp.rect, mp.T, mp.mode, mp.points)) setStatus(''); } catch (e) { setStatus(e.message); }
}
function overlayMask(ctx, mp, h) { // the tinted outline over the clip's rect h ({x0, y0, x1, y1, rot}, canvas pixels): crop, mirror and rotation as drawn
  const cr = mp.c.crop || {}, b = selBox(h), W = mp.img.width, H = mp.img.height;
  ctx.save(); ctx.translate(b.cx, b.cy); ctx.rotate(b.rad); if (mp.c.flip) ctx.scale(-1, 1);
  ctx.globalAlpha = 0.62;
  ctx.drawImage(mp.img, (cr.l || 0) * W, (cr.t || 0) * H, (1 - (cr.l || 0) - (cr.r || 0)) * W, (1 - (cr.t || 0) - (cr.b || 0)) * H, -b.hw, -b.hh, b.hw * 2, b.hh * 2);
  ctx.restore();
}
function endPreview(go) { // the confirm bar's answer: remove (or cut out) exactly the outline shown, draw the box again, or leave it
  const mp = S.maskPreview;
  if (go === 'smaller' || go === 'bigger') return stepPreview(go === 'smaller' ? -1 : 1);
  S.maskPreview = null; $('#confirmBar').hidden = true; S.dirty = true;
  if (!mp) return;
  if (go === 'ok') removeObject(mp.c, mp.lane, mp.rect, mp.T, 'best', mp.mode, mp.b64[mp.pick]).catch(e => setStatus(e.message));
  else if (go === 'again') { seekTo(mp.T); startRemove(mp.c, mp.lane, mp.mode); }
}
async function removeObject(c, lane, rect, T = S.t, quality = $('#rmQuality')?.value || 'best', mode = 'remove', seed) { // rect in project canvas units; the clip switches to the new copy of its range
  if (S.maskPreview) { S.maskPreview = null; $('#confirmBar').hidden = true; S.dirty = true; }
  const box = srcBox(c, rect, T); // seed: the confirmed outline (PNG), which SAM 2 then follows through the clip
  const pid = P.id, was = c.media, a = c.in; // the cleaned copy covers in..out as they were now: a trim meanwhile maps onto it
  const j = await job('/api/remove_object', { media: c.media, t: c.in + (T - c.start) * c.speed, t0: c.in, t1: c.out, box, quality, mode, seed }, mode === 'cutout' ? 'Cutting out' : 'Removing the object');
  await loadMedia();
  c = live(c, pid, was);
  const d = M.get(j.media).duration;
  change(() => { c.media = j.media; c.in = clamp(c.in - a, 0, d); c.out = clamp(c.out - a, c.in + 1 / P.fps, d); if (c.beats) c.beats = c.beats.map(b => b - a).filter(b => b >= 0 && b <= c.out); });
  const how = { 'sam2+propainter': 'SAM 2 outline + ProPainter', 'sam2+aligned+propainter': 'SAM 2 outline + background from other frames + ProPainter',
    'sam2+aligned': 'SAM 2 outline + background from other frames', propainter: 'ProPainter', 'aligned+propainter': 'background from other frames + ProPainter' }[j.engine] || 'background from other frames';
  if (mode === 'cutout') toast(`Cut out over ${j.frames} frames (SAM 2): everything else is transparent now`);
  else toast(`Removed it from ${j.frames} frames (${how})${j.lost && !j.engine.startsWith('sam2') ? '; it got hard to follow part of the way' : ''}`);
  return { ...brief(c, lane), engine: j.engine };
}
async function finishRemove(rect) { // Best and cutouts: show SAM 2's outline first, so a wrong pick costs a second, not the whole clip
  const { c, lane, mode } = S.pick, T = S.t, q = $('#rmQuality')?.value || 'best';
  S.pick = null; $('#toast').hidden = true; // the "drag a box" hint is done
  if (q === 'fast' && mode !== 'cutout') return removeObject(c, lane, rect, T, q, mode).catch(e => setStatus(e.message));
  setStatus('Finding its outline (SAM 2)…');
  try {
    const r = await maskPreview(c, lane, rect, T, mode);
    setStatus('');
    if (!r) return;
    if (r.areas.at(-1) < 0.0004) { S.maskPreview = null; S.dirty = true; toast('Nothing found in that box: draw it around the object'); return startRemove(c, lane, mode); }
  } catch (e) { setStatus(''); return removeObject(c, lane, rect, T, q, mode).catch(err => setStatus(err.message)); } // no SAM 2 here: straight on, with the box
  const bar = $('#confirmBar');
  markPreview();
  bar.title = 'Smaller / Bigger: a part of it, or more of it.';
  bar.querySelector('[data-ok]').textContent = mode === 'cutout' ? 'Cut it out' : 'Remove it';
  bar.hidden = false;
  bar.querySelector('[data-ok]').focus();
}
async function finishTrack(rect) { // rect in project canvas units
  const { c, lane, host } = S.pick, m = M.get(host.media), t0 = S.t;
  S.pick = null;
  const cr = host.crop || {}, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0);
  const toSrc = canvasToSrc(host, t0);
  const toCanvas = (sx, sy, G) => { let u = (sx - (cr.l || 0)) / fx; if (host.flip) u = 1 - u; return [(G.x + u * G.w) / P.w, (G.y + ((sy - (cr.t || 0)) / fy) * G.h) / P.h]; };
  const gAt = T => geom(m, host, P.w, P.h, propsAt(host, T - host.start)); // the host may be zooming / reframed
  const [sx, sy] = toSrc(rect.x, rect.y), [ex, ey] = toSrc(rect.x + rect.w, rect.y + rect.h);
  const end = Math.min(host.start + tdur(host, 'main'), c.start + tdur(c, lane));
  try {
    const j = await job('/api/track', { media: host.media, t0: host.in + (t0 - host.start) * host.speed, t1: host.in + (end - host.start) * host.speed,
      box: { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) } }, 'Tracking');
    const pts = j.points.map(p => { const T = host.start + (p.t - host.in) / host.speed; return { T, q: toCanvas(p.x + p.w / 2, p.y + p.h / 2, gAt(T)) }; }).filter(p => p.T >= c.start && p.T <= end);
    if (pts.length < 2) throw new Error('Lost the target right away; try a bigger, higher-contrast box');
    const base = propsAt(c, pts[0].T - c.start), q0 = pts[0].q, step = Math.max(1, Math.round(pts.length / 400));
    change(() => {
      c.kf = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => ({ t: p.T - c.start, scale: base.scale, opacity: base.opacity, rot: base.rot, x: base.x + p.q[0] - q0[0], y: base.y + p.q[1] - q0[1] }));
    });
    toast(`Tracked ${pts.length} frames${j.lost ? ' (target lost before the end)' : ''}`);
  } catch (e) { toast(e.message); }
}

async function autoCaptions(force) { // words come back in source time; map them through each clip's in/out/speed
  const lang = $('#capLang').value, per = +$('#capWords').value, status = $('#capStatus'), btn = $('#btnCaptions');
  packMain();
  const pid = P.id, speech = () => [...P.main, ...($('#capAudio').checked ? P.audio : [])].filter(c => M.get(c.media)?.hasAudio && c.volume > 0);
  let src = speech();
  if (!src.length) return toast('Add a clip with speech to the main or audio track first');
  if (P.captions.length && force !== true && !confirm(`Replace the ${P.captions.length} captions on the timeline? Text you edited on them is lost (undo brings it back).`)) return;
  btn.disabled = true;
  try {
    const ids = [...new Set(src.map(c => c.media))], words = new Map();
    for (const [i, id] of ids.entries()) {
      const msg = status.textContent = `Transcribing ${i + 1}/${ids.length}: ${M.get(id).name}…`;
      words.set(id, await fetchWords(id, lang, usedSpans(id, src), p => { status.textContent = msg + p; }));
    }
    // placed on the timeline as it is NOW (edits while it listened move the words with them), in the project it was asked in
    if (P.id !== pid) throw new Error('Another project is open now: open that one again and press Captions (the words are kept, so it is quick)');
    packMain(); src = speech().filter(c => words.has(c.media));
    const all = [];
    for (const c of src) {
      for (const w of words.get(c.media)) {
        if (w.e <= c.in || w.s >= c.out) continue;
        const a = c.start + (Math.max(w.s, c.in) - c.in) / c.speed, b = c.start + (Math.min(w.e, c.out) - c.in) / c.speed;
        if (b - a > 0.02) all.push({ w: w.w, s: a, e: b });
      }
    }
    all.sort((x, y) => x.s - y.s);
    const caps = [];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const s = cur[0].s, e = cur.at(-1).e;
      caps.push({ id: hex12(), start: s, dur: Math.max(0.2, e - s), text: cur.map(w => w.w).join(' '), words: cur.map(w => ({ w: w.w, s: w.s - s, e: w.e - s })) });
      cur = [];
    };
    for (const w of all) {
      const prev = cur.at(-1);
      if (prev && (cur.length >= per || w.s - prev.e > 0.6 || /[.?!]$/.test(prev.w))) flush();
      cur.push(w);
    }
    flush();
    for (let i = 0; i + 1 < caps.length; i++) { // hold each caption until the next one so they don't flicker
      const gap = caps[i + 1].start - (caps[i].start + caps[i].dur);
      if (gap > 0 && gap < 0.5) caps[i].dur += gap;
      else if (gap < 0) caps[i].dur = Math.max(0.1, caps[i + 1].start - caps[i].start);
    }
    const kept = new Map(P.captions.filter(c => c.style).map(c => [c.text, c.style])); // a restyled caption keeps its look when captions are re-made after a cut
    for (const c of caps) if (kept.has(c.text)) c.style = kept.get(c.text);
    change(() => { P.captions = caps; S.sel = null; });
    status.textContent = caps.length ? `${caps.length} captions from ${all.length} words. Click one to edit it.` : 'No speech found.';
  } catch (e) { status.textContent = e.message; throw e; }
  finally { btn.disabled = false; }
}

// ---------- import ----------
async function loadMedia() {
  const list = await api('/api/media');
  for (const m of list) { // a proxy may exist now: make players reload
    const old = M.get(m.id);
    if (old && !old.ready && m.ready) for (const v of pool.values()) if (v.dataset.media === m.id) v.dataset.media = '';
  }
  M.clear();
  for (const m of list) M.set(m.id, m);
  renderMediaList();
  renderTimeline();
  if (G.tab === 'audio') renderAudio();
  S.dirty = true;
  clearTimeout(loadMedia.t);
  if (list.some(m => !m.ready)) loadMedia.t = setTimeout(loadMedia, 1500);
}
// ---------- subtitles: SRT / WebVTT in and out ----------
const srtTime = t => { const ms = Math.max(0, Math.round(t * 1000)), p2 = (v, n = 2) => String(v).padStart(n, '0'); return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${p2(ms % 1000, 3)}`; };
function toSRT() { // the captions (or, with none, the text clips) as SubRip
  const src = (P.captions.length ? P.captions : P.text).filter(c => String(c.text || '').trim()).sort((a, b) => a.start - b.start);
  if (!src.length) throw new Error('no captions or text to save as subtitles');
  return src.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + c.dur)}\n${String(c.text).trim()}\n`).join('\n');
}
function parseSubs(txt) { // SubRip or WebVTT cues -> [{start, dur, text}]
  const sec = x => { const m = x.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/); return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000 : NaN; };
  const out = [];
  for (const blk of String(txt).replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = blk.split('\n'), i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map(x => sec(x.trim().split(/\s+/)[0]));
    const text = lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (Number.isFinite(a) && b > a && text) out.push({ start: a, dur: b - a, text });
  }
  return out.sort((x, y) => x.start - y.start);
}
function importSubs(txt, name = 'subtitles') { // onto the captions track (replacing it), words spread over each cue for the highlight
  const cues = parseSubs(txt);
  if (!cues.length) throw new Error(`no subtitles found in ${name}`);
  change(() => {
    P.captions = cues.map(c => { const ws = c.text.split(/\s+/).filter(Boolean); return { id: hex12(), start: c.start, dur: c.dur, text: ws.join(' '), words: ws.map((w, i) => ({ w, s: (i * c.dur) / ws.length, e: ((i + 1) * c.dur) / ws.length })) }; });
    if (S.sel?.lane === 'captions') S.sel = null;
  });
  toast(`${cues.length} subtitles from ${name} on the captions track`);
  return cues.length;
}
async function saveSRT(name) { const r = await api('/api/save_subs', { name: name || P.name, text: toSRT() }); return r.file; }
function importFiles(files) {
  for (const f of [...files].filter(x => /\.(srt|vtt)$/i.test(x.name))) f.text().then(t => importSubs(t, f.name)).catch(e => toast(e.message));
  files = [...files].filter(x => !/\.(srt|vtt)$/i.test(x.name));
  for (const f of files) {
    const u = { name: f.name, pct: 0 }, x = new XMLHttpRequest();
    uploads.push(u);
    const done = msg => { uploads.splice(uploads.indexOf(u), 1); if (msg) toast(`${f.name}: ${msg}`); loadMedia().catch(e => toast(e.message)); };
    x.open('POST', `/api/import?name=${encodeURIComponent(f.name)}`);
    x.setRequestHeader('X-Cutroom', '1');
    x.upload.onprogress = e => { u.pct = e.lengthComputable ? e.loaded / e.total : 0; renderMediaList(); };
    x.onload = () => { let err = ''; if (x.status !== 200) { try { err = JSON.parse(x.responseText).error; } catch { err = 'import failed'; } } done(err); };
    x.onerror = () => done('upload failed');
    x.send(f);
  }
  renderMediaList();
}

// ---------- export ----------
function exportSizes() {
  const s = Math.min(P.w, P.h);
  return [['720p', 720], ['1080p', 1080], ['1440p', 1440], ['4K', 2160]].map(([l, short]) => [l, even((P.w * short) / s), even((P.h * short) / s)]);
}
const blobURL = b => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
async function buildPlan(w, h, quality, name, loud, format = 'mp4') {
  await lutsReady([...P.main, ...P.overlay]); // imported LUTs in the grades are loaded
  await duckReady();
  const k = w / P.w, D = total();
  const clip = async (c, lane, i) => {
    const m = M.get(c.media);
    if (!m) throw new Error('a clip points at missing media; delete it first');
    const o = { media: c.media, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, frames: frames(c), fadeIn: c.fadeIn, fadeOut: c.fadeOut,
      fit: c.fit, opacity: c.opacity, adj: c.adj, crop: c.crop, flip: c.flip, denoise: c.denoise, look: lookMatrix(c), key: c.key, angle: c.rot ?? 0, blend: lane === 'overlay' && c.blend !== 'normal' ? c.blend : undefined };
    if (m.kind !== 'audio') {
      const g = geom(m, c, P.w, P.h);
      o.geom = { x: g.x * k, y: g.y * k, w: g.w * k, h: g.h * k };
      // keyframes as export-pixel width + top-left: those interpolate exactly like scale/x/y do (same easing)
      const bk = bakeKf(c, lane); // keyframes as export-pixel width + top-left (they interpolate like scale/x/y do), clip animations baked in
      if (bk) o.kf = bk.map(f => { const q = geom(m, c, P.w, P.h, f); return { t: f.t, w: q.w * k, x: q.x * k, y: q.y * k, op: f.opacity ?? 1, a: f.rot ?? 0, e: f.e, u0: f.eu0 ?? 0, u1: f.eu1 ?? 1 }; });
      if (c.mask && c.mkf?.length) o.maskSeq = await maskSeq(c, m); else if (c.mask) o.mask = await maskPNG(c, m);
      if (c.adj?.vig > 0) o.vig = await vigPNG(c, m);
      if (mbN(c)) o.mb = mbN(c);
      const cw = m.w * (1 - ((c.crop?.l || 0) + (c.crop?.r || 0))), ch = m.h * (1 - ((c.crop?.t || 0) + (c.crop?.b || 0))), short0 = Math.min(cw, ch);
      if (c.adj?.blur > 0) o.blur = Math.max(1, Math.min(Math.round(c.adj.blur * 0.03 * short0), Math.floor(short0 / 4) - 1));
      if (c.beauty?.amt > 0) o.beauty = { amt: c.beauty.amt, sigma: 0.008 * short0 };
      if (c.glow) o.glow = { color: c.glow.color, sigma: c.glow.size * 0.04 * ch, gain: c.glow.neon ? 2 : 1 };
      const gl3 = gradeLUT(c);
      if (gl3) o.grade = gradeB64(gl3);
      if (c.lkf?.length) o.lkf = c.lkf;
      const tn = toneLUT(c);
      if (tn) o.tone = tn;
    }
    if (lane === 'main' && trF(i)) o.tr = { type: c.tr.type, frames: trF(i) };
    if (c.vkf?.length) o.vkf = c.vkf;
    if (c.au) o.au = c.au;
    if ((lane === 'main' || lane === 'overlay') && P.mute.main && lane === 'main') { o.volume = 0; delete o.vkf; } // muted main track
    return o;
  };
  const items = ['text', 'captions'].filter(l => !P.mute[l]).flatMap(l => shown(l).map(it => [l, it])), layerFx = P.mute.fx ? [] : shown('fx').filter(f => FX[f.fx]?.layer);
  let text = null;
  if ((items.length || layerFx.length) && !['mp3', 'wav'].includes(format)) { // one PNG per interval in which the visible text (and effect overlays) don't change; none for sound only
    await Promise.all([...new Set(items.map(([l, it]) => { const s = textStyle(it, l); return `${s.weight} 40px "${s.font}"`; }))].map(f => document.fonts.load(f)));
    const cuts = new Set([0, D]);
    for (const [l, it] of items) {
      const st = textStyle(it, l), end = it.start + it.dur;
      cuts.add(it.start); cuts.add(end);
      if (it.words) for (const wd of it.words) cuts.add(it.start + wd.s);
      const spans = [st.anim && st.anim !== 'none' ? [it.start, it.start + animLen(st, false)] : null, l !== 'captions' && it.kf?.length > 1 ? [it.start + it.kf[0].t, it.start + it.kf.at(-1).t] : null,
        st.out && st.out !== 'none' ? [end - animLen(st, true), end] : null, st.loop && st.loop !== 'none' ? [it.start, end] : null];
      for (const [a, b] of spans.filter(Boolean)) for (let t = a; t < Math.min(b, end); t += 1 / P.fps) cuts.add(t); // animated: one PNG per frame
    }
    for (const f of layerFx) { // effect overlays change every frame, n times a second, near their ends only, or never
      const d = FX[f.fx], end = f.start + f.dur, step = d.rate === 'frame' || d.rate === 'edges' ? 1 / P.fps : d.rate ? 1 / d.rate : 0;
      cuts.add(f.start); cuts.add(end);
      if (step) for (let t = f.start; t < end; t += step) if (d.rate !== 'edges' || t - f.start < 0.45 || end - t < 0.45) cuts.add(t);
    }
    const nF = Math.round(D * P.fps), fs = new Set([0, nF]);
    for (const c of cuts) fs.add(Math.floor(c * P.fps)).add(Math.ceil(c * P.fps)); // the frames on either side of every change
    const sf = Math.floor(clamp(S.t, 0, Math.max(0, D - 1 / P.fps)) * P.fps + 1e-6); // a still: only its own frame's text (after one span from 0: the spans play back to back)
    const fr = format === 'png' ? [...new Set([0, sf, sf + 1])] : [...fs].filter(f => f >= 0 && f <= nF).sort((a, b) => a - b);
    const cv = new OffscreenCanvas(w, h), ctx = cv.getContext('2d', { willReadFrequently: true }), pngs = [], seen = new Map(), spans = [];
    for (let i = 0; i + 1 < fr.length; i++) { // spans on the frame grid: the export can't put a change between two frames
      const a = fr[i] / P.fps, b = fr[i + 1] / P.fps;
      ctx.clearRect(0, 0, w, h);
      drawTexts(ctx, a, k, false); // exactly what the preview draws on that frame (same function, same time)
      // the same picture again (a looping title comes back every half second) is found by its pixels, not encoded again:
      // the PNG encode was most of the 20 s before the render started
      const px = new Uint32Array(ctx.getImageData(0, 0, w, h).data.buffer);
      let h1 = 2166136261, h2 = 0x9e3779b9;
      for (let j = 0; j < px.length; j++) { const v = px[j]; h1 = Math.imul(h1 ^ v, 16777619); h2 = Math.imul(h2 ^ v, 2246822519) ^ (h2 >>> 13); }
      const key = `${h1 >>> 0}:${h2 >>> 0}`;
      let idx = seen.get(key);
      if (idx === undefined) { idx = pngs.push(await blobURL(await cv.convertToBlob({ type: 'image/png' }))) - 1; seen.set(key, idx); }
      const last = spans.at(-1);
      if (last && last.i === idx) last.end = b; else spans.push({ i: idx, start: a, end: b });
    }
    text = { pngs, frames: spans };
  }
  return { w, h, fps: P.fps, duration: D, bg: P.bg, quality, name, loud, text, format, fx: fxPlan(w, h), still: clamp(S.t, 0, Math.max(0, D - 1 / P.fps)), // a frame at the very end doesn't exist
    main: await Promise.all(P.main.map((c, i) => clip(c, 'main', i))), overlay: P.mute.overlay ? [] : await Promise.all(shown('overlay').map(c => clip(c, 'overlay'))),
    audio: P.mute.audio ? [] : await Promise.all(shown('audio').map(c => clip(c, 'audio'))) };
}
function openExport() {
  if (total() <= 0) return toast('Add something to the timeline first');
  modal(`<h2>Export</h2>
    <label class="row"><span>File name</span><input id="exName" value="${esc(P.name)}"></label>
    <label class="row"><span>Resolution</span><select id="exRes">${exportSizes().map(([l, w, h], i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${l} · ${w}×${h}</option>`).join('')}</select></label>
    <label class="row"><span>Encoder</span><select id="exQ"><option value="fast">Fast (Apple hardware)</option><option value="best">Best quality (x264, slower)</option></select></label>
    <label class="row"><span>Bitrate</span><select id="exRate"><option value="1">Standard</option><option value="1.6">High</option><option value="2.5">Very high</option></select></label>
    <label class="row chk"><span>Loudness −14 LUFS</span><input id="exLoud" type="checkbox"></label>
    <label class="row chk" title="Decodes on the Mac's media engine: the processor stays free for editing, the export can take longer"><span>Light (less CPU)</span><input id="exLight" type="checkbox"></label>
    <label class="row"><span>Format</span><select id="exFmt">${FORMATS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
    <p class="muted" id="exHint"></p>
    <div class="progress" hidden><div></div></div><p id="exStatus" class="muted"></p>
    <div class="actions" id="exActions"><span id="exDone"></span><button id="exCancel" hidden>Cancel export</button><button data-close>Close</button><button id="exGo" class="primary">Export</button></div>`);
  const hint = () => { // only the settings that apply to the chosen format are enabled
    const f = $('#exFmt').value, d = mss(total()), fps = +P.fps.toFixed(3);
    $('#exRes').disabled = ['mp3', 'wav', 'srt'].includes(f); $('#exQ').disabled = f !== 'mp4'; $('#exLoud').disabled = ['gif', 'png', 'srt'].includes(f); $('#exLight').disabled = ['mp3', 'wav', 'srt'].includes(f);
    $('#exRate').disabled = !(f === 'hevc' || (f === 'mp4' && $('#exQ').value === 'fast'));
    $('#exHint').textContent = { mp4: `MP4 · H.264 + AAC · ${fps} fps · ${d}`, hevc: `MP4 · HEVC + AAC, about half the size · ${fps} fps · ${d}`,
      prores: `MOV · ProRes 422 + PCM, for further editing (large) · ${d}`, gif: `GIF · 15 fps, up to 640 px wide, no sound, loops · ${d}${total() > 15 ? ' (long for a GIF: the file gets big)' : ''}`, mp3: `Audio only · MP3 · ${d}`,
      wav: `Audio only · WAV, uncompressed · ${d}`, srt: `${(P.captions.length ? P.captions : P.text).length} subtitles from the ${P.captions.length ? 'captions' : 'text clips'}, for YouTube and players`, png: `One frame at ${mss(clamp(S.t, 0, Math.max(0, total() - 1 / P.fps)))}` }[f];
  };
  $('#exFmt').addEventListener('change', hint); $('#exQ').addEventListener('change', hint); hint();
  if (S.exporting) exportUI(S.exporting.pct || 0, `Rendering… ${S.exporting.pct || 0}%`); // one is still running
}
function exportUI(pct, msg, done) { // the dialog when it's open (it can be closed and opened again while rendering) and the Export button
  const bar = $('.dialog .progress'), st = $('#exStatus'), busy = !!S.exporting;
  if (bar && (busy || pct)) { bar.hidden = false; bar.firstElementChild.style.width = `${pct}%`; }
  if (st && msg != null) st.innerHTML = msg;
  if (done != null && $('#exDone')) $('#exDone').innerHTML = done;
  if ($('#exGo')) $('#exGo').disabled = busy;
  if ($('#exCancel')) $('#exCancel').hidden = !S.exporting?.job;
  const b = $('#btnExport');
  b.classList.toggle('busy', busy); b.style.setProperty('--pct', `${busy ? pct : 0}%`); b.title = busy ? `Exporting… ${pct}%` : '';
}
async function runExport() { // the editor stays usable meanwhile: close the dialog and keep working, Cancel stops it
  if (S.exporting) return;
  const [, w, h] = exportSizes()[+$('#exRes').value], fmt = $('#exFmt').value, name = $('#exName').value.trim() || P.name;
  S.exporting = { pct: 0 };
  exportUI(0, 'Rendering text layer…', '');
  const tell = msg => { if ($('#modal').hidden || !$('#exStatus')) toast(msg); };
  try {
    if (fmt === 'srt') {
      const file = await saveSRT(name);
      S.exporting = null;
      exportUI(100, `Saved <b>${esc(file)}</b> in Movies/Cutroom/exports`, `<button data-reveal="${esc(file)}">Show in Finder</button>`);
      return;
    }
    const plan = await buildPlan(w, h, $('#exQ').value, name, $('#exLoud').checked, fmt);
    plan.rate = +$('#exRate').value; plan.light = $('#exLight').checked;
    const { job } = await api('/api/export', plan);
    S.exporting.job = job;
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const j = await api(`/api/jobs/${job}`), pct = Math.round((j.progress || 0) * 100);
      if (j.state === 'done') {
        S.exporting = null;
        exportUI(100, `Saved <b>${esc(j.file)}</b> in Movies/Cutroom/exports`, `<button data-reveal="${esc(j.file)}">Show in Finder</button><button data-play="${esc(j.file)}">Play</button>`);
        tell(`Exported ${j.file} (Movies/Cutroom/exports)`);
        break;
      }
      if (j.state === 'cancelled') { S.exporting = null; exportUI(0, 'Export cancelled.'); tell('Export cancelled'); break; }
      if (j.state !== 'running') throw new Error(j.error || 'The export failed');
      S.exporting.pct = pct;
      exportUI(pct, `Rendering… ${pct}%`);
    }
  } catch (e) { S.exporting = null; exportUI(0, `Export failed: ${esc(e.message)}`); tell(`Export failed: ${e.message}`); }
  finally { if (S.exporting) { S.exporting = null; exportUI(0); } }
}

// ---------- projects ----------
function migrate(p) {
  const q = { fps: 30, bg: '#000000', main: [], overlay: [], audio: [], text: [], captions: [], fx: [], markers: [], ...p,
    tracks: { ...(p.tracks || {}) }, mute: { main: false, overlay: false, audio: false, text: false, captions: false, fx: false, ...(p.mute || {}) }, capStyle: { ...CAP_PRESETS.Bold, y: 0.72, ...(p.capStyle || {}) } };
  if ((q.v || 1) < 2) { // v2: volume envelopes are multipliers of the clip volume, so the Volume slider still works after auto-duck
    for (const L of ['main', 'overlay', 'audio']) for (const c of q[L]) if (c.vkf?.length) { const b = c.volume || 1; c.vkf = c.vkf.map(f => ({ ...f, v: f.v / b })); }
    q.v = 2;
  }
  return q;
}
function newProject(ratio = '9:16') { const [w, h] = RATIOS[ratio]; return migrate({ id: hex12(), name: `Untitled ${new Date().toLocaleDateString()}`, w, h }); }
function sendPoster(leaving) { // the projects screen's card = the preview as you left it (its shape, its text), up to 480 px on the long side
  if (!P || !LANES.some(L => P[L.key].length)) return;
  const sel = S.sel, multi = new Set(S.multi), pick = S.pickRect;
  S.sel = null; S.multi.clear(); S.pickRect = null; // the frame as rendered: no selection box
  try { paint(); } catch { return; } finally { S.sel = sel; for (const x of multi) S.multi.add(x); S.pickRect = pick; S.dirty = true; }
  const cv = $('#cv'), k = Math.min(1, 480 / Math.max(cv.width, cv.height)), o = document.createElement('canvas');
  o.width = Math.round(cv.width * k); o.height = Math.round(cv.height * k);
  o.getContext('2d').drawImage(cv, 0, 0, o.width, o.height);
  return api(`/api/projects/${P.id}/poster`, { jpg: o.toDataURL('image/jpeg', 0.82).split(',')[1] }, 'POST', leaving).catch(() => {});
}
function setProject(p) {
  if (S.playing) pause();
  if (P && p.id !== P.id) sendPoster();
  flushSave(); // the project being left
  P = migrate(p); undo = []; redo = []; S.sel = null; S.multi.clear(); S.t = 0;
  for (const v of pool.values()) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
  pool.clear(); imgs.clear(); // (the last project's photos stayed decoded)
  store.set('cutroom.last', P.id);
  fitStage(); renderAll();
}
async function openProject(id) {
  setProject(await api(`/api/projects/${id}`));
  const gone = LANES.reduce((n, L) => n + P[L.key].filter(c => c.media && !M.get(c.media)).length, 0);
  if (gone) toast(`${gone} clip${gone === 1 ? ' has' : 's have'} missing media (striped red): select one to restore or relink it`);
}
async function openProjects() { // CapCut's home: a card per project with a frame from it, newest first
  await sendPoster(); // (this one's card shows it as it is now)
  const list = await api('/api/projects').catch(() => []);
  const ago = t => { const s = Date.now() / 1000 - t; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : s < 172800 ? 'yesterday' : new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const ratio = p => Object.entries(RATIOS).find(([, [w, h]]) => w * p.h === h * p.w)?.[0] || `${p.w}×${p.h}`;
  modal(`<div class="phead"><h2>Projects</h2><label class="pnew">New project <select id="newRatio" aria-label="Shape of the new project">${Object.keys(RATIOS).map(r => `<option${r === '9:16' ? ' selected' : ''}>${r}</option>`).join('')}</select><button class="primary" data-newsel>Create</button></label></div>
    <div class="pgrid">${list.map(p => `<div class="pcard${p.id === P?.id ? ' on' : ''}"><button class="pitem" data-open="${p.id}" title="Open ${esc(p.name)}"><span class="pthumb">${p.pic ? `<img src="/api/projects/${p.id}/poster.jpg?v=${Math.round(p.updated)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${fmtDur(p.dur || 0)}</i></span><b>${esc(p.name)}</b><span class="pmeta">${ratio(p)} · ${p.clips} clip${p.clips === 1 ? '' : 's'} · ${ago(p.updated)}</span></button>`
      + `<span class="pacts"><button class="pdel" data-dup="${p.id}" title="Duplicate" aria-label="Duplicate ${esc(p.name)}"><svg class="i" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button><button class="pdel" data-trash="${p.id}" data-name="${esc(p.name)}" title="Delete" aria-label="Delete ${esc(p.name)}"><svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></span></div>`).join('') || '<p class="hint">No saved projects yet.</p>'}</div>
    <div class="actions"><button data-close>Close</button></div>`, 'wide');
}

async function trashProject(id, name) { // reversible: the server moves it to Movies/Cutroom/trash
  if (!confirm(`Delete "${name}"? It moves to Movies/Cutroom/trash, so it can be recovered.`)) return;
  if (id === P?.id) { clearTimeout(saveTimer); saveTimer = 0; } // (a pending save would put it back)
  await api(`/api/projects/${id}/trash`, {});
  if (id === P?.id) { const list = await api('/api/projects'); if (list[0]) await openProject(list[0].id); else { setProject(newProject('9:16')); scheduleSave(); } }
  openProjects();
}
async function loadVoices() {
  const vs = await api('/api/voices').catch(() => []), pref = store.get('cutroom.voice') || 'Samantha';
  $('#ttsVoice').innerHTML = vs.map(v => `<option value="${esc(v.name)}"${v.name === pref ? ' selected' : ''}>${esc(v.name.replace(/\s*\(.*\)$/, ''))} · ${v.lang}</option>`).join('');
}
async function addVoiceover() { // CapCut's text-to-speech with the Mac's own voices
  const text = $('#ttsText').value.trim(), btn = $('#btnTts');
  if (!text) return toast('Type the script first');
  btn.disabled = true;
  try {
    const m = await api('/api/tts', { text, voice: $('#ttsVoice').value, rate: +$('#ttsRate').value });
    store.set('cutroom.voice', $('#ttsVoice').value);
    await loadMedia();
    addMedia(m.id, 'audio', S.t);
    toast('Voiceover added on the audio track. Generate captions to subtitle it.');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

// ---------- small UI ----------
let remoteLog = null; // toasts and statuses shown while a remote (MCP) command runs go back to the caller
const quiet = p => { p?.catch?.(() => {}); }; // a button's async tool: its error is already shown next to the clip
function toast(msg) { if (remoteLog) remoteLog.push(String(msg)); const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500); }
function modal(html, cls = '') { const m = $('#modal'); m.innerHTML = `<div class="dialog ${cls}" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; $('button, input', m)?.focus(); }
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

// ---------- timeline interaction ----------
function magnet(t, self) { // nearest playhead / clip edge within 8 px -> [time, distance]; distance Infinity = no snap
  let best = t, bd = 8 / S.pps, hit = false;
  const near = p => { if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; hit = true; } };
  near(0); near(S.t);
  for (const L of LANES) for (const x of P[L.key]) if (x !== self) { near(x.start); near(x.start + tdur(x, L.key)); }
  for (const a of P.audio) for (const b of a.beats || []) if (b >= a.in && b <= a.out) near(a.start + (b - a.in) / a.speed); // beat marks
  for (const mk of P.markers || []) near(mk);
  return [best, hit ? bd : Infinity];
}
function snapTo(s, c, lane) { // a moved clip snaps by whichever edge is closer to something
  const d = tdur(c, lane), [a, da] = magnet(s, c), [b, db] = magnet(s + d, c);
  return Math.max(0, da <= db ? (da < Infinity ? a : s) : b - d);
}
function scrub(e) { // drag the playhead: you hear it, the timeline scrolls at its edges, and playback carries on after a click
  const was = S.playing;
  if (S.playing) pause();
  if (!e.target.closest('.ruler') && (S.sel || S.multi.size)) { S.sel = null; S.multi.clear(); renderInspector(); $$('.clip.sel').forEach(x => x.classList.remove('sel')); }
  const sc = $('#tlScroll');
  let last = e, raf = 0;
  const set = ev => { last = ev; S.t = snap(clamp((ev.clientX - $('#tlInner').getBoundingClientRect().left) / S.pps, 0, total())); placePlayhead(); S.dirty = true; scrubSound(); };
  const edge = () => { // held near an edge: scroll that way, faster nearer the edge
    raf = 0;
    const r = sc.getBoundingClientRect(), d = last.clientX < r.left + 30 ? last.clientX - (r.left + 30) : last.clientX > r.right - 30 ? last.clientX - (r.right - 30) : 0;
    if (!d) return;
    sc.scrollLeft += d / 2; set(last); raf = requestAnimationFrame(edge);
  };
  const move = ev => { set(ev); if (!raf) raf = requestAnimationFrame(edge); };
  set(e);
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); cancelAnimationFrame(raf); if (selClip()) renderInspector(); if (was) play(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function scrubSound() { // 70 ms of what is under the playhead, at most every 40 ms (Shift+A turns it off)
  if (!actx || actx.state !== 'running' || store.get('cutroom.scrubSound') === 'off') return;
  const now = actx.currentTime;
  if (now - (S.scrubAt || 0) < 0.04) return;
  S.scrubAt = now;
  for (const [lane, list] of [['main', P.main], ['overlay', shown('overlay')], ['audio', shown('audio')]]) for (const c of list) {
    if (!M.get(c.media)?.hasAudio || !(c.volume > 0) || !(c.pitch || Math.abs(c.speed - 1) < 1e-6) || S.t < c.start || S.t >= c.start + tdur(c, lane)) continue;
    const s = c.in + (S.t - c.start) * c.speed, k = Math.floor(s / PCM_S), p = pcmChunk(c.media, 1, k, undefined, c.denoise), g0 = clipGain(c, lane, S.t);
    if (!p.buf || !g0) continue; // loading: the next move has it
    const n = actx.createBufferSource(), g = actx.createGain();
    n.buffer = p.buf; n.playbackRate.value = c.speed; n.connect(g).connect(actx.destination);
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(g0, now + 0.005); g.gain.setValueAtTime(g0, now + 0.065); g.gain.linearRampToValueAtTime(0, now + 0.07);
    n.start(now, Math.max(0, s - k * PCM_S), 0.07 * c.speed);
  }
}
function drag(e, lane, c, el) {
  const before = JSON.stringify(P), x0 = e.clientX, y0 = e.clientY, o = structuredClone(c), m = M.get(c.media);
  const group = lane !== 'main' && selection().length > 1 && isSel(lane, c.id) ? selection().filter(([x, l]) => x !== c && l !== 'main').map(([x]) => [x, x.start]) : [];
  const r = el.getBoundingClientRect(), edge = Math.min(8, r.width / 3);
  const mode = e.clientX - r.left < edge ? 'l' : r.right - e.clientX < edge ? 'r' : 'move';
  const minD = 1 / P.fps, sp = c.speed || 1, maxOut = m && m.kind !== 'image' ? m.duration : Infinity;
  const vert = mode === 'move' && MULTI.includes(lane) && !group.length, LH = LANES.find(L => L.key === lane)?.h || 42, R0 = vert ? rows(lane).row : null; // up / down: another track
  let moved = false;
  if (S.playing) pause();
  const an = lane === 'main' ? anchors() : []; // linked clips follow a main-track trim live, and a reorder on the drop
  const block = lane === 'main' && isSel(lane, c.id) ? selection().filter(([, l]) => l === 'main').map(([x]) => x).sort((a, b) => P.main.indexOf(a) - P.main.indexOf(b)) : [c];
  const dropAt = cx => { // main reorder: [the rest, the index the block goes in at]
    const mid = o.start + (cx - x0) / S.pps + tdur(c, 'main') / 2, rest = P.main.filter(x => !block.includes(x));
    return [rest, rest.filter(x => x.start + tdur(x, 'main') / 2 < mid).length];
  };
  let line = null;
  const move = ev => {
    const dx = ev.clientX - x0, dt = dx / S.pps;
    if (!moved && Math.abs(dx) < 3 && !(vert && Math.abs(ev.clientY - y0) >= 3)) return;
    moved = true;
    if (mode === 'move' && lane === 'main') { // reorder on drop (selected main clips go as one block)
      for (const x of block) { const e2 = document.querySelector(`.clip[data-lane="main"][data-id="${x.id}"]`); if (e2) { e2.style.transform = `translateX(${dx}px)`; e2.style.zIndex = 3; } }
      const [rest, i] = dropAt(ev.clientX), at = i ? rest[i - 1].start + tdur(rest[i - 1], 'main') : 0; // the cut it goes into, as laid out now
      if (!line?.isConnected) { line = document.createElement('i'); line.className = 'dropline'; $('#lane-main').append(line); }
      line.style.left = `${at * S.pps}px`; line.dataset.i = i;
      return;
    }
    if (mode === 'r') {
      if (c.media) c.out = clamp(o.out + dt * sp, o.in + minD * sp, maxOut); else c.dur = Math.max(minD, o.dur + dt);
      const [t1, dd] = magnet(c.start + len(c), c);
      if (dd < Infinity) { if (c.media) c.out = clamp(c.in + (t1 - c.start) * sp, c.in + minD * sp, maxOut); else c.dur = Math.max(minD, t1 - c.start); }
      reanchor(an);
    } else if (mode === 'l') {
      let d = lane === 'main' ? dt : Math.max(dt, -o.start);
      if (lane !== 'main') { const [t1, dd] = magnet(o.start + d, c); if (dd < Infinity) d = t1 - o.start; }
      if (!c.media) { d = Math.min(d, o.dur - minD); c.start = o.start + d; c.dur = o.dur - d; }
      else if (m?.kind === 'image') { d = Math.min(d, len(o) - minD); c.out = o.out - d; if (lane !== 'main') c.start = o.start + d; }
      else { d = clamp(d, -o.in / sp, len(o) - minD); c.in = o.in + d * sp; if (lane !== 'main') c.start = o.start + d; }
      if (o.kf) c.kf = o.kf.map(f => ({ ...f, t: f.t - d })); // keyframes, envelope and word timing stay on their content
      if (o.vkf) c.vkf = o.vkf.map(f => ({ ...f, t: f.t - d }));
      if (o.words) { c.words = o.words.map(w => ({ ...w, s: w.s - d, e: w.e - d })).filter(w => w.e > 0); c.text = c.words.map(w => w.w).join(' '); }
      reanchor(an);
    } else {
      c.start = snapTo(Math.max(0, o.start + dt), c, lane);
      const dd = Math.max(c.start - o.start, -Math.min(o.start, ...group.map(g => g[1]))); // the group keeps its spacing and stops at 0
      c.start = o.start + dd;
      for (const [x, s0] of group) x.start = s0 + dd;
      if (vert) {
        if (!S.dragLane) for (const x of P[lane]) if (x !== c) { const r = R0.get(x.id) || 0; if (r) x.track = r; else delete x.track; } // the others keep their tracks
        S.dragLane = lane;
        const top = $(`#lane-${lane}`).getBoundingClientRect().top, n = rows(lane).n, r = clamp(Math.floor((ev.clientY - top) / LH), 0, n);
        if (r !== (rows(lane).row.get(c.id) || 0)) { if (r) c.track = r; else delete c.track; }
      }
    }
    S.dirty = true;
    renderTimeline();
  };
  const up = ev => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    line?.remove();
    if (moved && mode === 'move' && lane === 'main') {
      const [rest, i] = dropAt(ev.clientX);
      rest.splice(i, 0, ...block);
      P.main = rest;
      reanchor(an);
    }
    if (S.dragLane) { S.dragLane = null; restackTracks(lane); }
    if (!moved && S.multi.size && !e.shiftKey && !e.metaKey) { S.multi.clear(); renderInspector(); } // a click (no drag) on one of a group selects just it
    if (moved && JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); } else renderTimeline();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function kfDrag(e, c, el, f) { // a keyframe diamond: click goes to it, drag moves it (on frames, one undo step)
  if (!f) return;
  const before = JSON.stringify(P), left = el.getBoundingClientRect().left, x0 = e.clientX;
  let moved = false;
  if (S.playing) pause();
  const move = ev => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    f.t = snap(clamp((ev.clientX - left) / S.pps, 0, len(c)));
    c.kf.sort((a, b) => a.t - b.t);
    S.t = c.start + f.t; placePlayhead(); S.dirty = true; renderTimeline();
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    if (!moved) return seekTo(c.start + f.t);
    if (JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function fadeDrag(lane, c, el, isIn) { // a fade knob: drag it into the clip to fade in (left) or out (right), in 0.05 s steps
  const before = JSON.stringify(P), left = el.getBoundingClientRect().left, d = tdur(c, lane), k = isIn ? 'fadeIn' : 'fadeOut', other = isIn ? 'fadeOut' : 'fadeIn';
  if (S.playing) pause();
  const move = ev => {
    const x = (ev.clientX - left) / S.pps;
    c[k] = Math.round(clamp(isIn ? x : d - x, 0, d - (c[other] || 0)) * 20) / 20;
    S.dirty = true; renderTimeline(); renderInspector();
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); } };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function setZoom(pps, anchorX) {
  const sc = $('#tlScroll'), x = anchorX ?? sc.clientWidth / 2, t = (sc.scrollLeft + x) / S.pps;
  S.pps = clamp(pps, Math.min(8, (sc.clientWidth - 60) / Math.max(1, total())), 600); // out far enough that a long edit fits
  $('#zoom').value = Math.log2(S.pps / 8);
  renderTimeline();
  sc.scrollLeft = t * S.pps - x;
}

// ---------- wiring ----------
function wire() {
  $('#heads').innerHTML = LANES.map(L => `<div style="height:${L.h}px">${L.label}</div>`).join('');
  $('#lanes').innerHTML = LANES.map(L => `<div class="lane" id="lane-${L.key}" data-lane="${L.key}" style="height:${L.h}px"></div>`).join('');
  $('#btnPlay').innerHTML = ICON.play;
  $('#zoom').value = Math.log2(S.pps / 8);
  renderTextTiles();
  $('#capPresets').innerHTML = Object.entries(CAP_PRESETS).map(([n, s]) => `<button data-cap="${n}" style="font-family:'${s.font}';font-weight:${s.weight};color:${s.hl}">${n}</button>`).join('');

  $('#btnPlay').addEventListener('click', () => (S.playing ? pause() : play()));
  $('#btnStart').addEventListener('click', () => P && seekTo(0));
  $('#btnEnd').addEventListener('click', () => P && seekTo(total()));
  $('#btnBack').addEventListener('click', () => P && seekTo(S.t - 1 / P.fps));
  $('#btnFwd').addEventListener('click', () => P && seekTo(S.t + 1 / P.fps));
  $('#btnUndo').addEventListener('click', () => restore(undo, redo));
  $('#btnRedo').addEventListener('click', () => restore(redo, undo));
  $('#btnSplit').addEventListener('click', split);
  $('#btnDelete').addEventListener('click', del);
  $('#btnPauses').addEventListener('click', () => quiet(removePauses()));
  $('#btnFillers').addEventListener('click', () => quiet(removeFillers()));
  $('#btnCaptions').addEventListener('click', () => quiet(autoCaptions()));
  $('#btnExport').addEventListener('click', openExport);
  $('#btnProjects').addEventListener('click', openProjects);
  $('#btnTts').addEventListener('click', addVoiceover);
  $('#btnRec').addEventListener('click', toggleRecord);
  $('#recHear').addEventListener('change', e => { $('#recHearHint').hidden = !e.target.checked; });
  $('#btnAiImage').addEventListener('click', async () => {
    const prompt = $('#aiPrompt').value.trim(), b = $('#btnAiImage');
    if (!prompt) return toast('Describe the image first');
    b.disabled = true;
    try { await aiImage({ prompt, shape: $('#aiShapeSel').value, sticker: $('#aiSticker').checked, steps: +$('#aiSteps').value, put: $('#aiPut').value }); }
    catch (e) { $('#aiStatus').textContent = e.message; }
    finally { b.disabled = false; }
  });
  $('#btnAiVideo').addEventListener('click', async () => {
    const b = $('#btnAiVideo'), st = $('#aivStatus');
    b.disabled = true; st.textContent = 'Starting the GPU PC (first time: about a minute)…';
    try { const r = await aiVideo({ prompt: $('#aivPrompt').value.trim(), ratio: $('#aivShape').value || undefined, quality: $('#aivQ').value, put: $('#aivPut').value, say: x => { st.textContent = x; } }); st.textContent = `Done (seed ${r.seed}).`; }
    catch (e) { st.textContent = e.message; }
    finally { b.disabled = false; }
  });
  $('#btnCombine').addEventListener('click', async () => {
    const b = $('#btnCombine'), media = [...document.querySelectorAll('#scList input:checked')].map(x => x.value);
    if (!media.length) return toast('Tick the videos to combine');
    b.disabled = true;
    try { await smartCombine({ media, length: +$('#scLen').value, style: $('#scStyle').value, order: $('#scOrder').value, music: $('#scMusic').value || undefined,
      ratio: $('#scRatio').value, sound: $('#scSound').checked, title: $('#scTitle').checked }); }
    catch (e) { $('#scStatus').textContent = e.message; }
    finally { b.disabled = false; }
  });
  $('#btnShorts').addEventListener('click', async () => {
    const b = $('#btnShorts'), [mn, mx] = $('#hlLen').value.split('-').map(Number);
    if (!$('#hlSrc').value) return toast('Import a video with speech first');
    b.disabled = true;
    try { await makeShorts({ media: $('#hlSrc').value, count: +$('#hlCount').value, min: mn, max: mx, captions: $('#hlCaps').checked, reframe: $('#hlReframe').checked, title: $('#hlTitle').checked, lang: $('#capLang').value }); }
    catch (e) { $('#hlStatus').textContent = e.message; }
    finally { b.disabled = false; }
  });
  $('#hlStatus').addEventListener('click', e => { const b = e.target.closest('[data-openproj]'); if (b) openProject(b.dataset.openproj).catch(err => toast(err.message)); });
  $('#btnHooks').addEventListener('click', async () => {
    const b = $('#btnHooks');
    b.disabled = true; $('#hookList').innerHTML = '<p class="muted">Writing on this Mac…</p>';
    try { const { hooks } = await hookTitles(); $('#hookList').innerHTML = hooks.map(h => `<button class="wide" data-hook="${esc(h)}">${esc(h)}</button>`).join('') + '<p class="hint">Click one to add it at the start.</p>'; }
    catch (e) { $('#hookList').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    finally { b.disabled = false; }
  });
  $('#hookList').addEventListener('click', e => { const b = e.target.closest('[data-hook]'); if (b) addHook(b.dataset.hook); });
  $('#subsIn').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  $('#btnSubsOut').addEventListener('click', async () => { try { const f = await saveSRT(); toast(`Saved ${f} in Movies/Cutroom/exports`); } catch (e) { toast(e.message); } });
  $('#btnTranslate').addEventListener('click', async () => {
    const b = $('#btnTranslate');
    b.disabled = true; $('#trStatus').textContent = 'Translating on this Mac…';
    try { const r = await translateCaptions({ to: $('#trLang').value }); $('#trStatus').textContent = `${r.sentences} sentences translated${r.kept ? ` (${r.kept} kept as they were)` : ''}.`; }
    catch (e) { $('#trStatus').textContent = e.message; }
    finally { b.disabled = false; }
  });
  $('#btnAiVoice').addEventListener('click', async () => {
    const text = $('#aiText').value.trim(), b = $('#btnAiVoice');
    if (!text) return toast('Type the script first');
    b.disabled = true; $('#aiVoiceStatus').textContent = 'Speaking…';
    try { await aiVoice({ text, voice: $('#aiVoice').value, speed: +$('#aiSpeed').value }); $('#aiVoiceStatus').textContent = 'Added on the audio track.'; }
    catch (e) { $('#aiVoiceStatus').textContent = e.message; }
    finally { b.disabled = false; }
  });
  $('#btnTemplates').addEventListener('click', openTemplates);
  $('#heads').addEventListener('click', e => {
    const b = e.target.closest('[data-lt], [data-tk], [data-lk]');
    if (!b) return;
    const d = b.dataset, key = d.tk || d.lk;
    change(() => {
      if (d.lt) P.mute[d.lt] = !P.mute[d.lt];
      else {
        const lane = key.split(':')[0], T = { ...(P.tracks[key] || {}) };
        if (d.tk && P.mute[lane]) P.mute[lane] = false; // an old whole-lane mute gives way to the track toggles
        else if (d.tk) T.off = !T.off; else T.lock = !T.lock;
        if (T.off || T.lock) P.tracks[key] = T; else delete P.tracks[key];
        if (d.lk && T.lock && S.sel && S.sel.lane !== 'tr' && selClip() && locked(S.sel.lane, selClip())) { S.sel = null; S.multi.clear(); }
      }
    });
  });
  $('#projName').addEventListener('change', e => change(() => { P.name = e.target.value.trim() || 'Untitled'; }));
  $('#zoom').addEventListener('input', e => setZoom(8 * 2 ** +e.target.value));
  $('#fileInput').addEventListener('click', () => window.webkit?.messageHandlers?.pick?.postMessage('library')); // the app clones picked media by path
  $('#fileInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  const photosApp = window.webkit?.messageHandlers?.photos; // only the Mac app has the system Photos picker
  $('#btnPhotos').hidden = !photosApp;
  $('#btnPhotos').addEventListener('click', () => photosApp?.postMessage('pick'));
  $('#textPresets').addEventListener('click', e => { const b = e.target.closest('[data-addtext]'); if (b) { addText(b.dataset.addtext); editText(); } });
  $('#capPresets').addEventListener('click', e => {
    const b = e.target.closest('[data-cap]');
    if (b) { change(() => { P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS[b.dataset.cap], y: P.capStyle.y }; }); toast(`Caption style: ${b.dataset.cap}`); }
  });
  $('.rail').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) openTab(b.dataset.tab); });
  const railFade = () => { const n = $('.rail'); n.classList.toggle('ft', n.scrollTop > 1); n.classList.toggle('fb', n.scrollTop + n.clientHeight < n.scrollHeight - 1); }; // a fade where more tabs are hidden
  $('.rail').addEventListener('scroll', railFade, { passive: true }); addEventListener('resize', railFade); railFade();
  const panes = $('.panes');
  panes.addEventListener('click', e => { // gallery tiles and rows
    const b = e.target.closest('button');
    if (!b || b.disabled || !P) return;
    const d = b.dataset;
    if (d.fx) addEffect(d.fx);
    else if (d.fxcat) { G.fxCat = d.fxcat; renderEffects(); }
    else if (d.trset) applyTransition(d.trset);
    else if (d.lookset) applyLook(d.lookset);
    else if (d.stcat) { G.stCat = d.stcat; renderStickers(); }
    else if (d.emoji) addText('Sticker', { text: d.emoji });
    else if (d.sfx) addSfx(d.sfx).catch(err => toast(err.message));
    else if (d.sfxplay) listen(`/sfx/${d.sfxplay}.wav`, b);
    else if (d.mplay) listen(`/media/${d.mplay}`, b);
    else if (d.addaudio) addMedia(d.addaudio, 'audio', S.t);
    else if (d.aitool) quiet((async () => aiTool(d.aitool))());
    else if (d.mfilter) { G.mfilter = d.mfilter; $$('#mediaFilter button').forEach(x => x.classList.toggle('on', x === b)); renderMediaList(); }
  });
  panes.addEventListener('pointerover', e => { const t = e.target.closest('.tile'); if (t !== G.hover) { const was = G.hover; G.hover = t; if (was) drawTiles(true); if (t && !G.raf) G.raf = requestAnimationFrame(galleryLoop); } });
  panes.addEventListener('pointerleave', () => { if (G.hover) { G.hover = null; drawTiles(true); } });
  $$('.pane').forEach(p => p.addEventListener('scroll', () => { if (!G.scrollRaf) G.scrollRaf = requestAnimationFrame(() => { G.scrollRaf = 0; drawTiles(true); }); }, { passive: true }));
  for (const [id, unit] of [['trDur', 's'], ['lookAmt', '%']]) $(`#${id}`).addEventListener('input', e => { fill(e.target); e.target.nextElementSibling.textContent = fmt(+e.target.value, unit); });
  $('#btnTrAll').addEventListener('click', () => applyTransition(G.lastTr || cutTarget()?.tr?.type || 'fade', true));
  $('#btnTrNone').addEventListener('click', () => applyTransition('none'));
  $('#btnAddText').addEventListener('click', () => { addText('Subtitle'); editText(); });
  $('#musicStyles').innerHTML = Object.keys(MUSIC_STYLES).map(k => `<button data-mstyle="${esc(k)}">${esc(k)}</button>`).join('');
  $('#musicStyles').addEventListener('click', e => { const b = e.target.closest('[data-mstyle]'); if (b) { $('#musicPrompt').value = MUSIC_STYLES[b.dataset.mstyle]; for (const x of $('#musicStyles').children) x.classList.toggle('on', x === b); } });
  $('#btnMusic').addEventListener('click', async () => {
    const b = $('#btnMusic'), prompt = $('#musicPrompt').value.trim();
    if (!prompt) return toast('Describe the music, or pick a style');
    b.disabled = true;
    try { const r = await aiMusic({ prompt, duration: +$('#musicLen').value }); $('#musicStatus').textContent = `Added "${r.media}" at the playhead.`; }
    catch (err) { $('#musicStatus').textContent = err.message; }
    finally { b.disabled = false; }
  });
  $('#btnStickerAI').addEventListener('click', async () => {
    const prompt = $('#stPrompt').value.trim(), b = $('#btnStickerAI');
    if (!prompt) return toast('Describe the sticker first');
    b.disabled = true; $('#stStatus').textContent = 'Drawing it on this Mac (30-60 s)…';
    try { await aiImage({ prompt, shape: '1:1', sticker: true, steps: 8, put: 'overlay' }); $('#stStatus').textContent = 'Added on the overlay track at the playhead.'; }
    catch (err) { $('#stStatus').textContent = err.message; }
    finally { b.disabled = false; }
  });
  $('#btnDup').addEventListener('click', dup);
  $('#btnFreeze').addEventListener('click', () => { const c = selClip(); if (c) quiet(freeze(c, S.sel.lane)); });
  $('#btnReverse').addEventListener('click', () => { const c = selClip(); if (c) quiet(remake(c, 'reverse')); });
  $('#btnMirror').addEventListener('click', () => { const c = selClip(); if (c) change(() => { c.flip = !c.flip; }); });
  $('#btnRotate').addEventListener('click', () => { const c = selClip(); if (c) rotate90(c); });
  $('#btnFit').addEventListener('click', fitTimeline);
  $('#btnLink').addEventListener('click', () => { if (P.unlinked) delete P.unlinked; else P.unlinked = true; scheduleSave(); renderAll(); toast(P.unlinked ? 'Unlinked: the other tracks stay put when the main track changes' : 'Linked: the other tracks follow the main track'); });
  $('#btnMulticam').addEventListener('click', openMulticam);
  $('#btnScope').addEventListener('click', () => { SCOPE.on = !SCOPE.on; $('#scope').hidden = !SCOPE.on; $('#btnScope').classList.toggle('on', SCOPE.on); $('#btnScope').setAttribute('aria-pressed', SCOPE.on); S.dirty = true; });
  $('#scope').addEventListener('click', e => { const b = e.target.closest('[data-scope]'); if (b) { SCOPE.kind = b.dataset.scope; for (const x of $('#scope').querySelectorAll('[data-scope]')) x.classList.toggle('on', x === b); S.dirty = true; } });

  $('#mediaList').addEventListener('click', async e => {
    const b = e.target.closest('[data-add]'), rm = e.target.closest('[data-rm]');
    if (b) { const r = srcRange(b.dataset.add); return addMedia(b.dataset.add, undefined, r ? S.t : undefined, r); } // a marked range goes in at the playhead
    const it = !rm && e.target.closest('.mitem[data-media]');
    if (it) { const R = it.getBoundingClientRect(); return openSource(it.dataset.media, clamp((e.clientX - R.left) / R.width, 0, 1) * (M.get(it.dataset.media)?.duration || 0)); }
    if (!rm) return;
    const m = M.get(rm.dataset.rm), used = LANES.some(L => P[L.key].some(c => c.media === m.id));
    if (used) return toast(`"${m.name}" is used in this project; delete those clips first`);
    const others = await api(`/api/media/${m.id}/uses`).then(l => l.filter(x => x.id !== P.id)).catch(() => []); // other projects that would lose it
    const also = others.length ? `\n\nIt's used in ${others.length} other project${others.length > 1 ? 's' : ''} (${others.slice(0, 3).map(x => x.name).join(', ')}${others.length > 3 ? ', …' : ''}): there it will show as missing until you put it back from the trash.` : '';
    if (!confirm(`Remove "${m.name}" from the library? It moves to Movies/Cutroom/trash.${also}`)) return;
    try { await api(`/api/media/${m.id}/trash`, {}); await loadMedia(); } catch (err) { toast(err.message); }
  });
  $('#mediaList').addEventListener('dragstart', e => {
    const it = e.target.closest('[data-media]');
    if (it) { e.dataTransfer.setData('text/cutroom-media', it.dataset.media); e.dataTransfer.effectAllowed = 'copy'; }
  });
  const lanes = $('#lanes');
  lanes.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/cutroom-media')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const over = e.target.closest('.lane');
    $$('.lane').forEach(l => l.classList.toggle('drop', l === over));
  });
  lanes.addEventListener('dragleave', e => { if (!lanes.contains(e.relatedTarget)) $$('.lane.drop').forEach(l => l.classList.remove('drop')); });
  lanes.addEventListener('drop', e => {
    $$('.lane.drop').forEach(l => l.classList.remove('drop'));
    const id = e.dataTransfer.getData('text/cutroom-media');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    addMedia(id, e.target.closest('.lane')?.dataset.lane, Math.max(0, (e.clientX - $('#tlInner').getBoundingClientRect().left) / S.pps), srcRange(id));
  });
  $('#mediaList').addEventListener('pointermove', skimAt);
  $('#mediaList').addEventListener('pointerleave', skimEnd);
  $('#mediaSearch').addEventListener('input', renderMediaList);
  $('#mediaSort').addEventListener('change', renderMediaList);
  $('#srcPos').addEventListener('input', e => { fill(e.target); srcSeek(+e.target.value); });
  $('#srcBar').addEventListener('click', e => {
    const k = e.target.closest('[data-src]')?.dataset.src;
    if (k === 'i' || k === 'o') srcMark(k);
    else if (k === 'add') { const r = srcRange(S.src.id); addMedia(S.src.id, 'main', S.t, r); }
    else if (k === 'close') closeSource();
  });
  addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', e => { document.body.classList.remove('dropping'); if (e.dataTransfer.files.length) { e.preventDefault(); importFiles(e.dataTransfer.files); } });

  $('#tlInner').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !P) return;
    closeSource(); // back to the timeline
    const th = e.target.closest('.trh');
    if (th) { S.sel = { lane: 'tr', id: th.dataset.trFor }; renderAll(); S.dirty = true; return; }
    const el = e.target.closest('.clip');
    if (!el) return scrub(e);
    const lane = el.dataset.lane, c = P[lane].find(x => x.id === el.dataset.id);
    if (!c) return;
    if (locked(lane, c)) return toast('That track is locked: click its lock to edit it');
    if (e.shiftKey || e.metaKey) { // ⇧ / ⌘-click: add the clip to the selection, or take it out
      const k = selKey(lane, c.id);
      if (isSel(lane, c.id) && selection().length > 1) {
        S.multi.delete(k);
        if (S.sel?.lane === lane && S.sel.id === c.id) { const nx = [...S.multi][0]; S.multi.delete(nx); S.sel = { lane: nx.slice(0, nx.indexOf(':')), id: nx.slice(nx.indexOf(':') + 1) }; }
      } else if (!isSel(lane, c.id)) { if (S.sel && S.sel.lane !== 'tr') S.multi.add(selKey(S.sel.lane, S.sel.id)); S.sel = { lane, id: c.id }; }
      renderTimeline(); renderInspector(); S.dirty = true;
      return;
    }
    if (!isSel(lane, c.id)) S.multi.clear(); // a click on an unselected clip starts over; on a selected one it keeps the group, to drag it
    if (S.sel?.id !== c.id) { S.sel = { lane, id: c.id }; renderInspector(); $$('.clip.sel').forEach(x => { if (!S.multi.has(selKey(x.dataset.lane, x.dataset.id))) x.classList.remove('sel'); }); el.classList.add('sel'); S.dirty = true; }
    const fh = e.target.closest('.fh'), km = e.target.closest('.kfm');
    if (km) kfDrag(e, c, el, c.kf?.[+km.dataset.k]); else if (fh) fadeDrag(lane, c, el, fh.classList.contains('l')); else drag(e, lane, c, el);
  });
  $('#tlInner').addEventListener('contextmenu', e => { // right-click: the clip's menu, the cut's menu, or paste
    if (!P) return;
    e.preventDefault();
    const th = e.target.closest('.trh'), el = e.target.closest('.clip');
    if (th) {
      const c = P.main.find(x => x.id === th.dataset.trFor);
      S.sel = { lane: 'tr', id: c.id }; S.multi.clear(); renderAll(); S.dirty = true;
      return openMenu(e.clientX, e.clientY, [['Transitions…', () => openTab('transitions')], ['Use this one on every cut', () => applyTransition(c.tr?.type || 'fade', true), '', !c.tr], '-', ['Remove transition', () => change(() => { delete c.tr; }), '⌫', !c.tr]]);
    }
    if (!el) {
      const left = $('#tlInner').getBoundingClientRect().left;
      S.t = snap(clamp((e.clientX - left) / S.pps, 0, total())); placePlayhead(); S.dirty = true;
      return openMenu(e.clientX, e.clientY, [['Paste here', () => paste(), '⌘V', !clipboard], ['Add marker', toggleMarker, 'M'], ['Select all', selectAll, '⌘A'], '-', ['Fit the edit in view', fitTimeline]]);
    }
    const lane = el.dataset.lane, c = P[lane].find(x => x.id === el.dataset.id);
    if (!c) return;
    if (locked(lane, c)) return toast('That track is locked: click its lock to edit it');
    if (!isSel(lane, c.id)) { S.multi.clear(); S.sel = { lane, id: c.id }; renderTimeline(); renderInspector(); S.dirty = true; }
    openMenu(e.clientX, e.clientY, clipMenu(c, lane));
  });
  $('#tlScroll').addEventListener('scroll', () => { // scrolled past what's rendered: render the new stretch (once per frame)
    const sc = $('#tlScroll'), [a, b] = S.tlWin || [0, 0];
    if ((sc.scrollLeft < a + 1 || sc.scrollLeft + sc.clientWidth > b - 1) && !S.tlRaf) S.tlRaf = requestAnimationFrame(() => { S.tlRaf = 0; renderTimeline(); });
  }, { passive: true });
  $('#tlScroll').addEventListener('wheel', e => {
    const sc = $('#tlScroll');
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.pps * Math.exp(-e.deltaY * 0.003), e.clientX - sc.getBoundingClientRect().left); }
    else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); sc.scrollLeft += e.deltaY; }
  }, { passive: false });

  $('#cv').addEventListener('pointerdown', e => { // select and drag things directly on the preview
    if (!P) return;
    const cv = $('#cv'), r = cv.getBoundingClientRect(), px = cv.width / r.width;
    const x = (e.clientX - r.left) * px, y = (e.clientY - r.top) * px;
    if (S.keyPick) { // the clip's own graded pixel under the click: repaint this frame with its key off, read it, put the key back
      const c = [...P.main, ...P.overlay].find(q => q.id === S.keyPick);
      S.keyPick = null; cv.style.cursor = '';
      if (!c?.key) return;
      const saved = c.key;
      c.key = null; paint();
      const px1 = cv.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
      c.key = saved;
      change(() => { c.key.color = `#${[px1[0], px1[1], px1[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`; });
      return toast('Key colour picked');
    }
    if (S.pick) { // rubber-band the tracking target (project canvas units)
      const kk = cv.width / P.w, x0p = x / kk, y0p = y / kk;
      const mv = ev => {
        const x1 = ((ev.clientX - r.left) * px) / kk, y1 = ((ev.clientY - r.top) * px) / kk;
        S.pickRect = { x: Math.min(x0p, x1), y: Math.min(y0p, y1), w: Math.abs(x1 - x0p), h: Math.abs(y1 - y0p) };
        S.dirty = true;
      };
      const upp = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', upp);
        const R = S.pickRect;
        S.pickRect = null; S.dirty = true;
        if (R && R.w > 8 && R.h > 8) (S.pick.remove ? finishRemove : finishTrack)(R); else { S.pick = null; toast('Cancelled'); }
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', upp);
      return;
    }
    if (S.maskPreview) return refinePreview(x / (cv.width / P.w), y / (cv.width / P.w), !e.altKey); // clicks shape the outline
    const hs = S.sel && canHandle(S.sel.lane) && selection().length === 1 && hits.find(h => h.id === S.sel.id), hk = hs && handleAt(hs, x, y);
    if (hk) return handleDrag(e, hs, hk, cv);
    const hit = [...hits].reverse().find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1 && !locked(h.lane, P[h.lane].find(q => q.id === h.id) || {}));
    if (!hit) { if (S.sel) { S.sel = null; renderAll(); S.dirty = true; } return; }
    if (S.sel?.id !== hit.id) { S.sel = { lane: hit.lane, id: hit.id }; renderAll(); S.dirty = true; }
    const c = selClip();
    if (!c) return;
    const before = JSON.stringify(P), k = cv.width / P.w, x0 = e.clientX, y0 = e.clientY;
    const o = hit.lane === 'captions' ? { y: P.capStyle.y } : propsAt(c, S.t - c.start);
    // text snaps (6 px, ⌘ to move freely) its box centre to the frame centre and other text, its edges to the safe margin
    const SAFE = 0.05, bx = { x: [(hit.x0 + hit.x1) / 2 / k / P.w - o.x, (hit.x1 - hit.x0) / 2 / k / P.w], y: [(hit.y0 + hit.y1) / 2 / k / P.h - o.y, (hit.y1 - hit.y0) / 2 / k / P.h] };
    const others = hits.filter(h => h.lane === 'text' && h.id !== hit.id);
    const snapAxis = (a, v, ev) => { // -> [value, guide line] for one axis
      const [off, half] = bx[a], tol = (6 * px) / k / (a === 'x' ? P.w : P.h), ctr = v + off;
      const cand = [[0.5, 0.5], ...others.map(h => { const q = a === 'x' ? (h.x0 + h.x1) / 2 / k / P.w : (h.y0 + h.y1) / 2 / k / P.h; return [q, q]; }), [SAFE + half, SAFE], [1 - SAFE - half, 1 - SAFE]];
      const best = ev.metaKey ? null : cand.map(([to, line]) => [Math.abs(to - ctr), to, line]).filter(q => q[0] <= tol).sort((p, q) => p[0] - q[0])[0];
      return best ? [best[1] - off, best[2]] : [v, null];
    };
    const move = ev => {
      const dx = ((ev.clientX - x0) * px) / k / P.w, dy = ((ev.clientY - y0) * px) / k / P.h;
      if (hit.lane === 'captions') P.capStyle.y = clamp(o.y + dy, 0, 1);
      else if (hit.lane === 'text') {
        const [nx, gx] = snapAxis('x', o.x + dx, ev), [ny, gy] = snapAxis('y', o.y + dy, ev);
        setProp(c, 'x', clamp(nx, 0, 1)); setProp(c, 'y', clamp(ny, 0, 1));
        S.guides = { x: gx, y: gy };
      } else { const lim = v => (c.media ? v : clamp(v, 0, 1)); setProp(c, 'x', lim(o.x + dx)); setProp(c, 'y', lim(o.y + dy)); }
      S.dirty = true;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (S.guides) { S.guides = null; S.dirty = true; }
      if (JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  $('#cv').addEventListener('dblclick', () => { if (['text', 'captions'].includes(S.sel?.lane)) editText(); }); // the first click selected it
  $('#cv').addEventListener('pointermove', e => { // the cursor says what a handle does
    if (e.buttons || S.pick || S.keyPick || !P) return;
    const cv = $('#cv'), r = cv.getBoundingClientRect(), px = cv.width / r.width, h = S.sel && canHandle(S.sel.lane) && selection().length === 1 && hits.find(q => q.id === S.sel.id);
    const k = h && handleAt(h, (e.clientX - r.left) * px, (e.clientY - r.top) * px);
    cv.style.cursor = k === 'rot' ? 'grab' : k ? (k === 'nw' || k === 'se' ? 'nwse-resize' : 'nesw-resize') : '';
  });
  $('#cv').addEventListener('contextmenu', e => {
    if (!P) return;
    e.preventDefault();
    const cv = $('#cv'), r = cv.getBoundingClientRect(), px = cv.width / r.width, x = (e.clientX - r.left) * px, y = (e.clientY - r.top) * px;
    const hit = [...hits].reverse().find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    if (!hit) return openMenu(e.clientX, e.clientY, [['Paste at the playhead', () => paste(), '⌘V', !clipboard], ['Theater view', () => toggleTheater(), 'F']]);
    const c = P[hit.lane].find(q => q.id === hit.id);
    if (!c) return;
    if (!isSel(hit.lane, c.id)) { S.multi.clear(); S.sel = { lane: hit.lane, id: c.id }; renderAll(); S.dirty = true; }
    openMenu(e.clientX, e.clientY, clipMenu(c, hit.lane));
  });
  $('#confirmBar').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) endPreview(['ok', 'again', 'smaller', 'bigger'].find(k => k in b.dataset) || null); });
  $('#btnTheater').innerHTML = ICON.expand;
  $('#btnTheater').addEventListener('click', () => toggleTheater());
  $('#scriptBody').addEventListener('pointerdown', e => { // click a word: jump there; drag or ⇧-click: select words
    const w = e.target.closest('[data-i]'), g = e.target.closest('[data-g]');
    if (g) { SC.sel = { gap: +g.dataset.g }; const p = SC.words[+g.dataset.g - 1]; if (p) seekTo(p.t1); markScript(); return; }
    if (!w) return;
    const i = +w.dataset.i;
    if (e.shiftKey && SC.anchor !== null && Array.isArray(SC.sel)) SC.sel = [Math.min(SC.anchor, i), Math.max(SC.anchor, i)];
    else { SC.anchor = i; SC.sel = [i, i]; SC.drag = true; }
    seekTo(SC.words[i].t0); markScript();
  });
  $('#scriptBody').addEventListener('pointerover', e => {
    const w = SC.drag && e.buttons && e.target.closest('[data-i]');
    if (w) { const i = +w.dataset.i; SC.sel = [Math.min(SC.anchor, i), Math.max(SC.anchor, i)]; markScript(); }
  });
  addEventListener('pointerup', () => { SC.drag = false; });
  $('#btnScriptCut').addEventListener('click', () => cutScript());
  $('#btnScriptLoad').addEventListener('click', () => renderScript());
  $('#btnScriptFill').addEventListener('click', () => quiet(removeFillers()));
  $('#btnScriptPause').addEventListener('click', () => quiet(removePauses(0.5)));
  $('#capList').addEventListener('change', e => {
    const inp = e.target.closest('[data-capid]'), c = inp && P.captions.find(x => x.id === inp.dataset.capid);
    if (c && inp.value.trim() !== c.text) change(() => { c.text = inp.value.trim(); retext(c); });
  });
  $('#capList').addEventListener('click', e => { const b = e.target.closest('[data-capgo]'), c = b && P.captions.find(x => x.id === b.dataset.capgo); if (c) { seekTo(c.start + 0.01); S.sel = { lane: 'captions', id: c.id }; renderAll(); S.dirty = true; } });
  $('#tplList').addEventListener('click', e => { const b = e.target.closest('[data-tpl]'); if (b) addTemplate(b.dataset.tpl); });

  const insp = $('#inspector');
  insp.addEventListener('pointerdown', e => { // colour wheels and the curve editor: one undo step per drag
    const wcv = e.target.closest('canvas[data-wheel]'), svg = e.target.closest('#curveSvg'), c = selClip();
    if (!c || (!wcv && !svg)) return;
    e.preventDefault();
    const before = JSON.stringify(P), el = wcv || svg, r = el.getBoundingClientRect();
    const pos = ev => [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
    let set;
    if (wcv) {
      const k = wcv.dataset.wheel;
      set = ev => { const [u, v] = pos(ev), R = (wcv.width / 2 - 6) / wcv.width; let x = (u - 0.5) / R, y = (0.5 - v) / R; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; } c.grade ??= {}; c.grade[k] = { ...c.grade[k], x: +x.toFixed(3), y: +y.toFixed(3) }; drawWheels(c); };
    } else {
      const ch = svg.dataset.ch, pts = (c.grade?.curves?.[ch] || [[0, 0], [1, 1]]).map(q => [...q]), [u, v] = pos(e), d = q => Math.hypot(q[0] - u, 1 - q[1] - v);
      let i = pts.findIndex(q => d(q) < 0.06);
      if (e.detail === 2 && i > 0 && i < pts.length - 1) { change(() => { pts.splice(i, 1); c.grade ??= {}; c.grade.curves = { ...c.grade.curves, [ch]: pts }; }); return; }
      if (i < 0) { const nu = +u.toFixed(3); pts.push([nu, +(1 - v).toFixed(3)]); pts.sort((a, b) => a[0] - b[0]); i = pts.findIndex(q => q[0] === nu); }
      const lo = i ? pts[i - 1][0] + 0.01 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1, ends = i === 0 || i === pts.length - 1;
      set = ev => { const [x, y] = pos(ev); pts[i] = [ends ? pts[i][0] : +clamp(x, lo, hi).toFixed(3), +(1 - y).toFixed(3)]; c.grade ??= {}; c.grade.curves = { ...c.grade.curves, [ch]: pts.map(q => [...q]) }; drawCurve(c); };
    }
    set(e); S.dirty = true;
    const mv = ev => { set(ev); S.dirty = true; }, up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); } };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  insp.addEventListener('dblclick', e => { const w = e.target.closest('canvas[data-wheel]'), c = selClip(); if (w && c?.grade?.[w.dataset.wheel]) change(() => { delete c.grade[w.dataset.wheel].x; delete c.grade[w.dataset.wheel].y; }); });
  insp.addEventListener('input', e => {
    if (!e.target.dataset.k) return;
    pending ??= JSON.stringify(P); // one undo step per gesture, committed on 'change'
    apply(e.target);
    if (e.target.type === 'range') fill(e.target);
    const out = e.target.parentElement.querySelector('output');
    if (out) out.textContent = fmt(+e.target.value, e.target.dataset.unit);
    S.dirty = true;
    scheduleSave();
    renderTimeline();
  });
  insp.addEventListener('change', e => {
    if (e.target.id === 'lutSel') { const c = selClip(), id = e.target.value; change(() => { c.grade ??= {}; if (id) c.grade.lut = { id, amount: c.grade.lut?.amount ?? 1 }; else delete c.grade.lut; }); if (id) loadLut(id); return; }
    if ('fontin' in e.target.dataset && e.target.files[0]) { const c = selClip(); importFont(e.target.files[0]).then(f => change(() => { c.style ??= {}; c.style.font = f.family; c.style.weight = 400; })).catch(err => setStatus(err.message)); return; }
    if ('lutin' in e.target.dataset && e.target.files[0]) { const c = selClip(); importLutFile(e.target.files[0]).then(L => change(() => { c.grade ??= {}; c.grade.lut = { id: L.id, amount: 1 }; })).catch(err => setStatus(err.message)); return; }
    if ('relink' in e.target.dataset && e.target.files[0]) { const c = selClip(), f = e.target.files[0]; setStatus(`Importing ${f.name}…`); uploadOne(f).then(m => relink(c.media, m.id)).catch(err => setStatus(err.message)); return; }
    if (!e.target.dataset.k) return;
    if (pending) { undo.push(pending); redo = []; pending = null; syncHistory(); }
    renderTimeline();
    const k = e.target.dataset.k;
    if (k === 'c.speed' || k === 'c.pitch') warmTempo(selClip()); // the new speed's sound is made now, not when Space is pressed
    if (k === 'p.fps') renderAll();
    else if (selClip()?.kf || k === 'c.tr.d' || k === 'c.speed' || e.target.tagName === 'SELECT' || e.target.type === 'checkbox') renderInspector(); // controls that depend on it
  });
  insp.addEventListener('click', e => {
    const out = e.target.closest('output');
    if (out) { e.preventDefault(); return editOutput(out); }
    const b = e.target.closest('button');
    if (!b) return;
    const c = selClip(), d = b.dataset;
    if (d.itab) {
      S.itab = d.itab;
      $$('#inspector .itabs button').forEach(x => x.classList.toggle('on', x === b));
      $$('#inspector .isec').forEach(x => x.classList.toggle('on', x.dataset.sec === d.itab));
    } else if (d.ratio) { change(() => { [P.w, P.h] = RATIOS[d.ratio]; }); fitStage(); }
    else if (d.fps) { change(() => { P.fps = +d.fps; }); renderAll(); }
    else if (d.fit) change(() => { c.fit = d.fit; });
    else if (d.cappreset) change(() => { P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS[d.cappreset], y: P.capStyle.y }; });
    else if (d.textpreset) change(() => { c.style = { ...TEXT_PRESETS[d.textpreset] }; });
    else if (d.act === 'split') split();
    else if (d.act === 'delete') del();
    else if (d.voice) setVoice(c, d.voice);
    else if (d.act === 'dup') dup();
    else if (d.act === 'reset') change(() => { Object.assign(c, { speed: 1, volume: 1, fit: S.sel.lane === 'overlay' ? 'fill' : 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 }, flip: false, denoise: false, rot: 0, ease: false }); delete c.kf; delete c.look; delete c.crop; delete c.key; delete c.mask; delete c.mkf; delete c.grade; delete c.lkf; delete c.blend; delete c.vkf; delete c.duck; delete c.anim; delete c.pitch; delete c.au; });
    else if (d.act === 'clearcaps') change(() => { P.captions = []; S.sel = null; });
    else if (d.tr) change(() => { if (d.tr === 'none') delete c.tr; else c.tr = { type: d.tr, d: c.tr?.d ?? 0.5 }; });
    else if (d.act === 'trall') change(() => { for (const x of P.main.slice(0, -1)) { if (c.tr) x.tr = { ...c.tr }; else delete x.tr; } });
    else if (d.look) change(() => { if (d.look === 'none') delete c.look; else c.look = { name: d.look, amount: c.look?.amount ?? 1 }; });
    else if (['kfadd', 'kfdel', 'kfclear'].includes(d.act)) kfOp(c, S.sel.lane, d.act.slice(2));
    else if (d.act === 'beats') quiet(detectBeats(c));
    else if (d.act === 'beatsync') beatSync(c, +$('#beatEvery').value);
    else if (d.act === 'freeze') quiet(freeze(c, S.sel.lane));
    else if (d.act === 'movelane') moveLane(c, S.sel.lane);
    else if (d.act === 'matte') quiet(removeBackground(c));
    else if (d.act === 'track') startTrack(c, S.sel.lane);
    else if (d.act === 'removeobj') startRemove(c, S.sel.lane);
    else if (d.act === 'cutobj') startRemove(c, S.sel.lane, 'cutout');
    else if (d.mask) change(() => { if (d.mask === 'none') { delete c.mask; delete c.mkf; } else c.mask = { x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 0.04, invert: false, ...c.mask, type: d.mask }; });
    else if (d.act === 'ramp') ramp(c, S.sel.lane, $('#rampSel').value);
    else if (d.act === 'detach') detachAudio(c);
    else if (d.act === 'isovoice' || d.act === 'novoice') quiet(isolateVoice(c, S.sel.lane, d.act === 'isovoice' ? 'voice' : 'music'));
    else if (d.act === 'reverse' || d.act === 'stabilize') quiet(remake(c, d.act));
    else if (d.act === 'denoise') quiet(denoiseVideo(c, $('#dnStrength')?.value));
    else if (d.act === 'scenes') quiet(sceneSplit(c, S.sel.lane));
    else if (d.act === 'reframe') quiet(autoReframe(c));
    else if (d.act === 'kfease') change(() => { const f = c.kf.find(x => Math.abs(x.t - (S.t - c.start)) < 0.5 / P.fps); if (f) f.ease = !(f.ease ?? c.ease); });
    else if (d.act === 'duck') quiet(autoDuck(c, +($('#duckDepth')?.value || 0.25)));
    else if (d.align) change(() => { (c.style ??= {}).align = d.align; });
    else if (d.act === 'capall') { change(() => { Object.assign(P.capStyle, c.style); for (const x of P.captions) delete x.style; }); toast('Every caption has this style now'); }
    else if (d.act === 'keypick') { S.keyPick = c.id; $('#cv').style.cursor = 'crosshair'; toast('Click the colour to remove on the preview (Esc cancels)'); }
    else if (d.act === 'fwd' || d.act === 'back') restack(c, d.act === 'fwd' ? 1 : -1);
    else if (d.act === 'kfprev' || d.act === 'kfnext') {
      const lt = S.t - c.start, ts = (c.kf || []).map(f => f.t), t = d.act === 'kfprev' ? ts.filter(x => x < lt - 1e-3).at(-1) : ts.find(x => x > lt + 1e-3);
      if (t !== undefined) seekTo(c.start + t);
    }
    else if (d.act === 'vkfclear' || d.act === 'unduck') change(() => { delete c.vkf; delete c.duck; });
    else if (d.act === 'soundreset') { change(() => { delete c.au; }); renderInspector(); }
    else if (d.act === 'stems') quiet(splitStems(c, S.sel.lane));
    else if (d.act === 'vkprev' || d.act === 'vknext') {
      const lt = S.t - c.start, ts = (c.vkf || []).map(f => f.t), t = d.act === 'vkprev' ? ts.filter(x => x < lt - 1e-3).at(-1) : ts.find(x => x > lt + 1e-3);
      if (t !== undefined) { seekTo(c.start + t); renderInspector(); }
    }
    else if (d.act === 'vkdel') { change(() => { const lt = S.t - c.start; delete c.duck; c.vkf = c.vkf.filter(f => Math.abs(f.t - lt) >= 0.5 / P.fps); if (!c.vkf.length) delete c.vkf; }); renderInspector(); }
    else if (d.act === 'slowmo') quiet(smoothSlowmo(c));
    else if (d.act === 'restore') api(`/api/media/${c.media}/restore`, {}).then(loadMedia).then(() => { if (!M.get(c.media)) throw new Error('not in the trash'); touched(); toast('Restored from the trash'); }).catch(err => setStatus(`Couldn't restore it: ${err.message}. Relink it to the file instead.`));
    else if (d.act === 'relinklib') relink(c.media, $('#relinkSel').value);
    else if (d.curvech) { S.curveCh = d.curvech; renderInspector(); }
    else if (d.hband) { S.hband = d.hband; renderInspector(); }
    else if (d.act === 'curvereset') change(() => { if (c.grade?.curves) delete c.grade.curves[S.curveCh || 'm']; });
    else if (d.act === 'gradereset') change(() => { delete c.grade; delete c.lkf; });
    else if (d.act === 'lkclear') change(() => { delete c.lkf; });
    else if (d.act === 'lkdel') change(() => { const lt = S.t - c.start; c.lkf = (c.lkf || []).filter(f => Math.abs(f.t - lt) >= 0.5 / P.fps); if (!c.lkf.length) delete c.lkf; });
    else if (d.act === 'lkprev' || d.act === 'lknext') {
      const lt = S.t - c.start, ts = (c.lkf || []).map(f => f.t), t = d.act === 'lkprev' ? ts.filter(x => x < lt - 1e-3).at(-1) : ts.find(x => x > lt + 1e-3);
      if (t !== undefined) { seekTo(c.start + t); renderInspector(); }
    }
    else if (d.act === 'mkfadd') change(() => { c.mkf ??= []; maskPoint(c); });
    else if (d.act === 'mkfdel') change(() => { const lt = S.t - c.start; c.mkf = c.mkf.filter(f => Math.abs(f.t - lt) >= 0.5 / P.fps); if (!c.mkf.length) delete c.mkf; });
    else if (d.act === 'mkfclear') change(() => { Object.assign(c.mask, maskAt(c, clamp(S.t - c.start, 0, len(c)))); delete c.mkf; });
    else if (d.act === 'mkfprev' || d.act === 'mkfnext') {
      const lt = S.t - c.start, ts = (c.mkf || []).map(f => f.t), t = d.act === 'mkfprev' ? ts.filter(x => x < lt - 1e-3).at(-1) : ts.find(x => x > lt + 1e-3);
      if (t !== undefined) seekTo(c.start + t);
    }
    else if (d.mcangle) mcCut(+d.mcangle);
    else if (d.body) quiet(bodyEffect(c, S.sel.lane, d.body));
    else if (d.glowkind) change(() => { if (d.glowkind === 'none') delete c.glow; else c.glow = { color: c.glow?.color || (d.glowkind === 'neon' ? '#00e5ff' : '#ffffff'), size: c.glow?.size ?? 0.5, ...(d.glowkind === 'neon' ? { neon: true } : {}) }; });
    else if (d.act === 'compound') makeCompound().catch(err => toast(err.message));
    else if (d.act === 'breakcompound') breakCompound(c);
    else if (d.act === 'keyon') change(() => { c.key = { color: '#00ff00', sim: 0.3, blend: 0.1 }; });
    else if (d.act === 'keyoff') change(() => { delete c.key; });
    else if (d.act === 'autoadj') autoAdjust(c, S.sel.lane).catch(() => {});
    else if (d.act === 'matchcol') autoAdjust(c, S.sel.lane, $('#matchRef').value).catch(() => {});
  });

  const modalClick = async e => {
    if (e.target.id === 'modal') { closeModal(); return; } // an export carries on (the Export button shows how far)
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if ('close' in d) closeModal();
    else if (d.new) { setProject(newProject(d.new)); scheduleSave(); closeModal(); }
    else if ('newsel' in d) { setProject(newProject($('#newRatio').value)); scheduleSave(); closeModal(); }
    else if (d.open) { await openProject(d.open).catch(err => toast(err.message)); closeModal(); }
    else if (b.id === 'exGo') runExport();
    else if (b.id === 'exCancel' && S.exporting?.job) { b.disabled = true; api(`/api/jobs/${S.exporting.job}/cancel`, {}).catch(() => {}); }
    else if (d.trash) trashProject(d.trash, d.name).catch(err => toast(err.message));
    else if (d.dup) { const p = await api(`/api/projects/${d.dup}`); p.id = hex12(); p.name = `${p.name} (copy)`; await api(`/api/projects/${p.id}`, p, 'PUT'); openProjects(); }
    else if ('savetpl' in d) { await saveTemplate(); openTemplates(); }
    else if (d.tpl) showTemplate(d.tpl);
    else if (d.usetpl) useTemplate(d.usetpl);
    else if (d.deltpl) { if (confirm('Delete this template? It moves to Movies/Cutroom/trash.')) { await api(`/api/templates/${d.deltpl}/trash`, {}); openTemplates(); } }
    else if (d.reveal) api('/api/reveal', { file: d.reveal }).catch(err => toast(err.message));
    else if (d.play) open(`/exports/${encodeURIComponent(d.play)}`, '_blank', 'noopener');
  };
  $('#modal').addEventListener('click', e => { modalClick(e).catch(err => toast(err.message)); });

  addEventListener('keydown', e => {
    if (!P) return;
    if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
    if (e.key === 'Escape' && e.target.matches('#inspector textarea')) { e.target.blur(); return; } // back to the timeline keys
    if (e.target.matches('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=color])')) return;
    if (e.repeat && ['Space', 'KeyF', 'KeyM'].includes(e.code)) { e.preventDefault(); return; } // a held key toggles once, not on every repeat
    const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    const field = e.target.matches('input[type=range], input[type=checkbox], input[type=color]');
    if (!$('#confirmBar').hidden && (key === 'enter' || key === 'escape')) { e.preventDefault(); return endPreview(key === 'enter' ? 'ok' : null); }
    if (e.code === 'Space' && !e.target.matches('input[type=checkbox], input[type=color]')) { e.preventDefault(); if (S.playing) pause(); else play(); }
    else if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) restore(redo, undo); else restore(undo, redo); }
    else if (mod && key === 'd') { e.preventDefault(); dup(); }
    else if (mod && e.code === 'KeyC') { e.preventDefault(); copySel(); }
    else if (mod && e.code === 'KeyX') { e.preventDefault(); copySel(true); }
    else if (mod && e.code === 'KeyV') { e.preventDefault(); if (e.altKey) pasteLook(); else paste(); }
    else if (mod && e.code === 'KeyA') { e.preventDefault(); selectAll(); }
    else if (!mod && S.src && (e.code === 'KeyI' || e.code === 'KeyO')) { e.preventDefault(); srcMark(e.code === 'KeyI' ? 'i' : 'o'); }
    else if (!mod && !e.altKey && S.src && !field && (key === 'arrowleft' || key === 'arrowright')) { e.preventDefault(); const m = M.get(S.src.id); srcSeek(S.src.t + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / (m?.fps || 30))); }
    else if (key === 'escape' && S.src && !menuEl) closeSource();
    else if (!mod && /^Digit[1-6]$/.test(e.code) && P.main.some(c => c.mc)) { e.preventDefault(); mcCut(+e.code.slice(5) - 1); }
    else if (!mod && e.code === 'KeyL') { e.preventDefault(); shuttle(1); }
    else if (!mod && e.code === 'KeyJ') { e.preventDefault(); shuttle(-1); }
    else if (!mod && e.code === 'KeyK') { e.preventDefault(); pause(); }
    else if (!mod && (key === 'arrowup' || key === 'arrowdown') && !field) { e.preventDefault(); const pts = editPoints(), t = snap(S.t); seekTo(key === 'arrowup' ? (pts.filter(x => x < t - 1e-6).at(-1) ?? 0) : (pts.find(x => x > t + 1e-6) ?? total())); }
    else if (mod && (e.key === '=' || e.key === '+' || e.key === '-')) { e.preventDefault(); const sc = $('#tlScroll'); setZoom(S.pps * (e.key === '-' ? 0.8 : 1.25), clamp(S.t * S.pps - sc.scrollLeft, 0, sc.clientWidth)); }
    else if (!mod && e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); fitTimeline(); }
    else if (!mod && e.key === '?') { e.preventDefault(); shortcuts(); }
    else if (!mod && e.shiftKey && e.code === 'KeyA') { e.preventDefault(); const off = store.get('cutroom.scrubSound') !== 'off'; store.set('cutroom.scrubSound', off ? 'off' : 'on'); toast(off ? 'Sound while scrubbing: off' : 'Sound while scrubbing: on'); }
    else if (e.altKey && !mod && (key === 'arrowleft' || key === 'arrowright') && !field) { e.preventDefault(); nudge(key === 'arrowleft' ? -1 : 1); }
    else if (!mod && e.code === 'KeyQ') { e.preventDefault(); trimTo('left'); }
    else if (!mod && e.code === 'KeyW') { e.preventDefault(); trimTo('right'); }
    else if (!mod && e.code === 'KeyF') { e.preventDefault(); toggleTheater(); }
    else if ((key === 'backspace' || key === 'delete') && G.tab === 'script' && SC.sel && $('#tab-script').contains(document.activeElement)) { e.preventDefault(); cutScript(); }
    else if ((mod && key === 'b') || (!mod && key === 's')) { e.preventDefault(); split(); }
    else if (!mod && key === 'm') { e.preventDefault(); toggleMarker(); }
    else if ((key === 'backspace' || key === 'delete') && !field) { e.preventDefault(); del(); }
    else if ((key === 'arrowleft' || key === 'arrowright') && !field) { e.preventDefault(); seekTo(S.t + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / P.fps)); }
    else if ((key === 'home' || key === 'end') && !field) { e.preventDefault(); seekTo(key === 'home' ? 0 : total()); }
    else if (key === 'escape' && S.keyPick) { S.keyPick = null; $('#cv').style.cursor = ''; toast('Colour pick cancelled'); }
    else if (key === 'escape' && S.pick) { S.pick = null; toast('Cancelled'); }
    else if (key === 'escape' && menuEl) closeMenu();
    else if (key === 'escape' && document.body.classList.contains('theater')) toggleTheater(false);
    else if (key === 'escape' && (S.sel || S.multi.size)) { S.sel = null; S.multi.clear(); renderAll(); S.dirty = true; }
  });
  new ResizeObserver(fitStage).observe($('#stage'));
  addEventListener('resize', () => renderTimeline());
  document.fonts.addEventListener('loadingdone', () => { S.dirty = true; });
}

// ---------- on-device AI: images (Z-Image-Turbo) and natural voices (Kokoro), both on this Mac ----------
const AI_LANG = { a: 'US English', b: 'UK English', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese' };
const aiVoiceName = v => `${v.slice(3, 4).toUpperCase()}${v.slice(4)} · ${AI_LANG[v[0]] || v[0]}, ${v[1] === 'f' ? 'female' : 'male'}`;
function aiShape(shape) { // generation size for a shape; "canvas" follows the project (about 1 megapixel, multiples of 16)
  const [a, b] = shape === 'canvas' ? [P.w, P.h] : shape.split(':').map(Number), k = Math.sqrt((1024 * 1024) / (a * b));
  return [Math.round((a * k) / 16) * 16, Math.round((b * k) / 16) * 16];
}
async function aiImage({ prompt, shape = 'canvas', sticker = false, steps = 8, seed, put = 'overlay', start = S.t, duration }) {
  const [w, h] = aiShape(shape), st = $('#aiStatus');
  if (st) st.textContent = 'Generating on this Mac…';
  const jb = await job('/api/ai/image', { prompt, w, h, steps, seed, sticker }, 'Generating image', sayIn('#aiStatus'));
  await loadMedia();
  if (st) st.textContent = `Done (seed ${jb.seed}).`;
  if (put === 'main' || put === 'overlay') {
    addMedia(jb.media, put, start);
    const [c, L] = cfind(S.sel.id);
    change(() => { if (duration) c.out = duration; if (sticker && put === 'overlay') Object.assign(c, { fit: 'fit', scale: 0.6 }); }); // stickers start smaller than the frame
    return { media: jb.media, seed: jb.seed, clip: brief(c, L) };
  }
  return { media: jb.media, seed: jb.seed };
}
async function aiVideo({ prompt = '', image, clip, ratio, quality = 'fast', put = 'main', at = S.t, seed, say }) { // a picture brought to life on the RTX 4090 PC (Wan 2.2), ~5 s
  let img = image ? mediaBy(image) : null;
  if (!img) {
    packMain();
    const c = clip ? cfind(clip)[0] : (S.sel && S.sel.lane !== 'tr' && selClip()?.media ? selClip() : P.main.find(x => S.t >= x.start && S.t < x.start + tdur(x, 'main')));
    const m = c && M.get(c.media);
    if (!m || m.kind === 'audio') throw new Error('select a photo or a video clip to animate (its frame at the playhead is the start)');
    if (m.kind === 'image') img = m;
    else { const lt = clamp(S.t - c.start, 0, len(c)), st = await api('/api/still', { media: m.id, t: c.in + lt * c.speed }); await loadMedia(); img = M.get(st.id); }
  }
  if (img?.kind !== 'image') throw new Error('start from a picture');
  const r = ratio || (img.w > img.h * 1.2 ? '16:9' : img.h > img.w * 1.2 ? '9:16' : '1:1');
  const j = await job('/api/ai/video', { image: img.id, prompt, ratio: r, quality, seed }, 'Animating it on the GPU PC', say);
  await loadMedia();
  if (put === 'main' || put === 'overlay') { addMedia(j.media, put, at); return { media: j.media, seed: j.seed, clip: brief(...cfind(S.sel.id)) }; }
  return { media: j.media, seed: j.seed };
}
async function aiVoice({ text, voice = 'af_heart', speed = 1, at = S.t }) {
  const jb = await job('/api/ai/voice', { text, voice, speed }, 'Generating voice', sayIn('#aiVoiceStatus'));
  await loadMedia();
  addMedia(jb.media, 'audio', at);
  return brief(...cfind(S.sel.id));
}
const COMBINE_MUSIC = { // what 'AI music, made to fit' asks MusicGen for, per smart-combine style
  balanced: 'uplifting indie pop, warm guitars, steady drums, feel good, 110 bpm', energetic: 'energetic electronic pop, punchy drums, bright synths, 124 bpm',
  calm: 'calm acoustic ambient, soft piano and guitar, gentle, 80 bpm', cinematic: 'epic cinematic orchestral, strings and big drums, building, 100 bpm' };
async function smartCombine({ media, length = 30, style = 'balanced', order = 'auto', music, ratio = '9:16', sound = true, title = false, reframe = true }) { // CapCut's AutoCut, on this Mac
  const vids = [...new Set((Array.isArray(media) ? media : [media]).map(q => mediaBy(q)))].filter(m => m.kind === 'video');
  if (!vids.length) throw new Error('pick at least one video');
  if (music === 'ai') { // music made for this edit: the style's sound, as long as the edit asks (or the longest MusicGen piece)
    const r = await aiMusic({ prompt: COMBINE_MUSIC[style] || COMBINE_MUSIC.balanced, duration: Math.min(60, +length || 60), add: false, say: sayIn('#scStatus') });
    music = r.id;
  }
  const mus = music ? mediaBy(music) : null;
  if (mus && !mus.hasAudio) throw new Error(`${mus.name} has no sound`);
  if (!RATIOS[ratio]) throw new Error(`ratio must be one of ${Object.keys(RATIOS).join(', ')}`);
  const say = sayIn('#scStatus');
  say('Looking at every shot…');
  const plan = await job('/api/ai/combine', { media: vids.map(m => m.id), target: +length || 0, style, order, music: mus?.id, sound }, 'Combining', say);
  setProject(newProject(ratio));
  P.name = plan.title || `Smart combine ${new Date().toLocaleDateString()}`;
  const slow = Math.min(...vids.map(m => m.fps || 30)); // the footage's frame rate (60 fps camera clips stay smooth), never above the slowest clip's
  P.fps = [24, 25, 30, 50, 60].reduce((a, f) => (Math.abs(f - slow) < Math.abs(a - slow) ? f : a));
  for (const s of plan.shots) {
    addMedia(s.media, 'main');
    const c = P.main.at(-1);
    change(() => { Object.assign(c, { in: s.in, out: s.out, volume: sound ? 1 : 0 }); if (s.tr) c.tr = { ...s.tr }; });
  }
  say('Framing the shots…');
  for (const c of P.main) { // other shapes fill the canvas; faces stay in frame
    const m = M.get(c.media);
    if (Math.abs(m.w / m.h - P.w / P.h) > 0.15) { change(() => { c.fit = 'fill'; }); if (reframe) await autoReframe(c).catch(() => {}); }
  }
  if (mus) {
    packMain();
    addMedia(mus.id, 'audio', 0);
    const a = P.audio.at(-1);
    await detectBeats(a).catch(() => {});
    if (a.beats?.length) change(() => { // each cut moves to the nearest beat, never past its shot's own scene
      const marks = a.beats.map(b => a.start + (b - a.in) / a.speed);
      P.main.slice(0, -1).forEach((x, i) => {
        packMain();
        const half = (x.tr?.d || 0) / 2, endT = x.start + tdur(x, 'main') - half;
        const mk = marks.reduce((best, v) => (Math.abs(v - endT) < Math.abs(best - endT) ? v : best), Infinity);
        const want = x.in + (mk + half - x.start) * x.speed;
        if (plan.shots[i].speech) return; // someone is talking: the cut stays where the word ends
        if (Number.isFinite(mk) && mk - x.start > 0.8 && want <= Math.min(plan.shots[i].lim ?? Infinity, M.get(x.media).duration)) x.out = want;
      });
    });
    const end = packMain(); // the edit's length (total() would count the music itself)
    change(() => { a.out = Math.min(mus.duration, a.in + end); a.fadeOut = Math.min(2, end / 4); });
    if (sound && P.main.some(c => M.get(c.media)?.hasAudio)) await autoDuck(a).catch(() => {});
  }
  if (title && plan.title) {
    S.t = 0; addText('Title', { text: plan.title, dur: Math.min(3, total()) }, { anim: 'fade' });
  }
  packMain();
  await api(`/api/projects/${P.id}`, P, 'PUT');
  S.t = 0; renderAll();
  const out = { project: P.id, name: P.name, shots: P.main.length, duration: r3(total()), transitions: P.main.filter(c => c.tr).map(c => c.tr.type), orderedBy: plan.vision ? 'what each shot shows' : 'time (no vision model)' };
  say(`${out.shots} shots, ${fmtDur(out.duration)}: ${P.name}`);
  return out;
}
async function makeShorts({ media, count = 3, min = 15, max = 45, captions = true, reframe = true, title = true, lang = 'auto' }) { // long video -> shorts, on this Mac
  const m = mediaBy(media);
  if (m.kind !== 'video' || !m.hasAudio) throw new Error('pick a video with speech');
  const say = sayIn('#hlStatus');
  say('Reading the transcript and picking the best moments…');
  const { clips } = await job('/api/ai/highlights', { media: m.id, count, min, max, lang }, 'Finding highlights', say);
  const made = [];
  for (const [i, h] of clips.entries()) {
    say(`Building short ${i + 1} of ${clips.length}: ${h.title || ''}`);
    setProject(newProject('9:16'));
    P.name = h.title || `${m.name} short ${i + 1}`;
    addMedia(m.id, 'main');
    const c = P.main[0];
    change(() => { Object.assign(c, { in: h.start, out: h.end, fit: 'fill' }); });
    if (reframe) await autoReframe(c).catch(() => {});
    if (captions) await autoCaptions(true).catch(() => {});
    if (title && h.title) {
      S.t = 0; addText('Title', { text: h.title, dur: Math.min(3, len(c)), y: 0.16 }, { anim: 'pop' });
    }
    await api(`/api/projects/${P.id}`, P, 'PUT');
    made.push({ id: P.id, name: P.name, start: h.start, end: h.end, reason: h.reason });
  }
  if (made.length) await openProject(made[0].id);
  if (st) st.innerHTML = made.map(x => `<button class="wide" data-openproj="${x.id}" title="${esc(x.reason)}">${esc(x.name)} · ${fmtDur(x.end - x.start)}</button>`).join('');
  return { shorts: made };
}
async function translateCaptions({ to }) { // whole sentences are translated, then re-cut into captions over the same time (fragments translate badly)
  if (!P.captions.length) throw new Error('no captions to translate yet (generate captions first)');
  const groups = [];
  for (const c of [...P.captions].sort((x, y) => x.start - y.start)) {
    const g = groups.at(-1), prev = g?.at(-1);
    if (prev && c.start - (prev.start + prev.dur) < 0.6 && !/[.?!…。？！]$/.test(prev.text.trim())) g.push(c); else groups.push([c]);
  }
  const { texts, kept } = await job('/api/ai/translate', { texts: groups.map(g => g.map(c => c.text).join(' ')), to }, 'Translating', sayIn('#trStatus'));
  const per = Math.max(1, +$('#capWords').value || 3), CJK = '぀-ヿ㐀-鿿＀-￯　-〿';
  change(() => {
    const out = [];
    groups.forEach((g, gi) => {
      const tr = String(texts[gi] || '').trim(), cjk = new RegExp(`[${CJK}]`).test(tr); // Chinese / Japanese: cut by character
      const units = (cjk ? tr.match(new RegExp(`[${CJK}]|[^\\s${CJK}]+`, 'g')) : tr.split(/\s+/))?.filter(Boolean) || [];
      const size = cjk ? per * 3 : per, chunks = [];
      for (let i = 0; i < units.length; i += size) chunks.push(units.slice(i, i + size));
      for (let i = chunks.length - 1; i > 0; i--) if (/^[\p{P}\s]+$/u.test(chunks[i].join(''))) chunks[i - 1].push(...chunks.splice(i, 1)[0]); // no lone "。"
      const t0 = g[0].start, t1 = g.at(-1).start + g.at(-1).dur, w8 = ch => ch.join('').length + ch.length, tot = chunks.reduce((s, ch) => s + w8(ch), 0) || 1;
      let at = t0;
      for (const ch of chunks) { // reading time follows text length
        const dur = ((t1 - t0) * w8(ch)) / tot, n = ch.length;
        out.push({ id: hex12(), start: at, dur, text: ch.join(cjk ? '' : ' '), words: ch.map((w, i) => ({ w, s: (i * dur) / n, e: ((i + 1) * dur) / n })) });
        at += dur;
      }
    });
    P.captions = out;
    if (S.sel?.lane === 'captions') S.sel = null;
  });
  return { sentences: groups.length, captions: P.captions.length, kept, first: P.captions.slice(0, 5).map(c => c.text) };
}
const MUSIC_STYLES = { // prompts MusicGen does well with
  'Upbeat pop': 'upbeat pop, bright synths, punchy drums, catchy, 120 bpm', 'Lo-fi': 'lo-fi hip hop beat, mellow piano, soft drums, relaxed, 85 bpm',
  Cinematic: 'epic cinematic orchestral, strings and big drums, building, 100 bpm', 'Hip hop': 'hip hop beat, deep 808 bass, crisp hi-hats, 90 bpm',
  EDM: 'energetic EDM, big synth leads, four on the floor, 128 bpm', Acoustic: 'warm acoustic guitar, light percussion, feel good, 100 bpm',
  Corporate: 'inspiring corporate background music, piano and soft drums, 110 bpm', Ambient: 'calm ambient pads, soft textures, slow, peaceful',
  Funk: 'funky groove, slap bass, wah guitar, tight drums, 105 bpm', Trap: 'dark trap beat, heavy 808, rolling hi-hats, 140 bpm' };
async function aiMusic({ prompt, duration = 20, seed, at = S.t, add = true, say }) { // music from a description, on this Mac (MusicGen): into the library, and onto the audio track
  if (!String(prompt || '').trim()) throw new Error('describe the music');
  const j = await job('/api/ai/music', { prompt, dur: duration, seed }, 'Making music', say || sayIn('#musicStatus'));
  await loadMedia();
  const m = M.get(j.media);
  if (add) addMedia(j.media, 'audio', at);
  return { id: j.media, media: m?.name, duration: m?.duration, ...(add ? { clip: brief(...cfind(S.sel.id)) } : {}) };
}
async function hookTitles() {
  packMain();
  const ranges = P.main.filter(c => M.get(c.media)?.hasAudio).map(c => ({ media: c.media, in: c.in, out: c.out }));
  if (!ranges.length) throw new Error('no speech on the main track');
  return job('/api/ai/hooks', { ranges, lang: $('#capLang').value }, 'Writing hooks', sayIn('#capStatus'));
}
function addHook(text) { S.t = 0; addText('Title', { text, dur: 3, y: 0.16 }, { anim: 'pop' }); return brief(P.text.at(-1), 'text'); }
async function loadAI() { // fill the AI tab from what is installed
  let s;
  try { s = await api('/api/ai/status'); } catch { return; }
  $('#aiVoice').innerHTML = s.voices.map(v => `<option value="${v}"${v === 'af_heart' ? ' selected' : ''}>${esc(aiVoiceName(v))}</option>`).join('');
  $('#btnAiImage').disabled = !s.image; $('#btnStickerAI').disabled = !s.image; $('#btnAiVoice').disabled = !s.voice;
  if (!s.image) $('#aiStatus').textContent = 'The image model is not installed (README: On-device AI).';
  if (!s.voice) $('#aiVoiceStatus').textContent = 'The voice model is not installed (README: On-device AI).';
  for (const id of ['btnShorts', 'btnHooks', 'btnTranslate']) $(`#${id}`).disabled = !s.llm;
  if (!s.llm) $('#scStatus').textContent = 'Without the local model, shots are kept in the order they were filmed.';
  if (!s.llm) $('#hlStatus').textContent = 'Needs Ollama with a model (ollama pull qwen3.5:9b).';
  G.ai = s; $('#btnMusic').disabled = !s.music;
  if (!s.music) $('#musicStatus').textContent = 'The music model is not installed (README: On-device AI).';
  renderMediaList();
}

// ---------- remote control: Claude Code drives this editor through the Cutroom MCP server ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cfind(id) { for (const L of LANES) { const c = P[L.key].find(x => x.id === id); if (c) return [c, L.key]; } throw new Error(`no clip with id ${id}`); }
function mediaBy(q) {
  const s0 = String(q).toLowerCase(), all = [...M.values()];
  const m = M.get(q) || all.find(x => x.name === q) || all.find(x => x.name.toLowerCase().includes(s0));
  if (!m) throw new Error(`no media "${q}" in the library (call media to list it, or import_media)`);
  return m;
}
const r3 = v => Math.round(v * 1000) / 1000;
function brief(c, lane) { // compact clip description: what an assistant needs to refer to and reason about it
  const o = { id: c.id, lane, start: r3(c.start), dur: r3(tdur(c, lane)) };
  if (c.media) { const m = M.get(c.media); Object.assign(o, { media: m?.name, kind: m?.kind, in: r3(c.in), out: r3(c.out) }); }
  else if (c.fx) Object.assign(o, { fx: c.fx, effect: FX[c.fx]?.n, strength: c.amt });
  else o.text = c.text;
  const def = { speed: 1, volume: 1, fit: lane === 'overlay' ? 'fill' : 'fit', scale: 1, x: lane === 'text' ? 0.5 : 0, y: lane === 'text' ? 0.42 : 0, rot: 0, opacity: 1, fadeIn: 0, fadeOut: 0 };
  for (const k of ['speed', 'volume', 'fit', 'scale', 'x', 'y', 'rot', 'opacity', 'blend', 'fadeIn', 'fadeOut', 'flip', 'denoise', 'pitch']) {
    const v = c[k];
    if (v !== undefined && v !== def[k] && v !== false && v !== 'normal') o[k] = typeof v === 'number' ? r3(v) : v;
  }
  for (const k of ['adj', 'look', 'crop', 'key', 'anim', 'style', 'tr', 'grade', 'beauty', 'glow']) if (c[k] && Object.keys(c[k]).length) o[k] = c[k];
  if (c.body) o.body = c.body;
  if (c.lkf?.length) o.strengthPoints = c.lkf.length;
  if (c.mask) o.mask = c.mask.type;
  if (c.mkf?.length) o.maskKeyframes = c.mkf.length;
  if (c.mc) o.multicam = { angle: c.mc.a + 1, angles: c.mc.angles.length };
  if (c.compound) o.compound = Object.values(c.compound).filter(Array.isArray).reduce((n, a) => n + a.length, 0);
  if (MULTI.includes(lane)) { const r = rows(lane).row.get(c.id) || 0; if (r) o.track = r; }
  if (c.kf?.length) o.keyframes = c.kf.length;
  if (c.vkf?.length) o.volumePoints = c.vkf.length;
  if (c.duck) o.duck = c.duck;
  return o;
}
const EDITABLE = new Set(['mb', 'beauty', 'glow', 'mkf', 'grade', 'lkf', 'track', 'au', 'vkf', 'speed', 'volume', 'fit', 'scale', 'x', 'y', 'rot', 'opacity', 'blend', 'fadeIn', 'fadeOut', 'flip', 'denoise', 'pitch', 'ease',
  'adj', 'look', 'crop', 'key', 'mask', 'anim', 'style', 'text', 'start', 'dur', 'in', 'out', 'kf', 'fx', 'amt']);
function merge(o, patch) { // deep merge; null deletes
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete o[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) merge(o[k], v);
    else o[k] = structuredClone(v);
  }
}
async function waitFrame() { // the preview shows the frame at S.t: every element at its time, then painted
  paint(); // issues the seeks now: WebKit stops requestAnimationFrame for a covered window, so don't wait for the loop
  const at = v => !v.getAttribute('src') || (v.readyState >= 2 && !v.seeking && srcFrame(v, v.currentTime) === srcFrame(v, v._want ?? v.currentTime));
  const t0 = performance.now(); // wall clock, not a count: a covered window throttles timers and decodes no video
  const pic = i => i.complete || performance.now() - t0 > 3000; // a photo still loading (its preview copy being made)
  for (let kick = true; performance.now() - t0 < 6000 && !([...(S.live || [])].every(at) && (S.pics || []).every(pic));) { // re-paint re-issues a seek skipped mid-seek
    if (kick && performance.now() - t0 > 2500) { kick = false; for (const v of S.live || []) if (v.getAttribute('src') && v.readyState < 2) v.load(); } // a first load that stalled: ask again
    await sleep(40); paint();
  }
  await sleep(40); // WebKit hands drawImage the new frame a moment after 'seeked'
  paint();
  for (let i = 0; S.mbFill && i < 6; i++) { await S.mbFill; paint(); } // motion blur: the frames before this one, drawn (each paint may ask for another clip's)
}
const REMOTE = {
  async status() { packMain(); return { project: { id: P.id, name: P.name, w: P.w, h: P.h, fps: P.fps, duration: r3(total()) }, playhead: r3(S.t), playing: S.playing, selected: S.sel, clips: Object.fromEntries(LANES.map(L => [L.key, P[L.key].length])) }; },
  async options() {
    return { ratios: Object.keys(RATIOS), transitions: TRANSITIONS.map(x => x[0]).filter(x => x !== 'none'), looks: Object.keys(LOOKS), blends: BLENDS.map(x => x[0]), clipIn: CLIP_ANIMS.map(x => x[0]), clipOut: CLIP_ANIMS.map(x => x[0]),
      comboMotion: LOOP_ANIMS.map(x => x[0]), masks: MASKS.map(x => x[0]), textPresets: Object.keys(TEXT_PRESETS), captionPresets: Object.keys(CAP_PRESETS), textIn: ANIMS.map(x => x[0]), textOut: OUTS.map(x => x[0]),
      textLoop: LOOPS.map(x => x[0]), fonts: [...FONTS, ...(G.fonts || []).map(f => f.family)], macFonts: G.sysFonts || [], luts: (G.luts = await api('/api/luts').catch(() => G.luts || [])).map(L => ({ id: L.id, name: L.name })), hslBands: HSL_BANDS.map(x => x[0]), speedRamps: Object.keys(RAMPS), exportFormats: FORMATS.map(x => x[0]), resolutions: exportSizes().map(x => x[0]), voices: [...$('#ttsVoice').options].map(o => o.value),
      effects: Object.fromEntries(Object.entries(FX).map(([k, d]) => [k, `${d.n} (${d.cat})`])), sounds: (G.sfx.length ? G.sfx : (G.sfx = await api('/api/sfx'))).map(x => x.name) };
  },
  async timeline() {
    packMain();
    return { ...(await REMOTE.status()), markers: P.markers,
      tracks: Object.fromEntries(LANES.map(L => [L.key, L.key === 'captions' ? P.captions.map(c => ({ id: c.id, start: r3(c.start), dur: r3(c.dur), text: c.text })) : P[L.key].map(c => brief(c, L.key))])) };
  },
  async media() { await loadMedia(); return [...M.values()].map(m => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, w: m.w, h: m.h, hasAudio: m.hasAudio })); },
  async projects() { return api('/api/projects'); },
  async open_project({ project }) {
    const list = await api('/api/projects'), q = String(project).toLowerCase();
    const p = list.find(x => x.id === project) || list.find(x => x.name === project) || list.find(x => x.name.toLowerCase().includes(q));
    if (!p) throw new Error(`no project "${project}"`);
    await openProject(p.id);
    return REMOTE.status();
  },
  async new_project({ ratio = '9:16', name }) {
    if (!RATIOS[ratio]) throw new Error(`ratio must be one of ${Object.keys(RATIOS).join(', ')}`);
    setProject(newProject(ratio)); if (name) P.name = name; scheduleSave(); renderAll();
    return REMOTE.status();
  },
  async set_project({ set = {} }) {
    change(() => {
      for (const [k, v] of Object.entries(set)) {
        if (k === 'ratio') { if (!RATIOS[v]) throw new Error(`ratio must be one of ${Object.keys(RATIOS).join(', ')}`); [P.w, P.h] = RATIOS[v]; }
        else if (['name', 'fps', 'bg'].includes(k)) P[k] = v;
        else if (k === 'capStyle') merge(P.capStyle, v);
        else throw new Error(`can't set project.${k} (name, ratio, fps, bg, capStyle)`);
      }
    });
    fitStage();
    return REMOTE.status();
  },
  async add_clip({ media, lane = 'main', start, in: a, out: b }) {
    const m = mediaBy(media);
    addMedia(m.id, lane, start);
    const [c, L] = cfind(S.sel.id);
    if (a !== undefined || b !== undefined) change(() => { if (a !== undefined) c.in = a; if (b !== undefined) c.out = b; });
    return brief(c, L);
  },
  async update_clip({ id, set = {} }) {
    const [c, L] = cfind(id), bad = Object.keys(set).filter(k => !EDITABLE.has(k));
    if (bad.length) throw new Error(`not editable: ${bad.join(', ')}. Editable: ${[...EDITABLE].join(', ')}`);
    if (set.fx !== undefined && !FX[set.fx]) throw new Error(`fx must be one of ${Object.keys(FX).join(', ')}`);
    const nan = ['speed', 'volume', 'scale', 'x', 'y', 'rot', 'opacity', 'fadeIn', 'fadeOut', 'start', 'dur', 'in', 'out', 'amt', 'mb'].filter(k => set[k] !== undefined && (set[k] !== null || ['speed', 'volume', 'start', 'dur', 'in', 'out'].includes(k)) && !Number.isFinite(set[k]));
    if (nan.length) throw new Error(`${nan.join(', ')} must be numbers`);
    if (set.speed !== undefined && !(set.speed >= 0.1 && set.speed <= 100)) throw new Error('speed must be 0.1-100');
    if (set.mb != null && !(set.mb >= 0 && set.mb <= 1)) throw new Error('mb (motion blur) must be 0-1');
    if ((set.in ?? c.in) >= (set.out ?? c.out) && c.media) throw new Error('in must be before out');
    if (set.dur !== undefined && !(set.dur > 0)) throw new Error('dur must be above 0');
    if (set.grade !== undefined && set.grade !== null) {
      const g = set.grade, bad = typeof g !== 'object' || Object.keys(g).some(k => !['lift', 'gamma', 'gain', 'curves', 'hsl', 'lut'].includes(k))
        || ['lift', 'gamma', 'gain'].some(k => g[k] && Object.values(g[k]).some(v => typeof v !== 'number' || !(v >= -1 && v <= 1)))
        || (g.curves && Object.entries(g.curves).some(([k, p]) => !['m', 'r', 'g', 'b'].includes(k) || (p !== null && (!Array.isArray(p) || p.some(q => !Array.isArray(q) || q.length !== 2 || q.some(v => !(v >= 0 && v <= 1)))))))
        || (g.hsl && Object.entries(g.hsl).some(([k, b]) => !HSL_BANDS.some(x => x[0] === k) || (b && Object.values(b).some(v => typeof v !== 'number' || !(v >= -1 && v <= 1)))))
        || (g.lut && g.lut !== null && !(G.luts || []).some(L => L.id === g.lut.id));
      if (bad) throw new Error(`grade: {lift|gamma|gain: {x, y, l} -1..1, curves: {m|r|g|b: [[x, y] 0..1, ...]}, hsl: {${HSL_BANDS.map(x => x[0]).join('|')}: {h, s, l} -1..1}, lut: {id (from options().luts), amount 0..1}}`);
      if (g.lut?.id) await loadLut(g.lut.id);
    }
    for (const [k, need] of [['kf', ['t']], ['vkf', ['t', 'v']], ['lkf', ['t', 'v']], ['mkf', ['t']]]) { // keyframes and volume points arrive as written: check them before they reach the clip
      if (set[k] === undefined || set[k] === null) continue;
      if (!Array.isArray(set[k]) || set[k].some(f => !f || need.some(q => !Number.isFinite(f[q])) || Object.values(f).some(v => typeof v === 'number' && !Number.isFinite(v)))) throw new Error(`${k} must be a list of {${need.join(', ')}${k === 'kf' ? ', scale, x, y, opacity, rot' : ''}} with numbers`);
    }
    change(() => {
      if (set.speed && c.speed && (c.kf || c.vkf)) { const f = c.speed / set.speed; c.kf?.forEach(x => { x.t *= f; }); c.vkf?.forEach(x => { x.t *= f; }); }
      merge(c, set);
      if (set.kf) { const base = propsAt({ ...c, kf: null }, 0); c.kf = c.kf.map(f => ({ ...base, ...f })).sort((x, y) => x.t - y.t); } // a keyframe that names only scale keeps the clip's position, opacity and angle
      if (set.vkf) { c.vkf.sort((x, y) => x.t - y.t); delete c.duck; }
      if (set.lkf) { c.lkf = c.lkf.map(f => ({ t: f.t, v: clamp(f.v, 0, 1) })).sort((x, y) => x.t - y.t); if (!c.lkf.length) delete c.lkf; }
      if (c.grade && !gradeOn(c.grade)) delete c.grade;
      if (set.mkf) { if (!c.mask) throw new Error('set a mask first (mask: {type, ...})'); c.mkf = c.mkf.map(f => ({ ...Object.fromEntries(MKF.map(q => [q, c.mask[q]])), ...f })).sort((x, y) => x.t - y.t); if (!c.mkf.length) delete c.mkf; }
      if (!c.mask) delete c.mkf;
      if (set.track !== undefined) { if (!MULTI.includes(L)) throw new Error('only overlay, audio, text and effect clips have tracks'); if (set.track) c.track = Math.max(0, Math.round(set.track)); else delete c.track; restackTracks(L); }
      if (c.kf && !c.kf.length) delete c.kf;
      if (c.vkf && !c.vkf.length) delete c.vkf;
    });
    return brief(c, L);
  },
  async set_track({ lane, track = 0, hidden, locked: lk }) { // hide (mute) or lock one track of a lane
    if (!LANES.some(L => L.key === lane)) throw new Error(`lane must be one of ${LANES.map(L => L.key).join(', ')}`);
    const key = `${lane}:${MULTI.includes(lane) ? Math.max(0, Math.round(track)) : 0}`;
    change(() => { const T = { ...(P.tracks[key] || {}) }; if (hidden !== undefined) T.off = !!hidden; if (lk !== undefined) T.lock = !!lk; if (T.off || T.lock) P.tracks[key] = T; else delete P.tracks[key]; });
    return { tracks: P.tracks };
  },
  async delete_clip({ id }) { const [, L] = cfind(id); S.sel = { lane: L, id }; del(); return REMOTE.status(); },
  async split_clip({ id, at }) {
    const [c, L] = cfind(id);
    if (!(at > c.start && at < c.start + tdur(c, L))) throw new Error(`at must be inside the clip: ${r3(c.start)}..${r3(c.start + tdur(c, L))} s on the timeline`);
    let b;
    change(() => { b = splitClip(c, L, L === 'main' ? snap(at) : at); });
    return [brief(c, L), brief(b, L)];
  },
  async duplicate_clip({ id }) { const [, L] = cfind(id); S.sel = { lane: L, id }; dup(); return brief(...cfind(S.sel.id)); },
  async move_clip({ id, start, index, lane }) {
    let [c, L] = cfind(id);
    if (lane && lane !== L) { if (!['main', 'overlay'].includes(lane) || !['main', 'overlay'].includes(L)) throw new Error('clips move between the main and overlay tracks only'); moveLane(c, L); [c, L] = cfind(id); }
    change(() => { if (L === 'main' && index !== undefined) { P.main.splice(P.main.indexOf(c), 1); P.main.splice(clamp(index, 0, P.main.length), 0, c); } else if (start !== undefined) c.start = Math.max(0, start); });
    return brief(c, L);
  },
  async add_text({ text, preset = 'Title', start = S.t, duration = 3, x, y, style }) {
    if (!TEXT_PRESETS[preset]) throw new Error(`preset must be one of ${Object.keys(TEXT_PRESETS).join(', ')}`);
    S.t = start; addText(preset);
    const [c] = cfind(S.sel.id);
    change(() => { c.text = String(text); c.dur = duration; if (x !== undefined) c.x = x; if (y !== undefined) c.y = y; if (style) merge(c.style, style); });
    return brief(c, 'text');
  },
  async set_transition({ after, type, duration = 0.5, all }) {
    if (type !== 'none' && !TRANSITIONS.some(x => x[0] === type)) throw new Error(`type must be none or one of ${TRANSITIONS.map(x => x[0]).join(', ')}`);
    const put = c => { if (type === 'none') delete c.tr; else c.tr = { type, d: duration }; };
    change(() => { if (all) P.main.slice(0, -1).forEach(put); else { const [c, L] = cfind(after); if (L !== 'main') throw new Error('transitions go between main-track clips: pass the id of the clip before the cut'); put(c); } });
    return (await REMOTE.timeline()).tracks.main;
  },
  async auto_captions({ lang = 'auto', words = 3, style, audio = true }) {
    $('#capLang').value = lang; if (!$('#capLang').value) { $('#capLang').insertAdjacentHTML('beforeend', `<option value="${esc(lang)}">${esc(lang)}</option>`); $('#capLang').value = lang; }
    $('#capWords').value = String(words); if (!$('#capWords').value) { $('#capWords').insertAdjacentHTML('beforeend', `<option>${+words}</option>`); $('#capWords').value = String(words); }
    $('#capAudio').checked = !!audio;
    if (style) { if (!CAP_PRESETS[style]) throw new Error(`style must be one of ${Object.keys(CAP_PRESETS).join(', ')}`); P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS[style], y: P.capStyle.y }; }
    await autoCaptions(true);
    return { captions: P.captions.length, status: $('#capStatus').textContent, first: P.captions.slice(0, 5).map(c => c.text) };
  },
  async remove_pauses({ min = 0.5 }) { const d0 = total(); await removePauses(+min); return { removedSeconds: r3(d0 - total()), clips: P.main.length }; },
  async remove_fillers() { const d0 = total(); await removeFillers(); return { removedSeconds: r3(d0 - total()), clips: P.main.length }; },
  async voiceover({ text, voice, rate = 185, at = S.t }) {
    const m = await api('/api/tts', { text: String(text), voice: voice || $('#ttsVoice').value, rate });
    await loadMedia(); addMedia(m.id, 'audio', at);
    return brief(...cfind(S.sel.id));
  },
  async clip_tool({ id, action, depth = 0.25, every = 2, ramp: rp = 'montage', at, ref }) {
    const [c, L] = cfind(id), n0 = LANES.reduce((n, x) => n + P[x.key].length, 0);
    S.sel = { lane: L, id };
    const run = { remove_background: () => removeBackground(c), stabilize: () => remake(c, 'stabilize'), reverse: () => remake(c, 'reverse'), auto_reframe: () => autoReframe(c),
      freeze_frame: () => { packMain(); if (at !== undefined) S.t = +at; if (!(S.t >= c.start && S.t <= c.start + tdur(c, L))) throw new Error(`at must be a time inside the clip: ${r3(c.start)}..${r3(c.start + tdur(c, L))} s`); return freeze(c, L); }, smooth_slowmo: () => smoothSlowmo(c), detach_audio: () => detachAudio(c), split_scenes: () => sceneSplit(c, L),
      auto_duck: () => autoDuck(c, depth), auto_adjust: () => autoAdjust(c, L, ref), isolate_voice: () => isolateVoice(c, L, 'voice'), remove_voice: () => isolateVoice(c, L, 'music'), split_stems: () => splitStems(c, L), detect_beats: () => detectBeats(c), beat_sync: () => beatSync(c, every), body_blur: () => bodyEffect(c, L, 'blur'), body_mono: () => bodyEffect(c, L, 'mono'), body_dim: () => bodyEffect(c, L, 'dim'), body_glow: () => bodyEffect(c, L, 'glow'), body_neon: () => bodyEffect(c, L, 'neon'), speed_ramp: () => { if (!RAMPS[rp]) throw new Error(`ramp must be one of ${Object.keys(RAMPS).join(', ')}`); ramp(c, L, rp); } }[action];
    if (!run) throw new Error('action must be one of body_blur, body_mono, body_dim, body_glow, body_neon, remove_background, stabilize, reverse, auto_reframe, freeze_frame, smooth_slowmo, detach_audio, split_scenes, auto_duck, auto_adjust (ref = a clip id to match its colours), isolate_voice, remove_voice, split_stems, detect_beats, beat_sync, speed_ramp');
    await run();
    return { clipsBefore: n0, clipsNow: LANES.reduce((n, x) => n + P[x.key].length, 0), clip: P[L].includes(c) ? brief(c, L) : null };
  },
  async remove_object({ id, box, t, quality = 'best' }) { // box = where it is on the canvas (snapshot), as fractions {x, y, w, h}
    const [c, L] = cfind(id);
    if (M.get(c.media)?.kind !== 'video') throw new Error('remove_object works on video clips');
    if (!(box?.w > 0 && box?.h > 0)) throw new Error('box {x, y, w, h} as fractions of the canvas is required');
    const T = t ?? (S.t >= c.start && S.t < c.start + tdur(c, L) ? S.t : c.start);
    if (T < c.start || T >= c.start + tdur(c, L)) throw new Error('t must be a time inside the clip');
    const rect = { x: box.x * P.w, y: box.y * P.h, w: box.w * P.w, h: box.h * P.h }, mp = previewFor(c, rect);
    return removeObject(c, L, rect, mp ? mp.T : T, quality === 'fast' && !mp ? 'fast' : 'best', 'remove', mp?.b64[mp.pick]);
  },
  async preview_object({ id, box, t, mode = 'remove', candidate, points = [] }) { // SAM 2's outline of a box, tinted on the frame: check it before remove_object / cut_out_object
    const [c, L] = cfind(id);
    if (M.get(c.media)?.kind !== 'video') throw new Error('preview_object works on video clips');
    if (!(box?.w > 0 && box?.h > 0)) throw new Error('box {x, y, w, h} as fractions of the canvas is required');
    const T = t ?? (S.t >= c.start && S.t < c.start + tdur(c, L) ? S.t : c.start);
    seekTo(T);
    const toSrc = canvasToSrc(c, S.t), pts = (Array.isArray(points) ? points : []).map(q => [...toSrc(q[0] * P.w, q[1] * P.h), q[2] ? 1 : 0]); // canvas fractions -> source
    const r = await maskPreview(c, L, { x: box.x * P.w, y: box.y * P.h, w: box.w * P.w, h: box.h * P.h }, S.t, mode, pts);
    if (!r) throw new Error('another outline was asked for meanwhile');
    if (Number.isInteger(candidate)) { S.maskPreview.pick = clamp(candidate, 0, r.masks.length - 1); markPreview(); }
    const snap = await REMOTE.snapshot({ max: 720 }); // the export renderer's frame: right even while the window is covered (no video decoding then)
    const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = `data:image/png;base64,${snap.image}`; });
    const cv = document.createElement('canvas'), x = cv.getContext('2d'), k = im.width / P.w, pr = propsAt(c, S.t - c.start), g = geom(M.get(c.media), c, P.w, P.h, pr);
    cv.width = im.width; cv.height = im.height; x.drawImage(im, 0, 0);
    overlayMask(x, S.maskPreview, { x0: g.x * k, y0: g.y * k, x1: (g.x + g.w) * k, y1: (g.y + g.h) * k, rot: pr.rot || 0 });
    return { t: r3(S.t), candidates: r.areas.map(a => +a.toFixed(4)), candidate: S.maskPreview.pick, unsure: !!r.unsure, image: cv.toDataURL('image/png').split(',')[1],
      note: 'pink = what will be taken (candidates: area of each outline, smallest first; pass candidate to show another). remove_object / cut_out_object with the same box then take exactly this outline' };
  },
  async cut_out_object({ id, box, t }) { // keep only what's in the box (any subject, SAM 2): the clip becomes it on transparency
    const [c, L] = cfind(id);
    if (M.get(c.media)?.kind !== 'video') throw new Error('cut_out_object works on video clips');
    if (!(box?.w > 0 && box?.h > 0)) throw new Error('box {x, y, w, h} as fractions of the canvas is required');
    const T = t ?? (S.t >= c.start && S.t < c.start + tdur(c, L) ? S.t : c.start);
    const rect = { x: box.x * P.w, y: box.y * P.h, w: box.w * P.w, h: box.h * P.h }, mp = previewFor(c, rect);
    return removeObject(c, L, rect, mp ? mp.T : T, 'best', 'cutout', mp?.b64[mp.pick]);
  },
  async cut_timeline({ ranges }) { // ripple-delete [start, end] ranges (timeline seconds) from the main track
    if (!Array.isArray(ranges) || !ranges.length || ranges.some(r => !Array.isArray(r) || !(r[1] > r[0]))) throw new Error('ranges: [[start, end], ...] in timeline seconds');
    const cut = await applyCut(timelineCuts(ranges.map(r => [+r[0], +r[1]])), `${ranges.length} range${ranges.length > 1 ? 's' : ''}`);
    return { removedSeconds: r3(cut), duration: r3(total()), clips: P.main.length };
  },
  async main_transcript({ lang }) { // the main track's words in timeline time (what edit-by-script shows)
    if (lang) $('#capLang').value = lang;
    await loadWords([...new Set(P.main.filter(c => M.get(c.media)?.hasAudio).map(c => c.media))]);
    const ws = scriptWords();
    return { words: ws.length, sentences: ws.reduce((out, w, i) => { const p = ws[i - 1]; if (!p || /[.?!]$/.test(p.w) || w.t0 - p.t1 > 1) out.push({ start: r3(w.t0), end: r3(w.t1), text: w.w }); else { const o = out.at(-1); o.end = r3(w.t1); o.text += ` ${w.w}`; } return out; }, []),
      timed: ws.map(w => [w.w, r3(w.t0), r3(w.t1)]) };
  },
  async add_effect({ type, start = S.t, duration, strength = 1 }) { return brief(addEffect(type, start, duration, strength), 'fx'); },
  async add_sound({ name, at = S.t }) {
    if (!G.sfx.length) G.sfx = await api('/api/sfx');
    const q = String(name || '').toLowerCase(), s = G.sfx.find(x => x.id === q || x.name.toLowerCase() === q) || G.sfx.find(x => x.name.toLowerCase().includes(q) || x.id.includes(q));
    if (!s) throw new Error(`name must be one of ${G.sfx.map(x => x.name).join(', ')}`);
    return addSfx(s.id, at);
  },
  async ai_image(args) { if (!args.prompt) throw new Error('prompt is required'); return aiImage(args); },
  async generate_music(args) { if (!args.prompt) throw new Error('prompt is required (or a style: ' + Object.keys(MUSIC_STYLES).join(', ') + ')'); return aiMusic({ ...args, prompt: MUSIC_STYLES[args.prompt] || args.prompt }); },
  async ai_voiceover(args) { if (!args.text) throw new Error('text is required'); return aiVoice(args); },
  async transcript({ media, lang = 'auto' }) { const m = mediaBy(media); return { media: m.name, sentences: (await api('/api/transcript', { media: m.id, lang })).sentences }; },
  async smart_combine(args) { if (!args.media) throw new Error('media (a list of videos) is required'); return smartCombine(args); },
  async make_shorts(args) { if (!args.media) throw new Error('media is required'); return makeShorts(args); },
  async translate_captions({ to }) { if (!to) throw new Error('to (a language) is required'); return translateCaptions({ to }); },
  async hook_titles({ add }) { const { hooks } = await hookTitles(); return add ? { hooks, added: addHook(hooks[0]) } : { hooks }; },
  async import_subtitles({ srt, name }) { if (!srt) throw new Error('srt (the file\'s text, SRT or WebVTT) is required'); return { captions: importSubs(srt, name || 'subtitles'), first: P.captions.slice(0, 5).map(c => [r3(c.start), c.text]) }; },
  async relink_media({ missing, media }) { const to = mediaBy(media).id; if (!LANES.some(L => P[L.key].some(c => c.media === missing))) throw new Error(`no clip uses media ${missing}`); return { relinked: relink(missing, to) }; },
  async import_lut({ cube, name }) { if (!cube) throw new Error('cube (the .cube file\'s text) is required'); parseCube(cube); const L = await api('/api/luts', { name: name || 'LUT', text: cube }); G.luts = await api('/api/luts'); return L; },
  async multicam({ media }) { if (!Array.isArray(media)) throw new Error('media: 2 to 6 videos (ids or names), the first gives the sound'); return makeMulticam(media); },
  async multicam_cut({ angle, at }) { const c = mcCut(Math.round(angle) - 1, at ?? S.t); if (!c) throw new Error(remoteLog?.at(-1) || 'no cut made'); return brief(c, 'main'); },
  async generate_video(args) { return aiVideo({ ...args, say: undefined }); },
  async compound_clip({ ids }) { if (!Array.isArray(ids) || ids.length < 2) throw new Error('ids: two or more clip ids'); const sel = ids.map(id => cfind(id)); S.sel = { lane: sel[0][1], id: sel[0][0].id }; S.multi = new Set(sel.slice(1).map(([c, L]) => selKey(L, c.id))); return makeCompound(sel); },
  async break_compound({ id }) { breakCompound(cfind(id)[0]); return (await REMOTE.timeline()).tracks.main; },
  async seek({ t }) { seekTo(+t); return { playhead: r3(S.t) }; },
  async history({ action }) { if (action === 'undo') restore(undo, redo); else if (action === 'redo') restore(redo, undo); else throw new Error('action: undo or redo'); return REMOTE.status(); },
  async snapshot({ t, max = 720, preview = false }) {
    if (S.playing) pause();
    if (t !== undefined) seekTo(+t);
    if (!preview && total() > 0) { // the frame as the export renders it: exact, and works while the window is hidden
      const k = Math.min(1, max / Math.max(P.w, P.h)), plan = await buildPlan(even(P.w * k), even(P.h * k), 'fast', 'snapshot', false, 'png');
      plan.still = clamp(S.t, 0, Math.max(0, total() - 1 / P.fps));
      return { t: r3(S.t), image: (await api('/api/still_frame', plan)).image };
    }
    const sel = S.sel, pick0 = S.pickRect;
    S.sel = null; S.pickRect = null; // the frame as rendered: no selection box or tracking marquee
    try { await waitFrame(); } finally { S.sel = sel; S.pickRect = pick0; }
    const cv = $('#cv'), k = Math.min(1, max / Math.max(cv.width, cv.height)), o = document.createElement('canvas');
    o.width = Math.round(cv.width * k); o.height = Math.round(cv.height * k);
    o.getContext('2d').drawImage(cv, 0, 0, o.width, o.height);
    return { t: r3(S.t), image: o.toDataURL('image/png').split(',')[1] };
  },
  async export({ format = 'mp4', resolution = '1080p', quality = 'fast', bitrate = 1, name, loudness = false, at, show = false }) {
    const sz = exportSizes().find(x => x[0] === resolution);
    if (!sz) throw new Error(`resolution must be one of ${exportSizes().map(x => x[0]).join(', ')}`);
    if (!FORMATS.some(x => x[0] === format)) throw new Error(`format must be one of ${FORMATS.map(x => x[0]).join(', ')}`);
    if (at !== undefined) S.t = +at;
    if (format === 'srt') { const file = await saveSRT(name); return { file, path: `~/Movies/Cutroom/exports/${file}`, format }; }
    S.exporting = true;
    try {
      const plan = await buildPlan(sz[1], sz[2], quality === 'best' ? 'best' : 'fast', name || P.name, !!loudness, format);
      plan.rate = +bitrate || 1;
      const jb = await job('/api/export', plan, 'Exporting');
      if (show) await api('/api/reveal', { file: jb.file, play: true }); // opens in QuickTime: a page can't open windows without a click
      return { file: jb.file, path: `~/Movies/Cutroom/exports/${jb.file}`, size: `${sz[1]}x${sz[2]}`, format, shown: !!show };
    } finally { S.exporting = false; }
  },
};
const remoteSeen = new Set();
async function remoteLoop() { // long-poll the server for commands from the MCP server; run them one at a time
  for (;;) {
    let m;
    try { m = await api('/api/remote/next'); } catch { await sleep(3000); continue; }
    if (!m.id || remoteSeen.has(m.id)) continue; // a re-offered command we already have
    remoteSeen.add(m.id);
    if (remoteSeen.size > 200) remoteSeen.delete(remoteSeen.values().next().value);
    api('/api/remote/ack', { id: m.id }).catch(() => {});
    let ok = true, result;
    remoteLog = [];
    const p0 = P, u0 = undo.length;
    busy(1);
    try { const fn = REMOTE[m.cmd]; if (!fn) throw new Error(`unknown command ${m.cmd}`); result = await fn(m.args || {}); }
    catch (e) { ok = false; result = e.message; }
    finally { busy(-1); }
    if (P === p0 && undo.length > u0 + 1) undo.splice(u0 + 1); // one command = one undo step (a command may make several changes)
    const log = remoteLog;
    remoteLog = null;
    await api('/api/remote/result', { id: m.id, ok, result: result ?? null, log }).catch(() => {});
  }
}

(async function boot() {
  wire();
  try {
    await loadMedia();
    G.luts = await api('/api/luts').catch(() => []);
    await loadFonts();
    api('/api/fonts/system').then(l => { G.sysFonts = l; }).catch(() => {});
    const list = await api('/api/projects'), last = store.get('cutroom.last');
    const id = (list.find(p => p.id === last) || list[0])?.id;
    if (id) await openProject(id);
    else { setProject(newProject('9:16')); scheduleSave(); }
    loadVoices();
    loadAI();
    const ping = await api('/api/ping');
    if (!ping.whisper) $('#capStatus').textContent = 'Captions need whisper.cpp: brew install whisper-cpp';
  } catch (e) { toast(`Cannot reach the Cutroom server: ${e.message}`); }
  kick();
  remoteLoop();
})();
