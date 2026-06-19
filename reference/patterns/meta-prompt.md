# Pattern: meta-prompt

**What:** 3-part architecture for complex, multi-agent work. You're not just writing a spec — you're writing the strategy document that tells the orchestrator how to decompose and delegate.

**When to use:** Work that's too complex for a single dispatch. Multiple agents, multiple phases, coordination required.

## The Three Parts

### 1. Orchestrator Prompt
The instructions for the coordinating agent. References the parallelization plan, defines the overall execution strategy, specifies how agents report back and how results are synthesized.

### 2. Parallelization Plan
Decomposes all phases. Defines what prompts the orchestrator gives to implementing agents. Maps dependencies. Identifies what can run concurrently.

This is the strategic layer — it's not just "do these things in parallel," it's "here's the reasoning behind the decomposition and the quality gates between phases."

### 3. Full Spec Document
The detailed specification. Files, decisions, phases, quality gates. Each implementing agent gets the slice relevant to their work package, plus enough context to understand where they fit.

## Why This Is Different

This is a **meta-prompt system**: the orchestrator doesn't just execute, it has a strategy document for how to decompose and delegate. This is a level above typical AI usage — it gives the AI the same thing a senior dev would want: the plan, the reasoning behind the plan, and the quality gates.

## When NOT to Use

- Single-file changes → just dispatch directly
- Simple multi-package specs → `wave-execution` is sufficient
- Use this when the work requires **coordination between agents**, not just parallel execution of independent units

## Enterprise Application

First production test at an enterprise: full day creating two detailed specs for real production features. Results: 4-8x time savings, but the bigger win was **energy conservation** — the cognitive drain of manually threading a change through 10+ stored procs and full stack is significant. The spec approach preserves mental energy for higher-value work.

## Execution Feedback

*(Append results here)*

---
*Source: LESSONS.md meta-prompt architecture notes, enterprise spec engineering results*
*Execution pattern — orchestration architecture for complex multi-agent work*
*See also: `spec-engineering`, `wave-execution`, `work-package`, `decomposition`*
