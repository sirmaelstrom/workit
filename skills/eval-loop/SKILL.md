---
name: eval-loop
description: "Run an autonomous Karpathy-style eval loop to improve a skill's quality through measured iteration. Use when the user says 'eval loop', 'karpathy loop', 'improve this skill', 'optimize skill', 'run evals', 'self-improve', or wants to iteratively improve a skill's output quality using automated scoring. Requires the skill to be marked karpathy_eligible in skills.db."
---

# Eval Loop — Autonomous Skill Improvement via Measured Iteration

Run a time-budgeted loop that mutates a skill definition, evaluates outputs against binary assertions, and keeps only improvements. This is Layer 2 — running the skill and measuring results, not reading its definition.

The core pattern: **one file to edit, one set of metrics to optimize, one time budget.**

## Why This Exists

Skills degrade or plateau without feedback. Human review is expensive and inconsistent. The Karpathy Loop pattern (autoresearch, March 2026) proved that autonomous eval-optimize-iterate cycles produce measurable improvement on any artifact with a quantifiable metric. This skill applies that pattern to Claude Code skill definitions.

## Prerequisites

- Target skill must have `karpathy_eligible = 1` in its most recent assessment (run `audit-skills` first if no assessment exists)
- `skills.db` must exist at the target project root
- An eval suite must exist or be created during setup (step 2)

## Process

### 1. Target Selection

Identify the skill to improve:

- **Explicit:** User names a skill → validate it exists and is karpathy-eligible
- **Auto-select:** User says "improve the highest ROI skill" → query latest assessments, pick highest ROI that's karpathy-eligible

```sql
SELECT s.id, s.name, s.plugin, a.karpathy_eligible,
  (5 - (a.output_quality + a.composability + a.agent_readiness + a.eval_coverage) / 4.0)
    * a.usage_frequency * CASE WHEN a.karpathy_eligible = 1 THEN 1.5 ELSE 1.0 END as roi
FROM skills s
JOIN assessments a ON s.id = a.skill_id
WHERE a.karpathy_eligible = 1
  AND a.id = (SELECT MAX(id) FROM assessments WHERE skill_id = s.id)
ORDER BY roi DESC LIMIT 1;
```

If the skill isn't eligible, say so and suggest running `audit-skills` or explain what's missing.

### 2. Eval Suite — Load or Create

Check for an existing eval suite at `skills/<skill-id>/evals/suite.yaml`. If none exists, generate one:

```yaml
skill: <skill-id>
created_at: <ISO timestamp>
model: sonnet  # default eval model
iterations: 10  # default loop budget
timeout_per_iteration_minutes: 10

test_cases:
  - id: tc-01
    description: "<what this tests>"
    input: "<structured input that would invoke the skill>"
    context:
      project: "<relevant project>"
      constraints: []
    assertions:
      format:
        - "<binary check on output structure>"
      quality:
        - "<binary check on output substance — LLM-as-judge>"
      instruction_adherence:
        - "<binary check on skill's own rules being followed>"
      composability:
        - "<binary check on output usability by downstream>"
```

**Suite generation rules:**
- Minimum 5 test cases, aim for 10-20
- Each test case needs 3-6 assertions across categories
- Format assertions should be mechanically verifiable (section exists, schema valid)
- Quality assertions use LLM-as-judge with binary framing ("Does X? Yes/No")
- Draw test inputs from real project contexts where possible
- Include at least one adversarial case (ambiguous input, edge case, conflicting constraints)

**Present the suite for human approval before proceeding.** This is the one required gate.

### 3. Baseline

Run the skill against ALL test cases using the current SKILL.md. Score every assertion.

Record baseline:
```
Baseline — [skill-id] — [timestamp]
  format:              28/30 (93.3%)
  quality:             18/30 (60.0%)
  instruction_adherence: 25/30 (83.3%)
  composability:       20/30 (66.7%)
  overall:             91/120 (75.8%)
```

Write to `eval_runs` table:
```sql
INSERT INTO eval_runs (
  skill_id, run_at, metric_name, metric_before, metric_after,
  delta, iterations, duration_seconds, model, notes
) VALUES (?, ?, 'baseline', NULL, ?, NULL, 0, ?, ?, 'Initial baseline');
```

### 4. The Loop

```
FOR each iteration (up to budget):
  1. ANALYZE: Identify the weakest assertion category from current scores
  2. HYPOTHESIZE: Propose ONE specific mutation to the SKILL.md that would improve that category
  3. MUTATE: Apply the change (save backup first)
  4. EVALUATE: Run ALL test cases against the mutated skill
  5. COMPARE:
     - If overall pass rate improved AND no category degraded by >5%: KEEP
     - If overall pass rate degraded OR any category dropped >5%: REVERT
  6. RECORD: Log the iteration result regardless of keep/revert
  7. CHECK: If converged (3 consecutive reverts) or budget exhausted: EXIT
```

**Mutation discipline:**
- ONE change per iteration. Not two. Not "a small set of related changes." One.
- Changes must be to the SKILL.md content (instructions, schema, process steps, examples)
- Never mutate the frontmatter name/description during the loop (that changes routing, not output quality)
- Prefer additive mutations (add example, add constraint, add edge case handling) over subtractive
- Each mutation must have a stated hypothesis: "Adding an explicit anti-pattern for X should improve quality assertion Y"

**Revert safety:**
- Before each mutation, copy current SKILL.md to `skills/<id>/evals/.backup-<iteration>.md`
- On revert, restore from backup
- After loop completes, clean up backups (keep only the final version and the original)

### 5. Record Results

After loop exits, write the final eval run:

```sql
INSERT INTO eval_runs (
  skill_id, run_at, metric_name, metric_before, metric_after,
  delta, iterations, duration_seconds, model, notes
) VALUES (?, ?, 'eval-loop', <baseline_score>, <final_score>,
  <final - baseline>, <iterations_run>, <total_seconds>, ?, <mutation_log>);
```

### 6. Debrief Report

```markdown
# Eval Loop Report — [skill-id] — [date]

## Configuration
- Model: [sonnet/opus]
- Iterations: [N run] / [M budgeted]
- Duration: [X minutes]
- Exit reason: [converged | budget exhausted | human stop]

## Results
| Category | Baseline | Final | Delta |
|----------|----------|-------|-------|
| format | 93.3% | 96.7% | +3.4% |
| quality | 60.0% | 78.3% | +18.3% |
| instruction_adherence | 83.3% | 86.7% | +3.4% |
| composability | 66.7% | 73.3% | +6.6% |
| **overall** | **75.8%** | **83.8%** | **+8.0%** |

## Mutations Applied (kept)
1. Iteration 2: Added explicit example of bad output for synthesis section → quality +6.7%
2. Iteration 5: Added composability note naming downstream consumers → composability +6.6%
3. Iteration 7: Added edge case handling for single-branch input → format +3.4%

## Mutations Reverted
1. Iteration 1: Tried restructuring process order → overall -2.5%
2. Iteration 3: Added verbose anti-pattern list → instruction_adherence -1.7%
3. ...

## Remaining Weak Assertions
- tc-04 quality: "Tradeoffs section names real costs" — still failing 40% of runs
- tc-09 composability: "Output parseable by spec skill" — failing 30% of runs

## Recommendations
- [Specific manual improvement for assertions that the loop couldn't crack]
- [Whether another loop iteration would help or if the skill needs redesign]
```

## Invocation

**Simple:**
```
/eval-loop parallel-explore
```

**With options:**
```
/eval-loop parallel-explore --iterations 15 --model opus --timeout 15
```

**Auto-select:**
```
/eval-loop --highest-roi
```

## Configuration Defaults

| Setting | Default | Override flag |
|---------|---------|-------------|
| Model | sonnet | `--model` |
| Max iterations | 10 | `--iterations` |
| Timeout per iteration | 10 min | `--timeout` |
| Revert threshold | 5% category drop | (not configurable v1) |
| Convergence | 3 consecutive reverts | (not configurable v1) |

## Anti-patterns

- Running without a baseline (no way to measure improvement)
- Multiple mutations per iteration (can't attribute what helped)
- Mutating frontmatter during the loop (changes trigger routing, not output quality)
- Running on skills that aren't karpathy-eligible (waste of compute)
- Skipping human approval of the eval suite (the suite IS the definition of "good")
- Optimizing a single category at the expense of others (the 5% degradation guard prevents this)
- Running indefinitely without a time budget (convergence detection + max iterations prevent this)
- Not recording reverted mutations (they're data too — knowing what didn't work prevents re-trying it)

## Relationship to Other Skills

- **audit-skills** — upstream: provides `karpathy_eligible` flag and assessment scores that determine targeting
- **parallel-explore** — could be used to explore SKILL.md mutations in parallel (future enhancement, not v1)
- **scorecard** — similar evaluation pattern but targets specs, not skills; could share assertion infrastructure

## Future Extensions (not v1)

- Parallel mutation exploration (try N mutations simultaneously, keep best)
- Cross-skill eval (does improving skill A degrade skill B in a pipeline?)
- Automated suite expansion (loop discovers new test cases from failure patterns)
- CI integration (run eval baseline on every skill commit)

---
*Origin: Karpathy autoresearch pattern (March 2026), AI Maker three-tier eval model, MindStudio binary eval framework. Adapted for Claude Code skill definitions as the single editable artifact.*
