# Seam fixtures

Inputs for `conduct.seam.test.mjs`. The `fixture paths` test greps every file here for the private-path shapes (orchestrator Must 8). Every uuid, PR number, sha and dollar figure in these files is made up; none comes from a real run.

Program output the seam tests hand back from their fake executor is either captured below or imported from `__fixtures__/land/` (check-runs, commit statuses, required checks, review threads) and `__fixtures__/build/` (lane reports, the lane-contract template) by path, not copied.

## Captured, scrubbed at capture

- `escape-reader.json`: `{ command, code, stdout, stderr }` for the real `scripts/escape-reader.mjs --repo example/scratch --since 2026-10-04`, run in-process through its `runEscapeReader` export with the `gh pr list` call injected: an authored list of three PRs on the synthetic repo `example/scratch` (two `Escape:` lines, one saw and one missed). The program and its output shape are real; the PR data is not, so nothing reached GitHub.

## Authored (not program output)

- `workshop/work-packages/`: a three-WP deep workshop (`_orchestrator.md` plus `wp-01-core.md`, `wp-02-left.md`, `wp-03-right.md`): WP-01 in wave 1, WP-02 and WP-03 in wave 2 with disjoint Files, tier T1, a `**Runtime exercise:**` and a `**Commit:**` line each. Placeholder prose. The tests copy it into the run's workshop as the scripted `/spec` output.
- `repo/`: the target repo's files the run reads: `.workit/conduct.json` (a release recipe shaped like workit's, and a `laneSuite`), and the two bump files `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (version `0.1.0`).
- `installed-plugins-before.json`, `installed-plugins-after.json`: two `installed_plugins.json` snapshots for the self-hosted handover, shaped like the real file (`version: 2`, `plugins.<key>` an array of `{ scope, installPath, version, … }`). `<plugins>` is replaced by the test's temp directory; "after" adds a newer user-scope install.
- `report-no-runtime.md`: a built lane report with no `## Runtime exercise` section (`{pr}` and `{head}` are filled by the test).
