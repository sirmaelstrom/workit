/**
 * pr-review-guard.mjs — the test-weakening check `post` runs over the patches
 * it already holds.
 *
 * A lane can go green by deleting, skipping or loosening the test that
 * reported the failure. This module finds the textual signs of that in a diff
 * and nothing more: it does not judge whether a removal was legitimate. It
 * reports into the review body and blocks nothing, so a false positive costs a
 * reader one look; the patterns lean wide.
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
    // Tests moved unchanged into code that never runs match as a move, so the
    // wrapper itself is the signal. Literal guards only: a condition that
    // needs evaluating is past what a pattern can know. Block comments are
    // judged by what they enclose, in `commentedOutTests` below.
    kind: 'disabled-added',
    on: 'added',
    label: 'code disabled (literal-false guard or block comment opened)',
    patterns: [
      /\b(?:if|while)\s*\(\s*(?:false|0|!1|null|undefined|''|"")\s*\)/,
      /^\s*#if\s+(?:false|0)\b/i,
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
      current = { filename: m?.[2] ?? null, previous_filename: m?.[1] ?? null, status: 'modified', binary: false, identical: false, patchLines: [] };
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
      else if (raw === 'similarity index 100%') current.identical = true;
      else if (/^index ([0-9a-f]+)\.\.\1(?:\s|$)/.test(raw)) current.identical = true;
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
  return files.map(({ patchLines: lines, filename, previous_filename: previous, status, binary, identical }) => {
    // A deleted file's only name is its old one.
    const name = status === 'removed' ? (previous ?? filename) : filename;
    return {
      filename: name,
      ...(previous && previous !== name ? { previous_filename: previous } : {}),
      status,
      patch: lines.join('\n'),
      // `changes: 0` (as the compare API reports it) only on evidence the
      // content is identical: `similarity index 100%`, or equal blob ids on the
      // `index` line. A mode header proves nothing about content, and a missing
      // hunk alone is not evidence either: both stay unchecked.
      ...(lines.length === 0 && !binary && identical ? { changes: 0 } : {}),
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
 * Where the block comment this line leaves open starts, or -1 when it leaves
 * none open. A lexical scan, not a parser: text inside quotes ('…', "…", `…`,
 * backslash escapes honoured) opens nothing, so a glob such as 'scripts/**'
 * is not a comment; a `//` line comment ends the scan; a comment closed on the
 * same line is skipped. A regex literal (`/'/`, `/[/*]/`) is skipped whole,
 * so a quote or a `/*` inside it opens nothing; a `/` is read as one where an
 * operand may start (line start, after an operator or `(`, `,`, `;` …, or after
 * a keyword such as `return`), and as division elsewhere. A quote still open at
 * the end of the line holds the rest of it. One line at a time: a template
 * literal or string spanning lines is not tracked, so a `/*` on its second
 * line still counts.
 */
function openCommentAt(text) {
  let open = -1;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (open !== -1) {
      if (c === '*' && text[i + 1] === '/') {
        open = -1;
        i++;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '/' && text[i + 1] === '*') {
      open = i;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      break;
    } else if (c === '/' && regexMayStart(text.slice(0, i))) {
      const end = regexEnd(text, i);
      if (end !== -1) i = end;
    }
  }
  return open;
}

/**
 * Whether a `/` after `before` starts a regex literal rather than a division.
 * A postfix `++`/`--` ends an operand, so the `/` after it divides. A `)` ends
 * an operand too, except the condition of `if`/`while`/`for`/`with`, after
 * which a statement (and so a regex) may start.
 */
function regexMayStart(before) {
  const code = before.trimEnd();
  if (/(?:\+\+|--)$/.test(code)) return false;
  if (code.endsWith(')')) return /(?<![\w$.])(?:if|while|for|with)\s*$/.test(code.slice(0, openingParen(code)));
  return code === ''
    || /[(,=:[!&|?{};+\-*%<>~^]$/.test(code)
    || /(?<![\w$.])(?:return|typeof|instanceof|case|in|of|delete|void|throw|new|yield|await|else|do)$/.test(code);
}

/** The index of the `(` matching the `)` that ends `code`, or 0 when unmatched. */
function openingParen(code) {
  let depth = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    if (code[i] === ')') depth++;
    else if (code[i] === '(' && --depth === 0) return i;
  }
  return 0;
}

/** The index of the `/` closing the regex literal opened at `start`, or -1. */
function regexEnd(text, start) {
  let inClass = false;
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j;
  }
  return -1;
}

/**
 * Added block-comment openers (`/*` or `/**`) that swallow a test: walking the
 * post-change lines the patch shows, in order, an opener added by this change
 * whose comment holds a test declaration or an assertion before the comment
 * closes is reported, whether the enclosed lines were moved, kept or added. A JSDoc block
 * above a function holds neither and stays silent. A comment still open when
 * the visible lines skip ahead (a hunk gap) is reported too: the patch cannot
 * show where it closes.
 */
function commentedOutTests(added, context) {
  const shown = [
    ...added.map((line) => ({ ...line, isAdded: true })),
    ...context.map((line) => ({ line: line.line, text: line.text, isAdded: false })),
  ].sort((a, b) => a.line - b.line);
  const swallows = (text) => classify(text, 'removed').some((row) => row.kind === 'test-removed' || row.kind === 'assertion-removed');
  const found = [];
  let open = null;
  let previous = null;
  for (const line of shown) {
    if (open && previous !== null && line.line !== previous + 1) {
      found.push(open.opener);
      open = null;
    }
    previous = line.line;
    if (open) {
      const close = line.text.indexOf('*/');
      const inside = close === -1 ? line.text : line.text.slice(0, close);
      if (!open.hit && swallows(inside)) open.hit = true;
      if (close !== -1) {
        if (open.hit) found.push(open.opener);
        open = null;
      }
      continue;
    }
    if (!line.isAdded) continue;
    const at = openCommentAt(line.text);
    if (at === -1) continue;
    open = { opener: line, hit: swallows(line.text.slice(at + 2)) };
  }
  if (open) found.push(open.opener);
  return found;
}

/**
 * The detector. One entry per changed test file that shows a sign of
 * weakening:
 *
 *   { path, status, deleted: true, patchMissing, removedTests, removedAssertions }
 *   { path, status, deleted: false, unchecked: true, items: [] }
 *   { path, status, deleted: false, items: [{ kind, label, side, line, text, at? }] }
 * and `renamedOut: true, previousPath` on either of the last two when a test
 * file was renamed to a path no runner discovers.
 *
 * `side` is `LEFT` for a removed line (numbered in the pre-change file),
 * `RIGHT` for an added one. A line removed and re-added
 * unchanged elsewhere in the same file (compared trimmed) is a move and is not
 * reported. A removed test declaration whose rename-key reappears among the
 * added lines is a rename and is not reported either, but only while every
 * other removed line in the file was re-added: the body is checked, not
 * assumed.
 *
 * A changed test file with no patch (GitHub omits it on a large diff, and a
 * binary file has none) cannot be read, so it is reported `unchecked`: an entry
 * that says nothing was checked, rather than silence. An added file and one
 * with `changes: 0` (content shown identical) have nothing to remove.
 */
export function detectTestWeakening(files) {
  const report = [];
  for (const file of files ?? []) {
    const path = file.filename;
    if (!isTestFile(path) && !isTestFile(file.previous_filename)) continue;
    // A test file renamed to a path no runner discovers stops running, whatever
    // its content: reported even as a pure rename.
    const renamedOut = file.status === 'renamed' && isTestFile(file.previous_filename) && !isTestFile(path);
    const outOf = renamedOut ? { renamedOut: true, previousPath: file.previous_filename } : {};
    const patchMissing = typeof file.patch !== 'string' || file.patch.trim() === '';
    if (patchMissing && file.status !== 'removed') {
      if (renamedOut && file.changes === 0) {
        report.push({ path, status: file.status, deleted: false, ...outOf, items: [] });
        continue;
      }
      if (file.status === 'added' || file.changes === 0) continue;
      report.push({ path, status: file.status, deleted: false, unchecked: true, ...outOf, items: [] });
      continue;
    }
    const { removed, added, context } = patchLines(file.patch);
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
    const isDeclaration = (text) => classify(text, 'removed').some((row) => row.kind === 'test-removed');
    // A rename is exempt only when it is checked to be one: every other
    // removed line in the file came back unchanged. A body line that did not
    // (`verifyPayment()` → `noop()`) voids every pairing in the file.
    const bodyIntact = unmovedRemoved.every((line) => line.text.trim() === '' || isDeclaration(line.text));
    const addedDeclarations = bodyIntact
      ? countBy(unmovedAdded.filter((line) => isDeclaration(line.text)), declarationKey)
      : new Map();
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
    const disabled = GUARD_PATTERNS.find((row) => row.kind === 'disabled-added');
    for (const opener of commentedOutTests(added, context)) {
      items.push({ kind: disabled.kind, label: disabled.label, side: 'RIGHT', line: opener.line, text: opener.text, at: opener.line });
    }
    if (items.length === 0 && !renamedOut) continue;
    items.sort((a, b) => a.at - b.at || (a.side === b.side ? a.line - b.line : a.side === 'LEFT' ? -1 : 1));
    report.push({ path, status: file.status, deleted: false, ...outOf, items });
  }
  return report;
}

/**
 * The comment tag of a guard thread. `post` no longer opens one (the check is a
 * body section), but threads opened by earlier reviews carry it, and `reply`
 * still reads it back on them.
 */
export const GUARD_LENS = 'guard';
/** Who may give a guard thread its verdict. The author may not clear it. */
export const GUARD_ADJUDICATORS = Object.freeze(['conductor', 'operator']);
/**
 * Set by lane.mjs in every lane agent's tool environment (scripts/lane.mjs
 * LANE_MARKER_ENV). While it is set, `reply` refuses an adjudicator from
 * GUARD_ADJUDICATORS: a lane cannot sign as the conductor or the operator.
 */
export const LANE_MARKER_ENV = 'WORKIT_LANE';

const MAX_LISTED = 20;

function quote(text) {
  const clipped = text.trim().length > 160 ? `${text.trim().slice(0, 157)}...` : text.trim();
  return clipped.includes('`') ? `\`\` ${clipped} \`\`` : `\`${clipped}\``;
}

/** One entry's lines in the body section: the file, then what matched in it. */
function renderEntry(entry) {
  if (entry.deleted) {
    return [`- \`${entry.path}\`: deleted. ${entry.patchMissing
      ? 'GitHub sent no patch for it, so its tests and assertions were not counted.'
      : `It held ${entry.removedTests} test declaration line(s) and ${entry.removedAssertions} assertion line(s).`}`];
  }
  const notes = [
    ...(entry.renamedOut ? [`renamed out of the test paths from \`${entry.previousPath}\`, so no test runner picks it up`] : []),
    ...(entry.unchecked ? [`not checked: no patch (${entry.status}; a large diff or a binary file)`] : []),
  ];
  const lines = [`- \`${entry.path}\`${notes.length > 0 ? `: ${notes.join('; ')}` : ''}`];
  for (const item of entry.items.slice(0, MAX_LISTED)) {
    lines.push(`  - ${item.side === 'LEFT' ? `\`-\` old line ${item.line}` : `\`+\` line ${item.line}`}, ${item.label}: ${quote(item.text)}`);
  }
  if (entry.items.length > MAX_LISTED) lines.push(`  - ... and ${entry.items.length - MAX_LISTED} more in this file`);
  return lines;
}

/**
 * The whole check as `post` runs it: detect over `sourceFiles` and render one
 * review-body section. It opens no thread, so nothing in it needs a verdict
 * before merge: a reviewer can read the listed lines, and that is all. An
 * empty result changes nothing in the review.
 */
export function guardReview({ sourceFiles, delta = false }) {
  const entries = detectTestWeakening(sourceFiles);
  if (entries.length === 0) return { entries, section: null };
  const section = [
    '',
    '---',
    '',
    '### Test files whose assertions changed',
    '',
    `Not blocking: nothing here needs a verdict to merge. ${entries.length} test file(s) in ${delta ? 'this amendment' : 'this PR'} lost or changed a test or an assertion, gained a skip, a focus or a disabling wrapper, left the test paths, or changed with no patch to check. The match is textual, so a strengthened or renamed assertion matches too; look if the lines below surprise you.`,
    '',
    ...entries.flatMap(renderEntry),
  ].join('\n');
  return { entries, section };
}
