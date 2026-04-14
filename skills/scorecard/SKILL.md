---
name: scorecard
description: "Use when the user asks to score a spec, evaluate spec quality, run a scorecard, grade a campaign, review how well a spec predicted execution, or says 'scorecard'. Also trigger when the user mentions post-dispatch evaluation, spec grading, or wants to understand why a campaign needed rework."
---

# Scorecard — Post-Dispatch Spec Quality Evaluation

Evaluate how well a specification predicted actual execution outcomes. Produces a structured 100-point score across 5 dimensions, a deviation log with root-cause analysis, and actionable feed-back routing. This is evaluation-loop Layer 1 made concrete.

## Why This Skill Exists

Specs that "pass" verification can still be mediocre. A campaign completes 11/11 WPs but three needed rework that isn't tracked anywhere. Without structured evaluation, the same under-specification patterns repeat across campaigns. The scorecard captures the gradient between "failed" and "excellent" — and routes findings to the places that prevent recurrence.

## When to Run

- **After every campaign** that reaches completed, cancelled, or failed status
- **After manual WP execution** (via `/execute-wp`) when you want to evaluate the spec, not just the code
- **When investigating why a dispatch needed rework** — the deviation log is the diagnostic tool
- **Retrospectively** — older campaigns can be scored if post-mortem data exists

## Data Sources

The scorecard draws from multiple sources. Gather what's available before scoring — the more evidence, the more accurate the score.

### From the Workshop Directory

The workshop lives at `/workspace\data\outputs\workshops\{slug}\` (or `.archive\{slug}\` for completed campaigns).

1. **Spec artifacts** — problem-statement.md, decisions.md, verification.md, constraints.md, decomposition.md
2. **Work packages** — `work-packages/*.md` and `_orchestrator.md`
3. **Post-mortem** — `post-mortem.md` (if campaign-closeout was done). This is the richest source: timeline, findings, stats, analysis.
4. **Review artifacts** — `reviews/` directory. Pre-dispatch spec reviews and post-dispatch code reviews.
5. **Progress log** — entries in `_orchestrator.md` (if the progress log pattern was used). Shows cross-dispatch context flow.

### From the Campaign Database

Query the infrastructure Postgres (port 5434) for campaign execution data:

```sql
-- Campaign overview
SELECT id, slug, title, status, gate_mode,
       created_at, started_at, completed_at,
       EXTRACT(EPOCH FROM (completed_at - started_at)) / 60 as duration_minutes
FROM campaigns
WHERE slug = '{campaign-slug}';

-- Wave execution details
SELECT w.wave_number, w.status, w.gate_output, w.fix_attempts_used,
       w.started_at, w.completed_at,
       EXTRACT(EPOCH FROM (w.completed_at - w.started_at)) / 60 as wave_minutes
FROM campaign_waves w
JOIN campaigns c ON w.campaign_id = c.id
WHERE c.slug = '{campaign-slug}'
ORDER BY w.wave_number;

-- Dispatch details per WP
SELECT cd.description, cd.project, cd.status, cd.model, cd.spec_path,
       cd.wave_number, cd.expected_files
FROM campaign_dispatches cd
JOIN campaigns c ON cd.campaign_id = c.id
WHERE c.slug = '{campaign-slug}'
ORDER BY cd.wave_number, cd.description;
```

Use `psql` via Bash: `psql -h localhost -p 5434 -U service -d service -c "..."`. If the DB isn't available, score from artifacts alone — note the data gap.

### From the Codebase

For scope adherence scoring, compare what the spec said to what actually changed:

```bash
# If the campaign has a feature branch with merged commits
git log --stat feature/{branch-name}..main  # or check the post-mortem's Key Commits
```

## The Evaluation Process

### Step 1: Identify the Workshop

Determine which workshop to score. The user might name it directly, reference the most recent campaign, or have it in viewport context. Find the workshop directory and confirm it has executed (status: `ready` with a post-mortem, or archived).

### Step 2: Gather Evidence

Read in order of richness:
1. Post-mortem (if it exists — this is the most concentrated source)
2. Orchestrator (constraints, progress log, wave plan)
3. Work package specs (what was specified)
4. Review artifacts (what reviewers found)
5. Campaign DB data (timing, failure counts, dispatch details)

Don't score until you've absorbed the available evidence. Scoring from spec artifacts alone (without execution data) produces a structural review, not a quality evaluation — note the limitation.

### Step 3: Score Each Dimension

The scorecard has 5 dimensions, 4 aspects each, on a 1-5 scale (3 = acceptable). Total: 100 points.

Use the template at `/workspace\projects\heathdev-patterns\operational\spec-scorecard.md` as the scoring framework. For each dimension:

#### 1. Structural Clarity (Did the agent know what to do?) — /20
*Evaluates: decomposition, constraint-architecture, decision-resolution*

- **Work package ordering** — Were dependencies correct? Did any WP block on unmet preconditions?
- **Scope boundaries** — Did agents stay in scope? Check post-mortem findings for scope violations.
- **Ambiguity** — Did agents have to guess intent? Look for progress log "Surprises" entries that indicate spec gaps.
- **Reference files** — Were listed files sufficient? Did agents need to discover unlisted files?

#### 2. Specification Precision (Was the right thing built?) — /20
*Evaluates: spec-engineering, work-package, decision-resolution*

- **Code snippets** — Were implementation examples followed accurately?
- **Naming/conventions** — Did output match spec conventions?
- **Design decisions** — Were decisions respected, or did agents re-decide?
- **Edge cases** — Were they anticipated in the spec?

#### 3. Execution Efficiency (Was work wasted?) — /20
*Evaluates: wave-execution, work-package self-containment*

- **Rework** — How many packages needed correction? (Check fix_attempts_used in DB, post-mortem findings)
- **Token burn** — Was session length proportional to work? (Check duration vs. WP count)
- **Parallelization** — Were packages that could run in parallel correctly grouped?
- **Tool use** — Was tool usage efficient? (Harder to measure — infer from execution time)

#### 4. Guardrail Effectiveness (Were mistakes prevented?) — /20
*Evaluates: constraint-architecture, test-first-spec, corrections-loop*

- **Critical guardrails** — Were "DO NOT" (must-not) items respected?
- **Verification steps** — Did per-package verification catch issues before gates?
- **CLAUDE.md corrections** — Were project-specific traps avoided?
- **Build verification** — Did gate commands catch real problems vs. passing vacuously?

#### 5. Completeness (Did we get what we asked for?) — /20
*Evaluates: post-build-verification*

- **Feature completeness** — All work packages done?
- **Visual fidelity** — Does output match design intent? (UI campaigns)
- **Integration** — Does it work in the full app context?
- **Polish** — Rough edges, missing transitions, broken states?

**Scoring guidelines:**
- **5** = Exemplary — would cite as a model. Requires evidence.
- **4** = Good — worked well with minor issues
- **3** = Acceptable — got the job done, some friction
- **2** = Weak — significant issues. Requires evidence.
- **1** = Failed — this aspect didn't work. Requires evidence.

### Step 4: Build the Deviation Log

For every point where execution deviated from the spec, log it with root cause:

| Package | Deviation | Root Cause | Spec Change Needed? |
|---------|-----------|------------|---------------------|
| WP-03 | Modified file not in spec's Files list | **Missing** — consumer of changed interface wasn't listed | Yes — add consumer audit |
| WP-07 | Used inline styles instead of CSS classes | **Ambiguous** — spec didn't specify styling approach | Yes — add to Preferences |

Root cause categories (from the scorecard template):
- **Ambiguous** — spec could be read multiple ways. Fix: tighten with decision-resolution.
- **Missing** — spec didn't cover this case. Fix: add to work package or constraints.
- **Wrong** — spec assumed something false. Fix: correct the assumption.
- **Agent error** — spec was clear, agent didn't follow it. Fix: add to corrections-loop / CLAUDE.md.

The root cause distribution is often more informative than the score itself. A campaign that's 80% "Missing" has a different problem than one that's 80% "Agent error."

### Step 5: Generate Improvement Actions

Based on deviations and low-scoring dimensions, produce specific actions in 5 categories:

1. **Over-specified** — remove or loosen constraints that caused unnecessary friction
2. **Under-specified** — add detail, examples, or guardrails where specs were insufficient
3. **Wrong assumptions** — correct spec assumptions that proved false
4. **Missing guardrails** — add must-nots or escalation triggers for unexpected agent behavior
5. **Structural changes** — reorder packages, split/merge, adjust wave grouping

### Step 6: Route Feed-Back

The scorecard is only valuable if findings flow to their destinations. For each finding, identify where it should go:

| Finding Type | Destination |
|-------------|-------------|
| Pattern insight | Append to pattern's "Execution Feedback" section in `/workspace\projects\heathdev-patterns\patterns\` |
| Agent mistake | Add to project's CLAUDE.md via corrections-loop |
| Recurring spec gap | Update `work-package` or `constraint-architecture` pattern |
| Process improvement | Update the scorecard template |
| Cross-campaign metric | Update `/workspace\data\outputs\projects\architecture\campaign-run-post-mortem-analysis.md` |

Present the routing table and ask the user which feed-back actions to execute now vs. defer.

### Step 7: Save the Scorecard

Write the completed scorecard to the workshop directory:
- **Active workshop:** `/workspace\data\outputs\workshops\{slug}\scorecard.md`
- **Archived workshop:** `/workspace\data\outputs\workshops\.archive\{slug}\scorecard.md`

## Output Format

Present the scorecard as a structured report. The spec-scorecard template (`/workspace\projects\heathdev-patterns\operational\spec-scorecard.md`) defines the canonical format — follow it. Key sections:

1. **Target** — workshop, model, completion stats, date
2. **Scoring tables** — 5 dimensions with aspect scores and notes
3. **Overall score** with assessment band (85-100 Excellent, 70-84 Good, 55-69 Acceptable, 40-54 Weak, <40 Failed)
4. **Deviation log** — every spec-vs-reality mismatch with root cause
5. **Improvement actions** — categorized by type
6. **Feed-back routing** — where findings go
7. **Meta-observations** — things learned about specifying in general

## Score Interpretation

Don't optimize for high scores — optimize for learning rate. An 80/100 with 5 well-diagnosed deviations is more valuable than a 95/100 where nothing was learned. The score is a snapshot; the deviations and feed-back actions are the compound interest.

Across campaigns, track:
- **Score trends** — are specs getting better?
- **Root cause distribution shifts** — are we reducing "Missing" over time?
- **Dimension patterns** — which dimension is consistently weakest?
- **Feed-back completion rate** — are findings actually getting routed?

## Relationship to Other Skills

- **`/workshop`** produces the spec artifacts that this skill evaluates
- **`/spec-validate`** checks structural quality *before* dispatch. Scorecard checks *predictive* quality after.
- **`/execute-wp`** produces progress log entries that feed into scorecard evidence
- The scorecard instantiates evaluation-loop Layer 1 from `/workspace\projects\heathdev-patterns\patterns\evaluation-loop.md`
- Post-mortems (from campaign-closeout pattern) are the primary data source — scorecard and post-mortem are complementary, not redundant
