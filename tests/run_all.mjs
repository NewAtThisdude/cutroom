// Serial release gate. Every test gets a new server and library; all files stay in tests/out/.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.dirname(HERE);
const WIN = process.platform === 'win32', PYTHON = WIN ? 'python' : 'python3';
const DEFAULT_TESTS = [
  'ui_smoke', 'ui_audit', 'tour', 'platforms', 'history', 'curves', 'scopes', 'jlcuts', 'meter',
  'versions', 'labels_keys', 'export_light', 'export_formats', 'layer_parity', 'package',
  'this_computer', 'fade_handles', 'features_e2e', 'interchange', 'timeline_pro', 'video_parity', 'audio_e2e',
  'settings', 'templates', 'brand', 'batch', 'fx_share', 'recovery', 'broll', 'installer', 'av_sync', 'attrs_compare', 'quick_tools', 'mask_grade',
  'layouts_viz',
];
const AI_TESTS = ['ai_worker', 'ai_enhance', 'captions_pro', 'tracking', 'retouch', 'voice_dub', 'zoom3d'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const options = { ai: false, ports: process.env.CUTROOM_TEST_PORTS || '4810-4819', timeout: 1200, tests: null, list: false };

function usage() {
  console.log(`Usage: node tests/run_all.mjs [--ports 4810-4819] [--tests ui_smoke,package] [--timeout 1200] [--ai] [--list]

Runs the 26 release tests serially, with export_formats in quick mode.
--ports     Inclusive scratch-server port range (at least two ports; never 4610).
--tests     Comma-separated test names, optionally with .mjs; defaults to the release list.
--timeout   Per-test timeout in seconds, excluding server startup and fixture seeding.
--ai        Permit AI model tests and append them to the default list. Off by default.
--list      Print selected tests without starting anything.
CUTROOM_TEST_AI_OFF=llm (comma list of AI kinds) starts each fresh library with those AI jobs off.
CUTROOM_TEST_PHOTOS=<dir> (or PHOTOS) clones that folder's real clips into every test's scratch photos folder
(ai_enhance, retouch, hdr_iphone, export_hdr_alpha, the real fox in ai_worker); without it those parts SKIP.

Install dependencies first: npm ci --prefix tests
macOS: npx --prefix tests playwright install webkit
Windows: install Edge, then set BROWSER=msedge (the Windows default).
Logs, fresh libraries, and JSON/Markdown summaries are retained under tests/out/runs/.`);
}

function canonical(file) {
  const full = path.resolve(file);
  if (fs.existsSync(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canonical(parent), path.basename(full));
}

function safeHome(home) {
  if (!home) throw new Error('CUTROOM_HOME is required for a test server');
  const norm = p => canonical(p).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const candidate = norm(home), protectedHome = norm(path.join(os.homedir(), 'Movies', 'Cutroom'));
  if (candidate === protectedHome || candidate.startsWith(`${protectedHome}/`)) {
    throw new Error('Refusing CUTROOM_HOME in the personal Movies/Cutroom library');
  }
  return path.resolve(home);
}

try {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (arg === '--ai') options.ai = true;
    else if (arg === '--list') options.list = true;
    else if (['--ports', '--tests', '--timeout'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = arg === '--timeout' ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
  const match = /^(\d+)-(\d+)$/.exec(options.ports);
  if (!match) throw new Error('--ports must be an inclusive range such as 4810-4819');
  const [first, last] = match.slice(1).map(Number);
  if (first < 1024 || last > 65535 || first >= last) throw new Error('--ports requires at least two ports between 1024 and 65535');
  if (first <= 4610 && last >= 4610) throw new Error('Port 4610 is forbidden');
  if (process.platform === 'darwin' && (first < 4810 || last > 4819)) throw new Error('macOS release tests may use only ports 4810-4819');
  options.portNumbers = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  options.selected = options.tests ? options.tests.split(',').map(s => s.trim().replace(/\.mjs$/, '')) : [...DEFAULT_TESTS, ...(options.ai ? AI_TESTS : [])];
  for (const name of options.selected) {
    if (![...DEFAULT_TESTS, ...AI_TESTS].includes(name)) throw new Error(`Unknown release-gate test: ${name}; see --list`);
    if (AI_TESTS.includes(name) && !options.ai) throw new Error(`${name} can load AI models; explicitly pass --ai`);
  }
  options.selected = [...new Set(options.selected)];
  if (!options.selected.length) throw new Error('No tests selected');
  if (process.env.CUTROOM_HOME) safeHome(process.env.CUTROOM_HOME);
} catch (error) {
  console.error(`FAIL runner configuration: ${error.message}`);
  process.exit(1);
}

if (options.list) {
  for (const test of options.selected) console.log(`${test}${test === 'export_formats' ? ' quick' : ''}`);
  process.exit(0);
}

// This machine shares its GPU with other worktrees. Fresh Macs use a portable temp lock.
// The marker is inherited only by the lock holder and lets callers apply the same lock externally.
if (process.platform === 'darwin' && !process.env.CUTROOM_GPU_LOCK_HELD) {
  const shared = '/private/tmp/claude-501/-Users-marat/827eb4bf-5aee-4497-950b-e90b10220711/scratchpad/gpu.lock';
  const lock = process.env.CUTROOM_GPU_LOCK || (fs.existsSync(path.dirname(shared)) ? shared : path.join(os.tmpdir(), 'cutroom-gpu.lock'));
  // Two lanes (Marat, 2026-11-14): two runs may share this Mac at once; each takes whichever lock is free.
  const lanes = [lock, lock]; // one lane: two at once overheated the Mac (2026-11-14)
  console.log(`Waiting for a shared GPU lane: ${lanes.join(' or ')}`);
  let locked = null;
  process.on('SIGINT', () => locked?.kill('SIGINT'));
  process.on('SIGTERM', () => locked?.kill('SIGTERM'));
  for (let i = 0; ; i++) {
    locked = spawn('lockf', ['-t', '0', '-k', lanes[i % 2], process.execPath, fileURLToPath(import.meta.url), ...args], {
      cwd: ROOT, env: { ...process.env, CUTROOM_GPU_LOCK_HELD: '1' }, stdio: ['inherit', 'inherit', 'pipe'],
    });
    locked.stderr.on('data', d => { if (!/already locked/.test(d)) process.stderr.write(d); });
    const r = await new Promise(resolve => { locked.once('error', error => resolve({ error })); locked.once('close', (code, signal) => resolve({ code, signal })); });
    if (r.error) { console.error(`FAIL GPU lock: ${r.error.message}`); process.exit(1); }
    if (r.code !== 75) process.exit(r.code ?? (r.signal ? 130 : 1)); // 75 = that lane is busy (lockf -t 0)
    if (i % 2) await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

// A Windows Job Object owns the complete process tree, including browser processes and
// package's secondary server. Closing its handle kills even children orphaned by process.exit().
const WINDOWS_JOB = String.raw`
import ctypes, subprocess, sys
from ctypes import wintypes as w
k = ctypes.WinDLL('kernel32', use_last_error=True)
class Basic(ctypes.Structure):
    _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64), ('Flags', w.DWORD), ('MinWorkingSet', ctypes.c_size_t), ('MaxWorkingSet', ctypes.c_size_t), ('ActiveProcessLimit', w.DWORD), ('Affinity', ctypes.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]
class IO(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ['ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes']]
class Extended(ctypes.Structure):
    _fields_ = [('Basic', Basic), ('IO', IO), ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemory', ctypes.c_size_t), ('PeakJobMemory', ctypes.c_size_t)]
k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
k.CreateJobObjectW.restype = w.HANDLE
k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
k.GetCurrentProcess.restype = w.HANDLE
job = k.CreateJobObjectW(None, None)
info = Extended(); info.Basic.Flags = 0x2000
if not job or not k.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) or not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
    raise ctypes.WinError(ctypes.get_last_error())
sys.exit(subprocess.call(sys.argv[1:]))
`;

const active = new Set();
let interrupted = false;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = path.join(HERE, 'out', 'runs', `${stamp}-${process.pid}`);
safeHome(runRoot);
fs.mkdirSync(runRoot, { recursive: true });
const results = [];

function start(command, commandArgs, env, logFile, echo = false) {
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const child = WIN ? spawn(PYTHON, ['-X', 'utf8', '-I', '-c', WINDOWS_JOB, command, ...commandArgs], { cwd: ROOT, env, windowsHide: true })
    : spawn(command, commandArgs, { cwd: ROOT, env, detached: true });
  const record = { child, output: '', log, finished: false };
  active.add(record);
  const write = data => { const s = data.toString(); record.output += s; log.write(s); if (echo) process.stdout.write(s); };
  child.stdout.on('data', write); child.stderr.on('data', write);
  record.done = new Promise(resolve => {
    child.once('error', error => { write(`FAIL starting ${command}: ${error.message}\n`); record.error = error; });
    child.once('close', (code, signal) => { record.finished = true; record.code = code; record.signal = signal; log.end(); resolve(record); });
  });
  return record;
}

async function stop(record) {
  if (!record || record.stopped) return;
  record.stopped = true;
  const pid = record.child.pid;
  if (pid) {
    if (WIN) {
      if (!record.finished) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(`Cleanup: ${error.message}`); }
      await Promise.race([record.done, sleep(2000)]);
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(`Cleanup: ${error.message}`); }
    }
  }
  await Promise.race([record.done, sleep(3000)]);
  active.delete(record);
}

async function shutdown() {
  interrupted = true;
  await Promise.all([...active].reverse().map(stop));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown().finally(() => process.exit(130)); });

async function availablePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function choosePorts(count) {
  const free = [];
  for (const port of options.portNumbers) if (await availablePort(port)) { free.push(port); if (free.length === count) return free; }
  throw new Error(`Need ${count} free scratch ports in ${options.ports}; no other listeners will be stopped`);
}

function environment(home, scratch, port) {
  const env = { ...process.env };
  for (const key of ['PYTHONPATH', 'B', 'B2', 'LOW_B', 'P2', 'SERVER_PID', 'PHOTOS', 'PHONE', 'CUTROOM_PROFILE', 'CUTROOM_RAM_GB', 'CUTROOM_PORT', 'CUTROOM_HOME', 'CUTROOM_SCRATCH', 'CUTROOM_TEST_AI', 'CUTROOM_TEST_RUNNER_PARENT']) delete env[key];
  Object.assign(env, {
    CUTROOM_HOME: safeHome(home), CUTROOM_SCRATCH: scratch, CUTROOM_PORT: String(port),
    B: `http://127.0.0.1:${port}`, BROWSER: process.env.BROWSER || (WIN ? 'msedge' : 'webkit'),
    CUTROOM_VERSION_GAP: '2', CUTROOM_BEATS_STDLIB: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
    PHOTOS: path.join(scratch, 'photos'), CUTROOM_PROCESS_REGISTRY: path.join(scratch, 'processes.txt'),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  });
  if (options.ai) env.CUTROOM_TEST_AI = '1';
  else { env.CUTROOM_MODEL = path.join(home, 'models', 'not-installed.bin'); env.CUTROOM_VAD = path.join(home, 'models', 'not-installed-vad.bin'); }
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(env.PHOTOS, { recursive: true });
  // CUTROOM_TEST_PHOTOS (else the caller's PHOTOS): a folder of real reference clips (iPhone MOVs, fox-walk.mp4, talk-with-music.mp4).
  // Its files are cloned into the test's scratch photos (copy-on-write on APFS; a plain copy elsewhere), so suites that need real
  // footage run instead of SKIPping, and never touch the originals. ponytail: a full copy per test on Windows; link if that gets slow
  const real = process.env.CUTROOM_TEST_PHOTOS || process.env.PHOTOS;
  if (real && fs.existsSync(real)) for (const f of fs.readdirSync(real, { withFileTypes: true })) {
    const dst = path.join(env.PHOTOS, f.name);
    if (f.isFile() && !fs.existsSync(dst)) fs.copyFileSync(path.join(real, f.name), dst, fs.constants.COPYFILE_FICLONE);
  }
  // CUTROOM_TEST_AI_OFF=llm,...: those AI_BUDGET kinds start switched off in each fresh library (Settings > AI), so a run never loads
  // a model into a shared service, e.g. an Ollama another job is using; the checks that need them fail and say why
  if (process.env.CUTROOM_TEST_AI_OFF) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(Object.fromEntries(process.env.CUTROOM_TEST_AI_OFF.split(',').map(k => [`ai.${k.trim()}`, false]))));
  return env;
}

async function server(env, logFile) {
  const record = start(PYTHON, ['-X', 'utf8', '-I', path.join(ROOT, 'server.py')], env, logFile);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (record.finished || record.error) throw new Error(`Server did not start: ${record.output.trim().slice(-2000)}`);
    try {
      const response = await fetch(`${env.B}/api/ping`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).ok) {
        await sleep(250);
        if (record.finished) throw new Error('Server exited after another listener answered');
        return record;
      }
    } catch { /* startup probe; bounded by the deadline */ }
    await sleep(200);
  }
  throw new Error(`Server did not answer ${env.B}/api/ping in 60 seconds; see ${logFile}`);
}

async function seed(env, logFile, phone = false) {
  // Seeding owns a browser too, so give it the same process-tree cleanup as every test.
  const marker = `CUTROOM_FIXTURE_RESULT_${process.pid}:`;
  const code = `import { seedLibrary } from ${JSON.stringify(new URL('./fixtures.mjs', import.meta.url).href)};
    try {
      const fixtures = await seedLibrary({baseUrl: process.env.B, home: process.env.CUTROOM_HOME, scratch: process.env.CUTROOM_SCRATCH, phone: ${JSON.stringify(phone)}});
      console.log(${JSON.stringify(marker)} + JSON.stringify({phonePath: fixtures.phonePath || null}));
    } catch (error) { console.error('FAIL fixtures: ' + (error.stack || error)); process.exitCode = 1; }`;
  const record = start(process.execPath, ['--input-type=module', '-e', code], env, logFile);
  let timer;
  try {
    await Promise.race([record.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture seeding timed out after 300 seconds')), 300000);
    })]);
    for (const line of checkLines(record.output, /^SKIP\b/)) console.log(line);
    if (record.code !== 0) {
      const detail = checkLines(record.output, /^FAIL fixtures:/)[0] || `exit ${record.code ?? record.signal}`;
      throw new Error(`Fixture seeding failed: ${detail}; see ${logFile}`);
    }
    const line = record.output.split(/\r?\n/).find(value => value.startsWith(marker));
    if (!line) throw new Error(`Fixture seeding returned no result; see ${logFile}`);
    return JSON.parse(line.slice(marker.length));
  } finally { clearTimeout(timer); await stop(record); }
}

function checkLines(output, pattern) { return [...new Set(output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(s => s.trim()).filter(s => pattern.test(s)))]; }

function summaries() {
  const rows = ['| Test | Result | Seconds | Checks / reason |', '| --- | --- | ---: | --- |'];
  for (const result of results) {
    const detail = result.failures.length ? result.failures.join('<br>') : [result.checkSummary, result.skips.length ? `${result.skips.length} optional skip(s)` : ''].filter(Boolean).join('; ');
    rows.push(`| ${result.test} | ${result.status} | ${result.seconds.toFixed(1)} | ${(detail || '').replace(/\r?\n/g, '<br>').replaceAll('|', '\\|')} |`);
  }
  const table = rows.join('\n');
  let markdown = `${table}\n`;
  for (const result of results) if (result.skips.length) markdown += `\n${result.test}:\n${result.skips.map(line => `- ${line}`).join('\n')}\n`;
  if (!options.ai) markdown += '\nSKIP AI model suites: excluded by default; pass --ai to opt in.\n';
  fs.writeFileSync(path.join(runRoot, 'summary.md'), markdown);
  fs.writeFileSync(path.join(runRoot, 'summary.json'), JSON.stringify({ started: stamp, platform: process.platform, browser: process.env.BROWSER || (WIN ? 'msedge' : 'webkit'), ports: options.ports, ai: options.ai, results }, null, 2));
  return markdown;
}

console.log(`Release gate: ${options.selected.length} tests, ${process.env.BROWSER || (WIN ? 'msedge' : 'webkit')}, ports ${options.ports}`);
console.log(`Run artifacts: ${runRoot}`);
try {
  for (const name of options.selected) {
    if (interrupted) break;
    const began = Date.now(), dir = path.join(runRoot, name), scratch = path.join(dir, 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const result = { test: `${name}${name === 'export_formats' ? ' quick' : ''}`, status: 'FAIL', seconds: 0, failures: [], skips: [], checkSummary: '', log: path.join(dir, 'test.log') };
    console.log(`\n=== ${result.test} ===`);
    let test;
    const seedLog = path.join(dir, 'fixtures.log');
    try {
      const ports = await choosePorts(['tour', 'package', 'voice_dub', 'recovery'].includes(name) ? 2 : 1);
      const env = environment(path.join(dir, 'library'), scratch, ports[0]);
      const srv = await server(env, path.join(dir, 'server.log'));
      env.SERVER_PID = String(srv.child.pid);
      if (name === 'tour') {
        const other = environment(path.join(dir, 'library-with-media'), scratch, ports[1]);
        await server(other, path.join(dir, 'server-with-media.log'));
        await seed(other, seedLog);
        env.B2 = other.B;
      } else {
        const fixtures = await seed(env, seedLog, name === 'export_formats');
        if (name === 'export_formats' && fixtures.phonePath) env.PHONE = fixtures.phonePath;
      }
      if (['package', 'voice_dub', 'recovery'].includes(name)) env.P2 = String(ports[1]);
      test = start(process.execPath, [path.join(HERE, `${name}.mjs`), ...(name === 'export_formats' ? ['quick'] : [])], env, result.log, true);
      let timer;
      try {
        await Promise.race([test.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Test timed out after ${options.timeout} seconds`)), options.timeout * 1000); })]);
      } finally { clearTimeout(timer); }
      result.failures = checkLines(test.output, /^(?:FAIL\b|FIX\b)/);
      result.skips = checkLines(test.output, /^SKIP\b/);
      result.checkSummary = checkLines(test.output, /^(?:\d+\/\d+\s+(?:passed|checks)|\d+ problems\b|all (?:ok|passed)\b)/).at(-1) || '';
      if (test.code !== 0) result.failures.push(`Test exited ${test.code ?? `on ${test.signal || 'startup error'}`}`);
      const passed = checkLines(test.output, /^(?:PASS\b|ok\s)/).length;
      result.status = result.failures.length ? 'FAIL' : result.skips.length && !passed && !result.checkSummary ? 'SKIP' : 'PASS';
    } catch (error) {
      if (test) {
        result.failures.push(...checkLines(test.output, /^(?:FAIL\b|FIX\b)/));
        result.skips.push(...checkLines(test.output, /^SKIP\b/));
      }
      result.failures.push(`FAIL harness: ${String(error.message).split(/\r?\n/, 1)[0]}`);
      console.error(result.failures.at(-1));
      fs.appendFileSync(result.log, `${error.stack || error}\n`);
    } finally {
      // Tests close browsers on SIGTERM; allow that before the server's group is stopped.
      if (test) await stop(test);
      for (const record of [...active].reverse()) await stop(record);
      if (fs.existsSync(seedLog)) result.skips = [...new Set([...result.skips, ...checkLines(fs.readFileSync(seedLog, 'utf8'), /^SKIP\b/)])];
      result.seconds = (Date.now() - began) / 1000;
      results.push(result);
      summaries();
    }
    console.log(`=== ${result.status} ${result.test} (${result.seconds.toFixed(1)}s) ===`);
  }
} finally {
  await shutdown();
}
console.log(`\n${summaries()}`);
console.log(`Logs and libraries: ${runRoot}`);
process.exitCode = results.some(result => result.status === 'FAIL') || results.length !== options.selected.length ? 1 : 0;
