// delegated-skills.test.mjs — structural guard (runs in the `node --test` CI job).
//
// Some skills are schedulers: they decide *which* work happens next and hand the
// work itself to another skill in this plugin. `/chart`'s delegation table maps a
// ticket's `Type:` to the skill that resolves it; `/burn-down` hands each queue
// item's claim/closeout to `pickup` and its mid-item exits to `handoff`. Both name
// their delegates as bare identifiers in prose — not as `${CLAUDE_*}` paths — so
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

// scheduler -> the delegates it names in prose.
// chart: the § Delegation table (`task` resolves by direct execution and
// delegates to no skill, so it has no entry). burn-down: the per-item loop hands
// claim/closeout to pickup, and mid-item exits to handoff.
const SCHEDULERS = {
  chart: ['grill-me', 'prototype', 'parallel-explore', 'ubiquitous-language'],
  'burn-down': ['pickup', 'handoff'],
};

test('every delegated skill exists as skills/<name>/SKILL.md', () => {
  const missing = [];
  for (const [scheduler, delegates] of Object.entries(SCHEDULERS)) {
    for (const name of delegates) {
      if (!existsSync(join(SKILLS_DIR, name, 'SKILL.md'))) missing.push(`${scheduler} -> ${name}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `delegation targets with no skill in this repo:\n  ${missing.join('\n  ')}`,
  );
});

// Self-check: the map above is hand-maintained, so it can silently drift out of
// sync with the prose it mirrors. Assert each scheduler exists and still names
// each of its delegates — otherwise this guard would keep passing while guarding
// nothing.
test('guard is non-vacuous (each delegate is still named by its scheduler)', () => {
  const problems = [];
  for (const [scheduler, delegates] of Object.entries(SCHEDULERS)) {
    const file = join(SKILLS_DIR, scheduler, 'SKILL.md');
    if (!existsSync(file)) {
      problems.push(`skills/${scheduler}/SKILL.md not found`);
      continue;
    }
    const body = readFileSync(file, 'utf8');
    for (const name of delegates) {
      if (!body.includes(name)) problems.push(`${scheduler}/SKILL.md no longer mentions "${name}"`);
    }
  }
  assert.deepEqual(problems, [], `delegation map has drifted:\n  ${problems.join('\n  ')}`);
});
