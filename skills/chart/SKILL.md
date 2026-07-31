---
name: chart
description: "Map a long-running effort as a decision tree on disk — a destination, the open questions beneath it, and one question resolved per session. Trigger on '/chart', 'chart this effort', 'map out this decision', 'what should I decide next', 'advance the chart', 'record an answer'. This is DECISION MAPPING, not data visualization — for a bar chart, graph, plot, heatmap, or dashboard use the dataviz skill instead."
disable-model-invocation: true
---

# Chart — decision mapping across sessions

`/chart` keeps one effort's open questions on disk so a later session can pick up
the next one and answer it without re-deriving the plan. It is a **scheduler over
primitives that already exist**: it decides *which question is next* and hands the
answering to `grill-me`, `prototype`, or `parallel-explore`.

This is deliberately **not** a speed play. One question per session is the point —
more sessions, each with one decision in it, is the shape being bought.

## Every invocation announces two things

Before doing anything else, state **the resolved charts root and the rule that
produced it**, and **which tracker adapter you used and the path you resolved**.
Every mode, every time, including the fall-through cases. Announcing an inference
beats making one silently.

### Root resolution — three rungs

1. `--chart-root <path>` — explicit argument.
2. `$WORKIT_CHART_ROOT` — per-machine environment variable.
3. `./.scratch/` — repo-relative fallback.

A **silent** fall-through to rung 3 is forbidden. Say which rung fired. Ambient
resolution that nobody was told about is exactly the failure this announcement
exists to kill.

Resolve the root **once**, then pass the absolute root into every adapter verb.
The adapter reads no flag and no environment variable of its own.

### Adapter discovery

1. If `.claude/chart-tracker.md` exists in the **invoking session's repo**, it wins.
2. Otherwise use the bundled `${CLAUDE_SKILL_DIR}/trackers/local-markdown.md`.

Resolve `.claude/chart-tracker.md` relative to the **invoking repo root** — the
same basis as `.claude/settings.json` — and **never** relative to the charts root,
which may point outside any repo. Configuration discovery and artifact placement
are structurally different things; do not collapse them.

## The seven verbs

Every tracker operation is one of these seven, and each delegates to the adapter
for physical form — file layout, templates, mutation bytes, query predicates.
**Read the adapter before performing any operation and follow its templates
literally.** Never construct, glob, or name a path yourself.

| Verb | Does |
|---|---|
| **Map** | Create an effort's map. |
| **Child ticket** | Create one question under an effort. |
| **Blocking** | Declare and read dependencies between tickets. |
| **Frontier** | Select the next actionable ticket. |
| **Claim** | Take a ticket, or release it back. |
| **Resolve** | Record an answer and advance the map. |
| **List** | Enumerate efforts under the root. |

The listing is the **List** verb. It is not a glob and not a path this file knows.

## Modes

| Invocation | Mode |
|---|---|
| `/chart` | **List** every map under the resolved root — age, open/total, stale/reclaimable/defect flags. |
| `/chart new <destination>` | **Chart** a map. |
| `/chart advance [<effort>]` | Claim the frontier ticket and resolve it. |
| `/chart record <effort> <NN>` | Write back an answer produced outside the session. |
| `/chart release <effort> <NN>` | Return a stale claim to `open`. |

1. Bare `/chart <text>` with a non-keyword argument is read as `new`, and **state
   that interpretation** rather than acting on it silently.
2. If that `<text>` matches an existing effort slug, **stop and ask.** Do not guess
   between "open that map" and "create a colliding one."
3. `advance` with `<effort>` omitted: exactly one map → use it; two or more → the
   one with the newest `Last advanced:`; none ever advanced → **list the candidates
   and ask.** Announce which map you selected and why, in all three cases.
4. `new` takes the effort **title** from the destination's leading clause — up to
   the first comma, period, or subordinating conjunction — trimmed of trailing
   punctuation. The remainder is not discarded: evaluate it for fog. **State the
   title you derived**, since the effort slug follows from it.

## Session sequence — `advance`

1. **Claim the ticket** — `Status: claimed` plus `Claimed:`. This is the session's
   **literal first write**, before any deep read of the ticket body. That ordering
   is what bounds the accepted double-claim window.
2. **Write the `## Answer` stub** — the **second** write, before any resolution
   work begins. This is what makes a mid-resolution death survivable: the session
   leaves a partial answer, never nothing.
3. **Invoke the delegated skill** for the ticket's `Type:`, streaming findings into
   `## Answer` as they land rather than buffering them to the end.
4. **On convergence** — `Status: resolved`, remove `Claimed:`, apply the adapter's
   two map mutations. Two regions, never a third.

## Session sequence — `record`

For an answer produced outside this session. Behavior is keyed to the ticket's
state on entry:

| Ticket state on entry | Behavior |
|---|---|
| `resolved` | **Refuse.** Already answered — report and stop. |
| `open` | Claim first, write `## Answer`, then resolve. (Fresh-handoff path.) |
| `claimed`, `Claimed:` **< 24h** | **Refuse by default** — another session may be live in it. Proceed only on explicit operator confirmation naming the ticket. |
| `claimed`, `Claimed:` **≥ 24h** | Accept. **Resume** the existing partial `## Answer`; do not overwrite it. |

On completion, `record` applies the same two map mutations as `advance`, and never
a third region.

## Session sequence — `release`

Set `Status: open`, remove `Claimed:`, and **leave any partial `## Answer` intact.**
Operator-invoked only — `/chart` never auto-reclaims a stale ticket.

This mode exists because the frontier selects `Status: open` only. Without a
`claimed → open` edge, a stale-claimed ticket is surfaced as reclaimable and yet
unreachable by any operation, which would defeat the "nothing is stranded"
property outright.

Legal transitions are exactly **`open → claimed`**, **`claimed → resolved`**, and
**`claimed → open`**. Everything else is forbidden.

## Delegation

This is the core behavior: `/chart` schedules, other skills answer.

| `Type:` | Resolves via |
|---|---|
| `grilling` | `grill-me` — plus `ubiquitous-language` when vocabulary is the blocker |
| `prototype` | `prototype` |
| `research` | `parallel-explore` |
| `task` | direct execution (no delegated skill) |

## The fog rule

**A question that cannot be stated precisely now belongs in `## Not yet specified`,
never in a ticket.** The test is whether you can **state** it — never whether you
can **answer** it.

`/chart new` creates the map with all five sections and only those tickets whose
questions are stateable **now**, possibly zero of them. Graduating a fog line into
a ticket later is a normal, recorded event, not a failure.

This is the skill's thesis. An implementation that eagerly decomposes a vague
destination into a comprehensive ticket set satisfies every mechanical check while
defeating the reason the skill exists.

## Escalations

**These are halts, not suggestions.** State the trigger, stop, and do not talk
yourself past it. An escalation implemented as advisory prose is not implemented.

1. **No fog → do not chart.** If charting surfaces **no** fog — the route is
   already clear and the effort fits in one session — **stop, create no map**, and
   recommend `grill-me` or `/spec` instead. An implementation that always charts
   fails this one silently, which is the only way it can fail.
2. **Existing content, or a git-tracked root.** If the resolved root already holds
   unrelated content, stop and ask. On the **first** map created under any root,
   report whether that location is **git-tracked**, and stop for confirmation when
   writing would commit planning content into a repo.
3. **A second tracker adapter.** Stop and confirm — do not implement one. Deferred
   until at least three real maps exist under the bundled adapter.
4. **Map too large.** Past roughly **20 open tickets**, or once the map no longer
   loads comfortably in one session, stop and propose **splitting the destination**.
   Never resolve this by adding one more ticket.
5. **Ticket ceiling.** At `NN = 99`, refuse to create a 100th ticket and say why.
   **Do not widen `NN` to three digits.** This is a backstop; rule 4 fires long
   before it.
6. **Bad blocking edge.** A `Blocked by:` edge that creates a cycle or a self-block
   is refused **at creation**, naming the cycle. Do not write the ticket and leave
   the graph to be repaired later.

## Never

1. **Never write to Observatory, the Spine, the knowledge base, or the context
   ledger.** Not optionally, not behind a capability check, and not because those
   tools happen to be connected in the session you are running in. **This is the
   constraint that makes `/chart` portable** — it is the reason the skill has this
   shape, and the first such call ends the property.
2. **Never resolve a ticket in the charting session.** Charting is one session's
   work and hand-resolves nothing.
3. **Never write a spec.** `/chart`'s output is a resolved map; `/spec` consumes it.
   Crossing that line rebuilds the single-session monolith one layer up.
4. **Never auto-suffix a colliding effort slug** — on explicit `/chart new
   <destination>` exactly as much as on the bare-argument path. Stop and ask. An
   auto-suffixed `auth-redesign-2` is precisely the invisible-duplicate-map failure
   the staleness listing exists to catch.

## Fail closed

A dangling `Blocked by:` reference leaves the ticket **blocked** and reports it as
a defect in the listing. A typo must never silently promote a ticket onto the
frontier.

---

*Adopted from Matt Pocock's `wayfinder` skill (github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder). Adapted: renamed to `chart` for workit's register, tracker-adapter indirection, resolution delegated to workit skills (grill-me/prototype/parallel-explore), append-only map writes, staleness listing.*
