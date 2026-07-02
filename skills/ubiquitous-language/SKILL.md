---
name: ubiquitous-language
description: "Extract domain terminology into a glossary. Trigger: 'domain language', 'glossary', 'terminology', or when ambiguous terms cause confusion in a project."
---

# Ubiquitous Language — Domain Glossary Extraction

Extract domain-relevant terminology from the current conversation and/or codebase into a consistent, opinionated glossary. From Domain-Driven Design: shared language eliminates a class of bugs that no amount of testing catches.

## Why This Exists

Terminology drift is invisible friction. When a spec says "campaign" and the code says "dispatch run," when a workshop says "briefing" but the DB schema says "schedule" — agents resolve the ambiguity by guessing, and they guess wrong. A canonical glossary prevents this class of error for every downstream skill that reads it.

## Process

### 1. Scan Sources

Read from multiple signals — don't rely on any single source:

- **Codebase** — class/type names, API endpoints, DB schemas, config keys. These are the terms that matter at runtime.
- **Conversation** — what the user actually calls things (may differ from code).
- **Existing documentation** — CLAUDE.md, README, workshop artifacts. Check for existing `UBIQUITOUS_LANGUAGE.md` first.
- **Knowledge Base** — search KB for the project name to surface historical terminology decisions.

### 2. Identify Problems

- Same word used for different concepts (ambiguity) — e.g., "session" means both "user login session" and "Claude conversation session"
- Different words used for the same concept (synonyms) — e.g., "dispatch," "task," "run" all meaning the same thing
- Vague or overloaded terms — e.g., "config" meaning everything from YAML files to DB settings to environment variables

### 3. Propose Canonical Glossary

Write to `UBIQUITOUS_LANGUAGE.md` in the project root:

```markdown
# Ubiquitous Language

## [Domain Area]

| Term | Definition | Aliases to avoid | Used in |
|------|-----------|-----------------|---------|
| **Term** | One-sentence definition of what it IS | Words that shouldn't be used | `file.ts`, `schema.sql` |

## Relationships

- A **Term** belongs to exactly one **OtherTerm**
- A **Term** can have many **RelatedTerms**

## Flagged Ambiguities

- "X" was used to mean both **A** and **B** — these are distinct concepts because [reason]
```

The "Used in" column is what makes this actionable — it connects terms to the code that defines their behavior.

### 4. Wire Into the Pipeline

After writing the glossary, make it discoverable:

**CLAUDE.md reference** — Append a note to the project's CLAUDE.md:
```markdown
## Domain Language
See `UBIQUITOUS_LANGUAGE.md` for canonical terminology. When writing specs, code, or documentation for this project, use the terms defined there. Flag any new terms or conflicts.
```

**Workshop integration** — If a `/spec` is active or about to start for this project, note which glossary terms are most relevant to the workshop's problem space. The problem-statement and decisions stages benefit most from consistent terminology.

**KB persistence** — Save the glossary to the knowledge base so it surfaces in future KB searches for this project:
```
kb_save({ title: "{project} — Ubiquitous Language", category: "project", content: {glossary} })
```

### 5. Output Summary

Present findings inline — don't just write the file silently. Highlight:
- How many terms defined
- Key ambiguities resolved
- Terms that are likely to cause confusion if not addressed

## Rules

- **Be opinionated.** Pick the best term, list others as aliases to avoid.
- **Flag conflicts explicitly.** If a term is ambiguous, call it out with a recommendation.
- **Keep definitions tight.** One sentence max. Define what it IS, not what it does.
- **Only include domain terms.** Skip generic programming concepts unless they have domain-specific meaning.
- **Group by subdomain** when natural clusters emerge.
- **Code wins ties.** When conversation and code use different terms, prefer whatever the code already uses — changing code is more expensive than changing how we talk.

## Re-running

When invoked again in the same project:
1. Read existing `UBIQUITOUS_LANGUAGE.md`
2. Incorporate new terms, mark with "(new)"
3. Update evolved definitions, mark with "(updated)"
4. Re-flag new ambiguities
5. Update the KB entry

After writing, state: "I've written/updated `UBIQUITOUS_LANGUAGE.md`. I'll use these terms consistently from here. Flag any drift."

## Relationship to Other Skills

- **`/spec`** — Stage 1 (problem statement) should check for a glossary; Stage 2 (decisions) should use canonical terms
- **`/spec-validate`** — could check spec artifacts against the glossary for terminology consistency (future enhancement)
- **`/project-onboard`** — surfaces the glossary as part of project context loading
- **`/improve-architecture`** — terminology scattered across modules is a code smell this skill can diagnose

---
*Inspired by Matt Pocock's ubiquitous-language skill. Adapted with pipeline integration, KB persistence, and CLAUDE.md wiring.*
*Source: github.com/mattpocock/skills/tree/main/ubiquitous-language*
