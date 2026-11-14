// SPDX-License-Identifier: GPL-3.0-or-later
// Cutroom: the audio visualizer's numbers. A visualizer is a text-track item with it.viz = {style: bars | mirror | line |
// circle, src: 'mix' or a clip id, n: bars, smooth, sens, c1, c2 (colours), w, h (box, shares of the canvas)}; draw.js's
// drawViz draws it. Its levels are worked out here, once, from the sound itself: each source clip's PCM (the same 48 kHz
// file the preview plays and the export reads), a 2048-point FFT every 10 ms into 64 log bands (40 Hz-16 kHz), then per
// frame of the item: the clips' bands at their source time, mixed by volume and fades, into bars (dB, sensitivity,
// smoothing run frame by frame from the item's start, so a frame's value never depends on where playback started).
// The export hands the very same arrays to its text-layer workers (it.lv): preview == export, and two exports agree.
// No AnalyserNode: that measures whatever happens to be playing, differently each time. Loaded after app.js.
'use strict';

const VZ_BANDS = 64, VZ_HOP = 0.01, VZ_N = 2048, VZ_SR = 48000, VZ_LO = 40, VZ_HI = 16000;
const VIZ_STYLES = [['bars', 'Bars'], ['mirror', 'Mirrored bars'], ['line', 'Line'], ['circle', 'Circle']];
const VZ = (() => { // the FFT's tables, the Hann window, and each band's bins [k0, k1)
  const N = VZ_N, lg = Math.log2(N), rev = new Uint32Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2), win = new Float64Array(N), bin = VZ_SR / N;
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < lg; b++) r |= ((i >> b) & 1) << (lg - 1 - b); rev[i] = r; win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = -Math.sin((2 * Math.PI * i) / N); }
  const edge = j => VZ_LO * (VZ_HI / VZ_LO) ** (j / VZ_BANDS), bands = [];
  for (let j = 0; j < VZ_BANDS; j++) { let k0 = Math.ceil(edge(j) / bin), k1 = Math.ceil(edge(j + 1) / bin); if (k1 <= k0) { k0 = Math.round(Math.sqrt(edge(j) * edge(j + 1)) / bin); k1 = k0 + 1; } bands.push([k0, k1]); } // a band narrower than a bin: the bin at its centre
  return { N, rev, cos, sin, win, bands };
})();
function vzFFT(re, im) { // in place, radix 2
  const { N, rev, cos, sin } = VZ;
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, st = N / size;
    for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += st) {
      const a = i + j, b = a + half, tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
// The source seconds [a, b] are read in pieces (the server answers a range with at most 8 MiB, ~44 s) and FFT'd as they
// arrive: only the piece in hand and the window's overlap stay in memory, whatever the length.
// ponytail: the spectrum itself is kept whole (Float32, 92 MB per hour of source); quantise it if hour-long sources matter
const vzSpec = new Map(); // `${media}|${a}|${b}` -> promise; .v = {a, hops, data: Float32Array(hops x 64)} (amplitude: a full-scale sine ~1) once read
function vzSpecGet(mid, a, b) {
  const key = `${mid}|${a}|${b}`;
  let p = vzSpec.get(key);
  if (p) return p;
  p = (async () => {
    const need = (b - a) * VZ_SR, hops = Math.round((b - a) / VZ_HOP) + 1, data = new Float32Array(hops * VZ_BANDS), re = new Float64Array(VZ_N), im = new Float64Array(VZ_N), step = VZ_SR * VZ_HOP;
    let mono = new Float32Array(0), base = 0, got = 0, done = false, j = 0; // mono = samples [base, base + length) of the source from a
    while (j < hops) {
      if (!done) { // the next piece: whatever the server sends of what's left
        const r = await fetch(`/media/${mid}?pcm=1`, { headers: { Range: `bytes=${(a * VZ_SR + got) * 4}-${b * VZ_SR * 4 - 1}` } });
        let buf = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0), skip = 0;
        if (r.status === 200) { skip = a * VZ_SR + got; done = true; } // the whole file, not a range
        const n = Math.max(0, Math.min((buf.byteLength >> 2) - skip, need - got)), x = new Int16Array(buf, skip * 4, n * 2), m2 = new Float32Array(mono.length + n);
        m2.set(mono);
        for (let i = 0; i < n; i++) m2[mono.length + i] = (x[2 * i] + x[2 * i + 1]) / 65536;
        mono = m2; buf = null; got += n;
        if (!n || got >= need) done = true;
      }
      for (; j < hops && (done || Math.round(j * step) + VZ_N / 2 <= got); j++) { // a window centred on each hop, once its samples are here
        const c0 = Math.round(j * step) - VZ_N / 2 - base;
        for (let i = 0; i < VZ_N; i++) { const q = c0 + i; re[i] = q >= 0 && q < mono.length ? mono[q] * VZ.win[i] : 0; im[i] = 0; }
        vzFFT(re, im);
        for (let k = 0; k < VZ_BANDS; k++) {
          const [k0, k1] = VZ.bands[k];
          let m = 0;
          for (let q = k0; q < k1; q++) m = Math.max(m, re[q] * re[q] + im[q] * im[q]);
          data[j * VZ_BANDS + k] = (4 * Math.sqrt(m)) / VZ_N;
        }
        if (j % 200 === 199) await new Promise(z => setTimeout(z)); // the editor keeps drawing
      }
      const keep = Math.max(base, Math.round(j * step) - VZ_N / 2); // what the next windows still need
      mono = mono.slice(keep - base); base = keep;
    }
    return { a, hops, data };
  })().catch(() => ({ a, hops: 0, data: new Float32Array(0) })) // no sound to read: flat
    .then(v => { p.v = v; S.dirty = true; return v; });
  vzSpec.set(key, p);
  return p;
}
const vzRange = c => [c.media, Math.max(0, Math.floor(c.in)), Math.ceil(c.out) + 1];
function vizSrcs(it) { // [clip, lane] whose sound it shows: one clip, or every audible clip under it (muted tracks don't count)
  const v = it.viz, out = [];
  for (const lane of ['main', 'overlay', 'audio']) {
    if (P.mute[lane]) continue;
    for (const c of shown(lane)) {
      const m = M.get(c.media);
      if (!m?.hasAudio || c.cell?.off || (v.src && v.src !== 'mix' && c.id !== v.src)) continue;
      if (c.start < it.start + it.dur && c.start + tdur(c, lane) > it.start) out.push([c, lane]);
    }
  }
  return out;
}
const vzLv = new Map(); // item id -> {sig, L}
function vizLevels(it) { // {f0: first frame, nF, n: bars, lv: Float32Array(nF x n), 0..1}; null until its sound is read
  const v = it.viz, fps = P.fps, srcs = vizSrcs(it), n = clamp(Math.round(v.n || 32), 4, 64);
  const sig = JSON.stringify([fps, it.start, it.dur, n, v.smooth, v.sens, srcs.map(([c, lane]) => [c.id, c.media, c.start, c.in, c.out, c.speed, c.volume, c.vkf, c.fadeIn, c.fadeOut, tdur(c, lane)])]);
  const hit = vzLv.get(it.id);
  if (hit?.sig === sig) return hit.L;
  const sp = srcs.map(([c]) => vzSpecGet(...vzRange(c)).v);
  if (sp.some(x => !x)) return null;
  const F0 = Math.floor(it.start * fps + 1e-6), nF = Math.max(1, Math.ceil((it.start + it.dur) * fps - 1e-6) - F0 + 1);
  const lv = new Float32Array(nF * n), E = new Float64Array(VZ_BANDS), sm = clamp(v.smooth ?? 0.5, 0, 0.98) ** (30 / fps), pw = 1 / clamp(v.sens ?? 1, 0.1, 10);
  for (let f = 0; f < nF; f++) {
    const t = (F0 + f) / fps;
    E.fill(0);
    srcs.forEach(([c, lane], q) => { // the clips' band energies at their source time, by volume x fades
      const d = tdur(c, lane), lt = t - c.start, s = sp[q];
      if (lt < 0 || lt >= d || !s.hops) return;
      const g = volAt(c, lt) * fadeAt(c, lt, d), j = Math.round((c.in + lt * (c.speed || 1) - s.a) / VZ_HOP);
      if (!(g > 0) || j < 0 || j >= s.hops) return;
      for (let k = 0; k < VZ_BANDS; k++) { const a = s.data[j * VZ_BANDS + k] * g; E[k] += a * a; }
    });
    for (let i = 0; i < n; i++) { // a bar = the loudest of its bands, -60..0 dB, lifted by the sensitivity; it rises at once and falls by the smoothing
      let e = 0;
      for (let k = Math.floor((i * VZ_BANDS) / n); k < Math.floor(((i + 1) * VZ_BANDS) / n); k++) e = Math.max(e, E[k]);
      const raw = e > 1e-12 ? clamp((10 * Math.log10(e) + 60) / 60, 0, 1) ** pw : 0, prev = f ? lv[(f - 1) * n + i] : 0;
      lv[f * n + i] = raw >= prev ? raw : prev * sm + raw * (1 - sm);
    }
  }
  const L = { f0: F0, nF, n, lv };
  vzLv.set(it.id, { sig, L });
  return L;
}
async function vizReady() { // every visualizer's sound read (buildPlan waits for this: the export never draws one without its numbers)
  await Promise.all(shown('text').filter(it => it.viz).flatMap(it => vizSrcs(it).map(([c]) => vzSpecGet(...vzRange(c)))));
}

function addViz(style = 'bars', o = {}) { // one undo step; colours from the brand kit unless given
  if (!VIZ_STYLES.some(x => x[0] === style)) throw new Error(`style must be one of ${VIZ_STYLES.map(x => x[0]).join(', ')}`);
  const bc = G.brand?.colors || [], c1 = o.c1 || bc[0] || '#7ee0c3', c2 = o.c2 || bc[1] || c1, round = style === 'circle', s = Math.min(P.w, P.h);
  let it;
  change(() => {
    const start = snap(Math.max(0, o.start ?? S.t)), rest = total() - start;
    it = { id: hex12(), start, dur: o.dur ?? (rest >= 0.5 ? rest : 5), text: 'Audio visualizer', x: o.x ?? 0.5, y: o.y ?? (round ? 0.5 : 0.8), scale: 1, opacity: 1, rot: 0, style: {},
      viz: { style, src: o.src || 'mix', n: o.n ?? (round ? 48 : 32), smooth: o.smooth ?? 0.5, sens: o.sens ?? 1, c1, c2, w: o.w ?? (round ? (0.45 * s) / P.w : 0.8), h: o.h ?? (round ? (0.45 * s) / P.h : 0.25) } };
    P.text.push(it);
    S.sel = { lane: 'text', id: it.id }; S.multi.clear();
  }, 'Audio visualizer');
  return it;
}
function vizPanel(c) { // the inspector for a visualizer (textPanel hands over)
  const v = c.viz, pr = propsAt(c, S.t - c.start), srcs = [['mix', 'The whole mix'], ...['main', 'overlay', 'audio'].flatMap(lane => P[lane].filter(x => M.get(x.media)?.hasAudio).map(x => [x.id, `${M.get(x.media).name} (${LANE_WORD[lane]} at ${x.start.toFixed(1)} s)`]))];
  const style = `<div class="presets small">${VIZ_STYLES.map(([k, n]) => `<button data-vizstyle="${k}" class="${v.style === k ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>`
    + pick('c.viz.src', 'Sound', srcs.some(x => x[0] === v.src) ? v.src : 'mix', srcs) + slider('c.viz.n', 'Bars', v.n, 4, 64, 1) + slider('c.viz.smooth', 'Smoothing', v.smooth ?? 0.5, 0, 0.95, 0.01, '%')
    + slider('c.viz.sens', 'Sensitivity', v.sens ?? 1, 0.25, 4, 0.05) + colour('c.viz.c1', 'Colour', v.c1) + colour('c.viz.c2', 'Second colour', v.c2 || v.c1)
    + '<p class="hint">Worked out from the sound itself, frame by frame: the export shows exactly what plays here.</p>';
  const pos = slider('c.viz.w', 'Width', v.w ?? 0.8, 0.05, 1, 0.005, '%') + slider('c.viz.h', 'Height', v.h ?? 0.25, 0.05, 1, 0.005, '%')
    + slider('c.x', 'Position X', pr.x - 0.5, -0.5, 0.5, 0.005, '%', ' data-off="0.5"') + slider('c.y', 'Position Y', pr.y - 0.5, -0.5, 0.5, 0.005, '%', ' data-off="0.5"') + slider('c.scale', 'Scale', pr.scale, 0.2, 4, 0.01, '%')
    + slider('c.rot', 'Rotate', pr.rot, -180, 180, 1, '°') + slider('c.opacity', 'Opacity', pr.opacity, 0, 1, 0.01, '%') + kfRow(c, 'text');
  return '<h3>Audio visualizer</h3>' + tabbed([['Style', style], ['Position', pos]])
    + '<div class="actions"><button data-act="split">Split</button><button data-act="dup">Duplicate</button><button data-act="delete">Delete</button></div><p id="clipStatus" class="muted"></p>';
}
{
  $('#inspector').addEventListener('click', e => {
    const b = e.target.closest('[data-vizstyle]'), c = selClip();
    if (!b || !c?.viz) return;
    change(() => { c.viz.style = b.dataset.vizstyle; }, 'Visualizer style');
    renderInspector();
  });
  $('#vizTiles').addEventListener('click', e => {
    const b = e.target.closest('[data-viz]');
    if (b && P) { addViz(b.dataset.viz); toast('Audio visualizer added at the playhead'); }
  });
}

Object.assign(REMOTE, {
  async visualizer({ id, style, source, start, duration, bars, smoothing, sensitivity, colors, x, y, w, h }) {
    if (source && source !== 'mix') { const [c, lane] = cfind(source); if (!['main', 'overlay', 'audio'].includes(lane) || !M.get(c.media)?.hasAudio) throw new Error('source must be "mix" or a clip with sound'); }
    if (colors && (!Array.isArray(colors) || !colors.every(q => /^#[0-9a-f]{6}$/i.test(q)))) throw new Error('colors: one or two "#rrggbb"');
    let it;
    if (!id) it = addViz(style || 'bars', { src: source, start, dur: duration, n: bars, smooth: smoothing, sens: sensitivity, c1: colors?.[0], c2: colors?.[1] || colors?.[0], x, y, w, h });
    else {
      [it] = cfind(id);
      if (!it.viz) throw new Error(`${id} is not a visualizer`);
      if (style && !VIZ_STYLES.some(q => q[0] === style)) throw new Error(`style must be one of ${VIZ_STYLES.map(q => q[0]).join(', ')}`);
      change(() => {
        const v = it.viz, set = (k, val) => { if (val !== undefined) v[k] = val; };
        set('style', style); set('src', source); set('n', bars); set('smooth', smoothing); set('sens', sensitivity); set('w', w); set('h', h);
        if (colors) { v.c1 = colors[0]; v.c2 = colors[1] || colors[0]; }
        if (start !== undefined) it.start = snap(Math.max(0, start));
        if (duration !== undefined) it.dur = Math.max(0.1, duration);
        if (x !== undefined) it.x = x;
        if (y !== undefined) it.y = y;
      }, 'Audio visualizer');
    }
    await vizReady();
    return { id: it.id, start: r3(it.start), dur: r3(it.dur), x: it.x, y: it.y, viz: it.viz };
  },
});
