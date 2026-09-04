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
           [--mcp-startup-timeout <sec>]
           [-- <native agent args>]
           dontAsk is always refused; default mode needs --allow-default-mode.
           Codex defaults Serena's startup timeout to 3 seconds; a caller-supplied
           mcp_servers.<server>.startup_timeout_sec config is left unchanged.
  prompt   <name> --file <abs>          Sends only "Read <file> and execute it exactly."
  wait     <name> [--until blocked|idle|done]... --timeout <ms> [--plan-floor <pct>]
           --until repeats: a blocked-only wait cannot see a lane that finished.
           Naming any state adds blocked; a bare wait forwards none (herdr's
           default already matches idle|done|blocked).
  check    <name> --expect-commit | --expect-file <path>[:needle] | --expect-pr <n>
  resume   <name> [--timeout <ms>]      Waits --until idle --until done, never bare.
  fallback <name> --to claude --model <slug> --reasoning <lvl>
  stop     <name> [--timeout <ms>]  Stops the lane agent and verifies it exited.
  sweep    [--root <path>]... [--workspace-root <abs>] [--lane <name>] [--list] [--force]
           --lane <name> limits the delegate to one lane; --list is a dry run.
           Outside a herdr worktrees root, every call is scoped to a lane this
           helper created (from the sidecar), and --force is refused there.
           The delegate is HERDR_LANES_SCRIPT, else <workspace-root>/infrastructure/
           herdr-lanes.ps1, else that path from the cwd; if none exists, sweep
           prints the command to run instead of guessing a location.

  --log <path>  JSONL instrumentation (default: <workspace>/data/outputs/projects/
                agentic-practice-transfer/lanes/lane-log.jsonl, else ./lane-log.jsonl)
  --prompt-regex <re>  How this box's shell prompt looks (or LANE_PROMPT_REGEX).
                Otherwise the pane's own prompt, captured at start, is the
                signature; default shapes are the last resort.`;
// Seeded only from a captured refusal, never an invented one. This string was
// read off lane O's pane at 2026-09-01 22:12Z; herdr reported that agent as
// `idle` the whole time the modal was up, so the pane text is the only signal.
export const PLAN_REFUSAL_PATTERNS = Object.freeze([
  /^\s*■\s*You've hit your usage limit/i,
  /^\s*Approaching rate limits\s+—\s+Switch to /i,
]);
// Captured from the first-run trust interstitial. Keep these together: this is
// a launch recovery, not a generic attempt to dismiss arbitrary Codex UI.
export const HOOKS_TRUST_PATTERNS = Object.freeze([
  /hooks need review/i,
  /press t to trust/i,
  /plugin\s*-\s*browser/i,
]);
// The sweep delegate's location is resolved, never hardcoded: this file ships in
// a public repo, and one operator's drive layout is not a default. Order:
// HERDR_LANES_SCRIPT, then <workspace-root>/infrastructure/herdr-lanes.ps1
// (--workspace-root or WORKIT_WORKSPACE_ROOT), then the same relative path from
// the cwd. When none of them resolves, `sweep` prints the command to run.
const SWEEP_DELEGATE = ['infrastructure', 'herdr-lanes.ps1'];
const POLL_MS = 1_000;
const LOG_BASENAME = 'lane-log.jsonl';
const LOG_SUBPATH = ['data', 'outputs', 'projects', 'agentic-practice-transfer', 'lanes'];
const VERBS = new Set(['create', 'start', 'prompt', 'wait', 'check', 'resume', 'fallback', 'stop', 'sweep']);

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
    '--plan-floor', '--path', '--slug', '--workspace-root', '--lane', '--prompt-regex', '--mcp-startup-timeout',
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
  // Refused here, for every verb: a prompt pattern that cannot compile is a
  // typo the operator wants told about, not a setting to fall back from.
  if (opts.promptRegex !== undefined) {
    try {
      new RegExp(opts.promptRegex);
    } catch (error) {
      usage(`--prompt-regex is not a usable regular expression: ${error.message}`);
    }
  }
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

async function acquireLock(deps, lock, attempts = 50, contents = null) {
  const started = deps.now();
  let holder = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      deps.mkdir(dirname(lock));
      deps.writeNew(lock, contents ?? `${deps.timestamp()}\n`);
      const release = () => { try { deps.remove(lock); } catch { /* already gone */ } };
      release.waitedMs = deps.now() - started;
      release.holder = holder;
      return release;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // The start lock has a small JSON receipt so a collision can name the
      // lane already launching instead of making the operator guess.
      try {
        const parsed = JSON.parse(deps.read(lock));
        holder = typeof parsed?.lane === 'string' ? parsed.lane : holder;
      } catch { /* legacy timestamp-only locks have no owner */ }
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

function hasMcpStartupTimeoutConfig(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    if (/^mcp_servers\.[^.]+\.startup_timeout_sec=/.test(String(args[i + 1] ?? ''))) return true;
  }
  return false;
}

function mcpStartupTimeoutValue(args) {
  for (let i = 0; i < args.length; i++) {
    const match = args[i] === '-c' && /^mcp_servers\.[^.]+\.startup_timeout_sec=(.+)$/.exec(String(args[i + 1] ?? ''));
    if (match) return Number(match[1]);
  }
  return null;
}

function startCollision(result) {
  return /agent_pane_busy/i.test(`${result.stderr}\n${result.stdout}`);
}

function bareShellWithoutAgent(deps, pane) {
  const snapshot = readPane(deps, pane);
  if (snapshot.code !== 0 || !paneAtPrompt(snapshot.stdout)) return false;
  const listing = call(deps, 'herdr', ['agent', 'list']);
  if (listing.code !== 0) return false;
  const agents = listedAgents(listing.stdout);
  return Array.isArray(agents) && !agents.some((agent) => (agent?.pane_id ?? agent?.paneId) === pane);
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
//
// But shape is a weak instrument, and this box proves it: the pwsh prompt here
// is two oh-my-posh lines whose last line is
//   ~  home / .herdr / worktrees / workit / feat-lane-helper ~
// with no `>`, `❯` or `$` anywhere. No default set can match every prompt, so
// shapes are the LAST resort. In order: an operator-declared regex, then the
// pane's own recorded signature, then these.
const DEFAULT_PROMPT_PATTERNS = Object.freeze([
  /^PS\s+\S.*>$/,          // PowerShell
  /^[A-Za-z]:\\.*>$/,      // cmd
  /^[>$#]$/,               // a BARE prompt character, never a line ending in one
  /^.*[❯➜λ]$/,             // oh-my-posh / starship glyphs, which prose does not end with
]);

// A live TUI is not a free pane. The veto looks at the last two non-empty lines
// only: a quit agent leaves its frame in the scrollback above the fresh prompt,
// and vetoing on the whole snapshot would reject the very pane we are waiting
// for. A live TUI always draws its footer at the bottom.
const LIVE_TUI = [
  /[─━]{6,}/,
  /shift\+tab to cycle/i,
  /esc to interrupt/i,
  /Ask Codex/i,
  /←\s*for agents/i,
  /⏵⏵/,
  /Context \d+% left/i,
];

function paneLines(text) {
  return responseText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// The pane's own prompt is the only prompt that matters. Its last non-empty
// line is the stable half — the first oh-my-posh line carries a clock and a
// command duration, which change between reads.
export function panePromptSignature(text) {
  const lines = paneLines(text);
  return lines.length > 0 ? lines.at(-1) : null;
}

export function paneAtPrompt(text, { signature = null, patterns = DEFAULT_PROMPT_PATTERNS } = {}) {
  const lines = paneLines(text);
  if (lines.length === 0) return false;
  const last = lines.at(-1);
  if (signature && last === String(signature).trim()) return true;
  if (LIVE_TUI.some((pattern) => lines.slice(-2).some((line) => pattern.test(line)))) return false;
  return patterns.some((pattern) => pattern.test(last));
}

// An operator who knows their prompt can say so; anything unparseable is a
// usage error rather than a silently ignored setting.
function promptPatterns(opts, deps) {
  const declared = opts.promptRegex ?? deps.env.LANE_PROMPT_REGEX ?? null;
  if (!declared) return DEFAULT_PROMPT_PATTERNS;
  try {
    return [new RegExp(declared)];
  } catch (error) {
    usage(`--prompt-regex / LANE_PROMPT_REGEX is not a usable regular expression: ${error.message}`);
    return DEFAULT_PROMPT_PATTERNS;
  }
}

function paneIsCodexReady(text, options) {
  const hasExecutable = paneLines(text).some((line) => /(?:^|[\\/])codex\.exe\s*$/i.test(line));
  return hasExecutable && paneAtPrompt(text, options);
}

function readPane(deps, pane) {
  return call(deps, 'herdr', ['pane', 'read', pane, '--source', 'detection', '--lines', '40']);
}

// Records what THIS pane's prompt looks like while it is known to be idle, so a
// later wait can match the pane against itself instead of against a guess.
//
// It polls, because a freshly created pane has not drawn its prompt yet: read
// immediately after `lane create` and the snapshot is empty, which is how the
// first live run recorded `promptSignature: null` for both lanes — and a null
// signature silently drops `fallback` back to the shape guess this exists to
// replace. Bounded and non-fatal: a lane still starts if the pane stays quiet.
async function capturePromptSignature(deps, pane, options, timeoutMs = 5_000) {
  const deadline = deps.now() + timeoutMs;
  let signature = null;
  do {
    const snapshot = readPane(deps, pane);
    if (snapshot.code === 0) {
      signature = panePromptSignature(snapshot.stdout);
      if (signature) return signature;
    }
    await deps.sleep(250);
  } while (deps.now() < deadline);
  return signature;
}

async function waitForPanePrompt(deps, pane, options = {}, timeoutMs = 30_000) {
  const deadline = deps.now() + timeoutMs;
  do {
    const snapshot = readPane(deps, pane);
    if (snapshot.code === 0 && paneAtPrompt(snapshot.stdout, options)) return;
    await deps.sleep(100);
  } while (deps.now() < deadline);
  // A wedged pane is infrastructure, not the operator's deadline: 4 belongs to
  // `lane wait` alone, and prepareCodexPane already raises ERROR for the same
  // shape of failure.
  throw new LaneError(EXIT.ERROR, `pane ${pane} never returned to a shell prompt${options.signature ? ` (${JSON.stringify(options.signature)})` : ''}`);
}

function laneSlug(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) usage('could not derive a worktree slug from the branch; pass --slug');
  return slug;
}

async function prepareCodexPane(opts, deps, signature) {
  // Windows-only by C12 (startLane refuses codex elsewhere), and `npm` on PATH
  // here is npm.ps1 — a shim execFileSync cannot launch — so it is routed
  // through cmd.exe rather than spawned directly.
  const patterns = promptPatterns(opts, deps);
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
    const snapshot = readPane(deps, opts.pane);
    if (snapshot.code === 0 && paneIsCodexReady(snapshot.stdout, { signature, patterns })) return;
    await deps.sleep(100);
  } while (deps.now() < deadline);
  throw new LaneError(EXIT.ERROR, `timed out waiting for codex.exe and the shell prompt in pane ${opts.pane}${signature ? ` (${JSON.stringify(signature)})` : ''}`);
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
    if (deps.platform === 'win32' && sandbox === 'workspace-write') {
      usage('codex workspace-write sandbox is refused on Windows: unified exec can time out connecting its runner pipe; use danger-full-access instead');
    }
    native = withoutConfig(withoutOption(withoutOption(withoutOption(native, '--sandbox'), '--ask-for-approval'), '--model'), 'model_reasoning_effort');
    native = [
      '--model', opts.model, '--ask-for-approval', 'never', '--sandbox', sandbox,
      '-c', `model_reasoning_effort=${opts.reasoning}`, ...native,
    ];
    const mcpStartupTimeoutSec = positiveNumber(opts.mcpStartupTimeout, '--mcp-startup-timeout', 3);
    if (!hasMcpStartupTimeoutConfig(native)) {
      native.push('-c', `mcp_servers.serena.startup_timeout_sec=${mcpStartupTimeoutSec}`);
    }
  }

  // A sidecar write lock prevents lost state; this separate, longer-lived lock
  // prevents two launches from both claiming the same shell between writes.
  const startLock = await acquireLock(
    deps,
    `${opts.log}.start.lock`,
    600,
    `${JSON.stringify({ lane: opts.name, startedAt: deps.timestamp() })}\n`,
  );
  const waitedForStartLockMs = startLock.waitedMs;
  try {
    // Every refusal above is herdr-free; the first call happens only once the
    // launch is known to be legal. This read is the last moment the pane is known
    // to be a shell — once an agent owns it, its prompt is gone until the agent
    // quits, which is exactly when `fallback` has to recognise it again.
    const patterns = promptPatterns(opts, deps);
    let pane = opts.pane;
    let paneSplitFrom = null;
    let promptSignature = null;
    let raw = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      promptSignature = await capturePromptSignature(deps, pane, { patterns });
      if (opts.kind === 'codex') await prepareCodexPane({ ...opts, pane }, deps, promptSignature);
      const started = call(deps, 'herdr', ['agent', 'start', opts.name, '--kind', opts.kind, '--pane', pane, '--', ...native]);
      if (started.code === 0) {
        raw = started.stdout;
        break;
      }
      const recoverable = startCollision(started) || (isTimeoutFailure(started) && bareShellWithoutAgent(deps, pane));
      if (!recoverable || attempt > 0) {
        const detail = started.stderr.trim() || started.stdout.trim();
        const holder = startLock.holder ? ` while ${startLock.holder} was starting` : '';
        throw new LaneError(EXIT.ERROR, `herdr agent start failed${holder}${detail ? `: ${detail}` : ''}`);
      }
      const split = call(deps, 'herdr', ['pane', 'split', pane, '--direction', 'right']);
      if (split.code !== 0) {
        const detail = split.stderr.trim() || split.stdout.trim();
        const holder = startLock.holder ? `; other in-flight lane: ${startLock.holder}` : '';
        throw new LaneError(EXIT.ERROR, `agent target pane ${pane} was busy and pane split fallback failed${holder}${detail ? `: ${detail}` : ''}`);
      }
      const splitResult = unwrapResult(split.stdout);
      const newPane = firstDefined(splitResult, ['pane_id', 'paneId']) ?? deepFind(splitResult, ['pane_id', 'paneId']);
      if (!newPane) throw new LaneError(EXIT.ERROR, `agent target pane ${pane} was busy and pane split returned no pane id`);
      paneSplitFrom ??= pane;
      pane = String(newPane);
    }
    if (raw === null) throw new LaneError(EXIT.ERROR, `agent start did not return a result for ${opts.name}`);
  // The agent is live from here on. Record it BEFORE asserting anything about
  // the world: a focus check that threw here once left a running agent with no
  // state row, and `lane wait` then answered "unknown lane" — the exact blind
  // lane this helper exists to prevent.
    await mergeState(deps, opts.log, state, (draft) => {
    const existing = draft.lanes[opts.name] ?? {};
    const byPath = existing.path
      ? draft.creates.find((created) => created.path && resolve(created.path) === resolve(existing.path))
      : null;
    const prior = byPath ?? draft.creates.find((created) => created.paneId === opts.pane || created.paneId === pane) ?? {};
    draft.lanes[opts.name] = {
      ...existing,
      pane,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning ?? null,
      // A fallback re-starts an existing lane, and its `creates` lookup misses:
      // without the existing fallbacks this nulls the lane's identity and
      // `lane check` — the completion verdict (C2) — is forfeited for good.
      branch: prior.branch ?? existing.branch ?? null,
      base: prior.base ?? existing.base ?? null,
      path: prior.path ?? existing.path ?? null,
      promptSignature: promptSignature ?? existing.promptSignature ?? null,
      ...(paneSplitFrom ? { paneSplitFrom } : {}),
    };
  });

    let hooksTrusted = false;
    if (opts.kind === 'codex') {
      const trust = readPane(deps, pane);
      if (trust.code === 0 && HOOKS_TRUST_PATTERNS.some((pattern) => pattern.test(responseText(trust.stdout)))) {
        call(deps, 'herdr', ['agent', 'send-keys', opts.name, 't']);
        call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'esc']);
        readPane(deps, pane);
        hooksTrusted = true;
      }
    }

    const focus = restoreFocus(deps);
    const warnings = [warning, focus.warning].filter(Boolean);
    const mcpStartupTimeoutSec = opts.kind === 'codex'
      ? (mcpStartupTimeoutValue(opts.agentArgs) ?? positiveNumber(opts.mcpStartupTimeout, '--mcp-startup-timeout', 3))
      : null;
    return {
    output: {
      agent: agentName(raw) ?? opts.name,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning,
      startedAt: deps.timestamp(),
      focus: focus.focus,
      ...(mcpStartupTimeoutSec !== null ? { mcpStartupTimeoutSec } : {}),
      ...(waitedForStartLockMs > 0 ? { waitedForStartLockMs } : {}),
      ...(hooksTrusted ? { hooksTrusted: true } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    },
    row: {
      lane: opts.name,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning ?? null,
      state: 'started',
      ...(mcpStartupTimeoutSec !== null ? { mcpStartupTimeoutSec } : {}),
      ...(waitedForStartLockMs > 0 ? { waitedForStartLockMs } : {}),
      ...(hooksTrusted ? { hooksTrusted: true } : {}),
      warning: warnings.length > 0 ? warnings.join('; ') : null,
    },
    };
  } finally {
    startLock();
  }
}

async function promptLane(opts, deps, state) {
  required(opts, 'file');
  if (!opts.name) usage('prompt needs <name>');
  const file = resolve(opts.file);
  if (!deps.exists(file)) usage(`prompt file does not exist: ${file}`);
  const wire = `Read ${file} and execute it exactly.`;
  const lane = state.lanes[opts.name] ?? {};
  const initial = agentState(deps, opts.name);
  if (!initial) throw new LaneError(EXIT.ERROR, `prompt agent state check failed: ${opts.name} is not listed`);
  const queued = initial.state === 'working';
  const promptArgs = ['agent', 'prompt', opts.name, wire, ...(queued ? [] : ['--wait', '--until', 'working'])];
  let sent = call(deps, 'herdr', promptArgs);
  let enterRetries = 0;
  let stateAfter = queued ? 'working' : responseState(sent.stdout, initial.state ?? 'working');
  if (sent.code !== 0 && !/agent_prompt_stalled|timeout/i.test(`${sent.stderr}\n${sent.stdout}`)) {
    const detail = sent.stderr.trim() || sent.stdout.trim();
    throw new LaneError(EXIT.ERROR, `herdr agent prompt failed${detail ? `: ${detail}` : ''}`);
  }
  if (sent.code !== 0) {
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'enter']);
    enterRetries++;
    const reread = agentState(deps, opts.name);
    stateAfter = reread?.state ?? stateAfter;
  }

  const composerStalled = () => {
    if (!lane.pane) return false;
    const pane = readPane(deps, lane.pane);
    if (pane.code !== 0) return false;
    const last = paneLines(pane.stdout).at(-1) ?? '';
    return stateAfter !== 'working' && last.startsWith('›') && last.includes('execute it exactly');
  };
  if (composerStalled()) {
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'enter']);
    enterRetries++;
    const reread = agentState(deps, opts.name);
    stateAfter = reread?.state ?? stateAfter;
    if (composerStalled()) throw new LaneError(EXIT.ERROR, `composer not submitted for ${opts.name} after Enter retry`);
  }
  await mergeState(deps, opts.log, state, (draft) => {
    draft.lanes[opts.name] = { ...(draft.lanes[opts.name] ?? lane), promptFile: file };
  });
  return {
    output: { accepted: deepFind(unwrapResult(sent.stdout), ['accepted']) ?? true, queued, enterRetries, stateAfter },
    row: { lane: opts.name, kind: lane.kind ?? null, model: lane.model ?? null, reasoning: lane.reasoning ?? null, state: stateAfter, queued, enterRetries },
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
  // Named `until`, not `state`: the lane-state parameter is in scope here.
  for (const until of untilStates) {
    if (!['blocked', 'idle', 'done'].includes(until)) usage('wait --until must be blocked, idle, or done');
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
    for (const until of [...new Set([...untilStates, ...(untilStates.length > 0 ? ['blocked'] : [])])]) {
      args.push('--until', until);
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
    if (waited.code !== 0 && !isTimeoutFailure(waited)) {
      throw new LaneError(EXIT.ERROR, `herdr agent wait failed: ${waited.stderr.trim() || waited.stdout.trim()}`);
    }

    // The read feeds plan metering and the dialog text only. A transient read
    // failure must not end a wait that herdr is still answering.
    const plan = readPlanState(deps, opts.name);
    if (plan.ok) {
      meter = plan.meter;
      dialog = plan.dialog;
    }
    const refusal = plan.refusal;
    const refusalEligible = refusal && (
      (meter.plan5h !== null && meter.plan5h <= floor) || ['idle', 'done'].includes(stateAfter)
    );
    if (refusalEligible) {
      return {
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-refused', refusal, refusalShape: plan.refusalShape, plan5h: meter.plan5h, planWeekly: meter.planWeekly },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter, refusalShape: plan.refusalShape },
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
    // Without the lane's path, `gh` runs with cwd undefined and answers about
    // whatever repo the conductor happens to be sitting in — a verdict about
    // the wrong thing is worse than no verdict.
    if (!lane.path) {
      throw new LaneError(EXIT.ERROR, `lane ${opts.name} has no worktree path; gh would answer about the conductor's own repo`);
    }
    const viewed = call(deps, 'gh', ['pr', 'view', String(opts.expectPr), '--json', 'headRefName,state'], { cwd: lane.path ?? undefined });
    if (viewed.code !== 0) {
      // "No such PR" is a failed expectation (5). Anything else — a missing gh,
      // a missing repo, expired auth, no network, a rate limit — is
      // infrastructure (1). The classifier matches only the shapes gh uses for
      // "that PR isn't there": a bare `not found` also matches
      // "gh: command not found" and "repository not found", which are not
      // verdicts about the work. Unrecognised failures default to infra.
      const detail = `${viewed.stderr}\n${viewed.stdout}`.trim();
      const noSuchPr = /no pull requests found|could not resolve to a pullrequest/i.test(detail);
      if (noSuchPr) {
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
    if (isTimeoutFailure(raw)) {
      return { exit: EXIT.TIMEOUT, output: { state: 'timeout' }, row: laneInstrumentation(opts.name, lane, 'timeout') };
    }
    throw new LaneError(EXIT.ERROR, `herdr agent wait failed: ${raw.stderr.trim() || raw.stdout.trim()}`);
  }
  // The same pane scrape `wait` runs: the plan meter and the captured refusal
  // belong to the lane, not to the verb that happened to look. C11(a) again —
  // herdr reports `idle` while that modal is up, so this outranks the state.
  const plan = readPlanState(deps, opts.name);
  const meter = plan.meter ?? { plan5h: null, planWeekly: null };
  const refusalEligible = plan.refusal && (
    (meter.plan5h !== null && meter.plan5h <= 20) || ['idle', 'done'].includes(responseState(raw.stdout, null))
  );
  if (refusalEligible) {
    return {
      exit: EXIT.PLAN_LOW,
      output: { state: 'plan-refused', refusal: plan.refusal, refusalShape: plan.refusalShape, ...meter },
      row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter, refusalShape: plan.refusalShape },
    };
  }
  const statusAfter = responseState(raw.stdout, 'idle');
  if (statusAfter === 'blocked') {
    return {
      exit: EXIT.BLOCKED,
      output: { state: 'blocked', dialog: plan.dialog },
      row: { ...laneInstrumentation(opts.name, lane, 'blocked'), ...meter },
    };
  }
  return {
    exit: EXIT.OK,
    output: { state: statusAfter, notice: 'status is not evidence — run lane check' },
    row: { ...laneInstrumentation(opts.name, lane, statusAfter), ...meter },
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
  call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'ctrl+c']);
  call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'ctrl+c']);
  // The pane's own recorded prompt is the evidence — no shape guess can cover
  // every shell (this box's prompt ends in `~`, with no prompt character at all).
  await waitForPanePrompt(deps, samePane, {
    signature: prior.promptSignature ?? null,
    patterns: promptPatterns(opts, deps),
  });

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

function listedAgents(raw) {
  const agents = deepFind(unwrapResult(raw), ['agents']);
  return Array.isArray(agents) ? agents : null;
}

function listedAgentNames(raw) {
  const agents = listedAgents(raw);
  return Array.isArray(agents) ? agents.map((agent) => agent?.name ?? agent?.agent).filter((name) => typeof name === 'string') : null;
}

function agentState(deps, name) {
  const listing = call(deps, 'herdr', ['agent', 'list']);
  if (listing.code !== 0) return null;
  const agents = listedAgents(listing.stdout);
  if (!agents) return null;
  const agent = agents.find((entry) => (entry?.name ?? entry?.agent) === name);
  if (!agent) return null;
  return { agent, state: String(agent.state ?? agent.status ?? 'unknown').toLowerCase() };
}

async function stopLane(opts, deps, state) {
  const lane = laneRecord(opts, state);
  if (!lane.pane) usage(`lane ${opts.name} has no pane metadata`);
  const timeout = positiveNumber(opts.timeout, '--timeout', 30_000);
  if (lane.kind === 'codex') {
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'esc']);
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'ctrl+c']);
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'ctrl+c']);
  } else if (lane.kind === 'claude') {
    call(deps, 'herdr', ['agent', 'prompt', opts.name, '/exit']);
  } else {
    usage(`lane ${opts.name} has unsupported kind: ${lane.kind}`);
  }
  try {
    await waitForPanePrompt(deps, lane.pane, {
      signature: lane.promptSignature ?? null,
      patterns: promptPatterns(opts, deps),
    }, timeout);
  } catch (error) {
    // Codex can draw its exit banner and only then repaint the prompt. Give
    // that hand-off one short second look before calling a completed exit a
    // failure; the agent listing is the deciding signal.
    await deps.sleep(5_000);
    const latePane = readPane(deps, lane.pane);
    const lateListing = call(deps, 'herdr', ['agent', 'list']);
    const lateNames = lateListing.code === 0 ? listedAgentNames(lateListing.stdout) : null;
    const lateText = latePane.code === 0 ? responseText(latePane.stdout) : '';
    const latePrompt = latePane.code === 0 && paneAtPrompt(latePane.stdout, {
      signature: lane.promptSignature ?? null,
      patterns: promptPatterns(opts, deps),
    });
    const exitBanner = /(?:goodbye|exited|codex.*(?:exit|closed)|PS\s+\S.*>)$/im.test(lateText);
    if (Array.isArray(lateNames) && !lateNames.includes(opts.name) && (latePrompt || exitBanner)) {
      return {
        exit: EXIT.OK,
        output: { state: 'stopped', panePrompt: true, agentListed: false, promptCheck: 'late' },
        row: { ...laneInstrumentation(opts.name, lane, 'stopped'), promptCheck: 'late' },
      };
    }
    if (Array.isArray(lateNames) && lateNames.includes(opts.name)) {
      throw new LaneError(EXIT.ERROR, `stop agent list check failed: ${opts.name} is still listed after late prompt check`);
    }
    throw new LaneError(EXIT.ERROR, `stop pane prompt check failed: ${error.message}`);
  }
  const listing = call(deps, 'herdr', ['agent', 'list']);
  if (listing.code !== 0) throw new LaneError(EXIT.ERROR, `stop agent list check failed: ${listing.stderr.trim() || listing.stdout.trim()}`);
  const names = listedAgentNames(listing.stdout);
  if (!names) throw new LaneError(EXIT.ERROR, 'stop agent list check failed: response did not contain agents');
  if (names.some((name) => name === opts.name)) throw new LaneError(EXIT.ERROR, `stop agent list check failed: ${opts.name} is still listed`);
  return { exit: EXIT.OK, output: { state: 'stopped', panePrompt: true, agentListed: false }, row: laneInstrumentation(opts.name, lane, 'stopped') };
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
// directories the sweeper is entitled to delete. A lane record contributes its
// agent name only when its path exactly matches one of those creates.
// Returns the sidecar's own spelling of the requested lane, or null. Windows
// paths are case-insensitive, so a casing mismatch there is the same directory,
// not a different one — and the delegate is handed the recorded name either way.
function matchKnownLane(known, lane, deps) {
  if (deps.platform === 'win32') {
    const wanted = String(lane).toLowerCase();
    return known.find((entry) => [entry.agentName, entry.label, entry.basename].some((name) => name?.toLowerCase() === wanted))?.basename ?? null;
  }
  return known.find((entry) => [entry.agentName, entry.label, entry.basename].includes(lane))?.basename ?? null;
}

function knownLanesUnder(state, root, deps) {
  // Same casing rule as the lane name: fold on win32, respect it elsewhere.
  const fold = (value) => (deps.platform === 'win32' ? value.toLowerCase() : value);
  const prefix = fold(`${resolve(root)}${sep}`);
  const creates = (state.creates ?? []).filter((created) => {
    const path = created?.path;
    return typeof path === 'string' && fold(resolve(path)).startsWith(prefix);
  });
  const paths = new Map(creates.map((created) => [fold(resolve(created.path)), created]));
  for (const [agentName, lane] of Object.entries(state.lanes ?? {})) {
    if (typeof lane?.path !== 'string' || !fold(resolve(lane.path)).startsWith(prefix)) continue;
    const key = fold(resolve(lane.path));
    if (paths.has(key)) paths.get(key).agentName = agentName;
  }
  return [...paths.values()].map((created) => ({
    agentName: created.agentName ?? null,
    label: created.label ?? null,
    path: resolve(created.path),
    basename: basename(resolve(created.path)),
  }));
}

function delegateRootForLane(lanePath, deps) {
  const resolvePath = deps.resolve ?? resolve;
  const resolvedLane = resolvePath(lanePath);
  const delegateRoot = dirname(dirname(resolvedLane));
  const fold = (value) => (deps.platform === 'win32' ? value.toLowerCase() : value);
  const ancestor = `${resolvePath(delegateRoot)}${sep}`;
  if (dirname(delegateRoot) === delegateRoot || !fold(resolvedLane).startsWith(fold(ancestor))) {
    usage(`cannot derive a safe delegate root for lane ${resolvedLane}: ${delegateRoot} is not a non-root ancestor`);
  }
  return delegateRoot;
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
  // C6: `--lane` is intersected with the sidecar on EVERY root, never trusted
  // on its own: an operator-typed string is not evidence that this helper
  // created that directory, and the delegate deletes with -Recurse -Force. A
  // `lanes[<name>].path` is admitted only when it exactly equals a
  // `creates[].path`; creates[] remains the sole delete authority. The herdr
  // root is no exception — everything under it is a lane, but not necessarily
  // OUR lane, and --force is permitted there.
  let laneFound = false;
  for (const root of roots) {
    const known = knownLanesUnder(state, root.path, deps);
    const requested = opts.lane ? matchKnownLane(known, opts.lane, deps) : null;
    // A named lane lives under exactly one root; the others simply have nothing
    // to do, which is not a refusal.
    if (opts.lane && !requested) continue;
    laneFound = laneFound || Boolean(requested);

    if (root.laneRoot) {
      const record = requested ? known.find((entry) => entry.basename === requested) : null;
      plan.push({
        root: root.path,
        kind: root.kind,
        ...(requested ? { lane: requested } : {}),
        ...(record ? { lanePath: record.path, delegateRoot: delegateRootForLane(record.path, deps) } : {}),
        flags: requested ? ['-Lane', requested, ...baseFlags] : [...baseFlags],
      });
      continue;
    }
    const lanes = requested ? [requested] : known.map((entry) => entry.basename);
    if (lanes.length === 0) {
      plan.push({ root: root.path, kind: root.kind, skipped: 'no known lanes under this root' });
      continue;
    }
    for (const lane of lanes) {
      const record = known.find((entry) => entry.basename === lane);
      const lanePath = record?.path ?? join(root.path, lane);
      plan.push({ root: root.path, kind: root.kind, lane, lanePath, delegateRoot: delegateRootForLane(lanePath, deps), flags: ['-Lane', lane, ...baseFlags] });
    }
  }
  if (opts.lane && !laneFound) {
    const known = roots.map((root) => ({ root: root.path, matches: knownLanesUnder(state, root.path, deps).map((entry) => ({
      agentNames: entry.agentName ? [entry.agentName] : [], labels: entry.label ? [entry.label] : [], basenames: [entry.basename],
    })) }));
    usage(`--lane ${opts.lane} is not a lane this helper created under any swept root; nothing in the sidecar lanes[] or creates[] matches. Agent names come from lanes[] only when their path equals a creates[] path; labels and basenames come from creates[]. Known spellings by root: ${JSON.stringify(known)}. Sweep it by hand if you mean it.`);
  }

  const present = plan.filter((entry) => !entry.skipped && deps.exists(entry.delegateRoot ?? entry.root));
  const missing = plan.filter((entry) => !entry.skipped && !deps.exists(entry.delegateRoot ?? entry.root)).map((entry) => entry.delegateRoot ?? entry.root);
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
    // Nonzero: the exit code is the machine-readable half of the contract, and
    // nothing was swept. The runnable command is still in the payload.
    return {
      exit: EXIT.ERROR,
      output: {
        delegated: false,
        delegate,
        hint: 'set HERDR_LANES_SCRIPT, or --workspace-root / WORKIT_WORKSPACE_ROOT so infrastructure/herdr-lanes.ps1 resolves',
        commands: present.map((entry) => `pwsh -NoProfile -File "${delegate}" -WorktreeRoot "${entry.delegateRoot ?? entry.root}"${entry.flags.length > 0 ? ` ${entry.flags.join(' ')}` : ''}`),
      },
      row: { lane: null, state: 'delegate-missing' },
    };
  }

  // Every entry is visited. Throwing on the first nonzero exit left the C13
  // lanes unswept behind a failing legacy root — the alert-fan-out failure
  // where one dead target silences the rest.
  const results = present.map((entry) => {
    const swept = call(deps, 'pwsh', ['-NoProfile', '-File', delegate, '-WorktreeRoot', entry.delegateRoot ?? entry.root, ...entry.flags]);
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
  // A delegate HOLD is useful only if it identifies the pane that prevented
  // cleanup. Query live records only when one was reported, preserving the
  // normal sweep's one-call-per-root behavior.
  const held = results.filter((entry) => /\bHOLD\b/i.test(entry.output));
  let holds = [];
  if (held.length > 0) {
    const listing = call(deps, 'herdr', ['agent', 'list']);
    const agents = listing.code === 0 ? listedAgents(listing.stdout) : null;
    if (Array.isArray(agents)) {
      holds = agents.map((agent) => {
        const pane = agent?.pane_id ?? agent?.paneId ?? '<unknown-pane>';
        const name = agent?.name ?? agent?.agent ?? '<unnamed>';
        const state = String(agent?.state ?? agent?.status ?? 'unknown').toLowerCase();
        const snapshot = pane === '<unknown-pane>' ? null : readPane(deps, pane);
        const ghost = name === '<unnamed>' && ['idle', 'done'].includes(state)
          && snapshot?.code === 0 && paneAtPrompt(snapshot.stdout);
        return {
          pane,
          agent: name,
          state,
          ...(ghost ? { ghost: true } : {}),
          message: ghost
            ? `HOLD on ${pane} by ${name} (ghost: true); remove by hand with herdr workspace close <ws> then git worktree remove`
            : `HOLD on ${pane} by ${name}`,
        };
      });
    }
  }
  return {
    exit: swept.length === 0 ? EXIT.ERROR : EXIT.OK,
    output: {
      delegated: true,
      roots: [...results, ...plan.filter((entry) => entry.skipped).map((entry) => ({ root: entry.root, skipped: entry.skipped }))],
      sweptRoots: swept.length,
      totalRoots: results.length,
      ...(holds.length > 0 ? { holds } : {}),
    },
    row: { lane: null, state: swept.length === results.length ? 'swept' : 'swept-partial' },
  };
}

// herdr answers failures with {"error":{"code":"…"}}. Read the code; the word
// "timeout" can appear in a message that is not one.
function isTimeoutFailure(result) {
  const parsed = parseJson(result.stderr) ?? parseJson(result.stdout);
  const code = parsed?.error?.code;
  if (typeof code === 'string') return code === 'timeout';
  return /timeout/i.test(`${result.stderr}\n${result.stdout}`);
}

// One pane read, shared by `wait` and `resume`: the plan meter and the captured
// refusal are properties of the lane, not of the verb that happened to look.
function readPlanState(deps, name) {
  const read = call(deps, 'herdr', ['agent', 'read', name, '--lines', '40']);
  if (read.code !== 0) return { ok: false, meter: null, refusal: null, refusalShape: null, dialog: '' };
  const refusal = planRefusal(read.stdout);
  return {
    ok: true,
    meter: scrapePlanMeter(read.stdout),
    refusal: refusal?.line ?? null,
    refusalShape: refusal?.shape ?? null,
    dialog: responseText(read.stdout),
  };
}

function planRefusal(text) {
  const source = responseText(text);
  const lines = source.split(/\r?\n/);
  const banner = lines.find((line) => PLAN_REFUSAL_PATTERNS[0].test(line));
  if (banner) return { shape: 'banner', line: banner.trim() };
  const modal = lines.find((line) => PLAN_REFUSAL_PATTERNS[1].test(line));
  if (modal && /(?:^|\n)\s*(?:›\s*)?1\.\s*Switch\b/i.test(source)) return { shape: 'modal', line: modal.trim() };
  return null;
}

export function matchPlanRefusal(text) {
  return planRefusal(text)?.line ?? null;
}

export function scrapePlanMeter(text) {
  // C11 says the LAST FOOTER LINE, not the last match in the buffer: mixing
  // lines returns a live 5h figure beside a stale weekly one. Unwrap first —
  // an enveloped response is one JSON line, which silently turns "last footer
  // line" into "first match" (measured: enveloped 80%, plain 9%).
  const source = responseText(text).split(/\r?\n/).filter((line) => /(?:5h|weekly)\s+\d+%\s+left/i.test(line)).at(-1) ?? '';
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
      case 'stop': result = await stopLane(opts, deps, state); break;
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
