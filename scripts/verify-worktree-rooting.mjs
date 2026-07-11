#!/usr/bin/env node
// Mechanical proof for reference/patterns/worktree-rooting.md (V4).
//
// Proves the pattern's EXACT worktree-creation argv is cwd-independent:
//
//     git -C <abs-target-repo> worktree add <abs-target-repo>-wt-<slug> -b <branch>
//
// The command is invoked literally (not a reimplemented parallel recipe) from
// four different cwds, and every created worktree is asserted via the STEP-0
// identity checks (`git rev-parse --show-toplevel` + `git remote get-url origin`):
//
//   Case 1: cwd is not a repo at all
//   Case 2: cwd is the WRONG repo (the sibling-repo failure this pattern kills)
//   Case 3: cwd is the right repo
//   Case 4: multi-repo — two worktrees, IDENTICAL branch name, from an unrelated cwd
//
// Exit 0 = rooting is deterministic regardless of session cwd.
// If the recipe in worktree-rooting.md changes, this script must change with it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const failures = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Canonical path form for comparison: symlinks resolved, forward slashes, case-folded on win32. */
function canon(p) {
  const real = (realpathSync.native ?? realpathSync)(p);
  const norm = real.replace(/\\/g, '/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function makeRepo(base, name) {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'proof@example.invalid');
  git(repo, 'config', 'user.name', 'Worktree Rooting Proof');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', `https://example.invalid/${name}.git`);
  return repo;
}

/**
 * THE MANDATED ARGV — invoked literally, with cwd deliberately set to the case
 * under test. If rooting leaked through cwd, this is where it would happen.
 */
function createWorktreePerPattern(fromCwd, absTargetRepo, slug, branch) {
  const worktree = `${absTargetRepo}-wt-${slug}`;
  execFileSync(
    'git',
    ['-C', absTargetRepo, 'worktree', 'add', worktree, '-b', branch],
    { cwd: fromCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return worktree;
}

/** STEP-0 identity assertion, exactly as the pattern mandates before any edit. */
function assertStepZero(caseName, worktree, expectedRepoName, expectedBranch) {
  const toplevel = git(worktree, 'rev-parse', '--show-toplevel');
  const origin = git(worktree, 'remote', 'get-url', 'origin');
  const branch = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD');

  const checks = [
    [`toplevel is the worktree itself`, canon(toplevel) === canon(worktree), `${toplevel} != ${worktree}`],
    [`origin is ${expectedRepoName}'s remote`, origin === `https://example.invalid/${expectedRepoName}.git`, origin],
    [`branch is ${expectedBranch}`, branch === expectedBranch, branch],
  ];
  for (const [what, pass, got] of checks) {
    if (pass) {
      console.log(`  ok   ${caseName}: ${what}`);
    } else {
      console.log(`  FAIL ${caseName}: ${what} (got: ${got})`);
      failures.push(`${caseName}: ${what}`);
    }
  }
}

function removeWorktree(repo, worktree, branch) {
  git(repo, 'worktree', 'remove', '--force', worktree);
  git(repo, 'branch', '-D', branch);
}

// --- arena setup -------------------------------------------------------------

const arena = mkdtempSync(join(tmpdir(), 'worktree-rooting-proof-'));
const repoAlpha = makeRepo(arena, 'target-alpha');
const repoBeta = makeRepo(arena, 'target-beta');
const notARepo = join(arena, 'plain-directory');
mkdirSync(notARepo);

console.log(`arena: ${arena}\n`);

try {
  // Case 1: cwd is not a repo — rooting must come entirely from the -C argument.
  {
    const wt = createWorktreePerPattern(notARepo, repoAlpha, 'case1', 'proof/case-1');
    assertStepZero('case 1 (not-a-repo cwd)', wt, 'target-alpha', 'proof/case-1');
    removeWorktree(repoAlpha, wt, 'proof/case-1');
  }

  // Case 2: cwd is the WRONG repo — the sibling-repo trap. The worktree must
  // still root to target-alpha, not to the repo we're standing in.
  {
    const wt = createWorktreePerPattern(repoBeta, repoAlpha, 'case2', 'proof/case-2');
    assertStepZero('case 2 (wrong-repo cwd)', wt, 'target-alpha', 'proof/case-2');
    removeWorktree(repoAlpha, wt, 'proof/case-2');
  }

  // Case 3: cwd is the right repo — the happy path must also hold.
  {
    const wt = createWorktreePerPattern(repoAlpha, repoAlpha, 'case3', 'proof/case-3');
    assertStepZero('case 3 (right-repo cwd)', wt, 'target-alpha', 'proof/case-3');
    removeWorktree(repoAlpha, wt, 'proof/case-3');
  }

  // Case 4: multi-repo — one worktree per target, IDENTICAL branch name (the
  // joint-merge minimum), created from a cwd unrelated to either repo.
  {
    const branch = 'proof/joint-branch';
    const wtA = createWorktreePerPattern(notARepo, repoAlpha, 'case4', branch);
    const wtB = createWorktreePerPattern(notARepo, repoBeta, 'case4', branch);
    assertStepZero('case 4 (multi-repo, alpha)', wtA, 'target-alpha', branch);
    assertStepZero('case 4 (multi-repo, beta)', wtB, 'target-beta', branch);
    removeWorktree(repoAlpha, wtA, branch);
    removeWorktree(repoBeta, wtB, branch);
  }
} finally {
  // Cleanup is best-effort: on Windows, read-only .git objects can survive a
  // first rm pass; a leftover dir under tmpdir is harmless, so never let
  // cleanup turn a passing proof into a failure.
  try {
    rmSync(arena, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    console.log(`  (cleanup warning: could not remove ${basename(arena)}: ${e.message})`);
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`✖ ${failures.length} assertion(s) failed — rooting is NOT cwd-independent:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('✓ all four cwd cases root to the declared target — rooting is cwd-independent');
  process.exit(0);
}
