---
name: execute-wp
description: "Execute a work package from a spec. Trigger: 'execute WP-01', 'run wp', 'execute wp', or referencing a specific work package. READ THE FULL SKILL — the execution lifecycle (read orchestrator → execute → append progress log) is defined below."
---

# Execute WP — Work Package Execution with Progress Log

Execute a single work package from a workshop specification. Handles the full lifecycle: read orchestrator context, read progress log, execute the work, append a progress entry. The progress log is what makes later packages smarter than earlier ones — this skill makes that lifecycle automatic.

## Why This Skill Exists

The progress log pattern (in `_orchestrator.md`) gives multi-package execution institutional memory. Each execution agent reads what came before and records what it did. But relying on agents to remember this lifecycle is fragile — they skip the read, forget the append, or write entries that don't follow the format. This skill makes the lifecycle structural.

## Prerequisites

Before executing a work package, you need:
1. A workshop at `./outputs/workshops/{slug}/` (or `.archive/{slug}/`) with status `ready`
2. An orchestrator at `work-packages/_orchestrator.md`
3. The specific work package file (e.g., `work-packages/wp-01-types.md`)

If the orchestrator doesn't have a `## Progress Log` section (older workshops), add one before the first entry — append it after the last existing section (typically Risk Assessment or Dispatch Notes). Use the format from `_orchestrator.template.md` in the heathdev-patterns pattern library.

## The Execution Lifecycle

### Step 1: Identify the Work Package

Determine which WP to execute. The user might:
- Name it directly: "execute WP-03" or "run wp-01-types"
- Reference it by workshop: "execute the first package from persistent-session-context"
- Have it in viewport context (workshop or files view)

Locate the workshop directory and the specific WP file.

### Step 2: Read the Orchestrator

Read `work-packages/_orchestrator.md` in full. Extract:

1. **Spec-level constraints** — Musts, Must-Nots, Preferences, Escalation Triggers. These apply to ALL packages. Internalize them before touching code.

2. **Dependency context** — What other packages exist? Which ones must complete before this one? Which are independent (could run in parallel — avoid file conflicts)?

3. **Progress Log entries** — Read every existing entry. This is context from prior executions:
   - What did earlier packages change?
   - What surprises did they encounter?
   - What notes did they leave for downstream packages?
   - Did any prior package flag something relevant to this WP?

   If the progress log is empty (this is the first package), note that — no prior context to absorb.

4. **Verification commands** — What verification will run after execution? Make sure your work will pass it.

### Step 3: Read the Work Package

Read the WP file itself. It's self-contained by design — you should be able to execute from the orchestrator + this file alone.

Parse the 6 required fields:
- **Precondition** — Is this met? If it references prior packages, check the progress log for confirmation. If the precondition isn't met, STOP and tell the user.
- **Goal** — The single outcome this package produces.
- **Files** — Exact paths to create, modify, or delete. Touch nothing else.
- **Verification** — The concrete check proving it works.
- **Failure Criteria** — Diagnostic footholds if things go wrong.
- **Boundary** — What's explicitly out of scope. Respect this.

Also read any Implementation section for detailed guidance (code snippets, API shapes, component structure).

### Step 4: Execute the Work

Do the work specified in the package. Key principles:

- **Stay within the Files list.** If you discover you need to modify a file not listed, check if it falls under an escalation trigger. If so, stop and report. If the file is clearly adjacent and the change is trivial (e.g., an import), use judgment but document it in the progress entry.

- **Respect Must-Nots.** These are the most common source of wasted executions. Re-read them before committing anything.

- **Follow Preferences.** When you have a choice between approaches, check if the orchestrator's preferences section has guidance.

- **Run verification as you go.** Don't wait until the end. If the WP specifies `npx tsc --noEmit`, run it after significant changes to catch issues early.

- **If you hit a Failure Criteria condition,** diagnose using the provided footholds before trying to fix. Document what happened.

- **If you hit an Escalation Trigger,** STOP. Report what you found, why it triggers the escalation, and what decision you need from the user. Do not proceed past the trigger.

### Step 5: Run Final Verification

Run the verification command(s) specified in the work package. Then run any orchestrator-level verification commands. Both must pass.

If verification fails:
1. Check the failure criteria for diagnostic guidance
2. Fix the issue
3. Re-run verification
4. If you can't fix it, document the failure in the progress entry (outcome: `partial` or `failed`)

### Step 6: Append Progress Entry

**This step is mandatory.** Before finishing, append a progress entry to the `## Progress Log` section of `_orchestrator.md`.

Format (from the work-package pattern):

```markdown
### WP-{NN}: {Name} -- {YYYY-MM-DD}
**Outcome:** {success | partial | failed}
**What changed:** {brief summary of files modified and why}
**Surprises:** {anything unexpected -- edge cases found, assumptions that were wrong, patterns worth noting}
**Notes for downstream:** {anything later packages should know -- e.g., "the API shape changed from what the orchestrator assumed" or "test helper at X is useful for similar work"}
```

Guidelines for the entry:
- **Outcome** must be honest. `partial` means some goals met but not all. `failed` means the core goal wasn't achieved.
- **What changed** should be scannable — a reader should understand the diff in 2-3 sentences without reading the diff.
- **Surprises** is the most valuable field for later packages. If something was different than expected, say so. If everything went smoothly, say "None — implementation matched the spec."
- **Notes for downstream** should be specific. Not "be careful with X" but "the `UserStore` interface now has a `lastSync` field that WP-04 should use for its cache invalidation check."

### Step 7: Create the Commit

If the work package includes a Commit field, use that message. Otherwise, compose a conventional commit message that summarizes the package's contribution.

Stage only the files listed in the work package (plus any documented additions from Step 4). Do NOT stage unrelated changes.

## Error Recovery

If execution partially fails:
1. Complete what you can
2. Document what failed and why in the progress entry (outcome: `partial`)
3. Note what a retry would need to address in "Notes for downstream"
4. Still append the progress entry — failed attempts are valuable context for retries

## Multi-Package Execution

If the user asks to execute multiple independent packages:
- Read the orchestrator once, absorb all shared context
- Execute each package independently
- Each gets its own progress entry
- Run orchestrator-level verification after ALL packages complete

For packages with dependencies — execute prerequisite packages first, verify, then proceed to dependent packages.

<supporting_info>

## Relationship to Other Skills

- **`/workshop`** and **`/spec`** create the spec artifacts that this skill executes against
- **`/spec-validate`** checks artifact quality before execution — run it first if you're unsure about spec quality

</supporting_info>
