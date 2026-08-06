#!/usr/bin/env node
// workspace-preamble.mjs — derive environment state at pickup; never transfer it.
//
// The class-E problem (burn-down retro §4): a handoff that writes down "dogan is
// on a feat branch, observatory is mid-work, dist rebuild pending" is stale the
// moment it is written. The next session reads it as fact and acts on a snapshot
// of a world that has moved. The item7 handoff even said so itself — "re-check
// both repos at pickup, the situation may have changed" — which is a written
// admission that the writing was the wrong mechanism.
//
// So: derive it, mechanically, at the moment it is needed. The model does not
// invent a branch name here; it reads one this script measured.
//
// WHY THIS IS NOT THE SESSION-START HOOK (the retro sketched it there):
//   1. That hook is registered in the user's GLOBAL settings and points at a
//      script in another repo. A plugin cannot ship a change to it — a
//      marketplace installer would get nothing. Same failure family as the bare
//      `./outputs/` path: correct on the author's box via ambient config,
//      absent everywhere else.
//   2. It fires in EVERY project on a fail-open ~2s budget. `pm2 jlist` alone
//      routinely eats most of that, for data most sessions never read.
//   3. Decisive: a hook fires once at STARTUP. A burn-down works items for
//      hours, so startup-derived state is stale by item 4. Pickup runs per item.
//
// Usage:
//   node scripts/workspace-preamble.mjs [--workspace-root <abs>] [--all] [--json]
//
// Exit 0 = a report was produced. Exit 2 = nothing was scanned (see below).

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hostname } from 'node:os';

// --- argv --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const SHOW_ALL = flag('--all');
const AS_JSON = flag('--json');

/**
 * Workspace root resolution — the same ladder reference/patterns/worktree-rooting.md
 * mandates for output rooting: explicit arg, then env var, then cwd AND SAY SO.
 * The rule that produced the answer is reported, never left implicit.
 */
function resolveWorkspaceRoot() {
  const explicit = opt('--workspace-root');
  if (explicit) return { root: explicit, via: '--workspace-root' };
  if (process.env.WORKIT_WORKSPACE_ROOT) {
    return { root: process.env.WORKIT_WORKSPACE_ROOT, via: 'WORKIT_WORKSPACE_ROOT' };
  }
  return { root: process.cwd(), via: 'cwd fallback (no --workspace-root, no WORKIT_WORKSPACE_ROOT)' };
}

// --- probes (every one best-effort; a missing tool degrades, never throws) ----

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

const git = (cwd, ...args) => run('git', args, cwd);

/**
 * Shell-resolved run, for tools installed as a Windows shim rather than an .exe.
 *
 * `execFileSync` cannot launch `pm2` on Windows: the installed entry points are
 * `pm2.ps1` / `pm2.cmd`, so a bare name is ENOENT and an explicit `pm2.cmd` is
 * EINVAL (Node refuses to spawn .cmd without a shell). Both surface as "not
 * available on this box" — a FALSE NEGATIVE that renders as a definitive
 * answer, which is worse than no check at all.
 *
 * The command is a fixed literal with no interpolation and no caller input, and
 * `execSync` takes a command string by design — so this avoids DEP0190, which
 * fires only when an ARGS ARRAY is concatenated under `shell: true`.
 */
function runShell(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function readGitState(repo) {
  // `rev-parse --git-dir` is the cheapest "is this actually a repo" question that
  // does not mistake a plain directory containing a `.git` FILE (a linked
  // worktree) for a non-repo.
  if (git(repo, 'rev-parse', '--git-dir') === null) return null;

  const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') ?? '(unknown)';
  const status = git(repo, 'status', '--porcelain') ?? '';
  const dirty = status === '' ? 0 : status.split(/\r?\n/).filter(Boolean).length;

  // Ahead/behind vs upstream. No upstream is a normal state, not an error.
  let ahead = null;
  let behind = null;
  const counts = git(repo, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD');
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ahead = a;
      behind = b;
    }
  }

  // Linked worktrees beyond the main checkout — the "occupied checkout" signal.
  const wtList = git(repo, 'worktree', 'list', '--porcelain') ?? '';
  const worktrees = wtList
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => basename(p) !== basename(repo));

  return { branch, dirty, ahead, behind, worktrees };
}

/** Default-branch guess, used only to decide whether a branch is worth reporting. */
function isDefaultBranch(name) {
  return name === 'main' || name === 'master';
}

function scanRepos(workspaceRoot) {
  const projectsDir = join(workspaceRoot, 'projects');
  if (!existsSync(projectsDir)) return { projectsDir, repos: [], missing: true };

  const repos = [];
  for (const ent of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const path = join(projectsDir, ent.name);
    // A linked worktree keeps `.git` as a FILE, so test existence, not type.
    if (!existsSync(join(path, '.git'))) continue;
    const state = readGitState(path);
    if (state) repos.push({ name: ent.name, path, ...state });
  }
  return { projectsDir, repos, missing: false };
}

/**
 * Plugin-cache freshness. This is the check that mechanizes the run's most
 * repeatedly-owed operator step: the repo ships a version, the cache installs
 * one, and a `/reload-plugins` that never happened leaves the model invoking
 * skills from an older cache with no visible symptom.
 */
function pluginFreshness(workspaceRoot) {
  const repoManifest = join(workspaceRoot, 'projects', 'workit', '.claude-plugin', 'plugin.json');
  let repoVersion = null;
  if (existsSync(repoManifest)) {
    try {
      repoVersion = JSON.parse(readFileSync(repoManifest, 'utf8')).version ?? null;
    } catch {
      repoVersion = null;
    }
  }

  const home = process.env.USERPROFILE || process.env.HOME;
  const cacheDir = home ? join(home, '.claude', 'plugins', 'cache', 'workit', 'workit') : null;
  let installed = [];
  if (cacheDir && existsSync(cacheDir)) {
    try {
      installed = readdirSync(cacheDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      installed = [];
    }
  }

  const newestInstalled = installed.length > 0 ? installed.slice().sort(cmpSemver).at(-1) : null;
  const stale = Boolean(repoVersion && newestInstalled && cmpSemver(newestInstalled, repoVersion) < 0);
  return { repoVersion, installed, newestInstalled, stale, cacheDir };
}

/** Numeric semver compare; non-numeric segments sort as 0 rather than throwing. */
function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** pm2, if this box runs it at all. Absence is a normal answer, not a failure. */
function readServices() {
  const raw = runShell('pm2 jlist');
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    // Deliberately field-selected. `pm2 jlist` carries each process's full
    // environment — secrets included — so this must never round-trip whole.
    return list.map((p) => ({
      name: p.name,
      status: p.pm2_env?.status ?? 'unknown',
      restarts: p.pm2_env?.restart_time ?? 0,
    }));
  } catch {
    return null;
  }
}

// --- render ------------------------------------------------------------------

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function repoIsNotable(r) {
  return (
    r.dirty > 0 ||
    !isDefaultBranch(r.branch) ||
    r.worktrees.length > 0 ||
    (r.ahead ?? 0) > 0 ||
    (r.behind ?? 0) > 0
  );
}

function render({ rootInfo, scan, plugin, services, stamp, host }) {
  const lines = [];
  lines.push(`WORKSPACE PREAMBLE — derived ${stamp} on ${host}`);
  lines.push(`workspace root: ${rootInfo.root}  [via ${rootInfo.via}]`);
  lines.push('');

  // -- checkouts
  if (scan.missing) {
    lines.push(`CHECKOUTS — none scanned: ${scan.projectsDir} does not exist`);
  } else {
    const notable = SHOW_ALL ? scan.repos : scan.repos.filter(repoIsNotable);
    const quiet = scan.repos.length - notable.length;
    lines.push(`CHECKOUTS — ${scan.repos.length} repo(s) scanned, ${notable.length} notable`);
    if (notable.length === 0) {
      lines.push('  (all clean, on a default branch, no extra worktrees)');
    } else {
      const w = Math.max(4, ...notable.map((r) => r.name.length));
      const bw = Math.max(6, ...notable.map((r) => r.branch.length));
      lines.push(`  ${pad('REPO', w)}  ${pad('BRANCH', bw)}  DIRTY  AHEAD/BEHIND  WORKTREES`);
      for (const r of notable) {
        const ab = r.ahead === null ? 'no upstream' : `+${r.ahead}/-${r.behind}`;
        const wt = r.worktrees.length === 0 ? '-' : String(r.worktrees.length);
        lines.push(
          `  ${pad(r.name, w)}  ${pad(r.branch, bw)}  ${pad(r.dirty === 0 ? 'clean' : r.dirty, 5)}  ${pad(ab, 12)}  ${wt}`,
        );
      }
      for (const r of notable.filter((x) => x.worktrees.length > 0)) {
        for (const wt of r.worktrees) lines.push(`    ${r.name} worktree: ${wt}`);
      }
    }
    // Suppressed rows are counted out loud: a report that silently hides most of
    // what it saw reads as "everything is fine" when it means "I did not say".
    if (!SHOW_ALL && quiet > 0) {
      lines.push(`  (+${quiet} clean on a default branch — re-run with --all to list them)`);
    }
  }
  lines.push('');

  // -- plugin cache
  lines.push('PLUGIN CACHE');
  if (!plugin.repoVersion && plugin.installed.length === 0) {
    lines.push('  workit: not resolvable (no repo manifest, no cache dir) — not checked');
  } else {
    const repoV = plugin.repoVersion ?? '(unknown)';
    const instV = plugin.newestInstalled ?? '(none installed)';
    const verdict = plugin.stale
      ? '← STALE: repo is ahead of the cache; /reload-plugins is OWED'
      : plugin.repoVersion && plugin.newestInstalled
        ? '← current'
        : '← indeterminate';
    lines.push(`  workit  repo ${repoV}  newest-installed ${instV}  ${verdict}`);
  }
  lines.push('');

  // -- services
  lines.push('SERVICES (pm2)');
  if (services === null) {
    lines.push('  pm2 not available on this box — not checked');
  } else if (services.length === 0) {
    lines.push('  pm2 present, no processes registered');
  } else {
    const w = Math.max(4, ...services.map((s) => s.name.length));
    for (const s of services) {
      lines.push(`  ${pad(s.name, w)}  ${pad(s.status, 9)}  restarts ${s.restarts}`);
    }
  }

  return lines.join('\n');
}

// --- main --------------------------------------------------------------------

const rootInfo = resolveWorkspaceRoot();
const scan = scanRepos(rootInfo.root);
const plugin = pluginFreshness(rootInfo.root);
const services = readServices();
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const host = hostname();

const report = { rootInfo, scan, plugin, services, stamp, host };

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(render(report));
}

// A preamble that scanned nothing is the dangerous case: it renders as a clean
// board and reads as "no occupied checkouts". Give that its own exit code so it
// cannot be mistaken for a quiet, healthy workspace.
if (scan.repos.length === 0) {
  console.error(
    `\n✖ scanned no repositories under ${scan.projectsDir} — this is "did not run", NOT "all clean".` +
      `\n  Pass --workspace-root <abs> or set WORKIT_WORKSPACE_ROOT to the directory containing projects/.`,
  );
  process.exit(2);
}
process.exit(0);
