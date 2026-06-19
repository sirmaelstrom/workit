# Pattern: spec-engineering

**What:** The full specification-driven AI development methodology. The spec is the product — code is a side effect.

**When to use:** Any feature, change, or initiative that will be dispatched to an AI agent.

**Core principle:** Specification precision over execution speed. The bottleneck is knowing what to type, not typing speed.

**Role in the library:** Umbrella philosophy. The workshop pipeline patterns (`problem-statement` → `decision-resolution` → `constraint-architecture` → `decomposition` → `work-package`) are the concrete implementation of these ideas. This pattern describes the *why* and the quality model; the pipeline patterns describe the *how*.

## Anatomy of a Spec

1. **Problem Statement** — Self-contained capture of what's being solved and why. (See: `problem-statement`)
2. **Decisions** — Every ambiguity resolved with reasoning. Option forcing analysis prices each path. Pragmatist Check resists complexity bias. (See: `decision-resolution`)
3. **Verification Criteria** — Testable success criteria for every decision. The specification act — if you can't verify it, you haven't decided it. (See: `verification-criteria`, governed by `test-first-spec`)
4. **Constraints** — Musts, must-nots, preferences, escalation triggers. (See: `constraint-architecture`)
5. **Decomposition** — Work broken into independent, testable, parallelizable units. (See: `decomposition`)
6. **Work Packages** — Ordered steps, each independently committable and dispatchable. (See: `work-package`)

## Required Metadata

```markdown
**Created:** {date}
**Project:** {name} (`{path}`)
**Status:** Draft | Ready | In Progress | Complete | Abandoned
```

Status matters. A Draft spec has unresolved decisions. A Ready spec can be handed to an agent without supplemental conversation. Never dispatch a Draft.

## Common Failures

- **Vague polish packages** — "Fix any visual issues" gives the agent a blank check
- **Implicit persistence** — Does "dismiss" survive page refresh? Say so explicitly.
- **Framework version mismatch** — Code snippets using deprecated APIs
- **Missing delete instructions** — Old files left as dead code
- **No constraints** — Agent refactors the world for "consistency" (See: `constraint-architecture`)
- **Untestable verification** — "Verify the component renders correctly" instead of a specific command with expected output (See: `test-first-spec`)
- **Complexity bias under low production cost** — Choosing the architecturally ambitious option because building is cheap, without pricing the forcing cost (new tests, error paths, documentation, maintenance). The spec is the brake that replaces production cost. (See: `decision-resolution` Pragmatist Check)

## Quality Measurement

5 dimensions, scored 1-5 across 4 sub-aspects (100-point scale):
- Structural Clarity
- Specification Precision
- Execution Efficiency
- Guardrail Effectiveness
- Completeness

First spec: expect 60-75. Fifth spec: expect 80-90. **The delta is the product.**

## The Two-Agent Test

> If two different agents would produce meaningfully different output from this spec, the spec is under-specified.

## Execution Feedback

**2026-03-01 — Pattern library restructure:** Reclassified from pipeline step to cross-cutting discipline. The pipeline patterns are the concrete implementation; this pattern is the philosophy and quality model. Prior positioning as a sequential step was misleading — spec-engineering governs the entire pipeline, not a single stage.

---
*Source: spec-driven-engineering-guide.md, spec-pipeline-layer1.md*
*Cross-cutting discipline — governs the full workshop pipeline*
*See also: `problem-statement`, `work-package`, `decision-resolution`, `constraint-architecture`, `test-first-spec`, `evaluation-loop`*
