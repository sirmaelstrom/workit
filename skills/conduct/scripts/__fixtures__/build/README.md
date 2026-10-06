# Build fixtures

Inputs for `lib/phases/build.test.mjs`. The `fixture paths` test greps every file here for the private-path shapes (orchestrator Must 8). Program output the build tests hand back (lane check, check-runs, commit statuses, required checks, review threads, `claude -p`) is imported from `__fixtures__/lanes/` and `__fixtures__/land/`, not copied.

## Copied

- `lane-contract.template.md`: `git show 0026be4:reference/templates/lane-contract.template.md`, unchanged. The lane-contract test reads this copy, never the working tree's template, so a later template edit cannot change it (D17).

## Synthetic

- `spine-receipt-result.json`: **synthetic, contract-valid** data shaped after a real `spine_receipt` success result (the same keys and types; the top-level `id` is the receipt's uuid string). The uuids, prose and locator are made up; no money, hosts or paths. The tests set its `questId` and `outcome` to what each `receipt` action asked for, since the build checks the acknowledgement against the request.

## Authored (not program output)

- `report-built.md`, `report-refuted.md`, `report-needs-conductor.md` (asks `(a)`/`(b)`), `report-no-verdict.md` (a `## Runtime exercise` with no `Verdict:` line): lane reports. `{pr}` and `{head}` are filled by the test with the PR number and head sha.
- `report-built-asks.md`: a built report whose `## Needs conductor` carries one ask, its question labeled `(a)` like its first option (the shape a live lane wrote).
- `report-built-two-asks.md`: two labeled questions, each with options `(a)`/`(b)` of the same text.
- `report-built-asks-timeout.md`, `report-built-asks-new-question.md`: one question each, with the same option text and different questions.
- `report-amendment.md`: a built report with an `## Amendment 1` table of three rows (fixed, refuted, judgment); the comment ids are the first comments of `__fixtures__/land/review-threads-145.json`'s threads.
- `report-council-amendment.md`: the same with council ids `C1-1`, `C1-2`.
- `report-guard.md`: an `## Amendment 1` table with a `conductor` row (slim-review's test-weakening guard).
- `report-council-guard.md`: a council table (`C1-1`, `C1-2`) whose second row is a `conductor` row.
- `report-duplicate-ids.md`: a table naming `123`/`#123` and `C1-3`/`c1-3` twice each (the same ids after normalization).
- `conduct.json`: a target repo's `.workit/conduct.json` with `contractPaths` and `laneSuite`.
