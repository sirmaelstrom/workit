import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

test('scorecard-example.json has every required top-level field', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const required = ['schema_version', 'run_slug', 'created_at', 'plugins',
    'summary', 'dimensions', 'skills', 'top_actions'];
  for (const k of required) assert.ok(k in f, `missing field: ${k}`);
  assert.equal(f.schema_version, '1.0');
});

test('scorecard-example.json covers all three dimension kinds', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const kinds = new Set(f.dimensions.map(d => d.kind));
  for (const k of ['likert5', 'eval_coverage', 'karpathy']) {
    assert.ok(kinds.has(k), `dimensions must include kind=${k}`);
  }
});

test('scorecard-example.json covers all three confidence bands', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const confidences = new Set();
  for (const s of f.skills) {
    for (const so of Object.values(s.scores)) confidences.add(so.confidence);
  }
  for (const c of ['high', 'medium', 'low']) {
    assert.ok(confidences.has(c), `expected confidence band: ${c}`);
  }
});

test('scorecard-example.json contains at least one karpathy_eligible skill', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const eligibleCount = f.skills.filter(s => s.karpathy_eligible === 1).length;
  assert.ok(eligibleCount >= 1, 'expected at least one eligible skill');
  assert.equal(eligibleCount, f.summary.karpathy_eligible_count,
    'summary.karpathy_eligible_count must match skills with karpathy_eligible=1');
});

test('scorecard-example.json: every skill has a score for every dimension', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const dimIds = new Set(f.dimensions.map(d => d.id));
  for (const s of f.skills) {
    for (const id of dimIds) {
      assert.ok(id in s.scores, `skill ${s.id} missing score for ${id}`);
    }
    const extras = Object.keys(s.scores).filter(k => !dimIds.has(k));
    assert.equal(extras.length, 0, `skill ${s.id} has unknown score keys: ${extras.join(',')}`);
  }
});

test('scorecard-example.json: top_actions reference real skills', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const skillIds = new Set(f.skills.map(s => s.id));
  for (const a of f.top_actions) {
    assert.ok(skillIds.has(a.skill_id), `top_action references unknown skill: ${a.skill_id}`);
  }
});

test('scorecard-example.json: summary.highest_roi_skill_id matches rank=1 skill', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-example.json'), 'utf8'));
  const rank1 = f.skills.find(s => s.rank === 1);
  assert.ok(rank1, 'expected a rank-1 skill');
  assert.equal(f.summary.highest_roi_skill_id, rank1.id);
});

test('scorecard-malformed.json parses but has a dangling top_actions skill_id', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'scorecard-malformed.json'), 'utf8'));
  assert.ok(Array.isArray(f.top_actions) && f.top_actions.length > 0);
  const skillIds = new Set(f.skills.map(s => s.id));
  const danglers = f.top_actions.filter(a => !skillIds.has(a.skill_id));
  assert.ok(danglers.length >= 1, 'expected at least one dangling top_actions reference');
});

test('scorecard-schema.md documents key validation rules', () => {
  const doc = readFileSync(join(fixturesDir, 'scorecard-schema.md'), 'utf8');
  assert.match(doc, /schema_version/i);
  assert.match(doc, /dimensions/i);
  assert.match(doc, /skills/i);
  assert.match(doc, /top_actions/i);
  assert.match(doc, /likert5/i);
  assert.match(doc, /karpathy/i);
});
