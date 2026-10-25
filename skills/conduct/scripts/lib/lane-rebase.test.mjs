import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { next as buildNext, record as buildRecord } from './phases/build.mjs';
import { gateCheck } from './land.mjs';

// The b118b800 run: the land rebase conflicted, a gate amendment had the lane
// rebase by hand and force-push, and conduct's own rebase was then a no-op.
// The lane check after that amendment maps the lane's rebase, so the gate
// reaches the reviewed head through it. `mode`: 'identical' rebases over an
// unrelated main commit; 'conflict' resolves an add/add conflict by changing
// the reviewed hunk; 'on-top' adds a commit with no rebase; 'stale' rebases
// onto a main commit the worktree's origin/main no longer names, and its
// resolution drops that commit's change. `breakFetch` points origin nowhere
// once the lane has pushed.
function laneRebased(t, mode, { breakFetch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conduct-lane-rebase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
  const real = (args, options = {}) => {
    const r = spawnSync('git', args, { encoding: 'utf8', input: options.input });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), wt = join(root, 'lane');
  const branch = 'conduct/fixture/wp-00';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const configure = (cwd) => { for (const [key, value] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(cwd, 'config', key, value); };
  const write = (cwd, file, text) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  const commit = (cwd, file, text, message = file) => {
    write(cwd, file, text);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, seed], { stdio: 'ignore' });
  configure(seed);
  commit(seed, 'base.txt', 'base\n');
  if (mode === 'stale') commit(seed, 'lib/x.mjs', 'zero\n');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, wt], { stdio: 'ignore' });
  configure(wt);
  git(wt, 'switch', '-q', '-c', branch);
  const oldBase = git(wt, 'rev-parse', 'HEAD');
  const full = commit(wt, 'lib/x.mjs', 'one\n', 'full');
  const reviewed = commit(wt, 'lib/x.mjs', 'one\ntwo\n', 'reviewed');
  git(wt, 'push', '-q', 'origin', branch);

  // main moves; the lane's amendment rebases onto it by hand and force-pushes.
  if (mode === 'identical') commit(seed, 'sibling.txt', 'sibling\n');
  if (mode === 'conflict') commit(seed, 'lib/x.mjs', 'zero\n');
  if (mode === 'stale') commit(seed, 'lib/x.mjs', 'zero, upstream\n');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  if (mode === 'on-top') commit(wt, 'lib/x.mjs', 'one\ntwo\nthree\n', 'gate fix');
  else {
    git(wt, 'fetch', '-q', 'origin');
    if (mode === 'conflict' || mode === 'stale') {
      assert.notEqual(real(['-C', wt, 'rebase', 'origin/main']).code, 0, 'the fixture rebase conflicts');
      write(wt, 'lib/x.mjs', 'one\n');
      git(wt, 'add', 'lib/x.mjs');
      git(wt, 'rebase', '--continue');
    } else git(wt, 'rebase', '-q', 'origin/main');
  }
  git(wt, 'push', '-q', '--force', 'origin', branch);
  const after = git(wt, 'rev-parse', 'HEAD');
  const newBase = git(wt, 'rev-parse', 'origin/main');
  // The worktree's origin/main falls back to the base the lane started from.
  if (mode === 'stale') git(wt, 'update-ref', 'refs/remotes/origin/main', oldBase);
  if (breakFetch) git(wt, 'remote', 'set-url', 'origin', join(root, 'missing.git'));

  // The lane check passed: the PR lookup recorded the pushed head.
  const wp = {
    id: 'WP-00', name: 'fixture', tier: 'T1', state: 'amending', stage: 'checked', queue: [], asks: [], files: ['lib/x.mjs'],
    lane: { worktree: wt, branch, base: oldBase, backend: 'exec', exitedAt: new Date().toISOString() }, pr: { number: 7, head: after },
    reviews: [{ round: 1, scope: 'full', head: full, verdicts: [], resolved: [] }, { round: 2, scope: 'delta', since: full, head: reviewed, verdicts: [], resolved: [] }],
    owed: { adjudicate: false }, rebases: [], deltaFrom: reviewed, gateAmends: 1,
    amendment: { n: 3, since: reviewed, kind: 'gate', reason: 'rebase onto origin/main conflicted: CONFLICT (add/add)' },
    gateFixes: [{ from: reviewed, reason: 'rebase onto origin/main conflicted: CONFLICT (add/add)', rebase: true, n: 3 }],
  };
  const state = { phase: 'build', runDir: root, pluginRoot: root, slug: 'lane-rebase', wps: [wp], touches: [], adapters: {},
    intent: { agent: 'codex', repo: { path: wt, remote: 'test/test', defaultBranch: 'main' }, lanesCap: 1 },
    authority: { merge: true, budgetUsd: 1000 }, build: { contract: 'fixture', halts: [] } };
  const ok = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const exec = (program, args, options) => {
    if (program === 'git') return real(args, options);
    if (program === 'node') return ok();
    assert.equal(program, 'gh');
    if (args[0] === 'pr' && args[1] === 'ready') return ok();
    if (args[0] === 'pr') return ok({ headRefOid: wp.pr.head, baseRefName: 'main', state: 'OPEN', body: '## Merge danger\n\nDoor: two-way\nBlast radius: fixture\n' });
    if (args[1].includes('/check-runs')) return ok({ total_count: 1, check_runs: [{ id: 1, name: 'proof', status: 'completed', conclusion: 'success' }] });
    if (args[1].includes('/status?')) return ok({ total_count: 0, statuses: [] });
    if (args[1].includes('/required_status_checks')) return ok({ contexts: ['proof'], checks: [] });
    throw new Error(`unexpected mocked remote call ${args.join(' ')}`);
  };
  const deps = { exec, env: {}, now: Date.now, timestamp: () => new Date().toISOString(), exists: () => true };
  // The build from the checked stage through the land rebase, as conduct queues it.
  const parts = [];
  for (let i = 0; i < 20; i += 1) {
    const action = buildNext(state, deps);
    if (action?.kind !== 'shell' || action.step !== 'rebase') break;
    parts.push(action.part);
    buildRecord(state, action, exec(action.command[0], action.command.slice(1)), deps);
  }
  return { wp, parts, reviewed, after, oldBase, newBase, gate: () => gateCheck(state, wp, { exec, now: Date.now }) };
}

test('lane rebase (b118b800): a gate amendment\'s patch-identical rebase is mapped at the lane check, and the gate\'s coverage reaches the reviewed head through it', (t) => {
  const s = laneRebased(t, 'identical');
  assert.equal(s.wp.state, 'gate', s.wp.reason);
  assert.deepEqual(s.parts.slice(0, 2), ['lane-fetch', 'lane-base'], s.parts.join(', '));
  const [lane, own] = s.wp.rebases;
  assert.deepEqual([lane.from, lane.to, lane.oldBase, lane.newBase, lane.equivalent], [s.reviewed, s.after, s.oldBase, s.newBase, true]);
  assert.equal(lane.images[s.reviewed], s.after);
  // Conduct's own rebase is then a no-op from the lane's base.
  assert.deepEqual([own.from, own.to, own.oldBase], [s.after, s.after, s.newBase]);
  const out = s.gate();
  assert.doesNotMatch(out.failures.join('\n'), /through no recorded rebase/);
  assert.deepEqual([out.ok, out.failures], [true, []]);
});

test('lane rebase (b118b800): a conflict resolution that changed a reviewed hunk is mapped too, and the gate requires a review of the rebased head', (t) => {
  const s = laneRebased(t, 'conflict');
  assert.deepEqual(s.parts.slice(0, 2), ['lane-fetch', 'lane-base'], s.parts.join(', '));
  const [lane] = s.wp.rebases;
  assert.deepEqual([lane.from, lane.to, lane.newBase, lane.equivalent], [s.reviewed, s.after, s.newBase, false]);
  const out = s.gate();
  assert.equal(out.ok, false);
  assert.deepEqual([out.causes.includes('full-review'), out.causes.includes('review-uncovered'), out.needsFullReview], [true, false, true], out.failures.join('\n'));
});

test('lane rebase (b118b800): a gate amendment that only adds commits on top records no lane rebase', (t) => {
  const s = laneRebased(t, 'on-top');
  assert.deepEqual(s.parts.slice(0, 2), ['lane-fetch', 'lane-base'], s.parts.join(', '));
  assert.deepEqual(s.wp.rebases.map((rebase) => [rebase.from, rebase.oldBase]), [[s.after, s.oldBase]], 'only conduct\'s own rebase');
});

test('lane rebase (workit#326 r1): a lane rebased onto a newer main than the worktree\'s stale origin/main, whose resolution dropped the upstream change, is measured against the fetched main, and the gate requires a review', (t) => {
  const s = laneRebased(t, 'stale');
  assert.deepEqual(s.parts.slice(0, 2), ['lane-fetch', 'lane-base'], s.parts.join(', '));
  const [lane] = s.wp.rebases;
  assert.deepEqual([lane.from, lane.to, lane.newBase, lane.equivalent], [s.reviewed, s.after, s.newBase, false]);
  const out = s.gate();
  assert.equal(out.ok, false);
  assert.deepEqual([out.causes.includes('full-review'), out.needsFullReview], [true, true], out.failures.join('\n'));
});

test('lane rebase (workit#326 r1): a failed fetch before the lane base is read blocks, and nothing is measured against the stale origin/main', (t) => {
  const s = laneRebased(t, 'stale', { breakFetch: true });
  assert.deepEqual(s.parts, ['lane-fetch']);
  assert.equal(s.wp.state, 'blocked');
  assert.match(s.wp.reason, /^the lane's base is unreadable: fetch of origin\/main failed/);
  assert.deepEqual(s.wp.rebases, []);
});
