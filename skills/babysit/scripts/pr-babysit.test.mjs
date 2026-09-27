/**
 * pr-babysit — the decision's seven controls and the driver end to end
 * against a scripted environment (spec-lite D2/D7, quest 14af0696).
 *
 * Nothing here touches GitHub or the coordinator: `runGh`, the coordinator
 * client and the writer spawner are fakes over one mutable world, and the
 * clock advances only when the loop sleeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, runLoop, summariseChecks, normaliseThreads, adjudicate, adjudicateVerb, unwrapClientResponse, fetchAllThreads, reviewRound, DEFAULT_BOUNDS, BLOCKED_REASONS, COMMENTS_PAGE } from './pr-babysit.mjs';
import { buildMarker } from '../../slim-review/scripts/pr-review-recognise.mjs';

const H1 = 'aaaaaaa1111111111111111111111111111111111';
const H2 = 'bbbbbbb2222222222222222222222222222222222';
const H3 = 'ccccccc3333333333333333333333333333333333';
const H4 = 'ddddddd4444444444444444444444444444444444';

const T0 = Date.parse('2026-09-11T14:00:00Z');
const MIN = 60_000;

function obs(over = {}) {
  return {
    repo: 'o/r', pr: 1,
    headBefore: H1, headAfter: H1, head: H1,
    checks: { pass: 2, pending: 0, fail: 0, skipping: 0, names: { fail: [], pending: [] } },
    threads: [],
    status: { attempts: [] },
    health: { enabled: true, paused: false, pauseReason: 'none' },
    coordinatorError: null,
    at: T0 + 5 * MIN,
    ...over,
  };
}
function ctx(over = {}) {
  return { repo: 'o/r', pr: 1, bounds: { ...DEFAULT_BOUNDS }, iterationHead: H1, iterations: 1, startedAt: T0, claimsOnHead: {}, ...over };
}
const posted = (head = H1, attempt = 1) => ({ head_sha: head, attempt, state: 'posted', disposition: null, review_id: 5000 + attempt, origin: 'beat' });
const thread = (id, resolved) => ({ id: `T${id}`, commentId: id, path: 'a.ts', line: 3, resolved, outdated: false, author: 'sirmaelstrom', lens: 'codex', first: 'x', replies: 0 });

// ---------------------------------------------------------------------------
// decide — positive path
// ---------------------------------------------------------------------------

test('converged: posted attempt on the current head, every thread resolved, checks green, head stable', () => {
  const d = decide(obs({ status: { attempts: [posted()] }, threads: [thread(1, true)] }), ctx());
  assert.equal(d.action, 'converged');
  assert.equal(d.reviewId, 5001);
});

test('a posted review with an open thread is YOUR TURN (adjudicate), never converged', () => {
  const d = decide(obs({ status: { attempts: [posted()] }, threads: [thread(1, false), thread(2, true)] }), ctx());
  assert.equal(d.action, 'adjudicate');
  assert.equal(d.threads.length, 1);
});

test('a posted review with a pending check waits', () => {
  const d = decide(obs({ status: { attempts: [posted()] }, checks: { pass: 1, pending: 1, fail: 0, skipping: 0, names: { fail: [], pending: ['verify'] } } }), ctx());
  assert.equal(d.action, 'wait');
});

test('an older coordinator without head_sha on status rows: the posted_head pointer still attributes the posted review; unattributable rows never converge a different head', () => {
  const rowNoHead = { attempt: 1, state: 'posted', disposition: null, review_id: 77, origin: 'beat' };
  const d = decide(obs({ status: { attempts: [rowNoHead], posted_head: H1, posted_review_id: 77 } }), ctx());
  assert.deepEqual([d.action, d.reviewId], ['converged', 77]);
  const other = decide(obs({ head: H2, headBefore: H2, headAfter: H2, status: { attempts: [rowNoHead], posted_head: H1, posted_review_id: 77 } }), ctx({ iterationHead: H2 }));
  assert.notEqual(other.action, 'converged');
});

test('a posted attempt on an OLDER head does not count for the current head', () => {
  const d = decide(obs({ head: H2, headBefore: H2, headAfter: H2, status: { attempts: [posted(H1)] } }), ctx({ iterationHead: H2 }));
  assert.notEqual(d.action, 'converged');
  assert.equal(d.action, 'claim');
});

// ---------------------------------------------------------------------------
// decide — the seven controls
// ---------------------------------------------------------------------------

test('control 1 — missing handback: a lens_running attempt waits, then blocks reviewer-never-answered at the wall bound', () => {
  const live = { head_sha: H1, attempt: 1, state: 'lens_running', disposition: null, review_id: null };
  assert.equal(decide(obs({ status: { attempts: [live] } }), ctx()).action, 'wait');
  const late = decide(obs({ status: { attempts: [live] }, at: T0 + 91 * MIN }), ctx());
  assert.deepEqual([late.action, late.reason], ['blocked', 'reviewer-never-answered']);
  assert.match(late.owed, /recover abandon/);
});

test('control 2 — reviewer never answers: a claimed attempt that never progresses is the same shape', () => {
  const live = { head_sha: H1, attempt: 1, state: 'claimed', disposition: null, review_id: null };
  const late = decide(obs({ status: { attempts: [live] }, at: T0 + 100 * MIN }), ctx());
  assert.deepEqual([late.action, late.reason], ['blocked', 'reviewer-never-answered']);
});

test('control 3 — head moved: a new iteration, and blocked head-moved-limit past --max-heads', () => {
  const moved = decide(obs({ head: H2, headBefore: H2, headAfter: H2 }), ctx({ iterationHead: H1, iterations: 1 }));
  assert.equal(moved.action, 'new-head');
  const over = decide(obs({ head: H4, headBefore: H4, headAfter: H4 }), ctx({ iterationHead: H3, iterations: 3 }));
  assert.deepEqual([over.action, over.reason], ['blocked', 'head-moved-limit']);
  // a head that moves DURING the read is re-read, never decided on
  assert.equal(decide(obs({ headBefore: H1, headAfter: H2, head: H2 }), ctx()).action, 'wait');
});

test('control 4 — CI failure blocks ci-failed and names the check, even with a posted review', () => {
  const d = decide(obs({ status: { attempts: [posted()] }, checks: { pass: 1, pending: 0, fail: 1, skipping: 0, names: { fail: ['verify'], pending: [] } } }), ctx());
  assert.deepEqual([d.action, d.reason], ['blocked', 'ci-failed']);
  assert.match(d.owed, /verify/);
});

test('control 5 — exhausted limits: wall-time with nothing in flight; unresolved threads at the wall bound are named', () => {
  const wall = decide(obs({ at: T0 + 200 * MIN }), ctx());
  assert.deepEqual([wall.action, wall.reason], ['blocked', 'wall-time']);
  const open = decide(obs({ at: T0 + 200 * MIN, status: { attempts: [posted()] }, threads: [thread(1, false)] }), ctx());
  assert.deepEqual([open.action, open.reason], ['blocked', 'unresolved-threads']);
});

test('control 6 — expired attempt: withdrawn/abandoned on the head → ONE session claim; a second → blocked attempt-failed; --session-claims 0 → blocked attempt-ended-no-retry', () => {
  const abandoned = { head_sha: H1, attempt: 1, state: 'withdrawn', disposition: 'abandoned', review_id: null };
  assert.equal(decide(obs({ status: { attempts: [abandoned] } }), ctx()).action, 'claim');
  const second = decide(obs({ status: { attempts: [abandoned] } }), ctx({ claimsOnHead: { [H1]: 1 } }));
  assert.deepEqual([second.action, second.reason], ['blocked', 'attempt-failed']);
  const strict = decide(obs({ status: { attempts: [abandoned] } }), ctx({ bounds: { ...DEFAULT_BOUNDS, sessionClaimsPerHead: 0 } }));
  assert.deepEqual([strict.action, strict.reason], ['blocked', 'attempt-ended-no-retry']);
  const integrity = decide(obs({ status: { attempts: [{ ...abandoned, state: 'failed', disposition: 'integrity-violation' }] } }), ctx({ claimsOnHead: { [H1]: 1 } }));
  assert.deepEqual([integrity.action, integrity.reason], ['blocked', 'integrity-violation']);
});

test('control 7 — ambiguous delivery: delivery-unresolved waits and NEVER claims; at the wall bound it blocks delivery-unresolved', () => {
  const du = { head_sha: H1, attempt: 1, state: 'delivery-unresolved', disposition: null, review_id: null };
  const d = decide(obs({ status: { attempts: [du] } }), ctx());
  assert.equal(d.action, 'wait');
  const late = decide(obs({ status: { attempts: [du] }, at: T0 + 95 * MIN }), ctx());
  assert.deepEqual([late.action, late.reason], ['blocked', 'delivery-unresolved']);
  assert.match(late.owed, /never re-POSTed/);
});

test('the coordinator gate: paused or disabled blocks before any claim; a live attempt is never claimed over', () => {
  assert.deepEqual(decide(obs({ health: { enabled: true, paused: true, pauseReason: 'reserve' } }), ctx()).reason, 'plan-paused');
  assert.deepEqual(decide(obs({ health: { enabled: false, paused: false } }), ctx()).reason, 'disabled');
  const live = { head_sha: H1, attempt: 1, state: 'lens_done', disposition: null, review_id: null };
  assert.equal(decide(obs({ status: { attempts: [live] }, health: { enabled: true, paused: true } }), ctx()).action, 'wait');
  assert.equal(decide(obs({ coordinatorError: 'ECONNREFUSED' }), ctx()).reason, 'coordinator-unreachable');
});

test('--claim beat waits for the beat instead of claiming a fresh head', () => {
  assert.equal(decide(obs(), ctx({ bounds: { ...DEFAULT_BOUNDS, claim: 'beat' } })).action, 'wait');
  assert.equal(decide(obs(), ctx()).action, 'claim');
});

test('every blocked reason the decision can emit is in the closed set', () => {
  const seen = new Set();
  const cases = [
    [obs({ coordinatorError: 'x' }), ctx()],
    [obs({ identityUnset: true }), ctx()],
    [obs({ head: H4, headBefore: H4, headAfter: H4 }), ctx({ iterationHead: H3, iterations: 3 })],
    [obs({ checks: { pass: 0, pending: 0, fail: 1, skipping: 0, names: { fail: ['a'], pending: [] } } }), ctx()],
    [obs({ at: T0 + 200 * MIN }), ctx()],
    [obs({ health: { enabled: false, paused: false } }), ctx()],
    [obs({ health: { enabled: true, paused: true } }), ctx()],
    [obs({ status: { attempts: [{ head_sha: H1, attempt: 1, state: 'failed', disposition: 'lens-error' }] } }), ctx({ claimsOnHead: { [H1]: 1 } })],
  ];
  for (const [o, c] of cases) { const d = decide(o, c); if (d.action === 'blocked') seen.add(d.reason); }
  for (const r of seen) assert.ok(BLOCKED_REASONS.includes(r), `${r} not in the closed set`);
  assert.ok(seen.has('identity-unset'), 'the identity-unset case was sampled');
  assert.ok(seen.size >= 6);
});

test('T1 workit#93 — the coordinator client answers an ENVELOPE; the loop reads the view inside it, and a refusal is an error (the live run on obs#676 waited on a review it could not see)', () => {
  assert.deepEqual(unwrapClientResponse({ ok: true, status: 200, body: { attempts: [1] } }), { attempts: [1] });
  assert.deepEqual(unwrapClientResponse({ attempts: [] }), { attempts: [] });
  // the client's real refusal shape (pr-review-coordinator.mjs refusal()): the code is `code`
  assert.throws(() => unwrapClientResponse({ ok: false, code: 'coordinator-unreachable', source: 'client', message: 'ECONNREFUSED' }), /^Error: readStatus: coordinator-unreachable — ECONNREFUSED$/);
  // a `reason` is still named when there is no `code`, and 'refused' only when there is neither
  assert.throws(() => unwrapClientResponse({ ok: false, reason: 'paused' }), /^Error: readStatus: paused$/);
  assert.throws(() => unwrapClientResponse({ ok: false }), /^Error: readStatus: refused$/);
  assert.throws(() => unwrapClientResponse(null), /empty/);
});

test('a real-shaped readStatus refusal names its code in the coordinator-unreachable owed text, not "refused"', async () => {
  const { w, deps } = world();
  deps.coordinator.readStatus = async () => ({ ok: false, code: 'unauthorized', source: 'coordinator', status: 401, message: 'coordinator refused the token' });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'coordinator-unreachable']);
  assert.match(r.owed, /readStatus: unauthorized — coordinator refused the token/);
  assert.doesNotMatch(r.owed, /refused —/);
  assert.equal(w.writerCalls.length, 0);
});

test('T1 workit#93 — checks that could not be READ are unknown: wait, then blocked checks-unavailable; never "no checks, therefore green"', () => {
  const unknown = { ...summariseChecks([]), unknown: true };
  const d = decide(obs({ checks: unknown, status: { attempts: [posted()] }, threads: [thread(1, true)] }), ctx());
  assert.equal(d.action, 'wait');
  const late = decide(obs({ checks: unknown, status: { attempts: [posted()] }, at: T0 + 200 * MIN }), ctx());
  assert.deepEqual([late.action, late.reason], ['blocked', 'checks-unavailable']);
});

test('T1 workit#93 — a truncated thread listing never converges', () => {
  const d = decide(obs({ threadsTruncated: true, status: { attempts: [posted()] } }), ctx());
  assert.deepEqual([d.action, d.reason], ['blocked', 'threads-truncated']);
});

test('T1 workit#93 — fetchAllThreads paginates and flags a thread whose comment page is full', () => {
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'A', comments: { nodes: [] } }] },
    { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'B', comments: { nodes: Array.from({ length: COMMENTS_PAGE }, (_, i) => ({ databaseId: i })) } }] },
  ];
  const calls = [];
  const runGh = (args) => { calls.push(args); return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: pages.shift() } } } }); };
  const r = fetchAllThreads({ repo: 'o/r', pr: 1, cwd: '.' }, runGh);
  assert.deepEqual(r.nodes.map((n) => n.id), ['A', 'B']);
  assert.equal(r.truncated, true);
  assert.ok(calls[1].includes('after=c1'), 'second page carries the cursor');
});

test('T1 workit#93 — adjudicate does NOT resolve the thread when the verdict reply failed', async () => {
  const { w, deps } = world({ threads: [openThread(5)] });
  deps.spawnWriter = (args) => { w.writerCalls.push(args); return args[0] === 'reply' ? { outcome: 'failed', reason: 'writer-exit-4' } : { outcome: 'ok' }; };
  const r = await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 5, verdict: 'refuted', bodyFile: 'x.md' }, deps);
  assert.deepEqual([r.outcome, r.reason, r.resolved], ['failed', 'reply-failed', false]);
  assert.equal(w.threads[0].isResolved, false);
  assert.ok(!w.ghCalls.some((a) => a[3]?.includes('resolveReviewThread')), 'no resolve mutation was sent');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('summariseChecks: cancel and unknown buckets are not green', () => {
  const s = summariseChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }, { name: 'c', bucket: 'cancel' }, { name: 'd', bucket: 'pending' }]);
  assert.deepEqual([s.pass, s.skipping, s.fail, s.pending], [1, 1, 1, 1]);
  assert.deepEqual(s.names, { fail: ['c'], pending: ['d'] });
});

test('normaliseThreads reads the lens tag, the first line, and the reply count', () => {
  const [t] = normaliseThreads([{ id: 'T', isResolved: false, isOutdated: true, path: 'x.ts', line: 9, comments: { nodes: [{ databaseId: 7, author: { login: 'me' }, body: '\n**lens:** astra · P2\nbody' }, { databaseId: 8, author: { login: 'me' }, body: 'reply' }] } }]);
  assert.deepEqual([t.commentId, t.lens, t.first, t.replies, t.resolved, t.outdated], [7, 'astra', '**lens:** astra · P2', 1, false, true]);
});

// ---------------------------------------------------------------------------
// driver — end to end against a scripted world
// ---------------------------------------------------------------------------

function world(init = {}) {
  const w = {
    head: H1,
    checks: [{ name: 'verify', bucket: 'pass' }],
    threads: [],
    attempts: [],
    reviews: [], // the PR's review listing, as `gh api …/reviews --jq` projects it
    history: [H1, H2, H3, H4], // a linear branch: each head descends from the ones before it
    login: 'sirmaelstrom',
    health: { enabled: true, paused: false, pauseReason: 'none' },
    clock: T0,
    writerCalls: [],
    ghCalls: [],
    onClaim: null, // (w) => void — scripted reaction to a claim
    lensRefusesSince: false, // the writer answers `--since` with its pre-start input-mismatch
    ...init,
  };
  const compare = (from, to) => {
    const i = w.history.indexOf(from);
    const j = w.history.indexOf(to);
    if (i < 0 || j < 0) return { status: 'diverged', ahead_by: 1, behind_by: 1, files: [{ filename: 'a.ts' }], commits: [] };
    if (i === j) return { status: 'identical', ahead_by: 0, files: [], commits: [] };
    if (j < i) return { status: 'behind', ahead_by: 0, files: [], commits: [] };
    const commits = w.history.slice(i + 1, j + 1).map((sha) => ({ sha, parents: [{ sha: 'p' }] }));
    const payload = { status: 'ahead', ahead_by: j - i, total_commits: j - i, files: [{ filename: 'a.ts' }], commits };
    return w.onCompare ? w.onCompare(payload, from, to) : payload;
  };
  const deps = {
    managed: { mode: 'managed' },
    coordinator: {
      // the REAL client's shape: an envelope around the view (regression for the obs#676 live run)
      readStatus: async () => ({ ok: true, status: 200, body: { attempts: w.attempts.map((a) => ({ ...a })), posted_head: null, posted_review_id: null } }),
      readHealth: async () => ({ ...w.health }),
      readIdentity: async () => ({ ok: true, status: 200, body: { login: w.login } }),
    },
    runGh: (args) => {
      w.ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') { if (w.headReads?.length) w.head = w.headReads.shift(); return `${w.head}\n`; }
      if (args[0] === 'pr' && args[1] === 'checks') return JSON.stringify(w.checks);
      if (args[0] === 'api' && args[1] === '--paginate' && /\/pulls\/\d+\/reviews$/.test(args[2])) return w.reviews.map((r) => JSON.stringify(r)).join('\n');
      const cmp = args[0] === 'api' && /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(args[1] ?? '');
      if (cmp) return JSON.stringify(compare(cmp[1], cmp[2]));
      if (args[0] === 'api' && args[1] === 'graphql' && args[3].includes('resolveReviewThread')) {
        const id = args[5].slice(3);
        const t = w.threads.find((x) => x.id === id);
        if (t) t.isResolved = true;
        return JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
      }
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: w.threads } } } } });
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    spawnWriter: (args) => {
      w.writerCalls.push(args);
      if (args[0] === 'claim') {
        if (w.health.paused) return { outcome: 'refused', reason: 'paused' };
        const attempt = w.attempts.filter((a) => a.head_sha === w.head).length + 1;
        w.attempts.push({ head_sha: w.head, attempt, state: 'claimed', disposition: null, review_id: null, origin: 'session' });
        if (w.onClaim) w.onClaim(w);
        return { outcome: 'ok', attempt_ref_file: `ref-${w.head}-${attempt}`, retry: 'stop' };
      }
      if (args[0] === 'lens') {
        const a = w.attempts[w.attempts.length - 1];
        const at = args.indexOf('--since');
        const since = at >= 0 ? args[at + 1] : null;
        // the writer's pre-start refusal: no lens start, the attempt stays live
        if (since && w.lensRefusesSince) return { outcome: 'refused', reason: 'input-mismatch', since, exitCode: 1 };
        if (w.lensOutcome === 'fail') { a.state = 'failed'; a.disposition = 'lens-error'; return { outcome: 'failed', reason: 'lens-error', retry: 'stop' }; }
        a.since = since;
        a.state = args[args.indexOf('--lens') + 1] === 'astra' ? 'lens_done' : 'lens_running';
        return { outcome: 'ok', retry: 'stop' };
      }
      if (args[0] === 'post') {
        const a = w.attempts[w.attempts.length - 1];
        a.state = 'posted'; a.review_id = 9000 + a.attempt;
        w.reviews.push(listed({ id: a.review_id, head: a.head_sha, since: a.since }));
        if (w.findingsOnPost) { w.threads.push(...w.findingsOnPost(w)); }
        return { outcome: 'posted', review_id: a.review_id, head_now: w.head };
      }
      if (args[0] === 'reply') return { outcome: 'ok' };
      throw new Error(`unexpected writer ${args.join(' ')}`);
    },
    now: () => w.clock,
    sleep: async (ms) => { w.clock += ms; if (w.onSleep) w.onSleep(w); },
    log: () => {},
    emit: () => {},
  };
  return { w, deps };
}
/** One entry of the review listing: a coordinated review carries the real marker; `marker: false` is a legacy review. */
function listed({ id, head, since = null, login = 'sirmaelstrom', marker = true, body }) {
  const text = body ?? (marker
    ? `review body\n\n${buildMarker({ repo: 'o/r', pr: 1, head, base: 'b'.repeat(40), lenses: ['codex', 'astra'], run: 'run-1', attempt: 1, policy: null, supersedes: null, since })}`
    : 'a legacy review with no marker');
  return { review_id: id, author_login: login, commit_id: head, submitted_at: '2026-09-27T12:00:00Z', state: 'COMMENTED', body: text };
}
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'babysit-')), 'state.json');
const openThread = (id) => ({ id: `T${id}`, isResolved: false, isOutdated: false, path: 'a.ts', line: 1, comments: { nodes: [{ databaseId: id, author: { login: 'sirmaelstrom' }, body: '**lens:** codex · P2 finding' }] } });

test('end to end: claims the head, review posts with findings → adjudicate (exit shape), fix pushes a new head, second review clean → converged in two iterations', async () => {
  const { w, deps } = world({ findingsOnPost: (ww) => (ww.head === H1 ? [openThread(11)] : []) });
  const state = stateFile();
  const r1 = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  assert.equal(r1.outcome, 'adjudicate');
  assert.equal(r1.threads.length, 1);
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 1);

  // the session judges: confirmed → fix pushed (new head); the thread is adjudicated + resolved
  const a = await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 11, verdict: 'confirmed', bodyFile: 'x.md' }, deps);
  assert.equal(a.outcome, 'ok');
  assert.ok(w.threads[0].isResolved);
  w.head = H2;

  const r2 = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  assert.equal(r2.outcome, 'converged');
  assert.equal(r2.head, H2);
  assert.equal(r2.iterations, 2);
  assert.equal(r2.review_id, 9001); // attempt 1 on H2 → the fake's 9000 + attempt
  // never posted twice on a head, exactly one claim per head
  const claims = w.writerCalls.filter((c) => c[0] === 'claim').length;
  assert.equal(claims, 2);
  assert.deepEqual(w.attempts.map((x) => [x.head_sha.slice(0, 7), x.state]), [['aaaaaaa', 'posted'], ['bbbbbbb', 'posted']]);
});

test('end to end: the session claim fails on the head → the per-head allowance is spent → blocked attempt-failed with an owed sentence, no second claim', async () => {
  const { w, deps } = world({ lensOutcome: 'fail' });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason, 'attempt-failed');
  assert.match(r.owed, /pr-review\.mjs claim/);
  // the loop's allowance is ONE session claim per head; the first claim is the session's own,
  // the failure ends it, and the allowance is spent → no second claim
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 1);
});

test('end to end: the coordinator refuses the claim as paused → blocked plan-paused, nothing else spawned', async () => {
  const { w, deps } = world({ health: { enabled: true, paused: false } });
  w.health.paused = true; deps.coordinator.readHealth = async () => ({ enabled: true, paused: false }); // gate read green, claim refuses
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'plan-paused']);
  assert.deepEqual(w.writerCalls.map((c) => c[0]), ['claim']);
});

test('end to end: a reviewer that never answers blocks at the wall bound and the clock proves the wait was bounded', async () => {
  const { w, deps } = world({ attempts: [{ head_sha: H1, attempt: 1, state: 'lens_running', disposition: null, review_id: null, origin: 'beat' }] });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 600, maxWallMinutes: 30 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'reviewer-never-answered']);
  assert.ok(w.clock - T0 <= 40 * MIN, 'waited past the bound');
  assert.equal(w.writerCalls.length, 0, 'never claimed over a live attempt');
});

test('end to end: CI failure on the head blocks ci-failed without spending a lens', async () => {
  const { w, deps } = world({ checks: [{ name: 'verify', bucket: 'fail' }] });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'ci-failed']);
  assert.equal(w.writerCalls.length, 0);
});

test('end to end: the head moving past --max-heads blocks head-moved-limit', async () => {
  const heads = [H2, H3, H4];
  const { w, deps } = world({ onSleep: (ww) => { const n = heads.shift(); if (n) ww.head = n; } });
  // a live beat attempt keeps the loop waiting; each sleep moves the head
  w.attempts.push({ head_sha: H1, attempt: 1, state: 'claimed', disposition: null, review_id: null, origin: 'beat' });
  w.onClaim = (ww) => { ww.attempts[ww.attempts.length - 1].state = 'claimed'; };
  deps.spawnWriter = (args) => { w.writerCalls.push(args); if (args[0] === 'claim') { w.attempts.push({ head_sha: w.head, attempt: 1, state: 'claimed' }); return { outcome: 'ok', attempt_ref_file: 'r' }; } return { outcome: 'ok' }; };
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1, maxHeads: 2 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'head-moved-limit']);
});

test('end to end: delivery-unresolved on the head waits and is never re-posted, then blocks delivery-unresolved', async () => {
  const { w, deps } = world({ attempts: [{ head_sha: H1, attempt: 1, state: 'delivery-unresolved', disposition: null, review_id: null, origin: 'beat' }] });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 300, maxWallMinutes: 20 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'delivery-unresolved']);
  assert.equal(w.writerCalls.length, 0);
});

test('a repository that is not managed blocks not-managed and touches nothing', async () => {
  const { w, deps } = world();
  deps.managed = { mode: 'standalone' };
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile() }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'not-managed']);
  assert.equal(w.ghCalls.length, 0);
});

// ---------------------------------------------------------------------------
// the capped review loop (quest 329cba0d): full → delta → no third review
// ---------------------------------------------------------------------------

const lensCalls = (w) => w.writerCalls.filter((c) => c[0] === 'lens');
const sinceOf = (call) => { const at = call.indexOf('--since'); return at >= 0 ? call[at + 1] : null; };
const fullReviewedOnH1 = (over = {}) => world({
  head: H2,
  reviews: [listed({ id: 7001, head: H1 })],
  attempts: [{ head_sha: H1, attempt: 1, state: 'posted', disposition: null, review_id: 7001, origin: 'beat' }],
  ...over,
});

test('reviewRound reads the rounds from the posted reviews: none → full, full → delta since its head, delta after it → capped, on this head → reviewed', () => {
  const full = { review_id: 1, head: H1, scope: 'full', since: null };
  const delta = { review_id: 2, head: H2, scope: 'delta', since: H1 };
  assert.deepEqual(reviewRound([], H1), { round: 'full' });
  assert.deepEqual([reviewRound([full], H2).round, reviewRound([full], H2).since], ['delta', H1]);
  assert.equal(reviewRound([full, delta], H3).round, 'capped');
  assert.equal(reviewRound([full, delta], H2).round, 'reviewed');
  // a full review the conductor ran after the delta opens a fresh pair
  assert.deepEqual(reviewRound([full, delta, { review_id: 3, head: H3, scope: 'full', since: null }], H4).since, H3);
});

test('round two is a delta pass: a posted full review on H1 and a new head H2 → both lens calls carry --since H1 under one claim, and the delta review converges H2', async () => {
  const { w, deps } = fullReviewedOnH1();
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 1);
  assert.deepEqual(lensCalls(w).map((c) => [c[c.indexOf('--lens') + 1], sinceOf(c)]), [['codex', H1], ['astra', H1]]);
  assert.equal(new Set(lensCalls(w).map((c) => c[c.indexOf('--attempt-ref') + 1])).size, 1, 'both lenses under the same attempt-ref');
  assert.deepEqual([r.outcome, r.head], ['converged', H2]);
  assert.match(w.reviews[w.reviews.length - 1].body, new RegExp(`since=${H1}`));
});

test('the round-one head is recovered without a state file: --fresh over a PR whose H1 review someone else posted → the claim on H2 is delta', async () => {
  const state = stateFile();
  writeFileSync(state, JSON.stringify({ iterationHead: H2, iterations: 1, startedAt: T0, claimsOnHead: {} }));
  // no coordinator row at all: a hand-run review is visible only on the PR
  const { w, deps } = fullReviewedOnH1({ attempts: [] });
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, resume: false, bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual(lensCalls(w).map(sinceOf), [H1, H1]);
});

test('a legacy marker-less review with a body is a full review (the reading claim gives it); another author\'s review and a reply container are not rounds', async () => {
  const legacy = fullReviewedOnH1({ reviews: [listed({ id: 1, head: H1, marker: false })], attempts: [] });
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, legacy.deps);
  assert.deepEqual(lensCalls(legacy.w).map(sinceOf), [H1, H1]);

  const other = fullReviewedOnH1({ reviews: [listed({ id: 2, head: H1, login: 'someone-else' }), { ...listed({ id: 3, head: H1 }), body: '', reply_container: true }], attempts: [] });
  // `reply_container: true` is what readReviewListing sets; the fake listing carries it as-is
  other.deps.runGh = ((inner) => (args, o) => {
    if (args[0] === 'api' && args[1] === '--paginate' && /\/reviews\/\d+\/comments$/.test(args[2])) return 'true\n';
    return inner(args, o);
  })(other.deps.runGh);
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, other.deps);
  assert.deepEqual(lensCalls(other.w).map(sinceOf), [null, null], 'no round by the posting identity → a full review');
});

test('no third review: a posted delta on H2 and a new head H3, threads resolved, checks green → converged with unreviewed_tail, and no claim is spawned', async () => {
  const state = stateFile();
  const { w, deps } = world({
    head: H3,
    reviews: [listed({ id: 7001, head: H1 }), listed({ id: 7002, head: H2, since: H1 })],
    threads: [{ ...openThread(21), isResolved: true }],
  });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  assert.equal(r.outcome, 'converged');
  assert.equal(r.unreviewed_tail, 'bbbbbbb...ccccccc');
  assert.equal(r.unreviewed_commits, 1);
  assert.equal(r.review_id, 7002);
  assert.deepEqual(r.judgment_notes, []);
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 0, 'never claimed');

  // --claim beat changes nothing: no claim, no waiting for the beat
  const beat = world({ head: H3, reviews: [listed({ id: 7001, head: H1 }), listed({ id: 7002, head: H2, since: H1 })] });
  const rb = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1, claim: 'beat' } }, beat.deps);
  assert.equal(rb.outcome, 'converged');
  assert.equal(beat.w.writerCalls.length, 0);
});

test('no third review, and the tail must sit on top of what was reviewed: an open thread is your turn; a head that does not descend from the delta head blocks amendment-not-descendant', async () => {
  const open = world({ head: H3, reviews: [listed({ id: 7001, head: H1 }), listed({ id: 7002, head: H2, since: H1 })], threads: [openThread(22)] });
  const ro = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, open.deps);
  assert.deepEqual([ro.outcome, ro.review_id], ['adjudicate', 7002]);

  const rebased = world({ head: H3, history: [H1, H3], reviews: [listed({ id: 7001, head: H1 }), listed({ id: 7002, head: H2, since: H1 })] });
  const rr = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, rebased.deps);
  assert.deepEqual([rr.outcome, rr.reason], ['blocked', 'amendment-not-descendant']);
  assert.match(rr.owed, /conductor decides how this head is reviewed/);
  assert.equal(rebased.w.writerCalls.length, 0);
});

test('a refused delta blocks: the writer answers input-mismatch on the delta lens → blocked amendment-not-descendant, no second lens, no second claim, never a full review', async () => {
  const { w, deps } = fullReviewedOnH1({ lensRefusesSince: true });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'amendment-not-descendant']);
  assert.match(r.owed, /conductor decides how this head is reviewed/);
  assert.match(r.owed, /ref-bbbbbbb/, 'the owed names the live attempt-ref for the conductor');
  assert.deepEqual(w.writerCalls.map((c) => c[0]), ['claim', 'lens']);
  assert.ok(lensCalls(w).every((c) => sinceOf(c) === H1), 'no lens ran without --since');
});

test('a rebased head is refused before any claim: the delta pre-check runs the writer\'s own amendment rule over the compare', async () => {
  const { w, deps } = fullReviewedOnH1({ history: [H2] });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual([r.outcome, r.reason], ['blocked', 'amendment-not-descendant']);
  assert.match(r.owed, /not an ancestor/);
  assert.equal(w.writerCalls.length, 0);
});

test('--claim beat on round two: still a session claim with --since, and the decision says why', async () => {
  const lines = [];
  const { w, deps } = fullReviewedOnH1();
  deps.log = (l) => lines.push(l);
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1, claim: 'beat' } }, deps);
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 1);
  assert.deepEqual(lensCalls(w).map(sinceOf), [H1, H1]);
  assert.ok(lines.some((l) => /--claim beat does not apply: the beat cannot run a delta pass yet/.test(l)), lines.join('\n'));
  // round one still waits for the beat
  const fresh = world();
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 60, maxWallMinutes: 2, claim: 'beat' } }, fresh.deps);
  assert.equal(fresh.w.writerCalls.length, 0);
});

test('--skip-delta: the amendment judged trivial → no delta claim; converged with delta_skipped and the tail in the receipt and the state file; the next head is owed its delta again', async () => {
  const state = stateFile();
  const { w, deps } = fullReviewedOnH1();
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, skipDelta: 'typo in a comment', bounds: { pollSeconds: 1 } }, deps);
  assert.equal(r.outcome, 'converged');
  assert.equal(r.delta_skipped, 'typo in a comment');
  assert.equal(r.unreviewed_tail, 'aaaaaaa...bbbbbbb');
  assert.equal(w.writerCalls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).deltaSkipped, { head: H2, reason: 'typo in a comment' });

  w.head = H3;
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual(lensCalls(w).map(sinceOf), [H1, H1], 'the skip covered H2 only');
});

test('--skip-delta on round one is ignored (logged): the full review is still claimed', async () => {
  const lines = [];
  const { w, deps } = world();
  deps.log = (l) => lines.push(l);
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), skipDelta: 'x', bounds: { pollSeconds: 1 } }, deps);
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 1);
  assert.ok(lines.some((l) => /--skip-delta ignored/.test(l)));
});

test('--context-file reaches both lenses in round one and in round two', async () => {
  const { w, deps } = world({ findingsOnPost: (ww) => (ww.head === H1 ? [openThread(31)] : []) });
  const state = stateFile();
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, contextFile: '/abs/uncertainty.md', bounds: { pollSeconds: 1 } }, deps);
  await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 31, verdict: 'confirmed', bodyFile: 'x.md', statePath: state }, deps);
  w.head = H2;
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, contextFile: '/abs/uncertainty.md', bounds: { pollSeconds: 1 } }, deps);
  const calls = lensCalls(w);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c[c.indexOf('--context-file') + 1] === '/abs/uncertainty.md'));
  assert.deepEqual(calls.map(sinceOf), [null, null, H1, H1]);
});

test('verdict fields: adjudicate --verdict judgment --adjudicator lane spawns reply with both; without --adjudicator the reply carries none; judgment ids reach the converged receipt', async () => {
  const state = stateFile();
  const { w, deps } = world({ reviews: [listed({ id: 7001, head: H1 })], attempts: [{ head_sha: H1, attempt: 1, state: 'posted', disposition: null, review_id: 7001, origin: 'beat' }], threads: [openThread(41), openThread(42)] });
  const a = await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 41, verdict: 'judgment', adjudicator: 'lane', bodyFile: 'x.md', statePath: state }, deps);
  assert.equal(a.outcome, 'ok');
  const reply1 = w.writerCalls.filter((c) => c[0] === 'reply')[0];
  assert.deepEqual(reply1.slice(reply1.indexOf('--verdict'), reply1.indexOf('--verdict') + 4), ['--verdict', 'judgment', '--adjudicator', 'lane']);

  await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 42, verdict: 'confirmed', bodyFile: 'x.md', statePath: state }, deps);
  const reply2 = w.writerCalls.filter((c) => c[0] === 'reply')[1];
  assert.ok(!reply2.includes('--adjudicator'), 'an existing caller is unchanged');

  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).judgmentNotes, ['41']);
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual([r.outcome, r.judgment_notes], ['converged', ['41']]);
  // --fresh resets the bounds, not the verdicts already given
  const fresh = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, resume: false, bounds: { pollSeconds: 1 } }, deps);
  assert.deepEqual(fresh.judgment_notes, ['41']);
});

test('reviews per PR are capped at 2 by construction: full on H1, fix H2 → delta, fix H3 → converged with no claim; two claims in all', async () => {
  const { w, deps } = world({ findingsOnPost: (ww) => (ww.head !== H3 ? [openThread(ww.head === H1 ? 51 : 52)] : []) });
  const state = stateFile();
  const run = () => runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  assert.equal((await run()).outcome, 'adjudicate');
  await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 51, verdict: 'confirmed', bodyFile: 'x.md', statePath: state }, deps);
  w.head = H2;
  assert.equal((await run()).outcome, 'adjudicate');
  await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 52, verdict: 'confirmed', bodyFile: 'x.md', statePath: state }, deps);
  w.head = H3;
  const r = await run();
  assert.deepEqual([r.outcome, r.unreviewed_tail, r.iterations], ['converged', 'bbbbbbb...ccccccc', 3]);
  assert.equal(w.writerCalls.filter((c) => c[0] === 'claim').length, 2);
  assert.deepEqual(w.reviews.map((x) => /since=/.test(x.body) ? 'delta' : 'full'), ['full', 'delta']);
});

test('run refuses an unreadable or empty --context-file and an empty --skip-delta reason before anything runs (exit 4)', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pr-babysit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'babysit-cli-'));
  const empty = join(dir, 'empty.md');
  writeFileSync(empty, '  \n');
  const runCli = (extra) => spawnSync(process.execPath, [script, 'run', '--pr', '1', '--repo', 'o/r', '--cwd', dir, ...extra], { encoding: 'utf8' });
  const missing = runCli(['--context-file', join(dir, 'nope.md')]);
  assert.equal(missing.status, 4, missing.stderr);
  assert.match(missing.stderr, /--context-file could not be read/);
  const blank = runCli(['--context-file', empty]);
  assert.equal(blank.status, 4, blank.stderr);
  assert.match(blank.stderr, /--context-file is empty/);
  const noReason = runCli(['--skip-delta', ' ']);
  assert.equal(noReason.status, 4, noReason.stderr);
  assert.match(noReason.stderr, /--skip-delta needs a reason/);
});

test('the posting identity is required: without it the head is never read as unreviewed — both shapes of "none pinned" block identity-unset, and nothing is claimed', async () => {
  const shapes = {
    // the client's own refusal for a 404 on /identity (pr-review-coordinator.mjs refusal())
    'client refusal': async () => ({ ok: false, code: 'identity-unset', source: 'client', status: 404, message: 'readIdentity: identity-unset' }),
    'answer with no login': async () => ({ ok: true, status: 200, body: {} }),
  };
  for (const [name, readIdentity] of Object.entries(shapes)) {
    const { w, deps } = fullReviewedOnH1();
    deps.coordinator.readIdentity = readIdentity;
    const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
    assert.deepEqual([r.outcome, r.reason], ['blocked', 'identity-unset'], name);
    assert.match(r.owed, /identity --pin --reason/, name);
    assert.equal(w.writerCalls.length, 0, name);
  }
});

test('identity-unset never over-matches: a network error, another refusal code, or a message that merely mentions identity-unset stays coordinator-unreachable', async () => {
  const cases = {
    'readIdentity network error': (deps) => { deps.coordinator.readIdentity = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3100'); }; },
    'readIdentity unreachable refusal': (deps) => { deps.coordinator.readIdentity = async () => ({ ok: false, code: 'coordinator-unreachable', source: 'client', message: 'readIdentity: coordinator-unreachable' }); },
    'readIdentity other code, identity-unset in the message': (deps) => { deps.coordinator.readIdentity = async () => ({ ok: false, code: 'unauthorized', source: 'coordinator', status: 401, message: 'identity-unset? no: the token was refused' }); },
    'readStatus network error': (deps) => { deps.coordinator.readStatus = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3100'); }; },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const { w, deps } = fullReviewedOnH1();
    arrange(deps);
    const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
    assert.deepEqual([r.outcome, r.reason], ['blocked', 'coordinator-unreachable'], name);
    assert.equal(w.writerCalls.length, 0, name);
  }
});

test('adjudicate --body-file: a relative path reaches reply as an absolute path resolved against the caller\'s cwd; a missing one is exit 4 before any spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'babysit-body-'));
  writeFileSync(join(dir, 'reply-5.md'), 'refuted: the guard at x.ts:3');
  const { w, deps } = world({ threads: [openThread(5)] });
  const v = await adjudicateVerb({ repo: 'o/r', pr: 1, cwd: '/some/checkout', commentId: 5, verdict: 'refuted', bodyFile: 'reply-5.md', statePath: stateFile() }, deps, { cwd: dir });
  assert.equal(v.exitCode, 0);
  const reply = w.writerCalls.find((c) => c[0] === 'reply');
  assert.equal(reply[reply.indexOf('--body-file') + 1], join(dir, 'reply-5.md'));

  const missing = world({ threads: [openThread(6)] });
  const m = await adjudicateVerb({ repo: 'o/r', pr: 1, cwd: '/some/checkout', commentId: 6, verdict: 'note', bodyFile: 'nope.md', statePath: stateFile() }, missing.deps, { cwd: dir });
  assert.equal(m.exitCode, 4);
  assert.match(m.error, /--body-file not found/);
  assert.equal(missing.w.writerCalls.length, 0);
  assert.equal(missing.w.ghCalls.length, 0);
});

test('the adjudicate CLI refuses a missing --body-file with exit 4 and says so', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pr-babysit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'babysit-cli-'));
  const r = spawnSync(process.execPath, [script, 'adjudicate', '--pr', '1', '--repo', 'o/r', '--cwd', dir, '--comment-id', '5', '--verdict', 'note', '--body-file', 'nope.md'], { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /--body-file not found: .*nope\.md/);
});

// ---------------------------------------------------------------------------
// Amendment 1 (T1 round one on workit#116)
// ---------------------------------------------------------------------------

const postDelta = (over = {}) => world({ head: H3, reviews: [listed({ id: 7001, head: H1 }), listed({ id: 7002, head: H2, since: H1 })], ...over });

test('T1 workit#116 (4116626534 i) — a post-delta tail with a merge from base, or a commit list too short to rule one out, blocks amendment-not-descendant; ancestry alone never converges it', async () => {
  const merged = postDelta({ onCompare: (p) => ({ ...p, commits: p.commits.map((c) => ({ ...c, parents: [{ sha: 'p' }, { sha: 'base' }] })) }) });
  const rm = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, merged.deps);
  assert.deepEqual([rm.outcome, rm.reason], ['blocked', 'amendment-not-descendant']);
  assert.match(rm.owed, /merge commit/);
  assert.equal(merged.w.writerCalls.length, 0);

  const partial = postDelta({ onCompare: (p) => ({ ...p, total_commits: 300 }) });
  const rp = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, partial.deps);
  assert.deepEqual([rp.outcome, rp.reason], ['blocked', 'amendment-not-descendant']);
  assert.match(rp.owed, /cannot be ruled out/);
});

test('T1 workit#116 (4116626534 i) — an ahead tail that changes no file (an empty commit to re-run CI) still converges on the tail', async () => {
  const empty = postDelta({ onCompare: (p) => ({ ...p, files: [] }) });
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, empty.deps);
  assert.deepEqual([r.outcome, r.unreviewed_tail], ['converged', 'bbbbbbb...ccccccc']);
});

test('T1 workit#116 delta (4116653420, 4116653423) — a zero-file tail is exempt only with no merge commit and a complete commit list', async () => {
  const cases = {
    'a merge commit': (p) => ({ ...p, files: [], commits: p.commits.map((c) => ({ ...c, parents: [{ sha: 'p' }, { sha: 'base' }] })) }),
    'an incomplete commit list': (p) => ({ ...p, files: [], total_commits: 300 }),
    'no commit list': (p) => ({ ...p, files: [], commits: undefined }),
  };
  for (const [name, onCompare] of Object.entries(cases)) {
    const { w, deps } = postDelta({ onCompare });
    const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: stateFile(), bounds: { pollSeconds: 1 } }, deps);
    assert.deepEqual([r.outcome, r.reason], ['blocked', 'amendment-not-descendant'], name);
    assert.equal(w.writerCalls.length, 0, name);
  }
});

test('T1 workit#116 (4116626540) — --skip-delta is dropped when the head moves during the first read; the head that arrives is owed its delta', async () => {
  const lines = [];
  const state = stateFile();
  // the first observation reads H2 before and H3 after
  const { w, deps } = fullReviewedOnH1({ headReads: [H2, H3] });
  deps.log = (l) => lines.push(l);
  const r = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, skipDelta: 'judged on H2', bounds: { pollSeconds: 1 } }, deps);
  assert.equal(r.delta_skipped, undefined);
  assert.deepEqual(lensCalls(w).map(sinceOf), [H1, H1], 'H3 got its delta pass');
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).deltaSkipped, null);
  assert.ok(lines.some((l) => /--skip-delta dropped/.test(l)), lines.join('\n'));
});

test('T1 workit#116 (4116626543) — the context file is persisted: a resumed delta run without --context-file still passes it; a new flag replaces it; --fresh drops it', async () => {
  const { w, deps } = world({ findingsOnPost: (ww) => (ww.head === H1 ? [openThread(61)] : []) });
  const state = stateFile();
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, contextFile: '/abs/round-one.md', bounds: { pollSeconds: 1 } }, deps);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).contextFile, '/abs/round-one.md');
  await adjudicate({ repo: 'o/r', pr: 1, cwd: '.', commentId: 61, verdict: 'confirmed', bodyFile: 'x.md', statePath: state }, deps);
  w.head = H2;
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, bounds: { pollSeconds: 1 } }, deps);
  const calls = lensCalls(w);
  assert.deepEqual(calls.map(sinceOf), [null, null, H1, H1]);
  assert.ok(calls.every((c) => c[c.indexOf('--context-file') + 1] === '/abs/round-one.md'), 'the resumed delta pass carries the round-one context');
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).contextFile, '/abs/round-one.md');

  const replaced = await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, contextFile: '/abs/round-two.md', bounds: { pollSeconds: 1 } }, deps);
  assert.equal(replaced.outcome, 'converged');
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).contextFile, '/abs/round-two.md');
  await runLoop({ repo: 'o/r', pr: 1, cwd: '.', statePath: state, resume: false, bounds: { pollSeconds: 1 } }, deps);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).contextFile, null);
});

test('T1 workit#116 (4116626543) — run checks a context file taken from the state file before anything runs (exit 4)', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pr-babysit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'babysit-cli-'));
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ contextFile: join(dir, 'gone.md') }));
  const r = spawnSync(process.execPath, [script, 'run', '--pr', '1', '--repo', 'o/r', '--cwd', dir, '--state', state], { encoding: 'utf8' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /--context-file \(from the state file\) could not be read/);
});
