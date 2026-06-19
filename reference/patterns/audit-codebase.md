---
name: Audit codebase
description: Comprehensive read-only codebase audit using parallel agent decomposition
tags: [security, quality, testing, dx]
variables:
  repo:
    label: Repository path
    placeholder: "e.g., ~/projects/your-project"
  concerns:
    label: Key concerns
    placeholder: "e.g., security posture, test coverage, onboarding friction"
  output_path:
    label: Output path
    placeholder: "e.g., ./outputs/audits/your-project-2026-03.md"
---

# Codebase Audit

**This is a read-only audit. Do not modify any source files.**

Read this template fully before starting. Decompose the work into four parallel agents (one per category below), then synthesize results into a single report.

## Scope Fence

**This template IS for:** Systematic, evidence-based assessment of codebase health across four dimensions. Produces a prioritized findings report.

**This template is NOT for:**
- Fixing the issues found (that's a workshop)
- Reviewing a specific PR or changeset (use the `review` skill)
- Evaluating spec quality after dispatch (use `spec-scorecard` template)
- Verifying a build matches its spec (use `post-build-verification` template)

## Target

- **Repo:** {{repo}}
- **Primary language:** (detect from repo)
- **Key concerns:** {{concerns}}
- **Key surfaces:** (detect — server, client, API, CLI, library, etc.)

## Agent Decomposition

Launch four parallel agents. Each produces independent findings for its category. Each agent should review every source file in the primary source directories and spot-check secondary areas.

---

### Agent 1: Security

Examine:
- Input validation on all public interfaces (API endpoints, WebSocket handlers, CLI args)
- Auth/authz boundary analysis — are protected resources actually protected?
- Secret handling — hardcoded values, `.env` files committed or referenced unsafely, secrets in logs
- Dependency vulnerabilities — outdated packages, known CVEs, unmaintained dependencies
- Injection surfaces — SQL, NoSQL, command injection, template injection, path traversal
- CORS, CSP, rate limiting configuration — present? correct? restrictive enough?
- Error information leakage — stack traces, internal paths, system info in error responses
- File system access — path traversal risks, unsanitized user input in file operations
- Cryptographic practices — weak algorithms, hardcoded keys/salts, insecure randomness

---

### Agent 2: Maintenance & Code Quality

Examine:
- Dead code and unreachable branches
- TODO/FIXME/HACK comment inventory (list them — they're implicit tech debt acknowledgments)
- Tight coupling between modules that should be independent
- Missing or weak type annotations (especially `any` in TypeScript, untyped function signatures)
- Deprecated API usage — both internal and external
- Inconsistent patterns across modules (different error handling styles, naming conventions, etc.)
- Undocumented magic numbers and strings
- Error handling consistency — are errors caught, logged, and propagated uniformly?
- Code duplication — similar logic in multiple places that should be shared
- Configuration sprawl — settings spread across too many files or formats

---

### Agent 3: Developer Experience

Examine:
- Build and dev loop friction — how long from `git clone` to running? Hot reload working?
- Error message quality — are failures actionable or cryptic?
- Configuration complexity — how many files/env vars does a developer need to understand?
- Naming consistency across the codebase (functions, files, directories, variables)
- Missing convenience scripts or commands (common operations that require multiple steps)
- Onboarding barriers — what would trip up a new contributor?
- README / CLAUDE.md accuracy — does documentation match actual behavior?
- Dev tooling — linting, formatting, pre-commit hooks present and configured?
- Logging quality — is there enough to debug issues? Too much noise?

---

### Agent 4: Testing & Validation

Examine:
- Coverage gaps — untested public functions, endpoints, or critical paths
- Shallow assertions — tests that pass but prove nothing (`expect(result).toBeDefined()`)
- Missing error path and edge case coverage (null, empty, boundary values, malformed input)
- Missing integration/E2E tests for critical flows
- Flaky test patterns — timing dependencies, external service calls, shared state
- Test organization and naming — can you tell what a test covers from its name?
- Test data — hardcoded vs factories/fixtures, realistic vs trivial
- Missing contract tests for API boundaries
- Build/CI pipeline — are tests actually running? On every commit?

---

## Scope Guidance

### Primary (thorough review)
- All source directories (`src/`, `lib/`, `app/`, `server/`, etc.)
- Configuration files (`.env.example`, `config/`, docker-compose, CI pipelines)
- Package manifests (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`, etc.)

### Secondary (review for patterns)
- Build scripts, dev scripts, deployment scripts
- Database migrations and schemas
- Docker/container configuration

### Spot-check only
- Examples, demos, docs
- Generated code (but flag if generation is outdated)
- Test fixtures and mock data

### Skip entirely
- `node_modules/`, `bin/`, `obj/`, `target/`, build output directories
- `.git/`
- Binary files, images, fonts
- Lock files (`package-lock.json`, `yarn.lock`, `Cargo.lock`)

---

## Output Format

Write the report to: {{output_path}}

### Severity Definitions

- **Critical:** Active security vulnerability or data loss risk
- **High:** Significant risk or major quality gap
- **Medium:** Should be addressed but not urgent
- **Low:** Nice to have, minor improvement

### Report Structure

```markdown
# Codebase Audit: {REPO_NAME}
**Date:** {DATE}
**Audited by:** {AGENT} (automated)

## Executive Summary
2-3 paragraphs: overall health assessment, most critical findings,
and general patterns observed.

## Summary Table
| # | Finding | Severity | Category | File(s) | Effort |
|---|---------|----------|----------|---------|--------|
(All findings, sorted by severity descending)

## Critical & High Severity Findings
Detailed writeup of anything rated critical or high.
Each finding: description, evidence (code snippets), impact, recommended fix.

## Security Findings
All security findings with full detail.

## Maintenance & Code Quality Findings
All maintenance findings with full detail.

## Developer Experience Findings
All DX findings with full detail.

## Testing & Validation Findings
All testing findings with full detail.

## Cross-Cutting Observations
Patterns that span multiple categories. Systemic issues.
Architectural observations that don't fit one category.

## Recommended Priority Order
Ordered list of what to fix first and why.
```

### Finding Detail Format

For each finding:
- **ID:** `{CATEGORY}-{NUMBER}` (e.g., SEC-001, MAINT-003, DX-002, TEST-001)
- **Severity:** critical / high / medium / low
- **File(s):** path + line range where applicable
- **Description:** What's wrong and why it matters
- **Evidence:** Relevant code snippet (keep brief)
- **Recommendation:** Specific fix, not generic advice
- **Effort:** quick-fix (< 1 hour) / moderate (1-4 hours) / significant (> 4 hours)

---

## Execution Guardrails

- This is a **read-only** audit. Do not create branches, modify files, or run destructive commands.
- You may run the test suite (`npm test`, `dotnet test`, `cargo test`, etc.) to assess test health.
- You may run linters or static analysis tools if they're already configured in the project.
- You may read `.env.example` but do NOT read `.env` files containing actual secrets.
- If the repo has a CLAUDE.md, read it first for project context.
- If the repo is very large, prioritize depth on server/core code over breadth on everything.

---

## Verification (Independent Observer Test)

An audit is complete when:
1. All four agent categories have produced findings
2. Every finding has an ID, severity, file reference, and specific recommendation
3. The summary table includes all findings sorted by severity
4. The recommended priority order is present and justified

## Execution Feedback

*(Append results from actual audit runs here — what worked, what the template missed, what agents got wrong)*

---
*Operational template — standalone codebase health assessment*
*See also: the `review` skill (for focused PR review), `post-build-verification` (for spec-vs-build checks)*
