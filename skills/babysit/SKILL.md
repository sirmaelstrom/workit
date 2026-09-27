---
name: babysit
description: "Converge a PR's paired review under bounds: claim the head, judge findings, fix, push, until a clean pass with threads resolved and CI green, or a blocked exit naming what is owed. Trigger on '/babysit', 'babysit this PR'. Managed repos only; never merges."
---

# Babysit — converge a PR's review, with bounds and a receipt

`slim-review` gets findings onto the PR. This is the loop that runs **after**
that, until the PR is honestly done: the review covers the head that will
merge, every finding has a verdict, checks are green on that exact head, and a
completed pass found nothing new. Or it stops with a reason a person can act on.

The session judges; the script observes, decides, waits and reports. Contract:
`data/outputs/workshops/pr-babysit/spec.md` (quest 14af0696).

## The three rounds (the T1 cap)

Babysit follows slim-review's cap (§ 4 Adjudicate, "Round two: the amendment
only"): at most **two reviews per PR**, one full and one delta.

1. **Full.** No review on the PR yet: claim the head and run both lenses over
   the whole PR.
2. **Delta.** The head moved after a posted full review: claim the new head and
   run both lenses with `--since <the full review's head>` under the same
   attempt-ref, so they review only the amendment.
3. **No third review.** The head moved after a posted delta review: no claim.
   The head converges on its checks and resolved threads, provided the last
   reviewed head is its ancestor with no merge from the base branch in
   between. The receipt names what only controls checked. Babysit does not
   verify that a post-delta fix's control was seen failing; that evidence
   lives in the lane report, and the receipt's tail tells the merge call what
   it covers.

The rounds come from the **markers of the reviews posted on the PR** (read with
slim-review's one marker parser), not from this skill's state file. A review
the beat or a hand-run slim-review posted counts. A marker with `since=` is a
delta, a marker without it is a full review, and a marker-less review with a
body is a legacy full review. A full review the conductor runs later (say,
after a rebase) starts a new pair.

**A refused delta blocks.** After a rebase, a merge from the base branch, or a
compare that can't be read whole, there is no amendment diff. The loop stops
with `amendment-not-descendant`, and the conductor decides how the head is
reviewed. The loop checks this with the writer's own rule before it claims. If
the writer refuses `--since` after the claim, the attempt stays live, and `owed`
names its attempt-ref file for the conductor's call. The loop never falls back
to a full review.

**`--claim beat` covers round one only.** The beat can't run a delta pass yet,
so round two is always a session claim, and the log line says so. The gap: if
you push a fix and wait longer than the beat's eligibility window before `run`,
the beat can post a full review on that head first. The beat's own migration
closes this.

## Convergence (the only clean exit)

For the PR's **current head** `H`, either:

- **a reviewed head.** The coordinator holds a **posted** paired attempt on `H`
  (lenses codex + astra), **or**
- **the tail after the cap.** `H` is past round two (or its delta was skipped,
  below), and the last posted review's head is an ancestor of `H`. The tail
  has no merge commit, and its commit list is complete. Either problem is
  `amendment-not-descendant`, and the conductor decides. A tail that changes
  no file, such as an empty commit to re-run CI, still converges, but only
  with no merge commit and a complete commit list. The receipt
  carries `unreviewed_tail`;

and in both cases, all at once:

1. **every** review thread on the PR is resolved;
2. every check on `H` is pass or skipping — none pending, failing, cancelled;
3. the head did not move while the loop read it.

A pending, failed, withdrawn, superseded or delivery-unresolved attempt, an
open thread, or a pending check never satisfies it.

## The loop

```bash
SCRIPT="${CLAUDE_SKILL_DIR}/scripts/pr-babysit.mjs"
node "$SCRIPT" run --pr <n> --repo <owner/name> --cwd "<ABSOLUTE CHECKOUT OF THE PR HEAD>" \
  [--context-file "$REVIEW_DIR/uncertainty.md"] [--skip-delta "<why the amendment is trivial>"]
```

`run` observes, decides, and then does one of three things. It waits (bounded).
It claims the head through the coordinated writer (`claim → lens codex → lens
astra → post`), with `--since` in round two. Or it returns to you. Exit codes
are the contract:

| Exit | Outcome | Your move |
|---|---|---|
| 0 | `converged` | write the quest receipt citing the JSON line; merge stays the operator's call |
| 3 | `adjudicate` | judge each open thread (below), push fixes, run again — the state file carries the bounds across runs |
| 2 | `blocked` | read `reason` and `owed`; do what it names, or hand it to a person |
| 4 | usage / `gh` failure | fix the invocation |

Every terminal exit prints one JSON receipt line: `{outcome, reason?, head,
review_id?, iterations, elapsedMinutes, owed?}`. A `converged` receipt also
carries:
- `judgment_notes`: the comment ids adjudicated `judgment` **through this
  skill**, for the operator's merge call. Threads judged outside babysit (a
  direct `pr-review.mjs reply`) are not listed.
- `unreviewed_tail` and `unreviewed_commits`, when the head converged past the
  cap: `"<last reviewed head>...<head>"` in short shas, and the commit count
  that only controls checked.
- `delta_skipped`: the `--skip-delta` reason, when it applied.

### Judging (exit 3)

```bash
node "$SCRIPT" threads --pr <n> --repo <owner/name> --cwd "<checkout>"          # every thread, OPEN first
node "$SCRIPT" adjudicate --pr <n> --repo <owner/name> --cwd "<checkout>" \
  --comment-id <id> --verdict confirmed|refuted|note|judgment --body-file reply-<id>.md \
  [--adjudicator lane|conductor|operator]
```

`adjudicate` replies through `pr-review.mjs reply --verdict` (so the T1
measurement row is written, attributed to that comment's lens) and then
**resolves the thread** — resolved is the state convergence reads, and this
verb is the only thing that sets it. The verdicts and who passes which
`--adjudicator` follow slim-review's verdict table (§ 4 Adjudicate). A
`judgment` thread is replied to and resolved like any other: the verdict is the
record, and the receipt lists it. A relative `--body-file` is resolved against
your working directory, not the checkout. A missing one exits 4 before anything
is replied. A confirmed finding is fixed on the branch
and pushed. The loop sees the new head as the next iteration and claims the
review its round is owed: a delta after a full review, nothing after a delta.
Verify against the code, not the claim. The reviewer had the diff and one pass;
you have the repo and the intent.

## Bounds (every one finite, every one named in the exit)

| Flag | Default | Meaning |
|---|---|---|
| `--max-heads` | 3 | iterations; a new head is one. Three is the full head, the delta head, and one fix after the delta |
| `--max-wall-minutes` | 90 | across re-runs (the state file carries `startedAt`) |
| `--poll-seconds` | 60 | never faster |
| `--session-claims` | 1 | session claims per head (retry authority, spec D4); `0` = never retry an ended automatic attempt |
| `--claim` | `session` | `session`: claim the head yourself now; `beat`: wait for the automatic attempt (≈15–30 min per head). Round one only |
| `--context-file` | — | the `pr-review.mjs uncertainty` output, passed to both lenses in both rounds; checked readable and non-empty before anything runs. It is kept in the state file, so a re-run without the flag reuses it; a new flag replaces it, and `--fresh` drops it |
| `--skip-delta` | — | `"<reason>"`: you judged this head's amendment trivial, so no delta is claimed; the head converges on the tail. It covers the current head only, and it is dropped (and logged) if the head moves during the first read. The reason goes into the state file and the receipt's `delta_skipped`. You pushed the fix, so the judgment is yours to make; babysit can't make it |
| `--fresh` | — | ignore the state file (a new run, new bounds); `judgment` ids are kept |

The review cap has no flag. Two reviews per PR is a T1 ruling, not a tunable.

Plan/cost stop is the coordinator's own: a claim refused `paused` or
`disabled` is `blocked`, never a retry.

## Blocked reasons (closed set)

`reviewer-never-answered` · `attempt-failed` · `attempt-ended-no-retry` ·
`ci-failed` · `head-moved-limit` · `wall-time` · `plan-paused` · `disabled` ·
`delivery-unresolved` · `integrity-violation` · `unresolved-threads` ·
`coordinator-unreachable` · `not-managed` · `checks-unavailable` ·
`threads-truncated` · `amendment-not-descendant` · `identity-unset`. Each
carries an `owed` sentence. `identity-unset` means the coordinator answered
but has no posting identity pinned. The operator pins one with
`pr-review.mjs identity --pin --reason "<why>"` (slim-review § Managed
repositories). `coordinator-unreachable` means the coordinator couldn't be
read at all.

## What it never does

- **Merge.** There is no merge path. `converged` is evidence for the receipt.
- **Allocate a second automatic attempt.** One session claim per head at most,
  none while the coordinator is paused or disabled, none over a live attempt.
- **Claim a third review, or a full review where a delta was refused.**
- **Re-POST a review** whose delivery is unresolved, or post outside the
  writer's coordinated `post --attempt-ref`.
- **Resolve a thread without a verdict reply**, or count anyone else's reply as
  an adjudication.
- **Wait past a bound silently.**

## Related

- `slim-review` — the review this converges; its standalone loop for
  repositories that are not managed (this skill blocks `not-managed` there).
- `burn-down` — invokes this at a PR boundary before closing an item.
