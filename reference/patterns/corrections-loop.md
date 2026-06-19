# Pattern: corrections-loop

**What:** Log every AI mistake once with date and fix. The correction compounds forever — you pay for the mistake once, and every future agent benefits.

**When to use:** After any dispatch or AI-assisted work that produced an error, used a deprecated API, or made an incorrect assumption.

## The Loop

1. **Mistake happens** — Agent uses wrong API, deprecated pattern, incorrect assumption
2. **Log it** — Add to the project's CLAUDE.md with date and correct approach
3. **Verify it works** — Next dispatch in that project should not repeat the mistake
4. **Graduate cross-project** — When the same correction appears in 2+ project CLAUDE.md files, move it to `CORRECTIONS.md` (global)
5. **Prune** — Monthly review. Remove corrections that haven't recurred in 60+ days. They've either been internalized or are no longer relevant.

## Format

In CLAUDE.md:
```markdown
## Corrections
- [2026-02-15] Use `$state()` not `let` for reactive variables in Svelte 5 runes mode
- [2026-02-18] Date parsing: always specify format explicitly, don't rely on browser defaults
- [2026-02-20] Test command is `npm test`, not `npm run test` (this project uses vitest directly)
```

## Why This Works

AI agents don't have persistent memory across sessions. CLAUDE.md is loaded at the start of every session. A correction logged today is active for every future agent interaction with that project — indefinitely.

The compounding effect: 20 corrections over 2 months means every new agent starts with 20 lessons learned. The project gets *smarter* without the codebase changing.

## The Graduation Rule

Same mistake in 2+ projects → it's not project-specific, it's a general pattern. Move to global CORRECTIONS.md so all projects benefit.

## Execution Feedback

*(Append results here)*

---
*Source: spec-driven-engineering-guide.md, CORRECTIONS.md*
*Cross-cutting discipline — applies after any dispatch or AI-assisted work*
*See also: `spec-engineering`, `constraint-architecture`, `evaluation-loop`, `trust-ramp`*
