# Land fixtures

Program output the landing tests hand back from a fake executor, so no test needs the network. The `fixture paths` test in `lib/land.test.mjs` greps every file here for the private-path shapes (orchestrator Must 8) and the `managed-*.json` files for `://127.` and `localhost:`.

## Captured from the real programs (2026-10-04)

- `check-runs-green.json`: `gh api repos/sirmaelstrom/workit/commits/934d875245857abab756e67df80cd1f568ed4f8d/check-runs?per_page=100 --paginate` (the merge commit of workit#152; 3 runs, all `success`).
- `check-runs-zero.json`: the same for `e55ab6e40c00d655857ea230b4c468f298040a93`, a non-head commit inside the squash-merged workit#152 (no runs were ever created for it).
- `check-runs-paged.json`: the green commit's read with `per_page=1 --paginate`: three page objects printed back to back with nothing between them (`}{"total_count"`), the shape `gateCheck` unions across.
- `unknown-sha.json`: `{ command, code, stdout, stderr }` for a sha GitHub does not have (exit 1, `HTTP 422` on stderr).
- `pr-view-150-merge-commit.json`: `gh pr view 150 --repo sirmaelstrom/workit --json mergeCommit`.
- `managed-workit.json`, `managed-observatory.json`: `node skills/slim-review/scripts/pr-review.mjs managed --repo sirmaelstrom/workit` and `--repo heathdev-me/observatory`. **Scrubbed at capture:** `coordinator` is `<coordinator-url>` and `directory` is `<home>/.workit/pr-review`; the GitHub `owner/name` values are kept.
- `required-checks.json`: `gh api repos/sirmaelstrom/workit/branches/main/protection/required_status_checks` (`contexts`: `Tests (node --test)`, `Secret scan (gitleaks)`).
- `required-checks-unprotected.json`: `{ command, code, stdout, stderr }` for the same read on an unprotected branch (exit 1, `Branch not protected (HTTP 404)`).
- `commit-status-green.json`: `gh api repos/sirmaelstrom/workit/commits/934d875…/status` (legacy commit statuses: none, `total_count` 0; the combined `state` reads `pending` with no statuses, which is why the gate reads `statuses[]`, never `state`).
- `review-threads-145.json`: `gh api graphql` with `land.mjs`'s `THREADS_QUERY` for workit#145 (4 threads, each with its node `id` and first comment `databaseId`).

## Captured, projected (2026-10-22)

Read from the real API, then projected with `--jq` to the fields the gate reads (the raw objects also carry repository, owner and URL blocks):

- `check-runs-observatory-base.json`: `gh api repos/heathdev-me/observatory/commits/45c42f0a8e6df732cc97cafdef41141ff66c6936/check-runs?per_page=100 --paginate --jq '{total_count, check_runs: [.check_runs[] | {id, name, head_sha, status, conclusion, check_suite: {id: .check_suite.id}, app: {slug: .app.slug}}]}'`. A main commit that a scheduled `db-tests` run and a pushed `CI` run (`verify`, `audit`) both checked.
- `workflow-runs-observatory-base.json`: `gh api "repos/heathdev-me/observatory/actions/runs?head_sha=45c42f0a…&per_page=100" --paginate --jq '{total_count, workflow_runs: [.workflow_runs[] | {id, name, path, event, head_sha, check_suite_id, status, conclusion}]}'`: the same commit's workflow runs, `schedule` and `push`, joined to the check-runs by `check_suite_id`.
- `check-runs-observatory-head.json`: the same check-runs read for `f5d5a7f16e74cebaab76a80f8d893e3fb7a43d43`, a PR head: `verify`, `audit` and a skipped `auto-merge`, all from `pull_request` runs, and no `db-tests`.

## Derived or authored (not program output)

- The failed-run, pending (`in_progress`), incomplete (`total_count` raised, duplicate id, a page without `check_runs`, trailing text) and missing-expected-check cases are derived in the tests from `check-runs-green.json` by editing it; the legacy-status cases from `commit-status-green.json` by adding one status.
- `installed-plugins-before.json`, `installed-plugins-after.json`: **synthesized** from the real `installed_plugins.json` `workit@workit` entry shape (`version: 2`, `plugins.<key>` an array of `{ scope, installPath, version, installedAt, lastUpdated, gitCommitSha }`), with placeholder paths. "after" holds an older and a newer entry, older first.
- `lane-report-amendment.md`: an authored lane report with two `## Amendment N` tables; the comment ids are the first comments of `review-threads-145.json`'s threads.
