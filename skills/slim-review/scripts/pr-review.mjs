#!/usr/bin/env node
/**
 * pr-review.mjs — the mechanical half of the slim PR-review loop.
 *
 * Three subcommands, each one deterministic step the reviewing agent should not
 * improvise:
 *
 *   post    — turn a delegated reviewer's findings JSON into a line-anchored
 *             GitHub PR review, after two checks against two different sources:
 *             path coverage against the PR files API (`fetchPrFilePaths`, the
 *             authoritative list), and line anchorability against the diff. The
 *             diff is authoritative for anchoring ONLY — it omits deleted,
 *             binary and pure-rename files, which are changed files all the same.
 *   threads — list the PR's review threads with their resolved state and the
 *             comment ids you reply to.
 *   reply   — reply to one review thread.
 *
 * Why a script and not inline `gh` calls: review bodies are markdown containing
 * backticks, quotes and newlines, and every posting path here builds JSON in
 * Node and hands it to `gh api --input -`, so no shell ever re-parses the text.
 * The findings-vs-diff checks are the other half — they are the only thing that
 * makes an incomplete or ungrounded review distinguishable from a clean one.
 *
 * Exit codes (`post`):
 *   0  review posted (a zero-finding review is a real, posted result)
 *   2  usage error
 *   3  the handback did not arrive — findings file missing, unparseable, or the
 *      wrong shape. NOT the same as "no findings"; a reviewer that never ran
 *      must never read as a clean review.
 *   4  a `gh` call failed
 *   5  coverage did not match the authoritative PR file list, or that list came
 *      back empty (a fetch failure, never a PR that changes nothing)
 *
 * Exit codes (`threads`):
 *   6  the result was truncated by the query's own page size, so the thread list
 *      is incomplete and must not be read as a merge-ready signal. Full
 *      pagination is a follow-up; this is the floor that keeps the gap loud.
 */

import {
  readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync,
  rmSync, readdirSync, renameSync, chmodSync, unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

import { createClient } from './pr-review-coordinator.mjs';
import { createReviewWorktree } from './pr-review-worktree.mjs';
import {
  loadCoordinatorToken,
  managedDirectory,
  readManagedList,
  resolveManaged,
  MANAGED_MODES,
} from './pr-review-managed.mjs';
import { emitOutcome, WITHDRAW_REASONS } from './pr-review-outcomes.mjs';
import { buildMarker, recognise } from './pr-review-recognise.mjs';

// ---------------------------------------------------------------------------
// gh plumbing
// ---------------------------------------------------------------------------

/**
 * Never pass `shell: true` here. `gh` ships as a real executable on every
 * platform (`gh.exe` on Windows, not a .cmd shim), so execFileSync launches it
 * directly — and with a shell in the way, Node concatenates the argv instead of
 * escaping it, which silently mangles any argument containing newlines or
 * quotes. The GraphQL query in `threads` is exactly such an argument.
 */
export function gh(args, { input, cwd } = {}) {
  return execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    input,
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function ghOrDie(args, opts) {
  try {
    return gh(args, opts);
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    fail(4, `gh ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`);
  }
}

/** Repo slug via gh itself — never parse `git remote get-url`, which applies insteadOf rewrites. */
function resolveRepo(explicit, cwd) {
  if (explicit) return explicit;
  return ghOrDie(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd }).trim();
}

/** Fetch the PR's authoritative changed-file paths from GitHub's PR files API. */
export function fetchPrFilePaths(repo, pr, cwd, runGh = ghOrDie) {
  const raw = runGh(
    ['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename'],
    { cwd },
  );
  return String(raw).split(/\r?\n/).filter((path) => path !== '');
}

/**
 * Fetch the same list with the three extra fields the manifest binds to.
 *
 * Two fetchers, not one with a wrapper (P3 asks for the wrapper): the standalone
 * path's `gh` argv is pinned byte-for-byte by the characterisation suite (M4),
 * and the richer projection is a different `--jq`. What P3 is actually
 * protecting against — a second, duplicate files request inside one flow, or a
 * changed public signature — does not happen either way: the coordinated flow
 * fetches files exactly once, in `manifest`, and every later step reads that
 * manifest back from the coordinator.
 *
 * `runGh` defaults to the raw `gh`, which throws: every caller here is a
 * coordinated path that must classify its own `gh-failure` rather than exit
 * from underneath the JSON outcome line.
 */
export function fetchPrFiles(repo, pr, cwd, runGh = gh) {
  const raw = runGh(
    ['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[] | {filename, sha, status, has_patch: has("patch")}'],
    { cwd },
  );
  return String(raw)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const entry = JSON.parse(line);
      return {
        filename: entry.filename,
        sha: entry.sha ?? null,
        status: entry.status ?? null,
        has_patch: entry.has_patch === true,
      };
    });
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into the set of lines GitHub will accept a RIGHT-side
 * review comment on: every added and context line inside a hunk, numbered in
 * the post-change file.
 *
 * @returns {Map<string, Set<number>>} path → commentable line numbers
 */
export function parseDiff(diffText) {
  const files = new Map();
  let path = null;
  let newLine = 0;
  let inHunk = false;

  // Strip the ONE trailing newline `gh pr diff` always emits. Left in, the split
  // yields a trailing '' that the `raw === ''` branch below counts as a context
  // line, marking one line past the diff's true end as commentable — and a
  // finding anchored there makes GitHub reject the entire single-POST review.
  for (const raw of String(diffText).replace(/\r?\n$/, '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      path = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      // A deleted file has no post-change side, so nothing is commentable.
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (path && !files.has(path)) files.set(path, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    if (!inHunk || !path) continue;

    if (raw.startsWith('+')) {
      files.get(path).add(newLine++);
    } else if (raw.startsWith('-')) {
      // removed line — consumes no post-change line number
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
    } else if (raw.startsWith(' ') || raw === '') {
      files.get(path).add(newLine++);
    } else {
      // Anything else ends the hunk (commit trailers, `diff --git`, EOF noise).
      inHunk = false;
    }
  }
  return files;
}

/**
 * Count the `diff --git` headers — every changed file, not just the ones a
 * comment can anchor to.
 *
 * DIAGNOSTIC ONLY. This no longer gates anything: coverage is checked against
 * `fetchPrFilePaths` (the files API), and the only consumer left is the receipt
 * line in `cmdPost`, where printing it beside `prFilePaths.length` makes a
 * divergence between the diff and the file list visible.
 *
 * It is still deliberately NOT `parseDiff(...).size`. A deleted file has no
 * post-change side, and a binary or pure-rename change has no hunk at all, so
 * none of them appear in the commentable map — but all of them are changed
 * files. Every changed file gets exactly one `diff --git` header.
 */
export function countChangedFiles(diffText) {
  let n = 0;
  for (const raw of String(diffText).split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Findings validation
// ---------------------------------------------------------------------------

const SEVERITIES = new Set(['P1', 'P2', 'P3']);
// Lens → model + default effort. `codex` (Terra) and `astra` both ride the
// codex-cli harness; `opus` rides `claude -p`. Astra joined 2026-09-09 as the
// default PAIR partner (operator ruling, quest bcc11983): on observatory#620
// Terra@high and Astra@low each found a real defect the other missed, neither
// produced a false finding, and Astra was better calibrated on severity at half
// the input — so the loop runs both and posts the union.
const LENS_MODELS = {
  codex: { model: 'gpt-5.6-terra', reasoning: 'high' },
  astra: { model: 'gpt-6-astra', reasoning: 'low' },
  opus: { model: 'opus', reasoning: 'low' },
};
const LENSES = new Set(Object.keys(LENS_MODELS));
const LENS_LIST = [...LENSES].join('|');
const isCodexLens = (lens) => lens === 'codex' || lens === 'astra';
const FINDING_KEYS = new Set(['severity', 'title', 'path', 'line', 'body', 'lens']);
/**
 * Keys a persisted findings document may carry.
 *
 * This is a closed allowlist and `loadFindings` runs it on every read, so the
 * four revision stamps a coordinated `lens` writes (`head_sha`, `base_sha`,
 * `attempt`, `run_id`) have to be admitted here or the writer's own loader
 * would reject every document it just produced, at `post`, with "top level has
 * unknown property: head_sha". They stay optional: a standalone document has
 * none of them and is unchanged.
 *
 * `findings.schema.json` is NOT widened — it governs what the model returns
 * through `--output-schema`, and the stamps (like `lens` / `model` / `wall_ms`
 * before them) are added by this script afterwards.
 */
const DOCUMENT_KEYS = new Set([
  'summary', 'coverage', 'examined_paths', 'findings', 'lens', 'model', 'reasoning', 'wall_ms',
  'head_sha', 'base_sha', 'attempt', 'run_id',
]);
/** The four revision stamps, in the order `lens --attempt-ref` writes them. */
export const DOCUMENT_STAMPS = Object.freeze(['head_sha', 'base_sha', 'attempt', 'run_id']);

/**
 * Load the handback. Anything short of a well-formed object is exit 3: a
 * reviewer that did not run must never be reported as a reviewer that found
 * nothing.
 */
export function loadFindings(file) {
  if (!existsSync(file)) {
    fail(3, `findings file not found: ${file}\nThe reviewer did not run (or wrote nowhere). This is NOT a clean review.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(3, `findings file is not valid JSON: ${file}\n${err.message}`);
  }
  const problems = validateFindingsShape(parsed);
  if (problems.length > 0) {
    fail(3, `findings file has the wrong shape: ${file}\n  - ${problems.join('\n  - ')}`);
  }
  return parsed;
}

export function validateFindingsShape(doc) {
  const problems = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['top level must be an object'];
  }
  for (const key of Object.keys(doc)) {
    if (!DOCUMENT_KEYS.has(key)) problems.push(`top level has unknown property: ${key}`);
  }
  if (doc.lens !== undefined && !LENSES.has(doc.lens)) problems.push(`lens must be one of ${LENS_LIST}`);
  if (doc.model !== undefined && (typeof doc.model !== 'string' || doc.model.trim() === '')) problems.push('model must be a non-empty string');
  if (doc.reasoning !== undefined && (typeof doc.reasoning !== 'string' || doc.reasoning.trim() === '')) problems.push('reasoning must be a non-empty string');
  if (doc.wall_ms !== undefined && (!Number.isInteger(doc.wall_ms) || doc.wall_ms < 0)) problems.push('wall_ms must be a non-negative integer');
  // The revision stamps: optional, but a present one that is empty or the wrong
  // type is worse than an absent one — `post` compares them to the AttemptRef.
  for (const key of ['head_sha', 'base_sha', 'run_id']) {
    if (doc[key] !== undefined && (typeof doc[key] !== 'string' || doc[key].trim() === '')) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  if (doc.attempt !== undefined && (!Number.isInteger(doc.attempt) || doc.attempt < 1)) problems.push('attempt must be a positive integer');
  if (typeof doc.summary !== 'string' || doc.summary.trim() === '') {
    problems.push('summary must be a non-empty string');
  }
  if (typeof doc.coverage !== 'string' || doc.coverage.trim() === '') {
    problems.push('coverage must be a non-empty string');
  } else if (!/examined\s+\d+\s+of\s+\d+/i.test(doc.coverage)) {
    // An unparsable string disarms checkCoverage's count check silently, so the
    // reviewer writing prose gets through while the one honestly reporting
    // "examined 1 of 2" is blocked. Enforce the format here, where it always
    // runs, rather than in the JSON schema, which the generator may ignore.
    problems.push(`coverage must state "examined N of M": ${JSON.stringify(doc.coverage)}`);
  }
  if (!Array.isArray(doc.examined_paths)) {
    problems.push('examined_paths must be an array');
  } else {
    // A checker over zero input reports "clean": checkCoverage([], []) is ok, so
    // a handback admitting nothing examined would post as a passing review.
    if (doc.examined_paths.length === 0) {
      problems.push('examined_paths must not be empty — a review that examined nothing is not a clean review');
    }
    doc.examined_paths.forEach((path, i) => {
      if (typeof path !== 'string' || path.trim() === '') {
        problems.push(`examined_paths[${i}] must be a non-empty string`);
      }
    });
    if (new Set(doc.examined_paths).size !== doc.examined_paths.length) {
      problems.push('examined_paths must not contain duplicates');
    }
  }
  if (!Array.isArray(doc.findings)) {
    problems.push('findings must be an array (an empty array is valid)');
    return problems;
  }
  doc.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(f)) {
      if (!FINDING_KEYS.has(key)) problems.push(`${at} has unknown property: ${key}`);
    }
    if (f.lens !== undefined && !LENSES.has(f.lens)) problems.push(`${at}.lens must be one of ${LENS_LIST}`);
    if (!SEVERITIES.has(f.severity)) problems.push(`${at}.severity must be one of P1, P2, P3`);
    for (const key of ['title', 'path', 'body']) {
      if (typeof f[key] !== 'string' || f[key].trim() === '') {
        problems.push(`${at}.${key} must be a non-empty string`);
      }
    }
    if (!Number.isInteger(f.line) || f.line < 1) problems.push(`${at}.line must be a positive integer`);
  });
  return problems;
}

/**
 * Split findings by whether GitHub will accept them as line-anchored comments.
 *
 * Two distinct off-diff buckets, and conflating them publishes a false
 * statement. Absence from `diffFiles` only means "no commentable line" — a
 * deleted, binary or pure-rename file never appears there but IS a file this PR
 * changes. `prFilePaths` (the files API, the authoritative list) is what
 * separates them:
 *
 *   offDiffChanged   — the PR changes the file, but no line can carry a comment
 *   offDiffUnchanged — the PR does not touch the file at all: out of scope or an
 *                      invented locator, and the operator must see which
 */
function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '');
}

export function partitionFindings(findings, diffFiles, prFilePaths = []) {
  const prSet = new Set(prFilePaths.map(normalizePath));
  const anchored = [];
  const offDiffChanged = [];
  const offDiffUnchanged = [];
  const offLine = [];
  for (const f of findings) {
    const path = normalizePath(f.path);
    const lines = diffFiles.get(path);
    if (!lines) {
      (prSet.has(path) ? offDiffChanged : offDiffUnchanged).push({ ...f, path });
    } else if (!lines.has(f.line)) {
      offLine.push({ ...f, path });
    } else {
      anchored.push({ ...f, path });
    }
  }
  return { anchored, offDiffChanged, offDiffUnchanged, offLine };
}

/**
 * Check the reviewer's own coverage claim against the PR's file count.
 *
 * This is the automated form of the delegation rule: the conductor never reads
 * the files, so a silently partial review is indistinguishable from a thorough
 * one unless something compares the claim to ground truth.
 */
export function checkCoverage(coverage, examinedPaths, prFilePaths) {
  const m = /examined\s+(\d+)\s+of\s+(\d+)/i.exec(String(coverage));

  const examinedSet = new Set(examinedPaths.map(normalizePath));
  const prSet = new Set(prFilePaths.map(normalizePath));
  const missing = [...prSet].filter((path) => !examinedSet.has(path)).sort();
  const extra = [...examinedSet].filter((path) => !prSet.has(path)).sort();

  let countReason;
  let countContradiction = false;
  if (!m) {
    countReason = `coverage string does not state "examined N of M": ${JSON.stringify(coverage)}`;
  } else {
    const examined = Number(m[1]);
    const claimedTotal = Number(m[2]);
    if (claimedTotal !== prSet.size) {
      countReason = `reviewer claims ${claimedTotal} changed files, the PR API has ${prSet.size}`;
      countContradiction = true;
    } else if (examined !== claimedTotal) {
      countReason = `reviewer examined ${examined} of ${claimedTotal} changed files — the review is partial`;
      countContradiction = true;
    }
  }

  if (missing.length === 0 && extra.length === 0) {
    if (countContradiction) {
      return {
        ok: false,
        reason: `coverage count contradicts examined_paths: ${countReason}`,
        missing,
        extra,
        countReason,
      };
    }
    return { ok: true, missing, extra, countReason };
  }
  const pathReasons = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
    extra.length > 0 ? `extra: ${extra.join(', ')}` : null,
  ].filter(Boolean);
  const reason = [`examined_paths do not match the PR API (${pathReasons.join('; ')})`];
  if (countReason) reason.push(`Secondary count check: ${countReason}`);
  return { ok: false, reason: reason.join('. '), missing, extra, countReason };
}

// ---------------------------------------------------------------------------
// Review payload
// ---------------------------------------------------------------------------

function renderFinding(f) {
  return `${f.lens ? `**lens:** ${f.lens}\n\n` : ''}**[${f.severity}] ${f.title}**\n\n${f.body}`;
}

/**
 * Build the `POST /pulls/{n}/reviews` payload.
 *
 * `event` is always COMMENT: GitHub forbids APPROVE and REQUEST_CHANGES on your
 * own pull request, and in this loop the PR author is the one running the
 * review. COMMENT works on your own PR and is what the manual loop produced.
 */
export function buildReviewPayload({
  summary,
  coverage,
  anchored,
  offDiffChanged,
  offDiffUnchanged,
  offLine,
  coverageCheck,
  warnings = [],
  lensCounts = [],
}) {
  const sections = [summary.trim()];

  if (lensCounts.length > 0) {
    sections.push(['### Findings by lens', '', ...lensCounts.map((count) =>
      `- ${count.lens}: ${count.P1} P1 / ${count.P2} P2 / ${count.P3} P3`,
    )].join('\n'));
  }

  if (offLine.length > 0 || offDiffChanged.length > 0 || offDiffUnchanged.length > 0) {
    const lines = ['', '---', '', '### Findings that could not be line-anchored', ''];
    for (const f of offLine) {
      lines.push(`- \`${f.path}:${f.line}\` — line is outside this PR's diff.`, '', renderFinding(f), '');
    }
    for (const f of offDiffChanged) {
      lines.push(
        `- \`${f.path}:${f.line}\` — **changed by this PR, but not line-anchorable** (deleted, binary, or pure rename).`,
        '',
        renderFinding(f),
        '',
      );
    }
    for (const f of offDiffUnchanged) {
      lines.push(`- \`${f.path}:${f.line}\` — **not a file this PR changes.**`, '', renderFinding(f), '');
    }
    sections.push(lines.join('\n'));
  }

  const footer = [
    '',
    '---',
    '',
    `_Slim review · ${anchored.length} anchored · ${offLine.length} off-line · ${offDiffChanged.length} not-anchorable · ${offDiffUnchanged.length} off-diff · ${coverage.trim()}_`,
  ];
  if (!coverageCheck.ok) {
    footer.push('', `> ⚠️ **Coverage check failed:** ${coverageCheck.reason}`);
  }
  for (const warning of warnings) {
    footer.push('', `> ⚠️ **Warning:** ${warning}`);
  }
  sections.push(footer.join('\n'));

  return {
    event: 'COMMENT',
    body: sections.join('\n'),
    comments: anchored.map((f) => ({
      path: f.path,
      line: f.line,
      side: 'RIGHT',
      body: renderFinding(f),
    })),
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * `post` — standalone, or coordinated when an attempt-ref is supplied.
 *
 * The branch is here and nothing below it changes: an edit to the standalone
 * body is a change to behaviour the characterisation suite pins byte-for-byte
 * (M4), so the coordinated path is a separate function reached before any of it.
 * Only the coordinated path returns a Promise.
 */
export function cmdPost(opts, deps = {}) {
  if (opts.attemptRef) return cmdPostCoordinated(opts, deps);
  return cmdPostStandalone(opts, deps);
}

function cmdPostStandalone(opts, { runGh = ghOrDie, die = fail, log = console.log, env = process.env, homeDir } = {}) {
  // Load the handback FIRST: a reviewer that never ran should fail before we
  // touch the network, and exit 3 must not depend on gh being reachable.
  const findingFiles = Array.isArray(opts.findings) ? opts.findings : [opts.findings];
  const docs = findingFiles.map(loadFindings);
  const gate = managedGate({ command: 'post', repo: opts.repo, env, homeDir, log, die });
  if (gate) return undefined;
  // The loop is two lenses posted as one review (2026-09-09). Terra's own review
  // of that change (workit#76) pointed out the policy was prose only: `post`
  // happily published a single handback as a clean slim review. Enforce it here,
  // before the network — one lens is a documented exception, never a default.
  const lensesPresent = [...new Set(docs.map((item) => item.lens).filter(Boolean))];
  if (lensesPresent.length < 2 && !opts.singleLens) {
    const carried = lensesPresent.length === 1 ? `only the \`${lensesPresent[0]}\` lens` : 'no lens tag';
    die(7, `the slim-review loop posts two lenses (codex + astra); this post carries ${carried}. Run the second lens and pass both --findings files, or pass --single-lens "<why the pair could not run>" to post one and stamp the reason into the review body. Nothing was posted.`);
    return;
  }
  const doc = {
    summary: docs.map((item) => item.summary).join('\n\n'),
    coverage: '',
    // Each handback is checked against the PR API below. Normalize this display
    // union too: otherwise two complete lenses using Windows and POSIX separators
    // inflate its count and make the combined receipt falsely claim it is partial.
    examined_paths: [...new Set(docs.flatMap((item) => item.examined_paths).map(normalizePath))],
    // A stamped document is the authority when an otherwise-valid handback
    // predates per-finding lens metadata. Without this, post loses the tag that
    // reply needs to attribute an adjudication.
    findings: docs.flatMap((item) => item.findings.map((finding) => ({
      ...finding,
      lens: finding.lens ?? item.lens,
    }))),
  };
  const repo = resolveRepo(opts.repo, opts.cwd);

  const reviewedHead = runGh(['pr', 'view', String(opts.pr), '--repo', repo, '--json', 'headRefOid', '-q', '.headRefOid'], { cwd: opts.cwd }).trim();
  const diffText = runGh(['pr', 'diff', String(opts.pr), '--repo', repo], { cwd: opts.cwd });
  const diffFiles = parseDiff(diffText);
  const diffHeaderCount = countChangedFiles(diffText);
  const prFilePaths = fetchPrFilePaths(repo, opts.pr, opts.cwd, runGh);
  // An empty authoritative list is a fetch failure, not a PR that changes
  // nothing: GitHub does not create a PR with zero files. Without this floor the
  // whole coverage guard runs over the empty set and reports OK.
  if (prFilePaths.length === 0) {
    die(5, `the PR API returned no changed files for ${repo}#${opts.pr}. That is a fetch failure, not a clean PR — nothing was posted.`);
    // `die` is an injected seam; never rely on it terminating. Falling through
    // here would run checkCoverage over an empty set, get ok:true, and post.
    return;
  }
  // The receipt summarizes the normalized union, but the guard is deliberately
  // per-handback: a union cannot prove each independent reviewer covered the PR.
  doc.coverage = docs.length === 1
    ? docs[0].coverage
    : `examined ${doc.examined_paths.length} of ${prFilePaths.length} changed files`;
  const { anchored, offDiffChanged, offDiffUnchanged, offLine } =
    partitionFindings(doc.findings, diffFiles, prFilePaths);
  // A completed union follows automatically from completed individual sets, and
  // its former count comparison could only reject separator variants falsely.
  // Keep every handback fail-closed against the authoritative PR API instead.
  const individualCoverageChecks = docs.map((item) => checkCoverage(item.coverage, item.examined_paths, prFilePaths));
  const individualFailures = individualCoverageChecks
    .map((check, i) => check.ok ? null : `findings file ${findingFiles[i]}: ${check.reason}`)
    .filter(Boolean);
  const coverageCheck = {
    ok: individualFailures.length === 0,
    missing: [],
    extra: [],
    reason: individualFailures.join('. '),
  };
  const lensCounts = [...new Set(docs.map((item) => item.lens).filter(Boolean))].map((lens) => {
    const findings = doc.findings.filter((finding) => finding.lens === lens);
    return {
      lens,
      P1: findings.filter((finding) => finding.severity === 'P1').length,
      P2: findings.filter((finding) => finding.severity === 'P2').length,
      P3: findings.filter((finding) => finding.severity === 'P3').length,
    };
  });

  // Free ground-truth signal: two independent sources for "what this PR changes"
  // are already in hand. Divergence means the diff the reviewer read disagrees
  // with the file list it was told to echo. Non-blocking — it is a heads-up, not
  // a verdict — but silently discarding it is worse than printing it.
  const warnings = [];
  if (lensesPresent.length < 2) {
    warnings.push(
      `single lens (${lensesPresent.join(', ') || 'untagged'}) — ${String(opts.singleLens).trim()}. Not a paired measurement.`,
    );
  }
  if (diffHeaderCount !== prFilePaths.length) {
    warnings.push(
      `diff shows ${diffHeaderCount} changed files, the PR API lists ${prFilePaths.length} — the diff and the authoritative file list disagree`,
    );
  }

  const payload = buildReviewPayload({
    summary: doc.summary,
    coverage: doc.coverage,
    anchored,
    offDiffChanged,
    offDiffUnchanged,
    offLine,
    coverageCheck,
    warnings,
    lensCounts,
  });
  payload.commit_id = reviewedHead;

  // Print the receipt BEFORE any coverage die: the failure path is exactly where
  // an operator needs the numbers to decide about --force-post.
  log(`repo           ${repo}`);
  log(`pr             #${opts.pr}`);
  log(`head           ${reviewedHead.slice(0, 7)}`);
  log(`changed files  ${prFilePaths.length} from PR API (${diffHeaderCount} diff headers; ${diffFiles.size} with commentable lines)`);
  log(`findings       ${doc.findings.length} → ${anchored.length} anchored · ${offLine.length} off-line · ${offDiffChanged.length} not-anchorable · ${offDiffUnchanged.length} off-diff`);
  log(`coverage       ${coverageCheck.ok ? `OK${coverageCheck.countReason ? ` — Secondary count check: ${coverageCheck.countReason}` : ''}` : `FAILED — ${coverageCheck.reason}`}`);
  for (const w of warnings) {
    log(`  warning      ${w}`);
  }
  for (const f of offDiffChanged) {
    log(`  not-anchor   ${f.path}:${f.line} — changed by this PR, but not line-anchorable`);
  }
  for (const f of offDiffUnchanged) {
    log(`  off-diff     ${f.path}:${f.line} — not a file this PR changes`);
  }

  if (!coverageCheck.ok && !opts.forcePost) {
    die(5, `coverage check failed; review was not posted: ${coverageCheck.reason}\nRe-run the reviewer or pass --force-post to post the stamped mismatch.`);
    return;
  }

  if (opts.dryRun) {
    log('\n--dry-run: nothing posted. Payload:\n');
    log(JSON.stringify(payload, null, 2));
    return;
  }

  const headNow = runGh(['pr', 'view', String(opts.pr), '--repo', repo, '--json', 'headRefOid', '-q', '.headRefOid'], { cwd: opts.cwd }).trim();
  if (headNow !== reviewedHead) {
    die(6, `PR head advanced from ${reviewedHead.slice(0,7)} to ${headNow.slice(0,7)} between the diff fetch and the post; the findings were anchored on the old head — re-run the reviewer. Nothing was posted.`);
    return;
  }

  const res = runGh(
    ['api', '--method', 'POST', `repos/${repo}/pulls/${opts.pr}/reviews`, '--input', '-'],
    { input: JSON.stringify(payload), cwd: opts.cwd },
  );
  const posted = JSON.parse(res);
  log(`\nposted         ${posted.html_url}`);
}

// GitHub's GraphQL connections are paged, and these two page sizes are the ones
// this query asks for. A full page means there is more behind it.
const THREADS_PAGE = 100;
const COMMENTS_PAGE = 50;

const THREADS_QUERY = `
query($owner:String!, $name:String!, $pr:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      reviewThreads(first:100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first:50) {
            nodes { databaseId author { login } body }
          }
        }
      }
    }
  }
}`;

export function cmdThreads(opts, { runGh = ghOrDie, die = fail, log = console.log } = {}) {
  const repo = resolveRepo(opts.repo, opts.cwd);
  const [owner, name] = repo.split('/');
  const res = runGh(
    ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${opts.pr}`],
    { cwd: opts.cwd },
  );
  const threads = JSON.parse(res).data.repository.pullRequest.reviewThreads.nodes;

  // Completeness check BEFORE any output. This query is unpaginated, and
  // SKILL.md leans on the result as the merge-ready signal — so a full page must
  // never be reported as the whole story. "no unresolved review threads" printed
  // off a truncated page is the same silent-completeness claim this script
  // removed from `post`, on the command that decides whether to merge.
  const fatThread = threads.find((t) => t.comments?.nodes?.length === COMMENTS_PAGE);
  if (threads.length === THREADS_PAGE || fatThread) {
    const what = threads.length === THREADS_PAGE
      ? `the thread list came back with exactly ${THREADS_PAGE} entries`
      : `thread ${fatThread.path}:${fatThread.line ?? '?'} came back with exactly ${COMMENTS_PAGE} comments`;
    die(
      6,
      `TRUNCATED: ${what}, which is this query's page size — there are almost certainly more.\n`
      + 'This command is not paginated, so its output cannot be trusted as a complete\n'
      + 'thread list, and "no unresolved review threads" would be a false merge-ready\n'
      + `signal. Adjudicate from the PR page instead: https://github.com/${repo}/pull/${opts.pr}/files`,
    );
    return;
  }

  const shown = opts.unresolved ? threads.filter((t) => !t.isResolved) : threads;

  if (shown.length === 0) {
    log(opts.unresolved ? 'no unresolved review threads' : 'no review threads on this PR');
    return;
  }
  log(`${shown.length} of ${threads.length} thread(s)${opts.unresolved ? ' (unresolved)' : ''}\n`);
  for (const t of shown) {
    const head = t.comments.nodes[0];
    const replies = t.comments.nodes.length - 1;
    const state = t.isResolved ? 'resolved' : 'OPEN';
    const first = String(head?.body ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
    log(`#${head?.databaseId}  ${t.path}:${t.line ?? '?'}  [${state}${t.isOutdated ? ', outdated' : ''}]  replies:${replies}`);
    log(`   ${head?.author?.login ?? '?'}: ${first.slice(0, 140)}`);
    log('');
  }
  log(`reply with:  node pr-review.mjs reply --pr ${opts.pr} --repo ${repo} --comment-id <id> --body-file <file>`);
}

export function cmdReply(opts, { runGh = ghOrDie, die = fail, log = console.log } = {}) {
  const repo = resolveRepo(opts.repo, opts.cwd);
  if (!existsSync(opts.bodyFile)) {
    die(2, `body file not found: ${opts.bodyFile}`);
    return;
  }
  const body = readFileSync(opts.bodyFile, 'utf8');
  if (body.trim() === '') {
    die(2, `body file is empty: ${opts.bodyFile}`);
    return;
  }
  const measureLog = opts.verdict ? resolveMeasureLog(opts.measureLog, opts.cwd, die) : null;
  if (opts.verdict && !measureLog) return;

  let lens = null;
  if (opts.verdict) {
    const original = JSON.parse(runGh(
      ['api', `repos/${repo}/pulls/comments/${opts.commentId}`],
      { cwd: opts.cwd },
    ));
    lens = new RegExp(`\\*\\*lens:\\*\\*\\s*(${LENS_LIST})\\b`, 'i').exec(String(original.body ?? ''))?.[1]?.toLowerCase() ?? null;
  }

  const res = runGh(
    [
      'api',
      '--method',
      'POST',
      `repos/${repo}/pulls/${opts.pr}/comments/${opts.commentId}/replies`,
      '--input',
      '-',
    ],
    { input: JSON.stringify({ body }), cwd: opts.cwd },
  );
  log(`replied        ${JSON.parse(res).html_url}`);
  if (opts.verdict) {
    appendMeasurementRow(measureLog, {
      ts: new Date().toISOString(), repo, pr: Number(opts.pr), comment_id: Number(opts.commentId), lens, verdict: opts.verdict,
    });
  }
}

// ---------------------------------------------------------------------------
// Reviewer lenses
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(SCRIPT_DIR, '..', 'reference', 'findings.schema.json');
const MEASURE_SUBPATH = ['data', 'outputs', 'projects', 'agentic-practice-transfer', 't1-lens-measure.jsonl'];

/**
 * Build the prompt from the same authoritative list that posting later checks.
 *
 * Two renders, one template. Standalone (`pinned_diff` absent) is byte-identical
 * to the baseline and tells the reviewer to fetch the diff itself. Coordinated
 * (`pinned_diff` present) inlines the compare-API patches captured at the pinned
 * head and removes the fetch instruction entirely: two lens invocations and a
 * post reading three separate live listings can otherwise review three different
 * things. The sentinel assertion in the tests runs on the RENDERED prompt — a
 * grep of this source would match the source, not the delivery.
 */
export function buildReviewerPrompt({ pr, repo, prFilePaths, pinned_diff, manifest }) {
  const paths = prFilePaths ?? (manifest?.files ?? []).map((file) => file.filename);
  const diffInstruction = pinned_diff === undefined
    ? `Read the diff with \`gh pr diff ${pr} --repo ${repo}\`. Read surrounding source as needed to judge correctness.`
    : 'Do not fetch the diff; review only the diff below. Read surrounding source as needed to judge correctness — it is read from the working directory, which can differ from the pinned revision below.';
  const pinnedSection = pinned_diff === undefined ? '' : [
    '',
    '',
    `## Authoritative diff (pinned at \`${pinned_diff.head_sha}\`)`,
    '',
    `Captured from \`${pinned_diff.base_sha}...${pinned_diff.head_sha}\`. This is the whole change under review.`,
    ...(pinned_diff.not_reviewed?.length > 0
      ? ['', `Not reviewed (no patch in the pinned compare — binary, or a change with no text side): ${pinned_diff.not_reviewed.join(', ')}.`]
      : []),
    '',
    pinned_diff.text,
  ].join('\n');
  return buildPromptText({ pr, repo, prFilePaths: paths, diffInstruction, pinnedSection });
}

function buildPromptText({ pr, repo, prFilePaths, diffInstruction, pinnedSection }) {
  return `Review pull request #${pr} in the repository at the current working directory.

READ-ONLY: modify nothing; do not create or delete files, and do not run git write commands.

${diffInstruction}

When a changed file affects prompt/template generation, configuration resolution, or dispatch selection, identify one concrete claim, its consumer, and the path producing the consumer input. Inspect the real rendered or resolved result through an existing safe renderer/resolver, or a captured result from that same path. In \`summary\`, record the claim, command or supplied-evidence provenance, decisive excerpt, and any unverified limitation. Do not create worktrees, write source or configuration, install packages, run git writes, start services, or dispatch real actions to obtain evidence; use in-memory inputs and read-only paths. If that is impossible, state the limitation and ask the conductor for a render capture. A tool-less reviewer may assess supplied render evidence but must never claim to have run the renderer. Do not report a defect finding solely because a check was skipped; record the skip as a stated limitation, as Workspace Integrity requires. A match found inside quoted source or inlined artifacts does not prove delivery: where a slot or insertion is claimed, pass a distinct sentinel through the slot and a different marker through the artifacts, and confirm the sentinel lands outside the artifacts section.

Authoritative PR file list:
${prFilePaths.join('\n')}

This list is coverage ground truth. Examine every entry and echo every entry you examined verbatim in \`examined_paths\`.${pinnedSection}

Report only correctness defects that matter after merge: wrong reachable behavior, violated contracts or invariants, an uncovered claimed case, a test/guard/checker that cannot fail on its claimed defect, or a broken adjacent consumer. Do not report style, naming, formatting, or speculative refactors.

Use severity P1 (blocks merge), P2 (should be resolved), or P3 (advisory). Each finding needs a changed repository-relative \`path\`, an anchorable post-change \`line\` where possible, and evidence in \`body\`.

Return ONLY JSON matching the schema. \`coverage\` is exactly \`examined ${prFilePaths.length} of ${prFilePaths.length} changed files\`; \`examined_paths\` echoes the authoritative list entries you examined verbatim.

Cite repo-relative paths exactly as they appear in the authoritative PR file list.`;
}

function defaultRun(program, args, { input, cwd } = {}) {
  return execFileSync(program, args, {
    input,
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

export function defaultCodexExe({ platform = process.platform } = {}) {
  if (platform !== 'win32') return 'codex';
  // Accepted Windows-only command-interpreter exception: this fixed argv only
  // invokes `npm root -g`, because npm is a .cmd shim. Pin cmd.exe rather than
  // accepting an environment-controlled ComSpec launch target.
  const npmRoot = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm root -g'], { encoding: 'utf8', windowsHide: true }).trim();
  const vendor = join(npmRoot, '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor');
  for (const entry of readdirSync(vendor, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(vendor, entry.name, 'bin', 'codex.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`codex.exe not found under: ${vendor}`);
}

function findWorkspaceRoot(cwd = process.cwd()) {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, 'projects')) && existsSync(join(current, 'data'))) return current;
    if (dirname(current) === current) return null;
  }
}

function resolveMeasureLog(explicit, cwd, die = fail) {
  if (explicit) return resolve(explicit);
  const root = process.env.WORKIT_WORKSPACE_ROOT || findWorkspaceRoot(cwd);
  if (root) return join(root, ...MEASURE_SUBPATH);
  die(2, 'no workspace root found; pass --measure-log');
  return null;
}

function appendMeasurementRow(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function stripCodeFences(text) {
  const trimmed = String(text).trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseLensOutput(raw, lens) {
  if (lens === 'opus') {
    const envelope = JSON.parse(stripCodeFences(raw));
    // Claude can return a structured object, but an empty object is not a
    // findings document and must not mask a valid JSON-string `result`.
    const structured = envelope?.structured_output
      && typeof envelope.structured_output === 'object'
      && !Array.isArray(envelope.structured_output)
      && Object.keys(envelope.structured_output).length > 0
      ? envelope.structured_output
      : envelope?.result;
    return typeof structured === 'string' ? JSON.parse(stripCodeFences(structured)) : structured;
  }
  return JSON.parse(stripCodeFences(raw));
}

function countSeverities(findings) {
  return Object.fromEntries([...SEVERITIES].map((severity) => [severity.toLowerCase(), findings.filter((f) => f.severity === severity).length]));
}

class LensOutputError extends Error {}

/**
 * Fail closed on a managed repository (D14).
 *
 * The expensive mistake is posting a review nobody coordinated, so a standalone
 * invocation on a coordinated repository refuses rather than proceeding, and an
 * installation that has a token but no readable list refuses everywhere. Returns
 * true when it refused.
 */
function managedGate({ command, repo, env, homeDir, log, die }) {
  const resolvedMode = resolveManaged({ repo, env, homeDir });
  if (resolvedMode.mode === MANAGED_MODES.configMissing) {
    emitOutcome({ outcome: 'refused', reason: MANAGED_MODES.configMissing, directory: resolvedMode.directory }, log);
    die(1, `a coordinator token is present but ${join(resolvedMode.directory, 'managed.json')} is missing or unreadable, so this repository cannot be classified. Nothing was ${command === 'post' ? 'posted' : 'run'}.`);
    return true;
  }
  if (resolvedMode.mode === MANAGED_MODES.managed) {
    // A usage error, deliberately, and not a JSON outcome line: `${command}`
    // without --attempt-ref is not a coordinated invocation, and D12's table
    // carries no reason for "you skipped claim".
    die(2, `${repo} is a managed repository: run \`pr-review.mjs claim --repo ${repo} --pr <n>\` first and pass its --attempt-ref to ${command}. Nothing was ${command === 'post' ? 'posted' : 'run'}.`);
    return true;
  }
  return false;
}

/**
 * `lens` — standalone, or coordinated when an attempt-ref is supplied.
 *
 * Same branch discipline as `post`: the standalone body below is unchanged.
 */
export function cmdLens(opts, deps = {}) {
  if (opts.attemptRef) return cmdLensCoordinated(opts, deps);
  return cmdLensStandalone(opts, deps);
}

/** Run exactly one model lens. The process runner is injected so tests never spawn. */
function cmdLensStandalone(opts, { run = defaultRun, die = fail, log = console.log, now = Date.now, findCodexExe = defaultCodexExe, env = process.env, homeDir } = {}) {
  if (managedGate({ command: 'lens', repo: opts.repo, env, homeDir, log, die })) return;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const repo = opts.repo;
  const reasoning = opts.reasoning ?? LENS_MODELS[opts.lens].reasoning;
  const model = LENS_MODELS[opts.lens].model;
  const promptPath = opts.promptOut ? resolve(opts.promptOut) : join(tmpdir(), `slim-review-${opts.lens}-${opts.pr}-prompt.txt`);
  const lensArgv = (tempOut) => isCodexLens(opts.lens)
    ? ['exec', '--model', model, '-c', `model_reasoning_effort=${reasoning}`, '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C', cwd, '--output-schema', SCHEMA_PATH, '-o', tempOut, '-']
    : ['-p', '--model', model, '--effort', reasoning, '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', '--output-format', 'json', '--json-schema', readFileSync(SCHEMA_PATH, 'utf8')];

  if (opts.dryRun) {
    log(`argv: ${JSON.stringify(lensArgv('<temporary findings.json>'))}`);
    log(`prompt path: ${promptPath}`);
    return;
  }
  const measureLog = resolveMeasureLog(opts.measureLog, cwd, die);
  if (!measureLog) return;
  const tempDir = mkdtempSync(join(tmpdir(), 'slim-review-lens-'));
  const tempOut = join(tempDir, 'findings.json');
  const argv = lensArgv(tempOut);
  let prFilePaths;
  try {
    prFilePaths = fetchPrFilePaths(repo, opts.pr, cwd, (args, ghOpts) => run(process.platform === 'win32' ? 'gh.exe' : 'gh', args, ghOpts));
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    die(4, `could not fetch PR files for ${repo}#${opts.pr}: ${err.message}`);
    return;
  }
  if (prFilePaths.length === 0) {
    rmSync(tempDir, { recursive: true, force: true });
    die(5, `the PR API returned no changed files for ${repo}#${opts.pr}; reviewer was not run.`);
    return;
  }
  const prompt = buildReviewerPrompt({ pr: opts.pr, repo, prFilePaths });
  if (opts.promptOut) {
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, 'utf8');
  }

  let raw;
  let wallMs;
  try {
    const program = isCodexLens(opts.lens) ? findCodexExe() : (process.platform === 'win32' ? 'claude.exe' : 'claude');
    const before = new Set(String(run(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', cwd, 'status', '--short', '--porcelain'], { cwd }))
      .split(/\r?\n/).filter(Boolean));
    const started = now();
    // Claude's -p mode on this box does not consume stdin (the live probe
    // returned a stale placeholder result), so its prompt is positional.
    raw = run(program, opts.lens === 'opus' ? [...argv, prompt] : argv, {
      ...(isCodexLens(opts.lens) ? { input: prompt } : {}),
      cwd,
    });
    wallMs = now() - started;
    // Observe the reviewer immediately, before our own --out and measurement
    // writes can make a deliberately in-worktree output look like misconduct.
    const after = String(run(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', cwd, 'status', '--short', '--porcelain'], { cwd }));
    if (isCodexLens(opts.lens) && !existsSync(tempOut)) {
      throw new LensOutputError(`${opts.lens} lens produced no findings file; API/CLI output: ${String(raw).trim()}`);
    }
    const source = isCodexLens(opts.lens) ? readFileSync(tempOut, 'utf8') : raw;
    let doc;
    try {
      doc = parseLensOutput(source, opts.lens);
    } catch (err) {
      throw new LensOutputError(`reviewer output is not valid JSON: ${err.message}`);
    }
    const problems = validateFindingsShape(doc);
    if (problems.length > 0) {
      throw new LensOutputError(`reviewer output has the wrong shape:\n  - ${problems.join('\n  - ')}`);
    }
    const coverageCheck = checkCoverage(doc.coverage, doc.examined_paths, prFilePaths);
    if (!coverageCheck.ok) {
      throw new LensOutputError(`reviewer output coverage check failed: ${coverageCheck.reason}`);
    }
    doc.lens = opts.lens;
    doc.model = model;
    doc.reasoning = reasoning;
    doc.wall_ms = wallMs;
    doc.findings = doc.findings.map((finding) => ({ ...finding, lens: opts.lens }));
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    const counts = countSeverities(doc.findings);
    const dirty = after.split(/\r?\n/).filter(Boolean).filter((line) => !before.has(line));
    appendMeasurementRow(measureLog, {
      ts: new Date().toISOString(), repo, pr: Number(opts.pr), lens: opts.lens, model, reasoning, wall_ms: wallMs,
      ...counts, examined: doc.examined_paths.length, coverage: doc.coverage, ...(dirty.length > 0 ? { dirty: true } : {}),
    });
    if (dirty.length > 0) {
      die(4, `reviewer added worktree changes:\n${dirty.join('\n')}`);
      return;
    }
    log(`wrote          ${opts.out}`);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    die(err instanceof LensOutputError ? 3 : 4, err instanceof LensOutputError ? err.message : `lens ${opts.lens} failed: ${err.message}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Coordinated plumbing
//
// Everything below runs only when a repository is coordinated: a manifest
// pinned between two head reads, an attempt claimed at the coordinator before
// any lens runs, the pinned diff inlined into the prompt, and a review POST the
// writer makes itself so that the process which reserved is the process which
// sends. Standalone invocations never reach any of it.
// ---------------------------------------------------------------------------

/**
 * Bounds (decisions.md D3). `maxFiles` is bounded by the compare API's 300-file
 * ceiling — raising it past 300 turns every large PR into a compare that cannot
 * agree with the manifest, which is `input-mismatch`, not a bigger review.
 *
 * The byte bound is NOT here. It arrives on the `GET /attempt` row as
 * `max_diff_bytes`, taken from the effective beat policy (`maxDiffBytes`) at
 * read time (v5.2 §W.5.2 item 15): a second literal in this file would agree
 * with the beat's until somebody lowered one of them, and then the writer would
 * not have moved (P6). It is measured over the compare payload the lens has just
 * fetched, before the model is invoked — nothing earlier knows the byte count,
 * because the listing carries additions/deletions and the manifest carries
 * `has_patch`.
 */
export const MAX_FILES = 250;

/** The review POST target. The env override is the test seam for a fake endpoint. */
export const GITHUB_API_DEFAULT = 'https://api.github.com';
export function githubApiBase(env = process.env) {
  const raw = env?.PR_REVIEW_GITHUB_API_BASE;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : GITHUB_API_DEFAULT;
}
export function reviewsUrl({ repo, pr, env = process.env }) {
  return `${githubApiBase(env)}/repos/${repo}/pulls/${pr}/reviews`;
}

/** The plugin version, stamped into the marker as the policy revision. */
export function pluginVersion({ scriptDir = SCRIPT_DIR } = {}) {
  try {
    return JSON.parse(readFileSync(join(scriptDir, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '-';
  } catch {
    return '-';
  }
}

/**
 * Produce the manifest — the one projection of "what this PR changes" that the
 * whole pinning design binds to.
 *
 * Order matters and is the point: `headRefOid` + `baseRefOid`, then the
 * paginated files list, then `headRefOid` again. A head that moved between the
 * two reads means the file list belongs to neither revision, so nothing is
 * produced and nothing is claimed. `base_sha` comes from the same read window,
 * so the three-dot compare a lens runs later describes the same change.
 *
 * There is exactly one implementation: a session's `claim` calls this in
 * process, the scheduled half spawns `pr-review.mjs manifest`.
 */
export function produceManifest({ repo, pr, cwd }, { runGh = gh, now = () => new Date() } = {}) {
  const readRefs = () => JSON.parse(runGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,baseRefOid'], { cwd }));
  const before = readRefs();
  const files = fetchPrFiles(repo, pr, cwd, runGh);
  const after = readRefs();
  if (before.headRefOid !== after.headRefOid) {
    return { ok: false, reason: 'revision-mismatch', head_before: before.headRefOid, head_now: after.headRefOid };
  }
  if (files.length === 0) {
    // A PR with no files is a fetch failure, never a real pull request — and an
    // empty manifest would allocate an attempt that reviews nothing.
    return { ok: false, reason: 'empty-file-list', head_sha: before.headRefOid };
  }
  return {
    ok: true,
    head_sha: before.headRefOid,
    base_sha: before.baseRefOid,
    manifest: {
      files,
      head_before: before.headRefOid,
      head_after: after.headRefOid,
      captured_at: now().toISOString(),
    },
  };
}

// --- the attempt-ref file --------------------------------------------------

/**
 * Where a session's attempt-ref file lives.
 *
 * Under the managed directory, which is per-user and root-independent, so the
 * same attempt resolves the same path from any checkout — and so the file
 * holding `worker_key` never lands inside a repository.
 */
export function attemptRefPath({ attemptRef, homeDir, explicit }) {
  if (explicit) return resolve(explicit);
  const [owner, name] = String(attemptRef.repo).split('/');
  return join(
    managedDirectory({ homeDir }),
    'attempts', `${owner}__${name}`, String(attemptRef.pr), String(attemptRef.head_sha), String(attemptRef.attempt),
    'attempt-ref.json',
  );
}

/**
 * Apply an owner-only ACL and read back what the filesystem actually did.
 *
 * M8: the mode is instructed HERE, at the write site, because this file carries
 * `worker_key` — the one credential that authorises calls against this attempt.
 * The observation is returned rather than enforced: a file whose ACL cannot be
 * tightened is a thing to report, not a reason to fail a claim that already
 * happened at the coordinator.
 */
function applyOwnerOnly(path, { platform = process.platform, run = defaultRun } = {}) {
  if (platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
      return `chmod 0600 applied on ${platform}`;
    } catch (err) {
      return `chmod failed on ${platform}: ${err.message}`;
    }
  }
  let account;
  try {
    account = userInfo().username;
  } catch (err) {
    return `could not resolve the current account: ${err.message}`;
  }
  try {
    run('icacls', [path, '/inheritance:r', '/grant:r', `${account}:F`], {});
    return String(run('icacls', [path], {})).trim().split(/\r?\n/).join(' | ');
  } catch (err) {
    return `icacls failed: ${err.message}`;
  }
}

/**
 * Write the attempt-ref file atomically, owner-only.
 *
 * Temp file plus rename: a half-written ref file is indistinguishable from a
 * ref file for a different attempt, and the reader is a separate process.
 */
export function writeAttemptRefFile(path, payload, { platform = process.platform, run = defaultRun } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
  return { path, observed: applyOwnerOnly(path, { platform, run }) };
}

/** Read it back, with every field the W endpoints need validated. */
export function readAttemptRefFile(path) {
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed = JSON.parse(raw);
  for (const key of ['attempt_ref', 'worker_key', 'coordinator']) {
    if (parsed?.[key] === undefined) throw new TypeError(`attempt-ref file is missing ${key}: ${path}`);
  }
  return parsed;
}

/** Delete it — only ever called once the attempt has left the live set. */
function discardAttemptRefFile(path, diag) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') diag(`could not remove the attempt-ref file ${path}: ${err.message}`);
  }
}

// --- the pinned diff -------------------------------------------------------

/**
 * Render the compare payload as one unified diff.
 *
 * The same text is the prompt's diff section and the anchoring input for
 * `post`, so a finding can only be line-anchored against the bytes the reviewer
 * was actually shown. Entries with no patch (binary, or a change with no text
 * side) are disclosed rather than dropped silently — they are files this PR
 * changes, and a reviewer told nothing about them cannot say so.
 */
export function renderPinnedDiff(comparePayload) {
  const sections = [];
  const notReviewed = [];
  let bytes = 0;
  for (const file of comparePayload?.files ?? []) {
    if (typeof file.patch !== 'string' || file.patch === '') {
      notReviewed.push(`${file.filename} (${file.status ?? 'unknown'})`);
      continue;
    }
    bytes += Buffer.byteLength(file.patch, 'utf8');
    sections.push(`diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`);
  }
  return { text: sections.join('\n'), not_reviewed: notReviewed, bytes };
}

// --- the review POST -------------------------------------------------------

/**
 * The positive allowlist for "no bytes left this process".
 *
 * undici raises exactly these before any application write, on the initial
 * connection attempt — and there is only ever an initial attempt, because
 * nothing here retries. Everything else, including a reset mid-body and a
 * timeout after the request was sent, is `unresolved`: process death cannot
 * retract bytes a server already received.
 */
export const NOT_SENT_CODES = Object.freeze(new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
]));

/**
 * Classify one submission. Receipt parsing lives inside the classifier: a 2xx
 * whose body will not parse is an unknown outcome, not a posted review.
 */
export function classifyPostOutcome({ response, error, bodyText }) {
  if (error) {
    const code = error?.cause?.code ?? error?.code;
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) {
      return { outcome: 'not_sent', wire: 'not-sent', reason: 'not-sent', detail: code };
    }
    return { outcome: 'unresolved', wire: 'unresolved', reason: 'delivery-unknown', detail: code ?? error?.name ?? String(error?.message ?? error) };
  }
  const status = response?.status;
  if (status >= 200 && status < 300) {
    let parsed;
    try {
      parsed = JSON.parse(String(bodyText));
    } catch {
      return { outcome: 'unresolved', wire: 'unresolved', reason: 'delivery-unknown', detail: `HTTP ${status} with an unparseable body` };
    }
    if (Number.isInteger(parsed?.id)) {
      return { outcome: 'posted', wire: 'posted', review_id: parsed.id, html_url: parsed.html_url };
    }
    return { outcome: 'unresolved', wire: 'unresolved', reason: 'delivery-unknown', detail: `HTTP ${status} with no review id` };
  }
  if ([401, 403, 404, 422].includes(status)) {
    return { outcome: 'post_rejected', wire: 'post_rejected', reason: 'definite-rejection', detail: `HTTP ${status}` };
  }
  return { outcome: 'unresolved', wire: 'unresolved', reason: 'delivery-unknown', detail: `HTTP ${status}` };
}

// ---------------------------------------------------------------------------
// Coordinated subcommands
//
// `managed` and `identity` are read-only-or-operator commands about the
// installation rather than about a pull request, and they are the first two
// invocations to carry the coordinated output contract: exactly one JSON line
// on stdout, every diagnostic on stderr. Standalone `lens` / `post` / `threads`
// / `reply` emit no such line, and the characterisation suite asserts both
// directions.
//
// Their exit integers are for humans and are not contractual — 0 when the
// outcome is `ok`, 1 when it is `refused`, and 4 when a `gh` call failed, the
// same 4 the rest of this script uses. The JSON line is the contract.
// ---------------------------------------------------------------------------

/**
 * Recovery and identity calls are logged verbatim on the coordinator's row with
 * who asked and why. The beat's recovery pass signs itself `beat`; this command
 * only ever runs from an operator's hand.
 */
const IDENTITY_ACTOR = 'operator';

/**
 * `managed --repo <r>` — what does this installation resolve for one
 * repository, and out of which directory?
 *
 * Read-only and side-effect free: the scheduled half runs it every tick and
 * compares the answer with its own, and the activation preflight runs it from
 * the service environment to catch a child process resolving a different
 * profile than the interactive shell. The token is never part of the answer.
 */
export function cmdManaged(opts, { log = console.log, die = fail, env = process.env, homeDir } = {}) {
  const resolved = resolveManaged({ repo: opts.repo, env, homeDir });
  const refused = resolved.mode === MANAGED_MODES.configMissing;
  emitOutcome({
    outcome: refused ? 'refused' : 'ok',
    ...(refused ? { reason: MANAGED_MODES.configMissing } : {}),
    mode: resolved.mode,
    repo: opts.repo,
    directory: resolved.directory,
    ...(resolved.coordinator === undefined ? {} : { coordinator: resolved.coordinator }),
    ...(resolved.repos === undefined ? {} : { repos: resolved.repos }),
  }, log);
  if (refused) {
    die(1, `a coordinator token is present but ${join(resolved.directory, 'managed.json')} is missing or unreadable, so this repository cannot be classified. Nothing was posted.`);
  }
}

/**
 * `identity --pin --reason "<why>"` — pin the posting login at the coordinator.
 *
 * Run once by the operator, under the same environment the service uses, so the
 * login the coordinator holds is the login the writer will actually post as.
 * The writer compares the two before every post and fails closed; this is the
 * only thing that writes the pinned value.
 */
export async function cmdIdentity(opts, {
  // The raw `gh` on purpose, not `ghOrDie`: this path has to classify its own
  // failure into the one JSON line rather than exit from underneath it.
  runGh = gh,
  log = console.log,
  die = fail,
  env = process.env,
  homeDir,
  makeClient = createClient,
} = {}) {
  const directory = managedDirectory({ homeDir });
  const token = loadCoordinatorToken({ env, homeDir });
  const list = readManagedList({ homeDir });
  if (token === null || !list.ok) {
    emitOutcome({ outcome: 'refused', reason: MANAGED_MODES.configMissing, directory }, log);
    die(1, token === null
      ? `no coordinator token in ${directory} and none in the environment; there is nothing to authenticate with.`
      : `no readable managed.json in ${directory}; the coordinator URL comes from that file.`);
    return;
  }

  let login;
  try {
    login = String(runGh(['api', 'user', '-q', '.login'], { cwd: opts.cwd })).trim();
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    // `gh-failure` is the reason table's name for a gh call that did not
    // answer. Its `retry` value is the table's, not this path's judgement.
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, `gh api user failed${stderr ? `:\n${stderr}` : ''}`);
    return;
  }
  if (login === '') {
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, 'gh api user returned an empty login; nothing was pinned.');
    return;
  }

  const result = await makeClient({ coordinator: list.coordinator, token })
    .identity({ login, actor: IDENTITY_ACTOR, reason: opts.reason });
  if (!result.ok) {
    emitOutcome({
      outcome: 'refused',
      reason: result.code,
      ...(result.source === 'coordinator' ? { coordinator_code: result.code } : {}),
    }, log);
    die(1, `the coordinator did not pin ${login}: ${result.message}`);
    return;
  }
  emitOutcome({ outcome: 'ok', login, coordinator: list.coordinator }, log);
}

/**
 * Resolve the coordinator this invocation talks to, and the token to talk with.
 *
 * URL precedence (decisions.md §W.1): under `--attempt-ref` the file's
 * `coordinator` is authoritative, for `claim` it is `managed.json`'s — and when
 * both are present and disagree the writer refuses rather than picking. Two
 * lists compared is the drift class; one list plus a refusal is the design.
 */
function resolveCoordinator({ env, homeDir, fileCoordinator }) {
  const directory = managedDirectory({ homeDir });
  const token = loadCoordinatorToken({ env, homeDir });
  if (token === null) {
    return { ok: false, reason: MANAGED_MODES.configMissing, directory, message: `no coordinator token in ${directory} and none in the environment; this installation is not provisioned to reach a coordinator.` };
  }
  const list = readManagedList({ homeDir });
  if (!list.ok) {
    return { ok: false, reason: MANAGED_MODES.configMissing, directory, message: `no readable managed.json in ${directory}; the coordinator URL comes from that file.` };
  }
  if (fileCoordinator !== undefined && fileCoordinator !== list.coordinator) {
    return {
      ok: false,
      reason: 'managed-resolver-disagreement',
      directory,
      message: `the attempt-ref file names the coordinator ${fileCoordinator} and ${join(directory, 'managed.json')} names ${list.coordinator}; refusing rather than choosing one.`,
    };
  }
  return { ok: true, token, coordinator: fileCoordinator ?? list.coordinator, directory, repos: list.repos };
}

/** Read the PR's review listing, projected to the fields both recognisers read. */
export function readReviewListing({ repo, pr, cwd, runGh = gh }) {
  const raw = runGh(
    ['api', '--paginate', `repos/${repo}/pulls/${pr}/reviews`, '--jq', '.[] | {review_id: .id, author_login: .user.login, commit_id, submitted_at, state, body}'],
    { cwd },
  );
  return String(raw).split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

/**
 * `manifest --repo <r> --pr <n>` — the one manifest producer, as a subcommand.
 *
 * Read-only. The scheduled half spawns this before its in-process claim so that
 * there is exactly one implementation of the projection the pinning binds to,
 * in one language, with one set of fixtures behind it.
 */
export function cmdManifest(opts, { runGh = gh, log = console.log, die = fail, diag = console.error, now } = {}) {
  let produced;
  try {
    produced = produceManifest({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd }, { runGh, ...(now ? { now } : {}) });
  } catch (err) {
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, `could not read the PR files for ${opts.repo}#${opts.pr}: ${err.message}`);
    return undefined;
  }
  if (!produced.ok) {
    emitOutcome({
      outcome: 'refused',
      reason: produced.reason,
      ...(produced.head_now === undefined ? {} : { head_now: produced.head_now }),
    }, log);
    die(1, produced.reason === 'revision-mismatch'
      ? `the head moved from ${produced.head_before} to ${produced.head_now} while the file list was being read; no manifest was produced.`
      : `the PR API returned no changed files for ${opts.repo}#${opts.pr}. That is a fetch failure, not a clean PR.`);
    return undefined;
  }
  diag(`manifest       ${produced.manifest.files.length} files at ${produced.head_sha.slice(0, 7)} (base ${produced.base_sha.slice(0, 7)})`);
  if (produced.manifest.files.length > MAX_FILES) {
    // Said out loud rather than refused here: the claim transaction is the
    // authority on the file-count bound, and it answers `bad-request`.
    diag(`note           ${produced.manifest.files.length} files is over the ${MAX_FILES}-file bound; a claim carrying this manifest will be refused`);
  }
  return emitOutcome({
    outcome: 'ok',
    manifest: produced.manifest,
    base_sha: produced.base_sha,
    // The file count is reported rather than judged: `maxFiles` is enforced by
    // the claim transaction (§W.3 step 2, `bad-request`) and, for the scheduled
    // half, by the listing-phase classifier. There is no writer-side reason
    // code for an over-count, and inventing one is an E2 escalation.
    file_count: produced.manifest.files.length,
  }, log);
}

/**
 * `claim` — allocate one attempt for this head and write the attempt-ref file.
 *
 * Order is the contract: identity before anything (a writer that would post as
 * the wrong login must not spend), then the manifest, then the dedupe
 * recogniser — which imports a review posted outside any attempt so the head
 * reads as reviewed and can be superseded — and only then `/claim`.
 */
export async function cmdClaim(opts, {
  runGh = gh,
  log = console.log,
  die = fail,
  diag = console.error,
  env = process.env,
  homeDir,
  makeClient = createClient,
  platform = process.platform,
  run = defaultRun,
} = {}) {
  const refuse = (reason, extra, message, code = 1) => {
    emitOutcome({ outcome: 'refused', reason, ...extra }, log);
    die(code, message);
  };
  const resolved = resolveCoordinator({ env, homeDir });
  if (!resolved.ok) {
    refuse(resolved.reason, { directory: resolved.directory }, resolved.message);
    return undefined;
  }
  const client = makeClient({ coordinator: resolved.coordinator, token: resolved.token });

  // 1. identity — the pinned login, and the credential this process would post
  //    with. A mismatch here has no attempt to withdraw yet, which is the whole
  //    reason the check runs before the claim as well as before the POST.
  const pinned = await client.readIdentity();
  if (!pinned.ok) {
    refuse(pinned.code, pinned.source === 'coordinator' ? { coordinator_code: pinned.code } : {}, pinned.message);
    return undefined;
  }
  let login;
  try {
    login = String(runGh(['api', 'user', '-q', '.login'], { cwd: opts.cwd })).trim();
  } catch (err) {
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, `gh api user failed: ${err?.stderr ? String(err.stderr).trim() : err.message}`);
    return undefined;
  }
  if (login !== pinned.body?.login) {
    refuse('identity-mismatch', { login, pinned_login: pinned.body?.login ?? null },
      `this credential posts as ${login || '(nothing)'} and the coordinator has ${pinned.body?.login} pinned; nothing was claimed.`);
    return undefined;
  }

  // 2. the manifest, pinned between two head reads
  let produced;
  try {
    produced = produceManifest({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd }, { runGh });
  } catch (err) {
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, `could not read the PR files for ${opts.repo}#${opts.pr}: ${err.message}`);
    return undefined;
  }
  if (!produced.ok) {
    refuse(produced.reason, produced.head_now === undefined ? {} : { head_now: produced.head_now },
      `no manifest for ${opts.repo}#${opts.pr}: ${produced.reason}. Nothing was claimed.`);
    return undefined;
  }

  // 3. the dedupe recogniser — skipped for an explicit supersede, which is the
  //    operator saying "yes, review this head again".
  if (!opts.supersede) {
    const status = await client.readStatus({ repo: opts.repo, pr: Number(opts.pr) });
    if (!status.ok) {
      refuse(status.code, status.source === 'coordinator' ? { coordinator_code: status.code } : {}, status.message);
      return undefined;
    }
    const replacedReviewIds = (status.body?.attempts ?? [])
      .filter((row) => row.state === 'replaced')
      .map((row) => row.review_id)
      .filter((id) => id !== null && id !== undefined);
    const listingCheckedAt = new Date().toISOString();
    let reviews;
    try {
      reviews = readReviewListing({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd, runGh });
    } catch (err) {
      emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
      die(4, `could not read the review listing for ${opts.repo}#${opts.pr}: ${err.message}`);
      return undefined;
    }
    const found = recognise({ reviews, head: produced.head_sha, serviceLogin: login, replacedReviewIds, listingCheckedAt });
    const hit = found.hits.find((item) => item.kind === 'dedupe');
    if (hit) {
      diag(`recognised     review ${hit.review_id} already covers ${produced.head_sha.slice(0, 7)}; importing it`);
      const imported = await client.recogniseImport({
        repo: opts.repo,
        pr: Number(opts.pr),
        head_sha: produced.head_sha,
        review_id: hit.review_id,
        author_login: hit.author_login,
        commit_id: hit.commit_id ?? produced.head_sha,
        listing_checked_at: found.listing_checked_at,
        ...(hit.marker === undefined ? {} : { marker: JSON.stringify(hit.marker) }),
      });
      if (!imported.ok) {
        refuse(imported.code, imported.source === 'coordinator' ? { coordinator_code: imported.code, review_id: hit.review_id } : { review_id: hit.review_id }, imported.message);
        return undefined;
      }
    }
  }

  // 4. the claim itself
  const workerKey = randomBytes(32).toString('hex');
  const result = await client.claim({
    repo: opts.repo,
    pr: Number(opts.pr),
    head_sha: produced.head_sha,
    base_sha: produced.base_sha,
    worker_key: workerKey,
    owner_label: opts.ownerLabel ?? 'session',
    manifest: produced.manifest,
    required_lenses: opts.singleLens ? [opts.lens ?? 'codex'] : ['codex', 'astra'],
    ...(opts.singleLens ? { exception_reason: opts.singleLens } : {}),
    ...(opts.supersede === undefined ? {} : { supersede_review_id: Number(opts.supersede), actor: IDENTITY_ACTOR, reason: opts.reason }),
  });
  if (!result.ok) {
    if (result.ended) diag(`ended attempt  ${JSON.stringify(result.ended)}`);
    if (result.live) diag(`live attempt   ${JSON.stringify(result.live)}`);
    refuse(
      result.code,
      {
        ...(result.source === 'coordinator' ? { coordinator_code: result.code } : {}),
        ...(result.live === undefined ? {} : { live: result.live }),
        ...(result.ended === undefined ? {} : { ended: result.ended }),
      },
      result.message,
    );
    return undefined;
  }

  const attemptRef = result.body.attempt_ref;
  const path = attemptRefPath({ attemptRef, homeDir, explicit: opts.attemptRefOut });
  const written = writeAttemptRefFile(path, {
    attempt_ref: attemptRef,
    worker_key: workerKey,
    coordinator: resolved.coordinator,
    required_lenses: result.body.required_lenses,
  }, { platform, run });
  diag(`attempt-ref    ${written.path}`);
  diag(`acl            ${written.observed}`);
  return emitOutcome({
    outcome: 'ok',
    attempt_ref: attemptRef,
    attempt_ref_file: written.path,
    required_lenses: result.body.required_lenses,
    ...(result.body.lease_until === undefined ? {} : { lease_until: result.body.lease_until }),
    // A replayed claim (the response was lost, the key decided) is `ok` with
    // this flag — v5.1 deleted the separate `reused` outcome.
    ...(result.status === 200 ? { replayed: true } : {}),
  }, log);
}

/**
 * `recognise --repo --pr --head [--run --attempt]` — run both recognisers over
 * the PR's review listing and print what they found.
 *
 * The scheduled half spawns this because it cannot run `gh` itself; a session
 * calls the same predicates in process. Neither the listing nor this command
 * resolves anything: it reports, and the caller decides.
 */
export async function cmdRecognise(opts, {
  runGh = gh,
  log = console.log,
  die = fail,
  env = process.env,
  homeDir,
  makeClient = createClient,
} = {}) {
  const refuse = (reason, extra, message, code = 1) => {
    emitOutcome({ outcome: 'refused', reason, ...extra }, log);
    die(code, message);
  };
  const resolved = resolveCoordinator({ env, homeDir });
  if (!resolved.ok) {
    refuse(resolved.reason, { directory: resolved.directory }, resolved.message);
    return undefined;
  }
  const client = makeClient({ coordinator: resolved.coordinator, token: resolved.token });
  const pinned = await client.readIdentity();
  if (!pinned.ok) {
    refuse(pinned.code, pinned.source === 'coordinator' ? { coordinator_code: pinned.code } : {}, pinned.message);
    return undefined;
  }
  const status = await client.readStatus({ repo: opts.repo, pr: Number(opts.pr) });
  if (!status.ok) {
    refuse(status.code, status.source === 'coordinator' ? { coordinator_code: status.code } : {}, status.message);
    return undefined;
  }
  const attempts = status.body?.attempts ?? [];
  const replacedReviewIds = attempts.filter((row) => row.state === 'replaced').map((row) => row.review_id).filter((id) => id !== null && id !== undefined);
  // Taken BEFORE the read: the coordinator compares this against a floor, and a
  // timestamp taken afterwards would claim the listing is fresher than it is.
  const listingCheckedAt = new Date().toISOString();
  let reviews;
  try {
    reviews = readReviewListing({ repo: opts.repo, pr: opts.pr, cwd: opts.cwd, runGh });
  } catch (err) {
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, `could not read the review listing for ${opts.repo}#${opts.pr}: ${err.message}`);
    return undefined;
  }
  const found = recognise({
    reviews,
    head: opts.head,
    serviceLogin: pinned.body?.login,
    replacedReviewIds,
    runId: opts.run,
    attempt: opts.attempt,
    // `probable` is "a review by this identity, created after the submission",
    // so it needs the submission's timestamp. `/status` does not carry one, so
    // the caller that has it — the row's owner — passes it.
    postAttemptedAt: opts.postAttemptedAt ?? attempts.find((row) => row.state === 'delivery-unresolved')?.post_attempted_at,
    listingCheckedAt,
  });
  return emitOutcome({ outcome: 'ok', hits: found.hits, listing_checked_at: found.listing_checked_at }, log);
}

/**
 * `recover <abandon|not-delivered|withdraw> --attempt-ref <file> --reason "<why>"`
 *
 * The operator's half of the R endpoints. None of them allocates anything.
 * `not-delivered` reads the listing itself — the coordinator requires a listing
 * checked after the floor, and if that listing shows the review, the honest
 * answer is that it was delivered, not that it was not.
 */
export async function cmdRecover(opts, {
  runGh = gh,
  log = console.log,
  die = fail,
  diag = console.error,
  env = process.env,
  homeDir,
  makeClient = createClient,
} = {}) {
  const refuse = (reason, extra, message, code = 1) => {
    emitOutcome({ outcome: 'refused', reason, ...extra }, log);
    die(code, message);
  };
  let file;
  try {
    file = readAttemptRefFile(opts.attemptRef);
  } catch (err) {
    die(2, `could not read the attempt-ref file: ${err.message}`);
    return undefined;
  }
  const resolved = resolveCoordinator({ env, homeDir, fileCoordinator: file.coordinator });
  if (!resolved.ok) {
    refuse(resolved.reason, { directory: resolved.directory }, resolved.message);
    return undefined;
  }
  const client = makeClient({ coordinator: resolved.coordinator, token: resolved.token });
  const attemptRef = file.attempt_ref;
  const done = (result, line) => {
    if (!result.ok) {
      refuse(result.code, result.source === 'coordinator' ? { coordinator_code: result.code } : {}, result.message);
      return undefined;
    }
    discardAttemptRefFile(resolve(opts.attemptRef), diag);
    return emitOutcome(line, log);
  };

  if (opts.recoverAction === 'abandon') {
    return done(await client.recoverAbandon({ attempt_ref: attemptRef, actor: IDENTITY_ACTOR, reason: opts.reason }), { outcome: 'ok', attempt_ref: attemptRef, recovered: 'abandon' });
  }
  if (opts.recoverAction === 'withdraw') {
    return done(await client.recoverWithdraw({ attempt_ref: attemptRef, actor: IDENTITY_ACTOR, reason: opts.reason }), { outcome: 'ok', attempt_ref: attemptRef, recovered: 'withdraw' });
  }

  const attempt = await client.readAttempt(attemptRef);
  if (!attempt.ok) {
    refuse(attempt.code, attempt.source === 'coordinator' ? { coordinator_code: attempt.code } : {}, attempt.message);
    return undefined;
  }
  const postGeneration = attempt.body?.post_generation;
  // The pinned login comes from the endpoint the contract guarantees for it;
  // a recogniser with no login to match on would find nothing and report the
  // head undelivered, which is the one answer that must not be guessed.
  const pinned = await client.readIdentity();
  if (!pinned.ok) {
    refuse(pinned.code, pinned.source === 'coordinator' ? { coordinator_code: pinned.code } : {}, pinned.message);
    return undefined;
  }
  const listingCheckedAt = new Date().toISOString();
  let reviews;
  try {
    reviews = readReviewListing({ repo: attemptRef.repo, pr: attemptRef.pr, cwd: opts.cwd, runGh });
  } catch (err) {
    emitOutcome({ outcome: 'failed', reason: 'gh-failure' }, log);
    die(4, `could not read the review listing for ${attemptRef.repo}#${attemptRef.pr}: ${err.message}`);
    return undefined;
  }
  const found = recognise({
    reviews,
    serviceLogin: pinned.body?.login,
    runId: attemptRef.run_id,
    attempt: attemptRef.attempt,
    postAttemptedAt: attempt.body?.post_attempted_at,
    listingCheckedAt,
  });
  const delivered = found.hits.find((item) => item.kind === 'delivery');
  if (delivered) {
    // The review is on the pull request. Releasing the head now would invite a
    // second one; recording the delivery is the arc the contract has for this.
    diag(`delivered      review ${delivered.review_id} carries this run and attempt`);
    return done(
      await client.recoverDelivery({ attempt_ref: attemptRef, actor: IDENTITY_ACTOR, reason: opts.reason, review_id: delivered.review_id, post_generation: postGeneration }),
      { outcome: 'posted', review_id: delivered.review_id, post_generation: postGeneration },
    );
  }
  return done(
    await client.recoverNotDelivered({
      attempt_ref: attemptRef,
      actor: IDENTITY_ACTOR,
      reason: opts.reason,
      post_generation: postGeneration,
      listing_checked_at: found.listing_checked_at,
      ...(opts.forceUnverified === undefined ? {} : { force_unverified: opts.forceUnverified }),
    }),
    { outcome: 'ok', attempt_ref: attemptRef, recovered: 'not-delivered', post_generation: postGeneration, listing_checked_at: found.listing_checked_at },
  );
}

/** `gh` through whichever process runner the caller injected. */
const ghVia = (runner) => (args, ghOpts) => runner(process.platform === 'win32' ? 'gh.exe' : 'gh', args, ghOpts);

/**
 * The `provider-limit` signature.
 *
 * D8 owes a measured capture of what the harness actually prints when the plan
 * window closes; until the activation preflight records one, this conservative
 * match is an ASSUMPTION and everything it does not match is `lens-error`, not
 * a pause. It is data, in one place, so the preflight can correct it without
 * touching the classifier.
 */
export const PROVIDER_LIMIT_PATTERNS = Object.freeze([
  /\busage limit\b/i,
  /\brate limit\b/i,
  /\bquota exceeded\b/i,
  /\bplan limit\b/i,
]);

/** Classify a lens invocation that did not produce a document. */
export function classifyLensFailure(err) {
  const text = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}\n${err?.message ?? ''}`;
  if (err?.killed === true || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') return 'timeout';
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(err?.code)) return 'spawn-error';
  if (PROVIDER_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return 'provider-limit';
  return 'lens-error';
}

/**
 * Invoke one model lens against an already-rendered prompt.
 *
 * Shared with nothing: the standalone path keeps its own body byte-for-byte
 * (M4). What this adds is classification — every failure leaves as one of D12's
 * lens reasons, because the caller has to tell the coordinator which of them
 * happened and the coordinator decides whether another start is allowed.
 */
function runLensModel({ lens, cwd, prompt, prFilePaths, run, findCodexExe, now }) {
  const reasoning = LENS_MODELS[lens].reasoning;
  const model = LENS_MODELS[lens].model;
  const tempDir = mkdtempSync(join(tmpdir(), 'slim-review-lens-'));
  const tempOut = join(tempDir, 'findings.json');
  const argv = isCodexLens(lens)
    ? ['exec', '--model', model, '-c', `model_reasoning_effort=${reasoning}`, '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C', cwd, '--output-schema', SCHEMA_PATH, '-o', tempOut, '-']
    : ['-p', '--model', model, '--effort', reasoning, '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', '--output-format', 'json', '--json-schema', readFileSync(SCHEMA_PATH, 'utf8')];
  try {
    let program;
    try {
      program = isCodexLens(lens) ? findCodexExe() : (process.platform === 'win32' ? 'claude.exe' : 'claude');
    } catch (err) {
      return { ok: false, reason: 'spawn-error', message: `could not resolve the ${lens} executable: ${err.message}` };
    }
    const gitExe = process.platform === 'win32' ? 'git.exe' : 'git';
    let before;
    try {
      before = new Set(String(run(gitExe, ['-C', cwd, 'status', '--short', '--porcelain'], { cwd })).split(/\r?\n/).filter(Boolean));
    } catch (err) {
      return { ok: false, reason: 'lens-error', message: `could not read the worktree status before the lens: ${err.message}` };
    }
    const started = now();
    let raw;
    try {
      raw = run(program, lens === 'opus' ? [...argv, prompt] : argv, { ...(isCodexLens(lens) ? { input: prompt } : {}), cwd });
    } catch (err) {
      return { ok: false, reason: classifyLensFailure(err), message: `lens ${lens} failed: ${err.message}` };
    }
    const wallMs = now() - started;
    let after;
    try {
      after = String(run(gitExe, ['-C', cwd, 'status', '--short', '--porcelain'], { cwd }));
    } catch (err) {
      return { ok: false, reason: 'lens-error', message: `could not read the worktree status after the lens: ${err.message}` };
    }
    if (isCodexLens(lens) && !existsSync(tempOut)) {
      return { ok: false, reason: 'malformed-output', message: `${lens} lens produced no findings file; API/CLI output: ${String(raw).trim()}` };
    }
    const source = isCodexLens(lens) ? readFileSync(tempOut, 'utf8') : raw;
    let doc;
    try {
      doc = parseLensOutput(source, lens);
    } catch (err) {
      return { ok: false, reason: 'malformed-output', message: `reviewer output is not valid JSON: ${err.message}` };
    }
    const problems = validateFindingsShape(doc);
    if (problems.length > 0) {
      return { ok: false, reason: 'malformed-output', message: `reviewer output has the wrong shape:\n  - ${problems.join('\n  - ')}` };
    }
    const coverageCheck = checkCoverage(doc.coverage, doc.examined_paths, prFilePaths);
    if (!coverageCheck.ok) {
      // An incomplete review is an incomplete handback, not a verdict: D5(c)
      // classes it with malformed output, and the coordinator's per-lens count
      // decides whether this lens gets another start.
      return { ok: false, reason: 'malformed-output', message: `reviewer output coverage check failed: ${coverageCheck.reason}` };
    }
    const dirty = after.split(/\r?\n/).filter(Boolean).filter((line) => !before.has(line));
    if (dirty.length > 0) {
      return { ok: false, reason: 'worktree-dirty', message: `reviewer added worktree changes:\n${dirty.join('\n')}`, wallMs };
    }
    return { ok: true, doc, wallMs, model, reasoning };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * `lens --attempt-ref <file>` — one lens execution against pinned input.
 *
 * The manifest comes from the coordinator, the patches from the compare API at
 * the pinned base and head, and the model is shown that diff instead of being
 * told to fetch one. Every exit from here reports to `/lens-end`, which is the
 * sole exhaustion authority: when it answers `terminal`, this writer says
 * `stop` and never starts another lens itself.
 */
async function cmdLensCoordinated(opts, {
  run = defaultRun,
  log = console.log,
  die = fail,
  diag = console.error,
  env = process.env,
  homeDir,
  makeClient = createClient,
  findCodexExe = defaultCodexExe,
  now = Date.now,
} = {}) {
  const runGh = ghVia(run);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const emit = (line) => emitOutcome(line, log);
  const refuse = (reason, extra, message, code = 1) => {
    emit({ outcome: 'refused', reason, ...extra });
    die(code, message);
  };

  let file;
  try {
    file = readAttemptRefFile(opts.attemptRef);
  } catch (err) {
    die(2, `could not read the attempt-ref file: ${err.message}`);
    return undefined;
  }
  const attemptRef = file.attempt_ref;
  const resolved = resolveCoordinator({ env, homeDir, fileCoordinator: file.coordinator });
  if (!resolved.ok) {
    refuse(resolved.reason, { directory: resolved.directory }, resolved.message);
    return undefined;
  }
  const client = makeClient({ coordinator: resolved.coordinator, token: resolved.token });
  const readHeadNow = () => {
    try {
      return String(runGh(['pr', 'view', String(attemptRef.pr), '--repo', attemptRef.repo, '--json', 'headRefOid', '-q', '.headRefOid'], { cwd })).trim();
    } catch {
      return undefined;
    }
  };

  /** A writer-local stop refusal after claim: withdraw, then report (D19). */
  const stop = async (reason, extra, message) => {
    const headNow = WITHDRAW_REASONS.has(reason) ? readHeadNow() : undefined;
    if (WITHDRAW_REASONS.has(reason)) {
      const withdrawn = await client.withdraw({
        attempt_ref: attemptRef,
        worker_key: file.worker_key,
        reason,
        ...(headNow === undefined ? {} : { head_now: headNow }),
      });
      if (!withdrawn.ok) {
        emit({ outcome: 'refused', reason: withdrawn.code, withdraw_reason: reason, ...(withdrawn.source === 'coordinator' ? { coordinator_code: withdrawn.code } : {}) });
        die(1, `${message}\nThe withdrawal itself was refused (${withdrawn.code}): ${withdrawn.message}`);
        return undefined;
      }
      discardAttemptRefFile(resolve(opts.attemptRef), diag);
    }
    emit({ outcome: 'refused', reason, ...(headNow === undefined ? {} : { head_now: headNow }), ...extra });
    die(1, message);
    return undefined;
  };

  if (opts.forcePost) {
    return stop('force-post-refused', {}, '--force-post is not available on a coordinated attempt (MN9); the attempt was withdrawn.');
  }
  if (opts.singleLens) {
    return stop('single-lens-refused', {}, '--single-lens is not available on a coordinated attempt: the lens set was fixed at claim; the attempt was withdrawn.');
  }

  const attempt = await client.readAttempt(attemptRef);
  if (!attempt.ok) {
    refuse(attempt.code, attempt.source === 'coordinator' ? { coordinator_code: attempt.code } : {}, attempt.message);
    return undefined;
  }
  const required = attempt.body?.required_lenses ?? file.required_lenses ?? [];
  if (!required.includes(opts.lens)) {
    return stop('lens-set-mismatch', { lens: opts.lens, required_lenses: required },
      `this attempt requires ${required.join(' + ') || '(nothing)'}, and --lens ${opts.lens} is not one of them; the attempt was withdrawn.`);
  }
  const manifest = attempt.body?.manifest;
  if (!manifest || !Array.isArray(manifest.files)) {
    refuse('coordinator-unreachable', {}, `the coordinator answered without a manifest for ${attemptRef.repo}#${attemptRef.pr}; nothing was started.`);
    return undefined;
  }
  const manifestPaths = manifest.files.map((entry) => entry.filename);
  // The byte bound is the coordinator's, never a literal of ours (v5.2 §W.5.2
  // item 15): an answer without it is a malformed coordinator answer, and gets
  // the same treatment as an answer without a manifest — nothing is started.
  const maxDiffBytes = attempt.body?.max_diff_bytes;
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes <= 0) {
    refuse('coordinator-unreachable', {}, `the coordinator answered without max_diff_bytes for ${attemptRef.repo}#${attemptRef.pr}; nothing was started.`);
    return undefined;
  }
  const fetchCompare = () => JSON.parse(runGh(['api', `repos/${attemptRef.repo}/compare/${attemptRef.base_sha}...${attemptRef.head_sha}`], { cwd }));
  const compareDisagreement = (payload) => {
    const compareSet = new Set((payload?.files ?? []).map((entry) => entry.filename));
    const missing = manifestPaths.filter((path) => !compareSet.has(path));
    const extra = [...compareSet].filter((path) => !manifestPaths.includes(path));
    return missing.length > 0 || extra.length > 0 ? { missing, extra } : null;
  };
  const promptPath = opts.promptOut ? resolve(opts.promptOut) : join(tmpdir(), `slim-review-${opts.lens}-${attemptRef.pr}-prompt.txt`);

  // The dry run renders from the same pinned inputs and stops before anything
  // mutating: a start consumed by a preview is a start the real run cannot have.
  if (opts.dryRun) {
    let payload;
    try {
      payload = fetchCompare();
    } catch (err) {
      emit({ outcome: 'failed', reason: 'gh-failure' });
      die(4, `could not fetch the pinned compare: ${err.message}`);
      return undefined;
    }
    const rendered = renderPinnedDiff(payload);
    const prompt = buildReviewerPrompt({
      pr: attemptRef.pr,
      repo: attemptRef.repo,
      prFilePaths: manifestPaths,
      manifest,
      pinned_diff: { head_sha: attemptRef.head_sha, base_sha: attemptRef.base_sha, text: rendered.text, not_reviewed: rendered.not_reviewed },
    });
    if (opts.promptOut) {
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(promptPath, prompt, 'utf8');
    }
    diag(`prompt path: ${promptPath}`);
    return emit({ outcome: 'ok', dry_run: true, prompt_path: promptPath, prompt_bytes: Buffer.byteLength(prompt, 'utf8') });
  }

  const started = await client.lensStart({ attempt_ref: attemptRef, worker_key: file.worker_key, lens: opts.lens });
  if (!started.ok) {
    refuse(started.code, {
      ...(started.source === 'coordinator' ? { coordinator_code: started.code } : {}),
      ...(started.ended === undefined ? {} : { ended: started.ended }),
    }, started.message);
    return undefined;
  }
  const executionId = started.body?.execution_id;

  /**
   * Every exit from here goes through `/lens-end`. `terminal: true` in its
   * answer is the only thing that turns a retryable reason into `stop`: the
   * budget belongs to the coordinator, and this writer never re-invokes a lens
   * on its own.
   */
  const finish = async ({ outcome, reason, documentPath, documentSha256, headNow, extra = {}, message, exitCode = 1 }) => {
    const ended = await client.lensEnd({
      attempt_ref: attemptRef,
      worker_key: file.worker_key,
      lens: opts.lens,
      execution_id: executionId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(documentPath === undefined ? {} : { document_path: documentPath, document_sha256: documentSha256 }),
      ...(headNow === undefined ? {} : { head_now: headNow }),
    });
    if (!ended.ok) {
      emit({ outcome: 'refused', reason: ended.code, execution_id: executionId, ...(ended.source === 'coordinator' ? { coordinator_code: ended.code } : {}) });
      die(1, `the coordinator refused the lens result (${ended.code}): ${ended.message}`);
      return undefined;
    }
    const terminal = ended.body?.terminal === true;
    const line = emit({
      outcome,
      ...(reason === undefined ? {} : { reason }),
      // The coordinator's exhaustion answer overrides the table: a third failed
      // start has already ended the row, so there is nothing to retry into.
      ...(terminal ? { retry: 'stop' } : {}),
      execution_id: executionId,
      ...(documentPath === undefined ? {} : { document: documentPath }),
      ...(headNow === undefined ? {} : { head_now: headNow }),
      ...(ended.body?.state === undefined ? {} : { state: ended.body.state }),
      ...extra,
    });
    // Only a terminal FAILURE takes the ref file: `lens_done` is terminal for
    // this lens and not for the attempt, and `post` still needs the key.
    if (terminal && outcome !== 'ok') discardAttemptRefFile(resolve(opts.attemptRef), diag);
    if (outcome !== 'ok') die(exitCode, message ?? `${reason}`);
    return line;
  };

  let payload;
  try {
    payload = fetchCompare();
  } catch (err) {
    return finish({ outcome: 'failed', reason: 'gh-failure', message: `could not fetch the pinned compare: ${err.message}`, exitCode: 4 });
  }
  const disagreement = compareDisagreement(payload);
  if (disagreement) {
    // Nothing has been invoked yet, and nothing will be: the compare and the
    // manifest describe different changes, so there is no pinned input.
    const headNow = readHeadNow();
    const moved = headNow !== undefined && headNow !== attemptRef.head_sha;
    return finish({
      outcome: 'refused',
      reason: moved ? 'revision-mismatch' : 'input-mismatch',
      headNow,
      extra: { compare_missing: disagreement.missing, compare_extra: disagreement.extra },
      message: `the pinned compare does not match the manifest (missing: ${disagreement.missing.join(', ') || 'none'}; extra: ${disagreement.extra.join(', ') || 'none'}); the model was not invoked.`,
    });
  }
  const rendered = renderPinnedDiff(payload);
  if (rendered.bytes > maxDiffBytes) {
    return finish({
      outcome: 'refused',
      reason: 'diff-too-large',
      extra: { patch_bytes: rendered.bytes, max_diff_bytes: maxDiffBytes },
      message: `the pinned diff is ${rendered.bytes} bytes and the bound is ${maxDiffBytes}; the model was not invoked.`,
    });
  }

  const prompt = buildReviewerPrompt({
    pr: attemptRef.pr,
    repo: attemptRef.repo,
    prFilePaths: manifestPaths,
    manifest,
    pinned_diff: { head_sha: attemptRef.head_sha, base_sha: attemptRef.base_sha, text: rendered.text, not_reviewed: rendered.not_reviewed },
  });
  if (opts.promptOut) {
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, prompt, 'utf8');
  }
  let checkout;
  let result;
  try {
    checkout = createReviewWorktree({ repo: attemptRef.repo, headSha: attemptRef.head_sha, run, diag });
    result = runLensModel({ lens: opts.lens, cwd: checkout.cwd, prompt, prFilePaths: manifestPaths, run, findCodexExe, now });
    if (result.ok) {
      try { checkout.assertHead(); }
      catch (err) { result = { ok: false, reason: 'worktree-dirty', message: err.message }; }
    }
  } catch (err) {
    result = { ok: false, reason: 'lens-error', message: `could not prepare or use the pinned review checkout: ${err.message}` };
  } finally {
    checkout?.cleanup();
  }
  if (!result.ok) {
    return finish({ outcome: 'failed', reason: result.reason, message: result.message, exitCode: result.reason === 'gh-failure' ? 4 : 3 });
  }

  const doc = result.doc;
  doc.lens = opts.lens;
  doc.model = result.model;
  doc.reasoning = result.reasoning;
  doc.wall_ms = result.wallMs;
  doc.findings = doc.findings.map((finding) => ({ ...finding, lens: opts.lens }));
  // The four stamps. `post` refuses on any disagreement between these, the
  // AttemptRef, the marker and the head it re-reads.
  doc.head_sha = attemptRef.head_sha;
  doc.base_sha = attemptRef.base_sha;
  doc.attempt = attemptRef.attempt;
  doc.run_id = attemptRef.run_id;

  const documentPath = opts.out ? resolve(opts.out) : join(dirname(resolve(opts.attemptRef)), `${opts.lens}.json`);
  mkdirSync(dirname(documentPath), { recursive: true });
  writeFileSync(documentPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const documentSha256 = createHash('sha256').update(readFileSync(documentPath)).digest('hex');
  diag(`wrote          ${documentPath}`);
  recordMeasurement({
    measureLog: opts.measureLog,
    cwd,
    diag,
    row: {
      ts: new Date().toISOString(), repo: attemptRef.repo, pr: Number(attemptRef.pr), lens: opts.lens,
      model: result.model, reasoning: result.reasoning, wall_ms: result.wallMs, ...countSeverities(doc.findings),
      examined: doc.examined_paths.length, coverage: doc.coverage, attempt: attemptRef.attempt, run_id: attemptRef.run_id,
    },
  });
  return finish({ outcome: 'ok', documentPath, documentSha256, extra: { document_sha256: documentSha256 } });
}

/**
 * Append a measurement row when a log can be resolved.
 *
 * Best effort on the coordinated path: the scheduled half runs outside any
 * workspace, and a missing measurement log must not turn a completed lens into
 * a usage error.
 */
function recordMeasurement({ measureLog, cwd, diag, row }) {
  const file = measureLog ? resolve(measureLog) : (() => {
    const root = process.env.WORKIT_WORKSPACE_ROOT || findWorkspaceRoot(cwd);
    return root ? join(root, ...MEASURE_SUBPATH) : null;
  })();
  if (!file) {
    diag('measurement    skipped: no --measure-log and no workspace root');
    return;
  }
  appendMeasurementRow(file, row);
}

/** Load one persisted findings document without exiting the process. */
function loadDocumentSafely(path) {
  if (!existsSync(path)) return { ok: false, problem: `findings file not found: ${path}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, problem: `findings file is not valid JSON: ${path} (${err.message})` };
  }
  const problems = validateFindingsShape(parsed);
  if (problems.length > 0) return { ok: false, problem: `findings file has the wrong shape: ${path}\n  - ${problems.join('\n  - ')}` };
  return { ok: true, doc: parsed };
}

/**
 * `post --attempt-ref <file>` — the coordinated submission.
 *
 * Guard order is the contract (D5e): identity, then the head, then the stamps,
 * then the required-lens set, then per-document coverage against the pinned
 * manifest — all of it before `reserve-post`, so a deterministic contradiction
 * costs zero POSTs. After the reservation this process sends the review itself
 * and spawns nothing until `/resolve` has been called: the process that
 * reserved has to be the process that sends, or a recovery pass cannot tell a
 * dead sender from a live one.
 */
async function cmdPostCoordinated(opts, {
  runGh = ghOrDie,
  log = console.log,
  die = fail,
  diag = console.error,
  env = process.env,
  homeDir,
  makeClient = createClient,
  fetchImpl = fetch,
  senderPid = process.pid,
  timeoutMs = 15000,
} = {}) {
  const emit = (line) => emitOutcome(line, log);
  const refuse = (reason, extra, message, code = 1) => {
    emit({ outcome: 'refused', reason, ...extra });
    die(code, message);
  };
  let file;
  try {
    file = readAttemptRefFile(opts.attemptRef);
  } catch (err) {
    die(2, `could not read the attempt-ref file: ${err.message}`);
    return undefined;
  }
  const attemptRef = file.attempt_ref;
  const resolved = resolveCoordinator({ env, homeDir, fileCoordinator: file.coordinator });
  if (!resolved.ok) {
    refuse(resolved.reason, { directory: resolved.directory }, resolved.message);
    return undefined;
  }
  const client = makeClient({ coordinator: resolved.coordinator, token: resolved.token });
  const refFile = resolve(opts.attemptRef);
  const readHeadNow = () => {
    try {
      return String(runGh(['pr', 'view', String(attemptRef.pr), '--repo', attemptRef.repo, '--json', 'headRefOid', '-q', '.headRefOid'], { cwd: opts.cwd })).trim();
    } catch {
      return undefined;
    }
  };

  /** Writer-local stop refusal after claim: withdraw in this same invocation. */
  const stop = async (reason, extra, message, headNow) => {
    const head = headNow ?? (WITHDRAW_REASONS.has(reason) ? readHeadNow() : undefined);
    if (WITHDRAW_REASONS.has(reason)) {
      const withdrawn = await client.withdraw({
        attempt_ref: attemptRef,
        worker_key: file.worker_key,
        reason,
        ...(head === undefined ? {} : { head_now: head }),
      });
      if (!withdrawn.ok) {
        emit({ outcome: 'refused', reason: withdrawn.code, withdraw_reason: reason, ...(withdrawn.source === 'coordinator' ? { coordinator_code: withdrawn.code } : {}) });
        die(1, `${message}\nThe withdrawal itself was refused (${withdrawn.code}): ${withdrawn.message}`);
        return undefined;
      }
      discardAttemptRefFile(refFile, diag);
    }
    emit({ outcome: 'refused', reason, ...(head === undefined ? {} : { head_now: head }), ...extra });
    die(1, message);
    return undefined;
  };

  if (opts.forcePost) return stop('force-post-refused', {}, '--force-post is not available on a coordinated attempt (MN9); the attempt was withdrawn. Nothing was posted.');
  if (opts.singleLens) return stop('single-lens-refused', {}, '--single-lens is not available on a coordinated attempt: the lens set was fixed at claim. Nothing was posted.');

  // 1. identity, with the credential this process is about to post with
  const pinned = await client.readIdentity();
  if (!pinned.ok) {
    refuse(pinned.code, pinned.source === 'coordinator' ? { coordinator_code: pinned.code } : {}, pinned.message);
    return undefined;
  }
  let login;
  try {
    login = String(runGh(['api', 'user', '-q', '.login'], { cwd: opts.cwd })).trim();
  } catch (err) {
    emit({ outcome: 'failed', reason: 'gh-failure' });
    die(4, `gh api user failed: ${err?.stderr ? String(err.stderr).trim() : err.message}`);
    return undefined;
  }
  if (login !== pinned.body?.login) {
    return stop('identity-mismatch', { login, pinned_login: pinned.body?.login ?? null },
      `this credential posts as ${login || '(nothing)'} and the coordinator has ${pinned.body?.login} pinned; the attempt was withdrawn and nothing was posted.`);
  }

  // 2. the head, re-read now
  const headNow = readHeadNow();
  if (headNow === undefined) {
    emit({ outcome: 'failed', reason: 'gh-failure' });
    die(4, `could not re-read the head of ${attemptRef.repo}#${attemptRef.pr}; nothing was posted.`);
    return undefined;
  }
  if (headNow !== attemptRef.head_sha) {
    return stop('revision-mismatch', { head_sha: attemptRef.head_sha },
      `the head moved from ${attemptRef.head_sha.slice(0, 7)} to ${headNow.slice(0, 7)}; the findings describe the old head. Nothing was posted.`, headNow);
  }

  // 3. the row: the manifest to check against, and the documents to post
  const attempt = await client.readAttempt(attemptRef);
  if (!attempt.ok) {
    refuse(attempt.code, attempt.source === 'coordinator' ? { coordinator_code: attempt.code } : {}, attempt.message);
    return undefined;
  }
  const manifest = attempt.body?.manifest;
  if (!manifest || !Array.isArray(manifest.files)) {
    refuse('coordinator-unreachable', {}, `the coordinator answered without a manifest for ${attemptRef.repo}#${attemptRef.pr}; nothing was posted.`);
    return undefined;
  }
  const manifestPaths = manifest.files.map((entry) => entry.filename);
  const required = attempt.body?.required_lenses ?? file.required_lenses ?? [];
  const lensState = attempt.body?.lens_state ?? {};
  const documents = [];
  for (const lens of Object.keys(lensState)) {
    const path = lensState[lens]?.document_path;
    if (!path) continue;
    const loaded = loadDocumentSafely(resolve(path));
    if (!loaded.ok) {
      return stop('lens-set-mismatch', { lens }, `the ${lens} document the row points at could not be read, so the posted set cannot be the required set: ${loaded.problem}. Nothing was posted.`);
    }
    documents.push({ lens, path, doc: loaded.doc });
  }

  // 4. the stamped lens set must be the row's, exactly
  const stampedLenses = [...new Set(documents.map((item) => item.doc.lens ?? item.lens))].sort();
  const requiredSorted = [...required].sort();
  if (stampedLenses.length !== requiredSorted.length || stampedLenses.some((lens, i) => lens !== requiredSorted[i])) {
    return stop('lens-set-mismatch', { stamped_lenses: stampedLenses, required_lenses: requiredSorted },
      `this attempt requires ${requiredSorted.join(' + ') || '(nothing)'} and the documents carry ${stampedLenses.join(' + ') || '(nothing)'}. Nothing was posted.`);
  }

  // 5. every stamp agrees with the AttemptRef and with the other document
  for (const item of documents) {
    for (const stamp of DOCUMENT_STAMPS) {
      if (String(item.doc[stamp]) !== String(attemptRef[stamp])) {
        return stop('revision-mismatch', { lens: item.lens, stamp, document_value: item.doc[stamp] ?? null, attempt_value: attemptRef[stamp] },
          `the ${item.lens} document is stamped ${stamp}=${item.doc[stamp]} and this attempt is ${stamp}=${attemptRef[stamp]}. Nothing was posted.`, headNow);
      }
    }
  }

  // 6. the marker the review will carry, checked against the same stamps
  const supersedes = attempt.body?.supersedes_review_id ?? null;
  const markerFromDocuments = buildMarker({
    repo: attemptRef.repo, pr: attemptRef.pr, head: documents[0]?.doc.head_sha, base: documents[0]?.doc.base_sha,
    lenses: stampedLenses, run: documents[0]?.doc.run_id, attempt: documents[0]?.doc.attempt, policy: pluginVersion(), supersedes,
  });
  const markerFromRef = buildMarker({
    repo: attemptRef.repo, pr: attemptRef.pr, head: attemptRef.head_sha, base: attemptRef.base_sha,
    lenses: requiredSorted, run: attemptRef.run_id, attempt: attemptRef.attempt, policy: pluginVersion(), supersedes,
  });
  if (markerFromDocuments !== markerFromRef) {
    return stop('revision-mismatch', { marker: markerFromDocuments }, `the marker built from the documents disagrees with the marker built from this attempt. Nothing was posted.`, headNow);
  }

  // 7. per-document coverage against the PINNED manifest — the check that
  //    already existed, pointed at the manifest instead of a live listing.
  for (const item of documents) {
    const check = checkCoverage(item.doc.coverage, item.doc.examined_paths, manifestPaths);
    if (!check.ok) {
      return stop('coverage-mismatch', { lens: item.lens, coverage_reason: check.reason },
        `the ${item.lens} document does not cover the pinned manifest: ${check.reason}. Nothing was posted.`);
    }
  }

  // 8. anchoring, against the same pinned patches the lenses were shown
  let comparePayload;
  try {
    comparePayload = JSON.parse(runGh(['api', `repos/${attemptRef.repo}/compare/${attemptRef.base_sha}...${attemptRef.head_sha}`], { cwd: opts.cwd }));
  } catch (err) {
    emit({ outcome: 'failed', reason: 'gh-failure' });
    die(4, `could not fetch the pinned compare: ${err.message}. Nothing was posted.`);
    return undefined;
  }
  const rendered = renderPinnedDiff(comparePayload);
  const diffFiles = parseDiff(rendered.text);
  const findings = documents.flatMap((item) => item.doc.findings.map((finding) => ({ ...finding, lens: finding.lens ?? item.doc.lens ?? item.lens })));
  const { anchored, offDiffChanged, offDiffUnchanged, offLine } = partitionFindings(findings, diffFiles, manifestPaths);
  const lensCounts = stampedLenses.map((lens) => {
    const own = findings.filter((finding) => finding.lens === lens);
    return {
      lens,
      P1: own.filter((finding) => finding.severity === 'P1').length,
      P2: own.filter((finding) => finding.severity === 'P2').length,
      P3: own.filter((finding) => finding.severity === 'P3').length,
    };
  });
  const payload = buildReviewPayload({
    summary: documents.map((item) => item.doc.summary).join('\n\n'),
    coverage: `examined ${manifestPaths.length} of ${manifestPaths.length} changed files`,
    anchored,
    offDiffChanged,
    offDiffUnchanged,
    offLine,
    coverageCheck: { ok: true, missing: [], extra: [], reason: '' },
    warnings: rendered.not_reviewed.length > 0 ? [`not reviewed (no patch in the pinned compare): ${rendered.not_reviewed.join(', ')}`] : [],
    lensCounts,
  });
  payload.commit_id = attemptRef.head_sha;
  payload.body = `${payload.body}\n\n${markerFromRef}`;
  diag(`repo           ${attemptRef.repo}`);
  diag(`pr             #${attemptRef.pr}`);
  diag(`head           ${attemptRef.head_sha.slice(0, 7)} (attempt ${attemptRef.attempt})`);
  diag(`changed files  ${manifestPaths.length} from the pinned manifest (${diffFiles.size} with commentable lines)`);
  diag(`findings       ${findings.length} → ${anchored.length} anchored · ${offLine.length} off-line · ${offDiffChanged.length} not-anchorable · ${offDiffUnchanged.length} off-diff`);

  if (opts.dryRun) {
    diag('--dry-run: nothing posted, nothing reserved.');
    return emit({ outcome: 'ok', dry_run: true, review_body_bytes: Buffer.byteLength(payload.body, 'utf8'), comments: payload.comments.length });
  }

  // 9. the credential, read BEFORE the reservation: `gh auth token` is a child
  //    process, and no process may be spawned between reserving and resolving.
  let githubToken = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!githubToken) {
    try {
      githubToken = String(runGh(['auth', 'token'], { cwd: opts.cwd })).trim();
    } catch (err) {
      emit({ outcome: 'failed', reason: 'gh-failure' });
      die(4, `could not read a GitHub credential: ${err.message}. Nothing was posted.`);
      return undefined;
    }
  }
  if (!githubToken) {
    emit({ outcome: 'failed', reason: 'gh-failure' });
    die(4, 'gh auth token returned nothing; there is no credential to post with.');
    return undefined;
  }

  // 10. reserve, send, resolve — one process, no spawn, no retry
  const reserved = await client.reservePost({ attempt_ref: attemptRef, worker_key: file.worker_key, sender_pid: senderPid });
  if (!reserved.ok) {
    if (['sender-unverifiable', 'disabled', 'paused', 'attempt-ended'].includes(reserved.code)) discardAttemptRefFile(refFile, diag);
    refuse(reserved.code, reserved.source === 'coordinator' ? { coordinator_code: reserved.code } : {}, reserved.message);
    return undefined;
  }
  const postGeneration = reserved.body?.post_generation;
  const url = reviewsUrl({ repo: attemptRef.repo, pr: attemptRef.pr, env });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let error;
  let bodyText;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'slim-review',
      },
      body: JSON.stringify(payload),
      // A followed redirect can re-send a request the first connection already
      // delivered. There is no retry here and no second attempt anywhere.
      redirect: 'error',
      signal: controller.signal,
    });
    bodyText = await response.text();
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(timer);
  }
  const classified = classifyPostOutcome({ response, error, bodyText });
  diag(`submission     ${classified.outcome}${classified.detail ? ` (${classified.detail})` : ''}`);

  const settled = await client.resolve({
    attempt_ref: attemptRef,
    worker_key: file.worker_key,
    post_generation: postGeneration,
    outcome: classified.wire,
    ...(classified.review_id === undefined ? {} : { review_id: classified.review_id }),
    ...(classified.reason === undefined ? {} : { reason: classified.detail ?? classified.reason }),
    head_now: headNow,
  });
  if (!settled.ok) {
    emit({
      outcome: 'refused',
      reason: settled.code,
      post_generation: postGeneration,
      submission: classified.outcome,
      ...(classified.review_id === undefined ? {} : { review_id: classified.review_id }),
      ...(settled.source === 'coordinator' ? { coordinator_code: settled.code } : {}),
    });
    die(1, `the review was ${classified.outcome} and the coordinator refused the resolution (${settled.code}): ${settled.message}`);
    return undefined;
  }
  // The ref file is deleted only when the attempt has left the live set. It
  // must survive `not-sent`, which returns the row to `lens_done` and needs the
  // same key for the second submission.
  const state = settled.body?.state;
  const terminal = settled.body?.terminal === true
    || ['posted', 'post_rejected', 'failed', 'replaced', 'superseded', 'withdrawn'].includes(state)
    || (state === undefined && ['posted', 'post_rejected'].includes(classified.outcome));
  if (terminal) discardAttemptRefFile(refFile, diag);
  if (classified.outcome === 'posted') diag(`posted         ${classified.html_url ?? `review ${classified.review_id}`}`);
  const line = emit({
    outcome: classified.outcome,
    ...(classified.reason === undefined ? {} : { reason: classified.reason }),
    post_generation: postGeneration,
    ...(classified.review_id === undefined ? {} : { review_id: classified.review_id }),
    head_now: headNow,
    ...(state === undefined ? {} : { state }),
  });
  if (classified.outcome !== 'posted') die(1, `review not posted: ${classified.outcome}${classified.detail ? ` (${classified.detail})` : ''}`);
  return line;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Commands that are about an installation or a login, never about one PR. */
const NO_PR_COMMANDS = new Set(['managed', 'identity', 'recover']);

const USAGE = `pr-review.mjs — mechanical half of the slim PR-review loop

  lens     --pr <n> --repo owner/name --lens codex|astra|opus --out <findings.json>
           [--reasoning low|medium|high] [--cwd <abs repo or worktree>]
           [--prompt-out <path>] [--measure-log <path>] [--dry-run]
  post     --pr <n> --repo owner/name --findings <file> --findings <file> [--dry-run] [--force-post]
           [--single-lens "<reason>"]   posting one lens is exit 7 unless the reason is given (it is stamped into the review)
  threads  --pr <n> --repo owner/name [--unresolved]
  reply    --pr <n> --repo owner/name --comment-id <id> --body-file <file>
           [--verdict confirmed|refuted|note] [--measure-log <path>]
  managed  --repo owner/name
           read-only: prints how this installation resolves that repository —
           standalone, managed, or managed-config-missing — with the directory
           it read. Takes no --pr. Never prints the token
  identity --pin --reason "<why>"
           pins the posting login (from gh api user) at the coordinator, once,
           from the environment the service runs under. Takes no --pr

On a managed repository (see below), the coordinated flow replaces steps 2 and 3:

  manifest --pr <n> --repo owner/name
           read-only: the pinned file list between two head reads, as
           {manifest, base_sha}. The one manifest producer
  claim    --pr <n> --repo owner/name [--supersede <review id> --reason "<why>"]
           [--single-lens "<why>" --lens codex|astra] [--owner-label <label>]
           [--attempt-ref-out <path>]
           allocates one attempt for the current head and writes the attempt-ref
           file (owner-only) whose path it prints
  lens     --attempt-ref <file> --lens codex|astra [--out <findings.json>]
           [--prompt-out <path>] [--dry-run]
           one lens execution against the pinned diff. --out defaults to the
           attempt's own directory
  post     --attempt-ref <file> [--dry-run]
           the coordinated submission: both documents, checked against the
           pinned manifest, posted by this process
  recognise --pr <n> --repo owner/name --head <sha>
           [--run <uuid> --attempt <k> --post-attempted-at <iso>]
           read-only: which reviews on this PR are already this identity's
  recover  abandon|not-delivered|withdraw --attempt-ref <file> --reason "<why>"
           [--force-unverified "<why>"]   the operator's recovery arcs

Coordinated output:
  managed, identity, manifest, claim, recognise, recover, and lens / post under
  --attempt-ref print exactly one JSON line on stdout ({outcome, reason?, retry,
  …}) with every diagnostic on stderr. Their exit codes are for humans and
  non-contractual: 0 ok, 1 refused, 3 no usable handback, 4 a gh call failed.
  The standalone commands above print no such line. Nothing retries itself.

Managed directory (both files optional; absent token = standalone everywhere):
  %USERPROFILE%/.workit/pr-review/coordinator-token   (env PR_REVIEW_COORDINATOR_TOKEN wins)
  %USERPROFILE%/.workit/pr-review/managed.json        { "coordinator": "...", "repos": ["owner/name"] }

Common:
  --repo   required for every command — cwd resolution silently answers about a
           different repo's PR of the same number
  --cwd    directory to run gh from (default: process cwd)

Lens safety:
  --lens         codex (Terra), astra (GPT-6 Astra), or opus; run one lens per
                 invocation, never the PR authoring model — the default loop
                 runs codex AND astra and posts both handbacks
  --reasoning    defaults to high for codex, low for astra and opus
  --measure-log  overrides the per-lens JSONL log (otherwise a workspace root is required)
  --dry-run      prints the exact reviewer argv and prompt path without running it
  status guard   fails if the reviewer adds any git status --porcelain line
`;

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

export function parseArgs(argv) {
  const [cmd, ...args] = argv;
  const opts = { cmd };
  // `recover` is the one command with a positional: the recovery arc it runs is
  // not a flag, because each is a different endpoint with different evidence.
  const rest = [...args];
  if (cmd === 'recover' && rest.length > 0 && !rest[0].startsWith('--')) {
    opts.recoverAction = rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) fail(2, `${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--pr': opts.pr = next(); break;
      case '--repo': {
        // Format-check here, not at use. `own/er/repo` passed every earlier
        // check, and cmdThreads destructures [owner, name] off the split — so it
        // queried a DIFFERENT repository and printed "no unresolved review
        // threads", the merge-ready signal, about it. Requiring --repo without
        // validating it left that hole open.
        const v = next();
        if (!/^[^/\s]+\/[^/\s]+$/.test(v)) {
          fail(2, `--repo must be owner/name (exactly one slash, no spaces), got: ${JSON.stringify(v)}`);
        }
        opts.repo = v;
        break;
      }
      case '--cwd': opts.cwd = next(); break;
      case '--findings': {
        const finding = next();
        opts.findings = opts.findings === undefined ? finding : (Array.isArray(opts.findings) ? [...opts.findings, finding] : [opts.findings, finding]);
        break;
      }
      case '--lens': opts.lens = next(); break;
      case '--out': opts.out = next(); break;
      case '--reasoning': opts.reasoning = next(); break;
      case '--prompt-out': opts.promptOut = next(); break;
      case '--measure-log': opts.measureLog = next(); break;
      case '--verdict': opts.verdict = next(); break;
      case '--comment-id': opts.commentId = next(); break;
      case '--body-file': opts.bodyFile = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force-post': opts.forcePost = true; break;
      case '--single-lens': {
        const v = next();
        if (v.trim() === '') fail(2, '--single-lens needs a non-empty reason');
        opts.singleLens = v;
        break;
      }
      case '--unresolved': opts.unresolved = true; break;
      case '--pin': opts.pin = true; break;
      case '--reason': {
        // Logged verbatim on the coordinator's row — an empty one records
        // nothing about why the login changed.
        const v = next();
        if (v.trim() === '') fail(2, '--reason needs a non-empty value');
        opts.reason = v;
        break;
      }
      case '--attempt-ref': opts.attemptRef = next(); break;
      case '--post-attempted-at': opts.postAttemptedAt = next(); break;
      case '--attempt-ref-out': opts.attemptRefOut = next(); break;
      case '--owner-label': opts.ownerLabel = next(); break;
      case '--head': opts.head = next(); break;
      case '--run': opts.run = next(); break;
      case '--attempt': {
        const v = next();
        if (!/^\d+$/.test(v)) fail(2, '--attempt must be a number');
        opts.attempt = Number(v);
        break;
      }
      case '--supersede': {
        const v = next();
        if (!/^\d+$/.test(v)) fail(2, '--supersede must be a numeric review id');
        opts.supersede = v;
        break;
      }
      case '--force-unverified': {
        const v = next();
        if (v.trim() === '') fail(2, '--force-unverified needs a non-empty reason');
        opts.forceUnverified = v;
        break;
      }
      case '-h': case '--help': opts.help = true; break;
      default: fail(2, `unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.cmd) {
    console.log(USAGE);
    process.exit(opts.cmd ? 0 : 2);
  }
  // Every command that asks about a pull request needs its number before
  // anything else runs. The two that ask about the installation instead take no
  // --pr at all: silently ignoring one would let `identity --pin --pr 5` read as
  // a per-PR pin, which is not a thing.
  if (NO_PR_COMMANDS.has(opts.cmd)) {
    if (opts.pr !== undefined) fail(2, `${opts.cmd} takes no --pr`);
  } else if (opts.attemptRef) {
    // Under --attempt-ref the pull request is a field of the AttemptRef, and
    // every call validates all six fields; a second, typed-in copy could only
    // disagree with it.
    if (opts.pr !== undefined) fail(2, `${opts.cmd} --attempt-ref takes no --pr: the attempt names its own pull request`);
  } else if (!opts.pr || !/^\d+$/.test(String(opts.pr))) {
    fail(2, '--pr <n> is required and must be a number');
  }

  switch (opts.cmd) {
    case 'post':
      if (opts.attemptRef) {
        // The documents come from the attempt's own row under --attempt-ref;
        // a --findings pair would be a second, unpinned source for the same
        // question, which is the thing the coordination exists to remove.
        if (opts.findings) fail(2, 'post --attempt-ref takes no --findings: the documents come from the attempt');
        return cmdPost(opts);
      }
      if (!opts.repo) fail(2, 'post needs --repo owner/name');
      if (!opts.findings) fail(2, 'post needs --findings <file>');
      return cmdPost(opts);
    case 'lens':
      if (!LENSES.has(opts.lens)) fail(2, `lens needs --lens ${LENS_LIST}`);
      if (opts.reasoning && !['low', 'medium', 'high'].includes(opts.reasoning)) fail(2, 'lens --reasoning must be low, medium, or high');
      if (opts.attemptRef) return cmdLens(opts);
      if (!opts.repo) fail(2, 'lens needs --repo owner/name');
      if (!opts.out) fail(2, 'lens needs --out <findings.json>');
      return cmdLens(opts);
    case 'manifest':
      if (!opts.repo) fail(2, 'manifest needs --repo owner/name');
      return cmdManifest(opts);
    case 'claim':
      if (!opts.repo) fail(2, 'claim needs --repo owner/name');
      if (opts.supersede !== undefined && !opts.reason) fail(2, 'claim --supersede needs --reason "<why>" — it is logged verbatim on the row');
      if (opts.singleLens && opts.lens && !LENSES.has(opts.lens)) fail(2, `claim --lens must be one of ${LENS_LIST}`);
      return cmdClaim(opts);
    case 'recognise':
      if (!opts.repo) fail(2, 'recognise needs --repo owner/name');
      if (!opts.head) fail(2, 'recognise needs --head <sha>');
      return cmdRecognise(opts);
    case 'recover':
      if (!['abandon', 'not-delivered', 'withdraw'].includes(opts.recoverAction)) {
        fail(2, 'recover needs one of abandon, not-delivered, withdraw');
      }
      if (!opts.attemptRef) fail(2, 'recover needs --attempt-ref <file>');
      if (!opts.reason) fail(2, 'recover needs --reason "<why>" — it is logged verbatim on the row');
      return cmdRecover(opts);
    case 'threads':
      // Not cosmetic: `threads --pr 53 --unresolved` from the wrong cwd prints
      // "no unresolved review threads" — the merge-ready signal — about someone
      // else's PR #53. Same number, different repo, and nothing says so.
      if (!opts.repo) fail(2, 'threads needs --repo owner/name');
      return cmdThreads(opts);
    case 'reply':
      if (!opts.repo) fail(2, 'reply needs --repo owner/name');
      if (!opts.commentId || !/^\d+$/.test(String(opts.commentId))) fail(2, 'reply needs --comment-id <numeric id>');
      if (!opts.bodyFile) fail(2, 'reply needs --body-file <file>');
      if (opts.verdict && !['confirmed', 'refuted', 'note'].includes(opts.verdict)) fail(2, 'reply --verdict must be confirmed, refuted, or note');
      return cmdReply(opts);
    case 'managed':
      if (!opts.repo) fail(2, 'managed needs --repo owner/name');
      return cmdManaged(opts);
    case 'identity':
      if (!opts.pin) fail(2, 'identity needs --pin (its only mode)');
      if (!opts.reason) fail(2, 'identity --pin needs --reason "<why>"');
      return cmdIdentity(opts);
    default:
      fail(2, `unknown command: ${opts.cmd}\n\n${USAGE}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const running = main(process.argv.slice(2));
  // The coordinated commands are async because the coordinator call is. A
  // rejection here would otherwise be an unhandled one with no exit code of its
  // own; the synchronous commands return nothing and are untouched.
  if (running instanceof Promise) running.catch((err) => fail(1, err?.stack ?? String(err)));
}
