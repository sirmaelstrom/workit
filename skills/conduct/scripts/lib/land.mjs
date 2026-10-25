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
//   `inspect` action as { verdict, tail, head }, or for its `visual` part as
//   { head, frames, rules }; council tools as their JSON.
// - Patch: `mergeLock` and `dispatchHalt` are run-level; every other key is a
//   WP field, applied as given: `reviewMode`, `rebaseFrom`, `rebases`,
//   `threadIds`, `threadReplies`, `reviews`, `inspections`, `visualReads`, `councilStage`, `retries`, `gate`
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
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ConductError, STEP_SEAM, laneBase, loadState } from './state.mjs';
import { amendmentSections } from './markdown.mjs';
import { pinnedConfig } from './repo-config.mjs';
import { mergeDanger } from '../../../../scripts/lane.mjs';
import { reviewEscalation, patchPlace, REBASE_FILE_READ_CAP } from '../../../slim-review/scripts/pr-review-rounds.mjs';
import { AUTHOR_LENS, reviewPairFor } from '../../../slim-review/scripts/pr-review.mjs';
import { laneModel } from './adapters.mjs';
import { gateBootstrap } from './bootstrap.mjs';
import { mergeRefusal } from './authority.mjs';

const WAIT_MS = 60000;
const PENDING_BLOCK_MS = 30 * 60000;
const NO_CI_MS = 10 * 60000;
const MAX_RETRIES = 3;
const TAIL_LINE_CAP = 400;
const GREEN = new Set(['success', 'neutral', 'skipped']);
// Markdown that carries behavior is never a trivial tail (`trivialExclude` in
// the repo config replaces this list; contractPaths are always added).
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

/**
 * The PR's authoring model, as the writer's `claim --author` names it (quest
 * 2aadf72f). A claude lane is `claude`. A codex lane is read from the model it
 * ran (laneModel): an explicit gpt-*astra* or gpt-*terra* id names that
 * author, and every other codex model, the GPT-6.1 Sol default included, is `sol`.
 */
export function claimAuthor(agent, model) {
  if (agent !== 'codex') return agent;
  let resolved = '';
  try { resolved = laneModel(agent, model); } catch { resolved = ''; }
  if (/astra/i.test(resolved)) return 'astra';
  if (/terra/i.test(resolved)) return 'terra';
  return 'sol';
}
const authorModelOf = (state, wp) => claimAuthor(authorOf(state, wp), wp.model);

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

// Keep command and review gates explicit per repository. The run records the matched rule.
const GATE_PATHS = {
  'sirmaelstrom/workit': new Set([
    'scripts/lane.mjs',
    'skills/slim-review/scripts/pr-review.mjs',
    'skills/slim-review/scripts/pr-review-guard.mjs',
    'skills/slim-review/scripts/pr-review-rounds.mjs',
    'skills/slim-review/scripts/pr-review-recognise.mjs',
    'skills/slim-review/scripts/pr-review-outcomes.mjs',
    'skills/slim-review/scripts/pr-review-coordinator.mjs',
    'skills/conduct/scripts/lib/land.mjs',
    'skills/conduct/scripts/lib/phases/build.mjs',
  ]),
  'heathdev-me/observatory': new Set([
    'src/bridge/allowed-origins.ts',
    'src/bridge/routes/spine.ts',
    'src/bridge/spine-answer-provenance.ts',
    'src/bridge/routes/t3-answer-evidence.ts',
    'src/bridge/routes/t3-answer-queue.ts',
  ]),
};

function agentActionGateRule(path, hookCommands = [], { repo, settingsHooksChanged = false } = {}) {
  const p = norm(path).replace(/^\.\//, '').toLowerCase();
  if (p.endsWith('.md')) return null;
  if (repo === 'sirmaelstrom/claude-config') {
    if (p.startsWith('hooks/')) return 'claude-config-hooks';
    if ((p === 'settings.json' || p === '.claude/settings.json') && settingsHooksChanged) return 'hook-registration-settings';
  }
  if (hookCommands.some((command) => {
    const normalized = norm(command).toLowerCase();
    return normalized.split(/[\s"']+/).some((token) => token === p || token.endsWith(`/${p}`));
  })) return 'registered-hook';
  if (GATE_PATHS[repo]?.has(p)) return `${repo.split('/')[1]}-agent-gate`;
  return null;
}

export function isAgentActionGatePath(path, hookCommands = [], options = {}) {
  return agentActionGateRule(path, hookCommands, options) !== null;
}

// Raise only, to T2 on a contract path or an agent-action gate path. A test
// file does not raise to T2: the slim review's lenses report a test that
// cannot fail on its claimed defect, and the lane contract owes each test's
// negative control. It is executable code, though, so it floors a T0 at T1:
// reviewed, never landed unread. Keep the first matched path and rule for the
// run record.
export function tierDecision(wp, changedPaths = [], contractPaths = [], hookCommands = [], options = {}) {
  const contracts = contractPaths.map(globRegex);
  for (const path of changedPaths) {
    const rule = contracts.some((re) => re.test(norm(path))) ? 'contract-path'
      : agentActionGateRule(path, hookCommands, options);
    if (rule) return { tier: 'T2', rule, path };
  }
  const test = effectiveTier(wp) === 'T0' ? changedPaths.find(isTestPath) : undefined;
  if (test !== undefined) return { tier: 'T1', rule: 'test-path-floor', path: test };
  return { tier: effectiveTier(wp), rule: effectiveTier(wp) === 'T2' ? 'declared-t2' : 'no-match', path: null };
}

export function tierFor(wp, changedPaths = [], contractPaths = [], hookCommands = [], options = {}) {
  return tierDecision(wp, changedPaths, contractPaths, hookCommands, options).tier;
}

// Lens availability: opus iff claude is on; codex and astra iff codex is on.
// `author` is the authoring model (claimAuthor); a codex lane defaults to sol.
// Its pair is the writer's (reviewPairFor), so neither lens is the author.
export function pickReviewers(state, authorKind, { mode = 'standalone', author = claimAuthor(authorKind) } = {}) {
  const claude = state.agents?.claude?.on === true;
  const codex = state.agents?.codex?.on === true;
  const pair = reviewPairFor(author) ?? reviewPairFor('claude');
  // No claude CLI: the pair's codex-harness lens alone, never the author's.
  const withoutOpus = (where) => {
    const lens = pair.find((l) => l !== 'opus');
    return { lenses: [lens], singleLens: `${author}-authored PR${where} with no claude CLI: ${lens} is the only available lens that is not the author` };
  };
  if (mode === 'managed') {
    if (!codex) return { impossible: 'managed repo needs the codex CLI' };
    if (pair.includes('opus') && !claude) return withoutOpus(' on a managed repo');
    return { lenses: pair };
  }
  if (authorKind === 'codex' && claude && codex) return { lenses: pair };
  if (codex && authorKind === 'codex' && pair.includes('opus')) return withoutOpus('');
  if (codex) return { lenses: ['codex', 'astra'] };
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

export function reviewSteps(state, wp, mode, meta) {
  const pick = pickReviewers(state, authorOf(state, wp), { mode, author: authorModelOf(state, wp) });
  if (pick.impossible) throw new ConductError(5, `${wp.id}: review impossible: ${pick.impossible}`);
  // The no-council T2 fallback runs every available lens but the author's own
  // (workit#240 review, codex P2): reviewer ≠ author holds at every tier.
  const authorLens = AUTHOR_LENS[authorModelOf(state, wp)] ?? null;
  // When the author's lens is the only one available, pickReviewers' single
  // lens (flagged sameFamily) stands, as at T1.
  const others = availableLenses(state).filter((lens) => lens !== authorLens);
  const lenses = meta.all && mode === 'standalone' && others.length > 0 ? others : pick.lenses;
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
    // The writer's claim needs the authoring model (reviewer ≠ author, quest
    // 2aadf72f); it answers the same pair pickReviewers chose.
    actions.push(shell('review', 'claim', ['node', script, 'claim', '--pr', pr, '--repo', repo, '--attempt-ref-out', ref,
      '--author', authorModelOf(state, wp),
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

// One delta pass from an ancestor. A reset may supply a baseline it verified
// after a rebase; an unverified pre-rebase head still requires a full review.
export function deltaReviewActions(state, wp, sinceHead, { report = null, changedPaths = [] } = {}) {
  const recovery = wp.deltaRecovery;
  const latest = (wp.reviews ?? []).at(-1);
  const verified = latest?.scope === 'full' && recovery?.reviewedHead === latest.head
    && recovery?.baseline === sinceHead && recovery?.head === wp.pr.head;
  if (!verified && (wp.rebases ?? []).some((rebase) => rebase.from !== rebase.to)) {
    throw new ConductError(2, `${wp.id}: no delta review after a rebase (${sinceHead.slice(0, 7)} is not an ancestor of the rebased head); a full review is owed`);
  }
  const round = latestRound(wp) + 1;
  if (state.adapters?.council?.on && effectiveTier(wp) === 'T2') return t2Actions(state, wp, { round, changedPaths, report, scope: 'delta', since: sinceHead });
  return reviewActions(state, wp, { round, report, since: sinceHead });
}

// /conduct's own council roster: the shared `code` profile minus
// sonnet-5-carto (quest 37676efe; RC-3's yield audit: 21 unique carto findings
// gave 8 fixes, 7 refuted, 6 judgment and one fixed A-class item). The profile
// is config-owned in the review-council's models.json, like `code`; a server
// without it refuses the call by name ("Unknown profile").
export const CONDUCT_COUNCIL_PROFILE = 'conduct-code';

// The file a council round's adjudication is handed to the next round in
// (quest 37676efe: 5 of RC-3's round-2 findings repeated round-1 rulings).
// Written at `resolve` beside the round's pr-record.md, and framed for a
// reviewer rather than for the PR.
export const PRIOR_ADJUDICATION_FILE = 'adjudication-for-next-round.md';

export function priorAdjudicationBody(recordBody) {
  return [
    '# Prior round: findings already adjudicated (context, not under review)',
    '',
    'The lane ruled on each finding below in the previous council round. Do not raise one again unless this round\'s change touches the code it cites, or the Evidence cell is wrong; then say which, and quote the line.',
    '',
    recordBody,
  ].join('\n');
}

// A Codex seat refuses a turn over 1,048,576 characters, and the prompt
// template rides on top of the artifacts. A round's artifacts, full or delta,
// stay under the budget: the diff first, then whole non-test files that fit.
export const CODEX_INPUT_LIMIT = 1048576;
export const COUNCIL_INPUT_BUDGET = 700000;

// The council round's scope comes from its dispatch, never the round number.
// A delta round first writes `git diff <since> <head>` into the run dir and
// hands that file to the council, so the scope reaches the tool's input. A
// full round writes the PR's whole diff the same way. Either diff's record
// (councilFit) then sets the review's artifact_paths under COUNCIL_INPUT_BUDGET.
// From round 2 on, the previous round's adjudication (wp.priorAdjudication =
// { path, round }, set at `resolve`) goes in too, as context only.
export function t2Actions(state, wp, { round = 1, changedPaths = [], report = null, scope = 'full', since = null } = {}) {
  if (!state.adapters?.council?.on) return reviewActions(state, wp, { round, report, all: true, since: scope === 'delta' ? since : null });
  // A delta's `since` goes into git's argv: only a commit sha, after --end-of-options.
  if (scope === 'delta' && !/^[0-9a-f]{7,40}$/i.test(since ?? '')) throw new ConductError(2, `${wp.id}: a council delta needs a commit sha to diff from, not ${JSON.stringify(since)}`);
  const workshop = `${join(state.runDir, 'council', lower(wp))}${sep}`;
  const outDir = `${join(state.runDir, 'council', lower(wp), `review-${round}`)}${sep}`;
  const deltaDiff = scope === 'delta' ? join(state.runDir, 'council', lower(wp), `delta-r${round}.diff`) : null;
  // Beside the delta diff: git does not create the round's output dir.
  const fullDiff = scope === 'full' ? join(state.runDir, 'council', lower(wp), `full-r${round}.diff`) : null;
  // Only the immediately preceding round's rulings: a zero-finding round writes
  // no adjudication, so an older file would arrive labelled as the previous
  // round's (council review of #242, codex's three-round reproduction).
  const recorded = wp.priorAdjudication;
  const prior = round > 1 && recorded?.path && recorded.round === round - 1 ? [recorded.path] : [];
  const land = { round, scope, since, deltaDiff, ...(fullDiff ? { fullDiff } : {}), prior: prior[0] ?? null };
  const tool = (part, name, args, extra = {}) => ({ kind: 'agent-tool', step: 'council', seam: STEP_SEAM.council, part, tool: name,
    instruction: `Call ${name} with these args and record its result.`, args, expects: { type: 'json' }, land, ...extra });
  return [
    ...(deltaDiff ? [shell('council', 'delta-diff', ['git', '-C', wp.lane.worktree, 'diff', '--no-color', `--output=${deltaDiff}`, '--end-of-options', since, wp.pr.head], { land })] : []),
    ...(fullDiff ? [shell('council', 'full-diff', ['git', '-C', wp.lane.worktree, 'diff', '--no-color', '--no-renames', '-U25', `--output=${fullDiff}`, `origin/${defaultOf(state)}...HEAD`], { land })] : []),
    // The paths are candidates until the diff's record fits them.
    tool('review', 'council_review', { workshop_path: workshop, output_dir: outDir, surface: 'code', code_root: wp.lane.worktree,
      artifact_paths: [...prior, ...(deltaDiff ? [deltaDiff] : []), ...(fullDiff ? [fullDiff] : []), ...changedPaths], round, profile: CONDUCT_COUNCIL_PROFILE }),
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
// with it, compose tables numbered `since` or later by finding id; with
// `only`, the table of that one section. A later ruling replaces only its own
// row; an earlier round never answers this one.
// A table quoted inside a code fence is never the table.
export function parseAmendmentTable(reportText, { since = null, only = null } = {}) {
  const headerAt = (section) => section.lines.findIndex((line) => !line.fenced && TABLE_HEADER.test(line.text.trim()));
  const sections = amendmentSections(reportText);
  const candidates = only !== null ? sections.filter((section) => section.n === only)
    : since === null ? sections.slice(-1) : sections.filter((section) => section.n >= since && headerAt(section) >= 0);
  const body = [];
  for (const section of candidates) {
   const header = headerAt(section);
   if (header < 0) continue;
   const rows = [];
   for (const { text: line, fenced } of section.lines.slice(header + 1)) {
    if (fenced || !line.trim().startsWith('|')) break;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
    const [comment, verdict, evidence, commit] = splitRow(line);
    rows.push({ comment, verdict: String(verdict ?? '').toLowerCase(), evidence: evidence ?? '', commit: rowCommits(commit)?.join(',') ?? null });
   }
   // Replace earlier answers by finding id, but preserve duplicates within
   // one table so the adjudication validator can reject ambiguity.
   const ids = new Set(rows.map((row) => String(row.comment).replace(/^#/, '')));
   for (let i = body.length - 1; i >= 0; i--) if (ids.has(String(body[i].comment).replace(/^#/, ''))) body.splice(i, 1);
   body.push(...rows);
  }
  return body;
}

// A row's id: a PR comment databaseId (`#` stripped), or a council id; anything else is refused.
function commentId(raw) {
  const id = String(raw ?? '').trim().replace(/^#(?=\d+$)/, '');
  if (/^\d+$/.test(id) || /^C\d+-\d+$/.test(id)) return id;
  throw new ConductError(2, `comment id ${JSON.stringify(raw)} is neither a PR comment id nor a council id C<round>-<n>`);
}

function adjudicationRows(verdicts) {
  return verdicts.map((row) => {
    const comment = commentId(row.comment);
    if (!VERDICTS.includes(row.verdict)) throw new ConductError(2, `comment ${comment}: verdict must be one of ${VERDICTS.join(', ')} (got ${row.verdict})`);
    if (row.verdict === 'fixed' && !rowCommits(row.commit)) throw new ConductError(2, `comment ${comment}: a fixed row needs its commit sha (several are comma-separated)`);
    return { comment, verdict: row.verdict, evidence: row.evidence ?? '', commit: row.commit ?? null, ...(row.adjudicator ? { adjudicator: row.adjudicator } : {}) };
  });
}

// One reply body per PR-comment row, then one reply each. Council ids have no
// PR thread; conductor rows go to a ruling first.
function replyActions(state, wp, rows) {
  const replyRows = rows.filter((row) => /^\d+$/.test(row.comment) && row.verdict !== 'conductor');
  const replies = join(reviewsDir(state, wp), 'replies');
  const body = (row) => join(replies, `${row.comment}.md`);
  return replyRows.length === 0 ? [] : [
    { kind: 'author', step: 'reply', seam: STEP_SEAM.reply, part: 'bodies', instruction: 'Write one reply body per file: the verdict and its evidence, quoted from the lane\'s amendment row.',
      outPath: replies, files: replyRows.map((row) => ({ path: body(row), ...row })), expects: { type: 'file' } },
    ...replyRows.map((row) => shell('reply', 'reply', ['node', prReview(state), 'reply', '--pr', String(wp.pr.number), '--repo', repoOf(state),
      '--comment-id', row.comment, '--body-file', body(row), '--verdict', REPLY_VERDICT[row.verdict], '--adjudicator', row.adjudicator ?? 'lane',
      '--measure-log', join(state.runDir, 't1.jsonl')], { land: { comment: row.comment, answer: answerKey(row) } })),
  ];
}

// What a reply says: its verdict, evidence and commit. A thread is replied to
// again only when its answer changes.
const answerKey = (row) => createHash('sha256').update(JSON.stringify([row.verdict, row.evidence ?? '', row.commit ?? null])).digest('hex');

export function recordAdjudication(state, wp, verdicts) {
  const reviews = wp.reviews ?? [];
  if (!reviews.length) throw new ConductError(2, `${wp.id} has no review to adjudicate`);
  const rows = adjudicationRows(verdicts);
  const replaced = new Set(rows.map((row) => row.comment));
  const latest = { ...reviews.at(-1), verdicts: [...(reviews.at(-1).verdicts ?? []).filter((row) => !replaced.has(row.comment)), ...rows] };
  return { patch: { reviews: [...reviews.slice(0, -1), latest] }, actions: replyActions(state, wp, rows), conductorRows: rows.filter((row) => row.verdict === 'conductor') };
}

// A gate amendment's table answers the threads its gate listed (`threads`, by
// first comment id): each answered row is replied to as an adjudication's is,
// then its thread is resolved. Only the listed threads' rows are read and
// validated; a thread answered twice is refused. A row for an id the gate did
// not list, and a conductor row, is left alone, so its thread stays open and
// the gate stops on it again. A thread whose posted reply (`wp.threadReplies`)
// carried the same answer is resolved without a second reply. The review's
// verdicts are not touched.
export function threadReplyActions(state, wp, verdicts, threads) {
  const listed = new Set(threads.map(String));
  const id = (row) => String(row.comment ?? '').trim().replace(/^#/, '');
  const mine = verdicts.filter((row) => listed.has(id(row)));
  const twice = [...new Set(mine.map(id).filter((comment, i, all) => all.indexOf(comment) !== i))];
  if (twice.length) throw new ConductError(2, `the ## Amendment table lists ${twice.join(', ')} more than once`);
  const rows = adjudicationRows(mine).filter((row) => row.verdict !== 'conductor');
  const posted = wp.threadReplies ?? {};
  return { rows, actions: rows.length ? [...replyActions(state, wp, rows.filter((row) => posted[row.comment] !== answerKey(row))), ...resolveThreadActions(state, wp, rows.map((row) => row.comment))] : [] };
}

// A council round leaves no thread on the PR, so its adjudication is posted as
// one COMMENT review: every finding's id, the lane's verdict, commit and
// Evidence cell, verbatim. Null for a round with no council rows. The body is
// a file beside the round's synthesis, read by `gh api -F body=@<file>`.
export function councilRecord(state, wp, rows) {
  const review = (wp.reviews ?? []).at(-1);
  const council = rows.filter((row) => /^C\d+-\d+$/i.test(String(row.comment).trim()));
  if ((!council.length && !review?.escalatedDeltaReviewId) || !review?.reviewId || !wp.pr?.number) return null;
  const cell = (text) => String(text ?? '').replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();
  const body = [
    `**Council review record**: \`/conduct\` run \`${state.slug}\`, ${wp.id}, round ${review.round}${review.scope === 'delta' ? ' (delta)' : ''}${review.lenses?.length ? `, seats ${review.lenses.join(', ')}` : ''}.`,
    `${council.length} finding(s), with the lane's verdicts from its report's \`## Amendment\` table. \`judgment\` rows are left for the operator.`,
    '',
    '| Finding | Verdict | Commit | Evidence |',
    '|---|---|---|---|',
    ...council.map((row) => `| ${cell(row.comment)} | ${cell(row.verdict)} | ${row.commit ? `\`${cell(row.commit)}\`` : '—'} | ${cell(row.evidence) || '—'} |`),
    '',
    ...(review.escalatedDeltaReviewId ? [`<!-- workit-council-round: ${JSON.stringify({ id: `${state.slug}/${wp.id.toLowerCase()}/${review.round}`, delta_review_id: review.escalatedDeltaReviewId, head: review.head })} -->`] : []),
  ].join('\n');
  const path = join(review.reviewId, 'pr-record.md');
  const action = shell('reply', 'record', ['gh', 'api', '--method', 'POST', `repos/${repoOf(state)}/pulls/${wp.pr.number}/reviews`, '-f', 'event=COMMENT', '-f', `commit_id=${review.head}`, '-F', `body=@${path}`],
    { instruction: 'Post the council round\'s adjudication as a PR review (the run\'s review record). Record { code, stdout, stderr }.' });
  return { path, body, action };
}

// One lookup maps comment ids to thread node ids; its record queues the resolves.
export function resolveThreadActions(state, wp, commentIds) {
  const [owner, name] = repoOf(state).split('/');
  return [shell('thread-ids', 'lookup', ['gh', 'api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${wp.pr.number}`],
    { expects: { type: 'json' }, land: { commentIds: commentIds.map(String) } })];
}

export function resolveAction(threadId) {
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
// gate waits for that review. Every step names the branch, never HEAD: a
// worktree left detached (a review lens's `gh pr checkout --detach`) would
// otherwise rebase the detached HEAD and push an unmoved branch. `rebase <base>
// <branch>` checks the branch out first.
export function rebaseActions(state, wp) {
  if (mergeLockFor(state, wp) === 'other') return [waitAction('rebase', 'yield', `Wait: ${state.mergeLock.wpId} holds the merge lock.`)];
  const git = (part, ...args) => shell('rebase', part, ['git', '-C', wp.lane.worktree, ...args]);
  const base = `origin/${defaultOf(state)}`;
  const ref = `refs/heads/${wp.lane.branch}`;
  return [
    git('fetch', 'fetch', 'origin'),
    shell('rebase', 'ready', ['gh', 'pr', 'ready', String(wp.pr.number), '--repo', repoOf(state)]),
    git('pre-head', 'rev-parse', ref),
    git('rebase', 'rebase', base, wp.lane.branch),
    git('post-heads', 'rev-parse', ref, base),
    git('push', 'push', `--force-with-lease=${wp.lane.branch}:${wp.pr.head}`, 'origin', wp.lane.branch),
    waitAction('rebase', 'ci-wait', 'Wait for CI at the pushed head; the land gate action answers it.'),
  ];
}

// A gate amendment for a rebase conflict has the lane rebase by hand. A fix
// saved before the flag is known by the reason its abort gave.
const isRebaseFix = (fix) => fix?.rebase === true || /^rebase onto \S+ conflicted:/.test(fix?.reason ?? '');

// The lane check after that amendment maps the head it pushed from the head the
// amendment started at, as the land rebase maps its own: from git, never the
// lane's report. `lane-base` reads the base the lane rebased onto.
export function laneRebaseActions(state, wp) {
  const fix = (wp.gateFixes ?? []).at(-1);
  const from = fix?.from, to = wp.pr?.head;
  if (!isRebaseFix(fix) || fix.to || !from || !to || from === to) return [];
  if ((wp.rebases ?? []).some((rebase) => rebase.from === from && rebase.to === to)) return [];
  return [shell('rebase', 'lane-base', ['git', '-C', wp.lane.worktree, 'merge-base', '--end-of-options', to, `origin/${defaultOf(state)}`], { land: { from, to } })];
}

// A whitespace-preserving id of the WP's diff, from output git does not
// colour or transform. An empty id for a non-empty diff is unreadable (null).
function patchId(wt, a, b, exec) {
  const diff = exec('git', ['-C', wt, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', a, b]);
  if (diff.code !== 0) return { id: null, diff: null };
  if (diff.stdout === '') return { id: '', diff: '' };
  const id = exec('git', ['-C', wt, 'patch-id', '--verbatim'], { input: diff.stdout });
  const value = id.code === 0 ? id.stdout.trim().split(/\s+/)[0] ?? '' : '';
  return { id: value === '' ? null : value, diff: diff.stdout };
}

function measureRebase(wt, { from, to, oldBase, newBase }, exec) {
  const before = patchId(wt, oldBase, from, exec), after = patchId(wt, newBase, to, exec);
  const ids = { from: before.id, to: after.id };
  let placeHash = null;
  if (ids.from !== null && ids.from === ids.to) {
    if (before.diff === '' && after.diff === '') placeHash = createHash('sha256').update('').digest('hex');
    else if (/^diff --git /m.test(before.diff ?? '') && /^diff --git /m.test(after.diff ?? '')) {
      const files = new Map();
      const read = (path, ref) => {
        const key = `${ref}:${path}`;
        if (!files.has(key)) {
          if (files.size >= REBASE_FILE_READ_CAP) throw new ConductError(5, 'rebase mapping file-read cap');
          const result = exec('git', ['-C', wt, 'show', key]);
          if (result.code !== 0) throw new ConductError(5, 'rebase mapping parent file unreadable');
          files.set(key, result.stdout);
        }
        return files.get(key);
      };
      try {
        const oldPlace = patchPlace(before.diff, oldBase, read), newPlace = patchPlace(after.diff, newBase, read);
        if (oldPlace !== null && oldPlace === newPlace) placeHash = createHash('sha256').update(oldPlace).digest('hex');
      } catch { /* Missing/ambiguous parent evidence requires a full review. */ }
    }
  }
  return { from, to, oldBase, newBase, patchIds: ids, equivalent: from === to || placeHash !== null,
    ...(placeHash ? { equivalenceProof: { version: 1, from, to, oldBase, newBase, placeHash } } : {}) };
}

// Each commit of a range by its own patch-id (`git log -p` read by `git
// patch-id`, as for the whole diff). A patch two commits share names neither;
// null is an unreadable range.
function commitPatchIds(wt, range, exec) {
  const log = exec('git', ['-C', wt, 'log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--format=commit %H', range]);
  if (log.code !== 0) return null;
  if (!log.stdout.trim()) return new Map();
  const ids = exec('git', ['-C', wt, 'patch-id', '--verbatim'], { input: log.stdout });
  if (ids.code !== 0) return null;
  const byId = new Map();
  for (const [id, sha] of lines(ids.stdout).map((line) => line.split(/\s+/))) byId.set(id, byId.has(id) ? null : sha?.toLowerCase());
  return byId;
}

// The rebase's image of each commit it moved: the commit on the new line with
// the same patch-id. An image locates a commit; it proves no coverage.
function rebaseImages(wt, { from, to, oldBase, newBase }, exec) {
  const before = commitPatchIds(wt, `${oldBase}..${from}`, exec);
  const after = commitPatchIds(wt, `${newBase}..${to}`, exec);
  if (!before || !after) return {};
  const images = {};
  for (const [id, sha] of before) if (sha && after.get(id)) images[sha] = after.get(id);
  return images;
}

// Patch identity alone does not preserve coverage when parent files changed.
// A rebase that moves commits also records their images, and measures each
// review head it moved below its own head at that head's image (`anchors`), so
// coverage and citations cross it from a reviewed head later amendments buried.
export function recordRebase(state, wp, { from, to, newBase }, deps) {
  const oldBase = laneBase(wp);
  const wt = wp.lane.worktree;
  const entry = measureRebase(wt, { from, to, oldBase, newBase }, deps.exec);
  if (from === to) return entry;
  const images = rebaseImages(wt, { from, to, oldBase, newBase }, deps.exec);
  if (!Object.keys(images).length) return entry;
  // A head an earlier rebase moved is looked up at that rebase's image of it.
  const heads = [...new Set((wp.reviews ?? []).filter((review) => review.head).map((review) => imageOf(wp, review.head)))].filter((head) => images[head] && head !== from);
  const anchors = heads.map((head) => measureRebase(wt, { from: head, to: images[head], oldBase, newBase }, deps.exec));
  return { ...entry, images, ...(anchors.length ? { anchors } : {}) };
}

// A commit's image after every later rebase (itself when none moved it).
function imageOf(wp, sha) {
  let at = String(sha).toLowerCase();
  for (const rebase of wp.rebases ?? []) at = rebase.images?.[at] ?? at;
  return at;
}

// Commits (full shas or the abbreviations a Commit cell holds) and their
// images: a row that names a commit names its rebased image too.
function carried(wp, shas) {
  const known = new Set(shas.map((sha) => String(sha).toLowerCase()));
  for (const rebase of wp.rebases ?? []) {
    for (const [old, image] of Object.entries(rebase.images ?? {})) if ([...known].some((sha) => old.startsWith(sha))) known.add(image);
  }
  return [...known];
}

function verifiedRebase(wp, rebase, exec) {
  if (rebase.from === rebase.to) return { ...rebase, equivalent: true };
  if (!rebase.equivalent) return rebase;
  const proof = rebase.equivalenceProof;
  if (proof?.version === 1 && /^[0-9a-f]{64}$/.test(proof.placeHash ?? '')
    && ['from', 'to', 'oldBase', 'newBase'].every((key) => proof[key] === rebase[key])) return rebase;
  if (!rebase.oldBase || !rebase.newBase) return { ...rebase, equivalent: false };
  // Old runs have only a patch-id receipt. Re-prove its immutable Git objects
  // before carrying coverage through it; never silently upgrade the receipt.
  return measureRebase(wp.lane.worktree, rebase, exec);
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

// The events whose workflow runs a PR head gets: its own pull_request runs,
// and push runs from pushes to its branch. A pull_request_target run checks
// the base branch's commit, so the head does not carry it. A push workflow
// filtered to the default branch still reads as expected: the run's event
// does not show its branch filter.
const PR_EVENTS = new Set(['pull_request', 'push']);

// What triggered each workflow run at one sha, by check-suite id, every page
// read and complete. No access to the Actions API (403, 404) reads as no runs,
// so every check stays expected.
function readTriggers(state, sha, exec) {
  const read = exec('gh', ['api', `repos/${repoOf(state)}/actions/runs?head_sha=${sha}&per_page=100`, '--paginate']);
  if (read.code !== 0) return /HTTP 40[34]/.test(read.stderr) ? { events: new Map() } : { failure: `workflow runs unreadable: ${first(read.stderr)}` };
  let pages;
  try {
    pages = parsePages(read.stdout);
  } catch (error) {
    return { failure: `workflow runs unreadable: ${error.message}` };
  }
  const runOk = (run) => run && run.id != null && run.check_suite_id != null && typeof run.event === 'string';
  if (!pages.length || pages.some((page) => typeof page?.total_count !== 'number' || !Array.isArray(page.workflow_runs) || !page.workflow_runs.every(runOk))) {
    return { failure: 'workflow runs unreadable: a page is malformed' };
  }
  const runs = pages.flatMap((page) => page.workflow_runs);
  if (runs.length !== pages[0].total_count || new Set(runs.map((run) => run.id)).size !== runs.length) {
    return { failure: `workflow runs incomplete: ${runs.length} distinct runs read of total_count ${pages[0].total_count}` };
  }
  return { events: new Map(runs.map((run) => [run.check_suite_id, run.event])) };
}

// The checks the head must carry: the branch's required status checks (the
// union of `contexts` and `checks`) when readable, else the names that ran on
// the base commit from a trigger a PR head also gets. A check-run that no
// workflow run accounts for (another app, a legacy status) stays expected.
function expectedChecks(state, wt, exec, wp, head) {
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
  // Explicit migration policy is scoped to one WP/head. It cannot suppress
  // any failed check, and never overrides readable branch protection.
  if (wp.ciCheckPolicy?.head === head && wp.ciCheckPolicy.names?.length) return { names: wp.ciCheckPolicy.names };
  const base = exec('git', ['-C', wt, 'rev-parse', `origin/${def}`]);
  if (base.code !== 0) return { failure: `base commit unreadable: ${first(base.stderr)}` };
  const ran = readRuns(state, base.stdout.trim(), exec);
  if (ran.failure) return ran;
  const triggers = readTriggers(state, base.stdout.trim(), exec);
  if (triggers.failure) return triggers;
  const prTriggered = (run) => {
    const event = triggers.events.get(run.check_suite?.id);
    return event === undefined || PR_EVENTS.has(event);
  };
  return { names: [...new Set((ran.runs ?? []).filter(prTriggered).map((run) => run.name))] };
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
  const expected = expectedChecks(state, wp.lane.worktree, exec, wp, head);
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

// The repo config as the run pinned it, so a PR cannot widen its own trivial
// set: the workspace config's intake snapshot (its sha256 is on touch 1), else
// the legacy .workit/conduct.json on the base branch.
function notTrivialPatterns(state, wt, exec) {
  const pinned = pinnedConfig(state);
  if (pinned) return { patterns: notTrivialGlobs(pinned).map(globRegex) };
  const shown = exec('git', ['-C', wt, 'show', `origin/${defaultOf(state)}:.workit/conduct.json`]);
  let config = {};
  if (shown.code === 0) {
    config = parseJson(shown.stdout);
    if (!config || typeof config !== 'object') return { failure: 'repo config .workit/conduct.json on the base is not valid JSON' };
  } else if (!/does not exist|exists on disk, but not in/.test(shown.stderr)) {
    return { failure: `repo config unreadable: ${first(shown.stderr)}` };
  }
  return { patterns: notTrivialGlobs(config).map(globRegex) };
}

const notTrivialGlobs = (config) => [...(Array.isArray(config.trivialExclude) ? config.trivialExclude : DEFAULT_NOT_TRIVIAL), ...(config.contractPaths ?? [])];

function ancestor(wt, a, b, exec) {
  const code = exec('git', ['-C', wt, 'merge-base', '--is-ancestor', a, b]).code;
  return code === 0 ? true : code === 1 ? false : null;
}

const fixedCommits = (review) => (review.verdicts ?? [])
  .filter((row) => row.verdict === 'fixed').flatMap((row) => (rowCommits(row.commit) ?? []).map((commit) => commit.toLowerCase()));

// The commits gate amendments added after the review cap: each gate amendment
// records the head it started from (build.mjs gateAmend) and, once its lane
// work is back, the head it ended at; its commits are from..end (end = `to`
// while it is still open). The range is read on the line the tail is on: as
// recorded, else at the images a later rebase made of its ends (a tail mapped
// back before that rebase is still on the recorded line). A range on neither
// line to `to` names nothing. A commit the conductor cited on one of the
// amendment's rows (`cited`) is one of its commits too. Returns the commits
// and the gate failures they repair; null is an unreadable range.
function gateFixCommits(wp, to, exec) {
  const wt = wp.lane.worktree;
  const commits = new Set();
  const reasons = [];
  for (const fix of wp.gateFixes ?? []) {
    const shas = carried(wp, fix?.cited ?? []);
    const recorded = [fix?.from ?? null, fix?.to ?? to];
    const imaged = [fix?.from ? imageOf(wp, fix.from) : null, fix?.to ? imageOf(wp, fix.to) : to];
    const ranges = recorded[0] === imaged[0] && recorded[1] === imaged[1] ? [recorded] : [recorded, imaged];
    for (const [from, end] of ranges) {
      if (!from || from === end) continue;
      const fromOnLine = ancestor(wt, from, end, exec);
      const endOnLine = end === to ? true : ancestor(wt, end, to, exec);
      if (fromOnLine === null || endOnLine === null) return null;
      if (!fromOnLine || !endOnLine) continue;
      const listed = exec('git', ['-C', wt, 'rev-list', `${from}..${end}`]);
      if (listed.code !== 0) return null;
      shas.push(...lines(listed.stdout).map((sha) => sha.toLowerCase()));
      break;
    }
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
  const fixed = carried(wp, fixedCommits(anchor));
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
  if (effectiveTier(wp) === 'T0') return { tail: `${laneBase(wp)}..${head} (T0)` };
  const anchor = (wp.reviews ?? []).at(-1);
  if (!anchor) return { failure: 'no review of this WP', cause: 'review-uncovered' };
  const rebases = (wp.rebases ?? []).map((rebase) => verifiedRebase(wp, rebase, exec));
  if (rebases.filter((rebase) => !rebase.equivalent).length >= 2) return { failure: 'a second rebase changed the WP\'s diff: held for the operator', cause: 'tail-out-of-bounds' };
  if (anchor.head === head) return {};
  const changed = { failure: 'rebase changed the WP\'s diff: full review of the rebased head', cause: 'full-review', needsFullReview: true };
  // Forward from the anchor, a rebase also carries the review heads it moved
  // below its own head; they are not counted as a second rebase.
  const moves = (wp.rebases ?? []).flatMap((rebase, i) => [...(rebase.anchors ?? []).map((entry) => verifiedRebase(wp, entry, exec)), rebases[i]]);
  let after = anchor.head;
  for (const rebase of moves) {
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
  // A WP's PR body declares its door (`## Merge danger`); the release PR is the
  // run's own and carries none.
  const release = wp.id === 'release';
  const view = exec('gh', ['pr', 'view', String(wp.pr.number), '--repo', repoOf(state), '--json', release ? 'headRefOid,baseRefName,state' : 'headRefOid,baseRefName,state,body']);
  const pr = view.code === 0 ? parseJson(view.stdout) : null;
  const danger = release || !pr?.headRefOid ? null : mergeDanger(typeof pr.body === 'string' ? pr.body : '');
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
  // The open threads by first comment id, as the listing prints them: a gate amendment answers them by these ids.
  const open = threads.code === 8 ? [...String(threads.stdout ?? '').matchAll(/^#(\d+)\s/gm)].map((m) => m[1]) : [];
  if (threads.code === 8) fail('unresolved review threads', 'threads');
  else if (threads.code !== 0) fail(`threads unreadable (exit ${threads.code}): ${first(threads.stderr)}`, 'infra');
  // (2a) the greenfield bootstrap WP: the manifest check on its worktree (quest 977d3efb).
  const boot = gateBootstrap(state, wp, exec);
  if (boot) fail(boot.failure, boot.cause);
  const config = notTrivialPatterns(state, wt, exec);
  if (config.failure) fail(config.failure, 'infra');
  const review = head ? reviewCondition(wp, head, exec, config.patterns ?? DEFAULT_NOT_TRIVIAL.map(globRegex)) : { failure: 'review coverage not read: no head', cause: 'infra' };
  if (review.failure) fail(review.failure, review.cause);
  const council = councilObligation(state, wp, exec);
  if (council) fail(council, 't2-council');
  const pendingOn = [...(ci.pending ? ['ci'] : []), ...(flight.pending ? ['review'] : [])];
  const ok = failures.length === 0 && pendingOn.length === 0;
  return {
    ok, pending: !ok && failures.length === 0, pendingOn, blocked: ci.blocked === true || flight.blocked === true, head, failures, causes: [...causes],
    unreviewedTail: review.tail ?? null, needsFullReview: review.needsFullReview === true, staleBase: causes.has('stale-base'),
    ...(danger ? { door: danger.door, doorProblems: danger.problems } : {}),
    ...(open.length ? { threads: open } : {}),
    ...(review.inspect ? { inspect: review.inspect } : {}),
    ...(review.outside ? { outside: review.outside } : {}),
    ...(review.uncited ? { uncited: review.uncited } : {}),
  };
}

// A T1 delta with two or more distinct majors, or a T1 full review with a P1
// or two distinct P2s, escalates the WP to a T2 council round, which the gate
// then requires. A run without the council adapter has no council to escalate
// to: the review's findings are amended at T1 like any others, its review
// entry says why (`escalation`), and nothing is owed.
export const councilOn = (state) => Boolean(state.adapters?.council?.on);
const NO_COUNCIL = 'not escalated: no council adapter in this run';

// A recorded review entry as `reviewEscalation` reads a posted review.
export const reviewCrosses = (review) => Boolean(reviewEscalation({ scope: review.scope, majorFindings: review.majorFindings,
  p1Findings: review.p1Findings, p2Findings: review.p2Findings, review_id: review.reviewId }));

function councilObligation(state, wp, exec) {
  if (!councilOn(state)) return null;
  const reviews = wp.reviews ?? [];
  const deltas = reviews.filter((review) => review.tier === 'T1' && reviewCrosses(review));
  if (wp.deltaEscalation && !deltas.some((review) => review.head === wp.deltaEscalation.head)) {
    deltas.push({ ...wp.deltaEscalation, scope: wp.deltaEscalation.scope ?? 'delta', tier: 'T1' });
  }
  for (const delta of deltas) {
    const recorded = reviews.some((review) => {
      if (review.tier !== 'T2' || review.scope !== 'full' || !review.reviewId || !review.record?.url) return false;
      if (review.escalatedDeltaReviewId && delta.reviewId && String(review.escalatedDeltaReviewId) !== String(delta.reviewId)) return false;
      if (review.head === delta.head) return true;
      if (!exec) return review.escalatedDeltaReviewId != null && String(review.escalatedDeltaReviewId) === String(delta.reviewId);
      return exec('git', ['-C', wp.lane.worktree, 'merge-base', '--is-ancestor', delta.head, review.head]).code === 0;
    });
    if (!recorded) return `${delta.scope} review ${delta.reviewId ?? delta.round ?? '?'} on ${delta.head} requires a recorded T2 council round on that head or later`;
  }
  return null;
}

// `authority` is the run's authority (lib/authority.mjs runAuthority).
export function mergeActions(state, wp, head, authority) {
  if (!authority) throw new ConductError(2, 'authority not passed');
  if (mergeRefusal(state, authority) || mergeLockFor(state, wp) !== 'mine') return [];
  if (councilObligation(state, wp, null)) return [];
  // The door again, at the merge itself: a gate record from before the door
  // check (a run resumed across an upgrade) carries none.
  if (wp.id !== 'release' && wp.gate?.door !== 'two-way') return [];
  const pr = String(wp.pr.number);
  return [
    shell('merge', 'squash', ['gh', 'pr', 'merge', pr, '--repo', repoOf(state), '--squash', '--match-head-commit', head,
      ...(wp.commit ? ['--subject', `${wp.commit} (#${pr})`] : [])]),
    ...mergeTail(state, wp),
  ];
}

// What follows a squash: the merge-commit lookup, which decides whether the
// PR merged, and the merged check. Neither merges anything.
export function mergeTail(state, wp) {
  const pr = String(wp.pr.number);
  return [
    shell('merge', 'merge-commit', ['gh', 'pr', 'view', pr, '--repo', repoOf(state), '--json', 'mergeCommit'], { expects: { type: 'json' } }),
    shell('merged', 'merged', ['node', join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs'), 'land', 'merged',
      '--run', state.runDir, '--wp', wp.id, '--merge-sha', '{merge.sha}']),
  ];
}

// The abort a conflicted rebase queues; its record is the amendment.
export const rebaseAbort = (wp, conflict) => shell('rebase', 'abort', ['git', '-C', wp.lane.worktree, 'rebase', '--abort'], { land: { conflict } });

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

function postedReviewId({ stdout, stderr }) {
  for (const output of [stdout, stderr]) {
    const parsed = parseJson(first(output));
    if (parsed?.review_id != null) return parsed.review_id;
    const direct = /^posted-review-id (\d+)$/m.exec(String(output ?? ''));
    if (direct) return Number(direct[1]);
    const match = /pullrequestreview-(\d+)/.exec(String(output ?? ''));
    if (match) return Number(match[1]);
  }
  return null;
}

export function findingsCount({ stdout, stderr }) {
  for (const text of [stdout, stderr]) {
    const match = /^findings\s+(\d+)/m.exec(String(text ?? ''));
    if (match) return Number(match[1]);
  }
  return null;
}

export function deltaMajorCount({ stdout, stderr }, head) {
  const matches = [stdout, stderr].flatMap((output) => [...String(output ?? '').matchAll(/^delta-major (\d+) head=([0-9a-f]{40})$/gim)]);
  if (matches.length !== 1 || matches[0][2].toLowerCase() !== head?.toLowerCase()) return null;
  return Number(matches[0][1]);
}

// The full post's receipt: `full-major p1=<n> p2=<m> head=<sha>`, exactly once and bound to the head.
export function fullMajorCount({ stdout, stderr }, head) {
  const matches = [stdout, stderr].flatMap((output) => [...String(output ?? '').matchAll(/^full-major p1=(\d+) p2=(\d+) head=([0-9a-f]{40})$/gim)]);
  if (matches.length !== 1 || matches[0][3].toLowerCase() !== head?.toLowerCase()) return null;
  return { p1Findings: Number(matches[0][1]), p2Findings: Number(matches[0][2]) };
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

// The read of the posted review of the claim's head, after a refused claim.
export const recoverAction = (state, wp, land) => shell('review', 'recover', ['node', prReview(state), 'rounds', '--pr', String(wp.pr.number), '--repo', repoOf(state), '--head', land.head],
  { land });

function recordReview(state, wp, action, r) {
  const after = rest(wp, action);
  if (action.part === 'delta-count' && action.land.scope === 'full') {
    const read = parseJson(first(r.stdout));
    const counts = { p1Findings: read?.p1_findings, p2Findings: read?.p2_findings };
    if (r.code !== 0 || read?.outcome !== 'ok' || String(read.review_id) !== String(action.land.reviewId) || read.head !== action.land.head
      || !Object.values(counts).every((n) => Number.isInteger(n) && n >= 0)) {
      return result('block', `posted full review ${action.land.reviewId} has no head-bound P1/P2 count after adjudication: ${first(r.stderr) || first(r.stdout)}`);
    }
    const reviews = withLatest(wp, (review) => ({ ...review, ...counts }));
    const cleared = !reviewCrosses({ scope: 'full', ...counts }) && wp.deltaEscalation?.reviewId === action.land.reviewId;
    return result('continue', null, { reviews, ...(cleared ? { tier: 'T1', deltaEscalation: null } : {}) });
  }
  if (action.part === 'delta-count') {
    const read = parseJson(first(r.stdout));
    const count = read?.major_findings;
    if (r.code !== 0 || read?.outcome !== 'ok' || String(read.review_id) !== String(action.land.reviewId)
      || read.head !== action.land.head || !Number.isInteger(count) || count < 0) {
      return result('block', `posted delta review ${action.land.reviewId} has no head-bound distinct-defect count after adjudication: ${first(r.stderr) || first(r.stdout)}`);
    }
    const reviews = withLatest(wp, (review) => ({ ...review, majorFindings: count }));
    const cleared = count < 2 && wp.deltaEscalation?.reviewId === action.land.reviewId;
    return result('continue', null, { reviews, ...(cleared ? { tier: 'T1', deltaEscalation: null } : {}) });
  }
  if (action.part === 'managed') {
    const mode = parseJson(r.stdout)?.mode;
    if (mode !== 'managed' && mode !== 'standalone') return result('block', `review mode unreadable: ${first(r.stdout) || first(r.stderr)}`);
    const pick = pickReviewers(state, authorOf(state, wp), { mode, author: authorModelOf(state, wp) });
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
    return result('continue', `claim refused ${ALREADY_REVIEWED}: reading the posted review of this head`,
      { queue: [recoverAction(state, wp, action.land), ...after.filter((a) => a.land?.attemptRef !== action.land.attemptRef)] });
  }
  if (action.part === 'recover') {
    const read = parseJson(first(r.stdout));
    if (read?.outcome === 'ok' && read.round === 'reviewed' && read.last?.head === action.land.head) {
      const delta = read.last.scope === 'delta';
      // `escalate` can belong to a review older than `last`: the obligation is
      // recorded from `escalate_review`, the review that owes the council.
      const signalled = read.escalate === 't2-council';
      const owed = signalled ? read.escalate_review ?? null : null;
      // Only a T1 WP in a run with a council can owe one, so only there does
      // an unreadable signal hold the WP.
      const obligation = signalled && effectiveTier(wp) === 'T1' && councilOn(state);
      if (obligation && !owed) {
        return result('held', `posted review ${read.last.review_id} signalled council with no escalate_review naming the review that owes it; check the producer version`);
      }
      const counts = owed?.scope === 'delta' ? { majorFindings: owed.major_findings } : { p1Findings: owed?.p1_findings, p2Findings: owed?.p2_findings };
      const readable = Boolean(owed) && ['full', 'delta'].includes(owed.scope) && owed.review_id != null && /^[0-9a-f]{40}$/i.test(String(owed.head)) && reviewCrosses({ scope: owed.scope, ...counts });
      if (obligation && !readable) {
        return result('held', `posted ${owed.scope ?? 'unscoped'} review ${owed.review_id} signalled council without a readable ${owed.scope === 'delta' ? 'distinct-defect' : 'P1/P2'} count`);
      }
      const own = readable && String(owed.review_id) === String(read.last.review_id);
      const crossed = signalled && effectiveTier(wp) === 'T1';
      const escalation = obligation;
      // The latest review's own finding count, apart from any older obligation it carries.
      const entry = reviewEntry(wp, action.land, { scope: delta ? 'delta' : 'full', reviewId: read.last.review_id ?? null,
        findings: Number.isInteger(read.last.findings) ? read.last.findings : null,
        ...(delta ? { majorFindings: read.major_findings ?? null } : {}), ...(!delta && own && crossed ? counts : {}), ...(crossed && !escalation ? { escalation: NO_COUNCIL } : {}) });
      return result('continue', null, { reviews: [...(wp.reviews ?? []), entry],
        ...(escalation ? { tier: 'T2', deltaEscalation: { scope: owed.scope, round: own ? action.land.round : null, head: owed.head, reviewId: owed.review_id, ...counts } } : {}) });
    }
    return result('held', `claim refused ${ALREADY_REVIEWED} and no posted review of ${action.land.head} could be verified: ${first(r.stdout) || first(r.stderr)}`);
  }
  return r.code === 0 ? result('continue') : result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
}

// A council round is coverage only after a review with a usable seat and a
// synthesis with a parseable count; the entry is written at that point.
function recordCouncil(state, wp, action, r, deps = {}) {
  const land = action.land ?? {};
  if (action.part === 'delta-diff') return r.code === 0 ? councilFit(wp, action, deps) : result('block', `delta diff for council round ${land.round} failed: ${first(r.stderr)}`);
  if (action.part === 'full-diff') return r.code === 0 ? councilFit(wp, action, deps) : result('block', `full diff for council round ${land.round} failed: ${first(r.stderr)}`);
  if (action.part === 'review') {
    const paths = action.args?.artifact_paths ?? [];
    // The prior round's adjudication is context, not something to review.
    if (!paths.some((path) => path !== land.prior)) return result('block', `council review round ${land.round} was dispatched with no artifact_paths: nothing to review`);
    const previous = land.retry ? wp.councilStage : null;
    const seats = Object.entries(r.models ?? {}).filter(([, seat]) => seat?.status === 'success').map(([name]) => name);
    // An MCP error result carries its text in `content`, not `error`
    // (an unknown profile is refused by name there).
    const error = r.error ?? (r.isError ? (Array.isArray(r.content) ? r.content.map((part) => part?.text).filter(Boolean).join(' ').slice(0, 300) : '') || 'isError' : null);
    // A seat that refused the input's size would refuse the same input again: no retry.
    const tooLarge = Object.entries(r.models ?? {}).filter(([, seat]) => seat?.status !== 'success' && INPUT_TOO_LARGE.test(String(seat?.error ?? '')));
    if (tooLarge.length || INPUT_TOO_LARGE.test(String(error ?? ''))) {
      const text = String(tooLarge[0]?.[1]?.error ?? error);
      const actual = text.match(/actual_chars\D{0,4}(\d+)/)?.[1];
      const max = Number(text.match(/(?:max_chars|maximum length of)\D{0,4}(\d+)/)?.[1] ?? CODEX_INPUT_LIMIT);
      const who = tooLarge.length ? tooLarge.map(([name]) => name).join(', ') : 'the council';
      return result('block', `council review round ${land.round}: ${who} refused the input as too large (${actual ? `${chars(Number(actual))} chars` : 'size not reported'}, limit ${chars(max)}); the same input cannot succeed, so it is not retried: split the WP or review by hand`);
    }
    if ((error || !seats.length) && !previous?.seats?.length) return result('block', `council review round ${land.round} has no usable seat: ${error ?? 'every seat failed'}`);
    // Delta only when the dispatched review carried the delta diff.
    const scope = land.scope === 'delta' && land.deltaDiff && paths.includes(land.deltaDiff) ? 'delta' : 'full';
    const usable = [...new Set([...(previous?.seats ?? []), ...seats])];
    const requested = [...new Set([...(previous?.requested ?? []), ...(action.args.models ?? []), ...Object.keys(r.models ?? {})])];
    const missing = requested.filter((seat) => !usable.includes(seat));
    const stage = { round: land.round, usable: usable.length, seats: usable, scope, ...(land.retry || missing.length ? { requested, missing } : {}) };
    if (missing.length) {
      if ((land.retry ?? 0) >= 2) return result('block', `council review round ${land.round} still lacks coverage from ${missing.join(', ')} after two retries`);
      const retry = { ...action, args: { ...action.args, models: missing }, land: { ...land, retry: (land.retry ?? 0) + 1 } };
      return result('continue', null, { councilStage: stage, queue: [retry, ...rest(wp, action)] });
    }
    return result('continue', null, { councilStage: stage });
  }
  if (action.part === 'synthesize') {
    const stage = wp.councilStage;
    if (stage?.round !== land.round) return result('block', `council synthesis for round ${land.round} has no recorded review stage`);
    if (stage.missing?.length) return result('block', `council synthesis round ${land.round} still lacks coverage from ${stage.missing.join(', ')}`);
    const seats = Array.isArray(r.seats) ? r.seats.filter((seat) => typeof seat === 'string' && seat) : [];
    if (r.error || !Number.isInteger(r.findings) || r.findings < 0 || !seats.length || !seats.every((seat) => (stage.seats ?? []).includes(seat))) {
      return result('block', `council synthesis round ${land.round} is unusable: ${r.error ?? 'needs an integer findings count and seats that succeeded at review'}`);
    }
    const entry = { round: land.round, scope: stage.scope ?? 'full', since: stage.scope === 'delta' ? land.since ?? null : null, tier: 'T2', head: action.head, lenses: seats,
      reviewId: action.args.review_dir, findings: r.findings, verdicts: [], resolved: [],
      ...(wp.deltaEscalation ? { escalatedDeltaReviewId: wp.deltaEscalation.reviewId } : {}) };
    return result('continue', null, { councilStage: null, reviews: [...(wp.reviews ?? []), entry], ...(wp.deltaEscalation ? { deltaEscalation: null } : {}) });
  }
  if (r.error || r.success === false || r.challenge_stub) return result('block', `council challenge round ${land.round} failed: ${r.error ?? 'stub or unsuccessful'}`);
  return result('continue');
}

const INPUT_TOO_LARGE = /input_too_large|Input exceeds the maximum length/i;
const chars = (n) => n.toLocaleString('en-US');

// A council round's input, full or delta, set once its diff is written: the
// prior adjudication and the diff, then changed non-test files whole, smallest
// first (ties by path), while the total stays within COUNCIL_INPUT_BUDGET. A
// test file, a deleted file and one that would overflow reach the council
// through the diff alone; the seats can still open any of them under
// code_root. A diff that with the prior adjudication is over the budget is refused.
function councilFit(wp, action, deps) {
  const land = action.land;
  const key = land.scope === 'delta' ? 'deltaDiff' : 'fullDiff';
  const diff = land[key];
  const size = (path) => {
    try { return String(deps.read(path)).length; } catch { return null; }
  };
  const diffChars = size(diff);
  if (diffChars === null) return result('block', `${land.scope} diff for council round ${land.round} was not written to ${diff}`);
  if (diffChars === 0) return result('block', `council review round ${land.round} has an empty ${land.scope} diff: nothing to review`);
  const priorChars = land.prior ? size(land.prior) ?? 0 : 0;
  if (diffChars + priorChars > COUNCIL_INPUT_BUDGET) {
    const of = `${chars(diffChars)} chars of diff${priorChars ? ` and ${chars(priorChars)} of prior adjudication` : ''}`;
    return result('block', `council input would exceed the Codex ${chars(CODEX_INPUT_LIMIT)}-char limit (${of}); split the WP or review by hand`);
  }
  const queue = rest(wp, action);
  const at = queue.findIndex((a) => a.step === 'council' && a.part === 'review' && a.land?.[key] === diff);
  if (at < 0) return result('block', `council round ${land.round} has no queued review for its ${land.scope} diff`);
  const review = queue[at];
  const candidates = review.args.artifact_paths.filter((p) => p !== land.prior && p !== diff);
  const files = candidates.map((path) => ({ path, chars: isTestPath(relative(wp.lane.worktree, path)) ? null : size(path) }))
    .filter((file) => file.chars !== null)
    .sort((a, b) => a.chars - b.chars || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let total = diffChars + priorChars;
  const kept = [];
  for (const file of files) {
    if (total + file.chars > COUNCIL_INPUT_BUDGET) break;
    kept.push(file.path);
    total += file.chars;
  }
  const fitted = { ...review, args: { ...review.args, artifact_paths: [...(land.prior ? [land.prior] : []), diff, ...kept] },
    land: { ...review.land, inputChars: total, omitted: candidates.filter((path) => !kept.includes(path)) } };
  return result('continue', null, { queue: queue.map((a, i) => (i === at ? fitted : a)) });
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
    return result('continue', conflict, { queue: [rebaseAbort(wp, conflict)] });
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
  if (action.part === 'lane-base') {
    const { from, to } = action.land;
    const [newBase] = lines(r.stdout);
    if (!/^[0-9a-f]{40}$/i.test(newBase ?? '')) return result('block', `the lane's new base is unreadable: ${first(r.stdout)}`);
    const onLine = ancestor(wp.lane.worktree, from, to, deps.exec);
    if (onLine === null) return result('block', 'the lane\'s rebase is unreadable: an ancestry check failed');
    // Commits on top of the amendment's start are its gate-fix tail, not a rebase.
    if (onLine) return result('continue');
    const entry = recordRebase(state, wp, { from, to, newBase }, deps);
    return result('continue', null, { rebases: [...(wp.rebases ?? []), entry] });
  }
  return result('continue');
}

// A full review of the rebased head, round + 1, at the WP's tier (D13.3). It
// is new content, so the amendment cap does not count it.
function fullReview(state, wp, deps) {
  const round = latestRound(wp) + 1;
  if (effectiveTier(wp) !== 'T2') return { queue: reviewActions(state, wp, { round }) };
  const diff = deps.exec('git', ['-C', wp.lane.worktree, 'diff', '--name-only', '--no-renames', `origin/${defaultOf(state)}...HEAD`]);
  if (diff.code !== 0) return { failure: `changed files unreadable: ${first(diff.stderr)}` };
  const paths = lines(diff.stdout);
  // The round as queued, which emission derives its acts from (build.mjs councilActs).
  return { queue: t2Actions(state, wp, { round, changedPaths: paths.map((path) => join(wp.lane.worktree, path)) }), councilScope: { round, scope: 'full', since: null, paths } };
}

const validInspect = (inspect) => inspect && typeof inspect === 'object' && /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/i.test(inspect.tail ?? '')
  && typeof inspect.head === 'string' && Array.isArray(inspect.files) && inspect.files.length > 0 && inspect.files.every((file) => typeof file === 'string' && file)
  && inspect.review && typeof inspect.findingsHash === 'string';

export function inspectAction(state, wp, inspect, gate) {
  const [from, to] = inspect.tail.split('..');
  return { kind: 'inspect', step: 'gate', seam: STEP_SEAM.gate, part: 'inspect',
    instruction: inspect.gateFailures?.length
      ? `Read the post-cap tail's diff (this argv). It holds gate amendments repairing: ${inspect.gateFailures.join('; ')}. Judge it against those gate failures and the findings of review ${inspect.anchor}: addresses-findings when every change repairs one of them and nothing else changes. Record { verdict: 'addresses-findings' | 'unrelated-change', tail: '${inspect.tail}', head: '${inspect.head}' }.`
      : `Read the post-cap tail's diff (this argv) against the findings of review ${inspect.anchor}; record { verdict: 'addresses-findings' | 'unrelated-change', tail: '${inspect.tail}', head: '${inspect.head}' }.`,
    command: ['git', '-C', wp.lane.worktree, 'diff', '--no-color', '--no-renames', from, to, '--', ...inspect.files],
    land: { tail: inspect.tail, head: inspect.head, review: inspect.review, findingsHash: inspect.findingsHash, gate: requeue(gate) },
    expects: { type: 'json', fields: ['verdict', 'tail', 'head'] } };
}

// The visual read (quest 1b3dec9f): a WP that names design-direction rules
// (`**Visual rules:**`) merges only after the conductor has read its frames at
// the gated head against those rules. A failed rule is a gate amendment.
export function visualAction(state, wp, head, gate) {
  const rules = (state.design?.rules ?? []).filter((rule) => wp.visualRules.includes(rule.n));
  return { kind: 'inspect', step: 'gate', seam: STEP_SEAM.gate, part: 'visual',
    instruction: `Visual read of ${wp.id} at ${head}. Open the frames its lane took at this head (its report's ## Runtime exercise names them; retake any frame taken at an earlier head with that section's command) and judge each design-direction rule in \`rules\` (from ${state.design?.source ?? 'the spec\'s ## Design direction'}) from the pixels, not the code. Record { "head": "${head}", "frames": ["<absolute path of each frame you read>"], "rules": { "<n>": "pass" | "fail: <what the frame shows>" } }, one entry for each of rules ${wp.visualRules.join(', ')}. A failed rule goes to the lane as a gate amendment.`,
    rules, land: { head, rules: [...wp.visualRules], gate: requeue(gate) },
    expects: { type: 'json', fields: ['head', 'frames', 'rules'] } };
}

const VISUAL_VERDICT = /^(pass|fail:\s*\S[\s\S]*)$/;

// What is wrong with a visual read's record, or null. `exists` checks each frame.
export function visualReadProblem(action, r, exists) {
  const want = (action.land?.rules ?? []).map(String);
  if (r?.head !== action.land?.head) return `the visual read must name head ${action.land?.head}`;
  if (!Array.isArray(r.frames) || !r.frames.length || !r.frames.every((frame) => typeof frame === 'string' && isAbsolute(frame))) return 'frames must be a non-empty list of absolute paths to the frames you read';
  const absent = r.frames.filter((frame) => !exists(frame));
  if (absent.length) return `no frame at ${absent.join(', ')}`;
  if (!r.rules || typeof r.rules !== 'object' || Array.isArray(r.rules)) return `rules must be { "<n>": "pass" | "fail: <why>" } for rules ${want.join(', ')}`;
  const got = Object.keys(r.rules);
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  if (missing.length || extra.length) return `rules must hold exactly rules ${want.join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; not this WP's: ${extra.join(', ')}` : ''}`;
  const bad = got.filter((n) => typeof r.rules[n] !== 'string' || !VISUAL_VERDICT.test(r.rules[n].trim()));
  if (bad.length) return `rule ${bad.join(', ')}: a verdict is "pass" or "fail: <what the frame shows>"`;
  return null;
}

const visualFailures = (read) => Object.entries(read.rules ?? {}).filter(([, verdict]) => verdict.trim() !== 'pass');
const visualReason = (read, failed) => `visual read at ${read.head}: ${failed.map(([n, verdict]) => `rule ${n} ${verdict.trim()}`).join('; ')}`;

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
// A conductor's inspection record that doesn't name this action's tail and
// head is a recording error (a stale result file), refused at record, never a block.
export function inspectionProblem(action, r) {
  if (INSPECTION.includes(r?.verdict) && r.tail === action.land?.tail && r.head === action.land?.head) return null;
  return `the inspection must name ${action.land?.tail} at ${action.land?.head} with a verdict of ${INSPECTION.join(' or ')}; got ${JSON.stringify(r ?? null).slice(0, 200)}`;
}

function recordGate(state, wp, action, r, deps, authority) {
  if (action.part === 'inspect') {
    const problem = inspectionProblem(action, r);
    if (problem) return result('block', problem);
    const { review, findingsHash: hash } = action.land;
    const inspections = [...(wp.inspections ?? []), { verdict: r.verdict, tail: r.tail, head: r.head, review, findingsHash: hash }];
    if (r.verdict !== 'addresses-findings') return result('held', `post-cap tail ${r.tail} does not address the findings`, { inspections });
    return result('continue', null, { inspections, queue: [action.land.gate, ...rest(wp, action)] });
  }
  if (action.part === 'visual') {
    const problem = visualReadProblem(action, r, deps.exists ?? (() => false));
    if (problem) return result('block', `visual read unusable: ${problem}`);
    const read = { head: r.head, frames: [...r.frames], rules: Object.fromEntries(Object.entries(r.rules).map(([n, verdict]) => [n, verdict.trim()])) };
    const visualReads = [...(wp.visualReads ?? []), read];
    const failed = visualFailures(read);
    if (failed.length) return result('amend', visualReason(read, failed), { visualReads });
    // The gate runs again at this head and finds the read.
    return result('continue', null, { visualReads, queue: [action.land.gate, ...rest(wp, action)] });
  }
  const gate = parseJson(r.stdout);
  if (![0, 5, 6].includes(r.code) || !validGate(gate)) return result('block', `land gate output unreadable (exit ${r.code}): ${first(r.stderr) || first(r.stdout)}`);
  const recorded = { gate: gateRecord(wp, gate, deps) };
  if (r.code === 0) {
    // A WP that names visual rules passes only with a read of this head. The
    // latest read of the head decides, so a failed rule the lane pushed no fix
    // for amends again (and counts against the gate-amendment cap).
    if (wp.id !== 'release' && (wp.visualRules ?? []).length) {
      const read = (wp.visualReads ?? []).findLast((entry) => entry.head === gate.head);
      const notOk = { gate: { ...recorded.gate, ok: false }, retries: 0 };
      if (!read) return result('continue', `visual read owed at ${gate.head}`, { ...notOk, queue: [visualAction(state, wp, gate.head, action), ...rest(wp, action)] });
      const failed = visualFailures(read);
      if (failed.length) return result('amend', visualReason(read, failed), notOk);
    }
    // Merge authority covers a two-way door only: a one-way or undeclared door
    // is held for the operator, whatever else the gate passed. The release PR
    // is the run's own and declares none.
    if (wp.id !== 'release' && gate.door !== 'two-way') {
      const why = gate.door === 'one-way'
        ? 'Door: one-way, a merge one revert cannot undo'
        : `the PR body declares no valid door (${(gate.doorProblems ?? []).join('; ') || 'the gate reported none'}), so whether one revert undoes it is unknown`;
      return result('held', `gate passed; ${why}: the merge is the operator's`, { ...recorded, retries: 0 });
    }
    // An authority that gives no merge makes the merge the operator's.
    const refusal = mergeRefusal(state, authority);
    return refusal ? result('held', `gate passed; ${refusal}`, { ...recorded, retries: 0 }) : result('continue', null, { ...recorded, retries: 0 });
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
  if (causes.has('t2-council')) {
    const latest = (wp.reviews ?? []).at(-1);
    const record = latest?.escalatedDeltaReviewId && !latest.record?.url ? councilRecord(state, wp, []) : null;
    if (!record) return result('block', reason);
    if ((wp.councilRecordRetries ?? 0) >= 2) return result('block', `council record not posted after retries: ${reason}`);
    return result('continue', `retry council record: ${reason}`, { councilRecordRetries: (wp.councilRecordRetries ?? 0) + 1,
      queue: [record.action, requeue(action), ...rest(wp, action)] });
  }
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
    return result('continue', reason, { ...(mergeLockFor(state, wp) === 'mine' ? { mergeLock: null } : {}), queue: review.queue, ...(review.councilScope ? { councilScope: review.councilScope } : {}) });
  }
  if (causes.size === 1 && causes.has('inspect')) {
    if (!validInspect(gate.inspect)) return result('block', `the gate asked for an inspection with an unusable payload: ${JSON.stringify(gate.inspect)}`);
    return result('continue', reason, { queue: [inspectAction(state, wp, gate.inspect, action), ...rest(wp, action)] });
  }
  return result('amend', reason);
}

function landOutcome(state, wp, action, r, deps, authority) {
  switch (action.step) {
    case 'review': return recordReview(state, wp, action, r);
    case 'post':
      if (r.code !== 0) return result('block', `post failed (exit ${r.code}): ${first(r.stderr)}`);
      if (action.land.scope === 'delta') {
        const majorFindings = deltaMajorCount(r, action.land.head);
        if (majorFindings === null) return result('block', `delta post for ${action.land.head} returned success without a posted P1/P2 count receipt; check the post outcome and producer version`);
        const crossed = effectiveTier(wp) === 'T1' && reviewCrosses({ scope: 'delta', majorFindings });
        const escalation = crossed && councilOn(state);
        const reviewId = postedReviewId(r);
        if (escalation && reviewId === null) return result('block', `delta post for ${action.land.head} crossed the T2 threshold but has no posted review id; check the producer receipt`);
        return result('continue', null, {
          reviews: [...(wp.reviews ?? []), reviewEntry(wp, action.land, { findings: findingsCount(r), majorFindings, reviewId, ...(crossed && !escalation ? { escalation: NO_COUNCIL } : {}) })],
          ...(escalation ? { tier: 'T2', deltaEscalation: { scope: 'delta', round: action.land.round, head: action.land.head, reviewId, majorFindings } } : {}),
        });
      }
      if (effectiveTier(wp) === 'T1') {
        // A T1 full review escalates at one P1 or two distinct P2s, as a delta does at two majors.
        const counts = fullMajorCount(r, action.land.head);
        if (counts === null) return result('block', `full post for ${action.land.head} returned success without a posted P1/P2 count receipt (full-major); check the post outcome and producer version`);
        const crossed = reviewCrosses({ scope: 'full', ...counts });
        const escalation = crossed && councilOn(state);
        const reviewId = crossed ? postedReviewId(r) : null;
        if (escalation && reviewId === null) return result('block', `full post for ${action.land.head} crossed the T2 threshold but has no posted review id; check the producer receipt`);
        return result('continue', null, {
          reviews: [...(wp.reviews ?? []), reviewEntry(wp, action.land, { findings: findingsCount(r), ...counts, ...(crossed ? { reviewId } : {}), ...(crossed && !escalation ? { escalation: NO_COUNCIL } : {}) })],
          ...(escalation ? { tier: 'T2', deltaEscalation: { scope: 'full', round: action.land.round, head: action.land.head, reviewId, ...counts } } : {}),
        });
      }
      return result('continue', null, { reviews: [...(wp.reviews ?? []), reviewEntry(wp, action.land, { findings: findingsCount(r) })] });
    case 'council': return recordCouncil(state, wp, action, r, deps);
    case 'reply':
      // An escalated council record is required at the land gate.
      if (action.part === 'record') {
        const url = parseJson(r.stdout)?.html_url ?? null;
        return r.code === 0 && url
          ? result('continue', null, { reviews: withLatest(wp, (review) => ({ ...review, record: { url } })) })
          : result('continue', `council review record not posted (exit ${r.code}): ${first(r.stderr) || 'missing html_url'}`, { reviews: withLatest(wp, (review) => ({ ...review, record: { failed: first(r.stderr) || (r.code === 0 ? 'missing html_url' : `exit ${r.code}`) } })) });
      }
      if (action.kind === 'author') return result('continue');
      if (r.code !== 0) return result('block', `reply failed (exit ${r.code}): ${first(r.stderr)}`);
      // A posted reply is recorded by its comment id with the answer it carried; threadReplyActions skips the same answer later.
      return action.land?.comment ? result('continue', null, { threadReplies: { ...(wp.threadReplies ?? {}), [action.land.comment]: action.land.answer } }) : result('continue');
    case 'thread-ids': return recordThreadIds(state, wp, action, r);
    case 'resolve':
      if (r.code !== 0) return result('block', `resolve failed: ${first(r.stderr)}`);
      // A T0 WP's gate amendment resolves threads with no review on record to note them on.
      if (!wp.reviews?.length) return result('continue');
      return result('continue', null, { reviews: withLatest(wp, (review) => ({ ...review, resolved: [...(review.resolved ?? []), action.land.threadId] })) });
    case 'rebase': return recordRebaseStep(state, wp, action, r, deps);
    case 'gate': return recordGate(state, wp, action, r, deps, authority);
    case 'merge': {
      // gh's exit on the squash is advisory: `gh pr merge` can exit non-zero
      // after the merge landed (a post-merge local step failing). The
      // merge-commit read that follows is the oracle, so a failed squash goes
      // on to it carrying its exit, and only a missing merge commit blocks.
      if (action.part === 'squash' && r.code !== 0) {
        return result('continue', `squash exited ${r.code}; the merge commit decides`, { squashExit: { code: r.code, stderr: first(r.stderr) } });
      }
      if (r.code !== 0 && !(action.part === 'ready' && /already/i.test(r.stderr))) return result('block', `${action.part} failed (exit ${r.code}): ${first(r.stderr)}`);
      // The squash landed even if the merge-commit lookup after it fails.
      if (action.part !== 'merge-commit') return result('continue', null, action.part === 'squash' ? { squashed: true } : {});
      const sha = parseJson(r.stdout)?.mergeCommit?.oid;
      if (sha) return result('continue', null, { merge: { sha }, ...(wp.squashExit ? { squashed: true } : {}) });
      return result('block', wp.squashExit
        ? `squash failed (exit ${wp.squashExit.code}): ${wp.squashExit.stderr}; gh pr view shows no merge commit`
        : 'gh pr view printed no mergeCommit.oid');
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
// the cleanup it owes queued. `authority` is the run's (runAuthority).
export function recordLandStep(state, wp, action, r, deps = {}, authority = undefined) {
  if (!authority) throw new ConductError(2, 'authority not passed');
  let out;
  try {
    out = landOutcome(state, wp, action, r ?? {}, deps, authority);
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
