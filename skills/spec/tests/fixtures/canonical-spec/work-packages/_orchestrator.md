# Orchestrator — Add a retry budget to the export worker

2 packages, 2 waves, 1 project (example-service).

## Wave Plan

Wave 1: [WP-01: Bounded retry loop]
Wave 2: [WP-02: Terminal failed state]

### Wave rationale

- **Wave 1** — establish the attempt counter and the bounded exit in isolation.
- **Wave 2** — depends on Wave 1's exit; adds the terminal state and slot release.

## Gate Commands

Wave 1: npm test
Wave 2: npm test

## Package Inventory

| Package | Wave | Project | Spec | Model |
|---------|------|---------|------|-------|
| WP-01: Bounded retry loop | 1 | example-service | [wp-01-retry-loop.md](wp-01-retry-loop.md) | - |
| WP-02: Terminal failed state | 2 | example-service | [wp-02-terminal-state.md](wp-02-terminal-state.md) | - |

## Spec-Level Constraints

### Musts

1. Keep the public `run()` signature unchanged — the budget is internal behavior.
2. Make the attempt cap a named constant (`MAX_ATTEMPTS`), not a magic number.

### Must-Nots

1. DO NOT introduce a new queue or dead-letter table.
2. DO NOT swallow the underlying error — it must reach `failureReason`.

### Escalation Triggers

1. Escalate if `storage.put()` is called from more than one site.

## Progress Log

<!-- Progress entries will be appended below by execution agents -->

## Risk Assessment

**Primary risk:** an off-by-one in the WP-01 exit condition would let a job run
4 or 6 attempts instead of 5.

**Mitigation:** V1's seam test pins the exact call count before WP-02 builds on it.
