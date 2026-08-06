---
name: wait-what
description: "Restate the last explanation in short declarative sentences grounded in the project's own vocabulary. Trigger: 'wait, what?', 'I don't follow', 'what do you mean', 'explain that again', 'come again', or any signal the operator lost the thread."
---

# Wait, What? — Restate in House Language

When the operator signals confusion, restate what you just said under two rules:

1. **Simplified Technical English (ASD-STE100).** Short declarative sentences. One idea per sentence. Active voice. No stacked qualifiers, no hedging chains.
2. **The project's ubiquitous language.** Re-ground every concept in the vocabulary this project already uses. Read `UBIQUITOUS_LANGUAGE.md` in the project root if it exists and use its canonical terms.

Rule 2 is the real cure. Simple words alone don't fix a misunderstanding built on a term collision — the restatement must use *this project's* words for its domain, not generic ones. A house term quietly read in its generic sense (a "leaf" as botany instead of a delegated sub-task) can invert a conclusion while sounding perfectly clear.

## Process

1. Find what broke — usually one sentence or one term in what you just said.
2. Restate the whole point in STE, mapping each generic or abstract term to the project's canonical term for it.
3. If a term collision caused the confusion, name it explicitly: what you meant, what the house term means, which one applies.
4. If the project has no `UBIQUITOUS_LANGUAGE.md` and terminology was the failure, suggest `/ubiquitous-language` to mint one — don't inline a glossary here.

---
*Inspired by Matt Pocock's wait-what skill (v1.2). Adapted to ground restatements in the project glossary maintained by `/ubiquitous-language` rather than a context.md.*
*Source: github.com/mattpocock/skills/tree/main/wait-what*
