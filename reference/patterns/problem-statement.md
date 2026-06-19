# Pattern: problem-statement

**What:** The discipline of stating a problem completely enough that it's plausibly solvable without the solver going out for more information. This is Phase 0 — before spec structure, before work packages, before any of it.

**When to use:** At the very beginning of any initiative. When an idea first crystallizes enough to say out loud. This is the *capture* step — it doesn't require finishing. A good problem statement can sit for days or weeks until the moment is right.

## The Self-Containment Test

> Can you state this problem with enough context that someone who has never seen your project, doesn't know your conventions, and has no access to anything other than what you've written could plausibly begin solving it?

If not, what's missing? That missing context is where your hidden assumptions live.

## The Rewrite Exercise

Take the conversational version of the idea:
> "We need to fix how dispatches handle failures"

Rewrite it as if the reader knows nothing:
> "The dispatch system (a backend service) queues AI agent tasks and runs them in git worktrees. When a dispatch fails — agent error, timeout, or scope violation — the system records the failure status but doesn't capture enough information to diagnose *why* it failed or feed that signal back into future dispatch decisions. The operator has to manually inspect logs and agent output. We need the system to capture structured failure data (failure type, last N chars of output, files touched vs. files specified) and surface it in a way that informs both immediate debugging and long-term pattern recognition."

The second version surfaces: what system, what "failure" means specifically, what data is missing, what the data would be used for. All of that was implicit in the first version.

## What This Is NOT

- **Not a spec.** No work packages, no file paths, no verification criteria. That comes later.
- **Not a solution.** Describe the problem and the shape of what "solved" looks like. Don't prescribe how.
- **Not final.** Problem statements evolve. The first version is a stake in the ground. Refinement happens through conversation, through `decision-resolution`, through working on adjacent things that reveal new angles.

## Structure (Lightweight)

```markdown
# Problem: {short title}
**Status:** Captured | Refining | Ready for Spec
**Project:** {name} (or "uncertain" — that's fine at this stage)

## The Problem
{Self-contained description. 1-3 paragraphs.}

## What "Solved" Looks Like
{Not acceptance criteria — that's spec-level. Just the shape of the outcome.}

## Hidden Assumptions Surfaced
{Things you realized you were assuming when you did the self-containment test.}

## Open Questions
{What you don't know yet. These don't block capture — they guide refinement.}
```

## Ground It Before You Write It

Before writing a problem statement for a codebase change, explore the actual implementation. Your mental model of how something works diverges from reality faster than you think — especially in a system that's being modified by agents between your sessions.

A 5-minute exploration that traces the real code paths prevents a spec built on wrong assumptions. The problem statement doesn't need to contain code, but it should be *informed by* code. "The handoff payload is too large" is a guess. "The handoff payload carries 12 fields, 8 of which are never read by any consumer" is grounded — and it leads to a completely different spec.

**Practical:** When the problem involves existing code, spin up explore agents to map the relevant paths *before* writing the problem statement. The exploration isn't part of the statement — it's the fieldwork that makes the statement trustworthy.

## Why This Matters for Momentum

A problem statement is a **micro-closure**. The idea is no longer floating in your head — it's captured, it has a status, it can be picked up when the moment is right. You don't have to finish it now. You don't even have to know which project it belongs to yet. The act of writing it down frees cognitive space without losing the thread.

This is the entry point to the workspace model — a problem statement can sit alone, and artifacts accumulate around it as thinking develops.

## Execution Feedback

*(Append results here)*

---
*Template: `templates/problem-statement.template.md`*
*Influenced by: Toby Lütke's self-containment principle, Nate B. Jones specification primitives*
*Pipeline: (first in pipeline) | → `decision-resolution`, `constraint-architecture`*
*See also: `spec-engineering`*
