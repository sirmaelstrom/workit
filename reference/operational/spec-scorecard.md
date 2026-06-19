---
name: Spec Scorecard
description: Post-dispatch evaluation of spec quality — structured scoring that feeds the evaluation loop
tags: [evaluation, quality, spec, dispatch]
variables:
  spec_path:
    label: Spec prompt path
    placeholder: "e.g., ./outputs/workshops/dispatch-form/work-packages/wp-03-ui.md"
  model:
    label: Executor model
    placeholder: "e.g., Opus 4.6, Sonnet 4.6"
  wp_completed:
    label: Work packages completed
    placeholder: "e.g., 5 / 5"
---

# Spec Scorecard

**Use this after a spec prompt has been executed by a dispatch or CLI session.** Fill in during or after execution review. The goal is to build a feedback loop that improves spec quality over time.

This is a concrete instantiation of `evaluation-loop` Layer 1 (Dispatch Outcome Tracking). The scorecard produces the data; the evaluation loop governs what you do with it.

## Scope Fence

**This template IS for:** Evaluating how well a *specification* performed — did it produce the right output with minimal rework? Grades the spec, not the code.

**This template is NOT for:**
- Verifying the build matches visual/behavioral intent (use `post-build-verification`)
- Reviewing code quality (use `code-review` or `Audit codebase`)
- Post-mortem of a full campaign (use `campaign-closeout` pattern)
- Reviewing specs before dispatch (use `review-council` pattern)

## Target

- **Spec prompt:** {{spec_path}}
- **Executor model:** {{model}}
- **Work packages completed:** {{wp_completed}}
- **Execution date:** (today)
- **Total execution time:** (measure)

---

## Scoring Dimensions

Rate each dimension 1-5. **3 = acceptable.** Evidence is required for scores of 1-2 or 5.

### 1. Structural Clarity (Did the agent know what to do?)

| Aspect | Score | Notes |
|--------|-------|-------|
| Work package ordering — were dependencies correct? | /5 | |
| Scope boundaries — did the agent stay in scope? | /5 | |
| Ambiguity — did the agent have to guess intent? | /5 | |
| Reference files — were they sufficient? | /5 | |

**Structural total:** /20

*Maps to patterns: `decomposition` (ordering), `scope-fence` / `constraint-architecture` (boundaries), `decision-resolution` (ambiguity)*

### 2. Specification Precision (Was the right thing built?)

| Aspect | Score | Notes |
|--------|-------|-------|
| Code snippets — were examples followed accurately? | /5 | |
| Naming/conventions — did output match spec conventions? | /5 | |
| Design decisions — were decisions respected (not re-decided)? | /5 | |
| Edge cases — were they anticipated in the spec? | /5 | |

**Precision total:** /20

*Maps to patterns: `spec-engineering` (specification quality), `work-package` (code specificity by type), `decision-resolution` (decision respect)*

### 3. Execution Efficiency (Was work wasted?)

| Aspect | Score | Notes |
|--------|-------|-------|
| Rework — how many packages needed correction? | /5 | |
| Token burn — was the session length proportional to work? | /5 | |
| Parallelization — could packages have been parallelized? | /5 | |
| Tool use — was tool usage efficient (no unnecessary reads)? | /5 | |

**Efficiency total:** /20

*Maps to patterns: `wave-execution` (parallelization), `work-package` (self-containment rule)*

### 4. Guardrail Effectiveness (Were mistakes prevented?)

| Aspect | Score | Notes |
|--------|-------|-------|
| Critical guardrails — were "DO NOT" items respected? | /5 | |
| Verification steps — did per-package verification catch issues? | /5 | |
| CLAUDE.md corrections — were project-specific traps avoided? | /5 | |
| Build verification — did gate commands work? | /5 | |

**Guardrail total:** /20

*Maps to patterns: `constraint-architecture` (four-category constraints), `test-first-spec` (verification hierarchy), `corrections-loop` (CLAUDE.md effectiveness)*

### 5. Completeness (Did we get what we asked for?)

| Aspect | Score | Notes |
|--------|-------|-------|
| Feature completeness — all work packages done? | /5 | |
| Visual fidelity — does output match design intent? | /5 | |
| Integration — does it work in the full app context? | /5 | |
| Polish — rough edges, missing transitions, broken states? | /5 | |

**Completeness total:** /20

*Maps to: `post-build-verification` (visual/behavioral verification)*

---

## Overall Score: /100

| Range | Assessment |
|-------|------------|
| 85-100 | Excellent — spec is reusable with minimal changes |
| 70-84 | Good — spec worked, minor improvements needed |
| 55-69 | Acceptable — got there but with notable friction |
| 40-54 | Weak — significant rework or re-prompting needed |
| < 40 | Failed — spec needs fundamental restructuring |

---

## Deviation Log

List every point where the agent deviated from the spec. Not to punish — to understand where the spec was unclear or wrong.

| Package | Deviation | Root Cause | Spec Change Needed? |
|---------|-----------|------------|---------------------|
| | | Ambiguous / Missing / Wrong / Agent error | |

Root cause categories:
- **Ambiguous** — spec could be read multiple ways → tighten with `decision-resolution`
- **Missing** — spec didn't cover this case → add to work package or constraints
- **Wrong** — spec assumed something false → correct the assumption
- **Agent error** — spec was clear, agent didn't follow it → add to `corrections-loop`

---

## Prompt Improvement Actions

Based on this evaluation, what changes would improve the spec for next time?

### Over-specified (remove or loosen)
-

### Under-specified (add detail or examples)
-

### Wrong assumptions (the spec assumed something false)
-

### Missing guardrails (the agent did something unexpected)
-

### Structural changes (reorder packages, split/merge, add phases)
-

---

## Feed-Back Destinations

Route findings to the right places (from `campaign-closeout` feed-back phase):

| Finding | Destination |
|---------|-------------|
| Pattern insight | Append to relevant pattern's "Execution Feedback" section |
| Agent mistake | Add to project's CLAUDE.md via `corrections-loop` |
| Recurring spec gap | Update `work-package` or `constraint-architecture` pattern |
| Process improvement | Update this scorecard template |

---

## Meta-Observations

Things learned about specifying work in general (not specific to this spec). These feed `evaluation-loop` Layer 2 (Pattern Effectiveness).

-

## Execution Feedback

*(Append results from actual scorecard runs — which dimensions consistently score low, which scoring aspects are redundant or missing)*

---
*Operational template — post-dispatch spec quality evaluation*
*Instantiates: `evaluation-loop` Layer 1 (Dispatch Outcome Tracking)*
*Applies: `scope-fence`, `corrections-loop` (feed-back routing), `test-first-spec` (verification scoring)*
*See also: `post-build-verification` (verifies build output), `campaign-closeout` (full campaign lifecycle)*
