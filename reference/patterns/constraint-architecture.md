# Pattern: constraint-architecture

**What:** The four-category system that turns a loose specification into a reliable one. Constraints define the *shape of the solution space* — what's required, what's forbidden, what's preferred, and what exceeds the agent's authority.

**When to use:** Every spec. This replaces `scope-fence` with a more complete model. Scope-fence covered must-nots well but ignored three other categories that matter just as much.

**Supersedes:** `scope-fence` (which covered ~40% of this pattern)

## The Four Categories

### 1. Musts — Non-Negotiable Requirements
Things that must be true in any valid solution. These are constraints, not goals — they apply *across* the entire spec, not to individual packages.

Examples:
- "All new code must have TypeScript types — no `any`"
- "Database queries must use parameterized statements"
- "UI components must follow the existing DaisyUI pattern in the project"
- "All API responses must include appropriate error codes, not just 500"

Musts are different from work package Goals. A goal says "build the login endpoint." A must says "every endpoint in this spec must validate input before processing." Goals are local to a package. Musts are global to the spec.

### 2. Must-Nots — Explicit Prohibitions
Things the agent is forbidden from doing. This is the "DO NOT" discipline from the original `scope-fence` pattern — still critical, now properly categorized.

Examples:
- "DO NOT modify files outside the listed paths"
- "DO NOT refactor existing code for consistency"
- "DO NOT add dependencies not specified in this spec"
- "DO NOT change test infrastructure or CI configuration"
- "DO NOT delete files unless explicitly instructed"

**The war story:** Dispatch 29acffaf — agent tasked with consolidating CLAUDE.md corrections also deleted `.github/workflows/ci.yml`. Out of scope. The CLAUDE.md change was good; the CI deletion was a scope violation. A must-not ("DO NOT modify CI/CD configuration") would have prevented this.

### 3. Preferences — Guidance for Ambiguous Situations
When multiple valid approaches exist, which should the agent choose? Without stated preferences, the agent guesses — and guesses diverge from your intent in ways that are subtle and expensive to fix.

Examples:
- "When choosing between a new utility function and an inline implementation, prefer inline for single-use cases"
- "For error messages, prefer user-facing clarity over technical precision"
- "When a component could be split or kept monolithic, prefer split only if both halves have independent test value"
- "For state management, prefer reactive stores over prop drilling"

Preferences are weaker than musts — an agent can deviate if it has a good reason and documents why. But they eliminate the most common source of "technically correct, not what I wanted" output.

### 4. Escalation Triggers — When to Stop and Ask
Situations where the agent should halt and come back to the human rather than making a decision autonomously. This is distinct from failure criteria (which say "if X, the problem is Y") — escalation triggers say "if X, I need a human decision before proceeding."

Examples:
- "If implementing this feature requires changing the database schema beyond what's specified, escalate"
- "If you discover a security concern in existing code, document it and escalate — don't fix it in this dispatch"
- "If the existing API contract would need to change to support this feature, escalate"
- "If test coverage for the affected area is below 50%, escalate before adding untested complexity"
- "If the work would require touching more than 2 files not listed in the spec, escalate"

Escalation triggers are the mechanism that makes `trust-ramp` possible at the spec level. The agent earns trust on work within boundaries; it demonstrates judgment by recognizing when it's outside them.

## Structural vs. Prompt-Based Constraints

Both layers matter:

- **Prompt-based:** The four categories above, written into the spec. Effective but the agent can technically violate them.
- **Structural:** `disallowedTools`, file path restrictions, worktree isolation, managed-write directories. Physically prevents violation.

Best practice: Use prompt-based constraints for intent and nuance. Use structural constraints for hard safety boundaries. They're complementary, not alternatives.

## Building Constraint Architecture

When writing constraints, use this exercise:

> Imagine a smart, well-intentioned person who has read only this spec. What might they do that technically satisfies every requirement but produces the wrong outcome?

Those failure modes are your constraints. Each one maps to one of the four categories:
- They should have done X → add a **must**
- They did Y which broke things → add a **must-not**
- They chose approach A when B would have been better → add a **preference**
- They made a judgment call that should have been yours → add an **escalation trigger**

## Per-Spec vs. Per-Package

- **Musts, must-nots, preferences** typically live at spec level (apply to all packages)
- **Escalation triggers** can be spec-level or package-level depending on scope
- Each work package still has its own **Boundary** field (what's out of scope for *that* package specifically) — this complements but doesn't replace spec-level constraints

## Derived Constraint: Consumer Audit on Data Structure Changes

When a WP changes a data structure (type, payload shape, schema), the spec MUST trace all read paths — not just the write path. Add this as a standard must in any orchestrator where WPs modify shared data structures:

> "When a work package changes the shape of a persisted or transmitted data structure, the spec must enumerate all consumers of that structure and either (a) update them within the same WP, or (b) explicitly note that a separate WP handles the consumer update."

**War story (a session-continuity campaign review):** WP-05 changed the handoff payload from `{warm_context, active_threads, ...}` to `{summary, session_id, ...}`. Two consumers read the old structure: `ledgerContext()` (reads `payload.warm_context` for cross-interface display) and `sanitizeEntry()` (truncates `payload.warm_context` to 1000 chars). Neither was in any WP's scope. Cross-interface awareness would have silently broken — the agent stops seeing what happened in one interface while in a web-frontend session, no error, no log. The review caught it; a consumer audit constraint in the orchestrator would have caught it at spec time.

**Pattern:** Data structure changes without consumer audits are the "off-by-one error" of multi-WP specs. The write path is obvious; the read paths are not.

## Derived Constraint: "Extend Existing" Requires "Verify Existing Behavior"

When a must or work package says "extend" an existing system (add a new tab, add a new context type, add parameters to an existing SP), the constraint architecture MUST pair it with a verification step for existing behavior.

> "When a work package extends existing infrastructure, the spec must include a verification step that confirms pre-existing behavior is unchanged after the extension. The verification step should name the specific existing paths to test."

**War story (a real ticket, Finding 2):** MN3 said "DO NOT change existing drilldown behavior for Summary/Fleet." The agent extended `openDrilldown()` in common.js to support the new Human tab but inadvertently changed how Fleet drilldown parameters were assembled. The must-not was correctly specified, but no verification step existed — the agent had no mechanism to confirm existing paths still worked. A verification step like "After modifying openDrilldown(), verify that Fleet questionCategory drilldown still passes the display name (not encrypted key)" would have caught this before manual testing.

**Pattern:** "Don't break existing behavior" is a must-not. But must-nots without verification mechanisms are aspirational, not enforceable. Pair every "extend existing" must with a concrete "verify existing" check that names the specific paths, inputs, and expected outputs.

## Derived Constraint: Event Chain Tracing on Behavioral Changes

When a WP modifies a module that emits events or is consumed by listeners, the spec MUST trace the event chain — not just the direct change.

> "When a work package modifies a module that emits events, triggers hooks, or is read by downstream consumers, the spec must enumerate the event chain: what fires, what listens, what state changes cascade. If any cascading change touches modules outside the WP's scope, either (a) expand scope to include them, or (b) add a verification step confirming no behavioral regression."

**Rationale:** Direct file changes are visible in diffs. Event-driven side effects are not. A change to `handler.ts` that alters when `task.completed` fires can silently break `metrics.ts`, `notification.ts`, and `cache.ts` without touching any of those files. This is the event-chain equivalent of the consumer audit constraint — but for behavioral coupling, not data structure coupling.

**Relationship to `decision-resolution`:** The Change Cascade Analysis in `decision-resolution` catches this during approach selection. This constraint ensures it's also checked during work package specification, after the approach is chosen.

## Execution Feedback

*(Append results here)*

---
*Source: scope-fence pattern (superseded), interface-trust-boundaries-spec.md, dispatch 29acffaf post-mortem*
*Four-category model influenced by: Nate B. Jones specification primitives (constraint architecture)*
*Pipeline: ← `verification-criteria` | → `decomposition`, `work-package`*
*See also: `trust-ramp`, `spec-engineering`, `problem-statement`, `verification-criteria`*
