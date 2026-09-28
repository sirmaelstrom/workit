/**
 * pr-review-guard.mjs — the test-weakening check `post` runs over the patches
 * it already holds.
 *
 * A lane can go green by deleting, skipping or loosening the test that
 * reported the failure. This module finds the textual signs of that in a diff
 * and nothing more: it does not judge whether a removal was legitimate. A false
 * positive costs one adjudication row; a missed deletion is the failure the
 * check exists for, so the patterns lean wide.
 *
 * Pure: no I/O. `post` feeds it the PR diff on a full review and the
 * `<since>...<head>` compare on an amendment check, so a delta round sees only
 * what the amendment removed.
 */

/**
 * What counts as a test file. Matched against the new path and, for a rename,
 * the old one. Extend by adding a row.
 */
export const TEST_FILE_PATTERNS = Object.freeze([
  { name: '*.test.*', pattern: /\.test\.[^/]+$/i },
  { name: '*.spec.*', pattern: /\.spec\.[^/]+$/i },
  { name: '__tests__/', pattern: /(^|\/)__tests__\// },
  { name: 'tests/', pattern: /(^|\/)tests\// },
  { name: 'test/', pattern: /(^|\/)test\// },
  { name: '*Tests.cs', pattern: /Tests\.cs$/ },
]);

/**
 * The line patterns, one table. `on` says which side of the diff a match is
 * reported from: `removed` lines (a test case or an assertion taken out) or
 * `added` lines (a skip or a focus put in). Extend by adding a pattern to a row.
 */
export const GUARD_PATTERNS = Object.freeze([
  {
    kind: 'test-removed',
    on: 'removed',
    label: 'test case removed',
    patterns: [
      // test( it( describe( and their .each / modifier forms; not `re.test(`
      /(?<![\w.$])(?:test|it|describe)(?:\.(?:each|only|skip|todo|concurrent|serial))*\s*[(`]/,
      /\[\s*(?:Fact|Theory|Test|TestCase|TestMethod)\b/,
    ],
  },
  {
    kind: 'skip-added',
    on: 'added',
    label: 'skip or focus added',
    patterns: [
      /\.(?:skip|only|todo)\b/,
      /(?<![\w.$])x(?:it|describe|test)\s*[(`]/,
      /\.(?:skipIf|runIf)\s*\(/,
      // node:test options: test('x', { skip: true }, ...)
      /\b(?:skip|only|todo)\s*:\s*(?:true|['"`])/,
      /\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=/,
      /\[\s*Ignore\b/,
    ],
  },
  {
    kind: 'assertion-removed',
    on: 'removed',
    label: 'assertion removed or changed',
    patterns: [
      /(?<![\w.$])assert(?:\.|\s*\()/,
      /(?<![\w.$])expect\s*\(/,
      /(?<![\w.$])Assert\./,
      /\.Should\(\)/,
    ],
  },
]);

export function isTestFile(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some(({ pattern }) => pattern.test(normalized));
}

function classify(text, on) {
  return GUARD_PATTERNS.filter((row) => row.on === on && row.patterns.some((pattern) => pattern.test(text)));
}

/**
 * The key two test declarations share when one is a rename of the other: the
 * line with its string literals blanked and its skip/only/todo modifier
 * dropped. `test('old', …)` → `test('new', …)` pairs; so do
 * `it('x')` → `it.skip('x')` and `[Fact]` → `[Fact(Skip = "…")]`, whose skip
 * is reported on its own row.
 */
function declarationKey(text) {
  return text
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\.(?:only|skip|todo)\b/g, '')
    .replace(/\(\s*Skip\s*=\s*""\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a unified diff (`gh pr diff`) into per-file entries in the compare
 * API's shape: `{ filename, previous_filename?, status, patch }`.
 */
export function filesFromDiff(diffText) {
  const files = [];
  let current = null;
  let inPatch = false;
  for (const raw of String(diffText).replace(/\r?\n$/, '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      current = { filename: m?.[2] ?? null, previous_filename: m?.[1] ?? null, status: 'modified', binary: false, patchLines: [] };
      files.push(current);
      inPatch = false;
      continue;
    }
    if (!current) continue;
    if (!inPatch) {
      if (raw.startsWith('deleted file mode')) current.status = 'removed';
      else if (raw.startsWith('new file mode')) current.status = 'added';
      else if (raw.startsWith('rename from ')) { current.status = 'renamed'; current.previous_filename = raw.slice(12); }
      else if (raw.startsWith('rename to ')) current.filename = raw.slice(10);
      else if (raw.startsWith('Binary files ')) current.binary = true;
      else if (raw.startsWith('--- ')) {
        const source = raw.slice(4).trim();
        if (source !== '/dev/null') current.previous_filename = source.replace(/^a\//, '');
      } else if (raw.startsWith('+++ ')) {
        const target = raw.slice(4).trim();
        if (target === '/dev/null') current.status = 'removed';
        else current.filename = target.replace(/^b\//, '');
      } else if (raw.startsWith('@@')) {
        inPatch = true;
        current.patchLines.push(raw);
      }
      continue;
    }
    current.patchLines.push(raw);
  }
  return files.map(({ patchLines: lines, filename, previous_filename: previous, status, binary }) => {
    // A deleted file's only name is its old one.
    const name = status === 'removed' ? (previous ?? filename) : filename;
    return {
      filename: name,
      ...(previous && previous !== name ? { previous_filename: previous } : {}),
      status,
      patch: lines.join('\n'),
      // No hunk and not binary: git saw no content change (a pure rename or a
      // mode change), which the compare API reports as `changes: 0`.
      ...(lines.length === 0 && !binary && status !== 'removed' ? { changes: 0 } : {}),
    };
  });
}

/**
 * Walk one file's patch into its removed and added lines, each with the line
 * number on its own side (`old` for removed, `new` for added). `at` is the
 * post-change line the change sits at, which the nearest-line fallback uses.
 */
export function patchLines(patch) {
  const removed = [];
  const added = [];
  const context = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of String(patch ?? '').split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('-')) removed.push({ line: oldLine++, text: raw.slice(1), at: newLine });
    else if (raw.startsWith('+')) added.push({ line: newLine++, text: raw.slice(1) });
    else if (raw.startsWith('\\')) continue;
    else if (raw.startsWith(' ') || raw === '') context.push({ old: oldLine++, line: newLine++, text: raw.slice(1) });
    else inHunk = false;
  }
  return { removed, added, context };
}

/** Take one entry for `key` from a multiset, reporting whether there was one. */
function take(multiset, key) {
  const n = multiset.get(key) ?? 0;
  if (n === 0) return false;
  multiset.set(key, n - 1);
  return true;
}

function countBy(lines, keyOf) {
  const multiset = new Map();
  for (const line of lines) {
    const key = keyOf(line.text);
    if (key === '') continue;
    multiset.set(key, (multiset.get(key) ?? 0) + 1);
  }
  return multiset;
}

/**
 * The detector. One entry per changed test file that shows a sign of
 * weakening:
 *
 *   { path, status, deleted: true, patchMissing, removedTests, removedAssertions }
 *   { path, status, deleted: false, unchecked: true, items: [] }
 *   { path, status, deleted: false, items: [{ kind, label, side, line, text, at? }] }
 *
 * `side` is GitHub's review-comment side: `LEFT` for a removed line (numbered
 * in the pre-change file), `RIGHT` for an added one. A line removed and re-added
 * unchanged elsewhere in the same file (compared trimmed) is a move and is not
 * reported. A removed test declaration whose rename-key reappears among the
 * added lines is a rename and is not reported either.
 *
 * A changed test file with no patch (GitHub omits it on a large diff, and a
 * binary file has none) cannot be read, so it is reported `unchecked`: a thread
 * that says nothing was checked, rather than silence. An added file and one
 * with `changes: 0` (a pure rename or a mode change) have nothing to remove.
 */
export function detectTestWeakening(files) {
  const report = [];
  for (const file of files ?? []) {
    const path = file.filename;
    if (!isTestFile(path) && !isTestFile(file.previous_filename)) continue;
    const patchMissing = typeof file.patch !== 'string' || file.patch.trim() === '';
    if (patchMissing && file.status !== 'removed') {
      if (file.status === 'added' || file.changes === 0) continue;
      report.push({ path, status: file.status, deleted: false, unchecked: true, items: [] });
      continue;
    }
    const { removed, added } = patchLines(file.patch);
    if (file.status === 'removed') {
      report.push({
        path,
        status: file.status,
        deleted: true,
        patchMissing,
        firstLine: removed[0]?.line ?? null,
        removedTests: removed.filter((line) => classify(line.text, 'removed').some((row) => row.kind === 'test-removed')).length,
        removedAssertions: removed.filter((line) => classify(line.text, 'removed').some((row) => row.kind === 'assertion-removed')).length,
      });
      continue;
    }
    // A move: the same trimmed text on both sides of the same file.
    const addedTexts = countBy(added, (text) => text.trim());
    const removedTexts = countBy(removed, (text) => text.trim());
    const unmovedRemoved = removed.filter((line) => line.text.trim() === '' || !take(addedTexts, line.text.trim()));
    const unmovedAdded = added.filter((line) => line.text.trim() === '' || !take(removedTexts, line.text.trim()));
    const addedDeclarations = countBy(
      unmovedAdded.filter((line) => classify(line.text, 'removed').some((row) => row.kind === 'test-removed')),
      declarationKey,
    );
    const items = [];
    for (const line of unmovedRemoved) {
      for (const row of classify(line.text, 'removed')) {
        if (row.kind === 'test-removed' && take(addedDeclarations, declarationKey(line.text))) continue;
        items.push({ kind: row.kind, label: row.label, side: 'LEFT', line: line.line, text: line.text, at: line.at });
      }
    }
    for (const line of unmovedAdded) {
      for (const row of classify(line.text, 'added')) {
        items.push({ kind: row.kind, label: row.label, side: 'RIGHT', line: line.line, text: line.text, at: line.line });
      }
    }
    if (items.length === 0) continue;
    items.sort((a, b) => a.at - b.at || (a.side === b.side ? a.line - b.line : a.side === 'LEFT' ? -1 : 1));
    report.push({ path, status: file.status, deleted: false, items });
  }
  return report;
}

/**
 * Index the PR diff for anchoring: per path, the lines GitHub accepts a comment
 * on for each side, and the text there. Measured on a scratch PR
 * (sirmaelstrom/workit#118): a `LEFT` comment on a removed line, on a line of a
 * deleted file and on a context line all post as review threads; a line
 * outside every hunk fails the whole review with 422 "Line could not be
 * resolved"; `subject_type: file` is not accepted inside a review.
 */
export function indexForAnchoring(files) {
  const index = new Map();
  for (const file of files ?? []) {
    const { removed, added, context } = patchLines(file.patch);
    const left = new Map();
    const right = new Map();
    const removedByText = new Map();
    for (const line of removed) {
      left.set(line.line, line.text);
      const key = line.text.trim();
      if (!removedByText.has(key)) removedByText.set(key, []);
      removedByText.get(key).push(line.line);
    }
    for (const line of context) {
      left.set(line.old, line.text);
      right.set(line.line, line.text);
    }
    for (const line of added) right.set(line.line, line.text);
    index.set(file.filename, { left, right, removedByText });
  }
  return index;
}

function nearest(lines, target) {
  let best = null;
  for (const line of lines) {
    if (best === null || Math.abs(line - target) < Math.abs(best - target)) best = line;
  }
  return best;
}

/**
 * Where one guard entry's thread sits on the PR diff, or null when the PR diff
 * has no commentable line at all. In order:
 *   1. an item's own line, when the PR diff shows the same text there
 *      (always so on a full review, where the two diffs are one);
 *   2. a removed item's text among the PR diff's removed lines in that file
 *      (an amendment check: the line numbers differ, the text does not);
 *   3. the commentable line nearest the change in that file, either side;
 *   4. the first commentable line of the PR diff (the file is not in it: the
 *      amendment removed something only an earlier round had added).
 * `exact` is false from step 3 on, and the comment then names the real place.
 */
export function anchorEntry(entry, index) {
  const own = index.get(entry.path);
  if (own) {
    const items = entry.deleted
      ? (entry.firstLine === null ? [] : [{ side: 'LEFT', line: entry.firstLine, text: own.left.get(entry.firstLine) }])
      : entry.items;
    for (const item of items) {
      const side = item.side === 'LEFT' ? own.left : own.right;
      if (side.has(item.line) && side.get(item.line) === item.text) return { path: entry.path, side: item.side, line: item.line, exact: true };
    }
    for (const item of items) {
      if (item.side !== 'LEFT') continue;
      const candidates = own.removedByText.get(item.text.trim());
      if (candidates?.length) return { path: entry.path, side: 'LEFT', line: nearest(candidates, item.line), exact: true };
    }
    const at = entry.items?.[0]?.at ?? 1;
    const right = nearest(own.right.keys(), at);
    if (right !== null) return { path: entry.path, side: 'RIGHT', line: right, exact: false };
    const left = nearest(own.left.keys(), at);
    if (left !== null) return { path: entry.path, side: 'LEFT', line: left, exact: false };
  }
  for (const [path, sides] of index) {
    const right = nearest(sides.right.keys(), 1);
    if (right !== null) return { path, side: 'RIGHT', line: right, exact: false };
    const left = nearest(sides.left.keys(), 1);
    if (left !== null) return { path, side: 'LEFT', line: left, exact: false };
  }
  return null;
}

/** The comment tag that makes a thread a guard thread. `reply` reads it back. */
export const GUARD_LENS = 'guard';
/** Who may give a guard thread its verdict. The author may not clear it. */
export const GUARD_ADJUDICATORS = Object.freeze(['conductor', 'operator']);

const MAX_LISTED = 20;

function quote(text) {
  const clipped = text.trim().length > 160 ? `${text.trim().slice(0, 157)}...` : text.trim();
  return clipped.includes('`') ? `\`\` ${clipped} \`\`` : `\`${clipped}\``;
}

/** The body of one guard thread. The prefix is what `readPostedFinding` parses. */
export function renderGuardComment(entry, anchor, { delta = false } = {}) {
  const lines = [`**lens:** ${GUARD_LENS}`, ''];
  if (delta) lines.push('**scope:** delta', '');
  if (entry.deleted) {
    lines.push(`**Test-weakening check: \`${entry.path}\` was deleted**`, '');
    lines.push(entry.patchMissing
      ? 'GitHub sent no patch for it, so its tests and assertions were not counted.'
      : `The file held ${entry.removedTests} test declaration line(s) and ${entry.removedAssertions} assertion line(s).`);
  } else if (entry.unchecked) {
    lines.push(`**Test-weakening check: \`${entry.path}\` not checked: no patch**`, '');
    lines.push(`This test file changed (${entry.status}), but GitHub sent no patch for it (a large diff or a binary file), so nothing in it was checked. Read the change before judging it.`);
  } else {
    lines.push(`**Test-weakening check: \`${entry.path}\`**`, '');
    for (const item of entry.items.slice(0, MAX_LISTED)) {
      lines.push(`- ${item.side === 'LEFT' ? `\`-\` old line ${item.line}` : `\`+\` line ${item.line}`}, ${item.label}: ${quote(item.text)}`);
    }
    if (entry.items.length > MAX_LISTED) lines.push(`- ... and ${entry.items.length - MAX_LISTED} more in this file`);
  }
  if (anchor && !anchor.exact) {
    lines.push('', `This comment sits on the nearest line GitHub accepts (\`${anchor.path}\` ${anchor.side} ${anchor.line}); the change is in \`${entry.path}\` as listed above.`);
  }
  lines.push(
    '',
    'Matched by pattern, not judged. The conductor or the operator gives the verdict, never the lane: `refuted` with a quoted reason the removal is legitimate, `judgment`, or `confirmed` once the test is restored (`reply --verdict … --adjudicator conductor|operator`).',
  );
  return lines.join('\n');
}

/**
 * The whole check as `post` runs it: detect over `sourceFiles`, anchor on
 * `prDiffFiles`, render. Returns the review comments to add, the entries that
 * found no line anywhere (listed in the body, and loud in the receipt), and a
 * body section. An empty result changes nothing in the review.
 */
export function guardReview({ sourceFiles, prDiffFiles, delta = false }) {
  const entries = detectTestWeakening(sourceFiles);
  if (entries.length === 0) return { entries, comments: [], unanchored: [], section: null };
  const index = indexForAnchoring(prDiffFiles);
  const comments = [];
  const unanchored = [];
  for (const entry of entries) {
    const anchor = anchorEntry(entry, index);
    if (!anchor) {
      unanchored.push(entry);
      continue;
    }
    comments.push({ path: anchor.path, line: anchor.line, side: anchor.side, body: renderGuardComment(entry, anchor, { delta }) });
  }
  const section = [
    '',
    '---',
    '',
    '### Test-weakening check',
    '',
    `${entries.length} test file(s) in ${delta ? 'this amendment' : 'this PR'} lost a test, an assertion, or gained a skip or focus, or changed with no patch to check. Each is an open thread for the conductor or the operator to judge; the lane cannot clear it.`,
    '',
    ...entries.map((entry) => `- \`${entry.path}\`: ${entry.deleted ? 'deleted' : entry.unchecked ? 'not checked: no patch' : entry.items.map((item) => item.label).filter((label, i, all) => all.indexOf(label) === i).join(', ')}${unanchored.includes(entry) ? ' — **no line in this PR diff can carry a comment; judge it here**' : ''}`),
  ].join('\n');
  return { entries, comments, unanchored, section };
}
