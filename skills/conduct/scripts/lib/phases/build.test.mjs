// The build phase on a fake executor: next/record driven directly on a state
// object (the resume tests go through runConduct on the run dir). A scripted
// "agent" performs each action: conduct.mjs sub-verbs run in-process (the real
// runLaneVerb and runLandVerb, so lane check and the merge gate are WP-02's
// and WP-03's own code), every other program answers from a fake executor.
// No real agent, no network, no sleeps: a wait is recorded, never slept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, appendFileSync, linkSync, truncateSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as build from './build.mjs';
import { RUN_SLOTS } from './build.mjs';
import { wpRecord } from './spec.mjs';
import { STEPS, STEP_SEAM, saveState, readEvents, loadState } from '../state.mjs';
import { runLaneVerb } from '../lanes.mjs';
import { runLandVerb } from '../land.mjs';
import { shellArgv } from '../exec.mjs';
import { acceptAnswer, correlation } from '../touch.mjs';
import { runConduct } from '../../conduct.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..');
const FIXTURES = join(SCRIPTS, '__fixtures__');
const fixture = (dir, name) => readFileSync(join(FIXTURES, dir, name), 'utf8');
const T0 = Date.parse('2026-10-04T18:00:00.000Z');
const IDENTITY = '2026-10-04T18:00:00.0000000Z claude.exe';
const ANCHOR = '2ff76fa2-ce43-4a3c-88d0-16e2dbc0750c';
const BASE = 'b'.repeat(40);
const LIVE = ['dispatched', 'pr', 'review', 'amending', 'gate'];
const CLAUDE_LOG = fixture('lanes', 'claude-p-ok.json');
const LANE_COST = JSON.parse(CLAUDE_LOG).total_cost_usd;
const RECEIPT = JSON.parse(fixture('build', 'spine-receipt-result.json'));
const sha = (prefix, n) => `${prefix}${String(n).padStart(39, '0')}`;
const num = (id) => Number(id.slice(3));
const prNumber = (id) => 100 + num(id);
const mergeSha = (id) => sha('d', num(id));
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const RELEASE_STUB = { next: () => ({ kind: 'done' }), record: () => {} };

const TWO = [
  { id: 'WP-01', files: ['lib/state.mjs'], wave: 1, state: 'merged' },
  { id: 'WP-02', files: ['lib/lanes.mjs'], dependsOn: ['WP-01'] },
  { id: 'WP-03', files: ['lib/land.mjs'], dependsOn: ['WP-01'] },
];
const withFour = [...TWO, { id: 'WP-04', files: ['lib/phases/build.mjs'], wave: 3, dependsOn: ['WP-02', 'WP-03'] }];

function harness(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const projects = join(dir, opts.inProjects ?? opts.herdr ? 'projects' : 'src');
  const repo = join(projects, 'repo');
  mkdirSync(join(repo, '.workit'), { recursive: true });
  if (opts.config !== null) writeFileSync(join(repo, '.workit', 'conduct.json'), opts.config ?? fixture('build', 'conduct.json'));
  const pluginRoot = join(dir, 'plugin');
  mkdirSync(join(pluginRoot, 'reference', 'templates'), { recursive: true });
  mkdirSync(join(pluginRoot, 'skills', 'conduct', 'templates'), { recursive: true });
  copyFileSync(join(FIXTURES, 'build', 'lane-contract.template.md'), join(pluginRoot, 'reference', 'templates', 'lane-contract.template.md'));
  copyFileSync(join(SCRIPTS, '..', 'templates', 'lane-brief.md'), join(pluginRoot, 'skills', 'conduct', 'templates', 'lane-brief.md'));
  const workshopDir = join(dir, 'ws');
  const runDir = join(workshopDir, 'run');
  mkdirSync(join(workshopDir, 'work-packages'), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const depth = opts.depth ?? 'deep';
  const gateCommand = opts.gateCommand ?? 'node --version';
  writeFileSync(join(workshopDir, 'work-packages', '_orchestrator.md'),
    `# Orchestrator\n\n## Gate Commands\n\n${[1, 2, 3].map((wave) => `Wave ${wave}: ${gateCommand}`).join('\n')}\n\n## Package Inventory\n`);
  const wps = (opts.wps ?? (depth === 'deep' ? TWO : [{ id: 'WP-00', files: [] }])).map((spec) => {
    const specPath = depth === 'deep' ? join(workshopDir, 'work-packages', `${spec.id.toLowerCase()}.md`) : join(runDir, 'wp-00.md');
    writeFileSync(specPath, `# ${spec.id}: name ${spec.id}\n\n**Commit:** \`feat: ${spec.id}\`\n`);
    const wp = wpRecord({ id: spec.id, name: `name ${spec.id}`, specPath, wave: spec.wave ?? 2, files: spec.files, dependsOn: spec.dependsOn ?? [],
      tier: spec.tier ?? 'T1', runtimeExercise: 'CLI: cat hello.txt prints hi' });
    return { ...wp, questId: opts.spine ? (spec.id === 'WP-00' ? ANCHOR : `quest-${spec.id.toLowerCase()}`) : null, state: spec.state ?? 'pending' };
  });
  const on = (value) => ({ on: Boolean(value), evidence: 'probed', detail: 'fake' });
  const state = {
    schemaVersion: 1, slug: 'demo', runId: 'abcd1234', createdAt: new Date(T0).toISOString(), runDir, workshopDir, pluginRoot,
    intent: { goal: 'demo goal', repo: { path: repo, remote: 'o/r', defaultBranch: 'main' }, anchor: opts.spine ? ANCHOR : null, campaign: null,
      budgetUsd: 100, lanesCap: opts.lanes ?? 2, agent: 'claude', release: null, ciWorkflows: 1 },
    agents: { claude: on(true), codex: on(true) },
    adapters: { herdr: on(opts.herdr), notify: on(opts.notify), spend: on(opts.spend), spine: on(opts.spine), council: on(opts.council), kb: on(false), verify: on(false) },
    phase: 'build',
    authority: { merge: opts.merge ?? true, release: false, budgetUsd: opts.budget ?? 25, metered: Boolean(opts.spend), scope: 'demo goal', notes: null, grant: null },
    touches: [], spec: { depth, reviewLevel: null, gate: null, gateCommand: depth === 'deep' ? null : gateCommand },
    wps, release: { state: 'pending', reason: null, base: null, worktree: null, branch: null, pr: null, gate: null, merge: null },
    mergeLock: null, dispatchHalt: null, handover: null, sentBack: null, pending: null, lastRecorded: null, seq: 0, rev: 0, txns: [],
  };
  let clock = T0;
  const h = {
    dir, repo, runDir, workshopDir, pluginRoot, state, trace: [], calls: [], heads: {}, life: {}, lifeByPid: new Map(), reports: {}, lastReport: {},
    findings: {}, rulings: [], synth: [], resolved: 0, seqSha: 0, spawns: {}, rules: [], identity: true, disk: false,
    tick: (ms) => { clock += ms; },
  };
  h.head = (id) => h.heads[id] ?? sha('a', num(id));
  h.bump = (id) => (h.heads[id] = sha('c', (h.seqSha += 1) * 100 + num(id)));
  h.deps = {
    exec: (program, args, options = {}) => fakeExec(h, program, args, options),
    read: (path) => readFileSync(path, 'utf8'), write: (path, value) => writeFileSync(path, value), exists: existsSync,
    mkdir: (path) => mkdirSync(path, { recursive: true }), rename: renameSync, append: appendFileSync, list: readdirSync,
    link: linkSync, truncate: truncateSync, remove: (path) => rmSync(path, { force: true }),
    env: opts.env ?? {}, platform: opts.platform ?? 'linux', home: join(dir, 'home'), pid: process.pid, hostname: 'test', lockWaitMs: 0,
    now: () => clock, timestamp: () => new Date(clock).toISOString(), sleep: async () => {}, stdinIsTTY: false, newRunId: () => 'abcd1234',
    resolveCodex: () => 'codex', pluginRoot,
    spawnDetached: (program, args, options) => fakeSpawn(h, options),
    pidAlive: (pid) => (h.lifeByPid.get(pid) ?? 0) > 0,
  };
  h.overrides = () => ({ ...h.deps, importModule: (rel) => (rel === 'lib/phases/release.mjs' ? RELEASE_STUB : import(pathToFileURL(join(SCRIPTS, rel)).href)) });
  h.current = () => (h.disk ? loadState(runDir, h.deps) : h.state);
  h.wp = (id) => h.current().wps.find((wp) => wp.id === id);
  h.events = () => readEvents(runDir, h.deps, h.current());
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  return h;
}

const idOfWorktree = (path) => /-(wp-\d+)$/.exec(path)?.[1].toUpperCase();

// Rules are [regex over "program args…", (h, match, input) → result]; a
// test's own h.rules come first.
const BASE_RULES = [
  [/Get-CimInstance|ps -o lstart/, (h) => ok(h.identity ? `${IDENTITY}\n` : '')],
  [/^git -C \S+ rev-list --count \S+\.\.HEAD$/, () => ok('1\n')],
  [/^gh pr view (\d+) --repo o\/r --json headRefName,state,body$/, (h, m) => {
    const id = `WP-${String(Number(m[1]) - 100).padStart(2, '0')}`;
    return ok(JSON.stringify({ headRefName: `conduct/demo/${id.toLowerCase()}`, state: 'OPEN', body: readFileSync(join(h.runDir, `lane-${id.toLowerCase()}-report.md`), 'utf8') }));
  }],
  [/^git -C (\S+) rev-parse HEAD$/, (h, m) => ok(`${h.head(idOfWorktree(m[1]))}\n`)],
  [/^gh pr view (\d+) --repo o\/r --json headRefOid,baseRefName,state$/, (h, m) => ok(JSON.stringify({
    headRefOid: h.head(`WP-${String(Number(m[1]) - 100).padStart(2, '0')}`), baseRefName: 'main', state: 'OPEN' }))],
  [/^git -C \S+ fetch origin$/, () => ok()],
  [/^git -C \S+ merge-base --is-ancestor origin\/main HEAD$/, (h) => (h.stale > 0 ? (h.stale -= 1, { code: 1, stdout: '', stderr: '' }) : ok())],
  [/^git -C \S+ merge-base --is-ancestor \w+ \w+$/, () => ok()],
  [/^gh api repos\/o\/r\/commits\/(\w+)\/check-runs\?per_page=100 --paginate$/, (h, m) => ok(h.checkRuns ? h.checkRuns(m[1]) : fixture('land', 'check-runs-green.json'))],
  [/^gh api repos\/o\/r\/commits\/\w+\/status\?per_page=100 --paginate$/, () => ok(fixture('land', 'commit-status-green.json'))],
  [/^gh api repos\/o\/r\/branches\/main\/protection\/required_status_checks$/, () => ok(fixture('land', 'required-checks.json'))],
  [/^node \S+pr-review\.mjs threads --pr (\d+)/, (h, m) => ({ code: h.unresolved?.(m[1]) ? 8 : 0, stdout: '', stderr: '' })],
  [/^git -C \S+ show origin\/main:\.workit\/conduct\.json$/, () => ({ code: 128, stdout: '', stderr: "fatal: path '.workit/conduct.json' does not exist in 'origin/main'" })],
  [/^git -C \S+ diff --no-color --no-ext-diff --no-textconv (\w+) (\w+)$/, (h, m) => ok(`diff ${m[1]} ${m[2]}\n`)],
  [/^git -C \S+ patch-id --verbatim$/, (h, m, input) => ok(`${h.patchId ? h.patchId(input) : 'f'.repeat(40)} x\n`)],
  [/^git -C \S+ diff --quiet (?:--no-renames )?(\w+) (\w+)$/, (h, m) => ({ code: h.treeMismatch && m[2] === mergeSha(h.treeMismatch) ? 1 : 0, stdout: '', stderr: '' })],
  [/^git -C \S+ diff --name-only --no-renames origin\/main\.\.\.HEAD$/, () => ok('src/a.mjs\n')],
];

function fakeExec(h, program, args, { input } = {}) {
  const key = [program, ...args].join(' ');
  h.calls.push(key);
  for (const [pattern, answer] of [...h.rules, ...BASE_RULES]) {
    const match = pattern.exec(key);
    if (match) return answer(h, match, input);
  }
  return { code: 127, stdout: '', stderr: `unexpected command: ${key}` };
}

// The lane writes its report (and, on an amendment, pushes a new head).
function writeReport(h, id, amended) {
  if (amended) h.bump(id);
  const name = h.reports[id]?.length ? h.reports[id].shift() : h.lastReport[id] ?? 'report-built.md';
  h.lastReport[id] = name;
  const text = fixture('build', name).replaceAll('{pr}', String(prNumber(id))).replaceAll('{head}', h.head(id));
  writeFileSync(join(h.runDir, `lane-${id.toLowerCase()}-report.md`), text);
}

function fakeSpawn(h, { logPath }) {
  const id = /lane-(wp-\d+)\.log$/.exec(logPath)[1].toUpperCase();
  const pid = 4200 + num(id);
  h.spawns[id] = (h.spawns[id] ?? 0) + 1;
  h.lifeByPid.set(pid, h.life[id] ?? 0);
  appendFileSync(logPath, `${CLAUDE_LOG.trim()}\n`);
  writeReport(h, id, h.spawns[id] > 1);
  return { pid };
}

const flagOf = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};

async function conductVerb(h, action) {
  const argv = action.command.slice(2);
  const [verb, sub] = argv;
  const wpId = flagOf(argv, 'wp');
  let reply;
  if (h.disk) {
    const result = await runConduct(argv, h.overrides());
    reply = { code: result.code, out: result.stdout };
  } else if (verb === 'lane') {
    const flags = sub === 'spawn' ? (flagOf(argv, 'amend') ? { amend: flagOf(argv, 'amend') } : {})
      : sub === 'check' ? { ...(flagOf(argv, 'pr') ? { pr: flagOf(argv, 'pr') } : {}), ...(argv.includes('--runtime-only') ? { runtimeOnly: true } : {}) } : {};
    reply = await runLaneVerb(sub, { runDir: h.runDir, wpId, flags, ...(sub === 'spawn' ? { state: h.state } : {}) }, h.deps);
  } else {
    reply = await runLandVerb(sub, { runDir: h.runDir, wpId, flags: sub === 'merged' ? { mergeSha: flagOf(argv, 'merge-sha') } : {} }, h.deps);
  }
  if (verb === 'lane' && sub === 'alive') {
    const pid = 4200 + num(wpId);
    h.lifeByPid.set(pid, Math.max(0, (h.lifeByPid.get(pid) ?? 0) - 1));
  }
  return { code: reply.code, stdout: typeof reply.out === 'string' ? reply.out : JSON.stringify(reply.out), stderr: '' };
}

function herdrVerb(h, action) {
  const id = action.wpId;
  const verb = action.command[2];
  if (verb === 'create') return ok(JSON.stringify({ paneId: `pane-${id}`, path: `${h.repo}-wt-demo-${id.toLowerCase()}`, branch: `conduct/demo/${id.toLowerCase()}` }));
  if (verb === 'start') return ok(JSON.stringify({ startedAt: h.deps.timestamp() }));
  if (verb === 'prompt') {
    h.spawns[id] = (h.spawns[id] ?? 0) + 1;
    writeReport(h, id, h.spawns[id] > 1);
    return ok();
  }
  if (verb === 'wait') return { code: h.herdrWait?.[id]?.length ? h.herdrWait[id].shift() : 0, stdout: '', stderr: '' };
  return ok();
}

function shellResult(h, action) {
  const id = action.wpId;
  const { command } = action;
  if (command[0] === 'node' && command[1].endsWith('conduct.mjs')) return conductVerb(h, action);
  if (command[0] === 'node' && command[1].endsWith('lane.mjs')) return herdrVerb(h, action);
  switch (action.part ? `${action.step}/${action.part}` : action.step) {
    case 'base': return ok(`${BASE}\n`);
    case 'pr-lookup': return ok(JSON.stringify([{ number: prNumber(id), headRefOid: h.head(id), state: 'OPEN' }]));
    case 'review/diff': return ok(h.diff?.[id] ?? 'src/a.mjs\n');
    case 'review/managed': return ok(JSON.stringify({ mode: 'standalone' }));
    case 'post/post': {
      const count = h.findings[id]?.length ? h.findings[id].shift() : 0;
      return ok(count === null ? 'posted\n' : `findings ${count}\n`);
    }
    case 'review/amend-diff': return ok(h.amendDiff?.[id] ?? 'docs/notes.md\n');
    case 'thread-ids/lookup': return ok(fixture('land', 'review-threads-145.json'));
    case 'resolve/resolve':
      h.resolved += 1;
      return ok();
    case 'rebase/pre-head': return ok(`${h.head(id)}\n`);
    case 'rebase/post-heads': return ok(`${h.bump(id)}\n${'e'.repeat(40)}\n`);
    case 'merge/merge-commit': return ok(JSON.stringify({ mergeCommit: { oid: mergeSha(id) } }));
    case 'spend/spend': return ok(`${h.spendUsd ?? 1}\n`);
    case 'gate-cmd/gate-cmd': return { code: h.gateCmdCode?.[id]?.length ? h.gateCmdCode[id].shift() : 0, stdout: '', stderr: 'gate output' };
    default: return ok();
  }
}

function fillTemplate(action) {
  let text = readFileSync(action.template, 'utf8');
  for (const [slot, value] of Object.entries(action.slots)) {
    text = value === null ? text.split('\n').filter((line) => !line.includes(slot)).join('\n') : text.replaceAll(slot, value);
  }
  return action.append ? `${text}${action.append}` : text;
}

function author(h, action) {
  if (action.step === 'ruling') {
    const value = h.rulings.length ? h.rulings.shift() : { ruled: action.ruling.keys.at(-1), evidence: 'node --test: 12 pass' };
    mkdirSync(dirname(action.outPath), { recursive: true });
    writeFileSync(action.outPath, JSON.stringify(value));
    return {};
  }
  if (action.step === 'council') {
    mkdirSync(dirname(action.outPath), { recursive: true });
    writeFileSync(action.outPath, JSON.stringify({ title: action.title }));
    return {};
  }
  if (action.files) {
    mkdirSync(action.outPath, { recursive: true });
    for (const file of action.files) writeFileSync(file.path, `${file.verdict}\n`);
    return {};
  }
  writeFileSync(action.outPath, action.template ? fillTemplate(action) : action.instruction);
  return {};
}

function tool(h, action) {
  switch (action.tool) {
    case 'spine_receipt': return structuredClone(RECEIPT);
    case 'spine_update': return { ok: true, applied: Object.keys(action.args) };
    case 'spine_quest': return h.spineQuest ? h.spineQuest(action) : { quests: [{ id: ANCHOR, latestReceipt: null }] };
    case 'council_review': return { models: { 'gpt-6.1-sol': { status: 'success' } } };
    case 'council_synthesize': return h.synth.length ? h.synth.shift() : { findings: 0, seats: ['gpt-6.1-sol'] };
    case 'council_challenge': return { success: true };
    default: throw new Error(`no fake for ${action.tool}`);
  }
}

async function perform(h, action) {
  const custom = h.answer?.(action);
  if (custom !== undefined) return custom;
  switch (action.kind) {
    case 'wait': return {};
    case 'author': return author(h, action);
    case 'agent-tool': return tool(h, action);
    case 'inspect': return { verdict: 'addresses-findings', tail: action.land.tail, head: action.land.head };
    default: return shellResult(h, action);
  }
}

// Emit as conduct.mjs does: stamp `<seq>-<step>` and the seam, keep pending.
async function step(h) {
  if (h.disk) {
    const result = await runConduct(['next', '--run', h.runDir], h.overrides());
    assert.equal(result.code, 0, result.stderr);
    const { action } = JSON.parse(result.stdout);
    return action.kind === 'done' ? null : action;
  }
  if (!h.state.pending) {
    const spec = await build.next(h.state, h.deps);
    if (!spec) {
      saveState(h.state, h.deps);
      return null;
    }
    assert.ok(STEPS.includes(spec.step), `step ${spec.step}`);
    h.state.seq += 1;
    h.state.pending = { id: `${h.state.seq}-${spec.step}`, phase: 'build', ...spec, seam: spec.seam !== undefined ? spec.seam : STEP_SEAM[spec.step] };
    saveState(h.state, h.deps);
  }
  return h.state.pending;
}

async function recordPending(h, result) {
  if (h.disk) {
    const action = loadState(h.runDir, h.deps).pending;
    const out = await runConduct(['record', '--run', h.runDir, '--action', action.id, '--result', JSON.stringify(result)], h.overrides());
    assert.ok([0, 3].includes(out.code), out.stderr);
    return;
  }
  const action = h.state.pending;
  await build.record(h.state, action, result, h.deps);
  h.state.pending = null;
  h.state.lastRecorded = action.id;
  saveState(h.state, h.deps);
}

// Run actions until `until(action)` holds for an emitted action (returned
// pending), or the phase leaves build (null).
async function drive(h, { until = () => false, max = 600 } = {}) {
  for (let i = 0; i < max; i += 1) {
    const action = await step(h);
    if (!action) return null;
    // A pending action a previous drive stopped at is already traced.
    if (h.trace.at(-1)?.id !== action.id) {
      h.trace.push(action);
      h.onEmit?.(action);
    }
    if (until(action, h)) return action;
    const result = await perform(h, action);
    h.onPerform?.(action, result);
    await recordPending(h, result);
  }
  throw new Error(`drive did not settle: ${h.trace.slice(-6).map((a) => `${a.id}${a.wpId ? `@${a.wpId}` : ''}`).join(', ')}`);
}

const of = (h, id) => h.trace.filter((a) => a.wpId === id);
const indexWhere = (h, fn) => h.trace.findIndex(fn);
const isWait = (a) => a.kind === 'wait';
const firstNonWait = (h, from, id) => h.trace.slice(from + 1).find((a) => a.wpId === id && !isWait(a));

// ---------------------------------------------------------------------------

test('lane contract: the first action; run-level slots refused (exit 2); per-lane placeholders stay; laneSuite fills the isolation slot', async (t) => {
  const h = harness(t);
  const first = await step(h);
  assert.equal(first.kind, 'author');
  assert.equal(first.step, 'contract');
  assert.equal(first.outPath, join(h.runDir, '_lane-contract.md'));
  assert.ok(first.template.endsWith(join('reference', 'templates', 'lane-contract.template.md')));
  const isolation = Object.entries(first.slots).find(([slot]) => slot.startsWith('<Per-repo lane isolation'));
  assert.equal(isolation[1], JSON.parse(fixture('build', 'conduct.json')).laneSuite);
  assert.equal(first.slots['<run name>'], 'conduct demo');
  assert.equal(first.slots['<gate command(s)>'], 'node --version');
  await assert.rejects(recordPending(h, {}), { code: 2, message: /was not written/ });
  const filled = fillTemplate(first);
  for (const bad of [`${filled}\nrun: <run name>\n`, `${filled}\n- <repo B>: \`x\`\n`]) {
    writeFileSync(first.outPath, bad);
    await assert.rejects(recordPending(h, {}), { code: 2, message: /run-level slots/ });
  }
  assert.equal(first.slots['<repo B>'], null, 'a single-repo run deletes the <repo B lines');
  writeFileSync(first.outPath, `${filled}\nPer lane: <your-lane-id>, <id>, <lane>, <n>, <sha>, <path>\n`);
  await recordPending(h, {});
  assert.equal(h.state.build.contract, first.outPath);
  // Every lane brief links the contract.
  await drive(h);
  const briefs = h.trace.filter((a) => a.step === 'brief' && a.part === 'brief');
  assert.deepEqual(briefs.map((a) => a.wpId), ['WP-02', 'WP-03']);
  for (const brief of briefs) assert.equal(brief.slots['<lane contract path>'], join(h.runDir, '_lane-contract.md'));
});

test('lane contract: with no laneSuite the isolation slot reads "none declared" and no run deltas are appended', async (t) => {
  const h = harness(t, { config: JSON.stringify({ contractPaths: [] }) });
  const first = await step(h);
  assert.equal(Object.entries(first.slots).find(([slot]) => slot.startsWith('<Per-repo lane isolation'))[1], 'none declared');
  assert.equal(first.append, undefined);
  writeFileSync(first.outPath, fillTemplate(first));
  await recordPending(h, {});
  assert.ok(h.state.build.contract);
});

test('run deltas for laneSuite (D20): set → a contract without ## Run deltas is exit 2, with it accepted; absent → accepted without', async (t) => {
  const h = harness(t);
  const first = await step(h);
  assert.match(first.append, /^\n## Run deltas\n/);
  assert.match(first.append, /overrides rule 9/);
  writeFileSync(first.outPath, fillTemplate({ ...first, append: undefined }));
  await assert.rejects(recordPending(h, {}), { code: 2, message: /## Run deltas/ });
  writeFileSync(first.outPath, fillTemplate(first));
  await recordPending(h, {});
  const bare = harness(t, { config: null });
  const action = await step(bare);
  writeFileSync(action.outPath, fillTemplate(action));
  await recordPending(bare, {});
  assert.ok(bare.state.build.contract);
});

test('two lanes, disjoint: WP-02 and WP-03 are live at once; sharing a file, never', async (t) => {
  for (const [files, expected] of [[['lib/land.mjs'], 2], [['lib/lanes.mjs'], 1]]) {
    const h = harness(t, { wps: [TWO[0], TWO[1], { ...TWO[2], files }] });
    h.life = { 'WP-02': 2, 'WP-03': 2 };
    let most = 0;
    h.onEmit = () => { most = Math.max(most, h.state.wps.filter((wp) => LIVE.includes(wp.state)).length); };
    assert.equal(await drive(h), null);
    assert.equal(most, expected, `files ${files}`);
    assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
    assert.equal(h.state.phase, 'release');
  }
});

test('waits yield (D17): a waiting WP-02 does not stop WP-03\'s dispatch; all waiting → one wait of the least remaining time', async (t) => {
  const h = harness(t);
  h.life = { 'WP-02': 3, 'WP-03': 3 };
  const first3 = await drive(h, { until: (a) => a.wpId === 'WP-03' });
  assert.equal(first3.step, 'create');
  const alive = of(h, 'WP-02').filter((a) => a.step === 'wait');
  assert.equal(alive.length, 1, 'WP-02 polled once and is waiting');
  assert.ok(LIVE.includes(h.wp('WP-02').state));
  assert.equal(h.trace.filter(isWait).length, 0, 'no wait was returned while WP-03 could be dispatched');
  const yielded = await drive(h, { until: isWait });
  assert.equal(yielded.yield, true);
  assert.equal(yielded.waitMs, 60000);
  // Shorten WP-03's wait: the one wait is the least remaining, and recording it
  // releases WP-03 while WP-02 keeps the rest of its own.
  h.state.pending = null;
  h.wp('WP-03').queue[0].remainingMs = 15000;
  const least = await step(h);
  assert.equal(least.waitMs, 15000);
  await recordPending(h, {});
  assert.equal(h.wp('WP-02').queue[0].remainingMs, 45000);
  const after = await step(h);
  assert.equal(after.wpId, 'WP-03');
  assert.equal(after.step, 'wait');
});

test('herdr polls and yields (D19.17): wait exit 4 yields to WP-03\'s dispatch; the next poll repeats the argv; WP-03 is created while WP-02 is live', async (t) => {
  const h = harness(t, { herdr: true });
  h.herdrWait = { 'WP-02': [4, 4, 0], 'WP-03': [4, 0] };
  await drive(h, { until: (a) => a.wpId === 'WP-03' });
  const polls = of(h, 'WP-02').filter((a) => a.step === 'wait');
  assert.equal(polls.length, 1);
  assert.equal(flagOf(polls[0].command, 'timeout'), '60000');
  assert.equal(h.trace.at(-1).step, 'admit', 'WP-03 is dispatched next');
  let createdWhileLive = false;
  h.onEmit = (a) => { if (a.wpId === 'WP-03' && a.step === 'create' && a.part === 'lane') createdWhileLive = LIVE.includes(h.wp('WP-02').state); };
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'wait' });
  assert.ok(createdWhileLive);
  assert.deepEqual(h.trace.at(-1).command, polls[0].command);
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
});

test('lane deadline: an injected clock past lane.deadline blocks that WP ("lane deadline") while the other WP merges', async (t) => {
  const h = harness(t);
  h.life = { 'WP-02': 3, 'WP-03': 1 };
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'wait' });
  h.tick(121 * 60000);
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.equal(h.wp('WP-02').reason, 'lane deadline');
  assert.equal(h.wp('WP-03').state, 'merged');
  assert.ok(of(h, 'WP-02').some((a) => a.step === 'stop'), 'the stop is owed cleanup');
  assert.ok(h.wp('WP-02').lane.exitedAt, 'the stop was confirmed');
});

test('step arrays: a herdr check array is emitted one action per next, in order; --expect-pr carries the number gh pr list stored', async (t) => {
  const h = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  await drive(h);
  const checks = of(h, 'WP-02').filter((a) => ['check', 'pr-lookup'].includes(a.step));
  assert.deepEqual(checks.map((a) => `${a.step}/${a.part}`), ['check/report', 'check/shape', 'pr-lookup/undefined', 'check/pr']);
  const at = checks.map((a) => h.trace.indexOf(a));
  assert.deepEqual(at, at.map((i, k) => at[0] + k), 'consecutive');
  assert.ok(checks[0].command.includes('--runtime-only'));
  assert.equal(checks[0].seam, 'runtime-exercise');
  assert.equal(flagOf(checks[3].command, 'expect-pr'), '102');
  assert.equal(h.wp('WP-02').pr.number, 102);
});

test('backend (D18, D19.18): flipping herdr off after dispatch keeps the WP on herdr; herdr on outside a projects tree → exec with the reason', async (t) => {
  const h = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  await drive(h, { until: (a) => a.step === 'create' });
  h.state.adapters.herdr.on = false;
  await drive(h);
  assert.equal(h.wp('WP-02').lane.backend, 'herdr');
  for (const a of of(h, 'WP-02').filter((x) => ['start', 'wait', 'stop'].includes(x.step))) assert.ok(a.command[1].endsWith('lane.mjs'), a.id);
  const outside = harness(t, { herdr: true, inProjects: false, wps: [TWO[0], TWO[1]] });
  await drive(outside, { until: (a) => a.wpId === 'WP-02' });
  assert.equal(outside.wp('WP-02').lane.backend, 'exec');
  assert.match(outside.state.adapters.herdr.detail, /not a projects tree/);
});

test('outcome first (D19.16): a refuted report → WP refuted, its dependent deferred naming it, a stop, no review; the build ends', async (t) => {
  const h = harness(t, { herdr: true, wps: withFour });
  h.reports = { 'WP-02': ['report-refuted.md'] };
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'refuted');
  assert.equal(h.wp('WP-04').state, 'deferred');
  assert.match(h.wp('WP-04').reason, /WP-02/);
  assert.ok(of(h, 'WP-02').some((a) => a.step === 'stop' && a.command[2] === 'stop'));
  assert.ok(!of(h, 'WP-02').some((a) => ['review', 'post', 'council'].includes(a.step)));
  assert.equal(h.wp('WP-03').state, 'merged');
  assert.equal(h.state.phase, 'release');
});

test('rulings before escalation (D19.3): needs conductor → a ruling author, not a touch; bad rulings exit 2; a ruling amends the lane', async (t) => {
  const h = harness(t);
  h.reports = { 'WP-02': ['report-needs-conductor.md', 'report-built.md'] };
  const ruling = await drive(h, { until: (a) => a.step === 'ruling' });
  assert.equal(ruling.outPath, join(h.runDir, 'rulings', 'wp-02-1.json'));
  assert.deepEqual(ruling.ruling.keys, ['a', 'b']);
  mkdirSync(dirname(ruling.outPath), { recursive: true });
  for (const bad of [{ ruled: 'z', evidence: 'x' }, { ruled: 'b', evidence: '  ' }, { escalate: true }]) {
    writeFileSync(ruling.outPath, JSON.stringify(bad));
    await assert.rejects(recordPending(h, {}), { code: 2 });
  }
  writeFileSync(ruling.outPath, JSON.stringify({ ruled: 'b', evidence: 'grep -n since lib/x.mjs → 12: --since' }));
  await recordPending(h, {});
  const brief = await step(h);
  assert.equal(brief.step, 'brief');
  assert.equal(brief.part, 'amendment');
  assert.match(brief.instruction, /ruled \(b\)/);
  assert.match(brief.instruction, /grep -n since lib\/x\.mjs → 12: --since/);
  assert.equal(h.wp('WP-02').state, 'amending');
  assert.deepEqual(h.wp('WP-02').rulings, [{ n: 1, file: 'rulings/wp-02-1.json', ruled: 'b', escalate: false }]);
  assert.ok(!h.events().some((e) => e.event === 'touch-opened'));
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('rulings before escalation (D19.3): an escalation opens one blocked touch with the lane\'s letters, wpId and check; WP-03 still merges', async (t) => {
  const h = harness(t);
  h.reports = { 'WP-02': ['report-needs-conductor.md'] };
  h.rulings = [{ escalate: true, why: 'only the operator knows which flag name ships' }];
  await drive(h, { until: () => h.state.wps[2].state === 'merged' });
  assert.equal(h.state.touches.length, 1);
  const [touch] = h.state.touches;
  assert.deepEqual(touch.options.map((o) => [o.key, o.label]), [['a', '- (a) keep the old flag name'], ['b', '- (b) rename the flag to --since']]);
  assert.equal(touch.wpId, 'WP-02');
  assert.equal(touch.suspendedStep, 'check');
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.equal(h.events().filter((e) => e.event === 'touch-opened').length, 1);
});

function answerCore(h, n, key, text = null) {
  const touch = h.state.touches[n - 1];
  touch.tty = true;
  acceptAnswer(touch, { key, text, by: 'operator:tty', answeredAt: h.deps.timestamp(), source: 'tty' });
}

test('blocked recovery (D19.4): an answer amends the blocked lane verbatim; its deferred dependent returns to pending and runs after it merges; a fresh runConduct agrees', async (t) => {
  const h = harness(t, { wps: withFour });
  h.reports = { 'WP-02': ['report-needs-conductor.md', 'report-built.md'] };
  h.rulings = [{ escalate: true, why: 'operator call' }];
  await drive(h, { until: () => h.state.wps[3].state === 'deferred' });
  assert.equal(h.wp('WP-03').state, 'merged');
  assert.match(h.wp('WP-04').reason, /WP-02, which is blocked/);
  h.state.pending = null;
  answerCore(h, 1, 'b', 'use --since');
  saveState(h.state, h.deps);
  const fresh = JSON.parse((await runConduct(['next', '--run', h.runDir], h.overrides())).stdout).action;
  h.state = loadState(h.runDir, h.deps);
  const brief = h.state.pending;
  assert.deepEqual(fresh, brief);
  assert.equal(brief.wpId, 'WP-02');
  assert.equal(brief.part, 'amendment');
  assert.match(brief.instruction, /verbatim: \(b\) use --since/);
  assert.equal(h.wp('WP-02').state, 'amending');
  assert.equal(h.wp('WP-04').state, 'pending');
  h.trace.push(brief);
  await recordPending(h, author(h, brief));
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged', 'merged']);
  const merged2 = indexWhere(h, (a) => a.wpId === 'WP-02' && a.step === 'merged');
  assert.ok(indexWhere(h, (a) => a.wpId === 'WP-04') > merged2, 'WP-04 dispatched after WP-02 merged');
  const afterBrief = of(h, 'WP-02').slice(of(h, 'WP-02').indexOf(brief) + 1).map((a) => a.step);
  assert.deepEqual(afterBrief.slice(0, 3), ['prompt', 'wait', 'check']);
});

test('blocked recovery (D19.4): with dispatch exhausted the build stays in build, emitting only the read-back and its 300000 ms wait, until the answer', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1], { id: 'WP-04', files: ['x.mjs'], wave: 3, dependsOn: ['WP-02'] }] });
  h.reports = { 'WP-02': ['report-needs-conductor.md', 'report-built.md'] };
  h.rulings = [{ escalate: true, why: 'operator call' }];
  await drive(h, { until: (a) => a.tool === 'spine_receipt' && a.args.outcome === 'needs_input' });
  const from = h.trace.length - 1;
  await drive(h, { until: () => h.trace.length >= from + 9 });
  const quiet = h.trace.slice(from);
  for (const a of quiet) {
    assert.ok((a.kind === 'agent-tool' && ['spine_receipt', 'spine_quest'].includes(a.tool)) || (a.kind === 'wait' && a.waitMs === 300000), `${a.id} ${a.kind} ${a.tool ?? a.waitMs}`);
  }
  assert.equal(quiet.filter((a) => a.tool === 'spine_receipt').length, 1);
  assert.equal(h.state.phase, 'build');
  assert.equal(h.wp('WP-04').state, 'deferred');
  // The operator answers (a) on the spine: the read-back carries it.
  h.spineQuest = () => {
    const result = JSON.parse(fixture('intake', 'spine-quest-answered.json'));
    result.quests[0].latestReceipt.question = `${correlation(h.state, h.state.touches[0])} synthetic question`;
    result.quests[0].latestReceipt.answer.key = 'a';
    return result;
  };
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
});

test('runtime exercise required: a report with no Verdict line → an amendment re-prompt, not a review; the amended report → review', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[2]] });
  h.reports = { 'WP-03': ['report-no-verdict.md', 'report-built.md'] };
  await drive(h, { until: (a) => a.step === 'review' });
  const steps = of(h, 'WP-03');
  const brief = steps.find((a) => a.part === 'amendment');
  assert.ok(brief, 'an amendment brief');
  assert.match(brief.instruction, /runtime exercise missing/);
  assert.ok(steps.indexOf(brief) < steps.findIndex((a) => a.step === 'review'));
  assert.equal(steps.filter((a) => a.step === 'review').length, 1, 'no review before the amendment');
  assert.equal(h.wp('WP-03').runtimeVerdict, 'exercised');
});

test('threads in the loop (D19.9): findings → amendment → its table → adjudicate, three replies, one thread-ids, three resolves → the gate passes → merge', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [3] };
  h.reports = { 'WP-02': ['report-built.md', 'report-amendment.md'] };
  h.unresolved = () => h.resolved < 3;
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.ok(h.events().some((e) => e.event === 'adjudicated' && e.data.rows.length === 3));
  const tail = of(h, 'WP-02').filter((a) => ['reply', 'thread-ids', 'resolve'].includes(a.step)).map((a) => `${a.step}/${a.part}`);
  assert.deepEqual(tail, ['reply/bodies', 'reply/reply', 'reply/reply', 'reply/reply', 'thread-ids/lookup', 'resolve/resolve', 'resolve/resolve', 'resolve/resolve']);
  const replies = of(h, 'WP-02').filter((a) => a.part === 'reply');
  assert.deepEqual(replies.map((a) => flagOf(a.command, 'verdict')), ['confirmed', 'refuted', 'judgment']);
  const gate = of(h, 'WP-02').findIndex((a) => a.step === 'gate');
  assert.ok(gate > of(h, 'WP-02').findIndex((a) => a.step === 'resolve'));
  assert.ok(of(h, 'WP-02').some((a) => a.step === 'merged'));
});

test('council meta and args (D20): meta precedes council_review; its args; a missing or wrong meta exits 2; C-ids reach the brief; no reply, thread-ids or resolve', async (t) => {
  const h = harness(t, { council: true, wps: [TWO[0], { ...TWO[1], tier: 'T2' }] });
  h.synth = [{ findings: 2, seats: ['gpt-6.1-sol'] }, { findings: 0, seats: ['gpt-6.1-sol'] }];
  h.reports = { 'WP-02': ['report-built.md', 'report-council-amendment.md'] };
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  const meta = await drive(h, { until: (a) => a.part === 'meta' });
  assert.equal(meta.outPath, join(h.runDir, 'council', 'wp-02', 'meta.json'));
  await assert.rejects(recordPending(h, {}), { code: 2, message: /was not written/ });
  mkdirSync(dirname(meta.outPath), { recursive: true });
  writeFileSync(meta.outPath, JSON.stringify({ title: 'WP-02: something else' }));
  await assert.rejects(recordPending(h, {}), { code: 2, message: /title/ });
  writeFileSync(meta.outPath, JSON.stringify({ title: 'WP-02: name WP-02' }));
  await recordPending(h, {});
  const review = await step(h);
  h.trace.push(review);
  assert.equal(review.tool, 'council_review');
  const wt = h.wp('WP-02').lane.worktree;
  assert.equal(review.args.workshop_path, `${join(h.runDir, 'council', 'wp-02')}${sep}`);
  assert.equal(review.args.output_dir, `${join(h.runDir, 'council', 'wp-02', 'review-1')}${sep}`);
  assert.equal(review.args.code_root, wt);
  assert.equal(review.args.profile, 'code');
  assert.ok(!('models' in review.args));
  assert.deepEqual(review.args.artifact_paths, [join(wt, 'src/a.mjs')]);
  await recordPending(h, await perform(h, review));
  const brief = await drive(h, { until: (a) => a.part === 'amendment' });
  assert.match(brief.instruction, /C1-1, C1-2/);
  const between = of(h, 'WP-02').slice(of(h, 'WP-02').findIndex((a) => a.tool === 'council_synthesize') + 1, -1);
  assert.deepEqual(between.map((a) => a.tool), ['council_challenge']);
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  assert.ok(!all.some((a) => ['reply', 'thread-ids', 'resolve'].includes(a.step)));
  const second = all.findIndex((a) => a.tool === 'council_review' && a.args.round === 2);
  assert.ok(second > all.indexOf(brief), 'the delta council round');
  assert.ok(all.findIndex((a) => a.step === 'rebase') > second);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('zero findings (D20): a post or a council synthesis with findings 0 goes straight to the rebase; findings null → an amendment brief', async (t) => {
  for (const council of [false, true]) {
    const h = harness(t, { council, wps: [TWO[0], { ...TWO[1], tier: council ? 'T2' : 'T1' }] });
    await drive(h, { until: (a) => a.step === 'rebase' });
    const all = of(h, 'WP-02');
    const recorded = all.findLastIndex((a) => (council ? a.tool === 'council_synthesize' : a.step === 'post'));
    assert.equal(all[recorded + 1].part, 'fetch', `council ${council}: next is the rebase fetch`);
    assert.ok(!all.some((a) => ['brief', 'reply', 'resolve', 'thread-ids'].includes(a.step) && a.part !== 'brief'));
    assert.ok(!h.events().some((e) => e.event === 'adjudicated'));
  }
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [null] };
  const brief = await drive(h, { until: (a) => a.step === 'brief' && a.part === 'amendment' || a.step === 'rebase' });
  assert.equal(brief.part, 'amendment');
});

test('guard ruling (D20): a conductor row is ruled before any reply to it; refuted → reply --adjudicator conductor, then its resolve; escalate → a WP touch', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [2] };
  h.reports = { 'WP-02': ['report-built.md', 'report-guard.md'] };
  h.rulings = [{ ruled: 'refuted', evidence: 'test 7 still asserts it: grep -n "stale base" lib/land.test.mjs' }];
  h.unresolved = () => h.resolved < 2;
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  const ruling = all.findIndex((a) => a.step === 'ruling');
  assert.equal(all[ruling].outPath, join(h.runDir, 'rulings', 'wp-02-1.json'));
  assert.equal(all[ruling].part, 'guard');
  const guardReply = all.findIndex((a) => a.part === 'reply' && a.command.includes('4177234275'));
  assert.ok(ruling < guardReply);
  const reply = all[guardReply].command;
  assert.equal(flagOf(reply, 'verdict'), 'refuted');
  assert.equal(flagOf(reply, 'adjudicator'), 'conductor');
  assert.equal(flagOf(reply, 'body-file'), join(h.runDir, 'reviews', 'wp-02', 'replies', '4177234275.md'));
  const lookup = all.find((a) => a.step === 'thread-ids');
  assert.deepEqual(lookup.land.commentIds, ['4177234272', '4177234275']);
  assert.equal(all.filter((a) => a.step === 'resolve').length, 2);
  assert.equal(h.wp('WP-02').state, 'merged');

  const e = harness(t, { wps: [TWO[0], TWO[1]] });
  e.findings = { 'WP-02': [2] };
  e.reports = { 'WP-02': ['report-built.md', 'report-guard.md'] };
  e.rulings = [{ escalate: true, why: 'is the deleted test a weakening?' }];
  await drive(e, { until: () => e.state.touches.length > 0 });
  assert.equal(e.state.touches[0].wpId, 'WP-02');
  assert.equal(e.wp('WP-02').state, 'blocked');
});

test('executable line (D20): an amendment changing only *.md → no delta review; *.mjs, *.test.mjs or a __fixtures__/ file → deltaReviewActions', async (t) => {
  for (const [paths, delta] of [['docs/a.md\nREADME.md\n', false], ['lib/x.mjs\n', true], ['lib/x.test.mjs\n', true], ['skills/conduct/scripts/__fixtures__/build/x.md\n', true]]) {
    const h = harness(t, { wps: [TWO[0], TWO[1]] });
    h.findings = { 'WP-02': [3] };
    h.reports = { 'WP-02': ['report-built.md', 'report-amendment.md'] };
    h.amendDiff = { 'WP-02': paths };
    await drive(h, { until: (a) => a.step === 'rebase' });
    const all = of(h, 'WP-02');
    const diff = all.findIndex((a) => a.part === 'amend-diff');
    const after = all[diff + 1];
    if (delta) {
      assert.ok(['review', 'post'].includes(after.step), `${paths}: ${after.step}`);
      assert.equal(after.land.scope, 'delta');
      assert.equal(after.land.since, h.wp('WP-02').amendment.since);
    } else assert.equal(after.part, 'fetch', paths);
  }
});

test('notify env (D20): argv is shellArgv(WORKIT_NOTIFY_CMD) unchanged; the PR, merge sha and revert ride env', async (t) => {
  const command = 'notify-me --channel "#runs"';
  const h = harness(t, { notify: true, env: { WORKIT_NOTIFY_CMD: command }, wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(h), null);
  const notify = of(h, 'WP-02').find((a) => a.step === 'notify');
  assert.deepEqual(notify.command, shellArgv(command, 'linux'));
  assert.deepEqual(notify.env, { WORKIT_NOTIFY_PR: '102', WORKIT_NOTIFY_SHA: mergeSha('WP-02'), WORKIT_NOTIFY_REVERT: `git revert ${mergeSha('WP-02')}` });
});

test('merge lock (D19.8): WP-03\'s rebase waits while WP-02 holds the lock and runs after WP-02 merged; a gate-command failure releases the lock', async (t) => {
  const h = harness(t);
  h.life = { 'WP-02': 1, 'WP-03': 1 };
  let pendingReads = 0;
  h.checkRuns = (head) => {
    const runs = JSON.parse(fixture('land', 'check-runs-green.json'));
    if (head === h.head('WP-02') && (pendingReads += 1) <= 6) runs.check_runs[0].status = 'in_progress';
    return JSON.stringify(runs);
  };
  let yielded = false;
  h.onEmit = (a) => {
    const three = h.wp('WP-03');
    if (h.state.mergeLock?.wpId === 'WP-02' && three.stage === 'land' && three.queue[0]?.kind === 'wait') yielded = true;
    if (a.wpId === 'WP-03' && a.step === 'rebase') assert.notEqual(h.state.mergeLock?.wpId, 'WP-02', `${a.id} emitted under WP-02's lock`);
  };
  assert.equal(await drive(h), null);
  assert.ok(yielded, 'WP-03 reached its rebase while WP-02 held the lock');
  const merged2 = indexWhere(h, (a) => a.wpId === 'WP-02' && a.step === 'merged');
  const landing = of(h, 'WP-03').filter((a) => ['rebase', 'gate-cmd', 'gate'].includes(a.step) && !isWait(a));
  assert.equal(`${landing[0].step}/${landing[0].part}`, 'rebase/fetch', 'WP-03 lands through its own rebase');
  assert.ok(h.trace.indexOf(landing[0]) > merged2);
  assert.equal(landing.filter((a) => a.part === 'gate').length, 1, 'one gate run: the lock was held when it ran');
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);

  const g = harness(t, { wps: [TWO[0], TWO[1]] });
  g.gateCmdCode = { 'WP-02': [1] };
  await drive(g, { until: (a) => a.step === 'gate-cmd' });
  assert.equal(g.state.mergeLock.wpId, 'WP-02');
  await recordPending(g, await perform(g, g.state.pending));
  assert.equal(g.state.mergeLock, null);
});

test('stale base (D19.8): land gate reporting staleBase → rebaseActions again, never an amendment', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.stale = 1;
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  const gates = all.filter((a) => a.step === 'gate' && a.part === 'gate');
  assert.equal(gates.length, 2);
  assert.equal(all[all.indexOf(gates[0]) + 1].part, 'fetch');
  assert.ok(!all.some((a) => a.part === 'amendment'));
  assert.equal(h.wp('WP-02').rebases.length, 2);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('merged anomaly (D19.8): land merged code 5 → dispatchHalt, no new dispatch while set, a run touch whose (a) clears it', async (t) => {
  const h = harness(t, { wps: [...TWO, { id: 'WP-04', files: ['lib/x.mjs'], dependsOn: ['WP-01'] }] });
  h.life = { 'WP-02': 1, 'WP-03': 8 };
  h.treeMismatch = 'WP-02';
  await drive(h, { until: () => h.state.touches.length > 0 });
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.equal(h.wp('WP-02').reason, 'merged tree differs from the checked head');
  assert.ok(h.state.dispatchHalt);
  assert.equal(h.state.touches[0].wpId, null);
  const from = h.trace.length;
  await drive(h, { until: (a) => a.wpId === 'WP-03' && a.step === 'wait' && h.trace.length > from + 2 });
  assert.ok(!h.trace.slice(from).some((a) => a.wpId === 'WP-04'), 'no dispatch while halted');
  h.state.pending = null;
  h.trace.pop();
  answerCore(h, 1, 'a');
  assert.equal(await drive(h), null);
  assert.equal(h.state.dispatchHalt, null);
  assert.equal(h.wp('WP-04').state, 'merged');
});

test('hold at PR (D12): no merge authority → WP-01 held (gate stored, lock released), its dependents deferred, no merge action, phase release', async (t) => {
  const h = harness(t, { merge: false, wps: [{ id: 'WP-01', files: ['a.mjs'], wave: 1 }, { ...TWO[1] }, { ...TWO[2] }] });
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-01').state, 'held');
  assert.equal(h.wp('WP-01').gate.ok, true);
  assert.equal(h.state.mergeLock, null);
  for (const id of ['WP-02', 'WP-03']) {
    assert.equal(h.wp(id).state, 'deferred');
    assert.match(h.wp(id).reason, /WP-01/);
  }
  assert.ok(!h.trace.some((a) => a.step === 'merge' || a.step === 'merged'));
  assert.equal(h.state.phase, 'release');
});

test('authority only (D19.1): authority.budgetUsd below the lane-only sum halts whatever intent.budgetUsd says', async (t) => {
  const h = harness(t, { budget: 0.5, lanes: 1 });
  h.state.intent.budgetUsd = 100;
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(h.wp('WP-03').state, 'pending');
  assert.ok(h.state.dispatchHalt);
  assert.match(h.state.touches[0].question, new RegExp(`\\$${LANE_COST} against the \\$0\\.5 budget \\(unmetered, lane-only lower bound\\)`));
});

test('budget (D16, D19.28): metered spend at the budget → no dispatch and a touch saying metered; the spend argv is shellArgv', async (t) => {
  const h = harness(t, { spend: true, env: { WORKIT_SPEND_CMD: 'spend-meter --usd' } });
  h.spendUsd = 30;
  assert.equal(await drive(h), null);
  const spend = h.trace.find((a) => a.step === 'spend');
  assert.deepEqual(spend.command, shellArgv(`spend-meter --usd ${h.state.createdAt}`, 'linux'));
  assert.ok(!h.trace.some((a) => a.wpId), 'nothing dispatched');
  assert.match(h.state.touches[0].question, /Spend is \$30 against the \$25 budget \(metered by the spend adapter\)/);
  assert.deepEqual(h.state.touches[0].options.map((o) => o.key), ['a', 'b']);
});

function pendingRuns(h, id, count) {
  let reads = 0;
  return (head) => {
    const runs = JSON.parse(fixture('land', 'check-runs-green.json'));
    if (head === h.head(id) && (reads += 1) <= count) runs.check_runs[0].status = 'in_progress';
    return JSON.stringify(runs);
  };
}

test('CI pending (D13): land gate exit 6 twice, then 0 → two waits, then the merge', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.checkRuns = pendingRuns(h, 'WP-02', 2);
  const codes = [];
  h.onPerform = (a, r) => { if (a.step === 'gate' && a.part === 'gate') codes.push(r.code); };
  assert.equal(await drive(h), null);
  assert.deepEqual(codes, [6, 6, 0]);
  const all = of(h, 'WP-02');
  assert.equal(h.trace.filter((a) => isWait(a) && a.step === 'gate').length, 2);
  assert.ok(all.findIndex((a) => a.step === 'merge') > all.findLastIndex((a) => a.step === 'gate'));
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('CI pending (D18): pendingSince is set at the first pending, kept at the same head, reset at a new head, cleared on ok; 31 minutes → blocked', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.checkRuns = pendingRuns(h, 'WP-02', 99);
  const seen = [];
  h.onPerform = (a) => { if (a.step === 'gate' && a.part === 'gate') h.tick(60000); };
  h.onEmit = (a) => { if (a.wpId === 'WP-02' && a.step === 'gate' && a.part === 'gate') seen.push({ head: h.wp('WP-02').gate?.head, since: h.wp('WP-02').gate?.pendingSince }); };
  await drive(h, { until: () => seen.length === 3 });
  const first = seen[1].since;
  assert.ok(first);
  assert.equal(seen[2].since, first, 'kept at the same head');
  // A new head: a stale base forces a rebase; then CI goes green.
  h.state.pending = null;
  h.trace.pop();
  h.stale = 1;
  h.checkRuns = undefined;
  h.onPerform = undefined;
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'rebase' && a.part === 'fetch' });
  h.checkRuns = pendingRuns(h, 'WP-02', 1);
  await drive(h, { until: (a) => a.step === 'merge' });
  const gates = h.wp('WP-02');
  assert.equal(gates.gate.ok, true);
  assert.equal(gates.gate.pendingSince, null, 'cleared on ok');

  const b = harness(t);
  b.life = { 'WP-02': 1, 'WP-03': 1 };
  b.checkRuns = pendingRuns(b, 'WP-03', 99);
  b.onPerform = (a, r) => { if (a.wpId === 'WP-03' && a.step === 'gate' && r.code === 6) b.tick(31 * 60000); };
  const sinces = new Set();
  b.onEmit = (a) => { if (a.wpId === 'WP-03' && a.step === 'gate' && b.wp('WP-03').gate?.pendingSince) sinces.add(b.wp('WP-03').gate.pendingSince); };
  assert.equal(await drive(b), null);
  assert.equal(b.wp('WP-03').state, 'blocked');
  assert.match(b.wp('WP-03').reason, /CI did not complete at head/);
  assert.equal(b.wp('WP-02').state, 'merged');
  assert.equal(sinces.size, 1, 'one pendingSince across the pending records at one head');
});

test('placeholders (D18): --pr and --merge-sha carry the recorded values; a null merge.sha at emission → next exit 2 naming {merge.sha}', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  assert.equal(flagOf(all.find((a) => a.part === 'pr').command, 'pr'), '102');
  assert.equal(flagOf(all.find((a) => a.step === 'merged').command, 'merge-sha'), mergeSha('WP-02'));
  for (const a of h.trace) for (const arg of a.command ?? []) assert.ok(!/^\{(pr\.number|pr\.head|merge\.sha)\}$/.test(arg), `${a.id}: ${arg}`);
  const n = harness(t, { wps: [TWO[0], TWO[1]] });
  await drive(n, { until: (a) => a.part === 'merge-commit' });
  n.state.pending = null;
  n.wp('WP-02').queue.shift();
  await assert.rejects(step(n), { code: 2, message: /\{merge\.sha\}/ });
});

test('shell strings (D18, D19): the gate command is shellArgv on win32 and linux; "human review", empty and a win32 quote are not-exercised; linux runs the quote', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const h = harness(t, { platform, gateCommand: 'node --test', wps: [TWO[0], TWO[1]], spend: true, notify: true, env: { WORKIT_SPEND_CMD: 'meter', WORKIT_NOTIFY_CMD: 'ping' } });
    assert.equal(await drive(h), null);
    assert.deepEqual(h.trace.find((a) => a.step === 'gate-cmd').command, shellArgv('node --test', platform));
    assert.equal(h.trace.find((a) => a.step === 'gate-cmd').cwd, h.wp('WP-02').lane.worktree);
    assert.deepEqual(h.trace.find((a) => a.step === 'spend').command, shellArgv(`meter ${h.state.createdAt}`, platform));
    assert.deepEqual(h.trace.find((a) => a.step === 'notify').command, shellArgv('ping', platform));
  }
  for (const [platform, command, reason] of [['linux', 'human review', /is not a command/], ['linux', '', /no gate command/], ['win32', 'node -e "1"', /double quote/]]) {
    const h = harness(t, { platform, gateCommand: command, wps: [TWO[0], TWO[1]] });
    assert.equal(await drive(h), null);
    assert.ok(!h.trace.some((a) => a.step === 'gate-cmd'), `${platform} ${command}`);
    assert.equal(h.wp('WP-02').gateCmd.state, 'not-exercised');
    assert.match(h.events().find((e) => e.event === 'not-exercised' && e.step === 'gate-cmd').data.reason, reason);
    assert.equal(h.wp('WP-02').state, 'merged');
  }
  const linux = harness(t, { platform: 'linux', gateCommand: 'node -e "1"', wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(linux), null);
  assert.deepEqual(linux.trace.find((a) => a.step === 'gate-cmd').command, ['sh', '-c', 'node -e "1"']);
});

test('non-equivalent rebase (D13): differing patch-ids → a full review (round + 1) before the merge; equal patch-ids → no new review', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  let calls = 0;
  h.patchId = (input) => ((calls += 1) <= 2 ? input.replace(/\W/g, '').slice(0, 40) : 'f'.repeat(40));
  assert.equal(await drive(h), null);
  const posts = of(h, 'WP-02').filter((a) => a.step === 'post');
  assert.deepEqual(posts.map((a) => a.land.round), [1, 2]);
  assert.ok(of(h, 'WP-02').indexOf(posts[1]) < of(h, 'WP-02').findIndex((a) => a.step === 'merge'));
  assert.equal(h.wp('WP-02').rebases[0].equivalent, false);
  const same = harness(t, { wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(same), null);
  assert.equal(of(same, 'WP-02').filter((a) => a.step === 'post').length, 1);
  assert.equal(same.wp('WP-02').rebases[0].equivalent, true);
});

test('gate command: exit 1 at the rebased head → an amendment and no merge action before it', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.gateCmdCode = { 'WP-02': [1] };
  await drive(h, { until: (a) => a.part === 'amendment' || a.step === 'merge' });
  const brief = h.trace.at(-1);
  assert.equal(brief.part, 'amendment');
  assert.match(brief.instruction, /the gate command exited 1 at the rebased head/);
  assert.ok(!h.trace.some((a) => a.step === 'merge'));
});

test('gate command after a no-op rebase: the amended head gets a full review (round + 1), not a refused delta that blocks the WP', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.gateCmdCode = { 'WP-02': [1] };
  h.answer = (a) => (a.part === 'post-heads' ? ok(`${h.head(a.wpId)}\n${'e'.repeat(40)}\n`) : undefined);
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged', h.wp('WP-02').reason);
  assert.equal(h.wp('WP-02').rebases[0].from, h.wp('WP-02').rebases[0].to, 'the first rebase was a no-op');
  const posts = of(h, 'WP-02').filter((a) => a.step === 'post');
  assert.deepEqual(posts.map((a) => [a.land.round, a.land.scope]), [[1, 'full'], [2, 'full']]);
});

test('tier from the recipe file (D17, D19.11): contractPaths or an added test raise T1 to T2; neither stays T1; WP-00 at depth none too', async (t) => {
  const cases = [['scripts/lane.mjs\n', 'T2'], ['lib/x.test.mjs\n', 'T2'], ['lib/x.mjs\n', 'T1']];
  for (const [diff, tier] of cases) {
    const h = harness(t, { council: true, wps: [TWO[0], TWO[1]] });
    h.diff = { 'WP-02': diff };
    const first = await drive(h, { until: (a) => a.wpId === 'WP-02' && (a.part === 'meta' || a.part === 'managed') });
    assert.equal(first.part, tier === 'T2' ? 'meta' : 'managed', diff);
    assert.equal(h.wp('WP-02').tier, tier);
  }
  const none = harness(t, { depth: 'none', council: true });
  none.diff = { 'WP-00': 'test/x.test.mjs\n' };
  const first = await drive(none, { until: (a) => a.part === 'meta' || a.part === 'managed' });
  assert.equal(first.part, 'meta');
  assert.equal(none.wp('WP-00').tier, 'T2');
});

test('depth none: one WP-00 lane from <run>/wp-00.md; spine on → a completed receipt on the anchor and no done update; spine off → no agent-tool action', async (t) => {
  const h = harness(t, { depth: 'none', spine: true });
  assert.equal(await drive(h), null);
  assert.equal(h.trace.find((a) => a.part === 'brief').slots['<wp spec path>'], join(h.runDir, 'wp-00.md'));
  const receipts = h.trace.filter((a) => a.step === 'receipt');
  assert.deepEqual(receipts.map((a) => [a.tool, a.args.questId, a.args.outcome]), [['spine_receipt', ANCHOR, 'completed']]);
  assert.ok(!h.trace.some((a) => a.tool === 'spine_update' && a.args.workState === 'done'));
  assert.deepEqual(h.trace.find((a) => a.step === 'flip').args, { questId: ANCHOR, currentPhase: 'build' });
  assert.equal(h.wp('WP-00').state, 'merged');
  const off = harness(t, { depth: 'none' });
  assert.equal(await drive(off), null);
  assert.equal(off.wp('WP-00').state, 'merged');
  assert.deepEqual(off.trace.filter((a) => a.kind === 'agent-tool').map((a) => a.id), []);
});

test('depth deep, spine on: each WP merges with a completed receipt and a done/landed update on its own quest', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(h), null);
  assert.deepEqual(h.trace.filter((a) => a.step === 'receipt').map((a) => [a.tool, a.args.questId]), [['spine_receipt', 'quest-wp-02'], ['spine_update', 'quest-wp-02']]);
  assert.deepEqual(h.trace.find((a) => a.tool === 'spine_update' && a.step === 'receipt').args, { questId: 'quest-wp-02', workState: 'done', horizon: 'landed' });
});

test('action ids and seams (D18, D19.15): every action is <seq>-<step> with a STEPS step and seam STEP_SEAM[step], except the herdr --runtime-only check', async (t) => {
  for (const herdr of [false, true]) {
    const h = harness(t, { herdr, spine: true, council: true, notify: true, env: { WORKIT_NOTIFY_CMD: 'ping' }, wps: [TWO[0], { ...TWO[1], tier: 'T2' }, TWO[2]] });
    h.findings = { 'WP-03': [3] };
    h.reports = { 'WP-03': ['report-built.md', 'report-amendment.md'] };
    h.unresolved = () => false;
    assert.equal(await drive(h), null);
    assert.ok(h.trace.length > 40);
    for (const a of h.trace) {
      const match = /^(\d+)-(.+)$/.exec(a.id);
      assert.ok(match && match[2] === a.step && STEPS.includes(a.step), a.id);
      const runtimeOnly = a.step === 'check' && a.command?.includes('--runtime-only');
      assert.equal(a.seam, runtimeOnly ? 'runtime-exercise' : STEP_SEAM[a.step], a.id);
    }
    assert.equal(h.trace.some((a) => a.seam === 'runtime-exercise'), herdr);
  }
});

test('fail closed on owner unverified (WP-02 additions): an unreadable identity keeps the lane occupying and polled until its pid is gone', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.identity = false;
  h.life = { 'WP-02': 3 };
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'wait' });
  const result = await perform(h, h.state.pending);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).owner, 'unverified');
  await recordPending(h, result);
  assert.equal(h.wp('WP-02').lane.exitedAt ?? null, null, 'still occupying');
  const nextWp = await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
  assert.equal(nextWp.step, 'wait', 'polled again, not checked');
  assert.equal(await drive(h), null);
  const polls = of(h, 'WP-02').filter((a) => a.step === 'wait' && a.kind === 'shell').length;
  assert.equal(polls, 4, 'polled until the pid was gone');
  assert.ok(h.events().some((e) => e.event === 'owner-unverified'));
  assert.equal(h.wp('WP-02').state, 'merged');
});

const strip = (h, value) => JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(h.dir).slice(1, -1), '<dir>'));

test('resume mid-build: a fresh runConduct on the run dir after WP-01 merged emits what the uninterrupted run emits, a half-emitted array included', async (t) => {
  const wps = [{ id: 'WP-01', files: ['a.mjs'], wave: 1 }, { ...TWO[1] }, { ...TWO[2] }];
  const whole = harness(t, { wps });
  whole.disk = true;
  whole.life = { 'WP-02': 2, 'WP-03': 1 };
  assert.equal(await drive(whole), null);
  const cut = harness(t, { wps });
  cut.disk = true;
  cut.life = { 'WP-02': 2, 'WP-03': 1 };
  const at = await drive(cut, { until: (a) => a.wpId === 'WP-02' && a.step === 'base' });
  assert.equal(cut.wp('WP-01').state, 'merged');
  assert.ok(cut.wp('WP-02').queue.length >= 2, 'the create array is half emitted');
  // A fresh process: new deps, nothing carried in memory.
  cut.deps = { ...cut.deps };
  const again = await step(cut);
  assert.deepEqual(again, at);
  cut.trace.pop();
  assert.equal(await drive(cut), null);
  assert.deepEqual(strip(cut, cut.trace), strip(whole, whole.trace));
  assert.equal(loadState(cut.runDir, cut.deps).phase, 'release');
});

const PRIVATE_PATHS = [/[A-Za-z]:[\\/]+(Users|Development)\b/i, /[\\/]Users[\\/][^\\/\s"]+[\\/]/];

test('fixture paths: no file under __fixtures__/build matches either Must 8 regex', () => {
  const dir = join(FIXTURES, 'build');
  const files = readdirSync(dir);
  assert.ok(files.length >= 10, files.join(', '));
  for (const name of files) assert.deepEqual(PRIVATE_PATHS.filter((p) => p.test(readFileSync(join(dir, name), 'utf8'))).map(String), [], name);
  for (const insert of [['C:', 'Users', 'someone', 'x'].join('\\'), ['D:', 'Development', 'x'].join('/'), ['', 'Users', 'someone', ''].join('/')]) {
    assert.ok(PRIVATE_PATHS.some((p) => p.test(`text ${insert} text`)), insert);
  }
});

test('RUN_SLOTS: every run-level slot of the 0026be4 template matches a prefix; per-lane placeholders do not', () => {
  const template = fixture('build', 'lane-contract.template.md');
  for (const slot of ['<run name>', '<anchor short id>', '<absolute path to the run doc>', '<repo A>', '<repo A worktrees:', '<gate command(s)>', '<reports directory>', '<base branch per repo', '<Per-repo lane isolation', '<repo B>']) {
    assert.ok(template.includes(slot), slot);
    assert.ok(RUN_SLOTS.some((prefix) => slot.startsWith(prefix)), slot);
  }
  for (const lane of ['<id>', '<lane>', '<n>', '<sha>', '<path>', '<your-lane-id>']) assert.ok(!RUN_SLOTS.some((prefix) => lane.startsWith(prefix)), lane);
  assert.ok(basename(fileURLToPath(import.meta.url)).endsWith('.test.mjs'));
});
