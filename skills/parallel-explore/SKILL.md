---
name: parallel-explore
description: "Fan out a design or problem space into multiple intentionally different agent runs, then synthesize into a ranked decision. Use when the user says 'explore alternatives', 'parallel explore', 'design it twice', 'what are my options', wants to compare approaches, or needs to make an architectural decision between competing designs. Replaces design-alternatives with broader scope and mechanical dispatch."
---

# Parallel Explore — Forced-Divergence Design Exploration

Fan out N intentionally different solutions to a problem, then synthesize into a ranked decision artifact. The key insight: without explicit constraint variation, all branches collapse into the same answer.

**Skill = cognitive layer.** This skill reasons about decomposition, crafts differentiated briefs, and synthesizes results.
**Script = mechanical layer.** `scripts/launch.mjs` handles process management. No reasoning in the script.

## Process

### 1. Intake and Decomposition (single pass)

In **one** reasoning pass, produce the full exploration brief:

```
## Exploration Brief

**Goal:** [what we're deciding or producing]
**Non-goals:** [what's explicitly out of scope]
**Hard constraints:** [stack, forbidden moves, invariants]
**Soft preferences:** [nice-to-haves, style, direction leanings]
**Hold constant:** [what must NOT vary across branches]
**Evaluation criteria:** [how we'll judge branches — ordered by importance]
**Expected deliverable:** [comparison matrix | ranked recommendation | merged design | PR-ready plan]
**Synthesis mode:** [pick-one (default) | merge-best-parts | keep-N-for-human-review]
```

Then immediately select **2-4 variation axes** and generate all branch briefs. Do NOT separate these into multiple passes — one call produces the brief, axes, and all branch prompts.

**Default behavior (vague input):** If the user gives a loose goal without structure, infer:
- 3 variants: one conservative, one balanced, one contrarian
- `pick-one` synthesis mode
- Evaluation criteria inferred from problem domain

### 2. Axis Selection

Choose axes that produce **genuinely different** designs, not cosmetic variants. Examples by domain:

**Architecture:** minimal-vs-scalable, centralized-vs-distributed, explicit-orchestration-vs-agent-autonomy, operational-simplicity-vs-extensibility

**UI:** dense-expert-vs-progressive-disclosure, conventional-vs-experimental, low-motion-vs-expressive, implementation-speed-vs-visual-ambition

**Code:** smallest-diff-vs-cleanest-abstraction, framework-native-vs-library-assisted, sync-simplicity-vs-async-scalability

**Debugging:** environment-first, code-path-first, dataflow/observability-first, toolchain/dependency-first

These are starting points, not templates. The skill should decompose well from goal + constraints alone. If you can't generate meaningful variation without falling back to these lists, the problem isn't well enough understood — ask the user.

### 3. Branch Brief Generation

Each branch gets a prompt file containing:

```markdown
You are branch N of M in a parallel exploration.

## Shared Context
[Goal, hard constraints, hold-constant items — identical across all branches]

## Your Branch Thesis
[One sentence: what this branch optimizes for]

## Favor
[What this branch should prioritize]

## Avoid
[What this branch should reject — including approaches other branches will take]

## Anti-convergence instruction
Do NOT produce a balanced compromise. Commit fully to your thesis. If your approach has ugly tradeoffs, name them — don't soften them. The value is in the contrast.

## Required Output

# [Branch Title]
## Thesis
## Proposed Design
## Why This Wins (under this branch's thesis)
## Tradeoffs (be honest — what do you sacrifice?)
## Failure Modes
## Operational Complexity (1-5 scale with justification)
## Verification Plan
## First Implementation Slice (smallest thing that proves the approach)
## What This Branch Would Reject From Other Approaches
```

The normalized output schema is non-negotiable. Without it, synthesis gets mushy.

### 4. Cost Check

Before dispatching, surface the cost:

> **Dispatching N branches.** Model: [sonnet/opus]. Estimated wall-clock: ~X minutes.
> Proceed, change model, or adjust variant count?

Model selection guidance:
- **Sonnet** for most explorations — good enough for differentiated design work, 5x cheaper
- **Opus** when the problem requires deep reasoning or novel pattern synthesis
- **Mixed** is valid — contrarian branch on Opus, conservative branches on Sonnet

If the user hasn't specified, default to Sonnet.

### 5. Mechanical Dispatch

#### Run slug

Derive a run slug from the goal and the current UTC time (per D1):
- Lowercase the goal; replace runs of non-alphanumeric characters with a single `-`; strip leading/trailing `-`; truncate to ≤ 40 characters, backing up to the nearest `-` only if truncation lands mid-word AND the result would exceed 40 chars (an exactly-40-char kebab is kept as-is).
- Append `-YYYYMMDD-HHMMSS` using UTC components.
- If no goal is provided, the kebab portion is `explore`.

Example: goal `"Design the authentication boundary"` at `2026-05-13T14:50:32Z` → slug `design-the-authentication-boundary-20260513-145032`.

#### Run directory

Create the central run directory **before invoking the launcher**:

```
./outputs/parallel-explore/{run-slug}/
  prompts/           # the skill writes branch prompts here
  results/           # launch.mjs writes here (created on first write)
  synthesis.json     # the skill writes here in section 6
  synthesis.md       # the renderer writes here
  synthesis.html     # the renderer writes here
```

The skill is responsible for `mkdir`-ing the run directory and the `prompts/` subdirectory before any branch prompt is written. Directory creation uses recursive (`-p`) semantics — the parent `./outputs/parallel-explore/` is created if it does not yet exist.

#### Prompt filenames (load-bearing convention)

Each branch prompt file MUST be named `{branch.id}.md` — i.e., `branch-1.md`, `branch-2.md`, `branch-3.md`, etc. The `branch.id` here is the same identifier the skill uses in section 6's `synthesis.json` `branches[].id` field. `launch.mjs` derives result filenames from prompt filenames via `basename(promptFile, '.md')`, so `branch-1.md` produces `results/branch-1.md`. The renderer's pick-branch prompt template assumes this — deviating produces HTML that points users at non-existent result files.

#### Dispatch

Invoke the launcher against the run directory:

```bash
node "[plugin-path]/skills/parallel-explore/scripts/launch.mjs" \
  --prompts "./outputs/parallel-explore/{run-slug}/prompts" \
  --workdir [current project] \
  --model sonnet
```

The script:
- Creates isolated directories (or worktrees if `--worktree` flag)
- Launches `claude -p` for each branch prompt
- Collects stdout to result files (one per branch) inside the run directory's `results/` subdirectory (derived as `dirname(--prompts)/results` — a sibling of `prompts/`)
- Logs progress and final results-directory path to stdout
- Exits with non-zero status if any branch failed (no programmatic return value — `launch.mjs` is a CLI process, not a library)

**The skill waits for all branches.** No early termination in v1. After `launch.mjs` exits, result files are at `{run-dir}/results/{branch.id}.md` — derived from the same `--prompts` argument the skill passed in, not from any value returned by the launcher.

### 6. Synthesis

Read all branch results from `{run-dir}/results/` and emit structured synthesis data.

#### Output contract

The synthesis step produces **three artifacts**, all written to the run directory:
- `synthesis.json` — structured data, the skill's emit target (canonical data source)
- `synthesis.md` — markdown rendering, canonical human-readable artifact
- `synthesis.html` — viewing surface for the human comparison and pick-branch step

The skill emits `synthesis.json`. The renderer (`scripts/render-synthesis.mjs`) derives `synthesis.md` and `synthesis.html` from it. JSON is the renderer's source of truth; markdown is the canonical human-readable artifact (git-tracked when applicable); HTML is the disposable viewing surface.

#### JSON schema reference

The skill must emit a valid `synthesis.json` conforming to v1.0 schema. An LLM reading only this section should be able to produce a valid emit (M5).

Required top-level fields:

| Field | Type | Notes |
|---|---|---|
| `schema_version` | string | Must be `"1.0"` |
| `run_slug` | string | Matches the run directory name derived in section 5 |
| `created_at` | string | ISO-8601 UTC timestamp; `YYYYMMDD-HHMMSS` components must match the timestamp suffix of `run_slug` |
| `goal` | string | The single design question being explored |
| `non_goals` | string[] | At least 1 entry |
| `hard_constraints` | string[] | At least 1 entry |
| `evaluation_criteria` | object[] | Each: `{ "id": "ec1", "name": "...", "weight": "high\|medium\|low" }` |
| `branches` | object[] | See subfields below; typically 2–4 entries |
| `comparison_matrix` | object[] | One row per criterion; see below |
| `branches_agree` | string | Markdown: what all branches converge on |
| `branches_disagree` | string | Markdown: core axes of disagreement |
| `hidden_assumptions` | string | Markdown: unstated assumptions across branches |
| `recommendation` | object | `{ "branch_id": "branch-1", "rationale": "markdown string" }` |
| `uncertainty` | string | Markdown: remaining unknowns that could change the recommendation |
| `next_action` | string | Markdown: concrete next steps |

Each `branches[]` entry: `id` (e.g. `"branch-1"`), `title`, `thesis` (one sentence), plus markdown-string prose subfields `proposed_design`, `why_this_wins`, `tradeoffs`, `failure_modes`, `verification_plan`, `first_implementation_slice`, `rejects_from_others`, and a structured `operational_complexity: { "score": 1–5, "justification": "..." }`.

Each `comparison_matrix[]` entry: `{ "criterion_id": "ec1", "criterion_label": "...", "cells": [ { "branch_id": "branch-1", "score": 1–5, "characterization": "≤80 chars" } ] }`. Cell scores are integers 1–5; the renderer maps them to a red→green color ramp in the HTML.

Prose fields (`branches_agree`, `branches_disagree`, `hidden_assumptions`, `uncertainty`, `next_action`, `recommendation.rationale`, and branch prose subfields) accept a bounded markdown subset: headings, paragraphs, ul/ol, bold, italic, inline code, fenced code, links. Unsupported syntax (tables in prose, nested lists deeper than 1, raw HTML) falls back to escaped plain text.

Full field-by-field documentation: `skills/parallel-explore/tests/fixtures/synthesis-schema.md`
Working reference: `skills/parallel-explore/tests/fixtures/synthesis-example.json`

#### Renderer invocation

After writing `synthesis.json` to the run directory, invoke (from any working directory):

```bash
node "[plugin-path]/skills/parallel-explore/scripts/render-synthesis.mjs" \
  --input "./outputs/parallel-explore/{run-slug}/synthesis.json" \
  --output-dir "./outputs/parallel-explore/{run-slug}"
```

The renderer:
- Validates the JSON against the v1.0 schema (fails loudly on invalid input — non-zero exit + stderr)
- Writes `synthesis.md` and `synthesis.html` into `--output-dir`
- Output is deterministic given fixed JSON input AND fixed `--output-dir` (two runs on the same input produce byte-identical files)

If the renderer exits non-zero, the JSON is malformed or missing required fields. Read stderr, fix the JSON, re-run.

#### The pick-branch round-trip

The rendered HTML contains per-branch "Pick this branch" buttons. Clicking a button copies a prompt to the user's clipboard. The user pastes that prompt into the next agent invocation, which begins execution from the chosen branch's Proposed Design and First Implementation Slice — referencing the corresponding `results/{branch.id}.md` file for the branch's full output.

This is the manual decision-and-handoff step. The canonical artifact is the persisted HTML, not the chat.

#### Chat output

Produce only a short chat-side summary: the recommendation, the run directory path, and a pointer to `synthesis.html`. Do not paste the full synthesis content into chat — point at the file.

#### Synthesis rules (preserved)

- Preserve disagreement. "Everyone is right" summaries are forbidden.
- `pick-one` (default): Recommend one branch. The others are evidence for the recommendation, not runners-up to blend.
- `merge-best-parts`: Only when explicitly requested. Name exactly which element comes from which branch and why. A merge that can't trace every element to a source branch is a Frankenstein.
- `keep-N-for-human-review`: Present top N with tradeoff analysis, no recommendation. User decides.

## Invocation

**Simple:**
```
/parallel-explore "Design the best pattern for X"
```

**Structured:**
```
/parallel-explore
goal: Design a portable parallel-agent workflow for Claude Code
constraints:
  - Must use Claude CLI
  - Must remain skill + script split
axes:
  - minimal vs scalable vs contrarian
  - manual vs automatic context
variants: 4
deliverable: ranked recommendation
synthesis_mode: pick-one
```

## Anti-patterns

- Launching branches that differ only cosmetically
- Synthesizing too early or blending by default
- "Everyone has good points" summaries
- Overbuilding the launcher script (it's plumbing, not architecture)
- Letting branches mutate shared state
- Treating exploration as implementation — no code is written, only designs
- Front-loading multiple LLM reasoning passes before any exploration launches
- Skipping the cost check on Opus runs

<supporting_info>

## Lineage

Evolved from `design-alternatives` (Ousterhout's "Design It Twice" + Pocock's design-an-interface skill). Broadened from interface/module scope to any problem domain. Added mechanical dispatch separation, forced-divergence axes, normalized output schema, and synthesis discipline learned from the campaign era.

---
*Source: design-alternatives skill, beam-search pattern from spec pipeline research, campaign-era lessons on merge-vs-pick and orchestration overhead.*

</supporting_info>
