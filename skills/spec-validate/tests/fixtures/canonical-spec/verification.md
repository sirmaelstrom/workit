# Verification Criteria — Add a retry budget to the export worker

## Verification Philosophy

Two layers carry this spec: unit tests pin the retry-counting logic in
isolation, and a seam-integration test wires the worker to a fixture storage
client that fails deterministically, proving the budget and the terminal state
behave end to end.

---

## V1: Retries stop at the attempt budget (maps to D1)

**Decision:** Cap retries at a fixed attempt budget of 5.

**Layers:**
- **Unit:** the attempt counter increments once per failure and the loop exits
  when it reaches 5.
- **Seam:** the worker, wired to a fixture storage client that always throws,
  performs exactly 5 `put` attempts and then stops.

**Criteria:**
- A job that fails every attempt is tried exactly 5 times, not 4 and not 6.
- A job that succeeds on attempt 3 is not retried further.

**How to verify:**
`npm test -- retry-budget` — asserts the call count on the fixture storage
client equals 5 for the always-failing case and 3 for the recover-on-third case.

---

## V2: Exhausted jobs reach a terminal failed state with a reason (maps to D2)

**Decision:** Move exhausted jobs to a terminal `failed` state carrying a
`failureReason`.

**Layers:**
- **Unit:** the state transition maps an exhausted budget to status `failed`
  and copies the last error message into `failureReason`.
- **Seam:** after the fixture client exhausts the budget, the persisted job row
  reads `status="failed"` with a non-empty `failureReason`, and the queue slot
  is released.

**Criteria:**
- An exhausted job ends at `status="failed"`, never back at `queued`.
- `failureReason` contains the last underlying error message.
- The freed slot lets the next queued job start.

**How to verify:**
`npm test -- terminal-failure` — reads the persisted job row from the test
database and asserts the status, the reason string, and that the next job drains.

---

## Verification Gaps

- [ ] ⚠️ Backoff timing is not asserted — the budget caps attempts but the delay
  between attempts is left to the existing scheduler tick and is out of scope.
- [x] ✅ The storage seam is covered by the fixture-backed integration test in V1.
