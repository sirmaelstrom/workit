---
name: prototype
description: "Build a throwaway prototype to answer a specific design or logic question before committing. Trigger: 'prototype this', 'spike this', 'try a quick implementation', 'build a quick prototype', or when grilling/spec hits a question that can only be answered by running code. Branches into LOGIC (terminal state-machine exploration) or UI (multiple visual variations toggled on one route). Pairs with handoff for the DIY sub-agent pattern."
---

# Prototype — Throwaway Code That Answers a Question

A prototype is **throwaway code that answers a specific question.** The question decides the shape.

<supporting_info>
Prototypes are not MVPs. An MVP is the smallest version of the real thing. A prototype is *not* the real thing — it exists only to learn something, and it gets deleted or absorbed once the answer is captured. Mixing these up produces "prototypes" that survive into production and accumulate technical debt.
</supporting_info>

## Pick the Branch

Identify which question is being answered. Pull from the user's prompt, the surrounding code, or ask if the user is around:

- **"Does this logic / state model feel right?"** → Read [LOGIC.md](LOGIC.md). Build a tiny interactive terminal app that drives the state machine through cases that are hard to reason about on paper.
- **"What should this look like?"** → Read [UI.md](UI.md). Generate several radically different UI variations on a single route, toggled via a URL search param and a floating switcher.

The branches produce very different artifacts. **Getting this wrong wastes the whole prototype.**

If the question is genuinely ambiguous and the user isn't reachable, default by surrounding context:
- A backend module, reducer, state machine, business logic file → **LOGIC**
- A page, route, component, or anything user-facing → **UI**

State the assumption explicitly at the top of the prototype.

## Rules That Apply to Both Branches

1. **Throwaway from day one, and clearly marked as such.** Locate the prototype next to where the real code lives (or will live) so context is obvious. Name it so a casual reader instantly sees it's a prototype — `__prototype__/`, `prototype-foo.ts`, route prefix `/proto/`, etc. Follow whatever conventions the project already uses; don't invent new top-level structure.

2. **One command to run.** Whatever the project's existing task runner supports — `pnpm <name>`, `bun <path>`, `dotnet run --project <path>`, `python <path>`. The user must be able to start it without thinking. State the command at the top of the prototype file.

3. **No persistence by default.** State lives in memory. Persistence is usually the thing you're *checking*, not something the prototype should depend on. If the question explicitly involves a database, use a scratch DB or local file with a clear `PROTOTYPE — wipe me` name.

4. **Skip the polish.** No tests, no error handling beyond what makes the prototype runnable, no abstractions. The point is to learn fast and delete. If you find yourself refactoring the prototype, stop.

5. **Surface the state.** After every action (LOGIC) or on every variant switch (UI), print or render the full relevant state. The user must be able to see what changed. Invisible state defeats the prototype.

6. **Delete or absorb when done.** When the prototype has answered its question, either delete it outright or fold the validated decision into the real code. Don't leave prototypes rotting in the repo — they confuse future readers and rot into accidental dependencies.

## When the Prototype Has Answered Its Question

The *answer* is the only thing worth keeping. Capture it somewhere durable before the prototype goes away:

- **Inline note** — `NOTES.md` next to the prototype, with the question and the verdict
- **ADR or design doc** — if the decision is architecturally significant
- **Commit message** — if the prototype is being deleted in the same commit
- **KB entry** — if the lesson generalizes beyond this codebase (`kb_save`)
- **Workshop input** — if the prototype was answering a question that's now feeding a spec, reference the verdict in the workshop's `decisions.md`

If the user is around, this capture is a quick conversation. If not, leave a placeholder so they (or a future session via `handoff`) can fill in the verdict before deletion.

## Connection to Other Skills

- **`grill-me` / `spec`** — common upstream triggers. Grilling or spec'ing hits a question that can only be answered by running code → prototype.
- **`handoff`** — natural pairing. Prototype work usually happens in a *separate* context window from the grilling/spec session that triggered it. Use the DIY sub-agent pattern: handoff out → prototype → handoff back with the verdict.
- **`design-alternatives` / `parallel-explore`** — adjacent but different. `parallel-explore` explores design *space* via parallel sub-agents writing competing proposals. `prototype` explores design *reality* by running code. Use parallel-explore first if you don't know which directions to try; use prototype to validate the direction you've narrowed to.
- **`execute-wp`** — distinct. WP execution builds production code against a spec. Prototypes are throwaway. Don't confuse the two.

## Anti-patterns

- **Building both branches at once.** Logic and UI prototypes have different rules and different artifacts. Combining them produces neither.
- **Skipping the surface-state rule.** A prototype where you can't see what happens is just code that runs.
- **Adding tests, types, or error handling "while you're in there."** That's the failure mode that turns prototypes into permanent code.
- **Forgetting to capture the answer.** The prototype is the *vehicle*; the verdict is the *cargo*. Discarding the cargo defeats the whole exercise.
- **Treating the prototype as the deliverable.** It's not. The deliverable is the validated decision. The prototype gets deleted.
- **Building UI prototypes when the question is really about logic** (or vice versa). Re-check the branch decision before writing any code.

---
*Adopted from Matt Pocock's `prototype` skill (github.com/mattpocock/skills/tree/main/skills/engineering/prototype). Adapted: explicit connection to workshop pipeline (grill-me, spec, parallel-explore), KB capture path, handoff pairing for DIY sub-agent pattern.*
