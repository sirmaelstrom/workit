# Pattern: review-council

**What:** Multi-model spec review where 3+ independent AI models evaluate workshop artifacts against structured criteria. Consensus findings are high-confidence real issues. Split opinions surface design tradeoffs worth deliberating.

**When to use:** Before dispatching a workshop with 3+ work packages, or any spec where the cost of missing a gap exceeds the cost of the review (~30 min manual effort currently).

**Relationship to wave-review:** The council pattern is the spec-review equivalent of wave-review (which is for code). Both use multiple independent perspectives to find gaps a single reviewer misses. The council could eventually be formalized as a wave in the campaign pipeline.

---

## Current Workflow (Manual)

### Step 1: Generate Reviewer Prompt

Write `reviews/reviewer-prompt.md` in the workshop directory. Template:

```markdown
# {Workshop Title} — Review by {Model Name}

## Context
{1-2 sentences on what this workshop specifies}

## Review Criteria

For each work package, evaluate:

1. **Completeness** — Are all implementation details specified? Could an agent build this without asking clarifying questions?
2. **Feasibility** — Can this be implemented as described? Are there hidden dependencies or technical impossibilities?
3. **Risk** — What could go wrong? What's under-specified that could bite us during implementation?
4. **Gaps** — What's missing? What assumptions are unstated?
5. **Conflicts** — Do any work packages contradict each other or the decisions doc?

## Specific Questions
{3-5 targeted questions about known weak spots}

## Output Format
{Structured format you want back — severity ratings, per-WP findings, synthesis}

## Files to Review
{Numbered list of all artifacts to provide}
```

### Step 2: Run 3 Parallel Reviews

Open 3 CLI sessions simultaneously:

| Model | Tool | Notes |
|-------|------|-------|
| Claude Sonnet (`claude`, default) | Claude Code CLI | Architectural reasoning + structural issues; ~2x faster/cheaper than opus, adequate for code/conformance review |
| Claude Opus (`claude-opus`, escalation) | Claude Code CLI | Use for **spec-coherence audits at a decision gate** — catches cross-artifact contradictions sonnet misses (2026-05-25 A/B). Also the synthesis model. |
| Gemini | Gemini CLI or API | Good at completeness checking, catches missing edge cases |
| GPT-5 / Codex | ChatGPT or Codex CLI | Good at implementation feasibility, catches practical issues |

**Lens model selection (2026-05-25 A/B):** The `claude` lens defaults to **sonnet** — adequate and faster for code/conformance review. **Escalate to `claude-opus`** when the artifact is a *spec at a decision gate* (reviewing decisions/constraints for internal contradictions), where sonnet tends to accept a self-contradictory spec as coherent. **Synthesis stays on opus** (`synthesisModel: "claude-opus"` in `models.json`) — the hardest reasoning in the flow.

Provide each model with:
- The reviewer prompt
- All workshop artifacts listed in the prompt

### Step 3: Collect & Save Reviews

Save each model's output to:
```
reviews/review-{model-name}.md
reviews/review-{model-name-2}.md
reviews/review-{model-name-3}.md
```

### Step 4: Synthesize

Write `reviews/review-synthesis.md`:

```markdown
# Review Synthesis

## Consensus Issues (All models flagged)
These are almost certainly real problems. Fix before dispatch.

## Majority Issues (2 of 3 models flagged)
Likely real. Investigate.

## Split Opinions (Models disagreed)
Design tradeoffs. Human decides.

## Unique Findings (Only 1 model caught)
Worth investigating — could be noise or a genuine blind spot.

## Overall Assessment
[Go/no-go recommendation with conditions]
```

### Step 5: Apply Amendments

Based on synthesis, edit the WP specs directly:
- Amendments are applied as direct edits to execution artifacts — not stored as separate reference files
- Reference files create indirection that makes specs harder for dispatch agents to follow
- If you need to track what changed, git history provides the diff

### Step 6: Round 2 (Optional)

If amendments are substantial, run a second review round:
- New prompt: `reviewer-prompt-r2.md` — focuses on amendment integration
- Shorter, targeted: "Do the amendments resolve the issues? Do they introduce new ones?"
- Reviews saved as `review-r2-{model}.md`

---

## Empirical Results

**Campaign Orchestration Workshop (2026-02-28):**
- 2 review rounds, 3 models each
- Round 1: 12 issues found, including a runtime-breaking SQL CHECK constraint gap
- Round 2: 5 additional issues, mostly amendment integration problems
- Total: 17 issues caught
- Consensus issues were reliably real bugs
- Split opinions (e.g., "stale artifact after rework") surfaced genuine design choices

**Cost:** ~30 minutes human effort per round (prompt generation, session management, synthesis). Model cost is negligible.

**Value:** The SQL constraint gap alone would have caused significant debugging time during implementation. The review caught it in prose before a line of code was written.

---

## Automated Workflow (MCP Server)

As of 2026-03-07, the review council is automated via a standalone MCP server (`src/mcp/review-council.ts`). Three tools:

```
council_review(workshop_path, surface, round, models[])
  → Fan out to N models in parallel, write review-lens-{model}.md

council_synthesize(review_dir)
  → Read all lenses, invoke synthesis model (default: Claude), write synthesis.md

council_challenge(review_dir)
  → Adversarial pass against synthesis (default: Gemini), write challenge.md
```

**Config:** `./config/review-council/models.json` — model registry (command, args, timeout).
**Templates:** `patterns/templates/review-council/` — single source of truth. The backend service reads these at runtime.

The manual workflow above still works and is the fallback when the MCP server is unavailable.

---

## Execution Feedback

**2026-02-28 — Campaign Orchestration Workshop (manual):** 2 rounds, 3 models each. 17 issues caught including runtime-breaking SQL CHECK constraint gap. Consensus issues were reliably real bugs. ~30 min human effort per round.

**2026-03-07 — review-council-mcp (a real campaign, first automated run):** Full pipeline (Claude + Gemini + GPT → synthesis → adversarial challenge) completed in ~5.5 minutes. Key findings:
- All 3 models produced substantive reviews with structured findings
- Synthesis correctly categorized findings by cross-model agreement (3 consensus, 6 majority, 7 unique)
- Adversarial challenge (Gemini) added genuine value: downgraded 5 findings, overturned 3, raised 3 new concerns no reviewer caught
- **Timing lesson:** Spec-surface review is most valuable pre-dispatch. Running it post-merge produced mostly stale findings (issues already resolved in implementation). Code-surface review is most valuable post-merge.
- Total pipeline time went from ~30 min/round manual to ~5.5 min automated — a 5x improvement with better consistency
- The adversarial challenge is the most valuable step per minute: it forces all findings through a skeptical lens and reliably separates real issues from noise

---

*Source: Campaign orchestration review sessions (2026-02-28), review-council-mcp campaign (2026-03-07)*
*Cross-cutting discipline — pre-dispatch multi-model review, between workshop completion and campaign execution*
*See also: `wave-review` (code review decomposition), `trust-ramp` (earned autonomy), `evaluation-loop`, `campaign-closeout`*
*Created: 2026-03-01 | Updated: 2026-03-07 — manual workflow superseded by MCP server*
