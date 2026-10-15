import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../../slim-review/scripts/__fixtures__/git-gh.mjs';
import { gitPatchId } from '../../../slim-review/scripts/pr-review-rounds.mjs';
import { deltaBaseline, verifyDeltaRecovery } from './delta-recovery.mjs';

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
