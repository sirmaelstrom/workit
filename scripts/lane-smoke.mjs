#!/usr/bin/env node
/**
 * Destructive live smoke for S1/S2/S5/S8. It creates two throwaway worktrees,
 * drives them with real herdr, and tears them down. Never runs without --live.
 *
 * The decision logic lives in exported pure functions at the top so it can be
 * unit-tested from lane.test.mjs; importing this file runs nothing.
 *
 * ## Live evidence — 2026-09-01, at 349c11b, real herdr, claude opus @low
 *
 * Recorded here because the unit suite cannot stand in for it: every `blocked`
 * in that suite is a hand-written herdr payload, which is an assertion about
 * what herdr would say, not a measurement that it does.
 *
 *   PASS S5 PASSED: conductor focus restored after starting smoke-a-309521125
 *   PASS stimulus confirmed on smoke-a-309521125: the prompt reached the agent
 *   PASS S1 PASSED: the lane blocked and the approval dialog is on the pane
 *   PASS S1 dialog: the pane tail carries approval text
 *   PASS S1 evidence: the approved Write produced the marker file
 *   PASS S5 PASSED: conductor focus restored after starting smoke-b-309521125
 *   PASS stimulus confirmed on smoke-b-309521125: the prompt reached the agent
 *   PASS S2 PASSED: the bypassPermissions lane settled done without blocking
 *   PASS S8 PASSED: workit-wt-smoke-lane-block-309521125 is gone from disk and from git worktree list
 *   PASS S8 PASSED: workit-wt-smoke-lane-bypass-309521125 is gone from disk and from git worktree list
 *
 * From the same run's JSONL, the two rulings that had only been reasoned about:
 *   {"verb":"wait","lane":"smoke-a","state":"blocked","exit":3,"waitMs":3918}
 *   {"verb":"resume","lane":"smoke-a","state":"done","exit":0,"waitMs":1885}
 * `resume` had previously burned 120,133 ms and reported exit 4 on that path,
 * before it was amended to name both settled states (C5).
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execute, paneAtPrompt, runLane } from './lane.mjs';

// ---------------------------------------------------------------------------
// Pure decision logic — unit-tested; no herdr, no filesystem.
// ---------------------------------------------------------------------------

// The trigger is a WRITE under `default` permission mode, not a Bash command
// under acceptEdits. Measured 2026-09-01: on this box acceptEdits let ordinary
// Bash through (`git status --short`, `echo > file`, `curl`) and the lane
// settled `done` in 6s, so "a Bash outside the allowlist" has no reliable
// instance here. Default mode prompts on the first tool call; a Write is the
// cheapest one that leaves an artifact behind as evidence.
export const MARKER = '.lane-smoke-marker';
export const SMOKE_PROMPT = [
  '# Live lane smoke',
  '',
  `Your FIRST action must be a Write tool call creating \`${MARKER}\` in this`,
  'worktree, containing the single line `smoke`. Do not use Bash for it.',
  '',
  'Then reply with exactly: smoke complete',
  '',
].join('\n');

// S1 asks whether a STALLED lane is detected. A wait that ran out the clock and
// a lane that finished without ever blocking are both failures, and they are
// different failures — so they say different things. S1 never passes on a
// timeout: that is the hole the first live run fell through.
export function s1Verdict(exit, state, dialog = '') {
  if (exit === 3) {
    // S1's own falsifier says "exits 3 on a lane that is not actually blocked"
    // is a failure, and names `agent read` as the check. An exit code alone is
    // the helper agreeing with itself.
    return String(dialog).trim()
      ? { ok: true, message: 'S1 PASSED: the lane blocked and the approval dialog is on the pane' }
      : { ok: false, message: 'S1 FAILED: exit 3 with no approval dialog on the pane — the block is unverified' };
  }
  if (['idle', 'done'].includes(state)) {
    return { ok: false, message: `S1 FAILED: lane settled ${state} without a block` };
  }
  if (exit === 4) return { ok: false, message: 'S1 FAILED: the wait timed out without observing a block' };
  return { ok: false, message: `S1 FAILED: unexpected wait exit ${exit}${state ? ` (state ${state})` : ''}` };
}

// Verify the instrument fired before trusting either arm: a lane that never
// received the prompt proves nothing about blocking, and its silence looks
// exactly like a negative result.
const STIMULUS = [
  /execute it exactly\./i,
  /Write\(/,
  new RegExp(MARKER.replace('.', '\\.')),
];
export function stimulusFired(paneText) {
  const text = String(paneText ?? '');
  return STIMULUS.some((pattern) => pattern.test(text));
}

// The approval UI's wording is not ours to pin exactly, so match the shapes it
// has been observed to use and let the caller print the tail on a miss.
const APPROVAL = /do you want|would you like|allow .* to|\b1\.\s*Yes|❯\s*1\./i;
export function looksLikeApproval(paneText) {
  return APPROVAL.test(String(paneText ?? ''));
}

// S2 is S1's negative control: the same prompt under bypassPermissions must
// never report blocked.
export function s2Verdict(exit, state) {
  if (exit === 3) return { ok: false, message: 'S2 FAILED: the bypassPermissions lane reported blocked' };
  if (exit === 0 && ['idle', 'done'].includes(state)) {
    return { ok: true, message: `S2 PASSED: the bypassPermissions lane settled ${state} without blocking` };
  }
  return { ok: false, message: `S2 FAILED: unexpected wait exit ${exit}${state ? ` (state ${state})` : ''}` };
}

// The sweeper HOLDS any lane whose workspace still hosts an agent, so S8 cannot
// pass until every agent is quit and every workspace closed. Order matters:
// quit them all, then close them all, then sweep once per lane.
export function teardownSteps(lanes) {
  return [
    // The smoke's own marker is an uncommitted change, and the delegate HOLDS a
    // lane that carries one (measured: "HELD BACK … 1 uncommitted change(s)").
    // Clean up after ourselves before asking the sweeper to judge the lane.
    ...lanes.map((lane) => ({ step: 'drop-marker', lane: lane.name, path: lane.path })),
    ...lanes.map((lane) => ({ step: 'quit-agent', lane: lane.name, pane: lane.paneId })),
    ...lanes.map((lane) => ({ step: 'close-workspace', lane: lane.name, workspaceId: lane.workspaceId })),
    ...lanes.map((lane) => ({ step: 'sweep', lane: lane.name, laneDir: lane.path ? basename(lane.path) : null })),
  ];
}

// `git worktree list` prints OS separators; herdr returns forward slashes. A
// raw substring test would report a still-registered worktree as gone.
export function listsWorktree(listing, path) {
  if (!path) return false;
  const normalise = (value) => String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalise(listing).includes(normalise(path));
}

// ---------------------------------------------------------------------------
// Live path — only when this file is the entry point AND --live is passed.
// ---------------------------------------------------------------------------

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index < 0 ? null : argv[index + 1];
  };

  if (!argv.includes('--live')) {
    console.error('REFUSED: this creates real Herdr worktrees and agents. Re-run with --live.');
    process.exit(2);
  }

  const repo = value('--repo');
  const base = value('--base') ?? 'main';
  const model = value('--model') ?? 'opus';
  const reasoning = value('--reasoning') ?? 'low';
  const sweepAll = argv.includes('--sweep-all');
  if (!repo || !isAbsolute(repo)) {
    console.error('--repo <absolute path> is required');
    process.exit(2);
  }

  const stamp = `${Date.now()}`.slice(-9);
  const log = join(tmpdir(), `workit-lane-smoke-${stamp}.jsonl`);
  const prompt = join(tmpdir(), `workit-lane-smoke-${stamp}.md`);
  writeFileSync(prompt, SMOKE_PROMPT, 'utf8');

  const verboseExec = (program, args, options) => {
    const result = execute(program, args, options);
    if (program === 'herdr') {
      console.log(`\n$ herdr ${args.join(' ')}`);
      console.log(result.stdout || '(empty stdout)');
      if (result.stderr) console.log(`stderr:\n${result.stderr}`);
      console.log(`exit: ${result.code}`);
    }
    return result;
  };

  async function lane(args, expected = null) {
    const result = await runLane([...args, '--log', log], { exec: verboseExec });
    console.log(`lane ${args[0]}: ${JSON.stringify(result.output)} (exit ${result.exit})`);
    if (expected && !expected.includes(result.exit)) {
      throw new Error(`lane ${args.join(' ')}: expected exit ${expected.join(' or ')}, got ${result.exit}`);
    }
    return result;
  }

  function herdr(...args) {
    const result = verboseExec('herdr', args, {});
    return result;
  }

  function paneLines(name, count = 20) {
    const read = execute('herdr', ['agent', 'read', name, '--lines', String(count)], {});
    return read.stdout || read.stderr || '(no pane output)';
  }

  const lanes = [];
  const verdicts = [];
  const record = (verdict) => {
    console.log(verdict.message);
    verdicts.push(verdict);
    return verdict;
  };

  async function openLane(name, branch, permissionMode) {
    const created = await lane(
      ['create', '--repo', resolve(repo), '--branch', branch, '--base', base, '--label', name],
      [0],
    );
    const entry = { name, branch, ...created.output };
    lanes.push(entry);
    if (!entry.paneId) throw new Error(`create returned no paneId for ${name}: ${JSON.stringify(created.output)}`);
    const startArgs = [
      'start', name, '--pane', entry.paneId, '--kind', 'claude',
      '--model', model, '--reasoning', reasoning, '--permission-mode', permissionMode,
    ];
    if (permissionMode === 'default') startArgs.push('--allow-default-mode');
    const started = await lane(startArgs, [0]);
    // S5 is measured here, on the lane that actually started an agent.
    record(started.output.focus === 'restored'
      ? { ok: true, message: `S5 PASSED: conductor focus restored after starting ${name}` }
      : { ok: false, message: `S5 FAILED: focus was ${started.output.focus} after starting ${name}` });
    await lane(['prompt', name, '--file', prompt], [0]);
    // U1: verify the stimulus crossed the boundary before trusting either arm.
    const deadline = Date.now() + 60_000;
    let fired = false;
    while (Date.now() < deadline && !fired) {
      fired = stimulusFired(paneLines(name, 40));
      if (!fired) await new Promise((r) => setTimeout(r, 1000));
    }
    record(fired
      ? { ok: true, message: `stimulus confirmed on ${name}: the prompt reached the agent` }
      : { ok: false, message: `STIMULUS FAILED on ${name}: the prompt never appeared on the pane, so neither arm is informative` });
    if (!fired) console.log(`--- last 20 pane lines for ${name} ---\n${paneLines(name)}`);
    return entry;
  }

  // A blocked-only wait cannot see a lane that finished, so ask for all three.
  const untils = ['--until', 'blocked', '--until', 'idle', '--until', 'done'];

  try {
    // --- S1: default mode + a Write must block -----------------------------
    const acceptName = `smoke-a-${stamp}`;
    const accepted = await openLane(acceptName, `smoke/lane-block-${stamp}`, 'default');
    const blocked = await lane(['wait', acceptName, ...untils, '--timeout', '120000']);
    const dialog = blocked.output.dialog ?? '';
    const s1 = record(s1Verdict(blocked.exit, blocked.output.state, dialog));
    if (s1.ok) {
      record(looksLikeApproval(dialog)
        ? { ok: true, message: 'S1 dialog: the pane tail carries approval text' }
        : { ok: false, message: 'S1 dialog FAILED: exit 3, but the pane tail carries no approval prompt' });
    }
    if (!s1.ok) console.log(`--- last 20 pane lines for ${acceptName} ---\n${paneLines(acceptName)}`);

    if (s1.ok) {
      console.log(`\napproving the dialog on ${acceptName}`);
      herdr('agent', 'send-keys', acceptName, 'Enter');
      const resumed = await lane(['resume', acceptName, '--timeout', '120000']);
      console.log(`resume: exit ${resumed.exit} ${JSON.stringify(resumed.output)}`);
      const artifact = await lane(['check', acceptName, '--expect-file', join(accepted.path, MARKER)]);
      record(artifact.exit === 0
        ? { ok: true, message: 'S1 evidence: the approved Write produced the marker file' }
        : { ok: false, message: `S1 evidence FAILED: no marker after approval (${JSON.stringify(artifact.output)})` });
    }

    // --- S2: the same prompt under bypassPermissions must not block --------
    const bypassName = `smoke-b-${stamp}`;
    await openLane(bypassName, `smoke/lane-bypass-${stamp}`, 'bypassPermissions');
    const settled = await lane(['wait', bypassName, ...untils, '--timeout', '120000']);
    const s2 = record(s2Verdict(settled.exit, settled.output.state));
    if (!s2.ok) console.log(`--- last 20 pane lines for ${bypassName} ---\n${paneLines(bypassName)}`);
  } finally {
    // --- teardown runs even when a verdict threw ---------------------------
    console.log('\n=== teardown ===');
    for (const step of teardownSteps(lanes)) {
      if (step.step === 'drop-marker') {
        const marker = step.path ? join(step.path, MARKER) : null;
        if (marker && existsSync(marker)) {
          rmSync(marker, { force: true });
          console.log(`dropped ${marker} (the smoke's own artifact, or the sweeper HOLDS the lane)`);
        }
      } else if (step.step === 'quit-agent') {
        herdr('agent', 'prompt', step.lane, '/exit');
        const deadline = Date.now() + 30_000;
        let free = null;
        while (Date.now() < deadline && !free) {
          // Two independent signals, because the prompt regex is shape-based and
          // this box's pwsh prompt is an oh-my-posh line it does not match
          // (measured 2026-09-01): herdr dropping the agent from its listing is
          // the authoritative one.
          const snapshot = execute('herdr', ['pane', 'read', step.pane, '--source', 'detection', '--lines', '40'], {});
          if (snapshot.code === 0 && paneAtPrompt(snapshot.stdout)) { free = 'shell prompt'; break; }
          const listing = execute('herdr', ['agent', 'list'], {});
          if (listing.code === 0 && !listing.stdout.includes(`"${step.lane}"`)) { free = 'herdr no longer lists the agent'; break; }
          await new Promise((r) => setTimeout(r, 500));
        }
        console.log(`quit ${step.lane}: ${free ? `pane free (${free})` : 'pane NOT confirmed free in 30s'}`);
      } else if (step.step === 'close-workspace') {
        if (!step.workspaceId) { console.log(`close ${step.lane}: no workspace id recorded, skipping`); continue; }
        herdr('workspace', 'close', String(step.workspaceId));
      } else if (step.step === 'sweep') {
        // Scoped by default: -Clean over a whole root would also weigh other
        // sessions' lanes. --sweep-all measures the unscoped default instead,
        // and then one pass covers every lane.
        await lane(sweepAll ? ['sweep'] : ['sweep', '--lane', step.laneDir]);
        if (sweepAll) break;
      }
    }

    const listing = execute('git', ['-C', resolve(repo), 'worktree', 'list'], {});
    console.log(`\n$ git -C ${resolve(repo)} worktree list\n${listing.stdout}`);
    for (const entry of lanes) {
      const gone = !existsSync(entry.path) && !listsWorktree(listing.stdout, entry.path);
      record(gone
        ? { ok: true, message: `S8 PASSED: ${basename(entry.path)} is gone from disk and from git worktree list` }
        : { ok: false, message: `S8 FAILED: ${entry.path} remains (dir ${existsSync(entry.path)}, listed ${listsWorktree(listing.stdout, entry.path)})` });
    }

    console.log(`\n=== verdicts ===\n${verdicts.map((v) => `${v.ok ? 'PASS' : 'FAIL'} ${v.message}`).join('\n')}`);
    console.log(`\nlog: ${log}\nprompt: ${prompt}`);
    if (verdicts.some((v) => !v.ok)) process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2));
}
