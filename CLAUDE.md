# CLAUDE.md — workit

*Guidance for any Claude Code session working in this repo.*

## What This Is

**workit** is a spec-and-skill toolkit for Claude Code: a plugin bundling **14 skills** (spec/plan → execute → review/repair → skill meta-tooling) plus a `reference/` library of patterns, heuristics, templates, and examples. It's the live successor to the retired `heathdev-workshop-plugin` (methodology/skills) and `heathdev-patterns` (pattern library) — both were deleted from disk and GitHub-archived **2026-07-01**; their content was bundled here (see `reference/README.md` § Origin).

## Load-bearing consumer (don't break this)

workit is **not** a purely personal toolkit anymore — it's a multi-consumer dependency:

- **Observatory's review-council reads `reference/templates/review-council/` directly.** Its MCP server points `TEMPLATES_DIR` at `workit/reference/templates/review-council` (Observatory PR #272). This clone is the **canonical, sole copy** — there is no fallback. The four templates (`spec-review.md`, `code-review.md`, `challenge.md`, `synthesis.md`) are **roster-agnostic by design** (`{{model_name}}` / `{{model_lens}}` / `{{codebase_access}}` placeholders filled at runtime); changing the council's model roster needs **no** template edit. Edit these templates only with the council contract in mind.

## Structure

- `skills/<id>/SKILL.md` — the 14 skills. **Auto-discovered by directory scan** — Claude Code plugins do not need a `skills[]` list in `.claude-plugin/plugin.json`, so there's nothing to keep in sync there (`_shared/` is shared test/lint utilities, not a user-facing skill). Slash-command pipeline is **`/spec`** (the old `/workshop` command was renamed; `workshop` survives only as the artifact-directory noun, `./outputs/workshops/{slug}/`).
- `reference/patterns/INDEX.md` — the pattern library index. `reference/{heuristics,templates,examples}/` — supporting material.
- `README.md` — the skill catalog + install/conventions. `CONTRIBUTING.md` — dev workflow (tests, commit style, how skills are structured). `reference/README.md` — provenance/origin.

## Working In This Repo

This repo is part of Justin's workspace cognitive infrastructure (KB / context-ledger / Spine). When you make a non-obvious decision here, save it to the KB and note it in the ledger; check the Spine for related quests before starting substantial work. Path variables in SKILL.md bodies (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`) resolve to absolute paths at load time — use them instead of find-based path hacks.

## Tests

Skill scripts carry their own `tests/` (Node's built-in test runner). See `CONTRIBUTING.md` for the exact commands before committing changes to any `scripts/*.mjs`.
