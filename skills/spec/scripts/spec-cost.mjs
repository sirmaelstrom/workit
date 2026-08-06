#!/usr/bin/env node
/**
 * spec-cost.mjs — /spec per-phase token/cost instrumentation CLI.
 *
 * Two subcommands:
 *   mark   --state <path> --phase <name> --event start|end
 *   report --state <path> [--projects-dir <dir>]
 *
 * `mark` writes/updates a small JSON state file recording phase start/end
 * timestamps (phases are sequential — starting a new phase auto-closes any
 * still-open prior entry). `report` scans this machine's Claude Code
 * subagent transcripts (`~/.claude/projects/<cwd-slug>/<session>/subagents/agent-NAME.jsonl`),
 * attributes each transcript file to a phase window by file mtime, aggregates
 * token usage per phase/model (message-id-deduped), prices it via pricing.mjs,
 * writes cost-report.json next to the state file, and prints a compact
 * markdown table.
 *
 * Collection is post-hoc (reads transcripts after the fact) — zero runtime
 * instrumentation, and orchestrator-session tokens are NOT counted (only
 * subagent transcripts exist as files). Instrumentation must never hard-fail
 * the /spec pipeline: missing/empty transcript data produces a valid
 * zero-row report on stderr note + exit 0.
 *
 * Node built-ins only (no deps in this repo).
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { resolveAnthropicFamily, computeCostUsd } from './pricing.mjs';

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Fresh state object for a brand-new state file. */
export function createState(cwd) {
  return { schema_version: '1.0', cwd, phases: [] };
}

/**
 * Pure phase-marking transition. Returns a NEW state object (does not mutate
 * `state`) plus an optional warning string (non-fatal — caller decides how
 * to surface it).
 *
 * start: appends a new open phase entry, auto-closing any prior still-open
 *        entry (phases are sequential — one open at a time).
 * end:   closes the most recent still-open entry matching `phase`; if none
 *        is open for that phase name, returns a warning and leaves state
 *        unchanged (no-op).
 */
export function markPhase(state, phase, event, now) {
  const next = {
    ...state,
    phases: state.phases.map((p) => ({ ...p })),
  };

  if (event === 'start') {
    for (const p of next.phases) {
      if (p.endedAt === null) p.endedAt = now;
    }
    next.phases.push({ phase, startedAt: now, endedAt: null });
    return { state: next, warning: null };
  }

  if (event === 'end') {
    let target = null;
    for (let i = next.phases.length - 1; i >= 0; i--) {
      if (next.phases[i].phase === phase && next.phases[i].endedAt === null) {
        target = next.phases[i];
        break;
      }
    }
    if (!target) {
      return { state: next, warning: `no open phase entry for "${phase}" to end` };
    }
    target.endedAt = now;
    return { state: next, warning: null };
  }

  throw new Error(`event must be "start" or "end", got ${JSON.stringify(event)}`);
}

/** `<cwd-slug>` rule: absolute cwd with every non-alphanumeric char -> '-'. */
export function slugifyCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve the Claude Code projects directory holding this run's transcripts,
 * and report WHICH rule produced it.
 *
 * The cwd-slug default is wrong whenever `mark` ran from somewhere other than
 * the directory the session was launched in — which, for the /spec pipeline, is
 * the normal case rather than the edge case: workshops live under
 * `data/outputs/workshops/` while the session is launched in a repo under
 * `projects/`. The derived slug then names a directory that has never existed,
 * every phase collects zero transcripts, and the report prints a clean $0 that
 * reads as "free" instead of "not measured".
 *
 * Precedence: explicit flag > env var > cwd slug (if it exists) > evidence-based
 * recovery. Recovery scans the projects root for the ONE directory holding
 * subagent transcripts inside a recorded phase window; ambiguity resolves to
 * nothing rather than to a guess.
 *
 * Returns `{ dir, rule, candidates }`. `dir` is null when nothing resolved.
 */
export function resolveProjectsDir(state, { projectsDir = null, env = process.env } = {}) {
  const explicit = (dir, rule) => ({ dir, rule, exists: existsSync(dir), candidates: [] });

  if (projectsDir) return explicit(resolve(projectsDir), 'flag');

  const fromEnv = env.WORKIT_CLAUDE_PROJECTS_DIR;
  if (fromEnv) return explicit(resolve(fromEnv), 'env');

  const root = join(homedir(), '.claude', 'projects');
  const bySlug = join(root, slugifyCwd(state.cwd));
  if (existsSync(bySlug)) return { dir: bySlug, rule: 'cwd-slug', exists: true, candidates: [] };

  // Recovery: which projects dir actually has transcripts in a phase window?
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { dir: null, rule: 'none', exists: false, candidates: [] };
  }

  const nowMs = Date.now();
  const matches = [];
  for (const entry of entries) {
    const dir = join(root, entry.name);
    let hits = 0;
    for (const file of findAgentJsonlFiles(dir)) {
      let mtimeMs;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (attributePhase(state.phases, mtimeMs, nowMs) !== null) hits++;
    }
    if (hits > 0) matches.push({ dir, hits });
  }

  if (matches.length === 1) return { dir: matches[0].dir, rule: 'recovered', exists: true, candidates: [] };
  return { dir: null, rule: 'none', exists: false, candidates: matches.map((m) => m.dir) };
}

// ---------------------------------------------------------------------------
// Transcript collection
// ---------------------------------------------------------------------------

/** Find `<projectsDir>/<session>/subagents/agent-NAME.jsonl` files. Missing dirs -> []. */
function findAgentJsonlFiles(projectsDir) {
  const files = [];
  let sessionEntries;
  try {
    sessionEntries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of sessionEntries) {
    if (!entry.isDirectory()) continue;
    const subagentsDir = join(projectsDir, entry.name, 'subagents');
    let subEntries;
    try {
      subEntries = readdirSync(subagentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of subEntries) {
      if (f.isFile() && /^agent-.*\.jsonl$/.test(f.name)) {
        files.push(join(subagentsDir, f.name));
      }
    }
  }
  return files;
}

function emptyTokenCounts() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
  };
}

function addTokenCounts(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreation5mTokens: a.cacheCreation5mTokens + b.cacheCreation5mTokens,
    cacheCreation1hTokens: a.cacheCreation1hTokens + b.cacheCreation1hTokens,
  };
}

/**
 * Normalize a raw `message.usage` block (JSONL shape) into our token-class
 * object. When `cache_creation` split is absent, bill the whole
 * `cache_creation_input_tokens` at the 5m rate (conservative under-count —
 * matches the /review precedent).
 */
function parseUsageBlock(usage) {
  const counts = emptyTokenCounts();
  counts.inputTokens = usage.input_tokens ?? 0;
  counts.outputTokens = usage.output_tokens ?? 0;
  counts.cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    counts.cacheCreation5mTokens = usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
    counts.cacheCreation1hTokens = usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else {
    counts.cacheCreation5mTokens = usage.cache_creation_input_tokens ?? 0;
    counts.cacheCreation1hTokens = 0;
  }
  return counts;
}

/** Which phase's [startedAt, endedAt||now] window contains `mtimeMs`? null if none. */
function attributePhase(phases, mtimeMs, nowMs) {
  for (const p of phases) {
    const startMs = new Date(p.startedAt).getTime();
    const endMs = p.endedAt ? new Date(p.endedAt).getTime() : nowMs;
    if (mtimeMs >= startMs && mtimeMs <= endMs) {
      return p.phase;
    }
  }
  return null;
}

/**
 * Scan `projectsDir` for subagent transcripts, attribute each file to a
 * phase by mtime, and aggregate token usage per phase -> per model
 * (message-id-deduped, last usage for an id wins). Models whose family
 * can't be resolved are bucketed globally under `unknownModels` instead of
 * a phase (their tokens are real but unpriceable — never silently priced
 * as $0).
 *
 * Returns `{ perPhase: Map<phase, Map<model, tokenCounts>>, unknownModels: Map<model, tokenCounts> }`.
 */
export function collectPhaseUsage(phases, projectsDir, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const perPhase = new Map();
  const unknownModels = new Map();

  const files = findAgentJsonlFiles(projectsDir);

  for (const file of files) {
    let mtimeMs;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const phase = attributePhase(phases, mtimeMs, nowMs);
    if (phase === null) continue; // outside all phase windows — ignored

    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Dedupe by message.id within this file — the same usage block repeats
    // across multiple streamed lines for one message; last seen wins.
    const byMessageId = new Map();
    let anonymousSeq = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const message = obj?.message;
      if (!message || !message.usage) continue;
      const key = message.id != null ? message.id : `__no-id-${anonymousSeq++}`;
      byMessageId.set(key, { model: message.model, usage: message.usage });
    }

    for (const { model, usage } of byMessageId.values()) {
      const counts = parseUsageBlock(usage);
      const family = resolveAnthropicFamily(model);
      if (family === null) {
        const prior = unknownModels.get(model) ?? emptyTokenCounts();
        unknownModels.set(model, addTokenCounts(prior, counts));
        continue;
      }
      if (!perPhase.has(phase)) perPhase.set(phase, new Map());
      const modelBucket = perPhase.get(phase);
      const prior = modelBucket.get(model) ?? emptyTokenCounts();
      modelBucket.set(model, addTokenCounts(prior, counts));
    }
  }

  return { perPhase, unknownModels };
}

// ---------------------------------------------------------------------------
// Report building + rendering
// ---------------------------------------------------------------------------

function round6(n) {
  return Number(n.toFixed(6));
}

/** Build the cost-report.json structure from state + collected usage. */
export function buildReport(state, collected, generatedAt, source = { dir: null, rule: 'unknown', candidates: [] }) {
  const { perPhase, unknownModels } = collected;

  let grandTotals = { ...emptyTokenCounts(), costUsd: 0 };

  const phases = state.phases.map((p) => {
    const modelBucket = perPhase.get(p.phase) ?? new Map();
    const models = {};
    let totals = { ...emptyTokenCounts(), costUsd: 0 };
    for (const [model, counts] of modelBucket.entries()) {
      const costUsd = computeCostUsd(model, counts) ?? 0;
      models[model] = { ...counts, costUsd };
      totals = {
        ...addTokenCounts(totals, counts),
        costUsd: round6(totals.costUsd + costUsd),
      };
    }
    grandTotals = {
      ...addTokenCounts(grandTotals, totals),
      costUsd: round6(grandTotals.costUsd + totals.costUsd),
    };
    return {
      phase: p.phase, startedAt: p.startedAt, endedAt: p.endedAt, models, totals,
    };
  });

  const unknownModelsArr = [...unknownModels.entries()].map(([model, counts]) => ({
    model, ...counts, costUsd: null,
  }));

  // "Nothing was measured" and "the measured cost was zero" are different facts
  // that render identically as $0.0000. Carry the difference explicitly so a
  // consumer of cost-report.json can never read an unmeasured run as free.
  const sawUsage =
    phases.some((p) => Object.keys(p.models).length > 0) || unknownModelsArr.length > 0;

  return {
    schema_version: '1.1',
    generatedAt,
    measurement: {
      measured: Boolean(source.dir) && sawUsage,
      projectsDir: source.dir,
      resolution: source.rule,
      exists: source.exists ?? null,
      candidates: source.candidates ?? [],
      // A phase never closed keeps its window open to `now`, so every later
      // transcript in that projects dir lands in it — including work from
      // unrelated sessions days afterwards. The total then grows every time the
      // report is re-run, and reads as "this phase was expensive" rather than
      // "this phase never ended". Name them so the number is interpretable.
      openPhases: state.phases.filter((p) => p.endedAt === null).map((p) => p.phase),
    },
    phases,
    totals: grandTotals,
    unknownModels: unknownModelsArr,
  };
}

function fmtCost(costUsd) {
  return costUsd == null ? 'n/a' : `$${costUsd.toFixed(4)}`;
}

/** Render the compact markdown summary table (+ totals row). */
export function renderMarkdownTable(report) {
  const header = '| Phase | In | Out | CacheR | CacheW | Cost |';
  const sep = '|---|---|---|---|---|---|';
  const rows = report.phases.map((p) => {
    const t = p.totals;
    const cacheW = t.cacheCreation5mTokens + t.cacheCreation1hTokens;
    return `| ${p.phase} | ${t.inputTokens} | ${t.outputTokens} | ${t.cacheReadTokens} | ${cacheW} | ${fmtCost(t.costUsd)} |`;
  });
  const tt = report.totals;
  const totalCacheW = tt.cacheCreation5mTokens + tt.cacheCreation1hTokens;
  const totalsRow = `| **Total** | ${tt.inputTokens} | ${tt.outputTokens} | ${tt.cacheReadTokens} | ${totalCacheW} | ${fmtCost(tt.costUsd)} |`;

  const table = [header, sep, ...rows, totalsRow].join('\n');
  const m = report.measurement;

  if (m?.openPhases?.length) {
    const banner = `> **OPEN PHASE — ${m.openPhases.join(', ')} never ended, so the window runs to now and absorbs every later transcript. Re-running grows the total. Close the phase (\`mark --event end\`) before trusting this number.**`;
    return m.measured ? [banner, '', table].join('\n') : [banner, '', renderUnmeasured(m, table)].join('\n');
  }

  if (!m || m.measured) return table;
  return renderUnmeasured(m, table);
}

/** Prepend the NOT-MEASURED banner to a rendered table. */
function renderUnmeasured(m, table) {

  // An unmeasured run must not be readable as a cheap one. The banner goes
  // ABOVE the table so it cannot be missed by someone skimming to the total.
  let why;
  if (m.resolution === 'none') {
    why = `No Claude Code projects directory could be resolved for this run.${
      m.candidates?.length
        ? ` Candidates with transcripts in a phase window: ${m.candidates.join(', ')} — re-run with --projects-dir <one of these>.`
        : ' Re-run with --projects-dir <dir>, or set WORKIT_CLAUDE_PROJECTS_DIR.'
    }`;
  } else if (m.exists === false) {
    why = `Projects dir not found: ${m.projectsDir} (rule: ${m.resolution}).`;
  } else {
    why = `Resolved ${m.projectsDir} (rule: ${m.resolution}) but no subagent transcript fell inside a phase window.`;
  }
  return [
    '> **NOT MEASURED — the totals below are zero because nothing was collected, not because the run was free.**',
    `> ${why}`,
    '',
    table,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const HELP_TEXT = `Usage:
  node spec-cost.mjs mark --state <path> --phase <name> --event start|end
  node spec-cost.mjs report --state <path> [--projects-dir <dir>]

mark    Record a phase start/end timestamp in the state file (created on
        first mark). Starting a phase auto-closes any still-open prior phase.
report  Scan this machine's Claude Code subagent transcripts, attribute them
        to phase windows by mtime, aggregate token usage + cost per phase,
        write cost-report.json next to --state, and print a markdown table.

Projects-dir resolution (report), in precedence order — the rule used is
printed to stderr and recorded in cost-report.json:
  1. --projects-dir <dir>
  2. WORKIT_CLAUDE_PROJECTS_DIR
  3. ~/.claude/projects/<slug of state.cwd>, if it exists
  4. Recovery: the ONE projects dir holding transcripts inside a phase window
     (ambiguity resolves to nothing, listing the candidates — never a guess)

The cwd slug is only correct when mark ran from the directory the session was
launched in. For /spec that is usually false — workshops live under
data/outputs/ while the session runs in a repo — so pass --projects-dir or set
the env var when the two differ.

Options:
  --state <path>          Path to the cost-log.json state file (required)
  --phase <name>          Phase name, e.g. phase-1-setup (mark only)
  --event start|end       Phase transition (mark only)
  --projects-dir <dir>    Override the Claude Code projects directory (report only)
  --help                  Print this message and exit 0

Instrumentation never hard-fails the /spec pipeline: exit 0 even when nothing
is collected. But an uncollected run is labelled NOT MEASURED in both the table
and cost-report.json — a $0 total must never be readable as "free". A phase
left open is labelled too: its window runs to now, so the total grows on every
re-run until the phase is ended.
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    command: args[0] && !args[0].startsWith('--') ? args[0] : null,
    state: null, phase: null, event: null, projectsDir: null, help: false,
  };
  const start = out.command ? 1 : 0;
  for (let i = start; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--state') out.state = args[++i] || null;
    else if (a === '--phase') out.phase = args[++i] || null;
    else if (a === '--event') out.event = args[++i] || null;
    else if (a === '--projects-dir') out.projectsDir = args[++i] || null;
  }
  return out;
}

function runMark(opts) {
  if (!opts.state || !opts.phase || !opts.event) {
    process.stderr.write('Error: mark requires --state, --phase, and --event\n');
    return 1;
  }
  if (opts.event !== 'start' && opts.event !== 'end') {
    process.stderr.write(`Error: --event must be "start" or "end", got ${JSON.stringify(opts.event)}\n`);
    return 1;
  }

  const statePath = resolve(opts.state);
  let state;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (e) {
      process.stderr.write(`Error: failed to parse state file: ${e.message}\n`);
      return 1;
    }
  } else {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
    } catch (e) {
      process.stderr.write(`Error: failed to create state directory: ${e.message}\n`);
      return 1;
    }
    state = createState(process.cwd());
  }

  const now = new Date().toISOString();
  const { state: next, warning } = markPhase(state, opts.phase, opts.event, now);
  if (warning) process.stderr.write(`Warning: ${warning}\n`);

  try {
    writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to write state file: ${e.message}\n`);
    return 1;
  }

  return 0;
}

function runReport(opts) {
  if (!opts.state) {
    process.stderr.write('Error: report requires --state\n');
    return 1;
  }

  const statePath = resolve(opts.state);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Error: failed to read/parse state file: ${e.message}\n`);
    return 1;
  }

  const source = resolveProjectsDir(state, { projectsDir: opts.projectsDir });

  // Announce the resolved directory AND the rule that produced it — a silent
  // default is exactly how this reported $0 for every workshop ever run.
  if (source.dir) {
    process.stderr.write(`Projects dir: ${source.dir} (rule: ${source.rule})\n`);
  } else {
    process.stderr.write(
      `Note: no projects dir resolved (cwd-slug of ${state.cwd} does not exist, nothing recovered)` +
      `${source.candidates.length ? `; candidates: ${source.candidates.join(', ')}` : ''}` +
      ' — writing an UNMEASURED report\n',
    );
  }

  const collected = source.dir
    ? collectPhaseUsage(state.phases, source.dir)
    : { perPhase: new Map(), unknownModels: new Map() };
  const report = buildReport(state, collected, new Date().toISOString(), source);

  if (!report.measurement.measured) {
    process.stderr.write('Note: report is NOT MEASURED — a $0 total here means "not collected", not "free"\n');
  }

  const outPath = join(dirname(statePath), 'cost-report.json');
  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to write cost-report.json: ${e.message}\n`);
    return 1;
  }

  process.stdout.write(`${renderMarkdownTable(report)}\n`);
  return 0;
}

/** Sync main returning integer exit code. Never throws — instrumentation must not gate the pipeline. */
export function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (!opts.command) {
    process.stderr.write(HELP_TEXT);
    return 1;
  }

  try {
    if (opts.command === 'mark') return runMark(opts);
    if (opts.command === 'report') return runReport(opts);
    process.stderr.write(`Error: unknown command "${opts.command}" (expected mark|report)\n`);
    return 1;
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
