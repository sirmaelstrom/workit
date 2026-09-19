# Pattern: session-chain

*This is the binding spec for `scripts/session.mjs`, reproduced from the session-chain-primitives spec-lite. It deliberately replaces host details with `<workspace>` and `<home>` because this public repository carries the mechanism, not an operator topology.*

## Intent

Long-running Claude work needs a deterministic rotation carrier rather than a hand-built pane split, pasted brief, and manually copied receipt. The carrier wraps herdr for Claude sessions so a conductor, hook, or operator can spawn, brief, watch, and retire a session while recording a JSONL row for the next receipt.

## Scope rulings

- `retire self` is supported: it writes its receipt before sending `/exit`.
- A successor closes a caller only after it is gone and `process-info` shows no Claude process. The final message comes from the marker-gated Stop hook, not scrollback.
- `tokens.context` comes from `herdr pane get`; absent means `null`, never `0`.
- The context threshold N is measured per model elsewhere; this carrier records the value.
- Claude-to-Claude `delegate` is out of scope. In-turn work uses the Agent tool.
- Fork is a flag with unit coverage. Interactive fork use and Stop-hook ordering remain live-smoke work.

## Verbs

| Verb | Inputs | Action | Receipt |
|---|---|---|---|
| `spawn` | explicit `--name`, `--model`, `--effort`; optional cwd, source pane, direction, fresh/fork, chrome, timeout | split a no-focus pane; start Claude with explicit permission/model/effort; wait briefly for session publication; verify the launched argv; restore caller focus | name, pane, session id, model, effort, mode, argv verification, parent pane, start time |
| `brief` | target, absolute `--file`; optional wait/timeout | sends exactly `Read <path> and execute it exactly.` through herdr argv | target, file, accepted, observed state |
| `watch` | target, repeated terminal states, timeout | herdr agent wait; on blocked reads the dialog | state; gone accepts done-with-record or agent-not-found |
| `retire` | self, parent, name, or pane; exit/close/exit+close | sends `/exit` through the executor; close waits for gone, parses the resume banner, and refuses a live process | target, mode, resume id or null, closed, final path or null |
| `chain` | handoff, successor name, model, effort; optional fork/cwd/direction/chrome | reads caller session/context/model; spawn; require successor idle; brief; receipt; retire caller unless opted out | chain id, caller and successor identity, context, models, model-change flag, handoff, timestamp |
| `status` | optional chain id / last | reads chain rows for a landing receipt | matching rows |

Default sidecar: `<workspace>/data/outputs/projects/agentic-practice-transfer/sessions/session-log.jsonl`, with adjacent `.state.json`. `--log` overrides it. `<workspace>` resolves from `--workspace-root`, then `WORKIT_WORKSPACE_ROOT`, then cwd.

## Constraints

1. Self retirement and chaining require `HERDR_ENV=1` and `HERDR_PANE_ID`; invalid input fails before herdr.
2. Spawn model and effort are mandatory launch flags; they are never inherited. `dontAsk` is refused before a call.
3. Context is read, not invented: absent is null.
4. A pane with a Claude process is never closed.
5. Gone has two successful shapes: done-with-record or agent-not-found.
6. Resume ids are parsed only from `Resume this session with: ... claude --resume <uuid>`; a missing banner warns by yielding null but does not block a clean close.
7. Self retirement writes the row first and sends `/exit` last; self close is invalid.
8. A successor that is not ready leaves the caller and successor in place, returns exit 4, and records `successor-not-ready`.
9. Public artifacts contain no host topology; all paths come from environment or arguments.
10. Herdr commands use the executor (`execFileSync` underneath), never a shell string.
11. Model change is recorded and requires the handoff's authority clause.
12. Handoffs derive environment at pickup; PR-boundary briefs carry the rotation steps and anchored quest, not stale state.
13. The JSONL row, rather than remembered prose, is the successor's evidence.

## Stop-hook capture

`scripts/session-stop-capture.mjs` reads hook stdin JSON. If `<home>/.workit/session-chain/final-pending/<session-id>` exists (or `WORKIT_SESSION_CHAIN_DIR` selects the state directory), it writes `last_assistant_message` to `final/<session-id>.md` and removes the marker. With no marker it exits quietly and writes nothing. Registration is deliberately outside this public repository. The ordering assumption is falsified if a live self-retirement lacks that final file or captures an earlier turn; then move the hook to SessionEnd and record its payload.

## Verification

The unit suite uses an injected fake executor and establishes: refused `dontAsk`; mandatory launch flags; successor timeout makes no `/exit`; a live process makes no pane close; both gone shapes; parsed-only resume ids; null context; ordered happy chain receipt; model-change warning; marker-gated capture. The successor-not-ready and live-process cases each include a positive branch so their absence assertions are not vacuous.

Herdr flags were verified from local help: `pane split --direction --cwd --no-focus`; `agent start --kind --pane --timeout --`; `agent prompt --wait --until --timeout`; `agent wait --until --timeout`; `pane process-info --pane`; `pane close <id>`; `pane get <id>`; and `agent get <target>`.

## Out of scope

- Claude `delegate`, a second slash-command surface, and selecting N are separate work.
- Stop-hook registration and a release announcement remain private/operator work.
- The carrier's first live chain, final-message capture, and interactive fork are conductor smokes, not CI claims.
