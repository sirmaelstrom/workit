# reference/ — Methodology Library

The **philosophy and patterns** layer of this toolkit. The `skills/` are the active, triggerable interface; this `reference/` layer is the methodology they draw on — the *why* and *how* behind the *what*.

Several skills read these files at runtime (e.g. `spec` reads `patterns/*` as it writes each artifact; `execute-wp` and `spec-validate` use the templates). They're also useful to read directly.

## Layout

| Directory | What's in it |
|-----------|--------------|
| `patterns/` | The methodology itself — pipeline stages (problem-statement → decomposition → work-package), cross-cutting disciplines (test-first-spec, constraint-architecture, trust-ramp…), and execution patterns (wave-execution, campaign-closeout…). **Start at [`patterns/INDEX.md`](patterns/INDEX.md).** |
| `templates/` | Copyable skeletons for workshop artifacts — `_orchestrator.template.md`, `meta.json.template`, problem-statement / post-mortem templates, and the `review-council/` prompt set. |
| `operational/` | Drop-in operational prompt templates with YAML frontmatter (`{{variable}}` interpolation) — codebase audit, code review, research brief, session handoff, spec scorecard, and more. |
| `heuristics/` | Sizing and decomposition guidelines (`wp-sizing.md`). |
| `examples/` | Worked examples — e.g. a spec-scorecard evaluation showing what the feedback loop looks like in practice. |

## Origin

This material was previously a standalone `heathdev-patterns` repo. It's bundled here because the methodology and the skills that operate on it belong together — the toolkit is *philosophy + patterns + concrete implementations* in one place. Personal/project-specific references have been generalized so the patterns are portable to any project.

Patterns evolve through use — append execution feedback directly to the relevant file, then update `patterns/INDEX.md` if you add a new one.
