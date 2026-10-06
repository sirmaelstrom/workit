// Run state for the goal conductor: where a run lives, how state.json is read
// and written, the events.jsonl line, and the step/seam vocabulary every
// action carries. Every clock and file operation arrives through deps.
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;
// A lock held from another host (whose pid cannot be checked) older than this
// is stale. Every verb is one-shot and bounded (ASSUMPTION).
export const LOCK_STALE_MS = 60000;
const LOCK_POLL_MS = 50;

export class ConductError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

// The touch seam: the analysis reports touches in their own section, so it is
// never a seam row nor a send-back seam name.
export const TOUCH_SEAM = 'operator-touch';

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
  ruling: 'adjudication', ratify: 'adjudication', adjudicate: 'adjudication', reply: 'adjudication',
  'thread-ids': 'adjudication', resolve: 'adjudication',
  rebase: 'merge-gate', 'gate-cmd': 'merge-gate', gate: 'merge-gate', merge: 'merge-gate', merged: 'merge-gate',
  release: 'release',
  analyze: 'run-analysis',
  preapproval: TOUCH_SEAM, grant: TOUCH_SEAM, showcase: TOUCH_SEAM, touch: TOUCH_SEAM,
  spend: null, notify: null, receipt: null, stop: null, alarm: null,
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

function readLock(path, deps) {
  try {
    return JSON.parse(deps.read(path));
  } catch {
    return null;
  }
}

// Stale only when the holder is shown gone: a dead pid on this host. Age
// decides only for a holder on another host, whose pid cannot be checked.
function lockIsStale(holder, deps) {
  if (holder.host === deps.hostname) return !deps.pidAlive(holder.pid);
  return deps.now() - Date.parse(holder.at) > LOCK_STALE_MS;
}

// One writer at a time: every state transaction (load, change, save) runs
// under a lock file beside state.json. The lock is a hard link to a complete
// temp file, so it never exists half-written, and `link` fails if a lock is
// already there. An unreadable lock is contention, never stale. Release
// removes the lock only while it still carries this writer's token. Two
// contenders that both judge one dead holder's lock stale can race on the
// takeover (accepted for v1: it needs a crash and two contenders; ASSUMPTION).
export async function withStateLock(runDir, deps, fn) {
  const path = join(runDir, 'state.lock');
  const token = randomBytes(8).toString('hex');
  const temp = `${path}.${token}.tmp`;
  const waitMs = deps.lockWaitMs ?? 2000;
  try {
    deps.write(temp, JSON.stringify({ pid: deps.pid, host: deps.hostname, at: deps.timestamp(), token }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ConductError(2, `no run directory at ${runDir}`);
    throw error;
  }
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        deps.link(temp, path);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = readLock(path, deps);
        if (holder && lockIsStale(holder, deps)) {
          deps.remove(path);
          continue;
        }
        if (attempt * LOCK_POLL_MS >= waitMs) {
          throw new ConductError(2, holder
            ? `the run is locked by pid ${holder.pid} on ${holder.host} since ${holder.at}; retry`
            : `the run's lock ${path} is unreadable; retry, or remove it if no conductor verb is running`);
        }
        await deps.sleep(LOCK_POLL_MS);
      }
    }
  } finally {
    deps.remove(temp);
  }
  try {
    return await fn();
  } finally {
    if (readLock(path, deps)?.token === token) deps.remove(path);
  }
}

// Events are staged on the state object and written by saveState, each line
// stamped with the transaction's `rev` and a random `txn`. The lines are
// appended before state.json is replaced; the txn is committed only when the
// state carrying it in `txns` lands. readEvents keeps committed lines only.
const staged = new WeakMap();

// A trailing line without its newline is a crash mid-append. That save never
// committed, so the fragment is cut off before anything is appended after it.
function repairTail(path, deps) {
  if (!deps.exists(path)) return;
  const text = deps.read(path);
  if (text === '' || text.endsWith('\n')) return;
  deps.truncate(path, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
}

export function saveState(state, deps) {
  const path = statePath(state.runDir);
  const events = join(state.runDir, 'events.jsonl');
  const lines = staged.get(state) ?? [];
  staged.delete(state);
  state.rev = (state.rev ?? 0) + 1;
  const txn = randomBytes(6).toString('hex');
  state.txns = [...(state.txns ?? []), txn];
  if (lines.length) {
    repairTail(events, deps);
    deps.append(events, lines.map((line) => `${JSON.stringify({ ...line, rev: state.rev, txn })}\n`).join(''));
  }
  // Temp file then rename, so a crash mid-write never leaves half a state.json
  // (ASSUMPTION: rename within one directory replaces the file whole).
  const temp = `${path}.${deps.pid}.${txn}.tmp`;
  try {
    deps.write(temp, `${JSON.stringify(state, null, 2)}\n`);
    deps.rename(temp, path);
  } catch (error) {
    deps.remove(temp);
    throw error;
  }
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

// The recovery rule: an event is visible only when its txn was committed,
// i.e. is in the saved state's `txns`. A torn trailing line is dropped as a
// crash artifact; a bad line anywhere else is corruption and exits 2.
export function readEvents(runDir, deps, state = loadState(runDir, deps)) {
  const path = join(runDir, 'events.jsonl');
  if (!deps.exists(path)) return [];
  const rows = deps.read(path).split('\n');
  rows.pop(); // '' after the final newline, or a torn trailing line
  const committed = new Set(state.txns ?? []);
  return rows.map((row, i) => {
    try {
      return JSON.parse(row);
    } catch {
      throw new ConductError(2, `events.jsonl line ${i + 1} is not valid JSON`);
    }
  }).filter((line) => committed.has(line.txn));
}
