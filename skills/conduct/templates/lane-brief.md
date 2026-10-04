# Lane `<lane id>`, quest <quest id>

**Read first, and follow:** `<lane contract path>`, the run's lane contract. Your report goes to `<report path>`.

**Worktree (work only here):** `<worktree path>`, branch `<branch name>`, based on `<base sha>`.

**Your work package is the spec:** `<wp spec path>`. Read it in full and build what its **Files**, behavior and **Verification** say, inside its **Boundary**. Commit title: its **Commit** line.

Never invoke `/conduct` from this lane: the conductor that dispatched you is already running.

## Runtime exercise

**The WP's runtime exercise:** <runtime exercise>

If the line above is empty, the WP named no runtime surface: name the surface yourself (CLI, service, UI, or `none: <why>`) and the check that exercises it, and say so in your report.

> **Runtime verification is part of done.** A change that alters runtime behavior is exercised at runtime before the PR boundary, and the report quotes the command and what was observed. A runtime check must be able to fail: say what it would have shown if the change were broken, or run it once against the pre-change tree — otherwise it is vacuous and is reported as such. Where the claim is visual, one screenshot per claim, of the critical state only; evidence is a few decisive pictures, never a gallery. Code-only verification of a runtime change is reported as **not exercised at runtime**, never as done.

Write the evidence under `## Runtime exercise` in your report: the command(s), what you observed (quoted), and what the same check showed or would show on the pre-change tree. The conductor reads only two lines of that section, each at the start of a line:

- `Verdict: exercised`, `Verdict: vacuous`, `Verdict: not exercised` or `Verdict: no runtime surface`: exactly one, verbatim.
- `Would have shown: <what the check prints or does when the change is broken, or the pre-change run's output>`: required with `Verdict: exercised`. A check you can't fill this line for is `Verdict: vacuous`.

## Standing clauses

`EARLY EXIT: if the brief assumed more work than the fix needs, make the small fix, stop, and say so — do not build the assumed scope around it. Your final message names the fix, its location, and the evidence that it is sufficient (the behavior it closes; what you checked that shows nothing else depends on it).`

`Do NOT open GitHub issues or PRs beyond the one asked for; anything you cannot do or think should follow goes in your final message.`

`Under ## Follow-ups, list the callers of any function you add a check to, and every construct in your files that intercepts another lane's or a prior WP's types (catch blocks, filters, handlers), with the base type grepped and the grep output quoted. "None" is an answer; silence is not.`

*Resident facts are asked for by name:* when the item depends on a fact that lives in the repo's CLAUDE.md or `.claude/rules/` (a CD trigger, a DB-name fallback, a mocked callee), the prompt names the fact and asks the lane to quote it before building on it. *Thresholds are measured at the midpoint:* an E-trigger that gates on a size or count ("if the diff exceeds N lines, stop and ask") says *when* to measure — before the first commit that could cross it — not only what.
