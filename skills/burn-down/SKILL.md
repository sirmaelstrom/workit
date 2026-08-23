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
3. **Read each note's own verb before queueing.** A note that says *decide* is a
   decision item — route it to an operator sitting, not the queue. No amount of
   throughput or lane parallelism converts a decision into a build item; run 4
   composed three of them as its pilot and the pilot had no payload. Phase does
   not discriminate here (pickup flips it) — the note text does.

   The same read prices **planning depth**. An item whose note carries open
   design forks that no measurement the session can take will settle is
   *underdetermined* — name the proposed depth in its queue row at composition
   (`prototype` for a logic question only running code answers, `grill-me` for
   hole-finding, `spec` / spec-lite for real structure). A depth named in the
   row is **pre-authorized**: the item's session invokes that skill directly
   instead of stopping to ask. Composition is where this is cheap — the operator
   is present and rules in seconds (run 5 took two such rulings at planning).
4. **Mint a run anchor quest.** Run-level receipts and observations land there;
   per-item receipts land on each item's own quest.
5. **Write the run doc** — instantiate `reference/templates/run-log.md` (this
   plugin). Its cargo is *only* what the board cannot hold:

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
   not a question. **Refutation is a valid outcome:** an item whose note does
   not survive re-derivation is handed back *refuted* with the evidence
   receipted, not built — across runs 3–4 the note was wrong or stale more
   often than it was right. A refuted item still gets its board closeout
   (`done` + `landed`, the refuting receipt as the evidence) — refuted is an
   *outcome recorded in the receipt*, not a lingering open state.

   **Underdetermination found at pickup is the third exit** (alongside build and
   refute): the note's premise fails re-derivation *beyond* an inline re-scope,
   or a design fork surfaces that no measurement the session can take will
   settle. Do not build on thin ground, and do not silently invoke a planning
   skill an unattended queue never authorized — stop with `outcome:
   "needs_input"` proposing the specific depth: *"this item needs a prototype to
   answer X / a grilling / a spec before code — proceed at that depth?"* (Run 2
   items 7–8 already exited this way; this names the pattern rather than adding
   machinery.) If the queue row pre-authorized a depth at composition, invoke it
   directly — the ruling already happened. **This is the exception path, and the
   measured base rate says so:** run 2 had five items whose notes failed
   re-derivation and every one re-scoped inline successfully. Escalate only when
   the inline re-scope would itself be a guess — a burn-down that specs every
   item is not a burn-down.
3. **Review at the tier the change raises — never the diff size.**
   - **T0 — no review.** Docs, config, comments, mechanical renames, with a
     green build. This tier exists so the policy is credible — it is the
     deliberate, named exception to `slim-review`'s every-PR-boundary default.
   - **T1 — `slim-review`.** The default for any code diff (one external lens
     at the PR boundary).
   - **T2 — full council.** Fired when the change **touches a contract or an
     invariant**, or **adds tests that claim to prove something**. T1 asks
     whether the diff is correct; T2 asks whether it was *permitted* — the
     class T1 structurally cannot see. Where the review-council MCP is not
     available (it is a private backend, not shipped with this plugin), the
     manual multi-model workflow in `reference/patterns/review-council.md` is
     the portable T2 path — T2's requirement is independent lenses plus an
     adversarial pass, not that specific server.

   Two rules with receipts: **never downgrade a fired T2 trigger** (the one
   measured downgrade would have cost 10 confirmed defects — run-4 ruling 8,
   held three times), and **a round that produced nontrivial amendments has
   not converged until something checks the amendments** — cheapest forms: run
   the suite in the mode the feature adds, or a challenge grounded against the
   *amended* tree (ruling 9, held twice).
4. **Land it.** Before the PR boundary, an item whose change touches a
   contract, wire format, or shared surface can take a `blast-radius` pass —
   pre-ship impact analysis that hands review its proven safety fact instead of
   a plausible writeup. Optional, and cheapest exactly when T2 is about to
   fire. Stop at the **PR boundary** — merge is the operator's go unless
   they have said otherwise. One standing "said otherwise" exists: the
   **ping-not-hold merge lane** (`reference/patterns/ping-not-hold-merge-lane.md`)
   — a PR meeting ALL of that pattern's criteria (gate-green, easily undone,
   uncoupled, unstacked) merges at its boundary with an immediate Discord ping +
   anchor receipt carrying the exact revert command; merge-only, never deploy.
   Any doubt → held. **A go must be READ, never assumed: after filing a
   `needs_input` receipt, act only on an answer you can cite — an operator
   message in-session, or a receipt/resolution read back via a tool call.
   "Merge approved" with nothing readable behind it is fabricated authorization
   (measured 2026-08-11: a burn-down filed needs_input, asserted approval 33s
   later with no in-band answer, and recorded "on operator go" in the receipt —
   failure-audit quest e8e289e1).** Then close out via `pickup`'s closeout:
   `done` + `landed` + artifacts, with `ripple` in the response as the read-back.
5. **Log one row to the run doc per stop — on every exit, not only landings.**
   Landed, refuted, blocked, and dropped all get their row (the template's
   event vocabulary names them); a blocked item exits at step 2 and still owes
   its row before you move on. Append-only, never rewrite.

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
7. **An instrument ships with its negative control.** Any item that ships a
   test, guard, watcher, or checker demonstrates it **failing on a known-bad
   input** before the PR boundary, and the run-log row records how; an
   instrument that cannot run exits distinctly as "did not run", never as pass.
   Rule and calibration recipe: `reference/patterns/negative-control.md`.

## Stopping

**At a PR boundary:** no handoff. The board plus the run doc plus the
session-start focus block already carry it. Refresh the anchor's resume note,
write a run-level receipt, stop.

**Mid-item:** invoke `handoff` in its **mid-item mode**, which carries the one
irreducible class — where in the item you stopped, what you tried and what it
ruled out, the next concrete move, design questions settled so far. Everything
else has a better home: environment state is **derived at pickup** by
`pickup`'s preamble step (never transferred — a written snapshot is stale the
moment it is saved), pending externals are receipts (rule 3), cross-item
bindings are resume notes (rule 4), conventions are *this file*.

## Summon the operator for

Decisions, secrets, external actions, and merges. Everything else auto-captures.
A decision is summoned as a `needs_input` receipt carrying the exact question —
not as a paused session waiting to be noticed.

## Measure the run

Count **every instance where the operator had to supply state the board or the
run doc should have held.** That number is the run's real score; items landed is
just throughput. Zero means the substrate carried the run. A non-zero is not a
scolding — it names precisely which surface to fix before the next one.

Second count: **catches by watcher position.** For every defect found after its
author believed the work done, record which position caught it (external lens,
contract-reading council, challenge grounded on the amended tree, runtime probe,
fleet-idle conductor, operator) and which positions it had already escaped. A
landing checked only from the author's own vantage is *unmeasured*, not clean —
and repeat passes from the same position do not accumulate independence: run 4's
twin lanes reached the same wrong verdict by the same sound method. Expect a
nonzero post-landing escape rate (run 4's obs#457: a wrong remedy survived five
watcher classes *because it works*); the response to an escape is another
watcher position, not a resolution to be more careful. No percentages — the
misses never seen can't be counted, and positions are the actionable unit.
