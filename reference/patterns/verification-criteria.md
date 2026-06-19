# Pattern: verification-criteria

**What:** Define observable, verifiable success criteria for every decision before constraining or decomposing the solution. This is the pipeline stage where `test-first-spec` gets applied to decisions — turning resolved ambiguity into testable assertions.

**When to use:** After `decision-resolution`, before `constraint-architecture`. Every workshop. If you can't verify a decision, you haven't actually made it.

## Why This Stage Exists

The workshop pipeline had a gap. Decisions resolved *what* to build. Constraints defined *how* to bound it. Decomposition broke it into units. Work packages specified verification per-unit. But there was no moment where decisions were pressure-tested for verifiability *as a group* — the "can we prove this worked?" question was deferred to work-package-level verification, which is too late and too granular.

The result: decisions that felt resolved but weren't actually testable. "Use broadcast-fed badges" sounds decided — but what does success look like? How would an independent observer know it's working? Without that answer, the decision is a direction, not a specification.

This stage forces the question early: **for each decision, write the verification criteria that will prove it was implemented correctly.** If you can't, the decision needs more refinement — push it back to `decision-resolution`.

## The Artifact: `verification.md`

The output is a `verification.md` file in the workshop directory. Structure:

```markdown
# Verification Criteria — {Workshop Name}

## Verification Philosophy
{Brief statement of the verification strategy — which layers are in play and why.}

---

## V1: {Short description} (maps to D1)

**Decision:** {One-line summary from decisions.md}

**Layers:**
- **Unit:** {What isolated logic is tested}
- **Fixture:** {What real external output is captured and parsed — or "N/A: no external boundary"}
- **Seam:** {What internal service handoffs are wired together — or "N/A: single service"}
- **Deployment:** {What build/infra checks apply — or "N/A"}

**Criteria:**
- {Observable assertion 1}
- {Observable assertion 2}
- {Observable assertion 3}

**Baseline (before):** {Current measurable state, if applicable}
**Target (after):** {Expected measurable state}

**How to verify:**
{Exact command, URL, or procedure per layer. No ambiguity.}

---
## V2: {Maps to D2}
...

---
## Verification Gaps
- [ ] ⚠️ {Uncovered seam or layer with rationale for why it's acceptable}
- [x] ✅ {Covered item for completeness tracking}
```

## The Three-Sentence Test

From `test-first-spec`:

> Could someone who has never seen this project verify the output using only what's written here, without asking you a single question?

For each decision, write three sentences an independent observer could use to verify the implementation. If you can't write those three sentences:
1. The decision isn't concrete enough — push it back to `decision-resolution`
2. The verification requires knowledge not in the spec — add the knowledge
3. The criteria are too complex for one decision — the decision might be multiple decisions

## Verification Layers

"Automated test" is not one thing. The default failure mode is writing unit tests with mocks and calling it verified. Unit tests with mocks verify that your code does what your mock says the world does — they don't verify that the world actually works that way. The seams between services are where things break, and they're exactly where mock-based tests go blind.

Every verification criterion must specify **which layer** it targets:

### Layer 1: Unit Tests
Isolated logic — URL regex, data parsing, prompt construction, error mapping. Mocks are appropriate here because the thing under test has no external dependencies by design.

### Layer 2: Fixture-Based Contract Tests
Capture **real output** from external services (API responses, CLI output, file formats) as test fixtures checked into the repo. Run your real parsers/deserializers against these fixtures. This catches format drift — when the external service changes its output shape, your fixtures go stale and the test fails on refresh.

**When required:** Any decision that involves consuming external service output (APIs, CLI tools, file formats from other systems). If a decision introduces an external boundary, it needs a fixture.

**Fixture discipline:**
- Capture from the real service, not hand-crafted
- Store in `tests/Fixtures/{ServiceName}/` (or equivalent)
- Include a comment or script showing how to refresh the fixture
- Include at least: one success case, one error/edge case

### Layer 3: Seam Integration Tests
Wire multiple **internal** services together with real code — no mocks between your own services. Fixtures only at external boundaries. This verifies the handoff contracts: does Service A's output actually work as Service B's input?

**When required:** Any decision that involves routing, delegation, or data transformation across service boundaries. If a pipeline has 3+ steps, the seam test wires them end-to-end with fixtures only at the edges.

**The failure mode this catches:** "Both services pass their unit tests independently, but Service A produces a shape that Service B doesn't actually handle." This is the most common class of bug in dispatched work — each WP is correct in isolation, but the integration breaks.

### Layer 4: Deployment Verification
Build checks, Docker smoke tests, CI-runnable infrastructure validation. These verify that the thing actually runs in the target environment, not just in the test runner.

**When required:** Any decision that changes the deployment artifact (Dockerfile, package.json, CI config, environment variables).

### Layer 5: Playwright / E2E
Full browser-based verification for UI behavior. Use when the decision affects what the user sees or interacts with.

### Layer 6: Manual Observation
Human judgment for subjective quality ("does the extracted recipe look right?", "is the UI confusing?"). **This is only appropriate for genuinely subjective criteria.** If you're writing "Manual observation" because automating is hard, that's a flag — either find the automation path or document why it's truly not automatable.

### Choosing Layers

Most verification criteria need **more than one layer**. A decision that introduces an external API typically needs:
- Layer 1 (unit): prompt construction, error mapping
- Layer 2 (fixture): real API response parsing
- Layer 3 (seam): response → downstream service handoff

A verification criterion that says only "Automated test" with a single `dotnet test --filter` command is almost certainly underspecified. Ask: **what breaks between the units?**

### Identifying Seams

When writing verification criteria, explicitly identify the seams in the system. A seam is any point where data crosses a boundary:
- Service A calls Service B
- Parser output feeds into a downstream consumer
- External data enters the system (API response, CLI output, user input)
- Internal data exits the system (database write, API call, UI render)

Each seam that isn't covered by a fixture or integration test is a gap. The `## Verification Gaps` section at the bottom of `verification.md` must list uncovered seams with rationale for why they're acceptable.

## Baseline Capture

For decisions that change measurable behavior (performance, request counts, bundle size, timing), **capture the baseline before implementation begins**. A verification criterion without a baseline is aspirational, not measurable.

Baselines can be:
- Runtime measurements (request count on connect, time-to-interactive)
- Static analysis (bundle size, import graph depth)
- Code metrics (module count in critical path, LOC in deleted files)

Include the exact command used to capture the baseline so it can be re-run after implementation.

## Connection to Downstream Patterns

**→ `constraint-architecture`:** Verification criteria inform constraints. If V3 says "Sidebar must not import full state modules," that becomes a must-not constraint. Verification criteria are the *evidence* that constraints need to exist; constraints are the *rules* that ensure criteria are met.

**→ `decomposition`:** Verification criteria define the observable outcomes that decomposition must preserve. Each work unit, when recombined, must satisfy the verification criteria. If a decomposition makes a criterion unverifiable (because the observable behavior spans multiple units), the decomposition is wrong.

**→ `work-package`:** Work package verification fields are *derived from* the criteria in this document — scoped to the individual package's contribution. The criteria here are system-level ("initial connect fires ≤4 requests"); work package verification is local ("this module's `_connected` handler is gated behind `_initialized`").

**← `decision-resolution`:** If writing verification criteria reveals that a decision is untestable or ambiguous, push it back. The feedback loop between decisions and verification is intentional — verification is the specification act that reveals whether decisions are real.

## Relationship to test-first-spec

`test-first-spec` is a cross-cutting discipline — the principle that testability IS specification. This pattern is the **pipeline stage where that discipline gets applied to decisions**. Think of it this way:

- `test-first-spec` says: "If you can't verify it, you haven't specified it."
- `verification-criteria` says: "Here is the moment in the pipeline where you prove you can verify every decision."

The discipline is timeless; the stage is structural.

## Execution Feedback

*(Append results here)*

---
*Source: a lazy-load workshop — decisions were resolved but verification criteria were deferred to work packages, which is too late. The gap was felt as "test-first-spec keeps getting left until too late."*
*Pipeline: ← `decision-resolution` | → `constraint-architecture`*
*Governed by: `test-first-spec` (cross-cutting discipline)*
*See also: `observability-contract` (verification criteria are postconditions at the workshop→dispatch boundary), `work-package` (per-unit verification derived from these criteria)*
