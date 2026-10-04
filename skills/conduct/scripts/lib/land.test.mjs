import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tierFor, pickReviewers, reviewActions, deltaReviewActions, t2Actions, parseAmendmentTable, recordAdjudication,
  resolveThreadActions, rebaseActions, recordRebase, mergeLockFor, gateCheck, mergeActions, recordLandStep, runLandVerb,
  parsePages, findingsCount, THREADS_QUERY, RESOLVE_MUTATION, ALREADY_REVIEWED,
} from './land.mjs';
import { STEPS, STEP_SEAM } from './state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '__fixtures__', 'land');
const fixtureText = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const fixtureJson = (name) => JSON.parse(fixtureText(name));

const RUN = join('/', 'runs', 'fixture', 'run');
const PLUGIN = join('/', 'plugin');
const WT = join('/', 'projects', 'workit-wt-fixture-wp-01');
const PR_REVIEW = join(PLUGIN, 'skills', 'slim-review', 'scripts', 'pr-review.mjs');
const sha = (c) => c.repeat(40);
const HEAD = sha('a');
const BASE = sha('b');
const NOW = Date.parse('2026-10-04T20:00:00.000Z');
const minutesAgo = (n) => new Date(NOW - n * 60000).toISOString();

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const GREEN = ok(fixtureText('check-runs-green.json'));
const ZERO = ok(fixtureText('check-runs-zero.json'));
const UNKNOWN = (({ code, stdout, stderr }) => ({ code, stdout, stderr }))(fixtureJson('unknown-sha.json'));
// Derived from the green capture by editing one run (fixture README).
function derived(edit) {
  const page = JSON.parse(fixtureText('check-runs-green.json'));
  edit(page.check_runs[0]);
  return JSON.stringify(page);
}
const FAILED = ok(derived((run) => { run.conclusion = 'failure'; }));
const PENDING = ok(derived((run) => { run.status = 'in_progress'; run.conclusion = null; }));

function makeState(over = {}) {
  return {
    schemaVersion: 1, runDir: RUN, pluginRoot: PLUGIN, phase: 'build',
    intent: { repo: { path: join('/', 'projects', 'workit'), remote: 'sirmaelstrom/workit', defaultBranch: 'main' }, agent: 'claude', release: null },
    agents: { claude: { on: true }, codex: { on: true } },
    adapters: { council: { on: false } },
    authority: { merge: true, release: false },
    mergeLock: { wpId: 'WP-01', since: minutesAgo(5) },
    release: { state: 'pending', base: null, worktree: null, branch: null, pr: null, gate: null, merge: null },
    wps: [],
    ...over,
  };
}

function makeWp(over = {}) {
  return {
    id: 'WP-01', name: 'fixture', tier: 'T1', state: 'gate',
    lane: { worktree: WT, branch: 'conduct/fixture/wp-01', base: BASE },
    pr: { number: 7, head: HEAD },
    reviews: [{ round: 1, scope: 'full', tier: 'T1', head: HEAD, lenses: ['codex', 'astra'], verdicts: [], resolved: [] }],
    rebases: [], gate: null, queue: [],
    ...over,
  };
}

// A fake executor for the gate's programs. Every call is logged with its input.
function gateExec({ head = HEAD, prHead = head, fetch = 0, ancestor = 0, ci = GREEN, threads = 0, tailFiles = [], tailCommits = [], diffQuiet = 0, patchIds = {} } = {}) {
  const calls = [];
  const exec = (program, args, options = {}) => {
    calls.push({ program, args, input: options.input });
    if (program === 'git' && args[2] === 'rev-parse') return ok(`${head}\n`);
    if (program === 'gh' && args[1] === 'view') return ok(JSON.stringify({ headRefOid: prHead }));
    if (program === 'git' && args[2] === 'fetch') return { code: fetch, stdout: '', stderr: fetch ? 'fatal: unable to access' : '' };
    if (program === 'git' && args[2] === 'merge-base') return { code: ancestor, stdout: '', stderr: '' };
    if (program === 'gh' && args[0] === 'api') return ci;
    if (program === 'node' && args[1] === 'threads') return { code: threads, stdout: '', stderr: threads ? 'open threads' : '' };
    if (program === 'git' && args[2] === 'diff' && args[3] === '--name-only') return ok(tailFiles.join('\n'));
    if (program === 'git' && args[2] === 'diff' && args[3] === '--quiet') return { code: diffQuiet, stdout: '', stderr: '' };
    if (program === 'git' && args[2] === 'diff') return ok(`diff ${args[3]} ${args[4]}\n`);
    if (program === 'git' && args[2] === 'patch-id') return ok(`${patchIds[options.input] ?? 'p0'} ${sha('0')}\n`);
    if (program === 'git' && args[2] === 'rev-list') return ok(tailCommits.join('\n'));
    throw new Error(`unexpected exec: ${program} ${args.join(' ')}`);
  };
  exec.calls = calls;
  return exec;
}

const gate = (state, wp, options = {}, now = NOW) => gateCheck(state, wp, { exec: gateExec(options), now: () => now });

test('gateCheck: ok for green CI, threads exit 0, a review at head, a fresh base and the lock held', () => {
  const out = gate(makeState(), makeWp());
  assert.deepEqual(out, { ok: true, pending: false, blocked: false, head: HEAD, failures: [], unreviewedTail: null, needsFullReview: false, staleBase: false });
});

test('gateCheck: one failed run fails, naming it', () => {
  const out = gate(makeState(), makeWp(), { ci: FAILED });
  assert.equal(out.ok, false);
  assert.equal(out.pending, false);
  assert.match(out.failures.join(), /CI failed at head: Tests \(node --test, windows\) \(failure\)/);
});

test('gateCheck: zero check-runs are pending, then "no CI at head" 10 minutes after pendingSince', () => {
  const fresh = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(2) } }), { ci: ZERO });
  assert.deepEqual([fresh.ok, fresh.pending, fresh.failures], [false, true, []]);
  const late = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(11) } }), { ci: ZERO });
  assert.deepEqual([late.ok, late.pending, late.failures], [false, false, ['no CI at head']]);
});

test('gateCheck: a sha GitHub does not have (422) is "no CI at head"', () => {
  assert.match(UNKNOWN.stderr, /HTTP 422/);
  assert.deepEqual(gate(makeState(), makeWp(), { ci: UNKNOWN }).failures, ['no CI at head']);
});

test('gateCheck: threads exit 8 fails; any other threads exit is unreadable', () => {
  assert.deepEqual(gate(makeState(), makeWp(), { threads: 8 }).failures, ['unresolved review threads']);
  assert.match(gate(makeState(), makeWp(), { threads: 1 }).failures[0], /^threads unreadable \(exit 1\)/);
});

test('gateCheck: a worktree head that differs from the PR headRefOid is "head mismatch"', () => {
  const out = gate(makeState(), makeWp(), { prHead: sha('c') });
  assert.equal(out.ok, false);
  assert.deepEqual(out.failures, ['head mismatch']);
});

test('gateCheck: a review at an older head whose tail changes a .mjs file fails', () => {
  const wp = makeWp({ reviews: [{ round: 1, scope: 'full', head: sha('e'), verdicts: [] }] });
  const out = gate(makeState(), wp, { tailFiles: ['skills/conduct/scripts/lib/land.mjs', 'README.md'] });
  assert.equal(out.ok, false);
  assert.match(out.failures.join(), /review does not cover head: .*land\.mjs/);
});

test('gateCheck: a tail that changes only *.md is ok as trivial', () => {
  const wp = makeWp({ reviews: [{ round: 1, scope: 'full', head: sha('e'), verdicts: [] }] });
  const out = gate(makeState(), wp, { tailFiles: ['README.md', 'skills/conduct/SKILL.md'] });
  assert.equal(out.ok, true);
  assert.equal(out.unreviewedTail, `${sha('e')}..${HEAD} (trivial)`);
});

test('trivial is docs only: a *.test.mjs or __fixtures__ tail is not trivial', () => {
  const wp = makeWp({ reviews: [{ round: 1, scope: 'full', head: sha('e'), verdicts: [] }] });
  for (const file of ['skills/conduct/scripts/lib/land.test.mjs', 'skills/conduct/scripts/__fixtures__/land/check-runs-green.json', 'skills/conduct/scripts/__fixtures__/land/README.md']) {
    const out = gate(makeState(), wp, { tailFiles: [file] });
    assert.equal(out.ok, false, file);
    assert.equal(out.unreviewedTail, null, file);
  }
});

const C1 = sha('1');
const C2 = sha('2');
const D = sha('d');
const postCapWp = (over = {}) => makeWp({
  reviews: [
    { round: 1, scope: 'full', head: sha('f'), verdicts: [{ comment: '11', verdict: 'fixed', commit: C1.slice(0, 7) }] },
    { round: 2, scope: 'delta', head: D, verdicts: [{ comment: '12', verdict: 'fixed', commit: C2 }] },
  ],
  ...over,
});

test('post-cap is bound to adjudicated fixes', () => {
  const tail = { tailFiles: ['skills/conduct/scripts/lib/land.mjs'], tailCommits: [C2, C1] };
  const out = gate(makeState(), postCapWp(), tail);
  assert.equal(out.ok, true, out.failures.join());
  assert.equal(out.unreviewedTail, `${D}..${HEAD} (post-cap)`);
  // One commit not a fixed row's commit.
  assert.equal(gate(makeState(), postCapWp(), { ...tail, tailCommits: [C2, sha('9')] }).ok, false);
  // A tail that starts after the delta review's head.
  const after = postCapWp();
  after.reviews.push({ round: 3, scope: 'full', head: sha('e'), verdicts: [] });
  assert.equal(gate(makeState(), after, tail).ok, false);
});

test('post-cap after an equivalent rebase: the tail is computed against the pre-rebase from', () => {
  const pre = sha('7');
  const wp = postCapWp({ rebases: [{ from: pre, to: HEAD, oldBase: BASE, newBase: sha('8'), equivalent: true }] });
  const exec = gateExec({ tailFiles: ['lib/x.mjs'], tailCommits: [C1, C2] });
  const out = gateCheck(makeState(), wp, { exec, now: () => NOW });
  assert.equal(out.ok, true, out.failures.join());
  assert.equal(out.unreviewedTail, `${D}..${pre} (post-cap)`);
  assert.ok(exec.calls.some((call) => call.args.join(' ') === `-C ${WT} rev-list ${D}..${pre}`));
});

test('fresh base: merge-base --is-ancestor exit 1 is "stale base", and land gate is code 5', async () => {
  const out = gate(makeState(), makeWp(), { ancestor: 1 });
  assert.equal(out.staleBase, true);
  assert.deepEqual(out.failures, ['stale base']);
  const exec = gateExec({ ancestor: 1 });
  assert.ok(exec.calls.length === 0);
  const verb = await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(makeState({ wps: [makeWp()] }), exec));
  assert.equal(verb.code, 5);
  const fetch = exec.calls.findIndex((call) => call.args[2] === 'fetch');
  const fresh = exec.calls.findIndex((call) => call.args[2] === 'merge-base');
  assert.ok(fetch >= 0 && fresh > fetch, 'fetch, then merge-base');
  assert.deepEqual(exec.calls[fresh].args, ['-C', WT, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
});

test('the merge lock: another holder fails the gate; null lock fails (D20); mergeLockFor; a non-holder rebase yields', async () => {
  assert.deepEqual(gate(makeState({ mergeLock: { wpId: 'WP-02', since: minutesAgo(1) } }), makeWp()).failures, ['merge lock held by WP-02']);
  const unlocked = makeState({ mergeLock: null, wps: [makeWp()] });
  assert.deepEqual(gate(unlocked, makeWp()).failures, ['merge lock not held']);
  assert.equal((await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(unlocked, gateExec()))).code, 5);
  assert.equal(mergeLockFor(makeState({ mergeLock: null }), makeWp()), 'free');
  assert.equal(mergeLockFor(makeState(), makeWp()), 'mine');
  assert.equal(mergeLockFor(makeState({ mergeLock: { wpId: 'WP-02' } }), makeWp()), 'other');
  const yielded = rebaseActions(makeState({ mergeLock: { wpId: 'WP-02' } }), makeWp());
  assert.deepEqual(yielded.map((a) => [a.kind, a.waitMs]), [['wait', 60000]]);
});

test('pending ≠ failure: in_progress is pending (code 6); 31 minutes past pendingSince is blocked (code 5)', async () => {
  const pending = gate(makeState(), makeWp(), { ci: PENDING });
  assert.deepEqual([pending.ok, pending.pending, pending.blocked, pending.failures], [false, true, false, []]);
  const verb = await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(makeState({ wps: [makeWp()] }), gateExec({ ci: PENDING })));
  assert.equal(verb.code, 6);
  const wp = makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(31) } });
  const blocked = gate(makeState(), wp, { ci: PENDING });
  assert.deepEqual([blocked.ok, blocked.pending, blocked.blocked, blocked.failures], [false, false, true, ['CI did not complete at head']]);
  const code = (await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(makeState({ wps: [wp] }), gateExec({ ci: PENDING })))).code;
  assert.equal(code, 5);
});

test('equivalent rebase covered; a non-equivalent rebase needs a full review even for a docs-only diff', () => {
  const from = sha('f');
  const reviewed = { reviews: [{ round: 1, scope: 'full', head: from, verdicts: [] }] };
  const covered = gate(makeState(), makeWp({ ...reviewed, rebases: [{ from, to: HEAD, equivalent: true }] }));
  assert.deepEqual([covered.ok, covered.unreviewedTail], [true, null]);
  const changed = gate(makeState(), makeWp({ ...reviewed, rebases: [{ from, to: HEAD, equivalent: false }] }), { tailFiles: ['README.md'] });
  assert.equal(changed.ok, false);
  assert.equal(changed.needsFullReview, true);
  assert.deepEqual(changed.failures, ['rebase changed the WP\'s diff: full review of the rebased head']);
});

test('recordRebase: equal stable patch-ids are equivalent; the patch-id call gets the diff stdout as input', () => {
  const from = sha('f');
  const newBase = sha('9');
  const wp = makeWp();
  const same = gateExec({ patchIds: { [`diff ${BASE} ${from}\n`]: 'pid1', [`diff ${newBase} ${HEAD}\n`]: 'pid1' } });
  const entry = recordRebase(makeState(), wp, { from, to: HEAD, newBase }, { exec: same });
  assert.deepEqual(entry, { from, to: HEAD, oldBase: BASE, newBase, patchIds: { from: 'pid1', to: 'pid1' }, equivalent: true });
  const inputs = same.calls.filter((call) => call.args[2] === 'patch-id').map((call) => call.input);
  assert.deepEqual(inputs, [`diff ${BASE} ${from}\n`, `diff ${newBase} ${HEAD}\n`]);
  const differ = gateExec({ patchIds: { [`diff ${BASE} ${from}\n`]: 'pid1', [`diff ${newBase} ${HEAD}\n`]: 'pid2' } });
  assert.equal(recordRebase(makeState(), wp, { from, to: HEAD, newBase }, { exec: differ }).equivalent, false);
  // A second rebase's oldBase is the previous rebase's newBase.
  const again = recordRebase(makeState(), makeWp({ rebases: [{ newBase }] }), { from: HEAD, to: sha('c'), newBase: sha('6') }, { exec: same });
  assert.equal(again.oldBase, newBase);
});

test('collects every failure (D17): head mismatch, no CI and threads together; pending CI plus threads is failed', async () => {
  const out = gate(makeState(), makeWp(), { prHead: sha('c'), ci: UNKNOWN, threads: 8 });
  assert.deepEqual(out.failures, ['head mismatch', 'no CI at head', 'unresolved review threads']);
  const state = makeState({ wps: [makeWp()] });
  assert.equal((await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(state, gateExec({ prHead: sha('c'), ci: UNKNOWN, threads: 8 })))).code, 5);
  const mixed = gate(makeState(), makeWp(), { ci: PENDING, threads: 8 });
  assert.deepEqual([mixed.ok, mixed.pending, mixed.failures], [false, false, ['unresolved review threads']]);
  assert.equal((await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(state, gateExec({ ci: PENDING, threads: 8 })))).code, 5);
});

test('T0 exemption: no review needed, CI and threads still apply', () => {
  const wp = makeWp({ tier: 'T0', reviews: [] });
  const out = gate(makeState(), wp);
  assert.deepEqual([out.ok, out.unreviewedTail], [true, `${BASE}..${HEAD} (T0)`]);
  assert.equal(gate(makeState(), wp, { threads: 8 }).ok, false);
});

function releaseState(lock) {
  return makeState({
    mergeLock: lock,
    release: { state: 'pending', base: BASE, worktree: join('/', 'projects', 'workit-wt-fixture-release'), branch: 'conduct/fixture/release', pr: { number: 9, head: HEAD }, gate: null, merge: null },
  });
}

test('release PR (D17, D20): --wp release is T0 under the release lock; merged diffs in release.worktree', async () => {
  const held = await runLandVerb('gate', { runDir: RUN, wpId: 'release', flags: {} }, verbDeps(releaseState({ wpId: 'release', since: minutesAgo(1) }), gateExec()));
  assert.equal(held.code, 0);
  assert.equal(held.out.unreviewedTail, `${BASE}..${HEAD} (T0)`);
  const free = await runLandVerb('gate', { runDir: RUN, wpId: 'release', flags: {} }, verbDeps(releaseState(null), gateExec()));
  assert.equal(free.code, 5);
  assert.ok(free.out.failures.includes('merge lock not held'));
  const exec = gateExec();
  const merged = await runLandVerb('merged', { runDir: RUN, wpId: 'release', flags: { mergeSha: sha('m') } }, verbDeps(releaseState(null), exec));
  assert.equal(merged.code, 0);
  assert.deepEqual(exec.calls.at(-1).args, ['-C', join('/', 'projects', 'workit-wt-fixture-release'), 'diff', '--quiet', HEAD, sha('m')]);
});

const PRIVATE_PATHS = [/[A-Za-z]:[\\/]+(Users|Development)\b/i, /[\\/]Users[\\/][^\\/\s"]+[\\/]/];
test('fixture paths: no private-path shapes under __fixtures__/land; no loopback in the managed lines', () => {
  const files = readdirSync(FIXTURES);
  assert.ok(files.length >= 11, files.join(', '));
  for (const name of files) assert.deepEqual(PRIVATE_PATHS.filter((pattern) => pattern.test(fixtureText(name))).map(String), [], name);
  for (const name of files.filter((file) => file.startsWith('managed-'))) {
    assert.ok(!fixtureText(name).includes('://127.') && !fixtureText(name).includes('localhost:'), name);
  }
  // Control: the check sees each shape when it is inserted (built at run time).
  const text = fixtureText('managed-workit.json');
  assert.ok(PRIVATE_PATHS.some((pattern) => pattern.test(text.replace('<home>', ['C:', 'Users', 'someone'].join('\\')))));
  assert.ok(text.replace('<coordinator-url>', ['http:', '', '127.0.0.1:3100'].join('/')).includes('://127.'));
});

test('mergeActions: ready, squash at --match-head-commit, the merge commit, then land merged with a literal {merge.sha}', () => {
  const actions = mergeActions(makeState(), makeWp(), HEAD);
  assert.deepEqual(actions.map((a) => a.command), [
    ['gh', 'pr', 'ready', '7', '--repo', 'sirmaelstrom/workit'],
    ['gh', 'pr', 'merge', '7', '--repo', 'sirmaelstrom/workit', '--squash', '--match-head-commit', HEAD],
    ['gh', 'pr', 'view', '7', '--repo', 'sirmaelstrom/workit', '--json', 'mergeCommit'],
    ['node', join(PLUGIN, 'skills', 'conduct', 'scripts', 'conduct.mjs'), 'land', 'merged', '--run', RUN, '--wp', 'WP-01', '--merge-sha', '{merge.sha}'],
  ]);
  assert.deepEqual(actions.map((a) => a.step), ['merge', 'merge', 'merge', 'merged']);
  assert.ok(actions.every((a) => a.step !== 'notify'));
  assert.deepEqual(mergeActions(makeState({ authority: { merge: false } }), makeWp(), HEAD), []);
  // Only authority is read: an intent saying otherwise changes nothing.
  assert.equal(mergeActions(makeState({ intent: { ...makeState().intent, merge: false, hold: true } }), makeWp(), HEAD).length, 4);
  assert.deepEqual(mergeActions(makeState({ mergeLock: { wpId: 'WP-02' } }), makeWp(), HEAD), []);
});

test('the CI read is the paginated check-runs argv, and every page is read', () => {
  const exec = gateExec();
  gateCheck(makeState(), makeWp(), { exec, now: () => NOW });
  assert.deepEqual(exec.calls.find((call) => call.program === 'gh' && call.args[0] === 'api').args, ['api', `repos/sirmaelstrom/workit/commits/${HEAD}/check-runs?per_page=100`, '--paginate']);
  const twoPages = ok(`${fixtureText('check-runs-green.json').trim()}${FAILED.stdout}`);
  assert.match(gate(makeState(), makeWp(), { ci: twoPages }).failures.join(), /CI failed at head/);
  const real = parsePages(fixtureText('check-runs-paged.json'));
  assert.equal(real.length, 3);
  assert.equal(gate(makeState(), makeWp(), { ci: ok(fixtureText('check-runs-paged.json')) }).ok, true);
});

test('land merged: an empty diff is code 0, a non-empty one 5, no --merge-sha 2', async () => {
  const state = makeState({ wps: [makeWp({ gate: { head: HEAD } })] });
  assert.deepEqual(await runLandVerb('merged', { runDir: RUN, wpId: 'WP-01', flags: { mergeSha: sha('m') } }, verbDeps(state, gateExec())),
    { code: 0, out: { ok: true, head: HEAD, mergeSha: sha('m') } });
  assert.equal((await runLandVerb('merged', { runDir: RUN, wpId: 'WP-01', flags: { mergeSha: sha('m') } }, verbDeps(state, gateExec({ diffQuiet: 1 })))).code, 5);
  assert.equal((await runLandVerb('merged', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(state, gateExec()))).code, 2);
  assert.equal((await runLandVerb('merge', { runDir: RUN, wpId: 'WP-01', flags: { mergeSha: sha('m') } }, verbDeps(state, gateExec()))).code, 2);
});

const agents = (claude, codex) => ({ claude: { on: claude }, codex: { on: codex } });

test('pickReviewers availability matrix (D19.12)', () => {
  assert.deepEqual(pickReviewers(makeState({ agents: agents(true, false) }), 'claude'),
    { lenses: ['opus'], singleLens: 'no codex CLI: opus is the only available lens', sameFamily: true });
  assert.deepEqual(pickReviewers(makeState({ agents: agents(true, true) }), 'claude').lenses, ['codex', 'astra']);
  assert.deepEqual(pickReviewers(makeState({ agents: agents(true, true) }), 'codex').lenses, ['astra', 'opus']);
  assert.deepEqual(pickReviewers(makeState({ agents: agents(false, true) }), 'codex'), { lenses: ['codex', 'astra'], sameFamily: true });
  assert.deepEqual(pickReviewers(makeState({ agents: agents(true, true) }), 'claude', { mode: 'managed' }).lenses, ['codex', 'astra']);
  const managedCodex = pickReviewers(makeState({ agents: agents(true, true) }), 'codex', { mode: 'managed' });
  assert.deepEqual(managedCodex.lenses, ['astra']);
  assert.ok(managedCodex.singleLens);
  assert.deepEqual(pickReviewers(makeState({ agents: agents(true, false) }), 'claude', { mode: 'managed' }), { impossible: 'managed repo needs the codex CLI' });
  const state = makeState({ agents: agents(true, false), intent: { ...makeState().intent, repo: { ...makeState().intent.repo, remote: 'heathdev-me/observatory' } } });
  const [probe] = reviewActions(state, makeWp({ reviewMode: undefined }), { round: 1 });
  const blocked = recordLandStep(state, makeWp(), probe, ok(fixtureText('managed-observatory.json')), {});
  assert.deepEqual([blocked.outcome, blocked.reason], ['block', 'managed repo needs the codex CLI']);
});

const OBS = (over = {}) => makeState({ intent: { ...makeState().intent, repo: { ...makeState().intent.repo, remote: 'heathdev-me/observatory' } }, ...over });
const REVIEWS = join(RUN, 'reviews', 'wp-01');

// The probe, recorded with a captured `managed` line: the queue it expands to.
function expanded(state, fixture, options = { round: 1 }) {
  const wp = makeWp({ reviews: [] });
  const probe = reviewActions(state, wp, options);
  assert.deepEqual(probe.map((a) => [a.step, a.part]), [['review', 'managed']]);
  assert.deepEqual(probe[0].command, ['node', PR_REVIEW, 'managed', '--repo', state.intent.repo.remote]);
  const out = recordLandStep(state, { ...wp, queue: probe }, probe[0], ok(fixtureText(fixture)), {});
  assert.equal(out.outcome, 'continue');
  return out.patch;
}

test('reviewActions: managed observatory → claim, lens ×2, post on one attempt-ref; workit → standalone lenses and post', () => {
  const managed = expanded(OBS(), 'managed-observatory.json');
  assert.equal(managed.reviewMode, 'managed');
  const ref = join(REVIEWS, 'attempt-ref-r1.json');
  assert.deepEqual(managed.queue.map((a) => a.command.slice(2)), [
    ['claim', '--pr', '7', '--repo', 'heathdev-me/observatory', '--attempt-ref-out', ref],
    ['lens', '--attempt-ref', ref, '--lens', 'codex'],
    ['lens', '--attempt-ref', ref, '--lens', 'astra'],
    ['post', '--attempt-ref', ref],
  ]);
  assert.deepEqual(managed.queue.filter((a) => a.part === 'lens').map((a) => a.cwd), [WT, WT]);
  const standalone = expanded(makeState(), 'managed-workit.json');
  assert.equal(standalone.reviewMode, 'standalone');
  assert.deepEqual(standalone.queue.map((a) => [a.step, a.part]), [['review', 'lens'], ['review', 'lens'], ['post', 'post']]);
  assert.deepEqual(standalone.queue[0].command.slice(2), ['lens', '--pr', '7', '--repo', 'sirmaelstrom/workit', '--lens', 'codex', '--cwd', WT,
    '--out', join(REVIEWS, 'codex-r1.json'), '--measure-log', join(RUN, 't1.jsonl')]);
  assert.deepEqual(standalone.queue[2].command.slice(2), ['post', '--pr', '7', '--repo', 'sirmaelstrom/workit',
    '--findings', join(REVIEWS, 'codex-r1.json'), '--findings', join(REVIEWS, 'astra-r1.json')]);
  for (const action of [...managed.queue, ...standalone.queue]) {
    assert.ok(STEPS.includes(action.step));
    assert.equal(action.seam, STEP_SEAM[action.step]);
  }
});

test('reviewActions: no codex CLI on a claude-authored standalone PR → one opus lens and post --single-lens', () => {
  const { queue } = expanded(makeState({ agents: agents(true, false) }), 'managed-workit.json');
  assert.deepEqual(queue.filter((a) => a.part === 'lens').map((a) => a.command[a.command.indexOf('--lens') + 1]), ['opus']);
  assert.deepEqual(queue.at(-1).command.slice(-2), ['--single-lens', 'no codex CLI: opus is the only available lens']);
});

test('managed single-lens: a codex-authored PR on observatory claims with --single-lens --lens astra; post never takes it', () => {
  const state = OBS({ intent: { ...OBS().intent, agent: 'codex' } });
  const { queue } = expanded(state, 'managed-observatory.json');
  const ref = join(REVIEWS, 'attempt-ref-r1.json');
  const reason = pickReviewers(state, 'codex', { mode: 'managed' }).singleLens;
  assert.deepEqual(queue.map((a) => a.command.slice(2)), [
    ['claim', '--pr', '7', '--repo', 'heathdev-me/observatory', '--attempt-ref-out', ref, '--single-lens', reason, '--lens', 'astra'],
    ['lens', '--attempt-ref', ref, '--lens', 'astra'],
    ['post', '--attempt-ref', ref],
  ]);
  assert.equal(queue[1].cwd, WT);
});

test('uncertainty: exit 0 keeps --context-file on every lens; exit 3 drops it', () => {
  const report = join(RUN, 'lane-wp-01-report.md');
  const { queue } = expanded(makeState(), 'managed-workit.json', { round: 1, report });
  const ctx = join(REVIEWS, 'uncertainty.md');
  assert.deepEqual(queue[0].command.slice(2), ['uncertainty', '--report', report, '--out', ctx]);
  const lenses = (q) => q.filter((a) => a.part === 'lens');
  assert.ok(lenses(queue).every((a) => a.command.at(-2) === '--context-file' && a.command.at(-1) === ctx));
  const wp = makeWp({ queue });
  const kept = recordLandStep(makeState(), wp, queue[0], { code: 0, stdout: '', stderr: '' }, {});
  assert.deepEqual([kept.outcome, kept.patch.queue], ['continue', undefined]);
  const dropped = recordLandStep(makeState(), wp, queue[0], { code: 3, stdout: '', stderr: 'no uncertainty' }, {});
  assert.equal(dropped.outcome, 'continue');
  assert.equal(lenses(dropped.patch.queue).length, 2);
  assert.ok(lenses(dropped.patch.queue).every((a) => !a.command.includes('--context-file')));
  assert.ok(dropped.patch.queue.every((a) => a.part !== 'uncertainty'));
});

test('deltaReviewActions: managed claims a fresh round; standalone passes --since per lens', () => {
  const since = sha('5');
  const managed = deltaReviewActions(OBS(), makeWp({ reviewMode: 'managed' }), since);
  const ref = join(REVIEWS, 'attempt-ref-r2.json');
  assert.deepEqual(managed.map((a) => a.command.slice(2)), [
    ['claim', '--pr', '7', '--repo', 'heathdev-me/observatory', '--attempt-ref-out', ref],
    ['lens', '--attempt-ref', ref, '--lens', 'codex', '--since', since],
    ['lens', '--attempt-ref', ref, '--lens', 'astra', '--since', since],
    ['post', '--attempt-ref', ref],
  ]);
  const standalone = deltaReviewActions(makeState(), makeWp({ reviewMode: 'standalone' }), since);
  assert.deepEqual(standalone.filter((a) => a.part === 'lens').map((a) => a.command.slice(-2)), [['--since', since], ['--since', since]]);
  assert.equal(standalone.at(-1).land.scope, 'delta');
});

test('every review runs before the rebase: deltaReviewActions → rebaseActions, never a delta after it', () => {
  const wp = makeWp({ reviewMode: 'standalone' });
  const order = [...deltaReviewActions(makeState(), wp, HEAD), ...rebaseActions(makeState(), wp)].map((a) => a.step);
  assert.ok(order.lastIndexOf('post') < order.indexOf('rebase'));
  const rebased = makeWp({ reviewMode: 'standalone', rebases: [{ from: HEAD, to: sha('c'), equivalent: true }] });
  assert.throws(() => deltaReviewActions(makeState(), rebased, HEAD), /no delta review after a rebase/);
});

test('t2Actions: council off → every available lens and no other; on → council_review, synthesize, challenge', () => {
  const off = t2Actions(makeState(), makeWp({ reviewMode: 'standalone' }), { round: 1 });
  assert.deepEqual(off.filter((a) => a.part === 'lens').map((a) => a.command[a.command.indexOf('--lens') + 1]), ['codex', 'astra', 'opus']);
  const state = makeState({ adapters: { council: { on: true } } });
  const changed = [join(WT, 'lib', 'x.mjs')];
  const on = t2Actions(state, makeWp(), { round: 2, changedPaths: changed });
  assert.deepEqual(on.map((a) => [a.kind, a.step, a.part, a.tool]), [
    ['agent-tool', 'council', 'review', 'council_review'], ['agent-tool', 'council', 'synthesize', 'council_synthesize'], ['agent-tool', 'council', 'challenge', 'council_challenge'],
  ]);
  const workshop = join(RUN, 'council', 'wp-01');
  assert.deepEqual(on[0].args, {
    workshop_path: `${workshop}${sep}`, output_dir: `${join(workshop, 'review-2')}${sep}`,
    surface: 'code', code_root: WT, artifact_paths: changed, round: 2, profile: 'code',
  });
  assert.match(on[0].args.output_dir, /council[\\/]wp-01[\\/]review-2[\\/]$/);
  assert.equal(Object.hasOwn(on[0].args, 'models'), false);
  assert.equal(on[1].head, HEAD);
  assert.deepEqual(on[1].expects, { type: 'json', fields: ['findings', 'seats'] });
});

test('council review is recorded (D20), and the gate accepts it like a posted review', () => {
  const state = makeState({ adapters: { council: { on: true } } });
  const wp = makeWp({ reviews: [], tier: 'T2' });
  const synth = t2Actions(state, wp, { round: 1 })[1];
  const out = recordLandStep(state, wp, synth, { findings: 2, seats: ['astra', 'codex'] }, {});
  assert.deepEqual(out.patch.reviews, [{ round: 1, scope: 'full', tier: 'T2', head: HEAD, lenses: ['astra', 'codex'], reviewId: synth.args.review_dir, findings: 2, verdicts: [], resolved: [] }]);
  assert.equal(gate(state, { ...wp, ...out.patch }).ok, true);
});

test('post findings count (D20): stdout standalone, stderr coordinated, null when neither prints it', () => {
  const line = 'findings       3 → 3 anchored · 0 off-line · 0 not-anchorable · 0 off-diff';
  assert.equal(findingsCount({ stdout: `posted\n${line}\n`, stderr: '' }), 3);
  assert.equal(findingsCount({ stdout: '{"outcome":"posted"}', stderr: `repo x\n${line}\n` }), 3);
  assert.equal(findingsCount({ stdout: '{"outcome":"posted"}', stderr: 'repo x\n' }), null);
  const post = reviewActions(makeState(), makeWp({ reviewMode: 'standalone' }), { round: 1 }).at(-1);
  const recorded = recordLandStep(makeState(), makeWp({ reviews: [] }), post, { code: 0, stdout: '', stderr: '' }, {});
  assert.equal(recorded.patch.reviews[0].findings, null);
});

test('claim refusal (D20): already-posted continues and drops the round\'s lens and post; any other reason blocks', () => {
  const queue = reviewActions(OBS(), makeWp({ reviewMode: 'managed' }), { round: 1 });
  const wp = makeWp({ reviewMode: 'managed', queue });
  const refused = (reason) => ({ code: 1, stdout: JSON.stringify({ outcome: 'refused', reason, retry: 'stop' }), stderr: '' });
  const absorbed = recordLandStep(OBS(), wp, queue[0], refused(ALREADY_REVIEWED), {});
  assert.equal(absorbed.outcome, 'continue');
  assert.ok(absorbed.patch.queue.every((a) => a.part !== 'lens' && a.step !== 'post'));
  const other = recordLandStep(OBS(), wp, queue[0], refused('live-attempt'), {});
  assert.deepEqual([other.outcome, other.reason], ['block', 'claim refused: live-attempt']);
});

test('reply bodies and council ids (D20)', () => {
  const rows = [
    { comment: '101', verdict: 'fixed', evidence: 'red line', commit: '1234567' },
    { comment: '102', verdict: 'refuted', evidence: 'the caller', commit: null },
    { comment: 'C1-1', verdict: 'fixed', evidence: 'council', commit: '89abcde' },
    { comment: '103', verdict: 'conductor', evidence: 'guard', commit: null },
  ];
  const out = recordAdjudication(makeState(), makeWp(), rows);
  const replies = join(REVIEWS, 'replies');
  assert.deepEqual(out.actions.map((a) => [a.kind, a.step, a.part]), [['author', 'reply', 'bodies'], ['shell', 'reply', 'reply'], ['shell', 'reply', 'reply']]);
  assert.deepEqual(out.actions[0].files.map((file) => file.path), [join(replies, '101.md'), join(replies, '102.md')]);
  assert.deepEqual(out.actions[1].command.slice(2), ['reply', '--pr', '7', '--repo', 'sirmaelstrom/workit', '--comment-id', '101', '--body-file', join(replies, '101.md'), '--verdict', 'confirmed', '--adjudicator', 'lane']);
  assert.deepEqual(out.actions[2].command.slice(-4), ['--verdict', 'refuted', '--adjudicator', 'lane']);
  assert.deepEqual(out.conductorRows.map((row) => row.comment), ['103']);
  assert.equal(out.patch.reviews[0].verdicts.length, 4);
  assert.throws(() => recordAdjudication(makeState(), makeWp(), [{ comment: '1', verdict: 'fixed', commit: null }]), /needs its commit sha/);
  const fromTable = parseAmendmentTable('## Amendment 1\n\n| Comment | Verdict | Evidence | Commit |\n|---|---|---|---|\n| `C1-1` | fixed | x | `89abcde` |\n');
  assert.deepEqual(fromTable, [{ comment: 'C1-1', verdict: 'fixed', evidence: 'x', commit: '89abcde' }]);
  const council = recordAdjudication(makeState(), makeWp(), fromTable);
  assert.deepEqual([council.actions, council.patch.reviews[0].verdicts.length], [[], 1]);
  assert.ok(out.actions.every((a) => !(a.command ?? []).includes('C1-1') && !(a.files ?? []).some((file) => file.comment === 'C1-1')));
});

test('threads get resolved (D19.9): table → replies → thread ids → resolve every replied thread → a passing gate', () => {
  const rows = parseAmendmentTable(fixtureText('lane-report-amendment.md'));
  assert.deepEqual(rows, [
    { comment: '4177234272', verdict: 'fixed', evidence: 'the control\'s red line: `not ok 7 - stale base`', commit: '1111111' },
    { comment: '4177234275', verdict: 'refuted', evidence: 'the caller at `lib/land.mjs:12` already checks it | quoted', commit: null },
    { comment: '4177261828', verdict: 'judgment', evidence: 'nothing runnable settles the naming', commit: null },
  ]);
  const state = makeState();
  let wp = makeWp();
  const adjudicated = recordAdjudication(state, wp, rows);
  wp = { ...wp, ...adjudicated.patch };
  const replied = adjudicated.actions.filter((a) => a.part === 'reply').map((a) => a.command[a.command.indexOf('--comment-id') + 1]);
  assert.deepEqual(replied, ['4177234272', '4177234275', '4177261828']);
  const [lookup] = resolveThreadActions(state, wp, replied);
  assert.deepEqual(lookup.command.slice(0, 4), ['gh', 'api', 'graphql', '-f']);
  assert.deepEqual(lookup.command.slice(5), ['-F', 'owner=sirmaelstrom', '-F', 'name=workit', '-F', 'pr=7']);
  assert.ok(!/["']/.test(THREADS_QUERY) && !/["']/.test(RESOLVE_MUTATION));
  const mapped = recordLandStep(state, { ...wp, queue: [lookup] }, lookup, ok(fixtureText('review-threads-145.json')), {});
  assert.deepEqual(mapped.patch.threadIds, { 4177234272: 'PRRT_kwDOS_8yoc6oxjYH', 4177234275: 'PRRT_kwDOS_8yoc6oxjYK', 4177261828: 'PRRT_kwDOS_8yoc6oxnvx' });
  const resolves = mapped.patch.queue;
  assert.deepEqual(resolves.map((a) => a.command.at(-1)), ['threadId=PRRT_kwDOS_8yoc6oxjYH', 'threadId=PRRT_kwDOS_8yoc6oxjYK', 'threadId=PRRT_kwDOS_8yoc6oxnvx']);
  for (const action of resolves) wp = { ...wp, ...recordLandStep(state, wp, action, ok('{}'), {}).patch };
  assert.deepEqual(wp.reviews.at(-1).resolved, ['PRRT_kwDOS_8yoc6oxjYH', 'PRRT_kwDOS_8yoc6oxjYK', 'PRRT_kwDOS_8yoc6oxnvx']);
  assert.equal(gate(state, wp, { threads: 0 }).ok, true);
  assert.equal(recordLandStep(state, wp, resolves[0], { code: 1, stdout: '', stderr: 'gh: Could not resolve' }, {}).outcome, 'block');
});

test('recordLandStep outcomes (D19.15)', () => {
  const state = makeState();
  const wp = makeWp();
  const gateAction = { kind: 'shell', step: 'gate', part: 'gate', command: ['node', 'conduct.mjs', 'land', 'gate'] };
  assert.equal(recordLandStep(state, wp, gateAction, ok('{}'), {}).outcome, 'continue');
  const waiting = recordLandStep(state, wp, gateAction, { code: 6, stdout: '{}', stderr: '' }, {});
  assert.deepEqual([waiting.outcome, waiting.waitMs], ['wait', 60000]);
  const failed = (out) => ({ code: 5, stdout: JSON.stringify({ ok: false, pending: false, failures: ['unresolved review threads'], ...out }), stderr: '' });
  const amend = recordLandStep(state, wp, gateAction, failed({}), {});
  assert.deepEqual([amend.outcome, amend.reason, amend.patch.mergeLock], ['amend', 'unresolved review threads', null]);
  assert.equal(recordLandStep(state, wp, gateAction, failed({ blocked: true }), {}).outcome, 'block');
  const stale = recordLandStep(state, wp, gateAction, failed({ staleBase: true }), {});
  assert.deepEqual([stale.outcome, stale.patch.queue.map((a) => a.part).slice(0, 2)], ['continue', ['fetch', 'pre-head']]);
  const full = recordLandStep(state, { ...wp, reviewMode: 'standalone' }, gateAction, failed({ needsFullReview: true }), {});
  assert.equal(full.outcome, 'continue');
  assert.equal(full.patch.queue.at(-1).land.round, 2);
  assert.equal(full.patch.queue.at(-1).land.scope, 'full');
  const merged = { kind: 'shell', step: 'merged', part: 'merged', command: ['node'] };
  const anomaly = recordLandStep(state, wp, merged, { code: 5, stdout: '{}', stderr: '' }, { now: () => NOW });
  assert.deepEqual([anomaly.outcome, anomaly.reason, anomaly.patch.mergeLock], ['block', 'merged tree differs from the checked head', null]);
  assert.deepEqual(anomaly.patch.dispatchHalt, { reason: 'merged tree differs from the checked head', since: new Date(NOW).toISOString() });
  assert.deepEqual(recordLandStep(state, wp, merged, ok('{}'), {}).patch, { mergeLock: null });
  const [fetch, , rebase] = rebaseActions(state, wp);
  const conflict = recordLandStep(state, wp, rebase, { code: 1, stdout: 'CONFLICT (content)', stderr: '' }, {});
  assert.deepEqual([conflict.outcome, conflict.patch.mergeLock], ['amend', null]);
  assert.deepEqual(conflict.patch.queue[0].command, ['git', '-C', WT, 'rebase', '--abort']);
  const other = makeState({ mergeLock: { wpId: 'WP-02', since: minutesAgo(1) } });
  const yielded = recordLandStep(other, wp, fetch, ok(), { now: () => NOW });
  assert.equal(yielded.outcome, 'wait');
  assert.equal(Object.hasOwn(yielded.patch, 'mergeLock'), false);
  const taken = recordLandStep(makeState({ mergeLock: null }), wp, fetch, ok(), { now: () => NOW });
  assert.deepEqual(taken.patch.mergeLock, { wpId: 'WP-01', since: new Date(NOW).toISOString() });
  const mergeCommit = mergeActions(state, wp, HEAD)[2];
  assert.deepEqual(recordLandStep(state, wp, mergeCommit, ok(fixtureText('pr-view-150-merge-commit.json')), {}).patch, { merge: { sha: '37e79605735904eac875b000ad1b2ca55885db89' } });
});

test('rebaseActions: fetch, pre-head, rebase, post-heads, push --force-with-lease, then a wait; post-heads records the rebase', () => {
  const state = makeState();
  const actions = rebaseActions(state, makeWp());
  assert.deepEqual(actions.map((a) => a.part), ['fetch', 'pre-head', 'rebase', 'post-heads', 'push', 'ci-wait']);
  assert.deepEqual(actions[4].command, ['git', '-C', WT, 'push', '--force-with-lease', 'origin', 'conduct/fixture/wp-01']);
  assert.deepEqual(actions[3].command, ['git', '-C', WT, 'rev-parse', 'HEAD', 'origin/main']);
  assert.equal(actions.at(-1).kind, 'wait');
  const from = sha('f');
  const wp = makeWp({ rebaseFrom: from });
  const exec = gateExec({ patchIds: { [`diff ${BASE} ${from}\n`]: 'p', [`diff ${sha('9')} ${HEAD}\n`]: 'p' } });
  const out = recordLandStep(state, wp, actions[3], ok(`${HEAD}\n${sha('9')}\n`), { exec });
  assert.deepEqual(out.patch.rebases.map((r) => [r.from, r.to, r.newBase, r.equivalent]), [[from, HEAD, sha('9'), true]]);
});

test('tierFor (D19.11): raise only, on a contract path or a test file', () => {
  const contractPaths = JSON.parse(readFileSync(join(HERE, '..', '..', '..', '..', '.workit', 'conduct.json'), 'utf8')).contractPaths;
  assert.equal(tierFor({ tier: 'T2' }, ['README.md'], []), 'T2');
  assert.equal(tierFor({ tier: 'T1' }, ['scripts/lane.mjs'], contractPaths), 'T2');
  assert.equal(tierFor({ tier: 'T1' }, ['scripts/lane.mjs'], []), 'T1');
  assert.equal(tierFor({ tier: 'T1' }, ['skills/conduct/scripts/lib/x.test.mjs'], []), 'T2');
  assert.equal(tierFor({ tier: 'T1' }, ['skills/spec-validate/tests/fixture.md'], []), 'T2');
  assert.equal(tierFor({ tier: 'T0' }, ['README.md'], []), 'T0');
});

test('runLandVerb I/O (D19.21): returns { code, out } and writes nothing to stdout', async (t) => {
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
  t.after(() => { process.stdout.write = original; });
  const out = await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(makeState({ wps: [makeWp()] }), gateExec()));
  process.stdout.write = original;
  assert.deepEqual(Object.keys(out).sort(), ['code', 'out']);
  assert.equal(out.code, 0);
  assert.deepEqual(writes, []);
});

// runLandVerb loads state.json through deps; this serves one in memory.
function verbDeps(state, exec) {
  const path = join(RUN, 'state.json');
  return { exec, now: () => NOW, exists: (p) => p === path, read: (p) => { if (p !== path) throw new Error(`unexpected read ${p}`); return JSON.stringify(state); } };
}
