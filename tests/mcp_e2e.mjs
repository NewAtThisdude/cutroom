// Every MCP command end to end, with the real on-device models: each REMOTE command (what the MCP tools call) runs in
// headless WebKit exactly as the remote loop runs it (one undo step per command), and the result is checked against the
// project, the library and the rendered files (ffprobe). Also checks the MCP server itself: its tool list maps onto
// REMOTE, and read-only tools answer through the real stdio -> server -> editor path. Everything made is trashed.
//   node mcp_e2e.mjs [only]   (server on 127.0.0.1:4610; slow: the AI tools run for real)
import { browser } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.B || 'http://127.0.0.1:4610', H = { 'X-Cutroom': '1', 'Content-Type': 'application/json' }, only = process.argv[2], HOME = process.env.CUTROOM_HOME || `${os.homedir()}/Movies/Cutroom`, EXP = `${HOME}/exports`;
const res = [];
const check = (name, ok, detail = '') => { res.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${String(detail).slice(0, 300)}]` : ''}`); };
const get = async p => (await fetch(B + p)).json();
const before = { p: new Set((await get('/api/projects')).map(x => x.id)), m: new Set((await get('/api/media')).map(x => x.id)), e: new Set(fs.readdirSync(EXP)) };
const probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,pix_fmt', '-of', 'json', `${EXP}/${f}`]));

// a talking clip with pauses and a filler (macOS say), over moving test video with a hard scene cut at 5 s
const tmp = fs.mkdtempSync(`${os.tmpdir()}/cutroom-mcp-`);
execFileSync('say', ['-v', 'Samantha', '-o', `${tmp}/speech.aiff`, 'Hello and welcome to the editing test. Um, this is the first sentence. [[slnc 1600]] Now we talk about colours and video. [[slnc 1600]] Thanks for watching, goodbye.']);
const sd = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${tmp}/speech.aiff`]).toString();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=5`, '-f', 'lavfi', '-i', `smptebars=s=1280x720:r=30:d=${(sd - 5 + 0.5).toFixed(2)}`, '-i', `${tmp}/speech.aiff`,
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `${tmp}/mcp-talk.mp4`]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=800x800:d=1', '-frames:v', '1', `${tmp}/mcp-pic.png`]);
const imp = async f => (await (await fetch(`${B}/api/import?name=${f.split('/').pop()}`, { method: 'POST', headers: { 'X-Cutroom': '1' }, body: fs.readFileSync(f) })).json());
const TALK = await imp(`${tmp}/mcp-talk.mp4`), PIC = await imp(`${tmp}/mcp-pic.png`);
fs.rmSync(tmp, { recursive: true });

// ---------- the MCP server: tools map onto REMOTE; read-only tools answer through the real path ----------
const mcp = spawn('python3', ['-I', fileURLToPath(new URL('../mcp/cutroom_mcp.py', import.meta.url))], { env: { ...process.env, PYTHONPATH: '', CUTROOM_PORT: new URL(B).port || '4610' } }); // the MCP server talks to the server under test
let buf = '';
const waiting = new Map();
mcp.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not json */ } } });
let rid = 0;
const rpc = (method, params = {}) => new Promise((ok, no) => { const id = ++rid; waiting.set(id, ok); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); setTimeout(() => no(new Error(`${method} timed out`)), 60000); });
const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
check('MCP initialize answers with instructions', init.result?.serverInfo?.name === 'cutroom' && init.result.instructions?.length > 100);
const tools = (await rpc('tools/list')).result.tools;

const b = await browser.launch(), page = await (await b.newContext({ viewport: { width: 1517, height: 904 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
const isNext = u => u.pathname === '/api/remote/next', hold = async r => { await new Promise(z => setTimeout(z, 15000)); r.fulfill({ contentType: 'application/json', body: '{}' }).catch(() => {}); };
await page.route(isNext, hold); // the real app keeps the MCP commands
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 20000 });
const ev = (f, a) => page.evaluate(f, a);
await ev(() => loadMedia());
await page.waitForFunction(ids => ids.every(id => M.get(id)?.ready), [TALK.id, PIC.id], { timeout: 90000 });
const CMD = { add_sound_effect: 'add_sound', generate_image: 'ai_image' }, remoteNames = await ev(() => Object.keys(REMOTE));
const VIA_PATH = ['import_media', 'import_subtitles', 'import_lut', 'import_fx']; // the MCP server reads the file and passes its contents
const unmapped = tools.filter(t => t.name !== 'import_media' && !remoteNames.includes(CMD[t.name] || t.name)).map(t => t.name);
check(`all ${tools.length} MCP tools map onto an editor command`, !unmapped.length, unmapped.join(', '));
const sigs = await ev(() => Object.fromEntries(Object.entries(REMOTE).map(([k, f]) => [k, String(f).slice(0, String(f).indexOf(')') + 1)])));
const stray = tools.filter(t => !VIA_PATH.includes(t.name)).flatMap(t => Object.keys(t.inputSchema.properties).filter(p => { const sig = sigs[CMD[t.name] || t.name]; return sig && !/\(\w+\)|\.\.\.\w+/.test(sig) && !new RegExp(`\\b${p}\\b`).test(sig); }).map(p => `${t.name}.${p}`));
check('every tool argument is one its command reads', !stray.length, stray.join(', '));
await page.unroute(isNext, hold); // for these read-only calls this page is the editor (the MCP server would open the app otherwise)
await page.waitForTimeout(16000);
for (const t of ['status', 'options', 'timeline', 'media', 'projects']) {
  const r = await rpc('tools/call', { name: t, arguments: {} });
  check(`MCP ${t} answers through the server and the open editor`, r.result && !r.result.isError && r.result.content[0].text.length > 2, r.result?.content?.[0]?.text?.slice(0, 120));
}
mcp.kill();
await page.route(isNext, hold);

// one command as the remote loop runs it
const call = (cmd, args = {}) => ev(async ([cmd, args]) => {
  const p0 = P, u0 = undo.length; remoteLog = [];
  try { const result = await REMOTE[cmd](args); if (P === p0 && undo.length > u0 + 1) undo.splice(u0 + 1); return { ok: true, result, log: remoteLog }; }
  catch (e) { return { ok: false, result: e.message, log: remoteLog }; }
  finally { remoteLog = null; }
}, [cmd, args]);
const T = async (name, cmd, args, test) => {
  if (only && !name.includes(only) && !cmd.includes(only)) return null;
  const t0 = Date.now(), r = await call(cmd, args), e = errs.splice(0);
  let ok = r.ok, detail = r.ok ? '' : r.result;
  if (ok && test) { try { const v = await test(r.result); if (v !== true) { ok = false; detail = v === false ? JSON.stringify(r.result).slice(0, 200) : v; } } catch (x) { ok = false; detail = x.message; } }
  if (e.length) { ok = false; detail += ` page errors: ${e.join(' | ')}`; }
  check(`${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`, ok, detail);
  return r.result;
};
const fails = async (name, cmd, args, want) => { if (only && !name.includes(only)) return; const r = await call(cmd, args); check(`${name} is refused clearly`, !r.ok && want.test(r.result), r.result); };
const tl = async () => (await call('timeline')).result;
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

// ---------- project ----------
await T('options lists every choice', 'options', {}, o => o.transitions.length > 20 && o.looks.length > 10 && Object.keys(o.effects).length > 20 && o.exportFormats.length >= 8 && o.exportFormats.includes('mp4'));
await T('new_project 16:9 with a name', 'new_project', { ratio: '16:9', name: 'MCP e2e (scratch)' }, () => ev(() => P.name === 'MCP e2e (scratch)' && P.w === 1920 && P.h === 1080));
await fails('new_project with a bad ratio', 'new_project', { ratio: '7:3' }, /ratio must be one of/);
await T('set_project name, fps, background, caption style', 'set_project', { set: { name: 'MCP e2e (scratch)', fps: 25, bg: '#102030', capStyle: { size: 70 } } }, () => ev(() => P.fps === 25 && P.bg === '#102030' && P.capStyle.size === 70));
await fails('set_project with an unknown key', 'set_project', { set: { colour: 1 } }, /can't set project\.colour/);
const pid = await ev(() => P.id);

// ---------- clips ----------
const c1 = await T('add_clip main (talking video)', 'add_clip', { media: TALK.id }, c => c.lane === 'main' && near(c.dur, TALK.duration, 0.1));
const c2 = await T('add_clip main by name with in/out', 'add_clip', { media: 'cafe-and-dinner', in: 1, out: 4 }, c => c.lane === 'main' && near(c.start, TALK.duration, 0.1) && near(c.dur, 3, 0.01));
const o1 = await T('add_clip overlay image at 1 s', 'add_clip', { media: PIC.id, lane: 'overlay', start: 1 }, c => c.lane === 'overlay' && c.start === 1);
const a1 = await T('add_clip audio (music) at 0', 'add_clip', { media: 'music.m4a', lane: 'audio', start: 0 }, c => c.lane === 'audio' && c.kind === 'audio');
await fails('add_clip of media that is not there', 'add_clip', { media: 'no-such-file-xyz' }, /no media/);
await T('update_clip: look, adjust, transform, fades, keyframes, mask, animation', 'update_clip', { id: o1.id, set: { scale: 0.5, x: 0.2, y: -0.1, rot: 10, opacity: 0.8, blend: 'screen', look: { name: 'teal', amount: 0.7 }, adj: { b: 1.1, temp: 0.3 }, fadeIn: 0.5, fadeOut: 0.5, kf: [{ t: 0, scale: 0.5 }, { t: 2, scale: 0.9 }], mask: { type: 'circle', x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 0.1, invert: false }, anim: { in: 'grow', ind: 0.5 } } },
  async c => c.scale === 0.5 && c.blend === 'screen' && c.look?.name === 'teal' && c.keyframes === 2 && c.mask === 'circle' && await ev(id => P.overlay.find(x => x.id === id).kf.every(f => f.x === 0.2 && f.opacity === 0.8), o1.id) || 'partial keyframes did not keep the position');
await T('update_clip audio: voice, EQ, pan, volume points', 'update_clip', { id: a1.id, set: { volume: 0.5, au: { voice: 'echo', semi: 2, bass: 3, pan: -0.5 }, vkf: [{ t: 0, v: 1 }, { t: 3, v: 0.2 }] } }, c => c.volume === 0.5 && c.volumePoints === 2);
await T('update_clip null deletes a setting', 'update_clip', { id: o1.id, set: { mask: null } }, c => !c.mask);
await fails('update_clip of a setting that is not editable', 'update_clip', { id: o1.id, set: { media: 'x' } }, /not editable: media/);
await fails('update_clip with a word for a number', 'update_clip', { id: o1.id, set: { scale: 'big' } }, /scale must be numbers?/);
await fails('update_clip with keyframes missing their time', 'update_clip', { id: o1.id, set: { kf: [{ scale: 2 }] } }, /kf must be a list/);
await fails('update_clip of a clip that is not there', 'update_clip', { id: 'ffffffffffff', set: { scale: 1 } }, /no clip with id/);
const sp = await T('split_clip in the middle', 'split_clip', { id: c2.id, at: c2.start + 1.5 }, ([x, y]) => near(x.dur + y.dur, 3, 0.05) && near(y.start, x.start + x.dur, 0.05));
await fails('split_clip outside the clip', 'split_clip', { id: c2.id, at: 0.1 }, /at must be inside the clip/);
const dupd = await T('duplicate_clip', 'duplicate_clip', { id: o1.id }, c => c.id !== o1.id && c.lane === 'overlay');
await T('move_clip overlay start', 'move_clip', { id: dupd.id, start: 6 }, c => c.start === 6);
await T('move_clip main order (index)', 'move_clip', { id: sp[1].id, index: 0 }, async () => (await tl()).tracks.main[0].id === sp[1].id);
await T('move_clip between tracks (main → overlay)', 'move_clip', { id: sp[1].id, lane: 'overlay' }, async () => (await tl()).tracks.overlay.some(c => c.id === sp[1].id));
await T('delete_clip', 'delete_clip', { id: sp[1].id }, async () => !(await tl()).tracks.overlay.some(c => c.id === sp[1].id));
await T('add_text with a preset and style', 'add_text', { text: 'Hello MCP', preset: 'Headline', start: 0.5, duration: 2, y: 0.3, style: { color: '#ffcc00' } }, c => c.text === 'Hello MCP' && c.dur === 2 && c.style.color === '#ffcc00');
await fails('add_text with a preset that is not there', 'add_text', { text: 'x', preset: 'Nope' }, /preset must be one of/);
await T('set_transition after the first clip', 'set_transition', { after: c1.id, type: 'dissolve', duration: 0.6 }, m => m[0].tr?.type === 'dissolve');
await T('set_transition on every cut, then none', 'set_transition', { type: 'slideleft', all: true }, async m => m.slice(0, -1).every(c => c.tr?.type === 'slideleft') && (await call('set_transition', { after: c1.id, type: 'none' })).ok);
await fails('set_transition of a type that is not there', 'set_transition', { after: c1.id, type: 'warp9' }, /type must be none or one of/);
const fx1 = await T('add_effect', 'add_effect', { type: 'vhs', start: 1, duration: 2, strength: 1.5 }, c => c.fx === 'vhs' && c.dur === 2 && c.strength === 1.5);
if (fx1) await T('update_clip of an effect', 'update_clip', { id: fx1.id, set: { fx: 'glitch', amt: 0.5 } }, c => c.fx === 'glitch');
await T('add_sound_effect (whoosh)', 'add_sound', { name: 'whoosh', at: 2 }, async () => (await tl()).tracks.audio.some(c => /whoosh/i.test(c.media) && near(c.start, 2, 0.01)));
await fails('add_sound_effect that is not there', 'add_sound', { name: 'kazoo-solo' }, /no sound called kazoo-solo/);
await T('seek', 'seek', { t: 3.25 }, r => near(r.playhead, 3.24, 0.05));
const u0 = await ev(() => JSON.stringify(P));
await call('update_clip', { id: c1.id, set: { speed: 1.5 } });
await T('history undo puts the last command back', 'history', { action: 'undo' }, () => ev(u0 => JSON.stringify(P) === u0, u0));
await T('history redo', 'history', { action: 'redo' }, async () => (await tl()).tracks.main.find(c => c.id === c1.id)?.speed === 1.5);
await call('history', { action: 'undo' });

// ---------- look at it ----------
const snapOk = async r => { const d = await ev(async b64 => { const i = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(32, 18), g = c.getContext('2d'); g.drawImage(i, 0, 0, 32, 18); const p = g.getImageData(0, 0, 32, 18).data; let s = 0; for (let k = 0; k < p.length; k += 4) s += p[k] + p[k + 1] + p[k + 2]; return { w: i.width, h: i.height, mean: s / (32 * 18 * 3) }; }, r.image); return (d.w === 720 && Math.abs(d.h - 405) <= 1 && d.mean > 10) || JSON.stringify(d); };
await T('snapshot from the export renderer', 'snapshot', { t: 1.5 }, snapOk);
await T('snapshot of the live preview', 'snapshot', { t: 1.5, preview: true }, snapOk);

// ---------- export every format ----------
const D = await ev(() => total());
for (const [fmt, want] of [['mp4', { v: 'h264', a: 'aac' }], ['hevc', { v: 'hevc', a: 'aac' }], ['prores', { v: 'prores', a: 'pcm' }], ['gif', { v: 'gif' }], ['mp3', { a: 'mp3' }], ['wav', { a: 'pcm' }], ['png', { v: 'png' }]]) {
  await T(`export ${fmt}`, 'export', { format: fmt, resolution: '720p', name: `mcp-e2e-${fmt}`, at: 2 }, r => {
    const p = probe(r.file), v = p.streams.find(s => s.codec_type === 'video'), a = p.streams.find(s => s.codec_type === 'audio'), dur = +p.format.duration;
    if (want.v && v?.codec_name !== want.v) return `video codec ${v?.codec_name}`;
    if (!want.v && v) return `has a picture (${v.codec_name}) it should not`;
    if (want.a && !a?.codec_name?.startsWith(want.a)) return `audio codec ${a?.codec_name}`;
    if (!want.a && a) return 'has sound it should not';
    if (want.v && !(fmt === 'gif' ? v.width === 640 && v.height === 360 : v.width === 1280 && v.height === 720)) return `${v.width}x${v.height}`; // (GIFs stop at 640 px across)
    if (fmt !== 'png' && !near(dur, D, fmt === 'gif' ? 0.15 : 0.1)) return `lasts ${dur} s, timeline ${D} s`;
    return true;
  });
}
await fails('export at a resolution that is not there', 'export', { resolution: '16K' }, /resolution must be one of/);

// ---------- speech: captions, transcript, cuts, pauses, fillers ----------
await call('new_project', { ratio: '16:9', name: 'MCP e2e speech (scratch)' });
await call('add_clip', { media: TALK.id });
await T('transcript of a library item', 'transcript', { media: TALK.id }, r => (r.sentences.length >= 2 && /welcome/i.test(JSON.stringify(r.sentences))) || JSON.stringify(r.sentences).slice(0, 200));
await T('auto_captions (whisper.cpp)', 'auto_captions', { lang: 'en', words: 3, style: (await call('options')).result.captionPresets[0] }, r => (r.captions >= 5 && /hello|welcome/i.test(r.first.join(' '))) || JSON.stringify(r));
const mt = await T('main_transcript', 'main_transcript', {}, r => r.words >= 15 && r.sentences.length >= 2);
if (mt) {
  const s = mt.sentences.find(x => /colou?rs/i.test(x.text)) || mt.sentences[1], d0 = await ev(() => total());
  await T('cut_timeline removes a sentence', 'cut_timeline', { ranges: [[s.start, s.end]] }, async r => (near(r.removedSeconds, s.end - s.start, 0.35) && !/colou?rs/i.test((await call('main_transcript')).result.sentences.map(x => x.text).join(' '))) || JSON.stringify(r));
  await T('captions follow the cut', 'timeline', {}, r => !r.tracks.captions.some(c => /colou?rs/i.test(c.text)) && r.tracks.captions.length > 2);
  await call('history', { action: 'undo' });
  check('undo brings the sentence back', near(await ev(() => total()), d0, 0.05));
}
await T('remove_pauses', 'remove_pauses', { min: 0.8 }, r => (r.removedSeconds > 1 && r.clips >= 2) || JSON.stringify(r));
await T('remove_fillers', 'remove_fillers', {}, r => r.removedSeconds >= 0);
await fails('cut_timeline with nonsense ranges', 'cut_timeline', { ranges: [[3, 1]] }, /ranges/);
await T('translate_captions (local model)', 'translate_captions', { to: 'Spanish' }, r => (r.captions > 0 && r.first.length && !/hello|welcome/i.test(r.first.join(' '))) || JSON.stringify(r));
await T('hook_titles (local model), add the first', 'hook_titles', { add: true }, r => r.hooks.length >= 1 && r.added?.text === r.hooks[0]);

// ---------- voices and sounds ----------
await T('voiceover (Mac voice)', 'voiceover', { text: 'Testing the Mac voice.', at: 0.5 }, c => c.lane === 'audio' && c.dur > 0.5 && near(c.start, 0.5, 0.01));
await T('ai_voiceover (Kokoro)', 'ai_voiceover', { text: 'Testing the natural voice on this Mac.', voice: 'af_heart', speed: 1, at: 1 }, c => c.lane === 'audio' && c.dur > 1 && c.dur < 8);
await T('generate_music (MusicGen), 5 s', 'generate_music', { prompt: 'Lo-fi', duration: 5, at: 0, seed: 7 }, r => (r.duration > 4 && r.duration < 6.5 && r.clip?.lane === 'audio') || JSON.stringify(r));
await T('generate_music add=false stays in the library', 'generate_music', { prompt: 'calm piano', duration: 4, add: false }, r => !r.clip && !!r.id);
await fails('generate_music without a prompt', 'generate_music', {}, /prompt is required/);

// ---------- images ----------
await T('generate_image (Z-Image), draft, on the overlay', 'ai_image', { prompt: 'a red apple on a white table', shape: '1:1', steps: 4, put: 'overlay', start: 0, duration: 2, seed: 3 }, async r => r.clip?.lane === 'overlay' && near(r.clip.dur, 2, 0.01) && (await get('/api/media')).some(m => m.id === r.media && m.kind === 'image'));
await T('generate_image sticker is cut out (transparent)', 'ai_image', { prompt: 'a cartoon cat face', sticker: true, steps: 4, put: 'library', seed: 5 }, async r => { const m = (await get('/api/media')).find(x => x.id === r.media); return !!(m && (m.alpha || m.trans)) || JSON.stringify(m); });

// ---------- smart tools on clips ----------
await call('new_project', { ratio: '16:9', name: 'MCP e2e tools (scratch)' });
const v = (await call('add_clip', { media: 'talk.mp4' })).result, vb = (await call('add_clip', { media: TALK.id })).result, mu = (await call('add_clip', { media: 'music.m4a', lane: 'audio', start: 0 })).result;
const tool = (action, id, extra, test) => T(`clip_tool ${action}`, 'clip_tool', { id, action, ...extra }, test);
await tool('split_scenes', vb.id, {}, r => r.clipsNow === r.clipsBefore + 1 || JSON.stringify(r)); // the test clip cuts to bars at 5 s
await tool('freeze_frame', vb.id, { at: vb.start + 1 }, r => r.clipsNow === r.clipsBefore + 2 || JSON.stringify(r)); // still + the rest of the clip
await fails('clip_tool freeze_frame outside the clip', 'clip_tool', { id: vb.id, action: 'freeze_frame', at: 0.2 }, /at must be a time inside the clip/);
await tool('auto_adjust', v.id, {}, r => !!r.clip?.adj);
await tool('auto_adjust', vb.id, { ref: v.id }, r => !!r.clip?.adj);
await tool('detect_beats', mu.id, {}, async () => ev(id => P.audio.find(c => c.id === id)?.beats?.length > 10, mu.id));
await tool('beat_sync', mu.id, { every: 4 }, r => r.clipsNow >= 3);
await tool('auto_duck', mu.id, { depth: 0.25 }, r => r.clip?.volumePoints >= 2 || JSON.stringify(r.clip));
await tool('detach_audio', v.id, {}, r => (r.clipsNow === r.clipsBefore + 1 && r.clip?.volume === 0) || JSON.stringify(r));
await tool('speed_ramp', v.id, { ramp: 'montage' }, r => (r.clipsNow === r.clipsBefore && r.clip?.ramp?.length === 10) || JSON.stringify(r)); // one clip with a curve, rendered into a copy
await fails('clip_tool speed_ramp with a ramp that is not there', 'clip_tool', { id: v.id, action: 'speed_ramp', ramp: 'warp' }, /ramp must be one of/);
await fails('clip_tool with an action that is not there', 'clip_tool', { id: v.id, action: 'teleport' }, /action must be one of/);
await call('new_project', { ratio: '9:16', name: 'MCP e2e tools 2 (scratch)' });
const t2 = (await call('add_clip', { media: 'talk.mp4', in: 0, out: 4 })).result;
{ const r = await call('clip_tool', { id: t2.id, action: 'auto_reframe' }); // no people in the test footage: it follows the main subject, or says there is none
  check('clip_tool auto_reframe with no face follows the subject or is refused clearly', r.ok ? !!r.result?.clip : /no face|no clear subject/.test(r.result), r.ok ? '' : r.result); }
await tool('reverse', t2.id, {}, r => (r.clip && r.clip.media !== 'talk.mp4') || JSON.stringify(r.clip));
await tool('stabilize', t2.id, {}, r => (r.clip && !/^talk\.mp4$/.test(r.clip.media)) || JSON.stringify(r.clip));
await call('update_clip', { id: t2.id, set: { speed: 0.5 } });
await tool('smooth_slowmo', t2.id, {}, r => !!r.clip || JSON.stringify(r));
await tool('remove_background', t2.id, {}, r => !!r.clip || JSON.stringify(r));
const t3 = (await call('add_clip', { media: 'talk.mp4', in: 0, out: 3 })).result;
await tool('isolate_voice', t3.id, {}, r => !!r.clip);
await tool('remove_voice', t3.id, {}, r => !!r.clip);
await tool('split_stems', t3.id, {}, r => r.clipsNow === r.clipsBefore + 4 || JSON.stringify(r));

// ---------- objects (SAM 2, ProPainter) ----------
await call('new_project', { ratio: '16:9', name: 'MCP e2e objects (scratch)' });
const fox = (await call('add_clip', { media: 'fox-walk.mp4' })).result;
await T('preview_object outlines the fox', 'preview_object', { id: fox.id, box: { x: 0.3, y: 0.3, w: 0.4, h: 0.5 }, t: 1 }, r => r.candidates.length >= 1 && r.image.length > 1000);
await ev(() => { if (!$('#confirmBar').hidden) endPreview(null); });
await fails('preview_object without a box', 'preview_object', { id: fox.id }, /box/);
await T('remove_object, fast', 'remove_object', { id: fox.id, box: { x: 0.3, y: 0.3, w: 0.4, h: 0.5 }, t: 1, quality: 'fast' }, async () => (await tl()).tracks.main[0].media !== 'fox-walk.mp4' || 'still the original clip');
await call('history', { action: 'undo' });
await T('cut_out_object', 'cut_out_object', { id: fox.id, box: { x: 0.3, y: 0.3, w: 0.4, h: 0.5 }, t: 1 }, async () => (await tl()).tracks.main[0].media !== 'fox-walk.mp4' || 'still the original clip');

await T('generate_video on the 4090 PC from the fox frame', 'generate_video', { clip: fox.id, prompt: 'slow camera push in, natural motion', ratio: '16:9', put: 'overlay', at: 0 }, async r => { const m = (await get('/api/media')).find(x => x.id === r.media); return (m && m.kind === 'video' && m.duration > 4 && m.w === 1280 && r.clip?.lane === 'overlay') || JSON.stringify(m); });

// ---------- whole-project tools ----------
await T('smart_combine three videos, 15 s, cinematic', 'smart_combine', { media: ['cafe-and-dinner', 'mountain-hike', 'beach-and-city'], length: 15, style: 'cinematic', ratio: '16:9', music: 'music.m4a' }, r => (r.shots >= 3 && r.duration > 10 && r.duration < 20) || JSON.stringify(r));
await T('make_shorts from the podcast, 2 shorts', 'make_shorts', { media: 'podcast-episode', count: 2, min: 10, max: 25 }, r => (r.shorts.length >= 1 && r.shorts.every(s => s.end - s.start >= 8 && s.end - s.start <= 30)) || JSON.stringify(r));
await T('open_project by name', 'open_project', { project: 'MCP e2e (scratch)' }, s => s.project.name === 'MCP e2e (scratch)');
await fails('open_project that is not there', 'open_project', { project: 'zz-no-such-project-zz' }, /no project/);
await T('projects lists them', 'projects', {}, l => l.some(p => p.id === pid));

// ---------- tidy ----------
await ev(() => clearTimeout(saveTimer));
await b.close();
const after = { p: await get('/api/projects'), m: await get('/api/media') };
const made = { p: after.p.filter(x => !before.p.has(x.id)), m: after.m.filter(x => !before.m.has(x.id)), e: fs.readdirSync(EXP).filter(f => !before.e.has(f)) };
for (const p of made.p) await fetch(`${B}/api/projects/${p.id}/trash`, { method: 'POST', headers: H, body: '{}' });
for (const m of made.m) await fetch(`${B}/api/media/${m.id}/trash`, { method: 'POST', headers: H, body: '{}' });
fs.mkdirSync(`${HOME}/trash/exports`, { recursive: true });
for (const f of made.e) fs.renameSync(`${EXP}/${f}`, `${HOME}/trash/exports/${f}`);
console.log(`\n${res.filter(Boolean).length}/${res.length} passed; trashed ${made.p.length} projects, ${made.m.length} media, ${made.e.length} exports`);
process.exit(res.includes(false) ? 1 : 0);

