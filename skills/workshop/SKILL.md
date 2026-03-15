---
name: workshop
description: "Scaffold, resume, and guide workshops through the spec pipeline. Use this skill whenever the user mentions workshops, wants to start specifying a feature, says 'let's workshop this', wants to create a problem statement, or needs to continue work on an existing workshop. Also trigger when the user references the spec pipeline, work packages, or decomposition in a planning context."
---

# Workshop — Spec Pipeline Orchestration

Guide workshops through the heathdev-patterns spec pipeline, from initial problem capture through dispatchable work packages.

## Context

Workshops are the specification mechanism. Each workshop lives at `/workspace\data\outputs\workshops\{slug}\` and progresses through a 6-stage pipeline defined in the pattern library at `/workspace\projects\heathdev-patterns\`.

The pipeline stages, their patterns, and their output artifacts:

| Stage | Pattern File | Output Artifact | meta.json status |
|-------|-------------|-----------------|------------------|
| 1 | `patterns/problem-statement.md` | `problem-statement.md` | `problem-statement` |
| 2 | `patterns/decision-resolution.md` | `decisions.md` | `decisions` |
| 3 | `patterns/verification-criteria.md` | `verification.md` | `verification` |
| 4 | `patterns/constraint-architecture.md` | `constraints.md` | `constraints` |
| 5 | `patterns/decomposition.md` | `decomposition.md` | `decomposition` |
| 6 | `patterns/work-package.md` | `work-packages/*.md` + `work-packages/_orchestrator.md` | `ready` |

Templates for scaffolding live at `/workspace\projects\heathdev-patterns\templates\`.

The canonical pipeline reference is `/workspace\projects\heathdev-patterns\patterns\INDEX.md`. When in doubt about stage ordering or pattern names, read it.

## How This Skill Works

### Entry Point: New or Resume?

When invoked, determine whether the user wants to:

**A) Start a new workshop** — they have an idea, a problem, a feature request. They might say "let's workshop X" or "I want to spec out Y" or just describe a problem.

**B) Resume an existing workshop** — they want to continue work on something already scaffolded. They might name it, or you might infer it from viewport context (workshops view) or recent session threads.

**C) Review workshop status** — they want to see where things stand across workshops. Show a status summary.

### Path A: New Workshop

1. **Clarify the intent.** What are we solving? Which project(s) does this touch? Get enough to write a slug and title.

2. **Scaffold the workshop directory:**
   - Create `/workspace\data\outputs\workshops\{slug}\`
   - Create `meta.json` using the template at `templates/meta.json.template` (strip the comment block — production meta.json must be valid JSON)
   - Set `status: "captured"`, fill in title, slug, projects, tags, timestamps

3. **Read the problem-statement pattern** from `patterns/problem-statement.md` — this is the methodology for stage 1. Also read the template from `templates/problem-statement.template.md` for the artifact skeleton. The template defines artifact structure (which sections, what order). The pattern defines methodology (how to think, what quality looks like). When they diverge, structure comes from the template, quality guidance comes from the pattern.

4. **Work through the problem statement collaboratively.** Don't just fill in a template — use the pattern's guidance to draw out the real problem. Key prompts from the pattern:
   - The self-containment test: could a stranger begin solving this from what's written?
   - Ground it before writing: explore actual code paths if this is a code problem
   - The rewrite exercise: turn vague descriptions into concrete ones
   - For code problems, spin up explore agents or read actual files before writing — grounded statements prevent specs built on wrong assumptions

5. **Write `problem-statement.md`** when the content is solid. Update `meta.json` status to `"problem-statement"`.

6. **Offer to continue to stage 2** or pause here. Workshops are non-terminal — pausing is fine.

### Path B: Resume Existing Workshop

1. **Identify the workshop.** Read `meta.json` to get current status. Read all existing artifacts to understand where things stand.

2. **Summarize state concisely:**
   - What's been completed (with key decisions/findings from each artifact)
   - What the current stage is
   - What's next
   - Any open questions or unresolved items from previous artifacts

3. **Suggest the next action.** Based on status and artifact quality, recommend:
   - Continue to the next pipeline stage
   - Revisit a previous stage (if you spot gaps — e.g., decisions that aren't verifiable)
   - A specific open question that needs answering before progressing

4. **Let the user override.** They might want to jump to a different stage, revisit something, or take the workshop in a new direction. The pipeline is guidance, not a cage.

### Advancing Through Stages

For each stage transition:

1. **Read the pattern file** for the target stage from `/workspace\projects\heathdev-patterns\patterns\{pattern-name}.md`. This is the methodology — it tells you what the stage produces, what quality looks like, and what the common failure modes are. Extract the relevant guidance and apply it conversationally — don't dump the raw pattern into the conversation. The pattern is your reference, not content to recite.

2. **Read the previous stage's artifact** to carry forward context. Each stage has a specific relationship to the one before it:
   - **decisions** reads the problem statement and **scans it for ambiguity flags** ("or", "possibly", "could", "might", "TBD", "should consider"). Each flag is a potential unresolved decision. This scan is the primary input to the decisions artifact.
   - **verification** reads decisions and asks: for each decision (D1, D2...), can an independent observer verify it was implemented correctly? If not, the decision needs refinement — push it back.
   - **constraints** reads all prior artifacts and extracts the boundaries: what must be true (musts), what's forbidden (must-nots), what's preferred when ambiguous (preferences), and what should stop work and escalate (triggers).
   - **decomposition** reads constraints and the problem statement to find the natural seams — where does the work break into independent, testable, parallelizable units?
   - **work-packages** takes each decomposition unit and writes a full dispatchable spec with precondition, goal, files, verification, failure criteria, and boundary.

3. **Guide the conversation** using the pattern's methodology. Each pattern has specific techniques:
   - **decision-resolution**: Scan the problem statement for ambiguity flags. For each real ambiguity: list options, state tradeoffs (one line each), decide, document reasoning. Use D1, D2, D3... naming convention.
   - **verification-criteria**: For each decision (D1→V1, D2→V2...), write the three-sentence independent observer test. Specify verification type (automated test, build check, CLI command, manual observation). If you can't verify it, push it back to decisions.
   - **constraint-architecture**: Four categories — musts, must-nots, preferences, escalation triggers. Number them (M1, MN1, P1, E1). Each must-not should reference what failure mode it prevents.
   - **decomposition**: Apply the appropriate break pattern from the pattern file (API/Backend, UI, Refactor, Infrastructure). Run the decomposition test: each unit < 2hrs, clear boundaries, independently verifiable, disjoint files.
   - **work-package**: The atomic dispatchable unit. Six fields minimum. Use the template from `templates/_orchestrator.template.md` for the campaign orchestrator.

4. **Write the artifact** when content is solid. Update `meta.json` status.

5. **Offer to continue or pause.**

### Stage 6: Work Packages + Orchestrator

Stage 6 is structurally different — it produces multiple files:

- Individual work package specs in `work-packages/` subdirectory
- The orchestrator at `work-packages/_orchestrator.md` (from the template)
- Wave plan, package inventory, gate commands, spec-level constraints

Read both `patterns/work-package.md` and `templates/_orchestrator.template.md` before starting this stage.

When work packages are complete and the orchestrator is written, update meta.json status to `"ready"`. The workshop is now dispatchable.

## Environment Adaptation

**service/frontend sessions:** You're assistant. You have full file access. Work conversationally — read patterns, guide discussion, write artifacts directly.

**Claude Code CLI sessions:** Same workflow. You may have subagent access for parallel work (e.g., researching code paths while writing the problem statement). Use it if available, but it's not required.

## Important Principles

**The patterns ARE the methodology.** Don't paraphrase them from memory — read them fresh each time. They evolve. The pattern files are the source of truth, not this skill's description of them.

**Templates define structure, patterns define methodology.** When a template's section layout differs from a pattern's suggested structure, use the template for the artifact skeleton and the pattern for quality guidance. They serve different purposes and both are needed.

**Guide, don't recite.** When you read a pattern file, extract the relevant techniques and apply them in conversation. Don't paste pattern contents or mechanically walk through every section. The user knows the methodology — the skill's job is to apply it, not teach it. Brief orientation is fine when introducing a stage for the first time.

**Workshops are non-terminal.** Any workshop can be paused and resumed. Status in meta.json tracks where things are. Don't pressure completion.

**Each stage has quality criteria.** The patterns define what "done" looks like for each stage. Don't advance past a stage that doesn't meet its own criteria — surface the gaps and work through them.

**The problem statement is the most important artifact.** If it's weak, everything downstream suffers. Spend the time here. The self-containment test is the minimum bar.

**Decisions must be decisions, not options.** The decision-resolution pattern exists because "we could do A or B" is not a spec — it's a brainstorm. Force the choice.

**Constraints prevent the most expensive class of agent failure.** Must-nots especially — they prevent scope violations that waste entire dispatches. Don't skip or rush the constraint stage.

**meta.json must be valid JSON.** The template file has comments for documentation, but production meta.json files must strip all comments. service's workshop handler parses these files.
