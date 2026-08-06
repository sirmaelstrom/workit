// environment-derivation.test.mjs — structural guard (runs in the `node --test` CI job).
//
// The contract this pins: environment state is DERIVED at pickup, never carried
// in a handoff. Three skills have to agree for that to hold, and they are edited
// at different times by different sessions:
//
//   pickup    — runs the preamble script before reading anything that describes
//               the world
//   handoff   — offers a mid-item mode that routes each non-nuance cargo class
//               to its real home instead of inlining it
//   burn-down — delegates its mid-item exit to that mode rather than restating it
//
// Drop any one and the system silently reverts to written-down environment
// state: still plausible-looking, still stale, and now with no reader who knows
// to distrust it. `bundled-refs.test.mjs` proves the script path resolves; this
// proves the skills still USE it and still say where each cargo class goes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const PLUGIN_ROOT = join(HERE, '..', '..'); // repo root
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

const PREAMBLE_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'workspace-preamble.mjs');
const SCRIPT_REF = '${CLAUDE_PLUGIN_ROOT}/scripts/workspace-preamble.mjs';

const read = (skill) => readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');

test('the preamble script exists and is the thing the skills point at', () => {
  assert.ok(existsSync(PREAMBLE_SCRIPT), 'scripts/workspace-preamble.mjs not found');

  const body = readFileSync(PREAMBLE_SCRIPT, 'utf8');
  // The two exit codes are the script's contract with its callers: a report, or
  // an explicit "did not run". If the vacuous case ever silently became exit 0,
  // an empty scan would read as a clean workspace.
  assert.match(body, /process\.exit\(2\)/, 'the scanned-nothing case must exit non-zero');
  assert.match(body, /WORKIT_WORKSPACE_ROOT/, 'must honour the workspace-root env var');
});

test('pickup derives the environment before trusting any note', () => {
  const body = read('pickup');
  assert.ok(body.includes(SCRIPT_REF), `pickup must invoke ${SCRIPT_REF}`);

  // Per-pickup, not per-session: the whole point is that a long run's third item
  // has a different environment than its first.
  assert.match(body, /per pickup/i, 'pickup must say the preamble is run per pickup');
});

test('handoff offers a mid-item mode and routes every cargo class to its home', () => {
  const body = read('handoff');

  assert.match(body, /mid-item/i, 'handoff must document a mid-item mode');
  assert.ok(body.includes(SCRIPT_REF), 'mid-item mode must point environment state at the script');

  // Each class the retro identified as NOT handoff cargo must still name a
  // destination. Dropping a row is how this silently regresses: the class stops
  // having a stated home and drifts back into the document.
  const homes = [
    [/pending externals/i, /receipt/i, 'pending externals -> receipts'],
    [/cross-item bindings/i, /resume note/i, 'cross-item bindings -> resume note'],
    [/conventions/i, /burn-down|protocol text/i, 'conventions -> protocol text'],
    [/environment state/i, /pickup|derive/i, 'environment state -> derived at pickup'],
  ];
  const missing = [];
  for (const [cargo, home, label] of homes) {
    if (!cargo.test(body) || !home.test(body)) missing.push(label);
  }
  assert.deepEqual(missing, [], `handoff no longer states a home for:\n  ${missing.join('\n  ')}`);

  // The PR-boundary case is "write nothing at all" — the rule that keeps the
  // slim mode from becoming a habit applied everywhere.
  assert.match(body, /PR boundary/i, 'handoff must name the write-nothing case');
});

test('burn-down delegates its mid-item exit instead of restating the template', () => {
  const body = read('burn-down');
  assert.match(body, /mid-item mode/i, 'burn-down must route to handoff\'s mid-item mode');
  assert.match(body, /derived at pickup/i, 'burn-down must keep the derive-not-transfer rule');

  // burn-down's own rule is "write conventions once; do not re-transmit". It
  // should not carry a second copy of the handoff template.
  assert.doesNotMatch(body, /## Where I stopped/, 'burn-down must not inline the handoff template');
});

// Self-checks: these assertions read files by name, so a rename or a bad path
// would make every test above pass vacuously against empty strings.
test('guard is non-vacuous (all three skills were read and are substantial)', () => {
  for (const skill of ['pickup', 'handoff', 'burn-down']) {
    const file = join(SKILLS_DIR, skill, 'SKILL.md');
    assert.ok(existsSync(file), `skills/${skill}/SKILL.md not found`);
    assert.ok(read(skill).length > 500, `skills/${skill}/SKILL.md is implausibly short`);
  }

  // And the discriminating check actually discriminates: a body with no script
  // ref must fail the test that demands one.
  assert.ok(!''.includes(SCRIPT_REF), 'an empty body must not satisfy the script-ref check');
});
