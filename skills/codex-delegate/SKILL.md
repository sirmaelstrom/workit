---
name: codex-delegate
description: "Delegate token-hungry grunt work to the Codex CLI (`codex exec`) instead of absorbing it into the conductor's context. Use when a task is a whole-repo or large-directory audit, PDF/large-document extraction, large-data or log scan, a broad 'find X across everything' search, or any read-heavy sweep whose bulk tokens don't need the conductor's intelligence. Also trigger when the user says 'delegate to codex', 'offload this', 'don't burn your context on this', or when a session is context-heavy and a self-contained heavy read is about to start."
---

# Codex Delegate — Route Token-Hungry Work Off the Expensive Channel

The conductor (this session's model) is the expensive channel — interactive weekly limits or metered API credit. Token-hungry grunt work (bulk reads, broad scans) burns that channel on work a cheaper model does just as well. `codex exec` — Codex CLI authenticated via the ChatGPT subscription — is the *cheap-but-competent* middle tier: $0 marginal cost, capable of real codebase work. Delegate the grunt work; keep the judgment.

## Route by Phase

Pick the execution surface by the **phase** of work, not just its size:

| Phase | Surface | Why |
|-------|---------|-----|
| Research / context-gathering / bulk reads | **Cheap** — `codex exec` (or a local model if trivially mechanical) | Input-token-heavy; needs coverage, not brilliance |
| Planning / architecture / judgment calls | **Conductor only** | Needs the session's accumulated context and the strongest reasoning |
| Execution of a well-specified, self-contained chunk | **`codex exec`** | The spec carries the intelligence; execution is grunt work |

The conductor stays the *orchestrator*: it decides, delegates, and integrates the distilled result. It does not absorb the bulk tokens.

## When to Delegate — Task Shapes

Delegate when the task matches a **token-hungry shape**:

- Whole-repo or large-directory audit ("check every X for pattern Y")
- PDF / large-document extraction or summarization
- Large-data or log scan
- Computer-use / screenshot-loop style repetitive verification
- Broad "find X across everything" searches whose result is a short list

## The Self-Containment Gate (must pass)

`codex exec` is a **fresh, stateless subprocess**. It has none of your mid-session context. Before delegating, ask:

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

## Invocation

```bash
codex exec --model gpt-5.5 --sandbox read-only --skip-git-repo-check -C "<absolute target dir>" - <<'EOF'
<self-contained prompt, ending with the bounded-return contract>
EOF
```

(`-` reads the prompt from stdin — safest for multi-line prompts. On Windows/PowerShell, pipe the prompt file: `Get-Content prompt.txt -Raw | codex exec ... -`.)

- **Model: pin `--model gpt-5.5`.** Do not use Codex-branded model slugs — they are gone from the ChatGPT-account plan and are rejected with 400 "model is not supported". Plain `gpt-5.5` through `codex exec` is the proven, subscription-covered path.
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

- Conductor→codex delegation is **pure arbitrage** when the conductor is plan-covered: expensive-channel tokens saved, $0 marginal spend on the sub.
- The ChatGPT Plus tier has real (unpublished) throughput limits. Treat this as a **spillover valve, not a workhorse** — one heavy delegation at a time, not a fan-out of dozens.

## Anti-patterns

- Delegating a task that needs mid-session context (fails the self-containment gate) — you'll serialize the context into the prompt and spend the tokens anyway, or get a wrong answer.
- Accepting an unbounded handback ("here's everything I found, plus the files") — the contract must cap it *before* the run.
- Delegating planning or judgment — codex executes well-specified work; it does not carry your session's intent.
- Piping codex's full session log or scratch files back into the conductor "for reference".
- Using this as a parallelism engine on the $20 tier — it's a cost valve, not a compute farm.

<supporting_info>

*Origin: codex-delegation-pattern workshop (spec-LITE, 2026-07-04), quest `cb3ce3e7`. Sources: Theo (`5LqC6qdVAwU`) and Chase AI (`p8ypBeNXQ8E`) on running Claude Code as conductor with Codex as the cheap execution arm. Mechanism proven in Observatory's `CodexCliProvider` and the review council's lead lens. Measurement gate (D5) run 2026-07-06: see `outputs/workshops/codex-delegation-pattern/measurement.md`.*

</supporting_info>
