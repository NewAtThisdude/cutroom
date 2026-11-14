// SPDX-License-Identifier: GPL-3.0-or-later
// Colour grading and the GPU colour pipeline, loaded before app.js (uses its globals only inside functions).
// A clip's grade (colour wheels, curves, HSL, an imported .cube LUT) is baked into one 33-point 3D LUT. The preview
// applies it on the GPU (WebGL2, with the clip's brightness/contrast/saturation, tone curve, look matrix, filter
// strength, chroma key, vignette and mask in the same pass); the export writes the same LUT as a .cube for ffmpeg's
// lut3d. One table both sides, so they agree by construction (trilinear both sides).
'use strict';
const HSL_BANDS = [['red', 0, '#e5484d'], ['orange', 30, '#f76b15'], ['yellow', 60, '#f5c400'], ['green', 120, '#30a46c'], ['aqua', 180, '#12a5c4'], ['blue', 240, '#3e63dd'], ['purple', 270, '#8e4ec6'], ['magenta', 300, '#d6409f']];
const GN = 33; // grid points per axis
const lutLib = new Map(); // imported LUTs: id -> { n, d: Float32Array (r fastest) } or a pending Promise
const isIdCurve = p => !p || p.length < 2 || p.every(([x, y]) => Math.abs(x - y) < 1e-4);
function gradeOn(g) { // anything to do?
  if (!g) return false;
  if (['lift', 'gamma', 'gain'].some(k => g[k] && (g[k].x || g[k].y || g[k].l))) return true;
  if (g.curves && ['m', 'r', 'g', 'b'].some(k => !isIdCurve(g.curves[k]))) return true;
  if (g.hsl && Object.values(g.hsl).some(b => b && (b.h || b.s || b.l))) return true;
  return !!(g.lut?.id && (g.lut.amount ?? 1) > 0);
}
const wheelRGB = w => { const x = w?.x || 0, y = w?.y || 0, m = Math.min(1, Math.hypot(x, y)), th = Math.atan2(y, x); return [0, 1, 2].map(i => m * Math.cos(th - (i * 2 * Math.PI) / 3)); }; // red at 0°, green 120°, blue 240°
function curveFn(pts) { // the curve editor's points -> v -> v (monotone cubic through them, flat past the ends)
  if (isIdCurve(pts)) return null;
  const q = [...pts].map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)]).sort((a, b) => a[0] - b[0]).filter((p, i, a) => !i || p[0] - a[i - 1][0] > 1e-3);
  if (q.length < 2) return null;
  const f = monotone(q);
  return v => clamp(v <= q[0][0] ? q[0][1] : v >= q.at(-1)[0] ? q.at(-1)[1] : f(v), 0, 1);
}
function rgb2hsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-7) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1) || 1e-7), h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, clamp(s, 0, 1), l];
}
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2, k = Math.floor((((h % 360) + 360) % 360) / 60) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][k];
  return [r + m, g + m, b + m];
}
function bandWeights(h) { // smooth, sums to 1: each band peaks at its hue and fades to 0 at its neighbours'
  const n = HSL_BANDS.length, w = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = HSL_BANDS[i][1], b = HSL_BANDS[(i + 1) % n][1] + (i === n - 1 ? 360 : 0), hh = h < a ? h + 360 : h;
    if (hh >= a && hh <= b) { const t = (hh - a) / (b - a), s = t * t * (3 - 2 * t); w[i] += 1 - s; w[(i + 1) % n] += s; break; }
  }
  return w;
}
function sampleLUT(L, r, g, b) { // trilinear, like lut3d interp=trilinear
  const n = L.n, f = v => clamp(v, 0, 1) * (n - 1), x = f(r), y = f(g), z = f(b), x0 = Math.min(n - 2, Math.floor(x)), y0 = Math.min(n - 2, Math.floor(y)), z0 = Math.min(n - 2, Math.floor(z));
  const dx = x - x0, dy = y - y0, dz = z - z0, at = (i, j, k, ch) => L.d[((k * n + j) * n + i) * 3 + ch], out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const c00 = at(x0, y0, z0, ch) * (1 - dx) + at(x0 + 1, y0, z0, ch) * dx, c10 = at(x0, y0 + 1, z0, ch) * (1 - dx) + at(x0 + 1, y0 + 1, z0, ch) * dx;
    const c01 = at(x0, y0, z0 + 1, ch) * (1 - dx) + at(x0 + 1, y0, z0 + 1, ch) * dx, c11 = at(x0, y0 + 1, z0 + 1, ch) * (1 - dx) + at(x0 + 1, y0 + 1, z0 + 1, ch) * dx;
    out[ch] = (c00 * (1 - dy) + c10 * dy) * (1 - dz) + (c01 * (1 - dy) + c11 * dy) * dz;
  }
  return out;
}
function gradeFn(g, look) { // the grade as rgb (0..1) -> rgb: a film look (lookLutOf), wheels, then curves (master, then per channel), then HSL, then the LUT
  const L = wheelRGB(g.lift), Gm = wheelRGB(g.gamma), Gn = wheelRGB(g.gain), ll = g.lift?.l || 0, gl = g.gamma?.l || 0, nl = g.gain?.l || 0;
  const lift = L.map(v => 0.25 * ll + 0.12 * v), gain = Gn.map(v => 1 + 0.5 * nl + 0.25 * v), gam = Gm.map(v => 2 ** -(gl + 0.4 * v));
  const wheels = [lift, gain, gam].some((a, i) => a.some(v => Math.abs(v - (i ? 1 : 0)) > 1e-6));
  const cm = curveFn(g.curves?.m), cc = ['r', 'g', 'b'].map(k => curveFn(g.curves?.[k]));
  const hb = HSL_BANDS.map(([k]) => g.hsl?.[k] || {}), hsl = hb.some(b => b.h || b.s || b.l);
  const lut = g.lut?.id && lutLib.get(g.lut.id), amt = clamp(g.lut?.amount ?? 1, 0, 1), useLut = lut && !(lut instanceof Promise) && amt > 0;
  return (r, gg, b) => {
    let v = [r, gg, b];
    if (look) { const o = look[0](v); v = v.map((x, i) => x + (clamp(o[i], 0, 1) - x) * look[1]); }
    if (wheels) v = v.map((x, i) => clamp(Math.max(0, x * gain[i] + lift[i] * (1 - x)) ** gam[i], 0, 1));
    if (cm) v = v.map(cm);
    v = v.map((x, i) => (cc[i] ? cc[i](x) : x));
    if (hsl) {
      let [h, s, l] = rgb2hsl(...v);
      const w = bandWeights(h), sw = Math.min(1, s * 3); // greys (no hue) are left alone
      let dh = 0, ds = 0, dl = 0;
      w.forEach((x, i) => { if (x) { dh += x * (hb[i].h || 0); ds += x * (hb[i].s || 0); dl += x * (hb[i].l || 0); } });
      h = (h + dh * 30 + 360) % 360; s = clamp(s * (1 + ds), 0, 1); l = clamp(l + dl * 0.25 * sw, 0, 1);
      v = hsl2rgb(h, s, l);
    }
    if (useLut) { const o = sampleLUT(lut, ...v); v = v.map((x, i) => x + (o[i] - x) * amt); }
    return v;
  };
}
const gradeCache = new Map();
function gradeLUT(c) { // the clip's grade as a GN^3 table (rgb 0..1, r fastest), or null
  const g = c.grade || {}, lk = lookLutOf(c);
  if (!gradeOn(g) && !lk) return null;
  if (g.lut?.id && !lutLib.has(g.lut.id)) loadLut(g.lut.id);
  const key = JSON.stringify(g) + (g.lut?.id && !(lutLib.get(g.lut.id) instanceof Promise) ? '+' : '') + (lk ? `|${c.look.name}:${lk[1]}` : '');
  if (!gradeCache.has(key)) {
    const f = gradeFn(g, lk), d = new Float32Array(GN * GN * GN * 3);
    for (let bi = 0, o = 0; bi < GN; bi++) for (let gi = 0; gi < GN; gi++) for (let ri = 0; ri < GN; ri++, o += 3) { const v = f(ri / (GN - 1), gi / (GN - 1), bi / (GN - 1)); d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; }
    if (gradeCache.size > 24) gradeCache.delete(gradeCache.keys().next().value);
    gradeCache.set(key, { key, d });
  }
  return gradeCache.get(key);
}
function parseCube(txt) { // Resolve/Adobe .cube: 3D (or 1D, expanded to 3D), DOMAIN_MIN/MAX
  let n3 = 0, n1 = 0, lo = [0, 0, 0], hi = [1, 1, 1];
  const rows = [];
  for (const line of String(txt).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const k = t.split(/\s+/);
    if (k[0] === 'LUT_3D_SIZE') n3 = +k[1]; else if (k[0] === 'LUT_1D_SIZE') n1 = +k[1];
    else if (k[0] === 'DOMAIN_MIN') lo = k.slice(1, 4).map(Number); else if (k[0] === 'DOMAIN_MAX') hi = k.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(k[0]) && k.length >= 3) rows.push([+k[0], +k[1], +k[2]]);
  }
  const ok = v => Number.isFinite(v);
  if (n3 >= 2 && n3 <= 128 && rows.length >= n3 ** 3 && rows.slice(0, n3 ** 3).every(r => r.every(ok))) {
    const d = new Float32Array(n3 ** 3 * 3);
    rows.slice(0, n3 ** 3).forEach((r, i) => { for (let ch = 0; ch < 3; ch++) d[i * 3 + ch] = clamp((r[ch] - lo[ch]) / (hi[ch] - lo[ch] || 1), 0, 1); });
    return { n: n3, d };
  }
  if (n1 >= 2 && n1 <= 65536 && rows.length >= n1) { // per-channel curves: sampled into a 3D table
    const n = 33, d = new Float32Array(n ** 3 * 3), at = (ch, v) => { const x = clamp((v - lo[ch]) / (hi[ch] - lo[ch] || 1), 0, 1) * (n1 - 1), i = Math.min(n1 - 2, Math.floor(x)); return clamp(rows[i][ch] + (rows[i + 1][ch] - rows[i][ch]) * (x - i), 0, 1); };
    for (let b = 0, o = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, o += 3) { d[o] = at(0, r / (n - 1)); d[o + 1] = at(1, g / (n - 1)); d[o + 2] = at(2, b / (n - 1)); }
    return { n, d };
  }
  throw new Error('not a .cube LUT (needs LUT_3D_SIZE or LUT_1D_SIZE and its rows)');
}
function loadLut(id) { // fetch an imported LUT once; the preview redraws when it arrives
  if (lutLib.has(id)) return lutLib.get(id);
  const p = fetch(`/luts/${id}.cube`).then(r => { if (!r.ok) throw new Error('LUT missing'); return r.text(); })
    .then(t => { const L = parseCube(t); lutLib.set(id, L); gradeCache.clear(); S.dirty = true; if (S.sel) renderInspector(); return L; })
    .catch(e => { lutLib.delete(id); throw e; });
  lutLib.set(id, p);
  p.catch(() => {});
  return p;
}
async function lutsReady(clips) { for (const c of clips) if (c.grade?.lut?.id) { const L = lutLib.get(c.grade.lut.id) || loadLut(c.grade.lut.id); if (L instanceof Promise) await L.catch(() => {}); } }
function gradeB64(G) { // the table for the export plan: 16-bit little-endian, base64
  const u = new Uint16Array(G.d.length);
  for (let i = 0; i < u.length; i++) u[i] = Math.round(clamp(G.d[i], 0, 1) * 65535);
  let s = '';
  const b = new Uint8Array(u.buffer);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const strengthAt = (c, lt) => { // the colour stage's strength at clip time lt (filter keyframes), 0..1, linear like the export's pw()
  const k = c.lkf;
  if (!k?.length) return 1;
  if (lt <= k[0].t) return k[0].v;
  for (let i = 0; i + 1 < k.length; i++) if (lt < k[i + 1].t) return k[i].v + ((k[i + 1].v - k[i].v) * (lt - k[i].t)) / Math.max(1e-6, k[i + 1].t - k[i].t);
  return k.at(-1).v;
};

// ---------- the GPU pass ----------
const GPU = { gl: null, failed: false };
function gpu() {
  if (GPU.gl || GPU.failed) return GPU.gl;
  try {
    const cv = document.createElement('canvas'), gl = cv.getContext('webgl2', { premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no WebGL2');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pg = gl.createProgram();
    gl.attachShader(pg, sh(gl.VERTEX_SHADER, `#version 300 es
in vec2 p; out vec2 uv; void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`));
    gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src, tone, mask; uniform sampler3D lut;
uniform vec4 crop; uniform bool flip, useTone, useLook, useLut, useKey, useMask, useColour, maskCol;
uniform float bri, con, lutN, mixK, sim, blnd, vig, beauty, bSig; uniform mat3 sat, look; uniform vec3 keyC; uniform vec2 size, texel;
vec3 r8(vec3 c) { return clamp(floor(c + 0.5), 0.0, 255.0); }
float tn(float v) { return texelFetch(tone, ivec2(int(floor(v + 0.5)), 0), 0).r * 255.0; }
void main() {
  vec2 p = uv; if (flip) p.x = 1.0 - p.x;
  vec2 P0 = mix(crop.xy, crop.zw, p);
  vec4 s = texture(src, P0);
  if (beauty > 0.0) { // smooth skin: a luma bilateral (sigmaR 0.1), mixed in where the colour is skin's, like the export's bilateral + chromakey
    const vec3 Y = vec3(0.299, 0.587, 0.114);
    float y0 = dot(s.rgb, Y), ws = 0.0, ys = 0.0;
    for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
      float y = dot(texture(src, P0 + vec2(float(i), float(j)) * bSig * 0.7 * texel).rgb, Y);
      float w = exp(-float(i * i + j * j) / 9.0 - (y - y0) * (y - y0) / 0.02); ws += w; ys += w * y;
    }
    float u = -0.168736 * s.r - 0.331264 * s.g + 0.5 * s.b, v = 0.5 * s.r - 0.418688 * s.g - 0.081312 * s.b;
    float du = u - (-0.0721), dv = v - 0.1043, dd = sqrt((du * du + dv * dv) / 2.0), kA = clamp((dd - 0.10) / 0.12, 0.0, 1.0);
    s.rgb = clamp(s.rgb + (ys / ws - y0) * beauty * (1.0 - kA), 0.0, 1.0);
  }
  vec3 c0 = r8(s.rgb * 255.0), c = c0;
  if (useColour) {
    c = clamp(c * bri, 0.0, 255.0); c = clamp((c - 127.5) * con + 127.5, 0.0, 255.0); c = clamp(sat * c, 0.0, 255.0);
    if (useTone) c = vec3(tn(c.r), tn(c.g), tn(c.b));
    if (useLook) c = look * c;
    c = r8(c);
    if (useLut) c = r8(texture(lut, (c / 255.0 * (lutN - 1.0) + 0.5) / lutN).rgb * 255.0);
    c = r8(c0 + (c - c0) * mixK);
  }
  if (useMask && maskCol) { float m = floor(texture(mask, uv).a * 255.0 + 0.5); c = floor((c0 * (255.0 - m) + c * m + 127.0) / 255.0); } // the grade only where the mask is (the export's maskedmerge)
  float a = s.a;
  if (useKey) { vec3 d = c - keyC; float diff = sqrt(dot(d, d) / 195075.0); a *= blnd > 0.0001 ? clamp((diff - sim) / blnd, 0.0, 1.0) : (diff > sim ? 1.0 : 0.0); }
  if (useMask && !maskCol) a *= texture(mask, uv).a;
  if (vig > 0.0) { vec2 f = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) - 0.5; float u = clamp((length((2.0 * f + 1.0) / size - 1.0) / 1.41421356 - 0.3) / 0.75, 0.0, 1.0); c = r8(c * (1.0 - vig * u * u * (3.0 - 2.0 * u))); }
  o = vec4(c / 255.0 * a, a);
}`));
    gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
    gl.useProgram(pg);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(pg, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    for (const n of ['src', 'tone', 'mask', 'lut', 'crop', 'flip', 'useTone', 'useLook', 'useLut', 'useKey', 'useMask', 'useColour', 'maskCol', 'bri', 'con', 'lutN', 'mixK', 'sim', 'blnd', 'vig', 'beauty', 'bSig', 'texel', 'sat', 'look', 'keyC', 'size']) U[n] = gl.getUniformLocation(pg, n);
    gl.uniform1i(U.src, 0); gl.uniform1i(U.tone, 1); gl.uniform1i(U.lut, 2); gl.uniform1i(U.mask, 3);
    const t2 = (unit, filter) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    const lutT = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, lutT);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
    Object.assign(GPU, { gl, cv, U, pg, srcT: t2(0, gl.LINEAR), toneT: t2(1, gl.NEAREST), maskT: t2(3, gl.LINEAR), lutT, toneKey: '', lutKey: '', maskKey: null });
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); GPU.gl = null; GPU.failed = false; GPU.mb = null; GPU.tr = null; MB.clear(); });
    return gl;
  } catch (e) { GPU.failed = true; console.warn('GPU colour pass off:', e.message); return null; }
}
// Edge/Chrome on Windows hand WebGL a hardware-decoded <video> frame through their own D3D11 copy, which comes out softer
// than drawImage shows the same frame (1:1, 640x360 noise: variance 308 vs 387, 4.7 levels apart on average); so a clip
// went soft the moment a colour setting or Smooth skin moved it onto the GPU. There the frame goes through a 2D canvas
// first (drawImage's own conversion, at the size the pass needs: ~4 ms a 1080p frame). Elsewhere both ways agree.
const VID_VIA_2D = /Windows/.test(navigator.userAgent), vid2d = document.createElement('canvas');
function texSource(gl, el, s = 1) { // texImage2D(el) into the bound texture; s <= 1: the largest scale the pass samples it at
  if (VID_VIA_2D && el.tagName === 'VIDEO') {
    const w = Math.max(1, Math.ceil(el.videoWidth * Math.min(1, s))), h = Math.max(1, Math.ceil(el.videoHeight * Math.min(1, s)));
    if (vid2d.width !== w || vid2d.height !== h) { vid2d.width = w; vid2d.height = h; }
    vid2d.getContext('2d').drawImage(el, 0, 0, w, h);
    el = vid2d;
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
}
const satM = s => [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
const colMajor = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
function gpuPass(el, src, W, H, c, opt = {}) { // el's src rect -> W x H, coloured, keyed, vignetted, masked (offscreen()'s CPU work); returns [canvas, y of the result] or null
  const gl = gpu();
  if (!gl) return null;
  const { cv, U } = GPU, vw = el.videoWidth || el.naturalWidth || el.width, vh = el.videoHeight || el.naturalHeight || el.height;
  if (!vw || !vh) return null;
  if (cv.width < W || cv.height < H) { cv.width = Math.max(cv.width, W); cv.height = Math.max(cv.height, H); }
  gl.useProgram(GPU.pg); gl.viewport(0, 0, W, H); // (the motion-blur mix has its own program)
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, GPU.srcT);
  try { texSource(gl, el, Math.max(W / src[2], H / src[3])); } catch { return null; }
  gl.uniform4f(U.crop, src[0] / vw, src[1] / vh, (src[0] + src[2]) / vw, (src[1] + src[3]) / vh);
  gl.uniform1i(U.flip, c.flip ? 1 : 0);
  const a = c.adj || {}, T = toneLUT(c), L = lookMatrix(c), G = gradeLUT(c);
  gl.uniform1i(U.useColour, opt.noColour ? 0 : 1);
  gl.uniform1f(U.bri, a.b ?? 1); gl.uniform1f(U.con, a.c ?? 1); gl.uniformMatrix3fv(U.sat, false, colMajor(satM(a.s ?? 1)));
  gl.uniform1i(U.useTone, T ? 1 : 0);
  if (T) { const k = T.join(','); if (GPU.toneKey !== k) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, GPU.toneT); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(T)); GPU.toneKey = k; } }
  gl.uniform1i(U.useLook, L ? 1 : 0);
  if (L) gl.uniformMatrix3fv(U.look, false, colMajor(L));
  gl.uniform1i(U.useLut, G ? 1 : 0);
  if (G) { if (GPU.lutKey !== G.key) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, GPU.lutT); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, GN, GN, GN, 0, gl.RGB, gl.FLOAT, G.d); GPU.lutKey = G.key; } gl.uniform1f(U.lutN, GN); }
  gl.uniform1f(U.mixK, opt.k ?? 1);
  const key = c.key && !opt.noKey;
  gl.uniform1i(U.useKey, key ? 1 : 0);
  if (key) { gl.uniform3f(U.keyC, ...hexRgb(c.key.color)); gl.uniform1f(U.sim, c.key.sim); gl.uniform1f(U.blnd, c.key.blend); }
  const mk = opt.mask !== undefined ? opt.mask : c.mask;
  gl.uniform1i(U.useMask, mk ? 1 : 0); gl.uniform1i(U.maskCol, opt.maskCol ? 1 : 0);
  if (mk) { const mc = maskCanvas(mk, W, H); if (GPU.maskKey !== mc) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, GPU.maskT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mc); GPU.maskKey = mc; } }
  gl.uniform1f(U.vig, opt.noVig ? 0 : a.vig || 0); gl.uniform2f(U.size, W, H);
  const bt = c.beauty?.amt || 0; // bilateral sigma: 0.8 % of the clip's short side, in source pixels as the export
  gl.uniform1f(U.beauty, bt); gl.uniform1f(U.bSig, 0.008 * Math.min(src[2], src[3])); gl.uniform2f(U.texel, 1 / vw, 1 / vh);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return [cv, cv.height - H];
}

// ---------- motion blur: a clip's last N frames, mixed (the export's tmix) ----------
// Each frame the colour pass draws for a motion-blurred clip is copied into a texture under its frame number (on the GPU,
// no read-back); the picture shown is the plain mean of frames j-N+1..j, with the clip's first frame standing in for the
// ones before it (tmix repeats it). Paused, app.js draws the frames before the playhead itself (mbFill, store = true).
const MB = new Map(), MBN = 9; // clip id -> { sig, f: Map(frame number -> texture) }; at most 9 frames mixed
function mbProg(gl) {
  if (GPU.mb) return GPU.mb;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pg = gl.createProgram(), hs = [...Array(MBN).keys()];
  gl.attachShader(pg, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
  gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; uniform sampler2D ${hs.map(i => `h${i}`).join(', ')}; uniform int n; uniform vec2 size; out vec4 o;
void main() { vec2 uv = gl_FragCoord.xy / size; vec4 s = texture(h0, uv);
  ${hs.slice(1).map(i => `if (n > ${i}) s += texture(h${i}, uv);`).join(' ')}
  o = floor(s * 255.0 / float(n) + 0.5) / 255.0; }`));
  gl.bindAttribLocation(pg, gl.getAttribLocation(GPU.pg, 'p'), 'p'); // the colour pass's vertex buffer, as it is
  gl.linkProgram(pg);
  if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
  gl.useProgram(pg);
  hs.forEach(i => gl.uniform1i(gl.getUniformLocation(pg, `h${i}`), 4 + i)); // units 4+: 0-3 belong to the colour pass
  return (GPU.mb = { pg, n: gl.getUniformLocation(pg, 'n'), size: gl.getUniformLocation(pg, 'size'), free: [] });
}
// right after gpuPass drew clip frame j (W x H): keep it, then (unless store) draw the mix -> { gp: [canvas, y], miss: [frames not held] }
function gpuMotion(id, sig, j, N, W, H, store) {
  const gl = GPU.gl;
  if (!gl) return null;
  let Q;
  try { Q = mbProg(gl); } catch (e) { console.warn('motion blur preview off:', e.message); return null; }
  let e = MB.get(id);
  MB.delete(id); // (most recently drawn last)
  if (e && e.sig !== sig) { Q.free.push(...e.f.values()); e = null; } // the clip changed: its frames are stale
  e ??= { sig, f: new Map() };
  MB.set(id, e);
  for (const [k, x] of MB) { if (MB.size <= 6) break; Q.free.push(...x.f.values()); MB.delete(k); } // clips no longer shown
  let t = e.f.get(j);
  if (!t) {
    t = Q.free.pop() || gl.createTexture();
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    e.f.set(j, t);
  }
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, W, H, 0);
  if (store) return null;
  for (const [k, x] of e.f) if (k > j || k <= j - N) { e.f.delete(k); Q.free.push(x); }
  while (Q.free.length > 12) gl.deleteTexture(Q.free.pop());
  const use = [], miss = [];
  for (let i = 0; i < N; i++) { const k = Math.max(0, j - i); if (e.f.has(k)) use.push(e.f.get(k)); else miss.push(k); } // (playing, a missed frame is left out)
  gl.useProgram(Q.pg); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
  use.forEach((x, i) => { gl.activeTexture(gl.TEXTURE4 + i); gl.bindTexture(gl.TEXTURE_2D, x); });
  gl.uniform1i(Q.n, use.length); gl.uniform2f(Q.size, W, H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return { gp: [GPU.cv, GPU.cv.height - H], miss: [...new Set(miss)] };
}

// ---------- the per-pixel transitions on the GPU ----------
// dissolve, pixelize, hblur, radial and fadegrays read every pixel of both sides: in JS a read-back of two layer
// canvases, a loop and a put. Uploading the two 2D layers to WebGL cost more than that, so this runs only when both
// sides are a plain picture in a box (app.js drawMedia's cap): their <video>/<img> go straight into a texture, each
// side's layer (the canvas colour + the picture) is rebuilt in an 8-bit texture, and pixelTr's maths run on those.
const TR_GPU = { dissolve: 1, pixelize: 2, hblur: 3, radial: 4, fadegrays: 5 };
function trProg(gl) {
  if (GPU.tr) return GPU.tr;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pg = gl.createProgram();
  gl.attachShader(pg, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
  gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp int;
uniform sampler2D vid, ta, tb, rnd; uniform int mode, size; uniform vec4 box, crop; uniform vec3 bg; uniform vec2 wh; uniform float P, dist, sq, s1, s2;
out vec4 o;
vec3 A(ivec2 q) { return texelFetch(ta, q, 0).rgb * 255.0; } // the layers: 8-bit, row 0 = the picture's top
vec3 B(ivec2 q) { return texelFetch(tb, q, 0).rgb * 255.0; }
void main() {
  if (mode == 0) { // a side's layer: the canvas colour with the picture in its box
    vec2 f = gl_FragCoord.xy; vec3 c = bg;
    if (all(greaterThanEqual(f, box.xy)) && all(lessThan(f, box.xy + box.zw))) c = floor(texture(vid, crop.xy + (f - box.xy) / box.zw * crop.zw).rgb * 255.0 + 0.5);
    o = vec4(c / 255.0, 1.0); return;
  }
  if (mode == 6) { // hblur's block sums (float): a's 32-pixel row blocks, then b's
    ivec2 f = ivec2(gl_FragCoord.xy); int nb = (int(wh.x) + 31) / 32, x0 = (f.x % nb) * 32, e = min(x0 + 32, int(wh.x)); vec3 s = vec3(0.0);
    for (int x = x0; x < e; x++) s += f.x < nb ? A(ivec2(x, f.y)) : B(ivec2(x, f.y));
    o = vec4(s, 1.0); return;
  }
  ivec2 q = ivec2(int(gl_FragCoord.x), int(wh.y) - 1 - int(gl_FragCoord.y)); // (the canvas keeps row 0 at the bottom)
  vec3 a = A(q), b = B(q), c;
  if (mode == 1) c = texelFetch(rnd, q, 0).r >= 1.0 - P ? a : b; // dissolve: xfade's frand per pixel (the JS map, uploaded once)
  else if (mode == 2) { ivec2 k = dist > 0.0 ? ivec2(min((floor(vec2(q) / sq) + 0.5) * sq, wh - 1.0)) : q; c = floor(A(k) * P + B(k) * (1.0 - P)); } // pixelize
  else if (mode == 3) { // hblur: the mean of the row from x on, size wide (cut at the edge), cross-faded; whole 32-pixel blocks from rnd
    vec3 x0 = vec3(0.0), x1 = vec3(0.0); int e = min(q.x + size, int(wh.x)), nb = (int(wh.x) + 31) / 32, x = q.x;
    for (; x < e && (x & 31) != 0; x++) { x0 += A(ivec2(x, q.y)); x1 += B(ivec2(x, q.y)); }
    for (; x + 32 <= e; x += 32) { x0 += texelFetch(rnd, ivec2(x / 32, q.y), 0).rgb; x1 += texelFetch(rnd, ivec2(nb + x / 32, q.y), 0).rgb; }
    for (; x < e; x++) { x0 += A(ivec2(x, q.y)); x1 += B(ivec2(x, q.y)); }
    float n = float(e - q.x); c = floor(x0 / n * P + x1 / n * (1.0 - P));
  } else if (mode == 4) { // radial: b over a through TR_MASK.radial's weight (8-bit, as the mask canvas)
    float w = floor(smoothstep(0.0, 1.0, atan(float(q.x) - wh.x / 2.0, float(q.y) - wh.y / 2.0) - (P - 0.5) * 3.14159265 * 2.5) * 255.0 + 0.5) / 255.0;
    c = floor(b * w + a * (1.0 - w) + 0.5);
  } else { float ga = floor((a.r + a.g + a.b) / 3.0), gb = floor((b.r + b.g + b.b) / 3.0); c = floor((a * s1 + ga * (1.0 - s1)) * P + (gb * s2 + b * (1.0 - s2)) * (1.0 - P)); } // fadegrays
  o = vec4(clamp(c, 0.0, 255.0) / 255.0, 1.0);
}`));
  gl.bindAttribLocation(pg, gl.getAttribLocation(GPU.pg, 'p'), 'p'); // the colour pass's vertex buffer, as it is
  gl.linkProgram(pg);
  if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
  gl.useProgram(pg);
  const U = {};
  for (const n of ['vid', 'ta', 'tb', 'rnd', 'mode', 'size', 'box', 'crop', 'bg', 'wh', 'P', 'dist', 'sq', 's1', 's2']) U[n] = gl.getUniformLocation(pg, n);
  gl.uniform1i(U.vid, 0); gl.uniform1i(U.ta, 4); gl.uniform1i(U.tb, 5); gl.uniform1i(U.rnd, 6); // 4-6: the motion-blur units, which it rebinds before use
  const tex = filter => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, t); for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v); return t; };
  return (GPU.tr = { pg, U, vid: tex(gl.LINEAR), t: [tex(gl.NEAREST), tex(gl.NEAREST)], fb: [gl.createFramebuffer(), gl.createFramebuffer()], rnd: tex(gl.NEAREST), bs: tex(gl.NEAREST), bfb: gl.createFramebuffer(), sz: '', rk: '', bk: '', fl: !!gl.getExtension('EXT_color_buffer_float') });
}
// sides: two { el, src: [x, y, w, h] of the source, dst: [x, y, w, h] on the canvas } -> the transition drawn into ctx, or false
function trGPU(ctx, sides, type, P1, bg) {
  const gl = gpu(), W = ctx.canvas.width, H = ctx.canvas.height;
  if (!gl || GPU.trOff) return false;
  let Q;
  try { Q = trProg(gl); } catch (e) { GPU.trOff = true; console.warn('GPU transitions off:', e.message); return false; }
  if (type === 'hblur' && !Q.fl) return false; // (its block sums need a float target)
  const { cv } = GPU, { U } = Q, sz = `${W}x${H}`;
  if (cv.width < W || cv.height < H) { cv.width = Math.max(cv.width, W); cv.height = Math.max(cv.height, H); }
  gl.useProgram(Q.pg);
  try {
    for (const u of [4, 5, 6]) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); } // (a layer being drawn can't also be bound)
    gl.uniform1i(U.mode, 0); gl.uniform3f(U.bg, ...hexRgb(bg)); gl.viewport(0, 0, W, H);
    for (const [j, s] of sides.entries()) {
      const vw = s.el.videoWidth || s.el.naturalWidth || s.el.width, vh = s.el.videoHeight || s.el.naturalHeight || s.el.height;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, Q.vid);
      texSource(gl, s.el, Math.max(s.dst[2] / s.src[2], s.dst[3] / s.src[3]));
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, Q.t[j]);
      if (Q.sz !== sz) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, Q.fb[j]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, Q.t[j], 0);
      gl.uniform4f(U.box, ...s.dst); gl.uniform4f(U.crop, s.src[0] / vw, s.src[1] / vh, s.src[2] / vw, s.src[3] / vh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, Q.t[0]);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, Q.t[1]);
    gl.uniform2f(U.wh, W, H);
    if (TRX[type]) { Q.sz = sz; trxPass(gl, Q, type, bg, W, H, 1 - P1); } else if (blurTrGPU(type)) { Q.sz = sz; blurTrPass(gl, Q, type, W, H, P1); } else {
    if (type === 'hblur') {
      const nb = Math.ceil(W / 32);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, Q.bs);
      if (Q.bk !== sz) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2 * nb, H, 0, gl.RGBA, gl.FLOAT, null); Q.bk = sz; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, Q.bfb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, Q.bs, 0);
      gl.viewport(0, 0, 2 * nb, H); gl.uniform1i(U.mode, 6); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.viewport(0, 0, W, H);
    }
    Q.sz = sz;
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, type === 'hblur' ? Q.bs : Q.rnd);
    if (type === 'dissolve' && Q.rk !== sz) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, frandMap(W, H)); Q.rk = sz; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const dist = Math.ceil(Math.min(P1, 1 - P1) * 50) / 50, prog = P1 <= 0.5 ? P1 * 2 : (1 - P1) * 2;
    gl.uniform1i(U.mode, TR_GPU[type]); gl.uniform1f(U.P, P1);
    gl.uniform1f(U.dist, dist); gl.uniform1f(U.sq, (2 * dist * Math.min(W, H)) / 20); gl.uniform1i(U.size, Math.trunc(1 + Math.trunc(W / 2) * prog));
    gl.uniform1f(U.s1, smoothstep(0.8, 1, P1)); gl.uniform1f(U.s2, smoothstep(0.2, 1, P1));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  } catch (e) { console.warn('GPU transition:', e.message); return false; } finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  ctx.drawImage(cv, 0, cv.height - H, W, H, 0, 0, W, H);
  return true;
}

// blur transitions (app.js TR_BLUR, zoom blur aside) on trGPU's two layers: the slide or dissolve, then a Gaussian along x or y (the export's
// gblur steps=3; blur dissolve's 3-pass boxblur of radius r as the Gaussian of the same variance, r(r+1), sideways then up-down).
// The canvas path (hblurInPlace) left WebKit drawing every later canvas effect at ~47 fps until a reload; this one reads the <video>s.
const BLUR_K = { fade: 0, slideleft: 1, slideright: 2, slideup: 3, slidedown: 4 }, blurTrGPU = type => type !== 'zoomblur' && TR_BLUR[type] in BLUR_K;
function blurTrPass(gl, Q, type, W, H, P1) { // units 4, 5: the layers (row 0 = the top) -> the default framebuffer
  const X = Q.bl ??= (() => {
    const pg = xshader(gl, gl.getAttribLocation(GPU.pg, 'p'), `${GLHEAD}uniform sampler2D ta, tb; uniform vec2 wh; uniform float P, sig; uniform int kind, fin; uniform ivec2 dir; out vec4 o;
vec3 A(ivec2 q) { return texelFetch(ta, clamp(q, ivec2(0), ivec2(wh) - 1), 0).rgb * 255.0; }
vec3 B(ivec2 q) { return texelFetch(tb, clamp(q, ivec2(0), ivec2(wh) - 1), 0).rgb * 255.0; }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy), S = ivec2(wh); if (fin == 1) q.y = S.y - 1 - q.y;
  vec3 c; int zx = int(P * wh.x), zy = int(P * wh.y);
  if (kind == 0) c = A(q) * P + B(q) * (1.0 - P); // as transition(): a*P + b*(1-P), the slides as drawn there
  else if (kind == 1) c = q.x < zx ? A(ivec2(q.x - zx + S.x, q.y)) : B(ivec2(q.x - zx, q.y));
  else if (kind == 2) c = q.x < S.x - zx ? B(ivec2(q.x + zx, q.y)) : A(ivec2(q.x - S.x + zx, q.y));
  else if (kind == 3) c = q.y < zy ? A(ivec2(q.x, q.y - zy + S.y)) : B(ivec2(q.x, q.y - zy));
  else if (kind == 4) c = q.y < S.y - zy ? B(ivec2(q.x, q.y + zy)) : A(ivec2(q.x, q.y - S.y + zy));
  else { int R = min(int(ceil(3.0 * sig)), 400); vec3 s = vec3(0.0); float ws = 0.0; // 5: a Gaussian of ta along dir, edges clamped
    for (int i = -R; i <= R; i++) { float w = exp(-float(i * i) / (2.0 * sig * sig)); s += w * A(q + dir * i); ws += w; }
    c = s / ws; }
  o = vec4(clamp(floor(c + 0.5), 0.0, 255.0) / 255.0, 1.0);
}`);
    gl.useProgram(pg); gl.uniform1i(gl.getUniformLocation(pg, 'ta'), 4); gl.uniform1i(gl.getUniformLocation(pg, 'tb'), 5);
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    const U = {}; for (const n of ['wh', 'P', 'sig', 'kind', 'fin', 'dir']) U[n] = gl.getUniformLocation(pg, n);
    return { pg, U, t, fb: gl.createFramebuffer(), sz: '' };
  })();
  const { U } = X, s = Math.sin(Math.PI * clamp(1 - P1, 0, 1)), r = Math.round(BLURF * H * s), g = Math.sqrt(r * (r + 1));
  const blurs = (type === 'blurfade' ? (r >= 1 ? [[g, 1, 0], [g, 0, 1]] : []) : type === 'whipup' || type === 'whipdown' ? [[WHIP * H * s, 0, 1]] : [[WHIP * W * s, 1, 0]]).filter(b => b[0] >= 0.5);
  gl.useProgram(X.pg); gl.uniform2f(U.wh, W, H); gl.uniform1f(U.P, P1); gl.viewport(0, 0, W, H);
  const into = (tex, fb) => { // a W x H target (unit 7 holds it while it is drawn), or the screen
    if (!tex) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.uniform1i(U.fin, 1); return; }
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (tex === X.t && X.sz !== `${W}x${H}`) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); X.sz = `${W}x${H}`; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); gl.uniform1i(U.fin, 0);
  };
  into(blurs.length ? X.t : null, X.fb); gl.uniform1i(U.kind, BLUR_K[TR_BLUR[type]]); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // the slide or dissolve
  let src = X.t;
  blurs.forEach(([sig, dx, dy], i) => { // then each blur: from src (on unit 4) into layer a's texture (free now) or the screen
    const last = i === blurs.length - 1, dst = src === X.t ? Q.t[0] : X.t;
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, src);
    into(last ? null : dst, dst === X.t ? X.fb : Q.fb[0]); gl.uniform1i(U.kind, 5); gl.uniform1f(U.sig, sig); gl.uniform2i(U.dir, dx, dy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    src = dst;
  });
}

// ---------- scopes: waveform, RGB parade, vectorscope, histogram of the preview ----------
// From a 256 px copy of the finished frame (before the selection box and guides): one small readback per update, at most
// ~15 a second while playing (paint), nothing at all while the panel is closed. ms = the last update's cost.
const SCOPE = { on: false, kind: 'wave', at: 0, ms: 0 };
const ycc = (r, g, b) => { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [y, (b - y) / 1.8556, (r - y) / 1.5748]; }; // BT.709, 0-1
function scopeFrame() {
  const cv = $('#cv'), W = 256, H = Math.max(8, Math.round((256 * cv.height) / cv.width)), sx = scratch(W, H, 'scope').getContext('2d', { willReadFrequently: true });
  sx.drawImage(cv, 0, 0, W, H);
  return { d: sx.getImageData(0, 0, W, H).data, W, H };
}
function drawScope() {
  const out = $('#scopeCv');
  if (!SCOPE.on || !out) return;
  const t0 = performance.now(), { d, W, H } = scopeFrame(), o = out.getContext('2d'), OW = out.width, OH = out.height;
  o.fillStyle = '#0e0e0f'; o.fillRect(0, 0, OW, OH);
  const img = o.getImageData(0, 0, OW, OH), px = img.data, add = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= OW || y >= OH) return; const i = (y * OW + x) * 4; px[i] = Math.min(255, px[i] + r); px[i + 1] = Math.min(255, px[i + 1] + g); px[i + 2] = Math.min(255, px[i + 2] + b); };
  const Y = v => Math.round((1 - v / 255) * (OH - 1)); // 0 IRE at the bottom row, 100 at the top
  const cx = OW / 2, cy = OH / 2, R = Math.min(cx, cy) - 4, vec = (r, g, b) => { const [, cb, cr] = ycc(r, g, b); return [cx + cb * 2 * R, cy - cr * 2 * R]; }; // 100 % saturation = the rim
  if (SCOPE.kind === 'hist') {
    const hs = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < d.length; i += 4) { hs[0][d[i]]++; hs[1][d[i + 1]]++; hs[2][d[i + 2]]++; }
    let mx = 1;
    for (const h of hs) for (let v = 2; v < 254; v++) mx = Math.max(mx, h[v]); // (clipped ends would flatten the rest)
    for (let ch = 0; ch < 3; ch++) for (let v = 0; v < 256; v++) { const x = Math.floor((v * OW) / 256), h = Math.min(OH, Math.round((hs[ch][v] / mx) * OH)); for (let y = OH - h; y < OH; y++) add(x, y, ch === 0 ? 110 : 0, ch === 1 ? 110 : 0, ch === 2 ? 130 : 0); }
  } else if (SCOPE.kind === 'wave') { // luma by column: where the brightness of each part of the frame sits
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; add(Math.floor((x * OW) / W), Y(l), 30, 30, 30); }
  } else if (SCOPE.kind === 'parade') { // the same, R, G and B side by side
    const pw = OW / 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, c = Math.floor((x * pw) / W); add(c, Y(d[i]), 60, 8, 8); add(Math.floor(pw) + c, Y(d[i + 1]), 8, 60, 8); add(Math.floor(2 * pw) + c, Y(d[i + 2]), 14, 14, 70); }
  } else { // vectorscope: hue = angle, saturation = distance
    for (let i = 0; i < d.length; i += 4) { const [x, y] = vec(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255); add(Math.round(x), Math.round(y), 34, 34, 34); }
  }
  o.putImageData(img, 0, 0);
  o.strokeStyle = 'rgba(237,237,237,.14)'; o.lineWidth = 1;
  const line = (x0, y0, x1, y1) => { o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.stroke(); };
  if (SCOPE.kind === 'vec') {
    o.beginPath(); o.arc(cx, cy, R, 0, 6.2832); o.stroke(); line(cx - R, cy, cx + R, cy); line(cx, cy - R, cx, cy + R);
    o.strokeStyle = 'rgba(237,237,237,.45)';
    for (const c of [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1]]) { const [x, y] = vec(...c.map(v => v * 0.75)); o.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7); } // 75 % colour bars
    const a = (123 * Math.PI) / 180; o.strokeStyle = 'rgba(240,178,62,.7)'; line(cx, cy, cx + Math.cos(a) * R, cy - Math.sin(a) * R); // skin tones fall on this line, whatever the skin
  } else if (SCOPE.kind === 'parade') { for (const i of [1, 2]) line(Math.floor((OW * i) / 3) + 0.5, 0, Math.floor((OW * i) / 3) + 0.5, OH); for (let i = 1; i < 4; i++) line(0, Math.round((OH * i) / 4) + 0.5, OW, Math.round((OH * i) / 4) + 0.5); }
  else for (let i = 1; i < 4; i++) line(0, Math.round((OH * i) / 4) + 0.5, OW, Math.round((OH * i) / 4) + 0.5);
  SCOPE.at = performance.now(); SCOPE.ms = SCOPE.at - t0;
}
function scopeLevels() { // the numbers behind the picture, for the MCP: luma spread in IRE, clipped share, mean R G B
  const { d } = scopeFrame(), h = new Uint32Array(256), m = [0, 0, 0], n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { h[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++; m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
  const pct = q => { let s = 0; for (let v = 0; v < 256; v++) if ((s += h[v]) >= q * n) return Math.round((v / 255) * 100); return 100; };
  let lo = 0, hi = 0; for (let v = 0; v < 256; v++) { if (v <= 4) lo += h[v]; if (v >= 251) hi += h[v]; }
  return { luma: { low: pct(0.01), median: pct(0.5), high: pct(0.99) }, clippedBlack: +((lo / n) * 100).toFixed(1), clippedWhite: +((hi / n) * 100).toFixed(1), meanRGB: m.map(v => Math.round(v / n)) };
}

// ---------- effect steps on the GPU ----------
// The film-look steps (colour matrix, RGB split, pixelate, grain) and the clip blur read and wrote every pixel in JS: a
// few effects together played at 12-19 fps. Same maths here, step by step through 8-bit textures (the canvas's own
// precision between steps), so the export's ffmpeg filters still match. No WebGL2: the JS steps run as before.
const FXG = { gl: null, failed: false };
function fxgl() {
  if (FXG.gl || FXG.failed) return FXG.gl;
  try {
    const cv = document.createElement('canvas'), gl = cv.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no WebGL2');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pg = gl.createProgram();
    gl.attachShader(pg, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
uniform sampler2D src, vid, msk; uniform sampler3D lut; uniform int mode, n, r, flipOut, useM; uniform ivec2 size, shift, dir; uniform mat3 M; uniform float s, seed, lutN, sg; uniform vec4 box, crop; uniform vec3 bgc;
out vec4 o;
vec3 at(ivec2 q) { return texelFetch(src, clamp(q, ivec2(0), size - 1), 0).rgb * 255.0; }
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
float k1(int i) { // sharpen's blur, one axis, spread sg: a sampled Gaussian, or under 0.6 px (where sampling one loses it) [w, 1-2w, w]
  if (sg >= 0.6) return exp(-float(i * i) / (2.0 * sg * sg)); // with the Gaussian's response at the finest detail (1 - 4w = exp(-pi^2 sg^2 / 2))
  float w = (1.0 - exp(-4.9348 * sg * sg)) / 4.0;
  return i == 0 ? 1.0 - 2.0 * w : abs(i) == 1 ? w : 0.0;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  if (flipOut == 1) q.y = size.y - 1 - q.y; // the canvas shows row 0 at the bottom; the textures keep the picture's top in row 0
  vec4 s0 = texelFetch(src, mode == 3 ? q / n : min(q, size - 1), 0);
  vec3 c = s0.rgb * 255.0;
  if (mode == 0) c = M * c; // colour matrix (colorchannelmixer)
  else if (mode == 1) c = vec3(at(q - ivec2(shift.x, 0)).r, c.g, at(q - ivec2(shift.y, 0)).b); // red and blue moved sideways, edges smeared (rgbashift)
  else if (mode == 2) { // pixelate, 1: q is a block; its mean, truncated (pixelize)
    ivec2 b0 = q * n; vec3 sum = vec3(0.0); float k = 0.0;
    for (int j = 0; j < 128; j++) { if (j >= n || b0.y + j >= size.y) break;
      for (int i = 0; i < 128; i++) { if (i >= n || b0.x + i >= size.x) break; sum += texelFetch(src, b0 + ivec2(i, j), 0).rgb * 255.0; k += 1.0; } }
    c = floor(sum / k);
  } // mode 3, pixelate 2: each pixel takes its block's mean (the fetch above)
  else if (mode == 4) c += (hash(vec2(q) + vec2(seed, seed * 1.7)) * 2.0 - 1.0) * s; // grain on brightness
  else if (mode == 7) { // an adjustment layer's table (gpuPass's lookup); with a mask, only where it is (the export's maskedmerge)
    vec3 g = texture(lut, (c / 255.0 * (lutN - 1.0) + 0.5) / lutN).rgb * 255.0;
    if (useM == 1) { float m = floor(texelFetch(msk, q, 0).a * 255.0 + 0.5); g = floor((floor(c + 0.5) * (255.0 - m) + floor(g + 0.5) * m + 127.0) / 255.0); }
    c = g;
  }
  else if (mode == 5) { vec3 sum = vec3(0.0); for (int i = -32; i <= 32; i++) if (i >= -r && i <= r) sum += at(q + dir * i); c = sum / float(2 * r + 1); } // one box pass (boxblur), edges clamped
  else if (mode == 10) { // sharpen like ffmpeg unsharp: c + (c - blur) * s; its binomial kernel as one of the
    vec3 sum = vec3(0.0); float wt = 0.0; // same spread (sigma sg: the export's, in this picture's pixels), r = its reach
    for (int j = -6; j <= 6; j++) { if (j < -r || j > r) continue;
      for (int i = -6; i <= 6; i++) { if (i < -r || i > r) continue; float w = k1(i) * k1(j); sum += w * at(q + ivec2(i, j)); wt += w; } }
    c += (c - sum / wt) * s; // (unrounded: at the preview's scale the correction is often under a level, which rounding would drop)
  }
  else if (mode == 8) { vec2 f = gl_FragCoord.xy; c = bgc; if (all(greaterThanEqual(f, box.xy)) && all(lessThan(f, box.xy + box.zw))) c = floor(texture(vid, crop.xy + (f - box.xy) / box.zw * crop.zw).rgb * 255.0 + 0.5); s0.a = 1.0; } // a plain picture in its box on the canvas colour (trGPU's layer)
  else if (mode == 9) { // transform: scaled by s about the centre, moved by box.xy, bilinear (runOps' drawImage); outside it the frame stays
    vec2 S = vec2(2.0 * trunc(float(size.x) * s / 2.0), 0.0); S.y = S.x * float(size.y) / float(size.x);
    vec2 u = (vec2(q) + 0.5 - (vec2(size) - S) / 2.0 - box.xy) / S * vec2(size) - 0.5;
    if (all(greaterThanEqual(u, vec2(-0.5))) && all(lessThan(u, vec2(size) - 0.5))) { ivec2 i = ivec2(floor(u)); vec2 t = u - floor(u);
      c = mix(mix(at(i), at(i + ivec2(1, 0)), t.x), mix(at(i + ivec2(0, 1)), at(i + ivec2(1, 1)), t.x), t.y); }
  }
  o = vec4(clamp(floor(c + 0.5), 0.0, 255.0) / 255.0, s0.a);
}`));
    gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
    gl.useProgram(pg);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(pg, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    for (const k of ['src', 'vid', 'msk', 'useM', 'lut', 'lutN', 'mode', 'n', 'r', 'flipOut', 'size', 'shift', 'dir', 'M', 's', 'seed', 'sg', 'box', 'crop', 'bgc']) U[k] = gl.getUniformLocation(pg, k);
    const lutT = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutT);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
    gl.uniform1i(U.src, 0); gl.uniform1i(U.lut, 1); gl.uniform1i(U.vid, 2); gl.uniform1i(U.msk, 3); gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v); return t; };
    Object.assign(FXG, { gl, cv, U, pg, lp, xp: new Map(), vidT: null, lutT, lutKey: '', mT: tex(), mKey: null, tex: [tex(), tex(), tex()], fb: [gl.createFramebuffer(), gl.createFramebuffer(), gl.createFramebuffer()], sz: [[0, 0], [0, 0], [0, 0]] });
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); FXG.gl = null; FXG.failed = false; });
    return gl;
  } catch (e) { FXG.failed = true; console.warn('GPU effects off:', e.message); return null; }
}
// src (a canvas, W x H, or { cap, bg }: a <video>/<img> in its box, drawMedia's cap) through steps [{mode, ...}] -> [the GL canvas, y of the result in it], or null (no WebGL2)
function fxGPU(src, W, H, steps) {
  const gl = fxgl();
  if (!gl) return null;
  const { cv, U, tex, fb, sz } = FXG;
  const target = (k, w, h) => { // texture k as a w x h render target
    gl.bindTexture(gl.TEXTURE_2D, tex[k]);
    if (sz[k][0] !== w || sz[k][1] !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); sz[k] = [w, h]; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[k]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[k], 0);
    gl.viewport(0, 0, w, h);
  };
  if (src.cap) { // the picture itself goes up (a video frame is a GPU copy; a 2D canvas upload cost 6-8 ms a frame), laid in its box in texture 0
    const { el, src: sr, dst } = src.cap, vw = el.videoWidth || el.naturalWidth, vh = el.videoHeight || el.naturalHeight;
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, FXG.vidT ??= (() => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v); return t; })());
    try { texSource(gl, el, Math.max(dst[2] / sr[2], dst[3] / sr[3])); } catch { gl.activeTexture(gl.TEXTURE0); return null; }
    gl.activeTexture(gl.TEXTURE0);
    target(0, W, H); gl.bindTexture(gl.TEXTURE_2D, tex[1]);
    gl.uniform1i(U.mode, 8); gl.uniform2i(U.size, W, H); gl.uniform1i(U.flipOut, 0); gl.uniform4f(U.box, ...dst); gl.uniform4f(U.crop, sr[0] / vw, sr[1] / vh, sr[2] / vw, sr[3] / vh); gl.uniform3f(U.bgc, ...hexRgb(src.bg));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, tex[0]);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { return null; }
  }
  sz[0] = [W, H];
  let cur = 0;
  gl.uniform1i(U.flipOut, 0);
  for (const st of steps) {
    const small = st.mode === 2, out = cur === 0 ? 1 : 0; // (pixelate goes through texture 2 at block size first)
    if (small) target(2, Math.ceil(W / st.n), Math.ceil(H / st.n)); else target(out, W, H);
    gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
    if (st.x) { try { fxExprStep(gl, st, W, H); cur = out; } catch (e) { console.warn('effect expression:', e.message); gl.useProgram(FXG.pg); } continue; } // (fxpack.js)
    gl.uniform1i(U.mode, st.mode); gl.uniform2i(U.size, W, H);
    if (st.M) gl.uniformMatrix3fv(U.M, false, colMajor(st.M));
    if (st.shift) gl.uniform2i(U.shift, ...st.shift);
    if (st.dir) gl.uniform2i(U.dir, ...st.dir);
    if (st.box) gl.uniform4f(U.box, ...st.box);
    if (st.G && FXG.lutKey !== st.G.key) { gl.activeTexture(gl.TEXTURE1); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, GN, GN, GN, 0, gl.RGB, gl.FLOAT, st.G.d); gl.activeTexture(gl.TEXTURE0); FXG.lutKey = st.G.key; gl.bindTexture(gl.TEXTURE_2D, tex[cur]); }
    if (st.G) gl.uniform1f(U.lutN, GN);
    gl.uniform1i(U.useM, st.M ? 1 : 0);
    if (st.M && FXG.mKey !== st.M) { // an adjustment layer's mask (maskCanvas, W x H, top row first like the textures here)
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, FXG.mT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, st.M);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[cur]); FXG.mKey = st.M;
    }
    gl.uniform1i(U.n, st.n || 1); gl.uniform1i(U.r, st.r || 0); gl.uniform1f(U.s, st.s || 0); gl.uniform1f(U.seed, (Math.random() * 1000) | 0); gl.uniform1f(U.sg, st.sg || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (small) { // pixelate, 2: back to full size from the block means
      target(out, W, H); gl.bindTexture(gl.TEXTURE_2D, tex[2]); gl.uniform1i(U.mode, 3); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    cur = out;
  }
  if (cv.width < W || cv.height < H) { cv.width = Math.max(cv.width, W); cv.height = Math.max(cv.height, H); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
  gl.bindTexture(gl.TEXTURE_2D, tex[cur]); gl.uniform1i(U.mode, 6); gl.uniform1i(U.flipOut, 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return [cv, cv.height - H];
}
const FX_GPU = { lut: o => [{ mode: 7, G: o.G, M: o.M }], matrix: o => [{ mode: 0, M: o.m.map(v => v * (o.k ?? 1)) }], rgbshift: o => [{ mode: 1, shift: [o.rh, o.bh] }], pixelize: o => [{ mode: 2, n: o.size }], noise: o => [{ mode: 4, s: o.s }], transform: o => [{ mode: 9, s: o.z, box: [o.x, o.y, 0, 0] }] };

// ---------- adjustment layer: an Effects-track clip (fx 'adjust') whose colour stage grades the composite under it ----------
// Its brightness/contrast/saturation, temperature/tint, exposure/highlights/shadows/fade, filter and grade (wheels, curves,
// HSL, LUT) are baked into ONE GN^3 table, the same way for every frame it covers. The preview looks it up on the GPU
// (fxGPU mode 7, gpuPass's trilinear lookup) or the CPU (lutPass); the export gives that table to lut3d on those frames.
const ADJUST = { n: 'Adjustment layer', d: 5 };
function adjustLUT(f) { // -> { key, d } or null (nothing to do)
  const a = f.adj || {}, b = a.b ?? 1, k = a.c ?? 1, s = a.s ?? 1, T = toneLUT(f), L = lookMatrix(f), lk = lookLutOf(f), gr = gradeOn(f.grade) || !!lk;
  if (b === 1 && k === 1 && s === 1 && !T && !L && !gr) return null;
  const lid = gr && f.grade?.lut?.id;
  if (lid && !lutLib.has(lid)) loadLut(lid);
  const key = 'adj' + JSON.stringify([b, k, s, T && T.join(), L, gr && f.grade, lk && f.look]) + (lid && !(lutLib.get(lid) instanceof Promise) ? '+' : '');
  if (!gradeCache.has(key)) { // (loadLut clears gradeCache when a LUT arrives, so this table is remade with it)
    const g = gr ? gradeFn(f.grade || {}, lk) : null, Sm = satM(s), q = v => clamp(v, 0, 255), d = new Float32Array(GN * GN * GN * 3);
    const tn = v => { const i = Math.min(254, Math.floor(v)); return T[i] + (T[i + 1] - T[i]) * (v - i); }; // the 256-entry curve between its entries
    for (let bi = 0, o = 0; bi < GN; bi++) for (let gi = 0; gi < GN; gi++) for (let ri = 0; ri < GN; ri++, o += 3) {
      let c = [ri, gi, bi].map(i => q((q((i * 255) / (GN - 1) * b) - 127.5) * k + 127.5)); // the clip colour pass's order: brightness, contrast, saturation, tone, look
      c = [0, 1, 2].map(i => q(Sm[i * 3] * c[0] + Sm[i * 3 + 1] * c[1] + Sm[i * 3 + 2] * c[2]));
      if (T) c = c.map(tn);
      if (L) c = [0, 1, 2].map(i => q(L[i * 3] * c[0] + L[i * 3 + 1] * c[1] + L[i * 3 + 2] * c[2]));
      const v = g ? g(c[0] / 255, c[1] / 255, c[2] / 255) : c.map(x => x / 255);
      d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2];
    }
    if (gradeCache.size > 24) gradeCache.delete(gradeCache.keys().next().value);
    gradeCache.set(key, { key, d });
  }
  return gradeCache.get(key);
}
const adjustOps = (f, W, H, lt) => { const G = adjustLUT(f); return G ? [{ op: 'lut', G, M: f.mask && W ? maskCanvas(maskAt(f, lt), W, H) : undefined }] : []; }; // its step in the effect list (runOps); a masked layer grades only inside its mask
function lutPass(x, W, H, G, Mk) { // the table on the CPU (no WebGL2), like lut3d interp=trilinear (Mk: the mask canvas, maskedmerge's mix)
  const img = x.getImageData(0, 0, W, H), d = img.data, L = { n: GN, d: G.d }, mm = Mk && scratch(W, H, 'lutm').getContext('2d', { willReadFrequently: true });
  if (mm) { mm.globalCompositeOperation = 'copy'; mm.drawImage(Mk, 0, 0); }
  const ma = mm && mm.getImageData(0, 0, W, H).data;
  for (let i = 0; i < d.length; i += 4) {
    const o = sampleLUT(L, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255), m = ma ? ma[i + 3] : 255;
    for (let k = 0; k < 3; k++) d[i + k] = m === 255 ? o[k] * 255 : Math.floor((d[i + k] * (255 - m) + Math.round(o[k] * 255) * m + 127) / 255);
  }
  x.putImageData(img, 0, 0);
}
