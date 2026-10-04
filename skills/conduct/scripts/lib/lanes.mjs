// Lane backends. Each step of a lane (admit, create, start, prompt, wait,
// check, stop) is an array of actions for the agent to run; recordLaneStep
// turns each action's result into a routed outcome. Two backends: herdr
// drives scripts/lane.mjs through its CLI; exec is git worktree plus a
// detached headless agent, which `lane spawn` starts and records by pid.
import { basename, dirname, join, resolve } from 'node:path';
import { LANE_MODELS, laneModel } from './adapters.mjs';
import { resolveProgram } from './exec.mjs';
import { ConductError, STEPS, STEP_SEAM, appendEvent, loadState, saveState } from './state.mjs';
import { EXIT_CODES as LANE_EXIT, reportShapeProblems } from '../../../../scripts/lane.mjs';

const DEADLINE_MS = 120 * 60 * 1000;
const POLL_MS = 60000;
const SHA = /^[0-9a-f]{40}$/;
const VERDICT = /^Verdict: (exercised|vacuous|not exercised|no runtime surface)$/;

// Where a WP's lane lives: names and paths every step agrees on.
export function laneLayout(state, wp) {
  const lower = wp.id.toLowerCase();
  const repo = resolve(state.intent.repo.path);
  return {
    name: `${state.slug}-${lower}`,
    branch: `conduct/${state.slug}/${lower}`,
    worktree: join(dirname(repo), `${basename(repo)}-wt-${state.slug}-${lower}`),
    briefPath: join(state.runDir, `lane-${lower}.md`),
    reportPath: join(state.runDir, `lane-${lower}-report.md`),
    logPath: join(state.runDir, `lane-${lower}.log`),
    runnerLog: join(state.runDir, 'lane-runner.jsonl'),
  };
}

function shellAction(step, fields) {
  if (!STEPS.includes(step)) throw new ConductError(2, `lane action step ${step} is not in STEPS`);
  return { kind: 'shell', step, seam: STEP_SEAM[step], expects: { type: 'none' }, ...fields };
}

const waitAction = (waitMs) => ({ kind: 'wait', step: 'wait', seam: STEP_SEAM.wait, waitMs, instruction: `Wait ${waitMs / 1000} s, then record {}.` });

// herdr when the adapter is on and the lane path lane.mjs create derives
// (<repo>-wt-<slug>, beside the repo) passes its assertUnderProjects rule
// (scripts/lane.mjs:953-970); exec otherwise.
export function chooseBackend(state, deps) {
  if (!state.adapters?.herdr?.on) return { backend: 'exec', detail: `herdr adapter off (${state.adapters?.herdr?.detail ?? 'not probed'})` };
  const parent = dirname(resolve(state.intent.repo.path));
  const root = deps.env?.WORKIT_WORKSPACE_ROOT;
  if (root) {
    const required = join(resolve(root), 'projects');
    if (parent !== required) return { backend: 'exec', detail: `lane.mjs create would refuse: the lane must live under ${required}, not ${parent}` };
    return { backend: 'herdr', detail: `herdr on; ${parent} is WORKIT_WORKSPACE_ROOT's projects tree` };
  }
  if (basename(parent) !== 'projects') return { backend: 'exec', detail: `lane.mjs create would refuse: ${parent} is not a projects tree` };
  return { backend: 'herdr', detail: `herdr on; ${parent} is a projects tree` };
}

// The agent argv of an exec lane: first run, or a resume of `sessionId`.
export function agentArgv(state, wp, { brief, sessionId = null }, deps) {
  const agent = state.intent.agent;
  const model = laneModel(agent, wp.model);
  const prompt = `Read ${brief} and execute it exactly.`;
  if (agent === 'claude') {
    const options = ['--permission-mode', 'bypassPermissions', '--model', model, '--effort', 'high', '--output-format', 'json'];
    return ['claude', '-p', ...(sessionId ? ['--resume', sessionId] : []), ...options, prompt];
  }
  // Options before `resume`: `codex exec resume … --sandbox` is rejected.
  const codex = [resolveProgram('codex', { platform: deps.platform, resolveCodex: deps.resolveCodex }), 'exec', '--sandbox', 'danger-full-access',
    '-c', `model=${model}`, '-c', 'model_reasoning_effort=high', '--json'];
  return sessionId ? [...codex, 'resume', sessionId, prompt] : [...codex, prompt];
}

export function laneBackend(state, deps, backend) {
  const repo = resolve(state.intent.repo.path);
  const fallbackBranch = state.intent.repo.defaultBranch ?? 'main';
  const conduct = (sub, wp, extra = []) => ['node', join(deps.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs'), 'lane', sub, '--run', state.runDir, '--wp', wp.id, ...extra];
  const prLookup = (wp) => shellAction('pr-lookup', {
    instruction: 'List the lane branch\'s PRs and record the JSON.', expects: { type: 'json' },
    command: ['gh', 'pr', 'list', '--repo', state.intent.repo.remote, '--head', laneLayout(state, wp).branch, '--state', 'all', '--json', 'number,headRefOid,state'],
  });
  const base = () => [
    shellAction('create', { part: 'fetch', instruction: 'Fetch origin.', command: ['git', '-C', repo, 'fetch', 'origin'] }),
    shellAction('base', { instruction: 'Resolve the base sha.', command: ['git', '-C', repo, 'rev-parse', `origin/${fallbackBranch}`] }),
  ];
  if (backend === 'herdr') {
    const laneMjs = (verb, args, log) => ['node', join(deps.pluginRoot, 'scripts', 'lane.mjs'), verb, ...args, '--log', log];
    return {
      name: 'herdr',
      admit: () => [shellAction('admit', { instruction: 'Ask lane.mjs whether a lane may start.', command: laneMjs('admit', [], join(state.runDir, 'lane-runner.jsonl')) })],
      create: (wp) => {
        const lane = laneLayout(state, wp);
        return [...base(), shellAction('create', {
          part: 'lane', instruction: 'Create the lane worktree and pane.', expects: { type: 'json' },
          command: laneMjs('create', ['--repo', repo, '--branch', lane.branch, '--base', `origin/${fallbackBranch}`, '--label', lane.name,
            '--slug', `${state.slug}-${wp.id.toLowerCase()}`], lane.runnerLog),
        })];
      },
      start: (wp) => {
        const lane = laneLayout(state, wp);
        const agent = state.intent.agent;
        const args = [lane.name, '--pane', wp.lane.paneId, '--kind', agent, '--model', laneModel(agent, wp.model), '--reasoning', 'high'];
        if (agent === 'codex') args.push('--sandbox', 'danger-full-access');
        return [shellAction('start', { instruction: 'Start the lane agent.', command: laneMjs('start', args, lane.runnerLog) })];
      },
      // Every prompt after the first is an amendment. A spine answer's receipt
      // is named only when a resolver can resolve it; otherwise the brief
      // quotes the answer (rulingCarried: 'brief').
      prompt: (wp, { amendment = false, answer = null } = {}) => {
        const lane = laneLayout(state, wp);
        const args = [lane.name, '--file', wp.lane.briefPath];
        const byReceipt = Boolean(answer?.receiptId && deps.env?.WORKIT_RECEIPT_RESOLVER);
        if (amendment) args.push('--amendment', ...(byReceipt ? ['--ruling-receipt', answer.receiptId, '--quest', state.intent.anchor] : ['--no-ruling']));
        return [shellAction('prompt', {
          instruction: 'Send the lane its brief.', command: laneMjs('prompt', args, lane.runnerLog),
          ...(amendment && answer && !byReceipt ? { data: { rulingCarried: 'brief' } } : {}),
        })];
      },
      wait: (wp) => {
        const lane = laneLayout(state, wp);
        return [shellAction('wait', { instruction: 'Poll the lane once.', command: laneMjs('wait', [lane.name, '--until', 'done', '--until', 'idle', '--timeout', '60000'], lane.runnerLog) })];
      },
      check: (wp) => {
        const lane = laneLayout(state, wp);
        return [
          shellAction('check', { part: 'shape', instruction: 'Check the report\'s shape.', command: laneMjs('check', [lane.name, '--expect-report', lane.reportPath], lane.runnerLog) }),
          shellAction('check', { part: 'report', seam: 'runtime-exercise', instruction: 'Check the report\'s outcome and runtime exercise.', command: conduct('check', wp, ['--runtime-only']) }),
          prLookup(wp),
          shellAction('check', { part: 'pr', instruction: 'Check the PR.', command: laneMjs('check', [lane.name, '--expect-pr', '{pr.number}'], lane.runnerLog) }),
        ];
      },
      stop: (wp) => [shellAction('stop', { instruction: 'Stop the lane agent.', command: laneMjs('stop', [laneLayout(state, wp).name], laneLayout(state, wp).runnerLog) })],
    };
  }
  return {
    name: 'exec',
    admit: () => [],
    create: (wp) => {
      const lane = laneLayout(state, wp);
      return [...base(), shellAction('create', {
        part: 'worktree', instruction: 'Add the lane worktree beside the repo.',
        command: ['git', '-C', repo, 'worktree', 'add', lane.worktree, '-b', lane.branch, `origin/${fallbackBranch}`],
      })];
    },
    // The first prompt rides the spawn; an amendment resumes the session.
    start: (wp) => [shellAction('start', { instruction: 'Start the lane agent, detached.', command: conduct('spawn', wp) })],
    prompt: (wp, { amendment = false } = {}) => (amendment
      ? [shellAction('prompt', { instruction: 'Resume the lane agent on its amended brief.', command: conduct('spawn', wp, ['--amend', wp.lane.briefPath]) })]
      : []),
    wait: (wp) => [shellAction('wait', { instruction: 'Ask whether the lane agent still runs.', command: conduct('alive', wp) })],
    check: (wp) => [
      shellAction('check', { part: 'report', instruction: 'Check the lane report.', command: conduct('check', wp) }),
      prLookup(wp),
      shellAction('check', { part: 'pr', instruction: 'Check the PR.', command: conduct('check', wp, ['--pr', '{pr.number}']) }),
    ],
    // An exec lane is checked only after its process exited: nothing to stop.
    stop: () => [],
  };
}

// The lines of the level-2 section `title` (fenced lines marked), or null.
function reportSection(text, title) {
  let fenced = false;
  const lines = String(text ?? '').split(/\r?\n/).map((raw) => {
    const fence = /^ {0,3}(```|~~~)/.test(raw);
    if (fence) fenced = !fenced;
    return { text: raw.replace(/\s+$/, ''), fenced: fenced || fence };
  });
  const start = lines.findIndex((line) => !line.fenced && (line.text === `## ${title}` || line.text.startsWith(`## ${title}:`)));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && !line.fenced && /^#{1,2}\s/.test(line.text));
  return { heading: lines[start].text, lines: lines.slice(start + 1, end < 0 ? lines.length : end).filter((line) => !line.fenced) };
}

// D19.23: only two anchored markers are read; prose never is.
export function runtimeExerciseVerdict(reportText, wp) {
  const section = reportSection(reportText, 'Runtime exercise');
  const verdict = section?.lines.map((line) => VERDICT.exec(line.text)).find(Boolean)?.[1];
  if (!verdict) return 'missing';
  if (/^none\b/i.test(String(wp?.runtimeExercise ?? '').trim())) return 'no-surface';
  if (verdict === 'not exercised' || verdict === 'no runtime surface') return 'not-exercised';
  if (verdict === 'vacuous') return 'vacuous';
  return section.lines.some((line) => /^Would have shown:\s*\S/.test(line.text)) ? 'exercised' : 'vacuous';
}

const VERDICT_PASSES = new Set(['exercised', 'no-surface']);

// D19.16, D20: `## Outcome` + first body line, or `## Outcome: <value>`.
export function parseOutcome(reportText) {
  const section = reportSection(reportText, 'Outcome');
  if (!section) return { outcome: 'missing', asks: [] };
  const raw = section.heading.startsWith('## Outcome:') ? section.heading.slice('## Outcome:'.length) : section.lines.find((line) => line.text.trim())?.text ?? '';
  const value = raw.replace(/[*_`]/g, '').trim().toLowerCase();
  const outcome = /^built\b/.test(value) ? 'built' : /^refuted\b/.test(value) ? 'refuted' : /^stopped:\s*needs conductor\b/.test(value) ? 'needs-conductor' : 'missing';
  const asks = (reportSection(reportText, 'Needs conductor')?.lines ?? [])
    .map((line) => ({ match: /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\(([a-f])\)/.exec(line.text.trim()), text: line.text.trim() }))
    .filter(({ match }) => match).map(({ match, text }) => ({ key: match[1], text }));
  return { outcome, asks };
}

// The report's `## PR`: a number and a head sha (7–40 hex), or nulls.
function reportPr(text) {
  const body = (reportSection(text, 'PR')?.lines ?? []).map((line) => line.text).join('\n');
  return { number: Number(/#?(\d+)\b/.exec(body)?.[1] ?? NaN) || null, head: /\b([0-9a-f]{7,40})\b/.exec(body)?.[1] ?? null };
}

// The last JSON object in a lane log (stdout and stderr share the file).
function lastJson(text, key) {
  const objects = String(text ?? '').split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((value) => value && (!key || value[key] !== undefined));
  return objects.at(-1) ?? null;
}

function readLog(deps, path) {
  try {
    return deps.read(path);
  } catch {
    return '';
  }
}

function parseStdout(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// A failure's words: stderr, then stdout's `error` (lane.mjs prints its error
// there and only a log line on stderr) or stdout itself.
function said(result) {
  const error = parseStdout(result)?.error;
  return [String(result.stderr ?? '').trim(), error ?? String(result.stdout ?? '').trim()].filter(Boolean).join(' | ') || `exit ${result.code}`;
}
const block = (reason, patch = {}) => ({ outcome: 'block', reason, patch });

function startedPatch(deps, startedAt = null) {
  const at = startedAt ? Date.parse(startedAt) : deps.now();
  return { startedAt: new Date(at).toISOString(), deadline: new Date(at + DEADLINE_MS).toISOString() };
}

// The lane is still running: past the deadline it blocks, else it yields.
// A herdr wait already polled for 60 s, so its yield is 0 ms.
function stillRunning(wp, deps, retry, waitMs) {
  if (wp.lane?.deadline && deps.now() > Date.parse(wp.lane.deadline)) return block('lane deadline', { queue: [] });
  return { outcome: 'wait', reason: 'lane running', patch: { queue: [waitAction(waitMs), ...retry] } };
}

// D19.15, D20: one result interface. `patch.lane` merges into wps[].lane;
// `patch.queue` replaces the WP's queued actions; other keys replace fields.
export function recordLaneStep(state, wp, action, result, deps) {
  if (action.kind === 'wait') return { outcome: 'continue', reason: null, patch: {} };
  const lane = laneLayout(state, wp);
  const backend = laneBackend(state, deps, wp.lane?.backend ?? 'exec');
  const ok = result.code === 0;
  switch (action.step) {
    case 'admit':
      if (result.code === LANE_EXIT.admitRefused) return { outcome: 'wait', reason: `admission refused: ${said(result)}`, patch: { state: 'pending', queue: [] } };
      return ok ? { outcome: 'continue', reason: null, patch: {} } : block(said(result));
    case 'base': {
      const sha = String(result.stdout ?? '').trim();
      return ok && SHA.test(sha) ? { outcome: 'continue', reason: null, patch: { lane: { base: sha } } } : block(`base sha: ${said(result)}`);
    }
    case 'create': {
      if (!ok) return block(said(result));
      if (action.part === 'fetch') return { outcome: 'continue', reason: null, patch: {} };
      if (action.part === 'lane') {
        const created = parseStdout(result);
        if (!created?.paneId || !created?.path) return block(`lane.mjs create printed no paneId/path: ${said(result)}`);
        return { outcome: 'continue', reason: null, patch: { lane: { name: lane.name, paneId: created.paneId, worktree: created.path, branch: created.branch ?? lane.branch, briefPath: lane.briefPath } } };
      }
      return { outcome: 'continue', reason: null, patch: { lane: { name: lane.name, worktree: lane.worktree, branch: lane.branch, briefPath: lane.briefPath, logPath: lane.logPath } } };
    }
    case 'start':
    case 'prompt': {
      // A start refused for memory re-arms start, never create (lane.mjs
      // refuses a create once the branch or worktree path exists).
      if (action.step === 'start' && result.code === LANE_EXIT.admitRefused) {
        return { outcome: 'wait', reason: `start refused: ${said(result)}`, patch: { queue: [waitAction(POLL_MS), ...backend.start(wp)] } };
      }
      if (!ok) return block(said(result));
      return { outcome: 'continue', reason: null, patch: { lane: startedPatch(deps, parseStdout(result)?.startedAt) } };
    }
    case 'fallback':
      return ok ? { outcome: 'continue', reason: null, patch: { lane: { fallback: 'claude' } } } : block(said(result));
    case 'wait':
      return wp.lane?.backend === 'herdr' ? recordHerdrWait(state, wp, result, deps, backend) : recordExecWait(state, wp, result, deps, backend);
    case 'check':
      return recordCheck(wp, action, result, backend);
    case 'pr-lookup':
      return recordPrLookup(wp, lane, result, deps);
    case 'stop':
      return ok ? { outcome: 'done', reason: 'lane stopped', patch: {} } : block(`stop: ${said(result)}`);
    default:
      throw new ConductError(2, `recordLaneStep has no route for step ${action.step}`);
  }
}

function recordHerdrWait(state, wp, result, deps, backend) {
  const name = laneLayout(state, wp).name;
  switch (result.code) {
    case LANE_EXIT.ok: return { outcome: 'continue', reason: null, patch: {} };
    case LANE_EXIT.timeout: return stillRunning(wp, deps, backend.wait(wp), 0);
    case LANE_EXIT.planLow: {
      const fallback = shellAction('fallback', {
        instruction: 'Hand the lane to claude.',
        command: ['node', join(deps.pluginRoot, 'scripts', 'lane.mjs'), 'fallback', name, '--to', 'claude', '--model', LANE_MODELS.claude.opus, '--reasoning', 'high', '--log', laneLayout(state, wp).runnerLog],
      });
      return { outcome: 'continue', reason: 'plan low: falling back to claude', patch: { queue: [fallback, ...backend.wait(wp)] } };
    }
    case LANE_EXIT.capacity:
      return { outcome: 'continue', reason: 'capacity: re-sending the brief once', patch: { queue: [...backend.prompt(wp, { amendment: true }), ...backend.wait(wp)] } };
    default:
      // 1 error, 2 usage, 3 a dialog blocks the lane (WP-04 opens a touch).
      return block(said(result));
  }
}

function recordExecWait(state, wp, result, deps, backend) {
  if (result.code === 0) return stillRunning(wp, deps, backend.wait(wp), POLL_MS);
  if (result.code !== 1) return block(said(result));
  // The agent exited: read its session id and, for claude, its cost.
  const log = readLog(deps, wp.lane?.logPath ?? laneLayout(state, wp).logPath);
  const claude = state.intent.agent === 'claude';
  const last = lastJson(log, claude ? 'session_id' : 'thread_id');
  const patch = { lane: { sessionId: (claude ? last?.session_id : last?.thread_id) ?? wp.lane?.sessionId ?? null } };
  if (claude) patch.lane.costUsd = typeof last?.total_cost_usd === 'number' ? last.total_cost_usd : null;
  return { outcome: 'continue', reason: null, patch };
}

function recordCheck(wp, action, result, backend) {
  if (action.part === 'report') {
    const checked = parseStdout(result);
    if (!checked) return block(`lane check printed no JSON: ${said(result)}`);
    const patch = { runtimeVerdict: checked.verdict ?? null };
    // Outcome first (D19.16): nothing after the report check runs unless built.
    if (checked.outcome === 'refuted') return { outcome: 'done', reason: 'refuted', patch: { ...patch, state: 'refuted', queue: backend.stop(wp) } };
    if (checked.outcome === 'needs-conductor') return block('needs conductor', { ...patch, asks: checked.asks ?? [], queue: [] });
    if (checked.outcome === 'missing') return { outcome: 'amend', reason: `report: ${(checked.failures ?? []).join('; ') || '## Outcome missing'}`, patch: { ...patch, queue: [] } };
    if (result.code === 5) return { outcome: 'amend', reason: (checked.failures ?? []).join('; '), patch: { ...patch, queue: [] } };
    return result.code === 0 ? { outcome: 'continue', reason: null, patch } : block(said(result), patch);
  }
  if (result.code === 0) return { outcome: 'continue', reason: null, patch: {} };
  if (result.code === 5) return { outcome: 'amend', reason: `${action.part} check: ${said(result)}`, patch: { queue: [] } };
  return block(said(result));
}

function recordPrLookup(wp, lane, result, deps) {
  if (result.code !== 0) return block(`gh pr list: ${said(result)}`);
  const prs = parseStdout(result);
  if (!Array.isArray(prs)) return block(`gh pr list printed no JSON array: ${said(result)}`);
  const branch = wp.lane?.branch ?? lane.branch;
  // Every later action carries {pr.number}: with no PR they are dropped.
  if (prs.length === 0) return { outcome: 'amend', reason: `no PR for ${branch}`, patch: { queue: [] } };
  const pr = prs.find((candidate) => candidate.state === 'OPEN') ?? prs[0];
  const found = { number: pr.number, head: pr.headRefOid };
  const claimed = reportPr(readLog(deps, lane.reportPath));
  if (claimed.number !== found.number || !claimed.head || !found.head?.startsWith(claimed.head)) {
    return { outcome: 'amend', reason: `the report's ## PR says #${claimed.number ?? '?'} at ${claimed.head ?? '?'}; GitHub has #${found.number} at ${found.head}`, patch: { pr: found, queue: [] } };
  }
  return { outcome: 'continue', reason: null, patch: { pr: found } };
}

const SUB_FLAGS = { spawn: ['amend'], alive: [], check: ['pr', 'runtimeOnly'] };
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const reply = (code, out) => ({ code, out: JSON.stringify(out) });

// D19.21: { code, out }; never prints, never sets process.exitCode.
export async function runLaneVerb(sub, { runDir, wpId, flags = {}, state = null }, deps) {
  if (!Object.hasOwn(SUB_FLAGS, sub)) return reply(2, { ok: false, error: `unknown lane sub-verb ${sub}` });
  const unknown = Object.keys(flags).filter((name) => !SUB_FLAGS[sub].includes(name));
  if (unknown.length) return reply(2, { ok: false, error: `lane ${sub}: unknown flag ${unknown.map((name) => `--${kebab(name)} (${name})`).join(', ')}` });
  const current = state ?? loadState(runDir, deps);
  const wp = current.wps.find((candidate) => candidate.id === wpId);
  if (!wp) return reply(2, { ok: false, error: `no WP ${wpId} in this run` });
  if (sub === 'alive') {
    if (!Number.isInteger(wp.lane?.pid)) return reply(2, { ok: false, error: `${wpId} has no lane pid` });
    const alive = deps.pidAlive(wp.lane.pid);
    return reply(alive ? 0 : 1, { ok: true, alive, pid: wp.lane.pid });
  }
  if (sub === 'spawn') return spawnLane(current, wp, flags, deps);
  return checkLane(current, wp, flags, deps);
}

function spawnLane(state, wp, flags, deps) {
  const lane = laneLayout(state, wp);
  const brief = typeof flags.amend === 'string' ? flags.amend : wp.lane?.briefPath ?? lane.briefPath;
  if (flags.amend !== undefined && typeof flags.amend !== 'string') return reply(2, { ok: false, error: 'lane spawn --amend <brief> needs a path' });
  const cwd = wp.lane?.worktree ?? lane.worktree;
  const logPath = wp.lane?.logPath ?? lane.logPath;
  const sessionId = flags.amend === undefined ? null : wp.lane?.sessionId
    ?? lastJson(readLog(deps, logPath), state.intent.agent === 'claude' ? 'session_id' : 'thread_id')?.[state.intent.agent === 'claude' ? 'session_id' : 'thread_id'];
  if (flags.amend !== undefined && !sessionId) return reply(2, { ok: false, error: `${wp.id} has no session id to resume (none in ${logPath})` });
  let program = null;
  let pid = null;
  let why = null;
  // agentArgv throws when codex does not resolve (resolveProgram).
  try {
    const [first, ...args] = agentArgv(state, wp, { brief, sessionId }, deps);
    program = first;
    pid = deps.spawnDetached(program, args, { cwd, logPath, env: deps.env }).pid;
  } catch (error) {
    why = error.message;
  }
  // spawnDetached reports a failed spawn as pid null and swallows the error
  // event; the log says what is known.
  if (pid === null) {
    why ??= deps.exists(cwd) ? `${program} did not start (not found on PATH, or not executable)` : `the lane worktree ${cwd} does not exist`;
    try {
      deps.append(logPath, `conduct: lane spawn failed: ${why}\n`);
    } catch { /* the log path itself may be the problem; the reply names it */ }
    return reply(5, { ok: false, error: `lane spawn failed: ${why}`, logPath });
  }
  const startedAt = deps.timestamp();
  wp.lane = { ...wp.lane, pid, logPath, startedAt };
  appendEvent(state, deps, { step: flags.amend === undefined ? 'start' : 'prompt', event: 'spawned', data: { wpId: wp.id, pid, resumed: Boolean(sessionId) } });
  saveState(state, deps);
  return reply(0, { ok: true, pid, startedAt, logPath });
}

function checkLane(state, wp, flags, deps) {
  const lane = laneLayout(state, wp);
  const failures = [];
  const text = deps.exists(lane.reportPath) ? deps.read(lane.reportPath) : null;
  const { outcome, asks } = text === null ? { outcome: 'missing', asks: [] } : parseOutcome(text);
  const verdict = runtimeExerciseVerdict(text, wp);
  if (outcome !== 'built') {
    if (outcome === 'missing') failures.push(text === null ? `no report at ${lane.reportPath}` : 'the report has no ## Outcome (built | refuted | stopped: needs conductor)');
    return reply(failures.length ? 5 : 0, { ok: !failures.length, outcome, verdict, failures, asks });
  }
  if (!VERDICT_PASSES.has(verdict)) failures.push(`runtime exercise: ${verdict}`);
  if (!flags.runtimeOnly) {
    failures.push(...reportShapeProblems(text));
    const ahead = deps.exec('git', ['-C', wp.lane?.worktree ?? lane.worktree, 'rev-list', '--count', `${wp.lane?.base}..HEAD`]);
    if (ahead.code !== 0 || !(Number(ahead.stdout.trim()) >= 1)) failures.push(`the branch has no commit past base ${wp.lane?.base}: ${said(ahead)}`);
    if (flags.pr !== undefined) {
      if (!/^\d+$/.test(String(flags.pr))) return reply(2, { ok: false, error: `--pr needs a PR number, got ${flags.pr}` });
      const view = deps.exec('gh', ['pr', 'view', String(flags.pr), '--repo', state.intent.repo.remote, '--json', 'headRefName,state,body']);
      const pr = view.code === 0 ? parseStdout(view) : null;
      if (!pr) failures.push(`gh pr view ${flags.pr}: ${said(view)}`);
      else {
        if (pr.headRefName !== (wp.lane?.branch ?? lane.branch)) failures.push(`PR #${flags.pr} head is ${pr.headRefName}, not ${wp.lane?.branch ?? lane.branch}`);
        if (pr.state !== 'OPEN' && pr.state !== 'MERGED') failures.push(`PR #${flags.pr} is ${pr.state}`);
        failures.push(...reportShapeProblems(pr.body ?? '').map((problem) => `PR body: ${problem}`));
      }
    }
  }
  return reply(failures.length ? 5 : 0, { ok: !failures.length, outcome, verdict, failures, asks });
}
