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
function gradeFn(g) { // the grade as rgb (0..1) -> rgb: wheels, then curves (master, then per channel), then HSL, then the LUT
  const L = wheelRGB(g.lift), Gm = wheelRGB(g.gamma), Gn = wheelRGB(g.gain), ll = g.lift?.l || 0, gl = g.gamma?.l || 0, nl = g.gain?.l || 0;
  const lift = L.map(v => 0.25 * ll + 0.12 * v), gain = Gn.map(v => 1 + 0.5 * nl + 0.25 * v), gam = Gm.map(v => 2 ** -(gl + 0.4 * v));
  const wheels = [lift, gain, gam].some((a, i) => a.some(v => Math.abs(v - (i ? 1 : 0)) > 1e-6));
  const cm = curveFn(g.curves?.m), cc = ['r', 'g', 'b'].map(k => curveFn(g.curves?.[k]));
  const hb = HSL_BANDS.map(([k]) => g.hsl?.[k] || {}), hsl = hb.some(b => b.h || b.s || b.l);
  const lut = g.lut?.id && lutLib.get(g.lut.id), amt = clamp(g.lut?.amount ?? 1, 0, 1), useLut = lut && !(lut instanceof Promise) && amt > 0;
  return (r, gg, b) => {
    let v = [r, gg, b];
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
  const g = c.grade;
  if (!gradeOn(g)) return null;
  if (g.lut?.id && !lutLib.has(g.lut.id)) loadLut(g.lut.id);
  const key = JSON.stringify(g) + (g.lut?.id && !(lutLib.get(g.lut.id) instanceof Promise) ? '+' : '');
  if (!gradeCache.has(key)) {
    const f = gradeFn(g), d = new Float32Array(GN * GN * GN * 3);
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
uniform vec4 crop; uniform bool flip, useTone, useLook, useLut, useKey, useMask, useColour;
uniform float bri, con, lutN, mixK, sim, blnd, vig; uniform mat3 sat, look; uniform vec3 keyC; uniform vec2 size;
vec3 r8(vec3 c) { return clamp(floor(c + 0.5), 0.0, 255.0); }
float tn(float v) { return texelFetch(tone, ivec2(int(floor(v + 0.5)), 0), 0).r * 255.0; }
void main() {
  vec2 p = uv; if (flip) p.x = 1.0 - p.x;
  vec4 s = texture(src, mix(crop.xy, crop.zw, p));
  vec3 c0 = r8(s.rgb * 255.0), c = c0;
  if (useColour) {
    c = clamp(c * bri, 0.0, 255.0); c = clamp((c - 127.5) * con + 127.5, 0.0, 255.0); c = clamp(sat * c, 0.0, 255.0);
    if (useTone) c = vec3(tn(c.r), tn(c.g), tn(c.b));
    if (useLook) c = look * c;
    c = r8(c);
    if (useLut) c = r8(texture(lut, (c / 255.0 * (lutN - 1.0) + 0.5) / lutN).rgb * 255.0);
    c = r8(c0 + (c - c0) * mixK);
  }
  float a = s.a;
  if (useKey) { vec3 d = c - keyC; float diff = sqrt(dot(d, d) / 195075.0); a *= blnd > 0.0001 ? clamp((diff - sim) / blnd, 0.0, 1.0) : (diff > sim ? 1.0 : 0.0); }
  if (useMask) a *= texture(mask, uv).a;
  if (vig > 0.0) { vec2 f = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) - 0.5; float u = clamp((length((2.0 * f + 1.0) / size - 1.0) / 1.41421356 - 0.3) / 0.75, 0.0, 1.0); c = r8(c * (1.0 - vig * u * u * (3.0 - 2.0 * u))); }
  o = vec4(c / 255.0 * a, a);
}`));
    gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
    gl.useProgram(pg);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(pg, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    for (const n of ['src', 'tone', 'mask', 'lut', 'crop', 'flip', 'useTone', 'useLook', 'useLut', 'useKey', 'useMask', 'useColour', 'bri', 'con', 'lutN', 'mixK', 'sim', 'blnd', 'vig', 'sat', 'look', 'keyC', 'size']) U[n] = gl.getUniformLocation(pg, n);
    gl.uniform1i(U.src, 0); gl.uniform1i(U.tone, 1); gl.uniform1i(U.lut, 2); gl.uniform1i(U.mask, 3);
    const t2 = (unit, filter) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    const lutT = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, lutT);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
    Object.assign(GPU, { gl, cv, U, srcT: t2(0, gl.LINEAR), toneT: t2(1, gl.NEAREST), maskT: t2(3, gl.LINEAR), lutT, toneKey: '', lutKey: '', maskKey: null });
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); GPU.gl = null; GPU.failed = false; });
    return gl;
  } catch (e) { GPU.failed = true; console.warn('GPU colour pass off:', e.message); return null; }
}
const satM = s => [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
const colMajor = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
function gpuPass(el, src, W, H, c, opt = {}) { // el's src rect -> W x H, coloured, keyed, vignetted, masked (offscreen()'s CPU work); returns [canvas, y of the result] or null
  const gl = gpu();
  if (!gl) return null;
  const { cv, U } = GPU, vw = el.videoWidth || el.naturalWidth || el.width, vh = el.videoHeight || el.naturalHeight || el.height;
  if (!vw || !vh) return null;
  if (cv.width < W || cv.height < H) { cv.width = Math.max(cv.width, W); cv.height = Math.max(cv.height, H); }
  gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, GPU.srcT);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el); } catch { return null; }
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
  gl.uniform1i(U.useMask, mk ? 1 : 0);
  if (mk) { const mc = maskCanvas(mk, W, H); if (GPU.maskKey !== mc) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, GPU.maskT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mc); GPU.maskKey = mc; } }
  gl.uniform1f(U.vig, opt.noVig ? 0 : a.vig || 0); gl.uniform2f(U.size, W, H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return [cv, cv.height - H];
}

// ---------- scopes: waveform, histogram, vectorscope of the preview ----------
const SCOPE = { on: false, kind: 'wave' };
function drawScope() {
  const out = $('#scopeCv');
  if (!SCOPE.on || !out) return;
  const cv = $('#cv'), W = 256, H = Math.max(8, Math.round((256 * cv.height) / cv.width)), sx = scratch(W, H, 'scope').getContext('2d', { willReadFrequently: true });
  sx.drawImage(cv, 0, 0, W, H);
  const d = sx.getImageData(0, 0, W, H).data, o = out.getContext('2d'), OW = out.width, OH = out.height;
  o.fillStyle = '#0b0d12'; o.fillRect(0, 0, OW, OH);
  const img = o.getImageData(0, 0, OW, OH), px = img.data, add = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= OW || y >= OH) return; const i = (y * OW + x) * 4; px[i] = Math.min(255, px[i] + r); px[i + 1] = Math.min(255, px[i + 1] + g); px[i + 2] = Math.min(255, px[i + 2] + b); };
  if (SCOPE.kind === 'hist') {
    const hs = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < d.length; i += 4) { hs[0][d[i]]++; hs[1][d[i + 1]]++; hs[2][d[i + 2]]++; }
    let mx = 1;
    for (const h of hs) for (let v = 2; v < 254; v++) mx = Math.max(mx, h[v]);
    for (let ch = 0; ch < 3; ch++) for (let v = 0; v < 256; v++) { const x = Math.floor((v * OW) / 256), h = Math.min(OH, Math.round((hs[ch][v] / mx) * OH)); for (let y = OH - h; y < OH; y++) add(x, y, ch === 0 ? 110 : 0, ch === 1 ? 110 : 0, ch === 2 ? 130 : 0); }
  } else if (SCOPE.kind === 'wave') { // luma by column: where the brightness of each part of the frame sits
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; add(Math.floor((x * OW) / W), Math.round((1 - l / 255) * (OH - 1)), 22, 44, 22); }
  } else { // vectorscope: hue = angle, saturation = distance (BT.709 Cb/Cr)
    const cx = OW / 2, cy = OH / 2, R = Math.min(cx, cy) - 4;
    for (let i = 0; i < d.length; i += 4) { const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, yy = 0.2126 * r + 0.7152 * g + 0.0722 * b, cb = (b - yy) / 1.8556, cr = (r - yy) / 1.5748; add(Math.round(cx + cb * 2 * R), Math.round(cy - cr * 2 * R), 34, 34, 34); }
  }
  o.putImageData(img, 0, 0);
  o.strokeStyle = 'rgba(255,255,255,.12)'; o.lineWidth = 1;
  if (SCOPE.kind === 'vec') { o.beginPath(); o.arc(OW / 2, OH / 2, Math.min(OW, OH) / 2 - 4, 0, 6.2832); o.stroke(); }
  else for (let i = 1; i < 4; i++) { o.beginPath(); o.moveTo(0, Math.round((OH * i) / 4) + 0.5); o.lineTo(OW, Math.round((OH * i) / 4) + 0.5); o.stroke(); }
}
