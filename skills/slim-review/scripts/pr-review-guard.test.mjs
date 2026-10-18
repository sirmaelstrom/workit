import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectTestWeakening,
  filesFromDiff,
  GUARD_SECTION_MAX_CHARS,
  guardReview,
  isTestFile,
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

test('reporting: every matched file is a body-section entry naming its lines; nothing is an inline thread', () => {
  const files = filesFromDiff(`${DELETED_TEST_FILE}\n${LOOSENED_ASSERTION}\n${ADDED_ONLY}`);
  const result = guardReview({ sourceFiles: files });
  assert.equal(result.entries.length, 3);
  assert.equal('comments' in result, false, 'the check posts no thread of its own');
  assert.match(result.section, /^\n---\n\n### Test files whose assertions changed\n/);
  assert.match(result.section, /Not blocking/);
  assert.match(result.section, /- `src\/old\.test\.mjs`: deleted\. It held \d+ test declaration line\(s\) and \d+ assertion line\(s\)\./);
  assert.match(result.section, /- `tests\/total\.mjs`\n  - `-` old line 21, assertion removed or changed: `/);
  assert.match(result.section, /- `src\/a\.test\.ts`\n  - `\+` line 4, skip or focus added: `/);
});

/** `files` test files, each removing `lines` assertion lines of about 150 characters. */
function manyRemovals(files, lines) {
  return Array.from({ length: files }, (_, f) => ({
    filename: `tests/suite-${String(f).padStart(2, '0')}.test.mjs`,
    status: 'modified',
    patch: [`@@ -1,${lines} +1,0 @@`, ...Array.from({ length: lines }, (_, i) => `-  assert.deepEqual(computeTheValueUnderTest(${f}, ${i}, { mode: 'strict', retries: 3 }), expectedValueFor(${f}, ${i}, 'with a long descriptive label'));`)].join('\n'),
  }));
}

test('reporting: the section is capped in total size, and says how much it left out', () => {
  const result = guardReview({ sourceFiles: manyRemovals(25, 20) });
  assert.equal(result.entries.length, 25);
  assert.ok(result.section.length <= GUARD_SECTION_MAX_CHARS, `section is ${result.section.length} chars, cap ${GUARD_SECTION_MAX_CHARS}`);
  assert.ok(GUARD_SECTION_MAX_CHARS <= 65536 / 4, 'the cap leaves most of the 65,536-char body for findings, summary, footer and marker');
  const notice = /… (\d+) more matched line\(s\) in (\d+) file\(s\) omitted/.exec(result.section);
  assert.ok(notice, 'the omission is stated, never silent');
  const shown = (result.section.match(/^ {2}- `-` old line /gm) ?? []).length;
  assert.equal(shown + Number(notice[1]), 500, 'shown plus omitted is every matched line');
});

test('reporting: under the cap every matched line is listed, with no per-file limit', () => {
  const result = guardReview({ sourceFiles: manyRemovals(1, 30) });
  assert.equal((result.section.match(/^ {2}- `-` old line /gm) ?? []).length, 30);
  assert.equal(/omitted|more in this file/.test(result.section), false);
});

test('reporting: an amendment removal is listed at the amendment\'s own line, whatever the PR diff holds', () => {
  const amendment = [{ filename: 'src/a.test.mjs', status: 'modified', patch: '@@ -6,3 +6,2 @@\n ctx\n-  assert.equal(b, 2);\n ctx' }];
  const result = guardReview({ sourceFiles: amendment, delta: true });
  assert.match(result.section, /in this amendment/);
  assert.match(result.section, /- `src\/a\.test\.mjs`\n  - `-` old line 7, assertion removed or changed: `assert\.equal\(b, 2\);`/);
});

// --- no patch: GitHub omits it on a large diff, and a binary has none -------

test('no patch: a modified test file with no patch is one "not checked" entry in the body section', () => {
  const big = { filename: 'src/big.test.mjs', status: 'modified', changes: 4000 };
  assert.deepEqual(detectTestWeakening([big]), [{ path: 'src/big.test.mjs', status: 'modified', deleted: false, unchecked: true, items: [] }]);
  const result = guardReview({ sourceFiles: [big] });
  assert.match(result.section, /- `src\/big\.test\.mjs`: not checked: no patch \(modified; a large diff or a binary file\)/);
});

test('no patch: a deleted test file with no patch is reported as deleted, and says its contents were not counted', () => {
  const gone = { filename: 'src/big.test.mjs', status: 'removed' };
  const [entry, ...rest] = detectTestWeakening([gone]);
  assert.deepEqual(rest, []);
  assert.deepEqual({ deleted: entry.deleted, patchMissing: entry.patchMissing }, { deleted: true, patchMissing: true });
  const result = guardReview({ sourceFiles: [gone] });
  assert.match(result.section, /- `src\/big\.test\.mjs`: deleted\. GitHub sent no patch for it/);
  assert.equal(result.section.includes('held 0 test declaration'), false, 'no count is claimed for a file nobody read');
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

// --- round one of workit#119 ---------------------------------------------------

test('4117560925: a modified test file with no hunk stays unchecked; only evidence of identical content reads as unchanged', () => {
  const files = filesFromDiff([
    'diff --git a/src/big.test.mjs b/src/big.test.mjs',
    'index 1111111..2222222 100644',
    'diff --git a/src/same.test.mjs b/src/same.test.mjs',
    'index 3333333..3333333 100644',
  ].join('\n'));
  assert.equal(files[0].changes, undefined, 'no hunk alone is not git saying nothing changed');
  assert.equal(files[1].changes, 0, 'equal blob ids are that word');
  assert.deepEqual(detectTestWeakening(files).map((entry) => [entry.path, entry.unchecked]), [['src/big.test.mjs', true]]);
});

test('4117587311 / 4117587316: a mode header is not evidence of unchanged content', () => {
  const files = filesFromDiff([
    'diff --git a/src/run.test.mjs b/src/run.test.mjs',
    'old mode 100644',
    'new mode 100755',
    'index 1111111..2222222',
    'diff --git a/src/chmod.test.mjs b/src/chmod.test.mjs',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/src/chmod-same.test.mjs b/src/chmod-same.test.mjs',
    'old mode 100644',
    'new mode 100755',
    'index 4444444..4444444',
  ].join('\n'));
  assert.deepEqual(files.map((file) => file.changes), [undefined, undefined, 0]);
  assert.deepEqual(detectTestWeakening(files).map((entry) => [entry.path, entry.unchecked]), [
    ['src/run.test.mjs', true],
    ['src/chmod.test.mjs', true],
  ], 'different blob ids, or none shown, stay not checked; only equal blob ids pass');
});

test('4117560929: a test moved unchanged under if (false) is reported by its wrapper', () => {
  const [entry] = detectTestWeakening([{ filename: 'src/pay.test.mjs', status: 'modified', patch: [
    '@@ -1,3 +1,5 @@',
    "-test('critical', () => {",
    '-  verifyPayment();',
    '-});',
    '+if (false) {',
    "+  test('critical', () => {",
    '+    verifyPayment();',
    '+  });',
    '+}',
  ].join('\n') }]);
  assert.deepEqual(entry?.items.map((item) => [item.kind, item.line, item.text]), [['disabled-added', 1, 'if (false) {']]);
});

test('4117587314 / 4117587318: a /** block around a moved test, or around kept test lines, is reported; one still open at a hunk gap is too', () => {
  const jsdocAroundMoved = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: "@@ -1,3 +1,5 @@\n-test('x', () => {\n-  assert.ok(run());\n-});\n+/**\n+test('x', () => {\n+  assert.ok(run());\n+});\n+ */" }]);
  assert.deepEqual(jsdocAroundMoved[0]?.items.map((item) => [item.kind, item.line, item.text]), [['disabled-added', 1, '/**']]);
  const aroundKept = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: "@@ -1,3 +1,5 @@\n+/*\n test('x', () => {\n   assert.ok(run());\n });\n+*/" }]);
  assert.deepEqual(aroundKept[0]?.items.map((item) => [item.kind, item.line]), [['disabled-added', 1]]);
  const openAtGap = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: "@@ -1,1 +1,2 @@\n+/*\n ctx\n@@ -40,1 +41,2 @@\n ctx\n+*/" }]);
  assert.deepEqual(openAtGap[0]?.items.map((item) => [item.kind, item.line]), [['disabled-added', 1]]);
});

test('4117560929: an opened block comment around moved tests is reported; a JSDoc opener, a closed one-line comment and a real condition are not', () => {
  const commented = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: "@@ -1,2 +1,4 @@\n-test('x', () => {\n-});\n+/*\n+test('x', () => {\n+});\n+*/" }]);
  assert.deepEqual(commented[0]?.items.map((item) => item.kind), ['disabled-added']);
  assert.deepEqual(detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: "@@ -1,1 +1,5 @@\n ctx\n+/**\n+ * helper\n+ */\n+/* eslint-disable no-console */\n+if (process.platform === 'win32') {" }]), []);
});

// 350bfd99: an added line whose only `/*` sits inside a string literal opened
// a "comment" that never closed. Each line below drew a false guard thread.
const addedThen = (text) => `@@ -1,1 +1,3 @@\n ctx\n+${text}\n+  assert.ok(run());`;
for (const [source, text] of [
  ['workit#246 conduct.test.mjs:584', "[{ contractPaths: 'scripts/**' }, /contractPaths must be an array of non-empty glob strings/],"],
  ['workit#246 repo-config.test.mjs:37', "const text = JSON.stringify({ contractPaths: ['a/**'], gateBackground: true });"],
  ['workit#248 land.test.mjs:1273', "const failing = { code: 3, stdout: JSON.stringify({ ok: false, failing: ['readme: missing (none of README.md)', 'ci: missing (no file matches .github/workflows/*.yml)'] }), stderr: '' };"],
  ['double quotes', 'const glob = "src/**/*.ts";'],
  ['backticks', 'const glob = `${root}/**`;'],
  ['an escaped quote inside the string', "const s = 'it\\'s in a/**';"],
  ['a // line comment', '// globs such as src/** are matched by name'],
  ['a comment closed on the line', '/* a */ x(); /**/'],
  ['a regex literal', 'assert.match(text, /a\\/*b/);'],
  ['a regex character class', 'const sep = /[/*]/;'],
]) {
  test(`350bfd99: a /* inside ${source} opens no comment`, () => {
    assert.deepEqual(detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: addedThen(text) }]), []);
  });
}

for (const [source, text] of [
  ['after a single-quoted string', "run('a'); /*"],
  ['after a string that holds a /*', 'run("a/*b"); /*'],
  ['after a string with an escaped quote', "const s = 'it\\'s'; /*"],
  ['after a closed comment', '/* a */ /*'],
  ['as a JSDoc /** at line start', '/**'],
  ['whose comment text holds a quote', "/* don't run"],
  // 4291712233 / 4291712242: a quote inside a regex literal is not a string.
  ['after a regex literal holding a quote', "const re = /'/; /*"],
  ['after a regex literal at line start', "/'/.test(s); /*"],
  ['after a regex literal following return', 'return /"/.test(s); /*'],
  ['after a division', 'const half = total / 2; /*'],
  // 4291764475 / 4291764494 / 4291764485: a postfix ++/-- ends an operand; a control condition's ) does not.
  ['after a division following postfix ++', 'const half = total++ / 2; /*'],
  ['after a division following postfix --', 'const half = total-- / 2; /*'],
  ['after a division following a call', 'const half = size(a) / 2; /*'],
  ['after a regex literal following an if condition', "if (ok(a)) /'/.test(s); /*"],
  ['after a regex literal following a while condition', "while (x) /'/.test(s); /*"],
]) {
  test(`350bfd99: a real opener ${source} is still reported`, () => {
    const [entry] = detectTestWeakening([{ filename: 'a.test.mjs', status: 'modified', patch: `@@ -1,1 +1,4 @@\n ctx\n+${text}\n+test('x', () => {});\n+*/` }]);
    assert.deepEqual(entry?.items.map((item) => [item.kind, item.line, item.text]), [['disabled-added', 2, text]]);
  });
}

for (const [id, patch] of [
  ['4117560930 (codex)', "@@ -1,3 +1,3 @@\n-test('critical', () => {\n-  verifyPayment();\n+test('placeholder', () => {\n+  noop();\n });"],
  ['4117560933 (astra)', "@@ -1,3 +1,2 @@\n-test('rejects invalid input', () => {\n-  checkRejectsInvalidInput();\n+test('placeholder', () => {\n });"],
]) {
  test(`${id}: a renamed declaration whose body lost a line is reported as a removed test`, () => {
    const [entry] = detectTestWeakening([{ filename: 'src/a.test.mjs', status: 'modified', patch }]);
    assert.deepEqual(entry?.items.map((item) => [item.kind, item.side, item.line]), [['test-removed', 'LEFT', 1]]);
  });
}

test('4117560938: a test file renamed out of the test paths is reported, pure rename or not', () => {
  const pureRename = { filename: 'src/a.mjs', previous_filename: 'src/a.test.mjs', status: 'renamed', changes: 0 };
  const pure = detectTestWeakening([pureRename]);
  assert.deepEqual(pure.map((entry) => [entry.path, entry.renamedOut, entry.previousPath, entry.items.length]), [['src/a.mjs', true, 'src/a.test.mjs', 0]]);
  const fromDiff = detectTestWeakening(filesFromDiff('diff --git a/src/a.test.mjs b/src/a.mjs\nsimilarity index 100%\nrename from src/a.test.mjs\nrename to src/a.mjs'));
  assert.deepEqual(fromDiff.map((entry) => [entry.path, entry.renamedOut]), [['src/a.mjs', true]]);
  const edited = detectTestWeakening([{ filename: 'src/a.mjs', previous_filename: 'src/a.test.mjs', status: 'renamed', changes: 2, patch: '@@ -1,1 +1,1 @@\n-// old\n+// new' }]);
  assert.deepEqual(edited.map((entry) => entry.renamedOut), [true]);
  const result = guardReview({ sourceFiles: [pureRename] });
  assert.match(result.section, /- `src\/a\.mjs`: renamed out of the test paths from `src\/a\.test\.mjs`, so no test runner picks it up/);
  // Renamed within the test paths stays silent.
  assert.deepEqual(detectTestWeakening([{ filename: 'tests/b.mjs', previous_filename: 'tests/a.mjs', status: 'renamed', changes: 0 }]), []);
});

test('guardReview renders a non-blocking body section, and nothing at all when no test was weakened', () => {
  const files = filesFromDiff(LOOSENED_ASSERTION);
  const result = guardReview({ sourceFiles: files, delta: true });
  assert.deepEqual(Object.keys(result).sort(), ['entries', 'section']);
  assert.match(result.section, /### Test files whose assertions changed/);
  assert.match(result.section, /nothing here needs a verdict to merge/);
  assert.equal(/\*\*lens:\*\* guard/.test(result.section), false, 'the section carries no lens tag a reply could read as a thread');
  const quiet = guardReview({ sourceFiles: filesFromDiff(REMOVED_IT.replace(/a\.spec\.ts/g, 'a.ts')) });
  assert.deepEqual(quiet, { entries: [], section: null });
});
