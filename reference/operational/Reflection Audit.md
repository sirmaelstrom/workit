---
name: Reflection Audit
description: Comprehensive codebase audit — security, maintainability, DX, testing, documentation
tags: [security, audit, continuous_improvement]
variables:
  project_path:
    label: Project path
    placeholder: "e.g., ~/projects/your-project"
  focus_area:
    label: Priority focus
    placeholder: "e.g., server code, API layer, state management"
    default: "server code"
  output_format:
    label: Output format
    placeholder: "e.g., prioritized findings list, filed issues, summary report"
    default: "prioritized findings list with severity (P0-P4)"
---

Audit the codebase at `{{project_path}}` with priority focus on **{{focus_area}}**.

Evaluate across these dimensions:

1. **Security** — Injection vectors, auth/authz gaps, secrets exposure, input validation, OWASP top 10
2. **Maintainability** — Coupling, complexity hotspots, dependency health, upgrade risk, dead code
3. **Developer Experience** — Build/test ergonomics, onboarding friction, error messages, tooling gaps
4. **Testing & Validation** — Coverage gaps, missing edge cases, integration test opportunities, CI gaps
5. **Knowledge Capture** — Are lessons learned documented? Do CLAUDE.md / MEMORY.md reflect current reality? Are patterns consistent across the portfolio?

Use a team of agents to audit the full codebase. Give everything a look, but prioritize {{focus_area}}.

**Output:** {{output_format}}. For each finding, include: what, where (file:line), why it matters, and suggested fix.
