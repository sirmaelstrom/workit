---
name: Code Review
description: Request a focused code review on recent changes
tags: [review, quality]
variables:
  repo:
    label: Repository
    placeholder: "e.g., web-frontend, backend-service"
  files_or_branch:
    label: Files or branch
    placeholder: "e.g., src/lib/state/chat.svelte.ts, or branch name"
  what_changed:
    label: What changed
    placeholder: "Brief summary of the changes"
  concerns:
    label: Specific concerns
    placeholder: "e.g., performance, edge cases, API design"
---

Review the following changes in **{{repo}}**.

**What changed:** {{what_changed}}

**Files/branch:** {{files_or_branch}}

**Review focus:** {{concerns}}

Look at the code and provide feedback on:
1. Correctness — any bugs, edge cases, or logic errors
2. The specific concerns listed above
3. Anything that smells off — naming, structure, unnecessary complexity

Skip praise. Just flag issues and suggest improvements. If it looks clean, say so briefly.
