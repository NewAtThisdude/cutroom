// The one-line installer on this Mac, end to end: `cutroom check` names this computer and picks the AI pack each kind of
// computer gets (simulated ones too), then install.sh is piped into sh from a local web server serving a tarball of this
// working tree, into a scratch prefix and library (no AI pack, no app: CUTROOM_AI=none, CUTROOM_APP=none). It checks the
// pinned source (a wrong SHA-256 is refused, a missing CUTROOM_SRC explained), that a second run keeps the AI pack's venv, and
// that the installed copy's ./cutroom check answers; and that the AI packs install only hash-locked packages. No Cutroom
// server needed; PORT is the web server's (default 4853):
//   [PORT=4853] node tests/installer.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..'), fails = [];
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${String(got).slice(-600)}`}`); if (!ok) fails.push(name); };
const env = { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };  // no PYTHONPATH, no uv on PATH
const checkOut = (extra) => spawnSync('python3', ['-I', join(repo, 'server.py'), '--check'], { env: { ...env, PATH: `/opt/homebrew/bin:${env.PATH}`, ...extra }, encoding: 'utf8' });

// 1. cutroom check, here and as other computers
const here = checkOut({});
check('check names this computer in plain words', here.status === 0 && /System {4}macOS .+ GB of memory/.test(here.stdout) && /Video {5}encodes on/.test(here.stdout), here.stdout + here.stderr);
check('an Apple Silicon Mac gets the MLX pack', /^pack: mlx$/m.test(here.stdout) && here.stdout.includes('AI pack: ai/setup.sh'), here.stdout);
for (const [sim, pack, why] of [['win:cuda:24:64', 'cuda', 'the CUDA pack'], ['win:cuda:4:16', 'cpu', 'under the 6 GB'], ['win:cpu:16', 'cpu', 'no NVIDIA GPU'],
                                ['win:cpu:4', 'none', 'too little for AI'], ['mac:8', 'mlx', 'without the image model']]) {
  const r = checkOut({ CUTROOM_PROFILE: sim });
  check(`${sim}: the ${pack} pack, with the reason`, r.status === 0 && r.stdout.includes(`\npack: ${pack}\n`) && r.stdout.includes(why), r.stdout + r.stderr);
}
const cpu = checkOut({ CUTROOM_PROFILE: 'win:cpu:16' }).stdout;
check('a CPU PC: Kokoro voices run, the Mac-only tools say why', cpu.includes('AI voiceover: Kokoro-82M (PyTorch, CPU)') && cpu.includes('Remove background: no, needs Apple Silicon'), cpu);
check('CUTROOM_AI overrides the pick', checkOut({ CUTROOM_AI: 'none' }).stdout.includes('chosen with CUTROOM_AI=none\n'), '');
// every package the AI packs install comes from a lock with each file's hash (the MLX pack too, ai/mac.lock)
const pipLines = ['setup.sh', 'setup.ps1'].flatMap((f) => readFileSync(join(repo, 'ai', f), 'utf8').split('\n').filter((l) => /uv\b.*\bpip install/.test(l)));
const lockReqs = ['mac.lock', 'win-cuda.lock', 'win-cpu.lock'].flatMap((f) => readFileSync(join(repo, 'ai', f), 'utf8').split(/\n(?=\S)/).filter((b) => !b.startsWith('#')));
check('the AI packs install only hash-locked packages', pipLines.length >= 2 && pipLines.every((l) => l.includes('--require-hashes'))
  && lockReqs.length > 100 && lockReqs.every((b) => b.includes('--hash=sha256:')), pipLines.join('\n'));

// 2. install.sh piped from a local web server: a tarball of this working tree (tracked files, as they are now)
const out = join(repo, 'tests', 'out', 'installer');
mkdirSync(out, { recursive: true });
const t = mkdtempSync(join(out, 'run-'));
const stash = execFileSync('git', ['stash', 'create'], { cwd: repo, encoding: 'utf8' }).trim() || 'HEAD';
execFileSync('git', ['archive', '--format=tar.gz', '--prefix=cutroom-test/', '-o', join(t, 'cutroom.tar.gz'), stash], { cwd: repo });
const files = { '/install.sh': readFileSync(join(repo, 'install.sh')), '/cutroom.tar.gz': readFileSync(join(t, 'cutroom.tar.gz')) };
const sha = createHash('sha256').update(files['/cutroom.tar.gz']).digest('hex');
const port = Number(process.env.PORT || 4853), base = `http://127.0.0.1:${port}`;
const web = createServer((q, s) => files[q.url] ? s.end(files[q.url]) : (s.statusCode = 404, s.end())).listen(port, '127.0.0.1');
await new Promise(r => web.once('listening', r));
try {
  const none = await pipe({});
  check('without CUTROOM_SRC it says the source is not published yet', none.code !== 0 && none.all.includes('not published yet'), none.all);
  const bad = await pipe({ CUTROOM_SRC: `${base}/cutroom.tar.gz`, CUTROOM_SRC_SHA256: '0'.repeat(64) });
  check('a source that does not match its SHA-256 is refused', bad.code !== 0 && bad.all.includes('Checksum mismatch') && !existsSync(join(t, 'prefix', 'src')), bad.all);
  const ok = await pipe({ CUTROOM_SRC: `${base}/cutroom.tar.gz`, CUTROOM_SRC_SHA256: sha });
  const src = join(t, 'prefix', 'src');
  check('the piped install finishes', ok.code === 0 && ok.all.includes('No app (CUTROOM_APP=none)'), ok.all);
  check('it unpacked the source into the prefix', existsSync(join(src, 'server.py')) && existsSync(join(src, 'cutroom')), src);
  check('it printed the check and the AI decision', ok.all.includes('Cutroom check: this computer') && ok.all.includes('AI        no pack: chosen with CUTROOM_AI=none'), ok.all);
  check('the speech detector is in the library, checked', existsSync(join(t, 'lib', 'models', 'ggml-silero-v5.1.2.bin')), '');
  check('uv came from its pinned download into the prefix', existsSync(join(t, 'prefix', 'bin', 'uv')), ok.all);
  mkdirSync(join(src, 'ai', '.venv'), { recursive: true });
  writeFileSync(join(src, 'ai', '.venv', 'kept'), '');
  const again = await pipe({ CUTROOM_SRC: `${base}/cutroom.tar.gz`, CUTROOM_SRC_SHA256: sha });
  check('a second run updates the source and keeps the AI pack', again.code === 0 && existsSync(join(src, 'ai', '.venv', 'kept')) && !again.all.includes('Downloading uv'), again.all);
  const cc = spawnSync(join(src, 'cutroom'), ['check'], { env: { ...env, CUTROOM_HOME: join(t, 'lib') }, encoding: 'utf8' });
  check('the installed ./cutroom check answers', cc.status === 0 && /^pack: mlx$/m.test(cc.stdout), cc.stdout + cc.stderr);
} finally {
  web.close();
}
console.log(fails.length ? `${fails.length} FAILED` : 'installer: all ok');
process.exit(fails.length ? 1 : 0);

function pipe(extra) {  // curl -fsSL <url>/install.sh | sh in a clean environment (spawn: the web server shares this event loop)
  return new Promise(r => {
    const p = spawn('sh', ['-c', `curl -fsSL ${base}/install.sh | sh`], { env: { ...env, CUTROOM_PREFIX: join(t, 'prefix'), CUTROOM_HOME: join(t, 'lib'),
      CUTROOM_AI: 'none', CUTROOM_APP: 'none', ...extra }, cwd: t });
    let all = '';
    p.stdout.on('data', d => { all += d; });
    p.stderr.on('data', d => { all += d; });
    p.on('close', code => r({ code, all }));
  });
}
