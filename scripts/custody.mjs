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
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findLinks, removeWorktree } from '../skills/parallel-explore/scripts/worktree-teardown.mjs';

//   0 ok, every selected entry disposed (or nothing to do) · 1 infrastructure,
//   or a link whose target came back empty · 2 usage, refused before any write
//   · 3 close kept at least one entry · 4 another writer holds the ledger
//   (retry; nothing was read or written)
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, KEPT: 3, BUSY: 4 });

// Close order: processes and droppers first, while the checkouts and links
// they run from still stand; then links, before the trees they sit in;
// worktrees last.
export const KINDS = Object.freeze(['process', 'db', 'dir', 'junction', 'worktree']);
const BUILT_IN = new Set(['junction', 'worktree']);
const LIVE_MS = 60_000;
const DISPOSE_MS = 600_000;

export const USAGE_TEXT = `custody <verb> --ledger <abs> [options] — one ledger operation per invocation, JSON on stdout.

  add   --kind <${KINDS.join('|')}> --id <name|abs path|pid> [--repo <abs>]
        [--dispose <json argv>] [--live <json argv>] [--cwd <abs>] [--by <tag>]
        [--ignored disposable]
        Records a resource the run just created. junction: --id is the link's
        absolute path. worktree: --id is its absolute path and --repo the repo
        it belongs to; --ignored disposable says the run's own install and build
        output are the only ignored files in it (otherwise ignored files keep
        it). Any other kind needs --dispose, the argv that removes it:
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
        changes or ignored files not declared disposable, when its HEAD is on
        no ref unless every file it changed is identical on the default
        branch, as last fetched (custody never fetches), in a repo with no
        grafts and no shallow history, or when an entry not
        yet disposed runs from inside it; otherwise removed with workit's
        junction-safe teardown.
        Others: --dispose after the --live check; exit 0 is disposed, anything
        else is kept with its exit and first stderr line.
        Exit 3 when anything was kept; exit 1 when a link's target came back
        empty, whatever else was kept.
  unlock
        Removes <ledger>.lock when the pid it names is not running.

  add and close hold <ledger>.lock: one writer at a time. A held lock is
  refused with exit 4 (retry: an add made while a close runs is refused, not
  queued) and never taken over; a lock left by a dead process is removed with
  unlock.`;

class CustodyError extends Error {
  constructor(code, message, { showUsage = false } = {}) {
    super(message);
    this.code = code;
    this.showUsage = showUsage;
  }
}

const usage = (message) => {
  throw new CustodyError(EXIT.USAGE, message, { showUsage: true });
};

const VALUE_FLAGS = new Set(['ledger', 'kind', 'id', 'repo', 'dispose', 'live', 'cwd', 'by', 'ignored']);
const BOOLEAN_FLAGS = new Set(['dry-run']);

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (!['add', 'list', 'close', 'unlock'].includes(verb)) usage(`unknown verb: ${verb ?? '(none)'}`);
  const opts = { verb };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const name = token.startsWith('--') ? token.slice(2) : null;
    if (name && BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (!name || !VALUE_FLAGS.has(name)) usage(`unexpected argument: ${token}`);
    // An empty value would read as absent: --by "" would close every item, --live "" would skip the check.
    if (rest[i + 1] === undefined || !rest[i + 1].trim()) usage(`--${name} needs a non-empty value`);
    opts[name] = rest[i + 1];
    i += 1;
  }
  if (!opts.ledger || !isAbsolute(opts.ledger)) usage('--ledger <absolute path> is required');
  if (opts['dry-run'] && verb !== 'close') usage('--dry-run belongs to close');
  const allowed = { add: null, list: ['verb', 'ledger'], close: ['verb', 'ledger', 'by', 'dry-run'], unlock: ['verb', 'ledger'] }[verb];
  if (allowed && Object.keys(opts).some((key) => !allowed.includes(key))) usage(`${verb} takes only ${allowed.slice(2).map((key) => `--${key}`).join(' and ') || '--ledger'}`);
  if (opts.ignored !== undefined && opts.ignored !== 'disposable') usage('--ignored takes only "disposable"');
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
// One spelling per directory: an 8.3 short name (C:\Users\RUNNER~1, which a
// Windows tmpdir can return) and the long name git prints are the same path.
// A path that does not exist keeps its resolved spelling.
const canonical = (deps, path) => {
  try {
    return deps.realpath(path);
  } catch {
    return resolve(path);
  }
};
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

const FIELDS = ['repo', 'dispose', 'live', 'cwd', 'by', 'ignored'];

function add(opts, deps) {
  if (opts.ignored && opts.kind !== 'worktree') usage('--ignored belongs to a worktree');
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
  if (opts.ignored) entry.ignored = opts.ignored;
  deps.mkdir(dirname(opts.ledger));
  return withLock(deps, opts.ledger, () => {
    const { lines } = readLedger(deps, opts.ledger);
    const known = entries(lines, deps.platform).find((row) => keyOf(row, deps.platform) === keyOf(entry, deps.platform));
    if (known && known.state !== 'disposed') {
      const differs = FIELDS.filter((field) => JSON.stringify(known[field] ?? null) !== JSON.stringify(entry[field] ?? null));
      if (differs.length) throw new CustodyError(EXIT.USAGE, `${keyOf(entry, deps.platform)} is already recorded (${known.state}) with a different ${differs.join(', ')}; close it first, or add it as it was`);
      return { exit: EXIT.OK, output: { ok: true, added: false, entry: known, note: 'already in the ledger' } };
    }
    entry.at = new Date(deps.now()).toISOString();
    appendLine(deps, opts.ledger, entry);
    return { exit: EXIT.OK, output: { ok: true, added: true, generation: known ? 'new' : 'first', entry } };
  });
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
  // Absence first: a worktree gone from disk is disposed whatever its repo's
  // state. A registration it left is reported, never pruned here (prune is
  // repo-wide).
  if (linkState(deps, entry.id) === null) return { op: 'disposed', reason: 'already gone' };
  const listed = deps.git(['-C', entry.repo, 'worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return { op: 'kept', reason: `git worktree list failed: ${firstLine(listed.stderr) || listed.error}` };
  const block = listed.stdout.split(/\r?\n\r?\n/).find((chunk) => {
    const path = /^worktree (.+)$/m.exec(chunk)?.[1];
    return path && samePath(canonical(deps, path), canonical(deps, entry.id), deps.platform);
  });
  if (!block) return { op: 'kept', reason: `${entry.id} is not a worktree of ${entry.repo}` };
  if (/^locked\b/m.test(block)) return { op: 'kept', reason: 'the worktree is locked' };
  const holder = held.find((other) => other.cwd && inside(canonical(deps, other.cwd), canonical(deps, entry.id), deps.platform));
  if (holder) return { op: 'kept', reason: `${holder.kind} ${holder.id} is not disposed and runs from inside it (--cwd ${holder.cwd})` };
  const links = deps.findLinks(entry.id);
  if (links.length) return { op: 'kept', reason: `it still holds a link (${links[0]}); record links as junctions so close unlinks them first` };
  const status = deps.git(['-C', entry.id, 'status', '--porcelain', '--untracked-files=normal', '--ignored=traditional']);
  if (status.code !== 0) return { op: 'kept', reason: `git status failed: ${firstLine(status.stderr) || status.error}` };
  const lines = status.stdout.split(/\r?\n/).filter((line) => line.trim());
  const changed = lines.filter((line) => !line.startsWith('!! '));
  if (changed.length) return { op: 'kept', reason: `uncommitted changes: ${changed[0]}` };
  const ignored = lines.filter((line) => line.startsWith('!! '));
  if (ignored.length && entry.ignored !== 'disposable') return { op: 'kept', reason: `ignored files the run did not declare disposable (add --ignored disposable): ${ignored[0].slice(3)}` };
  const head = proofGit(deps, entry.id, ['rev-parse', 'HEAD']);
  const sha = head.code === 0 ? head.stdout.trim() : null;
  if (!sha) return { op: 'kept', reason: `git rev-parse HEAD failed: ${firstLine(head.stderr) || head.error}` };
  const refs = proofGit(deps, entry.repo, ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)']);
  if (refs.code !== 0) return { op: 'kept', reason: `git for-each-ref failed: ${firstLine(refs.stderr) || refs.error}` };
  let reason = 'removed';
  if (!refs.stdout.trim()) {
    const orphan = `its HEAD ${sha.slice(0, 12)} is on no ref`;
    const kept = (checked) => ({ op: 'kept', reason: `${orphan}; removing it would orphan the commit (${checked})` });
    const rewritten = historyRewritten(entry.repo, deps);
    if (rewritten) return kept(rewritten);
    const branch = defaultBranch(entry.repo, deps);
    if (branch.unreadable) return kept(`default branch unreadable: ${branch.unreadable}`);
    if (branch.ambiguous) return kept(`default branch ambiguous: ${branch.ambiguous.join(', ')}`);
    if (!branch.candidate) return kept('no default-branch ref to check against');
    if (!identicalOn(entry.repo, sha, branch.candidate, deps)) return kept(`checked ${branch.candidate.name}`);
    reason = `removed: ${orphan}; every file it changed is identical in ${branch.candidate.name} (as last fetched; custody never fetches)`;
  }
  const out = deps.removeWorktree(entry.repo, entry.id);
  return out.removed ? { op: 'disposed', reason } : { op: 'kept', reason: out.reason };
}

// A HEAD on no ref can still carry nothing the default branch lacks: its
// branch was squash-merged, then deleted. The one proof accepted is exact
// containment: the default branch, as last fetched, holds HEAD's mode and
// object id for every file HEAD changed. Object ids are compared, never
// content, so whitespace, attributes, merge drivers and filters play no part.
// Custody never fetches: a remote-tracking ref behind the remote reads as
// "not in it".
const FALLBACK_LEVELS = [['refs/remotes/origin/main', 'refs/remotes/origin/master'], ['refs/heads/main', 'refs/heads/master']];
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const nonEmpty = (text) => String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
const shortName = (ref) => ref.replace(/^refs\/(?:remotes|heads)\//, '');
const failure = (out) => firstLine(out.stderr) || out.error || `git exited ${out.code}`;
// Lossless: Node decodes every ill-formed UTF-8 sequence to U+FFFD, so output
// without one round-trips to the bytes git printed. A path with one (a raw
// "bad\xff") would be looked up as other bytes, and read as absent.
const lossy = (text) => String(text ?? '').includes('\u{FFFD}');

// Every git call the merged-head proof makes reads history as written:
// --no-replace-objects ignores refs/replace/*, which can swap a commit or a
// tree so the merge base already holds HEAD's files.
const proofGit = (deps, repo, args) => deps.git(['-C', repo, '--no-replace-objects', ...args]);

// Grafts rewrite parents whatever --no-replace-objects says, and a shallow
// clone's history is cut: either is a reason to keep, returned as text. null
// when neither applies; a check that cannot be read keeps too.
function historyRewritten(repo, deps) {
  const shallow = proofGit(deps, repo, ['rev-parse', '--is-shallow-repository']);
  const answer = shallow.code === 0 ? shallow.stdout.trim() : '';
  if (answer === 'true') return 'a shallow clone: its history is cut';
  if (answer !== 'false') return `history unreadable: ${failure(shallow)}`;
  const path = proofGit(deps, repo, ['rev-parse', '--git-path', 'info/grafts']);
  const file = path.code === 0 ? path.stdout.replace(/\r?\n$/, '') : '';
  if (!file) return `history unreadable: ${failure(path)}`;
  try {
    if (deps.read(resolve(repo, file))) return `a grafts file rewrites its history: ${file}`;
  } catch (error) {
    if (error.code !== 'ENOENT') return `history unreadable: ${error.message}`;
  }
  return null;
}

// The default branch: { candidate: { name, id } }, { ambiguous: [names] },
// { unreadable: why }, or {} when none exists. origin/HEAD's target when it
// resolves, since another remote-tracking ref can be pruned upstream.
// Otherwise origin/main or origin/master when exactly one exists; with
// neither, main or master when exactly one exists. Both names at one level is
// ambiguous, and keeps. A ref is absent only when git says so (exit 1, nothing
// printed): a timeout, a launch failure or any other exit is unreadable, and
// keeps, since reading it as absent would fall through to another branch.
function defaultBranch(repo, deps) {
  const absent = (out) => out.code === 1 && !out.error && !String(out.stdout ?? '').trim();
  const unreadable = (out) => Object.assign(new Error(failure(out)), { unreadable: failure(out) });
  const resolved = (ref) => {
    const out = proofGit(deps, repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const id = out.code === 0 ? out.stdout.trim() : '';
    if (OBJECT_ID.test(id)) return [{ name: shortName(ref), id }];
    if (absent(out)) return [];
    throw unreadable(out);
  };
  try {
    const origin = proofGit(deps, repo, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
    const target = origin.code === 0 ? origin.stdout.trim() : '';
    if (!target && !absent(origin)) throw unreadable(origin);
    const [head] = target ? resolved(target) : [];
    if (head) return { candidate: head };
    for (const level of FALLBACK_LEVELS) {
      const found = level.flatMap(resolved);
      if (found.length === 1) return { candidate: found[0] };
      if (found.length > 1) return { ambiguous: found.map((ref) => ref.name) };
    }
    return {};
  } catch (error) {
    if (error.unreadable) return { unreadable: error.unreadable };
    throw error;
  }
}

// Every diff the guard reads runs with these: diff.relative from a --repo
// below the top level would drop the changes outside it, and
// diff.ignoreSubmodules would hide a submodule bump.
const DIFF_FLAGS = ['--no-relative', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv'];
const PATH_BATCH = 200;

// `git diff --quiet`: true for a change (exit 1), false for none (exit 0),
// null for anything else.
function changes(deps, repo, from, to) {
  const out = proofGit(deps, repo, ['diff', '--quiet', ...DIFF_FLAGS, from, to]);
  return out.code === 1 ? true : out.code === 0 ? false : null;
}

// Each path's { mode, type, id } in <tree>, by its full path: a Map, or null
// when a call fails or prints a record that does not parse. A path absent
// from the tree has no key. --full-tree reads paths from the top level,
// whatever directory --repo names.
function entriesIn(deps, repo, tree, paths) {
  const found = new Map();
  for (let i = 0; i < paths.length; i += PATH_BATCH) {
    const out = proofGit(deps, repo, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', ...paths.slice(i, i + PATH_BATCH)]);
    if (out.code !== 0 || lossy(out.stdout)) return null;
    for (const record of out.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (!match || !OBJECT_ID.test(match[3])) return null;
      found.set(match[4], { mode: match[1], type: match[2], id: match[3] });
    }
  }
  return found;
}

// True when the candidate holds exactly <sha>'s version of every file <sha>
// changed since its merge base: the same mode and object id for each added
// or modified path, and no entry for each deleted one. Any other status, a
// failed call or a malformed output is not shown, whatever stdout holds.
function identicalOn(repo, sha, candidate, deps) {
  const git = (...args) => proofGit(deps, repo, args);
  // Prerequisites: one merge base, and a non-empty change made of non-empty,
  // non-merge commits. An --allow-empty orphan carries only its message, which
  // no comparison of files would preserve.
  const bases = git('merge-base', '--all', candidate.id, sha);
  const base = bases.code === 0 ? nonEmpty(bases.stdout) : [];
  if (base.length !== 1 || !OBJECT_ID.test(base[0].trim())) return false;
  const from = base[0].trim();
  const range = git('rev-list', '--parents', `${from}..${sha}`);
  if (range.code !== 0) return false;
  const commits = nonEmpty(range.stdout).map((line) => line.trim().split(/\s+/));
  if (!commits.length || commits.some((ids) => ids.length !== 2 || changes(deps, repo, ids[1], ids[0]) !== true)) return false;
  if (changes(deps, repo, from, sha) !== true) return false;
  // -z: status NUL path NUL per path; --no-renames keeps R and C out.
  const status = git('diff', '--name-status', '-z', '--no-renames', ...DIFF_FLAGS, from, sha);
  if (status.code !== 0 || lossy(status.stdout)) return false;
  const fields = status.stdout.split('\0');
  if (fields.pop() !== '' || !fields.length || fields.length % 2) return false;
  const changed = [];
  for (let i = 0; i < fields.length; i += 2) changed.push({ status: fields[i], path: fields[i + 1] });
  if (changed.some((file) => !['A', 'M', 'D'].includes(file.status) || !file.path)) return false;
  const paths = changed.map((file) => file.path);
  const mine = entriesIn(deps, repo, sha, paths);
  const theirs = entriesIn(deps, repo, candidate.id, paths);
  if (!mine || !theirs) return false;
  return changed.every(({ status: kind, path }) => {
    const at = mine.get(path);
    const on = theirs.get(path);
    if (kind === 'D') return !at && !on;
    return Boolean(at && on) && at.mode === on.mode && at.id === on.id;
  });
}

function closeByCommand(entry, deps) {
  const out = deps.run(entry.dispose, { cwd: entry.cwd, timeout: DISPOSE_MS });
  if (out.error) return { op: 'kept', reason: `dispose did not run to an exit: ${out.error}` };
  return out.code === 0 ? { op: 'disposed', reason: 'dispose exited 0' } : { op: 'kept', reason: `dispose exited ${out.code}: ${firstLine(out.stderr) || firstLine(out.stdout)}` };
}

// One writer at a time per ledger. The lock names its holder (pid and a
// per-call token) and is released only while it still carries that token. A
// held lock is refused, never taken over: a close can outlast any fixed
// staleness, so only `unlock` removes one, and only when its pid is dead.
function withLock(deps, ledger, fn) {
  const lock = `${ledger}.lock`;
  const token = `${deps.pid} ${deps.token()}`;
  try {
    deps.writeNew(lock, `${token}\n`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holder = '?';
    try {
      holder = deps.read(lock).trim().split(' ')[0];
    } catch {
      // Released between the two calls; the refusal stands, and a retry will take it.
    }
    throw new CustodyError(EXIT.BUSY, `pid ${holder} holds ${lock}; run again when it is done, or unlock if that pid is not running`);
  }
  try {
    return fn();
  } finally {
    try {
      if (deps.read(lock).trim() === token) deps.remove(lock);
    } catch {
      // Already gone.
    }
  }
}

function unlock(opts, deps) {
  const lock = `${opts.ledger}.lock`;
  let text;
  try {
    text = deps.read(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return { exit: EXIT.OK, output: { ok: true, removed: false, note: 'no lock' } };
    throw error;
  }
  const pid = Number(text.trim().split(' ')[0]);
  if (Number.isInteger(pid) && pid > 0 && deps.pidAlive(pid)) throw new CustodyError(EXIT.BUSY, `pid ${pid} is running and holds ${lock}; nothing removed`);
  deps.remove(lock);
  return { exit: EXIT.OK, output: { ok: true, removed: true, holder: text.trim() } };
}

function close(opts, deps) {
  // A ledger never written has nothing to close, and no directory to lock in.
  if (!deps.exists(opts.ledger)) return { exit: EXIT.OK, output: { ok: true, closed: 0, disposed: 0, kept: 0, results: [], note: 'no ledger' } };
  const select = () => {
    const { lines, skipped } = readLedger(deps, opts.ledger);
    const all = entries(lines, deps.platform).filter((entry) => entry.state !== 'disposed');
    const open = all.filter((entry) => !opts.by || entry.by === opts.by).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    return { all, open, extra: skipped.length ? { skippedLines: skipped } : {} };
  };
  if (opts['dry-run']) {
    const { open, extra } = select();
    return { exit: EXIT.OK, output: { ok: true, dryRun: true, wouldClose: open.map(({ kind, id }) => ({ kind, id })), ...extra } };
  }
  return withLock(deps, opts.ledger, () => {
    // Read under the lock: a selection made before it could be another close's leftovers.
    const { all, open, extra } = select();
    const results = [];
    // Every entry outside this close that is not disposed (another item's,
    // open or kept) holds what it runs from; a selected one joins when kept.
    const held = all.filter((entry) => !open.includes(entry));
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
    exists: existsSync,
    token: () => randomBytes(8).toString('hex'),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM';
      }
    },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    lstat: (path) => lstatSync(path),
    realpath: (path) => realpathSync.native(path),
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
    if (opts.verb === 'unlock') return unlock(opts, deps);
    if (opts.verb === 'list') {
      const { lines, skipped } = readLedger(deps, opts.ledger);
      return { exit: EXIT.OK, output: { ok: true, entries: entries(lines, deps.platform), ...(skipped.length ? { skippedLines: skipped } : {}) } };
    }
    return close(opts, deps);
  } catch (error) {
    const code = error instanceof CustodyError ? error.code : EXIT.ERROR;
    return { exit: code, output: { ok: false, error: error.message, ...(error.showUsage ? { usage: USAGE_TEXT } : {}) } };
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
