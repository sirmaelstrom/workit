# Pattern: evaluation-loop

**What:** The systematic practice of knowing whether AI output is *good* — not "does it look reasonable" but "can you prove measurably, consistently, that this meets the bar." This is the feedback mechanism that makes every other pattern in the library get better over time.

**When to use:** After every dispatch. After every recurring AI task. After model updates. This is the pattern that's been missing — we handle errors (`corrections-loop`) but not quality. Error correction and quality evaluation are fundamentally different activities.

**Status:** Least mature pattern in the library. We know this is critical but haven't nailed the implementation. This document captures the shape and will evolve faster than most.

## Why This Was the Gap

We had:
- `test-first-spec` — verifies "does it work" per-dispatch
- `corrections-loop` — captures "what went wrong" after failures
- `trust-ramp` — graduates autonomy based on success/failure counts

We didn't have:
- "Was the output *good*, not just *passing*?"
- "Did this spec produce better results than last time?"
- "Which patterns consistently produce high-quality dispatches?"
- "Did a model update change output quality for the same spec?"

The gap: we track binary pass/fail but not quality gradient. A dispatch can "pass" verification and still be mediocre — technically correct code that's poorly structured, a feature that works but has bad UX, a refactor that passes tests but introduces complexity.

## The Three Layers

### Layer 1: Dispatch Outcome Tracking
The most concrete and immediately buildable layer.

For each dispatch, capture:
- **Pass/fail** (we have this)
- **Scope adherence** — did the agent stay within specified files? (we partially have this)
- **Verification results** — which criteria passed, which needed human intervention?
- **Rework needed** — did you have to manually fix anything after the dispatch "succeeded"?
- **Time to done** — wall-clock from dispatch to accepted result
- **Model used** — critical for regression detection across model updates

This data accumulates. Over 20-30 dispatches, patterns emerge: which types of specs produce clean results? Which consistently need rework? What's the rework rate by complexity level?

### Layer 2: Pattern Effectiveness
Which patterns from this library actually improve outcomes?

Track correlations:
- Specs with `constraint-architecture` (all four categories) vs. specs with only must-nots — rework rate difference?
- Specs that went through `decision-resolution` scan vs. specs dispatched with ambiguity — scope violation rate?
- Specs built from `problem-statement` → `decomposition` → `work-package` pipeline vs. specs written ad-hoc — first-pass success rate?

This is how the patterns evolve with evidence instead of intuition. A pattern that doesn't measurably improve outcomes gets revised or retired.

### Layer 3: Reference Outputs (Regression Detection)
For recurring work types, maintain known-good outputs as baselines.

- **What:** A small library of specs with their expected outputs (or output characteristics)
- **When to run:** After model updates. Periodically (monthly). When you suspect quality drift.
- **What it catches:** A model update that breaks a previously reliable spec. A pattern that stopped working. Quality regression that's invisible without comparison.

Example: Take a spec that produced excellent results with Sonnet 4.6. After a model update, run the same spec. Compare. If the output quality drops, you've caught a regression before it costs you real work.

This is the most aspirational layer. Start with Layer 1.

## Practical Starting Point

Don't try to build all three layers at once. Start with:

1. **Add a "Dispatch Results" section to every spec file** — after completion, append what happened. Pass/fail, rework needed, what you'd change about the spec.
2. **Review monthly** — look across the last month's dispatch results. What patterns show up? What specs needed the most rework? What was the common factor?
3. **Feed back to patterns** — each pattern file has an "Execution Feedback" section. When you see evidence that a pattern helps (or doesn't), append it there.

This is manual and low-tech. That's intentional. Automate after you understand what signals actually matter — premature automation captures the wrong things.

## Connection to Outcome Tracking (Phase 4a)

The dispatch system should eventually generate Layer 1 data automatically:
- Structured result capture (not just status codes)
- File-diff analysis (files touched vs. files specified)
- Agent output archival (last N chars on failure, full output on success)
- Time tracking (queue → start → complete → accepted)

Phase 4a on the board is the infrastructure for this. This pattern describes what to *do* with that data.

## The Quality Question

The hardest part of evaluation isn't capturing data — it's defining "good." Binary pass/fail is easy. Quality is subjective and context-dependent.

Starting heuristics for "good" (refine through experience):
- **Zero rework** — the output was accepted as-is
- **Scope adherence** — touched exactly the files specified, nothing more
- **Convention compliance** — follows project patterns without being told (because CLAUDE.md corrections are working)
- **Idiomatic** — code that looks like a human on the team would write it, not "AI-flavored"
- **Edge cases handled** — failure modes addressed without being explicitly listed in the spec

These aren't measurable yet. Making them measurable is part of the work.

## Execution Feedback

*(This pattern is self-referential — its own execution feedback IS the evaluation loop in action)*

**2026-02-19 — web-frontend Phase 2 (first application, retroactive):**

First real spec evaluation, scored conversationally at 80/100. Proved that even informal Layer 1 tracking produces actionable feed-back: persistence specification gaps in `work-package`, semantic accuracy checks in `post-build-verification`, and the two-document pattern (build spec + verification checklist) all originated from this single evaluation.

Primary failure mode: under-specification (2 missing, 1 wrong, 1 ambiguous out of 5 deviations) — not agent error. This aligns with Layer 2's prediction: specs that go through full `decision-resolution` should have lower deviation rates than ad-hoc specs.

Key gap exposed: no timing data captured. Without wall-clock duration, Execution Efficiency scoring is inference, not measurement. The `spec-scorecard` template now calls for this explicitly.

Worked example: `examples/scorecard-web-frontend-phase2-threads.md`

**2026-03-04 — Tooling materialized:**

Layer 1 now has a concrete template: `spec-scorecard.md` (100-point scale, 5 dimensions, deviation log with root-cause categories, feed-back routing table). Each scoring dimension explicitly maps to the pattern it evaluates — making Layer 2 analysis possible once enough scorecards accumulate. The running log format is demonstrated in `examples/`.

---
*Influenced by: Nate B. Jones specification primitives (evaluation design)*
*Cross-cutting discipline — post-execution quality feedback, governs pattern evolution*
*Concrete tooling: `spec-scorecard.md` (Layer 1), `post-build-verification.md` (build quality)*
*See also: `corrections-loop`, `trust-ramp`, `test-first-spec`, `spec-engineering`*
