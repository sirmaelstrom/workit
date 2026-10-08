// Lane backends. Each step of a lane (admit, create, start, prompt, wait,
// check, stop) is an array of actions for the agent to run; recordLaneStep
// turns each action's result into a routed outcome. Two backends: herdr
// drives scripts/lane.mjs through its CLI; exec is git worktree plus a
// detached headless agent, which `lane spawn` starts and records by pid.
//
// Contract for WP-04 (the recorder's result):
// - `patch.lane` merges into wps[].lane; `patch.queue` replaces the WP's
//   queued actions; every other patch key replaces that field.
// - `block`, `amend` and `done` always set `patch.queue`: `[]`, or only the
//   cleanup still owed (the lane's stop actions). WP-04 runs a WP's queued
//   cleanup whatever its state (blocked and refuted included); a cleanup
//   action's own record never changes the WP's state.
// - `done` carries cleanup only (a refuted lane's stop); it never carries work.
//   `admit` exit 7 is `done` with `state: 'pending'` and `notBefore`: WP-04
//   abandons that dispatch (the step array ends) and re-dispatches later.
// - A `block` carries `cause`: 'error' | 'dialog' (with `dialog`, the parsed
//   text) | 'needs-conductor' | 'deadline' | 'admission' | 'cleanup-unresolved'.
//   'cleanup-unresolved' keeps its stop queued and its slot held: WP-04
//   surfaces it, never finishes it silently.
// - Occupancy is not the orchestrator's live states: a lane holds its slot and
//   files until its exit is observed (`lane.exitedAt`), whatever the WP's
//   state. WP-04 stops a herdr lane when its WP is merged, held or refuted.
// - The build does not end while a pending WP waits on `notBefore`, or while
//   any WP holds a slot or a queued cleanup. WP-04 passes its injected clock:
//   `dispatchable(state, { now: deps.now() })`.
// - Each successful start, and each conductor amendment prompt, sets
//   `startedAt` and a fresh `deadline`, clears `exitedAt`, and resets the
//   dialog, capacity and start-retry counters. Automatic retries (capacity
//   re-send, dialog re-poll, refused start, plan-low fallback) renew nothing.
// - `lane.dialogPolls` counts consecutive dialogs (wait or start exit 3): any
//   other wait result resets it to 0; the second consecutive dialog blocks.
// - `lane.fallback: 'claude'` records that a codex lane now runs claude in its
//   pane (lane.mjs fallback replays the prompt); later herdr steps keep the
//   pane and lane name, and nothing else reads it in v1.
// - `lane.costComplete: false` marks a cost read from a lane that was killed or
//   whose pid was reused: a lower bound, not the lane's spend.
import { basename, dirname, join, resolve } from 'node:path';
import { LANE_MODELS, laneModel } from './adapters.mjs';
import { resolveProgram } from './exec.mjs';
import { ConductError, STEPS, STEP_SEAM, appendEvent, loadState, saveState } from './state.mjs';
import { GATED_FROM_LANE, LIVE_STATES, laneOccupied } from './schedule.mjs';
import { EXIT_CODES as LANE_EXIT, reapWorktree, reportShapeProblems } from '../../../../scripts/lane.mjs';

const DEADLINE_MS = 120 * 60 * 1000;
const POLL_MS = 60000;
const DIALOG_WAIT_MS = 60000;
const START_REARMS = 3;
const STOP_CONFIRMS = 3;
const STOP_WAIT_MS = 10000;
export const ADMIT_BACKOFF_MS = 5 * 60 * 1000;
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

// A process's identity: its creation time and image name, so a reused pid is
// never mistaken for the lane's agent.
const PS = (script) => ['powershell', '-NoProfile', '-NonInteractive', '-Command', script];
const psIdentity = (pid) => `$p = Get-CimInstance Win32_Process -Filter ProcessId=${Number(pid)}; $id = if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + ' ' + $p.Name } else { '' }`;
const SH_IDENTITY = 'id=$(echo $(ps -o lstart=,comm= -p "$1"))';

export function identityArgv(pid, platform) {
  return platform === 'win32' ? PS(`${psIdentity(pid)}; Write-Output $id`) : ['sh', '-c', `${SH_IDENTITY}; echo "$id"`, 'sh', String(pid)];
}

export function readIdentity(pid, deps) {
  const [program, ...args] = identityArgv(pid, deps.platform ?? process.platform);
  const result = deps.exec(program, args);
  const id = result.code === 0 ? String(result.stdout).trim().replace(/\s+/g, ' ') : '';
  return id || null;
}

// Terminate the lane's agent and its children, only when the pid still has
// the identity recorded at spawn; otherwise print why and exit 3. The check
// and the kill run in one executor process. ASSUMPTION: the residual window
// is that process's gap between its identity query and the kill (one
// executor round trip, under a second here). ASSUMPTION off win32: the agent
// leads its own process group (spawnDetached's detached: true).
export function guardedKillArgv(pid, identity, platform) {
  const refuse = `pid ${pid} is not the lane agent: not killed`;
  if (platform === 'win32') {
    // Every literal is single-quoted with its quotes doubled: PowerShell's rule.
    const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
    return PS(`${psIdentity(pid)}; if ($id -and $id -eq ${quote(identity)}) { taskkill /PID ${Number(pid)} /T /F; exit $LASTEXITCODE } else { Write-Output ${quote(refuse)}; exit 3 }`);
  }
  return ['sh', '-c', `${SH_IDENTITY}; if [ -n "$id" ] && [ "$id" = "$2" ]; then kill -TERM -- "-$1"; else echo "${refuse}"; exit 3; fi`, 'sh', String(pid), identity];
}

export function laneBackend(state, deps, backend) {
  const repo = resolve(state.intent.repo.path);
  const fallbackBranch = state.intent.repo.defaultBranch ?? 'main';
  // A recorder's deps are { exec, read, now }; it re-arms steps from the run's root.
  const pluginRoot = deps.pluginRoot ?? state.pluginRoot;
  const conduct = (sub, wp, extra = []) => ['node', join(pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs'), 'lane', sub, '--run', state.runDir, '--wp', wp.id, ...extra];
  const prLookup = (wp) => shellAction('pr-lookup', {
    instruction: 'List the lane branch\'s PRs and record the JSON.', expects: { type: 'json' },
    command: ['gh', 'pr', 'list', '--repo', state.intent.repo.remote, '--head', laneLayout(state, wp).branch, '--state', 'all', '--json', 'number,headRefOid,state'],
  });
  const base = () => [
    shellAction('create', { part: 'fetch', instruction: 'Fetch origin.', command: ['git', '-C', repo, 'fetch', 'origin'] }),
    shellAction('base', { instruction: 'Resolve the base sha.', command: ['git', '-C', repo, 'rev-parse', `origin/${fallbackBranch}`] }),
  ];
  const confirmAction = (wp) => shellAction('stop', { part: 'confirm', instruction: 'Confirm the lane agent exited.', command: conduct('alive', wp) });
  // Outcome first (D19.16): the report check precedes every other check.
  const reportCheck = (wp, extra) => shellAction('check', { part: 'report', instruction: 'Check the report\'s outcome and runtime exercise.', command: conduct('check', wp, extra) });
  const laneMjs = (verb, args, log) => ['node', join(pluginRoot, 'scripts', 'lane.mjs'), verb, ...args, '--log', log];
  const admitAction = (args = []) => shellAction('admit', { instruction: 'Ask lane.mjs whether a lane may start.', command: laneMjs('admit', args, join(state.runDir, 'lane-runner.jsonl')) });
  const worktreeOf = (wp) => wp.lane?.worktree ?? laneLayout(state, wp).worktree;
  // What an exec lane left running in its worktree (a runtime exercise's dev
  // server) does not end with the agent; herdr's `lane.mjs stop` reaps its own.
  const execReap = (wp) => [shellAction('stop', { part: 'reap', instruction: 'Kill what the lane left running in its worktree.', command: conduct('reap', wp) })];
  if (backend === 'herdr') {
    return {
      name: 'herdr',
      admit: () => [admitAction()],
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
      // quotes the answer (rulingCarried: 'brief'). `resend` marks the
      // automatic capacity re-send, which renews nothing.
      prompt: (wp, { amendment = false, answer = null, resend = false } = {}) => {
        const lane = laneLayout(state, wp);
        const args = [lane.name, '--file', wp.lane.briefPath];
        const byReceipt = Boolean(answer?.receiptId && deps.env?.WORKIT_RECEIPT_RESOLVER);
        if (amendment) args.push('--amendment', ...(byReceipt ? ['--ruling-receipt', answer.receiptId, '--quest', state.intent.anchor] : ['--no-ruling']));
        return [shellAction('prompt', {
          instruction: 'Send the lane its brief.', command: laneMjs('prompt', args, lane.runnerLog), ...(resend ? { part: 'resend' } : {}),
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
          { ...reportCheck(wp, ['--runtime-only']), seam: 'runtime-exercise' },
          shellAction('check', { part: 'shape', instruction: 'Check the report\'s shape.', command: laneMjs('check', [lane.name, '--expect-report', lane.reportPath], lane.runnerLog) }),
          prLookup(wp),
          shellAction('check', { part: 'pr', instruction: 'Check the PR.', command: laneMjs('check', [lane.name, '--expect-pr', '{pr.number}'], lane.runnerLog) }),
        ];
      },
      stop: (wp) => (wp.lane?.exitedAt ? [] : [shellAction('stop', {
        part: 'stop', instruction: 'Stop the lane agent.', command: laneMjs('stop', [laneLayout(state, wp).name], laneLayout(state, wp).runnerLog),
      })]),
    };
  }
  return {
    name: 'exec',
    // A 3rd or 4th live lane is admitted on measured free commit memory: room is
    // the gate's whole point, so a host that cannot measure it does not get one.
    admit: (wp) => (state.wps.filter((other) => other !== wp && (LIVE_STATES.includes(other.state) || laneOccupied(other))).length >= GATED_FROM_LANE - 1 ? [admitAction(['--require-reading'])] : []),
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
      reportCheck(wp, []),
      prLookup(wp),
      shellAction('check', { part: 'pr', instruction: 'Check the PR.', command: conduct('check', wp, ['--pr', '{pr.number}']) }),
    ],
    // First probe the pid's identity (`alive`); only a match queues the kill
    // (itself guarded by the same identity) and its confirmation. A mismatch,
    // or no identity, kills nothing and records the lane as exited. Only a
    // confirmation (alive exit 1) releases the slot. A lane already exited
    // gets the reap alone.
    stop: (wp) => (!Number.isInteger(wp.lane?.pid) ? [] : wp.lane?.exitedAt ? execReap(wp)
      : [shellAction('stop', { part: 'probe', instruction: 'Check the pid is still the lane agent.', command: conduct('alive', wp) })]),
    reap: (wp) => execReap(wp),
    // A merged WP's worktree is removed; git refuses a dirty tree (no --force),
    // and the refusal is recorded on the lane, never a block.
    remove: (wp) => [shellAction('stop', {
      part: 'remove', instruction: 'Remove the merged lane\'s worktree (no --force).', command: ['git', '-C', repo, 'worktree', 'remove', worktreeOf(wp)],
    })],
    kill: (wp) => [
      shellAction('stop', {
        part: 'kill', instruction: 'Terminate the lane agent if the pid is still its own.', command: guardedKillArgv(wp.lane.pid, wp.lane.identity, deps.platform ?? process.platform),
      }),
      confirmAction(wp),
    ],
  };
}

// Every line, with fenced lines marked. A fence closes only on the character
// that opened it, at least as long, with nothing after it (CommonMark).
function markLines(text) {
  let fence = null;
  return String(text ?? '').split(/\r?\n/).map((raw) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    let fenced = fence !== null;
    if (marker && fence === null) {
      fence = marker[1];
      fenced = true;
    } else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') {
      fence = null;
      fenced = true;
    }
    return { text: raw.replace(/\s+$/, ''), fenced };
  });
}

// The unfenced lines of the level-2 section `title`, or null.
function reportSection(text, title) {
  const lines = markLines(text);
  const start = lines.findIndex((line) => !line.fenced && (line.text === `## ${title}` || line.text.startsWith(`## ${title}:`)));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && !line.fenced && /^#{1,2}\s/.test(line.text));
  return { heading: lines[start].text, lines: lines.slice(start + 1, end < 0 ? lines.length : end).filter((line) => !line.fenced) };
}

// D19.23: only two anchored markers are read; prose never is. `problem`
// names what a failing report lacks.
function readRuntimeExercise(reportText, wp) {
  const section = reportSection(reportText, 'Runtime exercise');
  if (!section) return { verdict: 'missing', problem: 'no "## Runtime exercise" heading' };
  const verdicts = section.lines.map((line) => VERDICT.exec(line.text)).filter(Boolean).map((match) => match[1]);
  const verdict = verdicts[0];
  if (verdicts.length > 1) return { verdict: 'vacuous', problem: `${verdicts.length} Verdict lines (${verdicts.map((value) => `"Verdict: ${value}"`).join(', ')}); write exactly one` };
  if (!verdict) return { verdict: 'missing', problem: 'no line reading exactly "Verdict: exercised", "Verdict: vacuous", "Verdict: not exercised" or "Verdict: no runtime surface"' };
  if (/^none\b/i.test(String(wp?.runtimeExercise ?? '').trim())) return { verdict: 'no-surface', problem: null };
  if (verdict === 'not exercised' || verdict === 'no runtime surface') return { verdict: 'not-exercised', problem: `"Verdict: ${verdict}", but the WP names a runtime surface` };
  if (verdict === 'vacuous') return { verdict: 'vacuous', problem: '"Verdict: vacuous"' };
  return section.lines.some((line) => /^Would have shown:\s*\S/.test(line.text))
    ? { verdict: 'exercised', problem: null }
    : { verdict: 'vacuous', problem: '"Verdict: exercised" with no "Would have shown: <what a broken change shows>" line' };
}

export function runtimeExerciseVerdict(reportText, wp) {
  return readRuntimeExercise(reportText, wp).verdict;
}

// D19.16, D20: `## Outcome` + first body line, or `## Outcome: <value>`.
export function parseOutcome(reportText) {
  const section = reportSection(reportText, 'Outcome');
  if (!section) return { outcome: 'missing', asks: [] };
  const raw = section.heading.startsWith('## Outcome:') ? section.heading.slice('## Outcome:'.length) : section.lines.find((line) => line.text.trim())?.text ?? '';
  const value = raw.replace(/[*_`]/g, '').trim().toLowerCase();
  const outcome = /^built\b/.test(value) ? 'built' : /^refuted\b/.test(value) ? 'refuted' : /^stopped:\s*needs conductor\b/.test(value) ? 'needs-conductor' : 'missing';
  const lettered = (reportSection(reportText, 'Needs conductor')?.lines ?? []).map((line) => line.text.trim()).filter(Boolean)
    .map((text) => ({ match: /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\(([a-f])\)/.exec(text), text }));
  // A lettered question followed by option (a) is the ask's own label, not an
  // option. Every option carries the question it answers (the label, or the
  // last unlettered line asking one), so two questions stay two asks.
  const label = (entry, i) => entry.text.includes('?') && lettered[i + 1]?.match?.[1] === 'a';
  const asks = [];
  let question = null;
  lettered.forEach((entry, i) => {
    if (!entry.match || label(entry, i)) {
      if (entry.text.includes('?')) question = entry.text;
      return;
    }
    asks.push({ key: entry.match[1], text: entry.text, question });
  });
  return { outcome, asks };
}

// The `### PR…` subsection of the report's latest `## Amendment N`, or null.
function amendmentPrSection(text) {
  const lines = markLines(text);
  const starts = lines.flatMap((line, i) => (!line.fenced && /^## Amendment \d+\b/.test(line.text) ? [i] : []));
  if (!starts.length) return null;
  const end = lines.findIndex((line, i) => i > starts.at(-1) && !line.fenced && /^#{1,2}\s/.test(line.text));
  const section = lines.slice(starts.at(-1) + 1, end < 0 ? lines.length : end);
  const start = section.findIndex((line) => !line.fenced && /^###\s+PR\b/.test(line.text));
  if (start < 0) return null;
  const stop = section.findIndex((line, i) => i > start && !line.fenced && /^#{1,3}\s/.test(line.text));
  return { lines: section.slice(start + 1, stop < 0 ? section.length : stop).filter((line) => !line.fenced) };
}

// The report's PR claim: a number and a head sha (7–40 hex), or nulls. The
// latest amendment's `### PR` subsection, when it has one, is the newer claim;
// otherwise the top-level `## PR`.
function reportPr(text) {
  const amended = amendmentPrSection(text);
  const body = ((amended ?? reportSection(text, 'PR'))?.lines ?? []).map((line) => line.text).join('\n');
  return { from: amended ? 'latest amendment\'s ### PR' : '## PR', number: Number(/#?(\d+)\b/.exec(body)?.[1] ?? NaN) || null, head: /\b([0-9a-f]{7,40})\b/.exec(body)?.[1] ?? null };
}

// The JSON objects in a lane log (stdout and stderr share the file).
function logObjects(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const lastWith = (text, key) => logObjects(text).filter((value) => value[key] !== undefined).at(-1) ?? null;

// A claude session's total_cost_usd is cumulative across `--resume`
// invocations (measured: a resumed haiku session reported the first run's
// cost plus its own). So the lane's cost is each session's latest total,
// summed over sessions; null when the log holds no result.
export function laneCost(logText) {
  const latest = new Map();
  for (const value of logObjects(logText)) {
    if (typeof value.session_id === 'string' && typeof value.total_cost_usd === 'number') latest.set(value.session_id, value.total_cost_usd);
  }
  return latest.size ? [...latest.values()].reduce((sum, cost) => sum + cost, 0) : null;
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

// A failure's words for a brief or an ask: stderr without lane.mjs's routine
// `lane: log …` banner, then stdout's structured field (`error`,
// `failedExpectation`, lane check's `failures`) or stdout itself.
function said(result) {
  const out = parseStdout(result);
  const detail = out?.error ?? out?.failedExpectation ?? (Array.isArray(out?.failures) ? out.failures.join('; ') : null) ?? String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('lane: log ')).join(' ').trim();
  return [stderr, typeof detail === 'string' ? detail : JSON.stringify(detail)].filter(Boolean).join(' | ') || `exit ${result.code}`;
}

const proceed = (patch = {}, reason = null) => ({ outcome: 'continue', reason, patch });
const block = (reason, patch = {}, cause = 'error', extra = {}) => ({ outcome: 'block', reason, cause, ...extra, patch: { queue: [], ...patch } });
const amend = (reason, patch = {}) => ({ outcome: 'amend', reason, patch: { queue: [], ...patch } });
const done = (reason, patch = {}) => ({ outcome: 'done', reason, patch: { queue: [], ...patch } });
const iso = (ms) => new Date(ms).toISOString();

// A successful start or conductor amendment: a fresh deadline, the exit
// marker cleared, every retry counter reset.
function freshStart(deps, startedAt = null) {
  const at = startedAt ? Date.parse(startedAt) : deps.now();
  return { startedAt: iso(at), deadline: iso(at + DEADLINE_MS), exitedAt: null, dialogPolls: 0, capacityResent: false, startRearms: 0, stopConfirms: 0 };
}

// A dialog (wait or start exit 3) gets one re-poll after 60 s (it may clear
// itself); a second consecutive one blocks. The conductor never answers it.
function dialogRoute(wp, result, retry) {
  const dialog = String(parseStdout(result)?.dialog ?? said(result));
  const polls = (wp.lane?.dialogPolls ?? 0) + 1;
  if (polls > 1) return block(`dialog: ${dialog}`, { lane: { dialogPolls: polls } }, 'dialog', { dialog });
  return { outcome: 'wait', reason: `dialog: ${dialog}`, cause: 'dialog', dialog, patch: { lane: { dialogPolls: polls }, queue: [waitAction(DIALOG_WAIT_MS), ...retry] } };
}

const expired = (wp, deps) => Boolean(wp.lane?.deadline) && deps.now() > Date.parse(wp.lane.deadline);
// Past the deadline: stop the lane, then block. The stop is owed cleanup.
const deadlineBlock = (wp, backend) => block('lane deadline', { queue: backend.stop(wp) }, 'deadline');

// D19.15, D20: one result interface (the contract is in the header).
export function recordLaneStep(state, wp, action, result, deps) {
  if (action.kind === 'wait') return proceed();
  const lane = laneLayout(state, wp);
  const backend = laneBackend(state, deps, wp.lane?.backend ?? 'exec');
  const ok = result.code === 0;
  switch (action.step) {
    case 'admit':
      if (result.code === LANE_EXIT.admitRefused) {
        const notBefore = iso(deps.now() + ADMIT_BACKOFF_MS);
        return done(`admission refused (${said(result)}); not dispatched before ${notBefore}`, { state: 'pending', notBefore });
      }
      return ok ? proceed({ notBefore: null }) : block(said(result));
    case 'base': {
      const sha = String(result.stdout ?? '').trim();
      return ok && SHA.test(sha) ? proceed({ lane: { base: sha } }) : block(`base sha: ${said(result)}`);
    }
    case 'create': {
      if (!ok) return block(said(result));
      if (action.part === 'fetch') return proceed();
      if (action.part === 'lane') {
        const created = parseStdout(result);
        if (!created?.paneId || !created?.path) return block(`lane.mjs create printed no paneId/path: ${said(result)}`);
        return proceed({ lane: { name: lane.name, paneId: created.paneId, worktree: created.path, branch: created.branch ?? lane.branch, briefPath: lane.briefPath } });
      }
      return proceed({ lane: { name: lane.name, worktree: lane.worktree, branch: lane.branch, briefPath: lane.briefPath, logPath: lane.logPath } });
    }
    case 'start': {
      // A start refused for memory re-arms start, never create (lane.mjs
      // refuses a create once the branch or worktree path exists), at most
      // START_REARMS times; nothing runs, so the block holds no slot.
      if (result.code === LANE_EXIT.admitRefused) {
        const rearms = (wp.lane?.startRearms ?? 0) + 1;
        if (rearms > START_REARMS) return block(`start refused ${rearms} times: ${said(result)}`, { lane: { startRearms: rearms } }, 'admission');
        return { outcome: 'wait', reason: `start refused: ${said(result)}`, patch: { lane: { startRearms: rearms }, queue: [waitAction(POLL_MS), ...backend.start(wp)] } };
      }
      if (result.code === LANE_EXIT.blocked) return dialogRoute(wp, result, backend.wait(wp));
      return ok ? proceed({ lane: freshStart(deps, parseStdout(result)?.startedAt) }) : block(said(result));
    }
    case 'prompt':
      if (!ok) return block(said(result));
      // Only a conductor amendment renews the deadline and the counters.
      if (action.part === 'resend') return proceed();
      return proceed({ lane: freshStart(deps, parseStdout(result)?.startedAt) });
    case 'fallback':
      return ok ? proceed({ lane: { fallback: 'claude' } }) : block(said(result));
    case 'wait':
      return wp.lane?.backend === 'herdr' ? recordHerdrWait(state, wp, result, deps, backend) : recordExecWait(state, wp, result, deps, backend);
    case 'check':
      return recordCheck(wp, action, result, backend);
    case 'pr-lookup':
      return recordPrLookup(wp, lane, result, deps);
    case 'stop':
      return recordStop(state, wp, action, result, deps);
    default:
      throw new ConductError(2, `recordLaneStep has no route for step ${action.step}`);
  }
}

function recordHerdrWait(state, wp, result, deps, backend) {
  if (result.code === LANE_EXIT.ok) return proceed({ lane: { dialogPolls: 0 } });
  if (result.code === LANE_EXIT.error || result.code === LANE_EXIT.usage) return block(said(result));
  // Every route below recovers; an expired deadline comes first.
  if (expired(wp, deps)) return deadlineBlock(wp, backend);
  switch (result.code) {
    case LANE_EXIT.timeout:
      return { outcome: 'wait', reason: 'lane running', patch: { lane: { dialogPolls: 0 }, queue: [waitAction(0), ...backend.wait(wp)] } };
    case LANE_EXIT.blocked:
      return dialogRoute(wp, result, backend.wait(wp));
    case LANE_EXIT.planLow: {
      const fallback = shellAction('fallback', {
        instruction: 'Hand the lane to claude.',
        command: ['node', join(deps.pluginRoot ?? state.pluginRoot, 'scripts', 'lane.mjs'), 'fallback', laneLayout(state, wp).name, '--to', 'claude',
          '--model', LANE_MODELS.claude.opus, '--reasoning', 'high', '--log', laneLayout(state, wp).runnerLog],
      });
      return proceed({ queue: [fallback, ...backend.wait(wp)] }, 'plan low: falling back to claude');
    }
    case LANE_EXIT.capacity:
      if (wp.lane?.capacityResent) return block(`capacity again after the one re-send: ${said(result)}`);
      return proceed({ lane: { capacityResent: true }, queue: [...backend.prompt(wp, { amendment: true, resend: true }), ...backend.wait(wp)] }, 'capacity: re-sending the brief once');
    default:
      return block(said(result));
  }
}

function recordExecWait(state, wp, result, deps, backend) {
  if (result.code === 0) {
    if (expired(wp, deps)) return deadlineBlock(wp, backend);
    return { outcome: 'wait', reason: 'lane running', patch: { queue: [waitAction(POLL_MS), ...backend.wait(wp)] } };
  }
  if (result.code !== 1) return block(said(result));
  // Each observed exit reaps: a lane's dev server must not outlive its turn.
  return proceed({ lane: exitedLane(state, wp, deps, parseStdout(result)?.owner === 'gone'), queue: [...backend.reap(wp), ...(wp.queue ?? []).slice(1)] });
}

// The lane's exit is observed. The exec log holds its session id and, for
// claude, its cost: complete only when the agent ended on its own (not killed,
// pid not reused); a log with no result keeps the known cost.
function exitedLane(state, wp, deps, natural) {
  const lane = { exitedAt: iso(deps.now()), stopConfirms: 0 };
  if (wp.lane?.backend === 'herdr') return lane;
  const log = readLog(deps, wp.lane?.logPath ?? laneLayout(state, wp).logPath);
  const claude = state.intent.agent === 'claude';
  const last = lastWith(log, claude ? 'session_id' : 'thread_id');
  lane.sessionId = (claude ? last?.session_id : last?.thread_id) ?? wp.lane?.sessionId ?? null;
  if (!claude) return lane;
  const cost = laneCost(log);
  if (cost !== null) lane.costUsd = cost;
  lane.costComplete = natural && cost !== null;
  return lane;
}

// A stop is confirmed by `alive` exit 1 (exec) or a clean `lane.mjs stop`,
// whose `exited-shell-blocked` also means the agent is gone (herdr). An
// unconfirmed stop is re-confirmed after 10 s, up to STOP_CONFIRMS times;
// then it blocks as 'cleanup-unresolved' with its stop still queued.
function recordStop(state, wp, action, result, deps) {
  if (action.part === 'kill') return proceed(); // exit 3 (not our pid) or a gone pid: the confirmation decides
  const out = parseStdout(result);
  // Cleanup after the agent is gone. A survivor or a worktree git will not
  // remove is recorded on the lane for the analysis; neither blocks the run.
  if (action.part === 'reap') {
    return proceed({ lane: { reap: { state: out?.state ?? 'unreadable', orphans: out?.orphans?.length ?? 0, survivors: out?.survivors?.length ?? 0, ...(result.code === 0 ? {} : { error: said(result) }) } } });
  }
  if (action.part === 'remove') return proceed({ lane: { removed: result.code === 0, ...(result.code === 0 ? {} : { removeError: said(result) }) } });
  // The actions queued after this stop (a reap, a worktree removal, a ratify
  // or cite ruling) outlive it: every queue below keeps them.
  const rest = (wp.queue ?? []).slice(1);
  const backend = laneBackend(state, deps, wp.lane?.backend ?? 'exec');
  if (action.part === 'probe' && result.code === 0) return proceed({ queue: [...laneBackend(state, deps, 'exec').kill(wp), ...rest] }, `pid ${wp.lane?.pid} is the lane agent: killing it`);
  const gone = action.part === 'stop' ? result.code === 0 || out?.state === 'exited-shell-blocked' : result.code === 1;
  if (gone) {
    return done(`lane stopped${out?.owner && out.owner !== 'gone' ? ` (pid ${out.owner}: not killed)` : ''}`,
      { lane: exitedLane(state, wp, deps, false), queue: [...(backend.reap ? backend.reap(wp) : []), ...rest] });
  }
  const confirms = (wp.lane?.stopConfirms ?? 0) + 1;
  const why = action.part !== 'stop' && result.code === 0 ? `lane agent pid ${wp.lane?.pid} still runs after stop` : `stop: ${said(result)}`;
  if (confirms >= STOP_CONFIRMS) {
    return block(`cleanup unresolved after ${confirms} confirmations: ${why}`, { lane: { stopConfirms: confirms }, queue: [...backend.stop(wp), ...rest] }, 'cleanup-unresolved');
  }
  return { outcome: 'wait', reason: why, patch: { lane: { stopConfirms: confirms }, queue: [waitAction(STOP_WAIT_MS), action, ...rest] } };
}

function recordCheck(wp, action, result, backend) {
  if (action.part === 'report') {
    const checked = parseStdout(result);
    if (!checked) return block(`lane check printed no JSON: ${said(result)}`);
    // Provenance: the analysis reads who recorded the verdict (next or --manual)
    // from this action's `recorded` event.
    // A built report can still carry `## Needs conductor` asks: the build rules on them before review.
    const patch = { runtimeVerdict: checked.verdict ?? null, runtimeVerdictBy: { actionId: action.id ?? null }, asks: checked.asks ?? [] };
    // Outcome first (D19.16): nothing after the report check runs unless built.
    if (checked.outcome === 'refuted') return done('refuted', { ...patch, state: 'refuted', queue: backend.stop(wp) });
    if (checked.outcome === 'needs-conductor') return block('needs conductor', { ...patch, asks: checked.asks ?? [] }, 'needs-conductor');
    if (checked.outcome === 'missing') return amend(`report: ${(checked.failures ?? []).join('; ') || '## Outcome missing'}`, patch);
    if (result.code === 5) return amend((checked.failures ?? []).join('; '), patch);
    return result.code === 0 ? proceed(patch) : block(said(result), patch);
  }
  if (result.code === 0) return proceed();
  if (result.code === 5) return amend(`${action.part} check: ${said(result)}`);
  return block(said(result));
}

function recordPrLookup(wp, lane, result, deps) {
  if (result.code !== 0) return block(`gh pr list: ${said(result)}`);
  const prs = parseStdout(result);
  if (!Array.isArray(prs)) return block(`gh pr list printed no JSON array: ${said(result)}`);
  const branch = wp.lane?.branch ?? lane.branch;
  // Every later action carries {pr.number}: with no PR they are dropped.
  if (prs.length === 0) return amend(`no PR for ${branch}`);
  const pr = prs.find((candidate) => candidate.state === 'OPEN') ?? prs[0];
  const found = { number: pr.number, head: pr.headRefOid };
  const claimed = reportPr(readLog(deps, lane.reportPath));
  if (claimed.number !== found.number || !claimed.head || !found.head?.startsWith(claimed.head)) {
    return amend(`the report's ${claimed.from} says #${claimed.number ?? '?'} at ${claimed.head ?? '?'}; GitHub has #${found.number} at ${found.head}`, { pr: found });
  }
  return proceed({ pr: found });
}

const SUB_FLAGS = { spawn: ['amend'], alive: [], check: ['pr', 'runtimeOnly'], reap: [] };
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
    const owner = laneOwner(wp, deps);
    return reply(owner === 'running' ? 0 : 1, { ok: true, alive: owner === 'running', pid: wp.lane.pid, owner });
  }
  if (sub === 'spawn') return spawnLane(current, wp, flags, deps);
  if (sub === 'reap') {
    // lane.mjs's reap, in process: the core path runs no lane.mjs argv.
    const reaped = reapWorktree(wp.lane?.worktree ?? laneLayout(current, wp).worktree, { ...deps, platform: deps.platform ?? process.platform });
    const rows = (list) => list.map((row) => ({ pid: row.pid, cmd: row.cmd.length > 200 ? `${row.cmd.slice(0, 197)}...` : row.cmd }));
    const stateName = reaped.error ? 'reap-failed' : reaped.survivors.length ? 'survivors' : 'reaped';
    return reply(stateName === 'reaped' ? 0 : 1, { ok: stateName === 'reaped', state: stateName, orphans: rows(reaped.found), survivors: rows(reaped.survivors), ...(reaped.error ? { error: reaped.error } : {}) });
  }
  return checkLane(current, wp, flags, deps);
}

// Who holds the lane's pid: 'running' (the agent, by its recorded identity),
// 'gone', 'reused' (another process), or 'unverified' (no identity to compare).
// Only 'running' counts as the lane still running.
function laneOwner(wp, deps) {
  if (!deps.pidAlive(wp.lane.pid)) return 'gone';
  const now = wp.lane.identity ? readIdentity(wp.lane.pid, deps) : null;
  if (!now) return 'unverified';
  return now === wp.lane.identity ? 'running' : 'reused';
}

// One lane process per WP. The pending action is the replay key: running the
// same spawn action again returns its saved result and spawns nothing. Any
// other spawn while the recorded pid runs (its exit unobserved) is refused.
function spawnLane(state, wp, flags, deps) {
  const lane = laneLayout(state, wp);
  if (flags.amend !== undefined && typeof flags.amend !== 'string') return reply(2, { ok: false, error: 'lane spawn --amend <brief> needs a path' });
  const pending = state.pending;
  const actionId = pending?.command?.includes('spawn') && pending.command.includes(wp.id) ? pending.id : null;
  const saved = wp.lane?.spawn;
  if (actionId && saved?.actionId === actionId) return reply(0, { ok: true, pid: saved.pid, startedAt: saved.startedAt, logPath: saved.logPath, replayed: true });
  if (Number.isInteger(wp.lane?.pid) && !wp.lane?.exitedAt && laneOwner(wp, deps) === 'running') {
    return reply(5, { ok: false, error: `lane spawn refused: ${wp.id}'s agent pid ${wp.lane.pid} is still running; stop it first` });
  }
  const brief = typeof flags.amend === 'string' ? flags.amend : wp.lane?.briefPath ?? lane.briefPath;
  const cwd = wp.lane?.worktree ?? lane.worktree;
  const logPath = wp.lane?.logPath ?? lane.logPath;
  const idKey = state.intent.agent === 'claude' ? 'session_id' : 'thread_id';
  const sessionId = flags.amend === undefined ? null : wp.lane?.sessionId ?? lastWith(readLog(deps, logPath), idKey)?.[idKey];
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
  // The identity every later alive and stop compares against (null: unreadable,
  // so the lane is never killed and reads as exited).
  const identity = readIdentity(pid, deps);
  wp.lane = { ...wp.lane, pid, identity, logPath, startedAt, exitedAt: null, spawn: { actionId, pid, startedAt, logPath } };
  appendEvent(state, deps, { step: flags.amend === undefined ? 'start' : 'prompt', event: 'spawned', data: { wpId: wp.id, pid, resumed: Boolean(sessionId) } });
  saveState(state, deps);
  return reply(0, { ok: true, pid, startedAt, logPath });
}

function checkLane(state, wp, flags, deps) {
  const lane = laneLayout(state, wp);
  const failures = [];
  const text = deps.exists(lane.reportPath) ? deps.read(lane.reportPath) : null;
  const { outcome, asks } = text === null ? { outcome: 'missing', asks: [] } : parseOutcome(text);
  const { verdict, problem } = readRuntimeExercise(text, wp);
  // Outcome first: only a built report gets the shape and runtime checks.
  if (outcome !== 'built') {
    if (outcome === 'missing') failures.push(text === null ? `no report at ${lane.reportPath}` : 'the report has no ## Outcome (built | refuted | stopped: needs conductor)');
    return reply(failures.length ? 5 : 0, { ok: !failures.length, outcome, verdict, failures, asks });
  }
  if (problem) failures.push(`runtime exercise ${verdict}: ${problem}`);
  if (!flags.runtimeOnly) {
    failures.push(...reportShapeProblems(text));
    const ahead = deps.exec('git', ['-C', wp.lane?.worktree ?? lane.worktree, 'rev-list', '--count', `${wp.lane?.base}..HEAD`]);
    if (ahead.code !== 0 || !(Number(ahead.stdout.trim()) >= 1)) failures.push(`the branch has no commit past base ${wp.lane?.base} (${ahead.code === 0 ? `${ahead.stdout.trim()} commits` : said(ahead)})`);
    if (flags.pr !== undefined) {
      if (!/^\d+$/.test(String(flags.pr))) return reply(2, { ok: false, error: `--pr needs a PR number, got ${flags.pr}` });
      const view = deps.exec('gh', ['pr', 'view', String(flags.pr), '--repo', state.intent.repo.remote, '--json', 'headRefName,state,body']);
      const pr = view.code === 0 ? parseStdout(view) : null;
      if (!pr) failures.push(`gh pr view ${flags.pr}: ${said(view)}`);
      else {
        if (pr.headRefName !== (wp.lane?.branch ?? lane.branch)) failures.push(`PR #${flags.pr} head is ${pr.headRefName}, not ${wp.lane?.branch ?? lane.branch}`);
        if (pr.state !== 'OPEN' && pr.state !== 'MERGED') failures.push(`PR #${flags.pr} is ${pr.state}`);
        failures.push(...reportShapeProblems(pr.body ?? '').map((p) => `PR body: ${p}`));
      }
    }
  }
  return reply(failures.length ? 5 : 0, { ok: !failures.length, outcome, verdict, failures, asks });
}
