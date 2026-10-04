// The executor primitives. `execute` and `defaultCodexExe` are imported from
// their owners, never copied: a fix there reaches the conductor too.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { execute } from '../../../../scripts/lane.mjs';
import { defaultCodexExe } from '../../../slim-review/scripts/pr-review.mjs';

export { execute };

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
