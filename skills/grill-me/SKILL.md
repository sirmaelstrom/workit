---
name: grill-me
description: "Stress-test a plan or idea. Trigger: 'grill me', 'poke holes', 'what am I missing', or wanting to pressure-test before committing to a spec."
---

# Grill Me — Stress-Test an Idea

Interview me relentlessly about every aspect of this plan until we reach a shared understanding.

## Rounds

Model the open questions as a dependency graph: a question is **blocked** when its best framing depends on an answer we don't have yet, **unblocked** otherwise. Then, each round:

1. Ask **only the questions unblocked right now** — never one whose framing depends on an unanswered question.
2. Batch them into a numbered round (Q1, Q2, …). For each question, provide your recommended answer — don't just ask, bring an opinion.
3. When the answers land, push the frontier: newly unblocked questions form the next round.

I can answer by number — "Q1 agree, Q2 agree, Q3 change to X" — so a round of easy questions costs one turn, not five.

The graph rule is what makes batching safe: batching without it asks dependent questions out of order, which is the problem asking one-at-a-time was avoiding.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

If a question can be answered by searching the knowledge base, search it — prior work may already have answers.

## When to stop

Stop when every branch of the decision tree is either:
- **Resolved** — we agreed on an answer
- **Explicitly deferred** — we agreed it's out of scope or future work
- **Flagged as a risk** — we identified it but can't resolve it now

Summarize what was resolved, what was deferred, and what risks remain.

## Connection to workshops

If the grilling reveals enough structure and the user wants to proceed, suggest transitioning to `/spec` (depth auto-selects) to formalize it. The grilling output becomes input to the problem statement.

When the effort is too foggy and too large for one interview, run `/chart` first — it schedules `grill-me` sessions rather than replacing them.

---
*Inspired by Matt Pocock's grill-me skill; dependency-graph rounds from his v1.2. Adapted with KB integration and workshop pipeline connection.*
*Source: github.com/mattpocock/skills/tree/main/grill-me*
