import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPrompt, completeCheck, specDiff } from '../scripts/fix-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'fix-check');
const cli = join(here, '..', 'scripts', 'fix-check.mjs');
const skill = join(here, '..', 'SKILL.md');
const promptTemplate = join(here, '..', 'reference', 'fix-check-prompt.md');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'spec-fix-check-amend-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('prompt substitution preserves placeholders and dollar tokens in both findings and diff', () => {
  const tokens = "{spec_diff} {after_dir} $& $' $` $$";
  const findings = [{ id: 'W1-F1', finding: tokens, claimed_fix: tokens }];
  const diff = `+${tokens}\n-${tokens}`;
  const template = '<F>{fixed_findings}</F>\n<D>{spec_diff}</D>\n<A>{after_dir}</A>';
  assert.equal(buildPrompt(findings, diff, '/after', template),
    `<F>${JSON.stringify(findings, null, 2)}</F>\n<D>${diff}</D>\n<A>/after</A>`);
});

test('complete retry merges next-wave dispositions and preserves entries added after first run', () => withTempDir(root => {
  const findings = join(fixture, 'fixed-findings.json');
  const verdict = join(fixture, 'verdict.json');
  const after = join(fixture, 'after');
  const report = join(root, 'report.json');
  const next = join(root, 'next.json');
  const args = ['complete', '--findings', findings, '--verdict', verdict, '--after', after,
    '--wave', '1', '--output', report, '--next-dispositions', next];
  run(...args);
  const existing = json(next);
  existing.findings[0].disposition = 'noted';
  existing.findings[0].reason = 'stale next-wave edit';
  existing.findings.push({ id: 'W2-F1', finding: 'New wave finding', disposition: 'noted' });
  writeFileSync(next, JSON.stringify(existing));
  run(...args);
  assert.deepEqual(json(report).fix_check, { checked: 2, failed: 1, unchecked: 0 });
  assert.deepEqual(json(next).findings.map(f => f.id), ['W1-F2', 'W2-F1']);
  assert.equal(json(next).findings[0].disposition, 'reopened');
  assert.equal(json(next).findings[0].reason, json(join(fixture, 'verdict.json')).results[1].reason);
}));

test('unchecked recovery reopens every finding and reaches the next ledger without becoming held', () => withTempDir(root => {
  const report = join(root, 'report.json');
  const next = join(root, 'next.json');
  const ledger = join(root, 'ledger.json');
  run('unchecked', '--findings', join(fixture, 'fixed-findings.json'), '--wave', '1',
    '--output', report, '--next-dispositions', next);
  assert.deepEqual(json(report).fix_check, { checked: 0, failed: 0, unchecked: 2 });
  assert.deepEqual(json(report).results.map(r => r.status), ['unchecked', 'unchecked']);
  assert.deepEqual(json(next).findings.map(f => f.disposition), ['reopened', 'reopened']);
  run('ledger', '--slug', 'fixture', '--wave', '2', '--p1', '0', '--p2', '0', '--p3', '0',
    '--prior-report', report, '--output', ledger);
  assert.deepEqual(json(ledger).payload.workshop_stage.fix_check,
    { checked: 0, failed: 0, unchecked: 2 });
}));

test('dispositions schema and unchecked convergence rule are explicit in skill', () => {
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /"disposition": "fixed \| skipped \| false_positive \| noted \| reopened"/);
  assert.match(text, /reopened.*original id.*fixed again/is);
  assert.match(text, /unchecked.*cannot.*converg/is);
  assert.match(text, /at most \*\*two\*\* times \(three attempts total\)/);
  assert.match(text, /include each unchecked finding in the `fixed` export/);
  assert.match(text, /Quote validation proves the line exists/);
  assert.match(text, /terminal wave's own check.*Phase 9 final report/);
});

test('complete rejects an invalid existing dispositions file before replacing its report', () => withTempDir(root => {
  const findings = join(fixture, 'fixed-findings.json');
  const verdict = join(fixture, 'verdict.json');
  const after = join(fixture, 'after');
  const report = join(root, 'report.json');
  const next = join(root, 'next.json');
  const args = ['complete', '--findings', findings, '--verdict', verdict, '--after', after,
    '--wave', '1', '--output', report, '--next-dispositions', next];
  run(...args);
  const previous = readFileSync(report, 'utf8');
  writeFileSync(next, JSON.stringify({ wave: 7, findings: [] }));
  const retry = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /invalid wave or findings array/);
  assert.equal(readFileSync(report, 'utf8'), previous);
}));

test('spec diff stays textual under color.ui=always and prompt has no Markdown wrapper', () => {
  const previous = [process.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0];
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'color.ui';
    process.env.GIT_CONFIG_VALUE_0 = 'always';
    const diff = specDiff(join(fixture, 'before'), join(fixture, 'after'));
    assert.match(diff, /diff --git/);
    assert.doesNotMatch(diff, /\x1b\[/);
  } finally {
    for (const [key, value] of [
      ['GIT_CONFIG_COUNT', previous[0]],
      ['GIT_CONFIG_KEY_0', previous[1]],
      ['GIT_CONFIG_VALUE_0', previous[2]],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const template = readFileSync(promptTemplate, 'utf8');
  assert.doesNotMatch(template, /```/);
  assert.doesNotMatch(template, /Use this prompt with/);
  assert.match(template, /strip.*post-fix directory prefix/i);
});

test('fresh-eyes prompt points to convergence Phase 7d', () => {
  assert.match(readFileSync(join(here, '..', 'reference', 'fresh-eyes-prompt.md'), 'utf8'), /Phase 7d/);
});

test('partial verdict reopens with its explanation and counts as failed', () => {
  const findings = json(join(fixture, 'fixed-findings.json'));
  const verdict = json(join(fixture, 'verdict.json'));
  verdict.results[1].status = 'partial';
  const report = completeCheck(findings, verdict, join(fixture, 'after'), 1);
  assert.deepEqual(report.fix_check, { checked: 2, failed: 1, unchecked: 0 });
  assert.equal(report.next_dispositions.findings[0].reason, verdict.results[1].reason);
});

test('verdict rejects missing and duplicate ids, traversal, and Windows drive-relative path', () => {
  const findings = json(join(fixture, 'fixed-findings.json'));
  const base = json(join(fixture, 'verdict.json'));
  const after = join(fixture, 'after');
  assert.throws(() => completeCheck(findings, { results: [base.results[0]] }, after, 1), /cover every/);
  assert.throws(() => completeCheck(findings, { results: [base.results[0], base.results[0]] }, after, 1), /duplicate/);
  const traversal = structuredClone(base);
  traversal.results[1].path = '../outside.md';
  assert.throws(() => completeCheck(findings, traversal, after, 1), /escapes/);
  const drive = structuredClone(base);
  drive.results[1].path = 'D:outside.md';
  assert.throws(() => completeCheck(findings, drive, after, 1), /drive-relative|must be relative/);
});

test('empty check has explicit zero counts including unchecked', () => withTempDir(root => {
  const report = join(root, 'empty.json');
  run('empty', '--wave', '1', '--output', report);
  assert.deepEqual(json(report).fix_check, { checked: 0, failed: 0, unchecked: 0 });
}));

test('ledger CLI rejects forbidden, missing, and empty arguments before conversion', () => withTempDir(root => {
  const output = join(root, 'ledger.json');
  const badPrior = spawnSync(process.execPath, [cli, 'ledger', '--slug', 'fixture', '--wave', '1',
    '--p1', '0', '--p2', '0', '--p3', '0', '--prior-report', 'ignored', '--output', output], { encoding: 'utf8' });
  assert.notEqual(badPrior.status, 0);
  assert.match(badPrior.stderr, /--prior-report.*forbidden.*wave 1/i);
  const missingPrior = spawnSync(process.execPath, [cli, 'ledger', '--slug', 'fixture', '--wave', '2',
    '--p1', '0', '--p2', '0', '--p3', '0', '--output', output], { encoding: 'utf8' });
  assert.notEqual(missingPrior.status, 0);
  assert.match(missingPrior.stderr, /--prior-report.*required/i);
  const emptyCount = spawnSync(process.execPath, [cli, 'ledger', '--slug', 'fixture', '--wave', '1',
    '--p1', '', '--p2', '0', '--p3', '0', '--output', output], { encoding: 'utf8' });
  assert.notEqual(emptyCount.status, 0);
  assert.match(emptyCount.stderr, /--p1.*non-negative integer/i);
}));

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
    assert.deepEqual(json(report).fix_check, { checked: 2, failed: 1, unchecked: 0 });
    assert.equal(json(next).findings[0].id, 'W1-F2');
    assert.equal(json(next).findings[0].disposition, 'reopened');

    run('ledger', '--slug', 'fixture', '--wave', '1', '--p1', '1', '--p2', '1', '--p3', '0', '--output', wave1);
    assert.equal('fix_check' in json(wave1).payload.workshop_stage, false);
    run('ledger', '--slug', 'fixture', '--wave', '2', '--p1', '0', '--p2', '1', '--p3', '0',
      '--prior-report', report, '--output', wave2);
    assert.deepEqual(json(wave2).payload.workshop_stage.fix_check, { checked: 2, failed: 1, unchecked: 0 });
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
