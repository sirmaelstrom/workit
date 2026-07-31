# Tracker adapter — local markdown

The bundled default tracker for `/chart`. It stores an effort as plain markdown files on disk: one map per effort, one file per open question.

This file owns **physical form only** — the byte-level shape of every file the tracker writes and the exact predicate behind every query. It owns no session policy. When to claim, how many tickets a session may take, and which agent resolves what are decided in `SKILL.md`, not here. The split exists so a second adapter (an issue tracker, a database) can be written later against the same seven verbs without re-deciding conduct.

The seven-verb decomposition and the "one question per session" framing are adapted from prior art in wayfinding-style planning tools; the physical format below is this repo's own.

## Parameter contract

The skill resolves the charts root **once**, by its own rules, and passes it into every verb as an **absolute path**.

1. The adapter **never** reads a command-line flag.
2. The adapter **never** reads an environment variable.
3. The adapter **never** re-resolves, normalizes, or second-guesses the root it was given.
4. The adapter **never** hardcodes a root — including for the listing, which enumerates under the given root like every other verb.

If a verb below cannot be performed without knowing how the root was chosen, that is a contract defect, not a case for reading configuration here.

Examples in this file write the root as `<your-charts-dir>`. That is a placeholder, never a real path.

## Canonical layout

```
<root>/<effort-slug>/map.md
<root>/<effort-slug>/issues/NN-<slug>.md
```

An effort is exactly one directory under the root. `map.md` is always present. `issues/` is created with the first ticket, not before.

## Identifier grammar

1. **`NN`** — two digits, zero-padded, `01` through `99`. Assigned as `max(existing) + 1`. Numbers are **never** reassigned, re-sorted, or gap-filled. A resolved `03` leaves a permanent gap if `03` is later deleted; that is correct behavior.
2. **`<slug>` and `<effort-slug>`** — `[a-z0-9-]+`, derived deterministically:
   - lowercase the source string;
   - replace every run of characters outside `[a-z0-9]` with a single `-`;
   - strip leading and trailing `-`;
   - if the result exceeds **40 characters**, truncate to 40, then cut back to the last `-` and strip it (truncation lands on a word boundary, never mid-word).

   The effort slug derives from the effort title; a ticket slug derives from its question.
3. **A colliding effort slug is never auto-suffixed.** Stop and ask the operator. `-2` suffixes make two efforts indistinguishable in a listing.
4. **`Blocked by:` is matched by parsed integer, never by string.** `Blocked by: 1` matches ticket `01-*`. `Blocked by: 01, 3` matches `01-*` and `03-*`.
5. **`<session-tag>`** — `[a-z0-9_-]{1,32}`. In scaffolds and fixtures use the literal `session`.

## Byte rules

Two agents handed this file must produce identical files. These rules are what make that true.

1. UTF-8, LF line endings, exactly one trailing newline at end of file.
2. Every heading is level 1 for the title and level 2 for sections, spelled and capitalized exactly as the templates show.
3. Exactly one blank line before each `##` heading and one blank line after it. No blank line between consecutive header fields.
4. No trailing whitespace on any line. An empty `Blocked by:` field ends immediately after the colon.
5. Every timestamp is ISO-8601 UTC in the form `YYYY-MM-DDTHH:MM:SSZ` — no milliseconds, no offset other than `Z`.
6. An empty section is a heading with nothing under it. Never a placeholder, never `_none_`, never `TBD`.
7. Content under `## Notes`, `## Decisions so far`, `## Not yet specified`, and `## Out of scope` is a list of `- ` bullets, one per line. `## Destination` is a paragraph, not a bullet.
8. Operator-supplied text — the effort title, the destination, a question, a not-yet-specified line — is recorded **verbatim**. Do not rewrite, expand, or summarize it.
9. `map.md` never enumerates tickets. Counts are derived at list time by scanning `issues/`, never stored.

## The seven verbs

### 1. Map — create the effort

Write `<root>/<effort-slug>/map.md`. Five sections, in this exact order, all present at creation even when empty:

```markdown
# <Effort Title>

Charted: <ISO-8601-UTC>
Last advanced: <ISO-8601-UTC>

## Destination

<one paragraph: where this effort is trying to get to>

## Notes

## Decisions so far

## Not yet specified

## Out of scope
```

At creation `Charted:` and `Last advanced:` carry the **same** timestamp.

**The header carries `Charted:` and `Last advanced:` only.** Open and total counts are derived at list time by scanning tickets and must **never** be stored as a header field — a cached count either goes stale or forces a resolve to touch a third region of `map.md`, which the resolve verb forbids.

`## Not yet specified` holds questions that cannot be *stated* yet. A vague destination is not decomposed into speculative tickets to make the map look complete; it is written down as fog and left there until it can be phrased as a question.

### 2. Child ticket — create a question

Write `<root>/<effort-slug>/issues/NN-<slug>.md`:

```markdown
# <question as a question, not a task>

Type: <research | prototype | grilling | task>
Status: <open | claimed | resolved>
Blocked by:

## Question

<the question body>
```

1. The title is phrased as a **question**, not a task. "Where do icon names come from?" — not "Investigate icon names."
2. `Type:` is exactly one of `research`, `prototype`, `grilling`, `task`. A fifth value or a typo is **rejected**, not passed through — the delegation scheme keys off this field.
3. `Status:` is exactly one of `open`, `claimed`, `resolved`. No other value is legal. A new ticket is created `open`.
4. `Blocked by:` is present but empty when nothing blocks; otherwise a comma-separated integer list.
5. `Claimed:` is **absent** at creation. It exists **if and only if** `Status: claimed`.
6. The `## Question` body restates the question in full and adds any context the operator supplied. When no context was supplied it is the question verbatim.

### 3. Blocking — declare dependencies

Blocking is expressed only through the ticket's `Blocked by:` field. There is no separate index file.

1. Write the blocking ticket numbers as a comma-separated integer list: `Blocked by: 1, 4`.
2. **Self-block is refused at creation.** A ticket may not list its own number.
3. **Cycles are refused at creation, naming the cycle** — for example, `refused: 02 → 05 → 02`. Do not write the file and then report; refuse before writing.
4. A reference to a ticket that does not exist is a **dangling reference**. It is not repaired, not dropped, and not silently ignored: the ticket stays blocked and is reported as a defect (see Frontier and List).

### 4. Frontier — select the next actionable ticket

The frontier predicate:

> `Status: open` **AND** every integer in `Blocked by:` refers to a ticket whose `Status:` is `resolved`.

1. Order candidates numerically ascending by `NN`. **First match wins.**
2. `claimed` tickets are not frontier candidates. Neither are `resolved` ones.
3. **Fail closed.** A dangling `Blocked by:` reference leaves the ticket **blocked** — it never becomes a frontier candidate — and is reported as a defect. A malformed tracker state never resolves in favor of doing work.
4. When no ticket satisfies the predicate, say so plainly and report any defects found while scanning. An empty frontier with unresolved tickets means everything is blocked or claimed, which is information, not an error.

### 5. Claim — take a ticket, or give it back

**Claim mutation.** On the ticket, set `Status:` and insert `Claimed:` directly beneath it:

```markdown
Status: claimed
Claimed: <ISO-8601-UTC> <session-tag>
```

…and append the answer stub:

```markdown

## Answer

_(in progress)_
```

The stub's bytes are owned here; *when* it is written is session policy owned by `SKILL.md`.

**Release mutation** (the inverse — a claimed ticket handed back unresolved):

1. Set `Status: open`.
2. Remove the `Claimed:` line entirely.
3. **Leave any partial `## Answer` intact** as evidence. A half-written answer is the most valuable thing an abandoned session produced; deleting it is the one unrecoverable act in this contract.

Release makes a stale claim reachable again. Without it a ticket surfaced as reclaimable in a listing would have no operation that could act on it.

### 6. Resolve — record the answer

**On the ticket:**

1. Set `Status: resolved`.
2. Remove the `Claimed:` line.
3. `## Answer` carries the real answer, replacing the `_(in progress)_` stub.

**On `map.md`, exactly two regions and nothing else:**

1. One line appended at the end of `## Decisions so far`:

   ```
   - [NN] <question gist> → <answer gist> · issues/NN-<slug>.md
   ```

2. The `Last advanced:` header field.

Gists are single-line, ≤80 chars, and contain no `·` or newline (that character is the field separator).

**No other region of `map.md` is touched during a resolve** — not to tidy, not to re-sort, not to refresh a count, not to move a line out of `## Not yet specified` that now looks answerable. Two regions. A third edit means the contract was broken, and it is what a downstream check will catch.

### 7. List — enumerate efforts under the root

Enumerate every `<root>/*/map.md`. Per map emit one row:

```
<effort-slug>  last advanced <YYYY-MM-DD>  <open>/<total> open  [STALE] [<n> reclaimable] [<n> defects]
```

1. Fields are separated by **two spaces**. The date is date-only, `YYYY-MM-DD`, taken from `Last advanced:`.
2. `<total>` is every file in `issues/`. `<open>` is every ticket whose `Status:` is **not** `resolved` — that is, `open` plus `claimed` — because the listing answers "how much is left," and `reclaimable` already surfaces the claimed subset separately. An effort with one claimed ticket reads `1/1 open`, not `0/1 open`.
3. `STALE` is present when `Last advanced:` is more than **14 days** old.
4. `reclaimable` counts tickets that are `claimed` with a `Claimed:` timestamp more than **24 hours** old.
5. `defects` counts tickets carrying **at least one** dangling `Blocked by:` reference — one count per ticket, not per reference. This is where the blocking rules' promise that dangling references are "reported in the listing" is kept, so an effort nobody advances still surfaces its rot.
6. Each bracketed flag is **omitted entirely** when it does not apply — no `[0 defects]`, no empty brackets. Present flags keep the order shown: `STALE`, then `reclaimable`, then `defects`.
7. Counts come from scanning `issues/` at list time. Never read a count from a map header; no such field exists.

## Worked example

Root `<your-charts-dir>`, effort **Search relevance tuning**, one ticket, one resolved decision, one piece of fog.

`<your-charts-dir>/search-relevance-tuning/map.md`:

```markdown
# Search relevance tuning

Charted: 2026-03-04T14:02:11Z
Last advanced: 2026-03-06T09:41:00Z

## Destination

Results for multi-word queries should rank the way a reader would rank them, without per-query hand tuning.

## Notes

- The current scorer is a single BM25 pass with no field weighting.

## Decisions so far

- [01] Which fields carry signal? → title and headings; body is noise below rank 20 · issues/01-which-fields-carry-signal.md

## Not yet specified

- Something about how synonyms interact with stemming — cannot state it yet.

## Out of scope

- Replacing the search engine.
```

`<your-charts-dir>/search-relevance-tuning/issues/02-do-we-need-a-rerank-pass.md`, claimed and in progress:

```markdown
# Do we need a rerank pass?

Type: prototype
Status: claimed
Claimed: 2026-03-06T09:41:00Z session
Blocked by: 1

## Question

Do we need a rerank pass?

## Answer

_(in progress)_
```

Its List row, scanned on 2026-03-27 (21 days after `Last advanced:`, claim older than 24 hours):

```
search-relevance-tuning  last advanced 2026-03-06  1/2 open  [STALE] [1 reclaimable]
```

## What this file does not own

- **When** to claim, how many tickets one session may take, and which agent type resolves which `Type:` — session policy, owned by `SKILL.md`.
- **How the root is chosen** and how that choice is announced — owned by `SKILL.md`. This adapter receives an absolute root and uses it.
- **Any other storage backend.** One adapter ships in v1. A second one is a decision to make deliberately, not a file to add quietly.
