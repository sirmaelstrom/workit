---
name: conduct
description: "Take a goal end to end: spec, parallel lanes, review, merge, analysis, two touches. Trigger: /conduct. Not for one quest (pickup) or a queue (burn-down)."
---

# Conduct — take a stated goal end to end

`/conduct "<goal>" --repo <abs path to a git checkout>` runs a goal from intent to a merged, analyzed result: it specs the goal, splits it into work packages (WPs), builds each in its own lane, reviews and merges each PR, runs the release recipe if the repo declares one, and writes a run analysis. The operator is asked twice: **touch 1** before `/spec` runs (what authority the run has) and **touch 2** at the showcase (accept, accept with notes, or send back). A third touch, the blocked stop, opens only when a fork can't be settled from evidence.

You drive a one-shot state machine, `${CLAUDE_SKILL_DIR}/scripts/conduct.mjs`. Each verb reads `state.json`, does one bounded thing, writes state and exits. The conductor is you, repeating **intake → next → perform → record**; the run's state is the files under its run dir, not your context, so a rotated conductor resumes with `--resume <run dir>`.

```
/conduct "<goal>" --repo <abs path>
         [--anchor <quest id>]        # Spine adapter: the goal's quest
         [--budget <usd>]             # proposed in touch 1; default 25
         [--lanes <1|2>]              # concurrent lanes per repo; default 2
         [--agent claude|codex]       # lane agent CLI; default: the first found
         [--adapter <name>]...        # declare spine | council | kb | verify
         [--no-adapter <name>]...     # force the core path for an adapter
         [--release <json file>]      # a release recipe; else the repo's .workit/conduct.json
         [--runs-root <dir>]          # where the run dir goes
/conduct --resume <run dir>           # continue a run
```

## The loop

1. **Start.** Run `node "${CLAUDE_SKILL_DIR}/scripts/conduct.mjs" intake --goal "<goal>" --repo <abs> …` with the flags above (declare adapters first, § Adapters). It prints `{ ok, runDir, action }`. On the core path the first action is touch 1, a `touch`. With the Spine adapter the first action reads the anchor quest, and touch 1 follows as a receipt, a read-back and, while no answer is attributed, a hand-back (step 2, `touch`). Exit 2 is a refusal (§ Refusals) and writes nothing.
2. **Perform the action.** Every action has an `id`, a `kind`, an `instruction` a person could follow, and an `expects` field. What you do depends on `kind`:
   - `shell`: run its `command` argv exactly as given, from `cwd` and with `env` added when present. Record `{ "code": <exit>, "stdout": "…", "stderr": "…" }`. `background: true` marks a command that can outlast a foreground shell (a repo's long gate suite): start it in the background, wait for it to exit, and record the same result. The `lane`, `land` and `analyze` verbs (`lane spawn`, `lane check`, `land gate`, `land merged`, `analyze`) reach you only this way: `next` never runs a program, so every check is a `shell` action whose printed result you record. `land gate` exits 6 while CI is still running or a pipeline review of the head is in flight; that is a wait.
   - `agent-tool`: call the named MCP `tool` with `args` and record its raw JSON result. These are emitted only for an adapter that is on.
   - `skill`: invoke the named skill with `skillArgv`, one argument per element (`skillArgs` is its display form), **from the target repo's root** (cwd = the run's `--repo`): `/spec` takes its project from the cwd and doesn't ask. For `/spec`, record the JSON the action's `instruction` describes, composed from its report: `depth`, `workshopDir`, `reviewLevel`, and the `gateCommand` (depth `none` or `lite`). A deep run's WPs come from `work-packages/` in the workshop, not from the record. `expects.fields` lists only the minimum. Under the pre-approval no gate shows the spec's `[ASSUMPTION: …]` flags to a person: read the `**Assumptions:**` line of `/spec`'s final output and carry those flags into the showcase by naming them when you present it.
   - `author`: write the file at `outPath`: from `template` with the `slots` filled, or as the instruction describes (the grant at `touches/1-grant.json` from the operator's (c) text, a ruling at `rulings/<wp>-<n>.json` for a lane's question, a lane brief, an amendment). Record `{}`.
   - `inspect`: the one judgment step at the merge gate. Run the diff argv in `command` (the post-cap tail: commits added after the last review), read it against the findings the action names, and record `{ "verdict": "addresses-findings" | "unrelated-change", "tail": "<the action's tail>", "head": "<the action's head>" }`. `unrelated-change` holds the PR.
   - `touch`: stop and tell the operator what the instruction says.
     - **Core path:** record `{}` after they have answered. An unanswered touch returns the same action with `answered: false`.
     - **Spine path:** a touch is receipt → read-back → hand-back. The hand-back (`handBack: true`) comes when a read-back finds no answer to this run's filing, including another run's answer to the same tag. An answer to this filing that can't be used is handled differently:
       - An answer that isn't stamped `operator:` is refused: `record` exits 3, and the touch is re-filed (`filing + 1`).
       - An operator answer whose key isn't an option reopens the touch: `record` exits 0, and the touch is re-filed with the reason.
       - An operator answer with no key and free text is option (c), when the touch has one.

       After a re-file, the hand-back comes at the next read-back that still finds no answer. The hand-back ends your turn: tell the operator the touch waits for them in the Dogan, then stop, and don't poll. Never record a hand-back; `record` returns it unchanged with `answered: false`. To resume, run `conduct.mjs next --resume <run dir>`. Its first action is the read-back again. An answered read-back moves the run on, and an unanswered one hands back again. The build is the exception: it keeps re-reading a blocked touch every 5 minutes, between its other work, while anything else can still act. That means a lane poll, a WP's re-admission timer, or a meter re-read when `WORKIT_SPEND_CMD` is set. The build hands back only when a touch is waiting and nothing else is left to wait on except other touches or a meter that can't run.
   - `wait`: wait `waitMs`, record `{}`, then run `next`.
   - `done`: the run is over. A `done` action is never recorded.
3. **Record it.** `conduct.mjs record --run <dir> --action <id> --result '<json>'` (or `--result-file <path>`). It prints `{ ok, phase, action }`, the next action: loop to step 2. Re-recording the last recorded id is a no-op; any other id that isn't the pending one is exit 5. `--manual` marks a step you did by hand, so the analysis counts it as crossed by hand rather than owned by the skill. Exit 2 is an invalid result; fix it and record again. Exit 3 is a refused answer, and the next action re-files the touch. **A failure whose JSON output carries a `recorded` field** (the action id; exit 1, or the failing step's own code) means the record landed durably and a later step failed: don't record again with a different result. Run `next` (or re-send the same record, a no-op replay) to get the next action.
4. **Resume.** `conduct.mjs next --run <dir>` (or `next --resume <dir>`) returns the pending action again, with one exception: a pending hand-back is consumed and the read-back is emitted in its place. `conduct.mjs status --run <dir>` prints a summary.

**Exit 4** means this installed version lacks a phase handler or module the run needs (the verb names the path, e.g. `lib/analyze.mjs`): the later phases ship in a later version. Stop and report the path; don't write state by hand to get past it.

**A new plugin root.** After a self-hosted release (§ Self-hosted runs) a verb can exit 2 naming a new plugin root. Re-run it with that root's `skills/conduct/scripts/conduct.mjs`, and re-read that root's SKILL.md before the analyze and showcase steps: the text you loaded is the old version.

**Where a run lives.** The workshop is `<runs-root>/<slug>/` with `--runs-root`; else `<workspace>/data/outputs/workshops/<slug>/` under `WORKIT_WORKSPACE_ROOT` or the nearest ancestor of `--repo` holding both `projects/` and `data/`; else `~/.workit/runs/<slug>/`. The run dir is `<workshop>/run/`: `state.json`, `events.jsonl`, `touches/`, `rulings/`, the run's lane contract `_lane-contract.md`, per-WP lane briefs and reports (`lane-<wp>.md`, `lane-<wp>-report.md`), `reviews/`, `council/` and, at the end, `run-analysis.md`. `/spec` writes its workshop files beside it. Lane worktrees sit beside the repo, never in the run dir.

## Adapters

The **core** runs with `git`, `gh` and one lane-agent CLI. An adapter replaces a core mechanism with a richer one when present.

- **Declared by you.** A script can't see your MCP tools, so declare an adapter only when **every** tool it needs is callable in your own tool list; a partial set means the adapter isn't declared. Intake records each declaration with its evidence (`declared`).
  - `spine`: `spine_quest`, `spine_update`, `spine_receipt`, `spine_author`.
  - `council`: `council_review`, `council_synthesize`, `council_challenge`.
  - `kb`: `kb_search`, `kb_save`.
  - `verify`: the workit `verify` skill, when it covers the repo's surface.
- **Probed.** `intake` probes herdr (`HERDR_ENV=1` and `herdr agent list` exits 0; used only for a repo inside a projects tree), `notify` and `spend`, and the agent CLIs. `notify` and `spend` are optional shell strings in `WORKIT_NOTIFY_CMD` and `WORKIT_SPEND_CMD`; each is on when set and its program resolves, and off otherwise (on Windows a string holding a double quote is refused). `WORKIT_NOTIFY_CMD` runs after a merge and receives the PR number, the merge sha and a revert command in `WORKIT_NOTIFY_PR`, `WORKIT_NOTIFY_SHA` and `WORKIT_NOTIFY_REVERT`. `WORKIT_SPEND_CMD` is run with the run's start time (ISO) appended and prints the USD spent since then.
- **`--no-adapter <name>`** forces the core path for one adapter; the names are `herdr`, `notify`, `spend`, `spine`, `council`, `kb` and `verify`. For a run on the core path alone, declare none and pass `--no-adapter herdr --no-adapter notify --no-adapter spend`. `claude` and `codex` are agents, not adapters; `--no-adapter claude` is a usage error.
- **kb is declared-only.** There is no probe for kb, so pass `--adapter kb` to turn it on; leaving it to detection leaves it off.
- **kb has no script path.** With kb declared, run `kb_search` on the goal at intake and, once the showcase is answered, `kb_save` of the run's decision record (what the run decided and why, the alternatives it rejected, and the run dir), as your own steps.
- **spine needs `--anchor`.** Choose or author the goal's quest first, then run intake with its id.

## Touches

Every touch step's action and event, `resumed` included, carries the seam `operator-touch`. The one exception is the release anomaly's touch, the blocked touch opened when the release PR's merge is flagged (`land merged --wp release` exits 5). While the release waits on that touch, every touch action it emits carries `release`, and so do their events. That covers the anomaly touch's receipt, read-back and hand-back. It also covers the read-back and hand-back of a touch still filed ahead of it, which the release emits first. The run analysis reports touches in their own `Touches` section, not as a seam row, and `operator-touch` isn't a send-back seam name.

1. **Touch 1, before `/spec`.** Options: (a) approve as proposed, (b) approve but hold at PR boundaries, (c) approve with changes (free text), (d) decline. The answer is the run's only source of merge, release and budget authority. After a (c) answer, an `author` action has you write `touches/1-grant.json` from the operator's text, each field no wider than (a); if the text doesn't settle a field, write `{ "ambiguous": true, "why": "…" }` and the run asks again. A repo with no CI workflows that can gate a PR is offered hold-at-PR only. Without the spend adapter the budget is **unmetered** and is enforced against the lanes' own cost, a lower bound.
2. **Touch 2, the showcase.** After `analyze`. (a) accept, (b) accept with notes, (c) send back: write `seam: <name>` in the text (an unknown name records no seam). A (c) ends this run as `sent-back`; nothing re-runs and merged work isn't touched again. Reopening is a new `/conduct` run whose goal cites the old run dir. The question lists every open PR and every `held` or `deferred` WP.
3. **Touch-1 (b) holds, it doesn't deadlock.** A WP that passes its gate without merge authority ends `held` (PR open, merge lock released); its dependents are `deferred`; the run still reaches the showcase.
4. **Blocked stop.** A WP goes `blocked` with a cause (`error`, `dialog`, `needs-conductor`, `deadline`, `admission` or `cleanup-unresolved`) when a lane asks something evidence can't settle, its deadline passes, a repo-scope fork appears, or the budget cap is reached. It is counted as a touch. Other WPs not depending on it keep going, and the build doesn't end while a blocked touch a WP owns is open. An attributed answer resumes that WP at its `check` step.
5. **A lane's question is ruled by you first.** From the lane's `## Needs conductor` ask, settle it from evidence and write `rulings/<wp>-<n>.json` as `{ "ruled": "<key>", "evidence": "…" }`; write `{ "escalate": true, "why": "…" }` only when no evidence can settle it. Only an escalation opens the operator's blocked touch.
6. **Never advance without an attributed answer to that touch's tagged question.** With the Spine adapter, a touch is a `needs_input` receipt on the anchor whose question begins `[conduct <slug> touch <n>] (run <runId>/<filing>)`; the read-back accepts only an answered receipt to that filing, stamped `operator:`. An answer by anyone else, or with a key that isn't an option, confers no authority: the touch is re-filed (`filing + 1`) with the reason. A quest leaving WAITING is never an answer.
7. **The core-path `answer` command is the operator's, never yours.** Without the Spine adapter, a touch is `touches/<n>.md` plus the exact `conduct.mjs answer --run <dir> --touch <n> --key <a..f> [--text "…"]` command, which the operator runs from their own terminal. It refuses a non-TTY stdin, so your Bash tool can't run it. Don't try to work around that refusal.
8. **The approval boundary is procedural.** The TTY guard and the `by` attribution are a procedural boundary for v1, not proof of the operator's identity.
9. **The budget touch.** When spend reaches the budget, a blocked touch opens that no WP owns. (a) needs the text `budget <USD>` above the spend at the halt (`$` and thousands commas allowed): it becomes the budget and metering continues. (b) stops new paid lane work (no dispatch, lane start, prompt or fallback); PRs already up are still reviewed and still land.
10. **The meter halt.** With the spend adapter on, an unreadable spend reading or an unset `WORKIT_SPEND_CMD` halts dispatch on its own. Only a successful reading clears it. With `WORKIT_SPEND_CMD` set, the meter is re-read every 5 minutes. With it unset, the meter is never re-read. The build waits on the budget touch, and the spine path hands back. Once that touch is answered, the build still polls every 5 minutes; that is a known gap. The meter reads again only after the variable is set in the conductor's environment and the run is resumed.
11. **The `liveness` touch is a blocked-touch cause too.** When an exec lane's exit can't be verified past its deadline (three reads), its WP keeps the lane slot and Files and a `liveness` touch opens: (a) you confirm the process is gone, so the slot and Files are released and the WP keeps its state; (b) they stay held.
12. **No CI at head is never an amendment.** A repo with no workflow that can gate a PR stops at once; otherwise the gate waits 30 minutes per head for CI to appear, then stops. The stop is `held` (`held at PR: <reason>`) without merge authority, and `blocked` with it.

## Runtime verification is part of done

> **Runtime verification is part of done.** A change that alters runtime behavior is exercised at runtime before the PR boundary, and the report quotes the command and what was observed. A runtime check must be able to fail: say what it would have shown if the change were broken, or run it once against the pre-change tree — otherwise it is vacuous and is reported as such. Where the claim is visual, one screenshot per claim, of the critical state only; evidence is a few decisive pictures, never a gallery. Code-only verification of a runtime change is reported as **not exercised at runtime**, never as done.

Every lane brief carries this rule. Each WP's `**Runtime exercise:**` field names the surface (a CLI run against a real input, a service probed, a page loaded, or `none: <why>`) and the check; an empty field means the lane names the surface itself, and it doesn't authorize `no runtime surface`: only a field that begins `none` (case-insensitive) does, and the expected form is `none: <why>`. A waiver with no reason passes the gate but is reported as one. The lane writes the evidence under `## Runtime exercise` in its report, with a `Verdict:` line and, for `exercised`, a `Would have shown:` line. A missing section, `not exercised` for a WP that names a surface, or a `vacuous` check (unless the WP says `none`) fails the lane's check, and the lane gets an amendment before review. The workit `verify` skill is an optional adapter: when it covers the repo's surface, a WP's runtime exercise may name it, and its verdict artifact is the evidence.

## Self-recovery before a blocked stop

Try these first. A blocked touch is for what they can't settle.

- **A failed review seat:** re-run it once; then use a seat outside the author's model family, never one the operator excluded.
- **Red CI:** name the oracle that failed, and rerun a flake. CI still running is a `wait`, never a failure.
- **A stuck lane:** read its pane or log, re-arm the wait, then amend. A lane keeps its slot and its files until its process is observed exited, so don't start another WP on its files while it runs.
- **A harness dialog** (a `block` with cause `dialog`): the verb re-polls once after about a minute, then blocks. **Never answer a harness dialog yourself**: not by sending keys, not by approving. It goes to the operator in the blocked touch.
- **A council split:** you break the tie, inside the goal's bindings, and record why.
- **A refuted premise:** a lane whose report says `refuted` ends its WP `refuted` and defers its dependents; that is a finding, not a failure to retry.

## Repo config

The target repo's `.workit/conduct.json` may carry, beside `release`:
- `contractPaths`: globs that raise a WP to T2.
- `trivialExclude`: globs a tail never counts as trivial.
- `laneSuite`: the lane-isolation line of the lane contract.
- `gateEnv`: env for the conductor's gate command. `{run}` and `{wp}` become the run slug and the WP id as lowercase identifiers. Use it for a repo whose suite needs its own database per runner.
- `gateBackground: true`: the gate command's action carries `background: true`.

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

## What it reuses

Pointers, not restated rules:

- `/spec` (`${CLAUDE_PLUGIN_ROOT}/skills/spec/SKILL.md`) owns depth selection, the spec and the WPs. This skill passes `--workshop` and `--preapproved` (§ Conductor flags there) and never restates its heuristics.
- `/pickup` (`${CLAUDE_PLUGIN_ROOT}/skills/pickup/SKILL.md`): the claim discipline the build phase's `spine_update currentPhase: build` follows.
- `${CLAUDE_PLUGIN_ROOT}/scripts/lane.mjs`: the herdr lane lifecycle.
- `${CLAUDE_PLUGIN_ROOT}/skills/slim-review/SKILL.md`: the paired review at a PR boundary.
- `${CLAUDE_PLUGIN_ROOT}/skills/burn-down/SKILL.md` § Per item step 3 (review at the tier the change raises) and step 4 (Land it): the tiers and the gate, by reference.
- `${CLAUDE_PLUGIN_ROOT}/scripts/escape-reader.mjs`: the escapes section of the run analysis.
- `${CLAUDE_PLUGIN_ROOT}/reference/templates/lane-contract.template.md`: the lane contract the build phase instantiates.
