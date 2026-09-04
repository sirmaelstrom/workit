import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  EXIT_CODES, PLAN_REFUSAL_PATTERNS, paneAtPrompt, panePromptSignature, runLane, scrapePlanMeter,
} from './lane.mjs';
// Importing the smoke harness must run nothing: its live path is behind both
// `--live` and an entry-point check.
import { listsWorktree, s1Verdict, s2Verdict, stimulusFired, teardownSteps } from './lane-smoke.mjs';

// Every fixture path is built from tmpdir with path.join, and every
// platform-dependent branch is chosen through deps — the suite gates merge from
// a Linux runner, so a Windows-shaped literal here is a broken gate there.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-lane-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const responses = [];
  const exec = (program, args, options = {}) => {
    calls.push({ program, args: [...args], options });
    const next = responses.shift();
    if (typeof next === 'function') return next(program, args, options);
    return next ?? { code: 0, stdout: '{"result":{}}', stderr: '' };
  };
  return {
    dir,
    log: join(dir, 'lane-log.jsonl'),
    repo: join(dir, 'projects', 'workit'),
    calls,
    responses,
    exec,
  };
}

function readState(f) {
  return JSON.parse(readFileSync(`${f.log}.state.json`, 'utf8'));
}

// Fake existence for lane roots and the sweep delegate only — the state sidecar
// and its lock keep using the real filesystem.
function fakeExists(present = () => true) {
  return (path) => (String(path).includes('.state.json') ? existsSync(path) : present(String(path)));
}

// `start` reads the pane once — while it is still a shell — to record that
// pane's own prompt signature (A3). Every start-driving fixture therefore opens
// with a shell read.
const SHELL_READ = { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' };

function agentStartCall(f) {
  return f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
}

function seedLane(f, lane = {}) {
  writeFileSync(`${f.log}.state.json`, JSON.stringify({
    creates: [],
    lanes: {
      'lane-a': {
        pane: 'w1:p2',
        kind: 'codex',
        model: 'gpt-5.6-terra',
        reasoning: 'high',
        branch: 'feat/lane-a',
        base: 'main',
        path: f.dir,
        promptFile: join(f.dir, 'prompt.md'),
        ...lane,
      },
    },
  }), 'utf8');
}

test('WP-1: dontAsk is refused before herdr is invoked', async (t) => {
  const f = fixture(t);
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log, '--', '--permission-mode', 'dontAsk'],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /dontAsk/);
  assert.equal(f.calls.length, 0);
});

test('WP-1 / C8: start refuses an inherited reasoning effort before herdr is invoked', async (t) => {
  const f = fixture(t);
  for (const args of [
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--log', f.log],
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--sandbox', 'workspace-write', '--log', f.log],
  ]) {
    const result = await runLane(args, { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } });
    assert.equal(result.exit, 2, `${args[3]} lane must declare --reasoning`);
    assert.match(result.output.error, /--reasoning/);
  }
  assert.equal(f.calls.length, 0);
});

test('WP-1: read-only codex sandbox is refused before herdr is invoked', async (t) => {
  const f = fixture(t);
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'read-only', '--log', f.log],
    // platform injected: codex lanes are Windows-only (C12/U12), and without
    // this the Linux runner would exercise that refusal instead of this one.
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, platform: 'win32' },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /read-only/);
  assert.equal(f.calls.length, 0);
});

test('WP-1: claude start supplies the mandatory mode and restores conductor focus', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a","state":"idle"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{"focused":true}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"conductor","pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 0);
  assert.deepEqual(agentStartCall(f).args, ['agent', 'start', 'lane-a', '--kind', 'claude', '--pane', 'w1:p2', '--', '--model', 'opus', '--permission-mode', 'bypassPermissions', '--effort', 'high']);
  const after = f.calls.slice(f.calls.indexOf(agentStartCall(f)) + 1);
  assert.deepEqual(after[0].args, ['agent', 'focus', 'w1:p1']);
  assert.deepEqual(after[1].args, ['agent', 'list']);
});

test('WP-1: prompt sends only the absolute prompt-file instruction', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'task prompt.md');
  writeFileSync(prompt, 'shell-active `content`; must never be argv', 'utf8');
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"state":"working","accepted":true}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const result = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0);
  assert.deepEqual(f.calls[1].args, ['agent', 'prompt', 'lane-a', `Read ${resolve(prompt)} and execute it exactly.`, '--wait', '--until', 'working']);
  assert.doesNotMatch(f.calls[1].args.join(' '), /shell-active/);
});

test('WP-1: prompt refuses a missing file before herdr is invoked', async (t) => {
  const f = fixture(t);
  const result = await runLane(['prompt', 'lane-a', '--file', join(f.dir, 'missing.md'), '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /does not exist/);
  assert.equal(f.calls.length, 0);
});

test('WP-1: create refuses an existing branch before herdr is invoked', async (t) => {
  const f = fixture(t);
  f.responses.push({ code: 0, stdout: '', stderr: '' });
  const result = await runLane(
    ['create', '--repo', f.repo, '--branch', 'feat/existing', '--base', 'main', '--label', 'lane', '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /branch already exists/);
  assert.equal(f.calls.filter((call) => call.program === 'herdr').length, 0);
});

test('WP-1 / C13: create roots the lane beside the repo in the projects tree', async (t) => {
  const f = fixture(t);
  const repo = join(f.dir, 'projects', 'workit');
  const expectedPath = `${repo}-wt-feat-lane-helper`;
  f.responses.push(
    { code: 1, stdout: '', stderr: '' },
    { code: 0, stdout: JSON.stringify({ result: { workspace_id: 'wZ', pane_id: 'wZ:p1', path: expectedPath, branch: 'feat/lane-helper' } }), stderr: '' },
  );
  const result = await runLane(
    ['create', '--repo', repo, '--branch', 'feat/lane-helper', '--base', 'main', '--label', 'lane-w2', '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 0);
  const create = f.calls.find((call) => call.program === 'herdr');
  assert.deepEqual(create.args, [
    'worktree', 'create', '--cwd', repo, '--branch', 'feat/lane-helper', '--base', 'main',
    '--no-focus', '--label', 'lane-w2', '--path', expectedPath,
  ]);
  assert.equal(result.output.path, expectedPath);
  assert.doesNotMatch(result.output.path, /\.herdr/, 'C13: the lane must not land under the herdr default root');
});

test('WP-1 / C13: create honours an explicit --path and refuses one that already exists', async (t) => {
  const f = fixture(t);
  const taken = join(f.dir, 'projects', 'workit-wt-taken');
  mkdirSync(taken, { recursive: true });
  f.responses.push({ code: 1, stdout: '', stderr: '' });
  const result = await runLane(
    ['create', '--repo', f.repo, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x', '--path', taken, '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /already exists/);
  assert.equal(f.calls.filter((call) => call.program === 'herdr').length, 0);
});

test('WP-1: codex start waits for codex.exe and a returned prompt before agent start', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: 'X:\\fixture\\npm', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane> $env:PATH = "X:\\fixture\\vendor\\bin;" + $env:PATH; (Get-Command codex).Source', stderr: '' },
    { code: 0, stdout: 'X:\\fixture\\vendor\\bin\\codex.exe\nPS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'danger-full-access', '--log', f.log],
    // platform is injected: the Windows shim trap (C12) must be exercised by the
    // Linux runner too, and a process.platform read would skip it there.
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, platform: 'win32', findCodexBin: () => 'X:\\fixture\\vendor\\bin', sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  const npmRoot = f.calls.find((call) => call.program === 'cmd.exe');
  assert.deepEqual(npmRoot.args, ['/d', '/s', '/c', 'npm root -g']);
  const startIndex = f.calls.findIndex((call) => call.program === 'herdr' && call.args[0] === 'agent' && call.args[1] === 'start');
  const runIndex = f.calls.findIndex((call) => call.args[0] === 'pane' && call.args[1] === 'run');
  const readsAfterRun = f.calls.slice(runIndex, startIndex).filter((call) => call.args[0] === 'pane' && call.args[1] === 'read');
  assert.equal(readsAfterRun.length, 2, 'the readiness poll ran twice before the agent was started');
  assert.deepEqual(f.calls[startIndex].args.slice(-8), ['--model', 'gpt-5.6-terra', '--ask-for-approval', 'never', '--sandbox', 'danger-full-access', '-c', 'model_reasoning_effort=medium']);
  assert.equal(f.calls[startIndex].args.some((arg) => String(arg).includes('startup_timeout_sec')), false);
});

test('WP-1: every attempted verb appends the complete JSONL instrumentation shape', async (t) => {
  const f = fixture(t);
  await runLane(['prompt', 'lane-a', '--file', join(f.dir, 'missing.md'), '--log', f.log], { exec: f.exec });
  const row = JSON.parse(readFileSync(f.log, 'utf8').trim());
  assert.deepEqual(Object.keys(row), ['ts', 'lane', 'verb', 'kind', 'model', 'reasoning', 'state', 'waitMs', 'exit', 'plan5h', 'planWeekly', 'warning', 'error']);
  assert.equal(row.verb, 'prompt');
  assert.equal(row.exit, 2);
  assert.match(row.error, /does not exist/);
});

test('WP-1 fixture export remains available for later footer tests', () => {
  assert.equal(scrapePlanMeter('no meter here').plan5h, null);
});

test('WP-2 / S3: done is not evidence and an empty commit check exits 5', async (t) => {
  const f = fixture(t);
  seedLane(f, { state: 'done' });
  f.responses.push({ code: 0, stdout: '0\n', stderr: '' });
  const result = await runLane(['check', 'lane-a', '--expect-commit', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 5);
  assert.match(result.output.failedExpectation, /expect-commit/);
  assert.equal(f.calls.some((call) => call.program === 'herdr'), false, 'check must not accept agent status as evidence');
});

test('WP-2: file check requires the file and optional needle', async (t) => {
  const f = fixture(t);
  seedLane(f);
  const artifact = join(f.dir, 'artifact.md');
  writeFileSync(artifact, 'proof: green', 'utf8');
  const ok = await runLane(['check', 'lane-a', '--expect-file', `${artifact}:proof: green`, '--log', f.log], { exec: f.exec });
  const bad = await runLane(['check', 'lane-a', '--expect-file', `${artifact}:missing`, '--log', f.log], { exec: f.exec });
  assert.equal(ok.exit, 0);
  assert.equal(bad.exit, 5);
  assert.match(bad.output.failedExpectation, /missing/);
});

test('WP-2: PR check verifies the PR head equals the lane branch', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push({ code: 0, stdout: '{"headRefName":"other-branch","state":"OPEN"}', stderr: '' });
  const result = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 5);
  assert.deepEqual(f.calls[0].args, ['pr', 'view', '42', '--json', 'headRefName,state']);
  assert.match(result.output.failedExpectation, /head.*feat\/lane-a/);
});

test('WP-2: blocked wait exits 3 and includes the approval dialog', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"blocked"}}', stderr: '' },
    { code: 0, stdout: 'Approve running npm test?\n5h 72% left · weekly 88% left', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--until', 'blocked', '--timeout', '1000', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 3);
  assert.match(result.output.dialog, /Approve running npm test/);
  assert.equal(result.row.plan5h, 72);
  assert.equal(result.row.planWeekly, 88);
});

test('WP-2: done wait exits 0 but says status is not evidence', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' },
    { code: 0, stdout: 'finished', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0);
  assert.equal(result.output.state, 'done');
  assert.match(result.output.notice, /status is not evidence.*lane check/i);
});

test('WP-2: wait exits 4 when its overall timeout expires', async (t) => {
  const f = fixture(t);
  seedLane(f);
  let clock = 0;
  f.responses.push(
    () => { clock = 10; return { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' }; },
    { code: 0, stdout: 'still working', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--timeout', '5', '--log', f.log], { exec: f.exec, now: () => clock });
  assert.equal(result.exit, 4);
  assert.equal(result.output.state, 'timeout');
});

test('WP-2: footer meter below the plan floor exits 6 and is logged', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' },
    { code: 0, stdout: 'gpt-5.6-terra high · Context 62% left · 5h 9% left · weekly 91% left', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--timeout', '1000', '--plan-floor', '10', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(result.exit, 6);
  assert.equal(result.output.state, 'plan-low');
  assert.equal(result.row.plan5h, 9);
  assert.equal(result.row.planWeekly, 91);
});

test('WP-2 / C11: the captured refusal exits 6 even while herdr still reports idle', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"idle"}}', stderr: '' },
    {
      code: 0,
      stdout: [
        "■ You've hit your usage limit. Try again at 11:42 PM.",
        'Approaching rate limits — Switch to gpt-5.6-luna for lower credit usage?',
        '  › 1. Switch  2. Keep current model  3. Keep current model (never show again)',
        'gpt-5.6-terra high · Context 62% left · 5h 0% left · weekly 91% left',
      ].join('\n'),
      stderr: '',
    },
  );
  const result = await runLane(['wait', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(result.exit, 6, 'a usage-limit refusal is exit 6 regardless of lifecycle state');
  assert.equal(result.output.state, 'plan-refused');
  assert.match(result.output.refusal, /hit your usage limit/);
  assert.equal(result.row.state, 'plan-refused');
});

test('WP-2 / C11: the default plan floor is the measured 20%, not 10%', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' },
    { code: 0, stdout: 'gpt-5.6-terra high · Context 62% left · 5h 15% left · weekly 91% left', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(result.exit, 6);
  assert.equal(result.output.planFloor, 20);
  assert.equal(result.row.plan5h, 15);
});

test('WP-2: footer scrape returns the last meter and nulls when absent', () => {
  assert.deepEqual(
    scrapePlanMeter('old 5h 80% left · weekly 90% left\nnew 5h 79% left · weekly 89% left'),
    { plan5h: 79, planWeekly: 89 },
  );
  assert.deepEqual(scrapePlanMeter('gpt-5.6-terra · Context 62% left'), { plan5h: null, planWeekly: null });
  // C11 says the last FOOTER LINE. Taking the last match anywhere in the buffer
  // pairs a live 5h figure with a stale weekly one.
  assert.deepEqual(
    scrapePlanMeter('5h 80% left · weekly 90% left\nsome output\n5h 9% left'),
    { plan5h: 9, planWeekly: null },
  );
});

test('WP-2 / S6: resume waits explicitly until idle and never consults a bare stale-blocked wait', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push((program, args) => {
    if (!args.includes('--until')) return { code: 0, stdout: '{"result":{"state":"blocked"}}', stderr: '' };
    return { code: 0, stdout: '{"result":{"state":"idle"}}', stderr: '' };
  });
  const result = await runLane(['resume', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0);
  assert.equal(result.output.state, 'idle');
  assert.deepEqual(f.calls[0].args.slice(0, 7), ['agent', 'wait', 'lane-a', '--until', 'idle', '--until', 'done']);
  // One wait, never a bare one; the second call is the shared plan scrape that
  // `wait` also runs (R3-U7) — it reads the pane, it does not wait again.
  assert.equal(f.calls.filter((call) => call.args[1] === 'wait').length, 1);
  assert.deepEqual(f.calls[1].args.slice(0, 3), ['agent', 'read', 'lane-a']);
});

test('SMOKE6 / S6: resume also accepts done, because an unfocused lane never reaches idle', async (t) => {
  const f = fixture(t);
  seedLane(f);
  // Measured live: a lane started --no-focus is never "seen", so herdr settles
  // it to `done`. Waiting only for `idle` burned the full 120s and reported a
  // timeout while the approved work had already landed.
  f.responses.push((program, args) => {
    if (!args.includes('--until')) return { code: 0, stdout: '{"result":{"state":"blocked"}}', stderr: '' };
    if (!args.includes('done')) return { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' };
    return { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' };
  });
  const result = await runLane(['resume', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0, 'an approved lane that settled done is resumed, not a timeout');
  assert.equal(result.output.state, 'done');
  assert.match(result.output.notice, /status is not evidence/);
});

test('WP-3 / S7: fallback reuses the same pane and prompt path and records the channel switch', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'original task', 'utf8');
  seedLane(f, { promptFile: prompt });
  writeFileSync(f.log, `${JSON.stringify({
    ts: '2026-09-01T00:00:00.000Z', lane: 'lane-a', verb: 'wait', kind: 'codex', model: 'gpt-5.6-terra',
    reasoning: 'high', state: 'plan-low', waitMs: 1, exit: 6, plan5h: 9, planWeekly: 91,
  })}\n`, 'utf8');
  f.responses.push(
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true,"state":"working"}}', stderr: '' },
  );
  const result = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  const start = f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
  const startIndex = f.calls.indexOf(start);
  // C11(b): the rate-limit modal must be dismissed and codex quit before a
  // claude agent can take the pane — and the pane prompt is the evidence.
  const escIndex = f.calls.findIndex((call) => call.args[0] === 'agent' && call.args[1] === 'send-keys' && call.args.includes('esc'));
  const quitIndex = f.calls.findLastIndex((call) => call.args[0] === 'agent' && call.args[1] === 'send-keys' && call.args.includes('ctrl+c'));
  const paneReadIndex = f.calls.findIndex((call) => call.args[0] === 'pane' && call.args[1] === 'read');
  assert.ok(escIndex >= 0 && quitIndex > escIndex, 'esc then ctrl+c twice');
  assert.ok(paneReadIndex > quitIndex && paneReadIndex < startIndex, 'the shell prompt is confirmed before agent start');
  const promptCall = f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && call.args[3] !== '/quit');
  assert.equal(start.args[start.args.indexOf('--pane') + 1], 'w1:p2');
  assert.match(start.args.join(' '), /--kind claude/);
  assert.match(start.args.join(' '), /--model opus/);
  assert.equal(promptCall.args[3], `Read ${resolve(prompt)} and execute it exactly.`);
  const rows = readFileSync(f.log, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.kind, row.model, row.state]), [
    ['codex', 'gpt-5.6-terra', 'plan-low'],
    ['claude', 'opus', 'working'],
  ]);

  // C2: `lane check` is THE completion verdict, so a fallback must not cost the
  // lane its worktree identity. Re-read the state — counting calls and rows is
  // exactly what let this path stay green while it was non-functional.
  const persisted = readState(f).lanes['lane-a'];
  assert.equal(persisted.branch, 'feat/lane-a');
  assert.equal(persisted.base, 'main');
  assert.equal(persisted.path, f.dir);
  f.responses.push({ code: 0, stdout: '2\n', stderr: '' });
  const verdict = await runLane(['check', 'lane-a', '--expect-commit', '--log', f.log], { exec: f.exec });
  assert.equal(verdict.exit, 0, 'lane check must still resolve after a channel switch');
});

test('Q-1: fallback quits codex with esc and ctrl+c twice, never /quit', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'original task', 'utf8');
  seedLane(f, { promptFile: prompt });
  f.responses.push(
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true,"state":"working"}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const result = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  const keys = f.calls.filter((call) => call.args[0] === 'agent' && call.args[1] === 'send-keys');
  assert.deepEqual(keys.map((call) => call.args[3]), ['esc', 'ctrl+c', 'ctrl+c']);
  assert.equal(f.calls.some((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && call.args[3] === '/quit'), false);
});

test('Q-2: lane stop quits codex and succeeds only when agent list omits it', async (t) => {
  const f = fixture(t);
  seedLane(f, { promptSignature: 'PS X:\\fixture\\lane>' });
  f.responses.push(
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[]}}', stderr: '' },
  );
  const result = await runLane(['stop', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(result.exit, 0);
  assert.deepEqual(f.calls.slice(0, 3).map((call) => call.args.slice(0, 4)), [
    ['agent', 'send-keys', 'lane-a', 'esc'],
    ['agent', 'send-keys', 'lane-a', 'ctrl+c'],
    ['agent', 'send-keys', 'lane-a', 'ctrl+c'],
  ]);
});

test('Q-3: lane stop fails when agent list still contains the lane', async (t) => {
  const f = fixture(t);
  seedLane(f, { promptSignature: 'PS X:\\fixture\\lane>' });
  f.responses.push(
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a"}]}}', stderr: '' },
  );
  const result = await runLane(['stop', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(result.exit, 1);
  assert.match(result.output.error, /still listed|agent list/i);
});

test('Q-9: lane stop uses the measured claude /exit sequence', async (t) => {
  const f = fixture(t);
  seedLane(f, { kind: 'claude' });
  f.responses.push(
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: SHELL_READ.stdout, stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[]}}', stderr: '' },
  );
  const result = await runLane(['stop', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(result.exit, 0);
  assert.deepEqual(f.calls[0].args, ['agent', 'prompt', 'lane-a', '/exit']);
});

test('WP-3: the refusal pattern list carries the captured live refusal', () => {
  // Captured 2026-09-01 22:12Z, lane O. Nothing here is invented.
  const captured = "■ You've hit your usage limit. Try again at 11:42 PM.";
  assert.equal(PLAN_REFUSAL_PATTERNS.length, 2);
  assert.ok(PLAN_REFUSAL_PATTERNS.some((pattern) => pattern.test(captured)));
  assert.equal(PLAN_REFUSAL_PATTERNS.some((pattern) => pattern.test('5h 79% left · weekly 91% left')), false);
});

test('WP-3: exported lifecycle exit codes match the binding table', () => {
  // 1 is the herdr/infra failure code. Without it every hard failure reported as
  // 4 and a dead daemon was indistinguishable from a retryable wait timeout.
  assert.deepEqual(EXIT_CODES, { ok: 0, error: 1, usage: 2, blocked: 3, timeout: 4, artifactCheckFailed: 5, planLow: 6 });
});

test('WP-3 / S8+C13: sweep delegates a cleaning pass over both lane locations', async (t) => {
  const f = fixture(t);
  const profile = join(f.dir, 'profile');
  const legacyRoot = join(profile, '.herdr', 'worktrees');
  // The workspace root is not a lane root, so its call is scoped to a lane the
  // sidecar records as ours.
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-lane')]);
  f.responses.push(
    { code: 0, stdout: 'removing legacy lane ... done', stderr: '' },
    { code: 0, stdout: 'removing workit-wt-lane ... done', stderr: '' },
  );
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec,
    exists: fakeExists(),
    env: { USERPROFILE: profile, WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(result.exit, 0);
  assert.equal(f.calls.length, 2, 'one delegate invocation per lane location');
  for (const call of f.calls) {
    assert.equal(call.program, 'pwsh');
    assert.equal(call.args[0], '-NoProfile');
    assert.equal(call.args[1], '-File');
    // S8 needs removal, and the delegate is LIST-ONLY without -Clean.
    assert.ok(call.args.includes('-Clean'), 'sweep must ask the delegate to clean');
    assert.equal(call.args.includes('-Force'), false, 'never force by default — HOLD verdicts are the point');
  }
  const roots = f.calls.map((call) => call.args[call.args.indexOf('-WorktreeRoot') + 1]);
  assert.deepEqual(roots, [legacyRoot, f.dir]);
  const recorded = join(f.dir, 'projects', 'workit-wt-lane');
  assert.deepEqual(relative(roots[1], recorded).split(/[\\/]/), ['projects', 'workit-wt-lane']);
  assert.equal(result.output.roots.length, 2);
  assert.match(result.output.roots[1].output, /workit-wt-lane/);
});

test('WP-3 / C13: sweep accepts explicit roots and refuses when no location is declared', async (t) => {
  const f = fixture(t);
  const laneRoot = join(f.dir, '.herdr', 'worktrees');
  f.responses.push({ code: 0, stdout: 'nothing to remove', stderr: '' });
  const explicit = await runLane(['sweep', '--root', laneRoot, '--log', f.log], { exec: f.exec, env: {}, exists: fakeExists() });
  assert.equal(explicit.exit, 0);
  assert.deepEqual(f.calls.map((call) => call.args[call.args.indexOf('-WorktreeRoot') + 1]), [laneRoot]);

  const undeclared = await runLane(['sweep', '--log', f.log], { exec: f.exec, env: {} });
  assert.equal(undeclared.exit, 2);
  assert.match(undeclared.output.error, /--root|--workspace-root/);
});

test('WP-3: sweep prints the canonical operator commands when its delegate is absent', async (t) => {
  const f = fixture(t);
  const laneRoot = join(f.dir, '.herdr', 'worktrees');
  const result = await runLane(['sweep', '--root', laneRoot, '--log', f.log], {
    exec: f.exec,
    exists: fakeExists((path) => !path.endsWith('herdr-lanes.ps1')),
  });
  assert.equal(result.exit, 1, 'nothing was swept, so the exit code says so (R3-U2)');
  assert.equal(f.calls.length, 0);
  assert.match(result.output.commands[0], /^pwsh -NoProfile -File ".*herdr-lanes\.ps1"/);
  assert.match(result.output.commands[0], /-Clean$/);
  assert.ok(result.output.commands[0].includes(`-WorktreeRoot "${laneRoot}"`));
});

test('WP-4: burn-down and codex-delegate each point at the helper and a spec that resolves in-repo', () => {
  // workit is public: a pointer at the operator's local workshop directory is a
  // dead link for every consumer, and the old assertion could not detect that.
  const spec = 'reference/patterns/lane-supervision.md';
  assert.ok(existsSync(spec), `${spec} must exist for the skill pointers to resolve`);
  for (const file of ['skills/burn-down/SKILL.md', 'skills/codex-delegate/SKILL.md']) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.match(/scripts\/lane\.mjs/g)?.length, 1, `${file} must contain exactly one helper pointer`);
    assert.ok(text.includes(spec), `${file} must point at ${spec}`);
    assert.doesNotMatch(text, /data\/outputs\/workshops/, `${file} must not point outside the repo`);
    // A bare relative path does not resolve from the plugin cache, and the
    // standing bundled-ref guard only sees ${CLAUDE_*} refs — so a bare one is
    // both broken for consumers and invisible to CI.
    for (const ref of [`\${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs`, `\${CLAUDE_PLUGIN_ROOT}/${spec}`]) {
      assert.ok(text.includes(ref), `${file} must reference ${ref} so the bundled-ref guard covers it`);
    }
  }
});

// ---------------------------------------------------------------------------
// Amendment 1 — council round 1. Each test below pins one reproduced defect.
// ---------------------------------------------------------------------------

test('AM1: fallback validates its launch flags before it touches the pane', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'original task', 'utf8');
  seedLane(f, { promptFile: prompt });
  const result = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /--reasoning/);
  assert.match(result.output.error, /^fallback/, 'the error must name the verb the operator ran');
  assert.equal(f.calls.length, 0, 'codex must not be torn down before the flags validate');
  assert.equal(readState(f).lanes['lane-a'].kind, 'codex', 'the lane record must be untouched');
});

test('AM2: a failed focus check warns and still records the running agent', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 1, stdout: '', stderr: 'no such target' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 0, 'a started agent is never abandoned over a focus assertion');
  assert.match(result.output.warning, /focus/i);
  assert.match(result.row.warning, /focus/i);
  assert.ok(readState(f).lanes['lane-a'], 'the lane must be recorded before focus is asserted');
});

test('AM3 / S5: an unassociable agent listing reports focus unverified, never restored', async (t) => {
  const f = fixture(t);
  f.responses.push(
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    // Unparseable, and the only focused pane belongs to somebody else.
    { code: 0, stdout: 'agents: [ pane w9:p9 "focused": true ', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.output.focus, 'unverified');
  assert.match(result.output.warning, /focus/i);
});

test('AM3b / S5: a listing that shows the conductor unfocused is reported, not swallowed', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":false},{"pane_id":"w9:p9","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.output.focus, 'not-focused');
  assert.match(result.output.warning, /w1:p1/);
});

test('AM4: a herdr failure exits 1 and never masquerades as a wait timeout', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'task', 'utf8');
  f.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 1, stdout: '', stderr: 'daemon is not running' },
  );
  const result = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 1, 'a dead daemon is not a retryable timeout');
  assert.match(result.output.error, /daemon is not running/);
  assert.equal(result.row.exit, 1);
});

test('AM5 / U3: sweep visits every root even when one fails, and skips roots that are absent', async (t) => {
  const f = fixture(t);
  const profile = join(f.dir, 'profile');
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-lane')]);
  f.responses.push(
    { code: 1, stdout: '', stderr: 'legacy root exploded' },
    { code: 0, stdout: 'removing workit-wt-lane ... done', stderr: '' },
  );
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec,
    exists: fakeExists(),
    env: { USERPROFILE: profile, WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(f.calls.length, 2, 'the second root must still be swept');
  assert.equal(result.exit, 0, 'one failed root is not a failed sweep');
  assert.deepEqual(result.output.roots.map((entry) => entry.ok), [false, true]);

  const g = fixture(t);
  seedCreates(g, [join(g.dir, 'projects', 'workit-wt-lane')]);
  g.responses.push({ code: 0, stdout: 'done', stderr: '' });
  const skipped = await runLane(['sweep', '--log', g.log], {
    exec: g.exec,
    exists: fakeExists((path) => !path.includes('.herdr')),
    env: { USERPROFILE: join(g.dir, 'profile'), WORKIT_WORKSPACE_ROOT: g.dir },
  });
  assert.equal(g.calls.length, 1, 'a default root that does not exist is skipped, not swept');
  assert.equal(skipped.exit, 0);
});

test('AM5b: sweep exits 1 only when every root failed', async (t) => {
  const f = fixture(t);
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-lane')]);
  f.responses.push(
    { code: 1, stdout: '', stderr: 'boom' },
    { code: 1, stdout: '', stderr: 'boom' },
  );
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec,
    exists: fakeExists(),
    env: { USERPROFILE: join(f.dir, 'profile'), WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.output.roots.map((entry) => entry.ok), [false, false]);
});

test('AM6 / U4: create reads the herdr result envelope, never its cli id', async (t) => {
  const f = fixture(t);
  const expectedPath = `${f.repo}-wt-feat-x`;
  f.responses.push(
    { code: 1, stdout: '', stderr: '' },
    {
      code: 0,
      // The real envelope: every herdr response carries a top-level cli id.
      stdout: JSON.stringify({
        id: 'cli:worktree:create',
        result: { worktree: { path: expectedPath, branch: 'feat/x', open_workspace_id: 'wZ' } },
      }),
      stderr: '',
    },
    { code: 0, stdout: JSON.stringify({ id: 'cli:pane:list', result: { panes: [{ pane_id: 'wZ:p1', workspace_id: 'wZ' }] } }), stderr: '' },
  );
  const result = await runLane(
    ['create', '--repo', f.repo, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x', '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 0);
  assert.equal(result.output.workspaceId, 'wZ');
  assert.doesNotMatch(String(result.output.workspaceId), /^cli:/);
  // The create payload carries no pane, so it is resolved from the workspace —
  // lane-smoke feeds this straight into `lane start --pane`.
  assert.equal(result.output.paneId, 'wZ:p1');
  assert.equal(result.output.path, expectedPath);
});

test('AM7 / U5: a save re-reads the sidecar so a concurrent lane is not lost', async (t) => {
  const f = fixture(t);
  const stale = JSON.stringify({ creates: [], lanes: {} });
  const concurrent = JSON.stringify({ creates: [], lanes: { 'lane-b': { pane: 'w1:p9', kind: 'claude' } } });
  let reads = 0;
  const written = [];
  f.responses.push(
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    {
      exec: f.exec,
      env: { HERDR_PANE_ID: 'w1:p1' },
      exists: (path) => String(path).endsWith('.state.json') ? true : existsSync(path),
      // Another process wrote lane-b between our load and our save.
      read: (path) => String(path).endsWith('.state.json') ? (++reads === 1 ? stale : concurrent) : readFileSync(path, 'utf8'),
      write: (path, value) => { written.push([path, value]); },
      sleep: async () => {},
    },
  );
  const persisted = JSON.parse(written.at(-1)[1]);
  assert.ok(persisted.lanes['lane-a'], 'our own lane must be saved');
  assert.ok(persisted.lanes['lane-b'], 'the concurrently written lane must survive');
});

test('AM7b / U5: a held lock is retried, then released', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'task', 'utf8');
  seedLane(f);
  let attempts = 0;
  const removed = [];
  const sleeps = [];
  f.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"state":"working","accepted":true}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const result = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], {
    exec: f.exec,
    writeNew: (path) => {
      if (++attempts < 3) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
      removed.push(`held:${path}`);
    },
    remove: (path) => removed.push(`released:${path}`),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.exit, 0);
  assert.equal(attempts, 3, 'the lock is retried, not abandoned');
  assert.ok(sleeps.length >= 2, 'retries back off');
  assert.ok(removed.some((entry) => entry.startsWith('released:')), 'the lock is released in a finally');
});

test('AM8: the pane-prompt gate rejects a codex TUI line that merely ends in >', () => {
  assert.equal(paneAtPrompt('PS X:\\fixture\\lane>'), true);
  assert.equal(paneAtPrompt('X:\\fixture\\lane>'), true);
  assert.equal(paneAtPrompt('still running codex >'), false, 'this is the failover gate, not a suffix match');
  assert.equal(paneAtPrompt('  › 1. Switch  2. Keep current model'), false);
  assert.equal(paneAtPrompt('│ working on it >'), false);
});

test('AM9: the codex readiness poll retries a transient pane read instead of aborting', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: 'X:\\fixture\\npm', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 1, stdout: '', stderr: 'transient read failure' },
    { code: 0, stdout: 'X:\\fixture\\vendor\\bin\\codex.exe\nPS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'danger-full-access', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, platform: 'win32', findCodexBin: () => 'X:\\fixture\\vendor\\bin', sleep: async () => {} },
  );
  assert.equal(result.exit, 0, 'C12 exists because codex launches were flaky — do not reintroduce the flake');
  assert.ok(f.calls.some((call) => call.args[0] === 'agent' && call.args[1] === 'start'));
});

test('AM10: the PATH prepend is a single-quoted PowerShell literal', async (t) => {
  const f = fixture(t);
  f.responses.push(
    { code: 0, stdout: 'X:\\fixture\\npm', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: "X:\\fixture\\ven'dor\\bin\\codex.exe\nPS X:\\fixture\\lane>", stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  await runLane(
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'danger-full-access', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, platform: 'win32', findCodexBin: () => "X:\\fixture\\ven'dor\\bin", sleep: async () => {} },
  );
  const paneRun = f.calls.find((call) => call.args[0] === 'pane' && call.args[1] === 'run');
  assert.match(paneRun.args[3], /^\$env:PATH = '/, 'a single-quoted literal, so $ and ` cannot interpolate');
  assert.ok(paneRun.args[3].includes("ven''dor"), "an embedded quote is doubled, not left to terminate the literal");
});

test('AM11: a parse-time refusal still appends its instrumentation row', async (t) => {
  const f = fixture(t);
  const result = await runLane(['bogus-verb', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 2);
  const rows = readFileSync(f.log, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length, 1, 'every verb appends one row — including the ones that never ran');
  assert.equal(rows[0].exit, 2);
  assert.match(rows[0].error, /verb/);
});

test('AM12: the default log is anchored to the declared workspace, not the cwd', async (t) => {
  const f = fixture(t);
  f.responses.push({ code: 0, stdout: 'done', stderr: '' });
  const anchored = await runLane(['sweep', '--root', f.dir], {
    exec: f.exec,
    exists: fakeExists(),
    env: { WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(anchored.log, join(f.dir, 'data', 'outputs', 'projects', 'agentic-practice-transfer', 'lanes', 'lane-log.jsonl'));
  assert.equal(anchored.logSource, 'WORKIT_WORKSPACE_ROOT');

  const g = fixture(t);
  g.responses.push({ code: 0, stdout: 'done', stderr: '' });
  const cwdRelative = await runLane(['sweep', '--root', g.dir], {
    exec: g.exec,
    exists: fakeExists(),
    env: {},
    append: () => {},
    mkdir: () => {},
  });
  assert.equal(cwdRelative.log, resolve('lane-log.jsonl'));
  assert.equal(cwdRelative.logSource, 'cwd');
});

test('AM13: a failed agent read does not abort the wait, and the poll interval is a second', async (t) => {
  const f = fixture(t);
  seedLane(f);
  const sleeps = [];
  let clock = 0;
  f.responses.push(
    { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' },
    { code: 1, stdout: '', stderr: 'read failed' },
    { code: 0, stdout: '{"result":{"state":"blocked"}}', stderr: '' },
    { code: 0, stdout: 'Approve running npm test?', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--until', 'blocked', '--timeout', '60000', '--log', f.log], {
    exec: f.exec,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  assert.equal(result.exit, 3, 'metering is not the wait — a failed read must not end it');
  assert.match(result.output.dialog, /Approve running npm test/);
  // This asserts the pacing arithmetic under a fake clock, not wall-clock
  // behaviour. Production pacing is pinned by the herdr `--timeout` value the
  // poll sends (A3-10), which is what actually blocks for a second.
  assert.ok(sleeps.every((ms) => ms >= 1000), `poll interval must be >= 1s, saw ${sleeps.join(', ')}`);
});

test('AM14: a closed PR is not a completion verdict', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push({ code: 0, stdout: '{"headRefName":"feat/lane-a","state":"CLOSED"}', stderr: '' });
  const closed = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', f.log], { exec: f.exec });
  assert.equal(closed.exit, 5);
  assert.match(closed.output.failedExpectation, /closed/i);

  f.responses.push({ code: 0, stdout: '{"headRefName":"feat/lane-a","state":"MERGED"}', stderr: '' });
  const merged = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', f.log], { exec: f.exec });
  assert.equal(merged.exit, 0, 'a merged PR is the work landing, not a failure');
});

test('AM15: the usage text documents every flag the CLI accepts, including --lane', async (t) => {
  const f = fixture(t);
  const result = await runLane(['--help'], { exec: f.exec, append: () => {}, mkdir: () => {} });
  assert.equal(result.exit, 2);
  assert.match(result.output.usage, /--lane/);
  assert.match(result.output.usage, /sweep/);
  assert.match(result.output.usage, /--plan-floor/);
});

test('SMOKE1: wait passes every --until through, so a finished lane is still seen', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' },
    { code: 0, stdout: 'finished', stderr: '' },
  );
  const result = await runLane(
    ['wait', 'lane-a', '--until', 'blocked', '--until', 'idle', '--until', 'done', '--timeout', '1000', '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 0);
  assert.equal(result.output.state, 'done');
  assert.deepEqual(
    f.calls[0].args,
    ['agent', 'wait', 'lane-a', '--until', 'blocked', '--until', 'idle', '--until', 'done', '--timeout', '1000'],
  );
});

test('SMOKE2: default permission mode is opt-in and announced; dontAsk stays refused', async (t) => {
  const f = fixture(t);
  const refused = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low',
      '--permission-mode', 'default', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(refused.exit, 2);
  assert.match(refused.output.error, /--allow-default-mode/);
  assert.equal(f.calls.length, 0);

  const g = fixture(t);
  g.responses.push(
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const allowed = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low',
      '--permission-mode', 'default', '--allow-default-mode', '--log', g.log],
    { exec: g.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(allowed.exit, 0);
  assert.match(allowed.output.warning, /default permission mode/);
  assert.ok(agentStartCall(g).args.includes('default'));

  // The escape hatch must not reach dontAsk, which auto-denies and still settles.
  const h = fixture(t);
  const stillRefused = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low',
      '--permission-mode', 'dontAsk', '--allow-default-mode', '--log', h.log],
    { exec: h.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(stillRefused.exit, 2);
  assert.match(stillRefused.output.error, /dontAsk/);
  assert.equal(h.calls.length, 0);
});

test('SMOKE3: the harness never passes S1 on a timeout or a lane that finished', () => {
  assert.equal(s1Verdict(3, 'blocked', 'Do you want to create .lane-smoke-marker?').ok, true);
  const settled = s1Verdict(0, 'done', '');
  assert.equal(settled.ok, false);
  assert.match(settled.message, /S1 FAILED: lane settled done without a block/);
  assert.equal(s1Verdict(0, 'idle').ok, false);
  const timedOut = s1Verdict(4, 'timeout');
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.message, /timed out/);
  assert.equal(s1Verdict(6, 'plan-low').ok, false);

  // S2 is the negative control and inverts on `blocked`.
  assert.equal(s2Verdict(0, 'done').ok, true);
  assert.equal(s2Verdict(0, 'idle').ok, true);
  assert.equal(s2Verdict(3, 'blocked').ok, false);
  assert.equal(s2Verdict(4, 'timeout').ok, false);
});

test('SMOKE4: teardown quits every agent, then closes every workspace, then sweeps', () => {
  const steps = teardownSteps([
    { name: 'smoke-a', paneId: 'w1:p1', workspaceId: 'w1', path: join('X:\\fixture', 'workit-wt-a') },
    { name: 'smoke-b', paneId: 'w2:p1', workspaceId: 'w2', path: join('X:\\fixture', 'workit-wt-b') },
  ]);
  assert.deepEqual(steps.map((step) => step.step), [
    'drop-marker', 'drop-marker', 'quit-agent', 'quit-agent',
    'close-workspace', 'close-workspace', 'sweep', 'sweep',
  ]);
  // The sweeper HOLDS a lane that still hosts an agent OR carries an
  // uncommitted change — both measured — so the smoke's own marker goes first,
  // then the agents, then the workspaces, and only then the sweep.
  assert.ok(steps.findIndex((s) => s.step === 'quit-agent') > steps.findLastIndex((s) => s.step === 'drop-marker'));
  assert.ok(steps.findIndex((s) => s.step === 'close-workspace') > steps.findLastIndex((s) => s.step === 'quit-agent'));
  assert.ok(steps.findIndex((s) => s.step === 'sweep') > steps.findLastIndex((s) => s.step === 'close-workspace'));
  assert.deepEqual(steps.filter((s) => s.step === 'sweep').map((s) => s.laneDir), ['workit-wt-a', 'workit-wt-b']);
});

test('SMOKE5: the S8 worktree check survives separator differences', () => {
  const listing = 'X:\\fixture\\projects\\workit-wt-a  abc1234 [smoke/lane-a]';
  assert.equal(listsWorktree(listing, 'X:/fixture/projects/workit-wt-a'), true, 'herdr returns forward slashes');
  assert.equal(listsWorktree(listing, 'X:\\fixture\\projects\\workit-wt-a'), true);
  assert.equal(listsWorktree(listing, 'X:/fixture/projects/workit-wt-b'), false);
  assert.equal(listsWorktree(listing, null), false);
});

test('SCRUB: the sweep delegate is resolved, never a hardcoded machine path', async (t) => {
  const f = fixture(t);
  const declared = join(f.dir, 'delegate', 'herdr-lanes.ps1');
  f.responses.push({ code: 0, stdout: 'done', stderr: '' });
  const fromEnv = await runLane(['sweep', '--root', join(f.dir, '.herdr', 'worktrees'), '--log', f.log], {
    exec: f.exec,
    exists: fakeExists(),
    env: { HERDR_LANES_SCRIPT: declared },
  });
  assert.equal(fromEnv.exit, 0);
  assert.equal(f.calls[0].args[2], declared, 'HERDR_LANES_SCRIPT wins');

  const g = fixture(t);
  g.responses.push({ code: 0, stdout: 'done', stderr: '' });
  await runLane(['sweep', '--root', join(g.dir, '.herdr', 'worktrees'), '--log', g.log], {
    exec: g.exec,
    exists: fakeExists(),
    env: { WORKIT_WORKSPACE_ROOT: g.dir },
  });
  assert.equal(g.calls[0].args[2], join(g.dir, 'infrastructure', 'herdr-lanes.ps1'), 'else it derives from the workspace root');

  const h = fixture(t);
  const missing = await runLane(['sweep', '--root', join(h.dir, '.herdr', 'worktrees'), '--log', h.log], {
    exec: h.exec,
    exists: fakeExists((path) => !path.endsWith('herdr-lanes.ps1')),
    env: {},
  });
  assert.equal(h.calls.length, 0);
  assert.match(missing.output.hint, /HERDR_LANES_SCRIPT/, 'and an unresolvable delegate says how to declare one');
});

test('SCRUB: no host topology reaches the public files (guard is non-vacuous)', () => {
  // workit is public. This guard is the standing half of the scrub: a one-off
  // cut refills — a later fixture in this very file reintroduced an operator
  // drive path, which is why lane.test.mjs is scanned too. Windows-SHAPED
  // fixtures (X:\fixture\…) are fine; this machine's real paths are not. The
  // patterns are assembled from fragments so the guard cannot match itself.
  const files = [
    'reference/patterns/lane-supervision.md',
    'reference/patterns/INDEX.md',
    'scripts/lane.mjs',
    'scripts/lane-smoke.mjs',
    'scripts/lane.test.mjs',
    'skills/burn-down/SKILL.md',
    'skills/codex-delegate/SKILL.md',
  ];
  const banned = [
    ['operator username', new RegExp(['jm', 'hea'].join(''), 'i')],
    ['user-profile path', /[A-Za-z]:\\+Users/i],
    ['operator drive layout', /[A-Za-z]:\\+Development/i],
    ['hostname', new RegExp(`\\b(?:${['fla', 'gg'].join('')}|${['thedark', 'tower'].join('')})\\b`, 'i')],
    ['LAN address', /\b192\.168\.\d{1,3}\.\d{1,3}\b/],
  ];
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    scanned += text.length;
    for (const [label, pattern] of banned) {
      assert.doesNotMatch(text, pattern, `${file} leaks ${label} into a public repo`);
    }
  }
  assert.ok(scanned > 20_000, `the guard must actually read the files, saw ${scanned} chars`);
  // The guard discriminates: it catches a planted violation.
  assert.match(`Q:${'\\'}Users${'\\'}someone`, banned[1][1]);
});

test('AM16 / C13: create refuses a lane that would land outside the projects tree', async (t) => {
  const f = fixture(t);
  const outside = join(f.dir, 'elsewhere', 'workit');
  f.responses.push({ code: 1, stdout: '', stderr: '' });
  const refused = await runLane(
    ['create', '--repo', outside, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x', '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(refused.exit, 2);
  assert.match(refused.output.error, /projects/);
  assert.equal(f.calls.filter((call) => call.program === 'herdr').length, 0);

  const g = fixture(t);
  g.responses.push({ code: 1, stdout: '', stderr: '' });
  const wrongWorkspace = await runLane(
    ['create', '--repo', g.repo, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x',
      '--workspace-root', join(g.dir, 'other-workspace'), '--log', g.log],
    { exec: g.exec },
  );
  assert.equal(wrongWorkspace.exit, 2, 'the declared workspace root binds the lane location');
  assert.match(wrongWorkspace.output.error, /projects/);
});

// ---------------------------------------------------------------------------
// Amendment 2 — council round 2. Each fix ships with its negative control:
// round 1 closed reproduced instances, and the classes came back.
// ---------------------------------------------------------------------------

function sweepEnv(f) {
  return { USERPROFILE: join(f.dir, 'profile'), WORKIT_WORKSPACE_ROOT: f.dir };
}

function seedCreates(f, paths) {
  writeFileSync(`${f.log}.state.json`, JSON.stringify({
    lanes: {},
    creates: paths.map((path, index) => ({
      path, branch: `smoke/lane-${index}`, base: 'main', label: `lane-${index}`,
      workspaceId: `w${index}`, paneId: `w${index}:p1`,
    })),
  }), 'utf8');
}

test('A2-1 / U2: no delegate call against a non-lane root may go unscoped, and --force is refused there', async (t) => {
  const f = fixture(t);
  const laneDir = join(f.dir, 'projects', 'workit-wt-alpha');
  seedCreates(f, [laneDir]);
  f.responses.push({ code: 0, stdout: 'removing workit-wt-alpha ... done', stderr: '' });
  const swept = await runLane(['sweep', '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: sweepEnv(f),
  });
  assert.equal(swept.exit, 0);

  // The delegate deletes with Remove-Item -Recurse -Force. A workspace root is
  // NOT a lane root — it holds data/ and projects/ — so every call against one
  // must carry a -Lane filter naming a lane this helper actually created.
  for (const call of f.calls) {
    const root = call.args[call.args.indexOf('-WorktreeRoot') + 1];
    if (root === f.dir) {
      assert.ok(call.args.includes('-Lane'), `unscoped delegate call against the workspace root: ${call.args.join(' ')}`);
      assert.equal(call.args[call.args.indexOf('-Lane') + 1], 'workit-wt-alpha');
    }
  }

  const g = fixture(t);
  seedCreates(g, [join(g.dir, 'projects', 'workit-wt-alpha')]);
  const forced = await runLane(['sweep', '--force', '--log', g.log], {
    exec: g.exec, exists: fakeExists(), env: sweepEnv(g),
  });
  assert.equal(forced.exit, 2, '--force against a workspace root is refused outright');
  assert.match(forced.output.error, /--force/);
  assert.equal(g.calls.length, 0, 'nothing is delegated when --force is refused');
});

test('A2-1b / U2: a root with no known lanes is reported, never swept wholesale', async (t) => {
  const f = fixture(t);
  seedCreates(f, []);
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: { WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(f.calls.length, 0, 'an unscoped workspace-root sweep is exactly the 77-directory blast radius');
  assert.equal(result.output.roots[0].skipped, 'no known lanes under this root');
});

test('A2-1c / U2: the herdr worktree root IS a lane root and sweeps unfiltered', async (t) => {
  const f = fixture(t);
  const legacy = join(f.dir, 'profile', '.herdr', 'worktrees');
  seedCreates(f, []);
  f.responses.push({ code: 0, stdout: 'No lanes.', stderr: '' });
  await runLane(['sweep', '--log', f.log], {
    exec: f.exec, exists: fakeExists((path) => !path.includes(`${sep}data${sep}`)), env: { USERPROFILE: join(f.dir, 'profile') },
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-WorktreeRoot') + 1], legacy);
  assert.equal(f.calls[0].args.includes('-Lane'), false, 'every directory under the herdr root is a lane by construction');
});

test('A2-2 / C1: a git failure in --expect-commit is exit 1, never a timeout', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push({ code: 128, stdout: '', stderr: 'fatal: bad revision main..feat/lane-a' });
  const result = await runLane(['check', 'lane-a', '--expect-commit', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 1, 'a conductor that trusts the table re-polls a 4 forever');
  assert.match(result.output.error, /bad revision/);
});

test('A2-2b / U13: --expect-pr separates "no such PR" from a gh failure', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push({ code: 1, stdout: '', stderr: 'no pull requests found for branch "feat/lane-a"' });
  const missing = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', f.log], { exec: f.exec });
  assert.equal(missing.exit, 5, 'a missing PR is a failed expectation');
  assert.match(missing.output.failedExpectation, /does not exist/);

  f.responses.push({ code: 1, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login' });
  const broken = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', f.log], { exec: f.exec });
  assert.equal(broken.exit, 1, 'expired auth is infrastructure, not a verdict about the work');
  assert.match(broken.output.error, /auth/i);
});

test('A2-2c / S4: a wedged pane is an infra failure (1), not a wait deadline (4)', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'task', 'utf8');
  seedLane(f, { promptFile: prompt });
  let clock = 0;
  f.responses.push(
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    () => { clock += 40_000; return { code: 0, stdout: 'codex is still running', stderr: '' }; },
  );
  const result = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, now: () => clock, sleep: async () => {} },
  );
  assert.equal(result.exit, 1);
  assert.match(result.output.error, /shell prompt/);
});

test('A2-3 / C2: a sweep that found no root to visit is not a sweep', async (t) => {
  const f = fixture(t);
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec,
    // Both defaults declared, neither present: a typo'd WORKIT_WORKSPACE_ROOT.
    exists: fakeExists((path) => !path.includes('nowhere')),
    env: { USERPROFILE: join('nowhere', 'profile'), WORKIT_WORKSPACE_ROOT: join('nowhere', 'workspace') },
  });
  assert.equal(result.exit, 1, 'zero roots visited must not report success');
  assert.equal(result.output.state ?? result.row.state, 'no-roots-present');
  assert.equal(f.calls.length, 0);
  assert.match(JSON.stringify(result.output.missingRoots), /nowhere/, 'name the roots it looked for');
});

test('A2-4 / U3: a blocked lane is reported even when the caller asked for --until done', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"blocked"}}', stderr: '' },
    { code: 0, stdout: 'Do you want to create .lane-smoke-marker?', stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--until', 'done', '--timeout', '5000', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 3, 'the helper must not be blinder than the tool it wraps');
  assert.ok(f.calls[0].args.includes('blocked'), 'blocked is always added to the caller\'s target states');
  assert.ok(f.calls[0].args.includes('done'));
});

test('A2-5 / U5: a forwarded --model cannot override the enforced one', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const claude = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high',
      '--log', f.log, '--', '--model', 'sonnet-cheap'],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(claude.exit, 0);
  const emitted = agentStartCall(f).args;
  assert.equal(emitted.filter((arg) => arg === '--model').length, 1, 'C8 cost $5.24 in 9 minutes; last-flag-wins reopens it');
  assert.equal(emitted[emitted.indexOf('--model') + 1], 'opus');
  assert.equal(emitted.includes('sonnet-cheap'), false);

  const g = fixture(t);
  g.responses.push(
    SHELL_READ,
    { code: 0, stdout: 'X:\\fixture\\npm', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: 'X:\\fixture\\vendor\\bin\\codex.exe\nPS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const codex = await runLane(
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium',
      '--sandbox', 'danger-full-access', '--log', g.log, '--', '--model', 'gpt-cheap', '-c', 'model_reasoning_effort=xhigh'],
    { exec: g.exec, env: { HERDR_PANE_ID: 'w1:p1' }, platform: 'win32', findCodexBin: () => 'X:\\fixture\\vendor\\bin', sleep: async () => {} },
  );
  assert.equal(codex.exit, 0);
  const codexArgs = g.calls.find((call) => call.args[1] === 'start').args;
  assert.equal(codexArgs.filter((arg) => arg === '--model').length, 1);
  assert.equal(codexArgs.filter((arg) => String(arg).startsWith('model_reasoning_effort=')).length, 1);
  assert.equal(codexArgs.includes('model_reasoning_effort=xhigh'), false);
});

test('A2-6 / S2: C13 is asserted on the path herdr RETURNED, not only the one requested', async (t) => {
  const f = fixture(t);
  const elsewhere = join(f.dir, 'profile', '.herdr', 'worktrees', 'workit', 'lane');
  f.responses.push(
    { code: 1, stdout: '', stderr: '' },
    { code: 0, stdout: JSON.stringify({ id: 'cli:worktree:create', result: { worktree: { path: elsewhere, branch: 'feat/x', open_workspace_id: 'wZ', pane_id: 'wZ:p1' } } }), stderr: '' },
  );
  const result = await runLane(
    ['create', '--repo', f.repo, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x',
      '--workspace-root', f.dir, '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 1, 'a lane that landed outside the projects tree is a failure, not a success document');
  assert.match(result.output.error, /projects/);
  assert.match(result.output.error, /\.herdr/);
});

test('A2-7 / U6: create refuses to return a document with no pane', async (t) => {
  const f = fixture(t);
  const path = `${f.repo}-wt-feat-x`;
  f.responses.push(
    { code: 1, stdout: '', stderr: '' },
    { code: 0, stdout: JSON.stringify({ result: { worktree: { path, branch: 'feat/x', open_workspace_id: 'wZ' } } }), stderr: '' },
    { code: 1, stdout: '', stderr: 'no such workspace' },
  );
  const result = await runLane(
    ['create', '--repo', f.repo, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x', '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 1);
  assert.match(result.output.error, /paneId/, 'name the missing field where it went missing, not one verb later');
});

test('A2-8 / U7: an infra error is not masked by the plan meter, and a finished lane is not plan-low', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push({ code: 1, stdout: '', stderr: 'daemon is not running' });
  const dead = await runLane(['wait', 'lane-a', '--timeout', '5000', '--log', f.log], { exec: f.exec, sleep: async () => {} });
  assert.equal(dead.exit, 1, 'a dead daemon outranks a stale meter reading');

  const g = fixture(t);
  seedLane(g);
  g.responses.push(
    { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' },
    { code: 0, stdout: 'gpt-5.6-terra · 5h 3% left · weekly 40% left', stderr: '' },
  );
  const finished = await runLane(['wait', 'lane-a', '--timeout', '5000', '--log', g.log], { exec: g.exec, sleep: async () => {} });
  assert.equal(finished.exit, 0, 'work that finished is done, whatever the meter says');
  assert.equal(finished.output.state, 'done');
  assert.equal(finished.row.plan5h, 3, 'the meter is still recorded');
});

test('A2-9 / U10: a stale lock is reclaimed with a warning instead of wedging every later call', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'task', 'utf8');
  seedLane(f);
  const warnings = [];
  let attempts = 0;
  f.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"state":"working","accepted":true}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const result = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], {
    exec: f.exec,
    writeNew: () => {
      if (++attempts === 1) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
    },
    stat: () => ({ mtimeMs: 0 }),
    now: () => 3_600_000,
    remove: () => {},
    warn: (message) => warnings.push(message),
    sleep: async () => {},
  });
  assert.equal(result.exit, 0);
  assert.equal(attempts, 2, 'the stale lock is broken and the write retried');
  assert.match(warnings.join('\n'), /stale lock/i);
});

test('A2-10 / U12: codex lanes are refused off Windows instead of hunting a win32 vendor path', async (t) => {
  const f = fixture(t);
  const result = await runLane(
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium',
      '--sandbox', 'workspace-write', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, platform: 'linux' },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /windows/i);
  assert.equal(f.calls.length, 0);
});

test('A2-11 / U15: an unreadable sidecar does not read as invalid JSON', async (t) => {
  const f = fixture(t);
  const result = await runLane(['check', 'lane-a', '--expect-commit', '--log', f.log], {
    exec: f.exec,
    exists: () => true,
    read: () => { const error = new Error('EBUSY: resource busy or locked'); error.code = 'EBUSY'; throw error; },
  });
  assert.match(result.output.error, /EBUSY|could not read/i);
  assert.doesNotMatch(result.output.error, /not valid JSON/, 'do not send the operator to delete a healthy sidecar');
});

test('A2-12 / U15: EXIT_CODES carries every code the header documents', () => {
  assert.deepEqual(EXIT_CODES, { ok: 0, error: 1, usage: 2, blocked: 3, timeout: 4, artifactCheckFailed: 5, planLow: 6 });
});

// ---------------------------------------------------------------------------
// Amendment 3 — the prompt-shape detector. Measured on the box this was built
// on: the pwsh prompt here is two oh-my-posh lines whose last line ends in `~`.
// No `>`, no `❯`, no `$` — so NO shape-based default could ever match it, and
// `prepareCodexPane` and every `fallback` would poll 30s and exit 1.
// ---------------------------------------------------------------------------

// The live signature, read from a fresh herdr pane on this box (glyphs dropped
// by the same reader that will compare it — which is the point).
const MEASURED_PROMPT = '~  home / .herdr / worktrees / workit / feat-lane-helper ~';

// A live claude TUI: the composer is a bare `❯`, but it is never the LAST line —
// the status footer is. Both facts are load-bearing below.
const CLAUDE_TUI = [
  '● smoke complete',
  '─────────────────────────────────────────────',
  '❯',
  '─────────────────────────────────────────────',
  '  ⚡ Opus 5 │ 🌿 smoke/lane-a │ ▓░░░░░░░░░ 7% │ $0.70',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const CODEX_TUI = [
  '  Ask Codex to do something',
  '  gpt-5.6-terra high · Context 62% left · 5h 79% left · weekly 91% left',
].join('\n');

test('A3-1: the pane\'s own last line is the signature, volatile prompt segments excluded', () => {
  // The first oh-my-posh line carries a clock and a duration; the last line is
  // the stable one, which is why the signature is taken from the tail.
  const pane = [
    '~ sirm   feat/lane-helper   pwsh        0.001s  Tuesday at 7:17 PM ',
    MEASURED_PROMPT,
  ].join('\n');
  assert.equal(panePromptSignature(pane), MEASURED_PROMPT);
  assert.equal(panePromptSignature(`${pane}\n\n  \n`), MEASURED_PROMPT, 'trailing blank lines are not the signature');
  assert.equal(panePromptSignature(''), null);
});

test('A3-2: a recorded signature is what the wait matches — this box has no matchable shape', () => {
  const pane = `~ sirm  pwsh  0.9s\n${MEASURED_PROMPT}`;
  assert.equal(paneAtPrompt(pane), false, 'no default shape matches this prompt; that is the reported defect');
  assert.equal(paneAtPrompt(pane, { signature: MEASURED_PROMPT }), true);
  assert.equal(paneAtPrompt(`${pane}\n$p = Start-Process -FilePath codex`, { signature: MEASURED_PROMPT }), false,
    'a typed command means the pane is busy, not free');
  assert.equal(paneAtPrompt(CLAUDE_TUI, { signature: MEASURED_PROMPT }), false);
});

test('A3-3: the default shapes cover the common prompts and reject TUI lines', () => {
  assert.equal(paneAtPrompt('PS X:\\fixture\\lane>'), true);
  assert.equal(paneAtPrompt('X:\\fixture\\lane>'), true);
  assert.equal(paneAtPrompt('>'), true, 'a BARE > is a prompt');
  assert.equal(paneAtPrompt('$'), true);
  assert.equal(paneAtPrompt('~/work ❯'), true);
  assert.equal(paneAtPrompt('➜  workit'.concat(' ➜')), true);
  assert.equal(paneAtPrompt('λ'), true);

  // Round 1's negatives must stay negative: never an unanchored `>`.
  assert.equal(paneAtPrompt('still running codex >'), false);
  assert.equal(paneAtPrompt('  › 1. Switch  2. Keep current model'), false);
  assert.equal(paneAtPrompt('│ working on it >'), false);

  // A live TUI is not a free pane, even though its composer is a bare glyph.
  assert.equal(paneAtPrompt(CLAUDE_TUI), false, 'the claude composer ❯ is not a shell prompt');
  assert.equal(paneAtPrompt(CODEX_TUI), false, 'the Ask Codex footer is not a shell prompt');
});

test('A3-4: an operator can declare the prompt, by flag or by env', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'task', 'utf8');
  seedLane(f, { promptFile: prompt, promptSignature: null });
  // Two herdr calls to quit codex, then pane reads until the prompt is back.
  f.responses.push(
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: `remnant\n${MEASURED_PROMPT}`, stderr: '' },
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true,"state":"working"}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const byEnv = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1', LANE_PROMPT_REGEX: '.*helper ~$' }, sleep: async () => {} },
  );
  assert.equal(byEnv.exit, 0, 'LANE_PROMPT_REGEX declares what this box\'s prompt looks like');

  const g = fixture(t);
  const bad = await runLane(
    ['wait', 'lane-a', '--timeout', '1000', '--prompt-regex', '([unclosed', '--log', g.log],
    { exec: g.exec },
  );
  assert.equal(bad.exit, 2, 'an unusable prompt regex is refused, not silently ignored');
  assert.match(bad.output.error, /prompt-regex/);
});

test('A3-5: start records the pane signature while the pane is still a shell', async (t) => {
  const f = fixture(t);
  f.responses.push(
    { code: 0, stdout: `~ sirm  pwsh\n${MEASURED_PROMPT}`, stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 0);
  const read = f.calls[0];
  assert.deepEqual(read.args.slice(0, 2), ['pane', 'read'], 'the signature is captured BEFORE the agent takes the pane');
  assert.equal(readState(f).lanes['lane-a'].promptSignature, MEASURED_PROMPT);
});

test('A3-5b: the capture waits for a freshly created pane to draw its prompt', async (t) => {
  const f = fixture(t);
  // Measured live at 349c11b: read immediately after `lane create`, the pane is
  // still empty and the signature landed as null — which silently drops
  // `fallback` back to the shape guess this whole mechanism replaces.
  f.responses.push(
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '   \n', stderr: '' },
    { code: 0, stdout: `~ sirm  pwsh\n${MEASURED_PROMPT}`, stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  assert.equal(readState(f).lanes['lane-a'].promptSignature, MEASURED_PROMPT);

  // A pane that never draws a prompt must not block the launch.
  const g = fixture(t);
  let clock = 0;
  g.responses.push(
    () => { clock += 6000; return { code: 0, stdout: '', stderr: '' }; },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const quiet = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', g.log],
    { exec: g.exec, env: { HERDR_PANE_ID: 'w1:p1' }, now: () => clock, sleep: async () => {} },
  );
  assert.equal(quiet.exit, 0, 'the capture is best-effort; a quiet pane still starts its lane');
  assert.equal(readState(g).lanes['lane-a'].promptSignature, null);
});

test('A3-6: fallback waits for the signature the lane recorded', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md');
  writeFileSync(prompt, 'task', 'utf8');
  seedLane(f, { promptFile: prompt, promptSignature: MEASURED_PROMPT });
  f.responses.push(
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: CODEX_TUI, stderr: '' },
    { code: 0, stdout: `some codex remnant\n~ sirm  pwsh\n${MEASURED_PROMPT}`, stderr: '' },
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true,"state":"working"}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const result = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--reasoning', 'high', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  const startIndex = f.calls.indexOf(agentStartCall(f));
  const reads = f.calls.slice(0, startIndex).filter((call) => call.args[0] === 'pane' && call.args[1] === 'read');
  // Two waiting reads (the codex footer is rejected, the signature accepted),
  // then the re-start's own capture of the now-free pane.
  assert.equal(reads.length, 3, 'it waited for the signature rather than accepting the codex footer');
});

test('A3-7 / R3-U1: --lane is intersected with the sidecar, not passed through', async (t) => {
  const f = fixture(t);
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-alpha')]);
  const refused = await runLane(['sweep', '--lane', 'memory', '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: { WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(refused.exit, 2, 'an operator-typed name is not evidence that we created that directory');
  assert.match(refused.output.error, /creates|sidecar/i);
  assert.equal(f.calls.length, 0, 'nothing reaches a delegate that deletes with -Recurse -Force');

  const g = fixture(t);
  seedCreates(g, [join(g.dir, 'projects', 'workit-wt-alpha')]);
  g.responses.push({ code: 0, stdout: 'removing ... done', stderr: '' });
  const allowed = await runLane(['sweep', '--lane', 'workit-wt-alpha', '--log', g.log], {
    exec: g.exec, exists: fakeExists(), env: { WORKIT_WORKSPACE_ROOT: g.dir },
  });
  assert.equal(allowed.exit, 0);
  assert.equal(g.calls[0].args[g.calls[0].args.indexOf('-Lane') + 1], 'workit-wt-alpha');
});

test('Q-4: sweep --lane resolves agent name, create label, and basename identically', async (t) => {
  for (const spelling of ['lane-a', 'label a', 'workit-wt-lane-a']) {
    const f = fixture(t);
    const lanePath = join(f.dir, 'projects', 'workit-wt-lane-a');
    writeFileSync(`${f.log}.state.json`, JSON.stringify({
      lanes: { 'lane-a': { path: lanePath } },
      creates: [{ path: lanePath, label: 'label a' }],
    }), 'utf8');
    f.responses.push({ code: 0, stdout: 'listing only', stderr: '' });
    const result = await runLane(['sweep', '--lane', spelling, '--list', '--root', join(f.dir, 'projects'), '--log', f.log], {
      exec: f.exec, exists: fakeExists(), env: {},
    });
    assert.equal(result.exit, 0, spelling);
    assert.deepEqual(f.calls[0].args.slice(f.calls[0].args.indexOf('-WorktreeRoot')), [
      '-WorktreeRoot', join(f.dir), '-Lane', 'workit-wt-lane-a',
    ], spelling);
  }
});

test('Q-5: unknown sweep lane refusal lists known agent names, labels, and basenames', async (t) => {
  const f = fixture(t);
  const lanePath = join(f.dir, 'projects', 'workit-wt-lane-a');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({
    lanes: { 'lane-a': { path: lanePath } },
    creates: [{ path: lanePath, label: 'label a' }],
  }), 'utf8');
  const result = await runLane(['sweep', '--lane', 'unknown', '--root', join(f.dir, 'projects'), '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: {},
  });
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /lane-a/);
  assert.match(result.output.error, /label a/);
  assert.match(result.output.error, /workit-wt-lane-a/);
  assert.match(result.output.error, /lanes\[\].*creates\[\]/);
  assert.match(result.output.error, /Agent names come from lanes\[\].*labels and basenames come from creates\[\]/);
});

test('Q-6: every C13 root spelling reaches the recorded lane in exactly two delegate levels', async (t) => {
  for (const root of [null, 'projects', 'workspace']) {
    const f = fixture(t);
    const recorded = join(f.dir, 'projects', 'workit-wt-lane-a');
    seedCreates(f, [recorded]);
    const argv = root === null ? ['sweep', '--log', f.log]
      : ['sweep', '--root', root === 'projects' ? join(f.dir, 'projects') : f.dir, '--log', f.log];
    f.responses.push({ code: 0, stdout: 'listing only', stderr: '' });
    const result = await runLane(argv, { exec: f.exec, exists: fakeExists(), env: root === null ? { WORKIT_WORKSPACE_ROOT: f.dir } : {} });
    assert.equal(result.exit, 0);
    const call = f.calls.find((entry) => entry.program === 'pwsh');
    const delegateRoot = call.args[call.args.indexOf('-WorktreeRoot') + 1];
    assert.deepEqual(relative(delegateRoot, recorded).split(/[\\/]/), ['projects', 'workit-wt-lane-a']);
  }
  const f = fixture(t);
  const filesystemRoot = resolve(sep);
  const recorded = join(filesystemRoot, 'workit-wt-lane-a');
  seedCreates(f, [recorded]);
  const refused = await runLane(['sweep', '--lane', 'workit-wt-lane-a', '--root', filesystemRoot, '--log', f.log], { exec: f.exec, exists: fakeExists(), env: {}, platform: 'win32' });
  assert.equal(refused.exit, 2);
  assert.match(refused.output.error, /delegate root|root/i);
});

test('Q-6: win32 ancestor guard folds casing from path canonicalization', async (t) => {
  const f = fixture(t);
  const recorded = join(f.dir, 'projects', 'workit-wt-lane-a');
  seedCreates(f, [recorded]);
  const casingSegment = f.dir.split(sep).at(-1);
  const resolveWithWindowsCasing = (path) => {
    const resolved = resolve(path);
    if (path === recorded) return resolved.replace(casingSegment, casingSegment.toUpperCase());
    if (path.includes(casingSegment.toUpperCase())) return resolved.replace(casingSegment.toUpperCase(), casingSegment);
    return resolved;
  };
  f.responses.push({ code: 0, stdout: 'listing only', stderr: '' });
  const result = await runLane(['sweep', '--lane', 'workit-wt-lane-a', '--root', join(f.dir, 'projects'), '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: {}, platform: 'win32', resolve: resolveWithWindowsCasing,
  });
  assert.equal(result.exit, 0);
});

test('Q-7: a lanes entry without a matching create is not sweepable', async (t) => {
  const f = fixture(t);
  const lanePath = join(f.dir, 'projects', 'workit-wt-uncreated');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ lanes: { uncreated: { path: lanePath } }, creates: [] }), 'utf8');
  const result = await runLane(['sweep', '--lane', 'uncreated', '--root', join(f.dir, 'projects'), '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: {},
  });
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /creates|sidecar/i);
  assert.equal(f.calls.length, 0);
});

test('Q-8: a missing delegate command names the same WorktreeRoot as execution would use', async (t) => {
  const f = fixture(t);
  const lanePath = join(f.dir, 'projects', 'workit-wt-lane-a');
  seedCreates(f, [lanePath]);
  const result = await runLane(['sweep', '--root', join(f.dir, 'projects'), '--log', f.log], {
    exec: f.exec, exists: fakeExists((path) => !path.endsWith('herdr-lanes.ps1')), env: {},
  });
  assert.equal(result.exit, 1);
  const commandRoot = result.output.commands[0].match(/-WorktreeRoot "([^"]+)"/)[1];
  assert.equal(commandRoot, dirname(dirname(lanePath)));
});

test('A4-1: the sidecar check covers the herdr root too, not just the workspace root', async (t) => {
  // A3-7 never set USERPROFILE, so it only ever exercised the checked branch.
  // With only the herdr root present — the common shape on this box, since
  // WORKIT_WORKSPACE_ROOT is usually unset — `--lane` reached the delegate
  // unchecked, and `--force` is allowed on a lane root.
  const f = fixture(t);
  seedCreates(f, [join(f.dir, 'profile', '.herdr', 'worktrees', 'workit', 'mine')]);
  const herdrOnly = await runLane(['sweep', '--lane', 'memory', '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: { USERPROFILE: join(f.dir, 'profile') },
  });
  assert.equal(herdrOnly.exit, 2, 'the herdr root is not a licence to delete a name we never created');
  assert.match(herdrOnly.output.error, /creates|sidecar/i);
  assert.equal(f.calls.length, 0);

  // Both roots present: the refusal must come from the check, not from which
  // root happened to be iterated first.
  const g = fixture(t);
  seedCreates(g, [join(g.dir, 'projects', 'workit-wt-alpha')]);
  const bothRoots = await runLane(['sweep', '--lane', 'memory', '--force', '--log', g.log], {
    exec: g.exec,
    exists: fakeExists(),
    env: { USERPROFILE: join(g.dir, 'profile'), WORKIT_WORKSPACE_ROOT: g.dir },
  });
  assert.equal(bothRoots.exit, 2);
  assert.equal(g.calls.length, 0, 'no delegate call on either root');

  // A lane the sidecar knows is still swept, on whichever root holds it.
  const h = fixture(t);
  seedCreates(h, [join(h.dir, 'profile', '.herdr', 'worktrees', 'workit', 'mine')]);
  h.responses.push({ code: 0, stdout: 'removing mine ... done', stderr: '' });
  const known = await runLane(['sweep', '--lane', 'mine', '--log', h.log], {
    exec: h.exec, exists: fakeExists(), env: { USERPROFILE: join(h.dir, 'profile') },
  });
  assert.equal(known.exit, 0);
  assert.equal(h.calls[0].args[h.calls[0].args.indexOf('-Lane') + 1], 'mine');
});

test('A4-2: --lane matching follows the filesystem\'s casing rules', async (t) => {
  const f = fixture(t);
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-Alpha')]);
  f.responses.push({ code: 0, stdout: 'removing ... done', stderr: '' });
  const windows = await runLane(['sweep', '--lane', 'workit-wt-alpha', '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: { WORKIT_WORKSPACE_ROOT: f.dir }, platform: 'win32',
  });
  assert.equal(windows.exit, 0, 'Windows paths are case-insensitive; a casing mismatch is not a different lane');
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-Lane') + 1], 'workit-wt-Alpha',
    'the delegate gets the sidecar\'s spelling, not the operator\'s');

  const g = fixture(t);
  seedCreates(g, [join(g.dir, 'projects', 'workit-wt-Alpha')]);
  const posix = await runLane(['sweep', '--lane', 'workit-wt-alpha', '--log', g.log], {
    exec: g.exec, exists: fakeExists(), env: { WORKIT_WORKSPACE_ROOT: g.dir }, platform: 'linux',
  });
  assert.equal(posix.exit, 2, 'elsewhere those are two different directories');
  assert.equal(g.calls.length, 0);
});

test('A3-8 / R3-M1: --expect-pr refuses without a lane path, and reads gh failures precisely', async (t) => {
  const f = fixture(t);
  seedLane(f, { path: null });
  const noPath = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', f.log], { exec: f.exec });
  assert.equal(noPath.exit, 1, 'with no cwd, gh answers about whatever repo the conductor is sitting in');
  assert.equal(f.calls.length, 0);
  assert.match(noPath.output.error, /path/i);

  const g = fixture(t);
  seedLane(g);
  for (const [stderr, expected, why] of [
    ['gh: command not found', 1, 'a missing gh is infrastructure'],
    ['repository not found', 1, 'a missing REPO is not a missing PR'],
    ['GraphQL: Could not resolve to a PullRequest with the number of 42.', 5, 'no such PR is a verdict'],
    ['no pull requests found for branch "feat/lane-a"', 5, 'no such PR is a verdict'],
  ]) {
    g.responses.push({ code: 1, stdout: '', stderr });
    const result = await runLane(['check', 'lane-a', '--expect-pr', '42', '--log', g.log], { exec: g.exec });
    assert.equal(result.exit, expected, `${why}: ${stderr}`);
  }
});

test('A3-9 / R3-U2: a sweep whose delegate is missing exits nonzero and still prints the command', async (t) => {
  const f = fixture(t);
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-alpha')]);
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec,
    exists: fakeExists((path) => !path.endsWith('herdr-lanes.ps1')),
    env: { WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(result.exit, 1, 'the exit code is the machine-readable half of the contract');
  assert.equal(f.calls.length, 0);
  assert.match(result.output.commands[0], /herdr-lanes\.ps1/, 'and the runnable command is still there');
});

test('A3-10 / R3-M2: a bare wait sends no --until, and the poll timeout is the pacing', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' },
    { code: 0, stdout: 'finished', stderr: '' },
  );
  await runLane(['wait', 'lane-a', '--timeout', '5000', '--log', f.log], { exec: f.exec });
  // herdr's own default already matches idle|done|blocked, so the bare shape
  // forwards nothing — and the per-poll timeout is what paces production.
  assert.equal(f.calls[0].args.includes('--until'), false);
  assert.deepEqual(f.calls[0].args, ['agent', 'wait', 'lane-a', '--timeout', '1000']);
});

test('A3-11 / R3-U4: the plan meter unwraps the herdr envelope before reading the last footer line', () => {
  const enveloped = JSON.stringify({
    id: 'cli:agent:read',
    result: { text: 'old 5h 80% left · weekly 90% left\nnew 5h 9% left · weekly 40% left' },
  });
  assert.deepEqual(scrapePlanMeter(enveloped), { plan5h: 9, planWeekly: 40 },
    'an enveloped response collapses to one line, turning "last footer line" into "first match"');
});

test('A3-12 / R3-U6: herdr\'s structured error code decides a timeout, not a substring', async (t) => {
  const f = fixture(t);
  seedLane(f);
  let clock = 0;
  f.responses.push(
    // A real herdr timeout envelope, and a genuine failure whose text merely
    // mentions the word.
    () => { clock = 10; return { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"},"id":"cli:agent:wait"}' }; },
    { code: 0, stdout: 'still working', stderr: '' },
  );
  const timedOut = await runLane(['wait', 'lane-a', '--timeout', '5', '--log', f.log], { exec: f.exec, now: () => clock });
  assert.equal(timedOut.exit, 4);

  const g = fixture(t);
  seedLane(g);
  g.responses.push({ code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found","message":"no agent; the timeout setting is irrelevant"}}' });
  const failed = await runLane(['wait', 'lane-a', '--timeout', '5000', '--log', g.log], { exec: g.exec, sleep: async () => {} });
  assert.equal(failed.exit, 1, 'a failure that merely says "timeout" is not a timeout');
});

test('A3-13 / R3-U7: resume reports a plan refusal the same way wait does', async (t) => {
  const f = fixture(t);
  seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"idle"}}', stderr: '' },
    { code: 0, stdout: "■ You've hit your usage limit. Try again at 11:42 PM.\ngpt-5.6-terra high · Context 62% left · 5h 0% left · weekly 91% left", stderr: '' },
  );
  const result = await runLane(['resume', 'lane-a', '--timeout', '1000', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 6, 'the modal is up whether the operator resumed or waited');
  assert.equal(result.output.state, 'plan-refused');
});

test('A3-14 / R3-U9: sweep --list is a dry run and never asks the delegate to clean', async (t) => {
  const f = fixture(t);
  seedCreates(f, [join(f.dir, 'projects', 'workit-wt-alpha')]);
  f.responses.push({ code: 0, stdout: 'listing only', stderr: '' });
  const result = await runLane(['sweep', '--list', '--log', f.log], {
    exec: f.exec, exists: fakeExists(), env: { WORKIT_WORKSPACE_ROOT: f.dir },
  });
  assert.equal(result.exit, 0);
  assert.equal(f.calls[0].args.includes('-Clean'), false);
  assert.equal(f.calls[0].args.includes('-Force'), false);
});

test('A2-13 / U1: the harness verifies the stimulus fired, and S1 needs a real dialog', () => {
  // "Verify the instrument fired before trusting a null result" — a lane that
  // never received the prompt proves nothing about blocking, either way.
  assert.equal(stimulusFired('❯ Read X:\\fixture\\prompt.md and execute it exactly.'), true);
  assert.equal(stimulusFired('● Write(.lane-smoke-marker)'), true);
  assert.equal(stimulusFired('▐▛███▛█   Claude Code v2.1.258\n❯'), false, 'a bare startup banner is not the stimulus');
  assert.equal(stimulusFired(''), false);

  // S1 without a visible approval dialog is exit 3 and nothing else.
  assert.equal(s1Verdict(3, 'blocked', 'Do you want to create .lane-smoke-marker?').ok, true);
  const noDialog = s1Verdict(3, 'blocked', '   ');
  assert.equal(noDialog.ok, false);
  assert.match(noDialog.message, /dialog/i);
  assert.equal(s1Verdict(0, 'done', '').ok, false);
  assert.equal(s1Verdict(4, 'timeout', '').ok, false);
});

test('c952d41e DO 1 and 10: Codex MCP timeout is opt-in, paired, validated, caller-overridable, and refuses workspace-write only on win32', async (t) => {
  const start = async (agentArgs = [], platform = 'win32', helperArgs = [], kind = 'codex') => {
    const f = fixture(t);
    f.responses.push(
      SHELL_READ, { code: 0, stdout: 'X:\\fixture\\npm', stderr: '' }, { code: 0, stdout: '{}', stderr: '' },
      { code: 0, stdout: 'X:\\fixture\\vendor\\bin\\codex.exe\nPS X:\\fixture\\lane>', stderr: '' },
      { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
      { code: 0, stdout: 'no dialog', stderr: '' }, { code: 0, stdout: '{}', stderr: '' },
      { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
    );
    const result = await runLane(['start', 'lane-c', '--pane', 'w1:p2', '--kind', kind, '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'danger-full-access', '--log', f.log, ...helperArgs, '--', ...agentArgs], {
      exec: f.exec, platform, env: { HERDR_PANE_ID: 'w1:p1' }, findCodexBin: () => 'X:\\fixture\\vendor\\bin', sleep: async () => {},
    });
    return { f, result };
  };
  const bare = await start();
  assert.equal(agentStartCall(bare.f).args.some((arg) => String(arg).includes('startup_timeout_sec')), false);
  assert.equal('mcpStartupTimeoutSec' in bare.result.output, false);
  assert.equal('mcpStartupTimeoutSec' in bare.result.row, false);
  const optedIn = await start([], 'win32', ['--mcp-startup-timeout', '5', '--mcp-startup-server', 'observatory']);
  assert.equal(agentStartCall(optedIn.f).args.filter((arg) => arg === 'mcp_servers.observatory.startup_timeout_sec=5').length, 1);
  assert.deepEqual(optedIn.result.row.mcpStartupTimeoutSec, { server: 'observatory', seconds: 5 });
  const lone = await start([], 'win32', ['--mcp-startup-timeout', '5']);
  assert.equal(lone.result.exit, 2);
  assert.match(lone.result.output.error, /--mcp-startup-server/);
  const loneServer = await start([], 'win32', ['--mcp-startup-server', 'observatory']);
  assert.equal(loneServer.result.exit, 2);
  assert.match(loneServer.result.output.error, /--mcp-startup-timeout/);
  const emptyServer = await start([], 'win32', ['--mcp-startup-timeout', '5', '--mcp-startup-server', '']);
  assert.equal(emptyServer.result.exit, 2);
  assert.match(emptyServer.result.output.error, /bare MCP server name/);
  const dottedServer = await start([], 'win32', ['--mcp-startup-timeout', '5', '--mcp-startup-server', 'a.b']);
  assert.equal(dottedServer.result.exit, 2);
  assert.match(dottedServer.result.output.error, /bare MCP server name/);
  const claudePair = await start([], 'win32', ['--mcp-startup-timeout', '5', '--mcp-startup-server', 'observatory'], 'claude');
  assert.equal(claudePair.result.exit, 2);
  assert.match(claudePair.result.output.error, /codex/);
  const supplied = await start(['-c', 'mcp_servers.other.startup_timeout_sec=9'], 'win32', ['--mcp-startup-timeout', '5', '--mcp-startup-server', 'observatory']);
  assert.equal(agentStartCall(supplied.f).args.filter((arg) => String(arg).includes('startup_timeout_sec')).length, 1);
  assert.equal(agentStartCall(supplied.f).args.includes('mcp_servers.other.startup_timeout_sec=9'), true);
  assert.equal('mcpStartupTimeoutSec' in supplied.result.row, false);
  assert.match(supplied.result.output.warning, /ignored.*--mcp-startup-timeout.*--mcp-startup-server/);
  const refused = await runLane(['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'workspace-write', '--log', supplied.f.log], { exec: supplied.f.exec, platform: 'win32' });
  assert.equal(refused.exit, 2);
  assert.match(refused.output.error, /danger-full-access/);
});

test('c952d41e DO 2-4: a start lock wait is recorded and busy starts split once while retaining create identity', async (t) => {
  const f = fixture(t);
  const lanePath = join(f.dir, 'projects', 'workit-wt-lane');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({
    creates: [{ paneId: 'w1:p2', path: lanePath, branch: 'feat/lane', base: 'main' }],
    lanes: { 'lane-a': { path: lanePath } },
  }), 'utf8');
  let clock = 0;
  let first = true;
  f.responses.push(
    SHELL_READ,
    { code: 1, stdout: '', stderr: 'agent_pane_busy: agent target pane w1:p2 is not an available shell' },
    { code: 0, stdout: '{"result":{"pane_id":"w1:p3"}}', stderr: '' },
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low', '--log', f.log], {
    exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, now: () => clock, sleep: async () => { clock += 20; },
    writeNew: (path, value) => { if (first && path.endsWith('.start.lock')) { first = false; const error = new Error('held'); error.code = 'EEXIST'; throw error; } writeFileSync(path, value, { flag: 'wx' }); },
  });
  assert.equal(result.exit, 0);
  assert.ok(result.row.waitedForStartLockMs > 0);
  assert.ok(f.calls.some((call) => call.args[0] === 'pane' && call.args[1] === 'split'));
  const saved = readState(f).lanes['lane-a'];
  assert.deepEqual([saved.pane, saved.paneSplitFrom, saved.branch, saved.base, saved.path], ['w1:p3', 'w1:p2', 'feat/lane', 'main', lanePath]);
});

test('c952d41e DO 5 and 9: working prompts queue directly; a retained composer is retried then fails', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'prompt.md'); writeFileSync(prompt, 'task', 'utf8'); seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"working"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const queued = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], { exec: f.exec });
  assert.equal(queued.output.queued, true);
  assert.equal(f.calls[1].args.includes('--wait'), false, 'mutation control: restoring unconditional --wait fails this assertion');

  const g = fixture(t); writeFileSync(prompt, 'task', 'utf8'); seedLane(g, { promptFile: prompt });
  const composer = `› Read ${resolve(prompt)} and execute it exactly.`;
  g.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 1, stdout: '', stderr: '{"error":{"code":"agent_prompt_stalled"}}' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: composer, stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: composer, stderr: '' },
  );
  const failed = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', g.log], { exec: g.exec });
  assert.equal(failed.exit, 1);
  assert.match(failed.output.error, /composer not submitted/);
  assert.equal(g.calls.filter((call) => call.args[1] === 'send-keys').length, 2, 'stalled wait and retained composer each retry Enter once');
});

test('c952d41e DO 8: a hooks-trust dialog sends t then esc and is logged', async (t) => {
  const f = fixture(t);
  f.responses.push(
    SHELL_READ, { code: 0, stdout: 'X:\\fixture\\npm', stderr: '' }, { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: 'X:\\fixture\\vendor\\bin\\codex.exe\nPS X:\\fixture\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
    { code: 0, stdout: '2 hooks need review before they can run\nPress t to trust', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: 'clear', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--reasoning', 'medium', '--sandbox', 'danger-full-access', '--log', f.log], {
    exec: f.exec, platform: 'win32', env: { HERDR_PANE_ID: 'w1:p1' }, findCodexBin: () => 'X:\\fixture\\vendor\\bin', sleep: async () => {},
  });
  assert.equal(result.row.hooksTrusted, true);
  assert.deepEqual(f.calls.filter((call) => call.args[1] === 'send-keys').map((call) => call.args[3]), ['t', 'esc']);
});

test('c952d41e DO 11: plan refusal requires a Codex banner or numbered modal plus low meter or settled state', async (t) => {
  const compiler = fixture(t); seedLane(compiler); let clock = 0;
  compiler.responses.push(
    { code: 0, stdout: '{"result":{"state":"working"}}', stderr: '' },
    { code: 0, stdout: 'src/mcp/review-council/seat-fallback.ts(78,26): error TS2367: This comparison appears to be unintentional because the types \"usage limit\" | \"hit your usage limit\" | \"rate limit\" | \"Approaching rate limits\" and \"CODEX_SILENT_STREAM_ERROR\" have no overlap.\ngpt-5.6-terra high · 5h 81% left · weekly 91% left', stderr: '' },
  );
  const falsePositive = await runLane(['wait', 'lane-a', '--timeout', '1', '--log', compiler.log], { exec: compiler.exec, now: () => (clock += 10), sleep: async () => {} });
  assert.equal(falsePositive.exit, 4);

  const sourceLine = fixture(t); seedLane(sourceLine); let sourceClock = 0;
  sourceLine.responses.push(
    { code: 0, stdout: '{"result":{"state":"working"}}', stderr: '' },
    { code: 0, stdout: 'export const PLAN_REFUSAL_PATTERNS = Object.freeze([/hit your usage limit/i]);\ngpt-5.6-terra high · 5h 77% left · weekly 91% left', stderr: '' },
  );
  const ownSource = await runLane(['wait', 'lane-a', '--timeout', '1', '--log', sourceLine.log], { exec: sourceLine.exec, now: () => (sourceClock += 10), sleep: async () => {} });
  assert.equal(ownSource.exit, 4, 'a visible regex literal in helper source is not a refusal');

  const refused = fixture(t); seedLane(refused);
  refused.responses.push(
    { code: 0, stdout: '{"result":{"state":"working"}}', stderr: '' },
    { code: 0, stdout: "■ You've hit your usage limit. Try again later.\nApproaching rate limits — Switch to gpt-5.6-luna for lower credit usage?\n  › 1. Switch  2. Keep current model\ngpt-5.6-terra high · Context 62% left · 5h 0% left · weekly 91% left", stderr: '' },
  );
  const real = await runLane(['wait', 'lane-a', '--timeout', '1000', '--log', refused.log], { exec: refused.exec, sleep: async () => {} });
  assert.equal(real.exit, 6);
  assert.equal(real.row.refusalShape, 'banner');
});

test('c952d41e DO 6-8: late stop succeeds, hooks trust is dismissed, and sweep flags an unnamed shell ghost', async (t) => {
  const stopped = fixture(t); seedLane(stopped, { promptSignature: 'PS X:\\fixture\\lane>' }); let clock = 0;
  stopped.responses.push(
    { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: 'still exiting', stderr: '' }, { code: 0, stdout: 'Codex exited\nPS X:\\fixture\\lane>', stderr: '' }, { code: 0, stdout: '{"result":{"agents":[]}}', stderr: '' },
  );
  const late = await runLane(['stop', 'lane-a', '--timeout', '1', '--log', stopped.log], { exec: stopped.exec, now: () => clock, sleep: async () => { clock += 10; } });
  assert.equal(late.output.promptCheck, 'late');

  const sweep = fixture(t); const root = join(sweep.dir, '.herdr', 'worktrees'); const lanePath = join(root, 'repo', 'lane-a');
  writeFileSync(`${sweep.log}.state.json`, JSON.stringify({
    creates: [{ path: lanePath, label: 'lane-a', paneId: 'w1:p9' }],
    lanes: { 'lane-a': { pane: 'w1:p9', path: lanePath, promptSignature: 'PS X:\\fixture\\lane>' } },
  }), 'utf8');
  sweep.responses.push({ code: 0, stdout: 'HOLD lane', stderr: '' }, { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p9","state":"idle"}]}}', stderr: '' }, { code: 0, stdout: 'PS X:\\fixture\\lane>', stderr: '' });
  const held = await runLane(['sweep', '--root', root, '--log', sweep.log], { exec: sweep.exec, exists: fakeExists() });
  assert.deepEqual(held.output.holds[0], { pane: 'w1:p9', agent: '<unnamed>', state: 'idle', ghost: true, message: 'HOLD on w1:p9 by <unnamed> (ghost: true); remove by hand with herdr workspace close <ws> then git worktree remove' });
});

test('amend 1 P1 and P4c/P4d: footer composer is retried; banner fires while modal without corroboration times out', async (t) => {
  const p = fixture(t); const file = join(p.dir, 'prompt.md'); writeFileSync(file, 'task'); seedLane(p);
  const wire = `› Read ${resolve(file)} and execute it exactly.`;
  p.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true,"state":"done"}}', stderr: '' },
    { code: 0, stdout: `${wire}\ngpt-5.6-terra high · Context 62% left`, stderr: '' },
    { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"working"}]}}', stderr: '' },
    { code: 0, stdout: 'working', stderr: '' },
  );
  const composer = await runLane(['prompt', 'lane-a', '--file', file, '--log', p.log], { exec: p.exec });
  assert.equal(composer.output.enterRetries, 1);

  const banner = fixture(t); seedLane(banner);
  banner.responses.push({ code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' }, { code: 0, stdout: "■ You've hit your usage limit\ngpt-5.6-terra high · Context 62% left · 5h 74% left · weekly 0% left", stderr: '' });
  const p4c = await runLane(['wait', 'lane-a', '--until', 'done', '--timeout', '1000', '--log', banner.log], { exec: banner.exec, sleep: async () => {} });
  assert.equal(p4c.exit, 6); assert.equal(p4c.row.refusalShape, 'banner');

  const modal = fixture(t); seedLane(modal); let clock = 0;
  modal.responses.push({ code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' }, { code: 0, stdout: 'Approaching rate limits — Switch to gpt-5.6-luna\n  1. Switch', stderr: '' });
  const p4d = await runLane(['wait', 'lane-a', '--timeout', '1', '--log', modal.log], { exec: modal.exec, now: () => (clock += 10), sleep: async () => {} });
  assert.equal(p4d.exit, 4, 'modal-only is a corroborated pre-limit nudge, not a refusal');
});

test('amend 1 P5/P6: unread disappeared agent succeeds; live TUI and still-listed late paths fail', async (t) => {
  const unread = fixture(t); seedLane(unread, { promptSignature: 'PS X:\\fixture\\lane>' }); let clock = 0;
  unread.responses.push({ code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: 'not prompt', stderr: '' }, { code: 1, stdout: '', stderr: 'read failed' }, { code: 0, stdout: '{"result":{"agents":[]}}', stderr: '' });
  const p5 = await runLane(['stop', 'lane-a', '--timeout', '1', '--log', unread.log], { exec: unread.exec, now: () => (clock += 10), sleep: async () => {}, warn: () => {} });
  assert.equal(p5.output.promptCheck, 'unread');

  const live = fixture(t); seedLane(live, { promptSignature: 'PS X:\\fixture\\lane>' }); clock = 0;
  live.responses.push({ code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: 'not prompt', stderr: '' }, { code: 0, stdout: 'PS X:\\fixture\\src>\n| Ask Codex to do anything |\ngpt-5.6-terra high · Context 62% left', stderr: '' }, { code: 0, stdout: '{"result":{"agents":[]}}', stderr: '' });
  const p6 = await runLane(['stop', 'lane-a', '--timeout', '1', '--log', live.log], { exec: live.exec, now: () => (clock += 10), sleep: async () => {} });
  assert.equal(p6.exit, 1);
});

test('amend 1 P2: timeout on the pane\'s own oh-my-posh signature splits and records paneSplitFrom', async (t) => {
  const f = fixture(t);
  const prompt = '~  home / .herdr / worktrees / repo/slug ~';
  f.responses.push(
    { code: 0, stdout: prompt, stderr: '' },
    { code: 1, stdout: '', stderr: '{"error":{"code":"timeout"}}' },
    { code: 0, stdout: prompt, stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"pane_id":"w1:p3"}}', stderr: '' },
    { code: 0, stdout: prompt, stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low', '--log', f.log], { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, sleep: async () => {} });
  assert.equal(result.exit, 0);
  assert.ok(f.calls.some((call) => call.args[0] === 'pane' && call.args[1] === 'split'));
  assert.equal(readState(f).lanes['lane-a'].paneSplitFrom, 'w1:p2');
});

test('amend 2 P3: an unnamed idle HOLD on the recorded oh-my-posh signature is a ghost without a regex', async (t) => {
  const f = fixture(t);
  const root = join(f.dir, '.herdr', 'worktrees');
  const lanePath = join(root, 'repo', 'slug');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({
    creates: [{ path: lanePath, label: 'slug', paneId: 'w1:p9' }],
    lanes: { 'lane-a': { pane: 'w1:p9', path: lanePath, promptSignature: '~  home / .herdr / worktrees / repo/slug ~' } },
  }), 'utf8');
  f.responses.push(
    { code: 0, stdout: 'HOLD lane', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p9","state":"idle"}]}}', stderr: '' },
    { code: 0, stdout: '~  home / .herdr / worktrees / repo/slug ~', stderr: '' },
  );
  const result = await runLane(['sweep', '--root', root, '--log', f.log], { exec: f.exec, exists: fakeExists() });
  assert.equal(result.output.holds[0].ghost, true);
});

test('amend 1 P7: an untouched start lock beyond the 120-second window is reclaimed', async (t) => {
  const f = fixture(t);
  writeFileSync(`${f.log}.start.lock`, '{"lane":"lane-slow","startedAt":"old"}\n', 'utf8');
  const warnings = [];
  f.responses.push(
    SHELL_READ,
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low', '--log', f.log], {
    exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, now: () => 130_000, stat: () => ({ mtimeMs: 0 }), warn: (message) => warnings.push(message), sleep: async () => {},
  });
  assert.equal(result.exit, 0);
  assert.match(warnings.join('\n'), /stale lock/i);
});

test('amend 2 X2: only a dirty column-zero composer directly above the live footer is cleared', async (t) => {
  const quoted = fixture(t); const prompt = join(quoted.dir, 'prompt.md'); writeFileSync(prompt, 'task', 'utf8'); seedLane(quoted);
  quoted.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"working"}]}}', stderr: '' },
    { code: 0, stdout: 'thinking about the plan\n    › quoting the operator brief here\n› Ask Codex to do anything\nesc to interrupt · Context 62% left', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true}}', stderr: '' },
  );
  const x2 = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', quoted.log], { exec: quoted.exec });
  assert.equal(x2.output.composerCleared, false);
  assert.equal(quoted.calls.filter((call) => call.args[1] === 'send-keys' && call.args[3] === 'esc').length, 0);

  const dirty = fixture(t); seedLane(dirty);
  dirty.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"working"}]}}', stderr: '' },
    { code: 0, stdout: 'thinking about the plan\n› half-typed text\nesc to interrupt · Context 62% left', stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 0, stdout: '› Ask Codex to do anything\nesc to interrupt · Context 62% left', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true}}', stderr: '' },
  );
  const cleared = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', dirty.log], { exec: dirty.exec });
  assert.equal(cleared.output.composerCleared, true);
  assert.equal(dirty.calls.filter((call) => call.args[1] === 'send-keys' && call.args[3] === 'esc').length, 1);
});

test('amend 2: a prompt error whose text says timeout does not authorize Enter', async (t) => {
  const f = fixture(t); const prompt = join(f.dir, 'prompt.md'); writeFileSync(prompt, 'task', 'utf8'); seedLane(f);
  f.responses.push(
    { code: 0, stdout: '{"result":{"agents":[{"name":"lane-a","state":"done"}]}}', stderr: '' },
    { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found","message":"timeout mentioned here"}}' },
  );
  const result = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 1);
  assert.equal(f.calls.some((call) => call.args[1] === 'send-keys' && call.args[3] === 'enter'), false);
});

test('amend 2: a column-zero banner in prose needs a live TUI footer', async (t) => {
  const f = fixture(t); seedLane(f); let clock = 0;
  f.responses.push(
    { code: 0, stdout: '{"result":{"state":"working"}}', stderr: '' },
    { code: 0, stdout: "■ You've hit your usage limit. Try again later.\ngpt-5.6-terra high · 5h 81% left · weekly 91% left", stderr: '' },
  );
  const result = await runLane(['wait', 'lane-a', '--timeout', '1', '--log', f.log], { exec: f.exec, now: () => (clock += 10), sleep: async () => {} });
  assert.equal(result.exit, 4);
});

test('amend 2: sweep scopes HOLDs to known panes and surfaces split-failure candidates', async (t) => {
  const f = fixture(t); const root = join(f.dir, '.herdr', 'worktrees');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({
    creates: [],
    lanes: {},
    ghostCandidates: [{ pane: 'w1:p2', reason: 'pane split fallback failed', at: '2026-09-04T00:00:00.000Z' }],
  }), 'utf8');
  f.responses.push(
    { code: 0, stdout: 'HOLD lane', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p9","name":"other","state":"working"},{"pane_id":"w1:p8","name":"other-two","state":"idle"}]}}', stderr: '' },
  );
  const result = await runLane(['sweep', '--root', root, '--log', f.log], { exec: f.exec, exists: fakeExists() });
  assert.deepEqual(result.output.holds, [{ pane: 'w1:p2', message: 'HOLD candidate (split failed at 2026-09-04T00:00:00.000Z)' }]);
});

test('amend 2 P7b: a holder refreshed during a 90-second wait is never reclaimed', async (t) => {
  const f = fixture(t); let now = 0; let lock = null; let holderSleep; let holderReleased = false; let paneReads = 0; let refreshed = false; const warnings = [];
  const startArgs = (name) => ['start', name, '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low', '--log', f.log];
  const exec = (program, args) => {
    if (args[0] === 'pane' && args[1] === 'read') return ++paneReads === 1 ? { code: 0, stdout: '', stderr: '' } : SHELL_READ;
    return { code: 0, stdout: '{"result":{}}', stderr: '' };
  };
  const common = {
    exec, env: { HERDR_PANE_ID: 'w1:p1' }, now: () => now, timestamp: () => '2026-09-04T00:00:00.000Z',
    warn: (message) => { warnings.push(message); if (/stale lock/i.test(message) && holderSleep) holderSleep(); },
    writeNew: (path, value) => { if (!path.endsWith('.start.lock')) return writeFileSync(path, value, { flag: 'wx' }); if (lock !== null) { const error = new Error('held'); error.code = 'EEXIST'; throw error; } lock = value; },
    read: (path) => path.endsWith('.start.lock') ? lock : readFileSync(path, 'utf8'),
    remove: (path) => { if (path.endsWith('.start.lock')) lock = null; else rmSync(path, { force: true }); },
    stat: () => ({ mtimeMs: refreshed ? Math.min(80_000, Math.floor(now / 20_000) * 20_000) : -90_000 }),
    touch: () => { refreshed = true; },
    sleep: async (ms) => {
      if (!holderSleep) return new Promise((resolveSleep) => { holderSleep = resolveSleep; });
      now += ms;
      if (now >= 90_000 && !holderReleased) { holderReleased = true; holderSleep(); }
    },
  };
  const holder = runLane(startArgs('lane-holder'), common);
  await Promise.resolve();
  const waiter = await runLane(startArgs('lane-waiter'), common);
  await holder;
  assert.equal(waiter.exit, 0);
  assert.ok(now >= 90_000);
  assert.equal(warnings.some((message) => /stale lock/i.test(message)), false);
});

test('amend 2 P7c: a reclaimed lock survives the original holder release', async (t) => {
  const f = fixture(t); let now = 0; let lock = null; let paneReads = 0; const sleeps = [];
  const startArgs = (name) => ['start', name, '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--reasoning', 'low', '--log', f.log];
  const exec = (program, args) => {
    if (args[0] === 'pane' && args[1] === 'read') return ++paneReads <= 2 ? { code: 0, stdout: '', stderr: '' } : SHELL_READ;
    if (args[0] === 'agent' && args[1] === 'start') return { code: 1, stdout: '', stderr: 'start failed' };
    return { code: 0, stdout: '{"result":{}}', stderr: '' };
  };
  const common = {
    exec, env: { HERDR_PANE_ID: 'w1:p1' }, now: () => now, timestamp: () => '2026-09-04T00:00:00.000Z',
    writeNew: (path, value) => { if (!path.endsWith('.start.lock')) return writeFileSync(path, value, { flag: 'wx' }); if (lock !== null) { const error = new Error('held'); error.code = 'EEXIST'; throw error; } lock = value; },
    read: (path) => path.endsWith('.start.lock') ? lock : readFileSync(path, 'utf8'),
    remove: (path) => { if (path.endsWith('.start.lock')) lock = null; else rmSync(path, { force: true }); },
    stat: () => ({ mtimeMs: 0 }), touch: () => {}, sleep: () => new Promise((resolveSleep) => sleeps.push(resolveSleep)),
  };
  const holder = runLane(startArgs('lane-holder'), common);
  await Promise.resolve();
  now = 400_000;
  const reclaimer = runLane(startArgs('lane-reclaimer'), common);
  await Promise.resolve();
  sleeps.shift()();
  const holderResult = await holder;
  const afterHolderRelease = lock;
  assert.equal(holderResult.exit, 1);
  assert.match(afterHolderRelease, /lane-reclaimer/);
  sleeps.shift()();
  const reclaimerResult = await reclaimer;
  assert.equal(reclaimerResult.exit, 1);
  assert.equal(lock, null);
});
