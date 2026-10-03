# Pattern: session-chain

*This is the binding spec for `scripts/session.mjs`, reproduced from the session-chain-primitives spec-lite. It deliberately replaces host details with `<workspace>` and `<home>` because this public repository carries the mechanism, not an operator topology.*

## Intent

Long-running Claude work needs a deterministic rotation carrier rather than a hand-built pane split, pasted brief, and manually copied receipt. The carrier wraps herdr for Claude sessions so a conductor, hook, or operator can spawn, brief, watch, and retire a session while recording a JSONL row for the next receipt.

## Scope rulings

- `retire self` is supported: it writes its receipt before sending `/exit`.
- A successor closes a caller only after `done`, `agent_not_found` or `agent_not_running` (the caller already exited) and a parseable `process-info.foreground_processes` array shows no Claude process. Idle is never gone; an absent or unreadable process list fails closed. The final message comes from the marker-gated Stop hook, not scrollback.
- `tokens.context` comes from `herdr pane get`; absent means `null`, never `0`.
- The context threshold N is measured per model elsewhere; this carrier records the value.
- Claude-to-Claude `delegate` is out of scope. In-turn work uses the Agent tool.
- Fork is a flag with unit coverage. Interactive fork use and Stop-hook ordering remain live-smoke work.

## Verbs

| Verb | Inputs | Action | Receipt |
|---|---|---|---|
| `spawn` | explicit `--name`, `--model`, `--effort`; optional cwd, source pane, direction, fresh/fork, chrome, timeout | split a no-focus pane; start Claude with explicit permission/model/effort; wait briefly for session publication; verify the launched argv; restore caller focus | name, pane, session id, model, effort, mode, argv verification, parent pane, start time |
| `brief` | target, absolute `--file`; optional wait/timeout | sends exactly `Read <path> and execute it exactly.` through herdr argv | target, file, accepted, observed state |
| `watch` | target, repeated terminal states, timeout | herdr agent wait; on blocked reads the dialog | state; gone accepts done-with-record, agent-not-found or agent-not-running, never idle |
| `retire` | self, parent, name, or pane; exit/close/exit+close | sends `/exit` through the executor; close waits for gone and a clean process guard, then reads the resume banner (once more if still painting) | target, mode, resume id or null, closed, final path or null |
| `chain` | handoff, successor name, model, effort; optional fork/cwd/direction/chrome | reads caller session/context/model; spawn; require successor idle; brief; receipt; retire caller unless opted out | chain id, caller and successor identity, context, models, model-change flag, handoff, timestamp |
| `status` | optional chain id / last | reads chain rows for a landing receipt | matching rows (two for a chain whose caller `/exit` was refused; see 8b) |

Default sidecar: `<workspace>/data/outputs/projects/agentic-practice-transfer/sessions/session-log.jsonl`, with adjacent `.state.json`. `--log` overrides it. `<workspace>` resolves from `--workspace-root`, then `WORKIT_WORKSPACE_ROOT`, then cwd.

## Constraints

1. Self retirement and chaining require `HERDR_ENV=1` and `HERDR_PANE_ID`; invalid input fails before herdr.
2. Spawn model and effort are mandatory launch flags; they are never inherited. `dontAsk` is refused before a call.
3. Context is read, not invented: absent is null.
4. A pane with a Claude process is never closed. `process-info` must expose `foreground_processes`; absent or malformed JSON is live until proved otherwise.
5. Gone has three successful shapes: done-with-record, agent-not-found, or agent-not-running (the record remains but the process exited); idle is never gone.
6. Resume ids are parsed only from `Resume this session with: ... claude --resume <uuid>`; a missing banner warns by yielding null but does not block a clean close.
7. Self retirement writes the row first and sends `/exit` last; self close is invalid. `--capture-final` gets the caller session id from `agent get <HERDR_PANE_ID>` first, then the sidecar; no id is a usage refusal. It is invalid with `chain --no-retire`.
8. A successor that is not ready leaves the caller and successor in place, returns exit 4, and records `successor-not-ready`.
8a. A freshly split pane is not an available shell until its prompt draws, so `spawn` retries `agent start` on the same pane while herdr answers `agent_pane_busy`. One wall-clock deadline, the readiness timeout (`--successor-timeout` under `chain`, else `--timeout`) after the split, bounds the whole start phase: busy retries, `agent start`, and the readiness poll. No start attempt begins at or after the deadline, a retry sleeps 250 ms or what remains if less, and each retry passes herdr's `--timeout` only the remaining budget. Wall time can exceed the deadline only by the herdr call in flight when it passes. A start that returns after the deadline is not ready (`successor-not-ready`, `successorStartedLate: true`), so the caller is kept. Any other start failure is final on the first attempt. A pane still busy at the deadline returns exit 4 with `reason: agent_pane_busy` and never retires the caller. The split is closed only when `process-info` shows its foreground as the shell alone (every foreground pid is `shell_pid`). Otherwise it is kept, with `successorPaneKept` naming why: `foreground-not-shell`, `process-info-failed`, `process-info-unreadable` or `close-failed`. The row records `startAttempts`. A chain row, and a `successor-not-ready` row, record `successorStartAttempts`. A chain row also records `callerRetirement` (`retiring` or `kept`).
8b. A chain normally appends one row. When the caller's `/exit` is refused, it appends its `chained` row and then a `retire-failed` row with the same `chainId` (`callerRetirement: exit-refused`, exit 1). So `status --last` returns the failure, and `status --chain <id>` returns both rows. The refusal also disarms the caller's `--capture-final` marker and sets the persisted chain record to `exit-refused`. An accepted `/exit` is a delivered prompt, not proof that the caller exited. The successor's `retire <caller pane> --mode close` is what confirms it.
9. Public artifacts contain no host topology; all paths come from environment or arguments.
10. Herdr commands use the executor (`execFileSync` underneath), never a shell string.
11. Model change is recorded and requires the handoff's authority clause.
12. Handoffs derive environment at pickup; PR-boundary briefs carry the rotation steps and anchored quest, not stale state.
13. The JSONL row, rather than remembered prose, is the successor's evidence.

## Stop-hook capture

`scripts/session-stop-capture.mjs` reads hook stdin JSON. If `<home>/.workit/session-chain/final-pending/<session-id>` exists (or `WORKIT_SESSION_CHAIN_DIR` selects the state directory), it writes a non-empty `last_assistant_message` to `final/<session-id>.md` and removes the marker. Missing or empty message data leaves the marker intact and writes nothing. With no marker it exits quietly. Registration is deliberately outside this public repository. The ordering assumption is falsified if a live self-retirement lacks that final file or captures an earlier turn; then move the hook to SessionEnd and record its payload.

## Verification

The unit suite uses an injected fake executor and establishes: refused `dontAsk`; mandatory launch flags; successor timeout makes no `/exit`; a live process makes no pane close; every gone shape; parsed-only resume ids; null context; ordered happy chain receipt; model-change warning; marker-gated capture; a busy-then-ready successor pane that still retires the caller; a busy-forever pane that keeps caller custody within the bound, including non-divisible budgets, a retry that would start after the deadline, and a start that returns after it; a split closed only when its foreground is the shell alone; a refused caller `/exit` recorded as `retire-failed`, with its final capture disarmed and its persisted record marked. The successor-not-ready and live-process cases each include a positive branch so their absence assertions are not vacuous.

Herdr flags were verified from local help: `pane split --direction --cwd --no-focus`; `agent start --kind --pane --timeout --`; `agent prompt --wait --until --timeout`; `agent wait --until --timeout`; `pane process-info --pane`; `pane close <id>`; `pane get <id>`; and `agent get <target>`.

## Out of scope

- Claude `delegate`, a second slash-command surface, and selecting N are separate work.
- Stop-hook registration and a release announcement remain private/operator work.
- The carrier's first live chain, final-message capture, and interactive fork are conductor smokes, not CI claims.
