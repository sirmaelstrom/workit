# Prompt Templates for review Skill

Templates used by the review skill to construct prompts for each phase.
The skill reads this file and substitutes variables at execution time.

Mode-aware variables (substituted by orchestrator from `entry_mode`):
- `{TARGET_DESCRIPTOR}` -- human-friendly target (e.g. "PR #123", "Branch feature-x", "Plan plan.md")
- `{TARGET_NOUN}` -- short noun: "pull request" / "branch" / "working tree" / "file/directory" / "plan"
- `{TARGET_VERB}` -- review verb: "diff" for code modes, "plan" for plan mode

Per-reviewer slicing variables (Focused Reviewer Prompt only; assigned in SKILL.md Phase 4.1a):
- `{SLICING_STRATEGY}` -- strategy name (`raw_diff`, `function_context`, or `full_flow`) plus strategy-specific guidance from `references/slicing-strategies.md`.
- `{CONTEXT_BLOCK}` -- strategy-aware. The orchestrator constructs a different context block per reviewer based on assigned strategy and tier; see SKILL.md Phase 4.1 for the construction matrix.

Synthesis variables (Synthesis Prompt only):
- `{SLICING_STRATEGIES_MAP}` -- JSON-encoded map of archetype name -> strategy used in this wave (e.g. `{"Security": "raw_diff", "Code Quality": "function_context"}`). Used to correlate findings to strategies and detect cross-strategy convergence. Total reviewer count `M` is `len(SLICING_STRATEGIES_MAP)`.

## Cartographer Prompt

```
You are mapping a review target to determine what kind of focused reviews are needed.

## Target Context
- **Mode:** {ENTRY_MODE}
- **Target:** {TARGET_DESCRIPTOR}
- **Source:** {TARGET_SOURCE}

{PR_BLOCK_OR_BRANCH_BLOCK_OR_WT_BLOCK_OR_FILE_BLOCK_OR_PLAN_BLOCK}

### Issue/Spec Context (if available)
- **Ref:** {ISSUE_REF}
- **Summary:** {ISSUE_SUMMARY}
- **Acceptance Criteria:**
{ISSUE_DESCRIPTION}

### Commits (pr/branch modes)
{COMMIT_LOG}

### {TARGET_VERB_TITLECASE}
{DIFF_OR_PLAN_OR_CONTENT}

## Your Task

Analyze this {TARGET_NOUN} and produce a structured assessment:

### 1. Change/Target Map
List each changed file (or each section, for plan mode) with a one-line description of what's there and what pattern/concept is in play.

### 2. Intent Alignment
- For code modes: does this {TARGET_VERB} address what the issue/spec describes? Note any gaps or contradictions. Multiple PRs may address one issue -- only flag active contradictions.
- For plan mode: does the plan internally cohere? Are AC, decisions, and decomposition consistent with the stated goal?

### 3. Risk Signals
Flag anything that stands out: auth changes, schema migrations, data deletion, cross-project dependencies, performance-sensitive paths, large surface area for the feature scope.

**CRITICAL -- evidence rule for orphan/dead-code signals:** You only see the {TARGET_VERB}, not the full codebase. If you suspect a type, interface, or class has lost its only consumer, you MUST tag the signal as `[Needs codebase verification]`. Do NOT state that something "is now dead code" or "has no remaining consumers" -- you cannot know this from the {TARGET_VERB} alone.

### 4. Reviewer Composition
Select 2-7 reviewer archetypes from the menu below. Justify each selection in one sentence. Use the "Composition Guidance" section in reviewer-archetypes.md as your decision framework -- match diff signals to archetypes' "Deploy when" rules.

**Mandatory floor (always include -- non-negotiable):**
- **Security** -- runs every review regardless of diff signals. Even on diffs with no security surface (pure CSS, config-only), Security runs and may legitimately return "No issues found." Do NOT drop Security to free a slot for narrow archetypes.
- **Spec Fidelity** -- mandatory unless issue context is unavailable.

For plan mode: **Spec Specificity** replaces Spec Fidelity. Security still runs.

If your composition does not include Security, the orchestrator will add it back.

Available archetypes:
{ARCHETYPE_NAMES_AND_DESCRIPTIONS}

Your response format:
- **Selected archetypes:** [list with one-sentence justification each]
- **Rationale:** [one paragraph explaining the overall composition choice]
```

## Focused Reviewer Prompt

```
You are reviewing a {TARGET_NOUN} as a **{ARCHETYPE_NAME}** reviewer.

## Your Focus
{ARCHETYPE_FOCUS_DESCRIPTION}

## What You Look For
{ARCHETYPE_LOOKS_FOR}

## Slicing Strategy
{SLICING_STRATEGY}

## Target Context
- **Mode:** {ENTRY_MODE}
- **Target:** {TARGET_DESCRIPTOR}
- **Issue:** {ISSUE_REF} -- {ISSUE_SUMMARY} (if available)
- **Acceptance Criteria:**
{ISSUE_DESCRIPTION}

{CONTEXT_BLOCK}

## Rules
- ONLY flag issues you are confident are real problems.
- Severity levels: **blocker** (must fix before merge/execution), **high** (should fix), **medium** (worth discussing).
- Do NOT pad with praise, style opinions, or "consider doing X."
- If you cannot state the problem in two sentences, you are not confident enough. Drop it.
- If a finding depends on code/context you cannot see, add a "Needs verification" note.
- **Strategy-aware verification framing:** Your slicing strategy bounds what you can see. Do NOT compensate by speculating beyond it.
  - `raw_diff` reviewers see only hunks. Findings that hinge on surrounding function bodies or callers must be tagged `[Needs codebase verification -- raw_diff strategy, did not see surrounding context]`.
  - `function_context` reviewers see each changed function in full plus same-file callers, but no cross-file callers. Findings that hinge on cross-file usage must be tagged `[Needs codebase verification -- function_context strategy, did not see cross-file callers]`.
  - `full_flow` reviewers see changed files plus one-hop callees. Findings that hinge on two-hop transitive flow must be tagged `[Needs codebase verification -- full_flow strategy, did not expand beyond one hop]`. Use codebase tools for verification rather than speculation.
- **Evidence rule for orphan/dead-code claims:** Every claim that a type, class, or interface is "orphaned", "dead", or "has no remaining consumers" MUST be backed by a grep search of the codebase (where one is available). Cite the grep command and its result count. If you did not grep, do not make the claim.
- For plan mode (Spec Specificity reviewer): apply the Two-Agent Test and the Independent Observer Test. A plan that fails either test is under-specified -- surface specifically which decisions are unresolved or which AC items lack verification methods.
- Silence means approval.

## Output Format

For each finding:
- **{severity}** | `{file_path or section}` near line {line}
  - {The specific problem, citing code or plan text}
  - {Needs verification: what you'd need to check} (if applicable)

If no issues found, respond: "No issues found."
```

## Synthesis Prompt

```
You are synthesizing findings from {REVIEWER_COUNT} focused reviewers of {TARGET_DESCRIPTOR}.

## Reviewer Findings

{ALL_REVIEWER_OUTPUTS}

## Slicing Strategies Used This Wave

Each reviewer was assigned one diff-slicing strategy. Use this map to correlate findings to strategies and detect cross-strategy convergence:

{SLICING_STRATEGIES_MAP}

Total reviewers in this wave: M = len(SLICING_STRATEGIES_MAP).

## Your Task

1. **Deduplicate** -- multiple reviewers may flag the same issue. Merge into one finding.
2. **Detect convergence** -- for each merged finding, count how many DISTINCT reviewers independently flagged it. Record:
   - `reviewer_count` (N): number of distinct reviewers who flagged this issue.
   - `reviewers`: the archetype names.
   - `strategies`: the slicing strategies those reviewers used (look up each in SLICING_STRATEGIES_MAP).
   - `cross_strategy`: true if those reviewers used >= 2 distinct strategies.
   Convergence is rare (research baseline ~5-10% inter-reviewer overlap). Most findings will be singletons. When convergence does happen -- especially cross-strategy -- it is the highest-confidence signal class.
3. **Rank** -- order by severity: blocker -> high -> medium. Within a severity, list cross-strategy convergent first, then convergent, then singletons.
4. **Assess convergence at the wave level** -- surface counts and iteration recommendation.

## Output Format

### Blockers
(list, or "None")

### High
(list)

### Medium
(list)

For EACH finding (in any severity section), use this format:

**{severity}** | `{file_path or section}` near line {line}
  - {The specific problem}
  - **Convergence:** {N}/{M} reviewers ({list of archetypes}) -- strategies: {list}{, cross-strategy if >= 2 distinct}
  - {Needs verification: ...} (if applicable)

### Convergence Assessment
- **Total findings:** {count}
- **Convergent findings (>= 2 reviewers):** {count}
- **Cross-strategy convergent findings:** {count}
- **Singleton findings:** {count}
- **Recommendation:** {ITERATE | COMPLETE}
- **Iteration rationale:** {one sentence}
- **If iterating, composition adjustment:** {what to change}

**Iteration recommendation rule (apply mechanically):**
- Unresolved CONVERGENT blockers or convergent highs -> ITERATE.
- Singleton blockers/highs still warrant ITERATE -- severity matters even with one reviewer.
- Only SINGLETON mediums remain -> COMPLETE. Do not chase singleton mediums.
- Cross-strategy convergent findings are highest-confidence. Never drop them.

### Observations
(non-actionable items: patterns noticed, questions for the author)

**Evidence filter:** If any reviewer claims a type is "orphaned" or "dead code" without citing grep evidence, REJECT that observation. **Convergence does not bypass this filter** -- three reviewers hallucinating the same orphan is still a hallucination. Apply evidence filter first, then count convergence.
```

## Fresh Eyes Prompt

```
You are reviewing a {TARGET_NOUN} with fresh eyes. You have NO domain knowledge, NO project conventions, and NO prior review findings. You see only the target.

## Target
{CODE_OR_PLAN_BLOCK}

## Specs/Plans (if referenced in the target)
{SPEC_BLOCK}

## Your Task

Does this {TARGET_NOUN} make sense on its own terms?

- For code: do the names communicate what things do? Does the logic flow make sense? Does the code do what its own comments/names/tests claim? Are there assumptions that aren't documented?
- For plan: does the plan describe an executable thing? Are the AC items verifiable? Does the proposed approach make sense given what the plan describes as the problem?

If specs are provided: does the target faithfully implement what was planned?

## Rules
- You have NO conventions to reference. Judge by universal {TARGET_NOUN}-quality standards.
- Do NOT suggest "improvements." Only flag things that are confusing, wrong, or contradictory.
- Silence means it makes sense.

## Output Format
Same as focused reviewer: severity | location | problem.
```
