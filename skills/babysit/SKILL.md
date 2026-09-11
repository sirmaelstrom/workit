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

## Convergence (the only clean exit)

For the PR's **current head** `H`, all four at once:

1. the coordinator holds a **posted** paired attempt on `H` (lenses codex + astra);
2. **every** review thread on the PR is resolved;
3. every check on `H` is pass or skipping — none pending, failing, cancelled;
4. the head did not move while the loop read it.

A pending, failed, withdrawn, superseded or delivery-unresolved attempt, an
open thread, or a pending check never satisfies it.

## The loop

```bash
SCRIPT="${CLAUDE_SKILL_DIR}/scripts/pr-babysit.mjs"
node "$SCRIPT" run --pr <n> --repo <owner/name> --cwd "<ABSOLUTE CHECKOUT OF THE PR HEAD>"
```

`run` observes, decides and either waits (bounded), claims the head through
the coordinated writer (`claim → lens codex → lens astra → post`), or returns
to you. Exit codes are the contract:

| Exit | Outcome | Your move |
|---|---|---|
| 0 | `converged` | write the quest receipt citing the JSON line; merge stays the operator's call |
| 3 | `adjudicate` | judge each open thread (below), push fixes, run again — the state file carries the bounds across runs |
| 2 | `blocked` | read `reason` and `owed`; do what it names, or hand it to a person |
| 4 | usage / `gh` failure | fix the invocation |

Every terminal exit prints one JSON receipt line: `{outcome, reason?, head,
review_id?, iterations, elapsedMinutes, owed?}`.

### Judging (exit 3)

```bash
node "$SCRIPT" threads --pr <n> --repo <owner/name> --cwd "<checkout>"          # every thread, OPEN first
node "$SCRIPT" adjudicate --pr <n> --repo <owner/name> --cwd "<checkout>" \
  --comment-id <id> --verdict confirmed|refuted|note --body-file reply-<id>.md
```

`adjudicate` replies through `pr-review.mjs reply --verdict` (so the T1
measurement row is written, attributed to that comment's lens) and then
**resolves the thread** — resolved is the state convergence reads, and this
verb is the only thing that sets it. A confirmed finding is fixed on the branch
and pushed; the loop sees the new head as the next iteration and claims a fresh
paired review for it. Verify against the code, not the claim — the reviewer had
the diff and one pass; you have the repo and the intent.

## Bounds (every one finite, every one named in the exit)

| Flag | Default | Meaning |
|---|---|---|
| `--max-heads` | 3 | iterations; a new head is one |
| `--max-wall-minutes` | 90 | across re-runs (the state file carries `startedAt`) |
| `--poll-seconds` | 60 | never faster |
| `--session-claims` | 1 | session claims per head (retry authority, spec D4); `0` = never retry an ended automatic attempt |
| `--claim` | `session` | `session`: claim the head yourself now; `beat`: wait for the automatic attempt (≈15–30 min per head) |
| `--fresh` | — | ignore the state file (a new run, new bounds) |

Plan/cost stop is the coordinator's own: a claim refused `paused` or
`disabled` is `blocked`, never a retry.

## Blocked reasons (closed set)

`reviewer-never-answered` · `attempt-failed` · `attempt-ended-no-retry` ·
`ci-failed` · `head-moved-limit` · `wall-time` · `plan-paused` · `disabled` ·
`delivery-unresolved` · `integrity-violation` · `unresolved-threads` ·
`coordinator-unreachable` · `not-managed`. Each carries an `owed` sentence.

## What it never does

- **Merge.** There is no merge path. `converged` is evidence for the receipt.
- **Allocate a second automatic attempt.** One session claim per head at most,
  none while the coordinator is paused or disabled, none over a live attempt.
- **Re-POST a review** whose delivery is unresolved, or post outside the
  writer's coordinated `post --attempt-ref`.
- **Resolve a thread without a verdict reply**, or count anyone else's reply as
  an adjudication.
- **Wait past a bound silently.**

## Related

- `slim-review` — the review this converges; its standalone loop for
  repositories that are not managed (this skill blocks `not-managed` there).
- `burn-down` — invokes this at a PR boundary before closing an item.
