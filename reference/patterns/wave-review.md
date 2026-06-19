# Pattern: wave-review

**What:** Multi-agent code review decomposed into waves with different focuses. Different context, focus, and mental models create coverage gaps — wave review fills them.

**When to use:** Reviewing complex changes, large PRs, or any work where a single review perspective isn't enough.

## Wave Structure

### Wave 1: Cartographer (1 agent)
- Examines all changes
- Maps the territory — what files changed, what patterns are used, what's the shape of the change
- Produces structured output that guides subsequent reviewers

### Wave 2: Focused Reviewers (parallel, typically 3)
- **Code Quality** — Style, patterns, maintainability, idiomatic usage
- **Security** — Auth, input validation, data exposure, injection vectors
- **Implementation Accuracy** — Does this actually do what the spec says? Are edge cases handled?

Each reviewer gets the Cartographer's map plus the actual changes.

### Wave 3: Adversarial + Synthesis
- **Adversarial Reviewer** — Focused on the weakest areas identified in Waves 1-2. Tries to break things.
- **Additional Focus** — Based on what earlier waves surfaced (e.g., if security reviewer flagged concerns, a deeper security dive)
- **Orchestrator/Synthesizer** — Combines all findings into a single coherent report with severity rankings

## Why It Works

Human review has blind spots shaped by familiarity. An engineer who wrote similar code sees it as "normal" even when it's problematic. Multiple independent reviewers with different lenses catch what no single reviewer would.

## Result

Tested on a Google → Exchange email service migration. Found several real problems that human review had missed — not because the human was wrong, but because coverage gaps exist in any single perspective.

## Execution Feedback

*(Append results here)*

---
*Source: LESSONS.md, wave-based review session notes*
*Execution pattern — post-dispatch code review*
*See also: `wave-execution`, `meta-prompt`, `review-council` (spec review equivalent)*
