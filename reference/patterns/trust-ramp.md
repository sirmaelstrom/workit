# Pattern: trust-ramp

**What:** Systems earn autonomy through empirical success. Start with full human oversight, graduate to auto-approval as track record builds. Demote on failure.

**When to use:** Any automated system that can take consequential actions — dispatch auto-approval, deployment pipelines, data mutations.

## Trust Levels

| Level | Threshold | Behavior |
|---|---|---|
| 0 (New) | 0-2 successes | Always require human confirmation |
| 1 (Proven) | 3-4 successes | Auto-approve trivial/small + high confidence |
| 2 (Trusted) | 5+ successes, <30% failure rate | Auto-approve anything with high confidence |

## Demotion Rules

- **2 consecutive failures** → drop one trust level
- Demotion is immediate; promotion requires sustained success
- The asymmetry is intentional — trust is expensive to build and cheap to lose

## Key Design Decisions

- **Conservative default on uncertainty:** If the classifier fails or returns low confidence, require confirmation regardless of trust level
- **Scope assessment is LLM-based, not heuristic:** A single Sonnet call (~600 tokens in, ~150 out) evaluates dispatchability, confidence, complexity, risk areas
- **Failure output:** On classifier failure, default to `dispatchable=true, confidence=low` → requires confirmation. Don't block work, but don't auto-approve either.

## The Principle

> Autonomy is earned, not granted. The system proves itself on small things before it's trusted with big things.

This applies beyond dispatch — it's a general pattern for any AI system taking real-world actions.

## Execution Feedback

*(Append results here)*

---
*Source: Phase 2 scope classifier spec, trust gate validation*
*Cross-cutting discipline — governs autonomy graduation for any automated system*
*See also: `constraint-architecture`, `corrections-loop`, `evaluation-loop`*
