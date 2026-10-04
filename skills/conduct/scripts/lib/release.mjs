// Release recipes: the version bump a recipe asks for, whether the run is
// building the plugin that runs it, where the installed plugin lives, and
// whether a release may run at all. The recipe itself is resolved and
// validated by lib/recipe.mjs (WP-01); this module only reads it.
import { join } from 'node:path';
import { ConductError } from './state.mjs';
import { validateRecipe } from './recipe.mjs';

const BUMP = { patch: 2, minor: 1, major: 0 };

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const [x, y] = [parseVersion(a) ?? [-1, -1, -1], parseVersion(b) ?? [-1, -1, -1]];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// A dot path whose numeric segments index arrays: `plugins.0.version`.
function atPath(object, jsonPath) {
  return jsonPath.split('.').reduce((value, key) => (value == null ? undefined : value[/^\d+$/.test(key) ? Number(key) : key]), object);
}

export function bumpPlan(recipe, { read, repoPath = null }) {
  const checked = validateRecipe(recipe);
  if (!checked.ok) throw new ConductError(2, `invalid release recipe: ${checked.problems.join('; ')}`);
  const current = recipe.bump.map(({ file, jsonPath }) => {
    let text;
    try {
      text = read(repoPath ? join(repoPath, file) : file);
    } catch (error) {
      throw new ConductError(2, `bump file ${file} cannot be read: ${error.message}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ConductError(2, `bump file ${file} is not valid JSON: ${error.message}`);
    }
    return { file, jsonPath, from: atPath(json, jsonPath) };
  });
  const bad = current.find((entry) => !parseVersion(entry.from));
  if (bad) throw new ConductError(2, `${bad.file} ${bad.jsonPath} is not a version: ${bad.from}`);
  const versions = [...new Set(current.map((entry) => entry.from))];
  if (versions.length !== 1) throw new ConductError(2, `the bump files disagree: ${current.map((entry) => `${entry.file} ${entry.jsonPath}=${entry.from}`).join(', ')}`);
  const parts = parseVersion(versions[0]);
  const at = BUMP[recipe.level];
  const to = parts.map((n, i) => (i < at ? n : i === at ? n + 1 : 0)).join('.');
  return { from: versions[0], to, edits: current.map((entry) => ({ ...entry, to })) };
}

function ownerName(url) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

// The run builds the plugin running it when the target repo is the plugin's
// homepage repo. An unreadable plugin.json is not self-hosted.
export function selfHosted({ repoRemote, pluginRoot, read }) {
  let homepage;
  try {
    homepage = JSON.parse(read(join(pluginRoot, '.claude-plugin', 'plugin.json'))).homepage;
  } catch {
    return false;
  }
  const plugin = ownerName(homepage);
  return plugin !== null && plugin === String(repoRemote).toLowerCase();
}

// The installPath the session uses for the plugin key, or null: among the
// user-scope entries and the project/local entries of `projectPath`, the most
// specific scope wins (local > project > user), then the highest version. An
// entry with no scope (the legacy shape) is user scope. The caller supplies
// `projectPath` (WP-06: the run's repo path). Paths compare case-sensitively
// on Linux and case-folded on Windows and macOS.
const SCOPE_RANK = { local: 3, project: 2, user: 1 };
const norm = (path, platform) => {
  const p = String(path ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
};
export function resolvePluginRoot({ installedPluginsPath, pluginKey = 'workit@workit', projectPath = null, read, env = {}, platform = process.platform }) {
  let path = installedPluginsPath;
  if (!path) {
    const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
    if (!home) throw new ConductError(2, `no ${platform === 'win32' ? 'USERPROFILE' : 'HOME'} to find installed_plugins.json under`);
    path = join(home, '.claude', 'plugins', 'installed_plugins.json');
  }
  let entries;
  try {
    entries = JSON.parse(read(path)).plugins?.[pluginKey] ?? [];
  } catch (error) {
    throw new ConductError(2, `${path} cannot be read: ${error.message}`);
  }
  const scoped = entries.map((entry) => ({ ...entry, scope: entry.scope ?? 'user' }));
  const applies = (entry) => entry.scope === 'user' || (SCOPE_RANK[entry.scope] && projectPath && norm(entry.projectPath, platform) === norm(projectPath, platform));
  const best = scoped.filter(applies).sort((a, b) => (SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]) || compareVersions(b.version, a.version))[0];
  return best?.installPath ?? null;
}

// A release runs only after a complete build, with a recipe and the authority.
export function releaseEligible(state) {
  const wps = state.wps ?? [];
  if (!state.intent?.release) return { ok: false, reason: 'no recipe' };
  if (wps.some((wp) => wp.state === 'held')) return { ok: false, reason: 'held' };
  if (wps.some((wp) => ['blocked', 'deferred', 'refuted'].includes(wp.state))) return { ok: false, reason: 'incomplete build' };
  if (state.authority?.release !== true) return { ok: false, reason: 'no release authority' };
  if (wps.length === 0 || !wps.every((wp) => wp.state === 'merged')) return { ok: false, reason: 'incomplete build' };
  return { ok: true, reason: null };
}
