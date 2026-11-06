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
};
const CAP_PRESETS = {
  Bold: { font: 'Montserrat', weight: 900, size: 78, color: '#ffffff', stroke: '#000000', strokeW: 7, hl: '#ffd400', upper: true, pop: true },
  Clean: { font: 'Poppins', weight: 800, size: 62, color: '#ffffff', strokeW: 0, hl: '#ffffff', shadow: true },
  Boxed: { font: 'Montserrat', weight: 800, size: 58, color: '#ffffff', strokeW: 0, hl: '#ff7a45', box: true, boxAlpha: 0.75 },
  Neon: { font: 'Anton', weight: 400, size: 96, color: '#ffffff', stroke: '#000000', strokeW: 6, hl: '#3dff8b', upper: true, pop: true },
};
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>',
};

let P = null;                        // current project
const M = new Map();                 // media id -> server metadata
const S = { sel: null, t: 0, playing: false, pps: 60, dirty: true, t0: 0, wall0: 0, end: 0, exporting: false };
let undo = [], redo = [], pending = null, saveTimer = 0, hits = [];
const uploads = [], pool = new Map(), imgs = new Map();

// ---------- time ----------
const len = c => c.dur ?? (c.out - c.in) / c.speed;
const frames = c => Math.max(1, Math.round(len(c) * P.fps));
const tdur = (c, lane) => (lane === 'main' ? frames(c) / P.fps : len(c)); // main clips snap to whole frames, like the export
function packMain() { let f = 0; for (const c of P.main) { c.start = f / P.fps; f += frames(c); } return f / P.fps; }
function total() { packMain(); let t = 0; for (const L of LANES) for (const c of P[L.key]) t = Math.max(t, c.start + tdur(c, L.key)); return t; }
const snap = t => Math.round(t * P.fps) / P.fps;
function tc(t) { const fps = Math.round(P.fps), f = Math.round(t * P.fps), s = Math.floor(f / fps); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f % fps).padStart(2, '0')}`; }
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function geom(m, c, W, H) { // media rect on the canvas: fit/fill, then user scale and offset (fractions of canvas)
  const s = (c.fit === 'fill' ? Math.max(W / m.w, H / m.h) : Math.min(W / m.w, H / m.h)) * (c.scale ?? 1);
  const w = m.w * s, h = m.h * s;
  return { x: (W - w) / 2 + (c.x ?? 0) * W, y: (H - h) / 2 + (c.y ?? 0) * H, w, h };
}

// ---------- history + save ----------
const selClip = () => S.sel && P[S.sel.lane]?.find(c => c.id === S.sel.id);
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
  const r = $('#ruler');
  r.innerHTML = ruler;
  r.style.setProperty('--minor', `${(step * pps) / 5}px`);
  for (const L of LANES) $(`#lane-${L.key}`).innerHTML = P[L.key].map(c => clipHTML(L.key, c)).join('');
  placePlayhead();
}

function clipHTML(lane, c) {
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
  return `<div class="clip ${lane}${S.sel?.id === c.id ? ' sel' : ''}" data-lane="${lane}" data-id="${c.id}" style="left:${c.start * pps}px;width:${Math.max(3, tdur(c, lane) * pps)}px;${bg}"><span class="lbl">${esc(label)}</span><i class="h l"></i><i class="h r"></i></div>`;
}

function placePlayhead() { $('#playhead').style.transform = `translateX(${S.t * S.pps}px)`; }
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
      <button class="add" data-add="${m.id}" title="Add to timeline" aria-label="Add ${esc(m.name)} to timeline">+</button></div>`).join('');
  $('#mediaList').innerHTML = up + items || '<p class="hint">Nothing imported yet.</p>';
}

// ---------- inspector ----------
const fmt = (v, unit) => (unit === '%' ? `${Math.round(v * 100)}%` : unit === 's' ? `${(+v).toFixed(2)}s` : `${Math.round(v * 10) / 10}`);
const slider = (k, label, v, min, max, step, unit = '') => `<label class="row"><span>${label}</span><input type="range" data-k="${k}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${fmt(v, unit)}</output></label>`;
const pick = (k, label, v, opts) => `<label class="row"><span>${label}</span><select data-k="${k}"${typeof opts[0][0] === 'number' ? ' data-num' : ''}>${opts.map(([val, txt]) => `<option value="${val}"${String(val) === String(v) ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select></label>`;
const colour = (k, label, v) => `<label class="row"><span>${label}</span><input type="color" data-k="${k}" value="${v}"></label>`;
const tick = (k, label, v) => `<label class="row chk"><span>${label}</span><input type="checkbox" data-k="${k}"${v ? ' checked' : ''}></label>`;
const segs = (attr, label, v, opts) => `<div class="row"><span>${label}</span><div class="seg">${opts.map(([val, txt]) => `<button data-${attr}="${val}" class="${val === v ? 'on' : ''}">${txt}</button>`).join('')}</div></div>`;

function renderInspector() {
  const c = selClip();
  pending = null;
  $('#inspector').innerHTML = !c ? projectPanel() : c.media ? mediaPanel(c, S.sel.lane) : textPanel(c, S.sel.lane);
}
function projectPanel() {
  const ratio = Object.keys(RATIOS).find(r => RATIOS[r][0] === P.w && RATIOS[r][1] === P.h);
  return `<h3>Project</h3><p class="muted">${P.w}×${P.h} · ${tc(total())}</p>
    ${segs('ratio', 'Canvas', ratio, Object.keys(RATIOS).map(r => [r, r]))}
    ${pick('p.fps', 'Frame rate', P.fps, [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']])}
    ${colour('p.bg', 'Background', P.bg)}
    <h4>Shortcuts</h4><p class="hint">Space play · S split · ⌫ delete · ⌘D duplicate · ←/→ one frame (⇧ one second) · ⌘Z / ⇧⌘Z · ⌘+scroll zooms the timeline</p>`;
}
function mediaPanel(c, lane) {
  const m = M.get(c.media);
  if (!m) return '<h3>Missing media</h3><div class="actions"><button data-act="delete">Delete</button></div>';
  let h = `<h3>${esc(m.name)}</h3><p class="muted">${lane} track · ${tc(tdur(c, lane))}${m.kind === 'image' ? '' : ` of ${tc(m.duration)}`}</p>`;
  if (m.kind !== 'image') h += pick('c.speed', 'Speed', c.speed, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(s => [s, `${s}×`]));
  if (m.hasAudio) h += slider('c.volume', 'Volume', c.volume, 0, 2, 0.01, '%');
  if (m.kind !== 'audio') {
    h += segs('fit', 'Fit', c.fit, [['fit', 'Fit'], ['fill', 'Fill'], ...(lane === 'main' ? [['blur', 'Blur bg']] : [])]);
    h += slider('c.scale', 'Scale', c.scale, 0.1, 4, 0.01, '%') + slider('c.x', 'Position X', c.x, -1, 1, 0.005, '%') + slider('c.y', 'Position Y', c.y, -1, 1, 0.005, '%');
    if (lane === 'overlay') h += slider('c.opacity', 'Opacity', c.opacity, 0, 1, 0.01, '%');
    h += `<h4>Adjust</h4>${slider('c.adj.b', 'Brightness', c.adj.b, 0, 2, 0.01, '%')}${slider('c.adj.c', 'Contrast', c.adj.c, 0, 2, 0.01, '%')}${slider('c.adj.s', 'Saturation', c.adj.s, 0, 3, 0.01, '%')}`;
  }
  h += `<h4>Fade</h4>${slider('c.fadeIn', 'Fade in', c.fadeIn, 0, 3, 0.05, 's')}${slider('c.fadeOut', 'Fade out', c.fadeOut, 0, 3, 0.05, 's')}`;
  return `${h}<div class="actions"><button data-act="split">Split</button><button data-act="dup">Duplicate</button><button data-act="reset">Reset</button><button data-act="delete">Delete</button></div>`;
}
function textPanel(c, lane) {
  const cap = lane === 'captions', st = textStyle(c, lane), r = cap ? 'cap' : 'c.style';
  let h = `<h3>${cap ? 'Caption' : 'Text'}</h3><textarea data-k="c.text" rows="3" spellcheck="false">${esc(c.text)}</textarea>`;
  h += cap
    ? `<p class="hint">Style edits apply to every caption.</p><div class="presets small">${Object.keys(CAP_PRESETS).map(n => `<button data-cappreset="${n}">${n}</button>`).join('')}</div>`
    : `<div class="presets small">${Object.keys(TEXT_PRESETS).map(n => `<button data-textpreset="${n}">${n}</button>`).join('')}</div>`;
  h += pick(`${r}.font`, 'Font', st.font, FONTS.map(f => [f, f])) + pick(`${r}.weight`, 'Weight', st.weight, [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']])
    + slider(`${r}.size`, 'Size', st.size, 16, 260, 1) + colour(`${r}.color`, 'Color', st.color)
    + slider(`${r}.strokeW`, 'Outline', st.strokeW, 0, 20, 0.5) + colour(`${r}.stroke`, 'Outline color', st.stroke)
    + tick(`${r}.shadow`, 'Shadow', st.shadow) + tick(`${r}.box`, 'Background', st.box)
    + colour(`${r}.boxColor`, 'Background color', st.boxColor) + slider(`${r}.boxAlpha`, 'Bg opacity', st.boxAlpha, 0, 1, 0.01, '%')
    + tick(`${r}.upper`, 'All caps', st.upper) + slider(`${r}.maxW`, 'Max width', st.maxW, 0.2, 1, 0.01, '%');
  h += cap
    ? colour('cap.hl', 'Highlight', st.hl) + tick('cap.pop', 'Pop active word', st.pop) + slider('cap.y', 'Position Y', P.capStyle.y, 0, 1, 0.005, '%')
    : slider('c.x', 'Position X', c.x, 0, 1, 0.005, '%') + slider('c.y', 'Position Y', c.y, 0, 1, 0.005, '%');
  return `${h}<div class="actions"><button data-act="split">Split</button>${cap ? '' : '<button data-act="dup">Duplicate</button>'}<button data-act="delete">Delete</button>${cap ? '<button data-act="clearcaps">Delete all captions</button>' : ''}</div>`;
}
function apply(el) { // data-k="c.adj.b" -> selected clip .adj.b ; "cap.size" -> caption style ; "p.fps" -> project
  const [root, ...path] = el.dataset.k.split('.'), last = path.pop();
  let o = root === 'c' ? selClip() : root === 'cap' ? P.capStyle : P;
  if (!o) return;
  for (const p of path) o = o[p] ??= {};
  o[last] = el.type === 'checkbox' ? el.checked : el.type === 'range' || 'num' in el.dataset ? +el.value : el.value;
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
function sync(v, src, rate, vol) { // the wall clock is the master; media elements follow it
  v.volume = clamp(vol, 0, 1);
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
  const mi = P.main.findIndex(c => t >= c.start && t < c.start + tdur(c, 'main'));
  const layers = [];
  if (mi >= 0) layers.push(['main', P.main[mi], `m${mi % 2}`]); // two elements alternate so the next cut is pre-seeked
  for (const c of P.overlay) if (t >= c.start && t < c.start + len(c)) layers.push(['overlay', c, `o${c.id}`]);
  for (const c of P.audio) if (t >= c.start && t < c.start + len(c)) layers.push(['audio', c, `a${c.id}`]);
  for (const [lane, c, key] of layers) {
    const m = M.get(c.media);
    if (!m) continue;
    let el;
    if (m.kind === 'image') el = imgFor(m);
    else { el = vidFor(key, m); live.add(el); sync(el, c.in + (t - c.start) * c.speed, c.speed, c.volume); }
    if (lane !== 'audio') drawMedia(ctx, lane, c, m, el, t - c.start, k);
  }
  const nx = mi >= 0 && P.main[mi + 1], nm = nx && M.get(nx.media);
  if (nm && nm.kind !== 'image' && nx.start - t < 1.5) {
    const v = vidFor(`m${(mi + 1) % 2}`, nm);
    if (!live.has(v)) { live.add(v); if (!v.paused) v.pause(); if (!v.seeking && Math.abs(v.currentTime - nx.in) > 0.04) v.currentTime = nx.in; }
  }
  for (const v of pool.values()) if (!live.has(v) && !v.paused) v.pause();
  drawTexts(ctx, t, k, true);
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
  const g = geom(m, c, P.w, P.h), d = tdur(c, lane), a = c.adj || {};
  const f = clamp(Math.min(c.fadeIn > 0 ? lt / c.fadeIn : 1, c.fadeOut > 0 ? (d - lt) / c.fadeOut : 1), 0, 1);
  const adj = a.b !== 1 || a.c !== 1 || a.s !== 1 ? `brightness(${a.b}) contrast(${a.c}) saturate(${a.s})` : ''; // same math as server adjust()
  ctx.save();
  if (lane === 'main' && c.fit === 'blur') {
    const s = Math.max(P.w / m.w, P.h / m.h) * 1.08;
    ctx.filter = `${adj} blur(${(P.w / 40) * k}px)`.trim();
    ctx.drawImage(el, ((P.w - m.w * s) / 2) * k, ((P.h - m.h * s) / 2) * k, m.w * s * k, m.h * s * k);
  }
  ctx.filter = adj || 'none';
  if (lane === 'overlay') ctx.globalAlpha = (c.opacity ?? 1) * f;
  ctx.drawImage(el, g.x * k, g.y * k, g.w * k, g.h * k);
  ctx.restore();
  if (lane === 'main' && f < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - f})`; ctx.fillRect(0, 0, P.w * k, P.h * k); } // ffmpeg fade = to black
  hits.push({ lane, id: c.id, x0: g.x * k, y0: g.y * k, x1: (g.x + g.w) * k, y1: (g.y + g.h) * k });
}
function textStyle(it, lane) { return { ...TEXT_BASE, ...(lane === 'captions' ? P.capStyle : it.style) }; }
function drawTexts(ctx, t, k, preview) {
  for (const lane of ['text', 'captions']) for (const it of P[lane]) if (t >= it.start && t < it.start + it.dur) drawText(ctx, it, lane, t - it.start, k, preview);
}
function drawText(ctx, it, lane, lt, k, preview) { // shared by preview and export: what you see is what renders
  const st = textStyle(it, lane), u = (Math.min(P.w, P.h) / 1080) * k, size = st.size * u;
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
  const lh = size * st.lh, x = (lane === 'captions' ? 0.5 : it.x) * P.w * k, y = (lane === 'captions' ? P.capStyle.y : it.y) * P.h * k;
  const top = y - (lines.length * lh) / 2, padX = size * 0.3;
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
    const c = { id: hex12(), start: S.t, dur: 3, text: name === 'Title' ? 'Your title' : 'Your text', style: { ...TEXT_PRESETS[name] }, x: 0.5, y: 0.42 };
    P.text.push(c);
    S.sel = { lane: 'text', id: c.id };
  });
}
function split() {
  packMain();
  const t = S.t, inside = (x, lane) => t > x.start + 1e-6 && t < x.start + tdur(x, lane) - 1e-6;
  let lane = S.sel?.lane, c = selClip();
  if (!c || !inside(c, lane)) { lane = 'main'; c = P.main.find(x => inside(x, 'main')); }
  if (!c) return toast('Put the playhead over a clip to split it');
  change(() => {
    const lt = t - c.start, b = structuredClone(c);
    b.id = hex12();
    b.start = t;
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
  change(() => { P[S.sel.lane] = P[S.sel.lane].filter(x => x !== c); S.sel = null; });
}
function dup() {
  const c = selClip(), lane = S.sel?.lane;
  if (!c) return;
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
      return parts.map(([a, b], i) => ({ ...structuredClone(c), id: i ? hex12() : c.id, in: a, out: b, fadeIn: i ? 0 : c.fadeIn, fadeOut: i === parts.length - 1 ? c.fadeOut : 0 }));
    });
    const before = total();
    if (JSON.stringify(next) === JSON.stringify(P.main)) return toast(`No pauses longer than ${min} s`);
    change(() => { P.main = next; });
    toast(`Removed ${(before - total()).toFixed(1)} s of pauses`);
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
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
async function buildPlan(w, h, quality, name) {
  const k = w / P.w, D = total();
  const clip = c => {
    const m = M.get(c.media);
    if (!m) throw new Error('a clip points at missing media; delete it first');
    const o = { media: c.media, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, frames: frames(c), fadeIn: c.fadeIn, fadeOut: c.fadeOut, fit: c.fit, opacity: c.opacity, adj: c.adj };
    if (m.kind !== 'audio') { const g = geom(m, c, P.w, P.h); o.geom = { x: g.x * k, y: g.y * k, w: g.w * k, h: g.h * k }; }
    return o;
  };
  const items = ['text', 'captions'].flatMap(l => P[l].map(it => [l, it]));
  let text = null;
  if (items.length) { // one PNG per interval in which the visible text doesn't change
    await Promise.all([...new Set(items.map(([l, it]) => { const s = textStyle(it, l); return `${s.weight} 40px "${s.font}"`; }))].map(f => document.fonts.load(f)));
    const cuts = new Set([0, D]);
    for (const [l, it] of items) {
      cuts.add(it.start); cuts.add(it.start + it.dur);
      if (it.words && textStyle(it, l).hl) for (const wd of it.words) cuts.add(it.start + wd.s);
    }
    const ts = [...cuts].filter(t => t >= 0 && t <= D).sort((a, b) => a - b);
    const cv = new OffscreenCanvas(w, h), ctx = cv.getContext('2d'), pngs = [], seen = new Map(), spans = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i], b = ts[i + 1];
      if (b - a < 1e-4) continue;
      ctx.clearRect(0, 0, w, h);
      drawTexts(ctx, (a + b) / 2, k, false);
      const url = await blobURL(await cv.convertToBlob({ type: 'image/png' }));
      let idx = seen.get(url);
      if (idx === undefined) { idx = pngs.push(url) - 1; seen.set(url, idx); }
      const last = spans.at(-1);
      if (last && last.i === idx) last.end = b; else spans.push({ i: idx, start: a, end: b });
    }
    if (spans.length) spans[0].start = 0;
    text = { pngs, frames: spans };
  }
  return { w, h, fps: P.fps, duration: D, bg: P.bg, quality, name, main: P.main.map(clip), overlay: P.overlay.map(clip), audio: P.audio.map(clip), text };
}
function openExport() {
  if (total() <= 0) return toast('Add something to the timeline first');
  modal(`<h2>Export</h2>
    <label class="row"><span>File name</span><input id="exName" value="${esc(P.name)}"></label>
    <label class="row"><span>Resolution</span><select id="exRes">${exportSizes().map(([l, w, h], i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${l} · ${w}×${h}</option>`).join('')}</select></label>
    <label class="row"><span>Encoder</span><select id="exQ"><option value="fast">Fast (Apple hardware)</option><option value="best">Best quality (x264, slower)</option></select></label>
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
    const plan = await buildPlan(w, h, $('#exQ').value, $('#exName').value.trim() || P.name);
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
function migrate(p) { return { fps: 30, bg: '#000000', main: [], overlay: [], audio: [], text: [], captions: [], ...p, capStyle: { ...CAP_PRESETS.Bold, y: 0.72, ...(p.capStyle || {}) } }; }
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
    <div class="plist">${list.map(p => `<button class="pitem${p.id === P?.id ? ' on' : ''}" data-open="${p.id}"><b>${esc(p.name)}</b><span>${p.w}×${p.h} · ${p.clips} clips · ${new Date(p.updated * 1000).toLocaleString()}</span></button>`).join('') || '<p class="hint">No saved projects yet.</p>'}</div>
    <div class="actions"><button data-close>Close</button></div>`);
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
  const up = () => { removeEventListener('pointermove', set); removeEventListener('pointerup', up); };
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
  $('#btnUndo').addEventListener('click', () => restore(undo, redo));
  $('#btnRedo').addEventListener('click', () => restore(redo, undo));
  $('#btnSplit').addEventListener('click', split);
  $('#btnDelete').addEventListener('click', del);
  $('#btnPauses').addEventListener('click', removePauses);
  $('#btnCaptions').addEventListener('click', autoCaptions);
  $('#btnExport').addEventListener('click', openExport);
  $('#btnProjects').addEventListener('click', openProjects);
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

  $('#mediaList').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) addMedia(b.dataset.add); });
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
    const hit = [...hits].reverse().find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    if (!hit) { if (S.sel) { S.sel = null; renderAll(); S.dirty = true; } return; }
    if (S.sel?.id !== hit.id) { S.sel = { lane: hit.lane, id: hit.id }; renderAll(); S.dirty = true; }
    const c = selClip();
    if (!c) return;
    const before = JSON.stringify(P), k = cv.width / P.w, x0 = e.clientX, y0 = e.clientY;
    const o = hit.lane === 'captions' ? { y: P.capStyle.y } : { x: c.x, y: c.y };
    const move = ev => {
      const dx = ((ev.clientX - x0) * px) / k / P.w, dy = ((ev.clientY - y0) * px) / k / P.h;
      if (hit.lane === 'captions') P.capStyle.y = clamp(o.y + dy, 0, 1);
      else if (c.media) { c.x = o.x + dx; c.y = o.y + dy; }
      else { c.x = clamp(o.x + dx, 0, 1); c.y = clamp(o.y + dy, 0, 1); }
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
    const out = e.target.parentElement.querySelector('output');
    if (out) out.textContent = fmt(+e.target.value, e.target.dataset.unit);
    S.dirty = true;
    scheduleSave();
    if (['c.speed', 'c.text', 'p.fps'].includes(e.target.dataset.k)) renderTimeline();
  });
  insp.addEventListener('change', e => {
    if (!e.target.dataset.k) return;
    if (pending) { undo.push(pending); redo = []; pending = null; }
    renderTimeline();
  });
  insp.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = selClip(), d = b.dataset;
    if (d.ratio) { change(() => { [P.w, P.h] = RATIOS[d.ratio]; }); fitStage(); }
    else if (d.fit) change(() => { c.fit = d.fit; });
    else if (d.cappreset) change(() => { P.capStyle = { ...TEXT_BASE, ...CAP_PRESETS[d.cappreset], y: P.capStyle.y }; });
    else if (d.textpreset) change(() => { c.style = { ...TEXT_PRESETS[d.textpreset] }; });
    else if (d.act === 'split') split();
    else if (d.act === 'delete') del();
    else if (d.act === 'dup') dup();
    else if (d.act === 'reset') change(() => Object.assign(c, { speed: 1, volume: 1, fit: 'fit', scale: 1, x: 0, y: 0, opacity: 1, fadeIn: 0, fadeOut: 0, adj: { b: 1, c: 1, s: 1 } }));
    else if (d.act === 'clearcaps') change(() => { P.captions = []; S.sel = null; });
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
    else if (key === 'backspace' || key === 'delete') { e.preventDefault(); del(); }
    else if (key === 'arrowleft' || key === 'arrowright') {
      e.preventDefault();
      if (S.playing) pause();
      S.t = snap(clamp(S.t + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / P.fps), 0, total()));
      placePlayhead(); follow(); S.dirty = true;
    } else if (key === 'escape' && S.sel) { S.sel = null; renderAll(); S.dirty = true; }
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
    const ping = await api('/api/ping');
    if (!ping.whisper) $('#capStatus').textContent = 'Captions need whisper.cpp: brew install whisper-cpp';
  } catch (e) { toast(`Cannot reach the Cutroom server: ${e.message}`); }
  requestAnimationFrame(frame);
})();
