# Lane fixtures

Policy: session and thread ids, pane ids and costs may appear here. Absolute paths under a user's home or a workspace may not; the `fixture paths` test in `lib/lanes.test.mjs` greps for them.

## Captured from the real programs (2026-10-04)

- `claude-p-ok.json`: stdout of `claude -p --output-format json "reply with the word ok"` (claude 2.1.289), verbatim. One JSON object; the exec backend reads `session_id` and `total_cost_usd` from it.
- `codex-exec-ok.jsonl`: stdout of `codex exec --sandbox danger-full-access --json "reply with the word ok"` (codex-cli 0.159.3, stdin from the null device). **Scrubbed at capture:** the two config-warning lines named the user's home directory; it reads `<home>` instead. The exec backend reads `thread_id` from the `thread.started` line.
- `herdr-agent-list.json`: stdout of `herdr agent list` (herdr 0.9.2-preview). **Scrubbed at capture:** kept the first two agents; their `cwd`, `name` and terminal titles are neutral synthetic text. The shape is kept.

## Copied

- `workshop/work-packages/`: the goal-conductor run's `_orchestrator.md` and its six `wp-*.md`, copied unchanged. `parseWorkPackages` is tested against them; if a copy's Files field drifts from the test's arrays, re-copy it.
