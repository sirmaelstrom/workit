import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorEntry,
  detectTestWeakening,
  filesFromDiff,
  guardReview,
  indexForAnchoring,
  isTestFile,
  renderGuardComment,
} from './pr-review-guard.mjs';

const diff = (...lines) => lines.join('\n');

// --- positive cases: each must be reported ----------------------------------

const DELETED_TEST_FILE = diff(
  'diff --git a/src/old.test.mjs b/src/old.test.mjs',
  'deleted file mode 100644',
  'index 1111111..0000000',
  '--- a/src/old.test.mjs',
  '+++ /dev/null',
  '@@ -1,5 +0,0 @@',
  "-import { test } from 'node:test';",
  "-import assert from 'node:assert/strict';",
  "-test('works', () => {",
  '-  assert.equal(1, 1);',
  '-});',
);

const REMOVED_IT = diff(
  'diff --git a/src/a.spec.ts b/src/a.spec.ts',
  '--- a/src/a.spec.ts',
  '+++ b/src/a.spec.ts',
  '@@ -1,6 +1,3 @@',
  " describe('a', () => {",
  "-  it('handles the edge', () => {",
  '-    run();',
  '-  });',
  "   it('works', () => {",
  '     run();',
);

const ADDED_ONLY = diff(
  'diff --git a/src/a.test.ts b/src/a.test.ts',
  '--- a/src/a.test.ts',
  '+++ b/src/a.test.ts',
  '@@ -3,3 +3,3 @@',
  ' ',
  "-it('works', () => {",
  "+it.only('works', () => {",
  '   run();',
);

const ADDED_FACT_SKIP = diff(
  'diff --git a/Api.Tests/OrderTests.cs b/Api.Tests/OrderTests.cs',
  '--- a/Api.Tests/OrderTests.cs',
  '+++ b/Api.Tests/OrderTests.cs',
  '@@ -10,3 +10,3 @@',
  '     {',
  '-        [Fact]',
  '+        [Fact(Skip = "flaky on CI")]',
  '         public void Totals() {',
);

const LOOSENED_ASSERTION = diff(
  'diff --git a/tests/total.mjs b/tests/total.mjs',
  '--- a/tests/total.mjs',
  '+++ b/tests/total.mjs',
  '@@ -20,3 +20,3 @@',
  "   const total = sum([1, 2]);",
  '-  assert.strictEqual(total, 3);',
  '+  assert.ok(total);',
  ' });',
);

test('positive: a deleted test file is reported once, with its test and assertion counts', () => {
  const [entry, ...rest] = detectTestWeakening(filesFromDiff(DELETED_TEST_FILE));
  assert.deepEqual(rest, []);
  assert.equal(entry.path, 'src/old.test.mjs');
  assert.equal(entry.deleted, true);
  assert.equal(entry.removedTests, 1);
  assert.equal(entry.removedAssertions, 1);
  assert.equal(entry.firstLine, 1);
});

test('positive: a removed it( is reported as a removed test case on the old side', () => {
  const [entry] = detectTestWeakening(filesFromDiff(REMOVED_IT));
  assert.deepEqual(entry.items.map((item) => [item.kind, item.side, item.line]), [['test-removed', 'LEFT', 2]]);
});

test('positive: an added .only is reported, and the paired declaration is a rename, not a removal', () => {
  const [entry] = detectTestWeakening(filesFromDiff(ADDED_ONLY));
  assert.deepEqual(entry.items.map((item) => [item.kind, item.side, item.line]), [['skip-added', 'RIGHT', 4]]);
});

test('positive: an added [Fact(Skip = "…")] is reported as a skip', () => {
  const [entry] = detectTestWeakening(filesFromDiff(ADDED_FACT_SKIP));
  assert.equal(entry.path, 'Api.Tests/OrderTests.cs');
  assert.deepEqual(entry.items.map((item) => [item.kind, item.side, item.line]), [['skip-added', 'RIGHT', 11]]);
});

test('positive: assert.strictEqual changed to assert.ok is reported as an assertion removed or changed', () => {
  const [entry] = detectTestWeakening(filesFromDiff(LOOSENED_ASSERTION));
  assert.deepEqual(entry.items.map((item) => [item.kind, item.side, item.line, item.text.trim()]), [['assertion-removed', 'LEFT', 21, 'assert.strictEqual(total, 3);']]);
});

test('positive: the other skip forms in the table are each reported', () => {
  for (const added of ['xit(\'x\', () => {', 'describe.skip(\'x\', () => {', 'it.todo(\'x\');', 'it.skipIf(isWindows)(\'x\', () => {', 'ctx.skip();', "test('x', { skip: true }, () => {", '[Ignore("later")]', 'xdescribe(\'x\', () => {']) {
    const [entry] = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: `@@ -1,1 +1,2 @@\n ctx\n+${added}` }]);
    assert.ok(entry?.items.some((item) => item.kind === 'skip-added'), `not reported: ${added}`);
  }
});

// --- negative cases: none may be reported (red here means over-reporting) ---

test('negative: a moved assertion (removed, re-added unchanged in the same file) is not reported', () => {
  const moved = diff(
    'diff --git a/src/a.test.mjs b/src/a.test.mjs',
    '--- a/src/a.test.mjs',
    '+++ b/src/a.test.mjs',
    '@@ -1,4 +1,3 @@',
    " test('a', () => {",
    '-  assert.equal(a, 1);',
    '   const b = 2;',
    ' });',
    '@@ -10,2 +9,3 @@',
    " test('c', () => {",
    '+    assert.equal(a, 1);',
    ' });',
  );
  assert.deepEqual(detectTestWeakening(filesFromDiff(moved)), []);
});

test('negative: a renamed test with its body intact is not reported', () => {
  const renamed = diff(
    'diff --git a/src/a.test.mjs b/src/a.test.mjs',
    '--- a/src/a.test.mjs',
    '+++ b/src/a.test.mjs',
    '@@ -1,3 +1,3 @@',
    "-test('the old name', () => {",
    "+test('a clearer name', () => {",
    '   assert.equal(a, 1);',
    ' });',
  );
  assert.deepEqual(detectTestWeakening(filesFromDiff(renamed)), []);
});

test('negative: an added test is not reported', () => {
  const added = diff(
    'diff --git a/src/a.test.mjs b/src/a.test.mjs',
    '--- a/src/a.test.mjs',
    '+++ b/src/a.test.mjs',
    '@@ -5,1 +5,5 @@',
    ' });',
    '+',
    "+test('a new case', () => {",
    '+  assert.equal(b, 2);',
    '+});',
  );
  assert.deepEqual(detectTestWeakening(filesFromDiff(added)), []);
});

test('negative: a non-test file containing expect( is not reported', () => {
  const helper = diff(
    'diff --git a/src/matchers.ts b/src/matchers.ts',
    '--- a/src/matchers.ts',
    '+++ b/src/matchers.ts',
    '@@ -1,2 +1,1 @@',
    '-export const check = (x) => expect(x).toBe(1);',
    ' export const other = 1;',
  );
  assert.deepEqual(detectTestWeakening(filesFromDiff(helper)), []);
});

test('negative: a removed regex .test( call in a test file is not a removed test case', () => {
  const [entry] = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: '@@ -1,2 +1,1 @@\n-  if (SHA_PATTERN.test(value)) return;\n ctx' }]);
  assert.equal(entry, undefined);
});

// --- plumbing -----------------------------------------------------------------

test('isTestFile matches the table and nothing else', () => {
  for (const path of ['a.test.mjs', 'src/x.spec.ts', 'src/__tests__/x.js', 'tests/x.mjs', 'pkg/test/x.js', 'Api.Tests/OrderTests.cs', 'skills\\a\\tests\\b.mjs']) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ['src/testing.ts', 'src/latest.mjs', 'contest/x.js', 'OrderTest.cs', 'README.md']) {
    assert.equal(isTestFile(path), false, path);
  }
});

test('filesFromDiff reads status, names and patch from a gh pr diff', () => {
  const files = filesFromDiff(`${DELETED_TEST_FILE}\n${diff(
    'diff --git a/tests/old-name.mjs b/tests/new-name.mjs',
    'similarity index 90%',
    'rename from tests/old-name.mjs',
    'rename to tests/new-name.mjs',
    '--- a/tests/old-name.mjs',
    '+++ b/tests/new-name.mjs',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  )}\n${diff(
    'diff --git a/src/new.mjs b/src/new.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.mjs',
    '@@ -0,0 +1,1 @@',
    '+x',
  )}\n`);
  assert.deepEqual(files.map(({ filename, previous_filename, status }) => ({ filename, previous_filename, status })), [
    { filename: 'src/old.test.mjs', previous_filename: undefined, status: 'removed' },
    { filename: 'tests/new-name.mjs', previous_filename: 'tests/old-name.mjs', status: 'renamed' },
    { filename: 'src/new.mjs', previous_filename: undefined, status: 'added' },
  ]);
  assert.equal(files[1].patch, '@@ -1,1 +1,1 @@\n-a\n+b');
});

test('anchoring: a full review anchors each entry on its own line; a deleted file on LEFT 1', () => {
  const files = filesFromDiff(`${DELETED_TEST_FILE}\n${LOOSENED_ASSERTION}\n${ADDED_ONLY}`);
  const index = indexForAnchoring(files);
  const anchors = detectTestWeakening(files).map((entry) => anchorEntry(entry, index));
  assert.deepEqual(anchors, [
    { path: 'src/old.test.mjs', side: 'LEFT', line: 1, exact: true },
    { path: 'tests/total.mjs', side: 'LEFT', line: 21, exact: true },
    { path: 'src/a.test.ts', side: 'RIGHT', line: 4, exact: true },
  ]);
});

test('anchoring: an amendment removal finds its text on the PR diff; a file the PR diff lacks falls back to a named line', () => {
  // The amendment removed `assert.equal(b, 2);` at its line 7; the PR diff shows
  // the same removal at base line 9.
  const amendment = [{ filename: 'src/a.test.mjs', status: 'modified', patch: '@@ -6,3 +6,2 @@\n ctx\n-  assert.equal(b, 2);\n ctx' }];
  const prDiff = [{ filename: 'src/a.test.mjs', status: 'modified', patch: '@@ -8,3 +8,2 @@\n ctx\n-  assert.equal(b, 2);\n ctx' }];
  const [entry] = detectTestWeakening(amendment);
  assert.deepEqual(anchorEntry(entry, indexForAnchoring(prDiff)), { path: 'src/a.test.mjs', side: 'LEFT', line: 9, exact: true });
  // A test file an earlier round added and the amendment deleted is not in the
  // PR diff at all: the first commentable line anywhere carries it.
  const gone = [{ filename: 'src/b.test.mjs', status: 'removed', patch: "@@ -1,2 +0,0 @@\n-test('b', () => {\n-});" }];
  const [goneEntry] = detectTestWeakening(gone);
  const anchor = anchorEntry(goneEntry, indexForAnchoring(prDiff));
  assert.deepEqual(anchor, { path: 'src/a.test.mjs', side: 'RIGHT', line: 8, exact: false });
  assert.match(renderGuardComment(goneEntry, anchor), /nearest line GitHub accepts .*the change is in `src\/b\.test\.mjs`/);
  assert.equal(anchorEntry(goneEntry, indexForAnchoring([])), null);
});

// --- no patch: GitHub omits it on a large diff, and a binary has none -------

/** A PR diff with one commentable file, so a no-patch entry has somewhere to fall back to. */
const ELSEWHERE = [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }];

test('no patch: a modified test file with no patch is one "not checked" entry and a guard thread', () => {
  const big = { filename: 'src/big.test.mjs', status: 'modified', changes: 4000 };
  assert.deepEqual(detectTestWeakening([big]), [{ path: 'src/big.test.mjs', status: 'modified', deleted: false, unchecked: true, items: [] }]);
  const result = guardReview({ sourceFiles: [big], prDiffFiles: [...ELSEWHERE, big] });
  assert.equal(result.comments.length, 1);
  assert.deepEqual({ path: result.comments[0].path, side: result.comments[0].side, line: result.comments[0].line }, { path: 'src/a.ts', side: 'RIGHT', line: 1 });
  assert.match(result.comments[0].body, /^\*\*lens:\*\* guard\n\n\*\*Test-weakening check: `src\/big\.test\.mjs` not checked: no patch\*\*/);
  assert.match(result.comments[0].body, /the change is in `src\/big\.test\.mjs`/);
  assert.match(result.section, /`src\/big\.test\.mjs`: not checked: no patch/);
});

test('no patch: a deleted test file with no patch is reported as deleted, and says its contents were not counted', () => {
  const gone = { filename: 'src/big.test.mjs', status: 'removed' };
  const [entry, ...rest] = detectTestWeakening([gone]);
  assert.deepEqual(rest, []);
  assert.deepEqual({ deleted: entry.deleted, patchMissing: entry.patchMissing }, { deleted: true, patchMissing: true });
  const result = guardReview({ sourceFiles: [gone], prDiffFiles: [...ELSEWHERE, gone] });
  assert.equal(result.comments.length, 1);
  assert.match(result.comments[0].body, /`src\/big\.test\.mjs` was deleted\*\*\n\nGitHub sent no patch for it/);
  assert.equal(result.comments[0].body.includes('held 0 test declaration'), false, 'no count is claimed for a file nobody read');
});

test('no patch: a non-test file, an added test file, and a pure rename are not reported', () => {
  assert.deepEqual(detectTestWeakening([
    { filename: 'src/big.ts', status: 'modified', changes: 4000 },
    { filename: 'src/big.ts', status: 'removed' },
    { filename: 'src/new.test.mjs', status: 'added', changes: 9000 },
    { filename: 'tests/moved.mjs', previous_filename: 'tests/old.mjs', status: 'renamed', changes: 0 },
  ]), []);
  // The same pure rename read from a gh pr diff, and a binary test fixture, which is reported.
  const files = filesFromDiff([
    'diff --git a/tests/old.mjs b/tests/moved.mjs',
    'similarity index 100%',
    'rename from tests/old.mjs',
    'rename to tests/moved.mjs',
    'diff --git a/tests/fixture.png b/tests/fixture.png',
    'index 1111111..2222222 100644',
    'Binary files a/tests/fixture.png and b/tests/fixture.png differ',
  ].join('\n'));
  assert.deepEqual(detectTestWeakening(files).map((entry) => [entry.path, entry.unchecked]), [['tests/fixture.png', true]]);
});

test('guardReview renders tagged threads and a body section, and nothing at all when no test was weakened', () => {
  const files = filesFromDiff(LOOSENED_ASSERTION);
  const result = guardReview({ sourceFiles: files, prDiffFiles: files, delta: true });
  assert.equal(result.comments.length, 1);
  assert.match(result.comments[0].body, /^\*\*lens:\*\* guard\n\n\*\*scope:\*\* delta\n\n\*\*Test-weakening check: `tests\/total\.mjs`\*\*/);
  assert.match(result.section, /### Test-weakening check/);
  const quiet = guardReview({ sourceFiles: filesFromDiff(REMOVED_IT.replace(/a\.spec\.ts/g, 'a.ts')), prDiffFiles: [] });
  assert.deepEqual(quiet, { entries: [], comments: [], unanchored: [], section: null });
});
