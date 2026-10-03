---
name: session-chain
description: "Use when a long-running Claude session needs a durable successor in herdr. Trigger on '/session-chain', 'rotate this session', 'chain to a fresh session', or 'spawn a Claude session in herdr'. NOT for in-turn delegation (Agent tool) or codex lanes (codex-delegate / lane.mjs)."
---

# Session Chain

Long burn-downs should not pay a hand-built rotation tax. This skill points at one carrier that records the lifecycle as a sidecar receipt: spawn a successor, brief it from a file, observe it, then retire the caller only after the successor is ready.

The binding behavior is `${CLAUDE_PLUGIN_ROOT}/reference/patterns/session-chain.md`. Run `${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs`; it is the implementation, not this page.

| Verb | Use it for |
|---|---|
| `spawn` | Start a named Claude session in a new herdr pane with explicit model and effort. |
| `brief` | Send only `Read <path> and execute it exactly.` from a handoff file. |
| `watch` | Wait for idle, done, blocked, or gone. |
| `retire` | Exit a session; a successor may close a departed caller after the process guard. |
| `chain` | Spawn + brief + receipt + retire-self as one ordered carrier. |
| `status` | Read the chain receipt a successor must cite. |

## Rotation policy

Rotate at a PR boundary when the caller pane's `tokens.context` is at least **N**. N is measured per model, not chosen. The carrier records the caller percentage; absent context is `null`, never zero. Keep the handoff small: the successor derives environment at pickup and follows the anchored quest, rather than inheriting stale state.

## Rotation brief template

```
Read <handoff> and execute it exactly.

First steps:
1. node ${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs retire <caller pane> --mode close --log <path>
2. node ${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs status --last --log <path>
   If step 1 exited 4 (the caller never left) or that row is
   `state: retire-failed` (the caller's /exit was refused), the caller is
   still live: run `session.mjs retire <caller pane> --mode exit+close --log <path>`.
3. Write a spine_receipt on the anchor citing the caller resume id, your pane +
   session id, and the caller context % from that row.
4. Pick up the anchored quest.

Authority: Fable 5.1 (2026-09-04) and Opus 5.5 (2026-09-29) may merge and
pm2-deploy without a per-PR go; production hosts stay held. Any other model
holds at every PR boundary with needs_input.
```

`chain` / `retire self` must be your LAST tool call — make no tool call after it; write your final message and stop.

A `chain` that exits nonzero did not retire you. Exit 4 with `reason: agent_pane_busy` means the successor pane never became a shell (`successorPaneKept` says why a pane was left open). Exit 4 with `outcome: successor-not-ready` leaves a successor in `successorPane` to inspect. Exit 1 with `callerRetirement: exit-refused` means the successor is briefed but your `/exit` was refused. Read the output before retrying or continuing.

When `retire --mode close` reaches Claude Code's "Background work is running" exit dialog, it waits
`--dialog-after-ms` (15,000 by default), proves every direct child of claude.exe is a `run-*-mcp.js`
server or a background `lane.mjs wait` (Claude Code's background-Bash wrapper running only the wait
and output plumbing such as `tee`, `tail` or `echo`), and answers Enter itself; it reports
`abandonedLaneWaits`. Any other live child is never approved: it returns
`dialog: "background-process-live"` with its argv and exit 3 so a person can decide.

Fork mode and Stop-hook ordering are unit-tested, not yet live-proven. The hook is shipped as `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop-capture.mjs`, but its registration belongs to the private operator configuration.
