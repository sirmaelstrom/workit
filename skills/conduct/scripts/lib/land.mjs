// Landing a WP: the review lenses at its tier, the adjudication replies and
// thread resolution, the rebase under the merge lock, the merge gate at the
// exact head, and the merge. Burn-down's gate (skills/burn-down/SKILL.md § Per
// item step 4) and slim-review's script are driven here, never restated.
//
// Every function returns actions or a recorder outcome; nothing here runs a
// program except gateCheck, recordRebase and runLandVerb, through deps.exec.
// A recorder `patch` holds WP fields, except `mergeLock` and `dispatchHalt`,
// which are run-level. Optional fields this module adds: action `land` (the
// review metadata its recorder reads back), action `files` (reply bodies),
// `wps[].reviewMode`, `wps[].rebaseFrom`, `wps[].threadIds`.
import { join, sep } from 'node:path';
import { ConductError, STEP_SEAM, loadState } from './state.mjs';

const WAIT_MS = 60000;
const PENDING_BLOCK_MS = 30 * 60000;
const NO_CI_MS = 10 * 60000;
const GREEN = new Set(['success', 'neutral', 'skipped']);
// The reason `claim` prints when the head already carries this identity's review.
export const ALREADY_REVIEWED = 'already-posted';
const VERDICTS = ['fixed', 'refuted', 'judgment', 'conductor'];
const REPLY_VERDICT = { fixed: 'confirmed', refuted: 'refuted', judgment: 'judgment' };
// No quote character in either, so the argv runs without a shell.
export const THREADS_QUERY = 'query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } } } } }';
export const RESOLVE_MUTATION = 'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }';
const LOCKED_STEPS = new Set(['rebase', 'gate', 'merge', 'merged']);

const lower = (wp) => String(wp.id).toLowerCase();
const repoOf = (state) => state.intent.repo.remote;
const defaultOf = (state) => state.intent.repo.defaultBranch ?? 'main';
const prReview = (state) => join(state.pluginRoot, 'skills', 'slim-review', 'scripts', 'pr-review.mjs');
const reviewsDir = (state, wp) => join(state.runDir, 'reviews', lower(wp));
const lines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const first = (text) => lines(text)[0] ?? '';
const result = (outcome, reason = null, patch = {}) => ({ outcome, reason, patch });

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shell(step, part, command, extra = {}) {
  return { kind: 'shell', step, seam: STEP_SEAM[step], part, instruction: `Run ${command.slice(0, 3).join(' ')} … and record its { code, stdout, stderr }.`, command, expects: { type: 'none' }, ...extra };
}

function waitAction(step, part, instruction) {
  return { kind: 'wait', step, seam: STEP_SEAM[step], part, instruction, waitMs: WAIT_MS };
}

export function isTestPath(path) {
  const p = String(path).replaceAll('\\', '/');
  return /\.test\./.test(p.split('/').pop()) || /(^|\/)tests?\//.test(p);
}

// Trivial means docs: tests and fixtures are executable evidence even as .md.
function isDocPath(path) {
  const p = String(path).replaceAll('\\', '/');
  return p.endsWith('.md') && !isTestPath(p) && !/(^|\/)(__fixtures__|fixtures)\//.test(p);
}

// Raise only: a test file or a contract path makes it T2; an unknown declared
// tier is treated as T2.
export function tierFor(wp, changedPaths = [], contractPaths = []) {
  const declared = ['T0', 'T1', 'T2'].includes(wp.tier) ? wp.tier : 'T2';
  const norm = (path) => String(path).replaceAll('\\', '/');
  const contracts = new Set(contractPaths.map(norm));
  return changedPaths.some((path) => isTestPath(path) || contracts.has(norm(path))) ? 'T2' : declared;
}

// Lens availability: opus iff claude is on; codex and astra iff codex is on.
export function pickReviewers(state, authorKind, { mode = 'standalone' } = {}) {
  const claude = state.agents?.claude?.on === true;
  const codex = state.agents?.codex?.on === true;
  if (mode === 'managed') {
    if (!codex) return { impossible: 'managed repo needs the codex CLI' };
    if (authorKind === 'codex') return { lenses: ['astra'], singleLens: 'codex-authored PR on a managed repo: astra is the only lens outside the author family' };
    return { lenses: ['codex', 'astra'] };
  }
  if (authorKind === 'codex' && claude && codex) return { lenses: ['astra', 'opus'] };
  if (codex) return { lenses: ['codex', 'astra'], ...(authorKind === 'codex' ? { sameFamily: true } : {}) };
  if (claude) return { lenses: ['opus'], singleLens: 'no codex CLI: opus is the only available lens', ...(authorKind === 'claude' ? { sameFamily: true } : {}) };
  return { impossible: 'no review CLI is available' };
}

function availableLenses(state) {
  return [...(state.agents?.codex?.on ? ['codex', 'astra'] : []), ...(state.agents?.claude?.on ? ['opus'] : [])];
}

// The review flow. Until the repo's mode is known the array is the read-only
// `managed` probe alone; its record expands the rest (reviewSteps).
export function reviewActions(state, wp, { round = 1, report = null, since = null, all = false } = {}) {
  const meta = { round, scope: since ? 'delta' : 'full', since, report, all };
  if (!wp.reviewMode) {
    return [shell('review', 'managed', ['node', prReview(state), 'managed', '--repo', repoOf(state)], { expects: { type: 'json' }, land: meta })];
  }
  return reviewSteps(state, wp, wp.reviewMode, meta);
}

function reviewSteps(state, wp, mode, meta) {
  const pick = pickReviewers(state, state.intent.agent, { mode });
  if (pick.impossible) return [];
  const lenses = meta.all && mode === 'standalone' ? availableLenses(state) : pick.lenses;
  const single = lenses.length === 1 ? (pick.singleLens ?? `${lenses[0]} is the only available lens`) : null;
  const dir = reviewsDir(state, wp);
  const script = prReview(state);
  const pr = String(wp.pr.number);
  const repo = repoOf(state);
  const ctx = meta.report ? join(dir, 'uncertainty.md') : null;
  const land = { ...meta, lenses, head: wp.pr.head };
  const actions = [];
  if (ctx) actions.push(shell('review', 'uncertainty', ['node', script, 'uncertainty', '--report', meta.report, '--out', ctx], { land }));
  const extra = [...(meta.since ? ['--since', meta.since] : []), ...(ctx ? ['--context-file', ctx] : [])];
  if (mode === 'managed') {
    const ref = join(dir, `attempt-ref-r${meta.round}.json`);
    land.attemptRef = ref;
    actions.push(shell('review', 'claim', ['node', script, 'claim', '--pr', pr, '--repo', repo, '--attempt-ref-out', ref,
      ...(single ? ['--single-lens', single, '--lens', lenses[0]] : [])], { land }));
    for (const lens of lenses) actions.push(shell('review', 'lens', ['node', script, 'lens', '--attempt-ref', ref, '--lens', lens, ...extra], { cwd: wp.lane.worktree, land }));
    actions.push(shell('post', 'post', ['node', script, 'post', '--attempt-ref', ref], { land }));
    return actions;
  }
  const files = lenses.map((lens) => join(dir, `${lens}-r${meta.round}.json`));
  lenses.forEach((lens, i) => actions.push(shell('review', 'lens', ['node', script, 'lens', '--pr', pr, '--repo', repo, '--lens', lens,
    '--cwd', wp.lane.worktree, '--out', files[i], '--measure-log', join(state.runDir, 't1.jsonl'), ...extra], { land })));
  actions.push(shell('post', 'post', ['node', script, 'post', '--pr', pr, '--repo', repo, ...files.flatMap((file) => ['--findings', file]),
    ...(single ? ['--single-lens', single] : [])], { land }));
  return actions;
}

const latestRound = (wp) => Math.max(0, ...(wp.reviews ?? []).map((review) => review.round ?? 0));

// One delta pass per lens, before any rebase, so --since names an ancestor.
export function deltaReviewActions(state, wp, sinceHead, { report = null } = {}) {
  if ((wp.rebases ?? []).some((rebase) => rebase.from === sinceHead)) {
    throw new ConductError(2, `${wp.id}: no delta review after a rebase (${sinceHead.slice(0, 7)} is not an ancestor of the rebased head); a full review is owed`);
  }
  return reviewActions(state, wp, { round: latestRound(wp) + 1, report, since: sinceHead });
}

export function t2Actions(state, wp, { round = 1, changedPaths = [], report = null } = {}) {
  if (!state.adapters?.council?.on) return reviewActions(state, wp, { round, report, all: true });
  const workshop = `${join(state.runDir, 'council', lower(wp))}${sep}`;
  const outDir = `${join(state.runDir, 'council', lower(wp), `review-${round}`)}${sep}`;
  const tool = (part, name, args, extra = {}) => ({ kind: 'agent-tool', step: 'council', seam: STEP_SEAM.council, part, tool: name,
    instruction: `Call ${name} with these args and record its result.`, args, expects: { type: 'json' }, ...extra });
  return [
    tool('review', 'council_review', { workshop_path: workshop, output_dir: outDir, surface: 'code', code_root: wp.lane.worktree, artifact_paths: changedPaths, round, profile: 'code' }),
    tool('synthesize', 'council_synthesize', { review_dir: outDir, workshop_path: workshop }, {
      head: wp.pr.head, land: { round }, expects: { type: 'json', fields: ['findings', 'seats'] },
      instruction: 'Call council_synthesize, then record { findings: <Critical + Major count>, seats: [<usable seats>] } read from the synthesis.',
    }),
    tool('challenge', 'council_challenge', { review_dir: outDir, workshop_path: workshop, code_root: wp.lane.worktree }),
  ];
}

function splitRow(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
  return cells.map((cell) => cell.replace(/^`(.*)`$/, '$1'));
}

// The rows of the report's latest `## Amendment N` table.
export function parseAmendmentTable(reportText) {
  const sections = String(reportText).split(/^(?=## )/m).filter((section) => /^## Amendment \d+\b/.test(section));
  const section = sections.at(-1);
  if (!section) return [];
  const rows = section.split(/\r?\n/).filter((line) => line.trim().startsWith('|'));
  const header = rows.findIndex((line) => /^\|\s*Comment\s*\|\s*Verdict\s*\|\s*Evidence\s*\|\s*Commit\s*\|/i.test(line.trim()));
  if (header < 0) return [];
  const body = [];
  for (const line of rows.slice(header + 1)) {
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
    const [comment, verdict, evidence, commit] = splitRow(line);
    body.push({ comment, verdict: String(verdict ?? '').toLowerCase(), evidence: evidence ?? '', commit: /^[0-9a-f]{7,40}$/i.test(commit ?? '') ? commit : null });
  }
  return body;
}

export function recordAdjudication(state, wp, verdicts) {
  const reviews = wp.reviews ?? [];
  if (!reviews.length) throw new ConductError(2, `${wp.id} has no review to adjudicate`);
  for (const row of verdicts) {
    if (!VERDICTS.includes(row.verdict)) throw new ConductError(2, `comment ${row.comment}: verdict must be one of ${VERDICTS.join(', ')} (got ${row.verdict})`);
    if (row.verdict === 'fixed' && !/^[0-9a-f]{7,40}$/i.test(row.commit ?? '')) throw new ConductError(2, `comment ${row.comment}: a fixed row needs its commit sha`);
  }
  const rows = verdicts.map((row) => ({ comment: String(row.comment), verdict: row.verdict, evidence: row.evidence ?? '', commit: row.commit ?? null }));
  const latest = { ...reviews.at(-1), verdicts: [...(reviews.at(-1).verdicts ?? []), ...rows] };
  // Council ids (C<round>-<n>) have no PR thread; conductor rows go to a ruling first.
  const replyRows = rows.filter((row) => /^\d+$/.test(row.comment) && row.verdict !== 'conductor');
  const replies = join(reviewsDir(state, wp), 'replies');
  const body = (row) => join(replies, `${row.comment}.md`);
  const actions = replyRows.length === 0 ? [] : [
    { kind: 'author', step: 'reply', seam: STEP_SEAM.reply, part: 'bodies', instruction: 'Write one reply body per file: the verdict and its evidence, quoted from the lane\'s amendment row.',
      outPath: replies, files: replyRows.map((row) => ({ path: body(row), ...row })), expects: { type: 'file' } },
    ...replyRows.map((row) => shell('reply', 'reply', ['node', prReview(state), 'reply', '--pr', String(wp.pr.number), '--repo', repoOf(state),
      '--comment-id', row.comment, '--body-file', body(row), '--verdict', REPLY_VERDICT[row.verdict], '--adjudicator', row.adjudicator ?? 'lane'])),
  ];
  return { patch: { reviews: [...reviews.slice(0, -1), latest] }, actions, conductorRows: rows.filter((row) => row.verdict === 'conductor') };
}

// One lookup maps comment ids to thread node ids; its record queues the resolves.
export function resolveThreadActions(state, wp, commentIds) {
  const [owner, name] = repoOf(state).split('/');
  return [shell('thread-ids', 'lookup', ['gh', 'api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${wp.pr.number}`],
    { expects: { type: 'json' }, land: { commentIds: commentIds.map(String) } })];
}

function resolveAction(threadId) {
  return shell('resolve', 'resolve', ['gh', 'api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${threadId}`], { land: { threadId } });
}

export function mergeLockFor(state, wp) {
  const holder = state.mergeLock?.wpId;
  if (!holder) return 'free';
  return holder === wp.id ? 'mine' : 'other';
}

function lockFailure(state, wp) {
  const lock = mergeLockFor(state, wp);
  if (lock === 'free') return 'merge lock not held';
  return lock === 'other' ? `merge lock held by ${state.mergeLock.wpId}` : null;
}

export function rebaseActions(state, wp) {
  if (mergeLockFor(state, wp) === 'other') return [waitAction('rebase', 'yield', `Wait: ${state.mergeLock.wpId} holds the merge lock.`)];
  const git = (part, ...args) => shell('rebase', part, ['git', '-C', wp.lane.worktree, ...args]);
  const base = `origin/${defaultOf(state)}`;
  return [
    git('fetch', 'fetch', 'origin'),
    git('pre-head', 'rev-parse', 'HEAD'),
    git('rebase', 'rebase', base),
    git('post-heads', 'rev-parse', 'HEAD', base),
    git('push', 'push', '--force-with-lease', 'origin', wp.lane.branch),
    waitAction('rebase', 'ci-wait', 'Wait for CI at the pushed head; the land gate action answers it.'),
  ];
}

function patchId(wt, a, b, exec) {
  const diff = exec('git', ['-C', wt, 'diff', a, b]);
  if (diff.code !== 0) return null;
  const id = exec('git', ['-C', wt, 'patch-id', '--stable'], { input: diff.stdout });
  return id.code === 0 ? id.stdout.trim().split(/\s+/)[0] ?? '' : null;
}

// The WP's own diff before and after the rebase; equal stable patch-ids mean
// the review of `from` covers `to`. An unreadable id is never equivalent.
export function recordRebase(state, wp, { from, to, newBase }, deps) {
  const oldBase = (wp.rebases ?? []).at(-1)?.newBase ?? wp.lane.base;
  const ids = { from: patchId(wp.lane.worktree, oldBase, from, deps.exec), to: patchId(wp.lane.worktree, newBase, to, deps.exec) };
  return { from, to, oldBase, newBase, patchIds: ids, equivalent: ids.from !== null && ids.from === ids.to };
}

// `gh api --paginate` prints one JSON object per page with nothing between them.
export function parsePages(text) {
  const pages = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (depth++ === 0) start = i;
    } else if ((c === '}' || c === ']') && --depth === 0) pages.push(JSON.parse(text.slice(start, i + 1)));
  }
  if (depth !== 0) throw new Error('a page is truncated');
  return pages;
}

function ciCondition(state, wp, head, { exec, now }) {
  const read = exec('gh', ['api', `repos/${repoOf(state)}/commits/${head}/check-runs?per_page=100`, '--paginate']);
  if (read.code !== 0) {
    if (/HTTP (422|404)/.test(read.stderr)) return { failure: 'no CI at head' };
    return { failure: `CI unreadable: ${first(read.stderr)}` };
  }
  let runs;
  try {
    runs = parsePages(read.stdout).flatMap((page) => page.check_runs ?? []);
  } catch (error) {
    return { failure: `CI unreadable: ${error.message}` };
  }
  const since = wp.gate?.head === head && wp.gate?.pendingSince ? Date.parse(wp.gate.pendingSince) : null;
  const waited = since === null ? 0 : now() - since;
  if (runs.length === 0) return waited >= NO_CI_MS ? { failure: 'no CI at head' } : { pending: true };
  if (runs.some((run) => run.status !== 'completed')) return waited >= PENDING_BLOCK_MS ? { failure: 'CI did not complete at head', blocked: true } : { pending: true };
  const red = runs.filter((run) => !GREEN.has(run.conclusion));
  return red.length ? { failure: `CI failed at head: ${red.map((run) => `${run.name} (${run.conclusion})`).join(', ')}` } : {};
}

function fixedCommits(wp) {
  return (wp.reviews ?? []).flatMap((review) => review.verdicts ?? [])
    .filter((row) => row.verdict === 'fixed' && /^[0-9a-f]{7,40}$/i.test(row.commit ?? '')).map((row) => row.commit.toLowerCase());
}

function classifyTail(wp, reviewed, pre, exec) {
  const wt = wp.lane.worktree;
  const diff = exec('git', ['-C', wt, 'diff', '--name-only', reviewed, pre]);
  if (diff.code !== 0) return { failure: `tail ${reviewed}..${pre} unreadable: ${first(diff.stderr)}` };
  const paths = lines(diff.stdout);
  if (paths.every(isDocPath)) return { label: 'trivial' };
  if ((wp.reviews ?? []).some((review) => review.scope === 'delta' && review.head === reviewed)) {
    const listed = exec('git', ['-C', wt, 'rev-list', `${reviewed}..${pre}`]);
    const fixed = fixedCommits(wp);
    const shas = listed.code === 0 ? lines(listed.stdout) : [];
    if (shas.length && shas.every((sha) => fixed.some((commit) => sha.toLowerCase().startsWith(commit)))) return { label: 'post-cap' };
  }
  return { failure: `review does not cover head: tail ${reviewed}..${pre} changes ${paths.filter((path) => !isDocPath(path)).join(', ')}` };
}

// Condition (3): the latest review, mapped through equivalent rebases, covers
// head; or the tail qualifies (trivial, post-cap), or the WP is T0.
function reviewCondition(wp, head, exec) {
  if (wp.tier === 'T0') return { tail: `${wp.lane.base}..${head} (T0)` };
  const latest = (wp.reviews ?? []).at(-1);
  if (!latest) return { failure: 'no review of this WP' };
  if (latest.head === head) return {};
  const rebases = wp.rebases ?? [];
  let pre = head;
  for (let i = rebases.length - 1; i >= 0 && rebases[i].to === pre && pre !== latest.head; i -= 1) {
    if (!rebases[i].equivalent) return { failure: 'rebase changed the WP\'s diff: full review of the rebased head', needsFullReview: true };
    pre = rebases[i].from;
  }
  if (pre === latest.head) return {};
  const tail = classifyTail(wp, latest.head, pre, exec);
  return tail.failure ? tail : { tail: `${latest.head}..${pre} (${tail.label})` };
}

// The merge gate at the exact head. Every condition runs and every failure is
// listed; `pending` only when running CI is the sole reason ok is false.
export function gateCheck(state, wp, { exec, now }) {
  const wt = wp.lane.worktree;
  const failures = [];
  const rev = exec('git', ['-C', wt, 'rev-parse', 'HEAD']);
  const head = rev.code === 0 ? rev.stdout.trim() : null;
  if (!head) failures.push(`worktree head unreadable: ${first(rev.stderr)}`);
  const view = exec('gh', ['pr', 'view', String(wp.pr.number), '--repo', repoOf(state), '--json', 'headRefOid']);
  const prHead = view.code === 0 ? parseJson(view.stdout)?.headRefOid : null;
  if (!prHead) failures.push(`PR head unreadable: ${first(view.stderr)}`);
  else if (head && prHead !== head) failures.push('head mismatch');
  // (0) fresh base and the merge lock.
  let staleBase = false;
  const fetch = exec('git', ['-C', wt, 'fetch', 'origin']);
  if (fetch.code !== 0) failures.push(`fetch failed: ${first(fetch.stderr)}`);
  const fresh = exec('git', ['-C', wt, 'merge-base', '--is-ancestor', `origin/${defaultOf(state)}`, 'HEAD']);
  if (fresh.code === 1) {
    staleBase = true;
    failures.push('stale base');
  } else if (fresh.code !== 0) failures.push(`base freshness unreadable: ${first(fresh.stderr)}`);
  const lock = lockFailure(state, wp);
  if (lock) failures.push(lock);
  // (1) CI, (2) threads, (3) review covers head.
  const ci = head ? ciCondition(state, wp, head, { exec, now }) : { failure: 'CI not read: no head' };
  if (ci.failure) failures.push(ci.failure);
  const threads = exec('node', [prReview(state), 'threads', '--pr', String(wp.pr.number), '--repo', repoOf(state), '--unresolved']);
  if (threads.code === 8) failures.push('unresolved review threads');
  else if (threads.code !== 0) failures.push(`threads unreadable (exit ${threads.code}): ${first(threads.stderr)}`);
  const review = head ? reviewCondition(wp, head, exec) : { failure: 'review coverage not read: no head' };
  if (review.failure) failures.push(review.failure);
  const ok = failures.length === 0 && !ci.pending;
  return {
    ok, pending: !ok && failures.length === 0, blocked: ci.blocked === true, head, failures,
    unreviewedTail: review.tail ?? null, needsFullReview: review.needsFullReview === true, staleBase,
  };
}

export function mergeActions(state, wp, head) {
  if (state.authority?.merge !== true || mergeLockFor(state, wp) !== 'mine') return [];
  const pr = String(wp.pr.number);
  const repo = repoOf(state);
  return [
    shell('merge', 'ready', ['gh', 'pr', 'ready', pr, '--repo', repo]),
    shell('merge', 'squash', ['gh', 'pr', 'merge', pr, '--repo', repo, '--squash', '--match-head-commit', head]),
    shell('merge', 'merge-commit', ['gh', 'pr', 'view', pr, '--repo', repo, '--json', 'mergeCommit'], { expects: { type: 'json' } }),
    shell('merged', 'merged', ['node', join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs'), 'land', 'merged',
      '--run', state.runDir, '--wp', wp.id, '--merge-sha', '{merge.sha}']),
  ];
}

// The queue after this action: a leading copy of the recorded action is dropped.
function rest(wp, action) {
  const queue = wp.queue ?? [];
  const same = (a) => a.step === action.step && a.part === action.part && JSON.stringify(a.command ?? a.args) === JSON.stringify(action.command ?? action.args);
  return queue.length && same(queue[0]) ? queue.slice(1) : queue;
}

function reviewEntry(wp, land, extra) {
  return { round: land.round, scope: land.scope, tier: wp.tier, head: land.head, lenses: land.lenses, attemptRef: land.attemptRef ?? null,
    reviewId: null, findings: null, verdicts: [], resolved: [], ...extra };
}

export function findingsCount({ stdout, stderr }) {
  for (const text of [stdout, stderr]) {
    const match = /^findings\s+(\d+)/m.exec(String(text ?? ''));
    if (match) return Number(match[1]);
  }
  return null;
}

function withLatest(wp, change) {
  const reviews = wp.reviews ?? [];
  return [...reviews.slice(0, -1), change(reviews.at(-1))];
}

function recordReview(state, wp, action, r) {
  const after = rest(wp, action);
  if (action.part === 'managed') {
    const mode = parseJson(r.stdout)?.mode;
    if (mode !== 'managed' && mode !== 'standalone') return result('block', `review mode unreadable: ${first(r.stdout) || first(r.stderr)}`);
    const pick = pickReviewers(state, state.intent.agent, { mode });
    if (pick.impossible) return result('block', pick.impossible, { reviewMode: mode });
    return result('continue', null, { reviewMode: mode, queue: [...reviewSteps(state, wp, mode, action.land), ...after] });
  }
  if (action.part === 'uncertainty') {
    if (r.code === 0) return result('continue');
    if (r.code !== 3) return result('block', `uncertainty failed (exit ${r.code}): ${first(r.stderr)}`);
    const strip = (a) => {
      const at = a.part === 'lens' ? (a.command ?? []).indexOf('--context-file') : -1;
      return at < 0 ? a : { ...a, command: [...a.command.slice(0, at), ...a.command.slice(at + 2)] };
    };
    return result('continue', 'no uncertainty in the lane report: the lenses run without --context-file', { queue: after.map(strip) });
  }
  if (action.part === 'claim' && r.code !== 0) {
    const reason = parseJson(first(r.stdout))?.reason ?? first(r.stderr);
    if (reason !== ALREADY_REVIEWED) return result('block', `claim refused: ${reason}`);
    const ref = action.land?.attemptRef;
    return result('continue', `claim refused ${ALREADY_REVIEWED}: this head is already reviewed`, { queue: after.filter((a) => a.land?.attemptRef !== ref) });
  }
  return r.code === 0 ? result('continue') : result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
}

function recordThreadIds(state, wp, action, r) {
  const nodes = parseJson(r.stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return result('block', `review threads unreadable: ${first(r.stderr) || first(r.stdout)}`);
  const threadIds = {};
  for (const node of nodes) {
    const comment = String(node.comments?.nodes?.[0]?.databaseId ?? '');
    if (action.land.commentIds.includes(comment)) threadIds[comment] = node.id;
  }
  const missing = action.land.commentIds.filter((id) => !threadIds[id]);
  if (missing.length) return result('block', `no review thread found for comment ${missing.join(', ')}`, { threadIds });
  const resolves = action.land.commentIds.map((id) => resolveAction(threadIds[id]));
  return result('continue', null, { threadIds, queue: [...resolves, ...rest(wp, action)] });
}

function recordRebaseStep(state, wp, action, r, deps) {
  if (action.kind === 'wait') return result('continue');
  if (action.part === 'fetch') {
    const lock = mergeLockFor(state, wp);
    if (lock === 'other') return { ...result('wait', `merge lock held by ${state.mergeLock.wpId}`), waitMs: WAIT_MS };
    if (r.code !== 0) return result('block', `fetch failed: ${first(r.stderr)}`);
    return result('continue', null, lock === 'free' ? { mergeLock: { wpId: wp.id, since: new Date(deps.now()).toISOString() } } : {});
  }
  if (action.part === 'rebase' && r.code !== 0) {
    const abort = shell('rebase', 'abort', ['git', '-C', wp.lane.worktree, 'rebase', '--abort']);
    return result('amend', `rebase onto origin/${defaultOf(state)} conflicted (run the queued rebase --abort first): ${first(r.stdout) || first(r.stderr)}`, { queue: [abort] });
  }
  if (r.code !== 0) return result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
  if (action.part === 'pre-head') return result('continue', null, { rebaseFrom: r.stdout.trim() });
  if (action.part === 'post-heads') {
    const [to, newBase] = lines(r.stdout);
    const entry = recordRebase(state, wp, { from: wp.rebaseFrom, to, newBase }, deps);
    return result('continue', null, { rebases: [...(wp.rebases ?? []), entry] });
  }
  if (action.part === 'push') return result('continue', null, { pr: { ...wp.pr, head: (wp.rebases ?? []).at(-1)?.to ?? wp.pr.head } });
  return result('continue');
}

// A full review of the rebased head, round + 1, at the WP's tier (D13.3).
function fullReview(state, wp, deps) {
  const round = latestRound(wp) + 1;
  if (wp.tier !== 'T2') return reviewActions(state, wp, { round });
  const diff = deps.exec('git', ['-C', wp.lane.worktree, 'diff', '--name-only', `origin/${defaultOf(state)}...HEAD`]);
  return t2Actions(state, wp, { round, changedPaths: lines(diff.stdout).map((path) => join(wp.lane.worktree, path)) });
}

function recordGate(state, wp, action, r, deps) {
  if (r.code === 0) return result('continue');
  if (r.code === 6) return { ...result('wait', 'CI is still running at head'), waitMs: WAIT_MS };
  const gate = parseJson(r.stdout);
  if (r.code !== 5 || !gate) return result('block', `land gate exit ${r.code}: ${first(r.stderr) || first(r.stdout)}`);
  const reason = gate.failures.join('; ');
  if (gate.blocked) return result('block', reason);
  if (gate.staleBase) return result('continue', `stale base: re-rebase (${reason})`, { queue: rebaseActions(state, wp) });
  if (gate.needsFullReview) {
    const release = mergeLockFor(state, wp) === 'mine' ? { mergeLock: null } : {};
    return result('continue', reason, { ...release, queue: fullReview(state, wp, deps) });
  }
  return result('amend', reason);
}

function landOutcome(state, wp, action, r, deps) {
  switch (action.step) {
    case 'review': return recordReview(state, wp, action, r);
    case 'post':
      if (r.code !== 0) return result('block', `post failed (exit ${r.code}): ${first(r.stderr)}`);
      return result('continue', null, { reviews: [...(wp.reviews ?? []), reviewEntry(wp, action.land, { findings: findingsCount(r) })] });
    case 'council': {
      if (action.part !== 'synthesize') return result('continue');
      const entry = { round: action.land.round, scope: 'full', tier: 'T2', head: action.head, lenses: Array.isArray(r.seats) ? r.seats : [],
        reviewId: action.args.review_dir, findings: Number.isInteger(r.findings) ? r.findings : null, verdicts: [], resolved: [] };
      return result('continue', null, { reviews: [...(wp.reviews ?? []), entry] });
    }
    case 'reply':
      return action.kind === 'author' || r.code === 0 ? result('continue') : result('block', `reply failed (exit ${r.code}): ${first(r.stderr)}`);
    case 'thread-ids': return recordThreadIds(state, wp, action, r);
    case 'resolve':
      if (r.code !== 0) return result('block', `resolve failed: ${first(r.stderr)}`);
      return result('continue', null, { reviews: withLatest(wp, (review) => ({ ...review, resolved: [...(review.resolved ?? []), action.land.threadId] })) });
    case 'rebase': return recordRebaseStep(state, wp, action, r, deps);
    case 'gate': return recordGate(state, wp, action, r, deps);
    case 'merge': {
      if (r.code !== 0 && !(action.part === 'ready' && /already/i.test(r.stderr))) return result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
      if (action.part !== 'merge-commit') return result('continue');
      const sha = parseJson(r.stdout)?.mergeCommit?.oid;
      return sha ? result('continue', null, { merge: { sha } }) : result('block', 'gh pr view printed no mergeCommit.oid');
    }
    case 'merged':
      if (r.code === 0) return result('done', null, mergeLockFor(state, wp) === 'mine' ? { mergeLock: null } : {});
      if (r.code === 5) {
        const reason = 'merged tree differs from the checked head';
        return result('block', reason, { dispatchHalt: { reason, since: new Date(deps.now()).toISOString() } });
      }
      return result('block', `land merged exit ${r.code}: ${first(r.stderr) || first(r.stdout)}`);
    default:
      throw new ConductError(2, `recordLandStep has no case for step ${action.step}`);
  }
}

// The one recorder for every landing action. Any amend or block between the
// rebase and merged releases the lock its WP holds.
export function recordLandStep(state, wp, action, r, deps = {}) {
  const out = landOutcome(state, wp, action, r ?? {}, deps);
  if ((out.outcome === 'amend' || out.outcome === 'block') && LOCKED_STEPS.has(action.step) && mergeLockFor(state, wp) === 'mine') {
    out.patch = { ...out.patch, mergeLock: null };
  }
  return out;
}

// `--wp release`: the release PR as a WP of tier T0 with no reviews or rebases.
function releaseView(state) {
  const release = state.release ?? {};
  return { id: 'release', tier: 'T0', lane: { worktree: release.worktree, branch: release.branch, base: release.base },
    pr: release.pr, gate: release.gate, merge: release.merge, reviews: [], rebases: [] };
}

export async function runLandVerb(sub, { runDir, wpId, flags = {} }, deps) {
  const state = loadState(runDir, deps);
  const wp = wpId === 'release' ? releaseView(state) : state.wps.find((candidate) => candidate.id === wpId);
  if (!wp?.lane?.worktree || !wp.pr?.number) return { code: 2, out: { ok: false, error: `${wpId} has no worktree and PR to land` } };
  if (sub === 'gate') {
    const gate = gateCheck(state, wp, { exec: deps.exec, now: deps.now });
    return { code: gate.ok ? 0 : gate.pending ? 6 : 5, out: gate };
  }
  if (sub !== 'merged' || typeof flags.mergeSha !== 'string' || !flags.mergeSha.trim()) {
    return { code: 2, out: { ok: false, error: 'land merged needs --merge-sha <sha>' } };
  }
  const head = wp.gate?.head ?? wp.pr.head;
  const wt = wp.lane.worktree;
  const fetch = deps.exec('git', ['-C', wt, 'fetch', 'origin']);
  const diff = deps.exec('git', ['-C', wt, 'diff', '--quiet', head, flags.mergeSha]);
  if (fetch.code === 0 && diff.code === 0) return { code: 0, out: { ok: true, head, mergeSha: flags.mergeSha } };
  const reason = diff.code === 1 ? 'the squash tree differs from the checked head' : `tree compare failed: ${first(fetch.code ? fetch.stderr : diff.stderr)}`;
  return { code: 5, out: { ok: false, head, mergeSha: flags.mergeSha, reason } };
}
