---
name: failure-audit
description: "Use when auditing newly archived agent-session transcripts for delta failure modes. Trigger on '/failure-audit', 'failure audit', 'audit the new transcripts', 'delta audit'. NOT for scheduled runs or continuous scanning; use operator-pulled spot checks."
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
  Observatory's briefing collector (`projects/heathdev-observatory/src/briefings/treatment-rates.ts`) calls
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
its exact output path. Also give it the doctrine heading list for
`doctrine_refs` (`grep -E '^#{2,3} ' {workspace}/data/memory/DOCTRINE.md`).
An auditor without the list writes `[]`, and the run then carries no doctrine
signal.

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
node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/aggregate.mjs <run-dir> --doctrine {workspace}/data/memory/DOCTRINE.md
```
Writes `aggregate.json` (byClass / byModel / bySeverity / byCaught / byDoctrine /
verdicts / friction). Exits nonzero on coverage gaps — run a patch hand for the gap
digests, then re-aggregate. `byDoctrine` maps each doctrine section to its
`bite` / `no-bite` / `n-a` counts, one per failure record. It is the audit side
of the doctrine liveness join, and the quarterly doctrine review reads it by
hand. The section-id grammar that would make the key stable is still owed
(quest b74b4cfe), so a renamed heading splits its counts across two keys.
Each section counts once per failure record. Malformed refs, sections outside
the `--doctrine` heading list, repeats, and a section given two different bites
are skipped and counted (`invalid` / `unknown` / `duplicate` /
`conflictingDoctrineRefsSkipped`), never coerced. Without `--doctrine`, sections
go unvalidated and `doctrineRefsValidated` is `false`.

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

## Lesson scan

`lesson-scan` measures whether a memory's named mistake recurs when its situation
arises. It reads live Claude Code transcripts and auto-memory files. It does not
run the failure-audit fleet or change any memory.

```
node ${CLAUDE_PLUGIN_ROOT}/skills/failure-audit/scripts/lesson-scan.mjs [--memory-dir D:/Development/data/auto-memory] [--corpus-dir C:/Users/<user>/.claude/projects] [--data-repo D:/Development/data] [--out <output-prefix>]
```

Without `--out`, stdout contains JSON followed by a Markdown table. With it,
the script writes `<output-prefix>.json` and `<output-prefix>.md`. The table
gives exposed and mistake session counts on each side of treatment, the expected
after mistakes, both rates, and the verdict. The JSON also lists each
post-treatment session's delivery status.

A trap memory needs both fields in YAML frontmatter:

```yaml
situation: {regex: "OPPORTUNITY_PATTERN", scope: call}
mistake: {regex: "MISTAKE_PATTERN", scope: result}
```

Each field must use this exact one-line map, in `regex` then `scope` order.
`regex` is a JSON-quoted JavaScript regular expression source (double backslashes
inside the quoted string); `scope` is `call`, `result`, or `user`. A `call` tests
the tool name and input as JSON, `result` tests tool-result text, and `user`
tests typed user text. Invalid or duplicate fields stop the scan with a file
and line error. A memory lacking either field is reported as `not-trap`.
Regex authors must choose the situation independently of the mistake; the
scanner treats a mistake hit as exposure even if the situation regex misses.

The corpus is each project's main `*.jsonl` under `~/.claude/projects`, with
`<session>/subagents/*.jsonl` rolled into that main session. Hits split by
their own timestamps at treatment time, so one session can appear in both
windows. Treatment is the origin session's first transcript timestamp when
`originSessionId` resolves, or midnight UTC on the memory file's git first-add
day. The origin session is excluded from both windows: it supplied the lesson,
so its mistake is not a recurrence. If neither treatment time is known, that
memory is `untested` with reason `no-treatment-time`; its window counts and
rates are unavailable. The scan continues with other memories. Sessions with
no timestamp are skipped.

The scanner excludes council seats when any record's `cwd` has a
`council-seats` path segment. It excludes failure-audit fleet seats when their
first user prompt contains the fleet instruction opener or
`fleet-instructions.md`. It excludes SessionEnd summarizers when their first
user prompt contains `SessionEnd` near `summarize` or `summarise`. Any `Read`
result for a `.md` or `.jsonl` file and `git diff/show` results for files or
directories under the memory directory are quotation: the producing call and
result cannot create an exposure or mistake hit. The same applies to `rg`,
`grep`, `Select-String`, or a Grep tool call searching transcripts under the
corpus directory or files under the memory directory. Such a search excludes
the whole session, including other result hits in it. Explicit paths, bare
relative directory names, and omitted targets resolve from the record's cwd
after any preceding top-level `cd` or `git -C` (for git). A Grep call with no
`path` searches the record cwd; subagent records without `cwd` inherit their
parent session's cwd. If a preceding directory change is inside a
pipeline, subshell, or branch, the effective cwd is ambiguous and the session
is excluded as quotation. The JSON reports exclusion counts.

Delivery is `body-read` when the session calls `Read` on that memory file,
otherwise `index-loaded` when an `instructions` attachment has an `AutoMem`
entry for the directory's `MEMORY.md` and that index links the memory directly
or through a hub file, otherwise `unknown`. All sessions before
2026-09-01 are `unknown` because the archive has no dependable index-load
record for that period. Delivery describes observation, not proof that the
agent used the memory.

Rates divide mistake sessions by exposed sessions. Fewer than three exposed
sessions after treatment, or fewer than two expected mistakes at the before
rate, is `untested`. A zero before rate has zero expected mistakes and remains
`untested` under this power rule. Otherwise the verdict is `worse` at ≥1.5×
the before rate with ≥2 after mistakes, `reduced` at ≤0.5× with ≥2 before
mistakes, or `no-change`. No verdict is an admission or prune gate.

## Out of scope (separate owed work — don't fold in)

Codex-session distribution-diff and Dogan-substrate slicing are quest e8e289e1
run 2. A policy that demotes zero-hit lessons belongs to the memory-index prune
quest; this scan supplies counts, not a demotion decision.
