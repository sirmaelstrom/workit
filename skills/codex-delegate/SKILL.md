---
name: codex-delegate
description: "Delegate self-contained, token-hungry leaf work to the cheapest fitting agent (Codex/Terra, Luna, or Grok) instead of absorbing it into the conductor's context. Use for whole-repo or large-directory audits, large-document extraction, broad searches, repetitive implementation, test repair, or other bounded leaf tasks whose bulk tokens do not need the conductor's accumulated context. Also trigger when the user says 'delegate', 'offload this', 'use codex/luna/grok', or 'don't burn your context on this'."
---

# Model-Aware Delegate — Route Leaf Work Off the Expensive Channel

The conductor is the context-rich channel. Token-hungry grunt work burns it on work a cheaper model can do just as well. Delegate the leaf work; keep orchestration, architecture, and integration judgment in the conductor.

## Route by Phase

Pick the execution surface by the **phase** of work, not just its size:

| Phase | Surface | Why |
|-------|---------|-----|
| Research / context-gathering / bulk reads | **Cheapest fitting leaf agent** | Input-token-heavy; needs coverage, not brilliance |
| Planning / architecture / judgment calls | **Conductor only** | Needs the session's accumulated context and the strongest reasoning |
| Execution of a well-specified, self-contained chunk | **Cheapest fitting leaf agent** | The spec carries the intelligence; execution is grunt work |

The conductor stays the *orchestrator*: it decides, delegates, and integrates the distilled result. It does not absorb the bulk tokens.

## Select by Circumstance, Not Loyalty

Apply the self-containment gate first, then select the least expensive surface that fits:

| Target | Choose it when | Cost / effort posture | Do not choose it for |
|---|---|---|---|
| **Codex** (`codex`, currently Terra at high) | Default for codebase audits, difficult bounded implementation, repair, or verification where stronger leaf reasoning lowers retry risk | **$0 marginal**, ChatGPT-plan covered; high reasoning; proven 88x conductor-token saving | Fan-out that may exhaust plan throughput; work requiring conductor context |
| **Luna** (`codex-luna` in the Codex harness; `luna` where an API agent runner exists) | High-volume, repetitive, well-specified leaf grunt: mechanical edits, test generation, extraction, classification, or many independent small checks | Lowest-cost GPT-5.6 tier; medium reasoning by default; agents-only posture | Architecture, ambiguous diagnosis, synthesis across leaf results, direct conversational work |
| **Grok** (`grok`) | Bounded code-centric leaf work where concise/token-efficient execution matters and metered spend is acceptable | Metered xAI; low/medium/high effort, native default high | Orchestration, planning, broad synthesis, or any task whose runner lacks filesystem/tool access |

**Default to Codex** when two targets fit: $0 marginal cost dominates. Prefer Luna when volume and task simplicity matter more than maximum leaf reasoning. Prefer Grok only for a deliberate metered comparison or when Codex capacity/availability is the constraint.

### Availability gate

Do not confuse a registered Observatory/Dogan alias with a subprocess the current host can spawn.

- `codex` and `codex-luna` are actionable from an interactive coding session through `codex exec`.
- `grok` is actionable only when the host exposes an xAI-backed agent runner with the filesystem/tools the task needs. A plain Chat Completions call cannot inspect a repository. If that runner is absent, fall back to Codex; do not inline the repository into an API prompt and erase the token saving.

## When to Delegate — Task Shapes

Delegate when the task matches a **token-hungry shape**:

- Whole-repo or large-directory audit ("check every X for pattern Y")
- PDF / large-document extraction or summarization
- Large-data or log scan
- Computer-use / screenshot-loop style repetitive verification
- Broad "find X across everything" searches whose result is a short list

## The Self-Containment Gate (must pass)

A delegated agent is **fresh and stateless**. It has none of your mid-session context. Before delegating, ask:

> Can I write this task as a *standalone* prompt — target paths, definitions of the patterns to find, output contract — that a stranger could execute correctly with zero knowledge of this conversation?

- **Yes → delegate.** Example: *"Audit every Svelte island in `<abs repo path>` for async loads missing a load-sequence guard; return file → finding → line ref, max 80 lines."* Everything needed is in the prompt.
- **No → don't delegate.** Example: *"Refactor this the way we discussed"* or any task whose correctness depends on decisions, constraints, or partial edits accumulated in the current session. Handing it off either loses the context or forces you to serialize it all into the prompt — at which point you've spent the tokens anyway.

If the task needs the conductor's working memory, the conductor does it.

## The Handback Contract — Distilled Only (load-bearing)

**If raw tokens flow back into the conductor, the cost just moved — the win evaporates.** Every delegated prompt MUST demand a bounded, structured return:

- State the exact output shape (findings list, table, diff, single answer).
- Set an explicit ceiling: *"Maximum N lines total."*
- Forbid dumps: *"Do NOT include file contents, full transcripts, or raw data."*
- Read back only Codex's final message — never cat its scratch output or session log into the conductor's context.

## Codex-Harness Invocation

```bash
codex exec --model gpt-5.6-terra -c model_reasoning_effort=high --sandbox read-only --skip-git-repo-check -C "<absolute target dir>" - <<'EOF'
<self-contained prompt, ending with the bounded-return contract>
EOF
```

(`-` reads the prompt from stdin — safest for multi-line prompts. On Windows/PowerShell, pipe the prompt file: `Get-Content prompt.txt -Raw | codex exec ... -`.)

- **Default model:** use `gpt-5.6-terra` at high effort (the Observatory `codex` posture).
- **High-volume grunt:** use `--model gpt-5.6-luna -c model_reasoning_effort=medium` (the Observatory `codex-luna` posture). Set it explicitly: the Codex CLI's configured default may otherwise raise Luna to high.
- Use model slugs, not Observatory aliases, on the raw `codex exec --model` flag. The aliases describe the roster posture; the CLI accepts the underlying slug.
- **Sandbox:** `--sandbox read-only` for audits/scans/extraction (most delegations). Use `workspace-write` only when the delegated task must produce files, and point it at a scratch dir or worktree — never let a delegated task write into a repo the conductor is mid-edit on.
- **MCP: assume none.** `codex exec` **silently skips HTTP-transport MCP servers** — a delegated task that "uses the gateway" will no-op without error. Keep delegated tasks fully self-contained (filesystem + shell only). If a task genuinely needs an MCP tool, inject a *stdio* server explicitly via `-c mcp_servers.<name>.command=...` flags; never assume anything from the interactive session is reachable.
- **Verify against `codex exec`,** the non-interactive form — never against the interactive `codex` UI. They differ in config handling and MCP behavior; a pattern proven interactively can fail under `exec`.

### Prompt template

```
You are auditing/processing <target> at <absolute path>. READ-ONLY — modify nothing.

Task: <complete, standalone description — include definitions of every
pattern/term, because you have no other context>.

Return DISTILLED findings only:
- <exact output structure: e.g. "file path — pattern # — one-line evidence — line ref">
- End with a one-line coverage statement (what you examined).
- Maximum <N> lines total. Do NOT include file contents or raw data.
```

### Reading the result

Codex prints a header, the transcript, and a `tokens used` line. The final assistant message is the handback. Sanity-check it: if it exceeded the line ceiling or dumped raw content, tighten the contract and re-run — do not paste the oversized output onward.

## Cost posture

- Conductor→Codex/Terra or Codex/Luna delegation is **pure arbitrage** when the CLI is plan-covered: expensive-channel tokens saved, $0 marginal spend on the sub.
- API Luna and Grok are metered. Their lower token prices do not beat $0; use them for throughput, availability, or deliberate comparative evidence—not by default.
- The ChatGPT Plus tier has real (unpublished) throughput limits. Treat this as a **spillover valve, not a workhorse** — one heavy delegation at a time, not a fan-out of dozens.

## Anti-patterns

- Delegating a task that needs mid-session context (fails the self-containment gate) — you'll serialize the context into the prompt and spend the tokens anyway, or get a wrong answer.
- Accepting an unbounded handback ("here's everything I found, plus the files") — the contract must cap it *before* the run.
- Delegating planning, orchestration, or judgment — leaf agents execute well-specified work; they do not carry your session's intent.
- Selecting Grok because its alias exists while no tool-capable Grok runner exists in the current host.
- Piping codex's full session log or scratch files back into the conductor "for reference".
- Using this as a parallelism engine on the $20 tier — it's a cost valve, not a compute farm.

<supporting_info>

*Origin: codex-delegation-pattern workshop (spec-LITE, 2026-07-04), quest `cb3ce3e7`; roster expansion quest `93d32058` (2026-07-10). Mechanism proven in Observatory's `CodexCliProvider` and the review council's lead lens. Measurement gate (D5) run 2026-07-06: `outputs/workshops/codex-delegation-pattern/measurement.md` — 177,307 → ~2,020 conductor tokens (98.9%, ~88x) with the same 4/4 defect set.*

</supporting_info>
