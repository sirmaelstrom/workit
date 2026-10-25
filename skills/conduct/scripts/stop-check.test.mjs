import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'stop-check.mjs');

// The hook as Claude Code runs it: a process, the hook input on stdin.
function hook(args, input, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
}

// A run that upgrade-root moved to another plugin root, whose stop-check.mjs
// is a stub: it records the argv, stdin and hop marker it got, writes a
// verdict and blocks.
function movedRun(t, { stub = true } = {}) {
  const { runDir } = run(t);
  const newRoot = join(dirname(dirname(dirname(runDir))), 'plugin-1.28.2');
  if (stub) {
    const scripts = join(newRoot, 'skills', 'conduct', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'stop-check.mjs'), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const argv = process.argv.slice(2), runDir = argv[argv.indexOf('--run') + 1];",
      "const got = { argv, input: JSON.parse(readFileSync(0, 'utf8')), hop: process.env.WORKIT_STOP_CHECK_HOP ?? null };",
      "writeFileSync(join(runDir, 'lane-wp-00-stopcheck.json'), JSON.stringify({ verdict: 'blocked', by: 'new-root', got }));",
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'from the new root' }));",
    ].join('\n'));
  }
  const path = join(runDir, 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.pluginRoot = newRoot;
  state.handover = { pluginUpgrade: { from: join(dirname(SCRIPT), '..', '..', '..'), to: newRoot, why: 'test', at: '2026-10-25T15:30:00.000Z' } };
  writeFileSync(path, JSON.stringify(state));
  return { runDir, newRoot };
}

const verdictOf = (runDir, wp = 'wp-00') => JSON.parse(readFileSync(join(runDir, `lane-${wp}-stopcheck.json`), 'utf8'));

function run(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-stop-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, 'runs', 'demo', 'run');
  mkdirSync(runDir, { recursive: true });
  const wp = { id: 'WP-00', name: 'demo', files: ['a.mjs'], creates: ['a.mjs'], dependsOn: [], tier: 'T1', model: 'opus', state: 'dispatched', queue: [],
    lane: { backend: 'herdr', base: 'a'.repeat(40), worktree: join(dir, 'wt'), branch: 'conduct/demo/wp-00' } };
  const state = {
    schemaVersion: 1, slug: 'demo', runId: 'abcd1234', runDir, pluginRoot: join(dir, 'plugin'), rev: 0, seq: 0, phase: 'build',
    intent: { goal: 'demo', repo: { path: join(dir, 'repo'), remote: 'o/r', defaultBranch: 'main' }, anchor: 'anchor-uuid', lanesCap: 2, agent: 'claude' },
    agents: {}, adapters: { herdr: { on: true, detail: 'test' } }, wps: [wp],
  };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  return { runDir };
}

test('stop-check.mjs: a lane with no report gets exactly {"decision":"block","reason"} on stdout, exit 0', (t) => {
  const { runDir } = run(t);
  const result = hook(['--run', runDir, '--wp', 'WP-00'], { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(decision), ['decision', 'reason']);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /no report at .*lane-wp-00-report\.md/);
  assert.equal(JSON.parse(readFileSync(join(runDir, 'lane-wp-00-stopcheck.json'), 'utf8')).verdict, 'blocked');
});

test('stop-check.mjs: anything it cannot run (no such run, no such WP) prints nothing and exits 0, so the lane is never blocked by a crash', (t) => {
  const { runDir } = run(t);
  for (const args of [['--run', join(runDir, 'missing'), '--wp', 'WP-00'], ['--run', runDir, '--wp', 'WP-99'], []]) {
    const result = hook(args, { session_id: 's1' });
    assert.deepEqual([result.status, result.stdout], [0, ''], args.join(' '));
  }
});

test('stop-check.mjs: an old root\'s hook on a run that moved hands the same argv and stdin to the new root\'s stop-check, once, and prints its decision', (t) => {
  const { runDir } = movedRun(t);
  const input = { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] };
  const result = hook(['--run', runDir, '--wp', 'WP-00'], input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { decision: 'block', reason: 'from the new root' });
  const verdict = verdictOf(runDir);
  assert.equal(verdict.by, 'new-root');
  assert.deepEqual(verdict.got, { argv: ['--run', runDir, '--wp', 'WP-00'], input, hop: '1' });
});

test('stop-check.mjs: a hop that lands on a moved run again does not hop twice; it writes verdict failed naming the move', (t) => {
  const { runDir, newRoot } = movedRun(t);
  const result = hook(['--run', runDir, '--wp', 'WP-00'], { session_id: 's1' }, { WORKIT_STOP_CHECK_HOP: '1' });
  assert.deepEqual([result.status, result.stdout], [0, '']);
  const verdict = verdictOf(runDir);
  assert.equal(verdict.verdict, 'failed');
  assert.ok(verdict.reason.includes(`this run moved to the plugin root ${newRoot}`), verdict.reason);
  assert.ok(!Number.isNaN(Date.parse(verdict.at)));
});

test('stop-check.mjs: a stop-check that cannot run (moved to a root without stop-check.mjs, a corrupt state.json) prints nothing, exits 0 and writes verdict failed with the first line of why', (t) => {
  const moved = movedRun(t, { stub: false });
  const result = hook(['--run', moved.runDir, '--wp', 'WP-00'], { session_id: 's1' });
  assert.deepEqual([result.status, result.stdout], [0, '']);
  const gone = verdictOf(moved.runDir);
  assert.equal(gone.verdict, 'failed');
  assert.match(gone.reason, /stop-check\.mjs/);
  assert.ok(!gone.reason.includes('\n'));

  const { runDir } = run(t);
  writeFileSync(join(runDir, 'lane-wp-00-stopcheck.json'), JSON.stringify({ verdict: 'pass', round: 0, at: '2026-10-25T15:14:50.000Z' }));
  writeFileSync(join(runDir, 'state.json'), '{ not json');
  const corrupt = hook(['--run', runDir, '--wp', 'WP-00'], { session_id: 's2' });
  assert.deepEqual([corrupt.status, corrupt.stdout], [0, '']);
  const verdict = verdictOf(runDir);
  assert.deepEqual([verdict.verdict, verdict.sessionId], ['failed', 's2']);
  assert.ok(verdict.reason && !verdict.reason.includes('\n'), verdict.reason);
  assert.ok(Date.parse(verdict.at) > Date.parse('2026-10-25T15:14:50.000Z'));
});
