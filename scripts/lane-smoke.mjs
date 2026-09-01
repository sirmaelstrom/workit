#!/usr/bin/env node
/**
 * Destructive live smoke for S1/S2/S5/S8. It creates two throwaway worktrees
 * and delegates cleanup to lane sweep. Never run without an explicit --live.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execute, runLane } from './lane.mjs';

const argv = process.argv.slice(2);
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
const claudeModel = value('--model') ?? 'opus';
// C8: effort is never inherited. The smoke is a two-line task, so it declares
// the cheapest level rather than letting the lane default to xhigh.
const reasoning = value('--reasoning') ?? 'low';
if (!repo || !isAbsolute(repo)) {
  console.error('--repo <absolute path> is required');
  process.exit(2);
}

const stamp = `${Date.now()}`.slice(-9);
const log = join(tmpdir(), `workit-lane-smoke-${stamp}.jsonl`);
const prompt = join(tmpdir(), `workit-lane-smoke-${stamp}.md`);
writeFileSync(prompt, '# Live lane smoke\n\nYour first action must be a Bash command outside the configured allowlist: run `git status --short`. Then reply with `smoke complete`.\n', 'utf8');

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

async function lane(args, expected) {
  const result = await runLane([...args, '--log', log], { exec: verboseExec });
  console.log(`lane result: ${JSON.stringify(result.output)} (exit ${result.exit})`);
  if (!expected.includes(result.exit)) throw new Error(`expected exit ${expected.join(' or ')}, got ${result.exit}`);
  return result.output;
}

const acceptName = `smoke-a-${stamp}`;
const bypassName = `smoke-b-${stamp}`;
const accept = await lane(['create', '--repo', resolve(repo), '--branch', `smoke/lane-accept-${stamp}`, '--base', base, '--label', acceptName], [0]);
await lane(['start', acceptName, '--pane', accept.paneId, '--kind', 'claude', '--model', claudeModel, '--reasoning', reasoning, '--permission-mode', 'acceptEdits'], [0]);
await lane(['prompt', acceptName, '--file', prompt], [0]);
await lane(['wait', acceptName, '--until', 'blocked', '--timeout', '120000'], [3]);

const bypass = await lane(['create', '--repo', resolve(repo), '--branch', `smoke/lane-bypass-${stamp}`, '--base', base, '--label', bypassName], [0]);
await lane(['start', bypassName, '--pane', bypass.paneId, '--kind', 'claude', '--model', claudeModel, '--reasoning', reasoning], [0]);
await lane(['prompt', bypassName, '--file', prompt], [0]);
await lane(['wait', bypassName, '--timeout', '120000'], [0]);

// Split C is open: nobody has measured whether the delegate discovers a flat
// <repo>-wt-<slug> lane under DEFAULT root resolution. So prefer the default
// (WORKIT_WORKSPACE_ROOT) and say loudly when we had to override it, because an
// overridden run does not settle the question.
const declaredRoot = process.env.WORKIT_WORKSPACE_ROOT ?? null;
const derivedRoot = basename(dirname(resolve(repo))) === 'projects' ? resolve(repo, '..', '..') : null;
if (declaredRoot) {
  console.log(`\nS8 under DEFAULT root resolution (WORKIT_WORKSPACE_ROOT=${declaredRoot}) — this run settles Split C`);
} else {
  console.log(`\nS8 with an OVERRIDDEN root (--workspace-root ${derivedRoot}); WORKIT_WORKSPACE_ROOT is unset,`);
  console.log('so this run does NOT settle Split C — export it and re-run to measure default resolution.');
}
await lane(declaredRoot || !derivedRoot ? ['sweep'] : ['sweep', '--workspace-root', derivedRoot], [0]);
const worktrees = execute('git', ['-C', resolve(repo), 'worktree', 'list'], {});
console.log(`\n$ git -C ${resolve(repo)} worktree list\n${worktrees.stdout}`);
const directoriesAbsent = !existsSync(accept.path) && !existsSync(bypass.path);
const listingsAbsent = !worktrees.stdout.includes(accept.path) && !worktrees.stdout.includes(bypass.path);
if (!directoriesAbsent || !listingsAbsent) {
  throw new Error('S8 failed: a smoke lane directory or git worktree entry remains after sweep');
}
console.log(JSON.stringify({
  S1: 'blocked exit observed with dialog',
  S2: 'bypass lane settled without blocked',
  S5: 'agent list responses above show conductor focus restoration',
  S8: 'both lane directories and git worktree entries are absent',
  log,
}));
