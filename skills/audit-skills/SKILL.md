---
name: audit-skills
description: "Score skills against the evaluation rubric and write results to skills.db. Use when the user says 'audit skills', 'score my skills', 'skill health check', 'rate skills', 'how are my skills', or wants to assess skill quality across plugins. Also trigger when a significant skill change just shipped and needs reassessment. NOT for running skills against test cases to improve them (that's eval-loop) or grading workshop specs (that's scorecard)."
---

# Audit Skills — Structural Assessment Against Rubric

Score every skill in a plugin's `skills.db` against the 7-dimension evaluation rubric. Produces a ranked inventory with improvement priorities. This is Layer 1 — reading and judging skill definitions, not running them.

## Why This Exists

Without periodic structured assessment, skill quality drifts invisibly. The March 2026 audit found zero evals, weak agent-readiness, and lopsided tier coverage — all problems that accumulate silently. This skill makes the health check repeatable and the results queryable.

## Dependencies

**Upstream (required inputs):**
- `skills.db` at the target project root — seeded by `scripts/init-skills-db.mjs`
- Rubric definition: `/workspace/data/outputs/projects/skills/skill-evaluation-rubric.md` — read this, don't re-derive it

**Downstream (consumers of this skill's output):**
- **eval-loop** — reads `karpathy_eligible` flag and assessment scores to select improvement targets
- **Human review** — reads the markdown report for prioritization decisions

## Process

### 1. Target Selection

Determine scope in a single pass:

- **Default:** Audit ALL active skills in the current project's `skills.db`
- **Specific:** If user names skills, audit only those
- **Cross-plugin:** If user says "audit everything" or "all plugins", iterate both `heathdev-workshop-plugin/skills.db` and `sirmaelstroms-claude-code/skills.db`

Read the skill inventory from the database:
```sql
SELECT id, name, kind, plugin FROM skills WHERE status = 'active' ORDER BY kind, id;
```

### 2. Read Each Skill Definition

For each skill in scope:
- **heathdev-workshop skills:** Read `skills/<id>/SKILL.md`
- **sirmaelstroms-claude-code commands:** Read `commands/<category>/<name>.md` (parse category from id prefix `cmd:<category>:<name>`)
- **sirmaelstroms-claude-code agents:** Read `agents/<category>/<name>.md` (parse category from id prefix `agent:<category>:<name>`)

### 3. Score Against Rubric

For each skill, evaluate all 7 dimensions. Use the rubric's Likert scales AND binary checks together — the binary checks ground the score to observable evidence.

**Scoring discipline:**
- Score the binary checks FIRST, then derive the Likert score from the pattern
- If 0/4 binary checks pass, the score cannot be above 2
- If 4/4 binary checks pass, the score should be at least 4
- Record specific evidence for each score — "description has 5 trigger phrases" not just "good description"

**Per-skill output (internal, before writing to DB):**

```
Skill: parallel-explore
Plugin: heathdev-workshop
Kind: skill

description_quality: 4
  - Single line: Y | 3+ triggers: Y | Explains when NOT: N | References related: Y
  - Evidence: 6 trigger phrases, references design-alternatives replacement, missing negative trigger

output_quality: 4
  - Explicit schema: Y | Agent-parseable: Y | Examples: N
  - Evidence: Strict normalized output schema for branches + synthesis template

composability: 3
  - Names upstream: N | Names downstream: N | Handoff format: Y
  - Evidence: Output schema is well-defined but no explicit pipeline connections documented

agent_readiness: 3
  - Structured input only: Y | Defaults for ambiguity: Y | Reports confidence: N
  - Evidence: Handles vague input with 3-variant default, cost check gate requires human

eval_coverage: 0
  - Test cases exist: N | Automated eval: N | Pass rate tracked: N

usage_frequency: 2
  - Used twice since creation, not part of regular workflow yet

karpathy_eligible: 1
  - 3+ binary tests definable: Y | 20+ test inputs: Y | Single file: Y | 60-80% quality: Y

confidence: [high|medium|low] per dimension
  - high: 3+ binary checks agree clearly, no borderline calls
  - medium: binary checks agree but evidence is thin or context-dependent
  - low: binary checks split or score could reasonably be +/- 1
```

### 4. Write to Database

For each scored skill, insert an assessment row:

```sql
INSERT INTO assessments (
  skill_id, assessed_at,
  output_quality, description_quality, composability,
  agent_readiness, eval_coverage, usage_frequency,
  karpathy_eligible, notes, gaps, next_actions
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
```

- `assessed_at` = ISO timestamp
- `gaps` = JSON array of identified weaknesses
- `next_actions` = JSON array of concrete improvement steps

### 5. Compute ROI Rankings

After all assessments are written, compute improvement priority:

```
improvement_roi = (5 - avg_score) × usage_frequency × karpathy_multiplier
```

Where:
- `avg_score` = mean of (output_quality, composability, agent_readiness, eval_coverage)
- `karpathy_multiplier` = 1.5 if eligible, 1.0 if not

### 6. Produce Report

Output a summary table sorted by ROI descending:

```markdown
# Skill Audit Report — [date]

## Summary
- Skills assessed: N
- Average score: X.X / 5.0
- Karpathy-eligible: N of M
- Highest ROI: [skill name]

## Rankings

| Rank | Skill | Plugin | Kind | Desc | Output | Comp | Agent | Eval | Freq | K-Elig | Conf | ROI |
|------|-------|--------|------|------|--------|------|-------|------|------|--------|------|-----|
| 1 | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | H/M/L | ... |

## Top 5 Improvement Actions
1. [Skill]: [specific action] (addresses [gap], est. ROI impact: +X)
2. ...

## Karpathy Loop Candidates (ready for eval-loop)
- [skill]: [why eligible, suggested first metric]
- ...

## Trend (if prior assessments exist)
[Compare to last assessment: improved, degraded, stable per skill]
```

## Invocation

**Quick:**
```
/audit-skills
```

**Scoped:**
```
/audit-skills parallel-explore diagnose spec
```

**Cross-plugin:**
```
/audit-skills --all
```

## Output Schema

The report above IS the output. It goes to stdout (conversation) AND gets saved to:
- `skills.db` → `assessments` table (structured, queryable)
- `data/outputs/projects/skills/audit-[date].md` (human-readable snapshot)

## Anti-patterns

- Scoring without reading the actual SKILL.md (using memory of what a skill does)
- Inflating scores — "everything's a 3" means the binary checks weren't done first
- Skipping the ROI ranking — assessment without prioritization is a report that gathers dust
- Auditing without writing to the database — the whole point is queryable, versioned data
- Re-deriving the rubric instead of reading it from the reference file

<supporting_info>

## Relationship to Other Skills

- **eval-loop** — primary consumer; reads `karpathy_eligible` flag and assessment scores to select improvement targets
- **improve-architecture** — adjacent but different scope; targets codebases, not skill definitions
- **scorecard** — sibling pattern (structured evaluation against rubric) but targets workshop specs, not skills
- **diagnose** — no direct relationship, but shares the "structured assessment before action" philosophy

---
*Origin: Karpathy Loop research briefing (2026-04-26), skills audit March 2026, rubric v1 synthesized from AI Maker, MindStudio, Galileo, and Murat Can Koylan frameworks.*

</supporting_info>
