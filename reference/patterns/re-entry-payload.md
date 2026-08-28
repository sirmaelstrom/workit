# Pattern: re-entry-payload

**What:** A long-running quest's re-entry payload is a **router plus a document set**, never one growing note. The resume note carries live state and pointers; durable material — method, rulings, standing lessons, anything that does not change per item — is attached to the anchor as documents through the quest's own artifact tooling. The note tells a fresh session *where it is and what to read*; the documents hold *what to know*.

**When to use:** Any quest that will be picked up more than two or three times — a burn-down, a multi-item effort, a campaign whose method repeats across items. Adopt it at the second pickup, not after the note breaks. Distinct from `canonical-doc-contract`, which governs how a *document* avoids copying volatile values; this governs how a *quest* avoids becoming one.

## Why a growing note fails

A resume note has three consumers, and each imposes a different limit. A note that outgrows the smallest is already failing before anything errors.

| Consumer | What it does with the note | Effect of growth |
|---|---|---|
| Arrival injection (the session-start focus block) | truncates to a fixed character cap | everything past the cap never reaches the session — silently |
| Roadmap/board listing | carries no note body at all, only a length count | invisible either way |
| Full entity read (the pickup path) | returns the note verbatim | throws a ceiling error once note + refs + receipt exceed the payload limit |

The trap is that these fail in the wrong order. The arrival cap bites first and says nothing — a session simply receives a truncated note and proceeds as if it read everything. The hard error arrives last, long after the note stopped being read in full. **Nothing warns you in between**, so a note can spend weeks being 90% unread before anything breaks.

The limits are constants in the roadmap digest and the spine MCP. Re-measure rather than trusting a number written here; what the pattern fixes is the shape, not a threshold.

## The split

Three homes, one rule each.

- **The note — live state only.** Where the work is, what is next, what is blocked, and the pointer to the document set. Write it so the **first paragraph survives truncation on its own**: status, then the pointer. Everything a session needs to know it should go read must appear before the arrival cap, because that is the only part guaranteed to arrive.
- **Attached documents — the durable half.** Method, rulings, gate, standing lessons, glossaries, worked examples. Minted on the quest as artifacts at the moment each is born, so a fresh session walks quest → artifact without keyword search. Documents are unbudgeted and may grow.
- **Receipts — per-stop detail.** What one stop did and found. This is where audit detail belongs; it is already addressable per stop and never competes with the note for space.

The test for any paragraph in a note: *would this be identical after the next item lands?* If yes it is method, and it belongs in a document. If it changes every item, it is state, and it belongs in the note.

## How the set grows

The point is to let the payload accumulate without the note accumulating.

1. **Mint at birth.** A new document becomes an artifact on the quest the moment it exists, with a `rel` that says what it is to the work — the deliverable, the thing that caused the problem, or supporting evidence.
2. **Let documents point at each other.** The note's pointer list stays short because it names the entry document, not every file. A method document can carry its own index.
3. **Split when the method stabilizes.** The signal is repetition: the second time you write "unchanged since item 3" in a note, that content has stopped being state.
4. **Keep the note's pointer stable.** Renaming or moving the entry document breaks re-entry for every future pickup — treat it as a rename that owes a sweep.

## The tripwire

The board already reports note length on every row, next to the reference count. That number is the detector, and it is free — no new instrumentation. Name a threshold well below the arrival cap and split when a note crosses it, rather than waiting for a read to fail.

Checking it costs one board read, which pickup already performs.

## The Canonical Failure (why this exists)

A doc-rewrite quest ran sixteen items across many sessions, and each session appended what it had learned to the resume note: the operator's rulings, the method, the gate, the standing lessons, a per-item audit history. Every addition was correct and worth keeping. The note reached roughly 21,800 characters.

At the eleventh item, pickup could not read it. The full entity read refused the whole payload — note plus references plus the latest receipt — over its ceiling, and re-entry had to go around the tooling and query the database directly to recover the note.

The arrival cap had been discarding most of it long before that. Around 1,500 characters reached the session-start block, so roughly 93% of the note had not been arriving for weeks, across many pickups, with no error and no warning. The rulings that were *most* load-bearing had been added early, which put them near the top and saved them by luck rather than by design.

The repair took one pass: the durable half moved into a method document attached to the quest, and the note became status plus a pointer. It went from ~21,800 characters to ~7,900 with nothing lost — the two halves together were the same size as the original note. The full read resolved again immediately.

The lesson is not "notes get long." It is that **the note had three readers and served none of them**, and the only reader that complained was the last one to fail.

## Execution Feedback

*(Append results here)*

---
*See also: `canonical-doc-contract` (point at sources of truth, never copy volatile values — the same discipline applied to documents), `work-package` (the atomic unit a burn-down iterates), `campaign-closeout` (what happens to the document set when the campaign ends), `transition-sweep` (owed when the entry document is renamed or replaced)*
