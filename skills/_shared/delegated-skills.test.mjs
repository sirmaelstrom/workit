// delegated-skills.test.mjs — structural guard (runs in the `node --test` CI job).
//
// Some skills are schedulers: they decide *which* work happens next and hand the
// work itself to another skill in this plugin. `/chart`'s delegation table maps a
// ticket's `Type:` to the skill that resolves it, and `/chart` names those skills
// as bare identifiers in prose — not as `${CLAUDE_*}` paths — so
// `bundled-refs.test.mjs` cannot see them. Renaming or removing a delegate would
// leave the scheduler pointing at nothing, and the failure would surface at
// runtime in a user's environment as "invoke grill-me" with no grill-me to invoke.
//
// This guard makes that impossible to ship: every delegation target must exist as
// `skills/<name>/SKILL.md` in this repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const PLUGIN_ROOT = join(HERE, '..', '..'); // repo root
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

// The delegation targets named in skills/chart/SKILL.md § Delegation.
// `task` resolves by direct execution and delegates to no skill, so it has no
// entry here.
const DELEGATED = ['grill-me', 'prototype', 'parallel-explore', 'ubiquitous-language'];

test('every delegated skill exists as skills/<name>/SKILL.md', () => {
  const missing = DELEGATED.filter((name) => !existsSync(join(SKILLS_DIR, name, 'SKILL.md')));
  assert.deepEqual(
    missing,
    [],
    `delegation targets with no skill in this repo:\n  ${missing.join('\n  ')}`,
  );
});

// Self-check: the list above is hand-maintained, so it can silently drift out of
// sync with the table it mirrors. Assert each name is actually still named in the
// scheduler — otherwise this guard would keep passing while guarding nothing.
test('guard is non-vacuous (each delegate is still named in chart/SKILL.md)', () => {
  const chart = join(SKILLS_DIR, 'chart', 'SKILL.md');
  assert.ok(existsSync(chart), 'skills/chart/SKILL.md not found');
  const body = readFileSync(chart, 'utf8');
  const unreferenced = DELEGATED.filter((name) => !body.includes(name));
  assert.deepEqual(
    unreferenced,
    [],
    `names in DELEGATED that chart/SKILL.md no longer mentions:\n  ${unreferenced.join('\n  ')}`,
  );
});
