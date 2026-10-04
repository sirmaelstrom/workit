# Intake fixtures

Each `gh-*.json` file is `{ command, code, stdout, stderr }`: one real program run captured through `execute` (`scripts/lane.mjs`), the executor `conduct.mjs` uses. The tests hand these back from a fake executor, so no test needs the network.

## Captured from the real programs (2026-10-04)

- `gh-repo-view.json`: `gh repo view sirmaelstrom/workit --json nameWithOwner,defaultBranchRef` (success).
- `gh-repo-view-not-found.json`: `gh repo view sirmaelstrom/does-not-exist-xyz --json nameWithOwner` (exit 1, stderr kept).
- `gh-auth-status.json`: `gh auth status` (success; gh masks the token itself).
- `gh-actions-workflows.json`: `gh api repos/sirmaelstrom/workit/actions/workflows` (`total_count` 2).
- `spine-author-result.json`: a real `spine_author` result (6 quests, 14 seams: 6 decomposition and 8 sequence), copied unchanged.
- `spine-quest-answered.json`: a real `spine_quest` result whose latest receipt is `answered`. **Scrubbed at capture:** the resume note, the ref locators, the receipt question, the option consequences and the place path are neutral synthetic text. The question is `[conduct fixture-run touch 1] <synthetic text>`, so the tests run with slug `fixture-run`. The shape is kept: `latestReceipt.outcome`, `.question`, `.answer.{by,key,text,answeredAt}`, `.ask.options`, `campaign.{slug,title}`.

## Derived (hand-edited from a captured file; not program output)

- `gh-actions-workflows-zero.json`: `gh-actions-workflows.json` with `total_count: 0` and `workflows: []` (a repo with no CI).
- `spine-quest-answered-with-id.json`: `spine-quest-answered.json` plus a synthetic `latestReceipt.id`. Today's `spine_quest` carries no receipt id; this variant tests the path that stores one.
- `spine-quest-answered-touch-2.json`: `spine-quest-answered.json` with the question tag reading `touch 2` (an answer to a different question).
