import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A coordinated lens reads the repository and head named by its AttemptRef.
 * Never borrow the caller's checkout: the scheduler can run in a different
 * repository, and an interactive session can edit it during the review.
 *
 * Each execution owns a temporary bare repository and detached worktree.
 * Fetching from the declared GitHub repository also avoids borrowing mutable
 * refs, hooks, config, or dependency junctions from the live checkout. This is
 * source isolation, not a sandbox. No dependencies are installed or linked.
 */
export function createReviewWorktree({ repo, headSha, run, diag = console.error }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
      || !/^[a-f0-9]{40}$/i.test(headSha)) {
    throw new Error('review checkout requires a GitHub owner/repo and full commit SHA');
  }
  const root = mkdtempSync(join(tmpdir(), 'workit-review-'));
  const gitDir = join(root, 'repository.git');
  const cwd = join(root, 'checkout');
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const cleanup = () => {
    // Only this mkdtemp-owned directory is removed. There are no junctions to
    // canonical dependencies or a shared git common directory to unregister.
    try { rmSync(root, { recursive: true, force: true }); }
    catch (err) { diag(`review checkout cleanup failed at ${root}: ${err.message}`); }
  };
  const assertHead = () => {
    const actual = String(run(git, ['-C', cwd, 'rev-parse', 'HEAD'], { cwd })).trim();
    if (actual.toLowerCase() !== headSha.toLowerCase()) {
      throw new Error(`review checkout HEAD ${actual} does not match pinned head ${headSha}`);
    }
  };
  try {
    run(git, ['init', '--bare', gitDir], { cwd: root });
    run(git, ['--git-dir', gitDir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`], { cwd: root });
    run(git, ['--git-dir', gitDir, 'fetch', '--no-tags', '--depth=1',
      `https://github.com/${repo}.git`, headSha], { cwd: root });
    run(git, ['--git-dir', gitDir, 'worktree', 'add', '--detach', cwd, headSha], { cwd: root });
    assertHead();
    return { cwd, assertHead, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
