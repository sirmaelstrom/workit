---
name: handoff
description: "Compact the current conversation into a handoff document so a fresh agent can pick up the work without losing intent. Trigger: 'hand off', 'handoff to a fresh agent', 'pass this to a new window', 'compact context', or when the context window is heavy mid-task and you need to continue in a fresh session. Also use the DIY sub-agent pattern: handoff out, work in another window, hand back."
---

# Handoff — Compact Conversation for a Fresh Agent

Write a handoff document summarizing the current conversation so a fresh agent can continue the work in a new context window. The document is **not a permanent artifact** — it's a transfer cartridge between two agents.

## Why This Exists

Long sessions accumulate context that's expensive to throw away. Two patterns this skill enables:

1. **Fire-and-forget.** Mid-task you notice an unrelated bug or need to do a side quest. Hand off to a fresh agent in a new window, let it fix the thing, done. No context contamination in the current session.

2. **DIY sub-agent.** You're deep in `grill-me` or `spec` and hit a question that can only be answered by running code. Hand off to a fresh window for a `prototype` or implementation spike. When that's done, hand *back* to the original session with what was learned. You get sub-agent benefits (clean context, focused work, can spawn its own sub-agents) without the limitations of the built-in Task tool (small context, no tool access for some patterns).

## Process

### 1. Decide the Handoff Target

If the user passed arguments, treat them as a description of what the next session will focus on. Tailor the document accordingly.

If no arguments, infer from the current session state. Ask the user briefly if the target is ambiguous — handing off to the wrong purpose wastes both windows.

### 2. Write the Document

Save to: `./outputs/handoffs/handoff-{YYYY-MM-DD-HHmmss}-{short-slug}.md`

The slug should reflect the handoff target (e.g., `prototype-state-machine`, `fix-pm2-config`, `grill-resume`).

**Document structure:**

```markdown
# Handoff: {short title}

**From session:** {brief description of current session — what we were doing}
**To session:** {what the new agent should focus on}
**Created:** {ISO timestamp}

## What This Session Was Doing

{1-3 paragraphs of the *intent* and *current state* of the originating session — not a transcript replay. What problem were we solving? Where had we gotten to?}

## What the New Session Needs to Know

### Decisions already made
- {decision 1 with one-line rationale}
- {decision 2}
- ...

### Open questions / unresolved
- {question 1 — what's blocking it}
- ...

### Artifacts to reference (do NOT duplicate)
- {workshop path / spec path / PR / file paths — by reference only}

## What the New Session Should Do

{Specific, actionable directive. Not "consider exploring" — "build a logic prototype for the state transitions in src/state/foo.ts, focused on the question: does the SUSPENDED → ACTIVE transition handle the timeout case correctly?"}

## Suggested Skills

{Skills the next session should use, with one-line "why":}
- `prototype` — because we need to answer a logic question by running code
- `diagnose` — because the symptom isn't reproduced yet
- (none) — direct implementation is fine

## Return Path (if DIY sub-agent pattern)

{If the new session should hand back, say so explicitly. What does the original session need from this one? "Hand back when the prototype is validated. Include: which approach worked, what edge cases broke, and any new constraints discovered."}

{Otherwise: "Fire-and-forget. No return needed."}
```

### 3. Surface the Path

Print the absolute path of the handoff document. The user copies that into a new terminal / Claude Code window:

```
claude --resume false
> Read ./outputs/handoffs/handoff-2026-05-12-093045-prototype-state-machine.md and continue from there.
```

## Critical Rules

1. **Do not duplicate content** already captured in other artifacts (PRDs, workshop specs, ADRs, KB entries, commits, diffs, plans). Reference them by path or URL. The handoff is the *bridge*, not the cargo.

2. **Capture the vibe, not just the content.** If the originating session is a grilling session, say so — the new agent should know it's in a grilling stance, not a build stance. Intent carries differently than facts.

3. **Be specific about the target.** "Continue this work" is useless. "Build a terminal prototype that exercises the state machine in src/foo.ts, focused on the SUSPENDED → ACTIVE transition timeout" is useful.

4. **Single file, no scratch dir.** One markdown document. If the next session needs lots of context, point to existing artifacts — don't inline them.

5. **Read the file before writing.** Claude Code Write errors if a path hasn't been Read first when overwriting. For new files this is fine, but if the user is re-handing-off the same slug, Read first.

## Connection to Other Skills

- **`grill-me` / `spec`** — common upstream. These are long-context sessions where the DIY sub-agent pattern shines.
- **`prototype`** — common downstream target. "I have a question I can only answer by running code" → handoff → prototype → handoff back.
- **`diagnose`** — common fire-and-forget target. Bug noticed mid-task; hand off, let a fresh window run the diagnosis flow.
- **`execute-wp`** — usually NOT a handoff target; execute-wp already has its own context discipline via the progress log. Hand off *into* execute-wp only if you're switching to a long execution and want a clean window.

## Anti-patterns

- Writing a transcript instead of a directive. The new agent doesn't need to know what we talked about — it needs to know what to do.
- Duplicating workshop content, spec content, or KB content inline. Reference by path.
- Handing off without specifying the return path when the DIY sub-agent pattern is in play. The originating session needs to know what to expect back.
- Vague targets ("explore the architecture"). Make it actionable.
- Using `mktemp` paths. Handoffs in `./outputs/handoffs/` are greppable, browsable, and persist long enough to be findable — temp files vanish.

---
*Adopted from Matt Pocock's `handoff` skill (github.com/mattpocock/skills/tree/main/skills/productivity/handoff). Adapted: persistent workspace path instead of mktemp, explicit DIY-sub-agent pattern guidance, connection to grill-me/prototype/diagnose/execute-wp pipeline.*
