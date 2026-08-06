// output-rooting.test.mjs — structural guard (runs in the `node --test` CI job).
//
// Skills write artifacts to `{workspace}/data/outputs/{category}/…`, where
// `{workspace}` is the workspace root. The anti-pattern is a bare `./outputs/…`:
// it reads as a convention but resolves to wherever the agent happened to be
// standing — the same ambient-cwd failure that worktree-rooting kills on the
// input side, one direction later.
//
// It went unnoticed for a long time because on the author's box an ambient
// workspace instruction quietly redirected `./outputs/` to the right place. A
// marketplace installer, with no such instruction, got an `outputs/` directory
// created inside whatever repo they happened to be in. Same skill, different
// behavior, nothing documented.
//
// Two things this pins:
//   1. No skill or pattern doc INSTRUCTS a bare `./outputs/` path.
//   2. `{workspace}` is actually defined somewhere — a token used by six skills
//      and defined nowhere is worse than the bare path it replaced, because it
//      looks deliberate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const PLUGIN_ROOT = join(HERE, '..', '..'); // repo root
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const PATTERNS_DIR = join(PLUGIN_ROOT, 'reference', 'patterns');
const PATTERN_DOC = join(PATTERNS_DIR, 'worktree-rooting.md');

const BARE_OUTPUTS = /\.\/outputs\//;

// A line may NAME the anti-pattern in order to forbid it. Those lines are the
// documentation working as intended, so they are not violations. Keep this list
// tight: it is the guard's only escape hatch.
const PROHIBITION = /\b(never|not a|rather than|instead of|anti-pattern|drifting back|replaces)\b/i;

function isViolation(line) {
  return BARE_OUTPUTS.test(line) && !PROHIBITION.test(line);
}

function collect(dir, predicate) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collect(p, predicate));
    else if (predicate(p)) out.push(p);
  }
  return out;
}

// Tests and fixtures are excluded: fixtures pin historical JSON payloads whose
// stored strings are data rather than instructions, and a test file naming the
// anti-pattern (this one does, repeatedly) is documentation, not a violation.
const isTestFile = (p) => p.endsWith('.test.mjs') || /[\\/]tests[\\/]/.test(p);
const scanned = [
  ...collect(SKILLS_DIR, (p) => (p.endsWith('.md') || p.endsWith('.mjs')) && !isTestFile(p)),
  ...(existsSync(PATTERNS_DIR) ? collect(PATTERNS_DIR, (p) => p.endsWith('.md')) : []),
];

test('no skill or pattern doc instructs a bare ./outputs/ path', () => {
  const violations = [];
  for (const file of scanned) {
    const rel = file.slice(PLUGIN_ROOT.length + 1);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isViolation(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    violations,
    [],
    'bare ./outputs/ paths resolve against the agent\'s cwd, not the workspace root. ' +
      `Use {workspace}/data/outputs/…:\n  ${violations.join('\n  ')}`,
  );
});

test('{workspace} is defined in the rooting pattern doc', () => {
  assert.ok(existsSync(PATTERN_DOC), 'reference/patterns/worktree-rooting.md not found');
  const body = readFileSync(PATTERN_DOC, 'utf8');
  assert.match(body, /Output Rooting/, 'the pattern doc must carry an output-rooting section');
  assert.match(
    body,
    /\{workspace\}[`*\s]+is the workspace root/,
    'the doc must state what {workspace} resolves to — six skills use the token',
  );
  assert.match(body, /WORKIT_WORKSPACE_ROOT/, 'the env var that resolves it must be named');
});

// Self-checks: a guard that stopped scanning, or one whose escape hatch swallowed
// real violations, would keep passing while guarding nothing.
test('guard is non-vacuous (files scanned, and both verdicts still work)', () => {
  assert.ok(scanned.length > 0, 'no skill/pattern files discovered');

  // Every skill that writes artifacts must be using the rooted form somewhere,
  // or the sweep silently regressed to "nobody mentions outputs at all".
  const rootedMentions = scanned.filter((f) =>
    readFileSync(f, 'utf8').includes('{workspace}/data/outputs/'),
  );
  assert.ok(rootedMentions.length >= 4, `expected several rooted output paths, found ${rootedMentions.length}`);

  assert.ok(isViolation('Save it to ./outputs/handoffs/x.md'), 'a plain instruction must be caught');
  assert.ok(!isViolation('never a cwd-relative `./outputs/`'), 'a prohibition must not be caught');
  assert.ok(!isViolation('Save to {workspace}/data/outputs/handoffs/x.md'), 'the rooted form must pass');
});
