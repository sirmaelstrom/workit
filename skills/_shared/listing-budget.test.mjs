// listing-budget.test.mjs — structural guard (runs in the `node --test` CI job).
//
// A skill's `description` is not just documentation: it is the ENTIRE routing
// surface. Claude Code builds a "skill listing" of `name: description` pairs and
// injects it into the system prompt; the body is loaded only AFTER the model has
// already decided to invoke. If a description is not in the listing, the skill
// cannot fire — and the system prompt tells the model never to use a skill that
// is not listed.
//
// That listing has a budget (a fraction of the context window), and when it
// overflows the harness EVICTS descriptions SILENTLY — degrading a row from
// `- name: description` to a bare `- name`. Eviction is not alphabetical. Claude
// Code scores each skill by recency-weighted usage, roughly
//
//     score = usageCount * max(0.5 ^ (days_since_last_use / 7), 0.1)
//
// and strips the lowest scorers first. A skill with no usage record scores zero.
//
// This closes into a trap, and workit shipped one. Measured 2026-08-10 against
// this box's own ~/.claude.json: `workit:codex-delegate` scored 0.100 — the
// decay floor, DEAD LAST of all 82 tracked skills — while carrying the 3rd
// longest description in the set (505 chars). It cannot earn the usage that
// would protect its description, because it cannot be seen well enough to be
// used. Rewriting the prose of an evicted description accomplishes nothing.
//
// Two consequences this guard enforces:
//
//   1. A long description is not free — it is charged against a shared budget
//      and it starves the skills below it. Every skill pays for its neighbours.
//   2. The budget shrinks with the context window. workit's own listing must fit
//      well inside a SMALL-context session, not just a 1M one, or the set
//      degrades invisibly the moment the operator switches models.
//
// The caps below are workit's self-imposed ceilings, deliberately far under any
// harness limit. They exist so that "we went over" is a failing test rather than
// a skill that quietly stops working. Numbers in the harness rot; the discipline
// does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const PLUGIN_ROOT = join(HERE, '..', '..'); // repo root
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

// Per-skill ceiling. The five-part description grammar (domain / verb / object /
// when / when-NOT) fits comfortably under this. A description that cannot get
// under it is describing more than one skill — decompose instead of compressing.
const MAX_DESCRIPTION_CHARS = 600;

// Whole-set ceiling for workit's contribution to the listing. workit is one
// plugin among many (plus built-in and MCP-provided skills) sharing one budget,
// so it may not spend the whole thing.
const MAX_TOTAL_LISTING_CHARS = 9000;

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Every skills/<id>/SKILL.md, excluding the shared test utilities directory. */
function skillFiles() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared')
    .map((e) => join(SKILLS_DIR, e.name, 'SKILL.md'))
    .filter((p) => existsSync(p));
}

/**
 * Pull `name` and `description` out of a front-matter block. Tolerant on
 * purpose — front-matter.test.mjs owns whether the YAML parses at all; this
 * guard owns how much room it takes up.
 */
export function readListingRow(file) {
  const block = (readFileSync(file, 'utf8').match(FRONT_MATTER_RE) || [])[1] || '';
  const name = ((block.match(/^name:\s*(.+)$/m) || [])[1] || basename(dirname(file))).trim();
  const raw = (block.match(/^description:\s*([\s\S]*?)(?=\r?\n[a-zA-Z-]+:\s|$)/m) || [])[1] || '';
  const description = raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
  // The listing renders one row as `- name: description`.
  return { name, description, cost: name.length + description.length + 2 };
}

test('no single skill description starves the rest of the listing', () => {
  const files = skillFiles();
  assert.ok(files.length > 0, 'no SKILL.md files discovered under skills/ — this guard did not run');

  const over = files
    .map(readListingRow)
    .filter((row) => row.description.length > MAX_DESCRIPTION_CHARS)
    .map((row) => `${row.name}: ${row.description.length} chars (cap ${MAX_DESCRIPTION_CHARS})`);

  assert.deepEqual(
    over,
    [],
    'description(s) over the per-skill cap — every extra character is charged to a shared\n' +
      'budget and pushes the lowest-scoring skills out of the listing entirely:\n  ' +
      over.join('\n  '),
  );
});

test("workit's whole listing fits a small-context session", () => {
  const rows = skillFiles().map(readListingRow);
  assert.ok(rows.length > 0, 'no SKILL.md files discovered — this guard did not run');

  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  const worst = [...rows].sort((a, b) => b.cost - a.cost).slice(0, 3);

  assert.ok(
    total <= MAX_TOTAL_LISTING_CHARS,
    `workit's skill listing costs ${total} chars across ${rows.length} skills, over the ` +
      `${MAX_TOTAL_LISTING_CHARS} cap.\nThe budget scales with the context window, so going ` +
      `over degrades SILENTLY on small-context sessions — lowest-scoring skills lose their ` +
      `descriptions first and simply stop firing.\nBiggest contributors: ` +
      worst.map((r) => `${r.name} (${r.cost})`).join(', '),
  );
});

test('every description states when NOT to use the skill', () => {
  // Failure mode this catches: two skills claiming the same request, so routing
  // becomes a coin flip and the higher-scoring one always wins. Measured
  // instance: codex-delegate and slim-review both advertised "delegate ... to
  // Codex/Terra"; slim-review scored 6.613 to codex-delegate's 0.100, so
  // codex-delegate lost every toss. The boundary clause is what resolves it.
  //
  // Scoped to the skills that spawn or route to another agent, where collision
  // is a live risk rather than a hypothetical.
  const ROUTING_SKILLS = ['codex-delegate', 'slim-review', 'review', 'parallel-explore'];
  // Deliberately narrow. An incidental "instead of" in descriptive prose is not
  // a boundary — the original codex-delegate description contained "instead of
  // absorbing it into the conductor's context" and still collided with
  // slim-review. Only an explicit exclusion, or an explicit hand-off to a named
  // sibling, counts.
  const NEGATIVE = /\b(not for\b|do not use\b|don't use\b|never use\b|use \S+ (?:for|instead)\b)/i;

  const checked = [];
  const missing = [];
  for (const file of skillFiles()) {
    const row = readListingRow(file);
    if (!ROUTING_SKILLS.includes(row.name)) continue;
    checked.push(row.name);
    if (!NEGATIVE.test(row.description)) missing.push(row.name);
  }

  assert.deepEqual(
    checked.sort(),
    [...ROUTING_SKILLS].sort(),
    'a routing skill named in ROUTING_SKILLS was not found — the guard silently checked fewer ' +
      `skills than it claims. Saw: ${checked.join(', ')}`,
  );
  assert.deepEqual(
    missing,
    [],
    'routing skill description(s) with no "when NOT to use" boundary — these collide with ' +
      `sibling skills and lose the toss to whichever scores higher:\n  ${missing.join('\n  ')}`,
  );
});
