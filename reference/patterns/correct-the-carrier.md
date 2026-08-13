# Pattern: correct-the-carrier

**What:** Fixing a stale claim means landing the correction on every artifact that **carries** it — auto-loaded surfaces first — and leaving a receipt (resolved value, timestamp, verification) in place of the warning. Filing the lesson is not fixing the corpus.

**When to use:** The moment a stale factual claim surfaces in any artifact — deploy state, config values, "not yet live" warnings, inventory facts. Distinct from `corrections-loop` (agent-mistake graduation): this repairs *claims*; that codifies *behavior corrections*.

## The Repair

1. **Grep for ALL carriers** asserting the claim — not just the one in front of you. Search the bare token.
2. **Prioritize auto-loaded surfaces** (daily notes, MEMORY.md, quest resume notes, CLAUDE.md) over read-on-demand ones (KB, archived lesson indexes, outputs). A correction in a file nobody loads at the moment of the next error is inert — and so is one corrected carrier sitting beside an uncorrected one.
3. **Receipt in place of warning:** record the resolved value, its timestamp, and how it was verified. A warning has an expiry nothing enforces; a receipt does not expire.
4. **Name the unverified half.** When part of a finding is checked and part inherited, say which is which — a true half laundering a false half spends credibility it did not earn.

## The Canonical Failure (why this exists)

2026-07-27: a daily note read "⚠️ Not yet live — needs `pm2 restart`" — true for four minutes, stale for seventeen hours. It propagated four hops (overnight-threads → friction briefing, which promoted it to a flagship *"Verified unresolved"* item → a chat session repeating it as fact) while ground truth was one `pm2 jlist` away at every hop. Between hops three and four, a session found the truth, filed a lesson, and corrected the quest resume note — then left the auto-loaded daily note untouched. The last hop fired anyway. One corrected carrier is not a corrected corpus.

## Execution Feedback

*(Append results here)*

---
*Source: DOCTRINE.md → Externalized Intent → Correct the Carrier — pushed down 2026-08-13 (quest 3ad4a77a).*
*See also: `canonical-doc-contract` (the conventions that prevent the copy in the first place), `transition-sweep`, `corrections-loop` (different failure class)*
