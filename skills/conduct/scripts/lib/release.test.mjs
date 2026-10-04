import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpPlan, selfHosted, resolvePluginRoot, releaseEligible } from './release.mjs';
import { validateRecipe } from './recipe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const FIXTURES = join(HERE, '..', '__fixtures__', 'land');
const CONFIG = JSON.parse(readFileSync(join(REPO, '.workit', 'conduct.json'), 'utf8'));

// An in-memory file table; any other read is ENOENT.
function files(table) {
  return (path) => {
    if (Object.hasOwn(table, path)) return table[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
}

const PLUGIN = (version) => JSON.stringify({ name: 'workit', version, homepage: 'https://github.com/sirmaelstrom/workit' });
const MARKET = (version) => JSON.stringify({ name: 'workit', plugins: [{ name: 'workit', version }] });

test('validateRecipe accepts the release value of .workit/conduct.json and refuses it with pr: false (D19.14)', () => {
  assert.deepEqual(validateRecipe(CONFIG.release), { ok: true, problems: [] });
  assert.ok(Array.isArray(CONFIG.contractPaths) && typeof CONFIG.laneSuite === 'string');
  const refused = validateRecipe({ ...CONFIG.release, pr: false });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join(), /pr must be true/);
});

test('bumpPlan: 1.27.17 → 1.27.18 in both files; refuses when they disagree', () => {
  const read = files({ [join('/repo', '.claude-plugin', 'plugin.json')]: PLUGIN('1.27.17'), [join('/repo', '.claude-plugin', 'marketplace.json')]: MARKET('1.27.17') });
  assert.deepEqual(bumpPlan(CONFIG.release, { read, repoPath: '/repo' }), {
    from: '1.27.17', to: '1.27.18',
    edits: [
      { file: '.claude-plugin/plugin.json', jsonPath: 'version', from: '1.27.17', to: '1.27.18' },
      { file: '.claude-plugin/marketplace.json', jsonPath: 'plugins.0.version', from: '1.27.17', to: '1.27.18' },
    ],
  });
  const minor = bumpPlan({ ...CONFIG.release, level: 'minor' }, { read, repoPath: '/repo' });
  assert.equal(minor.to, '1.28.0');
  const disagree = files({ [join('/repo', '.claude-plugin', 'plugin.json')]: PLUGIN('1.27.17'), [join('/repo', '.claude-plugin', 'marketplace.json')]: MARKET('1.27.16') });
  assert.throws(() => bumpPlan(CONFIG.release, { read: disagree, repoPath: '/repo' }), /the bump files disagree/);
  assert.throws(() => bumpPlan({ ...CONFIG.release, pr: false }, { read, repoPath: '/repo' }), /invalid release recipe/);
});

test('selfHosted: the repo is the plugin homepage repo', () => {
  const read = files({ [join('/plugin', '.claude-plugin', 'plugin.json')]: PLUGIN('1.27.17') });
  assert.equal(selfHosted({ repoRemote: 'sirmaelstrom/workit', pluginRoot: '/plugin', read }), true);
  assert.equal(selfHosted({ repoRemote: 'heathdev-me/observatory', pluginRoot: '/plugin', read }), false);
  assert.equal(selfHosted({ repoRemote: 'sirmaelstrom/workit', pluginRoot: '/elsewhere', read }), false);
});

test('resolvePluginRoot: the highest-version installPath; the default path comes from the injected env', () => {
  const real = (name) => readFileSync(join(FIXTURES, name), 'utf8');
  const read = files({ '/after.json': real('installed-plugins-after.json'), '/before.json': real('installed-plugins-before.json') });
  assert.equal(resolvePluginRoot({ installedPluginsPath: '/after.json', read }), '<home>/.claude/plugins/cache/workit/workit/1.27.18');
  assert.equal(resolvePluginRoot({ installedPluginsPath: '/before.json', read }), '<home>/.claude/plugins/cache/workit/workit/1.27.17');
  const win = join('/profile', '.claude', 'plugins', 'installed_plugins.json');
  const posix = join('/home', '.claude', 'plugins', 'installed_plugins.json');
  const home = files({ [win]: real('installed-plugins-after.json'), [posix]: real('installed-plugins-before.json') });
  const env = { USERPROFILE: '/profile', HOME: '/home' };
  assert.match(resolvePluginRoot({ read: home, env, platform: 'win32' }), /1\.27\.18$/);
  assert.match(resolvePluginRoot({ read: home, env, platform: 'linux' }), /1\.27\.17$/);
  assert.equal(resolvePluginRoot({ installedPluginsPath: '/after.json', pluginKey: 'other@x', read }), null);
});

const wp = (state) => ({ id: 'WP', state });
const run = (over = {}) => ({ intent: { release: CONFIG.release }, authority: { release: true }, wps: [wp('merged'), wp('merged')], ...over });

test('releaseEligible (D19.10): complete build + recipe + authority; otherwise the first reason in order', () => {
  assert.deepEqual(releaseEligible(run()), { ok: true, reason: null });
  assert.deepEqual(releaseEligible(run({ wps: [wp('merged'), wp('blocked')] })), { ok: false, reason: 'incomplete build' });
  assert.deepEqual(releaseEligible(run({ wps: [wp('merged'), wp('held')] })), { ok: false, reason: 'held' });
  assert.deepEqual(releaseEligible(run({ intent: { release: null } })), { ok: false, reason: 'no recipe' });
  assert.deepEqual(releaseEligible(run({ authority: { release: false } })), { ok: false, reason: 'no release authority' });
  assert.deepEqual(releaseEligible(run({ wps: [wp('merged'), wp('gate')] })), { ok: false, reason: 'incomplete build' });
  assert.deepEqual(releaseEligible(run({ wps: [wp('held'), wp('blocked')], authority: { release: false } })), { ok: false, reason: 'held' });
});
