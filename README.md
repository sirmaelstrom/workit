<p align="center">
  <img src="./assets/workit-icon.png" alt="workit icon" width="128">
</p>

# workit

A personal [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin — the canonical toolkit I use day to day for **specification, execution, review, and skill self-improvement**. It started as a spec-pipeline and grew into a general-purpose set of skills for doing engineering work with an agent in the loop.

It's published openly so it can be referenced, forked, or installed directly. It's opinionated toward how I work; treat it as a worked example as much as a drop-in tool.

## What's inside

Two layers:

- **`skills/`** — the active, triggerable tools (below).
- **`reference/`** — the methodology library the skills draw on: patterns, checklists/conventions, templates, and heuristics. Start at [`reference/patterns/INDEX.md`](./reference/patterns/INDEX.md), or see [`reference/README.md`](./reference/README.md).

### Skills

Grouped by what they're for:

### Specify & plan
| Skill | What it does |
|-------|--------------|
| `chart` | Map a foggy, multi-session effort as a decision tree on disk, then resolve one question per session — scheduling `grill-me` / `prototype` / `parallel-explore` to do the answering. Halts rather than charting when the route is already clear. |
| `spec` | Generate a specification through a staged pipeline with review gates and depth auto-selection. |
| `spec-validate` | Validate a spec's quality against structural checks before you build. |
| `ubiquitous-language` | Extract domain terminology into a shared glossary (DDD). |
| `grill-me` | Stress-test a plan or idea — poke holes before you commit. |
| `parallel-explore` | Fan a design problem out into intentionally different agent runs, then synthesize a ranked decision. |
| `prototype` | Spike throwaway code — logic or UI — to answer a specific design question before you commit. |
| `wait-what` | Restate the last explanation in short declarative sentences grounded in the project's own vocabulary. |

### Execute
| Skill | What it does |
|-------|--------------|
| `execute-wp` | Execute a work package from a spec, appending to a progress log as it goes. |
| `handoff` | Compact a conversation into a handoff doc so a fresh agent can pick up the work. |
| `burn-down` | Run an ordered queue of roadmap quests to landed, holding the disciplines that keep the board honest — scheduling `pickup` per item and `handoff` only for mid-item exits. |
| `pickup` | Resume the current project's top roadmap quest from the Spine — resume note + cartridge artifacts, claim the quest on the board, then continue. |
| `commit-msg` | Commit via a file (`git commit -F`) so shell-active content — backticks, links, quotes — lands verbatim instead of breaking under HEREDOC parsing. |
| `codex-delegate` | Route token-hungry grunt work (repo audits, large-doc extraction, broad scans) to `codex exec` with a self-contained prompt and a distilled-only handback, keeping bulk tokens out of the conductor's context. |
| `wizard` | Generate an interactive bash wizard that walks a human through steps only they can perform — opens each URL, captures values, writes `.env`/GitHub secrets, confirms every stage. Ported from [Matt Pocock's wizard](https://github.com/mattpocock/skills/tree/main/skills/engineering/wizard); library Windows-verified under Git Bash. |

### Review & repair
| Skill | What it does |
|-------|--------------|
| `review` | Adaptive multi-reviewer pipeline over a PR, branch, working tree, file, or plan. |
| `slim-review` | The light tier: one external reviewer at a PR boundary, posted as line-anchored GitHub review comments, then confirmed or refuted thread by thread. Cheap enough to run on every PR. |
| `improve-architecture` | Find code smells and make a codebase more agent-friendly and testable. |
| `diagnose` | Force environmental / process / config / code-path hypotheses into an explicit verification flow before editing. |
| `blast-radius` | Pre-ship impact analysis: find what a change breaks beyond the diff, then prove the one fact it's safe because of by running real code — anything below that rung is marked unproven. Ported from [pstack's blast-radius](https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius). |
| `failure-audit` | Delta failure-mode audit over archived agent-session transcripts: slice new sessions into digests, fan out calibrated auditor waves, then run the standing comparisons (guard treatment check, model drift, new-label emergence). Operator-pulled, never scheduled. |
| `unslop` | Cut AI tells from prose (puffery, filler, hedging, chatbot phrases, metaphor jargon) and put a human voice back in. Ported from [pstack's unslop](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop); rule 26's jargon cut is gated on the project's `UBIQUITOUS_LANGUAGE.md`. |

### Skill meta-tooling
| Skill | What it does |
|-------|--------------|
| `audit-skills` | Score every skill in a plugin against a rubric and write results to `skills.db`. |
| `eval-loop` | Run an autonomous Karpathy-style eval loop to measurably improve a skill's output quality. |

## Install

This is a Claude Code plugin distributed via its own marketplace manifest.

```
/plugin marketplace add sirmaelstrom/workit
/plugin install workit
```

Or point Claude Code at a local clone during development:

```
/plugin marketplace add /path/to/workit
```

Once installed, the skills trigger by description (e.g. "write a spec for…", "review my branch", "diagnose this") or by slash command (`/spec`, `/review`, `/diagnose`, …).

## Conventions & assumptions

This is a personal plugin, so a few skills assume my environment:

- **The Spine (roadmap board).** `pickup` and `burn-down` are built around a persistent roadmap served by a `context-ledger` MCP server (Campaign → Quest → Seam) that is part of my personal infrastructure, **not** part of this plugin — without a board they have nothing to resume or burn down. Treat those two as worked examples unless you bring your own equivalent. A few others (`handoff`, `spec`, `improve-architecture`) reference the same tools where present and work fine without them.
- **Output location.** Several skills write artifacts to `{workspace}/data/outputs/{category}/`, where `{workspace}` is the workspace root — the directory containing `projects/` and `data/`. It resolves from `--workspace-root` where a script takes one, else `WORKIT_WORKSPACE_ROOT`, else your current working directory; the skill states which rule it used before writing. Set the env var if you keep your artifacts somewhere other than the cwd. Full rule: [`reference/patterns/worktree-rooting.md`](reference/patterns/worktree-rooting.md) § Output Rooting.
- **Pattern library.** The methodology these skills draw on is bundled in [`reference/`](./reference/) — patterns, checklists/conventions, templates, and heuristics. `spec`, `spec-validate`, and `execute-wp` read from it at runtime (`reference/patterns/`, `reference/templates/`). No external repo needed.
- **`skills.db`.** `audit-skills` and `eval-loop` read/write a local SQLite inventory seeded by `scripts/init-skills-db.mjs` (uses Node's native `node:sqlite`, so Node 24+). The DB is git-ignored.
- **Optional integrations.** `eval-loop`'s automation scripts can post to a Discord webhook (`DISCORD_WEBHOOK_URL`) and mirror results to a ledger endpoint (`LEDGER_URL`). Both are off unless you set those env vars.
- **External CLIs on `PATH`.** The automation skills shell out to other tools: `parallel-explore`, `eval-loop`, and `audit-skills` invoke the [`claude`](https://docs.claude.com/en/docs/claude-code) CLI, and `eval-loop`'s nightly automation optionally calls `bws` (the Bitwarden Secrets CLI) to resolve `DISCORD_WEBHOOK_SECRET`. The specification, review, and markdown skills work without either.
- **Other env knobs (all optional).** Beyond the two above, the `eval-loop` scripts read `DISCORD_WEBHOOK_SECRET`, `LEDGER_USER_ID`, `EVAL_PLUGINS`, `EVAL_TZ`, `EVAL_PROJECT_ROOT`, `EVAL_SKILL_FILE`, and `EVAL_SUITE_FILE` — knobs for the nightly automation, none required for interactive use.

## License

[MIT](./LICENSE) © 2026 Justin Heath
