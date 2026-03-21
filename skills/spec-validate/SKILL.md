---
name: spec-validate
description: "Validate workshop artifacts against the heathdev-patterns methodology. Use this skill when the user asks to validate a workshop, check spec quality, audit a workshop's artifacts, run the validation checklist, or asks 'is this workshop ready?' Also trigger when the user says 'spec-validate', 'validate spec', 'check workshop', or references spec quality before dispatch."
---

# Spec Validate — Workshop Artifact Validation

Run the heathdev-patterns validation checklist against a workshop directory. Produces a report with errors and warnings where every message teaches — not just reports.

## How It Works

This skill bundles a validation script at `scripts/validate.mjs` that performs deterministic checks against workshop artifacts. The script handles:

- **Structural completeness** — are expected sections present in each artifact?
- **Decision ambiguity scanning** — flag words ("or", "possibly", "TBD", "might", "should consider") in non-constraint contexts
- **Vague verification detection** — phrases like "should work", "looks good", "functions properly" that aren't actually verifiable
- **Constraint completeness** — all four categories present (musts, must-nots, preferences, escalation triggers)
- **Work package field coverage** — all 6 required fields (precondition, goal, files, verification, failure criteria, boundary)
- **Pipeline consistency** — meta.json status matches which artifacts actually exist

## Running Validation

### Step 1: Identify the workshop

Determine which workshop to validate. The user might:
- Name it directly: "validate portable-spec-cli"
- Reference the current focus from viewport context
- Ask to validate all workshops

Workshops live at `/workspace\data\outputs\workshops\{slug}\`.

### Step 2: Run the script

```bash
node <skill-path>/scripts/validate.mjs <workshop-path>
```

The script exits 0 if no errors (warnings are OK), exits 1 if any errors found.

### Step 3: Interpret and present results

The script produces a terminal-style report. Present it to the user, then add your own analysis:

- **False positives:** The ambiguity scanner uses regex, not semantic analysis. "or" in "create or modify" is fine English, not an unresolved decision. Similarly, quoted examples or references to validation rules themselves may trigger vague-verification detection. Call out any false positives you spot.

- **Severity context:** Not all warnings are equal. A missing "Escalation Triggers" section in a 2-WP workshop is less concerning than missing "Must-Nots" in a 10-WP campaign. Use judgment about what matters given the workshop's scope and stage.

- **Actionable next steps:** For each error or significant warning, suggest the specific fix. Don't just say "add verification type" — say "each V-criterion needs a **Verification type:** line. For V3, which is about API response format, an automated test is the strongest choice."

### Batch validation

To validate all workshops at once:

```bash
for dir in /workspace/data/outputs/workshops/*/; do
  node <skill-path>/scripts/validate.mjs "$dir" 2>&1
  echo ""
done
```

## What the Script Checks

### meta.json
- Required fields: title, slug, status
- slug matches directory name
- projects is an array (not a singular string)
- Lifecycle timestamps present (startedAt, createdAt)

### problem-statement.md
- Template sections present (What We're Solving, Current State, What "Solved" Looks Like, What's Actually Broken)
- Minimum word count (< 100 words triggers a warning — unlikely to pass self-containment test)
- Unfilled template placeholders (`{...}`)

### decisions.md
- Numbered decisions (D1, D2...) present
- Ambiguity flag word scan (skips "Rejected alternatives" sections)
- Each decision has documented reasoning (Why/Reason/Choice field)

### verification.md
- Numbered criteria (V1, V2...) mapping to decisions
- Verification type field present
- Vague verification phrase scan (errors, not warnings — these are showstoppers)
- "How to verify" sections present

### constraints.md
- All four categories present: Musts, Must-Nots, Preferences, Escalation Triggers
- Numbered constraints (M1, MN1, P1, E1)

### decomposition.md
- Break pattern identified
- Numbered work units (WP-1, WP-2...)
- Decomposition test evidence (< 2hrs, independently verifiable, disjoint files)

### work-packages/
- _orchestrator.md present with Wave Plan, Package Inventory, Gate Commands sections
- Spec-level constraints in orchestrator
- Each work package has all 6 required fields
- No vague verification in individual work packages

### Pipeline consistency
- All artifacts exist for stages up to the current meta.json status
- Status value is recognized

## Known Limitations

The script uses regex matching, not semantic understanding. Mitigations are in place but edge cases remain:
- **Quoted phrases are stripped** — `"should work correctly"` in quotes won't trigger, but unquoted references still will
- **Code blocks and blockquotes are skipped** — fenced code (```) and `>` quoted lines are excluded from scans
- **Open Questions sections are skipped** — ambiguity flags like "possibly" and "might" are expected there
- **Template placeholder detection** — only matches single-identifier placeholders (`{slug}`), not code patterns (`{ provider, model }`)

Remaining edge cases:
- **Context-dependent ambiguity** — "might" in a rationale paragraph explaining alternatives vs. "might" as an unresolved decision. The scanner can't distinguish prose tone.
- **Inline code references** — `\`should work\`` in backtick-inline-code isn't stripped (only fenced blocks are)

When presenting results, note any false positives you spot and help the user focus on real issues.

## Relationship to Other Skills

- **`/workshop`** creates and advances workshops through the pipeline. `/spec-validate` checks the quality of what was produced.
- Use `/spec-validate` before dispatch to catch issues early — a workshop that passes validation has a much higher chance of producing a successful campaign.
- After a campaign post-mortem reveals spec quality issues, run validation on the workshop to see if the checks would have caught them. If not, that's a signal to add a new check to the script.
