// The executor primitives. `execute` and `defaultCodexExe` are imported from
// their owners, never copied: a fix there reaches the conductor too.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
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

// A `shell` action's argv as drive runs it (only drive: the hand path runs
// `execute`): no shell, the action's env added, stdin closed. A spawn failure
// is exit 127, as a shell reports a missing program. A timeout kills the
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
      settle({ code: 127, stdout, stderr: `${error.message}\n${stderr}` });
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
