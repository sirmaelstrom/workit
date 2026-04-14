---
name: improve-architecture
description: "Use when the user says 'review architecture', 'find code smells', 'what should I refactor', 'improve structure', or wants to make a codebase more agent-friendly and testable."
---

# Improve Architecture — Codebase Friction Analysis

Explore a codebase organically, surface architectural friction, and propose module-deepening refactors. A **deep module** (Ousterhout) has a small interface hiding significant complexity. Deep modules are more testable, more agent-navigable, and more maintainable.

## Process

### 1. Explore the codebase

Use the Agent tool with subagent_type=Explore to navigate organically. Do NOT follow rigid heuristics — the friction you experience IS the signal. Note where you encounter:

- **Scattered concepts** — understanding one thing requires bouncing between many small files
- **Shallow modules** — interface nearly as complex as the implementation
- **Testability extraction** — pure functions extracted just for testability, but real bugs hide in how they're called
- **Tight coupling** — modules that create integration risk at the seams
- **Untested or hard-to-test code** — structural problems preventing coverage

### 2. Present candidates

Present a numbered list of deepening opportunities. For each:
- **Cluster**: Which modules/concepts are involved
- **Why they're coupled**: Shared types, call patterns, co-ownership of a concept
- **Current friction**: What makes this painful now
- **Test impact**: What existing tests would be replaced by boundary tests

Do NOT propose interfaces yet. Ask: "Which of these would you like to explore?"

### 3. User picks a candidate

### 4. Frame the problem space

Write a user-facing explanation:
- Constraints any new interface would need to satisfy
- Dependencies it would rely on
- A rough illustrative sketch to ground the constraints (not a proposal)

### 5. Design alternatives

Spawn 3+ sub-agents in parallel (or invoke `/design-alternatives`). Each produces a radically different interface for the deepened module, with different design constraints.

Present designs sequentially, compare in prose, give an opinionated recommendation.

### 6. User picks an interface

### 7. Create actionable output

Either:
- Create a GitHub issue as a refactor RFC
- Feed into `/workshop` if the refactor is complex enough to warrant a full spec
- Add to the project's TODO or backlog

## Deep Module Criteria

A good deepening refactor:
- Reduces the total interface surface area
- Hides complexity that callers don't need to know about
- Makes the module testable at its boundary (not its internals)
- Makes the codebase more navigable for both humans and agents

---
*Inspired by Matt Pocock's improve-codebase-architecture skill. Adapted with workshop pipeline integration and design-alternatives skill connection.*
*Source: github.com/mattpocock/skills/tree/main/improve-codebase-architecture*
