// Phase release: the repo's recipe as its own PR, after a complete build. A
// release worktree beside the repo, the version bump in slot form, a draft PR
// with no review (T0), the merge gate and merge through WP-03's land.mjs, the
// recipe's `after` and `verify` commands, and the plugin-root handover when
// the run built the plugin that runs it. Every action carries seam `release`.
//
// Fields this phase adds to state.release (optional; readers tolerate their
// absence): stage, queue, head, commit, retries, rebaseFrom, rebases, anomaly.
// The release holds the merge lock as { wpId: 'release', since } from its
// fetch to its merged, or to a failure (D20).
import { basename, dirname, join, resolve } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { recipeArgv } from '../recipe.mjs';
import { bumpPlan, releaseEligible, resolvePluginRoot, selfHosted } from '../release.mjs';
import { mergeActions, mergeLockFor, recordLandStep } from '../land.mjs';
import { conductScript, openTouch, recordTouch, touchAction } from '../touch.mjs';
import { firstLine } from '../adapters.mjs';

const SEAM = 'release';
const WAIT_MS = 60000;
// No CI at the release head waits as long as a WP's does (WP-04's window).
const NO_CI_WINDOW_MS = 30 * 60000;
const LAND_STEPS = new Set(['rebase', 'gate', 'merge', 'merged']);
const FILL = { '{pr.number}': (r) => r.pr?.number, '{pr.head}': (r) => r.pr?.head, '{merge.sha}': (r) => r.merge?.sha };

const shell = (part, command, extra = {}) => ({ kind: 'shell', step: 'release', seam: SEAM, part, command, expects: { type: 'none' },
  instruction: 'Run this exact argv (no shell), and record its { code, stdout, stderr }.', ...extra });
const wait = (step, waitMs, instruction) => ({ kind: 'wait', step, seam: SEAM, waitMs, instruction: `${instruction} Wait ${waitMs / 1000} s, then record {}.` });

// The release PR as a WP of tier T0, the shape land.mjs records against.
function view(state) {
  const r = state.release;
  return { id: 'release', tier: 'T0', commit: r.commit ?? null, queue: r.queue ?? [], retries: r.retries ?? 0, rebaseFrom: r.rebaseFrom ?? null,
    lane: { worktree: r.worktree, branch: r.branch, base: r.base }, pr: r.pr, gate: r.gate, merge: r.merge, reviews: [], rebases: r.rebases ?? [] };
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

// The plan's edits, each one checkable before it is emitted: a file edited
// once, its slot present exactly once in the file's current text.
function bumpActions(state, deps, plan) {
  const files = plan.edits.map((edit) => edit.file);
  const twice = files.find((file, i) => files.indexOf(file) !== i);
  if (twice) return { failure: `bump plan edits ${twice} twice` };
  const actions = [];
  for (const edit of plan.edits) {
    const key = edit.jsonPath.split('.').at(-1);
    const slotted = { ...edit, slot: `"${key}": "${edit.from}"`, value: `"${key}": "${edit.to}"` };
    const original = deps.read(join(state.release.worktree, edit.file));
    const n = occurrences(original, slotted.slot);
    if (n !== 1) return { failure: `bump: ${edit.file}: slot occurs ${n} times` };
    actions.push(bumpAction(state, slotted, original));
  }
  return { actions };
}

function expand(state, deps) {
  const r = state.release;
  const { remote, defaultBranch } = state.intent.repo;
  const base = `origin/${defaultBranch ?? 'main'}`;
  const repo = resolve(state.intent.repo.path);
  const recipe = state.intent.release;
  const go = (queue, stage) => Object.assign(r, { queue, stage });
  switch (r.stage) {
    case 'setup':
      return go([
        shell('fetch', ['git', '-C', repo, 'fetch', 'origin']),
        shell('base', ['git', '-C', repo, 'rev-parse', base]),
        shell('worktree', ['git', '-C', repo, 'worktree', 'add', r.worktree, '-b', r.branch, base]),
      ], 'bump');
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
    case 'commit': {
      const git = (part, ...args) => shell(part, ['git', '-C', r.worktree, ...args]);
      const body = `Release ${r.version.to} by conduct ${state.slug}: the recipe's version bump. Tier T0: no review; CI and threads still gate the merge.`;
      return go([
        git('add', 'add', '--', ...recipe.bump.map((entry) => entry.file)),
        git('commit', 'commit', '-m', r.commit),
        git('head', 'rev-parse', 'HEAD'),
        git('push', 'push', '-u', 'origin', r.branch),
        shell('pr', ['gh', 'pr', 'create', '--draft', '--repo', remote, '--base', defaultBranch ?? 'main', '--head', r.branch, '--title', r.commit, '--body', body]),
      ], 'gate');
    }
    case 'gate':
      return go([{ ...shell('gate', ['node', conductScript(state), 'land', 'gate', '--run', state.runDir, '--wp', 'release']), step: 'gate' }], 'merge');
    case 'merge': {
      if (!r.gate?.ok) return go([], 'gate');
      const actions = mergeActions(state, view(state), r.gate.head);
      if (!actions.length) return finish(state, deps, 'failed', 'merge: no merge authority, or the release does not hold the merge lock');
      // `expects: none`: a failed merge step reaches the release's failure
      // routing instead of record's JSON check (the merge-commit lookup).
      return go(actions.map((action) => ({ ...action, seam: SEAM, expects: { type: 'none' } })), 'after');
    }
    case 'after':
    case 'verify': {
      const commands = recipe[r.stage] ?? [];
      return go(commands.map((command) => shell(r.stage, recipeArgv(command), { cwd: r.worktree, recipeCommand: command })), r.stage === 'after' ? 'verify' : 'handover');
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
    const eligible = releaseEligible(state);
    if (!eligible.ok) return finish(state, deps, 'not-exercised', eligible.reason);
    const repo = resolve(state.intent.repo.path);
    Object.assign(r, { stage: 'setup', queue: [], worktree: join(dirname(repo), `${basename(repo)}-wt-${state.slug}-release`), branch: `conduct/${state.slug}/release` });
  }
  for (let hop = 0; hop < 8 && !r.queue?.length; hop += 1) {
    expand(state, deps);
    if (r.state !== 'pending') return null;
  }
  return emitHead(state);
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

// No CI run at the release head (WP-04's C2-8 rule): wait 30 minutes per head
// from the first absent-or-pending observation, still holding the lock, then
// fail. A release is never held.
function noCi(state, action, out, deps) {
  const gate = out.patch?.gate;
  if (action.step !== 'gate' || !['amend', 'block'].includes(out.outcome) || !gate?.failures?.includes('no CI at head') || (gate.causes ?? []).some((cause) => cause !== 'ci')) return out;
  const r = state.release;
  const since = Date.parse(gate.pendingSince ?? (r.noCi?.head === gate.head ? r.noCi.since : new Date(deps.now()).toISOString()));
  if (deps.now() - since >= NO_CI_WINDOW_MS) return { ...out, outcome: 'block', reason: 'CI did not complete at head' };
  const again = Object.fromEntries(Object.entries(action).filter(([key]) => !['id', 'phase'].includes(key)));
  return { outcome: 'wait', waitMs: WAIT_MS, reason: 'no CI run at the release head yet',
    patch: { gate, noCi: { head: gate.head, since: new Date(since).toISOString() }, queue: [again, ...r.queue.slice(1)] } };
}

function recordLand(state, action, result, deps) {
  const r = state.release;
  const out = noCi(state, action, recordLandStep(state, view(state), action, result, { exec: deps.exec, read: deps.read, now: deps.now }), deps);
  const patch = out.patch ?? {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'queue') r.queue = [...value];
    else if (key === 'mergeLock' || key === 'dispatchHalt') state[key] = value;
    else r[key] = value;
  }
  if (!Object.hasOwn(patch, 'queue')) r.queue.shift();
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
  let before;
  let after;
  try {
    before = JSON.parse(original);
    after = JSON.parse(text);
  } catch (error) {
    throw new ConductError(2, `bump ${file} does not parse after the edit: ${error.message}`);
  }
  if (!setAt(before, jsonPath, to) || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new ConductError(2, `bump ${file}: the edit must change only ${jsonPath}, to ${to}`);
  }
}

export function record(state, action, result = {}, deps) {
  const r = state.release;
  if (action.touch) return recordTouch(state, state.touches[action.touch.n - 1], action, result);
  if (LAND_STEPS.has(action.step) && action.kind !== 'wait') return recordLand(state, action, result, deps);
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
  } else if (result.code !== 0) return fail(state, deps, action, result);
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
