# Problem Statement — Add a retry budget to the export worker

## What We're Solving

The export worker (a backend service in `example-service`) turns user report
requests into downloadable files. When a downstream storage call fails, the
worker retries forever with no ceiling, so a single broken upload pins a queue
slot indefinitely and starves every other report behind it. Operators have no
way to tell a transient blip from a permanent failure, and the only recovery is
a manual process restart. We need a bounded retry policy that gives up after a
known number of attempts and records why it gave up.

## Current State

`exportWorker.run()` calls `storage.put()` inside a `while (true)` loop and
re-enters on any thrown error. There is no attempt counter, no backoff, and no
terminal failure state — a failed job is simply retried on the next tick, which
is why a poison job blocks the queue.

## What "Solved" Looks Like

A job that hits a permanent error stops after a bounded number of attempts,
moves to a `failed` state with a recorded reason, and frees its queue slot so
healthy jobs drain. Transient errors still recover within the budget. An
operator can read the failure reason without attaching a debugger.

## What's Actually Broken

### 1. Unbounded retries

The `while (true)` loop has no exit on repeated failure, so one bad job holds
its slot forever and blocks the rest of the queue.

### 2. No terminal failure signal

A job that can never succeed never reaches a `failed` state, so nothing surfaces
the reason and operators restart the process blind.
