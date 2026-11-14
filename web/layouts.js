// SPDX-License-Identifier: GPL-3.0-or-later
// Cutroom: split-screen layouts. A layout is P.layouts[i] = {id, type, gap, color, r, corner}; its cells are ordinary overlay
// clips carrying c.cell = {L: layout id, i: cell index, px, py (pan, -1..1), z (zoom, >= 1)}, and its gap colour is an
// overlay picture of that colour under them (c.layBg = layout id). layoutFit() bakes each cell into the clip's own crop,
// scale, position and (rounded corners) rect mask, so the preview and the export draw cells with the code every overlay
// already uses: nothing new to keep in step. touched() calls it after every edit, so a new layout type, a gap, or a new
// canvas shape re-flows the cells; clips beyond the layout's cells are parked (kept, not drawn) until a layout has room.
// Loaded after app.js (plain script, shares its globals).
'use strict';

const LAYOUTS = [['2h', 'Side by side'], ['2v', 'Stacked'], ['3', 'One big, two small'], ['4', 'Grid of four'], ['react', 'Reaction'], ['pip', 'Picture in picture']];
const LAYOUT_N = { '2h': 2, '2v': 2, 3: 3, 4: 4, react: 2, pip: 2 };
const layOf = c => c && (c.cell || c.layBg) && P.layouts?.find(L => L.id === (c.cell?.L || c.layBg));
function layoutCells(L, W, H) { // the cells as [x, y, w, h] canvas pixels; the gap (a share of the short side) runs round and between them
  const g = (L.gap || 0) * Math.min(W, H), wide = W > H * 1.001;
  if (L.type === 'pip') { // the first fills the frame, the second sits in a corner at a third of its size
    const w = W * 0.34, h = H * 0.34, m = Math.max(g, 0.04 * Math.min(W, H)), cn = L.corner || 'br';
    return [[0, 0, W, H], [cn[1] === 'l' ? m : W - m - w, cn[0] === 't' ? m : H - m - h, w, h]];
  }
  const U = { '2h': [[0, 0, 0.5, 1], [0.5, 0, 1, 1]], '2v': [[0, 0, 1, 0.5], [0, 0.5, 1, 1]], 4: [[0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1]],
    3: wide ? [[0, 0, 0.5, 1], [0.5, 0, 1, 0.5], [0.5, 0.5, 1, 1]] : [[0, 0, 1, 0.5], [0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1]], // the big one on the long side
    react: wide ? [[0, 0, 0.6, 1], [0.6, 0, 1, 1]] : [[0, 0, 1, 0.6], [0, 0.6, 1, 1]] }[L.type] || [];
  return U.map(([u0, v0, u1, v1]) => { const x0 = g + u0 * (W - g), y0 = g + v0 * (H - g); return [x0, y0, u1 * (W - g) - x0, v1 * (H - g) - y0]; });
}
function cellBake(c, m, [x, y, w, h], L, p) { // the clip fills its cell: cropped to the cell's shape (zoomed, panned), scaled and placed there; with Mirror on, pan means what you see
  const z = Math.max(1, c.cell.z || 1), ac = w / h, as = m.w / m.h, fw = Math.min(1, ac / as) / z, fh = Math.min(1, as / ac) / z, r6 = v => +v.toFixed(6);
  const l = ((1 - fw) * (1 + (c.flip ? -1 : 1) * clamp(c.cell.px || 0, -1, 1))) / 2, t = ((1 - fh) * (1 + clamp(c.cell.py || 0, -1, 1))) / 2;
  c.crop = { l: r6(l), r: r6(1 - fw - l), t: r6(t), b: r6(1 - fh - t) };
  const mw = m.w * fw, mh = m.h * fh, sc = w / (mw * Math.min(p.w / mw, p.h / mh)), nx = (x + w / 2) / p.w - 0.5, ny = (y + h / 2) / p.h - 0.5;
  if (c.kf?.length) { const dx = nx - (c.x ?? 0), dy = ny - (c.y ?? 0), q = sc / (c.scale || 1); for (const f of c.kf) { f.x = (f.x ?? 0) + dx; f.y = (f.y ?? 0) + dy; f.scale = (f.scale ?? 1) * q; } } // its own animation moves with the cell
  Object.assign(c, { fit: 'fit', x: nx, y: ny, scale: sc });
  const full = w >= p.w - 0.5 && h >= p.h - 0.5, rr = L.r > 0 && !full ? Math.min(0.5, (L.r * Math.min(p.w, p.h)) / Math.min(w, h)) : 0;
  if (rr && (!c.mask || c.mask.cell)) c.mask = { type: 'rect', x: 0, y: 0, w: 1, h: 1, rot: 0, feather: 0, rr: +rr.toFixed(5), cell: true }; // rounded corners (maskCanvas)
  else if (!rr && c.mask?.cell) delete c.mask;
}
function layoutFit(p = P) { // every layout's cells baked for this canvas (touched() after each edit, reshape() for an export in another shape)
  if (!p?.layouts?.length) return;
  for (const L of [...p.layouts]) {
    const cells = p.overlay.filter(c => c.cell?.L === L.id), bg = p.overlay.find(c => c.layBg === L.id);
    if (!cells.length && !bg) { p.layouts.splice(p.layouts.indexOf(L), 1); continue; } // its last clip deleted
    const R = layoutCells(L, p.w, p.h);
    for (const c of cells) {
      const r = R[c.cell.i], m = M.get(c.media);
      if (r) delete c.cell.off; else c.cell.off = true;
      if (r && m?.w) cellBake(c, m, r, L, p);
    }
    if (bg) { // spans its cells, fills the frame
      if (cells.length) { const s = Math.min(...cells.map(c => c.start)), e = Math.max(...cells.map(c => c.start + len(c))); Object.assign(bg, { start: s, in: 0, out: +(e - s).toFixed(6), speed: 1 }); }
      Object.assign(bg, { fit: 'fill', scale: 1, x: 0, y: 0, rot: 0 }); delete bg.kf; delete bg.crop;
    }
  }
}
const sleepL = ms => new Promise(r => setTimeout(r, ms));
async function solidMedia(hex) { // a plain picture of that colour in the library (a layout's gap colour), made once per colour
  hex = String(hex).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error('colour must be "#rrggbb"');
  const name = `Layout colour ${hex.slice(1)}.png`, have = () => [...M.values()].find(x => x.name === name && x.kind === 'image' && x.w);
  if (have()) return have();
  const cv = new OffscreenCanvas(64, 64), x = cv.getContext('2d');
  x.fillStyle = hex; x.fillRect(0, 0, 64, 64);
  const m = await uploadOne(new File([await cv.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' }));
  for (let i = 0; i < 60 && !M.get(m.id)?.w; i++) { await sleepL(150); await loadMedia(); }
  if (!M.get(m.id)?.w) throw new Error('the gap colour picture was not imported');
  return M.get(m.id);
}
const layoutSpan = L => { // [start, length] of the layout's clips (its gap colour's, else its cells')
  const bg = P.overlay.find(c => c.layBg === L.id), cs = P.overlay.filter(c => c.cell?.L === L.id), all = bg ? [bg] : cs;
  if (!all.length) return [snap(S.t), 5];
  const s = Math.min(...all.map(c => c.start));
  return [s, Math.max(...all.map(c => c.start + len(c))) - s];
};
function cellClip(L, i, mid, at, D, row) { // a new clip for cell i
  const m = M.get(mid);
  if (!m || m.kind === 'audio') throw new Error('a layout cell takes a video or a picture');
  return Object.assign(brandClip(mid), { start: at, out: m.kind === 'image' ? D : Math.min(m.duration, D), cell: { L: L.id, i }, track: row });
}
async function makeLayout({ type = '2h', media = [], clips = [], start, duration, gap = 0.02, color = '#000000', corners = 0, corner = 'br' } = {}) {
  if (!LAYOUT_N[type]) throw new Error(`type must be one of ${Object.keys(LAYOUT_N).join(', ')}`);
  const ms = media.map(q => mediaBy(q)), moved = clips.map(id => cfind(id));
  for (const m of ms) if (m.kind === 'audio') throw new Error(`${m.name} is a sound: a layout cell takes a video or a picture`);
  for (const [c, lane] of moved) if (!['main', 'overlay'].includes(lane) || M.get(c.media)?.kind === 'audio' || !M.get(c.media)) throw new Error('only video and picture clips go into a layout');
  const bgm = color && type !== 'pip' ? await solidMedia(color) : null;
  let L;
  change(() => {
    L = { id: hex12(), type, gap: clamp(+gap || 0, 0, 0.15), color: bgm ? color.toLowerCase() : null, r: clamp(+corners || 0, 0, 0.2), corner };
    (P.layouts ??= []).push(L);
    const t0 = snap(Math.max(0, start ?? (moved.length ? Math.min(...moved.map(([c]) => c.start)) : S.t)));
    const vids = [...moved.map(([c]) => c).filter(c => M.get(c.media).kind === 'video').map(len), ...ms.filter(m => m.kind === 'video').map(m => m.duration)];
    const D = duration ?? (Math.max(0, ...vids) || 5), row = P.overlay.length ? rows('overlay').n : 0;
    if (bgm) P.overlay.push(Object.assign(brandClip(bgm.id), { start: t0, out: D, volume: 0, layBg: L.id, track: row }));
    const items = moved.map(([c, lane], i) => {
      P[lane] = P[lane].filter(x => x !== c);
      delete c.tr; delete c.layBg;
      return Object.assign(c, { start: t0, cell: { L: L.id, i }, track: row });
    });
    ms.forEach((m, j) => items.push(cellClip(L, moved.length + j, m.id, t0, D, row)));
    P.overlay.push(...items);
    const first = items[0] || P.overlay.find(c => c.layBg === L.id);
    S.sel = first ? { lane: 'overlay', id: first.id } : null; S.multi.clear();
  }, 'Layout');
  return L;
}
async function setLayout(L, o) { // type, gap, corners (r), corner, color (null: the gaps show what's under)
  if (o.type !== undefined && !LAYOUT_N[o.type]) throw new Error(`type must be one of ${Object.keys(LAYOUT_N).join(', ')}`);
  if (o.corner !== undefined && !['tl', 'tr', 'bl', 'br'].includes(o.corner)) throw new Error('corner must be tl, tr, bl or br');
  const bgm = o.color ? await solidMedia(o.color) : null;
  change(() => {
    for (const k of ['type', 'corner']) if (o[k] !== undefined) L[k] = o[k];
    if (o.gap !== undefined) L.gap = clamp(+o.gap || 0, 0, 0.15);
    if (o.r !== undefined) L.r = clamp(+o.r || 0, 0, 0.2);
    if (o.color === undefined) return;
    const bg = P.overlay.find(c => c.layBg === L.id);
    L.color = bgm ? o.color.toLowerCase() : null;
    if (!bgm) { if (bg) P.overlay = P.overlay.filter(c => c !== bg); return; }
    if (bg) { bg.media = bgm.id; return; }
    const [s, d] = layoutSpan(L), at = P.overlay.findIndex(c => c.cell?.L === L.id), first = P.overlay[at];
    P.overlay.splice(Math.max(0, at), 0, Object.assign(brandClip(bgm.id), { start: s, out: d, volume: 0, layBg: L.id, track: first?.track || 0 })); // under its cells
  }, 'Layout');
}
function layoutPut(L, i, mid) { // media into cell i: the clip there plays it instead, or a new clip fills the empty cell
  const m = M.get(mid);
  if (!m || m.kind === 'audio') throw new Error('a layout cell takes a video or a picture');
  if (!(i >= 0 && i < LAYOUT_N[L.type])) throw new Error(`cell must be 0-${LAYOUT_N[L.type] - 1}`);
  let c;
  change(() => {
    c = P.overlay.find(x => x.cell?.L === L.id && x.cell.i === i);
    if (c) { const d = len(c); Object.assign(c, { media: mid, in: 0, out: m.kind === 'image' ? d : Math.min(m.duration, d * c.speed) }); delete c.crop; return; }
    const [s, d] = layoutSpan(L), mates = P.overlay.filter(x => x.cell?.L === L.id || x.layBg === L.id);
    c = cellClip(L, i, mid, s, m.kind === 'image' || mates.length ? d : m.duration, mates[0]?.track || 0);
    P.overlay.push(c);
    S.sel = { lane: 'overlay', id: c.id };
  }, 'Layout');
  return c;
}
function layoutLeave(c) { // the clip stays where it is, as a plain overlay
  change(() => { delete c.cell; if (c.mask?.cell) delete c.mask; }, 'Layout');
}
function layoutInfo(L) {
  const R = layoutCells(L, P.w, P.h), bg = P.overlay.find(c => c.layBg === L.id), r1 = v => Math.round(v * 10) / 10;
  return { id: L.id, type: L.type, gap: L.gap, color: L.color, corners: L.r, corner: L.corner, bg: bg?.id || null,
    cells: R.map((r, i) => ({ i, rect: r.map(r1), clips: P.overlay.filter(c => c.cell?.L === L.id && c.cell.i === i).map(c => c.id) })),
    parked: P.overlay.filter(c => c.cell?.L === L.id && c.cell.off).map(c => c.id) };
}
function layoutAt(x, y) { // [layout, cell] under canvas point (x, y), project pixels, at the playhead
  for (const L of [...(P.layouts || [])].reverse()) {
    const [s, d] = layoutSpan(L);
    if (S.t < s - 1e-6 || S.t >= s + d) continue;
    const i = layoutCells(L, P.w, P.h).findLastIndex(([cx, cy, w, h]) => x >= cx && x < cx + w && y >= cy && y < cy + h);
    if (i >= 0) return [L, i];
  }
  return null;
}

// ---------- the preview: drag inside a cell pans its clip, its corner handles zoom it; media dropped on a cell fills it ----------
function cellDrag(e, c, cv) {
  if (!c.cell) return; // the gap colour: selected, not moved
  const L = layOf(c), r = cv.getBoundingClientRect(), px = cv.width / r.width, k = cv.width / P.w, m = M.get(c.media), R = L && layoutCells(L, P.w, P.h)[c.cell.i];
  if (!R || !m?.w) return;
  const before = JSON.stringify(P), x0 = e.clientX, y0 = e.clientY, p0 = [c.cell.px || 0, c.cell.py || 0], z = Math.max(1, c.cell.z || 1);
  const fw = Math.min(1, R[2] / R[3] / (m.w / m.h)) / z, fh = Math.min(1, (m.w / m.h) / (R[2] / R[3])) / z;
  const move = ev => { // the picture follows the pointer: the crop window goes the other way (a pan of 1 = all the room there is)
    const dx = ((ev.clientX - x0) * px) / k, dy = ((ev.clientY - y0) * px) / k;
    if (fw < 1) c.cell.px = +clamp(p0[0] - (2 * dx * fw) / (R[2] * (1 - fw)), -1, 1).toFixed(4);
    if (fh < 1) c.cell.py = +clamp(p0[1] - (2 * dy * fh) / (R[3] * (1 - fh)), -1, 1).toFixed(4);
    cellBake(c, m, R, L, P); S.dirty = true;
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (JSON.stringify(P) !== before) { step(before, 'Pan in cell'); touched(); } };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}
function cellZoomDrag(e, h, c, cv) { // a corner handle: zoom about the cell's centre (1x = the clip just fills it)
  const L = layOf(c), m = M.get(c.media), R = L && layoutCells(L, P.w, P.h)[c.cell.i];
  if (!R || !m?.w) return;
  const r = cv.getBoundingClientRect(), px = cv.width / r.width, b = selBox(h), before = JSON.stringify(P), z0 = Math.max(1, c.cell.z || 1);
  const pt = ev => [(ev.clientX - r.left) * px, (ev.clientY - r.top) * px], [x0, y0] = pt(e), d0 = Math.max(1, Math.hypot(x0 - b.cx, y0 - b.cy));
  const move = ev => { const [x, y] = pt(ev); c.cell.z = +clamp((z0 * Math.hypot(x - b.cx, y - b.cy)) / d0, 1, 6).toFixed(3); cellBake(c, m, R, L, P); S.dirty = true; };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (JSON.stringify(P) !== before) { step(before, 'Zoom in cell'); touched(); } };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}
{
  const cvEl = $('#cv'), at = e => { const r = cvEl.getBoundingClientRect(), k = P.w / r.width; return layoutAt((e.clientX - r.left) * k, (e.clientY - r.top) * k); };
  cvEl.addEventListener('dragover', e => { if (P && e.dataTransfer.types.includes('text/cutroom-media') && at(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  cvEl.addEventListener('drop', e => {
    const hit = P && at(e), id = e.dataTransfer.getData('text/cutroom-media');
    if (!hit || !id) return;
    e.preventDefault(); e.stopPropagation();
    try { layoutPut(hit[0], hit[1], id); } catch (err) { toast(err.message); }
  });
}

// ---------- the Layouts tab (tiles drawn at the project's shape) and the inspector's layout rows ----------
const layEl = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});
function layoutTile(type) {
  const W = P ? P.w : 1080, H = P ? P.h : 1920, q = 44 / Math.max(W, H), ic = layEl('span', 'layic');
  Object.assign(ic.style, { width: `${Math.round(W * q)}px`, height: `${Math.round(H * q)}px` });
  for (const [x, y, w, h] of layoutCells({ type, gap: 0.04, corner: 'br' }, W, H)) Object.assign(ic.appendChild(layEl('i')).style, { left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, width: `${(w / W) * 100}%`, height: `${(h / H) * 100}%` });
  return ic;
}
function renderLayouts() {
  const L = layOf(selClip());
  $('#layTiles').replaceChildren(...LAYOUTS.map(([v, n]) => {
    const b = layEl('button', `laytile${L?.type === v ? ' on' : ''}`);
    b.dataset.layout = v; b.title = L ? `Change to ${n.toLowerCase()}` : `${n}: the selected clips go into its cells`;
    b.append(layoutTile(v), layEl('span', '', n));
    return b;
  }));
  $('#layNow').textContent = L ? `This layout is ${LAYOUTS.find(x => x[0] === L.type)[1].toLowerCase()}. Picking another one re-flows its clips.` : 'Select clips first (or none, for an empty layout), then pick one.';
}
function layoutPick(type) {
  const L = layOf(selClip());
  const run = L ? setLayout(L, { type }) : makeLayout({ type, clips: selection().filter(([c, lane]) => ['main', 'overlay'].includes(lane) && M.get(c.media) && M.get(c.media).kind !== 'audio' && !c.layBg).map(([c]) => c.id) });
  run.then(() => { renderLayouts(); toast(L ? 'Layout changed' : 'Layout added: drag clips from Media onto its cells'); }).catch(err => toast(err.message));
}
function layoutRows(c) { // the inspector's layout section (HTML, like its other panels) for a cell or a layout's gap colour
  const L = layOf(c);
  if (!L) return '';
  const pip = L.type === 'pip';
  return `<h4>Layout</h4><div class="presets small">${LAYOUTS.map(([v, n]) => `<button data-laytype="${v}" class="${L.type === v ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>`
    + (pip ? segs('laycorner', 'Corner', L.corner || 'br', [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']]) : '')
    + slider('lay.gap', pip ? 'Margin' : 'Gap', L.gap || 0, 0, 0.1, 0.002, '%') + slider('lay.r', 'Corners', L.r || 0, 0, 0.1, 0.002, '%')
    + (pip ? '' : `<label class="row"><span>Gap colour</span><input type="color" data-laycol value="${esc(L.color || '#000000')}"${G.brand.colors?.length ? ' list="brandColours"' : ''}></label>`
      + `<div class="actions"><button data-laynone="1"${L.color ? '' : ' disabled'} title="The gaps show the tracks under the layout">Clear gap colour</button></div>`)
    + (c.cell ? slider('c.cell.z', 'Zoom', c.cell.z || 1, 1, 4, 0.01) + slider('c.cell.px', 'Pan X', c.cell.px || 0, -1, 1, 0.01, '%') + slider('c.cell.py', 'Pan Y', c.cell.py || 0, -1, 1, 0.01, '%')
      + `<p class="hint">${c.cell.off ? 'This layout has no cell for this clip: it is kept, not shown, until a layout with more cells is picked.' : 'Drag the picture in the preview to pan it; drag a corner to zoom.'}</p><div class="actions"><button data-layleave="1">Take out of the layout</button></div>` : '');
}
{
  const insp = $('#inspector');
  insp.addEventListener('click', e => {
    const b = e.target.closest('button'), c = selClip(), L = layOf(c);
    if (!b || !L) return;
    const d = b.dataset, go = p => p.then(() => renderInspector()).catch(err => toast(err.message));
    if (d.laytype) go(setLayout(L, { type: d.laytype }));
    else if (d.laycorner) go(setLayout(L, { corner: d.laycorner }));
    else if (d.laynone) go(setLayout(L, { color: null }));
    else if (d.layleave) { layoutLeave(c); renderInspector(); }
  });
  insp.addEventListener('change', e => {
    if (!('laycol' in e.target.dataset)) return;
    const L = layOf(selClip());
    if (L) setLayout(L, { color: e.target.value }).then(() => renderInspector()).catch(err => toast(err.message));
  });
  $('#layTiles').addEventListener('click', e => { const b = e.target.closest('[data-layout]'); if (b && P) layoutPick(b.dataset.layout); });
}

Object.assign(REMOTE, {
  async layout({ id, clip, type, media, clips, start, duration, gap, color, corners, corner, cell, put, zoom, pan, leave }) {
    let L = id ? P.layouts?.find(x => x.id === id) : clip ? layOf(cfind(clip)[0]) : null;
    if ((id || clip) && !L) throw new Error(`no layout ${id || `with clip ${clip}`}`);
    if (!L) {
      L = await makeLayout({ type, media: media || [], clips: clips || [], start, duration, gap, color: color === undefined ? '#000000' : color, corners, corner });
      return layoutInfo(L);
    }
    if (leave) { const [c] = cfind(leave); if (c.cell?.L !== L.id) throw new Error('that clip is not in this layout'); layoutLeave(c); }
    const o = { type, gap, color, r: corners, corner };
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    if (Object.keys(o).length) await setLayout(L, o);
    for (const [j, q] of (media || []).entries()) layoutPut(L, (cell ?? 0) + j, mediaBy(q).id);
    if (put !== undefined) layoutPut(L, cell ?? 0, mediaBy(put).id);
    if (zoom !== undefined || pan !== undefined) {
      const c = P.overlay.find(x => x.cell?.L === L.id && x.cell.i === (cell ?? 0));
      if (!c) throw new Error(`cell ${cell ?? 0} is empty`);
      change(() => {
        if (zoom !== undefined) c.cell.z = clamp(+zoom || 1, 1, 6);
        if (pan !== undefined) [c.cell.px, c.cell.py] = [clamp(+pan[0] || 0, -1, 1), clamp(+pan[1] || 0, -1, 1)];
      }, 'Layout');
    }
    return layoutInfo(L);
  },
});
