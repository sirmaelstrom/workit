---
name: conduct
description: "Take a goal end to end: spec, parallel lanes, review, merge, analysis, two touches. Trigger: /conduct. Not for one quest (pickup) or a queue (burn-down)."
---

# Conduct — take a stated goal end to end

`/conduct "<goal>" --repo <abs path to a git checkout>` runs a goal from intent to a merged, analyzed result: it specs the goal, splits it into work packages (WPs), builds each in its own lane, reviews and merges each PR, runs the release recipe if the repo declares one, and writes a run analysis. The operator is asked twice: **touch 1** before `/spec` runs (what authority the run has) and **touch 2** at the showcase (accept, accept with notes, or send back). A third touch, the blocked stop, opens only when a fork can't be settled from evidence.

You drive a one-shot state machine, `${CLAUDE_SKILL_DIR}/scripts/conduct.mjs`. Each verb reads `state.json`, does one bounded thing, writes state and exits. The conductor is you, repeating **intake → next → perform → record**; the run's state is the files under its run dir, not your context, so a rotated conductor resumes from it (§ Rotating the conductor).

```
/conduct "<goal>" --repo <abs path>
         [--anchor <quest id>]        # Spine adapter: the goal's quest
         [--budget <usd>]             # proposed in touch 1; default 25
         [--lanes <1-4>]              # concurrent lanes per repo; default 2; a 3rd or 4th lane starts only with ≥ 10 GB free commit memory (lane.mjs admit)
         [--agent claude|codex]       # lane agent CLI; default: the first found
         [--adapter <name>]...        # declare spine | council | kb | verify | ledger
         [--no-adapter <name>]...     # force the core path for an adapter
         [--release <json file>]      # a release recipe; else the repo config's release (§ Repo config)
         [--runs-root <dir>]          # where the run dir goes
/conduct --resume <run dir>           # continue a run
```

## The loop

Recovery commands and amendment evidence rules: [RECOVERY.md](RECOVERY.md).
Long-running drivers should use `${CLAUDE_PLUGIN_ROOT}/scripts/conduct-run.mjs`
so each invocation follows the run's recorded plugin root after an upgrade.

1. **Start.** Run `node "${CLAUDE_SKILL_DIR}/scripts/conduct.mjs" intake --goal "<goal>" --repo <abs> …` with the flags above (declare adapters first, § Adapters). It prints `{ ok, runDir, action }`. On the core path the first action is touch 1, a `touch`. With the Spine adapter the first action reads the anchor quest, and touch 1 follows as a receipt, a read-back and, while no answer is attributed, a hand-back (step 2, `touch`). Exit 2 is a refusal (§ Refusals) and writes nothing.
2. **Perform the action.** Every action has an `id`, a `kind`, an `instruction` a person could follow, and an `expects` field. What you do depends on `kind`:
   - `shell`: run its `command` argv exactly as given, from `cwd` and with `env` added when present. Record `{ "code": <exit>, "stdout": "…", "stderr": "…" }`. `background: true` marks a command that can outlast a foreground shell (a repo's long gate suite): start it in the background, wait for it to exit, and record the same result. The `lane`, `land` and `analyze` verbs (`lane spawn`, `lane check`, `land gate`, `land merged`, `analyze`) reach you only this way: `next` never runs a program, so every check is a `shell` action whose printed result you record. `land gate` exits 6 while CI is still running or a pipeline review of the head is in flight; that is a wait.
   - `agent-tool`: call the named MCP `tool` with `args` and record its raw JSON result. These are emitted only for an adapter that is on.
   - `skill`: invoke the named skill with `skillArgv`, one argument per element (`skillArgs` is its display form), **from the target repo's root** (cwd = the run's `--repo`): `/spec` takes its project from the cwd and doesn't ask. On a greenfield run (`intent.greenfield.on`, § Greenfield bootstrap), the `/spec` action's `skillArgv` ends with `--greenfield`. `/spec` then attacks D1, the stack decision, with one lens before ruling it, and runs core-loop spikes only when the lens names a credible alternative (`${CLAUDE_PLUGIN_ROOT}/reference/patterns/stack-attack.md`, quest 061b526a). For `/spec`, record the JSON the action's `instruction` describes, composed from its report: `depth`, `workshopDir`, `reviewLevel`, and the `gateCommand` (depth `none` or `lite`). A deep run's WPs come from `work-packages/` in the workshop, not from the record. `expects.fields` lists only the minimum. Under the pre-approval no gate shows the spec's `[ASSUMPTION: …]` flags to a person: read the `**Assumptions:**` line of `/spec`'s final output and carry those flags into the showcase by naming them when you present it.
   - `author`: write the file at `outPath`: from `template` with the `slots` filled, or as the instruction describes (the grant at `touches/1-grant.json` from the operator's (c) text, a ruling at `rulings/<wp>-<n>.json` for a lane's question, a lane brief, an amendment). Record `{}`. A `ratify` action comes when a WP is held only because its post-cap tail touches paths outside its Files (inside the line cap). Write `{ "ratify": true, "why": "…" }` to add those paths to its Files and send it back to the gate, so its deferred dependents follow. Write `{ "ratify": false, "why": "…" }` to keep it held. The build doesn't end while that ruling is owed. A `cite` action comes when a WP is held only because its tail has commits no `fixed` row of the latest review cites. Write `{ "cite": { "<sha>": "<comment id>", … }, "why": "…" }`, citing every listed commit on the fixed row whose fix it completes; the WP goes back to the gate, where the inspection reads the tail again. `{ "cite": false, "why": "…" }` keeps it held. To extend a WP's Files before its tail needs it (a lane's ask, an amendment brief that names a new path), run `conduct.mjs ratify --run <dir> --wp <id> --paths <a,b> --why "<the ruling>"`. A path another unfinished WP owns is refused (exit 5).
   - `inspect` with part `visual`: the visual read of a UI WP, owed before a WP whose `**Visual rules:**` names design-direction rules can pass its gate (§ Visual reads). Open the frames its lane took at the action's head, judge each rule in the action's `rules` from the pixels, and record `{ "head": "<the action's head>", "frames": ["<absolute path>", …], "rules": { "<n>": "pass" | "fail: <what the frame shows>" } }`, one entry per rule. A malformed record exits 2 and writes nothing. All pass: the gate runs again and finds the read. Any fail: a gate amendment carrying each failed rule, and the next head is read again.
   - `inspect` (any other part): a judgment step at the merge gate. Run the diff argv in `command` (the post-cap tail: commits added after the last review, as `fixed` rows of it or as a gate amendment's fix, which the gate labels `gate-fix`), read it against the findings the action names, and record `{ "verdict": "addresses-findings" | "unrelated-change", "tail": "<the action's tail>", "head": "<the action's head>" }`. `unrelated-change` holds the PR. A **trivial** tail gets no `inspect` step: the gate passes it and labels it `(trivial)`. A tail is trivial when it has no net diff, or when every path it changes is Markdown that is not a test or fixture and matches no `contractPaths` or `trivialExclude` glob (§ Repo config; without `trivialExclude`, `skills/**/SKILL.md`, `reference/templates/**`, `agents/**`, `commands/**` and `.claude-plugin/**` are never trivial).
   - `touch`: stop and tell the operator what the instruction says.
     Pose any ask or list of choices as selectable options (AskUserQuestion in
     T3), with the Dogan ask filed too when it needs a record; a T3 answer is
     written back to Spine the same turn. Put the ask key in each option label
     (`a — Full grant, $200`) and the receipt tag in the question
     (`[ask <receiptId>]`). Use at most four options per question; split or
     collapse a Dogan ask with five or six options. A headless lane with no
     operator present files the Dogan ask only. The T3 ask-mirror hook writes a
     tagged single-choice answer to Spine as `answered` (`by: 'operator:t3'`)
     while the ask is the anchor's latest receipt, and a touch's read-back
     accepts it in unconfigured mode; with an operator passkey configured, the
     touch waits until the answer is confirmed with a passkey (§ Signed
     authority). When the hook reports the mirror refused or skipped it, or its
     pending job did not end `answered`, the touch waits for the Dogan press.
     - **Core path:** record `{}` after they have answered. An unanswered touch returns the same action with `answered: false`.
     - **Spine path:** a touch is receipt → read-back → hand-back. The hand-back (`handBack: true`) comes when a read-back finds no answer to this run's filing, including another run's answer to the same tag. An answer to this filing that can't be used is handled differently:
       - An answer that isn't stamped `operator:` is refused: `record` exits 3, and the touch is re-filed (`filing + 1`). With a passkey configured, an answer without a valid proof is refused the same way. An unsigned T3 answer is the exception: it waits for the phone confirmation, which supersedes it, and is neither refused nor re-filed.
       - An operator answer whose key isn't an option reopens the touch: `record` exits 0, and the touch is re-filed with the reason.
       - An operator answer with no key and free text is option (c), when the touch has one.

       After a re-file, the hand-back comes at the next read-back that still finds no answer. The hand-back ends your turn: tell the operator the touch waits for them in the Dogan, then stop, and don't poll. Never record a hand-back; `record` returns it unchanged with `answered: false`. To resume, run `conduct.mjs next --resume <run dir>`. Its first action is the read-back again.

       With the `answer` adapter on (§ Adapters), the read-back is a `shell` action (`await-answer --once`), and the hand-back carries a `waiter`. Start `waiter.command` in the background, tell the operator, and end your turn. This relies on your harness re-invoking you when a background command exits, as Claude Code does. On a harness that doesn't, the hand-back is a plain stop and the run needs a manual `next --resume`. The waiter exits when the answer lands (exit 0), at its timeout (exit 4), or after three failed lookups in a row (exit 1). With a passkey configured, an unsigned T3 answer doesn't end the wait, and an unreadable anchor exits 2 at once. However it exits, run `next --resume`: an unanswered read-back hands back again with a new waiter, so the operator never has to resume the run. An answered read-back moves the run on, and an unanswered one hands back again. The build is the exception: it keeps re-reading a blocked touch every 5 minutes, between its other work, while anything else can still act. That means a lane poll, a WP's re-admission timer, or a meter re-read when `WORKIT_SPEND_CMD` is set. The build hands back only when a touch is waiting and nothing else is left to wait on except other touches or a meter that can't run.
   - `wait`: wait `waitMs`, record `{}`, then run `next`.
   - `done`: the run is over. A `done` action is never recorded.
3. **Record it.** `conduct.mjs record --run <dir> --action <id> --result '<json>'` (or `--result-file <path>`). It prints `{ ok, phase, action }`, the next action: loop to step 2. Re-recording the last recorded id is a no-op; any other id that isn't the pending one is exit 5. `--manual` marks a step you did by hand, so the analysis counts it as crossed by hand rather than owned by the skill. Exit 2 is an invalid result; fix it and record again. Exit 3 is a refused answer, and the next action re-files the touch. **A failure whose JSON output carries a `recorded` field** (the action id; exit 1, or the failing step's own code) means the record landed durably and a later step failed: don't record again with a different result. Run `next` (or re-send the same record, a no-op replay) to get the next action.
4. **Resume.** `conduct.mjs next --run <dir>` (or `next --resume <dir>`) returns the pending action again, with one exception: a pending hand-back is consumed and the read-back is emitted in its place. `conduct.mjs status --run <dir>` prints a summary.

**Exit 4** means this installed version lacks a phase handler or module the run needs (the verb names the path, e.g. `lib/analyze.mjs`): the later phases ship in a later version. Stop and report the path; don't write state by hand to get past it. A stopped WP is put back with `reset-wp` (§ Recovering a stopped WP), never by editing `state.json`.

**A new plugin root.** After a self-hosted release (§ Self-hosted runs) a verb can exit 2 naming a new plugin root. Re-run it with that root's `skills/conduct/scripts/conduct.mjs`, and re-read that root's SKILL.md before the analyze and showcase steps: the text you loaded is the old version.

**Where a run lives.** The workshop is `<runs-root>/<slug>/` with `--runs-root`; else `<workspace>/data/outputs/workshops/<slug>/` under `WORKIT_WORKSPACE_ROOT` or the nearest ancestor of `--repo` holding both `projects/` and `data/`; else `~/.workit/runs/<slug>/`. The run dir is `<workshop>/run/`: `state.json`, `events.jsonl`, `touches/`, `rulings/`, the run's lane contract `_lane-contract.md`, per-WP lane briefs and reports (`lane-<wp>.md`, `lane-<wp>-report.md`), `reviews/`, `council/` and, at the end, `run-analysis.md`. `/spec` writes its workshop files beside it. Lane worktrees sit beside the repo, never in the run dir. After a WP merges, its lane is cleaned up: a herdr lane is swept (pane closed, worktree removed), and an exec lane's worktree is removed without `--force`. Then, if the directory is gone and no other worktree has the branch checked out, the branch is deleted locally and on origin, each only while it still names the merged head. Nothing is forced. Whatever stays is named on the WP's line in the run analysis. The release gets the same cleanup after its `verify` commands: `<repo>-wt-<slug>-release` and `conduct/<slug>/release` go, and what stays is named on the release line. A release that fails before then keeps its worktree for diagnosis.

## Adapters

The **core** runs with `git`, `gh` and one lane-agent CLI. An adapter replaces a core mechanism with a richer one when present.

- **Declared by you.** A script can't see your MCP tools, so declare an adapter only when **every** tool it needs is callable in your own tool list; a partial set means the adapter isn't declared. Intake records each declaration with its evidence (`declared`).
  - `spine`: `spine_quest`, `spine_update`, `spine_receipt`, `spine_author`.
  - `council`: `council_review`, `council_synthesize`, `council_challenge`. A council round leaves no thread on the PR, so at adjudication the build posts one COMMENT review to the PR: every finding's id, the lane's verdict, commit and Evidence cell (`<review dir>/pr-record.md`). A failed post is named under the analysis audit. For a delta escalation, the gate also waits for the posted, head-bound council record. The audit's judgment lines quote each item's Evidence and link its PR. The council call names `profile: 'conduct-code'`, which is the shared `code` roster minus sonnet-5-carto and is config-owned in the council's `models.json`. A server without that profile refuses the call by name. From round 2 on, the previous round's adjudication (`<review dir>/adjudication-for-next-round.md`) is the first artifact. It tells the council not to re-raise a finding the lane already ruled on, unless the round's change touches the cited code. This is a prompt instruction, not a filter. A conductor or operator ruling on a guard row carries its reason (`Ruling: …`) beside the lane's Evidence.
  - `kb`: `kb_search`, `kb_save`.
  - `verify`: the workit `verify` skill, when it covers the repo's surface.
  - `ledger`: `ledger_write` (the context ledger; a stall alarm's note).
- **Probed.** `intake` probes herdr (on when `herdr agent list` exits 0, that is, the herdr server answers; used only for a repo inside a projects tree). The conductor needn't run inside herdr: from another client (T3 Code), lanes still open in herdr panes you can watch. Only restoring the conductor's own focus needs `HERDR_PANE_ID`. Lanes run headless on the exec backend only when no herdr server answers, or under `--no-adapter herdr`, and nothing is visible while they work. The probe also covers `notify`, `spend` and `answer`, and the agent CLIs. `notify` and `spend` are optional shell strings in `WORKIT_NOTIFY_CMD` and `WORKIT_SPEND_CMD`; each is on when set and its program resolves, and off otherwise (on Windows a string holding a double quote is refused). `WORKIT_NOTIFY_CMD` runs after a merge and receives the PR number, the merge sha and a revert command in `WORKIT_NOTIFY_PR`, `WORKIT_NOTIFY_SHA` and `WORKIT_NOTIFY_REVERT`. It also runs for a stall alarm, with `WORKIT_NOTIFY_KIND=stalled` and the alarm in `WORKIT_NOTIFY_TEXT`. A stall is one shell step of a WP failing three times in a row, or a live WP whose state and stage have not moved for 30 minutes. Review actions allow 75 minutes; a queued seat starting or a lens finishing advances progress, while a heartbeat alone does not. A lane at work is left to its deadline. A stall raises an alarm and writes a `stalled` event while the build continues; with the `ledger` adapter declared, a `ledger_write` note goes to the Dogan's ledger stream under `WORKIT_LEDGER_USER` (default `conduct`). An alarm that can't be delivered is recorded as an `alarm-failed` event and never stops the build. `WORKIT_SPEND_CMD` is run with the run's start time (ISO) appended, and `WORKIT_SPEND_RUN` (the run slug) and `WORKIT_SPEND_REPO` (the repo's directory name) in its env, so it can attribute spend to the run, and prints the USD spent since then. Spend books when a lane closes, so the budget gate adds every live lane, and on a dispatch the next WP, at the per-WP projection (the mean of closed lanes, else `laneEstimateUsd`, § Repo config), and each merge records the projected total for the run (a `spend-projection` event and a line on the WP's receipt).
- **`answer`** is probed from `WORKIT_TOUCH_ANSWER_CMD` and matters only with `spine` on. It's on when the value is a JSON argv array of non-empty strings (or a bare program path) and its program resolves. No shell parses it.
  - **Arguments:** `{quest}` (the anchor's full uuid) and `{tag}` (the touch's correlation tag, `[conduct <slug> touch <n>] (run <id>/<filing>)`) are substituted into the argv. When neither placeholder appears, both are appended in that order. Both values are validated before substitution, so they are safe inside a SQL string literal.
  - **Output:** one JSON object, the newest `answered` receipt on `{quest}` whose question starts with `{tag}` (`{ id, outcome, question, ask, answer }`), or `null` or nothing when there is none. A non-zero exit is a failure. Return the whole `answer` jsonb, including `proof` and `askReceiptId`, and the `ask` column: the passkey proof is checked against them. With a passkey configured, a row without `ask` stops the read-back (exit 2).
  - **Why use it:** it reads every receipt on the anchor, so a later receipt can't hide the answer the way `spine_quest`'s latest-only read can. It also lets `conduct.mjs await-answer` wait for the answer without a model turn.
  - **Example:** a Postgres resolver: `["docker","exec","<db>","psql","-U","<user>","-d","<db>","-tA","-c","select row_to_json(t) from (select id, outcome, question, ask, answer from quest_receipts where quest_id = '{quest}' and outcome = 'answered' and starts_with(question, '{tag}') order by created_at desc, id desc limit 1) t"]`.
- **`--no-adapter <name>`** forces the core path for one adapter; the names are `herdr`, `notify`, `spend`, `answer`, `spine`, `council`, `kb` and `verify`. For a run on the core path alone, declare none and pass `--no-adapter herdr --no-adapter notify --no-adapter spend --no-adapter answer`. `claude` and `codex` are agents, not adapters; `--no-adapter claude` is a usage error.
- **kb is declared-only.** There is no probe for kb, so pass `--adapter kb` to turn it on; leaving it to detection leaves it off.
- **kb has no script path.** With kb declared, run `kb_search` on the goal at intake and, once the showcase is answered, `kb_save` of the run's decision record (what the run decided and why, the alternatives it rejected, and the run dir), as your own steps.
- **spine needs `--anchor`.** Choose or author the goal's quest first, then run intake with its id.

## Touches

Every touch step's action and event, `resumed` included, carries the seam `operator-touch`. The one exception is the release anomaly's touch, the blocked touch opened when the release PR's merge is flagged (`land merged --wp release` exits 5). While the release waits on that touch, every touch action it emits carries `release`, and so do their events. That covers the anomaly touch's receipt, read-back and hand-back. It also covers the read-back and hand-back of a touch still filed ahead of it, which the release emits first. The run analysis reports touches in their own `Touches` section, not as a seam row, and `operator-touch` isn't a send-back seam name.

1. **Touch 1, before `/spec`.** Options: (a) approve as proposed, (b) approve but hold at PR boundaries, (c) approve with changes (free text), (d) decline. The question leads with a short briefing (the repo, what the run will do and whether it merges, the budget, where the lanes can be watched), then the goal and the DO line, and only then the probe details. The answer is the run's only source of merge, release and budget authority. After a (c) answer, an `author` action has you write `touches/1-grant.json` from the operator's text, each field no wider than (a); if the text doesn't settle a field, write `{ "ambiguous": true, "why": "…" }` and the run asks again. A repo with no CI workflows that can gate a PR is offered hold-at-PR only. Without the spend adapter the budget is **unmetered** and is enforced against the lanes' own cost, a lower bound.
2. **Touch 2, the showcase.** After `analyze`, an `author` action (`showcase-brief`) has you write `run/showcase-brief.json`: `delivered`, `proof` (the runtime evidence, quoted), `notDone` (in plain words; it must name every WP that didn't finish, or state their count above six), `check` (the one thing worth checking yourself), `recommend` (`a`, `b` or `c`) and `why`. Each text field is at most 200 characters. The operator answers from this briefing alone, in the Dogan, so it carries your judgment: never leave a recommendation only in chat. The question leads with it, the recommended button says so, and the status lists follow. (a) accept, (b) accept with notes, (c) send back: write `seam: <name>` in the text (an unknown name records no seam). A (c) ends this run as `sent-back`; nothing re-runs and merged work isn't touched again. Reopening is a new `/conduct` run whose goal cites the old run dir.
3. **Touch-1 (b) holds, it doesn't deadlock.** A WP that passes its gate without merge authority ends `held` (PR open, merge lock released); its dependents are `deferred`; the run still reaches the showcase. Merge authority covers a two-way door only: a WP whose PR body's `## Merge danger` says `Door: one-way`, or declares no valid door, ends `held` the same way with authority granted.
4. **Blocked stop.** A WP goes `blocked` with a cause (`error`, `dialog`, `needs-conductor`, `deadline`, `admission` or `cleanup-unresolved`) when a lane asks something evidence can't settle, its deadline passes, a repo-scope fork appears, or the budget cap is reached. It is counted as a touch. Other WPs not depending on it keep going, and the build doesn't end while a blocked touch a WP owns is open. An attributed answer resumes that WP at its `check` step.
5. **A lane's question is ruled by you first.** From the lane's `## Needs conductor` ask, settle it from evidence and write `rulings/<wp>-<n>.json` as `{ "ruled": "<key>", "evidence": "…" }`; write `{ "escalate": true, "why": "…" }` only when no evidence can settle it. Only an escalation opens the operator's blocked touch. A report that says `built` and still carries asks gets the same ruling before review, and each ask is ruled once. When the ruling needs paths outside the WP's Files, add `"ratify": ["<path>", …]`: they are added to its Files with the ruling, and a path another unfinished WP owns is refused. A ruling is recorded as a `ruled` event and a `rulings[]` row, and goes to the lane as an amendment. That amendment doesn't move the delta review's start: the delta review still covers every fix made since the review's findings, Markdown-only ruling or not.
6. **Never advance without an attributed answer to that touch's tagged question.** With the Spine adapter, a touch is a `needs_input` receipt on the anchor whose question begins `[conduct <slug> touch <n>] (run <runId>/<filing>)`; the read-back accepts only an answered receipt to that filing, stamped `operator:`. With a passkey configured, it must also carry a proof that verifies against that filing's ask. An answer by anyone else, with a key that isn't an option, or with a proof that doesn't verify confers no authority: the touch is re-filed (`filing + 1`) with the reason. An unsigned T3 answer waits for the phone confirmation instead. A quest leaving WAITING is never an answer.
7. **The core-path `answer` command is the operator's, never yours.** Without the Spine adapter, a touch is `touches/<n>.md` plus the exact `conduct.mjs answer --run <dir> --touch <n> --key <a..f> [--text "…"]` command, which the operator runs from their own terminal. It refuses a non-TTY stdin, so your Bash tool can't run it. Don't try to work around that refusal.
8. **The approval boundary.** With an operator passkey configured, answers are verified against the operator's passkey, and authority comes from what the operator signed (§ Signed authority). Unconfigured, the TTY guard and the `by` attribution are a procedural boundary, not proof of the operator's identity.
9. **The budget touch.** When spend reaches the budget, a blocked touch opens that no WP owns. (a) needs the text `budget <USD>` above the spend at the halt (`$` and thousands commas allowed): it becomes the budget and metering continues. (b) stops new paid lane work (no dispatch, lane start, prompt or fallback); PRs already up are still reviewed and still land.
10. **The meter halt.** With the spend adapter on, an unreadable spend reading or an unset `WORKIT_SPEND_CMD` halts dispatch on its own. Only a successful reading clears it. With `WORKIT_SPEND_CMD` set, the meter is re-read every 5 minutes. With it unset, the meter is never re-read. The build waits on the budget touch, and the spine path hands back. Once that touch is answered, the build still polls every 5 minutes; that is a known gap. The meter reads again only after the variable is set in the conductor's environment and the run is resumed.
11. **The `liveness` touch is a blocked-touch cause too.** When an exec lane's exit can't be verified past its deadline (three reads), its WP keeps the lane slot and Files and a `liveness` touch opens: (a) you confirm the process is gone, so the slot and Files are released and the WP keeps its state; (b) they stay held.
12. **No CI at head is never an amendment.** A repo with no workflow that can gate a PR stops at once; otherwise the gate waits 30 minutes per head for CI to appear, then stops. The stop is `held` (`held at PR: <reason>`) without merge authority, and `blocked` with it.

## Signed authority

A run is **configured** when `~/.claude/operator-passkeys.json` holds a registered passkey, and **unconfigured** otherwise. Unconfigured, everything in this skill works as written, and the run says so: each touch's recorded answer stores `proofMode: unconfigured`, and the authority line reads `(proof: UNCONFIGURED — answers not signed)`. A run whose touches were verified but which finds no anchor configured now reads `(proof: UNCONFIGURED — no anchor is configured now, so the stored answer is not checked)`. Configured:

- **Touches are signed with a passkey.** The read-back accepts only an answer whose passkey proof verifies against the ask this filing handed out, and its recorded answer stores `proofMode: verified`. An unsigned T3 answer waits until the operator confirms it with a passkey (Dogan → Confirm on phone). A core-only run is refused at intake, because a TTY answer can't be signed (§ Refusals).
- **Grants are tagged.** Touch 1's (a) and (b) consequences end in ` [grant <tag>]`, and the budget touch's (a) ends in ` [raise <tag>]`. The tag is the first 16 hex digits of the SHA-256 of the grant's canonical JSON; the full grant is stored on the touch. The consequence is part of the signed ask, so the signature binds both the words and the tag. A (c) answer files a confirm touch: the checked grant's scope and the operator's text in the question, (a) Confirm with its own ` [grant <tag>]`, and (d) Decline. Authority stays zero until that signed (a) lands, and the grant becomes the run's authority. (d) declines: the run ends with `phase = 'declined'`. Any other key is refused, and the confirm re-opens saying why.
- **What this protects.** Against an agent that edits `state.json`, exactly this holds:
  1. Merge, release and budget authority are recomputed from the signed content just before every act. `state.authority` is a display cache that no act reads.
  2. A merge is admitted only at its stage: the WP at its gate holding the merge lock, the gate passed at the PR's current head, and the merge stage reached.
  3. A lane's worktree removal is admitted only after its WP merged, and its branch deletes only after that removal.
  4. A council round's acts come from the round recorded when it was queued. Every artifact path must sit lexically inside the lane worktree or the WP's council dir, and a delta's `since` must be a commit sha.
  5. **Not protected:** the ordering and arguments of the other queue producers. Every stored act must still equal one the run derives now, but for acts that don't merge, delete, push or remove, that is the union of a WP's producers over editable state, not a per-stage derivation.
- **Authority holds.** When the signed record stops verifying at an act (an invalid proof, an edited record), paid work, dispatch and merges hold, and the build waits with `waiting: restore the signed record and the build resumes on its own, checked again every 5 minutes`. Restoring the record resumes the build by itself. `grant_expired` and `wrong run` are terminal at once: every unfinished WP is held with `terminal: restoring the record cannot help; start a new run and sign its touch 1`, and the build ends (`/spec` returns `done`). Nothing re-files an authority touch mid-run; the recovery is a new run.
- **Replay ids.** A paid act re-checked on resume is emitted again under its first id only when it equals the original act exactly. Any other act gets a new id.
- **The proof line.** The run report's and the handoff's authority line ends in the proof label: `(proof: verified ••••<credential id tail> epoch <n>)`, `(proof: refused, <reason>; acts hold)`, or the UNCONFIGURED label above. Beside a verified proof it prints the verified values, never the cached ones.
- **Residuals** (detail in workit #267, § Follow-ups):
  - R6: act targets (PR number, worktree path, branch, lease head) come from editable state, though the grant still binds the repo.
  - S2: cleanup trusts the editable merge record, though every cleanup act is the derived, unforced one.
  - Council scope: a round's recorded scope can be edited together with its act.
  - Claim 5 above.

## Runtime verification is part of done

> **Runtime verification is part of done.** A change that alters runtime behavior is exercised at runtime before the PR boundary, and the report quotes the command and what was observed. A runtime check must be able to fail: say what it would have shown if the change were broken, or run it once against the pre-change tree — otherwise it is vacuous and is reported as such. Where the claim is visual, one screenshot per claim, of the critical state only; evidence is a few decisive pictures, never a gallery. Code-only verification of a runtime change is reported as **not exercised at runtime**, never as done.

Every lane brief carries this rule. Each WP's `**Runtime exercise:**` field names the surface (a CLI run against a real input, a service probed, a page loaded, or `none: <why>`) and the check; an empty field means the lane names the surface itself, and it doesn't authorize `no runtime surface`: only a field that begins `none` (case-insensitive) does, and the expected form is `none: <why>`. A waiver with no reason passes the gate but is reported as one. The lane writes the evidence under `## Runtime exercise` in its report, with a `Verdict:` line and, for `exercised`, a `Would have shown:` line. A missing section, `not exercised` for a WP that names a surface, or a `vacuous` check (unless the WP says `none`) fails the lane's check, and the lane gets an amendment before review. The workit `verify` skill is an optional adapter: when it covers the repo's surface, a WP's runtime exercise may name it, and its verdict artifact is the evidence.

## Visual reads

A goal with a UI gets its pixels judged at the merge gate, not only its code (quest 1b3dec9f). `/spec` writes the rules (§ Stage 4 there); this skill enforces them:
- **The rules.** The orchestrator's `## Design direction` (a lite spec's `spec.md`) holds numbered rules at column 0, each with its indented continuation lines; among them, rules opening `**Palette:**`, `**Type scale:**`, `**Iconography:**` and `**Fit to view:**`. A section missing one, or with a number used twice, is a spec defect at mint.
- **Which WPs.** A WP's `**Visual rules:**` names rule numbers, `all`, or `none`. Its lane brief carries them, and the lane names its frames under `## Runtime exercise`.
- **The polish WP.** With a design direction, the orchestrator's last wave is one WP whose `**Skills:**` names `frontend-design:frontend-design` and whose `**Visual rules:**` covers every rule. The lane brief names every skill a WP's `**Skills:**` lists.
- **The read.** After the gate passes at a head, a WP with visual rules gets the `inspect` `visual` action; the merge waits on it. The record's `head` is your attestation that the frames show that head: the verb checks that the files exist, not where they came from. Each read is kept on the WP, and the run analysis lists them under `## Visual reads`.

## Self-recovery before a blocked stop

Try these first. A blocked touch is for what they can't settle.

- **A failed review seat:** re-run it once; then use a seat outside the author's model family, never one the operator excluded.
- **Red CI:** name the oracle that failed, and rerun a flake. CI still running is a `wait`, never a failure.
- **A stuck lane:** read its pane or log, re-arm the wait, then amend. A lane keeps its slot and its files until its process is observed exited, so don't start another WP on its files while it runs. An amendment to a herdr lane whose agent has exited starts the lane before prompting it; a live lane keeps its agent.
- **A harness dialog** (a `block` with cause `dialog`): the verb re-polls once after about a minute, then blocks. **Never answer a harness dialog yourself**: not by sending keys, not by approving. It goes to the operator in the blocked touch.
- **A council split:** you break the tie, inside the goal's bindings, and record why.
- **A refuted premise:** a lane whose report says `refuted` ends its WP `refuted` and defers its dependents; that is a finding, not a failure to retry.

## Recovering a stopped WP

When a WP is `blocked` or `held` for a cause you have since fixed outside the lane (your brief's wrong path or table header, a PR body, the repo config), put it back with the verb. Never edit `state.json` by hand.

```
conduct.mjs reset-wp --run <dir> --wp <id> --to <target> --why "<what you fixed>"
```

| `--to` | From | The WP becomes | Use it when |
|---|---|---|---|
| `check` | blocked | `amending` (or `dispatched` before any amendment) at `check` | the report or PR is fixed; re-run the lane's checks |
| `checked` | blocked, with a PR recorded | the same, at `checked` | the report is right as written; rule its asks and adjudicate its table |
| `prompt` | blocked | the same, at `wait`, its brief queued | the brief is fixed; a herdr lane whose agent exited is started first, an exec lane resumes its session |
| `wait` | blocked, herdr lane | the same, at `wait`, the lane's deadline renewed | you restarted the herdr lane agent and sent its brief yourself |
| `land` | blocked or held, PR not merged | `gate` at `land` | the PR is ready; rebase, gate and merge again |
| `pending` | dropped (by a re-plan) | `pending`, no lane | the plan wants it again; the scheduler dispatches it under its usual rules |
| `delta` | blocked or held, PR not merged | `pr` at `delta` | review an uncovered tail; requires `--baseline <sha>` verified against the latest full review |

For `delta`, use `--to delta --baseline <sha>`. On the original commit line the baseline must be the reviewed head. After a recorded rebase, the supplied commit must carry exactly the reviewed prefix from the recorded new base. Verification reuses the review-round mapper's patch identity and location checks: changed parent files, ambiguous hunks, missing history or a baseline that includes unreviewed fixes are refused. The worktree must be clean and its HEAD must match the recorded PR head. Unsettled findings and a latest review already marked `delta` are refused too; a reset does not grant another review past the cap.

A successful delta reset records its verified baseline, clears the stale gate result and this WP's merge lock, and reviews the tail even when it contains only Markdown. The mapping is bound to that reviewed head and candidate; a candidate that moves needs a new verification. New findings start an exited herdr lane before its amendment prompt.

Under the run's lock the verb copies `state.json` to `state.before-reset-<wp>-<time>.json` beside it, sets the WP's reason to `reset-wp --to <target>: <why>`, and replaces its queue: `check`, `checked`, `land` and `delta` keep a queued stop, so an agent still running is stopped first. It returns every WP deferred because of this one (directly or through another deferral) to `pending` and logs a `wp-reset` event on the `recovery` seam, which the run analysis counts as crossed by hand. When the build had ended (phase `release`, `analyze` or `showcase`, with no release run and no showcase touch filed), the run goes back to `build`: the pending action of the phase it leaves is dropped and the release is decided again when the build ends. The check and gate counters are kept, so a WP that has used its one check re-prompt blocks on the next failure. Then run `next`.

Every target except `pending` puts the WP back in a live state, so the scheduler's rules still hold (`pending` takes no lane, and the scheduler admits the WP later): a WP whose Files overlap a live WP's, or any reset while every lane of the run's cap is in use, is refused until a lane finishes, and so is any reset while a merged-tree halt is open. It also refuses (exit 5) any other state or target, a WP with an open touch (answer it instead), an unverified lane (answer its liveness touch), a WP whose action is pending (record it first), and a run past its release or showcase. Exit 2 is an unknown WP or target, a missing `--why`, or a run another verb holds locked. A refusal writes nothing, no snapshot included.

## Re-planning mid-flight

When information that arrives mid-build shows the plan is wrong, or that another course is clearly better (a WP's premise refuted by a merged one, a cheaper route a lane found), restate the plan as a delta and record it before acting on it (quest e830d835):

```
conduct.mjs replan --run <dir> --plan <file>
# file: { "why": "<the new information>",
#         "delta": [ { "change": "<what changes>", "door": "two-way" | "one-way", "inScope": true | false } ] }
```

- **Every change two-way and inside the approved scope:** the re-plan rests on the run's pre-approval and needs no operator. The verb writes the proposal to `rulings/replan-<n>.json`.
- **Anything wider** (a one-way door, or a change outside the scope): dispatch halts on a touch whose question carries the whole delta-plan. A plan too long for one question is refused (exit 2). (a) approves it, (b) keeps the original plan, (c) approves it as the operator's text amends it, so (c) needs the text. Live lanes finish, and the build waits on the answer rather than ending. Any usable answer clears the halt.
- **Re-plan at a wait.** The verb refuses while any other kind of action is pending (exit 5), because an emitted action would run before the re-plan.
- **An approved re-plan is applied first.** The build's next action is an `author` step: make each change with the verb that makes it (`ratify`, `reset-wp`, a ruling's amendment), then write `{ "applied": true, "what": "…" }` (or `{ "applied": false, "why": "…" }`) to its `outPath`. A pending WP the plan no longer needs is dropped there with `"drop": ["WP-03"]`. It becomes `dropped`, with the re-plan as its reason, and its dependents are deferred. The analysis and the showcase name it as not finished. A drop is two-way inside the run: `reset-wp --wp WP-03 --to pending --why "…"` puts it back, and the scheduler dispatches it again. With the Spine adapter, an autonomous re-plan is then receipted on the anchor (`completed`: what changed, why, the pre-approval it rests on, what was applied). The receipt waits while a touch is filed on the anchor.
- Door and scope are your judgment, read the same way as a PR's `## Merge danger`. In doubt, it is `one-way`. Only one re-plan may be open at a time: one waiting on the operator or one approved and not yet applied. The run analysis lists every re-plan under the pre-approval audit.

## Greenfield bootstrap

`conduct.mjs bootstrap --repo <abs> [--write] [--offline]` checks a repo against the greenfield manifest (`${CLAUDE_PLUGIN_ROOT}/reference/templates/repo/manifest.json`). The manifest's standard is a repo prepared as if it will go public: README, LICENSE, SECURITY.md, `AGENTS.md` with a `CLAUDE.md` `@AGENTS.md` stub, `.editorconfig`, `.gitignore`, a CI workflow that runs on PRs, cancels superseded runs, sets `timeout-minutes` and scans with gitleaks, dependabot, and a PR template carrying `## Merge danger`. A repo with `package.json` adds a Node pin, `engines.node`, a formatter config and npm in dependabot. The one repo setting checked is `deleteBranchOnMerge`.

- It prints one JSON report. Exit 0 means every applicable item passes, 3 means something is missing, incomplete or unverified (`failing` lists each), and 2 is a usage error. A setting `gh` cannot read is `unverified`, never a pass. `--offline` skips settings and says so.
- `--write` copies a template (`reference/templates/repo/files/`) for each missing file. It fills `{{name}}`, `{{year}}` and `{{owner}}` (origin's repository name, else the repo directory; the UTC year; and `git config user.name`). It never rewrites a file that exists. A file that lacks a required marker, and `engines.node`, are reported for a hand edit. It writes the working tree only: no commit, no branch, and no change to a repo setting. The report prints the `gh repo edit` fix.
- A private repo's report names `${CLAUDE_PLUGIN_ROOT}/reference/templates/repo/public-flip-checklist.md`. That list covers branch protection, secret scanning, push protection, Dependabot alerts and private vulnerability reporting, which a private free-plan repo cannot turn on, as commands to run on the day it goes public.

**In a run (quest 977d3efb).** `intake` turns the check on when the repo has no CI workflow that can gate a PR (`intent.ciWorkflows` 0) or at most 3 commits on HEAD. An unread workflow count is not a trigger, and neither is a shallow clone's commit count. The trigger and its reasons are stored as `intent.greenfield` and named on touch 1. Mint then binds the manifest to WP-01: WP-00 in a one-WP run, else the first WP by wave. Every applicable manifest item that fails on the checkout adds its path to that WP's Files, and absent paths are added as Create paths. A stack's items apply when the repo has its file or the WP's Files name it. The WP's brief gets a `## Greenfield bootstrap` section telling the lane to run `bootstrap --write --offline` on its worktree and finish the hand edits. Its `land gate` runs `bootstrap --repo <worktree> --offline`. While that exits 3, or while a file the check read is not committed at HEAD, the gate fails with cause `bootstrap`, which is an amendment. Any other non-zero exit is `infra`. The gate checks files only, because a lane can't change a repo setting; the lane runs the read-only online check once and names each `gh repo edit` fix under `## Follow-ups`.
## Rotating the conductor

When your context runs high (the session-chain skill's rotation policy), hand the run to a fresh conductor with the verb. Never write the handoff by hand.

```
conduct.mjs rotate --run <dir> --why "<why now>" [--model <id> --effort <level>] [--name <successor>]
```

Run it right after a `record`, before you perform the action that record printed: the successor performs that action as given. It writes `<run>/handoff-<n>.md` from `state.json` (the phase, the pending action, every WP with its lane, PR and queued step, open touches, the authority and spend) and prints what to do next:
- **Inside herdr** (`HERDR_ENV=1` and `HERDR_PANE_ID` set; `--model` and `--effort` required) it prints a `session.mjs chain` argv with the handoff and `--log <run>/session-chain.jsonl`. Run it as your last tool call. If it exits nonzero and the successor was briefed (`callerRetirement: exit-refused`), end your turn: the successor takes custody. Otherwise run `next` from your own pane: it cancels the rotation and gives you the pending action back.
- **Outside herdr** start a fresh session with `Read <handoff> and execute it exactly.` and end your turn.

The successor's first call is `next --custody <n>` (the handoff gives it); custody never starts without it. It exits 5 when rotation `<n>` was cancelled or superseded: that session is not the run's conductor and ends its turn. Otherwise it emits **custody** before anything else, and until custody is taken `record` accepts only custody steps and every other writing verb (`ratify`, `reset-wp`, `ci-checks`, `lane spawn`, `upgrade-root`) exits 5:
1. Retire the predecessor: `session.mjs retire <its pane> --mode close --expect-session <its session>`; if that exits nonzero, `--mode exit+close`. The session comes from the chain row in `<run>/session-chain.jsonl` for this handoff and pane, so a pane id herdr has reissued to another agent is never retired. If both fail, if no chain row names the session, or if the predecessor ran outside herdr, an `author` step asks for `<run>/custody-<n>.json`: `{ "gone": true, "evidence": "…" }` once you have seen it end, or `{ "cancel": true, "why": "…" }` when you are that predecessor and no successor took over.
2. With the Spine adapter, a `paused` receipt on the anchor naming the rotation, the handoff and how the predecessor was retired. It is skipped while a touch is filed on the anchor, so the operator's ask stays the latest receipt. A receipt that fails is logged and never blocks custody.

Then the run emits its pending action again, by the same id (a pending hand-back is consumed and read back, as on any resume), and the build polls every live lane from its queue: nothing is re-armed by hand. From the predecessor's pane, once the successor has started custody, `next` and `record` exit 5. A second `rotate` while one is open exits 5, and so does `rotate` at the showcase (the analysis is already written; a fresh session resumes with `next --resume`). Each step is an event on the `rotation` seam, so the run analysis shows the row as owned.

## Repo config

Conduct-only keys live in the workspace, keyed by the repo's GitHub identity: `<workspace>/data/config/conduct/<owner>/<repo>.json`. The workspace is `WORKIT_WORKSPACE_ROOT`, else the nearest ancestor of the repo holding both `projects/` and `data/`. `intake` reads that file once and pins it: it stores the parsed keys in `state.json` and puts the file's sha256 on touch 1, which with the Spine adapter is the anchor receipt. The build and the merge gate read only the pin. An edit to the file after intake does not reach the run. An unknown key, a key of the wrong type, a `release` that is not a valid recipe (checked even under `--release`) or a `laneSuite` in this file is exit 2 at intake. With no workspace file and no repo file, touch 1 says `Repo config: none` and names the path it looked for.

The lane-facing text goes in the repo's `AGENTS.md`, under a `## Lane suite` heading (`###` or a setext `---` underline also counts). Its body, up to the next heading or thematic break, is joined into one line (fence markers dropped) and becomes the lane-isolation line of the lane contract and its `## Run deltas` entry. Keep it to a short paragraph.

The workspace file may carry:
- `release`: the release recipe (`--release` overrides it).
- `contractPaths`: globs that raise a WP to T2. Conduct also raises agent-action
  hook and command-gate paths without a repo config entry; see `burn-down` § Per item step 3.
- `trivialExclude`: globs a tail never counts as trivial.
- `gateEnv`: env for the conductor's gate command. `{run}` and `{wp}` become the run slug and the WP id as lowercase identifiers. Use it for a repo whose suite needs its own database per runner.
- `gateBackground: true`: the gate command's action carries `background: true`.
- `laneEstimateUsd`: what the budget gate counts for each live lane and the next WP until a lane has closed (then the mean of closed lanes is used); default 15.

**Deprecated, still read:** `.workit/conduct.json` in the product repo, with the same keys plus `laneSuite`. With no workspace file it supplies the conduct-only keys as it always has: the build reads it from the checkout and the merge gate from `origin/<default>`. With no `## Lane suite` section in `AGENTS.md` it supplies `laneSuite`. Touch 1 and the run analysis's Pre-approval audit name it as a deprecated location. A run started before this split has no pin in `state.json` and reads the repo file the old way, `laneSuite` included.

## Self-hosted runs

When the target repo is the plugin running this skill, lanes never invoke `/conduct`: a lane building the skill tests it with fake executors only. The release phase runs the repo's recipe; after the plugin update, re-read the new SKILL.md and use the new script (§ The loop, "A new plugin root").

## Refusals

`intake` exits 2 and writes nothing when:

1. `--repo` is missing, or isn't a git work tree.
2. The repo has no `origin`, or `gh` can't resolve it as a GitHub remote.
3. `gh auth status` fails.
4. **The goal names more than one repo.** Only you can see this: refuse a multi-repo goal rather than pick one.
5. No lane-agent CLI (`claude` or `codex`) is on PATH.
6. A run already exists for the same slug (use `--resume`).
7. `--adapter spine` without `--anchor`.
8. With the Spine adapter, touch 1's question would be over `spine_receipt`'s 2,000-char cap. A goal over 300 chars is already cited by its file (`<run>/goal.md`, written at intake), its length and its opening line, so what remains to shorten is the release recipe or the repo path.
9. An operator passkey is configured and the Spine adapter is off: a core-only run's touches can't be signed (§ Signed authority).

## What it reuses

Pointers, not restated rules:

- `/spec` (`${CLAUDE_PLUGIN_ROOT}/skills/spec/SKILL.md`) owns depth selection, the spec and the WPs. This skill passes `--workshop` and `--preapproved` (§ Conductor flags there) and never restates its heuristics.
- `/pickup` (`${CLAUDE_PLUGIN_ROOT}/skills/pickup/SKILL.md`): the claim discipline the build phase's `spine_update currentPhase: build` follows.
- `${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs`: the herdr lane lifecycle.
- `${CLAUDE_PLUGIN_ROOT}/skills/slim-review/SKILL.md`: the paired review at a PR boundary.
- `${CLAUDE_PLUGIN_ROOT}/skills/burn-down/SKILL.md` § Per item step 3 (review at the tier the change raises) and step 4 (Land it): the tiers, delta escalation, and gate, by reference.
- `${CLAUDE_PLUGIN_ROOT}/scripts/escape-reader.mjs`: the escapes section of the run analysis.
- `${CLAUDE_PLUGIN_ROOT}/reference/templates/lane-contract.template.md`: the lane contract the build phase instantiates.
