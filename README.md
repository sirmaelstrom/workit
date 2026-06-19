# heathdev-workshop

A personal [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin — the canonical toolkit I use day to day for **specification, execution, review, and skill self-improvement**. It started as a spec-pipeline and grew into a general-purpose set of skills for doing engineering work with an agent in the loop.

It's published openly so it can be referenced, forked, or installed directly. It's opinionated toward how I work; treat it as a worked example as much as a drop-in tool.

## What's inside

Two layers:

- **`skills/`** — the active, triggerable tools (thirteen of them, below).
- **`reference/`** — the methodology library the skills draw on: patterns, checklists/conventions, templates, and heuristics. Start at [`reference/patterns/INDEX.md`](./reference/patterns/INDEX.md), or see [`reference/README.md`](./reference/README.md).

### Skills

Thirteen skills, grouped by what they're for:

### Specify & plan
| Skill | What it does |
|-------|--------------|
| `spec` | Generate a specification through a staged pipeline with review gates and depth auto-selection. |
| `spec-validate` | Validate a spec's quality against structural checks before you build. |
| `ubiquitous-language` | Extract domain terminology into a shared glossary (DDD). |
| `grill-me` | Stress-test a plan or idea — poke holes before you commit. |
| `parallel-explore` | Fan a design problem out into intentionally different agent runs, then synthesize a ranked decision. |

### Execute
| Skill | What it does |
|-------|--------------|
| `execute-wp` | Execute a work package from a spec, appending to a progress log as it goes. |
| `handoff` | Compact a conversation into a handoff doc so a fresh agent can pick up the work. |
| `commit-msg` | Commit via a file (`git commit -F`) so shell-active content — backticks, links, quotes — lands verbatim instead of breaking under HEREDOC parsing. |

### Review & repair
| Skill | What it does |
|-------|--------------|
| `review` | Adaptive multi-reviewer pipeline over a PR, branch, working tree, file, or plan. |
| `improve-architecture` | Find code smells and make a codebase more agent-friendly and testable. |
| `diagnose` | Force environmental / process / config / code-path hypotheses into an explicit verification flow before editing. |

### Skill meta-tooling
| Skill | What it does |
|-------|--------------|
| `audit-skills` | Score every skill in a plugin against a rubric and write results to `skills.db`. |
| `eval-loop` | Run an autonomous Karpathy-style eval loop to measurably improve a skill's output quality. |

## Install

This is a Claude Code plugin distributed via its own marketplace manifest.

```
/plugin marketplace add sirmaelstrom/heathdev-workshop-plugin
/plugin install heathdev-workshop
```

Or point Claude Code at a local clone during development:

```
/plugin marketplace add /path/to/heathdev-workshop-plugin
```

Once installed, the skills trigger by description (e.g. "write a spec for…", "review my branch", "diagnose this") or by slash command (`/spec`, `/review`, `/diagnose`, …).

## Conventions & assumptions

This is a personal plugin, so a few skills assume my environment:

- **Output location.** Several skills write artifacts to `./outputs/{category}/` (relative to your working directory) by default. That's a documented convention, not a hard dependency — I personally redirect it to a canonical "data brain" via my own global config; adjust to taste if you adopt these skills.
- **Pattern library.** The methodology these skills draw on is bundled in [`reference/`](./reference/) — patterns, checklists/conventions, templates, and heuristics. `spec`, `spec-validate`, and `execute-wp` read from it at runtime (`reference/patterns/`, `reference/templates/`). No external repo needed.
- **`skills.db`.** `audit-skills` and `eval-loop` read/write a local SQLite inventory seeded by `scripts/init-skills-db.mjs` (uses Node's native `node:sqlite`, so Node 24+). The DB is git-ignored.
- **Optional integrations.** `eval-loop`'s automation scripts can post to a Discord webhook (`DISCORD_WEBHOOK_URL`) and mirror results to a ledger endpoint (`LEDGER_URL`). Both are off unless you set those env vars.

## License

[MIT](./LICENSE) © 2026 Justin Heath
