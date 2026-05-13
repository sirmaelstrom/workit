import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

test('synthesis-example.json parses and has all required fields', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'synthesis-example.json'), 'utf8'));
  const required = ['schema_version', 'run_slug', 'created_at', 'goal', 'non_goals',
    'hard_constraints', 'evaluation_criteria', 'branches', 'comparison_matrix',
    'branches_agree', 'branches_disagree', 'hidden_assumptions', 'recommendation',
    'uncertainty', 'next_action'];
  for (const k of required) assert.ok(k in f, `missing field: ${k}`);
  assert.equal(f.schema_version, '1.0');
  assert.equal(f.branches.length, 3, 'expected 3 branches');
  const recBranch = f.branches.find(b => b.id === f.recommendation.branch_id);
  assert.ok(recBranch, 'recommendation.branch_id must match a branch');
  const allScores = f.comparison_matrix.flatMap(row => row.cells.map(c => c.score));
  for (const s of [1, 2, 3, 4, 5]) {
    assert.ok(allScores.includes(s), `matrix must include score ${s}`);
  }
});

test('synthesis-malformed.json parses but has a dangling recommendation.branch_id', () => {
  const f = JSON.parse(readFileSync(join(fixturesDir, 'synthesis-malformed.json'), 'utf8'));
  assert.ok(f.recommendation, 'malformed file must still contain recommendation');
  const matched = f.branches.some(b => b.id === f.recommendation.branch_id);
  assert.equal(matched, false, 'recommendation.branch_id must NOT match any branch (this is the chosen break)');
});

test('synthesis-schema.md documents validation rules', () => {
  const doc = readFileSync(join(fixturesDir, 'synthesis-schema.md'), 'utf8');
  assert.match(doc, /schema_version/i);
  assert.match(doc, /branches/i);
  assert.match(doc, /recommendation/i);
});
