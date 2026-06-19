---
name: Cross-Project Catch-Up
description: Scan all repos and produce a structured status summary
tags: [status, projects, catchup]
variables:
  focus_area:
    label: Focus area (optional)
    placeholder: "Leave blank for full scan, or specify a project/topic"
  time_range:
    label: Time range
    placeholder: "e.g., today, this week, last 3 days"
    default: this week
---

Give me a cross-project status catch-up. Scan the workspace and produce a structured summary.

## What to check

List your active repos here, or have the agent discover them under your projects directory. Group them however suits you — e.g. infrastructure projects (always consider active), configuration repos (check for uncommitted changes only), and active feature projects.

1. **Git status** across all repos in your projects directory — any uncommitted changes, branches ahead/behind remote
2. **Recent commits** ({{time_range}}) — what actually shipped, grouped by project
3. **Open beads** —  discover .beads/*.db files and iterate across active projects, run `bd list --status open` and `bd list --status in_progress`, include beads that are in_progress but have no commits since last status check. That's our stale-work detector.
4. **GOALS.md** — current priorities from your goals file, if you keep one
5. **Daily Notes** - cross reference your daily notes, if you keep them (e.g. a dated notes file per day)

For next up, prioritize it by bead dependencies and GOALS.md alignment, not just recency. 

{{#if focus_area}}
## Focus area
Pay special attention to: {{focus_area}}
{{/if}}

## Output format

```
## Status — [date]

### Active Work
- [project]: [what's in progress, branch, beads]

### Recently Completed
- [project]: [commits/closes from {{time_range}}]

### Needs Attention
- [anything dirty, stale, blocked, or drifting from GOALS.md]

### Next Up
- [what's ready to pick up based on beads and priorities]

### Drift Check
- [compare what we worked on (commits) against what GOALS.md says we should be working on. That's where the real insight is.]

```

Be concise. Flag problems, don't narrate the obvious.
