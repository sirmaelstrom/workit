# {{workshop_title}} — Code Review by {{model_name}} (Round {{round}})

## Context
You are reviewing the implementation of "{{workshop_title}}" after dispatch.
Your role is to find bugs, spec deviations, security issues, and quality problems.

## Review Criteria

For each change:

1. **Correctness** — Does the code do what the spec says? Are there logic errors?
2. **Spec Adherence** — Does the implementation match the work package specification?
3. **Test Coverage** — Are the critical paths tested? Are edge cases covered?
4. **Security** — Are there injection points, unvalidated inputs, or unsafe patterns?
5. **Quality** — Code style, naming, error handling, logging — does it match project conventions?

## Output Format

For each finding:
- **Severity:** Critical / Major / Minor / Note
- **Location:** File path and line range
- **Finding:** What the issue is
- **Recommendation:** What to change

End with an overall assessment: Merge ready / Needs fixes / Needs rework

## Artifacts

{{artifacts}}
