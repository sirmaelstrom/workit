// not-loaded-banner.test.mjs — structural guard (runs in the `node --test` CI job).
//
// The owner's daily setup doesn't load this plugin. Its skills stay here as
// reference, and Observatory's review council still reads
// reference/templates/review-council/, so the repo keeps every file and keeps
// passing its tests. A skill file that reads as live gets designed around by an
// agent that finds it on disk. Every SKILL.md therefore opens its body with
// BANNER, and this guard fails when one doesn't.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // skills/_shared
const SKILLS_DIR = join(HERE, '..');

export const BANNER =
  "> **Reference only.** The owner's daily setup no longer loads this plugin, so this skill doesn't run in their sessions. Read it as reference; don't design around it as a live workflow.";

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** First non-blank line of the body after the front matter, or null. */
export function firstBodyLine(text) {
  const m = text.match(FRONT_MATTER_RE);
  const body = m ? text.slice(m[0].length) : text;
  return body.split(/\r?\n/).find((line) => line.trim() !== '') ?? null;
}

const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => join(SKILLS_DIR, d.name, 'SKILL.md'))
  .filter((p) => existsSync(p));

test('there are skills to check', () => {
  assert.ok(skillFiles.length > 0, `no SKILL.md found under ${SKILLS_DIR}`);
});

test('every SKILL.md body opens with the reference-only banner', () => {
  const missing = skillFiles.filter((p) => firstBodyLine(readFileSync(p, 'utf8')) !== BANNER);
  assert.deepEqual(missing.map((p) => p.slice(SKILLS_DIR.length + 1)), []);
});

test('firstBodyLine skips front matter and blank lines, either line ending', () => {
  assert.equal(firstBodyLine('---\nname: x\n---\n\n> b\n# T\n'), '> b');
  assert.equal(firstBodyLine('---\r\nname: x\r\n---\r\n\r\n> b\r\n'), '> b');
  assert.equal(firstBodyLine('# no front matter\n'), '# no front matter');
});
