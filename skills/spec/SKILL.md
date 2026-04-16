---
name: spec
description: "Generate a specification. Trigger: '/spec', 'spec this', 'write a spec for', 'auto-spec'. READ THE FULL SKILL before executing — depth selection, pipeline stages, and review gates are defined below."
---

# Spec — Autonomous Specification Pipeline

Generate a complete, execution-ready specification from a short intent description. The spec is **a tool you reach for, not a gate you pass through.** Three depths are available — choose based on the problem, not habit.

## Spec Depth

Parse the `--depth` flag from arguments. If not specified, **auto-select using the heuristics below.** State the choice and why.

### `--depth=deep` — Full 6-stage pipeline with refinement loop

**Auto-select when ANY of these are true:**
- Change touches 2+ projects/repos
- You cannot list all affected files with confidence before starting
- The domain is new to the codebase (no existing patterns to follow)
- There are 3+ real design decisions where the wrong choice wastes significant work
- The change has integration seams (data flows across service boundaries)
- The operator has never built something like this in this codebase before

**Produces:** Separate artifacts per stage (problem-statement.md, decisions.md, verification.md, constraints.md, decomposition.md, work-packages/), full refinement loop + council review.

### `--depth=lite` — Single compressed spec document

**Auto-select when ALL of these are true:**
- Single project
- You can list all affected files before starting (or close to it)
- The codebase already has patterns for this kind of change
- 1-2 design decisions, and the right answers are fairly obvious
- No integration seams — changes are contained within one service/module

**Produces:** Single `spec.md` with Problem/Decisions/Verification/Constraints sections. Self-review only. ~10-20 minutes.

### `--depth=none` — No spec, just execute

**Auto-select when ALL of these are true:**
- Single file or handful of files
- Zero design decisions — the what and how are both clear
- The operator described the change specifically enough to implement directly
- Change is additive or mechanical (rename, port, delete, config change)

**Produces:** Nothing. Respond with *"No spec needed. Go build."* and stop.

### When in doubt

Default to one level deeper than you think is needed. A lite spec that turns out to be unnecessary cost 15 minutes. A missing deep spec that was needed costs hours of rework.

### Review Level (deep specs only)

For deep specs, parse the `--review` flag. If not specified, auto-select:

| Flag | Behavior | Auto-select when |
|------|----------|-----------------|
| `--review=full` | Fresh-eyes loop → council → final wave (default) | ≥3 WPs or multi-project |
| `--review=light` | Self-review only, skip refinement loop | ≤2 WPs, single project, additive-only |
| `--review=none` | Decompose and stop | User explicitly wants manual review later |

---

## Spec Lite (`--depth=lite`)

A compressed specification for well-understood changes. Produces a single `spec.md` in the workshop directory.

### Setup

1. **Parse intent** — extract what, which project, slug (same as deep spec Phase 1a)
2. **Scaffold workshop** — create directory + `meta.json` with status `"captured"`
3. **Quick explore** — read key files likely affected. No full codebase survey — this is targeted.
4. **Read CORRECTIONS.md** — non-negotiable regardless of depth
5. **KB search** — one query for prior work on this topic

### Write spec.md

A single document with four concise sections:

```markdown
# {Title}

## Problem
{2-4 paragraphs. What we're solving, why, and the current state. Ground in real file paths.}

## Decisions
{Numbered D1, D2... Only real ambiguities — not exhaustive. For each: options considered, choice made, one-line reasoning.}

## Verification
{For each decision: how an observer confirms it was implemented correctly. Concrete commands or observable behavior.}

## Constraints
{M1, MN1, P1, E1... Compressed. Focus on must-nots that prevent the most likely agent mistakes.}
```

Run a quick self-review: ambiguity scan, grounding check, constraint coverage. Fix issues.

### Present for Review

Show a brief summary with flagged items. Wait for approval. Apply revisions if needed.

### Final Output

Update `meta.json` status to `"ready"`.

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `workshops/{slug}/`
**Depth:** lite — single document
**Review:** self-review only

Ready for execution.
```

Write a ledger event: `{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "spec-lite", "event_type": "completed", "actor": "agent" }`

---

## Spec Deep (`--depth=deep`)

Full methodology. Same pipeline as always — grounded, adversarial, iterative.

## Phase 1: Setup & Exploration

### 1a. Parse Intent

Extract from the intent:
- **What** is being built or changed
- **Which project(s)** this touches — check `/workspace\projects\` for matching repos
- **Slug** — kebab-case, ≤40 chars

If the project is ambiguous, ask. If the scope is ambiguous, make your best guess and flag it as `[ASSUMPTION: A1]` — the human will correct at the review gate.

### 1b. Scaffold Workshop

Create `/workspace\data\outputs\workshops\{slug}\` with `meta.json`:
```json
{
  "title": "{title}",
  "slug": "{slug}",
  "status": "captured",
  "projects": ["{project}"],
  "tags": [],
  "createdAt": "{ISO timestamp}",
  "updatedAt": "{ISO timestamp}"
}
```

### 1c. Explore Codebase

Before writing anything, ground yourself in the actual code. Use the Agent tool to launch an Explore agent:

- Directory structure of the target project
- Key entry points, config files, package.json/cargo.toml etc.
- Files most likely affected by this change
- Existing patterns the implementation should follow

Store findings mentally — you'll reference them throughout. Every architectural claim in the spec must cite a real file path.

### 1d. Read Institutional Memory

**Read CORRECTIONS.md first** — this is non-negotiable:
```
Read /workspace\data\memory\CORRECTIONS.md
```
This file contains cross-project corrections from past failures. Every constraint in it was learned the hard way. Internalize the relevant entries and inject them as constraints or must-nots in Stage 4.

Then search the KB for prior work on this topic:
```
kb_search("relevant terms from the intent")
```
Surface any prior workshops, research, or lessons that inform this spec. Don't re-derive what's already been decided.

## Phase 2: Autonomous Pipeline (Stages 1-4)

Run stages 1-4 sequentially. For each stage:
1. Read the pattern file from `/workspace\projects\heathdev-patterns\patterns\`
2. Write the artifact to the workshop directory
3. Update `meta.json` status

**Do not dump pattern contents into your output.** Read them, internalize the methodology, apply it. The patterns are your reference, not content to recite.

### Stage 1: Problem Statement
- Pattern: `patterns/problem-statement.md`
- Output: `problem-statement.md`
- Key discipline: Self-containment test. Could a stranger begin solving this from what's written?
- Ground every claim in code you actually read in Phase 1.
- Surface hidden assumptions as `[ASSUMPTION: A1]`, `[ASSUMPTION: A2]`, etc.

### Stage 2: Decisions
- Pattern: `patterns/decision-resolution.md`
- Output: `decisions.md`
- Key discipline: Scan your own problem statement for ambiguity flags ("or", "possibly", "might", "TBD", "should consider"). Each real ambiguity becomes a numbered decision (D1, D2...).
- For each decision: list options, state tradeoffs (one line each), **choose one**, document reasoning.
- Mark decisions where you're uncertain as `[DECISION: D3 — low confidence, alternatives close]`.
- Use the `design-alternatives` pattern mentally — consider at least 2 approaches before choosing.

### Stage 3: Verification
- Pattern: `patterns/verification-criteria.md`
- Output: `verification.md`
- Key discipline: For each decision, write the three-sentence independent observer test. If you can't verify it, the decision needs refinement — flag it.
- **Identify verification layers per criterion** — unit tests alone are insufficient. For each V-criterion, explicitly state which layers apply:
  - **Unit:** isolated logic (mocks OK here)
  - **Fixture-contract:** capture real external output as test fixtures, parse with real code. Required for any decision that consumes external service output (APIs, CLI tools, file formats).
  - **Seam-integration:** wire internal services together with real code, fixtures only at external boundaries. Required when data flows through 2+ services. This catches "both pass independently but the handoff breaks."
  - **Deployment:** Docker smoke tests, build checks, CI validation. Required when decisions change the deployment artifact.
  - **Manual observation:** ONLY for genuinely subjective quality judgment. If you default to "manual" because automation is hard, flag it as a gap.
- A V-criterion with only "run dotnet test --filter Foo" is almost certainly underspecified. Ask: what breaks between the units?
- **Identify seams explicitly** — list every point where data crosses a service boundary. Each uncovered seam is a verification gap that must be documented with rationale.
- End with a `## Verification Gaps` section listing uncovered seams and why they're acceptable.
- Capture baselines where applicable.

### Stage 4: Constraints
- Pattern: `patterns/constraint-architecture.md`
- Output: `constraints.md`
- Key discipline: Four categories — Musts (M1...), Must-Nots (MN1...), Preferences (P1...), Escalation Triggers (E1...).
- Use the "smart well-intentioned person" exercise: what could they do that satisfies every requirement but produces the wrong outcome?
- **Cross-reference CORRECTIONS.md** (read in Phase 1d) against this spec's scope. Specifically:
  - Any correction relevant to this spec's domain becomes an explicit Must-Not
  - Cross-repo changes share a wire format contract
- Check KB for failure modes from similar past work. Inject relevant constraints.

## Phase 3: Self-Review

After writing all 4 artifacts, run an adversarial self-review:

1. **Ambiguity scan** — re-read all artifacts for unresolved "or", "possibly", "might", "TBD"
2. **Grounding check** — does every architectural claim reference a real file?
3. **Verification specificity** — is every V-criterion a concrete command or observable behavior, not vibes?
4. **Constraint coverage** — all 4 categories present? Must-nots address likely agent drift?
5. **Cross-artifact consistency** — do decisions align with constraints? Do verification criteria cover every decision?

Fix issues found. Then flag anything you're still uncertain about.

## Phase 4: Human Review Gate

Present a consolidated review artifact. Format:

```markdown
## Spec Review: {title}

### Flagged Items
{List all [DECISION] and [ASSUMPTION] callouts with their context}

### Summary
- **Problem:** {1-2 sentences}
- **Key decisions:** {D1, D2... with choices made}
- **Verification approach:** {strongest verification type used}
- **Constraint highlights:** {most important must-nots and escalation triggers}

### Review level
{full|light|none} — {reason for selection}

### Your Call
Review the flagged items. For each:
- ✅ Approve
- ✏️ Revise: {your correction}
- ❌ Reject: {why}

Or: "looks good" to proceed, "start over" to restart, or specific feedback.
You can also override the review level: "looks good, but skip review" or "looks good, full review please"
```

**STOP HERE.** Wait for human input. Do not proceed to decomposition without explicit approval.

## Phase 5: Revision (if needed)

When the human provides feedback:
1. Identify the earliest affected stage
2. Revise from that stage forward (don't re-run unaffected stages)
3. Re-present only the changed sections
4. Return to the review gate

One revision loop is normal. If the third revision still has major issues, suggest a `/grill-me` session to resolve the underlying confusion.

## Phase 6: Decomposition & Work Packages

After approval, run stages 5-6:

### Stage 5: Decomposition
- Pattern: `patterns/decomposition.md`
- Output: `decomposition.md`
- Apply the appropriate break pattern (API/Backend, UI, Refactor, Infrastructure) from the pattern.
- Run the decomposition test: each unit <2hrs, clear boundaries, independently verifiable, disjoint files.
- Include a Mermaid dependency graph for 4+ packages.

### Stage 6: Work Packages
- Pattern: `patterns/work-package.md`
- Output: `work-packages/wp-{NN}-{slug}.md` for each package + `work-packages/_orchestrator.md`
- Use the template from `/workspace\projects\heathdev-patterns\templates\_orchestrator.template.md`
- All 6 required fields per WP (precondition, goal, files, verification, failure criteria, boundary)
- Tag each WP: `execution: autonomous` or `execution: review-needed` (HITL flag)
- Dependency order (which WPs must complete before others can start)
- Spec-level constraints in orchestrator (from constraints.md)

Update `meta.json` status to `"ready"`.

**If `--review=none`:** Skip to Phase 9 (Final Output).
**If `--review=light`:** Skip to Phase 9 (Final Output). The self-review in Phase 3 is the only quality pass.
**If `--review=full`:** Continue to Phase 7.

## Phase 7: Refinement Loop (--review=full only)

Iteratively review the work packages using fresh-eyes Sonnet sub-agents until convergence.

### 7a. Fresh-Eyes Wave

Launch a Sonnet sub-agent using the Agent tool with this prompt structure:

```
You are a fresh-eyes spec reviewer. You have NO prior context about this workshop.
Your job: find problems that would cause execution failures, incorrect implementations,
or ambiguity that an autonomous agent would resolve incorrectly.

Review these work package specs against the actual source code they reference.
For each WP, verify:
1. File paths and line numbers cited in the spec actually exist and match described content
2. Function signatures, type names, and API shapes match the real code
3. The described change is implementable as written (no missing steps, no impossible states)
4. Boundary constraints are enforceable (no overlap with other WPs' file lists)
5. Test descriptions are specific enough to write without guessing
6. Failure criteria are actionable (not just "if it doesn't work")

Rate each finding:
- **P1 (blocker):** Would cause execution failure, incorrect code, or constraint violation
- **P2 (significant):** Ambiguity an agent would likely resolve incorrectly
- **P3 (minor):** Style, clarity, or edge case unlikely to affect execution

Workshop directory: {workshop_path}
Project directory: {project_path}

Read ALL work package files in work-packages/ and the _orchestrator.md.
Read the constraints.md for constraint cross-reference.
Read the actual source files referenced in each WP to verify claims.

Output format:
## Review Wave {N}

### Findings
- **P1:** {description} — {which WP, which section, what's wrong}
- **P2:** {description}
...

### Files Checked
{list of source files you actually read}

### Verdict
{CLEAN | HAS_BLOCKERS | HAS_ISSUES}
- P1 count: {N}
- P2 count: {N}
- P3 count: {N}
```

### 7b. Fix Findings

After each wave:
- **P1s:** Fix immediately. These are blockers — update the WP spec files directly.
- **P2s:** Fix unless the fix would introduce more complexity than the ambiguity costs. Document skipped P2s.
- **P3s:** Note but do not fix unless trivial. Accumulate across waves.
- **False positives:** The agent uses regex-like heuristics. If a finding is wrong (e.g., "or" in normal English flagged as ambiguity), discard it and note it as a false positive.

### 7c. Convergence Check

After fixing, decide whether to run another wave:

| Condition | Action |
|-----------|--------|
| Wave returned P1s | Fix and run another wave (mandatory) |
| Wave returned P2s only, fixes applied | Run one more wave to verify fixes |
| Wave returned P3s only or was clean | **Converged** — proceed to council |
| 8 waves completed | **Force converge** — proceed to council regardless |

Track across waves: if wave N finds the same P2 that wave N-1 found and it was already evaluated and kept, that's not a new finding — it's convergence noise. Suppress it.

### 7d. Report Progress

After each wave, briefly report to the user:
```
Wave {N}: {P1_count} P1, {P2_count} P2, {P3_count} P3. {Fixed X issues. | Clean.} {Converged — moving to council. | Running wave {N+1}.}
```

Keep it to one line. The user doesn't need to see every finding — they'll see the final result.

## Phase 8: Council Review (--review=full only)

After the fresh-eyes loop converges:

### 8a. Deploy Council

Use the `mcp__review-council__council_review` tool to run a multi-model review:

```
council_review({
  artifact_path: "{workshop_path}",
  review_type: "spec",
  thinking_level: "medium",
  models: ["claude", "gemini", "gpt"]
})
```

If any model times out, retry that model once with `thinking_level: "low"`. If it times out again, proceed with the models that completed.

### 8b. Apply Council Findings

Process the council synthesis:
- **Critical findings:** Fix immediately in the spec files.
- **Major findings:** Fix unless they conflict with a deliberate decision (reference the D# and explain why it stands).
- **Minor findings:** Note but don't fix.

Count amendments applied.

### 8c. Final Validation Wave

Run one more Sonnet fresh-eyes wave (same prompt as 7a) to verify the council amendments didn't introduce new issues. This is the final quality gate.

Then run the spec-validate script (locate `validate.mjs` in the plugin's `skills/spec-validate/scripts/` directory):
```bash
node "$(find ~/.claude/plugins -path '*/spec-validate/scripts/validate.mjs' 2>/dev/null | head -1)" {workshop_path}
```

Report: validation result (errors/warnings/passes) + final wave verdict.

## Phase 9: Final Output

Present the completed spec summary:

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `workshops/{slug}/`
**Packages:** {N} WPs
**Estimated execution:** {autonomous WPs} autonomous, {review WPs} need review
**Dependency order:** {summary}
**Review:** {review_level} — {N} fresh-eyes waves, {N} council models, {N} amendments applied
**Validation:** {pass/fail} — {errors} errors, {warnings} warnings

Ready for execution.
```

If `--review=light` or `--review=none`, the Review and Validation lines reflect what was actually done:
```
**Review:** light — self-review only
**Review:** none — no review performed, manual review recommended before execution
```

## Principles

- **Speed over perfection, but not over correctness.** The refinement loop exists because speed without review produces specs that fail at execution. The loop is fast (Sonnet agents, ~2 min/wave) and the ROI is proven.
- **Ground everything.** No architectural claims without file references. No "the system probably does X."
- **Flag, don't hide.** Uncertainty is fine — hiding it isn't. Use [DECISION] and [ASSUMPTION] callouts liberally.
- **Patterns are runtime reads, not memorized content.** Read each pattern file fresh before writing its artifact. Patterns evolve.
- **The output is a real workshop.** Not a separate format. Everything downstream (validate, review council) works on these artifacts unchanged.
- **Convergence, not perfection.** The refinement loop stops when P1s are gone, not when findings are zero. P3s are noise — chasing them degrades momentum.
- **The spec is a tool, not a gate.** Deep when it helps, lite when it's enough, none when it's overhead. The operator chooses.

## Ledger Events

Write timing events at each stage transition (fire-and-forget, non-blocking):
```json
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "{stage}", "event_type": "entered", "actor": "agent" }
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "{stage}", "event_type": "completed", "actor": "agent" }
```

For the refinement loop, write one event per wave:
```json
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "refinement_wave_{N}", "event_type": "completed", "actor": "agent", "findings": { "p1": N, "p2": N, "p3": N } }
```

---
*Pattern library: /workspace\projects\heathdev-patterns\*
*Related skills: /spec-validate (quality check), /grill-me (stress-test before speccing), /design-alternatives (compare approaches)*
