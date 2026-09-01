import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseDiff,
  countChangedFiles,
  fetchPrFilePaths,
  gh,
  partitionFindings,
  checkCoverage,
  validateFindingsShape,
  buildReviewPayload,
  parseArgs,
  cmdPost,
} from './pr-review.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pr-review.mjs');
const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'findings.schema.json');
const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');

test('fetchPrFilePaths reads paths from the authoritative PR files API', () => {
  const calls = [];
  const paths = fetchPrFilePaths('owner/repo', 42, 'C:/repo', (args, opts) => {
    calls.push({ args, opts });
    return 'src/a.ts\ndocs/readme.md\n';
  });
  assert.deepEqual(paths, ['src/a.ts', 'docs/readme.md']);
  assert.deepEqual(calls, [{
    args: ['api', '--paginate', 'repos/owner/repo/pulls/42/files', '--jq', '.[].filename'],
    opts: { cwd: 'C:/repo' },
  }]);
});

test('fetchPrFilePaths collects every path from paginated REST output beyond 100 files', () => {
  const expected = Array.from({ length: 152 }, (_, i) => `src/file-${i + 1}.ts`);
  const calls = [];
  const paths = fetchPrFilePaths('owner/repo', 42, 'C:/repo', (args, opts) => {
    calls.push({ args, opts });
    return `${expected.slice(0, 100).join('\n')}\n${expected.slice(100).join('\n')}\n`;
  });
  assert.deepEqual(paths, expected);
  assert.deepEqual(calls, [{
    args: ['api', '--paginate', 'repos/owner/repo/pulls/42/files', '--jq', '.[].filename'],
    opts: { cwd: 'C:/repo' },
  }]);
});

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

test('parseDiff does not invent a line from the diff\'s own trailing newline', () => {
  // Real `gh pr diff` stdout always ends with a newline. Splitting on it yields a
  // trailing '' that falls through the `raw === ''` branch inside the last hunk
  // and marks one line past the true end as commentable — and a finding anchored
  // there makes GitHub reject the WHOLE single-POST review (exit 4).
  const withNewline = parseDiff(`${DIFF}\n`);
  assert.deepEqual([...withNewline.get('src/b.ts')].sort((x, y) => x - y), [1, 2]);
  assert.deepEqual(
    [...withNewline.get('src/b.ts')],
    [...parseDiff(DIFF).get('src/b.ts')],
    'a trailing newline must not change the commentable set',
  );
  // Same for the CRLF form gh emits on Windows.
  const crlf = parseDiff(`${DIFF.replace(/\n/g, '\r\n')}\r\n`);
  assert.deepEqual([...crlf.get('src/b.ts')].sort((x, y) => x - y), [1, 2]);
});

test('parseDiff tolerates CRLF input', () => {
  const files = parseDiff(DIFF.replace(/\n/g, '\r\n'));
  assert.deepEqual([...files.get('src/a.ts')].sort((x, y) => x - y), [10, 11, 12, 13]);
});

// ---------------------------------------------------------------------------
// countChangedFiles — must NOT be parseDiff().size
// ---------------------------------------------------------------------------

test('countChangedFiles counts every changed file', () => {
  assert.equal(countChangedFiles(DIFF), 2);
});

test('countChangedFiles counts a deleted file, which has no commentable side', () => {
  const del = ['diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n');
  assert.equal(parseDiff(del).size, 0, 'nothing is commentable on a deletion');
  assert.equal(countChangedFiles(del), 1, 'but it is still a changed file');
});

test('countChangedFiles counts a binary file, which produces no hunk', () => {
  const bin = [
    'diff --git a/img.png b/img.png',
    'index 111..222 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  assert.equal(parseDiff(bin).size, 0);
  assert.equal(countChangedFiles(bin), 1);
});

test('countChangedFiles counts a pure rename, which produces no hunk', () => {
  const ren = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
  ].join('\n');
  assert.equal(countChangedFiles(ren), 1);
});

// ---------------------------------------------------------------------------
// partitionFindings
// ---------------------------------------------------------------------------

const finding = (over) => ({ severity: 'P2', title: 't', path: 'src/a.ts', line: 11, body: 'b', ...over });

test('partitionFindings splits anchorable, off-line and off-diff findings', () => {
  const diffFiles = parseDiff(DIFF);
  const { anchored, offLine, offDiffUnchanged } = partitionFindings(
    [
      finding({ line: 11 }),
      finding({ line: 999 }),
      finding({ path: 'src/never-touched.ts', line: 3 }),
    ],
    diffFiles,
    ['src/a.ts', 'src/b.ts'],
  );
  assert.equal(anchored.length, 1);
  assert.equal(anchored[0].line, 11);
  assert.equal(offLine.length, 1);
  assert.equal(offLine[0].line, 999);
  assert.equal(offDiffUnchanged.length, 1);
  assert.equal(offDiffUnchanged[0].path, 'src/never-touched.ts');
});

test('partitionFindings separates a changed-but-unanchorable file from an unchanged one', () => {
  // `gone.ts` is deleted by the PR: the files API lists it, parseDiff's
  // commentable map never will. Same for binaries and pure renames.
  const diffFiles = parseDiff(DIFF);
  const { offDiffChanged, offDiffUnchanged } = partitionFindings(
    [finding({ path: 'gone.ts', line: 3 }), finding({ path: 'src/never-touched.ts', line: 3 })],
    diffFiles,
    ['src/a.ts', 'src/b.ts', 'gone.ts'],
  );
  assert.deepEqual(offDiffChanged.map((f) => f.path), ['gone.ts']);
  assert.deepEqual(offDiffUnchanged.map((f) => f.path), ['src/never-touched.ts']);
});

test('partitionFindings normalizes backslash and ./ paths before matching', () => {
  const diffFiles = parseDiff(DIFF);
  const { anchored } = partitionFindings(
    [finding({ path: 'src\\a.ts' }), finding({ path: './src/a.ts' })],
    diffFiles,
    ['src/a.ts', 'src/b.ts'],
  );
  assert.equal(anchored.length, 2);
  assert.equal(anchored[0].path, 'src/a.ts');
});

// ---------------------------------------------------------------------------
// checkCoverage
// ---------------------------------------------------------------------------

test('checkCoverage accepts a full, truthful claim', () => {
  assert.equal(checkCoverage('examined 2 of 2 changed files.', ['a', 'b'], ['a', 'b']).ok, true);
});

test('checkCoverage rejects a total that contradicts the matching path set', () => {
  const r = checkCoverage('examined 5 of 5 changed files.', ['a', 'b'], ['a', 'b']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contradicts examined_paths/);
  assert.match(r.reason, /claims 5 changed files, the PR API has 2/);
});

test('checkCoverage rejects a count claim that contradicts the matching path set', () => {
  const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const r = checkCoverage('examined 3 of 7 changed files', paths, paths);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contradicts examined_paths/);
  assert.match(r.reason, /examined 3 of 7/);
});

test('checkCoverage keeps a count-free coverage string as a secondary message', () => {
  const r = checkCoverage('I looked at everything.', ['a'], ['a']);
  assert.equal(r.ok, true);
  assert.match(r.countReason, /does not state/);
});

test('checkCoverage keeps an unparsable count as a secondary message', () => {
  const r = checkCoverage('examined many of many changed files', ['a'], ['a']);
  assert.equal(r.ok, true);
  assert.match(r.countReason, /does not state/);
});

test('checkCoverage accepts equal normalized examined and API path sets', () => {
  const r = checkCoverage(
    'examined 2 of 2 changed files',
    ['./src/a.ts', 'docs\\readme.md'],
    ['src/a.ts', 'docs/readme.md'],
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
});

test('checkCoverage names missing and extra paths, with count mismatch secondary', () => {
  const r = checkCoverage(
    'examined 9 of 9 changed files',
    ['src/a.ts', 'stale.ts'],
    ['src/a.ts', 'src/current.ts'],
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['src/current.ts']);
  assert.deepEqual(r.extra, ['stale.ts']);
  assert.match(r.reason, /missing: src\/current\.ts/);
  assert.match(r.reason, /extra: stale\.ts/);
  assert.match(r.reason, /Secondary count check: reviewer claims 9 changed files, the PR API has 2/);
});

test('checkCoverage rejects a stale same-count path set', () => {
  const r = checkCoverage(
    'examined 2 of 2 changed files',
    ['a.ts', 'stale.ts'],
    ['a.ts', 'b.ts'],
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['b.ts']);
  assert.deepEqual(r.extra, ['stale.ts']);
});

// ---------------------------------------------------------------------------
// validateFindingsShape
// ---------------------------------------------------------------------------

const VALID = {
  summary: 's',
  coverage: 'examined 1 of 1 changed files',
  examined_paths: ['src/a.ts'],
  findings: [finding()],
};

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
  const problems = validateFindingsShape({ summary: 's', coverage: 'c', examined_paths: [] });
  assert.match(problems.join(' '), /findings must be an array/);
});

test('validateFindingsShape requires examined_paths as an array of non-empty strings', () => {
  assert.match(validateFindingsShape({ ...VALID, examined_paths: undefined }).join(' '), /examined_paths must be an array/);
  assert.match(validateFindingsShape({ ...VALID, examined_paths: ['src/a.ts', ''] }).join(' '), /examined_paths\[1\]/);
});

test('validateFindingsShape requires the examined N of M coverage format', () => {
  // Prose disarms the count check entirely: "I reviewed the whole thing" passes
  // and posts, while an honest "examined 1 of 2" exits 5. Block the prose.
  for (const coverage of ['I reviewed the whole thing.', 'examined many of many changed files', 'complete']) {
    assert.match(
      validateFindingsShape({ ...VALID, coverage }).join(' '),
      /coverage must state "examined N of M"/,
      `expected ${JSON.stringify(coverage)} to be rejected`,
    );
  }
  assert.deepEqual(validateFindingsShape({ ...VALID, coverage: 'examined 1 of 1 changed files' }), []);
});

test('validateFindingsShape rejects an empty examined_paths — zero input is not a clean review', () => {
  const problems = validateFindingsShape({ ...VALID, examined_paths: [] });
  assert.match(problems.join(' '), /examined_paths must not be empty/);
});

test('validateFindingsShape rejects duplicate examined_paths like the schema does', () => {
  const problems = validateFindingsShape({ ...VALID, examined_paths: ['src/a.ts', 'src/a.ts'] });
  assert.match(problems.join(' '), /examined_paths must not contain duplicates/);
});

test('findings schema requires examined_paths strings', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  assert.ok(schema.required.includes('examined_paths'));
  assert.equal(schema.properties.examined_paths.type, 'array');
  assert.equal(schema.properties.examined_paths.items.type, 'string');
});

test('reviewer prompt carries the authoritative API paths and requires them echoed back', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /Authoritative PR file list \(from `gh api --paginate repos\/<owner>\/<repo>\/pulls\/<n>\/files --jq '\.\[\]\.filename'`\):/);
  assert.match(skill, /Echo every path from that authoritative\s+list into `examined_paths`/);
});

test('skill documents required repo, blocking coverage, and examined_paths handback', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /--pr <n> --repo <owner\/name> --findings/);
  // Step 4's two commands must carry --repo too — fixing only `post` left the
  // cwd-resolution class open on the commands that read the merge-ready signal.
  assert.match(skill, /threads --pr <n> --repo <owner\/name> --unresolved/);
  assert.match(skill, /--pr <n> --repo <owner\/name> --comment-id <id> --body-file/);
  assert.match(skill, /\*\*Blocking coverage set check\*\*/);
  assert.match(skill, /Handback contract: `summary`, `coverage`, `examined_paths`, and `findings`/);
});

test('skill says examined_paths is exact and bounds what the stale-set guard proves', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /`examined_paths` must be EXACTLY the authoritative list/);
  assert.match(skill, /Context-only paths are\s+extras and fail the check/);
  assert.match(skill, /detects stale or\s+missing path sets; it does not prove that examination happened/);
});

test('skill distinguishes the two off-diff buckets and flags the unverified schema keywords', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /\*\*changed by this PR but not\s+line-anchorable\*\*/);
  assert.match(skill, /\*\*not a file this PR changes\*\*/);
  assert.match(skill, /`minLength: 1` and `uniqueItems: true`/);
  assert.match(skill, /UNVERIFIED against that date/);
});

// ---------------------------------------------------------------------------
// buildReviewPayload
// ---------------------------------------------------------------------------

test('buildReviewPayload emits COMMENT with line-anchored comments', () => {
  const p = buildReviewPayload({
    summary: 'Looks mostly fine.',
    coverage: 'examined 2 of 2 changed files',
    anchored: [finding()],
    offDiffChanged: [],
    offDiffUnchanged: [],
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
  assert.match(p.body, /1 anchored · 0 off-line · 0 not-anchorable · 0 off-diff/);
});

test('buildReviewPayload surfaces an off-diff finding in the body, not silently', () => {
  const p = buildReviewPayload({
    summary: 's',
    coverage: 'examined 1 of 1 changed files',
    anchored: [],
    offDiffChanged: [],
    offDiffUnchanged: [finding({ path: 'other.ts' })],
    offLine: [],
    coverageCheck: { ok: true },
  });
  assert.equal(p.comments.length, 0);
  assert.match(p.body, /not a file this PR changes/);
  assert.match(p.body, /other\.ts:11/);
});

test('buildReviewPayload words the two off-diff buckets differently', () => {
  const p = buildReviewPayload({
    summary: 's',
    coverage: 'examined 3 of 3 changed files',
    anchored: [],
    offDiffChanged: [finding({ path: 'gone.ts' })],
    offDiffUnchanged: [finding({ path: 'other.ts' })],
    offLine: [],
    coverageCheck: { ok: true },
  });
  assert.match(p.body, /`gone\.ts:11` — \*\*changed by this PR, but not line-anchorable/);
  assert.match(p.body, /`other\.ts:11` — \*\*not a file this PR changes\.\*\*/);
  // The false statement must not be published about a file the PR does change.
  assert.doesNotMatch(p.body, /gone\.ts[^\n]*does not change that file/);
});

test('buildReviewPayload warns, non-blocking, when the diff and the file list disagree', () => {
  const warned = buildReviewPayload({
    summary: 's',
    coverage: 'examined 2 of 2 changed files',
    anchored: [],
    offDiffChanged: [],
    offDiffUnchanged: [],
    offLine: [],
    coverageCheck: { ok: true },
    warnings: ['diff shows 3 changed files, the PR API lists 2'],
  });
  assert.match(warned.body, /diff shows 3 changed files, the PR API lists 2/);
  assert.doesNotMatch(warned.body, /Coverage check failed/, 'a warning must not read as a failure');

  const quiet = buildReviewPayload({
    summary: 's',
    coverage: 'examined 2 of 2 changed files',
    anchored: [],
    offDiffChanged: [],
    offDiffUnchanged: [],
    offLine: [],
    coverageCheck: { ok: true },
  });
  assert.doesNotMatch(quiet.body, /⚠️/);
});

test('cmdPost warns when diffHeaderCount and the PR file list diverge, and still posts', () => {
  // DIFF has 2 `diff --git` headers; the files API here lists 3.
  const { calls, error } = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'src/b.ts', 'gone.ts'],
    coverage: 'examined 3 of 3 changed files',
    prFilePaths: ['src/a.ts', 'src/b.ts', 'gone.ts'],
  });
  assert.equal(error, undefined);
  const posts = calls.filter(({ args }) => args[0] === 'api' && args.includes('POST'));
  assert.equal(posts.length, 1);
  assert.match(JSON.parse(posts[0].opts.input).body, /diff shows 2 changed files, the PR API lists 3/);
});

test('buildReviewPayload banners a failed coverage check into the posted body', () => {
  const p = buildReviewPayload({
    summary: 's',
    coverage: 'examined 1 of 9 changed files',
    anchored: [],
    offDiffChanged: [],
    offDiffUnchanged: [],
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

test('parseArgs reads the explicit force-post escape hatch', () => {
  const o = parseArgs(['post', '--pr', '12', '--findings', 'f.json', '--force-post']);
  assert.equal(o.forcePost, true);
});

function runPostWithFakeGh({
  examinedPaths,
  forcePost = false,
  coverage = 'examined 2 of 2 changed files',
  prFilePaths = ['src/a.ts', 'src/b.ts'],
}) {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-post-'));
  const findings = join(dir, 'findings.json');
  const calls = [];
  let error;
  writeFileSync(findings, JSON.stringify({
    summary: 'summary',
    coverage,
    examined_paths: examinedPaths,
    findings: [],
  }), 'utf8');
  const runGh = (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'pr' && args[1] === 'diff') return DIFF;
    if (args[0] === 'api' && args[1] === '--paginate') {
      return prFilePaths.length === 0 ? '' : `${prFilePaths.join('\n')}\n`;
    }
    if (args[0] === 'api' && args.includes('POST')) return JSON.stringify({ html_url: 'https://example.test/review' });
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const die = (code, message) => {
    const err = new Error(message);
    err.code = code;
    throw err;
  };
  try {
    cmdPost(
      { pr: '42', repo: 'owner/repo', findings, forcePost },
      { runGh, die, log: () => {} },
    );
  } catch (err) {
    error = err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { calls, error };
}

test('coverage mismatch exits 5 and makes zero review POST calls', () => {
  const { calls, error } = runPostWithFakeGh({ examinedPaths: ['src/a.ts', 'stale.ts'] });
  assert.equal(error?.code, 5);
  assert.equal(calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length, 0);
});

test('--force-post sends one mismatched review with the coverage banner', () => {
  const { calls, error } = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'stale.ts'],
    forcePost: true,
  });
  assert.equal(error, undefined);
  const posts = calls.filter(({ args }) => args[0] === 'api' && args.includes('POST'));
  assert.equal(posts.length, 1);
  assert.match(JSON.parse(posts[0].opts.input).body, /Coverage check failed/);
});

test('a count contradiction with a matching path set exits 5 and posts nothing', () => {
  // The count branch is nested inside `missing.length === 0 && extra.length === 0`
  // — the structure a refactor flattens away — and every other integration test
  // here exercises only the path-set branch.
  const { calls, error } = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'src/b.ts'],
    coverage: 'examined 1 of 2 changed files',
  });
  assert.equal(error?.code, 5);
  assert.match(error.message, /examined 1 of 2 changed files — the review is partial/);
  assert.equal(calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length, 0);
});

test('an over-claimed count exits 5 too — the widened !== check runs in both directions', () => {
  // `claimedTotal` must MATCH the PR file count, or the total-mismatch branch
  // fires first and this never reaches `examined !== claimedTotal`.
  const { calls, error } = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'src/b.ts'],
    coverage: 'examined 5 of 2 changed files',
  });
  assert.equal(error?.code, 5);
  assert.match(error.message, /reviewer examined 5 of 2 changed files/);
  assert.equal(calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length, 0);
});

test('checkCoverage rejects an over-claim in the examined direction', () => {
  // The hardening commit widened `examined < claimedTotal` to `!==`; nothing
  // covered the direction that widening added.
  const paths = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
  const r = checkCoverage('examined 12 of 9 changed files', paths, paths);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contradicts examined_paths/);
  assert.match(r.reason, /reviewer examined 12 of 9 changed files/);
});

test('an empty PR file list exits 5 and posts nothing — a fetch failure is not a clean PR', () => {
  const { calls, error } = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'src/b.ts'],
    prFilePaths: [],
  });
  assert.equal(error?.code, 5);
  assert.match(error.message, /PR API returned no changed files/);
  assert.equal(calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length, 0);
});

test('matching coverage sends one review without a mismatch banner', () => {
  const { calls, error } = runPostWithFakeGh({ examinedPaths: ['src/a.ts', 'src/b.ts'] });
  assert.equal(error, undefined);
  const posts = calls.filter(({ args }) => args[0] === 'api' && args.includes('POST'));
  assert.equal(posts.length, 1);
  assert.doesNotMatch(JSON.parse(posts[0].opts.input).body, /Coverage check failed/);
});

// ---------------------------------------------------------------------------
// Exit codes — the distinction the whole loop rests on
// ---------------------------------------------------------------------------

test('gh() never spawns through a shell — a shell concatenates argv instead of escaping it', () => {
  // Pinning the exact regression this file was born from: with `shell: true`,
  // Node joins the argv into one command string, so the multi-line GraphQL query
  // in `threads` arrived at gh as fragments and it reported "A query attribute
  // must be specified". gh is a real executable everywhere (gh.exe on Windows),
  // so no shell is needed. Source-level assertion — the behavioral proof is that
  // `threads` returns real data, which needs a live PR.
  const src = readFileSync(SCRIPT, 'utf8');
  const body = src.slice(src.indexOf('export function gh('), src.indexOf('function ghOrDie('));
  assert.doesNotMatch(body, /shell\s*:/, 'gh() must not pass a shell option to execFileSync');
  assert.equal(typeof gh, 'function');
});

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
    const r = runCli(['post', '--pr', '1', '--repo', 'owner/repo', '--findings', join(dir, 'nope.json')]);
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
    const r = runCli(['post', '--pr', '1', '--repo', 'owner/repo', '--findings', f]);
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
    const r = runCli(['post', '--pr', '1', '--repo', 'owner/repo', '--findings', f]);
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

test('post requires an explicit --repo before reading findings or resolving cwd', () => {
  const r = runCli(['post', '--pr', '1', '--findings', 'missing.json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /post needs --repo owner\/name/);
});

test('threads requires --repo — same-number-different-repo reads as "no unresolved threads"', () => {
  const r = runCli(['threads', '--pr', '53', '--unresolved']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /threads needs --repo owner\/name/);
  // Exit 2 must land before any gh call, so a wrong cwd can never answer.
  assert.doesNotMatch(r.stderr, /gh /);
});

test('reply requires --repo', () => {
  const r = runCli(['reply', '--pr', '53', '--comment-id', '1', '--body-file', 'x.md']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /reply needs --repo owner\/name/);
});
