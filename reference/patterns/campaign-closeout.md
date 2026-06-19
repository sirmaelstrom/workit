# Pattern: campaign-closeout

**What:** The structured close-out process after a campaign completes. Captures what happened, what broke, what the code review found, and what needs to change before the next campaign. Produces a post-mortem document and feeds findings back into the pattern library.

**When to use:** After every campaign reaches `completed`, `cancelled`, or `failed` status. Non-optional — skipping this is how institutional knowledge evaporates.

**Status:** Mature. Codified after the first two campaigns, battle-tested across a dozen campaigns. Template is stable, closeout time has dropped from ad-hoc to ~20 minutes, and the feed-back loop is consistently closing. Active area of evolution: lifecycle cost tracking (see below).

## Why This Exists

Campaigns 1 and 2 both produced valuable post-mortems, but:
- Data gathering was manual and improvised (DB queries, git log, PR comment scraping)
- Code review was nearly forgotten in Campaign 2 — the external review PR comments existed but weren't consulted until explicitly prompted
- Pattern feedback wasn't written — `evaluation-loop` says "append results here" and it's empty
- The post-mortem format emerged through iteration, not from a template

The gap: **campaign completion is not the end of the lifecycle.** The real lifecycle is:

```
workshop → campaign → dispatch → gate → complete → review → post-mortem → feed-back
```

Everything after "complete" was missing.

## The Three Phases

### Phase 1: Review Wave

Add a review wave to the campaign's wave plan — runs after the final gate passes, before the campaign is marked complete.

**Internal review (wave-based):**
- Uses the existing `wave-review` pattern
- Cartographer maps all changes across the campaign's integration branch
- Focused reviewers run in parallel (code quality, security, implementation accuracy vs. spec)
- Adversarial + synthesis wave produces a structured report

**External review (optional, outside the loop):**
- A third-party automated review service configured on the repo
- Fires on the campaign's integration PR or individual WP PRs
- Produces comments that get scraped into the post-mortem
- Value: catches things our own system is blind to — different training, different heuristics

These are complementary, not redundant. Internal review checks against the spec and project conventions. External review checks against broader software engineering patterns the spec doesn't cover.

**Cost note:** An external review service used ~70% of weekly review budget on one 9-WP campaign. For sustainability, either:
- Use wave-review as the primary, external as spot-check on high-risk campaigns
- Find cheaper external services (self-hosted review agents)
- Budget external reviews to high-complexity or cross-cutting campaigns only

### Phase 2: Post-Mortem

Structured document produced after every campaign. Two parts: automated data collection, then human+AI synthesis.

**Automated data collection (should be scripted):**

| Data Source | What to Extract |
|-------------|----------------|
| Campaign DB | Wave count, dispatch count, duration, fix attempts, failure modes |
| Dispatch Tasks DB | Per-WP timing, status, retry count, failure mode, PR URLs, token cost |
| Git log | Commit timeline, merge events, branch operations |
| PR comments | External review findings (third-party review service), organized by severity |
| Gate output | What gates checked, what failed, false positive identification |

**Post-mortem template sections:**

1. **Campaign Summary** — table: name, objective, duration, result, PRs, gate mode, test counts
2. **Lifecycle Cost Breakdown** — per-phase cost (workshop, review, dispatch, closeout, fixes) with both lifecycle total and dispatch-only total for cross-campaign compatibility
3. **Wave Execution** — table: wave number, WPs, dispatch count, outcome
4. **Failures & Interventions** — narrative for each stop, root cause, fix, recovery time
5. **Infrastructure Context** — what was inherited from previous campaigns, what was new
6. **Code Review Findings** — organized by severity (P1/P2), with recurring themes identified
7. **Analysis** — what worked, what broke, key metrics with cross-campaign comparison
8. **Fixes Identified** — must-fix, should-fix, open questions — with difficulty and source (runtime vs. review)
9. **Cross-Campaign Comparison** — table comparing this campaign to previous ones (now includes both dispatch cost and lifecycle cost estimate)
10. **Dispatch Timeline** — appendix with timestamped event log

**Output location:** `./outputs/workshops/{campaign-slug}/post-mortem.md`

### Cost Blind Spot: Lifecycle Cost vs. Dispatch Cost

The "total cost" tracked in post-mortems through a dozen-plus campaigns is **dispatch cost only** — the cheapest phase. The actual lifecycle cost of delivering a feature includes phases that are completely untracked:

| Phase | Tracked? | Estimated Magnitude |
|-------|----------|-------------------|
| Workshop creation (spec planning) | ❌ No | $5–15 (Opus conversation) |
| Review council (pre-dispatch) | ❌ No | $2–5 (multi-model review) |
| Dispatch (campaign execution) | ✅ Yes | $5–18 (from DB) |
| Closeout (post-mortem synthesis) | ❌ No | $3–5 (Opus conversation) |
| Follow-up fixes (inter-campaign) | ❌ No | Variable |

This means reported costs systematically understate true cost by 2–3x. For one representative campaign: reported $9.13, estimated actual ~$20–30.

**Current mitigation:** The post-mortem template includes a Lifecycle Cost Breakdown section for manual estimates of each phase. This makes the blind spot visible in every post-mortem and creates data pressure for future automation.

**Future mitigation:** Backend-service session-level token/cost tracking, with sessions tagged to their campaign phase. This would make lifecycle cost collection automatic.

### Phase 3: Feed-Back

Route findings from the post-mortem into the appropriate places:

| Finding Type | Destination |
|-------------|-------------|
| Infrastructure bugs | Fix before next campaign (CLI prompt or workshop) |
| Pattern insights | Append to relevant pattern's "Execution Feedback" section |
| Process gaps | Update this pattern (`campaign-closeout`) |
| Recurring agent mistakes | Add to project's `CLAUDE.md` or `CORRECTIONS.md` |
| Cross-campaign metrics | Append to comparison table (maintained across post-mortems) |

This is the step that actually closes the loop. Without it, post-mortems are documentation. With it, they're evolution.

## Automation Roadmap

**Today (manual):**
- Human triggers review, gathers data, synthesizes with AI assistance
- Post-mortem written in conversation, saved to file

**Near-term (scripted collection):**
- `campaign closeout {slug}` CLI command that:
  - Queries DB for campaign timeline
  - Scrapes git log for commit history
  - Fetches PR comments via `gh api`
  - Produces a data package (JSON or structured markdown)
- Human + AI synthesize the data package into the post-mortem

**Future (integrated):**
- Review wave is part of the campaign's wave plan (automatic)
- Post-mortem draft auto-generated on campaign completion
- Feed-back suggestions auto-generated (which patterns to update, what CLAUDE.md entries to add)
- Human reviews and approves, doesn't write from scratch
- **Lifecycle cost tracking:** Backend-service session-level token/cost tracking with campaign-phase tagging, replacing manual estimates in the cost breakdown section

## Connection to Other Patterns

- **`wave-review`** — The review wave uses this pattern directly
- **`evaluation-loop`** — Post-mortem IS the evaluation loop in practice. Layer 1 (dispatch outcome tracking) is the data collection. Layer 2 (pattern effectiveness) is the feed-back phase.
- **`corrections-loop`** — Review findings that represent agent mistakes feed into corrections
- **`trust-ramp`** — Campaign success/failure data informs trust levels for dispatch autonomy
- **`wave-execution`** — The review wave extends the wave plan past the "work" phase

## Execution Feedback

**2026-03-01 — bridge-decomposition (retroactive):** Post-mortem written during campaign, included 4-round multi-model review. Format established through iteration. Missing: automated data collection, feed-back to patterns.

**2026-03-01 — campaign-recovery-observability:** Post-mortem written ad-hoc after campaign. External review findings nearly missed — only consulted when explicitly prompted. Three P1 findings and recurring P2 patterns discovered. Data collection done via DB queries + git log + `gh api`. Timeline extracted from DB. Format stabilized. This experience directly prompted creating this pattern.

**2026-03-06 — lazy-load (a real campaign):** First closeout using the codified template. Data collection still manual (DB queries + git log + gh CLI), but having the template structure made synthesis significantly faster — the template sections naturally guided what data to collect. Key process finding: the `expected_files` tracking has been broken since the first campaign (8 campaigns) and should either be fixed or removed from the template. New issue surfaced: Wave 5 stuck in `gate_running` because "human review" gate type produces empty gate spec — same gap as an earlier campaign, still unfixed. Total post-mortem time: ~30 minutes including data collection, synthesis, and feed-back updates.

**2026-03-07 — gate-command-validation (a real campaign):** Cleanest closeout yet. Data collection via single DB query (campaign + waves + dispatch_tasks join), PR review via `gh pr diff`, code review done inline. Post-mortem written in ~15 minutes. Process note: the cross-campaign comparison table is now the most valuable section — it immediately surfaces trends (cost is dropping, autonomous rate is consistently 100% for last 6 campaigns). New infrastructure finding: `recoverRunningCampaigns()` has no recovery path for `failed` waves — same class of gap as the empty-gate-spec issue from earlier campaigns. Feed-back to this pattern: total post-mortem time continues to drop as the template becomes muscle memory.

**2026-03-07 — review-council-mcp (a real campaign):** First campaign to include a friction log section in the post-mortem — captures the bootstrapping friction of building the review council tool and then immediately using it. Key process finding: spec-surface review is most valuable pre-dispatch, not post-merge (the automated council run found mostly stale spec issues already resolved in implementation). This campaign had a unique two-phase review: self-review (Option B) during the campaign caught 2 correctness bugs, then the automated review council ran post-merge as operational validation. The post-mortem adapted the template for a campaign without traditional DB campaign records (data sourced from git log instead). New process gaps identified: spec-implementation divergence not captured (specs become stale documentation), workshop readiness not surfaced in briefings. Total closeout time: ~25 minutes including post-mortem, cross-campaign analysis update, and pattern feed-back.

**2026-03-08 — chat-ui-refinement (a real campaign):** First zero-friction campaign — zero gate failures, zero merge conflicts, zero interventions, zero fix dispatches. Strongest evidence of review council value to date: R2 wave restructuring from 3→5 waves prevented guaranteed merge conflicts (three WPs modifying the same view component in parallel). All three models flagged the risk independently. Cost: $9.13 for 8 WPs ($1.14/dispatch). Closeout process continues to accelerate — sub-agents gathered DB/git/spec data in parallel. Total closeout time: ~20 minutes including merge, post-mortem, cross-campaign analysis update, archive, and pattern feed-back.

**2026-03-08 — persistent-session-context (a real campaign):** Second consecutive zero-friction campaign. 11 WPs, 6 waves, 38 minutes, $10.37, 100% autonomous. Most WP-heavy campaign in a while and the first to implement a runtime coordinator (new architectural component, not just features). Lowest cost-per-dispatch in the series: $0.94/dispatch. Cross-repo (backend service + web frontend). Code review done as post-merge manual review — confirmed architecture matched spec, all review council amendments applied. One scope deviation flagged (WP-03 created unexpected test file) — harmless. No new pattern insights beyond confirming the pipeline is reliably zero-friction at this maturity level. Total closeout time: ~20 minutes.

**2026-03-18 — multi-user-identity (a real campaign):** First manually dispatched campaign to receive a full post-mortem. 3 WPs, 3 waves, ~30m active execution buried in ~4h wall time (provider session instability blocked WP-03 for ~3 hours). No campaign DB records — all data reconstructed from git log. Key process finding: manual dispatch lacks retry resilience and observability. The automated pipeline would have retried through the session instability automatically. Recommendation: prefer automated dispatch even for small (3 WP) campaigns. No review council run. Post-mortem template worked well for manual campaigns with minor adaptation (estimated costs instead of DB-sourced). Total closeout time: ~15 minutes.

---
*Template: `templates/post-mortem.template.md`*
*Execution pattern — campaign lifecycle close-out*
*Pipeline: ← `wave-execution` (final gate) | → `evaluation-loop`, `corrections-loop`*
*See also: `wave-review`, `review-council`, `trust-ramp`*
