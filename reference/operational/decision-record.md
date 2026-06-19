---
name: Decision Record
description: Lightweight decision record (ADR) that couples each decision to the conditions that would reverse it.
tags: [decision, adr, doctrine, governance]
variables:
  number:
    label: Number
    placeholder: "Sequential id, e.g. 003"
  title:
    label: Title
    placeholder: "Short imperative title, e.g. 'SQLite over JSONL'"
  date:
    label: Date
    placeholder: "YYYY-MM-DD"
  decision:
    label: Decision
    placeholder: "1–2 sentence statement of what was decided"
  why:
    label: Why
    placeholder: "Bulleted justification — the reasons that make this the right call now"
  what_would_change:
    label: What Would Change This
    placeholder: "The conditions/triggers that would reopen or reverse this decision"
---

# {{number}}: {{title}}

**Date:** {{date}}
**Status:** Accepted

## Decision
{{decision}}

## Why
{{why}}

## What Would Change This
{{what_would_change}}

---

## How to use this

Drop one numbered file per decision into a `decisions/` directory at the project root (`001-…md`, `002-…md`, …). Keep each record short — a decision plus its justification plus its exit conditions, nothing more.

**The load-bearing section is "What Would Change This."** Most decision logs capture *what* was decided and *why*; few capture the conditions under which the decision should be **reopened**. Without it, decisions silently calcify — a constraint that made sense at 100 records is still assumed at 100M, and nobody revisits it because nobody wrote down the trigger. Coupling each decision to its reversal conditions makes the log a living guardrail a future agent (or you, six months on) can act on: when a trigger fires, the record tells you to reconsider, and what alternative was already in view.

Write the triggers as observable conditions, not vibes — "concurrent writers appear" / "data exceeds ~10 GB" / "this dependency drops the API we rely on", not "if it stops feeling right". A good trigger is something a check could detect.

Keep records append-only. If a decision is reversed, write a new record that supersedes it (and reference the old number) rather than editing history — the trail of *why it changed* is itself worth keeping.
