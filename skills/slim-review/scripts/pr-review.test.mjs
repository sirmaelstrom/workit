import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseDiff,
  partitionFindings,
  checkCoverage,
  validateFindingsShape,
  buildReviewPayload,
  parseArgs,
} from './pr-review.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pr-review.mjs');

// ---------------------------------------------------------------------------
// parseDiff
// ---------------------------------------------------------------------------

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ export function a() {',
  ' const keep = 1;',
  '-const gone = 2;',
  '+const added = 2;',
  '+const alsoAdded = 3;',
  ' return keep;',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  ' tail',
].join('\n');

test('parseDiff numbers added and context lines on the post-change side', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual([...files.keys()], ['src/a.ts', 'src/b.ts']);
  // hunk starts at new-line 10: context 10, (removed consumes nothing),
  // added 11, added 12, context 13.
  assert.deepEqual([...files.get('src/a.ts')].sort((x, y) => x - y), [10, 11, 12, 13]);
  assert.deepEqual([...files.get('src/b.ts')].sort((x, y) => x - y), [1, 2]);
});

test('parseDiff ignores deleted files — they have no commentable side', () => {
  const files = parseDiff(
    ['diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'),
  );
  assert.equal(files.size, 0);
});

test('parseDiff handles several hunks in one file', () => {
  const files = parseDiff(
    [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '+one',
      '@@ -50,1 +60,2 @@',
      '+sixty',
      '+sixtyone',
    ].join('\n'),
  );
  assert.deepEqual([...files.get('x.ts')].sort((a, b) => a - b), [1, 60, 61]);
});

test('parseDiff tolerates CRLF input', () => {
  const files = parseDiff(DIFF.replace(/\n/g, '\r\n'));
  assert.deepEqual([...files.get('src/a.ts')].sort((x, y) => x - y), [10, 11, 12, 13]);
});

// ---------------------------------------------------------------------------
// partitionFindings
// ---------------------------------------------------------------------------

const finding = (over) => ({ severity: 'P2', title: 't', path: 'src/a.ts', line: 11, body: 'b', ...over });

test('partitionFindings splits anchorable, off-line and off-diff findings', () => {
  const diffFiles = parseDiff(DIFF);
  const { anchored, offLine, offDiff } = partitionFindings(
    [
      finding({ line: 11 }),
      finding({ line: 999 }),
      finding({ path: 'src/never-touched.ts', line: 3 }),
    ],
    diffFiles,
  );
  assert.equal(anchored.length, 1);
  assert.equal(anchored[0].line, 11);
  assert.equal(offLine.length, 1);
  assert.equal(offLine[0].line, 999);
  assert.equal(offDiff.length, 1);
  assert.equal(offDiff[0].path, 'src/never-touched.ts');
});

test('partitionFindings normalizes backslash and ./ paths before matching', () => {
  const diffFiles = parseDiff(DIFF);
  const { anchored } = partitionFindings(
    [finding({ path: 'src\\a.ts' }), finding({ path: './src/a.ts' })],
    diffFiles,
  );
  assert.equal(anchored.length, 2);
  assert.equal(anchored[0].path, 'src/a.ts');
});

// ---------------------------------------------------------------------------
// checkCoverage
// ---------------------------------------------------------------------------

test('checkCoverage accepts a full, truthful claim', () => {
  assert.equal(checkCoverage('examined 2 of 2 changed files.', 2).ok, true);
});

test('checkCoverage rejects a claim whose total disagrees with the diff', () => {
  const r = checkCoverage('examined 5 of 5 changed files.', 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /claims 5 changed files, the PR diff has 2/);
});

test('checkCoverage rejects a silently partial review', () => {
  const r = checkCoverage('examined 3 of 7 changed files', 7);
  assert.equal(r.ok, false);
  assert.match(r.reason, /examined 3 of 7/);
});

test('checkCoverage rejects a coverage string that states no counts', () => {
  const r = checkCoverage('I looked at everything.', 4);
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not state/);
});

// ---------------------------------------------------------------------------
// validateFindingsShape
// ---------------------------------------------------------------------------

const VALID = { summary: 's', coverage: 'examined 1 of 1 changed files', findings: [finding()] };

test('validateFindingsShape accepts a well-formed document', () => {
  assert.deepEqual(validateFindingsShape(VALID), []);
});

test('validateFindingsShape accepts an empty findings array', () => {
  assert.deepEqual(validateFindingsShape({ ...VALID, findings: [] }), []);
});

test('validateFindingsShape rejects a bad severity and a non-integer line', () => {
  const problems = validateFindingsShape({
    ...VALID,
    findings: [finding({ severity: 'blocker' }), finding({ line: 'twelve' })],
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /severity/);
  assert.match(problems[1], /line/);
});

test('validateFindingsShape rejects a missing findings array', () => {
  const problems = validateFindingsShape({ summary: 's', coverage: 'c' });
  assert.match(problems.join(' '), /findings must be an array/);
});

// ---------------------------------------------------------------------------
// buildReviewPayload
// ---------------------------------------------------------------------------

test('buildReviewPayload emits COMMENT with line-anchored comments', () => {
  const p = buildReviewPayload({
    summary: 'Looks mostly fine.',
    coverage: 'examined 2 of 2 changed files',
    anchored: [finding()],
    offDiff: [],
    offLine: [],
    coverageCheck: { ok: true },
  });
  assert.equal(p.event, 'COMMENT');
  assert.equal(p.comments.length, 1);
  assert.deepEqual(
    { path: p.comments[0].path, line: p.comments[0].line, side: p.comments[0].side },
    { path: 'src/a.ts', line: 11, side: 'RIGHT' },
  );
  assert.match(p.comments[0].body, /\*\*\[P2\] t\*\*/);
  assert.match(p.body, /1 anchored · 0 off-line · 0 off-diff/);
});

test('buildReviewPayload surfaces an off-diff finding in the body, not silently', () => {
  const p = buildReviewPayload({
    summary: 's',
    coverage: 'examined 1 of 1 changed files',
    anchored: [],
    offDiff: [finding({ path: 'other.ts' })],
    offLine: [],
    coverageCheck: { ok: true },
  });
  assert.equal(p.comments.length, 0);
  assert.match(p.body, /this PR does not change that file/);
  assert.match(p.body, /other\.ts:11/);
});

test('buildReviewPayload banners a failed coverage check into the posted body', () => {
  const p = buildReviewPayload({
    summary: 's',
    coverage: 'examined 1 of 9 changed files',
    anchored: [],
    offDiff: [],
    offLine: [],
    coverageCheck: { ok: false, reason: 'reviewer examined 1 of 9 changed files — the review is partial' },
  });
  assert.match(p.body, /Coverage check failed/);
  assert.match(p.body, /the review is partial/);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads the post form', () => {
  const o = parseArgs(['post', '--pr', '12', '--findings', 'f.json', '--dry-run']);
  assert.deepEqual(
    { cmd: o.cmd, pr: o.pr, findings: o.findings, dryRun: o.dryRun },
    { cmd: 'post', pr: '12', findings: 'f.json', dryRun: true },
  );
});

// ---------------------------------------------------------------------------
// Exit codes — the distinction the whole loop rests on
// ---------------------------------------------------------------------------

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

test('a missing findings file exits 3 — "did not run", never a clean review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-'));
  try {
    const r = runCli(['post', '--pr', '1', '--findings', join(dir, 'nope.json')]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /NOT a clean review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unparseable findings file exits 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-'));
  const f = join(dir, 'findings.json');
  try {
    writeFileSync(f, '{ this is not json', 'utf8');
    const r = runCli(['post', '--pr', '1', '--findings', f]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong-shape findings file exits 3 and names each problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-'));
  const f = join(dir, 'findings.json');
  try {
    writeFileSync(f, JSON.stringify({ summary: 's', coverage: 'c', findings: [{ severity: 'nope' }] }), 'utf8');
    const r = runCli(['post', '--pr', '1', '--findings', f]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /wrong shape/);
    assert.match(r.stderr, /severity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-numeric --pr is a usage error, not a request', () => {
  const r = runCli(['post', '--pr', 'main', '--findings', 'x.json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--pr <n> is required/);
});
