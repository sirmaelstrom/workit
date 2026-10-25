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
import { LANE_MODELS, laneModel, t3ModelSelection } from './adapters.mjs';
import { resolveProgram, shellArgv } from './exec.mjs';
import { pinnedConfig } from './repo-config.mjs';
import { amendmentSections, markLines } from './markdown.mjs';
import { ConductError, STEPS, STEP_SEAM, appendEvent, laneBase, loadState, saveState } from './state.mjs';
import { GATED_FROM_LANE, LIVE_STATES, holdsSlot, laneOccupied } from './schedule.mjs';
import { conductorNumber } from './rotate.mjs';
import { conductScript } from './touch.mjs';
import { EXIT_CODES as LANE_EXIT, LANE_MARKER_ENV, mergeDanger, reapWorktree, reportEvidenceProblems, reportShapeProblems, stopHookSettings } from '../../../../scripts/lane.mjs';

const DEADLINE_MS = 120 * 60 * 1000;
const POLL_MS = 60000;
const DIALOG_WAIT_MS = 60000;
const START_REARMS = 3;
const STOP_CONFIRMS = 3;
const STOP_WAIT_MS = 10000;
// One t3_thread_wait: it returns as soon as the lane's run ends, so a longer
// timeout costs nothing but the conductor's other WPs' turn.
const T3_WAIT_MS = 120000;
const T3_RUNNING = new Set(['preparing','queued', 'starting', 'running', 'waiting']);
const T3_ENDED = new Set(['completed', 'idle']);
// The run's heartbeat: a schedule_task bound to the conductor's thread, which
// starts a conductor turn this often while lanes run (deadlines, stalls, a
// lane that ends without its done message).
export const T3_HEARTBEAT_MS = 10 * 60 * 1000;
export const ADMIT_BACKOFF_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const VERDICT = /^Verdict: (exercised|vacuous|not exercised|no runtime surface)$/;
// The in-lane stop-check: how many of its own failures a claude lane is sent
// back to repair before the hook lets it stop, per session and amendment round;
// and how long a stop with a live background task holds a herdr wait.
export const STOP_CHECK_BLOCKS = 3;
const BACKGROUND_HOLD_MS = 15 * 60 * 1000;

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
    stopCheckPath: join(state.runDir, `lane-${lower}-stopcheck.json`),
  };
}

// The command a claude lane's Stop hook runs: stop-check.mjs, for this run and WP.
// Forward slashes, and quotes only around a path with a space: the command
// rides a JSON argv through herdr and a hook shell.
export function stopHookCommand(state, wp, deps) {
  const arg = (path) => {
    const forward = String(path).replace(/\\/g, '/');
    return /\s/.test(forward) ? `"${forward}"` : forward;
  };
  const script = join(deps.pluginRoot ?? state.pluginRoot, 'skills', 'conduct', 'scripts', 'stop-check.mjs');
  return ['node', arg(script), '--run', arg(state.runDir), '--wp', wp.id].join(' ');
}

function shellAction(step, fields) {
  if (!STEPS.includes(step)) throw new ConductError(2, `lane action step ${step} is not in STEPS`);
  return { kind: 'shell', step, seam: STEP_SEAM[step], expects: { type: 'none' }, ...fields };
}

const waitAction = (waitMs) => ({ kind: 'wait', step: 'wait', seam: STEP_SEAM.wait, waitMs, instruction: `Wait ${waitMs / 1000} s, then record {}.` });

// herdr when the adapter is on and the lane path lane.mjs create derives
// (<repo>-wt-<slug>, beside the repo) passes its assertUnderProjects rule
// (scripts/lane.mjs:953-970); exec otherwise.
// A run that chose its backend at intake (--backend) keeps it; herdr still
// needs a lane path lane.mjs create accepts. A run from before the choice
// reads the herdr probe it stored.
export function chooseBackend(state, deps) {
  const chosen = state.intent?.backend?.name;
  if (chosen === 't3') return { backend: 't3', detail: `T3 Code threads in project ${state.intent.backend.t3Project}` };
  if (chosen === 'exec') return { backend: 'exec', detail: 'chosen at intake (--backend exec)' };
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
    const options = ['--permission-mode', 'bypassPermissions', '--model', model, '--effort', 'high', '--output-format', 'json',
      '--settings', JSON.stringify(stopHookSettings(stopHookCommand(state, wp, deps)))];
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

// The paths a herdr lane's brief may name while they are absent from its
// worktree (lane.mjs prompt refuses any other absent path). Its own `- Create`
// paths, and a `- Modify` path an earlier WP of the run creates: the worktree
// is cut from origin/<default>, which lacks that file until the earlier WP
// merges. Any other Modify path the brief names must exist, or the brief's
// premise is stale (the check reads the brief, not the WP spec it points at). A
// directory entry (`dir/`) covers the paths under it. Herdr backend only: the
// exec backend's brief rides `conduct spawn`, which runs no path check.
export function allowedMissing(state, wp) {
  const own = wp.creates ?? [];
  // Only a WP that runs first can supply the file: an earlier wave, or one this WP depends on.
  const first = (other) => other.id !== wp.id && ((other.wave ?? 0) < (wp.wave ?? 0) || (wp.dependsOn ?? []).includes(other.id));
  const others = (state.wps ?? []).filter(first).flatMap((other) => other.creates ?? []);
  const under = (path, created) => path === created || (created.endsWith('/') && path.startsWith(created));
  const createdElsewhere = (wp.files ?? []).filter((path) => !own.includes(path) && others.some((created) => under(path, created)));
  return [...new Set([...own, ...createdElsewhere])];
}

// The repo's laneSetup command (deploy-truth probation H4: a new worktree has
// no dependencies): the pinned workspace config's, else the legacy repo
// file's. { command } or { problem }: a legacy file that cannot be read, or a
// laneSetup that is not a usable command, is named, never read as "none".
function laneSetupOf(state, deps) {
  let config = pinnedConfig(state);
  if (!config) {
    const path = join(state.intent.repo.path, '.workit', 'conduct.json');
    try {
      config = deps.exists?.(path) ? JSON.parse(deps.read(path)) : null;
    } catch (error) {
      return { problem: `${path} cannot be read for laneSetup: ${error.message}` };
    }
  }
  if (!config || !Object.hasOwn(config, 'laneSetup')) return { command: null };
  const setup = config.laneSetup;
  if (typeof setup !== 'string' || !setup.trim() || setup.includes('"')) return { problem: 'laneSetup must be a non-empty command string with no double quote' };
  return { command: setup };
}

export function laneBackend(state, deps, backend) {
  const repo = resolve(state.intent.repo.path);
  const fallbackBranch = state.intent.repo.defaultBranch ?? 'main';
  // Run in each new exec lane worktree before the agent starts: a real
  // install, so removing the worktree unlinks nothing. A herdr lane's path is
  // known only once lane.mjs create prints it, so herdr lanes run none yet.
  // A config problem throws when the setup is queued, so the WP blocks naming it.
  const setupActs = (cwd) => {
    const setup = laneSetupOf(state, deps);
    if (setup.problem) throw new ConductError(2, setup.problem);
    return setup.command ? [shellAction('create', {
      part: 'setup', instruction: 'Run the repo\'s laneSetup in the new lane worktree.', command: shellArgv(setup.command, deps.platform), cwd,
    })] : [];
  };
  // A recorder's deps are { exec, read, exists, now, … }; it re-arms steps from the run's root.
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
  // Every act this backend can queue for a WP, each variant whatever the
  // lane's state reads now: the build's emission compares a stored lane act
  // with this list (S1). A step whose inputs are not recorded derives nothing.
  const actsOf = (self, wp, variants) => variants.flatMap((produce) => {
    try {
      return produce(self);
    } catch (error) {
      if (!(error instanceof ConductError) && !(error instanceof TypeError)) throw error;
      return [];
    }
  });
  const answers = (wp) => (state.touches ?? []).filter((touch) => touch.wpId === wp.id && touch.answer).map((touch) => touch.answer);
  const deletes = (wp) => [...new Set([wp.gate?.head, wp.merge?.sha, wp.pr?.head].filter(Boolean))].flatMap((head) => branchDeletes(state, wp, head));
  if (backend === 'herdr') {
    return {
      acts(wp) {
        const running = { ...wp, lane: { ...wp.lane, exitedAt: null } };
        const fallback = () => [shellAction('fallback', {
          instruction: 'Hand the lane to claude.',
          command: ['node', join(pluginRoot, 'scripts', 'lane.mjs'), 'fallback', laneLayout(state, wp).name, '--to', 'claude',
            '--model', LANE_MODELS.claude.opus, '--reasoning', 'high', '--log', laneLayout(state, wp).runnerLog],
        })];
        return actsOf(this, wp, [(b) => b.admit(wp), (b) => b.create(wp), (b) => b.start(wp), (b) => b.prompt(wp), (b) => b.prompt(wp, { amendment: true }),
          (b) => b.prompt(wp, { amendment: true, resend: true }), ...answers(wp).map((answer) => (b) => b.prompt(wp, { amendment: true, answer })),
          (b) => b.wait(wp), (b) => b.check(wp), (b) => b.stop(running), (b) => b.remove(wp), () => deletes(wp), fallback]);
      },
      name: 'herdr',
      setup: () => [],
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
        if (agent === 'claude') args.push('--stop-hook', stopHookCommand(state, wp, deps));
        return [shellAction('start', { instruction: 'Start the lane agent.', command: laneMjs('start', args, lane.runnerLog) })];
      },
      // Every prompt after the first is an amendment. A spine answer's receipt
      // is named only when a resolver can resolve it; otherwise the brief
      // quotes the answer (rulingCarried: 'brief'). `resend` marks the
      // automatic capacity re-send, which renews nothing.
      prompt: (wp, { amendment = false, answer = null, resend = false } = {}) => {
        const lane = laneLayout(state, wp);
        const args = [lane.name, '--file', wp.lane.briefPath, ...allowedMissing(state, wp).flatMap((path) => ['--allow-missing', path])];
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
      // A merged WP's lane is swept: the delegate closes its pane first (a
      // shell holding the folder fails the removal) and removes only a lane
      // it reads SAFE. The workspace root is the lane's grandparent, the root
      // lane.mjs sweep walks for <workspace>/projects/<repo>-wt-<slug>.
      remove: (wp) => [shellAction('stop', {
        part: 'remove', instruction: 'Close the merged lane\'s pane and remove its worktree.',
        command: laneMjs('sweep', ['--lane', laneLayout(state, wp).name, '--workspace-root', dirname(dirname(repo))], laneLayout(state, wp).runnerLog),
      })],
    };
  }
  // Exec and t3 lanes share the worktree beside the repo, cut by git; only the
  // agent differs. The 3rd and 4th lanes are admitted on free commit memory.
  const gitAdmit = (wp) => (state.wps.filter((other) => other !== wp && holdsSlot(other)).length >= GATED_FROM_LANE - 1 ? [admitAction(['--require-reading'])] : []);
  const gitCreate = (wp) => {
    const lane = laneLayout(state, wp);
    return [...base(), shellAction('create', {
      part: 'worktree', instruction: 'Add the lane worktree beside the repo.',
      command: ['git', '-C', repo, 'worktree', 'add', lane.worktree, '-b', lane.branch, `origin/${fallbackBranch}`],
    }), ...setupActs(lane.worktree)];
  };
  const gitRemove = (wp) => [shellAction('stop', {
    part: 'remove', instruction: 'Remove the merged lane\'s worktree (no --force).', command: ['git', '-C', repo, 'worktree', 'remove', worktreeOf(wp)],
  })];
  const gitCheck = (wp) => [
    reportCheck(wp, []),
    prLookup(wp),
    shellAction('check', { part: 'pr', instruction: 'Check the PR.', command: conduct('check', wp, ['--pr', '{pr.number}']) }),
  ];
  if (backend === 't3') {
    // A T3 lane is a T3 Code thread bound to the git worktree (existing_worktree),
    // driven by MCP calls the conductor makes: launch, send, wait, interrupt.
    // A claude lane's Stop hook rides the worktree's .claude/settings.local.json
    // (`lane hook`), which T3's Claude provider loads.
    const agent = state.intent.agent;
    const tool = (step, part, name, args, instruction) => ({
      kind: 'agent-tool', step, seam: STEP_SEAM[step], ...(part ? { part } : {}), tool: name, args, expects: { type: 'json' }, instruction,
    });
    // A send's request id: stable across retries of one queued send, new for
    // each send after it (startedAt is renewed by every recorded send).
    const sendKey = (wp) => `${state.runId}-${wp.id.toLowerCase()}-a${wp.amendment?.n ?? 0}-${Date.parse(wp.lane?.startedAt ?? '') || 0}`;
    // With the heartbeat live, the lane's last act wakes the conductor's thread
    // (a queued send into an idle thread starts a turn there).
    const message = (wp) => {
      const read = `Read ${wp.lane?.briefPath ?? laneLayout(state, wp).briefPath} and execute it exactly.`;
      if (!t3WakeLive(state)) return read;
      const done = { threadId: state.t3Wake.thread, mode: 'queue', clientRequestId: `${sendKey(wp)}-done`,
        message: `[conduct ${state.slug}] ${wp.id}'s lane ended its turn (round a${wp.amendment?.n ?? 0}); report: ${laneLayout(state, wp).reportPath}. Addressed to the conductor thread ${state.t3Wake.thread}. A wake, not a verdict: run node ${conductScript(state)} next --run ${state.runDir} ${AS_THREAD} and keep looping. If it exits 5, this thread is no longer the run's conductor: end your turn.` };
      return `${read}\n\nYour last act, once your report is written and before you end your turn (whatever the outcome, early stops included): call the t3-code tool t3_thread_send with ${JSON.stringify(done)}. That message wakes the conductor. If a Stop hook sends you back to work after it, send it again at your next stop with -2, -3, … appended to clientRequestId.`;
    };
    const hookAct = (wp) => (agent === 'claude' ? [shellAction('create', {
      part: 'hook', instruction: 'Install the lane\'s Stop hook in its worktree.', command: conduct('hook', wp),
    })] : []);
    const readAct = (wp) => tool('wait', 'read', 't3_thread_read', { threadId: wp.lane?.threadId ?? null, view: 'activity', limit: 1, runLimit: 1 },
      'Call t3_thread_read with these args and record its raw result.');
    const wakeWait = (wp) => ({ kind: 'wait', step: 'wait', seam: STEP_SEAM.wait, waitMs: T3_HEARTBEAT_MS, wake: true,
      instruction: `${wp.id}'s T3 lane is running; its done message or the run's heartbeat wakes the conductor.` });
    return {
      acts(wp) {
        const running = { ...wp, lane: { ...wp.lane, exitedAt: null } };
        return actsOf(this, wp, [() => [admitAction(['--require-reading'])], (b) => b.create(wp), (b) => b.start(wp), (b) => b.prompt(wp, { amendment: true }),
          (b) => b.prompt(wp, { amendment: true, resend: true }), (b) => b.wait(wp), () => [readAct(wp)], (b) => b.check(wp), (b) => b.stop(running), (b) => b.reap(wp),
          (b) => b.remove(wp), () => deletes(wp), () => heartbeatActs(state, 'create'), () => heartbeatActs(state, 'wait')]);
      },
      name: 't3',
      setup: (wp) => setupActs(worktreeOf(wp)),
      admit: gitAdmit,
      // The heartbeat is made before the first launch, so the launch message
      // can name the conductor's thread (schedule_task returns it).
      create: (wp) => [...gitCreate(wp), ...hookAct(wp), ...heartbeatActs(state, 'create')],
      read: readAct,
      // The first prompt rides the launch. No idempotency key: a lost response
      // is found by title before launching again.
      start: (wp) => {
        const lane = laneLayout(state, wp);
        const title = `${state.slug} ${wp.id}: ${wp.name || 'lane'}`.slice(0, 120);
        return [tool('start', null, 't3_thread_launch', {
          title, projectId: state.intent.backend?.t3Project ?? null,
          workspaceStrategy: { type: 'existing_worktree', worktreePath: worktreeOf(wp), branch: wp.lane?.branch ?? lane.branch },
          modelSelection: t3ModelSelection(agent, wp.model), message: message(wp),
        }, `Call t3_thread_launch with these args and record its raw result. If its response is lost, find the thread with t3_thread_list (titleContains "${title}") and record that thread's row; never launch twice.`)];
      },
      // An amendment is a new turn in the same thread: the lane keeps its context.
      // T3 drops a repeated request id, so a reset re-prompt gets a new one (sendKey).
      prompt: (wp, { amendment = false, resend = false } = {}) => (amendment ? [tool('prompt', resend ? 'resend' : null, 't3_thread_send', {
        threadId: wp.lane?.threadId ?? null, message: message(wp), mode: 'queue', clientRequestId: `${sendKey(wp)}${resend ? '-resend' : ''}`,
      }, 'Call t3_thread_send with these args and record its raw result.')] : []),
      // With the heartbeat live the conductor ends its turn (the build's wake
      // yield) and reads the lane when it is woken. Without it, a 2-minute
      // t3_thread_wait polls, and a heartbeat owed (a rotated conductor's) is made first.
      // A replaced heartbeat whose delete failed is retried first (heartbeatRetries).
      wait: (wp) => [...heartbeatRetries(state, 'wait'), ...(t3WakeLive(state) ? [wakeWait(wp), readAct(wp)] : [...heartbeatActs(state, 'wait'), tool('wait', null, 't3_thread_wait', { threadId: wp.lane?.threadId ?? null, timeoutMs: T3_WAIT_MS },
        'Call t3_thread_wait with these args and record its raw result.')])],
      check: gitCheck,
      // Interrupt the running turn, then confirm the run is terminal. A lane
      // already exited gets the reap alone.
      stop: (wp) => (!wp.lane?.threadId ? [] : wp.lane?.exitedAt ? execReap(wp) : [
        tool('stop', 'interrupt', 't3_thread_interrupt', { threadId: wp.lane.threadId, reason: 'conduct stopped this lane' }, 'Call t3_thread_interrupt with these args and record its raw result.'),
        tool('stop', 'confirm', 't3_thread_wait', { threadId: wp.lane.threadId, timeoutMs: STOP_WAIT_MS }, 'Call t3_thread_wait with these args and record its raw result.'),
      ]),
      reap: (wp) => execReap(wp),
      // T3 holds the thread's worktree open until the thread is archived: git
      // empties it but cannot delete the folder. The archived thread keeps its history.
      remove: (wp) => [...(wp.lane?.threadId ? [tool('stop', 'archive', 't3_thread_organize', { action: 'archive', threadId: wp.lane.threadId },
        'Call t3_thread_organize with these args and record its raw result.')] : []), ...gitRemove(wp)],
    };
  }
  return {
    acts(wp) {
      const running = { ...wp, lane: { ...wp.lane, exitedAt: null } };
      return actsOf(this, wp, [() => [admitAction(['--require-reading'])], (b) => b.create(wp), (b) => b.start(wp), (b) => b.prompt(wp, { amendment: true }),
        (b) => b.wait(wp), (b) => b.check(wp), (b) => b.stop(running), (b) => b.reap(wp), (b) => b.kill(wp), (b) => b.remove(wp), () => deletes(wp)]);
    },
    name: 'exec',
    // reset-wp --to setup: the repo's laneSetup again, in the worktree create made.
    setup: (wp) => setupActs(worktreeOf(wp)),
    // A 3rd or 4th lane agent is admitted on measured free commit memory: room is
    // the gate's whole point, so a host that cannot measure it does not get one.
    // A landing WP runs no agent and is not counted (holdsSlot).
    admit: gitAdmit,
    create: gitCreate,
    // The first prompt rides the spawn; an amendment resumes the session.
    start: (wp) => [shellAction('start', { instruction: 'Start the lane agent, detached.', command: conduct('spawn', wp) })],
    prompt: (wp, { amendment = false } = {}) => (amendment
      ? [shellAction('prompt', { instruction: 'Resume the lane agent on its amended brief.', command: conduct('spawn', wp, ['--amend', wp.lane.briefPath]) })]
      : []),
    wait: (wp) => [shellAction('wait', { instruction: 'Ask whether the lane agent still runs.', command: conduct('alive', wp) })],
    check: gitCheck,
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
    remove: gitRemove,
    kill: (wp) => [
      shellAction('stop', {
        part: 'kill', instruction: 'Terminate the lane agent if the pid is still its own.', command: guardedKillArgv(wp.lane.pid, wp.lane.identity, deps.platform ?? process.platform),
      }),
      confirmAction(wp),
    ],
  };
}

const laneBranch = (state, wp) => wp.lane?.branch ?? laneLayout(state, wp).branch;

// The worktree that has `branch` checked out, from `git worktree list
// --porcelain`; null when none does.
export function checkedOutAt(porcelain, branch) {
  let path = null;
  for (const line of String(porcelain).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return path ?? '?';
  }
  return null;
}

// A merged WP's branch, local then on origin, queued only once its worktree
// is gone, behind a read of every worktree's checkout run right before them:
// update-ref deletes a checked-out branch, and the sweep HOLDs a lane whose
// upstream is gone. Both compare and delete, so a branch that moved past the
// merged head stays.
// The release phase queues the same three steps for its own branch.
export function branchDeleteSteps(repo, branch, head, what = 'merged lane') {
  return [
    { part: 'branch-holder', instruction: 'List every worktree, to keep a branch another worktree has checked out.',
      command: ['git', '-C', repo, 'worktree', 'list', '--porcelain'] },
    { part: 'branch', instruction: `Delete the ${what}'s local branch if it still names the merged head.`,
      command: ['git', '-C', repo, 'update-ref', '-d', `refs/heads/${branch}`, head] },
    { part: 'branch-remote', instruction: `Delete the ${what}'s branch on origin if it still names the merged head.`,
      command: ['git', '-C', repo, 'push', 'origin', `--force-with-lease=refs/heads/${branch}:${head}`, '--delete', branch] },
  ];
}

function branchDeletes(state, wp, head) {
  return branchDeleteSteps(resolve(state.intent.repo.path), laneBranch(state, wp), head).map((fields) => shellAction('stop', fields));
}

// Removed means the directory is gone, and git either removed it or no longer
// knows it: a replayed removal (resumed before its result was recorded)
// exits 128 "is not a working tree" on a worktree it already removed.
export const worktreeGone = (result, worktree, exists) => !exists(worktree)
  && (result.code === 0 || /is not a working tree/.test(String(result.stderr ?? '')));

// A branch already gone is the goal reached, not a failure.
const BRANCH_ABSENT = /unable to resolve reference|remote ref does not exist/;
export const branchOutcome = (result) => (result.code === 0 ? 'deleted' : BRANCH_ABSENT.test(String(result.stderr ?? '')) ? 'absent' : 'kept');

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

// The unfenced lines of an amendment's `### PR…` subsection, or null.
function amendmentPr(section) {
  const start = section.lines.findIndex((line) => !line.fenced && /^###\s+PR\b/.test(line.text));
  if (start < 0) return null;
  const stop = section.lines.findIndex((line, i) => i > start && !line.fenced && /^#{1,3}\s/.test(line.text));
  return { lines: section.lines.slice(start + 1, stop < 0 ? section.lines.length : stop).filter((line) => !line.fenced) };
}

// The report's current PR claims, each a number and a head sha (7–40 hex) or
// nulls: the top-level `## PR`, which a lane may update in place, and the
// `### PR` subsection of the latest amendment that has one. Either may be the
// newer; the check passes when one of them names the PR's head.
function reportPrClaims(text) {
  const claim = (from, section) => {
    const body = (section?.lines ?? []).map((line) => line.text).join('\n');
    return { from, number: Number(/#?(\d+)\b/.exec(body)?.[1] ?? NaN) || null, head: /\b([0-9a-f]{7,40})\b/.exec(body)?.[1] ?? null };
  };
  const amended = amendmentSections(text).map((section) => ({ n: section.n, pr: amendmentPr(section) })).filter(({ pr }) => pr).at(-1);
  return [claim('## PR', reportSection(text, 'PR')), ...(amended ? [claim(`## Amendment ${amended.n}'s ### PR`, amended.pr)] : [])];
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

// How long a lane may run from its start or amendment: the repo config's
// laneDeadlineMinutes (a slow-build repo), else DEADLINE_MS.
export function laneDeadlineMs(state) {
  const minutes = pinnedConfig(state)?.laneDeadlineMinutes;
  return Number.isInteger(minutes) && minutes > 0 ? minutes * 60 * 1000 : DEADLINE_MS;
}

// A successful start or conductor amendment: a fresh deadline, the exit
// marker cleared, every retry counter reset.
export function freshStart(deps, startedAt = null, deadlineMs = DEADLINE_MS) {
  const at = startedAt ? Date.parse(startedAt) : deps.now();
  return { startedAt: iso(at), deadline: iso(at + deadlineMs), exitedAt: null, dialogPolls: 0, capacityResent: false, startRearms: 0, stopConfirms: 0 };
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
  if (action.kind === 'agent-tool') return recordT3Step(state, wp, action, result, deps, backend);
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
      if (action.part === 'fetch' || action.part === 'setup' || action.part === 'hook') return proceed();
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
        // What was queued after the start (a reset's prompt) still follows it.
        return { outcome: 'wait', reason: `start refused: ${said(result)}`, patch: { lane: { startRearms: rearms }, queue: [waitAction(POLL_MS), ...backend.start(wp), ...(wp.queue ?? []).slice(1)] } };
      }
      if (result.code === LANE_EXIT.blocked) return dialogRoute(wp, result, backend.wait(wp));
      return ok ? proceed({ lane: freshStart(deps, parseStdout(result)?.startedAt, laneDeadlineMs(state)) }) : block(said(result));
    }
    case 'prompt':
      if (!ok) return block(said(result));
      // Only a conductor amendment renews the deadline and the counters.
      if (action.part === 'resend') return proceed();
      return proceed({ lane: freshStart(deps, parseStdout(result)?.startedAt, laneDeadlineMs(state)) });
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
  if (result.code === LANE_EXIT.ok) {
    // herdr reads a pane idle while the lane's background shell still runs; the
    // agent wakes when it ends. The stop-check's verdict says so: hold the wait
    // for BACKGROUND_HOLD_MS from that stop, then check as before.
    const stopCheck = laneStopCheck(state, wp, deps);
    const since = Date.parse(stopCheck?.at ?? '');
    if (stopCheck?.verdict === 'background-live' && deps.now() - since < BACKGROUND_HOLD_MS && !expired(wp, deps)) {
      const tasks = (stopCheck.tasks ?? []).map((task) => task.command ?? task.id).join('; ');
      return { outcome: 'wait', reason: `lane stopped with a background task running: ${tasks}`, patch: { lane: { dialogPolls: 0 }, queue: [waitAction(POLL_MS), ...backend.wait(wp)] } };
    }
    return proceed({ lane: { dialogPolls: 0, ...(stopCheck ? { stopCheck: stopCheckSummary(stopCheck) } : {}) } });
  }
  if (result.code === LANE_EXIT.error || result.code === LANE_EXIT.usage) return block(said(result));
  // Every route below recovers; an expired deadline comes first.
  if (expired(wp, deps)) return deadlineBlock(wp, backend);
  switch (result.code) {
    case LANE_EXIT.timeout:
      return { outcome: 'wait', reason: 'lane running', patch: { lane: { dialogPolls: 0 }, queue: [waitAction(0), ...backend.wait(wp)] } };
    case LANE_EXIT.blocked:
      return dialogRoute(wp, result, backend.wait(wp));
    case LANE_EXIT.planLow: {
      // A claude lane the plan refused can't fall back to claude: its WP waits for the reset.
      const refused = parseStdout(result);
      if (refused?.refusalShape === 'transcript') {
        return block(`usage limit: the plan refused the lane (${refused.rateLimitType ?? 'unknown window'}); it resets at ${refused.resetsAt ?? 'an unknown time'}. ${refused.refusal ?? ''}`.trim());
      }
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

// A T3 tool's raw result. A call the conductor could not make is recorded as
// its error ({ error } or { isError }), and blocks with it.
const t3Said = (result) => JSON.stringify(result ?? null).slice(0, 400);
const t3Failed = (result) => !result || typeof result !== 'object' || result.isError === true || Boolean(result.error) || result.ok === false;

// ---- the T3 wake: state.t3Wake, run-level, written by the heartbeat's record ----
// { taskId, thread, conductor, at } is the live heartbeat: a schedule_task
// bound to conductor r<conductor>'s thread, which lanes' done messages target
// too. `failed` (that conductor's schedule_task failed or bound no thread)
// keeps its lanes polling. `old` lists replaced heartbeats and whether each
// was deleted; analyze deletes whatever is left.
export function t3WakeLive(state) {
  const wake = state.t3Wake;
  return Boolean(wake?.taskId && wake.thread && !wake.failed && !wake.deleted && wake.conductor === conductorNumber(state));
}

const heartbeatTitle = (state) => `conduct ${state.slug} heartbeat`;

// How a T3 conductor names itself to `next`/`record --as-thread`.
const AS_THREAD = '--as-thread <your own T3 thread id> (orchestrator_capabilities\' parentThreadId, or t3_thread_configuration\'s threadId)';

// `--as-thread <id>`: a T3 conductor woken in its own thread (a lane's done
// message, the heartbeat) names that thread. While a live heartbeat is bound
// to the run's conductor thread, every other thread is refused. With none
// (deleted at analyze, failed, or not made yet) only a retired conductor's
// thread is refused: one on state.retiredConductorThreads (custody appends
// the outgoing conductor's) or one a retired conductor's heartbeat was bound
// to. Without the flag (herdr, exec, by hand) nothing is checked.
// While a rotation is open, custody is bound to the successor's thread: the
// first `next --custody <n> --as-thread <id>` stores it (rotate.mjs
// bindCustodyThread), and until custody is taken every other thread is
// refused, the outgoing conductor's before any custody action is returned.
export function conductorThreadFence(state, asThread) {
  if (asThread === undefined || asThread === null) return;
  if (typeof asThread !== 'string' || !asThread.trim()) throw new ConductError(2, '--as-thread <thread id> needs a value');
  const rotation = state.rotations?.at(-1);
  if (rotation?.status === 'open') {
    if (rotation.thread ? asThread !== rotation.thread : outgoingThreads(state, rotation).includes(asThread)) {
      throw new ConductError(5, `not this run's conductor (current: ${rotation.thread ?? `none yet: rotation ${rotation.attempt}'s custody is r${rotation.to}'s`}); ${asThread} is not r${rotation.to}'s thread, so end your turn`);
    }
    return;
  }
  const n = conductorNumber(state);
  const live = t3WakeLive(state) ? state.t3Wake.thread : null;
  if (live ? asThread !== live : retiredThreads(state).includes(asThread)) {
    throw new ConductError(5, `not this run's conductor (current: ${live ?? 'none yet'}); ${asThread} is not r${n}'s thread, so end your turn`);
  }
}

// Threads no conductor may use again: the list custody appends to, and any
// heartbeat thread of a conductor before the current one.
function retiredThreads(state) {
  const n = conductorNumber(state);
  const wake = state.t3Wake ?? {};
  const bound = [wake, ...(wake.old ?? [])].filter((entry) => entry?.thread && entry.conductor !== n).map((entry) => entry.thread);
  return [...(state.retiredConductorThreads ?? []), ...bound];
}

// The threads an open rotation's custody refuses before it is bound: the
// outgoing conductor's (stored when it rotated), any retired one, and any
// earlier conductor's heartbeat thread.
function outgoingThreads(state, rotation) {
  const wake = state.t3Wake ?? {};
  const bound = [wake, ...(wake.old ?? [])].filter((entry) => entry?.thread && entry.conductor !== rotation.to).map((entry) => entry.thread);
  return [...(rotation.fromThread ? [rotation.fromThread] : []), ...(state.retiredConductorThreads ?? []), ...bound];
}

// Custody taken: the outgoing conductor's threads join the retired list
// (all but the successor's own). Returns the list, or null when it is empty.
export function retireConductorThreads(state, rotation) {
  const wake = state.t3Wake ?? {};
  const threads = [rotation.fromThread, ...[wake, ...(wake.old ?? [])].filter((entry) => entry?.conductor === rotation.from).map((entry) => entry.thread)];
  const retired = new Set(state.retiredConductorThreads ?? []);
  for (const thread of threads) if (thread && thread !== rotation.thread) retired.add(thread);
  if (!retired.size) return null;
  state.retiredConductorThreads = [...retired];
  return state.retiredConductorThreads;
}

// `next --resume --as-thread <id>`: a fresh T3 session resuming a run with
// no live heartbeat (the fence has passed it) adopts its own thread as the
// conductor thread. A heartbeat record left behind moves to `old`, one still
// undeleted owed a delete. With T3 lanes live, a new heartbeat is queued on
// one of them, and a pending wake yield (whose wakes no heartbeat sends) goes:
// every lane is read now.
export function adoptConductorThread(state, asThread, deps) {
  if (state.intent?.backend?.name !== 't3' || typeof asThread !== 'string' || !asThread.trim()) return null;
  if (state.rotations?.at(-1)?.status === 'open' || t3WakeLive(state)) return null;
  const n = conductorNumber(state);
  const wake = state.t3Wake ?? null;
  if (wake?.conductor === n && wake.thread === asThread) return null;
  const old = [...(wake?.old ?? [])];
  if (wake?.taskId) {
    old.push({ taskId: wake.taskId, thread: wake.thread ?? null, conductor: wake.conductor ?? null, deleted: wake.deleted === true,
      attempts: wake.deleteAttempts ?? (wake.deleteResult ? 1 : 0), ...(wake.deleteResult?.error ? { error: wake.deleteResult.error } : {}) });
  }
  // A new request id per adoption: T3 would hand an earlier heartbeat of the same conductor back.
  state.t3Adoptions = (state.t3Adoptions ?? 0) + 1;
  state.t3Wake = { taskId: null, thread: asThread, conductor: n, at: iso(deps.now()), failed: null, deleted: false, old };
  const heartbeat = queueHeartbeat(state, deps);
  appendEvent(state, deps, { event: 'conductor-adopted', source: 'next', data: { from: wake?.thread ?? null, to: asThread, conductor: n, heartbeat } });
  return { from: wake?.thread ?? null, to: asThread };
}

// A heartbeat made by the adopting conductor, queued on a live T3 lane (after
// its pending action, if any), unless one is queued already. Returns whether one is.
function queueHeartbeat(state, deps) {
  if (state.phase !== 'build') return false;
  const lanes = state.wps.filter((wp) => wp.lane?.backend === 't3' && (LIVE_STATES.includes(wp.state) || laneOccupied(wp)) && wp.queue?.length);
  if (!lanes.length) return false;
  releaseWakeYield(state, deps, { data: { why: 'conductor-adopted' } });
  if (state.wps.some((wp) => (wp.queue ?? []).some((act) => act.part === 'heartbeat'))) return true;
  const acts = heartbeatActs(state, 'wait');
  if (!acts.length) return false;
  const [wp] = lanes;
  const at = state.pending?.wpId === wp.id ? Math.min(1, wp.queue.length) : 0;
  wp.queue.splice(at, 0, ...acts);
  return true;
}

// A pending wake yield whose wakes would not reach the conductor is dropped,
// and each lane's wake wait with it: every live T3 lane is read at once, as a
// heartbeat tick reads them. Custody does this too, once the heartbeat is
// bound to the successor: its first wait would otherwise be a wake yield.
export function releaseWakeYield(state, deps, { step = 'wait', kind = 'wait', data = {} } = {}) {
  if (state.pending?.kind !== 'wait' || state.pending.wake !== true) return false;
  appendEvent(state, deps, { step, kind, event: 'wake-yield-dropped', source: 'next', data: { ...data, actionId: state.pending.id } });
  state.pending = null;
  for (const wp of state.wps) if (wp.queue?.[0]?.kind === 'wait' && wp.queue[0].wake) wp.queue.shift();
  return true;
}

// The heartbeat a T3 run's conductor owes: none while one is live or this
// conductor's failed; otherwise the stale one (a rotated predecessor's) is
// deleted and a new one bound to the calling conductor. The request id is
// per conductor, so lanes that each queue it make one task.
export function heartbeatActs(state, step) {
  if (state.intent?.backend?.name !== 't3' || t3WakeLive(state)) return [];
  const n = conductorNumber(state);
  const wake = state.t3Wake;
  if (wake?.failed && wake.conductor === n) return [];
  const t3 = (part, name, args, instruction) => ({ kind: 'agent-tool', step, seam: STEP_SEAM[step], part, tool: name, args, expects: { type: 'json' }, instruction });
  const stale = wake?.taskId && !wake.deleted ? [t3('heartbeat-stop', 'delete_scheduled_task', { scheduledTaskId: wake.taskId },
    'Call delete_scheduled_task with these args and record its raw result (an error too): it is the previous conductor\'s heartbeat.')] : [];
  return [...stale, t3('heartbeat', 'schedule_task', heartbeatArgs(state, n), HEARTBEAT_INSTRUCTION)];
}

export const HEARTBEAT_INSTRUCTION = 'Call schedule_task with these args from your own (the conductor\'s) thread, and record its raw result, an error too.';

// schedule_task's args for conductor r<n>'s heartbeat. The request id is per
// conductor, so lanes that each queue it make one task.
export function heartbeatArgs(state, n) {
  const prompt = `[${heartbeatTitle(state)}] A wake tick for conduct run ${state.runDir}, every ${T3_HEARTBEAT_MS / 60000} minutes while its T3 lanes run, addressed to the thread that made it: conductor r${n}'s. Run node ${conductScript(state)} next --run ${state.runDir} ${AS_THREAD} and perform what it prints: a pending wake wait is recorded {} (record --as-thread too) and the loop goes on. If it exits 5, this thread is not the run's conductor (the run was rotated away): end your turn. If the run has ended, end your turn.`;
  const adopted = state.t3Adoptions ? `-a${state.t3Adoptions}` : '';
  return { title: heartbeatTitle(state), prompt, schedule: { type: 'interval', everyMs: T3_HEARTBEAT_MS }, bindToCurrentThread: true, clientRequestId: `${state.runId}-heartbeat-r${n}${adopted}` };
}

// A heartbeat made by conductor r<n> at custody: it replaces whatever the run
// held. Returns the task ids now owed a delete: the replaced one, and a new
// one bound to no thread (it would start a fresh thread every tick).
export function adoptHeartbeat(state, n, result, at) {
  const wake = state.t3Wake ?? {};
  const old = [...(wake.old ?? [])];
  const stops = [];
  const made = !t3Failed(result) && typeof result.scheduledTaskId === 'string' ? result.scheduledTaskId : null;
  if (wake.taskId && !wake.deleted && wake.taskId !== made) {
    old.push({ taskId: wake.taskId, thread: wake.thread ?? null, conductor: wake.conductor ?? null });
    stops.push(wake.taskId);
  }
  if (!made) {
    state.t3Wake = { taskId: null, thread: null, conductor: n, failed: `schedule_task: ${t3Said(result)}`, old };
  } else if (typeof result.boundThreadId !== 'string' || !result.boundThreadId) {
    old.push({ taskId: made });
    stops.push(made);
    state.t3Wake = { taskId: null, thread: null, conductor: n, failed: `schedule_task bound no thread: ${t3Said(result)}`, old };
  } else {
    state.t3Wake = { taskId: made, thread: result.boundThreadId, conductor: n, at, failed: null, deleted: false, old };
  }
  return stops;
}

// A heartbeat's record. It never blocks the WP: a failure leaves the lanes polling.
function recordHeartbeat(state, wp, action, result, deps) {
  const rest = (wp.queue ?? []).slice(1);
  const wake = state.t3Wake ?? null;
  const old = wake?.old ?? [];
  if (action.part === 'heartbeat-stop') {
    const id = action.args.scheduledTaskId;
    // A replaced live task moves to `old`, keeping the thread it was bound
    // to: the conductor fence refuses a retired conductor's thread.
    if (wake?.taskId === id) {
      state.t3Wake = { ...wake, taskId: null, thread: null, old: [...old.filter((entry) => entry.taskId !== id), { taskId: id, thread: wake.thread ?? null, conductor: wake.conductor ?? null }] };
    }
    recordHeartbeatDelete(state, id, result);
    return proceed();
  }
  const conductor = Number(/-heartbeat-r(\d+)(?:-a\d+)?$/.exec(action.args.clientRequestId)?.[1] ?? conductorNumber(state));
  if (t3Failed(result) || typeof result.scheduledTaskId !== 'string') {
    state.t3Wake = { ...wake, taskId: null, thread: null, conductor, failed: `schedule_task: ${t3Said(result)}`, old };
    return proceed({}, 'no heartbeat: the T3 lanes poll');
  }
  const remove = (taskId, why) => ({ kind: 'agent-tool', step: action.step, seam: action.seam, part: 'heartbeat-stop', tool: 'delete_scheduled_task',
    args: { scheduledTaskId: taskId }, expects: { type: 'json' }, instruction: `Call delete_scheduled_task with these args and record its raw result (an error too): ${why}.` });
  // A heartbeat bound to no thread would start a fresh thread every tick.
  if (typeof result.boundThreadId !== 'string' || !result.boundThreadId) {
    state.t3Wake = { ...wake, taskId: null, thread: null, conductor, failed: `schedule_task bound no thread: ${t3Said(result)}`, old: [...old, { taskId: result.scheduledTaskId }] };
    return proceed({ queue: [remove(result.scheduledTaskId, 'it is bound to no thread'), ...rest] }, 'no heartbeat: the T3 lanes poll');
  }
  // A second task beside the live one (a request T3 did not dedupe): it goes.
  if (t3WakeLive(state) && wake.taskId !== result.scheduledTaskId) {
    state.t3Wake = { ...wake, old: [...old, { taskId: result.scheduledTaskId }] };
    return proceed({ queue: [remove(result.scheduledTaskId, 'the run already has a heartbeat'), ...rest] });
  }
  state.t3Wake = { taskId: result.scheduledTaskId, thread: result.boundThreadId, conductor, at: iso(deps.now()), failed: null, deleted: false, old };
  return proceed();
}

// The heartbeats a finished build still owns, for the analyze phase to delete.
// A heartbeat's delete is owed until it succeeds or has been tried this often.
export const HEARTBEAT_DELETE_ATTEMPTS = 3;

// Every heartbeat the run made, the live one first:
// { taskId, thread, conductor, deleted, attempts, error }.
function heartbeatEntries(state) {
  const wake = state.t3Wake;
  if (!wake) return [];
  const live = wake.taskId ? [{ taskId: wake.taskId, thread: wake.thread ?? null, conductor: wake.conductor ?? null, deleted: wake.deleted,
    attempts: wake.deleteAttempts ?? (wake.deleteResult ? 1 : 0), error: wake.deleteResult?.error }] : [];
  return [...live, ...(wake.old ?? []).map((entry) => ({ ...entry, attempts: entry.attempts ?? (entry.deleted === undefined ? 0 : 1) }))];
}

const owed = (entry) => entry.deleted !== true && entry.attempts < HEARTBEAT_DELETE_ATTEMPTS;

// The heartbeats a finished build still owns, for the analyze phase to delete.
export function heartbeatsToDelete(state) {
  return heartbeatEntries(state).filter(owed).map((entry) => entry.taskId);
}

// The heartbeats left undeleted, for the run analysis to name.
export function unresolvedHeartbeats(state) {
  return heartbeatEntries(state).filter((entry) => entry.deleted !== true);
}

// A replaced heartbeat whose delete failed is retried at each later wait,
// once per tick: a retry another lane already holds is not queued again.
function heartbeatRetries(state, step) {
  const queued = new Set(state.wps.flatMap((wp) => (wp.queue ?? []).filter((act) => act.part === 'heartbeat-stop').map((act) => act.args?.scheduledTaskId)));
  return heartbeatEntries(state).filter((entry) => entry.taskId !== state.t3Wake.taskId && entry.deleted === false && owed(entry) && !queued.has(entry.taskId))
    .map((entry) => ({ kind: 'agent-tool', step, seam: STEP_SEAM[step], part: 'heartbeat-stop', tool: 'delete_scheduled_task', args: { scheduledTaskId: entry.taskId }, expects: { type: 'json' },
      instruction: `Call delete_scheduled_task with these args and record its raw result (an error too): a replaced heartbeat whose delete failed (attempt ${entry.attempts + 1} of ${HEARTBEAT_DELETE_ATTEMPTS}).` }));
}

// One delete's outcome: a task already gone counts as deleted. A failed one
// stays owed until HEARTBEAT_DELETE_ATTEMPTS; the run analysis names what is left.
export function recordHeartbeatDelete(state, taskId, result) {
  const gone = !t3Failed(result) || /task_not_found|not found/i.test(t3Said(result));
  const wake = state.t3Wake ?? {};
  const was = heartbeatEntries(state).find((entry) => entry.taskId === taskId) ?? { attempts: 0 };
  const deleted = was.deleted === true || gone;
  const attempts = was.attempts + 1;
  const error = deleted ? undefined : t3Said(result);
  if (wake.taskId === taskId) {
    state.t3Wake = { ...wake, deleted, deleteAttempts: attempts, deleteResult: { taskId, deleted, ...(error ? { error } : {}) } };
    return;
  }
  const old = wake.old ?? [];
  const update = ({ error: _stale, ...entry } = {}) => ({ ...entry, taskId, deleted, attempts, ...(error ? { error } : {}) });
  state.t3Wake = { ...wake, old: old.some((entry) => entry.taskId === taskId) ? old.map((entry) => (entry.taskId === taskId ? update(entry) : entry)) : [...old, update()] };
}

// What the latest activity items say a lane waits on: the last waiting
// approval or question, by its text.
function waitingOn(result) {
  const item = [...(Array.isArray(result.items) ? result.items : [])].reverse().find((entry) => entry?.status === 'waiting' && /request/.test(String(entry.type ?? '')));
  if (!item) return null;
  const kind = item.type === 'approval_request' ? 'an approval' : item.type === 'user_input_request' ? 'a question' : item.type;
  // A question's text is its JSON array of questions, each with its options.
  let text = String(item.text ?? '');
  try {
    const asked = JSON.parse(text);
    if (Array.isArray(asked) && asked.every((entry) => typeof entry?.question === 'string')) {
      text = asked.map((entry) => `${entry.question}${Array.isArray(entry.options) ? ` (${entry.options.map((option) => option?.label).filter(Boolean).join(' / ')})` : ''}`).join('; ');
    }
  } catch { /* an approval's text is prose */ }
  return `${kind}: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}

function recordT3Step(state, wp, action, result, deps, backend) {
  // Cleanup never blocks: a thread left unarchived is named on the lane, and the removal after it says what stayed.
  if (action.part === 'archive') return proceed({ lane: { archived: !t3Failed(result), ...(t3Failed(result) ? { archiveError: t3Said(result) } : {}) } });
  if (action.part === 'heartbeat' || action.part === 'heartbeat-stop') return recordHeartbeat(state, wp, action, result, deps);
  const rest = (wp.queue ?? []).slice(1);
  // A stop's calls go through the cleanup retries, keeping what is queued
  // behind them: a failed interrupt is left to the confirmation, and a failed
  // confirmation counts as one that saw the run still going.
  if (action.step === 'stop' && action.part === 'interrupt') return proceed();
  if (action.step === 'stop' && t3Failed(result)) return t3StopUnconfirmed(wp, action, rest, backend, `${action.tool} failed: ${t3Said(result)}`);
  if (t3Failed(result)) return block(`${action.tool}: ${t3Said(result)}`);
  switch (action.step) {
    case 'start':
      if (typeof result.threadId !== 'string' || !result.threadId) return block(`t3_thread_launch returned no threadId: ${t3Said(result)}`);
      return proceed({ lane: { threadId: result.threadId, runId: result.runId ?? null, ...freshStart(deps, null, laneDeadlineMs(state)) } });
    case 'prompt':
      if (typeof result.threadId !== 'string' && typeof result.runId !== 'string') return block(`t3_thread_send returned no run: ${t3Said(result)}`);
      if (action.part === 'resend') return proceed();
      return proceed({ lane: { runId: result.runId ?? wp.lane?.runId ?? null, ...freshStart(deps, null, laneDeadlineMs(state)) } });
    case 'wait': {
      // A wait that times out is followed by a read, which sees a lane blocked on a person.
      if (action.part !== 'read' && action.part !== 'dialog') {
        return t3RunRoute(state, wp, String(result.status ?? ''), result.timedOut === true, result, deps, backend, rest,
          () => proceed({ queue: [backend.read(wp)] }, 'lane running: read it for a pending request'));
      }
      // A read: T3 shows a run waiting on an approval or a question as running,
      // and counts the request in pendingRequestCount. A count blocks the WP at
      // once; a second read of the latest activity names the request.
      const thread = result.thread ?? {};
      const run = Array.isArray(result.recentRuns) ? result.recentRuns[0] : null;
      const status = String(run?.status ?? thread.status ?? '');
      const pending = Number(thread.pendingRequestCount ?? 0);
      if (pending > 0 && !T3_ENDED.has(status)) {
        if (action.part === 'read') return proceed({ queue: [dialogRead(wp, thread.itemCount)] }, `the lane has ${pending} pending request(s): read which`);
        const dialog = `${waitingOn(result) ?? `${pending} pending request(s) the activity view does not name`} (T3 thread ${wp.lane?.threadId})`;
        return block(`dialog: ${dialog}`, { lane: { dialogPolls: 0 } }, 'dialog', { dialog });
      }
      return t3RunRoute(state, wp, status, false, result, deps, backend, rest,
        () => ({ outcome: 'wait', reason: `lane running (${status || 'unread'})`, patch: { queue: [...backend.wait(wp)] } }));
    }
    case 'stop': {
      const status = String(result.status ?? '');
      if (!(result.timedOut === true || T3_RUNNING.has(status))) {
        return done('lane stopped', { lane: exitedLane(state, wp, deps, false), queue: [...backend.reap(wp), ...rest] });
      }
      return t3StopUnconfirmed(wp, action, rest, backend, `the lane's T3 run is still ${status || 'running'} after the interrupt`);
    }
    default:
      throw new ConductError(2, `recordLaneStep has no T3 route for step ${action.step}`);
  }
}

// A lane's run status, from a wait or a read. `running` is the route of a
// run still going, before its deadline.
function t3RunRoute(state, wp, status, timedOut, result, deps, backend, rest, running) {
  if (T3_ENDED.has(status)) {
    // A stop with a background task still running wakes the agent when it
    // ends, as in herdr: hold the wait on the stop-check's verdict.
    const stopCheck = laneStopCheck(state, wp, deps);
    const since = Date.parse(stopCheck?.at ?? '');
    if (stopCheck?.verdict === 'background-live' && deps.now() - since < BACKGROUND_HOLD_MS && !expired(wp, deps)) {
      const tasks = (stopCheck.tasks ?? []).map((task) => task.command ?? task.id).join('; ');
      const again = t3WakeLive(state) ? backend.wait(wp) : [waitAction(POLL_MS), ...backend.wait(wp)];
      return { outcome: 'wait', reason: `lane stopped with a background task running: ${tasks}`, patch: { queue: again } };
    }
    return proceed({ lane: exitedLane(state, wp, deps, true), queue: [...backend.reap(wp), ...rest] });
  }
  if (timedOut || T3_RUNNING.has(status)) {
    if (expired(wp, deps)) return deadlineBlock(wp, backend);
    return running();
  }
  // interrupted, failed, cancelled, rolled_back: the agent is not running.
  return block(`the lane's T3 run ended ${status || 'unreadably'}: ${t3Said(result)}`, { lane: exitedLane(state, wp, deps, false), queue: backend.reap(wp) });
}

// The latest activity items, read after a count of pending requests: an
// activity read pages from the oldest item, and afterPosition is exclusive.
function dialogRead(wp, itemCount) {
  const count = Number.isInteger(itemCount) ? itemCount : 0;
  return {
    kind: 'agent-tool', step: 'wait', seam: STEP_SEAM.wait, part: 'dialog', tool: 't3_thread_read', expects: { type: 'json' },
    args: { threadId: wp.lane?.threadId ?? null, view: 'activity', limit: 5, runLimit: 1, maxCharsPerItem: 600, ...(count > 5 ? { afterPosition: count - 6 } : {}) },
    instruction: 'Call t3_thread_read with these args and record its raw result.',
  };
}

// An unconfirmed stop is confirmed again after 10 s, up to STOP_CONFIRMS
// times; then it blocks as 'cleanup-unresolved' with its stop and the rest still queued.
function t3StopUnconfirmed(wp, action, rest, backend, why) {
  const confirms = (wp.lane?.stopConfirms ?? 0) + 1;
  if (confirms >= STOP_CONFIRMS) {
    return block(`cleanup unresolved after ${confirms} confirmations: ${why}`, { lane: { stopConfirms: confirms }, queue: [...backend.stop(wp), ...rest] }, 'cleanup-unresolved');
  }
  return { outcome: 'wait', reason: why, patch: { lane: { stopConfirms: confirms }, queue: [waitAction(STOP_WAIT_MS), action, ...rest] } };
}

// The lane's exit is observed. The exec log holds its session id and, for
// claude, its cost: complete only when the agent ended on its own (not killed,
// pid not reused); a log with no result keeps the known cost.
function exitedLane(state, wp, deps, natural) {
  const lane = { exitedAt: iso(deps.now()), stopConfirms: 0 };
  const stopCheck = laneStopCheck(state, wp, deps);
  if (stopCheck) lane.stopCheck = stopCheckSummary(stopCheck);
  if (wp.lane?.backend === 'herdr' || wp.lane?.backend === 't3') return lane;
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
  // The actions queued after this stop (a reap, a worktree removal, a ratify
  // or cite ruling) outlive it: every queue below keeps them.
  const rest = (wp.queue ?? []).slice(1);
  // Removed means the directory is gone: a sweep exits 0 on a lane it HOLDs.
  // Only then are the branches deleted, against the head the merge checked.
  if (action.part === 'remove') {
    const worktree = wp.lane?.worktree ?? laneLayout(state, wp).worktree;
    const removed = worktreeGone(result, worktree, deps.exists);
    const removeError = removed ? null : result.code === 0 ? `${worktree} still exists after the removal: ${said(result)}` : said(result);
    const head = wp.gate?.head;
    const lane = { removed, ...(removeError ? { removeError } : {}) };
    return proceed({ lane, ...(removed && head ? { queue: [...branchDeletes(state, wp, head), ...rest] } : {}) });
  }
  // Another worktree (an operator's `gh pr checkout`), or a listing that
  // failed, keeps both branches: the two deletes queued behind it are dropped.
  if (action.part === 'branch-holder') {
    const holder = result.code === 0 ? checkedOutAt(result.stdout, laneBranch(state, wp)) : `unknown: git worktree list failed: ${said(result)}`;
    if (!holder) return proceed();
    const why = `checked out at ${holder}`;
    return proceed({ lane: { branchDeleted: { local: 'kept', remote: 'kept', localError: why, remoteError: why } },
      queue: rest.filter((queued) => !['branch', 'branch-remote'].includes(queued.part)) });
  }
  if (action.part === 'branch' || action.part === 'branch-remote') {
    const where = action.part === 'branch' ? 'local' : 'remote';
    const outcome = branchOutcome(result);
    return proceed({ lane: { branchDeleted: { ...(wp.lane?.branchDeleted ?? {}), [where]: outcome, ...(outcome === 'kept' ? { [`${where}Error`]: said(result) } : {}) } } });
  }
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
  const claims = reportPrClaims(readLog(deps, lane.reportPath));
  if (!claims.some((claimed) => claimed.number === found.number && claimed.head && found.head?.startsWith(claimed.head))) {
    const said = claims.map((claimed) => `${claimed.from} says #${claimed.number ?? '?'} at ${claimed.head ?? '?'}`).join('; ');
    return amend(`the report's ${said}; GitHub has #${found.number} at ${found.head}`, { pr: found });
  }
  return proceed({ pr: found });
}

const SUB_FLAGS = { spawn: ['amend'], alive: [], check: ['pr', 'runtimeOnly'], reap: [], 'stop-check': [], hook: [] };
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
  if (sub === 'stop-check') return stopCheckLane(current, wp, hookInput(deps), deps);
  if (sub === 'hook') return hookLane(current, wp, deps);
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
    // From the last land rebase's new base: the lane's own commits, not a sibling's merged ones.
    const base = laneBase(wp);
    const ahead = deps.exec('git', ['-C', wp.lane?.worktree ?? lane.worktree, 'rev-list', '--count', `${base}..HEAD`]);
    if (ahead.code !== 0 || !(Number(ahead.stdout.trim()) >= 1)) failures.push(`the branch has no commit past base ${base} (${ahead.code === 0 ? `${ahead.stdout.trim()} commits` : said(ahead)})`);
    // The lane contract's evidence rules, against the report and the lane's diff.
    const diff = deps.exec('git', ['-C', wp.lane?.worktree ?? lane.worktree, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--no-renames', `${base}...HEAD`]);
    if (diff.code !== 0) failures.push(`the evidence checks did not run: git diff from base ${base}: ${said(diff)}`);
    failures.push(...reportEvidenceProblems(text, { diff: diff.code === 0 ? diff.stdout : null, reportPath: lane.reportPath, exists: deps.exists,
      readSource: (_file, blob) => { if (!blob) return null; const source = deps.exec('git', ['-C', wp.lane?.worktree ?? lane.worktree, 'show', blob]); return source.code === 0 ? source.stdout : null; } }));
    if (flags.pr !== undefined) {
      if (!/^\d+$/.test(String(flags.pr))) return reply(2, { ok: false, error: `--pr needs a PR number, got ${flags.pr}` });
      const view = deps.exec('gh', ['pr', 'view', String(flags.pr), '--repo', state.intent.repo.remote, '--json', 'headRefName,state,body']);
      const pr = view.code === 0 ? parseStdout(view) : null;
      if (!pr) failures.push(`gh pr view ${flags.pr}: ${said(view)}`);
      else {
        if (pr.headRefName !== (wp.lane?.branch ?? lane.branch)) failures.push(`PR #${flags.pr} head is ${pr.headRefName}, not ${wp.lane?.branch ?? lane.branch}`);
        if (pr.state !== 'OPEN' && pr.state !== 'MERGED') failures.push(`PR #${flags.pr} is ${pr.state}`);
        failures.push(...[...reportShapeProblems(pr.body ?? ''), ...mergeDanger(pr.body ?? '').problems].map((p) => `PR body: ${p}`));
      }
    }
  }
  return reply(failures.length ? 5 : 0, { ok: !failures.length, outcome, verdict, failures, asks });
}

// A T3 claude lane's settings: T3 starts the agent, so no --settings flag can
// carry the Stop hook and the lane marker. They go in the worktree's
// .claude/settings.local.json, which the agent loads, and that file goes in
// the repo's info/exclude so no lane commits it and `git worktree remove`
// still sees a clean tree. An existing file keeps its other keys.
const LANE_SETTINGS = '.claude/settings.local.json';

function hookLane(state, wp, deps) {
  const worktree = wp.lane?.worktree ?? laneLayout(state, wp).worktree;
  if (!deps.exists(worktree)) return reply(1, { ok: false, error: `the lane worktree ${worktree} does not exist` });
  const path = join(worktree, ...LANE_SETTINGS.split('/'));
  let settings = {};
  try {
    if (deps.exists(path)) settings = JSON.parse(deps.read(path));
  } catch (error) {
    return reply(1, { ok: false, error: `${path} is not JSON: ${error.message}` });
  }
  const command = stopHookCommand(state, wp, deps);
  const ours = (entry) => (entry?.hooks ?? []).some((hook) => hook?.command === command);
  settings.env = { ...(settings.env ?? {}), [LANE_MARKER_ENV]: laneLayout(state, wp).name };
  settings.hooks = { ...(settings.hooks ?? {}), Stop: [...(settings.hooks?.Stop ?? []).filter((entry) => !ours(entry)), ...stopHookSettings(command).hooks.Stop] };
  deps.mkdir(dirname(path));
  deps.write(path, `${JSON.stringify(settings, null, 2)}\n`);
  const gitPath = deps.exec('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude']);
  if (gitPath.code !== 0) return reply(1, { ok: false, error: `git rev-parse --git-path info/exclude: ${said(gitPath)}`, path });
  const exclude = resolve(worktree, gitPath.stdout.trim());
  const line = `/${LANE_SETTINGS}`;
  const current = deps.exists(exclude) ? deps.read(exclude) : '';
  if (!current.split(/\r?\n/).includes(line)) {
    deps.mkdir(dirname(exclude));
    deps.write(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  return reply(0, { ok: true, path, exclude });
}

// The Stop hook's input (Claude Code writes it on stdin); {} when unreadable.
function hookInput(deps) {
  try {
    const parsed = JSON.parse(deps.readStdin?.() ?? '');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The in-lane stop-check, run by a claude lane's Stop hook each time the agent
// tries to end its turn. It runs the conductor's own report, PR-lookup and PR
// checks, read-only, and sorts the results with the same recorders. An amend
// (a failure the conductor would send back as a re-prompt round) blocks the
// stop with the conductor's reason, at most STOP_CHECK_BLOCKS times per session
// and amendment round, then the lane stops with verdict `failed`. Refuted,
// needs-conductor and infrastructure failures are the conductor's to route:
// the lane stops (`released`). A stop with a background task running is never
// blocked (`background-live`; the herdr wait holds on it). Every call writes the
// lane's verdict file; nothing writes state.json.
function stopCheckLane(state, wp, input, deps) {
  const lane = laneLayout(state, wp);
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
  const round = wp.amendment?.n ?? 0;
  const prior = readStopCheck(deps, lane.stopCheckPath);
  const blocks = prior && prior.sessionId === sessionId && prior.round === round ? prior.blocks ?? 0 : 0;
  const settle = (fields, block = false) => {
    const record = { sessionId, round, blocks, at: deps.timestamp(), ...fields };
    deps.write(lane.stopCheckPath, `${JSON.stringify(record, null, 2)}\n`);
    return reply(0, { ok: true, block, ...record });
  };
  const tasks = (Array.isArray(input.background_tasks) ? input.background_tasks : []).filter((task) => task?.status === 'running');
  if (tasks.length) return settle({ verdict: 'background-live', tasks: tasks.map(({ id, type, command }) => ({ id, type, command })) });
  const finding = stopFinding(state, wp, lane, deps);
  if (finding.outcome === 'continue') return settle({ verdict: 'pass' });
  if (finding.outcome !== 'amend') return settle({ verdict: 'released', reason: finding.reason });
  if (blocks >= STOP_CHECK_BLOCKS) return settle({ verdict: 'failed', reason: finding.reason });
  const n = blocks + 1;
  return settle({
    verdict: 'blocked', blocks: n, reason: finding.reason,
    instruction: `Not done yet: the conductor's check would send this lane back (stop-check ${n} of ${STOP_CHECK_BLOCKS}). What it found: ${finding.reason}\nFix that, update your report and your PR, then end your turn again.`,
  }, true);
}

// The conductor's checks in its order (outcome first), stopping at the first
// outcome that is not `continue`.
function stopFinding(state, wp, lane, deps) {
  const noStop = { stop: () => [] };
  const asResult = ({ code, out }) => ({ code, stdout: out, stderr: '' });
  const report = recordCheck(wp, { part: 'report' }, asResult(checkLane(state, wp, {}, deps)), noStop);
  if (report.outcome !== 'continue') return report;
  const listed = deps.exec('gh', ['pr', 'list', '--repo', state.intent.repo.remote, '--head', wp.lane?.branch ?? lane.branch, '--state', 'all', '--json', 'number,headRefOid,state']);
  const lookup = recordPrLookup(wp, lane, listed, deps);
  if (lookup.outcome !== 'continue') return lookup;
  return recordCheck(wp, { part: 'pr' }, asResult(checkLane(state, wp, { pr: String(lookup.patch.pr.number) }, deps)), noStop);
}

function readStopCheck(deps, path) {
  try {
    if (!deps.exists(path)) return null;
    const record = JSON.parse(deps.read(path));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

// The verdict of the lane's latest stop, or null: none written, or one from an
// earlier start or amendment round.
function laneStopCheck(state, wp, deps) {
  const record = readStopCheck(deps, laneLayout(state, wp).stopCheckPath);
  if (!record || record.round !== (wp.amendment?.n ?? 0)) return null;
  const startedAt = Date.parse(wp.lane?.startedAt ?? '');
  if (Number.isFinite(startedAt) && !(Date.parse(record.at) >= startedAt)) return null;
  return record;
}

const stopCheckSummary = ({ verdict, blocks, reason, at }) => ({ verdict, blocks, at, ...(reason ? { reason } : {}) });
