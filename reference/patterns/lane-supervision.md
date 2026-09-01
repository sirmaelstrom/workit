# Pattern: lane-supervision

*This is the binding spec for `scripts/lane.mjs` — the lane supervision helper. It is reproduced from the `herdr-lane-gating` workshop spec-lite so the pointer in `skills/burn-down` and `skills/codex-delegate` resolves inside this repo. Every constraint below is measured; do not re-derive them.*

*One deliberate departure from the source: machine-specific paths are written as placeholders — `%USERPROFILE%` for the profile directory and `<workspace>` for the workspace root (the directory holding `projects/` and `data/`). This repo is public; the measured rulings are what matter, not one operator's drive letters.*

---

# Spec-lite — the lane supervision rung: `herdr agent wait` in the lane runner

**Quest:** Spec: wire `herdr agent wait --until blocked` into the parallel-PR / codex-delegate gating path (884e2f9c) · **Campaign:** Async Agentic Operations · **Written:** 2026-09-01 (Burn-down Session D, Fable conductor) · **Depth:** spec-lite (intent + constraints + success criteria + work packages). Every ruling below is measured in the quest note or run-4 rulings 1, 5, 6; none is re-derived here.

## Intent

A conductor launches worktree lanes (claude or codex) and today cannot see a lane that has stalled on an approval dialog. The standing workaround forces lanes to gate in the foreground, which forfeits backgrounding and caps the fleet at two supervised lanes. `herdr agent wait --until blocked` detects the stall without foreground gating (proved behaviourally 2026-08-08). This spec turns the measured launch-and-wait choreography into one helper that burn-down and codex-delegate call, so a lane's lifecycle is observed by the tool, and its completion is judged by an artifact, never by a status.

## Scope ruling (the boundary the quest note left open)

**A shared helper, not a skill-local rung.** `projects/workit/scripts/lane.mjs` (Node, zero dependencies, same posture as `skills/slim-review/scripts/pr-review.mjs`), called by `skills/burn-down` (the multi-item runner) and `skills/codex-delegate` (leaf delegation when the leaf mutates and needs a worktree). `skills/slim-review` stays out: it has no lane. Prior art for the shape: slim-review's home was a skill, not a council profile (quest 741a1ff7). The helper is CLI-first (one verb per invocation, JSON out) so a codex lane can be supervised by a claude conductor and vice versa.

## Verbs

| Verb | Does | Returns |
|---|---|---|
| `lane create --repo <abs> --branch <b> --base <ref> --label <text>` | `herdr worktree create --cwd <repo> --branch <b> --base <ref> --no-focus --label <text>`; refuses if the branch exists | `{workspaceId, paneId, path, branch}` |
| `lane start <name> --pane <id> --kind claude\|codex --model <slug> [--reasoning <lvl>] [--sandbox <mode>]` | `herdr agent start <name> --kind <kind> --pane <id> -- <args>`; mandatory mode flags per kind (below); re-focuses the conductor pane afterwards (agent start has no `--no-focus`) | `{agent, kind, model, startedAt}` |
| `lane prompt <name> --file <path>` | The prompt is a FILE; the wire text is only "Read <path> and execute it exactly." (no prompt content passes through a shell); `herdr agent prompt --wait --until working` | `{accepted, stateAfter}` |
| `lane wait <name> [--until blocked\|idle\|done] --timeout <ms>` | `herdr agent wait`; on `blocked` also runs `herdr agent read --lines 40` and prints the dialog text | exit 0 idle/done · exit 3 blocked (+ dialog) · exit 4 timeout |
| `lane check <name> --expect-commit\|--expect-file <path>[:needle]\|--expect-pr <n>` | THE completion verdict: branch ahead of base by ≥1 commit / file exists and contains needle / PR exists with head = branch | exit 0 / exit 5 with the failed expectation named |
| `lane resume <name>` | after the operator approves a blocked dialog: `agent wait --until idle` (bare wait returns instantly on the stale `blocked`) | as wait |
| `lane fallback <name> --to claude --model opus` | for a codex lane that hit the plan limit: `agent start` a claude agent in the SAME pane/worktree, re-send the SAME prompt file; records the channel switch | as start |
| `lane sweep` | delegates to `infrastructure/herdr-lanes.ps1` (workspace close FIRST, then delete, then `git worktree prune`) | its output |

Every verb appends one JSONL row to `data/outputs/projects/agentic-practice-transfer/lanes/<run-anchor>.jsonl`: `{ts, lane, verb, kind, model, reasoning, state, waitMs, exit}`. This is the run's "lanes concurrently live" instrument (Session D delta 1).

## Constraints (binding; each measured)

1. **Mode is set at launch, per kind.** claude → `--permission-mode bypassPermissions`; the helper REFUSES `dontAsk` (auto-denies every tool and still settles to `done`) and warns on `acceptEdits` (stalls on every Bash outside the allowlist). codex → `--ask-for-approval never` plus an explicit `--sandbox`; on this Windows box `read-only` is broken (ungrounded answers, no error), so the helper refuses it.
2. **Status is never evidence.** `done` is reachable with zero work. Only `lane check` returns a completion verdict; `lane wait` exits 0 on done/idle but prints "status is not evidence — run lane check".
3. **Allow-rules cannot substitute for the mode.** Agents emit `git -C "<abs>" add … && …`; prefix matching fails. The helper does not try to generate allow-rules.
4. **Focus is restored.** After `lane start`, `herdr agent list` must show the conductor pane `focused: true`.
5. **Stale `blocked` after approval.** `lane resume` always waits `--until idle`.
6. **Removal leaks the directory while a shell holds cwd.** `lane sweep` closes the workspace first; it never calls `worktree remove --force` directly.
7. **Worktrees live on `%USERPROFILE%\.herdr\worktrees\<repo>\<slug>`, repos under `<workspace>/projects/` — often on a different volume.** No verb assumes the worktree is under the repo; every path is absolute and comes from `lane create`'s JSON.
8. **Model AND reasoning effort are launch flags, never inherited.** `--model` is mandatory on `lane start` (4 lanes inheriting opus once burned a 5-hour cap in ~25 min). Measured 2026-09-01: a claude fallback lane started with `--model opus` and no `--effort` ran at **xhigh** ("thinking with xhigh effort", $5.24 in 9 minutes on a finish-and-commit task). `lane start --kind claude` therefore requires `--reasoning` and passes it as `--effort <lvl>`; codex lanes pass `-c model_reasoning_effort=<lvl>`. The JSONL row records both.
9. **Lane kinds are claude|codex only.** Other herdr kinds have no state hook; `agent wait` would read `unknown`.
10. **Reviewer ≠ author model (Session D ruling).** The JSONL row records the lane's model so the PR-boundary review can pick a different one.
13. **Worktrees must live under the projects tree for T2 (measured 2026-09-01, Session D).** The review-council's `code_root` confinement refuses any path outside `<workspace>/projects/` — a herdr default worktree under `%USERPROFILE%\.herdr\worktrees\` was refused with "isolation not attempted", and the agentic seats grounded against the canonical checkout instead (phantom "does not exist" findings become possible on branch-only code). `lane create` therefore passes herdr's `--path` flag explicitly: `<workspace>/projects/<repo>-wt-<slug>` — the worktree-rooting pattern's own recipe. Constraint 7 still holds: no verb may assume the worktree sits under the repo; the location is whatever `lane create` returned. `lane sweep` must handle both locations (legacy `.herdr` lanes and projects-tree lanes).
12. **A codex lane needs the real `codex.exe` first on the PANE's PATH (measured 2026-09-01, Session D lane O).** `herdr agent start --kind codex` runs `Start-Process -FilePath codex` inside the pane's pwsh; on this box `codex` on PATH is the npm shim (`codex` / `codex.cmd` / `codex.ps1`) and Start-Process fails with "%1 is not a valid Win32 application", then `agent start` times out with no agent. The real binary is `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`. `lane start --kind codex` must first `herdr pane run <pane> '$env:PATH = "<vendor bin>;" + $env:PATH'` (locate the vendor bin from `npm root -g` at run time; never hardcode the version path) and verify `(Get-Command codex).Source` ends in `.exe` before invoking `agent start`. Same class as auto-memory `execfilesync-cannot-launch-windows-shims`. Also: codex has no `bypassPermissions`; the analog is `--ask-for-approval never` plus an explicit `--sandbox`.
11. **Plan-limit fallback (Session D ruling; detection measured 2026-09-01).** The codex TUI footer reports the plan meter live — observed via `herdr agent read`: `gpt-5.6-terra high · Context 62% left · 5h 79% left · weekly 91% left`. The helper's `lane wait` scrapes `5h (\d+)% left` and `weekly (\d+)% left` from the last footer line on every poll and writes them to the JSONL row; when the 5h figure drops below a threshold (default 10%), `lane wait` exits 6 (`plan-low`) so the conductor can call `lane fallback` BEFORE a refusal. The refusal pattern is now CAPTURED (2026-09-01 22:12Z, lane O): the pane shows `■ You've hit your usage limit. … try again at <time>.` followed by a modal `Approaching rate limits — Switch to gpt-5.6-luna for lower credit usage? › 1. Switch … 2. Keep current model 3. Keep current model (never show again)`. Two facts bind the helper: (a) herdr reports the agent as `idle`, not `blocked`, while that modal is up — `lane wait` must grep the pane for `hit your usage limit` on every poll and treat it as exit 6 regardless of lifecycle state; (b) the modal must be dismissed (`Escape`) and codex quit (`/quit` + Enter) before a claude agent can be started in the same pane. Measured drain: 79% → 0% of the 5h window in ~36 min with 3–4 codex lanes + council codex lenses + 2 probes; the "<10% left" footer warning arrived ~7 min before the refusal, so a 10% floor gives roughly one poll interval of warning at that concurrency — set the default floor to 20%. The review-council's codex seat and its codex synthesizer share the pool: when the floor trips, T2 rounds switch to the `anthropic` profile for the rest of the window. `lane fallback` re-launches the same worktree + prompt file on claude opus and records the switch. Measured cost datum: two codex lanes plus two read-only probes consumed ~4% of the 5h window in the first ~10 minutes.

## Success criteria, each with its falsifier

| # | Claim | How it is shown true | What would refute it |
|---|---|---|---|
| S1 | A stalled lane is detected without foreground gating | Live smoke: launch a claude lane in `acceptEdits` with a prompt whose first step is a Bash outside the allowlist; `lane wait --until blocked --timeout 120000` exits 3 and prints the approval dialog | It times out, or exits 3 on a lane that is not actually blocked (verify by `agent read`) |
| S2 | The same prompt under `bypassPermissions` never reports blocked (negative control for S1) | Same smoke, mode swapped; `lane wait` exits 0 | Exits 3 |
| S3 | Status is never evidence | Unit: a fake herdr that reports `done` for a lane with no commits → `lane check --expect-commit` exits 5 | Exits 0 |
| S4 | `dontAsk` is refused | Unit: `lane start --kind claude -- --permission-mode dontAsk` exits nonzero before invoking herdr | herdr is invoked |
| S5 | Focus restored | Live smoke: after `lane start`, `herdr agent list` shows the conductor pane focused | Conductor pane not focused |
| S6 | `lane resume` survives the stale-blocked trap | Unit: fake herdr returns `blocked` immediately on a bare wait and `idle` on `--until idle`; `lane resume` returns idle | Returns blocked |
| S7 | Fallback re-uses the worktree and prompt | Unit: fake pane text with the plan-limit pattern → `lane fallback` invokes `agent start --kind claude … --model opus` in the same pane and re-sends the same `--file`; JSONL has both rows | A new worktree or a different prompt path appears |
| S8 | Sweep leaves no directory | Live smoke on a throwaway lane: after `lane sweep`, the lane dir is gone and `git worktree list` no longer lists it | Directory remains |

Unit tests run under `node --test` with herdr injected as a fake executor (the same injection seam pr-review.mjs uses for `gh`). S1, S2, S5, S8 are LIVE smokes the conductor runs by hand and records in the run log; herdr is not on CI.

## Work packages (build lane: codex `gpt-5.6-sol` @medium, workit worktree; T2 on WP-2 because it adds a guard that claims to detect stalls)

- **WP-1** `lane.mjs` skeleton: arg parsing, executor injection, JSONL writer, `create` / `start` (with mode enforcement, S4) / `prompt`. T1.
- **WP-2** `wait` / `check` / `resume` with S3, S6 units; live S1/S2 smoke script `scripts/lane-smoke.mjs` that the conductor runs. **T2.**
- **WP-3** `fallback` (S7) + plan-limit pattern list + `sweep` delegation (S8 live). T1.
- **WP-4** Skill wiring: burn-down §lanes and codex-delegate §worktree both point at the helper (pointer, not restated recipe); auto-memory `herdr-worktree-lane-launch-recipe` gets a one-line "encoded in lane.mjs" receipt. T0.

## Out of scope (named, with where it goes)

- A Bors-style merge queue for merge-ref drift — its own quest (harvest at WP-2 close; the gastown prior art is on the quest note).
- "Pull the next ready quest into a lane" (`spine_map readyOnly` as tracker) — a later quest; not this spec.
- Claude-native peer messaging as a supervision path — settled dead (run-4 rulings 2, 3).

## Verification notes for the reviewer

⚠️ Untested at spec time: the plan-limit refusal text (constraint 11) — no captured sample exists yet; WP-3 seeds the pattern from the first real refusal and must not invent one. ✅ Verified at spec time: every herdr flag named above exists in `herdr 0.8.2-preview.2026-08-31` help output (`worktree create --no-focus/--label/--cwd/--branch/--base`; `agent start --kind/--pane/--timeout`; `agent wait --until/--timeout`; `agent prompt --wait/--until`; `agent read --lines`).
