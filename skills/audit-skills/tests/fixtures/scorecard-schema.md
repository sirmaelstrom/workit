# scorecard.json Schema — v1.0

This is the v1.0 contract for `scorecard.json` consumed by `scripts/render-scorecard.mjs`. The renderer derives both `scorecard.md` (human-readable markdown) and `scorecard.html` (styled single-file report) from this JSON. The JSON is the authoritative data source; both rendered artifacts are views of it. For a working example see `scorecard-example.json` in this directory.

This contract is intentionally narrow: it carries only what the renderer needs to produce a comparable scorecard view. The audit skill's full reasoning lives in the markdown report; this JSON is the structured projection.

---

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | yes | Must equal `"1.0"`. The renderer rejects any other value. |
| `run_slug` | string | yes | Identifier for this audit run. Format: `audit-{YYYYMMDD}-{HHMMSS}` (UTC). The audit skill assigns this. |
| `created_at` | string | yes | ISO-8601 timestamp of when the audit was produced. The renderer uses this string verbatim and never reads the runtime clock. |
| `plugins` | string[] | yes | The plugins covered by this audit (e.g. `["workit","sirmaelstroms-claude-code"]`). At least 1 entry. Every `skills[].plugin` value must appear here. |
| `summary` | object | yes | Aggregate summary. See `summary` below. |
| `dimensions` | object[] | yes | The rubric dimensions used for scoring. At least 1 entry. Order is the column order in the rendered grid. |
| `skills` | object[] | yes | One row per assessed skill. At least 1 entry. |
| `top_actions` | object[] | yes | Prioritized improvement actions. May be empty. |

---

## `summary` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `skills_assessed` | integer | yes | Total count of assessed skills. Typically equals `skills.length`. |
| `average_score` | number | yes | Mean Likert score across all skills × all `likert5` dimensions. Numeric; not pre-formatted. |
| `karpathy_eligible_count` | integer | yes | Count of skills with `karpathy_eligible === 1`. |
| `highest_roi_skill_id` | string | yes | The `skills[].id` of the rank-1 row. Must match an existing `skills[].id`. |

---

## `dimensions[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable identifier referenced by `skills[].scores`. Conventionally snake_case (e.g. `"description_quality"`). |
| `label` | string | yes | Human-readable column header. May be shorter than `id` (e.g. `"Description"`). |
| `kind` | string | yes | Score scale. Enum: `"likert5"` \| `"eval_coverage"` \| `"karpathy"`. |
| `description` | string | no | Optional longer description. The renderer may use it as a tooltip; v1 ignores it. |

### Score ranges per dimension `kind`

- `likert5` — integer in `[1, 5]`. Standard Likert.
- `eval_coverage` — integer in `[0, 5]`. `0` means no evaluation exists or is planned (mapped to a neutral grey tier).
- `karpathy` — integer in `[0, 1]`. Binary eligibility.

---

## `skills[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Skill identifier (matches `skills.id` in `skills.db`). Referenced by `top_actions[].skill_id` and `summary.highest_roi_skill_id`. |
| `name` | string | yes | Display name. May equal `id` for skill-kind entries, or differ for commands/agents that have a prefix in their `id`. |
| `plugin` | string | yes | Plugin name. Must appear in the top-level `plugins[]`. |
| `kind` | string | yes | One of `"skill"` \| `"command"` \| `"agent"`. Used for badge styling. |
| `rank` | integer | yes | 1-based ROI rank within this audit. Assigned by the audit skill; the renderer uses it as-is for row order. |
| `roi` | number | yes | Computed ROI value. Rendered with two decimal places when finite. |
| `karpathy_eligible` | integer | yes | `0` or `1`. Same value as `skills[].scores.karpathy_eligible.score` when that dimension is present. |
| `scores` | object | yes | Keyed by dimension `id` → score record. **Every dimension in `dimensions[]` must be present.** No extra keys allowed. |
| `notes` | string | yes | Markdown — top-level prose summary for the skill. May be the empty string. |
| `gaps` | string[] | yes | Bullet-list strings. May be empty. |
| `next_actions` | string[] | yes | Bullet-list strings. May be empty. |

### `skills[].scores.<dimension_id>` shape

| Field | Type | Required | Description |
|---|---|---|---|
| `score` | integer | yes | Score value. Must fall in the range defined by the dimension's `kind`. |
| `confidence` | string | yes | Enum: `"high"` \| `"medium"` \| `"low"`. Rendered as a confidence pill in the per-skill detail. |
| `binary_checks` | object[] | yes | The discrete rubric checks for this dimension. May be empty (e.g. `usage_frequency` has no binary checks in the rubric). |
| `evidence` | string | yes | Markdown — supports inline code, bold, italic, links, paragraphs, and bullet lists per `markdown-mini.mjs`. May be the empty string. |

### `skills[].scores.<dimension_id>.binary_checks[]` shape

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | string | yes | The rubric question (e.g. `"Single-line description"`). |
| `passed` | boolean | yes | `true` if the check passes; `false` if it fails. |

---

## `top_actions[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `rank` | integer | yes | Action priority rank (1 = highest). |
| `skill_id` | string | yes | Target skill. Must match a `skills[].id`. |
| `action_text` | string | yes | One-sentence imperative describing the change. |
| `addresses` | string | no | Short tag identifying the gap addressed (e.g. `"eval_coverage=0"`). Rendered as muted secondary text. |
| `est_roi_delta` | number | no | Estimated change in this skill's ROI score. Rendered with a Δ prefix. |
| `send_prompt_template` | string | yes | Prompt template the renderer substitutes for the "Send to agent" button. Supports tokens `{rank}`, `{skill_id}`, `{skill_name}`, `{action_text}`, `{scorecard_md_path}`. Backslashes in `{scorecard_md_path}` are normalized to forward slashes inside the attribute. |

---

## Cross-field consistency rules

The renderer enforces these in Layer 3 of `validateScorecard`. Violations fail loud with stderr messages naming the specific reference.

- Every `skills[].plugin` must appear in `plugins[]`.
- Every `dimensions[].id` must appear as a key in every `skills[].scores`.
- No `skills[].scores` key may reference an unknown `dimensions[].id`.
- `summary.highest_roi_skill_id` must match a `skills[].id`.
- Every `top_actions[].skill_id` must match a `skills[].id`.

---

## Tier rendering

The renderer derives a CSS tier class from `(dim.kind, score)`:

- `kind: likert5` — `score-1` (red) through `score-5` (green).
- `kind: eval_coverage` — `score-0` (neutral grey) through `score-5`.
- `kind: karpathy` — `elig-yes` (green) or `elig-no` (grey). Never `score-N`.

All colors are class-driven CSS; no inline color attributes.

---

## Determinism

`render-scorecard.mjs` reads no clock and no environment variables; given the same JSON and the same `--output-dir`, it produces byte-identical `scorecard.md` and `scorecard.html` files. The `created_at` value flows from the JSON, not the runtime.

---

## Author note

The malformed fixture file in this directory (`scorecard-malformed.json`) intentionally violates exactly one rule: it carries a `top_actions[0].skill_id` of `"nonexistent-skill"` that does not match any `skills[].id`. The test suite uses runtime mutation on the example fixture to cover the other validation paths.
