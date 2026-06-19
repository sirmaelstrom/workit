---
name: Session Handoff
description: End-of-session context dump for next session continuity
tags: [session, handoff, context]
variables:
  what_was_done:
    label: What was done
    placeholder: "Summary of work completed this session"
  what_remains:
    label: What remains
    placeholder: "Incomplete items, next steps"
  blockers:
    label: Blockers
    placeholder: "Anything blocking progress (leave blank if none)"
  notes:
    label: Notes
    placeholder: "Gotchas, decisions made, things to remember"
---

## Session Handoff

### Completed
{{what_was_done}}

### Remaining
{{what_remains}}

### Blockers
{{blockers}}

### Notes
{{notes}}

Store this context. When the next session starts and asks what to work on, reference this handoff to provide continuity. The goal is zero context loss between sessions.
