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

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(path, { method, headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

const LANES = [
  { key: 'text', label: 'Text', h: 30 },
  { key: 'captions', label: 'Captions', h: 30 },
  { key: 'overlay', label: 'Overlay', h: 42 },
  { key: 'main', label: 'Main', h: 58 },
  { key: 'audio', label: 'Audio', h: 42 },
];
const RATIOS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };
const FONTS = ['Montserrat', 'Poppins', 'Anton', 'Bebas Neue', 'Helvetica Neue', 'Arial Black', 'Impact', 'Futura', 'Avenir Next', 'Georgia', 'Marker Felt', 'American Typewriter', 'Menlo'];
const TEXT_BASE = { font: 'Montserrat', weight: 800, size: 72, color: '#ffffff', stroke: '#000000', strokeW: 0, shadow: false, box: false, boxColor: '#000000', boxAlpha: 0.72, upper: false, hl: '#ffd400', pop: false, maxW: 0.86, lh: 1.15 };
const TEXT_PRESETS = {
  Title: { font: 'Montserrat', weight: 900, size: 116, shadow: true },
  Subtitle: { font: 'Poppins', weight: 800, size: 64, shadow: true },
  Label: { font: 'Montserrat', weight: 800, size: 58, box: true },
  Outline: { font: 'Anton', weight: 400, size: 124, strokeW: 7, upper: true },
  Headline: { font: 'Bebas Neue', weight: 400, size: 150, color: '#ffd400', shadow: true },
  Typewriter: { font: 'American Typewriter', weight: 600, size: 60, box: true, boxColor: '#111111', boxAlpha: 0.85 },
  Sticker: { font: 'Montserrat', weight: 400, size: 230, anim: 'pop' }, // emoji render through the system emoji font
};
const CAP_PRESETS = {
  Bold: { font: 'Montserrat', weight: 900, size: 78, color: '#ffffff', stroke: '#000000', strokeW: 7, hl: '#ffd400', upper: true, pop: true },
  Clean: { font: 'Poppins', weight: 800, size: 62, color: '#ffffff', strokeW: 0, hl: '#ffffff', shadow: true },
  Boxed: { font: 'Montserrat', weight: 800, size: 58, color: '#ffffff', strokeW: 0, hl: '#ff7a45', box: true, boxAlpha: 0.75 },
  Neon: { font: 'Anton', weight: 400, size: 96, color: '#ffffff', stroke: '#000000', strokeW: 6, hl: '#3dff8b', upper: true, pop: true },
};
const ICON = {
  play: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>',
};

const TRANSITIONS = [['none', 'None'], ['fade', 'Dissolve'], ['fadeblack', 'Dip to black'], ['wipeleft', 'Wipe'], ['slideleft', 'Slide'], ['circleopen', 'Circle'], ['zoomin', 'Zoom']];
const ANIMS = [['none', 'None'], ['pop', 'Pop in'], ['fade', 'Fade in'], ['slide', 'Slide up']];
const OUTS = [['none', 'None'], ['pop', 'Pop out'], ['fade', 'Fade out'], ['slide', 'Slide out']];
const LOOPS = [['none', 'None'], ['bounce', 'Bounce'], ['pulse', 'Pulse'], ['wiggle', 'Wiggle']];
const FORMATS = [['mp4', 'MP4 · H.264'], ['hevc', 'MP4 · HEVC (smaller)'], ['prores', 'MOV · ProRes 422 (for editing)'], ['gif', 'GIF'], ['mp3', 'Audio · MP3'], ['wav', 'Audio · WAV'], ['png', 'Still frame at playhead (PNG)']];
const ANIM_T = 0.3; // text "in" animation length, seconds
const KF_PROPS = ['scale', 'x', 'y', 'opacity', 'rot'];
const MASKS = [['none', 'None'], ['circle', 'Circle'], ['rect', 'Rectangle'], ['linear', 'Linear'], ['mirror', 'Mirror']];
const RAMPS = { // speed multipliers over 8 equal parts of the clip (CapCut's curve presets, baked into editable parts)
  montage: [1, 1.6, 0.5, 2, 1, 0.5, 1.8, 1], hero: [1, 1, 0.5, 0.25, 0.25, 0.5, 1, 1], bullet: [2, 2, 0.35, 0.2, 0.35, 2, 2, 2],
  jumpcut: [1, 1, 3, 3, 1, 1, 3, 3], flashin: [4, 3, 2, 1.5, 1, 1, 1, 1], flashout: [1, 1, 1, 1, 1.5, 2, 3, 4],
};
const RAMP_NAMES = { montage: 'Montage', hero: 'Hero', bullet: 'Bullet', jumpcut: 'Jump cut', flashin: 'Flash in', flashout: 'Flash out' };
const sat = s => [.213 + .787 * s, .715 - .715 * s, .072 - .072 * s, .213 - .213 * s, .715 + .285 * s, .072 - .072 * s, .213 - .213 * s, .715 - .715 * s, .072 + .928 * s];
const LOOKS = { // 3x3 RGB matrices: the preview uses them as SVG feColorMatrix, the export as colorchannelmixer
  vivid: sat(1.45), mono: sat(0), sepia: [.393, .769, .189, .349, .686, .168, .272, .534, .131],
  warm: [1.1, .05, 0, 0, 1.02, 0, 0, -.04, .86], cool: [.88, 0, .04, 0, .98, .05, .04, .06, 1.12], teal: [1.12, .06, -.18, -.06, 1.02, .04, -.16, .12, 1.1],
};
const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

let P = null;                        // current project
const M = new Map();                 // media id -> server metadata
const S = { sel: null, t: 0, playing: false, pps: 60, dirty: true, t0: 0, wall0: 0, end: 0, exporting: false };
let undo = [], redo = [], pending = null, saveTimer = 0, hits = [];
const uploads = [], pool = new Map(), imgs = new Map();

// ---------- time ----------
const len = c => c.dur ?? (c.out - c.in) / c.speed;
const frames = c => Math.max(1, Math.round(len(c) * P.fps));
const tdur = (c, lane) => (lane === 'main' ? frames(c) / P.fps : len(c)); // main clips snap to whole frames, like the export
function trF(i) { // frames main clip i shares with i+1 in a transition (0 = hard cut); same clamp as server overlap()
  const c = P.main[i], n = P.main[i + 1];
  return c?.tr && n ? clamp(Math.round(c.tr.d * P.fps), 1, Math.floor(Math.min(frames(c), frames(n)) / 2)) : 0;
}
function packMain() { let f = 0; P.main.forEach((c, i) => { c.start = f / P.fps; f += frames(c) - trF(i); }); return f / P.fps; }
function total() { packMain(); let t = 0; for (const L of LANES) for (const c of P[L.key]) t = Math.max(t, c.start + tdur(c, L.key)); return t; }
const snap = t => Math.round(t * P.fps) / P.fps;
function tc(t) { const fps = Math.round(P.fps), f = Math.round(t * P.fps), s = Math.floor(f / fps); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f % fps).padStart(2, '0')}`; }
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function propsAt(c, lt) { // keyframed scale/x/y/opacity at clip-local time: linear, exactly like the server's pw()
  const k = c.kf;
  if (!k?.length) return { scale: c.scale ?? 1, x: c.x ?? 0, y: c.y ?? 0, opacity: c.opacity ?? 1, rot: c.rot ?? 0 };
  let i = 0;
  while (i + 1 < k.length && k[i + 1].t <= lt) i++;
  const a = k[i], b = k[i + 1];
  if (!b) return { scale: a.scale, x: a.x, y: a.y, opacity: a.opacity, rot: a.rot ?? 0 }; // never leak a keyframe's own t
  let u = clamp((lt - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
  if (a.ease ?? c.ease) u = u * u * (3 - 2 * u); // smoothstep from this keyframe (or clip default), same as pw() with e=1
  const mix = p => (a[p] ?? 0) + ((b[p] ?? 0) - (a[p] ?? 0)) * u;
  return { scale: mix('scale'), x: mix('x'), y: mix('y'), opacity: mix('opacity'), rot: mix('rot') };
}
function volAt(c, lt) { // volume envelope (auto-duck, fades), linear like the server's volume expression
  const k = c.vkf;
  if (!k?.length) return c.volume;
  let i = 0;
  while (i + 1 < k.length && k[i + 1].t <= lt) i++;
  const a = k[i], b = k[i + 1];
  return b ? a.v + (b.v - a.v) * clamp((lt - a.t) / Math.max(1e-6, b.t - a.t), 0, 1) : a.v;
}
function geom(m, c, W, H, pr = propsAt(c, 0)) { // media rect on the canvas: crop, fit/fill, then scale and offset (fractions of canvas)
  const cr = c.crop || {}, mw = m.w * (1 - (cr.l || 0) - (cr.r || 0)), mh = m.h * (1 - (cr.t || 0) - (cr.b || 0));
  const s = (c.fit === 'fill' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh)) * pr.scale;
  const w = mw * s, h = mh * s;
  return { x: (W - w) / 2 + pr.x * W, y: (H - h) / 2 + pr.y * H, w, h };
}
function lookMatrix(c) { // preset blended with identity by strength
  const p = c.look && LOOKS[c.look.name];
  if (!p) return null;
  const a = c.look.amount ?? 1;
  return p.map((v, i) => (i % 4 === 0 ? 1 : 0) + (v - (i % 4 === 0 ? 1 : 0)) * a);
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
function change(fn) { undo.push(JSON.stringify(P)); if (undo.length > 200) undo.shift(); redo = []; fn(); touched(); }
function touched() { S.dirty = true; scheduleSave(); renderAll(); }
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(P));
  P = JSON.parse(from.pop());
  if (S.sel && !selClip()) S.sel = null;
  fitStage(); touched();
}
function scheduleSave() {
  $('#saveState').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api(`/api/projects/${P.id}`, P, 'PUT'); $('#saveState').textContent = 'Saved'; }
    catch (e) { $('#saveState').textContent = 'Not saved'; toast(`Save failed: ${e.message}`); }
  }, 400);
}

// ---------- rendering: chrome ----------
function renderAll() {
  renderTimeline(); renderInspector();
  $('#ratioLabel').textContent = `${P.w}×${P.h} · ${P.fps} fps`;
  if (document.activeElement !== $('#projName')) $('#projName').value = P.name;
}

function renderTimeline() {
  if (!P) return;
  const D = total(), pps = S.pps, sc = $('#tlScroll'), W = Math.max(sc.clientWidth, (D + 6) * pps);
  $('#tlInner').style.width = `${W}px`;
  const step = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s * pps >= 70) ?? 600;
  let ruler = '';
  for (let i = 0; i * step * pps < W; i++) ruler += `<span style="left:${i * step * pps}px">${step < 1 ? (i * step).toFixed(1) : fmtDur(i * step)}</span>`;
  ruler += P.markers.map(t => `<b class="mk" style="left:${t * pps}px" title="Marker ${tc(t)}"></b>`).join('');
  const r = $('#ruler');
  r.innerHTML = ruler;
  r.style.setProperty('--minor', `${(step * pps) / 5}px`);
  let heads = '';
  for (const L of LANES) {
    const R = ['overlay', 'audio', 'text'].includes(L.key) ? rows(L.key) : { row: new Map(), n: 1 }, el = $(`#lane-${L.key}`);
    el.style.height = `${L.h * R.n}px`;
    const snd = L.key === 'main' || L.key === 'audio';
    heads += `<div style="height:${L.h * R.n}px">${L.label}<button class="lt${P.mute[L.key] ? ' on' : ''}" data-lt="${L.key}" title="${snd ? 'Mute' : 'Hide'} ${L.label}" aria-pressed="${!!P.mute[L.key]}">${snd ? 'M' : 'H'}</button></div>`;
    el.innerHTML = P[L.key].map(c => clipHTML(L.key, c, (R.row.get(c.id) || 0) * L.h, L.h)).join('') + (L.key === 'main' ? trHandles() : '');
  }
  $('#heads').innerHTML = heads;
  placePlayhead();
}
function rows(lane) { // overlapping clips stack into rows; a later clip sits higher and also renders on top
  const placed = [], row = new Map();
  for (const c of P[lane]) {
    const s = c.start, e = s + tdur(c, lane);
    let r = 0;
    while (placed.some(p => p.r === r && p.s < e - 1e-6 && s < p.e - 1e-6)) r++;
    placed.push({ r, s, e });
    row.set(c.id, r);
  }
  return { row, n: Math.max(1, ...placed.map(p => p.r + 1)) };
}
function trHandles() {
  return P.main.slice(0, -1).map((c, i) => `<button class="trh${c.tr ? ' on' : ''}${S.sel?.lane === 'tr' && S.sel.id === c.id ? ' sel' : ''}" data-tr-for="${c.id}" style="left:${(P.main[i + 1].start + trF(i) / P.fps / 2) * S.pps}px" title="Transition" aria-label="Transition"></button>`).join('');
}

function clipHTML(lane, c, top = 0, h = 42) {
  const pps = S.pps, m = M.get(c.media), layers = []; // [image, size, position, repeat]
  let label = c.text;
  if (m) {
    label = m.name + (c.speed !== 1 ? ` · ${c.speed}×` : '');
    const full = (m.duration / c.speed) * pps, off = (-c.in / c.speed) * pps, wave = m.wave && (lane === 'audio' || lane === 'main');
    if (m.kind === 'video' && m.stripN && lane !== 'audio') layers.push([`url(/cache/${m.id}.strip.jpg)`, `${full}px ${wave ? '68%' : '100%'}`, `${off}px 0`, 'no-repeat']);
    if (m.kind === 'image') layers.push([`url(/media/${m.id})`, 'auto 100%', '0 0', 'repeat-x']);
    if (wave) layers.push([`url(/cache/${m.id}.wave.png)`, `${full}px ${lane === 'main' ? '32%' : '100%'}`, `${off}px 100%`, 'no-repeat']);
  }
  const bg = layers.length ? `background-image:${layers.map(l => l[0])};background-size:${layers.map(l => l[1])};background-position:${layers.map(l => l[2])};background-repeat:${layers.map(l => l[3])};` : '';
  const marks = (c.kf || []).map(f => `<b class="kfm" style="left:${f.t * pps}px"></b>`).join('')
    + (c.beats || []).filter(b => b >= c.in && b <= c.out).map(b => `<b class="bm" style="left:${((b - c.in) / c.speed) * pps}px"></b>`).join('');
  return `<div class="clip ${lane}${S.sel?.lane === lane && S.sel.id === c.id ? ' sel' : ''}" data-lane="${lane}" data-id="${c.id}" style="left:${c.start * pps}px;width:${Math.max(3, tdur(c, lane) * pps)}px;top:${top + 3}px;height:${h - 6}px;${bg}"><span class="lbl">${esc(label)}</span>${marks}<i class="h l"></i><i class="h r"></i></div>`;
}

function placePlayhead() { $('#playhead').style.transform = `translateX(${S.t * S.pps}px)`; }
function seekTo(t) { // paused seek used by arrows, Home/End and the transport buttons
  if (S.playing) pause();
  S.t = snap(clamp(t, 0, total()));
  placePlayhead(); follow(); S.dirty = true;
  if (selClip()?.kf) renderInspector();
}
function follow() { const sc = $('#tlScroll'), x = S.t * S.pps; if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = x - 60; }

function thumbStyle(m) {
  if (m.kind === 'image') return `background-image:url(/media/${m.id})`;
  if (m.stripN) return `background-image:url(/cache/${m.id}.strip.jpg);background-size:${m.stripN * 100}% 100%;background-position:0 0`;
  if (m.wave) return `background-image:url(/cache/${m.id}.wave.png);background-size:100% 100%`;
  return '';
}
function renderMediaList() {
  const up = uploads.map(u => `<div class="mitem up"><div class="thumb"></div><div class="meta"><b>${esc(u.name)}</b><span>Uploading ${Math.round(u.pct * 100)}%</span></div></div>`).join('');
  const items = [...M.values()].map(m => `<div class="mitem" draggable="true" data-media="${m.id}" title="Drag onto a track">
      <div class="thumb" style="${thumbStyle(m)}"><span>${m.kind}</span></div>
      <div class="meta"><b>${esc(m.name)}</b><span>${m.kind === 'image' ? `${m.w}×${m.h}` : fmtDur(m.duration)}${m.ready ? '' : ' · preparing'}</span></div>
      <span class="mbtns"><button class="add" data-add="${m.id}" title="Add to timeline" aria-label="Add ${esc(m.name)} to timeline">+</button><button class="add rm" data-rm="${m.id}" title="Remove from library" aria-label="Remove ${esc(m.name)} from library">×</button></span></div>`).join('');
  $('#mediaList').innerHTML = up + items || '<p class="hint">Nothing imported yet.</p>';
}

// ---------- inspector ----------
const fmt = (v, unit) => (unit === '%' ? `${Math.round(v * 100)}%` : unit === 's' ? `${(+v).toFixed(2)}s` : unit === '°' ? `${Math.round(v)}°` : `${Math.round(v * 10) / 10}`);
const fill = el => el.style.setProperty('--p', `${(el.value - el.min) / (el.max - el.min) * 100}%`); // slider track fill
const slider = (k, label, v, min, max, step, unit = '') => `<label class="row"><span>${label}</span><input type="range" data-k="${k}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${v}" style="--p:${clamp((v - min) / (max - min), 0, 1) * 100}%"><output>${fmt(v, unit)}</output></label>`;
const pick = (k, label, v, opts) => `<label class="row"><span>${label}</span><select data-k="${k}"${typeof opts[0][0] === 'number' ? ' data-num' : ''}>${opts.map(([val, txt]) => `<option value="${val}"${String(val) === String(v) ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select></label>`;
const colour = (k, label, v) => `<label class="row"><span>${label}</span><input type="color" data-k="${k}" value="${v}"></label>`;
const tick = (k, label, v) => `<label class="row chk"><span>${label}</span><input type="checkbox" data-k="${k}"${v ? ' checked' : ''}></label>`;
const segs = (attr, label, v, opts) => `<div class="row"><span>${label}</span><div class="seg">${opts.map(([val, txt]) => `<button data-${attr}="${val}" class="${val === v ? 'on' : ''}">${txt}</button>`).join('')}</div></div>`;

function renderInspector() {
  const c = selClip();
  pending = null;
  $('#inspector').innerHTML = !c ? projectPanel() : S.sel.lane === 'tr' ? trPanel(c) : c.media ? mediaPanel(c, S.sel.lane) : textPanel(c, S.sel.lane);
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
  return `<h4>Keyframes</h4><div class="actions">${on ? `<button data-act="kfdel">Remove keyframe</button><button data-act="kfease">${eased ? 'Linear from here' : 'Ease from here'}</button>` : `<button data-act="kfadd"${inside ? '' : ' disabled'}>Add keyframe at playhead</button>`}${c.kf?.length ? `<button data-act="kfclear">Clear ${c.kf.length}</button>` : ''}</div>${c.kf?.length ? tick('c.ease', 'Ease all segments', c.ease) : ''}
    <p class="hint">${c.kf?.length ? 'Scale, position and opacity animate between the diamonds. Changing them at the playhead edits or adds a keyframe there.' : 'Add a keyframe, move the playhead, then change scale or position: zoom, pan, punch-in.'}</p>`;
}
function projectPanel() {
  const ratio = Object.keys(RATIOS).find(r => RATIOS[r][0] === P.w && RATIOS[r][1] === P.h);
  return `<h3>Project</h3><p class="muted">${P.w}×${P.h} · ${tc(total())}</p>
    ${segs('ratio', 'Canvas', ratio, Object.keys(RATIOS).map(r => [r, r]))}
    ${pick('p.fps', 'Frame rate', P.fps, [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']])}
    ${colour('p.bg', 'Background', P.bg)}
    <h4>Shortcuts</h4><p class="hint">Space play · S split · ⌫ delete · ⌘D duplicate · ←/→ one frame (⇧ one second) · Home/End · M marker · ⌘Z / ⇧⌘Z · ⌘+scroll zooms the timeline</p>`;
}
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 10];
function tabbed(sections) { // inspector tabs; empty tabs are hidden and the open tab survives re-renders
  const live = sections.filter(s => s[1]), cur = live.some(s => s[0] === S.itab) ? S.itab : live[0][0];
  return `<div class="itabs">${live.map(([n]) => `<button data-itab="${n}" class="${n === cur ? 'on' : ''}">${n}</button>`).join('')}</div>`
    + live.map(([n, h]) => `<div class="isec${n === cur ? ' on' : ''}" data-sec="${n}">${h}</div>`).join('');
}
function mediaPanel(c, lane) {
  const m = M.get(c.media);
  if (!m) return '<h3>Missing media</h3><div class="actions"><button data-act="delete">Delete</button></div>';
  const pr = propsAt(c, S.t - c.start), cr = c.crop || {}, vis = m.kind !== 'audio', vid = m.kind === 'video', mk = c.mask;
  const head = `<h3>${esc(m.name)}</h3><p class="muted">${lane} track · ${tc(tdur(c, lane))}${m.kind === 'image' ? '' : ` of ${tc(m.duration)}`}${m.hdr ? ' · HDR, tone-mapped on export' : ''}${m.alpha || m.trans ? ' · transparent' : ''}</p>`;
  let basic = m.kind !== 'image' ? pick('c.speed', 'Speed', c.speed, SPEEDS.map(s => [s, `${s}×`])) : '';
  if (vis) {
    basic += segs('fit', 'Fit', c.fit, [['fit', 'Fit'], ['fill', 'Fill'], ...(lane === 'main' ? [['blur', 'Blur bg']] : [])]);
    basic += `<h4>Transform</h4>${slider('c.scale', 'Scale', pr.scale, 0.1, 4, 0.01, '%')}${slider('c.x', 'Position X', pr.x, -1, 1, 0.005, '%')}${slider('c.y', 'Position Y', pr.y, -1, 1, 0.005, '%')}`
      + slider('c.rot', 'Rotate', pr.rot, -180, 180, 1, '°') + (lane === 'overlay' ? slider('c.opacity', 'Opacity', pr.opacity, 0, 1, 0.01, '%') : '') + kfRow(c, lane);
  }
  basic += `<h4>Fade</h4>${slider('c.fadeIn', 'Fade in', c.fadeIn, 0, 3, 0.05, 's')}${slider('c.fadeOut', 'Fade out', c.fadeOut, 0, 3, 0.05, 's')}`;
  let look = '';
  if (vis) {
    look += `<h4>Filter</h4><div class="presets small">${['none', ...Object.keys(LOOKS)].map(n => `<button data-look="${n}" class="${(c.look?.name || 'none') === n ? 'on' : ''}">${n[0].toUpperCase() + n.slice(1)}</button>`).join('')}</div>${c.look ? slider('c.look.amount', 'Strength', c.look.amount ?? 1, 0, 1, 0.01, '%') : ''}`;
    look += `<h4>Adjust</h4>${slider('c.adj.b', 'Brightness', c.adj.b, 0, 2, 0.01, '%')}${slider('c.adj.c', 'Contrast', c.adj.c, 0, 2, 0.01, '%')}${slider('c.adj.s', 'Saturation', c.adj.s, 0, 3, 0.01, '%')}`;
    look += `<h4>Crop</h4>${slider('c.crop.l', 'Left', cr.l || 0, 0, 0.45, 0.005, '%')}${slider('c.crop.r', 'Right', cr.r || 0, 0, 0.45, 0.005, '%')}${slider('c.crop.t', 'Top', cr.t || 0, 0, 0.45, 0.005, '%')}${slider('c.crop.b', 'Bottom', cr.b || 0, 0, 0.45, 0.005, '%')}${tick('c.flip', 'Mirror', c.flip)}`;
    look += `<h4>Mask</h4><div class="presets small">${MASKS.map(([v, n]) => `<button data-mask="${v}" class="${(mk?.type || 'none') === v ? 'on' : ''}">${n}</button>`).join('')}</div>`
      + (mk ? slider('c.mask.x', 'Centre X', mk.x, -0.5, 0.5, 0.005, '%') + slider('c.mask.y', 'Centre Y', mk.y, -0.5, 0.5, 0.005, '%')
        + (['circle', 'rect'].includes(mk.type) ? slider('c.mask.w', 'Width', mk.w, 0.05, 1.5, 0.01, '%') : '')
        + (mk.type !== 'linear' ? slider('c.mask.h', mk.type === 'mirror' ? 'Band' : 'Height', mk.h, 0.02, 1.5, 0.01, '%') : '')
        + slider('c.mask.rot', 'Rotate', mk.rot, -180, 180, 1, '°') + slider('c.mask.feather', 'Feather', mk.feather, 0, 0.3, 0.005, '%') + tick('c.mask.invert', 'Invert', mk.invert) : '');
    look += `<h4>Chroma key</h4>${c.key ? `${colour('c.key.color', 'Key colour', c.key.color)}${slider('c.key.sim', 'Strength', c.key.sim, 0.01, 1, 0.01, '%')}${slider('c.key.blend', 'Softness', c.key.blend, 0, 0.5, 0.01, '%')}<div class="actions"><button data-act="keyoff">Turn off</button></div>`
      : '<div class="actions"><button data-act="keyon">Remove green screen</button></div>'}`;
  }
  let audio = '';
  if (m.hasAudio) {
    audio += slider('c.volume', 'Volume', c.volume, 0, 4, 0.01, '%') + tick('c.denoise', 'Reduce noise', c.denoise)
      + `<h4>Volume envelope</h4>${c.vkf?.length ? `<p class="muted">${c.vkf.length} volume points</p>` : lane === 'audio' ? '<p class="hint">Auto duck lowers this clip wherever another clip has speech.</p>' : ''}<div class="actions">${lane === 'audio' ? '<button data-act="duck">Auto duck under speech</button>' : ''}${c.vkf?.length ? '<button data-act="vkfclear">Clear envelope</button>' : ''}${lane !== 'audio' && c.volume > 0 ? '<button data-act="detach">Detach audio</button>' : ''}</div>`;
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
  acts.push('<button data-act="reset">Reset</button>', '<button data-act="delete">Delete</button>');
  let tools = vid ? `<h4>Smart tools</h4><div class="actions"><button data-act="matte"${m.alpha ? ' disabled' : ''}>Remove background</button><button data-act="reframe">Auto reframe</button><button data-act="stabilize">Stabilize</button>${lane === 'overlay' ? '<button data-act="track">Track motion</button>' : ''}</div>
    <h4>Speed ramp</h4><div class="row"><span>Curve</span><select id="rampSel">${Object.keys(RAMPS).map(n => `<option value="${n}">${RAMP_NAMES[n]}</option>`).join('')}</select></div>
    <div class="actions"><button data-act="ramp">Apply ramp</button></div><p class="hint">Splits the clip into 8 parts with ramped speeds; every part stays editable.</p>` : '';
  tools += `<h4>Clip</h4><div class="actions">${acts.join('')}</div>`;
  return head + tabbed([['Basic', basic], ['Look', look], ['Audio', audio], ['Tools', tools]]) + '<p id="clipStatus" class="muted"></p>';
}
function textPanel(c, lane) {
  const cap = lane === 'captions', st = textStyle(c, lane), r = cap ? 'cap' : 'c.style', pr = cap ? null : propsAt(c, S.t - c.start);
  const style = `<textarea data-k="c.text" rows="3" spellcheck="false">${esc(c.text)}</textarea>`
    + (cap ? `<p class="hint">Style edits apply to every caption.</p><div class="presets small">${Object.keys(CAP_PRESETS).map(n => `<button data-cappreset="${n}">${n}</button>`).join('')}</div>`
      : `<div class="presets small">${Object.keys(TEXT_PRESETS).map(n => `<button data-textpreset="${n}">${n}</button>`).join('')}</div>`)
    + pick(`${r}.font`, 'Font', st.font, FONTS.map(f => [f, f])) + pick(`${r}.weight`, 'Weight', st.weight, [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']])
    + slider(`${r}.size`, 'Size', st.size, 16, 260, 1) + colour(`${r}.color`, 'Color', st.color) + (cap ? colour('cap.hl', 'Highlight', st.hl) + tick('cap.pop', 'Pop active word', st.pop) : '')
    + `<h4>Outline &amp; background</h4>${slider(`${r}.strokeW`, 'Outline', st.strokeW, 0, 20, 0.5)}${colour(`${r}.stroke`, 'Outline color', st.stroke)}${tick(`${r}.shadow`, 'Shadow', st.shadow)}`
    + tick(`${r}.box`, 'Background', st.box) + colour(`${r}.boxColor`, 'Background color', st.boxColor) + slider(`${r}.boxAlpha`, 'Bg opacity', st.boxAlpha, 0, 1, 0.01, '%')
    + `<h4>Layout</h4>${tick(`${r}.upper`, 'All caps', st.upper)}${slider(`${r}.maxW`, 'Max width', st.maxW, 0.2, 1, 0.01, '%')}`;
  const anim = pick(`${r}.anim`, 'In', st.anim || 'none', ANIMS) + pick(`${r}.out`, 'Out', st.out || 'none', OUTS) + pick(`${r}.loop`, 'Loop', st.loop || 'none', LOOPS);
  const pos = cap ? slider('cap.y', 'Position Y', P.capStyle.y, 0, 1, 0.005, '%') + '<p class="hint">Captions sit on one line position; drag one on the preview to move them all.</p>'
    : slider('c.x', 'Position X', pr.x, 0, 1, 0.005, '%') + slider('c.y', 'Position Y', pr.y, 0, 1, 0.005, '%') + slider('c.scale', 'Scale', pr.scale, 0.2, 4, 0.01, '%')
      + slider('c.rot', 'Rotate', pr.rot, -180, 180, 1, '°') + slider('c.opacity', 'Opacity', pr.opacity, 0, 1, 0.01, '%') + kfRow(c, lane);
  return `<h3>${cap ? 'Caption' : 'Text'}</h3>` + tabbed([['Style', style], ['Animate', anim], ['Position', pos]])
    + `<div class="actions"><button data-act="split">Split</button>${cap ? '' : '<button data-act="dup">Duplicate</button><button data-act="track">Track motion</button>'}<button data-act="delete">Delete</button>${cap ? '<button data-act="clearcaps">Delete all captions</button>' : ''}</div><p id="clipStatus" class="muted"></p>`;
}
function apply(el) { // data-k="c.adj.b" -> selected clip .adj.b ; "cap.size" -> caption style ; "p.fps" -> project
  const [root, ...path] = el.dataset.k.split('.'), last = path.pop();
  let o = root === 'c' ? selClip() : root === 'cap' ? P.capStyle : P;
  if (!o) return;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || 'num' in el.dataset ? +el.value : el.value;
  if (root === 'c' && !path.length && KF_PROPS.includes(last)) return setProp(o, last, v);
  for (const p of path) o = o[p] ??= {};
  o[last] = v;
  if (el.dataset.k === 'c.text') retext(selClip());
}
function retext(c) { // keep word timings when the word count still matches, otherwise it becomes plain text
  if (!c.words) return;
  const ws = c.text.trim().split(/\s+/);
  if (ws.length === c.words.length) c.words.forEach((w, i) => { w.w = ws[i]; }); else delete c.words;
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
function vidFor(key, m) {
  let v = pool.get(key);
  if (!v) {
    v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.addEventListener('seeked', () => { S.dirty = true; });
    v.addEventListener('loadeddata', () => { S.dirty = true; });
    $('#mediaPool').append(v);
    pool.set(key, v);
  }
  if (v.dataset.media !== m.id) { v.dataset.media = m.id; v.src = `/media/${m.id}`; }
  return v;
}
function imgFor(m) {
  let i = imgs.get(m.id);
  if (!i) { i = new Image(); i.onload = () => { S.dirty = true; }; i.src = `/media/${m.id}`; imgs.set(m.id, i); }
  return i;
}
let actx;
function audioOn() { try { actx ??= new AudioContext(); actx.resume(); } catch { actx = null; } } // needs a user gesture
function gain(v, vol) { // Web Audio gain: the preview can play volumes above 100%, like the export
  if (actx && v._g === undefined) { try { const s = actx.createMediaElementSource(v); v._g = actx.createGain(); s.connect(v._g).connect(actx.destination); } catch { v._g = null; } }
  if (v._g) { v.volume = 1; v._g.gain.value = vol; } else v.volume = clamp(vol, 0, 1);
}
const layerCv = [];
function layer(n) {
  const cv = $('#cv');
  const L = layerCv[n] ??= document.createElement('canvas');
  if (L.width !== cv.width || L.height !== cv.height) { L.width = cv.width; L.height = cv.height; }
  return L;
}
function transition(ctx, A, B, type, p) { // per-pixel math of ffmpeg's xfade, whose progress P runs 1 -> 0
  const W = A.width, H = A.height, P1 = clamp(1 - p, 0, 1);
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
    const C = layer(2), cx = C.getContext('2d'), R = Math.hypot(W / 2, H / 2), q = (P1 - 0.5) * 3;
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
  } else { // fade: a*P + b*(1-P)
    ctx.drawImage(A, 0, 0); ctx.globalAlpha = 1 - P1; ctx.drawImage(B, 0, 0);
  }
  ctx.restore();
}
function sync(v, src, rate, vol) { // the wall clock is the master; media elements follow it
  gain(v, vol);
  if (S.playing) {
    if (v.playbackRate !== rate) v.playbackRate = rate;
    if (v.paused) { if (Math.abs(v.currentTime - src) > 0.05) v.currentTime = src; v.play().catch(() => {}); }
    else if (Math.abs(v.currentTime - src) > 0.3) v.currentTime = src;
  } else {
    if (!v.paused) v.pause();
    if (!v.seeking && Math.abs(v.currentTime - src) > 0.5 / P.fps) v.currentTime = src;
  }
}
function paint() {
  const cv = $('#cv'), ctx = cv.getContext('2d'), k = cv.width / P.w, t = S.t, live = new Set();
  hits = [];
  packMain();
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  const act = [];
  P.main.forEach((c, i) => { if (t >= c.start && t < c.start + tdur(c, 'main')) act.push(i); });
  const mi = act.length ? act[act.length - 1] : -1;
  const tr = act.length > 1 ? { type: P.main[act[0]].tr?.type || 'fade', p: clamp((t - P.main[act[1]].start) / (trF(act[0]) / P.fps), 0, 1) } : null;
  const layers = act.map(i => ['main', P.main[i], `m${i % 2}`, i]); // two elements alternate: next cut pre-seeked, transitions show both
  for (const c of P.overlay) if (t >= c.start && t < c.start + len(c)) layers.push(['overlay', c, `o${c.id}`]);
  for (const c of P.audio) if (t >= c.start && t < c.start + len(c)) layers.push(['audio', c, `a${c.id}`]);
  for (const [lane, c, key, i] of layers) {
    const m = M.get(c.media);
    if (!m) continue;
    const g = tr && lane === 'main' ? (i === act[0] ? 1 - tr.p : tr.p) : 1; // audio crossfade, like acrossfade
    let el;
    if (m.kind === 'image') el = imgFor(m);
    else { el = vidFor(key, m); live.add(el); sync(el, c.in + (t - c.start) * c.speed, c.speed, S.recMute || P.mute[lane] ? 0 : volAt(c, t - c.start) * g); }
    if (lane === 'audio' || (lane === 'overlay' && P.mute.overlay)) continue;
    if (tr && lane === 'main') { // each side renders its full frame into a layer, then the transition composites them
      const L = layer(i === act[0] ? 0 : 1), lx = L.getContext('2d');
      lx.fillStyle = P.bg; lx.fillRect(0, 0, L.width, L.height);
      drawMedia(lx, lane, c, m, el, t - c.start, k);
      if (i === act[1]) transition(ctx, layer(0), L, tr.type, tr.p);
    } else drawMedia(ctx, lane, c, m, el, t - c.start, k);
  }
  const nx = mi >= 0 && P.main[mi + 1], nm = nx && M.get(nx.media);
  if (nm && nm.kind !== 'image' && nx.start - t < 1.5) {
    const v = vidFor(`m${(mi + 1) % 2}`, nm);
    if (!live.has(v)) { live.add(v); if (!v.paused) v.pause(); if (!v.seeking && Math.abs(v.currentTime - nx.in) > 0.04) v.currentTime = nx.in; }
  }
  for (const v of pool.values()) if (!live.has(v) && !v.paused) v.pause();
  drawTexts(ctx, t, k, true);
  if (S.pickRect) {
    const R = S.pickRect, d = devicePixelRatio || 1;
    ctx.save(); ctx.strokeStyle = '#3dff8b'; ctx.lineWidth = 2 * d; ctx.setLineDash([5 * d, 4 * d]);
    ctx.strokeRect(R.x * k, R.y * k, R.w * k, R.h * k); ctx.restore();
  }
  const s = S.sel && hits.find(h => h.id === S.sel.id);
  if (s) {
    const d = devicePixelRatio || 1;
    ctx.save(); ctx.strokeStyle = '#ff7a45'; ctx.lineWidth = 1.5 * d; ctx.setLineDash([6 * d, 4 * d]);
    ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0); ctx.restore();
  }
  $('#tc').textContent = `${tc(t)} / ${tc(S.playing ? S.end : total())}`;
}
function drawMedia(ctx, lane, c, m, el, lt, k) {
  if (el.tagName === 'VIDEO' ? el.readyState < 2 : !(el.complete && el.naturalWidth)) return;
  const pr = propsAt(c, lt), g = geom(m, c, P.w, P.h, pr), d = tdur(c, lane), a = c.adj || {}, cr = c.crop || {};
  const f = clamp(Math.min(c.fadeIn > 0 ? lt / c.fadeIn : 1, c.fadeOut > 0 ? (d - lt) / c.fadeOut : 1), 0, 1);
  const vw = el.videoWidth || el.naturalWidth, vh = el.videoHeight || el.naturalHeight, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0);
  const lm = lookMatrix(c); // same order and math as the server's adjust() then look()
  const filt = [a.b !== 1 || a.c !== 1 || a.s !== 1 ? `brightness(${a.b}) contrast(${a.c}) saturate(${a.s})` : '', lm ? lookFilter(lm) : ''].filter(Boolean).join(' ');
  const rad = ((pr.rot || 0) * Math.PI) / 180;
  const draw = (x, y, w, h, fgr = true) => { // crop = source rect; mirror flips inside the rect; rotation spins about its centre
    ctx.save();
    if (fgr && rad) { ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rad); ctx.translate(-(x + w / 2), -(y + h / 2)); }
    if (fgr && (c.key || c.mask)) { // needs pixels: filter + mirror + key + mask on an offscreen canvas, then composite
      const oc = offscreen(el, c, [(cr.l || 0) * vw, (cr.t || 0) * vh, fx * vw, fy * vh], w, h, filt);
      ctx.filter = 'none'; ctx.drawImage(oc, x, y, w, h); ctx.restore();
      return;
    }
    if (c.flip) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(el, (cr.l || 0) * vw, (cr.t || 0) * vh, fx * vw, fy * vh, x, y, w, h);
    ctx.restore();
  };
  ctx.save();
  if (lane === 'main' && c.fit === 'blur') {
    const mw = m.w * fx, mh = m.h * fy, s = Math.max(P.w / mw, P.h / mh) * 1.08;
    ctx.filter = `${filt} blur(${(P.w / 40) * k}px)`.trim();
    draw(((P.w - mw * s) / 2) * k, ((P.h - mh * s) / 2) * k, mw * s * k, mh * s * k, false);
  }
  ctx.filter = filt || 'none';
  if (lane === 'overlay') ctx.globalAlpha = pr.opacity * f;
  draw(g.x * k, g.y * k, g.w * k, g.h * k);
  ctx.restore();
  if (lane === 'main' && f < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - f})`; ctx.fillRect(0, 0, P.w * k, P.h * k); } // ffmpeg fade = to black
  hits.push({ lane, id: c.id, x0: g.x * k, y0: g.y * k, x1: (g.x + g.w) * k, y1: (g.y + g.h) * k });
}
const keyCv = document.createElement('canvas'), hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function offscreen(el, c, src, w, h, filt) { // filter + mirror, then chroma key (colorkey's formula) x mask, like the export
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  if (keyCv.width !== W || keyCv.height !== H) { keyCv.width = W; keyCv.height = H; }
  const x = keyCv.getContext('2d', { willReadFrequently: true });
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, W, H); x.filter = filt || 'none';
  if (c.flip) { x.translate(W, 0); x.scale(-1, 1); }
  x.drawImage(el, ...src, 0, 0, W, H);
  x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none';
  if (c.key) { // alpha *= clip((dist - similarity) / blend)
    const img = x.getImageData(0, 0, W, H), d = img.data, [kr, kg, kb] = hexRgb(c.key.color), sim = c.key.sim, bl = c.key.blend;
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb, diff = Math.sqrt((dr * dr + dg * dg + db * db) / 195075);
      d[i + 3] *= bl > 0.0001 ? clamp((diff - sim) / bl, 0, 1) : diff > sim ? 1 : 0;
    }
    x.putImageData(img, 0, 0);
  }
  if (c.mask) { x.globalCompositeOperation = 'destination-in'; x.drawImage(maskCanvas(c.mask, W, H), 0, 0); x.globalCompositeOperation = 'source-over'; }
  return keyCv;
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
  if (mk.invert) { x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none'; x.globalCompositeOperation = 'xor'; x.fillRect(0, 0, W, H); }
  if (maskCache.size > 12) maskCache.delete(maskCache.keys().next().value);
  maskCache.set(key, cv);
  return cv;
}
async function maskPNG(c, m) { // export: opaque greyscale (luma -> alpha via alphamerge) at the cropped source aspect
  const cr = c.crop || {}, mw = m.w * (1 - (cr.l || 0) - (cr.r || 0)), mh = m.h * (1 - (cr.t || 0) - (cr.b || 0)), s = Math.min(1, 1280 / Math.max(mw, mh));
  const W = Math.round(mw * s), H = Math.round(mh * s), cv = new OffscreenCanvas(W, H), x = cv.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.drawImage(maskCanvas(c.mask, W, H), 0, 0);
  return blobURL(await cv.convertToBlob({ type: 'image/png' }));
}
function textStyle(it, lane) { return { ...TEXT_BASE, ...(lane === 'captions' ? P.capStyle : it.style) }; }
function drawTexts(ctx, t, k, preview) {
  for (const lane of ['text', 'captions']) if (!P.mute[lane]) for (const it of P[lane]) if (t >= it.start && t < it.start + it.dur) drawText(ctx, it, lane, t - it.start, k, preview);
}
function drawText(ctx, it, lane, lt, k, preview) { // shared by preview and export: what you see is what renders
  const st = textStyle(it, lane), pr = lane === 'captions' ? { scale: 1, x: 0.5, y: P.capStyle.y, opacity: 1, rot: 0 } : propsAt(it, lt);
  const u = (Math.min(P.w, P.h) / 1080) * k * pr.scale, size = st.size * u;
  const timed = it.words?.length ? it.words : null;
  const paras = timed ? [timed.map(w => w.w)] : String(it.text ?? '').split('\n').map(p => p.split(/\s+/).filter(Boolean));
  let active = -1;
  if (timed && st.hl) timed.forEach((w, i) => { if (lt >= w.s) active = i; });
  ctx.save();
  ctx.font = `${st.weight} ${size}px "${st.font}", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const sp = ctx.measureText(' ').width, maxW = st.maxW * P.w * k, lines = [];
  const grow = timed && st.pop ? 1.12 : 1; // every word reserves its popped width: no overlap, and the line doesn't jitter
  let idx = 0;
  for (const para of paras) {
    let ln = { ws: [], w: 0 };
    for (let w of para) {
      if (st.upper) w = w.toUpperCase();
      const ww = ctx.measureText(w).width;
      if (ln.ws.length && ln.w + sp + ww * grow > maxW) { lines.push(ln); ln = { ws: [], w: 0 }; }
      ln.w += (ln.ws.length ? sp : 0) + ww * grow;
      ln.ws.push({ w, ww, i: idx++ });
    }
    lines.push(ln);
  }
  const lh = size * st.lh, x = pr.x * P.w * k, y = pr.y * P.h * k;
  const top = y - (lines.length * lh) / 2, padX = size * 0.3;
  if (pr.rot) { ctx.translate(x, y); ctx.rotate((pr.rot * Math.PI) / 180); ctx.translate(-x, -y); }
  const av = st.anim && st.anim !== 'none' ? clamp(lt / ANIM_T, 0, 1) : 1; // "in" animation progress
  ctx.globalAlpha = pr.opacity * (st.anim === 'pop' ? Math.min(1, av * 2) : av);
  if (av < 1 && st.anim === 'pop') { const s = 0.6 + 0.4 * easeOutBack(av); ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
  if (av < 1 && st.anim === 'slide') ctx.translate(0, (1 - av) ** 3 * lh * 0.8);
  const ao = st.out && st.out !== 'none' ? clamp((it.dur - lt) / ANIM_T, 0, 1) : 1; // "out" animation, mirrored
  if (ao < 1) {
    ctx.globalAlpha *= st.out === 'pop' ? Math.min(1, ao * 2) : ao;
    if (st.out === 'pop') { const s = 0.6 + 0.4 * ao; ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
    if (st.out === 'slide') ctx.translate(0, -((1 - ao) ** 2) * lh * 0.8);
  }
  if (st.loop === 'bounce') ctx.translate(0, -Math.abs(Math.sin(lt * Math.PI * 2)) * size * 0.15);
  if (st.loop === 'pulse') { const s = 1 + 0.06 * Math.sin(lt * Math.PI * 4); ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
  if (st.loop === 'wiggle') { ctx.translate(x, y); ctx.rotate(0.06 * Math.sin(lt * Math.PI * 6)); ctx.translate(-x, -y); }
  if (st.box) {
    ctx.fillStyle = hexA(st.boxColor, st.boxAlpha);
    for (const [li, ln] of lines.entries()) if (ln.ws.length) { ctx.beginPath(); ctx.roundRect(x - ln.w / 2 - padX, top + li * lh, ln.w + padX * 2, lh, size * 0.18); ctx.fill(); }
  }
  for (const [li, ln] of lines.entries()) {
    let cx = x - ln.w / 2;
    const cy = top + li * lh + lh / 2;
    for (const w of ln.ws) {
      const on = w.i === active, wx = cx + (w.ww * grow - w.ww) / 2;
      ctx.save();
      if (on && st.pop) { ctx.translate(wx + w.ww / 2, cy); ctx.scale(grow, grow); ctx.translate(-(wx + w.ww / 2), -cy); }
      if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = size * 0.18; ctx.shadowOffsetY = size * 0.04; }
      if (st.strokeW > 0) { ctx.lineWidth = st.strokeW * u * 2; ctx.strokeStyle = st.stroke; ctx.strokeText(w.w, wx, cy); ctx.shadowColor = 'transparent'; }
      ctx.fillStyle = on ? st.hl : st.color;
      ctx.fillText(w.w, wx, cy);
      ctx.restore();
      cx += w.ww * grow + sp;
    }
  }
  ctx.restore();
  if (preview) {
    const bw = Math.max(size, ...lines.map(l => l.w)) / 2 + padX;
    hits.push({ lane, id: it.id, x0: x - bw, y0: top, x1: x + bw, y1: top + lines.length * lh });
  }
}
function frame(now) {
  if (P) {
    if (S.playing) {
      S.t = Math.min(S.t0 + (now - S.wall0) / 1000, S.end);
      if (S.t >= S.end) pause();
      S.dirty = true;
      placePlayhead();
      follow();
    }
    if (S.dirty) { S.dirty = false; paint(); }
  }
  requestAnimationFrame(frame);
}
function play() {
  const D = total();
  if (D <= 0) return;
  if (S.t >= D - 1e-3) S.t = 0;
  audioOn();
  Object.assign(S, { playing: true, end: D, t0: S.t, wall0: performance.now(), dirty: true });
  $('#btnPlay').innerHTML = ICON.pause;
}
function pause() { S.playing = false; S.t = snap(S.t); S.dirty = true; $('#btnPlay').innerHTML = ICON.play; placePlayhead(); }

// ---------- edits ----------
function addMedia(id, lane, t) {
  const m = M.get(id);
  if (!m) return;
  lane = m.kind === 'audio' ? 'audio' : lane === 'overlay' ? 'overlay' : 'main';
  const c = { id: hex12(), media: id, start: 0, in: 0, out: m.kind === 'image' ? 3 : m.duration, speed: 1, volume: 1, fit: lane === 'overlay' ? 'fill' : 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } };
  change(() => {
    if (lane === 'main') { packMain(); P.main.splice(t === undefined ? P.main.length : P.main.filter(x => x.start + tdur(x, 'main') / 2 < t).length, 0, c); }
    else { c.start = Math.max(0, t ?? S.t); P[lane].push(c); }
    S.sel = { lane, id: c.id };
  });
}
function addText(name) {
  change(() => {
    const c = { id: hex12(), start: S.t, dur: 3, text: { Title: 'Your title', Sticker: '🔥' }[name] || 'Your text', style: { ...TEXT_PRESETS[name] }, x: 0.5, y: 0.42 };
    P.text.push(c);
    S.sel = { lane: 'text', id: c.id };
  });
}
function split() {
  packMain();
  const t = S.t, inside = (x, lane) => t > x.start + 1e-6 && t < x.start + tdur(x, lane) - 1e-6;
  let lane = S.sel?.lane === 'tr' ? 'main' : S.sel?.lane, c = selClip();
  if (!c || !inside(c, lane)) { lane = 'main'; c = P.main.find(x => inside(x, 'main')); }
  if (!c) return toast('Put the playhead over a clip to split it');
  change(() => {
    const lt = t - c.start, b = structuredClone(c);
    b.id = hex12();
    b.start = t;
    delete c.tr; // the outgoing transition now belongs to the second half
    if (c.kf) { // keyframes split at the cut, with an interpolated keyframe on both sides
      const mid = { t: lt, ...propsAt(c, lt) };
      c.kf = [...c.kf.filter(f => f.t < lt), mid];
      b.kf = [{ ...mid, t: 0 }, ...b.kf.filter(f => f.t > lt).map(f => ({ ...f, t: f.t - lt }))];
    }
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
    S.sel = { lane, id: b.id };
  });
}
function del() {
  const c = selClip();
  if (!c) return;
  if (S.sel.lane === 'tr') return change(() => { delete c.tr; });
  change(() => { P[S.sel.lane] = P[S.sel.lane].filter(x => x !== c); S.sel = null; });
}
function dup() {
  const c = selClip(), lane = S.sel?.lane;
  if (!c || lane === 'tr') return;
  change(() => {
    const b = { ...structuredClone(c), id: hex12() };
    if (lane !== 'main') b.start = c.start + tdur(c, lane);
    P[lane].splice(P[lane].indexOf(c) + 1, 0, b);
    S.sel = { lane, id: b.id };
  });
}

async function removePauses() { // CapCut's "remove pauses": silencedetect, then split main clips around the gaps
  const ids = [...new Set(P.main.filter(c => M.get(c.media)?.hasAudio).map(c => c.media))];
  if (!ids.length) return toast('Remove pauses works on main-track clips with sound');
  const min = +$('#pauseLen').value, pad = 0.1, btn = $('#btnPauses');
  btn.disabled = true;
  try {
    const sil = new Map();
    for (const id of ids) sil.set(id, (await api('/api/silences', { media: id, noise: -35, min })).silences);
    const next = P.main.flatMap(c => {
      const ss = sil.get(c.media);
      if (!ss) return [c];
      const keep = [];
      let cur = c.in;
      for (const [a, b] of ss) {
        const s = Math.max(a + pad, c.in), e = Math.min(b - pad, c.out); // keep a little air around speech
        if (e - s < 0.1) continue;
        if (s > cur) keep.push([cur, s]);
        cur = Math.max(cur, e);
      }
      if (c.out > cur) keep.push([cur, c.out]);
      const parts = keep.filter(([a, b]) => (b - a) / c.speed >= 2 / P.fps);
      if (!parts.length || (parts.length === 1 && parts[0][0] === c.in && parts[0][1] === c.out)) return [c];
      const last = parts.length - 1; // jump cuts are hard cuts: only the last piece keeps the clip's outgoing transition
      return parts.map(([a, b], i) => ({ ...structuredClone(c), id: i ? hex12() : c.id, in: a, out: b, fadeIn: i ? 0 : c.fadeIn, fadeOut: i === last ? c.fadeOut : 0, tr: i === last ? c.tr : undefined, kf: undefined }));
    });
    const before = total();
    if (JSON.stringify(next) === JSON.stringify(P.main)) return toast(`No pauses longer than ${min} s`);
    change(() => { P.main = next; });
    toast(`Removed ${(before - total()).toFixed(1)} s of pauses`);
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

const setStatus = msg => { const s = $('#clipStatus'); if (s) s.textContent = msg; else toast(msg); };
async function job(path, body, label) { // start a server job and poll it, showing progress next to the clip
  const { job: id } = await api(path, body);
  for (;;) {
    await new Promise(r => setTimeout(r, 500));
    const j = await api(`/api/jobs/${id}`);
    if (j.state === 'done') return j;
    if (j.state !== 'running') throw new Error((j.error || `${label} failed`).slice(-300));
    setStatus(`${label}… ${Math.round((j.progress || 0) * 100)}%`);
  }
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
  catch (e) { setStatus(e.message); }
}
function beatSync(c, every) { // every main clip ends on a beat mark (CapCut's beat sync)
  const marks = c.beats.filter(b => b >= c.in && b <= c.out).map(b => c.start + (b - c.in) / c.speed).filter((_, i) => i % every === 0);
  if (marks.length < 2) return toast('Not enough beats under the music clip');
  change(() => {
    for (const x of P.main) {
      packMain();
      const end = marks.find(mk => mk > x.start + 0.25), m = M.get(x.media);
      if (end === undefined || !m) continue;
      const want = (end - x.start) * x.speed;
      if (m.kind === 'image' || x.in + want <= m.duration) x.out = x.in + want;
    }
  });
  toast(`Main cuts now land on every ${every > 1 ? `${every} beats` : 'beat'}`);
}
async function freeze(c, lane) {
  const lt = S.t - c.start;
  if (lt < 0 || lt > tdur(c, lane)) return toast('Put the playhead over the clip');
  setStatus('Grabbing frame…');
  try {
    const img = await api('/api/still', { media: c.media, t: c.in + lt * c.speed });
    await loadMedia();
    change(() => {
      const fr = { ...structuredClone(c), id: hex12(), media: img.id, start: S.t, in: 0, out: 2, speed: 1, fadeIn: 0, fadeOut: 0 };
      delete fr.kf; delete fr.tr;
      if (lane !== 'main') P[lane].push(fr);
      else {
        const i = P.main.indexOf(c);
        if (lt > 1 / P.fps && lt < tdur(c, 'main') - 1 / P.fps) {
          const b = { ...structuredClone(c), id: hex12(), in: c.in + lt * c.speed, fadeIn: 0 };
          c.out = b.in; c.fadeOut = 0; delete c.tr; delete b.kf;
          P.main.splice(i + 1, 0, fr, b);
        } else P.main.splice(lt <= 1 / P.fps ? i : i + 1, 0, fr);
      }
      S.sel = { lane, id: fr.id };
    });
  } catch (e) { setStatus(e.message); }
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
async function removeBackground(c) { // Apple Vision person segmentation, on this Mac
  try {
    const j = await job('/api/matte', { media: c.media }, 'Removing background');
    await loadMedia();
    change(() => { c.media = j.media; });
    toast('Background removed. Put it on the overlay track over B-roll.');
  } catch (e) { setStatus(e.message); }
}
function ramp(c, lane, name) { // speed curve baked into 8 editable parts (inner cuts are hard cuts)
  const curve = RAMPS[name], n = curve.length, step = (c.out - c.in) / n;
  change(() => {
    const parts = curve.map((s, i) => ({ ...structuredClone(c), id: i ? hex12() : c.id, in: c.in + i * step, out: c.in + (i + 1) * step, speed: clamp(c.speed * s, 0.1, 10),
      fadeIn: i ? 0 : c.fadeIn, fadeOut: i === n - 1 ? c.fadeOut : 0, tr: i === n - 1 ? c.tr : undefined, kf: undefined }));
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
async function remake(c, kind) { // reverse / stabilize render a new library item; the clip switches to it
  try {
    const j = await job(`/api/${kind}`, { media: c.media }, kind === 'reverse' ? 'Reversing' : 'Stabilizing');
    await loadMedia();
    const d = M.get(j.media).duration;
    change(() => {
      if (kind === 'reverse') { const a = c.in, b = c.out; c.in = Math.max(0, d - b); c.out = Math.min(d, d - a); }
      c.media = j.media;
    });
    toast(kind === 'reverse' ? 'Reversed' : 'Stabilized');
  } catch (e) { setStatus(e.message); }
}
async function autoReframe(c) { // keep the largest face centred (CapCut's auto reframe), as eased keyframes
  const m = M.get(c.media);
  try {
    const j = await job('/api/faces', { media: c.media, t0: c.in, t1: c.out }, 'Finding faces');
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
  } catch (e) { setStatus(e.message); }
}
async function autoDuck(c) { // music dips ~12 dB wherever another clip has sound (speech), with short ramps
  const src = [...P.main, ...P.audio].filter(x => x !== c && M.get(x.media)?.hasAudio && x.volume > 0);
  if (!src.length) return toast('No other clips with sound to duck under');
  setStatus('Finding speech…');
  try {
    packMain();
    const sil = new Map(), speech = [];
    for (const id of new Set(src.map(x => x.media))) sil.set(id, (await api('/api/silences', { media: id, noise: -35, min: 0.3 })).silences);
    for (const x of src) { // non-silent stretches of each clip, on the timeline
      let cur = x.in;
      const add = (a, b) => { if (b - a > 0.05) speech.push([x.start + (a - x.in) / x.speed, x.start + (b - x.in) / x.speed]); };
      for (const [a, b] of sil.get(x.media)) { if (b <= x.in || a >= x.out) continue; add(cur, Math.min(a, x.out)); cur = Math.max(cur, b); }
      add(cur, x.out);
    }
    speech.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const s of speech) { const l = merged.at(-1); if (l && s[0] <= l[1] + 0.6) l[1] = Math.max(l[1], s[1]); else merged.push([...s]); }
    const v0 = c.volume, v1 = c.volume * 0.25, end = len(c), pts = [{ t: 0, v: v0 }];
    for (const [a, b] of merged) {
      const s = a - c.start, e = b - c.start;
      if (e > 0 && s < end) pts.push({ t: Math.max(0, s - 0.3), v: v0 }, { t: Math.max(0, s), v: v1 }, { t: Math.min(end, e), v: v1 }, { t: Math.min(end, e + 0.5), v: v0 });
    }
    change(() => { c.vkf = pts.sort((p, q) => p.t - q.t).filter((p, i, arr) => i === 0 || p.t > arr[i - 1].t + 1e-3); });
    toast(`Music ducks under ${merged.length} speech passage${merged.length === 1 ? '' : 's'}`);
  } catch (e) { setStatus(e.message); }
}
async function smoothSlowmo(c) { // interpolated frames for slow clips (rendered copy of just this range)
  const factor = clamp(Math.round(1 / c.speed), 2, 8);
  try {
    const j = await job('/api/slowmo', { media: c.media, t0: c.in, t1: c.out, factor }, 'Interpolating frames');
    await loadMedia();
    change(() => { const d = c.out - c.in; c.media = j.media; c.in = 0; c.out = Math.min(d, M.get(j.media).duration); });
    toast(`Smooth slow-mo: ${factor}× frames`);
  } catch (e) { setStatus(e.message); }
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
  for (const L of LANES) for (const c of p[L.key]) {
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
let rec = null;
async function toggleRecord() { // voiceover from the mic while the timeline plays (muted, so it doesn't bleed in)
  const btn = $('#btnRec');
  if (rec) return rec.stop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }), chunks = [], t0 = S.t, mr = new MediaRecorder(stream);
    mr.ondataavailable = e => chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach(tr => tr.stop());
      rec = null; S.recMute = false; btn.textContent = 'Record voiceover (mic)';
      if (S.playing) pause();
      try { const m = await uploadOne(new File(chunks, `Recording ${new Date().toLocaleTimeString().replace(/:/g, '.')}.webm`, { type: mr.mimeType })); addMedia(m.id, 'audio', t0); }
      catch (e) { toast(e.message); }
    };
    mr.start();
    rec = mr; S.recMute = true; btn.textContent = 'Stop recording';
    play();
  } catch (e) { toast(`Microphone: ${e.message}`); }
}
function startTrack(c, lane) { // pick a target on the main-track video; the clip then follows it via keyframes
  packMain();
  const host = P.main.find(x => S.t >= x.start && S.t < x.start + tdur(x, 'main'));
  if (!host || M.get(host.media)?.kind !== 'video') return toast('Move the playhead to where the thing to follow is visible on a main-track video');
  if (S.playing) pause();
  S.pick = { c, lane, host };
  toast('Drag a box around what this clip should follow');
}
async function finishTrack(rect) { // rect in project canvas units
  const { c, lane, host } = S.pick, m = M.get(host.media), t0 = S.t;
  S.pick = null;
  const g = geom(m, host, P.w, P.h, propsAt(host, t0 - host.start)), cr = host.crop || {}, fx = 1 - (cr.l || 0) - (cr.r || 0), fy = 1 - (cr.t || 0) - (cr.b || 0);
  const toSrc = (cx, cy) => { let u = (cx - g.x) / g.w; if (host.flip) u = 1 - u; return [(cr.l || 0) + u * fx, (cr.t || 0) + ((cy - g.y) / g.h) * fy]; };
  const toCanvas = (sx, sy) => { let u = (sx - (cr.l || 0)) / fx; if (host.flip) u = 1 - u; return [(g.x + u * g.w) / P.w, (g.y + ((sy - (cr.t || 0)) / fy) * g.h) / P.h]; };
  const [sx, sy] = toSrc(rect.x, rect.y), [ex, ey] = toSrc(rect.x + rect.w, rect.y + rect.h);
  const end = Math.min(host.start + tdur(host, 'main'), c.start + tdur(c, lane));
  try {
    const j = await job('/api/track', { media: host.media, t0: host.in + (t0 - host.start) * host.speed, t1: host.in + (end - host.start) * host.speed,
      box: { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) } }, 'Tracking');
    const pts = j.points.map(p => ({ T: host.start + (p.t - host.in) / host.speed, q: toCanvas(p.x + p.w / 2, p.y + p.h / 2) })).filter(p => p.T >= c.start && p.T <= end);
    if (pts.length < 2) throw new Error('Lost the target right away; try a bigger, higher-contrast box');
    const base = propsAt(c, pts[0].T - c.start), q0 = pts[0].q, step = Math.max(1, Math.round(pts.length / 400));
    change(() => {
      c.kf = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => ({ t: p.T - c.start, scale: base.scale, opacity: base.opacity, x: base.x + p.q[0] - q0[0], y: base.y + p.q[1] - q0[1] }));
    });
    toast(`Tracked ${pts.length} frames${j.lost ? ' (target lost before the end)' : ''}`);
  } catch (e) { toast(e.message); }
}

async function autoCaptions() { // words come back in source time; map them through each clip's in/out/speed
  const lang = $('#capLang').value, per = +$('#capWords').value, status = $('#capStatus'), btn = $('#btnCaptions');
  packMain();
  const src = [...P.main, ...($('#capAudio').checked ? P.audio : [])].filter(c => M.get(c.media)?.hasAudio && c.volume > 0);
  if (!src.length) return toast('Add a clip with speech to the main or audio track first');
  btn.disabled = true;
  try {
    const ids = [...new Set(src.map(c => c.media))], words = new Map();
    for (const [i, id] of ids.entries()) {
      status.textContent = `Transcribing ${i + 1}/${ids.length}: ${M.get(id).name}…`;
      words.set(id, (await api('/api/transcribe', { media: id, lang })).words);
    }
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
    change(() => { P.captions = caps; S.sel = null; });
    status.textContent = caps.length ? `${caps.length} captions from ${all.length} words. Click one to edit it.` : 'No speech found.';
  } catch (e) { status.textContent = e.message; }
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
  S.dirty = true;
  clearTimeout(loadMedia.t);
  if (list.some(m => !m.ready)) loadMedia.t = setTimeout(loadMedia, 1500);
}
function importFiles(files) {
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
  const k = w / P.w, D = total();
  const clip = async (c, lane, i) => {
    const m = M.get(c.media);
    if (!m) throw new Error('a clip points at missing media; delete it first');
    const o = { media: c.media, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, frames: frames(c), fadeIn: c.fadeIn, fadeOut: c.fadeOut,
      fit: c.fit, opacity: c.opacity, adj: c.adj, crop: c.crop, flip: c.flip, denoise: c.denoise, look: lookMatrix(c), key: c.key, angle: c.rot ?? 0 };
    if (m.kind !== 'audio') {
      const g = geom(m, c, P.w, P.h);
      o.geom = { x: g.x * k, y: g.y * k, w: g.w * k, h: g.h * k };
      // keyframes as export-pixel width + top-left: those interpolate exactly like scale/x/y do (same easing)
      if (c.kf?.length) o.kf = c.kf.map(f => { const q = geom(m, c, P.w, P.h, f); return { t: f.t, w: q.w * k, x: q.x * k, y: q.y * k, op: f.opacity ?? 1, a: f.rot ?? 0, e: (f.ease ?? c.ease) ? 1 : 0 }; });
      if (c.mask) o.mask = await maskPNG(c, m);
    }
    if (lane === 'main' && trF(i)) o.tr = { type: c.tr.type, frames: trF(i) };
    if (c.vkf?.length) o.vkf = c.vkf;
    if ((lane === 'main' || lane === 'overlay') && P.mute.main && lane === 'main') { o.volume = 0; delete o.vkf; } // muted main track
    return o;
  };
  const items = ['text', 'captions'].filter(l => !P.mute[l]).flatMap(l => P[l].map(it => [l, it]));
  let text = null;
  if (items.length) { // one PNG per interval in which the visible text doesn't change
    await Promise.all([...new Set(items.map(([l, it]) => { const s = textStyle(it, l); return `${s.weight} 40px "${s.font}"`; }))].map(f => document.fonts.load(f)));
    const cuts = new Set([0, D]);
    for (const [l, it] of items) {
      const st = textStyle(it, l), end = it.start + it.dur;
      cuts.add(it.start); cuts.add(end);
      if (it.words) for (const wd of it.words) cuts.add(it.start + wd.s);
      const spans = [st.anim && st.anim !== 'none' ? [it.start, it.start + ANIM_T] : null, l !== 'captions' && it.kf?.length > 1 ? [it.start + it.kf[0].t, it.start + it.kf.at(-1).t] : null,
        st.out && st.out !== 'none' ? [end - ANIM_T, end] : null, st.loop && st.loop !== 'none' ? [it.start, end] : null];
      for (const [a, b] of spans.filter(Boolean)) for (let t = a; t < Math.min(b, end); t += 1 / P.fps) cuts.add(t); // animated: one PNG per frame
    }
    const ts = [...cuts].filter(t => t >= 0 && t <= D).sort((a, b) => a - b);
    const cv = new OffscreenCanvas(w, h), ctx = cv.getContext('2d'), pngs = [], seen = new Map(), spans = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i], b = ts[i + 1];
      if (b - a < 1e-4) continue;
      ctx.clearRect(0, 0, w, h);
      drawTexts(ctx, a + 1e-4, k, false); // state at the interval start = what the preview shows on that frame
      const url = await blobURL(await cv.convertToBlob({ type: 'image/png' }));
      let idx = seen.get(url);
      if (idx === undefined) { idx = pngs.push(url) - 1; seen.set(url, idx); }
      const last = spans.at(-1);
      if (last && last.i === idx) last.end = b; else spans.push({ i: idx, start: a, end: b });
    }
    if (spans.length) spans[0].start = 0;
    text = { pngs, frames: spans };
  }
  return { w, h, fps: P.fps, duration: D, bg: P.bg, quality, name, loud, text, format, still: S.t,
    main: await Promise.all(P.main.map((c, i) => clip(c, 'main', i))), overlay: P.mute.overlay ? [] : await Promise.all(P.overlay.map(c => clip(c, 'overlay'))),
    audio: P.mute.audio ? [] : await Promise.all(P.audio.map(c => clip(c, 'audio'))) };
}
function openExport() {
  if (total() <= 0) return toast('Add something to the timeline first');
  modal(`<h2>Export</h2>
    <label class="row"><span>File name</span><input id="exName" value="${esc(P.name)}"></label>
    <label class="row"><span>Resolution</span><select id="exRes">${exportSizes().map(([l, w, h], i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${l} · ${w}×${h}</option>`).join('')}</select></label>
    <label class="row"><span>Encoder</span><select id="exQ"><option value="fast">Fast (Apple hardware)</option><option value="best">Best quality (x264, slower)</option></select></label>
    <label class="row chk"><span>Loudness −14 LUFS</span><input id="exLoud" type="checkbox"></label>
    <label class="row"><span>Format</span><select id="exFmt">${FORMATS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
    <p class="muted">MP4 (H.264 + AAC) · ${P.fps} fps · ${tc(total())}</p>
    <div class="progress" hidden><div></div></div><p id="exStatus" class="muted"></p>
    <div class="actions" id="exActions"><button data-close>Close</button><button id="exGo" class="primary">Export</button></div>`);
}
async function runExport() {
  const go = $('#exGo'), st = $('#exStatus'), bar = $('.dialog .progress');
  const [, w, h] = exportSizes()[+$('#exRes').value];
  go.disabled = true; S.exporting = true; bar.hidden = false;
  st.textContent = 'Rendering text layer…';
  try {
    const plan = await buildPlan(w, h, $('#exQ').value, $('#exName').value.trim() || P.name, $('#exLoud').checked, $('#exFmt').value);
    const { job } = await api('/api/export', plan);
    for (;;) {
      await new Promise(r => setTimeout(r, 400));
      const j = await api(`/api/jobs/${job}`);
      bar.firstElementChild.style.width = `${Math.round((j.progress || 0) * 100)}%`;
      if (j.state === 'done') {
        st.innerHTML = `Saved <b>${esc(j.file)}</b> in Movies/Cutroom/exports`;
        $('#exActions').insertAdjacentHTML('afterbegin', `<button data-reveal="${esc(j.file)}">Show in Finder</button><button data-play="${esc(j.file)}">Play</button>`);
        break;
      }
      if (j.state !== 'running') throw new Error((j.error || 'export failed').slice(-300));
      st.textContent = `Rendering… ${Math.round(j.progress * 100)}%`;
    }
  } catch (e) { st.textContent = `Export failed: ${e.message}`; }
  finally { go.disabled = false; S.exporting = false; }
}

// ---------- projects ----------
function migrate(p) {
  return { fps: 30, bg: '#000000', main: [], overlay: [], audio: [], text: [], captions: [], markers: [], ...p,
    mute: { main: false, overlay: false, audio: false, text: false, captions: false, ...(p.mute || {}) }, capStyle: { ...CAP_PRESETS.Bold, y: 0.72, ...(p.capStyle || {}) } };
}
function newProject(ratio = '9:16') { const [w, h] = RATIOS[ratio]; return migrate({ id: hex12(), name: `Untitled ${new Date().toLocaleDateString()}`, w, h }); }
function setProject(p) {
  if (S.playing) pause();
  P = migrate(p); undo = []; redo = []; S.sel = null; S.t = 0;
  for (const v of pool.values()) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
  pool.clear();
  store.set('cutroom.last', P.id);
  fitStage(); renderAll();
}
async function openProject(id) { setProject(await api(`/api/projects/${id}`)); }
async function openProjects() {
  const list = await api('/api/projects').catch(() => []);
  modal(`<h2>Projects</h2><div class="newp">${Object.keys(RATIOS).map(r => `<button data-new="${r}">New ${r}</button>`).join('')}</div>
    <div class="plist">${list.map(p => `<div class="prow"><button class="pitem${p.id === P?.id ? ' on' : ''}" data-open="${p.id}"><b>${esc(p.name)}</b><span>${p.w}×${p.h} · ${p.clips} clips · ${new Date(p.updated * 1000).toLocaleString()}</span></button><button class="pdel" data-dup="${p.id}" aria-label="Duplicate ${esc(p.name)}">Duplicate</button><button class="pdel" data-trash="${p.id}" data-name="${esc(p.name)}" aria-label="Delete ${esc(p.name)}">Delete</button></div>`).join('') || '<p class="hint">No saved projects yet.</p>'}</div>
    <div class="actions"><button data-close>Close</button></div>`);
}

async function trashProject(id, name) { // reversible: the server moves it to Movies/Cutroom/trash
  if (!confirm(`Delete "${name}"? It moves to Movies/Cutroom/trash, so it can be recovered.`)) return;
  if (id === P?.id) clearTimeout(saveTimer);
  await api(`/api/projects/${id}/trash`, {});
  if (id === P?.id) { const list = await api('/api/projects'); if (list[0]) await openProject(list[0].id); else { setProject(newProject('9:16')); scheduleSave(); } }
  openProjects();
}
async function loadVoices() {
  const vs = await api('/api/voices').catch(() => []), pref = store.get('cutroom.voice') || 'Samantha';
  $('#ttsVoice').innerHTML = vs.map(v => `<option value="${esc(v.name)}"${v.name === pref ? ' selected' : ''}>${esc(v.name)} · ${v.lang}</option>`).join('');
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
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500); }
function modal(html) { const m = $('#modal'); m.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; $('button, input', m)?.focus(); }
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
function scrub(e) {
  if (S.playing) pause();
  if (!e.target.closest('.ruler') && S.sel) { S.sel = null; renderInspector(); $$('.clip.sel').forEach(x => x.classList.remove('sel')); }
  const left = $('#tlInner').getBoundingClientRect().left;
  const set = ev => { S.t = snap(clamp((ev.clientX - left) / S.pps, 0, total())); placePlayhead(); S.dirty = true; };
  set(e);
  const up = () => { removeEventListener('pointermove', set); removeEventListener('pointerup', up); if (selClip()) renderInspector(); };
  addEventListener('pointermove', set);
  addEventListener('pointerup', up);
}
function drag(e, lane, c, el) {
  const before = JSON.stringify(P), x0 = e.clientX, o = structuredClone(c), m = M.get(c.media);
  const r = el.getBoundingClientRect(), edge = Math.min(8, r.width / 3);
  const mode = e.clientX - r.left < edge ? 'l' : r.right - e.clientX < edge ? 'r' : 'move';
  const minD = 1 / P.fps, sp = c.speed || 1, maxOut = m && m.kind !== 'image' ? m.duration : Infinity;
  let moved = false;
  if (S.playing) pause();
  const move = ev => {
    const dx = ev.clientX - x0, dt = dx / S.pps;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    if (mode === 'move' && lane === 'main') { el.style.transform = `translateX(${dx}px)`; el.style.zIndex = 3; return; } // reorder on drop
    if (mode === 'r') {
      if (c.media) c.out = clamp(o.out + dt * sp, o.in + minD * sp, maxOut); else c.dur = Math.max(minD, o.dur + dt);
      const [t1, dd] = magnet(c.start + len(c), c);
      if (dd < Infinity) { if (c.media) c.out = clamp(c.in + (t1 - c.start) * sp, c.in + minD * sp, maxOut); else c.dur = Math.max(minD, t1 - c.start); }
    } else if (mode === 'l') {
      let d = lane === 'main' ? dt : Math.max(dt, -o.start);
      if (lane !== 'main') { const [t1, dd] = magnet(o.start + d, c); if (dd < Infinity) d = t1 - o.start; }
      if (!c.media) { d = Math.min(d, o.dur - minD); c.start = o.start + d; c.dur = o.dur - d; }
      else if (m?.kind === 'image') { d = Math.min(d, len(o) - minD); c.out = o.out - d; if (lane !== 'main') c.start = o.start + d; }
      else { d = clamp(d, -o.in / sp, len(o) - minD); c.in = o.in + d * sp; if (lane !== 'main') c.start = o.start + d; }
    } else c.start = snapTo(Math.max(0, o.start + dt), c, lane);
    S.dirty = true;
    renderTimeline();
  };
  const up = ev => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (moved && mode === 'move' && lane === 'main') {
      const mid = o.start + (ev.clientX - x0) / S.pps + tdur(c, 'main') / 2, rest = P.main.filter(x => x !== c);
      rest.splice(rest.filter(x => x.start + tdur(x, 'main') / 2 < mid).length, 0, c);
      P.main = rest;
    }
    if (moved && JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); } else renderTimeline();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function setZoom(pps, anchorX) {
  const sc = $('#tlScroll'), x = anchorX ?? sc.clientWidth / 2, t = (sc.scrollLeft + x) / S.pps;
  S.pps = clamp(pps, 8, 600);
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
  $('#textPresets').innerHTML = Object.entries(TEXT_PRESETS).map(([n, s]) => `<button data-addtext="${n}" style="font-family:'${s.font}';font-weight:${s.weight};color:${s.color || '#fff'}">${n}</button>`).join('');
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
  $('#btnPauses').addEventListener('click', removePauses);
  $('#btnCaptions').addEventListener('click', autoCaptions);
  $('#btnExport').addEventListener('click', openExport);
  $('#btnProjects').addEventListener('click', openProjects);
  $('#btnTts').addEventListener('click', addVoiceover);
  $('#btnRec').addEventListener('click', toggleRecord);
  $('#btnTemplates').addEventListener('click', openTemplates);
  $('#heads').addEventListener('click', e => { const b = e.target.closest('[data-lt]'); if (b) change(() => { P.mute[b.dataset.lt] = !P.mute[b.dataset.lt]; }); });
  $('#projName').addEventListener('change', e => change(() => { P.name = e.target.value.trim() || 'Untitled'; }));
  $('#zoom').addEventListener('input', e => setZoom(8 * 2 ** +e.target.value));
  $('#fileInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  $('#textPresets').addEventListener('click', e => { const b = e.target.closest('[data-addtext]'); if (b) addText(b.dataset.addtext); });
  $('#capPresets').addEventListener('click', e => {
    const b = e.target.closest('[data-cap]');
    if (b) { change(() => { P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS[b.dataset.cap], y: P.capStyle.y }; }); toast(`Caption style: ${b.dataset.cap}`); }
  });
  $('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.pane').forEach(p => p.classList.toggle('on', p.id === `tab-${b.dataset.tab}`));
  });

  $('#mediaList').addEventListener('click', async e => {
    const b = e.target.closest('[data-add]'), rm = e.target.closest('[data-rm]');
    if (b) return addMedia(b.dataset.add);
    if (!rm) return;
    const m = M.get(rm.dataset.rm), used = LANES.some(L => P[L.key].some(c => c.media === m.id));
    if (used) return toast(`"${m.name}" is used in this project; delete those clips first`);
    if (!confirm(`Remove "${m.name}" from the library? It moves to Movies/Cutroom/trash.`)) return;
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
    addMedia(id, e.target.closest('.lane')?.dataset.lane, Math.max(0, (e.clientX - $('#tlInner').getBoundingClientRect().left) / S.pps));
  });
  addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', e => { document.body.classList.remove('dropping'); if (e.dataTransfer.files.length) { e.preventDefault(); importFiles(e.dataTransfer.files); } });

  $('#tlInner').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !P) return;
    const th = e.target.closest('.trh');
    if (th) { S.sel = { lane: 'tr', id: th.dataset.trFor }; renderAll(); S.dirty = true; return; }
    const el = e.target.closest('.clip');
    if (!el) return scrub(e);
    const lane = el.dataset.lane, c = P[lane].find(x => x.id === el.dataset.id);
    if (!c) return;
    if (S.sel?.id !== c.id) { S.sel = { lane, id: c.id }; renderInspector(); $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); S.dirty = true; }
    drag(e, lane, c, el);
  });
  $('#tlScroll').addEventListener('wheel', e => {
    const sc = $('#tlScroll');
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.pps * Math.exp(-e.deltaY * 0.003), e.clientX - sc.getBoundingClientRect().left); }
    else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); sc.scrollLeft += e.deltaY; }
  }, { passive: false });

  $('#cv').addEventListener('pointerdown', e => { // select and drag things directly on the preview
    if (!P) return;
    const cv = $('#cv'), r = cv.getBoundingClientRect(), px = cv.width / r.width;
    const x = (e.clientX - r.left) * px, y = (e.clientY - r.top) * px;
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
        if (R && R.w > 8 && R.h > 8) finishTrack(R); else { S.pick = null; toast('Tracking cancelled'); }
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', upp);
      return;
    }
    const hit = [...hits].reverse().find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    if (!hit) { if (S.sel) { S.sel = null; renderAll(); S.dirty = true; } return; }
    if (S.sel?.id !== hit.id) { S.sel = { lane: hit.lane, id: hit.id }; renderAll(); S.dirty = true; }
    const c = selClip();
    if (!c) return;
    const before = JSON.stringify(P), k = cv.width / P.w, x0 = e.clientX, y0 = e.clientY;
    const o = hit.lane === 'captions' ? { y: P.capStyle.y } : propsAt(c, S.t - c.start);
    const move = ev => {
      const dx = ((ev.clientX - x0) * px) / k / P.w, dy = ((ev.clientY - y0) * px) / k / P.h;
      if (hit.lane === 'captions') P.capStyle.y = clamp(o.y + dy, 0, 1);
      else { const lim = v => (c.media ? v : clamp(v, 0, 1)); setProp(c, 'x', lim(o.x + dx)); setProp(c, 'y', lim(o.y + dy)); }
      S.dirty = true;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (JSON.stringify(P) !== before) { undo.push(before); redo = []; touched(); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  const insp = $('#inspector');
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
    if (!e.target.dataset.k) return;
    if (pending) { undo.push(pending); redo = []; pending = null; }
    renderTimeline();
    if (selClip()?.kf || e.target.dataset.k === 'c.tr.d') renderInspector(); // keyframe buttons / effective duration
  });
  insp.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = selClip(), d = b.dataset;
    if (d.itab) {
      S.itab = d.itab;
      $$('#inspector .itabs button').forEach(x => x.classList.toggle('on', x === b));
      $$('#inspector .isec').forEach(x => x.classList.toggle('on', x.dataset.sec === d.itab));
    } else if (d.ratio) { change(() => { [P.w, P.h] = RATIOS[d.ratio]; }); fitStage(); }
    else if (d.fit) change(() => { c.fit = d.fit; });
    else if (d.cappreset) change(() => { P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS[d.cappreset], y: P.capStyle.y }; });
    else if (d.textpreset) change(() => { c.style = { ...TEXT_PRESETS[d.textpreset] }; });
    else if (d.act === 'split') split();
    else if (d.act === 'delete') del();
    else if (d.act === 'dup') dup();
    else if (d.act === 'reset') change(() => { Object.assign(c, { speed: 1, volume: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 }, flip: false, denoise: false, rot: 0, ease: false }); delete c.kf; delete c.look; delete c.crop; delete c.key; delete c.mask; });
    else if (d.act === 'clearcaps') change(() => { P.captions = []; S.sel = null; });
    else if (d.tr) change(() => { if (d.tr === 'none') delete c.tr; else c.tr = { type: d.tr, d: c.tr?.d ?? 0.5 }; });
    else if (d.act === 'trall') change(() => { for (const x of P.main.slice(0, -1)) { if (c.tr) x.tr = { ...c.tr }; else delete x.tr; } });
    else if (d.look) change(() => { if (d.look === 'none') delete c.look; else c.look = { name: d.look, amount: c.look?.amount ?? 1 }; });
    else if (['kfadd', 'kfdel', 'kfclear'].includes(d.act)) kfOp(c, S.sel.lane, d.act.slice(2));
    else if (d.act === 'beats') detectBeats(c);
    else if (d.act === 'beatsync') beatSync(c, +$('#beatEvery').value);
    else if (d.act === 'freeze') freeze(c, S.sel.lane);
    else if (d.act === 'movelane') moveLane(c, S.sel.lane);
    else if (d.act === 'matte') removeBackground(c);
    else if (d.act === 'track') startTrack(c, S.sel.lane);
    else if (d.mask) change(() => { if (d.mask === 'none') delete c.mask; else c.mask = { x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 0.04, invert: false, ...c.mask, type: d.mask }; });
    else if (d.act === 'ramp') ramp(c, S.sel.lane, $('#rampSel').value);
    else if (d.act === 'detach') detachAudio(c);
    else if (d.act === 'reverse' || d.act === 'stabilize') remake(c, d.act);
    else if (d.act === 'reframe') autoReframe(c);
    else if (d.act === 'kfease') change(() => { const f = c.kf.find(x => Math.abs(x.t - (S.t - c.start)) < 0.5 / P.fps); if (f) f.ease = !(f.ease ?? c.ease); });
    else if (d.act === 'duck') autoDuck(c);
    else if (d.act === 'vkfclear') change(() => { delete c.vkf; });
    else if (d.act === 'slowmo') smoothSlowmo(c);
    else if (d.act === 'keyon') change(() => { c.key = { color: '#00ff00', sim: 0.3, blend: 0.1 }; });
    else if (d.act === 'keyoff') change(() => { delete c.key; });
  });

  $('#modal').addEventListener('click', async e => {
    if (e.target.id === 'modal') { if (!S.exporting) closeModal(); return; }
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if ('close' in d) closeModal();
    else if (d.new) { setProject(newProject(d.new)); scheduleSave(); closeModal(); }
    else if (d.open) { await openProject(d.open).catch(err => toast(err.message)); closeModal(); }
    else if (b.id === 'exGo') runExport();
    else if (d.trash) trashProject(d.trash, d.name).catch(err => toast(err.message));
    else if (d.dup) { const p = await api(`/api/projects/${d.dup}`); p.id = hex12(); p.name = `${p.name} (copy)`; await api(`/api/projects/${p.id}`, p, 'PUT'); openProjects(); }
    else if ('savetpl' in d) { await saveTemplate(); openTemplates(); }
    else if (d.tpl) showTemplate(d.tpl);
    else if (d.usetpl) useTemplate(d.usetpl);
    else if (d.deltpl) { if (confirm('Delete this template? It moves to Movies/Cutroom/trash.')) { await api(`/api/templates/${d.deltpl}/trash`, {}); openTemplates(); } }
    else if (d.reveal) api('/api/reveal', { file: d.reveal }).catch(err => toast(err.message));
    else if (d.play) open(`/exports/${encodeURIComponent(d.play)}`, '_blank', 'noopener');
  });

  addEventListener('keydown', e => {
    if (!P) return;
    if (!$('#modal').hidden) { if (e.key === 'Escape' && !S.exporting) closeModal(); return; }
    if (e.target.matches('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=color])')) return;
    const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); if (S.playing) pause(); else play(); }
    else if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) restore(redo, undo); else restore(undo, redo); }
    else if (mod && key === 'd') { e.preventDefault(); dup(); }
    else if ((mod && key === 'b') || (!mod && key === 's')) { e.preventDefault(); split(); }
    else if (!mod && key === 'm') { e.preventDefault(); toggleMarker(); }
    else if (key === 'backspace' || key === 'delete') { e.preventDefault(); del(); }
    else if (key === 'arrowleft' || key === 'arrowright') { e.preventDefault(); seekTo(S.t + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / P.fps)); }
    else if (key === 'home' || key === 'end') { e.preventDefault(); seekTo(key === 'home' ? 0 : total()); }
    else if (key === 'escape' && S.pick) { S.pick = null; toast('Tracking cancelled'); }
    else if (key === 'escape' && S.sel) { S.sel = null; renderAll(); S.dirty = true; }
  });
  new ResizeObserver(fitStage).observe($('#stage'));
  addEventListener('resize', () => renderTimeline());
  document.fonts.addEventListener('loadingdone', () => { S.dirty = true; });
}

(async function boot() {
  wire();
  try {
    await loadMedia();
    const list = await api('/api/projects'), last = store.get('cutroom.last');
    const id = (list.find(p => p.id === last) || list[0])?.id;
    if (id) await openProject(id);
    else { setProject(newProject('9:16')); scheduleSave(); }
    loadVoices();
    const ping = await api('/api/ping');
    if (!ping.whisper) $('#capStatus').textContent = 'Captions need whisper.cpp: brew install whisper-cpp';
  } catch (e) { toast(`Cannot reach the Cutroom server: ${e.message}`); }
  requestAnimationFrame(frame);
})();
