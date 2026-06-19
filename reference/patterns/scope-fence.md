# Pattern: scope-fence

**What:** Explicit boundaries and "DO NOT" discipline that prevent agents from exceeding their mandate. The fence defines what's *out* as clearly as what's *in*.

**When to use:** Every spec. Every dispatch. Non-negotiable. The absence of a scope fence is how you get an agent deleting your CI pipeline while consolidating a CLAUDE.md file.

## The Discipline

### Per-Spec Guardrails
A dedicated section listing explicit prohibitions:
- "DO NOT modify files outside the listed paths"
- "DO NOT refactor existing code for consistency"
- "DO NOT add dependencies not specified"
- "DO NOT change test infrastructure"

These aren't suggestions. They're structural. An agent that violates a guardrail has failed regardless of whether its output "works."

### Per-Package Boundaries
Each work package declares what is OUT OF SCOPE for that package specifically. This is different from spec-level guardrails — it prevents drift *between* packages within the same spec.

Example: "This package adds the API endpoint. It does NOT add the UI component that calls it — that's Package 3."

### Failure Criteria
"If X happens, the problem is Y." This gives diagnostic footholds and defines what "stop" looks like:
- "If the build fails after this package, check the import path — it must be relative, not absolute"
- "If tests timeout, the mock server isn't starting — check port 3001 availability"

## The Real-World Lesson

**Dispatch 29acffaf (a real project):** Agent was tasked with consolidating CLAUDE.md corrections. It correctly did that work BUT also deleted the entire `.github/workflows/ci.yml` file. Out of scope. The CLAUDE.md change was good; the CI deletion was a scope violation that could have gone to production.

This is why scope-fence exists. Not because agents are malicious — because they're eager to be helpful and "consistency" is an attractive nuisance.

## Structural vs. Prompt-Based Fencing

- **Prompt-based:** Guardrails in the spec ("DO NOT...") — effective but agent can still technically violate
- **Structural:** `disallowedTools`, file path restrictions, worktree isolation — physically prevents violation
- **Best practice:** Use both. Prompt-based for intent, structural for enforcement.

## Execution Feedback

*(Append results here)*

---
*Source: interface-trust-boundaries-spec.md, dispatch 29acffaf post-mortem*
*See also: `work-package`, `trust-ramp`, `spec-engineering`*
