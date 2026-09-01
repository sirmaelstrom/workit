---
name: codex-delegate
description: "Offload a bounded whole-repo audit, broad search, bulk extraction, or repetitive mechanical edit to a plan-covered CLI agent (codex exec — Terra or Luna) instead of reading every file yourself. Use BEFORE you open ~10 files to produce one short answer, even if nobody says 'delegate' or 'offload'. Not for PR review (use slim-review), work needing this session's decisions, or edits to a repo you are mid-edit on."
---

# Model-Aware Delegate — Route Leaf Work Off the Expensive Channel

The conductor is the context-rich channel. Token-hungry grunt work burns it on work a cheaper model can do just as well. Delegate the leaf work; keep orchestration, architecture, and integration judgment in the conductor.

For worktree-backed agent execution, the lane lifecycle is encoded in `scripts/lane.mjs`; the binding behavior is `reference/patterns/lane-supervision.md`.

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
| **Luna** (`codex-luna` in the Codex harness; `luna` where an API agent runner exists) | High-volume, repetitive, well-specified leaf grunt: mechanical edits, test generation, extraction, classification, or many independent small checks | **Also $0** through the Codex harness — 43% faster, ~15% fewer plan tokens; medium reasoning by default | Architecture, ambiguous diagnosis, synthesis across leaf results, direct conversational work — **and any verdict about safety or correctness** (see threshold) |

**Grok is off the delegation roster (operator decision, 2026-08-10).** It is metered
xAI spend, and liberal delegation was trending toward **$25–50/month** for work two
plan-covered channels already do. Both tiers above are $0 marginal — there is no
delegation case that justifies paying for a third. Do not reach for Grok here even
if a `grok` alias is registered and looks available; if Codex capacity is the
constraint, wait or narrow the task rather than spending.

### The Terra-vs-Luna threshold (measured)

**Do not pick between Terra and Luna on cost — they are the same $0 plan-covered channel.** Luna buys wall-clock and plan capacity, and pays in silent incompleteness. Measured 2026-08-07, both tiers on a byte-identical whole-repo audit (`outputs/workshops/codex-delegation-pattern/luna-arm-measurement.md`):

| Choose | For | Evidence |
|---|---|---|
| **Terra @ high** | Any output that is a **verdict about safety or correctness** — audits, "is X guarded", pre-merge verification, anything where a miss ships a bug | Luna returned a **confident wrong PASS on 2 of 9 examined stores (22%)**, citing real code at real line numbers. Terra found 3 genuine defects that both Luna and the July baseline called clean |
| **Luna @ medium** | **Enumeration and extraction** whose output is mechanically checkable — inventories, find-all-X, classification, bulk mechanical edits | 141 s vs 249 s (**−43%**), 79k vs 93k leaf tokens (**−15%**), full recall of the known defect set |

**A wrong verdict and a wrong locator both arrive in the register of a verified finding.** Luna's three failure modes — 25% silent store-coverage shortfall, 22% false PASS, one hallucinated directory — were *all invisible in a handback that read as complete*.

### Assert the handback (both tiers, non-negotiable)

The conductor never reads the files, so the handback's coverage and locators **are** the deliverable. Two checks, each ~one line, catch every mechanical failure observed:

1. **Demand a coverage statement** and compare it to ground truth: end every prompt with *"Close with: examined N of M files matching `<glob>`."* Then `find` the glob and check N against M. Luna silently skipped 3 async-bearing stores; Terra silently skipped every leaf component under `lib/components/` by reading "island/store" literally. **The same assertion catches both** — neither is a tier-specific flaw.
2. **Grep every cited path against the filesystem** before acting on a finding or passing it upward. A hallucinated directory turns a correct finding into one you must re-derive — spending exactly the tokens the delegation saved.

*(This is the delegation-side instance of the closed-output lesson from the leaf-task inventory: the closed frame makes failure **detectable**, not output **trustworthy**. Nothing detects it unless you run the check.)*

### Availability gate

Do not confuse a registered Observatory/Dogan alias with a subprocess the current host can spawn.

- `codex` and `codex-luna` are actionable from an interactive coding session through `codex exec`.
- A registered `grok` alias is **not** a delegation target — see the roster note above. Neither is any other metered runner: if the only reachable surface is metered, do the work in the conductor or narrow it, and do not inline the repository into an API prompt (that erases the token saving *and* bills for it).

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
codex exec --model gpt-5.6-terra -c model_reasoning_effort=high --sandbox danger-full-access --skip-git-repo-check -C "<absolute target dir>" - <<'EOF'
<self-contained prompt, ending with the bounded-return contract>
EOF
```

(`-` reads the prompt from stdin — safest for multi-line prompts. On Windows/PowerShell, pipe the prompt file: `Get-Content prompt.txt -Raw | codex exec ... -`.)

- **Default model:** use `gpt-5.6-terra` at high effort (the Observatory `codex` posture). Slugs rot — before a large fan-out, or on a 400, verify the live slug against `~/.codex/models_cache.json` / `projects/heathdev-observatory/src/models.ts`.
- **High-volume grunt:** use `--model gpt-5.6-luna -c model_reasoning_effort=medium` (the Observatory `codex-luna` posture). Set it explicitly: the Codex CLI's configured default may otherwise raise Luna to high.
- Use model slugs, not Observatory aliases, on the raw `codex exec --model` flag. The aliases describe the roster posture; the CLI accepts the underlying slug.
- **Sandbox:** `--sandbox danger-full-access` for audits/scans/extraction (most delegations), with an explicit "do not modify any files" clause in the prompt — Terra honors it (verified). ⚠️ Do NOT use `--sandbox read-only` on this Windows box: the sandbox runner fails at the first child spawn (`CreateProcessAsUserW failed: 5`) and the model returns a plausible **ungrounded** answer with no surfaced error (auto-memory `codex-exec-readonly-sandbox-broken-windows`). Use `workspace-write` only when the delegated task must produce files, and point it at a scratch dir or worktree — never let a delegated task write into a repo the conductor is mid-edit on.
- **MCP: assume none.** `codex exec` **silently skips HTTP-transport MCP servers** — a delegated task that "uses the gateway" will no-op without error. Keep delegated tasks fully self-contained (filesystem + shell only). If a task genuinely needs an MCP tool, inject a *stdio* server explicitly via `-c mcp_servers.<name>.command=...` flags; never assume anything from the interactive session is reachable.
- **Verify against `codex exec`,** the non-interactive form — never against the interactive `codex` UI. They differ in config handling and MCP behavior; a pattern proven interactively can fail under `exec`.

### Prompt template

```
You are auditing/processing <target> at <absolute path>. READ-ONLY — modify nothing.

Task: <complete, standalone description — include definitions of every
pattern/term, because you have no other context>.

Return DISTILLED findings only:
- <exact output structure: e.g. "file path — pattern # — one-line evidence — line ref">
- Close with EXACTLY: "examined N of M files matching <glob>" — the real counts.
- Maximum <N> lines total. Do NOT include file contents or raw data.
```

The coverage line is load-bearing, not politeness: it is the only thing that makes an
incomplete audit distinguishable from a clean one. Check its N against your own `find`,
and grep every returned path against the filesystem — both tiers have been measured
silently skipping files and citing at least one directory that does not exist.

### Reading the result

Codex prints a header, the transcript, and a `tokens used` line. The final assistant message is the handback. Sanity-check it: if it exceeded the line ceiling or dumped raw content, tighten the contract and re-run — do not paste the oversized output onward.

## Cost posture

- Conductor→Codex/Terra or Codex/Luna delegation is **pure arbitrage** when the CLI is plan-covered: expensive-channel tokens saved, $0 marginal spend on the sub.
- API Luna is metered; its lower token price does not beat $0. Prefer the Codex harness, where both tiers are plan-covered. Metered runners are not a delegation target here at all — a cheaper-per-token bill is still a bill against $0.
- The ChatGPT Plus tier has real (unpublished) throughput limits. Treat this as a **spillover valve, not a workhorse** — one heavy delegation at a time, not a fan-out of dozens.
- **The scarce resource is plan capacity, not dollars.** Between two $0 channels there is no dollar axis to optimize; budget in leaf tokens and wall-clock instead. Measured on one whole-repo audit: Terra 93,353 tok / 249 s vs Luna 79,431 tok / 141 s — and both roughly half the 197,290 the same task cost on gpt-5.5 in July, a model-generation gain rather than a tier effect.

## Anti-patterns

- Delegating a task that needs mid-session context (fails the self-containment gate) — you'll serialize the context into the prompt and spend the tokens anyway, or get a wrong answer.
- Accepting an unbounded handback ("here's everything I found, plus the files") — the contract must cap it *before* the run.
- Delegating planning, orchestration, or judgment — leaf agents execute well-specified work; they do not carry your session's intent.
- Reaching for a metered runner (Grok, API Luna) because its alias is registered — the roster is two plan-covered tiers, and "it was available" is not a spend rationale.
- Piping codex's full session log or scratch files back into the conductor "for reference".
- Using this as a parallelism engine on the $20 tier — it's a cost valve, not a compute farm.

<supporting_info>

*Origin: codex-delegation-pattern workshop (spec-LITE, 2026-07-04), quest `cb3ce3e7`; roster expansion quest `93d32058` (2026-07-10). Mechanism proven in Observatory's `CodexCliProvider` and the review council's lead lens. Measurement gate (D5) run 2026-07-06: `outputs/workshops/codex-delegation-pattern/measurement.md` — 177,307 → ~2,020 conductor tokens (98.9%, ~88x) with the same 4/4 defect set.*

*Terra-vs-Luna threshold measured 2026-08-07, quest `a170a58d`: `outputs/workshops/codex-delegation-pattern/luna-arm-measurement.md` — both tiers re-run same-day on a byte-identical prompt (the D5 baseline's `gpt-5.5` + `--sandbox read-only` invocation is no longer reproducible). Directional, n=1 run per arm.*

</supporting_info>
