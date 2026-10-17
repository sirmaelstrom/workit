import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { completeCheck } from '../scripts/fix-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'fix-check');
const cli = join(here, '..', 'scripts', 'fix-check.mjs');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('fix check carries a missed fix into the next dispositions and ledger, without wave-1 check', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-fix-check-'));
  try {
    const findings = join(fixture, 'fixed-findings.json');
    const before = join(fixture, 'before');
    const after = join(fixture, 'after');
    const prompt = join(root, 'prompt.md');
    const report = join(root, 'report.json');
    const next = join(root, 'refinement-wave-2-dispositions.json');
    const wave1 = join(root, 'wave1.json');
    const wave2 = join(root, 'wave2.json');

    run('prepare', '--findings', findings, '--before', before, '--after', after, '--output', prompt);
    const text = readFileSync(prompt, 'utf8');
    assert.match(text, /W1-F2/);
    assert.match(text, /Require an immutable session id/);
    assert.match(text, /- Use mutable session id/);
    assert.match(text, /diff --git/);

    run('complete', '--findings', findings, '--verdict', join(fixture, 'verdict.json'),
      '--after', after, '--wave', '1', '--output', report, '--next-dispositions', next);
    assert.deepEqual(json(report).results.map(result => result.status), ['held', 'failed']);
    assert.deepEqual(json(report).fix_check, { checked: 2, failed: 1 });
    assert.equal(json(next).findings[0].id, 'W1-F2');
    assert.equal(json(next).findings[0].disposition, 'reopened');

    run('ledger', '--slug', 'fixture', '--wave', '1', '--p1', '1', '--p2', '1', '--p3', '0', '--output', wave1);
    assert.equal('fix_check' in json(wave1).payload.workshop_stage, false);
    run('ledger', '--slug', 'fixture', '--wave', '2', '--p1', '0', '--p2', '1', '--p3', '0',
      '--prior-report', report, '--output', wave2);
    assert.deepEqual(json(wave2).payload.workshop_stage.fix_check, { checked: 2, failed: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix check rejects an evidence quote that is absent from the post-fix spec', () => {
  const findings = json(join(fixture, 'fixed-findings.json'));
  const verdict = json(join(fixture, 'verdict.json'));
  verdict.results[1].quote = '- Use immutable session id';
  assert.throws(() => completeCheck(findings, verdict, join(fixture, 'after'), 1), /quote does not match/);
});
