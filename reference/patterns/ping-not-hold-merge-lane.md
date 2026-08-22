# Ping-not-hold merge lane

**Decided 2026-08-21/22** (quest `4e8a7626`, planning session; operator answers verbatim in the quest trail). This pattern is the standing "said otherwise" that burn-down step 4 points at: for PRs that pass every criterion below, the merge authorization is *this document* — written, durable, citable — so no in-session go is assumed or fabricated. Everything else stays in the held lane exactly as before.

The motivating receipt: runs 5/9/10/11 all ended with every PR held for a batched operator merge-go. Run 11's batch held a fix for active data loss (the record-usage spool), so queue throughput was operator response latency even while the latency cost data.

## Eligibility — ALL must hold

1. **Gate-green in full.** Suite green in foreground, CI green on the merge ref, the item's review tier fully run (a fired T2 is never downgraded), zero unresolved findings.
2. **Easily undone** — the operator's criterion, made concrete. One `git revert` restores the world. That excludes:
   - DB schema migrations or data backfills
   - anything that acts externally (posts, broadcasts, emails, public API shape)
   - secret, config, or infra mutations outside the repo
   - destructive steps of any kind
3. **Not coupled.** No cross-repo joint merge; no shared wire-format change; not a layer of a stacked chain.
4. **Independent base.** The PR targets the default branch directly.

Any doubt at classification time → held lane. The classification and its rationale go in the run-doc row either way; that row is the audit trail.

## Behavior at an eligible boundary

1. **Preflight the ping path before merging.** From a CLI session the Discord ping is the Observatory broadcast helper (`projects/heathdev-observatory/scripts/merge-ping.ps1`); run its `-Check` mode first. A broken ping path discovered before the merge is a held-lane classification, not an incident.
2. Merge.
3. **Ping, immediately:**
   - **Discord** — the authorizing channel: what merged, which criteria it passed, the exact one-command revert. The helper is fail-closed: a non-zero exit means the ping did not happen.
   - **Push notification** — additive attention layer (adopted 2026-08-22, deliberately exploratory): the merged item + short-form revert via the session's PushNotification tool. Best-effort; a skipped or failed push never blocks and never substitutes for the Discord ping.
   - **Anchor receipt** — on the run anchor, so the board carries the merge durably.
4. Log the run-doc row with the criteria checklist.

The Discord ping always carries the undo. A merge whose Discord ping did not deliver is not a ping-not-hold merge; it is an unauthorized one — fall back to the held lane and notify the operator directly. (Channel decision 2026-08-22, quest `799302fb`, after run 12 measured the lane inoperable from CLI sessions: Discord = authorizing + durable, push = additive; operator answers in the quest trail.)

## Explicitly out of the lane

- **Stacked chains — always held.** Decided with reluctance: chains have been the most trustworthy-feeling runs precisely because once locked in they just run, and always-hold fights the operator's stated aspiration ("involved in fewer places for longer periods"). It holds anyway because reverting the middle of a chain is not easily undone, and the squash + `--delete-branch` downstream-closure trap is measured. The tension is tracked as its own work, not solved here.
- **Deploy — merge-only for now.** The lane stops at the merge; deploy stays an owed receipt plus ping. Extension past merge-only is gated on an agent-attended deploy mechanism: bounded troubleshoot after restart, automatic rollback when the bound is hit. That gate is a quest, not a promise — until it lands, no unattended deploy.

## Worked example — run 11 replayed under this policy

Seven PRs held at the batch: obs #491→#492→#493 (stacked), #494/#495/#496 (independent), claude-config#1 (cross-repo coupled to #496). Under this lane: #494, #495, and #496 (the data-loss fix) merge same-day with pings; the chain and claude-config#1 hold for the operator. The data-loss window shrinks from days to one ping latency.
