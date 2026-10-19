# Verification — broken negative-control fixture

This fixture has a numbered criterion but declares no verification strength at
all — no layered coverage and no flat type label. The validator must still warn
that strength is missing, proving the relaxed check (which now credits the
layered model when present) did not stop firing when nothing is declared. The
token names are intentionally not written here, so the check can only pass by
genuinely finding nothing.

## V1: A criterion with no strength declared

The implementation produces the documented output for the documented input.
