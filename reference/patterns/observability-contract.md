# Pattern: observability-contract

**What:** Every boundary where work crosses from one autonomous agent to another (or from human to agent) must define three things: what goes in, what comes out, and how you know it's working while it runs. If a boundary lacks any of the three, it's opaque — and opaque boundaries are where failures hide.

**When to use:** Any automation boundary — dispatch handoff, agent-to-agent delegation, API integration, pipeline stage transitions, campaign wave boundaries.

## The Three Components

| Component | Question It Answers | Example (Dispatch) |
|---|---|---|
| **Precondition** | What must be true before work crosses this boundary? | Work package has verification criteria, expected files, failure criteria. Spec scored ≥70. |
| **Postcondition** | What must be true after work completes for it to count as success? | All expected files exist. `tsc --noEmit` passes. Tests pass. Verification steps produce expected output. |
| **Runtime Invariant** | How do you know the system is working (or failing) *while it runs*, not just after? | Turn budget consumption rate. Structured output at each step. Heartbeat/progress signals. |

The precondition and postcondition are the *contract*. The runtime invariant is the *observability*. You need both — a contract without observability is a promise you can't monitor; observability without a contract is telemetry with no success criteria.

## Why This Matters for Agentic Systems

Traditional software has narrow, typed interfaces — the compiler enforces the contract. Agentic boundaries are wide and fuzzy: natural language specs in, code artifacts out, with an LLM doing unobservable reasoning in between. The wider the boundary, the more critical the contract becomes, because you can't inspect the internals.

This is exactly Bertrand Meyer's **Design by Contract** (1986) applied to a new substrate:
- Preconditions → what the *caller* guarantees (spec quality, context completeness)
- Postconditions → what the *callee* guarantees (output correctness, artifact completeness)
- Invariants → what must remain true throughout (turn budget, no unauthorized side effects)

The classical version was enforced by the type system. The agentic version is enforced by **evaluation** — which is why `test-first-spec` and `evaluation-loop` are the enforcement mechanisms for this pattern.

## The Boundaries in Our System

| Boundary | Precondition | Postcondition | Runtime Invariant |
|---|---|---|---|
| **Human → Workshop** | Problem statement captures intent | Spec scores ≥70 on scorecard | Gate progression (each stage produces artifact) |
| **Workshop → Dispatch** | Decomposition complete, WPs have verification | All WPs execute successfully | Wave progress, per-WP pass/fail |
| **Dispatch → Agent** | WP spec + codebase context + failure criteria | Expected files modified, verification passes | Turn count, structured output per step |
| **Agent → Review** | Code changes committed, tests pass | Review findings synthesized, amendments applied | Reviewer progress (3 lenses → synthesis → adversarial) |
| **Review → Human** | Consolidated findings with severity ratings | Human approves/rejects/amends | N/A (human is the terminal observer) |

## The Failure Mode This Prevents

Without an observability contract, failures are **discovered**, not **detected**. You find out dispatch failed when you check back 20 minutes later. You find out the spec was underspecified when the agent produces garbage. You find out the review missed something when a bug hits production.

With an observability contract, failures are **surfaced at the boundary** — the precondition catches bad input before work starts, the runtime invariant catches divergence while work runs, and the postcondition catches incomplete output before it propagates.

The cost of a boundary failure compounds with distance from the boundary. Catching a bad spec at the workshop gate costs minutes. Catching it after dispatch costs an entire campaign wave. Catching it in production costs trust.

## Designing a New Boundary

When introducing any new automation boundary, answer these three questions before building:

1. **What's the precondition?** — What must the upstream system guarantee? Write it as a checklist. If you can't write the checklist, you don't understand the boundary.
2. **What's the postcondition?** — What will you verify after completion? This connects directly to `test-first-spec` — if you can't describe verification, you haven't specified the boundary.
3. **What's the runtime invariant?** — What signal will you monitor during execution? Budget consumption, progress callbacks, structured intermediate output. If the answer is "nothing — we wait and check," that's a red flag.

## Relationship to Other Patterns

- **`test-first-spec`** — Defines the postcondition. The verification criteria in a work package *are* the postcondition of the dispatch→agent boundary.
- **`trust-ramp`** — Evaluates contract fulfillment over time. A system that consistently meets its postconditions earns higher trust. One that violates them gets demoted.
- **`constraint-architecture`** — Preconditions are a subset of constraints. The "must" constraints in a spec are preconditions the human guarantees to the agent.
- **`evaluation-loop`** — The feedback mechanism that tells you whether contracts are well-calibrated. If postconditions pass but output quality is low, the contract is too loose.
- **`wave-execution`** — Turn budgets and per-WP monitoring are runtime invariants for the dispatch→agent boundary.
- **`corrections-loop`** — When a contract fails, the correction gets logged. Over time, corrections reveal which boundaries have weak contracts.

## Classical Lineage

This pattern rediscovers principles that are 40 years old, applied to a new execution substrate:

| Classical Concept | Agentic Equivalent |
|---|---|
| Design by Contract (Meyer, 1986) | Observability contracts at automation boundaries |
| Property-based testing | Evaluation loops with LLM-as-judge |
| Stage gates (project management) | Workshop gates with artifact requirements |
| Circuit breakers (distributed systems) | Turn budgets, failure criteria, trust demotion |

Naming the lineage matters — not for academic credibility, but because it makes the pattern *teachable*. When someone asks "why do you structure specs this way?" the answer isn't "we invented something new." It's "we're applying proven engineering discipline to a boundary type that didn't exist five years ago."

## Execution Feedback

*(Append results here)*

---
*Source: enterprise drilldown case study (2026-03-04) — 7-10x compression, zero functional defects. The observability contract was implicit in the spec structure; this pattern makes it explicit.*
*Cross-cutting discipline — governs how automation boundaries are designed across all projects*
*See also: `test-first-spec`, `trust-ramp`, `constraint-architecture`, `evaluation-loop`, `wave-execution`, `corrections-loop`*
