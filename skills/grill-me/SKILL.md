---
name: grill-me
description: "Stress-test a plan or idea. Trigger: 'grill me', 'poke holes', 'what am I missing', or wanting to pressure-test before committing to a spec."
---

# Grill Me — Stress-Test an Idea

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one.

For each question, provide your recommended answer — don't just ask, bring an opinion.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

If a question can be answered by searching the knowledge base, search it — prior work may already have answers.

## When to stop

Stop when every branch of the decision tree is either:
- **Resolved** — we agreed on an answer
- **Explicitly deferred** — we agreed it's out of scope or future work
- **Flagged as a risk** — we identified it but can't resolve it now

Summarize what was resolved, what was deferred, and what risks remain.

## Connection to workshops

If the grilling reveals enough structure and the user wants to proceed, suggest transitioning to `/workshop` to formalize it. The grilling output becomes input to the problem statement.

---
*Inspired by Matt Pocock's grill-me skill. Adapted with KB integration and workshop pipeline connection.*
*Source: github.com/mattpocock/skills/tree/main/grill-me*
