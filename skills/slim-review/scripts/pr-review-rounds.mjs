/**
 * pr-review-rounds.mjs — the review-round cap (slim-review § 4), shared.
 *
 * One full paired review, then one delta pass (`lens --since <full head>`) on
 * a later head, then no third review. Which round a head is in is read from
 * the PR's posted review markers (`postedReviewScope` entries, in listing
 * order), never from a caller's own state, so a review posted by the beat, a
 * session or by hand counts the same.
 *
 * Two callers ask: babysit's loop in process, and the scheduled beat through
 * `pr-review.mjs rounds`. Both read the answer from here, so the cap has one
 * implementation. Nothing in this module talks to the network except
 * `readTail`, which is handed its `gh` runner.
 */

/** GitHub's compare API returns at most this many files, with no page past it. */
export const COMPARE_FILE_CAP = 300;

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

/**
 * The `rounds` verb's answer for one head, given the scoped reviews and the
 * tail from the last reviewed head (null when there is none to read). Pure.
 *
 *   { round, since?, last?, problem }
 *
 * `since` only in the delta round (the last FULL review's head); `last` absent
 * in the full round; `problem` is `deltaTailProblem` in the delta round,
 * `cappedTailProblem` in the capped round, and null otherwise.
 */
export function roundsAnswer({ reviews, head, tail }) {
  const r = reviewRound(reviews, head);
  if (r.round === 'full') return { round: 'full', problem: null };
  const last = { head: r.last.head, scope: r.last.scope, review_id: r.last.review_id };
  if (r.round === 'reviewed') return { round: 'reviewed', last, problem: null };
  if (r.round === 'delta') return { round: 'delta', since: r.since, last, problem: deltaTailProblem(tail, r.since, head) };
  return { round: 'capped', last, problem: cappedTailProblem(tail, r.last.head, head) };
}
