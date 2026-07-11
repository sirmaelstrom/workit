# Pattern: worktree-rooting

**What:** Deterministic resolution of *where* work happens. A work item's target repo is **declared** (in the spec, the quest, or an explicit path) and **enforced** — the session's cwd is never consulted. One canonical recipe for creating worktrees and one mandatory identity assertion before any edit. This file is the single source of truth; every other doc that mentions worktree rooting points here (pointer-not-value).

**When to use:** Any dispatch that edits a repo — an `execute-wp` run, a roadmap/loop orchestrator spawning agents, or a multi-repo campaign. If an agent is about to run `git` or edit a file inside a repo, this pattern governs how it decided which repo.

## The Principle: Targets Are Declared, Never Ambient

The failure mode this kills: an agent inherits the session's cwd and roots its work there. On Windows, harness `isolation:"worktree"` spawns create a worktree of the *session's* repo only — correct for same-repo targets, **silently wrong-repo for siblings**. A cwd-derived target passes every gate (the wrong repo compiles fine) and fails only at integration, or worse, lands changes in the wrong codebase.

So: **cwd is never an input to target resolution.** Not as a fallback, not as a tiebreaker. A work item that cannot resolve its target from declared sources is under-specified — stop and ask; don't guess from where you happen to be standing.

## Resolution Order

Three declared sources, in precedence order:

1. **Explicit path** — the work item names an absolute path under a repo (e.g. in a WP's Files list, a spec, or an operator instruction). That repo is the target.
2. **Quest place** — roadmap surfaces only: the quest's `projects-*` place declares the target (see the roadmap section below).
3. **Spec declaration** — the workshop's `meta.projects` plus the work package's inventory `Project` value.

Each surface binds only the sources it actually has (next section) — a spec-driven run has no quest, a quest-driven run may have no spec yet.

## Per-Surface Input Binding

### execute-wp / CLI (spec-driven)

The only inputs are the WP file, the workshop's `meta.json`, and the orchestrator's Package Inventory:

1. If the WP's **Files** list contains absolute paths under a repo (e.g. `<workspace-root>/projects/<repo>/...`) → that repo is the target.
2. Else read `meta.projects` + this WP's inventory `Project` value → the target is `<workspace-root>/projects/<name>`.
3. **Never** `process.cwd()`. If neither source resolves, the WP is under-specified — stop and report.

Quest-place resolution is **out of scope for execute-wp**: a spec-driven run has no quest. Do not add quest lookups to this surface — the two consumers must not conflate their input sources.

`spec-validate` enforces the declaration side: `meta.projects` must be a non-empty array, every inventory `Project` must appear in it, and with `--workspace-root <abs>` (or `WORKIT_WORKSPACE_ROOT`) each project must resolve on disk.

### Roadmap / loop orchestrator (quest-driven)

The target comes from the quest's **place**: the attached place whose slug starts with `projects-` (kind `location`). Its `path` is **workspace-relative** (e.g. `\projects\workit`) — **join it to the resolved workspace root before any `git -C`**; never feed the stored path to git raw.

The workspace root itself is declared, not ambient: an explicit operator argument or the `WORKIT_WORKSPACE_ROOT` env var — never derived from cwd, never a hardcoded machine path. A quest with no `projects-*` place has no declared target — resolve it from the quest's spec (if one exists) or stop; do not guess.

A quest carries **at most one** `projects-*` place. Multi-repo work is modeled as separate single-repo quests linked by `decomposition` seams — not one quest with N places.

## Worktree Creation (the recipe)

The **orchestrator creates worktrees** — never rely on harness worktree isolation for a sibling-repo target (see the Windows failure above). The exact command:

```
git -C <abs-target-repo> worktree add <abs-target-repo>-wt-<slug> -b <branch>
```

- `<abs-target-repo>` — the absolute repo path from the resolution above.
- `<slug>` — the work item's slug; the worktree lands beside the repo as `<repo>-wt-<slug>`.
- `<branch>` — for multi-repo items, the **identical branch name in every repo** (see joint merge below).

Then spawn a plain agent pointed at the absolute worktree path — with the STEP-0 assertion baked into the top of its prompt.

Do **not** reintroduce a `WorktreeCreate` hook: that hook *replaces* worktree creation and kills every harness isolation spawn. Policy stands: no hook; orchestrators create worktrees explicitly.

## STEP-0: Assert Identity Before Any Edit

The first action in any repo-targeted workspace — before the first edit, in every spawned-agent prompt:

```
git rev-parse --show-toplevel    # must equal the intended repo/worktree path
git remote get-url origin        # must match the intended repo's remote
```

On mismatch: **do not proceed and do not "fix" the cwd.** Create the worktree yourself with the recipe above and build there. This self-check has caught 100% of wrong-repo spawns so far — it is the enforcement half of the pattern.

**Loose-file carve-out:** files at the workspace root that belong to no repo (e.g. the workspace-root `CLAUDE.md`) are edited directly from the workspace root by the operator/orchestrator. STEP-0 applies to repo-targeted work only.

## Multi-Repo: The Joint-Merge Minimum

A multi-repo work item is N single-repo lanes that land together:

1. **One worktree per target repo**, all created with the recipe above, all on the **identical branch name**.
2. **An ordered merge list declared up front** — all N repos, named before any lane starts.
3. **Per-repo green gate**: a repo's worktree is merge-eligible only when that repo's *real* gate (as stated in the orchestrator, verified against the repo) passes.
4. **Merge order**: dependency order when a contract flows between repos (producer merges first); otherwise any order — but **all repos must be green before the last one merges**. No partial landings: a red gate in any repo blocks the whole set.

## Mechanical Proof

`scripts/verify-worktree-rooting.mjs` pins the recipe mechanically: it invokes the exact argv above (not a reimplementation) across four cwd cases — not-a-repo, wrong-repo, right-repo, and multi-repo (two repos, same branch) — and asserts `rev-parse --show-toplevel` + `remote get-url origin` for every created worktree. Run it with:

```
node scripts/verify-worktree-rooting.mjs
```

Exit 0 = rooting is cwd-independent. If the recipe in this file ever changes, the proof script must change in the same commit.

## Consumers (pointers, not copies)

- `skills/execute-wp/SKILL.md` — "Root the Target" step (summary + pointer here).
- `reference/templates/_orchestrator.template.md` — one-line pointer beside Gate Commands.
- Workspace-root `CLAUDE.md` §Cross-Repo Agent Work — one-line pointer (operator-maintained; outside this repo).
- Walk-away pipeline doc §6b — one-line pointer (operator-maintained; outside this repo).

If you find the recipe restated anywhere else, that's drift — replace it with a pointer to this file.
