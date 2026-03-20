---
name: ubiquitous-language
description: "Extract and formalize domain terminology into a consistent glossary. Use when working with a new codebase, onboarding into a domain, the user mentions 'domain language', 'glossary', 'terminology', or when ambiguous terms are causing confusion in a project."
---

# Ubiquitous Language — Domain Glossary Extraction

Extract domain-relevant terminology from the current conversation and/or codebase into a consistent, opinionated glossary. From Domain-Driven Design: shared language eliminates a class of bugs that no amount of testing catches.

## Process

1. **Scan sources** — conversation, codebase (class/type names, API endpoints, DB schemas), and existing documentation
2. **Identify problems**:
   - Same word used for different concepts (ambiguity)
   - Different words used for the same concept (synonyms)
   - Vague or overloaded terms
3. **Propose a canonical glossary** with opinionated term choices
4. **Write to `UBIQUITOUS_LANGUAGE.md`** in the project root
5. **Output a summary** inline

## Output Format

```markdown
# Ubiquitous Language

## [Domain Area]

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Term** | One-sentence definition of what it IS | Words that mean the same thing but shouldn't be used |

## Relationships

- A **Term** belongs to exactly one **OtherTerm**
- A **Term** can have many **RelatedTerms**

## Flagged Ambiguities

- "X" was used to mean both **A** and **B** — these are distinct concepts because [reason]
```

## Rules

- **Be opinionated.** Pick the best term, list others as aliases to avoid.
- **Flag conflicts explicitly.** If a term is ambiguous, call it out with a recommendation.
- **Keep definitions tight.** One sentence max. Define what it IS, not what it does.
- **Only include domain terms.** Skip generic programming concepts unless they have domain-specific meaning.
- **Group by subdomain** when natural clusters emerge.

## Re-running

When invoked again in the same project:
1. Read existing `UBIQUITOUS_LANGUAGE.md`
2. Incorporate new terms, mark with "(new)"
3. Update evolved definitions, mark with "(updated)"
4. Re-flag new ambiguities

After writing, state: "I've written/updated `UBIQUITOUS_LANGUAGE.md`. I'll use these terms consistently from here. Flag any drift."

---
*Inspired by Matt Pocock's ubiquitous-language skill. Adapted with codebase scanning and project-root output.*
*Source: github.com/mattpocock/skills/tree/main/ubiquitous-language*
