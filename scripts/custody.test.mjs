// Run custody on a real filesystem and a real git repo in a temp dir. The
// dispose and live commands are `node -e`, so a test database is modelled by
// a command that exits as the repo's dropper would (0 dropped, 3 occupied).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCustody, entries, readLedger, runArgv } from './custody.mjs';

const node = (code) => JSON.stringify([process.execPath, '-e', code]);
const exitWith = (n) => node(`process.exit(${n})`);
// A dispose that appends one line to <file> per run, then exits 0.
const counting = (file) => node(`require('fs').appendFileSync(${JSON.stringify(file)}, 'x\\n')`);
const runs = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0);

function sandbox(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-custody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'run', 'custody.jsonl');
  const run = (...argv) => runCustody([argv[0], '--ledger', ledger, ...argv.slice(1)], overrides);
  return { dir, ledger, run };
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });

function repoWithWorktree(dir, name) {
  const repo = join(dir, 'repo');
  if (!existsSync(repo)) {
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'root');
  }
  const worktree = join(dir, name);
  git(repo, 'worktree', 'add', '-q', '--detach', worktree);
  return { repo, worktree };
}

function linkTo(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

const byId = (out) => Object.fromEntries(out.output.results.map((row) => [row.id, row]));
const nonEmptyLines = (text) => text.split(/\r?\n/).filter((line) => line.trim());

test('custody: a junction is unlinked and its target keeps its files; a real directory recorded as one is kept', (t) => {
  const { dir, run } = sandbox(t);
  const target = join(dir, 'shared-install');
  mkdirSync(target);
  writeFileSync(join(target, 'package.json'), '{}');
  const link = join(dir, 'node_modules');
  linkTo(target, link);
  const real = join(dir, 'real-dir');
  mkdirSync(real);
  writeFileSync(join(real, 'keep.txt'), 'x');
  assert.equal(run('add', '--kind', 'junction', '--id', link).exit, 0);
  assert.equal(run('add', '--kind', 'junction', '--id', real).exit, 0);
  const out = run('close');
  assert.equal(out.exit, 3, JSON.stringify(out.output));
  const state = byId(out);
  assert.equal(state[link].state, 'disposed');
  assert.equal(existsSync(link), false, 'the link is gone');
  assert.deepEqual(readdirSync(target), ['package.json'], 'the target was not followed');
  assert.equal(state[real].state, 'kept');
  assert.match(state[real].reason, /is not a link; custody never deletes a real directory/);
  assert.deepEqual(readdirSync(real), ['keep.txt']);
});

test('custody: a clean worktree is removed; a dirty one, one holding an unrecorded link, and one whose HEAD is on no ref are kept', (t) => {
  const { dir, run } = sandbox(t);
  const clean = repoWithWorktree(dir, 'wt-clean');
  const dirty = repoWithWorktree(dir, 'wt-dirty');
  const linked = repoWithWorktree(dir, 'wt-linked');
  const orphan = repoWithWorktree(dir, 'wt-orphan');
  writeFileSync(join(dirty.worktree, 'work.txt'), 'unsaved');
  const target = join(dir, 'install');
  mkdirSync(target);
  writeFileSync(join(target, 'a.js'), '1');
  linkTo(target, join(linked.worktree, 'deps'));
  git(orphan.worktree, 'commit', '-q', '--allow-empty', '-m', 'only here');
  for (const wt of [clean, dirty, linked, orphan]) assert.equal(run('add', '--kind', 'worktree', '--id', wt.worktree, '--repo', wt.repo).exit, 0);
  const out = run('close');
  assert.equal(out.exit, 3);
  const state = byId(out);
  assert.equal(state[clean.worktree].state, 'disposed');
  assert.equal(existsSync(clean.worktree), false);
  assert.equal(state[dirty.worktree].state, 'kept');
  assert.match(state[dirty.worktree].reason, /uncommitted changes/);
  assert.equal(existsSync(join(dirty.worktree, 'work.txt')), true, 'the owner\'s work is untouched');
  assert.equal(state[linked.worktree].state, 'kept');
  assert.match(state[linked.worktree].reason, /still holds a link/);
  assert.deepEqual(readdirSync(target), ['a.js']);
  assert.equal(state[orphan.worktree].state, 'kept');
  assert.match(state[orphan.worktree].reason, /is on no ref; removing it would orphan the commit/);
});

// A bare origin seeded with x.txt on main, and a clone of it (origin/HEAD set).
function originAndClone(dir) {
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'x.txt'), 'one\ntwo\nthree\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'root');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  return { origin, repo: cloneOf(dir, origin, 'clone') };
}

function cloneOf(dir, origin, name) {
  const repo = join(dir, name);
  git(dir, 'clone', '-q', origin, repo);
  return repo;
}

function commit(cwd, file, text, message) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

// Deletes <branch> on origin, locally and as a remote-tracking ref.
function dropBranch(repo, branch) {
  git(repo, 'push', '-q', 'origin', '--delete', branch);
  git(repo, 'branch', '-q', '-D', branch);
  git(repo, 'update-ref', '-d', `refs/remotes/origin/${branch}`);
}

const detach = (repo, dir, at, name = 'review') => {
  const worktree = join(dir, name);
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, at);
  return worktree;
};

// Records the worktree and closes the ledger. No ref holds its HEAD first, so
// a removal can only come from the merged-head check.
function closeOrphan(run, repo, worktree) {
  const head = git(worktree, 'rev-parse', 'HEAD').trim();
  assert.equal(git(repo, 'for-each-ref', '--contains', head), '', 'the orphan precondition: no ref holds HEAD');
  assert.equal(run('add', '--kind', 'worktree', '--id', worktree, '--repo', repo).exit, 0);
  return { ...byId(run('close'))[worktree], gone: !existsSync(worktree) };
}

// feat's commits a and b squashed onto main as S, feat deleted everywhere,
// then main advanced with an unrelated file.
function squashMerged(dir) {
  const { origin, repo } = originAndClone(dir);
  git(repo, 'switch', '-q', '-c', 'feat');
  const a = commit(repo, 'a.txt', 'a\n', 'a');
  const b = commit(repo, 'b.txt', 'b\n', 'b');
  git(repo, 'push', '-q', 'origin', 'feat');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--squash', 'feat');
  git(repo, 'commit', '-q', '-m', 'S');
  git(repo, 'push', '-q', 'origin', 'main');
  dropBranch(repo, 'feat');
  commit(repo, 'u.txt', 'u\n', 'unrelated');
  git(repo, 'push', '-q', 'origin', 'main');
  return { origin, repo, a, b };
}

test('custody (merged head): a squash-merged head is removed, since merging it adds nothing', (t) => {
  const { dir, run } = sandbox(t);
  const { repo, b } = squashMerged(dir);
  const row = closeOrphan(run, repo, detach(repo, dir, b));
  assert.equal(row.state, 'disposed', row.reason);
  assert.equal(row.gone, true);
  assert.equal(row.reason, `removed: its HEAD ${b.slice(0, 12)} is on no ref; merging it into origin/main adds nothing (as last fetched; custody never fetches)`);
});

// The narrowed claim (council round 2): patch-ids are not proof, so a rebase
// merge whose lines main changed again is kept and needs a hand close.
test('custody (merged head): a rebase-merged head whose lines main edited again is kept', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  git(repo, 'switch', '-q', '-c', 'feat');
  const a = commit(repo, 'x.txt', 'one\nTWO\nthree\n', 'a');
  git(repo, 'push', '-q', 'origin', 'feat');
  git(repo, 'switch', '-q', 'main');
  // An unrelated commit first, so the cherry-pick cannot reproduce a's sha.
  commit(repo, 'u.txt', 'u\n', 'unrelated');
  git(repo, 'cherry-pick', a);
  commit(repo, 'x.txt', 'one\n2\nthree\n', 're-edit');
  git(repo, 'push', '-q', 'origin', 'main');
  dropBranch(repo, 'feat');
  assert.notEqual(spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', 'origin/main', a]).status, 0, 'merging it conflicts');
  const row = closeOrphan(run, repo, detach(repo, dir, a));
  assert.equal(row.state, 'kept', row.reason);
  assert.match(row.reason, /\(checked origin\/main\)$/);
});

test('custody (merged head): an unpushed commit is kept, and the reason names the refs it checked', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'new.txt', 'only here\n', 'unpushed');
  const row = closeOrphan(run, repo, worktree);
  assert.equal(row.state, 'kept');
  assert.equal(row.gone, false);
  assert.match(row.reason, /is on no ref; removing it would orphan the commit \(checked origin\/main\)$/);
});

test('custody (merged head): a partial squash, a change then its revert, and a merge commit in the range are kept', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  // Partial: main holds a, not b.
  const partial = detach(repo, dir, 'origin/main', 'partial');
  commit(partial, 'a.txt', 'a\n', 'a');
  commit(partial, 'b.txt', 'b\n', 'b');
  // Revert: a adds a line, b removes it, so the aggregate change is empty.
  const reverted = detach(repo, dir, 'origin/main', 'reverted');
  commit(reverted, 'x.txt', 'one\ntwo\nthree\nfour\n', 'add four');
  commit(reverted, 'x.txt', 'one\ntwo\nthree\n', 'drop four');
  // Merge: c and d on two sides, merged; main holds both files.
  const merged = detach(repo, dir, 'origin/main', 'merged');
  const c = commit(merged, 'c.txt', 'c\n', 'c');
  git(merged, 'checkout', '-q', '--detach', 'origin/main');
  commit(merged, 'd.txt', 'd\n', 'd');
  git(merged, 'merge', '-q', '--no-edit', c);
  commit(repo, 'a.txt', 'a\n', 'a on main');
  writeFileSync(join(repo, 'c.txt'), 'c\n');
  git(repo, 'add', 'c.txt');
  commit(repo, 'd.txt', 'd\n', 'c and d on main');
  git(repo, 'push', '-q', 'origin', 'main');
  for (const worktree of [partial, reverted, merged]) {
    const row = closeOrphan(run, repo, worktree);
    assert.equal(row.state, 'kept', `${worktree}: ${row.reason}`);
    assert.match(row.reason, /is on no ref; removing it would orphan the commit \(checked origin\/main\)$/);
  }
});

test('custody (merged head): a squashed range that holds an --allow-empty commit is kept, though merging it adds nothing', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'a.txt', 'a\n', 'a');
  git(worktree, 'commit', '-q', '--allow-empty', '-m', 'only a message');
  commit(worktree, 'b.txt', 'b\n', 'b');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  commit(repo, 'b.txt', 'b\n', 'S');
  git(repo, 'push', '-q', 'origin', 'main');
  const row = closeOrphan(run, repo, worktree);
  assert.equal(row.state, 'kept', row.reason);
  assert.match(row.reason, /\(checked origin\/main\)$/);
});

test('custody (merged head): a stale remote-tracking ref keeps the worktree; custody does not fetch', (t) => {
  const { dir, run } = sandbox(t);
  const { origin, repo } = originAndClone(dir);
  git(repo, 'switch', '-q', '-c', 'feat');
  commit(repo, 'a.txt', 'a\n', 'a');
  const b = commit(repo, 'b.txt', 'b\n', 'b');
  git(repo, 'push', '-q', 'origin', 'feat');
  // This clone fetched feat, never the squash.
  const stale = cloneOf(dir, origin, 'stale');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--squash', 'feat');
  git(repo, 'commit', '-q', '-m', 'S');
  git(repo, 'push', '-q', 'origin', 'main');
  dropBranch(repo, 'feat');
  git(stale, 'update-ref', '-d', 'refs/remotes/origin/feat');
  const row = closeOrphan(run, stale, detach(stale, dir, b));
  assert.equal(row.state, 'kept', row.reason);
  assert.match(row.reason, /\(checked origin\/main\)$/);
});

test('custody (merged head): with no default-branch ref the worktree is kept and the reason says so', (t) => {
  const { dir, run } = sandbox(t);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'trunk');
  commit(repo, 'x.txt', 'x\n', 'root');
  const worktree = detach(repo, dir, 'trunk');
  commit(worktree, 'y.txt', 'y\n', 'only here');
  const row = closeOrphan(run, repo, worktree);
  assert.equal(row.state, 'kept');
  assert.match(row.reason, /is on no ref; removing it would orphan the commit \(no default-branch ref to check against\)$/);
});

test('custody (merged head): a merge-tree that exits nonzero keeps the worktree, even with a matching tree id', (t) => {
  const trees = [];
  const failing = (args) => {
    const out = runArgv(['git', ...args], { timeout: 60_000 });
    if (!args.includes('merge-tree')) return out;
    trees.push(out.stdout.split(/\r?\n/)[0]);
    return { ...out, code: 1 };
  };
  const { dir, run } = sandbox(t, { git: failing });
  const { repo, b } = squashMerged(dir);
  const row = closeOrphan(run, repo, detach(repo, dir, b));
  assert.equal(row.state, 'kept', row.reason);
  // origin/HEAD resolves, so origin/main is the one candidate.
  assert.deepEqual(trees, [git(repo, 'rev-parse', 'origin/main^{tree}').trim()], 'the injected merge-tree carried the matching tree id');
});

test('custody (merged head): a custom merge driver on a changed path skips the merge check', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  // keepours keeps %A, the candidate's side, and exits 0: a conflict reads as a no-op.
  git(repo, 'config', 'merge.keepours.driver', 'true');
  commit(repo, '.gitattributes', 'x.txt merge=keepours\n', 'attributes');
  git(repo, 'push', '-q', 'origin', 'main');
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'x.txt', 'one\nHEAD\nthree\n', 'head edit');
  commit(repo, 'x.txt', 'one\nMAIN\nthree\n', 'main edit');
  git(repo, 'push', '-q', 'origin', 'main');
  const row = closeOrphan(run, repo, worktree);
  assert.equal(row.state, 'kept', row.reason);
  assert.equal(row.gone, false);
});

test('custody (merged head, review 4372983285): when origin/HEAD resolves, only its target is checked; a squash on another branch keeps the worktree', (t) => {
  const { dir, run } = sandbox(t);
  const { repo, b } = squashMerged(dir);
  // origin/HEAD names master, still at the root; only main holds the squash.
  git(repo, 'push', '-q', 'origin', `${git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim()}:refs/heads/master`);
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'remote', 'set-head', 'origin', 'master');
  const row = closeOrphan(run, repo, detach(repo, dir, b));
  assert.equal(row.state, 'kept', row.reason);
  assert.match(row.reason, /is on no ref; removing it would orphan the commit \(checked origin\/master\)$/);
});

test('custody (merged head, review 4372983289/4372983294): a merge.default driver skips the merge check', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  // No .gitattributes entry: merge.default names the driver for unspecified paths.
  git(repo, 'config', 'merge.default', 'keepours');
  git(repo, 'config', 'merge.keepours.driver', 'true');
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'x.txt', 'one\nHEAD\nthree\n', 'head edit');
  commit(repo, 'x.txt', 'one\nMAIN\nthree\n', 'main edit');
  git(repo, 'push', '-q', 'origin', 'main');
  const row = closeOrphan(run, repo, worktree);
  assert.equal(row.state, 'kept', row.reason);
  assert.equal(row.gone, false);
});

// Council round 2: a patch-id match is not proof. Each case below reads as
// landed to git cherry, and is kept.
function patchIdTwin(t, base, orphan, landed) {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  commit(repo, 'f.txt', base, 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'f.txt', orphan, 'orphan edit');
  commit(repo, 'f.txt', landed, 'landed edit');
  git(repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(nonEmptyLines(git(repo, 'cherry', 'origin/main', git(worktree, 'rev-parse', 'HEAD').trim())).map((line) => line[0]), ['-'], 'git cherry marks the orphan commit landed');
  return closeOrphan(run, repo, worktree);
}

test('custody (merged head, council C2-1): an edit that differs from the landed one only in indentation is kept', (t) => {
  const row = patchIdTwin(t, 'if x:\n    a()\nb()\n', 'if x:\n    a()\n    c()\nb()\n', 'if x:\n    a()\nc()\nb()\n');
  assert.equal(row.state, 'kept', row.reason);
  assert.equal(row.gone, false);
});

test('custody (merged head, council C2-1): an edit to the other copy of a repeated block is kept', (t) => {
  const pad = 'pad\npad\npad\n';
  const row = patchIdTwin(t, `${pad}X\n${pad}X\n${pad}`, `${pad}Y\n${pad}X\n${pad}`, `${pad}X\n${pad}Y\n${pad}`);
  assert.equal(row.state, 'kept', row.reason);
  assert.equal(row.gone, false);
});

test('custody (merged head, council C2-2): with no origin/HEAD and both origin/main and origin/master, the default branch is ambiguous and the worktree is kept', (t) => {
  const { dir, run } = sandbox(t);
  const { repo, b } = squashMerged(dir);
  git(repo, 'push', '-q', 'origin', `${git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim()}:refs/heads/master`);
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'remote', 'set-head', 'origin', '-d');
  const row = closeOrphan(run, repo, detach(repo, dir, b));
  assert.equal(row.state, 'kept', row.reason);
  assert.match(row.reason, /\(default branch ambiguous: origin\/main, origin\/master\)$/);
});

test('custody (merged head, council C2-3): a driver routed to a rename\'s destination by .git/info/attributes keeps the worktree', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  const lines = (first, eighth) => `${first}\n2\n3\n4\n5\n6\n7\n${eighth}\n9\n`;
  commit(repo, 'x.txt', lines('1', '8'), 'eight lines');
  git(repo, 'push', '-q', 'origin', 'main');
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'x.txt', lines('ONE', '8'), 'orphan edits line 1');
  git(repo, 'mv', 'x.txt', 'y.txt');
  commit(repo, 'y.txt', lines('1', 'EIGHT'), 'rename and edit line 8');
  git(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(join(repo, '.git', 'info', 'attributes'), 'y.txt merge=keepours\n');
  git(repo, 'config', 'merge.keepours.driver', 'true');
  const row = closeOrphan(run, repo, worktree);
  assert.equal(row.state, 'kept', row.reason);
  assert.equal(row.gone, false);
});

test('custody (merged head, review 4372983297): diff.relative with a --repo below the top level still finds the driver on the changed path', (t) => {
  const { dir, run } = sandbox(t);
  const { repo } = originAndClone(dir);
  mkdirSync(join(repo, 'sub'));
  git(repo, 'config', 'merge.keepours.driver', 'true');
  git(repo, 'config', 'diff.relative', 'true');
  writeFileSync(join(repo, '.gitattributes'), 'sub/x.txt merge=keepours\n');
  git(repo, 'add', '.gitattributes');
  commit(repo, 'sub/x.txt', 'one\ntwo\nthree\n', 'sub file');
  git(repo, 'push', '-q', 'origin', 'main');
  const worktree = detach(repo, dir, 'origin/main');
  commit(worktree, 'sub/x.txt', 'one\nHEAD\nthree\n', 'head edit');
  commit(repo, 'sub/x.txt', 'one\nMAIN\nthree\n', 'main edit');
  git(repo, 'push', '-q', 'origin', 'main');
  const row = closeOrphan(run, join(repo, 'sub'), worktree);
  assert.equal(row.state, 'kept', row.reason);
  assert.equal(row.gone, false);
});

test('custody: links close before the worktree that holds them, whatever order they were added in', (t) => {
  const { dir, run } = sandbox(t);
  const wt = repoWithWorktree(dir, 'wt');
  const target = join(dir, 'install');
  mkdirSync(target);
  writeFileSync(join(target, 'a.js'), '1');
  const link = join(wt.worktree, 'node_modules');
  linkTo(target, link);
  // Ignored, as a real node_modules is, so git status stays clean.
  git(wt.worktree, 'config', 'core.excludesFile', join(dir, 'ignore'));
  writeFileSync(join(dir, 'ignore'), 'node_modules\n');
  assert.equal(run('add', '--kind', 'worktree', '--id', wt.worktree, '--repo', wt.repo).exit, 0);
  assert.equal(run('add', '--kind', 'junction', '--id', link).exit, 0);
  const out = run('close');
  assert.equal(out.exit, 0, JSON.stringify(out.output));
  assert.deepEqual(out.output.results.map((row) => row.kind), ['junction', 'worktree']);
  assert.equal(existsSync(wt.worktree), false);
  assert.deepEqual(readdirSync(target), ['a.js'], 'the shared install survived');
});

test('custody: a database with a live owner is left alone, an occupied one is kept, an idle one is disposed; a second close retries only the kept', (t) => {
  const { dir, ledger, run } = sandbox(t);
  const marker = join(dir, 'dropped');
  assert.equal(run('add', '--kind', 'db', '--id', 'test_live', '--dispose', counting(marker), '--live', exitWith(0)).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'test_busy', '--dispose', exitWith(3)).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'test_idle', '--dispose', exitWith(0), '--live', exitWith(1)).exit, 0);
  const first = run('close');
  assert.equal(first.exit, 3);
  const state = byId(first);
  assert.deepEqual([state.test_live.state, state.test_busy.state, state.test_idle.state], ['kept', 'kept', 'disposed']);
  assert.match(state.test_live.reason, /owner is live/);
  assert.equal(runs(marker), 0, 'the live database\'s dispose never ran');
  assert.match(state.test_busy.reason, /^dispose exited 3/);
  const second = run('close');
  assert.deepEqual(second.output.results.map((row) => row.id).sort(), ['test_busy', 'test_live']);
  const read = { read: (p) => readFileSync(p, 'utf8') };
  assert.deepEqual(entries(readLedger(read, ledger).lines).map((row) => row.state).sort(), ['disposed', 'kept', 'kept']);
});

test('custody (council r1 M1/M2): --live guards every kind, and a check that does not exit 1 keeps the entry', (t) => {
  const { dir, run } = sandbox(t);
  const marker = join(dir, 'dropped');
  const target = join(dir, 'install');
  mkdirSync(target);
  const link = join(dir, 'link');
  linkTo(target, link);
  const wt = repoWithWorktree(dir, 'wt');
  assert.equal(run('add', '--kind', 'junction', '--id', link, '--live', exitWith(0)).exit, 0);
  assert.equal(run('add', '--kind', 'worktree', '--id', wt.worktree, '--repo', wt.repo, '--live', exitWith(0)).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'unlaunchable', '--dispose', counting(marker), '--live', JSON.stringify([join(dir, 'no-such-checker.exe')])).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'unclear', '--dispose', counting(marker), '--live', exitWith(2)).exit, 0);
  const out = run('close');
  const state = byId(out);
  assert.deepEqual([link, wt.worktree, 'unlaunchable', 'unclear'].map((id) => state[id].state), ['kept', 'kept', 'kept', 'kept']);
  assert.match(state.unlaunchable.reason, /did not run to an exit: could not launch/);
  assert.match(state.unclear.reason, /exited 2; only 1 means free/);
  assert.equal(existsSync(link), true);
  assert.equal(existsSync(wt.worktree), true);
  assert.equal(runs(marker), 0, 'no dispose ran');
});

test('custody (council r1 M4/U2): a disposed entry added again is a new generation; an open one added with different fields is refused', (t) => {
  const { dir, run } = sandbox(t);
  const marker = join(dir, 'dropped');
  assert.equal(run('add', '--kind', 'db', '--id', 'lane_db', '--dispose', counting(marker)).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'lane_db', '--dispose', exitWith(0)).exit, 2, 'a different --dispose for an open entry');
  assert.equal(run('close').exit, 0);
  const again = run('add', '--kind', 'db', '--id', 'lane_db', '--dispose', counting(marker));
  assert.deepEqual([again.exit, again.output.added, again.output.generation], [0, true, 'new']);
  assert.deepEqual(run('list').output.entries.map((row) => row.state), ['open']);
  assert.equal(run('close').exit, 0);
  assert.equal(runs(marker), 2, 'both generations were disposed');
});

test('custody (council r1 U1/M5): close --by disposes of one item\'s entries; a worktree a kept entry runs from is kept', (t) => {
  const { dir, run } = sandbox(t);
  const marker = join(dir, 'dropped');
  const wt = repoWithWorktree(dir, 'wt-cond');
  assert.equal(run('add', '--kind', 'db', '--id', 'item1_db', '--dispose', counting(marker), '--by', 'item-1').exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'item2_db', '--dispose', counting(marker), '--by', 'item-2').exit, 0);
  const one = run('close', '--by', 'item-1');
  assert.deepEqual(one.output.results.map((row) => row.id), ['item1_db']);
  assert.deepEqual(run('list').output.entries.map((row) => [row.id, row.state]), [['item1_db', 'disposed'], ['item2_db', 'open']]);
  // The dropper runs from inside the checkout and refuses (occupied): the checkout stays so a retry can launch.
  assert.equal(run('add', '--kind', 'db', '--id', 'cond_db', '--dispose', exitWith(3), '--cwd', wt.worktree, '--by', 'cond').exit, 0);
  assert.equal(run('add', '--kind', 'worktree', '--id', wt.worktree, '--repo', wt.repo, '--by', 'cond').exit, 0);
  const cond = byId(run('close', '--by', 'cond'));
  assert.equal(cond.cond_db.state, 'kept');
  assert.equal(cond[wt.worktree].state, 'kept');
  assert.match(cond[wt.worktree].reason, /db cond_db is not disposed and runs from inside it/);
  assert.equal(existsSync(wt.worktree), true);
});

test('custody (council r2 U1/U4/C2): a disposed dropper does not pin its checkout; droppers run before links close; a lock another writer replaced is not released', (t) => {
  const { dir, ledger, run } = sandbox(t);
  const wt = repoWithWorktree(dir, 'wt');
  git(wt.worktree, 'config', 'core.excludesFile', join(dir, 'ignore'));
  writeFileSync(join(dir, 'ignore'), 'node_modules\n');
  const target = join(dir, 'install');
  mkdirSync(target);
  writeFileSync(join(target, 'a.js'), '1');
  const link = join(wt.worktree, 'node_modules');
  linkTo(target, link);
  // The dropper needs the checkout's node_modules link (exit 3 without it), and replaces the lock as a second writer would.
  const lock = `${ledger}.lock`;
  const dropper = node(`const fs = require('fs'); fs.writeFileSync(${JSON.stringify(lock)}, 'other writer\\n'); process.exit(fs.existsSync(${JSON.stringify(link)}) ? 0 : 3)`);
  assert.equal(run('add', '--kind', 'worktree', '--id', wt.worktree, '--repo', wt.repo, '--by', 'cond').exit, 0);
  assert.equal(run('add', '--kind', 'junction', '--id', link, '--by', 'cond').exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'cond_db', '--dispose', dropper, '--cwd', wt.worktree, '--by', 'cond').exit, 0);
  const out = run('close', '--by', 'cond');
  assert.deepEqual(out.output.results.map((row) => [row.kind, row.state]), [['db', 'disposed'], ['junction', 'disposed'], ['worktree', 'disposed']], JSON.stringify(out.output));
  assert.equal(readFileSync(lock, 'utf8'), 'other writer\n', 'the replaced lock was left to its writer');
  assert.deepEqual(readdirSync(target), ['a.js']);
});

test('custody (council r2 M2/M3/M4/U2): ignored files keep a worktree unless declared disposable; a never-written ledger closes clean; a worktree gone with its repo is disposed; empty values are refused', (t) => {
  const { dir, run } = sandbox(t);
  const kept = repoWithWorktree(dir, 'wt-env');
  const built = repoWithWorktree(dir, 'wt-built');
  for (const wt of [kept, built]) {
    git(wt.worktree, 'config', 'core.excludesFile', join(dir, 'ignore'));
  }
  writeFileSync(join(dir, 'ignore'), '.env\ndist/\n');
  writeFileSync(join(kept.worktree, '.env'), 'SECRET=1');
  mkdirSync(join(built.worktree, 'dist'));
  writeFileSync(join(built.worktree, 'dist', 'out.js'), '1');
  assert.equal(run('add', '--kind', 'worktree', '--id', kept.worktree, '--repo', kept.repo).exit, 0);
  assert.equal(run('add', '--kind', 'worktree', '--id', built.worktree, '--repo', built.repo, '--ignored', 'disposable').exit, 0);
  const state = byId(run('close'));
  assert.equal(state[kept.worktree].state, 'kept');
  assert.match(state[kept.worktree].reason, /ignored files the run did not declare disposable .*\.env/);
  assert.equal(existsSync(join(kept.worktree, '.env')), true);
  assert.equal(state[built.worktree].state, 'disposed');
  const fresh = join(dir, 'never', 'written', 'custody.jsonl');
  const none = runCustody(['close', '--ledger', fresh]);
  assert.deepEqual([none.exit, none.output.closed], [0, 0]);
  const gone = join(dir, 'gone-wt');
  assert.equal(run('add', '--kind', 'worktree', '--id', gone, '--repo', join(dir, 'gone-repo')).exit, 0);
  assert.equal(byId(run('close'))[gone].state, 'disposed');
  for (const argv of [['close', '--by', ''], ['add', '--kind', 'db', '--id', 'q', '--dispose', exitWith(0), '--live', ' '], ['add', '--kind', 'db', '--id', 'q', '--dispose', exitWith(0), '--ignored', 'disposable']]) {
    assert.equal(run(...argv).exit, 2, argv.join(' '));
  }
});

test('custody (council r1 M6/M7/U3): an lstat error keeps a junction; a fresh lock refuses a second close; a torn last line is reported and survives the next append', (t) => {
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const { dir, ledger, run } = sandbox(t, { lstat: () => { throw denied; } });
  const link = join(dir, 'link');
  assert.equal(run('add', '--kind', 'junction', '--id', link).exit, 0);
  const out = run('close');
  assert.deepEqual([out.exit, out.output.results[0].state], [3, 'kept']);
  assert.match(out.output.results[0].reason, /EACCES/);
  // A held lock refuses close and add alike; unlock removes it only when its pid is not running.
  writeFileSync(`${ledger}.lock`, `${process.pid} abc\n`);
  const locked = run('close');
  assert.equal(locked.exit, 4);
  assert.match(locked.output.error, new RegExp(`pid ${process.pid} holds .*run again when it is done, or unlock`));
  assert.equal(run('add', '--kind', 'db', '--id', 'while-locked', '--dispose', exitWith(0)).exit, 4);
  assert.equal(run('unlock').exit, 4, 'a running holder is not unlocked');
  const dead = runCustody(['unlock', '--ledger', ledger], { pidAlive: () => false });
  assert.deepEqual([dead.exit, dead.output.removed], [0, true]);
  assert.equal(existsSync(`${ledger}.lock`), false);
  appendFileSync(ledger, '{"op":"add","kind":"db"');
  assert.deepEqual(run('list').output.skippedLines, [3]);
  assert.equal(run('add', '--kind', 'db', '--id', 'after', '--dispose', exitWith(0)).exit, 0);
  const listed = run('list').output;
  assert.deepEqual([listed.skippedLines, listed.entries.map((row) => row.id)], [[3], [link, 'after']]);
});

// Windows CI on dc9a5e8: tmpdir() was C:\Users\RUNNER~1\..., git printed the
// long name, and every worktree read as "not a worktree of" its repo.
test('custody (Windows CI): a worktree recorded by its 8.3 short path is still matched to git\'s long one', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 short names exist only on Windows');
  const { dir, run } = sandbox(t);
  const wt = repoWithWorktree(dir, 'worktree-with-a-long-name');
  const short = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${wt.worktree}').ShortPath`], { encoding: 'utf8' }).trim();
  if (short.toLowerCase() === wt.worktree.toLowerCase()) return t.skip('8.3 names are disabled on this volume: the control did not run');
  assert.equal(run('add', '--kind', 'worktree', '--id', short, '--repo', wt.repo).exit, 0);
  const out = run('close');
  assert.equal(out.exit, 0, JSON.stringify(out.output));
  assert.equal(existsSync(wt.worktree), false);
});

test('custody: add is idempotent, list shows state, dry-run writes nothing; usage is refused before any write', (t) => {
  const { dir, ledger, run } = sandbox(t);
  assert.equal(run('add', '--kind', 'db', '--id', 'x', '--dispose', exitWith(0)).output.added, true);
  assert.equal(run('add', '--kind', 'db', '--id', 'x', '--dispose', exitWith(0)).output.added, false);
  assert.deepEqual(run('list').output.entries.map((row) => [row.id, row.state]), [['x', 'open']]);
  const dry = run('close', '--dry-run');
  assert.deepEqual(dry.output.wouldClose, [{ kind: 'db', id: 'x' }]);
  assert.deepEqual(run('list').output.entries.map((row) => row.state), ['open']);
  const refusals = [
    ['add', '--kind', 'db', '--id', 'y'],
    ['add', '--kind', 'worktree', '--id', join(dir, 'w')],
    ['add', '--kind', 'junction', '--id', 'relative/path'],
    ['add', '--kind', 'junction', '--id', join(dir, 'j'), '--dispose', exitWith(0)],
    ['add', '--kind', 'db', '--id', 'z', '--dispose', '"not an array"'],
    ['add', '--kind', 'db', '--id', 'z', '--dispose', exitWith(0), '--repo', dir],
    ['add', '--kind', 'vm', '--id', 'z'],
    ['list', '--dry-run'],
    ['close', '--kind', 'db'],
  ];
  for (const argv of refusals) assert.equal(run(...argv).exit, 2, argv.join(' '));
  assert.equal(runCustody(['list', '--ledger', 'relative.jsonl']).exit, 2);
  assert.equal(run('list').output.entries.length, 1, 'no refusal wrote');
  assert.equal(existsSync(ledger), true);
});
