// Shared process and path helpers for tests on macOS and Windows.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export function requireHome(value = process.env.CUTROOM_HOME) {
  if (!value?.trim()) throw new Error('CUTROOM_HOME is required: use a scratch library under tests/out/');
  const normalize = p => {
    const resolved = path.resolve(p.replace(/[\\/]/g, path.sep));
    let ancestor = resolved;
    const tail = [];
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
      tail.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    const real = path.join(realpathSync(ancestor), ...tail);
    // Default Mac and Windows volumes are case insensitive. Be conservative on Linux too.
    return real.toLowerCase().replace(/[\\/]+$/, '');
  };
  const home = normalize(value), personal = normalize(path.join(os.homedir(), 'Movies', 'Cutroom'));
  if (home === personal || home.startsWith(personal + path.sep)) throw new Error('CUTROOM_HOME must be a scratch library, outside the personal Movies library');
  return path.resolve(value.replace(/[\\/]/g, path.sep));
}

export function execNiceSync(command, args, options = {}, priority = 10) {
  return process.platform === 'win32'
    ? execFileSync(command, args, options)
    : execFileSync('nice', ['-n', String(priority), command, ...args], options);
}

const children = new Set();
function killChild(child, signal = 'SIGTERM') {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else child.kill(signal);
}
process.on('exit', () => { for (const child of children) killChild(child); });

export function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, options);
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', () => children.delete(child));
  if (child.pid && process.env.CUTROOM_PROCESS_REGISTRY) appendFileSync(process.env.CUTROOM_PROCESS_REGISTRY, `${child.pid}\n`);
  return child;
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  killChild(child);
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { killChild(child, 'SIGKILL'); resolve(); }, 5000); })]);
  clearTimeout(timer);
}
