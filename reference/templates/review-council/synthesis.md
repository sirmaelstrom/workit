# {{workshop_title}} — Review Synthesis (Round {{round}})

## Instructions
You have review outputs from multiple independent models. Your job is to consolidate them:

1. **Consensus Issues** — All models flagged. High confidence these are real. Fix before proceeding.
2. **Majority Issues** — 2+ models flagged. Likely real. Investigate.
3. **Split Opinions** — Models disagreed. These surface design tradeoffs. Human decides.
4. **Unique Findings** — Only 1 model caught. Could be noise or a genuine blind spot.
5. **Limits** — What the reviews say they did not establish ("unverified", "not tested", "does not prove"). Give each an ID (`L1: does not establish …`) and name the models that stated it. Keep a limit even when you drop the finding it qualified.

For each finding, note which models flagged it and their severity ratings.

End with: overall severity assessment, recommended action (proceed / amend / rework), and a prioritized amendment list.

## Output contract (parsed downstream — follow exactly)

Structure the synthesis under these five markdown headings, each on its own line, verbatim:

```
## Consensus Issues
## Majority Issues
## Split Opinions
## Unique Findings
## Limits
```

The escalation detector parses the Consensus and Majority headings to decide whether an adversarial overturn must be surfaced to a human. Do not fold the band name into a bold list item instead of a heading; keep counts and qualifiers ("all 3 models", "4/4") in the section body, not appended to the heading line. Write `None.` under any heading with nothing in it.

## Review Outputs

{{prior_findings}}
