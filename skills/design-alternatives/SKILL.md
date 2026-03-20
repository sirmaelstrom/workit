---
name: design-alternatives
description: "Generate multiple radically different design alternatives for a module, interface, or architectural decision using parallel sub-agents. Use when the user says 'design it twice', 'explore alternatives', 'what are my options', wants to compare approaches, or needs to make an architectural decision between competing designs."
---

# Design Alternatives — Parallel Exploration

Generate multiple radically different designs for a module, interface, or architectural decision. Based on "Design It Twice" from Ousterhout's *A Philosophy of Software Design*: your first idea is unlikely to be the best.

## Process

### 1. Gather requirements

Before designing, understand:
- What problem does this solve?
- Who are the callers / consumers?
- What are the key operations?
- Constraints (performance, compatibility, existing patterns)?
- What should be hidden vs. exposed?

### 2. Generate designs (parallel sub-agents)

Spawn 3+ sub-agents simultaneously using the Agent tool. Each must produce a **radically different** approach.

Give each agent a different design constraint:
- Agent 1: "Minimize the interface — 1-3 entry points max"
- Agent 2: "Maximize flexibility — support many use cases and extension"
- Agent 3: "Optimize for the most common caller — make the default case trivial"
- Agent 4 (if applicable): "Take inspiration from [specific paradigm/pattern]"

Each sub-agent outputs:
1. Interface signature (types, methods, params)
2. Usage example showing how callers use it
3. What complexity it hides internally
4. Trade-offs of this approach

### 3. Present and compare

Present designs sequentially so the user can absorb each before comparison. Then compare in prose — not tables. Highlight where designs diverge most.

**Be opinionated.** Give your recommendation: which design is strongest and why. If elements from different designs combine well, propose a hybrid.

### 4. User picks (or accepts recommendation)

### Anti-patterns
- Don't let sub-agents produce similar designs — enforce radical difference
- Don't skip comparison — the value is in contrast
- Don't implement yet — this is purely about shape and trade-offs
- Don't evaluate based on implementation effort alone

---
*Inspired by Matt Pocock's design-an-interface skill and the beam-search pattern from autonomous spec pipeline research.*
*Source: github.com/mattpocock/skills/tree/main/design-an-interface*
*Also draws from: improve-codebase-architecture parallel exploration pattern*
