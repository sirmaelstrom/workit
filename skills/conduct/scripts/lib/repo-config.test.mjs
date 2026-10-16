import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AGENTS_LANE_FROM, LEGACY_LANE_FROM, analysisLine, configLine, laneSuiteFrom, pinnedConfig, resolveRepoConfig, workspaceConfigPath,
} from './repo-config.mjs';
import { sectionText } from './markdown.mjs';

const ROOT = resolve('/ws');
const REPO = join(ROOT, 'projects', 'repo');
const WS_FILE = join(ROOT, 'data', 'config', 'conduct', 'o', 'r.json');
const LEGACY = join(REPO, '.workit', 'conduct.json');

function disk(files) {
  return {
    exists: (path) => Object.hasOwn(files, path) || [join(ROOT, 'projects'), join(ROOT, 'data')].includes(path),
    read: (path) => {
      if (Object.hasOwn(files, path)) return files[path];
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
  };
}

test('workspaceConfigPath: WORKIT_WORKSPACE_ROOT, else the workspace ancestor; null without a root or for a remote that is not owner/name', () => {
  const { exists } = disk({});
  assert.equal(workspaceConfigPath({ remote: 'o/r', repoPath: REPO, env: {}, exists }), WS_FILE);
  const elsewhere = resolve('/elsewhere');
  assert.equal(workspaceConfigPath({ remote: 'o/r', repoPath: REPO, env: { WORKIT_WORKSPACE_ROOT: elsewhere }, exists }), join(elsewhere, 'data', 'config', 'conduct', 'o', 'r.json'));
  assert.equal(workspaceConfigPath({ remote: 'o/r', repoPath: REPO, env: {}, exists: () => false }), null);
  for (const remote of ['o', 'o/r/x', '../r', 'o/..', 'o/r r', '', null]) {
    assert.equal(workspaceConfigPath({ remote, repoPath: REPO, env: {}, exists }), null, String(remote));
  }
});

test('resolveRepoConfig: workspace wins and is hashed and parsed; the legacy file is hashed only; neither is none', () => {
  const text = JSON.stringify({ contractPaths: ['a/**'], gateBackground: true });
  const both = resolveRepoConfig({ remote: 'o/r', repoPath: REPO, env: {}, ...disk({ [WS_FILE]: text, [LEGACY]: '{"laneSuite":"x"}' }) });
  assert.deepEqual(both, { source: 'workspace', path: WS_FILE, workspacePath: WS_FILE, sha256: createHash('sha256').update(text).digest('hex'), config: JSON.parse(text) });
  const legacy = resolveRepoConfig({ remote: 'o/r', repoPath: REPO, env: {}, ...disk({ [LEGACY]: 'not even json' }) });
  assert.deepEqual(legacy, { source: 'repo', path: LEGACY, workspacePath: WS_FILE, sha256: createHash('sha256').update('not even json').digest('hex'), config: null });
  assert.deepEqual(resolveRepoConfig({ remote: 'o/r', repoPath: REPO, env: {}, ...disk({}) }), { source: 'none', path: null, workspacePath: WS_FILE, sha256: null, config: null });
});

test('resolveRepoConfig: an invalid workspace file is a ConductError(2) naming every problem', () => {
  const bad = { laneSuite: 'x', bogus: 1, trivialExclude: [''], gateBackground: 'yes', laneEstimateUsd: -1 };
  assert.throws(() => resolveRepoConfig({ remote: 'o/r', repoPath: REPO, env: {}, ...disk({ [WS_FILE]: JSON.stringify(bad) }) }), (error) => {
    assert.equal(error.code, 2);
    for (const part of ['laneSuite is lane-facing text', 'unknown key: bogus', 'trivialExclude must be', 'gateBackground must be', 'laneEstimateUsd must be']) {
      assert.ok(error.message.includes(part), `${part}: ${error.message}`);
    }
    return true;
  });
  assert.throws(() => resolveRepoConfig({ remote: 'o/r', repoPath: REPO, env: {}, ...disk({ [WS_FILE]: '[]' }) }), /must be a JSON object/);
});

test('sectionText: the first ## or ### heading by title, case ignored, up to the next heading; fenced headings are text', () => {
  const doc = [
    '# Lane suite', 'level one is not it', '',
    '```', '## Lane suite', 'fenced, not a heading', '```',
    '## LANE SUITE', '', 'Run npm test', '  then e2e.', '',
    '```sh', '## not a heading', '```',
    '### Details', 'stop here', '## Lane suite', 'second one ignored',
  ].join('\n');
  assert.equal(sectionText(doc, 'Lane suite'), 'Run npm test then e2e. ## not a heading');
  assert.equal(sectionText('### Lane suite\nthree\n', 'lane suite'), 'three');
  assert.equal(sectionText('#### Lane suite\nfour\n', 'Lane suite'), null);
  assert.equal(sectionText('## Lane suite\n\n## Next\n', 'Lane suite'), null);
  assert.equal(sectionText('## Lane suite ##\r\nclosed atx\r\n', 'Lane suite'), 'closed atx');
  // Council round 1: indented ATX, a BOM, setext headings and thematic breaks.
  assert.equal(sectionText('   ## Lane suite\nindented\n', 'Lane suite'), 'indented');
  assert.equal(sectionText('    ## Lane suite\nfour spaces is code\n', 'Lane suite'), null);
  assert.equal(sectionText('﻿## Lane suite\nbom\n', 'Lane suite'), 'bom');
  assert.equal(sectionText('Lane suite\n----------\nsetext body\n\nCommit policy\n=============\nnot this\n', 'Lane suite'), 'setext body');
  assert.equal(sectionText('## Lane suite\nmine\n\nOther section\n---\npolicy text\n', 'Lane suite'), 'mine');
  assert.equal(sectionText('## Lane suite\nmine\n\n***\n\nafter a break\n', 'Lane suite'), 'mine');
  assert.equal(sectionText('## Lane suite\nmine\n\n---\n\nafter a break\n', 'Lane suite'), 'mine');
  assert.equal(sectionText('## Lane suite\n```\n---\n## x\n```\nafter the fence\n', 'Lane suite'), '--- ## x after the fence');
});

test('laneSuiteFrom: AGENTS.md first, the legacy laneSuite second, else null', () => {
  assert.deepEqual(laneSuiteFrom({ agentsText: '## Lane suite\nA\n', legacyConfig: { laneSuite: 'L' } }), { text: 'A', from: AGENTS_LANE_FROM });
  assert.deepEqual(laneSuiteFrom({ agentsText: '## Other\nA\n', legacyConfig: { laneSuite: 'L' } }), { text: 'L', from: LEGACY_LANE_FROM });
  assert.equal(laneSuiteFrom({ agentsText: null, legacyConfig: { laneSuite: '  ' } }), null);
  assert.equal(laneSuiteFrom({ agentsText: null, legacyConfig: {} }), null);
});

test('pinnedConfig, configLine and analysisLine by source; a run without the record reads as before', () => {
  const ws = { source: 'workspace', path: WS_FILE, workspacePath: WS_FILE, sha256: 'b'.repeat(64), config: { contractPaths: [] } };
  const repo = { source: 'repo', path: LEGACY, workspacePath: WS_FILE, sha256: 'c'.repeat(64), config: null };
  const state = (repoConfig, laneSuiteFromValue) => ({ intent: { repo: { remote: 'o/r' }, ...(repoConfig ? { repoConfig } : {}) }, build: { laneSuiteFrom: laneSuiteFromValue } });
  assert.deepEqual(pinnedConfig(state(ws)), { contractPaths: [] });
  assert.equal(pinnedConfig(state(repo)), null);
  assert.equal(pinnedConfig(state(null)), null);
  assert.equal(pinnedConfig({}), null);

  assert.equal(configLine(ws), `Repo config: ${WS_FILE}, sha256 ${'b'.repeat(64)} (pinned for this run)`);
  assert.equal(configLine(repo), 'Repo config: .workit/conduct.json in the repo (deprecated location), sha256 cccccccccccc');
  assert.equal(configLine({ ...repo, sha256: null }), 'Repo config: .workit/conduct.json in the repo (deprecated location)');
  assert.equal(configLine({ source: 'none', workspacePath: WS_FILE }), `Repo config: none (no ${WS_FILE}, no .workit/conduct.json)`);
  assert.equal(configLine({ source: 'none', workspacePath: null }), 'Repo config: none (no workspace root found, no .workit/conduct.json)');
  assert.equal(configLine(undefined), null);

  assert.equal(analysisLine(state(ws, AGENTS_LANE_FROM)), `- repo config: ${WS_FILE}, sha256 ${'b'.repeat(64)}, pinned at intake; laneSuite from ${AGENTS_LANE_FROM}`);
  assert.match(analysisLine(state(ws, LEGACY_LANE_FROM)), /pinned at intake; laneSuite from `\.workit\/conduct\.json` laneSuite\. Deprecated location for laneSuite \(it still works\)/);
  assert.match(analysisLine(state(repo, null)), /^- repo config: \.workit\/conduct\.json in the product repo\. Deprecated location \(it still works\): move its conduct-only keys to .*r\.json and move laneSuite/);
  assert.equal(analysisLine(state({ source: 'none', workspacePath: null }, null)), '- repo config: none (looked for <workspace>/data/config/conduct/o/r.json and .workit/conduct.json)');
  assert.equal(analysisLine(state(null, null)), '- repo config: not recorded (the run predates the workspace config), so .workit/conduct.json was read as before. Deprecated location (it still works): move its conduct-only keys to <workspace>/data/config/conduct/o/r.json and move laneSuite to the repo\'s AGENTS.md under "## Lane suite".');
});

test('workspaceConfigProblems: a present release is a full recipe; null and a bad recipe are refused', async () => {
  const { workspaceConfigProblems } = await import('./repo-config.mjs');
  const recipe = { bump: [{ file: 'p.json', jsonPath: 'version' }], level: 'patch', pr: true, after: [], verify: ['node --test'] };
  assert.deepEqual(workspaceConfigProblems({ release: recipe }), []);
  assert.deepEqual(workspaceConfigProblems({}), []);
  assert.match(workspaceConfigProblems({ release: null }).join(), /release: recipe must be a JSON object/);
  assert.match(workspaceConfigProblems({ release: { ...recipe, level: 'huge' } }).join(), /release: level must be patch, minor or major/);
});
