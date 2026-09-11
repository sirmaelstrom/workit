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
 * Everything else is `wait`, `claim` (at most one session claim per head —
 * D4), `adjudicate` (your turn: judge the open threads, push fixes, run
 * again), `new-head` (an iteration), or `blocked` with a reason from a closed
 * set and an `owed` sentence. Every wait has a bound. There is no merge path.
 *
 * Verbs:
 *   run        --pr <n> --repo <owner/name> --cwd <checkout> [--claim session|beat]
 *              [--max-heads 3] [--max-wall-minutes 90] [--poll-seconds 60]
 *              [--session-claims 1] [--state <file>]
 *   status     --pr --repo --cwd            one observation + decision, no waiting
 *   threads    --pr --repo --cwd [--json]   every review thread (resolved or not)
 *   adjudicate --pr --repo --cwd --comment-id <id> --verdict confirmed|refuted|note --body-file <f>
 *              reply through the writer (T1 measurement row) and RESOLVE the thread
 *
 * Exit: 0 converged · 2 blocked · 3 adjudicate (your turn) · 4 usage / gh failure.
 * Every terminal exit prints one JSON receipt line on stdout.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createClient } from '../../slim-review/scripts/pr-review-coordinator.mjs';
import { loadCoordinatorToken, resolveManaged, MANAGED_MODES } from '../../slim-review/scripts/pr-review-managed.mjs';

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
]);

const LIVE_STATES = new Set(['claimed', 'lens_running', 'lens_done', 'posting', 'delivery-unresolved']);
const ENDED_STATES = new Set(['failed', 'withdrawn', 'superseded', 'post_rejected', 'replaced']);

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

const THREADS_QUERY = `
query($owner:String!, $name:String!, $pr:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:50) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

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

  const checksRaw = deps.runGh(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state,bucket'], { cwd, allowFailure: true });
  let checksRows = [];
  try { checksRows = JSON.parse(checksRaw || '[]'); } catch { checksRows = []; }
  const checks = summariseChecks(Array.isArray(checksRows) ? checksRows : []);

  const threadsRaw = deps.runGh(
    ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`],
    { cwd },
  );
  const threads = normaliseThreads(JSON.parse(threadsRaw).data.repository.pullRequest.reviewThreads.nodes ?? []);

  let status = null;
  let health = null;
  let coordinatorError = null;
  try {
    status = await deps.coordinator.readStatus({ repo, pr });
    health = await deps.coordinator.readHealth();
  } catch (err) {
    coordinatorError = err instanceof Error ? err.message : String(err);
  }

  const headAfter = readHead();
  return { repo, pr, headBefore, headAfter, head: headAfter, checks, threads, status, health, coordinatorError, at: deps.now() };
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
    case 'not-managed': return `${ctx.repo} is not a managed repository — use slim-review's standalone loop.`;
    default: return 'a person decides.';
  }
}

/**
 * The decision, given one observation and the loop's context. Pure.
 *
 * ctx: { repo, iterationHead, iterations, startedAt, claimsOnHead: {head: n}, bounds }
 * → { action: 'converged'|'wait'|'claim'|'adjudicate'|'new-head'|'blocked', reason?, owed?, detail? }
 */
export function decide(obs, ctx) {
  const bounds = ctx.bounds;
  const elapsedMin = (obs.at - ctx.startedAt) / 60_000;
  const c = { ...ctx, head: obs.head };

  if (obs.coordinatorError) return { action: 'blocked', reason: 'coordinator-unreachable', owed: owedFor('coordinator-unreachable', c, { error: obs.coordinatorError }) };
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

  // No posted, no live attempt on this head.
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
    return { action: 'claim', detail: `attempt ${last.attempt} ended ${last.state}/${last.disposition ?? '?'} — one session claim allowed` };
  }
  if (bounds.claim === 'beat') return { action: 'wait', detail: 'waiting for the beat to claim this head' };
  if (claimsUsed >= bounds.sessionClaimsPerHead) return { action: 'wait', detail: 'session claim already made on this head; waiting for its attempt to appear' };
  return { action: 'claim', detail: 'no attempt on this head — session claim' };
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

/** Spawn a writer verb and parse its one JSON line (the last non-empty stdout line). */
export function spawnWriterDefault(args, { cwd }) {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [WRITER_SCRIPT, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    stdout = String(err?.stdout ?? '');
  }
  const line = stdout.split(/\r?\n/).filter((l) => l.trim() !== '').pop() ?? '';
  try { return JSON.parse(line); } catch { return { outcome: 'failed', reason: 'unparseable-writer-output', raw: line.slice(0, 300) }; }
}

/**
 * Claim the current head and run both lenses and the post through the writer.
 * Returns { ok, refused?, reason?, review_id? }. Never retries; a lens that
 * answers `retry: lens-budget` is left to the next observation (the attempt
 * row says what happened).
 */
export async function runAttempt({ repo, pr, cwd }, deps) {
  const claim = deps.spawnWriter(['claim', '--pr', String(pr), '--repo', repo, '--cwd', cwd], { cwd });
  if (claim.outcome !== 'ok') return { ok: false, phase: 'claim', reason: claim.reason ?? claim.outcome, coordinator_code: claim.coordinator_code };
  const ref = claim.attempt_ref_file;
  for (const lens of REQUIRED_LENSES) {
    const r = deps.spawnWriter(['lens', '--attempt-ref', ref, '--lens', lens, '--cwd', cwd], { cwd });
    if (r.outcome !== 'ok') return { ok: false, phase: `lens:${lens}`, reason: r.reason ?? r.outcome, retry: r.retry };
  }
  const post = deps.spawnWriter(['post', '--attempt-ref', ref, '--cwd', cwd], { cwd });
  if (post.outcome !== 'posted') return { ok: false, phase: 'post', reason: post.reason ?? post.outcome };
  return { ok: true, review_id: post.review_id, head: post.head_now };
}

export async function runLoop(opts, deps) {
  const bounds = { ...DEFAULT_BOUNDS, ...(opts.bounds ?? {}) };
  const statePath = opts.statePath ?? defaultStatePath(opts.repo, opts.pr);
  const prior = opts.resume === false ? null : loadState(statePath);
  const ctx = {
    repo: opts.repo,
    pr: opts.pr,
    bounds,
    iterationHead: prior?.iterationHead ?? null,
    iterations: prior?.iterations ?? 0,
    startedAt: prior?.startedAt ?? deps.now(),
    claimsOnHead: prior?.claimsOnHead ?? {},
  };
  const log = deps.log ?? (() => {});
  const persist = () => saveState(statePath, { iterationHead: ctx.iterationHead, iterations: ctx.iterations, startedAt: ctx.startedAt, claimsOnHead: ctx.claimsOnHead });

  const managed = deps.managed ?? { mode: MANAGED_MODES.managed };
  if (managed.mode !== MANAGED_MODES.managed) {
    return finish({ outcome: 'blocked', reason: 'not-managed', owed: owedFor('not-managed', { repo: opts.repo, bounds }) }, ctx, deps, null);
  }

  for (;;) {
    const obs = await observe({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd }, deps);
    if (ctx.iterationHead === null) { ctx.iterationHead = obs.head; ctx.iterations = 1; persist(); }
    const d = decide(obs, ctx);
    log(`[babysit] head ${obs.head.slice(0, 7)} it ${ctx.iterations}/${bounds.maxHeads} · ${d.action}${d.reason ? ` (${d.reason})` : ''}${d.detail ? ` — ${d.detail}` : ''}`);

    switch (d.action) {
      case 'converged':
        persist();
        return finish({ outcome: 'converged', head: obs.head, review_id: d.reviewId, attempt: d.attempt, checks: obs.checks }, ctx, deps, obs);
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
        const r = await runAttempt({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd }, deps);
        log(`[babysit] attempt on ${obs.head.slice(0, 7)}: ${r.ok ? `posted review ${r.review_id}` : `${r.phase} → ${r.reason}`}`);
        if (!r.ok && r.phase === 'claim' && (r.reason === 'paused' || r.reason === 'disabled')) {
          return finish({ outcome: 'blocked', reason: r.reason === 'paused' ? 'plan-paused' : 'disabled', owed: owedFor(r.reason === 'paused' ? 'plan-paused' : 'disabled', { ...ctx, head: obs.head }), head: obs.head }, ctx, deps, obs);
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

export async function adjudicate({ repo, pr, cwd, commentId, verdict, bodyFile }, deps) {
  const reply = deps.spawnWriter(['reply', '--pr', String(pr), '--repo', repo, '--comment-id', String(commentId), '--body-file', bodyFile, '--verdict', verdict, '--cwd', cwd], { cwd });
  const [owner, name] = repo.split('/');
  const threadsRaw = deps.runGh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`], { cwd });
  const nodes = JSON.parse(threadsRaw).data.repository.pullRequest.reviewThreads.nodes ?? [];
  const thread = nodes.find((t) => (t.comments?.nodes ?? []).some((c) => Number(c.databaseId) === Number(commentId)));
  if (!thread) return { outcome: 'failed', reason: 'thread-not-found', commentId };
  const res = deps.runGh(['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-F', `id=${thread.id}`], { cwd });
  const resolved = JSON.parse(res)?.data?.resolveReviewThread?.thread?.isResolved === true;
  return { outcome: resolved ? 'ok' : 'failed', commentId, threadId: thread.id, verdict, resolved, replied: reply };
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
      readStatus: (input) => client.readStatus(input),
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
    const r = await adjudicate(opts, deps);
    console.log(JSON.stringify(r));
    process.exit(r.outcome === 'ok' ? 0 : 4);
  }
  if (opts.verb === 'status') {
    if (deps.managed.mode !== MANAGED_MODES.managed) { console.log(JSON.stringify({ outcome: 'blocked', reason: 'not-managed' })); process.exit(2); }
    const obs = await observe(opts, deps);
    const state = loadState(opts.statePath ?? defaultStatePath(opts.repo, opts.pr));
    const ctx = { repo: opts.repo, pr: opts.pr, bounds: { ...DEFAULT_BOUNDS, ...bounds }, iterationHead: state?.iterationHead ?? obs.head, iterations: state?.iterations ?? 1, startedAt: state?.startedAt ?? obs.at, claimsOnHead: state?.claimsOnHead ?? {} };
    console.log(JSON.stringify({ head: obs.head, checks: obs.checks, threads: obs.threads.length, unresolved: obs.threads.filter((t) => !t.resolved).length, attemptsOnHead: (obs.status?.attempts ?? []).filter((a) => a.head_sha === obs.head), health: obs.health, decision: decide(obs, ctx) }, null, 2));
    return;
  }
  const receipt = await runLoop({ ...opts, bounds }, deps);
  process.exit(receipt.outcome === 'converged' ? 0 : receipt.outcome === 'adjudicate' ? 3 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.stack ?? String(err)); process.exit(4); });
}
