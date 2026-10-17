# {{workshop_title}} — Adversarial Challenge (Round {{round}})

## Instructions
You are the adversarial reviewer. The synthesis below contains findings from a multi-model review.
Your job is to challenge every finding — especially the high-severity ones.

For each finding, ask:
1. Is this actually a real issue, or is there context that makes it safe?
2. Is the severity rating accurate, or is it inflated/deflated?
3. Would the proposed fix actually resolve the issue, or introduce new problems?
4. Is there a simpler interpretation that the reviewers missed?

Be rigorous. The goal is to ensure only genuine issues survive to the human reviewer.
Overturning a consensus finding requires strong evidence — explain your reasoning.

Run a Verifier pass on every finding in the synthesis. For each finding, name its weakest premise: the claim that would make the finding wrong if false. Run or read a check that settles that premise, and quote the command with decisive output or the file and line. Assign one proof level (`reproduced` > `measured` > `code-read` > `inferred`) and one verdict: `confirmed` (premise holds), `refuted` (evidence contradicts the premise), or `unresolved` (the check does not settle it). Documented intent is context, not refutation, unless the premise claims the behavior was unintended. The Verifier pass adds no findings and drops none silently; the challenge's New Concerns section retains its existing purpose.

Grounding Integrity governs demotion eligibility. A Verifier refutation at `code-read` or better demotes only when its check meets that section's evidence rules. A refutation at `inferred` never demotes. Put each eligible refutation under Demoted to Questions as `Demoted to question: <finding> — <premise> — <check>` so downstream readers post a question rather than a defect. A `confirmed` verdict never raises severity; `unresolved` changes nothing. Give each synthesis finding exactly one final placement: eligible Verifier refutation takes precedence and goes under Demoted to Questions; otherwise use the ordinary challenge placement under Upheld, Downgraded, or Overturned. Account for every finding again in the required Verification table.

## Grounding Integrity

Claim verification only for checks you actually executed with tools in THIS session. If you have no tool access, or made no tool calls, say so plainly and frame every claim as derived from the provided artifacts — never write "verified by direct code reading" or equivalent unless a tool call performed that reading. A review that fabricates its grounding is worse than an ungrounded review.

`code-read` or better requires a tool read or run in THIS session. Code excerpts quoted in the synthesis, without your own tool read, are `inferred`. For prompt/template rendering, configuration resolution, or dispatch selection findings, a Verifier refutation needs evidence from the actual render, resolve, or dispatch path. Without that evidence, mark the Verifier verdict `unresolved` and do not demote.

To overturn or downgrade a finding about prompt/template generation, configuration resolution, or dispatch selection, inspect the rendered or resolved result yourself, through an existing safe renderer/resolver with in-memory inputs and read-only paths, or through a capture from that same path, and cite what you saw under the verdict. This holds whether or not the synthesis says the finding came with a render: a synthesis can drop that provenance. Reading the source alone does not overturn such a finding. If you cannot inspect the result, say so, and Uphold the finding or flag it for human review; never Overturn or Downgrade it.

## Output Format

Structure your response with these sections:

### Upheld
Findings you examined and agree are legitimate issues at the stated severity.

### Downgraded
Findings where the severity is overstated. Explain the correct severity and why.

### Overturned
Findings you believe are NOT real issues. Provide strong evidence for each.

### New Concerns
Any issues the original reviewers missed entirely.

### Demoted to Questions
Findings with eligible Verifier refutations. Keep each question visible here, separate from findings the ordinary challenge overturns. Use the required `Demoted to question: <finding> — <premise> — <check>` form, with a stable finding key and the decisive check. Write `None.` when there are no eligible refutations.

### Verification
Required: one row per synthesis finding, in synthesis order. Identify each finding by its number or quoted title and location; do not use an ordinal alone for an unnumbered finding. Keep the premise and decisive check compact; quote the command/output or file:line in the check cell. Name the one final placement. If the synthesis has no findings, use exactly the single `None` row shown below. An omitted table is an incomplete challenge.

| Finding | Weakest premise | Decisive check | Proof level | Verdict | Final placement |
|---|---|---|---|---|---|
| None | — | — | — | — | — |

## Synthesis to Challenge

{{prior_findings}}
