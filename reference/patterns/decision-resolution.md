# Pattern: decision-resolution

**What:** Systematically eliminate ambiguity AND evaluate the forcing cost of each option before marking a spec Ready. Every unresolved decision is a fork where two agents would produce different output. Every resolved decision has a cost that compounds — and the cheaper option isn't always obvious without analysis.

**When to use:** During spec refinement, before transitioning from Draft to Ready status.

## The Scan

Search the spec for these words — each is a flag:
- **"or"** — Two options means no decision. Pick one.
- **"possibly"** — Hedge language. Commit or cut.
- **"prefer"** / **"preferably"** — Soft preference isn't a decision. Make it a requirement or remove it.
- **"might"** / **"could"** / **"should consider"** — All flags for unresolved thinking.
- **"TBD"** / **"TODO"** — Obviously.

## Resolution Process

For each flag:
1. **Is this actually a decision?** Sometimes "or" is just English. "Create or modify the file" might be fine.
2. **If yes, what are the options?** List them explicitly.
3. **What are the tradeoffs?** Brief — one line each.
4. **Run the Option Forcing Table** (see below) — what does each option *require* beyond the code itself?
5. **Run the Change Cascade Analysis** (see below) — what's the blast radius of each option?
6. **Apply the Pragmatist Check** (see below) — is the simpler option being dismissed for the wrong reasons?
7. **Decide.** Document the choice and the reasoning.
8. **Remove the ambiguous language.** Replace with the decision.

## Option Forcing Table

For any decision with multiple viable approaches, fill in what each option **forces into existence**:

```markdown
| Dimension              | Option A                    | Option B                    |
|------------------------|-----------------------------|-----------------------------|
| Files changed          | 8 files across 3 modules    | 2 files in 1 module         |
| New tests required     | 12 (3 integration, 9 unit)  | 4 (all unit)                |
| New error paths        | 3 (timeout, retry, partial) | 1 (validation)              |
| Schema/API changes     | New DB column + migration   | None                        |
| Documentation updates  | API docs, CLAUDE.md         | None                        |
| Future maintenance     | New retry logic to maintain | Extends existing pattern    |
| Rollback complexity    | Migration reversal needed   | Revert single commit        |
| Event chain impact     | Triggers 2 downstream hooks | No downstream effects       |
```

**The principle:** Every option has a forcing cost — the work that *must exist* for the option to be correct, beyond the code that implements the feature. The option that forces less isn't always better, but you must **see** the forcing cost before choosing. When costs are similar, the option with lower forcing cost wins. When costs differ significantly, the higher-cost option needs an explicit justification for why the extra forcing is worth it.

**Anti-pattern:** Choosing the architecturally elegant option because it "feels right" without pricing out what it forces. Elegance is free in a design doc; it compounds in implementation.

## Change Cascade Analysis

For each option, trace what changes propagate beyond the immediate implementation:

### Event Chain Tracing
When option A modifies module X:
- What events does X emit? What listeners react to those events?
- What state changes cascade from those reactions?
- Do any of those cascading changes touch modules outside the spec's scope?

Map it explicitly:
```markdown
Option A cascade:
  handler.ts (modified) → emits 'task.completed' →
    metrics.ts (listener) — updates counters (safe, read-only) ✅
    notification.ts (listener) — sends Discord webhook (side effect!) ⚠️
    cache.ts (listener) — invalidates session cache (behavioral change) ⚠️

Option B cascade:
  handler.ts (modified) → no new events →
    (no downstream effects) ✅
```

### Change Surface Proportionality
Ask: **Is the change surface proportional to the problem being solved?**

- A 2-line bug fix that touches 8 files is disproportionate — something's wrong with the approach.
- A new feature that requires schema migration, API changes, and 3 consumer updates might be proportional — or might indicate an approach that's fighting the existing architecture.

When you find disproportionate change surface, that's a signal to look for a more minimal path, not necessarily to take it — but to price both paths explicitly.

## The Pragmatist Check

After filling the forcing table, apply this persona:

> **The Pragmatist asks:** "What's the minimum change that solves the stated problem correctly?"

This isn't "what's the laziest option" — it's "what's the option with the smallest blast radius that still meets all verification criteria."

The Pragmatist catches a specific failure mode: **complexity bias under low production cost.** When building is cheap (agentic velocity, AI-assisted development), the natural brake that used to favor simpler approaches disappears. You build the ambitious option because you *can*, not because you *should*. The Pragmatist is the replacement brake.

Concretely:
1. Can this be solved by extending an existing pattern rather than introducing a new one?
2. Can this be solved by changing behavior in one place rather than restructuring?
3. Does the more complex option provide benefits that are actually required by the verification criteria, or are they speculative future value?
4. If a senior engineer with no emotional investment picked an approach, would they pick yours?

**When the Pragmatist loses:** Sometimes the complex option IS correct — the simple path creates tech debt, the elegant path enables future work that's already planned, the minimal change is a band-aid on a structural problem. That's fine. But document *why* the Pragmatist's objection was overruled.

## Decision Log

For complex specs, maintain a decision log section:
```markdown
## Decisions
- **State storage:** Client-side reactive store, not server-persisted.
  Reason: no persistence requirement, simpler implementation.
  Pragmatist: ✅ agreed — server persistence would force migration + API changes for no user-facing benefit.

- **Event handling:** New event bus, not extending existing handler.
  Reason: existing handler is at capacity, mixing concerns.
  Pragmatist: ⚠️ overruled — extending existing handler was simpler (2 files vs 6) but would create a maintenance trap. Justified by planned phase 2 work that depends on clean event separation.
  Forcing cost: 4 additional files, new test suite, documentation update.
```

This serves three purposes: it documents *why* for future readers, it proves all decisions were made consciously, and it records whether the pragmatic option was considered.

## The Completeness Test

> A spec is Ready when a reasonable person reading it would make the same implementation choices you intend — without asking any clarifying questions.

If you hand the spec to someone and they'd need to ask "but which approach?" — it's not Ready.

## Execution Feedback

### Complexity bias under agentic velocity (2026-04-03)
Real-world enterprise case: a pipeline spec'd an A/B approach path. Spec author chose path A (more architecturally complete). An engineer independently chose path B (pragmatically minimal). Path B landed clean — fewer files touched, smaller blast radius, same functional outcome. Path A was defensible but path B was *better*. The forcing table would have surfaced this: path A forced new event handling, additional error paths, and consumer updates that path B avoided entirely. This incident motivated the Option Forcing Table, Change Cascade Analysis, and Pragmatist Check additions to this pattern.

**Root cause:** When production cost approaches zero (AI-assisted development), the natural cost brake that favors simpler approaches disappears. Specification must replace that brake explicitly, or complexity becomes the default.

---
*Source: spec-pipeline-layer1.md*
*Pipeline: ← `problem-statement` | → `verification-criteria`*
*See also: `spec-engineering`, `work-package`, `test-first-spec`, `constraint-architecture`, `decomposition`*
