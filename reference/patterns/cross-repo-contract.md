# Pattern: cross-repo-contract

**What:** The discipline of specifying shared wire formats, message types, and payload shapes when a campaign spans multiple repositories. Without explicit contracts, parallel dispatch agents in different repos independently invent type names and data shapes that don't match — producing code that passes all gates individually but fails silently at integration.

**When to use:** Any campaign where two or more repos must agree on a communication protocol — WebSocket message types, API request/response shapes, shared event formats, or any interface where one repo produces what another consumes.

## The Problem

Multi-repo campaigns have a unique failure mode: **invisible integration mismatch**.

In a single-repo campaign, WPs share an import graph. If WP-03 uses a type from WP-01, the compiler enforces the contract. Cross-repo campaigns don't have this — each repo has its own type system, its own build, its own gate. A WP in Repo A can define `chat.message.send` while a WP in Repo B uses `chat.room.send`, and both pass `tsc --noEmit` independently. The mismatch is invisible until runtime.

This failure class is uniquely dangerous because:
- **Gates don't catch it.** Each repo's gate validates its own types. Cross-repo type agreement is not tested.
- **Dispatch metrics don't surface it.** All WPs complete "successfully." The campaign reports 100% autonomous.
- **It fails silently.** Messages are dropped, not rejected. No error, no log, no crash — just broken features.

## The Contract Artifact

Every cross-repo campaign needs a **contract artifact** — a dedicated section in the orchestrator (`_orchestrator.md`) that explicitly defines the wire format both repos must implement. This artifact must be:

1. **Explicit** — exact type strings, exact payload shapes, exact field names. No shorthand, no `...`, no `{id, type}` without types.
2. **Referenced by name** — downstream WP specs say "implement the contract from the orchestrator" with the exact types quoted
3. **Self-contained** — a dispatch agent reading only its own WP spec + the orchestrator can reconstruct the contract without reading the other repo's code

### What a Contract Contains

For WebSocket/message-based protocols:

```markdown
## Wire Format Contract

All repos in this campaign MUST use these exact message types and payload shapes.
Do not invent alternative names or structures.

### Client → Server Messages

| Type String | Payload | Response |
|------------|---------|----------|
| `chat.room.create` | `{ name: string, participants: Array<{ id: string, type: 'human' \| 'ai', display: string }> }` | `{ id: string, name: string, createdBy: string, createdAt: string }` |
| `chat.room.list` | `{}` | `Array<{ id: string, name: string, createdBy: string }>` |

### Server → Client Broadcasts

| Type String | Payload Shape |
|------------|---------------|
| `chat.message.new` | `{ message: { id: string, roomId: string, senderId: string, content: string, createdAt: string }, roomId: string }` |

### Shared Types

```typescript
// Both repos must implement types compatible with these exact shapes
interface ChatRoom { id: string; name: string; createdBy: string; createdAt: string; }
interface ChatMessage { id: string; roomId: string; senderId: string; content: string; createdAt: string; }
interface ChatParticipant { id: string; type: 'human' | 'ai'; display: string; }
```
```

For REST API protocols:

```markdown
## API Contract

### Endpoints

| Method | Path | Request Body | Response (200) |
|--------|------|-------------|----------------|
| POST | `/api/v1/rooms` | `{ name: string, participants: ChatParticipant[] }` | `ChatRoom` |
| GET | `/api/v1/rooms` | — | `ChatRoom[]` |
| POST | `/api/v1/rooms/:roomId/messages` | `{ content: string }` | `ChatMessage` |

### Error Responses

All errors return `{ error: string, code: string }` with appropriate HTTP status.
```

### Where the Contract Lives

The contract lives in **`_orchestrator.md`** — the orchestrator's constraints section. This is the single source of truth. Every dispatch agent reads the orchestrator regardless of which repo they're working in, making it the only artifact guaranteed to be visible to all agents.

The contract is NOT:
- TypeScript types in one repo's source code (invisible to agents in the other repo)
- A WP-01 spec artifact (only read by the WP-01 agent, not downstream agents)
- Implied by shared terminology ("chat messages" means different things to different agents)

The contract is referenced by every downstream WP that touches the protocol, with the relevant subset embedded in each WP spec (see Embedding below).

## Embedding in Downstream WPs

Every WP that implements one side of the contract must include a **summary reference** — the message types and payload shapes relevant to that WP, with an explicit pointer to the orchestrator as the authoritative source:

```markdown
## Wire Format (from orchestrator contract)

This WP implements the server side of the following message types.
The authoritative contract is in `_orchestrator.md` — these are the relevant excerpts.

- `chat.room.create` — handler accepts `{ name: string, participants: ChatParticipant[] }`, returns `{ id, name, createdBy, createdAt }`
- `chat.room.list` — handler accepts `{}`, returns `ChatRoom[]`
- `chat.message.new` — broadcast to room participants: `{ message: ChatMessage, roomId: string }`

Use these EXACT type strings. Do not rename or restructure.
If a conflict with existing code requires deviation, ESCALATE — do not silently change the contract.
```

This is intentional duplication. The self-containment rule (from `work-package` pattern) requires each WP to be understandable without reading other WPs. The orchestrator is the single source of truth; WP embeddings are summaries for agent convenience. If there's a conflict, the orchestrator wins.

## Validation Gaps

Cross-repo contracts create a validation gap that single-repo campaigns don't have:

| What | Single-repo | Cross-repo |
|------|------------|------------|
| Type agreement | Compiler enforces | **Must be specified in contract** |
| Payload shape | Import graph ensures consistency | **Must be embedded in each WP** |
| Message type strings | Shared constant/enum | **Must be literal strings in each WP** |
| Integration test | Same test suite | **Manual integration only (post-merge)** |

The gap between "all gates pass" and "the feature works" is where this pattern operates. The contract doesn't close the gap completely — runtime integration testing is still necessary — but it eliminates the most common failure mode: independent invention of incompatible interfaces.

## Consumer-Side Schema Registration

Many consumer repos validate incoming messages against a schema before routing them. If a new message type isn't registered in the schema, it's silently dropped — no error, no log, no crash. This is the same failure class as the contract mismatch itself, just at a different layer.

The contract must explicitly call out schema registration requirements for every consumer repo:

```markdown
### Schema Registration Requirements

[Consumer Repo] validates incoming messages against [validation system].
New message types MUST be registered or they will be silently dropped.

Files to update: [exact file path] — add schema for each broadcast type above.
```

This is not something agents can infer from reading the codebase. Even if an agent sees validation code, it won't know that *its* new types need to be added to an existing union/registry. The contract must say so explicitly.

### Consumer Example (Zod Discriminated Union)

A web-frontend bridge client typically validates incoming WebSocket messages against a Zod discriminated union (e.g. in `src/lib/utils/bridge-client.ts`). New broadcast types that aren't added to this union are silently dropped by the parser. This has caused silent failures in practice and must be stated in every campaign that adds new bridge message types.

## Pre-Dispatch Checklist

Before dispatching a cross-repo campaign, verify:

- [ ] **Contract exists in `_orchestrator.md`** — wire format section with exact type strings and fully-typed payload shapes
- [ ] **Every cross-boundary message type is in the contract** — if Repo A sends it and Repo B receives it, it's in the contract
- [ ] **Broadcast shapes are defined** — not just request/response pairs (broadcasts are the most commonly missed)
- [ ] **Each consuming WP embeds its relevant contract subset** — with escalation instruction if deviation is needed
- [ ] **Schema registration steps are explicit** — for every consumer repo with message validation (Zod, JSON Schema, etc.)
- [ ] **Shared types are fully typed** — no `...`, no shorthand, no `any`, no implicit shapes

This checklist is the minimum. The review council checks (below) are the verification layer.

## Escalation Triggers

- If the contract requires a message type that conflicts with an existing type in either repo, escalate.
- If one repo's handler infrastructure doesn't support the payload shape defined in the contract (e.g., no support for nested objects, array fields, or optional fields), escalate.
- If implementing the contract requires modifying shared infrastructure (WebSocket connection layer, message router, schema validation system), escalate — the blast radius extends beyond this campaign.
- **If an agent deviates from the contract during implementation** — invents a different type string, restructures a payload, or renames a field — this is a gate-invisible failure. The WP spec must instruct agents to escalate rather than improvise. If discovered post-dispatch, treat as a contract violation finding in the post-mortem.

## Anti-Patterns

- **"See WP-01 types"** — References to another WP's source code violate self-containment. The contract must be in spec artifacts, not in code.
- **Implicit type agreement** — Assuming that because both WPs reference "chat messages" they'll use the same type strings. They won't.
- **TypeScript types as the contract** — Types in one repo's source files are invisible to agents dispatched to the other repo. The spec is the contract, not the code.
- **Testing only within each repo** — Both sides passing their own tests doesn't prove they talk to each other. Budget time for post-merge integration testing.

## The Review Council's Role

Pre-dispatch review should specifically check cross-repo contracts:

1. **Contract completeness** — Are all message types that cross the repo boundary defined in the contract?
2. **Contract consistency** — Do both sides' WP specs reference the same type strings and payload shapes?
3. **Schema registration** — Does the consumer-side WP include schema registration steps (Zod, validation, etc.)?
4. **Broadcast shapes** — Are server→client broadcast payloads explicitly defined, not just request/response pairs?

This is the highest-value review check for multi-repo campaigns. A real campaign shipped without review; all three P1/P2 findings were contract mismatches that a reviewer checking these four points would have caught.

## Execution Feedback

### A real cross-repo campaign

First campaign to expose this failure class. 6 WPs, 2 repos (a backend service + a web frontend), 4 waves, 31 min dispatch, zero gate failures. All WPs passed. Feature didn't work.

Three contract violations found during manual integration:
1. **Message type mismatch:** the web-frontend WP used `chat.room.send`; the backend WP defined `chat.message.send`. WP-01 had the correct types in a TypeScript union, but the web-frontend agent didn't reference it.
2. **Broadcast shape mismatch:** the web frontend expected `msg.payload`; the backend sent `msg.message` with separate `msg.roomId`.
3. **Missing Zod schemas:** New broadcast types weren't added to the web frontend's Zod discriminated union, causing silent message drops.

Cost of not having this pattern: ~90 minutes of manual Opus integration work post-merge. Estimated cost of the pattern (contract section in spec + review check): ~15 minutes of spec writing + ~$3-5 of review council time.

## Known Gaps

- **Contract amendment propagation.** If mid-campaign discovery requires changing the contract (e.g., a field needs to be added), there's no mechanism to propagate that change to already-dispatched WPs. For now: escalate, re-spec affected WPs, re-dispatch. A formal amendment protocol is deferred until we hit this in practice.
- **Integration verification.** This pattern eliminates the most common cause of integration failure (independent invention) but doesn't define what post-merge integration testing looks like. That's a separate concern — when we have a pattern for it, link it here.
- **Compile-time enforcement.** The ideal state is a shared package/schema that both repos import, making the compiler enforce the contract. This pattern is the manual discipline that covers the gap until shared packages are practical for our campaign infrastructure.

---
*Origin: a cross-repo campaign post-mortem — Finding 1 (cross-repo type mismatch), Finding 2 (broadcast shape mismatch), Finding 3 (missing Zod schemas)*
*Pipeline: ← `constraint-architecture`, `decomposition` | → `work-package`, `wave-execution`*
*See also: `work-package` (self-containment rule), `review-council` (cross-repo review checklist), `constraint-architecture` (where contracts are specified)*
