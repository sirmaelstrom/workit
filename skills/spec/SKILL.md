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

Before council dispatch, check the required review-input layout in `${CLAUDE_PLUGIN_ROOT}/reference/templates/review-council/artifact-layouts.json`. This is the collector's authoritative contract; changing the pipeline's required artifacts requires updating that contract in the same change. Incomplete deep workshops are not ready for full council review. Extra supporting material must be passed explicitly as `artifact_paths`; retained history is not automatically part of the current review.

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

**Lite specs** default to self-review only. Pass `--review=full` to *additionally* run the Phase 8 council against the single `spec.md` (see *Council Review* in the Spec Lite section) — worth it when the change is well-understood but you still want a diverse-model pass on a decision gate. `--review=light`/`none` are no-ops on lite; self-review is already its floor.

### Conductor flags

`/conduct` invokes this skill with two more flags, and with a third on a greenfield repo. The first two don't change what the pipeline produces; they say where it writes and whether the operator has already answered the review gate. The third adds one step before D1.

- **`--greenfield`**: `/conduct`'s intake found a greenfield repo, meaning no CI workflow can gate a PR, or HEAD has at most 3 commits (quest 977d3efb). D1 is then the stack decision, and it isn't ruled until the stack attack has run (§ Stage 2 *Greenfield: attack D1 before ruling it*; lite: § Write spec.md). You can also pass the flag by hand for any spec that picks the stack of a new codebase.

- **`--workshop <abs>`** — an absolute path; quote it in every command that uses it. Phase 1b (deep) and Setup step 2 (lite) create the workshop at that path instead of deriving `{workspace}/data/outputs/workshops/{slug}`, or use it as it is: the directory may already exist, because the conductor creates the run dir inside it first. Existing content is not an error; don't overwrite it. The slug is the path's basename. Wherever this skill says `{workshop_path}` or `{spec-dir}`, it means this path. The invoker starts you in the target repo's root, so Phase 1a takes the project from the current directory and doesn't ask.
- **`--preapproved "<ref>"`** — the operator's approval, given earlier and recorded, covers this spec's review gate. `<ref>` is quoted because it holds spaces. It is one of the three forms below, and it comes only from the invoker's argument: **never write, guess or reconstruct a ref.**

#### Verifying a `--preapproved` ref

Before any gate is crossed, check the ref against the record it names. Every step is yours to perform; nothing else reads it.

0. **Bind it to this run.** The run's state is `<workshop>/run/state.json` (the `--workshop` layout); read it for `runId`. No readable state, or no `runId`, means the ref can't be bound to a run.
1. **`spine:<anchor uuid>@<answeredAt> by <by>`.** Read the quest with the Spine quest-read tool (`spine_quest`). The ref is valid only when the quest's **latest** receipt has outcome `answered`, its `answer.answeredAt` equals `<answeredAt>`, its `answer.by` equals `<by>` and begins `operator:`, and its question carries this run's correlation prefix `(run <runId>/` after the `[conduct <slug> touch <n>]` tag (the bare tag isn't enough: it is shared by every run of the same goal). A superseded receipt (a later one exists), an unanswered one, or one not attributed to an operator is not an approval. If a later receipt supersedes the approval, stop: the conductor re-files the touch, an extra touch that the run analysis counts. With no Spine tool to read it, the ref can't be verified.
2. **`core:<path>`.** The path resolves to a file under `<workshop>/run/touches/`, which exists, parses as JSON, and has one of the two shapes the conductor writes. Validate each against its own shape:
   - a touch record `touches/<n>.json` (any `<n>`: a re-asked touch after an ambiguous grant is `touches/2.json`): `status` is `answered`, `tty` is `true`, `answer.by` begins `operator:`, and `kind` is `preapproval` or the re-ask (`blocked` with a question about the "(c) answer to touch <m>"; any other blocked touch is not an approval);
   - an authority record `touches/<n>-authority.json` (the checked grant after a "change it" answer): `{ merge, release, budgetUsd, scope, validated: true, touch, grant, answer }` with `validated` `true`, a non-empty `scope`, and an `answer` whose `key` is `c` and whose `by` begins `operator:`.

   A file that is missing, unreadable, outside `<workshop>/run/touches/`, of another shape, or with an empty `answer` is not an approval.
   
   **The answer must approve.** The conductor maps the answer key to authority: `a` approves as proposed, `b` approves with every PR held, `c` approves a checked grant (recorded as the authority record, never as the touch record), and **`d` declines** the run. So a touch record or a Spine answer is an approval only with key `a` or `b`, and an authority record only with key `c`. A decline, or any other key, is a stop.
3. **Scope.** When the record carries `scope` (the authority record), keep the goal for context but write the spec, the WPs and every assumption **only inside the scope**. List whatever the goal asks beyond it under an `Out of scope` heading (a short list in `problem-statement.md`, or in lite's Problem section) and never plan it. The goal text stays verbatim: the conductor passes it unchanged even under a narrowed grant. A touch record or a Spine answer carries no `scope`: it approves the goal as written. An `[ASSUMPTION: …]` that would widen the scope is not written.
4. **Any failed check keeps the normal stop** (the gate waits for a person, as without the flag) and prints one line naming the check that failed: `Gate not preapproved: <the check>`. An empty value, or one beginning with neither `spine:` nor `core:`, fails step 1 or 2 the same way.

With a verified `--preapproved`:
- **Deep, Phase 4:** still write and render `review-gate.json`, set `meta.json` `gate` to `"preapproved <ref>"`, print one line naming the ref, and continue to Phase 6 without stopping at `**STOP HERE.**`.
- **Lite, Present for Review:** print the summary, record the same `gate`, and continue to Final Output without waiting.
- **`--review=none`:** crosses Phase 4 and Present for Review the same way, records the same `gate`, and skips only the `review-gate.json` emission, as it already does without the flag.
- **Council unavailable:** the Phase 8 and lite council branches continue on the self-review floor and record `"council": "unavailable"` in `meta.json`; they do not stop.
- **No sub-agent for the fresh-eyes reviewer:** Phase 7a continues on the self-review floor and records `"fresh-eyes": "unavailable"` in `meta.json`; it does not stop.
- The flag skips no review wave: the fresh-eyes loop, the council and the final wave still run at whatever `--review` level applies. It only answers the gate that waits for a person.
- `[ASSUMPTION: …]` flags no longer reach a person at the gate. List every one on the `**Assumptions:**` line of the final output (Phase 9 / lite Final Output).

Without these flags, every gate and stop in this skill is unchanged.

---

## Spec Deep (`--depth=deep`)

Full methodology. Grounded, adversarial, iterative.

### Phase 1: Setup & Exploration

#### 1a. Parse Intent

Extract from the intent:
- **What** is being built or changed
- **Which project(s)** this touches — check your projects directory for matching repos
- **Slug** — kebab-case, ≤40 chars

If the project is ambiguous, ask (with `--workshop`, take it from the current directory and don't ask: § Conductor flags). If the scope is ambiguous, make your best guess and flag it as `[ASSUMPTION: A1]` — the human will correct at the review gate (under a verified `--preapproved` there is no such gate: the flags are listed on the final output's `**Assumptions:**` line instead).

#### 1b. Scaffold Workshop

Create `{workspace}/data/outputs/workshops/{slug}/` (under the workspace root's data-outputs tree, never a cwd-relative `./outputs/`) with `meta.json`. With `--workshop <abs>` (§ Conductor flags), create that path instead and take the slug from its basename:
```json
{
  "title": "{title}",
  "slug": "{slug}",
  "status": "captured",
  "projects": ["{project}"],
  "tags": [],
  "startedAt": "{ISO timestamp}",
  "createdAt": "{ISO timestamp}",
  "updatedAt": "{ISO timestamp}"
}
```

#### 1c. Explore Codebase

Before writing anything, ground yourself in the actual code. Use the Agent tool to launch an Explore agent when available; with no Explore agent, read the target's tree with your own tools. Either way, find:

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

Then search the KB for prior work on this topic, when available (with no KB tool, skip this and say so):
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

#### Blind second read (consequential specs)
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/blind-second-read.md`
- A deep spec counts as consequential by default. A lite spec counts when one of its decisions is a one-way door. Record the call in one line at the top of `decisions.md`.
- **Dispatch it now, before Stage 2 is written.** Send `problem-statement.md`, the constraints known so far (the operator's words, applicable CORRECTIONS entries, binding rulings) and the Phase 1 evidence to a model from another vendor family (`codex-delegate`'s carve-out). Do not send any draft decision. It runs while you write Stages 2-4.
- Writes `blind-read-<model>-<YYYY-MM-DD>.md`, which is conditional and stays out of the council's required layout. It holds the verbatim opening and the reconciliation table. Reconcile before Phase 3. Each disagreement either amends a decision or stays open as a `[DECISION: Dn — low confidence]` flag for the Phase 4 gate. Keep the table out of `decisions.md`, because the ambiguity scan there would flag its comparison wording.
- This read does not replace the Phase 8 council. The council reviews the finished spec, and the blind read checks the framing before the spec exists.

#### Stage 2: Decisions
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/decision-resolution.md`
- Output: `decisions.md`
- Key discipline: Scan your own problem statement for ambiguity flags ("or", "possibly", "might", "TBD", "should consider"). Each real ambiguity becomes a numbered decision (D1, D2...).
- For each decision: list options, state tradeoffs (one line each), **choose one**, document reasoning.
- Mark decisions where you're uncertain as `[DECISION: D3 — low confidence, alternatives close]`.
- Use the `parallel-explore` pattern mentally — consider at least 2 approaches before choosing.

#### Greenfield: attack D1 before ruling it (`--greenfield` only)
- Pattern: `${CLAUDE_PLUGIN_ROOT}/reference/patterns/stack-attack.md`. Follow its procedure and use its lens prompt verbatim, filling only the slots.
- **D1 is the stack decision.** Draft it with its options, the drafted choice and the core loop, marked `[DECISION: D1 — pending stack attack]`. Don't rule it yet. The other decisions can be drafted meanwhile, but none that depends on the stack is ruled before D1.
- **Run the lens**: one turn from a model of another vendor family, the same `codex exec` invocation as the blind second read. Save it as `stack-attack-<model>-<YYYY-MM-DD>.md`. It reads the draft on purpose, because attacking the draft is its job.
- **`Verdict: no credible alternative`**: rule D1 as drafted, and answer the attack's strongest point in D1's reasoning.
- **`Verdict: credible alternative`**: run 2–3 throwaway spikes of the core loop through `parallel-explore` § Spike mode. The branches are the drafted stack plus each alternative the lens named. Rule D1 from the spike synthesis's measured numbers. Spike code never enters the workshop.
- **D1 ends with** `Stack attack: <verdict> (<file>)`, plus `Spikes: <synthesis path>; worst case <branches × timeout>, took <wall-clock>` when spikes ran. Phase 9's summary repeats that line. With a verified `--preapproved`, neither step waits for a person. The build's budget gate does not meter the spikes at dispatch; only the spend adapter's first reading counts them, afterwards (`parallel-explore` § Spike mode, *Cost check*).
- The lens file and the spike synthesis are supporting material, outside the council's required layout. Pass them to Phase 8 as `artifact_paths` so the council sees why D1 holds.

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
- **A goal with a UI gets a design direction.** Write a `## Design direction` section of numbered rules, each one a thing a screenshot can pass or fail. Four rules open with these labels: `**Palette:**` (the color tokens and where each one is used), `**Type scale:**` (sizes and weights, and what each is for), `**Iconography:**` (one rule for glyphs and icons), and `**Fit to view:**` (what fills the viewport at load). Add other rules as the goal needs. A deep spec puts the section in `work-packages/_orchestrator.md` (Stage 6); a lite spec puts it in `spec.md`. `/conduct` refuses a section without those four labels, and its merge gate reads each UI WP's frames against these rules by number.

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

**With a verified `--preapproved "<ref>"` (§ Conductor flags, *Verifying a `--preapproved` ref*):** the gate is already answered. Set `meta.json` `gate` to `"preapproved <ref>"`, print one line naming the ref, and continue to Phase 6 without stopping. The `review-gate.json` above is still written and rendered, except under `--review=none`, which skips it as before.

**Without `--preapproved`, or when its ref doesn't verify: STOP HERE.** Use the ask rule below. Wait for human input. Do not proceed to decomposition without explicit approval.

**Ask rule for both review gates:** Pose any ask or list of choices as selectable
options (AskUserQuestion in T3), with the Dogan ask filed too when it needs a
record; a T3 answer is written back to Spine the same turn. Put the ask key in
each option label (`a — Full grant, $200`) and the receipt tag in the question
(`[ask <receiptId>]`) when a Spine ask exists. Use at most four options per
question; split or collapse a Dogan ask with five or six options. A headless
lane with no operator present files the Dogan ask only. For now, write a T3
answer as a conductor receipt quoting it; `spine_receipt` cannot write
`answered`.

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
- Required fields per WP: the 6 core ones (precondition, goal, files, verification, failure criteria, boundary) plus three that `/conduct`'s scheduler reads. `spec-validate` rejects a WP missing any of them; the rule and each field's form live in `${CLAUDE_PLUGIN_ROOT}/reference/patterns/work-package.md`:
  - **Files** as bullets that begin `- Create ` or `- Modify ` with the path as the first backticked token (a WP with no such bullet parses to an empty file set and runs alone).
  - `**Review tier:** T0|T1|T2`.
  - `**Runtime exercise:**` — the surface and the check, or `none: <why>`.
- **With a design direction (Stage 4):** copy it into the orchestrator's `## Design direction`. Each WP that changes what the UI shows declares `**Visual rules:** <rule numbers | all>`, and its runtime exercise takes frames that can show them. Schedule one polish WP as the only WP of the last wave, after every functional WP: it declares `**Skills:** frontend-design:frontend-design` and `**Visual rules:** all`.
- Tag each WP: `execution: autonomous` or `execution: review-needed` (HITL flag)
- Dependency order (which WPs must complete before others can start)
- Spec-level constraints in orchestrator (from constraints.md)

Update `meta.json` status to `"ready"`.

**If `--review=none`:** Skip to Phase 9 (Final Output).
**If `--review=light`:** Skip to Phase 9 (Final Output). The self-review in Phase 3 is the only quality pass.
**If `--review=full`:** Continue to Phase 7.

### Phase 7: Refinement Loop (--review=full only)

Iteratively review the work packages using fresh-eyes Opus sub-agents until convergence.

#### 7a. Fresh-Eyes Wave

Launch an Opus sub-agent using the Agent tool (`model: opus`): the fresh-eyes verdict is a gate nothing re-checks, so it goes to the higher tier. The full prompt template lives in `${CLAUDE_SKILL_DIR}/reference/fresh-eyes-prompt.md` — read that file and substitute `{workshop_path}` and `{project_path}` before spawning. Use it verbatim; the structured verdict format is what Phase 7d's convergence logic reads. With a verified `--preapproved`, if no sub-agent is available for this reviewer, continue on the self-review floor and record `"fresh-eyes": "unavailable"` in `meta.json`; without `--preapproved`, nothing changes.

#### 7b. Fix Findings

After each wave:
- Give each finding a stable id (`W{wave}-F{number}`). Record every finding and its disposition (`fixed`, `skipped`, `false_positive`, or `noted`) in `{workshop_path}/reviews/refinement-wave-{N}-dispositions.json`. For a fixed finding, record its original finding text and the claimed fix. Keep these records across waves; do not rely on memory or the fresh-eyes prompt to carry dispositions.
- Before changing spec files, copy the spec artifacts (`work-packages/`, `_orchestrator.md` within it, and any other spec file being changed) to `{workshop_path}/reviews/refinement-wave-{N}-before/`, preserving relative paths. After applying fixes, copy the same artifacts to `refinement-wave-{N}-after/`. These directories are the input to the fix-check diff.
- **P1s:** Fix immediately. These are blockers — update the WP spec files directly.
- **P2s:** Fix unless the fix would introduce more complexity than the ambiguity costs. Document skipped P2s.
- **P3s:** Note but do not fix unless trivial. Accumulate across waves.
- **False positives:** The agent uses regex-like heuristics. If a finding is wrong (e.g., "or" in normal English flagged as ambiguity), discard it and note it as a false positive.

#### 7c. Fix Check

After applying a wave's fixes, export only that wave's `fixed` dispositions to `{workshop_path}/reviews/refinement-wave-{N}-fixed.json` as an array of `{ "id": "W{N}-F1", "finding": "original finding text", "claimed_fix": "what changed" }`. When the array is nonempty, run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fix-check.mjs" prepare --findings "{workshop_path}/reviews/refinement-wave-{N}-fixed.json" --before "{workshop_path}/reviews/refinement-wave-{N}-before" --after "{workshop_path}/reviews/refinement-wave-{N}-after" --output "{workshop_path}/reviews/refinement-wave-{N}-fix-check-prompt.md"
```

Launch a **separate Sonnet sub-agent** with that assembled prompt (`model: sonnet` in the same Agent tool used in 7a). Sonnet is the cheaper seat this skill can already dispatch; the fresh-eyes Opus prompt and reviewer receive no fix-check input. Save Sonnet's JSON verdict to `{workshop_path}/reviews/refinement-wave-{N}-fix-check-verdict.json`, then run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fix-check.mjs" complete --findings "{workshop_path}/reviews/refinement-wave-{N}-fixed.json" --verdict "{workshop_path}/reviews/refinement-wave-{N}-fix-check-verdict.json" --after "{workshop_path}/reviews/refinement-wave-{N}-after" --wave {N} --output "{workshop_path}/reviews/refinement-wave-{N}-fix-check.json" --next-dispositions "{workshop_path}/reviews/refinement-wave-{N+1}-dispositions.json"
```

The script requires one `held | failed | partial` verdict per fixed finding and checks each quoted line against the post-fix spec. `failed` and `partial` both count as failed checks. It writes them as `reopened` entries in **the next wave's** `reviews/refinement-wave-{N+1}-dispositions.json`, with the original id, check status, and evidence. At that wave, add the new fresh-eyes findings to this file and resolve the reopened entries explicitly, even if the fresh-eyes reviewer does not repeat them. A `held` finding stays closed. A failed or partial check requires another wave unless the eight-wave force-convergence limit applies; report any still-open finding at that limit. If no fixes were claimed, skip Sonnet and run `node "${CLAUDE_SKILL_DIR}/scripts/fix-check.mjs" empty --wave {N} --output "{workshop_path}/reviews/refinement-wave-{N}-fix-check.json"` so a subsequent wave records `checked: 0, failed: 0`.

#### 7d. Convergence Check

After fixing, decide whether to run another wave. A failed or partial fix check takes precedence over a clean/P3-only fresh-eyes verdict; the eight-wave limit still force-converges:

| Condition | Action |
|-----------|--------|
| Wave returned P1s | Fix and run another wave (mandatory) |
| Wave returned P2s only, fixes applied | Run one more wave to verify fixes |
| Fix check returned `failed` or `partial` | Reopen each in the next wave's dispositions and run another wave |
| Wave returned P3s only or was clean | **Converged** — proceed to council |
| 8 waves completed | **Force converge** — proceed to council regardless |

Track across waves: if wave N finds the same P2 that wave N-1 found and it was already evaluated and kept, that's not a new finding — it's convergence noise. Suppress it.

#### 7e. Report Progress

After each wave, briefly report to the user:
```
Wave {N}: {P1_count} P1, {P2_count} P2, {P3_count} P3. {Fixed X issues. | Clean.} {Converged — moving to council. | Running wave {N+1}.}
```

Keep it to one line. The user doesn't need to see every finding — they'll see the final result.

### Phase 8: Council Review (--review=full only)

After the fresh-eyes loop converges:

#### 8a. Deploy Council

The council is a **single call to the `review-council` MCP**, which fans out every lens in the config-owned `spec` profile in parallel — Anthropic lenses (via `claude -p`) and external lenses alike — and writes one lens file per model. Its real value is the **synthesis across diverse models**: different model families surface different blind spots. Make ONE call:

```
mcp__review-council__council_review({
  workshop_path: "{workshop_path}",
  surface: "spec",
  round: 1,
  profile: "spec",
  thinking: "medium"
})
```

The `spec` profile is **config-owned** — its membership lives in `models.json` (`profiles.spec`), so the roster can rotate without editing this skill; read `profiles.spec` for the current seats. Two properties are load-bearing:

- **Anthropic runs natively via `claude -p` inside the MCP** — no separate in-session subagent anchor. This is plan-covered *today* only because the June-15 metering of `claude -p` was **deferred, not killed**. ⚠️ **Revert trigger:** the day `api_usage` anthropic rows flip `cost_basis` `notional`→`metered`, the opus + carto lenses start billing at API rates — at that point drop the Anthropic lenses from the `spec` profile (or point `/spec` back at `spec-external` + a local opus anchor). Watch: `SELECT cost_basis,count(*) FROM api_usage WHERE provider_id='anthropic' AND created_at>now()-interval '2 days' GROUP BY 1;` — a live instrument since 2026-08-29: Observatory's `costBasisFor` now observes `ANTHROPIC_API_KEY` presence in the recording process (until then anthropic-notional was hardcoded and this query was a tautology that could never fire).
- Do **not** pass `models:` here — naming an explicit list re-inlines the roster this profile exists to own (explicit `models` overrides `profile` when both are present).

The tool returns a JSON summary with each model's status and lens filename; the files land in `{workshop_path}/reviews/review-1/` (one `review-lens-{model}.md` per lens). Read those in 8b.

> **If the council is unavailable** (the MCP errors, returns all-failed, or isn't registered on this machine): the self-review floor from Phase 7 is your ship gate — note the gap explicitly in the Phase-9 summary and let the operator decide whether to proceed or defer. **With a verified `--preapproved`:** don't stop to let the operator decide — continue on the self-review floor and record `"council": "unavailable"` in `meta.json`. (Provisioning: the review-council MCP needs its own API credentials configured; if it isn't set up, self-review is the floor.)

If the **council** call fails, retry it once; if it still fails, see the unavailability note above — fall back to the self-review floor and record the gap.

#### 8b. Synthesize & Apply Council Findings

You (the orchestrator, running as opus) are the council's synthesizer — read **all** lens outputs and reconcile them before applying:
- **Inputs:** the lens files in `{workshop_path}/reviews/review-1/`. Read each lens file the `council_review` summary marked `success`; skip ones marked `failed`/`timeout`.
- **Convergence is signal:** a finding two or more lenses raise independently — *especially across vendor families (codex/grok/opus/sonnet)* — is high-confidence. Fix it.
- **Weight the lead:** the LEAD seat (`astra` since 2026-09-09, quest d0620857; `codex` before that, now the second seat — Terra then, GPT-6 Sol since 2026-09-23) explores the real code; give its concrete, file-cited findings (e.g. EF/migration traps, integration gaps) extra weight even when raised alone. Read which seat is LEAD from `data/config/review-council/models.json` (first entry of the profile, `defaults.synthesisModel`), never from this line.
- **Dedupe:** collapse the same issue reported by multiple lenses into one.
- **Then apply by severity:**
  - **Critical findings:** Fix immediately in the spec files.
  - **Major findings:** Fix unless they conflict with a deliberate decision (reference the D# and explain why it stands).
  - **Minor findings:** Note but don't fix.

Count amendments applied.

#### 8c. Final Validation Wave

Run one more Opus fresh-eyes wave (same prompt and model as 7a) to verify the council amendments didn't introduce new issues. This is the final quality gate.

Then run the spec-validate script (bundled in this plugin):
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/spec-validate/scripts/validate.mjs" "{workshop_path}"
```

Report: validation result (errors/warnings/passes) + final wave verdict.

### Phase 9: Final Output

Present the completed spec summary:

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `{workshop_path}` (the `--workshop` path when given, else `{workspace}/data/outputs/workshops/{slug}/`)
**Packages:** {N} WPs
**Estimated execution:** {autonomous WPs} autonomous, {review WPs} need review
**Dependency order:** {summary}
**Assumptions:** {every `[ASSUMPTION: …]` flag, one line each; required with `--preapproved`, where no gate shows them to a person}
**Stack attack:** {with `--greenfield` only: D1's `Stack attack:` line, and `Spikes:` when they ran}
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
2. **Scaffold workshop** — create directory (at `--workshop <abs>` when given, § Conductor flags) + `meta.json` with status `"captured"`. Mark cost tracking: `node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state "{workshop}/cost-log.json" --phase lite --event start`
3. **Quick explore** — read key files likely affected. ≤5 files, no Explore agent. If you're reaching for a wider survey, the depth was wrong — upgrade to deep.
4. **Read CORRECTIONS.md** — non-negotiable regardless of depth
5. **KB search** — one `kb_search` query for prior work on this topic, when available (with no KB tool, skip and say so)

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

**A goal with a UI:** add the `## Design direction` section (deep Stage 4) and a `**Visual rules:** <rule numbers | all>` line, so `/conduct` reads the change's frames against those rules at the merge gate.

**Greenfield (`--greenfield`)?** D1 is the stack decision. Draft it as `[DECISION: D1 — pending stack attack]` and run the stack attack before you rule it, exactly as deep Stage 2 does (*Greenfield: attack D1 before ruling it*): the lens first, and spikes only on `Verdict: credible alternative`. D1 ends with the `Stack attack:` line.

**One-way door?** When a decision in the lite spec is a one-way door, write `## Problem` and `## Constraints` first and dispatch the blind second read (deep Stage 1, `blind-second-read` pattern) on those two sections plus the files you read. Then write `## Decisions` and reconcile the two before the self-review.

### Council Review (opt-in — `--review=full`)

By default lite stops at self-review. If the operator passed `--review=full`, run the **Phase 8 council** against the single `spec.md` before presenting — the pure-MCP path handles a lite spec unchanged:

- One `council_review` MCP call with `surface: "spec"`, `profile: "spec"` (the same config-owned roster as Phase 8a — Anthropic lenses via `claude -p` + external lenses; never pass an explicit `models:` list). The collector inlines the root `spec.md` as the artifacts block (`collectSpecFiles` fallback, verified 2026-07-06), so every lens reviews the real content instead of an empty block that makes gemini hallucinate.

Synthesize as in Phase 8b — convergence across vendor families is high-confidence, weight codex, dedupe, apply Critical/Major — then re-run the self-review scan to confirm the amendments introduced nothing new. If the council MCP is unavailable, note the gap and fall back to the self-review floor. With a verified `--preapproved`, also record `"council": "unavailable"` in `meta.json`.

### Present for Review

Show a brief summary with flagged items. Use the ask rule above. Wait for approval.
Apply revisions if needed.

**With a verified `--preapproved "<ref>"` (§ Conductor flags, *Verifying a `--preapproved` ref*):** print the summary, set `meta.json` `gate` to `"preapproved <ref>"`, print one line naming the ref, and continue to Final Output without waiting.

### Final Output

Update `meta.json` status to `"ready"`. Close cost tracking and generate the report:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state "{workshop}/cost-log.json" --phase lite --event end
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" report --state "{workshop}/cost-log.json"
```

> **The report reads the SESSION's transcripts, not the workshop's.** The
> default projects-dir is derived from the state file's recorded cwd — the
> *workshop* path — and workshops live outside the repo the session was launched
> in, so that slug usually names a directory which has never existed. The report
> then labels itself `NOT MEASURED` and lists candidate directories: pass
> `--projects-dir <one of them>`, or set `WORKIT_CLAUDE_PROJECTS_DIR`. A `$0`
> total *without* that label means zero; *with* it, it means not collected.
> Always `--event end` a phase before trusting a total — an open phase's window
> runs to now and keeps absorbing later transcripts on every re-run.

```markdown
## ✅ Spec Complete: {title}

**Workshop:** `{workshop_path}` (the `--workshop` path when given, else `{workspace}/data/outputs/workshops/{slug}/`)
**Depth:** lite — single document
**Review:** {self-review only | self-review + council: N lenses, N amendments applied}
**Assumptions:** {every `[ASSUMPTION: …]` flag, one line each; required with `--preapproved`, where no gate shows them to a person}
**Stack attack:** {with `--greenfield` only: D1's `Stack attack:` line, and `Spikes:` when they ran}
**Cost:** {total $ and tokens, from cost-report}

Ready for execution.
```

Write a ledger event — as `event_type: "note"` with the stage record in the payload (see Ledger Events below for why): `{ "event_type": "note", "payload": { "content": "workshop_stage {slug}: spec-lite completed", "workshop_stage": { "workshop_slug": "{slug}", "stage": "spec-lite", "actor": "agent" } } }`

---

## Principles

- **Speed over perfection, but not over correctness.** The refinement loop exists because speed without review produces specs that fail at execution. The loop is fast (a few minutes per wave) and the ROI is proven.
- **Ground everything.** No architectural claims without file references. No "the system probably does X."
- **Flag, don't hide.** Uncertainty is fine — hiding it isn't. Use [DECISION] and [ASSUMPTION] callouts liberally.
- **Patterns are runtime reads, not memorized content.** Read each pattern file fresh before writing its artifact. Patterns evolve.
- **The output is a real workshop.** Not a separate format. The review council works on these artifacts unchanged; `spec-validate` applies to **deep** specs only — its checker hard-errors on a lite spec's single-file shape (auto-memory `workit-spec-validate-files-header-strict`).
- **Convergence, not perfection.** The refinement loop stops when P1s are gone, not when findings are zero. P3s are noise — chasing them degrades momentum.
- **The spec is a tool, not a gate.** Deep when it helps, lite when it's enough, none when it's overhead. The operator chooses.

## Cost Instrumentation (per-phase)

State file: `{workshop}/cost-log.json`. Collection reads subagent transcripts post-hoc — zero runtime instrumentation; orchestrator-session tokens are NOT counted (known limitation).

At the START of each deep-pipeline phase, run:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state "{workshop}/cost-log.json" --phase phase-N-<slug> --event start
```
Phase names: `phase-1-setup` … `phase-9-final` (matching this document's Phase 1-9 headings). At Phase 9, close the final phase and generate the report:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" mark --state "{workshop}/cost-log.json" --phase phase-9-final --event end
node "${CLAUDE_SKILL_DIR}/scripts/spec-cost.mjs" report --state "{workshop}/cost-log.json"
```
Include the printed markdown table in the Phase 9 final output.

Non-blocking: if the script errors, note it and continue — instrumentation never gates the spec.

## Ledger Events

Write timing events at each stage transition (fire-and-forget, non-blocking). The context ledger's `event_type` column CHECK-constrains to `handoff`/`thread`/`note` — a literal `workshop_stage` event type 23514s. Send stage events via `ledger_write` as `event_type: "note"` with the stage record in the payload:
```json
{ "event_type": "note", "payload": { "content": "workshop_stage {slug}: {stage} entered", "workshop_stage": { "workshop_slug": "{slug}", "stage": "{stage}", "actor": "agent" } } }
{ "event_type": "note", "payload": { "content": "workshop_stage {slug}: {stage} completed", "workshop_stage": { "workshop_slug": "{slug}", "stage": "{stage}", "actor": "agent" } } }
```

For the refinement loop, write one event per wave after its fresh-eyes verdict. Use `fix-check.mjs ledger` to shape the event, then send the JSON to `ledger_write`. Wave 1 has no `fix_check`: nothing from a previous wave can be checked. For wave N > 1, pass wave N-1's `refinement-wave-{N-1}-fix-check.json` as `--prior-report`; its `fix_check` counts belong to wave N. The `findings` counts are the current fresh-eyes verdict, not the reopened count.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fix-check.mjs" ledger --slug "{slug}" --wave {N} --p1 {p1} --p2 {p2} --p3 {p3} --prior-report "{workshop_path}/reviews/refinement-wave-{N-1}-fix-check.json" --output "{workshop_path}/reviews/refinement-wave-{N}-ledger.json"
```

Omit `--prior-report` for wave 1. The event payload has this shape for wave N > 1:
```json
{ "event_type": "note", "payload": { "content": "workshop_stage {slug}: refinement_wave_{N} completed (p1 {p1} / p2 {p2} / p3 {p3})", "workshop_stage": { "workshop_slug": "{slug}", "stage": "refinement_wave_{N}", "actor": "agent", "findings": { "p1": 0, "p2": 0, "p3": 0 }, "fix_check": { "checked": 0, "failed": 0 } } } }
```

---
*Pattern library: bundled under `reference/`*
*Related skills: /spec-validate (quality check), /grill-me (stress-test before speccing), /parallel-explore (compare approaches), /chart (map a foggy multi-session effort before speccing)*
