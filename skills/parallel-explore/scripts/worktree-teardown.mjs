// Removes a git worktree without deleting through a link inside it.
//
// Git for Windows before 2.54 deleted a junction's target contents on
// `git worktree remove`; 2.54 and later skip the junction but leave the
// directory on disk and still exit 0. Every link is unlinked first, without
// entering it, so no delete can follow one. Whether the worktree is gone is
// read from the filesystem, never from git's exit code.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const hasEntries = (dir) => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

// Every link (symlink or junction) under root. A link is listed, never entered.
export function findLinks(root) {
  const links = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // lstat as well: a junction must never be read as a plain directory.
      if (entry.isSymbolicLink() || (entry.isDirectory() && lstatSync(path).isSymbolicLink())) links.push(path);
      else if (entry.isDirectory()) pending.push(path);
    }
  }
  return links;
}

// Unlinks every link under root. Returns null, or why the worktree must stay.
// A target that had entries and has none afterwards means something followed
// the link.
export function unlinkAll(root) {
  try {
    if (lstatSync(root).isSymbolicLink()) return `${root} is itself a link`;
  } catch (error) {
    return `could not read ${root}: ${error.message}`;
  }
  let links;
  try {
    links = findLinks(root);
  } catch (error) {
    return `could not scan ${root} for links: ${error.message}`;
  }
  for (const link of links) {
    let target = null;
    try {
      target = resolve(dirname(link), readlinkSync(link));
    } catch {
      // A link whose target can't be read has nothing to compare.
    }
    const had = target !== null && hasEntries(target);
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch (error) {
        return `could not unlink ${link}: ${error.message}`;
      }
    }
    if (present(link)) return `${link} remains after unlinking`;
    if (had && !hasEntries(target)) return `the target of ${link} (${target}) is empty after unlinking`;
  }
  return null;
}

const runGit = (repo) => (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

// Returns { removed: true } or { removed: false, reason }; it never throws, so
// a caller removing several worktrees reaches every one.
export function removeWorktree(repo, worktree, { git = runGit(repo), rm = rmSync } = {}) {
  if (!present(worktree)) return { removed: true };
  const blocked = unlinkAll(worktree);
  if (blocked) return { removed: false, reason: blocked };
  try {
    git(['worktree', 'remove', '--force', worktree]);
  } catch (error) {
    const said = String(error.stderr ?? error.message).trim();
    // An earlier call can leave the directory after git unregistered it; the
    // retry finishes the delete below instead of stopping at git's refusal.
    if (!/is not a working tree/.test(said)) return { removed: false, reason: `git worktree remove failed: ${said}` };
  }
  if (present(worktree)) {
    // Its links are gone, so what is left is plain files.
    const again = unlinkAll(worktree);
    if (again) return { removed: false, reason: again };
    try {
      // A file still held open (an agent's shell cwd on Windows) refuses here.
      rm(worktree, { recursive: true, force: true });
    } catch (error) {
      return { removed: false, reason: `${worktree} remains after git's removal: ${error.message}` };
    }
    try {
      git(['worktree', 'prune']);
    } catch {
      // The directory is what this function answers for; a stale registration is git's.
    }
  }
  return present(worktree) ? { removed: false, reason: `${worktree} remains after removal` } : { removed: true };
}
