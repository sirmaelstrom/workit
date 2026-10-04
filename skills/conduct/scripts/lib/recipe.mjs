// Release recipes: resolved and validated at intake, so touch 1 shows the
// exact commands the release phase will run. WP-03's release.mjs imports these.
import { join } from 'node:path';
import { ConductError } from './state.mjs';

const RECIPE_KEYS = ['bump', 'level', 'pr', 'after', 'verify'];

function readJson(path, read, label) {
  let text;
  try {
    text = read(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new ConductError(2, `${label} ${path} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConductError(2, `${label} ${path} is not valid JSON: ${error.message}`);
  }
}

// --release file > <repo>/.workit/conduct.json's `release` > null.
export function resolveRecipe({ flagPath, repoPath, read }) {
  if (flagPath) {
    const recipe = readJson(flagPath, read, '--release file');
    if (recipe === undefined) throw new ConductError(2, `--release file ${flagPath} does not exist`);
    return recipe;
  }
  const config = readJson(join(repoPath, '.workit', 'conduct.json'), read, 'repo config');
  return config?.release ?? null;
}

function commandProblems(recipe, key, problems) {
  const list = recipe[key];
  if (!Array.isArray(list) || list.some((command) => typeof command !== 'string' || !command.trim())) {
    problems.push(`${key} must be an array of non-empty command strings`);
    return;
  }
  for (const command of list) {
    if (/['"]/.test(command)) problems.push(`${key} command contains a quote character (it is split on whitespace, never shell-parsed): ${command}`);
  }
}

export function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return { ok: false, problems: ['recipe must be a JSON object'] };
  const problems = [];
  for (const key of Object.keys(recipe)) if (!RECIPE_KEYS.includes(key)) problems.push(`unknown key: ${key}`);
  for (const key of RECIPE_KEYS) if (!Object.hasOwn(recipe, key)) problems.push(`missing key: ${key}`);
  if (Object.hasOwn(recipe, 'bump')) {
    const bump = recipe.bump;
    const entryOk = (entry) => entry && typeof entry === 'object'
      && typeof entry.file === 'string' && entry.file && typeof entry.jsonPath === 'string' && entry.jsonPath;
    if (!Array.isArray(bump) || bump.length === 0 || !bump.every(entryOk)) problems.push('bump must be a non-empty array of { file, jsonPath }');
  }
  if (Object.hasOwn(recipe, 'level') && !['patch', 'minor', 'major'].includes(recipe.level)) problems.push('level must be patch, minor or major');
  if (Object.hasOwn(recipe, 'pr') && recipe.pr !== true) problems.push('pr must be true (a release without a PR is refused in v1)');
  for (const key of ['after', 'verify']) if (Object.hasOwn(recipe, key)) commandProblems(recipe, key, problems);
  return { ok: problems.length === 0, problems };
}

export function recipeArgv(command) {
  return command.trim().split(/\s+/);
}
