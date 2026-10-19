import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../../slim-review/scripts/__fixtures__/git-gh.mjs';
import { gitPatchId } from '../../../slim-review/scripts/pr-review-rounds.mjs';
import { deltaBaseline, verifyDeltaRecovery, discoverDeltaRecovery } from './delta-recovery.mjs';
import { next as buildNext, record as buildRecord } from './phases/build.mjs';
import { recordRebase, gateCheck, recordLandStep } from './land.mjs';

const text = (tag) => Array.from({ length: 15 }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';
function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
function edit(dir, file, from, to) {
  const path = join(dir, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
}
function scenario({ changedParent = false, duplicate = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-delta-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'a.txt'), duplicate ? text('a') + text('a') : text('a'));
  writeFileSync(join(dir, 'b.txt'), text('b'));
  writeFileSync(join(dir, 'c.txt'), text('c'));
  writeFileSync(join(dir, 'README.md'), 'Before ruling.\n');
  const oldBase = commit(dir, 'base');
  git(dir, ['checkout', '-qb', 'pr']);
  edit(dir, 'a.txt', 'a line 1\n', 'a line 1 reviewed\n');
  const reviewed = commit(dir, 'reviewed prefix');
  edit(dir, 'b.txt', 'b line 1\n', 'b line 1 fixed\n');
  commit(dir, 'findings fix');
  edit(dir, 'README.md', 'Before', 'After');
  const from = commit(dir, 'report-only ruling');
  git(dir, ['checkout', '-q', 'main']);
  edit(dir, changedParent ? 'a.txt' : 'c.txt', changedParent ? 'a line 15' : 'c line 15', 'base changed');
  const newBase = commit(dir, 'base advance');
  git(dir, ['checkout', '-q', 'pr']);
  git(dir, ['rebase', '-q', 'main']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const baseline = git(dir, ['rev-parse', 'HEAD~2']).trim();
  const wp = {
    id: 'WP-14', lane: { worktree: dir, base: oldBase }, pr: { number: 16, head },
    reviews: [{ scope: 'full', round: 1, head: reviewed }], owed: { adjudicate: false },
    rebases: [{ from, to: head, oldBase, newBase, equivalent: true }],
  };
  const deps = { exec: (program, args, options) => {
    assert.equal(program, 'git');
    assert.deepEqual(args.slice(0, 2), ['-C', dir]);
    try { return { code: 0, stdout: git(dir, args.slice(2), options?.input), stderr: '' }; }
    catch (error) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
  } };
  return { dir, wp, deps, reviewed, baseline, oldBase, newBase, head, from };
}

test('delta reset maps a rebased reviewed prefix and leaves the executable fixes in the review tail', () => {
  const h = scenario();
  const before = JSON.stringify(h.wp);
  const proof = verifyDeltaRecovery(h.wp, h.baseline.slice(0, 12), h.deps);
  assert.deepEqual([proof.reviewedHead, proof.baseline, proof.head, proof.kind], [h.reviewed, h.baseline, h.head, 'rebase']);
  assert.deepEqual([proof.oldBase, proof.newBase], [h.oldBase, h.newBase]);
  assert.match(proof.patchId, /^[a-f0-9]{40}$/);
  assert.match(proof.placeHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(h.wp), before, 'verification changes no run state');
  assert.deepEqual(git(h.dir, ['diff', '--name-only', proof.baseline, h.head]).trim().split('\n'), ['README.md', 'b.txt']);
  assert.equal(deltaBaseline({ ...h.wp, deltaRecovery: proof }), h.baseline);
});

test('automatic mapping discovers only the verified reviewed prefix after a rebase', () => {
  const h = scenario();
  assert.equal(discoverDeltaRecovery(h.wp, h.deps).baseline, h.baseline);
  const changed = scenario({ changedParent: true });
  assert.equal(discoverDeltaRecovery(changed.wp, changed.deps), null);
});

test('the build requests a full review after a changed-parent rebase instead of dispatching an unproved delta', () => {
  const h = scenario({ changedParent: true });
  Object.assign(h.wp, { state: 'pr', stage: 'delta', queue: [], files: ['a.txt', 'b.txt'], lane: { ...h.wp.lane, backend: 'exec', exitedAt: new Date().toISOString() } });
  const state = { phase: 'build', runDir: h.dir, pluginRoot: h.dir, slug: 'mapping-control', wps: [h.wp], touches: [], adapters: {},
    intent: { agent: 'codex', repo: { path: h.dir, remote: 'test/test', defaultBranch: 'main' }, lanesCap: 1 }, authority: { budgetUsd: 1000 }, build: { contract: 'fixture', halts: [] } };
  const deps = { ...h.deps, env: {}, now: Date.now, timestamp: () => new Date().toISOString(), exists: () => false };
  const action = buildNext(state, deps);
  assert.equal(action.step, 'review');
  assert.equal(action.part, 'diff');
  assert.match(h.wp.fullReviewOwed.reason, /no verified reviewed prefix/);
  assert.equal(h.wp.deltaRecovery, undefined);
  buildRecord(state, action, { code: 0, stdout: 'a.txt\nb.txt\n', stderr: '' }, deps);
  assert.equal(h.wp.state, 'review');
  assert.equal(h.wp.stage, 'reviewed');
  assert.equal(h.wp.queue.some((item) => item.land?.scope === 'delta'), false);
  assert.ok(h.wp.queue.length > 0);
});

test('a gate fix after a rebase of the reviewed head is diffed from the verified image, never across the rebase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-delta-gate-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'a.txt'), text('a'));
  writeFileSync(join(dir, 'b.txt'), text('b'));
  writeFileSync(join(dir, 'c.txt'), text('c'));
  const oldBase = commit(dir, 'base');
  git(dir, ['checkout', '-qb', 'pr']);
  edit(dir, 'a.txt', 'a line 1\n', 'a line 1 reviewed\n');
  const reviewed = commit(dir, 'reviewed');
  git(dir, ['checkout', '-q', 'main']);
  edit(dir, 'c.txt', 'c line 15', 'base changed');
  const newBase = commit(dir, 'base advance');
  git(dir, ['checkout', '-q', 'pr']);
  git(dir, ['rebase', '-q', 'main']);
  const rebased = git(dir, ['rev-parse', 'HEAD']).trim();
  edit(dir, 'b.txt', 'b line 1\n', 'b line 1 gate fix\n');
  const head = commit(dir, 'gate fix');
  const exec = (program, args, options) => {
    try { return { code: 0, stdout: git(dir, args.slice(2), options?.input), stderr: '' }; }
    catch (error) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
  };
  // A state saved before deltaFrom existed has none; the mapping covers it too.
  for (const deltaFrom of [rebased, undefined]) {
    const wp = {
      id: 'WP-02', state: 'pr', stage: 'delta', queue: [], files: ['a.txt', 'b.txt'], owed: { adjudicate: false }, deltaFrom,
      lane: { worktree: dir, base: oldBase, backend: 'exec', exitedAt: new Date().toISOString() }, pr: { number: 16, head },
      reviews: [{ scope: 'full', round: 1, head: reviewed }], rebases: [{ from: reviewed, to: rebased, oldBase, newBase, equivalent: true }],
    };
    const state = { phase: 'build', runDir: dir, pluginRoot: dir, slug: 'gate-fix-control', wps: [wp], touches: [], adapters: {},
      intent: { agent: 'codex', repo: { path: dir, remote: 'test/test', defaultBranch: 'main' }, lanesCap: 1 }, authority: { budgetUsd: 1000 }, build: { contract: 'fixture', halts: [] } };
    const action = buildNext(state, { exec, env: {}, now: Date.now, timestamp: () => new Date().toISOString(), exists: () => true });
    assert.equal(action.part, 'amend-diff', `deltaFrom ${deltaFrom}: ${wp.reason}`);
    assert.equal(action.command.at(-2), rebased);
    assert.equal(wp.deltaRecovery.baseline, rebased);
  }
  assert.deepEqual(git(dir, ['diff', '--name-only', rebased, head]).trim().split('\n'), ['b.txt']);
  assert.notDeepEqual(git(dir, ['diff', '--name-only', reviewed, head]).trim().split('\n'), ['b.txt'], 'the unmapped range would carry the base change');
});

test('a later full review retires the old rebase proof before reviewing its own tail', () => {
  const h = scenario();
  h.wp.deltaRecovery = verifyDeltaRecovery(h.wp, h.baseline, h.deps);
  const currentReview = git(h.dir, ['rev-parse', 'HEAD~1']).trim();
  h.wp.reviews.push({ scope: 'full', head: currentReview, round: 3 });
  Object.assign(h.wp, { state: 'pr', stage: 'delta', queue: [], files: ['a.txt', 'b.txt'], lane: { ...h.wp.lane, backend: 'exec', exitedAt: new Date().toISOString() } });
  const state = { phase: 'build', runDir: h.dir, pluginRoot: h.dir, slug: 'mapping-control', wps: [h.wp], touches: [], adapters: {},
    intent: { agent: 'codex', repo: { path: h.dir, remote: 'test/test', defaultBranch: 'main' }, lanesCap: 1 }, authority: { budgetUsd: 1000 }, build: { contract: 'fixture', halts: [] } };
  const action = buildNext(state, { ...h.deps, env: {}, now: Date.now, timestamp: () => new Date().toISOString(), exists: () => true });
  assert.equal(action.part, 'amend-diff');
  assert.equal(action.command.at(-2), currentReview);
  assert.equal(h.wp.deltaRecovery.reviewedHead, currentReview);
  assert.equal(h.wp.deltaRecovery.kind, 'ancestor');
});

test('landing revalidates legacy patch-only receipts and sends a changed-parent rebase to full review', () => {
  for (const changedParent of [false, true]) {
    const h = scenario({ changedParent });
    git(h.dir, ['update-ref', 'refs/remotes/origin/main', h.newBase]);
    const receipt = recordRebase({}, { ...h.wp, rebases: [] }, { from: h.from, to: h.head, newBase: h.newBase }, h.deps);
    assert.equal(receipt.equivalent, !changedParent);
    const wp = { ...h.wp, tier: 'T1', state: 'gate', files: ['a.txt', 'b.txt', 'README.md'], queue: [],
      reviews: [{ scope: 'full', round: 1, head: h.from, verdicts: [], resolved: [] }],
      // A saved pre-fix run claims equivalence using patch IDs alone.
      rebases: [{ ...receipt, equivalent: true, equivalenceProof: undefined }] };
    const state = { runDir: h.dir, pluginRoot: h.dir, intent: { repo: { path: h.dir, remote: 'test/test', defaultBranch: 'main' } },
      authority: { merge: true }, adapters: {}, mergeLock: { wpId: wp.id }, wps: [wp] };
    const ok = (value = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    const exec = (program, args, options) => {
      if (program === 'git') return args[2] === 'fetch' ? ok() : h.deps.exec(program, args, options);
      if (program === 'node') return ok();
      assert.equal(program, 'gh');
      if (args[0] === 'pr') return ok({ headRefOid: h.head, baseRefName: 'main', state: 'OPEN', body: '## Merge danger\n\nDoor: two-way\nBlast radius: fixture\n' });
      if (args[1].includes('/check-runs')) return ok({ total_count: 1, check_runs: [{ id: 1, name: 'proof', status: 'completed', conclusion: 'success' }] });
      if (args[1].includes('/status?')) return ok({ total_count: 0, statuses: [] });
      if (args[1].includes('/required_status_checks')) return ok({ contexts: ['proof'], checks: [] });
      throw new Error(`unexpected mocked remote call ${args.join(' ')}`);
    };
    const verdict = gateCheck(state, wp, { exec, now: Date.now });
    assert.equal(verdict.ok, !changedParent, JSON.stringify(verdict));
    if (changedParent) {
      assert.equal(verdict.needsFullReview, true);
      const unsigned = { merge: true, release: false, budgetUsd: 0 };
      const out = recordLandStep(state, wp, { step: 'gate', part: 'gate', kind: 'shell' }, { code: 5, stdout: JSON.stringify(verdict), stderr: '' }, { exec }, unsigned);
      assert.equal(out.outcome, 'continue');
      assert.ok(out.patch.queue.some((action) => action.step === 'review'));
      assert.equal(out.patch.queue.some((action) => action.land?.scope === 'delta'), false);
    }
  }
});

test('delta reset cannot advance the baseline past an unreviewed fix or select the candidate itself', () => {
  const h = scenario();
  const afterFix = git(h.dir, ['rev-parse', 'HEAD~1']).trim();
  assert.throws(() => verifyDeltaRecovery(h.wp, afterFix, h.deps), /does not carry exactly the reviewed prefix/);
  assert.throws(() => verifyDeltaRecovery(h.wp, h.newBase, h.deps), /does not carry exactly the reviewed prefix/, 'a dropped reviewed prefix is not coverage');
  assert.throws(() => verifyDeltaRecovery(h.wp, h.head, h.deps), /skip the entire tail/);
});

test('delta reset refuses equal patch IDs when the base changed a reviewed file', () => {
  const h = scenario({ changedParent: true });
  assert.equal(gitPatchId(git(h.dir, ['diff', h.oldBase, h.reviewed])), gitPatchId(git(h.dir, ['diff', h.newBase, h.baseline])));
  assert.throws(() => verifyDeltaRecovery(h.wp, h.baseline, h.deps), /parent files changed/);
});

test('delta reset refuses a reviewed patch with more than one possible hunk location', () => {
  const h = scenario({ duplicate: true });
  assert.throws(() => verifyDeltaRecovery(h.wp, h.baseline, h.deps), /prefix moved or its parent files changed/);
});

test('delta reset can verify the prefix through two recorded rebases', () => {
  const h = scenario();
  git(h.dir, ['checkout', '-q', 'main']);
  edit(h.dir, 'c.txt', 'c line 1\n', 'c line 1 second advance\n');
  const newBase = commit(h.dir, 'second base advance');
  git(h.dir, ['checkout', '-q', 'pr']);
  git(h.dir, ['rebase', '-q', 'main']);
  const head = git(h.dir, ['rev-parse', 'HEAD']).trim();
  const baseline = git(h.dir, ['rev-parse', 'HEAD~2']).trim();
  h.wp.rebases.push({ from: h.head, to: head, oldBase: h.newBase, newBase, equivalent: true });
  h.wp.pr.head = head;
  assert.equal(verifyDeltaRecovery(h.wp, baseline, h.deps).newBase, newBase);
});

test('delta reset refuses missing rebase provenance, dirty worktrees and moved heads', () => {
  const h = scenario();
  assert.throws(() => verifyDeltaRecovery({ ...h.wp, rebases: [] }, h.baseline, h.deps), /no recorded rebase/);
  writeFileSync(join(h.dir, 'uncommitted.txt'), 'untracked input\n');
  assert.throws(() => verifyDeltaRecovery(h.wp, h.baseline, h.deps), /local changes/);
  commit(h.dir, 'local head moved');
  assert.throws(() => verifyDeltaRecovery(h.wp, h.baseline, h.deps), /HEAD differs/);
});

test('delta reset on an ancestor line accepts only the reviewed head; review caps and adjudication still hold', () => {
  const h = scenario();
  git(h.dir, ['checkout', '-q', '--detach', h.from]);
  h.wp.pr.head = h.from;
  assert.equal(verifyDeltaRecovery(h.wp, h.reviewed, h.deps).kind, 'ancestor');
  const afterFix = git(h.dir, ['rev-parse', 'HEAD~1']).trim();
  assert.throws(() => verifyDeltaRecovery(h.wp, afterFix, h.deps), /later commit would skip/);
  assert.throws(() => verifyDeltaRecovery(h.wp, h.baseline, h.deps), /not an ancestor/);
  assert.throws(() => verifyDeltaRecovery(h.wp, '--not-a-sha', h.deps), /requires --baseline/);
  assert.throws(() => verifyDeltaRecovery({ ...h.wp, reviews: [{ scope: 'delta', head: h.reviewed }] }, h.reviewed, h.deps), /review cap/);
  assert.throws(() => verifyDeltaRecovery({ ...h.wp, owed: { adjudicate: true } }, h.reviewed, h.deps), /not adjudicated/);
});

test('a delta reset binding cannot silently follow another candidate or override a new review', () => {
  const h = scenario();
  const deltaRecovery = verifyDeltaRecovery(h.wp, h.baseline, h.deps);
  assert.throws(() => deltaBaseline({ ...h.wp, deltaRecovery, pr: { ...h.wp.pr, head: h.from } }), /candidate moved/);
  assert.equal(deltaBaseline({ ...h.wp, deltaRecovery, reviews: [{ scope: 'delta', head: h.head }] }), h.head);
});
