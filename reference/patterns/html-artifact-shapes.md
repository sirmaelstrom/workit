# Pattern: html-artifact-shapes

**What:** For skills that produce a decision-point artifact (pick one of N, score a grid, triage a list), emit a structured JSON file as the source of truth and derive both a canonical markdown view and an interactive single-file HTML view from it. The HTML carries clipboard-writing controls that compile selection or form state into a structured response the next agent turn consumes — closing the loop from artifact to action.

**When to use:** Any skill whose terminal output is a comparison, ranking, scorecard, or triage list — and where the operator's next move is a follow-up prompt that references the artifact's contents. The decision point is what makes the pattern earn its keep; without one, an HTML artifact is just a viewer.

---

## The Three Observed Shapes

Three skills shipped this pattern in May 2026. Each renderer is its own — same envelope, different content model:

| Shape | Skill | What the operator does | Round-trip action |
|---|---|---|---|
| **Grid-of-variants** | `parallel-explore` (`synthesis.html`) | Compares N parallel design branches side-by-side; reads each branch tile + a comparison matrix | One "Pick this branch" button per tile → copies a follow-up prompt that names the chosen branch |
| **Score-grid** | `audit-skills` (`scorecard.html`) | Scans a sortable table of skills × scoring dimensions; drills into per-skill evidence on demand | One "Send to agent" button per top-N improvement action → copies an "improve this skill" prompt |
| **Checklist-triage** | `spec` Phase 4 (`review-gate.html`) | Triages flagged DECISION/ASSUMPTION items with approve/revise/reject radios + textareas; adds general feedback | Single "Compile decisions and copy" button → reads all form state → assembles a structured Phase 5 response |

These three are intentionally per-skill, not derivatives of a shared `/html` skill. The grid pattern uses tiles; the score-grid uses table cells; the triage uses cards with form controls. A generic renderer would produce a grid that's the worst version of all three. The shared part is the *envelope*, not the *content*.

## The Envelope (Mechanical Contract)

Every renderer in this pattern implements the same mechanical guarantees. These were learned the hard way in experiment #1 and held without modification across #2 and #3 — treat them as load-bearing.

| Guarantee | Why it matters | How it's enforced |
|---|---|---|
| **Synchronous `main()` returning an integer exit code** | An `async main()` makes the natural `process.exit(main(argv))` coerce `Promise → NaN → silent exit 0`. Failures vanish. | `export function main(argv) { ... return 0|1; }`, called as `process.exit(main(process.argv))`. A unit test asserts `typeof main(['node','script','--help']) === 'number'`. |
| **Three-layer JSON validation** | A single big validation function buries which rule failed. Layered messages let the operator grep stderr for the exact rule. | Layer 1: top-level fields present, `schema_version === "1.0"`. Layer 2: per-field shape, types, enum membership, numeric ranges. Layer 3: cross-field consistency — references resolve, coverage is complete (every dimension scored for every skill, every `top_action.skill_id` known, etc.). |
| **Fail-loud stderr with grep-friendly tokens** | Operators run renderers manually and from scripts; silent failure is worse than no rendering. | Validation throws `Error` with messages like `comparison_matrix[2].cells[0].branch_id "branch-99" does not match any branch`. CLI exits non-zero on any validation error. |
| **Determinism: same input + same `--output-dir` ⇒ byte-identical output** | Diffing rendered HTML across runs is how you catch unintended template drift. If the renderer reads the clock or generates random ids, you lose that signal. | No `Date.now()`, no `Math.random()`, no env-var reads. The `--output-dir` may be embedded in attribute substitutions (e.g., paths), so byte-identity is conditional on it being held constant. Tests assert this via `Buffer.equals`. |
| **Single-file HTML** | The artifact is shareable by attachment or URL with no broken assets. CDN dependencies create silent rendering failures when offline or rate-limited. | No `<link rel="stylesheet">`, no `<script src=>`, no `@import`, no `url(http`/`url(https`. Inline `<style>` and `<script>` blocks only. System fonts (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`). A test greps the output for forbidden patterns. |
| **Node built-ins only, no npm deps** | Every dependency is a maintenance cost on a workshop-plugin that ships across machines. A bounded markdown converter is cheap; pulling `marked` is not. | Imports validated by a test: every `import` must resolve to `node:*` or to a sibling file. |
| **Bounded markdown converter (`markdown-mini.mjs`)** | A real markdown library is overkill for the subset of markdown the pattern uses; it also pulls in attack surface (raw HTML pass-through). | ~130 LOC supporting H1–H6, paragraphs, ul/ol, **bold**, *italic*, `code`, fenced code blocks, links. Raw HTML is escaped, not pass-through. Uses NUL-byte sentinels (`\x00<idx>\x00`) to protect inline-code and link spans from later inline-parse passes. |
| **Attribute-escape order `&` → `<` → `>` → `"`** | Escaping `&` last double-encodes the others (`&lt;` → `&amp;lt;`). | Single function used wherever text lands inside an HTML attribute. |
| **Unresolved-token guard** | "Added a `{{placeholder}}` to the template and forgot to substitute it" is a routine failure mode. | After all substitutions, the renderer scans the output for `{{[a-z_]+}}` and exits non-zero if any remain, naming the leftover token(s). |
| **CLI shape** | A consistent invocation across skills reduces operator overhead and makes shell aliases reusable. | `node scripts/render-<thing>.mjs --input <path>/<thing>.json --output-dir <path>`. Both flags required; missing either is a clear stderr error. |
| **Renderer never reads the source artifact** | The renderer's job is to render the JSON. If it can reach into the spec dir for additional content, the JSON stops being authoritative and the contract gets fuzzy. | Renderer code imports only the markdown-mini converter and Node built-ins. It receives one path (`--input`) and writes to one path (`--output-dir`). |

## The Round-Trip Is Load-Bearing

The HTML's value is **decision → action without rekeying**. Three observed mechanisms:

- **Per-item button → templated follow-up prompt** (parallel-explore tile, audit-skills top-action). Each button carries a `data-pick-prompt` or `data-send-prompt` attribute with a fully substituted prompt string. Click → `navigator.clipboard.writeText` → toast.
- **Form state → compiled response** (spec review gate). All form controls (radios + textareas + general feedback) feed into a single "Compile decisions and copy" button. The button assembles a `decisions_blob`, substitutes a `compile_template`, validates that revise/reject items have non-empty notes, and copies the result. Per-item state lives in the DOM; no server roundtrip.
- **Approve-all shortcut** (spec review gate). One click sets every radio to "approve" and immediately compiles + copies. The shortcut exists because in practice most flagged items end up approved; the shortcut acknowledges that without forcing the operator to click each radio.

Without the round-trip the HTML is just a viewing surface — the same artifact in markdown achieves the same purpose at lower cost. The round-trip is what makes the JSON-emit step worth the cognitive overhead.

## When NOT to Use This Pattern

| Output type | Why HTML doesn't help | What to do instead |
|---|---|---|
| **Skills with no decision point** (single-output reports) | The HTML can't offer a round-trip if there's nothing to round-trip to. | Plain markdown. |
| **LLM-only consumers** (`SKILL.md`, `CLAUDE.md`, work-package files) | HTML wastes tokens on every read. LLMs eat markdown fine. | Markdown stays markdown forever. |
| **Conversational outputs** (`grill-me`) | The artifact is the conversation itself; there's no terminal state to serialize. | Don't try to retrofit a viewing surface. |
| **Outputs that need hand-review diffing** | HTML diffs are noisy and hard to review. | Markdown is the canonical artifact; the HTML is regenerable, never committed. |
| **High-volume, low-engagement outputs** (briefings, status pings) | Novelty bias matters — if everything is HTML, nothing is. | Reserve the pattern for decision points; routine outputs stay plain. |

## The Audience Matrix

Updated from a prior design decision with what the three experiments confirmed.

| Artifact | Audience | HTML benefit? |
|---|---|---|
| SKILL.md / CLAUDE.md / MEMORY.md | LLMs only | No — token cost, no decision point |
| Work package files (wp-NN.md) | Execution agents | No — agents read markdown fine, git diffs matter |
| Workshop patterns | LLMs reading them in `/spec` | No |
| problem-statement / decisions / verification / constraints | Dual: human + LLMs | No — the LLMs read them too often, and there's no decision point at this stage |
| `_orchestrator.md` progress log | Execution agents | No |
| **Parallel-explore synthesis** | Human comparing branches | **Yes — strongest fit. Shipped.** |
| **Scorecard reports** | Human ranking + improving | **Yes. Shipped.** |
| **Spec Phase 4 review gate** | Human triaging | **Yes. Shipped.** |
| Council review synthesis | Human scanning + acting | Strong fit, not yet shipped |
| Briefings | Human reading on the web dashboard | Maybe — the web dashboard already renders them |
| Research reports / KB sources | Dual + ingestion | No — ingestion complications |
| PR writeups / status updates | Sharing with humans | Strong fit, separate from skill-output |

The "strong fit, not yet shipped" rows are candidates for future experiments. Apply the same envelope — don't re-litigate the contract.

## Reference Implementations

| Skill | Renderer | Template | Schema doc | Tests |
|---|---|---|---|---|
| parallel-explore | `skills/parallel-explore/scripts/render-synthesis.mjs` | `synthesis-template.html` | `skills/parallel-explore/tests/fixtures/synthesis-schema.md` | `tests/render-synthesis.test.mjs` |
| audit-skills | `skills/audit-skills/scripts/render-scorecard.mjs` | `scorecard-template.html` | `skills/audit-skills/tests/fixtures/scorecard-schema.md` | `tests/render-scorecard.test.mjs` |
| spec | `skills/spec/scripts/render-review-gate.mjs` | `review-gate-template.html` | `skills/spec/tests/fixtures/review-gate-schema.md` | `tests/render-review-gate.test.mjs` |

Paths are relative to the plugin repo root. The shared markdown converter lives at `skills/_shared/markdown-mini.mjs` (extracted to a single canonical location once the third renderer triggered the "extract on the third caller" rule).

When building a fourth instance:
1. Pick a name. `render-<thing>.mjs`, `<thing>-template.html`, `<thing>.json`, schema at `tests/fixtures/<thing>-schema.md`.
2. Read the closest existing reference. Don't re-derive the envelope guarantees — copy the structure and adapt the content model.
3. Write the schema doc *before* the renderer. The schema is the contract; the renderer enforces it.
4. Three-layer validation, sync `main()`, single-file HTML, unresolved-token guard. All non-negotiable.
5. Add a fixture (`<thing>-example.json`) and a malformed fixture (`<thing>-malformed.json`) that breaks exactly one rule; the malformed fixture is the schema's smoke test.

## Designing the JSON Contract

Every renderer's JSON has the same top-level skeleton:

```json
{
  "schema_version": "1.0",
  "run_slug": "<thing>-YYYYMMDD-HHMMSS",
  "created_at": "ISO-8601",
  ...content-specific fields...
}
```

Beyond that, content varies. Three guidelines learned from the three experiments:

1. **References must resolve.** Any field that points at another piece of the JSON (`recommendation.branch_id` → an entry in `branches[]`; `top_actions[].skill_id` → an entry in `skills[]`) gets a Layer 3 cross-field check. Missing target = exit non-zero.
2. **Coverage must be complete.** If your JSON has a grid shape (skills × dimensions, branches × criteria), every cell of the grid must be present in the JSON. The renderer doesn't fill in missing cells; it rejects the input.
3. **Templates that embed in HTML attributes are documented.** If your JSON carries a string like `compile_template` that gets substituted client-side at click time, document every token in the schema. The renderer should also warn (not fail) on missing optional tokens — this is how the operator learns which tokens are recognized without reading the source.

## Anti-Patterns

- **Generating HTML from the LLM directly.** The LLM emits malformed HTML some fraction of the time, and the malformed output is invisible until rendered. The JSON-emit-then-render boundary keeps the LLM honest.
- **Adding markdown features to `markdown-mini.mjs` as renderers ask for them.** Tables, footnotes, blockquotes, definition lists — every addition is a regex more, and regexes interact badly. If a renderer needs a feature, escape it server-side and put the rendered HTML in the JSON, or pre-flatten the content. The converter stays bounded.
- **Mutable HTML output.** The artifact is regenerable. Don't write tools that hand-edit `<thing>.html` — edit the JSON and re-render.
- **Linking to assets in the same workshop dir.** Single-file HTML stays single-file. If the artifact needs an image, base64-encode it into the inline CSS or omit it.
- **Client-side server-side substitution mixing.** Server-side substitutions use `{{token}}` (double braces). Client-side substitutions use `{token}` (single braces). The unresolved-token guard checks `{{token}}` only; single-brace tokens are passed through verbatim into attributes.
- **Skipping the schema doc.** The schema is the contract between the skill and the renderer. If it isn't written down, the LLM emitting JSON will drift; if it isn't kept current, every new instance re-derives it badly.

## Relationship to Other Patterns

- **`observability-contract`** — The JSON schema is the renderer's *precondition*; the rendered HTML + markdown are its *postcondition*; the determinism guarantee is its *runtime invariant*. This pattern is a concrete instance of the contract design.
- **`test-first-spec`** — The malformed-fixture file IS the verification specification for the schema. Every Layer 1/2/3 rule has a corresponding test case that asserts the rule fires.
- **`verification-criteria`** — The mechanical contract above (sync `main()`, byte-determinism, single-file HTML, etc.) is a reusable verification checklist. Drop it into a verification.md when speccing a new renderer.
- **`decomposition`** — Each new renderer is a single work package: scripts dir + template + tests dir + schema doc + SKILL.md update + smoke render. Tight, atomic, ~1 hour to ship if the envelope is reused.

## Execution Feedback

- **2026-05-13** — Three experiments shipped over a single day (parallel-explore, audit-skills, spec Phase 4). 216 tests pass across the three renderers. Operator validation: the third experiment's round-trip ("Compile decisions and copy") was confirmed end-to-end by pasting the compiled response back into the agent and observing Phase 5 read it correctly. Operator preference: pattern is now the default surface for any skill with a decision point.
- **Markdown-mini extraction completed (same day).** The third caller triggered the extraction immediately after experiment #3 landed. Pre-extraction copies were verified byte-identical (SHA256 confirmed across all three) before deletion — drift would have meant a behavior change masquerading as a mechanical move. The "no extraction until the third caller" heuristic held: the shape stabilized across all three uses, and the mechanical move took ~150 seconds via a delegated agent. Shared location: `skills/_shared/markdown-mini.mjs`. Test count dropped from 216 to 162 (clean deduplication invariant: each skill lost exactly the 27 markdown-mini tests; `_shared` gained 27).

*(Append future results here)*

---
*Source: HTML-artifacts framing decision (a prior design decision) + three shipped experiments in this plugin.*
*Cross-cutting discipline — governs how decision-point artifacts are designed across skills.*
*See also: `observability-contract`, `test-first-spec`, `verification-criteria`, `decomposition`*
