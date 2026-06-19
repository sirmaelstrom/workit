# Pattern: test-first-spec

**What:** Define how you'll verify something works *before* specifying how to build it. If you can't describe verification, you haven't specified the thing yet.

**When to use:** Every work package. Every feature. The verification criteria are part of the specification, not an afterthought.

## The Principle

> "If you can't describe how to verify something, you haven't specified it yet."

This isn't TDD (though it's compatible). It's about **specification through testability**. The act of writing the verification forces you to be precise about what "done" actually means.

## The Independent Observer Test

> Could someone who has never seen this project verify the output using only what's written in the spec, without asking you a single question?

This is the foundational context test. If your verification criteria require knowledge that isn't in the spec, you have two choices:
1. Add the knowledge to the spec
2. Simplify the criteria until they're self-contained

**The conciseness discipline:** Write three sentences that an independent observer could use to verify the output. If you can't write those three sentences, you don't understand the task well enough to delegate it. If you need more than three sentences, your acceptance criteria might be too complex for a single work package.

This test also reveals when *you* aren't ready to delegate. That's a valid and valuable signal — come back when you can articulate done.

## Verification Hierarchy

From strongest to weakest:

1. **Automated test** — `npm test` passes, specific test file covers the behavior
2. **Build/compile check** — `npm run build` succeeds with zero errors
3. **CLI command** — `curl localhost:3000/api/health` returns 200
4. **Playwright verification** — Screenshot comparison, UI state assertion
5. **Manual observation** — "Open the page, click X, see Y" (weakest — use only when automation isn't practical)

## In Practice

Each work package's Verification field should specify:
- **What to run** — exact command or action
- **What success looks like** — exact output, status code, or observable state
- **What failure looks like** — so the agent knows when to stop (connects to failure criteria)

Bad: "Verify the component renders correctly"
Good: "Run `npm test -- --grep 'DispatchForm'`. All tests pass. The form renders with project selector, spec browser, and submit button."

## Visual Verification

For UI work, Playwright screenshots are mandatory:
- Organized in `./outputs/verification/{project}/{date}/`
- Taken at key states (empty, loaded, error, interaction result)
- Named descriptively: `dispatch-form-empty.png`, `dispatch-form-with-spec.png`

## The Development Pipeline Connection

From the development pipeline spec: **tests are defined BEFORE implementation begins.** The gate between planning and execution is: "Are all verification criteria written and concrete?"

This isn't bureaucracy — it's the discipline that makes wave execution and auto-approval possible. You can't auto-approve a dispatch if you can't automatically verify the result.

## Execution Feedback

**2026-03-01 — campaign-recovery-observability (post-hoc application):**

Applied test-first-spec retrospectively to 9 WPs that had been written from the bridge-decomposition model. Every WP had `tsc --noEmit` + `vitest run` as verification (necessary but not sufficient). None specified test files in Expected Files. Three WPs (01, 02, 03) added pure functions with clear inputs/outputs — directly testable with unit tests, but no tests were called for.

**Practice norm surfaced:** If a work package adds a function with clear inputs and outputs, a `.test.ts` file belongs in Expected Files with specific test cases. The verification hierarchy in this pattern says automated tests are strongest (Level 1) — but the work-package pattern's Verification field doesn't prompt authors to reach for Level 1. The gap is between the two patterns: test-first-spec says *prefer* automated tests, but work-package doesn't *require* the author to justify why they aren't using them.

**Fix:** When writing the Verification field for a work package, ask: "Is there a pure function in this WP that could have a `.test.ts` file?" If yes, add the test file to Expected Files and specify the test cases. If no (the WP is primarily integration/wiring), document why manual verification is the right level and label it as a post-wave gate check, not a per-WP assertion.

---
*Source: spec-driven-engineering-guide.md, development-pipeline-spec.md*
*Independent observer test influenced by: Nate B. Jones specification primitives*
*Cross-cutting discipline — governs how verification is written throughout the pipeline*
*Pipeline stage where this discipline is applied: `verification-criteria` (between decisions and constraints)*
*See also: `spec-engineering`, `work-package`, `verification-criteria`, `evaluation-loop`, `constraint-architecture`*
