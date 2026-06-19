# Worked Example: Spec Scorecard — Web Frontend Phase 2 Thread UI Redesign

*First real application of the spec evaluation process. Scored conversationally (scorecard template didn't exist yet), then retroactively structured. This entry demonstrates what evaluation-loop Layer 1 looks like in practice.*

## Target

- **Spec prompt:** `web-frontend-phase2-spec.md`
- **Executor model:** CLI session (likely Opus 4.6 — model unrecorded)
- **Work packages completed:** 8/8
- **Execution date:** 2026-02-19
- **Score:** 80/100 (estimated — formal scorecard not filled at time of execution)

---

## Scoring Breakdown

| Dimension | Score | Pattern Evaluated | Notes |
|-----------|-------|-------------------|-------|
| Structural Clarity | 18/20 | `decomposition`, `work-package` | Package ordering correct, file refs excellent, dependencies sound |
| Specification Precision | 17/20 | `spec-engineering`, `decision-resolution` | Code snippets followed nearly verbatim. Svelte 5 `onclick\|stopPropagation` syntax was wrong (Svelte 4 modifier) — agent self-corrected |
| Execution Efficiency | 16/20 | `wave-execution` | Not directly measured (no session timing data). Clean single-pass execution inferred from code state matching spec |
| Guardrail Effectiveness | 17/20 | `constraint-architecture`, `corrections-loop` | All "DO NOT" items respected (no spatial layout, no WarmthRail, no auto-send on Continue). DaisyUI OKLCH bare channels note prevented integration issues |
| Completeness | 12/20 | `post-build-verification` | All packages built, but polish package was underspecified. Palette gaps across views. Capture dismiss is local-only (no persistence). Thread iconography carried over from "Today" without semantic update |

---

## Deviation Log

| Package | Deviation | Root Cause | Spec Change Needed? |
|---------|-----------|------------|---------------------|
| 4 (ThreadCard) | `onclick\|stopPropagation` → `onclick={(e) => { e.stopPropagation(); ... }}` | **Wrong** — spec used Svelte 4 syntax | Yes — update code snippets to Svelte 5 |
| 5 (CaptureSeed) | `×` entity used instead of `×` text | Trivial HTML entity choice | No |
| 6 (TodayView) | Capture promote falls back to sendMessage instead of creating a new thread | **Missing** — bridge API for thread creation not described | Yes — specify the promote pathway or acknowledge as known gap |
| 7 (Polish) | Unclear what was actually verified | **Ambiguous** — package is a vibes check, not a spec | Yes — replace with verification checklist or enumerate surfaces |
| 8 (Rename) | `RoadmapSection.svelte` still exists as dead code | **Missing** — spec said "remove import" but not "delete file" | Yes — explicitly list files to delete |

Root cause distribution: 2 Missing, 1 Wrong, 1 Ambiguous, 1 trivial — signals that under-specification (not over-specification) is the primary failure mode at this stage.

---

## Key Lessons (fed back to patterns)

### 1. Polish packages need structure, not vibes
"Navigate all views and fix things" is not a spec — it's a wish. The agent either skips it or guesses.

**Feed-back:** This directly caused creation of the `post-build-verification` template. Polish is an inspection concern, not a build concern. The spec is for the builder; the verification checklist is for the inspector. Different audiences, different concerns, different timing.

### 2. Persistence gaps must be called out explicitly
The spec said "Dismiss" without specifying whether it persists to the backend or is local state. The agent implemented local `$state` (a Set of dismissed IDs) which resets on refresh.

**Feed-back:** The `work-package` pattern's "Persistence Specification" section was added because of this. For each user action: does it survive refresh? Navigation? Session restart? Where is state stored? "Does not persist — intentional" is just as important as specifying persistence.

### 3. Semantic carryover is invisible to agents
Renaming "Today" to "Threads" changed the label but not the sidebar icon. The sun icon is a carryover that doesn't match "Threads." Agents don't evaluate semantic appropriateness of existing visuals unless told to.

**Feed-back:** The `post-build-verification` template includes "Semantic Accuracy" as a dedicated category — specifically because of this miss.

### 4. Svelte 5 syntax in specs must be exact
The spec used Svelte 4 event modifier syntax. The agent self-corrected, but the spec was wrong.

**Feed-back:** This is a `corrections-loop` candidate → add to CLAUDE.md: "Svelte 5 uses `onclick={(e) => { e.stopPropagation(); handler(e) }}`, not `onclick|stopPropagation`."

---

## Meta-Observations

- The biggest class of misses — palette coverage, persistence, semantic accuracy — are all things discovered through *use*, not through *design*. This validates the verification-checklist approach over trying to make specs more exhaustive. Construction specs can't anticipate every surface-level detail.
- An 80/100 spec that produces working code with minor gaps is genuinely good for a first attempt. The feedback loop (scorecard → quality log → pattern updates) is the mechanism that compounds quality over time.
- The spec-then-verify two-document pattern mirrors construction (blueprints + punch list). Both are necessary. Neither is sufficient alone.
- Model timing data wasn't captured. Future dispatches need wall-clock timing to make Execution Efficiency scoring meaningful. (This gap motivated evaluation-loop's call for structured result capture.)

---

## Process Artifacts Created From This Evaluation

| Artifact | What It Is | Current Location |
|----------|-----------|-----------------|
| Post-Build Verification Checklist | 7-category inspection framework | `patterns/post-build-verification.md` |
| Persistence Specification section | Added to work-package pattern | `patterns/work-package.md` |
| Semantic Accuracy category | Added to verification checklist | `patterns/post-build-verification.md` |

This single evaluation created more process improvement than the execution itself — which is exactly what `evaluation-loop` predicts: "the feedback mechanism that makes every other pattern get better over time."

---
*Worked example — first application of spec evaluation, retroactively structured*
*Demonstrates: `evaluation-loop` Layer 1, `spec-scorecard` template, `corrections-loop` feed-back*
*Original source: an internal prompt-quality log (Feb 2026)*
