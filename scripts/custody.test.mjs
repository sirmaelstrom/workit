// Run custody on a real filesystem and a real git repo in a temp dir. The
// dispose and live commands are `node -e`, so a test database is modelled by
// a command that exits as the repo's dropper would (0 dropped, 3 occupied).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCustody, entries, readLedger } from './custody.mjs';

const node = (code) => JSON.stringify([process.execPath, '-e', code]);
const exitWith = (n) => node(`process.exit(${n})`);

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-custody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'run', 'custody.jsonl');
  const run = (...argv) => runCustody([argv[0], '--ledger', ledger, ...argv.slice(1)]);
  return { dir, ledger, run };
}

function repoWithWorktree(dir, name) {
  const repo = join(dir, 'repo');
  if (!existsSync(repo)) {
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  }
  const worktree = join(dir, name);
  execFileSync('git', ['worktree', 'add', '-q', '--detach', worktree], { cwd: repo, stdio: 'pipe' });
  return { repo, worktree };
}

function linkTo(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

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
  const byId = Object.fromEntries(out.output.results.map((row) => [row.id, row]));
  assert.equal(byId[link].state, 'disposed');
  assert.equal(existsSync(link), false, 'the link is gone');
  assert.deepEqual(readdirSync(target), ['package.json'], 'the target was not followed');
  assert.equal(byId[real].state, 'kept');
  assert.match(byId[real].reason, /is not a link; custody never deletes a real directory/);
  assert.deepEqual(readdirSync(real), ['keep.txt']);
});

test('custody: a clean worktree is removed; a dirty one and one holding an unrecorded link are kept', (t) => {
  const { dir, run } = sandbox(t);
  const clean = repoWithWorktree(dir, 'wt-clean');
  const dirty = repoWithWorktree(dir, 'wt-dirty');
  const linked = repoWithWorktree(dir, 'wt-linked');
  writeFileSync(join(dirty.worktree, 'work.txt'), 'unsaved');
  const target = join(dir, 'install');
  mkdirSync(target);
  writeFileSync(join(target, 'a.js'), '1');
  linkTo(target, join(linked.worktree, 'deps'));
  for (const wt of [clean, dirty, linked]) assert.equal(run('add', '--kind', 'worktree', '--id', wt.worktree, '--repo', wt.repo).exit, 0);
  const out = run('close');
  assert.equal(out.exit, 3);
  const state = Object.fromEntries(out.output.results.map((row) => [row.id, row]));
  assert.equal(state[clean.worktree].state, 'disposed');
  assert.equal(existsSync(clean.worktree), false);
  assert.equal(state[dirty.worktree].state, 'kept');
  assert.match(state[dirty.worktree].reason, /uncommitted changes/);
  assert.equal(existsSync(join(dirty.worktree, 'work.txt')), true, 'the owner\'s work is untouched');
  assert.equal(state[linked.worktree].state, 'kept');
  assert.match(state[linked.worktree].reason, /still holds a link/);
  assert.deepEqual(readdirSync(target), ['a.js']);
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
  execFileSync('git', ['config', 'core.excludesFile', join(dir, 'ignore')], { cwd: wt.worktree });
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
  assert.equal(run('add', '--kind', 'db', '--id', 'test_live', '--dispose', node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`), '--live', exitWith(0)).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'test_busy', '--dispose', exitWith(3)).exit, 0);
  assert.equal(run('add', '--kind', 'db', '--id', 'test_idle', '--dispose', exitWith(0), '--live', exitWith(1)).exit, 0);
  const first = run('close');
  assert.equal(first.exit, 3);
  const state = Object.fromEntries(first.output.results.map((row) => [row.id, row]));
  assert.deepEqual([state.test_live.state, state.test_busy.state, state.test_idle.state], ['kept', 'kept', 'disposed']);
  assert.match(state.test_live.reason, /owner is live/);
  assert.equal(existsSync(marker), false, 'the live database\'s dispose never ran');
  assert.match(state.test_busy.reason, /^dispose exited 3/);
  const second = run('close');
  assert.deepEqual(second.output.results.map((row) => row.id).sort(), ['test_busy', 'test_live']);
  assert.deepEqual(entries(readLedger({ exists: existsSync, read: (p) => readFileSync(p, 'utf8') }, ledger)).map((row) => row.state).sort(), ['disposed', 'kept', 'kept']);
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
    ['add', '--kind', 'vm', '--id', 'z'],
    ['list', '--dry-run'],
  ];
  for (const argv of refusals) assert.equal(run(...argv).exit, 2, argv.join(' '));
  assert.equal(runCustody(['list', '--ledger', 'relative.jsonl']).exit, 2);
  assert.equal(run('list').output.entries.length, 1, 'no refusal wrote');
  assert.equal(existsSync(ledger), true);
});
