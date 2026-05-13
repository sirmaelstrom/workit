# synthesis.json Schema — v1.0

This is the v1.0 contract for `synthesis.json` consumed by `scripts/render-synthesis.mjs`. The renderer derives both `synthesis.md` (human-readable markdown) and `synthesis.html` (styled single-file report) from this JSON. The JSON is the authoritative data source; both rendered artifacts are views of it. For a working example, see `synthesis-example.json` in this directory.

---

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | yes | Must equal `"1.0"`. The renderer rejects any other value. |
| `run_slug` | string | yes | Unique identifier for this run. Format: `{goal-kebab-40chars}-{YYYYMMDD}-{HHMMSS}`. Falls back to `explore-{YYYYMMDD}-{HHMMSS}` if goal is empty. |
| `created_at` | string | yes | ISO-8601 timestamp of when the synthesis was produced (e.g. `"2026-05-13T14:50:32Z"`). All rendered timestamps derive from this field — the renderer never reads the runtime clock. |
| `goal` | string | yes | The single design question being explored. Displayed prominently in the rendered output. |
| `non_goals` | string[] | yes | Things explicitly out of scope for this exploration. At least 1 entry expected. |
| `hard_constraints` | string[] | yes | Requirements that cannot be relaxed. The renderer may display these as a callout block. |
| `evaluation_criteria` | object[] | yes | Rubric axes used to score each branch. See `evaluation_criteria[]` table. At least 1 entry required. |
| `branches` | object[] | yes | The parallel design alternatives being compared. See `branches[]` table. At least 1 entry required (typically 2–4). |
| `comparison_matrix` | object[] | yes | Structured scoring grid: one row per criterion, one cell per branch. See `comparison_matrix[]` table. |
| `branches_agree` | string | yes | Markdown string: what all branches converge on, regardless of other differences. |
| `branches_disagree` | string | yes | Markdown string: the core axes of disagreement between branches. |
| `hidden_assumptions` | string | yes | Markdown string: unstated assumptions embedded in the analysis. May include bold text and inline code. |
| `recommendation` | object | yes | The recommended branch and rationale. See `recommendation` table. |
| `uncertainty` | string | yes | Markdown string: remaining unknowns that could change the recommendation. |
| `next_action` | string | yes | Markdown string: concrete steps to proceed after reading the synthesis. |

---

## `evaluation_criteria[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier referenced by `comparison_matrix[].criterion_id` (e.g. `"ec1"`). |
| `name` | string | yes | Human-readable criterion label (e.g. `"Operational simplicity"`). |
| `weight` | string | yes | Importance weight. Enum: `"high"` \| `"medium"` \| `"low"`. |

---

## `branches[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier for this branch (e.g. `"branch-1"`). Referenced by `comparison_matrix[].cells[].branch_id` and `recommendation.branch_id`. |
| `title` | string | yes | Short descriptive name for the branch approach. |
| `thesis` | string | yes | One-sentence summary of the branch's core argument. |
| `proposed_design` | string | yes | Markdown string describing the design in detail. Must include at least one bulleted list (`-` or `*` items). |
| `why_this_wins` | string | yes | Markdown string: the strongest case for choosing this branch. |
| `tradeoffs` | string | yes | Markdown string: costs and drawbacks of this branch. |
| `failure_modes` | string | yes | Markdown string: how this branch fails under adverse conditions. |
| `operational_complexity` | object | yes | Structured complexity assessment. See `operational_complexity` below. |
| `verification_plan` | string | yes | Markdown string: how to verify the branch works correctly. |
| `first_implementation_slice` | string | yes | Markdown string: the smallest first step to prove the approach end-to-end. |
| `rejects_from_others` | string | yes | Markdown string: specific arguments from competing branches this branch explicitly rejects. |

### `branches[].operational_complexity`

| Field | Type | Required | Description |
|---|---|---|---|
| `score` | integer | yes | Complexity score from 1 (simplest) to 5 (most complex). See score range section. |
| `justification` | string | yes | One-sentence explanation of why this score was assigned. |

**`operational_complexity.score` range: 1–5**

- `1` — Trivially simple; no new infra or code concerns
- `2` — Minor overhead; well-understood components
- `3` — Moderate complexity; requires discipline or coordination
- `4` — High complexity; significant new infrastructure or lifecycle concerns
- `5` — Very high complexity; new systems, teams, or expertise required

---

## `comparison_matrix[]` and `comparison_matrix[].cells[]` subfields

Each row in `comparison_matrix` corresponds to one `evaluation_criteria` entry. Each cell within a row corresponds to one branch.

| Field | Type | Required | Description |
|---|---|---|---|
| `criterion_id` | string | yes | Must match an `id` in `evaluation_criteria[]`. |
| `criterion_label` | string | yes | Human-readable label for display (may differ in casing from `evaluation_criteria[].name`). |
| `cells` | object[] | yes | One cell per branch. |

### `comparison_matrix[].cells[]` subfields

| Field | Type | Required | Description |
|---|---|---|---|
| `branch_id` | string | yes | Must match an `id` in `branches[]`. |
| `score` | integer | yes | Score for this branch on this criterion. Must be an integer in [1, 5]. |
| `characterization` | string | yes | Short description of why this branch received this score. Maximum 80 characters. |

**Score-to-color mapping (enforced by the renderer):**

| Score | Color name | Hex |
|---|---|---|
| 1 | Red | `#fca5a5` |
| 2 | Orange | `#fdba74` |
| 3 | Yellow | `#fde68a` |
| 4 | Light green | `#86efac` |
| 5 | Green | `#4ade80` |

---

## `recommendation`

| Field | Type | Required | Description |
|---|---|---|---|
| `branch_id` | string | yes | Must match an `id` in `branches[]`. The renderer fails loudly if this is a dangling reference. |
| `rationale` | string | yes | Markdown string explaining why this branch is recommended over the others. |

---

## Validation rules enforced by the renderer

The renderer (`scripts/render-synthesis.mjs`) validates these rules on startup and exits non-zero with a human-readable message to stderr if any rule is violated:

- `schema_version` must equal `"1.0"` — any other value is rejected immediately
- `branches.length >= 1` — a synthesis with no branches is invalid
- `recommendation.branch_id` must match one of `branches[].id` — dangling references are rejected (cross-field validation)
- All `comparison_matrix[].cells[].score` values must be integers in `[1, 5]` — fractional or out-of-range scores are rejected
- `--input` and `--output-dir` CLI flags are both required — missing either causes immediate exit with usage text

These rules are the M6 constraints from the workshop constraint architecture. Failing loudly prevents silent partial output and ensures artifact integrity.
