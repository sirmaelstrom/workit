#!/usr/bin/env node
// The goal conductor's one-shot state machine. Every verb reads state.json,
// does one bounded thing, writes state, appends to events.jsonl and exits; the
// agent running the skill drives the loop: intake → [next → act → record]*.
// `next` never runs a program: it hands the agent an action to perform.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, readdirSync, rmSync, linkSync, truncateSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { isatty } from 'node:tty';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute, spawnDetached, pidAlive, defaultCodexExe } from './lib/exec.mjs';
import {
  ConductError, SCHEMA_VERSION, STEPS, STEP_SEAM, TERMINAL_PHASES,
  appendEvent, loadState, resolveRunDir, saveState, slugify, statePath, withStateLock,
} from './lib/state.mjs';
import { ADAPTERS, AGENTS, DECLARED_ADAPTERS, detectAdapters, firstLine } from './lib/adapters.mjs';
import { resolveRecipe, validateRecipe } from './lib/recipe.mjs';
import { acceptAnswer, resumeHandBack, touchStep, writeTouchFiles } from './lib/touch.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
// The directory holding skills/ and scripts/. Computed here and only here;
// every lib/ module receives it as deps.pluginRoot.
const PLUGIN_ROOT = resolve(SCRIPTS_DIR, '../../..');

const USAGE = `usage: conduct.mjs <verb> [flags]
  intake --goal <text> --repo <abs> [--anchor <quest id>] [--budget <usd>] [--lanes 1|2] [--agent claude|codex]
         [--adapter <name>]... [--no-adapter <name>]... [--release <json file>] [--runs-root <dir>]
  next --run <dir>                 (also: next --resume <dir>, or conduct.mjs --resume <dir>)
  record --run <dir> --action <id> (--result <json> | --result-file <path>) [--manual]
  answer --run <dir> --touch <n> --key <a..f> [--text <text>]
  await-answer --run <dir> --touch <n> [--once] [--interval-ms <ms>] [--timeout-ms <ms>]
  status --run <dir>
  analyze --run <dir>
  lane <spawn|alive|check> --run <dir> --wp <id> [sub-verb flags]
  land <gate|merged> --run <dir> --wp <id|release> [sub-verb flags]`;

const BOOLEAN_FLAGS = new Set(['manual', 'once']);
const REPEATED_FLAGS = new Set(['adapter', 'no-adapter']);
// These always take the next token as their value, even one that starts with
// `--` (an operator's `--text "--skip release"`).
const VALUE_FLAGS = new Set(['goal', 'repo', 'anchor', 'budget', 'lanes', 'agent', 'adapter', 'no-adapter', 'release',
  'runs-root', 'run', 'resume', 'action', 'result', 'result-file', 'touch', 'key', 'text', 'wp']);

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

// A state transaction: load, change and save under the run's lock.
function transact(flags, deps, fn) {
  return withStateLock(runDirFlag(flags), deps, () => fn(openRun(flags, deps).state));
}

function stamp(state, spec) {
  if (!STEPS.includes(spec.step)) throw new ConductError(2, `action step ${spec.step} is not in STEPS`);
  state.seq += 1;
  return { id: `${state.seq}-${spec.step}`, phase: state.phase, ...spec, seam: spec.seam !== undefined ? spec.seam : STEP_SEAM[spec.step] };
}

// The pending action, or the current phase's next one. A handler that changes
// the phase without an action hands over to the next phase's handler.
async function emit(state, deps) {
  if (state.pending) return state.pending;
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
  if (lanesCap !== 1 && lanesCap !== 2) throw new ConductError(2, '--lanes must be 1 or 2');
  if (flags.agent !== undefined && !AGENTS.includes(flags.agent)) throw new ConductError(2, `--agent must be one of ${AGENTS.join(', ')}`);
  const spine = declared.includes('spine') && !forcedOff.includes('spine');
  return { goal, forcedOff, declared, budgetUsd, lanesCap, spine };
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
  const { adapters, agents } = detectAdapters({
    env: deps.env, exec: deps.exec, exists: deps.exists, declared: options.declared, forcedOff: options.forcedOff,
    platform: deps.platform, resolveCodex: deps.resolveCodex,
  });
  if (flags.agent !== undefined && !agents[flags.agent].on) refuse(5, `--agent ${flags.agent} is not available: ${agents[flags.agent].detail}`);
  const agent = flags.agent ?? AGENTS.find((name) => agents[name].on);
  if (!agent) refuse(5, `no lane agent CLI on PATH (${AGENTS.map((name) => `${name}: ${agents[name].detail}`).join('; ')})`);
  const recipe = resolveRecipe({ flagPath: typeof flags.release === 'string' ? resolve(flags.release) : null, repoPath, read: deps.read });
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

  deps.mkdir(runDir);
  return withStateLock(runDir, deps, async () => {
    if (deps.exists(statePath(runDir))) refuseExisting();
    const state = {
      schemaVersion: SCHEMA_VERSION, slug, runId: deps.newRunId(), createdAt: deps.timestamp(), runDir, workshopDir, pluginRoot: deps.pluginRoot,
      intent: {
        goal: options.goal, repo: { path: repoPath, remote, defaultBranch: repoInfo.defaultBranchRef?.name ?? null },
        anchor: typeof flags.anchor === 'string' ? flags.anchor : null, campaign: null,
        budgetUsd: options.budgetUsd, lanesCap: options.lanesCap, agent, release: recipe, ciWorkflows,
      },
      agents, adapters,
      phase: options.spine ? 'intake' : 'preapproval',
      authority: { merge: false, release: false, budgetUsd: 0, metered: adapters.spend.on, scope: options.goal, notes: null, grant: null },
      touches: [],
      spec: { depth: null, reviewLevel: null, gate: null, gateCommand: null },
      wps: [],
      release: { state: 'pending', reason: null, base: null, worktree: null, branch: null, pr: null, gate: null, merge: null },
      mergeLock: null, dispatchHalt: null, handover: null, sentBack: null, pending: null, lastRecorded: null, seq: 0, rev: 0, txns: [],
    };
    appendEvent(state, deps, { step: 'intake', event: 'intake', source: 'next', data: { remote, ciWorkflows, ciError } });
    saveState(state, deps);
    return { out: { ok: true, runDir, action: await emit(state, deps) } };
  });
}

// `next` (and `--resume`) on a pending spine hand-back is the resume: the
// hand-back is consumed and the touch is read back again.
async function next(tokens, deps) {
  return transact(parseFlags(tokens), deps, async (state) => {
    if (state.pending?.handBack) resumeHandBack(state, deps);
    return { out: { ok: true, action: await emit(state, deps) } };
  });
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

async function record(tokens, deps) {
  const flags = parseFlags(tokens);
  return transact(flags, deps, async (state) => {
    const id = stringFlag(flags, 'action');
    // A replay of the last record changes nothing and re-emits the next action.
    if (id === state.lastRecorded) return { out: { ok: true, phase: state.phase, action: await emitAfterRecord(state, deps, id), noop: true } };
    const action = state.pending;
    if (!action || action.id !== id) throw new ConductError(5, `action ${id} is not the pending action (${action?.id ?? 'none pending'})`);
    const result = readResult(flags, deps);
    if (action.kind === 'shell') checkShellResult(action, result);
    // A core touch the operator has not answered yet, or a spine hand-back,
    // stays pending: recording it does not mint a new action.
    if (action.kind === 'touch' && state.touches[action.touch.n - 1]?.status !== 'answered') {
      return { out: { ok: true, phase: state.phase, action, answered: false } };
    }
    const handler = await loadModule(deps, `lib/phases/${action.phase}.mjs`, `phase handler ${action.phase}`);
    const outcome = await handler.record(state, action, result, deps);
    state.pending = null;
    state.lastRecorded = id;
    appendEvent(state, deps, {
      actionId: id, step: action.step, seam: action.seam, kind: action.kind, event: 'recorded',
      source: flags.manual === true ? 'manual' : 'next', phase: action.phase,
      data: state.phase === action.phase ? {} : { phase: state.phase },
    });
    saveState(state, deps);
    const next = await emitAfterRecord(state, deps, id);
    // A refused answer (not operator-attributed) is recorded as a refusal:
    // exit 3, no authority, and the next action re-files the touch.
    if (outcome?.refused) return { code: 3, out: { ok: false, refused: outcome.refused, recorded: id, phase: state.phase, action: next } };
    return { out: { ok: true, phase: state.phase, action: next } };
  });
}

// An operator's answer to a core touch. stdinIsTTY comes from isatty(0) and
// no flag or env var sets it: a procedural approval boundary, not proof of
// the operator's identity (MN5).
async function answer(tokens, deps) {
  const flags = parseFlags(tokens);
  return transact(flags, deps, async (state) => {
    if (deps.stdinIsTTY !== true) throw new ConductError(3, 'stdin is not a TTY: the operator answers a touch from their own terminal');
    const touch = state.touches.find((candidate) => String(candidate.n) === String(flags.touch));
    if (!touch || touch.status !== 'open' || state.adapters.spine?.on) throw new ConductError(5, `no open core touch ${flags.touch}`);
    touch.tty = true;
    acceptAnswer(touch, { key: flags.key, text: typeof flags.text === 'string' ? flags.text : null, by: 'operator:tty', answeredAt: deps.timestamp(), source: 'tty' });
    writeTouchFiles(state, touch, deps);
    appendEvent(state, deps, { step: touchStep(touch), kind: 'touch', event: 'answered', source: 'tty', data: { n: touch.n, key: touch.answer.key } });
    saveState(state, deps);
    return { out: { ok: true, touch } };
  });
}

async function status(tokens, deps) {
  const { state } = openRun(parseFlags(tokens), deps);
  const lines = [
    `conduct ${state.slug}: phase ${state.phase}`,
    `repo: ${state.intent.repo.path} (${state.intent.repo.remote})`,
    `pending: ${state.pending ? `${state.pending.id} (${state.pending.kind}) ${state.pending.instruction ?? ''}` : 'none'}`,
    ...state.touches.map((touch) => `touch ${touch.n} ${touch.kind}: ${touch.status}${touch.answer ? ` (${touch.answer.key} by ${touch.answer.by})` : ''}`),
    ...state.wps.map((wp) => `${wp.id} ${wp.state}${wp.questId ? ` quest ${wp.questId}` : ''}`),
  ];
  return { out: lines.join('\n') };
}

async function analyze(tokens, deps) {
  const { runDir } = openRun(parseFlags(tokens), deps);
  const module = await loadModule(deps, 'lib/analyze.mjs', 'module');
  // readEvents (lib/state.mjs) needs exists and read; the analysis reads events through it.
  return { out: await module.analyzeRun(runDir, { exec: deps.exec, read: deps.read, write: deps.write, exists: deps.exists }) };
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

// The answer adapter's lookup and wait (lib/answer.mjs): read-only, unlocked.
async function awaitAnswerVerb(tokens, deps) {
  const module = await loadModule(deps, 'lib/answer.mjs', 'module');
  return module.awaitAnswer(parseFlags(tokens), deps);
}

const VERBS = {
  intake, next, record, answer, status, analyze, 'await-answer': awaitAnswerVerb,
  lane: subVerb('lib/lanes.mjs', 'runLaneVerb', ['spawn', 'alive', 'check'], ['spawn']),
  land: subVerb('lib/land.mjs', 'runLandVerb', ['gate', 'merged']),
};

// overrides is the in-process test seam; main() passes none.
export async function runConduct(argv, overrides = {}) {
  const deps = {
    exec: execute,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, value) => writeFileSync(path, value, 'utf8'),
    link: linkSync,
    truncate: truncateSync,
    remove: (path) => rmSync(path, { force: true }),
    exists: existsSync,
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
