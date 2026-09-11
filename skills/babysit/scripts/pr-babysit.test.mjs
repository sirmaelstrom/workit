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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, runLoop, summariseChecks, normaliseThreads, adjudicate, unwrapClientResponse, fetchAllThreads, DEFAULT_BOUNDS, BLOCKED_REASONS, COMMENTS_PAGE } from './pr-babysit.mjs';

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
    [obs({ head: H4, headBefore: H4, headAfter: H4 }), ctx({ iterationHead: H3, iterations: 3 })],
    [obs({ checks: { pass: 0, pending: 0, fail: 1, skipping: 0, names: { fail: ['a'], pending: [] } } }), ctx()],
    [obs({ at: T0 + 200 * MIN }), ctx()],
    [obs({ health: { enabled: false, paused: false } }), ctx()],
    [obs({ health: { enabled: true, paused: true } }), ctx()],
    [obs({ status: { attempts: [{ head_sha: H1, attempt: 1, state: 'failed', disposition: 'lens-error' }] } }), ctx({ claimsOnHead: { [H1]: 1 } })],
  ];
  for (const [o, c] of cases) { const d = decide(o, c); if (d.action === 'blocked') seen.add(d.reason); }
  for (const r of seen) assert.ok(BLOCKED_REASONS.includes(r), `${r} not in the closed set`);
  assert.ok(seen.size >= 6);
});

test('T1 workit#93 — the coordinator client answers an ENVELOPE; the loop reads the view inside it, and a refusal is an error (the live run on obs#676 waited on a review it could not see)', () => {
  assert.deepEqual(unwrapClientResponse({ ok: true, status: 200, body: { attempts: [1] } }), { attempts: [1] });
  assert.deepEqual(unwrapClientResponse({ attempts: [] }), { attempts: [] });
  assert.throws(() => unwrapClientResponse({ ok: false, reason: 'coordinator-unreachable', message: 'ECONNREFUSED' }), /coordinator-unreachable/);
  assert.throws(() => unwrapClientResponse(null), /empty/);
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
    health: { enabled: true, paused: false, pauseReason: 'none' },
    clock: T0,
    writerCalls: [],
    ghCalls: [],
    onClaim: null, // (w) => void — scripted reaction to a claim
    ...init,
  };
  const deps = {
    managed: { mode: 'managed' },
    coordinator: {
      // the REAL client's shape: an envelope around the view (regression for the obs#676 live run)
      readStatus: async () => ({ ok: true, status: 200, body: { attempts: w.attempts.map((a) => ({ ...a })), posted_head: null, posted_review_id: null } }),
      readHealth: async () => ({ ...w.health }),
    },
    runGh: (args) => {
      w.ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') return `${w.head}\n`;
      if (args[0] === 'pr' && args[1] === 'checks') return JSON.stringify(w.checks);
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
        if (w.lensOutcome === 'fail') { a.state = 'failed'; a.disposition = 'lens-error'; return { outcome: 'failed', reason: 'lens-error', retry: 'stop' }; }
        a.state = args[3] === 'astra' ? 'lens_done' : 'lens_running';
        return { outcome: 'ok', retry: 'stop' };
      }
      if (args[0] === 'post') {
        const a = w.attempts[w.attempts.length - 1];
        a.state = 'posted'; a.review_id = 9000 + a.attempt;
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
