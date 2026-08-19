---
name: unslop
description: "Cut AI tells from prose — puffery, filler, hedging, chatbot phrases, weak verbs, metaphor jargon — and put a human voice back in. Trigger: 'unslop', 'deslop', 'make this read human', or before publishing docs, README prose, PR bodies, briefs. Not for code or quoted material; domain terms defined in UBIQUITOUS_LANGUAGE.md are exempt from the jargon cut."
---

# Unslop — Cut AI Tells From Prose

Edit text to remove AI patterns and add human voice. Ported from Lauren "potato" Tan's `unslop` skill (cursor/plugins → pstack, MIT — license note at the bottom). House deltas from upstream: rule 13 softened (em dashes are house style), rules 17–18 annotated to house conventions, rule 26 gated on the project glossary.

## Scope

Run on prose meant for humans: docs, README text, PR bodies, briefs, briefing copy, handoff narrative, blog drafts. Leave alone: code and code blocks, verbatim quotes and citations, error messages being reported, front matter, and identifiers the text is describing.

## Process

1. If the target lives in a project, read `UBIQUITOUS_LANGUAGE.md` at the project root (the `/ubiquitous-language` output). Its defined terms are the exemption set for rule 26.
2. Scan for the patterns below.
3. Rewrite. Preserve meaning, match intended tone.
4. Add soul (see next section).
5. Self-audit: "What makes this obviously AI generated?" Fix remaining tells.

## Adding soul

Removing patterns is half the job. Sterile, voiceless writing is just as obvious.

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time. Mix it up.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive."
- **Use "I" when it fits.** First person isn't unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but "there's something unsettling about agents churning away at 3am."

## Patterns to detect and fix

Numbering follows the upstream skill verbatim, so a rule stays addressable ("rule 26") across both copies. The pattern strings below are *examples to detect in the target text* — finding them here in the rule definitions is not a hit.

### Content

1. **Puffery.** "pivotal moment", "testament to", "evolving landscape", "setting the stage for", "indelible mark", "deeply rooted". Cut puffery, state what happened.
2. **Name-dropping.** Listing media outlets without context. Pick one, say what was said.
3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or expand with real sources.
4. **Promotional language.** "nestled", "vibrant", "breathtaking", "groundbreaking", "renowned", "stunning", "must-visit". Use neutral descriptions.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete.
6. **Formulaic challenges.** "Despite challenges... continues to thrive." Replace with specific facts.

### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Replace with plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Just say "is" or "has".
9. **"Not just X, but Y."** State the point directly instead.
10. **Rule of three.** Forcing ideas into groups of three. Use the natural number.
11. **Synonym cycling.** Protagonist, main character, central figure, hero all in one paragraph. Pick one, repeat it.
12. **False ranges.** "from X to Y" where X and Y aren't on a meaningful scale. List topics directly.

### Style

13. **Em dash monotony** *(house deviation — upstream bans em dashes outright)*. Em dashes are house style; the tell is rhythm, not existence. Flag a run of sentences that all reach for the same dash-appositive shape and vary it: end the sentence, use a comma, restructure. Never mass-delete em dashes from house prose.
14. **Colon overuse.** Colons are fine before a list or example. Not as mid-sentence connectors. "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" adds nothing with the colon. Rewrite to let the point stand on its own without comparison framing. "Describing when the scheduler should fire works best as plain English." Same meaning, no crutch punctuation.
15. **Boldface overuse.** Don't bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon that restates the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine, not a tell.
17. **Title case headings.** Use sentence case *(house note: match the document's existing heading convention — don't churn an established doc in either direction)*.
18. **Decorative emojis.** Remove from headings and bullets *(house note: functional status glyphs — ⛔, ✓ — on ops surfaces are signal, not decoration)*.
19. **Curly quotes.** Replace with straight quotes.

### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.
21. **Cutoff disclaimers.** "While specific details are limited..." Find sources or remove.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". "It is important to note that" gets deleted.
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans or facts.

### Jargon — glossary-gated

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, primitive (as noun), harness (as metaphor), surface (as in "API surface"), bedrock, scaffolding (as metaphor), modality, paradigm, gold-plating, ratchet (as metaphor), evacuate (for moving code), endgame, north star, flywheel. These read as technical but usually have a plainer concrete word. "Substrate" becomes "base". "Wedge in" becomes "add". "Vector" becomes "way" or "method". "Gold-plating" becomes "more than the job needs". "Ratchet" becomes the mechanism's real name or "a limit that only tightens". "Evacuate" becomes "move out". "Endgame" becomes "the last phase". Pick the concrete word.

   **The gate** *(house deviation — upstream cuts unconditionally)*: before cutting, check the exemption set — `UBIQUITOUS_LANGUAGE.md` in the target project's root. A term defined there is domain vocabulary, not filler: keep it, spelled the way the glossary spells it. An undefined metaphor noun gets the concrete word. If there is no glossary and the text leans on these nouns as load-bearing domain terms, offer `/ubiquitous-language` to define them instead of mass-cutting — whether a word is vocabulary or filler is the operator's call, made once in the glossary rather than re-litigated per edit.

### Plain speech

27. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you can't restate it as a concrete instruction, fact, or number, cut it. One more check: if the sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
28. **Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.
29. **Active voice.** Prefer it. Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries", "the file is parsed by the loader" becomes "the loader parses the file". Passive is fine only when the actor is unknown or genuinely doesn't matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" becomes "use", "leverage" becomes "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if". The fancier synonym is rarely clearer.

## Rules

- **Preserve meaning.** A cut that changes what the text claims is a defect, not an edit.
- **Match the register.** A PR body, a README, and a brief have different tolerances for voice; keep the document's own.
- **Show the edit.** Present rewritten text, not a lecture about the patterns found. Summarize which rules fired only when the operator asks.
- **Quoted material is evidence.** Never unslop text the document is quoting or reporting — only text the document is asserting.

## Relationship to other skills

- **`/ubiquitous-language`** — produces `UBIQUITOUS_LANGUAGE.md`, the rule 26 exemption set. This skill is that glossary's consumer: defined terms survive the jargon cut, undefined ones don't.
- **`/handoff`, `/spec`, `/commit-msg`** — their artifacts are prose surfaces this skill can be run over after the fact; none of them invoke it automatically.

<supporting_info>

## Origin

Ported from Lauren "potato" Tan's `unslop` skill — `pstack/skills/unslop/SKILL.md` in the Cursor plugins monorepo (github.com/cursor/plugins; the `backnotprop/pstack` repo is a stale mirror). MIT-licensed; substantial portions reproduced verbatim, so the upstream copyright and permission notice is preserved at `UPSTREAM-LICENSE` in this directory. House deltas: rule 13 softened, rules 17–18 annotated, rule 26 glossary-gated; upstream's `description` ("Must always apply") replaced with trigger-based invocation, because always-apply descriptions get evicted by usage score in a fat skill stack.

</supporting_info>
