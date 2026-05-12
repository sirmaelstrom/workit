# Prototype — LOGIC Branch

A **logic prototype** is a minimal interactive terminal application that drives a state model, reducer, or data structure through cases that are hard to reason about on paper.

The point is **hands-on interaction with the logic itself**, not a UI experiment. You're answering questions like:

- Does this state machine handle the suspended → active → suspended cycle correctly?
- What happens if these two reducer actions arrive out of order?
- Is this API shape pleasant to use, or does it force callers into awkward sequences?
- Does this caching strategy actually invalidate when I expect it to?

## Structure: Separate the Logic From the Shell

The single most important rule:

1. **Pure logic module** — the reducer, state machine, function set, or class that *actually answers the question*. No I/O. No `console.log` for control flow. No terminal code. This module is the thing being prototyped — it's potentially the artifact you'll keep (in adapted form) when the prototype is absorbed.

2. **Lightweight TUI shell** — throwaway code that renders state and captures input. This is what makes the prototype interactive. It is **completely disposable** — it never makes it into production, and it never should.

If you mix UI and logic, you can't extract the validated decision when the prototype is done. Keep them separate from the start.

## Process

### 1. State the Question Explicitly

At the top of the prototype file, write the question being answered. Example:

```ts
// PROTOTYPE — wipe me when answered
// Question: Does the SUSPENDED → ACTIVE transition correctly handle the timeout
// edge case where the timer fires while the user is mid-action?
// Run: bun run src/state/__prototype__/run.ts
```

This anchors the prototype. If you can't write the question in one or two sentences, you don't have a prototype — you have a vague exploration.

### 2. Build the Pure Logic Module

Use the host project's language and tools. Don't introduce new dependencies unless absolutely required. Examples:

- TypeScript/Node project → write a `.ts` file with the pure functions / state machine
- .NET project → write a small console app with the logic in its own class
- Python project → write a `.py` file with the pure functions
- Rust project → write a small bin crate

The logic module should be exportable / importable so it can later be promoted into the real codebase with minimal change.

### 3. Build the TUI Shell

A full-screen refresh on each keystroke is far better than scrolling output — the user sees state, not history.

Minimum capabilities:

- Display current state clearly (the entire relevant state, not just the delta)
- Accept keystroke or short-string commands to fire actions / events
- Show a one-line command legend so the user doesn't have to remember the inputs
- Show the result of the most recent action (which transition fired? which guard rejected?)

In Node/TypeScript, `readline` + ANSI clear is usually enough. Don't reach for `blessed` or `ink` unless the prototype genuinely needs richer rendering — that's polish, not learning.

### 4. Make It Runnable in One Command

State the command at the top of the file. Use the project's existing runner:

- `pnpm proto:state` (script entry in package.json)
- `bun run src/state/__prototype__/run.ts`
- `dotnet run --project src/Proto/Proto.csproj`
- `python src/state/__prototype__/run.py`

If the project doesn't have a clean way to launch, add a single line to its task runner. Don't invent new infrastructure.

### 5. Exercise the Question

Drive the prototype through:

- The happy path (does the basic case work?)
- The case the question is actually about (the edge case, the ambiguous transition, the awkward interaction)
- Adjacent cases that suddenly seem suspicious once you see the state

Print state after every action. If you can't tell what happened, the shell is wrong — fix the rendering, not the logic.

### 6. Capture the Verdict in NOTES.md

Before deleting, write a `NOTES.md` next to the prototype:

```markdown
# Prototype: {question}

**Run:** {command}
**Date:** {ISO}

## Question
{the question from the top of the prototype file}

## Verdict
{one paragraph — what we learned, what decision this enables}

## Surprises
{any unexpected behavior or edge cases that emerged}

## Where the answer lives now
- {ADR / commit / spec / KB entry / workshop decisions.md}
```

Then delete the prototype (or absorb the pure-logic module into the real code). The NOTES.md may stay if it's referenced from a workshop or ADR; otherwise it can go too.

## What to Avoid

- **Mixing UI rendering into the logic module.** The shell is throwaway; the logic might not be. Don't entangle them.
- **Adding persistence.** State lives in memory. If you need persistence to answer the question, use a scratch DB with a `PROTOTYPE — wipe me` name and tear it down after.
- **Adding tests.** Tests come when the validated logic is promoted into the real code. The prototype's *interactive runs* are the tests.
- **Generalizing.** If you find yourself parameterizing the prototype to handle "the general case," stop. Hard-code the specific question; generalization happens after the verdict.
- **Shipping the TUI shell.** It exists only to drive the prototype. Even if it's pretty, it doesn't belong in the production codebase.
- **Skipping the verdict capture.** Without NOTES.md, the prototype was a waste of time — the whole point was to produce a durable answer.
