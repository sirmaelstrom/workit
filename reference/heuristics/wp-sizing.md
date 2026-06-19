# Work Package Sizing Heuristics

*Derived from several real campaigns, March 2026.*

---

## Core Principle

The single most predictive variable for campaign success is the **complexity of the hardest WP**, not the total WP count.

- Campaign 4 (6 WPs, one very complex): 67% autonomous rate
- Campaign 5 (4 simple WPs): 100% autonomous rate, zero interventions

## Heuristics

### 1. One-Sentence Gate Test

If you can't describe the gate check in one sentence, the WP is too big.

- **Good:** "All tests pass"
- **Bad:** "The extracted functions work correctly and the old file no longer contains them and the imports are updated" — that's three concerns wearing a trenchcoat.

### 2. Single Concern

Successful WPs touch one file or one tightly-coupled set, make one behavioral change, and have one clear gate command. Troubled WPs bundled multiple concerns or required the agent to make judgment calls about scope boundaries mid-implementation.

### 3. Mechanical Over Creative

The best WPs are boring: extract this, move that, add this test. When a WP requires the agent to make design decisions, it's **underspecified**, not just large. Design decisions belong in the spec, not in the agent's hands.

### 4. Split Extractions by Unit

"Extract monolith JS into separate files" is N tasks, not one. Each function group or logical boundary is its own WP:

1. Pull function group X out into its own file
2. Update imports in the source file
3. Verify nothing broke

Boring. Mechanical. Perfect for an agent.

### 5. Wave Overhead Is Cheap, Rework Is Expensive

Adding a wave to accommodate smaller WPs costs minutes of sequencing. An oversized WP that produces messy output costs hours of debugging — and it's worse than debugging your own code because you're reverse-engineering AI decisions.

### 6. Without Harness, Size Even More Conservatively

When you have gates and campaigns catching problems, an oversized WP fails fast and you iterate. Without that safety net, oversized WPs just produce messy output you have to untangle manually. If you're running without the full dispatch harness (e.g., at work with just patterns), err further toward smaller packages.

## Application

When decomposing work, test each WP against these heuristics before finalizing the orchestrator. If a WP fails any of them, split it. The overhead of more WPs and waves is almost always less than the overhead of one bad WP that derails execution.

---
*Source: LESSONS.md, campaign post-mortem data*
