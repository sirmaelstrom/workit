# Constraints — Add a retry budget to the export worker

## Musts (M)

- **M1 — Keep the public `run()` signature unchanged.** Callers depend on it; the
  retry budget is internal behavior, not a new parameter.
- **M2 — Make the attempt cap a named constant.** A magic `5` buried in the loop
  is the kind of value that drifts; name it `MAX_ATTEMPTS` so tests and code agree.

## Must-Nots (MN)

- **MN1 — Do NOT introduce a new queue or dead-letter table.** D2 keeps the
  failure on the existing job row; new infrastructure is out of scope.
- **MN2 — Do NOT swallow the underlying error.** The last error message must reach
  `failureReason`; a bare `catch {}` defeats the whole point of the change.

## Preferences (P)

- **P1 — Prefer extending the existing loop** over rewriting the worker around a
  retry library. The change is small; a dependency would dwarf it.

## Escalation Triggers (E)

- **E1 — Escalate if `storage.put()` is called from more than one site.** The
  budget assumes a single call path; a second caller changes the design.
