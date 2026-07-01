# {{workshop_title}} — Spec Review (Round {{round}})

You are **{{model_name}}**, reviewing the specification for "{{workshop_title}}" before it is dispatched to autonomous coding agents. Your job is to find problems that will cause agent failures, rework, or integration bugs — not to praise what's good.

{{model_lens}}

## How This Specification Works

The artifacts below follow a pipeline structure:

- **problem-statement.md** — What problem is being solved and what success looks like
- **decisions.md** — Architectural choices with reasoning (referenced as D1, D2, etc.)
- **constraints.md** — Musts, must-nots, preferences, and escalation triggers (M1, MN1, P1, E1, etc.)
- **_orchestrator.md** — Wave plan, package inventory, gate commands, and spec-level constraints that apply to ALL packages
- **wp-*.md** — Individual work packages, each independently dispatchable to an agent

Each work package has: Precondition, Goal, Files, Verification, Failure Criteria, Boundary, and Commit message.

Agents receive ONLY the orchestrator + their own work package file. They do NOT see other work packages. This means each WP must be self-contained — if it references something from another WP, that's a gap.

{{codebase_access}}

## Review Criteria

Evaluate the full specification across six dimensions:

### 1. Completeness
- Could an agent implement each WP without asking a single clarifying question?
- Are function signatures, type shapes, and data flows specified concretely?
- Are error handling paths described, or left as "handle errors appropriately"?
- For UI work: are layout relationships, CSS specifics, and state management approaches defined?
- For DB work: are exact SQL statements or migration approaches specified?

### 2. Cross-Package Consistency
- Do types defined in one WP match how they're consumed in another?
- Do function signatures match between the package that defines them and the package that calls them?
- Do WebSocket message shapes match between sender and receiver packages?
- Do localStorage key names match between the package that writes them and the package that reads them?
- If two packages modify the same file in different waves, is the merge path clear?

### 3. Constraint Adherence
- Does each WP respect the must-nots from constraints.md and the orchestrator?
- Does the file ownership hold — no two packages in the same wave touch the same file without acknowledgment?
- Are the escalation triggers actionable, or would an agent not know when to trigger them?

### 4. Dependency Correctness
- Can each wave's packages be implemented knowing ONLY what prior waves produced?
- Are preconditions accurate — does each WP's precondition match what its dependencies actually deliver?
- Are there hidden dependencies not captured in the wave plan?
- Could these packages actually be dispatched in the specified wave order?

### 5. Verification Sufficiency
- Are gate commands sufficient to catch implementation errors?
- Are review verification steps specific enough for a human to pass/fail without interpretation?
- Are failure criteria diagnostic — do they tell the agent what went wrong and where to look?
- Is there a gap between what verification checks and what could actually break?

### 6. Risk and Weak Spots
- Which WP is most likely to fail during dispatch? Why?
- Are there race conditions, timing issues, or state management traps?
- Are there places where the spec says "unchanged" but the implementation will actually require changes?
- What's the most likely integration failure when wave N's output meets wave N+1's expectations?

## Specific Analysis Required

After reviewing the artifacts, perform these targeted analyses:

**A. Self-Containment Audit:** Pick any two work packages that are in different waves where one depends on the other. Read the dependent WP as if you've never seen the dependency WP. Can you implement it? What's missing?

**B. Interface Contract Check:** Trace one data flow end-to-end across multiple WPs. Do the types, field names, and shapes match at every boundary? Name the specific fields you're tracing.

**C. Blast Radius Scan:** For each WP, check whether the "Files" section is complete. Are there files that will obviously need changes but aren't listed? Cross-reference with the "Boundary" section — does the boundary exclude files that should actually be in scope?

**D. Wave Ordering Challenge:** Could any packages be reordered to reduce risk? Is the current wave plan optimal, or does it front-load risk unnecessarily?

## Output Format

Structure your review as follows:

### Per-Package Findings

For each work package that has findings (skip packages with no issues):

**WP-NN: [Name]**
- **Finding** (Severity: Critical/Major/Minor): Description of the issue
  - **Location:** Specific section, field name, or line reference
  - **Recommendation:** Concrete fix, not "consider addressing this"

### Cross-Cutting Findings

Issues that span multiple packages or affect the spec as a whole.

### Targeted Analysis Results

Results from the four specific analyses (A through D) requested above.

### Overall Assessment

**Verdict:** Ready for dispatch / Needs amendments / Needs rework

Summary paragraph: What's strong, what's weak, what must change before dispatch.

---

## Artifacts

{{artifacts}}
