---
name: review
description: "Review a target with adaptive multi-reviewer pipeline. Targets: GitHub PR, local branch (pre-PR), working tree, file/directory, plan/spec. Triggered by '/review', '/review <PR-URL>', '/review #<num>', '/review branch[:<name>]', '/review wt', '/review file <path>', '/review plan <path>', or 'review my branch / plan / changes'. Runs complexity-driven tiering, dynamic reviewer composition, convergence tracking, and optional persistence."
model: opus
---

# Adaptive Multi-Target Review

Review a target with complexity-driven depth and dynamic reviewer composition. Targets supported: GitHub PR, local branch (pre-PR), working tree (uncommitted), file or directory, plan/spec document.

**Argument forms:**
- `/review` -- auto-detect from current cwd state (defaults to branch mode if on a feature branch)
- `/review https://github.com/owner/repo/pull/123` -- PR mode
- `/review #123` -- PR mode by number (uses current repo)
- `/review branch` or `/review branch:<name>` -- local branch mode
- `/review wt` or `/review working-tree` -- working tree (uncommitted + untracked)
- `/review file <path>` -- file or directory
- `/review plan <path>` -- plan/spec markdown document

If the argument is missing AND auto-detection is ambiguous, ask the user which target to review before proceeding.

**Prompt templates:** Read from `references/prompt-templates.md` (relative to this skill)
**Archetype library:** Read from `references/reviewer-archetypes.md` (relative to this skill)

### Subagent Dispatch Rules

All subagents in this skill are dispatched using the **Agent tool** with `model: opus`. This applies to the cartographer, all focused reviewers, and the synthesizer -- no exceptions.

**Parallel dispatch:** To run multiple reviewers simultaneously, emit multiple Agent tool calls in a single response message. Example: if the cartographer selects 4 archetypes, make 4 Agent tool calls in one message, each with its own prompt.

**Sequential dispatch:** The cartographer (1 call) and synthesizer (1 call) run alone -- no parallelism needed.

### Iteration Tracking

Maintain a list `iteration_records` across the review. Before each iteration decision, count the accumulated records:

```
# Check iteration cap before proceeding
if iteration_records.length >= max_iterations:
    # Proceed to Phase 5 regardless of synthesizer recommendation
```

Do NOT rely on mental counting. Always verify against the accumulated data.

---

## Phase 1: Intake

### 1.1 Parse Input + Detect Entry Mode

Map the argument to one of: `pr`, `branch`, `wt`, `file`, `plan`. Capture `entry_mode`.

| Argument pattern | Entry mode |
|---|---|
| `https://github.com/.../pull/<num>` | `pr` |
| `#<num>` (PR number in current repo) | `pr` |
| `branch` or `branch:<name>` | `branch` |
| `wt` / `working-tree` / `working tree` | `wt` |
| `file <path>` | `file` |
| `plan <path>` | `plan` |
| (no args) | auto-detect (see below) |

**Auto-detection rules (no args):**
1. If cwd is in a git repo and HEAD is a non-default branch with commits ahead of `origin/<default>` -> default to `branch` mode, use the current branch.
2. If cwd is in a git repo with uncommitted changes (staged or unstaged) and no branch divergence -> ask "branch or working-tree?" (the user's intent isn't decidable from state alone).
3. If on default branch with no changes -> ask the user for the target.

**Per-mode capture:**
- `pr`: extract owner, repo, PR number from URL or current repo context via `gh pr view`.
- `branch`: capture `branch_name` (current or named) and `base_branch` (default `origin/main`; allow override).
- `wt`: capture cwd.
- `file`: capture absolute `target_path`.
- `plan`: capture absolute `target_path`.

### 1.2 Record Start Time

Capture `started_at` as ISO 8601 UTC. All subsequent phase timestamps use the same mechanism.

### 1.3 Fetch Target

Per entry mode, gather the review target data.

**Input validation:** Before constructing any shell command, validate user-supplied values:
- PR numbers must match `^\d+$` — reject anything else
- Branch names: pass after `--` separator to prevent flag injection (e.g., `git diff <base>...<branch> --`)
- File paths: resolve to absolute, verify they exist, reject paths containing shell metacharacters

**`pr`:**
```bash
gh pr view <number> --json title,author,baseRefName,headRefName,files,body,commits,additions,deletions
gh pr diff <number>
```
Capture metadata, file list, diff text.

**`branch`:**
```bash
git diff <base>...<branch> -- # three-dot, common-ancestor based; -- prevents flag injection
git log <base>...<branch> --oneline
```
Capture diff text, files changed, commit log.

**`wt`:**
```bash
git diff HEAD
git ls-files --others --exclude-standard
```
Capture diff text, modified files, untracked files.

**`file`:**
Read file content directly. For directories, recurse into subdirectories, respect `.gitignore`, exclude binary files, and cap at 50 files or 200KB total content (whichever is reached first). If the cap is hit, warn the user and suggest reviewing specific subdirectories.

**`plan`:**
Read the plan/spec markdown. Extract any project references or codebase hints.

**Error handling:**
- Empty diff (branch/wt): Surface "no changes" and stop.
- File not found: Surface the path error and stop.
- PR not found: Surface the error and stop.

### 1.4 Branch Isolation

**Only applicable for `pr` mode** (when reviewing someone else's branch from origin) and `branch` mode (when reviewing a branch other than the current checkout).

For `pr`:
```bash
# Use platform-appropriate temp directory
git worktree add "$(mktemp -d)/review-pr-<number>" <head-ref>
```
Store `review_codebase_path` and `worktree_created` in orchestrator state. All reviewer prompts with codebase access must use this path as their filesystem root.

For `branch` (when target != current): same worktree approach with branch name.

For `wt`, `file`, `plan`: `review_codebase_path` is the cwd (or for `file`, the parent dir of the target).

**If worktree creation fails:** Fall back to diff-only context for all reviewers. Warn: "Worktree creation failed -- reviewers will use diff-only context."

### 1.5 Fetch Spec/Issue Context

If a ticket/issue reference is detected (from branch name pattern, PR body, or explicit argument):
- Try `gh issue view <number>` for GitHub Issues
- Check for linked issue in PR metadata
- Extract acceptance criteria, description, labels

**If no issue context available:** Continue with degraded context. **Drop Spec Fidelity from the reviewer composition** (it has no AC to compare against). Plan mode replaces Spec Fidelity with Spec Specificity, which works without issue context.

### 1.6 Record Intake Completion

Capture `intake_completed_at`. Present mode-aware metadata to user:

**`pr` mode:**
```
## PR #<NUM> -- <TITLE>
**Repo:** <OWNER/REPO>
**Author:** <AUTHOR> | **Branch:** <HEAD> -> <BASE>
**Issue:** <ISSUE_REF or "(none)">
**Files changed:** <COUNT> | **Diff lines:** +<ADD> -<DEL>
```

**`branch` mode:**
```
## Branch Review: <BRANCH> -> <BASE>
**Repo:** <REPO_PATH>
**Issue (extracted):** <ISSUE_REF or "(none)">
**Files changed:** <COUNT> | **Diff lines:** <COUNT> | **Commits ahead:** <COUNT>
```

**`wt` mode:**
```
## Working Tree Review
**Repo:** <REPO_PATH>
**Branch:** <CURRENT_BRANCH>
**Modified files:** <COUNT> | **Untracked:** <COUNT> | **Diff lines:** <COUNT>
```

**`file` mode:**
```
## File/Directory Review: <TARGET_PATH>
**Kind:** <file | directory>
**Files:** <COUNT> | **Total lines:** <COUNT>
```

**`plan` mode:**
```
## Plan Review: <PLAN_PATH>
**Issue (referenced in plan):** <ISSUE_REF or "(none)">
**Plan size:** <WORDS> words | **Codebase hint:** <DIR or "(none)">
```

---

## Phase 2: Complexity Assessment

Score the target across 6 dimensions. For `plan` mode, "Diff lines" becomes "Plan word count," and "Schema + logic" reads as "spec covers schema + logic."

### Scoring Rubric

| Dimension | 0 | 1 | 2 | Source |
|-----------|---|---|---|--------|
| Scope | 1 file | 2-5 files | 6+ files | File count (or plan: features described) |
| Cross-project | 1 project | 2 projects | 3+ | Project paths in target |
| Change type | Config/text/style | Logic changes | Schema + logic | File extensions + content |
| Surface area | < 100 diff lines | 100-500 | 500+ | Diff line count (or plan word count: <500/500-2000/2000+) |
| Domain risk | Low-risk area | Auth/financial/data-loss | Multiple risk domains | Keywords in target |
| Spec clarity | AC clear & narrow | Moderate ambiguity | Vague/missing AC | Issue description analysis |

### Tier Mapping

| Score | Tier | Max Iterations | Context Depth |
|-------|------|----------------|---------------|
| 0-3 | 1 -- Diff/target review | 3 | Target + embedded conventions |
| 4-7 | 2 -- Contextual review | 5 | Target + full source files |
| 8-12 | 3 -- Deep review | 8 | Full codebase access |

### Presentation

```
### Complexity Assessment

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Scope | {n} | {reason} |
| ... | ... | ... |
| **Total** | **{N}/12** | |

**Tier {T}** -- {TIER_NAME} (max {MAX} iterations)

Override? ("bump to Tier 3" / "just Tier 1" / or continue)
```

Record `complexity_completed_at` timestamp. Wait for user response. Accept override or continue.

---

## Phase 3: Cartographer (Wave 1)

Read:
- `references/reviewer-archetypes.md`
- Project CLAUDE.md if available (for Tier 1 convention embedding)

Construct the cartographer prompt using the template from `references/prompt-templates.md`, substituting:
- Target metadata, issue context (if present), diff/target text, commit log (if present)
- `{ENTRY_MODE}` -- passed through so the cartographer knows the review type
- Archetype names and descriptions from `reviewer-archetypes.md`

Dispatch a single **Opus** subagent with the cartographer prompt.

The cartographer returns:
1. Change/target map
2. Intent alignment assessment (where applicable -- `plan` mode uses internal coherence instead)
3. Risk signals (see evidence rule below)
4. Reviewer composition (2-7 selected archetypes with justification)

**Mandatory floor (always-on, no exceptions):**
- **Security** -- runs every review regardless of diff signals. This is the always-on security pattern validated by multi-reviewer convergence research. If the cartographer omits Security, the orchestrator MUST add it back before dispatch.
- **Spec Fidelity** -- mandatory unless issue context is unavailable.
- **Plan mode:** `Spec Specificity` replaces `Spec Fidelity`. Security still runs.

**Floor enforcement:** Before dispatching focused reviewers in Phase 4.1, validate that Security is in `current_archetypes`. If absent, prepend it and log the correction.

**Observation evidence rule:** The cartographer sees only the diff/target -- it has no codebase access. Any risk signal or observation about orphaned types, dead code, or unused references MUST be tagged `[Needs codebase verification]`. The cartographer must NOT state orphan claims as facts.

Record `cartographer_completed_at` timestamp.

Present the cartographer's composition to the user:
```
### Cartographer Assessment
{CHANGE_MAP_SUMMARY}

**Reviewer composition:** {ARCHETYPE_LIST}
**Rationale:** {ONE_PARAGRAPH}

Proceeding with {N} reviewers, up to {MAX} iterations.
```

---

## Phase 4: Wave Loop

Initialize:
- `iteration = 1`
- `current_archetypes = cartographer's selection`
- `all_findings = []`
- `iteration_records = []`

### Loop Start

Record `iteration_started_at` timestamp.

**4.1a Assign Slicing Strategies**

Before dispatch, assign each archetype a diff-slicing strategy. Strategies: `raw_diff`, `function_context`, `full_flow`. See `references/slicing-strategies.md` for construction details.

Assignment is deterministic (same composition -> same assignment), index-ordered:

| Mode + tier | Assignment |
|---|---|
| `plan` (any tier) | all -> `raw_diff` (plan document fed verbatim) |
| `file` (any tier) | all -> `raw_diff` (full file content) |
| `pr` / `branch` / `wt`, Tier 1 | all -> `raw_diff` |
| `pr` / `branch` / `wt`, Tier 2 | alternate `raw_diff`, `function_context` by index |
| `pr` / `branch` / `wt`, Tier 3 | round-robin `raw_diff`, `function_context`, `full_flow` by index |

Record as `slicing_strategies` dict (archetype name -> strategy string).

**4.1 Dispatch Focused Reviewers**

For each archetype in `current_archetypes`, dispatch a parallel Agent tool call using the Focused Reviewer Prompt template. Make all Agent calls in a single response for parallel execution.

Substitute per archetype:
- `{ARCHETYPE_NAME}`, `{ARCHETYPE_FOCUS_DESCRIPTION}`, `{ARCHETYPE_LOOKS_FOR}` from archetypes doc
- `{ENTRY_MODE}`, `{TARGET_DESCRIPTOR}` for mode-aware language
- `{SLICING_STRATEGY}` -- strategy name + guidance from slicing-strategies.md
- `{CONTEXT_BLOCK}` -- strategy-aware, layered over tier. Each tier is a strict superset of the previous:
  - **Tier 1 (or plan/file):** Diff/target text + conventions embedded directly.
  - **Tier 2, raw_diff:** Diff text + conventions embedded directly (same as Tier 1 — conventions always included).
  - **Tier 2, function_context:** Diff + conventions + full body of changed functions + same-file callers.
  - **Tier 3, raw_diff:** Diff + conventions + codebase tool access at `review_codebase_path`.
  - **Tier 3, function_context:** Tier 2 function_context + codebase tool access.
  - **Tier 3, full_flow:** Diff + conventions + entire changed files + one-hop callees + codebase tool access.

**Branch isolation enforcement:** Every Tier 2/3 reviewer prompt MUST use `review_codebase_path` as filesystem root.

**Token budget guard:** Estimate token count as `total_characters / 4` (rough heuristic). If estimated prompt > 150,000 tokens, fall back to `raw_diff` strategy with Tier 1 context for that reviewer and note the limitation.

**4.2 Collect Results**

Gather all reviewer outputs. Each produces structured findings (severity, file, line, problem).

Record `iteration_completed_at` timestamp.

**4.3 Synthesis**

Dispatch synthesis subagent using the Synthesis Prompt template. Feed all reviewer outputs from this iteration plus accumulated findings. Include `{SLICING_STRATEGIES_MAP}` for convergence analysis.

The synthesizer returns:
- Deduplicated, ranked findings with convergence tags (`reviewer_count`, archetype names, strategies, cross-strategy flag)
- Wave-level convergence counts: convergent (>=2), cross-strategy convergent, singleton
- Convergence assessment: ITERATE or COMPLETE with rationale
- Composition adjustment recommendation (if iterating)

**4.4 Iteration Decision**

Append a record to `iteration_records` with:

| Field | Source |
|-------|--------|
| `iteration_number` | current counter |
| `started_at` | iteration start ISO 8601 UTC |
| `completed_at` | iteration end ISO 8601 UTC |
| `reviewer_archetypes` | archetype list for this wave |
| `blockers_found` | blocker count |
| `findings_count` | total findings |
| `synthesizer_recommendation` | ITERATE or COMPLETE |

Then decide:

```
1. Check cap: IF iteration_records.length >= max_iterations -> Phase 5
2. IF synthesizer says COMPLETE AND no unresolved convergent blockers/highs -> Phase 5
3. Otherwise: ITERATE
   - current_archetypes = adjusted composition (or same)
   - GOTO Loop Start
```

**The iteration cap is structural, not advisory.** Always check against accumulated records.

**Default behavior:** Most reviews should run a single wave. The iteration loop exists for cases where the synthesizer identifies unresolved blockers or high-severity convergent findings that warrant a second pass with adjusted composition. In practice, Wave 1 catches the high-value findings; iteration is the exception, not the norm.

---

## Phase 5: Output

### 5.1 Conversation Presentation

Capture `output_completed_at`. Compute durations.

```
## Review: {TARGET_DESCRIPTOR}

**Mode:** {ENTRY_MODE} | **Tier:** {T} ({TIER_NAME}) | **Iterations:** {N}/{MAX} | **Reviewers:** {ARCHETYPE_LIST}
**Duration:** {FORMATTED_DURATION}
**Convergence:** {convergent_count} convergent ({cross_strategy_count} cross-strategy), {singleton_count} singleton(s)

### Blockers
{BLOCKER_LIST or "None"}

### Findings
{HIGH_AND_MEDIUM_FINDINGS}

### Observations
{NON_ACTIONABLE_ITEMS}
```

**Convergence tagging:**
- `[converged: N/M]` when reviewer_count >= 2, single strategy
- `[cross-strategy: N/M]` when reviewer_count >= 2 AND cross_strategy = true (highest confidence)
- No tag for singletons

`TARGET_DESCRIPTOR` by mode:
- `pr`: `PR #<NUM> (<REPO>)`
- `branch`: `Branch <NAME> (<REPO>)`
- `wt`: `Working Tree (<REPO>, branch <BRANCH>)`
- `file`: `<TARGET_PATH>`
- `plan`: `Plan <PLAN_PATH>`

### 5.2 Opt-in Actions

- **"Go deeper?"** -- bump tier or add iterations beyond cap (all modes)
- **"Fresh eyes?"** -- dispatch Fresh Eyes reviewer (minimal context, no conventions, no prior findings)
- **"Post to PR?"** -- `pr` mode only. Format findings and post as PR comment via `gh pr comment`.

### 5.3 Cleanup

If a worktree was created, remove it:
```bash
git worktree remove /tmp/review-pr-<number> --force
```

---

## Error Handling

- **gh CLI failure (pr mode):** Surface the error. Check `gh auth status`.
- **Issue fetch failure:** Report error, continue without issue context. Drop Spec Fidelity.
- **Subagent failure:** Retry once. If retry fails, report which reviewer failed, continue with remaining. Update synthesis prompt to reflect actual count.
- **Worktree creation failure (Phase 1.4):** Fall back to Tier 1 context. Warn user.
- **Empty diff (branch/wt):** Surface "no changes" and stop.
- **File/Plan not found:** Surface path error and stop.
