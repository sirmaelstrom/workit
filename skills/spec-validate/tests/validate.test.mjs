// validate.test.mjs — regression guard for spec-validate (runs in `node --test`).
//
// The plugin's headline feature is the spec pipeline, so the validator must
// accept a spec authored by faithfully following the /spec skill + pattern
// library — without the author having to reverse-engineer the validator's regex.
//
// Two fixtures pin that contract:
//   fixtures/canonical-spec  — a complete spec authored "by the book" using the
//                              NATURAL markdown forms. Must validate 0 errors AND
//                              0 warnings. If a future validator tweak rejects a
//                              by-the-book form, this goes red.
//   fixtures/broken-spec     — a deliberately broken spec. Must still report the
//                              specific errors/warnings the relaxed checks cover,
//                              so a relaxation can't silently go vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(__dirname, '..', 'scripts', 'validate.mjs');
const fixturesDir = join(__dirname, 'fixtures');
const CANONICAL = join(fixturesDir, 'canonical-spec');
const BROKEN = join(fixturesDir, 'broken-spec');

function runValidator(fixturePath) {
  try {
    const stdout = execFileSync('node', [VALIDATOR, fixturePath], { encoding: 'utf8' });
    return { status: 0, out: stripAnsi(stdout) };
  } catch (e) {
    return { status: e.status ?? 1, out: stripAnsi(`${e.stdout ?? ''}${e.stderr ?? ''}`) };
  }
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function read(...parts) {
  return readFileSync(join(...parts), 'utf8');
}

// ---------------------------------------------------------------------------
// Canonical spec: a by-the-book spec must validate clean.
// ---------------------------------------------------------------------------

test('canonical fixture validates with exit 0', () => {
  const { status } = runValidator(CANONICAL);
  assert.equal(status, 0, 'by-the-book spec must exit 0 (no errors)');
});

test('canonical fixture validates with 0 errors and 0 warnings', () => {
  const { out } = runValidator(CANONICAL);
  assert.match(out, /0 errors, 0 warnings/, `expected a clean report, got:\n${out}`);
});

// Non-vacuity: the canonical fixture must actually exercise the relaxed forms,
// so "conforming" it to validator-only conventions can't quietly pass this test.

test('canonical fixture uses the colon-inside WP field form (**Field:**)', () => {
  const wp = read(CANONICAL, 'work-packages', 'wp-01-retry-loop.md');
  for (const field of ['Precondition', 'Goal', 'Files', 'Verification', 'Failure Criteria', 'Boundary']) {
    assert.ok(wp.includes(`**${field}:**`), `WP should use the natural **${field}:** form`);
  }
});

test('canonical fixture uses bare constraint headers + bullet IDs', () => {
  const c = read(CANONICAL, 'constraints.md');
  // Bare category headers with no descriptive suffix (the form fix #2 accepts).
  assert.match(c, /^##\s+Musts \(M\)\s*$/m, 'expected a bare "## Musts (M)" header');
  assert.match(c, /^##\s+Must-Nots \(MN\)\s*$/m, 'expected a bare "## Must-Nots (MN)" header');
  // Bullet-form numbered IDs (the form fix #3 accepts) — not "### M1" headers.
  assert.match(c, /^- \*\*M1 —/m, 'expected a bullet-form "- **M1 —" constraint');
  assert.match(c, /^- \*\*MN1 —/m, 'expected a bullet-form "- **MN1 —" constraint');
  assert.ok(!/^###\s+M\d+/m.test(c), 'fixture should NOT rely on "### M1" headers');
});

test('canonical fixture lists decomposition units in a table (not ### WP-N)', () => {
  const d = read(CANONICAL, 'decomposition.md');
  assert.match(d, /^\|\s*WP-01\s*\|/m, 'expected a "| WP-01 |" table row');
  assert.ok(!/^###\s+WP-?\d+/mi.test(d), 'fixture should NOT rely on "### WP-N" headers');
});

test('canonical fixture uses the layered verification model, not flat type', () => {
  const v = read(CANONICAL, 'verification.md');
  assert.match(v, /\*\*Layers:\*\*/, 'expected the **Layers:** layered model');
  assert.ok(!/\*\*Verification type/i.test(v), 'fixture should NOT use the legacy **Verification type** label');
});

// ---------------------------------------------------------------------------
// Broken spec: the relaxed checks must still catch real problems.
// ---------------------------------------------------------------------------

test('broken fixture exits non-zero (errors present)', () => {
  const { status } = runValidator(BROKEN);
  assert.equal(status, 1, 'a spec with a missing required field must exit 1');
});

test('broken fixture still flags a missing WP required field', () => {
  const { out } = runValidator(BROKEN);
  assert.match(out, /Missing \d+ required field\(s\): .*Boundary/, 'WP field check must still fire');
});

test('broken fixture still flags missing verification strength', () => {
  const { out } = runValidator(BROKEN);
  assert.match(out, /No verification strength indicated/, 'verification strength check must still fire when neither layers nor type present');
});

test('broken fixture still flags missing constraint categories', () => {
  const { out } = runValidator(BROKEN);
  assert.match(out, /Missing "Must-Nots" category/, 'category detection must still report absent categories');
  assert.match(out, /Missing "Escalation Triggers" category/);
});
