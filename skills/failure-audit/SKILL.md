---
name: failure-audit
description: "Run a delta failure-mode audit over agent-session transcripts archived since the last run — slice new sessions into digests, fan out calibrated auditor waves, aggregate, and run the standing comparisons (treatment check on applied guards, model drift, new-label emergence). Trigger on '/failure-audit', 'failure audit', 'audit the new transcripts', 'delta audit'. Operator-pulled SPOT-CHECK only: deterministic scanners cover the watched-class rates continuously, so pull the fleet only when scanners or operations surface something semantic worth auditing. Never schedule this."
---

# Failure audit — delta-run cadence over archived transcripts

Measure **enacted** failure modes in real agent sessions: what the fleet actually
did wrong, with in-digest evidence — not what it talked about. Each run audits
only sessions **new since the last run** (a delta, never a re-run), then compares
against the frozen baseline so guards can be judged as treatments: a guard whose
failure-class rate doesn't drop is a failed treatment.

**Cadence doctrine:** scheduled beat = detector, not generator. Scanner-first
since the 2026-08-21 value review (`data/outputs/reviews/2026-08-21-failure-audit-value-review.md`):
`scripts/treatment-scan.mjs` measures the grep-shaped watched classes
deterministically (Observatory's maintenance briefing reports its rates), and
the LLM auditor fleet is an operator-pulled spot-check — not a backlog-band
routine. Rare-serious classes are statistically unauditable at practical
windows (~395 sessions for the needs_input class); they get mechanical guards
and same-session incident capture, not fleet measurement. Never wire any part
of this to cron.

## Substrate and layout

- **Archive** (the corpus): `{workspace}/data/outputs/transcripts/cli-projects/`
  — additive daily pull of Claude Code session `.jsonl` (data-sync step 4b).
  The archive trails live sessions by up to a day; that is why the running
  session can never be in its own delta (see preflight).
- **Run dirs**: `{workspace}/data/outputs/reviews/<YYYY-MM-DD>-failure-audit-*`.
  A run dir's `manifest.json` **is** the audited-session list; the union of all
  manifests is what has ever been covered. Baseline (frozen, never edit):
  `2026-08-11-failure-audit-data`.
- **Count contract** (which sessions are auditable) lives in `scripts/delta.mjs`
  and nowhere else — `treatment-scan.mjs` imports its constants, and
  Observatory's briefing collector (`src/briefings/treatment-rates.ts`) calls
  `treatment-scan.mjs`'s exported `runScan()` directly, so there is no mirror to
  keep in agreement (the old `audit-backlog.ts` count mirror retired 2026-08-21,
  quest c9c1c459). Clauses: depth-2 `*.jsonl` only (`subagents/` are
  sidechains), > 1 KB (stubs skipped), Temp-scratchpad lanes excluded, minus
  every prior manifest, bounded to mtime after the last run's date.

`{workspace}` is the directory containing `projects/` — resolve it from
`WORKIT_WORKSPACE_ROOT` or pass `--workspace-root`.

## Protocol

**0. Preflight.**
Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace-preamble.mjs` if the
environment hasn't been measured this sitting. Then instrument quarantine: after
step 1, grep the delta list for the current session's own id and require **zero
hits** (the archive lag makes this structural, but verify — an experiment that
can see itself contaminates itself).

**1. Delta.**
```
node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/delta.mjs --workspace-root <abs>
```
Creates the run dir and writes `delta-list.txt` + `run-meta.json` (counts of
skipped stubs/lanes stated, never silent). **Exit 2 = empty delta** — report
"nothing to audit since <date>" and stop; an audit over zero input must never
read as a clean pass.

**2. Slice.**
```
node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/slicer.mjs <run-dir> --list=<run-dir>/delta-list.txt
```
Writes `digests/` + `manifest.json`. ⚠️ The manifest marks these sessions
covered to every future delta run the moment it exists — if you abandon a run
before the fleet finishes, trash the run dir (or rename it away from the
`*failure-audit*` pattern) so unaudited sessions don't hide behind it.

**3. Auditor waves.**
Fleet contract: `fleet-instructions.md` in this skill dir — the **living copy**
(schema v2 + seeded taxonomy; the baseline's copy is frozen provenance). Sonnet
auditors, hands of ~5 digests, ~5 auditors per wave, results to
`<run-dir>/fleet-results/W<n><A-E>.json` — give each auditor its digest list and
its exact output path.

- **Wave 1 is calibration:** include one hand that re-audits 2 digests from the
  *prior* run with known findings. Prior runs may not have preserved `digests/`
  (the baseline didn't — measured on run 1): regenerate them from the archive
  with `slicer.mjs` into a scratch dir **outside**
  `{workspace}/data/outputs/reviews/`, where a stray `*failure-audit*` manifest
  would double-count them. Route the calibration hand's output to
  `<run-dir>/calibration/`, **never** `fleet-results/` — the aggregator counts
  what it finds there (and since run 1 skips non-manifest digests loudly).
  Gate the remaining waves on recall of the known findings with matching labels
  and verbatim quotes (baseline precedent: W1E 5/5; run 1: 5/6 with the miss on
  the count-3+-instances label). Calibration digests are re-reads — they don't
  join the new manifest.
- **Per-wave validation before the next wave:** (a) coverage — every assigned
  digest has a session entry (count *valid* entries, not entries); (b) verbatim
  spot-check — grep one `evidence_quote` against its digest; (c) record wave
  status + totals in `<run-dir>/state.json`.

**4. Aggregate.**
```
node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/aggregate.mjs <run-dir>
```
Writes `aggregate.json` (byClass / byModel / bySeverity / byCaught / verdicts /
friction). Exits nonzero on coverage gaps — run a patch hand for the gap
digests, then re-aggregate.

**5. Standing comparisons.**
```
node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/compare.mjs --baseline <prior-run-dir> --current <run-dir>
```
Three reads, every run:
- **Treatment check** — per-guard watch classes, rate per 100 sessions vs the
  window the guard shipped in. Current watch list (edit as guards land):
  `self-approved-gated-action` must → 0 (needs_input read-before-act guard,
  obs#465 + workit#26); `shell-string-code-write` ↓ (global class rule);
  `harness-protocol-repeated` ↓ (lesson filed 2026-08-11). A watched class whose
  rate holds or rises = **failed treatment** — lead the report with it.
- **Drift** — byModel × class distribution vs baseline. Meaningful on
  model-family change; compare paired windows and state the n basis for every
  rate (a rate without its denominator is not a measurement).
- **New-label emergence** — labels outside the seeded taxonomy are the semi-open
  contract surfacing new failure modes. Labels that recur or carry evidence get
  merged into the seeded table in this skill's `fleet-instructions.md` (with a
  dated note); one-off synonyms get folded into an existing label instead.

**6. Receipts.**
Ledger event (thread `failure-audit`, run counts + headline findings), KB save
for non-obvious findings, spine artifacts on the owning quest if one exists.
(The maintenance briefing's treatment-rates line is unaffected by fleet
coverage — it windows by guard epoch, not by manifests.)

## Cost and scale

~25k sonnet tokens per audited session ≈ 2.5M per ~100-session sweep. No
standing cadence: the treatment scanner is free and continuous; a fleet pull is
justified by a semantic question (new-label emergence, a scanner anomaly, a
model-family change), not by an unaudited-session count.

## Out of scope (separate owed work — don't fold in)

Codex-session distribution-diff and Dogan-substrate slicing are quest e8e289e1
run 2. The inverse per-lesson join (zero-hit lessons as demote candidates)
belongs to the memory-index prune quest.
