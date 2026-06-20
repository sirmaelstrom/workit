# WP-02: Terminal failed state

`execution: autonomous`

**Precondition:** WP-01 is complete — the retry loop exits after `MAX_ATTEMPTS`
and surfaces the last error. The job row has a `status` column and an unused
`failureReason` column.

**Goal:** When the retry budget is exhausted, move the job to `status="failed"`,
copy the last error message into `failureReason`, and release the queue slot so
the next job drains.

**Files:**
- Modify `src/exportWorker.ts` — on budget exhaustion, write the terminal state
  and call the existing `queue.release(jobId)`.
- Create `src/exportWorker.terminal-failure.test.ts` — seam test reading the
  persisted job row from the test database.

**Verification:** `npm test -- terminal-failure` exits 0. After the fixture
client exhausts the budget, the persisted row reads `status="failed"` with a
non-empty `failureReason`, and the next queued job starts.

**Failure Criteria:** If the row reads `status="queued"`, the terminal write
never ran — the exit path from WP-01 is not reaching the state transition. If
`failureReason` is empty, the error is being swallowed before it is recorded
(MN2 violation).

**Boundary:** Terminal state, reason capture, and slot release only. Do not add
a dead-letter queue or a new table (MN1), and do not change the attempt count
established in WP-01.

**Commit:** `feat(export): mark exhausted jobs failed with a reason`
