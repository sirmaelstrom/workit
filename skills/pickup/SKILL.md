---
name: pickup
description: "Resume the current project's top roadmap quest from the Spine — read its resume note + cartridge artifacts, claim the quest on the board, and continue the work. Trigger on '/pickup', 'pick up where I left off', 'continue the quest', 'resume the roadmap work'. Optional arg: a quest short-id or project name to pick up something other than the default."
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
   unreachable, read the mirror (§ Observatory down) and say so.
4. **Nothing found?** Say so plainly and list the 2–3 nearest frontier quests as
   options. Do not invent a quest and do not author one — pickup resumes work
   that already exists on the board.

## Derive the environment (do not accept it second-hand)

Before reading any note that describes the world, measure it:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace-preamble.mjs
```

It reports occupied checkouts (branch, dirty tree, extra worktrees, ahead/behind),
whether the installed plugin cache is behind the repo, and service state — the
things a handoff used to write down and get wrong. Pass `--workspace-root <abs>`
if `WORKIT_WORKSPACE_ROOT` is unset; it announces which rule resolved the root
either way, and exits 2 rather than printing a reassuring empty board if it
scanned no repositories.

Run it **per pickup**, not once per session: a run that works several items over
several hours has a different environment by the third one. If a resume note or
handoff states environment state, the script's answer wins — the note is evidence
about the past.

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
- **A fat resume note is a defect, not a rich payload.** The arrival focus block
  truncates the note to a fixed cap, so a long note is already mostly unread by
  the time you get here, silently — and past a further ceiling the full entity
  read refuses the payload outright. If the note you just read is dominated by
  method that has not changed in several items, split it: durable half into a
  document attached to the quest, note back to live state plus a pointer.
  Procedure: `reference/patterns/re-entry-payload.md`.

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

## Observatory down

Probe once, cheaply: `GET $OBSERVATORY_BASE_URL/api/health` with a 3-second
timeout. Anything but a 200, or an MCP call failing to connect, means work from
the file mirror Observatory keeps for this case:
`<data dir>/state/spine-mirror/` (`index.md`, `manifest.json`,
`campaigns/<slug>.json`). Read `index.md` first, then the one campaign file
that holds your quest; its entry carries the resume note verbatim, the refs and
the latest receipt. If a campaign file's `exportId` differs from the index's,
an export was mid-write: read both again once. A `schemaVersion` other than 1
means don't use the mirror; say so.

What degrades, exactly:
- **The board is stale.** Observatory rewrites the mirror 5 s after each write
  through its routes and every 15 minutes regardless, so it trails the live
  board by up to 15 minutes, then stays frozen for the length of the outage.
  Tell the operator the snapshot's age from its `exportedAt`.
- **No writes except receipts.** No claim, lane move or closeout
  (`spine_update`), no authoring and no answer recorded. Receipts go through
  Observatory's `scripts/spine-receipt-spool.mjs --quest <uuid> --body <file>`:
  it files them when Observatory answers and otherwise spools them for replay
  on recovery (exit 0 either way; 1 is a refusal to fix). It takes `completed`,
  `paused` and `needs_input`.
- **Asks wait for recovery.** A spooled `needs_input` has no receipt id until
  it replays, so its GitHub comment is posted at the first re-entry after the
  probe answers again: read the replayed receipt's id from `spine_quest`, write
  the spec and run `post` (it finds a comment already posted rather than
  posting twice). A reply to a
  comment already posted stays on GitHub, and `github-ask.mjs poll` keeps
  retrying it until Observatory records it.

When the probe answers again, go back to the Spine and make the writes you
held.

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
surfaces blocked-waiting instead of looking abandoned. When the question is a
CHOICE, pass `ask.options` too — one entry per choice with a letter key
(`a`..`f`), a short label, and a ONE-LINE consequence, plus `allowFreeText`
when a typed answer is also acceptable. A question with no choices is filed as
one option, `a` (label "Answer below"), with `allowFreeText: true`, because a
GitHub answer needs a key. That Spine ask is for unattended runs, and it
reaches the operator as a GitHub comment on the run's PR or issue. Post it with
`node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/github-ask/github-ask.mjs post --spec <file>`,
where the spec file holds the receipt's id, the question, the options and
`allowFreeText` exactly as filed, the recommended option's key (`recommended`),
the target `<owner/repo>#<n>` and the run's name. The operator replies from any
device with the option letter alone on the first line; notes, a typed answer
included, go on the lines below and become the answer's `text`. Then run
`github-ask.mjs poll --spec <file> --once`, once per re-entry: it finds that
reply and records it through Observatory as an `answered` receipt from
`operator:github` that supersedes the ask. Its exit says what to do next:
- 0, recorded: read the answer back (below).
- 7, no reply yet: end the turn, and run it again on the next re-entry. Never
  run the blocking form in a turn that should end.
- 3, the ask was answered another way or replaced: read it back.
- 4 (not the operator's), 5 (Observatory unconfigured), 6 (the route refused
  it), 1 (gh failed) or 2 (bad arguments, or no operator login): report the
  printed status and error to the operator, and stop.

poll counts only comments by the login in `OBSERVATORY_OPERATOR_GITHUB_LOGIN`
(or `--operator`). That filter is a convenience; Observatory's own check of the
login on the comment it fetches is the authority. A run holding the operator's
gh token can post as the operator, and nothing tells that comment apart, so
never reply to an ask comment yourself. The Dogan still lists waiting asks,
read-only; it no longer answers them. In session, pose any ask or list of choices
as a plain AskUserQuestion with the recommendation first: the recommended option
listed first, its label ending "(Recommended)". Use at most four options per
question. Record the ruling in your next Spine receipt: the chosen label
verbatim, plus the session id. In session, the operator's message is the go.
Unattended, on re-entry, `spine_quest`'s `latestReceipt.answer` (`key` / `text`)
IS the go when that receipt is `answered`, its `question` is your ask's,
verbatim, and its `answer.by` begins `operator:`. Never assume the go from the
quest having returned to the frontier. A later receipt hides the answer there,
so before concluding there is none, read the newest answered receipt from
Observatory's `GET /api/spine/quests/<quest uuid>/receipts/latest-answer?questionPrefix=<your ask's whole question, URL-encoded>`
route. It searches every receipt and returns one row, or `null`. The row IS the
go when its `question` passes the same verbatim check and its `answer.by`
begins `operator:`.

Work-state and attention are orthogonal: `dismissed` is not `done`, and a quest
you finished is not closed until `workState` says so.
