---
name: pickup
description: Resume the current project's top roadmap quest from the Spine — read its resume note + cartridge artifacts and continue the work. Trigger on '/pickup', 'pick up where I left off', 'continue the quest', 'resume the roadmap work' (the work-resume sense; Claude Code's built-in /resume resumes SESSIONS — this resumes WORK). Optional arg: a quest short-id or project name to pick up something other than the default.
---

# Pickup — one-command quest re-entry

Close the handoff-loading gap: instead of the operator hand-typing "read X and
continue", walk the Spine from quest → resume note → artifacts and start moving.

## Resolve the target quest

1. **Argument wins.** If the invocation carries a quest short-id (8+ hex chars),
   that is the target — resolve it via `spine_map` (ids are listed) or
   `spine_update`-style short-id addressing. If it carries a project name, use
   that instead of the cwd project in step 3.
2. **Injected focus block.** If this session's context already contains a
   `## Pick up here — {project}` block (the SessionStart hook injects it), that
   quest is the default target — you already have its resume note and artifact
   locators; skip to reading the artifacts.
3. **Spine lookup.** Otherwise derive the project from the cwd basename and run
   `spine_map` (no filter, or the campaign you know owns this project). Pick the
   quest that: is open + surfaced, sits on horizon `now` (fall back to `next`),
   and carries the `projects-{project}` place or an obviously matching title.
   Highest salience wins. If the context-ledger MCP tools are unavailable, GET
   the Observatory atlas endpoint (`$OBSERVATORY_BASE_URL/api/atlas`, default
   `http://127.0.0.1:3100`) and apply the same filter; if that is also
   unreachable, say the Spine is unreachable rather than guessing.
4. **Nothing found?** Say so plainly and list the 2–3 nearest frontier quests as
   options. Do not invent a quest and do not author one — pickup is read-side.

## Load the re-entry payload

- Read the quest's **resume note** in full.
- Read its **artifact** attachments — handoffs, cartridges, specs, files
  (workspace-relative locators resolve from the workspace root, the directory
  that contains `projects/`). A "build cartridge" or handoff doc is the primary
  payload: it defines where the work starts and what done means. Skip
  `cli`/`dogan` attachment rows (session joins, not artifacts) and PR refs
  unless the note points at them.
- If an artifact locator does not resolve, note it and continue from the resume
  note alone — do not stall on a dead pointer.

## Continue the work

- One-line confirmation of what you are picking up (title + short-id + the
  next concrete step from the note), then start executing. No ceremony, no
  re-planning of things the cartridge already decided.
- This is a recognition surface, not an order: if the operator's message
  indicates different work, do that instead and leave the quest untouched.
- As state changes, keep the Spine honest: `spine_update` the quest (progress
  in `resumeNote`, `workState`/`horizon` on completion) and mint new artifacts
  on it as they are born.
