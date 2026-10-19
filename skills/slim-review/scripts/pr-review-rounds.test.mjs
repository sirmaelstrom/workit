/**
 * pr-review-rounds — a rebase is mapped by patch id, not refused.
 *
 * Each scenario is a real git repository read through a `gh` runner that
 * answers GitHub's REST shapes from it (`__fixtures__/git-gh.mjs`), so the
 * compare statuses, commit lists and diffs the mapping reads are git's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffPreimages, gitPatchId, mapRebase, readRebase, readRoundTail, resolveRound, roundsAnswer, REBASE_COMMIT_CAP } from './pr-review-rounds.mjs';
import { git, gitBackedGh } from './__fixtures__/git-gh.mjs';

const LINES = (tag) => Array.from({ length: 12 }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'rounds-rebase-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, f), LINES(f));
  commit(dir, 'base');
  return dir;
}
function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
function edit(dir, file, from, to) {
  const path = join(dir, file);
  const text = git(dir, ['show', `HEAD:${file}`]);
  if (!text.includes(from)) throw new Error(`${file} lacks ${from}`);
  writeFileSync(path, text.replace(from, to));
}
const head = (dir) => git(dir, ['rev-parse', 'HEAD']).trim();

/** main with a.txt/b.txt/c.txt; a PR branch `pr` with two commits (a.txt, b.txt). */
function prOnMain() {
  const dir = repo();
  git(dir, ['checkout', '-q', '-b', 'pr']);
  edit(dir, 'a.txt', 'a.txt line 2', 'a.txt line 2 (pr)');
  const c1 = commit(dir, 'pr: a');
  edit(dir, 'b.txt', 'b.txt line 6', 'b.txt line 6 (pr)');
  const c2 = commit(dir, 'pr: b');
  return { dir, c1, c2 };
}
/** Advance main by one commit editing `file` at `line`. */
function advanceMain(dir, file, from, to) {
  git(dir, ['checkout', '-q', 'main']);
  edit(dir, file, from, to);
  const m = commit(dir, `main: ${file}`);
  git(dir, ['checkout', '-q', 'pr']);
  return m;
}
const full = (h, id = 11) => ({ review_id: id, head: h, scope: 'full', since: null });
const delta = (h, since, id = 12) => ({ review_id: id, head: h, scope: 'delta', since });

function round(dir, reviews, to) {
  const { runGh, calls } = gitBackedGh(dir);
  const last = reviews[reviews.length - 1];
  const tail = readRoundTail({ repo: 'o/r', pr: 1, cwd: dir, runGh, from: last.head, to });
  return { ...resolveRound({ reviews, head: to, tail }), calls, rawTail: tail };
}

test('gitPatchId: the same change on a different base has the same id; an empty diff has none', () => {
  const { dir, c1 } = prOnMain();
  const before = gitPatchId(git(dir, ['diff', `${c1}^`, c1]));
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  const rebased = git(dir, ['rev-parse', 'HEAD~1']).trim();
  assert.notEqual(rebased, c1);
  assert.equal(gitPatchId(git(dir, ['diff', `${rebased}^`, rebased])), before);
  assert.match(before, /^[0-9a-f]{40}$/);
  assert.equal(gitPatchId(''), null);
});

test('a patch-identical rebase reads reviewed, with rebased_from naming the reviewed head (delta and capped rounds)', () => {
  const { dir, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  const rebased = head(dir);
  const r = round(dir, [full(reviewed)], rebased);
  assert.equal(r.rawTail.status, 'diverged', 'the compare from the reviewed head diverged');
  assert.deepEqual(r.answer, {
    round: 'reviewed',
    last: { head: reviewed, scope: 'full', review_id: 11 },
    rebased_from: reviewed,
    rebase: { kind: 'identical', from: reviewed, commits: 2 },
    problem: null,
  });
  assert.ok(r.calls.every((args) => args[0] === 'api' && !args.includes('-X') && !args.includes('--method')), 'every read is a GET');

  // The capped round maps the same way: the delta head was rebased unchanged.
  const capped = round(dir, [full('f'.repeat(40), 10), delta(reviewed, 'f'.repeat(40))], rebased);
  assert.deepEqual([capped.answer.round, capped.answer.rebased_from, capped.answer.problem], ['reviewed', reviewed, null]);
});

test('a patch-identical rebase keeps a pending delta escalation (two P1/P2 defects) on the wire', () => {
  // Ported from babysit's 'a qualifying delta still blocks on a patch-identical
  // rebase': the rebase maps the head back to the reviewed delta head, and the
  // council it owes stays owed. Conduct's recoverAction reads `escalate` here.
  const { dir, c1, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  const rebased = head(dir);
  const owed = { ...delta(reviewed, c1), majorFindings: 2 };
  const r = round(dir, [full(c1), owed], rebased);
  assert.equal(r.rawTail.status, 'diverged', 'the compare from the reviewed delta head diverged');
  assert.deepEqual([r.answer.round, r.answer.rebased_from, r.answer.rebase?.kind], ['reviewed', reviewed, 'identical']);
  assert.deepEqual([r.answer.escalate, r.answer.major_findings], ['t2-council', 2], JSON.stringify(r.answer));

  // A recorded council round on the delta is what clears it, not the rebase.
  const cleared = round(dir, [full(c1), { ...owed, councilRoundId: 'run/WP-01/3' }], rebased);
  assert.equal(cleared.answer.escalate, undefined, JSON.stringify(cleared.answer));
});

test('a rebase with one conflict-resolution hunk: the delta is exactly that commit, since its parent', () => {
  const { dir, c2: reviewed } = prOnMain();
  // main edits the line the PR's second commit edits, so the rebase conflicts there.
  advanceMain(dir, 'b.txt', 'b.txt line 6', 'b.txt line 6 (main)');
  try { git(dir, ['rebase', '-q', 'main']); } catch { /* the conflict on b.txt is expected */ }
  writeFileSync(join(dir, 'b.txt'), LINES('b.txt').replace('b.txt line 6', 'b.txt line 6 (main) (pr)'));
  git(dir, ['add', 'b.txt']);
  git(dir, ['-c', 'core.editor=true', 'rebase', '--continue']);
  const rebased = head(dir);
  const firstRebased = git(dir, ['rev-parse', 'HEAD~1']).trim();
  const r = round(dir, [full(reviewed)], rebased);
  assert.deepEqual(r.answer, {
    round: 'delta',
    since: firstRebased,
    last: { head: reviewed, scope: 'full', review_id: 11 },
    rebase: { kind: 'delta', from: reviewed, since: firstRebased, commits: 1, fresh: 1 },
    problem: null,
  });
  assert.equal(r.from, firstRebased);
  assert.deepEqual([r.tail.from, r.tail.to, r.tail.status, r.tail.aheadBy], [firstRebased, rebased, 'ahead', 1], 'the delta tail spans exactly the resolved commit');
});

test('a rebase plus an amendment on top: the delta is the amendment alone', () => {
  const { dir, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  const rebasedTip = head(dir);
  edit(dir, 'a.txt', 'a.txt line 9', 'a.txt line 9 (amend)');
  const amended = commit(dir, 'pr: amend');
  const r = round(dir, [full(reviewed)], amended);
  assert.deepEqual([r.answer.round, r.answer.since, r.answer.problem, r.answer.rebase.commits], ['delta', rebasedTip, null, 1]);
});

test('a force-push of unrelated content still refuses, with the mapping reason beside the old problem', () => {
  const { dir, c2: reviewed } = prOnMain();
  git(dir, ['checkout', '-q', '-B', 'pr', 'main']);
  edit(dir, 'c.txt', 'c.txt line 4', 'c.txt line 4 (unrelated)');
  const unrelated = commit(dir, 'something else');
  const r = round(dir, [full(reviewed)], unrelated);
  assert.equal(r.answer.round, 'delta');
  assert.equal(r.answer.since, reviewed, 'since stays the reviewed head');
  assert.match(r.answer.problem, /is not an ancestor of the head .* \(compare status: diverged\)/);
  assert.equal(r.answer.rebase.kind, 'refused');
  assert.match(r.answer.rebase.reason, /no commit on the head carries a reviewed patch/);
});

test('a rebase that changed the first commit refuses: the delta would be the whole PR', () => {
  const { dir, c2: reviewed } = prOnMain();
  advanceMain(dir, 'a.txt', 'a.txt line 2', 'a.txt line 2 (main)');
  try { git(dir, ['rebase', '-q', 'main']); } catch { /* conflict on a.txt */ }
  writeFileSync(join(dir, 'a.txt'), LINES('a.txt').replace('a.txt line 2', 'a.txt line 2 (main) (pr)'));
  git(dir, ['add', 'a.txt']);
  git(dir, ['-c', 'core.editor=true', 'rebase', '--continue']);
  const r = round(dir, [full(reviewed)], head(dir));
  assert.equal(r.answer.rebase.kind, 'refused');
  assert.match(r.answer.rebase.reason, /first commit .* carries a patch no review saw/);
  assert.match(r.answer.problem, /not an ancestor/);
});

test('a clean merge of the base branch is no new patch: reviewed; a merge carrying an edit still refuses', () => {
  const { dir, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['merge', '-q', '--no-edit', 'main']);
  const merged = head(dir);
  const clean = round(dir, [full(reviewed)], merged);
  assert.equal(clean.rawTail.status, 'ahead');
  assert.deepEqual([clean.answer.round, clean.answer.rebased_from, clean.answer.problem], ['reviewed', reviewed, null]);

  // The same merge with an extra edit folded in (an "evil" merge).
  git(dir, ['reset', '-q', '--hard', reviewed]);
  git(dir, ['merge', '-q', '--no-commit', 'main']);
  writeFileSync(join(dir, 'a.txt'), git(dir, ['show', ':a.txt']).replace('a.txt line 11', 'a.txt line 11 (in the merge)'));
  git(dir, ['add', 'a.txt']);
  const evil = commit(dir, 'merge main with an edit');
  const r = round(dir, [full(reviewed)], evil);
  assert.equal(r.answer.round, 'delta');
  assert.match(r.answer.problem, /contains a merge commit/);
  assert.equal(r.answer.rebase.kind, 'delta');
});

test('an ahead tail with no merge is not mapped: no extra read, the answer is as before', () => {
  const { dir, c2: reviewed } = prOnMain();
  edit(dir, 'a.txt', 'a.txt line 9', 'a.txt line 9 (amend)');
  const amended = commit(dir, 'pr: amend');
  const r = round(dir, [full(reviewed)], amended);
  assert.deepEqual(r.answer, { round: 'delta', since: reviewed, last: { head: reviewed, scope: 'full', review_id: 11 }, problem: null });
  assert.equal(r.calls.length, 1, 'one compare, nothing else');
});

test('a mapping read that fails leaves the refusal exactly as before', () => {
  const { dir, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  const rebased = head(dir);
  const { runGh } = gitBackedGh(dir);
  const failing = (args) => { if (args.includes('Accept: application/vnd.github.diff')) throw new Error('HTTP 406: diff too large'); return runGh(args); };
  const tail = readRoundTail({ repo: 'o/r', pr: 1, cwd: dir, runGh: failing, from: reviewed, to: rebased });
  const answer = roundsAnswer({ reviews: [full(reviewed)], head: rebased, tail });
  assert.equal(answer.round, 'delta');
  assert.match(answer.problem, /not an ancestor/);
  assert.deepEqual([answer.rebase.kind, /diff too large/.test(answer.rebase.reason)], ['unavailable', true]);
});

test('mapRebase: the pure rules', () => {
  const nm = (sha, patchId) => ({ sha, merge: false, patchId });
  const rv = (...ids) => ids.map((patchId, i) => ({ sha: `r${i}`, patchId }));
  assert.deepEqual(mapRebase({ chain: [nm('a', 'p1'), nm('b', 'p2')], reviewed: rv('p2', 'p1') }), { kind: 'identical', commits: 2 });
  // a reviewed patch the head dropped is refused: nothing proves it landed upstream
  const dropped = mapRebase({ chain: [nm('b', 'p2')], reviewed: rv('p1', 'p2') });
  assert.equal(dropped.kind, 'refused');
  assert.match(dropped.reason, /no longer carries the reviewed patch of r0/);
  // an empty commit is no patch, on either side
  assert.equal(mapRebase({ chain: [nm('a', 'p1'), nm('e', null)], reviewed: rv('p1', null) }).kind, 'identical');
  // a rewritten patch under the same message replaces the reviewed one and is reviewed again
  const msg = (sha, patchId, message) => ({ sha, merge: false, patchId, message });
  assert.deepEqual(
    mapRebase({ chain: [msg('a', 'p1', 'one'), msg('b', 'p2x', 'two')], reviewed: [{ sha: 'r0', patchId: 'p1', message: 'one' }, { sha: 'r1', patchId: 'p2', message: 'two' }] }),
    { kind: 'delta', since: 'a', commits: 1, fresh: 1 },
  );
  // a new commit under another message is no replacement: the reviewed one was dropped
  assert.equal(mapRebase({ chain: [msg('a', 'p1', 'one'), msg('b', 'p3', 'three')], reviewed: [{ sha: 'r0', patchId: 'p1', message: 'one' }, { sha: 'r1', patchId: 'p2', message: 'two' }] }).kind, 'refused');
  // one replacement per dropped commit
  assert.equal(mapRebase({ chain: [msg('a', 'p1', 'one'), msg('b', 'p9', 'two')], reviewed: [{ sha: 'r0', patchId: 'p1', message: 'one' }, { sha: 'r1', patchId: 'p2', message: 'two' }, { sha: 'r2', patchId: 'p3', message: 'two' }] }).kind, 'refused');
  // one for one: a reviewed patch accounts for one head commit, a second copy is new
  assert.deepEqual(mapRebase({ chain: [nm('a', 'p1'), nm('b', 'p1')], reviewed: rv('p1') }), { kind: 'delta', since: 'a', commits: 1, fresh: 1 });
  // interleaved: everything after the first new patch is reviewed again
  assert.deepEqual(mapRebase({ chain: [nm('a', 'p1'), nm('b', 'NEW'), nm('c', 'p2')], reviewed: rv('p1', 'p2') }), { kind: 'delta', since: 'a', commits: 2, fresh: 1 });
  // a merge that is not clean is new (an octopus merge is never clean)
  assert.equal(mapRebase({ chain: [nm('a', 'p1'), { sha: 'm', merge: true, clean: false, patchId: null }], reviewed: rv('p1') }).kind, 'delta');
  // the same commit on both sides needs no patch id
  assert.equal(mapRebase({ chain: [{ sha: 'a', reviewedSha: true, merge: false, patchId: null }, { sha: 'm', merge: true, clean: true, patchId: null }], reviewed: [] }).kind, 'identical');
  assert.equal(mapRebase({ chain: [], reviewed: rv('p1') }).kind, 'refused');
  assert.equal(mapRebase({ chain: [nm('a', 'x')], reviewed: rv('p1') }).kind, 'refused');
  // only empty commits and clean merges: no reviewed patch on the head
  assert.equal(mapRebase({ chain: [nm('e', null)], reviewed: rv('p1') }).kind, 'refused');
});

test('a rebase that dropped a reviewed commit refuses', () => {
  const { dir, c1, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  // keep only the second commit: the reviewed change to a.txt is gone
  git(dir, ['rebase', '-q', '--onto', 'main', c1, 'pr']);
  const r = round(dir, [full(reviewed)], head(dir));
  assert.equal(r.answer.round, 'delta');
  assert.equal(r.answer.rebase.kind, 'refused');
  assert.match(r.answer.rebase.reason, new RegExp(`no longer carries the reviewed patch of ${c1.slice(0, 7)}`));
  assert.match(r.answer.problem, /not an ancestor/);
});

test('a conflict resolution that changes only indentation is a new patch (patch ids keep whitespace)', () => {
  const dir = repo();
  writeFileSync(join(dir, 'p.py'), 'if ok:\n    run()\n');
  commit(dir, 'base: p.py');
  git(dir, ['checkout', '-q', '-b', 'pr']);
  writeFileSync(join(dir, 'p.py'), 'if ok:\n    run()\naudit()\n');
  const reviewed = commit(dir, 'pr: audit');
  // the same addition, now inside the if: one indentation apart
  git(dir, ['checkout', '-q', '-B', 'pr2', 'main']);
  edit(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  commit(dir, 'main-ish: c');
  writeFileSync(join(dir, 'p.py'), 'if ok:\n    run()\n    audit()\n');
  const indented = commit(dir, 'pr: audit (indented)');
  const a = gitPatchId(git(dir, ['diff', `${reviewed}^`, reviewed]));
  const b = gitPatchId(git(dir, ['diff', `${indented}^`, indented]));
  assert.notEqual(a, b, 'indentation is part of the patch id');
});

test('a rebase that rewrites a reviewed patch only in indentation gets a delta over it, never reviewed', () => {
  const dir = repo();
  writeFileSync(join(dir, 'p.py'), 'if ok:\n    run()\n');
  commit(dir, 'base: p.py');
  git(dir, ['checkout', '-q', '-b', 'pr']);
  edit(dir, 'a.txt', 'a.txt line 2', 'a.txt line 2 (pr)');
  commit(dir, 'pr: a');
  writeFileSync(join(dir, 'p.py'), 'if ok:\n    run()\naudit()\n');
  const reviewed = commit(dir, 'pr: audit');
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  writeFileSync(join(dir, 'p.py'), 'if ok:\n    run()\n    audit()\n');
  git(dir, ['add', 'p.py']);
  git(dir, ['commit', '-q', '--amend', '--no-edit']);
  const r = round(dir, [full(reviewed)], head(dir));
  assert.deepEqual([r.answer.round, r.answer.since, r.answer.rebase.kind, r.answer.rebase.commits], ['delta', git(dir, ['rev-parse', 'HEAD~1']).trim(), 'delta', 1]);
});

test('a rebase that drops a reviewed merge carrying its own edit refuses', () => {
  const { dir } = prOnMain();
  git(dir, ['reset', '-q', '--hard', 'HEAD~1']); // the PR is `pr: a` alone
  const c1 = head(dir);
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['merge', '-q', '--no-commit', 'main']);
  writeFileSync(join(dir, 'b.txt'), git(dir, ['show', ':b.txt']).replace('b.txt line 3', 'b.txt line 3 GUARD()'));
  git(dir, ['add', 'b.txt']);
  const reviewed = commit(dir, 'merge main, with a guard');
  // rebuilt on main with only `pr: a`: the guard that rode in with the merge is gone
  git(dir, ['checkout', '-q', '-B', 'pr', 'main']);
  git(dir, ['cherry-pick', c1]);
  const r = round(dir, [full(reviewed)], head(dir));
  assert.equal(r.answer.rebase.kind, 'refused');
  assert.match(r.answer.rebase.reason, /reviewed merge .* carried its own edits/);
  assert.notEqual(r.answer.round, 'reviewed');
});

test('one patch id at two places (identical context): the edit moved to the other block is not reviewed (workit#228 codex P1)', () => {
  const dir = repo();
  const block = ['alpha', 'beta', 'gamma', 'TARGET', 'delta', 'epsilon', 'zeta'];
  writeFileSync(join(dir, 'd.txt'), ['head', ...block, 'sep 1', 'sep 2', 'sep 3', 'sep 4', ...block, 'tail', ''].join('\n'));
  commit(dir, 'base: d.txt');
  git(dir, ['checkout', '-q', '-b', 'pr']);
  const text = git(dir, ['show', 'HEAD:d.txt']);
  const at = (n) => { let i = -1; for (let k = 0; k < n; k++) i = text.indexOf('TARGET', i + 1); return i; };
  writeFileSync(join(dir, 'd.txt'), `${text.slice(0, at(1))}EDITED${text.slice(at(1) + 'TARGET'.length)}`);
  const reviewed = commit(dir, 'pr: edit the block');
  // the same message and, by patch id, the same patch; but on the second block
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['checkout', '-q', '-B', 'pr', 'main']);
  const moved = git(dir, ['show', 'HEAD:d.txt']);
  writeFileSync(join(dir, 'd.txt'), `${moved.slice(0, at(2))}EDITED${moved.slice(at(2) + 'TARGET'.length)}`);
  const head2 = commit(dir, 'pr: edit the block');
  assert.equal(gitPatchId(git(dir, ['diff', `${reviewed}^`, reviewed])), gitPatchId(git(dir, ['diff', `${head2}^`, head2])), 'the probe: one patch id for edits at two places');
  const r = round(dir, [full(reviewed)], head2);
  assert.notEqual(r.answer.round, 'reviewed');
  assert.notEqual(r.answer.rebase.kind, 'identical');
});

test('a block the base moved between sections, unique on each side: the edit under the other section is not reviewed (workit#228 delta codex P1)', () => {
  const dir = repo();
  const block = ['alpha', 'beta', 'gamma', 'TARGET', 'delta', 'epsilon', 'zeta'];
  const file = (userBlock, adminBlock) => ['[USER]', ...userBlock, '[ADMIN]', 'admin 1', 'admin 2', 'admin 3', 'admin 4', ...adminBlock, 'end', ''].join('\n');
  writeFileSync(join(dir, 'f.txt'), file(block, []));
  commit(dir, 'base: f.txt');
  git(dir, ['checkout', '-q', '-b', 'pr']);
  edit(dir, 'a.txt', 'a.txt line 2', 'a.txt line 2 (pr)');
  commit(dir, 'pr: a');
  writeFileSync(join(dir, 'f.txt'), file(block.map((l) => (l === 'TARGET' ? 'EDITED' : l)), []));
  const reviewed = commit(dir, 'pr: edit the block');
  // the base moves the block from USER to ADMIN; it is unique on both sides
  git(dir, ['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'f.txt'), file([], block));
  commit(dir, 'main: move the block under ADMIN');
  git(dir, ['checkout', '-q', '-B', 'pr', 'main']);
  edit(dir, 'a.txt', 'a.txt line 2', 'a.txt line 2 (pr)');
  const first = commit(dir, 'pr: a');
  writeFileSync(join(dir, 'f.txt'), file([], block.map((l) => (l === 'TARGET' ? 'EDITED' : l))));
  const moved = commit(dir, 'pr: edit the block');
  assert.equal(gitPatchId(git(dir, ['diff', `${reviewed}^`, reviewed])), gitPatchId(git(dir, ['diff', `${moved}^`, moved])), 'the probe: one patch id, an edit under another section');
  const r = round(dir, [full(reviewed)], moved);
  assert.deepEqual([r.answer.round, r.answer.since, r.answer.rebase.kind, r.answer.rebase.commits], ['delta', first, 'delta', 1]);
});

test('diffPreimages: context and removed lines per hunk; a created file and a quoted path', () => {
  const d = [
    'diff --git a/x.txt b/x.txt', 'index 1..2 100644', '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three',
    'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+new', '',
  ].join('\n');
  assert.deepEqual(diffPreimages(d), [{ path: 'x.txt', newPath: 'x.txt', created: false, hunks: [['one', 'two', 'three']] }, { path: null, newPath: 'n.txt', created: true, hunks: [[]] }]);
  assert.equal(diffPreimages('diff --git "a/x y" "b/x y"\n--- "a/x y"\n+++ "b/x y"\n@@ -1 +1 @@\n-a\n+b\n'), null);
});

test('the mapping refuses a truncated or over-cap commit list before reading any diff', () => {
  const sha = (c) => c.repeat(40);
  const commits = (n, tip) => Array.from({ length: n }, (_, i) => ({ sha: i === n - 1 ? tip : sha(String(i % 10)), parents: [{ sha: 'p'.repeat(40) }] }));
  const runFor = (payloadFor) => {
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (args[1] === 'repos/o/r/pulls/1') return JSON.stringify({ base: { ref: 'main' } });
      if (args[1]?.startsWith('repos/o/r/compare/main...')) return JSON.stringify(payloadFor(args[1].split('...')[1]));
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    return { runGh, calls };
  };
  const over = runFor((tip) => ({ commits: commits(REBASE_COMMIT_CAP + 1, tip), total_commits: REBASE_COMMIT_CAP + 1 }));
  const a = readRebase({ repo: 'o/r', pr: 1, runGh: over.runGh, from: sha('a'), to: sha('b') });
  assert.deepEqual([a.kind, /over the mapping cap/.test(a.reason)], ['unavailable', true]);
  const short = runFor((tip) => ({ commits: commits(2, tip), total_commits: 300 }));
  const b = readRebase({ repo: 'o/r', pr: 1, runGh: short.runGh, from: sha('a'), to: sha('b') });
  assert.deepEqual([b.kind, /listed 2 of 300 commits/.test(b.reason)], ['unavailable', true]);
  for (const { calls } of [over, short]) assert.ok(calls.every((args) => !args.includes('Accept: application/vnd.github.diff')), 'no diff was read');
});

test('readRoundTail keeps a settled mapping per tail; an unavailable one is read again', () => {
  const { dir, c2: reviewed } = prOnMain();
  advanceMain(dir, 'c.txt', 'c.txt line 1', 'c.txt line 1 (main)');
  git(dir, ['rebase', '-q', 'main']);
  const rebased = head(dir);
  const cache = new Map();
  const { runGh, calls } = gitBackedGh(dir);
  const read = () => readRoundTail({ repo: 'o/r', pr: 1, cwd: dir, runGh, from: reviewed, to: rebased, cache });
  assert.equal(read().rebase.kind, 'identical');
  const after = calls.length;
  assert.equal(read().rebase.kind, 'identical');
  assert.equal(calls.length - after, 1, 'the second read is the tail compare alone');

  let fail = true;
  const flaky = (args) => { if (fail && args.includes('Accept: application/vnd.github.diff')) throw new Error('HTTP 502'); return runGh(args); };
  const cache2 = new Map();
  const again = () => readRoundTail({ repo: 'o/r', pr: 1, cwd: dir, runGh: flaky, from: reviewed, to: rebased, cache: cache2 });
  assert.equal(again().rebase.kind, 'unavailable');
  fail = false;
  assert.equal(again().rebase.kind, 'identical');
});

test('a history past the base that is not one first-parent line, or over the cap, is not mapped', () => {
  const { dir, c2: reviewed } = prOnMain();
  // a side branch merged into the PR brings commits off the first-parent line
  git(dir, ['checkout', '-q', '-b', 'side', 'main']);
  edit(dir, 'c.txt', 'c.txt line 3', 'c.txt line 3 (side)');
  commit(dir, 'side');
  git(dir, ['checkout', '-q', 'pr']);
  git(dir, ['merge', '-q', '--no-edit', 'side']);
  const r = round(dir, [full(reviewed)], head(dir));
  assert.equal(r.answer.rebase.kind, 'unavailable');
  assert.match(r.answer.rebase.reason, /not one first-parent line/);
  assert.match(r.answer.problem, /contains a merge commit/);
  assert.ok(REBASE_COMMIT_CAP >= 10);
});
