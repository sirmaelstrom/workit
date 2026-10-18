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
   unreachable, say the Spine is unreachable rather than guessing.
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
when a typed answer is also acceptable. Pose any ask or list of choices as
selectable options (AskUserQuestion in T3), with the Dogan ask filed too when it
needs a record; a T3 answer is written back to Spine the same turn. Put the ask
key in each option label (`a — Full grant, $200`) and the receipt tag in the
question (`[ask <receiptId>]`). Use at most four options per question; split or
collapse a Dogan ask with five or six options. A headless lane with no operator
present files the Dogan ask only. The T3 ask-mirror hook writes a tagged
single-choice answer to Spine as `answered` (`by: 'operator:t3'`) while the ask
is still the quest's latest receipt; write a conductor receipt quoting the
answer only when the hook reports the mirror refused or skipped it, or its
pending job did not end `answered`. The Dogan's WAITING
card renders the choices as buttons the operator presses with no agent running,
and the press writes an `answered` receipt that supersedes the ask (quest
9a1ce903). When you file the ask, keep the `id` that `spine_receipt` returns,
with the ask in your notes (and in the handoff if the session rotates): it is
the ask receipt id, and the go check takes it from you, never from the answer.
Write a state file holding
`{"touches":[{"tag":"<question up to its first space>","receiptId":"<ask receipt id>"}]}`
for it. On re-entry, `spine_quest`'s `latestReceipt.answer` (`key` / `text`)
IS the go when that receipt's `question` is your ask's, verbatim,
`verify-receipt` with `--state` exits 0 on it, `answer.askReceiptId` is present
and equals the ask receipt id retained from `spine_receipt` at filing after
lowercasing both, and either `mode` is `verified` or, unconfigured, `answer.by`
begins `operator:`. Write the result body to a temp file and run
`node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/operator-proof/operator-proof.mjs" verify-receipt --file <it> --quest <full quest uuid> --state <the state file>`;
keep the state touch so the verifier also binds the signature to the filing
when its lookup matches. The `statement_mismatch` binding applies only when a
passkey is configured and the verifier finds that touch; the caller-side
filing-id equality is required even when the lookup misses.
Never assume the go from the quest having returned to the
frontier. With an operator passkey configured, an unsigned `operator:t3` answer
is not a go until the operator confirms it on the phone: wait for that signed
answer. Unconfigured (the CLI prints `"mode":"unconfigured"`), the CLI checks no
signature, so the gate is the operator stamp plus the filing-id equality. A
later receipt hides the answer there, so before concluding there is none, run
the `WORKIT_TOUCH_ANSWER_CMD` resolver with the quest uuid and your ask's whole
question, exactly as written, as the tag. It searches every receipt. Save the row
it prints; it IS the go when `verify-receipt --file <row> --quest <full quest
uuid> --state <the state file>` exits 0 on it (the CLI accepts a bare row), its
`question` passes the same verbatim check, `answer.askReceiptId` is present and
equals the ask receipt id retained from `spine_receipt` at filing after
lowercasing both, and either `mode` is `verified` or, unconfigured, its `answer.by`
begins `operator:`. A missing or unequal filing id means not a go: re-file the ask.
If the ask receipt id is lost, don't take it from the row:
the answer's `askReceiptId` sits beside the proof, so whoever swaps the proof
swaps it too. Without the id from your own filing the go is not verified;
re-file the ask and read the answer to the new filing.

Work-state and attention are orthogonal: `dismissed` is not `done`, and a quest
you finished is not closed until `workState` says so.
