import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { findLinks, removeWorktree, unlinkAll } from './worktree-teardown.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

// A repo, one worktree, and two link targets holding files. 'junction' is a
// junction on Windows and a directory symlink elsewhere.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'worktree-teardown-'));
  // Links are unlinked before the recursive delete, so cleanup can't empty a target either.
  t.after(() => {
    if (!existsSync(root)) return;
    assert.equal(unlinkAll(root), null);
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'teardown@example.invalid']);
  git(repo, ['config', 'user.name', 'teardown']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.cache\n');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);
  const targets = { modules: join(root, 'canonical-pkg'), cache: join(root, 'canonical-cache') };
  for (const dir of Object.values(targets)) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'must survive\n');
  }
  const worktree = join(root, 'wt');
  git(repo, ['worktree', 'add', '-q', '--detach', worktree, 'HEAD']);
  // One link nested inside a real directory, one at the top level.
  mkdirSync(join(worktree, 'node_modules'));
  symlinkSync(targets.modules, join(worktree, 'node_modules', 'pkg'), 'junction');
  symlinkSync(targets.cache, join(worktree, '.cache'), 'junction');
  return { root, repo, worktree, targets };
}

const intact = (targets) => Object.values(targets).every((dir) => readdirSync(dir).includes('keep.txt'));
const registered = (repo, worktree) => git(repo, ['worktree', 'list', '--porcelain']).includes(worktree.replace(/\\/g, '/'));

test('findLinks lists nested and top-level links without entering them', (t) => {
  const { worktree } = fixture(t);
  const links = findLinks(worktree).map((path) => path.slice(worktree.length + 1).replace(/\\/g, '/')).sort();
  assert.deepEqual(links, ['.cache', 'node_modules/pkg']);
});

test('removeWorktree removes the worktree and its registration and leaves every link target intact', (t) => {
  const { repo, worktree, targets } = fixture(t);
  assert.deepEqual(removeWorktree(repo, worktree), { removed: true });
  assert.equal(existsSync(worktree), false);
  assert.equal(registered(repo, worktree), false);
  assert.ok(intact(targets), 'a link target lost its files');
});

test('a git that exits 0 and leaves the directory (Git for Windows >= 2.54 beside a junction) is finished on disk, never reported removed while present', (t) => {
  const { repo, worktree, targets } = fixture(t);
  const calls = [];
  const leaveIt = (args) => {
    calls.push(args[1]);
    return '';
  };
  assert.deepEqual(removeWorktree(repo, worktree, { git: leaveIt }), { removed: true });
  assert.equal(existsSync(worktree), false);
  assert.deepEqual(calls, ['remove', 'prune']);
  assert.ok(intact(targets));
});

test('a left-behind directory that cannot be deleted is a failure result, never a throw, so the next worktree is still removed', (t) => {
  const { repo, worktree, targets } = fixture(t);
  const locked = () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  };
  // git really unregisters the worktree and leaves its directory, as Git for
  // Windows >= 2.54 does beside a junction.
  const unregister = (args) => {
    if (args[1] === 'remove') rmSync(join(repo, '.git', 'worktrees', basename(worktree)), { recursive: true, force: true });
    return '';
  };
  const result = removeWorktree(repo, worktree, { git: unregister, rm: locked });
  assert.equal(result.removed, false);
  assert.match(result.reason, /remains after git's removal: EBUSY/);
  assert.equal(registered(repo, worktree), false, 'git unregistered it');
  assert.ok(existsSync(worktree));
  assert.ok(intact(targets));
  // The retry meets git's "is not a working tree" and still finishes the delete.
  assert.deepEqual(removeWorktree(repo, worktree), { removed: true }, 'the same worktree is removable once the lock is gone');
  assert.equal(existsSync(worktree), false);
});

test('a git refusal other than an unregistered worktree still leaves the directory', (t) => {
  const { repo, worktree } = fixture(t);
  const refuse = () => {
    throw Object.assign(new Error('boom'), { stderr: Buffer.from("fatal: 'wt' contains modified or untracked files\n") });
  };
  assert.equal(removeWorktree(repo, worktree, { git: refuse, rm: () => assert.fail('rm must not run') }).removed, false);
  assert.ok(existsSync(worktree));
});

test('a git that fails leaves the worktree in place with the reason', (t) => {
  const { repo, worktree, targets } = fixture(t);
  const fail = () => {
    throw Object.assign(new Error('boom'), { stderr: Buffer.from('fatal: refused\n') });
  };
  assert.deepEqual(removeWorktree(repo, worktree, { git: fail }), { removed: false, reason: 'git worktree remove failed: fatal: refused' });
  assert.ok(existsSync(worktree));
  assert.ok(intact(targets));
});

test('a worktree path that is itself a link is refused and nothing is deleted', (t) => {
  const { root, repo, targets } = fixture(t);
  const linked = join(root, 'wt-link');
  symlinkSync(targets.modules, linked, 'junction');
  const result = removeWorktree(repo, linked, { git: () => assert.fail('git must not run') });
  assert.equal(result.removed, false);
  assert.match(result.reason, /is itself a link/);
  assert.ok(lstatSync(linked).isSymbolicLink());
  assert.ok(intact(targets));
});

test('a missing worktree is already removed', (t) => {
  const { root, repo } = fixture(t);
  assert.deepEqual(removeWorktree(repo, join(root, 'never-made'), { git: () => assert.fail('git must not run') }), { removed: true });
});
