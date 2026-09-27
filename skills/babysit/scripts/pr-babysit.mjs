#!/usr/bin/env node
/**
 * pr-babysit — bounded convergence over the coordinated PR review (quest 14af0696).
 *
 * The session judges; this script observes, decides, waits and reports. Its
 * contract is the spec-lite at data/outputs/workshops/pr-babysit/spec.md:
 *
 *   converged  ⇔  a POSTED paired attempt on the PR's CURRENT head
 *               ∧ every review thread resolved
 *               ∧ every check on that head pass/skipping
 *               ∧ the head did not move while the loop read it
 *
 * The review rounds are capped (quest 329cba0d, slim-review § 4): one full
 * review, then one delta pass (`lens --since <full head>`) on the next head,
 * then no third review. A head after the delta pass converges on its checks
 * and resolved threads alone when the last reviewed head is its ancestor with
 * no merge from the base branch between, and the receipt names the
 * `unreviewed_tail`. The rounds are read from the PR's
 * posted review markers, not from the state file, so a review posted by the
 * beat or by hand counts.
 *
 * Everything else is `wait`, `claim` (at most one session claim per head —
 * D4), `adjudicate` (your turn: judge the open threads, push fixes, run
 * again), `new-head` (an iteration), or `blocked` with a reason from a closed
 * set and an `owed` sentence. Every wait has a bound. There is no merge path.
 *
 * Verbs:
 *   run        --pr <n> --repo <owner/name> --cwd <checkout> [--claim session|beat]
 *              [--max-heads 3] [--max-wall-minutes 90] [--poll-seconds 60]
 *              [--session-claims 1] [--state <file>] [--context-file <uncertainty.md>]
 *              [--skip-delta "<reason>"]
 *   status     --pr --repo --cwd            one observation + decision, no waiting
 *   threads    --pr --repo --cwd [--json]   every review thread (resolved or not)
 *   adjudicate --pr --repo --cwd --comment-id <id> --verdict confirmed|refuted|note|judgment --body-file <f>
 *              [--adjudicator lane|conductor|operator]
 *              reply through the writer (T1 measurement row) and RESOLVE the thread
 *
 * Exit: 0 converged · 2 blocked · 3 adjudicate (your turn) · 4 usage / gh failure.
 * Every terminal exit prints one JSON receipt line on stdout.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createClient, CLIENT_REASONS } from '../../slim-review/scripts/pr-review-coordinator.mjs';
import { loadCoordinatorToken, resolveManaged, MANAGED_MODES } from '../../slim-review/scripts/pr-review-managed.mjs';
import { postedReviewScope } from '../../slim-review/scripts/pr-review-recognise.mjs';
import { amendmentProblem, readReviewListing } from '../../slim-review/scripts/pr-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WRITER_SCRIPT = resolve(HERE, '..', '..', 'slim-review', 'scripts', 'pr-review.mjs');
export const REQUIRED_LENSES = Object.freeze(['codex', 'astra']);

export const DEFAULT_BOUNDS = Object.freeze({
  maxHeads: 3,
  maxWallMinutes: 90,
  pollSeconds: 60,
  sessionClaimsPerHead: 1,
  claim: 'session', // 'session' | 'beat'
});

/** The closed set of blocked reasons (spec D7). */
export const BLOCKED_REASONS = Object.freeze([
  'reviewer-never-answered',
  'attempt-failed',
  'attempt-ended-no-retry',
  'ci-failed',
  'head-moved-limit',
  'wall-time',
  'plan-paused',
  'disabled',
  'delivery-unresolved',
  'integrity-violation',
  'unresolved-threads',
  'coordinator-unreachable',
  'not-managed',
  'checks-unavailable',
  'threads-truncated',
  'amendment-not-descendant',
  'identity-unset',
]);

/**
 * The coordinator client answers `{ok:true, status, body}` or a refusal
 * `{ok:false, code, source, …, message}` — never the view itself. Unwrap, or
 * throw the refusal, naming its code, so the observation records it (T1 on
 * workit#93, Terra P1: the loop read `.attempts` off the envelope and never
 * saw a posted review).
 */
export function unwrapClientResponse(r, what = 'readStatus') {
  if (!r || typeof r !== 'object') throw new Error(`${what}: empty response`);
  if (r.ok === false) throw new Error(`${what}: ${r.code ?? r.reason ?? 'refused'}${r.message ? ` — ${r.message}` : ''}`);
  if (r.ok === true && 'body' in r) return r.body;
  return r; // already a view (tests, or a future client that returns it bare)
}

const LIVE_STATES = new Set(['claimed', 'lens_running', 'lens_done', 'posting', 'delivery-unresolved']);
const ENDED_STATES = new Set(['failed', 'withdrawn', 'superseded', 'post_rejected', 'replaced']);

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export const THREADS_PAGE = 100;
export const COMMENTS_PAGE = 50;

const THREADS_QUERY = `
query($owner:String!, $name:String!, $pr:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      reviewThreads(first:${THREADS_PAGE}, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:${COMMENTS_PAGE}) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

/**
 * Every review thread, paginated. A thread whose comment page is full is
 * reported as truncated — convergence is never decided over a listing that
 * may be missing an open reply (T1 on workit#93: both lenses).
 */
export function fetchAllThreads({ repo, pr, cwd }, runGh) {
  const [owner, name] = repo.split('/');
  const nodes = [];
  let after = null;
  let truncated = false;
  for (let page = 0; page < 50; page++) {
    const args = ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`];
    if (after) args.push('-F', `after=${after}`);
    const conn = JSON.parse(runGh(args, { cwd })).data.repository.pullRequest.reviewThreads;
    nodes.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  if (nodes.some((t) => (t.comments?.nodes?.length ?? 0) >= COMMENTS_PAGE)) truncated = true;
  return { nodes, truncated };
}

const RESOLVE_MUTATION = `
mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }`;

export function gh(args, { input, cwd } = {}) {
  return execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    input,
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

/** Summarise `gh pr checks --json` rows into the three buckets the decision reads. */
export function summariseChecks(rows) {
  const out = { pass: 0, pending: 0, fail: 0, skipping: 0, names: { fail: [], pending: [] } };
  for (const r of rows) {
    const b = String(r.bucket ?? '').toLowerCase();
    if (b === 'pass') out.pass += 1;
    else if (b === 'skipping') out.skipping += 1;
    else if (b === 'pending') { out.pending += 1; out.names.pending.push(r.name); }
    else { out.fail += 1; out.names.fail.push(r.name); } // fail, cancel, unknown → not green
  }
  return out;
}

export function normaliseThreads(nodes) {
  return nodes.map((t) => {
    const comments = t.comments?.nodes ?? [];
    const head = comments[0];
    const body = String(head?.body ?? '');
    const lens = /\*\*lens:\*\*\s*([a-z0-9-]+)/i.exec(body)?.[1]?.toLowerCase() ?? null;
    return {
      id: t.id,
      commentId: head?.databaseId ?? null,
      path: t.path,
      line: t.line ?? null,
      resolved: t.isResolved === true,
      outdated: t.isOutdated === true,
      author: head?.author?.login ?? null,
      lens,
      first: body.split(/\r?\n/).find((l) => l.trim() !== '')?.slice(0, 140) ?? '',
      replies: Math.max(0, comments.length - 1),
    };
  });
}

/**
 * One observation of the PR: head (read twice, before and after), checks on
 * that head, review threads, the coordinator's attempts, the beat's gate.
 */
export async function observe({ repo, pr, cwd }, deps) {
  const readHead = () => deps.runGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid', '-q', '.headRefOid'], { cwd }).trim();
  const headBefore = readHead();
  const [owner, name] = repo.split('/');

  // `gh pr checks` exits non-zero when a check is FAILING and still prints
  // the JSON; a run that printed nothing is a failed READ — fail closed as
  // `unknown`, never as "no checks, therefore green" (T1 on workit#93).
  const checksRaw = deps.runGh(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state,bucket'], { cwd, allowFailure: true });
  let checks;
  try {
    const rows = JSON.parse(String(checksRaw ?? '').trim() || 'null');
    checks = Array.isArray(rows) ? summariseChecks(rows) : { ...summariseChecks([]), unknown: true };
  } catch {
    checks = { ...summariseChecks([]), unknown: true };
  }

  const { nodes, truncated } = fetchAllThreads({ repo, pr, cwd }, deps.runGh);
  const threads = normaliseThreads(nodes);
  void owner; void name;

  let status = null;
  let health = null;
  let identity = null;
  let identityUnset = false;
  let coordinatorError = null;
  try {
    status = unwrapClientResponse(await deps.coordinator.readStatus({ repo, pr }), 'readStatus');
    health = await deps.coordinator.readHealth();
    // The posting identity decides which listed reviews are rounds. Without it
    // every review would be filtered out and the head would read as never
    // reviewed, which is the direction that claims a second full review. The
    // coordinator answering "none pinned" (the client's identity-unset code,
    // or a body with no login) is its own block; anything else is unreachable.
    const answer = await deps.coordinator.readIdentity();
    if (answer?.ok === false && answer.code === CLIENT_REASONS.identityUnset) identityUnset = true;
    else {
      identity = unwrapClientResponse(answer, 'readIdentity');
      if (!identity?.login) identityUnset = true;
    }
  } catch (err) {
    coordinatorError = err instanceof Error ? err.message : String(err);
  }

  // The rounds come from the posted reviews' markers: the coordinator's status
  // rows carry no scope, and a state file knows only this loop's own claims.
  let reviews = [];
  let tail = null;
  if (!coordinatorError && !identityUnset) {
    const replacedReviewIds = (status?.attempts ?? []).filter((a) => a.state === 'replaced').map((a) => a.review_id).filter((id) => id !== null && id !== undefined);
    reviews = readReviewListing({ repo, pr, cwd, runGh: deps.runGh })
      .map((r) => postedReviewScope(r, { serviceLogin: identity.login, replacedReviewIds }))
      .filter(Boolean);
    const last = reviews[reviews.length - 1];
    if (last && last.head !== headBefore) {
      const payload = JSON.parse(deps.runGh(['api', `repos/${repo}/compare/${last.head}...${headBefore}`], { cwd }));
      const commits = Array.isArray(payload?.commits) ? payload.commits : null;
      tail = {
        from: last.head,
        to: headBefore,
        status: payload?.status ?? null,
        aheadBy: payload?.ahead_by ?? null,
        files: Array.isArray(payload?.files) ? payload.files.length : null,
        // read here, not from `problem`: amendmentProblem answers "no changed
        // files" before it looks at merges or the commit list
        merge: commits ? commits.some((cm) => (cm?.parents?.length ?? 0) > 1) : null,
        commitsComplete: commits !== null && !(Number.isInteger(payload?.total_commits) && payload.total_commits > commits.length),
        problem: amendmentProblem(payload, last.head, headBefore),
      };
    }
  }

  const headAfter = readHead();
  return { repo, pr, headBefore, headAfter, head: headAfter, checks, threads, threadsTruncated: truncated, status, health, coordinatorError, identityUnset, reviews, tail, at: deps.now() };
}

// ---------------------------------------------------------------------------
// Decision — pure
// ---------------------------------------------------------------------------

function owedFor(reason, ctx, extra = {}) {
  const head = (ctx.head ?? '').slice(0, 7);
  switch (reason) {
    case 'reviewer-never-answered': return `an attempt on head ${head} stayed live (${extra.state ?? 'in flight'}) for the whole ${ctx.bounds.maxWallMinutes} min budget — a person checks the writer/beat logs and either runs \`pr-review.mjs recover abandon\` on it or waits.`;
    case 'attempt-failed': return `attempt ${extra.attempt ?? '?'} on head ${head} ended ${extra.state ?? 'failed'}/${extra.disposition ?? '?'} and this loop's claim allowance for that head is spent — a person reads the reason and runs \`pr-review.mjs claim\` if a retry is wanted.`;
    case 'attempt-ended-no-retry': return `the automatic attempt on head ${head} ended ${extra.state ?? 'failed'}/${extra.disposition ?? '?'}; session claims are disabled (--session-claims 0) — a person runs \`pr-review.mjs claim\` or pushes a new head.`;
    case 'ci-failed': return `check(s) failing on head ${head}: ${(extra.names ?? []).join(', ') || '?'} — fix and push a new head, then run again.`;
    case 'head-moved-limit': return `the head moved ${ctx.iterations} time(s), past --max-heads ${ctx.bounds.maxHeads} — a person decides whether to keep going (run again with a higher bound).`;
    case 'wall-time': return `${ctx.bounds.maxWallMinutes} min elapsed without convergence — a person decides whether to keep going.`;
    case 'plan-paused': return `the coordinator's reserve gate is paused (${extra.pauseReason ?? 'reserve'}) — no claim will be made; wait for the meter or rule an exception.`;
    case 'disabled': return `the PR-review beat is disabled (kill switch) — no claim will be made; a person enables it or reviews by hand.`;
    case 'delivery-unresolved': return `a review submission on head ${head} has no known outcome (delivery-unresolved) — never re-POSTed by this loop; a person runs \`pr-review.mjs recover not-delivered\` after checking the PR.`;
    case 'integrity-violation': return `a lens on head ${head} reported worktree-dirty — the reviewer's checkout was edited during the run; keep the canonical checkout clean and run again (one session claim allowed).`;
    case 'unresolved-threads': return `${extra.count ?? '?'} review thread(s) still open on head ${head} at the wall budget — adjudicate them (\`pr-babysit.mjs threads\` / \`adjudicate\`) and run again.`;
    case 'coordinator-unreachable': return `the coordinator could not be read (${extra.error ?? '?'}) — is Observatory up on loopback?`;
    case 'identity-unset': return `the coordinator answered but has no posting identity pinned, so this loop cannot tell which posted reviews are rounds and will not claim — the operator pins it with \`pr-review.mjs identity --pin --reason "<why>"\` (slim-review SKILL § Managed repositories), then run again.`;
    case 'not-managed': return `${ctx.repo} is not a managed repository — use slim-review's standalone loop.`;
    case 'checks-unavailable': return `the checks on head ${head} could not be read for the whole budget (gh pr checks printed nothing) — fix gh/auth and run again; a run cannot converge on checks it never saw.`;
    case 'threads-truncated': return `a review thread on this PR has ${COMMENTS_PAGE}+ comments, past this loop's page size — adjudicate from the PR page; a truncated listing is never read as "all resolved".`;
    case 'amendment-not-descendant': return `there is no amendment diff from the last reviewed head ${(extra.from ?? '').slice(0, 7)} to head ${head} (${extra.problem ?? 'refused'}) — the conductor decides how this head is reviewed; this loop never claims a second full review.${extra.attemptRefFile ? ` The delta attempt stays live for that call: run its lenses without --since (\`pr-review.mjs lens --attempt-ref ${extra.attemptRefFile}\`), or \`pr-review.mjs recover withdraw --attempt-ref ${extra.attemptRefFile} --reason "<why>"\`.` : ''}`;
    default: return 'a person decides.';
  }
}

/**
 * Which review round the current head is in, from the posted reviews in
 * listing order (`postedReviewScope` entries). Pure.
 *
 *   full      no review yet — claim a full paired review
 *   reviewed  the last review is on this head — the existing path decides
 *   delta     a full review, no delta after it — claim a delta since its head
 *   capped    a delta after the last full review — no claim; converge on the tail
 *
 * Counting from the LAST full review means a full review the conductor ran
 * after a refused delta opens a fresh pair; nothing this loop claims does.
 */
export function reviewRound(reviews, head) {
  if (reviews.length === 0) return { round: 'full' };
  const last = reviews[reviews.length - 1];
  if (last.head === head) return { round: 'reviewed', last };
  let fullAt = -1;
  for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].scope === 'full') { fullAt = i; break; }
  // a delta with no full review before it cannot open round two again
  if (fullAt === -1 || reviews.slice(fullAt + 1).some((r) => r.scope === 'delta')) return { round: 'capped', last };
  return { round: 'delta', since: reviews[fullAt].head, last };
}

/**
 * The decision, given one observation and the loop's context. Pure.
 *
 * ctx: { repo, iterationHead, iterations, startedAt, claimsOnHead: {head: n}, bounds, deltaSkipped?: {head, reason} }
 * → { action: 'converged'|'wait'|'claim'|'adjudicate'|'new-head'|'blocked', reason?, owed?, detail?, since? }
 */
export function decide(obs, ctx) {
  const bounds = ctx.bounds;
  const elapsedMin = (obs.at - ctx.startedAt) / 60_000;
  const c = { ...ctx, head: obs.head };

  if (obs.coordinatorError) return { action: 'blocked', reason: 'coordinator-unreachable', owed: owedFor('coordinator-unreachable', c, { error: obs.coordinatorError }) };
  if (obs.identityUnset) return { action: 'blocked', reason: 'identity-unset', owed: owedFor('identity-unset', c) };
  if (obs.headBefore !== obs.headAfter) return { action: 'wait', detail: 'head moved during the read' };

  if (obs.head !== ctx.iterationHead) {
    if (ctx.iterations + 1 > bounds.maxHeads) return { action: 'blocked', reason: 'head-moved-limit', owed: owedFor('head-moved-limit', { ...c, iterations: ctx.iterations + 1 }) };
    return { action: 'new-head', detail: `head ${(ctx.iterationHead ?? '').slice(0, 7)} → ${obs.head.slice(0, 7)}` };
  }

  // Attempts are attributed to the head by `head_sha` (status rows carry it
  // since observatory#676). An older coordinator omits it: then only the
  // top-level `posted_head` pointer can attribute a POSTED review, and live /
  // ended rows are unattributable and ignored — a claim over a live row is
  // refused by the coordinator itself, which is the safe failure.
  const onHead = (obs.status?.attempts ?? []).filter((a) => a.head_sha === obs.head);
  let posted = onHead.find((a) => a.state === 'posted');
  if (!posted && obs.status?.posted_head === obs.head && obs.status?.posted_review_id) {
    posted = { head_sha: obs.head, attempt: null, state: 'posted', review_id: obs.status.posted_review_id };
  }
  const live = onHead.find((a) => LIVE_STATES.has(a.state));
  const ended = onHead.filter((a) => ENDED_STATES.has(a.state));
  const unresolved = obs.threads.filter((t) => !t.resolved);

  if (obs.checks.fail > 0) return { action: 'blocked', reason: 'ci-failed', owed: owedFor('ci-failed', c, { names: obs.checks.names.fail }) };
  if (obs.threadsTruncated) return { action: 'blocked', reason: 'threads-truncated', owed: owedFor('threads-truncated', c) };
  if (obs.checks.unknown) {
    if (elapsedMin > bounds.maxWallMinutes) return { action: 'blocked', reason: 'checks-unavailable', owed: owedFor('checks-unavailable', c) };
    return { action: 'wait', detail: 'checks could not be read (fail closed) — retrying' };
  }

  if (elapsedMin > bounds.maxWallMinutes) {
    if (live?.state === 'delivery-unresolved') return { action: 'blocked', reason: 'delivery-unresolved', owed: owedFor('delivery-unresolved', c) };
    if (live) return { action: 'blocked', reason: 'reviewer-never-answered', owed: owedFor('reviewer-never-answered', c, { state: live.state }) };
    if (posted && unresolved.length > 0) return { action: 'blocked', reason: 'unresolved-threads', owed: owedFor('unresolved-threads', c, { count: unresolved.length }) };
    return { action: 'blocked', reason: 'wall-time', owed: owedFor('wall-time', c) };
  }

  if (posted) {
    if (unresolved.length > 0) return { action: 'adjudicate', detail: `${unresolved.length} open thread(s)`, threads: unresolved, reviewId: posted.review_id };
    if (obs.checks.pending > 0) return { action: 'wait', detail: `checks pending: ${obs.checks.names.pending.join(', ')}` };
    return { action: 'converged', reviewId: posted.review_id, attempt: posted.attempt };
  }

  if (live) {
    if (live.state === 'delivery-unresolved') return { action: 'wait', detail: 'delivery-unresolved — waiting for the recogniser, never re-posting' };
    return { action: 'wait', detail: `attempt ${live.attempt} ${live.state}` };
  }

  // No posted, no live attempt on this head. The cap decides whether a claim
  // is owed at all, and at what scope.
  const round = reviewRound(obs.reviews ?? [], obs.head);
  const skipped = round.round === 'delta' && ctx.deltaSkipped?.head === obs.head ? ctx.deltaSkipped.reason : null;
  if (round.round === 'capped' || skipped) {
    // No third review (and no delta for a skipped amendment): the head
    // converges on controls alone, and only on top of what was reviewed.
    const tail = obs.tail;
    if (!tail || tail.from !== round.last.head || tail.to !== obs.head || tail.status !== 'ahead') {
      return { action: 'blocked', reason: 'amendment-not-descendant', owed: owedFor('amendment-not-descendant', c, { from: round.last.head, problem: `compare status ${tail?.status ?? 'missing'}` }) };
    }
    // Ancestry is not enough: after a merge from the base branch (or a commit
    // list too short to rule one out) the conductor decides how the head is
    // reviewed (slim-review § 4). An ahead tail that changes no file — an
    // empty commit to re-run CI — still converges, but only with no merge
    // commit and a complete commit list: a merge from base can leave the tree
    // unchanged when equivalent changes already landed.
    const emptyTail = tail.files === 0 && tail.merge === false && tail.commitsComplete === true;
    if (tail.problem && !emptyTail) {
      return { action: 'blocked', reason: 'amendment-not-descendant', owed: owedFor('amendment-not-descendant', c, { from: round.last.head, problem: tail.problem }) };
    }
    if (unresolved.length > 0) return { action: 'adjudicate', detail: `${unresolved.length} open thread(s)`, threads: unresolved, reviewId: round.last.review_id };
    if (obs.checks.pending > 0) return { action: 'wait', detail: `checks pending: ${obs.checks.names.pending.join(', ')}` };
    return {
      action: 'converged',
      reviewId: round.last.review_id,
      attempt: null,
      unreviewedTail: `${tail.from.slice(0, 7)}...${tail.to.slice(0, 7)}`,
      unreviewedCommits: tail.aheadBy,
      ...(skipped ? { deltaSkipped: skipped } : {}),
    };
  }
  const since = round.round === 'delta' ? round.since : undefined;
  if (since) {
    // Pre-checked with the writer's own rule, so a rebase costs no claim; the
    // writer's refusal of the same `--since` is handled by the driver.
    const problem = !obs.tail || obs.tail.from !== since || obs.tail.to !== obs.head ? 'no amendment compare was read' : obs.tail.problem;
    if (problem) return { action: 'blocked', reason: 'amendment-not-descendant', owed: owedFor('amendment-not-descendant', c, { from: since, problem }) };
  }
  const claim = (detail) => ({ action: 'claim', detail, ...(since ? { since } : {}) });

  if (obs.health && obs.health.enabled === false) return { action: 'blocked', reason: 'disabled', owed: owedFor('disabled', c) };
  if (obs.health && obs.health.paused === true) return { action: 'blocked', reason: 'plan-paused', owed: owedFor('plan-paused', c, { pauseReason: obs.health.pauseReason }) };

  const claimsUsed = ctx.claimsOnHead?.[obs.head] ?? 0;
  const last = ended[ended.length - 1];
  if (ended.length > 0) {
    if (bounds.sessionClaimsPerHead <= 0) return { action: 'blocked', reason: 'attempt-ended-no-retry', owed: owedFor('attempt-ended-no-retry', c, { state: last.state, disposition: last.disposition }) };
    if (claimsUsed >= bounds.sessionClaimsPerHead) {
      const reason = last.disposition === 'integrity-violation' ? 'integrity-violation' : 'attempt-failed';
      return { action: 'blocked', reason, owed: owedFor(reason, c, { attempt: last.attempt, state: last.state, disposition: last.disposition }) };
    }
    return claim(`attempt ${last.attempt} ended ${last.state}/${last.disposition ?? '?'} — one session claim allowed`);
  }
  // The beat cannot run a delta pass yet, so round two is always a session claim.
  if (bounds.claim === 'beat' && !since) return { action: 'wait', detail: 'waiting for the beat to claim this head' };
  if (claimsUsed >= bounds.sessionClaimsPerHead) return { action: 'wait', detail: 'session claim already made on this head; waiting for its attempt to appear' };
  if (since) return claim(`round two: delta since ${since.slice(0, 7)} — session claim${bounds.claim === 'beat' ? ' (--claim beat does not apply: the beat cannot run a delta pass yet)' : ''}`);
  return claim('no attempt on this head — session claim');
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function defaultStatePath(repo, pr) {
  return join(tmpdir(), 'pr-babysit', `${repo.replace('/', '__')}-${pr}.json`);
}

export function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Spawn a writer verb. Coordinated verbs emit one JSON line (the last
 * non-empty stdout line); `reply` prints a human receipt line and exits 0 —
 * so a zero exit with no JSON is `ok` and a non-zero exit is `failed`, whatever
 * the last line says. The exit code is what a caller that resolves a thread
 * afterwards must read (T1 on workit#93: both lenses, P1).
 */
export function spawnWriterDefault(args, { cwd }) {
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [WRITER_SCRIPT, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    stdout = String(err?.stdout ?? '');
    exitCode = typeof err?.status === 'number' ? err.status : 1;
  }
  const line = stdout.split(/\r?\n/).filter((l) => l.trim() !== '').pop() ?? '';
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object' && 'outcome' in parsed) return { ...parsed, exitCode };
  if (exitCode === 0) return { outcome: 'ok', exitCode, raw: line.slice(0, 300) };
  return { outcome: 'failed', reason: `writer-exit-${exitCode}`, exitCode, raw: line.slice(0, 300) };
}

/**
 * Claim the current head and run both lenses and the post through the writer.
 * `since` makes both lens calls a delta pass under the same attempt-ref;
 * `contextFile` (the `pr-review.mjs uncertainty` output) goes to both lenses
 * in either round. Returns { ok, refused?, reason?, review_id? }. Never
 * retries; a lens that answers `retry: lens-budget` is left to the next
 * observation (the attempt row says what happened).
 */
export async function runAttempt({ repo, pr, cwd, since, contextFile }, deps) {
  const claim = deps.spawnWriter(['claim', '--pr', String(pr), '--repo', repo, '--cwd', cwd], { cwd });
  if (claim.outcome !== 'ok') return { ok: false, phase: 'claim', reason: claim.reason ?? claim.outcome, coordinator_code: claim.coordinator_code };
  const ref = claim.attempt_ref_file;
  const lensExtra = [...(since ? ['--since', since] : []), ...(contextFile ? ['--context-file', contextFile] : [])];
  for (const lens of REQUIRED_LENSES) {
    const r = deps.spawnWriter(['lens', '--attempt-ref', ref, '--lens', lens, '--cwd', cwd, ...lensExtra], { cwd });
    if (r.outcome !== 'ok') return { ok: false, phase: `lens:${lens}`, reason: r.reason ?? r.outcome, retry: r.retry, since: r.since, attempt_ref_file: ref };
  }
  const post = deps.spawnWriter(['post', '--attempt-ref', ref, '--cwd', cwd], { cwd });
  if (post.outcome !== 'posted') return { ok: false, phase: 'post', reason: post.reason ?? post.outcome };
  return { ok: true, review_id: post.review_id, head: post.head_now };
}

export async function runLoop(opts, deps) {
  const bounds = { ...DEFAULT_BOUNDS, ...(opts.bounds ?? {}) };
  const statePath = opts.statePath ?? defaultStatePath(opts.repo, opts.pr);
  const stored = loadState(statePath);
  const prior = opts.resume === false ? null : stored;
  const ctx = {
    repo: opts.repo,
    pr: opts.pr,
    bounds,
    iterationHead: prior?.iterationHead ?? null,
    iterations: prior?.iterations ?? 0,
    startedAt: prior?.startedAt ?? deps.now(),
    claimsOnHead: prior?.claimsOnHead ?? {},
    deltaSkipped: prior?.deltaSkipped ?? null,
    // verdicts already given, not a bound: `--fresh` keeps them
    judgmentNotes: stored?.judgmentNotes ?? [],
    // the author's uncertainty follows the PR into round two unless replaced
    contextFile: opts.contextFile ?? prior?.contextFile ?? null,
  };
  const log = deps.log ?? (() => {});
  const persist = () => saveState(statePath, { iterationHead: ctx.iterationHead, iterations: ctx.iterations, startedAt: ctx.startedAt, claimsOnHead: ctx.claimsOnHead, deltaSkipped: ctx.deltaSkipped, judgmentNotes: ctx.judgmentNotes, contextFile: ctx.contextFile });

  const managed = deps.managed ?? { mode: MANAGED_MODES.managed };
  if (managed.mode !== MANAGED_MODES.managed) {
    return finish({ outcome: 'blocked', reason: 'not-managed', owed: owedFor('not-managed', { repo: opts.repo, bounds }) }, ctx, deps, null);
  }

  let first = true;
  for (;;) {
    const obs = await observe({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd }, deps);
    if (ctx.iterationHead === null) { ctx.iterationHead = obs.head; ctx.iterations = 1; persist(); }
    if (first && opts.skipDelta) {
      // The session that pushed the amendment judged it trivial; the judgment
      // covers this head only, and a later head is owed its delta again. A head
      // that moved during this first read is not the head that was judged.
      const round = reviewRound(obs.reviews ?? [], obs.head).round;
      if (obs.headBefore !== obs.headAfter) log(`[babysit] --skip-delta dropped: the head moved ${obs.headBefore.slice(0, 7)} → ${obs.headAfter.slice(0, 7)} during the first read; run again on the head you judged`);
      else if (round === 'delta') { ctx.deltaSkipped = { head: obs.head, reason: opts.skipDelta }; persist(); }
      else log(`[babysit] --skip-delta ignored: head ${obs.head.slice(0, 7)} is in round '${round}', not the delta round`);
    }
    first = false;
    const d = decide(obs, ctx);
    log(`[babysit] head ${obs.head.slice(0, 7)} it ${ctx.iterations}/${bounds.maxHeads} · ${d.action}${d.reason ? ` (${d.reason})` : ''}${d.detail ? ` — ${d.detail}` : ''}`);

    switch (d.action) {
      case 'converged':
        persist();
        return finish({
          outcome: 'converged',
          head: obs.head,
          review_id: d.reviewId,
          attempt: d.attempt,
          checks: obs.checks,
          ...(d.unreviewedTail ? { unreviewed_tail: d.unreviewedTail, unreviewed_commits: d.unreviewedCommits } : {}),
          ...(d.deltaSkipped ? { delta_skipped: d.deltaSkipped } : {}),
          judgment_notes: ctx.judgmentNotes,
        }, ctx, deps, obs);
      case 'blocked':
        persist();
        return finish({ outcome: 'blocked', reason: d.reason, owed: d.owed, head: obs.head }, ctx, deps, obs);
      case 'adjudicate':
        persist();
        return finish({ outcome: 'adjudicate', head: obs.head, review_id: d.reviewId, threads: d.threads, owed: `${d.threads.length} open thread(s): judge each (\`pr-babysit.mjs adjudicate --comment-id <id> --verdict …\`), push fixes, run again.` }, ctx, deps, obs);
      case 'new-head':
        ctx.iterationHead = obs.head;
        ctx.iterations += 1;
        persist();
        continue;
      case 'claim': {
        ctx.claimsOnHead[obs.head] = (ctx.claimsOnHead[obs.head] ?? 0) + 1;
        persist();
        const r = await runAttempt({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd, since: d.since, contextFile: ctx.contextFile }, deps);
        log(`[babysit] ${d.since ? `delta attempt (since ${d.since.slice(0, 7)})` : 'attempt'} on ${obs.head.slice(0, 7)}: ${r.ok ? `posted review ${r.review_id}` : `${r.phase} → ${r.reason}`}`);
        if (!r.ok && r.phase === 'claim' && (r.reason === 'paused' || r.reason === 'disabled')) {
          return finish({ outcome: 'blocked', reason: r.reason === 'paused' ? 'plan-paused' : 'disabled', owed: owedFor(r.reason === 'paused' ? 'plan-paused' : 'disabled', { ...ctx, head: obs.head }), head: obs.head }, ctx, deps, obs);
        }
        // The writer refused `--since` before any lens start (a rebase, a merge
        // from base, a sha on the base branch). A block, never a full review:
        // the attempt stays live for the conductor's call, per the writer.
        if (!r.ok && d.since && r.phase.startsWith('lens:') && r.reason === 'input-mismatch' && r.since) {
          return finish({ outcome: 'blocked', reason: 'amendment-not-descendant', owed: owedFor('amendment-not-descendant', { ...ctx, head: obs.head }, { from: d.since, problem: 'the writer refused --since', attemptRefFile: r.attempt_ref_file }), head: obs.head }, ctx, deps, obs);
        }
        continue; // the next observation reads the attempt row
      }
      case 'wait':
      default:
        await deps.sleep(bounds.pollSeconds * 1000);
        continue;
    }
  }
}

function finish(receipt, ctx, deps, obs) {
  const elapsedMinutes = Math.round(((obs?.at ?? deps.now()) - ctx.startedAt) / 6_000) / 10;
  const full = { ...receipt, repo: ctx.repo, pr: ctx.pr, iterations: ctx.iterations, elapsedMinutes, claimsOnHead: ctx.claimsOnHead };
  (deps.emit ?? ((o) => console.log(JSON.stringify(o))))(full);
  return full;
}

// ---------------------------------------------------------------------------
// Adjudicate: reply through the writer (T1 measurement row) and resolve the thread
// ---------------------------------------------------------------------------

export async function adjudicate({ repo, pr, cwd, commentId, verdict, bodyFile, adjudicator, statePath }, deps) {
  const reply = deps.spawnWriter(['reply', '--pr', String(pr), '--repo', repo, '--comment-id', String(commentId), '--body-file', bodyFile, '--verdict', verdict, ...(adjudicator ? ['--adjudicator', adjudicator] : []), '--cwd', cwd], { cwd });
  // No verdict on the thread → no resolution. A resolved thread with no
  // reply would read as adjudicated to the convergence check while carrying
  // no verdict at all (T1 on workit#93, both lenses P1).
  if (reply.outcome !== 'ok') return { outcome: 'failed', reason: 'reply-failed', commentId, verdict, replied: reply, resolved: false };
  const { nodes } = fetchAllThreads({ repo, pr, cwd }, deps.runGh);
  const thread = nodes.find((t) => (t.comments?.nodes ?? []).some((c) => Number(c.databaseId) === Number(commentId)));
  if (!thread) return { outcome: 'failed', reason: 'thread-not-found', commentId };
  const res = deps.runGh(['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-F', `id=${thread.id}`], { cwd });
  const resolved = JSON.parse(res)?.data?.resolveReviewThread?.thread?.isResolved === true;
  // A judgment thread is resolved like any other; the verdict is the record,
  // and the converged receipt lists it for the operator's merge call.
  if (resolved && verdict === 'judgment') {
    const path = statePath ?? defaultStatePath(repo, pr);
    const state = loadState(path) ?? {};
    const notes = new Set((state.judgmentNotes ?? []).map(String));
    notes.add(String(commentId));
    saveState(path, { ...state, judgmentNotes: [...notes] });
  }
  return { outcome: resolved ? 'ok' : 'failed', commentId, threadId: thread.id, verdict, resolved, replied: reply };
}

/**
 * The `adjudicate` verb as the CLI runs it. The writer's `reply` runs with the
 * checkout as its working directory, so a relative --body-file is made
 * absolute against the caller's cwd here, and a missing one is refused
 * (exit 4) before anything is replied.
 */
export async function adjudicateVerb(opts, deps, { cwd = process.cwd() } = {}) {
  const bodyFile = resolve(cwd, opts.bodyFile);
  let isFile = false;
  try { isFile = statSync(bodyFile).isFile(); } catch { isFile = false; }
  if (!isFile) return { exitCode: 4, error: `--body-file not found: ${bodyFile} (from ${opts.bodyFile}, resolved against ${cwd}); nothing was replied` };
  const result = await adjudicate({ ...opts, bodyFile }, deps);
  return { exitCode: result.outcome === 'ok' ? 0 : 4, result };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { verb: argv[0], json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--pr': opts.pr = Number(next()); break;
      case '--repo': opts.repo = next(); break;
      case '--cwd': opts.cwd = next(); break;
      case '--claim': opts.claim = next(); break;
      case '--max-heads': opts.maxHeads = Number(next()); break;
      case '--max-wall-minutes': opts.maxWallMinutes = Number(next()); break;
      case '--poll-seconds': opts.pollSeconds = Number(next()); break;
      case '--session-claims': opts.sessionClaimsPerHead = Number(next()); break;
      case '--state': opts.statePath = next(); break;
      case '--fresh': opts.resume = false; break;
      case '--comment-id': opts.commentId = next(); break;
      case '--verdict': opts.verdict = next(); break;
      case '--body-file': opts.bodyFile = next(); break;
      case '--adjudicator': opts.adjudicator = next(); break;
      case '--context-file': opts.contextFile = next(); break;
      case '--skip-delta': opts.skipDelta = next(); break;
      case '--json': opts.json = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return opts;
}

function buildDeps(opts) {
  const managed = resolveManaged({ repo: opts.repo });
  let coordinator = null;
  if (managed.mode === MANAGED_MODES.managed) {
    const client = createClient({ coordinator: managed.coordinator, token: loadCoordinatorToken() });
    coordinator = {
      // the client answers an envelope; `observe` unwraps it (unwrapClientResponse)
      readStatus: (input) => client.readStatus(input),
      readIdentity: () => client.readIdentity(),
      readHealth: async () => {
        const res = await fetch(`${managed.coordinator.replace(/\/+$/, '')}/api/health`, { headers: { connection: 'close' } });
        if (!res.ok) throw new Error(`/api/health ${res.status}`);
        const j = await res.json();
        return j.prReview ?? null;
      },
    };
  }
  return {
    managed,
    coordinator,
    runGh: (args, o = {}) => {
      try { return gh(args, { cwd: o.cwd, input: o.input }); } catch (err) {
        if (o.allowFailure) return String(err?.stdout ?? '');
        throw err;
      }
    },
    spawnWriter: spawnWriterDefault,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.error(line),
    emit: (o) => console.log(JSON.stringify(o)),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.verb || !['run', 'status', 'threads', 'adjudicate'].includes(opts.verb)) {
    console.error('usage: pr-babysit.mjs run|status|threads|adjudicate --pr <n> --repo <owner/name> --cwd <checkout> [...]');
    process.exit(4);
  }
  if (!opts.pr || !opts.repo || !opts.cwd) { console.error('--pr, --repo and --cwd are required'); process.exit(4); }
  if (opts.skipDelta !== undefined && String(opts.skipDelta).trim() === '') { console.error('--skip-delta needs a reason: it is written to the state file and the receipt'); process.exit(4); }
  // A resumed run reuses the context file the state file carries (runLoop does
  // the same fallback), so that path is checked here too.
  const storedContext = opts.verb === 'run' && opts.contextFile === undefined && opts.resume !== false
    ? loadState(opts.statePath ?? defaultStatePath(opts.repo, opts.pr))?.contextFile ?? undefined
    : undefined;
  if (opts.contextFile !== undefined || storedContext !== undefined) {
    // The writer refuses an unreadable or empty file only after the claim, and
    // that refusal leaves a live attempt the loop would wait on. Check it here.
    // Absolute, because the writer runs with --cwd as its working directory.
    const label = storedContext !== undefined ? '--context-file (from the state file)' : '--context-file';
    opts.contextFile = resolve(opts.contextFile ?? storedContext);
    let text = '';
    try { text = readFileSync(opts.contextFile, 'utf8'); } catch (err) { console.error(`${label} could not be read: ${err.message}`); process.exit(4); }
    if (text.trim() === '') { console.error(`${label} is empty: ${opts.contextFile}`); process.exit(4); }
  }
  const deps = buildDeps(opts);
  const bounds = {
    ...(opts.claim ? { claim: opts.claim } : {}),
    ...(Number.isFinite(opts.maxHeads) ? { maxHeads: opts.maxHeads } : {}),
    ...(Number.isFinite(opts.maxWallMinutes) ? { maxWallMinutes: opts.maxWallMinutes } : {}),
    ...(Number.isFinite(opts.pollSeconds) ? { pollSeconds: opts.pollSeconds } : {}),
    ...(Number.isFinite(opts.sessionClaimsPerHead) ? { sessionClaimsPerHead: opts.sessionClaimsPerHead } : {}),
  };

  if (opts.verb === 'threads') {
    const obs = await observe(opts, deps);
    if (opts.json) { console.log(JSON.stringify(obs.threads, null, 2)); return; }
    for (const t of obs.threads) console.log(`#${t.commentId}  ${t.path}:${t.line ?? '?'}  [${t.resolved ? 'resolved' : 'OPEN'}${t.outdated ? ', outdated' : ''}]  lens:${t.lens ?? '-'}  replies:${t.replies}\n   ${t.author}: ${t.first}`);
    return;
  }
  if (opts.verb === 'adjudicate') {
    if (!opts.commentId || !opts.verdict || !opts.bodyFile) { console.error('adjudicate needs --comment-id, --verdict and --body-file'); process.exit(4); }
    const v = await adjudicateVerb(opts, deps);
    if (v.error) { console.error(v.error); process.exit(v.exitCode); }
    console.log(JSON.stringify(v.result));
    process.exit(v.exitCode);
  }
  if (opts.verb === 'status') {
    if (deps.managed.mode !== MANAGED_MODES.managed) { console.log(JSON.stringify({ outcome: 'blocked', reason: 'not-managed' })); process.exit(2); }
    const obs = await observe(opts, deps);
    const state = loadState(opts.statePath ?? defaultStatePath(opts.repo, opts.pr));
    const ctx = { repo: opts.repo, pr: opts.pr, bounds: { ...DEFAULT_BOUNDS, ...bounds }, iterationHead: state?.iterationHead ?? obs.head, iterations: state?.iterations ?? 1, startedAt: state?.startedAt ?? obs.at, claimsOnHead: state?.claimsOnHead ?? {}, deltaSkipped: state?.deltaSkipped ?? null };
    console.log(JSON.stringify({ head: obs.head, checks: obs.checks, threads: obs.threads.length, unresolved: obs.threads.filter((t) => !t.resolved).length, attemptsOnHead: (obs.status?.attempts ?? []).filter((a) => a.head_sha === obs.head), reviews: obs.reviews, round: reviewRound(obs.reviews ?? [], obs.head).round, tail: obs.tail, health: obs.health, decision: decide(obs, ctx) }, null, 2));
    return;
  }
  const receipt = await runLoop({ ...opts, bounds }, deps);
  process.exit(receipt.outcome === 'converged' ? 0 : receipt.outcome === 'adjudicate' ? 3 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.stack ?? String(err)); process.exit(4); });
}
