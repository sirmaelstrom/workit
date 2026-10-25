/**
 * pr-review-rounds.mjs — the review-round cap (slim-review § 4), shared.
 *
 * One full paired review, then one delta pass (`lens --since <full head>`) on
 * a later head, then no third review. Which round a head is in is read from
 * the PR's posted review markers (`postedReviewScope` entries, in listing
 * order), never from a caller's own state, so a review posted by the beat, a
 * session or by hand counts the same.
 *
 * The cap has one implementation, this module. Three callers ask through
 * `pr-review.mjs rounds`: manual T1 (a session running slim-review § 4 by
 * hand), Observatory's pr-review beat, and conduct's `recoverAction`
 * (`land.mjs`). Separately, conduct imports helpers in process: `land.mjs` takes
 * `reviewEscalation`, `patchPlace` and `REBASE_FILE_READ_CAP`, and
 * `delta-recovery.mjs` takes `gitPatchId`, `patchPlace` and
 * `REBASE_FILE_READ_CAP`. Nothing in this module talks to the network except
 * `readTail` / `readRoundTail` / `readRebase`, which are handed their `gh`
 * runner.
 *
 * A rebase is mapped, not refused: when the tail from the last reviewed head
 * diverged, the head's commits past the base branch are matched to the
 * reviewed head's by `git patch-id --verbatim`, one for one. Every patch
 * reviewed and every reviewed patch still there → the head reads `reviewed`.
 * Some new → the delta runs from the last commit before the first new patch.
 * A merge whose own diff carries only base-branch content is no new patch. No
 * reviewed patch on the head, a reviewed patch dropped, or any read that
 * cannot be completed → the refusal stands as before.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** GitHub's compare API returns at most this many files, with no page past it. */
export const COMPARE_FILE_CAP = 300;

/** Past this many commits on either side, a rebase is not mapped (one diff read per commit). */
export const REBASE_COMMIT_CAP = 50;

/**
 * Why a compare cannot serve as an amendment diff, or null when it can.
 *
 * `since` must be an ancestor of the head (`status: ahead`): after a rebase or
 * a force-push the three-dot compare runs from a merge base, which carries
 * changes nobody amended. A compare at the file cap may be truncated, and a
 * truncated list would pass a partial review as complete. Either way there is
 * no amendment to check, and how to review that head is the conductor's call,
 * never a silent second full-PR round.
 */
export function amendmentProblem(payload, since, head) {
  const at = `${String(since).slice(0, 7)}...${String(head).slice(0, 7)}`;
  if (payload?.status === 'identical') return `the amendment ${at} changes nothing`;
  if (payload?.status !== 'ahead') {
    return `${String(since).slice(0, 7)} is not an ancestor of the head ${String(head).slice(0, 7)} (compare status: ${payload?.status ?? 'missing'}), so there is no amendment diff: amend with commits on top of the reviewed head, or the conductor decides how this head is reviewed`;
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length === 0) return `the amendment ${at} lists no changed files`;
  if (files.length >= COMPARE_FILE_CAP) return `the amendment ${at} lists ${files.length} files, the compare API's cap, so the list may be truncated; the conductor decides how this head is reviewed`;
  // A merge in the range (the lane merged the base branch in, or GitHub's
  // "Update branch") brings upstream changes nobody amended into the diff.
  // The commit list must be complete to say there is none.
  if (!Array.isArray(payload.commits)) return `the amendment compare ${at} carries no commit list, so a merge in the range cannot be ruled out`;
  if (Number.isInteger(payload.total_commits) && payload.total_commits > payload.commits.length) {
    return `the amendment ${at} has ${payload.total_commits} commits and the compare listed ${payload.commits.length}, so a merge in the range cannot be ruled out; the conductor decides how this head is reviewed`;
  }
  const merge = payload.commits.find((commit) => (commit?.parents?.length ?? 0) > 1);
  if (merge) {
    return `the amendment ${at} contains a merge commit (${String(merge.sha).slice(0, 7)}), so its diff carries changes nobody amended; amend without merging the base branch in, or the conductor decides how this head is reviewed`;
  }
  return null;
}

/**
 * Which review round the current head is in, from the posted reviews in
 * listing order (`postedReviewScope` entries). Pure.
 *
 *   full      no review yet — claim a full paired review
 *   reviewed  the last review is on this head — the existing path decides
 *   delta     a full review, no delta after it — claim a delta since its head
 *   capped    a delta after the last full review — no claim; converge on the tail
 *
 * Counting from the LAST full review means a full review the conductor ran
 * after a refused delta opens a fresh pair; nothing the loop claims does.
 */
export function reviewRound(reviews, head) {
  if (reviews.length === 0) return { round: 'full' };
  const last = reviews[reviews.length - 1];
  if (last.head === head) return { round: 'reviewed', last };
  let fullAt = -1;
  for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].scope === 'full') { fullAt = i; break; }
  // a delta with no full review before it cannot open round two again
  if (fullAt === -1 || reviews.slice(fullAt + 1).some((r) => r.scope === 'delta')) return { round: 'capped', last };
  return { round: 'delta', since: reviews[fullAt].head, last };
}

/**
 * The tail from the last reviewed head to the current head, read from one
 * compare payload (`repos/<repo>/compare/<from>...<to>`). Pure.
 *
 * `merge` and `commitsComplete` are read here, not from `problem`:
 * `amendmentProblem` answers "no changed files" before it looks at merges or
 * the commit list, and the zero-file exemption needs both.
 */
export function tailFromCompare(payload, from, to) {
  const commits = Array.isArray(payload?.commits) ? payload.commits : null;
  return {
    from,
    to,
    status: payload?.status ?? null,
    aheadBy: payload?.ahead_by ?? null,
    files: Array.isArray(payload?.files) ? payload.files.length : null,
    merge: commits ? commits.some((cm) => (cm?.parents?.length ?? 0) > 1) : null,
    commitsComplete: commits !== null && !(Number.isInteger(payload?.total_commits) && payload.total_commits > commits.length),
    problem: amendmentProblem(payload, from, to),
  };
}

/** Read the compare `<from>...<to>` through the given `gh` runner and project it to a tail. */
export function readTail({ repo, cwd, runGh, from, to }) {
  return tailFromCompare(JSON.parse(runGh(['api', `repos/${repo}/compare/${from}...${to}`], { cwd })), from, to);
}

/**
 * In the capped round (or a skipped delta): why the head cannot converge on
 * its tail from the last reviewed head `from`, or null when it can.
 *
 * Ancestry is not enough: after a merge from the base branch (or a commit
 * list too short to rule one out) the conductor decides how the head is
 * reviewed (slim-review § 4). An ahead tail that changes no file — an empty
 * commit to re-run CI — still converges, but only with no merge commit and a
 * complete commit list: a merge from base can leave the tree unchanged when
 * equivalent changes already landed.
 */
export function cappedTailProblem(tail, from, head) {
  if (!tail || tail.from !== from || tail.to !== head || tail.status !== 'ahead') return `compare status ${tail?.status ?? 'missing'}`;
  const emptyTail = tail.files === 0 && tail.merge === false && tail.commitsComplete === true;
  if (tail.problem && !emptyTail) return tail.problem;
  return null;
}

/** In the delta round: why `since...head` is not an amendment diff, or null — the writer's own rule. */
export function deltaTailProblem(tail, since, head) {
  if (!tail || tail.from !== since || tail.to !== head) return 'no amendment compare was read';
  return tail.problem;
}

// ---------------------------------------------------------------------------
// Rebase mapping by patch id
// ---------------------------------------------------------------------------

/**
 * `git patch-id --verbatim` of one diff text: the id, or null for an empty
 * diff. Reads stdin only, so it needs no repository. `--verbatim` keeps
 * whitespace (indentation is code in Python, YAML or a Makefile) and, like
 * `--stable`, sums per-file hashes so file order does not change the id; line
 * numbers are ignored, which is what lets a rebased patch match.
 */
export function gitPatchId(diff) {
  if (!diff || !diff.trim()) return null;
  const r = spawnSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git patch-id exited ${r.status}: ${String(r.stderr ?? '').trim()}`);
  const id = String(r.stdout ?? '').trim().split(/\s+/)[0];
  return id || null;
}

/**
 * Map the head's commits onto the reviewed patches. Pure.
 *
 *   chain     the head's commits past the base branch, oldest first, each
 *             { sha, reviewedSha, merge, patchId, located, clean }: `reviewedSha` when
 *             the same commit is in the reviewed head; `patchId` for a
 *             non-merge (null for an empty commit); `clean` for a merge whose
 *             own diff carries only base-branch content
 *   reviewed  the reviewed head's non-merge commits past the base that are
 *             NOT on the head by sha, each { sha, patchId, located, message }
 *
 * → { kind: 'identical', commits }
 *   { kind: 'delta', since, commits, fresh }   since = the last commit before
 *             the first new patch; every commit after it is reviewed again
 *   { kind: 'refused', reason }
 *
 * Patches are matched one for one (a multiset): a reviewed patch accounts for
 * at most one head commit. The reader binds each `patchId` to the commit's
 * place (`patchPlace`: the touched files' parent content, each hunk unique),
 * so equal ids are the same edits on the same files; `located: false` (no
 * fixed place) never matches on either side. A commit is new when it is a merge that is not
 * clean, or a non-empty non-merge no unmatched reviewed patch accounts for.
 * A reviewed patch the head no longer carries must have been REPLACED: a new
 * non-merge commit with the same commit message (a rebase keeps messages, and
 * a conflict resolution rewrites the patch under it) takes its place, one for
 * one, and is reviewed again in the delta as it now stands. Refused: a
 * reviewed patch with no replacement (a dropped commit changes the code as
 * much as an added one, and nothing here proves it landed upstream), a head
 * carrying no reviewed patch (a force-push of unrelated content), and a head
 * whose first commit is new (the delta would be the whole PR).
 */
export function mapRebase({ chain, reviewed }) {
  if (!Array.isArray(chain) || chain.length === 0) return { kind: 'refused', reason: 'the head has no commits past the base branch' };
  const unmatched = new Map();
  const messageOf = new Map();
  for (const r of reviewed ?? []) {
    if (r.patchId === null || r.patchId === undefined) continue; // an empty reviewed commit carried nothing
    // an unlocated reviewed patch matches nothing, so only a replacement accounts for it
    const key = r.located === false ? `unlocated:${r.sha}` : r.patchId;
    messageOf.set(r.sha, r.message);
    if (!unmatched.has(key)) unmatched.set(key, []);
    unmatched.get(key).push(r.sha);
  }
  let carried = 0;
  const fresh = chain.map((c) => {
    if (c.reviewedSha === true) { carried += 1; return false; }
    if (c.merge) return c.clean !== true;
    if (c.patchId === null) return false;
    // A patch id is blind to line numbers: a patch whose hunks could apply at
    // more than one place in its parent proves nothing about where it went.
    if (c.located === false) return true;
    const shas = unmatched.get(c.patchId);
    if (!shas || shas.length === 0) return true;
    shas.shift();
    carried += 1;
    return false;
  });
  if (carried === 0) return { kind: 'refused', reason: 'no commit on the head carries a reviewed patch, so this is not a rebase of the reviewed head' };
  const replacements = chain
    .filter((c, i) => fresh[i] && !c.merge && typeof c.message === 'string' && c.message.trim() !== '')
    .map((c) => c.message);
  const dropped = [...unmatched.values()].flat().filter((sha) => {
    const message = messageOf.get(sha);
    const at = typeof message === 'string' && message.trim() !== '' ? replacements.indexOf(message) : -1;
    if (at === -1) return true;
    replacements.splice(at, 1);
    return false;
  });
  if (dropped.length > 0) {
    return { kind: 'refused', reason: `the head no longer carries the reviewed patch of ${dropped.map((sha) => String(sha).slice(0, 7)).join(', ')}, and a dropped commit is a change no review saw` };
  }
  const first = fresh.indexOf(true);
  if (first === -1) return { kind: 'identical', commits: chain.length };
  if (first === 0) return { kind: 'refused', reason: `the head's first commit ${String(chain[0].sha).slice(0, 7)} carries a patch no review saw, so the delta would be the whole PR` };
  return { kind: 'delta', since: chain[first - 1].sha, commits: chain.length - first, fresh: fresh.filter(Boolean).length };
}

/** A compare `<base>...<sha>`'s commits as a first-parent line, oldest first, or a reason it is not one. */
function firstParentLine(payload, sha) {
  const commits = Array.isArray(payload?.commits) ? payload.commits : null;
  if (!commits) return { reason: `the compare to ${sha.slice(0, 7)} carries no commit list` };
  if (Number.isInteger(payload.total_commits) && payload.total_commits > commits.length) return { reason: `the compare to ${sha.slice(0, 7)} listed ${commits.length} of ${payload.total_commits} commits` };
  if (commits.length > REBASE_COMMIT_CAP) return { reason: `${commits.length} commits past the base branch, over the mapping cap of ${REBASE_COMMIT_CAP}` };
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const line = [];
  for (let at = bySha.get(sha); at; at = bySha.get(at.parents?.[0]?.sha)) {
    line.push(at);
    if (line.length > commits.length) break;
  }
  if (line.length !== commits.length) return { reason: `the history past the base branch to ${sha.slice(0, 7)} is not one first-parent line` };
  return { line: line.reverse() };
}

/** Past this many file reads, a rebase is not mapped (one read per changed file per commit). */
export const REBASE_FILE_READ_CAP = 200;

/**
 * The pre-image of every hunk in a unified diff, per file. Pure.
 *
 * → [{ path, newPath, created, hunks: [[line, …], …] }], where `path` is the
 * pre-image path (null for a created file), `newPath` the post-image path
 * (null for a deleted one), and each hunk lists its context and removed lines
 * in order; or null when a file header cannot be read (a quoted path), which
 * places nothing.
 */
export function diffPreimages(diffText) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { path: null, newPath: null, created: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('@@')) {
      if (!file.created && file.path === null) return null;
      hunk = [];
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) {
      if (raw.startsWith('--- ')) {
        const p = raw.slice(4).replace(/\r$/, '');
        if (p === '/dev/null') file.created = true;
        else if (p.startsWith('a/')) file.path = p.slice(2);
        else return null;
      } else if (raw.startsWith('+++ ')) {
        const p = raw.slice(4).replace(/\r$/, '');
        if (p.startsWith('b/')) file.newPath = p.slice(2);
        else if (p !== '/dev/null') return null;
      }
      continue; // index, mode, rename and Binary lines
    }
    if (raw.startsWith(' ') || raw.startsWith('-')) hunk.push(raw.slice(1));
  }
  return files;
}

/** How many times `block` occurs as consecutive lines of `lines`, counting to 2. */
function occurrences(lines, block) {
  let found = 0;
  for (let i = 0; i + block.length <= lines.length && found < 2; i++) {
    let j = 0;
    while (j < block.length && lines[i + j] === block[j]) j++;
    if (j === block.length) found++;
  }
  return found;
}

/**
 * Where a patch applies, as a key two patches can be compared by, or null
 * when its place is not fixed. Read at `parent` through `readFile`.
 *
 * The key names every file the patch touches with a hash of that file's
 * whole content in the parent (a created file by its new path alone). Two
 * patches with one patch id and one place key change byte-identical files
 * with the same text; and with every hunk's pre-image occurring exactly once
 * in its file, that text can sit at one place only, so the edits are the same
 * edits at the same place. A patch id alone is blind to line numbers: equal
 * ids over files the base changed (an identical block moved between
 * sections, say) can be edits at different places, which is why the key
 * carries the files' content and not only the uniqueness. Null (never a
 * match) for: a hunk whose pre-image is not unique, a file with no readable
 * path (binary, a pure rename, a quoted path).
 */
export function patchPlace(diffText, parent, readFile) {
  const files = diffPreimages(diffText);
  if (!files) return null;
  const parts = [];
  for (const f of files) {
    if (f.created) {
      if (!f.newPath) return null;
      parts.push(`+${f.newPath}`);
      continue;
    }
    if (f.path === null || f.hunks.length === 0) return null;
    const content = readFile(f.path, parent);
    const lines = content.split('\n');
    for (const hunk of f.hunks) {
      if (hunk.length === 0 ? content !== '' : occurrences(lines, hunk) !== 1) return null;
    }
    parts.push(`${f.path}\0${createHash('sha256').update(content).digest('hex')}`);
  }
  return parts.sort().join('\n');
}

/**
 * Map the head `to` onto the reviewed head `from` by patch id, through the
 * given `gh` runner. Every read is GET. A read that fails, or a history this
 * cannot map, answers `{ kind: 'unavailable', reason }` and the refusal stands.
 *
 * The base branch is the PR's live base ref, so both sides are measured from
 * the same tip: each side's commits are those its head has past it.
 */
export function readRebase({ repo, pr, cwd, runGh, from, to, patchIdOf = gitPatchId }) {
  try {
    const base = JSON.parse(runGh(['api', `repos/${repo}/pulls/${pr}`], { cwd }))?.base?.ref;
    if (typeof base !== 'string' || base === '') return { kind: 'unavailable', reason: 'the PR answered no base branch' };
    const compare = (a, b) => JSON.parse(runGh(['api', `repos/${repo}/compare/${a}...${b}`], { cwd }));
    const diff = (path) => runGh(['api', '-H', 'Accept: application/vnd.github.diff', path], { cwd });
    const files = new Map();
    const readFile = (path, ref) => {
      const key = `${ref}:${path}`;
      if (!files.has(key)) {
        if (files.size >= REBASE_FILE_READ_CAP) throw new Error(`over the mapping cap of ${REBASE_FILE_READ_CAP} file reads`);
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        files.set(key, runGh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${encoded}?ref=${ref}`], { cwd }));
      }
      return files.get(key);
    };
    // One commit's match key: its patch id bound to its place in its first
    // parent (`patchPlace`), so equal keys are the same edits on the same
    // file contents. A commit whose place is not fixed is unlocated.
    const commitPatch = (c) => {
      const text = diff(`repos/${repo}/commits/${c.sha}`);
      const patchId = patchIdOf(text);
      if (patchId === null) return { patchId: null, located: true };
      const place = patchPlace(text, c.parents[0].sha, readFile);
      if (place === null) return { patchId, located: false };
      return { patchId: `${patchId}:${createHash('sha256').update(place).digest('hex')}`, located: true };
    };
    const reviewed = firstParentLine(compare(base, from), from);
    if (reviewed.reason) return { kind: 'unavailable', reason: reviewed.reason };
    const headSide = firstParentLine(compare(base, to), to);
    if (headSide.reason) return { kind: 'unavailable', reason: headSide.reason };
    const reviewedShas = new Set(reviewed.line.map((c) => c.sha));
    const headShas = new Set(headSide.line.map((c) => c.sha));
    const isMerge = (c) => (c.parents?.length ?? 0) > 1;
    // Clean: the merge adds onto its second parent exactly what its first
    // parent added past their merge base — the branch's own changes and
    // nothing else, so no conflict resolution or edit rode in with it.
    // Both diffs must have one place key, in the merge's second parent and in
    // the parents' merge base: the files the branch touched are byte-identical
    // in both (the base did not change them), or one id could stand for edits
    // at two places.
    const cleanMerge = (c) => {
      if (c.parents.length !== 2) return false;
      const [p1, p2] = c.parents.map((p) => p.sha);
      const ontoText = diff(`repos/${repo}/compare/${p2}...${c.sha}`);
      const ownText = diff(`repos/${repo}/compare/${p2}...${p1}`);
      const onto = patchIdOf(ontoText);
      if (onto === null || onto !== patchIdOf(ownText)) return false;
      const mergeBase = compare(p2, p1)?.merge_base_commit?.sha;
      if (typeof mergeBase !== 'string') return false;
      const ontoPlace = patchPlace(ontoText, p2, readFile);
      return ontoPlace !== null && ontoPlace === patchPlace(ownText, mergeBase, readFile);
    };
    // A reviewed merge the head no longer carries must have been clean: an
    // edit that rode in with it was reviewed, and nothing here can match it
    // to a head commit, so its loss would read as no change at all.
    const lostMerge = reviewed.line.find((c) => isMerge(c) && !headShas.has(c.sha) && !cleanMerge(c));
    if (lostMerge) {
      return { kind: 'refused', reason: `the reviewed merge ${lostMerge.sha.slice(0, 7)} carried its own edits and the head no longer carries it` };
    }
    // A reviewed clean merge contributes no patch; a head commit carrying a
    // reviewed merge's content reads new (reviewed again), never the reverse.
    const reviewedPatches = reviewed.line
      .filter((c) => !isMerge(c) && !headShas.has(c.sha))
      .map((c) => ({ sha: c.sha, ...commitPatch(c), message: c.commit?.message }));
    const chain = headSide.line.map((c) => {
      if (reviewedShas.has(c.sha)) return { sha: c.sha, reviewedSha: true, merge: isMerge(c), patchId: null };
      if (!isMerge(c)) return { sha: c.sha, merge: false, ...commitPatch(c), message: c.commit?.message };
      return { sha: c.sha, merge: true, clean: cleanMerge(c), patchId: null };
    });
    const mapped = mapRebase({ chain, reviewed: reviewedPatches });
    if (mapped.kind === 'refused') return mapped;
    if (mapped.kind === 'delta') return { ...mapped, tail: readTail({ repo, cwd, runGh, from: mapped.since, to }) };
    return mapped;
  } catch (err) {
    return { kind: 'unavailable', reason: `a read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The tail a round reads: `readTail` from the last reviewed head, and the
 * patch-id mapping beside it as `rebase` when that compare diverged (a rebase
 * or a force-push) or is ahead with a merge in it (the base branch merged in).
 * A plain ahead tail is not mapped: it is already an amendment diff. The
 * compare itself failing still throws, as `readTail` does.
 *
 * `cache` (a Map, optional) keeps a settled mapping per `from...to` for a
 * caller that polls the same head, since a mapping costs a diff read per
 * commit. Both ends are commit shas, so only a moved base tip could change
 * the answer, and one polling run (bounded by its wall budget) takes the tip
 * it first read. An `unavailable` answer is never kept, so a failed read is
 * tried again.
 */
export function readRoundTail({ repo, pr, cwd, runGh, from, to, patchIdOf, cache }) {
  const tail = readTail({ repo, cwd, runGh, from, to });
  const mergedIn = tail.status === 'ahead' && tail.merge === true;
  if (tail.status !== 'diverged' && !mergedIn) return tail;
  const key = `${repo}#${pr}:${from}...${to}`;
  const kept = cache?.get(key);
  if (kept) return { ...tail, rebase: kept };
  const rebase = readRebase({ repo, pr, cwd, runGh, from, to, patchIdOf });
  if (cache && rebase.kind !== 'unavailable') cache.set(key, rebase);
  return { ...tail, rebase };
}

/** The wire summary of a mapping: kind, and its since / commit counts or reason. */
function rebaseSummary(rebase, from) {
  const out = { kind: rebase.kind, from };
  for (const key of ['since', 'commits', 'fresh', 'reason']) if (rebase[key] !== undefined) out[key] = rebase[key];
  return out;
}

/**
 * The round for one head, with the tail its problem was read from. Pure.
 *
 *   { answer, tail, from }
 *
 * `answer` is the `rounds` wire line (see `roundsAnswer`). `tail` / `from` are
 * the tail a capped or delta head converges on and where it starts: the tail
 * from the last reviewed head, or after a mapped rebase the tail from the
 * mapping's `since`. A rebase that maps with no new patch is `reviewed`, with
 * `rebased_from` naming the reviewed head it maps onto.
 */
export function resolveRound({ reviews, head, tail }) {
  const r = reviewRound(reviews, head);
  if (r.round === 'full') return { answer: { round: 'full', problem: null }, tail: null, from: null };
  const last = { head: r.last.head, scope: r.last.scope, review_id: r.last.review_id };
  const owed = [...reviews].reverse().find((review) => reviewEscalation(review));
  const signal = reviewEscalation(owed) ?? {};
  const count = r.last.scope === 'delta' && r.last.majorFindings > 0 ? { major_findings: r.last.majorFindings }
    : r.last.scope === 'full' && (r.last.p1Findings > 0 || r.last.p2Findings > 0) ? { p1_findings: r.last.p1Findings, p2_findings: r.last.p2Findings } : {};
  if (r.round === 'reviewed') return { answer: { round: 'reviewed', last, problem: null, ...count, ...signal }, tail: null, from: null };
  const rebase = tail && tail.from === r.last.head && tail.to === head ? tail.rebase : undefined;
  const rebased = rebase ? { rebase: rebaseSummary(rebase, r.last.head) } : {};
  if (rebase?.kind === 'identical') {
    return { answer: { round: 'reviewed', last, rebased_from: r.last.head, ...rebased, problem: null, ...count, ...signal }, tail: null, from: null };
  }
  const mapped = rebase?.kind === 'delta';
  const from = mapped ? rebase.since : r.round === 'delta' ? r.since : r.last.head;
  const effective = mapped ? rebase.tail : tail;
  if (r.round === 'delta') {
    return { answer: { round: 'delta', since: from, last, ...rebased, problem: deltaTailProblem(effective, from, head), ...count, ...signal }, tail: effective, from };
  }
  return { answer: { round: 'capped', last, ...rebased, problem: cappedTailProblem(effective, from, head), ...count, ...signal }, tail: effective, from };
}

/**
 * The T2 council a posted review owes, or null. A delta crosses at two or more
 * distinct in-amendment P1/P2 defects; a full review crosses at one P1 or two
 * distinct P2s. A review a council record already covers (`councilRoundId`)
 * owes nothing.
 */
export function reviewEscalation(review) {
  if (!review || review.councilRoundId) return null;
  if (review.scope === 'delta') {
    if (!Number.isInteger(review.majorFindings) || review.majorFindings < 2) return null;
    return { escalate: 't2-council', escalate_reason: `${review.majorFindings} posted in-amendment P1/P2 defects on review ${review.review_id}` };
  }
  if (review.scope !== 'full' || !Number.isInteger(review.p1Findings) || !Number.isInteger(review.p2Findings)) return null;
  if (review.p1Findings < 1 && review.p2Findings < 2) return null;
  return { escalate: 't2-council', escalate_reason: `full review ${review.review_id}: ${review.p1Findings} P1, ${review.p2Findings} P2` };
}

export const deltaEscalation = reviewEscalation;

/**
 * The `rounds` verb's answer for one head, given the scoped reviews and the
 * tail from the last reviewed head (null when there is none to read). Pure.
 *
 *   { round, since?, last?, rebased_from?, rebase?, problem }
 *
 * `since` only in the delta round (the last FULL review's head, or after a
 * mapped rebase the last commit before the first new patch); `last` absent in
 * the full round; `rebased_from` only on a `reviewed` head that is a
 * patch-identical rebase of `last.head`; `rebase` whenever a mapping was
 * attempted; `problem` is `deltaTailProblem` in the delta round,
 * `cappedTailProblem` in the capped round, and null otherwise.
 */
export function roundsAnswer({ reviews, head, tail }) {
  return resolveRound({ reviews, head, tail }).answer;
}
