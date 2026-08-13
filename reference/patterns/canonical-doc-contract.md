# Pattern: canonical-doc-contract

**What:** A canonical-presenting doc earns durability by *pointing at the source of truth, not copying its volatile values* — and carries an ownership header so a reader knows who keeps it true and as-of when.

**When to use:** Authoring or reviewing any doc that presents as canonical — architecture overviews, inventories, roster/config references, living indexes.

## The Contract

1. **Point, don't copy.** The facts that rot fastest — provider lists, model pricing, port maps, MCP inventories, directory listings, config defaults — are mechanically enumerable from code/config. A doc that inlines them decays at the value's update rate and counterfeits freshness (a recent "reconciled" date sitting over a stale table). A doc that points (`.claude/rules/*` scoped to the code, living indexes that link rather than restate) rides transitions untouched.
2. **Ownership header:** owner/owning-process, last-verified date, a supersession-pointer slot.
3. **Snapshot demotion:** where a doc's volatile sections *cannot* be pointers (a hand-drawn map, a synthesized overview), demote it to an explicitly dated **snapshot** ("as-of" banner) rather than letting it present as live truth. Regenerating those sections from source is the higher-cost fix, taken when the map class earns it.
4. **Backstop:** the scheduled `doc-health` beat flags the drift these conventions exist to prevent.

## Receipt

Council templates parameterized their roster and survived a full roster rework with zero edits; the hand-drawn architecture maps copied theirs and rotted. Same content class, opposite outcome — the variable is point-vs-copy.

## Execution Feedback

*(Append results here)*

---
*Source: DOCTRINE.md → Externalized Intent → Pointer, Not Value — pushed down 2026-08-13 (quest 3ad4a77a).*
*See also: `correct-the-carrier` (the repair when you find a copy gone stale), `transition-sweep`*
