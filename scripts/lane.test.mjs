import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EXIT_CODES, PLAN_REFUSAL_PATTERNS, runLane, scrapePlanMeter } from './lane.mjs';

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
  return { dir, log: join(dir, 'lane-log.jsonl'), calls, responses, exec };
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
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--log', f.log, '--', '--permission-mode', 'dontAsk'],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /dontAsk/);
  assert.equal(f.calls.length, 0);
});

test('WP-1: read-only codex sandbox is refused before herdr is invoked', async (t) => {
  const f = fixture(t);
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--sandbox', 'read-only', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /read-only/);
  assert.equal(f.calls.length, 0);
});

test('WP-1: claude start supplies the mandatory mode and restores conductor focus', async (t) => {
  const f = fixture(t);
  f.responses.push(
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a","state":"idle"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{"focused":true}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"name":"conductor","pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-a', '--pane', 'w1:p2', '--kind', 'claude', '--model', 'opus', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' } },
  );
  assert.equal(result.exit, 0);
  assert.deepEqual(f.calls[0].args, ['agent', 'start', 'lane-a', '--kind', 'claude', '--pane', 'w1:p2', '--', '--model', 'opus', '--permission-mode', 'bypassPermissions']);
  assert.deepEqual(f.calls[1].args, ['agent', 'focus', 'w1:p1']);
  assert.deepEqual(f.calls[2].args, ['agent', 'list']);
});

test('WP-1: prompt sends only the absolute prompt-file instruction', async (t) => {
  const f = fixture(t);
  const prompt = join(f.dir, 'task prompt.md');
  writeFileSync(prompt, 'shell-active `content`; must never be argv', 'utf8');
  f.responses.push({ code: 0, stdout: '{"result":{"state":"working","accepted":true}}', stderr: '' });
  const result = await runLane(['prompt', 'lane-a', '--file', prompt, '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0);
  assert.deepEqual(f.calls[0].args, ['agent', 'prompt', 'lane-a', `Read ${resolve(prompt)} and execute it exactly.`, '--wait', '--until', 'working']);
  assert.doesNotMatch(f.calls[0].args.join(' '), /shell-active/);
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
    ['create', '--repo', 'D:\\Development\\projects\\workit', '--branch', 'feat/existing', '--base', 'main', '--label', 'lane', '--log', f.log],
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
  const repo = join(f.dir, 'projects', 'workit');
  f.responses.push({ code: 1, stdout: '', stderr: '' });
  const result = await runLane(
    ['create', '--repo', repo, '--branch', 'feat/x', '--base', 'main', '--label', 'lane-x', '--path', f.dir, '--log', f.log],
    { exec: f.exec },
  );
  assert.equal(result.exit, 2);
  assert.match(result.output.error, /already exists/);
  assert.equal(f.calls.filter((call) => call.program === 'herdr').length, 0);
});

test('WP-1: codex start waits for codex.exe and a returned prompt before agent start', async (t) => {
  const f = fixture(t);
  f.responses.push(
    { code: 0, stdout: 'C:\\npm', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: 'PS C:\\lane> $env:PATH = "C:\\vendor\\bin;" + $env:PATH; (Get-Command codex).Source', stderr: '' },
    { code: 0, stdout: 'C:\\vendor\\bin\\codex.exe\nPS C:\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-c"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
  );
  const result = await runLane(
    ['start', 'lane-c', '--pane', 'w1:p2', '--kind', 'codex', '--model', 'gpt-5.6-terra', '--sandbox', 'workspace-write', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, findCodexBin: () => 'C:\\vendor\\bin', sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  assert.equal(f.calls[0].program, 'cmd.exe');
  assert.deepEqual(f.calls[0].args, ['/d', '/s', '/c', 'npm root -g']);
  const startIndex = f.calls.findIndex((call) => call.program === 'herdr' && call.args[0] === 'agent' && call.args[1] === 'start');
  const readsBeforeStart = f.calls.slice(0, startIndex).filter((call) => call.args[0] === 'pane' && call.args[1] === 'read');
  assert.equal(readsBeforeStart.length, 2);
  assert.deepEqual(f.calls[startIndex].args.slice(-6), ['--model', 'gpt-5.6-terra', '--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
});

test('WP-1: every attempted verb appends the complete JSONL instrumentation shape', async (t) => {
  const f = fixture(t);
  await runLane(['prompt', 'lane-a', '--file', join(f.dir, 'missing.md'), '--log', f.log], { exec: f.exec });
  const row = JSON.parse(readFileSync(f.log, 'utf8').trim());
  assert.deepEqual(Object.keys(row), ['ts', 'lane', 'verb', 'kind', 'model', 'reasoning', 'state', 'waitMs', 'exit', 'plan5h', 'planWeekly']);
  assert.equal(row.verb, 'prompt');
  assert.equal(row.exit, 2);
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
    () => { clock = 10; return { code: 1, stdout: '', stderr: '{"error":"timeout"}' }; },
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
    { code: 1, stdout: '', stderr: '{"error":"timeout"}' },
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
    { code: 1, stdout: '', stderr: '{"error":"timeout"}' },
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
  assert.deepEqual(f.calls[0].args.slice(0, 5), ['agent', 'wait', 'lane-a', '--until', 'idle']);
  assert.equal(f.calls.length, 1);
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
    { code: 0, stdout: 'PS C:\\lane>', stderr: '' },
    { code: 0, stdout: '{"result":{"agent":{"name":"lane-a"}}}', stderr: '' },
    { code: 0, stdout: '{"result":{}}', stderr: '' },
    { code: 0, stdout: '{"result":{"agents":[{"pane_id":"w1:p1","focused":true}]}}', stderr: '' },
    { code: 0, stdout: '{"result":{"accepted":true,"state":"working"}}', stderr: '' },
  );
  const result = await runLane(
    ['fallback', 'lane-a', '--to', 'claude', '--model', 'opus', '--log', f.log],
    { exec: f.exec, env: { HERDR_PANE_ID: 'w1:p1' }, sleep: async () => {} },
  );
  assert.equal(result.exit, 0);
  const start = f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
  const startIndex = f.calls.indexOf(start);
  // C11(b): the rate-limit modal must be dismissed and codex quit before a
  // claude agent can take the pane — and the pane prompt is the evidence.
  const escIndex = f.calls.findIndex((call) => call.args[0] === 'agent' && call.args[1] === 'send-keys' && call.args.includes('esc'));
  const quitIndex = f.calls.findIndex((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && call.args.includes('/quit'));
  const paneReadIndex = f.calls.findIndex((call) => call.args[0] === 'pane' && call.args[1] === 'read');
  assert.ok(escIndex >= 0 && quitIndex > escIndex, 'esc then /quit');
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
});

test('WP-3: the refusal pattern list carries the captured live refusal', () => {
  // Captured 2026-09-01 22:12Z, lane O. Nothing here is invented.
  const captured = "■ You've hit your usage limit. Try again at 11:42 PM.";
  assert.equal(PLAN_REFUSAL_PATTERNS.length, 1);
  assert.ok(PLAN_REFUSAL_PATTERNS.some((pattern) => pattern.test(captured)));
  assert.equal(PLAN_REFUSAL_PATTERNS.some((pattern) => pattern.test('5h 79% left · weekly 91% left')), false);
});

test('WP-3: exported lifecycle exit codes match the binding table', () => {
  assert.deepEqual(EXIT_CODES, { ok: 0, blocked: 3, timeout: 4, artifactCheckFailed: 5, planLow: 6 });
});

test('WP-3 / S8+C13: sweep delegates a cleaning pass over both lane locations', async (t) => {
  const f = fixture(t);
  f.responses.push(
    { code: 0, stdout: 'removing legacy lane ... done', stderr: '' },
    { code: 0, stdout: 'removing workit-wt-lane ... done', stderr: '' },
  );
  const result = await runLane(['sweep', '--log', f.log], {
    exec: f.exec,
    env: { USERPROFILE: 'C:\\Users\\test', WORKIT_WORKSPACE_ROOT: 'D:\\Development' },
  });
  assert.equal(result.exit, 0);
  assert.equal(f.calls.length, 2, 'one delegate invocation per lane location');
  for (const call of f.calls) {
    assert.equal(call.program, 'pwsh');
    assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-File', 'D:\\Development\\infrastructure\\herdr-lanes.ps1']);
    // S8 needs removal, and the delegate is LIST-ONLY without -Clean.
    assert.ok(call.args.includes('-Clean'), 'sweep must ask the delegate to clean');
    assert.equal(call.args.includes('-Force'), false, 'never force by default — HOLD verdicts are the point');
  }
  const roots = f.calls.map((call) => call.args[call.args.indexOf('-WorktreeRoot') + 1]);
  assert.deepEqual(roots, [join('C:\\Users\\test', '.herdr', 'worktrees'), 'D:\\Development']);
  assert.equal(result.output.roots.length, 2);
  assert.match(result.output.roots[1].output, /workit-wt-lane/);
});

test('WP-3 / C13: sweep accepts explicit roots and refuses when no location is declared', async (t) => {
  const f = fixture(t);
  f.responses.push({ code: 0, stdout: 'nothing to remove', stderr: '' });
  const explicit = await runLane(['sweep', '--root', 'D:\\Development', '--log', f.log], { exec: f.exec, env: {} });
  assert.equal(explicit.exit, 0);
  assert.deepEqual(f.calls.map((call) => call.args[call.args.indexOf('-WorktreeRoot') + 1]), ['D:\\Development']);

  const undeclared = await runLane(['sweep', '--log', f.log], { exec: f.exec, env: {} });
  assert.equal(undeclared.exit, 2);
  assert.match(undeclared.output.error, /--root|--workspace-root/);
});

test('WP-3: sweep prints the canonical operator commands when its delegate is absent', async (t) => {
  const f = fixture(t);
  const canonical = 'D:\\Development\\infrastructure\\herdr-lanes.ps1';
  const result = await runLane(['sweep', '--root', 'D:\\Development', '--log', f.log], {
    exec: f.exec,
    exists: (path) => path === canonical ? false : existsSync(path),
  });
  assert.equal(result.exit, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(result.output.commands[0], `pwsh -NoProfile -File "${canonical}" -WorktreeRoot "D:\\Development" -Clean`);
});

test('WP-4: burn-down and codex-delegate each carry one pointer to the shared lane lifecycle', () => {
  for (const file of ['skills/burn-down/SKILL.md', 'skills/codex-delegate/SKILL.md']) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.match(/scripts\/lane\.mjs/g)?.length, 1, `${file} must contain exactly one helper pointer`);
    assert.match(text, /herdr-lane-gating.*spec-lite/i, `${file} must point to the binding spec`);
  }
});
