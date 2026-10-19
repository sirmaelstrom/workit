# WP-01: Missing one required field

This work package deliberately provides only five of the six required fields —
the out-of-scope field is omitted. The validator must still report it as
missing, proving the relaxed work-package field check (which now also accepts the
colon-inside form) did not become vacuous. Note: the omitted field's name is not
written anywhere in this file in bold or as a heading, so the only way it can be
flagged is by the field check actually running.

**Precondition:** None.

**Goal:** Demonstrate a missing required field.

**Files:**
- Modify `src/example.ts`.

**Verification:** `npm test` exits 0.

**Failure Criteria:** If the validator reports all six fields present, the field
check has regressed.
