#!/usr/bin/env node
/**
 * Run-owned resource custody (quest a0b2f31a). A run records each resource it
 * creates (a test database, a worktree, a junction, a process) in its own
 * ledger at the moment it creates it, and `close` disposes of them at run
 * close. A resource whose owner is still live is kept and reported, never
 * forced. One JSON document on stdout per invocation.
 *
 * The ledger is append-only JSONL: `add` lines, then one `disposed` or `kept`
 * line per close attempt. A kept entry is tried again at the next close; a
 * disposed one never is.
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execute } from './lane.mjs';
import { findLinks, removeWorktree } from '../skills/parallel-explore/scripts/worktree-teardown.mjs';

//   0 ok, every entry disposed (or nothing to do) · 1 infrastructure
//   2 usage, refused before any write · 3 close kept at least one entry
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, KEPT: 3 });
export const CUSTODY_EXIT_CODES = Object.freeze({ ok: 0, error: 1, usage: 2, kept: 3 });

// Close order: links before the trees they sit in, processes before the
// worktrees they hold open, worktrees last.
export const KINDS = Object.freeze(['junction', 'process', 'db', 'dir', 'worktree']);
const BUILT_IN = new Set(['junction', 'worktree']);

export const USAGE_TEXT = `custody <verb> --ledger <abs> [options] — one ledger operation per invocation, JSON on stdout.

  add   --kind <${KINDS.join('|')}> --id <name|abs path|pid> [--repo <abs>]
        [--dispose <json argv>] [--live <json argv>] [--cwd <abs>] [--by <who>]
        Records a resource the run just created. junction: --id is the link's
        absolute path. worktree: --id is its absolute path and --repo the repo
        it belongs to. Any other kind needs --dispose, the argv that removes it
        (the repo's own dropper, which must refuse an occupied resource with a
        non-zero exit). --live is an argv whose exit 0 means "still owned":
        close keeps the entry without disposing. Adding the same kind and id
        again is a no-op.
  list  Prints every entry with its latest state (open, disposed, kept).
  close [--dry-run]
        Disposes of every entry not yet disposed, in the order ${KINDS.join(' → ')}.
        junction: unlinked without entering it; a path that is not a link is kept.
        worktree: kept when it has uncommitted changes, is locked, or still holds
        a link; otherwise removed with workit's junction-safe teardown.
        Others: --live first (exit 0 → kept), then --dispose (exit 0 → disposed,
        anything else → kept with its exit and first stderr line).
        Exit 3 when anything was kept.`;

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

export const keyOf = (entry) => `${entry.kind}:${entry.id}`;

export function readLedger(deps, path) {
  if (!deps.exists(path)) return [];
  return deps.read(path).split('\n').filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new CustodyError(EXIT.ERROR, `${path} line ${i + 1} is not JSON`);
    }
  });
}

// Each added entry with its latest close outcome.
export function entries(lines) {
  const byKey = new Map();
  for (const line of lines) {
    if (line.op === 'add') {
      if (!byKey.has(keyOf(line))) byKey.set(keyOf(line), { ...line, state: 'open', reason: null });
    } else if (byKey.has(line.key)) {
      Object.assign(byKey.get(line.key), { state: line.op, reason: line.reason ?? null, at: line.at });
    }
  }
  return [...byKey.values()];
}

function add(opts, deps) {
  if (!KINDS.includes(opts.kind)) usage(`--kind must be one of ${KINDS.join(', ')}`);
  if (!opts.id) usage('--id is required');
  const entry = { op: 'add', kind: opts.kind, id: opts.id };
  if (opts.kind === 'junction' || opts.kind === 'worktree') {
    if (!isAbsolute(opts.id)) usage(`a ${opts.kind}'s --id is its absolute path`);
    entry.id = resolve(opts.id);
  }
  if (opts.kind === 'worktree') {
    if (!opts.repo || !isAbsolute(opts.repo)) usage('a worktree needs --repo <absolute path>');
    entry.repo = resolve(opts.repo);
  }
  if (!BUILT_IN.has(opts.kind)) {
    if (!opts.dispose) usage(`a ${opts.kind} needs --dispose <json argv>: custody has no built-in way to remove it`);
    entry.dispose = argvOf(opts.dispose, 'dispose');
  } else if (opts.dispose) {
    usage(`a ${opts.kind} is removed by custody itself; --dispose is not taken`);
  }
  if (opts.live) entry.live = argvOf(opts.live, 'live');
  if (opts.cwd) {
    if (!isAbsolute(opts.cwd)) usage('--cwd must be absolute');
    entry.cwd = opts.cwd;
  }
  if (opts.by) entry.by = opts.by;
  const known = entries(readLedger(deps, opts.ledger)).find((row) => keyOf(row) === keyOf(entry));
  if (known) return { exit: EXIT.OK, output: { ok: true, added: false, entry: known, note: 'already in the ledger' } };
  entry.at = new Date(deps.now()).toISOString();
  deps.mkdir(dirname(opts.ledger));
  deps.append(opts.ledger, `${JSON.stringify(entry)}\n`);
  return { exit: EXIT.OK, output: { ok: true, added: true, entry } };
}

const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0] ?? '';

function isLink(deps, path) {
  try {
    return deps.lstat(path).isSymbolicLink();
  } catch {
    return null;
  }
}

function closeJunction(entry, deps) {
  const link = isLink(deps, entry.id);
  if (link === null) return { op: 'disposed', reason: 'already gone' };
  if (!link) return { op: 'kept', reason: `${entry.id} is not a link; custody never deletes a real directory` };
  return deps.unlink(entry.id);
}

function closeWorktree(entry, deps) {
  if (!deps.exists(entry.id)) return { op: 'disposed', reason: 'already gone' };
  const listed = deps.exec('git', ['-C', entry.repo, 'worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return { op: 'kept', reason: `git worktree list failed: ${firstLine(listed.stderr)}` };
  const block = listed.stdout.split(/\r?\n\r?\n/).find((chunk) => {
    const path = /^worktree (.+)$/m.exec(chunk)?.[1];
    return path && resolve(path).toLowerCase() === entry.id.toLowerCase();
  });
  if (!block) return { op: 'kept', reason: `${entry.id} is not a worktree of ${entry.repo}` };
  if (/^locked\b/m.test(block)) return { op: 'kept', reason: 'the worktree is locked' };
  const links = deps.findLinks(entry.id);
  if (links.length) return { op: 'kept', reason: `it still holds a link (${links[0]}); record links as junctions so close unlinks them first` };
  const status = deps.exec('git', ['-C', entry.id, 'status', '--porcelain', '--untracked-files=normal']);
  if (status.code !== 0) return { op: 'kept', reason: `git status failed: ${firstLine(status.stderr)}` };
  if (status.stdout.trim()) return { op: 'kept', reason: `uncommitted changes: ${firstLine(status.stdout)}` };
  const out = deps.removeWorktree(entry.repo, entry.id);
  return out.removed ? { op: 'disposed', reason: 'removed' } : { op: 'kept', reason: out.reason };
}

function closeByCommand(entry, deps) {
  if (entry.live) {
    const live = deps.exec(entry.live[0], entry.live.slice(1), { cwd: entry.cwd });
    if (live.code === 0) return { op: 'kept', reason: 'its owner is live (the --live check exited 0)' };
  }
  const out = deps.exec(entry.dispose[0], entry.dispose.slice(1), { cwd: entry.cwd });
  return out.code === 0 ? { op: 'disposed', reason: 'dispose exited 0' } : { op: 'kept', reason: `dispose exited ${out.code}: ${firstLine(out.stderr) || firstLine(out.stdout)}` };
}

function close(opts, deps) {
  const open = entries(readLedger(deps, opts.ledger)).filter((entry) => entry.state !== 'disposed');
  open.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  if (opts['dry-run']) return { exit: EXIT.OK, output: { ok: true, dryRun: true, wouldClose: open.map(({ kind, id }) => ({ kind, id })) } };
  const results = [];
  for (const entry of open) {
    let outcome;
    try {
      outcome = entry.kind === 'junction' ? closeJunction(entry, deps)
        : entry.kind === 'worktree' ? closeWorktree(entry, deps)
          : closeByCommand(entry, deps);
    } catch (error) {
      outcome = { op: 'kept', reason: `close failed: ${error.message}` };
    }
    deps.append(opts.ledger, `${JSON.stringify({ op: outcome.op, key: keyOf(entry), reason: outcome.reason, at: new Date(deps.now()).toISOString() })}\n`);
    results.push({ kind: entry.kind, id: entry.id, state: outcome.op, reason: outcome.reason });
  }
  const kept = results.filter((row) => row.state === 'kept');
  return { exit: kept.length ? EXIT.KEPT : EXIT.OK, output: { ok: kept.length === 0, closed: results.length, disposed: results.length - kept.length, kept: kept.length, results } };
}

// Unlinks one link without entering it. A target that had entries and has
// none afterwards means something followed the link.
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
  if (had && !count(target)) return { op: 'kept', reason: `the target ${target} is empty after unlinking` };
  return { op: 'disposed', reason: 'unlinked' };
}

export function runCustody(argv, overrides = {}) {
  const deps = {
    exec: execute,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
    append: (path, value) => appendFileSync(path, value, 'utf8'),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    lstat: (path) => lstatSync(path),
    unlink: unlinkOne,
    findLinks,
    removeWorktree,
    now: () => Date.now(),
    ...overrides,
  };
  try {
    const opts = parseArgs(argv);
    if (opts.verb === 'add') return add(opts, deps);
    if (opts.verb === 'list') return { exit: EXIT.OK, output: { ok: true, entries: entries(readLedger(deps, opts.ledger)) } };
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
