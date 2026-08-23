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

Four auto-memory filings in three weeks did not lower the rate. Documentation is not the intervention; a required artifact at the moment of trust is.

## The Rule

Two clauses, both required:

1. **Bite before trust.** Before an instrument's first trusted answer, demonstrate it **failing on a known-bad input** — a deliberately broken fixture, a known-mangled real sample, a reverted fix. An instrument only ever observed passing has proven nothing about its ability to catch anything.
2. **"Did not run" is its own exit.** Missing dependency, unset config, failed compile, empty input — each must produce an outcome distinguishable from both pass and fail. A checker that finds nothing to check reports *that*, loudly, with its own exit code.

## Calibration Recipe

For an instrument answering a live question (a watcher, a probe, a one-off checker):

1. **Known-negative first.** Feed it an input that must fail — a real mangled sample if one exists, a constructed one otherwise — and watch it fail. If the failure can't be produced, the instrument is not yet an instrument.
2. **Known-positive second.** Feed it an input that must pass, and watch it pass. Only after both may a live answer be trusted.
3. **Selftest fixtures for anything reused.** An instrument that will run more than once carries its calibration as fixtures it re-runs on start — a classifier that self-tests on N labeled samples before answering.
4. **Quarantine the instrument from the experiment.** An instrument that shares state with the thing it measures can leak into (or be corrupted by) the result. Probe for its own footprint: run it against a window where the answer is known to be "nothing".

For a shipped test suite, the same discipline is **red-first**: run the suite against the pre-fix control and record which cases fail. A regression test that passes before the fix is testing something other than the fix.

## Where This Binds

- **`burn-down` standing rule:** any queue item that ships a test, guard, watcher, or checker demonstrates the bite before the PR boundary, and the run-log row records how.
- **`verification-criteria`:** each V-block carries a **Negative control** field — the known-bad input and the observed failure.
- **`slim-review`:** an added test, guard, or checker that cannot fail on the defect it claims to catch is a reportable correctness defect.
- **Mid-session:** no structural gate exists — this file is the citable rule. The tell that you are in the class: your instrument's first answer is the answer you hoped for, and you have never seen it say anything else.

## Execution Feedback

*(Append results here)*

---
*Source: run 14 item 1 (quest df9f1153), 2026-08-23 — a convergent recommendation reached independently by two analysis passes over the same corpus. Four prior auto-memory filings (2026-08-04 → 2026-08-23) plus four fresh occurrences in a single session established that per-occurrence documentation does not lower the rate.*
*Governed by: `test-first-spec` (testability IS specification — this pattern extends it to the instruments themselves)*
*See also: `verification-criteria` (the pipeline stage where the field lands), `post-build-verification` (the punch list this discipline precedes)*
