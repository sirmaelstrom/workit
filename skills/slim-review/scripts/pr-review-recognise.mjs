/**
 * pr-review-recognise.mjs — the one marker parser and the two recognisers.
 *
 * A coordinated review carries a marker in its body, and two different
 * questions are asked of a PR's review listing afterwards:
 *
 *   dedupe    "has this head already been reviewed by the posting identity?"
 *             — asked before every claim, so a review posted by a session, by
 *             the scheduled half, or by hand with `gh api` all suppress a second
 *             one. A hit with no attempt row is imported (`/recognise-import`)
 *             so the head reads as reviewed and can be superseded explicitly.
 *
 *   delivery  "did MY submission land?" — asked about an attempt whose POST
 *             returned nothing usable. It matches the marker's `run` + `attempt`
 *             exactly; a marker-less review by the posting identity created
 *             after the submission is `probable` and resolves nothing.
 *
 * Both live here because there must be exactly one marker parser: a second one
 * in the scheduled half is a wire format maintained in two places, which is the
 * drift class this whole design is trying not to reproduce. The scheduled half
 * spawns `pr-review.mjs recognise`; a session calls the same code in-process.
 *
 * Nothing in this module talks to the network. It is given the listing.
 */

/** The marker, as it appears in a posted review body (decisions.md D2). */
const MARKER_RE = /<!--\s*slim-review\s+([^>]*?)\s*-->/;

/** Fields the marker carries, in the order it writes them. */
export const MARKER_FIELDS = Object.freeze(['repo', 'pr', 'head', 'base', 'lenses', 'run', 'attempt', 'policy', 'supersedes']);

/** `-` is the marker's "absent" value: a standalone post has no run id. */
const ABSENT = '-';

/**
 * Render the marker for one posted review.
 *
 * Every value is written even when it is absent, so a reader can tell a field
 * that was empty from a field a different writer never wrote.
 */
export function buildMarker({ repo, pr, head, base, lenses, run, attempt, policy, supersedes }) {
  const pairs = [
    `repo=${repo}`,
    `pr=${pr}`,
    `head=${head}`,
    `base=${base}`,
    `lenses=${[...lenses].join('+')}`,
    `run=${run ?? ABSENT}`,
    `attempt=${attempt ?? ABSENT}`,
    `policy=${policy ?? ABSENT}`,
    `supersedes=${supersedes ?? ABSENT}`,
  ];
  return `<!-- slim-review ${pairs.join(' ')} -->`;
}

/**
 * Parse the marker out of a review body, or null when there is none.
 *
 * A legacy review — posted before the marker existed — is not an error and not
 * a miss: the recognisers below fall back to `commit_id`, which GitHub records
 * for every review, so a marker-less review still suppresses a duplicate.
 */
export function parseMarker(body) {
  const match = MARKER_RE.exec(String(body ?? ''));
  if (!match) return null;
  const marker = {};
  for (const token of match[1].split(/\s+/)) {
    const at = token.indexOf('=');
    if (at <= 0) continue;
    marker[token.slice(0, at)] = token.slice(at + 1);
  }
  if (marker.lenses !== undefined) marker.lenses = marker.lenses === ABSENT ? [] : marker.lenses.split('+');
  for (const key of ['run', 'supersedes', 'policy']) {
    if (marker[key] === ABSENT) marker[key] = null;
  }
  if (marker.attempt !== undefined) {
    marker.attempt = marker.attempt === ABSENT ? null : Number(marker.attempt);
  }
  return marker;
}

/** Normalise one listing entry, whatever projection produced it. */
function normalizeReview(review) {
  return {
    review_id: review.review_id ?? review.id,
    author_login: review.author_login ?? review.login ?? review.user?.login ?? null,
    commit_id: review.commit_id ?? null,
    submitted_at: review.submitted_at ?? null,
    body: review.body ?? '',
  };
}

/**
 * The dedupe predicate: a review by the pinned service login, on this head,
 * that has not been replaced.
 *
 * The head is matched from the marker OR from `commit_id`, because the second
 * is what a legacy or hand-posted review has. Broadening rather than excluding
 * is deliberate: a missed hit posts a second review on a head, and an extra hit
 * only refuses a claim the operator can still make explicitly with `--supersede`.
 */
export function isDedupeHit(review, { head, serviceLogin, replacedReviewIds = [] }) {
  const item = normalizeReview(review);
  if (item.author_login !== serviceLogin) return false;
  if (replacedReviewIds.some((id) => String(id) === String(item.review_id))) return false;
  const marker = parseMarker(item.body);
  return marker?.head === head || item.commit_id === head;
}

/**
 * The delivery predicate. Exactly two answers matter:
 *
 *   'delivery'  the marker names this run and this attempt — the submission
 *               landed, and the coordinator may record it posted
 *   'probable'  a marker-less review by the posting identity, created after the
 *               submission — evidence for a person, never a resolution
 */
export function deliveryKind(review, { runId, attempt, serviceLogin, postAttemptedAt }) {
  const item = normalizeReview(review);
  if (item.author_login !== serviceLogin) return null;
  const marker = parseMarker(item.body);
  if (marker) {
    return marker.run === runId && Number(marker.attempt) === Number(attempt) ? 'delivery' : null;
  }
  if (!postAttemptedAt || !item.submitted_at) return null;
  return Date.parse(item.submitted_at) > Date.parse(postAttemptedAt) ? 'probable' : null;
}

/**
 * Run both recognisers over one listing.
 *
 * `runId` / `attempt` / `postAttemptedAt` are the delivery half and are optional:
 * a pre-claim call has no attempt to ask about. Every hit carries
 * `author_login` because `/recognise-import` requires it and the predicate has
 * already matched on it (v5.1).
 */
export function recognise({
  reviews,
  head,
  serviceLogin,
  replacedReviewIds = [],
  runId,
  attempt,
  postAttemptedAt,
  listingCheckedAt,
}) {
  const hits = [];
  for (const review of reviews) {
    const item = normalizeReview(review);
    const marker = parseMarker(item.body);
    const kinds = [];
    if (head !== undefined && isDedupeHit(review, { head, serviceLogin, replacedReviewIds })) kinds.push('dedupe');
    if (runId !== undefined && runId !== null) {
      const kind = deliveryKind(review, { runId, attempt, serviceLogin, postAttemptedAt });
      if (kind) kinds.push(kind);
    }
    for (const kind of kinds) {
      hits.push({
        review_id: item.review_id,
        kind,
        author_login: item.author_login,
        commit_id: item.commit_id,
        ...(marker === null ? {} : { marker }),
      });
    }
  }
  return { outcome: 'ok', hits, listing_checked_at: listingCheckedAt };
}
