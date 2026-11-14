// The 4 starter templates in templates/, built in the editor itself with no third-party media: the footage is test
// patterns made here (they become the numbered slots and never ship), the sounds are Cutroom's own synthesized effects
// (kept by name, made again on any Mac). Run it again after changing a starter's recipe below.
//   CUTROOM_HOME=<scratch lib> CUTROOM_PORT=4751 python3 -I server.py, then B=http://127.0.0.1:4751 CUTROOM_SCRATCH=<dir> node make_starters.mjs
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const B = process.env.B || 'http://127.0.0.1:4751', SCR = process.env.CUTROOM_SCRATCH || '/tmp/cutroom-scratch', OUT = fileURLToPath(new URL('../templates/', import.meta.url));
if (/:4610\b/.test(B)) throw new Error('run on a scratch server');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PYTHONPATH'));
const ff = (...a) => execFileSync('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-y', ...a], { env });
const api = async (path, body) => {
  const r = await fetch(B + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const FX = mkdtempSync(`${SCR}/starters-`);
const clip = (name, w, h, hue, audio = false) => { // a moving test pattern, tinted so the slots tell apart while building
  ff('-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=30:d=12,hue=h=${hue}`, ...(audio ? ['-f', 'lavfi', '-i', 'sine=f=180:d=12', '-c:a', 'aac', '-shortest'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${FX}/${name}`);
  return api('/api/import_path', { path: `${FX}/${name}` });
};
const V = [];
for (let i = 0; i < 6; i++) V.push(await clip(`tall${i + 1}.mp4`, 540, 960, i * 60));
const SQ = [await clip('square1.mp4', 720, 900, 30), await clip('square2.mp4', 720, 900, 200)];
ff('-f', 'lavfi', '-i', 'testsrc=s=800x1000', '-frames:v', '1', `${FX}/photo.png`);
const PH = await api('/api/import_path', { path: `${FX}/photo.png` });
const TALK = await clip('talk.mp4', 1280, 720, 0, true);
ff('-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:d=12", '-c:a', 'aac', `${FX}/beat.m4a`); // a kick every half second: 120 BPM
const MUS = await api('/api/import_path', { path: `${FX}/beat.m4a` });
for (let i = 0; i < 120; i++) { if ((await api('/api/media')).filter(m => [...V, ...SQ, TALK, MUS].some(x => x.id === m.id)).every(m => m.ready)) break; await new Promise(r => setTimeout(r, 500)); }

const b = await webkit.launch();
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', e => { throw e; });
await page.goto(`${B}/`);
await page.waitForFunction(() => typeof P !== 'undefined' && P && typeof REMOTE !== 'undefined', null, { timeout: 20000 });
await page.evaluate(() => { if (tourAt >= 0) tourGo('skip'); });
const R = (cmd, args = {}) => page.evaluate(([c, a]) => REMOTE[c](a), [cmd, args]);
const main = (m, len, set) => R('add_clip', { media: m.id, lane: 'main', in: 3, out: 3 + len }).then(async c => (set ? R('update_clip', { id: c.id, set }) : c));

const STARTERS = {
  cafe0000a001: async () => { // vertical vlog intro
    await R('new_project', { ratio: '9:16', name: 'Vlog intro' });
    const a = await main(V[0], 2.4, { anim: { loop: 'kbin', amt: 1 } }), c = await main(V[1], 1.9), d = await main(V[2], 2.6, { anim: { loop: 'drift', amt: 1 } });
    await R('set_transition', { after: a.id, type: 'whipleft', duration: 0.3 });
    await R('set_transition', { after: c.id, type: 'zoomin', duration: 0.3 });
    await R('add_text', { text: 'My week in Lisbon', preset: 'Headline', start: 0.2, duration: 2.6, y: 0.4, style: { anim: 'pop', out: 'fade' } });
    await R('add_text', { text: 'Day 1', preset: 'Label', start: 4.1, duration: 2.3, y: 0.78, style: { anim: 'slide', out: 'fade' } });
    await R('add_sound', { name: 'whoosh', at: 1.75 });
    await R('add_sound', { name: 'swish', at: 3.85 });
    return { name: 'Vlog intro', labels: { [V[0].id]: 'Opening shot', [V[1].id]: 'A detail', [V[2].id]: 'You, on camera' } };
  },
  cafe0000a002: async () => { // product showcase with a price
    await R('new_project', { ratio: '4:5', name: 'Product showcase' });
    const a = await main(SQ[0], 3, { anim: { loop: 'kbin', amt: 1 } });
    const p = await R('add_clip', { media: PH.id, lane: 'main', in: 0, out: 2.6 });
    await R('update_clip', { id: p.id, set: { fit: 'fill', anim: { loop: 'kbout', amt: 1 } } });
    await main(SQ[1], 3);
    await R('set_transition', { after: a.id, type: 'dissolve', duration: 0.4 });
    await R('set_transition', { after: p.id, type: 'smoothleft', duration: 0.4 });
    await R('add_text', { text: 'Aurora lamp', preset: 'Title', start: 0.3, duration: 2.5, y: 0.82, style: { size: 96, anim: 'fade', out: 'fade' } });
    await R('add_text', { text: '$49', preset: 'Bubble', start: 3.1, duration: 2.4, y: 0.8, style: { size: 92, anim: 'pop', out: 'pop' } });
    await R('add_text', { text: 'Shop now', preset: 'Label', start: 6.0, duration: 2.0, y: 0.84, style: { anim: 'slide' } });
    await R('add_sound', { name: 'pop', at: 3.1 });
    await R('add_sound', { name: 'ding', at: 6.0 });
    await R('add_effect', { type: 'vignette', start: 0, duration: 8, strength: 0.6 });
    return { name: 'Product showcase', labels: { [SQ[0].id]: 'The product, turning', [PH.id]: 'A close-up photo', [SQ[1].id]: 'It in use' } };
  },
  cafe0000a003: async () => { // podcast clip: one speaker, a hook, a name, captions made from the new speech
    await R('new_project', { ratio: '9:16', name: 'Podcast clip' });
    await main(TALK, 8.5, { fit: 'blur' });
    await R('set_project', { set: { capStyle: await page.evaluate(() => ({ ...CAP_PRESETS['Karaoke Gold'], y: 0.7 })) } });
    await R('add_text', { text: 'The one thing nobody tells you', preset: 'Label', start: 0, duration: 8.5, y: 0.16, style: { size: 56, anim: 'fade' } });
    await R('add_text', { text: 'Guest name · Show name', preset: 'Minimal', start: 0.6, duration: 3.4, y: 0.62, style: { font: 'Montserrat', weight: 500, size: 40, anim: 'fade', out: 'fade' } }); // (bundled fonts: the same on every computer)
    return { name: 'Podcast clip', labels: { [TALK.id]: 'The speaker' }, recaption: true };
  },
  cafe0000a004: async () => { // beat-cut travel montage: cuts on the beat of a 120 BPM song (2, 1, 1, 1, 1, 2 s)
    await R('new_project', { ratio: '9:16', name: 'Travel montage' });
    for (const [i, len] of [2, 1, 1, 1, 1, 2].entries()) await main(V[i], len, i === 0 || i === 5 ? { anim: { loop: 'kbin', amt: 1 } } : undefined);
    await R('add_clip', { media: MUS.id, lane: 'audio', start: 0, in: 0, out: 8 }).then(c => R('update_clip', { id: c.id, set: { fadeOut: 1 } }));
    for (const t of [2, 4, 6]) await R('add_effect', { type: 'flash', start: t, duration: 0.25 });
    await R('set_project', { set: { markers: [2, 3, 4, 5, 6] } });
    await R('add_text', { text: 'Wander', preset: 'Outline', start: 0.15, duration: 1.8, y: 0.42, style: { anim: 'zoom', out: 'fade' } });
    await R('add_text', { text: 'Lisbon · Porto · Sintra', preset: 'Minimal', start: 6, duration: 2, y: 0.8, style: { font: 'Montserrat', weight: 500, size: 44, anim: 'fade' } });
    return { name: 'Travel montage', labels: Object.fromEntries(['Wide view', 'A street', 'Food', 'A detail', 'People', 'Sunset'].map((l, i) => [V[i].id, l])), keep: [], music: MUS.id };
  },
};
for (const [id, build] of Object.entries(STARTERS)) {
  const o = await build();
  if (o.music) o.labels[o.music] = 'Your music';
  const t = await page.evaluate(o => saveTemplate(o), o);
  await api(`/api/templates/${t.id}/trash`, {}); // (the library's copy: the starter lives in the repo)
  delete t.created;
  writeFileSync(`${OUT}${id}.json`, `${JSON.stringify({ ...t, id }, null, 1)}\n`);
  console.log(`${id} ${t.name}: ${t.slots.length} slots, ${t.dur} s, ${t.texts.length} texts`);
}
await b.close();
