# Build fixtures

Inputs for `lib/phases/build.test.mjs`. The `fixture paths` test greps every file here for the private-path shapes (orchestrator Must 8). Program output the build tests hand back (lane check, check-runs, commit statuses, required checks, review threads, `claude -p`) is imported from `__fixtures__/lanes/` and `__fixtures__/land/`, not copied.

## Copied

- `lane-contract.template.md`: `git show 0026be4:reference/templates/lane-contract.template.md`, unchanged. The lane-contract test reads this copy, never the working tree's template, so a later template edit cannot change it (D17).
- `spine-receipt-result.json`: the goal-conductor run's `run/fixtures/spine-receipt-result.json`, verbatim: a real `spine_receipt` success result (receipt 9722037a, top-level `id` the receipt's uuid string). The `receipt` step's recorded result.

## Authored (not program output)

- `report-built.md`, `report-refuted.md`, `report-needs-conductor.md` (asks `(a)`/`(b)`), `report-no-verdict.md` (a `## Runtime exercise` with no `Verdict:` line): lane reports. `{pr}` and `{head}` are filled by the test with the PR number and head sha.
- `report-amendment.md`: a built report with an `## Amendment 1` table of three rows (fixed, refuted, judgment); the comment ids are the first comments of `__fixtures__/land/review-threads-145.json`'s threads.
- `report-council-amendment.md`: the same with council ids `C1-1`, `C1-2`.
- `report-guard.md`: an `## Amendment 1` table with a `conductor` row (slim-review's test-weakening guard).
- `conduct.json`: a target repo's `.workit/conduct.json` with `contractPaths` and `laneSuite`.
