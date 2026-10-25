#!/usr/bin/env node
// A claude lane's Stop hook: node stop-check.mjs --run <dir> --wp <id>, with the
// hook input on stdin. It runs `conduct.mjs lane stop-check` in process and
// prints {"decision":"block","reason":…} only when that verdict blocks the stop.
// It always exits 0 and prints nothing else: exit 2 would block the lane with a
// crash for its reason, and the lane cannot repair the conductor's script.
//
// The hook names the plugin root that was current when the lane started. When
// upgrade-root has since moved the run, this root's conduct.mjs refuses it with
// `moved: true`, so the hook hands the same argv and stdin to the stop-check.mjs
// under state.pluginRoot: one hop, marked in the child's env, never a second.
// The destination comes from state.json alone, never from an error's text. A
// check that cannot run writes verdict `failed` with the first line of why, so
// the conductor sees it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runConduct } from './conduct.mjs';

export const HOP_ENV = 'WORKIT_STOP_CHECK_HOP';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'unknown error';
const flagValue = (argv, name) => {
  const at = argv.indexOf(name);
  return at >= 0 && typeof argv[at + 1] === 'string' ? argv[at + 1] : null;
};

function decisionOf(stdout) {
  if (!stdout.trim()) return '';
  const out = JSON.parse(stdout);
  if (out?.decision !== 'block' || typeof out.reason !== 'string') throw new Error(`unexpected hook output: ${firstLine(stdout)}`);
  return JSON.stringify({ decision: 'block', reason: out.reason });
}

// The stop-check.mjs a moved run hops to: the one under state.pluginRoot, read
// here from <run>/state.json. The root must be absolute, not this root, and
// hold that script; anything else is no hop.
function movedScript(argv, here, platform) {
  const run = flagValue(argv, '--run');
  if (!run) throw new Error('the run moved, but the hook names no --run');
  const root = JSON.parse(readFileSync(join(resolve(run), 'state.json'), 'utf8'))?.pluginRoot;
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error(`the run moved, but state.pluginRoot ${JSON.stringify(root)} is not an absolute path`);
  const fold = (path) => (platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  if (fold(root) === fold(here)) throw new Error(`the run moved, but state.pluginRoot ${root} is this root`);
  const script = join(root, 'skills', 'conduct', 'scripts', 'stop-check.mjs');
  if (!existsSync(script)) throw new Error(`the run moved to ${root}, which has no ${script}`);
  return script;
}

// The new root's stop-check, as a process with the same argv and stdin.
function delegate(script, argv, input, env) {
  const child = spawnSync(process.execPath, [script, ...argv], { input, encoding: 'utf8', env: { ...env, [HOP_ENV]: '1' }, windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${script} exited ${child.status ?? child.signal}: ${firstLine(child.stderr)}`);
  return decisionOf(child.stdout ?? '');
}

// The mark a check that could not run leaves: lane-<wp>-stopcheck.json, verdict
// failed. Best effort: if this write fails too, nothing more is done.
function markFailed(argv, input, error, timestamp) {
  try {
    const run = flagValue(argv, '--run'), wpId = flagValue(argv, '--wp');
    if (!run || !wpId) return;
    const runDir = resolve(run);
    let sessionId = null, round;
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed?.session_id === 'string') sessionId = parsed.session_id;
    } catch { /* unreadable hook input */ }
    try {
      const wp = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).wps.find((candidate) => candidate.id === wpId);
      if (wp) round = wp.amendment?.n ?? 0;
    } catch { /* the state may be what failed */ }
    const record = { sessionId, ...(round === undefined ? {} : { round }), blocks: 0, at: timestamp(), verdict: 'failed', reason: firstLine(error?.message ?? error) };
    writeFileSync(join(runDir, `lane-${wpId.toLowerCase()}-stopcheck.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch { /* leave no other trace */ }
}

export async function stopCheck(argv, overrides = {}) {
  const env = overrides.env ?? process.env;
  const timestamp = overrides.timestamp ?? (() => new Date().toISOString());
  let input = '';
  try {
    input = (overrides.readStdin ?? (() => readFileSync(0, 'utf8')))();
  } catch { /* no hook input reads as {} */ }
  try {
    const result = await runConduct(['lane', 'stop-check', ...argv], { ...overrides, readStdin: () => input });
    if (result.code === 0) {
      const out = JSON.parse(result.stdout);
      return out?.block === true && typeof out.instruction === 'string' ? JSON.stringify({ decision: 'block', reason: out.instruction }) : '';
    }
    let error = result.stderr.replace(/^conduct: /, ''), moved = false;
    try {
      const out = JSON.parse(result.stdout);
      error = out?.error ?? error;
      moved = out?.moved === true;
    } catch { /* stderr names it */ }
    if (moved && env[HOP_ENV] !== '1') {
      const script = movedScript(argv, overrides.pluginRoot ?? PLUGIN_ROOT, overrides.platform ?? process.platform);
      return delegate(script, argv, input, env);
    }
    throw new Error(error || `conduct.mjs lane stop-check exited ${result.code}`);
  } catch (error) {
    markFailed(argv, input, error, timestamp);
    return '';
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const decision = await stopCheck(process.argv.slice(2));
  if (decision) process.stdout.write(decision);
  process.exitCode = 0;
}
