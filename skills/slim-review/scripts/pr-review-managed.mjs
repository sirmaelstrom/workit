/**
 * pr-review-managed.mjs — is this repository coordinated, and where does the
 * answer come from?
 *
 * Two signals, one directory, resolved from the user profile and nothing else:
 *
 *   %USERPROFILE%/.workit/pr-review/coordinator-token   the authorization token
 *   %USERPROFILE%/.workit/pr-review/managed.json        { coordinator, repos }
 *
 * The directory is deliberately **root-independent**. The workspace-root lookup
 * this script uses for its measurement log resolves per checkout, so the same
 * repository opened from a second clone or a worktree would answer differently
 * about whether it is coordinated — and the failure mode of answering
 * "standalone" wrongly is a duplicate review posted outside the coordinator.
 * `os.homedir()` answers the same from every directory on the host, which is
 * also why it is the only test seam: it reads USERPROFILE on Windows and HOME
 * on POSIX, so a test spawns the writer with those pointed at a fixture
 * directory. Nothing in this module reads the working directory, and a test
 * asserts that against the source of both modules.
 *
 * Resolution (fail closed — the risk is posting uncoordinated, never refusing):
 *
 *   no token anywhere                → standalone everywhere, behaviour unchanged
 *   token ∧ list absent/unreadable   → managed-config-missing, the writer refuses
 *   token ∧ repo listed              → managed
 *   token ∧ repo not listed          → standalone
 *
 * The token has its own loader, it is read only where it is needed, and it
 * never appears in a resolver result — `managed`'s stdout is printed for an
 * operator and read by a scheduled job, and neither has any use for it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `<home>/.workit/pr-review` — the one managed directory. */
export const MANAGED_DIR_SEGMENTS = Object.freeze(['.workit', 'pr-review']);
export const TOKEN_FILENAME = 'coordinator-token';
export const MANAGED_FILENAME = 'managed.json';
export const TOKEN_ENV_VAR = 'PR_REVIEW_COORDINATOR_TOKEN';

/** The three answers a repository can get. */
export const MANAGED_MODES = Object.freeze({
  standalone: 'standalone',
  managed: 'managed',
  configMissing: 'managed-config-missing',
});

/** The managed directory for a given home. Never depends on the working directory. */
export function managedDirectory({ homeDir = homedir() } = {}) {
  return join(homeDir, ...MANAGED_DIR_SEGMENTS);
}

/**
 * The coordinator token, or null.
 *
 * Precedence is environment then file: the beat hands the token to the writer
 * it spawns, and an interactive session reads the provisioned file. An absent
 * or empty file is no token at all, which is the standalone case — not an
 * error, and not a reason to guess.
 *
 * This function never prints, never logs, and is never called by the resolver.
 */
export function loadCoordinatorToken({ env = process.env, homeDir = homedir() } = {}) {
  const fromEnv = env?.[TOKEN_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  let raw;
  try {
    raw = readFileSync(join(managedDirectory({ homeDir }), TOKEN_FILENAME), 'utf8');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read `managed.json`. Absent, unparseable, or the wrong shape are one answer —
 * `{ok: false}` — because they have one consequence: the writer cannot tell
 * whether this repository is coordinated, so it must refuse rather than post.
 */
export function readManagedList({ homeDir = homedir() } = {}) {
  const file = join(managedDirectory({ homeDir }), MANAGED_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, file };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, file };
  const { coordinator, repos } = parsed;
  if (typeof coordinator !== 'string' || coordinator.trim() === '') return { ok: false, file };
  if (!Array.isArray(repos) || repos.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    return { ok: false, file };
  }
  return { ok: true, file, coordinator: coordinator.trim(), repos: repos.map((entry) => entry.trim()) };
}

/**
 * Resolve one repository against the managed directory.
 *
 * @param {object} options
 * @param {string} options.repo `owner/name`
 * @param {object} [options.env] environment to read the token override from
 * @param {string} [options.homeDir] profile directory (the supported test seam)
 * @returns {{mode: string, directory: string, coordinator?: string, repos?: string[]}}
 *          never a token, at any mode
 */
export function resolveManaged({ repo, env = process.env, homeDir = homedir() } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new TypeError('resolveManaged: repo is required — the answer is per repository');
  }
  const directory = managedDirectory({ homeDir });
  // Token first: with no token anywhere the installation is not the trusted one
  // and every repository is standalone, whatever else is lying in the directory.
  if (loadCoordinatorToken({ env, homeDir }) === null) {
    return { mode: MANAGED_MODES.standalone, directory };
  }
  const list = readManagedList({ homeDir });
  if (!list.ok) return { mode: MANAGED_MODES.configMissing, directory };

  // Matched case-insensitively on purpose. GitHub treats `Owner/Repo` and
  // `owner/repo` as the same repository, and the cost of the two mistakes is
  // not symmetric: a false "managed" refuses until the operator fixes the list,
  // a false "standalone" posts a second review nobody coordinated.
  const wanted = repo.trim().toLowerCase();
  const listed = list.repos.some((entry) => entry.toLowerCase() === wanted);
  return {
    mode: listed ? MANAGED_MODES.managed : MANAGED_MODES.standalone,
    directory,
    coordinator: list.coordinator,
    repos: list.repos,
  };
}
