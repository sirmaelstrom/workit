#!/usr/bin/env node
/**
 * One-step lane lifecycle helper. Each invocation emits one JSON document and
 * appends one JSONL instrumentation row. No prompt body is ever shell-parsed.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// The exit contract a conductor branches on:
//   0 ok · 1 herdr/infra failure · 2 usage, refused before any mutation
//   3 blocked (+ dialog) · 4 a wait deadline expired · 5 artifact check failed
//   6 plan-low or a captured plan refusal
//   7 admission refused: free commit memory below the admit threshold, or unread
//   8 capacity: the turn ended on codex's "model is at capacity" banner; re-prompt
// 4 means a deadline and nothing else. A dead daemon that reports as a timeout
// is re-polled forever by a conductor that trusts this table.
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, BLOCKED: 3, TIMEOUT: 4, CHECK_FAILED: 5, PLAN_LOW: 6, ADMIT_REFUSED: 7, CAPACITY: 8 });
export const EXIT_CODES = Object.freeze({ ok: 0, error: 1, usage: 2, blocked: 3, timeout: 4, artifactCheckFailed: 5, planLow: 6, admitRefused: 7, capacity: 8 });

export const USAGE_TEXT = `lane <verb> [options] — one lane lifecycle step per invocation, JSON on stdout.

  create   --repo <abs> --branch <b> --base <ref> --label <text>
           [--path <abs>] [--slug <text>] [--workspace-root <abs>]
           Roots the lane at <repo>-wt-<slug> under the projects tree (C13).
  start    <name> --pane <id> --kind claude|codex --model <slug> --reasoning <lvl>
           [--sandbox <mode>] [--permission-mode <mode>] [--allow-default-mode]
           [--mcp-startup-timeout <sec> --mcp-startup-server <name>]
           [--min-free-gb <n>] [--force-admit] [-- <native agent args>]
           Refused (exit 7) below --min-free-gb of free commit memory (or
           LANE_MIN_FREE_GB, default 10) or when the reading fails; --force-admit
           starts anyway and is logged. fallback is exempt: it swaps one agent
           for another in the same pane.
           dontAsk is always refused; default mode needs --allow-default-mode.
           Codex has no default MCP startup timeout. Opt in with the timeout/server
           pair; a caller-supplied mcp_servers.<server>.startup_timeout_sec wins.
  prompt   <name> --file <abs>          Sends only "Read <file> and execute it exactly."
           [--amendment (--ruling-receipt <uuid> --quest <id> | --no-ruling)]
           Any prompt after the lane's first is an amendment, --amendment or not,
           and states whether it acts on an operator ruling. A named receipt must
           resolve through WORKIT_RECEIPT_RESOLVER to an answered receipt on that
           quest; with no resolver configured it is refused.
  wait     <name> [--until blocked|idle|done]... --timeout <ms> [--plan-floor <pct>]
           --until repeats: a blocked-only wait cannot see a lane that finished.
           Naming any state adds blocked; a bare wait forwards none (herdr's
           default already matches idle|done|blocked). A codex lane's idle/done
           must hold on a second poll 3 s later. A turn that ended on codex's
           "Selected model is at capacity" banner exits 8 (retryable). A settled
           Claude lane whose transcript's last entry since its prompt is the
           plan's usage limit exits 6 as plan-refused (refusalShape transcript,
           rateLimitType, resetsAt). A Claude
           lane whose status bar still shows background work ("· 1 shell ·") is
           not settled: at the deadline it exits 4 as settled-background-live.
           stdout is the verdict alone; the row counts pollCount and pollTimeouts.
  check    <name> --expect-commit | --expect-file <path>[:needle] | --expect-pr <n>
           | --expect-report <path>
           --expect-report and --expect-pr (on the PR body) require ## Debrief with
           both headings, and every question under ## Needs conductor in a lettered
           ask (a)…(f): at most six options per ask, no letter twice.
  resume   <name> [--timeout <ms>] [--plan-floor <pct>]
           Waits --until idle --until done, never bare; honours --plan-floor.
           One read, no poll loop: a codex lane whose rollout shows its turn
           still running exits 4 as settled-turn-live.
  fallback <name> --to claude --model <slug> --reasoning <lvl>
  stop     <name> [--timeout <ms>]  Stops the lane agent; a late shell/banner
           check is accepted only after the live-TUI veto. A Claude lane gone
           from the listing whose pane still ends in its resume footer exits 1
           with state "exited-shell-blocked" and its resumeId. Then reaps the
           lane's worktree (see reap); when the reaped process was what held
           the shell, a returned prompt makes the stop "stopped" (after-reap).
  reap     <name> | --path <abs> [--list]
           Kills every process whose command line names the lane's worktree
           (a dev server that outlived the agent), with its tree, then lists
           again: exit 1 for a survivor or an unreadable list. --list kills
           nothing. stop runs it after the agent exits; sweep --lane runs it
           on a lane the delegate lists SAFE (or HOLD under --force), and
           leaves a lane with a survivor uncleaned.
  sweep   [--root <path>]... [--workspace-root <abs>] [--lane <name>] [--list] [--force]
           --lane <name> limits the delegate to one lane; --list is a dry run.
           Outside a herdr worktrees root, every call is scoped to a lane this
           helper created (from the sidecar), and --force is refused there.
           The delegate is HERDR_LANES_SCRIPT, else <workspace-root>/infrastructure/
           herdr-lanes.ps1, else that path from the cwd; if none exists, sweep
           prints the command to run instead of guessing a location.
  admit    [--min-free-gb <n>] [--drain-free-gb <n>] [--require-reading]
           Read-only admission check, for a conductor before a start or a council
           dispatch: exit 0 admitted, 7 refused. Prints freeGb, the thresholds,
           and drain: true below --drain-free-gb (or LANE_DRAIN_FREE_GB, default 4).
           Off Windows freeGb is null and the check admits with a warning, unless
           --require-reading, which refuses a reading it cannot take.

  --log <path>  JSONL instrumentation (default: <workspace>/data/outputs/projects/
                agentic-practice-transfer/lanes/lane-log.jsonl, else ./lane-log.jsonl)
  --prompt-regex <re>  How this box's shell prompt looks (or LANE_PROMPT_REGEX).
                Otherwise the pane's own prompt, captured at start, is the
                signature; default shapes are the last resort.
  start serializes for about 120s per --log sidecar (not across different logs),
        splits a busy pane once, and logs waitedForStartLockMs, paneSplitFrom,
        hooksTrusted, folderTrusted, queued, enterRetries, composerCleared, promptCheck,
        ghost, and refusalShape.`;
// Seeded only from a captured refusal, never an invented one. This string was
// read off lane O's pane at 2026-09-01 22:12Z; herdr reported that agent as
// `idle` the whole time the modal was up, so the pane text is the only signal.
export const PLAN_REFUSAL_PATTERNS = Object.freeze([
  /^\s*■\s*You've hit your usage limit/i,
  /^\s*Approaching rate limits\s+—\s+Switch to /i,
]);
// Read off lane ored's pane, 2026-10-01 23:36Z: `■ Selected model is at
// capacity. Please try a different model.`, after which herdr settled the
// agent to done mid-amendment. Retryable, unlike the usage limit.
export const CAPACITY_PATTERN = /^\s*■\s*Selected model is at capacity\b/i;
// The banner counts only near the bottom: below it a live codex draws the
// composer and the footer, so it sits a few lines up. Higher is scrollback
// from an earlier turn.
const CAPACITY_TAIL_LINES = 6;
// Captured from the first-run trust interstitial. Keep these together: this is
// a launch recovery, not a generic attempt to dismiss arbitrary Codex UI.
export const HOOKS_TRUST_PATTERNS = Object.freeze([
  /hooks need review/i,
  /press t to trust/i,
]);
// Claude Code's folder-trust dialog on a directory it has never opened, read off
// a scratch pane at 2026-09-26 21:25Z (claude --model claude-haiku-4-5-20251001
// in a fresh %TEMP% dir). `herdr agent start` fails on it with agent_not_ready.
// The options draw as `❯ No, exit` then `Yes, I trust this folder`, cursor on
// No; Down then Enter selects trust and the composer follows. The first pattern
// is the opening words of the question, which a narrow pane still keeps on
// one line.
export const FOLDER_TRUST_PATTERNS = Object.freeze([
  /Quick safety check/i,
  /Yes, I trust this folder/i,
]);
const FOLDER_TRUST_CURSOR_ON_NO = /^❯\s*No, exit\b/;
const FOLDER_TRUST_FOOTER = /Enter to confirm/i;
const FOLDER_TRUST_KEYS = Object.freeze(['Down', 'Enter']);
// The dialog is 9 non-blank lines from its top rule to its footer, as read;
// 3 more cover the question wrapping in a narrower pane. Only this block,
// ending at the pane's last non-blank line, is the current dialog.
const FOLDER_TRUST_BLOCK_LINES = 12;
// The trusted screen, read the same run, ends in the mode line
// `⏸ manual mode on · ← for agents`, drawn below the composer and a
// statusline. Claude Code draws it last, so a mode line anywhere else is an
// older frame with something newer under it. The other shapes are LIVE_TUI's.
const CLAUDE_MODE_LINE = /←\s*for agents|shift\+tab to cycle|⏵⏵/i;
// A Claude lane that ends its turn with its own background shell or Monitor
// still running is herdr-settled, but the real hand-back comes later, when the
// monitor wakes it. Claude Code 2.1.289 says so in the mode line below the
// composer: `⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← for agents`.
// The segment sits within the first two non-blank lines below the composer's
// bottom rule (a configured statusline, then the mode line); a subagent panel
// draws further down, so counting from the rule, not from the pane's end, keeps
// the match. Three lines leave one for a wrapped mode line.
const CLAUDE_COMPOSER_RULE = /^\s*─{8,}\s*$/;
const CLAUDE_STATUS_LINES = 3;
const CLAUDE_BACKGROUND_KIND = String.raw`\d+\s+(?:shell|monitor)s?`;
const CLAUDE_BACKGROUND_SEGMENT = new RegExp(String.raw`·\s+(${CLAUDE_BACKGROUND_KIND}(?:,\s+${CLAUDE_BACKGROUND_KIND})*)\s+(?:·|$)`);
const FOLDER_TRUST_TIMEOUT_MS = 15_000;
// The sweep delegate's location is resolved, never hardcoded: this file ships in
// a public repo, and one operator's drive layout is not a default. Order:
// HERDR_LANES_SCRIPT, then <workspace-root>/infrastructure/herdr-lanes.ps1
// (--workspace-root or WORKIT_WORKSPACE_ROOT), then the same relative path from
// the cwd. When none of them resolves, `sweep` prints the command to run.
const SWEEP_DELEGATE = ['infrastructure', 'herdr-lanes.ps1'];
const POLL_MS = 1_000;
const SETTLE_CONFIRM_MS = 3_000;
const LOG_BASENAME = 'lane-log.jsonl';
const LOG_SUBPATH = ['data', 'outputs', 'projects', 'agentic-practice-transfer', 'lanes'];
const VERBS = new Set(['create', 'start', 'prompt', 'wait', 'check', 'resume', 'fallback', 'stop', 'reap', 'sweep', 'admit']);
// Operator rulings of 2026-10-01 (quest 93d4855b), in GB of free commit memory.
const ADMIT_MIN_FREE_GB = 10;
const ADMIT_DRAIN_FREE_GB = 4;

class LaneError extends Error {
  // `row` carries instrumentation a refusal must still log (the JSONL row of a
  // throw is otherwise just { state: 'failed' }).
  constructor(code, message, details = {}, row = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.row = row;
  }
}

// `timeout` (ms) kills a child that has not exited by then; the kill reads as
// a failure (code 1), never as a hang. Unset, the child may run indefinitely.
export function execute(program, args, { cwd, input, timeout } = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync(program, args, {
        cwd,
        input,
        ...(timeout ? { timeout } : {}),
        // execFileSync's default copies the child's stderr to ours as well as
        // capturing it: every herdr poll timeout of a long `wait` reached the
        // conductor's task output (~50 KB a wait). Captured is enough; failures
        // already carry it.
        stdio: ['pipe', 'pipe', 'pipe'],
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

// herdr agent names must start with a lowercase letter and hold only [a-z0-9_-], 1–32 characters.
// A lane name built from a long goal slug breaks that, so herdr sees a stable alias: the name when it
// already fits, else a cleaned prefix plus a 6-character hash of the full name. Every herdr verb that
// takes an agent name, and every agent-list comparison, goes through this one mapping.
const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HERDR_NAMED_VERBS = new Set(['start', 'send-keys', 'prompt', 'wait', 'stop', 'read', 'focus']);

export function herdrAgentName(name) {
  const text = String(name);
  if (HERDR_AGENT_NAME.test(text)) return text;
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const tag = hash.toString(36).padStart(6, '0').slice(-6);
  const clean = text.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, '') || 'lane';
  return `${clean.slice(0, 32 - tag.length - 1).replace(/[-_]+$/, '') || 'lane'}-${tag}`;
}

function herdrArgs(program, args) {
  if (program !== 'herdr' || args[0] !== 'agent' || !HERDR_NAMED_VERBS.has(args[1]) || typeof args[2] !== 'string') return args;
  // `agent focus` takes a pane id (`w2P:p1`), never an agent name: leave it as it is.
  if (args[1] === 'focus' && args[2].includes(':')) return args;
  return [args[0], args[1], herdrAgentName(args[2]), ...args.slice(3)];
}

function call(deps, program, args, options = {}) {
  const result = deps.exec(program, herdrArgs(program, args), options);
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

function isHelpRequest(verb) {
  return verb === undefined || ['--help', '-h', 'help'].includes(verb);
}

function parseArgs(argv) {
  const [verb, ...tokens] = argv;
  if (isHelpRequest(verb)) {
    throw new LaneError(EXIT.USAGE, 'lane needs one verb', { usage: USAGE_TEXT });
  }
  if (!VERBS.has(verb)) {
    throw new LaneError(EXIT.USAGE, `expected one verb: ${[...VERBS].join(', ')}`, { usage: USAGE_TEXT });
  }
  const opts = { verb, positional: [], agentArgs: [] };
  const booleanFlags = new Set(['--expect-commit', '--live', '--force', '--list', '--allow-default-mode', '--amendment', '--no-ruling', '--force-admit', '--require-reading']);
  const repeatableFlags = new Set(['--root', '--until']);
  const valueFlags = new Set([
    '--repo', '--branch', '--base', '--label', '--pane', '--kind', '--model', '--reasoning', '--sandbox',
    '--permission-mode', '--file', '--timeout', '--expect-file', '--expect-pr', '--expect-report', '--to', '--log',
    '--plan-floor', '--path', '--slug', '--workspace-root', '--lane', '--prompt-regex', '--mcp-startup-timeout', '--mcp-startup-server',
    '--ruling-receipt', '--quest', '--min-free-gb', '--drain-free-gb',
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
  if (verb !== 'prompt' && (opts.amendment || opts.noRuling || opts.rulingReceipt !== undefined || opts.quest !== undefined)) {
    usage(`--amendment, --ruling-receipt, --quest and --no-ruling belong to the prompt verb, not ${verb}`);
  }
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
  return { lanes: {}, creates: [], ghostCandidates: [] };
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
    return { lanes: parsed.lanes ?? {}, creates: parsed.creates ?? [], ghostCandidates: parsed.ghostCandidates ?? [] };
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
    state.ghostCandidates = fresh.ghostCandidates;
    return fresh;
  } finally {
    release();
  }
}

const LOCK_STALE_MS = 60_000;
// Two split-path passes can each spend 5s capturing + 30s preparing, followed
// by agent start and trust handling. 120s leaves one full pass plus margin.
const START_LOCK_STALE_MS = 120_000;

async function acquireLock(deps, lock, attempts = 50, contents = null, staleMs = LOCK_STALE_MS) {
  const started = deps.now();
  let holder = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      deps.mkdir(dirname(lock));
      deps.writeNew(lock, contents ?? `${deps.timestamp()}\n`);
      const expected = String(contents ?? '').trim();
      const release = () => {
        try {
          // A stale-lock reclaimer may own this path now. Never delete its lock.
          if (!expected || String(deps.read(lock)).trim() === expected) deps.remove(lock);
        } catch { /* already gone or unreadable */ }
      };
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
      if (age !== null && age > staleMs) {
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
    if (/^mcp_servers\..+\.startup_timeout_sec=/.test(String(args[i + 1] ?? ''))) return true;
  }
  return false;
}

function startCollision(result) {
  return /agent_pane_busy/i.test(`${result.stderr}\n${result.stdout}`);
}

function startupBlocked(result) {
  return /agent_not_ready|blocked during startup/i.test(`${result.stderr}\n${result.stdout}`);
}

// The dialog as measured, and only as the CURRENT frame: a pane read carries
// scrollback, so the footer must be the last non-blank line, and both patterns
// and the cursor on No must sit in the block it closes. Any other shape is left
// alone, because Down+Enter on a dialog that changed could select "No, exit".
export function folderTrustDialog(text) {
  const lines = paneLines(text);
  if (!FOLDER_TRUST_FOOTER.test(lines.at(-1) ?? '')) return false;
  const block = lines.slice(-FOLDER_TRUST_BLOCK_LINES);
  return FOLDER_TRUST_PATTERNS.every((pattern) => block.some((line) => pattern.test(line)))
    && block.some((line) => FOLDER_TRUST_CURSOR_ON_NO.test(line));
}

// Positive readiness after the answer: the mode line is the last non-blank
// line. Nothing above it is read, so an older Claude frame in scrollback, the
// dialog, an empty redraw frame or a newer startup prompt is not ready; a
// frame caught before the mode line is drawn waits for the next poll.
export function claudeTuiReady(text) {
  return CLAUDE_MODE_LINE.test(paneLines(text).at(-1) ?? '');
}

// Answers the folder-trust dialog in `pane` and waits for a Claude frame;
// returns false, having sent nothing, when the pane does not show the dialog.
// No Claude frame by the deadline is exit 3 with the pane's tail.
async function answerFolderTrust(deps, pane) {
  const snapshot = readPane(deps, pane);
  if (snapshot.code !== 0 || !folderTrustDialog(snapshot.stdout)) return false;
  for (const key of FOLDER_TRUST_KEYS) callOrFail(deps, 'herdr', ['pane', 'send-keys', pane, key]);
  const deadline = deps.now() + FOLDER_TRUST_TIMEOUT_MS;
  let last = snapshot.stdout;
  do {
    await deps.sleep(250);
    const after = readPane(deps, pane);
    if (after.code === 0) {
      last = after.stdout;
      if (claudeTuiReady(last)) return true;
    }
  } while (deps.now() < deadline);
  throw new LaneError(EXIT.BLOCKED, `folder-trust dialog in pane ${pane} was answered with ${FOLDER_TRUST_KEYS.join('+')} but no Claude mode line was drawn last within ${FOLDER_TRUST_TIMEOUT_MS} ms`, {
    dialog: paneLines(last).slice(-12).join('\n'),
  });
}

function bareShellWithoutAgent(deps, pane, promptOptions = {}) {
  const snapshot = readPane(deps, pane);
  if (snapshot.code !== 0 || !paneAtPrompt(snapshot.stdout, promptOptions)) return false;
  const listing = call(deps, 'herdr', ['agent', 'list']);
  if (listing.code !== 0) return false;
  const agents = listedAgents(listing.stdout);
  return Array.isArray(agents) && !agents.some((agent) => (agent?.pane_id ?? agent?.paneId) === pane);
}

function refreshLock(deps, lock, owner) {
  try {
    if (String(deps.read(lock)).trim() === String(owner).trim()) deps.touch(lock);
  } catch { /* another owner won the path */ }
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

// Composer safety needs the original indentation: a quoted transcript line is
// not a live composer line, even though its trimmed text begins with `›`.
function paneRawLines(text) {
  return responseText(text).split(/\r?\n/).filter((line) => line.trim());
}

// What a shell prints when its profile throws at pane start: PowerShell's
// concise view (`InvalidOperation: …`, then `Line |` / `12 | …` / `| ~~~`
// frame lines) and its classic view (`At line:1 char:1`, `+ CategoryInfo …`).
// None of these is ever a prompt.
const PANE_ERROR_LINES = Object.freeze([
  /^[A-Z][A-Za-z]+(?:Exception|Error)?: \S/,
  /^Line \|$/,
  /^\d+ \|/,
  /^\|/,
  /^At (?:line:\d+|.+:\d+) char:\d+$/,
  /^\+ /,
]);

export const paneErrorLine = (line) => PANE_ERROR_LINES.some((pattern) => pattern.test(String(line ?? '').trim()));

// The pane's own prompt is the only prompt that matters. Its last non-empty
// line that is not error output is the stable half — the first oh-my-posh
// line carries a clock and a command duration, which change between reads.
export function panePromptSignature(text) {
  return paneLines(text).findLast((line) => !paneErrorLine(line)) ?? null;
}

export function paneAtPrompt(text, { signature = null, patterns = DEFAULT_PROMPT_PATTERNS } = {}) {
  const lines = paneLines(text);
  if (lines.length === 0) return false;
  const last = lines.at(-1);
  if (signature && last === String(signature).trim()) return true;
  if (LIVE_TUI.some((pattern) => lines.slice(-2).some((line) => pattern.test(line)))) return false;
  return patterns.some((pattern) => pattern.test(last));
}

// Claude prints these two lines when it exits. As the pane's TAIL, with nothing
// drawn below, they mean Claude is gone but the shell has not redrawn its
// prompt; a footer with the prompt under it is an ordinary exit.
const CLAUDE_RESUME_HINT = 'Resume this session with:';
const CLAUDE_RESUME_LINE = /^claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// The resume id when the pane ends in Claude's exit footer, else null.
function claudeExitFooterTail(text) {
  const lines = paneLines(text);
  if (lines.length < 2 || lines.at(-2) !== CLAUDE_RESUME_HINT) return null;
  return CLAUDE_RESUME_LINE.exec(lines.at(-1))?.[1] ?? null;
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

// A Codex TUI still loading its session. Measured on codex 0.156.1 (2026-09-24,
// quest 7e1fecf7): the composer placeholder is drawn ~0.4 s after launch while the
// header still reads `model: loading`; the footer appears ~1.4 s in, still loading;
// the header names the model at ~2.1 s. A prompt sent into that window can be
// dropped by the redraw — W5 (2026-09-22) saw the banner drawn twice, an empty
// composer and `Context 100% left`, while herdr reported the agent `working`.
const CODEX_LOADING = /^│?\s*(?:model|directory):\s+loading\b/i;
const CODEX_BANNER = /OpenAI Codex \(v/;
const CODEX_FOOTER = /Context \d+% left/i;
// Loading took ~2.1 s on a warm box; the budget is for a cold start. The echo
// appeared ~1.3 s after Enter.
const CODEX_LOAD_TIMEOUT_MS = 60_000;
const CODEX_DELIVERY_TIMEOUT_MS = 5_000;

export function codexTuiLoading(text) {
  const lines = paneLines(text);
  if (lines.some((line) => CODEX_LOADING.test(line))) return true;
  return lines.some((line) => CODEX_BANNER.test(line)) && !lines.some((line) => CODEX_FOOTER.test(line));
}

// POSITIVE readiness: a Codex frame with its footer drawn and nothing loading. "Not
// loading" is not enough — an empty pane, or the shell prompt before the first paint,
// is not loading either (workit#107 review, codex).
export function codexTuiReady(text) {
  return paneLines(text).some((line) => CODEX_FOOTER.test(line)) && !codexTuiLoading(text);
}

// The live composer starts at the LAST column-zero `›` line; a long prompt wraps, so
// everything from there down (continuation lines, footer) is composer, not transcript
// (workit#107 review, astra). Transcript echoes of earlier prompts sit above it.
function codexTranscript(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('›')) return lines.slice(0, i);
  return lines;
}

function codexEvidence(text, needle) {
  const lines = paneLines(text);
  return {
    echoes: codexTranscript(lines).filter((line) => line.includes(needle)).length,
    working: lines.filter((line) => /esc to interrupt/i.test(line)).length,
  };
}

// Whether THIS submission reached the Codex session. After Enter the transcript
// echoes the prompt above a `Working (… esc to interrupt)` line and the composer
// returns to its placeholder (measured, same run). The context meter is no signal:
// it stays at 100% until the reply completes. Evidence is counted against the
// pre-send frame, so an echo or working line left by an EARLIER turn is not proof
// (workit#107 review, codex + astra). `unknown` = the pane does not look like a
// Codex TUI at all; the caller must not treat that as a failed delivery.
export function codexPromptDelivery(text, needle, before = null) {
  const lines = paneLines(text);
  if (!lines.some((line) => CODEX_BANNER.test(line) || CODEX_FOOTER.test(line) || /Ask Codex/i.test(line))) return 'unknown';
  const now = codexEvidence(text, needle);
  const then = before === null ? { echoes: 0, working: 0 } : codexEvidence(before, needle);
  return now.working > then.working || now.echoes > then.echoes ? 'delivered' : 'missing';
}

// Returns the ready frame: it is the pre-send evidence baseline.
async function waitForCodexReady(deps, pane, timeoutMs) {
  const deadline = deps.now() + timeoutMs;
  do {
    const snapshot = readPane(deps, pane);
    if (snapshot.code === 0 && codexTuiReady(snapshot.stdout)) return snapshot.stdout;
    await deps.sleep(250);
  } while (deps.now() < deadline);
  throw new LaneError(EXIT.ERROR, `codex TUI in pane ${pane} was not ready after ${timeoutMs} ms (still loading, not yet painted, or unreadable); prompt not sent`);
}

async function readCodexDelivery(deps, pane, needle, before, timeoutMs) {
  const deadline = deps.now() + timeoutMs;
  let verdict = 'unknown';
  do {
    const snapshot = readPane(deps, pane);
    if (snapshot.code !== 0) return 'unknown';
    verdict = codexPromptDelivery(snapshot.stdout, needle, before);
    if (verdict !== 'missing') return verdict;
    await deps.sleep(250);
  } while (deps.now() < deadline);
  return verdict;
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
// A pane that ends in error output has not finished starting (or its profile
// threw after the prompt): it is read again until the deadline, and then the
// last line above the error output is taken.
async function capturePromptSignature(deps, pane, options, timeoutMs = 5_000) {
  const deadline = deps.now() + timeoutMs;
  let signature = null;
  do {
    const snapshot = readPane(deps, pane);
    if (snapshot.code === 0) {
      signature = panePromptSignature(snapshot.stdout) ?? signature;
      if (signature && !paneErrorLine(paneLines(snapshot.stdout).at(-1))) return signature;
    }
    await deps.sleep(250);
  } while (deps.now() < deadline);
  return signature;
}

async function waitForPanePrompt(deps, pane, options = {}, timeoutMs = 30_000) {
  const deadline = deps.now() + timeoutMs;
  let last = null;
  do {
    const snapshot = readPane(deps, pane);
    if (snapshot.code === 0 && paneAtPrompt(snapshot.stdout, options)) return;
    last = snapshot.code === 0 ? (paneLines(snapshot.stdout).at(-1) ?? '') : null;
    await deps.sleep(100);
  } while (deps.now() < deadline);
  // A wedged pane is infrastructure, not the operator's deadline: 4 belongs to
  // `lane wait` alone, and prepareCodexPane already raises ERROR for the same
  // shape of failure. The message quotes the line the pane ENDED on: quoting
  // only the expected prompt invited a match against prompt text higher up.
  const seen = last === null ? 'the last pane read failed' : `its last line was ${JSON.stringify(last.length > 200 ? `${last.slice(0, 200)}…` : last)}`;
  const expected = options.signature ? `, not the recorded prompt ${JSON.stringify(options.signature)}` : '';
  throw Object.assign(new LaneError(EXIT.ERROR, `pane ${pane} never returned to a shell prompt: ${seen}${expected}`), { lastLine: last });
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

function gbOption(value, flag, envValue, fallback) {
  const raw = value ?? (envValue === '' ? undefined : envValue);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) usage(`${flag} must be a non-negative number of GB`);
  return number;
}

// Free commit memory, the resource run Y exhausted (lanes and council seats
// died, production restarted). Win32_OperatingSystem reports it in KB.
function readFreeGb(deps) {
  if (deps.platform !== 'win32') {
    return { freeGb: null, warning: `free commit memory is read on Windows only (platform ${deps.platform}); admitted unmeasured` };
  }
  const read = call(deps, 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory']);
  const text = read.stdout.trim();
  const kb = /^\d+$/.test(text) ? Number(text) : NaN;
  if (read.code !== 0 || !Number.isFinite(kb)) {
    return { freeGb: null, error: `could not read free commit memory (${read.stderr.trim() || text || `exit ${read.code}`})` };
  }
  return { freeGb: Math.round((kb / 1024 / 1024) * 100) / 100 };
}

// An unreadable reading refuses: the gate exists because nothing else stopped
// the host running out, and "unknown" is not evidence there is room.
function admission(opts, deps) {
  const admitThreshold = gbOption(opts.minFreeGb, '--min-free-gb', deps.env.LANE_MIN_FREE_GB, ADMIT_MIN_FREE_GB);
  const drainThreshold = gbOption(opts.drainFreeGb, '--drain-free-gb', deps.env.LANE_DRAIN_FREE_GB, ADMIT_DRAIN_FREE_GB);
  const reading = readFreeGb(deps);
  // A caller that admits only on room (a 3rd or 4th lane) treats an unmeasured reading as none.
  const unmeasured = opts.requireReading && reading.freeGb === null && !reading.error ? `free commit memory was not measured (${reading.warning}) and --require-reading asks for a reading` : null;
  const reason = reading.error ?? unmeasured
    ?? (reading.freeGb !== null && reading.freeGb < admitThreshold
      ? `free commit memory ${reading.freeGb} GB is below the admit threshold ${admitThreshold} GB`
      : null);
  return {
    admitted: reason === null || Boolean(opts.forceAdmit),
    reason,
    drain: reading.freeGb !== null && reading.freeGb < drainThreshold,
    drainThreshold,
    warning: reading.warning ?? null,
    fields: { freeGb: reading.freeGb, admitThreshold, admitOverride: Boolean(opts.forceAdmit) },
  };
}

async function admitLane(opts, deps) {
  if (opts.name) usage('admit takes no lane name');
  const admit = admission(opts, deps);
  return {
    exit: admit.admitted ? EXIT.OK : EXIT.ADMIT_REFUSED,
    output: {
      admitted: admit.admitted,
      ...admit.fields,
      drain: admit.drain,
      drainThreshold: admit.drainThreshold,
      ...(admit.reason ? { reason: admit.reason } : {}),
      ...(admit.warning ? { warning: admit.warning } : {}),
    },
    row: { state: admit.admitted ? 'admitted' : 'refused', ...admit.fields, drain: admit.drain, warning: admit.warning },
  };
}

async function startLane(opts, deps, state) {
  // C8: model AND reasoning effort are launch flags, never inherited. A claude
  // fallback lane started without --effort ran at xhigh — $5.24 in 9 minutes on
  // a finish-and-commit task (measured 2026-09-01).
  required(opts, 'pane', 'kind', 'model', 'reasoning');
  if (!opts.name) usage('start needs <name>');
  if (!['claude', 'codex'].includes(opts.kind)) usage('start --kind must be claude or codex');
  // Taken before the agent launches: a codex session's rollout is born while
  // the TUI loads, and `wait` finds it as the newest rollout since this stamp.
  const startRequestedAt = deps.timestamp();

  let native = [...opts.agentArgs];
  let warning = null;
  const hasMcpStartupTimeout = opts.mcpStartupTimeout !== undefined;
  const hasMcpStartupServer = opts.mcpStartupServer !== undefined;
  const callerMcpStartupTimeout = hasMcpStartupTimeoutConfig(opts.agentArgs);
  if (opts.kind !== 'codex' && (hasMcpStartupTimeout || hasMcpStartupServer)) {
    usage('--mcp-startup-timeout/--mcp-startup-server apply to codex lanes only');
  }
  if (hasMcpStartupTimeout !== hasMcpStartupServer) {
    usage(`${hasMcpStartupTimeout ? '--mcp-startup-server' : '--mcp-startup-timeout'} is required with the other MCP startup option`);
  }
  if (hasMcpStartupServer && !/^[A-Za-z0-9_-]+$/.test(opts.mcpStartupServer)) {
    usage('--mcp-startup-server must be a bare MCP server name');
  }
  const mcpStartup = hasMcpStartupTimeout && !callerMcpStartupTimeout
    ? { server: opts.mcpStartupServer, seconds: positiveNumber(opts.mcpStartupTimeout, '--mcp-startup-timeout') }
    : null;
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
    if (sandbox === 'workspace-write') {
      usage('codex workspace-write sandbox is refused on Windows: unified exec can time out connecting its runner pipe; use danger-full-access instead');
    }
    native = withoutConfig(withoutOption(withoutOption(withoutOption(native, '--sandbox'), '--ask-for-approval'), '--model'), 'model_reasoning_effort');
    native = [
      '--model', opts.model, '--ask-for-approval', 'never', '--sandbox', sandbox,
      '-c', `model_reasoning_effort=${opts.reasoning}`, ...native,
    ];
    if (mcpStartup !== null) {
      native.push('-c', `mcp_servers.${mcpStartup.server}.startup_timeout_sec=${mcpStartup.seconds}`);
    } else if (hasMcpStartupTimeout && callerMcpStartupTimeout) {
      warning = `ignored --mcp-startup-timeout ${opts.mcpStartupTimeout} + --mcp-startup-server ${opts.mcpStartupServer}: caller-supplied MCP startup-timeout config wins`;
    }
  }

  // The last refusal, and still herdr-free. A fallback is exempt: it replaces
  // the lane's own agent in the same pane, after codex has already been quit.
  const admit = opts.verb === 'fallback' ? null : admission(opts, deps);
  if (admit && !admit.admitted) {
    throw new LaneError(
      EXIT.ADMIT_REFUSED,
      `start refused: ${admit.reason}; pass --force-admit to start anyway`,
      { ...admit.fields, drain: admit.drain },
      { state: 'refused', ...admit.fields },
    );
  }
  const admitRow = admit ? admit.fields : {};
  const admitOutput = admit ? { admission: { ...admit.fields, ...(admit.reason ? { overridden: admit.reason } : {}), ...(admit.warning ? { warning: admit.warning } : {}) } } : {};

  // A sidecar write lock prevents lost state; this separate, longer-lived lock
  // prevents two launches from both claiming the same shell between writes.
  const startLockContent = `${JSON.stringify({ lane: opts.name, startedAt: deps.timestamp() })}\n`;
  const startLock = await acquireLock(
    deps,
    `${opts.log}.start.lock`,
    600,
    startLockContent,
    START_LOCK_STALE_MS,
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
    let folderTrusted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      refreshLock(deps, `${opts.log}.start.lock`, startLockContent);
      promptSignature = await capturePromptSignature(deps, pane, { patterns });
      refreshLock(deps, `${opts.log}.start.lock`, startLockContent);
      if (opts.kind === 'codex') await prepareCodexPane({ ...opts, pane }, deps, promptSignature);
      refreshLock(deps, `${opts.log}.start.lock`, startLockContent);
      const started = call(deps, 'herdr', ['agent', 'start', opts.name, '--kind', opts.kind, '--pane', pane, '--', ...native]);
      if (started.code === 0) {
        raw = started.stdout;
        break;
      }
      // herdr registers the agent before it reports agent_not_ready, so once
      // the dialog is answered the agent is live in this pane.
      if (opts.kind === 'claude' && startupBlocked(started) && await answerFolderTrust(deps, pane)) {
        folderTrusted = true;
        raw = '';
        break;
      }
      const recoverable = startCollision(started) || (isTimeoutFailure(started) && bareShellWithoutAgent(deps, pane, { signature: promptSignature, patterns }));
      if (!recoverable || attempt > 0) {
        const detail = started.stderr.trim() || started.stdout.trim();
        const holder = startLock.holder ? ` while ${startLock.holder} was starting` : '';
        throw new LaneError(EXIT.ERROR, `herdr agent start failed${holder}${detail ? `: ${detail}` : ''}`);
      }
      const split = call(deps, 'herdr', ['pane', 'split', pane, '--direction', 'right']);
      if (split.code !== 0) {
        const detail = split.stderr.trim() || split.stdout.trim();
        const holder = startLock.holder ? `; other in-flight lane: ${startLock.holder}` : '';
        await mergeState(deps, opts.log, state, (draft) => {
          (draft.ghostCandidates ??= []).push({ pane, reason: 'pane split fallback failed', at: deps.timestamp() });
        });
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
    // creates[] is append-only (createLane's push is its one writer), so a higher
    // index is a newer create. A re-start of the same live lane (fallback, or a
    // split onto a fresh pane id) keeps its create by path (amendment 17). A lane
    // NAME reused from an earlier run carries that run's path, and herdr reissues
    // pane ids across workspaces; either way the newest create on the started pane
    // is newer than the record's own create, and it wins.
    const byPathIndex = existing.path
      ? draft.creates.findLastIndex((created) => created.path && resolve(created.path) === resolve(existing.path))
      : -1;
    const byPaneIndex = draft.creates.findLastIndex((created) => created.paneId === opts.pane || created.paneId === pane);
    const priorIndex = byPaneIndex > byPathIndex ? byPaneIndex : byPathIndex;
    const prior = priorIndex >= 0 ? draft.creates[priorIndex] : {};
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
      startRequestedAt,
      ...(paneSplitFrom ? { paneSplitFrom } : {}),
    };
  });

    let hooksTrusted = false;
    if (opts.kind === 'codex') {
      const trust = readPane(deps, pane);
      const trustLines = trust.code === 0 ? paneLines(trust.stdout).slice(-12) : [];
      if (trustLines.some((line) => HOOKS_TRUST_PATTERNS[0].test(line)) && trustLines.some((line) => HOOKS_TRUST_PATTERNS[1].test(line))) {
        call(deps, 'herdr', ['agent', 'send-keys', opts.name, 't']);
        call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'esc']);
        readPane(deps, pane);
        hooksTrusted = true;
      }
    }

    const focus = restoreFocus(deps);
    const warnings = [warning, focus.warning].filter(Boolean);
    const mcpStartupTimeoutSec = mcpStartup;
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
      ...(folderTrusted ? { folderTrusted: true } : {}),
      ...admitOutput,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    },
    row: {
      lane: opts.name,
      kind: opts.kind,
      model: opts.model,
      reasoning: opts.reasoning ?? null,
      state: 'started',
      ...admitRow,
      ...(mcpStartupTimeoutSec !== null ? { mcpStartupTimeoutSec } : {}),
      ...(waitedForStartLockMs > 0 ? { waitedForStartLockMs } : {}),
      ...(hooksTrusted ? { hooksTrusted: true } : {}),
      ...(folderTrusted ? { folderTrusted: true } : {}),
      warning: warnings.length > 0 ? warnings.join('; ') : null,
    },
    };
  } finally {
    startLock();
  }
}

const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEST_REF = /^[0-9a-f-]{6,}$/i;

// The resolver is the operator's, never a default: this repo is public and the
// receipt store is one operator's database. It is either a JSON argv array, with
// `{id}` substituted in any element (appended as the last argument if none has
// it), or a bare program path that gets the id as its one argument. No shell
// parses it, and the id is a validated uuid before it reaches the argv.
function resolverArgv(spec, id) {
  const trimmed = String(spec).trim();
  if (!trimmed.startsWith('[')) return [trimmed, id];
  const argv = parseJson(trimmed);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string' && part !== '')) {
    usage('WORKIT_RECEIPT_RESOLVER is neither a program path nor a JSON array of non-empty strings');
  }
  const placeholder = argv.some((part) => part.includes('{id}'));
  const filled = argv.map((part) => part.split('{id}').join(id));
  return placeholder ? filled : [...filled, id];
}

// An amendment says, in the command, whether it acts on an operator ruling. Any
// prompt after the lane's first (the sidecar's `promptFile`, written by this verb
// on every send) is an amendment whether or not `--amendment` is passed. A ruling
// it names must resolve to an `answered` receipt on the named quest; with no
// resolver there is nothing to resolve against, so the send is refused. Every
// refusal here happens before the first herdr call. `fallback` replays the
// lane's own last prompt, so it is not gated.
function rulingGate(opts, deps, lane) {
  if (opts.verb !== 'prompt') return null;
  const named = opts.rulingReceipt !== undefined || opts.quest !== undefined;
  if (!opts.amendment && !lane.promptFile) {
    if (named || opts.noRuling) {
      usage(`this is lane ${opts.name}'s first prompt, which is not an amendment; --ruling-receipt, --quest and --no-ruling apply to a later prompt (or pass --amendment)`);
    }
    return null;
  }
  if (opts.noRuling) {
    if (named) usage('--no-ruling declares that no operator ruling is acted on; drop --ruling-receipt/--quest or drop --no-ruling');
    return { ruling: 'none' };
  }
  if (opts.rulingReceipt === undefined) {
    usage(opts.amendment
      ? 'prompt --amendment needs --ruling-receipt <uuid> --quest <id>, or --no-ruling'
      : `lane ${opts.name} already has a prompt (${lane.promptFile}), so this one is an amendment: it needs --ruling-receipt <uuid> --quest <id>, or --no-ruling`);
  }
  if (opts.quest === undefined) usage('prompt --amendment --ruling-receipt needs --quest <id>');
  if (!RECEIPT_ID.test(opts.rulingReceipt)) usage(`--ruling-receipt must be a full receipt uuid, got ${JSON.stringify(opts.rulingReceipt)}`);
  if (!QUEST_REF.test(opts.quest)) usage(`--quest must be a quest uuid or a prefix of at least 6 characters, got ${JSON.stringify(opts.quest)}`);
  const spec = deps.env.WORKIT_RECEIPT_RESOLVER;
  if (!spec || !String(spec).trim()) {
    usage('--ruling-receipt needs WORKIT_RECEIPT_RESOLVER to resolve it; none is configured, so the amendment is refused');
  }
  const [program, ...args] = resolverArgv(spec, opts.rulingReceipt.toLowerCase());
  const resolved = call(deps, program, args);
  if (resolved.code !== 0) {
    const detail = resolved.stderr.trim() || resolved.stdout.trim();
    throw new LaneError(EXIT.ERROR, `receipt resolver failed (exit ${resolved.code})${detail ? `: ${detail}` : ''}; the amendment was not sent`);
  }
  const text = resolved.stdout.trim();
  if (!text || text === 'null') usage(`ruling receipt ${opts.rulingReceipt} was not found by the resolver`);
  const receipt = parseJson(text);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new LaneError(EXIT.ERROR, `receipt resolver printed something that is not one receipt JSON object: ${text.slice(0, 200)}`);
  }
  const id = String(receipt.id ?? '').toLowerCase();
  const questId = String(receipt.questId ?? receipt.quest_id ?? '').toLowerCase();
  const outcome = String(receipt.outcome ?? '');
  if (id !== opts.rulingReceipt.toLowerCase()) usage(`the resolver returned receipt ${id || '<no id>'}, not ${opts.rulingReceipt}`);
  if (!questId.startsWith(opts.quest.toLowerCase())) {
    usage(`ruling receipt ${opts.rulingReceipt} belongs to quest ${questId || '<none>'}, not ${opts.quest}`);
  }
  if (outcome !== 'answered') usage(`ruling receipt ${opts.rulingReceipt} has outcome ${JSON.stringify(outcome)}, not "answered"`);
  // Freshness is the resolver's to report: without `latestReceiptId` the gate
  // proves an answered receipt exists on the quest, not that it is the latest.
  const latest = receipt.latestReceiptId ?? receipt.latest_receipt_id ?? null;
  if (latest !== null && String(latest).toLowerCase() !== id) {
    usage(`ruling receipt ${id} is not the latest receipt on quest ${questId} (latest: ${latest}); a later stop superseded it`);
  }
  return { ruling: 'receipt', receipt: id, quest: questId };
}

async function promptLane(opts, deps, state) {
  required(opts, 'file');
  if (!opts.name) usage('prompt needs <name>');
  const file = resolve(opts.file);
  if (!deps.exists(file)) usage(`prompt file does not exist: ${file}`);
  const lane = state.lanes[opts.name] ?? {};
  const ruling = rulingGate(opts, deps, lane);
  const wire = `Read ${file} and execute it exactly.`;
  const initial = agentState(deps, opts.name);
  if (!initial) throw new LaneError(EXIT.ERROR, `prompt agent state check failed: ${opts.name} is not listed`);
  const queued = initial.state === 'working';
  let composerCleared = false;
  if (queued && lane.pane && opts.verb === 'prompt') {
    const beforeSteer = readPane(deps, lane.pane);
    const lines = beforeSteer.code === 0 ? paneRawLines(beforeSteer.stdout) : [];
    // Esc interrupts a working Codex agent. Only a column-zero composer
    // directly above its live footer is evidence that it is safe to clear.
    const composer = lines.at(-2);
    const footer = lines.at(-1);
    const dirty = Boolean(composer && footer
      && composer.startsWith('›')
      && !/Ask Codex to do anything/i.test(composer)
      && LIVE_TUI.some((pattern) => pattern.test(footer)));
    if (dirty) {
      call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'esc']);
      readPane(deps, lane.pane);
      composerCleared = true;
    }
  }
  // A fresh (not queued) prompt to a codex lane waits out the TUI's loading
  // window first; herdr's own state is no guard here — it read the loading
  // redraw as `working` (W5, quest 7e1fecf7).
  const verifyCodex = !queued && lane.kind === 'codex' && Boolean(lane.pane) && opts.verb === 'prompt';
  let readyFrame = verifyCodex ? await waitForCodexReady(deps, lane.pane, CODEX_LOAD_TIMEOUT_MS) : null;
  const promptArgs = ['agent', 'prompt', opts.name, wire, ...(queued ? [] : ['--wait', '--until', 'working'])];
  // Stamped before the first send: the turn this prompt starts (or steers)
  // ends with a task_complete later than this, and `wait` asks for exactly that.
  const promptedAt = deps.timestamp();
  const failIfRefused = (result) => {
    if (result.code !== 0 && !isTimeoutFailure(result)) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new LaneError(EXIT.ERROR, `herdr agent prompt failed${detail ? `: ${detail}` : ''}`);
    }
  };
  let sent = call(deps, 'herdr', promptArgs);
  let enterRetries = 0;
  let stateAfter = queued ? 'working' : responseState(sent.stdout, initial.state ?? 'working');
  failIfRefused(sent);
  if (sent.code !== 0) {
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'enter']);
    enterRetries++;
    const reread = agentState(deps, opts.name);
    stateAfter = reread?.state ?? stateAfter;
  }

  const composerStalled = () => {
    if (opts.verb !== 'prompt' || stateAfter === 'working' || !lane.pane) return false;
    const pane = readPane(deps, lane.pane);
    if (pane.code !== 0) return false;
    return paneLines(pane.stdout).slice(-5).some((line) => line.startsWith('›') && line.includes('execute it exactly'));
  };
  if (composerStalled()) {
    call(deps, 'herdr', ['agent', 'send-keys', opts.name, 'enter']);
    enterRetries++;
    const reread = agentState(deps, opts.name);
    stateAfter = reread?.state ?? stateAfter;
    if (composerStalled()) throw new LaneError(EXIT.ERROR, `composer not submitted for ${opts.name} after Enter retry`);
  }
  // Read the pane back: `accepted` from herdr means the text was typed, not that
  // the session received it. One re-send after the TUI settles; a second miss is
  // an error, never a silent `accepted: true` on a lane that never started.
  let delivery = verifyCodex ? await readCodexDelivery(deps, lane.pane, basename(file), readyFrame, CODEX_DELIVERY_TIMEOUT_MS) : 'unverified';
  let resent = false;
  if (delivery === 'missing') {
    readyFrame = await waitForCodexReady(deps, lane.pane, CODEX_LOAD_TIMEOUT_MS);
    sent = call(deps, 'herdr', promptArgs);
    resent = true;
    // The re-send gets the first send's refusal check (workit#107 review, astra):
    // a failed re-send must not fall through to `unverified` and exit 0.
    failIfRefused(sent);
    delivery = await readCodexDelivery(deps, lane.pane, basename(file), readyFrame, CODEX_DELIVERY_TIMEOUT_MS);
    if (delivery === 'missing') {
      throw new LaneError(EXIT.ERROR, `prompt not delivered to ${opts.name}: no echo of ${basename(file)} and no working line after one re-send`);
    }
  }
  if (delivery === 'unknown') delivery = 'unverified';
  await mergeState(deps, opts.log, state, (draft) => {
    draft.lanes[opts.name] = { ...(draft.lanes[opts.name] ?? lane), promptFile: file, promptedAt };
  });
  const rulingRecord = ruling ? { amendment: true, ruling: ruling.ruling === 'none' ? 'none' : ruling.receipt } : {};
  return {
    output: { accepted: deepFind(unwrapResult(sent.stdout), ['accepted']) ?? true, queued, enterRetries, composerCleared, stateAfter, delivery, resent, ...rulingRecord },
    row: { lane: opts.name, kind: lane.kind ?? null, model: lane.model ?? null, reasoning: lane.reasoning ?? null, state: stateAfter, queued, enterRetries, composerCleared, delivery, resent, ...rulingRecord },
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

function planFloorOption(opts) {
  const floor = positiveNumber(opts.planFloor, '--plan-floor', 20);
  if (floor > 100) usage('--plan-floor must not exceed 100');
  return floor;
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
  const floor = planFloorOption(opts);
  const deadline = deps.now() + timeout;
  let meter = { plan5h: null, planWeekly: null };
  let dialog = '';
  // The row counts the herdr polls; stdout carries only the verdict.
  const polls = { pollCount: 0, pollTimeouts: 0 };
  const settle = (result) => ({ ...result, row: { ...result.row, ...polls } });
  // A codex lane passes through `done` between tool calls, so one settled poll
  // is not a finished turn: the state must hold on a second poll
  // SETTLE_CONFIRM_MS later. Claude lanes settle on one poll.
  let unconfirmedAt = null;
  let rolloutPath = null;
  let settleSource = null;

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
    const observedAt = deps.now();
    polls.pollCount++;
    if (waited.code !== 0 && isTimeoutFailure(waited)) polls.pollTimeouts++;
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
    const plan = readPlanState(deps, opts.name, lane.kind, statusFramePrompt(opts, deps, lane));
    if (plan.ok) {
      meter = plan.meter;
      dialog = plan.dialog;
    } else {
      // Do not make the last good footer look fresh after a failed pane read.
      meter = { plan5h: null, planWeekly: null };
      dialog = '';
    }
    const warning = planMeterWarning(meter, lane.kind);
    const refusal = plan.refusal;
    const modalEligible = plan.refusalShape === 'modal'
      && (planFloorReached(meter, floor) || ['idle', 'done'].includes(stateAfter));
    const refusalEligible = Boolean(refusal) && (plan.refusalShape === 'banner' || modalEligible);
    if (refusalEligible) {
      return settle({
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-refused', refusal, refusalShape: plan.refusalShape, plan5h: meter.plan5h, planWeekly: meter.planWeekly, ...warning },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter, refusalShape: plan.refusalShape, ...warning },
      });
    }

    if (waited.code === 0 && stateAfter === 'blocked') {
      return settle({
        exit: EXIT.BLOCKED,
        output: { state: 'blocked', dialog, ...warning },
        row: { ...laneInstrumentation(opts.name, lane, 'blocked'), ...meter, ...warning },
      });
    }
    // An observation still unconfirmed at the deadline is a timeout: the
    // conductor waits again rather than reading a mid-turn lane as finished.
    // The interval runs from the first settled reading: a second reading taken
    // sooner, because the deadline cut the sleep short, confirms nothing.
    // A herdr-settled Claude lane whose status bar still shows background work
    // has not handed back: keep polling, and at the deadline say why.
    // A codex lane whose rollout shows its turn still running has not handed
    // back either, whatever herdr reads. No rollout found keeps the two-poll
    // settle alone, and the verdict says which evidence it rests on.
    const herdrSettled = waited.code === 0 && ['idle', 'done'].includes(stateAfter);
    const limit = herdrSettled && lane.kind === 'claude' ? claudeUsageLimit(deps, lane) : null;
    if (limit) {
      const { text, ...when } = limit;
      return settle({
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-refused', refusal: text, refusalShape: 'transcript', ...when, ...warning },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), refusalShape: 'transcript', ...when, ...warning },
      });
    }
    let hold = herdrSettled ? settleHold(plan, lane.kind) : null;
    if (herdrSettled && !hold && lane.kind === 'codex') {
      rolloutPath ??= findCodexRollout(deps, lane);
      const turn = rolloutPath ? codexTurnState(deps, rolloutPath, lane.promptedAt ?? null) : null;
      settleSource = turn ? 'rollout' : 'polls';
      if (turn && !turn.ended) {
        hold = { state: 'settled-turn-live', turnEvent: turn.event, turnEventAt: turn.at };
      }
    }
    const settled = herdrSettled && !hold;
    if (!settled) unconfirmedAt = null;
    else if (unconfirmedAt === null) unconfirmedAt = observedAt;
    const confirmed = settled && (lane.kind !== 'codex' || observedAt - unconfirmedAt >= SETTLE_CONFIRM_MS);
    if (settled && !confirmed && deps.now() < deadline) {
      await deps.sleep(Math.max(0, Math.min(SETTLE_CONFIRM_MS - (deps.now() - unconfirmedAt), deadline - deps.now())));
      continue;
    }
    if (confirmed) {
      if (lane.kind === 'codex') Object.assign(polls, { settleConfirmed: true, settleSource });
      if (plan.capacity) {
        return settle({
          exit: EXIT.CAPACITY,
          output: { state: 'capacity', retryable: true, banner: plan.capacity, ...warning },
          row: { ...laneInstrumentation(opts.name, lane, 'capacity'), ...meter, ...warning },
        });
      }
      return settle({
        exit: EXIT.OK,
        output: {
          state: stateAfter,
          ...(lane.kind === 'codex' ? { settle: settleSource } : {}),
          notice: 'status is not evidence — run lane check',
          ...warning,
        },
        row: { ...laneInstrumentation(opts.name, lane, stateAfter), ...meter, ...warning },
      });
    }
    if (planFloorReached(meter, floor)) {
      return settle({
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-low', plan5h: meter.plan5h, planWeekly: meter.planWeekly, planFloor: floor },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-low'), ...meter },
      });
    }
    if (deps.now() >= deadline) {
      const { state: holdState = 'timeout', ...held } = hold ?? {};
      return settle({
        exit: EXIT.TIMEOUT,
        output: { state: holdState, ...held, ...warning },
        row: { ...laneInstrumentation(opts.name, lane, holdState), ...meter, ...held, ...warning },
      });
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

// The lane contract's § Finish headings, verbatim. A report or PR body passes
// only with `## Debrief` carrying both, each with a body ("None" is a body).
export const DEBRIEF_HEADINGS = Object.freeze([
  'Forks I decided that the brief did not settle',
  'Claims no control measures',
]);
// A letter marker at the start of a line, after an optional list marker or bold
// opener. Letters identify options, and `(a)`…`(f)` is the cap: six is
// spine_receipt's `ask.options` maximum.
const LETTER_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\(([A-Za-z])\)/;
const ASK_LETTER = /^[a-f]$/;

function markdownHeading(line) {
  if (line.fenced) return null;
  const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line.text);
  return match ? { level: match[1].length, title: match[2] } : null;
}

// Every line, with fenced-code lines marked so a heading or a question quoted
// inside a code block is never read as the report's own.
function markdownLines(text) {
  let fence = null;
  return String(text).split(/\r?\n/).map((raw, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    let fenced = fence !== null;
    if (marker && fence === null) {
      fence = marker[1];
      fenced = true;
    } else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') {
      // A closer carries nothing but whitespace after its marker; ```markdown
      // inside an open fence is content.
      fence = null;
      fenced = true;
    }
    return { number: index + 1, text: raw, fenced };
  });
}

function sectionEnd(lines, start, level) {
  for (let i = start + 1; i < lines.length; i++) {
    const heading = markdownHeading(lines[i]);
    if (heading && heading.level <= level) return i;
  }
  return lines.length;
}

function letterOf(line) {
  if (!line || line.fenced) return null;
  const match = LETTER_MARKER.exec(line.text.trim());
  return match ? match[1] : null;
}

// A `?` anywhere on the line counts, except inside a code span.
function carriesQuestion(line) {
  return !line.fenced && line.text.replace(/`[^`]*`/g, '').includes('?');
}

// An ask is a lettered item `(a) …?`, or a question stem whose next non-blank
// line starts a lettered item. Anything else carrying a `?` is a bare question.
// The lettered items in one unbroken run are one ask's options: at most six,
// no letter twice. A line that is neither an item nor indented under one ends
// the run.
function askProblems(section, label) {
  const problems = [];
  let itemIndent = null;
  let run = null;
  const closeRun = () => {
    if (!run) return;
    if (run.letters.length > 6) {
      problems.push(`${label} line ${run.line}: the ask has ${run.letters.length} lettered options; an ask carries at most six, (a)…(f)`);
    }
    const repeated = [...new Set(run.letters.filter((letter, i) => run.letters.indexOf(letter) !== i))];
    for (const letter of repeated) {
      const count = run.letters.filter((candidate) => candidate === letter).length;
      problems.push(`${label} line ${run.line}: the ask repeats option (${letter}) ${count} times; letters identify options within one ask`);
    }
    run = null;
  };
  section.forEach((line, index) => {
    if (!line.text.trim()) return;
    const indent = /^\s*/.exec(line.text)[0].replace(/\t/g, '    ').length;
    const letter = letterOf(line);
    if (letter !== null) {
      // A lettered question followed by option (a) labels its own ask (`(a) Which…? / (a) … / (b) …`): it opens a new ask.
      const following = section.slice(index + 1).find((candidate) => candidate.text.trim());
      if (ASK_LETTER.test(letter) && carriesQuestion(line) && letterOf(following) === 'a') {
        closeRun();
        itemIndent = null;
        return;
      }
      if (ASK_LETTER.test(letter)) {
        itemIndent = indent;
        run ??= { line: line.number, letters: [] };
        run.letters.push(letter);
        return;
      }
      itemIndent = null;
      const why = /[A-Z]/.test(letter) ? 'letters are lowercase (a)…(f)' : 'an ask carries at most six options, (a)…(f)';
      problems.push(`${label} line ${line.number} starts (${letter}), which is not a lettered ask: ${why}: ${line.text.trim()}`);
      return;
    }
    if (itemIndent !== null && indent > itemIndent) return;
    itemIndent = null;
    closeRun();
    if (!carriesQuestion(line)) return;
    const next = section.slice(index + 1).find((candidate) => candidate.text.trim());
    if (ASK_LETTER.test(letterOf(next) ?? '')) return;
    problems.push(`${label} line ${line.number} is a question outside a lettered ask (a)…(f): ${line.text.trim()}`);
  });
  closeRun();
  return problems;
}

// The report shape the lane contract requires, as a list of what is missing.
// Empty means the shape holds. A question phrased without `?` is not seen.
export function reportShapeProblems(text) {
  const lines = markdownLines(text);
  const problems = [];
  const debrief = lines.findIndex((line) => {
    const heading = markdownHeading(line);
    return heading?.level === 2 && heading.title === 'Debrief';
  });
  if (debrief < 0) {
    problems.push('## Debrief is missing');
  } else {
    const section = lines.slice(debrief + 1, sectionEnd(lines, debrief, 2));
    for (const title of DEBRIEF_HEADINGS) {
      const at = section.findIndex((line) => {
        const heading = markdownHeading(line);
        return heading?.level === 3 && heading.title === title;
      });
      if (at < 0) {
        problems.push(`## Debrief is missing ### ${title}`);
        continue;
      }
      // A heading is not a body: the subsection needs one content line of its own.
      const body = section.slice(at + 1, sectionEnd(section, at, 3)).filter((line) => line.text.trim() && !markdownHeading(line));
      if (body.length === 0) problems.push(`### ${title} has no body (write None if there is nothing to list)`);
    }
  }
  lines.forEach((line, index) => {
    const heading = markdownHeading(line);
    if (!heading || heading.level < 2 || heading.level > 4 || !/^Needs conductor\b/i.test(heading.title)) return;
    const label = `${'#'.repeat(heading.level)} ${heading.title}`;
    problems.push(...askProblems(lines.slice(index + 1, sectionEnd(lines, index, heading.level)), label));
  });
  return problems;
}

// spawnSync reports a missing cwd as ENOENT on the PROGRAM ("spawnSync gh
// ENOENT"), and git -C a swept path reads as a git failure; both send the
// operator to PATH. Name the directory before either runs.
function requireLaneDir(opts, lane, deps) {
  if (!deps.exists(lane.path)) {
    throw new LaneError(EXIT.ERROR, `lane ${opts.name} worktree path does not exist: ${lane.path} (a swept worktree, or a stale lane record)`);
  }
}

async function checkLane(opts, deps, state) {
  const lane = laneRecord(opts, state);
  const expectations = [
    opts.expectCommit ? 'commit' : null, opts.expectFile ? 'file' : null, opts.expectPr ? 'pr' : null, opts.expectReport ? 'report' : null,
  ].filter(Boolean);
  if (expectations.length !== 1) usage('check needs exactly one of --expect-commit, --expect-file, --expect-pr, or --expect-report');
  let failedExpectation = null;
  let evidence = null;

  if (opts.expectCommit) {
    if (!lane.path || !lane.base || !lane.branch) usage(`lane ${opts.name} has no worktree/base/branch metadata`);
    requireLaneDir(opts, lane, deps);
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
  } else if (opts.expectReport) {
    const path = isAbsolute(opts.expectReport) ? resolve(opts.expectReport) : resolve(lane.path ?? process.cwd(), opts.expectReport);
    evidence = { path };
    if (!deps.exists(path)) {
      failedExpectation = `--expect-report: report does not exist: ${path}`;
    } else {
      const problems = reportShapeProblems(deps.read(path));
      evidence = { path, problems };
      if (problems.length > 0) failedExpectation = `--expect-report ${path}: ${problems.join('; ')}`;
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
    requireLaneDir(opts, lane, deps);
    // The body rides the same call: the contract requires ## Debrief in the PR
    // body as well as in the report.
    const viewed = call(deps, 'gh', ['pr', 'view', String(opts.expectPr), '--json', 'headRefName,state,body'], { cwd: lane.path ?? undefined });
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
      const bodyProblems = reportShapeProblems(typeof doc?.body === 'string' ? doc.body : '');
      evidence = { headRefName: doc?.headRefName ?? null, state: doc?.state ?? null, bodyProblems };
      const prStatus = String(doc?.state ?? '').toUpperCase();
      if (doc?.headRefName !== lane.branch) {
        failedExpectation = `--expect-pr ${opts.expectPr}: head must equal ${lane.branch}, got ${doc?.headRefName ?? 'unknown'}`;
      } else if (!['OPEN', 'MERGED'].includes(prStatus)) {
        // A closed PR is abandoned work wearing the right head ref.
        failedExpectation = `--expect-pr ${opts.expectPr}: the PR is ${prStatus.toLowerCase() || 'in an unknown state'}, which is not a completion verdict`;
      } else if (bodyProblems.length > 0) {
        failedExpectation = `--expect-pr ${opts.expectPr}: PR body: ${bodyProblems.join('; ')}`;
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
  const floor = planFloorOption(opts);
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
      // A timeout says the lane is still working, not that its pane is
      // unreadable. Take one fresh reading so a live reserve floor can still
      // stop dispatch; resume remains a settled-state wait, never a poll loop.
      const plan = readPlanState(deps, opts.name, lane.kind);
      const meter = plan.meter ?? { plan5h: null, planWeekly: null };
      const warning = planMeterWarning(meter, lane.kind);
      const modalEligible = plan.refusalShape === 'modal' && planFloorReached(meter, floor);
      const refusalEligible = Boolean(plan.refusal) && (plan.refusalShape === 'banner' || modalEligible);
      if (refusalEligible) {
        return {
          exit: EXIT.PLAN_LOW,
          output: { state: 'plan-refused', refusal: plan.refusal, refusalShape: plan.refusalShape, ...meter, ...warning },
          row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter, refusalShape: plan.refusalShape, ...warning },
        };
      }
      if (plan.ok && planFloorReached(meter, floor)) {
        return {
          exit: EXIT.PLAN_LOW,
          output: { state: 'plan-low', plan5h: meter.plan5h, planWeekly: meter.planWeekly, planFloor: floor },
          row: { ...laneInstrumentation(opts.name, lane, 'plan-low'), ...meter },
        };
      }
      return {
        exit: EXIT.TIMEOUT,
        output: { state: 'timeout', ...meter, ...warning },
        row: { ...laneInstrumentation(opts.name, lane, 'timeout'), ...meter, ...warning },
      };
    }
    throw new LaneError(EXIT.ERROR, `herdr agent wait failed: ${raw.stderr.trim() || raw.stdout.trim()}`);
  }
  // The same pane scrape `wait` runs: the plan meter and the captured refusal
  // belong to the lane, not to the verb that happened to look. C11(a) again —
  // herdr reports `idle` while that modal is up, so this outranks the state.
  const plan = readPlanState(deps, opts.name, lane.kind, statusFramePrompt(opts, deps, lane));
  const meter = plan.meter ?? { plan5h: null, planWeekly: null };
  const warning = planMeterWarning(meter, lane.kind);
  const modalEligible = plan.refusalShape === 'modal'
    && (planFloorReached(meter, floor) || ['idle', 'done'].includes(responseState(raw.stdout, null)));
  const refusalEligible = Boolean(plan.refusal) && (plan.refusalShape === 'banner' || modalEligible);
  if (refusalEligible) {
    return {
      exit: EXIT.PLAN_LOW,
      output: { state: 'plan-refused', refusal: plan.refusal, refusalShape: plan.refusalShape, ...meter, ...warning },
      row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter, refusalShape: plan.refusalShape, ...warning },
    };
  }
  const statusAfter = responseState(raw.stdout, 'idle');
  if (statusAfter === 'blocked') {
    return {
      exit: EXIT.BLOCKED,
      output: { state: 'blocked', dialog: plan.dialog, ...warning },
      row: { ...laneInstrumentation(opts.name, lane, 'blocked'), ...meter, ...warning },
    };
  }
  // One settled reading, not a poll loop: a lane that settled with background
  // work live is a timeout the conductor answers with `lane wait`. A codex
  // lane gets the same single rollout read `wait` makes (herdr reads `done`
  // between tool calls); no rollout found leaves herdr's reading alone.
  let settleSource = null;
  let turnHold = null;
  if (lane.kind === 'codex') {
    const rolloutPath = findCodexRollout(deps, lane);
    const turn = rolloutPath ? codexTurnState(deps, rolloutPath, lane.promptedAt ?? null) : null;
    settleSource = turn ? 'rollout' : 'polls';
    if (turn && !turn.ended) turnHold = { state: 'settled-turn-live', turnEvent: turn.event, turnEventAt: turn.at };
  }
  const { state: holdState = null, ...held } = settleHold(plan, lane.kind) ?? turnHold ?? {};
  if (holdState) {
    return {
      exit: EXIT.TIMEOUT,
      output: { state: holdState, ...held, ...warning },
      row: { ...laneInstrumentation(opts.name, lane, holdState), ...meter, ...held, ...warning },
    };
  }
  return {
    exit: EXIT.OK,
    output: {
      state: statusAfter,
      ...(settleSource ? { settle: settleSource } : {}),
      notice: 'status is not evidence — run lane check',
      ...warning,
    },
    row: { ...laneInstrumentation(opts.name, lane, statusAfter), ...meter, ...(settleSource ? { settleSource } : {}), ...warning },
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
  const agent = agents.find((entry) => (entry?.name ?? entry?.agent) === herdrAgentName(name));
  if (!agent) return null;
  return { agent, state: String(agent.state ?? agent.status ?? 'unknown').toLowerCase() };
}

// Measured 2026-09-26 21:30Z and 21:31Z (a Haiku agent after one turn, then
// the stop's `/exit`): the shell prompt was back 1.8 s in with the agent still
// listed, and it was unlisted by 2.4 s, both times. The window is a few times
// that lag.
const STOP_UNLIST_WINDOW_MS = 10_000;

// Re-reads `herdr agent list` until `name` drops out or `windowMs` passes; a
// failed or agent-less listing ends it at once. The caller judges the result.
async function pollUntilUnlisted(deps, name, windowMs) {
  const deadline = deps.now() + windowMs;
  let polls = 0;
  for (;;) {
    const listing = call(deps, 'herdr', ['agent', 'list']);
    polls++;
    const names = listing.code === 0 ? listedAgentNames(listing.stdout) : null;
    if (!names || !names.includes(herdrAgentName(name)) || deps.now() >= deadline) return { listing, names, polls };
    await deps.sleep(250);
  }
}

// Stops the agent, then reaps what the lane left running in its worktree.
async function stopLane(opts, deps, state) {
  const lane = laneRecord(opts, state);
  const result = await stopAgent(opts, deps, lane);
  if (!lane.path) return result;
  const reaped = reapWorktree(lane.path, deps);
  if (!reaped.found.length && !reaped.error) return result;
  const add = (out) => ({
    ...out,
    output: { ...out.output, ...reapOutput(reaped) },
    row: { ...out.row, orphans: reaped.found.length, ...(reaped.error ? { reapError: reaped.error } : {}) },
  });
  // Only a verified reap (the second list read, no survivor) can turn a blocked stop into a stop.
  if (result.output?.state === 'exited-shell-blocked' && reaped.killed.length && !reaped.survivors.length && !reaped.error) {
    // The live descendant the launch waited on was the orphan: with it gone,
    // the pane's shell can return.
    try {
      await waitForPanePrompt(deps, lane.pane, { signature: lane.promptSignature ?? null, patterns: promptPatterns(opts, deps) }, REAP_PROMPT_MS);
      return add({
        exit: EXIT.OK,
        output: { state: 'stopped', panePrompt: true, agentListed: false, promptCheck: 'after-reap' },
        row: { ...laneInstrumentation(opts.name, lane, 'stopped'), promptCheck: 'after-reap' },
      });
    } catch {
      // The pane still holds; the failure stands, with what was reaped.
    }
  }
  return add(result);
}

async function stopAgent(opts, deps, lane) {
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
    const promptOptions = { signature: lane.promptSignature ?? null, patterns: promptPatterns(opts, deps) };
    // What one late read of the pane shows.
    const look = (read) => {
      const text = read.code === 0 ? responseText(read.stdout) : '';
      const lines = paneLines(text);
      const liveTui = LIVE_TUI.some((pattern) => lines.slice(-2).some((line) => pattern.test(line)));
      return {
        unread: read.code !== 0,
        liveTui,
        prompt: read.code === 0 && paneAtPrompt(read.stdout, promptOptions),
        banner: !liveTui && lines.slice(-3).some((line) => /^(?:goodbye|codex\s+(?:exited|closed))/i.test(line)),
        // The footer must be the last two lines, so a live TUI's footer below
        // it keeps it out: neither footer line matches a LIVE_TUI pattern.
        resumeId: lane.kind === 'claude' && read.code === 0 ? claudeExitFooterTail(text) : null,
        last: lines.at(-1) ?? null,
      };
    };
    const before = look(readPane(deps, lane.pane));
    // The same listing lag as the normal path: with the pane showing an exit
    // (or unreadable), the listing gets the same window; a live TUI gets one read.
    const exitSeen = !before.liveTui && (before.prompt || before.banner || before.resumeId !== null || before.unread);
    const late = await pollUntilUnlisted(deps, opts.name, exitSeen ? STOP_UNLIST_WINDOW_MS : 0);
    const lateListing = late.listing;
    const lateNames = late.names;
    const latePolls = late.polls > 1 ? { agentListPolls: late.polls } : {};
    const gone = lateListing.code === 0 && Array.isArray(lateNames) && !lateNames.includes(herdrAgentName(opts.name));
    // The poll can take the whole window, and the shell may come back during
    // it: once the agent is gone, the pane is judged as it is now.
    const now = gone ? look(readPane(deps, lane.pane)) : before;
    if (gone && now.unread) {
      deps.warn(`lane: stop pane re-read failed after ${opts.name} disappeared; accepting unread exit`);
      return { exit: EXIT.OK, output: { state: 'stopped', panePrompt: false, agentListed: false, promptCheck: 'unread', ...latePolls }, row: { ...laneInstrumentation(opts.name, lane, 'stopped'), promptCheck: 'unread', ...latePolls } };
    }
    // Claude has exited and herdr has dropped it, but the shell under the
    // footer never came back, so the pane is not free. A failure, kept apart
    // from a prompt that never matched so the conductor knows the agent is gone.
    // The footer tail outranks a banner above it: no prompt was drawn.
    if (gone && now.resumeId) {
      const blocked = 'exited-shell-blocked';
      return {
        exit: EXIT.ERROR,
        output: {
          error: `stop ${blocked}: ${opts.name} exited and is no longer listed, but pane ${lane.pane} ends in Claude's resume footer with no shell prompt under it; likely herdr's Start-Process -Wait launch is still waiting on a live descendant of the Claude process, so the shell has not returned and the pane is not reusable`,
          state: blocked,
          panePrompt: false,
          agentListed: false,
          resumeId: now.resumeId,
          ...latePolls,
        },
        row: { ...laneInstrumentation(opts.name, lane, blocked), resumeId: now.resumeId, ...latePolls },
      };
    }
    if (gone && (now.prompt || now.banner)) {
      return {
        exit: EXIT.OK,
        output: { state: 'stopped', panePrompt: true, agentListed: false, promptCheck: 'late', ...latePolls },
        row: { ...laneInstrumentation(opts.name, lane, 'stopped'), promptCheck: 'late', ...latePolls },
      };
    }
    // With no recorded signature, or one that is error output, nothing can
    // recognise this pane's prompt by its text. The agent is gone, so the pane
    // is judged idle at a prompt when no TUI is drawn, its last line held still
    // from the end of the prompt wait through both late reads, and that line
    // is not error output and ENDS with the lane's worktree directory and a
    // prompt character, as a shell prompt shows its cwd (`… / wp-02 ~`,
    // `PS …\wp-02>`, `…/wp-02$`). Output that merely mentions the worktree,
    // or a prompt that does not show the cwd, keeps the failure below.
    const untrusted = !lane.promptSignature || paneErrorLine(lane.promptSignature);
    const cwdPrompt = lane.path ? new RegExp(`${basename(lane.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]?\\s*[~>$#%❯➜λ]\\s*$`, 'u') : null;
    const showsCwd = (line) => Boolean(cwdPrompt) && !paneErrorLine(line) && cwdPrompt.test(line);
    if (untrusted && gone && !now.liveTui && now.last !== null && now.last === before.last && now.last === error.lastLine && showsCwd(now.last)) {
      return {
        exit: EXIT.OK,
        output: { state: 'stopped', panePrompt: false, agentListed: false, promptCheck: 'idle', ...latePolls },
        row: { ...laneInstrumentation(opts.name, lane, 'stopped'), promptCheck: 'idle', ...latePolls },
      };
    }
    if (Array.isArray(lateNames) && lateNames.includes(herdrAgentName(opts.name))) {
      throw new LaneError(EXIT.ERROR, `stop agent list check failed: ${opts.name} is still listed after late prompt check`);
    }
    throw new LaneError(EXIT.ERROR, `stop pane prompt check failed: ${error.message}`);
  }
  // herdr drops an exited agent from `agent list` a beat after the pane's
  // prompt returns, so one read at the prompt races it; the listing is
  // re-read until the agent is gone or the window closes.
  const { listing, names, polls: agentListPolls } = await pollUntilUnlisted(deps, opts.name, STOP_UNLIST_WINDOW_MS);
  if (listing.code !== 0) throw new LaneError(EXIT.ERROR, `stop agent list check failed: ${listing.stderr.trim() || listing.stdout.trim()}`);
  if (!names) throw new LaneError(EXIT.ERROR, 'stop agent list check failed: response did not contain agents');
  if (names.includes(herdrAgentName(opts.name))) {
    throw new LaneError(EXIT.ERROR, `stop agent list check failed: ${opts.name} is still listed ${STOP_UNLIST_WINDOW_MS} ms after the pane prompt returned`);
  }
  const polls = agentListPolls > 1 ? { agentListPolls } : {};
  return {
    exit: EXIT.OK,
    output: { state: 'stopped', panePrompt: true, agentListed: false, ...polls },
    row: { ...laneInstrumentation(opts.name, lane, 'stopped'), ...polls },
  };
}

// ---- reap ----

const REAP_PROMPT_MS = 10_000;
const PROCESS_LIST_WIN32 = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';

// Every process with its parent and command line, or { error }.
function processList(deps) {
  if (deps.platform === 'win32') {
    const read = call(deps, 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LIST_WIN32]);
    if (read.code !== 0) return { error: `process list failed: ${read.stderr.trim() || read.stdout.trim()}` };
    const parsed = parseJson(read.stdout);
    if (parsed === null || typeof parsed !== 'object') return { error: 'process list printed no JSON' };
    // ConvertTo-Json prints a lone object, not an array, for one row.
    const rows = Array.isArray(parsed) ? parsed : 'ProcessId' in parsed ? [parsed] : [];
    return { processes: rows.map((row) => ({ pid: Number(row?.ProcessId), ppid: Number(row?.ParentProcessId), cmd: String(row?.CommandLine ?? '') })).filter((row) => Number.isInteger(row.pid)) };
  }
  const read = call(deps, 'ps', ['-eo', 'pid=,ppid=,args=']);
  if (read.code !== 0) return { error: `process list failed: ${read.stderr.trim() || read.stdout.trim()}` };
  return { processes: read.stdout.split(/\r?\n/).map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), cmd })) };
}

// Whether a command line names the worktree: the path (either slash, case
// folded on win32), followed by a separator, a quote, whitespace or the end,
// so `<wt>-2` is not `<wt>`.
export function commandNamesPath(cmd, path, platform) {
  const fold = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const text = fold(String(cmd));
  const bare = String(path).replace(/[\\/]+$/, '');
  for (const form of new Set([bare, bare.replaceAll('\\', '/'), bare.replaceAll('/', '\\')].map(fold))) {
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
      const next = text[at + form.length];
      if (next === undefined || /[\\/"'\s]/.test(next)) return true;
    }
  }
  return false;
}

// The processes still running from a lane's worktree after its agent exited
// (a runtime-exercise dev server). They hold the pane's shell open
// (exited-shell-blocked) and lock files a sweep must delete. Found by the
// worktree path in the command line, which herdr's pane shells and the lane
// agents do not carry (ASSUMPTION beyond the shapes read on 2026-10-08:
// `pwsh -NoExit -Command <prompt hook>` and `claude.exe --resume <id>`).
// This process and its ancestors are never matched. Each match is killed with
// its tree, then the list is read again: a survivor is reported, never
// assumed gone. ASSUMPTION: a pid is not reused between the list and the kill
// (one round trip). `list` reports without killing.
export function reapWorktree(path, deps, { list = false } = {}) {
  const before = processList(deps);
  if (before.error) return { path, found: [], killed: [], survivors: [], error: before.error };
  const self = deps.pid ?? process.pid;
  const parents = new Map(before.processes.map((row) => [row.pid, row.ppid]));
  const ancestors = new Set();
  for (let pid = self; Number.isInteger(pid) && !ancestors.has(pid); pid = parents.get(pid)) ancestors.add(pid);
  const match = (rows) => rows.filter((row) => !ancestors.has(row.pid) && commandNamesPath(row.cmd, path, deps.platform));
  const found = match(before.processes);
  if (list || !found.length) return { path, found, killed: [], survivors: [] };
  // A match's descendants (a `node server.js` under the matched shell) need not
  // name the path; the parent links read in the same list find them.
  const tree = new Map(found.map((row) => [row.pid, row]));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of before.processes) {
      if (!tree.has(row.pid) && tree.has(row.ppid) && !ancestors.has(row.pid)) {
        tree.set(row.pid, row);
        grew = true;
      }
    }
  }
  const killed = [];
  // taskkill /T walks the tree itself; elsewhere each process gets its own
  // TERM, deepest first (depth by parent links, not list order).
  const depth = (row) => {
    let n = 0;
    for (let at = row; tree.has(at.ppid) && n < tree.size; at = tree.get(at.ppid)) n += 1;
    return n;
  };
  const targets = deps.platform === 'win32' ? found : [...tree.values()].sort((a, b) => depth(b) - depth(a));
  for (const row of targets) {
    const kill = deps.platform === 'win32' ? call(deps, 'taskkill', ['/PID', String(row.pid), '/T', '/F']) : call(deps, 'kill', ['-TERM', String(row.pid)]);
    if (kill.code === 0) killed.push(row.pid);
  }
  const after = processList(deps);
  if (after.error) return { path, found, killed, survivors: [], error: `after the kill: ${after.error}` };
  // A survivor is a new path match, or a member of the tree still running the same command (a reused pid is not).
  const survivors = after.processes.filter((row) => (tree.has(row.pid) && tree.get(row.pid).cmd === row.cmd)
    || (!ancestors.has(row.pid) && commandNamesPath(row.cmd, path, deps.platform)));
  return { path, found, killed, survivors };
}

const shortCmd = (cmd) => (cmd.length > 200 ? `${cmd.slice(0, 197)}...` : cmd);
function reapOutput(reaped) {
  return {
    orphans: reaped.found.map((row) => ({ pid: row.pid, cmd: shortCmd(row.cmd) })),
    ...(reaped.survivors.length ? { survivors: reaped.survivors.map((row) => ({ pid: row.pid, cmd: shortCmd(row.cmd) })) } : {}),
    ...(reaped.error ? { reapError: reaped.error } : {}),
  };
}

// `lane reap <name> | --path <abs> [--list]`: one lane's leftover processes.
async function reapLane(opts, deps, state) {
  const path = opts.path ? resolve(opts.path) : laneRecord(opts, state).path;
  if (!path) usage('reap needs <name> (a lane with a path) or --path <abs>');
  const reaped = reapWorktree(path, deps, { list: Boolean(opts.list) });
  const failed = Boolean(reaped.error) || (!opts.list && reaped.survivors.length > 0);
  const stateName = reaped.error ? 'reap-failed' : opts.list ? 'listed' : reaped.survivors.length ? 'survivors' : 'reaped';
  return {
    exit: failed ? EXIT.ERROR : EXIT.OK,
    output: { state: stateName, path, ...reapOutput(reaped), ...(reaped.error ? { error: reaped.error } : {}) },
    row: { lane: opts.name ?? basename(path), state: stateName, orphans: reaped.found.length },
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

// `creates[]` is the sidecar's record of every path it made — the only list of
// directories the sweeper is entitled to delete. A lane record counts only when
// its path exactly matches one of those creates.
// `--lane <name>` names ONE directory, chosen across every create before any
// root is visited. A lane name is reused across runs, and creates[] keeps the
// old runs' rows (append order, oldest first): a first match per root picked
// the oldest create's label and could match one under every root. The lane
// record's path wins (start keeps it on the current create); otherwise the
// newest create whose label or basename is the name. Windows paths and names
// are case-insensitive, so a casing mismatch there is the same directory, and
// the delegate is handed the recorded basename either way. Returns the folded
// path key, or null.
function sweepTargetKey(state, lane, deps) {
  const fold = (value) => (deps.platform === 'win32' ? String(value).toLowerCase() : String(value));
  const creates = (state.creates ?? []).filter((created) => typeof created?.path === 'string');
  const createKeys = new Set(creates.map((created) => fold(resolve(created.path))));
  const wanted = fold(lane);
  const records = Object.entries(state.lanes ?? {})
    .filter(([name, record]) => fold(name) === wanted && typeof record?.path === 'string' && createKeys.has(fold(resolve(record.path))));
  if (records.length > 0) return fold(resolve(records.at(-1)[1].path));
  const newest = creates.findLast((created) => [created.label, basename(resolve(created.path))].some((name) => typeof name === 'string' && fold(name) === wanted));
  return newest ? fold(resolve(newest.path)) : null;
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

// The delegate (herdr-lanes.ps1) lists one row per lane it found:
//   REPO  LANE  BRANCH  DIRTY  AHEAD  AGENT  VERDICT
// under a dashed rule, reason lines indented below a row, a blank line after
// the table. It walks <WorktreeRoot>\<repo dir>\<lane dir> and deletes the
// lane dir's FullName, so a row's path is <WorktreeRoot>/<REPO>/<LANE>.
// Returns those paths, [] for "No lanes under", or null when the output has
// neither shape (unverifiable, so the caller refuses).
export function delegateListedPaths(output, worktreeRoot) {
  return delegateListedRows(output, worktreeRoot)?.map((row) => row.path) ?? null;
}

// Each listed lane with the delegate's verdict (SAFE, HOLD, PRUNE), its last column.
export function delegateListedRows(output, worktreeRoot) {
  const lines = String(output).split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*REPO\s+LANE\s+BRANCH\b/.test(line));
  if (header < 0) return /No lanes under/i.test(String(output)) ? [] : null;
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (line.trim() === '') break;
    if (/^\s/.test(line)) continue;
    const cells = line.trim().split(/\s+/);
    const [repo, lane] = cells;
    if (!repo || !lane) return null;
    rows.push({ path: join(worktreeRoot, repo, lane), verdict: cells.at(-1) });
  }
  return rows;
}

// d4480b68: `-Lane` scopes the delegate by basename only, two levels below
// -WorktreeRoot — a same-named directory under a different parent matches too,
// and -Clean deletes with Remove-Item -Recurse -Force. Before a cleaning call
// for a named lane, list first and clean only when every listed path is the
// sidecar's path for that lane.
function verifyDelegateTarget(deps, delegate, entry) {
  const fold = (value) => (deps.platform === 'win32' ? value.toLowerCase() : value);
  const root = entry.delegateRoot ?? entry.root;
  const listFlags = entry.flags.filter((flag) => flag !== '-Clean' && flag !== '-Force');
  const listed = call(deps, 'pwsh', ['-NoProfile', '-File', delegate, '-WorktreeRoot', root, ...listFlags]);
  if (listed.code !== 0) return { refused: `delegate --list failed before -Clean: ${listed.stderr.trim() || listed.stdout.trim() || `exit ${listed.code}`}` };
  const rows = delegateListedRows(listed.stdout, root);
  if (rows === null) return { refused: 'the delegate list could not be read, so the directory -Clean would remove is unverified' };
  const reported = rows.map((row) => row.path);
  const expected = fold(resolve(entry.lanePath));
  const strays = reported.filter((path) => fold(resolve(path)) !== expected);
  if (strays.length > 0) {
    return { refused: `the delegate lists ${strays.join(', ')} for -Lane ${entry.lane}, not the sidecar's ${resolve(entry.lanePath)}; -Clean refused` };
  }
  return { listed: listed.stdout, nothingListed: reported.length === 0, verdicts: rows.map((row) => row.verdict) };
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
  const targetKey = opts.lane ? sweepTargetKey(state, opts.lane, deps) : null;
  const foldPath = (value) => (deps.platform === 'win32' ? value.toLowerCase() : value);
  for (const root of roots) {
    const known = knownLanesUnder(state, root.path, deps);
    const requested = targetKey ? known.find((entry) => foldPath(entry.path) === targetKey)?.basename ?? null : null;
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
    let verified = null;
    if (entry.lanePath && entry.flags.includes('-Clean')) {
      verified = verifyDelegateTarget(deps, delegate, entry);
      if (verified.refused) {
        return { root: entry.root, lane: entry.lane, ok: false, exit: null, output: '', refused: true, error: verified.refused };
      }
      if (verified.nothingListed) {
        return { root: entry.root, lane: entry.lane, ok: true, exit: 0, output: verified.listed, cleaned: false };
      }
    }
    // A lane's leftover process locks files the delegate deletes (a dev
    // server's native module), so the lane is reaped first, but only a lane the
    // delegate is about to clean: a HOLD lane (a live agent, unfinished work)
    // keeps its processes unless -Force overrides the HOLD. An unverified reap
    // leaves the lane uncleaned rather than half-deleted around a locked file.
    const cleans = (verdict) => verdict === 'SAFE' || verdict === 'PRUNE' || (verdict === 'HOLD' && entry.flags.includes('-Force'));
    const reaped = verified?.verdicts?.length && verified.verdicts.every(cleans) ? reapWorktree(entry.lanePath, deps) : null;
    if (reaped && (reaped.error || reaped.survivors.length)) {
      return { root: entry.root, lane: entry.lane, ...reapOutput(reaped), ok: false, exit: null, output: '',
        error: `${entry.lanePath} not cleaned: ${reaped.error ?? `${reaped.survivors.length} process(es) still run from it`}` };
    }
    const swept = call(deps, 'pwsh', ['-NoProfile', '-File', delegate, '-WorktreeRoot', entry.delegateRoot ?? entry.root, ...entry.flags]);
    return {
      root: entry.root,
      ...(entry.lane ? { lane: entry.lane } : {}),
      ...(reaped && (reaped.found.length || reaped.error) ? reapOutput(reaped) : {}),
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
      const heldLanes = Object.values(state.lanes ?? {}).filter((lane) => held.some((entry) => {
        if (entry.lane) return entry.lane === basename(lane.path ?? '');
        return knownLanesUnder(state, entry.root, deps).some((known) => known.path === resolve(lane.path ?? ''));
      }));
      const heldPanes = new Set(heldLanes.flatMap((lane) => [lane.pane, lane.paneSplitFrom]).filter(Boolean));
      const paneSignatures = new Map(Object.values(state.lanes ?? {}).map((lane) => [lane.pane, lane.promptSignature]));
      // A HOLD is scoped to a pane the sidecar knows; never turn an empty or
      // ambiguous association into a report about every live agent.
      const relevant = agents.filter((agent) => heldPanes.has(agent?.pane_id ?? agent?.paneId));
      holds = relevant.map((agent) => {
        const pane = agent?.pane_id ?? agent?.paneId ?? '<unknown-pane>';
        const name = agent?.name ?? agent?.agent ?? '<unnamed>';
        const state = String(agent?.state ?? agent?.status ?? 'unknown').toLowerCase();
        const snapshot = pane === '<unknown-pane>' ? null : readPane(deps, pane);
        const ghost = name === '<unnamed>' && ['idle', 'done'].includes(state)
          && snapshot?.code === 0 && paneAtPrompt(snapshot.stdout, {
            signature: paneSignatures.get(pane) ?? null,
            patterns: promptPatterns(opts, deps),
          });
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
  const candidates = (state.ghostCandidates ?? []).map((candidate) => ({
    pane: candidate.pane,
    message: `HOLD candidate (split failed at ${candidate.at})`,
  }));
  return {
    exit: swept.length === 0 ? EXIT.ERROR : EXIT.OK,
    output: {
      delegated: true,
      roots: [...results, ...plan.filter((entry) => entry.skipped).map((entry) => ({ root: entry.root, skipped: entry.skipped }))],
      sweptRoots: swept.length,
      totalRoots: results.length,
      ...((holds.length > 0 || candidates.length > 0) ? { holds: [...holds, ...candidates] } : {}),
    },
    row: { lane: null, state: swept.length === results.length ? 'swept' : 'swept-partial' },
  };
}

// herdr answers failures with {"error":{"code":"…"}}. Read the code; the word
// "timeout" can appear in a message that is not one.
function isTimeoutFailure(result) {
  const parsed = parseJson(result.stderr) ?? parseJson(result.stdout);
  const code = parsed?.error?.code;
  return code === 'timeout' || code === 'agent_prompt_stalled';
}

// What the status-frame check treats as this pane's own shell prompt, in
// promptPatterns' order: a declared regex (flag, then LANE_PROMPT_REGEX)
// replaces the default shapes, and the lane's recorded signature always counts.
// Unlike promptPatterns, a declared regex that cannot compile falls back to the
// default shapes: this check must give `wait` no new way to fail (the flag is
// already refused at parse time for every verb).
function statusFramePrompt(opts, deps, lane) {
  let patterns = DEFAULT_PROMPT_PATTERNS;
  const declared = opts.promptRegex ?? deps.env.LANE_PROMPT_REGEX ?? null;
  if (declared) {
    try {
      patterns = [new RegExp(declared)];
    } catch {
      // keep the default shapes
    }
  }
  return { signature: lane.promptSignature ?? null, patterns };
}

// One pane read, shared by `wait` and `resume`: the plan meter and the captured
// refusal are properties of the lane, not of the verb that happened to look.
function readPlanState(deps, name, kind, prompt = {}) {
  const read = call(deps, 'herdr', ['agent', 'read', name, '--lines', '40']);
  if (read.code !== 0) return { ok: false, meter: null, refusal: null, refusalShape: null, background: null, dialog: '' };
  // The meter footer, the refusal banner and modal, and the capacity banner
  // are all codex TUI text. A claude lane draws none of them, so any of it in
  // its pane is its own output (measured: a lane editing lane.test.mjs
  // fixtures read as weekly 15%, exit 6), and a lane of unknown kind may be a
  // claude lane.
  if (!readsCodexTui(kind)) {
    return {
      ok: true,
      meter: { plan5h: null, planWeekly: null },
      refusal: null,
      refusalShape: null,
      capacity: null,
      background: claudeBackgroundWork(read.stdout, prompt),
      dialog: responseText(read.stdout),
    };
  }
  const refusal = planRefusal(read.stdout);
  return {
    ok: true,
    meter: scrapePlanMeter(read.stdout),
    refusal: refusal?.line ?? null,
    refusalShape: refusal?.shape ?? null,
    capacity: capacityBanner(read.stdout),
    background: null,
    dialog: responseText(read.stdout),
  };
}

// The status-bar segment text (`1 shell, 1 monitor`) when the pane's composer
// is followed by a mode line naming live background work, else null. The
// composer is the last rule line followed by a `❯` line, and its bottom rule
// the next rule: rules drawn further down (a survey box) are not it, and the
// segment is read only in the lines under that bottom rule, so a lane's own
// transcript quoting the text above the composer is not evidence. A frame is
// dead, and reads null, when Claude's exit footer is under it or when the pane's
// last line is the shell's own prompt (the lane's recorded signature, else a
// default prompt shape): Claude was killed and the shell redrew beneath it. A
// prompt that is neither (a multi-line prompt, no signature captured) leaves the
// old frame reading live, which costs a timeout, never a false settle.
export function claudeBackgroundWork(text, { signature = null, patterns = DEFAULT_PROMPT_PATTERNS } = {}) {
  const lines = responseText(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  const top = lines.findLastIndex((line, index) => CLAUDE_COMPOSER_RULE.test(line) && lines[index + 1]?.startsWith('❯'));
  const bottom = top < 0 ? -1 : lines.findIndex((line, index) => index > top + 1 && CLAUDE_COMPOSER_RULE.test(line));
  const last = lines.at(-1)?.trim() ?? '';
  const atShellPrompt = (signature && last === String(signature).trim()) || patterns.some((pattern) => pattern.test(last));
  if (bottom < 0 || atShellPrompt || lines.slice(bottom + 1).some((line) => line.trim() === CLAUDE_RESUME_HINT)) return null;
  const segment = CLAUDE_BACKGROUND_SEGMENT.exec(lines.slice(bottom + 1, bottom + 1 + CLAUDE_STATUS_LINES).join(' '));
  return segment ? segment[1].replace(/\s+/g, ' ') : null;
}

// What keeps a herdr-settled non-codex lane from settling: live background work
// in its status bar, or a pane that could not be read (an unread pane must not
// make a live segment look absent). Both end at the deadline as exit 4.
// --- codex turn state from the session rollout ----------------------------
// herdr's agent_status reads `done` for minutes while codex works between tool
// calls, steadily enough that a second poll confirms it. The rollout journal is
// codex's own record: a turn is over when its last turn event is task_complete
// or turn_aborted, written after the lane's last prompt.
const ROLLOUT_HEAD_BYTES = 16 * 1024;
const ROLLOUT_TAIL_BYTES = 256 * 1024;
const ROLLOUT_MAX_DAYS = 14;
const TURN_EVENTS = new Set(['task_started', 'task_complete', 'turn_aborted']);

function readFileBytes(path, { bytes, fromEnd = false }) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const start = fromEnd ? size - length : 0;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString('utf8'), start };
  } finally {
    closeSync(fd);
  }
}

function codexSessionsRoot(deps) {
  const home = deps.env.CODEX_HOME || join(deps.home(), '.codex');
  return join(home, 'sessions');
}

// Codex files a rollout under its LOCAL date, so the scan spans a day either
// side of the UTC dates between `since` and now.
function rolloutDayDirs(root, sinceMs, nowMs) {
  const day = 86_400_000;
  const first = Math.max(sinceMs - day, nowMs - ROLLOUT_MAX_DAYS * day);
  const dirs = [];
  for (let at = first; at <= nowMs + day; at += day) {
    const date = new Date(at);
    const parts = [
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ];
    dirs.push(join(root, ...parts));
  }
  return dirs;
}

// The lane's own rollout: the EARLIEST interactive (codex-tui) session whose
// session_meta.cwd is the lane's worktree and which began at or after the
// lane's start was requested. Review seats and lenses run `codex exec` in the
// same worktree (originator codex_exec), and any later session there began
// after the lane's own, so neither the newest match nor a non-TUI session is
// the lane. null when there is none yet.
export function findCodexRollout(deps, lane) {
  const sinceMs = lane.startRequestedAt ? Date.parse(lane.startRequestedAt) : NaN;
  if (!lane.path || !Number.isFinite(sinceMs)) return null;
  const fold = (value) => (deps.platform === 'win32' ? value.toLowerCase() : value);
  const want = fold(resolve(lane.path));
  let best = null;
  for (const dir of rolloutDayDirs(codexSessionsRoot(deps), sinceMs, deps.now())) {
    let names;
    try {
      names = deps.list(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const path = join(dir, name);
      let head;
      try {
        head = deps.readBytes(path, { bytes: ROLLOUT_HEAD_BYTES }).text;
      } catch {
        continue;
      }
      const firstLine = head.split('\n', 1)[0];
      if (!firstLine.includes('"session_meta"') || !firstLine.includes('"originator":"codex-tui"')) continue;
      const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(firstLine);
      const stamp = /"timestamp":"([^"]+)"/.exec(firstLine);
      if (!cwd || !stamp) continue;
      let cwdValue;
      try {
        cwdValue = JSON.parse(cwd[1]);
      } catch {
        continue;
      }
      if (fold(resolve(cwdValue)) !== want) continue;
      // Ordered by the session's own UTC stamp: the filename is local time,
      // which repeats an hour at a DST fall-back.
      const at = Date.parse(stamp[1]);
      if (!(at >= sinceMs)) continue;
      if (!best || at < best.at || (at === best.at && name < best.name)) best = { name, path, at };
    }
  }
  return best?.path ?? null;
}

// Claude Code files a session under <config dir>/projects/<the cwd with every
// non-alphanumeric character as '-'>; CLAUDE_CONFIG_DIR moves the config dir.
function claudeProjectDir(deps, path) {
  const root = deps.env.CLAUDE_CONFIG_DIR || join(deps.home(), '.claude');
  return join(root, 'projects', resolve(path).replace(/[^a-zA-Z0-9]/g, '-'));
}

// A Claude lane the plan refuses ends its turn on a synthetic assistant entry
// carrying apiError "usage_limit_reached", and herdr reads it as done. Its
// pane is not scraped (a lane's own output can quote any banner), so the
// evidence is the lane's own session: the newest one in its worktree's
// project directory that holds the lane's last prompt as sent (another
// session there, such as a review lens's `claude -p`, is not the lane's).
// { text, rateLimitType, resetsAt } when its last assistant entry after that
// prompt is the refusal, else null.
export function claudeUsageLimit(deps, lane) {
  if (!lane.path || !lane.promptFile) return null;
  const dir = claudeProjectDir(deps, lane.path);
  const wire = JSON.stringify(`Read ${lane.promptFile} and execute it exactly.`).slice(1, -1);
  let sessions;
  try {
    sessions = deps.list(dir).filter((name) => name.endsWith('.jsonl')).map((name) => {
      const path = join(dir, name);
      return { path, mtime: Number(deps.stat(path).mtimeMs) };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  let read = null;
  for (const session of sessions) {
    try {
      const text = deps.read(session.path);
      if (text.includes(wire)) {
        read = { text, start: 0 };
        break;
      }
    } catch {
      // unreadable: not evidence either way
    }
  }
  if (!read) return null;
  const lines = read.text.split('\n');
  if (read.start > 0) lines.shift();
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].includes('"type":"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    if (entry.apiError !== 'usage_limit_reached') return null;
    const promptMs = lane.promptedAt ? Date.parse(lane.promptedAt) : NaN;
    if (Number.isFinite(promptMs) && !(Date.parse(entry.timestamp) >= promptMs)) return null;
    const info = entry.apiErrorParams?.rate_limit_info ?? entry.quotaLimits ?? {};
    const resets = Number(info.resetsAt);
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    return {
      text: content.map((part) => part?.text).find(Boolean) ?? null,
      rateLimitType: info.rateLimitType ?? null,
      resetsAt: Number.isFinite(resets) && resets > 0 ? new Date(resets * 1000).toISOString() : null,
    };
  }
  return null;
}

// { ended, event, at } from the rollout's last turn event, or null when the
// rollout cannot be read. A tail with no turn event is a turn still running: an
// idle session writes nothing after its task_complete, so a finished turn's
// event is always inside the tail.
export function codexTurnState(deps, path, promptedAt = null) {
  let read;
  try {
    read = deps.readBytes(path, { bytes: ROLLOUT_TAIL_BYTES, fromEnd: true });
  } catch {
    return null;
  }
  const lines = read.text.split('\n');
  if (read.start > 0) lines.shift();
  let last = null;
  for (let index = lines.length - 1; index >= 0 && !last; index--) {
    const line = lines[index];
    if (!line.includes('task_') && !line.includes('turn_aborted')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'event_msg' && TURN_EVENTS.has(entry.payload?.type)) {
        last = { event: entry.payload.type, at: entry.timestamp ?? null };
      }
    } catch {
      // a line still being written, or not JSON
    }
  }
  if (!last) return { ended: false, event: null, at: null };
  const promptMs = promptedAt ? Date.parse(promptedAt) : NaN;
  const afterPrompt = !Number.isFinite(promptMs) || Date.parse(last.at) >= promptMs;
  return { ended: last.event !== 'task_started' && afterPrompt, ...last };
}

function settleHold(plan, kind) {
  if (readsCodexTui(kind)) return null;
  if (!plan.ok) return { state: 'timeout', paneUnread: true };
  if (plan.background) return { state: 'settled-background-live', background: plan.background };
  return null;
}

export function capacityBanner(text) {
  const lines = responseText(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  const liveFooter = LIVE_TUI.some((pattern) => lines.slice(-2).some((line) => pattern.test(line)));
  const tailStart = Math.max(0, lines.length - CAPACITY_TAIL_LINES);
  const at = lines.findLastIndex((line, index) => index >= tailStart && CAPACITY_PATTERN.test(line));
  // The banner must belong to the turn that just settled: a column-zero `›`
  // line between it and the composer is a later prompt, so the banner ended an
  // earlier turn.
  const laterPrompt = at >= 0 && codexTranscript(lines).slice(at + 1).some((line) => line.startsWith('›'));
  return at >= 0 && liveFooter && !laterPrompt ? lines[at].trim() : null;
}

function planRefusal(text) {
  const source = responseText(text);
  const lines = source.split(/\r?\n/);
  const banner = lines.find((line) => PLAN_REFUSAL_PATTERNS[0].test(line));
  const liveFooter = LIVE_TUI.some((pattern) => lines.slice(-2).some((line) => pattern.test(line)));
  if (banner && liveFooter) return { shape: 'banner', line: banner.trim() };
  const modal = lines.find((line) => PLAN_REFUSAL_PATTERNS[1].test(line));
  if (modal && /(?:^|\n)\s*(?:›\s*)?1\.\s*Switch\b/i.test(source)) return { shape: 'modal', line: modal.trim() };
  return null;
}

function selectedPlanWindow(meter) {
  return meter?.plan5h ?? meter?.planWeekly ?? null;
}

function planFloorReached(meter, floor) {
  const selected = selectedPlanWindow(meter);
  return selected !== null && selected <= floor;
}

// Codex TUI text (the meter footer, the refusal banner and modal, the capacity
// banner) is read only off a lane recorded as codex.
function readsCodexTui(kind) {
  return kind === 'codex';
}

// A record with no kind is a lane whose `start` failed after herdr had already
// registered the agent (lane zd, 2026-09-26: `start --kind claude` failed
// agent_not_ready and the record kept no kind), so its kind is unknown. Its
// pane is not scraped, but its capacity is unknown too, so it warns.
function warnsOnUnknownMeter(kind) {
  return readsCodexTui(kind) || kind === undefined || kind === null;
}

function planMeterWarning(meter, kind) {
  return warnsOnUnknownMeter(kind) && selectedPlanWindow(meter) === null
    ? { warning: 'plan meter unavailable; capacity is unknown' }
    : {};
}

export function scrapePlanMeter(text) {
  // C11 says the LAST FOOTER LINE: the pane's last non-blank line, and only
  // when it is the live Codex footer (`Context N% left`). Any line above it is
  // transcript — a lane's own output can quote meter text, and a quit codex
  // leaves its old footer in the scrollback under a fresh shell prompt. Unwrap
  // first — an enveloped response is one JSON line, which silently turns "last
  // footer line" into "first match" (measured: enveloped 80%, plain 9%).
  const last = responseText(text).split(/\r?\n/).filter((line) => line.trim() !== '').at(-1) ?? '';
  const source = CODEX_FOOTER.test(last) ? last : '';
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
    touch: (path) => utimesSync(path, new Date(), new Date()),
    warn: (message) => console.error(message),
    append: (path, value) => appendFileSync(path, value, 'utf8'),
    list: (path) => readdirSync(path),
    readBytes: readFileBytes,
    home: () => homedir(),
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
    // A help request is not a lane event. `lane --help` (or a bare `lane`) run
    // from any repo used to append a usage-error row to THAT repo's lane log —
    // Session G opened 2026-09-03 by trashing a row this way. A wrong verb or a
    // bad flag still logs: those are real mistakes worth a trail.
    if (!isHelpRequest(argv[0])) appendRow(deps, log, row);
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
      case 'reap': result = await reapLane(opts, deps, state); break;
      case 'sweep': result = await sweepLanes(opts, deps, state); break;
      case 'admit': result = await admitLane(opts, deps); break;
      default: throw new LaneError(EXIT.USAGE, `${opts.verb} is not implemented yet`);
    }
    result.exit ??= EXIT.OK;
  } catch (error) {
    // An unclassified throw is an infrastructure failure, not a deadline.
    const code = error instanceof LaneError ? error.code : EXIT.ERROR;
    result = { exit: code, output: { error: error.message, ...(error.details ?? {}) }, row: { state: 'failed', ...(error.row ?? {}) } };
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
