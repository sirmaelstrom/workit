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
import { gitPatchId, mapRebase, readRoundTail, resolveRound, roundsAnswer, REBASE_COMMIT_CAP } from './pr-review-rounds.mjs';
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
  assert.deepEqual(mapRebase({ chain: [nm('a', 'p1'), nm('b', 'p2')], reviewedIds: ['p2', 'p1'] }), { kind: 'identical', commits: 2 });
  // reordered and one dropped (landed upstream): still identical
  assert.equal(mapRebase({ chain: [nm('b', 'p2')], reviewedIds: ['p1', 'p2'] }).kind, 'identical');
  // an empty commit is no patch
  assert.equal(mapRebase({ chain: [nm('a', 'p1'), nm('e', null)], reviewedIds: ['p1'] }).kind, 'identical');
  // interleaved: everything after the first new patch is reviewed again
  assert.deepEqual(mapRebase({ chain: [nm('a', 'p1'), nm('b', 'NEW'), nm('c', 'p2')], reviewedIds: ['p1', 'p2'] }), { kind: 'delta', since: 'a', commits: 2, fresh: 1 });
  // a merge that is not clean is new
  assert.equal(mapRebase({ chain: [nm('a', 'p1'), { sha: 'm', merge: true, clean: false, patchId: null }], reviewedIds: ['p1'] }).kind, 'delta');
  assert.equal(mapRebase({ chain: [], reviewedIds: ['p1'] }).kind, 'refused');
  assert.equal(mapRebase({ chain: [nm('a', 'x')], reviewedIds: ['p1'] }).kind, 'refused');
  // only empty commits and clean merges: no reviewed patch on the head
  assert.equal(mapRebase({ chain: [nm('e', null)], reviewedIds: ['p1'] }).kind, 'refused');
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
