// Phase release: the repo's recipe as its own PR, after a complete build. A
// release worktree beside the repo, the version bump in slot form, a draft PR
// with no review (T0), the merge gate and merge through WP-03's land.mjs, the
// recipe's `after` and `verify` commands, the worktree and branch cleanup,
// and the plugin-root handover when
// the run built the plugin that runs it. Every action carries seam `release`.
//
// Fields this phase adds to state.release (optional; readers tolerate their
// absence): stage, queue, head, commit, retries, rebaseFrom, rebases, anomaly,
// cleanup ({ removed, removeError?, branchDeleted? }, as a merged lane's).
// The release holds the merge lock as { wpId: 'release', since } from its
// fetch to its merged, or to a failure (D20).
import { basename, dirname, join, resolve } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { recipeArgv } from '../recipe.mjs';
import { bumpPlan, releaseEligible, resolvePluginRoot, selfHosted } from '../release.mjs';
import { mergeActions, mergeLockFor, rebaseActions, recordLandStep } from '../land.mjs';
import { conductScript, openTouch, recordTouch, touchAction } from '../touch.mjs';
import { firstLine } from '../adapters.mjs';
import { branchDeleteSteps, branchOutcome, checkedOutAt, worktreeGone } from '../lanes.mjs';
import { samePath } from './spec.mjs';
import { mergeRefusal, releaseRefusal, verifiedAuthority } from '../authority.mjs';

const SEAM = 'release';
const WAIT_MS = 60000;
// No CI at the release head waits as long as a WP's does (WP-04's window).
const NO_CI_WINDOW_MS = 30 * 60000;
const LAND_STEPS = new Set(['rebase', 'gate', 'merge', 'merged']);
const CLEANUP_PARTS = new Set(['remove', 'branch-holder', 'branch', 'branch-remote']);
const FILL = { '{pr.number}': (r) => r.pr?.number, '{pr.head}': (r) => r.pr?.head, '{merge.sha}': (r) => r.merge?.sha };

const shell = (part, command, extra = {}) => ({ kind: 'shell', step: 'release', seam: SEAM, part, command, expects: { type: 'none' },
  instruction: 'Run this exact argv (no shell), and record its { code, stdout, stderr }.', ...extra });
const wait = (step, waitMs, instruction) => ({ kind: 'wait', step, seam: SEAM, waitMs, instruction: `${instruction} Wait ${waitMs / 1000} s, then record {}.` });

// The release PR as a WP of tier T0, the shape land.mjs records against.
function view(state) {
  const r = state.release;
  return { id: 'release', tier: 'T0', commit: r.commit ?? null, queue: r.queue ?? [], retries: r.retries ?? 0, rebaseFrom: r.rebaseFrom ?? null,
    lane: { worktree: r.worktree, branch: r.branch, base: r.base }, pr: r.pr, gate: r.gate, merge: r.merge, squashExit: r.squashExit, reviews: [], rebases: r.rebases ?? [] };
}

// Terminal for the release: the lock is released and the phase moves on.
function finish(state, deps, to, reason) {
  const r = state.release;
  Object.assign(r, { state: to, reason, stage: null, queue: [] });
  if (state.mergeLock?.wpId === 'release') state.mergeLock = null;
  appendEvent(state, deps, to === 'not-exercised'
    ? { step: 'release', event: 'not-exercised', data: { step: 'release', reason } }
    : { step: 'release', event: 'release', data: { state: to, reason } });
  state.phase = 'analyze';
  return null;
}

function setAt(object, jsonPath, value) {
  const keys = jsonPath.split('.');
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node?.[/^\d+$/.test(key) ? Number(key) : key], object);
  if (parent == null) return false;
  parent[/^\d+$/.test(last) ? Number(last) : last] = value;
  return true;
}

const occurrences = (text, slot) => text.split(slot).length - 1;

// One slot-form edit per bump file: the exact `"<key>": "<from>"` text,
// replaced once. The original is kept so the record can check the edit.
function bumpAction(state, edit, original) {
  const path = join(state.release.worktree, edit.file);
  return { kind: 'author', step: 'release', seam: SEAM, part: 'bump', template: path, outPath: path,
    slots: { [edit.slot]: edit.value }, bump: { file: edit.file, jsonPath: edit.jsonPath, to: edit.to, original },
    expects: { type: 'file' }, instruction: `Edit ${path} in place: replace the key of slots (its exact text, once) with its value, and change nothing else. Record {}.` };
}

// True when replacing the slot in `original` changes exactly jsonPath, to
// `to`, and nothing else in the parsed JSON.
function editsOnly(original, text, jsonPath, to) {
  try {
    const before = JSON.parse(original);
    return setAt(before, jsonPath, to) && JSON.stringify(before) === JSON.stringify(JSON.parse(text));
  } catch {
    return false;
  }
}

// The plan's edits, each one checkable before it is emitted: each file once
// (by canonical destination), its slot present exactly once in the file's
// current text, and the replacement editing exactly jsonPath.
function bumpActions(state, deps, plan) {
  const wt = state.release.worktree;
  const twice = plan.edits.find((edit, i) => plan.edits.slice(0, i).some((prior) => samePath(resolve(wt, prior.file), resolve(wt, edit.file), deps.platform)));
  if (twice) return { failure: `bump plan edits ${twice.file} twice` };
  const actions = [];
  for (const edit of plan.edits) {
    const key = edit.jsonPath.split('.').at(-1);
    const slotted = { ...edit, slot: `"${key}": "${edit.from}"`, value: `"${key}": "${edit.to}"` };
    const original = deps.read(join(wt, edit.file));
    const n = occurrences(original, slotted.slot);
    if (n !== 1) return { failure: `bump: ${edit.file}: slot occurs ${n} times` };
    if (!editsOnly(original, original.replace(slotted.slot, () => slotted.value), edit.jsonPath, edit.to)) return { failure: `bump: ${edit.file}: slot does not edit ${edit.jsonPath}` };
    actions.push(bumpAction(state, slotted, original));
  }
  return { actions };
}

// The queue a stage expands to, from the run's state and recipe alone, so
// emission can derive it again (derivedActions). The bump, merge and
// handover stages are built in expand; null for them.
const NEXT_STAGE = { setup: 'bump', commit: 'gate', gate: 'merge', after: 'verify', verify: 'cleanup', cleanup: 'handover' };
function stageQueue(state, stage) {
  const r = state.release;
  const { remote, defaultBranch } = state.intent.repo;
  const base = `origin/${defaultBranch ?? 'main'}`;
  const repo = resolve(state.intent.repo.path);
  const recipe = state.intent.release;
  switch (stage) {
    case 'setup':
      return [
        shell('fetch', ['git', '-C', repo, 'fetch', 'origin']),
        shell('base', ['git', '-C', repo, 'rev-parse', base]),
        shell('worktree', ['git', '-C', repo, 'worktree', 'add', r.worktree, '-b', r.branch, base]),
      ];
    case 'commit': {
      const git = (part, ...args) => shell(part, ['git', '-C', r.worktree, ...args]);
      const body = `Release ${r.version.to} by conduct ${state.slug}: the recipe's version bump. Tier T0: no review; CI and threads still gate the merge.`;
      return [
        git('add', 'add', '--', ...recipe.bump.map((entry) => entry.file)),
        git('commit', 'commit', '-m', r.commit),
        git('head', 'rev-parse', 'HEAD'),
        git('push', 'push', '-u', 'origin', r.branch),
        shell('pr', ['gh', 'pr', 'create', '--draft', '--repo', remote, '--base', defaultBranch ?? 'main', '--head', r.branch, '--title', r.commit, '--body', body]),
      ];
    }
    case 'gate':
      // Readied before the gate, never back to back with the merge (land.mjs rebaseActions).
      return [
        shell('ready', ['gh', 'pr', 'ready', String(r.pr.number), '--repo', remote]),
        { ...shell('gate', ['node', conductScript(state), 'land', 'gate', '--run', state.runDir, '--wp', 'release']), step: 'gate' },
      ];
    case 'after':
    case 'verify':
      return (recipe[stage] ?? []).map((command) => shell(stage, recipeArgv(command), { cwd: r.worktree, recipeCommand: command }));
    // After verify, which runs in the worktree. The remove recorder queues the
    // branch deletes only once the directory is gone (#206's order).
    case 'cleanup':
      return [shell('remove', ['git', '-C', repo, 'worktree', 'remove', r.worktree], { instruction: 'Remove the merged release\'s worktree (no --force).' })];
    default:
      return null;
  }
}

function expand(state, deps) {
  const r = state.release;
  const recipe = state.intent.release;
  const go = (queue, stage) => Object.assign(r, { queue, stage });
  const queue = stageQueue(state, r.stage);
  if (queue) return go(queue, NEXT_STAGE[r.stage]);
  switch (r.stage) {
    case 'bump': {
      let plan;
      try {
        plan = bumpPlan(recipe, { read: deps.read, repoPath: r.worktree });
      } catch (error) {
        if (!(error instanceof ConductError)) throw error;
        return finish(state, deps, 'failed', `bump: ${error.message}`);
      }
      Object.assign(r, { version: { from: plan.from, to: plan.to }, commit: `chore(release): ${plan.to} (conduct ${state.slug})` });
      const bumps = bumpActions(state, deps, plan);
      if (bumps.failure) return finish(state, deps, 'failed', bumps.failure);
      return go(bumps.actions, 'commit');
    }
    case 'merge': {
      if (!r.gate?.ok) return go([], 'gate');
      const actions = mergeActions(state, view(state), r.gate.head, verifiedAuthority(state, deps));
      if (!actions.length) return finish(state, deps, 'failed', 'merge: no merge authority, or the release does not hold the merge lock');
      // `expects: none`: a failed merge step reaches the release's failure
      // routing instead of record's JSON check (the merge-commit lookup).
      return go(actions.map((action) => ({ ...action, seam: SEAM, expects: { type: 'none' } })), 'after');
    }
    case 'handover':
      return handover(state, deps);
    default:
      throw new ConductError(2, `the release has no stage ${r.stage}`);
  }
}

function installedVersion(root, deps) {
  try {
    return JSON.parse(deps.read(join(root, '.claude-plugin', 'plugin.json'))).version ?? null;
  } catch {
    return null;
  }
}

// After a self-hosted release the plugin is re-resolved and checked, and every
// later verb must come from the new root (D19.22). The root must be the
// released install: its plugin.json at the bump's version (an unchanged root
// only after an in-place update), and the skill and its script present.
function handover(state, deps) {
  // A release held after its merge ran only its cleanup: it ends failed, held.
  if (state.release.heldAfterMerge) return finish(state, deps, 'failed', state.release.heldAfterMerge);
  if (!selfHosted({ repoRemote: state.intent.repo.remote, pluginRoot: state.pluginRoot, read: deps.read })) return finish(state, deps, 'done', null);
  let to;
  try {
    to = resolvePluginRoot({ projectPath: state.intent.repo.path, read: deps.read, env: deps.env, platform: deps.platform });
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    return finish(state, deps, 'failed', `handover: ${error.message}`);
  }
  if (!to) return finish(state, deps, 'failed', 'handover: no installed plugin root resolves');
  const version = installedVersion(to, deps);
  if (version !== state.release.version?.to) return finish(state, deps, 'failed', `handover: installed version is ${version}, not ${state.release.version?.to}`);
  const missing = [['skills', 'conduct', 'SKILL.md'], ['skills', 'conduct', 'scripts', 'conduct.mjs']].map((parts) => join(to, ...parts)).find((path) => !deps.exists(path));
  if (missing) return finish(state, deps, 'failed', `handover: ${missing} is missing`);
  state.handover = { from: state.pluginRoot, to, at: deps.timestamp() };
  state.pluginRoot = to;
  appendEvent(state, deps, { step: 'release', event: 'handover', data: state.handover });
  return finish(state, deps, 'done', null);
}

// A touch the release opened, or the one filed ahead of it (spine).
function touchSpec(state, touch) {
  const spec = touchAction(state, touch) ?? touchAction(state, state.touches.find((other) => other !== touch && other.status === 'filed'));
  if (!spec) throw new ConductError(2, `touch ${touch.n} has no action to emit`);
  return { ...spec, seam: SEAM };
}

function emitHead(state) {
  const r = state.release;
  const head = r.queue[0];
  const command = head.command?.map((arg) => {
    if (!Object.hasOwn(FILL, arg)) return arg;
    const value = FILL[arg](r);
    if (value === null || value === undefined) throw new ConductError(2, `release: placeholder ${arg} is unfilled when ${head.step}/${head.part} is emitted`);
    return String(value);
  });
  r.queue[0] = command ? { ...head, command } : head;
  return { ...r.queue[0], seam: SEAM };
}

export function next(state, deps) {
  const r = state.release;
  if (r.state !== 'pending') {
    state.phase = 'analyze';
    return null;
  }
  if (r.anomaly) {
    const touch = state.touches[r.anomaly.touch - 1];
    if (touch.status !== 'answered') return touchSpec(state, touch);
    return finish(state, deps, 'failed', `${r.anomaly.reason}; operator answer (${touch.answer.key})${touch.answer.text ? `: ${touch.answer.text}` : ''}`);
  }
  if (!r.stage) {
    const eligible = releaseEligible(state, verifiedAuthority(state, deps));
    if (!eligible.ok) return finish(state, deps, 'not-exercised', eligible.reason);
    const repo = resolve(state.intent.repo.path);
    Object.assign(r, { stage: 'setup', queue: [], worktree: join(dirname(repo), `${basename(repo)}-wt-${state.slug}-release`), branch: `conduct/${state.slug}/release` });
  }
  for (let hop = 0; hop < 8 && !r.queue?.length; hop += 1) {
    expand(state, deps);
    if (r.state !== 'pending') return null;
  }
  // Checked at emission, not only when queued (U1): a queue resumed after an
  // edit to the recipe, the repo, the queue or the signed answer emits nothing.
  const refusal = emissionRefusal(state, deps, r.queue[0]);
  if (refusal) {
    held(state, deps, refusal);
    return r.state === 'pending' ? next(state, deps) : null;
  }
  return emitHead(state);
}

// A release act left pending is checked again before it is emitted again
// (conduct.mjs emit): one refused now is dropped, and the release holds as it
// does at emission. False when the pending action was dropped.
export function checkPending(state, deps) {
  const action = state.pending;
  if (action.touch || state.release.state !== 'pending' || !state.release.queue?.length) return true;
  const refusal = emissionRefusal(state, deps, action);
  if (!refusal) return true;
  held(state, deps, refusal);
  return false;
}

// A refused release act. Before the release PR merged, the release fails,
// held. After it, only the merged release's cleanup still runs, exactly as
// the release derives it, and the release then fails, held (handover).
function held(state, deps, refusal) {
  const r = state.release;
  const reason = `release held: ${refusal}`;
  if (!r.squashed && !r.merge?.sha) return finish(state, deps, 'failed', reason);
  r.heldAfterMerge = reason;
  appendEvent(state, deps, { step: 'release', event: 'release-held', data: { reason } });
  // Once the worktree is removed, only its branch deletes are left.
  if (r.cleanup) Object.assign(r, { queue: r.queue.filter((queued) => CLEANUP_PARTS.has(queued.part) && !derivationRefusal(state, queued, null)), stage: 'handover' });
  else Object.assign(r, { queue: [], stage: 'cleanup' });
  return null;
}

const repoAfter = (command) => command[command.indexOf('--repo') + 1];
const filledArgv = (command, r) => command.map((arg) => {
  const value = Object.hasOwn(FILL, arg) ? FILL[arg](r) : null;
  return value === null || value === undefined ? arg : String(value);
});
const sameAct = (a, b, r) => a.step === b.step && a.part === b.part && (a.cwd ?? null) === (b.cwd ?? null)
  && JSON.stringify(filledArgv(a.command, r)) === JSON.stringify(filledArgv(b.command, r));

// Every command the release can emit, from the run's state and the verified
// recipe: each stage's queue, the land steps (the merge under `authority`, a
// rebase the gate can ask for, and its abort) and the merged release's branch
// deletes. A stage whose inputs are not recorded yet derives nothing.
function derivedActions(state, authority) {
  const r = state.release;
  const out = [];
  for (const stage of Object.keys(NEXT_STAGE)) {
    try {
      out.push(...stageQueue(state, stage));
    } catch {
      // not reached yet
    }
  }
  const wp = view(state);
  if (r.gate?.head && authority) out.push(...mergeActions(state, wp, r.gate.head, authority));
  if (r.gate?.head) out.push(...branchDeleteSteps(resolve(state.intent.repo.path), r.branch, r.gate.head, 'merged release').map(({ part, command }) => shell(part, command)));
  if (r.pr?.number) out.push(...rebaseActions(state, wp), { step: 'rebase', part: 'abort', command: ['git', '-C', r.worktree, 'rebase', '--abort'] });
  return out;
}

// Why `head` is not an act the release derives, or null: a command must be
// one of derivedActions (argv and cwd), and a bump must edit a file the
// verified recipe bumps. A wait or an inspection runs nothing.
function derivationRefusal(state, head, authority) {
  const r = state.release;
  if (head.kind === 'author') {
    const files = (state.intent.release?.bump ?? []).map((entry) => join(r.worktree, entry.file));
    return head.template === head.outPath && files.includes(head.outPath) ? null : `${head.part}: ${head.outPath} is not a file the verified recipe bumps`;
  }
  if (!Array.isArray(head.command)) return null;
  if (derivedActions(state, authority).some((derived) => sameAct(derived, head, r))) return null;
  return `${head.step}/${head.part}: the queued command is not one the verified recipe derives: ${head.command.join(' ')}`;
}

// Configured, every release act runs under release authority, from the
// verified recipe and against the granted repo: the head must be an act the
// release derives, and every --repo it names the granted one; a squash also
// needs merge authority. The merged release's cleanup needs no authority,
// only the derivation. Unconfigured, emission is today's (M8).
function emissionRefusal(state, deps, head) {
  const authority = verifiedAuthority(state, deps);
  if (authority.proofMode === 'unconfigured') return null;
  if (!CLEANUP_PARTS.has(head.part)) {
    const refusal = releaseRefusal(state, authority);
    if (refusal) return refusal;
    const granted = authority.grant.repo.remote;
    const command = head.command ?? [];
    const other = command.find((arg, i) => command[i - 1] === '--repo' && arg !== granted);
    if (other !== undefined) return `${head.step}/${head.part}: --repo ${other} is not the granted ${granted}`;
    if (head.step === 'merge' && head.part === 'squash') {
      const merge = mergeRefusal(state, authority, repoAfter(command));
      if (merge) return merge;
    }
  }
  return derivationRefusal(state, head, authority);
}

function fail(state, deps, action, result) {
  const command = action.recipeCommand ? ` "${action.recipeCommand}"` : '';
  return finish(state, deps, 'failed', `${action.part}${command} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}`);
}

// A merged code 5 is an anomaly (D19.8): dispatch halts and the operator is
// asked; any answer fails the release (D20 Settled).
function anomaly(state, deps, reason) {
  state.dispatchHalt ??= { reason: `release: ${reason}`, since: deps.timestamp() };
  const touch = openTouch(state, {
    kind: 'blocked', allowFreeText: true, did: `conduct ${state.slug}: release PR #${state.release.pr?.number} merged`,
    question: `DO: look at the release PR #${state.release.pr?.number}: ${reason}. EXPECT: any answer records the release as failed with your text, and the run goes on to the analysis.`,
    options: [{ key: 'a', label: 'Record the release as failed', consequence: 'The analysis and the showcase name it; nothing is reverted by the run.' }],
  }, deps);
  state.release.anomaly = { reason, touch: touch.n };
}

// No CI, or CI still pending, at the release head (WP-04's C2-8 rule): one
// 30-minute window per head, from the earliest absent-or-pending observation
// (release.noCi.since or land's gate.pendingSince, whichever came first),
// still holding the lock; then fail. A new head starts a new window. A
// release is never held.
function noCi(state, action, out, deps) {
  const gate = out.patch?.gate;
  if (action.step !== 'gate' || !gate) return out;
  const absent = ['amend', 'block'].includes(out.outcome) && gate.failures?.includes('no CI at head') && (gate.causes ?? []).every((cause) => cause === 'ci');
  if (!absent && !(out.outcome === 'wait' && gate.pending)) return out;
  const r = state.release;
  const seen = [r.noCi?.head === gate.head ? r.noCi.since : null, gate.pendingSince, new Date(deps.now()).toISOString()].filter(Boolean).map(Date.parse);
  const since = Math.min(...seen);
  r.noCi = { head: gate.head, since: new Date(since).toISOString() };
  if (deps.now() - since >= NO_CI_WINDOW_MS) return { ...out, outcome: 'block', reason: 'CI did not complete at head' };
  if (!absent) return out;
  const again = Object.fromEntries(Object.entries(action).filter(([key]) => !['id', 'phase'].includes(key)));
  return { outcome: 'wait', waitMs: WAIT_MS, reason: 'no CI run at the release head yet', patch: { gate, queue: [again, ...r.queue.slice(1)] } };
}

function recordLand(state, action, result, deps) {
  const r = state.release;
  const out = noCi(state, action, recordLandStep(state, view(state), action, result, { exec: deps.exec, read: deps.read, now: deps.now }, verifiedAuthority(state, deps)), deps);
  const patch = out.patch ?? {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'queue') r.queue = [...value];
    else if (key === 'mergeLock' || key === 'dispatchHalt') state[key] = value;
    else r[key] = value;
  }
  if (!Object.hasOwn(patch, 'queue')) r.queue.shift();
  // The squash landed even if the merge-commit lookup after it fails; a squash
  // that exited non-zero is confirmed only by that lookup (land.mjs).
  if (action.part === 'squash' && out.outcome === 'continue' && !patch.squashExit) r.squashed = true;
  if (out.outcome === 'continue' || out.outcome === 'done') return;
  if (out.outcome === 'wait') {
    if (r.queue[0]?.kind !== 'wait') r.queue.unshift(wait(action.step, out.waitMs ?? WAIT_MS, out.reason ?? ''));
    return;
  }
  if (action.step === 'merged') return anomaly(state, deps, out.reason);
  return finish(state, deps, 'failed', `${action.step === 'gate' ? 'land gate' : action.step}: ${out.reason}`);
}

// The edit is textual: the file is the original with exactly the slot
// replaced, byte for byte elsewhere, and it parses with only jsonPath changed.
function recordBump(action, deps) {
  const { file, jsonPath, to, original } = action.bump;
  const [[slot, value]] = Object.entries(action.slots);
  const count = occurrences(original, slot);
  if (count !== 1) throw new ConductError(2, `bump ${file}: the slot text ${slot} occurs ${count} times; the slot-form edit needs exactly one`);
  const text = deps.read(action.outPath);
  if (text !== original.replace(slot, () => value)) throw new ConductError(2, `bump ${file}: the file must be the original with only ${slot} replaced by ${value}`);
  if (!editsOnly(original, text, jsonPath, to)) throw new ConductError(2, `bump ${file}: the edit must parse and change only ${jsonPath}, to ${to}`);
}

// The merged release's worktree and branch, cleaned up as a merged WP's are
// (lanes.mjs recordStop). What is kept lands on r.cleanup for the analysis and
// never fails the release: it has already merged.
function recordCleanup(state, action, result, deps) {
  const r = state.release;
  if (r.queue[0]?.step === action.step && r.queue[0]?.part === action.part) r.queue.shift();
  // Every stderr line: a rejected push names its origin first, its reason after.
  const why = () => String(result.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ') || firstLine(result.stdout) || `exit ${result.code}`;
  if (action.part === 'remove') {
    const removed = worktreeGone(result, r.worktree, deps.exists);
    r.cleanup = { removed, ...(removed ? {} : { removeError: result.code === 0 ? `${r.worktree} still exists after the removal` : why() }) };
    const head = r.gate?.head;
    if (removed && head) {
      const steps = branchDeleteSteps(resolve(state.intent.repo.path), r.branch, head, 'merged release');
      r.queue.unshift(...steps.map(({ part, command, instruction }) => shell(part, command, { instruction })));
    }
    return undefined;
  }
  if (action.part === 'branch-holder') {
    const holder = result.code === 0 ? checkedOutAt(result.stdout, r.branch) : `unknown: git worktree list failed: ${why()}`;
    if (!holder) return undefined;
    const kept = `checked out at ${holder}`;
    r.cleanup.branchDeleted = { local: 'kept', remote: 'kept', localError: kept, remoteError: kept };
    r.queue = r.queue.filter((queued) => !['branch', 'branch-remote'].includes(queued.part));
    return undefined;
  }
  const where = action.part === 'branch' ? 'local' : 'remote';
  const outcome = branchOutcome(result);
  r.cleanup.branchDeleted = { ...(r.cleanup.branchDeleted ?? {}), [where]: outcome, ...(outcome === 'kept' ? { [`${where}Error`]: why() } : {}) };
  return undefined;
}

export function record(state, action, result = {}, deps) {
  const r = state.release;
  if (action.touch) return recordTouch(state, state.touches[action.touch.n - 1], action, result, deps);
  if (LAND_STEPS.has(action.step) && action.kind !== 'wait') return recordLand(state, action, result, deps);
  if (action.kind === 'shell' && CLEANUP_PARTS.has(action.part)) return recordCleanup(state, action, result, deps);
  if (action.part === 'bump') recordBump(action, deps);
  const head = r.queue[0];
  const sameHead = head && head.step === action.step && head.part === action.part;
  if (action.kind === 'wait' || action.kind === 'author') {
    if (sameHead) r.queue.shift();
    return undefined;
  }
  if (action.part === 'fetch') {
    const lock = mergeLockFor(state, { id: 'release' });
    if (lock === 'other') {
      r.queue.unshift(wait('release', WAIT_MS, `${state.mergeLock.wpId} holds the merge lock.`));
      return undefined;
    }
    if (result.code !== 0) return fail(state, deps, action, result);
    if (lock === 'free') state.mergeLock = { wpId: 'release', since: new Date(deps.now()).toISOString() };
  } else if (result.code !== 0 && !(action.part === 'ready' && /already/i.test(result.stderr ?? ''))) return fail(state, deps, action, result);
  const value = String(result.stdout ?? '').trim();
  if (action.part === 'base') {
    if (!/^[0-9a-f]{40}$/.test(value)) return finish(state, deps, 'failed', `base: not a commit sha: ${firstLine(value)}`);
    r.base = value;
  }
  if (action.part === 'head') r.head = value;
  if (action.part === 'pr') {
    const number = Number(/\/pull\/(\d+)/.exec(value)?.[1]);
    if (!number) return finish(state, deps, 'failed', `pr: gh pr create printed no PR URL: ${firstLine(value) || firstLine(result.stderr)}`);
    r.pr = { number, head: r.head };
  }
  if (sameHead) r.queue.shift();
  return undefined;
}
