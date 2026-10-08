// Landing a WP: the review lenses at its tier, the adjudication replies and
// thread resolution, the rebase under the merge lock, the merge gate at the
// exact head, and the merge. Burn-down's gate (skills/burn-down/SKILL.md § Per
// item step 4) and slim-review's script are driven here, never restated.
//
// Every function returns actions or a recorder outcome. Programs run only in
// gateCheck, runLandVerb, recordRebase and recordLandStep (git, for a rebase
// record or a full review's changed files), always through the injected exec.
//
// Contract for WP-04 (the build phase that drives this module):
// - Queue: an emitter's array goes to `wps[].queue`; recordLandStep's
//   `patch.queue`, when present, replaces the remaining queue whole (a leading
//   copy of the recorded action is dropped either way). A terminal outcome
//   (amend, block, held, done) carries `queue: []` or exactly the cleanup owed.
// - Outcomes: continue | amend | block | wait | done | held. `wait` carries
//   `waitMs` and re-queues what it waits on; `held` keeps the PR open, ends the
//   WP's build and releases the merge lock. ConductErrors become `block`.
// - Records: a shell action is recorded as { code, stdout, stderr }; the
//   `inspect` action as { verdict, tail, head }; council tools as their JSON.
// - Patch: `mergeLock` and `dispatchHalt` are run-level; every other key is a
//   WP field, applied as given: `reviewMode`, `rebaseFrom`, `rebases`,
//   `threadIds`, `reviews`, `inspections`, `councilStage`, `retries`, `gate`
//   (with `pendingSince`), `merge`, `pr`.
// - WP-04 sets: `wps[].commit` (the WP's Commit line), `wps[].agent` (the
//   lane's effective author), `wps[].files`, `wps[].tier` (tierFor's raise
//   persisted before the review), and `wps[].pr.head` after every lane push,
//   so the rebase lease pins the current remote head.
// - Emitters throw ConductError 5 when no lens can run: block the WP.
//
// `land merged` compares the squash tree with the checked head. That holds
// only while the base does not move between the gate and the merge; a moved
// base reads as a tree mismatch and halts dispatch, never as a pass.
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ConductError, STEP_SEAM, loadState } from './state.mjs';
import { amendmentSections } from './markdown.mjs';

const WAIT_MS = 60000;
const PENDING_BLOCK_MS = 30 * 60000;
const NO_CI_MS = 10 * 60000;
const MAX_RETRIES = 3;
const TAIL_LINE_CAP = 400;
const GREEN = new Set(['success', 'neutral', 'skipped']);
// Markdown that carries behavior is never a trivial tail (`trivialExclude` in
// .workit/conduct.json replaces this list; contractPaths are always added).
export const DEFAULT_NOT_TRIVIAL = ['skills/**/SKILL.md', 'reference/templates/**', 'agents/**', 'commands/**', '.claude-plugin/**'];
// The reason `claim` prints when the head already carries this identity's review.
export const ALREADY_REVIEWED = 'already-posted';
export const TREE_MISMATCH = 'the squash tree differs from the checked head';
const VERDICTS = ['fixed', 'refuted', 'judgment', 'conductor'];
const REPLY_VERDICT = { fixed: 'confirmed', refuted: 'refuted', judgment: 'judgment' };
const INSPECTION = ['addresses-findings', 'unrelated-change'];
// No quote character in either, so the argv runs without a shell.
export const THREADS_QUERY = 'query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } } } } }';
export const RESOLVE_MUTATION = 'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }';
const LOCKED_STEPS = new Set(['rebase', 'gate', 'merge', 'merged']);

const lower = (wp) => String(wp.id).toLowerCase();
const norm = (path) => String(path).replaceAll('\\', '/');
const repoOf = (state) => state.intent.repo.remote;
const defaultOf = (state) => state.intent.repo.defaultBranch ?? 'main';
const prReview = (state) => join(state.pluginRoot, 'skills', 'slim-review', 'scripts', 'pr-review.mjs');
const reviewsDir = (state, wp) => join(state.runDir, 'reviews', lower(wp));
const lines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const first = (text) => lines(text)[0] ?? '';
const result = (outcome, reason = null, patch = {}) => ({ outcome, reason, patch });
// Unknown or missing tiers are treated as T2, everywhere.
export const effectiveTier = (wp) => (['T0', 'T1', 'T2'].includes(wp.tier) ? wp.tier : 'T2');
const authorOf = (state, wp) => wp.agent ?? state.intent.agent;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shell(step, part, command, extra = {}) {
  return { kind: 'shell', step, seam: STEP_SEAM[step], part, instruction: `Run this exact argv (no shell): ${command.slice(0, 3).join(' ')} …, and record its { code, stdout, stderr }.`, command, expects: { type: 'none' }, ...extra };
}

function waitAction(step, part, instruction) {
  return { kind: 'wait', step, seam: STEP_SEAM[step], part, instruction, waitMs: WAIT_MS };
}

const requeue = (action) => Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'id' && key !== 'phase'));

// Tests by file name anywhere, by `__tests__/` or `__fixtures__/` segment
// anywhere, and `test/`, `tests/`, `spec/` only at the repo root.
export function isTestPath(path) {
  const p = norm(path).replace(/^\.\//, '');
  const base = p.split('/').pop();
  return /\.(test|spec)\./.test(base) || /_test\./.test(base) || /(^|\/)(__tests__|__fixtures__)\//.test(p) || /^(tests?|spec)\//.test(p);
}

function globRegex(glob) {
  const body = norm(glob).split(/(\*\*\/|\*\*|\*)/).map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*'
    : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${body}$`);
}

// Trivial means docs: tests, fixtures and behavior-bearing Markdown never are.
function trivialPath(path, notTrivial) {
  const p = norm(path);
  return p.endsWith('.md') && !isTestPath(p) && !/(^|\/)(__fixtures__|fixtures|testdata)\//.test(p) && !notTrivial.some((re) => re.test(p));
}

// Raise only: a test file or a contract path makes it T2.
export function tierFor(wp, changedPaths = [], contractPaths = []) {
  const contracts = contractPaths.map(globRegex);
  return changedPaths.some((path) => isTestPath(path) || contracts.some((re) => re.test(norm(path)))) ? 'T2' : effectiveTier(wp);
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
// `managed` probe alone; its record expands the rest (reviewSteps). No lens
// that can run is ConductError 5: the WP blocks.
export function reviewActions(state, wp, { round = 1, report = null, since = null, all = false } = {}) {
  const meta = { round, scope: since ? 'delta' : 'full', since, report, all };
  if (!wp.reviewMode) {
    return [shell('review', 'managed', ['node', prReview(state), 'managed', '--repo', repoOf(state)], { expects: { type: 'json' }, land: meta })];
  }
  return reviewSteps(state, wp, wp.reviewMode, meta);
}

function reviewSteps(state, wp, mode, meta) {
  const pick = pickReviewers(state, authorOf(state, wp), { mode });
  if (pick.impossible) throw new ConductError(5, `${wp.id}: review impossible: ${pick.impossible}`);
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

// One delta pass, before any rebase, so --since names an ancestor. A T2 WP
// with the council on gets a council round dispatched as scope 'delta'.
export function deltaReviewActions(state, wp, sinceHead, { report = null, changedPaths = [] } = {}) {
  if ((wp.rebases ?? []).some((rebase) => rebase.from === sinceHead && rebase.from !== rebase.to)) {
    throw new ConductError(2, `${wp.id}: no delta review after a rebase (${sinceHead.slice(0, 7)} is not an ancestor of the rebased head); a full review is owed`);
  }
  const round = latestRound(wp) + 1;
  if (state.adapters?.council?.on && effectiveTier(wp) === 'T2') return t2Actions(state, wp, { round, changedPaths, report, scope: 'delta', since: sinceHead });
  return reviewActions(state, wp, { round, report, since: sinceHead });
}

// The council round's scope comes from its dispatch, never the round number.
// A delta round first writes `git diff <since> <head>` into the run dir and
// hands that file to the council, so the scope reaches the tool's input.
export function t2Actions(state, wp, { round = 1, changedPaths = [], report = null, scope = 'full', since = null } = {}) {
  if (!state.adapters?.council?.on) return reviewActions(state, wp, { round, report, all: true, since: scope === 'delta' ? since : null });
  const workshop = `${join(state.runDir, 'council', lower(wp))}${sep}`;
  const outDir = `${join(state.runDir, 'council', lower(wp), `review-${round}`)}${sep}`;
  const deltaDiff = scope === 'delta' ? join(state.runDir, 'council', lower(wp), `delta-r${round}.diff`) : null;
  const land = { round, scope, since, deltaDiff };
  const tool = (part, name, args, extra = {}) => ({ kind: 'agent-tool', step: 'council', seam: STEP_SEAM.council, part, tool: name,
    instruction: `Call ${name} with these args and record its result.`, args, expects: { type: 'json' }, land, ...extra });
  return [
    ...(deltaDiff ? [shell('council', 'delta-diff', ['git', '-C', wp.lane.worktree, 'diff', '--no-color', `--output=${deltaDiff}`, since, wp.pr.head], { land })] : []),
    tool('review', 'council_review', { workshop_path: workshop, output_dir: outDir, surface: 'code', code_root: wp.lane.worktree,
      artifact_paths: [...(deltaDiff ? [deltaDiff] : []), ...changedPaths], round, profile: 'code' }),
    tool('synthesize', 'council_synthesize', { review_dir: outDir, workshop_path: workshop }, {
      head: wp.pr.head, expects: { type: 'json', fields: ['findings', 'seats'] },
      instruction: 'Call council_synthesize, then record { findings: <count>, seats: [<usable seats>] } read from the synthesis. Count each synthesized finding once if any lens rated it Critical, Major or Minor; a finding every lens rated Note is not counted.',
    }),
    tool('challenge', 'council_challenge', { review_dir: outDir, workshop_path: workshop, code_root: wp.lane.worktree }),
  ];
}

// A Commit cell: one sha, or several comma-separated when a fix took more than
// one commit. Returns the shas, or null when any part is not a sha.
export function rowCommits(cell) {
  const shas = String(cell ?? '').split(/[\s,]+/).map((part) => part.replace(/^`+|`+$/g, '')).filter(Boolean);
  return shas.length && shas.every((sha) => /^[0-9a-f]{7,40}$/i.test(sha)) ? shas : null;
}

function splitRow(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
  return cells.map((cell) => cell.replace(/^`(.*)`$/, '$1'));
}

const TABLE_HEADER = /^\|\s*Comment\s*\|\s*Verdict\s*\|\s*Evidence\s*\|\s*Commit\s*\|/i;

// The rows of an `## Amendment N` table, which ends at the first line after its
// header that is not a table row. Without `since`, the latest section's table;
// with it, the table of the latest section numbered `since` or later that has
// one, so an amendment that only fixed a check (no table) does not hide the
// findings table before it, and a table from an earlier round never answers.
// A table quoted inside a code fence is never the table.
export function parseAmendmentTable(reportText, { since = null } = {}) {
  const headerAt = (section) => section.lines.findIndex((line) => !line.fenced && TABLE_HEADER.test(line.text.trim()));
  const sections = amendmentSections(reportText);
  const candidates = since === null ? sections.slice(-1) : sections.filter((section) => section.n >= since && headerAt(section) >= 0);
  const section = candidates.at(-1);
  if (!section) return [];
  const header = headerAt(section);
  if (header < 0) return [];
  const body = [];
  for (const { text: line, fenced } of section.lines.slice(header + 1)) {
    if (fenced || !line.trim().startsWith('|')) break;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
    const [comment, verdict, evidence, commit] = splitRow(line);
    body.push({ comment, verdict: String(verdict ?? '').toLowerCase(), evidence: evidence ?? '', commit: rowCommits(commit)?.join(',') ?? null });
  }
  return body;
}

// A row's id: a PR comment databaseId (`#` stripped), or a council id; anything else is refused.
function commentId(raw) {
  const id = String(raw ?? '').trim().replace(/^#(?=\d+$)/, '');
  if (/^\d+$/.test(id) || /^C\d+-\d+$/.test(id)) return id;
  throw new ConductError(2, `comment id ${JSON.stringify(raw)} is neither a PR comment id nor a council id C<round>-<n>`);
}

export function recordAdjudication(state, wp, verdicts) {
  const reviews = wp.reviews ?? [];
  if (!reviews.length) throw new ConductError(2, `${wp.id} has no review to adjudicate`);
  const rows = verdicts.map((row) => {
    const comment = commentId(row.comment);
    if (!VERDICTS.includes(row.verdict)) throw new ConductError(2, `comment ${comment}: verdict must be one of ${VERDICTS.join(', ')} (got ${row.verdict})`);
    if (row.verdict === 'fixed' && !rowCommits(row.commit)) throw new ConductError(2, `comment ${comment}: a fixed row needs its commit sha (several are comma-separated)`);
    return { comment, verdict: row.verdict, evidence: row.evidence ?? '', commit: row.commit ?? null, ...(row.adjudicator ? { adjudicator: row.adjudicator } : {}) };
  });
  const latest = { ...reviews.at(-1), verdicts: [...(reviews.at(-1).verdicts ?? []), ...rows] };
  // Council ids have no PR thread; conductor rows go to a ruling first.
  const replyRows = rows.filter((row) => /^\d+$/.test(row.comment) && row.verdict !== 'conductor');
  const replies = join(reviewsDir(state, wp), 'replies');
  const body = (row) => join(replies, `${row.comment}.md`);
  const actions = replyRows.length === 0 ? [] : [
    { kind: 'author', step: 'reply', seam: STEP_SEAM.reply, part: 'bodies', instruction: 'Write one reply body per file: the verdict and its evidence, quoted from the lane\'s amendment row.',
      outPath: replies, files: replyRows.map((row) => ({ path: body(row), ...row })), expects: { type: 'file' } },
    ...replyRows.map((row) => shell('reply', 'reply', ['node', prReview(state), 'reply', '--pr', String(wp.pr.number), '--repo', repoOf(state),
      '--comment-id', row.comment, '--body-file', body(row), '--verdict', REPLY_VERDICT[row.verdict], '--adjudicator', row.adjudicator ?? 'lane',
      '--measure-log', join(state.runDir, 't1.jsonl')])),
  ];
  return { patch: { reviews: [...reviews.slice(0, -1), latest] }, actions, conductorRows: rows.filter((row) => row.verdict === 'conductor') };
}

// One lookup maps comment ids to thread node ids; its record queues the resolves.
export function resolveThreadActions(state, wp, commentIds) {
  const [owner, name] = repoOf(state).split('/');
  return [shell('thread-ids', 'lookup', ['gh', 'api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${wp.pr.number}`],
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

// The push lease is pinned to the PR head the rebase started from, so a
// commit pushed to the branch since then is never overwritten. The PR is
// readied here, under the lock the fetch takes and before the gate, never back
// to back with the merge: a ready PR is what a pipeline review picks up, and the
// gate waits for that review.
export function rebaseActions(state, wp) {
  if (mergeLockFor(state, wp) === 'other') return [waitAction('rebase', 'yield', `Wait: ${state.mergeLock.wpId} holds the merge lock.`)];
  const git = (part, ...args) => shell('rebase', part, ['git', '-C', wp.lane.worktree, ...args]);
  const base = `origin/${defaultOf(state)}`;
  return [
    git('fetch', 'fetch', 'origin'),
    shell('rebase', 'ready', ['gh', 'pr', 'ready', String(wp.pr.number), '--repo', repoOf(state)]),
    git('pre-head', 'rev-parse', 'HEAD'),
    git('rebase', 'rebase', base),
    git('post-heads', 'rev-parse', 'HEAD', base),
    git('push', 'push', `--force-with-lease=${wp.lane.branch}:${wp.pr.head}`, 'origin', wp.lane.branch),
    waitAction('rebase', 'ci-wait', 'Wait for CI at the pushed head; the land gate action answers it.'),
  ];
}

// A whitespace-preserving id of the WP's diff, from output git does not
// colour or transform. An empty id for a non-empty diff is unreadable (null).
function patchId(wt, a, b, exec) {
  const diff = exec('git', ['-C', wt, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', a, b]);
  if (diff.code !== 0) return null;
  if (diff.stdout === '') return '';
  const id = exec('git', ['-C', wt, 'patch-id', '--verbatim'], { input: diff.stdout });
  const value = id.code === 0 ? id.stdout.trim().split(/\s+/)[0] ?? '' : '';
  return value === '' ? null : value;
}

// Equal verbatim patch-ids mean the review of `from` covers `to` (D13, with
// whitespace kept). An unreadable id is never equivalent.
export function recordRebase(state, wp, { from, to, newBase }, deps) {
  const oldBase = (wp.rebases ?? []).at(-1)?.newBase ?? wp.lane.base;
  const ids = { from: patchId(wp.lane.worktree, oldBase, from, deps.exec), to: patchId(wp.lane.worktree, newBase, to, deps.exec) };
  return { from, to, oldBase, newBase, patchIds: ids, equivalent: ids.from !== null && ids.from === ids.to };
}

// `gh api --paginate` prints one JSON object per page with nothing between
// them. Outside a page only whitespace or a page opener is allowed, and an
// unfinished page or string is a truncated read.
export function parsePages(text) {
  const pages = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (depth === 0 && c !== '{' && c !== '[') {
      if (!/\s/.test(c)) throw new Error(`text outside a page at offset ${i}`);
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (depth++ === 0) start = i;
    } else if ((c === '}' || c === ']') && --depth === 0) pages.push(JSON.parse(text.slice(start, i + 1)));
  }
  // An unfinished string can only sit inside a page, so it leaves depth > 0.
  if (depth !== 0) throw new Error('a page is truncated');
  return pages;
}

// Check-runs and legacy commit statuses at one sha, as one run list. Every
// page must be well formed and the runs complete (count = total_count, ids distinct).
function readRuns(state, sha, exec) {
  const read = exec('gh', ['api', `repos/${repoOf(state)}/commits/${sha}/check-runs?per_page=100`, '--paginate']);
  if (read.code !== 0) return /HTTP (422|404)/.test(read.stderr) ? { missing: true } : { failure: `CI unreadable: ${first(read.stderr)}` };
  let pages;
  try {
    pages = parsePages(read.stdout);
  } catch (error) {
    return { failure: `CI unreadable: ${error.message}` };
  }
  const runOk = (run) => run && run.id != null && typeof run.name === 'string' && typeof run.status === 'string';
  if (!pages.length || pages.some((page) => typeof page?.total_count !== 'number' || !Array.isArray(page.check_runs) || !page.check_runs.every(runOk))) {
    return { failure: 'CI unreadable: a check-runs page is malformed' };
  }
  const runs = pages.flatMap((page) => page.check_runs);
  const total = pages[0].total_count;
  if (pages.some((page) => page.total_count !== total) || runs.length !== total || new Set(runs.map((run) => run.id)).size !== runs.length) {
    return { failure: `CI incomplete: ${runs.length} distinct-checked runs read of total_count ${total}` };
  }
  // Legacy statuses: the combined status, every page; one entry per context.
  const status = exec('gh', ['api', `repos/${repoOf(state)}/commits/${sha}/status?per_page=100`, '--paginate']);
  let statusPages = null;
  try {
    statusPages = status.code === 0 ? parsePages(status.stdout) : null;
  } catch {
    statusPages = null;
  }
  const statuses = statusPages?.every((page) => Array.isArray(page?.statuses) && typeof page.total_count === 'number') ? statusPages.flatMap((page) => page.statuses) : null;
  if (!statuses || statuses.length !== statusPages[0].total_count || new Set(statuses.map((s) => s.context)).size !== statuses.length) {
    return { failure: `commit statuses unreadable: ${first(status.stderr) || 'malformed or incomplete'}` };
  }
  const legacy = statuses.map((s) => ({ id: `status:${s.context}`, name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure' }));
  return { runs: [...runs, ...legacy] };
}

// The checks the head must carry: the branch's required status checks (the
// union of `contexts` and `checks`) when readable, else the names that ran on
// the base commit.
function expectedChecks(state, wt, exec) {
  const def = defaultOf(state);
  const required = exec('gh', ['api', `repos/${repoOf(state)}/branches/${encodeURIComponent(def)}/protection/required_status_checks`]);
  if (required.code === 0) {
    const body = parseJson(required.stdout);
    const contexts = body?.contexts ?? [];
    const checks = body?.checks ?? [];
    if (!Array.isArray(contexts) || !Array.isArray(checks) || !checks.every((check) => typeof check?.context === 'string')) {
      return { failure: 'required status checks unreadable: malformed' };
    }
    return { names: [...new Set([...contexts, ...checks.map((check) => check.context)])] };
  }
  if (!/HTTP 40[34]/.test(required.stderr)) return { failure: `required status checks unreadable: ${first(required.stderr)}` };
  const base = exec('git', ['-C', wt, 'rev-parse', `origin/${def}`]);
  if (base.code !== 0) return { failure: `base commit unreadable: ${first(base.stderr)}` };
  const ran = readRuns(state, base.stdout.trim(), exec);
  if (ran.failure) return ran;
  return { names: [...new Set((ran.runs ?? []).map((run) => run.name))] };
}

function ciCondition(state, wp, head, { exec, now }) {
  const at = readRuns(state, head, exec);
  if (at.failure) return { failure: at.failure, cause: 'infra' };
  if (at.missing) return { failure: 'no CI at head', cause: 'ci' };
  const since = wp.gate?.head === head && wp.gate?.pendingSince ? Date.parse(wp.gate.pendingSince) : null;
  const waited = since === null ? 0 : now() - since;
  const runs = at.runs;
  if (runs.length === 0) return waited >= NO_CI_MS ? { failure: 'no CI at head', cause: 'ci' } : { pending: true };
  if (runs.some((run) => run.status !== 'completed')) {
    return waited >= PENDING_BLOCK_MS ? { failure: 'CI did not complete at head', cause: 'ci', blocked: true } : { pending: true };
  }
  const red = runs.filter((run) => !GREEN.has(run.conclusion));
  if (red.length) return { failure: `CI failed at head: ${red.map((run) => `${run.name} (${run.conclusion})`).join(', ')}`, cause: 'ci' };
  const expected = expectedChecks(state, wp.lane.worktree, exec);
  if (expected.failure) return { failure: expected.failure, cause: 'infra' };
  const names = new Set(runs.map((run) => run.name));
  const absent = expected.names.filter((name) => !names.has(name));
  if (!absent.length) return {};
  // A check not yet registered is pending until the no-CI deadline, then blocks.
  return waited >= NO_CI_MS ? { failure: `expected check missing at head: ${absent.join(', ')}`, cause: 'ci-missing-check' } : { pending: true };
}

// A pipeline review of the head that has not ended: wait for it to post, so its
// threads are read at this gate and not after the merge. It shares CI's
// pending clock and blocks at the same deadline; an unreadable answer is infra.
function inflightCondition(state, wp, head, { exec, now }) {
  const r = exec('node', [prReview(state), 'inflight', '--pr', String(wp.pr.number), '--repo', repoOf(state), '--head', head]);
  if (r.code === 0) return {};
  if (r.code !== 9) return { failure: `in-flight review unreadable (exit ${r.code}): ${first(r.stderr) || first(r.stdout)}`, cause: 'infra' };
  const since = wp.gate?.head === head && wp.gate?.pendingSince ? Date.parse(wp.gate.pendingSince) : null;
  const waited = since === null ? 0 : now() - since;
  if (waited >= PENDING_BLOCK_MS) return { failure: `a pipeline review of head is still in flight: ${first(r.stderr)}`, cause: 'review-inflight', blocked: true };
  return { pending: true };
}

// The repo config on the base branch, so a PR cannot widen its own trivial set.
function notTrivialPatterns(state, wt, exec) {
  const shown = exec('git', ['-C', wt, 'show', `origin/${defaultOf(state)}:.workit/conduct.json`]);
  let config = {};
  if (shown.code === 0) {
    config = parseJson(shown.stdout);
    if (!config || typeof config !== 'object') return { failure: 'repo config .workit/conduct.json on the base is not valid JSON' };
  } else if (!/does not exist|exists on disk, but not in/.test(shown.stderr)) {
    return { failure: `repo config unreadable: ${first(shown.stderr)}` };
  }
  const globs = [...(Array.isArray(config.trivialExclude) ? config.trivialExclude : DEFAULT_NOT_TRIVIAL), ...(config.contractPaths ?? [])];
  return { patterns: globs.map(globRegex) };
}

function ancestor(wt, a, b, exec) {
  const code = exec('git', ['-C', wt, 'merge-base', '--is-ancestor', a, b]).code;
  return code === 0 ? true : code === 1 ? false : null;
}

const fixedCommits = (review) => (review.verdicts ?? [])
  .filter((row) => row.verdict === 'fixed').flatMap((row) => (rowCommits(row.commit) ?? []).map((commit) => commit.toLowerCase()));

// The commits gate amendments added after the review cap: each gate amendment
// records the head it started from (build.mjs gateAmend) and, once its lane
// work is back, the head it ended at; its commits are from..end (end = `to`
// while it is still open). A range whose ends are no longer on the line to
// `to` (a later rebase rewrote them) names nothing. Returns the commits and
// the gate failures they repair; null is an unreadable range.
function gateFixCommits(wp, to, exec) {
  const wt = wp.lane.worktree;
  const commits = new Set();
  const reasons = [];
  for (const fix of wp.gateFixes ?? []) {
    const end = fix?.to ?? to;
    if (!fix?.from || fix.from === end) continue;
    const fromOnLine = ancestor(wt, fix.from, end, exec);
    const endOnLine = end === to ? true : ancestor(wt, end, to, exec);
    if (fromOnLine === null || endOnLine === null) return null;
    if (!fromOnLine || !endOnLine) continue;
    const listed = exec('git', ['-C', wt, 'rev-list', `${fix.from}..${end}`]);
    if (listed.code !== 0) return null;
    const shas = lines(listed.stdout).map((sha) => sha.toLowerCase());
    shas.forEach((sha) => commits.add(sha));
    if (shas.length && fix.reason) reasons.push({ reason: fix.reason, shas });
  }
  return { commits, reasons };
}

// An inspection binds the exact tail and candidate head, the anchoring
// review's identity and a hash of its adjudication table.
const reviewIdentity = (review) => ({ round: review.round ?? null, scope: review.scope ?? null, since: review.since ?? null });
const findingsHash = (review) => createHash('sha256').update(JSON.stringify(review.verdicts ?? [])).digest('hex');
const sameBinding = (entry, binding) => entry.tail === binding.tail && entry.head === binding.head
  && JSON.stringify(entry.review) === JSON.stringify(binding.review) && entry.findingsHash === binding.findingsHash;

function declaredFile(wp, path) {
  return (wp.files ?? []).map(norm).some((file) => (file.endsWith('/') ? norm(path).startsWith(file) : norm(path) === file));
}

// A tail is trivial (no net diff, or only plain docs), or post-cap: it starts at
// the anchoring delta review's (translated) head, every commit is a `fixed`
// row of that review, it stays inside the WP's Files and the line cap, and an
// inspection of exactly this tail and head says it addresses the findings.
function classifyTail(wp, anchor, from, to, head, exec, notTrivial) {
  const wt = wp.lane.worktree;
  const key = `${from}..${to}`;
  const quiet = exec('git', ['-C', wt, 'diff', '--quiet', '--no-renames', from, to]);
  if (quiet.code === 0) return { tail: `${key} (trivial)` };
  const numstat = exec('git', ['-C', wt, 'diff', '--no-renames', '--no-color', '--numstat', from, to]);
  if (quiet.code !== 1 || numstat.code !== 0) return { failure: `tail ${key} unreadable: ${first(numstat.stderr) || first(quiet.stderr)}`, cause: 'infra' };
  const rows = lines(numstat.stdout).map((row) => {
    const [added, deleted, ...path] = row.split(/\t/);
    return { path: path.join('\t'), lines: (Number(added) || 0) + (Number(deleted) || 0), binary: added === '-' };
  });
  const nonTrivial = rows.filter((row) => !trivialPath(row.path, notTrivial));
  if (rows.length && !nonTrivial.length) return { tail: `${key} (trivial)` };
  const changes = nonTrivial.map((row) => row.path).join(', ') || 'file modes';
  // The cap counts production lines (tests excluded); the inspection reads
  // every non-trivial path, tests included.
  const production = nonTrivial.filter((row) => !isTestPath(row.path));
  if (anchor.scope !== 'delta') return { failure: `review does not cover head: tail ${key} changes ${changes}`, cause: 'review-uncovered' };
  const listed = exec('git', ['-C', wt, 'rev-list', key]);
  if (listed.code !== 0) return { failure: `tail ${key} commits unreadable: ${first(listed.stderr)}`, cause: 'infra' };
  const fixed = fixedCommits(anchor);
  const shas = lines(listed.stdout);
  const gateFixed = gateFixCommits(wp, to, exec);
  if (gateFixed === null) return { failure: `tail ${key}: a gate amendment's commits are unreadable`, cause: 'infra' };
  const isFixed = (sha) => fixed.some((commit) => sha.toLowerCase().startsWith(commit));
  if (!shas.length) return { failure: `review does not cover head: tail ${key} lists no commits`, cause: 'review-uncovered' };
  // A commit no fixed row cites goes to the conductor's cite ruling (held), not the end of the build.
  const uncited = shas.filter((sha) => !isFixed(sha) && !gateFixed.commits.has(sha.toLowerCase()));
  if (uncited.length) {
    return { failure: `review does not cover head: tail ${key} has commits that are not fixed rows of the anchoring review: ${uncited.join(', ')}`, cause: 'tail-uncited', uncited };
  }
  // Gate amendments after the cap are their own class: bounded and inspected like the post-cap tail.
  const kind = shas.every(isFixed) ? 'post-cap' : 'gate-fix';
  const count = production.reduce((sum, row) => sum + row.lines, 0);
  const outside = rows.map((row) => row.path).filter((path) => !declaredFile(wp, path));
  if (count > TAIL_LINE_CAP || outside.length || rows.some((row) => row.binary)) {
    // Only outside the Files, inside the cap: the conductor can ratify the paths.
    const ratifiable = count <= TAIL_LINE_CAP && !rows.some((row) => row.binary);
    return { failure: `post-cap tail ${key} out of bounds: ${count} production lines${outside.length ? `; outside the WP's Files: ${outside.join(', ')}` : ''}`,
      cause: ratifiable ? 'tail-outside-files' : 'tail-out-of-bounds', ...(ratifiable ? { outside } : {}) };
  }
  const binding = { tail: key, head, review: reviewIdentity(anchor), findingsHash: findingsHash(anchor) };
  const inspection = (wp.inspections ?? []).find((entry) => sameBinding(entry, binding));
  const files = (nonTrivial.length ? nonTrivial : rows).map((row) => row.path);
  // A gate-fix tail is read against the gate failures its own commits repair
  // (not those of a fix already reviewed) as well as the findings.
  const inTail = new Set(shas.map((sha) => sha.toLowerCase()));
  const failures = gateFixed.reasons.filter((fix) => fix.shas.some((sha) => inTail.has(sha))).map((fix) => fix.reason);
  const repairs = kind === 'gate-fix' ? { gateFailures: failures } : {};
  if (!inspection) return { failure: `post-cap tail ${key} needs an inspection`, cause: 'inspect', inspect: { ...binding, files, anchor: anchor.reviewId ?? anchor.head, ...repairs } };
  if (inspection.verdict !== 'addresses-findings') return { failure: `post-cap tail ${key} inspected: ${inspection.verdict}`, cause: 'tail-out-of-bounds' };
  return { tail: `${key} (${kind})` };
}

// Condition (3): the latest review covers head, through equivalent rebases in
// either direction, or its tail qualifies; or the WP is T0.
function reviewCondition(wp, head, exec, notTrivial) {
  if (effectiveTier(wp) === 'T0') return { tail: `${wp.lane.base}..${head} (T0)` };
  const anchor = (wp.reviews ?? []).at(-1);
  if (!anchor) return { failure: 'no review of this WP', cause: 'review-uncovered' };
  const rebases = wp.rebases ?? [];
  if (rebases.filter((rebase) => !rebase.equivalent).length >= 2) return { failure: 'a second rebase changed the WP\'s diff: held for the operator', cause: 'tail-out-of-bounds' };
  if (anchor.head === head) return {};
  const changed = { failure: 'rebase changed the WP\'s diff: full review of the rebased head', cause: 'full-review', needsFullReview: true };
  let after = anchor.head;
  for (const rebase of rebases) {
    if (rebase.from !== after) continue;
    if (!rebase.equivalent) return changed;
    after = rebase.to;
  }
  let pre = head;
  for (let i = rebases.length - 1; i >= 0 && rebases[i].to === pre && pre !== anchor.head; i -= 1) {
    if (!rebases[i].equivalent) return changed;
    pre = rebases[i].from;
  }
  if (after === head || pre === anchor.head || after === pre) return {};
  // The tail runs from the anchor's head (or its equivalent-rebase image) to
  // the candidate (or its pre-rebase image); the first pair on one line wins.
  const wt = wp.lane.worktree;
  const pairs = [[anchor.head, pre], ...(after !== anchor.head ? [[after, pre], [after, head]] : [])].filter(([a, b]) => a !== b);
  for (const [from, to] of pairs) {
    const onLine = ancestor(wt, from, to, exec);
    if (onLine === null) return { failure: 'review coverage unreadable: an ancestry check failed', cause: 'infra' };
    if (onLine) return classifyTail(wp, anchor, from, to, head, exec, notTrivial);
  }
  return { failure: `review does not cover head: ${anchor.head} reaches ${head} through no recorded rebase`, cause: 'review-uncovered' };
}

// The merge gate at the exact head. Every condition runs and every failure is
// listed with its cause; `pending` only when running CI or an in-flight pipeline
// review of the head is the sole reason ok is false (`pendingOn` names which).
export function gateCheck(state, wp, { exec, now }) {
  const wt = wp.lane.worktree;
  const failures = [];
  const causes = new Set();
  const fail = (text, cause) => {
    failures.push(text);
    causes.add(cause);
  };
  const rev = exec('git', ['-C', wt, 'rev-parse', 'HEAD']);
  const head = rev.code === 0 ? rev.stdout.trim() : null;
  if (!head) fail(`worktree head unreadable: ${first(rev.stderr)}`, 'infra');
  const view = exec('gh', ['pr', 'view', String(wp.pr.number), '--repo', repoOf(state), '--json', 'headRefOid,baseRefName,state']);
  const pr = view.code === 0 ? parseJson(view.stdout) : null;
  if (!pr?.headRefOid) fail(`PR head unreadable: ${first(view.stderr)}`, 'infra');
  else {
    if (head && pr.headRefOid !== head) fail('head mismatch', 'head-mismatch');
    if (pr.state !== 'OPEN') fail(`PR is ${pr.state}, not OPEN`, 'pr-state');
    if (pr.baseRefName !== defaultOf(state)) fail(`PR base is ${pr.baseRefName}, not ${defaultOf(state)}`, 'pr-state');
  }
  // (0) fresh base and the merge lock.
  const fetch = exec('git', ['-C', wt, 'fetch', 'origin']);
  if (fetch.code !== 0) fail(`fetch failed: ${first(fetch.stderr)}`, 'infra');
  const fresh = exec('git', ['-C', wt, 'merge-base', '--is-ancestor', `origin/${defaultOf(state)}`, 'HEAD']);
  if (fresh.code === 1) fail('stale base', 'stale-base');
  else if (fresh.code !== 0) fail(`base freshness unreadable: ${first(fresh.stderr)}`, 'infra');
  const lock = lockFailure(state, wp);
  if (lock) fail(lock, 'lock');
  // (1) CI, (2) threads, (3) review covers head.
  const ci = head ? ciCondition(state, wp, head, { exec, now }) : { failure: 'CI not read: no head', cause: 'infra' };
  if (ci.failure) fail(ci.failure, ci.cause);
  // In flight first: a review that posts and ends between the two reads is
  // then seen by the threads read, never missed by both.
  const flight = head ? inflightCondition(state, wp, head, { exec, now }) : {};
  if (flight.failure) fail(flight.failure, flight.cause);
  const threads = exec('node', [prReview(state), 'threads', '--pr', String(wp.pr.number), '--repo', repoOf(state), '--unresolved']);
  if (threads.code === 8) fail('unresolved review threads', 'threads');
  else if (threads.code !== 0) fail(`threads unreadable (exit ${threads.code}): ${first(threads.stderr)}`, 'infra');
  const config = notTrivialPatterns(state, wt, exec);
  if (config.failure) fail(config.failure, 'infra');
  const review = head ? reviewCondition(wp, head, exec, config.patterns ?? DEFAULT_NOT_TRIVIAL.map(globRegex)) : { failure: 'review coverage not read: no head', cause: 'infra' };
  if (review.failure) fail(review.failure, review.cause);
  const pendingOn = [...(ci.pending ? ['ci'] : []), ...(flight.pending ? ['review'] : [])];
  const ok = failures.length === 0 && pendingOn.length === 0;
  return {
    ok, pending: !ok && failures.length === 0, pendingOn, blocked: ci.blocked === true || flight.blocked === true, head, failures, causes: [...causes],
    unreviewedTail: review.tail ?? null, needsFullReview: review.needsFullReview === true, staleBase: causes.has('stale-base'),
    ...(review.inspect ? { inspect: review.inspect } : {}),
    ...(review.outside ? { outside: review.outside } : {}),
    ...(review.uncited ? { uncited: review.uncited } : {}),
  };
}

export function mergeActions(state, wp, head) {
  if (state.authority?.merge !== true || mergeLockFor(state, wp) !== 'mine') return [];
  const pr = String(wp.pr.number);
  const repo = repoOf(state);
  return [
    shell('merge', 'squash', ['gh', 'pr', 'merge', pr, '--repo', repo, '--squash', '--match-head-commit', head,
      ...(wp.commit ? ['--subject', `${wp.commit} (#${pr})`] : [])]),
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
  return { round: land.round, scope: land.scope, since: land.since ?? null, tier: effectiveTier(wp), head: land.head, lenses: land.lenses,
    attemptRef: land.attemptRef ?? null, reviewId: null, findings: null, verdicts: [], resolved: [], ...extra };
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

// Infrastructure failures retry the same action up to MAX_RETRIES, then block.
function retry(wp, action, reason) {
  const n = (wp.retries ?? 0) + 1;
  if (n > MAX_RETRIES) return result('block', `${reason} (after ${MAX_RETRIES} retries)`, { retries: 0 });
  return { ...result('wait', `${reason} (retry ${n} of ${MAX_RETRIES})`, { retries: n, queue: [requeue(action), ...rest(wp, action)] }), waitMs: WAIT_MS };
}

function recordReview(state, wp, action, r) {
  const after = rest(wp, action);
  if (action.part === 'managed') {
    const mode = parseJson(r.stdout)?.mode;
    if (mode !== 'managed' && mode !== 'standalone') return result('block', `review mode unreadable: ${first(r.stdout) || first(r.stderr)}`);
    const pick = pickReviewers(state, authorOf(state, wp), { mode });
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
    // The refusal is not a review: recover the posted review of this exact head, or hold.
    const recover = shell('review', 'recover', ['node', prReview(state), 'rounds', '--pr', String(wp.pr.number), '--repo', repoOf(state), '--head', action.land.head],
      { land: action.land });
    return result('continue', `claim refused ${ALREADY_REVIEWED}: reading the posted review of this head`,
      { queue: [recover, ...after.filter((a) => a.land?.attemptRef !== action.land.attemptRef)] });
  }
  if (action.part === 'recover') {
    const read = parseJson(first(r.stdout));
    if (read?.outcome === 'ok' && read.round === 'reviewed' && read.last?.head === action.land.head) {
      const entry = reviewEntry(wp, action.land, { scope: read.last.scope === 'delta' ? 'delta' : 'full', reviewId: read.last.review_id ?? null });
      return result('continue', null, { reviews: [...(wp.reviews ?? []), entry] });
    }
    return result('held', `claim refused ${ALREADY_REVIEWED} and no posted review of ${action.land.head} could be verified: ${first(r.stdout) || first(r.stderr)}`);
  }
  return r.code === 0 ? result('continue') : result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
}

// A council round is coverage only after a review with a usable seat and a
// synthesis with a parseable count; the entry is written at that point.
function recordCouncil(state, wp, action, r) {
  const land = action.land ?? {};
  if (action.part === 'delta-diff') return r.code === 0 ? result('continue') : result('block', `delta diff for council round ${land.round} failed: ${first(r.stderr)}`);
  if (action.part === 'review') {
    const paths = action.args?.artifact_paths ?? [];
    if (!paths.length) return result('block', `council review round ${land.round} was dispatched with no artifact_paths: nothing to review`);
    const seats = Object.entries(r.models ?? {}).filter(([, seat]) => seat?.status === 'success').map(([name]) => name);
    if (r.error || !seats.length) return result('block', `council review round ${land.round} has no usable seat: ${r.error ?? 'every seat failed'}`);
    // Delta only when the dispatched review carried the delta diff.
    const scope = land.scope === 'delta' && land.deltaDiff && paths.includes(land.deltaDiff) ? 'delta' : 'full';
    return result('continue', null, { councilStage: { round: land.round, usable: seats.length, seats, scope } });
  }
  if (action.part === 'synthesize') {
    const stage = wp.councilStage;
    if (stage?.round !== land.round) return result('block', `council synthesis for round ${land.round} has no recorded review stage`);
    const seats = Array.isArray(r.seats) ? r.seats.filter((seat) => typeof seat === 'string' && seat) : [];
    if (r.error || !Number.isInteger(r.findings) || r.findings < 0 || !seats.length || !seats.every((seat) => (stage.seats ?? []).includes(seat))) {
      return result('block', `council synthesis round ${land.round} is unusable: ${r.error ?? 'needs an integer findings count and seats that succeeded at review'}`);
    }
    const entry = { round: land.round, scope: stage.scope ?? 'full', since: stage.scope === 'delta' ? land.since ?? null : null, tier: 'T2', head: action.head, lenses: seats,
      reviewId: action.args.review_dir, findings: r.findings, verdicts: [], resolved: [] };
    return result('continue', null, { councilStage: null, reviews: [...(wp.reviews ?? []), entry] });
  }
  if (r.error || r.success === false || r.challenge_stub) return result('block', `council challenge round ${land.round} failed: ${r.error ?? 'stub or unsuccessful'}`);
  return result('continue');
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
  if (action.part === 'ready') {
    return r.code === 0 || /already/i.test(r.stderr) ? result('continue') : result('block', `ready failed (exit ${r.code}): ${first(r.stderr)}`);
  }
  if (action.part === 'fetch') {
    const lock = mergeLockFor(state, wp);
    if (lock === 'other') return { ...result('wait', `merge lock held by ${state.mergeLock.wpId}`, { queue: wp.queue ?? [] }), waitMs: WAIT_MS };
    if (r.code !== 0) return retry(wp, action, `fetch failed: ${first(r.stderr)}`);
    return result('continue', null, { retries: 0, ...(lock === 'free' ? { mergeLock: { wpId: wp.id, since: new Date(deps.now()).toISOString() } } : {}) });
  }
  if (action.part === 'rebase' && r.code !== 0) {
    // The abort runs first; its record is the amendment.
    const conflict = `rebase onto origin/${defaultOf(state)} conflicted: ${first(r.stdout) || first(r.stderr)}`;
    return result('continue', conflict, { queue: [shell('rebase', 'abort', ['git', '-C', wp.lane.worktree, 'rebase', '--abort'], { land: { conflict } })] });
  }
  if (r.code !== 0) return result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
  if (action.part === 'abort') return result('amend', action.land.conflict);
  if (action.part === 'pre-head') return result('continue', null, { rebaseFrom: r.stdout.trim() });
  if (action.part === 'post-heads') {
    const [to, newBase] = lines(r.stdout);
    const entry = recordRebase(state, wp, { from: wp.rebaseFrom, to, newBase }, deps);
    return result('continue', null, { rebases: [...(wp.rebases ?? []), entry] });
  }
  if (action.part === 'push') return result('continue', null, { pr: { ...wp.pr, head: (wp.rebases ?? []).at(-1)?.to ?? wp.pr.head } });
  return result('continue');
}

// A full review of the rebased head, round + 1, at the WP's tier (D13.3). It
// is new content, so the amendment cap does not count it.
function fullReview(state, wp, deps) {
  const round = latestRound(wp) + 1;
  if (effectiveTier(wp) !== 'T2') return { queue: reviewActions(state, wp, { round }) };
  const diff = deps.exec('git', ['-C', wp.lane.worktree, 'diff', '--name-only', '--no-renames', `origin/${defaultOf(state)}...HEAD`]);
  if (diff.code !== 0) return { failure: `changed files unreadable: ${first(diff.stderr)}` };
  return { queue: t2Actions(state, wp, { round, changedPaths: lines(diff.stdout).map((path) => join(wp.lane.worktree, path)) }) };
}

const validInspect = (inspect) => inspect && typeof inspect === 'object' && /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/i.test(inspect.tail ?? '')
  && typeof inspect.head === 'string' && Array.isArray(inspect.files) && inspect.files.length > 0 && inspect.files.every((file) => typeof file === 'string' && file)
  && inspect.review && typeof inspect.findingsHash === 'string';

function inspectAction(state, wp, inspect, gate) {
  const [from, to] = inspect.tail.split('..');
  return { kind: 'inspect', step: 'gate', seam: STEP_SEAM.gate, part: 'inspect',
    instruction: inspect.gateFailures?.length
      ? `Read the post-cap tail's diff (this argv). It holds gate amendments repairing: ${inspect.gateFailures.join('; ')}. Judge it against those gate failures and the findings of review ${inspect.anchor}: addresses-findings when every change repairs one of them and nothing else changes. Record { verdict: 'addresses-findings' | 'unrelated-change', tail: '${inspect.tail}', head: '${inspect.head}' }.`
      : `Read the post-cap tail's diff (this argv) against the findings of review ${inspect.anchor}; record { verdict: 'addresses-findings' | 'unrelated-change', tail: '${inspect.tail}', head: '${inspect.head}' }.`,
    command: ['git', '-C', wp.lane.worktree, 'diff', '--no-color', '--no-renames', from, to, '--', ...inspect.files],
    land: { tail: inspect.tail, head: inspect.head, review: inspect.review, findingsHash: inspect.findingsHash, gate: requeue(gate) },
    expects: { type: 'json', fields: ['verdict', 'tail', 'head'] } };
}

const validGate = (gate) => gate && typeof gate === 'object' && Array.isArray(gate.failures) && gate.failures.every((text) => typeof text === 'string')
  && (gate.causes === undefined || (Array.isArray(gate.causes) && gate.causes.every((cause) => typeof cause === 'string')));

// The gate record keeps `pendingSince`: set at the first pending result for a
// head, kept while that head stays pending or failed, cleared on a new head or ok.
function gateRecord(wp, gate, deps) {
  const same = wp.gate?.head && wp.gate.head === gate.head;
  const kept = same ? wp.gate.pendingSince ?? null : null;
  const pendingSince = gate.ok ? null : gate.pending ? kept ?? new Date(deps.now()).toISOString() : kept;
  return { ...gate, pendingSince };
}

// Failures are classified: infrastructure retries, lock contention re-acquires,
// limits hold, coverage gaps block, and only what a lane can fix is an amendment.
function recordGate(state, wp, action, r, deps) {
  if (action.part === 'inspect') {
    if (!INSPECTION.includes(r.verdict) || r.tail !== action.land.tail || r.head !== action.land.head) {
      return result('block', `the inspection must name ${action.land.tail} at ${action.land.head} with a verdict of ${INSPECTION.join(' or ')}`);
    }
    const { review, findingsHash: hash } = action.land;
    const inspections = [...(wp.inspections ?? []), { verdict: r.verdict, tail: r.tail, head: r.head, review, findingsHash: hash }];
    if (r.verdict !== 'addresses-findings') return result('held', `post-cap tail ${r.tail} does not address the findings`, { inspections });
    return result('continue', null, { inspections, queue: [action.land.gate, ...rest(wp, action)] });
  }
  const gate = parseJson(r.stdout);
  if (![0, 5, 6].includes(r.code) || !validGate(gate)) return result('block', `land gate output unreadable (exit ${r.code}): ${first(r.stderr) || first(r.stdout)}`);
  const recorded = { gate: gateRecord(wp, gate, deps) };
  if (r.code === 0) {
    return state.authority?.merge === true ? result('continue', null, { ...recorded, retries: 0 }) : result('held', 'gate passed; no merge authority', { ...recorded, retries: 0 });
  }
  if (r.code === 6) {
    const reason = (gate.pendingOn ?? ['ci']).map((on) => (on === 'review' ? 'a pipeline review of head is in flight' : 'CI is still running at head')).join('; ');
    return { ...result('wait', reason, { ...recorded, retries: 0, queue: [requeue(action), ...rest(wp, action)] }), waitMs: WAIT_MS };
  }
  const causes = new Set(gate.causes ?? []);
  const reason = gate.failures.join('; ');
  if (causes.has('infra')) {
    const retried = retry(wp, action, `infrastructure failure: ${reason}`);
    return { ...retried, patch: { ...retried.patch, ...recorded } };
  }
  const out = classifyGate(state, wp, action, gate, causes, reason, deps);
  return { ...out, patch: { retries: 0, ...recorded, ...out.patch } };
}

function classifyGate(state, wp, action, gate, causes, reason, deps) {
  if (gate.blocked || causes.has('pr-state') || causes.has('ci-missing-check')) return result('block', reason);
  if (causes.has('stale-base') && causes.has('head-mismatch')) return result('block', `stale base and head mismatch together: ${reason}`);
  if (causes.has('tail-out-of-bounds')) return result('held', reason);
  // Held for a ratify ruling: the build asks the conductor before it can end.
  if (causes.has('tail-outside-files')) return result('held', reason, { heldOutside: gate.outside ?? [] });
  // Held for a cite ruling: the conductor cites each uncited commit on the
  // fixed row it belongs to, and the inspection reads the tail again.
  if (causes.has('tail-uncited')) return gate.uncited?.length ? result('held', reason, { heldUncited: gate.uncited }) : result('block', reason);
  // A lane commit cannot repair coverage: the conductor dispatches a review
  // within the cap or holds the PR.
  if (causes.has('review-uncovered')) return result('block', reason);
  if (causes.has('lock') || causes.has('stale-base')) {
    const other = mergeLockFor(state, wp) === 'other';
    return { ...result(other ? 'wait' : 'continue', `re-acquire the lock and rebase: ${reason}`, { queue: rebaseActions(state, wp) }), ...(other ? { waitMs: WAIT_MS } : {}) };
  }
  if (causes.has('full-review')) {
    const review = fullReview(state, wp, deps);
    if (review.failure) return result('block', review.failure);
    return result('continue', reason, { ...(mergeLockFor(state, wp) === 'mine' ? { mergeLock: null } : {}), queue: review.queue });
  }
  if (causes.size === 1 && causes.has('inspect')) {
    if (!validInspect(gate.inspect)) return result('block', `the gate asked for an inspection with an unusable payload: ${JSON.stringify(gate.inspect)}`);
    return result('continue', reason, { queue: [inspectAction(state, wp, gate.inspect, action), ...rest(wp, action)] });
  }
  return result('amend', reason);
}

function landOutcome(state, wp, action, r, deps) {
  switch (action.step) {
    case 'review': return recordReview(state, wp, action, r);
    case 'post':
      if (r.code !== 0) return result('block', `post failed (exit ${r.code}): ${first(r.stderr)}`);
      return result('continue', null, { reviews: [...(wp.reviews ?? []), reviewEntry(wp, action.land, { findings: findingsCount(r) })] });
    case 'council': return recordCouncil(state, wp, action, r);
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
      // The squash landed even if the merge-commit lookup after it fails.
      if (action.part !== 'merge-commit') return result('continue', null, action.part === 'squash' ? { squashed: true } : {});
      const sha = parseJson(r.stdout)?.mergeCommit?.oid;
      return sha ? result('continue', null, { merge: { sha } }) : result('block', 'gh pr view printed no mergeCommit.oid');
    }
    case 'merged': {
      if (r.code === 0) {
        const inflightAtMerge = parseJson(r.stdout)?.inflightAtMerge;
        return inflightAtMerge ? result('done', `merged with a pipeline review of the head in flight: ${inflightAtMerge}`, { postMerge: { inflightAtMerge } }) : result('done');
      }
      const reason = parseJson(r.stdout)?.reason ?? `land merged exit ${r.code}: ${first(r.stderr) || first(r.stdout)}`;
      if (r.code === 5 && reason === TREE_MISMATCH) return result('block', reason, { dispatchHalt: { reason, since: new Date(deps.now()).toISOString() } });
      return result('block', reason);
    }
    default:
      throw new ConductError(2, `recordLandStep has no case for step ${action.step}`);
  }
}

// The one recorder for every landing action. Any amend, block or held between
// the rebase and merged, and merged itself, releases the lock its WP holds.
// A ConductError (an impossible lens selection, an unknown step) becomes
// `block`; only a programming error escapes. A terminal outcome leaves only
// the cleanup it owes queued.
export function recordLandStep(state, wp, action, r, deps = {}) {
  let out;
  try {
    out = landOutcome(state, wp, action, r ?? {}, deps);
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    out = result('block', error.message);
  }
  if (['amend', 'block', 'held', 'done'].includes(out.outcome)) {
    out.patch = { queue: [], ...out.patch };
    if (LOCKED_STEPS.has(action.step) && mergeLockFor(state, wp) === 'mine') out.patch.mergeLock = null;
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
  if (fetch.code === 0 && diff.code === 0) {
    // The gate waited for in-flight reviews, but one can be claimed between the
    // gate and the merge: name it, so its threads are read after the merge.
    const flight = deps.exec('node', [prReview(state), 'inflight', '--pr', String(wp.pr.number), '--repo', repoOf(state), '--head', head]);
    const inflightAtMerge = flight.code === 9 ? first(flight.stderr) : flight.code === 0 ? null : `not read (exit ${flight.code}): ${first(flight.stderr)}`;
    return { code: 0, out: { ok: true, head, mergeSha: flags.mergeSha, ...(inflightAtMerge ? { inflightAtMerge } : {}) } };
  }
  const reason = fetch.code === 0 && diff.code === 1 ? TREE_MISMATCH : `tree compare failed: ${first(fetch.code ? fetch.stderr : diff.stderr)}`;
  return { code: 5, out: { ok: false, head, mergeSha: flags.mergeSha, reason } };
}
