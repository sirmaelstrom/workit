import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  tierFor, pickReviewers, reviewActions, deltaReviewActions, t2Actions, parseAmendmentTable, recordAdjudication,
  resolveThreadActions, rebaseActions, recordRebase, mergeLockFor, gateCheck, mergeActions, recordLandStep, runLandVerb,
  parsePages, findingsCount, isTestPath, THREADS_QUERY, RESOLVE_MUTATION, ALREADY_REVIEWED, TREE_MISMATCH,
} from './land.mjs';
import { STEPS, STEP_SEAM } from './state.mjs';
import { runConduct } from '../conduct.mjs';

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
const BASE_TIP = sha('9');
const NOW = Date.parse('2026-10-04T20:00:00.000Z');
const minutesAgo = (n) => new Date(NOW - n * 60000).toISOString();

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const captured = (name) => (({ code, stdout, stderr }) => ({ code, stdout, stderr }))(fixtureJson(name));
const GREEN = ok(fixtureText('check-runs-green.json'));
const ZERO = ok(fixtureText('check-runs-zero.json'));
const UNKNOWN = captured('unknown-sha.json');
const STATUS = ok(fixtureText('commit-status-green.json'));
const REQUIRED = ok(fixtureText('required-checks.json'));
const UNPROTECTED = captured('required-checks-unprotected.json');
// Derived from the green captures by editing them (fixture README).
function derived(edit, name = 'check-runs-green.json') {
  const page = JSON.parse(fixtureText(name));
  edit(page);
  return ok(JSON.stringify(page));
}
const FAILED = derived((page) => { page.check_runs[0].conclusion = 'failure'; });
const PENDING = derived((page) => { page.check_runs[0].status = 'in_progress'; page.check_runs[0].conclusion = null; });

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
    id: 'WP-01', name: 'fixture', tier: 'T1', state: 'gate', files: ['lib/x.mjs', 'lib/fix.mjs', 'lib/x.test.mjs', 'skills/spec/scripts/x.mjs'],
    lane: { worktree: WT, branch: 'conduct/fixture/wp-01', base: BASE },
    pr: { number: 7, head: HEAD },
    reviews: [{ round: 1, scope: 'full', tier: 'T1', head: HEAD, lenses: ['codex', 'astra'], verdicts: [], resolved: [] }],
    rebases: [], gate: null, queue: [],
    ...over,
  };
}

// A fake executor for the gate's programs. Every call is logged with its input.
// `tailFiles` answers the tail diffs: with --no-renames each entry is its own
// row; without it, a `renames` pair collapses to its destination (git's default).
function gateExec(o = {}) {
  const { head = HEAD, fetch = 0, ancestor = 0, ci = GREEN, status = STATUS, required = REQUIRED, baseRuns = GREEN, threads = 0,
    config = null, tailFiles = [], renames = {}, tailLines = 1, ancestry = {}, tailCommits = [], diffQuiet = 0, patchIds = {}, diffs = {}, pr = {} } = o;
  const calls = [];
  const exec = (program, args, options = {}) => {
    calls.push({ program, args, input: options.input });
    const has = (flag) => args.includes(flag);
    if (program === 'git' && args[2] === 'rev-parse') return ok(`${args[3] === 'HEAD' ? head : BASE_TIP}\n`);
    if (program === 'gh' && args[1] === 'view') return ok(JSON.stringify({ headRefOid: head, baseRefName: 'main', state: 'OPEN', ...pr }));
    if (program === 'git' && args[2] === 'fetch') return { code: fetch, stdout: '', stderr: fetch ? 'fatal: unable to access' : '' };
    if (program === 'git' && args[2] === 'merge-base') {
      if (args[4] === 'origin/main') return { code: ancestor, stdout: '', stderr: '' };
      return { code: ancestry[`${args[4]}..${args[5]}`] ?? 0, stdout: '', stderr: '' };
    }
    if (program === 'gh' && /\/check-runs\?/.test(args[1])) return args[1].includes(BASE_TIP) ? baseRuns : ci;
    if (program === 'gh' && /\/status\?/.test(args[1])) return status;
    if (program === 'gh' && /required_status_checks$/.test(args[1])) return required;
    if (program === 'node' && args[1] === 'threads') return { code: threads, stdout: '', stderr: threads ? 'open threads' : '' };
    if (program === 'git' && args[2] === 'show') return config === null ? { code: 128, stdout: '', stderr: 'fatal: path \'.workit/conduct.json\' does not exist in \'origin/main\'' } : ok(config);
    const rows = has('--no-renames') ? tailFiles : tailFiles.filter((file) => !Object.hasOwn(renames, file));
    if (program === 'git' && args[2] === 'diff' && has('--quiet') && has('--no-renames')) return { code: tailFiles.length ? 1 : 0, stdout: '', stderr: '' };
    if (program === 'git' && args[2] === 'diff' && has('--numstat')) {
      return ok(rows.map((file) => `${typeof tailLines === 'object' ? tailLines[file] ?? 1 : tailLines}\t0\t${file}`).join('\n'));
    }
    if (program === 'git' && args[2] === 'diff' && has('--name-only')) return ok(rows.join('\n'));
    if (program === 'git' && args[2] === 'diff' && has('--quiet')) return { code: diffQuiet, stdout: '', stderr: '' };
    if (program === 'git' && args[2] === 'diff') return ok(diffs[`${args.at(-2)} ${args.at(-1)}`] ?? `diff ${args.at(-2)} ${args.at(-1)}\n`);
    if (program === 'git' && args[2] === 'patch-id') return ok(Object.hasOwn(patchIds, options.input) ? patchIds[options.input] : `p0 ${sha('0')}\n`);
    if (program === 'git' && args[2] === 'rev-list') return ok(tailCommits.join('\n'));
    throw new Error(`unexpected exec: ${program} ${args.join(' ')}`);
  };
  exec.calls = calls;
  return exec;
}

const gate = (state, wp, options = {}, now = NOW) => gateCheck(state, wp, { exec: gateExec(options), now: () => now });
const olderReview = (over = {}) => makeWp({ reviews: [{ round: 1, scope: 'full', head: sha('e'), verdicts: [] }], ...over });
const gateJson = (out) => JSON.stringify({ ok: false, pending: false, blocked: false, head: HEAD, failures: [], causes: [], ...out });
const GATE_OK = ok(gateJson({ ok: true }));
const GATE_PENDING = { code: 6, stdout: gateJson({ pending: true }), stderr: '' };

test('gateCheck: ok for green CI, threads exit 0, a review at head, a fresh base and the lock held', () => {
  const out = gate(makeState(), makeWp());
  assert.deepEqual(out, { ok: true, pending: false, blocked: false, head: HEAD, failures: [], causes: [], unreviewedTail: null, needsFullReview: false, staleBase: false });
});

test('gateCheck: one failed run fails, naming it', () => {
  const out = gate(makeState(), makeWp(), { ci: FAILED });
  assert.deepEqual([out.ok, out.pending, out.causes], [false, false, ['ci']]);
  assert.match(out.failures.join(), /CI failed at head: Tests \(node --test, windows\) \(failure\)/);
});

test('gateCheck: zero check-runs are pending, then "no CI at head" 10 minutes after pendingSince', () => {
  const fresh = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(2) } }), { ci: ZERO });
  assert.deepEqual([fresh.ok, fresh.pending, fresh.failures], [false, true, []]);
  const late = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(11) } }), { ci: ZERO });
  assert.deepEqual([late.ok, late.pending, late.failures], [false, false, ['no CI at head']]);
});

test('C2-3 pendingSince is initialized by the wait record, kept per head, reset on a new head; a module-produced state reaches the deadline', () => {
  const state = makeState();
  const t0 = NOW - 11 * 60000;
  const action = { kind: 'shell', step: 'gate', part: 'gate', command: ['node', 'conduct.mjs', 'land', 'gate'] };
  let wp = makeWp();
  const first = gateCheck(state, wp, { exec: gateExec({ ci: ZERO }), now: () => t0 });
  const waited = recordLandStep(state, wp, action, { code: 6, stdout: JSON.stringify(first), stderr: '' }, { now: () => t0 });
  assert.deepEqual([waited.outcome, waited.patch.gate.pendingSince], ['wait', new Date(t0).toISOString()]);
  wp = { ...wp, ...waited.patch };
  const again = recordLandStep(state, wp, action, { code: 6, stdout: JSON.stringify(first), stderr: '' }, { now: () => t0 + 60000 });
  assert.equal(again.patch.gate.pendingSince, new Date(t0).toISOString(), 'kept across pending results at the same head');
  const moved = recordLandStep(state, wp, action, { code: 6, stdout: JSON.stringify({ ...first, head: sha('c') }), stderr: '' }, { now: () => t0 + 60000 });
  assert.equal(moved.patch.gate.pendingSince, new Date(t0 + 60000).toISOString(), 'reset on a new head');
  const late = gateCheck(state, wp, { exec: gateExec({ ci: ZERO }), now: () => NOW });
  assert.deepEqual(late.failures, ['no CI at head']);
  assert.equal(recordLandStep(state, wp, action, GATE_OK, { now: () => NOW }).patch.gate.pendingSince, null);
});

test('gateCheck: a sha GitHub does not have (422) is "no CI at head"', () => {
  assert.match(UNKNOWN.stderr, /HTTP 422/);
  assert.deepEqual(gate(makeState(), makeWp(), { ci: UNKNOWN }).failures, ['no CI at head']);
});

test('C1-2 CI completeness: total_count, trailing text, a malformed page and duplicate ids are unreadable', () => {
  const short = derived((page) => { page.total_count = 4; });
  const missingRuns = ok(`${GREEN.stdout.trim()}{"total_count":3}`);
  const duplicate = derived((page) => { page.check_runs[1].id = page.check_runs[0].id; });
  for (const [label, ci, pattern] of [['short', short, /CI incomplete/], ['trailing', ok(`${GREEN.stdout.trim()}NOT_JSON`), /text outside a page/],
    ['malformed page', missingRuns, /malformed/], ['duplicate ids', duplicate, /CI incomplete/]]) {
    const out = gate(makeState(), makeWp(), { ci });
    assert.equal(out.ok, false, label);
    assert.match(out.failures.join(), pattern, label);
    assert.deepEqual(out.causes, ['infra'], label);
  }
});

test('C2-5 complete input: a quoted suffix or an unterminated string after a page is unreadable', () => {
  assert.throws(() => parsePages(`${GREEN.stdout.trim()}"garbage"`), /text outside a page/);
  assert.throws(() => parsePages(`${GREEN.stdout.trim()}"unterminated`), /text outside a page/);
  assert.throws(() => parsePages('{"a":"unterminated'), /truncated/);
  assert.equal(parsePages(`${GREEN.stdout.trim()}\n ${GREEN.stdout.trim()}\n`).length, 2);
  for (const ci of [ok(`${GREEN.stdout.trim()}"garbage"`), ok(`${GREEN.stdout.trim()}"unterminated`)]) {
    assert.match(gate(makeState(), makeWp(), { ci }).failures.join(), /CI unreadable/);
  }
});

test('C2-5 legacy statuses are read on every page and must be complete', () => {
  const exec = gateExec();
  gateCheck(makeState(), makeWp(), { exec, now: () => NOW });
  assert.deepEqual(exec.calls.find((call) => /\/status\?/.test(call.args[1] ?? '')).args, ['api', `repos/sirmaelstrom/workit/commits/${HEAD}/status?per_page=100`, '--paginate']);
  const page = (contexts, total) => JSON.stringify({ state: 'success', total_count: total, statuses: contexts.map((context) => ({ context, state: 'success' })) });
  assert.equal(gate(makeState(), makeWp(), { status: ok(`${page(['a'], 2)}${page(['b'], 2)}`) }).ok, true);
  assert.match(gate(makeState(), makeWp(), { status: ok(page(['a'], 2)) }).failures.join(), /commit statuses unreadable/);
});

test('C2-2 expected checks: a required check not yet registered waits, then blocks with cause ci-missing-check', () => {
  const noScan = derived((page) => { page.check_runs = page.check_runs.filter((run) => run.name !== 'Secret scan (gitleaks)'); page.total_count = page.check_runs.length; });
  const early = gate(makeState(), makeWp(), { ci: noScan });
  assert.deepEqual([early.ok, early.pending, early.failures], [false, true, []]);
  const late = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(11) } }), { ci: noScan });
  assert.deepEqual([late.failures, late.causes], [['expected check missing at head: Secret scan (gitleaks)'], ['ci-missing-check']]);
  const action = { kind: 'shell', step: 'gate', part: 'gate', command: ['node'] };
  assert.equal(recordLandStep(makeState(), makeWp(), action, { code: 6, stdout: JSON.stringify(early), stderr: '' }, { now: () => NOW }).outcome, 'wait');
  const recorded = recordLandStep(makeState(), makeWp(), action, { code: 5, stdout: JSON.stringify(late), stderr: '' }, { now: () => NOW });
  assert.deepEqual([recorded.outcome, recorded.patch.mergeLock, recorded.patch.queue], ['block', null, []]);
});

test('C1-2 expected checks: an unprotected base falls back to the checks that ran on it', () => {
  assert.match(UNPROTECTED.stderr, /HTTP 404/);
  const extraOnBase = derived((page) => { page.check_runs.push({ ...page.check_runs[0], id: 1, name: 'Deploy' }); page.total_count += 1; });
  const out = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(11) } }), { required: UNPROTECTED, baseRuns: extraOnBase });
  assert.deepEqual(out.failures, ['expected check missing at head: Deploy']);
  assert.equal(gate(makeState(), makeWp(), { required: UNPROTECTED }).ok, true);
  assert.deepEqual(gate(makeState(), makeWp(), { required: { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' } }).causes, ['infra']);
});

test('C2-4 required checks are the union of contexts and checks: a checks-only protection still requires its check', () => {
  const checksOnly = ok(JSON.stringify({ strict: true, contexts: [], checks: [{ context: 'Deploy gate', app_id: 1 }] }));
  const out = gate(makeState(), makeWp({ gate: { head: HEAD, pendingSince: minutesAgo(11) } }), { required: checksOnly });
  assert.deepEqual(out.failures, ['expected check missing at head: Deploy gate']);
  const both = ok(JSON.stringify({ contexts: ['Tests (node --test)'], checks: [{ context: 'Secret scan (gitleaks)' }] }));
  assert.equal(gate(makeState(), makeWp(), { required: both }).ok, true);
});

test('C1-27 legacy commit statuses are read: a failed status fails, a pending one is pending', () => {
  const statusWith = (state) => derived((body) => { body.statuses = [{ context: 'ci/legacy', state }]; body.total_count = 1; }, 'commit-status-green.json');
  assert.match(gate(makeState(), makeWp(), { status: statusWith('failure') }).failures.join(), /ci\/legacy \(failure\)/);
  assert.equal(gate(makeState(), makeWp(), { status: statusWith('pending') }).pending, true);
  assert.equal(gate(makeState(), makeWp(), { status: statusWith('success') }).ok, true);
});

test('gateCheck: threads exit 8 fails; any other threads exit is unreadable', () => {
  assert.deepEqual(gate(makeState(), makeWp(), { threads: 8 }).failures, ['unresolved review threads']);
  const other = gate(makeState(), makeWp(), { threads: 6 });
  assert.match(other.failures[0], /^threads unreadable \(exit 6\)/);
  assert.deepEqual(other.causes, ['infra']);
});

test('gateCheck: a worktree head that differs from the PR headRefOid is "head mismatch"', () => {
  const out = gate(makeState(), makeWp(), { pr: { headRefOid: sha('c') } });
  assert.deepEqual([out.ok, out.failures], [false, ['head mismatch']]);
});

test('C1-29 the PR must be open and target the default branch', () => {
  assert.deepEqual(gate(makeState(), makeWp(), { pr: { state: 'CLOSED' } }).failures, ['PR is CLOSED, not OPEN']);
  const base = gate(makeState(), makeWp(), { pr: { baseRefName: 'develop' } });
  assert.deepEqual([base.failures, base.causes], [['PR base is develop, not main'], ['pr-state']]);
});

test('gateCheck: a review at an older head whose tail changes a .mjs file fails', () => {
  const out = gate(makeState(), olderReview(), { tailFiles: ['skills/conduct/scripts/lib/land.mjs', 'README.md'] });
  assert.equal(out.ok, false);
  assert.match(out.failures.join(), /review does not cover head: tail .* changes skills\/conduct\/scripts\/lib\/land\.mjs$/);
});

test('C2-6 an uncovered review blocks with cause review-uncovered, never amend', () => {
  const tail = gate(makeState(), olderReview(), { tailFiles: ['lib/x.mjs'] });
  assert.deepEqual(tail.causes, ['review-uncovered']);
  const none = gate(makeState(), makeWp({ reviews: [] }));
  assert.deepEqual([none.failures, none.causes], [['no review of this WP'], ['review-uncovered']]);
  for (const out of [tail, none]) {
    const recorded = recordLandStep(makeState(), makeWp(), GATE_ACTION, { code: 5, stdout: JSON.stringify(out), stderr: '' }, { now: () => NOW });
    assert.deepEqual([recorded.outcome, recorded.patch.queue], ['block', []]);
  }
});

test('gateCheck: a tail that changes only plain *.md is ok as trivial; an empty net diff is trivial', () => {
  const out = gate(makeState(), olderReview(), { tailFiles: ['README.md', 'docs/notes.md'] });
  assert.deepEqual([out.ok, out.unreviewedTail], [true, `${sha('e')}..${HEAD} (trivial)`]);
  assert.equal(gate(makeState(), olderReview(), { tailFiles: [] }).unreviewedTail, `${sha('e')}..${HEAD} (trivial)`);
});

test('trivial is docs only: tests, fixtures and behavior-bearing Markdown are not trivial (C1-10)', () => {
  for (const file of ['skills/conduct/scripts/lib/land.test.mjs', 'skills/conduct/scripts/__fixtures__/land/check-runs-green.json',
    'skills/conduct/scripts/__fixtures__/land/README.md', 'skills/conduct/SKILL.md', 'reference/templates/review-council/code-review.md',
    'agents/x.md', 'commands/y.md', '.claude-plugin/notes.md', 'spec/behaviour.md', 'pkg/x_test.md']) {
    const out = gate(makeState(), olderReview(), { tailFiles: [file] });
    assert.equal(out.ok, false, file);
    assert.equal(out.unreviewedTail, null, file);
  }
  const config = JSON.stringify({ trivialExclude: [], contractPaths: ['docs/contract.md'] });
  assert.equal(gate(makeState(), olderReview(), { tailFiles: ['skills/conduct/SKILL.md'], config }).ok, true);
  assert.equal(gate(makeState(), olderReview(), { tailFiles: ['docs/contract.md'], config }).ok, false);
});

test('C1-6 a production file renamed to .md is not a docs-only tail: the tail is read with --no-renames', () => {
  const exec = gateExec({ tailFiles: ['lib/x.mjs', 'lib/x.md'], renames: { 'lib/x.mjs': 'lib/x.md' } });
  const out = gateCheck(makeState(), olderReview(), { exec, now: () => NOW });
  assert.equal(out.ok, false);
  assert.match(out.failures.join(), /changes lib\/x\.mjs/);
  assert.ok(exec.calls.filter((call) => call.args.includes('--numstat')).every((call) => call.args.includes('--no-renames')));
});

const C1 = sha('1');
const C2 = sha('2');
const D = sha('d');
const anchorReview = (verdicts) => ({ round: 2, scope: 'delta', since: sha('f'), head: D, reviewId: 'review-2', verdicts });
const postCapWp = (over = {}) => makeWp({
  reviews: [
    { round: 1, scope: 'full', head: sha('f'), verdicts: [{ comment: '11', verdict: 'fixed', commit: sha('3').slice(0, 7) }] },
    anchorReview([{ comment: '12', verdict: 'fixed', commit: C1.slice(0, 7) }, { comment: '13', verdict: 'fixed', commit: C2 }]),
  ],
  ...over,
});
const TAIL = { tailFiles: ['lib/x.mjs'], tailCommits: [C2, C1] };
// The binding the gate asks for, as the driver's inspection would record it.
function inspected(wp, options = TAIL, verdict = 'addresses-findings', edit = (binding) => binding) {
  const { inspect } = gate(makeState(), wp, options);
  const { files, anchor, ...binding } = inspect;
  return { ...wp, inspections: [{ verdict, ...edit(binding) }] };
}

test('C1-1 post-cap: the anchoring delta review\'s fixes, an inspection of exactly that tail, then ok', () => {
  const needs = gate(makeState(), postCapWp(), TAIL);
  assert.deepEqual([needs.ok, needs.causes, needs.failures], [false, ['inspect'], [`post-cap tail ${D}..${HEAD} needs an inspection`]]);
  assert.deepEqual([needs.inspect.tail, needs.inspect.head, needs.inspect.files, needs.inspect.anchor], [`${D}..${HEAD}`, HEAD, ['lib/x.mjs'], 'review-2']);
  const out = gate(makeState(), inspected(postCapWp()), TAIL);
  assert.deepEqual([out.ok, out.unreviewedTail], [true, `${D}..${HEAD} (post-cap)`]);
  assert.deepEqual(gate(makeState(), inspected(postCapWp(), TAIL, 'addresses-findings', (b) => ({ ...b, head: sha('c') })), TAIL).causes, ['inspect']);
  assert.deepEqual(gate(makeState(), inspected(postCapWp(), TAIL, 'unrelated-change'), TAIL).causes, ['tail-out-of-bounds']);
});

test('C2-7 the inspection binds tail, head, the anchoring review and its findings', () => {
  const wp = inspected(postCapWp());
  assert.equal(gate(makeState(), wp, TAIL).ok, true);
  const otherTail = inspected(postCapWp(), TAIL, 'addresses-findings', (b) => ({ ...b, tail: `${sha('e')}..${HEAD}` }));
  assert.deepEqual(gate(makeState(), otherTail, TAIL).causes, ['inspect'], 'same head, a different tail');
  const changed = { ...wp, reviews: [wp.reviews[0], anchorReview([...wp.reviews[1].verdicts, { comment: '14', verdict: 'refuted', commit: null }])] };
  assert.deepEqual(gate(makeState(), changed, TAIL).causes, ['inspect'], 'same tail, the findings changed');
  const otherReview = { ...wp, reviews: [wp.reviews[0], { ...wp.reviews[1], round: 3 }] };
  assert.deepEqual(gate(makeState(), otherReview, TAIL).causes, ['inspect'], 'same tail, another review');
  assert.equal(typeof gate(makeState(), postCapWp(), TAIL).inspect.findingsHash, 'string');
});

test('C1-1 post-cap: fixes come only from the anchoring review, which must be a delta; one unadjudicated commit fails', () => {
  assert.match(gate(makeState(), inspected(postCapWp()), { ...TAIL, tailCommits: [C2, sha('9')] }).failures.join(), /not fixed rows of the anchoring review/);
  assert.match(gate(makeState(), inspected(postCapWp()), { ...TAIL, tailCommits: [C2, sha('3')] }).failures.join(), /not fixed rows of the anchoring review/);
  const full = postCapWp();
  full.reviews[1].scope = 'full';
  assert.match(gate(makeState(), full, TAIL).failures.join(), /review does not cover head/);
});

test('C1-1 post-cap bounds: more than 400 production lines, or a file outside the WP\'s Files, is out of bounds', () => {
  const big = gate(makeState(), postCapWp(), { ...TAIL, tailLines: 401 });
  assert.deepEqual([big.ok, big.causes], [false, ['tail-out-of-bounds']]);
  assert.match(gate(makeState(), postCapWp(), { ...TAIL, tailFiles: ['lib/x.mjs', 'lib/other.mjs'] }).failures.join(), /outside the WP's Files: lib\/other\.mjs/);
  assert.equal(gate(makeState(), inspected(postCapWp(), { ...TAIL, tailLines: 400 }), { ...TAIL, tailLines: 400 }).ok, true);
  const mixed = { ...TAIL, tailFiles: ['lib/x.mjs', 'lib/x.test.mjs'], tailLines: { 'lib/x.mjs': 300, 'lib/x.test.mjs': 300 } };
  const withTest = gate(makeState(), inspected(postCapWp(), mixed), mixed);
  assert.deepEqual([withTest.ok, withTest.unreviewedTail], [true, `${D}..${HEAD} (post-cap)`]);
  assert.equal(gate(makeState(), olderReview(), { tailFiles: ['lib/x.test.mjs'] }).ok, false);
});

test('C2-8 test paths: names anywhere, test/ tests/ spec/ only at the root; skills/spec/ is production; the inspection lists every non-trivial path', () => {
  for (const path of ['lib/x.test.mjs', 'pkg/x_test.go', 'a/b.spec.ts', 'a/__tests__/x.js', 'a/__fixtures__/x.json', 'test/x.js', 'tests/x.md', 'spec/x.rb']) assert.equal(isTestPath(path), true, path);
  for (const path of ['skills/spec/scripts/x.mjs', 'skills/spec-validate/tests/x.mjs', 'lib/testing.mjs', 'docs/spec/x.md']) assert.equal(isTestPath(path), false, path);
  const specTail = { ...TAIL, tailFiles: ['skills/spec/scripts/x.mjs'], tailLines: 5000 };
  assert.deepEqual(gate(makeState(), inspected(postCapWp(), { ...specTail, tailLines: 1 }), specTail).causes, ['tail-out-of-bounds']);
  const mixed = gate(makeState(), postCapWp(), { ...TAIL, tailFiles: ['lib/x.mjs', 'lib/x.test.mjs'] });
  assert.deepEqual(mixed.inspect.files, ['lib/x.mjs', 'lib/x.test.mjs']);
  const testOnly = gate(makeState(), postCapWp(), { ...TAIL, tailFiles: ['lib/x.test.mjs'] });
  assert.deepEqual([testOnly.causes, testOnly.inspect.files], [['inspect'], ['lib/x.test.mjs']]);
});

test('post-cap after an equivalent rebase: the tail is computed against the pre-rebase from', () => {
  const pre = sha('7');
  const wp = postCapWp({ rebases: [{ from: pre, to: HEAD, oldBase: BASE, newBase: sha('8'), equivalent: true }] });
  const exec = gateExec(TAIL);
  const out = gateCheck(makeState(), inspected(wp), { exec, now: () => NOW });
  assert.deepEqual([out.ok, out.unreviewedTail], [true, `${D}..${pre} (post-cap)`]);
  assert.ok(exec.calls.some((call) => call.args.join(' ') === `-C ${WT} rev-list ${D}..${pre}`));
});

test('C1-7 review → equivalent rebase → amendment → gate: the tail past the rebased head is classified', () => {
  const t = sha('7');
  const wp = makeWp({ reviews: [{ round: 1, scope: 'full', head: sha('f'), verdicts: [] }], rebases: [{ from: sha('f'), to: t, equivalent: true }] });
  const docs = gate(makeState(), wp, { tailFiles: ['README.md'], ancestry: { [`${sha('f')}..${HEAD}`]: 1 } });
  assert.deepEqual([docs.ok, docs.unreviewedTail], [true, `${t}..${HEAD} (trivial)`]);
  const code = gate(makeState(), wp, { tailFiles: ['lib/x.mjs'], ancestry: { [`${sha('f')}..${HEAD}`]: 1 } });
  assert.match(code.failures.join(), new RegExp(`tail ${t}\\.\\.${HEAD} changes lib/x\\.mjs`));
});

test('C2-1 review A → equivalent rebase B → amendment C → equivalent rebase D: coverage for B..C, bound to head D', () => {
  const [A, B, C] = [sha('4'), sha('5'), sha('6')];
  const rebases = [{ from: A, to: B, equivalent: true }, { from: C, to: HEAD, equivalent: true }];
  const ancestry = { [`${A}..${C}`]: 1 };
  const docs = gate(makeState(), makeWp({ reviews: [{ round: 1, scope: 'full', head: A, verdicts: [] }], rebases }), { tailFiles: ['README.md'], ancestry });
  assert.deepEqual([docs.ok, docs.unreviewedTail], [true, `${B}..${C} (trivial)`]);
  const anchor = { round: 2, scope: 'delta', since: sha('f'), head: A, reviewId: 'review-2', verdicts: [{ comment: '1', verdict: 'fixed', commit: C }] };
  const wp = makeWp({ reviews: [anchor], rebases });
  const opts = { tailFiles: ['lib/x.mjs'], tailCommits: [C], ancestry };
  const needs = gate(makeState(), wp, opts);
  assert.deepEqual([needs.causes, needs.inspect.tail, needs.inspect.head], [['inspect'], `${B}..${C}`, HEAD]);
  assert.deepEqual([gate(makeState(), inspected(wp, opts), opts).ok, gate(makeState(), inspected(wp, opts), opts).unreviewedTail], [true, `${B}..${C} (post-cap)`]);
});

test('fresh base: merge-base --is-ancestor exit 1 is "stale base", and land gate is code 5', async () => {
  const out = gate(makeState(), makeWp(), { ancestor: 1 });
  assert.deepEqual([out.staleBase, out.failures], [true, ['stale base']]);
  const exec = gateExec({ ancestor: 1 });
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
  assert.deepEqual([changed.ok, changed.needsFullReview, changed.causes], [false, true, ['full-review']]);
});

test('C1-15/C2-12 a second non-equivalent rebase is held, with the serialized cause tail-out-of-bounds', () => {
  const wp = makeWp({ reviews: [{ round: 2, scope: 'full', head: HEAD, verdicts: [] }], rebases: [{ from: sha('1'), to: sha('2'), equivalent: false }, { from: sha('3'), to: HEAD, equivalent: false }] });
  const out = gate(makeState(), wp);
  assert.equal(JSON.stringify(out.causes), '["tail-out-of-bounds"]');
  const recorded = recordLandStep(makeState(), wp, GATE_ACTION, { code: 5, stdout: JSON.stringify(out), stderr: '' }, { now: () => NOW });
  assert.deepEqual([recorded.outcome, recorded.patch.mergeLock, recorded.patch.queue], ['held', null, []]);
});

test('recordRebase: equal verbatim patch-ids are equivalent; the patch-id call gets the controlled diff as input (C1-5, C1-16)', () => {
  const from = sha('f');
  const newBase = sha('9');
  const wp = makeWp();
  const same = gateExec({ patchIds: { [`diff ${BASE} ${from}\n`]: 'pid1', [`diff ${newBase} ${HEAD}\n`]: 'pid1' } });
  const entry = recordRebase(makeState(), wp, { from, to: HEAD, newBase }, { exec: same });
  assert.deepEqual(entry, { from, to: HEAD, oldBase: BASE, newBase, patchIds: { from: 'pid1', to: 'pid1' }, equivalent: true });
  const diffCalls = same.calls.filter((call) => call.args[2] === 'diff');
  assert.ok(diffCalls.every((call) => ['--no-color', '--no-ext-diff', '--no-textconv'].every((flag) => call.args.includes(flag))));
  const ids = same.calls.filter((call) => call.args[2] === 'patch-id');
  assert.deepEqual(ids.map((call) => [call.args[3], call.input]), [['--verbatim', `diff ${BASE} ${from}\n`], ['--verbatim', `diff ${newBase} ${HEAD}\n`]]);
  const differ = gateExec({ patchIds: { [`diff ${BASE} ${from}\n`]: 'pid1', [`diff ${newBase} ${HEAD}\n`]: 'pid2' } });
  assert.equal(recordRebase(makeState(), wp, { from, to: HEAD, newBase }, { exec: differ }).equivalent, false);
  const empty = gateExec({ patchIds: { [`diff ${BASE} ${from}\n`]: '', [`diff ${newBase} ${HEAD}\n`]: '' } });
  assert.deepEqual(recordRebase(makeState(), wp, { from, to: HEAD, newBase }, { exec: empty }).patchIds, { from: null, to: null });
  const none = gateExec({ diffs: { [`${BASE} ${from}`]: '', [`${newBase} ${HEAD}`]: '' } });
  assert.equal(recordRebase(makeState(), wp, { from, to: HEAD, newBase }, { exec: none }).equivalent, true);
  const again = recordRebase(makeState(), makeWp({ rebases: [{ newBase }] }), { from: HEAD, to: sha('c'), newBase: sha('6') }, { exec: same });
  assert.equal(again.oldBase, newBase);
});

test('collects every failure (D17): head mismatch, no CI and threads together; pending CI plus threads is failed', async () => {
  const out = gate(makeState(), makeWp(), { pr: { headRefOid: sha('c') }, ci: UNKNOWN, threads: 8 });
  assert.deepEqual(out.failures, ['head mismatch', 'no CI at head', 'unresolved review threads']);
  const state = makeState({ wps: [makeWp()] });
  assert.equal((await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(state, gateExec({ pr: { headRefOid: sha('c') }, ci: UNKNOWN, threads: 8 })))).code, 5);
  const mixed = gate(makeState(), makeWp(), { ci: PENDING, threads: 8 });
  assert.deepEqual([mixed.ok, mixed.pending, mixed.failures], [false, false, ['unresolved review threads']]);
  assert.equal((await runLandVerb('gate', { runDir: RUN, wpId: 'WP-01', flags: {} }, verbDeps(state, gateExec({ ci: PENDING, threads: 8 })))).code, 5);
});

test('T0 exemption: no review needed, CI and threads still apply; an unknown tier is T2 (C1-21)', () => {
  const wp = makeWp({ tier: 'T0', reviews: [] });
  const out = gate(makeState(), wp);
  assert.deepEqual([out.ok, out.unreviewedTail], [true, `${BASE}..${HEAD} (T0)`]);
  assert.equal(gate(makeState(), wp, { threads: 8 }).ok, false);
  assert.deepEqual(gate(makeState(), makeWp({ tier: 't0', reviews: [] })).failures, ['no review of this WP']);
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
  assert.ok(files.length >= 14, files.join(', '));
  for (const name of files) assert.deepEqual(PRIVATE_PATHS.filter((pattern) => pattern.test(fixtureText(name))).map(String), [], name);
  for (const name of files.filter((file) => file.startsWith('managed-'))) {
    assert.ok(!fixtureText(name).includes('://127.') && !fixtureText(name).includes('localhost:'), name);
  }
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
  assert.deepEqual(mergeActions(makeState({ authority: { merge: false } }), makeWp(), HEAD), []);
  assert.equal(mergeActions(makeState({ intent: { ...makeState().intent, merge: false, hold: true } }), makeWp(), HEAD).length, 4);
  assert.deepEqual(mergeActions(makeState({ mergeLock: { wpId: 'WP-02' } }), makeWp(), HEAD), []);
});

test('C1-12 the squash subject is the WP\'s Commit line when the record carries it', () => {
  const [, squash] = mergeActions(makeState(), makeWp({ commit: 'feat(conduct): landing (2ff76fa2 WP-03)' }), HEAD);
  assert.deepEqual(squash.command.slice(-2), ['--subject', 'feat(conduct): landing (2ff76fa2 WP-03) (#7)']);
});

test('the CI read is the paginated check-runs argv, and every page is read', () => {
  const exec = gateExec();
  gateCheck(makeState(), makeWp(), { exec, now: () => NOW });
  assert.deepEqual(exec.calls.find((call) => call.program === 'gh' && /check-runs/.test(call.args[1])).args, ['api', `repos/sirmaelstrom/workit/commits/${HEAD}/check-runs?per_page=100`, '--paginate']);
  const page = (edit) => derived((p) => { p.total_count = 6; edit(p); }).stdout;
  const twoPages = ok(`${page(() => {})}${page((p) => { p.check_runs = p.check_runs.map((run, i) => ({ ...run, id: run.id + 10, conclusion: i ? run.conclusion : 'failure' })); })}`);
  assert.match(gate(makeState(), makeWp(), { ci: twoPages }).failures.join(), /CI failed at head/);
  assert.equal(parsePages(fixtureText('check-runs-paged.json')).length, 3);
  assert.equal(gate(makeState(), makeWp(), { ci: ok(fixtureText('check-runs-paged.json')) }).ok, true);
});

test('land merged: an empty diff is code 0, a non-empty one 5 (tree mismatch), no --merge-sha 2', async () => {
  const state = makeState({ wps: [makeWp({ gate: { head: HEAD } })] });
  assert.deepEqual(await runLandVerb('merged', { runDir: RUN, wpId: 'WP-01', flags: { mergeSha: sha('m') } }, verbDeps(state, gateExec())),
    { code: 0, out: { ok: true, head: HEAD, mergeSha: sha('m') } });
  const mismatch = await runLandVerb('merged', { runDir: RUN, wpId: 'WP-01', flags: { mergeSha: sha('m') } }, verbDeps(state, gateExec({ diffQuiet: 1 })));
  assert.deepEqual([mismatch.code, mismatch.out.reason], [5, TREE_MISMATCH]);
  const failed = await runLandVerb('merged', { runDir: RUN, wpId: 'WP-01', flags: { mergeSha: sha('m') } }, verbDeps(state, gateExec({ fetch: 128 })));
  assert.match(failed.out.reason, /^tree compare failed/);
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
  const state = OBS({ agents: agents(true, false) });
  const [probe] = reviewActions(state, makeWp({ reviewMode: undefined }), { round: 1 });
  const blocked = recordLandStep(state, makeWp(), probe, ok(fixtureText('managed-observatory.json')), {});
  assert.deepEqual([blocked.outcome, blocked.reason], ['block', 'managed repo needs the codex CLI']);
});

test('C1-21 the review author is the WP\'s effective lane agent, not the run\'s', () => {
  const { queue } = expanded(makeState(), 'managed-workit.json', { round: 1 }, { agent: 'codex' });
  assert.deepEqual(queue.filter((a) => a.part === 'lens').map((a) => a.command[a.command.indexOf('--lens') + 1]), ['astra', 'opus']);
});

test('C1-22 no lens that can run is ConductError 5 from the emitters, never an empty array', () => {
  const none = makeState({ agents: agents(false, false) });
  assert.throws(() => reviewActions(none, makeWp({ reviewMode: 'standalone' })), (error) => error.code === 5 && /review impossible/.test(error.message));
  assert.throws(() => deltaReviewActions(OBS({ agents: agents(true, false) }), makeWp({ reviewMode: 'managed' }), sha('5')), (error) => error.code === 5);
});

test('C2-13 the recorder never throws a ConductError: an impossible lens selection in a full review blocks', () => {
  const none = makeState({ agents: agents(false, false) });
  const out = recordLandStep(none, makeWp({ reviewMode: 'standalone' }), GATE_ACTION, { code: 5, stdout: gateJson({ failures: ['x'], causes: ['full-review'] }), stderr: '' }, { now: () => NOW });
  assert.deepEqual([out.outcome, out.patch.queue, out.patch.mergeLock], ['block', [], null]);
  assert.match(out.reason, /review impossible/);
  const unknown = recordLandStep(makeState(), makeWp(), { kind: 'shell', step: 'nope', part: 'x' }, ok(), {});
  assert.equal(unknown.outcome, 'block');
});

const OBS = (over = {}) => makeState({ intent: { ...makeState().intent, repo: { ...makeState().intent.repo, remote: 'heathdev-me/observatory' } }, ...over });
const REVIEWS = join(RUN, 'reviews', 'wp-01');

// The probe, recorded with a captured `managed` line: the queue it expands to.
function expanded(state, fixture, options = { round: 1 }, wpOver = {}) {
  const wp = makeWp({ reviews: [], ...wpOver });
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

const usableModels = { models: { astra: { status: 'success' }, codex: { status: 'success' } } };

test('C1-4/C2-10 a delta council round writes the delta diff and hands it to the council; only then is it recorded as delta', () => {
  const state = makeState({ adapters: { council: { on: true } } });
  const wp = makeWp({ tier: 'T2' });
  const changed = [join(WT, 'lib', 'x.mjs')];
  const delta = deltaReviewActions(state, wp, sha('f'), { changedPaths: changed });
  const diffFile = join(RUN, 'council', 'wp-01', 'delta-r2.diff');
  assert.deepEqual(delta.map((a) => a.tool ?? a.part), ['delta-diff', 'council_review', 'council_synthesize', 'council_challenge']);
  assert.deepEqual(delta[0].command, ['git', '-C', WT, 'diff', '--no-color', `--output=${diffFile}`, sha('f'), HEAD]);
  const full = t2Actions(state, wp, { round: 2, changedPaths: changed });
  assert.deepEqual(delta[1].args.artifact_paths, [diffFile, ...changed]);
  assert.notDeepEqual(delta[1].args, full[0].args, 'the payloads differ at the tool-input boundary');
  const staged = recordLandStep(state, wp, delta[1], usableModels, {});
  assert.equal(staged.patch.councilStage.scope, 'delta');
  const entry = recordLandStep(state, { ...wp, ...staged.patch }, delta[2], { findings: 1, seats: ['astra'] }, {}).patch.reviews.at(-1);
  assert.deepEqual([entry.scope, entry.since, entry.round], ['delta', sha('f'), 2]);
  // A delta-labelled review that did not carry the diff is recorded as full.
  const stripped = { ...delta[1], args: { ...delta[1].args, artifact_paths: changed } };
  const fullStage = recordLandStep(state, wp, stripped, usableModels, {}).patch.councilStage;
  assert.equal(fullStage.scope, 'full');
  const fullEntry = recordLandStep(state, { ...wp, councilStage: fullStage }, full[1], { findings: 0, seats: ['astra'] }, {}).patch.reviews.at(-1);
  assert.deepEqual([fullEntry.scope, fullEntry.since], ['full', null]);
  assert.equal(recordLandStep(state, wp, delta[0], { code: 128, stdout: '', stderr: 'fatal' }, {}).outcome, 'block');
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
  assert.equal(Object.hasOwn(on[0].args, 'models'), false);
  assert.equal(on[1].head, HEAD);
  assert.deepEqual(on[1].expects, { type: 'json', fields: ['findings', 'seats'] });
});

test('council review is recorded (D20) after its stages succeed, and the gate accepts it like a posted review', () => {
  const state = makeState({ adapters: { council: { on: true } } });
  let wp = makeWp({ reviews: [], tier: 'T2' });
  const [review, synth] = t2Actions(state, wp, { round: 1, changedPaths: [join(WT, 'lib', 'x.mjs')] });
  const staged = recordLandStep(state, wp, review, { output_dir: 'x', models: { astra: { status: 'success' }, codex: { status: 'failed' } } }, {});
  assert.deepEqual([staged.outcome, staged.patch.councilStage], ['continue', { round: 1, usable: 1, seats: ['astra'], scope: 'full' }]);
  wp = { ...wp, ...staged.patch };
  const out = recordLandStep(state, wp, synth, { findings: 2, seats: ['astra'] }, {});
  assert.deepEqual(out.patch.reviews, [{ round: 1, scope: 'full', since: null, tier: 'T2', head: HEAD, lenses: ['astra'], reviewId: synth.args.review_dir, findings: 2, verdicts: [], resolved: [] }]);
  assert.equal(out.patch.councilStage, null);
  assert.equal(gate(state, { ...wp, ...out.patch }).ok, true);
});

test('C1-3/C2-11 a council round is not coverage when a stage failed, a seat failed, or nothing was given to review', () => {
  const state = makeState({ adapters: { council: { on: true } } });
  const wp = makeWp({ reviews: [], tier: 'T2' });
  const [review, synth, challenge] = t2Actions(state, wp, { round: 1, changedPaths: [join(WT, 'lib', 'x.mjs')] });
  assert.equal(recordLandStep(state, wp, review, { models: { astra: { status: 'failed' }, codex: { status: 'timeout' } } }, {}).outcome, 'block');
  assert.equal(recordLandStep(state, wp, review, { error: 'All models failed', models: {} }, {}).outcome, 'block');
  const [emptyReview] = t2Actions(state, wp, { round: 1 });
  assert.match(recordLandStep(state, wp, emptyReview, usableModels, {}).reason, /no artifact_paths/);
  const noStage = recordLandStep(state, wp, synth, { findings: 0, seats: ['astra'] }, {});
  assert.deepEqual([noStage.outcome, noStage.patch.reviews], ['block', undefined]);
  const staged = makeWp({ reviews: [], tier: 'T2', councilStage: { round: 1, usable: 1, seats: ['astra'], scope: 'full' } });
  for (const bad of [{ error: 'synthesis failed' }, { findings: 0, seats: [] }, { findings: 'two', seats: ['astra'] }, { isError: true, findings: -1, seats: ['x'] },
    { findings: 0, seats: ['codex'] }, { findings: 0, seats: ['astra', 'codex'] }]) {
    const out = recordLandStep(state, staged, synth, bad, {});
    assert.deepEqual([out.outcome, out.patch.reviews], ['block', undefined], JSON.stringify(bad));
  }
  assert.equal(recordLandStep(state, staged, challenge, { success: false, challenge_stub: true }, {}).outcome, 'block');
  assert.equal(recordLandStep(state, staged, challenge, { success: true }, {}).outcome, 'continue');
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

test('claim refusal (C1-9): already-posted reads the posted review of this head, or holds; any other reason blocks', () => {
  const queue = reviewActions(OBS(), makeWp({ reviewMode: 'managed' }), { round: 1 });
  const wp = makeWp({ reviewMode: 'managed', reviews: [], queue });
  const refused = (reason) => ({ code: 1, stdout: JSON.stringify({ outcome: 'refused', reason, retry: 'stop' }), stderr: '' });
  const absorbed = recordLandStep(OBS(), wp, queue[0], refused(ALREADY_REVIEWED), {});
  assert.equal(absorbed.outcome, 'continue');
  assert.equal(absorbed.patch.reviews, undefined, 'a refusal string is never a review');
  const [recover, ...remaining] = absorbed.patch.queue;
  assert.deepEqual(recover.command.slice(2), ['rounds', '--pr', '7', '--repo', 'heathdev-me/observatory', '--head', HEAD]);
  assert.ok(remaining.every((a) => a.part !== 'lens' && a.step !== 'post'));
  const reviewed = ok(JSON.stringify({ outcome: 'ok', round: 'reviewed', last: { head: HEAD, scope: 'full', review_id: 42 }, problem: null }));
  const entry = recordLandStep(OBS(), wp, recover, reviewed, {}).patch.reviews[0];
  assert.deepEqual([entry.head, entry.scope, entry.reviewId, entry.findings], [HEAD, 'full', 42, null]);
  const other = ok(JSON.stringify({ outcome: 'ok', round: 'reviewed', last: { head: sha('c'), scope: 'full', review_id: 41 } }));
  assert.equal(recordLandStep(OBS(), wp, recover, other, {}).outcome, 'held');
  const blocked = recordLandStep(OBS(), wp, queue[0], refused('live-attempt'), {});
  assert.deepEqual([blocked.outcome, blocked.reason], ['block', 'claim refused: live-attempt']);
});

test('C2-13 a rounds recovery with empty stdout reaches the recorder through the real record dispatcher, and holds', async (t) => {
  const queue = reviewActions(OBS(), makeWp({ reviewMode: 'managed' }), { round: 1 });
  const refusedWp = makeWp({ reviewMode: 'managed', reviews: [], queue });
  const [recover] = recordLandStep(OBS(), refusedWp, queue[0], { code: 1, stdout: JSON.stringify({ outcome: 'refused', reason: ALREADY_REVIEWED }), stderr: '' }, {}).patch.queue;
  const dir = mkdtempSync(join(tmpdir(), 'workit-land-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { ...OBS(), runDir: dir, workshopDir: dir, handover: null, seq: 1, rev: 0, txns: [], lastRecorded: null,
    wps: [makeWp({ reviewMode: 'managed', reviews: [] })], pending: { ...recover, id: '1-review', phase: 'build' } };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  let outcome = null;
  const build = { next: () => ({ kind: 'done' }), record: (s, action, r, deps) => { outcome = recordLandStep(s, s.wps[0], action, r, deps); } };
  const out = await runConduct(['record', '--run', dir, '--action', '1-review', '--result', JSON.stringify({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' })],
    { importModule: (relPath) => (relPath === 'lib/phases/build.mjs' ? build : import(pathToFileURL(join(HERE, '..', relPath)).href)) });
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.deepEqual([outcome.outcome, outcome.patch.queue], ['held', []]);
});

test('reply bodies and council ids (D20); replies carry the run\'s measure log (C1-17)', () => {
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
  assert.deepEqual(out.actions[1].command.slice(2), ['reply', '--pr', '7', '--repo', 'sirmaelstrom/workit', '--comment-id', '101', '--body-file', join(replies, '101.md'),
    '--verdict', 'confirmed', '--adjudicator', 'lane', '--measure-log', join(RUN, 't1.jsonl')]);
  assert.deepEqual(out.actions[2].command.slice(-6, -2), ['--verdict', 'refuted', '--adjudicator', 'lane']);
  assert.deepEqual(out.conductorRows.map((row) => row.comment), ['103']);
  assert.equal(out.patch.reviews[0].verdicts.length, 4);
  assert.throws(() => recordAdjudication(makeState(), makeWp(), [{ comment: '1', verdict: 'fixed', commit: null }]), /needs its commit sha/);
  const fromTable = parseAmendmentTable('## Amendment 1\n\n| Comment | Verdict | Evidence | Commit |\n|---|---|---|---|\n| `C1-1` | fixed | x | `89abcde` |\n');
  assert.deepEqual(fromTable, [{ comment: 'C1-1', verdict: 'fixed', evidence: 'x', commit: '89abcde' }]);
  const council = recordAdjudication(makeState(), makeWp(), fromTable);
  assert.deepEqual([council.actions, council.patch.reviews[0].verdicts.length], [[], 1]);
  assert.ok(out.actions.every((a) => !(a.command ?? []).includes('C1-1') && !(a.files ?? []).some((file) => file.comment === 'C1-1')));
});

test('C1-13 adjudication ids: `#<id>` is normalized; any other shape is refused, never skipped', () => {
  const out = recordAdjudication(makeState(), makeWp(), [{ comment: '#4177234272', verdict: 'judgment', evidence: 'x', commit: null }]);
  assert.equal(out.actions[1].command[out.actions[1].command.indexOf('--comment-id') + 1], '4177234272');
  for (const id of ['D1', 'r4177', 'https://github.com/x#discussion_r1', '']) {
    assert.throws(() => recordAdjudication(makeState(), makeWp(), [{ comment: id, verdict: 'judgment', evidence: 'x' }]), /neither a PR comment id nor a council id/, id);
  }
});

test('C1-23 the amendment table ends at its first non-table line', () => {
  const text = '## Amendment 1\n\n| Comment | Verdict | Evidence | Commit |\n|---|---|---|---|\n| `101` | judgment | x | — |\n\n### Other\n\n| A | B | C | D |\n| `999` | fixed | y | `1234567` |\n';
  assert.deepEqual(parseAmendmentTable(text).map((row) => row.comment), ['101']);
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
  assert.deepEqual(lookup.command.slice(5), ['-f', 'owner=sirmaelstrom', '-f', 'name=workit', '-F', 'pr=7']);
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

const GATE_ACTION = { kind: 'shell', step: 'gate', part: 'gate', command: ['node', 'conduct.mjs', 'land', 'gate'] };
const gateResult = (out) => ({ code: 5, stdout: gateJson({ failures: ['x'], ...out }), stderr: '' });

test('recordLandStep outcomes (D19.15)', () => {
  const state = makeState();
  const wp = makeWp();
  assert.equal(recordLandStep(state, wp, GATE_ACTION, GATE_OK, { now: () => NOW }).outcome, 'continue');
  const waiting = recordLandStep(state, wp, GATE_ACTION, GATE_PENDING, { now: () => NOW });
  assert.deepEqual([waiting.outcome, waiting.waitMs, waiting.patch.queue[0].step], ['wait', 60000, 'gate']);
  const amend = recordLandStep(state, wp, GATE_ACTION, gateResult({ failures: ['unresolved review threads'], causes: ['threads'] }), { now: () => NOW });
  assert.deepEqual([amend.outcome, amend.reason, amend.patch.mergeLock, amend.patch.queue], ['amend', 'unresolved review threads', null, []]);
  assert.equal(recordLandStep(state, wp, GATE_ACTION, gateResult({ blocked: true, causes: ['ci'] }), { now: () => NOW }).outcome, 'block');
  const stale = recordLandStep(state, wp, GATE_ACTION, gateResult({ staleBase: true, causes: ['stale-base'] }), { now: () => NOW });
  assert.deepEqual([stale.outcome, stale.patch.queue.map((a) => a.part).slice(0, 2)], ['continue', ['fetch', 'pre-head']]);
  const full = recordLandStep(state, { ...wp, reviewMode: 'standalone' }, GATE_ACTION, gateResult({ needsFullReview: true, causes: ['full-review'] }), { now: () => NOW });
  assert.equal(full.outcome, 'continue');
  assert.deepEqual([full.patch.queue.at(-1).land.round, full.patch.queue.at(-1).land.scope, full.patch.mergeLock], [2, 'full', null]);
  const merged = { kind: 'shell', step: 'merged', part: 'merged', command: ['node'] };
  const anomaly = recordLandStep(state, wp, merged, { code: 5, stdout: JSON.stringify({ ok: false, reason: TREE_MISMATCH }), stderr: '' }, { now: () => NOW });
  assert.deepEqual([anomaly.outcome, anomaly.reason, anomaly.patch.mergeLock], ['block', TREE_MISMATCH, null]);
  assert.deepEqual(anomaly.patch.dispatchHalt, { reason: TREE_MISMATCH, since: new Date(NOW).toISOString() });
  assert.deepEqual(recordLandStep(state, wp, merged, ok('{}'), {}).patch, { queue: [], mergeLock: null });
  const compare = recordLandStep(state, wp, merged, { code: 5, stdout: JSON.stringify({ ok: false, reason: 'tree compare failed: fatal: bad object' }), stderr: '' }, { now: () => NOW });
  assert.deepEqual([compare.outcome, compare.reason, Object.hasOwn(compare.patch, 'dispatchHalt')], ['block', 'tree compare failed: fatal: bad object', false]);
  const other = makeState({ mergeLock: { wpId: 'WP-02', since: minutesAgo(1) } });
  const [fetch] = rebaseActions(state, wp);
  const yielded = recordLandStep(other, { ...wp, queue: [fetch] }, fetch, ok(), { now: () => NOW });
  assert.deepEqual([yielded.outcome, yielded.patch.queue, Object.hasOwn(yielded.patch, 'mergeLock')], ['wait', [fetch], false]);
  const taken = recordLandStep(makeState({ mergeLock: null }), wp, fetch, ok(), { now: () => NOW });
  assert.deepEqual(taken.patch.mergeLock, { wpId: 'WP-01', since: new Date(NOW).toISOString() });
  const mergeCommit = mergeActions(state, wp, HEAD)[2];
  assert.deepEqual(recordLandStep(state, wp, mergeCommit, ok(fixtureText('pr-view-150-merge-commit.json')), {}).patch, { merge: { sha: '37e79605735904eac875b000ad1b2ca55885db89' } });
});

test('C1-8/C1-18 failures are classified: lock re-acquires, infrastructure retries 3 times then blocks, a held gate releases the lock', () => {
  const state = makeState();
  const deps = { now: () => NOW };
  const free = recordLandStep(makeState({ mergeLock: null }), makeWp(), GATE_ACTION, gateResult({ failures: ['merge lock not held'], causes: ['lock'] }), deps);
  assert.deepEqual([free.outcome, free.patch.queue[0].part], ['continue', 'fetch']);
  const busy = recordLandStep(makeState({ mergeLock: { wpId: 'WP-02' } }), makeWp(), GATE_ACTION, gateResult({ failures: ['merge lock held by WP-02'], causes: ['lock'] }), deps);
  assert.deepEqual([busy.outcome, busy.waitMs, busy.patch.queue[0].part], ['wait', 60000, 'yield']);
  const infra = gateResult({ failures: ['fetch failed: HTTP 502'], causes: ['infra'] });
  let wp = makeWp();
  for (const n of [1, 2, 3]) {
    const out = recordLandStep(state, wp, GATE_ACTION, infra, deps);
    assert.deepEqual([out.outcome, out.patch.retries, out.patch.queue[0].step], ['wait', n, 'gate']);
    wp = { ...wp, ...out.patch };
  }
  const gaveUp = recordLandStep(state, wp, GATE_ACTION, infra, deps);
  assert.deepEqual([gaveUp.outcome, gaveUp.patch.mergeLock, gaveUp.patch.queue], ['block', null, []]);
  // An unrelated outcome resets the counter.
  assert.equal(recordLandStep(state, { ...wp, retries: 2 }, GATE_ACTION, gateResult({ causes: ['threads'] }), deps).patch.retries, 0);
  const held = recordLandStep(makeState({ authority: { merge: false } }), makeWp(), GATE_ACTION, GATE_OK, deps);
  assert.deepEqual([held.outcome, held.patch.mergeLock, held.patch.queue], ['held', null, []]);
});

test('C1-24 malformed gate output blocks', () => {
  for (const stdout of ['{}', '{"failures":"x"}', 'not json', '{"failures":[1]}']) {
    assert.equal(recordLandStep(makeState(), makeWp(), GATE_ACTION, { code: 5, stdout, stderr: '' }, { now: () => NOW }).outcome, 'block', stdout);
  }
  assert.equal(recordLandStep(makeState(), makeWp(), GATE_ACTION, { code: 0, stdout: '{}', stderr: '' }, { now: () => NOW }).outcome, 'block');
});

test('C1-19 the push lease is pinned to the PR head; stale base plus head mismatch blocks', () => {
  const push = rebaseActions(makeState(), makeWp()).find((a) => a.part === 'push');
  assert.deepEqual(push.command, ['git', '-C', WT, 'push', `--force-with-lease=conduct/fixture/wp-01:${HEAD}`, 'origin', 'conduct/fixture/wp-01']);
  const both = recordLandStep(makeState(), makeWp(), GATE_ACTION, gateResult({ failures: ['head mismatch', 'stale base'], causes: ['head-mismatch', 'stale-base'], staleBase: true }), { now: () => NOW });
  assert.deepEqual([both.outcome, both.patch.mergeLock], ['block', null]);
});

test('C1-1/C2-13 the inspection: the gate queues it (validated), its record binds it and re-queues the gate or holds', () => {
  const { inspect } = gate(makeState(), postCapWp(), TAIL);
  const queued = recordLandStep(makeState(), makeWp(), GATE_ACTION, gateResult({ failures: ['needs an inspection'], causes: ['inspect'], inspect }), { now: () => NOW });
  const [action] = queued.patch.queue;
  assert.deepEqual([queued.outcome, action.kind, action.step, action.part], ['continue', 'inspect', 'gate', 'inspect']);
  assert.deepEqual(action.command, ['git', '-C', WT, 'diff', '--no-color', '--no-renames', D, HEAD, '--', 'lib/x.mjs']);
  const good = recordLandStep(makeState(), makeWp(), action, { verdict: 'addresses-findings', tail: inspect.tail, head: HEAD }, {});
  assert.deepEqual(good.patch.inspections, [{ verdict: 'addresses-findings', tail: inspect.tail, head: HEAD, review: inspect.review, findingsHash: inspect.findingsHash }]);
  assert.deepEqual([good.outcome, good.patch.queue[0].step], ['continue', 'gate']);
  assert.equal(recordLandStep(makeState(), makeWp(), action, { verdict: 'unrelated-change', tail: inspect.tail, head: HEAD }, {}).outcome, 'held');
  assert.equal(recordLandStep(makeState(), makeWp(), action, { verdict: 'addresses-findings', tail: 'x..y', head: HEAD }, {}).outcome, 'block');
  const mixed = recordLandStep(makeState(), makeWp(), GATE_ACTION, gateResult({ causes: ['inspect', 'threads'], inspect }), { now: () => NOW });
  assert.equal(mixed.outcome, 'amend');
  for (const bad of [true, { ...inspect, files: [] }, { ...inspect, tail: 'nope' }, { ...inspect, findingsHash: undefined }]) {
    assert.equal(recordLandStep(makeState(), makeWp(), GATE_ACTION, gateResult({ causes: ['inspect'], inspect: bad }), { now: () => NOW }).outcome, 'block', JSON.stringify(bad));
  }
});

test('C1-11 a rebase conflict queues the abort; the abort\'s record is the amendment', () => {
  const state = makeState();
  const wp = makeWp();
  const [, , rebase] = rebaseActions(state, wp);
  const conflict = recordLandStep(state, wp, rebase, { code: 1, stdout: 'CONFLICT (content)', stderr: '' }, {});
  assert.deepEqual([conflict.outcome, Object.hasOwn(conflict.patch, 'mergeLock')], ['continue', false]);
  const [abort] = conflict.patch.queue;
  assert.deepEqual(abort.command, ['git', '-C', WT, 'rebase', '--abort']);
  const amended = recordLandStep(state, wp, abort, ok(), {});
  assert.deepEqual([amended.outcome, amended.patch.mergeLock, amended.patch.queue], ['amend', null, []]);
  assert.match(amended.reason, /conflicted: CONFLICT/);
});

test('C1-20 a full review whose changed files cannot be read blocks', () => {
  const state = makeState({ adapters: { council: { on: true } } });
  const exec = () => ({ code: 128, stdout: '', stderr: 'fatal: bad revision' });
  const out = recordLandStep(state, makeWp({ tier: 'T2' }), GATE_ACTION, gateResult({ needsFullReview: true, causes: ['full-review'] }), { exec, now: () => NOW });
  assert.deepEqual([out.outcome, out.patch.mergeLock], ['block', null]);
  const unknownTier = recordLandStep(state, makeWp({ tier: 'X' }), GATE_ACTION, gateResult({ causes: ['full-review'] }), { exec: () => ok('lib/x.mjs\n'), now: () => NOW });
  assert.equal(unknownTier.patch.queue[0].tool, 'council_review');
});

test('rebaseActions: fetch, pre-head, rebase, post-heads, push --force-with-lease, then a wait; post-heads records the rebase', () => {
  const state = makeState();
  const actions = rebaseActions(state, makeWp());
  assert.deepEqual(actions.map((a) => a.part), ['fetch', 'pre-head', 'rebase', 'post-heads', 'push', 'ci-wait']);
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
  assert.equal(tierFor({ tier: 'T1' }, ['tests/fixture.md'], []), 'T2');
  assert.equal(tierFor({ tier: 'T1' }, ['skills/spec/scripts/x.mjs'], []), 'T1');
  assert.equal(tierFor({ tier: 'T0' }, ['README.md'], []), 'T0');
  assert.equal(tierFor({ tier: 'weird' }, ['README.md'], []), 'T2');
});

test('runLandVerb I/O (D19.21): returns { code, out } and writes nothing to stdout', async (t) => {
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
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
