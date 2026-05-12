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

Write branch prompts to temp files, then call the launcher:

```bash
node "[plugin-path]/skills/parallel-explore/scripts/launch.mjs" \
  --prompts /tmp/explore-branches/ \
  --workdir [current project] \
  --model sonnet
```

The script:
- Creates isolated directories (or worktrees if `--worktree` flag)
- Launches `claude -p` for each branch prompt
- Collects stdout to result files
- Reports exit status and timing
- Returns path to results directory

**The skill waits for all branches.** No early termination in v1 — keep it simple.

### 6. Synthesis

Read all branch results and produce:

```markdown
## Branch Summaries
[2-3 sentence summary of each branch's approach]

## Where Branches Agree
[Consensus points — these are likely correct regardless of direction]

## Where Branches Genuinely Disagree
[Real tradeoffs, not cosmetic differences. Name the tension.]

## Hidden Assumptions
[What did branches assume without stating? Where might all branches be wrong?]

## Comparison Matrix
| Criterion | Branch 1 | Branch 2 | Branch 3 |
|-----------|----------|----------|----------|
[Evaluation criteria from the brief, scored or characterized per branch]

## Recommendation
[Pick one. Be opinionated. Say why. If merge-best-parts was requested, propose the specific merge with justification for each borrowed element.]

## Uncertainty
[What remains unclear even after exploration? What would you need to resolve before committing?]

## Next Action
[Concrete next step — spec it, build it, explore further, or decide.]
```

**Synthesis rules:**
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
