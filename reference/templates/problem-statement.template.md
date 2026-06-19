# Problem Statement: {Short Title}

<!-- Template based on the problem-statement pattern (patterns/problem-statement.md).
     The self-containment test: could someone who has never seen your project,
     doesn't know your conventions, and has no access to anything other than
     what you've written plausibly begin solving this?

     Ground it before you write it: explore the actual code paths before writing.
     Your mental model diverges from reality faster than you think. -->

## What We're Solving

<!-- Self-contained description of the problem. 1-3 paragraphs.
     Name the system, the project, the specific behavior that's wrong or missing.
     Don't assume the reader has context. The rewrite exercise:
       BAD:  "We need to fix how dispatches handle failures"
       GOOD: "The dispatch service queues AI agent tasks and runs
              them in git worktrees. When a dispatch fails, the system records
              the failure status but doesn't capture enough information to
              diagnose *why* it failed..." -->

{Description of the problem with enough context that a stranger could understand it.}

## Current State

<!-- What exists today. How does the system currently handle this?
     Be specific — reference files, functions, data flows.
     This section grounds the problem in reality, not assumptions. -->

{What the system does now. Concrete details.}

## What "Solved" Looks Like

<!-- Not acceptance criteria (that's spec-level). The shape of the outcome.
     What would the operator see/experience if this were fixed?
     What would be true that isn't true today? -->

{Description of the desired end state.}

## What's Actually Broken

<!-- The specific failures, in order of impact.
     Each should be a concrete, testable claim — not a vague concern.
     Number them. This list often becomes the seed for work package decomposition. -->

### 1. {First broken thing}

{Why it's broken, what the impact is.}

### 2. {Second broken thing}

{Why it's broken, what the impact is.}

## Hidden Assumptions Surfaced

<!-- Things you realized you were assuming when you did the self-containment test.
     These are often the most valuable part of the problem statement — they
     reveal the gaps between your mental model and reality. -->

- {Assumption you discovered was implicit}
- {Another assumption}

## Open Questions

<!-- What you don't know yet. These don't block capture — they guide refinement.
     They often become the seed for the decisions.md artifact. -->

- {Question that needs answering before spec work}
- {Another question}

## Scope

<!-- Optional but useful for larger problems. Helps prevent scope creep
     before specification even begins. -->

### Must Have
- {Core requirement}

### Won't Have (This Iteration)
- {Explicitly out of scope}

---
*Status: Captured*
*Project: {project-name}*
*Related: {links to related workshops, design docs, or prior work}*
