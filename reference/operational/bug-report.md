---
name: Bug Report
description: Structured bug report with context and reproduction steps
tags: [bug, debugging]
variables:
  component:
    label: Component / Area
    placeholder: "e.g., chat input, file browser, bridge connection"
  what_happened:
    label: What happened
    placeholder: "Describe the actual behavior"
  expected:
    label: Expected behavior
    placeholder: "What should have happened instead"
  steps_to_reproduce:
    label: Steps to reproduce
    placeholder: "1. Open X\n2. Click Y\n3. See error"
---

## Bug Report: {{component}}

**What happened:** {{what_happened}}

**Expected:** {{expected}}

**Steps to reproduce:**
{{steps_to_reproduce}}

Investigate this bug. Check the relevant code, identify the root cause, and suggest a fix. If you can determine the exact file and line, point to it. If the cause is ambiguous, list the most likely candidates ranked by probability.
