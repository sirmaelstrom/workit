---
name: Research Brief
description: Commission research on a technical topic
tags: [research, planning]
variables:
  topic:
    label: Topic
    placeholder: "e.g., Svelte 5 SSR patterns, Tauri IPC performance"
  context:
    label: Context
    placeholder: "Why this matters, what project it's for"
  questions:
    label: Key questions
    placeholder: "Specific things you want answered"
  depth:
    label: Depth
    placeholder: "quick scan, moderate, or deep dive"
    default: moderate
---

Research: **{{topic}}**

**Context:** {{context}}

**Key questions:**
{{questions}}

**Depth:** {{depth}}

Produce a structured research brief. Include:
- Direct answers to the key questions
- Trade-offs and alternatives considered
- Concrete recommendations with rationale
- Links or references where relevant

If depth is "quick scan" — keep it to 1-2 paragraphs per question. If "deep dive" — be thorough, include code examples where helpful.
