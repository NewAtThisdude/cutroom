// SPDX-License-Identifier: GPL-3.0-or-later
// Cutroom effects pack: per-pixel transitions and effects written ONCE as ffmpeg-style expressions, compiled to GLSL for the
// preview (trGPU / fxGPU in grade.js) and to ffmpeg geq expressions for the export; and film
// looks as rgb -> rgb maths baked into the clip's one grade table (the export's lut3d). Page only (after grade.js, draw.js).
//
// The expression language is ffmpeg's (numbers, + - * /, unary -, and if ifnot lt lte gt gte eq between min max abs floor
// ceil trunc sqrt exp log sin cos tan atan atan2 mod pow clip hypot), plus macros (XMAC and each item's defs, expanded before
// either target sees them) and these names: X Y W H (pixel, frame size), PI, p (transition progress 0 -> 1), n (effect frame
// since its start), K(r, g, b) (this channel's value of the three), and fetches of a pixel's 0..255 value: a(x, y) / b(x, y)
// (this channel of the outgoing / incoming picture), ar ag ab br bg bb (one channel), s(x, y) and sr sg sb (an effect's
// source). Fetches clamp to the frame and truncate to whole pixels, like geq's nearest sampling; the result is
// clipped to 0..255 and truncated, as ffmpeg stores it. Where the two can differ: float32 (GPU) vs double (ffmpeg) at hard
// edges (one pixel either way), and effects whose detail is in whole pixels at the export size (scan lines, edge taps) are
// drawn at the preview canvas's size.
'use strict';
const XFN = { if: 3, ifnot: 3, lt: 2, lte: 2, gt: 2, gte: 2, eq: 2, between: 3, min: 2, max: 2, abs: 1, floor: 1, ceil: 1, trunc: 1, sqrt: 1, exp: 1, log: 1, sin: 1, cos: 1, tan: 1, atan: 1, atan2: 2, mod: 2, pow: 2, clip: 3, hypot: 2 };
const XFETCH = { a: 'A', b: 'B', ar: 'A', ag: 'A', ab: 'A', br: 'B', bg: 'B', bb: 'B', s: 'S', sr: 'S', sg: 'S', sb: 'S' }; // -> the GLSL fetch helper
const XMAC = {
  u: 'X/W', v: 'Y/H', asp: 'W/H', cx: '(X-W/2)/H', cy: '(Y-H/2)/H', // centred coordinates in frame heights
  'sst(t)': 't*t*(3-2*t)', 'ss(e0,e1,x)': 'sst(clip((x-e0)/(e1-e0),0,1))', 'mix(a0,b0,t)': 'a0+(b0-a0)*t', 'in01(x)': 'between(x,0,1)',
  'hash(k)': 'mod(mod(k,251)*mod(k,251)*7+mod(k,251)*131+89,1013)/1013', // 0..1 from a whole number: exact in float32 too
  'la(x,y)': '0.2126*ar(x,y)+0.7152*ag(x,y)+0.0722*ab(x,y)', 'ls(x,y)': '0.2126*sr(x,y)+0.7152*sg(x,y)+0.0722*sb(x,y)', // BT.709 luma
};
function xparse(src) { // -> AST: ['n', v] ['v', name] ['f', name, args] ['+' | '-' | '*' | '/', l, r] ['neg', x]
  const T = [];
  let used = 0;
  for (const m of src.matchAll(/\s*(?:(\d+\.?\d*|\.\d+)|([A-Za-z_]\w*)|([-+*/(),]))/gy)) { used += m[0].length; T.push(m[1] ? ['n', +m[1]] : m[2] ? ['id', m[2]] : ['op', m[3]]); }
  if (src.slice(used).trim()) throw new Error(`bad expression near "${src.slice(used, used + 12)}"`);
  let i = 0;
  const peek = v => T[i]?.[0] === 'op' && T[i][1] === v, eat = v => { if (!peek(v)) throw new Error(`expected ${v} in ${src}`); i++; };
  const prim = () => {
    const t = T[i++];
    if (!t) throw new Error(`unexpected end of ${src}`);
    if (t[0] === 'n') return t;
    if (t[0] === 'op' && t[1] === '(') { const e = add(); eat(')'); return e; }
    if (t[0] === 'op' && t[1] === '-') return ['neg', prim()];
    if (t[0] !== 'id') throw new Error(`unexpected ${t[1]} in ${src}`);
    if (!peek('(')) return ['v', t[1]];
    i++;
    const args = [];
    if (!peek(')')) do args.push(add()); while (peek(',') && ++i);
    eat(')');
    return ['f', t[1], args];
  };
  const mul = () => { let l = prim(); while (peek('*') || peek('/')) { const op = T[i++][1]; l = [op, l, prim()]; } return l; };
  function add() { let l = mul(); while (peek('+') || peek('-')) { const op = T[i++][1]; l = [op, l, mul()]; } return l; }
  const e = add();
  if (i < T.length) throw new Error(`trailing ${T[i][1]} in ${src}`);
  return e;
}
const xmacros = defs => { // { 'name' | 'name(a,b)': body } -> name -> [params, body AST]
  const out = new Map();
  for (const [k, body] of Object.entries({ ...XMAC, ...defs })) { const m = k.match(/^(\w+)(?:\(([\w,]*)\))?$/); out.set(m[1], [m[2] === undefined ? null : m[2].split(','), xparse(String(body))]); }
  return out;
};
// Macros are inlined, except that a value used more than once is worked out once per pixel: an item's own definitions and
// a macro argument its body repeats become lets (['ld', i]: ffmpeg st()/ld(), of which it has 10; GLSL locals). Inlined, the
// repeats nested: halftone's expression was 12 kB a channel and its 4 s took 21 minutes to export at 1080p.
const xsize = n => (n[0] === 'n' || n[0] === 'v' || n[0] === 'ld' ? 1 : n[0] === 'f' ? 1 + n[2].reduce((s, a) => s + xsize(a), 0) : n[0] === 'neg' ? 1 + xsize(n[1]) : 1 + xsize(n[1]) + xsize(n[2]));
const xuses = (n, name) => (n[0] === 'v' ? +(n[1] === name) : n[0] === 'f' ? n[2].reduce((s, a) => s + xuses(a, name), 0) : n[0] === 'neg' ? xuses(n[1], name) : n[0] === 'n' ? 0 : xuses(n[1], name) + xuses(n[2], name));
function xlet(body, L, name) { // -> ['ld', i] for a body worth keeping (room permitting), else the body itself
  if (name && L.idx.has(name)) return ['ld', L.idx.get(name)];
  if (xsize(body) <= 4 || L.list.length >= 10) return body;
  L.list.push(body);
  if (name) L.idx.set(name, L.list.length - 1);
  return ['ld', L.list.length - 1];
}
function xexpand(node, mac, L, env = {}, depth = 0) { // -> a tree of built-ins and lets (L.list)
  if (depth > 40) throw new Error('macros nest too deep');
  if (++L.n > 50000) throw new Error('expression too complex'); // (an imported file's defs can double at every step)
  const k = node[0], rec = x => xexpand(x, mac, L, env, depth);
  if (k === 'n') return node;
  if (k === 'v') {
    if (node[1] in env) return env[node[1]];
    const m = mac.get(node[1]);
    if (!m || m[0]) return node;
    if (L.own.has(node[1])) return L.idx.has(node[1]) ? ['ld', L.idx.get(node[1])] : xlet(xexpand(m[1], mac, L, {}, depth + 1), L, node[1]);
    return xexpand(m[1], mac, L, {}, depth + 1);
  }
  if (k === 'f') {
    const args = node[2].map(rec), m = mac.get(node[1]);
    if (m && m[0]) return xexpand(m[1], mac, L, Object.fromEntries(m[0].map((p, j) => [p, xuses(m[1], p) > 1 ? xlet(args[j], L) : args[j]])), depth + 1);
    return ['f', node[1], args];
  }
  return k === 'neg' ? ['neg', rec(node[1])] : [k, rec(node[1]), rec(node[2])];
}
const xnum = v => { const s = (+(+v).toFixed(7)).toString(); return s.includes('e') ? '0' : s; }; // plain decimals both sides
function xglsl(node, c) { // GLSL for channel c (0 r, 1 g, 2 b)
  const g = x => xglsl(x, c), k = node[0];
  if (k === 'n') { const s = xnum(node[1]); return s.includes('.') ? s : `${s}.0`; }
  if (k === 'v') { const v = { X: 'X', Y: 'Y', W: 'W', H: 'H', PI: '3.141592653589793', p: 'pr', n: 'nf' }[node[1]]; if (!v) throw new Error(`unknown name ${node[1]}`); return v; }
  if (k === 'neg') return `(-${g(node[1])})`;
  if (k === 'ld') return `L${c}_${node[1]}`;
  if (k !== 'f') return `(${g(node[1])}${k}${g(node[2])})`;
  const [, f, a] = node, A = a.map(g);
  if (XFETCH[f]) return `F${XFETCH[f]}(${A[0]},${A[1]}).${f.length > 1 ? f[1] : 'rgb'[c]}`; // (the helpers add 0.001, as xff does)
  if (f === 'K') return A[c];
  if (XFN[f] !== a.length) throw new Error(`${f}() takes ${XFN[f] ?? 'no'} arguments`);
  const cmp = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '==' }[f];
  if (cmp) return `float(${A[0]}${cmp}${A[1]})`;
  if (f === 'if') return `(${A[0]}!=0.0?${A[1]}:${A[2]})`;
  if (f === 'ifnot') return `(${A[0]}!=0.0?${A[2]}:${A[1]})`;
  if (f === 'between') return `float(${A[0]}>=${A[1]}&&${A[0]}<=${A[2]})`;
  if (f === 'floor') return `floor(${A[0]}+0.0001)`; // (as xff: a grid line that is whole in double maths can be just under it in float32)
  if (f === 'hypot') return `length(vec2(${A[0]},${A[1]}))`;
  return `${{ clip: 'clamp', atan2: 'atan', mod: 'xmod' }[f] || f}(${A.join(',')})`;
}
function xff(node, c, fetch, V) { // the ffmpeg expression for channel c; fetch(name, c, x, y) writes a pixel fetch; V: names to write otherwise
  const g = x => xff(x, c, fetch, V), k = node[0];
  if (k === 'n') return xnum(node[1]);
  if (k === 'v') { const v = { X: 'X', Y: 'Y', W: 'W', H: 'H', PI: 'PI', n: 'LF', ...V }[node[1]]; if (!v) throw new Error(`unknown name ${node[1]}`); return v; } // LF: the server writes (N - the step's first frame)
  if (k === 'neg') return `(-${g(node[1])})`;
  if (k === 'ld') return `ld(${node[1]})`;
  if (k !== 'f') return `(${g(node[1])}${k}${g(node[2])})`;
  const [, f, a] = node, A = a.map(g);
  if (XFETCH[f]) return fetch(f, c, `${A[0]}+0.001`, `${A[1]}+0.001`); // a coordinate that is a whole number in double maths can be 1e-7 under it in float32: both truncate after +0.001
  if (f === 'K') return A[c];
  if (XFN[f] !== a.length) throw new Error(`${f}() takes ${XFN[f] ?? 'no'} arguments`);
  if (f === 'floor') return `floor(${A[0]}+0.0001)`;
  return `${f}(${A.join(',')})`;
}
const xtree = (src, defs) => { const L = { own: new Set(Object.keys(defs).filter(k => !k.includes('('))), idx: new Map(), list: [], n: 0 }, e = xexpand(xparse(src), xmacros(defs), L); return { e, lets: L.list }; };
const xffc = (T, c, fetch, V) => (T.lets.length ? `(${T.lets.map((b, i) => `st(${i},${xff(b, c, fetch, V)})`).join(';')};${xff(T.e, c, fetch, V)})` : xff(T.e, c, fetch, V)); // one channel for ffmpeg, lets first
const RGB3 = 'rgb', chOf = (f, c) => RGB3[f.length > 1 ? RGB3.indexOf(f[1]) : c]; // a fetch's channel: its own letter, else this channel

// ---------- transitions: p runs 0 -> 1 (xfade's P is 1 - p); BG = the canvas colour where neither picture is ----------
const TRX = {
  flashwhite: { n: 'Flash', defs: { fl: 'max(0,1-abs(2*p-1)*2.5)', cut: 'mix(a(X,Y),b(X,Y),ss(0.46,0.54,p))' }, e: 'cut+(255-cut)*fl*(2-fl)' },
  flashblack: { n: 'Flash black', defs: { fl: 'max(0,1-abs(2*p-1)*2.5)', cut: 'mix(a(X,Y),b(X,Y),ss(0.46,0.54,p))' }, e: 'cut*(1-fl*(2-fl))' },
  lightleak: { n: 'Light leak', defs: { base: 'mix(a(X,Y),b(X,Y),ss(0.25,0.75,p))', gx: '-0.35+1.7*p', d2: '((u-gx)*asp)*((u-gx)*asp)+(v-0.35)*(v-0.35)',
    g: 'clip((exp(-d2*3)*1.15+0.35*(1-v))*sin(PI*p),0,1)', core: 'exp(-d2*12)', col: 'K(255,150+90*core,60+150*core)' }, e: 'base+g*(col-base*col/255)' }, // screen of a warm glow sweeping across
  filmburn: { n: 'Film burn', defs: { base: 'mix(a(X,Y),b(X,Y),ss(0.42,0.58,p))', d: 'hypot((u-0.72)*asp,v-0.42)+0.06*sin(v*19+u*7)+0.04*sin(u*31-v*13)',
    h: 'clip((1.9*ss(0,0.55,p)-d)/0.35,0,1)*(1-ss(0.55,1,p))', col: 'K(255,90+165*h,20+200*h*h)' }, e: 'base+h*(col-base*col/255)' },
  cube: { n: 'Cube', defs: { e: '1-p', zf: '1-0.18*sin(PI*p)', ta: 'u/max(e,0.0001)', sva: '0.5+(v-0.5)/(zf*(1-0.35*p*(1-ta)))',
    tb: '(u-e)/max(1-e,0.0001)', svb: '0.5+(v-0.5)/(zf*(1-0.35*(1-p)*tb))' },
    e: 'if(lt(u,e),if(in01(sva),a(ta*W,sva*H)*(1-0.45*p),BG),if(in01(svb),b(tb*W,svb*H)*(0.55+0.45*p),BG))' }, // a face turning away, the next turning in
  flip: { n: 'Flip', defs: { w: 'max(abs(cos(PI*p)),0.001)', su: '0.5+(u-0.5)/w', sv: '0.5+(v-0.5)/(1-0.12*sin(PI*p))' },
    e: 'if(in01(su)*in01(sv),if(lt(p,0.5),a(su*W,sv*H),b(su*W,sv*H))*(0.6+0.4*abs(cos(PI*p))),BG)' },
  punchin: { n: 'Zoom punch', defs: { za: '1+3*p*p', zb: '1+3*(1-p)*(1-p)' }, e: 'mix(a((0.5+(u-0.5)/za)*W,(0.5+(v-0.5)/za)*H),b((0.5+(u-0.5)/zb)*W,(0.5+(v-0.5)/zb)*H),ss(0.4,0.6,p))' },
  zoomout: { n: 'Zoom out', defs: { za: '1-0.7*ss(0,1,p)', sua: '0.5+(u-0.5)/za', sva: '0.5+(v-0.5)/za', zb: '1+0.25*(1-p)', bz: 'b((0.5+(u-0.5)/zb)*W,(0.5+(v-0.5)/zb)*H)' },
    e: 'mix(if(in01(sua)*in01(sva),a(sua*W,sva*H),bz),bz,ss(0.7,1,p))' },
  spin: { n: 'Spin', defs: { ta: 'PI*p', tb: 'PI*(p-1)', z: '1+1.2*sin(PI*p)', dx: 'X-W/2', dy: 'Y-H/2',
    xa: '(dx*cos(ta)+dy*sin(ta))/z+W/2', ya: '(dy*cos(ta)-dx*sin(ta))/z+H/2', xb: '(dx*cos(tb)+dy*sin(tb))/z+W/2', yb: '(dy*cos(tb)-dx*sin(tb))/z+H/2' },
    e: 'mix(if(in01(xa/W)*in01(ya/H),a(xa,ya),BG),if(in01(xb/W)*in01(yb/H),b(xb,yb),BG),ss(0.45,0.55,p))' },
  glitchcut: { n: 'Glitch', defs: { band: 'floor(v*18)', st: 'floor(p*14)', hb: 'hash(band*7+st*13+3)', hc: 'hash(band*11+st*5+1)', amp: 'sin(PI*p)',
    xs: 'X+(hb-0.5)*0.22*W*amp*lt(hc,0.55)+K(-1,0,1)*0.012*W*amp' }, e: 'if(gt(p,0.3+0.4*hc),b(xs,Y),a(xs,Y))' }, // bands jump sideways and switch at their own moment
  rgbsplit: { n: 'RGB split', defs: { d: '0.06*W*sin(PI*p)*K(-1,0,1)' }, e: 'mix(a(X+d,Y),b(X+d,Y),ss(0.3,0.7,p))' },
  lumafade: { n: 'Luma fade', defs: { t: '(p*1.24-0.12)*255' }, e: 'mix(a(X,Y),b(X,Y),ss(-15,15,t-la(X,Y)))' }, // the darkest parts of a go first
  stretch: { n: 'Stretch', defs: { sa: '1+4*p*p', sb: '1+4*(1-p)*(1-p)' }, e: 'mix(a((0.5+(u-0.5)/sa)*W,Y),b((0.5+(u-0.5)/sb)*W,Y),ss(0.35,0.65,p))' },
  ink: { n: 'Ink wipe', defs: { f: 'u+0.08*sin(v*17+u*5)+0.05*sin(v*41-u*23)+0.03*sin(u*67+v*29)+0.02*sin(v*97+u*11)', e: '1.44*p-0.22' },
    e: 'mix(a(X,Y),b(X,Y),ss(e+0.02,e-0.02,f))*(1-0.55*exp(-(f-e)*(f-e)*4000))' }, // a ragged painted edge, darker where it is wet
  heart: { n: 'Heart', defs: { r: 'max(2.4*p*p,0.001)', hx: 'cx/r', hy: '0.1-cy/r', q: 'hx*hx+hy*hy-1' }, e: 'if(lte(q*q*q-hx*hx*hy*hy*hy,0),b(X,Y),a(X,Y))' }, // (x²+y²-1)³ = x²y³
  star: { n: 'Star', defs: { k: 'mod(atan2(cy,cx)+PI/2+2*PI,2*PI/5)/(2*PI/5)', t: 'abs(2*k-1)' }, e: 'if(lt(hypot(cx,cy),2.8*p*(0.4+0.6*t*t*t)),b(X,Y),a(X,Y))' },
  diamond: { n: 'Diamond', defs: { r: '1.5*p-0.02' }, e: 'mix(a(X,Y),b(X,Y),ss(r+0.01,r-0.01,abs(cx)+abs(cy)))' },
  pagecurl: { n: 'Page curl', defs: { qx: 'X/H', qy: 'Y/H', s: '(asp-qx+1-qy)*0.7071068', f: '(asp+1)*0.7071068*1.02*ss(0,1,p)', k: '(s-f)*1.4142136', fx: 'qx+k', fy: 'qy+k' },
    e: 'if(lt(s,f),b(X,Y)*(1-0.35*exp((s-f)*25)),if(lt(s,2*f)*lte(fx,asp)*lte(fy,1),(0.35*a(fx*H,fy*H)+0.65*232)*(1-0.3*(s-f)/max(f,0.001)),a(X,Y)))' }, // the corner folds over: its back is the page mirrored, paper-light
  wave: { n: 'Wave', defs: { amp: 'sin(PI*p)', dx: '0.035*W*amp*sin(v*18+p*12)', dy: '0.025*H*amp*sin(u*14-p*9)' }, e: 'mix(a(X+dx,Y+dy),b(X+dx,Y+dy),ss(0.3,0.7,p))' },
  tiles: { n: 'Tiles', defs: { h: 'hash(floor(u*16)*9+floor(v*9)+5)' }, e: 'mix(a(X,Y),b(X,Y),ss(h*0.7,h*0.7+0.3,p))' },
};
const bgK = bg => { const [r, g, b] = hexRgb(bg || '#000000'); return `K(${r},${g},${b})`; };
const trxTree = (type, bg) => xtree(TRX[type].e, { ...TRX[type].defs, BG: bgK(bg) });
// The export runs a transition through geq, not xfade's custom expression: xfade's one expression is shared by its threads, so
// st()/ld() lets race (garbage), and without them or threads a 1 s transition took minutes. Its overlap frames come stacked, a
// over b (W x 2H): the expressions see H as half the height, p as N / TO (the server writes the overlap's frame count).
function trxFF(type, bg) { // -> { er, eg, eb }
  const T = trxTree(type, bg), half = y => `clip(${y},0,H/2-1)`;
  const fetch = (f, c, x, y) => `${chOf(f, c)}(${x},${f[0] === 'b' ? `${half(y)}+H/2` : half(y)})`;
  return Object.fromEntries([0, 1, 2].map(c => [`e${RGB3[c]}`, `if(lt(Y,H/2),clip(${xffc(T, c, fetch, { H: '(H/2)', p: '(N/TO)' })},0,255),0)`]));
}
const trPlan = (type, frames) => (TRX[type] ? (P.alpha ? { type: 'fade', frames } : { type, frames, expr: trxFF(type, P.bg) }) : { type, frames }); // (transparent: a dissolve, as the preview shows it)
const GLHEAD = '#version 300 es\nprecision highp float; precision highp int;\n' // mod: the GPU's x - y floor(x / y) can land a whole y off (its division is a reciprocal), ffmpeg's can't
  + 'float xmod(float a, float b) { float m = a - b * floor(a / b); return m >= b ? m - b : m < 0.0 ? m + b : m; }\n';
function xshader(gl, loc, fs) { // -> a linked program with attribute 'p' at loc (the caller's vertex buffer)
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pg = gl.createProgram();
  gl.attachShader(pg, sh(gl.VERTEX_SHADER, `${GLHEAD}in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`));
  gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(pg, loc, 'p');
  gl.linkProgram(pg);
  if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
  return pg;
}
const xout = T => `${[0, 1, 2].map(c => T.lets.map((b, i) => `float L${c}_${i} = ${xglsl(b, c)};`).join(' ')).join('\n')}\n  vec3 xv = vec3(${[0, 1, 2].map(c => xglsl(T.e, c)).join(', ')});`; // lets, then the three channels as xv
function trxPass(gl, Q, type, bg, W, H, p) { // trGPU's two layers (units 4, 5; row 0 = the top) -> the transition, in the default framebuffer
  const key = `${type}|${bg}`;
  let X = (Q.x ??= new Map()).get(key);
  if (!X) {
    const pg = xshader(gl, gl.getAttribLocation(GPU.pg, 'p'), `${GLHEAD}uniform sampler2D ta, tb; uniform vec2 wh; uniform float pr; out vec4 o;
vec3 FA(float x, float y) { return texelFetch(ta, ivec2(clamp(x + 0.001, 0.0, wh.x - 1.0), clamp(y + 0.001, 0.0, wh.y - 1.0)), 0).rgb * 255.0; }
vec3 FB(float x, float y) { return texelFetch(tb, ivec2(clamp(x + 0.001, 0.0, wh.x - 1.0), clamp(y + 0.001, 0.0, wh.y - 1.0)), 0).rgb * 255.0; }
void main() { float X = floor(gl_FragCoord.x), Y = wh.y - 1.0 - floor(gl_FragCoord.y), W = wh.x, H = wh.y;
  ${xout(trxTree(type, bg))}
  o = vec4(floor(clamp(xv, 0.0, 255.0)) / 255.0, 1.0); }`);
    gl.useProgram(pg); gl.uniform1i(gl.getUniformLocation(pg, 'ta'), 4); gl.uniform1i(gl.getUniformLocation(pg, 'tb'), 5);
    X = { pg, wh: gl.getUniformLocation(pg, 'wh'), pr: gl.getUniformLocation(pg, 'pr') };
    Q.x.set(key, X);
  }
  gl.useProgram(X.pg); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
  gl.uniform2f(X.wh, W, H); gl.uniform1f(X.pr, p);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---------- video effects as expressions (their FX entries in draw.js return { op: 'expr', k, amt, n }) ----------
const EXF = {
  leaks: { defs: { t: 'n*0.02', g1x: '0.2+0.6*(0.5+0.5*sin(t*1.3))', g1y: '0.25+0.15*sin(t*0.9+1)', g2x: '0.8-0.5*(0.5+0.5*sin(t*0.8+2))', g2y: '0.75+0.15*sin(t*1.1)',
    k1: 'min(amt,1.5)*0.85*exp(-(((u-g1x)*asp)*((u-g1x)*asp)+(v-g1y)*(v-g1y))*3.5)*(0.75+0.25*sin(t*2.3))', k2: 'min(amt,1.5)*0.6*exp(-(((u-g2x)*asp)*((u-g2x)*asp)+(v-g2y)*(v-g2y))*5)',
    c1: 'K(255,140,50)', c2: 'K(255,70,110)', s1: 's(X,Y)+k1*(c1-s(X,Y)*c1/255)' }, e: 's1+k2*(c2-s1*c2/255)' }, // two warm glows drifting, screened on
  chroma: { defs: { k: '1+K(0.02,0,-0.02)*min(amt,2)' }, e: 's(W/2+(X-W/2)/k,H/2+(Y-H/2)/k)' }, // red a little larger, blue a little smaller, about the centre
  edges: { defs: { d: 'max(1,H/540)', gx: 'ls(X+d,Y)-ls(X-d,Y)', gy: 'ls(X,Y+d)-ls(X,Y-d)', ed: 'min(255,(abs(gx)+abs(gy))*2.2*min(amt,2))' }, e: 's(X,Y)*0.35+ed*K(90,225,255)/255' },
  halftone: { defs: { c: 'H/60', gx: '(floor(X/c)+0.5)*c', gy: '(floor(Y/c)+0.5)*c', rad: 'c*0.72*sqrt(max(0,1-ls(gx,gy)/255))', w: 'ss(rad-0.8,rad+0.8,hypot(X+0.5-gx,Y+0.5-gy))' },
    e: 'mix(s(X,Y),mix(K(25,22,30),K(245,238,222),w),min(amt,1))' }, // ink dots on paper, as big as the cell is dark
  posterize: { defs: { L: 'floor(max(2,7-3*min(amt,1.5)))' }, e: 'floor(s(X,Y)*L/256)*255/(L-1)' },
  kaleido: { defs: { r: 'hypot(X-W/2,Y-H/2)*0.55', seg: 'PI/3', a2: 'abs(mod(atan2(Y-H/2,X-W/2)+n*0.012*min(amt,2)+4*PI,seg)-seg/2)' }, e: 's(W/2+r*cos(a2),H/2+r*sin(a2))' }, // six mirrored wedges, turning
  tunnel: { defs: { dx: 'X-W/2', dy: 'Y-H/2', m: 'max(max(abs(dx)/(W/2),abs(dy)/(H/2)),0.0001)', t: 'mod(n*0.015*min(amt,2),1)', j: 'floor(log(m)/log(0.7)+t)', k: 'pow(0.7,j-t)' },
    e: 's(W/2+dx/k,H/2+dy/k)*(1-0.07*min(j,8))' }, // the frame inside itself, 0.7x each time, flying in
  datamosh: { defs: { st: 'floor(n/3)', bx: 'floor(u*12)', by: 'floor(v*8)', on: 'lt(hash(by*3+st*11+2),0.5*min(amt,1.6))',
    dx: '(hash(bx*8+by+st*29)-0.5)*0.14*W*on', dy: '(hash(bx*5+by*13+st*17+7)-0.5)*0.06*H*on' }, e: 's(X-dx+K(0,3,6)*H/1080*on,Y-dy)' }, // block rows smeared from elsewhere (no real motion vectors)
  oldtv: { defs: { r2: 'cx*cx+cy*cy', k: '1+0.16*r2', sx: 'W/2+(X-W/2)*k', sy: 'H/2+(Y-H/2)*k', ry: 'v-mod(n*0.008,1.3)+0.15',
    c0: 'mix(s(sx,sy),ls(sx,sy),0.55)*(0.8+0.2*sin(v*PI*480))*(1+0.1*exp(-ry*ry*60))*(1-0.55*ss(0.25,0.75,r2))' },
    e: 'mix(s(X,Y),if(in01(sx/W)*in01(sy/H),c0,0),min(amt,1))' }, // bulged glass, faded colour, scan lines, a rolling bar
  nightvision: { e: 'mix(s(X,Y),min(255,ls(X,Y)*1.9+18)*K(0.18,1,0.32)*(1-0.85*ss(0.3,0.95,hypot(cx,cy)))*(0.9+0.1*sin(v*PI*400)),min(amt,1))' },
  thermal: { defs: { t: 'ls(X,Y)/255', R: 'clip(2.2*t-0.35,0,1)', G: 'clip(2.5*t-1.4,0,1)', B: 'clip(1-abs(t-0.3)*3.5,0,1)*0.9+clip(t*4-3.2,0,1)' },
    e: 'mix(s(X,Y),255*min(1,K(R,G,B)),min(amt,1))' }, // brightness as an iron-bow palette: black, violet, red, orange, white
};
const exTree = (k, amt) => xtree(EXF[k].e, { ...EXF[k].defs, amt: xnum(amt) });
const xop = (k, f, lt) => ({ op: 'expr', k, amt: +clamp(f.amt, 0.1, 2).toFixed(3), n: fxFrame(lt) }); // an FX px() step
function fxGeq(k, amt) { const T = exTree(k, amt); return Object.fromEntries([0, 1, 2].map(c => [`e${RGB3[c]}`, `clip(${xffc(T, c, (f, cc, x, y) => `${chOf(f, cc)}(${x},${y})`)},0,255)`])); } // geq's r, g, b as er, eg, eb (a and b are the step's frames)
function fxExprStep(gl, st, W, H) { // one expression step inside fxGPU: source on unit 0, target bound
  const key = `${st.k}|${st.amt}`;
  let X = FXG.xp.get(key);
  if (!X) {
    const pg = xshader(gl, FXG.lp, `${GLHEAD}uniform sampler2D src; uniform ivec2 size; uniform float nf; out vec4 o;
vec3 FS(float x, float y) { return texelFetch(src, ivec2(clamp(x + 0.001, 0.0, float(size.x) - 1.0), clamp(y + 0.001, 0.0, float(size.y) - 1.0)), 0).rgb * 255.0; }
void main() { float X = floor(gl_FragCoord.x), Y = floor(gl_FragCoord.y), W = float(size.x), H = float(size.y); float a = texelFetch(src, ivec2(X, Y), 0).a;
  ${xout(exTree(st.k, st.amt))}
  o = vec4(floor(clamp(xv, 0.0, 255.0)) / 255.0, a); }`); // (rows as the textures keep them: the top first)
    gl.useProgram(pg); gl.uniform1i(gl.getUniformLocation(pg, 'src'), 0);
    X = { pg, size: gl.getUniformLocation(pg, 'size'), nf: gl.getUniformLocation(pg, 'nf') };
    if (FXG.xp.size > 32) FXG.xp.delete(FXG.xp.keys().next().value);
    FXG.xp.set(key, X);
  }
  gl.useProgram(X.pg); gl.uniform2i(X.size, W, H); gl.uniform1f(X.nf, st.n || 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.useProgram(FXG.pg); gl.uniform2i(FXG.U.size, W, H); // (fxGPU's last pass reads size: an expression alone never set it)
}
FX_GPU.expr = o => [{ x: true, k: o.k, amt: o.amt, n: o.n }];

// ---------- film looks: rgb 0..1 -> rgb, baked into the clip's grade table (gradeLUT), which the export's lut3d uses as is ----------
const Y709 = v => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const LK = {
  sat: (v, s) => { const y = Y709(v); return v.map(x => y + (x - y) * s); }, // saturation about BT.709 luma
  con: (v, k, m = 0.5) => v.map(x => m + (x - m) * k), // linear contrast about m
  sc: (v, k) => v.map(x => x + (x * x * (3 - 2 * x) - x) * k), // S-curve: toward smoothstep(x) by k (k < 0 flattens)
  lgg: (v, L, G, N) => v.map((x, i) => Math.max(0, x * N[i] + L[i] * (1 - x)) ** (1 / G[i])), // lift, gamma, gain per channel
  split: (v, sh, hi) => { const w = smoothstep(0, 1, Y709(v)); return v.map((x, i) => x + sh[i] * (1 - w) + hi[i] * w); }, // split toning by luma
  fade: (v, lo, hi = 1) => v.map(x => lo + x * (hi - lo)), // blacks lifted to lo, whites held at hi
  mono: (v, w = [0.2126, 0.7152, 0.0722]) => { const y = w[0] * v[0] + w[1] * v[1] + w[2] * v[2]; return [y, y, y]; },
  mul: (v, m) => v.map((x, i) => x * m[i]),
  aces: (v, ex) => v.map(x => { const l = s2l(clamp(x, 0, 1)) * ex; return l2s(clamp((l * (2.51 * l + 0.03)) / (l * (2.43 * l + 0.59) + 0.14), 0, 1)); }), // ACES filmic (Narkowicz 2015) in linear light
  ov: (v, y) => v.map(x => (x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y))), // overlay of a grey y
  mix: (a, b, t) => a.map((x, i) => x + (b[i] - x) * t),
};
const LOOK_LUT = { // name -> { n: label, f: rgb -> rgb }: each a short chain of the steps above
  tealorange: { n: 'Teal & orange', f: v => LK.sc(LK.sat(LK.split(v, [-0.06, 0.02, 0.07], [0.07, 0.02, -0.06]), 1.15), 0.25) },
  bleach: { n: 'Bleach bypass', f: v => LK.con(LK.sat(LK.mix(v, LK.ov(v, Y709(v)), 0.7), 0.45), 1.12) }, // the silver kept: overlay of its own luma, desaturated
  print: { n: 'Print film', f: v => LK.sat(LK.split(LK.aces(v, 1.5), [0, 0.015, 0.02], [0.04, 0.01, -0.03]), 0.95) },
  portra: { n: 'Portra', f: v => LK.sat(LK.lgg(LK.fade(v, 0.04, 0.98), [0.01, 0, -0.005], [1.03, 1.02, 1], [1.04, 1.01, 0.95]), 0.9) },
  ektar: { n: 'Ektar', f: v => LK.mul(LK.sc(LK.sat(v, 1.35), 0.3), [1, 1, 1.04]) }, // vivid and neutral-cool
  fuji: { n: 'Fuji 400H', f: v => LK.sat(LK.fade(LK.split(v, [-0.02, 0.03, 0.04], [0.03, 0.03, 0.01]), 0.05), 0.85) },
  velvia: { n: 'Velvia', f: v => LK.lgg(LK.sc(LK.sat(v, 1.6), 0.4), [0, 0, 0.01], [1, 1, 1], [1, 1.02, 1.04]) },
  trix: { n: 'Tri-X', f: v => LK.fade(LK.sc(LK.mono(v, [0.3, 0.6, 0.1]), 0.6), 0.02) },
  crossproc: { n: 'Cross process', f: v => [v[0] + (smoothstep(0, 1, v[0]) - v[0]) * 0.5, v[1] + (smoothstep(0, 1, v[1]) - v[1]) * 0.3, 0.12 + v[2] * 0.7] }, // slide film in negative chemistry
  matte: { n: 'Matte', f: v => LK.sc(LK.sat(LK.fade(v, 0.08, 0.94), 0.9), 0.15) },
  faded: { n: 'Faded', f: v => LK.mul(LK.sat(LK.fade(v, 0.15, 0.9), 0.75), [1.02, 1, 0.97]) },
  vintage: { n: 'Warm vintage', f: v => LK.mul(LK.fade(LK.mix(v, LK.mul(LK.mono(v), [1.1, 0.97, 0.78]), 0.35), 0.08), [1.06, 1, 0.86]) },
  moody: { n: 'Moody', f: v => LK.sc(LK.lgg(LK.sat(v, 0.7), [-0.01, 0, 0.02], [0.92, 0.92, 0.95], [0.95, 0.97, 1]), 0.2) },
  noir: { n: 'Noir', f: v => LK.con(LK.sc(LK.mono(v), 0.8), 1.15) },
  cyber: { n: 'Cyberpunk', f: v => LK.sc(LK.sat(LK.split(v, [0, 0.05, 0.12], [0.12, -0.02, 0.1]), 1.25), 0.2) },
  sunset: { n: 'Sunset glow', f: v => LK.sc(LK.split(LK.mul(v, [1.08, 0.98, 0.85]), [0, 0, 0], [0.06, 0.02, -0.04]), 0.15) },
  ice: { n: 'Ice', f: v => LK.lgg(LK.fade(LK.mul(LK.sat(v, 0.7), [0.92, 0.99, 1.08]), 0.03), [0, 0, 0], [1, 1, 1], [1.02, 1.04, 1.08]) },
  forest: { n: 'Forest', f: v => LK.lgg(LK.mul(LK.sat(v, 1.1), [0.94, 1.04, 0.94]), [0, 0, 0], [0.95, 0.95, 0.95], [1, 1, 1]) },
  desert: { n: 'Desert', f: v => LK.sc(LK.sat(LK.mul(LK.lgg(v, [0.02, 0.01, 0], [1, 1, 1], [1, 1, 1]), [1.07, 1, 0.88]), 0.85), 0.2) },
  instant: { n: 'Instant', f: v => LK.sat(LK.split(LK.fade(v, 0.07, 0.95), [-0.02, 0.02, 0.05], [0.05, 0.03, -0.02]), 1.05) },
  lomo: { n: 'Lomo', f: v => LK.split(LK.sc(LK.sat(v, 1.4), 0.5), [0, 0.03, 0.06], [0.05, 0.04, -0.05]) },
  pastel: { n: 'Pastel', f: v => LK.sc(LK.sat(LK.fade(v, 0.12), 0.65), -0.15) },
  hdr: { n: 'HDR pop', f: v => LK.con(LK.sat(LK.sc(v, 0.55), 1.3), 1.05) },
  cinema: { n: 'Cinematic', f: v => LK.sat(LK.split(LK.aces(v, 1.4), [-0.02, 0.01, 0.04], [0.03, 0.01, -0.02]), 0.9) },
  daynight: { n: 'Day for night', f: v => LK.lgg(LK.sat(LK.mul(v, [0.55, 0.7, 1]), 0.5), [0, 0.005, 0.03], [0.8, 0.8, 0.8], [1, 1, 1]) },
  antique: { n: 'Antique', f: v => LK.fade(LK.mul(LK.mono(v), [1.05, 0.92, 0.75]), 0.1, 0.92) },
  codegreen: { n: 'Code green', f: v => LK.sc(LK.sat(LK.split(LK.mul(v, [0.85, 1.08, 0.85]), [0, 0.03, 0], [0, 0, 0]), 0.8), 0.2) },
  kodachrome: { n: 'Kodachrome', f: v => { const w = LK.mul(LK.sc(LK.sat(v, 1.3), 0.45), [1.06, 0.98, 0.88]); return [w[0] + 0.12 * (w[0] - (w[1] + w[2]) / 2), w[1], w[2]]; } }, // warm, deep reds
  twostrip: { n: 'Two-strip', f: v => LK.sc(LK.sat([v[0], (v[1] + v[2]) / 2, (v[1] + v[2]) / 2], 1.2), 0.2) }, // two-strip Technicolor: a red record and a cyan one
  aerochrome: { n: 'Aerochrome', f: v => LK.sat([v[1], v[0], v[2]], 1.2) }, // infrared film's false colour: greens print red
  muted: { n: 'Muted', f: v => LK.fade(LK.con(LK.sat(v, 0.6), 0.95), 0.03) },
};
const LOOK_NAMES = () => [...Object.keys(LOOKS), ...Object.keys(LOOK_LUT)];
const lookLabel = n => (n === 'none' ? 'None' : LOOK_LUT[n]?.n || n[0].toUpperCase() + n.slice(1));
const lookLutOf = c => { const L = LOOK_LUT[c?.look?.name]; return L ? [L.f, clamp(c.look.amount ?? 1, 0, 1)] : null; }; // gradeFn's first step

// ---------- shared files (.cutroom-fx): an effect or transition as one small JSON file; the server checks every name (fx_check) and the
// compile below is the second check. Registered ones live in EXF / TRX / FX beside the built-ins under the key 'u_<id>' ----------
const FXSHARED = new Map(); // key -> the file's checked document
function fxRegister(d) {
  const key = `u_${d.id}`, defs = { ...Object.fromEntries(Object.entries(d.parameters || {}).map(([k, v]) => [k, xnum(v)])), ...d.expressions.defs }, e = d.expressions.e;
  if (d.kind === 'effect') {
    EXF[key] = { defs, e };
    try { fxGeq(key, 1); xout(exTree(key, 1)); } catch (err) { delete EXF[key]; throw err; }
    FX[key] = { n: d.name, cat: 'shared', d: 3, px: (W, H, u, lt, f) => [xop(key, f, lt)] };
  } else {
    TRX[key] = { n: d.name, defs, e };
    try { trxFF(key, '#000000'); xout(trxTree(key, '#000000')); } catch (err) { delete TRX[key]; throw err; }
    if (!TRANSITIONS.some(t => t[0] === key)) TRANSITIONS.push([key, d.name]);
  }
  FXSHARED.set(key, d);
  return key;
}
function fxUnregister(key) {
  FXSHARED.delete(key); delete EXF[key]; delete FX[key]; delete TRX[key];
  const i = TRANSITIONS.findIndex(t => t[0] === key);
  if (i >= 0) TRANSITIONS.splice(i, 1);
}
function fxFile(kind, key) { // the JSON text of a built-in or imported effect / transition
  const d = FXSHARED.get(key);
  if (d) return JSON.stringify({ cutroom_fx: 1, name: d.name, kind: d.kind, author: d.author || '', parameters: d.parameters || {}, expressions: d.expressions }, null, 1);
  const x = kind === 'effect' ? EXF[key] : TRX[key];
  return JSON.stringify({ cutroom_fx: 1, name: (kind === 'effect' ? FX[key] : TRX[key]).n, kind, author: '', parameters: {}, expressions: { defs: x.defs || {}, e: x.e } }, null, 1);
}
