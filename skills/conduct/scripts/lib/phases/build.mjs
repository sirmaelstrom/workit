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
// state.build { contract, halts }; authority.budgetSource; wps[]
// stage, amendment, checkAmends, gateAmends, owed, asks, replyIds, rulingSeq,
// deferredBy, changedPaths, councilScope, gateCmd, noCi, cleanup, lane.uncertain,
// lane.livenessHeld; halts[] kinds budget | merged | replan;
// state.replans[] (n, why, delta, rests, file, mode, touch, receipt, answer);
// touches[] build (why the build opened it), applied, announced, waitLeftMs,
// waitDueAt, guard, spendUsd; a queued wait's remainingMs and dueAt; an
// emitted action's wpId and, on a yielding wait, `yield: true`.
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { shellArgv } from '../exec.mjs';
import { LIVE_STATES, dispatchable, filesDisjoint, laneOccupied, normalizePath } from '../schedule.mjs';
import { allowedMissing, chooseBackend, freshStart, laneBackend, laneLayout, recordLaneStep } from '../lanes.mjs';
import { deltaBaseline, verifyDeltaRecovery, discoverDeltaRecovery } from '../delta-recovery.mjs';
import { LEGACY_LANE_FROM, laneSuiteFrom, pinnedConfig } from '../repo-config.mjs';
import { isTopListItem, markLines, sectionLines } from '../markdown.mjs';
import { briefPaths } from '../../../../../scripts/lane.mjs';
import { bootstrapBrief } from '../bootstrap.mjs';
import {
  PRIOR_ADJUDICATION_FILE, councilRecord, deltaReviewActions, effectiveTier, isTestPath, mergeActions, mergeLockFor, parseAmendmentTable,
  priorAdjudicationBody, rebaseActions, recordAdjudication, recordLandStep, resolveThreadActions, reviewActions,
  t2Actions, tierDecision, visualReadProblem,
} from '../land.mjs';
import {
  QUESTION_MAX, READ_BACK_WAIT_MS, answerCommand, conductScript, filedLength, handBackAction, openTouch, recordTouch, spineAckFailure, touchAction, writeTouchFiles,
} from '../touch.mjs';
import { budgetAmount, runAuthority } from '../authority.mjs';
import { preapprovedRef } from './spec.mjs';

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
const STALL_FAILS = 3;
const STALL_MS = 30 * 60000;
const REVIEW_STALL_MS = 75 * 60000;
const ASK_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\([a-f]\)(?:\*\*|__)?\s*/i;
const GUARD_VERDICTS = ['confirmed', 'refuted', 'judgment'];
const FILL = { '{pr.number}': (wp) => wp.pr?.number, '{pr.head}': (wp) => wp.pr?.head, '{merge.sha}': (wp) => wp.merge?.sha };

const lower = (wp) => wp.id.toLowerCase();
const SHA = /^[0-9a-f]{7,40}$/i;
const lines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const spineOn = (state) => state.adapters?.spine?.on === true;
const contractPath = (state) => join(state.runDir, '_lane-contract.md');
const latestRound = (wp) => Math.max(0, ...(wp.reviews ?? []).map((review) => review.round ?? 0));
const backendOf = (state, wp, deps) => laneBackend(state, deps, wp.lane?.backend ?? 'exec');
function recoveryBaseline(state, wp, deps) {
  try {
    const review = (wp.reviews ?? []).at(-1);
    if (review?.scope === 'full' && wp.deltaRecovery && wp.deltaRecovery.reviewedHead !== review.head) wp.deltaRecovery = null;
    if (!wp.deltaRecovery && (wp.rebases ?? []).some((r) => r.from !== r.to) && review?.scope === 'full' && review.head !== wp.pr?.head) {
      let proof;
      try { proof = verifyDeltaRecovery(wp, review.head, deps); }
      catch (error) { if (!(error instanceof ConductError)) throw error; }
      proof ??= discoverDeltaRecovery(wp, deps);
      if (!proof) {
        const head = deps.exec('git', ['-C', wp.lane.worktree, 'rev-parse', 'HEAD']);
        const dirty = deps.exec('git', ['-C', wp.lane.worktree, 'status', '--porcelain']);
        if (head.code !== 0 || head.stdout.trim() !== wp.pr.head || dirty.code !== 0 || dirty.stdout.trim()) {
          throw new ConductError(5, `${wp.id}: cannot review the rebased candidate until its worktree is clean and HEAD matches its recorded PR head`);
        }
        wp.fullReviewOwed = { head: wp.pr.head, reason: 'no verified reviewed prefix after the rebase' };
        appendEvent(state, deps, { event: 'full-review-owed', data: { wpId: wp.id, ...wp.fullReviewOwed } });
        return null;
      }
      wp.deltaRecovery = proof;
      appendEvent(state, deps, { event: 'delta-baseline-mapped', data: { wpId: wp.id, ...proof } });
    }
    return deltaBaseline(wp);
  }
  catch (error) {
    if (!(error instanceof ConductError)) throw error;
    block(state, wp, deps, error.message);
    return null;
  }
}
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

function registeredHookCommands(wp, deps) {
  const commands = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'command' && typeof item === 'string') commands.push(item);
      else walk(item);
    }
  };
  for (const path of ['settings.json', '.claude/settings.json', '.claude/settings.local.json', '.codex/settings.json', '.agents/settings.json']) {
    const text = readText(deps, join(wp.lane.worktree, path));
    if (!text) continue;
    try { walk(JSON.parse(text).hooks); } catch { /* a changed settings file is T2 by path */ }
  }
  return commands;
}

export function hooksBlockChanged(state, wp, changed, deps) {
  if (state.intent.repo.remote !== 'sirmaelstrom/claude-config') return false;
  const path = changed.find((p) => p === 'settings.json' || p === '.claude/settings.json');
  if (!path) return false;
  const previous = deps.exec('git', ['-C', wp.lane.worktree, 'show', `origin/${state.intent.repo.defaultBranch ?? 'main'}:${path}`]);
  const current = readText(deps, join(wp.lane.worktree, path));
  try {
    return JSON.stringify(previous.code === 0 ? JSON.parse(previous.stdout).hooks ?? null : null)
      !== JSON.stringify(current ? JSON.parse(current).hooks ?? null : null);
  } catch {
    return true;
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

// The conduct-only keys: the workspace config pinned at intake, else the
// target repo's legacy .workit/conduct.json read from the checkout as before
// (absent → {}). lib/repo-config.mjs owns the split.
function legacyConfig(state, deps) {
  const path = join(state.intent.repo.path, '.workit', 'conduct.json');
  return deps.exists(path) ? readJsonFile(deps, path, 'repo config') : {};
}

function repoConfig(state, deps) {
  return pinnedConfig(state) ?? legacyConfig(state, deps);
}

// The lane-facing laneSuite: the checkout's AGENTS.md `## Lane suite`
// section, else the legacy file's laneSuite. { text, from } or null. A run
// whose state predates the split (no intent.repoConfig) reads only the legacy
// file, as it did when it started.
function laneSuiteOf(state, deps) {
  const legacy = () => laneSuiteFrom({ agentsText: null, legacyConfig: legacyConfig(state, deps) });
  if (!state.intent.repoConfig) return legacy();
  const agentsText = readText(deps, join(state.intent.repo.path, 'AGENTS.md'));
  return laneSuiteFrom({ agentsText, legacyConfig: null }) ?? legacy();
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

// The gate command's env, from the repo config's `gateEnv` (string values).
// `{run}` and `{wp}` become the run slug and the WP id as lowercase
// identifiers, so a repo can give the conductor's suite its own test database:
// the gate runs under the merge lock, so one per run never runs twice at once.
export function gateEnvFor(state, wp, config) {
  const env = config.gateEnv;
  if (env === undefined) return {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
    throw new ConductError(2, `${pinnedConfig(state) ? state.intent.repoConfig.path : '.workit/conduct.json'} gateEnv must be an object of string values`);
  }
  const ident = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const run = ident(state.slug), id = ident(wp.id);
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, fitRun(key, value, run, id)]));
}

// A gateEnv value names a database more often than not, and Postgres cuts an
// identifier at 63 bytes (deploy-truth probation H9: a 74-char name failed
// 115 suites). When `{run}` would take a value past 63, the run is shortened
// to fit and a hash of the whole run keeps two runs with one prefix apart.
const IDENT_MAX = 63;
function fitRun(key, value, run, wp) {
  const full = value.replaceAll('{run}', run).replaceAll('{wp}', wp);
  const uses = value.split('{run}').length - 1;
  if (full.length <= IDENT_MAX || !uses) return full;
  const hash = createHash('sha256').update(run).digest('hex').slice(0, 6);
  const fixed = value.replaceAll('{run}', '').replaceAll('{wp}', wp).length;
  const room = Math.floor((IDENT_MAX - fixed) / uses) - hash.length - 1;
  if (room < 1) throw new ConductError(2, `gateEnv ${key} cannot fit 63 characters with any {run} in it; shorten its fixed part`);
  const short = `${run.slice(0, room).replace(/_+$/, '')}_${hash}`;
  return value.replaceAll('{run}', short).replaceAll('{wp}', wp);
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

const suiteLine = (laneSuite, from) => `- **Suite ownership (${from}):** ${laneSuite} This overrides rule 9's "the full suite at the merge candidate is the conductor's, so don't run it" for this run.`;

function runDeltas(laneSuite, from) {
  return ['', '## Run deltas', '', suiteLine(laneSuite, from), ''].join('\n');
}

// The block-level list items of the contract's `## Run deltas` section, with
// sectionText's boundaries (the next ATX or setext heading, or a thematic
// break): fenced, quoted and indented-code lines are not instructions.
function runDeltaLines(text) {
  return sectionLines(text, 'Run deltas').filter(isTopListItem).map((line) => line.text);
}

function contractAction(state, deps) {
  const template = join(deps.pluginRoot ?? state.pluginRoot, 'reference', 'templates', 'lane-contract.template.md');
  const text = readText(deps, template);
  if (text === null) throw new ConductError(2, `the lane-contract template is unreadable at ${template}`);
  const suite = laneSuiteOf(state, deps);
  const laneSuite = suite?.text;
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
  const append = typeof laneSuite === 'string' && laneSuite.trim() ? runDeltas(laneSuite, suite.from) : null;
  return {
    kind: 'author', step: 'contract', template, outPath: contractPath(state), slots, ...(append ? { append } : {}), expects: { type: 'file' },
    // What this action was built from, so record checks the same text.
    laneSuite: suite ?? null,
    instruction: `Copy ${template} to ${contractPath(state)}, replacing each key of slots (its exact text, brackets included) with its value; a null value deletes the whole line that holds the slot. Leave every other <…> placeholder as it is.${append ? ' Then append the append text verbatim.' : ''} Record {}.`,
  };
}

function recordContract(state, action, deps) {
  const text = readText(deps, action.outPath);
  if (text === null) throw new ConductError(2, `the lane contract ${action.outPath} was not written`);
  const left = RUN_SLOTS.filter((prefix) => text.includes(prefix));
  if (left.length) throw new ConductError(2, `the lane contract still holds run-level slots: ${left.join(', ')}`);
  // The emitted action's laneSuite; an action stored by an older conduct.mjs has none, so it is read again.
  const suite = Object.hasOwn(action, 'laneSuite') ? action.laneSuite : laneSuiteOf(state, deps);
  if (suite && !/^## Run deltas\b/m.test(text)) {
    throw new ConductError(2, `the repo declares laneSuite (${suite.from}), and the lane contract has no ## Run deltas section saying it overrides rule 9`);
  }
  // For an AGENTS.md laneSuite the emitted Suite ownership line itself must be
  // a line of the Run deltas section: unfenced, unquoted, before any further
  // heading (workit#246 review). The legacy source keeps its old heading-only
  // check, unchanged.
  if (suite && suite.from !== LEGACY_LANE_FROM) {
    const flat = (value) => String(value).replace(/\s+/g, ' ').trim();
    const want = flat(suiteLine(suite.text, suite.from));
    if (!runDeltaLines(text).some((line) => flat(line) === want)) {
      throw new ConductError(2, `the lane contract's ## Run deltas section does not carry the laneSuite text from ${suite.from}`);
    }
  }
  state.build.contract = action.outPath;
  // Where the lane-facing text came from, for the run analysis.
  state.build.laneSuiteFrom = suite?.from ?? null;
}

// ---- authored actions ----

function briefAction(state, wp, deps) {
  const lane = laneLayout(state, wp);
  const outPath = wp.lane?.briefPath ?? lane.briefPath;
  const template = join(deps.pluginRoot ?? state.pluginRoot, 'skills', 'conduct', 'templates', 'lane-brief.md');
  // The greenfield bootstrap WP's brief carries the verb to run (quest 977d3efb, writer (d)).
  const append = wp.bootstrap ? bootstrapBrief(state, wp, wp.lane?.worktree ?? lane.worktree) : null;
  return {
    kind: 'author', step: 'brief', part: 'brief', template, outPath, expects: { type: 'file' },
    slots: {
      '<lane id>': lane.name, '<quest id>': wp.questId ?? 'none', '<lane contract path>': contractPath(state), '<report path>': lane.reportPath,
      '<worktree path>': wp.lane?.worktree ?? lane.worktree, '<branch name>': wp.lane?.branch ?? lane.branch, '<base sha>': wp.lane?.base ?? '',
      '<wp spec path>': wp.specPath ?? '', '<runtime exercise>': wp.runtimeExercise || '',
      '<skills>': (wp.skills ?? []).length ? wp.skills.join(', ') : 'none',
      '<visual rules>': (wp.visualRules ?? []).length ? `${wp.visualRules.join(', ')} of ${state.design?.source ?? 'the spec\'s ## Design direction'}` : 'none',
    },
    ...(append ? { append } : {}),
    instruction: `Copy ${template} to ${outPath}, replacing each key of slots with its value.${append ? ' Then append the append text verbatim.' : ''} Record {}.${wp.runtimeExercise ? '' : ' The WP names no runtime exercise: the brief asks the lane to name the surface and its check.'}`,
  };
}

const AMEND_TEXT = {
  check: (a) => `its last check failed: ${a.reason}. Fix exactly that, push, and update the report.`,
  gate: (a) => `landing stopped: ${a.reason}. Fix it on the branch at the current head, push, and update the report.`,
  ruling: (a) => (a.rulings
    ? `the conductor ruled on each question of its ## Needs conductor: ${a.rulings.map((r) => `${r.question ?? 'the ask'} → (${r.ruled}); evidence, verbatim: ${r.evidence}`).join('. ')}. Carry on under those rulings.`
    : `the conductor ruled (${a.ruled}) on its ## Needs conductor ask. The ruling's evidence, verbatim: ${a.evidence}. Carry on under that ruling.`),
  answer: (a) => `the operator answered ${a.tag}, verbatim: (${a.key})${a.text ? ` ${a.text}` : ''}. Carry on under that answer.${a.rulings?.length
    ? ` The conductor also ruled on the report's other questions: ${a.rulings.map((r) => `${r.question ?? 'the ask'} → (${r.ruled}); evidence, verbatim: ${r.evidence}`).join('. ')}.` : ''}`,
  findings: (a) => `${a.ids
    ? `council review round ${a.round} (synthesis in ${a.reviewDir}) has ${a.ids.length} Critical/Major/Minor finding(s). Write them into this brief numbered ${a.ids.join(', ')} in synthesis order; the lane's ## Amendment table uses those ids.`
    : `review round ${a.round} posted ${a.findings ?? 'an unknown number of'} finding(s) as PR review comments; the lane adjudicates each in an ## Amendment table keyed by its comment id.`} ${VERDICT_TEXT}${a.round > 1 ? ` ${REPEAT_TEXT(a.round)}` : ''}`,
};

// SKILL.md § Self-recovery, "a fix loop that repeats a class": the stop is
// read where the conductor writes the round's brief, not only in the skill.
const REPEAT_TEXT = (round) => `Before writing it, compare these findings with round ${round - 1}'s: when they share a defect class, another per-finding fix list is the wrong next step. Write a design ruling that removes the class, or narrow the WP's claim to what its fixes prove and name the rest as residuals, and rule each finding against that; a ruling wider than the approved scope is a re-plan.`;

// The lane contract's verdicts (§ Finish step 4), which the check parses; any
// other word in a table row, `declined` included, fails it.
const VERDICT_TEXT = 'Each row\'s Verdict is `fixed`, `refuted` or `judgment` (`conductor` only on a guard thread). When the brief rules on a finding itself, write the ruling in those words: a "no change" ruling is `refuted` when its evidence shows the finding is wrong, otherwise `judgment`, with the ruling quoted as the row\'s Evidence.';

// A retry renders the failed expectation whatever the amendment's kind; the
// marker line is what `record` looks for, so an unchanged brief is refused.
function amendmentBrief(state, wp, amendment) {
  const outPath = wp.lane?.briefPath ?? laneLayout(state, wp).briefPath;
  const kind = AMEND_TEXT[amendment.kind] ? amendment.kind : 'check';
  const retry = amendment.retryReason && kind !== 'check' ? `${AMEND_TEXT.check({ reason: amendment.retryReason })} Still owed: ` : '';
  const marker = `Amendment ${amendment.n}: ${amendment.retryReason ?? amendment.reason}`;
  return {
    kind: 'author', step: 'brief', part: 'amendment', outPath, amendment, marker, expects: { type: 'file' },
    instruction: `Rewrite ${outPath} as amendment ${amendment.n} for ${wp.id}'s lane (same worktree, same report ${laneLayout(state, wp).reportPath}): ${retry}${AMEND_TEXT[kind](amendment)} Keep question and option text unchanged under Needs conductor; record resolutions on a separate indented Resolution: line. The lane appends ## Amendment ${amendment.n} to its report (lane contract § Finish, step 4). Start the file with this line, verbatim: ${marker}. Record {}.`,
  };
}

// An ask is a question and one of its options: the same option text under a
// different question is a different ask.
// Resolution annotations are presentation, not a new question. Preserve the
// old identity format so already-recorded rulings remain usable on resume.
function askText(text) {
  let line = text.replace(/\*\*/g, '').replace(/\s*\[resolved[^\]]*\]/gi, '').replace(/\s*\(resolved[^)]*\)/gi, '').trim();
  const annotation = /^(\d+[.)]\s+)?Resolved by amendment \d+\b/i.exec(line);
  if (!annotation) return line;
  let tail = line.slice(annotation[0].length).trimStart();
  if (tail.startsWith('(')) {
    let depth = 0;
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] === '(') depth++;
      if (tail[i] === ')' && --depth === 0) { tail = tail.slice(i + 1); break; }
    }
  }
  return `${annotation[1] ?? ''}${tail.replace(/^[\s:.—-]+/, '')}`;
}
export const askId = (ask) => `${ask.question ?? ''}\n${ask.text}`.split('\n').map(askText).join('\n').trim();
const askRuled = (wp, ask) => (wp.ruledAsks ?? []).some((id) => askId({ text: id }) === askId(ask));

// A ruling on a lane's asks (part ask) or on a guard row (part guard, D20).
function rulingAction(state, wp, fields) {
  wp.rulingSeq = Math.max(wp.rulingSeq ?? 0, (wp.rulings ?? []).length) + 1;
  return rulingAct(state, wp, fields, wp.rulingSeq);
}

// Ruling n's act, as rulingAction queues it and emission derives it again.
function rulingAct(state, wp, { asks = null, row = null }, n) {
  const file = `rulings/${lower(wp)}-${n}.json`;
  const keys = row ? GUARD_VERDICTS : (asks ?? []).map((ask) => ask.key);
  const outPath = join(state.runDir, file);
  const questions = [...new Set((asks ?? []).map((ask) => ask.question).filter(Boolean))];
  const what = row ? `the guard row for comment ${row.comment} (the lane's evidence: ${row.evidence})`
    : `${wp.id}'s ## Needs conductor ${questions.length ? `question ${questions.map((text) => `"${text}"`).join(' and ')}, options` : 'asks'}: ${(asks ?? []).map((ask) => ask.text).join(' / ')}`;
  return {
    kind: 'author', step: 'ruling', part: row ? 'guard' : 'ask', outPath, ruling: { n, file, keys, ...(row ? { comment: row.comment, row } : { asks }) }, expects: { type: 'file' },
    instruction: `Rule on ${what}: write ${outPath} = { "ruled": "<one of ${keys.join(', ')}>", "evidence": "<the measurement or file that settles it>" }, or { "escalate": true, "why": "<why only the operator can settle it>" }.${row ? '' : ` When the ruling needs paths outside ${wp.id}'s Files, add "ratify": ["<path>", …]: they are added to its Files with this ruling (a path another unfinished WP owns is refused).`} Record {}.`,
  };
}

// ---- ratify ----

// A path is in a WP's Files when it is listed, or sits under a listed
// directory, which ends in `/`: the merge gate's own rule (land.mjs declaredFile).
const covered = (files, path) => (files ?? []).some((file) => (String(file).endsWith('/') ? path.startsWith(file) : path === file));

// A WP held only because its post-cap tail touches paths outside its Files is
// the conductor's ruling, not the end of the build.
function ratifyAction(state, wp) {
  const outPath = join(state.runDir, 'rulings', `${lower(wp)}-ratify-${(wp.ratified ?? []).length + 1}.json`);
  const paths = [...(wp.heldOutside ?? [])];
  return {
    kind: 'author', step: 'ratify', part: 'ruling', outPath, paths, expects: { type: 'file' },
    instruction: `${wp.id} is held: its post-cap tail touches ${paths.join(', ')}, outside its Files. Rule: write ${outPath} = { "ratify": true, "why": "<why these paths belong to ${wp.id}>" } to add them to its Files and send it back to the gate, or { "ratify": false, "why": "<why not>" } to keep it held (create the directory). Record {}.`,
  };
}

// Extends a WP's Files with the conductor's ruling. A path another unfinished
// WP owns is refused (exit 5): lanes run on disjoint Files. A WP held only on
// its Files whose outside paths are now all covered goes back to its land
// stage (rebase, gate, inspection), and its deferred dependents follow at the
// next `next`. Returns whether it was re-admitted.
function applyRatify(state, wp, paths, why, deps) {
  const normal = paths.map((path) => {
    const repoPath = normalizePath(path);
    if (repoPath === null) throw new ConductError(2, `ratify: \`${path}\` is not a path inside the repository`);
    return repoPath;
  });
  if (!normal.length) throw new ConductError(2, 'ratify: no paths');
  // No Files means an unknown scope, which conflicts with every WP; a ratified
  // path would make it look complete. The same holds for the owner check.
  if (!wp.files?.length) throw new ConductError(5, `ratify: ${wp.id} has no declared Files (an unknown scope); ratifying would define its whole scope`);
  // A dropped WP gives up its paths, so a re-plan can fold them into another WP (its restore then waits on Files, as any dispatch does).
  const owner = state.wps.find((other) => other !== wp && !['merged', 'refuted', 'dropped'].includes(other.state) && !filesDisjoint(normal, other.files ?? []));
  if (owner) throw new ConductError(5, `ratify: ${owner.id} (${owner.state}) owns a path in ${normal.join(', ')}${owner.files?.length ? '' : ' (it has no declared Files)'}; lanes run on disjoint Files`);
  wp.files = [...new Set([...(wp.files ?? []), ...normal])];
  wp.ratified = [...(wp.ratified ?? []), { paths: normal, why, at: deps.timestamp() }];
  appendEvent(state, deps, { event: 'ratified', data: { wpId: wp.id, paths: normal, why } });
  if (wp.state !== 'held' || !wp.heldOutside?.length || !wp.heldOutside.every((path) => covered(wp.files, path))) return false;
  wp.heldOutside = null;
  wp.queue = (wp.queue ?? []).filter((action) => action.step !== 'ratify');
  setState(state, wp, 'gate', `ratified: ${why}`, deps);
  wp.stage = 'land';
  return true;
}

// ---- cite ----

// The fixed rows of the WP's latest review: the rows a tail commit can be cited on.
const fixedRows = (wp) => ((wp.reviews ?? []).at(-1)?.verdicts ?? []).filter((row) => row.verdict === 'fixed');

// A WP held only because its tail has commits no fixed row cites (a fix that
// took a second commit) is the conductor's ruling, not the end of the build.
function citeAction(state, wp) {
  const outPath = join(state.runDir, 'rulings', `${lower(wp)}-cite-${(wp.cited ?? []).length + 1}.json`);
  const shas = [...(wp.heldUncited ?? [])];
  const rows = fixedRows(wp).map((row) => `${row.comment} (${row.commit})`).join(', ') || 'none';
  return {
    kind: 'author', step: 'cite', part: 'ruling', outPath, shas, expects: { type: 'file' },
    instruction: `${wp.id} is held: its tail has commits no fixed row of the latest review cites: ${shas.join(', ')}. Read each (\`git -C ${wp.lane.worktree} show <sha>\`). The fixed rows are ${rows}. Rule: write ${outPath} = { "cite": { "<sha>": "<the fixed row's comment id>", … }, "why": "<why each commit belongs to that fix>" }, citing every sha listed, to add them to those rows and send ${wp.id} back to the gate, where the post-cap inspection reads the tail again; or { "cite": false, "why": "<why not>" } to keep it held (create the directory). Record {}.`,
  };
}

// Appends each cited sha to its fixed row's Commit cell. Every held sha must
// be cited, on a fixed row of the latest review.
function applyCite(state, wp, action, cite, why, deps) {
  const shas = action.shas ?? [];
  const entries = Object.entries(cite);
  const rows = fixedRows(wp);
  const cited = new Map();
  for (const [sha, comment] of entries) {
    const held = shas.find((full) => /^[0-9a-f]{7,40}$/i.test(sha) && full.toLowerCase().startsWith(sha.toLowerCase()));
    if (!held) throw new ConductError(2, `cite ruling ${action.outPath}: ${sha} is not one of the held commits ${shas.join(', ')}`);
    if (!rows.some((row) => row.comment === String(comment))) {
      throw new ConductError(2, `cite ruling ${action.outPath}: ${comment} is not a fixed row of ${wp.id}'s latest review (${rows.map((row) => row.comment).join(', ') || 'none'})`);
    }
    cited.set(held, String(comment));
  }
  const missing = shas.filter((sha) => !cited.has(sha));
  if (missing.length) throw new ConductError(2, `cite ruling ${action.outPath}: every held commit is cited; missing ${missing.join(', ')}`);
  const latest = wp.reviews.at(-1);
  latest.verdicts = latest.verdicts.map((row) => {
    const add = [...cited].filter(([, comment]) => comment === row.comment && row.verdict === 'fixed').map(([sha]) => sha);
    return add.length ? { ...row, commit: [row.commit, ...add].filter(Boolean).join(',') } : row;
  });
  wp.cited = [...(wp.cited ?? []), { shas: Object.fromEntries(cited), why, at: deps.timestamp() }];
  appendEvent(state, deps, { event: 'cited', data: { wpId: wp.id, shas: Object.fromEntries(cited), why } });
  wp.heldUncited = null;
  setState(state, wp, 'gate', `cited: ${why}`, deps);
  wp.stage = 'land';
}

// `conduct.mjs ratify --run <dir> --wp <id> --paths <a,b> --why <text>`.
export function ratify(state, { wpId, paths, why }, deps) {
  const wp = state.wps.find((candidate) => candidate.id === wpId);
  if (!wp) throw new ConductError(2, `ratify: no WP ${wpId} in this run`);
  if (typeof why !== 'string' || !why.trim()) throw new ConductError(2, 'ratify: --why <the ruling> is required');
  if (['merged', 'refuted'].includes(wp.state)) throw new ConductError(5, `ratify: ${wp.id} is ${wp.state}`);
  if (state.pending?.wpId === wp.id && state.pending.step === 'ratify') {
    throw new ConductError(5, `ratify: ${wp.id}'s ruling is the pending action ${state.pending.id}; write its file and record it`);
  }
  const readmitted = applyRatify(state, wp, paths, why.trim(), deps);
  return { wpId: wp.id, files: wp.files, readmitted };
}

// ---- reset-wp ----

// Where the conductor may put a stopped WP back: each target is a stage the
// build itself runs, with the WP state the build holds there. Only a blocked or
// held WP is reset; every other state belongs to the scheduler.
// - check: re-run the lane's checks (report, shape, PR) against what is there now.
// - checked: rule and adjudicate the report already written, as after a passing check.
// - prompt: re-send the lane its current brief; a lane whose agent has exited is started first.
// - wait: poll a herdr lane the conductor restarted outside the verbs; its deadline is renewed.
// - land: rebase, gate and merge the PR again.
// - delta: verify a supplied baseline and review the uncovered tail.
// check, checked, land and delta keep a queued stop (an agent still running is
// stopped before anything else runs); prompt and wait want the agent.
const laneWork = (wp) => (wp.amendment ? 'amending' : 'dispatched');
const hasLane = (wp) => (wp.lane?.backend && wp.lane?.worktree ? null : `${wp.id} has no lane worktree (it was never dispatched)`);
const laneExited = (wp) => !wp.lane?.startedAt || Boolean(wp.lane?.exitedAt);
const keepStops = (state, wp) => (wp.queue ?? []).filter((action) => action.step === 'stop');
const firstProblem = (...checks) => checks.reduce((found, check) => found ?? check(), null);

export const RESET_TARGETS = Object.freeze({
  check: { from: ['blocked'], state: laneWork, stage: 'check', needs: (state, wp) => hasLane(wp), queue: keepStops },
  checked: {
    from: ['blocked'], state: laneWork, stage: 'checked', queue: keepStops,
    // The review the checked stage starts reads the PR, which only the check's pr-lookup records.
    needs: (state, wp, deps) => firstProblem(() => hasLane(wp), () => (wp.pr?.number ? null : `${wp.id} has no PR recorded; reset it --to check`),
      () => (deps.exists(laneLayout(state, wp).reportPath) ? null : `${wp.id} has no report at ${laneLayout(state, wp).reportPath}`)),
  },
  prompt: {
    from: ['blocked'], state: laneWork, stage: 'wait',
    needs: (state, wp, deps) => firstProblem(() => hasLane(wp),
      () => (wp.lane.briefPath && deps.exists(wp.lane.briefPath) ? null : `${wp.id} has no brief at ${wp.lane.briefPath ?? laneLayout(state, wp).briefPath}`),
      () => (wp.lane.backend === 'herdr' && !wp.lane.paneId ? `${wp.id}'s herdr lane has no pane` : null),
      () => (wp.lane.backend !== 'herdr' && !laneExited(wp) ? `${wp.id}'s exec lane agent (pid ${wp.lane.pid}) has not been observed to exit; an exec lane is re-prompted by a new spawn, which a running agent refuses` : null),
      // `lane spawn --amend` reads the session id from the lane, else from its log.
      () => (wp.lane.backend !== 'herdr' && (wp.amendment || wp.lane.startedAt) && !wp.lane.sessionId && !deps.exists(wp.lane.logPath ?? laneLayout(state, wp).logPath)
        ? `${wp.id}'s exec lane has no session id to resume (none recorded, no lane log)` : null)),
    queue: (state, wp, deps) => {
      const backend = backendOf(state, wp, deps);
      // A lane that ever ran is re-prompted as an amendment: herdr's lane.mjs
      // treats any later prompt as one (--no-ruling), and an exec lane resumes
      // its session (spawn --amend) rather than starting a fresh one.
      const again = Boolean(wp.amendment || wp.lane.startedAt);
      if (backend.name === 'exec') return again ? backend.prompt(wp, { amendment: true }) : backend.start(wp);
      return [...(laneExited(wp) ? backend.start(wp) : []), ...backend.prompt(wp, { amendment: again })];
    },
  },
  wait: {
    from: ['blocked'], state: laneWork, stage: 'wait',
    // An exec lane is polled by its recorded pid, which a restart outside `lane spawn` does not update.
    needs: (state, wp) => firstProblem(() => hasLane(wp), () => (wp.lane.backend !== 'herdr' ? `${wp.id} is an exec lane; restart it with --to prompt` : null),
      () => (wp.lane.paneId ? null : `${wp.id}'s herdr lane has no pane`)),
    lane: (deps) => freshStart(deps),
  },
  land: {
    from: ['blocked', 'held'], state: () => 'gate', stage: 'land', queue: keepStops,
    needs: (state, wp) => firstProblem(() => hasLane(wp), () => (wp.pr?.number ? null : `${wp.id} has no PR to land`),
      () => (wp.merge?.sha ? `${wp.id}'s PR is already merged (${wp.merge.sha}); a merged WP is never landed again` : null),
      // The gate does not read the owed adjudication; only the checked stage settles it.
      () => (wp.owed?.adjudicate ? `${wp.id}'s review round ${wp.owed.round ?? '?'} findings are not adjudicated; reset it --to checked` : null)),
  },
  // A WP a re-plan dropped goes back into the plan: the scheduler dispatches it
  // again like any pending WP, so it takes no lane here (Amendment 1, e830d835).
  pending: { from: ['dropped'], state: () => 'pending', stage: null, needs: () => null, queue: () => [] },
  delta: {
    from: ['blocked', 'held'], state: () => 'pr', stage: 'delta', queue: keepStops,
    needs: (state, wp, deps) => firstProblem(() => hasLane(wp),
      () => (wp.pr?.number && wp.pr?.head ? null : `${wp.id} has no PR head recorded; reset it --to check`),
      () => (wp.merge?.sha ? `${wp.id}'s PR is already merged (${wp.merge.sha})` : null),
      () => (deps.exists(laneLayout(state, wp).reportPath) ? null : `${wp.id} has no report at ${laneLayout(state, wp).reportPath}`)),
  },
});

// Every target but `pending` puts the WP in a live state, so it takes a lane under the
// scheduler's rules (schedule.mjs dispatchable): Files disjoint from every
// live or lane-holding WP, and a slot under the run's lane cap. A WP whose own
// lane still holds its slot already has one. A merged-tree halt is the
// operator's to clear first.
function admissionRefusal(state, wp) {
  const halt = (state.build?.halts ?? []).find((entry) => entry.kind === 'merged');
  if (halt) return `dispatch is halted (${halt.reason}); answer touch ${halt.touch} first`;
  const running = state.wps.filter((other) => other !== wp && (LIVE_STATES.includes(other.state) || laneOccupied(other)));
  const overlap = running.find((other) => !filesDisjoint(wp.files ?? [], other.files ?? []));
  if (overlap) return `${overlap.id} (${overlap.state}) holds a path in ${wp.id}'s Files; lanes run on disjoint Files, so reset ${wp.id} after it finishes`;
  const cap = state.intent?.lanesCap ?? 1;
  if (!laneOccupied(wp) && running.length >= cap) return `${running.length} lane(s) are live (${running.map((other) => other.id).join(', ')}) against the run's cap of ${cap}; reset ${wp.id} when one finishes`;
  return null;
}

// The phases a reset can move back to build: the build ended (a WP stopped and
// its dependents deferred), and nothing after it has acted yet. A release that
// ran, or a showcase touch already filed, is never undone.
const REWINDABLE = ['release', 'analyze', 'showcase'];
function rewindRefusal(state) {
  if (state.phase === 'build') return null;
  if (!REWINDABLE.includes(state.phase)) return `the run is in phase ${state.phase}; a reset moves only a build, or a run whose build ended (release, analyze, showcase), back to build`;
  const r = state.release ?? {};
  const untouched = r.state === 'not-exercised' || (r.state === 'pending' && !r.stage && !r.anomaly);
  if (!untouched || state.mergeLock?.wpId === 'release') return `the release is ${r.state}${r.stage ? ` at ${r.stage}` : ''}; a run whose release has acted is not moved back to build`;
  const showcase = (state.touches ?? []).find((touch) => touch.kind === 'showcase');
  if (showcase) return `the showcase touch ${showcase.n} is already ${showcase.status}; answer it, or start a new run`;
  return null;
}

function rewindPhase(state, deps) {
  if (state.phase === 'build') return null;
  const from = state.phase;
  // The pending action belongs to the phase being left; it is dropped, never recorded.
  const dropped = state.pending && state.pending.phase !== 'build' ? state.pending.id : null;
  if (dropped) state.pending = null;
  // The release is decided again when the build ends again: a reason like
  // `incomplete build` may no longer hold.
  if (state.release?.state === 'not-exercised') Object.assign(state.release, { state: 'pending', reason: null, stage: null, queue: [] });
  if (state.showcaseBrief) state.showcaseBrief = null;
  state.phase = 'build';
  // A phase event carries the phase it leaves, as emit's hand-overs do.
  appendEvent(state, deps, { step: 'reset', event: 'phase', phase: from, data: { from, to: 'build' } });
  return { from, to: 'build', droppedPending: dropped };
}

// `conduct.mjs reset-wp --run <dir> --wp <id> --to <target> --why <text>`.
// Refusals: an unknown WP, target or empty why (exit 2); a transition the
// table does not allow, a target whose needs fail, a WP whose action is the
// pending one, an open touch or an unverified lane on the WP, or a phase that
// cannot go back to build (exit 5). `beforeChange` runs after every check and
// before the first change (the verb writes its snapshot there).
export function resetWp(state, { wpId, to, why, baseline = null }, deps, { beforeChange = () => null } = {}) {
  const wp = (state.wps ?? []).find((candidate) => candidate.id === wpId);
  if (!wp) throw new ConductError(2, `reset-wp: no WP ${wpId} in this run`);
  const target = Object.hasOwn(RESET_TARGETS, to ?? '') ? RESET_TARGETS[to] : null;
  if (!target) throw new ConductError(2, `reset-wp: --to must be one of ${Object.keys(RESET_TARGETS).join(', ')} (got ${to ?? 'none'})`);
  if (baseline !== null && to !== 'delta') throw new ConductError(2, 'reset-wp: --baseline is only valid with --to delta');
  if (typeof why !== 'string' || !why.trim()) throw new ConductError(2, 'reset-wp: --why <the ruling> is required');
  const refuse = (reason) => { throw new ConductError(5, `reset-wp: ${reason}`); };
  if (!target.from.includes(wp.state)) refuse(`${wp.id} is ${wp.state}; --to ${to} resets a WP that is ${target.from.join(' or ')}`);
  const need = target.needs(state, wp, deps);
  if (need) refuse(need);
  if (wp.lane?.livenessHeld) refuse(`${wp.id}'s lane liveness is unverified; answer its liveness touch first`);
  const touch = (state.touches ?? []).find((candidate) => candidate.wpId === wp.id && candidate.status !== 'answered');
  if (touch) refuse(`${wp.id} has touch ${touch.n} open; its answer resumes the WP`);
  if (state.pending?.wpId === wp.id) refuse(`${wp.id}'s action ${state.pending.id} is pending; perform and record it first`);
  // `--to pending` takes no lane: the scheduler admits the WP when it dispatches it.
  const blocker = rewindRefusal(state) ?? (to === 'pending' ? null : admissionRefusal(state, wp));
  if (blocker) refuse(blocker);
  const recovery = to === 'delta' ? verifyDeltaRecovery(wp, baseline, deps) : null;
  // Built before the snapshot: an emitter that throws leaves nothing behind.
  const nextQueue = target.queue ? target.queue(state, wp, deps) : [];

  const snapshot = beforeChange();
  const from = { state: wp.state, stage: wp.stage ?? null };
  const label = (action) => `${action.step}${action.part ? `/${action.part}` : ''}`;
  const dropped = (wp.queue ?? []).filter((action) => !nextQueue.includes(action)).map(label);
  const phase = rewindPhase(state, deps);
  const reason = `reset-wp --to ${to}: ${why.trim()}`;
  if (target.lane) wp.lane = { ...wp.lane, ...target.lane(deps) };
  setState(state, wp, target.state(wp), reason, deps);
  wp.stage = target.stage;
  wp.queue = nextQueue;
  wp.failStreak = null;
  wp.stall = null;
  if (recovery) {
    wp.deltaRecovery = recovery;
    wp.gate = null;
    if (state.mergeLock?.wpId === wp.id) state.mergeLock = null;
  }
  // A held WP's markers belong to the hold it leaves; the gate sets them again if they still hold.
  if (from.state === 'held') Object.assign(wp, { heldOutside: null, heldUncited: null });
  if (from.state === 'dropped') wp.droppedBy = null;
  // Every WP deferred because of this one, directly or through another
  // deferral, goes back to pending; the next `next` defers again any that
  // still waits on a stopped WP.
  const undeferred = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const other of state.wps) {
      if (other.state !== 'deferred' || !(other.deferredBy === wp.id || undeferred.includes(other.deferredBy))) continue;
      setState(state, other, 'pending', null, deps);
      other.deferredBy = null;
      undeferred.push(other.id);
      changed = true;
    }
  }
  const queue = wp.queue.map(label);
  // The seam row the run analysis counts: one per reset, by hand.
  state.seq += 1;
  appendEvent(state, deps, {
    actionId: `${state.seq}-reset`, step: 'reset', kind: 'reset', event: 'wp-reset', source: 'manual',
    data: { wpId: wp.id, to, from, state: wp.state, stage: wp.stage, queue, dropped, undeferred, phase, why: why.trim(), snapshot, ...(recovery ? { deltaRecovery: recovery } : {}) },
  });
  return { wpId: wp.id, to, from, state: wp.state, stage: wp.stage, queue, dropped, undeferred, phase, snapshot, ...(recovery ? { deltaRecovery: recovery } : {}) };
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
  const options = budget
    ? [option('a', 'Raise the budget', 'Type "budget <USD>", above the current spend; booked lane cost is checked against it.'),
      option('b', 'Stop new paid lane work', 'No dispatch, start, prompt or fallback; PRs already up may still land.')]
    : [option('a', 'Resume dispatch', 'This halt is cleared.'), option('b', 'End the build', 'Live lanes finish; nothing new is dispatched.')];
  const touch = buildTouch(state, deps, why, {
    question: budget
      ? `DO: decide whether conduct ${state.slug} spends more. ${reason}. EXPECT: (a) answered with the text "budget <USD>" above the current spend raises the ceiling to it, and the lane-only lower bound is checked against it; (b) no new paid lane work (no dispatch, lane start, prompt or fallback); work already at a PR boundary may still be reviewed and landed, and the build ends.`
      : `DO: decide whether conduct ${state.slug} dispatches more lanes. ${reason}. EXPECT: (a) this halt is cleared; dispatch resumes once no other halt is open; (b) no new lane starts, the live ones finish, and the build ends.`,
    options,
    allowFreeText: budget,
  });
  touch.spendUsd = spendUsd;
  halts.push({ kind: why, reason, touch: touch.n });
  syncHalt(state, deps);
}

// ---- re-plan inside the pre-approval (quest e830d835) ----

// `conduct.mjs replan --run <dir> --plan <file>`. When mid-flight information
// invalidates the run's plan, the conductor states the delta: why, and each
// change with its door and whether it stays inside the approved scope. Every
// change two-way and in scope: the delta is approved on the run's
// pre-approval. Anything wider halts dispatch on a touch whose question carries
// the whole delta-plan. An approved re-plan (on the pre-approval, or the
// operator's (a) or (c)) is applied before any other build work: the next
// action is an `author` step in which the conductor makes the changes with the
// verbs that make them (ratify, reset-wp, a ruling's amendment) and records
// what it did. With the Spine adapter, an autonomous re-plan is then receipted
// on the anchor. rulings/replan-<n>.json is the proposal as filed; state.json
// and the run analysis carry what became of it.
const REPLAN_DOORS = ['two-way', 'one-way'];
// The plan's own shape, which no run state changes: `record --replan` checks
// it before recording anything (quest 4e7311a7).
export function replanShape(plan) {
  const why = typeof plan?.why === 'string' ? plan.why.trim() : '';
  if (!why) throw new ConductError(2, 'replan: the plan needs "why", the information that invalidated the plan');
  const delta = Array.isArray(plan.delta) ? plan.delta : [];
  if (!delta.length) throw new ConductError(2, 'replan: the plan needs a non-empty "delta"');
  delta.forEach((item, i) => {
    if (typeof item?.change !== 'string' || !item.change.trim()) throw new ConductError(2, `replan: delta[${i}].change must say what changes`);
    if (!REPLAN_DOORS.includes(item.door)) throw new ConductError(2, `replan: delta[${i}].door must be two-way or one-way (in doubt, one-way)`);
    if (typeof item.inScope !== 'boolean') throw new ConductError(2, `replan: delta[${i}].inScope must be true or false: is the change inside the approved scope?`);
  });
  return { why, delta };
}

// `record` is the id of the action whose record filed it (record --replan).
export function replan(state, plan, deps, { record = null } = {}) {
  if (state.phase !== 'build') throw new ConductError(5, `replan: the run is in phase ${state.phase}; a re-plan is made mid-build`);
  // An emitted action runs before anything a re-plan queues: re-plan only at a
  // wait (slim review on #250), or with the record that would emit it (record --replan).
  if (state.pending && state.pending.kind !== 'wait') throw new ConductError(5, `replan: action ${state.pending.id} (${state.pending.kind}) is pending; perform it, then file the re-plan with its record (record --replan), or re-plan at a wait`);
  const { why, delta } = replanShape(plan);
  state.build ??= { contract: null, halts: [] };
  state.replans ??= [];
  if (state.replans.some((row) => row.mode === 'asked')) throw new ConductError(5, 'replan: a re-plan already waits on the operator; answer it first');
  const unapplied = state.replans.find((row) => ['autonomous', 'operator'].includes(row.mode) && !row.applied);
  if (unapplied) throw new ConductError(5, `replan: re-plan ${unapplied.n} is approved and not yet applied; run next and apply it first`);
  const n = state.replans.length + 1;
  const items = delta.map((item) => ({ change: item.change.trim(), door: item.door, inScope: item.inScope }));
  const wider = items.filter((item) => item.door !== 'two-way' || !item.inScope);
  const file = `rulings/replan-${n}.json`;
  let rests;
  try {
    rests = preapprovedRef(state);
  } catch {
    rests = `the authority in ${join(state.runDir, 'state.json')} (no approving touch recorded)`;
  }
  const row = { n, why, delta: items, rests, file, at: deps.timestamp(), mode: wider.length ? 'asked' : 'autonomous', ...(record ? { record } : {}) };
  const source = record ? 'record' : 'verb';
  // The operator decides from the question alone, so it carries the whole delta-plan or is refused before anything is written.
  let question = null;
  if (wider.length) {
    const list = items.map((item, i) => `${i + 1}. ${item.change} (${item.door}${item.inScope ? '' : ', outside the approved scope'})`).join(' ');
    const reasons = wider.map((item) => `change ${items.indexOf(item) + 1} is ${item.inScope ? 'a one-way door' : 'outside the approved scope'}`).join('; ');
    question = `DO: rule on conduct ${state.slug}'s re-plan. New information: ${why}. The delta-plan: ${list} It needs you because ${reasons}; the pre-approval (${rests}) covers only two-way changes inside its scope. EXPECT: (a) the conductor applies these changes before any other build work; (b) the run keeps its original plan; (c) the conductor applies the plan as your text amends it (type the changes). Dispatch stays halted until you answer.`;
    const length = filedLength(state, state.touches.length + 1, question);
    if (length > QUESTION_MAX) throw new ConductError(2, `replan: the delta-plan's question would be ${length} chars, over spine_receipt's ${QUESTION_MAX}-char cap; shorten "why" or the changes so the operator sees the whole plan`);
  }
  deps.mkdir(join(state.runDir, 'rulings'));
  deps.write(join(state.runDir, file), `${JSON.stringify({ n, why, delta: items, rests, at: row.at, needs: wider.length ? 'the operator' : 'nothing: inside the pre-approval' }, null, 2)}\n`);
  if (!wider.length) {
    // Receipted on the anchor once applied (spine), else the event and the analysis carry it.
    row.receipt = spineOn(state) && state.intent?.anchor ? 'owed' : null;
    state.replans.push(row);
    appendEvent(state, deps, { step: 'replan', event: 'replanned', source, data: { n, mode: 'autonomous', changes: items.length, rests: row.rests } });
    return { n, mode: 'autonomous', rests: row.rests, file: join(state.runDir, file) };
  }
  const touch = buildTouch(state, deps, 'replan', {
    question,
    options: [
      option('a', 'Apply the delta-plan', `The conductor applies the ${items.length} change(s) before any other build work.`),
      option('b', 'Keep the original plan', 'Nothing changes; dispatch resumes on the plan you approved.'),
      option('c', 'Apply it with my changes', 'Type the changes; the conductor applies the plan as your text amends it.'),
    ],
    allowFreeText: true,
  });
  row.touch = touch.n;
  state.replans.push(row);
  (state.build.halts ??= []).push({ kind: 'replan', reason: `re-plan ${n} waits on the operator (touch ${touch.n})`, touch: touch.n });
  syncHalt(state, deps);
  appendEvent(state, deps, { step: 'replan', event: 'replan-asked', source, data: { n, touch: touch.n, changes: items.length, wider: wider.length } });
  return { n, mode: 'asked', touch: touch.n, file: join(state.runDir, file) };
}

// An approved re-plan is applied before any other build work: the conductor
// makes the changes and writes what it did (or why it could not).
function replanApply(state) {
  const row = (state.replans ?? []).find((entry) => ['autonomous', 'operator'].includes(entry.mode) && !entry.applied);
  if (!row) return null;
  const outPath = join(state.runDir, 'rulings', `replan-${row.n}-applied.json`);
  const amended = row.answer?.text ? ` The operator's text, verbatim, amends it: ${row.answer.text}` : '';
  return {
    kind: 'author', step: 'replan', part: 'apply', replan: row.n, outPath, expects: { type: 'file' },
    instruction: `Apply re-plan ${row.n} before anything else runs: ${row.delta.map((item, i) => `${i + 1}. ${item.change}`).join(' ')}${amended} Make each change with the verb that makes it (conduct.mjs ratify, reset-wp, or a ruling's amendment). A pending WP the plan no longer needs is dropped here: list it in "drop" (its dependents are deferred, so drop them too or keep it). Then write { "applied": true, "what": "<what you did>", "drop": ["<WP id>", …] } to outPath ("drop" optional), or { "applied": false, "why": "<why it could not be applied>" }, and record {}.`,
  };
}

// The apply record. `drop` is the one plan change no other verb makes: a
// pending WP leaves the plan as `dropped`, with the re-plan as its reason. A
// drop is a two-way door inside the run: `reset-wp --to pending` puts the WP
// back, and the scheduler dispatches it again. Until then its dependents are
// deferred, and the analysis and the showcase name it as not finished.
function recordReplanApply(state, action, deps) {
  const row = (state.replans ?? []).find((entry) => entry.n === action.replan);
  if (!row) throw new ConductError(2, `no re-plan ${action.replan} in this run`);
  const value = readJsonFile(deps, action.outPath, 're-plan application');
  const said = value?.applied === true ? value.what : value?.applied === false ? value.why : null;
  if (typeof said !== 'string' || !said.trim()) throw new ConductError(2, `${action.outPath} must be { "applied": true, "what": "…" } or { "applied": false, "why": "…" }`);
  const drop = value.drop ?? [];
  if (!Array.isArray(drop) || (drop.length && value.applied !== true)) throw new ConductError(2, `${action.outPath}: "drop" is a list of WP ids, and only with "applied": true`);
  const dropped = drop.map((id) => state.wps.find((wp) => wp.id === id));
  const bad = drop.find((id, i) => dropped[i]?.state !== 'pending');
  if (bad !== undefined) throw new ConductError(2, `${action.outPath}: ${bad} is ${state.wps.find((wp) => wp.id === bad)?.state ?? 'not a WP of this run'}; only a pending WP is dropped (a started one is reset or ruled)`);
  for (const wp of dropped) {
    setState(state, wp, 'dropped', `dropped by re-plan ${row.n}: ${row.why} (restore: reset-wp --wp ${wp.id} --to pending)`, deps);
    wp.droppedBy = row.n;
  }
  row.applied = { applied: value.applied, text: said.trim(), at: deps.timestamp(), ...(drop.length ? { dropped: [...drop] } : {}) };
  appendEvent(state, deps, { step: 'replan', event: value.applied ? 'replan-applied' : 'replan-not-applied', data: { n: row.n, text: said.trim(), dropped: drop } });
}

// The anchor receipt an autonomous re-plan owes once applied. A touch filed
// on the anchor waits on the operator, and a later receipt would supersede its
// needs_input, so the receipt waits until no touch is filed.
function replanReceipt(state) {
  const row = (state.replans ?? []).find((entry) => entry.receipt === 'owed' && entry.applied);
  if (!row || (state.touches ?? []).some((touch) => touch.status === 'filed')) return null;
  return {
    kind: 'agent-tool', step: 'replan', part: 'receipt', replan: row.n, tool: 'spine_receipt', expects: { type: 'json' },
    instruction: 'Call spine_receipt with these args and record its raw result.',
    args: {
      questId: state.intent.anchor, outcome: 'completed',
      did: `conduct ${state.slug} (run ${state.runId}) re-planned inside its pre-approval (re-plan ${row.n}). Why: ${row.why.slice(0, 800)} What changed: ${row.delta.map((item, i) => `${i + 1}. ${item.change}`).join(' ').slice(0, 1600)} Every change is a two-way door inside the approved scope; it rests on ${row.rests}. ${row.applied.applied ? 'Applied' : 'Not applied'}: ${row.applied.text.slice(0, 800)}`.slice(0, 4000),
      stoppedAt: `re-plan ${row.n} recorded at ${row.file}; the run continues ${row.applied.applied ? 'on the changed plan' : 'on its original plan'}`,
    },
  };
}

// A failed receipt is recorded and never stops the build.
function recordReplanReceipt(state, action, result, deps) {
  const row = (state.replans ?? []).find((entry) => entry.n === action.replan);
  if (!row) return;
  const failed = spineAckFailure(action, result);
  row.receipt = failed ? 'failed' : 'filed';
  row.receiptId = failed ? null : result?.id ?? null;
  appendEvent(state, deps, { step: 'replan', event: failed ? 'replan-receipt-failed' : 'replan-receipted', data: { n: row.n, ...(failed ? { error: failed } : { receipt: row.receiptId }) } });
}

// The operator's ruling on a wider re-plan: (a) or (c) approve it (c as their
// text amends it, so (c) needs the text), (b) keeps the original plan. The
// halt clears; an approved plan's apply step runs before any other work.
function answerReplan(state, touch, deps) {
  const row = (state.replans ?? []).find((entry) => entry.touch === touch.n);
  const { key, text, by, answeredAt } = touch.answer;
  if (key === 'c' && !String(text ?? '').trim()) return refuse(state, touch, '(c) needs your changes as text', deps);
  if (row) Object.assign(row, { mode: key === 'b' ? 'declined' : 'operator', answer: { key, text: text ?? null, by, answeredAt } });
  state.build.halts = (state.build.halts ?? []).filter((entry) => entry.touch !== touch.n);
  syncHalt(state, deps);
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
  if (touch.build === 'replan') return answerReplan(state, touch, deps);
  const { key, text } = touch.answer;
  const halt = (state.build.halts ?? []).find((entry) => entry.touch === touch.n);
  if (key === 'b') {
    if (halt) halt.ended = true;
    return;
  }
  if (touch.build === 'budget') {
    const usd = budgetAmount(text);
    // A GitHub reply's text is the notes below its letter.
    const where = touch.answer.by === 'operator:github' ? ' (on GitHub: on the line below the letter a)' : '';
    if (!(usd > (touch.spendUsd ?? 0))) return refuse(state, touch, `(a) needs the text "budget <USD>"${where} above the current spend of $${touch.spendUsd ?? 'unknown'}`, deps);
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
  wp.queue = [...wp.queue, ...conductorVerdict(state, wp, row, verdict, deps, touch.answer.text), ...(wp.owed?.queue ?? [])];
  if (wp.owed) wp.owed.queue = [];
  wp.stage = 'resolve';
}

// The conductor's verdict on a guard row: a PR comment gets the conductor
// reply (then its resolve); a council finding has no PR comment, so the
// verdict is recorded as an `adjudicated` event and nothing is posted.
function conductorVerdict(state, wp, row, verdict, deps, why = null) {
  if (/^C\d+-\d+$/.test(row.comment)) {
    appendEvent(state, deps, { step: 'adjudicate', event: 'adjudicated', data: { wpId: wp.id, rows: [{ comment: row.comment, verdict, adjudicator: 'conductor' }] } });
    // The round's PR record, still to be posted, shows the ruling rather than
    // `conductor`, and carries the ruling's reason beside the lane's Evidence:
    // the next round's reviewers read this row (council review of #242).
    const ruling = typeof why === 'string' && why.trim() ? ` Ruling: ${why.trim()}` : '';
    if (wp.pendingRecord) {
      wp.pendingRecord.rows = wp.pendingRecord.rows.map((pending) => (pending.comment === row.comment
        ? { ...pending, verdict: `${verdict} (conductor)`, evidence: `${pending.evidence ?? ''}${ruling}`.trim() } : pending));
    }
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
    else {
      // Rulings held for this WP's other questions go to the lane with the answer.
      const rulings = wp.heldRulings?.length ? { rulings: wp.heldRulings } : {};
      wp.heldRulings = [];
      startAmendment(state, wp, deps, { kind: 'answer', reason: `operator answer ${key} to touch ${touch.n}`, tag: touch.tag, key, text, answer: touch.answer, ...rulings });
    }
  }
}

const openBuildTouches = (state) => (state.touches ?? []).filter((touch) => touch.build && touch.status !== 'answered');

// ---- WP transitions ----

function startAmendment(state, wp, deps, { retry = false, answer = null, ...fields }) {
  const prev = wp.amendment;
  const n = (prev?.n ?? 0) + 1;
  wp.amendment = retry && prev ? { ...prev, n, retryReason: fields.reason } : { n, since: wp.pr?.head ?? null, ...fields, kind: fields.kind ?? 'check' };
  // The delta boundary is the first amendment's start since the WP last
  // reached land; a later ruling's amendment does not move it past fixes.
  wp.deltaFrom ??= wp.pr?.head ?? null;
  setState(state, wp, 'amending', fields.reason, deps);
  wp.stage = 'wait';
  const backend = backendOf(state, wp, deps);
  const restart = backend.name === 'herdr' && laneExited(wp) ? backend.start(wp) : [];
  wp.queue = [...(wp.queue ?? []), amendmentBrief(state, wp, wp.amendment), ...restart, ...backend.prompt(wp, { amendment: true, answer })];
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
  // The land gate reads this amendment's commits (from..head) as a gate-fix tail, not as unreviewed work.
  wp.gateFixes = [...(wp.gateFixes ?? []), { from: wp.pr?.head ?? null, reason }];
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
  // The projected crossing, at every merge: booked spend (the closed lanes'
  // logged cost) plus every WP whose lane cost is not booked yet (unfinished,
  // or a lane still open, this one included) at the projection.
  const booked = state.wps.reduce((total, other) => total + (Number(other.lane?.costUsd) || 0), 0);
  const laneBooked = (other) => Number.isFinite(Number(other.lane?.costUsd ?? NaN));
  // A dropped WP has no dispatch planned: it is projected again only once restored.
  const unbooked = (other) => !['merged', 'refuted', 'dropped'].includes(other.state) || (Boolean(other.lane?.startedAt) && !laneBooked(other));
  const left = state.wps.filter(unbooked).length;
  const per = laneProjection(state, deps);
  const projected = Math.round((booked + left * per.usd) * 100) / 100;
  const spend = { bookedUsd: booked, wpsLeft: left, perWpUsd: per.usd, basis: per.basis, projectedUsd: projected, budgetUsd: runAuthority(state).budgetUsd };
  appendEvent(state, deps, { event: 'spend-projection', data: { wpId: wp.id, bookedUsd: booked, wpsLeft: left, perWpUsd: per.usd, projectedUsd: projected, budgetUsd: spend.budgetUsd } });
  const backend = backendOf(state, wp, deps);
  // The lane's removal queues its branch deletes once the worktree is gone.
  wp.queue = [...(wp.queue ?? []), ...mergedAfter(state, wp, deps, spend), ...backend.stop(wp), ...backend.remove(wp)];
}

// What a merge queues before the lane's cleanup: the notify command, and with
// the spine on the WP quest's receipt (its spend line from `spend`) and its done.
function mergedAfter(state, wp, deps, spend) {
  const after = [];
  const { number } = wp.pr;
  const sha = wp.merge?.sha;
  const notify = deps.env?.WORKIT_NOTIFY_CMD;
  if (state.adapters?.notify?.on && notify) {
    after.push(shell('notify', 'notify', shellArgv(notify, deps.platform), { env: { WORKIT_NOTIFY_PR: String(number), WORKIT_NOTIFY_SHA: sha, WORKIT_NOTIFY_REVERT: `git revert ${sha}` } }));
  }
  if (spineOn(state) && wp.questId) {
    const money = (usd) => Math.round(usd * 100) / 100;
    const { bookedUsd, projectedUsd, wpsLeft, perWpUsd, basis, budgetUsd } = spend;
    const spendLine = ` Spend: $${money(bookedUsd)} booked; ~$${projectedUsd} projected with ${wpsLeft} WP(s) not yet booked at $${money(perWpUsd)} each (${basis}), against $${budgetUsd}${projectedUsd >= budgetUsd ? ': the projection crosses the budget' : ''}.`;
    const tool = (part, name, args) => ({ kind: 'agent-tool', step: 'receipt', part, tool: name, args, expects: { type: 'json' }, instruction: `Call ${name} with these args and record its raw result.` });
    after.push(tool('completed', 'spine_receipt', { questId: wp.questId, outcome: 'completed', did: `${wp.id} (${wp.name}) merged as PR #${number} at ${sha}.${spendLine}`,
      stoppedAt: `merged by conduct ${state.slug}`, producedArtifacts: [{ type: 'pr', locator: `https://github.com/${state.intent.repo.remote}/pull/${number}`, rel: 'remedy' }] }));
    // The anchor (depth none/lite) stays open until the showcase answer (D18).
    if (wp.questId !== state.intent.anchor) after.push(tool('done', 'spine_update', { questId: wp.questId, workState: 'done', horizon: 'landed' }));
  }
  return after;
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
  // The table that answers this review is in this amendment or a later one.
  wp.owed.since = wp.amendment.n;
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
  const since = Number.isInteger(wp.owed?.since) ? wp.owed.since : null;
  const rows = parseAmendmentTable(readText(deps, laneLayout(state, wp).reportPath) ?? '', { since });
  let adjudication;
  try {
    if (!rows.length) throw new ConductError(2, `the report has no ## Amendment table (| Comment | Verdict | Evidence | Commit |)${since === null ? '' : ` in ## Amendment ${since} or later`}`);
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
  // A council round leaves its adjudication on the PR as one review.
  // A council round's record is posted at `resolve`, after its guard rows are ruled, so it carries their final verdicts.
  wp.pendingRecord = councilRecord(state, wp, rows) ? { rows: rows.map(({ comment, verdict, evidence, commit }) => ({ comment, verdict, evidence, commit })) } : null;
  wp.queue = [...adjudication.actions, ...adjudication.conductorRows.map((row) => rulingAction(state, wp, { row }))];
  wp.stage = 'resolve';
  return true;
}

// ---- stage expansion ----

// The producers expand and emission's derivation (wpActs) share.
const flipActs = (state, wp) => (spineOn(state) && wp.questId ? [{ kind: 'agent-tool', step: 'flip', tool: 'spine_update', args: { questId: wp.questId, currentPhase: 'build' },
  expects: { type: 'json' }, instruction: 'Call spine_update with these args (the pickup flip) and record its raw result.' }] : []);

// The gate command (when it can run as written) and the land gate. An
// unusable gateEnv throws ConductError: expand blocks the WP on it.
function gateActs(state, wp, deps) {
  const command = gateCommandFor(state, wp, deps);
  const gate = shell('gate', 'gate', ['node', conductScript(state), 'land', 'gate', '--run', state.runDir, '--wp', wp.id]);
  if (notRunnable(command, deps.platform)) return [gate];
  const config = repoConfig(state, deps);
  const env = gateEnvFor(state, wp, config);
  // A suite longer than a foreground shell allows runs in the background (gateBackground).
  const extra = { cwd: wp.lane.worktree, ...(Object.keys(env).length ? { env } : {}), ...(config.gateBackground === true ? { background: true } : {}) };
  return [shell('gate-cmd', 'gate-cmd', shellArgv(command, deps.platform), extra), gate];
}

// The files an amendment changed since the delta baseline, a commit sha.
const amendDiff = (wp, since) => shell('review', 'amend-diff', ['git', '-C', wp.lane.worktree, 'diff', '--name-only', '--end-of-options', since, '{pr.head}']);

// A T1 delta review with two or more majors is counted again after adjudication.
function deltaCountActs(state, wp) {
  const latest = (wp.reviews ?? []).at(-1);
  if (!(latest?.scope === 'delta' && latest.tier === 'T1' && latest.majorFindings >= 2 && latest.reviewId != null)) return [];
  return [shell('review', 'delta-count', ['node', join(state.pluginRoot, 'skills', 'slim-review', 'scripts', 'pr-review.mjs'), 'delta-count',
    '--pr', String(wp.pr.number), '--repo', state.intent.repo.remote, '--review-id', String(latest.reviewId)],
  { land: { reviewId: latest.reviewId, head: latest.head } })];
}

function expand(state, wp, deps) {
  const backend = backendOf(state, wp, deps);
  const go = (actions, stage) => {
    wp.queue = actions;
    wp.stage = stage;
  };
  switch (wp.stage) {
    case 'admit': return go(backend.admit(wp), 'flip');
    case 'flip': return go(flipActs(state, wp), 'create');
    case 'create': return go(backend.create(wp), 'brief');
    case 'brief': return go([briefAction(state, wp, deps)], 'start');
    case 'start': return go(backend.start(wp), 'prompt');
    case 'prompt': return go(backend.prompt(wp), 'wait');
    case 'wait': return go(backend.wait(wp), 'check');
    case 'check': return go(backend.check(wp), 'checked');
    case 'checked': {
      // A passing report's `## Needs conductor` asks are ruled before review or
      // adjudication, one question per ruling.
      const open = (wp.asks ?? []).filter((ask) => !askRuled(wp, ask));
      if (open.length) return go([rulingAction(state, wp, { asks: open.filter((ask) => (ask.question ?? null) === (open[0].question ?? null)) })], 'checked');
      const findings = Boolean(wp.reviews?.length && wp.owed?.adjudicate);
      if (findings && !adjudicate(state, wp, deps)) return undefined;
      wp.checkAmends = 0;
      if (wp.state !== 'pr') setState(state, wp, 'pr', null, deps);
      if (findings) return undefined;
      if (!wp.reviews?.length) {
        // A full review covers every amendment before it.
        wp.deltaFrom = null;
        return go([prDiff(state)], null);
      }
      return go([], 'delta');
    }
    case 'reviewed': {
      if ((wp.reviews ?? []).at(-1)?.findings === 0) {
        const review = (wp.reviews ?? []).at(-1);
        const record = review?.escalatedDeltaReviewId ? councilRecord(state, wp, []) : null;
        if (record) {
          deps.mkdir(dirname(record.path));
          deps.write(record.path, record.body);
          return go([record.action], 'land');
        }
        return go([], 'land');
      }
      return findingsAmendment(state, wp, deps);
    }
    case 'resolve': {
      const record = wp.pendingRecord ? councilRecord(state, wp, wp.pendingRecord.rows) : null;
      wp.pendingRecord = null;
      if (record) {
        deps.mkdir(dirname(record.path));
        deps.write(record.path, record.body);
        // The next council round reads this round's rulings (land.mjs t2Actions).
        const prior = join(dirname(record.path), PRIOR_ADJUDICATION_FILE);
        deps.write(prior, priorAdjudicationBody(record.body));
        wp.priorAdjudication = { path: prior, round: (wp.reviews ?? []).at(-1)?.round ?? null };
      }
      return go([...(record ? [record.action] : []), ...(wp.replyIds?.length ? resolveThreadActions(state, wp, wp.replyIds) : []), ...deltaCountActs(state, wp)], 'delta');
    }
    case 'delta': {
      // One delta pass per full review; a later tail is the gate's post-cap inspection.
      // A ruling may start after executable findings fixes. Its amendment's
      // `since` is not the boundary of work the full review covered.
      const review = (wp.reviews ?? []).at(-1);
      const since = recoveryBaseline(state, wp, deps);
      if (wp.state === 'blocked') return undefined;
      if (wp.fullReviewOwed) return go([prDiff(state)], null);
      if (wp.deltaEscalation) return go([prDiff(state)], null);
      if (!since || since === wp.pr?.head || review.scope !== 'full') return go([], 'land');
      if (!SHA.test(since)) return block(state, wp, deps, `the delta baseline ${JSON.stringify(since)} is not a commit sha`);
      return go([amendDiff(wp, since)], null);
    }
    case 'land':
      // A gate amendment's lane work ends here: its gate-fix range is closed at the head it pushed.
      for (const fix of wp.gateFixes ?? []) fix.to ??= wp.pr?.head ?? null;
      // Every head before land has passed its delta check; the rebase starts a new line.
      wp.deltaFrom = null;
      if (mergeLockFor(state, wp) === 'other') return go([waitSpec('rebase', WAIT_MS, `Wait: ${state.mergeLock.wpId} holds the merge lock.`)], 'land');
      if (wp.state !== 'gate') setState(state, wp, 'gate', null, deps);
      return go(rebaseActions(state, wp), 'gate');
    case 'gate': {
      const command = gateCommandFor(state, wp, deps);
      const why = notRunnable(command, deps.platform);
      if (why && wp.gateCmd?.reason !== why) appendEvent(state, deps, { step: 'gate-cmd', event: 'not-exercised', data: { wpId: wp.id, reason: why } });
      wp.gateCmd = why ? { state: 'not-exercised', reason: why } : { state: 'run', command };
      if (why) return go(gateActs(state, wp, deps), 'merge');
      repoConfig(state, deps);
      let acts;
      try {
        acts = gateActs(state, wp, deps);
      } catch (error) {
        if (!(error instanceof ConductError)) throw error;
        if (mergeLockFor(state, wp) === 'mine') state.mergeLock = null;
        return block(state, wp, deps, error.message);
      }
      return go(acts, 'merge');
    }
    case 'merge': {
      if (!wp.gate?.ok) return go([], 'gate');
      // A merge the authority refuses queues nothing and goes back through land.
      const actions = mergeActions(state, wp, wp.gate.head, runAuthority(state));
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
  const stuck = (dep) => ['held', 'refuted', 'dropped', 'deferred'].includes(dep.state) || (dep.state === 'blocked' && !live);
  for (let changed = true, round = 0; changed && round < state.wps.length + 1; round += 1) {
    changed = false;
    for (const wp of state.wps) {
      if (wp.state === 'pending') {
        const dep = (wp.dependsOn ?? []).map((id) => byId.get(id)).find((candidate) => candidate && stuck(candidate));
        if (!dep) continue;
        setState(state, wp, 'deferred', `depends on ${dep.id}, which is ${dep.state}`, deps);
        wp.deferredBy = dep.id;
        changed = true;
      } else if (wp.state === 'deferred' && wp.deferredBy && !['held', 'refuted', 'dropped', 'deferred', 'blocked'].includes(byId.get(wp.deferredBy)?.state)) {
        setState(state, wp, 'pending', null, deps);
        wp.deferredBy = null;
        changed = true;
      }
    }
  }
}

// Before each dispatch and each paid lane action (`purpose` is 'dispatch' or
// the WP id): a start (exec `lane spawn` carries the first prompt), a prompt
// or a fallback. The lane-only lower bound (D16, D19.28). Returns null (go),
// 'halted' or 'ended'.
const paid = (action) => action.kind === 'shell' && ['start', 'prompt', 'fallback'].includes(action.step);
const budgetEnded = (state) => (state.build.halts ?? []).some((entry) => entry.kind === 'budget' && entry.ended);

// What spend does not show yet. A lane books its cost when it closes (in the
// lane log), so every live lane is counted at the per-WP projection, and a dispatch adds one more for the WP it
// starts. The projection is the mean cost of the lanes closed so far, else the
// repo config's laneEstimateUsd, else DEFAULT_LANE_ESTIMATE_USD. It over- rather
// than under-counts: a live lane's earlier sessions may already be booked.
const DEFAULT_LANE_ESTIMATE_USD = 15;
function laneProjection(state, deps) {
  const closed = state.wps.map((wp) => Number(wp.lane?.costUsd)).filter((cost) => Number.isFinite(cost) && cost > 0);
  if (closed.length) return { usd: closed.reduce((a, b) => a + b, 0) / closed.length, basis: `the mean of ${closed.length} closed lane(s)` };
  const configured = Number(repoConfig(state, deps).laneEstimateUsd);
  if (Number.isFinite(configured) && configured >= 0) return { usd: configured, basis: 'the repo config laneEstimateUsd' };
  return { usd: DEFAULT_LANE_ESTIMATE_USD, basis: 'the default estimate' };
}

function committed(state, deps, purpose, bookedUsd) {
  const projection = laneProjection(state, deps);
  const live = state.wps.filter((wp) => LIVE_STATES.includes(wp.state) || laneOccupied(wp)).length;
  const next = purpose === 'dispatch' ? 1 : 0;
  const money = (usd) => Math.round(usd * 100) / 100;
  const usd = money(bookedUsd + (live + next) * projection.usd);
  const parts = [`$${money(bookedUsd)} booked`, ...(live ? [`$${money(live * projection.usd)} for ${live} live lane(s)`] : []), ...(next ? [`$${money(projection.usd)} for the next WP`] : [])];
  return { usd, detail: `${parts.join(' + ')}; lanes at $${money(projection.usd)} each, ${projection.basis}` };
}

function budgetGate(state, deps, purpose) {
  if (budgetEnded(state)) return 'ended';
  if ((state.build.halts ?? []).some((entry) => entry.kind === 'budget')) return 'halted';
  const budget = runAuthority(state).budgetUsd;
  const sum = state.wps.reduce((total, wp) => total + (Number(wp.lane?.costUsd) || 0), 0);
  const spend = committed(state, deps, purpose, sum);
  if (spend.usd < budget) return null;
  haltTouch(state, deps, `Spend is $${spend.usd} committed (${spend.detail}) against the $${budget} budget (unmetered: booked is the lane-only lower bound)`, 'budget', spend.usd);
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
  // An approved re-plan is applied, then receipted, before any other build work.
  const replanStep = replanApply(state) ?? (spineOn(state) ? replanReceipt(state) : null);
  if (replanStep) return replanStep;
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
      return emitHead(wp);
    }
    return emitHead(wp);
  }
  if (spineOn(state)) {
    for (const touch of openBuildTouches(state)) {
      const spec = touchAction(state, touch, deps);
      // A waiting touch is re-read by the yield below, or handed back when idle.
      if (spec && !spec.handBack) return spec;
    }
  }
  if (state.dispatchHalt || !dispatchable(state, { now: deps.now() }).length) return null;
  const gate = budgetGate(state, deps, 'dispatch');
  if (gate === 'halted' || gate === 'ended') return workAction(state, deps);
  return dispatch(state, dispatchable(state, { now: deps.now() })[0], deps);
}

// A wait ends at a wall-clock deadline (`dueAt`, stamped when it first heads a
// queue, is opened or is re-armed) or when the yields recorded against it add
// up to its length, whichever comes first. Yield credit alone starves: a lane
// poll's 0 ms re-wait is always due, so the build never yields while a lane
// runs, and every other wait would sit until that lane stopped.
const leftMs = (creditMs, dueAt, now) => Math.min(creditMs, dueAt ? Date.parse(dueAt) - now : Infinity);
const touchWaits = (state, touch) => !spineOn(state) || touch.waiting;

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
}

// A stall is an alarm, not a touch: nothing waits for an answer and the build
// goes on. It is an event, a ledger note (the Dogan's ledger stream) when the
// ledger adapter is declared, and the notify command when that adapter is on,
// raised once per stall and re-armed when the WP moves again.
function alarm(state, wp, deps, why) {
  if (wp.stall) return;
  wp.stall = { at: deps.timestamp(), why };
  appendEvent(state, deps, { event: 'stalled', data: { wpId: wp.id, why } });
  const out = alarmActs(state, wp, deps, why);
  const queue = wp.queue ?? [];
  // A pending action must remain at the head until its result is recorded.
  // Polling it can enqueue alarms, but cannot displace or replay that work.
  const at = state.pending?.wpId === wp.id ? Math.min(1, queue.length) : 0;
  wp.queue = [...queue.slice(0, at), ...out, ...queue.slice(at)];
}

function alarmActs(state, wp, deps, why) {
  const text = `conduct ${state.slug}: ${wp.id} has stalled: ${why}. Nothing is asked of you; the run continues, and the alarm re-arms when ${wp.id} moves.`;
  const out = [];
  const notify = deps.env?.WORKIT_NOTIFY_CMD;
  if (state.adapters?.notify?.on && notify) {
    out.push(shell('alarm', 'notify', shellArgv(notify, deps.platform), { env: { WORKIT_NOTIFY_KIND: 'stalled', WORKIT_NOTIFY_TEXT: text } }));
  }
  if (state.adapters?.ledger?.on) {
    out.push({ kind: 'agent-tool', step: 'alarm', part: 'ledger', tool: 'ledger_write', expects: { type: 'json' },
      args: { event_type: 'note', source: 'cli', user_id: deps.env?.WORKIT_LEDGER_USER || 'conduct', payload: { content: text } },
      instruction: 'Call ledger_write with these args and record its raw result.' });
  }
  return out;
}

// A non-zero exit is a failure unless it printed a verdict: JSON with no
// `error` field (a gate that is pending, a check that wants an amendment) is an
// answer. A lane poll's exit is always its answer.
function failed(action, result) {
  if (result.code === 0 || action.step === 'wait') return false;
  try {
    const out = JSON.parse(result.stdout);
    return !out || typeof out !== 'object' || Object.hasOwn(out, 'error');
  } catch {
    return true;
  }
}

// An MCP tool result that failed: the call errored (`isError`), or it answered
// with an `error` or `ok: false`, or nothing came back (null, a non-object, `{}`).
const toolFailed = (result) => !result || typeof result !== 'object' || !Object.keys(result).length || result.isError === true || Boolean(result.error) || result.ok === false;
const toolError = (result) => {
  if (!result || typeof result !== 'object' || !Object.keys(result).length) return 'no result';
  const text = Array.isArray(result.content) ? result.content.map((part) => part?.text).filter(Boolean).join(' ') : '';
  return String(result.error ?? (text || (result.isError ? 'isError' : null)) ?? '').slice(0, 200) || null;
};

// Three failed records in a row of one shell step, with the WP's state
// unchanged between them.
function failStreak(state, wp, action, result, deps, stateBefore) {
  if (action.kind !== 'shell' || action.step === 'alarm') return;
  const key = `${action.step}/${action.part ?? ''}`;
  if (!failed(action, result) || wp.state !== stateBefore) {
    wp.failStreak = null;
    return;
  }
  const count = wp.failStreak?.key === key ? wp.failStreak.count + 1 : 1;
  wp.failStreak = { key, count };
  if (count >= STALL_FAILS) alarm(state, wp, deps, `${key} failed ${count} times in a row (exit ${result.code}: ${lines(result.stderr || result.stdout)[0] ?? ''})`);
}

// A WP with work queued, or live, whose state and stage have not moved for
// STALL_MS. A lane at work (a lane poll queued) is left to the lane deadline.
export function observePending(state, deps) { watchStalls(state, deps); }

function watchStalls(state, deps) {
  const now = deps.now();
  for (const wp of state.wps) {
    const watched = LIVE_STATES.includes(wp.state) || Boolean(wp.queue?.length);
    const head = wp.queue?.[0];
    const reviewing = ['review', 'council'].includes(head?.step);
    let seats = '';
    if (head?.step === 'council' && head.part === 'review' && head.args?.output_dir) {
      try {
        const progress = JSON.parse(readText(deps, join(head.args.output_dir, 'review-progress.json')));
        // Starting or finishing a seat advances progress; a capacity wait and
        // the model run each get their deadline. Heartbeats never extend it.
        seats = Object.entries(progress.seats ?? {}).map(([name, seat]) => `${name}:${seat.status}:${seat.startedAt ?? ''}`).sort().join(',');
      } catch { /* A consumer without progress artifacts uses the action clock. */ }
    }
    const at = `${wp.state}|${wp.stage ?? ''}${reviewing ? `|${head.step}|${head.part ?? ''}|${head.command?.join(' ') ?? head.tool ?? ''}|${seats}` : ''}`;
    const laneAtWork = Boolean(wp.queue?.some((action) => action.step === 'wait'));
    if (!watched || wp.progress?.at !== at || laneAtWork) {
      wp.progress = watched ? { at, since: new Date(now).toISOString() } : null;
      if (wp.stall && !laneAtWork) wp.stall = null;
      continue;
    }
    if (wp.stall) continue;
    const still = now - Date.parse(wp.progress.since);
    const limit = reviewing ? REVIEW_STALL_MS : STALL_MS;
    if (still >= limit) alarm(state, wp, deps, `no state or stage change for ${Math.round(still / 60000)} minutes (${wp.state}${wp.stage ? ` at ${wp.stage}` : ''})${reviewing ? `; waiting on ${head.step}/${head.part ?? ''}` : ''}`);
  }
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
  return out;
}

const waitText = (waitMs) => `Wait ${waitMs / 1000} s, then record {}.`;

function yieldWait(waiting) {
  const least = waiting.reduce((a, b) => (b.ms < a.ms ? b : a));
  return { kind: 'wait', step: least.step, part: 'yield', yield: true, waitMs: least.ms, instruction: `${waitText(least.ms)} Waiting: ${waiting.map((y) => y.note).join('; ')}` };
}

function release(y) {
  if (y.wp) y.wp.queue.shift();
  if (y.touch) {
    y.touch.waitLeftMs = null;
    y.touch.waitDueAt = null;
    y.touch.waiting = false;
  }
}

// A core touch is announced before any other work, once per opening.
function announce(state) {
  const unseen = spineOn(state) ? null : openBuildTouches(state).find((touch) => touch.status === 'open' && !touch.announced);
  if (!unseen) return null;
  unseen.announced = true;
  return { kind: 'wait', step: 'touch', part: 'announce', yield: true, waitMs: 0,
    instruction: `Stop and show the operator ${join(state.runDir, unseen.file)}: ${unseen.tag} is open${unseen.refusal ? ` again (${unseen.refusal})` : ''}. They answer from their own terminal: ${answerCommand(state, unseen)}. Then record {}.` };
}

// The build ends when nothing is live, queued, occupying a lane or waiting on
// a WP's touch.
function settled(state, deps) {
  const now = deps.now();
  const busy = state.wps.some((wp) => LIVE_STATES.includes(wp.state) || laneOccupied(wp) || wp.queue?.length
    || (wp.state === 'pending' && wp.notBefore && Date.parse(wp.notBefore) > now));
  // A re-plan's touch halts the run until it is answered: the build waits on it.
  const replanning = openBuildTouches(state).some((touch) => touch.wpId || touch.build === 'replan');
  return !busy && !replanning && !dispatchable(state, { now }).length;
}

export function next(state, deps) {
  state.build ??= { contract: null, halts: [] };
  if (!state.build.contract) return contractAction(state, deps);
  applyAnswers(state, deps);
  deferrals(state, deps);
  stampWaits(state, deps);
  watchStalls(state, deps);
  const action = chooseAction(state, deps);
  // A wait queued while choosing (by fill, or under a released head) starts
  // its deadline now, not after the action emitted with it has run.
  stampWaits(state, deps);
  return action;
}

function chooseAction(state, deps) {
  const first = announce(state);
  if (first) return first;
  for (let pass = 0; pass < 8; pass += 1) {
    const action = workAction(state, deps);
    // Scheduling can open a touch (the budget): its announce goes first, and
    // the prepared action is derived again from the queue at the next `next`.
    const opened = announce(state);
    if (opened) return opened;
    if (action) return action;
    // A WP that blocked during this pass did so after next()'s deferrals ran:
    // run them again before deciding the build is over, so its dependents end
    // `deferred` (named by the showcase), not `pending` (quest 5a848b95). One
    // that is un-deferred instead is dispatchable, and the build goes on.
    deferrals(state, deps);
    // A run touch (no wpId) still open stays open into the showcase (D16).
    if (settled(state, deps)) break;
    const waiting = yielders(state, deps);
    const due = waiting.filter((y) => y.ms <= 0);
    if (due.length) {
      due.forEach(release);
      continue;
    }
    // Nothing but spine touches to wait on (no lane poll or re-admission that
    // can act): only the operator can move the build, so it hands back.
    const touchYield = waiting.find((y) => y.touch);
    if (spineOn(state) && touchYield && waiting.every((y) => y.touch)) return handBackAction(state, touchYield.touch);
    if (waiting.length) return yieldWait(waiting);
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
}

function recordRuling(state, wp, action, deps) {
  const value = readJsonFile(deps, action.outPath, 'ruling');
  const { n, file, keys, asks, row } = action.ruling;
  // An ask is ruled once, whatever the lane's next report repeats.
  const settled = () => { wp.ruledAsks = [...(wp.ruledAsks ?? []), ...(asks ?? []).map(askId)]; };
  if (value?.escalate === true) {
    if (typeof value.why !== 'string' || !value.why.trim()) throw new ConductError(2, `ruling ${file}: an escalation needs a non-empty why`);
    wp.rulings = [...(wp.rulings ?? []), { n, file, ruled: null, escalate: true }];
    settled();
    appendEvent(state, deps, { step: 'ruling', event: 'ruled', data: { wpId: wp.id, n, file, ruled: null, escalate: true } });
    // The rest of the owed adjudication (other replies and rulings) waits for the answer.
    if (row) wp.owed = { ...(wp.owed ?? {}), queue: wp.queue.slice(1) };
    wp.queue = [];
    return escalate(state, wp, deps, { why: value.why, asks, row });
  }
  if (!keys.includes(value?.ruled)) throw new ConductError(2, `ruling ${file}: ruled must be one of ${keys.join(', ')} (got ${value?.ruled})`);
  if (typeof value.evidence !== 'string' || !value.evidence.trim()) throw new ConductError(2, `ruling ${file}: evidence must name the measurement or file that settles the fork`);
  const ratified = value.ratify ?? [];
  if (!Array.isArray(ratified) || ratified.some((path) => typeof path !== 'string' || !path.trim()) || (row && ratified.length)) {
    throw new ConductError(2, `ruling ${file}: ratify must be a list of paths${row ? ', and a guard ruling ratifies none' : ''}`);
  }
  if (ratified.length) applyRatify(state, wp, ratified, `ruling ${file}: (${value.ruled}) ${value.evidence.trim()}`, deps);
  wp.rulings = [...(wp.rulings ?? []), { n, file, ruled: value.ruled, escalate: false, ...(ratified.length ? { ratified } : {}) }];
  settled();
  appendEvent(state, deps, { step: 'ruling', event: 'ruled', data: { wpId: wp.id, n, file, ruled: value.ruled, ratified } });
  wp.queue.shift();
  if (row) {
    wp.queue = [...conductorVerdict(state, wp, row, value.ruled, deps, value.evidence), ...wp.queue];
    return undefined;
  }
  // Every open question is ruled before the lane hears any of them: its next
  // report may not repeat a question it is still waiting on.
  const ruling = { file, ruled: value.ruled, evidence: value.evidence, question: asks?.[0]?.question ?? null };
  if ((wp.asks ?? []).some((ask) => !askRuled(wp, ask))) {
    wp.heldRulings = [...(wp.heldRulings ?? []), ruling];
    return undefined;
  }
  const all = [...(wp.heldRulings ?? []), ruling];
  wp.heldRulings = [];
  if (all.length === 1) return startAmendment(state, wp, deps, { kind: 'ruling', reason: `ruling ${file}: (${value.ruled})`, ruled: value.ruled, evidence: value.evidence });
  return startAmendment(state, wp, deps, { kind: 'ruling', reason: `rulings ${all.map((r) => `${r.file}: (${r.ruled})`).join(', ')}`, rulings: all });
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
      if (action.append) {
        // The whole append, as one block of the brief's own text: every
        // non-blank line in order (council review 1), none inside a code
        // fence (review #248: a quoted copy is not an instruction). CRLF,
        // blank lines and edge whitespace are forgiven.
        const want = action.append.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const have = markLines(readText(deps, action.outPath) ?? '').filter((line) => line.text.trim());
        const carried = have.some((_, i) => want.every((line, j) => have[i + j] && !have[i + j].fenced && have[i + j].text.trim() === line));
        if (!carried) throw new ConductError(2, `the brief ${action.outPath} does not carry the appended section (${want[0]}) verbatim, in order and outside any code fence: append the action's append text verbatim`);
      }
      {
        const roots = [wp.lane.worktree];
        if (basename(dirname(wp.lane.worktree)) === 'projects') roots.push(dirname(dirname(wp.lane.worktree)));
        const missing = briefPaths(readText(deps, action.outPath) ?? '').filter((path) => !covered(allowedMissing(state, wp), path)
          && !roots.some((root) => deps.exists(join(root, path))));
        if (missing.length) throw new ConductError(2, `brief preflight: paths not found: ${missing.join(', ')}. Correct the repo-relative paths in ${action.outPath}, or declare intentionally created files as Create paths. Record this same author action again; the lane has not been prompted.`);
      }
      return ok();
    case 'ruling': return recordRuling(state, wp, action, deps) ?? true;
    case 'ratify': {
      const value = readJsonFile(deps, action.outPath, 'ratify ruling');
      if (typeof value?.ratify !== 'boolean') throw new ConductError(2, `ratify ruling ${action.outPath}: ratify must be true or false`);
      if (typeof value.why !== 'string' || !value.why.trim()) throw new ConductError(2, `ratify ruling ${action.outPath}: why must say why`);
      if (value.ratify) applyRatify(state, wp, action.paths, value.why.trim(), deps);
      else {
        wp.heldOutside = null;
        appendEvent(state, deps, { event: 'ratify-declined', data: { wpId: wp.id, paths: action.paths, why: value.why.trim() } });
      }
      wp.queue = (wp.queue ?? []).filter((queued) => queued !== action && queued.step !== 'ratify');
      return true;
    }
    case 'cite': {
      const value = readJsonFile(deps, action.outPath, 'cite ruling');
      const cite = value?.cite;
      if (cite !== false && (!cite || typeof cite !== 'object' || Array.isArray(cite) || !Object.keys(cite).length)) {
        throw new ConductError(2, `cite ruling ${action.outPath}: cite must be { "<sha>": "<comment id>", … } or false`);
      }
      if (typeof value.why !== 'string' || !value.why.trim()) throw new ConductError(2, `cite ruling ${action.outPath}: why must say why`);
      if (cite) applyCite(state, wp, action, cite, value.why.trim(), deps);
      else {
        wp.heldUncited = null;
        appendEvent(state, deps, { event: 'cite-declined', data: { wpId: wp.id, shas: action.shas, why: value.why.trim() } });
      }
      wp.queue = (wp.queue ?? []).filter((queued) => queued !== action && queued.step !== 'cite');
      return true;
    }
    case 'council/meta':
      if (readJsonFile(deps, action.outPath, 'council meta')?.title !== action.title) throw new ConductError(2, `${action.outPath} must be { "title": "${action.title}" }`);
      return ok();
    case 'notify':
      if (result.code !== 0) appendEvent(state, deps, { step: 'notify', event: 'notify-failed', data: { wpId: wp.id, code: result.code } });
      return ok();
    case 'alarm':
      // An alarm that cannot be delivered is recorded, never a reason to stop.
      if (action.kind === 'shell' ? result.code !== 0 : toolFailed(result)) {
        appendEvent(state, deps, { step: 'alarm', event: 'alarm-failed', data: { wpId: wp.id, part: action.part, code: result?.code ?? null, error: toolError(result) } });
      }
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
        const since = recoveryBaseline(state, wp, deps);
        if (wp.state === 'blocked') return true;
        if (wp.fullReviewOwed) return (wp.stage = 'delta');
        // A saved action from an older conductor may have diffed from a
        // later amendment. Recompute the range rather than trust its result.
        if (action.command.at(-2) !== since) return (wp.stage = 'delta');
        // An executable line: any changed file that is not Markdown, tests and fixtures counted (D19.7, D20).
        if (!wp.deltaRecovery || wp.deltaRecovery.reviewedHead !== (wp.reviews ?? []).at(-1)?.head) {
          if (!changed.some((path) => !path.toLowerCase().endsWith('.md') || isTestPath(path))) return (wp.stage = 'land');
        }
        setState(state, wp, 'review', null, deps);
        wp.councilScope = { round: latestRound(wp) + 1, scope: 'delta', since, paths: changed };
        wp.queue = emitting(state, wp, deps, () => withMeta(state, wp, deltaReviewActions(state, wp, since, { report, changedPaths: absolute })));
        return (wp.stage = wp.state === 'blocked' ? null : 'reviewed');
      }
      const config = repoConfig(state, deps);
      wp.changedPaths = changed;
      const decision = tierDecision(wp, changed, Array.isArray(config.contractPaths) ? config.contractPaths : [], registeredHookCommands(wp, deps),
        { repo: state.intent.repo.remote, settingsHooksChanged: hooksBlockChanged(state, wp, changed, deps) });
      wp.tierDecision = decision;
      wp.tier = decision.tier;
      appendEvent(state, deps, { step: 'review', event: 'tier-classified', data: { wpId: wp.id, changedPaths: changed, ...decision } });
      if (wp.fullReviewOwed && effectiveTier(wp) === 'T0') wp.tier = 'T1';
      wp.fullReviewOwed = null;
      if (effectiveTier(wp) === 'T0') return (wp.stage = 'land');
      setState(state, wp, 'review', null, deps);
      const round = latestRound(wp) + 1;
      wp.councilScope = { round, scope: 'full', since: null, paths: changed };
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
  // Only an `alive` reading (the wait, the probe, the confirmation) says anything about liveness.
  // Every other stop (a kill, a reap, a worktree removal, a branch delete) exits 1 for its own
  // reasons, so the reads are named here rather than the rest excluded.
  const aliveRead = action.step === 'wait' || (action.step === 'stop' && ['probe', 'confirm'].includes(action.part));
  if (wp.lane?.backend !== 'exec' || !aliveRead) return null;
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
  const hold = runAuthority(state).merge !== true;
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
      else if (patch.queue?.some((a) => (a.step === 'review' && a.part !== 'delta-count') || a.step === 'post' || (a.step === 'council' && a.part === 'review'))) {
        wp.queue = withMeta(state, wp, wp.queue);
        wp.stage = 'reviewed';
      }
      const added = (wp.reviews ?? []).length > before ? wp.reviews.at(-1) : null;
      // Zero findings (D20): no amendment, adjudication or resolve; the rest of the review array is dropped.
      if (added?.findings === 0) {
        const record = added.escalatedDeltaReviewId ? councilRecord(state, wp, []) : null;
        if (record) {
          deps.mkdir(dirname(record.path));
          deps.write(record.path, record.body);
        }
        wp.queue = record ? [record.action] : [];
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
      if (wp.heldOutside?.length) wp.queue.push(ratifyAction(state, wp));
      if (wp.heldUncited?.length) wp.queue.push(citeAction(state, wp));
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
        // The checked stage rules its asks one question at a time, as for a built report.
        wp.stage = 'checked';
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
  if (action.touch) return recordTouch(state, state.touches[action.touch.n - 1], action, result, deps);
  if (action.step === 'replan') return action.part === 'apply' ? recordReplanApply(state, action, deps) : recordReplanReceipt(state, action, result, deps);
  const wp = state.wps.find((candidate) => candidate.id === action.wpId);
  if (!wp) throw new ConductError(2, `action ${action.id} names no WP of this run (${action.wpId})`);
  // A malformed visual read is refused (exit 2, nothing written): fix the record and record again.
  if (action.kind === 'inspect' && action.part === 'visual') {
    const problem = visualReadProblem(action, result, deps.exists);
    if (problem) throw new ConductError(2, `visual read of ${wp.id}: ${problem}`);
  }
  const before = wp.state;
  const out = recordStep(state, wp, action, result, deps);
  failStreak(state, wp, action, result, deps, before);
  return out;
}

function recordStep(state, wp, action, result, deps) {
  if (recordOwn(state, wp, action, result, deps) !== undefined) return undefined;
  const recorderDeps = { exec: deps.exec, read: deps.read, exists: deps.exists, now: deps.now, platform: deps.platform, env: deps.env, pluginRoot: deps.pluginRoot };
  if (LANE_STEPS.has(action.step)) {
    if (liveness(state, wp, action, result, deps) === 'polling') return undefined;
    return route(state, wp, action, recordLaneStep(state, wp, action, result, recorderDeps), deps);
  }
  if (LAND_STEPS.has(action.step)) {
    const out = recordLandStep(state, wp, action, result, recorderDeps, runAuthority(state));
    return route(state, wp, action, noCi(state, wp, action, out, deps), deps);
  }
  throw new ConductError(2, `the build has no route for step ${action.step}`);
}
