#!/usr/bin/env node
/**
 * Run-owned resource custody (quest a0b2f31a). A run records each resource it
 * creates (a test database, a worktree, a junction, a process) in its own
 * ledger at the moment it creates it, and `close` disposes of them at run
 * close. A resource whose owner is live, or whose ownership cannot be read,
 * is kept and reported, never forced. One JSON document on stdout per
 * invocation.
 *
 * The ledger is append-only JSONL: `add` lines, then one `disposed` or `kept`
 * line per close attempt. A kept entry is tried again at the next close; a
 * disposed one is not, until it is added again (a new generation).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findLinks, removeWorktree } from '../skills/parallel-explore/scripts/worktree-teardown.mjs';

//   0 ok, every selected entry disposed (or nothing to do) · 1 infrastructure,
//   or a link whose target came back empty · 2 usage, refused before any write
//   · 3 close kept at least one entry
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, KEPT: 3 });

// Close order: links before the trees they sit in, processes before the
// worktrees they hold open, worktrees last.
export const KINDS = Object.freeze(['junction', 'process', 'db', 'dir', 'worktree']);
const BUILT_IN = new Set(['junction', 'worktree']);
const LIVE_MS = 60_000;
const DISPOSE_MS = 600_000;
const LOCK_STALE_MS = 30 * 60_000;

export const USAGE_TEXT = `custody <verb> --ledger <abs> [options] — one ledger operation per invocation, JSON on stdout.

  add   --kind <${KINDS.join('|')}> --id <name|abs path|pid> [--repo <abs>]
        [--dispose <json argv>] [--live <json argv>] [--cwd <abs>] [--by <tag>]
        Records a resource the run just created. junction: --id is the link's
        absolute path. worktree: --id is its absolute path and --repo the repo
        it belongs to. Any other kind needs --dispose, the argv that removes it:
        the repo's own dropper, which must refuse an occupied resource with a
        non-zero exit. Argvs run without a shell, so name an executable (node,
        git), never an npm script: on Windows "npm" does not launch.
        --live checks ownership before any disposal: exit 0 means owned (kept),
        exit 1 means free; any other exit, a timeout or a launch failure keeps
        the entry. A process's --live check is its identity check (a pid can be
        reused). --by tags the entry so close --by can dispose of one item's
        resources. Adding an open entry again is a no-op, and refused if its
        fields differ; adding a disposed one opens a new generation.
  list  Prints every entry with its latest state (open, disposed, kept).
  close [--by <tag>] [--dry-run]
        Disposes of every entry not yet disposed (only those tagged <tag> with
        --by), in the order ${KINDS.join(' → ')}.
        junction: unlinked without entering it; a path that is not a link is kept.
        worktree: kept when locked, when it holds a link, when it has uncommitted
        changes, when its HEAD is on no ref, or when a kept entry still runs
        from inside it; otherwise removed with workit's junction-safe teardown.
        Others: --dispose after the --live check; exit 0 is disposed, anything
        else is kept with its exit and first stderr line.
        Exit 3 when anything was kept. One close at a time per ledger.`;

class CustodyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const usage = (message) => {
  throw new CustodyError(EXIT.USAGE, message);
};

const VALUE_FLAGS = new Set(['ledger', 'kind', 'id', 'repo', 'dispose', 'live', 'cwd', 'by']);
const BOOLEAN_FLAGS = new Set(['dry-run']);

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (!['add', 'list', 'close'].includes(verb)) usage(`unknown verb: ${verb ?? '(none)'}`);
  const opts = { verb };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const name = token.startsWith('--') ? token.slice(2) : null;
    if (name && BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (!name || !VALUE_FLAGS.has(name)) usage(`unexpected argument: ${token}`);
    if (rest[i + 1] === undefined) usage(`--${name} needs a value`);
    opts[name] = rest[i + 1];
    i += 1;
  }
  if (!opts.ledger || !isAbsolute(opts.ledger)) usage('--ledger <absolute path> is required');
  if (opts['dry-run'] && verb !== 'close') usage('--dry-run belongs to close');
  if (verb === 'close' && Object.keys(opts).some((key) => !['verb', 'ledger', 'by', 'dry-run'].includes(key))) usage('close takes only --by and --dry-run');
  return opts;
}

function argvOf(text, flag) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    usage(`--${flag} must be a JSON array of strings`);
  }
  if (!Array.isArray(value) || !value.length || value.some((part) => typeof part !== 'string' || !part)) usage(`--${flag} must be a non-empty JSON array of strings`);
  return value;
}

// Paths compare case-insensitively where the filesystem does.
const samePath = (a, b, platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const pathKey = (path, platform) => (platform === 'win32' ? path.toLowerCase() : path);
const inside = (child, parent, platform) => {
  const rel = relative(pathKey(parent, platform), pathKey(child, platform));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const keyOf = (entry, platform = process.platform) => `${entry.kind}:${BUILT_IN.has(entry.kind) ? pathKey(entry.id, platform) : entry.id}`;

// Every line that parses. A line that does not (a torn append: a writer died
// mid-line) is skipped and its file line number reported. Skipping fails safe:
// a lost close record means the entry is tried again; a lost add means a
// resource is left, never one removed.
export function readLedger(deps, path) {
  let text;
  try {
    text = deps.read(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], skipped: [] };
    throw new CustodyError(EXIT.ERROR, `could not read ${path}: ${error.message}`);
  }
  const lines = [];
  const skipped = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      lines.push(JSON.parse(line));
    } catch {
      skipped.push(i + 1);
    }
  });
  return { lines, skipped };
}

// Each entry's latest generation with its latest close outcome.
export function entries(lines, platform = process.platform) {
  const byKey = new Map();
  for (const line of lines) {
    const key = line.op === 'add' ? keyOf(line, platform) : line.key;
    const known = byKey.get(key);
    if (line.op === 'add') {
      if (!known || known.state === 'disposed') byKey.set(key, { ...line, state: 'open', reason: null });
    } else if (known) {
      Object.assign(known, { state: line.op, reason: line.reason ?? null, at: line.at });
    }
  }
  return [...byKey.values()];
}

// A torn tail gets a newline before the next line, so it stays one bad line.
function appendLine(deps, path, value) {
  let prefix = '';
  try {
    const text = deps.read(path);
    if (text && !text.endsWith('\n')) prefix = '\n';
  } catch {
    // A new ledger.
  }
  deps.append(path, `${prefix}${JSON.stringify(value)}\n`);
}

const FIELDS = ['repo', 'dispose', 'live', 'cwd', 'by'];

function add(opts, deps) {
  if (!KINDS.includes(opts.kind)) usage(`--kind must be one of ${KINDS.join(', ')}`);
  if (!opts.id) usage('--id is required');
  const entry = { op: 'add', kind: opts.kind, id: opts.id };
  if (BUILT_IN.has(opts.kind)) {
    if (!isAbsolute(opts.id)) usage(`a ${opts.kind}'s --id is its absolute path`);
    entry.id = resolve(opts.id);
    if (opts.dispose) usage(`a ${opts.kind} is removed by custody itself; --dispose is not taken`);
  } else {
    if (!opts.dispose) usage(`a ${opts.kind} needs --dispose <json argv>: custody has no built-in way to remove it`);
    entry.dispose = argvOf(opts.dispose, 'dispose');
  }
  if (opts.kind === 'worktree') {
    if (!opts.repo || !isAbsolute(opts.repo)) usage('a worktree needs --repo <absolute path>');
    entry.repo = resolve(opts.repo);
  } else if (opts.repo) {
    usage('--repo belongs to a worktree');
  }
  if (opts.live) entry.live = argvOf(opts.live, 'live');
  if (opts.cwd) {
    if (!isAbsolute(opts.cwd)) usage('--cwd must be absolute');
    entry.cwd = resolve(opts.cwd);
  }
  if (opts.by) entry.by = opts.by;
  const { lines } = readLedger(deps, opts.ledger);
  const known = entries(lines, deps.platform).find((row) => keyOf(row, deps.platform) === keyOf(entry, deps.platform));
  if (known && known.state !== 'disposed') {
    const differs = FIELDS.filter((field) => JSON.stringify(known[field] ?? null) !== JSON.stringify(entry[field] ?? null));
    if (differs.length) usage(`${keyOf(entry, deps.platform)} is already recorded (${known.state}) with a different ${differs.join(', ')}; close it first, or add it as it was`);
    return { exit: EXIT.OK, output: { ok: true, added: false, entry: known, note: 'already in the ledger' } };
  }
  entry.at = new Date(deps.now()).toISOString();
  deps.mkdir(dirname(opts.ledger));
  appendLine(deps, opts.ledger, entry);
  return { exit: EXIT.OK, output: { ok: true, added: true, generation: known ? 'new' : 'first', entry } };
}

const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0] ?? '';

// Launches without a shell. { code, error } where error is set on a launch
// failure, a timeout or a signal: anything that is not an exit status.
export function runArgv(argv, { cwd, timeout }) {
  const out = spawnSync(argv[0], argv.slice(1), { cwd, timeout, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  if (out.error) return { code: null, error: out.error.code === 'ETIMEDOUT' ? `timed out after ${timeout} ms` : `could not launch ${argv[0]}: ${out.error.code ?? out.error.message}`, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  if (out.status === null) return { code: null, error: `ended by signal ${out.signal}`, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  return { code: out.status, error: null, stdout: out.stdout, stderr: out.stderr };
}

// The --live check: owned (exit 0), free (exit 1), or unknown, which keeps.
function ownership(entry, deps) {
  if (!entry.live) return null;
  const out = deps.run(entry.live, { cwd: entry.cwd, timeout: LIVE_MS });
  if (out.error) return { op: 'kept', reason: `the --live check did not run to an exit: ${out.error}` };
  if (out.code === 0) return { op: 'kept', reason: 'its owner is live (the --live check exited 0)' };
  if (out.code !== 1) return { op: 'kept', reason: `the --live check exited ${out.code}; only 1 means free` };
  return null;
}

// lstat that tells absence from an error: true, false, or null for absent.
function linkState(deps, path) {
  try {
    return deps.lstat(path).isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function closeJunction(entry, deps) {
  const link = linkState(deps, entry.id);
  if (link === null) return { op: 'disposed', reason: 'already gone' };
  if (!link) return { op: 'kept', reason: `${entry.id} is not a link; custody never deletes a real directory` };
  return deps.unlink(entry.id);
}

function closeWorktree(entry, deps, held) {
  const listed = deps.git(['-C', entry.repo, 'worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return { op: 'kept', reason: `git worktree list failed: ${firstLine(listed.stderr) || listed.error}` };
  const block = listed.stdout.split(/\r?\n\r?\n/).find((chunk) => {
    const path = /^worktree (.+)$/m.exec(chunk)?.[1];
    return path && samePath(resolve(path), entry.id, deps.platform);
  });
  const present = linkState(deps, entry.id) !== null;
  if (!present) {
    // Gone from disk: a registration left behind is git's to prune, which touches only missing worktrees.
    if (block) deps.git(['-C', entry.repo, 'worktree', 'prune']);
    return { op: 'disposed', reason: 'already gone' };
  }
  if (!block) return { op: 'kept', reason: `${entry.id} is not a worktree of ${entry.repo}` };
  if (/^locked\b/m.test(block)) return { op: 'kept', reason: 'the worktree is locked' };
  const holder = held.find((other) => other.cwd && inside(other.cwd, entry.id, deps.platform));
  if (holder) return { op: 'kept', reason: `kept ${holder.kind} ${holder.id} still runs from inside it (--cwd ${holder.cwd})` };
  const links = deps.findLinks(entry.id);
  if (links.length) return { op: 'kept', reason: `it still holds a link (${links[0]}); record links as junctions so close unlinks them first` };
  const status = deps.git(['-C', entry.id, 'status', '--porcelain', '--untracked-files=normal']);
  if (status.code !== 0) return { op: 'kept', reason: `git status failed: ${firstLine(status.stderr) || status.error}` };
  if (status.stdout.trim()) return { op: 'kept', reason: `uncommitted changes: ${firstLine(status.stdout)}` };
  const head = deps.git(['-C', entry.id, 'rev-parse', 'HEAD']);
  const sha = head.code === 0 ? head.stdout.trim() : null;
  if (!sha) return { op: 'kept', reason: `git rev-parse HEAD failed: ${firstLine(head.stderr) || head.error}` };
  const refs = deps.git(['-C', entry.repo, 'for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)']);
  if (refs.code !== 0) return { op: 'kept', reason: `git for-each-ref failed: ${firstLine(refs.stderr) || refs.error}` };
  if (!refs.stdout.trim()) return { op: 'kept', reason: `its HEAD ${sha.slice(0, 12)} is on no ref; removing it would orphan the commit` };
  const out = deps.removeWorktree(entry.repo, entry.id);
  return out.removed ? { op: 'disposed', reason: 'removed' } : { op: 'kept', reason: out.reason };
}

function closeByCommand(entry, deps) {
  const out = deps.run(entry.dispose, { cwd: entry.cwd, timeout: DISPOSE_MS });
  if (out.error) return { op: 'kept', reason: `dispose did not run to an exit: ${out.error}` };
  return out.code === 0 ? { op: 'disposed', reason: 'dispose exited 0' } : { op: 'kept', reason: `dispose exited ${out.code}: ${firstLine(out.stderr) || firstLine(out.stdout)}` };
}

// One close at a time per ledger: a second would dispose of the same entries.
function withLock(deps, ledger, fn) {
  const lock = `${ledger}.lock`;
  try {
    deps.writeNew(lock, `${deps.pid}\n`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = deps.now() - deps.mtime(lock);
    if (age < LOCK_STALE_MS) throw new CustodyError(EXIT.ERROR, `another close holds ${lock} (${Math.round(age / 1000)} s old); run close again when it is done`);
    deps.remove(lock);
    deps.writeNew(lock, `${deps.pid}\n`);
  }
  try {
    return fn();
  } finally {
    deps.remove(lock);
  }
}

function close(opts, deps) {
  const { lines, skipped } = readLedger(deps, opts.ledger);
  const open = entries(lines, deps.platform).filter((entry) => entry.state !== 'disposed' && (!opts.by || entry.by === opts.by));
  open.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const extra = skipped.length ? { skippedLines: skipped } : {};
  if (opts['dry-run']) return { exit: EXIT.OK, output: { ok: true, dryRun: true, wouldClose: open.map(({ kind, id }) => ({ kind, id })), ...extra } };
  return withLock(deps, opts.ledger, () => {
    const results = [];
    // Kept entries from other items count too: a worktree is never removed from under one.
    const held = entries(lines, deps.platform).filter((entry) => entry.state !== 'disposed' && !open.includes(entry));
    for (const entry of open) {
      let outcome;
      try {
        outcome = ownership(entry, deps)
          ?? (entry.kind === 'junction' ? closeJunction(entry, deps)
            : entry.kind === 'worktree' ? closeWorktree(entry, deps, held)
              : closeByCommand(entry, deps));
      } catch (error) {
        outcome = { op: 'kept', reason: `close failed: ${error.message}` };
      }
      appendLine(deps, opts.ledger, { op: outcome.op, key: keyOf(entry, deps.platform), reason: outcome.reason, ...(outcome.warning ? { warning: outcome.warning } : {}), at: new Date(deps.now()).toISOString() });
      if (outcome.op === 'kept') held.push(entry);
      results.push({ kind: entry.kind, id: entry.id, state: outcome.op, reason: outcome.reason, ...(outcome.warning ? { warning: outcome.warning } : {}) });
    }
    const kept = results.filter((row) => row.state === 'kept');
    const warned = results.filter((row) => row.warning);
    const exit = warned.length ? EXIT.ERROR : kept.length ? EXIT.KEPT : EXIT.OK;
    return { exit, output: { ok: exit === EXIT.OK, closed: results.length, disposed: results.length - kept.length, kept: kept.length, results, ...extra } };
  });
}

// Unlinks one link without entering it. A target that had entries and has
// none afterwards means something followed the link: the link is gone either
// way, so it is disposed, with the warning carried to the ledger and exit 1.
function unlinkOne(path) {
  let target = null;
  try {
    target = resolve(dirname(path), readlinkSync(path));
  } catch {
    // An unreadable target has nothing to compare.
  }
  const count = (dir) => {
    try {
      return readdirSync(dir).length;
    } catch {
      return 0;
    }
  };
  const had = target === null ? 0 : count(target);
  try {
    unlinkSync(path);
  } catch {
    try {
      rmdirSync(path);
    } catch (error) {
      return { op: 'kept', reason: `could not unlink: ${error.message}` };
    }
  }
  try {
    lstatSync(path);
    return { op: 'kept', reason: `${path} remains after unlinking` };
  } catch {
    // Gone, as asked.
  }
  if (had && !count(target)) return { op: 'disposed', reason: 'unlinked', warning: `the target ${target} is empty after unlinking` };
  return { op: 'disposed', reason: 'unlinked' };
}

export function runCustody(argv, overrides = {}) {
  const deps = {
    run: runArgv,
    git: (args) => runArgv(['git', ...args], { timeout: LIVE_MS }),
    read: (path) => readFileSync(path, 'utf8'),
    append: (path, value) => appendFileSync(path, value, 'utf8'),
    writeNew: (path, value) => writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' }),
    remove: (path) => {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    },
    mtime: (path) => statSync(path).mtimeMs,
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    lstat: (path) => lstatSync(path),
    unlink: unlinkOne,
    findLinks,
    removeWorktree,
    platform: process.platform,
    pid: process.pid,
    now: () => Date.now(),
    ...overrides,
  };
  try {
    const opts = parseArgs(argv);
    if (opts.verb === 'add') return add(opts, deps);
    if (opts.verb === 'list') {
      const { lines, skipped } = readLedger(deps, opts.ledger);
      return { exit: EXIT.OK, output: { ok: true, entries: entries(lines, deps.platform), ...(skipped.length ? { skippedLines: skipped } : {}) } };
    }
    return close(opts, deps);
  } catch (error) {
    const code = error instanceof CustodyError ? error.code : EXIT.ERROR;
    return { exit: code, output: { ok: false, error: error.message, ...(code === EXIT.USAGE ? { usage: USAGE_TEXT } : {}) } };
  }
}

function main() {
  const result = runCustody(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exit;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
