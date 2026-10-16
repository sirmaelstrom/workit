import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCH = fileURLToPath(new URL('./launch.mjs', import.meta.url));

// Without --prompts the launcher once read the cwd as the prompts directory and
// launched a branch agent per Markdown file in it.
test('no --prompts exits 1 before reading the cwd or writing results', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'launch-no-prompts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'README.md'), 'not a branch prompt\n');
  const run = spawnSync(process.execPath, [LAUNCH], { cwd, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /--prompts directory required/);
  assert.doesNotMatch(run.stdout, /Branches:/);
  assert.equal(existsSync(join(root, 'results')), false);
});

// Quest 061b526a: spike mode runs each branch in its own new, empty directory
// outside every repo, with the permission to write and run throwaway code.
// A fake `claude` on PATH prints its cwd and argv in place of a real agent.
function fakeClaude(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nmore > nul\r\necho cwd=%CD% args=%*\r\n');
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat > /dev/null\necho "cwd=$(pwd) args=$*"\n', { mode: 0o755 });
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function spikeRun(t) {
  const root = mkdtempSync(join(tmpdir(), 'launch-spike-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = join(root, 'run-x');
  mkdirSync(join(run, 'prompts'), { recursive: true });
  writeFileSync(join(run, 'prompts', 'branch-1.md'), 'spike the core loop in stack A\n');
  writeFileSync(join(run, 'prompts', 'branch-2.md'), 'spike the core loop in stack B\n');
  return { root, run, env: fakeClaude(root), spikeRoot: join(root, 'spikes') };
}

test('--spike: each branch runs in its own empty directory under the spike root, with bypassPermissions', (t) => {
  const { run, env, spikeRoot } = spikeRun(t);
  const out = spawnSync(process.execPath, [LAUNCH, '--prompts', join(run, 'prompts'), '--spike', '--spike-root', spikeRoot], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  for (const branch of ['branch-1', 'branch-2']) {
    const result = readFileSync(join(run, 'results', `${branch}.md`), 'utf8');
    const dir = join(spikeRoot, 'run-x', branch);
    assert.ok(existsSync(dir), `${dir} was created`);
    assert.ok(result.includes(`| spike: ${dir} -->`), result);
    assert.ok(result.toLowerCase().includes(`cwd=${dir}`.toLowerCase()), result);
    assert.match(result, /args=-p --output-format text --model sonnet --permission-mode bypassPermissions/);
  }
});

test('--spike refuses --worktree, a non-empty spike directory, and a spike root inside a git work tree', (t) => {
  const { root, run, env, spikeRoot } = spikeRun(t);
  const launch = (...extra) => spawnSync(process.execPath, [LAUNCH, '--prompts', join(run, 'prompts'), '--spike', ...extra], { env, encoding: 'utf8', timeout: 60000 });
  const both = launch('--spike-root', spikeRoot, '--worktree');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /cannot be combined with --worktree/);
  // The second branch's directory is the stale one: the first must not have launched either.
  mkdirSync(join(spikeRoot, 'run-x', 'branch-2'), { recursive: true });
  writeFileSync(join(spikeRoot, 'run-x', 'branch-2', 'left.txt'), 'an earlier spike\n');
  const stale = launch('--spike-root', spikeRoot);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /is not empty/);
  assert.equal(existsSync(join(run, 'results', 'branch-1.md')), false, 'every spike directory is checked before any branch launches');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  const inside = launch('--spike-root', join(repo, 'spikes'));
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /inside a git work tree/);
  assert.equal(existsSync(join(run, 'results', 'branch-2.md')), false, 'no branch launched');
});

test('without --spike the argv carries no permission mode', (t) => {
  const { root, run, env } = spikeRun(t);
  const out = spawnSync(process.execPath, [LAUNCH, '--prompts', join(run, 'prompts'), '--workdir', root], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const result = readFileSync(join(run, 'results', 'branch-1.md'), 'utf8');
  assert.match(result, /args=-p --output-format text --model sonnet\s*$/m);
  assert.doesNotMatch(result, /permission-mode|spike:/);
});
