// bundled-refs.test.mjs — structural guard (runs in the `node --test` CI job).
//
// Every `${CLAUDE_SKILL_DIR}/…` and `${CLAUDE_PLUGIN_ROOT}/…` reference in a
// SKILL.md body must resolve to a file or directory that actually exists in the
// repo. The harness substitutes those variables with absolute paths at skill
// load, so a ref to a missing bundled asset fails silently at runtime in a
// user's environment. This guard makes that impossible to ship: if a skill
// points at a bundled script/reference/template that isn't there, CI goes red.
//
// Scope is deliberately the `${CLAUDE_*}` refs only — those are the
// plugin-resolved, drift-prone paths. Bare relative names in prose (e.g. a
// skill describing `scripts/foo.mjs`, or runtime-generated workshop artifacts
// like `meta.json`) are intentionally NOT checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const PLUGIN_ROOT = join(HERE, '..', '..'); // repo root
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

// Matches `${CLAUDE_SKILL_DIR}/...` or `${CLAUDE_PLUGIN_ROOT}/...` up to the
// first character that can't be part of a path (quote, backtick, space, …).
const REF_RE = /\$\{CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT)\}\/[\w.\/-]+/g;

function findSkillFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findSkillFiles(p));
    else if (ent.name === 'SKILL.md') out.push(p);
  }
  return out;
}

function resolveRef(ref, skillDir) {
  const abs = ref
    .replace('${CLAUDE_SKILL_DIR}', skillDir)
    .replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
  return abs.replace(/\/{2,}/g, '/'); // collapse any incidental double slashes
}

const skillFiles = findSkillFiles(SKILLS_DIR);

test('every ${CLAUDE_*} bundled-asset ref in a SKILL.md resolves to a real path', () => {
  const missing = [];
  for (const file of skillFiles) {
    const skillDir = dirname(file);
    const refs = new Set(readFileSync(file, 'utf8').match(REF_RE) ?? []);
    for (const ref of refs) {
      const resolved = resolveRef(ref, skillDir);
      if (!existsSync(resolved)) {
        missing.push(`${file.slice(PLUGIN_ROOT.length + 1)}: ${ref}  ->  ${resolved}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `SKILL.md references to bundled assets that do NOT exist:\n  ${missing.join('\n  ')}`,
  );
});

// Self-check: the guard must actually be scanning something, or it would pass
// vacuously if discovery or the regex ever broke.
test('guard is non-vacuous (found SKILL.md files and at least one ref)', () => {
  assert.ok(skillFiles.length > 0, 'no SKILL.md files discovered under skills/');
  const totalRefs = skillFiles.reduce(
    (n, f) => n + (readFileSync(f, 'utf8').match(REF_RE)?.length ?? 0),
    0,
  );
  assert.ok(totalRefs > 0, 'no ${CLAUDE_*} refs matched across SKILL.md files');
});
