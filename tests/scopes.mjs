// Scopes (G): luma waveform, RGB parade, vectorscope (75 % colour-bar targets, skin-tone line), RGB histogram. Synthetic
// frames give known traces: a 75 % red still lands on the vectorscope's red target, a black | white split draws the
// waveform at 0 and 100 IRE only, a grey ramp draws a diagonal. Also: the selection box stays out of the scopes, the
// panel is remembered, nothing is drawn while it is closed, at most ~15 updates a second while playing, and the cost of
// one update (ms) is measured. Both motion modes.
//   B=http://127.0.0.1:<scratch port> node scopes.mjs
import { browser } from './browser.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' };
const res = [], check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-scopes-`);
const still = (name, vf) => { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', vf, '-frames:v', '1', `${tmp}/${name}`]); return name; };
const files = [still('red75.png', 'color=0xBF0000:s=1280x720,format=rgb24'), still('split.png', 'color=black:s=1280x720,drawbox=x=640:y=0:w=640:h=720:color=white:t=fill,format=rgb24'),
  still('ramp.png', "nullsrc=s=1280x720,format=gray,geq=lum='X*255/(W-1)'")];
const ids = [];
for (const f of files) ids.push((await (await fetch(`${B}/api/import?name=scope-${f}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(`${tmp}/${f}`) })).json()).id);
fs.rmSync(tmp, { recursive: true });

const OW = 256, OH = 150, cx = OW / 2, cy = OH / 2, R = Math.min(cx, cy) - 4;
const vecAt = (r, g, b) => { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [cx + ((b - y) / 1.8556) * 2 * R, cy - ((r - y) / 1.5748) * 2 * R]; };
const Yof = v => Math.round((1 - v / 255) * (OH - 1));
const b = await browser.launch(), pids = [], cost = {};
for (const rm of ['no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(u => u.pathname === '/api/remote/next', async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); }); // (not the MCP's editor)
  await page.goto(`${B}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
  const ev = (fn, a) => page.evaluate(fn, a);
  await ev(() => { localStorage.removeItem('cutroom.scope'); setScope({ on: false, kind: 'wave' }); });
  await ev(() => loadMedia());
  await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), ids, { timeout: 60000 });
  pids.push(await ev(ids => { setProject(newProject('16:9')); P.name = 'Scopes (scratch)'; for (const id of ids) addMedia(id, 'main'); packMain(); S.sel = null; renderAll(); return P.id; }, ids));
  const mids = await ev(() => P.main.map(c => c.start + 1));

  // closed: no scope work at all, even while playing
  await ev(() => { window.__ds = 0; window.__od ??= drawScope; drawScope = () => { __ds++; __od(); }; S.t = 0; play(); });
  await page.waitForTimeout(1200);
  const closedN = await ev(() => { pause(); return __ds; });
  check(`${rm}: closed panel: no scope updates while playing`, closedN === 0, `${closedN} updates`);
  await page.keyboard.press('g');
  check(`${rm}: G opens the panel`, await ev(() => SCOPE.on && !$('#scope').hidden && $('#btnScope').getAttribute('aria-pressed') === 'true'));
  await ev(() => { __ds = 0; S.t = 0; play(); });
  await page.waitForTimeout(2000);
  const openN = await ev(() => { pause(); return __ds; });
  check(`${rm}: playing: at most ~15 updates a second`, openN >= 6 && openN <= 32, `${openN} in 2 s`);
  await ev(() => { drawScope = __od; });

  const scope = async (kind, t) => ev(async ([kind, t]) => {
    setScope({ kind }); S.t = t; await waitFrame();
    return [...$('#scopeCv').getContext('2d').getImageData(0, 0, 256, 150).data];
  }, [kind, t]);
  const px = (d, x, y) => d.slice((y * OW + x) * 4, (y * OW + x) * 4 + 3);
  const lit = (d, x, y, th = 200) => Math.min(...px(d, x, y)) >= th;
  const centroid = (d, th = 200) => { let n = 0, sx = 0, sy = 0; for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) if (lit(d, x, y, th)) { n++; sx += x; sy += y; } return n ? [sx / n, sy / n, n] : [NaN, NaN, 0]; };

  // a 75 % red still, selected (its selection box must not reach the scopes)
  await ev(() => { S.sel = { lane: 'main', id: P.main[0].id }; S.dirty = true; });
  let d = await scope('vec', mids[0]);
  const [tx, ty] = vecAt(0.75, 0, 0), [vx, vy, vn] = centroid(d), stray = (() => { let n = 0; for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) if (lit(d, x, y) && Math.hypot(x - tx, y - ty) > 6) n++; return n; })();
  check(`${rm}: 75 % red: the vectorscope point sits on the red target`, vn > 0 && Math.hypot(vx - tx, vy - ty) <= 3, `point ${vx.toFixed(1)},${vy.toFixed(1)} target ${tx.toFixed(1)},${ty.toFixed(1)}`);
  check(`${rm}: the selection box stays out of the scopes`, stray === 0, `${stray} stray points`);
  const lv = await ev(() => scopeLevels());
  check(`${rm}: levels: mean RGB 191, 0, 0`, Math.abs(lv.meanRGB[0] - 191) <= 2 && lv.meanRGB[1] <= 2 && lv.meanRGB[2] <= 2, JSON.stringify(lv.meanRGB));
  d = await scope('parade', mids[0]);
  const pw = Math.floor(OW / 3), row = (d, x0, x1, y) => { let n = 0; for (let x = x0; x < x1; x++) if (Math.max(...px(d, x, y)) >= 150) n++; return n; };
  check(`${rm}: parade: red at 75 %, green and blue at 0`, row(d, 0, pw, Yof(191)) > pw * 0.8 && row(d, pw + 1, 2 * pw, OH - 1) > pw * 0.8 && row(d, 2 * pw + 1, OW, OH - 1) > pw * 0.8 && row(d, 0, pw, OH - 1) === 0,
    `red row ${row(d, 0, pw, Yof(191))}, green floor ${row(d, pw + 1, 2 * pw, OH - 1)}, blue floor ${row(d, 2 * pw + 1, OW, OH - 1)}`);
  d = await scope('hist', mids[0]);
  check(`${rm}: histogram: one red peak at 191, green and blue at 0`, px(d, 191, 3)[0] >= 100 && px(d, 191, 3)[1] < 40 && px(d, 0, 3)[1] >= 100 && px(d, 0, 3)[2] >= 100 && px(d, 128, OH - 2).every(v => v < 40),
    `191: ${px(d, 191, 3)}, 0: ${px(d, 0, 3)}, 128: ${px(d, 128, OH - 2)}`);
  await ev(() => { S.sel = null; S.dirty = true; });

  // black | white
  d = await scope('wave', mids[1]);
  const rowLit = y => { let n = 0; for (let x = 0; x < OW; x++) if (lit(d, x, y)) n++; return n; };
  let mid = 0; for (let y = 3; y < OH - 3; y++) mid += rowLit(y);
  check(`${rm}: black | white: the waveform at 0 and 100 IRE, nothing between`, rowLit(OH - 1) >= 120 && rowLit(0) >= 120 && mid <= 6, `0 IRE ${rowLit(OH - 1)}, 100 IRE ${rowLit(0)}, between ${mid}`);
  d = await scope('hist', mids[1]);
  check(`${rm}: black | white: histogram peaks at both ends only`, lit(d, 0, 2, 100) && lit(d, 255, 2, 100) && !lit(d, 128, OH - 2, 60), `0: ${px(d, 0, 2)}, 255: ${px(d, 255, 2)}`);
  const lw = await ev(() => scopeLevels());
  check(`${rm}: levels: half clipped black, half clipped white`, Math.abs(lw.clippedBlack - 50) < 3 && Math.abs(lw.clippedWhite - 50) < 3, JSON.stringify(lw));

  // grey ramp: a diagonal waveform, a dot in the vectorscope's middle
  d = await scope('wave', mids[2]);
  let worst = 0;
  for (let x = 4; x < OW - 4; x += 8) { let by = -1, bv = 0; for (let y = 0; y < OH; y++) { const v = px(d, x, y)[1]; if (v > bv) { bv = v; by = y; } } worst = Math.max(worst, Math.abs(by - Yof((x + 0.5) * 255 / 256))); }
  check(`${rm}: grey ramp: the waveform is a diagonal from 0 to 100 IRE`, worst <= 4, `worst ${worst} px off`);
  d = await scope('vec', mids[2]);
  const [gx, gy] = centroid(d);
  check(`${rm}: grey ramp: no colour, the vectorscope stays in the middle`, Math.hypot(gx - cx, gy - cy) <= 1.5, `${gx.toFixed(1)},${gy.toFixed(1)}`);

  // the cost of one update, per scope
  for (const k of ['wave', 'parade', 'vec', 'hist']) {
    const ms = await ev(k => { setScope({ kind: k }); drawScope(); const t0 = performance.now(); for (let i = 0; i < 50; i++) drawScope(); return (performance.now() - t0) / 50; }, k); // (WebKit's clock ticks in whole ms: a mean)
    (cost[k] ??= []).push(ms);
  }

  // remembered: reload, it is open on the same scope; G closes it
  await ev(() => setScope({ kind: 'parade' }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof P !== 'undefined' && P, null, { timeout: 20000 });
  check(`${rm}: the panel and the scope are remembered`, await ev(() => SCOPE.on && SCOPE.kind === 'parade' && !$('#scope').hidden && $('[data-scope="parade"]').classList.contains('on')));
  await page.keyboard.press('g');
  check(`${rm}: G closes it again`, await ev(() => !SCOPE.on && $('#scope').hidden));
  await page.click('#btnScope');
  check(`${rm}: the toolbar button opens it`, await ev(() => SCOPE.on && !$('#scope').hidden));
  const r = await ev(() => REMOTE.scopes({ show: false }));
  check(`${rm}: REMOTE.scopes returns levels and closes the panel`, r.open === false && typeof r.luma?.median === 'number', JSON.stringify(r));
  check(`${rm}: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await ev(() => localStorage.removeItem('cutroom.scope'));
  await ctx.close();
}
for (const k of Object.keys(cost)) console.log(`cost of one update, ${k.padEnd(6)}: ${cost[k].map(v => v.toFixed(2)).join(' / ')} ms (mean of 50; no-preference / reduce)`);
await b.close();
for (const id of pids) await fetch(`${B}/api/projects/${id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const id of ids) await fetch(`${B}/api/media/${id}/trash`, { method: 'POST', headers: H, body: '{}' });
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
