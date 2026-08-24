# Pattern: negative-control

**What:** An instrument — a test, guard, watcher, or checker — is trusted only after it has been observed **failing on a known-bad input**. An instrument that cannot run must exit distinctly as **"did not run"**, never as "pass". Until both hold, the instrument's green answer is unmeasured, not clean.

**When to use:** Every time an instrument is born or first trusted — a test harness in a PR, a pre-push hook, a mid-session watcher script, a checker over a corpus. The mid-session case is the hardest and the most common: an ad-hoc probe written to answer one question, trusted on its first answer, with no review boundary between its author and its verdict.

## The Class

The failure this pattern exists to stop: **an instrument reports success by being unable to report anything else.** Nothing errors. The instrument runs (or appears to), produces its pass-shaped output, and the defect it was built to catch sails through. It never exercised the real path at all.

Recurring shapes, each with a measured occurrence behind it:

| Shape | How it reads as "pass" |
|---|---|
| **Missing dependency** | A watcher armed with a tool that isn't installed reports "timed out" or "no output" — indistinguishable from "nothing happened" |
| **Unset configuration** | A harness runs with the critical variable unset and asserts the notifier was silent — which is also what total delivery failure looks like |
| **Compile-time degradation** | An assertion whose helper fails to load degrades to checking nothing, and validates every input |
| **Empty input** | A checker over zero items reports a clean corpus |
| **Self-reported capability** | Diagnosing a tool by asking it what it can do, instead of by calling it |
| **Control inside the old regime** | The known-bad input fails the same way under the behavior being *replaced*, so the control confirms the instrument runs — not that it can tell new from old |

Four auto-memory filings in three weeks did not lower the rate. Documentation is not the intervention; a required artifact at the moment of trust is.

## The Rule

Three clauses, all required:

1. **Bite before trust.** Before an instrument's first trusted answer, demonstrate it **failing on a known-bad input** — a deliberately broken fixture, a known-mangled real sample, a reverted fix. An instrument only ever observed passing has proven nothing about its ability to catch anything.
2. **"Did not run" is its own exit.** Missing dependency, unset config, failed compile, empty input — each must produce an outcome distinguishable from both pass and fail. A checker that finds nothing to check reports *that*, loudly, with its own exit code.
3. **The control must span the regime it claims to test.** Name the boundary the instrument is supposed to detect, then show the control crossing it. A known-bad input that the *previous* behavior handles identically — or that sits inside the window the new behavior replaces — passes without discriminating. Clause 1 proves the instrument can fail; this clause proves it can fail *at the thing that changed*.

## Calibration Recipe

For an instrument answering a live question (a watcher, a probe, a one-off checker):

1. **Known-negative first.** Feed it an input that must fail — a real mangled sample if one exists, a constructed one otherwise — and watch it fail. If the failure can't be produced, the instrument is not yet an instrument.
2. **Known-positive second.** Feed it an input that must pass, and watch it pass. Only after both may a live answer be trusted.
3. **Selftest fixtures for anything reused.** An instrument that will run more than once carries its calibration as fixtures it re-runs on start — a classifier that self-tests on N labeled samples before answering.
4. **Quarantine the instrument from the experiment.** An instrument that shares state with the thing it measures can leak into (or be corrupted by) the result. Probe for its own footprint: run it against a window where the answer is known to be "nothing".
5. **Revert, then verify the revert.** Calibrating breaks the tree on purpose. Restoring it is part of the calibration, not tidying afterwards — `git diff` before staging, and never `git add -A` a tree you or a delegated lens have deliberately broken. See *The Calibration's Own Hazard*.

For a shipped test suite, the same discipline is **red-first**: run the suite against the pre-fix control and record which cases fail. A regression test that passes before the fix is testing something other than the fix — and per clause 3, check that the case you ran red is one the pre-fix code handles *differently*, not merely one it also rejects.

## The Calibration's Own Hazard

The technique that calibrates a guard needs a guard of its own. **Calibrating edits the tree, and an un-reverted edit ships.**

Measured 2026-08-24 (burn-down run 15, obs#513, hotfixed as obs#515): an agentic review lens sabotaged a source file to verify a guard failed, and did not revert it. A `git add -A src/` on the amendment commit swept `// SABOTAGE: spread removed` into the PR, and it merged. The affected path then built its SDK options with no tool policy at all, so an interface meant to be read-only silently lost its restriction. The regression escaped **five** watcher positions: type-check, a 5,741-case suite, CI, and two independent review lenses that both returned merge-ready. Nothing asserted what that path sent, so nothing could see it. Grepping for calibration residue two stops later turned it up — luck, not process, which is why the response was a new gate rather than more care.

The disciplines, in cost order:

1. **Diff before staging.** Read what you are committing. `git add -A` over a deliberately broken tree is the entire mechanism.
2. **Use one greppable marker.** Every sabotage carries the same fixed token (`SABOTAGE`), so residue is findable by one search instead of by reading a diff.
3. **Let the repo enforce it.** A test that fails when the marker appears anywhere in the tree converts the discipline into a gate — the only one of the three that survives a tired session.

Corollary for delegated calibration: **a lens sharing a checkout with the work cannot be assumed to clean up after itself.** Isolate it, or treat the revert as the caller's job.

## Where This Binds

- **`burn-down` standing rule:** any queue item that ships a test, guard, watcher, or checker demonstrates the bite before the PR boundary, and the run-log row records how. The rule carries both calibration clauses too — diff before staging, and span the regime.
- **`verification-criteria`:** each V-block carries a **Negative control** field — the known-bad input and the observed failure.
- **`slim-review`:** an added test, guard, or checker that cannot fail on the defect it claims to catch is a reportable correctness defect.
- **Mid-session:** no structural gate exists — this file is the citable rule. The tell that you are in the class: your instrument's first answer is the answer you hoped for, and you have never seen it say anything else.

## Execution Feedback

**Run 15 (2026-08-24) — two amendments, both from failures measured *inside* a run that was already following this pattern.**

- *The non-discriminating control (→ rule clause 3).* Stop 4 shipped a per-subject alert-backoff ladder replacing a flat 30-minute cooldown. Its negative control passed calibration while being unable to discriminate: the test's window was 20 minutes, which sits **inside** the 30-minute cooldown being replaced, so old and new code produce the same result. Only widening the window to 11 hours made it bite. The control ran, it failed on the broken fixture, and it still measured nothing about the change — clause 1 was satisfied and the test was worthless.
- *The un-reverted calibration (→ The Calibration's Own Hazard).* Detailed above. The response was a repo-level gate rather than a resolution to be careful: an integrity test that fails when a `SABOTAGE` marker reaches the tree.

No watcher caught either one. The author found the first by widening a window on a hunch; the second turned up while grepping for something unrelated. That is the argument for making both clauses required rather than advisory — every position that would normally catch a defect had already passed.

---
*Source: run 14 item 1 (quest df9f1153), 2026-08-23 — a convergent recommendation reached independently by two analysis passes over the same corpus. Four prior auto-memory filings (2026-08-04 → 2026-08-23) plus four fresh occurrences in a single session established that per-occurrence documentation does not lower the rate.*
*Governed by: `test-first-spec` (testability IS specification — this pattern extends it to the instruments themselves)*
*See also: `verification-criteria` (the pipeline stage where the field lands), `post-build-verification` (the punch list this discipline precedes)*
