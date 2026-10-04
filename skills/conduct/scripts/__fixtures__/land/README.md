# Land fixtures

Program output the landing tests hand back from a fake executor, so no test needs the network. The `fixture paths` test in `lib/land.test.mjs` greps every file here for the private-path shapes (orchestrator Must 8) and the `managed-*.json` files for `://127.` and `localhost:`.

## Captured from the real programs (2026-10-04)

- `check-runs-green.json`: `gh api repos/sirmaelstrom/workit/commits/934d875245857abab756e67df80cd1f568ed4f8d/check-runs?per_page=100 --paginate` (the merge commit of workit#152; 3 runs, all `success`).
- `check-runs-zero.json`: the same for `e55ab6e40c00d655857ea230b4c468f298040a93`, a non-head commit inside the squash-merged workit#152 (no runs were ever created for it).
- `check-runs-paged.json`: the green commit's read with `per_page=1 --paginate`: three page objects printed back to back with nothing between them (`}{"total_count"`), the shape `gateCheck` unions across.
- `unknown-sha.json`: `{ command, code, stdout, stderr }` for a sha GitHub does not have (exit 1, `HTTP 422` on stderr).
- `pr-view-150-merge-commit.json`: `gh pr view 150 --repo sirmaelstrom/workit --json mergeCommit`.
- `managed-workit.json`, `managed-observatory.json`: `node skills/slim-review/scripts/pr-review.mjs managed --repo sirmaelstrom/workit` and `--repo heathdev-me/observatory`. **Scrubbed at capture:** `coordinator` is `<coordinator-url>` and `directory` is `<home>/.workit/pr-review`; the GitHub `owner/name` values are kept.
- `review-threads-145.json`: `gh api graphql` with `land.mjs`'s `THREADS_QUERY` for workit#145 (4 threads, each with its node `id` and first comment `databaseId`).

## Derived or authored (not program output)

- The failed-run and pending (`in_progress`) check-runs cases are derived in the tests from `check-runs-green.json` by editing one run's `conclusion` or `status`.
- `installed-plugins-before.json`, `installed-plugins-after.json`: **synthesized** from the real `installed_plugins.json` `workit@workit` entry shape (`version: 2`, `plugins.<key>` an array of `{ scope, installPath, version, installedAt, lastUpdated, gitCommitSha }`), with placeholder paths. "after" holds an older and a newer entry, older first.
- `lane-report-amendment.md`: an authored lane report with two `## Amendment N` tables; the comment ids are the first comments of `review-threads-145.json`'s threads.
