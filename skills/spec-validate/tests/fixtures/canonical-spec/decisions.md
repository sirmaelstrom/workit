# Decisions — Add a retry budget to the export worker

## D1: Cap retries at a fixed attempt budget

**Options:** (a) fixed attempt count, (b) wall-clock deadline, (c) hybrid of both.

**Choice:** Fixed attempt count of 5.

**Why:** Attempt count is the simplest unit to reason about and to assert in a
unit test. A wall-clock deadline couples the policy to job duration, which
varies widely across report sizes; the hybrid adds configuration surface we do
not need yet. Five attempts covers the observed transient-blip recovery window.

## D2: Move exhausted jobs to a terminal `failed` state with a reason

**Options:** (a) re-enqueue to a dead-letter queue, (b) terminal `failed` state
on the existing job row, (c) drop the job silently.

**Choice:** Terminal `failed` state on the existing job row, carrying a
`failureReason` string.

**Why:** The job row already exists and is what operators inspect, so recording
the reason there is the shortest path to making the failure legible. A
dead-letter queue is more infrastructure than the current volume warrants;
dropping silently reproduces the invisibility this spec exists to fix.
