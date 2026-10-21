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

For worktree-backed agent execution, the lane lifecycle is encoded in `${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs`; the binding behavior is `${CLAUDE_PLUGIN_ROOT}/reference/patterns/lane-supervision.md`.

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

   **A long run's queue is a consequential plan.** That covers a queue that
   lanes will run unattended and one that spans several sittings. Get a blind
   second read before the operator sees your ranking
   (`${CLAUDE_PLUGIN_ROOT}/reference/patterns/blind-second-read.md`). Give a
   model from another vendor family the board read (the digest plus the
   candidate notes), the operator's goal and exclusions verbatim, and the gates
   and constraints. Do not give it your ordering. Reconcile its ordering,
   exclusions and depth calls against yours, and then present the queue along
   with the disagreements that changed it. A short queue the operator ranks
   live in the sitting skips this.
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

1. **Pick it up** — call the Skill tool with `workit:pickup` and the item's
   quest id as its argument (naming the skill in prose is not the call; this
   sentence is the A/B arm of quest 55d44b84). It claims the quest
   (flip `currentPhase` before the first edit, `promote: true` if the queue row
   says so, read `applied[]` instead of re-reading the board) and it owns the
   closeout shape. Do not restate any of that here.
2. **Work it.** Receipt at every meaningful stop with `spine_receipt` —
   workspace-relative locators, verbatim needles. Blocked? `outcome:
   "needs_input"` with the **exact** blocking question, never smuggled into
   `stoppedAt`. That is what summons the operator; a quest sitting silently is
   not a question. **A needs_input that is a CHOICE passes `ask.options`** —
   one entry per choice with a letter key (`a`..`f`), a short label, and a
   ONE-LINE consequence — plus `allowFreeText` when a typed answer is also
   acceptable (`question` stays alongside it as the prompt fallback). That
   Spine ask is for unattended runs, and it reaches the operator as a GitHub
   comment in the private asks repo (`WORKIT_ASKS_REPO`; never a public
   repo, so `post` refuses one), posted with
   `node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/github-ask/github-ask.mjs post --spec <file>`
   (`pickup` lists the spec's fields, the item's quest id among them, and
   what each exit code means). The
   operator replies with the option letter alone on the first line, notes below
   it, from any device and with no agent running. A question with no choices is
   filed as one option, `a`, with `allowFreeText: true`, and the operator puts
   the answer under the `a`. `github-ask.mjs poll --spec <file> --once`, run
   once each time the run comes back to the item, finds the reply and records
   it as an `answered` receipt from `operator:github`, which supersedes the ask
   and puts the quest back on the frontier; exit 7 means no reply yet, so park
   the item and go on; exit 8 means no operator login is configured, so stop
   and tell the operator to set `OBSERVATORY_OPERATOR_GITHUB_LOGIN` in the
   Claude Code `settings.json` `env` block. The login filter in poll is a convenience, and
   Observatory's check of the operator login is the authority. Options buried
   in the question prose can't be answered by letter. The Dogan lists waiting
   asks read-only.
   In session, pose any ask or list of choices as a plain AskUserQuestion with the
   recommendation first: the recommended option listed first, its label ending
   "(Recommended)". Use at most four options per question. Record the ruling in
   your next Spine receipt: the chosen label verbatim, plus the session id.
   **Refutation is a valid outcome:** an item whose note does
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
   - **T1 — `slim-review`.** The default for any code diff (two external
     lenses at the PR boundary, both posted, since 2026-09-09 — GPT-6 Sol and
     Astra since 2026-09-23; Terra held the first seat before that). **Capped:**
     one paired review of the whole PR, with the lane report's uncertainty
     passed to both lenses; the lane adjudicates every finding in one batch
     (fix with a control, refute with a quoted observation, or `judgment`), and
     the conductor re-reads only the refutations; after a nontrivial amendment
     (one that changes an executable line), one delta-only pass per lens
     (`lens --since <reviewed head>`). There is no
     second full-PR review and no third round at T1; a fix made after the delta
     pass is checked by its seen-failing control. The cap binds manual T1,
     Observatory's pr-review beat (observatory#765) and conduct's land phase.
     Manual T1 and the beat read the rounds through the writer's `rounds`;
     conduct asks `rounds` too, when a claim is refused as already reviewed
     (`recoverAction`), and imports `pr-review-rounds.mjs` in process
     (slim-review § 4, "Who follows the cap today").
     If the delta pass finds at least two distinct new P1/P2 defects inside the
     amendment, review the amended whole PR in a T2 council round. A `--dup-of`
     pair counts once; guard comments and P3s do not count. The obligation ends
     when a council round is recorded on the delta head or a later head. The
     council cap then applies. This marker guards the workflow against honest
     mistakes. It is not a security boundary against a same-user agent forging
     a record; that boundary belongs to quest 11c2d46a.
     With fewer than two, the T1 cap stands.
   - **T2 — full council.** Fired when the change **touches a contract or an
     invariant**, **adds tests that claim to prove something**, or changes a
     hook, guard, or parser that intercepts or gates agent actions. This includes
     PreToolUse, PostToolUse, and permission hooks, deny/allow logic, and shell
     or command classifiers. Size does not matter. T1 asks
     whether the diff is correct; T2 asks whether it was *permitted* — the
     class T1 structurally cannot see. Where the review-council MCP is not
     available (it is a private backend, not shipped with this plugin), the
     manual multi-model workflow in `reference/patterns/review-council.md` is
     the portable T2 path — T2's requirement is independent lenses plus an
     adversarial pass, not that specific server.

   **The conductor's full suite runs once, at the candidate merge head**, when
   the repo's CI does not run its database-backed tests per PR. It gets its
   own test database, never the lane's (name it after the lane's with a
   `_cond` suffix), and its own detached checkout of that head, never the
   lane's worktree (`git worktree add --detach <repo>-wt-<lane>-cond <head>`,
   then the repo's install and build there; record both in the run's custody
   ledger, standing rule 9, and close them after the merge): a
   build in the lane's tree cleans what the lane is running, and a lane turn
   would stop the suite. So it never blocks the lane: start it in parallel with
   the lane's amendment or with the challenge on the amended tree, and record
   its start and end in the row. It is the whole suite: the database-backed
   files alone take most of its time, so running only those saves little. Run
   no suite before the amendment; a green suite on a head that is about to
   change gates nothing.

   Two rules with receipts: **never downgrade a fired T2 trigger** (the one
   measured downgrade would have cost 10 confirmed defects — run-4 ruling 8,
   held three times), and **a round that produced nontrivial amendments has
   not converged until something checks the amendments** — cheapest forms: at
   T1, the delta lens (`slim-review` `lens --since <reviewed head>`, one pass
   per lens over the amendment only); otherwise run the suite in the mode the
   feature adds, or a challenge grounded against the *amended* tree (ruling 9,
   held twice). The amendment brief itself states the
   limit of what it dictates — a prescribed mechanism carries "or another you
   can justify", the disposition outranks the brief's example, a "settled"
   premise carries its receipt (`reference/patterns/lane-supervision.md` →
   *Amendment briefs*; Y governance measurement §7 #8). Send it with
   `lane.mjs prompt <lane> --file <brief> --ruling-receipt <uuid> --quest <id>`
   when it acts on an operator answer, or `--no-ruling` when it acts on none (a
   review-round fix). Every prompt after a lane's first is an amendment, and
   the helper refuses one that declares neither.
4. **Land it.** Before the PR boundary, an item whose change touches a
   contract, wire format, or shared surface can take a `blast-radius` pass —
   pre-ship impact analysis that hands review its proven safety fact instead of
   a plausible writeup. Optional, and cheapest exactly when T2 is about to
   fire. Every PR body carries `## Merge danger` with its `Door:` and
   `Blast radius:` lines (the lane-contract template's § Finish spells out
   the form); the ping-not-hold criterion *easily undone* is read from the
   `Door:` line, and a `Door: one-way` PR is held whatever else it passes.
   Stop at the **PR boundary** — merge is the operator's go unless
   they have said otherwise. One standing "said otherwise" exists: the
   **ping-not-hold merge lane** (`reference/patterns/ping-not-hold-merge-lane.md`)
   — a PR meeting ALL of that pattern's criteria (gate-green, easily undone,
   uncoupled, unstacked) merges at its boundary with an immediate Discord ping +
   anchor receipt carrying the exact revert command; merge-only, never deploy.
   Any doubt → held. **A go must be READ, never assumed: after filing a
   `needs_input` receipt, act only on an answer you can cite. In session, the
   go is the operator's message; record the ruling in your next Spine receipt
   (the chosen label verbatim, plus the session id), never by replying to the
   ask's GitHub comment yourself or through any answer route, which stamps the
   operator's identity. Unattended,
   `spine_quest`'s `latestReceipt.answer` (`key` and/or `text`) IS the go when
   that receipt is `answered`, its `question` is the ask's, verbatim, and its
   `answer.by` begins `operator:`. Read it back with a tool call; never infer
   it from the quest having left WAITING. A later receipt hides the answer
   there: before concluding there is none, read the newest answered receipt
   from Observatory's
   `GET $OBSERVATORY_BASE_URL/api/spine/quests/<quest uuid>/receipts/latest-answer?questionPrefix=<the ask's whole question, URL-encoded>`
   route (`OBSERVATORY_BASE_URL` default `http://127.0.0.1:3100`). It searches every receipt and returns one row, or `null`. The row IS
   the go when its `question` passes the same verbatim check and its
   `answer.by` begins `operator:`.
   "Merge approved" with nothing readable behind it is fabricated authorization
   (measured 2026-08-11: a burn-down filed needs_input, asserted approval 33s
   later with no in-band answer, and recorded "on operator go" in the receipt —
   failure-audit quest e8e289e1).** Then close out via `pickup`'s closeout:
   `done` + `landed` + artifacts, with `ripple` in the response as the read-back.

   **The merge gate is checked at the exact head being merged**: review done
   at the tier, CI green at that head, no pipeline review of that head still
   in flight (`pr-review.mjs inflight --head <sha>` exit 0; exit 9 means wait
   for it to post), `threads --unresolved` exit 0, and the squash tree equal
   to the head that was checked. Mark a draft PR ready before the gate, never
   in the same step as the merge: a ready PR is what a pipeline review picks
   up, and a review that posts after the merge goes unread. Under the T1 cap the merged
   head may differ from the last reviewed head in two named cases only:
   - **post-cap:** a fix made after the delta pass, which the cap forbids
     reviewing again;
   - **trivial:** an amendment that changes no executable line (docs,
     comments, test-only additions), for which no delta pass is owed.

   Either merges on the fix's control seen red then green at that head, CI at
   that head, and the conductor's own read of the tail diff, and the row
   records `unreviewed tail <reviewed>..<merged> (post-cap|trivial)`. Any other
   gap, such as an executable amendment after the full round with no delta
   pass, gets the delta pass before the merge. T2 adds three checks. When the
   base branch moved during review, test the tree that will land (rebase and
   re-run, or run the suite on the merge result) rather than the reviewed
   branch alone. A rebase costs no review ruling: the rounds map it by patch
   id, so an unchanged rebase reads reviewed and a conflict resolution gets a
   delta over the commits it changed. The row names how each challenge escalation ("Human
   review required") was disposed of, including any confirmation of an
   operator ruling that the challenge asks for. And an amendment made after
   the challenge on the amended tree is post-cap at T2: it merges on its
   controls seen red then green, CI and the suite at that head, and the
   conductor's read of the tail's diff body (not its `--stat`), and the row
   records `unreviewed tail <challenged>..<merged> (post-cap)`.

   **A red gate names an oracle; re-derive WHICH one per red step before
   monitoring anything.** A CI red is reached through several steps that may
   share one external oracle (run K: the named audit step, `npm ci`'s implicit
   audit at its 300 s fetch-timeout, and the runtime guard billing both — one
   flapping advisories endpoint, three symptoms). Read the failing step's own
   log, name the oracle it actually waited on, and arm the rerun on a probe of
   *that* oracle — K's first monitor watched the right endpoint for the wrong
   step for 45 minutes. A gate on a remote oracle is three-valued (tree / runner
   / oracle); a red that is the oracle's is a rerun, never a tree finding.
5. **Log one row to the run doc per stop — on every exit, not only landings.**
   Landed (`closed`), refuted, blocked, and dropped all get their row (the
   template's event vocabulary names them); a blocked item exits at step 2 and still owes
   its row before you move on. Append-only, never rewrite. **Every row's
   timestamp is measured, not written:** add the row with
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/run-log.mjs append --doc <abs> --item …
   --event … --pointers … --teach …`, which stamps it from the clock at write
   time and refuses an event outside the template's vocabulary; no flag sets the
   stamp. A row that rests on an operator ask also passes `--asks <receipt
   uuid> --quest <id>`, so the helper reads the receipt at write time and the
   row says what it found. Never add a row with Edit. Run
   `run-log.mjs lint --doc <abs>` before every handoff and at run close; it exits 5 naming each future, out-of-order,
   unparseable or post-commit stamp, each malformed row, and each event outside
   the vocabulary. Three consecutive sessions (I, J, M — 2026-09-04/05)
   hand-wrote stamps 60–70 minutes ahead of the ledger's own clock, and the
   overnight friction memo re-reported it each morning; a row whose time the
   deploy receipt contradicts is a row nobody can trust.

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
   binding outlives the session that made it. A procedure written there (a
   rollback, a kill switch, a recovery step) cites its source file and section,
   or copies the source's commands verbatim; never paraphrase an env var, flag
   or key, because the paraphrase is a new instruction nobody has run.
5. **Correct the carrier.** When you measure something that makes a title, note,
   or doc line false, fix *that string* — `spine_update` has `title` for exactly
   this. A correction filed only in a resume note leaves the falsehood on the
   surface everything renders.
6. **Sweep the trail.** When an item retires or renames vocabulary, grep the doc
   corpus *and the consuming repos' tests* for the outgoing name before marking
   it done. A ship that adds or renames a thing owes the count. **The sweep
   covers config keys and server names, not only prose** — `grep -rn <key>`
   across `projects/` *and the plugin cache* before a removal is marked landed.
   Run K (2026-09-04) retired the `serena` MCP server correctly and measured,
   and every codex lane start still broke: `lane.mjs` injected
   `-c mcp_servers.serena.startup_timeout_sec` by name, and codex treats an
   override on an unconfigured server as a hard config error. The quest note
   had guessed the consumer would ignore it; the guess was wrong by 0 s.
7. **An instrument ships with its negative control.** Any item that ships a
   test, guard, watcher, or checker demonstrates it **failing on a known-bad
   input** before the PR boundary, and the run-log row records how; an
   instrument that cannot run exits distinctly as "did not run", never as pass.
   Calibrating is itself a tree edit and a claim, so two clauses guard it.
   **Diff before staging.** Never `git add -A` a tree that you or a
   mutation-testing lens have deliberately broken. **Span the regime.** The
   control must cross the boundary the instrument is meant to detect; name that
   boundary and show the crossing. Rule, both measured receipts, and the
   calibration recipe: `reference/patterns/negative-control.md`. **Assertions
   too:** every *cannot / always / only / never / the one place* written in a
   comment, PR body, pragma or report carries the one-line command that would
   refute it, run and quoted, or the word ASSUMPTION — Y: 8 of 26 confirmed
   Majors contradicted a sentence the lane itself had written, with this rule's
   instrument clause resident and unconsumed in all 14 sessions. Lanes get both
   clauses from `reference/templates/lane-contract.template.md` rule 7.

8. **Re-plan inside the pre-approval.** When mid-flight information shows the
   queue's plan is wrong, or another course is clearly better, you may re-plan
   without asking only when every changed item stays inside the approved scope
   and is a two-way door. Receipt the delta on the run anchor: what changed,
   why, and which pre-approval receipt it rests on. Anything wider, such as a
   one-way door, new scope, or a dropped item the operator asked for, halts with
   a `needs_input` whose `ask.options` carry the delta-plan. `/conduct` does
   this with its `replan` verb, or with `record --replan` when an action's own
   result is the new information (`skills/conduct/SKILL.md` § Re-planning
   mid-flight). Quest e830d835.

9. **The run owns what it creates, and disposes of it at close.** Record each
   test database, worktree, junction or process the moment the run creates it,
   in a ledger beside the run doc. That includes the `_cond` database and
   checkout, a `node_modules` junction, a database a council seat names for you
   to drop, and a verify guest:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/custody.mjs add --ledger <run dir>/custody.jsonl --kind <junction|worktree|db|process|dir> --id <path|name|pid> [--repo <abs>] [--dispose <json argv>] [--live <json argv>]`.
   A database or process needs `--dispose`, the repo's own dropper, which must
   refuse an occupied resource with a non-zero exit (Observatory:
   `["npm","run","test:dbs","--","--drop","--name","<db>"]` with `--cwd` at the
   checkout). Run `custody.mjs close` when an item's resources are done (the
   `_cond` pair after its merge) and again at run close. It unlinks junctions
   before it removes worktrees. It keeps a dirty or locked worktree, a path
   that is not a link, and anything whose `--live` check exits 0 or whose
   dropper refuses. Exit 3 lists what was kept: each kept entry is a row
   in the run close, never a forced removal.

## Stopping

**At a PR boundary:** no handoff. The board plus the run doc plus the
session-start focus block already carry it. Refresh the anchor's resume note,
write a run-level receipt, stop.

Refreshing that note means **replacing live state, not appending to it**. A
burn-down anchor is picked up many times, so it is the quest most likely to
accumulate a note nothing can read in full; method that survives an item
unchanged belongs in a document attached to the anchor, not in the note.
`reference/patterns/re-entry-payload.md`.

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
and, when it is a choice, `ask.options` (letter, label, one-line consequence),
posted as a GitHub comment the operator answers by letter (`github-ask.mjs`,
step 2) — not as a paused session waiting to be noticed. The answer is read
back (`latestReceipt.answer`, else the
answer resolver, step 4), never assumed.

## Observatory down

The run keeps going on `pickup` § Observatory down: one health probe
(`GET $OBSERVATORY_BASE_URL/api/health`, 3 s), then the queue's quests are read
from the file mirror and every stop-receipt goes through Observatory's
`scripts/spine-receipt-spool.mjs`. What degrades: the board is the mirror's
snapshot, up to 15 minutes behind the live board and frozen for the outage, so
say its age; nothing is written but receipts, so the pickup flip, lane moves
and closeouts wait for recovery; and no ask is answered until Observatory is
back to record it. Items that need any of those park; the rest proceed.

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
