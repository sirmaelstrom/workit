# WP-01: Bounded retry loop

`execution: autonomous`

**Precondition:** None — this is the first package. The export worker's
`run()` currently retries on failure inside a `while (true)` loop.

**Goal:** Replace the unbounded loop with a counter that stops after
`MAX_ATTEMPTS` (5) failed attempts and surfaces the last error to the caller of
the loop.

**Files:**
- Modify `src/exportWorker.ts` — add the `MAX_ATTEMPTS` constant and the
  attempt counter; exit the loop when the budget is exhausted.
- Create `src/exportWorker.retry-budget.test.ts` — unit + seam tests for the
  attempt count.

**Verification:** `npm test -- retry-budget` exits 0. The always-failing fixture
client records exactly 5 `put` calls; the recover-on-third fixture records 3.
The cap is read from the named `MAX_ATTEMPTS` constant, not a literal in the
loop (M2) — grep the loop body for a bare `5` and expect no hit.

**Failure Criteria:** If the call count is 4 or 6, the off-by-one is in the
loop's exit condition (counter checked before vs. after the attempt). If the
test hangs, the loop has no exit path and the budget constant is not wired in.

**Boundary:** Counting and exiting only. The terminal `failed` state, the
`failureReason` field, and the queue-slot release are WP-02 — do not touch
persistence here. The public `run()` signature stays exactly as it is (M1): the
budget is internal behavior, so no new parameter and no changed return shape.
Stop and escalate if `storage.put()` turns out to be called from more than one
site (E1) — the budget assumes a single call path, and a second caller changes
the design rather than the implementation.

**Commit:** `feat(export): cap retries at MAX_ATTEMPTS`
