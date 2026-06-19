---
name: General Work Template
description: 
tags: []
variables:
  primary_action:
    label: Primary Action
    placeholder: "e.g., starting a greenfield build"
  project:
    label: Project Name
    placeholder: "e.g., your app"
  short_description:
    label: Short description
    placeholder: "e.g., a Rust application"
  additional_files:
    label: Additional file paths
    placeholder: "e.g., ~/projects/your-project/docs/myfile.md"
  build_order:
    label: Build order instructions
    placeholder: "e.g. The issues are dependency-chained. The first three have no blockers and can start immediately: ..."
  additional_instructions:
    label: Additional instructions
    placeholder: "e.g., After dependencies are installed, schema/types/layout issues unblock, then CRUD APIs, then the budget engine."
  focus_area:
    label: Priority focus
    placeholder: "e.g., server code, API layer, state management"
    default: "server code"
  additional_guidelines:
    label: Guidelines
    placeholder: "e.g., Patterns matter: The first CRUD implementation (accounts) establishes the pattern. Every subsequent feature follows it. Take extra care here.,
                        Stay in scope: The scope doc defines MVP boundaries. Don't add features beyond what's listed.,
                        After compaction: If you lose context, read CLAUDE.md, then run bd ready and bd show <id> on the next issue. The planning docs at ./outputs/projects/your-project/ have full architecture details.,"
  success_criteria:
    label: Success criteria
    placeholder: "e.g., At the end of the foundation phase: the database schema is up, all CRUD APIs work with tests passing, the budget engine correctly calculates RTA / CC auto-move / overspending with test coverage, and the app runs in Docker. The UI shell exists but feature views come next."
    default: "All items have been completed and verified."
---

You are `{{primary_action}}` of `{{project}}`, a `{{short_description}}`.

Context,
Read these files in order before doing anything:

CLAUDE.md (in this repo) — Architecture conventions, stack decisions, key files,
`{{additional_files}}`

How to Work,
Run bd ready to see available issues,
Pick the first available P0 issue and run bd update <id> --status in_progress,
Implement it using TDD (write failing tests, then implement, then verify),
When done: commit, close the issue (bd close <id>), and check bd ready for the next one,
Continue through the dependency chain — issues unlock as their blockers are closed,

Build Order,
`{{build_order}}`,

`{{additional_instructions}}`
Your priority of focus should be `{{focus_area}}`

Guidelines,
TDD: Write failing tests before implementation. The architecture doc (section 6) has concrete test examples for the budget engine.,
Commit often: Each completed issue should be one or more commits. Push after each issue.,

What Success Looks Like,
`{{success_criteria}}`

Work autonomously. Commit and push after each issue. If you hit a decision point not covered by the planning docs, create a bd issue noting the question and move on to the next unblocked task.