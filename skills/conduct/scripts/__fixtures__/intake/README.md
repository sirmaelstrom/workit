# Intake fixtures

Each `gh-*.json` file is `{ command, code, stdout, stderr }`: one real program run captured through `execute` (`scripts/lane.mjs`), the executor `conduct.mjs` uses. The tests hand these back from a fake executor, so no test needs the network.

Policy: quest and campaign UUIDs, campaign titles, timestamps and workspace-relative locators may appear here. Absolute paths, host names, LAN URLs and IPs may not; the `fixture paths` test greps for them.

## Captured from the real programs (2026-10-04)

- `gh-repo-view.json`: `gh repo view sirmaelstrom/workit --json nameWithOwner,defaultBranchRef` (success).
- `gh-repo-view-not-found.json`: `gh repo view sirmaelstrom/does-not-exist-xyz --json nameWithOwner` (exit 1, stderr kept).
- `gh-auth-status.json`: `gh auth status --hostname github.com` (success; gh masks the token itself).
- `gh-actions-workflows.json`: `gh api --paginate repos/sirmaelstrom/workit/actions/workflows --jq '.workflows[]'` (every page, one workflow per line: the CI workflow and Dependabot's dynamic one; 1 can gate a PR). Recaptured 2026-10-04T19:26:47Z when intake moved to the paginated command.
- `spine-author-result.json`: a real `spine_author` result (6 quests, 14 seams: 6 decomposition and 8 sequence), copied unchanged from the conductor's capture. Its keys (`rc1-wp-01` …) are the minting run's; the `mint from the workshop` test rewrites them in memory to the test run's `<slug>-<runId>-<wp id>` keys before mapping, and the file itself stays verbatim.
- `spine-quest.json`: a real `spine_quest` result, the anchor intake reads (its full uuid and `campaign.{slug,title}`). **Scrubbed at capture:** the resume note, the ref locators, the latest receipt's text and the place path are neutral synthetic text. The tests run with slug `fixture-run` and run id `abcd1234`.

## Derived (hand-edited from a captured file; not program output)

- `gh-actions-workflows-zero.json`: `gh-actions-workflows.json` with no workflow lines (a repo with no CI).
- `gh-actions-workflows-dependabot-only.json`: `gh-actions-workflows.json` with only the Dependabot dynamic workflow line (a repo with no workflow that can gate a PR).
