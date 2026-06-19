# Pattern: constraint-discovery

**What:** The practice of explicitly surfacing, articulating, and encoding domain constraints during triage, implementation, and review — so that "no" compounds instead of evaporating. Governs the lifecycle: discover → articulate → encode → search → validate.

**When to use:** During any structured analysis of unfamiliar or complex code. During triage. During post-mortems. During code review when you catch something that wasn't in the spec. Any time you say "this is wrong and here's why" or "this works differently than expected."

**Status:** New. Captures a practice that's been happening informally (triage analysis, code review discoveries, incident investigation) but without a durable encoding mechanism. The constraint-architecture pattern defines the *categories* of constraints in a spec. This pattern defines how constraints are *discovered, encoded, and reused* across the lifecycle.

## The Problem

Every time a developer analyzes a codebase area — during triage, code review, debugging, or incident response — they discover constraints that didn't exist in explicit form before. Business rules, calling patterns, null-handling behaviors, calculation dependencies, deprecated-vs-current pattern disambiguation.

Right now, those discoveries evaporate. They live in:
- Ticket comments nobody reads twice
- Slack threads that scroll away
- Code review notes attached to a merged PR
- Someone's head

The same discovery gets made again next quarter when someone else touches that area. The same "no" gets said again. The organization pays for the same understanding repeatedly.

## Why Rejections Are Knowledge Creation Events

When a domain expert looks at AI output (or a spec, or a ticket) and says "no, this is wrong because X" — the "because X" is a constraint that wasn't explicit before. Three things happened:

1. **Recognition** — they detected something was wrong. This depends on domain experience and can't be shortcut.
2. **Articulation** — they explained *why* in terms that produce a usable constraint. "This isn't right" is a rejection. "This isn't right because DSCR calculations use these five fields and null handling differs between v2 and legacy" is a constraint.
3. **Encoding** — they made the constraint persist beyond the moment.

Most people do 1 and 2. Almost nobody does 3 durably. The constraint lives in the conversation where it was articulated and dies there.

## The Three-Layer Architecture

### Layer 1: Project Constraints (project-level)

Specific to *this* codebase, *this* domain, *this* set of business rules. Lives in the project repo.

**Location:** `CONSTRAINTS.md` at project root, or `constraints/` directory organized by subsystem for larger projects.

**Format:**
```markdown
## {subsystem} / {area}

- [{date}] {Constraint description — specific, actionable, explains WHY}
  Source: {triage / code-review / incident / post-mortem}

- [{date}] {Another constraint}
  Source: {source}
```

**Examples:**
- `[2026-03-12] When modifying vessel assignment, recalculation cascades through: freight-calc → demurrage → P&L. All three consumers must be checked. Source: triage`
- `[2026-03-12] CalcDSCR_v2 treats null inputs as zero; CalcDSCR_legacy throws. Five calling patterns exist; only pattern B (parameterized with explicit null check) is current. Source: triage`
- `[2026-03-15] The billing summary proc is called by 4 pages and 2 scheduled jobs. Changing the output column order breaks the scheduled jobs silently (they index by position, not name). Source: incident`

**What belongs here:**
- Business logic that isn't obvious from reading the code
- Calling patterns and consumer maps for shared procs/functions
- Pattern disambiguation (which of N approaches is current)
- Null handling, edge cases, calculation dependencies
- Things that broke and why — the "war stories" that prevent recurrence

**What doesn't belong here:**
- General coding style preferences → CLAUDE.md
- Agent-specific mistakes → `corrections-loop` / CLAUDE.md
- Universal cross-project patterns → Layer 2 (pattern library)

### Layer 2: Pattern Library Constraints (cross-project)

Universal truths about how AI-assisted development works, regardless of project. These live in the pattern library.

Already partially exists:
- `constraint-architecture.md` has the consumer audit constraint (data structure changes must trace read paths)
- `corrections-loop.md` has the graduation rule (same mistake in 2+ projects → global)

**Graduation path:** When a project-level constraint recurs across 2+ projects, it's not project-specific. Extract the general principle and add it to the relevant pattern, or create a new pattern if it represents a new category.

**Examples of cross-project constraints:**
- "When a work package changes a data structure, the spec MUST trace all read paths" (already encoded)
- "Keep research separate from implementation intent — ticket context contaminates analysis"
- "Vertical implementation order (tracer bullets) produces more reliable results than horizontal (layer-by-layer)"
- "Surface competing patterns and disambiguate during research, not during implementation"

### Layer 3: Post-Mortem Constraint Assessment (feedback loop)

After work ships, explicitly assess constraint quality. This is a new section in the post-mortem template (see addition to `campaign-closeout`).

Four questions:
1. **Which constraints held?** — Correctly prevented a failure mode.
2. **Which constraints were missed?** — Would have prevented an issue if specified upfront.
3. **Which constraints were wrong?** — Over-constrained, caused unnecessary friction.
4. **What new domain knowledge was discovered?** — Learned during this work, applicable beyond this ticket.

Each missed or discovered constraint gets routed to its encoding destination (project CONSTRAINTS.md, pattern library, CLAUDE.md).

## The Lifecycle

```
1. SEARCH — Before starting work, search for existing constraints in this area
   └─ kb_search, grep CONSTRAINTS.md, check CLAUDE.md corrections

2. DISCOVER — During research/triage, surface new constraints
   └─ Map calling patterns, identify edge cases, disambiguate patterns

3. ARTICULATE — State constraints precisely enough to be reusable
   └─ Not "this is tricky" → "this proc has 3 calling patterns, only B is current because..."

4. ENCODE — Write constraints to a durable, searchable location
   └─ Project CONSTRAINTS.md, CLAUDE.md, pattern library (by scope)

5. VALIDATE — After work ships, assess constraint quality in post-mortem
   └─ What held, what was missed, what was overconstrained, what's new
   └─ Route new discoveries back to step 4
```

## Integration with Existing Patterns

- **`constraint-architecture`** — Defines the *categories* (musts, must-nots, preferences, escalation triggers). This pattern defines the *lifecycle* (discover, encode, search, validate). Complementary, not overlapping.
- **`corrections-loop`** — Handles agent *mistakes* (wrong API, deprecated pattern). This pattern handles *domain knowledge* (business rules, calling patterns, edge cases). Different scope: corrections are about AI behavior, constraints are about the domain.
- **`evaluation-loop`** — Assesses output *quality*. This pattern assesses constraint *completeness*. Evaluation asks "was the output good?" Constraint discovery asks "did we know enough to specify good?"
- **`campaign-closeout`** — The Constraint Assessment section in the post-mortem template is the Layer 3 mechanism. Closeout feeds findings back to constraints.

## Building a Constraint Culture

The hardest part isn't the format or the tooling — it's the habit. Three practices:

1. **Search before you spec.** Make it standard practice to check existing constraints in an area before writing a new spec. Agents should do this as part of the research phase. This is what makes previously encoded "no"s compound.

2. **Articulate, don't just reject.** When you say "no" to AI output or find an issue in review, take 30 seconds to state *why* in terms someone unfamiliar with the area could understand. That's the constraint. Write it down.

3. **Assess constraints in retrospectives.** The post-mortem Constraint Assessment isn't busywork — it's the mechanism that surfaces whether our specifications are getting better or we're making the same discoveries repeatedly.

## Execution Feedback

*(Append results here)*

---
*Source: Nate B. Jones "rejection as knowledge creation" framework, enterprise triage experience, campaign post-mortem analysis*
*Cross-cutting discipline — governs constraint lifecycle across all work*
*Pipeline: Operates alongside `constraint-architecture` (categories) and `evaluation-loop` (quality)*
*See also: `constraint-architecture`, `corrections-loop`, `evaluation-loop`, `campaign-closeout`, `spec-engineering`*
