---
name: slim-review
description: "Run the slim PR-review loop — two external reviewers (Terra and Astra, plan-covered) at a PR boundary, findings posted as line-anchored GitHub review comments, then confirm or refute each and reply. Trigger on '/slim-review', 'slim review', 'review this PR before merge', or at any PR boundary in a burn-down. The LIGHT tier: two lenses, no synthesis. NOT for converging a reviewed PR (babysit), in-session multi-reviewer passes ('/review'), or complex PRs (review-council)."
---

# Slim PR Review — two external lenses, on the PR, adjudicated

A PR-boundary review that is cheap enough to run **every time**. Two external
reviewers (Terra and Astra, one invocation each) look at the diff, their findings land on the pull request as real review
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
   PR + diff    lens verb     the script   confirm / refute / fix / reply
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
  --pr <n> --repo <owner/name> --lens codex|astra|opus \
  --cwd "<ABSOLUTE REPO OR WORKTREE PATH>" \
  --out "$REVIEW_DIR/findings.json" \
  [--reasoning low|medium|high] [--measure-log <path>] [--dry-run]
```

**The loop runs two lenses and posts both** (operator ruling 2026-09-09, quest
`bcc11983`): invoke the verb once per lens with a distinct `--out`, then hand
both files to `post`. `--lens` is `codex` (Terra @ high), `astra` (GPT-6 Astra @
low), or `opus`; `--reasoning` overrides the per-lens default; `--measure-log`
overrides the per-lens JSONL destination; `--dry-run` prints the resolved argv
and prompt path without running a reviewer. Use `--prompt-out <path>` when you
need to retain that exact grounded prompt for inspection.

Why two: on observatory#620 (2026-09-09, paired on a byte-identical prompt)
Terra@high and Astra@low each found a real defect the other missed, neither
produced a false finding, and Astra was better calibrated on severity — Terra
graded a deliberate two-fetch startup window as P1 — at half the input, 6× less
output and a third of the wall clock. Both arms together did not move the plan
meter one integer point (`astra-diff-review-measurement.md`). Two lenses is the
ceiling; three is a council.

### Reviewer ≠ author

The pair is chosen so neither lens is the PR's authoring model: a PR authored by
a Claude session takes `codex` + `astra`; a PR authored by a Terra lane takes
`astra` + `opus`; a PR authored by an Astra lane takes `codex` + `opus`. Read
the author from the PR's commits or the lane record; never assume.

Handback contract: `summary`, `coverage`, `examined_paths`, and `findings`.
`examined_paths` must be EXACTLY the authoritative list. Context-only paths are
extras and fail the check. It must also be **non-empty**, and `coverage` must
literally state `examined N of M` — a handback admitting nothing, or one whose
coverage is prose, is exit 3, not a clean review.

### Consumer-visible artifact evidence

When a changed file affects prompt/template generation, configuration resolution,
or dispatch selection, name one concrete claim, its consumer, and the path that
produces the consumer input. Inspect the real rendered or resolved result with an
existing safe renderer/resolver, or use a capture from that same path. In
`summary`, record the claim, command or supplied-evidence provenance, decisive
excerpt, and any unverified limitation. Do not create worktrees, write source or
configuration, install packages, run git writes, start services, or dispatch real
actions to obtain evidence; use in-memory inputs and read-only paths. If that is
impossible, state the limitation and ask the conductor for a render capture. A
tool-less reviewer may assess supplied render evidence but must never claim to
have run the renderer. Do not report a defect finding solely because a check was
skipped; record the skip as a stated limitation, as Workspace Integrity requires.
A match found inside quoted source or inlined artifacts does not prove delivery:
where a slot or insertion is claimed, pass a distinct sentinel through the slot
and a different marker through the artifacts, and confirm the sentinel lands
outside the artifacts section.

The instrument bullet is this skill's negative-control binding
(`reference/patterns/negative-control.md`): an added test, guard, or checker
that cannot fail on the defect it claims to catch is a reportable correctness
defect.

Non-negotiable flags, each for a measured reason:

- **Codex `--model gpt-5.6-terra` at high effort.** A review is a verdict about
  correctness, and Luna returns confident wrong PASSes on those. See
  `codex-delegate`'s Terra-vs-Luna threshold.
- **Astra `--model gpt-6-astra` at low effort.** Low is the CLI's own default
  and lost nothing but a path prefix on the measured arms; the prompt now
  carries the one-line repo-relative-paths instruction that fixed that. Pin
  `--reasoning high` only when a low handback shows a coverage or locator gap.
- **`--sandbox danger-full-access`.** `--sandbox read-only` is broken on this
  Windows box — the sandbox runner dies at the first child spawn and the model
  returns a plausible **ungrounded** answer with no surfaced error. The read-only
  clause in the prompt is the only thing asking it to behave, and it is a
  request, not a sandbox: on 2026-09-09 a Terra council seat under the same
  clause created and recursively deleted git worktrees whose `node_modules`
  were junctioned to the live checkout (quest a0180149). The lens verb's
  before/after `git status --short --porcelain` check catches writes inside
  the reviewed tree; it cannot see a worktree created beside it, so read the
  handback for "worktree", "cleaned", or "removed" and count the canonical
  `node_modules` when they appear.
- **`--output-schema` + `-o`.** Forces the handback into a shape step 3 can check
  instead of a prose blob you have to trust. Do not substitute `codex exec
  review`: it takes no sandbox flag, so it hits the read-only bug on this box,
  and its output is unstructured prose.

The verb captures `git -C "<ABSOLUTE REPO OR WORKTREE PATH>" status --short
--porcelain` before and after the reviewer and fails on every status line added
by the reviewer, even when the worktree was already dirty before it ran.

### The pair is the measurement

Every run is the shadow arm now: two lenses, both posted, both adjudicated with
`reply --verdict`, so the measurement log accumulates unique-to-lens confirmed
catches on every PR instead of on the ones someone remembered to name. Post the
two handbacks with repeated flags: `post --findings codex.json --findings
astra.json`. Where both lenses anchor the same defect on the same line, post
both — the duplicate is the agreement signal — and **reply to each comment**
with its own `--verdict`: `reply` posts to one comment id and records one
measurement row attributed to that comment's lens, so a single reply would
leave the other lens without an adjudication and lose its confirmed/refuted
row (Astra's own review of this change caught that, workit#76). The two
replies may reuse the same evidence.

## 3. Post

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" post \
  --pr <n> --repo <owner/name> \
  --findings "$REVIEW_DIR/codex.json" --findings "$REVIEW_DIR/astra.json" \
  [--dry-run] [--force-post] [--single-lens "<reason>"]
```

The review is pinned to the reviewed head and refuses to post if the head moved.

**Two lenses is enforced, not described.** A post carrying fewer than two lens
tags is exit 7 and nothing is posted; the pair is the loop, and a one-lens
review published as a clean slim review is the failure Terra's own review of
this change caught (workit#76). When one lens genuinely cannot run — its plan
window closed, the harness is down — pass `--single-lens "<reason>"`: the
review posts with the reason stamped in the body as **not a paired
measurement**, so the measurement log never counts it as one.

The script does the checking you would otherwise have to remember:

- **Blocking per-handback coverage check** — compares each findings document's
  normalized `examined_paths` against the PR API's authoritative file list.
  Missing or extra paths exit nonzero before posting; `--force-post` is the
  explicit escape hatch and stamps the mismatch in the review body. A parseable
  `examined N of M` contradiction also fails; an absent or unparsable count
  remains secondary evidence. This detects stale or missing path sets; it does
  not prove that examination happened.
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
| 6 | The PR head moved between the diff fetch and the post. The findings were anchored on the old head, so nothing was posted — re-run step 2 against the new head. Not a transient `gh` failure (that is 4) |
| 7 | Fewer than two lens tags across the `--findings` files and no `--single-lens` reason. Nothing was posted — run the missing lens, or state why it could not run |

`--force-post` overrides the first two exit-5 triggers — the set mismatch and
the count contradiction — and posts the review with the mismatch stamped into
the body. It does **not** override the empty-file-list floor: an empty
authoritative list is a fetch failure, and there is nothing to check coverage
against, so that exit 5 is
unconditional and posts nothing no matter what flags you pass. It does **not**
override exit 6 either: a moved head is stale findings, not a coverage question,
and no flag posts them.

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

## Managed repositories

Coordinated `lens --attempt-ref` executions create a temporary detached
worktree at the attempt's pinned head, fetched from its declared GitHub repo.
The caller's `--cwd` is used for command context and measurement placement,
not for the model's source reads or integrity checks. Each lens execution gets
its own repository and checkout; edits in the interactive checkout cannot
invalidate it. The writer checks HEAD before and after the review and still
rejects reviewer edits. It removes the temporary checkout after success or
failure, retaining findings outside it. A killed process can leave a temporary
`workit-review-*` directory behind.

These are source-only checkouts: no dependencies are installed or linked from
the live workspace. Reviewers must report checks that need unavailable
dependencies as unverified, as required by the artifact-evidence contract.
Setup/fetch failure reports `lens-error` to the coordinator and runs no model.
Dry runs create no checkout. Standalone lenses retain their explicit-cwd behavior.

Everything above is the standalone loop: you run it, it posts, nothing else is
involved. On an installation where reviews are also raised automatically, a
repository can instead be **managed** — the review is allocated by a coordinator
so two runs cannot post twice on the same commit. Which one applies is resolved
from one directory, and from nothing else:

```
%USERPROFILE%/.workit/pr-review/coordinator-token   the coordinator token
%USERPROFILE%/.workit/pr-review/managed.json        { "coordinator": "http://127.0.0.1:3100",
                                                      "repos": ["owner/name"] }
```

The environment variable `PR_REVIEW_COORDINATOR_TOKEN` overrides the token file;
an absent or empty file is no token at all. The four answers:

| Token | List | Answer |
|---|---|---|
| absent | either | **standalone** everywhere — the loop above, unchanged |
| present | absent or unreadable | **managed-config-missing** — the writer refuses rather than guess |
| present | repository listed | **managed** — the coordinated path |
| present | repository not listed | **standalone** |

The directory is under the user profile on purpose. Resolving it from the
repository or a workspace root would answer differently from a second clone or a
worktree of the same repository, and the mistake it would make is the expensive
one: posting a second review nobody coordinated. Ask what an installation
resolves — read-only, and safe to run anywhere:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" managed --repo <owner/name>
```

It prints one JSON line — `{outcome, retry, mode, repo, directory, coordinator?,
repos?}` — with any diagnostic on stderr, and never the token. Run it from two
different directories and the answer must be identical; if it is not, the
resolution is coming from somewhere it should not.

**Pinning the posting identity.** A managed installation records the login its
reviews are posted under, so a review that appears under any other login is
visible as one. The operator pins it once, from the same environment the
automatic half runs in:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" identity --pin --reason "<why>"
```

That reads the login from `gh api user` with the credential it is going to post
with and records it at the coordinator with the actor and the reason. Neither
subcommand takes `--pr`: one is about an installation, the other about a login.
Both print exactly one JSON line on stdout, exit 0 when the outcome is `ok` and
non-zero when it is `refused` — the JSON line is the contract, the exit integer
is for you.

Posting on a managed repository needs the service credential, and the
coordinator is reachable on loopback only: a session on another host resolves
`coordinator-unreachable` and posts nothing. Nothing retries itself. Every
refusal above is final for that invocation — the retry, when there should be
one, is a person's decision.

### The coordinated loop

On a managed repository, steps 2 and 3 change shape. The review is allocated
first, and every later step is fenced against the revision that was allocated:

```
claim  →  lens --attempt-ref (once per lens)  →  post --attempt-ref
```

```bash
# 1. allocate. Prints the attempt-ref file's path; that file holds the key for
#    every later call, so it is written owner-only and never leaves this host.
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" claim --pr <n> --repo <owner/name>

# 2. one invocation per required lens, against the diff pinned at claim time
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" lens --attempt-ref <file> --lens codex
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" lens --attempt-ref <file> --lens astra

# 3. post both documents, checked against the pinned manifest
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" post --attempt-ref <file>
```

`claim` reads the head, the file list, and the head again, and refuses
`revision-mismatch` if they disagree — a file list that belongs to no single
revision is not something to review. That list is the manifest, and it is what
both lenses and the post are checked against afterwards, instead of three
separate live listings that can disagree with each other.

The coordinated `lens` inlines the pinned patches into the prompt and removes
the instruction to fetch a diff, so the reviewer reads exactly the change that
was allocated. `--dry-run --prompt-out <path>` writes that rendered prompt
without spending a lens start. Surrounding source still comes from `--cwd`, and
the prompt says so.

`post --attempt-ref` re-reads the posting identity and the head, checks that
both documents carry the same four stamps as the attempt, that their lens set is
the set the attempt requires, and that each one covers the pinned manifest —
then sends the review from its own process and records the outcome. Any
disagreement is a refusal before anything is sent, and the attempt is withdrawn
in the same invocation rather than left to expire.

Every one of these commands prints one JSON line — `{outcome, reason?, retry,
…}` — with diagnostics on stderr. `retry` has three values: `stop`,
`lens-budget` (that lens may be invoked again — by whoever is driving, never by
the writer itself), and `post-budget` (the submission provably never left this
process).

### Adjudicating a review that already exists

Before it claims, `claim` looks for a review already posted under the pinned
login on this head — with the marker the coordinated loop writes, or, for a
legacy or hand-posted review, by its `commit_id`. A hit is recorded at the
coordinator and the claim is refused: the head has been reviewed, and reviewing
it again is a decision, not a default.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" recognise --pr <n> --repo <owner/name> --head <sha>
```

Read-only. It prints every review on the pull request that the recognisers
match, with the id, the author, and the marker if there is one. To review the
head anyway, supersede the review you read there:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" claim --pr <n> --repo <owner/name> \
  --supersede <review id> --reason "<why the first review is not the answer>"
```

The superseded review stays on the pull request and is marked replaced; the new
one names it. Adjudicating the review that is already there is usually cheaper
than paying for a second one.

### When an attempt ends without posting

An attempt that fails — an exhausted lens budget, a refused guard, an expired
lease, a paused reserve — is an **ended** attempt. Nothing re-runs it on its
own: the head stays visible as needing attention until either the head moves or
a person claims it again. That explicit `claim` is the retry, and it is the only
one. If the ended attempt is still holding the head, retire it first:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" recover abandon \
  --attempt-ref <file> --reason "<why>"          # an expired lease
node "${CLAUDE_SKILL_DIR}/scripts/pr-review.mjs" recover not-delivered \
  --attempt-ref <file> --reason "<why>"          # a submission with no known outcome
```

`recover not-delivered` reads the review listing itself before it asks for
anything: if the review is on the pull request after all, it records the
delivery instead of releasing the head. A head released while a review is
landing is how a pull request gets two of them.

`manifest --pr <n> --repo <owner/name>` prints the same pinned file list as a
JSON line without allocating anything. It exists so the scheduled half and this
skill build the manifest with one implementation rather than two.

---

## What this deliberately is not

- **Not a council.** Two lenses, no synthesis, no challenge pass. If the two
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
