import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
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
  cmdThreads,
  cmdReply,
  cmdLens,
  buildReviewerPrompt,
  defaultCodexExe,
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
  const prompt = buildReviewerPrompt({ pr: 42, repo: 'owner/repo', prFilePaths: ['src/a.ts', 'docs/readme.md'] });
  assert.match(prompt, /gh pr diff 42 --repo owner\/repo/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /docs\/readme\.md/);
  assert.match(prompt, /READ-ONLY: modify nothing/);
  assert.match(prompt, /P1.*P2.*P3/s);
  assert.match(prompt, /Return ONLY JSON matching the schema/);
});

test('skill delegates prompt construction to the lens verb and requires reviewer diversity', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /pr-review\.mjs" lens/);
  assert.match(skill, /Reviewer ≠ author/);
  assert.match(skill, /Shadow arm \(measurement, opt-in\)/);
  assert.match(skill, /--lens codex\|opus/);
  assert.match(skill, /--reasoning low\|medium\|high/);
  assert.match(skill, /--measure-log <path>/);
  assert.match(skill, /--dry-run/);
  assert.match(skill, /status line added/);
});

test('skill documents required repo, blocking coverage, and examined_paths handback', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /--pr <n> --repo <owner\/name> --findings/);
  // Step 4's two commands must carry --repo too — fixing only `post` left the
  // cwd-resolution class open on the commands that read the merge-ready signal.
  assert.match(skill, /threads --pr <n> --repo <owner\/name> --unresolved/);
  assert.match(skill, /--pr <n> --repo <owner\/name> --comment-id <id> --body-file/);
  assert.match(skill, /\*\*Blocking per-handback coverage check\*\*/);
  assert.match(skill, /Handback contract: `summary`, `coverage`, `examined_paths`, and `findings`/);
});

test('skill says examined_paths is exact and bounds what the stale-set guard proves', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /`examined_paths` must be EXACTLY the authoritative list/);
  assert.match(skill, /Context-only paths are\s+extras and fail the check/);
  assert.match(skill, /detects stale or\s+missing path sets; it does\s+not prove that examination happened/);
});

test('skill distinguishes the two off-diff buckets and flags the unverified schema keywords', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /\*\*changed by this PR but not\s+line-anchorable\*\*/);
  assert.match(skill, /\*\*not a file this PR changes\*\*/);
  assert.match(skill, /`minLength: 1` and `uniqueItems: true`/);
  assert.match(skill, /UNVERIFIED against that date/);
});

test('skill states the force-post boundary and the threads truncation floor truthfully', () => {
  const skill = readFileSync(SKILL, 'utf8');
  // The old row claimed --force-post covered BOTH exit-5 triggers. It never
  // consults forcePost on the empty-list floor.
  assert.match(skill, /does \*\*not\*\* override the empty-file-list floor/);
  assert.match(skill, /unconditional and posts nothing no matter what flags you pass/);
  // All three exit-5 triggers named, count contradiction included.
  assert.match(skill, /a parseable `examined N of M` contradicts that list/);
  // The truncation floor and its follow-up.
  assert.match(skill, /exits\s+\*\*6\*\* with a truncation warning/);
  assert.match(skill, /Full `pageInfo` pagination is a known follow-up/);
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
  dryRun = false,
  coverage = 'examined 2 of 2 changed files',
  prFilePaths = ['src/a.ts', 'src/b.ts'],
  die,
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
  const throwingDie = (code, message) => {
    const err = new Error(message);
    err.code = code;
    throw err;
  };
  try {
    cmdPost(
      { pr: '42', repo: 'owner/repo', findings, forcePost, dryRun },
      { runGh, die: die ?? throwingDie, log: () => {} },
    );
  } catch (err) {
    error = err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { calls, error };
}

test('--dry-run posts nothing and is not an error', () => {
  // Every other non-posting path here has a POST-counting test; without this one
  // deleting `if (opts.dryRun) return` ships green and --dry-run posts for real.
  const { calls, error } = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'src/b.ts'],
    dryRun: true,
  });
  assert.equal(error, undefined);
  assert.equal(calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length, 0);
  // It must still have done the real work it is previewing.
  assert.equal(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'diff').length, 1);
});

test('every exit-5 floor stops the function, not just the process', () => {
  // `die` is an INJECTED seam. A non-terminating impl must not fall through to
  // the POST — an empty prSet makes checkCoverage return ok:true, which is
  // exactly the false clean the floor exists to prevent.
  const deaths = [];
  const recordingDie = (code, message) => deaths.push({ code, message });

  const empty = runPostWithFakeGh({
    examinedPaths: ['src/a.ts'],
    prFilePaths: [],
    die: recordingDie,
  });
  assert.equal(empty.error, undefined, 'the recording die does not throw');
  assert.equal(deaths[0]?.code, 5);
  assert.equal(
    empty.calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length,
    0,
    'empty-file-list floor must return, not fall through to the POST',
  );

  deaths.length = 0;
  const mismatch = runPostWithFakeGh({
    examinedPaths: ['src/a.ts', 'stale.ts'],
    die: recordingDie,
  });
  assert.equal(deaths[0]?.code, 5);
  assert.equal(
    mismatch.calls.filter(({ args }) => args[0] === 'api' && args.includes('POST')).length,
    0,
    'coverage-mismatch floor must return, not fall through to the POST',
  );
});

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
// cmdThreads — the merge-ready signal must never claim completeness it lacks
// ---------------------------------------------------------------------------

const thread = (over = {}) => ({
  isResolved: true,
  isOutdated: false,
  path: 'src/a.ts',
  line: 11,
  comments: { nodes: [{ databaseId: 1, author: { login: 'someone' }, body: 'a comment' }] },
  ...over,
});

function runThreadsWithFakeGh({ threads, unresolved = false }) {
  const calls = [];
  const logs = [];
  const deaths = [];
  const runGh = (args, opts) => {
    calls.push({ args, opts });
    return JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } },
    });
  };
  cmdThreads(
    { pr: '53', repo: 'owner/repo', unresolved },
    { runGh, die: (code, message) => deaths.push({ code, message }), log: (m) => logs.push(String(m)) },
  );
  return { calls, out: logs.join('\n'), deaths };
}

test('threads lists normally when nothing is truncated', () => {
  const { out, deaths } = runThreadsWithFakeGh({
    threads: [thread({ isResolved: false }), thread()],
  });
  assert.deepEqual(deaths, []);
  assert.match(out, /2 of 2 thread\(s\)/);
});

test('a full 100-thread page exits nonzero instead of claiming completeness', () => {
  // The exact silent-completeness class this PR removed from `post`, left
  // standing on the command that prints the merge verdict.
  const { out, deaths } = runThreadsWithFakeGh({
    threads: Array.from({ length: 100 }, () => thread()),
    unresolved: true,
  });
  assert.equal(deaths[0]?.code, 6);
  assert.match(deaths[0].message, /truncat/i);
  assert.doesNotMatch(
    out,
    /no unresolved review threads/,
    'the merge-ready signal must never be printed off a truncated page',
  );
});

test('a full 50-comment page on any one thread also exits nonzero', () => {
  const fat = thread({
    comments: {
      nodes: Array.from({ length: 50 }, (_, i) => ({
        databaseId: i + 1,
        author: { login: 'someone' },
        body: 'a comment',
      })),
    },
  });
  const { deaths } = runThreadsWithFakeGh({ threads: [thread({ isResolved: false }), fat] });
  assert.equal(deaths[0]?.code, 6);
  assert.match(deaths[0].message, /comments/i);
});

test('threads takes an injectable runGh — it no longer reaches the network to be tested', () => {
  const { calls } = runThreadsWithFakeGh({ threads: [thread()] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'api');
  assert.equal(calls[0].args[1], 'graphql');
  assert.ok(calls[0].args.includes('owner=owner'));
  assert.ok(calls[0].args.includes('name=repo'));
});

test('reply takes an injectable runGh and posts one reply to the given comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-reply-'));
  const bodyFile = join(dir, 'reply.md');
  const calls = [];
  try {
    writeFileSync(bodyFile, 'confirmed, fixed in abc1234', 'utf8');
    cmdReply(
      { pr: '53', repo: 'owner/repo', commentId: '99', bodyFile },
      {
        runGh: (args, opts) => {
          calls.push({ args, opts });
          return JSON.stringify({ html_url: 'https://example.test/reply' });
        },
        die: (code, message) => { throw Object.assign(new Error(message), { code }); },
        log: () => {},
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('repos/owner/repo/pulls/53/comments/99/replies'));
  assert.equal(JSON.parse(calls[0].opts.input).body, 'confirmed, fixed in abc1234');
});

// ---------------------------------------------------------------------------
// lens — second T1 reviewer and measurement instrument
// ---------------------------------------------------------------------------

function runLensWithFake({ lens = 'codex', result = JSON.stringify(VALID), codexOutput = result, beforeStatus = '', afterStatus = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-lens-'));
  const out = join(dir, 'findings.json');
  const measureLog = join(dir, 'measure.jsonl');
  const calls = [];
  const deaths = [];
  let statusCalls = 0;
  try {
    cmdLens(
      { pr: '42', repo: 'owner/repo', lens, cwd: 'C:/repo', out, measureLog },
      {
        run: (program, args, opts = {}) => {
          calls.push({ program, args, opts });
          if (args[0] === 'api') return 'src/a.ts\n';
          if (args.includes('status')) return ++statusCalls === 1 ? beforeStatus : afterStatus;
          if (args[0] === 'exec') {
            writeFileSync(args[args.indexOf('-o') + 1], codexOutput, 'utf8');
            return 'codex stdout that must not be parsed';
          }
          return result;
        },
        findCodexExe: () => 'C:/codex/vendor/bin/codex.exe',
        die: (code, message) => deaths.push({ code, message }),
        log: () => {},
        now: (() => { let clock = 100; return () => (clock += 25); })(),
      },
    );
    return {
      calls, deaths, outExists: existsSync(out), out: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
      tempOut: calls.find(({ args }) => args[0] === 'exec')?.args.at(-2),
      rows: existsSync(measureLog) ? readFileSync(measureLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('lens codex reads its -o findings file, builds the Terra argv, and sends every authoritative path on stdin', () => {
  const fromFile = JSON.stringify({ ...VALID, summary: 'read from codex -o file' });
  const { calls, deaths, out } = runLensWithFake({ codexOutput: fromFile });
  assert.deepEqual(deaths, []);
  const call = calls.find(({ args }) => args[0] === 'exec');
  assert.ok(call);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.ok(call.args.includes('model_reasoning_effort=high'));
  assert.ok(call.args.includes('--sandbox'));
  assert.ok(call.args.includes('danger-full-access'));
  const schemaPath = call.args[call.args.indexOf('--output-schema') + 1];
  assert.ok(schemaPath.endsWith('findings.schema.json'));
  assert.ok(existsSync(schemaPath));
  assert.ok(call.args.includes('--skip-git-repo-check'));
  const tempOut = call.args[call.args.indexOf('-o') + 1];
  assert.equal(relative(resolve(tmpdir()), resolve(tempOut)).startsWith('..'), false, '-o must be inside the temp directory');
  assert.deepEqual(call.args.slice(-1), ['-']);
  assert.match(call.opts.input, /src\/a\.ts/);
  assert.ok(call.args.includes('-C'));
  assert.equal(call.args[call.args.indexOf('-C') + 1], resolve('C:/repo'));
  assert.equal(out.summary, 'read from codex -o file', 'codex stdout must not replace its -o findings file');
});

test('lens opus builds the constrained structured-output argv', () => {
  const { calls, deaths } = runLensWithFake({ lens: 'opus', result: JSON.stringify({ result: JSON.stringify(VALID) }) });
  assert.deepEqual(deaths, []);
  const call = calls.find(({ args }) => args[0] === '-p');
  assert.ok(call.args.includes('--model'));
  assert.ok(call.args.includes('opus'));
  assert.ok(call.args.includes('--effort'));
  assert.ok(call.args.includes('low'));
  assert.ok(call.args.includes('--permission-mode'));
  assert.ok(call.args.includes('bypassPermissions'));
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(call.args.includes(tool));
  assert.ok(call.args.includes('--output-format'));
  assert.ok(call.args.includes('json'));
  assert.ok(call.args.includes('--json-schema'));
  assert.equal(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]).additionalProperties, false);
  assert.match(call.args.at(-1), /Review pull request #42/);
  assert.equal(call.opts.input, undefined, 'Claude -p receives its prompt positionally on this host');
});

test('lens opus accepts fenced result JSON, structured_output, and ignores an empty structured_output in favor of result', () => {
  const fenced = `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
  for (const result of [
    JSON.stringify({ result: fenced }),
    JSON.stringify({ structured_output: VALID }),
    JSON.stringify({ structured_output: {}, result: JSON.stringify(VALID) }),
  ]) {
    const { deaths, out } = runLensWithFake({ lens: 'opus', result });
    assert.deepEqual(deaths, []);
    assert.equal(out.lens, 'opus');
  }
});

test('the codex executable resolver uses plain codex outside Windows without mutating process.platform', () => {
  assert.equal(defaultCodexExe({ platform: 'linux' }), 'codex');
});

test('lens requires an explicit measurement log when no workspace root can be found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-no-workspace-'));
  const savedWorkspaceRoot = process.env.WORKIT_WORKSPACE_ROOT;
  const deaths = [];
  try {
    delete process.env.WORKIT_WORKSPACE_ROOT;
    cmdLens(
      { pr: '42', repo: 'owner/repo', lens: 'codex', cwd: dir, out: join(dir, 'findings.json') },
      { run: () => { throw new Error('measurement root must fail before any process starts'); }, die: (code, message) => deaths.push({ code, message }), log: () => {} },
    );
    assert.deepEqual(deaths, [{ code: 2, message: 'no workspace root found; pass --measure-log' }]);
  } finally {
    if (savedWorkspaceRoot === undefined) delete process.env.WORKIT_WORKSPACE_ROOT;
    else process.env.WORKIT_WORKSPACE_ROOT = savedWorkspaceRoot;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lens dry-run prints its argv and prompt path without invoking the injected runner', () => {
  const logs = [];
  cmdLens(
    { pr: '42', repo: 'owner/repo', lens: 'codex', cwd: 'C:/repo', out: 'findings.json', dryRun: true },
    { run: () => { throw new Error('dry-run must not run'); }, findCodexExe: () => 'C:/codex/vendor/bin/codex.exe', die: (code, message) => { throw Object.assign(new Error(message), { code }); }, log: (message) => logs.push(message) },
  );
  assert.match(logs.join('\n'), /argv:/);
  assert.match(logs.join('\n'), /prompt path:/);
});

test('lens rejects prose, a P4 handback, and incomplete coverage without writing --out or leaking its temp dir', () => {
  for (const result of [
    'this is not JSON',
    JSON.stringify({ ...VALID, findings: [finding({ severity: 'P4' })] }),
    JSON.stringify({ ...VALID, coverage: 'examined 1 of 1 changed files', examined_paths: ['other.ts'] }),
  ]) {
    const { deaths, outExists, tempOut } = runLensWithFake({ codexOutput: result });
    assert.equal(deaths[0]?.code, 3);
    assert.match(deaths[0]?.message ?? '', /output|severity/i);
    assert.equal(outExists, false);
    assert.equal(existsSync(dirname(tempOut)), false, 'failed validation must remove the lens temp dir before die()');
  }
});

test('lens stamps document/findings and appends one per-lens measurement row', () => {
  const { deaths, out, rows } = runLensWithFake({ result: JSON.stringify({ ...VALID, findings: [finding({ severity: 'P2' })] }) });
  assert.deepEqual(deaths, []);
  assert.equal(out.lens, 'codex');
  assert.equal(out.model, 'gpt-5.6-terra');
  assert.equal(out.reasoning, 'high');
  assert.equal(out.wall_ms, 25);
  assert.equal(out.findings[0].lens, 'codex');
  assert.equal(rows.length, 1);
  assert.deepEqual({ lens: rows[0].lens, p1: rows[0].p1, p2: rows[0].p2, p3: rows[0].p3, examined: rows[0].examined },
    { lens: 'codex', p1: 0, p2: 1, p3: 0, examined: 1 });
  assert.equal(rows[0].wall_ms, 25);
});

test('lens dirty-tree guard detects a new path on an already-dirty tree and records it', () => {
  const { deaths, outExists, rows } = runLensWithFake({ beforeStatus: ' M existing.ts\n', afterStatus: ' M existing.ts\n?? reviewer-created.ts\n' });
  assert.equal(deaths[0]?.code, 4);
  assert.match(deaths[0]?.message ?? '', /reviewer-created\.ts/);
  assert.equal(outExists, true);
  assert.deepEqual(rows.map((row) => row.dirty), [true]);
});

test('post combines lens findings, tags comment bodies, counts each lens, and guards their path union', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-post-lenses-'));
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  const calls = [];
  try {
    writeFileSync(a, JSON.stringify({ ...VALID, lens: 'codex', coverage: 'examined 2 of 2 changed files', examined_paths: ['src/a.ts', 'src/b.ts'], findings: [finding({ path: 'src/a.ts', line: 11, severity: 'P2' })] }));
    writeFileSync(b, JSON.stringify({ ...VALID, lens: 'opus', coverage: 'examined 2 of 2 changed files', examined_paths: ['src/a.ts', 'src/b.ts'], findings: [finding({ path: 'src/b.ts', line: 1, severity: 'P3' })] }));
    const runGh = (args, opts) => {
      calls.push({ args, opts });
      if (args[0] === 'pr') return DIFF;
      if (args[0] === 'api' && args[1] === '--paginate') return 'src/a.ts\nsrc/b.ts\n';
      if (args.includes('POST')) return JSON.stringify({ html_url: 'https://example.test/review' });
      throw new Error('unexpected gh call');
    };
    cmdPost({ pr: '42', repo: 'owner/repo', findings: [a, b] }, { runGh, die: (code, message) => { throw Object.assign(new Error(message), { code }); }, log: () => {} });
    const payload = JSON.parse(calls.find(({ args }) => args.includes('POST')).opts.input);
    assert.match(payload.comments[0].body, /\*\*lens:\*\* codex/);
    assert.match(payload.comments[1].body, /\*\*lens:\*\* opus/);
    assert.match(payload.body, /codex: 0 P1 \/ 1 P2 \/ 0 P3/);
    assert.match(payload.body, /opus: 0 P1 \/ 0 P2 \/ 1 P3/);

    writeFileSync(b, JSON.stringify({ ...VALID, lens: 'opus', examined_paths: ['not-in-pr.ts'], findings: [] }));
    assert.throws(() => cmdPost({ pr: '42', repo: 'owner/repo', findings: [a, b] }, { runGh, die: (code, message) => { throw Object.assign(new Error(message), { code }); }, log: () => {} }), /coverage check failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('post accepts two complete handbacks whose coverage paths use different separators', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-post-normalized-union-'));
  const codex = join(dir, 'codex.json');
  const opus = join(dir, 'opus.json');
  const slash = String.fromCharCode(92);
  let posted = false;
  try {
    writeFileSync(codex, JSON.stringify({ ...VALID, lens: 'codex', coverage: 'examined 2 of 2 changed files', examined_paths: ['src/a.ts', 'src/b.ts'] }));
    writeFileSync(opus, JSON.stringify({ ...VALID, lens: 'opus', coverage: 'examined 2 of 2 changed files', examined_paths: [`src${slash}a.ts`, `src${slash}b.ts`] }));
    cmdPost(
      { pr: '42', repo: 'owner/repo', findings: [codex, opus] },
      {
        runGh: (args) => {
          if (args[0] === 'pr') return DIFF;
          if (args[0] === 'api' && args[1] === '--paginate') return 'src/a.ts\nsrc/b.ts\n';
          if (args.includes('POST')) { posted = true; return JSON.stringify({ html_url: 'https://example.test/review' }); }
          throw new Error('unexpected gh call');
        },
        die: (code, message) => { throw Object.assign(new Error(message), { code }); },
        log: () => {},
      },
    );
    assert.equal(posted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('post refuses a partial individual lens even when another lens covers the union', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-post-partial-lens-'));
  const complete = join(dir, 'complete.json');
  const partial = join(dir, 'partial.json');
  try {
    writeFileSync(complete, JSON.stringify({ ...VALID, lens: 'codex', coverage: 'examined 2 of 2 changed files', examined_paths: ['src/a.ts', 'src/b.ts'], findings: [] }));
    writeFileSync(partial, JSON.stringify({ ...VALID, lens: 'opus', coverage: 'examined 1 of 2 changed files', examined_paths: ['src/a.ts'], findings: [] }));
    const runGh = (args) => {
      if (args[0] === 'pr') return DIFF;
      if (args[0] === 'api' && args[1] === '--paginate') return 'src/a.ts\nsrc/b.ts\n';
      throw new Error('unexpected gh call');
    };
    assert.throws(
      () => cmdPost({ pr: '42', repo: 'owner/repo', findings: [complete, partial] }, { runGh, die: (code, message) => { throw Object.assign(new Error(message), { code }); }, log: () => {} }),
      (err) => {
        assert.equal(err.code, 5);
        assert.match(err.message, /findings file .*reviewer examined 1 of 2 changed files — the review is partial/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reply verdict records the lens tag, or null when the comment has no tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-review-reply-measure-'));
  const bodyFile = join(dir, 'reply.md');
  const measureLog = join(dir, 'measure.jsonl');
  try {
    writeFileSync(bodyFile, 'refuted with evidence');
    for (const [body, lens] of [['**lens:** opus\n\n**[P2] title**', 'opus'], ['plain comment', null]]) {
      cmdReply(
        { pr: '42', repo: 'owner/repo', commentId: '99', bodyFile, verdict: 'refuted', measureLog },
        { runGh: (args) => args.includes('replies') ? JSON.stringify({ html_url: 'https://example.test/reply' }) : JSON.stringify({ body }), die: (code, message) => { throw Object.assign(new Error(message), { code }); }, log: () => {} },
      );
      const row = JSON.parse(readFileSync(measureLog, 'utf8').trim().split(/\r?\n/).at(-1));
      assert.equal(row.lens, lens);
      assert.equal(row.verdict, 'refuted');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema permits optional lens metadata but preserves additionalProperties false', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(validateFindingsShape({ ...VALID, lens: 'codex', model: 'gpt-5.6-terra', reasoning: 'high', wall_ms: 1, findings: [finding({ lens: 'codex' })] }), []);
  assert.match(validateFindingsShape({ ...VALID, unexpected: true }).join(' '), /unknown property/);
});

// ---------------------------------------------------------------------------
// Exit codes — the distinction the whole loop rests on
// ---------------------------------------------------------------------------

test('process launches never opt into shell parsing', () => {
  // Pinning the exact regression this file was born from: with `shell: true`,
  // Node joins the argv into one command string, so the multi-line GraphQL query
  // in `threads` arrived at gh as fragments and it reported "A query attribute
  // must be specified". gh is a real executable everywhere (gh.exe on Windows),
  // so no shell is needed. Source-level assertion — the behavioral proof is that
  // `threads` returns real data, which needs a live PR.
  const src = readFileSync(SCRIPT, 'utf8');
  for (const [name, start, end] of [
    ['gh()', 'export function gh(', 'function ghOrDie('],
    ['defaultRun()', 'function defaultRun(', 'export function defaultCodexExe('],
    ['defaultCodexExe()', 'export function defaultCodexExe(', 'function findWorkspaceRoot('],
  ]) {
    const body = src.slice(src.indexOf(start), src.indexOf(end));
    assert.doesNotMatch(body, /shell\s*:/, `${name} must not pass a shell option to execFileSync`);
  }
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

test('a malformed --repo is a usage error on every subcommand, with the value echoed', () => {
  // `own/er/repo` used to sail through: cmdThreads destructures [owner, name]
  // and drops the third segment, so `threads` printed "no unresolved review
  // threads" — the merge-ready signal — about a DIFFERENT repository.
  const bad = ['own/er/repo', 'noslash', 'owner/', '/name', 'own er/repo', ''];
  for (const repo of bad) {
    const r = runCli(['threads', '--pr', '53', '--repo', repo]);
    assert.equal(r.code, 2, `expected exit 2 for --repo ${JSON.stringify(repo)}`);
    assert.match(r.stderr, /--repo must be owner\/name/);
    if (repo !== '') assert.ok(r.stderr.includes(repo), 'the rejected value must be echoed');
  }
  for (const cmd of [
    ['post', '--pr', '1', '--repo', 'own/er/repo', '--findings', 'f.json'],
    ['reply', '--pr', '1', '--repo', 'own/er/repo', '--comment-id', '1', '--body-file', 'x.md'],
  ]) {
    const r = runCli(cmd);
    assert.equal(r.code, 2, `expected exit 2 for ${cmd[0]}`);
    assert.match(r.stderr, /--repo must be owner\/name/);
  }
  // A well-formed value must still get past parsing.
  assert.equal(parseArgs(['threads', '--pr', '1', '--repo', 'sirmaelstrom/workit']).repo, 'sirmaelstrom/workit');
});

test('reply requires --repo', () => {
  const r = runCli(['reply', '--pr', '53', '--comment-id', '1', '--body-file', 'x.md']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /reply needs --repo owner\/name/);
});
