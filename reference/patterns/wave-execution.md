# Pattern: wave-execution

**What:** Execute work packages in parallel waves by analyzing the dependency graph. Minimize wall-clock time by running independent work concurrently.

**When to use:** Any spec with 3+ work packages. Even specs that look sequential often have hidden parallelism.

## The Process

1. **Map dependencies** — For each work package, identify what it actually depends on (read preconditions carefully — they may reveal independence that the ordering obscures).
2. **Build the wave plan** — Group packages into waves where everything in a wave can run simultaneously.
3. **Visualize** — Mermaid dependency graph showing waves. Helps catch missed parallelism and hidden dependencies.
4. **Execute** — Launch wave 1 agents in parallel. Wait for completion. Launch wave 2. Repeat.

## Example: 6-Package Spec → 3 Waves

```
Wave 1 (parallel):  [Schema] [CLI Extension] [Prompt Template]
Wave 2 (sequential): [Worktree + Runner] (depends on Schema + CLI)
Wave 3 (parallel):  [Notification] [Bridge Integration] (depend on Runner)
```

Wall-clock: 3 waves instead of 6 sequential steps. ~50% time reduction.

## Key Insight

**Read preconditions, not just ordering.** The spec may list packages 1-6 in order, but Package 2's precondition might say "Unit 1 is not required." That's a parallelization opportunity hiding in plain text.

## When Agents Share a Repo

If parallel agents work in the same repo (no worktree isolation), they must touch **disjoint files**. The work-package `Files` field makes this verifiable before launch. If two packages in the same wave touch the same file, they can't parallelize — reorder or merge them.

## Real Result

Phase 1 Dispatch MVP: 6 packages, 3 waves, ~6 min wall-clock. All 6 agents compiled on first try despite no worktree isolation (disjoint files).

## Dispatch Ordering Within Waves (Fixed 2026-03-01)

**Previously:** Same-project dispatch ordering was non-deterministic — `ORDER BY id` on `randomUUID()` primary keys meant execution order was effectively random. Bridge-decomposition had same-project ordering constraints in Wave 3 that worked by UUID accident.

**Fix:** Added `sequence INTEGER` column to `campaign_dispatches`, populated from array index at insertion time. All `ORDER BY id` queries changed to `ORDER BY sequence`. Insertion order now equals execution order.

**Files changed:** `pg.ts` (migration), `types.ts` + `campaign-db.ts` (type/mapping), `campaign-runner.ts` (insert + 3 queries).

## Gate Command Discipline (Added 2026-03-03)

**Gate commands must NOT contain absolute `cd` paths.** The campaign runner creates a temporary worktree from the integration branch and sets `cwd` to it. If the gate command includes `cd /absolute/project/path && ...`, it escapes the worktree back to the main project directory (on `master`), where new files from the campaign branch don't exist.

**Correct:** `npx tsc --noEmit && npx vitest run src/dispatch/queue.test.ts`
**Wrong:** `cd ~/projects/your-project && npx tsc --noEmit && npx vitest run src/dispatch/queue.test.ts`

The runner handles per-project cwd. Gate commands are just the verification commands.

**War story:** dispatch-lifecycle-cleanup campaign (2026-03-03). Both WP-01 and WP-02 completed successfully, `queue.test.ts` was created on the campaign branch and passes. But the gate command had `cd ~/projects/your-project &&` which jumped to master where the test file doesn't exist. Vitest reported "No test files found" → gate failed → two fix attempts produced zero commits (zombie pattern — agents couldn't find anything to fix because the code was correct). Campaign paused after exhausting fix attempts.

## Execution Feedback

**2026-03-01 — bridge-decomposition:** 18 WPs across 5 waves, 2h23m. All 354 tests passed at every gate. 3/4 stops were merge infrastructure, not agent quality. Parallel dispatch within waves worked cleanly — zero merge conflicts between concurrent dispatches. See workshop post-mortem for full details.

---
*Source: phase1-dispatch-mvp-spec.md execution results*
*Pipeline: ← `decomposition`, `work-package` | → `wave-review`*
*See also: `meta-prompt`, `spec-engineering`*
