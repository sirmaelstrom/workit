#!/usr/bin/env node
/**
 * One-step lane lifecycle helper. Each invocation emits one JSON document and
 * appends one JSONL instrumentation row. No prompt body is ever shell-parsed.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT = Object.freeze({ OK: 0, USAGE: 2, BLOCKED: 3, TIMEOUT: 4, CHECK_FAILED: 5, PLAN_LOW: 6 });
export const EXIT_CODES = Object.freeze({ ok: 0, blocked: 3, timeout: 4, artifactCheckFailed: 5, planLow: 6 });
// Seeded only from a captured refusal, never an invented one. This string was
// read off lane O's pane at 2026-09-01 22:12Z; herdr reported that agent as
// `idle` the whole time the modal was up, so the pane text is the only signal.
export const PLAN_REFUSAL_PATTERNS = Object.freeze([/hit your usage limit/i]);
const SWEEP_SCRIPT = 'D:\\Development\\infrastructure\\herdr-lanes.ps1';
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
    throw new LaneError(EXIT.TIMEOUT, `${program} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
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

function deepFind(value, names) {
  if (!value || typeof value !== 'object') return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined) return value[name];
  }
  for (const child of Object.values(value)) {
    const found = deepFind(child, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

function responseState(text, fallback = null) {
  const parsed = parseJson(text);
  const fromJson = deepFind(parsed, ['state', 'status', 'agent_status']);
  if (typeof fromJson === 'string') return fromJson.toLowerCase();
  const match = /\b(blocked|working|idle|done|unknown|timeout)\b/i.exec(String(text));
  return match ? match[1].toLowerCase() : fallback;
}

function responseText(text) {
  const parsed = parseJson(text);
  const found = deepFind(parsed, ['text', 'output', 'content']);
  return typeof found === 'string' ? found : String(text);
}

function parseArgs(argv) {
  const [verb, ...tokens] = argv;
  if (!VERBS.has(verb)) usage(`expected one verb: ${[...VERBS].join(', ')}`);
  const opts = { verb, positional: [], agentArgs: [] };
  const booleanFlags = new Set(['--expect-commit', '--live', '--force', '--list']);
  const valueFlags = new Set([
    '--repo', '--branch', '--base', '--label', '--pane', '--kind', '--model', '--reasoning', '--sandbox',
    '--permission-mode', '--file', '--until', '--timeout', '--expect-file', '--expect-pr', '--to', '--log',
    '--plan-floor', '--path', '--slug', '--workspace-root', '--lane',
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      opts.agentArgs = tokens.slice(i + 1);
      break;
    }
    if (token === '--root') {
      const value = tokens[++i];
      if (value === undefined) usage('--root needs a value');
      (opts.root ??= []).push(value);
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
  opts.log = resolve(opts.log ?? 'lane-log.jsonl');
  return opts;
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
  try {
    const parsed = JSON.parse(deps.read(path));
    return parsed && typeof parsed === 'object' ? parsed : emptyState();
  } catch {
    throw new LaneError(EXIT.USAGE, `lane state is not valid JSON: ${path}`);
  }
}

function saveState(deps, logPath, state) {
  deps.write(statePath(logPath), `${JSON.stringify(state, null, 2)}\n`);
}

function required(opts, ...names) {
  for (const name of names) if (!opts[name]) usage(`${opts.verb} needs --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}

function agentOption(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
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

function paneAtPrompt(text) {
  const lines = responseText(text).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.length > 0 && /(?:^PS\s+.+>|^[A-Za-z]:\\.*>|>)\s*$/.test(lines.at(-1));
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
  throw new LaneError(EXIT.TIMEOUT, `pane ${pane} never returned to a shell prompt`);
}

function laneSlug(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) usage('could not derive a worktree slug from the branch; pass --slug');
  return slug;
}

async function prepareCodexPane(opts, deps) {
  const npmRoot = deps.platform === 'win32'
    ? callOrFail(deps, deps.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g']).trim()
    : callOrFail(deps, 'npm', ['root', '-g']).trim();
  const bin = deps.findCodexBin(npmRoot);
  const escaped = bin.replace(/"/g, '`"');
  const command = `$env:PATH = "${escaped};" + $env:PATH; (Get-Command codex).Source`;
  callOrFail(deps, 'herdr', ['pane', 'run', opts.pane, command]);
  const deadline = deps.now() + 30_000;
  do {
    const snapshot = callOrFail(deps, 'herdr', ['pane', 'read', opts.pane, '--source', 'detection', '--lines', '40']);
    if (paneIsCodexReady(snapshot)) return;
    await deps.sleep(100);
  } while (deps.now() < deadline);
  throw new LaneError(EXIT.TIMEOUT, `timed out waiting for codex.exe and the shell prompt in pane ${opts.pane}`);
}

function restoreFocus(deps) {
  const conductorPane = deps.env.HERDR_PANE_ID;
  if (!conductorPane) throw new LaneError(EXIT.TIMEOUT, 'HERDR_PANE_ID is required to restore conductor focus');
  callOrFail(deps, 'herdr', ['agent', 'focus', conductorPane]);
  const listing = callOrFail(deps, 'herdr', ['agent', 'list']);
  const parsed = parseJson(listing);
  const agents = deepFind(parsed, ['agents']);
  if (Array.isArray(agents)) {
    const conductor = agents.find((agent) => (agent.pane_id ?? agent.paneId) === conductorPane);
    if (!conductor || conductor.focused !== true) {
      throw new LaneError(EXIT.TIMEOUT, `conductor pane ${conductorPane} was not restored to focus`);
    }
  } else if (!/"focused"\s*:\s*true/i.test(listing)) {
    throw new LaneError(EXIT.TIMEOUT, `could not verify conductor pane ${conductorPane} is focused`);
  }
}

async function createLane(opts, deps, state) {
  required(opts, 'repo', 'branch', 'base', 'label');
  if (!isAbsolute(opts.repo)) usage('create --repo must be absolute');
  const repo = resolve(opts.repo);
  const exists = call(deps, 'git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${opts.branch}`]);
  if (exists.code === 0) usage(`branch already exists: ${opts.branch}`);
  if (exists.code !== 1) throw new LaneError(EXIT.TIMEOUT, `could not inspect branch ${opts.branch}: ${exists.stderr.trim()}`);
  // C13: the review-council confines code_root to the projects tree and refuses
  // a lane under herdr's default root, so the lane lands beside its repo as
  // <workspace>/projects/<repo>-wt-<slug> — the worktree-rooting recipe. The
  // path is declared here and returned; no other verb may assume it (C7).
  const path = opts.path ? resolve(opts.path) : `${repo}-wt-${laneSlug(opts.slug ?? opts.branch)}`;
  if (deps.exists(path)) usage(`worktree path already exists: ${path}`);
  const raw = callOrFail(deps, 'herdr', [
    'worktree', 'create', '--cwd', repo, '--branch', opts.branch, '--base', opts.base, '--no-focus', '--label', opts.label,
    '--path', path,
  ]);
  const parsed = parseJson(raw);
  const output = {
    workspaceId: deepFind(parsed, ['workspace_id', 'workspaceId', 'id']) ?? null,
    paneId: deepFind(parsed, ['pane_id', 'paneId']) ?? null,
    path: deepFind(parsed, ['path', 'worktree_path', 'worktreePath']) ?? path,
    branch: deepFind(parsed, ['branch']) ?? opts.branch,
  };
  state.creates.push({ ...output, base: opts.base, label: opts.label });
  saveState(deps, opts.log, state);
  return { output, row: { lane: opts.label, state: 'created' } };
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
    if (mode === 'dontAsk') usage('claude permission mode dontAsk is refused because it auto-denies tools');
    if (!['bypassPermissions', 'acceptEdits'].includes(mode)) usage(`unsupported claude permission mode: ${mode}`);
    if (mode === 'acceptEdits') warning = 'acceptEdits may block on Bash outside the allowlist';
    native = withoutOption(withoutOption(native, '--permission-mode'), '--effort');
    native = ['--model', opts.model, '--permission-mode', mode, '--effort', opts.reasoning, ...native];
  } else {
    const sandbox = opts.sandbox ?? agentOption(native, '--sandbox');
    if (!sandbox) usage('codex start needs an explicit --sandbox');
    if (sandbox === 'read-only') usage('codex read-only sandbox is refused on Windows because it can return ungrounded answers');
    native = withoutOption(withoutOption(native, '--sandbox'), '--ask-for-approval');
    await prepareCodexPane(opts, deps);
    native = [
      '--model', opts.model, '--ask-for-approval', 'never', '--sandbox', sandbox,
      '-c', `model_reasoning_effort=${opts.reasoning}`, ...native,
    ];
  }

  const raw = callOrFail(deps, 'herdr', ['agent', 'start', opts.name, '--kind', opts.kind, '--pane', opts.pane, '--', ...native]);
  restoreFocus(deps);
  const prior = state.creates.find((created) => created.paneId === opts.pane) ?? {};
  state.lanes[opts.name] = {
    ...(state.lanes[opts.name] ?? {}),
    pane: opts.pane,
    kind: opts.kind,
    model: opts.model,
    reasoning: opts.reasoning ?? null,
    branch: prior.branch ?? null,
    base: prior.base ?? null,
    path: prior.path ?? null,
  };
  saveState(deps, opts.log, state);
  return {
    output: {
      agent: deepFind(parseJson(raw), ['name', 'agent']) ?? opts.name,
      kind: opts.kind,
      model: opts.model,
      startedAt: deps.timestamp(),
      ...(warning ? { warning } : {}),
    },
    row: { lane: opts.name, kind: opts.kind, model: opts.model, reasoning: opts.reasoning ?? null, state: 'started' },
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
  state.lanes[opts.name] = { ...lane, promptFile: file };
  saveState(deps, opts.log, state);
  const stateAfter = responseState(raw, 'working');
  return {
    output: { accepted: deepFind(parseJson(raw), ['accepted']) ?? true, stateAfter },
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
  if (opts.until && !['blocked', 'idle', 'done'].includes(opts.until)) {
    usage('wait --until must be blocked, idle, or done');
  }
  // 20, not 10: the measured drain was 79% → 0% in ~36 min at four concurrent
  // codex consumers, and the "<10% left" warning arrived ~7 min before refusal.
  const floor = positiveNumber(opts.planFloor, '--plan-floor', 20);
  if (floor > 100) usage('--plan-floor must not exceed 100');
  const deadline = deps.now() + timeout;
  let meter = { plan5h: null, planWeekly: null };

  while (true) {
    const remaining = Math.max(1, deadline - deps.now());
    const pollMs = Math.min(1_000, remaining);
    const args = ['agent', 'wait', opts.name];
    if (opts.until) args.push('--until', opts.until);
    args.push('--timeout', String(pollMs));
    const waited = call(deps, 'herdr', args);
    const stateAfter = waited.code === 0 ? responseState(waited.stdout, null) : null;

    const read = call(deps, 'herdr', ['agent', 'read', opts.name, '--lines', '40']);
    if (read.code !== 0) {
      throw new LaneError(EXIT.TIMEOUT, `herdr agent read failed: ${read.stderr.trim() || read.stdout.trim()}`);
    }
    meter = scrapePlanMeter(read.stdout);
    // C11(a): herdr reports the lane `idle` while the refusal modal is up, so
    // the pane text is checked before any lifecycle state is trusted.
    const refusal = matchPlanRefusal(read.stdout);
    if (refusal) {
      return {
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-refused', refusal, plan5h: meter.plan5h, planWeekly: meter.planWeekly },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-refused'), ...meter },
      };
    }
    if (meter.plan5h !== null && meter.plan5h < floor) {
      return {
        exit: EXIT.PLAN_LOW,
        output: { state: 'plan-low', plan5h: meter.plan5h, planWeekly: meter.planWeekly, planFloor: floor },
        row: { ...laneInstrumentation(opts.name, lane, 'plan-low'), ...meter },
      };
    }

    if (waited.code === 0 && stateAfter === 'blocked') {
      return {
        exit: EXIT.BLOCKED,
        output: { state: 'blocked', dialog: responseText(read.stdout) },
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
    if (waited.code !== 0 && !/timeout/i.test(`${waited.stderr}\n${waited.stdout}`)) {
      throw new LaneError(EXIT.TIMEOUT, `herdr agent wait failed: ${waited.stderr.trim() || waited.stdout.trim()}`);
    }
    if (deps.now() >= deadline) {
      return {
        exit: EXIT.TIMEOUT,
        output: { state: 'timeout' },
        row: { ...laneInstrumentation(opts.name, lane, 'timeout'), ...meter },
      };
    }
    await deps.sleep(Math.min(100, Math.max(1, deadline - deps.now())));
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
    if (count.code !== 0) throw new LaneError(EXIT.TIMEOUT, `git rev-list failed: ${count.stderr.trim()}`);
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
      failedExpectation = `--expect-pr ${opts.expectPr}: PR does not exist`;
    } else {
      const doc = parseJson(viewed.stdout);
      evidence = doc;
      if (doc?.headRefName !== lane.branch) {
        failedExpectation = `--expect-pr ${opts.expectPr}: head must equal ${lane.branch}, got ${doc?.headRefName ?? 'unknown'}`;
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
  const raw = call(deps, 'herdr', ['agent', 'wait', opts.name, '--until', 'idle', '--timeout', String(timeout)]);
  if (raw.code !== 0) {
    if (/timeout/i.test(`${raw.stderr}\n${raw.stdout}`)) {
      return { exit: EXIT.TIMEOUT, output: { state: 'timeout' }, row: laneInstrumentation(opts.name, lane, 'timeout') };
    }
    throw new LaneError(EXIT.TIMEOUT, `herdr agent wait failed: ${raw.stderr.trim() || raw.stdout.trim()}`);
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
  required(opts, 'to', 'model');
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

  const started = await startLane({
    ...opts,
    verb: 'start',
    pane: samePane,
    kind: 'claude',
    permissionMode: 'bypassPermissions',
    agentArgs: [],
  }, deps, state);
  const prompted = await promptLane({ ...opts, verb: 'prompt', file: samePrompt }, deps, state);
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
    },
  };
}

function sweepRoots(opts, deps) {
  if (Array.isArray(opts.root) && opts.root.length > 0) return opts.root.map((root) => resolve(root));
  const roots = [];
  // Legacy lanes: herdr's own default root, <profile>\.herdr\worktrees\<repo>\<lane>.
  if (deps.env.USERPROFILE) roots.push(join(deps.env.USERPROFILE, '.herdr', 'worktrees'));
  // C13 lanes: <workspace>\projects\<repo>-wt-<slug>. The delegate walks
  // <root>/<repo>/<lane>, so the root it needs is the WORKSPACE, not projects/.
  const workspace = opts.workspaceRoot ?? deps.env.WORKIT_WORKSPACE_ROOT ?? null;
  if (workspace) roots.push(resolve(workspace));
  if (roots.length === 0) {
    usage('sweep needs --root <path>, or --workspace-root / WORKIT_WORKSPACE_ROOT, to know where lanes live');
  }
  return roots;
}

async function sweepLanes(opts, deps) {
  const roots = sweepRoots(opts, deps);
  // The delegate is LIST-ONLY without -Clean, and S8 wants the directory gone.
  // -Force is never implied: its HOLD verdicts are what keep unfinished work.
  const flags = [];
  if (!opts.list) flags.push('-Clean');
  if (opts.lane) flags.push('-Lane', opts.lane);
  if (opts.force) flags.push('-Force');
  if (!deps.exists(SWEEP_SCRIPT)) {
    const suffix = flags.length > 0 ? ` ${flags.join(' ')}` : '';
    return {
      exit: EXIT.OK,
      output: {
        delegated: false,
        commands: roots.map((root) => `pwsh -NoProfile -File "${SWEEP_SCRIPT}" -WorktreeRoot "${root}"${suffix}`),
      },
      row: { lane: null, state: 'delegate-missing' },
    };
  }
  const results = roots.map((root) => ({
    root,
    output: callOrFail(deps, 'pwsh', ['-NoProfile', '-File', SWEEP_SCRIPT, '-WorktreeRoot', root, ...flags]),
  }));
  return {
    exit: EXIT.OK,
    output: { delegated: true, roots: results },
    row: { lane: null, state: 'swept' },
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
  const source = String(text);
  const five = [...source.matchAll(/5h\s+(\d+)%\s+left/gi)].at(-1);
  const weekly = [...source.matchAll(/weekly\s+(\d+)%\s+left/gi)].at(-1);
  return { plan5h: five ? Number(five[1]) : null, planWeekly: weekly ? Number(weekly[1]) : null };
}

function appendRow(deps, logPath, row) {
  deps.append(logPath, `${JSON.stringify(row)}\n`);
}

export async function runLane(argv, overrides = {}) {
  const deps = {
    exec: execute,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, value) => writeFileSync(path, value, 'utf8'),
    append: (path, value) => appendFileSync(path, value, 'utf8'),
    env: process.env,
    platform: process.platform,
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    findCodexBin: defaultFindCodexBin,
    ...overrides,
  };

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    return { exit: error.code ?? EXIT.USAGE, output: { error: error.message } };
  }

  const started = deps.now();
  const baseRow = {
    ts: deps.timestamp(),
    lane: opts.name ?? opts.label ?? opts.branch ?? null,
    verb: opts.verb,
    kind: opts.kind ?? null,
    model: opts.model ?? null,
    reasoning: opts.reasoning ?? null,
    state: null,
    waitMs: 0,
    exit: EXIT.OK,
    plan5h: null,
    planWeekly: null,
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
      case 'sweep': result = await sweepLanes(opts, deps); break;
      default: throw new LaneError(EXIT.USAGE, `${opts.verb} is not implemented yet`);
    }
    result.exit ??= EXIT.OK;
  } catch (error) {
    const code = error instanceof LaneError ? error.code : EXIT.TIMEOUT;
    result = { exit: code, output: { error: error.message, ...(error.details ?? {}) }, row: {} };
  }

  const row = {
    ...baseRow,
    ...(result.row ?? {}),
    waitMs: deps.now() - started,
    exit: result.exit,
  };
  appendRow(deps, opts.log, row);
  return { exit: result.exit, output: result.output, row };
}

async function main() {
  const result = await runLane(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exit;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
