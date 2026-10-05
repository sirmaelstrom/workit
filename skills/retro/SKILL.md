---
name: retro
description: "Retro on one to three sessions: read the real transcript and propose environment changes (checks over prose, steering no-ops, tool economy, information access), never code. Trigger: '/retro', 'retro this session', 'what would have prevented that'. NOT for fleet failure rates (failure-audit) or CLAUDE.md one-liners (/reflect)."
disable-model-invocation: true
---

# Retro — change the environment, not the code

The operator has asked for a retrospective. Read what the agent actually did in a session and propose changes to its **environment** so the next run does not repeat it. Ported from Matt Pocock's `retro` skill (mattpocock/skills v1.3.1, MIT — license note at the bottom). House deltas: transcript locations, the remedy ladder and the carriers remedies land on, the relation to `failure-audit` and `/reflect`, and the measurement rule.

Where it sits in this toolkit: `failure-audit` measures enacted failure classes across the fleet against a frozen baseline. `/reflect` looks for one imperative sentence to add to `CLAUDE.md`. Retro reads one to three sessions and asks the opposite question of the steering files: what should become a check, and what should be deleted.

## Steps

1. **Find the primary source.** The session the operator names, or the current one by default. Claude Code transcripts live under `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`; a lane's sit under its worktree's slug. The archive is `{workspace}/data/outputs/transcripts/cli-projects/`, one day behind. For a long session, digest it first:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/slicer.mjs <scratch-dir> <jsonl-path>
   ```
   Keep `<scratch-dir>` outside `data/outputs/reviews/`, where a stray `*failure-audit*` manifest would mark the session audited. Read the tool calls and their results, not the agent's summaries of them: the agent does not complain as much as it should, and the transcript shows what the prose hid.

2. **Look for candidates in these categories.** Each carries the signal that makes it worth raising.
   - **Navigation.** How long did it take to find the right file, and was there a hidden dependency between files? *Signal:* the session spent several turns locating one fact. *Remedy:* a navigation pointer in the file the agent did open.
   - **Automated checks.** Could a linter, a type check, a test, a filesystem rule or a hook have caught the mistake? Read the repo's own check command first (`package.json` scripts, the CI workflow, `.husky/`, `settings.json` hooks): a check that exists but sits unwired or silently broken is the finding, not a reinvention. A repo with no guardrail at all is a finding of its own. *Signal:* a mistake a machine could have refused.
   - **Standards for the reviewer.** Should the review tier get a rule, or lose one? Classify the violation first. A **mechanical** one (a fixed pattern, a banned API, an import shape, a file-location rule) gets a deterministic check, full stop: a lint rule, a hook, a CI job, whichever the repo already makes cheapest. Only a **judgement call** (cross-file consistency, "matches the surrounding style") goes to prose a reviewer reads. *Signal:* review missed something, or caught it late.
   - **Steering-file health.** `CLAUDE.md`, `AGENTS.md`, `~/.claude/rules/*.md`, auto-memory and the skill the session ran. Is any instruction there one the agent could not have acted on, and did a resident instruction go unconsumed? Which lines should move out to a check, a rule file loaded on a path, or a skill? *Signal:* a large steering file, or an instruction the transcript shows was present and ignored.
   - **No-ops.** Instructions that change no behavior: "write clean code", "be careful with X", a pointer to a file nothing ever opens. *Signal:* steering files are long and the session shows no trace of the instruction. The measurement rule below applies.
   - **Tool economy.** Expensive tool calls that could have been one call, a custom CLI or MCP server whose output or description burns tokens for little, a description whose contract sits past the point anyone reads. *Signal:* one tool result dominated the context, or the same large result was fetched twice.
   - **Information access.** Something the agent needed and could not reach: a service log it could have tailed, read-only access to a third-party dashboard, an environment value, a probe it had to ask the operator for. *Signal:* the agent asked for, guessed at, or worked around a fact it should have been able to read.

3. **Measure before you assert.** A finding about a steering line is a claim about behavior, so it carries its receipt: the transcript line where the instruction was present and the line where it was not followed, or a count over the archive (how many sessions opened the file the line points at). "This looks like a no-op" without a trace is an opinion; say so or do the grep. The same rule binds the remedy: name what would show it worked (a rate that drops, a check that fails on the old mistake), or label it ASSUMPTION.

4. **Rank and present.** Most serious first, each as: the evidence (quoted), the category, the remedy, and the carrier it lands on. Change nothing until the operator picks. Some findings will not matter to them; that is their call, not a defect in the retro.

5. **Land what was picked, on the right carrier.** The remedy ladder, cheapest durable form first:
   1. a check that can fail (lint rule, test, hook, CI job, the `lane check` shape check);
   2. a path-scoped rule in `.claude/rules/` or a skill step, loaded only when relevant;
   3. an auto-memory entry (cross-project) or the project `CLAUDE.md` Corrections section (project-scoped);
   4. a `CLAUDE.md` navigation pointer, and only a pointer.
   A deletion is a remedy. When a line moves to a check, remove the line; the evidence for the move goes in the commit message, not in the file (`git log -L` on the line reaches it). Correct the carrier that still asserts the stale thing in the same change.

## Do not automate this

Run it on a session where the agent did something odd, after a `diagnose` that found an avoidable cause, or on a sample when there is a free moment. Never wire it to cron or a scheduled beat: an automated retro finds false positives, keeps fixing them, and takes the repo somewhere it should not go. Fleet-scale questions go to `failure-audit`, whose scanner is the detector; this skill is the operator-pulled generator.

**Reply:** the ranked list from step 4, with the receipts; then only the changes the operator picked.

## Connection to other skills

- **`failure-audit`** — fleet delta, failure classes, treatment rates. A class retro keeps finding is a candidate for its seeded taxonomy.
- **`/reflect`** (operator command) — the one-sentence `CLAUDE.md` fix. Retro's steering-file categories run the other way: out of prose, into checks.
- **`diagnose`** — finds the cause of one broken behavior; retro asks what would have stopped the agent from causing it.
- **`audit-skills`** — scores skills against a rubric; a skill retro finds the session ran and ignored is an input to it.
- **`unslop`** — the findings list and any prose remedy go through it before they land anywhere public.

<supporting_info>

## Origin

Ported from Matt Pocock's `retro` skill — `skills/engineering/retro/SKILL.md` at github.com/mattpocock/skills tag v1.3.1. MIT-licensed; the seven categories and their signals are adapted from upstream, so the upstream copyright and permission notice is preserved at `UPSTREAM-LICENSE` in this directory. House deltas: upstream's step 1 call to `writing-for-agents` replaced by `unslop` at the reply; `CODING_STANDARDS.md` generalized to the review tier's rules; transcript locations, the slicer digest, the measurement rule (step 3), the remedy ladder and carriers (step 5), and the Connection section added. Upstream's `disable-model-invocation: true` kept — this stays user-invoked.

</supporting_info>
