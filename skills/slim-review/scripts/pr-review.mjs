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

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  return execFileSync('gh', args, {
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
export function partitionFindings(findings, diffFiles, prFilePaths = []) {
  const normalizePath = (path) => String(path).replace(/\\/g, '/').replace(/^\.\//, '');
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

  const normalizePath = (path) => String(path).replace(/\\/g, '/').replace(/^\.\//, '');
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
  return `**[${f.severity}] ${f.title}**\n\n${f.body}`;
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
}) {
  const sections = [summary.trim()];

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

export function cmdPost(opts, { runGh = ghOrDie, die = fail, log = console.log } = {}) {
  // Load the handback FIRST: a reviewer that never ran should fail before we
  // touch the network, and exit 3 must not depend on gh being reachable.
  const doc = loadFindings(opts.findings);
  const repo = resolveRepo(opts.repo, opts.cwd);

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
  const { anchored, offDiffChanged, offDiffUnchanged, offLine } =
    partitionFindings(doc.findings, diffFiles, prFilePaths);
  const coverageCheck = checkCoverage(doc.coverage, doc.examined_paths, prFilePaths);

  // Free ground-truth signal: two independent sources for "what this PR changes"
  // are already in hand. Divergence means the diff the reviewer read disagrees
  // with the file list it was told to echo. Non-blocking — it is a heads-up, not
  // a verdict — but silently discarding it is worse than printing it.
  const warnings = [];
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
  });

  // Print the receipt BEFORE any coverage die: the failure path is exactly where
  // an operator needs the numbers to decide about --force-post.
  log(`repo           ${repo}`);
  log(`pr             #${opts.pr}`);
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
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `pr-review.mjs — mechanical half of the slim PR-review loop

  post     --pr <n> --repo owner/name --findings <file> [--dry-run] [--force-post]
  threads  --pr <n> --repo owner/name [--unresolved]
  reply    --pr <n> --repo owner/name --comment-id <id> --body-file <file>

Common:
  --repo   required for every command — cwd resolution silently answers about a
           different repo's PR of the same number
  --cwd    directory to run gh from (default: process cwd)
`;

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd };
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
      case '--findings': opts.findings = next(); break;
      case '--comment-id': opts.commentId = next(); break;
      case '--body-file': opts.bodyFile = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force-post': opts.forcePost = true; break;
      case '--unresolved': opts.unresolved = true; break;
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
  if (!opts.pr || !/^\d+$/.test(String(opts.pr))) fail(2, '--pr <n> is required and must be a number');

  switch (opts.cmd) {
    case 'post':
      if (!opts.repo) fail(2, 'post needs --repo owner/name');
      if (!opts.findings) fail(2, 'post needs --findings <file>');
      return cmdPost(opts);
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
      return cmdReply(opts);
    default:
      fail(2, `unknown command: ${opts.cmd}\n\n${USAGE}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
