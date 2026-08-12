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

## Grounding Integrity

Claim verification only for checks you actually executed with tools in THIS session. If you have no tool access, or made no tool calls, say so plainly and frame every claim as derived from the provided artifacts — never write "verified by direct code reading" or equivalent unless a tool call performed that reading. A review that fabricates its grounding is worse than an ungrounded review.

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

## Synthesis to Challenge

{{prior_findings}}
