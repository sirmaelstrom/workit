import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'stop-check.mjs');

// The hook as Claude Code runs it: a process, the hook input on stdin.
function hook(args, input) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input: JSON.stringify(input), encoding: 'utf8' });
}

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
