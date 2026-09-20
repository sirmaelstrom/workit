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
3. Write a spine_receipt on the anchor citing the caller resume id, your pane +
   session id, and the caller context % from that row.
4. Pick up the anchored quest.

Authority: if you are Fable 5.1 the 2026-09-04 ruling applies (merges + pm2 deploys pre-authorized,
production hosts held); if you are not Fable, hold at every PR boundary with
needs_input.
```

`chain` / `retire self` must be your LAST tool call — make no tool call after it; write your final message and stop.

When `retire --mode close` reaches Claude Code's "Background work is running" exit dialog, it waits
`--dialog-after-ms` (15,000 by default), proves every direct child of claude.exe is a `run-*-mcp.js`
server, and answers Enter itself. A live non-MCP child is never approved: it returns
`dialog: "background-process-live"` with its argv so a person can decide.

Fork mode and Stop-hook ordering are unit-tested, not yet live-proven. The hook is shipped as `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop-capture.mjs`, but its registration belongs to the private operator configuration.
