// Where a target repo's /conduct config lives (quest e2b54cd3, ruled
// 2026-10-06: the split). Conduct-only keys live in the workspace, keyed by
// the repo's GitHub identity, at <workspace>/data/config/conduct/<owner>/<repo>.json,
// so workflow tooling stays out of a repo meant to go public. The lane-facing
// text (laneSuite) lives in the repo's AGENTS.md under a `## Lane suite`
// heading, where every lane agent already reads.
//
// Intake reads the workspace file once and pins it: its parsed keys go into
// state.intent.repoConfig and its sha256 onto touch 1 (the anchor receipt with
// the Spine adapter), and the build and the land gate read only that snapshot,
// so an edit to the workspace file after intake does not reach this run.
//
// A repo that still carries .workit/conduct.json and has no workspace file
// keeps today's behaviour exactly (source 'repo'): the build reads the
// checkout's file and the land gate reads origin/<default>'s. The run analysis
// names that location as deprecated.
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ConductError, workspaceAncestor } from './state.mjs';
import { sectionText } from './markdown.mjs';

export const WORKSPACE_KEYS = Object.freeze(['release', 'contractPaths', 'trivialExclude', 'gateEnv', 'gateBackground', 'laneEstimateUsd']);
export const LEGACY_RELPATH = '.workit/conduct.json';
export const LANE_SUITE_HEADING = 'Lane suite';
const NAME = /^[A-Za-z0-9._-]+$/;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The workspace root is WORKIT_WORKSPACE_ROOT, else the nearest ancestor of
// the repo holding both projects/ and data/ (the run-dir rule, lib/state.mjs).
// null when there is no workspace root or the remote is not owner/name.
export function workspaceConfigPath({ remote, repoPath, env = {}, exists }) {
  const root = env.WORKIT_WORKSPACE_ROOT ? resolve(env.WORKIT_WORKSPACE_ROOT) : workspaceAncestor(repoPath, exists);
  const parts = String(remote ?? '').split('/');
  if (!root || parts.length !== 2 || !parts.every((part) => NAME.test(part) && part !== '.' && part !== '..')) return null;
  return join(root, 'data', 'config', 'conduct', parts[0], `${parts[1]}.json`);
}

function readText(path, read, label) {
  try {
    return read(path);
  } catch (error) {
    throw new ConductError(2, `${label} ${path} cannot be read: ${error.message}`);
  }
}

const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());

export function workspaceConfigProblems(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['it must be a JSON object'];
  const problems = [];
  for (const key of Object.keys(config)) {
    if (key === 'laneSuite') problems.push(`laneSuite is lane-facing text: put it in the repo's AGENTS.md under a "## ${LANE_SUITE_HEADING}" heading`);
    else if (!WORKSPACE_KEYS.includes(key)) problems.push(`unknown key: ${key} (known: ${WORKSPACE_KEYS.join(', ')})`);
  }
  for (const key of ['contractPaths', 'trivialExclude']) {
    if (Object.hasOwn(config, key) && !isStrings(config[key])) problems.push(`${key} must be an array of non-empty glob strings`);
  }
  const env = config.gateEnv;
  if (Object.hasOwn(config, 'gateEnv') && (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string'))) {
    problems.push('gateEnv must be an object of string values');
  }
  if (Object.hasOwn(config, 'gateBackground') && typeof config.gateBackground !== 'boolean') problems.push('gateBackground must be true or false');
  const estimate = config.laneEstimateUsd;
  if (Object.hasOwn(config, 'laneEstimateUsd') && (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0)) {
    problems.push('laneEstimateUsd must be a non-negative number');
  }
  return problems;
}

// At intake: { source: 'workspace' | 'repo' | 'none', path, workspacePath,
// sha256, config }. `config` is the parsed workspace file (source
// 'workspace' only); a legacy file is hashed here and parsed where it is used,
// as before, so its failures land where they always did. An invalid
// workspace file is exit 2 naming its problems.
export function resolveRepoConfig({ remote, repoPath, env, exists, read }) {
  const workspacePath = workspaceConfigPath({ remote, repoPath, env, exists });
  if (workspacePath && exists(workspacePath)) {
    const text = readText(workspacePath, read, 'workspace conduct config');
    let config;
    try {
      config = JSON.parse(text);
    } catch (error) {
      throw new ConductError(2, `workspace conduct config ${workspacePath} is not valid JSON: ${error.message}`);
    }
    const problems = workspaceConfigProblems(config);
    if (problems.length) throw new ConductError(2, `workspace conduct config ${workspacePath}: ${problems.join('; ')}`);
    return { source: 'workspace', path: workspacePath, workspacePath, sha256: sha256(text), config };
  }
  const legacy = join(repoPath, ...LEGACY_RELPATH.split('/'));
  if (exists(legacy)) {
    // Hashed for the record only: an unreadable file fails where it always did.
    let hash = null;
    try {
      hash = sha256(read(legacy));
    } catch {
      hash = null;
    }
    return { source: 'repo', path: legacy, workspacePath, sha256: hash, config: null };
  }
  return { source: 'none', path: null, workspacePath, sha256: null, config: null };
}

// The pinned workspace config, or null when the run reads the legacy repo file
// (source 'repo' or 'none', or a run that predates this record).
export function pinnedConfig(state) {
  const pinned = state?.intent?.repoConfig;
  return pinned?.source === 'workspace' && pinned.config && typeof pinned.config === 'object' ? pinned.config : null;
}

// The lane-facing laneSuite text: the AGENTS.md section, else the legacy repo
// file's laneSuite (a repo not yet migrated), else null. Returns
// { text, from } so the contract and the analysis can name where it came from.
export const AGENTS_LANE_FROM = `AGENTS.md \`## ${LANE_SUITE_HEADING}\``;
export const LEGACY_LANE_FROM = `\`${LEGACY_RELPATH}\` laneSuite`;

export function laneSuiteFrom({ agentsText, legacyConfig }) {
  const section = agentsText === null || agentsText === undefined ? null : sectionText(agentsText, LANE_SUITE_HEADING);
  if (section) return { text: section, from: AGENTS_LANE_FROM };
  const legacy = legacyConfig?.laneSuite;
  if (typeof legacy === 'string' && legacy.trim()) return { text: legacy, from: LEGACY_LANE_FROM };
  return null;
}

// One line for touch 1's Details. The workspace line carries the full sha256:
// it is the pin the ruling asks to be recorded on the anchor receipt.
export function configLine(pinned) {
  if (!pinned) return null;
  if (pinned.source === 'workspace') return `Repo config: ${pinned.path}, sha256 ${pinned.sha256} (pinned for this run)`;
  if (pinned.source === 'repo') return `Repo config: ${LEGACY_RELPATH} in the repo (deprecated location)${pinned.sha256 ? `, sha256 ${pinned.sha256.slice(0, 12)}` : ''}`;
  return null;
}

// The analysis line, with the deprecation note whenever a key still came from
// the legacy location.
export function analysisLine(state) {
  const pinned = state?.intent?.repoConfig;
  const from = state?.build?.laneSuiteFrom ?? null;
  const lane = from ? `; laneSuite from ${from}` : '';
  const target = pinned?.workspacePath ?? `<workspace>/data/config/conduct/${state?.intent?.repo?.remote ?? '<owner>/<repo>'}.json`;
  const moveLane = `move laneSuite to the repo's AGENTS.md under "## ${LANE_SUITE_HEADING}"`;
  if (!pinned) return `- repo config: not recorded (the run predates the workspace config), so ${LEGACY_RELPATH} was read as before${lane}`;
  if (pinned.source === 'repo') {
    return `- repo config: ${LEGACY_RELPATH} in the product repo${lane}. Deprecated location (it still works): move its conduct-only keys to ${target} and ${moveLane}.`;
  }
  const head = pinned.source === 'workspace'
    ? `- repo config: ${pinned.path}, sha256 ${pinned.sha256}, pinned at intake${lane}`
    : `- repo config: none (looked for ${target} and ${LEGACY_RELPATH})${lane}`;
  return from === LEGACY_LANE_FROM ? `${head}. Deprecated location for laneSuite (it still works): ${moveLane}.` : head;
}
