// front-matter.test.mjs — structural guard (runs in the `node --test` CI job).
//
// A SKILL.md's YAML front matter is what the harness reads to build the
// model-invocable skill listing. When it fails to parse, the harness drops the
// skill SILENTLY: no warning, no error, the skill simply never appears in the
// listing and nothing says why.
//
// `/pickup` shipped that way and stayed broken for weeks. Its description was
// the only unquoted one in the set and it contained
//
//     Optional arg: a quest short-id or project name
//
// A bare `": "` inside a plain (unquoted) YAML scalar is a parse error, not a
// string — YAML reads it as a nested mapping. js-yaml: "bad indentation of a
// mapping entry (2:348)", col 348 being that exact colon. The skill was invisible
// to every model-facing listing; the front matter carried nothing that looked
// wrong to a reader.
//
// This guard makes that class impossible to ship. It deliberately does NOT
// implement YAML — the plugin has no dependencies and CI runs bare `node --test`.
// It rejects the constructs that make a plain scalar ambiguous, which is the only
// breakage hand-written front matter realistically hits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const PLUGIN_ROOT = join(HERE, '..', '..'); // repo root
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

// Tolerates both line endings: the working tree is CRLF on Windows, LF on the
// Linux runner. Nothing here may depend on which one it got.
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Scan one front-matter block for the constructs that break a YAML parse.
 * Returns { keys, problems } — `problems` empty means the block is safe.
 */
export function scanFrontMatter(block) {
  const problems = [];
  const keys = [];

  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = `line ${i + 1}`;

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Indented lines belong to a block scalar / nested mapping / sequence whose
    // parent we already vetted. Out of scope on purpose.
    if (/^[ \t]/.test(line)) continue;

    const m = line.match(/^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/);
    if (!m) {
      problems.push(`${at}: not a top-level "key: value" entry -> ${JSON.stringify(line)}`);
      continue;
    }

    const key = m[1];
    const value = (m[2] ?? '').trim();
    keys.push(key);
    if (value === '') continue; // value lives on the indented lines below

    const lead = value[0];

    // Quoted: safe, provided the quote actually closes on this line.
    if (lead === '"' || lead === "'") {
      if (value.length < 2 || value[value.length - 1] !== lead) {
        problems.push(`${at}: ${key} opens with ${lead} but does not close on the same line`);
      }
      continue;
    }

    // Block scalar, flow collection, anchor/alias: not a plain scalar.
    if ('|>[{&*'.includes(lead)) continue;

    // Plain scalar — the hazardous case.
    const colon = value.indexOf(': ');
    if (colon !== -1) {
      problems.push(
        `${at}: ${key} is unquoted and contains ": " at col ${key.length + 2 + colon + 1} ` +
          `(...${value.slice(Math.max(0, colon - 12), colon + 14)}...) — YAML reads that as a ` +
          `nested mapping and the whole file fails to parse. Wrap the value in double quotes.`,
      );
    }
    if (value.endsWith(':')) {
      problems.push(`${at}: ${key} is unquoted and ends with ":" — wrap the value in double quotes.`);
    }
    if (value.includes(' #')) {
      problems.push(
        `${at}: ${key} is unquoted and contains " #" — YAML starts a comment there, silently ` +
          `truncating the value. Wrap the value in double quotes.`,
      );
    }
  }

  return { keys, problems };
}

function findSkillFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findSkillFiles(p));
    else if (ent.name === 'SKILL.md') out.push(p);
  }
  return out;
}

const skillFiles = findSkillFiles(SKILLS_DIR);

test('every SKILL.md front matter is unambiguous YAML', () => {
  const failures = [];
  for (const file of skillFiles) {
    const rel = file.slice(PLUGIN_ROOT.length + 1);
    const block = readFileSync(file, 'utf8').match(FRONT_MATTER_RE)?.[1];
    if (block === undefined) {
      failures.push(`${rel}: no --- front matter block at the top of the file`);
      continue;
    }
    for (const p of scanFrontMatter(block).problems) failures.push(`${rel}: ${p}`);
  }
  assert.deepEqual(failures, [], `SKILL.md front matter that will not parse:\n  ${failures.join('\n  ')}`);
});

test('every SKILL.md declares name + description, and name matches its directory', () => {
  const failures = [];
  for (const file of skillFiles) {
    const rel = file.slice(PLUGIN_ROOT.length + 1);
    const block = readFileSync(file, 'utf8').match(FRONT_MATTER_RE)?.[1];
    if (block === undefined) continue; // already reported by the test above

    const { keys } = scanFrontMatter(block);
    for (const required of ['name', 'description']) {
      if (!keys.includes(required)) failures.push(`${rel}: front matter has no "${required}"`);
    }

    // The value is read back with a tolerant regex on purpose: this test asserts
    // identity, and the test above owns whether the syntax was safe.
    const declared = block.match(/^name:[ \t]+["']?(.*?)["']?[ \t]*$/m)?.[1];
    const dir = basename(dirname(file));
    if (declared !== undefined && declared !== dir) {
      failures.push(`${rel}: declares name "${declared}" but lives in skills/${dir}/`);
    }
  }
  assert.deepEqual(failures, [], `SKILL.md identity problems:\n  ${failures.join('\n  ')}`);
});

// Self-checks: a scanner that stopped scanning, or one that no longer recognises
// the defect it was built for, would keep passing while guarding nothing.
test('guard is non-vacuous (skills discovered, and the historical defect is still caught)', () => {
  assert.ok(skillFiles.length > 0, 'no SKILL.md files discovered under skills/');
  assert.ok(existsSync(join(SKILLS_DIR, 'pickup', 'SKILL.md')), 'skills/pickup/SKILL.md not found');

  // Verbatim shape of the /pickup defect this guard exists to prevent.
  const broken = 'name: pickup\ndescription: Resume the quest. Optional arg: a quest short-id.';
  assert.equal(scanFrontMatter(broken).problems.length, 1, 'scanner no longer flags the /pickup defect');

  // ...and the fixed shape must pass, or the guard is just noise.
  const fixed = 'name: pickup\ndescription: "Resume the quest. Optional arg: a quest short-id."';
  assert.deepEqual(scanFrontMatter(fixed).problems, [], 'scanner flags the correctly-quoted form');
});

test('scanner catches the other plain-scalar hazards', () => {
  assert.equal(scanFrontMatter('description: trailing colon:').problems.length, 1, 'trailing ":" not caught');
  assert.equal(scanFrontMatter('description: a value # not a comment').problems.length, 1, '" #" not caught');
  assert.equal(scanFrontMatter('description: "quoted: fine"').problems.length, 0, 'quoted value wrongly flagged');
  assert.equal(scanFrontMatter("description: 'quoted: fine'").problems.length, 0, 'single-quoted value wrongly flagged');
  assert.equal(scanFrontMatter('allowed-tools:\n  - Read\n  - Bash').problems.length, 0, 'nested sequence wrongly flagged');
  assert.equal(scanFrontMatter('description: >\n  folded: fine').problems.length, 0, 'block scalar wrongly flagged');
  assert.equal(scanFrontMatter('description: plain and safe').problems.length, 0, 'safe plain scalar wrongly flagged');
});
