#!/usr/bin/env node
/**
 * Claude-session lifecycle carrier.  Each invocation emits JSON and appends one
 * receipt row; herdr is reached only through the injectable executor.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execute, EXIT_CODES } from './lane.mjs';

const EXIT = Object.freeze({
  ok: EXIT_CODES.ok,
  error: EXIT_CODES.error,
  usage: EXIT_CODES.usage,
  blocked: EXIT_CODES.blocked,
  timeout: EXIT_CODES.timeout,
  checkFailed: EXIT_CODES.artifactCheckFailed,
});
for (const [name, code] of Object.entries(EXIT)) {
  if (!Number.isInteger(code)) throw new Error(`lane EXIT_CODES.${name} is not a number`);
}
const VERBS = new Set(['spawn', 'brief', 'watch', 'retire', 'chain', 'status']);
const LOG_SUBPATH = ['data', 'outputs', 'projects', 'agentic-practice-transfer', 'sessions'];
const LOG_NAME = 'session-log.jsonl';

export const USAGE_TEXT = `session <verb> [options] — one Claude-session lifecycle step per invocation, JSON on stdout.

  spawn  --name <n> --model <id> --effort <lvl> [--cwd <abs>] [--from <pane>|--current]
         [--direction down|right] [--mode fresh|fork --from-session <id>] [--chrome]
         [--permission-mode bypassPermissions] [--timeout <ms>] [-- <native args>]
  brief  <name|pane> --file <abs> [--wait] [--timeout <ms>]
  watch  <name|pane> [--until idle|done|blocked|gone]... --timeout <ms>
  retire <self|parent|name|pane> --mode exit|close|exit+close [--timeout <ms>] [--dialog-after-ms <ms>] [--capture-final]
  chain  --handoff <abs> --model <id> --effort <lvl> --name <successor> [--no-retire]
  status [--chain <id>] [--last]

  --log <path> overrides the session JSONL sidecar. --workspace-root <abs> selects its default root.`;

class SessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function usage(message) { throw new SessionError(EXIT.usage, message, { usage: USAGE_TEXT }); }
function isHelp(verb) { return verb === undefined || ['help', '--help', '-h'].includes(verb); }
function keyFor(flag) { return flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

function parseArgs(argv) {
  const [verb, ...tokens] = argv;
  if (isHelp(verb)) usage('session needs one verb');
  if (!VERBS.has(verb)) usage(`expected one verb: ${[...VERBS].join(', ')}`);
  const opts = { verb, positional: [], nativeArgs: [] };
  const booleans = new Set(['--current', '--chrome', '--wait', '--capture-final', '--no-retire', '--last']);
  const repeated = new Set(['--until']);
  const values = new Set([
    '--name', '--model', '--effort', '--cwd', '--from', '--direction', '--mode', '--from-session',
    '--permission-mode', '--timeout', '--file', '--log', '--workspace-root', '--handoff', '--chain',
    '--successor-timeout', '--dialog-after-ms',
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') { opts.nativeArgs = tokens.slice(i + 1); break; }
    if (booleans.has(token)) { opts[keyFor(token)] = true; continue; }
    if (repeated.has(token)) {
      const value = tokens[++i]; if (value === undefined) usage(`${token} needs a value`);
      (opts[keyFor(token)] ??= []).push(value); continue;
    }
    if (values.has(token)) {
      const value = tokens[++i]; if (value === undefined) usage(`${token} needs a value`);
      opts[keyFor(token)] = value; continue;
    }
    if (token.startsWith('-')) usage(`unknown argument: ${token}`);
    opts.positional.push(token);
  }
  if (opts.verb === 'chain' && opts.captureFinal && opts.noRetire) usage('--capture-final requires an exiting caller; remove --no-retire');
  return opts;
}

function resolveLogPath(opts, deps) {
  if (opts.log) return { log: resolve(opts.log), logSource: '--log' };
  const root = opts.workspaceRoot ?? deps.env.WORKIT_WORKSPACE_ROOT;
  if (root) return { log: join(resolve(root), ...LOG_SUBPATH, LOG_NAME), logSource: opts.workspaceRoot ? '--workspace-root' : 'WORKIT_WORKSPACE_ROOT' };
  return { log: resolve(...LOG_SUBPATH, LOG_NAME), logSource: 'cwd' };
}
function logFromArgv(argv, deps) {
  const option = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  return resolveLogPath({ log: option('--log'), workspaceRoot: option('--workspace-root') }, deps);
}
function required(opts, ...names) {
  for (const name of names) if (!opts[name]) usage(`${opts.verb} needs --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}
function positive(value, flag, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) usage(`${flag} must be a positive number`);
  return number;
}
function call(deps, args, options = {}) {
  const result = deps.exec('herdr', args, options);
  if (typeof result === 'string') return { code: 0, stdout: result, stderr: '' };
  return { code: result?.code ?? result?.exitCode ?? 0, stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') };
}
function callOrFail(deps, args, options) {
  const result = call(deps, args, options);
  if (result.code !== 0) throw new SessionError(EXIT.error, `herdr ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
function parsed(raw) { try { return JSON.parse(raw); } catch { return null; } }
function resultOf(raw) { const value = parsed(raw); return value?.result && typeof value.result === 'object' ? value.result : value; }
function deep(value, names) {
  if (!value || typeof value !== 'object') return undefined;
  for (const name of names) if (value[name] !== undefined && value[name] !== null) return value[name];
  for (const [key, child] of Object.entries(value)) if (key !== 'id') { const found = deep(child, names); if (found !== undefined) return found; }
  return undefined;
}
function agentState(raw) { const state = deep(resultOf(raw), ['state', 'status', 'agent_status']); return typeof state === 'string' ? state.toLowerCase() : null; }
function sessionId(raw) {
  const session = deep(resultOf(raw), ['agent_session', 'agentSession']);
  if (typeof session === 'string') return session;
  if (session && typeof session === 'object' && typeof session.value === 'string') return session.value;
  const id = deep(resultOf(raw), ['session_id', 'sessionId']);
  return typeof id === 'string' ? id : null;
}
function paneId(raw) { const id = deep(resultOf(raw), ['pane_id', 'paneId', 'id']); return typeof id === 'string' ? id : null; }
function contextOf(raw) {
  const token = deep(resultOf(raw), ['tokens']);
  const context = token && typeof token === 'object' ? token.context : deep(resultOf(raw), ['context']);
  if (context === undefined || context === null || context === '') return null;
  const number = Number(context); return Number.isFinite(number) ? number : null;
}
function foregroundProcesses(raw) {
  const info = resultOf(raw);
  const processInfo = info?.process_info ?? info?.processInfo;
  return Array.isArray(processInfo?.foreground_processes) ? processInfo.foreground_processes : null;
}
function processName(process) {
  const candidate = process?.name ?? String(process?.argv0 ?? '').split(/[\\/]/).at(-1);
  return typeof candidate === 'string' ? candidate : null;
}
function hasClaude(raw) {
  const processes = foregroundProcesses(raw);
  // process-info is the only close guard. An unreadable or changed envelope is
  // not evidence that a pane is clean, so it deliberately fails closed.
  if (!processes) return true;
  return processes.some((process) => {
    const name = processName(process);
    return !name || /^claude(?:\.exe)?$/i.test(name);
  });
}
function processModel(raw) {
  const processes = foregroundProcesses(raw);
  if (!processes) return null;
  for (const process of processes) {
    const argv = Array.isArray(process?.argv) ? process.argv : [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--model' && typeof argv[index + 1] === 'string') return argv[index + 1];
      if (typeof argv[index] === 'string' && argv[index].startsWith('--model=')) return argv[index].slice('--model='.length) || null;
    }
  }
  return null;
}
function processPid(raw) {
  const processes = foregroundProcesses(raw);
  if (!processes) return null;
  const claude = processes.find((process) => /^claude(?:\.exe)?$/i.test(processName(process) ?? ''));
  const pid = Number(claude?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function inHerdr(deps) {
  if (deps.env.HERDR_ENV !== '1' || !deps.env.HERDR_PANE_ID) usage('this verb requires HERDR_ENV=1 and HERDR_PANE_ID');
  return deps.env.HERDR_PANE_ID;
}
function statePath(log) { return `${log}.state.json`; }
function emptyState() { return { sessions: {}, chains: [] }; }
function loadState(deps, log) {
  if (!deps.exists(statePath(log))) return emptyState();
  try { const value = JSON.parse(deps.read(statePath(log))); return { sessions: value.sessions ?? {}, chains: value.chains ?? [] }; }
  catch { throw new SessionError(EXIT.usage, `session state is not valid JSON: ${statePath(log)}`); }
}
function saveState(deps, log, state) { deps.mkdir(dirname(statePath(log))); deps.write(statePath(log), `${JSON.stringify(state, null, 2)}\n`); }
function appendRow(deps, log, row) { deps.mkdir(dirname(log)); deps.append(log, `${JSON.stringify(row)}\n`); }
function finalStateRoot(deps) { return deps.env.WORKIT_SESSION_CHAIN_DIR ?? join(deps.env.HOME ?? deps.env.USERPROFILE ?? '.', '.workit', 'session-chain'); }
function prepareFinalCapture(deps, id) {
  if (!id) usage('capture-final needs the caller session id from herdr agent get');
  const root = finalStateRoot(deps);
  const marker = join(root, 'final-pending', id);
  deps.mkdir(dirname(marker));
  deps.write(marker, 'pending\n');
  return join(root, 'final', `${id}.md`);
}
function finalMessagePath(deps, state, target) {
  const session = target.sessionId
    ?? Object.values(state.sessions).find((item) => item.pane === target.pane)?.sessionId
    ?? [...state.chains].reverse().find((item) => item.callerPane === target.pane)?.callerSession
    ?? null;
  if (!session) return null;
  const path = join(finalStateRoot(deps), 'final', `${session}.md`);
  return deps.exists(path) ? path : null;
}
async function resolveTarget(opts, state, target, deps) {
  if (target === 'parent') {
    const current = Object.values(state.sessions).find((item) => item.pane === opts.currentPane);
    if (!current?.spawnedBy) usage('parent is not recorded for this session');
    return { name: current.parentName ?? null, pane: current.spawnedBy, sessionId: null, target: current.spawnedBy };
  }
  if (target === 'self') return { name: null, pane: opts.currentPane, sessionId: null, target: opts.currentPane };
  const record = state.sessions[target] ?? Object.values(state.sessions).find((item) => item.pane === target);
  if (record) return { name: record.name ?? target, pane: record.pane, sessionId: record.sessionId ?? null, target: record.name ?? target };
  if (target.startsWith('pane:') || /^w[0-9A-Za-z]+:p\d+$/.test(target)) {
    const pane = call(deps, ['pane', 'get', target]);
    if (pane.code !== 0) usage(`pane_not_found: ${target}`);
    const agents = callOrFail(deps, ['agent', 'list']);
    const owner = agentOwningPane(agents, target);
    if (!owner) return { name: null, pane: target, sessionId: null, target, resolvedFrom: 'herdr', goneAgent: true };
    return { name: owner, pane: target, sessionId: null, target: owner, resolvedFrom: 'herdr' };
  }
  const fetched = call(deps, ['agent', 'get', target]);
  const pane = fetched.code === 0 ? paneId(fetched.stdout) : null;
  if (!pane) usage(`target ${target} has no sidecar pane and herdr agent get did not return pane_id`);
  return { name: target, pane, sessionId: fetched.code === 0 ? sessionId(fetched.stdout) : null, target };
}
function agentOwningPane(raw, pane) {
  const search = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) { const found = search(item); if (found) return found; }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const paneId = value.pane_id ?? value.paneId ?? (typeof value.pane === 'string' ? value.pane : value.pane?.id ?? value.pane?.pane_id);
    if (paneId === pane) {
      const name = value.name ?? value.agent_name ?? value.agentName ?? value.id;
      return typeof name === 'string' ? name : null;
    }
    for (const child of Object.values(value)) { const found = search(child); if (found) return found; }
    return null;
  };
  return search(resultOf(raw));
}
function normalizeNativeArgs(args) {
  const normalized = [];
  for (const arg of args) {
    const match = /^(--(?:permission-mode|model))=(.*)$/.exec(String(arg));
    if (match) normalized.push(match[1], match[2]);
    else normalized.push(arg);
  }
  return normalized;
}
function nativeOption(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function nativeHasDontAsk(args) { return String(nativeOption(args, '--permission-mode') ?? '').toLowerCase() === 'dontask'; }

async function spawn(opts, deps, state, { chain = false } = {}) {
  const nativeArgs = normalizeNativeArgs(opts.nativeArgs);
  const nativePermission = nativeOption(nativeArgs, '--permission-mode');
  const nativeModel = nativeOption(nativeArgs, '--model');
  if (nativeHasDontAsk(nativeArgs) || String(opts.permissionMode ?? '').toLowerCase() === 'dontask') usage('dontAsk is refused before herdr is invoked');
  const callerPane = inHerdr(deps);
  required(opts, 'name', 'model', 'effort');
  if (opts.permissionMode && opts.permissionMode !== 'bypassPermissions') usage('--permission-mode must be bypassPermissions');
  if (nativePermission && nativePermission !== 'bypassPermissions') usage('native --permission-mode must be bypassPermissions');
  if (nativeModel && nativeModel !== opts.model) usage('native --model must match --model');
  if (opts.cwd && !isAbsolute(opts.cwd)) usage('--cwd must be absolute');
  if (opts.mode && !['fresh', 'fork'].includes(opts.mode)) usage('--mode must be fresh or fork');
  if ((opts.mode ?? 'fresh') === 'fork' && !opts.fromSession) usage('fork mode needs --from-session');
  const from = opts.from === 'current' || opts.current ? callerPane : (opts.from ?? callerPane);
  const direction = opts.direction ?? 'down';
  if (!['down', 'right'].includes(direction)) usage('--direction must be down or right');
  const timeout = positive(opts.readinessTimeout ?? opts.timeout, opts.readinessTimeout !== undefined ? '--successor-timeout' : '--timeout', 90_000);
  const split = ['pane', 'split', from, '--direction', direction, '--no-focus'];
  if (opts.cwd) split.push('--cwd', resolve(opts.cwd));
  const splitOut = callOrFail(deps, split);
  const pane = paneId(splitOut);
  if (!pane) throw new SessionError(EXIT.error, 'herdr pane split did not return a pane id');
  const agentArgs = ['--permission-mode', opts.permissionMode ?? 'bypassPermissions', '--model', opts.model, '--effort', opts.effort];
  if (opts.chrome) agentArgs.push('--chrome');
  if ((opts.mode ?? 'fresh') === 'fork') agentArgs.push('--resume', opts.fromSession, '--fork-session');
  agentArgs.push(...nativeArgs);
  try {
    callOrFail(deps, ['agent', 'start', opts.name, '--kind', 'claude', '--pane', pane, '--timeout', String(timeout), '--', ...agentArgs]);
    const deadline = deps.now() + timeout;
    let status = null; let session = null;
    do {
      const gotten = call(deps, ['agent', 'get', opts.name]);
      if (gotten.code === 0) { status = agentState(gotten.stdout); session = sessionId(gotten.stdout); if (session && (!chain || status === 'idle')) break; }
      if (deps.now() >= deadline) break;
      await deps.sleep(100);
    } while (true);
    const record = { name: opts.name, pane, sessionId: session, model: opts.model, effort: opts.effort, mode: opts.mode ?? 'fresh', argvVerified: false, spawnedBy: from, startedAt: deps.timestamp() };
    state.sessions[opts.name] = record;
    saveState(deps, opts.log, state);
    const process = callOrFail(deps, ['pane', 'process-info', '--pane', pane]);
    record.argvVerified = processModel(process) === opts.model;
    if (!record.argvVerified) throw new SessionError(EXIT.checkFailed, `pane ${pane} argv does not contain requested model ${opts.model}`, { pane });
    saveState(deps, opts.log, state);
    return { record, ready: Boolean(session) && (!chain || status === 'idle') };
  } finally {
    // Agent start has no --no-focus. The caller remains the interaction owner
    // even when argv verification rejects an already-running successor.
    call(deps, ['agent', 'focus', callerPane]);
  }
}

async function brief(opts, deps, state) {
  if (opts.positional.length !== 1) usage('brief needs one target');
  required(opts, 'file');
  const file = resolve(opts.file);
  if (!isAbsolute(opts.file) || !deps.exists(file)) usage(`brief file does not exist: ${file}`);
  const target = await resolveTarget(opts, state, opts.positional[0], deps);
  const found = call(deps, ['agent', 'get', target.target]);
  if (found.code !== 0 || agentState(found.stdout) === 'blocked') throw new SessionError(EXIT.blocked, `target is blocked or unavailable: ${target.target}`);
  const args = ['agent', 'prompt', target.target, `Read ${file} and execute it exactly.`];
  if (opts.wait) args.push('--wait', '--until', 'working');
  if (opts.timeout) args.push('--timeout', String(positive(opts.timeout, '--timeout')));
  const result = call(deps, args);
  if (result.code !== 0) throw new SessionError(/agent_blocked/i.test(result.stderr) ? EXIT.blocked : EXIT.error, `herdr agent prompt failed: ${(result.stderr || result.stdout).trim()}`);
  return { target: target.target, file, accepted: true, stateAfter: agentState(result.stdout) };
}

async function watch(opts, deps, state) {
  if (opts.positional.length !== 1) usage('watch needs one target');
  const target = opts.resolvedTarget ?? await resolveTarget(opts, state, opts.positional[0], deps);
  const until = opts.until?.length ? opts.until : ['idle', 'done', 'blocked'];
  if (until.some((value) => !['idle', 'done', 'blocked', 'gone'].includes(value))) usage('watch --until must be idle, done, blocked, or gone');
  const timeout = positive(opts.timeout, '--timeout');
  const requested = until.includes('gone')
    ? [...new Set([...until.filter((value) => value !== 'gone'), 'done'])]
    : until;
  const result = call(deps, ['agent', 'wait', target.target, ...requested.flatMap((value) => ['--until', value]), '--timeout', String(timeout)]);
  const missing = /agent_not_found/i.test(`${result.stdout}\n${result.stderr}`);
  if (until.includes('gone') && (missing || (result.code === 0 && agentState(result.stdout) === 'done'))) return { state: 'gone', target: target.target };
  if (result.code !== 0) {
    if (/timeout/i.test(`${result.stdout}\n${result.stderr}`)) throw new SessionError(EXIT.timeout, `watch timed out for ${target.target}`);
    throw new SessionError(EXIT.error, `herdr agent wait failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const stateAfter = agentState(result.stdout) ?? 'unknown';
  if (stateAfter === 'blocked') {
    const read = call(deps, ['agent', 'read', target.target, '--lines', '40']);
    throw new SessionError(EXIT.blocked, `target is blocked: ${target.target}`, { dialog: read.stdout });
  }
  return { state: stateAfter, target: target.target };
}

function exitDialog(text) {
  return /Background work is running/i.test(text) && /Enter to confirm/i.test(text);
}
function childProcesses(deps, pid) {
  if (!pid) return { children: null, error: 'claude.exe pid was unavailable from process-info' };
  const command = `Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq ${pid} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const result = deps.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  if ((result?.code ?? result?.exitCode ?? 0) !== 0) return { children: null, error: String(result?.stderr ?? '').trim() || `PowerShell exited ${(result?.code ?? result?.exitCode ?? 1)}` };
  const stdout = String(result?.stdout ?? '');
  if (!stdout.trim()) return { children: [], error: null };
  const value = parsed(stdout);
  if (value === null) return { children: null, error: 'PowerShell returned invalid child-process JSON' };
  return { children: Array.isArray(value) ? value : [value], error: null };
}
function onlyMcpChildren(children) {
  return Array.isArray(children) && children.length > 0 && children.every((child) => /run-.*-mcp\.js/i.test(String(child?.CommandLine ?? child?.commandLine ?? child?.argv ?? '')));
}
function waitForGone(deps, target, timeout) {
  const result = call(deps, ['agent', 'wait', target.target, '--until', 'done', '--timeout', String(timeout)]);
  const missing = /agent_not_found/i.test(`${result.stdout}\n${result.stderr}`);
  if (missing || (result.code === 0 && agentState(result.stdout) === 'done')) return { state: 'gone', target: target.target };
  if (result.code !== 0 && /timeout/i.test(`${result.stdout}\n${result.stderr}`)) return { state: 'timeout', target: target.target };
  if (result.code !== 0) throw new SessionError(EXIT.error, `herdr agent wait failed: ${(result.stderr || result.stdout).trim()}`);
  return { state: agentState(result.stdout) ?? 'unknown', target: target.target };
}
function requireGone(watched) {
  if (watched.state === 'gone') return watched;
  if (watched.state === 'timeout') throw new SessionError(EXIT.timeout, `watch timed out for ${watched.target}`);
  throw new SessionError(EXIT.blocked, `target is not gone: ${watched.target}`);
}
async function waitForClose(deps, target, timeout, dialogAfter) {
  if (target.goneAgent) return { state: 'gone', target: target.target, dialogAnswered: false };
  const deadline = deps.now() + timeout;
  do {
    const remaining = Math.max(1, deadline - deps.now());
    const waited = waitForGone(deps, target, Math.min(dialogAfter, remaining));
    if (waited.state === 'gone') return { ...waited, dialogAnswered: false };
    const paneText = callOrFail(deps, ['pane', 'read', target.pane, '--source', 'recent-unwrapped', '--lines', '40']);
    if (!exitDialog(paneText)) {
      if (waited.state !== 'timeout') return { ...requireGone(waited), dialogAnswered: false };
      if (deps.now() < deadline) continue;
      return { ...requireGone(waited), dialogAnswered: false };
    }
    const process = callOrFail(deps, ['pane', 'process-info', '--pane', target.pane]);
    const listed = childProcesses(deps, processPid(process));
    if (listed.error || listed.children.length === 0) throw new SessionError(EXIT.blocked, `Claude exit dialog children could not be listed for ${target.pane}`, { dialog: 'children-unknown', childrenError: listed.error ?? 'PowerShell returned no child processes' });
    if (!onlyMcpChildren(listed.children)) {
      const argv = listed.children.map((child) => child?.CommandLine ?? child?.commandLine ?? child?.argv ?? null);
      throw new SessionError(EXIT.blocked, `Claude exit dialog has a live background process in ${target.pane}`, { dialog: 'background-process-live', argv });
    }
    callOrFail(deps, ['pane', 'send-keys', target.pane, 'enter']);
    const afterAnswer = Math.max(1, deadline - deps.now());
    return { ...requireGone(waitForGone(deps, target, afterAnswer)), dialogAnswered: true };
  } while (deps.now() < deadline);
  throw new SessionError(EXIT.timeout, `watch timed out for ${target.target}`);
}

async function closeTarget(deps, target, timeout, dialogAfter) {
  const watched = target.goneAgent
    ? { state: 'gone', target: target.target, dialogAnswered: false }
    : await waitForClose(deps, target, timeout, dialogAfter);
  const deadline = deps.now() + timeout;
  do {
    const info = callOrFail(deps, ['pane', 'process-info', '--pane', target.pane]);
    if (!hasClaude(info)) {
      let paneText = callOrFail(deps, ['pane', 'read', target.pane, '--source', 'recent-unwrapped', '--lines', '40']);
      let match = /Resume this session with:\s*\r?\n\s*claude --resume ([0-9a-f-]{36})/i.exec(paneText);
      if (!match) {
        await deps.sleep(100);
        paneText = callOrFail(deps, ['pane', 'read', target.pane, '--source', 'recent-unwrapped', '--lines', '40']);
        match = /Resume this session with:\s*\r?\n\s*claude --resume ([0-9a-f-]{36})/i.exec(paneText);
      }
      callOrFail(deps, ['pane', 'close', target.pane]);
      return { ...watched, resumeId: match?.[1] ?? null, closed: true };
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(100);
  } while (true);
  throw new SessionError(EXIT.blocked, `pane ${target.pane} still has a live Claude process`);
}

async function retire(opts, deps, state) {
  if (opts.positional.length !== 1) usage('retire needs one target');
  required(opts, 'mode');
  if (!['exit', 'close', 'exit+close'].includes(opts.mode)) usage('--mode must be exit, close, or exit+close');
  const self = opts.positional[0] === 'self';
  if (self || opts.positional[0] === 'parent') opts.currentPane = inHerdr(deps);
  const target = await resolveTarget(opts, state, opts.positional[0], deps);
  if (self && opts.mode !== 'exit') usage('retire self only supports --mode exit');
  const timeout = positive(opts.timeout, '--timeout', 60_000);
  const dialogAfter = positive(opts.dialogAfterMs, '--dialog-after-ms', 15_000);
  if (self) return { self, target, timeout };
  let resumeId = null; let closed = false;
  if (opts.mode === 'exit' || opts.mode === 'exit+close') callOrFail(deps, ['agent', 'prompt', target.target, '/exit']);
  let dialogAnswered = false;
  if (opts.mode === 'close' || opts.mode === 'exit+close') ({ resumeId, closed, dialogAnswered } = await closeTarget(deps, target, timeout, dialogAfter));
  return { target: target.target, mode: opts.mode, resumeId, closed, dialogAnswered, resolvedFrom: target.resolvedFrom ?? null, finalMessagePath: finalMessagePath(deps, state, target) };
}

async function chain(opts, deps, state) {
  const callerPane = inHerdr(deps); opts.currentPane = callerPane;
  required(opts, 'handoff', 'model', 'effort', 'name');
  const handoff = resolve(opts.handoff);
  if (!isAbsolute(opts.handoff) || !deps.exists(handoff)) usage(`handoff file does not exist: ${handoff}`);
  const caller = callOrFail(deps, ['agent', 'get', callerPane]);
  const callerSession = sessionId(caller);
  if (opts.captureFinal && !callerSession) usage('capture-final needs the caller session id from herdr agent get');
  const pane = callOrFail(deps, ['pane', 'get', callerPane]);
  const callerContext = contextOf(pane);
  const callerProcess = callOrFail(deps, ['pane', 'process-info', '--pane', callerPane]);
  const callerModel = processModel(callerProcess);
  const successorTimeout = positive(opts.successorTimeout, '--successor-timeout', 90_000);
  const spawned = await spawn({ ...opts, from: callerPane, readinessTimeout: successorTimeout }, deps, state, { chain: true });
  const chainId = `${callerSession ?? callerPane}:${spawned.record.sessionId ?? spawned.record.pane}:${deps.timestamp()}`;
  if (!spawned.ready) {
    return { exit: EXIT.timeout, output: { chainId, outcome: 'successor-not-ready', callerPane, callerSession, callerContext, callerModel, successorPane: spawned.record.pane, nextStep: 'inspect the successor pane; caller remains active' }, row: { chainId, outcome: 'successor-not-ready', callerPane, callerSession, callerContext, callerModel, successorPane: spawned.record.pane } };
  }
  const delivered = await brief({ verb: 'brief', positional: [opts.name], file: handoff, wait: true, timeout: opts.successorTimeout }, deps, state);
  const modelChanged = callerModel !== null && callerModel !== opts.model;
  const row = { chainId, callerPane, callerSession, callerContext, callerModel, successorPane: spawned.record.pane, successorSession: spawned.record.sessionId, successorModel: opts.model, modelChanged, handoff, ts: deps.timestamp() };
  state.chains.push(row); saveState(deps, opts.log, state);
  const output = { ...row, accepted: delivered.accepted, nextStep: `run session status --last, then cite chain ${chainId} in the landing receipt`, ...(modelChanged ? { warning: 'model changed: the brief must carry the merge/deploy-authority clause' } : {}) };
  return { self: !opts.noRetire, captureSession: opts.captureFinal ? callerSession : null, target: { target: callerPane, pane: callerPane, sessionId: callerSession }, row, output };
}

function status(opts, deps) {
  const rows = deps.exists(opts.log) ? deps.read(opts.log).split(/\r?\n/).filter(Boolean).map(parsed).filter(Boolean) : [];
  let found = rows.filter((row) => row.verb === 'chain' || row.chainId);
  if (opts.chain) found = found.filter((row) => row.chainId === opts.chain);
  if (opts.last || !opts.chain) found = found.slice(-1);
  return { rows: found };
}

export async function runSession(argv, overrides = {}) {
  const deps = {
    exec: execute, exists: existsSync, read: (path) => readFileSync(path, 'utf8'), write: (path, value) => writeFileSync(path, value, 'utf8'),
    remove: (path) => rmSync(path, { force: true }), mkdir: (path) => mkdirSync(path, { recursive: true }), append: (path, value) => appendFileSync(path, value, 'utf8'),
    env: process.env, now: () => Date.now(), timestamp: () => new Date().toISOString(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)), ...overrides,
  };
  const started = deps.now(); let opts;
  try { opts = parseArgs(argv); Object.assign(opts, resolveLogPath(opts, deps)); }
  catch (error) {
    const root = logFromArgv(argv, deps); const output = { error: error.message, ...(error.details ?? {}) };
    const row = { ts: deps.timestamp(), verb: argv[0] ?? null, state: 'usage-error', exit: error.code ?? EXIT.usage, error: error.message };
    if (!isHelp(argv[0])) appendRow(deps, root.log, row);
    return { exit: error.code ?? EXIT.usage, output, row, ...root };
  }
  const base = { ts: deps.timestamp(), verb: opts.verb, state: null, exit: EXIT.ok, error: null };
  let result;
  try {
    const state = loadState(deps, opts.log);
    if (opts.verb === 'spawn') { const spawned = await spawn(opts, deps, state); result = { output: spawned.record, row: spawned.record }; }
    else if (opts.verb === 'brief') { const output = await brief(opts, deps, state); result = { output, row: output }; }
    else if (opts.verb === 'watch') { const output = await watch(opts, deps, state); result = { output, row: output }; }
    else if (opts.verb === 'retire') {
      const retired = await retire(opts, deps, state);
      if (retired.self) {
        const session = Object.values(state.sessions).find((item) => item.pane === opts.currentPane);
        let finalMessagePath = null;
        if (opts.captureFinal) {
          const current = call(deps, ['agent', 'get', opts.currentPane]);
          const id = (current.code === 0 ? sessionId(current.stdout) : null) ?? session?.sessionId ?? null;
          finalMessagePath = prepareFinalCapture(deps, id);
        }
        const output = { target: opts.currentPane, mode: 'exit', resumeId: null, closed: false, finalMessagePath, notice: 'this must be your last tool call' };
        const row = { ...base, ...output, state: 'retiring' };
        appendRow(deps, opts.log, row);
        const sent = call(deps, ['agent', 'prompt', opts.currentPane, '/exit']);
        return { exit: sent.code === 0 ? EXIT.ok : EXIT.error, output: sent.code === 0 ? output : { error: `herdr agent prompt failed: ${(sent.stderr || sent.stdout).trim()}` }, row, log: opts.log, logSource: opts.logSource };
      }
      result = { output: retired, row: retired };
    } else if (opts.verb === 'chain') {
      const chained = await chain(opts, deps, state);
      if (chained.self) {
        if (chained.captureSession) {
          const finalMessagePath = prepareFinalCapture(deps, chained.captureSession);
          chained.output.finalMessagePath = finalMessagePath;
          chained.row.finalMessagePath = finalMessagePath;
        }
        const committed = { ...base, ...chained.row, state: 'chained' };
        appendRow(deps, opts.log, committed);
        const sent = call(deps, ['agent', 'prompt', chained.target.target, '/exit']);
        return { exit: sent.code === 0 ? EXIT.ok : EXIT.error, output: chained.output, row: committed, log: opts.log, logSource: opts.logSource };
      }
      result = { exit: chained.exit, output: chained.output, row: chained.row };
    } else if (opts.verb === 'status') { const output = status(opts, deps); result = { output, row: { state: 'reported' } }; }
  } catch (error) { result = { exit: error instanceof SessionError ? error.code : EXIT.error, output: { error: error.message, ...(error.details ?? {}) }, row: { state: 'failed', ...(error.details ?? {}) } }; }
  const exit = result.exit ?? EXIT.ok;
  const row = { ...base, ...(result.row ?? {}), exit, error: result.output?.error ?? null, waitMs: deps.now() - started };
  appendRow(deps, opts.log, row);
  return { exit, output: result.output, row, log: opts.log, logSource: opts.logSource };
}

async function main() {
  const result = await runSession(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exit;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
