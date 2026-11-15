// Reproducible media and demo-project stand-ins for an explicitly selected scratch server.
// The release runner holds its GPU lock while calling these helpers. Files in out/fixtures
// are reusable inputs; every library import and project save goes through Cutroom's API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireHome } from './runtime.mjs';

export const fixtureDir = fileURLToPath(new URL('./out/fixtures/', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = error => String(error?.stderr || error?.message || error).trim().split('\n').slice(-3).join(' ').slice(-600);

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 2 << 20,
  }));
}

// Atomic publication means a failed/interrupted ffmpeg never becomes a cached fixture.
export function cachedMedia(name, args, { timeout = 180000 } = {}) {
  if (path.basename(name) !== name) throw new Error('fixture name must be a filename');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const target = path.join(fixtureDir, name);
  if (fs.existsSync(target)) {
    try { if (probe(target).streams.length) return target; } catch { /* regenerate a broken cache entry */ }
    fs.rmSync(target, { force: true });
  }
  const ext = path.extname(name), partial = path.join(fixtureDir, `${path.basename(name, ext)}.${process.pid}.partial${ext}`);
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, partial], {
      timeout, maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!probe(partial).streams.length) throw new Error(`${name} has no streams`);
    fs.renameSync(partial, target);
    return target;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

export function ensurePhoneFixture() {
  if (process.env.PHONE && fs.existsSync(process.env.PHONE)) return path.resolve(process.env.PHONE);
  if (process.env.PHONE) console.log(`NOTE PHONE is unavailable: ${process.env.PHONE}; trying a synthetic HLG source`);
  const name = 'phone-hlg-4k60-v1.mov', cached = path.join(fixtureDir, name);
  if (fs.existsSync(cached)) {
    try {
      const v = probe(cached).streams.find(s => s.codec_type === 'video');
      if (v?.codec_name === 'hevc' && v.width === 3840 && v.height === 2160 && v.color_transfer === 'arib-std-b67' && v.avg_frame_rate === '60/1') return cached;
    } catch { /* try encoding it again */ }
    fs.rmSync(cached, { force: true });
  }
  let encoders;
  try { encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { console.log(`SKIP iPhone HLG source: ffmpeg unavailable (${summary(e)})`); return null; }
  const options = [
    ['libx265', ['-preset', 'ultrafast', '-crf', '22', '-x265-params', 'pools=4:frame-threads=2:log-level=error']],
    ['hevc_videotoolbox', ['-b:v', '20M']],
    ['hevc_nvenc', ['-preset', 'p1', '-b:v', '20M']],
    ['hevc_qsv', ['-preset', 'veryfast', '-b:v', '20M']],
  ];
  const failures = [];
  for (const [encoder, optionsForEncoder] of options) {
    if (!encoders.includes(` ${encoder} `)) continue;
    try {
      const file = cachedMedia(name, ['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=60:d=5',
        '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=5', '-map', '0:v', '-map', '1:a',
        '-vf', 'format=p010le,setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc',
        '-c:v', encoder, ...optionsForEncoder, '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020',
        '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1',
        '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart']);
      console.log(`fixture: synthetic 4K60 HLG HEVC source (${encoder})`);
      return file;
    } catch (e) { failures.push(`${encoder}: ${summary(e)}`); }
  }
  console.log(`SKIP iPhone HLG source: no usable HEVC encoder${failures.length ? ` (${failures.join('; ')})` : ''}`);
  return null;
}

// Uses exactly the operating system voice services used by server.py's voiceover.
// A missing optional voice service skips its dependent checks, not the whole release gate.
export function makeSpeech(file, text, { voice, rate = 180 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify([process.platform, text, voice || '', rate, path.extname(file)])).digest('hex').slice(0, 24);
  const cached = path.join(fixtureDir, `speech-${key}${path.extname(file) || '.wav'}`);
  if (fs.existsSync(cached)) {
    try {
      if (probe(cached).streams.some(s => s.codec_type === 'audio')) { fs.copyFileSync(cached, file); return true; }
    } catch { /* regenerate an interrupted or corrupt speech fixture */ }
    fs.rmSync(cached, { force: true });
  }
  let result;
  if (process.platform === 'darwin') {
    const args = ['-r', String(rate), '-o', file];
    if (path.extname(file).toLowerCase() === '.wav') args.push('--file-format=WAVE', '--data-format=LEI16@22050');
    if (voice) args.push('-v', voice);
    result = spawnSync('say', [...args, text], { encoding: 'utf8', timeout: 60000 });
    // A fresh Mac need not have the particular optional voice installed.
    if (voice && result.status !== 0) result = spawnSync('say', [...args.slice(0, -2), text], { encoding: 'utf8', timeout: 60000 });
  } else if (process.platform === 'win32') {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const speech = xml(text).replace(/\[\[slnc\s+(\d+)\]\]/g, '<break time="$1ms"/>');
    const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; `
      + `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { `
      + `$voices = @($s.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo }); `
      + `$v = $voices | Where-Object Name -eq ${quote(voice || '')} | Select-Object -First 1; `
      + `if (!$v) { $v = $voices | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }; `
      + `if ($v) { $s.SelectVoice($v.Name) }; $s.Rate = ${Math.max(-10, Math.min(10, Math.round((rate - 180) / 20)))}; `
      + `$s.SetOutputToWaveFile(${quote(path.resolve(file))}); `
      + `$s.SpeakSsml(${quote(`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${speech}</speak>`)}); `
      + `} finally { $s.Dispose() }`;
    result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
  }
  if (result?.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 44) {
    const partial = `${cached}.${process.pid}.partial`;
    fs.copyFileSync(file, partial);
    fs.renameSync(partial, cached);
    return true;
  }
  fs.rmSync(file, { force: true });
  console.log(`SKIP speech fixture: ${process.platform === 'darwin' ? 'say' : process.platform === 'win32' ? 'PowerShell System.Speech' : 'OS speech service'} unavailable${result ? ` (${summary(result.error || result.stderr || 'no audio generated')})` : ''}`);
  return false;
}

export async function seedLibrary({ baseUrl = process.env.B, home = process.env.CUTROOM_HOME, phone = false } = {}) {
  requireHome(home);
  if (!baseUrl || new URL(baseUrl).port === '4610') throw new Error('fixtures require a scratch server URL (never port 4610)');
  const api = async (route, body) => {
    const response = await fetch(baseUrl + route, { headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(`fixture ${route}: ${result.error || response.status}`);
    return result;
  };
  const inputs = {
    video: cachedMedia('fixture-testsrc2-12s-v1.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=12',
      '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart']),
    bars: cachedMedia('fixture-smptebars-6s-v1.mp4', ['-f', 'lavfi', '-i', 'smptebars=s=1280x720:r=30:d=6',
      '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart']),
    audio: cachedMedia('fixture-tone-noise-12s-v1.wav', ['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=12',
      '-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:d=12:seed=42:amplitude=0.03',
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest', '-c:a', 'pcm_s16le']),
    image: cachedMedia('fixture-testsrc-1280x720-v1.png', ['-f', 'lavfi', '-i', 'testsrc=s=1280x720', '-frames:v', '1']),
  };
  const media = {};
  for (const [name, file] of Object.entries(inputs)) {
    const item = await api('/api/import_path', { path: file });
    if (!item.id) throw new Error(`fixture import returned no id: ${file}`);
    media[name] = item.id;
  }
  const until = Date.now() + 120000;
  for (;;) {
    // A media JSON file can be briefly unreadable while preparation writes it.
    const response = await fetch(baseUrl + '/api/media', { headers: { 'X-Cutroom': '1' }, signal: AbortSignal.timeout(30000) });
    const items = response.ok ? await response.json() : [];
    if (Object.values(media).every(id => items.find(m => m.id === id)?.ready)) break;
    const failed = items.find(m => Object.values(media).includes(m.id) && m.error);
    if (failed || Date.now() > until) throw new Error(`fixture preparation failed: ${failed?.error || JSON.stringify(items.filter(m => Object.values(media).includes(m.id)))}`);
    await pause(250);
  }
  const { browser } = await import('./browser.mjs');
  const b = await browser.launch(), projects = {};
  try {
    const page = await b.newPage({ viewport: { width: 1517, height: 904 } });
    await page.goto(baseUrl + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof REMOTE !== 'undefined' && typeof P !== 'undefined' && P && M.size > 0, null, { timeout: 30000 });
    await page.evaluate(() => loadMedia());
    for (const [name, duration] of [['cinematic', 10], ['Remove object example', 4], ['Midnight Highway', 6]]) {
      projects[name] = await page.evaluate(async ({ name, duration, media }) => {
        await REMOTE.new_project({ name, ratio: '16:9', branded: false });
        await REMOTE.set_project({ set: { fps: 30 } });
        await REMOTE.add_clip({ media, in: 0, out: duration });
        await flushSave();
        return P.id;
      }, { name, duration, media: media.video });
    }
  } finally { await b.close(); }
  const phonePath = phone ? ensurePhoneFixture() : null;
  console.log(`fixtures: ${Object.keys(media).length} media, ${Object.keys(projects).length} stand-in projects`);
  return { media, projects, phonePath };
}

export const seedFixtures = options => seedLibrary({ ...options, baseUrl: options?.baseUrl ?? options?.baseURL });

// ---------- the AI suites' named footage (ai_worker, captions_pro, tracking), made here and imported on demand ----------
// The suites once used clips and ids of one personal library; these stand-ins are made with ffmpeg and the speech helper, cached
// in out/fixtures, imported through the API when the library lacks them, and found BY NAME (ids differ per library):
//   podcast  podcast-episode-v1.mp4: ~1 min of one voice, sentences apart, over a quiet noise bed
//   fox      fox-walk-v1.mp4 and its clean plate fox-plate-v1.mp4: an orange "fox" with dark legs walking right over a still
//            textured ground, 1280x720 30 fps, 120 frames (tests/fox_truth.py takes the two files: their difference is the fox);
//            PHOTOS/fox-walk.mp4 + PHOTOS/talk-with-music.mp4 (the real shot and its plate) instead when they are there
//   drive    night-drive-{1,2,3}-v1.mp4 (~1 min of talk each, long pauses) and the project "Midnight Highway Journey" that uses a
//            short span of each; "Cutroom demo (fixture)": the podcast on the main track (edit by script)
const AI_TALK = [
  'Welcome back to the show. Today we are talking about editing video on your own computer.',
  'Most people start with their phone, and that is fine for short clips.',
  'But once you have an hour of footage, you need a real timeline.',
  'The first thing I do is cut the long pauses out of every interview.',
  'Then I add captions, because most viewers watch without sound.',
  'Colour comes next. A warm grade makes skin look healthy and bright.',
  'Music should sit under the voice, never on top of it.',
  'Finally, I export a vertical version for social media.',
  'That is the whole workflow. Thanks for listening, and see you next week.',
];
const AI_DRIVE = [
  ['We left the city just after midnight, with an empty highway ahead of us.', 'The engine was quiet and the radio played old songs.',
    'Every few miles a truck passed us going the other way.', 'My friend counted the bridges while I kept my eyes on the road.'],
  ['Around two in the morning we stopped for coffee at a gas station.', 'The cashier told us the mountain pass was closed for repairs.',
    'So we took the coast road instead, which added an hour.', 'Nobody minded, because the ocean looked silver under the moon.'],
  ['By four the sky started to turn grey over the hills.', 'We were tired, but the sunrise made the whole trip worth it.',
    'I parked by the beach and we watched the waves for a while.', 'Then we drove the last twenty miles home and slept until noon.'],
];

function aiSpeechMedia(name, lines, gap, video) { // speech (lines `gap` ms apart) on a video source, over a quiet pink-noise bed
  const wav = path.join(fixtureDir, `${path.basename(name, path.extname(name))}.speech.wav`);
  if (!fs.existsSync(path.join(fixtureDir, name)) && !makeSpeech(wav, lines.join(` [[slnc ${gap}]] `))) return null;
  return cachedMedia(name, ['-f', 'lavfi', '-i', video, '-i', wav, '-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:seed=5:amplitude=0.004',
    '-filter_complex', '[1:a]aresample=48000,apad=pad_dur=1[s];[s][2:a]amix=inputs=2:duration=first:normalize=0[a]', '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart'], { timeout: 600000 });
}

function foxFiles() {
  // the ground: still blurred noise round a dark green; the fox (a 176x164 sprite): body, head and tail orange, legs dark brown from
  // 92 px down, so its pixels below y = 590 are the legs (fox_truth.py). At t = 1 s it spans x 283-459, y 458-622: the ai_worker
  // box {0.21, 0.62, 0.16, 0.26} with ~2 % margin; it walks 20 px/s to the right
  const ground = cachedMedia('fox-ground-v1.png', ['-f', 'lavfi', '-i', 'color=c=0x46603a:s=1280x720,format=rgb24', '-vf',
    'noise=alls=40:allf=u,gblur=sigma=5', '-frames:v', '1']);
  const body = 'lte(pow((X-88)/70,2)+pow((Y-60)/40,2),1)+lte(pow(X-150,2)+pow(Y-24,2),576)+lte(pow((X-20)/22,2)+pow((Y-50)/10,2),1)';
  const legs = 'gte(Y,92)*(between(X,40,52)+between(X,62,74)+between(X,108,120)+between(X,128,140))';
  const sprite = cachedMedia('fox-sprite-v1.png', ['-f', 'lavfi', '-i', 'color=c=black:s=176x164,format=rgba', '-vf',
    `geq=r='if(${legs},45,215)':g='if(${legs},32,110)':b='if(${legs},25,45)':a='255*gt(${body}+${legs},0)'`, '-frames:v', '1']);
  const enc = ['-r', '30', '-frames:v', '120', '-c:v', 'libx264', '-preset', 'slow', '-crf', '10', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart'];
  const plate = cachedMedia('fox-plate-v1.mp4', ['-loop', '1', '-framerate', '30', '-i', ground, ...enc]);
  const walk = cachedMedia('fox-walk-v1.mp4', ['-loop', '1', '-framerate', '30', '-i', ground, '-loop', '1', '-framerate', '30', '-i', sprite,
    '-filter_complex', "[0:v][1:v]overlay=x='263+20*t':y=458:format=rgb", ...enc]);
  return { plate, walk };
}

// names: any of 'podcast', 'fox', 'drive'. Returns { podcast, fox, plate, drive: [3 media], driveProject, demoProject } (media
// objects from /api/media; project ids); speech footage is null where this computer has no speech service (a SKIP line says so)
export async function aiFootage(names, { baseUrl = process.env.B } = {}) {
  requireHome();
  if (!baseUrl || new URL(baseUrl).port === '4610') throw new Error('fixtures require a scratch server URL (never port 4610)');
  const api = async (route, body) => {
    const r = await fetch(baseUrl + route, { headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(`fixture ${route}: ${j.error || r.status}`);
    return j;
  };
  const files = {};
  if (names.includes('podcast') || names.includes('drive')) files.podcast = aiSpeechMedia('podcast-episode-v1.mp4', AI_TALK, 900, 'testsrc2=s=1280x720:r=30');
  // the real fox clip and its clean plate (Marat's footage, where SAM 2 is unsure of a loose box) when PHOTOS has them, else the stand-in
  const real = ['fox-walk.mp4', 'talk-with-music.mp4'].map(f => process.env.PHOTOS && path.join(process.env.PHOTOS, f));
  if (names.includes('fox')) { const f = real.every(x => x && fs.existsSync(x)) ? { walk: real[0], plate: real[1] } : foxFiles(); files.fox = f.walk; files.plate = f.plate; }
  if (names.includes('drive')) AI_DRIVE.forEach((lines, i) => { files[`drive${i}`] = aiSpeechMedia(`night-drive-${i + 1}-v1.mp4`, lines, 2500, 'testsrc2=s=640x360:r=30'); });
  let lib = await api('/api/media');
  const out = {};
  for (const [key, file] of Object.entries(files)) {
    out[key] = file && (lib.find(m => m.name === path.basename(file)) || await api('/api/import_path', { path: file }));
  }
  const ids = Object.values(out).filter(Boolean).map(m => m.id);
  for (const until = Date.now() + 300000; ;) {
    lib = await api('/api/media');
    if (ids.every(id => lib.find(m => m.id === id)?.ready)) break;
    const bad = lib.find(m => ids.includes(m.id) && m.error);
    if (bad || Date.now() > until) throw new Error(`fixture preparation failed: ${bad?.error || 'not ready in 300 s'}`);
    await pause(250);
  }
  for (const k of Object.keys(out)) if (out[k]) out[k] = lib.find(m => m.id === out[k].id);
  const res = { podcast: out.podcast, fox: out.fox, plate: out.plate, realFox: !!files.fox && files.fox === real[0] };
  if (names.includes('drive')) {
    res.drive = [0, 1, 2].map(i => out[`drive${i}`]);
    if (res.drive.every(Boolean) && res.podcast) {
      const projects = await api('/api/projects'), find = n => projects.find(p => p.name === n)?.id;
      res.driveProject = find('Midnight Highway Journey');
      res.demoProject = find('Cutroom demo (fixture)');
      if (!res.driveProject || !res.demoProject) {
        const { browser } = await import('./browser.mjs');
        const b = await browser.launch();
        try {
          const page = await b.newPage({ viewport: { width: 1517, height: 904 } });
          await page.goto(baseUrl + '/', { waitUntil: 'load' });
          await page.waitForFunction(() => typeof REMOTE !== 'undefined' && typeof P !== 'undefined' && P, null, { timeout: 30000 });
          await page.evaluate(() => loadMedia());
          const make = (name, clips) => page.evaluate(async ([name, clips]) => {
            await REMOTE.new_project({ name, ratio: '16:9', branded: false });
            await REMOTE.set_project({ set: { fps: 30 } });
            for (const c of clips) await REMOTE.add_clip(c);
            await flushSave();
            return P.id;
          }, [name, clips]);
          // a short span of each long take, as an edit of a night drive would: whisper should hear these (+1 s), not the whole takes
          res.driveProject ||= await make('Midnight Highway Journey', res.drive.map((m, i) => ({ media: m.id, in: 2 + 3 * i, out: 12 + 3 * i })));
          res.demoProject ||= await make('Cutroom demo (fixture)', [{ media: res.podcast.id, in: 0, out: Math.min(30, res.podcast.duration) }]);
        } finally { await b.close(); }
      }
    }
  }
  return res;
}

// Media a test expects under its own file names (the library shows a file's name): made once with ffmpeg into
// out/fixtures/named-<hash of name and args>/<name> (so two tests can't share a name with different contents), imported
// through the API and waited on until ready. specs: { 'talk.mp4': [ffmpeg input/output args], ... } -> { name: media item }.
export async function importNamedMedia(baseUrl, specs, { timeout = 180000 } = {}) {
  requireHome();
  if (!baseUrl || new URL(baseUrl).port === '4610') throw new Error('fixtures require a scratch server URL (never port 4610)');
  const call = async (route, body) => {
    const r = await fetch(baseUrl + route, { headers: { 'X-Cutroom': '1', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`fixture ${route}: ${j.error || r.status}`);
    return j;
  };
  const ids = {};
  for (const [name, args] of Object.entries(specs)) {
    if (path.basename(name) !== name) throw new Error('fixture name must be a filename');
    const dir = path.join(fixtureDir, `named-${createHash('sha256').update(JSON.stringify([name, args])).digest('hex').slice(0, 12)}`), file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      const partial = path.join(dir, `.${process.pid}.partial${path.extname(name)}`);
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, partial], { timeout: 600000, maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.renameSync(partial, file);
      } finally { fs.rmSync(partial, { force: true }); }
    }
    ids[name] = (await call('/api/import_path', { path: file })).id;
  }
  for (const until = Date.now() + timeout; ;) {
    const items = await call('/api/media').catch(() => []); // a media JSON can be briefly unreadable while preparation writes it
    const mine = Object.values(ids).map(id => items.find(m => m.id === id));
    if (mine.every(m => m?.ready)) return Object.fromEntries(Object.keys(ids).map((n, i) => [n, mine[i]]));
    const failed = mine.find(m => m?.error);
    if (failed || Date.now() > until) throw new Error(`fixture preparation failed: ${failed?.error || 'timed out'}`);
    await pause(250);
  }
}

// ---- speech clips and a rotated HLG source (audio_tools, audio_packs, export_hdr_alpha) ----
// A "talk" clip: OS speech (makeSpeech) placed at `lead` s over an optional lavfi sound bed (music, noise), padded to `dur`
// s, with a test-pattern picture unless `video: false`. Returns { file, speech: [[start, end], ...] }: where the voice is,
// from the clean speech (silencedetect), the ground truth a VAD would be judged by; null when the OS has no speech service.
export function speechClip(name, text, { lead = 0.5, dur, bed = '', video = true, voice } = {}) {
  const key = createHash('sha256').update(JSON.stringify([process.platform, text, lead, dur, bed, video, ...(voice ? [voice] : [])])).digest('hex').slice(0, 12);
  fs.mkdirSync(fixtureDir, { recursive: true });
  const wav = path.join(fixtureDir, `speech-src-${key}.${process.pid}.wav`);
  if (!makeSpeech(wav, text, { voice })) return null;
  try {
    const sil = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 }).stderr;
    const len = +probe(wav).format.duration, speech = [];
    const st = [...sil.matchAll(/silence_start: (-?[\d.]+)/g)].map(m => Math.max(0, +m[1])), en = [...sil.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
    let t = 0;
    st.forEach((a, i) => { if (a > t + 0.05) speech.push([t, a]); t = en[i] ?? len; });
    if (len > t + 0.05) speech.push([t, len]);
    const total = dur ?? Math.ceil(lead + len + 1), ms = Math.round(lead * 1000);
    const graph = `[${video ? 1 : 0}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms},apad[s]` + (bed ? `;[${video ? 2 : 1}:a]aformat=sample_rates=48000:channel_layouts=stereo[b];[s][b]amix=inputs=2:normalize=0:duration=first[a]` : ';[s]anull[a]');
    const file = cachedMedia(`${path.basename(name, path.extname(name))}-${key}${path.extname(name)}`, [
      ...(video ? ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${total}`] : []), '-i', wav, ...(bed ? ['-f', 'lavfi', '-i', bed] : []),
      '-filter_complex', graph, '-map', '[a]', ...(video ? ['-map', '0:v', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : []),
      ...(path.extname(name) === '.wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']), '-t', String(total), '-movflags', '+faststart']);
    return { file, speech: speech.map(([a, b]) => [+(a + lead).toFixed(3), +(b + lead).toFixed(3)]).filter(([a]) => a < total) };
  } finally { fs.rmSync(wav, { force: true }); }
}

// The synthetic HLG phone source (ensurePhoneFixture) as an iPhone holds it: portrait by a 90-degree display rotation,
// stream-copied (no re-encode). null when this ffmpeg can't make the HEVC source.
export function ensureRotatedPhoneFixture() {
  const src = ensurePhoneFixture();
  if (!src) return null;
  try {
    const file = cachedMedia(`phone-hlg-4k60-rot90-${path.basename(src, path.extname(src))}.mov`, ['-display_rotation:v:0', '90', '-i', src, '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart']);
    const v = probe(file).streams.find(s => s.codec_type === 'video');
    if ((v.side_data_list || []).some(d => Math.abs(d.rotation) === 90)) return file;
    console.log('SKIP rotated HLG source: this ffmpeg wrote no display rotation');
  } catch (e) { console.log(`SKIP rotated HLG source: ${summary(e)}`); }
  return null;
}
