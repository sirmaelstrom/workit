#!/usr/bin/env node
// The goal conductor's one-shot state machine. Every verb reads state.json,
// does one bounded thing, writes state, appends to events.jsonl and exits; the
// agent running the skill drives the loop: intake → [next → act → record]*.
// `next` never runs a program: it hands the agent an action to perform.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, readdirSync, rmSync, linkSync, truncateSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { isatty } from 'node:tty';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute, runArgv, windowsShim, spawnDetached, pidAlive, defaultCodexExe } from './lib/exec.mjs';
import {
  ConductError, SCHEMA_VERSION, STEPS, STEP_SEAM, TERMINAL_PHASES,
  appendEvent, breakLockHint, liveLock, loadState, refuseRetired, resolveRunDir, saveState, slugify, statePath, withStateLock,
} from './lib/state.mjs';
import { ADAPTERS, AGENTS, BACKENDS, DECLARED_ADAPTERS, detectAdapters, firstLine } from './lib/adapters.mjs';
import { resolveRecipe, validateRecipe } from './lib/recipe.mjs';
import { resolveRepoConfig } from './lib/repo-config.mjs';
import { MAX_LANES } from './lib/schedule.mjs';
import { QUESTION_MAX, acceptAnswer, dropRetiredFiling, recordSupersede, resumeHandBack, supersedeAction, touchStep, writeTouchFiles } from './lib/touch.mjs';
import { custodyFence, custodyNext, openRotation, recordCustody, rotate, rotatedOut } from './lib/rotate.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
// The directory holding skills/ and scripts/. Computed here and only here;
// every lib/ module receives it as deps.pluginRoot.
const PLUGIN_ROOT = resolve(SCRIPTS_DIR, '../../..');

const USAGE = `usage: conduct.mjs <verb> [flags]
  intake --goal <text> --repo <abs> --backend t3|herdr|exec [--t3-project <id>] [--backend-why <text>]
         [--anchor <quest id>] [--budget <usd>] [--lanes 1-4] [--agent claude|codex]
         [--adapter <name>]... [--no-adapter <name>]... [--release <json file>] [--runs-root <dir>]
  next --run <dir> [--custody <n>] (also: next --resume <dir>, or conduct.mjs --resume <dir>)
  record --run <dir> --action <id> (--result <json> | --result-file <path>) [--manual] [--replan <json file>]
  answer --run <dir> --touch <n> --key <a..f> [--text <text>]
  drive --run <dir> [--max-steps <n>]   (perform shell, wait and template author actions; stop at the first that needs the conductor)
  drive --run <dir> --break-lock --why <text>   (remove another host's drive.lock, or a dead driver's on this host)
  status --run <dir>
  analyze --run <dir>
  ratify --run <dir> --wp <id> --paths <path,path> --why <text>
  reset-wp --run <dir> --wp <id> --to check|checked|prompt|wait|land|setup|pending|delta [--baseline <sha>] --why <text>
  ci-checks --run <dir> --wp <id> --head <sha> --checks <name,name> --why <text>
  replan --run <dir> --plan <json file>
  upgrade-root --run <dir> --why <text> (invoke from destination root at an author/wait action)
  rotate --run <dir> --why <text> [--model <id> --effort <level>] [--name <successor>]
  lane <spawn|alive|check|reap|stop-check|hook> --run <dir> --wp <id> [sub-verb flags]
  land <gate|merged> --run <dir> --wp <id|release> [sub-verb flags]
  quiet [--samples <n>] [--interval-ms <ms>] [--max-busy <percent>]   (no run: is this host's CPU quiet enough to re-run a gate)
  bootstrap --repo <abs> [--write] [--offline]   (no run: check a repo against the greenfield manifest)`;

const BOOLEAN_FLAGS = new Set(['manual', 'write', 'offline', 'break-lock']);
const REPEATED_FLAGS = new Set(['adapter', 'no-adapter']);
// These always take the next token as their value, even one that starts with
// `--` (an operator's `--text "--skip release"`).
const VALUE_FLAGS = new Set(['goal', 'repo', 'backend', 'backend-why', 't3-project', 'anchor', 'budget', 'lanes', 'agent', 'adapter', 'no-adapter', 'release',
  'runs-root', 'run', 'resume', 'action', 'max-steps', 'result', 'result-file', 'touch', 'key', 'text', 'wp', 'paths', 'why', 'to', 'baseline', 'head', 'checks', 'model', 'effort', 'name', 'custody', 'plan', 'replan']);

function parseFlags(tokens) {
  const flags = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) throw new ConductError(2, `unexpected argument: ${token}`);
    const name = token.slice(2);
    const following = tokens[i + 1];
    let value = true;
    if (!BOOLEAN_FLAGS.has(name) && following !== undefined && (VALUE_FLAGS.has(name) || !following.startsWith('--'))) {
      value = following;
      i += 1;
    }
    if (REPEATED_FLAGS.has(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return flags;
}

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function stringFlag(flags, name) {
  if (typeof flags[name] !== 'string' || !flags[name].trim()) throw new ConductError(2, `--${name} <value> is required`);
  return flags[name];
}

async function loadModule(deps, relPath, what) {
  try {
    return await deps.importModule(relPath);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new ConductError(4, `${what} missing: ${relPath} (${error.message})`);
    throw error;
  }
}

function runDirFlag(flags) {
  return resolve(stringFlag(flags, flags.run === undefined && flags.resume !== undefined ? 'resume' : 'run'));
}

function openRun(flags, deps) {
  const runDir = runDirFlag(flags);
  const state = loadState(runDir, deps);
  if (state.handover && deps.pluginRoot !== state.pluginRoot) {
    throw new ConductError(2, `this run moved to the plugin root ${state.pluginRoot}; re-run the verb with that root's skills/conduct/scripts/conduct.mjs`);
  }
  return { runDir, state };
}

// A state.json names the run dir it was made in, and its pending argv and
// paths point there: a copied run dir still names the original. drive and
// record act only on the run --run names, so a copy is refused before
// anything runs or is written. Paths compare by realpath, so a junction, a
// symlink or a \\?\ path to the run is the run, then case-folded on win32.
function refuseForeignState(runDir, state, deps) {
  if (typeof state.runDir !== 'string') return;
  if (!deps.exists(state.runDir)) throw new ConductError(2, `state.runDir ${state.runDir} does not exist (was this run moved?)`);
  const fold = (path) => (deps.platform === 'win32' ? deps.realpath(path).toLowerCase() : deps.realpath(path));
  if (fold(state.runDir) !== fold(runDir)) throw new ConductError(2, `this state belongs to ${state.runDir}; refusing to act on it from ${runDir}`);
}

// While a live driver holds drive.lock, the verbs that move the pending
// action or the plan are refused: the driver's next step would act on a run
// that moved under it. The driver's own in-process calls carry its token. A
// shell action that is itself a conduct.mjs verb (lane, land, analyze) is
// not one of these and runs.
function refuseWhileDriven(runDir, deps, verb) {
  const holder = liveLock(runDir, 'drive.lock', deps);
  if (!holder || (deps.driveToken && holder.token === deps.driveToken)) return;
  if (holder.unreadable) throw new ConductError(5, `${verb}: ${holder.path} is unreadable; remove it if no drive is running, then retry`);
  throw new ConductError(5, `${verb}: a drive holds this run (pid ${holder.pid} on ${holder.host} since ${holder.at}${holder.action ? `, executing ${holder.action}` : ''}); wait for it to stop, or stop it, then retry${breakLockHint(runDir, 'drive.lock', holder, deps)}`);
}

// A state transaction: load, change and save under the run's lock. While a
// rotation is open only custody moves the run: every other writer is refused
// unless it is one of next, record (custody steps only), answer (the
// operator's) or rotate (which names the open rotation itself). `driven`
// names a verb refused while a drive runs.
function transact(flags, deps, fn, { duringRotation = false, driven = null } = {}) {
  return withStateLock(runDirFlag(flags), deps, () => {
    const { state } = openRun(flags, deps);
    refuseRetired(state);
    if (driven) refuseWhileDriven(runDirFlag(flags), deps, driven);
    const rotation = duringRotation ? null : openRotation(state);
    if (rotation) throw new ConductError(5, `rotation ${rotation.attempt} is open: custody comes first (next), and nothing else changes the run until it is taken or cancelled`);
    return fn(state);
  });
}

function stamp(state, spec) {
  if (!STEPS.includes(spec.step)) throw new ConductError(2, `action step ${spec.step} is not in STEPS`);
  state.seq += 1;
  return { id: `${state.seq}-${spec.step}`, phase: state.phase, ...spec, seam: spec.seam !== undefined ? spec.seam : STEP_SEAM[spec.step] };
}

// The pending action, or the current phase's next one. A handler that changes
// the phase without an action hands over to the next phase's handler. An open
// rotation's custody steps (lib/rotate.mjs) come before either; the pending
// action stays where it is and is emitted again once custody is taken.
async function emit(state, deps, { custody = null } = {}) {
  const rotation = openRotation(state);
  if (rotation) {
    const spec = custodyNext(state, rotation, deps, { custody });
    if (spec && spec !== rotation.action) {
      rotation.action = stamp(state, spec);
      appendEvent(state, deps, { actionId: rotation.action.id, step: spec.step, seam: rotation.action.seam, kind: spec.kind, event: 'emitted' });
    }
    saveState(state, deps);
    if (spec) return rotation.action;
  }
  dropRetiredFiling(state, deps);
  if (state.pending) {
    // The build watches for stalls even while an action is pending.
    const phase = state.phase === 'build' ? await loadModule(deps, 'lib/phases/build.mjs', 'phase handler build') : null;
    if (phase?.observePending) { phase.observePending(state, deps); saveState(state, deps); }
    return state.pending;
  }
  // A filed touch's answer is receipted on the anchor before anything else,
  // in any phase (a closing answer too), so its needs_input stops blocking.
  // The phase settles the answer first, so the receipt says where it left the run.
  if (supersedeAction(state) && !TERMINAL_PHASES.includes(state.phase)) {
    const handler = await loadModule(deps, `lib/phases/${state.phase}.mjs`, `phase handler ${state.phase}`);
    handler.settle?.(state, deps);
  }
  const supersede = supersedeAction(state);
  if (supersede) {
    const action = stamp(state, supersede);
    state.pending = action;
    appendEvent(state, deps, { actionId: action.id, step: action.step, seam: action.seam, kind: action.kind, event: 'emitted' });
    saveState(state, deps);
    return action;
  }
  for (let hop = 0; hop < 8; hop += 1) {
    if (TERMINAL_PHASES.includes(state.phase)) return { kind: 'done', phase: state.phase };
    const handler = await loadModule(deps, `lib/phases/${state.phase}.mjs`, `phase handler ${state.phase}`);
    const before = state.phase;
    const spec = await handler.next(state, deps);
    if (spec?.kind === 'done') {
      saveState(state, deps);
      return { ...spec, phase: state.phase };
    }
    if (spec) {
      const action = stamp(state, spec);
      state.pending = action;
      appendEvent(state, deps, { actionId: action.id, step: action.step, seam: action.seam, kind: action.kind, event: 'emitted' });
      saveState(state, deps);
      return action;
    }
    if (state.phase === before) throw new ConductError(2, `phase ${before} has no action to emit`);
    appendEvent(state, deps, { step: STEPS.includes(before) ? before : null, event: 'phase', phase: before, data: { from: before, to: state.phase } });
    saveState(state, deps);
  }
  throw new ConductError(2, 'phase handlers did not settle on an action');
}

// After a durable record, every failure says so: `recorded` tells the driver
// the record landed, and the next `next` (or a replay of it) re-emits.
async function emitAfterRecord(state, deps, id) {
  try {
    return await emit(state, deps);
  } catch (error) {
    const recorded = error instanceof ConductError ? error : new ConductError(1, `after recording ${id}: ${error.message}`, { cause: error });
    recorded.details = { ...(recorded.details ?? {}), recorded: id };
    throw recorded;
  }
}

function parseGitHubRemote(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// A URL's userinfo (a token or password) never reaches a refusal message.
function redactUrl(url) {
  return url.trim().replace(/\/\/[^@/\s]+@/, '//<redacted>@');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Workflows that can gate a PR: active, and defined in the repo. Dynamic
// workflows (Dependabot, CodeQL default setup, pages) are not counted. The
// listing is every page (`--paginate`), one workflow object per line.
function gatingWorkflows(stdout) {
  const workflows = stdout.split('\n').filter((line) => line.trim()).map(parseJson);
  if (workflows.some((workflow) => !workflow)) return null;
  return workflows.filter((workflow) => workflow.state === 'active' && String(workflow.path).startsWith('.github/workflows/')).length;
}

function intakeOptions(flags) {
  const goal = stringFlag(flags, 'goal');
  const forcedOff = flags['no-adapter'] ?? [];
  const declared = flags.adapter ?? [];
  for (const name of forcedOff) {
    if (AGENTS.includes(name)) throw new ConductError(2, `--no-adapter ${name}: ${name} is a lane agent CLI, not an adapter`);
    if (!ADAPTERS.includes(name)) throw new ConductError(2, `--no-adapter ${name}: unknown adapter (one of ${ADAPTERS.join(', ')})`);
  }
  for (const name of declared) {
    if (!DECLARED_ADAPTERS.includes(name)) throw new ConductError(2, `--adapter ${name}: only ${DECLARED_ADAPTERS.join(', ')} are declared; the rest are probed`);
  }
  const budgetUsd = flags.budget === undefined ? 25 : Number(flags.budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new ConductError(2, '--budget must be a positive number of USD');
  const lanesCap = flags.lanes === undefined ? 2 : Number(flags.lanes);
  if (!Number.isInteger(lanesCap) || lanesCap < 1 || lanesCap > MAX_LANES) throw new ConductError(2, `--lanes must be 1 to ${MAX_LANES}`);
  if (flags.agent !== undefined && !AGENTS.includes(flags.agent)) throw new ConductError(2, `--agent must be one of ${AGENTS.join(', ')}`);
  const spine = declared.includes('spine') && !forcedOff.includes('spine');
  const backend = flags.backend === undefined ? null : flags.backend;
  if (backend !== null && !BACKENDS.includes(backend)) throw new ConductError(2, `--backend must be one of ${BACKENDS.join(', ')}`);
  const t3Project = typeof flags['t3-project'] === 'string' ? flags['t3-project'].trim() : null;
  if (flags['t3-project'] !== undefined && backend !== 't3') throw new ConductError(2, '--t3-project belongs to --backend t3');
  const backendWhy = typeof flags['backend-why'] === 'string' ? flags['backend-why'].trim() : null;
  return { goal, forcedOff, declared, budgetUsd, lanesCap, spine, backend, t3Project, backendWhy };
}

// Where the lanes run is the conductor's choice, stated at intake: nothing is
// probed into it. t3 (the default for a conductor in T3 Code) needs the T3
// project whose workspace root is the repo; herdr needs a stated reason.
function laneBackendChoice(options, refuse) {
  const { backend, t3Project, backendWhy } = options;
  if (backend === null) {
    refuse(9, `choose where the lanes run: --backend t3 --t3-project <id> (T3 Code threads; t3_project_list gives the id of the project rooted at --repo), --backend herdr --backend-why "<the reason T3 won't do>", or --backend exec (headless, nothing to watch)`);
  }
  if (backend === 't3' && !t3Project) refuse(9, '--backend t3 needs --t3-project <id>: the T3 project whose workspace root is --repo (t3_project_list)');
  if (backend === 'herdr' && !backendWhy) refuse(9, '--backend herdr needs --backend-why "<the reason T3 won\'t do>": T3 is the default substrate for lanes');
  return { name: backend, ...(t3Project ? { t3Project } : {}), ...(backendWhy ? { why: backendWhy } : {}) };
}

// Refusals 1–3 and 5–7 of D1. Every one exits 2 before anything is written.
async function intake(tokens, deps) {
  const flags = parseFlags(tokens);
  const options = intakeOptions(flags);
  const refuse = (n, reason) => { throw new ConductError(2, `refusal ${n}: ${reason}`); };
  if (typeof flags.repo !== 'string') refuse(1, '--repo <abs path to a git checkout> is required');
  const inside = deps.exec('git', ['-C', resolve(flags.repo), 'rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') refuse(1, `${resolve(flags.repo)} is not a git work tree`);
  // The repo is its work tree's root, wherever inside it --repo points.
  const top = deps.exec('git', ['-C', resolve(flags.repo), 'rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) refuse(1, `${resolve(flags.repo)} has no work-tree root`);
  const repoPath = resolve(top.stdout.trim());
  if (options.spine && !/^[0-9a-f]{8}[0-9a-f-]*$/i.test(typeof flags.anchor === 'string' ? flags.anchor : '')) {
    refuse(7, '--adapter spine needs --anchor <quest id> (a uuid or a prefix of at least 8 hex characters): the touches need a quest to carry them');
  }
  // The raw origin URL, before any insteadOf rewrite.
  const origin = deps.exec('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url']);
  if (origin.code !== 0 || !origin.stdout.trim()) refuse(2, `${repoPath} has no origin remote`);
  const ownerName = parseGitHubRemote(origin.stdout);
  if (!ownerName) refuse(2, `origin ${redactUrl(origin.stdout)} is not a GitHub remote`);
  const auth = deps.exec('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (auth.code !== 0) refuse(3, `gh auth status --hostname github.com failed: ${firstLine(auth.stderr || auth.stdout)}`);
  const view = deps.exec('gh', ['repo', 'view', ownerName, '--json', 'nameWithOwner,defaultBranchRef']);
  if (view.code !== 0) refuse(2, `gh cannot resolve ${ownerName}: ${firstLine(view.stderr)}`);
  const repoInfo = parseJson(view.stdout);
  if (typeof repoInfo?.nameWithOwner !== 'string') refuse(2, `gh repo view ${ownerName} printed no nameWithOwner`);
  const remote = repoInfo.nameWithOwner;
  // A failed or unreadable workflow count is stored as null and treated as zero.
  const workflows = deps.exec('gh', ['api', '--paginate', `repos/${remote}/actions/workflows`, '--jq', '.workflows[]']);
  const ciWorkflows = workflows.code === 0 ? gatingWorkflows(workflows.stdout) : null;
  const ciError = workflows.code !== 0 ? workflows.stderr : ciWorkflows === null ? 'a workflows listing line is not JSON' : null;
  // The greenfield trigger (quest 977d3efb, answer (c)): no CI workflow, or a
  // near-empty history. Mint binds the bootstrap manifest to WP-01 when on.
  // A shallow clone's count is not its history (council review 1): only a
  // checkout git reports as not shallow is counted; anything else is unread.
  const shallow = deps.exec('git', ['-C', repoPath, 'rev-parse', '--is-shallow-repository']);
  const count = shallow.code === 0 && shallow.stdout.trim() === 'false' ? deps.exec('git', ['-C', repoPath, 'rev-list', '--count', 'HEAD']) : null;
  const commits = count?.code === 0 && /^\d+$/.test(count.stdout.trim()) ? Number(count.stdout.trim()) : null;
  const { detectGreenfield } = await loadModule(deps, 'lib/bootstrap.mjs', 'module');
  const greenfield = detectGreenfield({ ciWorkflows, commits });
  const backend = laneBackendChoice(options, refuse);
  // herdr is asked only when it was chosen; a chosen herdr that doesn't answer is refused.
  const { adapters, agents } = detectAdapters({
    env: deps.env, exec: deps.exec, exists: deps.exists, declared: options.declared,
    forcedOff: backend.name === 'herdr' ? options.forcedOff : [...new Set([...options.forcedOff, 'herdr'])],
    platform: deps.platform, resolveCodex: deps.resolveCodex,
  });
  if (backend.name !== 'herdr' && !options.forcedOff.includes('herdr')) adapters.herdr = { on: false, evidence: 'chosen', detail: `lanes run on ${backend.name} (--backend)` };
  if (backend.name === 'herdr' && !adapters.herdr.on) refuse(9, `--backend herdr, but ${adapters.herdr.detail}`);
  // A T3 lane runs in T3's own provider, so no agent CLI need be on PATH.
  if (backend.name !== 't3' && flags.agent !== undefined && !agents[flags.agent].on) refuse(5, `--agent ${flags.agent} is not available: ${agents[flags.agent].detail}`);
  const agent = backend.name === 't3' ? flags.agent ?? 'claude' : flags.agent ?? AGENTS.find((name) => agents[name].on);
  if (!agent) refuse(5, `no lane agent CLI on PATH (${AGENTS.map((name) => `${name}: ${agents[name].detail}`).join('; ')})`);
  // The workspace config is read once here and pinned (lib/repo-config.mjs).
  const repoConfig = resolveRepoConfig({ remote, repoPath, env: deps.env, exists: deps.exists, read: deps.read });
  const recipe = resolveRecipe({ flagPath: typeof flags.release === 'string' ? resolve(flags.release) : null, repoPath, read: deps.read, repoConfig });
  if (recipe !== null) {
    const checked = validateRecipe(recipe);
    if (!checked.ok) throw new ConductError(2, `invalid release recipe: ${checked.problems.join('; ')}`);
  }
  const slug = slugify(options.goal);
  const { workshopDir, runDir } = resolveRunDir({
    repo: repoPath, slug, env: deps.env, runsRoot: typeof flags['runs-root'] === 'string' ? flags['runs-root'] : null,
    exists: deps.exists, home: deps.home,
  });
  const refuseExisting = () => refuse(6, `a run already exists at ${runDir}; continue it with next --run ${runDir}`);
  if (deps.exists(statePath(runDir))) refuseExisting();

  const draft = () => ({
      schemaVersion: SCHEMA_VERSION, slug, runId: deps.newRunId(), createdAt: deps.timestamp(), runDir, workshopDir, pluginRoot: deps.pluginRoot,
      intent: {
        goal: options.goal, repo: { path: repoPath, remote, defaultBranch: repoInfo.defaultBranchRef?.name ?? null },
        anchor: typeof flags.anchor === 'string' ? flags.anchor : null, campaign: null,
        budgetUsd: options.budgetUsd, lanesCap: options.lanesCap, agent, backend, release: recipe, ciWorkflows, repoConfig, greenfield,
      },
      agents, adapters,
      phase: options.spine ? 'intake' : 'preapproval',
      authority: { merge: false, release: false, budgetUsd: 0, scope: options.goal, notes: null, grant: null },
      touches: [],
      spec: { depth: null, reviewLevel: null, gate: null, gateCommand: null },
      wps: [],
      release: { state: 'pending', reason: null, base: null, worktree: null, branch: null, pr: null, gate: null, merge: null },
      mergeLock: null, dispatchHalt: null, handover: null, sentBack: null, pending: null, lastRecorded: null, seq: 0, rev: 0, txns: [],
  });
  // Touch 1 is filed through spine_receipt, which refuses a question over its
  // cap; the run would be stuck at touch 1. Measured before anything is written.
  if (options.spine) {
    const preapproval = await loadModule(deps, 'lib/phases/preapproval.mjs', 'module');
    const projected = draft();
    const length = preapproval.touchOneLength(projected, deps, { bound: true });
    if (length > QUESTION_MAX) {
      refuse(8, `touch 1's question would be ${length} chars, over spine_receipt's ${QUESTION_MAX}-char cap: shorten the release recipe, the repo path${repoConfig.source === 'workspace' ? ' or the workspace config path' : ''} (a long goal is already cited by file)`);
    }
  }

  deps.mkdir(runDir);
  return withStateLock(runDir, deps, async () => {
    if (deps.exists(statePath(runDir))) refuseExisting();
    const state = draft();
    // The goal in full: touch 1 cites it by this file when it is long.
    deps.write(join(runDir, 'goal.md'), `${options.goal}\n`);
    appendEvent(state, deps, { step: 'intake', event: 'intake', source: 'next', data: { remote, ciWorkflows, ciError, greenfield } });
    saveState(state, deps);
    return { out: { ok: true, runDir, action: await emit(state, deps) } };
  });
}

// `next` (and `--resume`) on a pending spine hand-back is the resume: the
// hand-back is consumed and the touch is asked again (or, answered from the
// operator's terminal meanwhile, receipted and acted on).
// `--custody <n>` is a rotated-in successor's first call: refused when
// rotation n was cancelled or superseded (lib/rotate.mjs custodyFence).
async function next(tokens, deps) {
  const flags = parseFlags(tokens);
  return transact(flags, deps, async (state) => {
    const custody = flags.custody === undefined ? null : String(flags.custody);
    if (custody !== null) custodyFence(state, custody);
    if (state.pending?.handBack) resumeHandBack(state, deps);
    return { out: { ok: true, action: await emit(state, deps, { custody }) } };
  }, { duringRotation: true, driven: 'next' });
}

function readResult(flags, deps) {
  let text;
  if (typeof flags.result === 'string') text = flags.result;
  else if (typeof flags['result-file'] === 'string') {
    const path = resolve(flags['result-file']);
    try {
      text = deps.read(path);
    } catch (error) {
      throw new ConductError(2, `cannot read --result-file ${path}: ${error.message}`);
    }
  } else throw new ConductError(2, '--result <json> or --result-file <path> is required');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConductError(2, `the result is not valid JSON: ${error.message}`);
  }
}

function checkShellResult(action, result) {
  if (typeof result?.code !== 'number') throw new ConductError(2, `a shell result is { code, stdout, stderr } with a numeric code (action ${action.id})`);
  if (action.expects?.type === 'exit0' && result.code !== 0) throw new ConductError(2, `action ${action.id} expects exit 0, got ${result.code}`);
  if (action.expects?.type === 'json') {
    try {
      JSON.parse(result.stdout);
    } catch (error) {
      throw new ConductError(2, `action ${action.id} expects JSON on stdout: ${error.message}`);
    }
  }
}

// A tool's raw result is never `{}` or null: those mean the result was never
// captured (a result-file write that failed beside its record). Refused, so
// the action stays pending and is recorded again. A text result (ledger_write
// answers "Event written …") is a real result and passes.
function checkToolResult(action, result) {
  if (result === null || (typeof result === 'object' && !Array.isArray(result) && !Object.keys(result).length)) {
    throw new ConductError(2, `a tool result is ${action.tool}'s raw JSON object, not ${JSON.stringify(result)} (action ${action.id}): the result was not captured. Nothing was recorded; record the tool's raw result again`);
  }
}

// `record --replan <file>`: the re-plan is filed after the record and before
// anything is emitted, so a WP's final result can drop the WP its record would
// otherwise dispatch (quest 4e7311a7). The plan's shape, the build phase and
// the action's kind are checked before the record. A refusal that rests on
// state the record changed comes after it: the record stands, the output
// carries `recorded`, nothing is emitted, and `replan` is open at an empty
// pending. A replay files nothing: it returns the re-plan this record filed,
// if any, and re-emits as any replay does.
async function readReplanPlan(flags, deps) {
  const path = stringFlag(flags, 'replan');
  let plan;
  try {
    plan = JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `record: --replan ${path} is not a readable JSON file: ${error.message}`);
  }
  const module = await loadModule(deps, 'lib/phases/build.mjs', 'module');
  module.replanShape(plan);
  return { plan, module };
}

function fileReplan(state, deps, id, replan) {
  try {
    const out = replan.module.replan(state, replan.plan, deps, { record: id });
    saveState(state, deps);
    return out;
  } catch (error) {
    const known = error instanceof ConductError;
    const refused = new ConductError(known ? 5 : 1, `recorded ${id}; ${known ? 'the re-plan was refused' : 'filing the re-plan failed'}: ${error.message}. Nothing was emitted, so no action is pending: fix the plan and run replan, then next.`, { cause: error });
    refused.details = { recorded: id };
    throw refused;
  }
}

// The re-plan a record filed, as `record --replan` reported it.
function filedBy(state, id) {
  const row = (state.replans ?? []).find((entry) => entry.record === id);
  return row ? { n: row.n, mode: row.mode, ...(row.touch ? { touch: row.touch } : {}), file: join(state.runDir, row.file) } : null;
}

async function record(tokens, deps) {
  const flags = parseFlags(tokens);
  return transact(flags, deps, async (state) => {
    refuseForeignState(runDirFlag(flags), state, deps);
    const id = stringFlag(flags, 'action');
    const wantsReplan = flags.replan !== undefined;
    // A replay of the last record changes nothing and re-emits the next action.
    // From the rotated-out conductor's pane it is refused: its re-emit would
    // cancel the open rotation, and a replay must not change custody.
    if (id === state.lastRecorded && rotatedOut(state, deps)) throw new ConductError(5, `rotation ${openRotation(state).attempt} is open: a replay changes nothing; cancel it with next from your own pane, or end your turn`);
    if (id === state.lastRecorded) {
      // A replay with --replan files nothing (a lost response is retried here): it reports the re-plan this record filed.
      const filed = wantsReplan ? filedBy(state, id) : null;
      if (wantsReplan && !filed) throw new ConductError(5, `action ${id} is already recorded and filed no re-plan; a replay files none. Run replan --plan <file> at a wait, then next`);
      return { out: { ok: true, phase: state.phase, action: await emitAfterRecord(state, deps, id), noop: true, ...(filed ? { replan: filed } : {}) } };
    }
    if (wantsReplan && openRotation(state)) throw new ConductError(5, `rotation ${openRotation(state).attempt} is open: custody comes first; re-plan after it is taken`);
    // Checked before anything is recorded: a re-plan is made mid-build, and a touch's record is no WP's result.
    if (wantsReplan && state.phase !== 'build') throw new ConductError(5, `record --replan: the run is in phase ${state.phase}; a re-plan is made mid-build. Nothing was recorded`);
    if (wantsReplan && state.pending?.id === id && (state.pending.kind === 'touch' || state.pending.touch)) throw new ConductError(5, `record --replan: action ${id} is a touch's step, not a WP's result. Nothing was recorded; record it without --replan`);
    const replan = wantsReplan ? await readReplanPlan(flags, deps) : null;
    // While a rotation is open only its custody step can be recorded.
    const rotation = openRotation(state);
    if (rotation) {
      const step = rotation.action;
      if (rotatedOut(state, deps)) throw new ConductError(5, `rotation ${rotation.attempt} is open and you are r${rotation.from}, the conductor that rotated: only its successor records custody`);
      if (!step || step.id !== id) throw new ConductError(5, `action ${id} is not the pending action: custody of rotation ${rotation.attempt} comes first (${step ? `record ${step.id}` : 'run next'})`);
      recordCustody(state, rotation, step, readResult(flags, deps), deps);
      state.lastRecorded = id;
      appendEvent(state, deps, {
        actionId: id, step: step.step, seam: step.seam, kind: step.kind, event: 'recorded',
        source: flags.manual === true ? 'manual' : 'next', phase: step.phase, data: {},
      });
      saveState(state, deps);
      return { out: { ok: true, phase: state.phase, action: await emitAfterRecord(state, deps, id) } };
    }
    const action = state.pending;
    if (!action || action.id !== id) throw new ConductError(5, `action ${id} is not the pending action (${action?.id ?? 'none pending'})`);
    const result = readResult(flags, deps);
    if (action.kind === 'shell') checkShellResult(action, result);
    if (action.kind === 'agent-tool') checkToolResult(action, result);
    // A core touch the operator has not answered yet, or a spine hand-back,
    // stays pending: recording it does not mint a new action. A session ask
    // is recorded: its result is the operator's answer, or that none is here.
    if (action.kind === 'touch' && action.part !== 'ask' && state.touches[action.touch.n - 1]?.status !== 'answered') {
      return { out: { ok: true, phase: state.phase, action, answered: false } };
    }
    // A superseding receipt belongs to no phase: it may follow a closing answer.
    if (action.part === 'supersede') recordSupersede(state, action, result, deps);
    else await (await loadModule(deps, `lib/phases/${action.phase}.mjs`, `phase handler ${action.phase}`)).record(state, action, result, deps);
    state.pending = null;
    state.lastRecorded = id;
    appendEvent(state, deps, {
      actionId: id, step: action.step, seam: action.seam, kind: action.kind, event: 'recorded',
      source: flags.manual === true ? 'manual' : 'next', phase: action.phase,
      data: state.phase === action.phase ? {} : { phase: state.phase },
    });
    saveState(state, deps);
    const filed = replan ? fileReplan(state, deps, id, replan) : null;
    const next = await emitAfterRecord(state, deps, id);
    return { out: { ok: true, phase: state.phase, action: next, ...(filed ? { replan: filed } : {}) } };
  }, { duringRotation: true, driven: 'record' });
}

// An operator's answer to a touch: a core touch, or a spine touch filed as
// needs_input (its superseding receipt is then owed). stdinIsTTY comes from
// isatty(0) and no flag or env var sets it: a procedural approval boundary,
// not proof of the operator's identity (MN5).
async function answer(tokens, deps) {
  const flags = parseFlags(tokens);
  return transact(flags, deps, async (state) => {
    if (deps.stdinIsTTY !== true) throw new ConductError(3, 'stdin is not a TTY: the operator answers a touch from their own terminal');
    const touch = state.touches.find((candidate) => String(candidate.n) === String(flags.touch));
    if (!touch || !['open', 'filed'].includes(touch.status)) throw new ConductError(5, `no open touch ${flags.touch}`);
    touch.tty = true;
    acceptAnswer(state, touch, { key: flags.key, text: typeof flags.text === 'string' ? flags.text : null, by: 'operator:tty', answeredAt: deps.timestamp(), source: 'tty' });
    writeTouchFiles(state, touch, deps);
    appendEvent(state, deps, { step: touchStep(touch), kind: 'touch', event: 'answered', source: 'tty', data: { n: touch.n, key: touch.answer.key } });
    saveState(state, deps);
    return { out: { ok: true, touch } };
  }, { duringRotation: true });
}

// drive (lib/drive.mjs) reaches the run only through these verbs, in
// process: its pending action is next's, minus consuming a hand-back, and
// refused while a rotation is open; its results go through record. drive.lock
// keeps a second driver off the run, and the verbs that move the run off it
// while it runs (refuseWhileDriven); the driver's own calls carry its token.
// It is a lease, renewed while the drive runs; another host's is never taken
// over (lib/state.mjs DRIVE_LOCK), only broken by --break-lock.
// state.lock is taken per verb as always, so a shell action's own conduct.mjs
// verb can take it. Before each step, claim re-reads state.pending under
// state.lock and stamps drive.lock with the action id it is about to execute.
async function driveVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const runDir = runDirFlag(flags);
  if (flags['break-lock']) return breakDriveLock(runDir, flags, deps);
  const maxSteps = flags['max-steps'] === undefined ? undefined : Number(flags['max-steps']);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 0)) throw new ConductError(2, '--max-steps must be a whole number');
  refuseForeignState(runDir, openRun(flags, deps).state, deps);
  const { drive } = await loadModule(deps, 'lib/drive.mjs', 'module');
  const call = async (fn) => {
    try {
      const { code = 0, out } = await fn();
      return { code, out };
    } catch (error) {
      if (!(error instanceof ConductError)) throw error;
      return { code: error.code, out: { ok: false, error: error.message, ...(error.details ?? {}) } };
    }
  };
  const lockPath = join(runDir, 'drive.lock');
  return withStateLock(runDir, deps, ({ token }) => {
    const driver = { ...deps, driveToken: token };
    const claim = (id) => withStateLock(runDir, driver, () => {
      const found = loadState(runDir, driver).pending?.id ?? null;
      if (found === id) {
        const temp = `${lockPath}.${token}.claim.tmp`;
        driver.write(temp, JSON.stringify({ ...JSON.parse(driver.read(lockPath)), action: id }));
        driver.rename(temp, lockPath);
      }
      return { out: { ok: true, found } };
    });
    return drive({ runDir, maxSteps }, {
      ...driver,
      pending: () => call(() => transact({ run: runDir }, driver, async (state) => ({ out: { ok: true, action: await emit(state, driver) } }))),
      claim: (id) => call(() => claim(id)),
      record: (id, result) => call(() => record(['--run', runDir, '--action', id, '--result', JSON.stringify(result)], driver)),
    });
  }, { lock: 'drive.lock', lease: true });
}

// The conductor's removal of a drive.lock no driver will release: another
// host's, an unreadable one, or one whose pid on this host is dead. A live
// holder on this host is refused. The old holder and the why are logged as a
// drive-lock-broken event before the lock goes.
function breakDriveLock(runDir, flags, deps) {
  const why = stringFlag(flags, 'why');
  return withStateLock(runDir, deps, () => {
    const { state } = openRun(flags, deps);
    refuseForeignState(runDir, state, deps);
    const path = join(runDir, 'drive.lock');
    if (!deps.exists(path)) throw new ConductError(2, `--break-lock: no drive.lock in ${runDir}`);
    let holder;
    try {
      holder = JSON.parse(deps.read(path));
    } catch {
      holder = { unreadable: true };
    }
    if (holder.host === deps.hostname && deps.pidAlive(holder.pid)) {
      throw new ConductError(5, `--break-lock: drive.lock is held by pid ${holder.pid} on ${holder.host}, which is alive; stop that drive instead`);
    }
    appendEvent(state, deps, { event: 'drive-lock-broken', source: 'verb', data: { holder, why } });
    saveState(state, deps);
    deps.remove(path);
    return { out: { ok: true, broken: holder, why } };
  });
}

async function status(tokens, deps) {
  const { state } = openRun(parseFlags(tokens), deps);
  const lines = [
    `conduct ${state.slug}: phase ${state.phase}`,
    `repo: ${state.intent.repo.path} (${state.intent.repo.remote})`,
    `pending: ${state.pending ? `${state.pending.id} (${state.pending.kind}) ${state.pending.instruction ?? ''}` : 'none'}`,
    ...(openRotation(state) ? [`rotation ${openRotation(state).attempt} open: r${openRotation(state).from} → r${openRotation(state).to}, handoff ${openRotation(state).handoff}; custody comes first`] : []),
    ...state.touches.map((touch) => `touch ${touch.n} ${touch.kind}: ${touch.status}${touch.answer ? ` (${touch.answer.key} by ${touch.answer.by})` : ''}`),
    ...state.wps.map((wp) => `${wp.id} ${wp.state}${wp.questId ? ` quest ${wp.questId}` : ''}`),
  ];
  return { out: lines.join('\n') };
}

async function analyze(tokens, deps) {
  const { runDir } = openRun(parseFlags(tokens), deps);
  const module = await loadModule(deps, 'lib/analyze.mjs', 'module');
  // readEvents (lib/state.mjs) needs exists and read; the analysis reads events
  // through it.
  return { out: await module.analyzeRun(runDir, { exec: deps.exec, read: deps.read, write: deps.write, exists: deps.exists, now: deps.now }) };
}

// lane/land: conduct.mjs parses --run and --wp; every other flag reaches the
// sub-verb camelCased, and the sub-verb validates its own flags. A sub-verb
// in `writers` writes state: conduct.mjs runs it inside the run's lock and
// hands it the state loaded under that lock, which it saves with saveState.
// The others only read and print, and get no lock.
function subVerb(relPath, exportName, subs, writers = []) {
  return async ([sub, ...tokens], deps) => {
    if (!subs.includes(sub)) throw new ConductError(2, `sub-verb must be one of ${subs.join(', ')} (got ${sub ?? 'none'})`);
    const flags = parseFlags(tokens);
    const wpId = stringFlag(flags, 'wp');
    const rest = Object.fromEntries(Object.entries(flags).filter(([name]) => name !== 'run' && name !== 'wp').map(([name, value]) => [camelCase(name), value]));
    const call = async (runDir, state) => {
      const module = await loadModule(deps, relPath, 'module');
      return module[exportName](sub, { runDir, wpId, flags: rest, ...(state ? { state } : {}) }, deps);
    };
    if (writers.includes(sub)) return transact(flags, deps, (state) => call(runDirFlag(flags), state));
    return call(openRun(flags, deps).runDir);
  };
}

// The conductor extends a WP's Files with a ruling (lib/phases/build.mjs ratify).
async function ratifyVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const wpId = stringFlag(flags, 'wp');
  const paths = stringFlag(flags, 'paths').split(',').map((path) => path.trim()).filter(Boolean);
  const why = stringFlag(flags, 'why');
  return transact(flags, deps, async (state) => {
    const module = await loadModule(deps, 'lib/phases/build.mjs', 'module');
    const out = module.ratify(state, { wpId, paths, why }, deps);
    saveState(state, deps);
    return { out: { ok: true, ...out } };
  }, { driven: 'ratify' });
}

// The conductor puts a blocked or held WP back at a stage the build runs
// (lib/phases/build.mjs resetWp). Under the run's lock, after every check
// passes, the verb copies state.json to state.before-reset-<wp>-<time>.json
// beside it, then applies the reset and saves.
async function resetWpVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const wpId = stringFlag(flags, 'wp');
  const to = stringFlag(flags, 'to');
  const why = stringFlag(flags, 'why');
  const baseline = flags.baseline === undefined ? null : stringFlag(flags, 'baseline');
  return transact(flags, deps, async (state) => {
    const module = await loadModule(deps, 'lib/phases/build.mjs', 'module');
    const beforeChange = () => {
      const stampText = deps.timestamp().replace(/[:.]/g, '-');
      const path = join(state.runDir, `state.before-reset-${wpId.toLowerCase()}-${stampText}.json`);
      if (deps.exists(path)) throw new ConductError(2, `reset-wp: the snapshot ${path} already exists; retry`);
      deps.write(path, deps.read(statePath(state.runDir)));
      return path;
    };
    const out = module.resetWp(state, { wpId, to, why, baseline }, deps, { beforeChange });
    saveState(state, deps);
    return { out: { ok: true, ...out, next: `conduct.mjs next --run ${state.runDir}` } };
  }, { driven: 'reset-wp' });
}

// A mid-flight re-plan inside the pre-approval (lib/phases/build.mjs replan):
// two-way changes inside the approved scope proceed, recorded; anything wider
// halts dispatch on a touch whose options carry the delta-plan.
async function replanVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const path = stringFlag(flags, 'plan');
  return transact(flags, deps, async (state) => {
    let plan;
    try {
      plan = JSON.parse(deps.read(path));
    } catch (error) {
      throw new ConductError(2, `replan: --plan ${path} is not a readable JSON file: ${error.message}`);
    }
    const module = await loadModule(deps, 'lib/phases/build.mjs', 'module');
    const out = module.replan(state, plan, deps);
    saveState(state, deps);
    const then = out.mode === 'autonomous'
      ? 'Run next: its first action is applying this re-plan (ratify, reset-wp, a ruling), before any other build work.'
      : `Run next: touch ${out.touch} is open and dispatch halts until the operator answers.`;
    return { out: { ok: true, ...out, next: `conduct.mjs next --run ${state.runDir}`, then } };
  }, { driven: 'replan' });
}

async function ciChecksVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const wpId = stringFlag(flags, 'wp'), head = stringFlag(flags, 'head'), why = stringFlag(flags, 'why');
  const names = stringFlag(flags, 'checks').split(',').map((s) => s.trim());
  if (!/^[a-f0-9]{40}$/i.test(head) || names.some((name) => !name) || new Set(names).size !== names.length) throw new ConductError(2, 'ci-checks needs a full head SHA and distinct non-empty check names');
  return transact(flags, deps, (state) => {
    const wp = state.wps.find((item) => item.id.toLowerCase() === wpId.toLowerCase());
    if (!wp || wp.pr?.head !== head || !['blocked', 'held', 'gate', 'pr'].includes(wp.state)) throw new ConductError(5, 'ci-checks: WP must be at landing or held, with that recorded PR head');
    wp.ciCheckPolicy = { head, names, why, at: deps.timestamp() };
    appendEvent(state, deps, { event: 'ci-check-policy', data: { wpId: wp.id, ...wp.ciCheckPolicy } });
    saveState(state, deps);
    return { out: { ok: true, wpId: wp.id, policy: wp.ciCheckPolicy, next: 'Reset a blocked WP --to land to re-run its gate. Readable branch protection always takes precedence.' } };
  });
}

async function upgradeRootVerb(tokens, deps) {
  const flags = parseFlags(tokens), why = stringFlag(flags, 'why'), runDir = runDirFlag(flags);
  return withStateLock(runDir, deps, () => {
    const state = loadState(runDir, deps);
    // It rewrites the run's paths for a resume, so a run no resume can take is refused, not rewritten.
    refuseRetired(state);
    refuseWhileDriven(runDir, deps, 'upgrade-root');
    if (openRotation(state)) throw new ConductError(5, 'upgrade-root: a rotation is open; take custody (next) before moving the run');
    if (state.pending && !['author', 'wait'].includes(state.pending.kind)) throw new ConductError(5, `upgrade-root: record pending action ${state.pending.id} first; executable actions cannot be migrated safely (upgrade at an author or wait action)`);
    if (state.pluginRoot === deps.pluginRoot) return { out: { ok: true, unchanged: true, pluginRoot: state.pluginRoot } };
    const from = state.pluginRoot;
    for (const file of ['scripts/lane.mjs', 'skills/conduct/scripts/conduct.mjs', 'skills/slim-review/scripts/pr-review.mjs']) {
      if (!deps.exists(join(deps.pluginRoot, file))) throw new ConductError(4, `upgrade-root: destination lacks ${file}`);
    }
    const snapshot = join(runDir, `state.before-upgrade-${deps.timestamp().replace(/[:.]/g, '-')}.json`);
    if (deps.exists(snapshot)) throw new ConductError(2, 'upgrade-root: snapshot already exists; retry');
    deps.write(snapshot, deps.read(statePath(runDir)));
    const migrate = (value) => {
      if (typeof value === 'string') {
        const root = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return value.replace(new RegExp(`${root}(?=$|[\\\\/\\s'"\x60),])`, 'g'), () => deps.pluginRoot);
      }
      if (Array.isArray(value)) return value.map(migrate);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrate(item)]));
      return value;
    };
    // Only executable queues and the contract use root paths; historical
    // review/ruling receipts retain their original provenance.
    for (const wp of state.wps) {
      wp.queue = migrate(wp.queue ?? []);
      if (wp.owed?.queue) wp.owed.queue = migrate(wp.owed.queue);
    }
    if (state.release?.queue) state.release.queue = migrate(state.release.queue);
    state.pending = migrate(state.pending);
    if (state.build?.contract) state.build.contract = migrate(state.build.contract);
    state.pluginRoot = deps.pluginRoot;
    state.handover = { ...(state.handover ?? {}), pluginUpgrade: { from, to: deps.pluginRoot, why, at: deps.timestamp() } };
    appendEvent(state, deps, { event: 'plugin-upgraded', data: { from, to: deps.pluginRoot, why, snapshot } });
    saveState(state, deps);
    return { out: { ok: true, snapshot, pluginRoot: state.pluginRoot, next: `Use ${join(state.pluginRoot, 'skills/conduct/scripts/conduct.mjs')} for every subsequent verb. Drivers must resolve state.pluginRoot on each invocation.` } };
  });
}

// The conductor hands the run to a successor (lib/rotate.mjs rotate): the
// handoff is written from state, the chain argv printed, and the successor's
// first `next` emits custody before the pending action.
async function rotateVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const text = (name) => (typeof flags[name] === 'string' ? flags[name] : null);
  return transact(flags, deps, async (state) => {
    const out = rotate(state, { why: text('why'), model: text('model'), effort: text('effort'), name: text('name') }, deps);
    saveState(state, deps);
    return { out: { ok: true, ...out } };
  }, { duringRotation: true, driven: 'rotate' });
}

// The quiet-host probe a gate retry runs first (lib/gate-env.mjs): exit 0
// quiet, 1 busy, the samples printed either way.
async function quietVerb(tokens, deps) {
  const flags = parseFlags(tokens);
  const { QUIET_DEFAULTS, quietProbe } = await loadModule(deps, 'lib/gate-env.mjs', 'module');
  const number = (name, fallback, min, max) => {
    if (flags[name] === undefined) return fallback;
    const value = Number(flags[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new ConductError(2, `--${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const out = await quietProbe({
    samples: number('samples', QUIET_DEFAULTS.samples, 1, 10),
    intervalMs: number('interval-ms', QUIET_DEFAULTS.intervalMs, 100, 600000),
    maxBusy: number('max-busy', QUIET_DEFAULTS.maxBusy, 1, 100),
  }, { cpus: deps.cpus, sleep: deps.sleep });
  return { code: out.quiet ? 0 : 1, out };
}

const VERBS = {
  intake, next, record, answer, drive: driveVerb, status, analyze, ratify: ratifyVerb, 'reset-wp': resetWpVerb,
  'ci-checks': ciChecksVerb, 'upgrade-root': upgradeRootVerb, rotate: rotateVerb, replan: replanVerb,
  lane: subVerb('lib/lanes.mjs', 'runLaneVerb', ['spawn', 'alive', 'check', 'reap', 'stop-check', 'hook'], ['spawn']),
  land: subVerb('lib/land.mjs', 'runLandVerb', ['gate', 'merged']),
  bootstrap: async (tokens, deps) => {
    const { runBootstrapVerb } = await loadModule(deps, 'lib/bootstrap.mjs', 'module');
    const { code, report } = runBootstrapVerb(parseFlags(tokens), deps);
    return { code, out: report };
  },
  quiet: quietVerb,
};

// overrides is the in-process test seam; main() passes none.
export async function runConduct(argv, overrides = {}) {
  const deps = {
    exec: execute,
    runArgv,
    windowsShim,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, value) => writeFileSync(path, value, 'utf8'),
    link: linkSync,
    truncate: truncateSync,
    remove: (path) => rmSync(path, { force: true }),
    exists: existsSync,
    realpath: (path) => realpathSync.native(path),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    rename: renameSync,
    append: (path, value) => appendFileSync(path, value, 'utf8'),
    list: (path) => readdirSync(path),
    env: process.env,
    platform: process.platform,
    home: homedir(),
    pid: process.pid,
    hostname: hostname(),
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    lockWaitMs: 2000,
    newRunId: () => randomBytes(4).toString('hex'),
    stdinIsTTY: isatty(0),
    // Only `lane stop-check` reads it: the Stop hook's input.
    readStdin: () => readFileSync(0, 'utf8'),
    spawnDetached,
    pidAlive,
    resolveCodex: defaultCodexExe,
    pluginRoot: PLUGIN_ROOT,
    importModule: (relPath) => import(pathToFileURL(join(SCRIPTS_DIR, relPath)).href),
    ...overrides,
  };
  let [verb, ...tokens] = argv;
  if (verb === '--resume') {
    verb = 'next';
    tokens = ['--run', ...tokens];
  }
  if (!Object.hasOwn(VERBS, verb ?? '')) {
    return { code: 2, stdout: '', stderr: `${verb ? `conduct: unknown verb ${verb}\n` : ''}${USAGE}\n` };
  }
  try {
    const { code = 0, out } = await VERBS[verb](tokens, deps);
    return { code, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' };
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    const cause = error.cause ? `${error.cause.stack ?? error.cause}\n` : '';
    return { code: error.code, stdout: JSON.stringify({ ok: false, error: error.message, ...(error.details ?? {}) }), stderr: `conduct: ${error.message}\n${cause}` };
  }
}

async function main() {
  const result = await runConduct(process.argv.slice(2));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  // exitCode, never process.exit(): exiting after I/O truncates piped output.
  process.exitCode = result.code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
