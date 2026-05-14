import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

test('review-gate-example.json has every required top-level field', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-example.json'), 'utf8'));
  const required = ['schema_version', 'run_slug', 'created_at', 'spec',
    'review_level', 'review_level_reason', 'summary', 'flagged_items', 'compile_template'];
  for (const k of required) assert.ok(k in f, `missing field: ${k}`);
  assert.equal(f.schema_version, '1.0');
});

test('review-gate-example.json contains both DECISION and ASSUMPTION items', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-example.json'), 'utf8'));
  const kinds = new Set(f.flagged_items.map(it => it.kind));
  assert.ok(kinds.has('DECISION'));
  assert.ok(kinds.has('ASSUMPTION'));
});

test('review-gate-example.json contains at least 5 flagged items', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-example.json'), 'utf8'));
  assert.ok(f.flagged_items.length >= 5, `expected >=5 items, got ${f.flagged_items.length}`);
});

test('review-gate-example.json mixes default_action presence', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-example.json'), 'utf8'));
  const withDefault = f.flagged_items.filter(it => it.default_action != null);
  const withoutDefault = f.flagged_items.filter(it => it.default_action == null);
  assert.ok(withDefault.length >= 1, 'expected at least one item with default_action');
  assert.ok(withoutDefault.length >= 1, 'expected at least one item without default_action');
});

test('review-gate-example.json: compile_template contains every documented token', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-example.json'), 'utf8'));
  const required = ['{decisions_blob}', '{general_feedback}', '{spec_slug}', '{spec_title}', '{review_level}'];
  for (const tok of required) {
    assert.ok(f.compile_template.includes(tok), `compile_template missing token: ${tok}`);
  }
});

test('review-gate-example.json: every flagged_item id is unique', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-example.json'), 'utf8'));
  const seen = new Set();
  for (const it of f.flagged_items) {
    assert.ok(!seen.has(it.id), `duplicate id: ${it.id}`);
    seen.add(it.id);
  }
});

test('review-gate-malformed.json parses but has duplicate flagged_items ids', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'review-gate-malformed.json'), 'utf8'));
  const ids = f.flagged_items.map(it => it.id);
  const set = new Set(ids);
  assert.ok(set.size < ids.length, 'expected duplicate ids in the malformed fixture');
});

test('review-gate-schema.md documents key validation rules', () => {
  const doc = readFileSync(join(fixturesDir, 'review-gate-schema.md'), 'utf8');
  assert.match(doc, /schema_version/i);
  assert.match(doc, /flagged_items/i);
  assert.match(doc, /compile_template/i);
  assert.match(doc, /decisions_blob/);
  assert.match(doc, /DECISION/);
  assert.match(doc, /ASSUMPTION/);
});
