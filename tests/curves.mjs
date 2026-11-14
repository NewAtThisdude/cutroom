// Keyframe curve editor: the inspector's graph (every keyframed property over time, each segment's cubic-bezier with two
// handles). Drag a handle with the mouse -> f.bz follows the drag in one undo step; the preview's position at several times
// follows that bezier (checked against a bezier solved here, independently) and the export (/api/still_frame through the
// MCP snapshot) puts the clip within 2 px of the preview; the presets set their known curves; copy / paste and the keyboard
// (arrows nudge, 1 / 2 pick the handle, ] the next segment) work; undo restores. Both motion modes, no page errors.
//   CUTROOM_HOME=<scratch library> B=http://127.0.0.1:<port> node curves.mjs   (never the 4610 server)
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4713';
if (/:4610\b/.test(B)) throw new Error('run this on a scratch server, not 4610');
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-curves-`), png = `${tmp}/curves-white.png`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:s=640x360', '-frames:v', '1', png]);
const W = (await (await fetch(`${B}/api/import?name=curves-white.png`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(png) })).json()).id;
fs.rmSync(tmp, { recursive: true });

// an independent cubic-bezier: solve x(s) = u by bisection, return y(s)
const bez = ([x1, y1, x2, y2], u) => { const f = (a, b, s) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3; let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(x1, x2, m) < u) lo = m; else hi = m; } return f(y1, y2, (lo + hi) / 2); };
const X0 = -0.2, X1 = 0.25, SC = 0.4; // segment 1 moves the clip from x -0.2 to 0.25 over 2 s at scale 0.4
const KF = [{ t: 0, scale: SC, x: X0, y: 0, opacity: 1, rot: 0 }, { t: 2, scale: SC, x: X1, y: 0.1, opacity: 1, rot: 0 }, { t: 3, scale: 0.6, x: X1, y: 0.1, opacity: 0.8, rot: 10 }];

// the clip's left edge on three rows of the same frame both ways (full-size snapshots)
const EDGES = async T => {
  const ex = await REMOTE.snapshot({ t: T, max: 640 }), pv = await REMOTE.snapshot({ t: T, max: 640, preview: true });
  const edges = async b64 => {
    const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, im.width, im.height);
    return { w: im.width, e: [0.4, 0.5, 0.6].map(fy => { const y = Math.floor(fy * d.height); for (let x = 0; x < d.width; x++) { const i = (y * d.width + x) * 4; if (d.data[i] + d.data[i + 1] + d.data[i + 2] > 3 * 127) return x; } return -1; }) };
  };
  const [a, b] = [await edges(ex.image), await edges(pv.image)];
  return { w: a.w, ex: a.e, pv: b.e };
};

const b = await browser.launch();
for (const [rm, dpr] of [['no-preference', 1], ['reduce', 2]]) {
  const page = await (await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm, deviceScaleFactor: dpr })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
  await page.evaluate(() => loadMedia());
  await page.waitForFunction(id => M.get(id)?.ready, W, { timeout: 120000 });
  const ev = (f, a) => page.evaluate(f, a);
  await ev(([W, KF]) => {
    setProject(newProject('16:9')); P.name = 'Curves (scratch)'; S.sel = null; S.multi.clear();
    addMedia(W, 'main'); const c = P.main[0]; c.kf = KF.map(f => ({ ...f })); S.sel = { lane: 'main', id: c.id }; seekTo(0.5); renderAll();
  }, [W, KF]);
  await page.waitForFunction(() => $('#kfGraph')?.width > 0);
  const crisp = await ev(() => { const cv = $('#kfGraph'); return { w: cv.width, cw: cv.clientWidth, h: cv.height, ch: cv.clientHeight, dpr: devicePixelRatio }; });
  check(`${rm}: the graph is drawn at the device pixel ratio (${dpr}x)`, crisp.w === Math.round(crisp.cw * dpr) && crisp.h === Math.round(crisp.ch * dpr) && crisp.dpr === dpr, JSON.stringify(crisp));
  const legend = await ev(() => [...document.querySelectorAll('.kglegend span')].map(s => s.textContent));
  check(`${rm}: the legend names the keyframed properties`, ['Scale', 'Position X', 'Position Y', 'Opacity', 'Rotate'].every(n => legend.includes(n)) && legend.some(s => /^Segment 1/.test(s)), legend.join(', '));

  // drag both handles of segment 1 with the mouse
  const handle = j => ev(j => { const c = P.main[0], cv = $('#kfGraph'), r = cv.getBoundingClientRect(), g = kgGeo(c, cv), h = kgHandles(c, g).find(q => q[0] === 0 && q[1] === j); return { x: r.left + cv.clientLeft + h[2], y: r.top + cv.clientTop + h[3], w: g.w, h: g.h, D: g.D, bz: kgBz(c, c.kf[0]) }; }, j);
  const drag = async (j, dx, dy) => {
    await page.locator('#kfGraph').scrollIntoViewIfNeeded();
    const h = await handle(j), u0 = await ev(() => undo.length);
    await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x + dx / 2, h.y + dy / 2, { steps: 4 }); await page.mouse.move(h.x + dx, h.y + dy, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction(() => $('#kfGraph')?.width > 0);
    const want = [...h.bz]; want[j] = Math.min(1, Math.max(0, h.bz[j] + (dx / h.w) * (h.D / 2))); want[j + 1] = h.bz[j + 1] - (dy / h.h) * 2;
    const got = await ev(() => ({ bz: P.main[0].kf[0].bz, ease: P.main[0].kf[0].ease, kind: easeKind(P.main[0], P.main[0].kf[0]), undos: undo.length }));
    return { want, got, steps: got.undos - u0 };
  };
  const d1 = await drag(0, 40, -50), d2 = await drag(2, -30, 40);
  const near = (a, b, e) => a?.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
  check(`${rm}: dragging handle 1 sets f.bz to the drag, one undo step`, near(d1.got.bz, d1.want, 0.01) && d1.got.ease === true && d1.steps === 1, `bz ${JSON.stringify(d1.got.bz)} want ${d1.want.map(v => v.toFixed(3))}, ${d1.steps} step`);
  check(`${rm}: dragging handle 2 too, one more undo step: a custom curve`, near(d2.got.bz, d2.want, 0.01) && d2.got.kind === 'custom' && d2.steps === 1, `bz ${JSON.stringify(d2.got.bz)} want ${d2.want.map(v => v.toFixed(3))}`);
  const bz = d2.got.bz;

  // the preview follows that bezier; the export puts the clip where the preview does
  for (const T of [0.3, 0.7, 1.0, 1.5]) {
    const x = await ev(T => propsAt(P.main[0], T).x, T), want = X0 + (X1 - X0) * bez(bz, T / 2);
    const e = await page.evaluate(`(${EDGES})(${T})`), at = Math.round((e.w - SC * e.w) / 2 + want * e.w);
    const off = Math.max(...e.ex.map((v, i) => Math.abs(v - e.pv[i]))), offW = Math.max(...e.pv.map(v => Math.abs(v - at)));
    check(`${rm}: t=${T}: the preview follows the dragged bezier, the export within 2 px of it`, Math.abs(x - want) < 1e-3 && off <= 2 && offW <= 2,
      `x ${x.toFixed(4)} vs bezier ${want.toFixed(4)}; left edge: preview ${e.pv.join('/')} export ${e.ex.join('/')} expected ${at} (${off} px between them)`);
  }

  // undo, redo
  const ur = await ev(() => { const k = () => JSON.stringify(P.main[0].kf[0].bz ?? null); restore(undo, redo); const a = k(); restore(undo, redo); const b = { bz: k(), kind: easeKind(P.main[0], P.main[0].kf[0]) }; restore(redo, undo); restore(redo, undo); return { a, b, c: k() }; });
  check(`${rm}: undo puts the curve back one drag at a time, redo brings it again`, ur.a === JSON.stringify(d1.got.bz) && ur.b.bz === 'null' && ur.b.kind === 'linear' && ur.c === JSON.stringify(bz), JSON.stringify(ur));

  // presets
  const want = { in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1], inout: null, linear: null, back: [0.34, 1.56, 0.64, 1] };
  for (const [k, v] of Object.entries(want)) {
    const u0 = await ev(() => undo.length);
    await page.click(`#inspector [data-ease="${k}"]`);
    const f = await ev(() => ({ ...P.main[0].kf[0], kind: easeKind(P.main[0], P.main[0].kf[0]), undos: undo.length, on: document.querySelector('#inspector [data-ease].on')?.dataset.ease }));
    check(`${rm}: preset ${k} sets ${v ? `cubic-bezier(${v})` : k === 'linear' ? 'no easing' : 'the smoothstep'}, one undo step`, f.kind === k && f.on === k && JSON.stringify(f.bz ?? null) === JSON.stringify(v) && !!f.ease === (k !== 'linear') && f.undos === u0 + 1, JSON.stringify({ bz: f.bz, ease: f.ease, kind: f.kind }));
  }
  const back = await ev(() => Math.max(...Array.from({ length: 41 }, (_, i) => propsAt(P.main[0], i / 20).x)));
  check(`${rm}: back overshoots the end keyframe`, back > X1 + 0.02, `peak x ${back.toFixed(3)} vs ${X1}`);

  // copy segment 1's curve, ] to segment 2 with the graph focused, paste; then nudge with the arrow keys
  await ev(bz => { P.main[0].kf[0].ease = true; P.main[0].kf[0].bz = bz; renderAll(); }, bz);
  await page.click('#inspector [data-act="kfcopy"]');
  await page.click('#kfGraph', { position: { x: 30, y: 120 } }); // an empty spot: seeks there (in segment 1) and focuses the graph
  const t1 = await ev(() => ({ t: S.t, focus: document.activeElement?.id }));
  await page.keyboard.press(']');
  const seg = await ev(() => ({ i: P.main[0].kf.indexOf(easeSeg(P.main[0], S.t - P.main[0].start)), t: S.t, focus: document.activeElement?.id }));
  check(`${rm}: clicking the graph seeks there; ] picks the next segment, the graph keeps focus`, t1.t > 0 && t1.t < 0.5 && t1.focus === 'kfGraph' && seg.i === 1 && seg.focus === 'kfGraph', `${JSON.stringify(t1)} ${JSON.stringify(seg)}`);
  await page.click('#inspector [data-act="kfpaste"]');
  const pasted = await ev(() => P.main[0].kf[1].bz);
  check(`${rm}: paste puts the copied curve on segment 2`, JSON.stringify(pasted) === JSON.stringify(bz), JSON.stringify(pasted));
  await page.focus('#kfGraph');
  const k0 = await ev(() => ({ t: S.t, u: undo.length }));
  await page.keyboard.press('1'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('2'); await page.keyboard.press('Shift+ArrowLeft');
  const k1 = await ev(() => ({ bz: P.main[0].kf[1].bz, t: S.t, u: undo.length, focus: document.activeElement?.id }));
  const nb = [bz[0], +(bz[1] + 0.01).toFixed(3), +Math.max(0, bz[2] - 0.1).toFixed(3), bz[3]];
  check(`${rm}: arrow keys nudge the picked handle (one undo step each), not the playhead`, near(k1.bz, nb, 1e-9) && k1.t === k0.t && k1.u === k0.u + 2 && k1.focus === 'kfGraph', `${JSON.stringify(k1.bz)} want ${JSON.stringify(nb)}, ${k1.u - k0.u} steps`);
  await page.keyboard.press('Meta+z');
  const z = await ev(() => P.main[0].kf[1].bz);
  check(`${rm}: ⌘Z from the graph undoes the last nudge`, JSON.stringify(z) === JSON.stringify([bz[0], +(bz[1] + 0.01).toFixed(3), bz[2], bz[3]]), JSON.stringify(z));
  await page.locator('#kfGraph').screenshot({ path: `${process.env.CUTROOM_SCRATCH || '/tmp'}/curves-${rm}.png` });
  check(`${rm}: no page errors`, !errs.length, errs.slice(0, 2).join(' | '));
  await page.context().close();
}
await b.close();
const n = res.filter(Boolean).length;
console.log(`\n${n}/${res.length} passed`);
process.exit(n === res.length ? 0 : 1);
