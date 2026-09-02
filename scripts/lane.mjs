#!/usr/bin/env node
/**
 * One-step lane lifecycle helper. Each invocation emits one JSON document and
 * appends one JSONL instrumentation row. No prompt body is ever shell-parsed.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// The exit contract a conductor branches on:
//   0 ok · 1 herdr/infra failure · 2 usage, refused before any mutation
//   3 blocked (+ dialog) · 4 a wait deadline expired · 5 artifact check failed
//   6 plan-low or a captured plan refusal
// 4 means a deadline and nothing else. A dead daemon that reports as a timeout
// is re-polled forever by a conductor that trusts this table.
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, BLOCKED: 3, TIMEOUT: 4, CHECK_FAILED: 5, PLAN_LOW: 6 });
export const EXIT_CODES = Object.freeze({ ok: 0, error: 1, usage: 2, blocked: 3, timeout: 4, artifactCheckFailed: 5, planLow: 6 });

export const USAGE_TEXT = `lane <verb> [options] — one lane lifecycle step per invocation, JSON on stdout.

  create   --repo <abs> --branch <b> --base <ref> --label <text>
           [--path <abs>] [--slug <text>] [--workspace-root <abs>]
           Roots the lane at <repo>-wt-<slug> under the projects tree (C13).
  start    <name> --pane <id> --kind claude|codex --model <slug> --reasoning <lvl>
           [--sandbox <mode>] [--permission-mode <mode>] [--allow-default-mode]
           [-- <native agent args>]
           dontAsk is always refused; default mode needs --allow-default-mode.
  prompt   <name> --file <abs>          Sends only "Read <file> and execute it exactly."
  wait     <name> [--until blocked|idle|done]... --timeout <ms> [--plan-floor <pct>]
           --until repeats: a blocked-only wait cannot see a lane that finished.
  check    <name> --expect-commit | --expect-file <path>[:needle] | --expect-pr <n>
  resume   <name> [--timeout <ms>]      Waits --until idle --until done, never bare.
  fallback <name> --to claude --model <slug> --reasoning <lvl>
  sweep    [--root <path>]... [--workspace-root <abs>] [--lane <name>] [--list] [--force]
           --lane <name> limits the delegate to one lane; --list is a dry run.
           Outside a herdr worktrees root, every call is scoped to a lane this
           helper created (from the sidecar), and --force is refused there.
           The delegate is HERDR_LANES_SCRIPT, else <workspace-root>/infrastructure/
           herdr-lanes.ps1, else that path from the cwd; if none exists, sweep
           prints the command to run instead of guessing a location.

  --log <path>  JSONL instrumentation (default: <workspace>/data/outputs/projects/
                agentic-practice-transfer/lanes/lane-log.jsonl, else ./lane-log.jsonl)`;
// Seeded only from a captured refusal, never an invented one. This string was
// read off lane O's pane at 2026-09-01 22:12Z; herdr reported that agent as
// `idle` the whole time the modal was up, so the pane text is the only signal.
export const PLAN_REFUSAL_PATTERNS = Object.freeze([/hit your usage limit/i]);
// The sweep delegate's location is resolved, never hardcoded: this file ships in
// a public repo, and one operator's drive layout is not a default. Order:
// HERDR_LANES_SCRIPT, then <workspace-root>/infrastructure/herdr-lanes.ps1
// (--workspace-root or WORKIT_WORKSPACE_ROOT), then the same relative path from
// the cwd. When none of them resolves, `sweep` prints the command to run.
const SWEEP_DELEGATE = ['infrastructure', 'herdr-lanes.ps1'];
const POLL_MS = 1_000;
const LOG_BASENAME = 'lane-log.jsonl';
const LOG_SUBPATH = ['data', 'outputs', 'projects', 'agentic-practice-transfer', 'lanes'];
const VERBS = new Set(['create', 'start', 'prompt', 'wait', 'check', 'resume', 'fallback', 'sweep']);

class LaneError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function execute(program, args, { cwd, input } = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync(program, args, {
        cwd,
        input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      code: Number.isInteger(error?.status) ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}

function usage(message) {
  throw new LaneError(EXIT.USAGE, message);
}

function call(deps, program, args, options = {}) {
  const result = deps.exec(program, args, options);
  if (typeof result === 'string') return { code: 0, stdout: result, stderr: '' };
  return {
    code: result?.code ?? result?.exitCode ?? 0,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  };
}

function callOrFail(deps, program, args, options = {}) {
  const result = call(deps, program, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new LaneError(EXIT.ERROR, `${program} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

// Every herdr response is {"id":"cli:<command>","result":{…}} — verified live on
// worktree list, pane list and agent list. The envelope's `id` is the command
// name, so a deep search for an "id" alias reads "cli:worktree:create" as a
// workspace id. Unwrap the envelope, then read documented fields by name.
function unwrapResult(text) {
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.result && typeof parsed.result === 'object' ? parsed.result : parsed;
}

function deepFind(value, names, topLevel = true) {
  if (!value || typeof value !== 'object') return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined) return value[name];
  }
  for (const [key, child] of Object.entries(value)) {
    if (topLevel && key === 'id') continue;
    const found = deepFind(child, names, false);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstDefined(source, names) {
  if (!source || typeof source !== 'object') return undefined;
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return undefined;
}

function responseState(text, fallback = null) {
  const result = unwrapResult(text);
  const fromJson = firstDefined(result, ['state', 'status', 'agent_status'])
    ?? deepFind(result, ['state', 'status', 'agent_status']);
  if (typeof fromJson === 'string') return fromJson.toLowerCase();
  const match = /\b(blocked|working|idle|done|unknown|timeout)\b/i.exec(String(text));
  return match ? match[1].toLowerCase() : fallback;
}

function responseText(text) {
  const found = deepFind(unwrapResult(text), ['text', 'output', 'content']);
  return typeof found === 'string' ? found : String(text);
}

function parseArgs(argv) {
  const [verb, ...tokens] = argv;
  if (verb === undefined || ['--help', '-h', 'help'].includes(verb)) {
    throw new LaneError(EXIT.USAGE, 'lane needs one verb', { usage: USAGE_TEXT });
  }
  if (!VERBS.has(verb)) {
    throw new LaneError(EXIT.USAGE, `expected one verb: ${[...VERBS].join(', ')}`, { usage: USAGE_TEXT });
  }
  const opts = { verb, positional: [], agentArgs: [] };
  const booleanFlags = new Set(['--expect-commit', '--live', '--force', '--list', '--allow-default-mode']);
  const repeatableFlags = new Set(['--root', '--until']);
  const valueFlags = new Set([
    '--repo', '--branch', '--base', '--label', '--pane', '--kind', '--model', '--reasoning', '--sandbox',
    '--permission-mode', '--file', '--timeout', '--expect-file', '--expect-pr', '--to', '--log',
    '--plan-floor', '--path', '--slug', '--workspace-root', '--lane',
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      opts.agentArgs = tokens.slice(i + 1);
      break;
    }
    // herdr's `agent wait --until` repeats, and a blocked-only wait cannot see a
    // lane that finished — so this flag repeats here too.
    if (repeatableFlags.has(token)) {
      const value = tokens[++i];
      if (value === undefined) usage(`${token} needs a value`);
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      (opts[key] ??= []).push(value);
      continue;
    }
    if (booleanFlags.has(token)) {
      opts[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (valueFlags.has(token)) {
      const value = tokens[++i];
      if (value === undefined) usage(`${token} needs a value`);
      opts[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      continue;
    }
    if (token.startsWith('-')) usage(`unknown argument: ${token}`);
    opts.positional.push(token);
  }
  opts.name = opts.positional[0] ?? null;
  if (opts.positional.length > 1) usage(`unexpected argument: ${opts.positional[1]}`);
  return opts;
}

// Worktree-rooting's output rule: the log root is declared (a flag, then the
// env var), and falls back to cwd only when neither is set — and then it says
// so. A cwd-relative default silently gives a later verb a different sidecar,
// which surfaces as "unknown lane" rather than as the rooting mistake it is.
function resolveLogPath(opts, deps) {
  if (opts.log) return { log: resolve(opts.log), logSource: '--log' };
  const declared = opts.workspaceRoot ?? deps.env.WORKIT_WORKSPACE_ROOT ?? null;
  if (declared) {
    return {
      log: join(resolve(declared), ...LOG_SUBPATH, LOG_BASENAME),
      logSource: opts.workspaceRoot ? '--workspace-root' : 'WORKIT_WORKSPACE_ROOT',
    };
  }
  return { log: resolve(LOG_BASENAME), logSource: 'cwd' };
}

// Recovered from raw argv so a refusal that never reached parseArgs can still
// append its row: the spec says EVERY verb appends one.
function logPathFromArgv(argv, deps) {
  const index = argv.indexOf('--log');
  const root = argv.indexOf('--workspace-root');
  return resolveLogPath({
    log: index >= 0 ? argv[index + 1] : undefined,
    workspaceRoot: root >= 0 ? argv[root + 1] : undefined,
  }, deps);
}


function emptyState() {
  return { lanes: {}, creates: [] };
}

function statePath(logPath) {
  return `${logPath}.state.json`;
}

function loadState(deps, logPath) {
  const path = statePath(logPath);
  if (!deps.exists(path)) return emptyState();
  // Read and parse fail for different reasons and want different answers. One
  // try around both told an operator whose sidecar was merely locked that their
  // JSON was invalid — which points them at deleting a healthy file.
  let raw;
  try {
    raw = deps.read(path);
  } catch (error) {
    throw new LaneError(EXIT.ERROR, `could not read lane state (${error.code ?? 'read failed'}): ${path}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return { lanes: parsed.lanes ?? {}, creates: parsed.creates ?? [] };
  } catch {
    throw new LaneError(EXIT.USAGE, `lane state is not valid JSON: ${path}`);
  }
}

// The helper is CLI-first and supervises a fleet, so two lane processes can
// reach the sidecar at once. Read-modify-write without a lock loses one of
// them outright (measured: two concurrent starts, one lane unrecoverable), and
// the in-memory copy loaded at entry is stale by the time we save. So: take a
// lock, re-read, merge into the fresh copy, write, release in a finally.
async function mergeState(deps, logPath, state, mutate) {
  const lock = `${statePath(logPath)}.lock`;
  const release = await acquireLock(deps, lock);
  try {
    const fresh = loadState(deps, logPath);
    await mutate(fresh);
    deps.mkdir(dirname(statePath(logPath)));
    deps.write(statePath(logPath), `${JSON.stringify(fresh, null, 2)}\n`);
    state.lanes = fresh.lanes;
    state.creates = fresh.creates;
    return fresh;
  } finally {
    release();
  }
}

const LOCK_STALE_MS = 60_000;

async function acquireLock(deps, lock, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      deps.mkdir(dirname(lock));
      deps.writeNew(lock, `${deps.timestamp()}\n`);
      return () => { try { deps.remove(lock); } catch { /* already gone */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // A lane killed mid-write leaves a lock that would fail every later call
      // until someone deletes it by hand. Reclaim it once it is older than any
      // plausible in-flight write, and say so — silence here looks like a hang.
      const age = lockAge(deps, lock);
      if (age !== null && age > LOCK_STALE_MS) {
        deps.warn(`lane: reclaiming a stale lock (${Math.round(age / 1000)}s old): ${lock}`);
        try { deps.remove(lock); } catch { /* someone else won the race */ }
        continue;
      }
      await deps.sleep(Math.min(200, 10 * (attempt + 1)));
    }
  }
  throw new LaneError(EXIT.ERROR, `could not take the lane state lock: ${lock} (remove it if no lane is running)`);
}

function lockAge(deps, lock) {
  try {
    const stat = deps.stat(lock);
    return deps.now() - Number(stat?.mtimeMs ?? stat?.mtime ?? 0);
  } catch {
    return null;
  }
}

function required(opts, ...names) {
  for (const name of names) if (!opts[name]) usage(`${opts.verb} needs --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}

function agentOption(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// Strips `-c <key>=…` pairs for one key only: a codex lane may legitimately
// carry other -c overrides, but not one that reopens the enforced effort level.
function withoutConfig(args, key) {
  const copy = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && String(args[i + 1] ?? '').startsWith(`${key}=`)) {
      i++;
      continue;
    }
    copy.push(args[i]);
  }
  return copy;
}

function withoutOption(args, flag) {
  const copy = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++;
    } else {
      copy.push(args[i]);
    }
  }
  return copy;
}

function defaultFindCodexBin(npmRoot) {
  const vendor = join(
    npmRoot.trim(),
    '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor',
  );
  let platforms;
  try {
    platforms = readdirSync(vendor, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    throw new LaneError(EXIT.USAGE, `codex vendor directory not found under npm root: ${vendor}`);
  }
  for (const platform of platforms) {
    const bin = join(vendor, platform.name, 'bin');
    if (existsSync(join(bin, 'codex.exe'))) return bin;
  }
  throw new LaneError(EXIT.USAGE, `codex.exe not found under: ${vendor}`);
}

// Every alternative is anchored. An unanchored `>` alternative subsumes the
// others and matches any line ending in `>` — "still running codex >" passed,
// and this is the only gate before `agent start` fires into the pane.
const PANE_PROMPT = /^(?:PS\s+\S.*|[A-Za-z]:\\.*)>\s*$/;

export function paneAtPrompt(text) {
  const lines = responseText(text).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.length > 0 && PANE_PROMPT.test(lines.at(-1));
}

function paneIsCodexReady(text) {
  const lines = responseText(text).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const hasExecutable = lines.some((line) => /(?:^|[\\/])codex\.exe\s*$/i.test(line));
  return hasExecutable && paneAtPrompt(text);
}

async function waitForPanePrompt(deps, pane, timeoutMs = 30_000) {
  const deadline = deps.now() + timeoutMs;
  do {
    const snapshot = call(deps, 'herdr', ['pane', 'read', pane, '--source', 'detection', '--lines', '40']);
    if (snapshot.code === 0 && paneAtPrompt(snapshot.stdout)) return;
    await deps.sleep(100);
  } while (deps.now() < deadline);
  // A wedged pane is infrastructure, not the operator's deadline: 4 belongs to
  // `lane wait` alone, and prepareCodexPane already raises ERROR for the same
  // shape of failure.
  throw new LaneError(EXIT.ERROR, `pane ${pane} never returned to a shell prompt`);
}

function laneSlug(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) usage('could not derive a worktree slug from the branch; pass --slug');
  return slug;
}

async function prepareCodexPane(opts, deps) {
  // Windows-only by C12 (startLane refuses codex elsewhere), and `npm` on PATH
  // here is npm.ps1 — a shim execFileSync cannot launch — so it is routed
  // through cmd.exe rather than spawned directly.
  const npmRoot = callOrFail(deps, deps.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g']).trim();
  const bin = deps.findCodexBin(npmRoot);
  // A single-quoted PowerShell literal: inside it `$` and backtick are inert,
  // and an embedded quote is escaped by doubling it.
  const command = `$env:PATH = '${bin.replace(/'/g, "''")};' + $env:PATH; (Get-Command codex).Source`;
  callOrFail(deps, 'herdr', ['pane', 'run', opts.pane, command]);
  const deadline = deps.now() + 30_000;
  do {
    // C12 exists because codex launches were unreliable — a transient read must
    // retry inside the budget, not abort the launch it is there to make safe.
    const snapshot = call(deps, 'herdr', ['pane', 'read', opts.pane, '--source', 'detection', '--lines', '40']);
    if (snapshot.code === 0 && paneIsCodexReady(snapshot.stdout)) return;
    await deps.sleep(100);
  } while (deps.now() < deadline);
  throw new LaneError(EXIT.ERROR, `timed out waiting for codex.exe and the shell prompt in pane ${opts.pane}`);
}

// Returns a verdict; never throws. C4 is an assertion about the world made
// AFTER a live agent exists, so failing it must not abandon that agent — and a
// verdict that cannot be tied to the conductor's own pane is `unverified`,
// never success. The old fallback grepped the raw listing for "focused": true
// with no association at all: an unrelated focused pane read as S5 holding.
function agentName(raw) {
  const result = unwrapResult(raw);
  if (typeof result?.agent === 'string') return result.agent;
  if (typeof result?.agent?.name === 'string') return result.agent.name;
  return typeof result?.name === 'string' ? result.name : null;
}

function restoreFocus(deps) {
  const conductorPane = deps.env.HERDR_PANE_ID;
  if (!conductorPane) {
    return { focus: 'unverified', warning: 'HERDR_PANE_ID is not set, so conductor focus could not be restored or verified' };
  }
  const focused = call(deps, 'herdr', ['agent', 'focus', conductorPane]);
  if (focused.code !== 0) {
    const detail = focused.stderr.trim() || focused.stdout.trim();
    return { focus: 'failed', warning: `could not focus conductor pane ${conductorPane}${detail ? `: ${detail}` : ''}` };
  }
  const listing = call(deps, 'herdr', ['agent', 'list']);
  if (listing.code !== 0) {
    return { focus: 'unverified', warning: `herdr agent list failed, so focus on ${conductorPane} is unverified` };
  }
  const agents = deepFind(unwrapResult(listing.stdout), ['agents']);
  if (!Array.isArray(agents)) {
    return { focus: 'unverified', warning: `herdr agent list could not be parsed, so focus on ${conductorPane} is unverified` };
  }
  const conductor = agents.find((agent) => (agent?.pane_id ?? agent?.paneId) === conductorPane);
  if (!conductor) {
    return { focus: 'unverified', warning: `no agent in the listing holds conductor pane ${conductorPane}` };
  }
  if (conductor.focused !== true) {
    return { focus: 'not-focused', warning: `conductor pane ${conductorPane} was not restored to focus` };
  }
  return { focus: 'restored' };
}

async function createLane(opts, deps, state) {
  required(opts, 'repo', 'branch', 'base', 'label');
  if (!isAbsolute(opts.repo)) usage('create --repo must be absolute');
  const repo = resolve(opts.repo);
  const exists = call(deps, 'git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${opts.branch}`]);
  if (exists.code === 0) usage(`branch already exists: ${opts.branch}`);
  if (exists.code !== 1) throw new LaneError(EXIT.ERROR, `could not inspect branch ${opts.branch}: ${exists.stderr.trim()}`);
  // C13: the review-council confines code_root to the projects tree and refuses
  // a lane under herdr's default root, so the lane lands beside its repo as
  // <workspace>/projects/<repo>-wt-<slug> — the worktree-rooting recipe. The
  // path is declared here and returned; no other verb may assume it (C7).
  const path = opts.path ? resolve(opts.path) : `${repo}-wt-${laneSlug(opts.slug ?? opts.branch)}`;
  assertUnderProjects(opts, deps, path);
  if (deps.exists(path)) usage(`worktree path already exists: ${path}`);
  const raw = callOrFail(deps, 'herdr', [
    'worktree', 'create', '--cwd', repo, '--branch', opts.branch, '--base', opts.base, '--no-focus', '--label', opts.label,
    '--path', path,
  ]);
  const result = unwrapResult(raw);
  const worktree = (result && typeof result.worktree === 'object' ? result.worktree : result) ?? {};
  const workspaceId = firstDefined(worktree, ['open_workspace_id', 'workspace_id', 'workspaceId'])
    ?? firstDefined(result, ['open_workspace_id', 'workspace_id', 'workspaceId'])
    ?? null;
  const output = {
    workspaceId,
    paneId: firstDefined(worktree, ['pane_id', 'paneId'])
      ?? firstDefined(result, ['pane_id', 'paneId'])
      ?? resolvePaneId(deps, workspaceId),
    path: firstDefined(worktree, ['path', 'worktree_path', 'worktreePath']) ?? path,
    branch: firstDefined(worktree, ['branch']) ?? opts.branch,
  };
  // C13 binds the lane that EXISTS, not the one we asked for. herdr returning a
  // different path is exactly the state the constraint exists to prevent: the
  // council's code_root refuses it and the agentic seats silently ground
  // against the canonical checkout instead.
  if (resolve(output.path) !== resolve(path)) {
    assertUnderProjects(opts, deps, resolve(output.path), EXIT.ERROR);
  }
  // `{workspaceId, paneId, path, branch}` is the documented return. A null pane
  // is not an instance of it, and it surfaces one verb later inside `start`.
  if (!output.paneId) {
    throw new LaneError(EXIT.ERROR, `herdr worktree create returned no paneId for ${output.path}; cannot start a lane without a pane`);
  }
  await mergeState(deps, opts.log, state, (draft) => {
    draft.creates.push({ ...output, base: opts.base, label: opts.label });
  });
  return { output, row: { lane: opts.label, state: 'created' } };
}

// C13's invariant, not just its shape: a lane that lands outside the projects
// tree is refused by the council's code_root confinement, which is the whole
// reason the flag exists. The workspace root is declared (--workspace-root or
// WORKIT_WORKSPACE_ROOT); with neither, the structural rule still binds — the
// lane's parent directory must be named `projects`.
function assertUnderProjects(opts, deps, path, code = EXIT.USAGE) {
  const refuse = (message) => {
    if (code === EXIT.USAGE) usage(message);
    throw new LaneError(code, message);
  };
  const declared = opts.workspaceRoot ?? deps.env.WORKIT_WORKSPACE_ROOT ?? null;
  if (declared) {
    const required = join(resolve(declared), 'projects');
    if (dirname(path) !== required) {
      refuse(`C13: the lane must live under ${required}, not ${dirname(path)}`);
    }
    return;
  }
  if (basename(dirname(path)) !== 'projects') {
    refuse(`C13: the lane must live in a projects tree; ${dirname(path)} is not one (declare --workspace-root to be explicit)`);
  }
}

// `worktree create` opens a workspace; the pane it opens is what `lane start`
// needs. When the create payload carries no pane, ask the workspace for it
// rather than returning a null that fails deep inside `start`.
function resolvePaneId(deps, workspaceId) {
  if (!workspaceId) return null;
  const listing = call(deps, 'herdr', ['pane', 'list', '--workspace', String(workspaceId)]);
  if (listing.code !== 0) return null;
  const panes = deepFind(unwrapResult(listing.stdout), ['panes']);
  if (!Array.isArray(panes) || panes.length === 0) return null;
  return firstDefined(panes[0], ['pane_id', 'paneId']) ?? null;
}

async function startLane(opts, deps, state) {
  // C8: model AND reasoning effort are launch flags, never inherited. A claude
  // fallback lane started without --effort ran at xhigh — $5.24 in 9 minutes on
  // a finish-and-commit task (measured 2026-09-01).
  required(opts, 'pane', 'kind', 'model', 'reasoning');
  if (!opts.name) usage('start needs <name>');
  if (!['claude', 'codex'].includes(opts.kind)) usage('start --kind must be claude or codex');

  let native = [...opts.agentArgs];
  let warning = null;
  if (opts.kind === 'claude') {
    const mode = opts.permissionMode ?? agentOption(native, '--permission-mode') ?? 'bypassPermissions';
    // dontAsk stays refused whatever else is passed: it auto-denies every tool
    // and still settles to `done`, which is the one failure no flag should buy.
    if (mode === 'dontAsk') usage('claude permission mode dontAsk is refused because it auto-denies tools');
    if (mode === 'default') {
      // A lane in default mode blocks on the first tool prompt. That is a broken
      // lane and a working S1 trigger, so it is opt-in and always announced.
      if (!opts.allowDefaultMode) {
        usage('claude permission mode default blocks on the first tool prompt; pass --allow-default-mode if a blocked lane is the point');
      }
      warning = 'default permission mode: this lane will block on its first tool prompt and needs an operator approval';
    } else if (!['bypassPermissions', 'acceptEdits'].includes(mode)) {
      usage(`unsupported claude permission mode: ${mode}`);
    } else if (mode === 'acceptEdits') {
      warning = 'acceptEdits auto-accepts edits; on this box it did not block on ordinary Bash';
    }
    // C8 is a cost guard with a measured incident behind it, and `-- <native>`
    // is the documented extension point: a forwarded --model would sit AFTER
    // the enforced one, and last-flag-wins would silently pick it.
    native = withoutOption(withoutOption(withoutOption(native, '--permission-mode'), '--effort'), '--model');
    native = ['--model', opts.model, '--permission-mode', mode, '--effort', opts.reasoning, ...native];
  } else {
    // C12 makes codex lanes Windows-only here: the launch depends on the real
    // codex.exe under a win32 vendor path. Refuse elsewhere rather than hunt
    // for a directory that cannot exist.
    if (deps.platform !== 'win32') {
      usage(`codex lanes are Windows-only (C12: the launch needs the win32 codex.exe); platform is ${deps.platform}`);
    }
    const sandbox = opts.sandbox ?? agentOption(native, '--sandbox');
    if (!sandbox) usage('codex start needs an explicit --sandbox');
    if (sandbox === 'read-only') usage('codex read-only sandbox is refused on Windows because it can return ungrounded answers');
    native = withoutConfig(withoutOption(withoutOption(withoutOption(native, '--sandbox'), '--ask-for-approval'), '--model'), 'model_reasoning_effort');
    await prepareCodexPane(opts, deps);
    native = [
      '--model', opts.model, '--ask-for-approval', 'never', '--sandbox', sandbox,
      '-c', `model_reasoning_effort=${opts.reasoning}`, ...native,
    ];
  }

  const raw = callOrFail(deps, 'herdr', ['agent', 'start', opts.name, '--kind', opts.kind, '--pane', opts.pane, '--', ...native]);
  // The agent is live from here on. Record it BEFORE asserting anything about
  // the world: a focus check that threw here once left a running agent with no
  // state row, and `lane wait` then answered "unknown lane" — the exact blind
  // lane this helper exists to prevent.
  await mergeState(deps, opts.log, state, (draft) => {
    const existing = draft.lanes[opts.name] ?? {};
    const prior = draft.creates.find((created) => created.paneId === opts.pane) ?? {};
    draft.lanes[opts.name] = {
      ...existing,
      pane: opts.pane,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning ?? null,
      // A fallback re-starts an existing lane, and its `creates` lookup misses:
      // without the existing fallbacks this nulls the lane's identity and
      // `lane check` — the completion verdict (C2) — is forfeited for good.
      branch: prior.branch ?? existing.branch ?? null,
      base: prior.base ?? existing.base ?? null,
      path: prior.path ?? existing.path ?? null,
    };
  });

  const focus = restoreFocus(deps);
  const warnings = [warning, focus.warning].filter(Boolean);
  return {
    output: {
      agent: agentName(raw) ?? opts.name,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning,
      startedAt: deps.timestamp(),
      focus: focus.focus,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    },
    row: {
      lane: opts.name,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning ?? null,
      state: 'started',
      warning: warnings.length > 0 ? warnings.join('; ') : null,
    },
  };
}

async function promptLane(opts, deps, state) {
  required(opts, 'file');
  if (!opts.name) usage('prompt needs <name>');
  const file = resolve(opts.file);
  if (!deps.exists(file)) usage(`prompt file does not exist: ${file}`);
  const wire = `Read ${file} and execute it exactly.`;
  const raw = callOrFail(deps, 'herdr', ['agent', 'prompt', opts.name, wire, '--wait', '--until', 'working']);
  const lane = state.lanes[opts.name] ?? {};
  await mergeState(deps, opts.log, state, (draft) => {
    draft.lanes[opts.name] = { ...(draft.lanes[opts.name] ?? lane), promptFile: file };
  });
  const stateAfter = responseState(raw, 'working');
  return {
    output: { accepted: deepFind(unwrapResult(raw), ['accepted']) ?? true, stateAfter },
    row: { lane: opts.name, kind: lane.kind ?? null, model: lane.model ?? null, reasoning: lane.reasoning ?? null, state: stateAfter },
  };
}

function laneRecord(opts, state) {
  if (!opts.name) usage(`${opts.verb} needs <name>`);
  const lane = state.lanes[opts.name];
  if (!lane) usage(`unknown lane: ${opts.name}`);
  return lane;
}

function laneInstrumentation(name, lane, state) {
  return {
    lane: name,
    kind: lane.kind ?? null,
    model: lane.model ?? null,
    reasoning: lane.reasoning ?? null,
    state,
  };
}

function positiveNumber(value, flag, fallback = null) {
  if (value === undefined && fallback !== null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) usage(`${flag} must be a positive number`);
  return number;
}

async function waitLane(opts, deps, state) {
  const lane = laneRecord(opts, state);
  const timeout = positiveNumber(opts.timeout, '--timeout');
  const untilStates = Array.isArray(opts.until) ? opts.until : (opts.until ? [opts.until] : []);
  for (const state of untilStates) {
    if (!['blocked', 'idle', 'done'].includes(state)) usage('wait --until must be blocked, idle, or done');
  }
  // 20, not 10: the measured drain was 79% → 0% in ~36 min at four concurrent
  // codex consumers, and the "<10% left" warning arrived ~7 min before refusal.
  const floor = positiveNumber(opts.planFloor, '--plan-floor', 20);
  if (floor > 100) usage('--plan-floor must not exceed 100');
  const deadline = deps.now() + timeout;
  let meter = { plan5h: null, planWeekly: null };
  let dialog = '';

  while (true) {
    const pollStarted = deps.now();
    const remaining = Math.max(1, deadline - pollStarted);
    const pollMs = Math.min(POLL_MS, remaining);
    const args = ['agent', 'wait', opts.name];
    // `blocked` is always asked for alongside whatever the caller wanted. The
    // flag repeats, and narrowing it to idle|done made the helper BLINDER than
    // bare `herdr agent wait`: a blocked lane timed out every poll, the exit-3
    // branch was unreachable, and `--until done --timeout 1800000` became a
    // 30-minute silent stall.
    for (const state of [...new Set([...untilStates, ...(untilStates.length > 0 ? ['blocked'] : [])])]) {
      args.push('--until', state);
    }
    args.push('--timeout', String(pollMs));
    const waited = call(deps, 'herdr', args);
    const stateAfter = waited.code === 0 ? responseState(waited.stdout, null) : null;

    // Order matters, and it is not the obvious one:
    //   1. a herdr that could not answer is an infra failure (1), never a
    //      plan-low reading taken from a stale pane;
    //   2. the captured refusal still pre-empts the lifecycle state, because
    //      herdr reports `idle` while that modal is up (C11(a), measured);
    //   3. a real settled state wins over the meter — work that finished is
    //      done whatever the footer says;
    //   4. the plan floor applies only to a lane that is still working.
    if (waited.code !== 0 && !/timeout/i.test(`${waited.stderr}\n${waited.stdout}`)) {
      throw new LaneError(EXIT.ERROR, `herdr agent wait failed: ${waited.stderr.trim() || waited.stdout.trim()}`);
    }

    // The read feeds plan metering and the dialog text only. A transient read
    // failure must not end a wait that herdr is still answering.
    const read = call(deps, 'herdr', ['agent', 'read', opts.name, '--lines', '40']);
    if (read.code === 0) {
      meter = scrapePlanMeter(read.stdout);
      dialog = responseText(read.stdout);
    }
    const refusal = read.code === 0 ? matchPlanRefusal(read.stdout) : null;
    if (refusal) {
      return {
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-refused', refusal, plan5h: meter.plan5h, planWeekly: meter.planWeekly },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter },
      };
    }

    if (waited.code === 0 && stateAfter === 'blocked') {
      return {
        exit: EXIT.BLOCKED,
        output: { state: 'blocked', dialog },
        row: { ...laneInstrumentation(opts.name, lane, 'blocked'), ...meter },
      };
    }
    if (waited.code === 0 && ['idle', 'done'].includes(stateAfter)) {
      return {
        exit: EXIT.OK,
        output: {
          state: stateAfter,
          notice: 'status is not evidence — run lane check',
        },
        row: { ...laneInstrumentation(opts.name, lane, stateAfter), ...meter },
      };
    }
    if (meter.plan5h !== null && meter.plan5h < floor) {
      return {
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-low', plan5h: meter.plan5h, planWeekly: meter.planWeekly, planFloor: floor },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-low'), ...meter },
      };
    }
    if (deps.now() >= deadline) {
      return {
        exit: EXIT.TIMEOUT,
        output: { state: 'timeout' },
        row: { ...laneInstrumentation(opts.name, lane, 'timeout'), ...meter },
      };
    }
    // One poll per second, not per 100ms: each poll spawns two herdr processes,
    // and a 120s wait was costing ~2,400 of them per lane.
    const elapsed = deps.now() - pollStarted;
    await deps.sleep(Math.max(0, Math.min(POLL_MS - elapsed, deadline - deps.now())));
  }
}

function parseFileExpectation(value, lanePath) {
  const searchFrom = /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0;
  const split = value.indexOf(':', searchFrom);
  const pathPart = split < 0 ? value : value.slice(0, split);
  const needle = split < 0 ? null : value.slice(split + 1);
  const path = isAbsolute(pathPart) ? resolve(pathPart) : resolve(lanePath ?? process.cwd(), pathPart);
  return { path, needle };
}

async function checkLane(opts, deps, state) {
  const lane = laneRecord(opts, state);
  const expectations = [opts.expectCommit ? 'commit' : null, opts.expectFile ? 'file' : null, opts.expectPr ? 'pr' : null].filter(Boolean);
  if (expectations.length !== 1) usage('check needs exactly one of --expect-commit, --expect-file, or --expect-pr');
  let failedExpectation = null;
  let evidence = null;

  if (opts.expectCommit) {
    if (!lane.path || !lane.base || !lane.branch) usage(`lane ${opts.name} has no worktree/base/branch metadata`);
    const count = call(deps, 'git', ['-C', lane.path, 'rev-list', '--count', `${lane.base}..${lane.branch}`]);
    // A git that could not answer is infrastructure, not a verdict about the
    // work — and 4 would have a conductor re-poll this forever. Ordinary
    // triggers: a base that is not a local ref, or a swept worktree.
    if (count.code !== 0) throw new LaneError(EXIT.ERROR, `git rev-list failed: ${count.stderr.trim()}`);
    const ahead = Number(count.stdout.trim());
    evidence = { commitsAhead: ahead };
    if (!Number.isInteger(ahead) || ahead < 1) failedExpectation = '--expect-commit: branch is not ahead of base by at least one commit';
  } else if (opts.expectFile) {
    const expected = parseFileExpectation(opts.expectFile, lane.path);
    evidence = { path: expected.path, needle: expected.needle };
    if (!deps.exists(expected.path)) {
      failedExpectation = `--expect-file: file does not exist: ${expected.path}`;
    } else if (expected.needle !== null && !deps.read(expected.path).includes(expected.needle)) {
      failedExpectation = `--expect-file: ${expected.path} does not contain ${JSON.stringify(expected.needle)}`;
    }
  } else {
    if (!/^\d+$/.test(String(opts.expectPr))) usage('--expect-pr must be a PR number');
    if (!lane.branch) usage(`lane ${opts.name} has no branch metadata`);
    const viewed = call(deps, 'gh', ['pr', 'view', String(opts.expectPr), '--json', 'headRefName,state'], { cwd: lane.path ?? undefined });
    if (viewed.code !== 0) {
      // "No such PR" is a failed expectation (5). Expired auth, no network or a
      // rate limit is infrastructure (1) — same family as the git call above.
      const detail = `${viewed.stderr}\n${viewed.stdout}`.trim();
      if (/no pull requests found|could not resolve to a pullrequest|not found/i.test(detail)) {
        failedExpectation = `--expect-pr ${opts.expectPr}: PR does not exist`;
      } else {
        throw new LaneError(EXIT.ERROR, `gh pr view failed: ${detail || `exit ${viewed.code}`}`);
      }
    } else {
      const doc = parseJson(viewed.stdout);
      evidence = doc;
      const prStatus = String(doc?.state ?? '').toUpperCase();
      if (doc?.headRefName !== lane.branch) {
        failedExpectation = `--expect-pr ${opts.expectPr}: head must equal ${lane.branch}, got ${doc?.headRefName ?? 'unknown'}`;
      } else if (!['OPEN', 'MERGED'].includes(prStatus)) {
        // A closed PR is abandoned work wearing the right head ref.
        failedExpectation = `--expect-pr ${opts.expectPr}: the PR is ${prStatus.toLowerCase() || 'in an unknown state'}, which is not a completion verdict`;
      }
    }
  }

  if (failedExpectation) {
    return {
      exit: EXIT.CHECK_FAILED,
      output: { ok: false, failedExpectation, evidence },
      row: laneInstrumentation(opts.name, lane, 'artifact-check-failed'),
    };
  }
  return {
    exit: EXIT.OK,
    output: { ok: true, evidence },
    row: laneInstrumentation(opts.name, lane, 'artifact-check-passed'),
  };
}

async function resumeLane(opts, deps, state) {
  const lane = laneRecord(opts, state);
  const timeout = positiveNumber(opts.timeout, '--timeout', 120_000);
  // C5 says never bare-wait here — a bare wait returns instantly on the stale
  // `blocked`. It said `--until idle`; the first live approval measured why that
  // is not enough: a lane started --no-focus is never "seen", so herdr settles
  // it to `done`, not `idle`, and the resume burned its full 120s and reported a
  // timeout while the approved work had already landed. Both settled states are
  // named; this is still not a bare wait.
  const raw = call(deps, 'herdr', [
    'agent', 'wait', opts.name, '--until', 'idle', '--until', 'done', '--timeout', String(timeout),
  ]);
  if (raw.code !== 0) {
    if (/timeout/i.test(`${raw.stderr}\n${raw.stdout}`)) {
      return { exit: EXIT.TIMEOUT, output: { state: 'timeout' }, row: laneInstrumentation(opts.name, lane, 'timeout') };
    }
    throw new LaneError(EXIT.ERROR, `herdr agent wait failed: ${raw.stderr.trim() || raw.stdout.trim()}`);
  }
  const stateAfter = responseState(raw.stdout, 'idle');
  if (stateAfter === 'blocked') {
    return { exit: EXIT.BLOCKED, output: { state: 'blocked' }, row: laneInstrumentation(opts.name, lane, 'blocked') };
  }
  return {
    exit: EXIT.OK,
    output: { state: stateAfter, notice: 'status is not evidence — run lane check' },
    row: laneInstrumentation(opts.name, lane, stateAfter),
  };
}

async function fallbackLane(opts, deps, state) {
  // Validate EVERY launch flag before touching the pane. `start`'s own
  // requirements used to fire after codex had already been quit: the lane was
  // left with no agent at all, still recorded as codex. Nothing here mutates.
  required(opts, 'to', 'model', 'reasoning');
  const prior = laneRecord(opts, state);
  if (prior.kind !== 'codex') usage('fallback is only valid for a codex lane');
  if (opts.to !== 'claude') usage('fallback --to must be claude');
  if (!prior.pane) usage(`lane ${opts.name} has no pane metadata`);
  if (!prior.promptFile || !deps.exists(prior.promptFile)) usage(`lane ${opts.name} has no existing prompt file to replay`);
  const samePane = prior.pane;
  const samePrompt = resolve(prior.promptFile);

  // C11(b): the rate-limit modal has to be dismissed and codex quit before the
  // pane will take a claude agent. Both sends are best-effort — the pane's own
  // shell prompt is the evidence that the pane is free, not their exit codes.
  call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'esc']);
  call(deps, 'herdr', ['agent', 'prompt', opts.name, '/quit']);
  await waitForPanePrompt(deps, samePane);

  // `verb` is not rewritten: an operator who ran `fallback` must not be told
  // that "start" is missing a flag.
  const started = await startLane({
    ...opts,
    pane: samePane,
    kind: 'claude',
    permissionMode: 'bypassPermissions',
    agentArgs: [],
  }, deps, state);
  const prompted = await promptLane({ ...opts, file: samePrompt }, deps, state);
  return {
    exit: EXIT.OK,
    output: {
      ...started.output,
      accepted: prompted.output.accepted,
      stateAfter: prompted.output.stateAfter,
      channelSwitch: { from: 'codex', to: 'claude', pane: samePane, promptFile: samePrompt },
    },
    row: {
      lane: opts.name,
      kind: 'claude',
      model: opts.model,
      reasoning: opts.reasoning ?? null,
      state: prompted.output.stateAfter,
      warning: started.row?.warning ?? null,
    },
  };
}

// A root is a LANE root when everything under it is a lane by construction —
// herdr's own worktrees directory. A workspace root is not: it holds data/ and
// projects/, and the delegate deletes with `Remove-Item -Recurse -Force`. A
// list-only run against one enumerated 77 candidate directories, including
// data/auto-memory, data/backups and data/memory.
function sweepRoots(opts, deps) {
  // An explicitly declared root is never filtered for existence — the operator
  // named it, and a silent skip would read as "swept". Its KIND is still
  // unknown, so it is treated as a non-lane root.
  if (Array.isArray(opts.root) && opts.root.length > 0) {
    return opts.root.map((root) => ({
      path: resolve(root),
      kind: 'declared',
      // A declared root is only a lane root when it IS a herdr worktrees
      // directory — the one shape where every child is a lane by construction.
      // Anything else is treated as a workspace: scoped, and no --force.
      laneRoot: /[\\/]\.herdr[\\/]worktrees[\\/]?$/i.test(resolve(root)),
    }));
  }
  const roots = [];
  // Legacy lanes: herdr's own default root, <profile>\.herdr\worktrees\<repo>\<lane>.
  if (deps.env.USERPROFILE) {
    roots.push({ path: join(deps.env.USERPROFILE, '.herdr', 'worktrees'), kind: 'herdr', laneRoot: true });
  }
  // C13 lanes: <workspace>\projects\<repo>-wt-<slug>. The delegate walks
  // <root>/<repo>/<lane>, so pointing it at <workspace>/projects would see
  // projects/<repo>/<subdir> and never find a lane — the workspace root is the
  // only root that works, which is exactly why every call against it must be
  // scoped to lanes this helper created.
  const workspace = opts.workspaceRoot ?? deps.env.WORKIT_WORKSPACE_ROOT ?? null;
  if (workspace) roots.push({ path: resolve(workspace), kind: 'workspace', laneRoot: false });
  if (roots.length === 0) {
    usage('sweep needs --root <path>, or --workspace-root / WORKIT_WORKSPACE_ROOT, to know where lanes live');
  }
  return roots;
}

// The lanes this helper actually created under a given root, by directory name.
// `creates[]` is the sidecar's record of every path it made — the only list of
// directories the sweeper is entitled to delete.
function knownLanesUnder(state, root) {
  const prefix = `${resolve(root)}${sep}`.toLowerCase();
  return [...new Set(
    (state.creates ?? [])
      .map((created) => created?.path)
      .filter((path) => typeof path === 'string' && resolve(path).toLowerCase().startsWith(prefix))
      .map((path) => basename(resolve(path))),
  )];
}

function sweepDelegate(opts, deps) {
  if (deps.env.HERDR_LANES_SCRIPT) return resolve(deps.env.HERDR_LANES_SCRIPT);
  const workspace = opts.workspaceRoot ?? deps.env.WORKIT_WORKSPACE_ROOT ?? null;
  if (workspace) return join(resolve(workspace), ...SWEEP_DELEGATE);
  return resolve(...SWEEP_DELEGATE);
}

async function sweepLanes(opts, deps, state) {
  const roots = sweepRoots(opts, deps);
  const delegate = sweepDelegate(opts, deps);
  // -Force removes HOLD verdicts too, and HOLD is the only thing standing
  // between an unfinished lane and `Remove-Item -Recurse -Force`. On a root
  // that is not a lane root, every directory two levels down is in range, so
  // the combination is refused rather than scoped.
  if (opts.force && roots.some((root) => !root.laneRoot)) {
    const named = roots.filter((root) => !root.laneRoot).map((root) => root.path).join(', ');
    usage(`--force is refused for a root that is not a herdr worktrees root (${named}): everything two levels below it would be in range. Sweep it by hand if you mean it.`);
  }

  // The delegate is LIST-ONLY without -Clean, and S8 wants the directory gone.
  const baseFlags = [];
  if (!opts.list) baseFlags.push('-Clean');
  if (opts.force) baseFlags.push('-Force');

  // One plan entry per delegate invocation. A non-lane root is only ever swept
  // with an explicit -Lane naming a directory this helper created.
  const plan = [];
  for (const root of roots) {
    if (root.laneRoot) {
      plan.push({ root: root.path, kind: root.kind, flags: opts.lane ? ['-Lane', opts.lane, ...baseFlags] : [...baseFlags] });
      continue;
    }
    const lanes = opts.lane ? [opts.lane] : knownLanesUnder(state, root.path);
    if (lanes.length === 0) {
      plan.push({ root: root.path, kind: root.kind, skipped: 'no known lanes under this root' });
      continue;
    }
    for (const lane of lanes) plan.push({ root: root.path, kind: root.kind, lane, flags: ['-Lane', lane, ...baseFlags] });
  }

  const present = plan.filter((entry) => !entry.skipped && deps.exists(entry.root));
  const missing = plan.filter((entry) => !entry.skipped && !deps.exists(entry.root)).map((entry) => entry.root);
  if (present.length === 0) {
    // A sweep that visited nothing is not a sweep. Reporting `swept` here was
    // the checker-over-zero-input read: exit 0 with the delegate never invoked.
    const declared = [...new Set(plan.map((entry) => entry.root))];
    return {
      exit: EXIT.ERROR,
      output: {
        delegated: false,
        state: 'no-roots-present',
        missingRoots: [...new Set(missing)],
        declaredRoots: declared,
        skipped: plan.filter((entry) => entry.skipped),
        roots: plan.map((entry) => ({ root: entry.root, ...(entry.skipped ? { skipped: entry.skipped } : { missing: true }) })),
      },
      row: { lane: null, state: 'no-roots-present' },
    };
  }

  if (!deps.exists(delegate)) {
    return {
      exit: EXIT.OK,
      output: {
        delegated: false,
        delegate,
        hint: 'set HERDR_LANES_SCRIPT, or --workspace-root / WORKIT_WORKSPACE_ROOT so infrastructure/herdr-lanes.ps1 resolves',
        commands: present.map((entry) => `pwsh -NoProfile -File "${delegate}" -WorktreeRoot "${entry.root}"${entry.flags.length > 0 ? ` ${entry.flags.join(' ')}` : ''}`),
      },
      row: { lane: null, state: 'delegate-missing' },
    };
  }

  // Every entry is visited. Throwing on the first nonzero exit left the C13
  // lanes unswept behind a failing legacy root — the alert-fan-out failure
  // where one dead target silences the rest.
  const results = present.map((entry) => {
    const swept = call(deps, 'pwsh', ['-NoProfile', '-File', delegate, '-WorktreeRoot', entry.root, ...entry.flags]);
    return {
      root: entry.root,
      ...(entry.lane ? { lane: entry.lane } : {}),
      ok: swept.code === 0,
      exit: swept.code,
      output: swept.stdout,
      ...(swept.code === 0 ? {} : { error: swept.stderr.trim() || swept.stdout.trim() }),
    };
  });
  const swept = results.filter((entry) => entry.ok);
  return {
    exit: swept.length === 0 ? EXIT.ERROR : EXIT.OK,
    output: {
      delegated: true,
      roots: [...results, ...plan.filter((entry) => entry.skipped).map((entry) => ({ root: entry.root, skipped: entry.skipped }))],
      sweptRoots: swept.length,
      totalRoots: results.length,
    },
    row: { lane: null, state: swept.length === results.length ? 'swept' : 'swept-partial' },
  };
}

export function matchPlanRefusal(text) {
  const source = responseText(text);
  for (const pattern of PLAN_REFUSAL_PATTERNS) {
    if (!pattern.test(source)) continue;
    const line = source.split(/\r?\n/).find((candidate) => pattern.test(candidate));
    return (line ?? pattern.exec(source)[0]).trim();
  }
  return null;
}

export function scrapePlanMeter(text) {
  // C11 says the LAST FOOTER LINE, not the last match in the buffer: mixing
  // lines returns a live 5h figure beside a stale weekly one.
  const source = String(text).split(/\r?\n/).filter((line) => /(?:5h|weekly)\s+\d+%\s+left/i.test(line)).at(-1) ?? '';
  const five = /5h\s+(\d+)%\s+left/i.exec(source);
  const weekly = /weekly\s+(\d+)%\s+left/i.exec(source);
  return { plan5h: five ? Number(five[1]) : null, planWeekly: weekly ? Number(weekly[1]) : null };
}

function appendRow(deps, logPath, row) {
  deps.mkdir(dirname(logPath));
  deps.append(logPath, `${JSON.stringify(row)}\n`);
}

export async function runLane(argv, overrides = {}) {
  const deps = {
    exec: execute,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, value) => writeFileSync(path, value, 'utf8'),
    writeNew: (path, value) => writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' }),
    remove: (path) => rmSync(path, { force: true }),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    stat: (path) => statSync(path),
    warn: (message) => console.error(message),
    append: (path, value) => appendFileSync(path, value, 'utf8'),
    env: process.env,
    platform: process.platform,
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    findCodexBin: defaultFindCodexBin,
    ...overrides,
  };

  const started = deps.now();
  let opts;
  try {
    opts = parseArgs(argv);
    Object.assign(opts, resolveLogPath(opts, deps));
  } catch (error) {
    const { log, logSource } = logPathFromArgv(argv, deps);
    const output = { error: error.message, ...(error.details ?? {}) };
    const row = {
      ...emptyRow(deps), verb: argv[0] ?? null, state: 'usage-error',
      waitMs: deps.now() - started, exit: error.code ?? EXIT.USAGE, error: error.message,
    };
    appendRow(deps, log, row);
    return { exit: error.code ?? EXIT.USAGE, output, row, log, logSource };
  }

  const baseRow = {
    ...emptyRow(deps),
    lane: opts.name ?? opts.label ?? opts.branch ?? null,
    verb: opts.verb,
    kind: opts.kind ?? null,
    model: opts.model ?? null,
    reasoning: opts.reasoning ?? null,
  };
  let result;
  try {
    const state = loadState(deps, opts.log);
    switch (opts.verb) {
      case 'create': result = await createLane(opts, deps, state); break;
      case 'start': result = await startLane(opts, deps, state); break;
      case 'prompt': result = await promptLane(opts, deps, state); break;
      case 'wait': result = await waitLane(opts, deps, state); break;
      case 'check': result = await checkLane(opts, deps, state); break;
      case 'resume': result = await resumeLane(opts, deps, state); break;
      case 'fallback': result = await fallbackLane(opts, deps, state); break;
      case 'sweep': result = await sweepLanes(opts, deps, state); break;
      default: throw new LaneError(EXIT.USAGE, `${opts.verb} is not implemented yet`);
    }
    result.exit ??= EXIT.OK;
  } catch (error) {
    // An unclassified throw is an infrastructure failure, not a deadline.
    const code = error instanceof LaneError ? error.code : EXIT.ERROR;
    result = { exit: code, output: { error: error.message, ...(error.details ?? {}) }, row: { state: 'failed' } };
  }

  const row = {
    ...baseRow,
    ...(result.row ?? {}),
    waitMs: deps.now() - started,
    exit: result.exit,
    error: result.output?.error ?? null,
  };
  appendRow(deps, opts.log, row);
  return { exit: result.exit, output: result.output, row, log: opts.log, logSource: opts.logSource };
}

function emptyRow(deps) {
  return {
    ts: deps.timestamp(),
    lane: null,
    verb: null,
    kind: null,
    model: null,
    reasoning: null,
    state: null,
    waitMs: 0,
    exit: EXIT.OK,
    plan5h: null,
    planWeekly: null,
    warning: null,
    error: null,
  };
}

async function main() {
  const result = await runLane(process.argv.slice(2));
  // Announce the resolved output root and the rule that produced it (once, on
  // stderr so stdout stays a single JSON document).
  if (result.log) console.error(`lane: log ${result.log} (resolved from ${result.logSource})`);
  if (result.output?.warning) console.error(`lane: warning — ${result.output.warning}`);
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exit;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
