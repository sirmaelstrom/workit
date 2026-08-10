# Run-log template — tiered-queue anchor docs

**Status:** v1 — durable home as of workit v1.15.0 (fold-in quest 5354f87e, 2026-08-10). Adopted at run-3 planning 2026-08-07 (quest eabd47ad); validated by runs 3–4. Prior canonical copy `data/outputs/projects/agentic-practice-transfer/run-log-template.md` is now a pointer to this file.
**Why this exists:** runs 1 and 2's anchor docs scaled with run length — run 2 reached ~73.5k chars, most of it prose observation entries — so the cost of joining the run rose monotonically while the oldest entries' marginal value fell to near zero. The board, receipts, quest notes, and artifacts already hold the substance; the anchor doc carries structure and pointers. (Operator observation at run-2 close; measured in tiered-queue-run2.md.)

## The rules

1. **The board is canonical for all per-quest work-state.** The doc has no status column, ever (retro §1 row 3b; unchanged from protocol v2).
2. **One row per stop in the run log.** Fielded table: `date | item | event | pointers | teach →`. Event vocabulary: `pickup / PR / review / closed / blocked / dropped / amended / run opened / run closed`.
3. **The second-sentence rule.** If a log entry wants a second sentence, the substance belongs elsewhere — file it at write time and point:
   - cross-project generalization → **auto-memory** (one-fact file + index line; normal intake bar applies — this is already the push channel that reaches every joining CLI session)
   - item-scoped fact, or a ruling that binds a later item → **that item's quest** (resume note or receipt — burn-down standing rule: bindings land at ruling time)
   - protocol change → **the /burn-down skill** (versioned, reviewed; run 2 proved narrating protocol in the doc causes rebuild attempts)
   - genuinely run-scoped cross-item ruling (rare) → **Run rulings** section, one line each
4. **Doc-only content** — the sections allowed short prose: queue order + ranking rationale, gates and window reasoning, sittings, protocol deltas vs the /burn-down standing rules, out-of-window rejections (named, with reasons — V4 discipline), bench.
5. **Watch the size at close.** At one row per stop the log stays small in *rows*; the measured erosion vector is fat rows (run 4: ~66k chars at 14 items — structure held, rows bloated). At run close, record the doc's measured size next to the prior runs' figures, same method. Add a size guard only if the format demonstrably erodes (guard-first lesson, quest 94165afb) — the counterweight here is structural (the prose field is gone), not willpower.

## Skeleton

```markdown
# Tiered Queue Run N — {one-line queue identity}

**Opened:** {date} · **Window:** {dates} · **Anchor quest:** {shortid} · **Format:** run-log template v1 (workit reference/templates/run-log.md)
**Protocol:** /burn-down standing rules (workit vX.Y) + deltas below.
**Precedence:** Atlas canonical for ALL per-quest work-state; this doc = queue order, gates, deltas, pointers.
**Summary:** {2–3 sentences: selection axes, window, what was decided at planning}

## Queue (ordered; board canonical for state)
| # | Quest (short id) | Campaign | Repo | Scope | Gate | Notes |

**Gate discipline (adopted 2026-08-09, slim-down sitting):** every Gate cell names its kind — **build-gate** (physically can't act before X; the only kind that blocks pickup) · **verify-gate** (build now; the gate date is the verification beat, calendar it) · **cadence** (batching choice; calendar item, never a blocker) · **dependency** (gated on another quest's outcome). A bare date with no kind is a defect in the queue, not a constraint. Name the *job* a date-gate binds to, and verify that binding against the live schedule — run 4's E1 gate cited the wrong cron and the correction was itself the error.

**Ranking rationale:** {short prose}

## Sittings (operator — planned, not parked)
- {quest + packet pointer + what the decision unblocks}

## Out of window / deferred (named, with reasons)
- {quest — reason; where it goes instead}
- Bench (swap-in if an item blocks): {short ids}

## Protocol deltas (vs /burn-down standing rules)
1. {only what differs this run}

## Run rulings
(one line each; rare — most rulings belong on a quest)

## Run log (append-only; one row per stop)
| date | item | event | pointers | teach → |
|---|---|---|---|---|

## Run close (written once, at the operator's close call)
- Queue accounting: {N/N accounted — landed / refuted / superseded / verified-resolved}
- Substrate score: {operator state-supplies, with row pointers}
- Catch ledger: {defect → caught by which watcher position → positions it escaped}
- Post-landing escapes: {named, with the position that finally caught each}
- Doc size, same-method: {chars / est. tokens, vs prior runs}
- Fold-back disposition: {which deltas graduated to /burn-down, which routed elsewhere}
```
