---
name: spec
description: "Generate a specification. Trigger: '/spec', 'spec this', 'write a spec for', 'auto-spec'. READ THE FULL SKILL before executing — depth selection, pipeline stages, and review gates are defined below."
---

# Spec — Autonomous Specification Pipeline

Generate a complete, execution-ready specification from a short intent description. The spec is **a tool you reach for, not a gate you pass through.** Three depths are available — choose based on the problem, not habit.

## Spec Depth

Parse the `--depth` flag from arguments. If not specified, **auto-select using the heuristics below.** State the choice and why.

### `--depth=deep` — Full 6-stage pipeline with refinement loop

**Auto-select when ANY of these are true:**
- Change touches 2+ projects/repos
- You cannot list all affected files with confidence before starting
- The domain is new to the codebase (no existing patterns to follow)
- There are 3+ real design decisions where the wrong choice wastes significant work
- The change has integration seams (data flows across service boundaries)
- The operator has never built something like this in this codebase before

**Produces:** Separate artifacts per stage (problem-statement.md, decisions.md, verification.md, constraints.md, decomposition.md, work-packages/), full refinement loop + council review.

### `--depth=lite` — Single compressed spec document

**Auto-select when ALL of these are true:**
- Single project
- You can list all affected files before starting (or close to it)
- The codebase already has patterns for this kind of change
- 1-2 design decisions, and the right answers are fairly obvious
- No integration seams — changes are contained within one service/module

**Produces:** Single `spec.md` with Problem/Decisions/Verification/Constraints sections. Self-review only. ~10-20 minutes.

### `--depth=none` — No spec, just execute

**Auto-select when ALL of these are true:**
- Single file or handful of files
- Zero design decisions — the what and how are both clear
- The operator described the change specifically enough to implement directly
- Change is additive or mechanical (rename, port, delete, config change)

**Produces:** Nothing. Respond with *"No spec needed. Go build."* and stop.

### When in doubt

If you're oscillating between two depths, pick the deeper one only when rework risk clearly outweighs ~15 min of spec overhead. Otherwise trust the lighter depth — forced depth erodes momentum without improving correctness. The spec exists to serve execution, not the other way around.

### Review Level

For deep specs, parse the `--review` flag. If not specified, auto-select:

| Flag | Behavior | Auto-select when |
|------|----------|-----------------|
| `--review=full` | Fresh-eyes loop → council → final wave (default) | ≥3 WPs or multi-project |
| `--review=light` | Self-review only, skip refinement loop | ≤2 WPs, single project, additive-only |
| `--review=none` | Decompose and stop (no review waves) | User explicitly wants manual review later |

**Lite specs** default to self-review only. Pass `--review=full` to *additionally* run the Phase 8 hybrid council against the single `spec.md` (see *Council Review* in the Spec Lite section) — worth it when the change is well-understood but you still want a diverse-model pass on a decision gate. `--review=light`/`none` are no-ops on lite; self-review is already its floor.

---

## Spec Deep (`--depth=deep`)

Full methodology. Grounded, adversarial, iterative.

### Phase 1: Setup & Exploration

#### 1a. Parse Intent

Extract from the intent:
- **What** is being built or changed
- **Which project(s)** this touches — check your projects directory for matching repos
- **Slug** — kebab-case, ≤40 chars

If the project is ambiguous, ask. If the scope is ambiguous, make your best guess and flag it as `[ASSUMPTION: A1]` — the human will correct at the review gate.

#### 1b. Scaffold Workshop

Create `./outputs/workshops/{slug}/` with `meta.json`:
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

#### 1c. Explore Codebase

Before writing anything, ground yourself in the actual code. Use the Agent tool to launch an Explore agent:

- Directory structure of the target project
- Key entry points, config files, package.json/cargo.toml etc.
- Files most likely affected by this change
- Existing patterns the implementation should follow

Store findings mentally — you'll reference them throughout. Every architectural claim in the spec must cite a real file path.

#### 1d. Read Institutional Memory

**Read your project's corrections memory first** (if you keep one) — non-negotiable when it exists:
```
Read CORRECTIONS.md
```
A corrections file captures cross-project lessons from past failures — every entry was learned the hard way. Internalize the relevant entries and inject them as constraints or must-nots in Stage 4. Skip this step if your project has no such file.

Then search the KB for prior work on this topic:
```
kb_search("relevant terms from the intent")
```
Surface any prior workshops, research, or lessons that inform this spec. Don't re-derive what's already been decided.

### Phase 2: Autonomous Pipeline (Stages 1-4)

Run stages 1-4 sequentially. For each stage:
1. Read the pattern file from this plugin's bundled library. The stage `Pattern:` refs below are absolute paths that resolve to this plugin's install directory automatically at skill load (NOT the user's cwd; `/spec` runs from the user's project).
2. Write the artifact to the workshop directory
3. Update `meta.json` status

**Do not dump pattern contents into your output.** Read them, internalize the methodology, apply it. The patterns are your reference, not content to recite.

#### Stage 1: Problem Statement
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/problem-statement.md`
- Output: `problem-statement.md`
- Key discipline: Self-containment test. Could a stranger begin solving this from what's written?
- Ground every claim in code you actually read in Phase 1.
- Surface hidden assumptions as `[ASSUMPTION: A1]`, `[ASSUMPTION: A2]`, etc.

#### Stage 2: Decisions
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/decision-resolution.md`
- Output: `decisions.md`
- Key discipline: Scan your own problem statement for ambiguity flags ("or", "possibly", "might", "TBD", "should consider"). Each real ambiguity becomes a numbered decision (D1, D2...).
- For each decision: list options, state tradeoffs (one line each), **choose one**, document reasoning.
- Mark decisions where you're uncertain as `[DECISION: D3 — low confidence, alternatives close]`.
- Use the `parallel-explore` pattern mentally — consider at least 2 approaches before choosing.

#### Stage 3: Verification
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/verification-criteria.md`
- Output: `verification.md`
- Key discipline: For each decision, write the three-sentence independent observer test. If you can't verify it, the decision needs refinement — flag it.
- **Identify verification layers per criterion** — unit tests alone are insufficient. For each V-criterion, explicitly state which layers apply:
  - **Unit:** isolated logic (mocks OK here)
  - **Fixture-contract:** capture real external output as test fixtures, parse with real code. Required for any decision that consumes external service output (APIs, CLI tools, file formats).
  - **Seam-integration:** wire internal services together with real code, fixtures only at external boundaries. Required when data flows through 2+ services. This catches "both pass independently but the handoff breaks."
  - **Deployment:** Docker smoke tests, build checks, CI validation. Required when decisions change the deployment artifact.
  - **Manual observation:** ONLY for genuinely subjective quality judgment. If you default to "manual" because automation is hard, flag it as a gap.
- A V-criterion with only "run dotnet test --filter Foo" is almost certainly underspecified. Ask: what breaks between the units?
- **Identify seams explicitly** — list every point where data crosses a service boundary. Each uncovered seam is a verification gap that must be documented with rationale.
- End with a `## Verification Gaps` section listing uncovered seams and why they're acceptable.
- Capture baselines where applicable.

#### Stage 4: Constraints
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/constraint-architecture.md`
- Output: `constraints.md`
- Key discipline: Four categories — Musts (M1...), Must-Nots (MN1...), Preferences (P1...), Escalation Triggers (E1...).
- Use the "smart well-intentioned person" exercise: what could they do that satisfies every requirement but produces the wrong outcome?
- **Cross-reference CORRECTIONS.md** (read in Phase 1d) against this spec's scope. Specifically:
  - Any correction relevant to this spec's domain becomes an explicit Must-Not
  - Cross-repo changes share a wire format contract
- Check KB for failure modes from similar past work. Inject relevant constraints.

### Phase 3: Self-Review

After writing all 4 artifacts, run an adversarial self-review:

1. **Ambiguity scan** — re-read all artifacts for unresolved "or", "possibly", "might", "TBD"
2. **Grounding check** — does every architectural claim reference a real file?
3. **Verification specificity** — is every V-criterion a concrete command or observable behavior, not vibes?
4. **Constraint coverage** — all 4 categories present? Must-nots address likely agent drift?
5. **Cross-artifact consistency** — do decisions align with constraints? Do verification criteria cover every decision?

Fix issues found. Then flag anything you're still uncertain about.

### Phase 4: Human Review Gate

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

After presenting the chat-side artifact, **also emit** a structured `review-gate.json` to the spec bundle and invoke the renderer so the operator has an interactive triage surface. Skip this entirely when `--review=none`.

#### JSON schema reference

The skill writes `review-gate.json` next to the spec's other stage outputs. Full schema: `skills/spec/tests/fixtures/review-gate-schema.md`. Minimum the skill needs to know to produce a valid emit:

- Top-level: `schema_version: "1.0"`, `run_slug`, `created_at` (ISO-8601), `spec {title, slug, dir}`, `review_level`, `review_level_reason`, `summary`, `flagged_items[]`, `compile_template` (string).
- `summary`: `{problem, key_decisions[], verification_approach, constraint_highlights[]}` — `problem` and `verification_approach` are markdown strings; the lists are arrays of strings.
- `flagged_items[]`: `{id, kind: "DECISION"|"ASSUMPTION", title, context, stage?, default_action?}`. `id` values must be **unique within the array**. `context` is markdown. `default_action` is optional `"approve"|"revise"|"reject"` that pre-checks the corresponding radio.
- `compile_template` is the template the HTML uses when the operator clicks "Compile decisions and copy". It **must contain `{decisions_blob}`** (renderer fails Layer 3 without it). Should also contain `{spec_slug}` and `{general_feedback}` (renderer warns to stderr without them). Other supported tokens: `{spec_title}`, `{spec_dir}`, `{review_level}`, `{review_gate_path}`, `{approved_count}`, `{revised_count}`, `{rejected_count}`.

Default `compile_template` to write into the JSON unless the operator has reason to override:

```
Spec review decisions for {spec_title} (slug: `{spec_slug}`, review_level: {review_level}):

{decisions_blob}

General feedback: {general_feedback}
Counts: {approved_count} approved, {revised_count} revised, {rejected_count} rejected.

Proceed to Phase 5 (Revision if any items were revised or rejected) then Phase 6 (Decomposition and Work Packages). Spec dir: {spec_dir}.
```

A working example fixture lives at `skills/spec/tests/fixtures/review-gate-example.json`.

#### Renderer invocation

After writing `review-gate.json`, invoke (from any working directory):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/render-review-gate.mjs" \
  --input "{spec-dir}/review-gate.json" \
  --output-dir "{spec-dir}"
```

The renderer:
- Validates the JSON against the v1.0 schema (three-layer; fails loudly on invalid input — non-zero exit + stderr).
- Writes `review-gate.md` and `review-gate.html` into `--output-dir`.
- Output is deterministic given fixed JSON input AND fixed `--output-dir`.
- Single-file HTML — no external assets, system fonts only.
- The HTML's "Compile decisions and copy" button compiles per-item state into a structured response and writes it to clipboard. The operator pastes the compiled response back into chat; Phase 5 reads it.

#### Chat output

After the renderer succeeds, point the operator at `review-gate.html` (one line — do not paste the chat-side markdown summary into the response that already shows it). The HTML and the chat-side markdown are redundant; the HTML is the recommended triage surface, the chat-side markdown is the fallback for environments without an open browser.

**STOP HERE.** Wait for human input. Do not proceed to decomposition without explicit approval.

### Phase 5: Revision (if needed)

When the human provides feedback:
1. Identify the earliest affected stage
2. Revise from that stage forward (don't re-run unaffected stages)
3. Re-present only the changed sections
4. Return to the review gate

One revision loop is normal. If the third revision still has major issues, suggest a `/grill-me` session to resolve the underlying confusion.

### Phase 6: Decomposition & Work Packages

After approval, run stages 5-6:

#### Stage 5: Decomposition
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/decomposition.md`
- Output: `decomposition.md`
- Apply the appropriate break pattern (API/Backend, UI, Refactor, Infrastructure) from the pattern.
- Run the decomposition test: each unit <2hrs, clear boundaries, independently verifiable, disjoint files.
- Include a Mermaid dependency graph for 4+ packages.

#### Stage 6: Work Packages
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/work-package.md`
- Output: `work-packages/wp-{NN}-{slug}.md` for each package + `work-packages/_orchestrator.md`
- Use the `_orchestrator.template.md` template from `${CLAUDE_PLUGIN_ROOT}/reference/templates/`
- All 6 required fields per WP (precondition, goal, files, verification, failure criteria, boundary)
- Tag each WP: `execution: autonomous` or `execution: review-needed` (HITL flag)
- Dependency order (which WPs must complete before others can start)
- Spec-level constraints in orchestrator (from constraints.md)

Update `meta.json` status to `"ready"`.

**If `--review=none`:** Skip to Phase 9 (Final Output).
**If `--review=light`:** Skip to Phase 9 (Final Output). The self-review in Phase 3 is the only quality pass.
**If `--review=full`:** Continue to Phase 7.

### Phase 7: Refinement Loop (--review=full only)

Iteratively review the work packages using fresh-eyes Sonnet sub-agents until convergence.

#### 7a. Fresh-Eyes Wave

Launch a Sonnet sub-agent using the Agent tool. The full prompt template lives in `${CLAUDE_SKILL_DIR}/reference/fresh-eyes-prompt.md` — read that file and substitute `{workshop_path}` and `{project_path}` before spawning. Use it verbatim; the structured verdict format is what Phase 7c's convergence logic reads.

#### 7b. Fix Findings

After each wave:
- **P1s:** Fix immediately. These are blockers — update the WP spec files directly.
- **P2s:** Fix unless the fix would introduce more complexity than the ambiguity costs. Document skipped P2s.
- **P3s:** Note but do not fix unless trivial. Accumulate across waves.
- **False positives:** The agent uses regex-like heuristics. If a finding is wrong (e.g., "or" in normal English flagged as ambiguity), discard it and note it as a false positive.

#### 7c. Convergence Check

After fixing, decide whether to run another wave:

| Condition | Action |
|-----------|--------|
| Wave returned P1s | Fix and run another wave (mandatory) |
| Wave returned P2s only, fixes applied | Run one more wave to verify fixes |
| Wave returned P3s only or was clean | **Converged** — proceed to council |
| 8 waves completed | **Force converge** — proceed to council regardless |

Track across waves: if wave N finds the same P2 that wave N-1 found and it was already evaluated and kept, that's not a new finding — it's convergence noise. Suppress it.

#### 7d. Report Progress

After each wave, briefly report to the user:
```
Wave {N}: {P1_count} P1, {P2_count} P2, {P3_count} P3. {Fixed X issues. | Clean.} {Converged — moving to council. | Running wave {N+1}.}
```

Keep it to one line. The user doesn't need to see every finding — they'll see the final result.

### Phase 8: Council Review (--review=full only)

After the fresh-eyes loop converges:

#### 8a. Deploy Council

The council is a **hybrid of two composed halves** — a local Anthropic lens (plan-covered) and an external multi-model council (the config-owned `spec-external` profile). Its real value is the **synthesis across diverse models**: different model families surface different blind spots. Dispatch **both halves in a single response** for maximum parallelism — the two Agent subagent calls and the one MCP call go out together.

**Half 1 — Local Anthropic lenses (plan-covered anchor).** Two specialized lenses run as `model: opus` Task subagents *inside this interactive session* — plan-covered (your subscription), not the metered programmatic API. Each reviews the converged spec cold:

1. **Reasoning & Coherence** — read `${CLAUDE_SKILL_DIR}/reference/council-lens-reasoning.md`, substitute `{workshop_path}` and `{project_path}`, spawn the prompt verbatim. The logic / contradiction auditor.
2. **Cartography & Codebase Grounding** — read `${CLAUDE_SKILL_DIR}/reference/council-lens-cartography.md`, substitute the same placeholders, spawn verbatim. Verifies the spec against real source (has Read/Grep/Glob).

Use **opus** for both: a Phase-8 spec review is a coherence audit at a decision gate, and a 2026-05-25 A/B showed sonnet accepts a self-contradictory spec as coherent while opus catches the cross-artifact contradictions (stale constraints after a mid-flight decision revision).

**Half 2 — External council (diverse-model lenses).** In the *same response*, make ONE call to the `review-council` MCP, which fans out the profile's external lenses in parallel and writes a lens file per model:

```
mcp__review-council__council_review({
  workshop_path: "{workshop_path}",
  surface: "spec",
  round: 1,
  profile: "spec-external",
  thinking: "medium"
})
```

The `spec-external` profile is **config-owned** — its membership lives in `models.json` (`profiles.spec-external`), so the roster can rotate without editing this skill. Two properties are load-bearing:

- It is **external-only by design**: it must never include the `claude -p` Anthropic lenses — the local half above already runs the pivotal opus review in-session, and adding an MCP Anthropic lens would double-run it on the revert-risk path. The profile currently leads with **codex** (agentic, explores `{project_path}` itself, runs on your own ChatGPT login → plan-covered); its other members are metered external APIs, attributed as `review.council` api_usage rows.
- Do **not** pass `models:` here — naming an explicit list re-inlines the roster this profile exists to own (explicit `models` overrides `profile` when both are present).

The tool returns a JSON summary with each model's status and lens filename; the files land in `{workshop_path}/reviews/review-1/` (one `review-lens-{model}.md` per lens). Read those in 8b.

> **If the external council is unavailable** (the MCP errors, returns all-failed, or isn't registered on this machine): proceed with the two local opus lenses alone and note the gap in the Phase-9 summary. The local anchor is sufficient to ship; the external lenses are additive depth. (Provisioning: the review-council MCP needs its own API credentials configured; if it isn't set up, the local lenses suffice.)

> **Why this split.** The Claude lenses run as interactive subagents because interactive Claude Code was **removed from scope for the June-15 metering change** — that path is bulletproof plan-covered regardless of what happens to programmatic billing. The MCP council *can* run Anthropic lenses natively too (via `claude -p`), and today that is *also* plan-covered — but only because the June-15 metering of `claude -p` was **deferred, not permanently killed** (that deferral is exactly why the MCP was reworked to run Anthropic natively again). So keeping the pivotal opus review in-session is defense-in-depth: the day the `-p` hold lifts, the in-session anchor is unaffected while the MCP's Anthropic path flips to metered. The external lenses run via the MCP because they authenticate with their *own* credentials: codex via your ChatGPT login (plan-covered), gpt/gemini via metered API keys. Composing both halves is the whole point — the diverse external models are where new blind spots surface, with codex as the lead adversarial reviewer.

If a **local lens subagent** fails, retry it once, then proceed with what completed. If the **external council** call fails, see the unavailability note above — proceed with the local anchor and record the gap.

#### 8b. Synthesize & Apply Council Findings

You (the orchestrator, running as opus) are the council's synthesizer — read **all** lens outputs and reconcile them before applying:
- **Inputs:** the two local opus subagent returns (reasoning + cartography) **and** the external lens files in `{workshop_path}/reviews/review-1/`. Read each external lens file the `council_review` summary marked `success`; skip ones marked `failed`/`timeout`.
- **Convergence is signal:** a finding two or more lenses raise independently — *especially across the local/external boundary* — is high-confidence. Fix it.
- **Weight the lead:** codex is the strongest adversarial/grounding reviewer and explores the real code; give its concrete, file-cited findings (e.g. EF/migration traps, integration gaps) extra weight even when raised alone.
- **Dedupe:** collapse the same issue reported by multiple lenses into one.
- **Then apply by severity:**
  - **Critical findings:** Fix immediately in the spec files.
  - **Major findings:** Fix unless they conflict with a deliberate decision (reference the D# and explain why it stands).
  - **Minor findings:** Note but don't fix.

Count amendments applied.

#### 8c. Final Validation Wave

Run one more Sonnet fresh-eyes wave (same prompt as 7a) to verify the council amendments didn't introduce new issues. This is the final quality gate.

Then run the spec-validate script (bundled in this plugin):
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/spec-validate/scripts/validate.mjs" {workshop_path}
```

Report: validation result (errors/warnings/passes) + final wave verdict.

### Phase 9: Final Output

Present the completed spec summary:

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `workshops/{slug}/`
**Packages:** {N} WPs
**Estimated execution:** {autonomous WPs} autonomous, {review WPs} need review
**Dependency order:** {summary}
**Review:** {review_level} — {N} fresh-eyes waves, {N} council lenses, {N} amendments applied
**Validation:** {pass/fail} — {errors} errors, {warnings} warnings
**Cost:** {total $ and tokens, from cost-report}

Ready for execution.
```

If `--review=light` or `--review=none`, the Review and Validation lines reflect what was actually done:
```
**Review:** light — self-review only
**Review:** none — no review performed, manual review recommended before execution
```

---

## Spec Lite (`--depth=lite`)

A compressed specification for well-understood changes. Produces a single `spec.md` in the workshop directory.

### Setup

1. **Parse intent** — extract what, which project, slug (same as deep spec Phase 1a)
2. **Scaffold workshop** — create directory + `meta.json` with status `"captured"`. Mark cost tracking: `node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state {workshop}/cost-log.json --phase lite --event start`
3. **Quick explore** — read key files likely affected. ≤5 files, no Explore agent. If you're reaching for a wider survey, the depth was wrong — upgrade to deep.
4. **Read CORRECTIONS.md** — non-negotiable regardless of depth
5. **KB search** — one `kb_search` query for prior work on this topic

### Write spec.md

A single document with four concise sections:

```markdown
# {Title}

## Problem
{2-4 paragraphs. What we're solving, why, and the current state. Ground in real file paths.}

## Decisions
{Numbered D1, D2... Only real ambiguities — not exhaustive. For each: options considered, choice made, one-line reasoning.}

## Verification
{For each decision: how an observer confirms it was implemented correctly. Concrete commands or observable behavior.}

## Constraints
{M1, MN1, P1, E1... Compressed. Focus on must-nots that prevent the most likely agent mistakes.}
```

Run a quick self-review: ambiguity scan, grounding check, constraint coverage. Fix issues.

### Council Review (opt-in — `--review=full`)

By default lite stops at self-review. If the operator passed `--review=full`, run the **Phase 8 hybrid council** against the single `spec.md` before presenting — both halves handle a lite spec:

- **Local opus lenses** (reasoning + cartography) — the same two Task subagents as Phase 8a, spawned verbatim from the reference prompts. Those prompts read whatever spec artifacts are present in the workshop directory, so on a lite workshop they read `spec.md` (no deep-layout assumption).
- **External council** — one `council_review` MCP call with `surface: "spec"`, `profile: "spec-external"` (the same config-owned external-only profile as Phase 8a — never pass an explicit `models:` list). The collector inlines the root `spec.md` as the artifacts block (`collectSpecFiles` fallback, verified 2026-07-06), so the external lenses review the real content instead of an empty block that makes gemini hallucinate.

Synthesize as in Phase 8b — convergence across the local/external boundary is high-confidence, weight codex, dedupe, apply Critical/Major — then re-run the self-review scan to confirm the amendments introduced nothing new. If the council MCP is unavailable, note the gap and proceed on the local anchor.

### Present for Review

Show a brief summary with flagged items. Wait for approval. Apply revisions if needed.

### Final Output

Update `meta.json` status to `"ready"`. Close cost tracking and generate the report:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state {workshop}/cost-log.json --phase lite --event end
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" report --state {workshop}/cost-log.json
```

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `workshops/{slug}/`
**Depth:** lite — single document
**Review:** {self-review only | self-review + council: N lenses, N amendments applied}
**Cost:** {total $ and tokens, from cost-report}

Ready for execution.
```

Write a ledger event: `{ "type": "workshop_stage", "workshop_slug": "{slug}", "stage": "spec-lite", "event_type": "completed", "actor": "agent" }`

---

## Principles

- **Speed over perfection, but not over correctness.** The refinement loop exists because speed without review produces specs that fail at execution. The loop is fast (Sonnet agents, ~2 min/wave) and the ROI is proven.
- **Ground everything.** No architectural claims without file references. No "the system probably does X."
- **Flag, don't hide.** Uncertainty is fine — hiding it isn't. Use [DECISION] and [ASSUMPTION] callouts liberally.
- **Patterns are runtime reads, not memorized content.** Read each pattern file fresh before writing its artifact. Patterns evolve.
- **The output is a real workshop.** Not a separate format. Everything downstream (validate, review council) works on these artifacts unchanged.
- **Convergence, not perfection.** The refinement loop stops when P1s are gone, not when findings are zero. P3s are noise — chasing them degrades momentum.
- **The spec is a tool, not a gate.** Deep when it helps, lite when it's enough, none when it's overhead. The operator chooses.

## Cost Instrumentation (per-phase)

State file: `{workshop}/cost-log.json`. Collection reads subagent transcripts post-hoc — zero runtime instrumentation; orchestrator-session tokens are NOT counted (known limitation, matches the `/review` cost-pattern precedent).

At the START of each deep-pipeline phase, run:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state {workshop}/cost-log.json --phase phase-N-<slug> --event start
```
Phase names: `phase-1-setup` … `phase-9-final` (matching this document's Phase 1-9 headings). At Phase 9, close the final phase and generate the report:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state {workshop}/cost-log.json --phase phase-9-final --event end
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" report --state {workshop}/cost-log.json
```
Include the printed markdown table in the Phase 9 final output.

Non-blocking: if the script errors, note it and continue — instrumentation never gates the spec.

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
*Pattern library: bundled under `reference/`*
*Related skills: /spec-validate (quality check), /grill-me (stress-test before speccing), /parallel-explore (compare approaches)*
