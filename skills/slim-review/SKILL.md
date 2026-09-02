---
name: slim-review
description: "Run the slim PR-review loop — delegate one external reviewer (Codex/Terra) at a PR boundary, post its findings as line-anchored GitHub review comments, then confirm or refute each one and reply on the thread. Trigger on '/slim-review', 'slim review', 'review this PR before merge', 'get a second pass on the PR', or at any PR boundary during a burn-down. This is the LIGHT tier: one external lens, posted to the PR. Use '/review' for the in-session multi-reviewer pipeline and the review-council for complex multi-component PRs."
---

# Slim PR Review — one external lens, on the PR, adjudicated

A PR-boundary review that is cheap enough to run **every time**. One external
reviewer looks at the diff, its findings land on the pull request as real review
comments, and you then confirm or refute each one in public and reply on the
thread.

The value is not the model. It is that the finding, the verdict, and the fix all
end up attached to the line they are about, where review and merge already happen.

## Which tier

| Reach for | When | Cost |
|---|---|---|
| **this skill** | Every code-diff PR boundary. Single-surface changes, burn-down items, anything you were about to merge on your own say-so. (Burn-down's T0 — docs/config/mechanical with a green build — is the one named exception) | $0 plan-covered, one spawn, ~2–5 min |
| `/review` | You want several perspectives in-session and a convergence read before opening a PR | in-session Opus subagents |
| `council_review` (review-council MCP) | Complex multi-component PRs and spec surfaces — fan-out, synthesis, adversarial challenge | 4–6 lenses |

Reaching for the heavy instrument and therefore skipping review entirely is the
failure this tier exists to prevent.

## The loop

```
1. target   →  2. elicit  →  3. post   →  4. adjudicate
   PR + diff    codex exec    the script   confirm / refute / fix / reply
```

Steps 2 and 3 are mechanical — run them as written. Step 4 is the part that
needs you.

---

## 1. Target

```bash
gh pr view <n> --repo <owner/name> --json title,headRefName,baseRefName,files,additions,deletions
```

Work from a checkout of the PR's head — the repo root, or the worktree the branch
is checked out in. Note the absolute path; step 2 grounds the reviewer there.

Set a scratch directory for this run (never write these into the repo):

```bash
REVIEW_DIR="<scratchpad>/slim-review-pr<n>"
mkdir -p "$REVIEW_DIR"
```

## 2. Elicit

Run the lens verb. It builds the grounded prompt itself from the authoritative
PR file list, requires the reviewer to read `gh pr diff <n> --repo <owner/name>`,
and rejects prose or incomplete handbacks.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" lens \
  --pr <n> --repo <owner/name> --lens codex \
  --cwd "<ABSOLUTE REPO OR WORKTREE PATH>" \
  --out "$REVIEW_DIR/findings.json"
```

### Reviewer ≠ author

A PR authored by a codex lane takes `--lens opus`; a PR authored by a Claude
session takes `--lens codex`. Read the author from the PR's commits or the lane
record; never assume.

Handback contract: `summary`, `coverage`, `examined_paths`, and `findings`.
`examined_paths` must be EXACTLY the authoritative list. Context-only paths are
extras and fail the check. It must also be **non-empty**, and `coverage` must
literally state `examined N of M` — a handback admitting nothing, or one whose
coverage is prose, is exit 3, not a clean review.

The instrument bullet is this skill's negative-control binding
(`reference/patterns/negative-control.md`): an added test, guard, or checker
that cannot fail on the defect it claims to catch is a reportable correctness
defect.

Non-negotiable flags, each for a measured reason:

- **`--model gpt-5.6-terra` at high effort.** A review is a verdict about
  correctness, and Luna returns confident wrong PASSes on those. See
  `codex-delegate`'s Terra-vs-Luna threshold.
- **`--sandbox danger-full-access`.** `--sandbox read-only` is broken on this
  Windows box — the sandbox runner dies at the first child spawn and the model
  returns a plausible **ungrounded** answer with no surfaced error. The read-only
  clause in the prompt is what keeps it honest, and Terra honors it; verify with
  `git status --short` afterwards.
- **`--output-schema` + `-o`.** Forces the handback into a shape step 3 can check
  instead of a prose blob you have to trust. Do not substitute `codex exec
  review`: it takes no sandbox flag, so it hits the read-only bug on this box,
  and its output is unstructured prose.

The verb checks `git -C "<ABSOLUTE REPO OR WORKTREE PATH>" status --short`
before and after the reviewer and fails if a clean worktree becomes dirty.

### Shadow arm (measurement, opt-in)

On a PR the conductor names, run **both** lenses, post both, and adjudicate both
with `reply --verdict`. The measurement log then captures unique-to-lens
confirmed catches. Post the two handbacks with repeated flags, for example
`post --findings codex.json --findings opus.json`. Two lenses is the ceiling.

## 3. Post

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" post \
  --pr <n> --repo <owner/name> --findings "$REVIEW_DIR/findings.json" [--dry-run] [--force-post]
```

The script does the checking you would otherwise have to remember:

- **Blocking coverage set check** — compares normalized `examined_paths` against
  the PR API's authoritative file list. Missing or extra paths exit nonzero before
  posting; `--force-post` is the explicit escape hatch and stamps the mismatch in
  the review body. A parseable `examined N of M` contradiction also fails; an
  absent or unparsable count remains secondary evidence. This detects stale or
  missing path sets; it does not prove that examination happened.
- **Anchorability** — a finding whose line is in the diff becomes a real
  line-anchored comment; one whose line is not becomes a body entry. A finding on
  a file with no commentable line splits into two buckets with different wording,
  because they mean different things: **changed by this PR but not
  line-anchorable** (deleted, binary, or pure rename — the diff has no
  post-change side to comment on) versus **not a file this PR changes**. Only the
  second is where invented locators surface; publishing the second's wording over
  the first tells the reader something false about a real defect.
- **Diff-vs-file-list warning** — if the diff's `diff --git` header count differs
  from the PR API's file count, the footer says so. Non-blocking; it means the
  two sources disagree about what the PR changes.
- **No shell re-parsing** — the payload is built in Node and handed to
  `gh api --input -`, so backticks and quotes in the review text land verbatim.

Read the receipt line before moving on. `anchored · off-line · off-diff` plus the
coverage verdict is the whole quality signal.

Exit codes matter here:

| Code | Meaning |
|---|---|
| 0 | Posted. **A zero-finding review is a real result** — it posts, and that is the receipt that review happened |
| 3 | The handback never arrived: file missing, unparseable, or wrong shape — including an **empty `examined_paths`** or a `coverage` string that does not state `examined N of M`. **This is not a clean review.** Re-run step 2 |
| 4 | A `gh` call failed |
| 5 | A coverage check failed. Three triggers: the `examined_paths` set does not match the PR API's file list; a parseable `examined N of M` contradicts that list; or the PR API returned **no** changed files at all |

`--force-post` overrides the first two — the set mismatch and the count
contradiction — and posts the review with the mismatch stamped into the body. It
does **not** override the empty-file-list floor: an empty authoritative list is a
fetch failure, and there is nothing to check coverage against, so that exit 5 is
unconditional and posts nothing no matter what flags you pass.

The review posts as `COMMENT`, which is the only event GitHub permits on your own
pull request.

## 4. Adjudicate

This is the half that caught real defects three times out of three when it was
run by hand, and it is the half no script can do.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" threads --pr <n> --repo <owner/name> --unresolved
```

`--repo` is required here, not optional. Resolved from cwd, `--pr <n>` silently
answers about a *different* repository's PR of the same number — and the answer
it prints, "no unresolved review threads", is the merge-ready signal.

This lists every unresolved review thread on the PR, not only the ones this loop
just posted — a human's or a bot's open comment deserves the same verdict, and a
PR whose threads are all answered is the actual merge-ready condition. If you
need to tell them apart, `post` printed the URL of the review it created.

**Bounded, and it says so.** The query asks for 100 threads and 50 comments per
thread and does not paginate. If either page comes back full, the command exits
**6** with a truncation warning and prints no listing at all — because "no
unresolved review threads" read off a truncated page is a false merge-ready
signal, which is the one thing this skill exists to prevent. Adjudicate from the
PR page in that case. Full `pageInfo` pagination is a known follow-up, not
implemented here.

For **each** thread, in order:

1. **Verify against the code, not the claim.** Open the cited file and the paths
   it depends on. The reviewer had the diff and one pass; you have the repo and
   the intent. Treat its finding as a hypothesis.
2. **Reach a verdict, and say which.** Confirmed, refuted, or out of scope. A
   finding you neither fix nor refute is the one failure mode of this loop.
3. **Fix confirmed findings on the branch**, then push.
4. **Reply on the thread** with the verdict and its evidence — the commit sha for
   a fix, the reason for a refusal:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" reply \
  --pr <n> --repo <owner/name> --comment-id <id> --body-file "$REVIEW_DIR/reply-<id>.md" \
  --verdict confirmed|refuted|note
```

Write the reply to a file and pass `--body-file`; reply bodies quote code and
would not survive being typed into a shell.

**A refutation is worth as much as a fix and costs more to skip.** Say what the
reviewer missed — the guard it did not read, the caller that makes the state
unreachable, the invariant that already holds. Three of the wrong findings this
loop has produced were reachability claims about code the reviewer never opened;
the reply is where that gets recorded rather than re-litigated next time.

When every thread has a verdict and CI is green, the PR is ready for the
operator's merge call.

---

## What this deliberately is not

- **Not a council.** One lens, no synthesis, no challenge pass. If lenses would
  disagree in an interesting way, that PR wants `council_review`, not this.
- **Not a merge gate.** It posts findings and adjudications; merging stays the
  operator's call.
- **Not a linter.** Style findings are explicitly excluded — CI already owns
  those, and a review that lists them trains you to skim.

## Anti-patterns

- Running step 2 and reading the JSON yourself instead of posting it. The PR is
  the point; a finding that lives only in a session transcript dies with it.
- Treating exit 3 as "clean". It means the reviewer did not run.
- Fixing findings without replying. The thread is the record of *why* the code
  looks the way it does now.
- Reaching for `--model gpt-5.6-luna` because it is faster. It is faster at
  enumeration, and wrong at verdicts.
- Letting this grow lenses. The moment it has three, it is a second council and
  it stops getting run.

<supporting_info>

*Origin: quest `741a1ff7` (Agentic Practice & Transfer), from the operator's
run-2 observation that the manual codex-GUI → PR-comment → CLI-read-back loop
"caught real defects every time it ran" — 3 for 3 on tiered-queue run 2, items
10, 11 and 15 — and wanted it lighter and automated rather than replaced by the
council.*

*Two design questions the quest left open, and how they were settled: (1) the
automation is a skill, not a council profile — `council_review`'s surface is
workshop-shaped (`workshop_path`/`surface`/`round`, lens files) with no PR
awareness and no GitHub write path, so a "slim profile" would have meant building
one inside Observatory, which is the council-rebuild the quest forbids. (2) Codex
does **not** post the comments; it returns a schema-forced handback and the script
posts. That removes the "can an unattended agent be trusted with `gh` writes"
question rather than answering it, and it is what makes the coverage and
anchoring checks possible at all — they run on the findings before anything
reaches GitHub.*

*Mechanism verified 2026-08-07: `codex exec --output-schema` + `-o` returned exact
conforming JSON on a real Observatory commit, and `git status --short` confirmed
the read-only clause held. `codex exec review` was tested and rejected — it
exposes no `--sandbox` flag, so it hit `CreateProcessAsUserW failed: 5` on this
box (auto-memory `codex-exec-readonly-sandbox-broken-windows`) and returned prose.*

*UNVERIFIED against that date, and the date must not be refreshed until it is:
`findings.schema.json` has since gained `minLength: 1` and `uniqueItems: true` on
`examined_paths`. Both appear on OpenAI Structured Outputs' unsupported-keyword
list for strict mode, and the live `codex exec --output-schema` probe was blocked
by a usage limit. Re-run one real `codex exec --output-schema` against the current
schema before touching the line above. Do **not** drop the keywords pre-emptively:
`validateFindingsShape` enforces non-empty strings and uniqueness unconditionally
at runtime, so a schema codex rejects degrades to a loud exit 3, never to a false
clean — and if a live probe does show rejection, the keywords can simply be
removed with no loss of enforcement.*

</supporting_info>
