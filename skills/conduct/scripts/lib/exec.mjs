// The executor primitives. `execute` and `defaultCodexExe` are imported from
// their owners, never copied: a fix there reaches the conductor too.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execute } from '../../../../scripts/lane.mjs';
import { defaultCodexExe } from '../../../slim-review/scripts/pr-review.mjs';

export { execute, defaultCodexExe };

// The one process that outlives a verb: a lane agent, detached, logging to a file.
export function spawnDetached(program, args, { cwd, logPath, env } = {}) {
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    // A spawn failure (ENOENT) arrives as an event; without a listener it
    // would crash the verb after it has already reported the pid.
    child.on('error', () => {});
    child.unref();
    return { pid: child.pid ?? null };
  } finally {
    closeSync(fd);
  }
}

// Kills a process and everything it started. A gate command runs under
// cmd.exe /c or sh -c, and killing that root alone leaves its children
// running. win32: taskkill /T; POSIX: the root leads its own process group
// (runArgv spawns it detached), and the group is killed.
export function killProcessTree(pid, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone; the caller verifies the root.
  }
}

// win32: true when a command name reaches CreateProcess only as a .cmd or
// .bat file (npm, npx), which no shell-free spawn can start. A name with an
// extension is judged by it; a path is run as given. A bare name is looked
// up in cwd, then PATH, with each PATHEXT extension: a .exe or .com anywhere
// is what spawn finds and runs, so only a name with none of those is a shim.
export function windowsShim(name, { env = process.env, cwd = process.cwd(), exists = existsSync } = {}) {
  const ext = extname(name).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return true;
  if (ext || /[\\/]/.test(name)) return false;
  const lookup = (key) => env[Object.keys(env).find((k) => k.toUpperCase() === key) ?? key];
  const exts = (lookup('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const dirs = [cwd, ...(lookup('PATH') ?? '').split(';')].filter(Boolean);
  let shim = false;
  for (const dir of dirs) {
    for (const e of exts) {
      if (!exists(join(dir, `${name}${e}`))) continue;
      if (e === '.exe' || e === '.com') return false;
      if (e === '.cmd' || e === '.bat') shim = true;
    }
  }
  return shim;
}

// A `shell` action's argv as drive runs it (only drive: the hand path runs
// `execute`): no shell, the action's env added, stdin closed. A spawn failure
// is `spawnError` (its code) and no exit code: the program never ran, so
// there is no result to record. A timeout kills the
// process tree and waits up to killGraceMs for the root to exit: `timedOut`,
// with `killVerified` false when it did not. Its partial output is not a result.
export function runArgv(program, args, { cwd, env, timeout, platform = process.platform, killTree = killProcessTree, killGraceMs = 5000 } = {}) {
  return new Promise((done) => {
    const out = [], err = [];
    const text = () => ({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    let settled = false, exited = false, timedOut = false, timer = null, grace = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      done(value);
    };
    const failed = (error) => {
      const { stdout, stderr } = text();
      settle({ code: null, stdout, stderr: `${error.message}\n${stderr}`, spawnError: error.code ?? 'UNKNOWN' });
    };
    let child;
    try {
      child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32' });
    } catch (error) {
      failed(error);
      return;
    }
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => { if (child.pid === undefined) failed(error); });
    child.on('exit', () => {
      exited = true;
      if (timedOut) settle({ code: null, ...text(), timedOut: true, killVerified: true, pid: child.pid });
    });
    child.on('close', (code) => { if (!timedOut) settle({ code: code ?? 1, ...text() }); });
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid, { platform });
        if (exited) settle({ code: null, ...text(), timedOut: true, killVerified: true, pid: child.pid });
        else grace = setTimeout(() => settle({ code: null, ...text(), timedOut: true, killVerified: false, pid: child.pid }), killGraceMs);
      }, timeout);
    }
  });
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

// codex on win32 is an npm .cmd shim that execFileSync cannot run without a
// shell, so it resolves to the vendored codex.exe. The resolver's throw (codex
// absent) is the caller's to catch.
export function resolveProgram(name, { platform, resolveCodex = defaultCodexExe } = {}) {
  if (name === 'codex' && platform === 'win32') return resolveCodex({ platform });
  return name;
}

export function shellArgv(command, platform) {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
}
