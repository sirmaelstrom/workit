---
name: burn-down
description: "Run an ordered queue of roadmap quests to landed in one or more sittings, holding the disciplines that keep the board honest — pickup flip, receipt per stop, ripple closeout, side-thread harvest, owed-step receipts. Trigger on '/burn-down', 'burn down the queue', 'work the queue', 'run the burn-down', 'clear the frontier', 'work these quests to landed'. For resuming a SINGLE quest use pickup instead; this is the multi-item runner that calls it."
---

# Burn-down — work an ordered queue to landed

A **scheduler over primitives that already exist.** It decides *which item is
next* and what discipline surrounds it; the per-item work is handed to `pickup`
(claim + closeout) and, only when stopping mid-item, to `handoff`.

The point is not speed. It is that **nothing gets silently dropped** — not the
side-threads that surface mid-item, not the step someone else owes, not the
ruling that binds a later item.

## Compose the run (once, at the start)

1. **Read the whole board** — `spine_digest` first (bounded aggregate counts;
   `spine_map(readyOnly: true)` can blow the tool-result ceiling on a big board),
   then scoped `spine_map` per campaign you are drawing from.
2. **Order by leverage compounding, not by campaign.** Put items that make every
   *subsequent* item cheaper first — tooling and protocol fixes before the work
   that will use them. Cross-campaign selection is the point; grouping by
   campaign is what makes a queue slow.
3. **Mint a run anchor quest.** Run-level receipts and observations land there;
   per-item receipts land on each item's own quest.
4. **Write the run doc.** Its cargo is *only* what the board cannot hold:

   | Keep | Leave to the board |
   |---|---|
   | Queue order, gates, sequencing notes | Per-item work-state |
   | Ranking rationale (why this order) | Resume notes, artifacts |
   | Protocol deltas for this run | Receipts |
   | Append-only observations | Anything with a status column |

   **No Status column.** Duplicating work-state into the doc guarantees one of
   the two goes stale, and the board is canonical. State that precedence in the
   doc itself.

## Per item

1. **Pick it up** — invoke `pickup` with the item's quest. It claims the quest
   (flip `currentPhase` before the first edit, `promote: true` if the queue row
   says so, read `applied[]` instead of re-reading the board) and it owns the
   closeout shape. Do not restate any of that here.
2. **Work it.** Receipt at every meaningful stop with `spine_receipt` —
   workspace-relative locators, verbatim needles. Blocked? `outcome:
   "needs_input"` with the **exact** blocking question, never smuggled into
   `stoppedAt`. That is what summons the operator; a quest sitting silently is
   not a question.
3. **Land it.** Stop at the **PR boundary** — merge is the operator's go unless
   they have said otherwise. Then close out via `pickup`'s closeout: `done` +
   `landed` + artifacts, with `ripple` in the response as the read-back.
4. **Log one observation** to the run doc. Append-only, never rewrite.

## Standing rules (write these once; do not re-transmit per handoff)

1. **Fold-ins ride branches.** A small adjacent fix rides the item's branch
   rather than earning its own PR. Say so in the queue row so it is not a
   surprise in review.
2. **Harvest side-threads the moment they surface** — `spine_author` with
   `provisional: true`, then **keep going**. Never chase one mid-item. The
   operator prunes; pruning is telemetry, not failure. During a declared
   burn-down, harvest *sparingly* and present harvested items as parkable
   proposals — a burn-down that hands back a pile of new forks has failed at its
   job.
3. **Operator-owed steps get a receipt at the moment they are owed**, not at the
   moment someone remembers. Anything you cannot do yourself — a plugin reload, a
   restart, a merge, a decision — is written down as owed, with the baseline to
   compare against. The next session *verifies* rather than trusts. This is the
   rule that exists because the one silent failure of the original run was the
   one unreceipted owed step.
4. **A ruling that binds a later item is written to that item's quest resume note
   at ruling time** — not carried in a handoff, not held in the session. The
   binding outlives the session that made it.
5. **Correct the carrier.** When you measure something that makes a title, note,
   or doc line false, fix *that string* — `spine_update` has `title` for exactly
   this. A correction filed only in a resume note leaves the falsehood on the
   surface everything renders.
6. **Sweep the trail.** When an item retires or renames vocabulary, grep the doc
   corpus *and the consuming repos' tests* for the outgoing name before marking
   it done. A ship that adds or renames a thing owes the count.

## Stopping

**At a PR boundary:** no handoff. The board plus the run doc plus the
session-start hook already carry it. Refresh the anchor's resume note, write a
run-level receipt, stop.

**Mid-item:** a handoff, and a slim one. Environment state is **derived at
pickup, never transferred** — branch, worktree, and service state are re-checked
by the next session because a written snapshot is stale the moment it is written.
The only irreducible cargo is mid-item nuance: where in the item you stopped,
what you have tried, the next concrete move, and design questions settled so far.
Everything else has a better home — pending externals are receipts (rule 3),
cross-item bindings are resume notes (rule 4), conventions are *this file*.

## Summon the operator for

Decisions, secrets, external actions, and merges. Everything else auto-captures.
A decision is summoned as a `needs_input` receipt carrying the exact question —
not as a paused session waiting to be noticed.

## Measure the run

Count **every instance where the operator had to supply state the board or the
run doc should have held.** That number is the run's real score; items landed is
just throughput. Zero means the substrate carried the run. A non-zero is not a
scolding — it names precisely which surface to fix before the next one.
