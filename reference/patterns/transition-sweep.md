# Pattern: transition-sweep

**What:** A transition's definition-of-done includes its doc trail — when a subsystem is retired, renamed, or replaced, sweep the corpus for the outgoing vocabulary and disposition every hit *at transition time*, not as a follow-up.

**When to use:** Any retirement, rename, or replacement of a subsystem, tool, convention, or vocabulary — as part of the transition quest itself.

## The Sweep

1. **Grep the corpus** for the outgoing vocabulary: memory files, outputs, every CLAUDE.md, `.claude/rules/`, skills, KB. Search the bare token; both slash styles for paths.
2. **Inventory config that *served* the retired system** — hooks, settings, cron jobs, env vars. Grep is necessary, not sufficient: serving config rarely names its master (the dispatch-era `WorktreeCreate` hooks never said "dispatch"; they sat dormant four months, then broke worktree isolation in six repos).
3. **Disposition each hit:**
   - **Fix** it if the doc is live
   - **Banner** it if it's a historical record ("superseded by X, date") — for a KB-indexed doc, `kb_supersede` writes the file banner, marker columns, and ledger event in one call (detail: observatory `docs/KB-SUPERSESSION.md`)
   - **Archive** it if its job is done — after checking sibling pointers
4. **At transition time, as part of the transition quest.** Thirty minutes at the event replaces a corpus-wide audit campaign later.

## Why

Documentation drift in this workspace is event-shaped, not time-shaped. Every major transition of Feb–Jul 2026 left a vocabulary trail describing a dead reality while presenting as current; the code was cleaned every time, the doc trail never (evidence: `data/outputs/projects/architecture/_SYNTHESIS.md`, 2026-07-01).

## Execution Feedback

*(Append results here)*

---
*Source: DOCTRINE.md → Externalized Intent → Transition Sweep — pushed down 2026-08-13 (quest 3ad4a77a); the principle stays in DOCTRINE, the procedure lives here.*
*See also: `correct-the-carrier`, `campaign-closeout`, `corrections-loop`*
