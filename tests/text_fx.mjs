// Text and clip motion, arc layout, REMOTE/history/persistence and the shared page/worker export paths.
// Run outside restricted sandboxes through run_all: B and CUTROOM_HOME must name its scratch server/library.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { browser } from './browser.mjs';
import { cachedMedia } from './fixtures.mjs';
import { requireHome } from './runtime.mjs';

const B = process.env.B, HOME = requireHome();
if (!B || new URL(B).port === '4610') throw new Error('B must name a scratch server, never port 4610');
const OUT = new URL('./out/text_fx/', import.meta.url); fs.mkdirSync(OUT, { recursive: true });
const checks = [], check = (name, ok, detail = '') => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const api = async (route, body) => {
  const r = await fetch(B + route, { headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || `${route}: ${r.status}`); return j;
};
const source = cachedMedia('text-fx-grid-v1.png', ['-f', 'lavfi', '-i', 'testsrc=s=960x540', '-frames:v', '1']);
const media = (await api('/api/import_path', { path: source })).id;
if (!media) throw new Error('Fixture import returned no id');
const md5 = file => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], { maxBuffer: 1 << 26 }).toString().split('\n').filter(l => l && !l.startsWith('#'));
const b = await browser.launch();
try {
  for (const rm of ['no-preference', 'reduce']) {
    const context = await b.newContext({ viewport: { width: 1517, height: 904 }, reducedMotion: rm }), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ev = (fn, args) => page.evaluate(fn, args);
    await page.goto(B + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE !== 'undefined', null, { timeout: 30000 });
    await ev(() => { if ($('#tour')) $('#tour').remove(); store.set('cutroom.tour', 'done'); });
    await page.waitForFunction(async id => { await loadMedia(); return M.get(id)?.ready; }, media, { timeout: 90000 });
    await ev(async rm => {
      await REMOTE.new_project({ name: `Text FX ${rm}`, ratio: '16:9', branded: false });
      await REMOTE.set_project({ set: { fps: 30, bg: '#18202b' } });
      delete document.documentElement.dataset.motion;
      await document.fonts.load('800 140px "Montserrat"');
      window.tx = {};
      tx.style = { font: 'Montserrat', weight: 800, size: 140, color: '#ffffff', shadow: false, strokeW: 0, box: false, maxW: 0.95, anim: 'none', out: 'none', loop: 'none', animT: 1, outT: 1 };
      tx.render = (style = {}, t = 1.5, extra = {}) => {
        const cv = new OffscreenCanvas(960, 540), x = cv.getContext('2d', { willReadFrequently: true });
        drawText(x, { id: 'probe', text: 'Make it move', start: 0, dur: 3, x: 0.5, y: 0.5, ...extra, style: { ...tx.style, ...style } }, 'text', t, 960 / P.w, false);
        return x.getImageData(0, 0, 960, 540).data;
      };
      tx.diff = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
      tx.ink = a => a.some((v, i) => i % 4 === 3 && v);
      tx.hash = a => { let h = 2166136261; for (const v of a) h = Math.imul(h ^ v, 16777619); return h >>> 0; };
      tx.boxes = a => { // separated glyphs: connected ink columns -> per-letter bounding boxes
        const boxes = []; let box = null;
        for (let x = 0; x < 960; x++) {
          let y0 = 540, y1 = -1;
          for (let y = 0; y < 540; y++) if (a[(y * 960 + x) * 4 + 3] > 8) { y0 = Math.min(y0, y); y1 = y; }
          if (y1 < 0) { if (box) boxes.push(box); box = null; }
          else if (!box) box = { x0: x, x1: x, y0, y1 };
          else { box.x1 = x; box.y0 = Math.min(box.y0, y0); box.y1 = Math.max(box.y1, y1); }
        }
        if (box) boxes.push(box); return boxes;
      };
    }, rm);

    const inventory = await ev(async () => {
      const o = await REMOTE.options();
      return { ins: TEXT_FX_IN.map(x => x[0]), outs: TEXT_FX_OUT.map(x => x[0]), loops: TEXT_FX_LOOPS.map(x => x[0]), options: o };
    });
    check(`${rm}: REMOTE publishes every new text preset`, inventory.ins.every(n => inventory.options.textIn.includes(n)) && inventory.outs.every(n => inventory.options.textOut.includes(n)) && inventory.loops.every(n => inventory.options.textLoop.includes(n)));
    for (const [field, names] of [['anim', [...inventory.ins, 'type']], ['out', [...inventory.outs, 'type']]]) for (const name of names) {
      const r = await ev(({ field, name }) => {
        // Also exercise WebKit's shadow/alpha handling, outline and background, not just bare glyphs.
        const results = [false, true].map(decorated => {
          const style = decorated ? { shadow: true, shc: '#e85190', strokeW: 3, box: true, boxColor: '#162a48' } : {};
          const settled = tx.render(style), at = p => tx.render({ ...style, [field]: name }, field === 'out' ? 3 - p : p);
          const frames = [0.15, 0.4, 0.7, 1].map(at);
          return { changed: new Set(frames.map(tx.hash)).size >= 3, empty: !tx.ink(at(0)), settled: tx.diff(at(1), settled), repeat: tx.diff(at(0.4), at(0.4)) };
        });
        return results;
      }, { field, name });
      check(`${rm}: ${field} ${name} changes, repeats deterministically and reaches both endpoints`, r.every(x => x.changed && x.empty && x.settled === 0 && x.repeat === 0), JSON.stringify(r));
    }
    for (const name of inventory.loops) {
      const r = await ev(name => {
        const style = { loop: name, color: '#ffc65c', color2: '#ed4f93', shadow: true, shc: '#9751e8' }, period = name === 'wave' ? 1 : name === 'shake' ? 0.5 : 2;
        const frames = [0.07, 0.21, 0.43].map(t => tx.render(style, t));
        return { changed: new Set(frames.map(tx.hash)).size === 3, periodic: tx.diff(frames[0], tx.render(style, 0.07 + period)) };
      }, name);
      check(`${rm}: loop ${name} changes and is periodic`, r.changed && r.periodic < 0.02, JSON.stringify(r));
    }
    for (const name of ['letterrise', 'letterdrop', 'letterblur', 'wave', 'glitch']) {
      const r = await ev(name => {
        const extra = { text: 'HHHHHH' }, style = { anim: name, ls: 0.4 }, base = tx.boxes(tx.render({ ls: 0.4 }, 1.5, extra));
        const boxes = tx.boxes(tx.render(style, 0.71, extra));
        const offsets = boxes.map(a => { const c = base.reduce((p, q) => Math.abs(q.x0 - a.x0) < Math.abs(p.x0 - a.x0) ? q : p); return [a.x0 - c.x0, a.y0 - c.y0, a.x1 - a.x0, a.y1 - a.y0]; });
        return { boxes, independent: boxes.length >= 3 && new Set(offsets.map(x => x.join(','))).size >= 3 };
      }, name);
      check(`${rm}: ${name} moves/blurs letters independently`, r.independent, JSON.stringify(r.boxes));
    }
    const units = await ev(() => {
      const extra = { text: 'H H H H H H' }, base = tx.boxes(tx.render({}, 1.5, extra)), typed = [0.2, 0.5, 0.9].map(t => tx.boxes(tx.render({ anim: 'type' }, t, extra)).length);
      const pop = tx.boxes(tx.render({ anim: 'wordpop' }, 0.7, extra));
      const decode = [0.35, 0.65].map(t => tx.boxes(tx.render({ anim: 'decode' }, t, extra)));
      return { typed, word: new Set(pop.map(x => x.x1 - x.x0)).size, decode: decode.map(x => x.length), base: base.length };
    });
    check(`${rm}: typewriter and decode reveal separate graphemes; word pop scales words independently`, units.typed[0] < units.typed[1] && units.typed[1] < units.typed[2] && units.word >= 2 && units.decode[0] < units.decode[1], JSON.stringify(units));
    const arcs = await ev(() => {
      const edge = curve => {
        const a = tx.render({ ls: 0.15 }, 1.5, { curve, text: 'HHHHHHHHHH' }), cols = [];
        for (let x = 0; x < 960; x++) for (let y = 0; y < 540; y++) if (a[(y * 960 + x) * 4 + 3] > 32) { cols.push([x, y]); break; }
        const band = f => { const values = cols.slice(Math.floor(cols.length * f), Math.floor(cols.length * (f + 0.1))).map(x => x[1]).sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; };
        return (band(0.05) + band(0.85)) / 2 - band(0.45);
      };
      return [-75, 0, 75].map(edge);
    });
    check(`${rm}: Curve bends the top edge in either direction; zero stays straight`, arcs[0] < -12 && Math.abs(arcs[1]) < 2 && arcs[2] > 12, JSON.stringify(arcs));
    const glyphs = await ev(() => textChars('A\u0301👨‍👩‍👧‍👦B').length);
    check(`${rm}: combining marks and joined emoji remain whole characters`, glyphs === 3);

    // Real inspector edits, one-step command undo, curve keyframes, validation and disk persistence.
    const id = await ev(async () => {
      const n = undo.length, r = await REMOTE.add_text({ text: 'Saved arc', duration: 3, curve: 40, style: { anim: 'letterrise', out: 'letterblur', loop: 'breathe' } });
      tx.oneStep = undo.length === n + 1;
      return r.id;
    });
    await page.locator('[data-k="c.curve"]').evaluate(el => { el.value = '-55'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    const history = await ev(async id => {
      const changed = cfind(id)[0].curve; await REMOTE.history({ action: 'undo' }); const before = cfind(id)[0].curve;
      await REMOTE.history({ action: 'redo' }); const after = cfind(id)[0].curve;
      await REMOTE.update_clip({ id, set: { kf: [{ t: 0, curve: -55 }, { t: 2, curve: 55 }] } });
      const mid = propsAt(cfind(id)[0], 1).curve;
      S.sel = { lane: 'text', id }; S.t = 1;
      change(() => setProp(cfind(id)[0], 'curve', 25));
      const keyed = cfind(id)[0].kf.find(f => f.t === 1)?.curve;
      await REMOTE.history({ action: 'undo' });
      let rejected = 0; const n = undo.length;
      for (const set of [{ curve: 101 }, { style: { curve: -101 } }, { style: { anim: 'typo' } }, { style: { loop: 'typo' } }, { kf: [{ t: 0, curve: 200 }] }]) try { await REMOTE.update_clip({ id, set }); } catch { rejected++; }
      await flushSave(); return { changed, before, after, mid, keyed, rejected, noBadHistory: n === undo.length, oneStep: tx.oneStep, project: P.id, saved: JSON.stringify(cfind(id)[0]) };
    }, id);
    check(`${rm}: Curve slider undo/redo and keyframe editing`, history.changed === -55 && history.before === 40 && history.after === -55 && history.mid === 0 && history.keyed === 25 && history.oneStep, JSON.stringify(history));
    check(`${rm}: invalid names/curve values fail without history changes`, history.rejected === 5 && history.noBadHistory);
    // Select every new gallery tile in each motion mode; reduced motion seeks, full motion plays.
    const galleries = await ev(async ({ id, inventory, rm }) => {
      const c = cfind(id)[0]; S.sel = { lane: 'text', id }; renderInspector();
      const names = [...TEXT_FX_IN, ...TEXT_FX_OUT, ...TEXT_FX_LOOPS];
      const labels = names.every(([v, label]) => [...document.querySelectorAll(`[data-animv="${v}"]`)].some(el => el.textContent === label));
      let ok = true;
      for (const [k, list] of [['anim', inventory.ins], ['out', inventory.outs], ['loop', inventory.loops]]) for (const name of list) {
        pause(); pickAnim(`c.style.${k}`, name);
        ok &&= c.style[k] === name && Number.isFinite(S.t) && (rm === 'reduce' ? !S.playing : S.playing);
      }
      pause(); return { labels, ok };
    }, { id, inventory, rm });
    check(`${rm}: gallery names and motion-aware preset previews`, galleries.labels && galleries.ok);
    // Restore the saved project first: gallery previews above intentionally made subsequent edits.
    await ev(async saved => { P.text = [JSON.parse(saved)]; await flushSave(); }, history.saved);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE !== 'undefined', null, { timeout: 30000 });
    await ev(project => REMOTE.open_project({ project }), history.project);
    const saved = await ev(id => JSON.stringify(cfind(id)[0]), id);
    check(`${rm}: animation, curve and keyframes survive save/reload`, saved === history.saved);

    // A real image goes through drawMedia, not a test stand-in for clipAnim.
    const clipChecks = await ev(async media => {
      await loadMedia(); const m = M.get(media), im = imgFor(m); if (!im.complete) await new Promise((ok, no) => { im.addEventListener('load', ok, { once: true }); im.addEventListener('error', no, { once: true }); });
      const c = { id: 'clip-probe', media, start: 0, in: 0, out: 3, speed: 1, scale: 0.6, x: 0, y: 0, opacity: 1, rot: 0, fit: 'fit' };
      const render = (anim, t) => { const x = new OffscreenCanvas(480, 270).getContext('2d'); drawMedia(x, 'overlay', { ...c, anim }, m, im, t, 480 / P.w); return x.getImageData(0, 0, 480, 270).data; };
      const hash = a => { let h = 1; for (const v of a) h = Math.imul(h ^ v, 16777619); return h; }, empty = a => !a.some((v, i) => i % 4 === 3 && v), equal = (a, b) => a.every((v, i) => v === b[i]);
      const r = [];
      for (const name of ['bounce', 'elastic', 'whip', 'roll', 'tilt', 'snap']) for (const side of ['in', 'out']) {
        const anim = { [side]: name, ind: 1, outd: 1 }, at = p => render(anim, side === 'out' ? 3 - p : p);
        const baked = bakeKf({ ...c, anim }, 'overlay');
        r.push([`${side} ${name}`, empty(at(0)) && equal(at(1), render({}, 1)) && new Set([0.2, 0.5, 0.8].map(p => hash(at(p)))).size === 3 && baked.every(f => ['x', 'y', 'scale', 'rot', 'opacity'].every(k => Math.abs(f[k] - clipAnim({ ...c, anim }, f.t, 3, propsAt(c, f.t))[k]) < 1e-9))]);
      }
      for (const [name, period] of [['breathe', 2], ['orbit', 2], ['bounce', 1], ['jitter', 0.5]]) {
        const a = render({ loop: name }, 0.07), b = render({ loop: name }, 0.07 + period), diff = a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0) / a.length;
        r.push([`loop ${name}`, diff < 0.02 && hash(a) !== hash(render({ loop: name }, 0.21))]);
      }
      return r;
    }, media);
    for (const [name, ok] of clipChecks) check(`${rm}: clip ${name}, rendered endpoints/period and export samples`, ok);

    // All new text presets, curved multiline text and keyed curve in one three-second export.
    await ev(async ({ media, inventory }) => {
      await REMOTE.new_project({ name: 'Text FX parity', ratio: '16:9', branded: false });
      await REMOTE.set_project({ set: { fps: 24, bg: '#18202b' } });
      await REMOTE.add_clip({ media, in: 0, out: 3 });
      const cases = [...inventory.ins.map(anim => ({ anim })), ...inventory.outs.map(out => ({ out })), ...inventory.loops.map(loop => ({ loop }))];
      for (const [i, style] of cases.entries()) await REMOTE.add_text({ text: 'Move me', start: 0, duration: 3, x: (i % 7 + 0.5) / 7, y: 0.09 + Math.floor(i / 7) * 0.16,
        curve: i % 3 ? 0 : (i % 2 ? -45 : 45), style: { font: 'Montserrat', size: 48, weight: 800, color: '#ffc65c', color2: '#ec59a1', shadow: true, shc: '#7a3ddb', strokeW: 2, box: i % 2 === 0, boxColor: '#13243a', animT: 1, outT: 1, ...style } });
      const c = await REMOTE.add_text({ text: 'Curved\nTwo lines', duration: 3, y: 0.79, style: { size: 65, box: true, strokeW: 2, shadow: true, anim: 'letterblur', out: 'slideblur', animT: 0.8, outT: 0.8 } });
      await REMOTE.update_clip({ id: c.id, set: { kf: [{ t: 0, curve: -70 }, { t: 1.5, curve: 70 }, { t: 3, curve: -70 }] } });
    }, { media, inventory });
    const exports = [];
    for (const mode of ['workers', 'page', 'preview']) {
      const result = await ev(async mode => {
        S.layerForce = mode === 'page' ? 'page' : undefined;
        const plan = await buildPlan(960, 540, 'fast', `text-fx-${mode}`, false, 'prores'), layerMode = S.layerMode;
        if (mode === 'preview') { // Full-frame pictures directly from preview drawing, bypassing layerScan/crop/worker batching.
          const cv = new OffscreenCanvas(960, 540), x = cv.getContext('2d'), pngs = [], frames = [];
          for (let f = 0; f < Math.round(plan.duration * P.fps); f++) {
            x.clearRect(0, 0, 960, 540); drawTexts(x, f / P.fps, 960 / P.w, true);
            pngs.push(await blobURL(await cv.convertToBlob({ type: 'image/png' }))); frames.push({ i: f, start: f / P.fps, end: (f + 1) / P.fps });
          }
          plan.text = { pngs, frames };
        }
        const { job } = await api('/api/export', plan), deadline = Date.now() + 180000;
        while (Date.now() < deadline) { const j = await api(`/api/jobs/${job}`); if (j.state !== 'running') { if (j.state !== 'done') throw new Error(j.error || j.state); return { file: j.file, layerMode }; } await sleep(250); }
        throw new Error('Text FX export timed out');
      }, mode);
      exports.push({ ...result, hashes: md5(path.join(HOME, 'exports', result.file)) });
    }
    for (const i of [0, 1]) check(`${rm}: ${i ? 'page' : 'workers'} export equals preview pictures on all 72 frames`, exports[i].hashes.length === 72 && exports[i].hashes.every((h, f) => h === exports[2].hashes[f]));
    check(`${rm}: both export drawing paths were exercised`, exports[0].layerMode === 'workers' && exports[1].layerMode === 'page', exports.map(x => x.layerMode).join(', '));
    await page.screenshot({ path: new URL(`${rm}.png`, OUT).pathname });
    check(`${rm}: no page errors`, errors.length === 0, errors.join('; '));
    await context.close();
  }
} finally { await b.close(); }
process.exitCode = checks.every(Boolean) ? 0 : 1;
