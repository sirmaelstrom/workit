import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, appendFileSync, linkSync, truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseBackend, laneBackend, recordLaneStep, runLaneVerb, runtimeExerciseVerdict, parseOutcome, agentArgv,
} from './lanes.mjs';
import { STEPS, STEP_SEAM } from './state.mjs';
import { reportShapeProblems } from '../../../../scripts/lane.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const FIXTURES = join(SCRIPTS, '__fixtures__', 'lanes');
const REPO_ROOT = join(SCRIPTS, '..', '..', '..');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const CLAUDE_JSON = fixture('claude-p-ok.json');
const CODEX_JSONL = fixture('codex-exec-ok.jsonl');
const SESSION_ID = JSON.parse(CLAUDE_JSON).session_id;
const COST = JSON.parse(CLAUDE_JSON).total_cost_usd;
const THREAD_ID = JSON.parse(CODEX_JSONL.split('\n')[0]).thread_id;
const SHA40 = 'a'.repeat(40);
const T0 = Date.parse('2026-10-04T18:00:00.000Z');

// A run in a temp dir: state with one WP, and deps whose exec answers from a
// table (tests edit f.table) and whose spawnDetached/pidAlive are fakes.
function lanes(t, { agent = 'claude', herdr = false, backend = 'exec', model = 'opus', env = {}, wpLane = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, 'runs', 'demo', 'run');
  mkdirSync(runDir, { recursive: true });
  const repo = join(dir, 'repo');
  const pluginRoot = join(dir, 'plugin');
  const wp = {
    id: 'WP-00', name: 'demo', files: ['a.mjs'], dependsOn: [], tier: 'T1', model, runtimeExercise: 'CLI: cat hello.txt prints hi', state: 'dispatched',
    queue: [], lane: { backend, base: SHA40, ...wpLane },
  };
  const state = {
    schemaVersion: 1, slug: 'demo', runId: 'abcd1234', runDir, pluginRoot, rev: 0, seq: 0, phase: 'build',
    intent: { goal: 'demo', repo: { path: repo, remote: 'o/r', defaultBranch: 'main' }, anchor: 'anchor-uuid', lanesCap: 2, agent },
    agents: {}, adapters: { herdr: { on: herdr, detail: herdr ? 'herdr agent list exit 0' : 'HERDR_ENV is not 1' } }, wps: [wp],
  };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  const calls = [];
  const spawns = [];
  const table = {};
  let clock = T0;
  const deps = {
    exec: (program, args) => {
      const key = [program, ...args].join(' ');
      calls.push(key);
      return table[key] ?? { code: 127, stdout: '', stderr: `unexpected command: ${key}` };
    },
    read: (path) => readFileSync(path, 'utf8'), write: (path, value) => writeFileSync(path, value), exists: existsSync,
    rename: renameSync, append: appendFileSync, link: linkSync, truncate: truncateSync, remove: (path) => rmSync(path, { force: true }),
    list: readdirSync, env, platform: 'linux', resolveCodex: () => 'codex.exe', pluginRoot, pid: process.pid, hostname: 'test',
    now: () => clock, timestamp: () => new Date(clock).toISOString(),
    spawnDetached: (program, args, options) => { spawns.push({ program, args, options }); return { pid: 4242 }; },
    pidAlive: (pid) => pid === 4242,
  };
  return {
    dir, runDir, repo, pluginRoot, state, wp, deps, calls, spawns, table,
    tick: (ms) => { clock += ms; },
    backend: (name = backend) => laneBackend(state, deps, name),
    record: (act, result, more = {}) => recordLaneStep(state, wp, act, result, { ...deps, ...more }),
    report: (text) => writeFileSync(join(runDir, 'lane-wp-00-report.md'), text),
    saved: () => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')),
  };
}

const LANE = (f) => join(f.pluginRoot, 'scripts', 'lane.mjs');
const CONDUCT = (f) => join(f.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs');
const LOG = (f) => join(f.runDir, 'lane-runner.jsonl');
const BRIEF = (f) => join(f.runDir, 'lane-wp-00.md');
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const exit = (code, stderr = '', stdout = '') => ({ code, stdout, stderr });
const allSteps = (backend, wp) => ['admit', 'create', 'start', 'prompt', 'wait', 'check', 'stop'].flatMap((step) => backend[step](wp, { amendment: true }));

function report({ outcome = 'built', runtime = 'Verdict: exercised\nWould have shown: cat prints nothing; exit 1', pr = '#7 · abcdef1', claims = 'None', extra = '' } = {}) {
  return [
    '# Lane report', '', `## Outcome`, '', outcome, '',
    ...(runtime === null ? [] : ['## Runtime exercise', '', 'ran `cat hello.txt`: printed hi.', runtime, '']),
    ...(pr === null ? [] : ['## PR', '', pr, '']),
    extra,
    '## Debrief', '', '### Forks I decided that the brief did not settle', '', 'None', '',
    ...(claims === null ? [] : ['### Claims no control measures', '', claims, '']),
  ].join('\n');
}

// ---------------------------------------------------------------- verdict

test('runtimeExerciseVerdict: one report per marker (D19.23)', () => {
  const wp = { runtimeExercise: 'CLI: cat hello.txt prints hi' };
  const section = (body) => `## Outcome\n\nbuilt\n\n## Runtime exercise\n\n${body}\n\n## Debrief\n`;
  assert.equal(runtimeExerciseVerdict(section('Verdict: exercised\nWould have shown: exit 1'), wp), 'exercised');
  assert.equal(runtimeExerciseVerdict(section('Verdict: exercised'), wp), 'vacuous');
  assert.equal(runtimeExerciseVerdict(section('Verdict: vacuous'), wp), 'vacuous');
  assert.equal(runtimeExerciseVerdict(section('Verdict: not exercised'), wp), 'not-exercised');
  assert.equal(runtimeExerciseVerdict(section('This was exercised, and it would have shown: exit 1.\nWould have shown: exit 1'), wp), 'missing');
  assert.equal(runtimeExerciseVerdict(section('The check is not vacuous.\nVerdict: exercised\nWould have shown: exit 1'), wp), 'exercised');
  assert.equal(runtimeExerciseVerdict(section('Verdict: vacuous\nVerdict: exercised\nWould have shown: exit 1'), wp), 'vacuous');
  // A Verdict line outside the section, or quoted in a fence, is not read.
  assert.equal(runtimeExerciseVerdict('## Tests\n\nVerdict: exercised\nWould have shown: x\n', wp), 'missing');
  assert.equal(runtimeExerciseVerdict(section('```\nVerdict: exercised\nWould have shown: x\n```'), wp), 'missing');
});

test('runtimeExerciseVerdict: none, an empty field, and no section (D18)', () => {
  const noSurface = '## Runtime exercise\n\nVerdict: no runtime surface\n';
  assert.equal(runtimeExerciseVerdict(noSurface, { runtimeExercise: 'none: docs only' }), 'no-surface');
  assert.equal(runtimeExerciseVerdict(noSurface, { runtimeExercise: '' }), 'not-exercised');
  assert.equal(runtimeExerciseVerdict('## Outcome\n\nbuilt\n', { runtimeExercise: 'none: docs only' }), 'missing');
});

// ---------------------------------------------------------------- outcome

test('parseOutcome: built, refuted, needs conductor with asks verbatim, missing', () => {
  assert.equal(parseOutcome('## Outcome\n\nbuilt — PR #7\n').outcome, 'built');
  assert.equal(parseOutcome('## Outcome\n\n**refuted**: the premise fails\n').outcome, 'refuted');
  const asks = '## Outcome\n\nstopped: needs conductor\n\n## Needs conductor\n\nWhich base should the lane use?\n(a) main: the default\n- (b) release: the branch the WP names\n';
  assert.deepEqual(parseOutcome(asks), {
    outcome: 'needs-conductor',
    asks: [{ key: 'a', text: '(a) main: the default' }, { key: 'b', text: '- (b) release: the branch the WP names' }],
  });
  assert.deepEqual(parseOutcome('# Report\n\n## Tests\n\nall green\n'), { outcome: 'missing', asks: [] });
  assert.equal(parseOutcome('## Outcome\n\npartly done\n').outcome, 'missing');
});

test('parseOutcome heading form (D20)', () => {
  assert.equal(parseOutcome('## Outcome: refuted\n\nthe premise fails\n').outcome, 'refuted');
  assert.equal(parseOutcome('## Outcome: built\n').outcome, 'built');
  assert.equal(parseOutcome('## Outcome\n\nrefuted\n').outcome, 'refuted');
  assert.equal(parseOutcome('## Outcome\nbuilt\n').outcome, 'built');
});

// ---------------------------------------------------------------- backend choice

test('chooseBackend (D19.18)', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'workit-choose-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = (repo, on = true) => ({ intent: { repo: { path: repo } }, adapters: { herdr: { on, detail: on ? 'on' : 'HERDR_ENV is not 1' } } });
  assert.equal(chooseBackend(state(join(base, 'projects', 'scratch')), { env: {} }).backend, 'herdr');
  const elsewhere = chooseBackend(state(join(base, 'elsewhere', 'scratch')), { env: {} });
  assert.equal(elsewhere.backend, 'exec');
  assert.match(elsewhere.detail, /not a projects tree/);
  const rooted = { env: { WORKIT_WORKSPACE_ROOT: base } };
  assert.equal(chooseBackend(state(join(base, 'projects', 'scratch')), rooted).backend, 'herdr');
  const other = chooseBackend(state(join(base, 'other', 'projects', 'scratch')), rooted);
  assert.equal(other.backend, 'exec');
  assert.match(other.detail, /must live under/);
  const off = chooseBackend(state(join(base, 'projects', 'scratch'), false), { env: {} });
  assert.deepEqual([off.backend, /herdr adapter off/.test(off.detail)], ['exec', true]);
});

test('backend from the record (D18): the stored backend wins over the adapter', (t) => {
  const on = lanes(t, { herdr: true });
  const execActions = allSteps(on.backend('exec'), on.wp);
  assert.ok(execActions.length > 0);
  assert.ok(execActions.every((act) => !act.command.includes(LANE(on))), 'exec emits no lane.mjs argv');
  const off = lanes(t, { herdr: false, wpLane: { paneId: 'w1:p1', briefPath: '/b.md' } });
  assert.ok(allSteps(off.backend('herdr'), off.wp).some((act) => act.command.includes(LANE(off))));
});

// ---------------------------------------------------------------- step arrays

test('step arrays: every step returns an array; exec admit is []; every action carries step and seam (D19.15)', (t) => {
  for (const name of ['exec', 'herdr']) {
    const f = lanes(t, { backend: name, wpLane: { paneId: 'w1:p1', briefPath: '/b.md' } });
    const backend = f.backend(name);
    for (const step of ['admit', 'create', 'start', 'prompt', 'wait', 'check', 'stop']) assert.ok(Array.isArray(backend[step](f.wp)), `${name} ${step}`);
    for (const act of allSteps(backend, f.wp)) {
      assert.ok(STEPS.includes(act.step), act.step);
      const runtimeOnly = act.command.includes('--runtime-only');
      assert.equal(act.seam, runtimeOnly ? 'runtime-exercise' : STEP_SEAM[act.step], act.command.join(' '));
      assert.equal(runtimeOnly, name === 'herdr' && act.part === 'report');
    }
  }
  const f = lanes(t);
  assert.deepEqual(f.backend('exec').admit(f.wp), []);
});

test('step arrays: both create arrays are fetch, rev-parse origin/<default>, create; the base record stores a 40-hex sha (D17)', (t) => {
  for (const name of ['exec', 'herdr']) {
    const f = lanes(t, { backend: name, wpLane: { base: null } });
    const create = f.backend(name).create(f.wp);
    assert.deepEqual(create.slice(0, 2).map((act) => act.command), [['git', '-C', f.repo, 'fetch', 'origin'], ['git', '-C', f.repo, 'rev-parse', 'origin/main']]);
    assert.deepEqual(create.map((act) => act.step), ['create', 'base', 'create']);
    const recorded = f.record(create[1], ok(`${'b'.repeat(40)}\n`));
    assert.deepEqual([recorded.outcome, recorded.patch.lane.base], ['continue', 'b'.repeat(40)]);
    assert.equal(f.record(create[1], ok('origin/main\n')).outcome, 'block');
  }
});

// ---------------------------------------------------------------- recordLaneStep

test('recordLaneStep: create records the worktree and brief on both backends, never lane.path (D20)', (t) => {
  const h = lanes(t, { backend: 'herdr' });
  const herdrCreate = h.backend().create(h.wp).at(-1);
  const created = { workspaceId: 'w1', paneId: 'w1:p1', path: join(h.dir, 'projects', 'repo-wt-demo-wp-00'), branch: 'conduct/demo/wp-00' };
  const patch = h.record(herdrCreate, ok(JSON.stringify(created))).patch.lane;
  assert.deepEqual([patch.paneId, patch.worktree, patch.branch, patch.briefPath], ['w1:p1', created.path, 'conduct/demo/wp-00', BRIEF(h)]);
  assert.equal('path' in patch, false);
  assert.equal(h.record(herdrCreate, exit(2, 'lane: log x', '{"error":"branch already exists"}')).outcome, 'block');
  const e = lanes(t);
  const execCreate = e.backend().create(e.wp).at(-1);
  assert.equal(execCreate.part, 'worktree');
  const worktree = join(e.dir, 'repo-wt-demo-wp-00');
  assert.deepEqual(execCreate.command, ['git', '-C', e.repo, 'worktree', 'add', worktree, '-b', 'conduct/demo/wp-00', 'origin/main']);
  const lane = e.record(execCreate, ok()).patch.lane;
  assert.deepEqual([lane.worktree, lane.briefPath, 'path' in lane], [worktree, BRIEF(e), false]);
});

test('recordLaneStep: admit exit 7 → wait, the WP back to pending', (t) => {
  const f = lanes(t, { backend: 'herdr' });
  const result = f.record(f.backend().admit(f.wp)[0], exit(7, '', '{"admitted":false}'));
  assert.deepEqual([result.outcome, result.patch.state], ['wait', 'pending']);
});

test('start exit 7 re-arms start (D20)', (t) => {
  for (const name of ['herdr', 'exec']) {
    const f = lanes(t, { backend: name, wpLane: { paneId: 'w1:p1' } });
    const start = f.backend().start(f.wp);
    const result = f.record(start[0], exit(7, 'admission refused'));
    assert.equal(result.outcome, 'wait');
    assert.equal('state' in result.patch, false);
    assert.equal(result.patch.queue[0].kind, 'wait');
    assert.deepEqual(result.patch.queue.slice(1), start);
    const commands = result.patch.queue.slice(1).map((act) => act.command.join(' '));
    assert.ok(commands.every((command) => !/ fetch | worktree add | create /.test(command)), commands.join('\n'));
  }
});

test('herdr start exit 2 → block with the stderr', (t) => {
  const f = lanes(t, { backend: 'herdr', agent: 'codex', wpLane: { paneId: 'w1:p1' } });
  const result = f.record(f.backend().start(f.wp)[0], exit(2, 'codex start needs an explicit --sandbox'));
  assert.equal(result.outcome, 'block');
  assert.match(result.reason, /codex start needs an explicit --sandbox/);
});

test('recordLaneStep: start sets startedAt and a deadline 120 minutes later (D19.17)', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1' } });
  const lane = f.record(f.backend().start(f.wp)[0], ok('{}')).patch.lane;
  assert.equal(lane.startedAt, new Date(T0).toISOString());
  assert.equal(Date.parse(lane.deadline) - Date.parse(lane.startedAt), 120 * 60 * 1000);
});

test('lane deadline (D19.17): past it, a running lane blocks on either backend', (t) => {
  const deadline = new Date(T0 + 120 * 60 * 1000).toISOString();
  const e = lanes(t, { wpLane: { pid: 4242, deadline } });
  const alive = e.backend().wait(e.wp)[0];
  assert.equal(e.record(alive, exit(0)).outcome, 'wait');
  e.tick(121 * 60 * 1000);
  assert.deepEqual([e.record(alive, exit(0)).outcome, e.record(alive, exit(0)).reason], ['block', 'lane deadline']);
  const h = lanes(t, { backend: 'herdr', wpLane: { deadline } });
  const wait = h.backend().wait(h.wp)[0];
  assert.equal(h.record(wait, exit(4)).outcome, 'wait');
  h.tick(121 * 60 * 1000);
  assert.deepEqual([h.record(wait, exit(4)).outcome, h.record(wait, exit(4)).reason], ['block', 'lane deadline']);
});

test('exec wait: alive 0 → wait 60 s then alive again; 1 → continue, with cost and session read through deps.read (D19.28)', (t) => {
  const f = lanes(t, { wpLane: { pid: 4242, logPath: join('nowhere', 'lane-wp-00.log') } });
  const alive = f.backend().wait(f.wp)[0];
  const running = f.record(alive, exit(0));
  assert.equal(running.outcome, 'wait');
  assert.deepEqual([running.patch.queue[0].kind, running.patch.queue[0].waitMs], ['wait', 60000]);
  assert.deepEqual(running.patch.queue.slice(1), [alive]);
  const reads = [];
  const read = (path) => { reads.push(path); return `some stderr line\n${CLAUDE_JSON}`; };
  const done = f.record(alive, exit(1), { read });
  assert.equal(done.outcome, 'continue');
  assert.deepEqual([done.patch.lane.costUsd, done.patch.lane.sessionId], [COST, SESSION_ID]);
  assert.deepEqual(reads, [join('nowhere', 'lane-wp-00.log')]);
  assert.equal(f.record(alive, exit(2, 'no pid')).outcome, 'block');
  // codex: the thread id, no cost.
  const c = lanes(t, { agent: 'codex', wpLane: { pid: 4242, logPath: 'x.log' } });
  const codexDone = c.record(c.backend().wait(c.wp)[0], exit(1), { read: () => CODEX_JSONL });
  assert.deepEqual([codexDone.patch.lane.sessionId, 'costUsd' in codexDone.patch.lane], [THREAD_ID, false]);
});

test('herdr wait exits map to outcomes (D17, D19.17)', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/run/lane-wp-00.md' } });
  const wait = f.backend().wait(f.wp)[0];
  assert.deepEqual(wait.command, ['node', LANE(f), 'wait', 'demo-wp-00', '--until', 'done', '--until', 'idle', '--timeout', '60000', '--log', LOG(f)]);
  assert.equal(f.record(wait, ok('{"state":"done"}')).outcome, 'continue');
  for (const code of [1, 2]) {
    const result = f.record(wait, exit(code, `lane: daemon said no (${code})`));
    assert.equal(result.outcome, 'block');
    assert.match(result.reason, new RegExp(`daemon said no \\(${code}\\)`));
  }
  const blocked = f.record(wait, exit(3, '', '{"state":"blocked","dialog":"Allow this command?"}'));
  assert.equal(blocked.outcome, 'block');
  assert.match(blocked.reason, /Allow this command\?/);
  const timeout = f.record(wait, exit(4));
  assert.equal(timeout.outcome, 'wait');
  assert.deepEqual([timeout.patch.queue[0].kind, timeout.patch.queue[0].waitMs], ['wait', 0]);
  assert.deepEqual(timeout.patch.queue[1].command, wait.command);
  const planLow = f.record(wait, exit(6));
  assert.equal(planLow.outcome, 'continue');
  assert.equal(planLow.patch.queue[0].step, 'fallback');
  assert.deepEqual(planLow.patch.queue[0].command, ['node', LANE(f), 'fallback', 'demo-wp-00', '--to', 'claude', '--model', 'claude-opus-5-5', '--reasoning', 'high', '--log', LOG(f)]);
  const capacity = f.record(wait, exit(8));
  assert.equal(capacity.outcome, 'continue');
  assert.deepEqual(capacity.patch.queue[0].command, ['node', LANE(f), 'prompt', 'demo-wp-00', '--file', '/run/lane-wp-00.md', '--amendment', '--no-ruling', '--log', LOG(f)]);
});

// ---------------------------------------------------------------- check and PR

test('a refuted report → done, refuted, the stop queued, no PR lookup (D19.16)', (t) => {
  for (const name of ['herdr', 'exec']) {
    const f = lanes(t, { backend: name });
    const reportCheck = f.backend().check(f.wp).find((act) => act.part === 'report');
    const result = f.record(reportCheck, ok(JSON.stringify({ ok: true, outcome: 'refuted', verdict: 'missing', failures: [], asks: [] })));
    assert.deepEqual([result.outcome, result.patch.state], ['done', 'refuted']);
    assert.deepEqual(result.patch.queue, f.backend().stop(f.wp));
    assert.ok(result.patch.queue.every((act) => act.step !== 'pr-lookup' && !act.command.includes('{pr.number}')));
    if (name === 'herdr') assert.equal(result.patch.queue[0].step, 'stop');
  }
});

test('a needs-conductor report → block with the asks verbatim, before any PR check', (t) => {
  const f = lanes(t, { backend: 'herdr' });
  const asks = [{ key: 'a', text: '(a) main: the default' }, { key: 'b', text: '(b) release' }];
  const reportCheck = f.backend().check(f.wp).find((act) => act.part === 'report');
  const result = f.record(reportCheck, ok(JSON.stringify({ ok: true, outcome: 'needs-conductor', verdict: 'exercised', failures: [], asks })));
  assert.deepEqual([result.outcome, result.reason, result.patch.asks, result.patch.queue], ['block', 'needs conductor', asks, []]);
});

test('lane check exit 5 → amend; a missing outcome → amend', (t) => {
  const f = lanes(t);
  const reportCheck = f.backend().check(f.wp)[0];
  const failed = f.record(reportCheck, exit(5, '', JSON.stringify({ ok: false, outcome: 'built', verdict: 'missing', failures: ['runtime exercise: missing'] })));
  assert.deepEqual([failed.outcome, failed.reason, failed.patch.runtimeVerdict, failed.patch.queue], ['amend', 'runtime exercise: missing', 'missing', []]);
  const missing = f.record(reportCheck, exit(5, '', JSON.stringify({ ok: false, outcome: 'missing', verdict: 'missing', failures: ['no report'] })));
  assert.equal(missing.outcome, 'amend');
  assert.equal(f.record(f.backend().check(f.wp).at(-1), exit(5, '', '{"ok":false}')).outcome, 'amend');
});

test('PR lookup: after the report check on both backends; stores pr.number and pr.head; a mismatch or no PR → amend (D17)', (t) => {
  for (const name of ['herdr', 'exec']) {
    const f = lanes(t, { backend: name });
    const check = f.backend().check(f.wp);
    const lookupAt = check.findIndex((act) => act.step === 'pr-lookup');
    assert.ok(lookupAt > check.findIndex((act) => act.part === 'report'));
    assert.deepEqual(check[lookupAt].command, ['gh', 'pr', 'list', '--repo', 'o/r', '--head', 'conduct/demo/wp-00', '--state', 'all', '--json', 'number,headRefOid,state']);
    assert.ok(check.slice(lookupAt + 1).every((act) => act.command.includes('{pr.number}')));
    f.report(report({ pr: '#7 · abcdef1' }));
    const head = `abcdef1${'0'.repeat(33)}`;
    const found = f.record(check[lookupAt], ok(JSON.stringify([{ number: 7, headRefOid: head, state: 'OPEN' }])));
    assert.deepEqual([found.outcome, found.patch.pr], ['continue', { number: 7, head }]);
    const other = f.record(check[lookupAt], ok(JSON.stringify([{ number: 8, headRefOid: head, state: 'OPEN' }])));
    assert.equal(other.outcome, 'amend');
    assert.match(other.reason, /#7 at abcdef1.*#8/);
    const none = f.record(check[lookupAt], ok('[]'));
    assert.deepEqual([none.outcome, none.reason, none.patch.queue], ['amend', 'no PR for conduct/demo/wp-00', []]);
  }
});

// ---------------------------------------------------------------- herdr argv

test('herdr: each action\'s argv, every one with --log (D17, D19.17)', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1', briefPath: '/run/lane-wp-00.md' } });
  const b = f.backend();
  const lane = (verb, ...args) => ['node', LANE(f), verb, ...args, '--log', LOG(f)];
  assert.deepEqual(b.admit(f.wp).map((act) => act.command), [lane('admit')]);
  assert.deepEqual(b.create(f.wp)[2].command, lane('create', '--repo', f.repo, '--branch', 'conduct/demo/wp-00', '--base', 'origin/main', '--label', 'demo-wp-00', '--slug', 'demo-wp-00'));
  assert.deepEqual(b.start(f.wp)[0].command, lane('start', 'demo-wp-00', '--pane', 'w1:p1', '--kind', 'claude', '--model', 'claude-opus-5-5', '--reasoning', 'high'));
  assert.deepEqual(b.prompt(f.wp)[0].command, lane('prompt', 'demo-wp-00', '--file', '/run/lane-wp-00.md'));
  assert.deepEqual(b.check(f.wp).map((act) => act.command), [
    lane('check', 'demo-wp-00', '--expect-report', join(f.runDir, 'lane-wp-00-report.md')),
    ['node', CONDUCT(f), 'lane', 'check', '--run', f.runDir, '--wp', 'WP-00', '--runtime-only'],
    ['gh', 'pr', 'list', '--repo', 'o/r', '--head', 'conduct/demo/wp-00', '--state', 'all', '--json', 'number,headRefOid,state'],
    lane('check', 'demo-wp-00', '--expect-pr', '{pr.number}'),
  ]);
  assert.deepEqual(b.stop(f.wp)[0].command, lane('stop', 'demo-wp-00'));
  for (const act of allSteps(b, f.wp).filter((item) => item.command.includes(LANE(f)))) {
    assert.deepEqual(act.command.slice(-2), ['--log', LOG(f)], act.command.join(' '));
  }
});

test('herdr codex start sandbox (D20)', (t) => {
  const codex = lanes(t, { backend: 'herdr', agent: 'codex', wpLane: { paneId: 'w1:p1' } });
  const command = codex.backend().start(codex.wp)[0].command;
  assert.deepEqual(command.slice(command.indexOf('--kind'), command.indexOf('--reasoning')), ['--kind', 'codex', '--model', 'gpt-6.1-sol']);
  assert.deepEqual(command.slice(command.indexOf('--sandbox'), command.indexOf('--sandbox') + 2), ['--sandbox', 'danger-full-access']);
  const claude = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1' } });
  assert.equal(claude.backend().start(claude.wp)[0].command.includes('--sandbox'), false);
});

test('herdr amendments: a receipt only when a resolver can resolve it (D16)', (t) => {
  const answer = { key: 'a', receiptId: '91cc7678-0000-4000-8000-000000000000' };
  const withResolver = lanes(t, { backend: 'herdr', env: { WORKIT_RECEIPT_RESOLVER: 'node resolve.mjs' }, wpLane: { briefPath: '/b.md' } });
  const named = withResolver.backend().prompt(withResolver.wp, { amendment: true, answer })[0];
  assert.deepEqual(named.command.slice(6, -2), ['--amendment', '--ruling-receipt', answer.receiptId, '--quest', 'anchor-uuid']);
  assert.equal(named.data, undefined);
  const unset = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/b.md' } });
  const brief = unset.backend().prompt(unset.wp, { amendment: true, answer })[0];
  assert.deepEqual([brief.command.slice(6, -2), brief.data], [['--amendment', '--no-ruling'], { rulingCarried: 'brief' }]);
  const core = unset.backend().prompt(unset.wp, { amendment: true, answer: { key: 'b', receiptId: null } })[0];
  assert.deepEqual(core.command.slice(6, -2), ['--amendment', '--no-ruling']);
});

test('herdr: lane check --runtime-only fails a shape-valid report with no runtime exercise (exit 5, missing)', async (t) => {
  const f = lanes(t, { backend: 'herdr' });
  const text = report({ runtime: null });
  assert.deepEqual(reportShapeProblems(text), [], 'lane.mjs check --expect-report would accept it');
  f.report(text);
  const result = await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: { runtimeOnly: true } }, f.deps);
  assert.equal(result.code, 5);
  const out = JSON.parse(result.out);
  assert.deepEqual([out.ok, out.outcome, out.verdict], [false, 'built', 'missing']);
  assert.deepEqual(f.calls, [], 'runtime-only runs no program');
  f.report(report());
  assert.equal((await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: { runtimeOnly: true } }, f.deps)).code, 0);
});

// ---------------------------------------------------------------- exec

test('exec: spawn runs the agent detached in the lane worktree, logging to the run, and records the pid', async (t) => {
  const f = lanes(t, { model: 'sonnet' });
  const worktree = join(f.dir, 'repo-wt-demo-wp-00');
  f.state.wps[0].lane = { ...f.wp.lane, worktree, briefPath: BRIEF(f) };
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  const state = f.saved();
  const result = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: {}, state }, f.deps);
  assert.equal(result.code, 0, result.out);
  const [spawn] = f.spawns;
  assert.equal(spawn.options.cwd, worktree);
  assert.equal(spawn.options.logPath, join(f.runDir, 'lane-wp-00.log'));
  assert.deepEqual([spawn.program, ...spawn.args], ['claude', '-p', '--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-5-5', '--effort', 'high',
    '--output-format', 'json', `Read ${BRIEF(f)} and execute it exactly.`]);
  assert.deepEqual([f.saved().wps[0].lane.pid, f.saved().wps[0].lane.startedAt], [4242, new Date(T0).toISOString()]);
  const start = f.backend().start(f.wp)[0];
  assert.deepEqual(start.command, ['node', CONDUCT(f), 'lane', 'spawn', '--run', f.runDir, '--wp', 'WP-00']);
  assert.equal(f.record(start, ok(result.out)).patch.lane.startedAt, new Date(T0).toISOString());
});

test('exec: a failed spawn says why in the lane log (WP-01 follow-up)', async (t) => {
  const f = lanes(t, { wpLane: { worktree: join('no', 'such', 'worktree'), briefPath: '/b.md' } });
  const deps = { ...f.deps, spawnDetached: () => ({ pid: null }) };
  const result = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: {}, state: f.saved() }, deps);
  assert.equal(result.code, 5);
  assert.match(JSON.parse(result.out).error, /lane worktree .* does not exist/);
  assert.match(readFileSync(join(f.runDir, 'lane-wp-00.log'), 'utf8'), /conduct: lane spawn failed: the lane worktree .* does not exist/);
  assert.equal(f.saved().wps[0].lane.pid, undefined);
  const thrown = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: {}, state: f.saved() }, { ...f.deps, spawnDetached: () => { throw new Error('EMFILE: too many open files'); } });
  assert.match(JSON.parse(thrown.out).error, /EMFILE/);
});

test('exec: the claude resume argv carries the session id from the captured JSON; every brief path is lane.briefPath', async (t) => {
  const f = lanes(t, { wpLane: { worktree: join('somewhere', 'wt'), briefPath: '/run/lane-wp-00.md' } });
  writeFileSync(join(f.runDir, 'lane-wp-00.log'), `stderr noise\n${CLAUDE_JSON}`);
  const amend = f.backend().prompt(f.wp, { amendment: true })[0];
  assert.deepEqual(amend.command.slice(-2), ['--amend', '/run/lane-wp-00.md']);
  const result = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: { amend: '/run/lane-wp-00.md' }, state: f.saved() }, f.deps);
  assert.equal(result.code, 0, result.out);
  const { program, args } = f.spawns[0];
  assert.deepEqual([program, ...args.slice(0, 3)], ['claude', '-p', '--resume', SESSION_ID]);
  assert.equal(args.at(-1), 'Read /run/lane-wp-00.md and execute it exactly.');
  assert.equal(f.backend().prompt(f.wp).length, 0, 'the first exec prompt rides the spawn');
});

test('exec: codex argv and its resume token order (D18)', (t) => {
  for (const model of ['opus', 'sonnet']) {
    const f = lanes(t, { agent: 'codex', model });
    const first = agentArgv(f.state, f.wp, { brief: '/b.md' }, f.deps);
    assert.deepEqual(first, ['codex', 'exec', '--sandbox', 'danger-full-access', '-c', 'model=gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--json', 'Read /b.md and execute it exactly.']);
    assert.equal(first.includes('--ask-for-approval'), false);
    const thread = JSON.parse(CODEX_JSONL.split('\n')[0]).thread_id;
    const resume = agentArgv(f.state, f.wp, { brief: '/b.md', sessionId: thread }, f.deps);
    const at = resume.indexOf('resume');
    for (const token of ['exec', '--sandbox', 'danger-full-access', '-c', 'model=gpt-6.1-sol', 'model_reasoning_effort=high', '--json']) {
      assert.ok(resume.indexOf(token) > -1 && resume.indexOf(token) < at, token);
    }
    assert.deepEqual(resume.slice(at), ['resume', THREAD_ID, 'Read /b.md and execute it exactly.']);
  }
  const win = lanes(t, { agent: 'codex' });
  assert.equal(agentArgv(win.state, win.wp, { brief: '/b.md' }, { ...win.deps, platform: 'win32', resolveCodex: () => 'C:/codex.exe' })[0], 'C:/codex.exe');
});

test('LANE_MODELS: a claude opus lane carries claude-opus-5-5; no production module but adapters.mjs names a model id (D17)', (t) => {
  const f = lanes(t);
  assert.deepEqual(agentArgv(f.state, f.wp, { brief: '/b.md' }, f.deps).slice(4, 6), ['--model', 'claude-opus-5-5']);
  const production = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) { if (name.name !== '__fixtures__') walk(path); } else if (name.name.endsWith('.mjs') && !name.name.endsWith('.test.mjs')) production.push(path);
    }
  };
  walk(SCRIPTS);
  assert.ok(production.some((path) => path.endsWith('lanes.mjs')));
  const naming = production.filter((path) => /claude-opus-5-5|claude-sonnet-5-5|gpt-6\.1-sol/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(naming.map((path) => path.slice(SCRIPTS.length + 1).replace(/\\/g, '/')), ['lib/adapters.mjs']);
});

test('exec: lane check passes a good report and fails a missing Debrief heading or runtime exercise', async (t) => {
  const f = lanes(t, { wpLane: { worktree: '/wt', branch: 'conduct/demo/wp-00' } });
  f.table[`git -C /wt rev-list --count ${SHA40}..HEAD`] = ok('1\n');
  const check = (flags = {}) => runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags }, f.deps).then((result) => ({ ...result, out: JSON.parse(result.out) }));
  f.report(report());
  const good = await check();
  assert.deepEqual([good.code, good.out.ok, good.out.outcome, good.out.verdict, good.out.failures], [0, true, 'built', 'exercised', []]);
  f.report(report({ claims: null }));
  const noClaims = await check();
  assert.equal(noClaims.code, 5);
  assert.ok(noClaims.out.failures.some((failure) => /Claims no control measures/.test(failure)), noClaims.out.failures.join('; '));
  f.report(report({ runtime: null }));
  const noRuntime = await check();
  assert.deepEqual([noRuntime.code, noRuntime.out.verdict], [5, 'missing']);
  // No commit past the base.
  f.report(report());
  f.table[`git -C /wt rev-list --count ${SHA40}..HEAD`] = ok('0\n');
  assert.match((await check()).out.failures.join('; '), /no commit past base/);
  // The PR form: head branch, state and body.
  f.table[`git -C /wt rev-list --count ${SHA40}..HEAD`] = ok('1\n');
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'conduct/demo/wp-00', state: 'OPEN', body: report() }));
  assert.equal((await check({ pr: '7' })).code, 0);
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'other', state: 'CLOSED', body: 'no debrief' }));
  assert.equal((await check({ pr: '7' })).out.failures.length, 3);
  const pr = f.backend().check(f.wp).at(-1);
  assert.deepEqual(pr.command.slice(-2), ['--pr', '{pr.number}']);
});

test('exec: lane alive exits 1 for a dead pid', async (t) => {
  const live = lanes(t, { wpLane: { pid: 4242 } });
  assert.equal((await runLaneVerb('alive', { runDir: live.runDir, wpId: 'WP-00', flags: {} }, live.deps)).code, 0);
  const dead = lanes(t, { wpLane: { pid: 999999 } });
  const result = await runLaneVerb('alive', { runDir: dead.runDir, wpId: 'WP-00', flags: {} }, dead.deps);
  assert.deepEqual([result.code, JSON.parse(result.out).alive], [1, false]);
});

// ---------------------------------------------------------------- verb I/O

test('runLaneVerb I/O (D19.21): { code, out }, nothing printed; an unknown flag is exit 2 naming it', async (t) => {
  const f = lanes(t);
  f.report(report());
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
  let result;
  try {
    result = await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: { runtimeOnly: true } }, f.deps);
  } finally {
    process.stdout.write = original;
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'out']);
  assert.equal(typeof result.out, 'string');
  assert.equal(JSON.parse(result.out).verdict, 'exercised');
  const bogus = await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: { bogus: 1 } }, f.deps);
  assert.equal(bogus.code, 2);
  assert.match(bogus.out, /bogus/);
  assert.equal((await runLaneVerb('stop', { runDir: f.runDir, wpId: 'WP-00', flags: {} }, f.deps)).code, 2);
});

// ---------------------------------------------------------------- brief and fixtures

test('lane-brief.md carries the standing clauses byte-equal to codex-delegate, and the Verdict format', () => {
  const brief = readFileSync(join(REPO_ROOT, 'skills', 'conduct', 'templates', 'lane-brief.md'), 'utf8');
  const delegate = readFileSync(join(REPO_ROOT, 'skills', 'codex-delegate', 'SKILL.md'), 'utf8').split(/\r?\n/);
  const clauseAfter = (marker) => /`([^`]+)`/.exec(delegate[delegate.findIndex((line) => line.includes(marker)) + 1].trim())[1];
  const earlyExit = clauseAfter('*Build / repair:*');
  assert.match(earlyExit, /^EARLY EXIT: if the brief assumed more work/);
  for (const clause of [earlyExit, clauseAfter('**Follow-ups destination.**'), clauseAfter('**Boundary question.**')]) {
    assert.ok(brief.includes(`\`${clause}\``), clause.slice(0, 40));
  }
  assert.match(brief, /^- `Verdict: exercised`, `Verdict: vacuous`, `Verdict: not exercised` or `Verdict: no runtime surface`/m);
  assert.match(brief, /^- `Would have shown: /m);
  assert.match(brief, /## Runtime exercise/);
  assert.match(brief, /Never invoke `\/conduct` from this lane/);
  for (const slot of ['<lane id>', '<quest id>', '<worktree path>', '<branch name>', '<base sha>', '<wp spec path>', '<lane contract path>', '<report path>', '<runtime exercise>']) {
    assert.ok(brief.includes(slot), slot);
  }
});

const PRIVATE_PATHS = [/[A-Za-z]:[\\/]+(Users|Development)\b/i, /[\\/]Users[\\/][^\\/\s"]+[\\/]/];
const privateHits = (text) => PRIVATE_PATHS.filter((pattern) => pattern.test(text)).map(String);

test('fixture paths: no private-path shapes under __fixtures__/lanes (Must 8)', (t) => {
  const files = [];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : files.push(join(dir, entry.name))));
  walk(FIXTURES);
  assert.ok(files.length >= 11, files.join(', '));
  for (const path of files) assert.deepEqual(privateHits(readFileSync(path, 'utf8')), [], path);
  // Controls: each shape inserted into a copy is flagged (built at run time,
  // so this file stays clean).
  for (const insert of [['C:', 'Users', 'someone', 'x'].join('\\'), ['D:', 'Development', 'x'].join('/'), ['', 'Users', 'someone', ''].join('/')]) {
    assert.notDeepEqual(privateHits(`${CODEX_JSONL}${insert}`), [], insert);
  }
});
