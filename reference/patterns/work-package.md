# Pattern: work-package

**What:** The atomic unit of a spec. Each work package is one independently committable — and independently *dispatchable* — chunk of work with clear boundaries.

**When to use:** Inside any spec that has more than one logical step. Every work package follows this structure.

## The 6 Required Fields

1. **Precondition** — What must be true before starting this package. May reference prior packages or external state.
2. **Goal** — What this package accomplishes. One clear statement.
3. **Files** — Exact paths. Create, modify, or delete. Nothing else gets touched.
4. **Verification** — Concrete command or check proving it works. Not "it should work" — a specific test, build command, or observable behavior.
5. **Failure Criteria** — "If X happens, the problem is Y." Gives the agent (or reviewer) diagnostic footholds.
6. **Boundary** — What is explicitly OUT OF SCOPE for this package. Prevents drift.
7. **Commit** — Conventional commit message. Forces you to name what changed.

## File-Per-Package Structure

Work packages live as **individual files** in a `work-packages/` directory within the workshop, not as sections of a monolith document.

```
workshop-slug/
  meta.json
  problem-statement.md
  decisions.md
  verification.md
  constraints.md
  decomposition.md
  work-packages/
    _orchestrator.md          ← wave plan, dependency graph, spec-level constraints
    wp-01-types.md            ← self-contained, independently dispatchable
    wp-03-backend-api.md
    wp-10-filesystem-watching.md
    ...
  reviews/
    review-1/                 ← spec review (pre-dispatch)
      reviewer-prompt.md
      review-lens-a.md
      review-lens-b.md
      review-1-synthesis.md
    review-2/                 ← code review (post-dispatch), or additional spec round
      ...
```

The `reviews/` directory holds numbered review rounds. Minimum 2 per workshop: one for specs (pre-dispatch) and one for code (post-dispatch). Additional rounds are added as needed — e.g., if spec amendments are substantial enough to warrant re-review. Each round contains its reviewer prompt, individual model outputs, and a synthesis.

### Why files, not sections

- **Token efficiency.** A dispatch agent reads its own file (~3-5KB) plus the orchestrator (~2-3KB), not a 50-100KB monolith containing 11 packages it doesn't need.
- **Parallel dispatch.** Within a wave, each package dispatches independently. No coordination beyond the orchestrator's dependency rules.
- **Incremental hardening.** Tighten WP-01 without touching WP-06. Each file evolves on its own timeline.
- **Natural dispatch input.** The work package file *is* the spec path passed to dispatch. No "find section X in the document."
- **Workshop surface integration.** The artifact list shows each work package as a clickable item. Select it, dispatch it.

### The Orchestrator (`_orchestrator.md`)

The orchestrator is not a work package — it's the coordination layer. It contains:

1. **Wave plan** — which packages execute in which order, with a mermaid dependency graph.
2. **Spec-level constraints** — musts, must-nots, preferences, escalation triggers that apply to ALL packages (from `constraint-architecture` pattern). Each work package file references the orchestrator for these.
3. **Cross-cutting verification** — checks that apply after any package (e.g., `tsc --noEmit` must pass after every package in the wave).
4. **Dispatch strategy** — how to group packages for dispatch (per-package, per-wave, per-project).

The underscore prefix (`_orchestrator.md`) sorts it first in directory listings and distinguishes it from dispatchable work packages.

### Orchestrator Format — Coordination Sections

The orchestrator has three structured sections that execution agents and `spec-validate` rely on. Format matters.

> **File location is load-bearing.** The orchestrator MUST live at `work-packages/_orchestrator.md` — not at the workshop root. The workshop directory is derived from `dirname(dirname(orchestratorPath))`. An orchestrator at the workshop root will cause tools to look for `meta.json` and spec files in the wrong directory, failing silently or with confusing path errors. A template is available at `templates/_orchestrator.template.md` in this repo.

**`## Wave Plan`** — One line per wave, packages in square brackets:
```
Wave 1: [WP-01: Short Name] [WP-02: Another Name]
Wave 2: [WP-03: Third Name]
```
- The parser extracts package names from `[brackets]` and matches them to the inventory via `WP-NN` ID. Package names in brackets must contain a `WP-NN` substring.
- Wave numbers must be sequential starting from 1. Duplicate wave numbers fail validation — if two packages must be in the same wave, put them on the same line.
- Wave Plan lines must NOT be inside a fenced code block (` ``` `). The parser skips code block content. Bare lines only.

**`## Package Inventory`** — Markdown table, 4 required columns, optional 5th Model column:
```
| Package | Wave | Project | Spec | Model |
|---------|------|---------|------|-------|
| WP-01: Short Name | 1 | project-name | [wp-01-slug.md](wp-01-slug.md) | opus |
```
- Column 1 (Package): must contain `WP-NN` for cross-reference with wave plan
- Column 2 (Wave): integer wave number
- Column 3 (Project): the project name (e.g. `backend-service`, `web-frontend`)
- Column 4 (Spec): markdown link to the WP spec file (relative to `work-packages/`), or `-`/`N/A` for no spec
- Column 5 (Model, optional): claude model name for this WP (e.g. `opus`, `sonnet`). Use `-` or omit the column for system default.

**`## Gate Commands`** — One line per wave:
```
Wave 1: npx vitest run && npx tsc --noEmit
Wave 2: npx vitest run && npx tsc --noEmit
```
If omitted, defaults to `npx tsc --noEmit` per project. Gate commands must NOT contain absolute `cd` paths — the campaign runner sets `cwd` to the worktree automatically (see `wave-execution` for the war story).

**Everything else** (Campaign Metadata, wave descriptions, risk assessment, dependency graph) is for human readers. Title and slug come from `meta.json`, not the orchestrator.

### Work Package File Naming

Convention: `wp-{NN}-{slug}.md`

- `{NN}` is the package number (zero-padded to 2 digits), matching the decomposition order.
- `{slug}` is a brief kebab-case description.
- Numbers are NOT wave numbers — they're sequential identifiers from the decomposition. The orchestrator defines which wave each package belongs to.

Examples: `wp-01-types.md`, `wp-03-backend-api.md`, `wp-07-view-shell.md`

### Self-Containment Rule

Each work package file must be understandable by an agent that has read ONLY:
1. The orchestrator (for spec-level constraints, wave context, and progress log)
2. Its own file

It must NOT require reading other work package files. If a package depends on another package's output, the precondition field describes what that output is — it doesn't say "see WP-03 for details."

### Progress Log Lifecycle

The orchestrator contains a `## Progress Log` section — a running log of what each dispatch agent did, discovered, and noted for downstream packages. This is the campaign's institutional memory.

Every dispatch agent follows this lifecycle:
1. **Read** the progress log entries (in the orchestrator) at session start — learn what prior packages did and flagged
2. **Execute** the work package
3. **Append** a progress entry before finishing:

```markdown
### WP-{NN}: {Name} — {date}
**Outcome:** {success | partial | failed}
**What changed:** {brief summary of files modified and why}
**Surprises:** {anything unexpected — edge cases found, assumptions that were wrong, patterns worth noting}
**Notes for downstream:** {anything later packages should know — e.g., "the API shape changed from what the orchestrator assumed" or "test helper at X is useful for similar work"}
```

The progress log solves a specific failure mode: later packages starting cold without context from earlier packages. Wave 3 agents benefit from Wave 1 discoveries. Retry agents know what the first attempt tried. The log also feeds directly into `campaign-closeout` post-mortems — the timeline is already written.

## Code Specificity by Type

Different kinds of changes need different levels of detail:

- **UI Components:** Exact CSS classes, prop interface, event handlers — OR reference a component to clone
- **State Modules:** Reactive state shape, accessor signatures, message types
- **Bridge/API Handlers:** Message type, request/response shape, validation logic
- **Database:** Schema changes, migration SQL, rollback strategy

## Ordering

Dependencies flow forward. Package 3 can depend on 1 and 2, never on 4. If the agent gets stuck on Package 4, you still have Packages 1-3 committed and working.

## Persistence Specification

For each user action in a UI package, answer:
- Does it survive page refresh?
- Does it survive navigation?
- Does it survive session restart?
- Where is state stored?

Stating "does not persist — intentional" is just as important as specifying persistence.

## The Independent Observer Test

From `test-first-spec`: could someone who has never seen this project verify the output using only what's written in the work package file + orchestrator, without asking a single question?

If verification requires knowledge that isn't in the file, either:
1. Add it to the file
2. Simplify the criteria until they're self-contained

## Execution Feedback

**2026-03-19 — campaign-fifo-queue (a real campaign, scorecard 87/100):**

Two findings from scorecard deviation analysis:

1. **Queue/list operations need mutation-state guards.** When a work package implements CRUD for ordered collections (queues, lists, stacks), the spec must specify which item states allow which mutations. The campaign's `dequeueItem()` didn't specify that terminal-state items (completed/failed/cancelled) are audit records and shouldn't be removable. The agent allowed removal of any item — required a post-dispatch fix. **Practice:** For any WP with delete/remove/reorder operations, add a "Mutable states" section listing which statuses allow each operation.

2. **UI WPs that consume multiple data sources need a Display Composition section.** The campaign's web-frontend queue UI consumed both `QueueState` (position, status) and `WorkshopSuggestion` (title, projects) data. The spec described each source but not how they compose for display — the agent showed raw slugs instead of titles, and double-rendered the running item. **Practice:** For UI work packages that join data from multiple sources, add a "Display Composition" section specifying: which fields come from which source, how sources are joined (key field), and what the user sees for each state.

**2026-02-27 — workshop-surface:** First workshop to use file-per-package. Original monolith (work-packages.md, 55KB) was 12 packages in one file. Hardened Wave 1 (3 packages, 33KB) demonstrated that spec-engineering discipline makes monolith structure untenable — too large, too much irrelevant context per dispatch. Split to individual files resolved the size problem and aligned with dispatch mechanics (one file = one dispatch input).

**2026-03-01 — campaign-recovery-observability (verification audit):**

Verification fields had two distinct failure modes:

1. **Missing test files.** WPs adding pure functions (types with logic, git inspection utilities) specified `tsc + vitest` as verification but no test files. The gate commands (`npx vitest run`) would pass vacuously — no new tests to run. Fixed by adding `.test.ts` to Expected Files with specific test cases for WPs with testable functions.

2. **Integration tests labeled as per-WP verification.** WPs 04/05/06 described multi-step manual scenarios (start campaign → fail → recover) as their verification. These are valid checks, but they can't run in the automated gate — they require a running backend service and deliberate failure induction. Relabeled as "post-wave gate" checks to distinguish from what the gate command actually validates.

**Practice norm:** Verification should have two clearly labeled tiers:
- **Gate verification** — runs automatically in `## Gate Commands`. Must be a command that exits 0 on success.
- **Review verification** — checked by the human reviewer during `gate_mode: 'review'`. Manual integration scenarios, visual checks, DB inspection.

### Svelte 5 rune restrictions are invisible to tsc gate (a real campaign, 2026-04-06)
WP-03 spec exported `groupedResults` as `$derived.by(...)` directly from a `.svelte.ts` module. `tsc --noEmit` passes this. `svelte-check` and `vite build` reject it: "Cannot export derived state from a module." Both the dispatch agent and CLI independently hit this and fixed it the same way (wrap in accessor function). **Practice:** Gate commands for Svelte projects must use `npx svelte-check --tsconfig ./tsconfig.json`, not `tsc --noEmit`. `tsc` doesn't run Svelte-specific checks. Similarly, `{@const}` placement restrictions (must be direct child of `{#each}`/`{#if}`, not inside HTML elements) are invisible to `tsc`.

---
*Template: `templates/_orchestrator.template.md`*
*Source: spec-pipeline-layer1.md, phase1-dispatch-mvp-spec.md, workshop-surface hardening session*
*Pipeline: ← `decomposition`, `constraint-architecture` | → `wave-execution`*
*See also: `spec-engineering`, `test-first-spec`, `verification-criteria` (system-level criteria that WP verification fields are derived from)*
