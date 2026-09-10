/**
 * pr-review-outcomes.mjs — the writer's half of the D12 outcome contract.
 *
 * Every coordinated invocation of `pr-review.mjs` prints exactly one JSON line
 * on stdout, `{outcome, reason?, retry, …}`, and every diagnostic on stderr.
 * This module owns the two closed vocabularies that line is built from:
 *
 *   OUTCOMES      what happened            (ok, refused, failed, posted, …)
 *   REASONS       why, and whether the caller may try again (`retry`)
 *
 * The table below is a transcription of `d12-reason-table.json`, which both
 * repositories vendor byte-identically (M2). The test asserts this constant
 * equals the vendored file's `reasons` / `outcomes` / `retry_values` and FAILS —
 * never skips — when the fixture is absent, so the two cannot drift silently.
 *
 * `retry` is derived here rather than written at the call site: two literals in
 * two commands is exactly how a contract gets a third value nobody agreed to.
 * A reason the table does not carry cannot be minted locally either — that is an
 * E2 escalation, not an edit to this file.
 */

/** The three-valued retry enum. Nothing else may appear in a JSON line. */
export const RETRY_VALUES = Object.freeze(['stop', 'lens-budget', 'post-budget']);

/** The outcome vocabulary. `reused` was deleted in v5.1 — a replayed claim is `ok` with `replayed: true`. */
export const OUTCOMES = Object.freeze(['ok', 'refused', 'failed', 'posted', 'unresolved', 'post_rejected', 'not_sent']);

/**
 * The reason table.
 *
 * `source` is a contract, not a label: a `writer` reason is one the writer
 * raises before spend or before `reserve-post` and reports through `/withdraw`;
 * a `writer-lens` reason is a lens-end outcome that `/withdraw` refuses
 * `bad-request`. Routing a `writer-lens` reason through `/withdraw` is a defect
 * the coordinator will catch, which is why the split lives in data.
 */
export const REASONS = Object.freeze([
  { reason: 'live-attempt', retry: 'stop', source: 'coordinator' },
  { reason: 'already-posted', retry: 'stop', source: 'coordinator' },
  { reason: 'attempt-ended', retry: 'stop', source: 'coordinator' },
  { reason: 'stale-attempt', retry: 'stop', source: 'coordinator' },
  { reason: 'bad-state', retry: 'stop', source: 'coordinator' },
  { reason: 'bad-request', retry: 'stop', source: 'coordinator' },
  { reason: 'disabled', retry: 'stop', source: 'coordinator' },
  { reason: 'paused', retry: 'stop', source: 'coordinator' },
  { reason: 'revision-mismatch', retry: 'stop', source: 'coordinator|writer' },
  { reason: 'lens-not-required', retry: 'stop', source: 'coordinator' },
  { reason: 'lens-running', retry: 'stop', source: 'coordinator' },
  { reason: 'stale-execution', retry: 'stop', source: 'coordinator' },
  { reason: 'stale-generation', retry: 'stop', source: 'coordinator' },
  { reason: 'sender-alive', retry: 'stop', source: 'coordinator' },
  { reason: 'sender-unverifiable', retry: 'stop', source: 'coordinator' },
  { reason: 'not-delivered-floor', retry: 'stop', source: 'coordinator' },
  { reason: 'lease-active', retry: 'stop', source: 'coordinator' },
  { reason: 'supersede-target-not-posted', retry: 'stop', source: 'coordinator' },
  { reason: 'unauthorized', retry: 'stop', source: 'coordinator' },
  { reason: 'coordinator-unreachable', retry: 'stop', source: 'client' },
  { reason: 'managed-config-missing', retry: 'stop', source: 'client' },
  { reason: 'managed-resolver-disagreement', retry: 'stop', source: 'client' },
  { reason: 'identity-unset', retry: 'stop', source: 'client' },
  { reason: 'identity-mismatch', retry: 'stop', source: 'writer' },
  { reason: 'lens-set-mismatch', retry: 'stop', source: 'writer' },
  { reason: 'coverage-mismatch', retry: 'stop', source: 'writer' },
  { reason: 'empty-file-list', retry: 'stop', source: 'writer' },
  { reason: 'single-lens-refused', retry: 'stop', source: 'writer' },
  { reason: 'force-post-refused', retry: 'stop', source: 'writer' },
  { reason: 'gh-failure', retry: 'lens-budget', source: 'writer-lens' },
  { reason: 'spawn-error', retry: 'lens-budget', source: 'writer-lens' },
  { reason: 'timeout', retry: 'lens-budget', source: 'writer-lens' },
  { reason: 'malformed-output', retry: 'lens-budget', source: 'writer-lens' },
  { reason: 'provider-limit', retry: 'stop', source: 'writer-lens' },
  { reason: 'lens-error', retry: 'stop', source: 'writer-lens' },
  { reason: 'worktree-dirty', retry: 'stop', source: 'writer-lens' },
  { reason: 'input-mismatch', retry: 'stop', source: 'writer-lens' },
  { reason: 'diff-too-large', retry: 'stop', source: 'writer-lens' },
  { reason: 'definite-rejection', retry: 'stop', source: 'writer-post' },
  { reason: 'delivery-unknown', retry: 'stop', source: 'writer-post' },
  { reason: 'not-sent', retry: 'post-budget', source: 'writer-post' },
]);

const BY_REASON = new Map(REASONS.map((row) => [row.reason, row]));

/** Every reason string the table carries. */
export const KNOWN_REASONS = Object.freeze(new Set(REASONS.map((row) => row.reason)));

/**
 * The reasons `/withdraw` accepts (decisions.md v5.2 §W.4, verbatim).
 *
 * A writer-local stop refusal raised after `claim` and before `reserve-post`
 * withdraws the attempt in the same invocation (D19); every other refusal
 * either never had an attempt to retire, or is the coordinator's own answer,
 * which has already retired the row where the contract says so.
 */
export const WITHDRAW_REASONS = Object.freeze(new Set([
  'identity-mismatch',
  'lens-set-mismatch',
  'coverage-mismatch',
  'revision-mismatch',
  'force-post-refused',
  'single-lens-refused',
]));

/**
 * The `retry` value for one reason.
 *
 * An unrecognised reason answers `stop`, deliberately: a code from a coordinator
 * newer than this writer is not something to retry into. It is still a test
 * failure — `KNOWN_REASONS` is asserted against the vendored table — but a
 * runtime crash here would turn an unknown refusal into no report at all.
 */
export function retryFor(reason) {
  if (reason === undefined || reason === null) return 'stop';
  return BY_REASON.get(reason)?.retry ?? 'stop';
}

/** The table row for one reason, or undefined. */
export function reasonRow(reason) {
  return BY_REASON.get(reason);
}

/**
 * Print the one JSON line.
 *
 * Key order is fixed — `outcome`, `reason?`, `retry`, then everything the caller
 * added — so the line reads the same way whichever command produced it, and
 * `retry` comes from the table above rather than from the call site.
 */
export function emitOutcome({ outcome, reason, ...rest }, log = console.log) {
  const line = {
    outcome,
    ...(reason === undefined ? {} : { reason }),
    retry: retryFor(reason),
    ...rest,
  };
  log(JSON.stringify(line));
  return line;
}
