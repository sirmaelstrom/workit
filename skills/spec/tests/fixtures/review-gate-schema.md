# review-gate.json Schema — v1.0

This is the v1.0 contract for `review-gate.json` consumed by `scripts/render-review-gate.mjs`. The renderer derives both `review-gate.md` (human-readable markdown) and `review-gate.html` (interactive triage surface) from this JSON. The JSON is the authoritative data source; both rendered artifacts are views of it. For a working example see `review-gate-example.json` in this directory.

---

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | yes | Must equal `"1.0"`. The renderer rejects any other value. |
| `run_slug` | string | yes | Identifier for this gate run. Usually the spec's slug + timestamp. |
| `created_at` | string | yes | ISO-8601 timestamp. The renderer uses this verbatim and never reads the runtime clock. |
| `spec` | object | yes | `{ title, slug, dir }` — links the gate back to the on-disk spec bundle. |
| `review_level` | string | yes | Enum: `"full"` \| `"light"` \| `"none"`. |
| `review_level_reason` | string | yes | Auto-select reason or operator override text. |
| `summary` | object | yes | Pre-gate summary block. See below. |
| `flagged_items` | object[] | yes | One entry per `[DECISION]` or `[ASSUMPTION]` callout from upstream stages. May be empty if the spec produced no flags. |
| `compile_template` | string | yes | Template used by the HTML's "Compile and copy" button. **Must contain `{decisions_blob}`** — Layer 3 enforces this. Should also contain `{general_feedback}` and `{spec_slug}` (renderer warns to stderr if missing). |

---

## `spec` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Spec title (display). May contain special characters; HTML-escaped on render. |
| `slug` | string | yes | Spec slug (kebab-case). |
| `dir` | string | yes | Absolute path to the spec bundle directory. Backslashes are normalized to forward slashes when embedded in attributes. |

---

## `summary` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `problem` | string | yes | Markdown — 1–2 sentence problem statement. Rendered via `markdown-mini`. |
| `key_decisions` | string[] | yes | Bullet list of major decisions captured in upstream stages. |
| `verification_approach` | string | yes | Markdown — one paragraph describing the strongest verification approach used. |
| `constraint_highlights` | string[] | yes | Bullet list of must-nots / escalation triggers. |

---

## `flagged_items[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable id (e.g. `"D1"`, `"A3"`). Must be unique within `flagged_items[]`. Used in DOM ids after sanitization (non-alphanumeric/dash/underscore characters become `_`). |
| `kind` | string | yes | Enum: `"DECISION"` \| `"ASSUMPTION"`. Drives the kind badge and the card's accent. |
| `title` | string | yes | One-line item title. |
| `context` | string | yes | Markdown — supports bold, italic, inline code, links, paragraphs, bullet lists. May reference other files in the spec dir. |
| `stage` | string \| null | no | Which upstream stage emitted this flag (e.g. `"problem-statement"`, `"decisions"`, `"verification"`). Rendered as a stage chip when present. |
| `default_action` | string \| null | no | Optional `"approve"` \| `"revise"` \| `"reject"`. If present, the corresponding radio is pre-checked on render. |

---

## `compile_template` substitution tokens

These tokens are substituted **client-side at click time** (when the operator presses "Compile decisions and copy"). The renderer does NOT substitute them server-side — it just preserves the template inside a `data-compile-template` attribute (HTML-attribute-escaped).

| Token | Source | Notes |
|---|---|---|
| `{decisions_blob}` | Form state | Newline-joined per-item lines. **Required** in the template. |
| `{general_feedback}` | Form state | The bottom textarea, or `"none"` if empty. Recommended. |
| `{spec_slug}` | `spec.slug` | Recommended. |
| `{spec_title}` | `spec.title` | |
| `{spec_dir}` | `spec.dir` (backslash-normalized) | |
| `{review_level}` | `review_level` | |
| `{review_gate_path}` | `spec.dir/review-gate.md` | For agent re-hydration. |
| `{approved_count}` | Form state | Integer count. |
| `{revised_count}` | Form state | Integer count. |
| `{rejected_count}` | Form state | Integer count. |

Unknown tokens (anything matching `{name}` that isn't in the table) pass through as literal text — the operator can paste-and-edit if needed.

---

## Cross-field consistency rules (Layer 3)

Violations exit non-zero with a stderr message identifying the rule.

- `flagged_items[].id` values must be unique within the array.
- `compile_template` must contain `{decisions_blob}` (otherwise the compiled response would silently lose every per-item decision).

---

## Determinism

`render-review-gate.mjs` reads no clock and no environment variables; given the same JSON and the same `--output-dir`, it produces byte-identical `review-gate.md` and `review-gate.html` files. The `created_at` value flows from the JSON, not the runtime.

---

## Author note

The malformed fixture file in this directory (`review-gate-malformed.json`) intentionally violates exactly one rule: two `flagged_items[].id` values are both `"D1"`. The test suite uses runtime mutation on the example fixture to cover other validation paths.
