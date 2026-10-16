# Pattern: stack-attack

**What:** On a greenfield repo, the stack decision (D1) gets one lens whose only job is to attack it, before D1 is ruled. Throwaway spikes of the core loop run only when that lens names a credible alternative stack. The operator chose this order (quest 061b526a, answer (c)). The lens costs one model turn, and the spikes cost 30 to 60 minutes. A greenfield run pays for spikes only when an argument has given a reason to.

**When to use:** `/spec` runs it when invoked with `--greenfield`. `/conduct` passes that flag when intake's trigger is on, which happens when the repo has no CI workflow that can gate a PR or has at most 3 commits on a non-shallow HEAD (quest 977d3efb). Outside `/conduct`, use it on any spec whose first decision picks a language, framework or runtime for a new codebase.

**Why:** On Shopfloor RC-3 (2026-10-06), `decisions.md` D1 listed five options with one line each. The winner's first trade-off was "the operator's personal stack". No spike ran. Five fresh-eyes waves and a four-seat spec council produced zero findings on D1. A council reviewing a finished spec critiques what the spec chose to list; it rarely reopens the first decision. Only a lens charged with nothing else does.

## The procedure

1. **Draft D1, don't rule it.** In Stage 2 (lite: the Decisions section), write D1 with its options, the drafted choice and its reasoning, marked `[DECISION: D1 — pending stack attack]`. Name the **core loop**: the one operation the product repeats most, whose cost or correctness the stack decides (a tick of a simulation, a request through a handler, a render of a frame). Every later step measures that loop.
2. **Send the lens the inputs.** These are `problem-statement.md` (lite: the Problem section), the constraints known so far, the core loop, and the drafted D1 with every option it lists. The lens must see the draft, because its job is to attack that draft. This differs from the blind second read, which must not see the plan.
3. **Pick the lens model from another vendor family than the drafter.** A Claude-drafted spec goes to GPT-6 Astra at high through `codex exec`, the same invocation `codex-delegate` documents for the blind second read and the same carve-out. The turn is read-only, and the prompt says so: `--sandbox read-only` is broken on Windows, so only the prompt can carry the limit.
4. **Use the prompt below, verbatim apart from the slots.** Save the handback as `stack-attack-<model>-<YYYY-MM-DD>.md` in the workshop, with a header naming the model, the effort and the inputs.
5. **Read the verdict line.**
   - `Verdict: no credible alternative`: rule D1 as drafted. Its reasoning cites the attack file and the strongest objection, answered in one line.
   - `Verdict: credible alternative`: run the spike step (below) before ruling D1.
   - A handback with no verdict line, or one naming an alternative without all four fields, is no verdict. Re-run the lens once. If it still has no verdict, rule D1 as drafted and mark it `[DECISION: D1 — low confidence, stack attack returned no verdict]`.
6. **Record the outcome in D1** as one line: `Stack attack: <verdict> (<file>)`, plus `Spikes: <synthesis path>` when they ran.

## The lens prompt

```
You are the stack-attack lens for a greenfield spec. Your only job is to attack the drafted stack decision (D1) below. This turn is read-only: do not write, create or delete any file, and run no command that changes state.

Problem: {{problem}}
Constraints: {{constraints}}
Core loop: {{core_loop}}
Drafted D1 (options, choice, reasoning): {{d1}}

Find the strongest case that a different stack serves this core loop better. Attack the draft's reasoning first: which trade-off does it state without evidence, and which does it leave out? A preference is not evidence ("the operator's stack", "familiar", "popular"). Then name at most two alternative stacks that would beat the draft on a property of the core loop that can be measured.

An alternative is credible only when you can fill all four fields:
- stack: a concrete language, runtime and framework, with versions where they matter
- property: the core-loop property it wins on (latency, determinism, memory, testability, a library the loop needs)
- mechanism: why that stack wins on that property, in one or two sentences, with the source you rely on
- spike: a throwaway build of the core loop in 30 to 60 minutes, and the number it would print that settles the comparison

If no alternative has all four fields, say so. Don't manufacture one: "no credible alternative" is a useful result, and the drafted choice then stands.

Return at most 400 words in this shape:
Attack: <the drafted reasoning's weakest point, quoted, and why>
Alternative 1: stack / property / mechanism / spike (omit if none)
Alternative 2: stack / property / mechanism / spike (omit if none)
Verdict: credible alternative | no credible alternative
```

## The spike step (verdict: credible alternative)

Run `parallel-explore` in **spike mode** (its SKILL.md § Spike mode). There are 2 or 3 branches: the drafted stack and each credible alternative the lens named. Each branch builds the same core loop in its stack and prints the spike's settling number. Every branch prompt holds these constant: the core loop, the input size, the machine, and the measurement command. Synthesis is `pick-one` and recommends a stack from the measured numbers. A branch whose build failed is evidence about that stack, not a tie. Rule D1 from the synthesis, citing each branch's number. When the spikes contradict the lens, the numbers win, and D1 says so.

Spike code is throwaway. Each branch starts in its own spike directory outside the repo and is told to write only there; the launcher places it but does not confine it. Spike code never goes into the workshop or a work package. The synthesis quotes numbers, not code.

## Evidence and falsifier

The procedure has not been measured yet. It answers the RC-3 gap, where no step could have reopened D1.

**Falsifier:** five greenfield runs where the lens returns `no credible alternative` every time, and the operator later reopens the stack anyway. That would mean the lens is not attacking. Also watch for three runs where spikes ran and every one confirmed the draft. That would mean the lens's bar for "credible" is too low. Either way, revise the prompt here.

## Execution Feedback

*(Append results here: run, date, verdict, whether spikes ran, and what D1 became)*

---
*Source: quest 061b526a (operator answer (c), 2026-10-16), Shopfloor RC-3 analysis §7.*
*Used by: `spec` (Stage 2 and lite Decisions, with `--greenfield`), `conduct` (passes `--greenfield`). Carve-out: `codex-delegate` (the blind second read's invocation). Spikes: `parallel-explore` § Spike mode.*
