# Pattern: blind-second-read

**What:** A consequential plan gets a second model's read **before** that model sees the first plan. The second model gets the problem, the constraints and the evidence, writes its own opening, and only then are the two reconciled. A second model handed a finished plan to review takes on that plan's framing: it critiques the options the plan chose to list and rarely asks whether the problem was framed right.

**When to use:** Any plan whose wrong framing would cost more than one extra model turn. That covers a deep spec, a plan with a one-way door, a burn-down queue that lanes will run unattended or that spans several sittings, and a plan a successor session will execute without its author. Whether a plan counts is a judgment call. Make it, and write one line in the plan saying which way you called it and why. Routine plans, such as a single quest's build steps or a lite spec with only two-way doors, skip it.

**What it replaces, and what it does not:** It replaces review-of-plan as the second-planner step, where a second model reads the finished plan and comments on it. It does not replace a council review of the finished artifact (the spec's Phase 8 or a PR review). That review checks whether the plan can be executed. It does not check how the problem was framed.

## The procedure

1. **Assemble the inputs without the plan.** Include the problem statement, the constraints (the operator's own words where they exist, plus any binding rulings) and the evidence (files read, measurements, quest notes, prior decisions). Leave out the draft plan, its decision list, and any sentence that names a preferred option. If the inputs were written after the plan, reread them for leaked conclusions before sending.
2. **Pick a second model from another vendor family.** A plan Claude drafted goes to GPT-6 Astra at high through `codex exec` (see `codex-delegate`, which carves this out of its "planning is conductor-only" row). A plan a Codex model drafted goes to a Claude seat. Run one turn on identical inputs, with no access to the first plan's file. Say in the prompt that the turn is read-only: `--sandbox read-only` is broken on Windows, so the prompt carries the limit.
3. **Ask for an opening, not a review.** Ask for its framing of the problem, the plan or decision set it would choose, what it would measure first, and what would change its mind. Cap the return length the way any delegated handback is capped.
4. **Save the opening verbatim** next to the plan as `blind-read-<model>-<YYYY-MM-DD>.md`. The header lists the model, the effort and the input list. Append the wrapper prompt so a reader can confirm the plan was not in it.
5. **Reconcile in a table** with the columns *point · first plan · blind read · ruling · why*. The disagreements are what you are paying for. Settle each one with evidence or a measurement, or carry it to the operator as a lettered question. Do not settle it by deferring to whichever model wrote more.
6. **Record whether the read changed anything.** End the table with one line: `Changed: yes (D3, D5)` or `Changed: no`. That line is what the falsifier below counts.

## Evidence and falsifier

The procedure was illustrated once and has not been measured. On 2026-09-29 two blind openings on the model-routing discussion, one from Fable and one from GPT-6 Astra on the same inputs, each rejected the research pass's proposed trust line on its own. One instance does not show that the procedure beats review-of-plan.

**Falsifier:** three consecutive consequential plans where the blind read records `Changed: no` and catches nothing that a review-of-plan pass on the same plan also caught. If that happens, demote this pattern to optional and say so here.

## Execution Feedback

*(Append results here: plan, date, `Changed:` line, and whether review-of-plan would have caught it)*

---
*Source: model-routing decision record 2026-09-29, decision D6 ("Independent planning is blind-first"), quest 5e0da84b.*
*Used by: `spec` (Stage 2), `burn-down` (queue composition), `session-chain` (rotation briefs that carry a plan). Carve-out: `codex-delegate` (Route by Phase).*
