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
import { join, dirname, basename, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as build from './build.mjs';
import { RUN_SLOTS } from './build.mjs';
import { preapprovedRef, wpRecord } from './spec.mjs';
import { STEPS, STEP_SEAM, saveState, readEvents, loadState } from '../state.mjs';
import { runLaneVerb } from '../lanes.mjs';
import { laneOccupied } from '../schedule.mjs';
import { runLandVerb } from '../land.mjs';
import { analyzeRun } from '../analyze.mjs';
import { shellArgv } from '../exec.mjs';
import { acceptAnswer } from '../touch.mjs';
import { runConduct } from '../../conduct.mjs';

// The section a lane PR body carries (lane contract § Finish; fca05d92).
const MERGE_DANGER = '## Merge danger\n\nDoor: two-way\nBlast radius: the demo WP\n';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..');
const FIXTURES = join(SCRIPTS, '__fixtures__');
const fixture = (dir, name) => readFileSync(join(FIXTURES, dir, name), 'utf8');
const T0 = Date.parse('2026-10-04T18:00:00.000Z');
const IDENTITY = '2026-10-04T18:00:00.0000000Z claude.exe';
const ANCHOR = '2ff76fa2-ce43-4a3c-88d0-16e2dbc0750c';
const QUEST = (id) => `00000000-0000-4000-8000-0000000000${id.slice(3).padStart(2, '0')}`;
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
// A WP that shares WP-02's Files waits for WP-02 to merge: a landing WP holds
// no lane slot but still reserves its Files (190c9a18).
const behindWp02 = (id) => ({ id, files: TWO[1].files, dependsOn: ['WP-01'] });

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
    return { ...wp, questId: opts.spine ? (spec.id === 'WP-00' ? ANCHOR : QUEST(spec.id)) : null, state: spec.state ?? 'pending' };
  });
  const on = (value) => ({ on: Boolean(value), evidence: 'probed', detail: 'fake' });
  const state = {
    schemaVersion: 1, slug: 'demo', runId: 'abcd1234', createdAt: new Date(T0).toISOString(), runDir, workshopDir, pluginRoot,
    intent: { goal: 'demo goal', repo: { path: repo, remote: 'o/r', defaultBranch: 'main' }, anchor: opts.spine ? ANCHOR : null, campaign: null,
      budgetUsd: 100, lanesCap: opts.lanes ?? 2, agent: 'claude', release: null, ciWorkflows: 1 },
    agents: { claude: on(true), codex: on(true) },
    adapters: { herdr: on(opts.herdr), notify: on(opts.notify), spine: on(opts.spine), council: on(opts.council), kb: on(false), verify: on(false), ledger: on(opts.ledger) },
    phase: 'build',
    authority: { merge: opts.merge ?? true, release: false, budgetUsd: opts.budget ?? 25, scope: 'demo goal', notes: null, grant: null },
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
  [/^git -C \S+ diff --no-color --no-ext-diff --no-textconv --no-renames --full-index \w+ \w+$/, () => ok('diff --git a/proof.txt b/proof.txt\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111\n--- /dev/null\n+++ b/proof.txt\n@@ -0,0 +1 @@\n+proof\n')],
  [/^git -C \S+ rev-parse --verify ([0-9a-f]{40})\^\{commit\}$/, (h, m) => ok(`${m[1]}\n`)],
  [/^git -C \S+ status --porcelain$/, () => ok()],
  [/Get-CimInstance|ps -o lstart/, (h) => ok(h.identity ? `${IDENTITY}\n` : '')],
  [/^git -C \S+ rev-list --count \S+\.\.HEAD$/, () => ok('1\n')],
  // The lane's diff for the report's evidence checks (e4ad108b): empty unless a test sets one.
  [/^git -C \S+ diff --no-color --no-ext-diff --no-textconv --full-index --no-renames \S+\.\.HEAD$/, (h) => ok(h.laneDiff ?? '')],
  [/^gh pr view (\d+) --repo o\/r --json headRefName,state,body$/, (h, m) => {
    const id = `WP-${String(Number(m[1]) - 100).padStart(2, '0')}`;
    // The lane's PR body: its report plus the `## Merge danger` section (fca05d92).
    const body = `${readFileSync(join(h.runDir, `lane-${id.toLowerCase()}-report.md`), 'utf8')}\n${h.mergeDanger ?? MERGE_DANGER}`;
    return ok(JSON.stringify({ headRefName: `conduct/demo/${id.toLowerCase()}`, state: 'OPEN', body }));
  }],
  [/^git -C (\S+) rev-parse HEAD$/, (h, m) => ok(`${h.head(idOfWorktree(m[1]))}\n`)],
  // The gate reads a WP PR's body for its door (fca05d92); the release PR's view has no body.
  [/^gh pr view (\d+) --repo o\/r --json headRefOid,baseRefName,state(,body)?$/, (h, m) => ok(JSON.stringify({
    headRefOid: h.head(`WP-${String(Number(m[1]) - 100).padStart(2, '0')}`), baseRefName: 'main', state: 'OPEN', ...(m[2] ? { body: h.mergeDanger ?? MERGE_DANGER } : {}) }))],
  [/^git -C \S+ fetch origin$/, () => ok()],
  [/^git -C \S+ merge-base --is-ancestor origin\/main HEAD$/, (h) => (h.stale > 0 ? (h.stale -= 1, { code: 1, stdout: '', stderr: '' }) : ok())],
  [/^git -C \S+ merge-base --is-ancestor \w+ \w+$/, () => ok()],
  [/^gh api repos\/o\/r\/commits\/(\w+)\/check-runs\?per_page=100 --paginate$/, (h, m) => ok(h.checkRuns ? h.checkRuns(m[1]) : fixture('land', 'check-runs-green.json'))],
  [/^gh api repos\/o\/r\/commits\/\w+\/status\?per_page=100 --paginate$/, () => ok(fixture('land', 'commit-status-green.json'))],
  [/^gh api repos\/o\/r\/branches\/main\/protection\/required_status_checks$/, () => ok(fixture('land', 'required-checks.json'))],
  [/^node \S+pr-review\.mjs threads --pr (\d+)/, (h, m) => ({ code: h.unresolved?.(m[1]) ? 8 : 0, stdout: '', stderr: '' })],
  [/^node \S+pr-review\.mjs inflight --pr (\d+)/, (h, m) => (h.inflight?.(m[1]) ? { code: 9, stdout: '', stderr: 'review attempt(s) still in flight (beat #1 lens_running)' } : ok())],
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
  if (verb === 'admit') return { code: h.herdrAdmit?.[id]?.length ? h.herdrAdmit[id].shift() : 0, stdout: '', stderr: 'below the free-memory floor' };
  if (verb === 'create') return ok(JSON.stringify({ paneId: `pane-${id}`, path: `${h.repo}-wt-demo-${id.toLowerCase()}`, branch: `conduct/demo/${id.toLowerCase()}` }));
  if (verb === 'start') return ok(JSON.stringify({ startedAt: h.deps.timestamp() }));
  if (verb === 'prompt') {
    h.spawns[id] = (h.spawns[id] ?? 0) + 1;
    writeReport(h, id, h.spawns[id] > 1);
    return ok();
  }
  if (verb === 'wait') {
    const code = h.herdrWait?.[id]?.length ? h.herdrWait[id].shift() : 0;
    return { code, stdout: code === 3 ? JSON.stringify({ dialog: 'Do you trust the files in this folder?' }) : '', stderr: '' };
  }
  return ok();
}

function shellResult(h, action) {
  const id = action.wpId;
  const { command } = action;
  // The quiet-host probe reads this host's CPU: a test scripts its answers.
  if (action.step === 'gate-cmd' && action.part === 'quiet') return h.quiet?.length ? h.quiet.shift() : ok(JSON.stringify({ quiet: true, busy: [5, 5, 5], maxBusy: 30 }));
  if (command[0] === 'node' && command[1].endsWith('conduct.mjs')) return conductVerb(h, action);
  if (command[0] === 'node' && command[1].endsWith('lane.mjs')) return herdrVerb(h, action);
  // github-ask post: the touch's comment on the run's asks issue.
  if (command[0] === 'node' && command[1].endsWith('github-ask.mjs')) {
    const { askReceiptId } = JSON.parse(readFileSync(command.at(-1), 'utf8'));
    return ok(JSON.stringify({ status: 'posted', existing: false, askReceiptId, target: 'o/r#9', askCommentUrl: `https://github.com/o/r/issues/9#issuecomment-${900 + action.touch.n}`, askCommentId: 900 + action.touch.n }));
  }
  switch (action.part ? `${action.step}/${action.part}` : action.step) {
    case 'base': return ok(`${BASE}\n`);
    case 'pr-lookup': return ok(JSON.stringify([{ number: prNumber(id), headRefOid: h.head(id), state: 'OPEN' }]));
    case 'review/diff': return ok(h.diff?.[id] ?? 'src/a.mjs\n');
    case 'review/managed': return ok(JSON.stringify({ mode: 'standalone' }));
    case 'review/delta-count': return ok(JSON.stringify({ outcome: 'ok', review_id: action.land.reviewId, head: action.land.head, major_findings: h.deltaAfterDup?.[id]?.shift() ?? 2 }));
    case 'post/post': {
      const count = h.findings[id]?.length ? h.findings[id].shift() : 0;
      const receipt = action.land.scope === 'delta' ? `posted-review-id 7002\ndelta-major ${h.deltaMajor?.[id]?.shift() ?? 0} head=${action.land.head}\n` : '';
      return ok(count === null ? `posted\n${receipt}` : `findings ${count}\n${receipt}`);
    }
    case 'review/amend-diff': return ok(h.amendDiff?.[id] ?? 'docs/notes.md\n');
    case 'thread-ids/lookup': return ok(fixture('land', 'review-threads-145.json'));
    case 'resolve/resolve':
      h.resolved += 1;
      return ok();
    case 'reply/record': return h.recordPosts?.length ? h.recordPosts.shift() : ok(JSON.stringify({ html_url: 'https://github.com/o/r/pull/102#pullrequestreview-9003' }));
    case 'rebase/pre-head': return ok(`${h.head(id)}\n`);
    case 'rebase/post-heads': return ok(`${h.bump(id)}\n${'e'.repeat(40)}\n`);
    case 'merge/merge-commit': return ok(JSON.stringify({ mergeCommit: { oid: mergeSha(id) } }));
    case 'gate-cmd/gate-cmd': {
      const out = h.gateCmdOut?.[id]?.length ? h.gateCmdOut[id].shift() : null;
      return { code: h.gateCmdCode?.[id]?.length ? h.gateCmdCode[id].shift() : 0, stdout: out?.stdout ?? '', stderr: out?.stderr ?? 'gate output' };
    }
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
    case 'spine_receipt': return { ...structuredClone(RECEIPT), questId: action.args.questId, outcome: action.args.outcome };
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
  // A session ask: no operator in these runs unless a test answers it, so the touch goes to GitHub.
  if (action.kind === 'touch' && action.part === 'ask') return { unattended: true };
  // A test of why a WP blocks lets its build end: the recover touch is answered (b).
  if (h.declineRecover && action.step === 'touch' && action.part === 'announce') {
    const recover = h.state.touches.findLast((touch) => touch.build === 'recover' && touch.status !== 'answered');
    if (recover) answerCore(h, recover.n, 'b');
    return {};
  }
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
  while (!h.state.pending) {
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

// Quest e830d835: a mid-flight re-plan inside the pre-approval.
const REPLAN_WHY = 'WP-02 found the parser already handles the case WP-03 was to add';
test('replan (e830d835): two-way changes inside the scope proceed on the pre-approval, receipted on the anchor; a bad plan or the wrong phase is refused', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1], behindWp02('WP-03')], lanes: 1 });
  const refused = (plan, code, pattern) => assert.throws(() => build.replan(h.state, plan, h.deps), (error) => error.code === code && pattern.test(error.message));
  // Slim review on #250: an emitted action would run before the re-plan; re-plan only at a wait.
  await drive(h, { until: (a) => a.step === 'brief' && a.wpId === 'WP-02' });
  refused({ why: REPLAN_WHY, delta: [{ change: 'x', door: 'two-way', inScope: true }] }, 5, /is pending; perform it, then file the re-plan with its record \(record --replan\), or re-plan at a wait/);
  await drive(h, { until: (a) => a.kind === 'wait' });
  assert.equal(h.wp('WP-03').state, 'pending');
  refused({ why: ' ', delta: [] }, 2, /needs "why"/);
  refused({ why: REPLAN_WHY, delta: [] }, 2, /non-empty "delta"/);
  refused({ why: REPLAN_WHY, delta: [{ change: 'x', door: 'maybe', inScope: true }] }, 2, /two-way or one-way/);
  refused({ why: REPLAN_WHY, delta: [{ change: 'x', door: 'two-way' }] }, 2, /inScope must be true or false/);
  const out = build.replan(h.state, { why: REPLAN_WHY, delta: [{ change: 'fold WP-03 into a test on WP-02', door: 'two-way', inScope: true }] }, h.deps);
  assert.deepEqual([out.n, out.mode], [1, 'autonomous']);
  assert.equal(h.state.dispatchHalt, null, 'an autonomous re-plan halts nothing');
  assert.equal(h.state.touches.length, 0, 'and asks nothing');
  const record = JSON.parse(readFileSync(out.file, 'utf8'));
  assert.deepEqual([record.why, record.delta[0].door, record.needs], [REPLAN_WHY, 'two-way', 'nothing: inside the pre-approval']);
  assert.throws(() => build.replan(h.state, { why: 'again', delta: [{ change: 'x', door: 'two-way', inScope: true }] }, h.deps), (error) => error.code === 5 && /approved and not yet applied/.test(error.message));
  // Council r1: the approved re-plan is applied before any other build work, then receipted.
  const mark = h.trace.length;
  h.answer = (a) => {
    if (a.step !== 'replan' || a.part !== 'apply') return undefined;
    // A bad drop (a WP that is not pending) is refused, nothing written; then the real one.
    writeFileSync(a.outPath, JSON.stringify({ applied: true, what: 'x', drop: ['WP-01'] }));
    assert.throws(() => build.record(h.state, h.state.pending, {}, h.deps), (error) => error.code === 2 && /WP-01 is merged; only a pending WP is dropped/.test(error.message));
    writeFileSync(a.outPath, JSON.stringify({ applied: true, what: 'dropped WP-03; WP-02 carries its regression test', drop: ['WP-03'] }));
    return {};
  };
  const apply = await drive(h, { until: (a) => a.step === 'replan' });
  assert.deepEqual([apply.kind, apply.part], ['author', 'apply']);
  assert.match(apply.instruction, /^Apply re-plan 1 before anything else runs: 1\. fold WP-03 into a test on WP-02 Make each change/);
  assert.deepEqual(h.trace.slice(mark).map((a) => a.step), ['replan'], 'the apply step is the first action after the pending wait');
  const receipt = await drive(h, { until: (a) => a.step === 'replan' && a.part === 'receipt' });
  assert.equal(h.wp('WP-03').state, 'dropped');
  assert.match(h.wp('WP-03').reason, /^dropped by re-plan 1: WP-02 found .* \(restore: reset-wp --wp WP-03 --to pending\)$/);
  assert.deepEqual([receipt.kind, receipt.tool, receipt.args.questId, receipt.args.outcome], ['agent-tool', 'spine_receipt', ANCHOR, 'completed']);
  assert.match(receipt.args.did, /re-planned inside its pre-approval \(re-plan 1\)\. Why: WP-02 found .* What changed: 1\. fold WP-03 into a test on WP-02 Every change is a two-way door inside the approved scope; it rests on .*\. Applied: dropped WP-03/);
  assert.equal(await drive(h), null);
  assert.equal(h.state.replans[0].receipt, 'filed');
  assert.deepEqual(h.events().filter((e) => e.step === 'replan').map((e) => e.event), ['replanned', 'replan-applied', 'replan-receipted']);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'dropped']);
  assert.ok(!of(h, 'WP-03').some((a) => a.step === 'brief'), 'the dropped WP never dispatched');
  await analyzeRun(h.runDir, h.deps);
  const analysis = readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  assert.match(analysis, /^  - re-plan 1, approved inside the pre-approval; rests on .*; why: WP-02 found .*; changes: fold WP-03 into a test on WP-02 \[two-way\]; applied: dropped WP-03; WP-02 carries its regression test; anchor receipt filed$/m);
  assert.match(analysis, /^- WP-03 \(name WP-03\): dropped: dropped by re-plan 1: /m, 'the analysis names the dropped WP');
  // Amendment 1 delta pass: a dropped WP is no future lane in the spend projection, and gives up its paths to a ratify.
  assert.deepEqual(h.events().filter((e) => e.event === 'spend-projection' && e.data.wpId === 'WP-02').map((e) => e.data.wpsLeft), [0]);
  const fold = structuredClone(h.state);
  fold.wps[1].state = 'dispatched';
  build.ratify(fold, { wpId: 'WP-02', paths: [...h.wp('WP-03').files], why: 'fold WP-03 into WP-02' }, h.deps);
  assert.ok(h.wp('WP-03').files.every((path) => fold.wps[1].files.includes(path)));
  // Amendment 1: a drop is two-way inside the run. reset-wp --to pending restores it, and the build dispatches it again.
  assert.equal(h.state.phase, 'release');
  const restored = build.resetWp(h.state, { wpId: 'WP-03', to: 'pending', why: 'the parser case came back' }, h.deps);
  assert.deepEqual([restored.from.state, restored.state, h.state.phase, h.wp('WP-03').droppedBy], ['dropped', 'pending', 'build', null]);
  h.answer = null;
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
  assert.ok(of(h, 'WP-03').some((a) => a.step === 'brief'), 'the restored WP was dispatched');
  assert.throws(() => build.resetWp(h.state, { wpId: 'WP-02', to: 'pending', why: 'x' }, h.deps), (error) => error.code === 5 && /WP-02 is merged; --to pending resets a WP that is dropped/.test(error.message));
  refused({ why: REPLAN_WHY, delta: [{ change: 'x', door: 'two-way', inScope: true }] }, 5, /a re-plan is made mid-build/);
});

test('replan (e830d835): a one-way or out-of-scope change halts dispatch on a touch carrying the delta-plan; the build waits for it; (b) keeps the plan and dispatch resumes', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1], behindWp02('WP-03')], lanes: 1 });
  await drive(h, { until: (a) => a.kind === 'wait' });
  const out = build.replan(h.state, { why: REPLAN_WHY, delta: [
    { change: 'drop WP-03', door: 'two-way', inScope: true },
    { change: 'migrate the saved state format', door: 'one-way', inScope: true },
    { change: 'add a CLI flag the goal never named', door: 'two-way', inScope: false },
  ] }, h.deps);
  assert.deepEqual([out.mode, out.touch], ['asked', 1]);
  const [touch] = h.state.touches;
  assert.equal(touch.build, 'replan');
  assert.deepEqual(touch.options.map((o) => o.key), ['a', 'b', 'c']);
  assert.match(touch.question, /The delta-plan: 1\. drop WP-03 \(two-way\) 2\. migrate the saved state format \(one-way\) 3\. add a CLI flag the goal never named \(two-way, outside the approved scope\)/);
  assert.match(touch.question, /change 2 is a one-way door; change 3 is outside the approved scope/);
  assert.match(h.state.dispatchHalt.reason, /re-plan 1 waits on the operator \(touch 1\)/);
  assert.throws(() => build.replan(h.state, { why: 'again', delta: [{ change: 'x', door: 'two-way', inScope: true }] }, h.deps), (error) => error.code === 5);
  // The build does not end, and WP-03 is not dispatched, while the touch is open.
  const stop = await drive(h, { until: (a) => a.step === 'touch' && a.part === 'announce' });
  assert.match(stop.instruction, /touches[\\/]1\.md/);
  // Past the announce, the build only yields on the open touch: it never ends and never dispatches WP-03.
  await assert.rejects(drive(h, { max: 200 }), /drive did not settle/);
  assert.equal(h.wp('WP-03').state, 'pending');
  assert.equal(h.wp('WP-02').state, 'merged', 'the live lane finished under the halt');
  h.state.pending = null;
  answerCore(h, 1, 'b');
  assert.equal(await drive(h), null);
  assert.deepEqual([h.state.replans[0].mode, h.state.replans[0].answer.key, h.state.dispatchHalt, h.state.build.halts.length], ['declined', 'b', null, 0]);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged'], 'the original plan ran');
  assert.ok(!h.trace.some((a) => a.step === 'replan' && a.part === 'apply'), 'a declined re-plan is never applied');
});

test('replan (e830d835, council r1): (c) needs text; (a) and (c) are applied first; a plan too long for one question is refused before anything is written; build touches never become the authority', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1], TWO[2]], lanes: 1 });
  await drive(h, { until: (a) => a.kind === 'wait' });
  const huge = { why: 'x'.repeat(1900), delta: [{ change: 'migrate the saved state format', door: 'one-way', inScope: true }] };
  assert.throws(() => build.replan(h.state, huge, h.deps), (error) => error.code === 2 && /over spine_receipt's 2000-char cap/.test(error.message));
  assert.deepEqual([h.state.replans ?? [], h.state.touches.length, existsSync(join(h.runDir, 'rulings', 'replan-1.json'))], [[], 0, false], 'nothing written');
  build.replan(h.state, { why: REPLAN_WHY, delta: [{ change: 'migrate the saved state format', door: 'one-way', inScope: true }] }, h.deps);
  await drive(h, { until: (a) => a.step === 'touch' && a.part === 'announce' });
  h.state.pending = null;
  answerCore(h, 1, 'c', '   ');
  await step(h);
  const touch = h.state.touches[0];
  assert.deepEqual([touch.status, touch.refusal, h.state.replans[0].mode], ['open', '(c) needs your changes as text', 'asked'], 'an empty (c) is refused and the halt stays');
  assert.ok(h.state.dispatchHalt);
  h.state.pending = null;
  answerCore(h, 1, 'c', 'keep the old format readable for one release');
  h.answer = (a) => {
    if (a.step !== 'replan' || a.part !== 'apply') return undefined;
    writeFileSync(a.outPath, JSON.stringify({ applied: false, why: 'the migration is a separate run' }));
    return {};
  };
  const apply = await step(h);
  assert.deepEqual([apply.step, apply.part], ['replan', 'apply']);
  assert.match(apply.instruction, /The operator's text, verbatim, amends it: keep the old format readable for one release/);
  assert.equal(h.state.dispatchHalt, null);
  assert.equal(await drive(h), null);
  assert.deepEqual([h.state.replans[0].mode, h.state.replans[0].applied.applied, h.state.replans[0].applied.text], ['operator', false, 'the migration is a separate run']);
  // A later answered build touch (budget, a re-plan) is never the run's authority: touch 1 is.
  const state = { ...h.state, authority: { record: null }, adapters: { spine: { on: false } }, touches: [
    { n: 1, kind: 'preapproval', status: 'answered', wpId: null, answer: { answeredAt: 't1', by: 'operator:tty' } },
    { n: 2, kind: 'blocked', build: 'budget', status: 'answered', wpId: null, answer: { answeredAt: 't2', by: 'operator:tty' } },
    { n: 3, kind: 'showcase', status: 'answered', wpId: null, answer: { answeredAt: 't3', by: 'operator:tty' } },
  ] };
  assert.equal(preapprovedRef(state), `core:${h.runDir}/touches/1.json`);
});

test('replan (e830d835): the verb reads the plan file under the run lock; an unreadable plan is exit 2 and writes nothing', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1], TWO[2]], lanes: 1 });
  await drive(h, { until: (a) => a.kind === 'wait' });
  const bad = join(h.dir, 'bad-plan.json');
  writeFileSync(bad, '{ not json');
  const refused = await runConduct(['replan', '--run', h.runDir, '--plan', bad], h.overrides());
  assert.equal(refused.code, 2);
  assert.match(JSON.parse(refused.stdout).error, /is not a readable JSON file/);
  assert.equal(loadState(h.runDir, h.deps).replans, undefined, 'nothing written');
  const plan = join(h.dir, 'plan.json');
  writeFileSync(plan, JSON.stringify({ why: REPLAN_WHY, delta: [{ change: 'fold WP-03 into a test on WP-02', door: 'two-way', inScope: true }] }));
  const done = await runConduct(['replan', '--run', h.runDir, '--plan', plan], h.overrides());
  assert.equal(done.code, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.deepEqual([out.ok, out.n, out.mode], [true, 1, 'autonomous']);
  assert.match(out.then, /ratify, reset-wp, a ruling/);
  assert.equal(loadState(h.runDir, h.deps).replans[0].receipt, null, 'core path: no anchor receipt owed');
});

// Quest 4e7311a7: WP-02's final record emits WP-03's dispatch at once, so a
// re-plan filed after that record finds a non-wait action pending and is
// refused. `record --replan <file>` files the re-plan inside the record's
// transaction, before anything is emitted.
const CHAIN = [TWO[0], TWO[1], { id: 'WP-03', files: ['lib/land.mjs'], dependsOn: ['WP-02'] }];
const DROP_PLAN = { why: REPLAN_WHY, delta: [{ change: 'drop WP-03; WP-02 already covers it', door: 'two-way', inScope: true }] };
// WP-02's final action is deleting its remote branch.
const isFinalOfWp02 = (a) => a.wpId === 'WP-02' && a.step === 'stop' && a.part === 'branch-remote';
const recordArgs = (h, action, result) => ['record', '--run', h.runDir, '--action', action.id, '--result', JSON.stringify(result)];

test('replan (4e7311a7): without --replan, WP-02\'s final record dispatches WP-03 and the re-plan is refused (the defect, paired control)', async (t) => {
  const h = harness(t, { wps: CHAIN, lanes: 1 });
  h.disk = true;
  const plan = join(h.dir, 'plan.json');
  writeFileSync(plan, JSON.stringify(DROP_PLAN));
  const final = await drive(h, { until: isFinalOfWp02 });
  const out = await runConduct(recordArgs(h, final, await perform(h, final)), h.overrides());
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const emitted = JSON.parse(out.stdout).action;
  assert.deepEqual([emitted.wpId, emitted.step, emitted.part], ['WP-03', 'create', 'fetch']);
  assert.equal(h.wp('WP-03').state, 'dispatched');
  const late = await runConduct(['replan', '--run', h.runDir, '--plan', plan], h.overrides());
  assert.equal(late.code, 5);
  assert.match(JSON.parse(late.stdout).error, /is pending; perform it, then file the re-plan with its record/);
  // A replay with --replan files nothing: this record filed none.
  const replay = await runConduct([...recordArgs(h, final, {}), '--replan', plan], h.overrides());
  assert.equal(replay.code, 5);
  assert.match(JSON.parse(replay.stdout).error, /is already recorded and filed no re-plan; a replay files none/);
  assert.equal(loadState(h.runDir, h.deps).replans, undefined);
});

test('replan (4e7311a7): a re-plan filed with the record of WP-02\'s final action drops WP-03 before it dispatches', async (t) => {
  const h = harness(t, { wps: CHAIN, lanes: 1 });
  h.disk = true;
  const plan = join(h.dir, 'plan.json');
  writeFileSync(plan, JSON.stringify(DROP_PLAN));
  const final = await drive(h, { until: isFinalOfWp02 });
  assert.ok(final, 'reached WP-02\'s final action');
  const result = await perform(h, final);
  const out = await runConduct([...recordArgs(h, final, result), '--replan', plan], h.overrides());
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const body = JSON.parse(out.stdout);
  assert.deepEqual([body.action.step, body.action.part], ['replan', 'apply'], 'the record emits the re-plan\'s apply step, not WP-03\'s dispatch');
  assert.deepEqual([body.replan.n, body.replan.mode], [1, 'autonomous']);
  assert.equal(h.wp('WP-03').state, 'pending', 'WP-03 has not dispatched');
  // A lost response is retried: the replay reports the same re-plan and the same pending action, and files nothing new.
  const replay = await runConduct([...recordArgs(h, final, result), '--replan', plan], h.overrides());
  assert.equal(replay.code, 0, replay.stdout);
  const again = JSON.parse(replay.stdout);
  assert.deepEqual([again.noop, again.action.id, again.replan.n], [true, body.action.id, 1]);
  assert.equal(loadState(h.runDir, h.deps).replans.length, 1);
  assert.deepEqual(h.events().filter((e) => e.event === 'replanned').map((e) => e.source), ['record'], 'the event names the record route');
  h.answer = (a) => {
    if (a.step !== 'replan' || a.part !== 'apply') return undefined;
    writeFileSync(a.outPath, JSON.stringify({ applied: true, what: 'dropped WP-03', drop: ['WP-03'] }));
    return {};
  };
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-03').state, 'dropped');
  assert.ok(!h.trace.some((a) => a.wpId === 'WP-03'), 'no WP-03 action was ever emitted');
  // Outside build, --replan is refused before anything is recorded.
  const state = loadState(h.runDir, h.deps);
  assert.notEqual(state.phase, 'build');
  const outside = await runConduct(['record', '--run', h.runDir, '--action', state.pending?.id ?? 'none', '--result', '{}', '--replan', plan], h.overrides());
  assert.equal(outside.code, 5);
  assert.match(JSON.parse(outside.stdout).error, /a re-plan is made mid-build\. Nothing was recorded/);
  assert.equal(loadState(h.runDir, h.deps).lastRecorded, state.lastRecorded);
});

test('replan (4e7311a7): record --replan refuses a bad plan before recording, and a state-dependent refusal after the record emits nothing', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1], TWO[2]], lanes: 1 });
  h.disk = true;
  const wait = await drive(h, { until: (a) => a.kind === 'wait' });
  const bad = join(h.dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ why: REPLAN_WHY, delta: [] }));
  const before = readFileSync(join(h.runDir, 'state.json'), 'utf8');
  const refused = await runConduct(['record', '--run', h.runDir, '--action', wait.id, '--result', '{}', '--replan', bad], h.overrides());
  assert.equal(refused.code, 2);
  assert.match(JSON.parse(refused.stdout).error, /non-empty "delta"/);
  assert.equal(readFileSync(join(h.runDir, 'state.json'), 'utf8'), before, 'nothing recorded');
  // A plan the state refuses after the record (a re-plan already waits on the operator): the record stands, nothing is emitted.
  const wider = join(h.dir, 'wider.json');
  writeFileSync(wider, JSON.stringify({ why: REPLAN_WHY, delta: [{ change: 'migrate the state format', door: 'one-way', inScope: true }] }));
  const asked = await runConduct(['replan', '--run', h.runDir, '--plan', wider], h.overrides());
  assert.equal(asked.code, 0, asked.stdout);
  const again = join(h.dir, 'again.json');
  writeFileSync(again, JSON.stringify({ why: 'again', delta: [{ change: 'x', door: 'two-way', inScope: true }] }));
  const late = await runConduct(['record', '--run', h.runDir, '--action', wait.id, '--result', '{}', '--replan', again], h.overrides());
  assert.equal(late.code, 5);
  const lateOut = JSON.parse(late.stdout);
  assert.match(lateOut.error, /recorded .*; the re-plan was refused: .*already waits on the operator.*Nothing was emitted, so no action is pending/);
  assert.equal(lateOut.recorded, wait.id);
  const state = loadState(h.runDir, h.deps);
  assert.deepEqual([state.lastRecorded, state.pending], [wait.id, null], 'the record landed and nothing was emitted');
  assert.equal(state.replans.length, 1);
});

test('replan (4e7311a7, challenge on 31e1416): --replan on a touch\'s step is refused before anything is recorded', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1], TWO[2]], lanes: 1 });
  h.disk = true;
  await drive(h, { until: (a) => a.kind === 'wait' });
  const wider = join(h.dir, 'wider.json');
  writeFileSync(wider, JSON.stringify({ why: REPLAN_WHY, delta: [{ change: 'migrate the state format', door: 'one-way', inScope: true }] }));
  assert.equal((await runConduct(['replan', '--run', h.runDir, '--plan', wider], h.overrides())).code, 0);
  const touchStep = await drive(h, { until: (a) => a.kind !== 'wait' && (a.kind === 'touch' || Boolean(a.touch)) });
  assert.ok(touchStep, 'the re-plan touch emits a step');
  const plan = join(h.dir, 'plan.json');
  writeFileSync(plan, JSON.stringify(DROP_PLAN));
  const before = loadState(h.runDir, h.deps).lastRecorded;
  const onTouch = await runConduct(['record', '--run', h.runDir, '--action', touchStep.id, '--result', '{}', '--replan', plan], h.overrides());
  assert.equal(onTouch.code, 5, onTouch.stdout);
  assert.match(JSON.parse(onTouch.stdout).error, /is a touch's step, not a WP's result\. Nothing was recorded/);
  const state = loadState(h.runDir, h.deps);
  assert.deepEqual([state.pending.id, state.lastRecorded], [touchStep.id, before], 'nothing recorded');
});

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

test('waits are wall-clock deadlines: WP-03\'s 60 s ci-wait elapses while WP-02 polls its herdr lane for minutes, so WP-03\'s gate runs before WP-02\'s poll loop ends', async (t) => {
  const h = harness(t, { herdr: true });
  const polls = 30;
  h.herdrWait = { 'WP-02': [...Array(polls).fill(4), 0], 'WP-03': [0] };
  // `lane.mjs wait --timeout 60000` blocks for its timeout before exit 4.
  h.onPerform = (a) => { if (a.wpId === 'WP-02' && a.kind === 'shell' && a.step === 'wait') h.tick(60000); };
  // A queued wait is never emitted: note where WP-03's ci-wait first heads its queue.
  let ciWait = -1;
  h.onEmit = () => { if (ciWait < 0 && h.wp('WP-03').queue?.[0]?.part === 'ci-wait') ciWait = h.trace.length - 1; };
  assert.equal(await drive(h, { max: 1200 }), null);
  const gate = indexWhere(h, (a) => a.wpId === 'WP-03' && a.step === 'gate');
  const lastPoll = h.trace.findLastIndex((a) => a.wpId === 'WP-02' && a.kind === 'shell' && a.step === 'wait');
  assert.equal(of(h, 'WP-02').filter((a) => a.kind === 'shell' && a.step === 'wait').length, polls + 1);
  assert.ok(ciWait >= 0 && ciWait < gate, 'WP-03 queued its ci-wait before its gate');
  assert.ok(gate < lastPoll, `WP-03's gate (trace ${gate}) runs before WP-02's last poll (trace ${lastPoll})`);
  assert.ok(!h.trace.slice(ciWait, gate).some((a) => a.yield), 'no yield was needed to age the ci-wait');
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
});

test('waits are wall-clock deadlines: a wait queued while `next` chooses (a rebase waiting on the other WP\'s merge lock) is stamped before the action emitted with it runs', async (t) => {
  const h = harness(t, { herdr: true });
  h.herdrWait = { 'WP-02': [4, 4, 0], 'WP-03': [4, 0] };
  const unstamped = [];
  h.onEmit = (a) => {
    for (const wp of h.state.wps) {
      const head = wp.queue?.[0];
      if (head?.kind === 'wait' && !head.dueAt) unstamped.push(`${wp.id} ${head.step}/${head.part ?? ''} at ${a.id}`);
    }
  };
  assert.equal(await drive(h), null);
  assert.ok(h.trace.some((a) => a.step === 'gate'), 'the run reached its gates');
  assert.deepEqual(unstamped, []);
});

const stalledEvents = (h) => h.events().filter((e) => e.event === 'stalled');

test('a progressing 35-minute review avoids a stall; a reviewer with no progress still alarms after its deadline', async (t) => {
  const h = harness(t, { herdr: true, notify: true, ledger: true, env: { WORKIT_NOTIFY_CMD: 'notify-me' }, wps: [TWO[0], TWO[1]] });
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'review' && a.part === 'lens' });
  // Watch starts on next, before an action is emitted. Another WP's next
  // observes the pending review without inventing a completed result.
  const pending = h.state.pending.id;
  const next = async () => {
    saveState(h.state, h.deps);
    const out = await runConduct(['next', '--run', h.runDir], h.overrides());
    h.state = loadState(h.runDir, h.deps);
    assert.equal(JSON.parse(out.stdout).action.id, pending);
  };
  await next();
  h.tick(35 * 60000);
  await next();
  assert.deepEqual(stalledEvents(h), []);
  h.tick(41 * 60000);
  await next();
  saveState(h.state, h.deps);
  assert.equal(stalledEvents(h).length, 1);
  assert.match(stalledEvents(h)[0].data.why, /waiting on review\/lens/);
  const original = h.state.pending;
  assert.equal(h.wp('WP-02').queue[0].step, 'review');
  assert.deepEqual(h.wp('WP-02').queue.slice(1, 3).map((a) => a.part), ['notify', 'ledger']);
  await next();
  assert.equal(h.wp('WP-02').queue.filter((a) => a.step === 'alarm').length, 2);
  await recordPending(h, await perform(h, original));
  assert.equal(h.wp('WP-02').queue.filter((a) => a.step === 'alarm').length, 2);
  assert.equal(h.wp('WP-02').queue.some((a) => JSON.stringify(a.command) === JSON.stringify(original.command)), false, 'the completed review is removed exactly once');
});

test('brief preflight refuses a crate-relative typo before prompting and accepts the corrected author action', async (t) => {
  const h = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  const action = await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'brief' });
  await perform(h, action);
  writeFileSync(action.outPath, `${readFileSync(action.outPath, 'utf8')}\nInspect \`src/nonexistent.rs\`.\n`);
  h.wp('WP-02').files = [...h.wp('WP-02').files, 'src/nonexistent.rs'];
  assert.throws(() => build.record(h.state, action, {}, h.deps), /brief preflight/);
  assert.equal(h.wp('WP-02').state, 'dispatched');
  assert.equal(of(h, 'WP-02').some((a) => a.step === 'prompt'), false);
  writeFileSync(action.outPath, readFileSync(action.outPath, 'utf8').replace('Inspect `src/nonexistent.rs`.', 'Inspect the declared WP files.'));
  await build.record(h.state, action, {}, h.deps);
});

// Quest 977d3efb, writer (d): the bootstrap WP's brief carries the verb, its
// absent manifest paths pass the preflight as Create paths, and a brief
// written without the section is refused.
test('the greenfield bootstrap WP\'s brief appends the bootstrap section; a brief without it is refused', async (t) => {
  const h = harness(t, { herdr: true, wps: [{ id: 'WP-01', files: ['lib/state.mjs'], wave: 1 }] });
  h.state.intent.greenfield = { on: true, why: ['no CI workflow can gate a PR'], commits: 1 };
  Object.assign(h.state.wps[0], {
    files: ['lib/state.mjs', '.github/workflows/ci.yml'], creates: ['.github/workflows/ci.yml'],
    bootstrap: { files: ['.github/workflows/ci.yml'], failing: ['ci'] },
  });
  const action = await drive(h, { until: (a) => a.wpId === 'WP-01' && a.step === 'brief' });
  assert.match(action.append, /^## Greenfield bootstrap$/m);
  assert.match(action.instruction, /Then append the append text verbatim/);
  await perform(h, action);
  assert.match(readFileSync(action.outPath, 'utf8'), /bootstrap --repo \S+ --write --offline/);
  writeFileSync(action.outPath, readFileSync(action.outPath, 'utf8').replace(action.append, ''));
  assert.throws(() => build.record(h.state, action, {}, h.deps), /does not carry the appended section/);
  // Council review 1: the heading alone is not the section.
  await perform(h, action);
  const run = action.append.split('\n').find((line) => line.startsWith('Run `node'));
  writeFileSync(action.outPath, readFileSync(action.outPath, 'utf8').replace(run, ''));
  assert.throws(() => build.record(h.state, action, {}, h.deps), /does not carry the appended section/);
  // Review #248: the section quoted inside a code fence is not the brief's own instruction.
  await perform(h, action);
  const plainBrief = readFileSync(action.outPath, 'utf8').replace(action.append, '');
  writeFileSync(action.outPath, `${plainBrief}\n## Artifacts\n\n\`\`\`markdown\n${action.append}\n\`\`\`\n`);
  assert.throws(() => build.record(h.state, action, {}, h.deps), /outside any code fence/);
  // CRLF line endings are forgiven.
  await perform(h, action);
  writeFileSync(action.outPath, readFileSync(action.outPath, 'utf8').replace(/\n/g, '\r\n'));
  await build.record(h.state, action, {}, h.deps);
  // A WP without the flag gets no append.
  const plain = harness(t, { herdr: true, wps: [{ id: 'WP-01', files: ['lib/state.mjs'], wave: 1 }] });
  assert.equal((await drive(plain, { until: (a) => a.step === 'brief' })).append, undefined);
});

test('a Rust seat starting after capacity wait gets its own deadline, while heartbeats cannot hide a dead seat', async (t) => {
  const h = harness(t, { herdr: true, council: true, wps: [TWO[0], { ...TWO[1], tier: 'T2' }] });
  const action = await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'council' && a.part === 'review' });
  mkdirSync(action.args.output_dir, { recursive: true });
  const path = join(action.args.output_dir, 'review-progress.json');
  const publish = (status, startedAt = null) => writeFileSync(path, JSON.stringify({ updatedAt: h.deps.timestamp(), seats: { sol: { status, startedAt } } }));
  const poll = async () => {
    saveState(h.state, h.deps);
    const out = await runConduct(['next', '--run', h.runDir], h.overrides());
    h.state = loadState(h.runDir, h.deps);
    assert.equal(JSON.parse(out.stdout).action.id, action.id);
  };
  publish('queued');
  await poll();
  h.tick(50 * 60000);
  const started = h.deps.timestamp();
  publish('running', started);
  await poll();
  h.tick(26 * 60000);
  publish('running', started);
  await poll();
  assert.equal(stalledEvents(h).length, 0);
  h.tick(50 * 60000);
  publish('running', started);
  await poll();
  assert.equal(stalledEvents(h).length, 1);
});

test('stall alarm: a lane stop failing three times in a row raises one `stalled` event and one notify call (kind stalled); the run goes on and merges', async (t) => {
  const h = harness(t, { herdr: true, notify: true, env: { WORKIT_NOTIFY_CMD: 'notify-me' }, wps: [TWO[0], TWO[1]] });
  // Three pending gates first: exit 6 with a JSON verdict is an answer, not a failure.
  let pending = 3;
  h.inflight = () => pending-- > 0;
  let fails = 5;
  h.answer = (a) => {
    if (a.wpId !== 'WP-02' || a.step !== 'stop' || a.kind !== 'shell' || fails <= 0) return undefined;
    fails -= 1;
    return { code: 1, stdout: JSON.stringify({ error: 'stop pane prompt check failed: pane w1:p1 never returned to a shell prompt' }), stderr: '' };
  };
  assert.equal(await drive(h), null);
  const stalled = stalledEvents(h);
  assert.equal(stalled.length, 1, JSON.stringify(stalled));
  assert.equal(stalled[0].data.wpId, 'WP-02');
  assert.match(stalled[0].data.why, /^stop\/stop failed 3 times in a row \(exit 1/);
  const calls = h.trace.filter((a) => a.step === 'alarm');
  assert.deepEqual(calls.map((a) => [a.kind, a.part, a.env?.WORKIT_NOTIFY_KIND]), [['shell', 'notify', 'stalled']]);
  assert.match(calls[0].env.WORKIT_NOTIFY_TEXT, /WP-02 has stalled: stop\/stop failed 3 times/);
  assert.ok(indexWhere(h, (a) => a.step === 'alarm') > h.trace.findIndex((a) => a.wpId === 'WP-02' && a.step === 'stop'), 'raised after the failures');
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(h.wp('WP-02').cleanup, null, 'the stop finally confirmed');
});

// WP-02 reaches its rebase, then waits on a stale merge lock (held by a WP
// that already merged), a minute per yield, until it has stalled; the lock is
// then cleared and the run driven to its end.
async function staleLockStall(h) {
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'rebase' });
  h.state.mergeLock = { wpId: 'WP-01' };
  h.onPerform = (a) => { if (a.yield) h.tick(a.waitMs); };
  await drive(h, { until: () => stalledEvents(h).length > 0 });
  h.state.mergeLock = null;
  return drive(h);
}

test('stall alarm: the ledger note needs the ledger adapter: spine alone writes the event and no ledger_write; a failed ledger_write is an alarm-failed event and the run goes on', async (t) => {
  const spineOnly = harness(t, { herdr: true, spine: true, wps: [TWO[0], TWO[1]] });
  assert.equal(await staleLockStall(spineOnly), null);
  assert.equal(stalledEvents(spineOnly).length, 1);
  assert.ok(!spineOnly.trace.some((a) => a.tool === 'ledger_write'), 'spine_* tools only: no ledger_write');
  assert.equal(spineOnly.wp('WP-02').state, 'merged');

  const down = harness(t, { herdr: true, ledger: true, wps: [TWO[0], TWO[1]] });
  down.answer = (a) => (a.tool === 'ledger_write' ? { isError: true, content: [{ type: 'text', text: 'ledger unavailable' }] } : undefined);
  assert.equal(await staleLockStall(down), null);
  const failed = down.events().filter((e) => e.event === 'alarm-failed');
  assert.deepEqual(failed.map((e) => [e.data.wpId, e.data.part, e.data.error]), [['WP-02', 'ledger', 'ledger unavailable']]);
  assert.equal(down.wp('WP-02').state, 'merged');

  // Nothing came back (null, or an empty object): recorded as not delivered, and the run goes on.
  for (const nothing of [null, {}]) {
    const empty = harness(t, { herdr: true, ledger: true, wps: [TWO[0], TWO[1]] });
    empty.answer = (a) => (a.tool === 'ledger_write' ? nothing : undefined);
    assert.equal(await staleLockStall(empty), null);
    const lost = empty.events().filter((e) => e.event === 'alarm-failed');
    assert.deepEqual(lost.map((e) => [e.data.part, e.data.code, e.data.error]), [['ledger', null, 'no result']], JSON.stringify(nothing));
    assert.equal(empty.wp('WP-02').state, 'merged');
  }
});

test('stall alarm: ledger declared, a WP whose state and stage do not move for 30 minutes gets one ledger note; a lane at work for an hour gets none', async (t) => {
  const h = harness(t, { herdr: true, spine: true, ledger: true, env: { WORKIT_LEDGER_USER: 'operator' }, wps: [TWO[0], TWO[1]] });
  h.herdrWait = { 'WP-02': [4, 4, 4, 0] };
  const notes = [];
  h.answer = (a) => {
    if (a.tool !== 'ledger_write') return undefined;
    notes.push(a.args);
    return { id: 1 };
  };
  // A lane at work for an hour: its poll is queued, so it is left to the lane
  // deadline. The hour passes on the second poll, once the stage has settled.
  const polls = () => of(h, 'WP-02').filter((a) => a.kind === 'shell' && a.step === 'wait').length;
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.kind === 'shell' && a.step === 'wait' && polls() === 2 });
  h.tick(61 * 60000);
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'rebase' });
  assert.deepEqual(stalledEvents(h), [], 'no alarm for the lane at work');
  // A stale merge lock (held by a WP that already merged): WP-02's rebase
  // waits on it, a minute per yield, with no state or stage change.
  h.state.mergeLock = { wpId: 'WP-01' };
  h.onPerform = (a) => { if (a.yield) h.tick(a.waitMs); };
  const raised = await drive(h, { until: (a) => a.step === 'alarm' });
  assert.deepEqual([raised.tool, raised.wpId], ['ledger_write', 'WP-02']);
  h.state.mergeLock = null;
  assert.equal(await drive(h), null);
  const stalled = stalledEvents(h);
  assert.equal(stalled.length, 1, JSON.stringify(stalled));
  assert.match(stalled[0].data.why, /^no state or stage change for 3\d minutes \(gate at gate\)$/);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].event_type, notes[0].source, notes[0].user_id], ['note', 'cli', 'operator']);
  assert.match(notes[0].payload.content, /WP-02 has stalled: no state or stage change/);
  assert.equal(h.wp('WP-02').state, 'merged');
});

// WP-03 depends on WP-02, whose first gate is held: its post-cap tail touches
// CLAUDE.md, outside its Files, inside the line cap.
const RATIFY_WPS = [TWO[0], TWO[1], { id: 'WP-03', files: ['lib/land.mjs'], dependsOn: ['WP-02'] }];
function heldOnFiles(h) {
  let held = false;
  h.answer = (a) => {
    if (held || a.wpId !== 'WP-02' || a.step !== 'gate' || a.part !== 'gate') return undefined;
    held = true;
    const failure = 'post-cap tail c1..c2 out of bounds: 12 production lines; outside the WP\'s Files: CLAUDE.md';
    return { code: 5, stdout: JSON.stringify({ ok: false, pending: false, pendingOn: [], blocked: false, head: h.head('WP-02'), failures: [failure], causes: ['tail-outside-files'],
      unreviewedTail: null, needsFullReview: false, staleBase: false, outside: ['CLAUDE.md'] }), stderr: '' };
  };
}

test('ratify (c58b3a51): a WP held only on its Files does not end the build; ratifying the paths sends it back to the gate, its dependent follows, and every WP merges', async (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  heldOnFiles(h);
  const ruling = await drive(h, { until: (a) => a.step === 'ratify' });
  assert.ok(ruling, 'the build asks for a ratify ruling instead of ending');
  assert.deepEqual([ruling.wpId, ruling.paths], ['WP-02', ['CLAUDE.md']]);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-03').state, h.state.phase], ['held', 'deferred', 'build']);
  mkdirSync(dirname(ruling.outPath), { recursive: true });
  writeFileSync(ruling.outPath, JSON.stringify({ ratify: true, why: 'the amendment brief asked for the CLAUDE.md Commands line' }));
  await recordPending(h, {});
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-02').stage], ['gate', 'land']);
  assert.ok(h.wp('WP-02').files.includes('CLAUDE.md'));
  assert.deepEqual(h.events().filter((e) => e.event === 'ratified').map((e) => [e.data.wpId, e.data.paths]), [['WP-02', ['CLAUDE.md']]]);
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
});

test('door (fca05d92): with merge authority, a PR body declaring Door: one-way passes its gate and is held, its dependent deferred, no merge issued', async (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  h.mergeDanger = '## Merge danger\n\nDoor: one-way\nBlast radius: every consumer of the demo\n';
  assert.equal(await drive(h), null);
  assert.equal(h.state.authority.merge, true);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-03').state], ['held', 'deferred']);
  assert.equal(h.wp('WP-02').gate.door, 'one-way');
  assert.equal(h.trace.some((a) => a.wpId === 'WP-02' && a.step === 'merge'), false);
});

test('ratify (c58b3a51): a declined ruling keeps the WP held, its dependent deferred, and lets the build end', async (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  heldOnFiles(h);
  const ruling = await drive(h, { until: (a) => a.step === 'ratify' });
  mkdirSync(dirname(ruling.outPath), { recursive: true });
  writeFileSync(ruling.outPath, JSON.stringify({ ratify: false, why: 'CLAUDE.md belongs to the docs WP' }));
  await recordPending(h, {});
  assert.equal(await drive(h), null);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-03').state], ['held', 'deferred']);
  assert.ok(!h.wp('WP-02').files.includes('CLAUDE.md'));
  assert.equal(h.events().filter((e) => e.event === 'ratify-declined').length, 1);
});

// WP-03 depends on WP-02, whose first gate is held: its tail has a commit no
// fixed row of the latest review cites (RC-4 WP-04's 18dd500).
const UNCITED = 'c'.repeat(40);
function heldOnUncited(h) {
  let held = false;
  h.answer = (a) => {
    if (held || a.wpId !== 'WP-02' || a.step !== 'gate' || a.part !== 'gate') return undefined;
    held = true;
    const review = h.wp('WP-02').reviews.at(-1);
    review.verdicts = [...(review.verdicts ?? []), { comment: 'C1-1', verdict: 'fixed', evidence: 'red then green', commit: '1111111' }];
    const failure = `review does not cover head: tail d..e has commits that are not fixed rows of the anchoring review: ${UNCITED}`;
    return { code: 5, stdout: JSON.stringify({ ok: false, pending: false, pendingOn: [], blocked: false, head: h.head('WP-02'), failures: [failure], causes: ['tail-uncited'],
      unreviewedTail: null, needsFullReview: false, staleBase: false, uncited: [UNCITED] }), stderr: '' };
  };
}
const writeRuling = (action, value) => {
  mkdirSync(dirname(action.outPath), { recursive: true });
  writeFileSync(action.outPath, JSON.stringify(value));
};

test('cite (61f67554): an uncited tail commit holds the WP for a ruling instead of ending the build; citing it on its fixed row sends the WP back to the gate and every WP merges', async (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  heldOnUncited(h);
  const ruling = await drive(h, { until: (a) => a.step === 'cite' });
  assert.ok(ruling, 'the build asks for a cite ruling instead of ending');
  assert.deepEqual([ruling.wpId, ruling.shas], ['WP-02', [UNCITED]]);
  assert.match(ruling.instruction, /C1-1 \(1111111\)/);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-03').state, h.state.phase], ['held', 'deferred', 'build']);
  writeRuling(ruling, { cite: { [UNCITED.slice(0, 7)]: 'C1-1' }, why: 'the second commit is the fix\'s own key-press test' });
  await recordPending(h, {});
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-02').stage], ['gate', 'land']);
  assert.equal(h.wp('WP-02').reviews.at(-1).verdicts.find((row) => row.comment === 'C1-1').commit, `1111111,${UNCITED}`);
  assert.deepEqual(h.events().filter((e) => e.event === 'cited').map((e) => [e.data.wpId, e.data.shas]), [['WP-02', { [UNCITED]: 'C1-1' }]]);
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
});

test('cite (61f67554): a declined ruling keeps the WP held and lets the build end; a ruling that misses a held commit or names a row that is not fixed is refused (exit 2)', async (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  heldOnUncited(h);
  const ruling = await drive(h, { until: (a) => a.step === 'cite' });
  writeRuling(ruling, { cite: { [UNCITED]: 'C9-9' }, why: 'x' });
  await assert.rejects(recordPending(h, {}), { code: 2, message: /C9-9 is not a fixed row/ });
  writeRuling(ruling, { cite: { '2222222': 'C1-1' }, why: 'x' });
  await assert.rejects(recordPending(h, {}), { code: 2, message: /2222222 is not one of the held commits/ });
  writeRuling(ruling, { cite: {}, why: 'x' });
  await assert.rejects(recordPending(h, {}), { code: 2, message: /cite must be/ });
  writeRuling(ruling, { cite: false, why: 'the commit is unrelated work; it belongs in its own PR' });
  await recordPending(h, {});
  assert.equal(await drive(h), null);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-03').state], ['held', 'deferred']);
  assert.equal(h.events().filter((e) => e.event === 'cite-declined').length, 1);
});

test('ratify verb (c58b3a51): extends a live WP\'s Files with the ruling; refuses a path another unfinished WP owns (exit 5), a missing --why (exit 2) and a path outside the repo (exit 2)', async (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'wait' });
  h.state.pending = null;
  saveState(h.state, h.deps);
  const run = (...args) => runConduct(['ratify', '--run', h.runDir, ...args], h.overrides());
  const ok = await run('--wp', 'WP-02', '--paths', 'src/ui/SidePanel.svelte, docs/x.md', '--why', 'the lane\'s ask (a) needs the panel');
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(JSON.parse(ok.stdout).readmitted, false);
  const after = loadState(h.runDir, h.deps).wps.find((wp) => wp.id === 'WP-02');
  assert.deepEqual(after.files, ['lib/lanes.mjs', 'src/ui/SidePanel.svelte', 'docs/x.md']);
  assert.equal(after.ratified[0].why, 'the lane\'s ask (a) needs the panel');
  const owned = await run('--wp', 'WP-02', '--paths', 'lib/land.mjs', '--why', 'x');
  assert.equal(owned.code, 5);
  assert.match(JSON.parse(owned.stdout).error, /WP-03 \(pending\) owns a path/);
  assert.equal((await run('--wp', 'WP-02', '--paths', 'a.md')).code, 2);
  assert.equal((await run('--wp', 'WP-02', '--paths', '../outside.md', '--why', 'x')).code, 2);
});

test('ratify (c58b3a51): coverage follows the merge gate (a directory ends in /), and an unknown scope is never ratified or ratified into', (t) => {
  const h = harness(t, { wps: RATIFY_WPS });
  const held = h.wp('WP-02');
  Object.assign(held, { state: 'held', heldOutside: ['src/ui/Panel.svelte'], queue: [] });
  const bare = build.ratify(h.state, { wpId: 'WP-02', paths: ['src/ui'], why: 'the panel' }, h.deps);
  assert.equal(bare.readmitted, false, '`src/ui` is a file to the gate, so the tail is still outside');
  assert.equal(held.state, 'held');
  const dir = build.ratify(h.state, { wpId: 'WP-02', paths: ['src/ui/'], why: 'the panel directory' }, h.deps);
  assert.deepEqual([dir.readmitted, held.state, held.stage], [true, 'gate', 'land']);

  const unknown = harness(t, { wps: [TWO[0], { ...TWO[1], files: [] }, TWO[2]] });
  assert.throws(() => build.ratify(unknown.state, { wpId: 'WP-02', paths: ['docs/new.md'], why: 'x' }, unknown.deps), { code: 5, message: /no declared Files/ });
  assert.deepEqual(unknown.wp('WP-02').files, []);
  assert.throws(() => build.ratify(unknown.state, { wpId: 'WP-03', paths: ['docs/new.md'], why: 'x' }, unknown.deps), { code: 5, message: /WP-02 \(pending\) owns a path.*no declared Files/ });
});

// ---- reset-wp (61d817db) ----

test('reset-wp verb (61d817db): a WP blocked at its gate ends the build once its recover touch is declined; reset --to land is refused while another writer holds the lock, then writes the snapshot, moves the run back to build, logs one recovery row, and every WP merges', async (t) => {
  const h = harness(t, { config: JSON.stringify({ gateEnv: { DB: 7 } }), wps: RATIFY_WPS });
  h.declineRecover = true;
  assert.equal(await drive(h), null);
  assert.deepEqual([h.wp('WP-02').state, h.state.phase], ['blocked', 'release']);
  // 5a848b95: WP-02 blocks inside the final `next`, after that call's
  // deferrals ran. The build still ends with its dependent deferred, never
  // `pending`, so the showcase's unfinished list names it.
  assert.deepEqual([h.wp('WP-03').state, h.wp('WP-03').deferredBy], ['deferred', 'WP-02']);
  const ended = h.events().filter((e) => e.event === 'build-ended');
  assert.deepEqual(ended.at(-1).data.wps.find((wp) => wp.id === 'WP-03')?.state, 'deferred', 'the build-ended row records it deferred too');
  writeFileSync(join(h.repo, '.workit', 'conduct.json'), fixture('build', 'conduct.json'));
  const before = readFileSync(join(h.runDir, 'state.json'), 'utf8');
  const run = (...args) => runConduct(['reset-wp', '--run', h.runDir, ...args], h.overrides());

  // Held by another writer: refused, nothing written.
  writeFileSync(join(h.runDir, 'state.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', at: h.deps.timestamp(), token: 'x' }));
  const locked = await run('--wp', 'WP-02', '--to', 'land', '--why', 'gateEnv fixed');
  assert.equal(locked.code, 2);
  assert.match(JSON.parse(locked.stdout).error, /locked by pid 1 on elsewhere/);
  rmSync(join(h.runDir, 'state.lock'));
  assert.equal(readFileSync(join(h.runDir, 'state.json'), 'utf8'), before);
  assert.ok(!readdirSync(h.runDir).some((name) => name.startsWith('state.before-reset-')));

  const done = await run('--wp', 'WP-02', '--to', 'land', '--why', 'the repo config gateEnv is fixed');
  assert.equal(done.code, 0, done.stdout);
  const out = JSON.parse(done.stdout);
  assert.deepEqual([out.from, out.state, out.stage, out.phase.from, out.phase.to], [{ state: 'blocked', stage: null }, 'gate', 'land', 'release', 'build']);
  assert.equal(readFileSync(out.snapshot, 'utf8'), before, 'the snapshot is the state.json the reset read');
  assert.match(basename(out.snapshot), /^state\.before-reset-wp-02-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
  h.disk = true;
  const after = h.current();
  assert.deepEqual([after.phase, after.release.state, h.wp('WP-03').state, h.wp('WP-03').deferredBy ?? null], ['build', 'pending', 'pending', null]);
  const rows = h.events().filter((e) => e.event === 'wp-reset');
  assert.deepEqual(rows.map((e) => [e.step, e.seam, e.source, e.data.wpId, e.data.to, e.data.snapshot]), [['reset', 'recovery', 'manual', 'WP-02', 'land', out.snapshot]]);
  assert.match(h.wp('WP-02').reason, /^reset-wp --to land: the repo config gateEnv is fixed$/);

  assert.equal(await drive(h), null);
  assert.deepEqual(h.current().wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
  await analyzeRun(h.runDir, h.deps);
  const analysis = readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  assert.match(analysis, new RegExp(`^- recovery: by hand \\(${rows[0].actionId}\\)$`, 'm'));
});

// A run with one WP stopped in each shape the table names, for the refusals.
function resetFixture(t, opts = {}) {
  const h = harness(t, { wps: RATIFY_WPS, ...opts });
  const lane = (extra = {}) => ({ backend: 'herdr', worktree: join(h.dir, 'wt'), paneId: 'p1', briefPath: join(h.runDir, 'lane-wp-02.md'), startedAt: h.deps.timestamp(), exitedAt: h.deps.timestamp(), ...extra });
  writeFileSync(join(h.runDir, 'lane-wp-02.md'), 'Amendment 1: x\n');
  writeFileSync(join(h.runDir, 'lane-wp-02-report.md'), '## Outcome\n\nbuilt\n');
  Object.assign(h.wp('WP-02'), { state: 'blocked', stage: null, queue: [], lane: lane(), amendment: { n: 1, kind: 'check' }, pr: { number: 102 } });
  Object.assign(h.wp('WP-03'), { state: 'deferred', deferredBy: 'WP-02' });
  h.lane = lane;
  h.reset = (to, extra = {}) => build.resetWp(h.state, { wpId: 'WP-02', to, why: 'a ruling', ...extra }, h.deps);
  return h;
}

test('reset-wp --to delta: snapshots, reviews a report-only tail, then restarts the stopped lane for new findings', async (t) => {
  const h = resetFixture(t, { herdr: true, council: true });
  const wp = h.wp('WP-02');
  wp.tier = 'T2';
  h.synth = [{ findings: 2, seats: ['gpt-6.1-sol'] }];
  const reviewed = sha('a', 2);
  const head = sha('c', 2);
  wp.pr.head = head;
  wp.reviews = [{ round: 1, scope: 'full', head: reviewed, findings: 0 }];
  h.heads[wp.id] = head;
  h.rules.unshift(
    [/^git -C \S+ rev-parse --verify ([0-9a-f]+)\^\{commit\}$/, (h, m) => ok(`${m[1]}\n`)],
    [/^git -C \S+ rev-parse HEAD$/, () => ok(`${head}\n`)],
    [/^git -C \S+ status --porcelain$/, () => ok()],
  );
  h.state.mergeLock = { wpId: wp.id };
  wp.gate = { ok: false, head, failures: ['review does not cover head'], causes: ['review-uncovered'] };
  saveState(h.state, h.deps);
  const before = readFileSync(join(h.runDir, 'state.json'), 'utf8');
  const reset = await runConduct(['reset-wp', '--run', h.runDir, '--wp', wp.id, '--to', 'delta', '--baseline', reviewed, '--why', 'review the uncovered fixes'], h.overrides());
  assert.equal(reset.code, 0, reset.stdout);
  const result = JSON.parse(reset.stdout);
  assert.equal(readFileSync(result.snapshot, 'utf8'), before);
  h.disk = true;
  assert.deepEqual([h.wp(wp.id).state, h.wp(wp.id).stage, h.wp(wp.id).gate, h.current().mergeLock], ['pr', 'delta', null, null]);
  assert.deepEqual(result.undeferred, ['WP-03']);
  const diff = await drive(h, { until: (a) => a.part === 'amend-diff' });
  assert.equal(diff.command.at(-2), reviewed);
  const start = await drive(h, { until: (a) => ['start', 'rebase'].includes(a.step) });
  assert.equal(h.wp(wp.id).reviews.at(-1).scope, 'delta', 'an explicit recovery reviews even a report-only tail');
  assert.equal(start.step, 'start', 'new findings re-start the lane stopped during the original block');
  await recordPending(h, await perform(h, start));
  const prompt = await drive(h, { until: (a) => a.step === 'prompt' });
  assert.ok(prompt.command.includes('--amendment'));
  assert.equal(h.wp(wp.id).lane.exitedAt, null);
  assert.equal(h.events().filter((e) => e.event === 'wp-reset').length, 1);
});

test('a refused delta reset writes no snapshot and leaves run state and events untouched', (t) => {
  for (const [to, baseline, review, expected] of [
    ['delta', null, { scope: 'full', head: sha('a', 2) }, 2],
    ['land', sha('a', 2), { scope: 'full', head: sha('a', 2) }, 2],
    ['delta', sha('a', 2), { scope: 'delta', head: sha('a', 2) }, 5],
  ]) {
    const h = resetFixture(t);
    h.wp('WP-02').pr.head = sha('c', 2);
    h.wp('WP-02').reviews = [review];
    const before = JSON.stringify(h.state);
    const events = h.events();
    let snapshots = 0;
    assert.throws(() => build.resetWp(h.state, { wpId: 'WP-02', to, baseline, why: 'a ruling' }, h.deps, { beforeChange: () => { snapshots += 1; } }), { code: expected });
    assert.equal(snapshots, 0);
    assert.equal(JSON.stringify(h.state), before);
    assert.deepEqual(h.events(), events);
  }
});

test('a moved delta-recovery candidate blocks without reviewing and can be reset again', async (t) => {
  for (const pendingDiff of [false, true]) {
    const h = resetFixture(t);
    const wp = h.wp('WP-02');
    const reviewed = sha('a', 2);
    const previous = sha('b', 2);
    const head = sha('c', 2);
    Object.assign(wp, {
      state: 'pr', stage: 'delta', pr: { number: 102, head },
      reviews: [{ scope: 'full', head: reviewed, round: 1 }],
      deltaRecovery: { reviewedHead: reviewed, baseline: reviewed, head: previous, kind: 'ancestor' },
    });
    if (pendingDiff) {
      const action = { id: '99-review', wpId: wp.id, step: 'review', part: 'amend-diff', kind: 'shell', command: ['git', '-C', wp.lane.worktree, 'diff', '--name-only', reviewed, previous] };
      wp.queue = [action];
      h.state.pending = action;
      await recordPending(h, ok('lib/lanes.mjs\n'));
    } else await drive(h);
    assert.equal(wp.state, 'blocked');
    assert.match(wp.reason, /candidate moved/);
    assert.equal(wp.reviews.length, 1);
    h.rules.unshift(
      [/^git -C \S+ rev-parse --verify ([0-9a-f]+)\^\{commit\}$/, (h, m) => ok(`${m[1]}\n`)],
      [/^git -C \S+ rev-parse HEAD$/, () => ok(`${head}\n`)],
      [/^git -C \S+ status --porcelain$/, () => ok()],
    );
    assert.equal(h.reset('delta', { baseline: reviewed }).state, 'pr');
    assert.equal(wp.deltaRecovery.head, head);
  }
});

test('reset-wp (61d817db): the refused transitions, one row each', (t) => {
  const rows = [
    ['an unknown WP', (h) => build.resetWp(h.state, { wpId: 'WP-09', to: 'check', why: 'x' }, h.deps), 2, /no WP WP-09/],
    ['an unknown target', (h) => h.reset('start'), 2, /--to must be one of check, checked, prompt, wait, land/],
    ['no why', (h) => h.reset('check', { why: ' ' }), 2, /--why/],
    ...['pending', 'dispatched', 'amending', 'pr', 'review', 'gate', 'deferred', 'merged', 'refuted'].map((from) => [
      `a WP that is ${from}`, (h) => { h.wp('WP-02').state = from; return h.reset('check'); }, 5, new RegExp(`WP-02 is ${from}; --to check resets a WP that is blocked`)]),
    ...['check', 'checked', 'prompt', 'wait'].map((to) => [`held --to ${to}`, (h) => { h.wp('WP-02').state = 'held'; return h.reset(to); }, 5, /is held; --to \w+ resets a WP that is blocked$/]),
    ['a WP never dispatched', (h) => { h.wp('WP-02').lane = null; return h.reset('check'); }, 5, /no lane worktree/],
    ['checked with no report', (h) => { rmSync(join(h.runDir, 'lane-wp-02-report.md')); return h.reset('checked'); }, 5, /no report at/],
    ['prompt with no brief', (h) => { rmSync(join(h.runDir, 'lane-wp-02.md')); return h.reset('prompt'); }, 5, /no brief at/],
    ['prompt on a herdr lane with no pane', (h) => { h.wp('WP-02').lane.paneId = null; return h.reset('prompt'); }, 5, /no pane/],
    ['prompt on a running exec lane', (h) => { h.wp('WP-02').lane = h.lane({ backend: 'exec', pid: 42, exitedAt: null }); return h.reset('prompt'); }, 5, /has not been observed to exit/],
    ['land with no PR', (h) => { h.wp('WP-02').pr = null; return h.reset('land'); }, 5, /no PR to land/],
    ['land with findings not adjudicated', (h) => { h.wp('WP-02').owed = { adjudicate: true, round: 1 }; return h.reset('land'); }, 5, /round 1 findings are not adjudicated; reset it --to checked/],
    ['land on a merged PR',(h) => { h.wp('WP-02').merge = { sha: 'd'.repeat(40) }; return h.reset('land'); }, 5, /already merged/],
    ['checked with no PR', (h) => { h.wp('WP-02').pr = null; return h.reset('checked'); }, 5, /no PR recorded; reset it --to check/],
    ['wait on an exec lane', (h) => { h.wp('WP-02').lane = h.lane({ backend: 'exec', pid: 42 }); return h.reset('wait'); }, 5, /exec lane; restart it with --to prompt/],
    ['prompt on an exec lane with no session', (h) => { h.wp('WP-02').lane = h.lane({ backend: 'exec', pid: 42 }); return h.reset('prompt'); }, 5, /no session id to resume/],
    ['Files a live WP holds', (h) => { Object.assign(h.wp('WP-03'), { state: 'dispatched', files: ['lib/lanes.mjs'] }); return h.reset('check'); }, 5, /WP-03 \(dispatched\) holds a path in WP-02's Files/],
    ...['prompt', 'check'].map((to) => [`no lane slot for ${to}`, (h) => { h.state.intent.lanesCap = 1; Object.assign(h.wp('WP-03'), { state: 'dispatched' }); return h.reset(to); }, 5, /1 lane\(s\) are live \(WP-03\) against the run's cap of 1/]),
    ['a merged-tree halt', (h) => { h.state.build = { halts: [{ kind: 'merged', reason: 'WP-01 merged tree differs', touch: 3 }] }; return h.reset('land'); }, 5, /dispatch is halted \(WP-01 merged tree differs\); answer touch 3 first/],
    ['an unverified lane', (h) => { h.wp('WP-02').lane.livenessHeld = true; return h.reset('check'); }, 5, /liveness is unverified/],
    ['an open touch on the WP', (h) => { h.state.touches = [{ n: 1, wpId: 'WP-02', status: 'filed' }]; return h.reset('check'); }, 5, /touch 1 open/],
    ['the WP\'s pending action', (h) => { h.state.pending = { id: '9-stop', wpId: 'WP-02', step: 'stop' }; return h.reset('check'); }, 5, /9-stop is pending/],
    ...['intake', 'preapproval', 'spec', 'mint', 'closed', 'declined', 'sent-back'].map((phase) => [`phase ${phase}`, (h) => { h.state.phase = phase; return h.reset('check'); }, 5, new RegExp(`phase ${phase}`)]),
    ['a filed showcase touch', (h) => { Object.assign(h.state, { phase: 'showcase', touches: [{ n: 2, kind: 'showcase', status: 'filed' }] }); h.state.release.state = 'not-exercised'; return h.reset('check'); }, 5, /showcase touch 2 is already filed/],
    ['a release that ran', (h) => { h.state.phase = 'analyze'; h.state.release.state = 'merged'; return h.reset('check'); }, 5, /release is merged/],
    ['a release in flight', (h) => { h.state.phase = 'release'; h.state.release.stage = 'gate'; return h.reset('check'); }, 5, /release is pending at gate/],
  ];
  // beforeChange runs after the last check and before the first change, so a
  // refusal that never reached it changed nothing and wrote no snapshot.
  for (const [name, call, code, message] of rows) {
    const h = resetFixture(t);
    let snapshot = 0;
    h.reset = (to, extra = {}) => build.resetWp(h.state, { wpId: 'WP-02', to, why: 'a ruling', ...extra }, h.deps, { beforeChange: () => { snapshot += 1; } });
    assert.throws(() => call(h), { code, message }, name);
    assert.equal(snapshot, 0, `${name}: no snapshot is written for a refusal`);
  }
});

// Quest 190c9a18 (H14): a land runs in the conductor, so a WP at gate holds
// no lane slot; only an amendment the land starts takes one.
test('reset-wp --to land (190c9a18): admitted with every slot taken; Files a live WP holds still refuse it', (t) => {
  const h = resetFixture(t);
  h.state.intent.lanesCap = 1;
  Object.assign(h.wp('WP-03'), { state: 'dispatched' });
  const out = h.reset('land');
  assert.deepEqual([out.state, out.stage], ['gate', 'land']);
  const overlap = resetFixture(t);
  overlap.state.intent.lanesCap = 1;
  Object.assign(overlap.wp('WP-03'), { state: 'dispatched', files: ['lib/lanes.mjs'] });
  assert.throws(() => overlap.reset('land'), { code: 5, message: /WP-03 \(dispatched\) holds a path in WP-02's Files/ });
});

const FOUR = [TWO[0], TWO[1], TWO[2], { id: 'WP-04', files: ['lib/x.mjs'], dependsOn: ['WP-01'] }];
const firstOf = (h, id, fn = () => true) => h.trace.findIndex((a) => a.wpId === id && fn(a));

test('lane cap (190c9a18): a WP landing frees its slot, so the next WP is dispatched before it merges', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1], TWO[2]], lanes: 1 });
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
  const landing = firstOf(h, 'WP-02', (a) => a.step === 'rebase');
  const dispatched = firstOf(h, 'WP-03');
  assert.ok(landing >= 0 && landing < dispatched, 'WP-03 waits for WP-02 to leave its lane');
  assert.ok(dispatched < firstOf(h, 'WP-02', (a) => a.step === 'merge'), 'WP-03 is dispatched while WP-02 lands');
});

test('lane cap (190c9a18): a gate amendment waits for a lane slot, and takes the next one before a new dispatch', async (t) => {
  const h = harness(t, { wps: [...FOUR, { id: 'WP-05', files: ['lib/y.mjs'], dependsOn: ['WP-01'] }], lanes: 1 });
  h.gateCmdCode = { 'WP-02': [1] };
  // WP-04's lane is still running when WP-02's gate fails.
  h.life = { 'WP-04': 12 };
  // At every emitted action, the lane agents running fit the cap.
  const over = [];
  h.onEmit = (a) => {
    const running = h.state.wps.filter(laneOccupied).map((wp) => wp.id);
    if (running.length > 1) over.push(`${a.id}: ${running.join(', ')}`);
  };
  assert.equal(await drive(h, { max: 1200 }), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged', 'merged', 'merged']);
  assert.deepEqual(over, []);
  const brief = firstOf(h, 'WP-02', (a) => a.part === 'amendment');
  const relaunch = h.trace.findIndex((a, i) => i > brief && a.wpId === 'WP-02' && ['start', 'prompt'].includes(a.step));
  assert.ok(brief >= 0 && relaunch > brief);
  assert.ok(h.trace.slice(brief, relaunch).some((a) => a.kind === 'wait' && /WP-02 waits for a lane slot: WP-04 hold/.test(a.instruction)), 'the amendment waited for WP-04\'s slot');
  // The waiting amendment holds the next slot: no WP is dispatched while it waits.
  const firsts = ['WP-03', 'WP-04', 'WP-05'].map((id) => firstOf(h, id));
  assert.deepEqual(firsts.filter((i) => i > brief && i < relaunch), [], 'no dispatch between the amendment and its restart');
  assert.ok(firstOf(h, 'WP-05') > relaunch, 'WP-05 is dispatched after the amendment restarts WP-02');
});

test('reset-wp (61d817db): each target\'s stage, state and queue; a lane that exited is started before its prompt; wait renews the deadline; deferrals through a chain are lifted', async (t) => {
  const shapes = (h) => h.wp('WP-02').queue.map((a) => `${a.step}${a.command?.includes('--amendment') ? ' --amendment' : ''}${a.command?.includes('--amend') ? ' --amend' : ''}`);
  const h = resetFixture(t, { wps: [...RATIFY_WPS, { id: 'WP-04', files: ['lib/x.mjs'], dependsOn: ['WP-03'] }] });
  Object.assign(h.wp('WP-04'), { state: 'deferred', deferredBy: 'WP-03' });
  const out = h.reset('prompt');
  assert.deepEqual([out.state, out.stage, shapes(h), out.undeferred], ['amending', 'wait', ['start', 'prompt --amendment'], ['WP-03', 'WP-04']]);
  assert.deepEqual([h.wp('WP-03').state, h.wp('WP-04').state, h.wp('WP-04').deferredBy], ['pending', 'pending', null]);

  const alive = resetFixture(t);
  alive.wp('WP-02').lane.exitedAt = null;
  alive.reset('prompt');
  assert.deepEqual(shapes(alive), ['prompt --amendment'], 'a live herdr agent gets the prompt alone');
  const prompted = resetFixture(t);
  prompted.wp('WP-02').amendment = null;
  assert.deepEqual([prompted.reset('prompt').state, shapes(prompted)], ['dispatched', ['start', 'prompt --amendment']], 'a lane that ran: every later prompt is an amendment to lane.mjs');
  const never = resetFixture(t);
  Object.assign(never.wp('WP-02'), { amendment: null, lane: never.lane({ startedAt: null, exitedAt: null }) });
  assert.deepEqual(shapes((never.reset('prompt'), never)), ['start', 'prompt'], 'a lane that never started: the first prompt');
  const exec = resetFixture(t);
  exec.wp('WP-02').lane = exec.lane({ backend: 'exec', pid: 42, sessionId: 's-1' });
  exec.reset('prompt');
  assert.deepEqual(shapes(exec), ['prompt --amend'], 'an exec amendment resumes the session by a new spawn');
  const execRan = resetFixture(t);
  Object.assign(execRan.wp('WP-02'), { amendment: null, lane: execRan.lane({ backend: 'exec', pid: 42, sessionId: 's-1' }) });
  execRan.reset('prompt');
  assert.deepEqual(shapes(execRan), ['prompt --amend'], 'an exec lane that ran resumes its session, never a fresh one');

  // A refused start (exit 7) re-arms the start and keeps the prompt queued behind it.
  const refused = resetFixture(t);
  refused.reset('prompt');
  const start = { ...refused.wp('WP-02').queue[0], id: '9-start', phase: 'build', wpId: 'WP-02' };
  await build.record(refused.state, start, { code: 7, stdout: '', stderr: 'low memory' }, refused.deps);
  assert.deepEqual(shapes(refused), ['wait', 'start', 'prompt --amendment']);

  const stop = { kind: 'shell', step: 'stop', part: 'stop', command: ['x'] };
  for (const [to, state, stage] of [['check', 'amending', 'check'], ['checked', 'amending', 'checked'], ['land', 'gate', 'land']]) {
    const r = resetFixture(t);
    r.wp('WP-02').queue = [stop, { kind: 'author', step: 'ratify', part: 'ruling' }];
    const done = r.reset(to);
    assert.deepEqual([done.state, done.stage, done.queue, done.dropped], [state, stage, ['stop/stop'], ['ratify/ruling']], `${to}: an owed stop runs first`);
  }
  const live = resetFixture(t);
  Object.assign(live.wp('WP-02'), { queue: [stop], lane: live.lane({ exitedAt: null }) });
  assert.deepEqual(live.reset('prompt').dropped, ['stop/stop'], 'prompt wants the running agent');
  const held = resetFixture(t);
  Object.assign(held.wp('WP-02'), { state: 'held', heldOutside: ['CLAUDE.md'], heldUncited: ['c'.repeat(40)] });
  assert.equal(held.reset('land').state, 'gate');
  assert.deepEqual([held.wp('WP-02').heldOutside, held.wp('WP-02').heldUncited], [null, null]);
  const rewound = resetFixture(t);
  Object.assign(rewound.state, { phase: 'analyze' });
  rewound.state.release.state = 'not-exercised';
  rewound.reset('check');
  assert.equal(rewound.state.phase, 'build');

  const wait = resetFixture(t);
  wait.tick(5 * 3600000);
  wait.reset('wait');
  const lane = wait.wp('WP-02').lane;
  assert.deepEqual([lane.startedAt, lane.exitedAt, Date.parse(lane.deadline) - wait.deps.now()], [wait.deps.timestamp(), null, 120 * 60000]);
});

test('Needs conductor on a passing report (d9d4d664): the build rules before review; the ruling is an event and a rulings[] row, ratifies its path, amends the lane; a repeated ask is not ruled again', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  // The lane's amended report repeats the same ask.
  h.reports = { 'WP-02': ['report-built-asks.md', 'report-built-asks.md'] };
  h.rulings = [{ ruled: 'a', evidence: 'the panel is the only place the roving tabindex can live', ratify: ['src/ui/SidePanel.svelte'] }];
  const rulings = [];
  h.onEmit = (a) => { if (a.step === 'ruling') rulings.push(a); };
  assert.equal(await drive(h), null);
  assert.equal(rulings.length, 1, 'one ruling for the one ask');
  assert.deepEqual([rulings[0].part, rulings[0].ruling.keys], ['ask', ['a', 'b']]);
  const firstReview = indexWhere(h, (a) => a.wpId === 'WP-02' && a.step === 'review');
  assert.ok(h.trace.indexOf(rulings[0]) < firstReview, 'ruled before review');
  const wp = h.wp('WP-02');
  assert.deepEqual(wp.rulings.map((r) => [r.ruled, r.ratified]), [['a', ['src/ui/SidePanel.svelte']]]);
  assert.ok(wp.files.includes('src/ui/SidePanel.svelte'));
  const ruled = h.events().filter((e) => e.event === 'ruled');
  assert.deepEqual(ruled.map((e) => [e.data.wpId, e.data.ruled, e.data.ratified]), [['WP-02', 'a', ['src/ui/SidePanel.svelte']]]);
  assert.equal(h.events().filter((e) => e.event === 'ratified').length, 1);
  assert.ok(of(h, 'WP-02').some((a) => a.step === 'brief' && a.amendment?.kind === 'ruling'), 'the ruling went to the lane as an amendment');
  assert.equal(wp.state, 'merged');
});

test('Needs conductor (d9d4d664): one ruling per question, its stem in the instruction; the same option text under a new question is ruled again', async (t) => {
  const two = harness(t, { wps: [TWO[0], TWO[1]] });
  two.reports = { 'WP-02': ['report-built-two-asks.md', 'report-built.md', 'report-built.md'] };
  two.rulings = [{ ruled: 'a', evidence: 'x' }, { ruled: 'b', evidence: 'y' }];
  const asked = [];
  two.onEmit = (a) => { if (a.step === 'ruling') asked.push(a); };
  assert.equal(await drive(two), null);
  assert.deepEqual(asked.map((a) => a.ruling.keys), [['a', 'b'], ['a', 'b']]);
  assert.match(asked[0].instruction, /question "\(a\) Change the timeout\?"/);
  assert.match(asked[1].instruction, /question "\(b\) Remove the authorization guard\?"/);
  // Both rulings reach the lane in one amendment, ruled before it.
  const briefs = of(two, 'WP-02').filter((a) => a.step === 'brief' && a.amendment?.kind === 'ruling');
  assert.equal(briefs.length, 1);
  assert.ok(two.trace.indexOf(briefs[0]) > two.trace.indexOf(asked[1]));
  assert.deepEqual(briefs[0].amendment.rulings.map((r) => [r.question, r.ruled]), [['(a) Change the timeout?', 'a'], ['(b) Remove the authorization guard?', 'b']]);
  assert.equal(two.wp('WP-02').state, 'merged');

  const reused = harness(t, { wps: [TWO[0], TWO[1]] });
  reused.reports = { 'WP-02': ['report-built-asks-timeout.md', 'report-built-asks-new-question.md', 'report-built.md'] };
  reused.rulings = [{ ruled: 'a', evidence: 'x' }, { ruled: 'b', evidence: 'y' }];
  const again = [];
  reused.onEmit = (a) => { if (a.step === 'ruling') again.push(a); };
  assert.equal(await drive(reused), null);
  assert.equal(again.length, 2, 'the new question is ruled although its options repeat');
  assert.match(again[1].instruction, /Remove the authorization guard\?/);
});

test('lanes 3-4 (b443eca6): with --lanes 3 on the exec backend, only the 3rd live lane asks lane.mjs admit; refused (free commit memory 8 GB, exit 7) it is held back, then admitted and merged', async (t) => {
  const THREE = [TWO[0], TWO[1], TWO[2], { id: 'WP-04', files: ['lib/schedule.mjs'], dependsOn: ['WP-01'] }];
  const h = harness(t, { lanes: 3, wps: THREE });
  h.life = { 'WP-02': 4, 'WP-03': 4, 'WP-04': 1 };
  h.herdrAdmit = { 'WP-04': [7] };
  h.onPerform = (a) => { if (a.yield) h.tick(a.waitMs); };
  let held = false;
  h.onEmit = () => {
    const four = h.wp('WP-04');
    if (four.state === 'pending' && four.notBefore && ['WP-02', 'WP-03'].every((id) => LIVE.includes(h.wp(id).state))) held = true;
  };
  assert.equal(await drive(h, { max: 1200 }), null);
  const admits = h.trace.filter((a) => a.step === 'admit' && a.kind === 'shell');
  assert.deepEqual([...new Set(admits.map((a) => a.wpId))], ['WP-04'], 'the first two lanes are not gated');
  // Refused once; by its retry the other lanes may have ended, and a lane that is not the 3rd is not gated.
  assert.ok(admits.length >= 1);
  assert.ok(admits[0].command.includes('admit') && admits[0].command[1].endsWith('lane.mjs'));
  assert.ok(admits[0].command.includes('--require-reading'), 'an unmeasured host gets no 3rd lane');
  assert.ok(held, 'WP-04 was held back while WP-02 and WP-03 ran');
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged', 'merged']);
});

test('lanes 3-4 (190c9a18): a WP landing is not counted toward the 3rd lane, so the 2nd agent beside it asks no admit', async (t) => {
  const h = harness(t, { lanes: 2, wps: [TWO[0], TWO[1], TWO[2], { id: 'WP-04', files: ['lib/schedule.mjs'], dependsOn: ['WP-01'] }] });
  h.life = { 'WP-03': 40 };
  assert.equal(await drive(h, { max: 1200 }), null);
  const dispatched = firstOf(h, 'WP-04');
  assert.ok(dispatched >= 0 && dispatched < firstOf(h, 'WP-02', (a) => a.step === 'merge'), 'WP-04 is dispatched while WP-02 lands and WP-03 runs');
  assert.deepEqual(h.trace.filter((a) => a.step === 'admit' && a.kind === 'shell').map((a) => a.wpId), []);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged', 'merged']);
});

test('budget, live lanes (8f433d11): two live lanes at $30 plus the next WP against an $80 cap halts the third dispatch, unmetered', async (t) => {
  const THREE = [TWO[0], TWO[1], TWO[2], { id: 'WP-04', files: ['lib/schedule.mjs'], dependsOn: ['WP-01'] }];
  const config = JSON.stringify({ ...JSON.parse(fixture('build', 'conduct.json')), laneEstimateUsd: 30 });
  const h = harness(t, { lanes: 3, wps: THREE, budget: 80, config });
  h.life = { 'WP-02': 5, 'WP-03': 5 };
  await drive(h, { until: (a) => a.part === 'announce' });
  const [touch] = h.state.touches;
  assert.ok(touch, `a budget touch opened; WP-04 is ${h.wp('WP-04').state}`);
  assert.match(touch.question, /Spend is \$90 committed \(\$0 booked \+ \$60 for 2 live lane\(s\) \+ \$30 for the next WP; lanes at \$30 each, the repo config laneEstimateUsd\) against the \$80 budget \(unmetered/);
  assert.equal(h.wp('WP-04').state, 'pending', 'the third lane was never dispatched');
  assert.ok(!h.trace.some((a) => a.wpId === 'WP-04'));
});

test('budget projection (8f433d11): every merge records booked spend and the projected total with the WPs left', async (t) => {
  const h = harness(t);
  assert.equal(await drive(h), null);
  const projections = h.events().filter((e) => e.event === 'spend-projection');
  assert.equal(projections.length, 2);
  assert.deepEqual(projections.map((e) => e.data.wpId).sort(), ['WP-02', 'WP-03']);
  const money = (usd) => Math.round(usd * 100) / 100;
  for (const p of projections) {
    assert.equal(p.data.budgetUsd, 25);
    assert.equal(p.data.projectedUsd, money(p.data.bookedUsd + p.data.wpsLeft * p.data.perWpUsd), JSON.stringify(p.data));
  }
  // Exec lanes book their cost when they exit, before the merge: the last merge has both, and nothing left.
  const last = projections.at(-1).data;
  assert.deepEqual([last.wpsLeft, money(last.bookedUsd), last.projectedUsd], [0, money(2 * LANE_COST), money(2 * LANE_COST)]);
  assert.equal(money(last.perWpUsd), money(LANE_COST));
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

test('exec cleanup (5c93c8cb, db7fde36): each exec lane exit is reaped, and every merged WP\'s worktree removal, then its branch deletes, follow its merge; herdr lanes are swept', async (t) => {
  const h = harness(t, { wps: TWO });
  // A reap failure never blocks, so a reap that could not run would pass
  // silently: the process list answers, and each reap's state is asserted.
  h.rules.push([/^ps -eo pid=,ppid=,args=$/, () => ok('1 0 init\n')]);
  assert.equal(await drive(h), null);
  for (const id of ['WP-02', 'WP-03']) {
    const mine = of(h, id);
    const merged = mine.findIndex((a) => a.step === 'merged');
    const remove = mine.findIndex((a) => a.step === 'stop' && a.part === 'remove');
    assert.ok(merged >= 0 && remove > merged, `${id}: the worktree removal follows the merge`);
    assert.deepEqual(mine[remove].command.slice(0, 5), ['git', '-C', resolve(h.repo), 'worktree', 'remove']);
    assert.ok(mine.some((a, i) => a.part === 'reap' && i < merged && mine[i - 1]?.step === 'wait'), `${id}: the lane's exit was reaped before review`);
    assert.deepEqual([h.wp(id).state, h.wp(id).lane.removed, h.wp(id).lane.reap.state], ['merged', true, 'reaped']);
    // Both deletes compare against the head the merge checked.
    const branch = `conduct/demo/${id.toLowerCase()}`;
    const head = h.wp(id).gate.head;
    const local = mine.findIndex((a) => a.part === 'branch');
    const remote = mine.findIndex((a) => a.part === 'branch-remote');
    // The checkout read runs right before the deletes, not when the removal is recorded.
    assert.deepEqual([mine[local - 1].part, local > remove, remote], ['branch-holder', true, local + 1], `${id}: removal, checkout read, local delete, remote delete`);
    assert.deepEqual(mine[local].command, ['git', '-C', resolve(h.repo), 'update-ref', '-d', `refs/heads/${branch}`, head]);
    assert.deepEqual(mine[remote].command, ['git', '-C', resolve(h.repo), 'push', 'origin', `--force-with-lease=refs/heads/${branch}:${head}`, '--delete', branch]);
    assert.deepEqual(h.wp(id).lane.branchDeleted, { local: 'deleted', remote: 'deleted' });
  }
  // The action's argv runs through the CLI, whose sub-verb list must name reap.
  const reap = of(h, 'WP-02').find((a) => a.part === 'reap');
  const cli = await runConduct(reap.command.slice(2), h.overrides());
  assert.deepEqual([cli.code, JSON.parse(cli.stdout).state], [0, 'reaped'], cli.stderr);
  const herdr = harness(t, { herdr: true, wps: TWO });
  assert.equal(await drive(herdr), null);
  assert.ok(!herdr.trace.some((a) => a.part === 'reap'), 'herdr lanes are reaped by lane.mjs stop');
  for (const id of ['WP-02', 'WP-03']) {
    const mine = of(herdr, id);
    const remove = mine.findIndex((a) => a.part === 'remove');
    assert.ok(remove > mine.findIndex((a) => a.step === 'merged'), `${id}: the sweep follows the merge`);
    assert.ok(mine[remove].command[1].endsWith('lane.mjs'));
    assert.deepEqual(mine[remove].command.slice(2, 7), ['sweep', '--lane', `demo-${id.toLowerCase()}`, '--workspace-root', dirname(dirname(resolve(herdr.repo)))]);
    assert.deepEqual([herdr.wp(id).lane.removed, herdr.wp(id).lane.branchDeleted], [true, { local: 'deleted', remote: 'deleted' }]);
  }
});

test('merged cleanup (db7fde36): a worktree that stays keeps both branches; a branch that moved stays, one already gone reads absent; an unmerged WP queues none', async (t) => {
  const h = harness(t, { herdr: true, wps: TWO });
  const kept = `${h.repo}-wt-demo-wp-02`;
  h.answer = (a) => {
    // The sweep HOLDs WP-02's lane: exit 0, and the directory is still there.
    if (a.wpId === 'WP-02' && a.part === 'remove') {
      mkdirSync(kept, { recursive: true });
      return ok(JSON.stringify({ delegated: true, holds: [{ pane: 'pane-WP-02', message: 'HOLD on pane-WP-02 by claude' }] }));
    }
    if (a.wpId === 'WP-03' && a.part === 'branch') return { code: 1, stdout: '', stderr: "error: cannot lock ref 'refs/heads/conduct/demo/wp-03': is at 1111 but expected 2222" };
    if (a.wpId === 'WP-03' && a.part === 'branch-remote') return { code: 1, stdout: '', stderr: "error: unable to delete 'conduct/demo/wp-03': remote ref does not exist" };
    return undefined;
  };
  assert.equal(await drive(h), null);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-02').lane.removed], ['merged', false]);
  assert.match(h.wp('WP-02').lane.removeError, /still exists after the removal: .*HOLD on pane-WP-02/);
  assert.ok(!of(h, 'WP-02').some((a) => a.part === 'branch' || a.part === 'branch-remote'), 'no branch is deleted while its worktree stays');
  const wp03 = h.wp('WP-03').lane.branchDeleted;
  assert.deepEqual([wp03.local, wp03.remote], ['kept', 'absent']);
  assert.match(wp03.localError, /cannot lock ref/);
  await analyzeRun(h.runDir, h.deps);
  const analysis = readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  assert.match(analysis, /^- WP-02 \(name WP-02\): merged, PR #102; cleanup kept the worktree and branches: .*still exists after the removal/m);
  assert.match(analysis, /^- WP-03 \(name WP-03\): merged, PR #103; cleanup kept the local branch \(error: cannot lock ref .*\)$/m);

  // An exec lane's branch deletes exit 1 for their own reasons: with the old
  // pid reused, each is recorded (a moved branch kept, a gone one absent),
  // never polled as a liveness read.
  const exec = harness(t, { wps: [TWO[0], TWO[1]] });
  exec.rules.push([/^ps -eo pid=,ppid=,args=$/, () => ok('1 0 init\n')]);
  exec.answer = (a) => {
    if (a.wpId !== 'WP-02' || !['branch', 'branch-remote'].includes(a.part)) return undefined;
    exec.lifeByPid.set(4202, 9);
    return { code: 1, stdout: '', stderr: a.part === 'branch' ? "error: cannot lock ref 'refs/heads/conduct/demo/wp-02': is at 1111 but expected 2222" : "error: unable to delete 'conduct/demo/wp-02': remote ref does not exist" };
  };
  assert.equal(await drive(exec), null);
  assert.deepEqual([exec.wp('WP-02').lane.branchDeleted.local, exec.wp('WP-02').lane.branchDeleted.remote], ['kept', 'absent']);
  assert.ok(!exec.events().some((e) => e.event === 'liveness-uncertain'), 'a branch delete is not a liveness read');

  // Another worktree has WP-03's branch checked out (an operator's `gh pr
  // checkout`): both branches stay, and the analysis says where.
  const other = harness(t, { wps: TWO });
  other.rules.push([/^ps -eo pid=,ppid=,args=$/, () => ok('1 0 init\n')]);
  other.answer = (a) => (a.part === 'branch-holder' && a.wpId === 'WP-03'
    ? ok(`worktree ${other.repo}\nHEAD ${BASE}\nbranch refs/heads/main\n\nworktree ${other.dir}/review\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/conduct/demo/wp-03\n`)
    : undefined);
  assert.equal(await drive(other), null);
  const holder = of(other, 'WP-03').find((a) => a.part === 'branch-holder');
  assert.deepEqual(holder.command, ['git', '-C', resolve(other.repo), 'worktree', 'list', '--porcelain']);
  assert.ok(!of(other, 'WP-03').some((a) => a.part === 'branch' || a.part === 'branch-remote'), 'a branch checked out elsewhere is not deleted');
  assert.deepEqual([other.wp('WP-03').lane.removed, other.wp('WP-03').lane.branchDeleted.local, other.wp('WP-03').lane.branchDeleted.remote], [true, 'kept', 'kept']);
  assert.deepEqual(other.wp('WP-02').lane.branchDeleted, { local: 'deleted', remote: 'deleted' });
  await analyzeRun(other.runDir, other.deps);
  assert.match(readFileSync(join(other.runDir, 'run-analysis.md'), 'utf8'), /^- WP-03 \(name WP-03\): merged, PR #103; cleanup kept the local branch \(checked out at \S+review\) and the remote branch/m);

  const hold = harness(t, { herdr: true, merge: false, wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(hold), null);
  assert.equal(hold.wp('WP-02').state, 'held');
  assert.ok(!of(hold, 'WP-02').some((a) => ['remove', 'branch', 'branch-remote'].includes(a.part)), 'a held WP keeps its worktree and branches');
});

test('backend (D18, D19.18): flipping herdr off after dispatch keeps the WP on herdr; herdr on outside a projects tree → exec with the reason', async (t) => {
  const h = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  await drive(h, { until: (a) => a.step === 'create' });
  h.state.adapters.herdr.on = false;
  await drive(h);
  assert.equal(h.wp('WP-02').lane.backend, 'herdr');
  for (const a of of(h, 'WP-02').filter((x) => ['start', 'wait', 'stop'].includes(x.step) && !['branch-holder', 'branch', 'branch-remote'].includes(x.part))) assert.ok(a.command[1].endsWith('lane.mjs'), a.id);
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
  assert.deepEqual(touch.options.map((o) => [o.key, o.label]), [['a', 'keep the old flag name'], ['b', 'rename the flag to --since']]);
  assert.equal(touch.wpId, 'WP-02');
  assert.equal(touch.suspendedStep, 'check');
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.equal(h.events().filter((e) => e.event === 'touch-opened').length, 1);
});

function answerCore(h, n, key, text = null) {
  const touch = h.state.touches[n - 1];
  touch.tty = true;
  acceptAnswer(h.state, touch, { key, text, by: 'operator:tty', answeredAt: h.deps.timestamp(), source: 'tty' });
}

test('Needs conductor (d9d4d664): a stopped report\'s two questions get one ruling each and one amendment; a ruling held when a later question escalates reaches the lane with the operator\'s answer', async (t) => {
  const stopped = harness(t, { wps: [TWO[0], TWO[1]] });
  stopped.reports = { 'WP-02': ['report-stopped-two-asks.md', 'report-built.md'] };
  stopped.rulings = [{ ruled: 'a', evidence: 'x' }, { ruled: 'b', evidence: 'y' }];
  const asked = [];
  stopped.onEmit = (a) => { if (a.step === 'ruling') asked.push(a); };
  assert.equal(await drive(stopped), null);
  assert.deepEqual(asked.map((a) => a.ruling.keys), [['a', 'b'], ['a', 'b']]);
  const briefs = of(stopped, 'WP-02').filter((a) => a.step === 'brief' && a.amendment?.kind === 'ruling');
  assert.deepEqual(briefs.map((a) => a.amendment.rulings?.map((r) => r.ruled)), [['a', 'b']]);

  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.reports = { 'WP-02': ['report-built-two-asks.md', 'report-built.md'] };
  h.rulings = [{ ruled: 'a', evidence: 'the timeout belongs here' }, { escalate: true, why: 'only the operator can drop a guard' }];
  await drive(h, { until: (a) => a.kind === 'touch' || (a.step === 'touch' && a.part === 'announce') });
  assert.equal(h.state.touches.length, 1, 'the escalation opened one touch');
  h.state.pending = null;
  answerCore(h, 1, 'b');
  const brief = await step(h);
  assert.equal(brief.part, 'amendment');
  assert.match(brief.instruction, /verbatim: \(b\)/);
  assert.match(brief.instruction, /\(a\) Change the timeout\? → \(a\); evidence, verbatim: the timeout belongs here/);
  assert.deepEqual(h.wp('WP-02').heldRulings, []);
});

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
  // The exec lane's observed exit reaps its worktree before the check.
  assert.deepEqual(afterBrief.slice(0, 4), ['prompt', 'wait', 'stop', 'check']);
});

test('blocked recovery (D19.4), spine, idle build (E6): with no lane work left the build files the touch, reads it back and hands back, never a 300000 ms poll; next resumes at the read-back; the answer merges', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1], { id: 'WP-04', files: ['x.mjs'], wave: 3, dependsOn: ['WP-02'] }] });
  h.reports = { 'WP-02': ['report-needs-conductor.md', 'report-built.md'] };
  h.rulings = [{ escalate: true, why: 'operator call' }];
  await drive(h, { until: (a) => a.tool === 'spine_receipt' && a.args.outcome === 'needs_input' });
  const from = h.trace.length - 1;
  const back = await drive(h, { until: (a) => a.handBack === true, max: 10 });
  assert.deepEqual(h.trace.slice(from).map((a) => a.tool ?? a.part), ['spine_receipt', 'post', 'spine_quest', 'hand-back']);
  assert.deepEqual([back.kind, back.step, back.touch.n], ['touch', 'touch', 1]);
  assert.equal(h.state.phase, 'build');
  assert.equal(h.wp('WP-04').state, 'deferred');
  // A fresh runConduct `next` is the resume: the read-back, not a new filing; unanswered, it hands back again.
  h.disk = true;
  const resumed = await step(h);
  assert.deepEqual([resumed.tool, resumed.part], ['spine_quest', 'read-back']);
  assert.ok(h.events().some((e) => e.event === 'resumed' && e.actionId === back.id));
  h.trace.push(resumed);
  await recordPending(h, await perform(h, resumed));
  assert.equal(h.current().pending.part, 'hand-back');
  assert.equal(h.current().touches[0].filings, 1);
  // The operator answers (a) on the spine: the next resume reads it back.
  h.spineQuest = () => {
    const result = JSON.parse(fixture('intake', 'spine-quest-answered.json'));
    result.quests[0].latestReceipt.question = h.current().touches[0].filedQuestion;
    result.quests[0].latestReceipt.answer.key = 'a';
    return result;
  };
  assert.equal(await drive(h), null);
  assert.deepEqual(h.current().wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
  assert.ok(!h.trace.some((a) => a.kind === 'wait' && a.waitMs === 300000), 'no 300000 ms poll');
});

test('blocked recovery (D19.4), spine, live lane (E6): while WP-03 runs, the waiting touch is re-read on the yield cadence between WP-03\'s actions and never handed back; once WP-03 merges the build hands back', async (t) => {
  const h = harness(t, { spine: true });
  h.reports = { 'WP-02': ['report-needs-conductor.md', 'report-built.md'] };
  h.rulings = [{ escalate: true, why: 'operator call' }];
  h.life = { 'WP-03': 20 };
  const backs = [];
  h.onEmit = (a) => { if (a.handBack) backs.push(h.wp('WP-03').state); };
  const back = await drive(h, { until: (a) => a.handBack === true });
  assert.deepEqual(backs, ['merged'], 'the only hand-back comes after WP-03 merged');
  const filed = indexWhere(h, (a) => a.tool === 'spine_receipt' && a.args.outcome === 'needs_input');
  const during = h.trace.slice(filed, h.trace.indexOf(back));
  assert.ok(during.filter((a) => a.tool === 'spine_quest').length >= 2, 'the touch was read back again while WP-03 ran');
  assert.ok(during.some((a) => a.kind === 'wait' && a.yield === true && /touch 1\]: no answer yet/.test(a.instruction)), 'yield waits name the touch');
  assert.ok(during.some((a) => a.wpId === 'WP-03'), 'WP-03 kept going');
  assert.equal(h.wp('WP-02').state, 'blocked');
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
  // 93d852e6: a brief that ruled "decline" got a `declined` row the check refused; the instruction names the verdicts.
  const brief = of(h, 'WP-02').find((a) => a.part === 'amendment');
  assert.match(brief.instruction, /`fixed`, `refuted` or `judgment`/);
  assert.match(brief.instruction, /"no change" ruling is `refuted` .* otherwise `judgment`/);
});

test('a fix loop that repeats a class: round 2\'s findings brief asks for a design ruling or a narrowed claim; round 1\'s does not', async (t) => {
  const h = harness(t, { council: true, wps: [TWO[0], { ...TWO[1], tier: 'T2' }] });
  h.synth = [{ findings: 2, seats: ['gpt-6.1-sol'] }, { findings: 1, seats: ['gpt-6.1-sol'] }, { findings: 0, seats: ['gpt-6.1-sol'] }];
  h.reports = { 'WP-02': ['report-built.md', 'report-council-amendment.md', 'report-council-amendment.md'] };
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  await drive(h, { until: (a) => a.part === 'amendment' && a.amendment?.round === 2 });
  const briefs = of(h, 'WP-02').filter((a) => a.part === 'amendment' && a.amendment?.kind === 'findings');
  assert.deepEqual(briefs.map((a) => a.amendment.round), [1, 2]);
  assert.doesNotMatch(briefs[0].instruction, /share a defect class/);
  assert.match(briefs[1].instruction, /compare these findings with round 1's: when they share a defect class, another per-finding fix list is the wrong next step/);
  assert.match(briefs[1].instruction, /design ruling that removes the class, or narrow the WP's claim/);
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
  assert.equal(review.args.profile, 'conduct-code');
  assert.ok(!('models' in review.args));
  assert.deepEqual(review.args.artifact_paths, [join(wt, 'src/a.mjs')]);
  await recordPending(h, await perform(h, review));
  const brief = await drive(h, { until: (a) => a.part === 'amendment' });
  assert.match(brief.instruction, /C1-1, C1-2/);
  const between = of(h, 'WP-02').slice(of(h, 'WP-02').findIndex((a) => a.tool === 'council_synthesize') + 1, -1);
  assert.deepEqual(between.map((a) => a.tool), ['council_challenge']);
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  // No thread replies: a council round's only PR write is its review record (da57e5ba).
  assert.deepEqual(all.filter((a) => ['reply', 'thread-ids', 'resolve'].includes(a.step)).map((a) => `${a.step}/${a.part}`), ['reply/record']);
  const record = all.find((a) => a.part === 'record');
  const recordFile = join(h.runDir, 'council', 'wp-02', 'review-1', 'pr-record.md');
  assert.deepEqual(record.command, ['gh', 'api', '--method', 'POST', `repos/o/r/pulls/${prNumber('WP-02')}/reviews`, '-f', 'event=COMMENT', '-f', `commit_id=${sha('a', 2)}`, '-F', `body=@${recordFile}`]);
  const body = readFileSync(recordFile, 'utf8');
  assert.match(body, /\*\*Council review record\*\*: `\/conduct` run `demo`, WP-02, round 1/);
  assert.match(body, /\| C1-1 \| fixed \| `2222222` \| the control's red line: `not ok 4 - merge lock` \|/);
  assert.match(body, /\| C1-2 \| refuted \| — \| `grep -n mergeLock lib\/land\.mjs` shows the release at :876 \|/);
  assert.ok(all.indexOf(record) < all.findIndex((a) => a.step === 'rebase'), 'the record is posted at adjudication, before landing');
  const second = all.findIndex((a) => a.tool === 'council_review' && a.args.round === 2);
  assert.ok(second > all.indexOf(brief), 'the delta council round');
  // Round 2 is handed round 1's rulings (37676efe): the file is written at resolve and leads its artifacts.
  const priorFile = join(h.runDir, 'council', 'wp-02', 'review-1', 'adjudication-for-next-round.md');
  assert.equal(all[second].args.artifact_paths[0], priorFile);
  const prior = readFileSync(priorFile, 'utf8');
  assert.match(prior, /^# Prior round: findings already adjudicated \(context, not under review\)/);
  assert.match(prior, /\| C1-2 \| refuted \| — \| `grep -n mergeLock lib\/land\.mjs` shows the release at :876 \|/);
  assert.ok(!all.find((a) => a.tool === 'council_review' && a.args.round === 1).args.artifact_paths.includes(priorFile), 'round 1 has no prior round');
  assert.ok(all.findIndex((a) => a.step === 'rebase') > second);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('a report-only ruling after executable findings fixes: the delta review starts where the findings amendment did', async (t) => {
  for (const council of [false, true]) {
    const h = harness(t, { council, wps: [TWO[0], { ...TWO[1], tier: council ? 'T2' : 'T1' }] });
    const report = council ? 'report-council-amendment.md' : 'report-amendment.md';
    h.findings = { 'WP-02': [3, 0] };
    h.synth = [{ findings: 2, seats: ['gpt-6.1-sol'] }, { findings: 0, seats: ['gpt-6.1-sol'] }];
    h.reports = { 'WP-02': ['report-built.md', report, report] };
    h.onPerform = (action) => {
      if (action.step === 'prompt' && h.spawns['WP-02'] === 2) {
        appendFileSync(join(h.runDir, 'lane-wp-02-report.md'), '\n## Needs conductor\n\n(a) Keep the existing name?\n(a) Keep it.\n(b) Rename it.\n');
      }
    };
    await drive(h, { until: (a) => a.part === 'amendment' && a.amendment?.kind === 'findings' });
    const reviewed = h.wp('WP-02').reviews.at(-1).head;
    h.answer = (action) => action.part === 'amend-diff'
      ? ok(action.command.at(-2) === reviewed ? 'lib/lanes.mjs\nREADME.md\n' : 'README.md\n') : undefined;
    await drive(h, { until: (a) => a.step === 'rebase' });
    const diff = of(h, 'WP-02').find((a) => a.part === 'amend-diff');
    assert.notEqual(h.wp('WP-02').amendment.since, reviewed, 'the ruling started after the executable fixes');
    assert.equal(diff.command.at(-2), reviewed, 'the diff includes fixes made before the ruling amendment');
    const delta = of(h, 'WP-02').filter((a) => a.land?.scope === 'delta');
    assert.ok(delta.length > 0, `council ${council}: a Markdown-only ruling cannot hide executable fixes`);
    assert.ok(delta.every((a) => a.land.since === reviewed));
    assert.equal(h.wp('WP-02').reviews.at(-1).scope, 'delta');
  }
});

test('resume: a saved amendment diff from after the fixes is recomputed from the reviewed head', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [3, 0] };
  h.reports = { 'WP-02': ['report-built.md', 'report-amendment.md'] };
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  const old = await drive(h, { until: (a) => a.part === 'amend-diff' });
  const reviewed = h.wp('WP-02').reviews.at(-1).head;
  old.command.splice(-2, 1, h.wp('WP-02').pr.head);
  saveState(h.state, h.deps);
  h.disk = true;
  await recordPending(h, ok('README.md\n'));
  const replacement = await drive(h, { until: (a) => a.part === 'amend-diff' || a.step === 'rebase' });
  assert.equal(replacement.part, 'amend-diff', 'a stale Markdown-only result cannot reach the gate');
  assert.equal(replacement.command.at(-2), reviewed);
  assert.notEqual(replacement.id, old.id);
  await drive(h, { until: (a) => a.step === 'rebase' });
  assert.equal(h.wp('WP-02').reviews.at(-1).scope, 'delta');
});

test('a findings amendment restarts an exited herdr lane before prompting, and keeps a live lane', async (t) => {
  for (const exited of [true, false]) {
    const h = resetFixture(t, { herdr: true, council: true });
    const wp = h.wp('WP-02');
    Object.assign(wp, {
      state: 'review', stage: 'reviewed', tier: 'T2', amendment: { n: 2, since: sha('a', 2), kind: 'ruling' },
      pr: { number: 102, head: sha('c', 2) },
      reviews: [{ round: 2, scope: 'delta', head: sha('c', 2), findings: 2, ids: ['C2-1', 'C2-2'] }],
      lane: h.lane({ exitedAt: exited ? h.deps.timestamp() : null }),
    });
    const action = await drive(h, { until: (a) => a.wpId === wp.id && ['start', 'prompt'].includes(a.step) });
    assert.equal(action.step, exited ? 'start' : 'prompt');
    if (exited) {
      h.tick(3600000);
      await recordPending(h, await perform(h, action));
      assert.equal(wp.lane.exitedAt, null);
      assert.equal(wp.lane.startedAt, h.deps.timestamp());
      assert.ok(Date.parse(wp.lane.deadline) > h.deps.now());
      const prompt = await drive(h, { until: (a) => a.wpId === wp.id && a.step === 'prompt' });
      assert.ok(prompt.command.includes('--amendment'));
    }
    assert.equal(of(h, wp.id).filter((a) => a.step === 'start').length, exited ? 1 : 0);
  }
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
  const h = harness(t, { wps: [...TWO, behindWp02('WP-04')] });
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
  const cost = Math.round(LANE_COST * 100) / 100;
  assert.match(h.state.touches[0].question, new RegExp(`committed \\(\\$${cost} booked \\+ .*\\) against the \\$0\\.5 budget \\(unmetered: booked is the lane-only lower bound\\)`));
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
  b.declineRecover = true;
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

test('a WP whose squash landed but whose merge-commit lookup failed is still swept for post-merge threads', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.answer = (a) => (a.wpId === 'WP-02' && a.part === 'merge-commit' ? { code: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' } : undefined);
  // A review posts on #102 after its squash: open threads from then on.
  h.unresolved = (pr) => pr === '102' && h.wp('WP-02').squashed === true;
  await drive(h, { until: (a, hh) => hh.wp('WP-02').state === 'blocked' });
  assert.equal(h.wp('WP-02').squashed, true, 'the squash is recorded on the WP');
  assert.equal(h.wp('WP-02').merge?.sha, undefined);
  await analyzeRun(h.runDir, h.deps);
  const analysis = readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  assert.match(analysis, /^ {2}- WP-02 PR #102: \d+ unresolved thread\(s\) after the merge; give each a verdict$/m);
  assert.match(analysis, /^run PRs: #102 WP-02 merged \(merge commit unconfirmed\)$/m);
});

test('repo config gateEnv and gateBackground: the gate command carries the expanded env and background: true; absent, neither', async (t) => {
  const config = JSON.stringify({ gateEnv: { OBSERVATORY_TEST_DB: 'heathdev_observatory_test_conduct_{run}', LANE: '{wp}' }, gateBackground: true });
  const h = harness(t, { config, gateCommand: 'npm test', wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(h), null);
  const gate = of(h, 'WP-02').find((a) => a.step === 'gate-cmd');
  assert.deepEqual(gate.env, { OBSERVATORY_TEST_DB: 'heathdev_observatory_test_conduct_demo', LANE: 'wp_02' });
  assert.equal(gate.background, true);
  assert.equal(gate.cwd, h.wp('WP-02').lane.worktree);
  const plain = harness(t, { gateCommand: 'npm test', wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(plain), null);
  const bare = of(plain, 'WP-02').find((a) => a.step === 'gate-cmd');
  assert.deepEqual([Object.hasOwn(bare, 'env'), Object.hasOwn(bare, 'background')], [false, false]);
});

// Deploy-truth probation H9: `{run}` for that run's slug made a 74-char
// database name, past Postgres's 63, and 115 suites failed.
test('gateEnv (H9): {run} is at most 24 characters, the same in every key; a long run keeps its head and a hash, a short one is unchanged', () => {
  const config = { gateEnv: {
    OBSERVATORY_TEST_DB: 'heathdev_observatory_test_conduct_{run}', LANE: '{wp}', PGDATABASE: 'app_test_{run}',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/app_test_{run}',
  } };
  const wp = { id: 'WP-02' };
  const long = build.gateEnvFor({ slug: 'deploy-truth-in-heathdev-observatory-thi' }, wp, config);
  assert.equal('heathdev_observatory_test_conduct_deploy_truth_in_heathdev_observatory_thi'.length, 74, 'the measured overflow');
  assert.ok(Buffer.byteLength(long.OBSERVATORY_TEST_DB) <= 63, long.OBSERVATORY_TEST_DB);
  assert.match(long.OBSERVATORY_TEST_DB, /^heathdev_observatory_test_conduct_deploy_trut_[0-9a-f]{12}$/);
  // Council r1 U2/U3: every key gets the same run, and a URL is never refused for its length.
  const run = long.OBSERVATORY_TEST_DB.slice('heathdev_observatory_test_conduct_'.length);
  assert.equal(run.length, build.RUN_IDENT_MAX);
  assert.deepEqual([long.PGDATABASE, long.DATABASE_URL], [`app_test_${run}`, `postgresql://postgres:postgres@localhost:5432/app_test_${run}`]);
  assert.deepEqual(build.gateEnvFor({ slug: 'deploy-truth-in-heathdev-observatory-thi' }, wp, config), long, 'stable within a run');
  // Council r1 U1: the pair that collided under a 6-hex suffix stays apart.
  const a = build.gateEnvFor({ slug: 'deploy-truth-in-heathdev-002938' }, wp, config).OBSERVATORY_TEST_DB;
  const b = build.gateEnvFor({ slug: 'deploy-truth-in-heathdev-005002' }, wp, config).OBSERVATORY_TEST_DB;
  assert.notEqual(a, b);
  const short = build.gateEnvFor({ slug: 'demo-run' }, wp, config);
  assert.deepEqual([short.OBSERVATORY_TEST_DB, short.LANE], ['heathdev_observatory_test_conduct_demo_run', 'wp_02'], 'a run that fits is unchanged');
  // Challenge on 17293a4 (N1): an identifier still past 63 bytes, by a long or non-ASCII fixed part, is refused, never cut by Postgres.
  const refused = (value) => assert.throws(() => build.gateEnvFor({ slug: 'deploy-truth-in-heathdev-observatory-thi' }, wp, { gateEnv: { DB: value } }), (error) => error.code === 2 && /past Postgres's 63-byte identifier limit/.test(error.message));
  refused(`${'p'.repeat(40)}_{run}`);
  refused(`${'é'.repeat(20)}_{run}`);
  assert.equal(build.gateEnvFor({ slug: 'demo' }, wp, { gateEnv: { URL: `postgresql://u:p@localhost:5432/${'p'.repeat(60)}_{run}` } }).URL.endsWith('_demo'), true, 'a URL is not measured');
});

// e2b54cd3: the split. A workspace config pinned at intake replaces the
// checkout's .workit/conduct.json; laneSuite comes from AGENTS.md.
function pinWorkspace(h, config) {
  const path = join(h.dir, 'data', 'config', 'conduct', 'o', 'r.json');
  h.state.intent.repoConfig = { source: 'workspace', path, workspacePath: path, sha256: 'f'.repeat(64), config };
  writeFileSync(join(h.runDir, 'state.json'), JSON.stringify(h.state));
  return path;
}

test('repo config split (e2b54cd3): the pinned workspace config replaces the checkout file at the gate and the land check; AGENTS.md ## Lane suite fills the contract', async (t) => {
  const legacy = JSON.stringify({ gateEnv: { X: 'legacy' }, laneSuite: 'legacy suite', contractPaths: [] });
  const h = harness(t, { config: legacy, gateCommand: 'npm test', wps: [TWO[0], TWO[1]] });
  const path = pinWorkspace(h, { gateEnv: { X: 'pinned-{run}' }, gateBackground: true });
  writeFileSync(join(h.repo, 'AGENTS.md'), '# Repo\n\n## Lane suite\n\nRun the full suite\nbefore the PR boundary.\n\n### Notes\n\nnested\n\n## Commit policy\n\nnot this\n');
  const first = await step(h);
  const isolation = Object.entries(first.slots).find(([slot]) => slot.startsWith('<Per-repo lane isolation'))[1];
  assert.equal(isolation, 'Run the full suite before the PR boundary.');
  assert.match(first.append, /- \*\*Suite ownership \(AGENTS\.md `## Lane suite`\):\*\* Run the full suite before the PR boundary\. This overrides rule 9/);
  writeFileSync(first.outPath, fillTemplate(first));
  await recordPending(h, {});
  assert.equal(h.state.build.laneSuiteFrom, 'AGENTS.md `## Lane suite`');
  // A lane (or anyone) rewriting the checkout's legacy file mid-run changes nothing.
  writeFileSync(join(h.repo, '.workit', 'conduct.json'), JSON.stringify({ gateEnv: { X: 'tampered' } }));
  assert.equal(await drive(h), null);
  const gate = of(h, 'WP-02').find((a) => a.step === 'gate-cmd');
  assert.deepEqual(gate.env, { X: 'pinned-demo' });
  assert.equal(gate.background, true);
  assert.ok(!h.calls.some((call) => call.includes('show origin/main:.workit/conduct.json')), 'the land check reads the pin, not the base file');
  await analyzeRun(h.runDir, h.deps);
  const analysis = readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  assert.ok(analysis.includes(`- repo config: ${path}, sha256 ${'f'.repeat(64)}, pinned at intake; laneSuite from AGENTS.md \`## Lane suite\``), analysis);
  assert.doesNotMatch(analysis, /Deprecated/);
});

test('repo config split (e2b54cd3): the pinned contractPaths set the tier; a run with no pin reads the legacy file as before and the analysis calls it deprecated', async (t) => {
  // The fixture's legacy contractPaths do not name lib/x.mjs: T1 unless the pin does.
  const pinned = harness(t, { council: true, wps: [TWO[0], TWO[1]] });
  pinWorkspace(pinned, { contractPaths: ['lib/x.mjs'] });
  pinned.diff = { 'WP-02': 'lib/x.mjs\n' };
  await drive(pinned, { until: (a) => a.wpId === 'WP-02' && (a.part === 'meta' || a.part === 'managed') });
  assert.equal(pinned.wp('WP-02').tier, 'T2');

  const legacy = harness(t, { wps: [TWO[0], TWO[1]] });
  legacy.state.intent.repoConfig = { source: 'repo', path: join(legacy.repo, '.workit', 'conduct.json'), workspacePath: '/ws/data/config/conduct/o/r.json', sha256: 'a'.repeat(64), config: null };
  writeFileSync(join(legacy.runDir, 'state.json'), JSON.stringify(legacy.state));
  assert.equal(await drive(legacy), null);
  assert.equal(legacy.state.build.laneSuiteFrom, '`.workit/conduct.json` laneSuite');
  assert.ok(legacy.calls.some((call) => call.includes('show origin/main:.workit/conduct.json')), 'the land check still reads the base file');
  await analyzeRun(legacy.runDir, legacy.deps);
  const analysis = readFileSync(join(legacy.runDir, 'run-analysis.md'), 'utf8');
  assert.match(analysis, /^- repo config: \.workit\/conduct\.json in the product repo; laneSuite from `\.workit\/conduct\.json` laneSuite\. Deprecated location \(it still works\): move its conduct-only keys to \/ws\/data\/config\/conduct\/o\/r\.json and move laneSuite to the repo's AGENTS\.md under "## Lane suite"\.$/m);
});

// Deploy-truth probation H4: a lane worktree had no node_modules, and the
// conductor junctioned one by hand for each lane.
test('lane setup (H4): the repo\'s laneSetup runs in each new exec lane worktree, after it is added and before the agent starts; a failed setup blocks the WP', async (t) => {
  const h = harness(t, { config: JSON.stringify({ laneSetup: 'npm ci --no-audit' }), wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(h), null);
  const lane = of(h, 'WP-02').filter((a) => a.kind !== 'wait').map((a) => `${a.step}/${a.part ?? ''}`);
  const at = (name) => lane.indexOf(name);
  assert.ok(at('create/worktree') >= 0 && at('create/worktree') < at('create/setup') && at('create/setup') < at('start/'), lane.join(' '));
  const setup = of(h, 'WP-02').find((a) => a.part === 'setup');
  assert.deepEqual([setup.command, setup.cwd], [shellArgv('npm ci --no-audit', 'linux'), h.wp('WP-02').lane.worktree]);
  assert.equal(h.wp('WP-02').state, 'merged');
  const failing = harness(t, { config: JSON.stringify({ laneSetup: 'npm ci' }), wps: [TWO[0], TWO[1]] });
  failing.answer = (a) => (a.part === 'setup' ? { code: 1, stdout: '', stderr: 'npm ERR! missing lockfile' } : undefined);
  assert.equal(await drive(failing), null);
  assert.equal(failing.wp('WP-02').state, 'blocked');
  assert.match(failing.wp('WP-02').reason, /missing lockfile/);
  assert.ok(!of(failing, 'WP-02').some((a) => a.step === 'start'), 'no agent started in a worktree whose setup failed');
  // Council r1 on 453b360: the cause fixed, reset-wp --to setup reruns it in the same worktree, and the WP goes on.
  failing.answer = null;
  const worktree = failing.wp('WP-02').lane.worktree;
  mkdirSync(worktree, { recursive: true });
  const reset = build.resetWp(failing.state, { wpId: 'WP-02', to: 'setup', why: 'lockfile committed' }, failing.deps);
  assert.deepEqual([reset.state, reset.stage, reset.queue], ['dispatched', 'brief', ['create/setup']]);
  assert.equal(await drive(failing), null);
  assert.equal(failing.wp('WP-02').state, 'merged');
  const runs = of(failing, 'WP-02').filter((a) => a.part === 'setup');
  assert.deepEqual(runs.map((a) => a.cwd), [worktree, worktree], 'the second setup ran in the worktree create made');
  assert.throws(() => build.resetWp(h.state, { wpId: 'WP-02', to: 'setup', why: 'x' }, h.deps), (error) => error.code === 5 && /is merged; --to setup resets a WP that is blocked/.test(error.message));
});

test('lane setup (H4, council r1): an invalid legacy laneSetup blocks the WP naming it; a pinned workspace laneSetup wins, and a pin without one turns the legacy key off', async (t) => {
  const bad = harness(t, { config: JSON.stringify({ laneSetup: 42 }), wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(bad), null);
  assert.deepEqual([bad.wp('WP-02').state, /laneSetup must be a non-empty command string/.test(bad.wp('WP-02').reason)], ['blocked', true], bad.wp('WP-02').reason);
  assert.ok(!of(bad, 'WP-02').some((a) => a.step === 'start'));
  // Challenge on db3a8f8: blocked before any worktree, the WP goes back to pending once the config is fixed, and runs.
  assert.throws(() => build.resetWp(bad.state, { wpId: 'WP-02', to: 'setup', why: 'x' }, bad.deps), (error) => error.code === 5 && /has no lane worktree to set up/.test(error.message));
  writeFileSync(join(bad.repo, '.workit', 'conduct.json'), JSON.stringify({ laneSetup: 'npm ci' }));
  const back = build.resetWp(bad.state, { wpId: 'WP-02', to: 'pending', why: 'laneSetup fixed' }, bad.deps);
  assert.deepEqual([back.from.state, back.state], ['blocked', 'pending']);
  assert.equal(await drive(bad), null);
  assert.equal(bad.wp('WP-02').state, 'merged');
  assert.ok(of(bad, 'WP-02').some((a) => a.part === 'setup'));
  assert.throws(() => build.resetWp(bad.state, { wpId: 'WP-02', to: 'pending', why: 'x' }, bad.deps), (error) => error.code === 5 && /is merged; --to pending resets a WP that is dropped or blocked/.test(error.message));
  const pinned = harness(t, { config: JSON.stringify({ laneSetup: 'legacy setup' }), wps: [TWO[0], TWO[1]] });
  pinWorkspace(pinned, { laneSetup: 'pnpm install' });
  assert.equal(await drive(pinned), null);
  assert.deepEqual(of(pinned, 'WP-02').filter((a) => a.part === 'setup').map((a) => a.command), [shellArgv('pnpm install', 'linux')]);
  const off = harness(t, { config: JSON.stringify({ laneSetup: 'legacy setup' }), wps: [TWO[0], TWO[1]] });
  pinWorkspace(off, {});
  assert.equal(await drive(off), null);
  assert.ok(!of(off, 'WP-02').some((a) => a.part === 'setup'), 'the pin replaces the legacy file whole');
});

// Deploy-truth probation H3: the repo's laneSuite told lanes to run the full
// database suite against an operator's no-load rule, and nothing in the spec
// could narrow it. The workshop's _orchestrator.md `## Lane suite` wins.
test('lane suite (H3): the spec\'s _orchestrator.md ## Lane suite overrides the repo\'s for this run, in the contract and its recorded source', async (t) => {
  const h = harness(t, { config: JSON.stringify({ laneSuite: 'legacy suite', contractPaths: [] }), gateCommand: 'npm test', wps: [TWO[0], TWO[1]] });
  pinWorkspace(h, {});
  writeFileSync(join(h.repo, 'AGENTS.md'), '## Lane suite\n\nRun the full database suite.\n');
  appendFileSync(join(h.workshopDir, 'work-packages', '_orchestrator.md'), '\n## Lane suite\n\nRun only the named test files;\nno database suite (operator rule: no load on this host).\n');
  const first = await step(h);
  const isolation = Object.entries(first.slots).find(([slot]) => slot.startsWith('<Per-repo lane isolation'))[1];
  assert.equal(isolation, 'Run only the named test files; no database suite (operator rule: no load on this host).');
  assert.match(first.append, /- \*\*Suite ownership \(the spec's `work-packages\/_orchestrator\.md` `## Lane suite`\):\*\* Run only the named test files;/);
  writeFileSync(first.outPath, fillTemplate(first));
  await recordPending(h, {});
  assert.equal(h.state.build.laneSuiteFrom, 'the spec\'s `work-packages/_orchestrator.md` `## Lane suite`');
  // Council r1 on 453b360: the rendered analysis names the spec as the source.
  assert.equal(await drive(h), null);
  await analyzeRun(h.runDir, h.deps);
  assert.match(readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8'), /laneSuite from the spec's `work-packages\/_orchestrator\.md` `## Lane suite`/);
  // A spec that is not deep has no orchestrator: the repo's text stands.
  const lite = harness(t, { depth: 'lite', config: JSON.stringify({ contractPaths: [] }), gateCommand: 'npm test' });
  pinWorkspace(lite, {});
  writeFileSync(join(lite.repo, 'AGENTS.md'), '## Lane suite\n\nRun the full database suite.\n');
  writeFileSync(join(lite.workshopDir, 'work-packages', '_orchestrator.md'), '## Lane suite\n\nignored outside deep\n');
  const contract = await step(lite);
  assert.equal(Object.entries(contract.slots).find(([slot]) => slot.startsWith('<Per-repo lane isolation'))[1], 'Run the full database suite.');
});

test('repo config split (e2b54cd3): a run whose state predates the split keeps the legacy laneSuite even when AGENTS.md has a ## Lane suite', async (t) => {
  const h = harness(t);
  assert.equal(h.state.intent.repoConfig, undefined, 'the harness state is a pre-split state');
  writeFileSync(join(h.repo, 'AGENTS.md'), '## Lane suite\n\nnew rule\n');
  const first = await step(h);
  const isolation = Object.entries(first.slots).find(([slot]) => slot.startsWith('<Per-repo lane isolation'))[1];
  assert.equal(isolation, JSON.parse(fixture('build', 'conduct.json')).laneSuite);
  assert.match(first.append, /Suite ownership \(`\.workit\/conduct\.json` laneSuite\)/);
});

test('repo config split (e2b54cd3): record checks the laneSuite the contract action was built from, not a re-read', async (t) => {
  const h = harness(t, { config: JSON.stringify({ contractPaths: [] }) });
  pinWorkspace(h, {});
  writeFileSync(join(h.repo, 'AGENTS.md'), '## Lane suite\n\nemitted rule\n');
  const first = await step(h);
  assert.deepEqual(first.laneSuite, { text: 'emitted rule', from: 'AGENTS.md `## Lane suite`' });
  // The section is removed after emission: the contract still needs its Run deltas, and provenance stays.
  writeFileSync(join(h.repo, 'AGENTS.md'), '# nothing here\n');
  writeFileSync(first.outPath, fillTemplate({ ...first, append: undefined }));
  await assert.rejects(recordPending(h, {}), { code: 2, message: /declares laneSuite \(AGENTS\.md `## Lane suite`\)/ });
  // A Run deltas heading without the text is refused too (workit#246 review).
  writeFileSync(first.outPath, fillTemplate({ ...first, append: '\n## Run deltas\n\n- something else\n\n## Emitted rule\n\nemitted rule\n' }));
  await assert.rejects(recordPending(h, {}), { code: 2, message: /does not carry the laneSuite text from AGENTS\.md/ });
  // Nor does the text count when it sits only inside a fenced block (workit#246 delta review).
  // Only the emitted Suite ownership line, as a line of the section itself, counts (workit#246 delta reviews):
  // not fenced, not quoted, not under a later heading of any level.
  const line = first.append.split('\n').find((text) => text.startsWith('- **Suite ownership'));
  for (const bypass of [`\`\`\`\n${line}\n\`\`\``, `> ${line}`, `### Artifacts\n\n${line}`, `# Artifacts\n\n${line}`,
    `    ${line}`, `Artifacts\n---------\n${line}`, `Artifacts\n=========\n${line}`]) {
    writeFileSync(first.outPath, fillTemplate({ ...first, append: `\n## Run deltas\n\nArtifact follows:\n\n${bypass}\n` }));
    await assert.rejects(recordPending(h, {}), { code: 2, message: /does not carry the laneSuite text from AGENTS\.md/ }, bypass);
  }
  writeFileSync(first.outPath, fillTemplate(first));
  await recordPending(h, {});
  assert.equal(h.state.build.laneSuiteFrom, 'AGENTS.md `## Lane suite`');
});

test('repo config gateEnv that is not an object of strings blocks the WP at its gate and releases the merge lock', async (t) => {
  const h = harness(t, { config: JSON.stringify({ gateEnv: { OBSERVATORY_TEST_DB: 7 } }), gateCommand: 'npm test', wps: [TWO[0], TWO[1]] });
  await drive(h, { until: (a, hh) => hh.wp('WP-02').state === 'blocked' });
  assert.match(h.wp('WP-02').reason, /gateEnv must be an object of string values/);
  assert.notEqual(h.state.mergeLock?.wpId, 'WP-02');
  assert.ok(!of(h, 'WP-02').some((a) => a.step === 'gate-cmd'));
});

test('shell strings (D18, D19): the gate command is shellArgv on win32 and linux; "human review", empty and a win32 quote are not-exercised; linux runs the quote', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const h = harness(t, { platform, gateCommand: 'node --test', wps: [TWO[0], TWO[1]], notify: true, env: { WORKIT_SPEND_CMD: 'meter', WORKIT_NOTIFY_CMD: 'ping' } });
    assert.equal(await drive(h), null);
    assert.deepEqual(h.trace.find((a) => a.step === 'gate-cmd').command, shellArgv('node --test', platform));
    assert.equal(h.trace.find((a) => a.step === 'gate-cmd').cwd, h.wp('WP-02').lane.worktree);
    // WORKIT_SPEND_CMD meters nothing: no spend read is emitted.
    assert.ok(!h.trace.some((a) => a.command?.[0] === 'meter' || a.command?.join(' ').includes('meter ')), platform);
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
  h.patchId = () => ((calls += 1) <= 2 ? String(calls).repeat(40) : 'f'.repeat(40));
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
  // f424b70b: the amendment's start is recorded for the land gate's gate-fix tail.
  const wp = h.wp('WP-02');
  assert.deepEqual(wp.gateFixes.map((fix) => fix.from), [wp.rebases.at(-1).to]);
  assert.equal(wp.amendment.since, wp.rebases.at(-1).to);
});

test('gate command after a no-op rebase: the amended head gets its delta review (the fixed land.mjs predicate), never a block', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.gateCmdCode = { 'WP-02': [1] };
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  h.answer = (a) => (a.part === 'post-heads' ? ok(`${h.head(a.wpId)}\n${'e'.repeat(40)}\n`) : undefined);
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged', h.wp('WP-02').reason);
  assert.equal(h.wp('WP-02').rebases[0].from, h.wp('WP-02').rebases[0].to, 'the first rebase was a no-op');
  const posts = of(h, 'WP-02').filter((a) => a.step === 'post');
  assert.deepEqual(posts.map((a) => [a.land.round, a.land.scope]), [[1, 'full'], [2, 'delta']]);
  // f424b70b: the gate amendment's range runs from the failed head to the head its lane pushed.
  const [fix] = h.wp('WP-02').gateFixes;
  assert.ok(fix.to && fix.to !== fix.from, JSON.stringify(fix));
});

// Quest 1b3dec9f: the conductor's visual read at the merge gate, end to end.
test('visual read (1b3dec9f): a UI WP\'s passing gate asks for a read of its frames; a malformed read is refused, a failed rule is a gate amendment, and the fixed head merges after a clean read', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  const frame = join(h.runDir, 'lane-wp-02-target.png');
  writeFileSync(frame, 'png');
  h.state.design = { source: join(h.workshopDir, 'work-packages', '_orchestrator.md'), rules: [{ n: 1, text: '**Palette:** ink and copper' }, { n: 2, text: '**Type scale:** 11/13/20' }, { n: 4, text: '**Fit to view:** the floor fills the canvas' }] };
  h.wp('WP-02').visualRules = [1, 4];
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  const reads = [];
  h.answer = (a) => {
    if (a.part !== 'visual') return undefined;
    reads.push(a);
    return { head: a.land.head, frames: [frame], rules: { 1: 'pass', 4: reads.length === 1 ? 'fail: the floor fills half the width' : 'pass' } };
  };
  h.wp('WP-02').skills = ['frontend-design:frontend-design'];
  const first = await drive(h, { until: (a) => a.part === 'visual' });
  // Council r1: the brief renders both new slots.
  const brief = readFileSync(of(h, 'WP-02').find((a) => a.step === 'brief' && a.part === 'brief').outPath, 'utf8');
  assert.match(brief, /^\*\*Skills to load with the Skill tool before you build:\*\* frontend-design:frontend-design\.$/m);
  assert.match(brief, /^\*\*Visual rules:\*\* 1, 4 of .*_orchestrator\.md\. When this names rules/m);
  assert.ok(!/<skills>|<visual rules>/.test(brief), 'no slot left unfilled');
  assert.equal(first.kind, 'inspect');
  assert.deepEqual(first.rules.map((rule) => rule.n), [1, 4], 'only the WP\'s rules, with their text');
  assert.equal(h.wp('WP-02').gate.ok, false, 'a gate owing its visual read is not ok');
  assert.ok(!h.trace.some((a) => a.step === 'merge'));
  // Refused with exit 2 and nothing written: a missing rule, a frame that is not there.
  assert.throws(() => build.record(h.state, first, { head: first.land.head, frames: [frame], rules: { 1: 'pass' } }, h.deps), (error) => error.code === 2 && /missing 4/.test(error.message));
  assert.throws(() => build.record(h.state, first, { head: first.land.head, frames: [join(h.runDir, 'absent.png')], rules: { 1: 'pass', 4: 'pass' } }, h.deps), (error) => error.code === 2 && /no frame at/.test(error.message));
  assert.equal(h.wp('WP-02').visualReads, undefined);

  assert.equal(await drive(h), null);
  const wp = h.wp('WP-02');
  assert.equal(wp.state, 'merged', wp.reason);
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0].land.head, reads[1].land.head, 'the second read is of the amended head');
  assert.match(wp.gateFixes[0].reason, /^visual read at [0-9a-f]{40}: rule 4 fail: the floor fills half the width$/);
  const amendment = of(h, 'WP-02').find((a) => a.part === 'amendment');
  assert.match(amendment.instruction, /rule 4 fail: the floor fills half the width/);
  assert.deepEqual(wp.visualReads.map((read) => read.rules), [{ 1: 'pass', 4: 'fail: the floor fills half the width' }, { 1: 'pass', 4: 'pass' }]);
  const merge = indexWhere(h, (a) => a.wpId === 'WP-02' && a.step === 'merge');
  assert.ok(merge > h.trace.indexOf(reads[1]), 'the merge follows the clean read');
  await analyzeRun(h.runDir, h.deps);
  const analysis = readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  assert.match(analysis, /^## Visual reads$/m);
  assert.match(analysis, /^- WP-02 at [0-9a-f]{7}: fail; pass 1; fail 4 \(the floor fills half the width\) \(frames: .*lane-wp-02-target\.png\)$/m);
  assert.match(analysis, /^- WP-02 at [0-9a-f]{7}: pass; pass 1, 4 \(frames: /m);
});

test('lane brief (1b3dec9f, council r1): a WP naming no skills and no visual rules renders "none" in both slots', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  await drive(h, { until: (a) => a.step === 'prompt' });
  const brief = readFileSync(of(h, 'WP-02').find((a) => a.step === 'brief' && a.part === 'brief').outPath, 'utf8');
  assert.match(brief, /^\*\*Skills to load with the Skill tool before you build:\*\* none\.$/m);
  assert.match(brief, /^\*\*Visual rules:\*\* none\. /m);
});

// The harness's git answers every ancestry and patch check, so the mapped
// baseline here is the harness's; delta-recovery.test.mjs maps it in real git.
test('gate command after a rebase that moved the head: the gate fix gets a delta review from the verified baseline, never a block', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.gateCmdCode = { 'WP-02': [1] };
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  assert.equal(await drive(h), null);
  const wp = h.wp('WP-02');
  assert.equal(wp.state, 'merged', wp.reason);
  const [rebase] = wp.rebases;
  assert.notEqual(rebase.from, rebase.to, 'the first rebase moved the head');
  assert.equal(wp.reviews[0].head, rebase.from, 'the full review predates the rebase');
  const mapped = h.events().find((e) => e.event === 'delta-baseline-mapped' && e.data.wpId === 'WP-02');
  assert.ok(mapped, 'the rebased baseline is verified before the delta review');
  const posts = of(h, 'WP-02').filter((a) => a.step === 'post');
  assert.deepEqual(posts.map((a) => [a.land.round, a.land.scope, a.land.since ?? null]), [[1, 'full', null], [2, 'delta', mapped.data.baseline]]);
  assert.equal(wp.deltaFrom, null, 'land clears the delta boundary');
});

test('tier from the recipe file (D17): contractPaths raise T1 to T2; a test file alone stays T1; WP-00 at depth none too', async (t) => {
  const cases = [['scripts/lane.mjs\n', 'T2'], ['lib/x.test.mjs\n', 'T1'], ['hooks/PreToolUse.js\n', 'T1'], ['lib/x.mjs\n', 'T1']];
  for (const [diff, tier] of cases) {
    const h = harness(t, { council: true, wps: [TWO[0], TWO[1]] });
    h.diff = { 'WP-02': diff };
    const first = await drive(h, { until: (a) => a.wpId === 'WP-02' && (a.part === 'meta' || a.part === 'managed') });
    assert.equal(first.part, tier === 'T2' ? 'meta' : 'managed', diff);
    assert.equal(h.wp('WP-02').tier, tier);
    const decision = h.events().find((event) => event.event === 'tier-classified' && event.data.wpId === 'WP-02');
    assert.equal(decision?.data.tier, tier);
    assert.ok(decision?.data.rule, 'the run record names the matched rule, including no-match');
  }
  const none = harness(t, { depth: 'none', council: true });
  none.diff = { 'WP-00': 'test/x.test.mjs\nscripts/lane.mjs\n' };
  const first = await drive(none, { until: (a) => a.part === 'meta' || a.part === 'managed' });
  assert.equal(first.part, 'meta');
  assert.equal(none.wp('WP-00').tier, 'T2');
  // A declared T0 is reviewed once a test file changes: T1, the slim review, never straight to land.
  const t0 = harness(t, { council: true, wps: [TWO[0], { ...TWO[1], tier: 'T0' }] });
  t0.diff = { 'WP-02': 'lib/x.test.mjs\n' };
  const t0First = await drive(t0, { until: (a) => a.wpId === 'WP-02' && (a.part === 'meta' || a.part === 'managed' || a.step === 'rebase' || a.step === 'merge') });
  assert.equal(t0First.part, 'managed', `a test-only T0 takes the slim review, got ${t0First.step}/${t0First.part}`);
  assert.equal(t0.wp('WP-02').tier, 'T1');
  const testOnly = harness(t, { depth: 'none', council: true });
  testOnly.diff = { 'WP-00': 'test/x.test.mjs\n' };
  const slim = await drive(testOnly, { until: (a) => a.part === 'meta' || a.part === 'managed' });
  assert.equal(slim.part, 'managed', 'a test-only WP-00 takes the slim review');
  assert.equal(testOnly.wp('WP-00').tier, 'T1');
});

test('settings tier signal compares only the claude-config hooks block', () => {
  const state = { intent: { repo: { remote: 'sirmaelstrom/claude-config', defaultBranch: 'main' } } };
  const wp = { lane: { worktree: 'repo' } };
  const previous = { hooks: { PreToolUse: [{ command: 'node scripts/check-write.mjs' }] }, theme: 'old' };
  const deps = { exec: () => ok(JSON.stringify(previous)), read: () => JSON.stringify({ ...previous, theme: 'new' }) };
  assert.equal(build.hooksBlockChanged(state, wp, ['settings.json'], deps), false);
  deps.read = () => JSON.stringify({ ...previous, hooks: { PostToolUse: [{ command: 'node scripts/check-write.mjs' }] } });
  assert.equal(build.hooksBlockChanged(state, wp, ['settings.json'], deps), true);
  assert.equal(build.hooksBlockChanged({ intent: { repo: { remote: 'other/repo' } } }, wp, ['settings.json'], deps), false);
});

test('two delta P1/P2 findings route the amended whole PR to a T2 council', async (t) => {
  const h = resetFixture(t, { council: true });
  const wp = h.wp('WP-02');
  const fullHead = sha('a', 2);
  const deltaHead = sha('c', 2);
  Object.assign(wp, {
    state: 'pr', stage: 'delta', tier: 'T2', pr: { number: 102, head: deltaHead },
    reviews: [
      { round: 1, scope: 'full', tier: 'T1', head: fullHead, findings: 3 },
      { round: 2, scope: 'delta', tier: 'T1', head: deltaHead, findings: 2, majorFindings: 2 },
    ],
    deltaEscalation: { round: 2, head: deltaHead, majorFindings: 2 },
  });
  h.diff = { 'WP-02': 'lib/x.mjs\n' };
  const next = await drive(h, { until: (action) => action.wpId === 'WP-02' && action.part === 'meta' });
  assert.equal(next.part, 'meta');
  const council = of(h, 'WP-02').find((action) => action.tool === 'council_review');
  assert.equal(council, undefined, 'the council follows the metadata step');
  assert.deepEqual(wp.deltaEscalation, { round: 2, head: deltaHead, majorFindings: 2 });
  assert.equal(wp.tier, 'T2');
  await recordPending(h, await perform(h, next));
  const round = await drive(h, { until: (action) => action.tool === 'council_review' });
  assert.equal(round.args.round, 3);
  assert.equal(round.land.scope, 'full');
});

test('a posted delta receipt flows through amendment, checks, council, record, and gate', async (t) => {
  const h = harness(t, { council: true, wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [3, 2] };
  h.deltaMajor = { 'WP-02': [2] };
  h.reports = { 'WP-02': ['report-built.md', 'report-amendment.md', 'report-amendment-2.md'] };
  h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
  const countAction = await drive(h, { until: (a) => a.step === 'review' && a.part === 'delta-count' });
  assert.ok(countAction, JSON.stringify(h.wp('WP-02')));
  assert.ok(h.wp('WP-02').deltaEscalation, JSON.stringify(h.wp('WP-02')));
  await recordPending(h, await perform(h, countAction));
  assert.equal(h.wp('WP-02').stage, 'delta', JSON.stringify({ stage: h.wp('WP-02').stage, escalation: h.wp('WP-02').deltaEscalation, queue: h.wp('WP-02').queue }));
  assert.equal(await drive(h), null);
  const actions = of(h, 'WP-02');
  const delta = actions.findIndex((action) => action.step === 'post' && action.land.scope === 'delta');
  const amendment = actions.findIndex((action, index) => index > delta && action.step === 'brief' && action.part === 'amendment');
  const council = actions.findIndex((action) => action.tool === 'council_review' && action.land.scope === 'full');
  const record = actions.findIndex((action) => action.step === 'reply' && action.part === 'record');
  const gate = actions.findIndex((action) => action.step === 'gate' && action.part === 'gate');
  assert.ok(delta >= 0 && amendment > delta && council > amendment && record > council && gate > record, JSON.stringify({ indexes: [delta, amendment, council, record, gate], state: h.wp('WP-02').state, reason: h.wp('WP-02').reason, trace: actions.slice(-25).map((a) => `${a.step}/${a.part ?? a.land?.scope ?? ''}`), reviews: h.wp('WP-02').reviews }));
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(h.wp('WP-02').reviews.some((review) => review.escalatedDeltaReviewId === 7002 && review.record?.url), true);
});

test('ROUND 2 RED: failed council record recovers at gate without a lane amendment', async (t) => {
  for (const firstPost of [{ code: 1, stdout: '', stderr: 'HTTP 502' }, ok('{}')]) {
    const h = harness(t, { council: true, wps: [TWO[0], TWO[1]] });
    h.findings = { 'WP-02': [3, 2] };
    h.deltaMajor = { 'WP-02': [2] };
    h.reports = { 'WP-02': ['report-built.md', 'report-amendment.md', 'report-amendment-2.md'] };
    h.amendDiff = { 'WP-02': 'lib/lanes.mjs\n' };
    h.recordPosts = [firstPost, ok(JSON.stringify({ html_url: 'https://github.com/o/r/pull/102#pullrequestreview-9004' }))];
    assert.equal(await drive(h), null);
    const actions = of(h, 'WP-02');
    assert.equal(actions.filter((action) => action.step === 'reply' && action.part === 'record').length, 2);
    assert.equal(actions.filter((action) => action.step === 'brief' && action.part === 'amendment').length, 2, 'the lane is not asked to repair a GitHub post');
    assert.equal(h.wp('WP-02').state, 'merged');
  }
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
  assert.deepEqual(h.trace.filter((a) => a.step === 'receipt').map((a) => [a.tool, a.args.questId]), [['spine_receipt', QUEST('WP-02')], ['spine_update', QUEST('WP-02')]]);
  assert.deepEqual(h.trace.find((a) => a.tool === 'spine_update' && a.step === 'receipt').args, { questId: QUEST('WP-02'), workState: 'done', horizon: 'landed' });
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
  // The third read's record already sees the pid dead (pidAlive false): affirmative evidence.
  assert.equal(polls, 3, 'polled until the pid was gone');
  assert.ok(h.events().some((e) => e.event === 'liveness-uncertain' && e.data.owner === 'unverified'));
  assert.equal(h.wp('WP-02').state, 'merged');
});

// ---- amendment 1 (council round 1 on #156) ----

const aliveOf = (a) => a.kind === 'shell' && a.command?.[1]?.endsWith('conduct.mjs') && a.command[2] === 'lane' && a.command[3] === 'alive';
const pendingAfter = async (h, result) => {
  h.trace.at(-1) !== h.state.pending && h.trace.push(h.state.pending);
  await recordPending(h, result);
};

test('liveness (C1-1): unparseable or empty `lane alive` output on a wait keeps the slot and polls again', async (t) => {
  for (const stdout of ['not json', '']) {
    const h = harness(t, { wps: [TWO[0], TWO[1]] });
    h.life = { 'WP-02': 5 };
    await drive(h, { until: (a) => aliveOf(a) && a.wpId === 'WP-02' });
    await pendingAfter(h, { code: 1, stdout, stderr: '' });
    assert.equal(h.wp('WP-02').lane.exitedAt ?? null, null, `${JSON.stringify(stdout)}: still occupying`);
    const again = await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
    assert.ok(aliveOf(again), `${JSON.stringify(stdout)}: polled again, not checked (${again.step}/${again.part})`);
  }
});

test('liveness (5c93c8cb): a reap that exits 1 while the old agent pid is reused is recorded, never read as liveness', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  const reap = await drive(h, { until: (a) => a.wpId === 'WP-02' && a.part === 'reap' });
  assert.ok(reap, 'the exec lane exit queues a reap');
  h.lifeByPid.set(4202, 9);
  await pendingAfter(h, { code: 1, stdout: JSON.stringify({ ok: false, state: 'survivors', orphans: [{ pid: 9, cmd: 'x' }], survivors: [{ pid: 9, cmd: 'x' }] }), stderr: '' });
  assert.deepEqual([h.wp('WP-02').lane.reap?.state, h.wp('WP-02').lane.uncertain ?? 0], ['survivors', 0]);
  const next = await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
  assert.notEqual(next.part, 'reap', 'the build moves on; the reap is not re-asked as a liveness read');
});

test('liveness (C1-1): unparseable output on a stop probe and on a stop confirmation keeps the slot and asks again', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.life = { 'WP-02': 9 };
  await drive(h, { until: (a) => aliveOf(a) && a.wpId === 'WP-02' });
  h.tick(121 * 60000);
  await pendingAfter(h, await perform(h, h.state.pending));
  assert.equal(h.wp('WP-02').reason, 'lane deadline');
  const probe = await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'stop' });
  assert.equal(probe.part, 'probe');
  await pendingAfter(h, { code: 1, stdout: '{"ok":tru', stderr: '' });
  assert.equal(h.wp('WP-02').lane.exitedAt ?? null, null, 'probe: still occupying');
  assert.equal((await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) })).part, 'probe', 'probe: asked again');
  const confirm = await drive(h, { until: (a) => a.wpId === 'WP-02' && a.part === 'confirm' });
  await pendingAfter(h, { code: 1, stdout: '', stderr: '' });
  assert.equal(h.wp('WP-02').lane.exitedAt ?? null, null, 'confirm: still occupying');
  const next = await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
  assert.equal(next.part, 'confirm', 'confirm: asked again');
  assert.ok(confirm);
});

test('liveness (C1-1, split 4): past the deadline the third uncertain read blocks the WP visibly, slot held and stop queued', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.life = { 'WP-02': 9 };
  await drive(h, { until: (a) => aliveOf(a) && a.wpId === 'WP-02' });
  h.tick(121 * 60000);
  for (let read = 1; read <= 3; read += 1) {
    if (read > 1) await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
    assert.ok(aliveOf(h.state.pending), `read ${read} is a poll`);
    await pendingAfter(h, { code: 1, stdout: JSON.stringify({ ok: true, alive: false, pid: 4202, owner: 'unverified' }), stderr: '' });
  }
  const wp = h.wp('WP-02');
  assert.equal(wp.state, 'blocked');
  assert.match(wp.reason, /lane liveness unverifiable past the deadline: 3 reads/);
  assert.equal(wp.lane.exitedAt ?? null, null, 'the slot is held');
  assert.deepEqual(wp.queue.map((a) => `${a.kind}/${a.step}/${a.part ?? ''}`), ['shell/stop/probe'], 'the stop stays queued');
  assert.equal(h.state.touches.at(-1).build, 'liveness');
  // The block is the visible stop: no more polling, no repeated block event.
  const from = h.trace.length;
  await drive(h, { until: () => h.trace.length >= from + 6 });
  assert.ok(!h.trace.slice(from).some((a) => a.wpId === 'WP-02'), 'nothing more is emitted for WP-02');
  assert.equal(h.events().filter((e) => e.event === 'wp-state' && e.data.wpId === 'WP-02' && /liveness unverifiable/.test(e.data.reason ?? '')).length, 1);
  // The operator's (a) is the release: the slot frees, the state stays.
  h.state.pending = null;
  h.trace.pop();
  answerCore(h, h.state.touches.length, 'a');
  assert.equal(await drive(h), null);
  assert.ok(h.wp('WP-02').lane.exitedAt);
  assert.equal(h.wp('WP-02').state, 'blocked');
});

test('liveness (C2-9): only reads past the deadline count; the block comes on the third of them', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.life = { 'WP-02': 20 };
  const unverified = { code: 1, stdout: JSON.stringify({ ok: true, alive: false, pid: 4202, owner: 'unverified' }), stderr: '' };
  await drive(h, { until: (a) => aliveOf(a) && a.wpId === 'WP-02' });
  for (let read = 1; read <= 2; read += 1) {
    if (read > 1) await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
    await pendingAfter(h, unverified);
  }
  assert.equal(h.wp('WP-02').lane.uncertain, 0, 'pre-deadline reads do not count');
  h.tick(121 * 60000);
  for (let read = 1; read <= 3; read += 1) {
    await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
    assert.ok(aliveOf(h.state.pending), `post-deadline read ${read} is a poll`);
    await pendingAfter(h, unverified);
    assert.equal(h.wp('WP-02').state === 'blocked', read === 3, `read ${read}`);
  }
});

test('liveness (C2-9): an uncertain stop read on a terminal WP sets wps[].cleanup and leaves its state', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  assert.equal(await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'merged' }) !== null, true);
  await pendingAfter(h, await perform(h, h.state.pending));
  const wp = h.wp('WP-02');
  assert.equal(wp.state, 'merged');
  // The lane turns out not to be observed exited, past its deadline.
  Object.assign(wp.lane, { exitedAt: null, deadline: new Date(T0 - 60000).toISOString() });
  wp.queue = [];
  h.life = { 'WP-02': 9 };
  h.lifeByPid.set(4202, 9);
  for (let read = 1; read <= 3; read += 1) {
    const probe = await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
    assert.equal(probe.part, 'probe');
    await pendingAfter(h, { code: 1, stdout: 'not json', stderr: '' });
  }
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.match(h.wp('WP-02').cleanup, /lane liveness unverifiable past the deadline: 3 reads \(unparseable lane alive output\)/);
  assert.equal(h.wp('WP-02').lane.exitedAt ?? null, null);
});

test('liveness (C2-9): an error read between uncertain reads does not reset the count', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'merged' });
  await pendingAfter(h, await perform(h, h.state.pending));
  const wp = h.wp('WP-02');
  Object.assign(wp.lane, { exitedAt: null, deadline: new Date(T0 - 60000).toISOString() });
  wp.queue = [];
  h.lifeByPid.set(4202, 9);
  const reads = [{ code: 1, stdout: 'not json', stderr: '' }, { code: 1, stdout: 'not json', stderr: '' }, { code: 2, stdout: '', stderr: 'lane alive: usage' }, { code: 1, stdout: 'not json', stderr: '' }];
  for (const read of reads) {
    await drive(h, { until: (a) => a.wpId === 'WP-02' && !isWait(a) });
    await pendingAfter(h, read);
  }
  assert.equal(h.wp('WP-02').lane.uncertain, 3);
  assert.match(h.wp('WP-02').cleanup, /3 reads/);
});

test('gate cap (C1-2): the third gate-driven amendment blocks the WP with the last gate cause as its reason', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.declineRecover = true;
  h.gateCmdCode = { 'WP-02': [1, 1, 1] };
  assert.equal(await drive(h), null);
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'amendment').length, 2);
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.match(h.wp('WP-02').reason, /^the gate command exited 1 at the rebased head: gate output \(after 2 gate amendments\)$/);
});

// ---- deploy-truth probation H12 and H17 (quests 8710f724, 6f3a6194) ----

const gateEnvOut = (name) => ({ stdout: fixture('gate-env', `${name}.out`), stderr: existsSync(join(FIXTURES, 'gate-env', `${name}.err`)) ? fixture('gate-env', `${name}.err`) : '' });
// The land rebase finds the base where it was, so the head does not move.
const keepHead = (h) => (a) => (a.step === 'rebase' && a.part === 'post-heads' ? ok(`${h.head(a.wpId)}\n${'e'.repeat(40)}\n`) : undefined);
const missingCheck = (h, id) => ({ code: 5, stderr: '', stdout: JSON.stringify({ ok: false, pending: false, blocked: false, head: h.head(id),
  failures: ['expected check missing at head: db-tests'], causes: ['ci-missing-check'], door: 'two-way', doorProblems: [] }) });
const gateCmds = (h, id) => of(h, id).filter((a) => a.step === 'gate-cmd' && a.part === 'gate-cmd');

test('H12 (8710f724): a land reset at the head whose gate command passed reuses the pass; a changed command or a moved head runs the suite again', async (t) => {
  const landTwice = async (change = () => {}, before = () => {}) => {
    const h = harness(t, { wps: [TWO[0], TWO[1]] });
    h.answer = keepHead(h);
    before(h);
    // The suite passes; the land gate then blocks on a check the PR does not get.
    await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'gate' && a.part === 'gate' });
    await recordPending(h, missingCheck(h, 'WP-02'));
    assert.equal(h.wp('WP-02').state, 'blocked');
    change(h);
    build.resetWp(h.state, { wpId: 'WP-02', to: 'land', why: 'ci-checks audit,verify declared for this head' }, h.deps);
    assert.equal(await drive(h), null);
    assert.equal(h.wp('WP-02').state, 'merged');
    return h;
  };
  const same = await landTwice();
  assert.equal(gateCmds(same, 'WP-02').length, 1, 'the suite ran once: the re-land reused its pass at the same head');
  const reused = same.events().filter((e) => e.step === 'gate-cmd' && e.event === 'gate-cmd-reused');
  assert.deepEqual(reused.map((e) => e.data.head), [same.head('WP-02')]);
  const command = await landTwice((h) => writeFileSync(join(h.workshopDir, 'work-packages', '_orchestrator.md'), '# Orchestrator\n\n## Gate Commands\n\nWave 2: node --test\n'));
  assert.equal(gateCmds(command, 'WP-02').length, 2, 'a changed gate command runs again');
  const moved = await landTwice((h) => { h.answer = undefined; });
  assert.equal(gateCmds(moved, 'WP-02').length, 2, 'a rebase that moves the head runs again');
  // Council r1 L7: a changed gateEnv is a changed key.
  const env = await landTwice((h) => writeFileSync(join(h.repo, '.workit', 'conduct.json'), JSON.stringify({ ...JSON.parse(fixture('build', 'conduct.json')), gateEnv: { DB: 'other' } })));
  assert.equal(gateCmds(env, 'WP-02').length, 2, 'a changed gateEnv runs again');
  // Council r1 M1: a suite that ends with uncommitted changes in the worktree records no pass.
  const dirty = await landTwice(() => {}, (h) => h.rules.unshift([/^git -C \S+ status --porcelain$/, () => ok(' M src/fix.mjs\n')]));
  assert.equal(gateCmds(dirty, 'WP-02').length, 2, 'a pass from a dirty worktree is not reused');
  assert.equal(dirty.wp('WP-02').gateCmdPass ?? null, null);
});

test('H12 (8710f724, council r1 U3): a land gate that passes at another head than the reused pass sends the WP back to run the suite', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  const keep = keepHead(h);
  let reused = false;
  h.answer = (a) => {
    // After the reuse, the land gate reports a head the suite never ran at.
    if (reused && a.wpId === 'WP-02' && a.step === 'gate' && a.part === 'gate') {
      reused = false;
      return ok(JSON.stringify({ ok: true, pending: false, pendingOn: [], blocked: false, head: sha('f', 2), failures: [], causes: [], door: 'two-way', doorProblems: [] }));
    }
    return keep(a);
  };
  await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'gate' && a.part === 'gate' });
  await recordPending(h, missingCheck(h, 'WP-02'));
  build.resetWp(h.state, { wpId: 'WP-02', to: 'land', why: 'ci-checks declared' }, h.deps);
  h.onEmit = (a) => { if (a.wpId === 'WP-02' && a.step === 'gate' && h.wp('WP-02').gateCmd?.state === 'reused') reused = true; };
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(gateCmds(h, 'WP-02').length, 2, 'the suite ran again for the head the gate passed at');
});

test('H17 (6f3a6194, council r1 M2, M3): no recover touch for a WP blocked outside its gate, or one whose squash already landed', async (t) => {
  // The gate amendment's lane fails its check twice: blocked in the lane, not at the gate.
  const lane = harness(t, { wps: [TWO[0], TWO[1]] });
  lane.gateCmdCode = { 'WP-02': [1] };
  lane.reports = { 'WP-02': ['report-built.md', 'report-no-verdict.md', 'report-no-verdict.md'] };
  assert.equal(await drive(lane), null);
  assert.match(lane.wp('WP-02').reason, /^check failed again after an amendment/);
  assert.deepEqual([lane.state.phase, lane.state.touches.length], ['release', 0]);
  // The squash landed and the merge-commit read failed.
  const squashed = harness(t, { wps: [TWO[0], TWO[1]] });
  squashed.answer = (a) => (a.step === 'merge' && a.part === 'merge-commit' ? ok('{}') : undefined);
  assert.equal(await drive(squashed), null);
  assert.deepEqual([squashed.wp('WP-02').state, squashed.wp('WP-02').squashed, squashed.state.touches.length], ['blocked', true, 0]);
});

test('H17 (6f3a6194): a gate command whose every failure is a timeout retries after a quiet-host probe, not as a gate amendment; one assertion failure among the timeouts still amends', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.gateCmdCode = { 'WP-02': [1, 1, 0] };
  h.gateCmdOut = { 'WP-02': [gateEnvOut('vitest-timeouts'), gateEnvOut('node-timeouts')] };
  // Busy at the first probe; quiet after a wait.
  h.quiet = [{ code: 1, stdout: JSON.stringify({ quiet: false, busy: [95, 90, 40], maxBusy: 30 }), stderr: '' }];
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'amendment').length, 0, 'no gate amendment');
  assert.equal(gateCmds(h, 'WP-02').length, 3);
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'quiet').length, 3, 'a busy probe, a re-probe after its wait, a probe before the second retry');
  const retries = h.events().filter((e) => e.event === 'gate-env-retry');
  assert.deepEqual(retries.map((e) => [e.data.runner, e.data.failures, e.data.n]), [['vitest', 2, 1], ['node', 3, 1]]);

  const mixed = harness(t, { wps: [TWO[0], TWO[1]] });
  mixed.gateCmdCode = { 'WP-02': [1, 0] };
  mixed.gateCmdOut = { 'WP-02': [gateEnvOut('vitest-mixed')] };
  assert.equal(await drive(mixed), null);
  assert.equal(of(mixed, 'WP-02').filter((a) => a.part === 'amendment').length, 1, 'the assertion failure is the lane\'s to fix');
  assert.ok(!of(mixed, 'WP-02').some((a) => a.part === 'quiet'));
});

test('H17 (6f3a6194): environment retries are bounded per head: the third all-timeout failure at one head is a gate amendment', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.answer = keepHead(h);
  h.gateCmdCode = { 'WP-02': [1, 1, 1, 0] };
  h.gateCmdOut = { 'WP-02': [1, 2, 3].map(() => gateEnvOut('vitest-timeouts')) };
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'amendment').length, 1);
  assert.match(h.wp('WP-02').gateFixes[0].reason, /every failure a timeout, after 2 environment retries at this head/);
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'quiet').length, 2);
  // Council r1 U4: the probe outlasts a foreground shell.
  assert.ok(of(h, 'WP-02').filter((a) => a.part === 'quiet').every((a) => a.background === true));

  // Council r1 M5: each retry rebases; a base that moves every time still stops at 4 per WP.
  const moving = harness(t, { wps: [TWO[0], TWO[1]] });
  moving.gateCmdCode = { 'WP-02': [1, 1, 1, 1, 1, 0] };
  moving.gateCmdOut = { 'WP-02': [1, 2, 3, 4, 5].map(() => gateEnvOut('vitest-timeouts')) };
  assert.equal(await drive(moving), null);
  assert.equal(of(moving, 'WP-02').filter((a) => a.part === 'quiet').length, 4);
  assert.match(moving.wp('WP-02').gateFixes[0].reason, /every failure a timeout, after 4 environment retries for WP-02/);
});

test('H17 (6f3a6194, council r1 S2): a WP probing a busy host for ~48 minutes raises no stall alarm', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.gateCmdCode = { 'WP-02': [1, 0] };
  h.gateCmdOut = { 'WP-02': [gateEnvOut('vitest-timeouts')] };
  const busy = { code: 1, stdout: JSON.stringify({ quiet: false, busy: [95, 90, 90], maxBusy: 30 }), stderr: '' };
  h.quiet = [busy, busy, busy, busy, busy, busy];
  // Each probe samples for 3 minutes and its wait is 5 more.
  h.onPerform = (a) => { if (a.part === 'quiet') h.tick(8 * 60000); };
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'quiet').length, 6);
  assert.deepEqual(h.events().filter((e) => e.event === 'stalled').map((e) => e.data.wpId), []);
  assert.ok(h.events().some((e) => e.event === 'quiet-not-reached' && e.data.probes === 6));
});

test('H17 (6f3a6194): a WP blocked at its gate holds the build on a recover touch instead of ending it; (a) re-lands it and its deferred dependent follows; (b) ends the build', async (t) => {
  const wps = [TWO[0], TWO[1], { id: 'WP-03', files: ['lib/land.mjs'], dependsOn: ['WP-02'] }];
  const h = harness(t, { wps });
  h.gateCmdCode = { 'WP-02': [1, 1, 1] };
  const held = await drive(h, { until: (a) => a.step === 'touch' });
  assert.ok(held, 'the build ended without a recover touch');
  assert.deepEqual([h.state.phase, h.wp('WP-02').state, h.wp('WP-03').state], ['build', 'blocked', 'deferred']);
  const touch = h.state.touches.at(-1);
  assert.deepEqual([touch.wpId, touch.build], ['WP-02', 'recover']);
  assert.match(touch.question, /WP-02 is blocked at its gate: the gate command exited 1 at the rebased head: gate output \(after 2 gate amendments\)/);
  assert.match(touch.question, /WP-03 waits on it/);
  h.state.pending = null;
  answerCore(h, touch.n, 'a');
  assert.equal(await drive(h), null);
  assert.deepEqual(h.state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
  assert.deepEqual(h.events().filter((e) => e.event === 'wp-reset').map((e) => [e.data.wpId, e.data.to, e.source, e.data.undeferred]), [['WP-02', 'land', 'touch', ['WP-03']]]);

  const ended = harness(t, { wps });
  ended.gateCmdCode = { 'WP-02': [1, 1, 1] };
  await drive(ended, { until: (a) => a.step === 'touch' });
  ended.state.pending = null;
  answerCore(ended, ended.state.touches.at(-1).n, 'b');
  assert.equal(await drive(ended), null);
  assert.deepEqual([ended.state.phase, ended.wp('WP-02').state, ended.wp('WP-03').state, ended.state.touches.length], ['release', 'blocked', 'deferred', 1]);
});

test('no CI at head (C1-2): with CI the gate waits out the window, then blocks "CI did not complete at head"; with none it blocks at once; never an amendment', async (t) => {
  const noRuns = [/^gh api repos\/o\/r\/commits\/\w+\/check-runs/, () => ({ code: 1, stdout: '', stderr: 'gh: No commit found for SHA (HTTP 422)' })];
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.declineRecover = true;
  h.rules.unshift(noRuns);
  h.onPerform = (a) => { if (a.part === 'gate') h.tick(10 * 60000); };
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.equal(h.wp('WP-02').reason, 'CI did not complete at head');
  assert.ok(!h.trace.some((a) => a.part === 'amendment'));
  assert.equal(h.trace.filter((a) => a.part === 'gate').length, 4, 'gated at 0, 10, 20 and 30 minutes');
  assert.equal(h.state.mergeLock, null);
  const none = harness(t, { wps: [TWO[0], TWO[1]] });
  none.declineRecover = true;
  none.state.intent.ciWorkflows = 0;
  none.rules.unshift(noRuns);
  assert.equal(await drive(none), null);
  assert.match(none.wp('WP-02').reason, /no CI workflow/);
  assert.equal(none.trace.filter((a) => a.part === 'gate').length, 1);
});

test('budget before amendment prompts (C1-2, C1-5): an over-budget amendment is not prompted; (a) needs "budget <USD>" above spend', async (t) => {
  // The lane's closed cost is booked and projected for the live lane again: the amendment's prompt crosses $1.5.
  const h = harness(t, { wps: [TWO[0], TWO[1]], budget: 1.5 });
  h.gateCmdCode = { 'WP-02': [1] };
  await drive(h, { until: (a) => a.part === 'announce' });
  const brief = of(h, 'WP-02').find((a) => a.part === 'amendment');
  assert.ok(brief);
  assert.ok(!of(h, 'WP-02').slice(of(h, 'WP-02').indexOf(brief)).some((a) => a.step === 'prompt'), 'not prompted while over budget');
  const spend = h.state.touches[0].spendUsd;
  assert.ok(spend >= 1.5, String(spend));
  assert.match(h.state.touches[0].question, /committed \(.*\) against the \$1\.5 budget \(unmetered: booked is the lane-only lower bound\)/);
  assert.equal(h.state.touches[0].allowFreeText, true);
  assert.match(h.state.touches[0].question, /\(b\) no new paid lane work \(no dispatch, lane start, prompt or fallback\); work already at a PR boundary may still be reviewed and landed/);
  const refusals = [[null, /needs the text "budget <USD>"/], ['budget 1', new RegExp(`above the current spend of \\$${String(spend).replace('.', '\\.')}`)], ['budget 1.5k', /needs the text "budget <USD>"/], ['budget 1,50', /needs the text/]];
  for (const [text, refused] of refusals) {
    await recordPending(h, {});
    answerCore(h, 1, 'a', text);
    const again = await step(h);
    h.trace.push(again);
    assert.equal(again.part, 'announce', String(text));
    assert.match(again.instruction, refused);
    assert.equal(h.state.authority.budgetUsd, 1.5);
  }
  await recordPending(h, {});
  answerCore(h, 1, 'a', 'continue; budget $1,500');
  assert.equal(await drive(h), null);
  assert.equal(h.state.authority.budgetUsd, 1500);
  assert.deepEqual(h.state.authority.budgetSource.touch, 1);
  assert.equal(h.state.build.resumed, undefined);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('budget on GitHub: an operator:github (a) whose notes say "budget 25" raises the ceiling to 25; without the amount it is refused, saying where the amount goes', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1]], budget: 1.5 });
  h.gateCmdCode = { 'WP-02': [1] };
  let text = null;
  h.spineQuest = () => {
    const result = JSON.parse(fixture('intake', 'spine-quest-answered-github.json'));
    const touch = h.state.touches[0];
    Object.assign(result.quests[0].latestReceipt, { question: touch.filedQuestion, ask: { options: touch.options, allowFreeText: touch.allowFreeText } });
    Object.assign(result.quests[0].latestReceipt.answer, { key: 'a', text });
    return result;
  };
  const refiled = await drive(h, { until: (a) => a.tool === 'spine_receipt' && h.state.touches[0]?.filings === 1 });
  assert.equal(h.state.touches[0].build, 'budget');
  assert.equal(h.state.touches[0].answer, null);
  assert.match(refiled.args.question, /\(a\) needs the text "budget <USD>" \(on GitHub: on the line below the letter a\) above the current spend/);
  assert.equal(h.state.authority.budgetUsd, 1.5);
  text = 'budget 25';
  assert.equal(await drive(h), null);
  assert.equal(h.state.authority.budgetUsd, 25);
  assert.deepEqual([h.state.authority.budgetSource.by, h.state.authority.budgetSource.text], ['operator:github', 'budget 25']);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('owed adjudication (C1-3): findings → guard escalation → answer (b) → the conductor replies refuted, then every thread resolves', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [2] };
  h.reports = { 'WP-02': ['report-built.md', 'report-guard.md'] };
  h.rulings = [{ escalate: true, why: 'is the deleted test a weakening?' }];
  h.unresolved = () => h.resolved < 2;
  await drive(h, { until: (a) => a.part === 'announce' });
  assert.deepEqual(h.state.touches[0].options.map((o) => o.label), ['confirmed', 'refuted', 'judgment']);
  await recordPending(h, {});
  answerCore(h, 1, 'b');
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  const guard = all.find((a) => a.part === 'reply' && a.command.includes('4177234275'));
  assert.equal(flagOf(guard.command, 'verdict'), 'refuted');
  assert.equal(flagOf(guard.command, 'adjudicator'), 'conductor');
  assert.equal(all.filter((a) => a.part === 'amendment').length, 1, 'the lane is not amended for a guard answer');
  assert.deepEqual(all.find((a) => a.step === 'thread-ids').land.commentIds, ['4177234272', '4177234275']);
  assert.equal(all.filter((a) => a.step === 'resolve').length, 2);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('owed adjudication (C1-3): findings → needs conductor → ruling → built → the owed replies and resolves still run', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [3] };
  h.reports = { 'WP-02': ['report-built.md', 'report-needs-conductor.md', 'report-amendment.md'] };
  h.unresolved = () => h.resolved < 3;
  assert.equal(await drive(h), null);
  const all = of(h, 'WP-02');
  assert.deepEqual(all.filter((a) => a.part === 'amendment').map((a) => a.amendment.kind), ['findings', 'ruling']);
  assert.ok(h.events().some((e) => e.event === 'adjudicated' && e.data.rows.length === 3));
  assert.equal(all.filter((a) => a.part === 'reply').length, 3);
  assert.equal(all.filter((a) => a.step === 'resolve').length, 3);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('halt reasons (C1-12): a budget answer clears only the budget halt; dispatch waits for the merged-tree anomaly\'s own answer', async (t) => {
  const h = harness(t, { budget: 1.5, wps: [...TWO, behindWp02('WP-04')] });
  h.life = { 'WP-02': 1, 'WP-03': 1 };
  h.treeMismatch = 'WP-02';
  h.gateCmdCode = { 'WP-03': [1] };
  await drive(h, { until: () => h.state.touches.length === 2 && h.state.pending?.part === 'announce' });
  assert.deepEqual(h.state.touches.map((touch) => touch.build), ['merged', 'budget']);
  await recordPending(h, {});
  answerCore(h, 2, 'a', 'budget 60');
  await drive(h, { until: () => h.wp('WP-03').state === 'merged' && isWait(h.state.pending ?? {}) });
  assert.match(h.state.dispatchHalt.reason, /merged tree differs/);
  assert.ok(!h.trace.some((a) => a.wpId === 'WP-04'), 'no dispatch while the anomaly is open');
  h.state.pending = null;
  h.trace.pop();
  answerCore(h, 1, 'a');
  assert.equal(await drive(h), null);
  assert.equal(h.state.dispatchHalt, null);
  assert.equal(h.wp('WP-04').state, 'merged');
});

test('blocked drops failed work (C1-6): a failed diff or amend-diff blocks, and the next next() does not emit it again', async (t) => {
  for (const part of ['diff', 'amend-diff']) {
    const h = harness(t, { wps: [TWO[0], TWO[1]] });
    if (part === 'amend-diff') {
      h.findings = { 'WP-02': [3] };
      h.reports = { 'WP-02': ['report-built.md', 'report-amendment.md'] };
      h.unresolved = () => h.resolved < 3;
    }
    h.answer = (a) => (a.part === part ? { code: 1, stdout: '', stderr: 'gh: HTTP 502' } : undefined);
    assert.equal(await drive(h), null, part);
    assert.equal(h.wp('WP-02').state, 'blocked');
    assert.equal(h.trace.filter((a) => a.part === part).length, 1, `${part}: emitted once`);
    assert.deepEqual(h.wp('WP-02').queue, []);
  }
});

test('fallback (C1-7): after a successful claude fallback the PR\'s author is claude, so a managed review claims two lenses with no single-lens exception', async (t) => {
  const h = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  h.state.intent.agent = 'codex';
  h.herdrWait = { 'WP-02': [6, 0] };
  h.answer = (a) => (a.part === 'managed' ? ok(JSON.stringify({ mode: 'managed' })) : undefined);
  await drive(h, { until: (a) => a.step === 'post' });
  assert.ok(of(h, 'WP-02').some((a) => a.step === 'fallback'));
  assert.equal(h.wp('WP-02').agent, 'claude');
  const claim = of(h, 'WP-02').find((a) => a.part === 'claim');
  assert.ok(!claim.command.includes('--single-lens'), claim.command.join(' '));
  assert.deepEqual(of(h, 'WP-02').filter((a) => a.part === 'lens').map((a) => flagOf(a.command, 'lens')), ['codex', 'astra']);
});

test('recovery paths (C1-9): an inspect action the gate asks for is emitted and its verdict recorded; admission backoff; one dialog re-poll, then a touch', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  let asked = false;
  h.answer = (a) => {
    if (a.part !== 'gate' || asked) return undefined;
    asked = true;
    const head = h.head('WP-02');
    return { code: 5, stdout: JSON.stringify({ ok: false, pending: false, blocked: false, head, failures: ['post-cap tail needs an inspection'], causes: ['inspect'],
      inspect: { tail: `${'1'.repeat(7)}..${head.slice(0, 7)}`, head, files: ['lib/lanes.mjs'], review: { round: 1, scope: 'full', since: null }, findingsHash: 'f'.repeat(64), anchor: 'review-1' } }), stderr: '' };
  };
  assert.equal(await drive(h), null);
  const inspect = h.trace.find((a) => a.kind === 'inspect');
  assert.equal(inspect.step, 'gate');
  assert.deepEqual(inspect.command.slice(0, 4), ['git', '-C', h.wp('WP-02').lane.worktree, 'diff']);
  assert.deepEqual(h.wp('WP-02').inspections.map((entry) => entry.verdict), ['addresses-findings']);
  assert.equal(h.trace.filter((a) => a.part === 'gate').length, 2);
  assert.equal(h.wp('WP-02').state, 'merged');

  const admit = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  admit.herdrAdmit = { 'WP-02': [7] };
  admit.onPerform = (a) => { if (a.yield) admit.tick(a.waitMs); };
  assert.equal(await drive(admit), null);
  const admits = admit.trace.filter((a) => a.step === 'admit' && a.kind === 'shell');
  assert.equal(admits.length, 2);
  const backoff = admit.trace.slice(admit.trace.indexOf(admits[0]), admit.trace.indexOf(admits[1])).filter(isWait);
  assert.deepEqual(backoff.map((a) => [a.step, a.waitMs]), [['admit', 300000]]);
  assert.equal(admit.wp('WP-02').state, 'merged');

  const once = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  once.herdrWait = { 'WP-02': [3, 0] };
  assert.equal(await drive(once), null);
  assert.equal(once.state.touches.length, 0);
  assert.equal(once.trace.filter((a) => a.wpId === 'WP-02' && a.step === 'wait' && a.kind === 'shell').length, 2);
  const twice = harness(t, { herdr: true, wps: [TWO[0], TWO[1]] });
  twice.herdrWait = { 'WP-02': [3, 3] };
  await drive(twice, { until: (a) => a.part === 'announce' });
  assert.equal(twice.state.touches[0].build, 'dialog');
  assert.match(twice.state.touches[0].question, /Do you trust the files in this folder\?/);
  assert.equal(twice.wp('WP-02').state, 'blocked');
  await recordPending(twice, {});
  answerCore(twice, 1, 'a');
  assert.equal(await drive(twice), null);
  const lane = twice.trace.filter((a) => a.command?.[1]?.endsWith('lane.mjs')).map((a) => a.command[2]);
  assert.ok(lane.every((verb) => ['admit', 'create', 'start', 'prompt', 'wait', 'check', 'stop', 'sweep'].includes(verb)), lane.join(','));
  assert.equal(twice.wp('WP-02').state, 'merged');
});

test('CI pending (C1-9): a pending record at a new head resets pendingSince', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  const pending = (head) => {
    const runs = JSON.parse(fixture('land', 'check-runs-green.json'));
    if (h.pendingHeads.has(head)) runs.check_runs[0].status = 'in_progress';
    return JSON.stringify(runs);
  };
  // Every rebased head has CI still running.
  h.pendingHeads = new Set();
  h.answer = (a) => (a.part === 'post-heads' ? (h.pendingHeads.add(h.bump(a.wpId)), ok(`${h.head(a.wpId)}\n${'e'.repeat(40)}\n`)) : undefined);
  h.checkRuns = pending;
  h.onPerform = (a) => { if (a.part === 'gate') h.tick(60000); };
  const sinces = [];
  h.onEmit = (a) => { if (a.part === 'gate' && h.wp('WP-02').gate) sinces.push([h.wp('WP-02').gate.head, h.wp('WP-02').gate.pendingSince]); };
  await drive(h, { until: () => sinces.length === 1 });
  // The next gate sees a stale base: a rebase moves the head, and CI is pending there too.
  h.stale = 1;
  await drive(h, { until: () => sinces.length >= 2 && sinces.at(-1)[0] !== sinces[0][0] });
  const first = sinces[0];
  const last = sinces.at(-1);
  assert.ok(first[1], 'set at the first pending');
  assert.notEqual(last[0], first[0], 'a new head');
  assert.ok(last[1] && Date.parse(last[1]) > Date.parse(first[1]), `reset at the new head: ${first[1]} → ${last[1]}`);
});

test('spine acknowledgements (C1-10): another quest, another outcome or state, or no receipt uuid is a check failure (exit 2)', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1]] });
  const receipt = await drive(h, { until: (a) => a.tool === 'spine_receipt' && a.step === 'receipt' });
  const good = { ...structuredClone(RECEIPT), questId: receipt.args.questId, outcome: 'completed' };
  for (const bad of [{ ...good, questId: '11111111-0000-4000-8000-000000000000' }, { ...good, outcome: 'paused' }, { ...good, id: 'not-a-uuid' }, { error: 'boom' }]) {
    await assert.rejects(recordPending(h, bad), { code: 2 }, JSON.stringify(bad).slice(0, 80));
  }
  await recordPending(h, good);
  const update = await step(h);
  assert.equal(update.tool, 'spine_update');
  await assert.rejects(recordPending(h, { questId: update.args.questId, workState: 'open' }), { code: 2, message: /workState is open/ });
  await recordPending(h, { questId: update.args.questId, workState: 'done', horizon: 'landed' });
});

test('retry reason and amendment marker (C1-11, C1-13): a missing table re-prompts with its reason; an unchanged brief is refused', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [3] };
  h.reports = { 'WP-02': ['report-built.md', 'report-built.md', 'report-amendment.md'] };
  h.unresolved = () => h.resolved < 3;
  const first = await drive(h, { until: (a) => a.part === 'amendment' });
  const initial = readFileSync(first.outPath, 'utf8');
  await assert.rejects(recordPending(h, {}), { code: 2, message: /marker line: Amendment 1: review round 1: 3 finding\(s\)/ });
  writeFileSync(first.outPath, `${first.marker}\n${initial}`);
  await recordPending(h, {});
  const retry = await drive(h, { until: (a) => a.part === 'amendment' && a.amendment.n === 2 });
  assert.match(retry.instruction, /its last check failed: the report has no ## Amendment table/);
  assert.match(retry.instruction, /Still owed: review round 1 posted 3 finding\(s\)/);
  assert.match(retry.marker, /^Amendment 2: the report has no ## Amendment table/);
  await recordPending(h, author(h, retry));
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('a check-fix amendment with no table: the findings amendment\'s table is adjudicated, not a second check failure', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.findings = { 'WP-02': [3] };
  h.reports = { 'WP-02': ['report-built.md', 'report-amendment-stale-pr.md', 'report-amendment-check-fix.md'] };
  h.unresolved = () => h.resolved < 3;
  const fix = await drive(h, { until: (a) => a.part === 'amendment' && a.amendment.n === 2 });
  assert.match(fix.instruction, /its last check failed: the report's ## PR says #\d+ at 0000000/);
  await recordPending(h, author(h, fix));
  assert.equal(await drive(h), null);
  assert.equal(h.wp('WP-02').state, 'merged');
  assert.ok(h.events().some((e) => e.event === 'adjudicated' && e.data.rows.length === 3));
});

test('comment-id reconciliation (C1-16): a council table missing C1-3 re-prompts naming it', async (t) => {
  const h = harness(t, { council: true, wps: [TWO[0], { ...TWO[1], tier: 'T2' }] });
  h.synth = [{ findings: 3, seats: ['gpt-6.1-sol'] }];
  h.reports = { 'WP-02': ['report-built.md', 'report-council-amendment.md'] };
  const retry = await drive(h, { until: (a) => a.part === 'amendment' && a.amendment.n === 2 });
  assert.match(retry.instruction, /the ## Amendment table has no row for C1-3/);
  assert.ok(!h.events().some((e) => e.event === 'adjudicated'));
});

test('core touch visibility (split 2): the action after an escalation is a wait naming the touch file and its answer command, before other work', async (t) => {
  const h = harness(t);
  h.reports = { 'WP-02': ['report-needs-conductor.md'] };
  h.rulings = [{ escalate: true, why: 'operator call' }];
  h.life = { 'WP-03': 2 };
  await drive(h, { until: (a) => a.step === 'ruling' });
  await pendingAfter(h, author(h, h.state.pending));
  const announce = await step(h);
  assert.equal(announce.kind, 'wait');
  assert.equal(announce.part, 'announce');
  assert.ok(announce.instruction.includes(join(h.runDir, 'touches', '1.md')), announce.instruction);
  assert.match(announce.instruction, /answer --run .* --touch 1 --key <a\|b>/);
  await recordPending(h, {});
  const after = await step(h);
  assert.notEqual(after.part, 'announce', 'once per touch');
});

// ---- amendment 2 (delta council round 2 on #156) ----

test('budget (b) (C2-1, C2-2): no prompt after (b) for a second WP, which blocks with the reason; a WP at its PR boundary still lands', async (t) => {
  // Both lanes close ($0.95 each, booked); WP-03's amendment prompt then projects past $2.5.
  const h = harness(t, { budget: 2.5 });
  h.life = { 'WP-02': 2, 'WP-03': 1 };
  h.gateCmdCode = { 'WP-03': [1] };
  await drive(h, { until: (a) => a.part === 'announce' });
  assert.match(h.state.touches[0].question, /\(b\) no new paid lane work \(no dispatch, lane start, prompt or fallback\); work already at a PR boundary may still be reviewed and landed/);
  assert.equal(h.state.touches[0].options[1].label, 'Stop new paid lane work');
  // M4: the raise names the lane-only lower bound; nothing says metering goes on.
  assert.match(h.state.touches[0].question, /raises the ceiling to it, and the lane-only lower bound is checked against it;/);
  assert.match(h.state.touches[0].options[0].consequence, /booked lane cost is checked against it\.$/);
  assert.doesNotMatch(`${h.state.touches[0].question} ${h.state.touches[0].options.map((o) => o.consequence).join(' ')}`, /metering|meter reading/i);
  await recordPending(h, {});
  answerCore(h, 1, 'b');
  assert.equal(await drive(h), null);
  assert.ok(!h.trace.some((a) => a.wpId === 'WP-03' && a.step === 'prompt'), 'WP-03 was never prompted again');
  assert.equal(h.wp('WP-03').state, 'blocked');
  assert.equal(h.wp('WP-03').reason, 'the budget was reached and the operator stopped new paid lane work');
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('touch announce (C2-7): a touch opened while scheduling is announced next, before a yield, another action or the release', async (t) => {
  for (const lanes of [1, 2]) {
    const h = harness(t, { budget: 0.5, lanes, ...(lanes === 1 ? { wps: [TWO[0], TWO[1], behindWp02('WP-03')] } : {}) });
    h.life = { 'WP-02': 0, 'WP-03': 0 };
    let seen = 0;
    const late = [];
    h.onEmit = (a) => {
      if (h.state.touches.length > seen && a.part !== 'announce') late.push(`${a.id} ${a.kind}/${a.step}`);
      seen = h.state.touches.length;
    };
    assert.equal(await drive(h), null);
    assert.ok(h.state.touches.length >= 1, `lanes ${lanes}: a budget touch opened`);
    assert.deepEqual(late, [], `lanes ${lanes}: emitted before the announce`);
    // One lane: the halt opens as WP-03 is about to dispatch, with nothing else live, so the release follows it.
    if (lanes === 1) assert.equal(h.trace.at(-1).part, 'announce', 'the announce precedes the release');
  }
});

test('spine acknowledgements (C2-4): ok:false, success:false, an empty or too-short quest id are failures', async (t) => {
  const h = harness(t, { spine: true, wps: [TWO[0], TWO[1]] });
  const receipt = await drive(h, { until: (a) => a.tool === 'spine_receipt' && a.step === 'receipt' });
  const good = { ...structuredClone(RECEIPT), questId: receipt.args.questId, outcome: 'completed' };
  for (const bad of [{ ...good, ok: false }, { ...good, success: false }, { ...good, questId: '' }, { ...good, questId: '0' }, { ...good, questId: 'zzzzzzzz' }]) {
    await assert.rejects(recordPending(h, bad), { code: 2 }, JSON.stringify(bad).slice(0, 60));
  }
  await recordPending(h, { ...good, questId: receipt.args.questId.slice(0, 8) });
  const update = await step(h);
  await assert.rejects(recordPending(h, { ok: false, questId: update.args.questId, workState: 'done', horizon: 'landed' }), { code: 2, message: /failed/ });
  await recordPending(h, { questId: update.args.questId, workState: 'done', horizon: 'landed' });
});

test('adjudication ids are unique (C2-5): a slim or a council table naming one id twice re-prompts with the reason', async (t) => {
  const slim = harness(t, { wps: [TWO[0], TWO[1]] });
  slim.findings = { 'WP-02': [2] };
  slim.reports = { 'WP-02': ['report-built.md', 'report-duplicate-ids.md'] };
  const retry = await drive(slim, { until: (a) => a.part === 'amendment' && a.amendment.n === 2 });
  assert.match(retry.instruction, /the ## Amendment table lists 123, C1-3 more than once/);
  assert.ok(!slim.trace.some((a) => a.part === 'reply'));
  const council = harness(t, { council: true, wps: [TWO[0], { ...TWO[1], tier: 'T2' }] });
  council.synth = [{ findings: 3, seats: ['gpt-6.1-sol'] }];
  council.reports = { 'WP-02': ['report-built.md', 'report-duplicate-ids.md'] };
  const again = await drive(council, { until: (a) => a.part === 'amendment' && a.amendment.n === 2 });
  assert.match(again.instruction, /lists 123, C1-3 more than once/);
  assert.ok(!council.events().some((e) => e.event === 'adjudicated'));
});

test('council guard rows (C2-6): an answered escalation on C1-2 is recorded as adjudicated, with no reply --comment-id C1-2', async (t) => {
  const h = harness(t, { council: true, wps: [TWO[0], { ...TWO[1], tier: 'T2' }] });
  h.synth = [{ findings: 2, seats: ['gpt-6.1-sol'] }];
  h.reports = { 'WP-02': ['report-built.md', 'report-council-guard.md'] };
  h.rulings = [{ escalate: true, why: 'only the operator can rule on a deleted test' }];
  await drive(h, { until: (a) => a.part === 'announce' });
  await recordPending(h, {});
  answerCore(h, 1, 'b', 'RULING_SENTINEL the deleted test covered a removed function');
  assert.equal(await drive(h), null);
  // The operator's reason rides on the row beside the lane's Evidence, so the next round reads it (council review of #242).
  assert.match(readFileSync(join(h.runDir, 'council', 'wp-02', 'review-1', 'adjudication-for-next-round.md'), 'utf8'), /\| C1-2 \| refuted \(conductor\) \|[^\n]*Ruling: RULING_SENTINEL the deleted test covered a removed function \|/);
  // The council round's review record is its only PR write; no comment id is replied to (da57e5ba).
  assert.deepEqual(h.trace.filter((a) => ['reply', 'thread-ids', 'resolve'].includes(a.step)).map((a) => `${a.step}/${a.part}`), ['reply/record']);
  // It is written after the guard row's ruling, so it carries the operator's final verdict, never `conductor` (codex lens, workit#201).
  const body = readFileSync(join(h.runDir, 'council', 'wp-02', 'review-1', 'pr-record.md'), 'utf8');
  assert.match(body, /\| C1-2 \| refuted \(conductor\) \| — \|[^\n]*Ruling: RULING_SENTINEL/);
  assert.ok(!/\| conductor \|/.test(body), body);
  const answered = h.trace.findIndex((a) => a.part === 'record');
  assert.ok(answered > h.trace.findIndex((a) => a.part === 'announce'), 'the record follows the escalation and its answer');
  const verdicts = h.events().filter((e) => e.event === 'adjudicated').flatMap((e) => e.data.rows);
  assert.deepEqual(verdicts.at(-1), { comment: 'C1-2', verdict: 'refuted', adjudicator: 'conductor' });
  assert.equal(h.wp('WP-02').state, 'merged');
});

test('no CI (C2-8): an unread workflow count waits, then blocks as unknown; the window is 30 minutes from the first absent-or-pending read; hold authority holds', async (t) => {
  const noRuns = [/^gh api repos\/o\/r\/commits\/\w+\/check-runs/, () => ({ code: 1, stdout: '', stderr: 'gh: No commit found for SHA (HTTP 422)' })];
  const unknown = harness(t, { wps: [TWO[0], TWO[1]] });
  unknown.declineRecover = true;
  unknown.state.intent.ciWorkflows = null;
  unknown.rules.unshift(noRuns);
  unknown.onPerform = (a) => { if (a.part === 'gate') unknown.tick(10 * 60000); };
  assert.equal(await drive(unknown), null);
  assert.equal(unknown.wp('WP-02').reason, 'CI state unknown: the workflow count could not be read');
  assert.equal(unknown.trace.filter((a) => a.part === 'gate').length, 4);

  const empty = harness(t, { wps: [TWO[0], TWO[1]] });
  empty.declineRecover = true;
  empty.checkRuns = () => JSON.stringify({ total_count: 0, check_runs: [] });
  const times = [];
  empty.onPerform = (a) => {
    if (a.part !== 'gate') return;
    times.push(empty.deps.now());
    empty.tick(60000);
  };
  assert.equal(await drive(empty), null);
  assert.equal(empty.wp('WP-02').reason, 'CI did not complete at head');
  assert.equal((times.at(-1) - times[0]) / 60000, 30, 'blocked at 30 minutes after the first read, not 40');

  const hold = harness(t, { merge: false, wps: [TWO[0], TWO[1]] });
  hold.state.intent.ciWorkflows = 0;
  hold.rules.unshift(noRuns);
  assert.equal(await drive(hold), null);
  assert.equal(hold.wp('WP-02').state, 'held');
  assert.equal(hold.wp('WP-02').reason, 'held at PR: no CI at head: the repo has no CI workflow that can gate a PR');
  assert.deepEqual(hold.wp('WP-02').gate.failures, ['no CI at head']);
  assert.equal(hold.state.mergeLock, null);
});

test('gate cap on the landing route (C2-10): repeated lane-fixable land gate failures block at the third', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  h.declineRecover = true;
  h.unresolved = () => true;
  assert.equal(await drive(h), null);
  assert.equal(of(h, 'WP-02').filter((a) => a.part === 'amendment').length, 2);
  assert.equal(h.trace.filter((a) => a.part === 'gate').length, 3);
  assert.equal(h.wp('WP-02').state, 'blocked');
  assert.equal(h.wp('WP-02').reason, 'unresolved review threads (after 2 gate amendments)');
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

test('synthetic receipt fixture (C1-8): the spine_receipt success shape with made-up ids, no money and no locators', () => {
  const text = fixture('build', 'spine-receipt-result.json');
  const receipt = JSON.parse(text);
  assert.deepEqual(Object.keys(receipt), ['id', 'questId', 'outcome', 'did', 'stoppedAt', 'producedArtifacts', 'coherence', 'resolution', 'source', 'createdAt', 'question', 'ask', 'answer']);
  for (const id of [receipt.id, receipt.questId]) assert.match(id, /^00000000-0000-4000-8000-0000000000\w\w$/);
  assert.ok(!/\$\d|data\/outputs|projects\/|\bpane\b/.test(text), text);
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

test('unconfigured (M8, council r1): merge authority edited to false after the gate passed takes today\'s path back through land; a queued squash is emitted as today', async (t) => {
  const h = harness(t, { wps: [TWO[0], TWO[1]] });
  const gate = await drive(h, { until: (a) => a.wpId === 'WP-02' && a.step === 'gate' && a.part === 'gate' });
  await recordPending(h, await perform(h, gate));
  assert.equal(h.wp('WP-02').gate.ok, true);
  h.state.authority.merge = false;
  assert.equal(await drive(h), null);
  assert.deepEqual([h.wp('WP-02').state, h.wp('WP-02').reason], ['held', 'gate passed; no merge authority']);

  const queued = harness(t, { wps: [TWO[0], TWO[1]] });
  await drive(queued, { until: (a) => a.step === 'merge' && a.part === 'squash' });
  queued.state.pending = null;
  queued.state.authority.merge = false;
  assert.equal(await drive(queued), null);
  assert.equal(queued.trace.filter((a) => a.part === 'squash').length, 2);
  assert.equal(queued.wp('WP-02').state, 'merged');
});
