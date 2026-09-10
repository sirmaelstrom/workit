import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('council contract covers every concrete deep-stage output declared by the spec producer', () => {
  const contract = JSON.parse(readFileSync(new URL('./artifact-layouts.json', import.meta.url), 'utf8'));
  const skill = readFileSync(new URL('../../../skills/spec/SKILL.md', import.meta.url), 'utf8');
  const stageLines = skill.split('\n').filter((line) => /^- Output:/.test(line));
  assert.ok(stageLines.length >= 6, 'producer output declarations must be discoverable');
  const outputs = stageLines.flatMap((line) => [...line.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1]));
  const concrete = outputs.filter((p) => !p.includes('{'));
  assert.deepEqual([...contract.workshop.required].sort(), concrete.sort());
  assert.equal(contract.version, 1);
  assert.ok(new RegExp(contract.workshop.packagePattern).test('wp-01-example.md'));
  assert.equal(contract.workshop.packagesDirectory, 'work-packages');
  assert.deepEqual(contract.lite, ['spec.md', 'spec-lite.md']);
});
