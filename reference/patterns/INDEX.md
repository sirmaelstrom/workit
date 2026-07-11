# Pattern Library — Index

*Short-name references for conversational use. Say the name, the agent pulls the pattern.*

## The Workshop Pipeline

Sequential stages that produce workshop artifacts. Each stage has a concrete output.

| Stage | Pattern | What It Produces | File |
|---|---|---|---|
| 1 | `problem-statement` | Self-contained problem capture — the stake in the ground | problem-statement.md |
| 2 | `decision-resolution` | Ambiguity elimination + option forcing analysis — resolve every "or", price every path, apply the Pragmatist Check | decision-resolution.md |
| 3 | `verification-criteria` | Testable success criteria for every decision — the specification act | verification-criteria.md |
| 4 | `constraint-architecture` | Four-category constraint system — musts, must-nots, preferences, escalation triggers | constraint-architecture.md |
| 5 | `decomposition` | Independent, testable, parallelizable work units + break patterns | decomposition.md |
| 6 | `work-package` | The atomic dispatchable unit — precondition, goal, files, verification, failure criteria, boundary, commit | work-package.md |

## Cross-Cutting Disciplines

Not sequential steps — principles that govern how artifacts are written throughout the pipeline.

| Pattern | What It Governs | File |
|---|---|---|
| `test-first-spec` | How verification fields get written. The independent observer test. Specification through testability. | test-first-spec.md |
| `spec-engineering` | Umbrella philosophy — the spec is the product, code is a side effect. Quality measurement (100-point scale). | spec-engineering.md |
| `evaluation-loop` | Post-execution quality feedback — dispatch outcomes, pattern effectiveness, regression detection. Least mature pattern; manual process today. | evaluation-loop.md |
| `corrections-loop` | Post-failure learning — log mistakes in CLAUDE.md, graduate cross-project, prune stale corrections. | corrections-loop.md |
| `constraint-discovery` | Domain knowledge lifecycle — discover, articulate, encode, search, validate constraints across triage, implementation, and review. | constraint-discovery.md |
| `trust-ramp` | Autonomy graduation — systems earn trust through empirical success, demote on failure. | trust-ramp.md |
| `review-council` | Pre-dispatch multi-model review — 3+ independent reviewers, synthesis, amendment cycle. | review-council.md |
| `observability-contract` | Every automation boundary needs three things: precondition, postcondition, runtime invariant. Design by Contract for agentic systems. | observability-contract.md |
| `html-artifact-shapes` | For decision-point skills: emit structured JSON, deterministically render canonical markdown + interactive single-file HTML, carry a clipboard round-trip back to the next agent turn. | html-artifact-shapes.md |

## Execution Patterns

How to run work once it's specified:

| Pattern | What It Does | File |
|---|---|---|
| `wave-execution` | Parallel dispatch in waves — dependency analysis, disjoint-file verification, deterministic ordering | wave-execution.md |
| `wave-review` | Multi-agent code review — cartographer → focused reviewers → adversarial synthesis | wave-review.md |
| `campaign-closeout` | Post-campaign lifecycle — review wave, post-mortem, feed-back to patterns | campaign-closeout.md |
| `cross-repo-contract` | Wire format contracts for multi-repo campaigns — exact types, payload shapes, schema registration | cross-repo-contract.md |
| `meta-prompt` | 3-part architecture for complex multi-agent work — orchestrator, parallelization plan, spec | meta-prompt.md |
| `worktree-rooting` | Deterministic target rooting — declared targets (spec/quest/explicit path, never cwd), the canonical worktree-creation recipe, STEP-0 identity assertion, joint-merge minimum | worktree-rooting.md |

## Checklists & Conventions

Concrete instruments — checklists and conventions the skills and patterns draw on. Each does something no skill covers. (Folded in when the former `operational/` templating layer was retired; the parameterized drop-in prompts that overlapped existing skills were dropped.)

| Name | Purpose | File |
|---|---|---|
| `audit-codebase` | Parallel 4-agent codebase health audit (security, quality, DX, testing) | audit-codebase.md |
| `spec-scorecard` | Post-dispatch spec quality evaluation (100-point scale) — instruments `evaluation-loop` Layer 1 | spec-scorecard.md |
| `post-build-verification` | Post-build punch list — interaction, palette, semantics, data, a11y, errors | post-build-verification.md |
| `decision-record` | Lightweight ADR that couples each decision to the conditions that would reverse it (the "What Would Change This" discipline) | decision-record.md |

## Workshop Artifact Templates

Copyable skeletons for the key workshop files. Located in `templates/`.

| Template | What It Produces | File |
|---|---|---|
| `_orchestrator.template.md` | Campaign orchestrator — wave plan, package inventory, gate commands, constraints | _orchestrator.template.md |
| `meta.json.template` | Workshop metadata — title, slug, status, projects, tags. Field reference included. | meta.json.template |
| `problem-statement.template.md` | Problem capture — self-contained description, current state, what solved looks like | problem-statement.template.md |
| `post-mortem.template.md` | Campaign post-mortem — summary, timeline, findings, analysis, cross-campaign comparison, feed-back checklist | post-mortem.template.md |

## Superseded

| Old Name | Replaced By | Reason |
|---|---|---|
| `scope-fence` | `constraint-architecture` | scope-fence covered must-nots only (~40% of constraint space) |

---
*20 active patterns, 4 checklists/conventions, 1 superseded, 4 artifact templates. To add: create the .md, add a row.*
*Patterns evolve — append execution feedback directly to pattern files.*
