# {Workshop Title} — Post-Mortem

<!-- Template based on the campaign-closeout pattern (patterns/campaign-closeout.md).
     Produced after every campaign reaches completed, cancelled, or failed status.
     Non-optional — skipping this is how institutional knowledge evaporates.

     Three phases: Review Wave → Post-Mortem (this doc) → Feed-Back
     Feed-back routes findings to: pattern Execution Feedback sections,
     CORRECTIONS.md, LESSONS.md, and the cross-campaign comparison matrix
     at outputs/architecture/campaign-run-post-mortem-analysis.md -->

## Campaign Summary

| Field | Value |
|-------|-------|
| **Campaign** | {slug} |
| **Campaign #** | {N} (Nth campaign through the dispatch pipeline) |
| **Objective** | {One-line description of what was delivered} |
| **Duration** | {Total wall time, note if multiple attempts} |
| **Result** | {N/N work packages completed} |
| **Status** | {Merged to master / Cancelled / Failed} |
| **Gate mode** | {auto / review / mixed — note per-wave if mixed} |
| **Tests** | {Test count at completion (and at start if notable)} |
| **Projects** | {project names} |

---

## Timeline

<!-- Timestamped event log. Include: campaign start, wave releases,
     WP completions (with duration), gate passes/failures, fix attempts,
     manual interventions, campaign end. Use UTC or local with label. -->

| Time | Event |
|------|-------|
| {time} | Campaign started, Wave 1 released ({WP list}) |
| {time} | {WP-NN} complete ({duration}) |
| {time} | Wave 1 gate {passed/failed} — {detail if failed} |
| {time} | Wave 2 released ({WP list}) |
| ... | ... |
| {time} | Campaign complete |

---

## Campaign Stats

| Metric | Value |
|--------|-------|
| Work packages | {count} |
| Waves | {count} |
| Repos | {count} ({names}) |
| Dispatch failures | {count} ({detail}) |
| Gate failures | {count} ({type}) |
| Auto-fix dispatches | {count} ({successful/failed}) |
| Merge conflicts | {count} |
| Turn exhaustions | {count} |
| Manual interventions | {count} ({brief description}) |
| Autonomous rate | {N/N WPs} ({percentage}) |
| Campaign attempts | {count} |
| Tests at start | {count} |
| Tests at merge | {count} (+{delta}) |
| Files changed | {count} |
| Lines changed | +{added}/-{removed} |

---

## Lifecycle Cost Breakdown

<!-- Campaign "cost" is more than dispatch cost. This section captures the full
     lifecycle cost of delivering the feature — from initial planning through
     closeout. Dispatch cost comes from the DB. Other phases are manual estimates
     based on session duration and model used.

     Estimation guide:
     - Opus conversation: ~$0.25–0.50/minute of active exchange
     - Sonnet sub-agents: ~$0.05–0.15/minute
     - Review council (3-model): estimate from council output or ~$2–5 per run
     - If your dispatch service gains session-level cost tracking, replace estimates with actuals.

     The goal is visibility, not precision. A 2x estimate is better than
     a missing row — it still surfaces the blind spot. -->

| Phase | Cost | Source | Notes |
|-------|------|--------|-------|
| Workshop creation (spec) | ~${N} | Estimate | {N} planning sessions, Opus |
| Review council (pre-dispatch) | ~${N} | Estimate | {R1/R2 review passes} |
| Dispatch (campaign execution) | ${N} | DB | {N} dispatches |
| Closeout (post-mortem) | ~${N} | Estimate | {This session} |
| Follow-up fixes | ~${N} | Estimate | {Ad-hoc fix sessions, if any} |
| **Lifecycle total** | **~${N}** | | |
| **Dispatch-only total** | **${N}** | DB | {For cross-campaign comparison compatibility} |

---

## Key Commits

<!-- List the significant commits from the campaign, across all repos. -->

- `{hash}` — {conventional commit message}
- `{hash}` — {conventional commit message}

---

## What Was Delivered

<!-- Numbered list of concrete deliverables. Not WP titles —
     what the operator actually got. -->

1. {Deliverable}
2. {Deliverable}

---

## Findings

<!-- Each finding gets its own subsection. Number them sequentially.
     Include: severity, status (fixed/unfixed/deferred), narrative,
     root cause, impact, and follow-up.

     Finding types:
     - NEW FAILURE CLASS — a failure mode not seen in previous campaigns
     - BUG — code defect discovered during or after execution
     - PROCESS GAP — missing check, validation, or workflow step
     - OBSERVATION — pattern worth noting, no immediate action required -->

### Finding 1: {Title}

**Type:** {New failure class / Bug / Process gap / Observation}
**Severity:** {P1 / P2 / Advisory}
**Status:** {Fixed — commit {hash} / UNFIXED — {reason} / Deferred — {where}}

**What happened:** {Narrative description}

**Root cause:** {Why it happened}

**Impact:** {What broke, how much time was lost, what was the blast radius}

**Follow-up:** {What needs to happen next — fix, workshop, process change}

### Finding 2: {Title}

{Same structure as above}

---

## Code Review

<!-- Summary of the review wave findings. Reference the review artifacts
     in the workshop's reviews/ directory. -->

**Review method:** {Multi-model / single-model / wave-based — describe structure}

**Review artifacts:** `{workshop-slug}/reviews/{review-N}/`

| Severity | Count | Key Findings |
|----------|-------|-------------|
| P1 | {N} | {Brief list} |
| P2 | {N} | {Brief list} |
| Advisory | {N} | {Brief list} |

<!-- Note any findings that would have shipped without review — this is
     the review council's value proposition. -->

**Would have shipped without review:** {Yes/No — what specifically}

---

## Analysis

### What Worked

- {Positive pattern — be specific, reference data}
- {Another positive pattern}

### What Broke

- {Failure — root cause, not just symptom}
- {Another failure}

### Individual WP Performance

<!-- Optional but valuable for campaigns with variance. -->

| WP | Duration | Notes |
|----|----------|-------|
| WP-01 | {duration} | {Straightforward / complex / failed + retried} |
| WP-02 | {duration} | {Notes} |

---

## Constraint Assessment

<!-- Evaluate the quality of constraints in this campaign's spec.
     The goal is to close the loop: did we know enough to specify well?
     What did we learn that should persist?

     Route each missed or discovered constraint to its encoding destination:
     - Project-specific → project's CONSTRAINTS.md
     - Agent behavior → CLAUDE.md corrections
     - Cross-project → pattern library (if recurs in 2+ projects)

     See: constraint-discovery pattern (patterns/constraint-discovery.md) -->

### Constraints That Held
<!-- Constraints in the spec that correctly prevented failure modes.
     Evidence that specification was working. -->

- {Constraint} — prevented {failure mode}

### Constraints Missed
<!-- Things discovered during implementation or review that should have
     been in the spec. Each one is a future constraint to encode. -->

- {Discovery} — would have prevented {issue} if specified upfront
  → Encoded to: {project CONSTRAINTS.md / CLAUDE.md / pattern library}

### Constraints Overconstrained
<!-- Constraints that caused unnecessary friction — too restrictive,
     based on wrong assumptions, or no longer relevant. -->

- {Constraint} — caused {friction} because {reason}
  → Recommendation: {relax / remove / rephrase}

### Domain Knowledge Discovered
<!-- New understanding about how the codebase/domain works, learned
     during this campaign. Valuable beyond this ticket. -->

- {Insight} — applicable to {scope}
  → Encoded to: {location}

---

## Cross-Campaign Comparison

<!-- DO NOT copy the full comparison matrix here. The centralized matrix lives at:
     outputs/architecture/campaign-run-post-mortem-analysis.md
     (split into eras of ~4 campaigns each).

     Instead, include ONLY this campaign's stats for easy reference,
     and update the centralized analysis doc in the Feed-Back step. -->

| Dimension | **C{N} ({slug})** |
|-----------|-------------------|
| Work packages | **{N}** |
| Waves | **{N}** |
| Duration | **{duration}** |
| Repos | **{N}** |
| Dispatch failures | **{N}** |
| Gate failures | **{N}** |
| Merge failures | **{N}** |
| Manual interventions | **{N}** |
| Autonomous rate | **{N}%** |
| Tests at end | **{N}** |
| Dispatch cost | **${N}** |
| Lifecycle cost (est.) | **~${N}** |

---

## Follow-Up Items

<!-- Concrete next actions. Each should have a clear owner/destination:
     - Infrastructure fix → immediate (before next campaign)
     - Pattern insight → append to pattern's Execution Feedback section
     - Process gap → update campaign-closeout or relevant pattern
     - Agent mistake → CLAUDE.md or CORRECTIONS.md
     - Cross-campaign metric → update campaign-run-post-mortem-analysis.md -->

1. **{Item}** — {destination: fix / pattern update / workshop / process change}
2. **{Item}** — {destination}

---

## Feed-Back Checklist

<!-- Track that findings were actually routed to their destinations.
     This is the step that closes the loop. Without it, post-mortems
     are documentation. With it, they're evolution. -->

- [ ] Cross-campaign comparison matrix updated (`campaign-run-post-mortem-analysis.md`)
- [ ] Pattern Execution Feedback sections updated (list which patterns)
- [ ] Constraint Assessment completed — missed/discovered constraints encoded to destinations
- [ ] CORRECTIONS.md updated (if agent mistakes found)
- [ ] LESSONS.md updated (if new insights)
- [ ] Infrastructure fixes applied (if any)
- [ ] Follow-up workshops created (if needed)
- [ ] Workshop archived

---

*Post-mortem written: {date}*
*Campaign #{N} in the dispatch pipeline series*
