#!/usr/bin/env node
// A claude lane's Stop hook: node stop-check.mjs --run <dir> --wp <id>, with the
// hook input on stdin. It runs `conduct.mjs lane stop-check` in process and
// prints {"decision":"block","reason":…} only when that verdict blocks the stop.
// It always exits 0 and prints nothing else: exit 2 would block the lane with a
// crash for its reason, and the lane cannot repair the conductor's script.
//
// The hook names the plugin root that was current when the lane started. When
// upgrade-root has since moved the run, this root's conduct.mjs refuses it, so
// the hook hands the same argv and stdin to the new root's stop-check.mjs: one
// hop, marked in the child's env, never a second. A check that cannot run
// writes verdict `failed` with the first line of why, so the conductor sees it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runConduct } from './conduct.mjs';

export const HOP_ENV = 'WORKIT_STOP_CHECK_HOP';
const MOVED = /this run moved to the plugin root (.+?); re-run the verb/;

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

// The new root's stop-check, as a process with the same argv and stdin.
function delegate(root, argv, input, env) {
  const script = join(root, 'skills', 'conduct', 'scripts', 'stop-check.mjs');
  if (!existsSync(script)) throw new Error(`the run moved to ${root}, which has no ${script}`);
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
    let error = result.stderr.replace(/^conduct: /, '');
    try {
      error = JSON.parse(result.stdout)?.error ?? error;
    } catch { /* stderr names it */ }
    const moved = MOVED.exec(error);
    if (moved && env[HOP_ENV] !== '1') return delegate(moved[1], argv, input, env);
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
