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
- Rubric definition: `${CLAUDE_SKILL_DIR}/reference/skill-evaluation-rubric.md` (bundled with this skill) — read this, don't re-derive it

**Downstream (consumers of this skill's output):**
- **eval-loop** — reads `karpathy_eligible` flag and assessment scores to select improvement targets
- **Human review** — reads the markdown report for prioritization decisions

## Process

### 1. Target Selection

Determine scope in a single pass:

- **Default:** Audit ALL active skills in the current project's `skills.db`
- **Specific:** If user names skills, audit only those
- **Cross-plugin:** If user says "audit everything" or "all plugins", iterate the `skills.db` of each plugin repo under the projects root

Read the skill inventory from the database:
```sql
SELECT id, name, kind, plugin FROM skills WHERE status = 'active' ORDER BY kind, id;
```

### 2. Read Each Skill Definition

For each skill in scope:
- **Skills:** Read `skills/<id>/SKILL.md`
- **Flat-file agents (if present):** Read `agents/<category>/<name>.md` (parse category from id prefix `agent:<category>:<name>`)

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

### 7. Emit `scorecard.json` and Render HTML

After the markdown report is written, also emit a structured `scorecard.json` next to it and invoke the renderer to produce the HTML view. The HTML is the human viewing surface; the markdown remains canonical and git-trackable.

#### Output layout

For an audit run with timestamp `{YYYYMMDD-HHMMSS}` written to `data/outputs/projects/skills/`:

```
data/outputs/projects/skills/
  audit-{YYYYMMDD-HHMMSS}.md     # markdown report (existing, canonical)
  audit-{YYYYMMDD-HHMMSS}.json   # scorecard.json (renderer input)
  audit-{YYYYMMDD-HHMMSS}.html   # rendered HTML (renderer output)
```

The renderer derives the `.html` (and a normalized `.md`) from the `.json`. To avoid filename collision with the existing canonical markdown, prefer this convention: write the structured JSON adjacent to the existing markdown report, and direct the renderer at a dedicated `audit-{stamp}/` sub-directory whose `scorecard.md` is the renderer's normalized view (a one-line `[Full report](../audit-{stamp}.md)` link is fine in the canonical .md to point at the renderer output if needed).

The simpler alternative — used here — is to write everything into a fresh sub-directory:

```
data/outputs/projects/skills/audit-{YYYYMMDD-HHMMSS}/
  scorecard.json         # the skill writes here in step 7
  scorecard.md           # the renderer writes here
  scorecard.html         # the renderer writes here
```

#### JSON schema reference

The skill must emit a valid `scorecard.json` conforming to v1.0. Full schema: `skills/audit-skills/tests/fixtures/scorecard-schema.md`. The minimum the skill needs to know to produce a valid emit:

- Top-level: `schema_version: "1.0"`, `run_slug: "audit-{YYYYMMDD}-{HHMMSS}"`, `created_at` (ISO-8601), `plugins[]`, `summary {skills_assessed, average_score, karpathy_eligible_count, highest_roi_skill_id}`, `dimensions[]`, `skills[]`, `top_actions[]`.
- `dimensions[]` entries: `{id, label, kind}` where `kind` is `"likert5"` | `"eval_coverage"` | `"karpathy"`. Order is the column order in the HTML grid.
- `skills[]` entries: `{id, name, plugin, kind, rank, roi, karpathy_eligible, scores, notes, gaps, next_actions}`.
- `skills[].scores` is keyed by `dimensions[].id`. Every dimension must have an entry. Each entry: `{score, confidence: "high"|"medium"|"low", binary_checks: [{label, passed}], evidence}`.
- `top_actions[]` entries: `{rank, skill_id, action_text, addresses?, est_roi_delta?, send_prompt_template}`. The template supports tokens `{rank}`, `{skill_id}`, `{skill_name}`, `{action_text}`, `{scorecard_md_path}`.
- Cross-field rules the renderer enforces: every `dimensions[].id` appears in every `skills[].scores`; every `top_actions[].skill_id` and `summary.highest_roi_skill_id` matches a `skills[].id`; every `skills[].plugin` appears in `plugins[]`.

A working example fixture lives at `skills/audit-skills/tests/fixtures/scorecard-example.json`.

#### Renderer invocation

After writing `scorecard.json`, invoke (from any working directory):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/render-scorecard.mjs" \
  --input "./outputs/projects/skills/audit-{stamp}/scorecard.json" \
  --output-dir "./outputs/projects/skills/audit-{stamp}"
```

The renderer:
- Validates the JSON against the v1.0 schema (three-layer validation; fails loudly on invalid input — non-zero exit + stderr).
- Writes `scorecard.md` and `scorecard.html` into `--output-dir`.
- Output is deterministic given fixed JSON input AND fixed `--output-dir` (two runs on the same input produce byte-identical files).
- Single-file HTML — no external assets, system fonts only.

#### Chat output

After the renderer succeeds, point the operator at `scorecard.html` (one line — do not paste audit content into chat that the HTML already shows). The HTML's "Send to agent" buttons let the operator copy a follow-up prompt for any of the top improvement actions; that prompt expects to be pasted into a new chat, not consumed in this one.

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

The audit produces four artifacts per run:
- `skills.db` → `assessments` table (structured, queryable, append-only across runs).
- `data/outputs/projects/skills/audit-{stamp}/scorecard.json` (structured renderer input; v1.0 schema documented at `skills/audit-skills/tests/fixtures/scorecard-schema.md`).
- `data/outputs/projects/skills/audit-{stamp}/scorecard.md` (canonical human-readable snapshot, rendered from the JSON — replaces the old `audit-[date].md` location).
- `data/outputs/projects/skills/audit-{stamp}/scorecard.html` (single-file viewing surface with collapsible per-dimension evidence and "Send to agent" buttons for top improvement actions).

The chat-side output is short: the rank-1 skill, the top improvement action, and pointers to the JSON and HTML paths. The full report lives in the files, not in chat scrollback.

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
