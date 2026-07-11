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

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(__dirname, '..', 'scripts', 'validate.mjs');
const fixturesDir = join(__dirname, 'fixtures');
const CANONICAL = join(fixturesDir, 'canonical-spec');
const BROKEN = join(fixturesDir, 'broken-spec');

function runValidator(fixturePath, { args = [], env } = {}) {
  const options = { encoding: 'utf8' };
  if (env) options.env = { ...process.env, ...env };
  try {
    const stdout = execFileSync('node', [VALIDATOR, fixturePath, ...args], options);
    return { status: 0, out: stripAnsi(stdout) };
  } catch (e) {
    return { status: e.status ?? 1, out: stripAnsi(`${e.stdout ?? ''}${e.stderr ?? ''}`) };
  }
}

// NO_ROOT strips an inherited WORKIT_WORKSPACE_ROOT so temp-fixture tests that
// assume "no root provided" stay deterministic on machines that export it.
// (An empty env value is treated as unset by the validator.)
const NO_ROOT = { WORKIT_WORKSPACE_ROOT: '' };

// --- temp-fixture helpers for the target-enforcement tests ------------------

const tempDirs = [];
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

function makeTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Minimal workshop: clean except for what the caller injects. */
function makeWorkshop({ projects, orchestrator } = {}) {
  const dir = makeTemp('spec-validate-ws-');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    title: 'Temp target-enforcement fixture',
    slug: basename(dir),
    status: 'captured',
    projects,
    startedAt: '2026-07-11T00:00:00Z',
    createdAt: '2026-07-11T00:00:00Z',
  }, null, 2));
  if (orchestrator !== undefined) {
    mkdirSync(join(dir, 'work-packages'));
    writeFileSync(join(dir, 'work-packages', '_orchestrator.md'), orchestrator);
  }
  return dir;
}

/** Minimal orchestrator with a parameterized Package Inventory table. */
function orchestratorWithInventory(rows) {
  const rowLines = rows.map(r => `| ${r.package} | 1 | ${r.project} | [wp.md](wp.md) | - |`).join('\n');
  return [
    '# Orchestrator — temp fixture',
    '',
    '## Wave Plan',
    '',
    'Wave 1: everything',
    '',
    '## Gate Commands',
    '',
    'Wave 1: npm test',
    '',
    '## Package Inventory',
    '',
    '| Package | Wave | Project | Spec | Model |',
    '|---------|------|---------|------|-------|',
    rowLines,
    '',
    '## Spec-Level Constraints',
    '',
    'Musts: minimal fixture.',
    '',
  ].join('\n');
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

// ---------------------------------------------------------------------------
// Target enforcement: declared projects, disk resolution, inventory cross-check.
// ---------------------------------------------------------------------------

test('canonical no-root invocation emits no workspace/disk-check output (pin guard)', () => {
  const { out } = runValidator(CANONICAL);
  assert.match(out, /0 errors, 0 warnings/, 'the no-root pin must stay 0/0');
  assert.ok(!/workspace-root/i.test(out), 'no root provided → the disk check must be silent, not even a warning');
});

test('empty projects array is an error (broken fixture)', () => {
  const { status, out } = runValidator(BROKEN);
  assert.equal(status, 1);
  assert.match(out, /Missing or empty "projects"/, 'empty meta.projects must be an error, not a warning');
});

test('inventory project not in meta.projects is an error (broken fixture)', () => {
  const { out } = runValidator(BROKEN);
  assert.match(out, /targets project "example-service" which is not declared in meta\.projects/, 'inventory cross-check must fire');
});

test('disk resolution: project missing under workspace root is an error (CLI flag)', () => {
  const wsRoot = makeTemp('spec-validate-root-');
  mkdirSync(join(wsRoot, 'projects', 'good-service'), { recursive: true });
  const workshop = makeWorkshop({ projects: ['missing-service'] });
  const { status, out } = runValidator(workshop, { args: ['--workspace-root', wsRoot] });
  assert.equal(status, 1);
  assert.match(out, /Project "missing-service" does not resolve to a directory/, 'disk check must fire when a root is provided');
});

test('disk resolution: project present under workspace root passes', () => {
  const wsRoot = makeTemp('spec-validate-root-');
  mkdirSync(join(wsRoot, 'projects', 'good-service'), { recursive: true });
  const workshop = makeWorkshop({ projects: ['good-service'] });
  const { status, out } = runValidator(workshop, { args: ['--workspace-root', wsRoot] });
  assert.equal(status, 0, `expected clean run, got:\n${out}`);
});

test('disk resolution: WORKIT_WORKSPACE_ROOT env var also triggers the check', () => {
  const wsRoot = makeTemp('spec-validate-root-');
  mkdirSync(join(wsRoot, 'projects'), { recursive: true });
  const workshop = makeWorkshop({ projects: ['missing-service'] });
  const { status, out } = runValidator(workshop, { env: { WORKIT_WORKSPACE_ROOT: wsRoot } });
  assert.equal(status, 1);
  assert.match(out, /Project "missing-service" does not resolve to a directory/);
});

test('no root provided: disk check is skipped silently for an unresolvable project', () => {
  const workshop = makeWorkshop({ projects: ['missing-service'] });
  const { status, out } = runValidator(workshop, { env: NO_ROOT });
  assert.equal(status, 0, `no root → no disk check → clean, got:\n${out}`);
  assert.ok(!/workspace/i.test(out), 'must not even warn about the skipped check');
});

test('relative --workspace-root is rejected, naming the flag', () => {
  const workshop = makeWorkshop({ projects: ['anything'] });
  const { status, out } = runValidator(workshop, { args: ['--workspace-root', 'relative/path'] });
  assert.equal(status, 1);
  assert.match(out, /--workspace-root must be an absolute path/, 'a relative root must be rejected, never cwd-resolved');
});

test('nonexistent --workspace-root is rejected as an invalid root', () => {
  const wsRoot = makeTemp('spec-validate-root-');
  const missingRoot = join(wsRoot, 'nope');
  const workshop = makeWorkshop({ projects: ['anything'] });
  const { status, out } = runValidator(workshop, { args: ['--workspace-root', missingRoot] });
  assert.equal(status, 1);
  assert.match(out, /does not exist or is not a directory/, 'an invalid root is its own error, distinct from project resolution');
});

test('invalid project names are rejected before disk resolution', () => {
  const workshop = makeWorkshop({ projects: ['../evil', 'bad/name', ' padded '] });
  const { status, out } = runValidator(workshop, { env: NO_ROOT });
  assert.equal(status, 1);
  assert.match(out, /Invalid project name "\.\.\/evil"/);
  assert.match(out, /Invalid project name "bad\/name"/);
  assert.match(out, /Invalid project name " padded "/);
});

test('inventory cross-check flags an undeclared project, naming the WP', () => {
  const workshop = makeWorkshop({
    projects: ['svc-a'],
    orchestrator: orchestratorWithInventory([{ package: 'WP-01: Something', project: 'svc-b' }]),
  });
  const { status, out } = runValidator(workshop, { env: NO_ROOT });
  assert.equal(status, 1);
  assert.match(out, /Package "WP-01: Something" targets project "svc-b" which is not declared/);
});

test('inventory cross-check skips blank and literal "-" Project cells', () => {
  const workshop = makeWorkshop({
    projects: ['svc-a'],
    orchestrator: orchestratorWithInventory([
      { package: 'WP-01: Targeted', project: 'svc-a' },
      { package: 'WP-02: No target yet', project: '-' },
    ]),
  });
  const { status, out } = runValidator(workshop, { env: NO_ROOT });
  assert.equal(status, 0, `a "-" Project cell is not an error at this stage, got:\n${out}`);
});

test('work-packages present but no inventory table is an error (distinct from missing file)', () => {
  const orch = [
    '# Orchestrator — no table',
    '',
    '## Wave Plan',
    '',
    'Wave 1: everything',
    '',
    '## Gate Commands',
    '',
    'Wave 1: npm test',
    '',
    '## Package Inventory',
    '',
    'Table coming soon. Musts: none.',
    '',
  ].join('\n');
  const workshop = makeWorkshop({ projects: ['svc-a'], orchestrator: orch });
  const { status, out } = runValidator(workshop, { env: NO_ROOT });
  assert.equal(status, 1);
  assert.match(out, /Missing inventory table/, 'a present-but-tableless orchestrator must error');
});

test('lite spec with multiple projects warns (not errors)', () => {
  const workshop = makeWorkshop({ projects: ['svc-a', 'svc-b'] });
  const { status, out } = runValidator(workshop, { env: NO_ROOT });
  assert.equal(status, 0, `multi-project lite spec must remain exit 0, got:\n${out}`);
  assert.match(out, /multi-repo usually wants a deep spec/, 'the lite-spec nudge must be a warning');
});
