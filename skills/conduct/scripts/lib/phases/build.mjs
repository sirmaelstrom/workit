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
// state.build { contract, spendOk, resumed }; wps[] stage, amendment,
// checkAmends, asks, replyIds, rulingSeq, deferredBy, changedPaths, gateCmd,
// cleanup; touches[] build (why the build opened it), applied, waitLeftMs; a
// queued wait's remainingMs; an emitted action's wpId and, on the one
// yielding wait, `yield: true`.
import { join } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { shellArgv } from '../exec.mjs';
import { LIVE_STATES, dispatchable, laneOccupied } from '../schedule.mjs';
import { chooseBackend, laneBackend, laneLayout, recordLaneStep } from '../lanes.mjs';
import {
  deltaReviewActions, effectiveTier, isTestPath, mergeActions, mergeLockFor, parseAmendmentTable, rebaseActions,
  recordAdjudication, recordLandStep, resolveThreadActions, reviewActions, t2Actions, tierFor,
} from '../land.mjs';
import { READ_BACK_WAIT_MS, conductScript, openTouch, recordTouch, touchAction } from '../touch.mjs';

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
    ? `council review round ${a.round} (synthesis in ${a.reviewDir}) has ${a.ids.length} Critical/Major finding(s). Write them into this brief numbered ${a.ids.join(', ')} in synthesis order; the lane's ## Amendment table uses those ids.`
    : `review round ${a.round} posted ${a.findings ?? 'an unknown number of'} finding(s) as PR review comments; the lane adjudicates each in an ## Amendment table keyed by its comment id.`),
};

function amendmentBrief(state, wp, amendment) {
  const outPath = wp.lane?.briefPath ?? laneLayout(state, wp).briefPath;
  const kind = AMEND_TEXT[amendment.kind] ? amendment.kind : 'check';
  return {
    kind: 'author', step: 'brief', part: 'amendment', outPath, amendment, expects: { type: 'file' },
    instruction: `Rewrite ${outPath} as amendment ${amendment.n} for ${wp.id}'s lane (same worktree, same report ${laneLayout(state, wp).reportPath}): ${AMEND_TEXT[kind](amendment)} The lane appends ## Amendment ${amendment.n} to its report (lane contract § Finish, step 4). Record {}.`,
  };
}

// A ruling on a lane's asks (part ask) or on a guard row (part guard, D20).
function rulingAction(state, wp, { asks = null, row = null }) {
  wp.rulingSeq = Math.max(wp.rulingSeq ?? 0, (wp.rulings ?? []).length) + 1;
  const n = wp.rulingSeq;
  const file = `rulings/${lower(wp)}-${n}.json`;
  const keys = row ? ['confirmed', 'refuted', 'judgment'] : (asks ?? []).map((ask) => ask.key);
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

const withMeta = (state, wp, actions) => (actions.some((a) => a.step === 'council' && a.part === 'review') ? [metaAction(state, wp), ...actions] : actions);

// ---- touches the build opens (D19.3, D19.4, D19.8, D16) ----

function buildTouch(state, deps, why, fields) {
  const touch = openTouch(state, { kind: 'blocked', allowFreeText: false, did: `conduct ${state.slug}: build phase`, ...fields }, deps);
  touch.build = why;
  return touch;
}

const option = (key, label, consequence) => ({ key, label: String(label).slice(0, 120), consequence: String(consequence).slice(0, 240) });

function haltTouch(state, deps, reason, why) {
  state.dispatchHalt = { reason, since: deps.timestamp() };
  buildTouch(state, deps, why, {
    question: `DO: decide whether conduct ${state.slug} dispatches more lanes. ${reason}. EXPECT: (a) dispatch resumes; (b) no new lane starts, the live ones finish, and the build ends.`,
    options: [option('a', 'Resume dispatch', 'New lanes start again.'), option('b', 'End the build', 'Live lanes finish; nothing new is dispatched.')],
  });
}

function escalate(state, wp, deps, { why, asks = null, row = null }) {
  const options = row ? ['confirmed', 'refuted', 'judgment'].map((v, i) => option('abc'[i], v, `Reply ${v} to comment ${row.comment}, through the lane.`))
    : (asks?.length ? asks.map((ask) => option(ask.key, ask.text, `The lane is amended with (${ask.key}) and resumes at its check.`)) : [option('a', 'Resume the lane', 'The lane is amended with your text.')]);
  const verbatim = row ? `the guard row for comment ${row.comment}: ${row.evidence}` : (asks ?? []).map((ask) => ask.text).join(' / ');
  buildTouch(state, deps, row ? 'guard' : 'ask', {
    question: `DO: settle ${wp.id}'s fork; the conductor escalated it (${why}). The lane's words, verbatim: ${verbatim}. EXPECT: ${wp.id}'s lane is amended with your answer verbatim and resumes at its check.`.slice(0, 2000),
    options, wpId: wp.id, suspendedStep: 'check',
  });
  setState(state, wp, 'blocked', `escalated to the operator: ${why}`, deps);
  wp.stage = null;
}

// An answered build touch acts once: a WP touch amends its lane; a run touch's
// (a) clears dispatchHalt and (b) leaves it set.
function applyAnswers(state, deps) {
  for (const touch of state.touches ?? []) {
    if (!touch.build || touch.status !== 'answered' || touch.applied) continue;
    touch.applied = true;
    const { key, text } = touch.answer;
    appendEvent(state, deps, { step: 'touch', event: 'answer-applied', data: { n: touch.n, key, wpId: touch.wpId } });
    if (!touch.wpId) {
      if (key === 'a') {
        state.dispatchHalt = null;
        if (touch.build === 'budget') state.build.resumed = true;
      }
      continue;
    }
    const wp = state.wps.find((candidate) => candidate.id === touch.wpId);
    if (!wp || wp.state !== 'blocked' || (touch.build === 'dialog' && key === 'b')) continue;
    startAmendment(state, wp, deps, { kind: 'answer', reason: `operator answer ${key} to touch ${touch.n}`, tag: touch.tag, key, text, answer: touch.answer });
  }
}

const openBuildTouches = (state) => (state.touches ?? []).filter((touch) => touch.build && touch.status !== 'answered');

// ---- WP transitions ----

function startAmendment(state, wp, deps, { retry = false, answer = null, ...fields }) {
  const prev = wp.amendment;
  const n = (prev?.n ?? 0) + 1;
  wp.amendment = retry && prev ? { ...prev, n, reason: fields.reason } : { n, since: wp.pr?.head ?? null, adjudicated: false, ...fields, kind: fields.kind ?? 'check' };
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

function block(state, wp, deps, reason) {
  setState(state, wp, 'blocked', reason, deps);
  wp.stage = null;
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
  startAmendment(state, wp, deps, { kind: 'findings', reason: `review round ${review.round}: ${review.findings ?? 'unknown'} finding(s)`, round: review.round, findings: review.findings, ids, reviewDir });
}

// The amended report's table feeds recordAdjudication (step adjudicate): its
// replies, then a ruling per guard row; thread resolution follows.
function adjudicate(state, wp, deps) {
  const rows = parseAmendmentTable(readText(deps, laneLayout(state, wp).reportPath) ?? '');
  let adjudication;
  try {
    if (!rows.length) throw new ConductError(2, 'the report has no ## Amendment table (| Comment | Verdict | Evidence | Commit |)');
    adjudication = recordAdjudication(state, wp, rows);
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    return checkFailed(state, wp, deps, error.message);
  }
  wp.amendment.adjudicated = true;
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
      const findings = wp.reviews?.length && wp.amendment?.kind === 'findings' && !wp.amendment.adjudicated;
      if (findings && !adjudicate(state, wp, deps)) return undefined;
      wp.checkAmends = 0;
      if (wp.state !== 'pr') setState(state, wp, 'pr', null, deps);
      if (findings) return undefined;
      if (!wp.reviews?.length) return go([shell('review', 'diff', ['gh', 'pr', 'diff', '{pr.number}', '--repo', state.intent.repo.remote, '--name-only'])], null);
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
      if ((wp.reviews ?? []).at(-1)?.scope !== 'full' || !since || since === wp.pr?.head) return go([], 'land');
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
      return go([...(why ? [] : [shell('gate-cmd', 'gate-cmd', shellArgv(command, deps.platform), { cwd: wp.lane.worktree })]), gate], 'merge');
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

// Before each dispatch: the metered spend, or the lane-only lower bound (D16, D19.28).
function budgetGate(state, deps) {
  if (state.build.resumed) return null;
  const budget = state.authority?.budgetUsd ?? 0;
  if (state.adapters?.spend?.on) {
    if (state.build.spendOk) return null;
    return shell('spend', 'spend', shellArgv(`${deps.env?.WORKIT_SPEND_CMD} ${state.createdAt}`, deps.platform),
      { instruction: 'Run this exact argv; it prints the run\'s spend in USD. Record its { code, stdout, stderr }.' });
  }
  const sum = state.wps.reduce((total, wp) => total + (Number(wp.lane?.costUsd) || 0), 0);
  if (sum >= budget) haltTouch(state, deps, `Spend is $${sum} against the $${budget} budget (unmetered, lane-only lower bound)`, 'budget');
  return null;
}

function dispatch(state, wp, deps) {
  const chosen = chooseBackend(state, deps);
  if (state.adapters?.herdr?.on && chosen.backend !== 'herdr') state.adapters.herdr.detail = chosen.detail;
  wp.lane = { backend: chosen.backend };
  wp.agent = state.intent.agent;
  wp.commit = /^\*\*Commit:\*\*\s*`([^`]+)`/m.exec(readText(deps, wp.specPath ?? '') ?? '')?.[1] ?? null;
  Object.assign(wp, { queue: [], stage: 'admit', checkAmends: 0, dispatchedAt: deps.timestamp() });
  setState(state, wp, 'dispatched', null, deps);
  state.build.spendOk = false;
  fill(state, wp, deps);
  return wp.queue.length ? emitHead(wp) : null;
}

function workAction(state, deps) {
  for (const wp of byDispatch(state)) {
    fill(state, wp, deps);
    if (wp.queue.length && wp.queue[0].kind !== 'wait') return emitHead(wp);
  }
  if (spineOn(state)) {
    for (const touch of openBuildTouches(state)) {
      const spec = touchAction(state, touch);
      if (spec && spec.kind !== 'wait') return spec;
    }
  }
  if (state.dispatchHalt || !dispatchable(state, { now: deps.now() }).length) return null;
  const spend = budgetGate(state, deps);
  if (spend) return spend;
  const ready = dispatchable(state, { now: deps.now() });
  return ready.length ? dispatch(state, ready[0], deps) : workAction(state, deps);
}

// Everything that is waiting, with what is left of its wait.
function yielders(state, deps) {
  const out = [];
  for (const wp of state.wps) {
    const head = wp.queue?.[0];
    if (head?.kind === 'wait') out.push({ ms: head.remainingMs ?? head.waitMs ?? 0, wp, step: head.step, note: `${wp.id}: ${head.instruction}` });
    const until = wp.state === 'pending' && wp.notBefore ? Date.parse(wp.notBefore) - deps.now() : 0;
    if (until > 0) out.push({ ms: until, step: 'admit', note: `${wp.id} may be dispatched again at ${wp.notBefore}` });
  }
  for (const touch of openBuildTouches(state)) {
    const core = !spineOn(state);
    if (core || touch.waiting) {
      const note = core ? `${touch.tag} is open: show the operator ${join(state.runDir, touch.file)}; they answer from their own terminal` : `${touch.tag}: no answer yet`;
      out.push({ ms: touch.waitLeftMs ?? READ_BACK_WAIT_MS, touch, step: 'touch', note });
    }
  }
  return out;
}

function release(state, y) {
  if (y.wp) y.wp.queue.shift();
  if (y.touch) {
    y.touch.waitLeftMs = null;
    y.touch.waiting = false;
  }
}

function settled(state, deps) {
  const now = deps.now();
  const busy = state.wps.some((wp) => LIVE_STATES.includes(wp.state) || laneOccupied(wp) || wp.queue?.length
    || (wp.state === 'pending' && wp.notBefore && Date.parse(wp.notBefore) > now));
  return !busy && !openBuildTouches(state).some((touch) => touch.wpId) && !dispatchable(state, { now }).length;
}

export function next(state, deps) {
  state.build ??= { contract: null, spendOk: false, resumed: false };
  if (!state.build.contract) return contractAction(state, deps);
  applyAnswers(state, deps);
  deferrals(state, deps);
  for (let pass = 0; pass < 8; pass += 1) {
    const action = workAction(state, deps);
    if (action) return action;
    // A run touch (no wpId) still open stays open into the showcase (D16).
    if (settled(state, deps)) break;
    const waiting = yielders(state, deps);
    const due = waiting.filter((y) => y.ms <= 0);
    if (due.length) {
      due.forEach((y) => release(state, y));
      continue;
    }
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
    else release(state, { touch });
  }
}

function recordSpend(state, result, deps) {
  const usd = result.code === 0 ? Number(String(result.stdout ?? '').trim()) : NaN;
  const budget = state.authority?.budgetUsd ?? 0;
  if (!Number.isFinite(usd)) return haltTouch(state, deps, `The spend command's output is unreadable (exit ${result.code}: ${lines(result.stderr || result.stdout)[0] ?? ''}), so spend is unknown (metered by the spend adapter)`, 'budget');
  if (usd >= budget) return haltTouch(state, deps, `Spend is $${usd} against the $${budget} budget (metered by the spend adapter)`, 'budget');
  state.build.spendOk = true;
  return undefined;
}

function recordRuling(state, wp, action, deps) {
  const value = readJsonFile(deps, action.outPath, 'ruling');
  const { n, file, keys, asks, row } = action.ruling;
  if (value?.escalate === true) {
    if (typeof value.why !== 'string' || !value.why.trim()) throw new ConductError(2, `ruling ${file}: an escalation needs a non-empty why`);
    wp.rulings = [...(wp.rulings ?? []), { n, file, ruled: null, escalate: true }];
    wp.queue = [];
    return escalate(state, wp, deps, { why: value.why, asks, row });
  }
  if (!keys.includes(value?.ruled)) throw new ConductError(2, `ruling ${file}: ruled must be one of ${keys.join(', ')} (got ${value?.ruled})`);
  if (typeof value.evidence !== 'string' || !value.evidence.trim()) throw new ConductError(2, `ruling ${file}: evidence must name the measurement or file that settles the fork`);
  wp.rulings = [...(wp.rulings ?? []), { n, file, ruled: value.ruled, escalate: false }];
  wp.queue.shift();
  if (row) {
    wp.replyIds = [...(wp.replyIds ?? []), row.comment];
    wp.queue = [...guardReply(state, wp, row, value.ruled), ...wp.queue];
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
  const toolFailed = (r) => !r || typeof r !== 'object' || r.error || r.isError;
  switch (action.step === 'review' || action.step === 'council' ? `${action.step}/${action.part}` : action.step) {
    case 'flip':
    case 'receipt':
      if (toolFailed(result)) throw new ConductError(2, `${action.tool} failed: ${JSON.stringify(result?.error ?? result).slice(0, 200)}`);
      return ok();
    case 'brief':
      if (!deps.exists(action.outPath)) throw new ConductError(2, `the brief ${action.outPath} was not written`);
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
      return startAmendment(state, wp, deps, { kind: 'gate', reason: `the gate command exited ${result.code} at the rebased head: ${lines(result.stderr || result.stdout)[0] ?? ''}` }) ?? true;
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

// Fail closed (WP-02 additions, D21): `owner: unverified` from a lane this
// build has not seen exit still holds its slot and Files; poll until the pid
// is gone. Past the deadline the recorder blocks and queues the stop.
function unverified(state, wp, action, result, deps) {
  if (wp.lane?.backend !== 'exec' || !['wait', 'stop'].includes(action.step) || action.part === 'kill') return null;
  let owner = null;
  try {
    owner = JSON.parse(result.stdout)?.owner;
  } catch { /* not alive's output */ }
  if (owner !== 'unverified') return null;
  if (action.step === 'wait' && wp.lane.deadline && deps.now() > Date.parse(wp.lane.deadline)) return { ...result, code: 0 };
  appendEvent(state, deps, { step: action.step, event: 'owner-unverified', data: { wpId: wp.id, pid: wp.lane.pid } });
  wp.queue = [waitSpec(action.step, WAIT_MS, `${wp.id}'s pid ${wp.lane.pid} cannot be verified: poll until it is gone.`), ...wp.queue];
  return 'polling';
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
      return LANE_STEPS.has(action.step) ? checkFailed(state, wp, deps, out.reason) : startAmendment(state, wp, deps, { kind: 'gate', reason: out.reason });
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
  state.build ??= { contract: null, spendOk: false, resumed: false };
  if (action.step === 'contract') return recordContract(state, action, deps);
  if (action.yield) return recordYield(state, action);
  if (action.touch) return recordTouch(state, state.touches[action.touch.n - 1], action, result);
  if (action.step === 'spend') return recordSpend(state, result, deps);
  const wp = state.wps.find((candidate) => candidate.id === action.wpId);
  if (!wp) throw new ConductError(2, `action ${action.id} names no WP of this run (${action.wpId})`);
  if (recordOwn(state, wp, action, result, deps) !== undefined) return undefined;
  const recorderDeps = { exec: deps.exec, read: deps.read, now: deps.now, platform: deps.platform, env: deps.env, pluginRoot: deps.pluginRoot };
  if (LANE_STEPS.has(action.step)) {
    const checked = unverified(state, wp, action, result, deps);
    if (checked === 'polling') return undefined;
    return route(state, wp, action, recordLaneStep(state, wp, action, checked ?? result, recorderDeps), deps);
  }
  if (LAND_STEPS.has(action.step)) return route(state, wp, action, recordLandStep(state, wp, action, result, recorderDeps), deps);
  throw new ConductError(2, `the build has no route for step ${action.step}`);
}
