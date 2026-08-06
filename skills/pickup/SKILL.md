---
name: pickup
description: "Resume the current project's top roadmap quest from the Spine — read its resume note + cartridge artifacts, claim the quest on the board, and continue the work. Trigger on '/pickup', 'pick up where I left off', 'continue the quest', 'resume the roadmap work' (the work-resume sense; Claude Code's built-in /resume resumes SESSIONS — this resumes WORK). Optional arg: a quest short-id or project name to pick up something other than the default."
---

# Pickup — one-command quest re-entry

Close the handoff-loading gap: instead of the operator hand-typing "read X and
continue", walk the Spine from quest → resume note → artifacts, claim the quest
on the board, and start moving.

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
   `spine_map` scoped to that project's `place` (or the campaign you know owns
   it) — scoped reads are complete; an unfiltered map can blow the MCP
   tool-result ceiling on a big board. Pick the
   quest that: is open + surfaced, sits on horizon `now` (fall back to `next`),
   and carries the `projects-{project}` place or an obviously matching title.
   Highest salience wins. If the context-ledger MCP tools are unavailable, GET
   the Observatory atlas endpoint (`$OBSERVATORY_BASE_URL/api/atlas`, default
   `http://127.0.0.1:3100`) and apply the same filter; if that is also
   unreachable, say the Spine is unreachable rather than guessing.
4. **Nothing found?** Say so plainly and list the 2–3 nearest frontier quests as
   options. Do not invent a quest and do not author one — pickup resumes work
   that already exists on the board.

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

## Claim the quest

Pickup is where the board stops being a plan and becomes a record. Claim the
quest with `spine_update` **before the first edit**, not after the work is done —
a session that dies mid-item should still have left a mark:

- **`currentPhase`** → the phase the work actually enters (`discussion` / `spec` /
  `build` / `review`). This is the flip that makes an interrupted item legible to
  the next session: `build` means someone started.
- **`promote: true`** if the quest is `provisional` and you are genuinely doing
  it. A harvested proposal you have decided to work is no longer a proposal.
- **`horizon: "now"`** if it was sitting on `next` and it is what you are doing
  now.

Then **read `applied[]` in the response instead of re-reading the board.** It
lists the axes the write accepted, and it is the complete truth of the call: an
undocumented field rejects the whole `spine_update` *before* any write, with a
did-you-mean (`state` → `workState`, `phase` → `currentPhase`), so a misspelled
axis can no longer be silently ignored. Note `applied[]` reports what was
accepted, not what changed — an axis already at the requested value still
appears.

Claim, then work. If the Spine is unreachable, say so once and continue from the
resume note — an unclaimable quest is not a reason to stall.

## Continue the work

- One-line confirmation of what you are picking up (title + short-id + the
  next concrete step from the note), then start executing. No ceremony, no
  re-planning of things the cartridge already decided.
- This is a recognition surface, not an order: if the operator's message
  indicates different work, do that instead and leave the quest untouched.
- Mint artifacts on the quest as they are born (`artifacts` on `spine_update`) —
  a PR, a doc, a handoff. A fresh session must be able to walk quest → artifact
  without keyword search.

## Close it out

One `spine_update` carries the closeout: `workState: "done"` +
`horizon: "landed"` + any final `artifacts`. Its response carries **`ripple`** —
the campaign's open/dormant/done delta, the quests whose readiness this write
flipped (`newlyReady` / `newlyBlocked`), and `campaign.clear` when the last open
quest closed. **That is the read-back.** A follow-up `spine_map` is wasted work
unless the response carries `rippleNote` instead, which means the diff could not
be computed — the write still applied, and only then is a re-read owed.

Receipt the stop with `spine_receipt`: locators **workspace-relative**, needles
**verbatim** copies of a string the artifact actually contains. Both are
pre-validated at submit — an unresolvable artifact rejects the whole receipt with
a per-artifact fix hint and nothing is persisted, so fix and resubmit rather than
dropping the needle. Stopped because you are blocked rather than done? Use
`outcome: "needs_input"` with the exact blocking question — the quest then
surfaces blocked-waiting instead of looking abandoned.

Work-state and attention are orthogonal: `dismissed` is not `done`, and a quest
you finished is not closed until `workState` says so.
