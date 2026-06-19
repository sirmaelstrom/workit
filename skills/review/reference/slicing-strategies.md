# Diff Slicing Strategies

The review skill assigns each Tier 2/3 reviewer ONE slicing strategy so the same change is framed differently across the wave. Per Liu et al. (arXiv 2505.17928, May 2025), different framings uniquely catch defects others miss.

Slicing applies only to entry modes that produce a diff: `pr`, `branch`, `wt`. For `plan` mode there is no diff (the plan document itself is the target), so all reviewers get `raw_diff`. For `file` mode the full file content is already fed to every reviewer, so slicing is a no-op and the strategy is recorded as `raw_diff`.

## Strategies

### `raw_diff`

Unified-diff hunks only. The baseline framing — every reviewer sees the same raw diff.

**Construction:** Use `diff_text` from the fetch script verbatim.

**Reviewer is told:** They see only the hunks, not surrounding code. Do NOT speculate about what the rest of the function/file looks like. If a finding depends on context outside the hunk, mark it `[Needs codebase verification — raw_diff strategy, did not see surrounding context]`.

### `function_context`

For each changed function/method/stored procedure, include the FULL body containing the change (not just hunks), plus any caller within the same file. Strip unrelated functions in the same file.

**Construction:**
1. Parse changed files, locate the enclosing function/method/SP for each hunk.
2. Emit the full body of each containing function, marked with the hunk lines.
3. In the same file, find call sites that reference the changed function — emit those caller bodies too.
4. Drop other functions in the file. Keep imports/usings and class headers for orientation.

**Caveats:**
- For SQL files: "function" means stored procedure or function; "caller" means SP-to-SP `EXEC`/`CALL` references in the same file.
- For files with no function structure (config, migrations, JSON), fall back to `raw_diff` for that file and note the fallback.

**Reviewer is told:** They see each changed function in full plus same-file callers. They do NOT see cross-file callers, downstream consumers, or call graph beyond one hop. Do NOT speculate about cross-file usage. Mark cross-file claims `[Needs codebase verification — function_context strategy, did not see cross-file callers]`.

### `full_flow` (Tier 3 only)

The entire changed file(s), plus any file containing a function called from a changed function (one-hop call-graph expansion). Most expensive — Tier 3 only.

**Construction:**
1. Emit each changed file in full.
2. Identify functions called from any changed function (within the changed file's bodies).
3. For each called function, find its defining file. Emit those files in full.
4. Stop at one hop. Do not transitively expand.

**Caveats:**
- One-hop call-graph resolution is best-effort. If resolution fails (dynamic dispatch, reflection, generated code), note the gap rather than expanding speculatively.
- Token budget guard in Phase 4.1 still applies — if `full_flow` exceeds the limit, that reviewer falls back to `raw_diff` for that wave.

**Reviewer is told:** They see changed files in full plus one-hop callees. They do NOT see two-hop transitive flow or runtime behavior. Codebase tool access is available — use it for verification rather than speculation when something looks off.

## Assignment Rules

See SKILL.md Phase 4.1a for the assignment table (mode + tier → strategy distribution). The orchestrator stores the assignment as `slicing_strategies` in each iteration record.

## Recording

The `slicing_strategies` map is persisted per iteration (see iteration_records schema in SKILL.md Phase 4.4) so downstream synthesis and convergence analysis can correlate findings to the strategy that surfaced them.
