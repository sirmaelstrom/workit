# Constraints — broken negative-control fixture

This fixture intentionally declares ONLY the Musts category. The validator must
still report the three missing categories — proving the relaxed category
detection (which no longer requires a descriptive suffix on the header) did not
become vacuous.

## Musts (M)

- **M1 — Some non-negotiable requirement.** Present so the Musts category is
  detected and the numbered-constraint check passes for this category.
