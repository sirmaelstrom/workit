---
name: post-mortem
description: "Run a structured campaign post-mortem after a dispatch campaign completes, fails, or is cancelled. Use this skill when the user asks to write a post-mortem, close out a campaign, do campaign closeout, review what happened in a campaign, or says 'post-mortem'. Also trigger when a campaign has just finished and the user asks 'what happened?' or wants to analyze the results. This is non-optional after every campaign — skipping it is how institutional knowledge evaporates."
---

# Post-Mortem — Campaign Closeout

Produce a structured post-mortem for a completed campaign. Gathers data from the campaign DB, git history, review artifacts, and progress log, then synthesizes into the standard template. Closes the loop by routing findings to their feed-back destinations.

## Why This Skill Exists

Campaign completion is not the end of the lifecycle. The real lifecycle is:

```
workshop → campaign → dispatch → gate → complete → review → post-mortem → feed-back
```

Everything after "complete" was historically ad-hoc. This skill makes closeout structural. Across 13 campaigns, closeout time has dropped from improvised hours to ~20 minutes — the template is muscle memory now. This skill codifies that muscle memory.

## When to Run

- **After every campaign** that reaches `completed`, `cancelled`, or `failed` status
- **After manual WP execution** if the user ran all packages and wants a formal closeout
- Campaigns that ran outside the automated pipeline (CLI sessions, manual dispatches) still deserve post-mortems — the data sources are different but the template is the same

## The Three Phases

The campaign-closeout pattern (`/workspace\projects\heathdev-patterns\patterns\campaign-closeout.md`) defines three phases. This skill guides all three.

### Phase 1: Data Collection

Gather evidence from all available sources before writing anything.

#### Campaign Database (Primary)

Query the infrastructure Postgres (port 5434, db: service, user: service):

```sql
-- Campaign overview
SELECT c.id, c.slug, c.title, c.status, c.gate_mode,
       c.created_at, c.started_at, c.completed_at,
       EXTRACT(EPOCH FROM (c.completed_at - c.started_at)) / 60 AS duration_min
FROM campaigns c
WHERE c.slug = '{slug}';

-- Wave execution timeline
SELECT w.wave_number, w.status, w.fix_attempts_used,
       w.gate_output,
       array_length(w.fix_dispatch_ids::jsonb, 1) AS fix_dispatches,
       w.started_at, w.completed_at,
       EXTRACT(EPOCH FROM (w.completed_at - w.started_at)) / 60 AS wave_min
FROM campaign_waves w
JOIN campaigns c ON w.campaign_id = c.id
WHERE c.slug = '{slug}'
ORDER BY w.wave_number;

-- Dispatch details (per WP)
SELECT cd.description, cd.project, cd.status, cd.model,
       cd.wave_number, cd.spec_path, cd.expected_files
FROM campaign_dispatches cd
JOIN campaigns c ON cd.campaign_id = c.id
WHERE c.slug = '{slug}'
ORDER BY cd.wave_number, cd.description;

-- Dispatch task details (timing, cost, token usage)
SELECT dt.id, dt.description, dt.status, dt.model,
       dt.created_at, dt.completed_at,
       EXTRACT(EPOCH FROM (dt.completed_at - dt.created_at)) / 60 AS task_min,
       dt.token_input, dt.token_output, dt.cost_usd
FROM dispatch_tasks dt
JOIN campaign_dispatches cd ON dt.id = cd.dispatch_task_id
JOIN campaigns c ON cd.campaign_id = c.id
WHERE c.slug = '{slug}'
ORDER BY dt.created_at;
```

Run via: `psql -h localhost -p 5434 -U service -d service -c "..."`. If the DB is unavailable or the campaign wasn't run through the automated pipeline, note the data gap and collect from other sources.

#### Git History

```bash
# Commits from the campaign's feature branch (if one exists)
git log --oneline --stat feature/{branch-name}

# Or from the campaign's time window
git log --oneline --after="{start-date}" --before="{end-date}" --all
```

#### Workshop Artifacts

Read from the workshop directory (`/workspace\data\outputs\workshops\{slug}\` or `.archive\{slug}\`):

- **Orchestrator** — `work-packages/_orchestrator.md` for wave plan, constraints, progress log
- **Progress log entries** — accumulated context from dispatch agents (if available)
- **Review artifacts** — `reviews/` directory for pre-dispatch spec reviews and post-dispatch code reviews
- **Spec artifacts** — for cross-referencing what was specified vs. what was built

#### PR / External Review Data

```bash
# If a PR exists for the campaign
gh pr view {pr-number} --json title,body,comments,reviews
gh pr diff {pr-number}

# External review comments (Codex, Greptile)
gh api repos/{owner}/{repo}/pulls/{pr-number}/comments
```

### Phase 2: Post-Mortem Synthesis

Write the post-mortem using the template at `/workspace\projects\heathdev-patterns\templates\post-mortem.template.md`. The template defines the canonical structure — follow it. Read it fresh each time; don't work from memory.

Key sections and what feeds them:

#### Campaign Summary
Fill the summary table from DB data. Include: slug, campaign number (check the cross-campaign analysis doc for the next number), objective, duration, result, status, gate mode, test counts, projects.

To determine the campaign number, read the header of `/workspace\data\outputs\projects\architecture\campaign-run-post-mortem-analysis.md` for the list of numbered campaigns.

#### Timeline
Build from DB timestamps (campaign started, wave released, WP completed, gate passed/failed, manual interventions, campaign complete). Supplement with progress log entries if they contain timing info.

#### Campaign Stats
Compute from DB: WP count, wave count, repos, dispatch failures, gate failures, fix dispatches, merge conflicts, turn exhaustions, manual interventions, autonomous rate, campaign attempts, test counts, files/lines changed.

#### Lifecycle Cost Breakdown
Campaign dispatch cost comes from the DB. Other phases are estimates:
- Workshop creation: estimate from planning session count and model (Opus ~$0.25-0.50/min)
- Review council: estimate from council output or ~$2-5 per run
- Dispatch: actual from DB
- Closeout: this session
- Follow-up fixes: if any

Include both lifecycle total (estimated) and dispatch-only total (from DB) for cross-campaign comparison compatibility.

#### Key Commits
Extract from git log. List significant commits with conventional commit messages.

#### What Was Delivered
Not WP titles — what the user actually got. Concrete deliverables.

#### Findings
The most important section. For each finding:
- Number sequentially (Finding 1, 2, 3...)
- Type: NEW FAILURE CLASS / BUG / PROCESS GAP / OBSERVATION
- Severity: P1 / P2 / Advisory
- Status: Fixed (with commit hash) / UNFIXED (with reason) / Deferred (with destination)
- Narrative: what happened, root cause, impact, follow-up

Look for findings in: gate failures, dispatch failures, progress log surprises, review artifacts, code review comments, manual interventions.

#### Code Review
Summarize review wave findings. Reference review artifacts in `reviews/`. Note what would have shipped without review.

#### Analysis
What worked, what broke, individual WP performance (optional but valuable for campaigns with variance).

#### Constraint Assessment
Evaluate constraints from the orchestrator:
- **Held** — constraints that correctly prevented failure modes
- **Missed** — things discovered during execution that should have been constrained
- **Overconstrained** — constraints that caused unnecessary friction
- **Domain knowledge discovered** — new understanding applicable beyond this campaign

Each missed/discovered constraint gets a routing destination (CONSTRAINTS.md, CLAUDE.md, pattern library).

#### Cross-Campaign Comparison
Fill in this campaign's row of stats. Do NOT copy the full matrix — that lives at `/workspace\data\outputs\projects\architecture\campaign-run-post-mortem-analysis.md`.

### Phase 3: Feed-Back

This is the step that closes the loop. Present the feed-back checklist and work through it with the user:

- [ ] Cross-campaign comparison matrix updated
- [ ] Pattern Execution Feedback sections updated (list which patterns)
- [ ] Constraint Assessment completed — missed/discovered constraints encoded
- [ ] CORRECTIONS.md updated (if agent mistakes found)
- [ ] LESSONS.md updated (if new insights)
- [ ] Infrastructure fixes applied (if any)
- [ ] Follow-up workshops created (if needed)
- [ ] Workshop archived (move to `.archive/`)

For each feed-back item, offer to execute it directly (append to pattern file, update CORRECTIONS.md, move workshop to archive) or note it as deferred.

## Saving the Post-Mortem

Write to: `/workspace\data\outputs\workshops\{slug}\post-mortem.md` (or `.archive\{slug}\` if already archived).

## Archiving the Workshop

After the post-mortem and feed-back are complete, move the workshop to `.archive/`:

```bash
mv "/workspace/data/outputs/workshops/{slug}" "/workspace/data/outputs/workshops/.archive/{slug}"
```

Update `meta.json` status to `"archived"` before moving.

## Campaigns Without DB Records

Some campaigns run outside the automated pipeline (manual CLI dispatches, `/execute-wp` skill). These still deserve post-mortems. Data sources shift:

- **No DB data** — use progress log entries for timeline and outcomes
- **No automatic timing** — estimate from session timestamps
- **No cost data** — estimate from model and duration
- **Git history** — still available and often the best source

Note the data limitations in the post-mortem. Partial post-mortems are better than no post-mortems.

## Relationship to Other Skills

- **`/execute-wp`** produces progress log entries that feed the timeline and findings
- **`/scorecard`** evaluates spec quality — complementary, not redundant. Scorecard grades the spec's predictive power; post-mortem documents what actually happened. Run both for maximum learning.
- **`/workshop`** created the spec artifacts being evaluated
- **`/spec-validate`** catches structural issues pre-dispatch that the post-mortem would flag post-dispatch
