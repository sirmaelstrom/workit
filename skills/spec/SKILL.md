---
name: spec
description: "Autonomously generate a complete workshop specification from a short intent description. Use when the user says '/spec', 'spec this', 'write a spec for', 'auto-spec', or describes a feature and wants a full specification without co-authoring each stage. This skill runs all 6 pipeline stages, pauses for human review after constraints, completes decomposition and work packages, then runs an iterative refinement loop (fresh-eyes waves + council review) to convergence."
---

# Spec — Autonomous Specification Pipeline

Generate a complete, dispatch-ready workshop specification from a short intent description. You run all 6 pipeline stages autonomously, pause once for human review, then finish with an iterative refinement loop that produces a review-council-validated spec.

## Inputs

The user provides intent — one sentence to a short paragraph:
- `/spec "add OAuth login to service"`
- `/spec` then describes the problem when prompted

If no intent is provided, ask for it. One question only: "What are we building?"

### Review Level

Parse the `--review` flag from arguments. If not specified, auto-select based on complexity:

| Flag | Behavior | Auto-select when |
|------|----------|-----------------|
| `--review=full` | Fresh-eyes loop → council → final wave (default) | ≥3 WPs or multi-project |
| `--review=light` | Self-review only, skip refinement loop | ≤2 WPs, single project, additive-only |
| `--review=none` | Decompose and stop | User explicitly wants manual review later |

When auto-selecting, state the choice: *"Auto-selecting `--review=full` — 4 WPs across 2 waves warrants iterative review."*

## Phase 1: Setup & Exploration

### 1a. Parse Intent

Extract from the intent:
- **What** is being built or changed
- **Which project(s)** this touches — check `/workspace\projects\` for matching repos
- **Slug** — kebab-case, ≤40 chars

If the project is ambiguous, ask. If the scope is ambiguous, make your best guess and flag it as `[ASSUMPTION: A1]` — the human will correct at the review gate.

### 1b. Scaffold Workshop

Create `/workspace\data\outputs\workshops\{slug}\` with `meta.json`:
```json
{
  "title": "{title}",
  "slug": "{slug}",
  "status": "captured",
  "projects": ["{project}"],
  "tags": [],
  "createdAt": "{ISO timestamp}",
  "updatedAt": "{ISO timestamp}"
}
```

### 1c. Explore Codebase

Before writing anything, ground yourself in the actual code. Use the Agent tool to launch an Explore agent:

- Directory structure of the target project
- Key entry points, config files, package.json/cargo.toml etc.
- Files most likely affected by this change
- Existing patterns the implementation should follow

Store findings mentally — you'll reference them throughout. Every architectural claim in the spec must cite a real file path.

### 1d. Search Knowledge Base

Search the KB for prior work on this topic:
```
kb_search("relevant terms from the intent")
```
Surface any prior workshops, research, corrections, or lessons that inform this spec. Don't re-derive what's already been decided.

## Phase 2: Autonomous Pipeline (Stages 1-4)

Run stages 1-4 sequentially. For each stage:
1. Read the pattern file from `/workspace\projects\heathdev-patterns\patterns\`
2. Write the artifact to the workshop directory
3. Update `meta.json` status

**Do not dump pattern contents into your output.** Read them, internalize the methodology, apply it. The patterns are your reference, not content to recite.

### Stage 1: Problem Statement
- Pattern: `patterns/problem-statement.md`
- Output: `problem-statement.md`
- Key discipline: Self-containment test. Could a stranger begin solving this from what's written?
- Ground every claim in code you actually read in Phase 1.
- Surface hidden assumptions as `[ASSUMPTION: A1]`, `[ASSUMPTION: A2]`, etc.

### Stage 2: Decisions
- Pattern: `patterns/decision-resolution.md`
- Output: `decisions.md`
- Key discipline: Scan your own problem statement for ambiguity flags ("or", "possibly", "might", "TBD", "should consider"). Each real ambiguity becomes a numbered decision (D1, D2...).
- For each decision: list options, state tradeoffs (one line each), **choose one**, document reasoning.
- Mark decisions where you're uncertain as `[DECISION: D3 — low confidence, alternatives close]`.
- Use the `design-alternatives` pattern mentally — consider at least 2 approaches before choosing.

### Stage 3: Verification
- Pattern: `patterns/verification-criteria.md`
- Output: `verification.md`
- Key discipline: For each decision, write the three-sentence independent observer test. If you can't verify it, the decision needs refinement — flag it.
- Specify verification type (automated test > build check > CLI command > Playwright > manual observation).
- Capture baselines where applicable.

### Stage 4: Constraints
- Pattern: `patterns/constraint-architecture.md`
- Output: `constraints.md`
- Key discipline: Four categories — Musts (M1...), Must-Nots (MN1...), Preferences (P1...), Escalation Triggers (E1...).
- Use the "smart well-intentioned person" exercise: what could they do that satisfies every requirement but produces the wrong outcome?
- Check KB for failure modes from similar past campaigns. Inject relevant constraints.

## Phase 3: Self-Review

After writing all 4 artifacts, run an adversarial self-review:

1. **Ambiguity scan** — re-read all artifacts for unresolved "or", "possibly", "might", "TBD"
2. **Grounding check** — does every architectural claim reference a real file?
3. **Verification specificity** — is every V-criterion a concrete command or observable behavior, not vibes?
4. **Constraint coverage** — all 4 categories present? Must-nots address likely agent drift?
5. **Cross-artifact consistency** — do decisions align with constraints? Do verification criteria cover every decision?

Fix issues found. Then flag anything you're still uncertain about.

## Phase 4: Human Review Gate

Present a consolidated review artifact. Format:

```markdown
## Spec Review: {title}

### Flagged Items
{List all [DECISION] and [ASSUMPTION] callouts with their context}

### Summary
- **Problem:** {1-2 sentences}
- **Key decisions:** {D1, D2... with choices made}
- **Verification approach:** {strongest verification type used}
- **Constraint highlights:** {most important must-nots and escalation triggers}

### Review level
{full|light|none} — {reason for selection}

### Your Call
Review the flagged items. For each:
- ✅ Approve
- ✏️ Revise: {your correction}
- ❌ Reject: {why}

Or: "looks good" to proceed, "start over" to restart, or specific feedback.
You can also override the review level: "looks good, but skip review" or "looks good, full review please"
```

**STOP HERE.** Wait for human input. Do not proceed to decomposition without explicit approval.

## Phase 5: Revision (if needed)

When the human provides feedback:
1. Identify the earliest affected stage
2. Revise from that stage forward (don't re-run unaffected stages)
3. Re-present only the changed sections
4. Return to the review gate

One revision loop is normal. If the third revision still has major issues, suggest a `/grill-me` session to resolve the underlying confusion.

## Phase 6: Decomposition & Work Packages

After approval, run stages 5-6:

### Stage 5: Decomposition
- Pattern: `patterns/decomposition.md`
- Output: `decomposition.md`
- Apply the appropriate break pattern (API/Backend, UI, Refactor, Infrastructure) from the pattern.
- Run the decomposition test: each unit <2hrs, clear boundaries, independently verifiable, disjoint files.
- Include a Mermaid dependency graph for 4+ packages.

### Stage 6: Work Packages
- Pattern: `patterns/work-package.md`
- Output: `work-packages/wp-{NN}-{slug}.md` for each package + `work-packages/_orchestrator.md`
- Use the template from `/workspace\projects\heathdev-patterns\templates\_orchestrator.template.md`
- All 7 required fields per WP (precondition, goal, files, verification, failure criteria, boundary, commit)
- Tag each WP: `execution: autonomous` or `execution: review-needed` (HITL flag)
- Wave plan with gate commands
- Spec-level constraints in orchestrator (from constraints.md)
- **Model assignment in Package Inventory table.** The 5th column (`Model`) is parsed by `campaign-parser.ts` and wired to dispatch. For each WP, assign `opus` or `sonnet` (use `-` for system default):
  - `opus` — WPs involving review, fix, or judgment work; integration packages with protocol design or direction reversal; packages touching auth/data-loss boundaries
  - `sonnet` — clear specs with mechanical wiring, single-file changes, straightforward ports, CRUD operations, cleanup/deletion
  - When uncertain, default to `opus` — correctness on fix work outweighs token cost

Update `meta.json` status to `"ready"`.

**If `--review=none`:** Skip to Phase 9 (Final Output).
**If `--review=light`:** Skip to Phase 9 (Final Output). The self-review in Phase 3 is the only quality pass.
**If `--review=full`:** Continue to Phase 7.

## Phase 7: Refinement Loop (--review=full only)

Iteratively review the work packages using fresh-eyes Sonnet sub-agents until convergence.

### 7a. Fresh-Eyes Wave

Launch a Sonnet sub-agent using the Agent tool with this prompt structure:

```
You are a fresh-eyes spec reviewer. You have NO prior context about this workshop.
Your job: find problems that would cause dispatch failures, incorrect implementations,
or ambiguity that an autonomous agent would resolve incorrectly.

Review these work package specs against the actual source code they reference.
For each WP, verify:
1. File paths and line numbers cited in the spec actually exist and match described content
2. Function signatures, type names, and API shapes match the real code
3. The described change is implementable as written (no missing steps, no impossible states)
4. Boundary constraints are enforceable (no overlap with other WPs' file lists)
5. Test descriptions are specific enough to write without guessing
6. Failure criteria are actionable (not just "if it doesn't work")

Rate each finding:
- **P1 (blocker):** Would cause dispatch failure, incorrect code, or constraint violation
- **P2 (significant):** Ambiguity an agent would likely resolve incorrectly
- **P3 (minor):** Style, clarity, or edge case unlikely to affect dispatch

Workshop directory: {workshop_path}
Project directory: {project_path}

Read ALL work package files in work-packages/ and the _orchestrator.md.
Read the constraints.md for constraint cross-reference.
Read the actual source files referenced in each WP to verify claims.

Output format:
## Wave {N} Review

### Findings
- **P1:** {description} — {which WP, which section, what's wrong}
- **P2:** {description}
...

### Files Checked
{list of source files you actually read}

### Verdict
{CLEAN | HAS_BLOCKERS | HAS_ISSUES}
- P1 count: {N}
- P2 count: {N}
- P3 count: {N}
```

### 7b. Fix Findings

After each wave:
- **P1s:** Fix immediately. These are blockers — update the WP spec files directly.
- **P2s:** Fix unless the fix would introduce more complexity than the ambiguity costs. Document skipped P2s.
- **P3s:** Note but do not fix unless trivial. Accumulate across waves.
- **False positives:** The agent uses regex-like heuristics. If a finding is wrong (e.g., "or" in normal English flagged as ambiguity), discard it and note it as a false positive.

### 7c. Convergence Check

After fixing, decide whether to run another wave:

| Condition | Action |
|-----------|--------|
| Wave returned P1s | Fix and run another wave (mandatory) |
| Wave returned P2s only, fixes applied | Run one more wave to verify fixes |
| Wave returned P3s only or was clean | **Converged** — proceed to council |
| 8 waves completed | **Force converge** — proceed to council regardless |

Track across waves: if wave N finds the same P2 that wave N-1 found and it was already evaluated and kept, that's not a new finding — it's convergence noise. Suppress it.

### 7d. Report Progress

After each wave, briefly report to the user:
```
Wave {N}: {P1_count} P1, {P2_count} P2, {P3_count} P3. {Fixed X issues. | Clean.} {Converged — moving to council. | Running wave {N+1}.}
```

Keep it to one line. The user doesn't need to see every finding — they'll see the final result.

## Phase 8: Council Review (--review=full only)

After the fresh-eyes loop converges:

### 8a. Deploy Council

Use the `mcp__review-council__council_review` tool to run a multi-model review:

```
council_review({
  artifact_path: "{workshop_path}",
  review_type: "spec",
  thinking_level: "medium",
  models: ["claude", "gemini", "gpt"]
})
```

If any model times out, retry that model once with `thinking_level: "low"`. If it times out again, proceed with the models that completed.

### 8b. Apply Council Findings

Process the council synthesis:
- **Critical findings:** Fix immediately in the spec files.
- **Major findings:** Fix unless they conflict with a deliberate decision (reference the D# and explain why it stands).
- **Minor findings:** Note but don't fix.

Count amendments applied. If 5+ amendments were needed, the spec had significant gaps — note this for post-mortem calibration.

### 8c. Final Validation Wave

Run one more Sonnet fresh-eyes wave (same prompt as 7a) to verify the council amendments didn't introduce new issues. This is the final quality gate.

Then run the spec-validate script (locate `validate.mjs` in the plugin's `skills/spec-validate/scripts/` directory):
```bash
node "$(find ~/.claude/plugins -path '*/spec-validate/scripts/validate.mjs' 2>/dev/null | head -1)" {workshop_path}
```

Report: validation result (errors/warnings/passes) + final wave verdict.

## Phase 9: Final Output

Present the completed spec summary:

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `workshops/{slug}/`
**Packages:** {N} WPs across {N} waves
**Estimated execution:** {autonomous WPs} autonomous, {review WPs} need review
**Gate commands:** {summary}
**Review:** {review_level} — {N} fresh-eyes waves, {N} council models, {N} amendments applied
**Validation:** {pass/fail} — {errors} errors, {warnings} warnings

Ready for dispatch.
```

If `--review=light` or `--review=none`, the Review and Validation lines reflect what was actually done:
```
**Review:** light — self-review only
**Review:** none — no review performed, manual review recommended before dispatch
```

## Principles

- **Speed over perfection, but not over correctness.** The refinement loop exists because speed without review produces specs that fail at dispatch. The loop is fast (Sonnet agents, ~2 min/wave) and the ROI is proven (C33: 7 waves caught 3 P1s that would have caused runtime failures).
- **Ground everything.** No architectural claims without file references. No "the system probably does X."
- **Flag, don't hide.** Uncertainty is fine — hiding it isn't. Use [DECISION] and [ASSUMPTION] callouts liberally.
- **Patterns are runtime reads, not memorized content.** Read each pattern file fresh before writing its artifact. Patterns evolve.
- **The output is a real workshop.** Not a separate format. Everything downstream (validate, dispatch, review council, post-mortem) works on these artifacts unchanged.
- **Convergence, not perfection.** The refinement loop stops when P1s are gone, not when findings are zero. P3s are noise — chasing them degrades momentum.

## Ledger Events

Write timing events at each stage transition (fire-and-forget, non-blocking):
```json
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "{stage}", "event_type": "entered", "actor": "agent" }
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "{stage}", "event_type": "completed", "actor": "agent" }
```

For the refinement loop, write one event per wave:
```json
{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "refinement_wave_{N}", "event_type": "completed", "actor": "agent", "findings": { "p1": N, "p2": N, "p3": N } }
```

---
*Implements Approach A from the Autonomous Spec Pipeline workshop, extended with iterative refinement from C33 learnings.*
*Pattern library: /workspace\projects\heathdev-patterns\*
*Related skills: /workshop (interactive co-authoring), /spec-validate (quality check), /grill-me (stress-test before speccing)*
