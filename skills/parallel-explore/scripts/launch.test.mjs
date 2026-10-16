import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
