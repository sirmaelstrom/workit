// workspace-preamble.test.mjs — behavioural guard (runs in the `node --test` CI job).
//
// The preamble replaces written environment state in handoffs. That only holds if
// it is trustworthy in the two directions that matter:
//
//   1. It must REPORT the occupied checkouts (dirty tree, feature branch, extra
//      worktree) — those are the class-E cargo a handoff used to carry stale.
//   2. It must never let "I could not look" render as "everything is fine".
//      A preamble that scanned nothing and printed a clean board is worse than
//      no preamble, because the next session acts on it.
//
// Arena paths are built from os.tmpdir(), never a drive-letter literal: `D:/x`
// is ABSOLUTE on Windows but RELATIVE on the Linux CI runner, so a hardcoded
// path passes locally and resolves under `/` on CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const SCRIPT = join(HERE, 'workspace-preamble.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(projectsDir, name, { branch = 'main', dirty = false } = {}) {
  const repo = join(projectsDir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'preamble@example.invalid');
  git(repo, 'config', 'user.name', 'Preamble Guard');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'init');
  if (branch !== 'main') git(repo, 'checkout', '-b', branch);
  if (dirty) writeFileSync(join(repo, 'README.md'), `# ${name}\nlocal edit\n`);
  return repo;
}

/** Run the script; returns {status, stdout, stderr} without throwing on non-zero. */
function runPreamble(args) {
  const res = execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A non-zero exit is a verdict under test, not a harness failure.
    // execFileSync throws on non-zero, so catch and read the attached buffers.
  });
  return { status: 0, stdout: res, stderr: '' };
}

function runPreambleAllowFail(args) {
  try {
    return runPreamble(args);
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

// --- arena -------------------------------------------------------------------

const arena = mkdtempSync(join(tmpdir(), 'workspace-preamble-'));
const projectsDir = join(arena, 'projects');
mkdirSync(projectsDir, { recursive: true });

makeRepo(projectsDir, 'quiet-repo'); // clean, on main  -> suppressed
makeRepo(projectsDir, 'dirty-repo', { dirty: true }); // -> notable
makeRepo(projectsDir, 'branched-repo', { branch: 'feat/thing' }); // -> notable

process.on('exit', () => {
  try {
    rmSync(arena, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a leftover tmpdir is harmless; never fail a passing run on cleanup */
  }
});

// --- tests -------------------------------------------------------------------

test('reports occupied checkouts and suppresses the quiet ones', () => {
  const { stdout } = runPreamble(['--workspace-root', arena]);

  assert.match(stdout, /CHECKOUTS — 3 repo\(s\) scanned, 2 notable/, 'scanned/notable counts');
  assert.match(stdout, /dirty-repo/, 'a dirty tree must be reported');
  assert.match(stdout, /branched-repo/, 'a non-default branch must be reported');
  assert.match(stdout, /feat\/thing/, 'the actual branch name must appear');
  assert.doesNotMatch(stdout, /quiet-repo/, 'a clean repo on main is not notable');

  // The suppressed rows must be counted out loud — silence about 1 repo and
  // silence about 400 look identical otherwise.
  assert.match(stdout, /\(\+1 clean on a default branch/, 'suppressed rows are counted');
});

test('--all lists the suppressed repos', () => {
  const { stdout } = runPreamble(['--workspace-root', arena, '--all']);
  assert.match(stdout, /quiet-repo/, '--all must show the clean repo');
  assert.doesNotMatch(stdout, /clean on a default branch — re-run/, 'nothing left to suppress');
});

test('announces the workspace root and the rule that resolved it', () => {
  const viaArg = runPreamble(['--workspace-root', arena]).stdout;
  assert.match(viaArg, /workspace root: .*\[via --workspace-root\]/, 'explicit arg is announced');

  // The env-var rung of the same ladder.
  const res = execFileSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKIT_WORKSPACE_ROOT: arena },
  });
  assert.match(res, /\[via WORKIT_WORKSPACE_ROOT\]/, 'env var is announced');
});

test('scanning nothing is a distinct failure, not a clean board', () => {
  const empty = mkdtempSync(join(tmpdir(), 'workspace-preamble-empty-'));
  try {
    const { status, stdout, stderr } = runPreambleAllowFail(['--workspace-root', empty]);

    assert.equal(status, 2, '"did not run" must have its own exit code');
    assert.match(stderr, /NOT "all clean"/, 'stderr must refuse the clean-board reading');
    // And it must not have printed a reassuring checkout table on the way out.
    assert.doesNotMatch(stdout, /notable/, 'no notable-count line when nothing was scanned');
  } finally {
    rmSync(empty, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('unavailable probes say "not checked", never a definitive negative', () => {
  const { stdout } = runPreamble(['--workspace-root', arena]);

  // The arena has no workit checkout, so plugin freshness is genuinely
  // indeterminate. It must never render as "current" — a false all-clear on the
  // plugin cache is exactly the owed-reload failure this script exists to catch.
  const pluginLine = stdout.split('\n').find((l) => l.includes('workit')) ?? '';
  assert.doesNotMatch(pluginLine, /← current/, 'indeterminate must not read as current');
  assert.match(stdout, /not resolvable|indeterminate|STALE/, 'plugin verdict is explicit');

  // pm2 may or may not exist on the runner. Either answer is fine; an ambiguous
  // one is not — "no processes" and "could not look" must be different strings.
  const services = stdout.slice(stdout.indexOf('SERVICES (pm2)'));
  assert.match(
    services,
    /not available on this box — not checked|no processes registered|restarts \d+/,
    'the services section must state which of the three cases it is in',
  );
});

test('--json emits the same findings in parseable form', () => {
  const { stdout } = runPreamble(['--workspace-root', arena, '--json']);
  const report = JSON.parse(stdout);

  assert.equal(report.scan.repos.length, 3, 'all three repos present in the payload');
  const byName = Object.fromEntries(report.scan.repos.map((r) => [r.name, r]));
  assert.equal(byName['dirty-repo'].dirty, 1, 'dirty count is a number, not a guess');
  assert.equal(byName['quiet-repo'].dirty, 0, 'clean repo reports zero');
  assert.equal(byName['branched-repo'].branch, 'feat/thing', 'branch is measured');
  assert.equal(report.rootInfo.via, '--workspace-root', 'resolution rule is in the payload');
});

// Self-check: a guard whose arena stopped building repos, or whose assertions
// could no longer fail, would keep passing while guarding nothing.
test('guard is non-vacuous (the arena is real and the checks discriminate)', () => {
  const { stdout } = runPreamble(['--workspace-root', arena, '--json']);
  const report = JSON.parse(stdout);
  assert.ok(report.scan.repos.length >= 3, 'arena must actually contain repos');

  // The notable/quiet split is the whole classification. If every repo were
  // notable (or none were), the suppression test above would pass vacuously.
  const notable = report.scan.repos.filter(
    (r) => r.dirty > 0 || (r.branch !== 'main' && r.branch !== 'master') || r.worktrees.length > 0,
  );
  assert.equal(notable.length, 2, 'exactly two notable repos — the split is real');
  assert.equal(report.scan.repos.length - notable.length, 1, 'and exactly one quiet repo');
});
