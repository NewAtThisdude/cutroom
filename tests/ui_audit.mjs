// Layout audit, headless WebKit at the app's window size: every rail tab, every inspector tab for each kind of clip, the
// modals. Flags text cut off without an ellipsis, text boxes that overlap, and things poking out of their panel.
// Screenshots go to tests/out/. Exit code = number of problems.  node ui_audit.mjs [width height]
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const [W, H] = [+(process.argv[2] || 1517), +(process.argv[3] || 904)], OUT = fileURLToPath(new URL('./out/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const b = await browser.launch(), page = await (await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto((process.env.B || 'http://127.0.0.1:4610') + '/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
let problems = 0;
const audit = async (name, root) => {
  await page.waitForTimeout(250);
  const r = await ev(root => {
    const vis = e => { const s = getComputedStyle(e), q = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && q.width > 0 && q.height > 0 && e.offsetParent !== null; };
    const scope = document.querySelector(root);
    if (!scope) return { bad: [`no ${root}`] };
    const sr = scope.getBoundingClientRect(), bad = [];
    const label = e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''} "${(e.textContent || e.value || '').trim().slice(0, 40)}"`;
    const texty = [...scope.querySelectorAll('*')].filter(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !e.closest('svg,canvas,textarea'));
    for (const e of texty) { // clipped: wider than its box, not an intentional ellipsis; or taller (wrapped into a fixed-height box)
      const s = getComputedStyle(e), rg = document.createRange(); rg.selectNodeContents(e);
      const ell = s.textOverflow === 'ellipsis' && /nowrap|pre/.test(s.whiteSpace) && !/flex|grid/.test(s.display); // an ellipsis the browser can actually draw
      const tq = rg.getBoundingClientRect(), eq = e.getBoundingClientRect(), pl = parseFloat(s.paddingLeft) || 0, pr = parseFloat(s.paddingRight) || 0;
      if (!ell && (tq.right > eq.right - pr + 1.5 || tq.left < eq.left + pl - 1.5) && tq.width > 0) bad.push(`text past its box: ${label(e)} (text ${Math.round(tq.width)} px, room ${Math.round(eq.width - pl - pr)})`);
      if (e.scrollWidth > e.clientWidth + 1 && !ell && s.overflowX !== 'visible') bad.push(`cut off: ${label(e)} (${e.scrollWidth} > ${e.clientWidth})`);
      if (e.scrollHeight > e.clientHeight + 2 && s.overflowY === 'hidden' && s.textOverflow !== 'ellipsis' && !s.webkitLineClamp) bad.push(`cut off vertically: ${label(e)}`);
    }
    // text that leaves its scroll container sideways (a row too wide for the panel)
    for (const e of [...scope.querySelectorAll('button, label, span, b, small, input, select, h4, p, div')].filter(vis)) {
      if (e.closest('.tl-scroll')) continue; // the timeline scrolls sideways by design
      const q = e.getBoundingClientRect(), pane = e.closest('.pane, #inspector, .modal-card, #modal > div, .confirm') || scope, pr = pane.getBoundingClientRect();
      if (q.right > pr.right + 1 || q.left < pr.left - 1) { bad.push(`pokes out of ${pane.id || pane.className}: ${label(e)} (${Math.round(q.left)}..${Math.round(q.right)} vs ${Math.round(pr.left)}..${Math.round(pr.right)})`); }
    }
    // overlapping text boxes (leaf text, not nested in one another)
    const leaf = texty.map(e => { // the text as drawn: cut to its box when the box clips (an ellipsis hides the rest)
      const rg = document.createRange(); rg.selectNodeContents(e); let q = rg.getBoundingClientRect();
      if (getComputedStyle(e).overflowX !== 'visible') { const er = e.getBoundingClientRect(), l = Math.max(q.left, er.left), r = Math.min(q.right, er.right); q = new DOMRect(l, q.top, Math.max(0, r - l), q.height); }
      for (let a = e.parentElement; a && a !== scope; a = a.parentElement) if (getComputedStyle(a).overflowY !== 'visible') { // a scrolling list inside the panel hides what is scrolled out
        const ar = a.getBoundingClientRect(), t = Math.max(q.top, ar.top), bo = Math.min(q.bottom, ar.bottom); q = new DOMRect(q.left, t, bo > t ? q.width : 0, Math.max(0, bo - t));
      }
      return [e, q];
    }).filter(([, q]) => q.width > 0);
    for (let i = 0; i < leaf.length; i++) for (let j = i + 1; j < leaf.length; j++) {
      const [a, p] = leaf[i], [c, q] = leaf[j];
      if (a.contains(c) || c.contains(a)) continue;
      const ix = Math.min(p.right, q.right) - Math.max(p.left, q.left), iy = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (ix > 2 && iy > 2) bad.push(`overlap: ${label(a)} / ${label(c)}`);
    }
    return { bad: [...new Set(bad)].slice(0, 25), w: Math.round(sr.width) };
  }, root);
  const shot = `${OUT}${name.replace(/[^a-z0-9]+/gi, '_')}`;
  await page.screenshot({ path: `${shot}.png` });
  const el = await page.$(root), sh = await ev(r => { const e = document.querySelector(r); return e ? [e.scrollHeight, e.clientHeight] : [0, 0]; }, root);
  for (let y = sh[1], k = 2; el && y < sh[0]; y += sh[1] - 40, k++) { await ev(([r, y]) => { document.querySelector(r).scrollTop = y; }, [root, y]); await page.waitForTimeout(150); await el.screenshot({ path: `${shot}_${k}.png` }); }
  if (el) await ev(r => { document.querySelector(r).scrollTop = 0; }, root);
  problems += r.bad.length;
  console.log(`${r.bad.length ? 'FIX ' : 'ok  '} ${name}${r.bad.length ? '\n      ' + r.bad.join('\n      ') : ''}`);
};
// a scratch project with one of every kind of clip
await ev(() => {
  setProject(newProject('16:9')); P.name = 'UI audit (scratch)';
  const v = [...M.values()].find(m => m.kind === 'video' && m.hasAudio && m.duration > 8), a = [...M.values()].find(m => m.kind === 'audio');
  addMedia(v.id, 'main'); addMedia(v.id, 'overlay', 1); addMedia(a.id, 'audio', 0); addText('Title');
  P.captions = [{ id: hex12(), start: 0.5, dur: 1.5, text: 'Caption line here', words: [] }];
  P.fx = [{ id: hex12(), fx: Object.keys(FX)[0], start: 0, dur: 2, amt: 1 }, { id: hex12(), fx: 'adjust', start: 2, dur: 2, amt: 1, adj: { b: 1.1, c: 1, s: 1 } }];
  renderAll();
});
const pid = await ev(() => P.id);
for (const t of ['media', 'audio', 'text', 'stickers', 'effects', 'transitions', 'filters', 'captions', 'script', 'ai']) {
  await page.click(`.rail button[data-tab="${t}"]`);
  await audit(`rail ${t}`, `#tab-${t}`);
}
for (const [lane, i] of [['main', 0], ['overlay', 0], ['audio', 0], ['text', 0], ['captions', 0], ['fx', 0], ['fx', 1]]) { // fx 1: the adjustment layer
  await ev(([l, i]) => { const c = P[l][i]; S.sel = { lane: l, id: c.id }; renderAll(); }, [lane, i]);
  const tabs = await page.$$eval('#inspector .itabs button', bs => bs.map(x => x.dataset.itab));
  if (!tabs.length) await audit(`inspector ${lane}${i ? " adjust" : ""}`, '#inspector');
  for (const it of tabs) { await page.click(`#inspector .itabs button[data-itab="${it}"]`); await audit(`inspector ${lane}${i ? " adjust" : ""} / ${it}`, '#inspector'); }
}
await ev(() => { S.sel = null; renderAll(); });
await audit('inspector project', '#inspector');
await audit('top bar', 'header');
await audit('timeline', '.tl-body');
for (const [btn, name] of [['#btnExport', 'export dialog'], ['#btnProjects', 'projects'], ['#btnTemplates', 'templates']]) {
  if (await page.$(btn)) { await page.click(btn); await page.waitForTimeout(500); await audit(name, '#modal'); await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
}
if (errs.length) console.log('page errors:', errs.slice(0, 5));
await fetch(`${process.env.B || "http://127.0.0.1:4610"}/api/projects/${pid}/trash`, { method: 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
console.log(`\n${problems} problems, screenshots in ${OUT}`);
await b.close();
process.exit(Math.min(problems, 100));
