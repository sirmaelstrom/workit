// Phase build: the WP list → merged (or held) PRs. The run's lane contract
// first; then the scheduler dispatches WPs into lanes (WP-02), each WP's lane
// and landing steps run as queued arrays routed through recordLaneStep and
// recordLandStep, the conductor rules on lane asks before any escalation, and
// rebase → gate → merge runs one WP at a time under the merge lock (WP-03).
//
// A WP's position is `wps[].stage`: the step expanded into `wps[].queue` when
// the queue runs dry. `next` emits one queued action at a time: the oldest
// dispatched WP's first non-wait action, then a blocked touch's read, then a
// dispatch; only when everything waits, one `wait` with the smallest
// remaining time (waits yield, D17).
//
// Fields this phase adds (optional; every reader tolerates their absence):
// state.build { contract, halts, spendOkFor }; authority.budgetSource; wps[]
// stage, amendment, checkAmends, gateAmends, owed, asks, replyIds, rulingSeq,
// deferredBy, changedPaths, gateCmd, noCi, cleanup, lane.uncertain,
// lane.livenessHeld; halts[] kinds budget | meter | merged, a meter's dueAt;
// touches[] build (why the build opened it), applied, announced, waitLeftMs,
// waitDueAt, guard, spendUsd; a queued wait's remainingMs and dueAt; an
// emitted action's wpId and, on a yielding wait, `yield: true`; a spend
// action's budgetFor.
import { join } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { shellArgv } from '../exec.mjs';
import { LIVE_STATES, dispatchable, laneOccupied } from '../schedule.mjs';
import { chooseBackend, laneBackend, laneLayout, recordLaneStep } from '../lanes.mjs';
import {
  deltaReviewActions, effectiveTier, isTestPath, mergeActions, mergeLockFor, parseAmendmentTable, rebaseActions,
  recordAdjudication, recordLandStep, resolveThreadActions, reviewActions, t2Actions, tierFor,
} from '../land.mjs';
import { READ_BACK_WAIT_MS, answerCommand, conductScript, handBackAction, openTouch, recordTouch, spineAckFailure, touchAction, writeTouchFiles } from '../touch.mjs';

// The lane-contract template's run-level slot prefixes (D17). `<repo A` also
// matches `<repo A worktrees: …>`; a `<repo B` line is deleted in a
// single-repo run. Per-lane placeholders (<id>, <lane>, <n>, <sha>, <path>,
// <your-lane-id>) are not here: they stay for the lanes.
export const RUN_SLOTS = Object.freeze(['<run name>', '<anchor short id>', '<absolute path to the run doc>', '<repo A', '<gate command(s)>',
  '<reports directory>', '<base branch per repo', '<Per-repo lane isolation', '<repo B']);

const LANE_STEPS = new Set(['admit', 'create', 'base', 'start', 'prompt', 'fallback', 'wait', 'check', 'pr-lookup', 'stop']);
const LAND_STEPS = new Set(['review', 'post', 'council', 'reply', 'thread-ids', 'resolve', 'rebase', 'gate', 'merge', 'merged']);
const WAIT_MS = 60000;
const CLEANUP_RETRY_MS = 300000;
const GATE_AMENDS = 2;
const UNCERTAIN_BLOCK = 3;
const NO_CI_WINDOW_MS = 30 * 60000;
const ASK_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\([a-f]\)(?:\*\*|__)?\s*/i;
const GUARD_VERDICTS = ['confirmed', 'refuted', 'judgment'];
const FILL = { '{pr.number}': (wp) => wp.pr?.number, '{pr.head}': (wp) => wp.pr?.head, '{merge.sha}': (wp) => wp.merge?.sha };

const lower = (wp) => wp.id.toLowerCase();
const lines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const spineOn = (state) => state.adapters?.spine?.on === true;
const contractPath = (state) => join(state.runDir, '_lane-contract.md');
const latestRound = (wp) => Math.max(0, ...(wp.reviews ?? []).map((review) => review.round ?? 0));
const backendOf = (state, wp, deps) => laneBackend(state, deps, wp.lane?.backend ?? 'exec');
const waitSpec = (step, waitMs, instruction = `Wait ${waitMs / 1000} s.`) => ({ kind: 'wait', step, waitMs, instruction });
const shell = (step, part, command, extra = {}) => ({ kind: 'shell', step, part, command, expects: { type: 'none' },
  instruction: `Run this exact argv (no shell), and record its { code, stdout, stderr }.`, ...extra });

function readText(deps, path) {
  try {
    return deps.read(path);
  } catch {
    return null;
  }
}

function readJsonFile(deps, path, what) {
  if (!deps.exists(path)) throw new ConductError(2, `${what} ${path} was not written`);
  try {
    return JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `${what} ${path} is not valid JSON: ${error.message}`);
  }
}

function setState(state, wp, to, reason, deps) {
  const from = wp.state;
  wp.state = to;
  if (reason !== undefined) wp.reason = reason;
  appendEvent(state, deps, { event: 'wp-state', data: { wpId: wp.id, from, to, reason: wp.reason ?? null } });
}

// The target repo's .workit/conduct.json (absent → {}).
function repoConfig(state, deps) {
  const path = join(state.intent.repo.path, '.workit', 'conduct.json');
  return deps.exists(path) ? readJsonFile(deps, path, 'repo config') : {};
}

// Deep: the orchestrator's `## Gate Commands` line for the WP's wave; none and
// lite: the spec record's gate command.
function gateCommands(state, deps) {
  if (state.spec?.depth !== 'deep') return new Map([[null, state.spec?.gateCommand ?? '']]);
  const text = readText(deps, join(state.workshopDir, 'work-packages', '_orchestrator.md')) ?? '';
  const section = text.split(/^## /m).find((part) => part.startsWith('Gate Commands')) ?? '';
  return new Map(lines(section).map((line) => /^Wave (\d+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [Number(m[1]), m[2].trim()]));
}

const gateCommandFor = (state, wp, deps) => gateCommands(state, deps).get(state.spec?.depth === 'deep' ? wp.wave : null) ?? '';

// The gate command's env, from .workit/conduct.json `gateEnv` (string values).
// `{run}` and `{wp}` become the run slug and the WP id as lowercase
// identifiers, so a repo can give the conductor's suite its own test database:
// the gate runs under the merge lock, so one per run never runs twice at once.
export function gateEnvFor(state, wp, config) {
  const env = config.gateEnv;
  if (env === undefined) return {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
    throw new ConductError(2, '.workit/conduct.json gateEnv must be an object of string values');
  }
  const ident = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll('{run}', ident(state.slug)).replaceAll('{wp}', ident(wp.id))]));
}

// A gate command that cannot run as written is never run mis-quoted (D18, D19).
function notRunnable(command, platform) {
  if (!String(command).trim()) return 'no gate command';
  if (/^human review$/i.test(command.trim())) return `"${command.trim()}" is not a command`;
  if (platform === 'win32' && command.includes('"')) return 'contains a double quote, which cmd.exe /s /c would mis-quote on win32';
  return null;
}

// ---- the lane contract (D15.2, D17, D19.30, D20) ----

// Each `<…>` span on a line, nested brackets kept inside their span.
function slotSpans(line) {
  const spans = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '<') continue;
    for (let j = i, depth = 0; j < line.length; j += 1) {
      depth += line[j] === '<' ? 1 : line[j] === '>' ? -1 : 0;
      if (depth === 0) {
        spans.push(line.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return spans;
}

function runDeltas(laneSuite) {
  return ['', '## Run deltas', '',
    `- **Suite ownership (\`.workit/conduct.json\` laneSuite):** ${laneSuite} This overrides rule 9's "the full suite at the merge candidate is the conductor's, so don't run it" for this run.`, ''].join('\n');
}

function contractAction(state, deps) {
  const template = join(deps.pluginRoot ?? state.pluginRoot, 'reference', 'templates', 'lane-contract.template.md');
  const text = readText(deps, template);
  if (text === null) throw new ConductError(2, `the lane-contract template is unreadable at ${template}`);
  const laneSuite = repoConfig(state, deps).laneSuite;
  const { remote, defaultBranch } = state.intent.repo;
  const gates = [...new Set(gateCommands(state, deps).values())].filter(Boolean);
  const value = (prefix, span) => ({
    '<run name>': `conduct ${state.slug}`,
    '<anchor short id>': state.intent.anchor ? state.intent.anchor.slice(0, 8) : 'none',
    '<absolute path to the run doc>': join(state.runDir, 'state.json'),
    '<repo A': span === '<repo A>' ? remote : `${remote} worktrees: none declared by the run; follow the repo's own setup docs`,
    '<gate command(s)>': gates.join('; ') || 'none declared',
    '<reports directory>': state.runDir,
    '<base branch per repo': `${defaultBranch ?? 'main'} (${remote})`,
    '<Per-repo lane isolation': typeof laneSuite === 'string' && laneSuite.trim() ? laneSuite : 'none declared',
    '<repo B': null,
  })[prefix];
  const slots = {};
  for (const span of text.split(/\r?\n/).flatMap(slotSpans)) {
    const prefix = RUN_SLOTS.find((candidate) => span.startsWith(candidate));
    if (prefix) slots[span] = value(prefix, span);
  }
  const append = typeof laneSuite === 'string' && laneSuite.trim() ? runDeltas(laneSuite) : null;
  return {
    kind: 'author', step: 'contract', template, outPath: contractPath(state), slots, ...(append ? { append } : {}), expects: { type: 'file' },
    instruction: `Copy ${template} to ${contractPath(state)}, replacing each key of slots (its exact text, brackets included) with its value; a null value deletes the whole line that holds the slot. Leave every other <…> placeholder as it is.${append ? ' Then append the append text verbatim.' : ''} Record {}.`,
  };
}

function recordContract(state, action, deps) {
  const text = readText(deps, action.outPath);
  if (text === null) throw new ConductError(2, `the lane contract ${action.outPath} was not written`);
  const left = RUN_SLOTS.filter((prefix) => text.includes(prefix));
  if (left.length) throw new ConductError(2, `the lane contract still holds run-level slots: ${left.join(', ')}`);
  const laneSuite = repoConfig(state, deps).laneSuite;
  if (typeof laneSuite === 'string' && laneSuite.trim() && !/^## Run deltas\b/m.test(text)) {
    throw new ConductError(2, 'the repo declares laneSuite, and the lane contract has no ## Run deltas section saying it overrides rule 9');
  }
  state.build.contract = action.outPath;
}

// ---- authored actions ----

function briefAction(state, wp, deps) {
  const lane = laneLayout(state, wp);
  const outPath = wp.lane?.briefPath ?? lane.briefPath;
  const template = join(deps.pluginRoot ?? state.pluginRoot, 'skills', 'conduct', 'templates', 'lane-brief.md');
  return {
    kind: 'author', step: 'brief', part: 'brief', template, outPath, expects: { type: 'file' },
    slots: {
      '<lane id>': lane.name, '<quest id>': wp.questId ?? 'none', '<lane contract path>': contractPath(state), '<report path>': lane.reportPath,
      '<worktree path>': wp.lane?.worktree ?? lane.worktree, '<branch name>': wp.lane?.branch ?? lane.branch, '<base sha>': wp.lane?.base ?? '',
      '<wp spec path>': wp.specPath ?? '', '<runtime exercise>': wp.runtimeExercise || '',
    },
    instruction: `Copy ${template} to ${outPath}, replacing each key of slots with its value. Record {}.${wp.runtimeExercise ? '' : ' The WP names no runtime exercise: the brief asks the lane to name the surface and its check.'}`,
  };
}

const AMEND_TEXT = {
  check: (a) => `its last check failed: ${a.reason}. Fix exactly that, push, and update the report.`,
  gate: (a) => `landing stopped: ${a.reason}. Fix it on the branch at the current head, push, and update the report.`,
  ruling: (a) => `the conductor ruled (${a.ruled}) on its ## Needs conductor ask. The ruling's evidence, verbatim: ${a.evidence}. Carry on under that ruling.`,
  answer: (a) => `the operator answered ${a.tag}, verbatim: (${a.key})${a.text ? ` ${a.text}` : ''}. Carry on under that answer.`,
  findings: (a) => (a.ids
    ? `council review round ${a.round} (synthesis in ${a.reviewDir}) has ${a.ids.length} Critical/Major/Minor finding(s). Write them into this brief numbered ${a.ids.join(', ')} in synthesis order; the lane's ## Amendment table uses those ids.`
    : `review round ${a.round} posted ${a.findings ?? 'an unknown number of'} finding(s) as PR review comments; the lane adjudicates each in an ## Amendment table keyed by its comment id.`),
};

// A retry renders the failed expectation whatever the amendment's kind; the
// marker line is what `record` looks for, so an unchanged brief is refused.
function amendmentBrief(state, wp, amendment) {
  const outPath = wp.lane?.briefPath ?? laneLayout(state, wp).briefPath;
  const kind = AMEND_TEXT[amendment.kind] ? amendment.kind : 'check';
  const retry = amendment.retryReason && kind !== 'check' ? `${AMEND_TEXT.check({ reason: amendment.retryReason })} Still owed: ` : '';
  const marker = `Amendment ${amendment.n}: ${amendment.retryReason ?? amendment.reason}`;
  return {
    kind: 'author', step: 'brief', part: 'amendment', outPath, amendment, marker, expects: { type: 'file' },
    instruction: `Rewrite ${outPath} as amendment ${amendment.n} for ${wp.id}'s lane (same worktree, same report ${laneLayout(state, wp).reportPath}): ${retry}${AMEND_TEXT[kind](amendment)} The lane appends ## Amendment ${amendment.n} to its report (lane contract § Finish, step 4). Start the file with this line, verbatim: ${marker}. Record {}.`,
  };
}

// A ruling on a lane's asks (part ask) or on a guard row (part guard, D20).
function rulingAction(state, wp, { asks = null, row = null }) {
  wp.rulingSeq = Math.max(wp.rulingSeq ?? 0, (wp.rulings ?? []).length) + 1;
  const n = wp.rulingSeq;
  const file = `rulings/${lower(wp)}-${n}.json`;
  const keys = row ? GUARD_VERDICTS : (asks ?? []).map((ask) => ask.key);
  const outPath = join(state.runDir, file);
  const what = row ? `the guard row for comment ${row.comment} (the lane's evidence: ${row.evidence})` : `${wp.id}'s ## Needs conductor asks: ${(asks ?? []).map((ask) => ask.text).join(' / ')}`;
  return {
    kind: 'author', step: 'ruling', part: row ? 'guard' : 'ask', outPath, ruling: { n, file, keys, ...(row ? { comment: row.comment, row } : { asks }) }, expects: { type: 'file' },
    instruction: `Rule on ${what}: write ${outPath} = { "ruled": "<one of ${keys.join(', ')}>", "evidence": "<the measurement or file that settles it>" }, or { "escalate": true, "why": "<why only the operator can settle it>" }. Record {}.`,
  };
}

function guardReply(state, wp, row, ruled) {
  const body = join(state.runDir, 'reviews', lower(wp), 'replies', `${row.comment}.md`);
  const script = join(state.pluginRoot, 'skills', 'slim-review', 'scripts', 'pr-review.mjs');
  return [
    { kind: 'author', step: 'reply', part: 'bodies', outPath: join(state.runDir, 'reviews', lower(wp), 'replies'), files: [{ path: body, comment: row.comment, verdict: ruled }],
      expects: { type: 'file' }, instruction: `Write ${body}: the conductor's ${ruled} ruling on comment ${row.comment} and its evidence (rulings/). Record {}.` },
    shell('reply', 'reply', ['node', script, 'reply', '--pr', String(wp.pr.number), '--repo', state.intent.repo.remote, '--comment-id', row.comment,
      '--body-file', body, '--verdict', ruled, '--adjudicator', 'conductor', '--measure-log', join(state.runDir, 't1.jsonl')]),
  ];
}

function metaAction(state, wp) {
  const outPath = join(state.runDir, 'council', lower(wp), 'meta.json');
  const title = `${wp.id}: ${wp.name}`;
  return { kind: 'author', step: 'council', part: 'meta', outPath, title, expects: { type: 'file' },
    instruction: `Write ${outPath} = ${JSON.stringify({ title })} (create the directory). Record {}.` };
}

// The changed files of the PR: the start of a full review (D19.11).
const prDiff = (state) => shell('review', 'diff', ['gh', 'pr', 'diff', '{pr.number}', '--repo', state.intent.repo.remote, '--name-only']);

const withMeta = (state, wp, actions) => (actions.some((a) => a.step === 'council' && a.part === 'review') ? [metaAction(state, wp), ...actions] : actions);

// ---- touches the build opens (D19.3, D19.4, D19.8, D16) ----

function buildTouch(state, deps, why, fields) {
  const touch = openTouch(state, { kind: 'blocked', allowFreeText: false, did: `conduct ${state.slug}: build phase`, ...fields }, deps);
  touch.build = why;
  return touch;
}

const option = (key, label, consequence) => ({ key, label: String(label).slice(0, 120), consequence: String(consequence).slice(0, 240) });

// Run-level halt reasons (budget, a merged-tree anomaly) are kept as a set:
// an answer clears only its own, and dispatch resumes when none is left.
function syncHalt(state, deps) {
  const halts = state.build.halts ?? [];
  state.dispatchHalt = halts.length ? { reason: halts.map((halt) => halt.reason).join('; '), since: state.dispatchHalt?.since ?? deps.timestamp() } : null;
}

function haltTouch(state, deps, reason, why, spendUsd = null) {
  const halts = (state.build.halts ??= []);
  if (why === 'budget' && halts.some((halt) => halt.kind === 'budget')) return;
  const budget = why === 'budget';
  const touch = buildTouch(state, deps, why, {
    question: budget
      ? `DO: decide whether conduct ${state.slug} spends more. ${reason}. EXPECT: (a) answered with the text "budget <USD>" above the current spend raises the ceiling to it, and metering continues; (b) no new paid lane work (no dispatch, lane start, prompt or fallback); work already at a PR boundary may still be reviewed and landed, and the build ends.`
      : `DO: decide whether conduct ${state.slug} dispatches more lanes. ${reason}. EXPECT: (a) this halt is cleared; dispatch resumes once no other halt is open; (b) no new lane starts, the live ones finish, and the build ends.`,
    options: budget
      ? [option('a', 'Raise the budget', 'Type "budget <USD>", above the current spend; metering continues against it.'), option('b', 'Stop new paid lane work', 'No dispatch, start, prompt or fallback; PRs already up may still land.')]
      : [option('a', 'Resume dispatch', 'This halt is cleared.'), option('b', 'End the build', 'Live lanes finish; nothing new is dispatched.')],
    allowFreeText: budget,
  });
  touch.spendUsd = spendUsd;
  halts.push({ kind: why, reason, touch: touch.n });
  syncHalt(state, deps);
}

// An unreadable or unset meter is its own halt reason: only a successful
// spend read clears it, re-tried every READ_BACK_WAIT_MS (no budget answer does).
function meterHalt(state, deps, reason) {
  const halts = (state.build.halts ??= []);
  const meter = halts.find((halt) => halt.kind === 'meter');
  if (meter) {
    Object.assign(meter, { reason, waitLeftMs: READ_BACK_WAIT_MS, dueAt: null });
    return syncHalt(state, deps);
  }
  halts.push({ kind: 'meter', reason, waitLeftMs: READ_BACK_WAIT_MS });
  haltTouch(state, deps, reason, 'budget');
  return syncHalt(state, deps);
}

function escalate(state, wp, deps, { why, asks = null, row = null }) {
  const label = (ask) => ask.text.replace(ASK_MARKER, '');
  const options = row ? GUARD_VERDICTS.map((v, i) => option('abc'[i], v, `The conductor replies ${v} to comment ${row.comment}; resolution resumes.`))
    : (asks?.length ? asks.map((ask) => option(ask.key, label(ask), `The lane is amended with (${ask.key}) and resumes at its check.`)) : [option('a', 'Resume the lane', 'The lane is amended with your text.')]);
  const verbatim = row ? `the guard row for comment ${row.comment}: ${row.evidence}` : (asks ?? []).map((ask) => ask.text).join(' / ');
  const expect = row ? `the conductor posts your verdict on comment ${row.comment} (adjudicator conductor) and resolves the threads` : `${wp.id}'s lane is amended with your answer verbatim and resumes at its check`;
  const touch = buildTouch(state, deps, row ? 'guard' : 'ask', {
    question: `DO: settle ${wp.id}'s fork; the conductor escalated it (${why}). The lane's words, verbatim: ${verbatim}. EXPECT: ${expect}.`.slice(0, 2000),
    options, wpId: wp.id, suspendedStep: 'check',
  });
  if (row) touch.guard = row;
  block(state, wp, deps, `escalated to the operator: ${why}`);
}

// An unusable answer re-opens the touch with a refusal, so it stays answerable.
function refuse(state, touch, why, deps) {
  Object.assign(touch, { status: 'open', answer: null, refusal: why, tty: false, waiting: false, announced: false, applied: false, waitDueAt: null });
  appendEvent(state, deps, { step: 'touch', event: 'answer-refused', data: { n: touch.n, why } });
  if (!spineOn(state)) writeTouchFiles(state, touch, deps);
}

// A run touch's (a) clears its own halt: for the budget only with "budget
// <USD>" above the spend at the halt, which becomes authority.budgetUsd.
function answerRunTouch(state, touch, deps) {
  const { key, text } = touch.answer;
  const halt = (state.build.halts ?? []).find((entry) => entry.touch === touch.n);
  if (key === 'b') {
    if (halt) halt.ended = true;
    return;
  }
  if (touch.build === 'budget') {
    // `budget <USD>`: digits with optional thousands commas, `$` and decimals ("budget $1,500" → 1500).
    const usd = Number(/\bbudget\s+\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\w.,])/i.exec(text ?? '')?.[1]?.replaceAll(',', ''));
    if (!(usd > (touch.spendUsd ?? 0))) return refuse(state, touch, `(a) needs the text "budget <USD>" above the current spend of $${touch.spendUsd ?? 'unknown'}`, deps);
    state.authority.budgetUsd = usd;
    state.authority.budgetSource = { touch: touch.n, by: touch.answer.by, answeredAt: touch.answer.answeredAt, text };
  }
  state.build.halts = (state.build.halts ?? []).filter((entry) => entry !== halt);
  syncHalt(state, deps);
}

// A guard ruling the operator made goes through the conductor reply path, then
// the owed resolution resumes.
function answerGuard(state, wp, touch, deps) {
  const verdict = GUARD_VERDICTS['abc'.indexOf(touch.answer.key)];
  const row = touch.guard;
  wp.rulings = [...(wp.rulings ?? []), { n: null, file: touch.file, ruled: verdict, escalate: false, touch: touch.n }];
  setState(state, wp, 'review', `operator ruled ${verdict} on comment ${row.comment} (touch ${touch.n})`, deps);
  wp.queue = [...wp.queue, ...conductorVerdict(state, wp, row, verdict, deps), ...(wp.owed?.queue ?? [])];
  if (wp.owed) wp.owed.queue = [];
  wp.stage = 'resolve';
}

// The conductor's verdict on a guard row: a PR comment gets the conductor
// reply (then its resolve); a council finding has no PR comment, so the
// verdict is recorded as an `adjudicated` event and nothing is posted.
function conductorVerdict(state, wp, row, verdict, deps) {
  if (/^C\d+-\d+$/.test(row.comment)) {
    appendEvent(state, deps, { step: 'adjudicate', event: 'adjudicated', data: { wpId: wp.id, rows: [{ comment: row.comment, verdict, adjudicator: 'conductor' }] } });
    return [];
  }
  wp.replyIds = [...(wp.replyIds ?? []), row.comment];
  return guardReply(state, wp, row, verdict);
}

// An answered build touch acts once: a WP touch amends its lane (a guard
// touch replies instead); a run touch clears or ends its own halt.
function applyAnswers(state, deps) {
  for (const touch of state.touches ?? []) {
    if (!touch.build || touch.status !== 'answered' || touch.applied) continue;
    touch.applied = true;
    const { key, text } = touch.answer;
    appendEvent(state, deps, { step: 'touch', event: 'answer-applied', data: { n: touch.n, key, wpId: touch.wpId } });
    if (!touch.wpId) {
      answerRunTouch(state, touch, deps);
      continue;
    }
    const wp = state.wps.find((candidate) => candidate.id === touch.wpId);
    // An unverifiable lane is released only on the operator's word; the WP keeps its state.
    if (wp && touch.build === 'liveness') {
      if (key === 'a') {
        Object.assign(wp.lane, { exitedAt: deps.timestamp(), livenessHeld: false, uncertain: 0 });
        wp.queue = wp.queue.filter((action) => action.step !== 'stop');
      }
      continue;
    }
    if (!wp || wp.state !== 'blocked' || (touch.build === 'dialog' && key === 'b')) continue;
    if (touch.build === 'guard') answerGuard(state, wp, touch, deps);
    else startAmendment(state, wp, deps, { kind: 'answer', reason: `operator answer ${key} to touch ${touch.n}`, tag: touch.tag, key, text, answer: touch.answer });
  }
}

const openBuildTouches = (state) => (state.touches ?? []).filter((touch) => touch.build && touch.status !== 'answered');

// ---- WP transitions ----

function startAmendment(state, wp, deps, { retry = false, answer = null, ...fields }) {
  const prev = wp.amendment;
  const n = (prev?.n ?? 0) + 1;
  wp.amendment = retry && prev ? { ...prev, n, retryReason: fields.reason } : { n, since: wp.pr?.head ?? null, ...fields, kind: fields.kind ?? 'check' };
  setState(state, wp, 'amending', fields.reason, deps);
  wp.stage = 'wait';
  wp.queue = [...(wp.queue ?? []), amendmentBrief(state, wp, wp.amendment), ...backendOf(state, wp, deps).prompt(wp, { amendment: true, answer })];
}

// One re-prompt per failed check expectation; a second failure blocks.
function checkFailed(state, wp, deps, reason) {
  if ((wp.checkAmends ?? 0) >= 1) return block(state, wp, deps, `check failed again after an amendment: ${reason}`);
  wp.checkAmends = 1;
  startAmendment(state, wp, deps, { retry: true, kind: 'check', reason });
}

// At most GATE_AMENDS gate-driven amendments per WP (gate command, land gate
// and rebase-conflict amendments alike); the next blocks with the last gate
// cause as its reason.
function gateAmend(state, wp, deps, reason) {
  if ((wp.gateAmends ?? 0) >= GATE_AMENDS) return block(state, wp, deps, `${reason} (after ${GATE_AMENDS} gate amendments)`);
  wp.gateAmends = (wp.gateAmends ?? 0) + 1;
  return startAmendment(state, wp, deps, { kind: 'gate', reason });
}

// A blocked WP keeps only its owed cleanup (the lane's stop); failed work is dropped.
function block(state, wp, deps, reason) {
  setState(state, wp, 'blocked', reason, deps);
  wp.stage = null;
  wp.queue = (wp.queue ?? []).filter((action) => action.step === 'stop');
}

function merged(state, wp, deps) {
  setState(state, wp, 'merged', null, deps);
  wp.stage = null;
  const after = [];
  const { number } = wp.pr;
  const sha = wp.merge?.sha;
  const notify = deps.env?.WORKIT_NOTIFY_CMD;
  if (state.adapters?.notify?.on && notify) {
    after.push(shell('notify', 'notify', shellArgv(notify, deps.platform), { env: { WORKIT_NOTIFY_PR: String(number), WORKIT_NOTIFY_SHA: sha, WORKIT_NOTIFY_REVERT: `git revert ${sha}` } }));
  }
  if (spineOn(state) && wp.questId) {
    const tool = (part, name, args) => ({ kind: 'agent-tool', step: 'receipt', part, tool: name, args, expects: { type: 'json' }, instruction: `Call ${name} with these args and record its raw result.` });
    after.push(tool('completed', 'spine_receipt', { questId: wp.questId, outcome: 'completed', did: `${wp.id} (${wp.name}) merged as PR #${number} at ${sha}.`,
      stoppedAt: `merged by conduct ${state.slug}`, producedArtifacts: [{ type: 'pr', locator: `https://github.com/${state.intent.repo.remote}/pull/${number}`, rel: 'remedy' }] }));
    // The anchor (depth none/lite) stays open until the showcase answer (D18).
    if (wp.questId !== state.intent.anchor) after.push(tool('done', 'spine_update', { questId: wp.questId, workState: 'done', horizon: 'landed' }));
  }
  wp.queue = [...(wp.queue ?? []), ...after, ...backendOf(state, wp, deps).stop(wp)];
}

// A library emitter that cannot emit (no lens can run, a delta after a
// rebase) blocks the WP.
function emitting(state, wp, deps, fn) {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    block(state, wp, deps, error.message);
    return [];
  }
}

function findingsAmendment(state, wp, deps) {
  const review = (wp.reviews ?? []).at(-1);
  if (!review) return block(state, wp, deps, 'the review recorded no result');
  const reviewDir = String(review.reviewId ?? '');
  const council = reviewDir.startsWith(join(state.runDir, 'council'));
  const ids = council ? Array.from({ length: review.findings }, (_, i) => `C${review.round}-${i + 1}`) : null;
  // The adjudication is owed until the table is read, whatever amendments come between.
  wp.owed = { adjudicate: true, round: review.round, findings: review.findings, ids, queue: [] };
  startAmendment(state, wp, deps, { kind: 'findings', reason: `review round ${review.round}: ${review.findings ?? 'unknown'} finding(s)`, round: review.round, findings: review.findings, ids, reviewDir });
}

// Every finding the review raised has a row: a council id each, or as many
// PR-comment rows as findings posted.
// Ids are normalized (`#`, case, whitespace) and must be unique; distinct ids
// are counted against the findings, and known council ids must all appear.
function unreconciled(owed, rows) {
  const ids = rows.map((row) => String(row.comment).trim().replace(/^#/, '').toUpperCase());
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (twice.length) return `the ## Amendment table lists ${twice.join(', ')} more than once`;
  if (owed?.ids) {
    const missing = owed.ids.filter((id) => !ids.includes(id.toUpperCase()));
    if (missing.length) return `the ## Amendment table has no row for ${missing.join(', ')}`;
  }
  return Number.isInteger(owed?.findings) && ids.length < owed.findings ? `the ## Amendment table has ${ids.length} distinct id(s) for ${owed.findings} finding(s)` : null;
}

// The amended report's table feeds recordAdjudication (step adjudicate): its
// replies, then a ruling per guard row; thread resolution follows.
function adjudicate(state, wp, deps) {
  const rows = parseAmendmentTable(readText(deps, laneLayout(state, wp).reportPath) ?? '');
  let adjudication;
  try {
    if (!rows.length) throw new ConductError(2, 'the report has no ## Amendment table (| Comment | Verdict | Evidence | Commit |)');
    const gap = unreconciled(wp.owed, rows);
    if (gap) throw new ConductError(2, gap);
    adjudication = recordAdjudication(state, wp, rows);
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    return checkFailed(state, wp, deps, error.message);
  }
  wp.owed.adjudicate = false;
  wp.reviews = adjudication.patch.reviews;
  wp.replyIds = adjudication.actions.filter((a) => a.part === 'reply').map((a) => a.command[a.command.indexOf('--comment-id') + 1]);
  appendEvent(state, deps, { step: 'adjudicate', event: 'adjudicated', data: { wpId: wp.id, rows: rows.map((row) => ({ comment: row.comment, verdict: row.verdict })) } });
  wp.queue = [...adjudication.actions, ...adjudication.conductorRows.map((row) => rulingAction(state, wp, { row }))];
  wp.stage = 'resolve';
  return true;
}

// ---- stage expansion ----

function expand(state, wp, deps) {
  const backend = backendOf(state, wp, deps);
  const go = (actions, stage) => {
    wp.queue = actions;
    wp.stage = stage;
  };
  switch (wp.stage) {
    case 'admit': return go(backend.admit(wp), 'flip');
    case 'flip': return go(spineOn(state) && wp.questId ? [{ kind: 'agent-tool', step: 'flip', tool: 'spine_update', args: { questId: wp.questId, currentPhase: 'build' },
      expects: { type: 'json' }, instruction: 'Call spine_update with these args (the pickup flip) and record its raw result.' }] : [], 'create');
    case 'create': return go(backend.create(wp), 'brief');
    case 'brief': return go([briefAction(state, wp, deps)], 'start');
    case 'start': return go(backend.start(wp), 'prompt');
    case 'prompt': return go(backend.prompt(wp), 'wait');
    case 'wait': return go(backend.wait(wp), 'check');
    case 'check': return go(backend.check(wp), 'checked');
    case 'checked': {
      const findings = Boolean(wp.reviews?.length && wp.owed?.adjudicate);
      if (findings && !adjudicate(state, wp, deps)) return undefined;
      wp.checkAmends = 0;
      if (wp.state !== 'pr') setState(state, wp, 'pr', null, deps);
      if (findings) return undefined;
      if (!wp.reviews?.length) return go([prDiff(state)], null);
      return go([], 'delta');
    }
    case 'reviewed': {
      if ((wp.reviews ?? []).at(-1)?.findings === 0) return go([], 'land');
      return findingsAmendment(state, wp, deps);
    }
    case 'resolve': return go(wp.replyIds?.length ? resolveThreadActions(state, wp, wp.replyIds) : [], 'delta');
    case 'delta': {
      // One delta pass per full review; a later tail is the gate's post-cap inspection.
      const since = wp.amendment?.since;
      if (!since || since === wp.pr?.head || (wp.reviews ?? []).at(-1)?.scope !== 'full') return go([], 'land');
      return go([shell('review', 'amend-diff', ['git', '-C', wp.lane.worktree, 'diff', '--name-only', since, '{pr.head}'])], null);
    }
    case 'land':
      if (mergeLockFor(state, wp) === 'other') return go([waitSpec('rebase', WAIT_MS, `Wait: ${state.mergeLock.wpId} holds the merge lock.`)], 'land');
      if (wp.state !== 'gate') setState(state, wp, 'gate', null, deps);
      return go(rebaseActions(state, wp), 'gate');
    case 'gate': {
      const command = gateCommandFor(state, wp, deps);
      const why = notRunnable(command, deps.platform);
      if (why && wp.gateCmd?.reason !== why) appendEvent(state, deps, { step: 'gate-cmd', event: 'not-exercised', data: { wpId: wp.id, reason: why } });
      wp.gateCmd = why ? { state: 'not-exercised', reason: why } : { state: 'run', command };
      const gate = shell('gate', 'gate', ['node', conductScript(state), 'land', 'gate', '--run', state.runDir, '--wp', wp.id]);
      if (why) return go([gate], 'merge');
      const config = repoConfig(state, deps);
      let env;
      try {
        env = gateEnvFor(state, wp, config);
      } catch (error) {
        if (!(error instanceof ConductError)) throw error;
        if (mergeLockFor(state, wp) === 'mine') state.mergeLock = null;
        return block(state, wp, deps, error.message);
      }
      // A suite longer than a foreground shell allows runs in the background (gateBackground).
      const extra = { cwd: wp.lane.worktree, ...(Object.keys(env).length ? { env } : {}), ...(config.gateBackground === true ? { background: true } : {}) };
      return go([shell('gate-cmd', 'gate-cmd', shellArgv(command, deps.platform), extra), gate], 'merge');
    }
    case 'merge': {
      if (!wp.gate?.ok) return go([], 'gate');
      const actions = mergeActions(state, wp, wp.gate.head);
      return actions.length ? go(actions, null) : go([], 'land');
    }
    default:
      wp.stage = null;
      return undefined;
  }
}

// A WP's queue, expanded from its stage when empty. A lane still holding its
// slot after its WP left the live states is stopped, unless an open touch
// will resume it.
function fill(state, wp, deps) {
  if (wp.queue?.length) return;
  wp.queue = [];
  if (!LIVE_STATES.includes(wp.state) && laneOccupied(wp) && !wp.stage && !openBuildTouches(state).some((t) => t.wpId === wp.id)) {
    wp.queue = backendOf(state, wp, deps).stop(wp);
    return;
  }
  for (let hop = 0; hop < 16 && wp.stage && !wp.queue.length; hop += 1) expand(state, wp, deps);
}

// ---- emission ----

function emitHead(wp) {
  const head = wp.queue[0];
  const command = head.command?.map((arg) => {
    if (!Object.hasOwn(FILL, arg)) return arg;
    const value = FILL[arg](wp);
    if (value === null || value === undefined) throw new ConductError(2, `${wp.id}: placeholder ${arg} is unfilled when ${head.step}${head.part ? `/${head.part}` : ''} is emitted`);
    return String(value);
  });
  wp.queue[0] = command ? { ...head, command } : head;
  return { ...wp.queue[0], wpId: wp.id };
}

const byDispatch = (state) => [...state.wps].sort((a, b) => String(a.dispatchedAt ?? '~').localeCompare(String(b.dispatchedAt ?? '~')) || a.id.localeCompare(b.id));

function deferrals(state, deps) {
  const byId = new Map(state.wps.map((wp) => [wp.id, wp]));
  // "Nothing else is live": no WP holds a live state and none can be dispatched.
  const live = state.wps.some((wp) => LIVE_STATES.includes(wp.state)) || dispatchable(state, { now: deps.now() }).length > 0;
  const stuck = (dep) => ['held', 'refuted', 'deferred'].includes(dep.state) || (dep.state === 'blocked' && !live);
  for (let changed = true, round = 0; changed && round < state.wps.length + 1; round += 1) {
    changed = false;
    for (const wp of state.wps) {
      if (wp.state === 'pending') {
        const dep = (wp.dependsOn ?? []).map((id) => byId.get(id)).find((candidate) => candidate && stuck(candidate));
        if (!dep) continue;
        setState(state, wp, 'deferred', `depends on ${dep.id}, which is ${dep.state}`, deps);
        wp.deferredBy = dep.id;
        changed = true;
      } else if (wp.state === 'deferred' && wp.deferredBy && !['held', 'refuted', 'deferred', 'blocked'].includes(byId.get(wp.deferredBy)?.state)) {
        setState(state, wp, 'pending', null, deps);
        wp.deferredBy = null;
        changed = true;
      }
    }
  }
}

// Before each dispatch and each paid lane action (`purpose` is 'dispatch' or
// the WP id): a start (exec `lane spawn` carries the first prompt), a prompt
// or a fallback. The metered spend, or the lane-only lower bound (D16,
// D19.28). Returns null (go), a spend action, 'halted' or 'ended'.
const paid = (action) => action.kind === 'shell' && ['start', 'prompt', 'fallback'].includes(action.step);
const budgetEnded = (state) => (state.build.halts ?? []).some((entry) => entry.kind === 'budget' && entry.ended);
const spendAction = (state, deps, purpose) => shell('spend', 'spend', shellArgv(`${deps.env.WORKIT_SPEND_CMD} ${state.createdAt}`, deps.platform),
  { budgetFor: purpose, instruction: 'Run this exact argv; it prints the run\'s spend in USD. Record its { code, stdout, stderr }.' });

function budgetGate(state, deps, purpose) {
  if (budgetEnded(state)) return 'ended';
  if ((state.build.halts ?? []).some((entry) => entry.kind === 'budget' || entry.kind === 'meter')) return 'halted';
  const budget = state.authority?.budgetUsd ?? 0;
  if (state.adapters?.spend?.on) {
    if (!deps.env?.WORKIT_SPEND_CMD) {
      meterHalt(state, deps, 'The spend adapter is on, but WORKIT_SPEND_CMD is not set, so spend is unknown (metered by the spend adapter)');
      return 'halted';
    }
    if (state.build.spendOkFor === purpose) {
      state.build.spendOkFor = null;
      return null;
    }
    return spendAction(state, deps, purpose);
  }
  const sum = state.wps.reduce((total, wp) => total + (Number(wp.lane?.costUsd) || 0), 0);
  if (sum < budget) return null;
  haltTouch(state, deps, `Spend is $${sum} against the $${budget} budget (unmetered, lane-only lower bound)`, 'budget', sum);
  return 'halted';
}

function dispatch(state, wp, deps) {
  const chosen = chooseBackend(state, deps);
  if (state.adapters?.herdr?.on && chosen.backend !== 'herdr') state.adapters.herdr.detail = chosen.detail;
  wp.lane = { backend: chosen.backend };
  wp.agent = state.intent.agent;
  wp.commit = /^\*\*Commit:\*\*\s*`([^`]+)`/m.exec(readText(deps, wp.specPath ?? '') ?? '')?.[1] ?? null;
  Object.assign(wp, { queue: [], stage: 'admit', checkAmends: 0, dispatchedAt: deps.timestamp() });
  setState(state, wp, 'dispatched', null, deps);
  fill(state, wp, deps);
  return wp.queue.length ? emitHead(wp) : null;
}

function workAction(state, deps) {
  for (const wp of byDispatch(state)) {
    fill(state, wp, deps);
    if (!wp.queue.length || wp.queue[0].kind === 'wait' || wp.lane?.livenessHeld) continue;
    if (paid(wp.queue[0])) {
      const gate = budgetGate(state, deps, wp.id);
      if (gate === 'ended') {
        block(state, wp, deps, 'the budget was reached and the operator stopped new paid lane work');
        continue;
      }
      if (gate === 'halted') continue;
      if (gate) return gate;
    }
    return emitHead(wp);
  }
  if (spineOn(state)) {
    for (const touch of openBuildTouches(state)) {
      const spec = touchAction(state, touch);
      // A waiting touch is re-read by the yield below, or handed back when idle.
      if (spec && !spec.handBack) return spec;
    }
  }
  // A meter halt re-reads the spend when its wait is over.
  const meter = (state.build.halts ?? []).find((entry) => entry.kind === 'meter');
  if (meter && meterLeft(meter, deps.now()) <= 0 && !budgetEnded(state)) {
    Object.assign(meter, { waitLeftMs: READ_BACK_WAIT_MS, dueAt: null });
    if (deps.env?.WORKIT_SPEND_CMD) return spendAction(state, deps, 'meter');
  }
  if (state.dispatchHalt || !dispatchable(state, { now: deps.now() }).length) return null;
  const gate = budgetGate(state, deps, 'dispatch');
  if (gate === 'halted' || gate === 'ended') return workAction(state, deps);
  if (gate) return gate;
  return dispatch(state, dispatchable(state, { now: deps.now() })[0], deps);
}

// A wait ends at a wall-clock deadline (`dueAt`, stamped when it first heads a
// queue, is opened or is re-armed) or when the yields recorded against it add
// up to its length, whichever comes first. Yield credit alone starves: a lane
// poll's 0 ms re-wait is always due, so the build never yields while a lane
// runs, and every other wait would sit until that lane stopped.
const leftMs = (creditMs, dueAt, now) => Math.min(creditMs, dueAt ? Date.parse(dueAt) - now : Infinity);
const touchWaits = (state, touch) => !spineOn(state) || touch.waiting;
const meterLeft = (meter, now) => leftMs(meter.waitLeftMs, meter.dueAt, now);

function stampWaits(state, deps) {
  const now = deps.now();
  const due = (ms) => new Date(now + ms).toISOString();
  for (const wp of state.wps) {
    const head = wp.queue?.[0];
    if (head?.kind === 'wait' && !head.dueAt) head.dueAt = due(head.remainingMs ?? head.waitMs ?? 0);
  }
  for (const touch of openBuildTouches(state)) {
    if (touchWaits(state, touch) && !touch.waitDueAt) touch.waitDueAt = due(touch.waitLeftMs ?? READ_BACK_WAIT_MS);
  }
  const meter = (state.build.halts ?? []).find((entry) => entry.kind === 'meter');
  if (meter && !meter.dueAt) meter.dueAt = due(meter.waitLeftMs);
}

// Everything that is waiting, with what is left of its wait.
function yielders(state, deps) {
  const now = deps.now();
  const out = [];
  for (const wp of state.wps) {
    const head = wp.queue?.[0];
    if (head?.kind === 'wait') out.push({ ms: leftMs(head.remainingMs ?? head.waitMs ?? 0, head.dueAt, now), wp, step: head.step, note: `${wp.id}: ${head.instruction}` });
    const until = wp.state === 'pending' && wp.notBefore ? Date.parse(wp.notBefore) - now : 0;
    if (until > 0) out.push({ ms: until, step: 'admit', note: `${wp.id} may be dispatched again at ${wp.notBefore}` });
  }
  for (const touch of openBuildTouches(state)) {
    if (touchWaits(state, touch)) {
      const core = !spineOn(state);
      const refused = touch.refusal ? ` (their last answer could not be used: ${touch.refusal})` : '';
      const note = core ? `${touch.tag} is open: show the operator ${join(state.runDir, touch.file)}; they answer from their own terminal${refused}` : `${touch.tag}: no answer yet`;
      out.push({ ms: leftMs(touch.waitLeftMs ?? READ_BACK_WAIT_MS, touch.waitDueAt, now), touch, step: 'touch', note });
    }
  }
  const meter = (state.build.halts ?? []).find((entry) => entry.kind === 'meter');
  if (meter && !budgetEnded(state)) out.push({ ms: meterLeft(meter, now), meter, step: 'spend', note: `the spend meter is re-read: ${meter.reason}` });
  return out;
}

function release(y) {
  if (y.wp) y.wp.queue.shift();
  if (y.touch) {
    y.touch.waitLeftMs = null;
    y.touch.waitDueAt = null;
    y.touch.waiting = false;
  }
  if (y.meter) Object.assign(y.meter, { waitLeftMs: 0, dueAt: null });
}

// A core touch is announced before any other work, once per opening.
function announce(state) {
  const unseen = spineOn(state) ? null : openBuildTouches(state).find((touch) => touch.status === 'open' && !touch.announced);
  if (!unseen) return null;
  unseen.announced = true;
  return { kind: 'wait', step: 'touch', part: 'announce', yield: true, waitMs: 0,
    instruction: `Stop and show the operator ${join(state.runDir, unseen.file)}: ${unseen.tag} is open${unseen.refusal ? ` again (${unseen.refusal})` : ''}. They answer from their own terminal: ${answerCommand(state, unseen)}. Then record {}.` };
}

// The build ends when nothing is live, queued, occupying a lane, waiting on a
// WP's touch or on a meter re-read (unless budget (b) stopped paid work).
function settled(state, deps) {
  const now = deps.now();
  const busy = state.wps.some((wp) => LIVE_STATES.includes(wp.state) || laneOccupied(wp) || wp.queue?.length
    || (wp.state === 'pending' && wp.notBefore && Date.parse(wp.notBefore) > now));
  const metering = (state.build.halts ?? []).some((entry) => entry.kind === 'meter') && !budgetEnded(state);
  return !busy && !metering && !openBuildTouches(state).some((touch) => touch.wpId) && !dispatchable(state, { now }).length;
}

export function next(state, deps) {
  state.build ??= { contract: null, halts: [] };
  if (!state.build.contract) return contractAction(state, deps);
  applyAnswers(state, deps);
  deferrals(state, deps);
  stampWaits(state, deps);
  const first = announce(state);
  if (first) return first;
  for (let pass = 0; pass < 8; pass += 1) {
    const action = workAction(state, deps);
    // Scheduling can open a touch (the budget): its announce goes first, and
    // the prepared action is derived again from the queue at the next `next`.
    const opened = announce(state);
    if (opened) return opened;
    if (action) return action;
    // A run touch (no wpId) still open stays open into the showcase (D16).
    if (settled(state, deps)) break;
    const waiting = yielders(state, deps);
    const due = waiting.filter((y) => y.ms <= 0);
    if (due.length) {
      due.forEach(release);
      continue;
    }
    // Nothing but spine touches to wait on (no lane poll, re-admission or meter
    // re-read that can act): only the operator can move the build, so it hands
    // back. A meter with WORKIT_SPEND_CMD unset never re-reads; a set one does.
    const touchYield = waiting.find((y) => y.touch);
    const operatorOnly = (y) => y.touch || (y.meter && !deps.env?.WORKIT_SPEND_CMD);
    if (spineOn(state) && touchYield && waiting.every(operatorOnly)) return handBackAction(state, touchYield.touch);
    if (waiting.length) {
      const least = waiting.reduce((a, b) => (b.ms < a.ms ? b : a));
      return { kind: 'wait', step: least.step, part: 'yield', yield: true, waitMs: least.ms,
        instruction: `Wait ${least.ms / 1000} s, then record {}. Waiting: ${waiting.map((y) => y.note).join('; ')}` };
    }
    break;
  }
  if (!settled(state, deps)) {
    const busy = state.wps.map((wp) => `${wp.id} ${wp.state}${wp.stage ? ` at ${wp.stage}` : ''}${wp.queue?.length ? ` (${wp.queue.length} queued)` : ''}`).join(', ');
    throw new ConductError(2, `the build has no action to emit and has not ended: ${busy}`);
  }
  appendEvent(state, deps, { event: 'build-ended', data: { wps: state.wps.map((wp) => ({ id: wp.id, state: wp.state, reason: wp.reason ?? null })) } });
  state.phase = 'release';
  return null;
}

// ---- record ----

function recordYield(state, action) {
  for (const wp of state.wps) {
    const head = wp.queue?.[0];
    if (head?.kind !== 'wait') continue;
    const left = (head.remainingMs ?? head.waitMs ?? 0) - action.waitMs;
    if (left <= 0) wp.queue.shift();
    else head.remainingMs = left;
  }
  for (const touch of openBuildTouches(state)) {
    if (spineOn(state) && !touch.waiting) continue;
    const left = (touch.waitLeftMs ?? READ_BACK_WAIT_MS) - action.waitMs;
    if (left > 0) touch.waitLeftMs = left;
    else release({ touch });
  }
  const meter = (state.build.halts ?? []).find((entry) => entry.kind === 'meter');
  if (meter) meter.waitLeftMs = Math.max(0, meter.waitLeftMs - action.waitMs);
}

// Only a non-empty, finite, non-negative number is a spend; anything else
// halts dispatch (fail closed).
function recordSpend(state, action, result, deps) {
  const text = String(result.stdout ?? '').trim();
  const usd = result.code === 0 && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
  const budget = state.authority?.budgetUsd ?? 0;
  if (!Number.isFinite(usd)) return meterHalt(state, deps, `The spend command's output is unreadable (exit ${result.code}: ${JSON.stringify(text.slice(0, 80))}${result.stderr ? `, ${lines(result.stderr)[0]}` : ''}), so spend is unknown (metered by the spend adapter)`);
  // Only a successful read clears the meter halt; it is kept for the audit.
  state.build.lastSpend = { usd, at: deps.timestamp() };
  state.build.halts = (state.build.halts ?? []).filter((entry) => entry.kind !== 'meter');
  syncHalt(state, deps);
  if (usd >= budget) return haltTouch(state, deps, `Spend is $${usd} against the $${budget} budget (metered by the spend adapter)`, 'budget', usd);
  state.build.spendOkFor = action.budgetFor === 'meter' ? 'dispatch' : action.budgetFor ?? 'dispatch';
  return undefined;
}

function recordRuling(state, wp, action, deps) {
  const value = readJsonFile(deps, action.outPath, 'ruling');
  const { n, file, keys, asks, row } = action.ruling;
  if (value?.escalate === true) {
    if (typeof value.why !== 'string' || !value.why.trim()) throw new ConductError(2, `ruling ${file}: an escalation needs a non-empty why`);
    wp.rulings = [...(wp.rulings ?? []), { n, file, ruled: null, escalate: true }];
    // The rest of the owed adjudication (other replies and rulings) waits for the answer.
    if (row) wp.owed = { ...(wp.owed ?? {}), queue: wp.queue.slice(1) };
    wp.queue = [];
    return escalate(state, wp, deps, { why: value.why, asks, row });
  }
  if (!keys.includes(value?.ruled)) throw new ConductError(2, `ruling ${file}: ruled must be one of ${keys.join(', ')} (got ${value?.ruled})`);
  if (typeof value.evidence !== 'string' || !value.evidence.trim()) throw new ConductError(2, `ruling ${file}: evidence must name the measurement or file that settles the fork`);
  wp.rulings = [...(wp.rulings ?? []), { n, file, ruled: value.ruled, escalate: false }];
  wp.queue.shift();
  if (row) {
    wp.queue = [...conductorVerdict(state, wp, row, value.ruled, deps), ...wp.queue];
    return undefined;
  }
  return startAmendment(state, wp, deps, { kind: 'ruling', reason: `ruling ${file}: (${value.ruled})`, ruled: value.ruled, evidence: value.evidence });
}

// Steps the build performs or checks itself; undefined means "not mine".
function recordOwn(state, wp, action, result, deps) {
  const ok = () => {
    wp.queue.shift();
    return true;
  };
  switch (action.step === 'review' || action.step === 'council' ? `${action.step}/${action.part}` : action.step) {
    case 'flip':
    case 'receipt': {
      const failed = spineAckFailure(action, result);
      if (failed) throw new ConductError(2, `${action.tool}: ${failed}`);
      return ok();
    }
    case 'brief':
      if (!deps.exists(action.outPath)) throw new ConductError(2, `the brief ${action.outPath} was not written`);
      if (action.marker && !(readText(deps, action.outPath) ?? '').includes(action.marker)) {
        throw new ConductError(2, `the brief ${action.outPath} does not carry amendment ${action.amendment.n}'s marker line: ${action.marker}`);
      }
      return ok();
    case 'ruling': return recordRuling(state, wp, action, deps) ?? true;
    case 'council/meta':
      if (readJsonFile(deps, action.outPath, 'council meta')?.title !== action.title) throw new ConductError(2, `${action.outPath} must be { "title": "${action.title}" }`);
      return ok();
    case 'notify':
      if (result.code !== 0) appendEvent(state, deps, { step: 'notify', event: 'notify-failed', data: { wpId: wp.id, code: result.code } });
      return ok();
    case 'gate-cmd':
      if (result.code === 0) return ok();
      if (mergeLockFor(state, wp) === 'mine') state.mergeLock = null;
      wp.queue = [];
      return gateAmend(state, wp, deps, `the gate command exited ${result.code} at the rebased head: ${lines(result.stderr || result.stdout)[0] ?? ''}`) ?? true;
    case 'review/diff':
    case 'review/amend-diff': {
      if (result.code !== 0) return block(state, wp, deps, `${action.command.slice(0, 3).join(' ')} failed: ${lines(result.stderr)[0] ?? `exit ${result.code}`}`) ?? true;
      const changed = lines(result.stdout);
      const report = laneLayout(state, wp).reportPath;
      const absolute = changed.map((path) => join(wp.lane.worktree, path));
      wp.queue.shift();
      if (action.part === 'amend-diff') {
        // An executable line: any changed file that is not Markdown, tests and fixtures counted (D19.7, D20).
        if (!changed.some((path) => !path.toLowerCase().endsWith('.md') || isTestPath(path))) return (wp.stage = 'land');
        setState(state, wp, 'review', null, deps);
        wp.queue = emitting(state, wp, deps, () => withMeta(state, wp, deltaReviewActions(state, wp, wp.amendment.since, { report, changedPaths: absolute })));
        return (wp.stage = wp.state === 'blocked' ? null : 'reviewed');
      }
      const config = repoConfig(state, deps);
      wp.changedPaths = changed;
      wp.tier = tierFor(wp, changed, Array.isArray(config.contractPaths) ? config.contractPaths : []);
      if (effectiveTier(wp) === 'T0') return (wp.stage = 'land');
      setState(state, wp, 'review', null, deps);
      const round = latestRound(wp) + 1;
      wp.queue = emitting(state, wp, deps, () => (wp.tier === 'T2' ? withMeta(state, wp, t2Actions(state, wp, { round, changedPaths: absolute, report })) : reviewActions(state, wp, { round, report })));
      return (wp.stage = wp.state === 'blocked' ? null : 'reviewed');
    }
    default:
      return undefined;
  }
}

// Liveness needs affirmative evidence (WP-02 additions, D21): a running read
// (exit 0), or an exit-1 read with a parsed `owner` of gone or reused or a
// dead pid, is certain and resets the count. An exit-1 read with anything
// else (unparseable, empty, unverified with the pid alive) keeps the slot and
// Files and polls again; only reads past the deadline count, and the third
// blocks the WP once, visibly: slot, Files and stop held, no more polling,
// and a touch whose answer is the only release. An error read (any other
// exit) is the recorder's and never resets the count.
function liveness(state, wp, action, result, deps) {
  if (wp.lane?.backend !== 'exec' || !['wait', 'stop'].includes(action.step) || action.part === 'kill') return null;
  let owner = null;
  try {
    owner = JSON.parse(result.stdout)?.owner ?? null;
  } catch { /* unparseable: no evidence either way */ }
  if (result.code === 0 || (result.code === 1 && (owner === 'gone' || owner === 'reused' || !Number.isInteger(wp.lane.pid) || !deps.pidAlive(wp.lane.pid)))) {
    wp.lane.uncertain = 0;
    return null;
  }
  if (result.code !== 1) return null;
  const past = Boolean(wp.lane.deadline) && deps.now() > Date.parse(wp.lane.deadline);
  const count = (wp.lane.uncertain ?? 0) + (past ? 1 : 0);
  wp.lane.uncertain = count;
  appendEvent(state, deps, { step: action.step, event: 'liveness-uncertain', data: { wpId: wp.id, pid: wp.lane.pid, owner, count, pastDeadline: past } });
  if (count < UNCERTAIN_BLOCK) {
    wp.queue = [waitSpec(action.step, WAIT_MS, `${wp.id}'s pid ${wp.lane.pid} is not shown exited: poll again.`), ...wp.queue];
    return 'polling';
  }
  const reason = `lane liveness unverifiable past the deadline: ${count} reads (${owner ? `owner ${owner}` : 'unparseable lane alive output'}); pid ${wp.lane.pid} keeps its slot`;
  if (LIVE_STATES.includes(wp.state) || wp.state === 'blocked') block(state, wp, deps, reason);
  else wp.cleanup = reason;
  wp.lane.livenessHeld = true;
  wp.queue = backendOf(state, wp, deps).stop(wp);
  buildTouch(state, deps, 'liveness', {
    question: `DO: check whether ${wp.id}'s lane agent (pid ${wp.lane.pid}) still runs; the conductor cannot verify it. ${reason}. EXPECT: (a) you confirm the process is gone: its slot and Files are released; (b) they stay held.`,
    options: [option('a', 'The process is gone: release the slot', 'Its slot and Files are released; the WP keeps its state.'), option('b', 'Keep the slot held', 'Nothing runs for it.')],
    wpId: wp.id, suspendedStep: 'stop',
  });
  return 'polling';
}

// "No CI at head" is not lane-fixable (C1-2, C2-8). No CI workflow (0): stop
// at once. Known CI (> 0) or an unread count (null): wait out 30 minutes per
// head from the first absent-or-pending observation (land's pendingSince when
// it has one), then stop. Stopping blocks, or holds when the run has no merge
// authority (the operator merges). The gate JSON is still recorded.
function noCi(state, wp, action, out, deps) {
  if (out.outcome !== 'amend' || action.step !== 'gate' || action.part !== 'gate') return out;
  const gate = out.patch?.gate;
  if (!gate?.failures?.includes('no CI at head') || (gate.causes ?? []).some((cause) => cause !== 'ci')) return out;
  const hold = state.authority?.merge !== true;
  const stop = (reason) => ({ ...out, outcome: hold ? 'held' : 'block', reason: hold ? `held at PR: ${reason}` : reason, patch: { ...out.patch, noCi: null } });
  const count = state.intent.ciWorkflows;
  if (count === 0) return stop('no CI at head: the repo has no CI workflow that can gate a PR');
  const since = Date.parse(gate.pendingSince ?? (wp.noCi?.head === gate.head ? wp.noCi.since : new Date(deps.now()).toISOString()));
  if (deps.now() - since >= NO_CI_WINDOW_MS) return stop(count > 0 ? 'CI did not complete at head' : 'CI state unknown: the workflow count could not be read');
  const { mergeLock, ...patch } = out.patch;
  const again = Object.fromEntries(Object.entries(action).filter(([key]) => !['id', 'phase', 'wpId'].includes(key)));
  return { outcome: 'wait', waitMs: WAIT_MS, reason: 'no CI run at head yet', patch: { ...patch, noCi: { head: gate.head, since: new Date(since).toISOString() }, queue: [again, ...wp.queue.slice(1)] } };
}

function applyPatch(state, wp, patch, reason, deps) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'queue') wp.queue = [...value];
    else if (key === 'lane') wp.lane = { ...(wp.lane ?? {}), ...value };
    else if (key === 'state') setState(state, wp, value, reason, deps);
    else if (key === 'mergeLock' || key === 'dispatchHalt') state[key] = value;
    else wp[key] = value;
  }
}

function route(state, wp, action, out, deps) {
  const patch = out.patch ?? {};
  const cleanup = action.step === 'stop';
  const before = (wp.reviews ?? []).length;
  applyPatch(state, wp, patch, out.reason ?? undefined, deps);
  if (!Object.hasOwn(patch, 'queue')) wp.queue.shift();
  switch (out.outcome) {
    case 'continue': {
      // After a fallback, the agent now running is the PR's author for reviewer choice.
      if (action.step === 'fallback' && patch.lane?.fallback) wp.agent = patch.lane.fallback;
      // A land patch that replaces the queue moves the stage with it.
      if (patch.queue?.some((a) => a.step === 'rebase' && a.part === 'fetch')) wp.stage = 'gate';
      else if (patch.queue?.some((a) => ['review', 'post'].includes(a.step) || (a.step === 'council' && a.part === 'review'))) {
        wp.queue = withMeta(state, wp, wp.queue);
        wp.stage = 'reviewed';
      }
      const added = (wp.reviews ?? []).length > before ? wp.reviews.at(-1) : null;
      // Zero findings (D20): no amendment, adjudication or resolve; the rest of the review array is dropped.
      if (added?.findings === 0) {
        wp.queue = [];
        wp.stage = 'land';
      }
      return;
    }
    case 'wait':
      if (wp.queue[0]?.kind !== 'wait') wp.queue.unshift(waitSpec(action.step, out.waitMs ?? WAIT_MS));
      return;
    case 'done':
      if (cleanup) wp.cleanup = null;
      else if (action.step === 'merged') merged(state, wp, deps);
      else if (wp.state === 'pending') Object.assign(wp, { stage: null, dispatchedAt: null }); // admission refused (exit 7)
      else wp.stage = null;
      return;
    case 'held':
      setState(state, wp, 'held', out.reason, deps);
      wp.stage = null;
      wp.queue.push(...backendOf(state, wp, deps).stop(wp));
      return;
    case 'amend':
      return LANE_STEPS.has(action.step) ? checkFailed(state, wp, deps, out.reason) : gateAmend(state, wp, deps, out.reason);
    case 'block':
      // A cleanup action's record never changes the WP's state.
      if (cleanup) {
        if (out.cause !== 'cleanup-unresolved') return;
        wp.cleanup = out.reason;
        appendEvent(state, deps, { step: 'stop', event: 'cleanup-unresolved', data: { wpId: wp.id, reason: out.reason } });
        wp.queue.unshift(waitSpec('stop', CLEANUP_RETRY_MS, `${wp.id}'s lane did not confirm its stop; retrying.`));
        return;
      }
      if (out.cause === 'needs-conductor') {
        wp.stage = null;
        wp.queue.push(rulingAction(state, wp, { asks: wp.asks ?? [] }));
        return;
      }
      block(state, wp, deps, patch.dispatchHalt ? 'merged tree differs from the checked head' : out.reason);
      if (patch.dispatchHalt) haltTouch(state, deps, `${wp.id}'s merged tree differs from the checked head (${out.reason})`, 'merged');
      if (out.cause === 'dialog') {
        buildTouch(state, deps, 'dialog', {
          question: `DO: clear the dialog in ${wp.id}'s lane pane (${wp.lane?.name ?? ''}); the conductor never answers one. The dialog: ${out.dialog ?? out.reason}. EXPECT: (a) the lane is re-prompted and resumes; (b) ${wp.id} stays blocked.`,
          options: [option('a', 'Dialog cleared: resume the lane', 'The lane is re-prompted with an amendment.'), option('b', `Leave ${wp.id} blocked`, 'Nothing more runs for it.')],
          wpId: wp.id, suspendedStep: 'wait',
        });
      }
      return;
    default:
      throw new ConductError(2, `${wp.id}: no route for outcome ${out.outcome} of ${action.step}`);
  }
}

export function record(state, action, result = {}, deps) {
  state.build ??= { contract: null, halts: [] };
  if (action.step === 'contract') return recordContract(state, action, deps);
  if (action.yield) return recordYield(state, action);
  if (action.touch) return recordTouch(state, state.touches[action.touch.n - 1], action, result);
  if (action.step === 'spend') return recordSpend(state, action, result, deps);
  const wp = state.wps.find((candidate) => candidate.id === action.wpId);
  if (!wp) throw new ConductError(2, `action ${action.id} names no WP of this run (${action.wpId})`);
  if (recordOwn(state, wp, action, result, deps) !== undefined) return undefined;
  const recorderDeps = { exec: deps.exec, read: deps.read, now: deps.now, platform: deps.platform, env: deps.env, pluginRoot: deps.pluginRoot };
  if (LANE_STEPS.has(action.step)) {
    if (liveness(state, wp, action, result, deps) === 'polling') return undefined;
    return route(state, wp, action, recordLaneStep(state, wp, action, result, recorderDeps), deps);
  }
  if (LAND_STEPS.has(action.step)) return route(state, wp, action, noCi(state, wp, action, recordLandStep(state, wp, action, result, recorderDeps), deps), deps);
  throw new ConductError(2, `the build has no route for step ${action.step}`);
}
