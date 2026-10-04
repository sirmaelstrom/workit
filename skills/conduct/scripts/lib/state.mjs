// Run state for the goal conductor: where a run lives, how state.json is read
// and written, the events.jsonl line, and the step/seam vocabulary every
// action carries. Every clock and file operation arrives through deps.
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;
// A lock whose holder is gone, or older than this, is stale. Every verb is
// one-shot and bounded, so no live writer holds the lock this long (ASSUMPTION).
export const LOCK_STALE_MS = 60000;
const LOCK_POLL_MS = 50;

export class ConductError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The step → seam map. STEPS is its key list, so the two cannot drift apart.
// The seam is what the run analysis keys on; `null` is "no seam".
export const STEP_SEAM = Object.freeze({
  intake: 'intent-capture', anchor: 'intent-capture',
  spec: 'spec',
  mint: 'wp-mint',
  contract: 'lane-dispatch', admit: 'lane-dispatch', flip: 'lane-dispatch', create: 'lane-dispatch',
  base: 'lane-dispatch', brief: 'lane-dispatch', start: 'lane-dispatch', prompt: 'lane-dispatch',
  fallback: 'lane-dispatch',
  wait: 'lane-wait', check: 'lane-wait', 'pr-lookup': 'lane-wait',
  review: 'review-tier', post: 'review-tier', council: 'review-tier',
  ruling: 'adjudication', adjudicate: 'adjudication', reply: 'adjudication',
  'thread-ids': 'adjudication', resolve: 'adjudication',
  rebase: 'merge-gate', 'gate-cmd': 'merge-gate', gate: 'merge-gate', merge: 'merge-gate', merged: 'merge-gate',
  release: 'release',
  analyze: 'run-analysis',
  preapproval: 'touches', grant: 'touches', showcase: 'touches', touch: 'touches',
  spend: null, notify: null, receipt: null, stop: null,
});
export const STEPS = Object.freeze(Object.keys(STEP_SEAM));

export const TERMINAL_PHASES = Object.freeze(['closed', 'declined', 'sent-back']);

export function slugify(goal) {
  const slug = String(goal).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 40).replace(/-+$/, '') || 'run';
}

// First match wins: --runs-root, WORKIT_WORKSPACE_ROOT, the nearest ancestor
// of the repo holding both projects/ and data/, then ~/.workit/runs.
export function resolveRunDir({ repo, slug, env = {}, runsRoot, exists, home }) {
  let workshopDir;
  let source;
  if (runsRoot) {
    workshopDir = join(resolve(runsRoot), slug);
    source = '--runs-root';
  } else if (env.WORKIT_WORKSPACE_ROOT) {
    workshopDir = join(resolve(env.WORKIT_WORKSPACE_ROOT), 'data', 'outputs', 'workshops', slug);
    source = 'WORKIT_WORKSPACE_ROOT';
  } else {
    const ancestor = workspaceAncestor(repo, exists);
    if (ancestor) {
      workshopDir = join(ancestor, 'data', 'outputs', 'workshops', slug);
      source = 'workspace ancestor';
    } else {
      workshopDir = join(home, '.workit', 'runs', slug);
      source = 'home';
    }
  }
  return { workshopDir, runDir: join(workshopDir, 'run'), source };
}

function workspaceAncestor(repo, exists) {
  if (!repo) return null;
  for (let current = resolve(repo); ; current = dirname(current)) {
    if (exists(join(current, 'projects')) && exists(join(current, 'data'))) return current;
    if (dirname(current) === current) return null;
  }
}

export function statePath(runDir) {
  return join(runDir, 'state.json');
}

export function loadState(runDir, deps) {
  const path = statePath(runDir);
  if (!runDir || !deps.exists(path)) throw new ConductError(2, `no state.json in ${runDir}`);
  let state;
  try {
    state = JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `state.json is not valid JSON: ${error.message}`);
  }
  if (typeof state?.schemaVersion !== 'number' || state.schemaVersion > SCHEMA_VERSION) {
    throw new ConductError(2, `state.json schemaVersion ${state?.schemaVersion} is newer than this conduct.mjs supports (${SCHEMA_VERSION})`);
  }
  return state;
}

// One writer at a time: every state transaction (load, change, save) runs
// under an O_EXCL lock file beside state.json. A holder that is not alive, or
// a lock older than LOCK_STALE_MS, is stale and is taken over.
export async function withStateLock(runDir, deps, fn) {
  const path = join(runDir, 'state.lock');
  const waitMs = deps.lockWaitMs ?? 2000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      deps.writeNew(path, JSON.stringify({ pid: deps.pid, at: deps.timestamp() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try {
        holder = JSON.parse(deps.read(path));
      } catch {
        // Unreadable: treated as stale below.
      }
      const stale = !holder || !deps.pidAlive(holder.pid) || deps.now() - Date.parse(holder.at) > LOCK_STALE_MS;
      if (stale) {
        deps.remove(path);
        continue;
      }
      if (attempt * LOCK_POLL_MS >= waitMs) throw new ConductError(2, `the run is locked by pid ${holder.pid} since ${holder.at}; retry`);
      await deps.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    deps.remove(path);
  }
}

// Events are staged on the state object and written by saveState, each line
// stamped with the transaction's `rev` and a random `txn`. They are appended
// before state.json is replaced, so a failed save can leave orphan lines;
// readEvents is the recovery rule that drops them.
const staged = new WeakMap();

export function saveState(state, deps) {
  const path = statePath(state.runDir);
  const lines = staged.get(state) ?? [];
  staged.delete(state);
  state.rev = (state.rev ?? 0) + 1;
  const txn = randomBytes(6).toString('hex');
  if (lines.length) {
    deps.append(join(state.runDir, 'events.jsonl'), lines.map((line) => `${JSON.stringify({ ...line, rev: state.rev, txn })}\n`).join(''));
  }
  // Temp file then rename, so a crash mid-write never leaves half a state.json
  // (ASSUMPTION: rename within one directory replaces the file whole).
  const temp = `${path}.${deps.pid}.${txn}.tmp`;
  deps.write(temp, `${JSON.stringify(state, null, 2)}\n`);
  deps.rename(temp, path);
}

export function appendEvent(state, deps, { actionId = null, step = null, seam, kind = null, event, source = 'next', data = {}, phase = state.phase }) {
  const line = {
    ts: deps.timestamp(),
    seq: state.seq,
    actionId,
    step,
    seam: seam === undefined ? (step ? STEP_SEAM[step] ?? null : null) : seam,
    phase,
    kind,
    event,
    source,
    data,
  };
  if (!staged.has(state)) staged.set(state, []);
  staged.get(state).push(line);
}

// The recovery rule: a rev's events are the lines of the LAST transaction
// written with that rev, and a rev past the saved state's is an orphan.
export function readEvents(runDir, deps, state = loadState(runDir, deps)) {
  const path = join(runDir, 'events.jsonl');
  const lines = deps.exists(path) ? deps.read(path).split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const lastTxn = new Map(lines.map((line) => [line.rev, line.txn]));
  return lines.filter((line) => line.rev <= (state.rev ?? 0) && lastTxn.get(line.rev) === line.txn);
}
