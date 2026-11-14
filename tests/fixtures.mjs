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

// ---- speech clips and a rotated HLG source (audio_tools, audio_packs, export_hdr_alpha) ----
// A "talk" clip: OS speech (makeSpeech) placed at `lead` s over an optional lavfi sound bed (music, noise), padded to `dur`
// s, with a test-pattern picture unless `video: false`. Returns { file, speech: [[start, end], ...] }: where the voice is,
// from the clean speech (silencedetect), the ground truth a VAD would be judged by; null when the OS has no speech service.
export function speechClip(name, text, { lead = 0.5, dur, bed = '', video = true } = {}) {
  const key = createHash('sha256').update(JSON.stringify([process.platform, text, lead, dur, bed, video])).digest('hex').slice(0, 12);
  fs.mkdirSync(fixtureDir, { recursive: true });
  const wav = path.join(fixtureDir, `speech-src-${key}.${process.pid}.wav`);
  if (!makeSpeech(wav, text)) return null;
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
