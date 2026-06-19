---
name: Post-Build Verification
description: Punch list for verifying a build matches its spec — catches issues that only emerge through use
tags: [verification, quality, ui, accessibility]
variables:
  spec_path:
    label: Spec prompt path
    placeholder: "e.g., ./outputs/workshops/dispatch-form/work-packages/wp-03-ui.md"
  project:
    label: Project path
    placeholder: "e.g., ~/projects/your-project"
  reviewer:
    label: Reviewer
    placeholder: "e.g., human, agent, or both"
    default: "both"
---

# Post-Build Verification Checklist

**Use this after a spec prompt has been executed and the build succeeds.** The spec gets the thing built. This checklist inspects what was built. Run it as a separate pass — manually, as a focused CLI session, or as a Playwright-assisted visual review.

## Scope Fence

**This template IS for:** Verifying that built output matches design intent across interaction, visual, semantic, data, accessibility, and error dimensions. The punch list after the walls go up.

**This template is NOT for:**
- Evaluating spec quality (use `spec-scorecard` template)
- Reviewing code quality or architecture (use `code-review` or `Audit codebase` template)
- Running the review council on specs pre-dispatch (use `review-council` pattern)
- Post-mortem analysis of a campaign (use `campaign-closeout` pattern)

## Target

- **Spec prompt:** {{spec_path}}
- **Project:** {{project}}
- **Review date:** (today)
- **Reviewer:** {{reviewer}}

---

## 1. Interaction Persistence

For every interactive element added or modified, verify the action actually persists at the right layer.

| Element | Action | Survives refresh? | Survives session restart? | Storage layer | Notes |
|---------|--------|-------------------|---------------------------|---------------|-------|
| | Click / Submit | | | | |
| | Dismiss | | | | |
| | Toggle | | | | |
| | Expand/Collapse | | | | |

**Common failure:** Local `$state` without backend persistence. Looks like it works until you refresh.

**Verification hierarchy** (from `test-first-spec`):
- **Best:** Automated test that asserts persistence across page reload
- **Good:** Playwright script that clicks → reloads → asserts state
- **Acceptable:** Manual click → F5 → observe

**What to check:**
- Dismiss actions — does the item come back on page reload?
- Toggle states — are expanded/collapsed states preserved?
- Preference changes — do selections survive session rotation?
- Created/modified data — does it write to the database or just local state?
- Stating "does not persist — intentional" is just as important as specifying persistence.

---

## 2. Palette Integration

Walk every view/surface in the app and verify visual coherence with the design palette.

| View / Surface | Background | Text | Accents | Borders | Status |
|----------------|------------|------|---------|---------|--------|
| | Matches palette? | Readable? | Correct semantic color? | Visible but not harsh? | OK / Issue |

**Common failure:** Hardcoded color values that predate palette changes. DaisyUI component classes that don't inherit from custom theme variables.

**What to check:**
- Every view in the sidebar navigation
- Modal/dialog overlays
- Dropdown menus and autocomplete popups
- Toast/notification surfaces
- Loading/skeleton states
- Empty states
- Error states
- Hover and focus states (do focus rings show against the new background?)
- Scrollbar styling (if custom)
- Status indicators (connection dots, loading spinners) — color and contrast

---

## 3. Semantic Accuracy

Every visual element should match its semantic meaning. Icons, labels, colors, and affordances should communicate the right thing.

| Element | Current Visual | Intended Meaning | Match? | Fix Needed |
|---------|---------------|------------------|--------|------------|
| | Icon / Label / Color | What it represents | Yes / No | |

**Common failure:** Carryover from a previous design that was renamed but not visually updated.

**What to check:**
- View icons in the sidebar — do they match the view's purpose?
- Section headers — do labels describe the content accurately?
- Badge/pill colors — is the color semantically correct (amber = warmth, blue = system, muted = secondary)?
- Action button labels — do they describe what will happen?
- Empty state messages — do they make sense for the current context?

---

## 4. Data Variation

Test with real data that spans the expected range. Designed views often look great with 3 items but break with 0, 1, 15, or 50.

| Data Condition | Expected Behavior | Actual Behavior | Status |
|----------------|-------------------|-----------------|--------|
| Empty (0 items) | Empty state shown | | |
| Single item | No layout break | | |
| Typical (3-7) | Normal display | | |
| Dense (15-30+) | Scroll, no perf issues | | |
| Long text content | Truncation/wrapping | | |
| Missing optional fields | Graceful absence | | |

**For warmth/visual-weight systems specifically:**
- Do items with different data values actually look visually distinct?
- Is the warmest item obviously warm? Is the coldest obviously cool?
- Does the middle range compress into visual sameness?
- Does the visual system degrade gracefully at the extremes?

---

## 5. Keyboard & Accessibility

| Element | Focusable? | Has focus indicator? | Keyboard-activatable? | Screen reader label? | Notes |
|---------|-----------|---------------------|----------------------|---------------------|-------|
| | Tab reaches it | Visible ring/outline | Enter/Space works | aria-label or text | |

**Common failure:** `onclick` without `role="button"` and `tabindex="0"`. Focus indicators invisible against the current palette.

---

## 6. Responsive / Overflow

| Condition | Behavior | Status |
|-----------|----------|--------|
| Narrow viewport (< 800px) | No horizontal overflow, content reflows | |
| Very long title/label text | Truncates with ellipsis, no layout break | |
| Rapid resize | No layout thrashing | |
| Scroll containers | Scroll correctly, no double-scroll | |

---

## 7. Error & Edge States

| Scenario | Expected Behavior | Actual Behavior | Status |
|----------|-------------------|-----------------|--------|
| Backend disconnected | Graceful degradation or error indicator | | |
| Slow response | Loading state shown | | |
| Action fails | Error feedback to user | | |
| Stale data (websocket reconnect) | Data refreshes | | |

---

## Summary

| Category | Issues Found | Critical? |
|----------|-------------|-----------|
| Interaction Persistence | | |
| Palette Integration | | |
| Semantic Accuracy | | |
| Data Variation | | |
| Keyboard & Accessibility | | |
| Responsive / Overflow | | |
| Error & Edge States | | |

**Total issues:** {N}
**Blocking issues (must fix before shipping):** {N}
**Polish issues (fix in next pass):** {N}

---

## Issue Log

| # | Category | Description | Severity | Fix |
|---|----------|-------------|----------|-----|
| 1 | | | blocking / polish | |

---

## Feedback to Spec (Corrections Loop)

Issues that should have been caught by the *build spec* rather than this verification pass. Feed these back into:
- The spec's work package (add to verification criteria for next time)
- The project's CLAUDE.md (if it's a recurring miss)
- The `corrections-loop` (if the same class of issue recurs across specs)

-

## Execution Feedback

*(Append results from actual verification runs — what categories consistently find issues, what's always clean and could be trimmed)*

---
*Operational template — post-execution verification, not spec review*
*Applies: `test-first-spec` (verification hierarchy), `scope-fence` (scope declaration), `corrections-loop` (feedback to spec)*
*See also: `spec-scorecard` (evaluates spec quality), `campaign-closeout` (post-campaign lifecycle)*
