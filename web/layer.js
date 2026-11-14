// SPDX-License-Identifier: GPL-3.0-or-later
// Cutroom export: a text-layer worker. Draws frames of the text/effect layer with the preview's own code (draw.js) from
// the project snapshot the page sends, then scans them (pixel hash + ink box) or encodes and uploads the cropped PNGs.
// Messages (buildPlan's textLayer): {init: {P, w, h, k, fonts}} -> {ok}; {probe: [font]} -> {px}; {scan: [frame]} -> {res};
// {encode: {lid, box, items}} -> {done: i}... {end, redrawn}; anything that throws -> {err} (the page then draws the layer itself).
'use strict';
importScripts('draw.js');
let P = null, k = 1, ctx = null;
const shown = lane => P[lane]; // the snapshot holds only what plays (hidden tracks already left out)
onmessage = async ({ data: m }) => {
  try {
    if (m.init) {
      ({ P, k } = m.init);
      for (const [family, buf, desc] of m.init.fonts) { const f = new FontFace(family, buf, desc); await f.load(); self.fonts.add(f); }
      ctx = new OffscreenCanvas(m.init.w, m.init.h).getContext('2d', { willReadFrequently: true });
      postMessage({ ok: 1 });
    } else if (m.probe) postMessage({ px: await layerSerial(() => m.probe.map(probeText)) });
    else if (m.scan) postMessage({ res: await layerScan(ctx, k, m.scan) });
    else if (m.encode) {
      const { lid, box, items } = m.encode;
      postMessage({ end: 1, redrawn: await layerEncode(ctx, k, box, items, lid, i => postMessage({ done: i })) });
    }
  } catch (e) { postMessage({ err: String(e?.message || e) }); }
};
