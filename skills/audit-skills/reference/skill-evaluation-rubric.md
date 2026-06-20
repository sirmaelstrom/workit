# Skill Evaluation Rubric

**Purpose:** Structured scoring framework for assessing and improving Claude Code skills in a plugin's `skills.db`.

**Stores into:** `skills.db` → `assessments` table in each project root.

---

## Sources & Influences

- **AI Maker / Karpathy Loop article** — three-tier model (qualitative rubric → binary evals → autonomous loop)
- **MindStudio autoresearch eval loop** — binary yes/no test framework, disaggregated pass rates per category
- **Galileo agent evaluation framework** — trajectory vs outcome metrics, hierarchical rubric design (dimensions → sub-dimensions → items)
- **Murat Can Koylan's advanced-evaluation skill** — rubric structure components, bias mitigation, confidence scoring
- **Our March 2026 skills audit** — existing gaps (no evals, weak agent-readiness, lopsided tiers)
- **DOCTRINE.md** — testability-as-specification, validation architecture, externalized intent

---

## Two-Layer Model

Skills need two different kinds of evaluation, and conflating them is how rubrics become useless.

### Layer 1: Structural Assessment (Human, Periodic)

"Is this skill well-built?" — assessed by reading the skill definition, not by running it.

Runs during audits (quarterly or after significant changes). Writes to `assessments` table.

### Layer 2: Output Evaluation (Automated, Continuous)

"Does this skill produce good results?" — assessed by running the skill against test cases and scoring outputs.

Runs via Karpathy loop or manual eval passes. Writes to `eval_runs` table.

Not every skill is ready for Layer 2. The `karpathy_eligible` flag in assessments tracks which ones are.

---

## Layer 1: Structural Assessment Rubric

Seven dimensions, each scored 1-5. These map directly to `assessments` table columns.

### 1. Description Quality (description_quality)

How well does the trigger description route invocations?

| Score | Criteria |
|-------|----------|
| 1 | Single vague trigger, no examples |
| 2 | One clear trigger, missing edge cases |
| 3 | Multiple triggers, covers obvious invocations |
| 4 | Multiple triggers with examples, covers non-obvious invocations, "pushy" |
| 5 | Battle-tested routing — rarely mis-triggers, rarely missed when relevant |

**Binary checks:**
- Does the description fit in a single line? (Y/N)
- Are there 3+ trigger phrases? (Y/N)
- Does it explain when NOT to trigger? (Y/N)
- Does it reference related skills for disambiguation? (Y/N)

### 2. Output Quality (output_quality)

How well-defined is the skill's output contract?

| Score | Criteria |
|-------|----------|
| 1 | No defined output format |
| 2 | Prose guidance but no schema |
| 3 | Markdown template with sections |
| 4 | Strict schema with required fields, examples of good/bad output |
| 5 | Machine-parseable output contract usable by downstream skills/agents |

**Binary checks:**
- Is there an explicit output schema/template? (Y/N)
- Could another agent parse this output without human interpretation? (Y/N)
- Are there examples of expected output? (Y/N)

### 3. Composability (composability)

Can this skill's output feed into other skills? Can other skills feed into it?

| Score | Criteria |
|-------|----------|
| 1 | Terminal — produces output nothing consumes |
| 2 | Loosely connected — output could feed another skill with human reformatting |
| 3 | One-directional — clear input OR output contract, not both |
| 4 | Bidirectional — defined upstream sources and downstream consumers |
| 5 | Pipeline-native — part of an explicit chain with handoff contracts |

**Binary checks:**
- Does the skill name its upstream inputs? (Y/N)
- Does the skill name its downstream consumers? (Y/N)
- Is there a documented handoff format between this skill and its neighbors? (Y/N)

### 4. Agent Readiness (agent_readiness)

Could an orchestrating agent invoke this skill without human scaffolding?

| Score | Criteria |
|-------|----------|
| 1 | Requires human judgment at every step |
| 2 | Human needed for setup, autonomous execution |
| 3 | Autonomous with human approval gates at transitions |
| 4 | Fully autonomous with structured output, human optional |
| 5 | Designed for agent invocation — parameters, contracts, error handling all specified |

**Binary checks:**
- Can this skill run with only structured input (no conversational context)? (Y/N)
- Does it handle missing/ambiguous input with defaults rather than questions? (Y/N)
- Does it report confidence/uncertainty in its output? (Y/N)

### 5. Eval Coverage (eval_coverage)

How testable is this skill's output, and how much testing exists?

| Score | Criteria |
|-------|----------|
| 0 | No evaluation exists or is planned |
| 1 | Manual spot-checking only |
| 2 | Defined criteria but no automated tests |
| 3 | Partial automated coverage (some binary checks, some test cases) |
| 4 | Solid automated coverage with disaggregated pass rates |
| 5 | Full eval suite with regression tracking, runs in CI or Karpathy loop |

**Binary checks:**
- Do test cases exist for this skill? (Y/N)
- Can evaluation run without human judgment? (Y/N)
- Is there a quantitative pass rate tracked over time? (Y/N)

### 6. Usage Frequency (usage_frequency)

How often is this skill actually invoked? (Estimated or tracked)

| Score | Criteria |
|-------|----------|
| 1 | Never used / dead code |
| 2 | Used once or twice, not part of regular workflow |
| 3 | Monthly — invoked for specific project phases |
| 4 | Weekly — regular part of development workflow |
| 5 | Daily — core tool, would feel the absence immediately |

### 7. Karpathy Eligibility (karpathy_eligible)

Can an autonomous eval loop improve this skill?

| Eligible | Criteria |
|----------|----------|
| No (0) | Output is purely subjective, no measurable metric exists, or skill is too meta |
| Yes (1) | Has at least one quantifiable metric, a set of test inputs can be defined, and the skill file is the single thing to edit |

**Prerequisite checks (all must be Yes for eligibility):**
- Can you define 3+ binary yes/no tests for the output? (Y/N)
- Can you generate 20+ synthetic test inputs? (Y/N)
- Does the skill have a single editable file (SKILL.md or .md)? (Y/N)
- Is current quality in the 60-80% range (good enough to loop, bad enough to improve)? (Y/N)

---

## Layer 2: Output Evaluation Framework

For skills marked `karpathy_eligible = 1`, define eval suites using this structure.

### Test Case Structure

```yaml
skill: parallel-explore
test_cases:
  - id: tc-01
    input: "Design a caching layer for a knowledge-base search service"
    context:
      project: your-project
      constraints: ["must use existing Postgres", "no Redis"]
    assertions:
      format:
        - "Output contains '## Branch Summaries' section"
        - "Output contains '## Comparison Matrix' section"
        - "At least 2 branches produced"
      quality:
        - "Branches are genuinely different (not cosmetic variants)"
        - "Tradeoffs section names real costs, not hedged praise"
        - "Recommendation is opinionated (picks one, says why)"
      instruction_adherence:
        - "Anti-convergence instruction was followed"
        - "Normalized output schema was used by all branches"
      composability:
        - "Comparison Matrix is structured enough for /spec to consume as decision input"
```

### Assertion Categories

Borrowed from MindStudio's framework, adapted for our skill types:

| Category | What It Tests | Scoring |
|----------|--------------|---------|
| **Format** | Schema compliance, required sections, parseable structure | Binary pass/fail |
| **Quality** | Substance, depth, genuine insight vs. filler | LLM-as-judge (binary) |
| **Instruction Adherence** | Did the skill follow its own rules? | Binary pass/fail |
| **Composability** | Can the output be consumed by the next skill in the chain? | Binary pass/fail |

### Scoring

- Per-category pass rate (e.g., format: 28/30, quality: 22/30)
- Disaggregated view — never collapse to a single number
- Track over time per skill in `eval_runs` table
- Delta between runs is the Karpathy loop's optimization signal

### The Loop

```
1. Baseline: Run all test cases, score, record in eval_runs
2. Mutate: Agent edits the SKILL.md (one change per iteration)
3. Evaluate: Run all test cases again
4. Compare: If pass rate improved → keep. If degraded → revert.
5. Repeat until: convergence, time budget exhausted, or human review gate
```

**Constraints:**
- One mutation per iteration (isolates what helped)
- Time budget per iteration (5-15 min depending on skill complexity)
- Total loop budget (set before starting — e.g., 10 iterations or 2 hours)
- Human review after loop completes (debrief phase)

---

## Assessment Workflow

### Initial Audit (what we're about to do)

1. For each of 26 skills, score all 7 Layer 1 dimensions
2. Record as assessment rows with `assessed_at = now`
3. Flag `karpathy_eligible` skills
4. Rank by improvement ROI: `(potential_impact × usage_frequency) / estimated_effort`
5. Produce a prioritized improvement schedule

### Ongoing

- Re-assess after significant skill changes
- Run eval loops on eligible skills (Layer 2)
- Track eval_runs over time for trend analysis
- Quarterly full re-audit to catch drift

---

## ROI Ranking Formula

```
improvement_roi = (5 - avg_score) × usage_frequency × karpathy_multiplier
```

Where:
- `avg_score` = mean of output_quality, composability, agent_readiness, eval_coverage
- `usage_frequency` = 1-5 from assessment
- `karpathy_multiplier` = 1.5 if eligible, 1.0 if not (autonomous improvement is cheaper)

Higher ROI = work on this first.

---

*Rubric v1 — 2026-04-26*
*Sources: AI Maker (Karpathy loop), MindStudio (binary evals), Galileo (hierarchical rubrics), Murat Can Koylan (advanced-evaluation skill), heathdev skills audit March 2026*
