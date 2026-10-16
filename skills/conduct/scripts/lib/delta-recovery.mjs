import { createHash } from 'node:crypto';
import { ConductError } from './state.mjs';
import { gitPatchId, patchPlace, REBASE_FILE_READ_CAP } from '../../../slim-review/scripts/pr-review-rounds.mjs';

// A reset's mapping belongs to one reviewed head and one candidate. A later
// amendment or rebase must not silently reuse it for another candidate.
// Without one, the baseline is the first head no delta check has seen: where
// the first amendment since the last land started, else the reviewed head.
export function deltaBaseline(wp) {
  const reviewed = (wp.reviews ?? []).at(-1)?.head;
  const recovery = wp.deltaRecovery;
  if (!recovery || recovery.reviewedHead !== reviewed) return wp.deltaFrom ?? reviewed;
  if (recovery.head !== wp.pr?.head) throw new ConductError(5, `delta recovery: ${wp.id}'s candidate moved; reset --to delta again to verify its baseline`);
  return recovery.baseline;
}

// Verify the operator-supplied baseline without changing run state or the
// repository. For a rebase, compare the reviewed prefix from its recorded old
// base with the proposed prefix from the recorded new base. The shared place
// check binds equal patches to unchanged parent-file contents and unique hunks.
export function verifyDeltaRecovery(wp, baseline, deps) {
  const fail = (why) => { throw new ConductError(5, `reset-wp: ${why}`); };
  if (typeof baseline !== 'string' || !/^[0-9a-f]{7,40}$/i.test(baseline)) {
    throw new ConductError(2, 'reset-wp: --to delta requires --baseline <commit sha>');
  }
  const review = (wp.reviews ?? []).at(-1);
  if (review?.scope !== 'full' || !review.head) fail(`${wp.id} has no latest full review; a delta reset cannot bypass the review cap`);
  if (wp.owed?.adjudicate) fail(`${wp.id}'s findings are not adjudicated; reset it --to checked`);
  const run = (args, options) => deps.exec('git', ['-C', wp.lane.worktree, ...args], options);
  const read = (args) => {
    const result = run(args);
    if (result.code !== 0) fail(`cannot verify delta baseline: git ${args[0]} failed (exit ${result.code})`);
    return result.stdout;
  };
  const commit = (sha) => {
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) fail('the recorded review or rebase has no valid commit SHA');
    const resolved = read(['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    if (!/^[0-9a-f]{40}$/i.test(resolved)) fail('git returned no complete commit SHA');
    return resolved;
  };
  const ancestor = (from, to) => {
    const result = run(['merge-base', '--is-ancestor', from, to]);
    if (![0, 1].includes(result.code)) fail('delta baseline ancestry is unreadable');
    return result.code === 0;
  };
  const head = commit(wp.pr.head);
  const reviewedHead = commit(review.head);
  const since = commit(baseline);
  if (read(['rev-parse', 'HEAD']).trim() !== head) fail(`${wp.id}'s worktree HEAD differs from its recorded PR head; check the PR first`);
  if (read(['status', '--porcelain']).trim()) fail(`${wp.id}'s worktree has local changes; commit or resolve them before resetting review`);
  if (since === head) fail('the delta baseline is the candidate itself; it would skip the entire tail');
  if (!ancestor(since, head)) fail('the delta baseline is not an ancestor of the candidate');
  const binding = { reviewedHead: review.head, baseline: since, head: wp.pr.head };
  if (ancestor(reviewedHead, head)) {
    if (since !== reviewedHead) fail('the baseline must be the reviewed head; a later commit would skip unreviewed changes');
    return { ...binding, kind: 'ancestor' };
  }

  const rebases = wp.rebases ?? [];
  const source = rebases.find((r) => r.oldBase && ancestor(reviewedHead, commit(r.from)) && ancestor(commit(r.oldBase), reviewedHead));
  const target = [...rebases].reverse().find((r) => r.newBase && ancestor(commit(r.to), head) && ancestor(commit(r.newBase), since));
  if (!source || !target) fail('no recorded rebase connects the reviewed prefix to this candidate; a full review is owed');
  const oldBase = commit(source.oldBase);
  const newBase = commit(target.newBase);
  const diff = (from, to) => read(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', from, to]);
  const before = diff(oldBase, reviewedHead);
  const after = diff(newBase, since);
  const patchId = gitPatchId(before);
  if (patchId === null || patchId !== gitPatchId(after)) fail('the proposed baseline does not carry exactly the reviewed prefix; a full review is owed');
  const files = new Map();
  const readFile = (path, ref) => {
    const key = `${ref}:${path}`;
    if (!files.has(key)) {
      if (files.size >= REBASE_FILE_READ_CAP) fail('the reviewed prefix exceeds the file-read mapping cap');
      files.set(key, read(['show', key]));
    }
    return files.get(key);
  };
  const place = patchPlace(before, oldBase, readFile);
  if (place === null || place !== patchPlace(after, newBase, readFile)) {
    fail('the reviewed prefix moved or its parent files changed; patch identity alone cannot establish coverage, so a full review is owed');
  }
  return { ...binding, kind: 'rebase', oldBase, newBase, patchId, placeHash: createHash('sha256').update(place).digest('hex') };
}

// Find the reviewed prefix on the new line without trusting commit messages
// or a count of commits. Every candidate must pass the same patch/place proof
// as an explicit recovery. A large or unprovable history fails closed.
export function discoverDeltaRecovery(wp, deps) {
  const reviewed = (wp.reviews ?? []).at(-1);
  if (reviewed?.scope !== 'full' || wp.owed?.adjudicate) return null;
  const run = (args) => deps.exec('git', ['-C', wp.lane.worktree, ...args]);
  if (run(['merge-base', '--is-ancestor', reviewed.head, wp.pr.head]).code === 0) return null;
  const rebase = (wp.rebases ?? []).at(-1);
  if (!rebase?.newBase || !/^[0-9a-f]{7,40}$/i.test(rebase.newBase)) return null;
  const candidates = run(['rev-list', '--reverse', '--max-count=257', `${rebase.newBase}..${wp.pr.head}`]);
  if (candidates.code !== 0) return null;
  const shas = candidates.stdout.trim().split(/\s+/).filter(Boolean);
  if (shas.length > 256) return null;
  for (const sha of shas) {
    try { return verifyDeltaRecovery(wp, sha, deps); }
    catch (error) { if (!(error instanceof ConductError)) throw error; }
  }
  return null;
}
