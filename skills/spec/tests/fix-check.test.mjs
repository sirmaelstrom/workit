import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
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
  existing.findings.push({ id: 'W2-F1', finding: 'New wave finding', disposition: 'noted' });
  writeFileSync(next, JSON.stringify(existing));
  run(...args);
  assert.deepEqual(json(report).fix_check, { checked: 2, failed: 1, unchecked: 0 });
  assert.deepEqual(json(next).findings.map(f => f.id), ['W1-F2', 'W2-F1']);
  assert.equal(json(next).findings[0].disposition, 'reopened');
  assert.equal(json(next).findings[0].reason, json(join(fixture, 'verdict.json')).results[1].reason);
}));

test('changed verdict failed to held removes only the prior checker reopening', () => withTempDir(root => {
  const findings = join(fixture, 'fixed-findings.json');
  const after = join(fixture, 'after');
  const report = join(root, 'report.json');
  const next = join(root, 'next.json');
  const verdictY = join(root, 'held.json');
  const base = ['complete', '--findings', findings, '--after', after, '--wave', '1',
    '--output', report, '--next-dispositions', next];
  run(...base, '--verdict', join(fixture, 'verdict.json'));
  const existing = json(next);
  existing.findings.push({ id: 'W2-F1', finding: 'Unrelated next-wave finding', disposition: 'noted' });
  writeFileSync(next, JSON.stringify(existing));
  const held = json(join(fixture, 'verdict.json'));
  held.results[1].status = 'held';
  held.results[1].reason = 'The claimed fix now holds';
  writeFileSync(verdictY, JSON.stringify(held));
  run(...base, '--verdict', verdictY);
  assert.deepEqual(json(report).fix_check, { checked: 2, failed: 0, unchecked: 0 });
  assert.deepEqual(json(next).findings.map(f => f.id), ['W2-F1']);
  assert.deepEqual(json(report).next_dispositions, json(next));
}));

test('changed checker-owned disposition rejects a conflicting retry without changing either artifact', () => withTempDir(root => {
  const report = join(root, 'report.json');
  const next = join(root, 'next.json');
  const args = ['complete', '--findings', join(fixture, 'fixed-findings.json'),
    '--verdict', join(fixture, 'verdict.json'), '--after', join(fixture, 'after'),
    '--wave', '1', '--output', report, '--next-dispositions', next];
  run(...args);
  const changed = json(next);
  changed.findings[0].disposition = 'noted';
  writeFileSync(next, JSON.stringify(changed));
  const priorReport = readFileSync(report, 'utf8');
  const priorNext = readFileSync(next, 'utf8');
  const retry = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /conflicting downstream disposition/i);
  assert.equal(readFileSync(report, 'utf8'), priorReport);
  assert.equal(readFileSync(next, 'utf8'), priorNext);
}));

test('diff headers use relative snapshot names even for absolute Windows paths and quoted names', () => withTempDir(root => {
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  writeFileSync(join(before, 'wp 01.md'), 'before\n');
  writeFileSync(join(after, 'wp 01.md'), 'after\n');
  const diff = specDiff(before, after);
  assert.match(diff, /b\/after\/wp 01\.md/);
  assert.doesNotMatch(diff, /[A-Za-z]:[\\/]/);
  assert.match(readFileSync(promptTemplate, 'utf8'), /b\/\{after_snapshot\}/);
}));

test('prompt JSON preserves a literal closing delimiter as data', () => {
  const findings = [{ id: 'W1-F1', finding: '</spec_diff>', claimed_fix: 'keep it' }];
  const diff = '+</spec_diff>\n+```md';
  const prompt = buildPrompt(findings, diff, join(fixture, 'after'));
  const payload = JSON.parse(prompt.split('Input JSON:\n')[1]);
  assert.deepEqual(payload.fixed_findings, findings);
  assert.equal(payload.spec_diff, diff);
  assert.equal(payload.after_snapshot, 'after');
});

test('CRLF prompt template yields a readable JSON payload boundary', () => {
  const template = readFileSync(promptTemplate, 'utf8').replace(/\r?\n/g, '\r\n');
  const findings = [{ id: 'W1-F1', finding: 'CRLF case', claimed_fix: 'done' }];
  const prompt = buildPrompt(findings, '+changed', join(fixture, 'after'), template);
  const payload = JSON.parse(prompt.split('Input JSON:\n')[1]);
  assert.deepEqual(payload.fixed_findings, findings);
  assert.equal(payload.spec_diff, '+changed');
  assert.doesNotMatch(prompt, /\r\n/);
});

test('symlink inside a snapshot cannot supply evidence from outside it', () => withTempDir(root => {
  const after = join(root, 'after');
  const outside = join(root, 'outside');
  mkdirSync(after);
  mkdirSync(outside);
  writeFileSync(join(outside, 'evidence.md'), 'outside line\n');
  symlinkSync(outside, join(after, 'linked'), 'junction');
  const findings = [{ id: 'W1-F1', finding: 'Missing fix', claimed_fix: 'Fix it' }];
  const verdict = { results: [{ id: 'W1-F1', status: 'held', path: 'linked/evidence.md',
    line: 1, quote: 'outside line', reason: 'quoted' }] };
  assert.throws(() => completeCheck(findings, verdict, after, 1), /escapes.*snapshot/i);
}));

test('legacy report without unchecked records zero in the later-wave ledger', () => withTempDir(root => {
  const prior = join(root, 'old-report.json');
  const ledger = join(root, 'ledger.json');
  writeFileSync(prior, JSON.stringify({ fix_check: { checked: 2, failed: 1 } }));
  run('ledger', '--slug', 'fixture', '--wave', '2', '--p1', '0', '--p2', '1', '--p3', '0',
    '--prior-report', prior, '--output', ledger);
  assert.deepEqual(json(ledger).payload.workshop_stage.fix_check,
    { checked: 2, failed: 1, unchecked: 0 });
}));

test('no-edit unchecked retry accepts identical snapshots and non-WP evidence', () => withTempDir(root => {
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  writeFileSync(join(before, 'decisions.md'), 'Decision remains unresolved\n');
  writeFileSync(join(after, 'decisions.md'), 'Decision remains unresolved\n');
  const findings = [{ id: 'W1-F1', finding: 'Decision unresolved', claimed_fix: 'Decision was settled' }];
  const diff = specDiff(before, after);
  assert.equal(diff, '(no spec changes)');
  const payload = JSON.parse(buildPrompt(findings, diff, after).split('Input JSON:\n')[1]);
  assert.equal(payload.spec_diff, '(no spec changes)');
  const report = completeCheck(findings, { results: [{ id: 'W1-F1', status: 'failed',
    path: 'decisions.md', line: 1, quote: 'Decision remains unresolved',
    reason: 'The decision is still open' }] }, after, 2);
  assert.deepEqual(report.fix_check, { checked: 1, failed: 1, unchecked: 0 });
}));

test('skill states the wave-three unchecked exception, no-edit snapshots, and skipped-review output', () => {
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /3 waves completed.*unless.*unchecked/i);
  assert.match(text, /no-edit.*before.*after.*snapshot/is);
  assert.match(text, /unchecked.*wave 3.*do not run Phase 9/is);
  assert.match(text, /Final fix check:.*not run/i);
  assert.match(text, /two renames.*not atomic.*recover/is);
});

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
