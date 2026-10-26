import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, appendFileSync, linkSync, truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  allowedMissing, chooseBackend, laneBackend, recordLaneStep, runLaneVerb, runtimeExerciseVerdict, parseOutcome, agentArgv, laneCost, ADMIT_BACKOFF_MS, identityArgv, guardedKillArgv,
  STOP_CHECK_BLOCKS, stopHookCommand, laneDeadlineMs, T3_HEARTBEAT_MS, t3WakeLive, heartbeatsToDelete, conductorThreadFence, unresolvedHeartbeats, markDoneWake,
} from './lanes.mjs';
import { RESET_TARGETS } from './phases/build.mjs';
import { dispatchable } from './schedule.mjs';
import { STEPS, STEP_SEAM } from './state.mjs';
import { reportShapeProblems, runLane } from '../../../../scripts/lane.mjs';

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
const IDENTITY = '2026-10-04T18:00:00.0000000Z claude.exe';
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
    id: 'WP-00', name: 'demo', files: ['a.mjs'], creates: ['a.mjs'], dependsOn: [], tier: 'T1', model, runtimeExercise: 'CLI: cat hello.txt prints hi', state: 'dispatched',
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
  // pid 4242 is the lane's agent, with this identity, on either platform.
  const table = Object.fromEntries(['linux', 'win32'].map((platform) => [identityArgv(4242, platform).join(' '), { code: 0, stdout: `${IDENTITY}\n`, stderr: '' }]));
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
// The Stop hook command a claude lane carries (no spaces in the fixture's paths).
const STOP_HOOK = (f, wpId = 'WP-00') => ['node', join(f.pluginRoot, 'skills', 'conduct', 'scripts', 'stop-check.mjs').replace(/\\/g, '/'),
  '--run', f.runDir.replace(/\\/g, '/'), '--wp', wpId].join(' ');
const LOG = (f) => join(f.runDir, 'lane-runner.jsonl');
const BRIEF = (f) => join(f.runDir, 'lane-wp-00.md');
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const exit = (code, stderr = '', stdout = '') => ({ code, stdout, stderr });
// WP-04's reading of a patch (lanes.mjs header): lane merges, the rest replace.
function apply(wp, { lane, ...fields }) {
  if (lane) wp.lane = { ...wp.lane, ...lane };
  Object.assign(wp, fields);
}
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
    asks: [{ key: 'a', text: '(a) main: the default', question: 'Which base should the lane use?' }, { key: 'b', text: '- (b) release: the branch the WP names', question: 'Which base should the lane use?' }],
  });
  assert.deepEqual(parseOutcome('# Report\n\n## Tests\n\nall green\n'), { outcome: 'missing', asks: [] });
  assert.equal(parseOutcome('## Outcome\n\npartly done\n').outcome, 'missing');
});

test('parseOutcome (d9d4d664): a lettered question followed by option (a) labels its ask and is not an option; a built report keeps its asks', () => {
  const labeled = '## Outcome\n\nbuilt\n\n## Needs conductor\n\n(a) perf.test.ts is load-sensitive on main too: how should this WP treat it?\n(a) Raise the budget.\n(b) Isolate it in its own job.\n(c) Leave it and file a follow-up.\n';
  const stem = '(a) perf.test.ts is load-sensitive on main too: how should this WP treat it?';
  assert.deepEqual(parseOutcome(labeled), {
    outcome: 'built',
    asks: [{ key: 'a', text: '(a) Raise the budget.', question: stem }, { key: 'b', text: '(b) Isolate it in its own job.', question: stem },
      { key: 'c', text: '(c) Leave it and file a follow-up.', question: stem }],
  });
  // An option that asks a question is still an option when (a) does not follow it.
  assert.deepEqual(parseOutcome('## Outcome\n\nbuilt\n\n## Needs conductor\n\nWhich?\n(a) Keep it?\n(b) Drop it?\n').asks.map((ask) => [ask.key, ask.question]), [['a', 'Which?'], ['b', 'Which?']]);
  // Two questions with the same letters stay two questions.
  const two = parseOutcome('## Outcome\n\nbuilt\n\n## Needs conductor\n\n(a) Change the timeout?\n(a) Fix it here.\n(b) Defer it.\n\n(b) Remove the guard?\n(a) Fix it here.\n(b) Defer it.\n').asks;
  assert.deepEqual(two.map((ask) => [ask.question, ask.key]), [['(a) Change the timeout?', 'a'], ['(a) Change the timeout?', 'b'], ['(b) Remove the guard?', 'a'], ['(b) Remove the guard?', 'b']]);
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
  // A pane id in the shape herdr really issues (captured `herdr agent list`).
  const [agent] = JSON.parse(fixture('herdr-agent-list.json')).result.agents;
  assert.match(agent.pane_id, /^w[0-9A-Za-z]+:p\d+$/);
  const created = { workspaceId: agent.workspace_id, paneId: agent.pane_id, path: join(h.dir, 'projects', 'repo-wt-demo-wp-00'), branch: 'conduct/demo/wp-00' };
  const patch = h.record(herdrCreate, ok(JSON.stringify(created))).patch.lane;
  assert.deepEqual([patch.paneId, patch.worktree, patch.branch, patch.briefPath], [agent.pane_id, created.path, 'conduct/demo/wp-00', BRIEF(h)]);
  assert.deepEqual(h.backend().start({ ...h.wp, lane: { ...h.wp.lane, ...patch } })[0].command.slice(4, 6), ['--pane', agent.pane_id]);
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

test('admission refusal backs off (C1-11): admit exit 7 → done, pending, notBefore 5 minutes on; dispatchable waits for it', (t) => {
  const f = lanes(t, { backend: 'herdr' });
  const result = f.record(f.backend().admit(f.wp)[0], exit(7, '', '{"admitted":false}'));
  const notBefore = new Date(T0 + ADMIT_BACKOFF_MS).toISOString();
  assert.deepEqual([result.outcome, result.patch.state, result.patch.notBefore, result.patch.queue], ['done', 'pending', notBefore, []]);
  assert.equal(ADMIT_BACKOFF_MS, 5 * 60 * 1000);
  const wp = { ...f.wp, lane: null, files: ['a.mjs'], dependsOn: [], state: 'pending', notBefore };
  const state = { intent: { lanesCap: 2 }, wps: [wp], dispatchHalt: null };
  assert.deepEqual(dispatchable(state, { now: T0 + 60000 }).map((item) => item.id), []);
  assert.deepEqual(dispatchable(state, { now: T0 + ADMIT_BACKOFF_MS }).map((item) => item.id), ['WP-00']);
  assert.deepEqual(f.record(f.backend().admit(f.wp)[0], ok('{"admitted":true}')).patch, { notBefore: null });
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

test('recordLaneStep with deps { exec, read, now } alone re-arms from the run\'s plugin root (D20)', (t) => {
  for (const name of ['herdr', 'exec']) {
    const f = lanes(t, { backend: name, wpLane: { paneId: 'w1:p1', briefPath: '/b.md' } });
    const narrow = { exec: f.deps.exec, read: f.deps.read, now: f.deps.now };
    const rearmed = recordLaneStep(f.state, f.wp, f.backend().start(f.wp)[0], exit(7), narrow);
    assert.deepEqual(rearmed.patch.queue.slice(1), f.backend().start(f.wp));
    if (name === 'herdr') {
      const queued = recordLaneStep(f.state, f.wp, f.backend().wait(f.wp)[0], exit(6), narrow).patch.queue;
      assert.equal(queued[0].command[1], LANE(f));
    }
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

test('fd50a09c (1): the pinned repo config\'s laneDeadlineMinutes sets the deadline at start, at an amendment and at reset-wp --to wait', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1' } });
  f.state.intent.repoConfig = { source: 'workspace', config: { laneDeadlineMinutes: 240 } };
  const span = (lane) => Date.parse(lane.deadline) - Date.parse(lane.startedAt);
  assert.equal(span(f.record(f.backend().start(f.wp)[0], ok('{}')).patch.lane), 240 * 60 * 1000);
  assert.equal(span(f.record(f.backend().prompt(f.wp, { amendment: true })[0], ok('{}')).patch.lane), 240 * 60 * 1000);
  // A resend is a retry: it renews nothing, whatever the config says.
  assert.equal(f.record(f.backend().prompt(f.wp, { amendment: true, resend: true })[0], ok('{}')).patch.lane, undefined);
  assert.equal(span(RESET_TARGETS.wait.lane(f.deps, f.state)), 240 * 60 * 1000);
  // A legacy or absent config keeps 120 minutes.
  for (const repoConfig of [undefined, { source: 'repo', config: null }, { source: 'workspace', config: {} }]) {
    assert.equal(laneDeadlineMs({ ...f.state, intent: { ...f.state.intent, repoConfig } }), 120 * 60 * 1000);
  }
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
  const blocked = h.record(wait, exit(4));
  assert.deepEqual([blocked.outcome, blocked.reason, blocked.cause], ['block', 'lane deadline', 'deadline']);
  assert.deepEqual(blocked.patch.queue, h.backend().stop(h.wp));
  assert.equal(blocked.patch.queue[0].command[2], 'stop');
});

test('occupancy until exit (C1-1, C1-2): a deadline block at cap 1 keeps the slot until the stop confirms exit', (t) => {
  const deadline = new Date(T0 + 120 * 60 * 1000).toISOString();
  for (const platform of ['win32', 'linux']) {
    const e = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY, startedAt: new Date(T0).toISOString(), deadline } });
    e.deps.platform = platform;
    e.tick(121 * 60 * 1000);
    const blocked = e.record(e.backend().wait(e.wp)[0], exit(0));
    assert.deepEqual([blocked.outcome, blocked.cause], ['block', 'deadline']);
    const [probe] = blocked.patch.queue;
    assert.deepEqual([blocked.patch.queue.length, probe.step, probe.part, probe.command.slice(2, 4)], [1, 'stop', 'probe', ['lane', 'alive']]);
    apply(e.wp, { ...blocked.patch, state: 'blocked' });
    const rival = { id: 'WP-01', state: 'pending', files: ['a.mjs'], dependsOn: [] };
    const state = { intent: { lanesCap: 1 }, wps: [e.wp, rival], dispatchHalt: null };
    assert.deepEqual(dispatchable(state), [], 'blocked but still running: holds the slot');
    // The probe saw our agent: the guarded kill and its confirmation follow.
    const matched = e.record(probe, exit(0, '', '{"ok":true,"alive":true,"pid":4242,"owner":"running"}'));
    const [kill, confirm] = matched.patch.queue;
    assert.equal(kill.part, 'kill');
    const killText = kill.command.join(' ');
    assert.ok(platform === 'win32' ? killText.includes('taskkill /PID 4242 /T /F') && killText.includes(`$id -eq '${IDENTITY}'`) : kill.command.at(-1) === IDENTITY && killText.includes('kill -TERM'), killText);
    assert.equal(e.record(kill, exit(128, 'ERROR: not found')).outcome, 'continue');
    const gone = e.record(confirm, exit(1));
    assert.deepEqual([gone.outcome, gone.patch.queue.map((a) => [a.step, a.part, a.command.slice(2, 4)]), gone.patch.lane.exitedAt],
      ['done', [['stop', 'reap', ['lane', 'reap']]], new Date(T0 + 121 * 60 * 1000).toISOString()], 'the confirmed exit reaps the worktree');
    apply(e.wp, gone.patch);
    assert.deepEqual(dispatchable(state).map((wp) => wp.id), ['WP-01']);
    assert.deepEqual(e.backend().stop(e.wp).map((a) => a.part), ['reap'], 'an exited lane has only its reap left');
  }
});

test('PID ownership (C2-1): a reused pid is never killed; the lane reads as exited', async (t) => {
  const f = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY, startedAt: new Date(T0).toISOString() } });
  f.table[identityArgv(4242, 'linux').join(' ')] = ok('2026-10-04T19:59:59.0000000Z notepad.exe\n');
  const alive = await runLaneVerb('alive', { runDir: f.runDir, wpId: 'WP-00', flags: {} }, f.deps);
  assert.deepEqual([alive.code, JSON.parse(alive.out).owner], [1, 'reused']);
  const [probe] = f.backend().stop(f.wp);
  const routed = f.record(probe, { code: alive.code, stdout: alive.out, stderr: '' });
  assert.deepEqual([routed.outcome, routed.patch.queue.map((a) => a.part), Boolean(routed.patch.lane.exitedAt)], ['done', ['reap'], true]);
  assert.match(routed.reason, /pid reused: not killed/);
  // No identity to compare: unverified, never killed.
  f.table[identityArgv(4242, 'linux').join(' ')] = ok('\n');
  assert.equal(JSON.parse((await runLaneVerb('alive', { runDir: f.runDir, wpId: 'WP-00', flags: {} }, f.deps)).out).owner, 'unverified');
  // The identity is recorded at spawn, through the executor.
  const s = lanes(t, { wpLane: { worktree: '/wt', briefPath: '/b.md' } });
  assert.equal((await runLaneVerb('spawn', { runDir: s.runDir, wpId: 'WP-00', flags: {}, state: s.saved() }, s.deps)).code, 0);
  assert.equal(s.saved().wps[0].lane.identity, IDENTITY);
  assert.ok(s.calls.includes(identityArgv(4242, 'linux').join(' ')));
});

test('guarded kill (C2-1): the win32 script\'s string literals are closed, an identity\'s quote doubled', () => {
  for (const identity of [IDENTITY, "2026-10-04T18:00:00Z o'brien.exe"]) {
    const [program, ...args] = guardedKillArgv(4242, identity, 'win32');
    const script = args.at(-1);
    assert.equal(program, 'powershell');
    // Doubled quotes are escapes; what remains must pair up.
    assert.equal(script.replace(/''/g, '').split("'").length % 2, 1, script);
    assert.ok(script.includes(`'${identity.replace(/'/g, "''")}'`), script);
  }
  const posix = guardedKillArgv(4242, IDENTITY, 'linux');
  assert.deepEqual(posix.slice(-2), ['4242', IDENTITY], 'identity passed as an argument, never spliced into the script');
});

test('cleanup survives an unconfirmed stop (C2-3): alive, alive, gone releases; alive x3 blocks as cleanup-unresolved, stop still queued', (t) => {
  const e = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY, startedAt: new Date(T0).toISOString() } });
  const [, confirm] = e.backend().kill(e.wp);
  // As the build runs it: the pending action heads the queue, and the wait is consumed before the confirmation re-runs.
  const later = { step: 'ratify', part: 'ruling' };
  e.wp.queue = [confirm, later];
  for (let i = 1; i <= 2; i += 1) {
    const again = e.record(confirm, exit(0));
    assert.deepEqual([again.outcome, again.patch.lane.stopConfirms, again.patch.queue[0].waitMs, again.patch.queue.slice(1)], ['wait', i, 10000, [confirm, later]], 'what was queued after the stop is kept');
    apply(e.wp, { ...again.patch, queue: again.patch.queue.slice(1) });
  }
  const released = e.record(confirm, exit(1));
  assert.deepEqual([released.outcome, released.patch.lane.stopConfirms, released.patch.queue.map((a) => a.part)], ['done', 0, ['reap', 'ruling']]);
  const stuck = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY, startedAt: new Date(T0).toISOString() } });
  stuck.wp.queue = [confirm];
  let routed;
  for (let i = 0; i < 3; i += 1) {
    routed = stuck.record(confirm, exit(0));
    apply(stuck.wp, { ...routed.patch, queue: routed.patch.queue.slice(1) });
  }
  assert.deepEqual([routed.outcome, routed.cause], ['block', 'cleanup-unresolved']);
  assert.deepEqual(routed.patch.queue, stuck.backend().stop(stuck.wp));
  assert.equal(stuck.wp.lane.exitedAt, undefined, 'occupancy held');
  // herdr: lane.mjs stop's exited-shell-blocked means the agent is gone.
  const h = lanes(t, { backend: 'herdr', wpLane: { startedAt: new Date(T0).toISOString() } });
  const shell = h.record(h.backend().stop(h.wp)[0], exit(1, '', '{"state":"exited-shell-blocked","resumeId":"x"}'));
  assert.deepEqual([shell.outcome, Boolean(shell.patch.lane.exitedAt)], ['done', true]);
});

test('herdr restart (C2-2): stop, start, amendment, deadline at cap 1 keeps the slot and queues a second stop', (t) => {
  const h = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1', briefPath: '/b.md' } });
  const b = h.backend();
  apply(h.wp, h.record(b.start(h.wp)[0], ok('{}')).patch);
  apply(h.wp, h.record(b.stop(h.wp)[0], ok('{}')).patch);
  assert.ok(h.wp.lane.exitedAt);
  h.tick(10 * 60 * 1000);
  apply(h.wp, h.record(b.start(h.wp)[0], ok('{}')).patch);
  assert.equal(h.wp.lane.exitedAt, null, 'a successful restart clears the exit marker');
  assert.equal(h.wp.lane.deadline, new Date(T0 + 130 * 60 * 1000).toISOString());
  h.tick(10 * 60 * 1000);
  apply(h.wp, h.record(b.prompt(h.wp, { amendment: true })[0], ok('{}')).patch);
  assert.equal(h.wp.lane.deadline, new Date(T0 + 140 * 60 * 1000).toISOString());
  const rival = { id: 'WP-01', state: 'pending', files: ['a.mjs'], dependsOn: [] };
  apply(h.wp, { state: 'blocked' });
  const state = { intent: { lanesCap: 1 }, wps: [h.wp, rival], dispatchHalt: null };
  assert.deepEqual(dispatchable(state), [], 'the restarted lane holds its slot');
  h.tick(121 * 60 * 1000);
  const late = h.record(b.wait(h.wp)[0], exit(4));
  assert.deepEqual([late.outcome, late.cause, late.patch.queue], ['block', 'deadline', b.stop(h.wp)]);
  assert.equal(late.patch.queue.length, 1);
});

test('startup retries are bounded (C2-4): three re-arms, then an admission block holding no slot', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1' } });
  const start = f.backend().start(f.wp)[0];
  let routed;
  let rearms = 0;
  for (let i = 0; i < 1000; i += 1) {
    routed = f.record(start, exit(7, 'admission refused'));
    apply(f.wp, routed.patch);
    if (routed.outcome !== 'wait') break;
    rearms += 1;
  }
  assert.deepEqual([rearms, routed.outcome, routed.cause, routed.patch.queue], [3, 'block', 'admission', []]);
  assert.deepEqual(dispatchable({ intent: { lanesCap: 1 }, wps: [{ ...f.wp, state: 'blocked' }, { id: 'WP-01', state: 'pending', files: ['a.mjs'], dependsOn: [] }], dispatchHalt: null }).map((wp) => wp.id), ['WP-01']);
  // A start that succeeds resets the count.
  assert.equal(f.record(start, ok('{}')).patch.lane.startRearms, 0);
});

test('start exit 3 (C2-8): the same structured dialog cause and one re-poll', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1' } });
  const start = f.backend().start(f.wp)[0];
  const dialog = exit(3, '', '{"state":"blocked","dialog":"Trust this folder?"}');
  const first = f.record(start, dialog);
  assert.deepEqual([first.outcome, first.cause, first.dialog, first.patch.queue[0].waitMs], ['wait', 'dialog', 'Trust this folder?', 60000]);
  assert.deepEqual(first.patch.queue[1].command, f.backend().wait(f.wp)[0].command);
  apply(f.wp, first.patch);
  const second = f.record(start, dialog);
  assert.deepEqual([second.outcome, second.cause, second.dialog], ['block', 'dialog', 'Trust this folder?']);
});

test('killed-lane cost (C2-9): recovered from the log or kept, marked incomplete', (t) => {
  const result = (session, cost) => JSON.stringify({ session_id: session, total_cost_usd: cost });
  const e = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY, logPath: 'x.log', costUsd: 0.2 } });
  const [, confirm] = e.backend().kill(e.wp);
  const recovered = e.record(confirm, exit(1), { read: () => `${result('s1', 0.3)}\n` });
  assert.deepEqual([recovered.patch.lane.costUsd, recovered.patch.lane.costComplete], [0.3, false]);
  const kept = e.record(confirm, exit(1), { read: () => '' });
  assert.deepEqual(['costUsd' in kept.patch.lane, kept.patch.lane.costComplete], [false, false]);
  // A natural exit with a result is complete; a reused pid's is not.
  const alive = e.backend().wait(e.wp)[0];
  const natural = e.record(alive, exit(1, '', '{"ok":true,"alive":false,"owner":"gone"}'), { read: () => `${result('s1', 0.3)}\n` });
  assert.equal(natural.patch.lane.costComplete, true);
  const reused = e.record(alive, exit(1, '', '{"ok":true,"alive":false,"owner":"reused"}'), { read: () => `${result('s1', 0.3)}\n` });
  assert.equal(reused.patch.lane.costComplete, false);
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
  assert.equal(done.patch.lane.exitedAt, new Date(T0).toISOString());
  // codex: the thread id, no cost.
  const c = lanes(t, { agent: 'codex', wpLane: { pid: 4242, logPath: 'x.log' } });
  const codexDone = c.record(c.backend().wait(c.wp)[0], exit(1), { read: () => CODEX_JSONL });
  assert.deepEqual([codexDone.patch.lane.sessionId, 'costUsd' in codexDone.patch.lane], [THREAD_ID, false]);
});

test('cost (C1-6): a session\'s total is cumulative, so each session\'s latest total, summed; a log with no result keeps the known cost', (t) => {
  // Measured shape: run 1 then `--resume` of the same session, which
  // reported run 1's cost plus its own.
  const run = (session, cost) => JSON.stringify({ type: 'result', session_id: session, total_cost_usd: cost });
  const resumed = `${run('s1', 0.073835)}\nstderr noise\n${run('s1', 0.078269)}\n`;
  assert.equal(laneCost(resumed), 0.078269);
  assert.equal(laneCost(`${resumed}${run('s2', 0.5)}\n`), 0.078269 + 0.5);
  assert.equal(laneCost('no result here\n'), null);
  const f = lanes(t, { wpLane: { pid: 4242, logPath: 'x.log', costUsd: 0.25 } });
  const alive = f.backend().wait(f.wp)[0];
  const once = f.record(alive, exit(1), { read: () => resumed });
  const again = f.record(alive, exit(1), { read: () => resumed });
  assert.deepEqual([once.patch.lane.costUsd, again.patch.lane.costUsd], [0.078269, 0.078269], 'recording twice does not double count');
  const empty = f.record(alive, exit(1), { read: () => 'conduct: lane spawn failed: x\n' });
  assert.equal('costUsd' in empty.patch.lane, false, 'never overwritten with null');
});

test('lane spawn (C1-1): a replayed spawn action returns its saved pid; a spawn or amendment while the pid runs is refused', async (t) => {
  const f = lanes(t, { wpLane: { worktree: '/wt', briefPath: '/b.md', logPath: join('x', 'lane.log') } });
  const start = { id: '7-start', step: 'start', command: f.backend().start(f.wp)[0].command };
  f.state.pending = start;
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  const first = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: {}, state: f.saved() }, f.deps);
  assert.equal(first.code, 0, first.out);
  // The verb saved, then the conductor crashed before `record`: the agent
  // runs the same pending action again.
  const replay = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: {}, state: f.saved() }, f.deps);
  assert.equal(replay.code, 0, replay.out);
  assert.deepEqual([JSON.parse(replay.out).pid, JSON.parse(replay.out).startedAt, JSON.parse(replay.out).replayed], [4242, JSON.parse(first.out).startedAt, true]);
  assert.equal(f.spawns.length, 1, 'one agent');
  // A distinct action while pid 4242 runs: refused, naming the pid.
  const later = f.saved();
  later.pending = { id: '9-start', step: 'start', command: start.command };
  const distinct = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: {}, state: later }, f.deps);
  assert.deepEqual([distinct.code, /pid 4242 is still running/.test(JSON.parse(distinct.out).error)], [5, true]);
  later.pending = { id: '10-prompt', step: 'prompt', command: [...start.command, '--amend', '/b.md'] };
  const amendment = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: { amend: '/b.md' }, state: later }, f.deps);
  assert.equal(amendment.code, 5);
  assert.equal(f.spawns.length, 1);
  // Once the exit is observed, an amendment spawns, even if the pid number was reused.
  later.wps[0].lane.exitedAt = new Date(T0).toISOString();
  later.wps[0].lane.sessionId = SESSION_ID;
  const resumed = await runLaneVerb('spawn', { runDir: f.runDir, wpId: 'WP-00', flags: { amend: '/b.md' }, state: later }, f.deps);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual([f.spawns.length, f.saved().wps[0].lane.exitedAt], [2, null]);
});

test('fences (C1-3): a marker inside a longer or mixed-character fence is not read', () => {
  const wp = { runtimeExercise: 'CLI: x' };
  const wrap = (open, close, inner = '```') => `## Runtime exercise\n\n${open}\n${inner}\nVerdict: exercised\nWould have shown: x\n${inner}\n${close}\n`;
  assert.equal(runtimeExerciseVerdict(wrap('````', '````'), wp), 'missing');
  assert.equal(runtimeExerciseVerdict(wrap('~~~', '~~~'), wp), 'missing');
  assert.equal(runtimeExerciseVerdict(wrap('~~~', '~~~', '````'), wp), 'missing');
  // A closer needs the opener's character and at least its length.
  assert.equal(runtimeExerciseVerdict('## Runtime exercise\n\n````\n```\nVerdict: exercised\nWould have shown: x\n', wp), 'missing');
  assert.equal(runtimeExerciseVerdict('## Runtime exercise\n\n```\nquoted\n```\nVerdict: exercised\nWould have shown: x\n', wp), 'exercised');
});

test('diagnostics (C1-7): a failing runtime exercise names the missing heading or marker', async (t) => {
  const f = lanes(t);
  const check = async (text) => {
    f.report(text);
    return JSON.parse((await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: { runtimeOnly: true } }, f.deps)).out).failures.join('; ');
  };
  assert.match(await check(report({ runtime: null })), /missing: no "## Runtime exercise" heading/);
  assert.match(await check(report({ runtime: '- Verdict: exercised' })), /missing: no line reading exactly "Verdict: exercised"/);
  assert.match(await check(report({ runtime: 'Verdict: exercised' })), /vacuous: "Verdict: exercised" with no "Would have shown:/);
});

test('queue ownership (C1-8): every block, amend and done sets patch.queue; a failed fetch leaves no create action queued', (t) => {
  const e = lanes(t, { wpLane: { pid: 4242 } });
  const fetch = e.backend().create(e.wp)[0];
  const failed = e.record(fetch, exit(128, 'fatal: could not read from remote'));
  assert.deepEqual([failed.outcome, failed.patch.queue], ['block', []]);
  const results = [];
  for (const name of ['exec', 'herdr']) {
    const f = lanes(t, { backend: name, wpLane: { paneId: 'w1:p1', briefPath: '/b.md', pid: 4242 } });
    for (const act of allSteps(f.backend(), f.wp)) {
      for (const result of [exit(1, 'boom'), exit(2, 'usage'), exit(5, '', '{"ok":false,"outcome":"built","failures":["x"]}'), ok('[]')]) {
        results.push([act, f.record(act, result)]);
      }
    }
  }
  const terminal = results.filter(([, routed]) => ['block', 'amend', 'done'].includes(routed.outcome));
  assert.ok(terminal.length > 20, String(terminal.length));
  for (const [act, routed] of terminal) assert.ok(Array.isArray(routed.patch.queue), `${act.step}/${act.part}: ${routed.outcome}`);
  // done carries cleanup only (C1-13).
  for (const [, routed] of terminal.filter(([, r]) => r.outcome === 'done')) assert.ok(routed.patch.queue.every((act) => act.step === 'stop'));
});

test('outcome first (C1-9): the report check precedes the shape check on herdr; a malformed refuted report is still refuted', async (t) => {
  const h = lanes(t, { backend: 'herdr' });
  assert.deepEqual(h.backend().check(h.wp).map((act) => act.part ?? act.step), ['report', 'shape', 'pr-lookup', 'pr']);
  const e = lanes(t);
  e.report('## Outcome\n\nrefuted: the premise fails\n');
  const result = await runLaneVerb('check', { runDir: e.runDir, wpId: 'WP-00', flags: {} }, e.deps);
  assert.deepEqual([result.code, JSON.parse(result.out).outcome], [0, 'refuted']);
  assert.deepEqual(e.calls, [], 'no shape, commit or PR check on a refuted report');
});

test('failure reasons (C1-14): no lane.mjs log banner, the structured error field only', (t) => {
  const h = lanes(t, { backend: 'herdr' });
  const create = h.backend().create(h.wp).at(-1);
  const banner = 'lane: log /run/lane-runner.jsonl (resolved from --log)';
  assert.equal(h.record(create, exit(2, banner, '{"error":"branch already exists: conduct/demo/wp-00"}')).reason, 'branch already exists: conduct/demo/wp-00');
  const shape = h.backend().check(h.wp)[1];
  const failed = h.record(shape, exit(5, banner, '{"ok":false,"failedExpectation":"--expect-report r.md: ## Debrief is missing","evidence":{"path":"r.md"}}'));
  assert.equal(failed.reason, 'shape check: --expect-report r.md: ## Debrief is missing');
});

test('herdr wait exits map to outcomes (D17, D19.17)', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/run/lane-wp-00.md' } });
  const wait = f.backend().wait(f.wp)[0];
  assert.deepEqual(wait.command, ['node', LANE(f), 'wait', 'demo-wp-00', '--until', 'done', '--until', 'idle', '--timeout', '60000', '--log', LOG(f)]);
  assert.equal(f.record(wait, ok('{"state":"done"}')).outcome, 'continue');
  for (const code of [1, 2]) {
    const result = f.record(wait, exit(code, `lane: daemon said no (${code})`));
    assert.deepEqual([result.outcome, result.cause], ['block', 'error']);
    assert.match(result.reason, new RegExp(`daemon said no \\(${code}\\)`));
  }
  const timeout = f.record(wait, exit(4));
  assert.equal(timeout.outcome, 'wait');
  assert.deepEqual([timeout.patch.queue[0].kind, timeout.patch.queue[0].waitMs], ['wait', 0]);
  assert.deepEqual(timeout.patch.queue[1].command, wait.command);
  const planLow = f.record(wait, exit(6));
  assert.equal(planLow.outcome, 'continue');
  assert.equal(planLow.patch.queue[0].step, 'fallback');
  assert.deepEqual(planLow.patch.queue[0].command, ['node', LANE(f), 'fallback', 'demo-wp-00', '--to', 'claude', '--model', 'claude-opus-5-5', '--reasoning', 'high', '--log', LOG(f)]);
  // 93d852e6: a claude lane's usage limit (read from its transcript) blocks with the reset time; no fallback.
  const limited = f.record(wait, exit(6, '', JSON.stringify({ state: 'plan-refused', refusalShape: 'transcript', rateLimitType: 'seven_day', resetsAt: '2026-10-09T00:00:00.000Z', refusal: "You've hit your weekly limit · resets 7pm (America/Chicago)" })));
  assert.deepEqual([limited.outcome, limited.cause, limited.patch.queue], ['block', 'error', []]);
  assert.match(limited.reason, /^usage limit: .*\(seven_day\); it resets at 2026-10-09T00:00:00\.000Z\. You've hit your weekly limit/);
  const capacity = f.record(wait, exit(8));
  assert.equal(capacity.outcome, 'continue');
  assert.deepEqual(capacity.patch.queue[0].command, ['node', LANE(f), 'prompt', 'demo-wp-00', '--file', '/run/lane-wp-00.md', '--allow-missing', 'a.mjs', '--amendment', '--no-ruling', '--log', LOG(f)]);
});

test('wait exit 3 (C1-4, C1-10): a structured dialog cause, one re-poll after 60 s, the second consecutive dialog blocks', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/b.md' } });
  const wait = f.backend().wait(f.wp)[0];
  const dialogResult = exit(3, 'lane: log x (resolved from --log)', '{"state":"blocked","dialog":"Allow this command?"}');
  const first = f.record(wait, dialogResult);
  assert.deepEqual([first.outcome, first.cause, first.dialog, first.patch.lane.dialogPolls], ['wait', 'dialog', 'Allow this command?', 1]);
  assert.deepEqual([first.patch.queue[0].kind, first.patch.queue[0].waitMs], ['wait', 60000]);
  assert.deepEqual(first.patch.queue[1].command, wait.command);
  apply(f.wp, first.patch);
  // The count is on the WP: a replay of the same record cannot reset it.
  const second = f.record(wait, dialogResult);
  assert.deepEqual([second.outcome, second.cause, second.dialog, second.patch.queue], ['block', 'dialog', 'Allow this command?', []]);
  // A poll in between that is not a dialog resets the count.
  apply(f.wp, f.record(wait, exit(4)).patch);
  assert.equal(f.record(wait, dialogResult).outcome, 'wait');
});

test('capacity recovery is bounded and never renews the deadline (C1-5)', (t) => {
  const deadline = new Date(T0 + 120 * 60 * 1000).toISOString();
  const f = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/b.md', startedAt: new Date(T0).toISOString(), deadline } });
  const wait = f.backend().wait(f.wp)[0];
  const first = f.record(wait, exit(8));
  assert.deepEqual([first.outcome, first.patch.lane.capacityResent, first.patch.queue[0].part], ['continue', true, 'resend']);
  apply(f.wp, first.patch);
  // The automatic re-send renews nothing.
  assert.deepEqual(f.record(first.patch.queue[0], ok('{}')).patch, {});
  const second = f.record(wait, exit(8));
  assert.deepEqual([second.outcome, second.cause, second.patch.queue], ['block', 'error', []]);
  // A conductor amendment renews the deadline and the allowance.
  const amendment = f.backend().prompt(f.wp, { amendment: true })[0];
  f.tick(30 * 60 * 1000);
  const renewed = f.record(amendment, ok('{}')).patch.lane;
  assert.deepEqual([renewed.capacityResent, renewed.deadline], [false, new Date(T0 + 150 * 60 * 1000).toISOString()]);
  // Past the deadline the deadline wins over every recovery route.
  const late = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/b.md', deadline } });
  late.tick(121 * 60 * 1000);
  for (const code of [3, 4, 6, 8]) {
    const result = late.record(late.backend().wait(late.wp)[0], exit(code, '', '{"dialog":"x"}'));
    assert.deepEqual([result.outcome, result.cause], ['block', 'deadline'], `exit ${code}`);
  }
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

test('PR lookup: the top-level ## PR or the latest amendment ### PR may name the head; the check fails only when neither does', (t) => {
  const f = lanes(t);
  const lookup = f.backend().check(f.wp).find((act) => act.step === 'pr-lookup');
  const head = `ed889f8${'0'.repeat(33)}`;
  const github = ok(JSON.stringify([{ number: 7, headRefOid: head, state: 'OPEN' }]));
  const amendment = (n, prLine) => `## Amendment ${n}\n\n| Comment | Verdict | Evidence | Commit |\n|---|---|---|---|\n| \`101\` | fixed | red | \`ed889f8\` |\n\n${prLine === null ? '' : `### PR (amendment)\n\n${prLine}\n\n`}### Forks I decided that the brief did not settle\n\nNone\n`;
  // The top-level ## PR still names the pre-amendment head; the amendment pushed and said so.
  f.report(`${report({ pr: '#7 · 0105e2c' })}\n${amendment(1, '#7, head `ed889f8`, CI pass.')}`);
  assert.equal(f.record(lookup, github).outcome, 'continue');
  // The lane updated the top-level ## PR in place; an earlier amendment's ### PR is history.
  f.report(`${report({ pr: '#7 · ed889f8' })}\n${amendment(1, '#7, head `0105e2c`.')}\n${amendment(2, null)}`);
  assert.equal(f.record(lookup, github).outcome, 'continue');
  // Amendment 1 named the pushed head; amendment 2 pushed nothing and wrote no ### PR.
  f.report(`${report({ pr: '#7 · 0105e2c' })}\n${amendment(1, '#7, head `ed889f8`.')}\n${amendment(2, null)}`);
  assert.equal(f.record(lookup, github).outcome, 'continue');
  // Neither claim names the head: amend, naming both.
  f.report(`${report({ pr: '#7 · 0105e2c' })}\n${amendment(1, '#7, head `84816ef`.')}\n${amendment(2, null)}`);
  const stale = f.record(lookup, github);
  assert.equal(stale.outcome, 'amend');
  assert.match(stale.reason, /## PR says #7 at 0105e2c; ## Amendment 1's ### PR says #7 at 84816ef; GitHub has #7 at ed889f8/);
  // A fenced "### PR" line is not a heading.
  f.report(`${report({ pr: '#7 · 0105e2c' })}\n## Amendment 1\n\n\`\`\`\n### PR\n#7 ed889f8\n\`\`\`\n`);
  assert.equal(f.record(lookup, github).outcome, 'amend');
});

// ---------------------------------------------------------------- herdr argv

test('herdr: each action\'s argv, every one with --log (D17, D19.17)', (t) => {
  const f = lanes(t, { backend: 'herdr', wpLane: { paneId: 'w1:p1', briefPath: '/run/lane-wp-00.md' } });
  const b = f.backend();
  const lane = (verb, ...args) => ['node', LANE(f), verb, ...args, '--log', LOG(f)];
  assert.deepEqual(b.admit(f.wp).map((act) => act.command), [lane('admit')]);
  assert.deepEqual(b.create(f.wp)[2].command, lane('create', '--repo', f.repo, '--branch', 'conduct/demo/wp-00', '--base', 'origin/main', '--label', 'demo-wp-00', '--slug', 'demo-wp-00'));
  assert.deepEqual(b.start(f.wp)[0].command, lane('start', 'demo-wp-00', '--pane', 'w1:p1', '--kind', 'claude', '--model', 'claude-opus-5-5', '--reasoning', 'high',
    '--stop-hook', STOP_HOOK(f)));
  // The WP's Create paths ride as --allow-missing: lane.mjs prompt refuses a
  // brief naming an absent path, and these are the paths the lane creates (ec7b1192).
  assert.deepEqual(b.prompt(f.wp)[0].command, lane('prompt', 'demo-wp-00', '--file', '/run/lane-wp-00.md', '--allow-missing', 'a.mjs'));
  assert.deepEqual(b.prompt({ ...f.wp, files: ['src/x.ts', 'src/x.test.ts'], creates: ['src/x.test.ts'] })[0].command,
    lane('prompt', 'demo-wp-00', '--file', '/run/lane-wp-00.md', '--allow-missing', 'src/x.test.ts'));
  assert.deepEqual(b.check(f.wp).map((act) => act.command), [
    ['node', CONDUCT(f), 'lane', 'check', '--run', f.runDir, '--wp', 'WP-00', '--runtime-only'],
    lane('check', 'demo-wp-00', '--expect-report', join(f.runDir, 'lane-wp-00-report.md')),
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

// ec7b1192 post-merge council (Major): exempting every Files entry let a moved
// or renamed Modify target through, the stale premise the check exists for.
test('allowedMissing: Create paths, and a Modify path only when another WP of the run creates it', () => {
  const wp = { id: 'WP-02', wave: 2, files: ['src/new.ts', 'src/old.ts', 'src/made-by-01.ts', 'gen/out.ts'], creates: ['src/new.ts'] };
  const state = { wps: [
    { id: 'WP-01', wave: 1, files: ['src/made-by-01.ts'], creates: ['src/made-by-01.ts', 'gen/'] },
    wp,
  ] };
  const allowed = allowedMissing(state, wp);
  assert.ok(allowed.includes('src/new.ts'), '(c) a Create path is exempt');
  assert.ok(allowed.includes('src/made-by-01.ts'), '(b) a Modify path an earlier WP creates is exempt');
  assert.ok(allowed.includes('gen/out.ts'), 'a Modify path under a directory another WP creates is exempt');
  assert.equal(allowed.includes('src/old.ts'), false, '(a) a Modify path no WP creates is not exempt');
  assert.deepEqual(allowedMissing({ wps: [wp] }, { ...wp, creates: undefined }), [], 'a record without creates exempts nothing');
});

// Review of #220 (codex): only a WP that runs first can supply the file.
test('allowedMissing: a Modify path a LATER WP creates is not exempt; an earlier wave or a named dependency is', () => {
  const wp = { id: 'WP-02', wave: 2, dependsOn: [], files: ['src/later.ts', 'src/earlier.ts', 'src/dep.ts'], creates: [] };
  const state = { wps: [
    { id: 'WP-01', wave: 1, creates: ['src/earlier.ts'] },
    wp,
    { id: 'WP-03', wave: 3, creates: ['src/later.ts'] },
    { id: 'WP-04', wave: 2, creates: ['src/dep.ts'] },
  ] };
  assert.deepEqual(allowedMissing(state, wp), ['src/earlier.ts']);
  assert.deepEqual(allowedMissing(state, { ...wp, dependsOn: ['WP-04'] }), ['src/earlier.ts', 'src/dep.ts']);
});

test('allowedMissing → lane.mjs prompt: a missing Modify path no WP creates is refused; one an earlier WP creates is sent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workit-allow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, 'projects', 'repo-wt-x');
  mkdirSync(worktree, { recursive: true });
  const brief = join(dir, 'brief.md');
  writeFileSync(brief, 'Edit `src/old.ts` and `src/made-by-01.ts`; add `src/new.ts`.', 'utf8');
  const log = join(dir, 'lane-runner.jsonl');
  writeFileSync(`${log}.state.json`, JSON.stringify({ creates: [], lanes: { 'lane-x': { pane: 'w1:p2', kind: 'claude', path: worktree, branch: 'b', base: 'main' } } }), 'utf8');
  const wp = { id: 'WP-02', wave: 2, files: ['src/new.ts', 'src/old.ts', 'src/made-by-01.ts'], creates: ['src/new.ts'] };
  const state = { wps: [{ id: 'WP-01', wave: 1, creates: ['src/made-by-01.ts'] }, wp] };
  const exec = () => ({ code: 0, stdout: '{"result":{"agents":[{"name":"lane-x","state":"done"}],"state":"working","accepted":true}}', stderr: '' });
  const send = (extra) => runLane(['prompt', 'lane-x', '--file', brief, ...allowedMissing(state, extra).flatMap((p) => ['--allow-missing', p]), '--log', log], { exec });
  const refused = await send(wp);
  assert.equal(refused.exit, 2, JSON.stringify(refused.output));
  assert.match(refused.output.error, /src\/old\.ts/);
  assert.doesNotMatch(refused.output.error, /src\/made-by-01\.ts|src\/new\.ts/);
  const sent = await send({ ...wp, files: ['src/new.ts', 'src/made-by-01.ts'], creates: ['src/new.ts', 'src/old.ts'] });
  assert.equal(sent.exit, 0, JSON.stringify(sent.output));
});

test('herdr amendments: a receipt only when a resolver can resolve it (D16)', (t) => {
  const answer = { key: 'a', receiptId: '91cc7678-0000-4000-8000-000000000000' };
  const withResolver = lanes(t, { backend: 'herdr', env: { WORKIT_RECEIPT_RESOLVER: 'node resolve.mjs' }, wpLane: { briefPath: '/b.md' } });
  const named = withResolver.backend().prompt(withResolver.wp, { amendment: true, answer })[0];
  // [node, lane.mjs, prompt, <lane>, --file, <brief>, --allow-missing, a.mjs, …]
  assert.deepEqual(named.command.slice(8, -2), ['--amendment', '--ruling-receipt', answer.receiptId, '--quest', 'anchor-uuid']);
  assert.equal(named.data, undefined);
  const unset = lanes(t, { backend: 'herdr', wpLane: { briefPath: '/b.md' } });
  const brief = unset.backend().prompt(unset.wp, { amendment: true, answer })[0];
  assert.deepEqual([brief.command.slice(8, -2), brief.data], [['--amendment', '--no-ruling'], { rulingCarried: 'brief' }]);
  const core = unset.backend().prompt(unset.wp, { amendment: true, answer: { key: 'b', receiptId: null } })[0];
  assert.deepEqual(core.command.slice(8, -2), ['--amendment', '--no-ruling']);
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
    '--output-format', 'json', '--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: STOP_HOOK(f), timeout: 300 }] }] } }),
    `Read ${BRIEF(f)} and execute it exactly.`]);
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

// 7df6d47c (H16): after a land rebase onto a main that merged a sibling WP, the
// evidence checks read the WP's own diff, from the rebase's new base, and not
// the sibling's merged tests as the lane's own.
test('exec: lane check after a land rebase diffs from the rebase\'s new base, not the stale lane.base (7df6d47c)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workit-lanes-rebased-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) git('config', key, value);
  const commit = (file, text) => {
    writeFileSync(join(root, file), text);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const oldBase = commit('base.txt', 'base\n');
  git('switch', '-q', '-c', 'conduct/demo/wp-00');
  const from = commit('a.mjs', 'export const a = 1;\n');
  git('switch', '-q', 'main');
  const newBase = commit('sibling.test.mjs', "test('a sibling WP\\'s merged test', () => {});\n");
  git('rebase', '-q', 'main', 'conduct/demo/wp-00');
  const to = git('rev-parse', 'HEAD');
  const f = lanes(t, { wpLane: { worktree: root, branch: 'conduct/demo/wp-00', base: oldBase } });
  f.wp.rebases = [{ from, to, oldBase, newBase, equivalent: true }];
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  const table = f.deps.exec;
  f.deps.exec = (program, args) => (program === 'git' ? real(args) : table(program, args));
  f.report(report());
  const result = await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: {} }, f.deps);
  const out = JSON.parse(result.out);
  assert.deepEqual([result.code, out.failures], [0, []], out.failures.join('; '));
});

// b118b800: a gate amendment had the lane rebase itself onto origin/main, which
// had moved on; no land rebase recorded it. Rule 7 counted main's tests from
// the recorded base as the lane's own. The check measures the fork point from
// origin/<default> now, so only the branch's own new test is named.
test('exec: lane check after the lane rebased itself onto a moved origin/main names only the branch\'s own new tests (b118b800)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workit-lanes-self-rebased-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) git('config', key, value);
  const commit = (file, text) => {
    writeFileSync(join(root, file), text);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const oldBase = commit('base.txt', 'base\n');
  git('switch', '-q', '-c', 'conduct/demo/wp-00');
  commit('own.test.mjs', "test('the lane\\'s own new test', () => {});\n");
  git('switch', '-q', 'main');
  commit('drive.test.mjs', "test('main\\'s drive test', () => {});\n");
  commit('wake.test.mjs', "test('main\\'s wake test', () => {});\n");
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('rebase', '-q', 'origin/main', 'conduct/demo/wp-00');
  const f = lanes(t, { wpLane: { worktree: root, branch: 'conduct/demo/wp-00', base: oldBase } });
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  const table = f.deps.exec;
  f.deps.exec = (program, args) => (program === 'git' ? real(args) : table(program, args));
  f.report(report());
  const result = await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: {} }, f.deps);
  const out = JSON.parse(result.out);
  const rule7 = out.failures.filter((failure) => /rule 7/.test(failure));
  assert.equal(rule7.length, 1, out.failures.join('; '));
  assert.match(rule7[0], /^1 new test\(s\) named in no Negative controls run .*own\.test\.mjs:1 "the lane's own new test"$/);
  assert.doesNotMatch(rule7[0], /drive\.test|wake\.test/);
});

test('exec: lane check passes a good report and fails a missing Debrief heading or runtime exercise', async (t) => {
  const f = lanes(t, { wpLane: { worktree: '/wt', branch: 'conduct/demo/wp-00' } });
  f.table[`git -C /wt rev-list --count ${SHA40}..HEAD`] = ok('1\n');
  const DIFF = `git -C /wt diff --no-color --no-ext-diff --no-textconv --full-index --no-renames ${SHA40}...HEAD`;
  f.table[DIFF] = ok('');
  const check = (flags = {}) => runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags }, f.deps).then((result) => ({ ...result, out: JSON.parse(result.out) }));
  f.report(report());
  const good = await check();
  assert.deepEqual([good.code, good.out.ok, good.out.outcome, good.out.verdict, good.out.failures], [0, true, 'built', 'exercised', []]);
  // e4ad108b: the evidence checks read the lane's diff; one that cannot be read is "did not run", never a pass.
  f.table[DIFF] = ok(['diff --git a/src/a.test.mjs b/src/a.test.mjs', '--- a/src/a.test.mjs', '+++ b/src/a.test.mjs', '@@ -0,0 +1 @@', "+test('an unnamed new test', () => {});"].join('\n'));
  assert.match((await check()).out.failures.join('; '), /1 new test\(s\) named in no Negative controls run .*src\/a\.test\.mjs:1 "an unnamed new test"/);
  f.table[DIFF] = { code: 128, stdout: '', stderr: 'fatal: bad revision' };
  assert.match((await check()).out.failures.join('; '), /the evidence checks did not run: git diff from base/);
  f.table[DIFF] = ok('');
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
  const danger = '\n## Merge danger\n\nDoor: two-way\nBlast radius: the demo WP\n';
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'conduct/demo/wp-00', state: 'OPEN', body: report() + danger }));
  assert.equal((await check({ pr: '7' })).code, 0);
  // fca05d92: the PR body needs its `## Merge danger` marker lines.
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'conduct/demo/wp-00', state: 'OPEN', body: report() }));
  assert.match((await check({ pr: '7' })).out.failures.join('; '), /PR body: ## Merge danger is missing/);
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'conduct/demo/wp-00', state: 'OPEN', body: report() + danger.replace('Door: two-way', '- Door: two-way') }));
  assert.match((await check({ pr: '7' })).out.failures.join('; '), /PR body: ## Merge danger line \d+ is not a Door: marker line/);
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'other', state: 'CLOSED', body: 'no debrief' }));
  // Head, state, the Debrief, and (fca05d92) the missing ## Merge danger.
  assert.equal((await check({ pr: '7' })).out.failures.length, 4);
  const pr = f.backend().check(f.wp).at(-1);
  assert.deepEqual(pr.command.slice(-2), ['--pr', '{pr.number}']);
});

test('exec: lane alive exits 1 for a dead pid', async (t) => {
  const live = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY } });
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
  // The marker lines appear exactly as the reader accepts them (C1-7): the
  // brief's own example passes runtimeExerciseVerdict.
  const lines = brief.split(/\r?\n/);
  const shown = [lines.find((line) => line.startsWith('Verdict: ')), lines.find((line) => line.startsWith('Would have shown: '))];
  assert.deepEqual(shown.map(Boolean), [true, true]);
  // Filled in, the shape passes; copied as it stands it never does (C2-7).
  assert.equal(runtimeExerciseVerdict(`## Runtime exercise\n\nVerdict: exercised\nWould have shown: exit 1\n`, { runtimeExercise: 'CLI: x' }), 'exercised');
  assert.equal(runtimeExerciseVerdict(`## Runtime exercise\n\n${shown.join('\n')}\n`, { runtimeExercise: 'CLI: x' }), 'missing');
  assert.equal(lines.filter((line) => /^Verdict: /.test(line)).length, 1);
});

test('duplicate verdicts (C2-7): more than one Verdict line is vacuous, naming them; a copy of the old four-line template no longer passes', () => {
  const wp = { runtimeExercise: 'CLI: x' };
  const copied = '## Runtime exercise\n\nVerdict: exercised\nVerdict: vacuous\nVerdict: not exercised\nVerdict: no runtime surface\n\nWould have shown: cat: hello.txt: No such file or directory\n';
  assert.equal(runtimeExerciseVerdict(copied, wp), 'vacuous');
  assert.equal(runtimeExerciseVerdict('## Runtime exercise\n\nVerdict: exercised\nVerdict: exercised\nWould have shown: x\n', wp), 'vacuous');
});

test('duplicate verdicts (C2-7): the lane check names the duplicates', async (t) => {
  const f = lanes(t);
  f.report(report({ runtime: 'Verdict: exercised\nVerdict: vacuous\nWould have shown: x' }));
  const out = JSON.parse((await runLaneVerb('check', { runDir: f.runDir, wpId: 'WP-00', flags: { runtimeOnly: true } }, f.deps)).out);
  assert.match(out.failures.join('; '), /vacuous: 2 Verdict lines \("Verdict: exercised", "Verdict: vacuous"\)/);
});

test('lane-brief.md: the runtime section, the no-/conduct line and every slot', () => {
  const brief = readFileSync(join(REPO_ROOT, 'skills', 'conduct', 'templates', 'lane-brief.md'), 'utf8');
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

test('exec cleanup (5c93c8cb): an observed exit reaps ahead of what follows; a merged lane\'s worktree is removed without --force; neither a survivor nor a refused removal blocks', (t) => {
  const worktree = join(tmpdir(), 'demo-wt-wp-00');
  const e = lanes(t, { wpLane: { pid: 4242, identity: IDENTITY, startedAt: new Date(T0).toISOString(), worktree } });
  const [wait] = e.backend().wait(e.wp);
  const later = { step: 'check', part: 'report' };
  e.wp.queue = [wait, later];
  const exited = e.record(wait, exit(1, '', '{"ok":true,"alive":false,"pid":4242,"owner":"gone"}'));
  assert.deepEqual([exited.outcome, exited.patch.queue.map((a) => a.part)], ['continue', ['reap', 'report']]);
  assert.deepEqual(exited.patch.queue[0].command.slice(2, 4), ['lane', 'reap'], 'in process: the core path runs no lane.mjs argv');
  const [reap] = e.backend().reap(e.wp);
  const survived = e.record(reap, exit(1, '', JSON.stringify({ ok: false, state: 'survivors', orphans: [{ pid: 9, cmd: 'x' }], survivors: [{ pid: 9, cmd: 'x' }] })));
  assert.deepEqual([survived.outcome, survived.patch.lane.reap.state, survived.patch.lane.reap.orphans, survived.patch.lane.reap.survivors], ['continue', 'survivors', 1, 1]);
  const [remove] = e.backend().remove(e.wp);
  assert.deepEqual(remove.command, ['git', '-C', resolve(e.repo), 'worktree', 'remove', worktree]);
  const refused = e.record(remove, exit(128, 'fatal: contains modified or untracked files, use --force to delete it'));
  assert.deepEqual([refused.outcome, refused.patch.lane.removed], ['continue', false]);
  assert.match(refused.patch.lane.removeError, /modified or untracked/);
  assert.equal(e.record(remove, exit(0)).patch.lane.removed, true);
  const herdr = lanes(t, { backend: 'herdr' });
  const [sweep] = herdr.backend().remove(herdr.wp);
  assert.deepEqual([sweep.part, sweep.command[1].endsWith('lane.mjs'), sweep.command[2]], ['remove', true, 'sweep'], 'herdr lanes are swept by lane.mjs');
});

test('lane reap (5c93c8cb): kills what runs from the WP\'s worktree, in process, and exits 1 on a survivor', async (t) => {
  const worktree = join(tmpdir(), 'demo-wt-wp-00');
  const e = lanes(t, { wpLane: { worktree } });
  let rows = [{ pid: 501, cmd: `node ${join(worktree, 'vite.js')}` }, { pid: 502, cmd: `node ${join(`${worktree}2`, 'vite.js')}` }];
  const killed = [];
  const exec = (program, args) => {
    if (program === 'ps') return ok(rows.map((row) => `${row.pid} 1 ${row.cmd}`).join('\n'));
    if (program === 'kill') {
      killed.push(args.at(-1));
      rows = rows.filter((row) => String(row.pid) !== args.at(-1));
      return ok();
    }
    return exit(127, `unexpected: ${program}`);
  };
  const reaped = await runLaneVerb('reap', { runDir: e.runDir, wpId: 'WP-00', flags: {} }, { ...e.deps, exec });
  assert.deepEqual([reaped.code, JSON.parse(reaped.out).state, JSON.parse(reaped.out).orphans.map((row) => row.pid), killed], [0, 'reaped', [501], ['501']]);
  rows = [{ pid: 503, cmd: `node ${join(worktree, 'vite.js')}` }];
  const stuck = await runLaneVerb('reap', { runDir: e.runDir, wpId: 'WP-00', flags: {} }, { ...e.deps, exec: (program, args) => (program === 'kill' ? ok() : exec(program, args)) });
  assert.deepEqual([stuck.code, JSON.parse(stuck.out).state, JSON.parse(stuck.out).survivors.map((row) => row.pid)], [1, 'survivors', [503]]);
  assert.equal((await runLaneVerb('reap', { runDir: e.runDir, wpId: 'WP-00', flags: { x: true } }, e.deps)).code, 2, 'reap takes no flags');
});

// ---------------------------------------------------------------- stop-check (d3adb4ee)

// A lane whose report, branch and PR all pass the conductor's checks; tests
// break one piece at a time. `stop(input)` runs the sub-verb as the Stop hook does.
function stopCheckLane(t, more = {}) {
  const f = lanes(t, { wpLane: { worktree: '/wt', branch: 'conduct/demo/wp-00' }, ...more });
  f.table[`git -C /wt rev-list --count ${SHA40}..HEAD`] = ok('1\n');
  f.table[`git -C /wt diff --no-color --no-ext-diff --no-textconv --full-index --no-renames ${SHA40}...HEAD`] = ok('');
  f.table['gh pr list --repo o/r --head conduct/demo/wp-00 --state all --json number,headRefOid,state'] = ok(JSON.stringify([{ number: 7, headRefOid: `abcdef1${'0'.repeat(33)}`, state: 'OPEN' }]));
  const danger = '\n## Merge danger\n\nDoor: two-way\nBlast radius: the demo WP\n';
  f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'conduct/demo/wp-00', state: 'OPEN', body: report() + danger }));
  f.report(report());
  const verdictPath = join(f.runDir, 'lane-wp-00-stopcheck.json');
  const stop = async (input = { session_id: 's1', background_tasks: [] }) => {
    const result = await runLaneVerb('stop-check', { runDir: f.runDir, wpId: 'WP-00', flags: {} }, { ...f.deps, readStdin: () => (typeof input === 'string' ? input : JSON.stringify(input)) });
    return { code: result.code, out: JSON.parse(result.out), file: JSON.parse(readFileSync(verdictPath, 'utf8')) };
  };
  return { ...f, stop, verdictPath };
}

test('stop-check: a lane that passes every conductor check may stop, and the verdict file says pass', async (t) => {
  const f = stopCheckLane(t);
  const passed = await f.stop();
  assert.deepEqual([passed.code, passed.out.block, passed.out.verdict, passed.file.verdict, passed.file.sessionId, passed.file.blocks], [0, false, 'pass', 'pass', 's1', 0]);
  // The conductor's own PR view ran: the hook checks what the conductor checks.
  assert.ok(f.calls.includes('gh pr view 7 --repo o/r --json headRefName,state,body'));
  assert.equal(existsSync(join(f.runDir, 'state.json')) && JSON.stringify(f.saved()) === JSON.stringify(f.state), true, 'state.json is never written');
});

test('stop-check: a failure the conductor would amend blocks the stop with its reason, STOP_CHECK_BLOCKS times, then the lane stops failed', async (t) => {
  const f = stopCheckLane(t);
  rmSync(join(f.runDir, 'lane-wp-00-report.md'));
  for (let n = 1; n <= STOP_CHECK_BLOCKS; n++) {
    const blocked = await f.stop();
    assert.deepEqual([blocked.code, blocked.out.block, blocked.out.verdict, blocked.file.blocks], [0, true, 'blocked', n]);
    assert.match(blocked.out.instruction, new RegExp(`stop-check ${n} of ${STOP_CHECK_BLOCKS}`));
    assert.match(blocked.out.instruction, /no report at .*lane-wp-00-report\.md/);
  }
  const failed = await f.stop();
  assert.deepEqual([failed.out.block, failed.out.verdict, failed.file.blocks], [false, 'failed', STOP_CHECK_BLOCKS]);
  assert.match(failed.out.reason, /no report at/);
  // A new session (a fresh start) or a new amendment round gets a fresh budget.
  assert.deepEqual([(await f.stop({ session_id: 's2' })).out.blocks], [1]);
  f.state.wps[0].amendment = { n: 1 };
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  assert.deepEqual([(await f.stop({ session_id: 's2' })).file.round, (await f.stop({ session_id: 's2' })).file.blocks], [1, 2]);
});

test('stop-check: each of the conductor\'s amend findings blocks: missing commit, no PR, a PR claim mismatch, a bad PR body', async (t) => {
  const cases = [
    [(f) => { f.table[`git -C /wt rev-list --count ${SHA40}..HEAD`] = ok('0\n'); }, /no commit past base/],
    [(f) => { f.table['gh pr list --repo o/r --head conduct/demo/wp-00 --state all --json number,headRefOid,state'] = ok('[]'); }, /no PR for conduct\/demo\/wp-00/],
    [(f) => { f.table['gh pr list --repo o/r --head conduct/demo/wp-00 --state all --json number,headRefOid,state'] = ok(JSON.stringify([{ number: 8, headRefOid: 'f'.repeat(40), state: 'OPEN' }])); }, /GitHub has #8/],
    [(f) => { f.table['gh pr view 7 --repo o/r --json headRefName,state,body'] = ok(JSON.stringify({ headRefName: 'conduct/demo/wp-00', state: 'OPEN', body: report() })); }, /Merge danger is missing/],
  ];
  for (const [breakIt, reason] of cases) {
    const f = stopCheckLane(t);
    breakIt(f);
    const blocked = await f.stop();
    assert.deepEqual([blocked.out.block, blocked.out.verdict], [true, 'blocked'], blocked.out.reason);
    assert.match(blocked.out.reason, reason);
  }
});

test('stop-check: refuted, needs-conductor and infrastructure failures are the conductor\'s to route: the lane stops, released', async (t) => {
  const refuted = stopCheckLane(t);
  refuted.report(report({ outcome: 'refuted' }));
  const r = await refuted.stop();
  assert.deepEqual([r.out.block, r.out.verdict], [false, 'released']);
  const asks = stopCheckLane(t);
  asks.report(report({ outcome: 'stopped: needs conductor', extra: '## Needs conductor\n\n- Q1: which branch? Options: (a) main (b) dev\n' }));
  const a = await asks.stop();
  assert.deepEqual([a.out.block, a.out.verdict], [false, 'released'], a.out.reason);
  const infra = stopCheckLane(t);
  infra.table['gh pr list --repo o/r --head conduct/demo/wp-00 --state all --json number,headRefOid,state'] = exit(1, 'gh: HTTP 502');
  const i = await infra.stop();
  assert.deepEqual([i.out.block, i.out.verdict], [false, 'released']);
  assert.match(i.out.reason, /HTTP 502/);
});

test('stop-check: a stop with a running background task is never blocked and runs no check; unreadable input reads as {}', async (t) => {
  const f = stopCheckLane(t);
  rmSync(join(f.runDir, 'lane-wp-00-report.md'));
  const task = { id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' };
  const live = await f.stop({ session_id: 's1', background_tasks: [task, { ...task, id: 'b2', status: 'completed' }] });
  assert.deepEqual([live.out.block, live.out.verdict, live.file.tasks], [false, 'background-live', [{ id: 'b1', type: 'shell', command: 'npm run dev' }]]);
  assert.equal(f.calls.some((call) => call.startsWith('git ') || call.startsWith('gh ')), false);
  const garbled = await f.stop('not json');
  assert.deepEqual([garbled.out.block, garbled.file.sessionId], [true, null]);
});

test('stop-check: the herdr wait holds on a fresh background-live verdict for 15 minutes, then checks; exec and herdr exits record the verdict', async (t) => {
  const f = stopCheckLane(t, { backend: 'herdr', wpLane: { worktree: '/wt', branch: 'conduct/demo/wp-00', paneId: 'w1:p1', startedAt: new Date(T0).toISOString() } });
  const wait = f.backend('herdr').wait(f.wp)[0];
  assert.equal(f.record(wait, ok()).outcome, 'continue', 'no verdict file: the wait proceeds as before');
  f.tick(1000);
  await f.stop({ session_id: 's1', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm run dev' }] });
  const held = f.record(wait, ok());
  assert.deepEqual([held.outcome, held.patch.queue.map((act) => act.kind ?? act.step)], ['wait', ['wait', 'shell']]);
  assert.match(held.reason, /background task running: npm run dev/);
  f.tick(15 * 60 * 1000);
  const after = f.record(wait, ok());
  assert.deepEqual([after.outcome, after.patch.lane.stopCheck.verdict], ['continue', 'background-live']);
  // A verdict from before this start is not this lane's latest stop.
  f.wp.lane.startedAt = new Date(T0 + 60 * 60 * 1000).toISOString();
  assert.equal(f.record(wait, ok()).patch.lane.stopCheck, undefined);

  const e = stopCheckLane(t, { wpLane: { worktree: '/wt', branch: 'conduct/demo/wp-00', pid: 4242, identity: IDENTITY, logPath: join(tmpdir(), 'none.log') } });
  await e.stop();
  const exited = e.record(e.backend().wait(e.wp)[0], exit(1, '', JSON.stringify({ ok: true, alive: false, owner: 'gone' })));
  assert.deepEqual(exited.patch.lane.stopCheck, { verdict: 'pass', blocks: 0, at: new Date(T0).toISOString() });
});

test('stop-check: the hook command names stop-check.mjs, the run and the WP, forward-slashed, quoting only a path with a space', (t) => {
  const f = lanes(t);
  assert.equal(stopHookCommand(f.state, f.wp, f.deps), STOP_HOOK(f));
  const spaced = stopHookCommand({ ...f.state, runDir: 'C:\\runs\\my run' }, f.wp, { ...f.deps, pluginRoot: 'C:\\plugin' });
  assert.equal(spaced, 'node C:/plugin/skills/conduct/scripts/stop-check.mjs --run "C:/runs/my run" --wp WP-00');
  const codex = lanes(t, { agent: 'codex' });
  assert.equal(agentArgv(codex.state, codex.wp, { brief: '/b.md' }, codex.deps).includes('--settings'), false, 'codex lanes carry no stop hook');
  assert.equal(lanes(t, { agent: 'codex', backend: 'herdr', wpLane: { paneId: 'w1:p1' } }).backend('herdr').start(codex.wp)[0].command.includes('--stop-hook'), false);
});

// ---------------------------------------------------------------- t3 (c87c58c4)

// `wake`: 'polling' (r1's heartbeat failed, so lanes poll), 'live' (r1's
// heartbeat is recorded), or 'none' (no heartbeat tried yet).
function t3Lanes(t, { wake = 'polling', ...opts } = {}) {
  const f = lanes(t, { backend: 't3', ...opts });
  f.state.intent.backend = { name: 't3', t3Project: 'proj-1' };
  if (wake === 'polling') f.state.t3Wake = { taskId: null, thread: null, conductor: 1, failed: 'schedule_task: {"error":"no thread"}', old: [] };
  if (wake === 'live') f.state.t3Wake = { taskId: TASK, thread: CONDUCTOR, conductor: 1, at: new Date(T0).toISOString(), failed: null, deleted: false, old: [] };
  return f;
}
const THREAD = 'mcp:thread-1';
const CONDUCTOR = 'mcp:conductor-1';
const TASK = 'scheduled-task:hb-1';

test('t3 backend: chosen at intake; a git worktree plus the Stop hook, then MCP calls the conductor makes (launch, send, wait, interrupt)', (t) => {
  const f = t3Lanes(t, { wpLane: { worktree: '/wt', branch: 'conduct/demo/wp-00', briefPath: '/run/lane-wp-00.md' } });
  assert.deepEqual(chooseBackend(f.state, f.deps), { backend: 't3', detail: 'T3 Code threads in project proj-1' });
  const b = f.backend();
  assert.equal(b.name, 't3');
  assert.deepEqual(b.create(f.wp).map((act) => act.part ?? act.step), ['fetch', 'base', 'worktree', 'hook']);
  assert.deepEqual(b.create(f.wp).at(-1).command, ['node', CONDUCT(f), 'lane', 'hook', '--run', f.runDir, '--wp', 'WP-00']);
  const [launch] = b.start(f.wp);
  assert.deepEqual([launch.kind, launch.step, launch.tool], ['agent-tool', 'start', 't3_thread_launch']);
  assert.deepEqual(launch.args, {
    title: 'demo WP-00: demo', projectId: 'proj-1',
    workspaceStrategy: { type: 'existing_worktree', worktreePath: '/wt', branch: 'conduct/demo/wp-00' },
    modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] },
    message: `Read ${f.wp.lane.briefPath} and execute it exactly.`,
  });
  assert.match(launch.instruction, /never launch twice/);
  assert.deepEqual(b.prompt(f.wp), [], 'the first prompt rides the launch');
  f.wp.lane.threadId = THREAD;
  f.wp.amendment = { n: 2 };
  const [send] = b.prompt(f.wp, { amendment: true });
  assert.deepEqual([send.tool, send.args], ['t3_thread_send', { threadId: THREAD, message: `Read ${f.wp.lane.briefPath} and execute it exactly.`, mode: 'queue', clientRequestId: 'abcd1234-wp-00-a2-0' }]);
  assert.equal(b.prompt(f.wp, { amendment: true, resend: true })[0].args.clientRequestId, 'abcd1234-wp-00-a2-0-resend');
  assert.deepEqual(b.wait(f.wp)[0].args, { threadId: THREAD, timeoutMs: 120000 });
  f.wp.lane.startedAt = new Date(T0).toISOString();
  assert.deepEqual(b.stop(f.wp).map((act) => [act.tool, act.part]), [['t3_thread_interrupt', 'interrupt'], ['t3_thread_wait', 'confirm']]);
  f.wp.lane.exitedAt = new Date(T0).toISOString();
  assert.deepEqual(b.stop(f.wp).map((act) => act.part), ['reap']);
  // T3 holds a bound worktree's folder until its thread is archived.
  const [archive, remove] = b.remove(f.wp);
  assert.deepEqual([archive.tool, archive.args], ['t3_thread_organize', { action: 'archive', threadId: THREAD }]);
  assert.deepEqual(remove.command, ['git', '-C', resolve(f.repo), 'worktree', 'remove', '/wt']);
  assert.deepEqual(f.record(archive, { sequence: 1 }).patch, { lane: { archived: true } });
  const unarchived = f.record(archive, { error: 'thread not found' });
  assert.deepEqual([unarchived.outcome, unarchived.patch.lane.archived], ['continue', false], 'cleanup never blocks');
  for (const act of [...b.create(f.wp), launch, send, ...b.wait(f.wp), ...b.check(f.wp)]) {
    assert.ok(STEPS.includes(act.step), `${act.step} is a STEP`);
    assert.equal(act.seam, STEP_SEAM[act.step]);
  }
  // A codex lane runs in T3's codex provider, with no hook (Codex skips an untrusted one).
  const codex = t3Lanes(t, { agent: 'codex', wpLane: { worktree: '/wt' } });
  assert.deepEqual(codex.backend().create(codex.wp).map((act) => act.part ?? act.step), ['fetch', 'base', 'worktree']);
  assert.deepEqual(codex.backend().start(codex.wp)[0].args.modelSelection, { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] });
});

test('t3 recorder: a launch records its thread, a wait polls until the run ends, an ended run is reaped, a failed run blocks, and the deadline stops the lane', (t) => {
  const f = t3Lanes(t, { wpLane: { worktree: '/wt' } });
  const b = f.backend();
  const [launch] = b.start(f.wp);
  const launched = f.record(launch, { threadId: THREAD, runId: 'run-1', status: 'preparing' });
  assert.equal(launched.outcome, 'continue');
  assert.deepEqual([launched.patch.lane.threadId, launched.patch.lane.runId, launched.patch.lane.startedAt], [THREAD, 'run-1', new Date(T0).toISOString()]);
  assert.equal(Date.parse(launched.patch.lane.deadline) - T0, laneDeadlineMs(f.state));
  assert.deepEqual([f.record(launch, { status: 'preparing' }).outcome, f.record(launch, { error: 'project not found' }).outcome], ['block', 'block']);
  apply(f.wp, launched.patch);
  const [wait] = b.wait(f.wp);
  // A wait that times out is followed by a read (87518991); a read of a running lane polls again.
  for (const result of [{ status: 'running', timedOut: true }, { status: 'waiting', timedOut: true }, { status: 'starting', timedOut: false }]) {
    const polled = f.record(wait, result);
    assert.deepEqual([polled.outcome, polled.patch.queue.map((act) => [act.tool, act.part])], ['continue', [['t3_thread_read', 'read']]], JSON.stringify(result));
  }
  const read = b.read(f.wp);
  assert.deepEqual(read.args, { threadId: THREAD, view: 'activity', limit: 1, runLimit: 1 });
  const again = f.record(read, { thread: { status: 'running', pendingRequestCount: 0, itemCount: 4 }, recentRuns: [{ status: 'running' }] });
  assert.deepEqual([again.outcome, again.patch.queue.map((act) => act.tool)], ['wait', ['t3_thread_wait']]);
  const ended = f.record(wait, { status: 'completed', timedOut: false });
  assert.deepEqual([ended.outcome, ended.patch.lane.exitedAt, ended.patch.queue.map((act) => act.part)], ['continue', new Date(T0).toISOString(), ['reap']]);
  const failed = f.record(wait, { status: 'failed', timedOut: false });
  assert.deepEqual([failed.outcome, Boolean(failed.patch.lane.exitedAt)], ['block', true]);
  assert.match(failed.reason, /T3 run ended failed/);
  f.tick(laneDeadlineMs(f.state) + 1);
  const late = f.record(wait, { status: 'running', timedOut: true });
  assert.deepEqual([late.outcome, late.cause, late.patch.queue.map((act) => act.tool)], ['block', 'deadline', ['t3_thread_interrupt', 't3_thread_wait']]);
  assert.equal(f.record(read, { thread: { status: 'running', pendingRequestCount: 0 }, recentRuns: [{ status: 'running' }] }).cause, 'deadline');
});

// ---------------------------------------------------------------- t3 wake (bf8ed575) and pending requests (87518991)

// t3_thread_read's shape, as measured on T3 0.1.2 (2026-10-25 probes): the
// thread's pendingRequestCount, its runs newest first, and activity items
// paged from the oldest.
const t3Read = ({ status = 'running', pending = 0, itemCount = 5, items = [] } = {}) => ({
  thread: { threadId: THREAD, status, pendingRequestCount: pending, itemCount, runCount: 1 },
  recentRuns: [{ runId: 'run-1', ordinal: 1, status }], items, nextPosition: items.length ? itemCount - 1 : 0, hasMore: !items.length,
});
const APPROVAL = { position: 4, type: 'approval_request', status: 'waiting', text: 'Write probe string to probe.txt' };
const QUESTION = { position: 4, type: 'user_input_request', status: 'waiting', text: '[\n  {\n    "question": "Probe 87518991: proceed?",\n    "options": [{ "label": "yes" }, { "label": "no" }]\n  }\n]' };

test('t3 heartbeat: the first lane\'s create makes it bound to the conductor; its record keeps that thread; the launch and amendment messages end with the done send into it', (t) => {
  const f = t3Lanes(t, { wake: 'none', wpLane: { worktree: '/wt', briefPath: '/run/lane-wp-00.md' } });
  const b = f.backend();
  const heartbeat = b.create(f.wp).at(-1);
  assert.deepEqual([heartbeat.kind, heartbeat.step, heartbeat.part, heartbeat.tool], ['agent-tool', 'create', 'heartbeat', 'schedule_task']);
  assert.deepEqual({ ...heartbeat.args, prompt: undefined }, {
    title: 'conduct demo heartbeat', prompt: undefined, schedule: { type: 'interval', everyMs: T3_HEARTBEAT_MS }, bindToCurrentThread: true, clientRequestId: 'abcd1234-heartbeat-r1',
  });
  assert.match(heartbeat.args.prompt, /addressed to the thread that made it: conductor r1's\. Run node \S+conduct\.mjs next --run \S+ --as-thread <your own T3 thread id> \(orchestrator_capabilities' parentThreadId/);
  assert.match(heartbeat.args.prompt, /If it exits 5, this thread is not the run's conductor/);
  assert.equal(T3_HEARTBEAT_MS, 600000);
  // No heartbeat yet: the launch carries no done send.
  assert.equal(b.start(f.wp)[0].args.message, 'Read /run/lane-wp-00.md and execute it exactly.');
  // schedule_task's raw result, as measured: boundThreadId is the calling thread.
  const made = f.record(heartbeat, { scheduledTaskId: TASK, title: 'conduct demo heartbeat', enabled: true, boundThreadId: CONDUCTOR, schedule: { type: 'interval', everyMs: 600000 }, nextRunAt: 'x' });
  assert.deepEqual([made.outcome, made.patch], ['continue', {}]);
  assert.deepEqual([f.state.t3Wake.taskId, f.state.t3Wake.thread, f.state.t3Wake.conductor, t3WakeLive(f.state)], [TASK, CONDUCTOR, 1, true]);
  assert.deepEqual(b.create(f.wp).map((act) => act.part ?? act.step), ['fetch', 'base', 'worktree', 'hook'], 'a live heartbeat makes no other');
  const done = (message) => JSON.parse(/t3_thread_send with (\{.*\})\. That message/.exec(message)[1]);
  const launch = b.start(f.wp)[0].args.message;
  assert.match(launch, /^Read \/run\/lane-wp-00\.md and execute it exactly\.\n\nYour last act, once your report is written/);
  assert.deepEqual({ ...done(launch), message: undefined }, { threadId: CONDUCTOR, mode: 'queue', clientRequestId: 'abcd1234-wp-00-a0-0-done', message: undefined });
  assert.match(done(launch).message, /^\[conduct demo\] WP-00's lane ended its turn \(round a0\); report: \S+lane-wp-00-report\.md\. Addressed to the conductor thread mcp:conductor-1\. A wake, not a verdict/);
  // The recipient names its own thread, so a retired conductor is refused (workit#313 review r1, finding 2).
  assert.match(done(launch).message, /next --run \S+ --woken-by done --wp WP-00 --as-thread <your own T3 thread id> \(orchestrator_capabilities' parentThreadId, or t3_thread_configuration's threadId\).*If it exits 5, this thread is no longer the run's conductor: end your turn\.$/);
  // An amendment's done id is its send's id plus -done: new for every send.
  Object.assign(f.wp.lane, { threadId: THREAD, startedAt: new Date(T0).toISOString() });
  f.wp.amendment = { n: 2 };
  const [send] = b.prompt(f.wp, { amendment: true });
  assert.equal(done(send.args.message).clientRequestId, `${send.args.clientRequestId}-done`);
  assert.equal(send.args.clientRequestId, `abcd1234-wp-00-a2-${T0}`);
});

test('t3 heartbeat: a failed or unbound schedule_task leaves the lanes polling, and is never asked again by that conductor; a duplicate task is deleted', (t) => {
  const f = t3Lanes(t, { wake: 'none', wpLane: { worktree: '/wt', threadId: THREAD, briefPath: '/run/lane-wp-00.md' } });
  const b = f.backend();
  const [heartbeat, wait] = b.wait(f.wp);
  assert.deepEqual([heartbeat.part, heartbeat.step, wait.tool], ['heartbeat', 'wait', 't3_thread_wait'], 'a run with no heartbeat yet makes one at its next wait');
  const failed = f.record(heartbeat, { error: 'no calling thread' });
  assert.deepEqual([failed.outcome, t3WakeLive(f.state), f.state.t3Wake.failed], ['continue', false, 'schedule_task: {"error":"no calling thread"}'], 'a heartbeat never blocks the WP');
  assert.deepEqual(b.wait(f.wp).map((act) => act.tool), ['t3_thread_wait'], 'and is not asked again');
  assert.equal(b.start(f.wp)[0].args.message, 'Read /run/lane-wp-00.md and execute it exactly.');
  // A task bound to no thread would start a fresh thread each tick: it is deleted.
  delete f.state.t3Wake;
  const unbound = f.record(heartbeat, { scheduledTaskId: 'task-x', boundThreadId: null });
  assert.deepEqual([t3WakeLive(f.state), unbound.patch.queue.map((act) => [act.tool, act.args.scheduledTaskId])], [false, [['delete_scheduled_task', 'task-x']]]);
  assert.match(f.state.t3Wake.failed, /bound no thread/);
  // A second task beside the live one goes; the same task (T3 dedupes the request id, measured) is kept.
  f.state.t3Wake = { taskId: TASK, thread: CONDUCTOR, conductor: 1, failed: null, deleted: false, old: [] };
  const second = f.record(heartbeat, { scheduledTaskId: 'task-2', boundThreadId: CONDUCTOR });
  assert.deepEqual([f.state.t3Wake.taskId, second.patch.queue.map((act) => act.args.scheduledTaskId)], [TASK, ['task-2']]);
  assert.deepEqual(f.record(heartbeat, { scheduledTaskId: TASK, boundThreadId: CONDUCTOR }).patch, {});
  assert.equal(f.state.t3Wake.taskId, TASK);
});

test('t3 wake wait: with the heartbeat live a lane waits on its wake, then one read; running waits again, ended is reaped, past the deadline is stopped', (t) => {
  const f = t3Lanes(t, { wake: 'live', wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3600000).toISOString() } });
  const b = f.backend();
  const [wake, read] = b.wait(f.wp);
  assert.deepEqual([wake.kind, wake.step, wake.wake, wake.waitMs], ['wait', 'wait', true, T3_HEARTBEAT_MS]);
  assert.deepEqual([read.tool, read.part, read.args], ['t3_thread_read', 'read', { threadId: THREAD, view: 'activity', limit: 1, runLimit: 1 }]);
  const running = f.record(read, t3Read());
  assert.deepEqual([running.outcome, running.patch.queue.map((act) => act.tool ?? (act.wake && 'wake'))], ['wait', ['wake', 't3_thread_read']]);
  const ended = f.record(read, t3Read({ status: 'completed' }));
  assert.deepEqual([ended.outcome, Boolean(ended.patch.lane.exitedAt), ended.patch.queue.map((act) => act.part)], ['continue', true, ['reap']]);
  const failed = f.record(read, t3Read({ status: 'interrupted' }));
  assert.deepEqual([failed.outcome, failed.cause], ['block', 'error']);
  f.tick(3600001);
  assert.equal(f.record(read, t3Read()).cause, 'deadline');
});

test('t3 done wake: a done-woken lane whose read fails spends the mark; stopped and amended, its next heartbeat read waits on wakes, not a 60 s settle; a mark left on the run before is cleared by the amendment (workit#325 review r1, P3)', (t) => {
  const f = t3Lanes(t, { wake: 'live', wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3600000).toISOString() } });
  const b = f.backend();
  assert.equal(markDoneWake(f.state, 'done', 'WP-00', f.deps), true);
  const failed = f.record(b.read(f.wp), { isError: true, error: 'thread read failed' });
  assert.deepEqual([failed.outcome, failed.cause], ['block', 'error']);
  apply(f.wp, failed.patch);
  assert.equal(f.wp.lane.doneWake, null, 'a failed read spends the done wake');
  // Cleanup stops the lane, then the conductor amends it.
  const [interrupt, confirm] = b.stop(f.wp);
  apply(f.wp, f.record(interrupt, { ok: true }).patch);
  apply(f.wp, f.record(confirm, { status: 'interrupted', timedOut: false }).patch);
  assert.ok(f.wp.lane.exitedAt, 'the stop is recorded');
  // A mark the failed read did not spend still goes with the amendment.
  f.wp.lane.doneWake = new Date(T0).toISOString();
  f.wp.amendment = { n: 1 };
  apply(f.wp, f.record(b.prompt(f.wp, { amendment: true })[0], { threadId: THREAD, runId: 'run-2' }).patch);
  assert.deepEqual([f.wp.lane.doneWake, f.wp.lane.exitedAt], [null, null], 'the amendment clears the mark');
  // The heartbeat's read of the new run, running: it waits on wakes.
  const running = f.record(b.read(f.wp), t3Read());
  assert.deepEqual([running.outcome, running.patch.queue.map((act) => act.part ?? (act.wake && 'wake'))], ['wait', ['wake', 'read']]);
});

test('t3 pending request: a read counting one blocks the WP as a dialog at once, named from the latest activity (an approval or a question); one cleared meanwhile waits on', (t) => {
  const f = t3Lanes(t, { wake: 'live', wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3600000).toISOString() } });
  const b = f.backend();
  const read = b.read(f.wp);
  const counted = f.record(read, t3Read({ pending: 1, itemCount: 5 }));
  const [dialog] = counted.patch.queue;
  assert.deepEqual([counted.outcome, dialog.tool, dialog.part, dialog.args], ['continue', 't3_thread_read', 'dialog', { threadId: THREAD, view: 'activity', limit: 5, runLimit: 1, maxCharsPerItem: 600 }]);
  // Reads page from the oldest item and afterPosition is exclusive: the last five of twelve start after position 6.
  assert.equal(f.record(read, t3Read({ pending: 1, itemCount: 12 })).patch.queue[0].args.afterPosition, 6);
  const approval = f.record(dialog, t3Read({ pending: 1, items: [{ position: 3, type: 'command_execution', status: 'running', text: '$ echo probe' }, APPROVAL] }));
  assert.deepEqual([approval.outcome, approval.cause, approval.patch.queue], ['block', 'dialog', []]);
  assert.equal(approval.dialog, `an approval: Write probe string to probe.txt (T3 thread ${THREAD})`);
  const question = f.record(dialog, t3Read({ pending: 1, items: [QUESTION] }));
  assert.equal(question.dialog, `a question: Probe 87518991: proceed? (yes / no) (T3 thread ${THREAD})`);
  assert.match(f.record(dialog, t3Read({ pending: 2, items: [] })).dialog, /^2 pending request\(s\) the activity view does not name/);
  // Granted between the two reads: the lane runs on.
  assert.equal(f.record(dialog, t3Read({ pending: 0, items: [] })).outcome, 'wait');
  // A request beats the deadline: the person can still answer it.
  f.tick(3600001);
  assert.equal(f.record(dialog, t3Read({ pending: 1, items: [APPROVAL] })).cause, 'dialog');
});

test('t3 rotation: r1\'s heartbeat is not live under r2; the next wait deletes it and makes r2\'s, and the lanes poll until it is recorded', (t) => {
  const f = t3Lanes(t, { wake: 'live', wpLane: { worktree: '/wt', threadId: THREAD } });
  f.state.rotations = [{ attempt: 1, status: 'custody' }];
  assert.equal(t3WakeLive(f.state), false);
  const b = f.backend();
  const [stop, heartbeat, wait] = b.wait(f.wp);
  assert.deepEqual([stop.tool, stop.args, heartbeat.args.clientRequestId, wait.tool], ['delete_scheduled_task', { scheduledTaskId: TASK }, 'abcd1234-heartbeat-r2', 't3_thread_wait']);
  f.record(stop, { scheduledTaskId: TASK, deleted: true });
  assert.deepEqual([f.state.t3Wake.taskId, f.state.t3Wake.old], [null, [{ taskId: TASK, thread: CONDUCTOR, conductor: 1, deleted: true, attempts: 1 }]]);
  // r1's thread stays known as retired: the conductor fence refuses it before r2 has a heartbeat.
  assert.throws(() => conductorThreadFence(f.state, CONDUCTOR), { code: 5, message: /not this run's conductor \(current: none yet\)/ });
  assert.doesNotThrow(() => conductorThreadFence(f.state, 'mcp:conductor-2'));
  // Another lane's stale delete of the same task finds it gone: still deleted.
  f.record(stop, { error: '{"_tag":"OrchestratorMcpFailure","code":"task_not_found"}' });
  assert.deepEqual(f.state.t3Wake.old.map((entry) => entry.deleted), [true]);
  f.record(heartbeat, { scheduledTaskId: 'task-r2', boundThreadId: 'mcp:conductor-2' });
  assert.deepEqual([t3WakeLive(f.state), f.state.t3Wake.thread, f.state.t3Wake.conductor], [true, 'mcp:conductor-2', 2]);
  assert.equal(b.wait(f.wp)[0].wake, true);
  assert.throws(() => conductorThreadFence(f.state, CONDUCTOR), { code: 5, message: /current: mcp:conductor-2/ });
  assert.doesNotThrow(() => conductorThreadFence(f.state, 'mcp:conductor-2'));
  assert.doesNotThrow(() => conductorThreadFence(f.state, undefined), 'no --as-thread, no check');
});

test('t3 heartbeat delete retry: a delete that failed stays owed and is retried at each later wait, once per tick across lanes, up to 3 attempts (workit#313 review r1, finding 3)', (t) => {
  const f = t3Lanes(t, { wake: 'live', wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString(), deadline: new Date(T0 + 3600000).toISOString() } });
  const b = f.backend();
  // The run already has a heartbeat; a duplicate T3 did not dedupe is queued for deletion, and that delete fails.
  const heartbeat = { kind: 'agent-tool', step: 'wait', part: 'heartbeat', tool: 'schedule_task', args: { clientRequestId: 'abcd1234-heartbeat-r1' } };
  const [dup] = f.record(heartbeat, { scheduledTaskId: 'task-dup', boundThreadId: CONDUCTOR }).patch.queue;
  assert.deepEqual([dup.part, dup.args], ['heartbeat-stop', { scheduledTaskId: 'task-dup' }]);
  assert.equal(f.record(dup, { error: 'T3 unreachable' }).outcome, 'continue', 'a failed delete never blocks');
  const shape = (acts) => acts.map((act) => (act.part === 'heartbeat-stop' ? `stop:${act.args.scheduledTaskId}` : act.wake ? 'wake' : act.part));
  assert.deepEqual(shape(b.wait(f.wp)), ['stop:task-dup', 'wake', 'read'], 'the next wait retries it');
  f.record(b.wait(f.wp)[0], { error: 'T3 unreachable' });
  // Another lane already holds the retry this tick: it is not queued twice.
  f.state.wps.push({ id: 'WP-09', queue: [b.wait(f.wp)[0]] });
  assert.deepEqual(shape(b.wait(f.wp)), ['wake', 'read']);
  f.state.wps.pop();
  // In poll mode too.
  const live = f.state.t3Wake;
  f.state.t3Wake = { ...live, failed: 'x' };
  assert.deepEqual(shape(b.wait(f.wp)).slice(0, 1), ['stop:task-dup']);
  f.state.t3Wake = live;
  f.record(b.wait(f.wp)[0], { error: 'T3 still unreachable' });
  const entry = f.state.t3Wake.old.find((candidate) => candidate.taskId === 'task-dup');
  assert.deepEqual([entry.deleted, entry.attempts], [false, 3]);
  assert.deepEqual(shape(b.wait(f.wp)), ['wake', 'read'], 'after the third failure it is left to the run analysis');
  assert.deepEqual(heartbeatsToDelete(f.state), [TASK], 'analyze owes only the live one');
});

test('t3 analyze: the heartbeats a finished build still owns are deleted before the analysis runs; a failed delete stays owed, up to 3 attempts per task (workit#313 review r1, finding 3)', async (t) => {
  const analyze = await import('./phases/analyze.mjs');
  const f = t3Lanes(t, { wake: 'live' });
  f.state.t3Wake.old = [{ taskId: 'old-1' }, { taskId: 'old-2', deleted: true }, { taskId: 'old-3', deleted: false, attempts: 1, error: 'x' }];
  const first = analyze.next(f.state);
  assert.deepEqual([first.kind, first.step, first.tool, first.args], ['agent-tool', 'analyze', 'delete_scheduled_task', { scheduledTaskId: TASK }]);
  analyze.record(f.state, first, { scheduledTaskId: TASK, deleted: true });
  const second = analyze.next(f.state);
  assert.deepEqual(second.args, { scheduledTaskId: 'old-1' });
  analyze.record(f.state, second, { error: 'T3 unreachable' });
  assert.equal(f.state.phase, 'build', 'a delete never moves the phase');
  // old-1 failed once: it is tried again, and again, then given up.
  for (const error of ['T3 unreachable', 'T3 still unreachable']) {
    const retry = analyze.next(f.state);
    assert.deepEqual([retry.tool, retry.args], ['delete_scheduled_task', { scheduledTaskId: 'old-1' }], 'a failed delete is retried');
    analyze.record(f.state, retry, { error });
  }
  // old-3 failed once in the build: two attempts are left, and the second deletes it.
  const third = analyze.next(f.state);
  assert.deepEqual(third.args, { scheduledTaskId: 'old-3' });
  analyze.record(f.state, third, { error: 'busy' });
  analyze.record(f.state, analyze.next(f.state), { scheduledTaskId: 'old-3', deleted: true });
  const run = analyze.next(f.state);
  assert.deepEqual([run.kind, run.step], ['shell', 'analyze'], 'after 3 attempts the analysis runs');
  assert.deepEqual(heartbeatsToDelete(f.state), []);
  const entry = (id) => f.state.t3Wake.old.find((candidate) => candidate.taskId === id);
  assert.deepEqual([entry('old-1').deleted, entry('old-1').attempts, entry('old-1').error], [false, 3, '{"error":"T3 still unreachable"}']);
  assert.deepEqual([entry('old-3').deleted, entry('old-3').attempts, entry('old-3').error], [true, 3, undefined]);
  assert.deepEqual(unresolvedHeartbeats(f.state).map((left) => left.taskId), ['old-1'], 'what the run analysis names');
  analyze.record(f.state, run, { code: 0 });
  assert.equal(f.state.phase, 'showcase');
  assert.equal(analyze.next(t3Lanes(t, { wake: 'none' }).state).kind, 'shell', 'a run with no heartbeat goes straight to its analysis');
});

test('t3 recorder: an amendment is a new turn that renews the deadline (a re-send renews nothing); a stop is confirmed by a terminal run, else re-confirmed, then cleanup-unresolved', (t) => {
  const f = t3Lanes(t, { wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString() } });
  const b = f.backend();
  f.tick(5000);
  const sent = f.record(b.prompt(f.wp, { amendment: true })[0], { threadId: THREAD, runId: 'run-2', status: 'starting', delivery: 'started' });
  assert.deepEqual([sent.outcome, sent.patch.lane.runId, sent.patch.lane.startedAt], ['continue', 'run-2', new Date(T0 + 5000).toISOString()]);
  assert.deepEqual(f.record(b.prompt(f.wp, { amendment: true, resend: true })[0], { threadId: THREAD, runId: 'run-2' }).patch, {});
  const [interrupt, confirm] = b.stop(f.wp);
  f.wp.queue = [interrupt, confirm];
  assert.equal(f.record(interrupt, { threadId: THREAD, status: 'interrupted' }).outcome, 'continue');
  f.wp.queue = [confirm, { kind: 'shell', step: 'stop', part: 'remove' }];
  const stopped = f.record(confirm, { status: 'interrupted', timedOut: false });
  assert.deepEqual([stopped.outcome, Boolean(stopped.patch.lane.exitedAt), stopped.patch.queue.map((act) => act.part)], ['done', true, ['reap', 'remove']]);
  const still = f.record(confirm, { status: 'running', timedOut: true });
  assert.deepEqual([still.outcome, still.patch.lane.stopConfirms, still.patch.queue.map((act) => act.part ?? act.step)], ['wait', 1, ['wait', 'confirm', 'remove']]);
  f.wp.lane.stopConfirms = 2;
  const stuck = f.record(confirm, { status: 'running', timedOut: true });
  assert.deepEqual([stuck.outcome, stuck.cause], ['block', 'cleanup-unresolved']);
  // A failed stop call keeps the cleanup queued behind it (review of #306).
  f.wp.lane.stopConfirms = 0;
  assert.equal(f.record(interrupt, { error: 'thread busy' }).outcome, 'continue', 'a failed interrupt is left to the confirmation');
  const failedConfirm = f.record(confirm, { error: 'T3 unreachable' });
  assert.deepEqual([failedConfirm.outcome, failedConfirm.patch.queue.map((act) => act.part ?? act.step)], ['wait', ['wait', 'confirm', 'remove']]);
  assert.match(failedConfirm.reason, /t3_thread_wait failed/);
});

test('t3 amendment ids: stable across retries of one queued send, new for the send a reset queues after a recorded one (review of #306)', (t) => {
  const f = t3Lanes(t, { wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString() } });
  f.wp.amendment = { n: 1 };
  const b = f.backend();
  const [first] = b.prompt(f.wp, { amendment: true });
  assert.deepEqual(b.prompt(f.wp, { amendment: true })[0].args.clientRequestId, first.args.clientRequestId, 'a retry of the same send');
  f.tick(60000);
  apply(f.wp, f.record(first, { threadId: THREAD, runId: 'run-2', status: 'starting' }).patch);
  const [again] = b.prompt(f.wp, { amendment: true });
  assert.notEqual(again.args.clientRequestId, first.args.clientRequestId, 'reset-wp --to prompt re-sends amendment 1 with a new id');
});

test('t3 lane hook: writes the Stop hook and the lane marker into the worktree settings, keeps their other keys, and excludes the file once', async (t) => {
  const f = t3Lanes(t);
  const worktree = join(f.dir, 'wt');
  mkdirSync(join(worktree, '.claude'), { recursive: true });
  writeFileSync(join(worktree, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  const exclude = join(f.dir, 'git', 'info', 'exclude');
  f.table[`git -C ${worktree} rev-parse --git-path info/exclude`] = ok(`${exclude}\n`);
  f.wp.lane.worktree = worktree;
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  for (let i = 0; i < 2; i += 1) {
    const result = await runLaneVerb('hook', { runDir: f.runDir, wpId: 'WP-00' }, { ...f.deps, mkdir: (path) => mkdirSync(path, { recursive: true }) });
    assert.equal(result.code, 0, result.out);
  }
  const settings = JSON.parse(readFileSync(join(worktree, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(settings.env, { WORKIT_LANE: 'demo-wp-00' });
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: STOP_HOOK(f), timeout: 300 }] }], 'one Stop hook after two runs');
  assert.equal(readFileSync(exclude, 'utf8'), '/.claude/settings.local.json\n');
  const missing = t3Lanes(t, { wpLane: { worktree: join(f.dir, 'gone') } });
  writeFileSync(join(missing.runDir, 'state.json'), JSON.stringify(missing.state));
  assert.equal((await runLaneVerb('hook', { runDir: missing.runDir, wpId: 'WP-00' }, missing.deps)).code, 1);
});

const BOM = String.fromCharCode(0xfeff);
// A T3 lane whose worktree settings file starts as `raw` (null: no file);
// hook() runs `lane hook` once and returns the file's bytes after it.
function laneHookFixture(t, raw) {
  const f = t3Lanes(t);
  const worktree = join(f.dir, 'wt'), path = join(worktree, '.claude', 'settings.local.json');
  mkdirSync(dirname(path), { recursive: true });
  if (raw !== null) writeFileSync(path, raw, 'utf8');
  const exclude = join(f.dir, 'git', 'info', 'exclude');
  f.table[`git -C ${worktree} rev-parse --git-path info/exclude`] = ok(`${exclude}\n`);
  f.wp.lane.worktree = worktree;
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const hook = async () => {
    const result = await runLaneVerb('hook', { runDir: f.runDir, wpId: 'WP-00' }, { ...f.deps, mkdir: (p) => mkdirSync(p, { recursive: true }) });
    return { result, raw: read(path), exclude: read(exclude) };
  };
  return { f, path, exclude, hook };
}

test('t3 lane hook: a BOM and CRLF settings file is read and written back with one BOM and CRLF only, its other keys and the foreign Stop hook kept; a second run is byte-identical', async (t) => {
  const theirs = { hooks: [{ type: 'command', command: 'echo theirs' }] };
  const pre = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }];
  const before = { permissions: { allow: ['Bash(ls)'] }, env: { FOO: 'bar' }, hooks: { PreToolUse: pre, Stop: [theirs] } };
  const { f, hook } = laneHookFixture(t, `${BOM}${JSON.stringify(before, null, 2).replace(/\n/g, '\r\n')}\r\n`);
  const first = await hook();
  assert.equal(first.result.code, 0, first.result.out);
  assert.ok(first.raw.startsWith(`${BOM}{`) && !first.raw.startsWith(`${BOM}${BOM}`), 'exactly one leading BOM');
  assert.ok(first.raw.endsWith('}\r\n'), 'ends with CRLF');
  assert.equal(first.raw.replace(/\r\n/g, '').includes('\n'), false, 'a bare LF was written');
  const after = JSON.parse(first.raw.slice(1));
  assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.env, { FOO: 'bar', WORKIT_LANE: 'demo-wp-00' });
  assert.deepEqual(after.hooks.PreToolUse, pre);
  assert.deepEqual(after.hooks.Stop, [theirs, { hooks: [{ type: 'command', command: STOP_HOOK(f), timeout: 300 }] }]);
  assert.equal(first.exclude, '/.claude/settings.local.json\n');
  const second = await hook();
  assert.equal(second.result.code, 0, second.result.out);
  assert.equal(second.raw, first.raw, 'a second run changes no byte');
  assert.equal(second.exclude, first.exclude);
});

test('t3 lane hook: an LF file with no BOM stays that way, and a missing file is created LF with no BOM', async (t) => {
  for (const raw of [`${JSON.stringify({ permissions: {} }, null, 2)}\n`, null]) {
    const { hook } = laneHookFixture(t, raw);
    const { result, raw: after } = await hook();
    assert.equal(result.code, 0, result.out);
    assert.ok(after.startsWith('{') && after.endsWith('}\n'), JSON.stringify(after.slice(0, 3)));
    assert.equal(after.includes('\r'), false, 'a CR was written');
  }
});

test('t3 lane hook: a BOM then {, null and [] are refused (is not JSON, is not a JSON object) and neither the settings file nor info/exclude is written', async (t) => {
  for (const [raw, error] of [[`${BOM}{`,/is not JSON: /], ['null', /is not a JSON object$/], ['[]', /is not a JSON object$/]]) {
    const { path, exclude, hook } = laneHookFixture(t, raw);
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, '# theirs\n');
    const { result, raw: after, exclude: excluded } = await hook();
    assert.equal(result.code, 1, JSON.stringify(raw));
    assert.match(JSON.parse(result.out).error, error);
    assert.ok(JSON.parse(result.out).error.startsWith(path));
    assert.equal(after, raw, 'the settings file was written');
    assert.equal(excluded, '# theirs\n', 'info/exclude was written');
  }
});

test('t3 lane hook: replaces every stop-check hook for this run and WP, whatever root it names, with the one current entry; keeps other hooks; a second run leaves exactly one', async (t) => {
  const f = t3Lanes(t);
  const worktree = join(f.dir, 'wt'), path = join(worktree, '.claude', 'settings.local.json');
  mkdirSync(join(worktree, '.claude'), { recursive: true });
  const fwd = (p) => p.replace(/\\/g, '/');
  const hook = (root, run = fwd(f.runDir), wpId = 'WP-00') => ({ type: 'command', command: `node ${fwd(join(f.dir, root, 'skills/conduct/scripts/stop-check.mjs'))} --run ${run} --wp ${wpId}` });
  const otherWp = { hooks: [hook('plugin-1.28.1', fwd(f.runDir), 'WP-01')] };
  const otherRun = { hooks: [hook('plugin-1.28.1', fwd(join(f.dir, 'elsewhere')))] };
  const theirs = { hooks: [{ type: 'command', command: 'echo theirs' }] };
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [
    { hooks: [hook('plugin-1.28.1')] }, otherWp, { hooks: [hook('plugin-1.28.2', f.runDir), theirs.hooks[0]] }, otherRun,
  ] } }));
  f.table[`git -C ${worktree} rev-parse --git-path info/exclude`] = ok(`${join(f.dir, 'git', 'info', 'exclude')}\n`);
  f.wp.lane.worktree = worktree;
  writeFileSync(join(f.runDir, 'state.json'), JSON.stringify(f.state));
  const current = { hooks: [{ type: 'command', command: STOP_HOOK(f), timeout: 300 }] };
  for (let i = 0; i < 2; i += 1) {
    const result = await runLaneVerb('hook', { runDir: f.runDir, wpId: 'WP-00' }, { ...f.deps, mkdir: (p) => mkdirSync(p, { recursive: true }) });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop, [otherWp, theirs, otherRun, current], `run ${i + 1}: one current entry, others kept`);
  }
});

test('t3 reset-wp --to prompt: a lane with a thread gets a new turn in it; one never launched is launched; a running thread is refused', (t) => {
  const f = t3Lanes(t, { wpLane: { worktree: '/wt', threadId: THREAD, startedAt: new Date(T0).toISOString(), exitedAt: new Date(T0).toISOString(), briefPath: join(tmpdir()) } });
  assert.equal(RESET_TARGETS.prompt.needs(f.state, f.wp, f.deps), null);
  assert.deepEqual(RESET_TARGETS.prompt.queue(f.state, f.wp, f.deps).map((act) => act.tool), ['t3_thread_send']);
  f.wp.lane.exitedAt = null;
  assert.match(RESET_TARGETS.prompt.needs(f.state, f.wp, f.deps), /T3 lane thread mcp:thread-1 has not been observed to end its run/);
  const fresh = t3Lanes(t, { wpLane: { worktree: '/wt', briefPath: join(tmpdir()) } });
  assert.deepEqual(RESET_TARGETS.prompt.queue(fresh.state, fresh.wp, fresh.deps).map((act) => act.tool), ['t3_thread_launch']);
});
