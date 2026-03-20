---
name: spec
description: "Autonomously generate a complete workshop specification from a short intent description. Use when the user says '/spec', 'spec this', 'write a spec for', 'auto-spec', or describes a feature and wants a full specification without co-authoring each stage. This skill runs all 6 pipeline stages, pauses for human review after constraints, then completes decomposition and work packages."
---

# Spec — Autonomous Specification Pipeline

Generate a complete, dispatch-ready workshop specification from a short intent description. You run all 6 pipeline stages autonomously, pause once for human review, then finish.

## Workshop System Context

Workshops are the specification mechanism. Each workshop lives at `/workspace\data\outputs\workshops\{slug}\` and progresses through a 6-stage pipeline defined in the pattern library at `/workspace\projects\heathdev-patterns\`.

| Stage | Pattern File | Template | Output Artifact | meta.json status |
|-------|-------------|----------|-----------------|------------------|
| 1 | `patterns/problem-statement.md` | `templates/problem-statement.template.md` | `problem-statement.md` | `problem-statement` |
| 2 | `patterns/decision-resolution.md` | — | `decisions.md` | `decisions` |
| 3 | `patterns/verification-criteria.md` | — | `verification.md` | `verification` |
| 4 | `patterns/constraint-architecture.md` | — | `constraints.md` | `constraints` |
| 5 | `patterns/decomposition.md` | — | `decomposition.md` | `decomposition` |
| 6 | `patterns/work-package.md` | `templates/_orchestrator.template.md` | `work-packages/*.md` + `work-packages/_orchestrator.md` | `ready` |

**Templates define structure** (which sections, what order). **Patterns define methodology** (how to think, what quality looks like). Both live at `/workspace\projects\heathdev-patterns\`. When they diverge, structure comes from the template, quality guidance comes from the pattern.

The canonical pipeline reference is `/workspace\projects\heathdev-patterns\patterns\INDEX.md`.

## Inputs

The user provides intent — one sentence to a short paragraph:
- `/spec "add OAuth login to service"`
- `/spec` then describes the problem when prompted

If no intent is provided, ask for it. One question only: "What are we building?"

## Phase 1: Setup & Exploration

### 1a. Parse Intent

Extract from the intent:
- **What** is being built or changed
- **Which project(s)** this touches — check `/workspace\projects\` for matching repos
- **Slug** — kebab-case, ≤40 chars

If the project is ambiguous, ask. If the scope is ambiguous, make your best guess and flag it as `[ASSUMPTION: A1]` — the human will correct at the review gate.

### 1b. Scaffold Workshop

Check if `/workspace\data\outputs\workshops\{slug}\` already exists.

**If the directory does not exist:** Create it with `meta.json`:
```json
{
  "title": "{title}",
  "slug": "{slug}",
  "status": "captured",
  "projects": ["{project}"],
  "tags": [],
  "startedAt": "{ISO timestamp}",
  "createdAt": "{ISO timestamp}"
}
```

Use `"projects"` (plural, array) — NOT `"project"` (singular). The workshop handler reads `Array.isArray(meta.projects)`. A singular string silently resolves to empty array.

**If the directory already exists:** This workshop has prior work. Handle it cleanly:
1. Read `meta.json` for context (title, status, projects) — note the current status
2. Archive existing pipeline artifacts into a `_prior/` subdirectory (problem-statement.md, decisions.md, verification.md, constraints.md, decomposition.md, specification.md, work-packages/). Do NOT archive meta.json.
3. Reset `meta.json` status to `"captured"` and update timestamps
4. Note in your output: "Found existing workshop at status '{status}'. Archived prior artifacts to `_prior/` and starting fresh from patterns."

**Critical: existing artifacts are context, not drivers.** You may glance at a prior problem statement for domain context, but the patterns + codebase exploration drive your process. Do not read existing artifacts to determine your approach, restructure them into pipeline format, or let their decisions constrain yours. You are generating fresh from patterns and the current state of the code.

### 1c. Explore Codebase

Before writing anything, ground yourself in the actual code. Use the Agent tool to launch an Explore agent:

- Directory structure of the target project
- Key entry points, config files, package.json/cargo.toml etc.
- Files most likely affected by this change
- Existing patterns the implementation should follow

Store findings mentally — you'll reference them throughout. Every architectural claim in the spec must cite a real file path.

### 1d. Search Knowledge Base

Search the KB for prior work on this topic:
```
kb_search("relevant terms from the intent")
```
Surface any prior workshops, research, corrections, or lessons that inform this spec. Don't re-derive what's already been decided.

## Phase 2: Autonomous Pipeline (Stages 1-4)

Run stages 1-4 sequentially. For each stage:
1. Read the **pattern file** from `/workspace\projects\heathdev-patterns\patterns\` — this is the methodology
2. If a **template** exists for this stage (see table above), read it too — this is the artifact skeleton
3. Write the artifact to the workshop directory
4. Update `meta.json` status (use the status values from the table above)

**Do not dump pattern contents into your output.** Read them, internalize the methodology, apply it. The patterns are your reference, not content to recite.

### Stage 1: Problem Statement
- Pattern: `patterns/problem-statement.md`
- Template: `templates/problem-statement.template.md`
- Output: `problem-statement.md`
- Key discipline: Self-containment test. Could a stranger begin solving this from what's written?
- Ground every claim in code you actually read in Phase 1.
- Surface hidden assumptions as `[ASSUMPTION: A1]`, `[ASSUMPTION: A2]`, etc.

### Stage 2: Decisions
- Pattern: `patterns/decision-resolution.md`
- Output: `decisions.md`
- Key discipline: Scan your own problem statement for ambiguity flags ("or", "possibly", "might", "TBD", "should consider"). Each real ambiguity becomes a numbered decision (D1, D2...).
- For each decision: list options, state tradeoffs (one line each), **choose one**, document reasoning.
- Mark decisions where you're uncertain as `[DECISION: D3 — low confidence, alternatives close]`.
- Use the `design-alternatives` pattern mentally — consider at least 2 approaches before choosing.

### Stage 3: Verification
- Pattern: `patterns/verification-criteria.md`
- Output: `verification.md`
- Key discipline: For each decision, write the three-sentence independent observer test. If you can't verify it, the decision needs refinement — flag it.
- Specify verification type (automated test > build check > CLI command > Playwright > manual observation).
- Capture baselines where applicable.

### Stage 4: Constraints
- Pattern: `patterns/constraint-architecture.md`
- Output: `constraints.md`
- Key discipline: Four categories — Musts (M1...), Must-Nots (MN1...), Preferences (P1...), Escalation Triggers (E1...).
- Use the "smart well-intentioned person" exercise: what could they do that satisfies every requirement but produces the wrong outcome?
- Check KB for failure modes from similar past campaigns. Inject relevant constraints.

## Phase 3: Self-Review

After writing all 4 artifacts, run an adversarial self-review:

1. **Ambiguity scan** — re-read all artifacts for unresolved "or", "possibly", "might", "TBD"
2. **Grounding check** — does every architectural claim reference a real file?
3. **Verification specificity** — is every V-criterion a concrete command or observable behavior, not vibes?
4. **Constraint coverage** — all 4 categories present? Must-nots address likely agent drift?
5. **Cross-artifact consistency** — do decisions align with constraints? Do verification criteria cover every decision?

Fix issues found. Then flag anything you're still uncertain about.

## Phase 4: Human Review Gate

Present a consolidated review artifact. Format:

```markdown
## Spec Review: {title}

### Flagged Items
{List all [DECISION] and [ASSUMPTION] callouts with their context}

### Summary
- **Problem:** {1-2 sentences}
- **Key decisions:** {D1, D2... with choices made}
- **Verification approach:** {strongest verification type used}
- **Constraint highlights:** {most important must-nots and escalation triggers}

### Your Call
Review the flagged items. For each:
- ✅ Approve
- ✏️ Revise: {your correction}
- ❌ Reject: {why}

Or: "looks good" to proceed, "start over" to restart, or specific feedback.
```

**STOP HERE.** Wait for human input. Do not proceed to decomposition without explicit approval.

## Phase 5: Revision (if needed)

When the human provides feedback:
1. Identify the earliest affected stage
2. Revise from that stage forward (don't re-run unaffected stages)
3. Re-present only the changed sections
4. Return to the review gate

One revision loop is normal. If the third revision still has major issues, suggest a `/grill-me` session to resolve the underlying confusion.

## Phase 6: Decomposition & Work Packages

After approval, run stages 5-6:

### Stage 5: Decomposition
- Pattern: `patterns/decomposition.md`
- Output: `decomposition.md`
- Apply the appropriate break pattern (API/Backend, UI, Refactor, Infrastructure) from the pattern.
- Run the decomposition test: each unit <2hrs, clear boundaries, independently verifiable, disjoint files.
- Include a Mermaid dependency graph for 4+ packages.

### Stage 6: Work Packages
- Pattern: `patterns/work-package.md`
- Template: `templates/_orchestrator.template.md`
- Output: `work-packages/wp-{NN}-{slug}.md` for each package + `work-packages/_orchestrator.md`
- All 7 required fields per WP (precondition, goal, files, verification, failure criteria, boundary, commit)
- Tag each WP: `execution: autonomous` or `execution: review-needed` (HITL flag)
- Wave plan with gate commands
- Spec-level constraints in orchestrator (from constraints.md)

Update `meta.json` status to `"ready"`.

## Phase 7: Final Output

Present the completed spec summary:

```markdown
## Spec Complete: {title}

**Workshop:** `workshops/{slug}/`
**Packages:** {N} WPs across {N} waves
**Estimated execution:** {autonomous WPs} autonomous, {review WPs} need review
**Gate commands:** {summary}

Ready for `/spec-validate` then dispatch.
```

## Principles

- **Patterns are the methodology, existing artifacts are not.** Drive from patterns + codebase exploration. If a workshop directory already exists with prior artifacts, those are context — not the starting point. Never restructure old artifacts into pipeline format or let prior decisions constrain fresh analysis.
- **Templates define structure, patterns define methodology.** Read both when available. The template gives you the artifact skeleton; the pattern tells you how to fill it well.
- **Speed over perfection.** A 90% spec in 15 minutes beats a 98% spec in 60 minutes. The review gate and review council catch the delta.
- **Ground everything.** No architectural claims without file references. No "the system probably does X."
- **Flag, don't hide.** Uncertainty is fine — hiding it isn't. Use [DECISION] and [ASSUMPTION] callouts liberally.
- **Patterns are runtime reads, not memorized content.** Read each pattern file fresh before writing its artifact. Patterns evolve.
- **The output is a real workshop.** Not a separate format. Everything downstream (validate, dispatch, review council, post-mortem) works on these artifacts unchanged.

## Ledger Events

Write timing events at each stage transition (fire-and-forget, non-blocking):
```json
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "{stage}", "event_type": "entered", "actor": "agent" }
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "{stage}", "event_type": "completed", "actor": "agent" }
```

Valid stage names: `problem-statement`, `decisions`, `verification`, `constraints`, `decomposition`, `work-packages`

**Tool:** Call `mcp__context-ledger__ledger_write` with the payload above. The ledger adds timestamps automatically. Non-blocking: if the call fails, log and continue — timing capture must not block workshop progress.

---
*Implements Approach A from the Autonomous Spec Pipeline workshop.*
*Pattern library: /workspace\projects\heathdev-patterns\*
*Related skills: /workshop (interactive co-authoring), /spec-validate (quality check), /grill-me (stress-test before speccing)*
