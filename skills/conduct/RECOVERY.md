# Recovering a run

Run the recovery commands with the plugin version that provides them. Take the
run directory from `state.json`; do not edit its scheduling or review fields.

Before dispatch, the conductor validates paths in an authored brief. A refusal
leaves that author action pending. Correct the brief and record the same action
again. Explicit Create paths may be created by the lane; missing Modify paths
must be corrected before dispatch.

Amendment tables compose from the amendment that opened the current review's
findings. Later rows replace the same finding ID. Earlier rounds do not answer
the current round. An unchanged copied row retains its controls. A new row may
name a control in `Amendment N`; otherwise it needs controls in its own section
or `no control: <why>` in Evidence. Keep ask question and option text unchanged;
put `Resolution: <ruling receipt>` on a separate indented line.

For a blocked WP, `reset-wp --to checked` re-runs adjudication, `--to prompt`
restarts a stopped lane and sends its brief, and `--to land` re-runs the merge
gate. `--to delta --baseline <sha>` proves the reviewed prefix and reviews its
tail. An ordinary delta pass can discover the same prefix after a recorded
rebase. Patch identity and unchanged parent files must both agree. An unproved
prefix requires a new full review; a dirty or mismatched worktree blocks it.
Every reset snapshots state and records its reason.

When GitHub returns 403 or 404 reading required checks and a WP deliberately
renames CI jobs, use:

```text
conduct.mjs ci-checks --run <dir> --wp WP-01 --head <full SHA> --checks core,app,app-test --why "WP replaces scaffold workflow"
conduct.mjs reset-wp --run <dir> --wp WP-01 --to land --why "Recorded the CI migration check set"
```

This policy applies only to that head. Readable branch protection takes
precedence. Every check present at the head must still pass, and every named
check must be present. Never manufacture a legacy success status.

To move a run to a repaired plugin, pause at an author or wait action, then
invoke the destination plugin's `conduct.mjs upgrade-root --run <dir> --why
<reason>`. Pending executable actions must be recorded first. The upgrade
preserves author/wait action IDs, snapshots state and migrates queued command paths. Historical
receipts retain their provenance. Old plugin entry points refuse the moved run.
Drivers should invoke `scripts/conduct-run.mjs <verb> --run <dir>`; that wrapper
reads `state.pluginRoot` on every invocation. It does not pin an installed version.

Review actions have a 75-minute stall deadline per action; a queued seat starting,
a lens finishing or moving to synthesis advances progress. Heartbeats alone do
not advance it. Ordinary scheduler waits retain their
30-minute alarm. Rust review consumers publish `review-progress.json` with the
active, queued and finished seats. Failed seats remain missing coverage. A
partially successful council review retries only missing seats, at most twice,
before holding the WP. A synthesis cannot silently turn that gap into coverage.
