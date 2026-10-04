import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runConduct } from './conduct.mjs';
import { STEPS, STEP_SEAM, resolveRunDir } from './lib/state.mjs';
import { detectAdapters, laneModel } from './lib/adapters.mjs';
import { resolveRecipe, recipeArgv } from './lib/recipe.mjs';
import { shellArgv, spawnDetached, pidAlive } from './lib/exec.mjs';
import { openTouch, touchAction, recordTouch } from './lib/touch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'intake');
const fixtureJson = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const captured = (name) => {
  const { code, stdout, stderr } = fixtureJson(name);
  return { code, stdout, stderr };
};

// slug `fixture-run` matches the tag in the spine fixtures' questions.
const GOAL = 'fixture run';
const ANCHOR = '93427349';
const ANCHOR_UUID = '93427349-2540-4d97-8437-db3af451caf2';
const ANSWERED_AT = '2026-09-27T15:56:42.000Z';

// Real WP-01 handlers; the build phase (a later WP) is a stub that is done.
const FAKE_BUILD = { next: () => ({ kind: 'done' }), record: () => {} };
function testLoader(relPath) {
  if (relPath === 'lib/phases/build.mjs') return FAKE_BUILD;
  return import(pathToFileURL(join(HERE, relPath)).href);
}
function loaderWith(modules) {
  return (relPath) => (Object.hasOwn(modules, relPath) ? modules[relPath] : testLoader(relPath));
}
function missingLoader() {
  const error = new Error('Cannot find module');
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
}

// A fake executor answering from captured fixtures (pattern: fixture(t) in
// scripts/lane.test.mjs). Tests edit f.table to change one program's answer.
function fixture(t, deps = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-conduct-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const runs = join(dir, 'runs');
  mkdirSync(runs);
  const calls = [];
  const table = {
    [`git -C ${repo} rev-parse --is-inside-work-tree`]: { code: 0, stdout: 'true\n', stderr: '' },
    [`git -C ${repo} config --get remote.origin.url`]: { code: 0, stdout: 'https://github.com/sirmaelstrom/workit.git\n', stderr: '' },
    'gh auth status': captured('gh-auth-status.json'),
    'gh repo view sirmaelstrom/workit --json nameWithOwner,defaultBranchRef': captured('gh-repo-view.json'),
    'gh api repos/sirmaelstrom/workit/actions/workflows': captured('gh-actions-workflows.json'),
    'claude --version': { code: 0, stdout: '2.1.289 (Claude Code)\n', stderr: '' },
    'codex --version': { code: 1, stdout: '', stderr: 'spawnSync codex ENOENT' },
  };
  const exec = (program, args) => {
    const key = [program, ...args].join(' ');
    calls.push(key);
    return table[key] ?? { code: 127, stdout: '', stderr: `unexpected command: ${key}` };
  };
  let clock = Date.parse('2026-10-04T18:00:00.000Z');
  const base = {
    exec, env: {}, platform: 'linux', home: join(dir, 'home'), stdinIsTTY: false, pluginRoot: join(dir, 'plugin'),
    resolveCodex: () => 'codex', now: () => clock, timestamp: () => new Date((clock += 1000)).toISOString(),
    importModule: testLoader, ...deps,
  };
  return { dir, repo, runs, calls, table, deps: base, run: (argv, more = {}) => runConduct(argv, { ...base, ...more }) };
}

const out = (result) => JSON.parse(result.stdout);
const readState = (runDir) => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
const events = (runDir) => readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const SPINE = ['--adapter', 'spine', '--anchor', ANCHOR];

function intake(f, extra = [], more = {}) {
  return f.run(['intake', '--goal', GOAL, '--repo', f.repo, '--runs-root', f.runs, ...extra], more);
}
function record(f, runDir, id, result, more = {}) {
  return f.run(['record', '--run', runDir, '--action', id, '--result', JSON.stringify(result)], more);
}
function answer(f, runDir, key, { text, tty = true } = {}) {
  return f.run(['answer', '--run', runDir, '--touch', '1', '--key', key, ...(text ? ['--text', text] : [])], { stdinIsTTY: tty });
}

// intake → anchor → touch 1 filed; returns the read-back action.
async function toSpineReadBack(f, extra = []) {
  const first = out(await intake(f, [...SPINE, ...extra]));
  const receipt = out(await record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json'))).action;
  const readBack = out(await record(f, first.runDir, receipt.id, { id: 'filed-receipt-uuid' })).action;
  return { runDir: first.runDir, anchorAction: first.action, receipt, readBack };
}
async function toSpineSpec(f, extra = []) {
  const flow = await toSpineReadBack(f, extra);
  const spec = out(await record(f, flow.runDir, flow.readBack.id, fixtureJson('spine-quest-answered.json'))).action;
  return { ...flow, spec };
}
async function toCoreSpec(f, extra = [], key = 'a') {
  const first = out(await intake(f, extra));
  assert.equal((await answer(f, first.runDir, key)).code, 0);
  const spec = out(await record(f, first.runDir, first.action.id, {})).action;
  return { runDir: first.runDir, touchAction: first.action, spec };
}
async function toGrant(f, text, extra = []) {
  const first = out(await intake(f, extra));
  assert.equal((await answer(f, first.runDir, 'c', { text })).code, 0);
  const grant = out(await record(f, first.runDir, first.action.id, {})).action;
  return { runDir: first.runDir, grant };
}

function seedRun(f, patch = {}) {
  const runDir = join(f.runs, 'seeded', 'run');
  mkdirSync(runDir, { recursive: true });
  const state = {
    schemaVersion: 1, slug: 'seeded', runDir, workshopDir: dirname(runDir), pluginRoot: f.deps.pluginRoot,
    intent: { goal: GOAL, anchor: null }, agents: {}, adapters: { spine: { on: false } }, phase: 'build',
    touches: [], wps: [], handover: null, pending: null, lastRecorded: null, seq: 0, ...patch,
  };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  return runDir;
}
function shellHandler(spec) {
  return { next: () => ({ kind: 'shell', step: 'gate-cmd', command: ['node', '--test'], expects: { type: 'exit0' }, ...spec }), record: () => {} };
}

function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path] = { bytes: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs };
    }
  };
  walk(dir);
  return files;
}

const RECIPE = {
  bump: [{ file: '.claude-plugin/plugin.json', jsonPath: 'version' }], level: 'patch', pr: true,
  after: ['claude plugin update workit@workit'], verify: ['node --test'],
};
function recipeFile(f, recipe, name = 'recipe.json') {
  const path = join(f.dir, name);
  writeFileSync(path, JSON.stringify(recipe));
  return path;
}

test('intake refuses <case>: exit 2 and the runs root stays empty', async (t) => {
  const notFound = 'https://github.com/sirmaelstrom/does-not-exist-xyz.git\n';
  const cases = [
    ['refusal 1: no --repo', (f) => f.run(['intake', '--goal', GOAL, '--runs-root', f.runs])],
    ['refusal 1: not a work tree', (f) => {
      f.table[`git -C ${f.repo} rev-parse --is-inside-work-tree`] = { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      return intake(f);
    }],
    ['refusal 2: no origin', (f) => {
      f.table[`git -C ${f.repo} config --get remote.origin.url`] = { code: 1, stdout: '', stderr: '' };
      return intake(f);
    }],
    ['refusal 2: not GitHub', (f) => {
      f.table[`git -C ${f.repo} config --get remote.origin.url`] = { code: 0, stdout: 'https://gitlab.com/a/b.git\n', stderr: '' };
      return intake(f);
    }],
    ['refusal 2: gh cannot resolve', (f) => {
      f.table[`git -C ${f.repo} config --get remote.origin.url`] = { code: 0, stdout: notFound, stderr: '' };
      f.table['gh repo view sirmaelstrom/does-not-exist-xyz --json nameWithOwner,defaultBranchRef'] = captured('gh-repo-view-not-found.json');
      return intake(f);
    }],
    ['refusal 3: gh auth', (f) => {
      f.table['gh auth status'] = { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
      return intake(f);
    }],
    ['refusal 5: no agent', (f) => {
      f.table['claude --version'] = { code: 1, stdout: '', stderr: 'spawnSync claude ENOENT' };
      return intake(f);
    }],
    ['refusal 7: spine without anchor', (f) => intake(f, ['--adapter', 'spine'])],
    ['recipe missing bump', (f) => {
      const { bump, ...rest } = RECIPE;
      return intake(f, ['--release', recipeFile(f, rest)]);
    }],
    ['recipe after with a quote', (f) => intake(f, ['--release', recipeFile(f, { ...RECIPE, after: ['echo "hi"'] })])],
    ['recipe pr: false', (f) => intake(f, ['--release', recipeFile(f, { ...RECIPE, pr: false })])],
  ];
  for (const [name, act] of cases) {
    const f = fixture(t);
    const result = await act(f);
    assert.equal(result.code, 2, `${name}: ${result.stdout}`);
    assert.deepEqual(readdirSync(f.runs), [], name);
  }

  const f = fixture(t);
  const first = out(await intake(f));
  const before = snapshot(f.runs);
  const again = await intake(f);
  assert.equal(again.code, 2);
  assert.match(out(again).error, /refusal 6/);
  assert.deepEqual(snapshot(f.runs), before);
  assert.ok(Object.keys(before).includes(join(first.runDir, 'state.json')));
});

test('no-adapter names an agent: exit 2, nothing written', async (t) => {
  for (const name of ['claude', 'codex']) {
    const f = fixture(t);
    const result = await intake(f, ['--no-adapter', name]);
    assert.equal(result.code, 2);
    assert.match(out(result).error, /lane agent CLI, not an adapter/);
    assert.deepEqual(readdirSync(f.runs), []);
    assert.deepEqual(f.calls, []);
  }
});

test('codex probe throws: intake survives with codex off and the message kept', async (t) => {
  const f = fixture(t, { platform: 'win32', resolveCodex: () => { throw new Error('codex.exe not found under: vendor'); } });
  const result = await intake(f);
  assert.equal(result.code, 0, result.stdout);
  const state = readState(out(result).runDir);
  assert.equal(state.agents.codex.on, false);
  assert.match(state.agents.codex.detail, /codex\.exe not found under: vendor/);
  assert.equal(state.agents.claude.on, true);
});

test('adapter quote rule: a quoted spend command is off on win32 and never run', () => {
  for (const [platform, on] of [['win32', false], ['linux', true]]) {
    const calls = [];
    const exec = (program, args) => {
      calls.push([program, ...args].join(' '));
      return { code: 0, stdout: 'v1\n', stderr: '' };
    };
    const { adapters } = detectAdapters({ env: { WORKIT_SPEND_CMD: 'spend "x"' }, exec, platform, resolveCodex: () => 'codex' });
    assert.equal(adapters.spend.on, on, platform);
    if (!on) assert.match(adapters.spend.detail, /double quote/);
    assert.ok(!calls.some((call) => call.includes('spend')), calls.join('\n'));
  }
});

test('run-dir precedence: --runs-root > WORKIT_WORKSPACE_ROOT > workspace ancestor > ~/.workit/runs', () => {
  const root = join(tmpdir(), 'ws');
  const repo = join(root, 'projects', 'repo');
  const exists = (path) => path === join(root, 'projects') || path === join(root, 'data');
  const env = { WORKIT_WORKSPACE_ROOT: join(tmpdir(), 'envroot') };
  const home = join(tmpdir(), 'home');
  const runsRoot = join(tmpdir(), 'scratch');
  assert.equal(resolveRunDir({ repo, slug: 's', env, runsRoot, exists, home }).runDir, join(runsRoot, 's', 'run'));
  assert.equal(resolveRunDir({ repo, slug: 's', env, exists, home }).workshopDir, join(env.WORKIT_WORKSPACE_ROOT, 'data', 'outputs', 'workshops', 's'));
  assert.equal(resolveRunDir({ repo, slug: 's', env: {}, exists, home }).workshopDir, join(root, 'data', 'outputs', 'workshops', 's'));
  assert.equal(resolveRunDir({ repo, slug: 's', env: {}, exists: () => false, home }).workshopDir, join(home, '.workit', 'runs', 's'));
});

test('recipe at intake: stored verbatim and shown in touch 1', async (t) => {
  const f = fixture(t);
  const result = out(await intake(f, ['--release', recipeFile(f, RECIPE)]));
  assert.deepEqual(readState(result.runDir).intent.release, RECIPE);
  for (const command of [...RECIPE.after, ...RECIPE.verify]) assert.ok(result.action.touch.question.includes(command), command);

  const files = { '/flag.json': JSON.stringify({ ...RECIPE, level: 'minor' }), [join('/repo', '.workit', 'conduct.json')]: JSON.stringify({ release: RECIPE }) };
  const read = (path) => {
    if (Object.hasOwn(files, path)) return files[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
  assert.equal(resolveRecipe({ flagPath: '/flag.json', repoPath: '/repo', read }).level, 'minor');
  assert.deepEqual(resolveRecipe({ flagPath: null, repoPath: '/repo', read }), RECIPE);
  assert.equal(resolveRecipe({ flagPath: null, repoPath: '/elsewhere', read }), null);
  assert.deepEqual(recipeArgv('claude plugin update workit@workit'), ['claude', 'plugin', 'update', 'workit@workit']);
});

function libFilesUsingImportMetaUrl(libDir) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') && readFileSync(path, 'utf8').includes('import.meta.url')) hits.push(path);
    }
  };
  walk(libDir);
  return hits;
}

test('pluginRoot from conduct.mjs only', async (t) => {
  const f = fixture(t);
  const state = readState(out(await intake(f)).runDir);
  assert.equal(state.pluginRoot, f.deps.pluginRoot);
  assert.deepEqual(libFilesUsingImportMetaUrl(join(HERE, 'lib')), []);
});

test('action env (D20): carried verbatim through pending, never into the command', async (t) => {
  const f = fixture(t);
  const env = { WORKIT_NOTIFY_PR: '7' };
  const runDir = seedRun(f);
  const importModule = loaderWith({ 'lib/phases/build.mjs': shellHandler({ step: 'notify', command: ['sh', '-c', '$WORKIT_NOTIFY_CMD'], env }) });
  const first = out(await f.run(['next', '--run', runDir], { importModule })).action;
  const second = out(await f.run(['next', '--run', runDir], { importModule })).action;
  assert.deepEqual(first.env, env);
  assert.deepEqual(second, first);
  assert.deepEqual(readState(runDir).pending.env, env);
  assert.ok(!first.command.some((arg) => arg.includes('7')));
});

test('plugin-root handover (D19.22)', async (t) => {
  const f = fixture(t);
  const importModule = loaderWith({ 'lib/phases/build.mjs': shellHandler({}) });
  const handover = { from: '/old', to: '/new', at: '2026-10-04T18:00:00.000Z' };
  let runDir = seedRun(f, { pluginRoot: '/new', handover });
  for (const argv of [['next', '--run', runDir], ['record', '--run', runDir, '--action', '1-gate-cmd', '--result', '{}']]) {
    const result = await f.run(argv, { pluginRoot: '/old', importModule });
    assert.equal(result.code, 2);
    assert.match(out(result).error, /\/new/);
  }
  assert.equal((await f.run(['next', '--run', runDir], { pluginRoot: '/new', importModule })).code, 0);
  rmSync(join(f.runs, 'seeded'), { recursive: true });
  runDir = seedRun(f, { pluginRoot: '/new', handover: null });
  const action = out(await f.run(['next', '--run', runDir], { pluginRoot: '/old', importModule })).action;
  const recorded = await record(f, runDir, action.id, { code: 0, stdout: '', stderr: '' }, { pluginRoot: '/old', importModule });
  assert.equal(recorded.code, 0, recorded.stdout);
});

test('depth none writes wp-00.md', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toCoreSpec(f);
  const state = readState(runDir);
  const result = await record(f, runDir, spec.id, { depth: 'none', workshopDir: state.workshopDir, gateCommand: 'node --test' });
  assert.equal(result.code, 0, result.stdout);
  const wp = readState(runDir).wps[0];
  assert.equal(wp.specPath, join(runDir, 'wp-00.md'));
  assert.equal(wp.model, 'opus');
  assert.equal(wp.tier, 'T1');
  const text = readFileSync(wp.specPath, 'utf8');
  assert.ok(text.includes(GOAL));
  assert.ok(text.includes('node --test'));
  assert.match(text, /^\*\*Runtime exercise:\*\* \S/m);
  assert.equal(wp.runtimeExercise, /^\*\*Runtime exercise:\*\* (.*)$/m.exec(text)[1]);
});

test('answer refuses non-tty', async (t) => {
  const f = fixture(t);
  const { runDir } = out(await intake(f));
  const recordPath = join(runDir, 'touches', '1.json');
  const before = readFileSync(recordPath, 'utf8');
  const piped = await answer(f, runDir, 'a', { tty: false });
  assert.equal(piped.code, 3);
  assert.equal(readFileSync(recordPath, 'utf8'), before);
  assert.equal(readState(runDir).touches[0].status, 'open');
  assert.equal((await answer(f, runDir, 'z')).code, 3);
  assert.equal(readFileSync(recordPath, 'utf8'), before);
  const tty = await answer(f, runDir, 'a');
  assert.equal(tty.code, 0, tty.stdout);
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).tty, true);
});

test('record refuses unattributed answer', async (t) => {
  const f = fixture(t);
  const { runDir, readBack } = await toSpineReadBack(f);
  const result = fixtureJson('spine-quest-answered.json');
  result.quests[0].latestReceipt.answer = { by: 'agent:claude', key: 'a' };
  assert.equal((await record(f, runDir, readBack.id, result)).code, 3);
  assert.equal(readState(runDir).touches[0].status, 'filed');
});

test('anchor resolution: spine reads the anchor first; spine off starts at preapproval', async (t) => {
  const f = fixture(t);
  const first = out(await intake(f, SPINE));
  assert.equal(readState(first.runDir).phase, 'intake');
  assert.equal(first.action.tool, 'spine_quest');
  assert.deepEqual(first.action.args, { ids: [ANCHOR] });
  const next = out(await record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json')));
  const state = readState(first.runDir);
  const { slug, title } = fixtureJson('spine-quest-answered.json').quests[0].campaign;
  assert.deepEqual(state.intent.campaign, { slug, title });
  assert.equal(state.intent.anchor, ANCHOR_UUID);
  assert.equal(state.phase, 'preapproval');
  assert.equal(next.action.tool, 'spine_receipt');

  const g = fixture(t);
  assert.equal(readState(out(await intake(g)).runDir).phase, 'preapproval');
});

test('touch 1 names lane models', async (t) => {
  const f = fixture(t);
  f.table['codex --version'] = { code: 0, stdout: 'codex-cli 0.159.3\n', stderr: '' };
  assert.match(out(await intake(f, ['--agent', 'codex'])).action.touch.question, /gpt-6\.1-sol/);
  const g = fixture(t);
  const question = out(await intake(g)).action.touch.question;
  assert.ok(question.includes('claude-opus-5-5') && question.includes('claude-sonnet-5-5'), question);
  assert.equal(laneModel('codex', 'sonnet'), 'gpt-6.1-sol');
  assert.equal(laneModel('claude', '-'), 'claude-opus-5-5');
  assert.equal(laneModel('claude', undefined), 'claude-opus-5-5');
  assert.throws(() => laneModel('claude', 'haiku'));
});

test('laneModel normalizes (D20)', () => {
  assert.equal(laneModel('claude', 'Opus'), 'claude-opus-5-5');
  assert.equal(laneModel('claude', 'SONNET'), 'claude-sonnet-5-5');
  assert.equal(laneModel('claude', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(laneModel('codex', 'gpt-6.1-sol'), 'gpt-6.1-sol');
});

test('touch 1 budget label (D19.28)', async (t) => {
  const f = fixture(t);
  const off = out(await intake(f));
  assert.match(off.action.touch.question, /unmetered/);
  assert.match(off.action.touch.question, /lane-only lower bound/);
  assert.equal(readState(off.runDir).authority.metered, false);
  const g = fixture(t, { env: { WORKIT_SPEND_CMD: 'spend-usd --since' } });
  const on = out(await intake(g));
  assert.doesNotMatch(on.action.touch.question, /unmetered|lane-only lower bound/);
  assert.equal(readState(on.runDir).authority.metered, true);
});

test('no CI offers hold only (D19.13)', async (t) => {
  const f = fixture(t);
  f.table['gh api repos/sirmaelstrom/workit/actions/workflows'] = captured('gh-actions-workflows-zero.json');
  const { runDir, grant } = await toGrant(f, 'merge them anyway');
  const state = readState(runDir);
  assert.equal(state.intent.ciWorkflows, 0);
  assert.deepEqual(state.touches[0].options.map((option) => option.key), ['b', 'c', 'd']);
  assert.match(state.touches[0].question, /No CI workflows exist/);
  writeFileSync(grant.outPath, JSON.stringify({ merge: true, release: false, budgetUsd: 10, scope: GOAL }));
  const result = await record(f, runDir, grant.id, {});
  assert.equal(result.code, 2);
  assert.match(out(result).error, /merge/);
});

test('structured grant (c) (D19.1)', async (t) => {
  const text = 'cap it at $10 and skip the release';
  const f = fixture(t);
  const { runDir, grant } = await toGrant(f, text);
  assert.equal(grant.kind, 'author');
  assert.equal(grant.step, 'grant');
  assert.equal(grant.outPath, join(runDir, 'touches', '1-grant.json'));
  const granted = { merge: true, release: false, budgetUsd: 10, scope: GOAL };
  writeFileSync(grant.outPath, JSON.stringify(granted));
  assert.equal((await record(f, runDir, grant.id, {})).code, 0);
  const state = readState(runDir);
  assert.deepEqual(state.authority, { ...granted, metered: false, notes: text, grant: 'touches/1-grant.json' });
  assert.equal(state.phase, 'spec');

  for (const [bad, field] of [[{ ...granted, budgetUsd: 30 }, /budgetUsd/], [{ ...granted, release: true }, /release/]]) {
    const g = fixture(t);
    const flow = await toGrant(g, text);
    writeFileSync(flow.grant.outPath, JSON.stringify(bad));
    const result = await record(g, flow.runDir, flow.grant.id, {});
    assert.equal(result.code, 2);
    assert.match(out(result).error, field);
  }

  const h = fixture(t);
  const flow = await toGrant(h, text);
  writeFileSync(flow.grant.outPath, JSON.stringify({ ambiguous: true, why: 'the scope is unclear' }));
  const blocked = out(await record(h, flow.runDir, flow.grant.id, {})).action;
  const touch = readState(flow.runDir).touches[1];
  assert.equal(touch.kind, 'blocked');
  assert.deepEqual(touch.options.map((option) => option.key), ['a', 'b', 'd']);
  assert.ok(touch.question.includes(`"${text}"`));
  assert.equal(blocked.touch.n, 2);
  assert.equal(events(flow.runDir).filter((line) => line.event === 'touch-opened').length, 2);
});

test('preapproved ref (D19.6)', async (t) => {
  const f = fixture(t);
  const { spec } = await toSpineSpec(f);
  assert.ok(spec.skillArgs.endsWith(`--preapproved "spine:${ANCHOR_UUID}@${ANSWERED_AT} by operator:dogan"`), spec.skillArgs);
  const g = fixture(t);
  const core = await toCoreSpec(g);
  assert.ok(core.spec.skillArgs.endsWith(`--preapproved "core:${core.runDir}/touches/1.json"`), core.spec.skillArgs);
  assert.ok(core.spec.skillArgs.startsWith(`${GOAL} --workshop ${readState(core.runDir).workshopDir} `));
});

test('touch-opened event: one per touch, spine on and off', async (t) => {
  for (const extra of [[], SPINE]) {
    const f = fixture(t);
    const first = out(await intake(f, extra));
    if (extra.length) await record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json'));
    const opened = events(first.runDir).filter((line) => line.event === 'touch-opened');
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].data, { n: 1, kind: 'preapproval' });
  }
});

test('interim deep mint', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toSpineSpec(f);
  const minted = fixtureJson('spine-author-result.json');
  const wps = minted.quests.map((quest, i) => ({ id: quest.key.toUpperCase(), name: `wp ${i + 1}`, specPath: `wp-0${i + 1}.md`, tier: 'T2' }));
  const mint = out(await record(f, runDir, spec.id, { depth: 'deep', workshopDir: readState(runDir).workshopDir, wps })).action;
  assert.equal(mint.tool, 'spine_author');
  assert.deepEqual(mint.args.campaign, { title: fixtureJson('spine-quest-answered.json').quests[0].campaign.title });
  assert.equal(mint.args.quests.length, wps.length);
  assert.ok(mint.args.seams.every((seam) => seam.from === ANCHOR_UUID && seam.type === 'decomposition'));
  assert.equal((await record(f, runDir, mint.id, minted)).code, 0);
  const state = readState(runDir);
  assert.deepEqual(state.wps.map((wp) => wp.questId), minted.quests.map((quest) => quest.id));
  assert.equal(state.phase, 'build');
});

test('spine touch is filed once', async (t) => {
  const f = fixture(t);
  const { runDir, receipt } = await toSpineReadBack(f);
  assert.equal(receipt.tool, 'spine_receipt');
  const pending = fixtureJson('spine-quest-answered.json');
  pending.quests[0].latestReceipt = { outcome: 'needs_input', question: readState(runDir).touches[0].question };
  for (let read = 0; read < 3; read += 1) {
    const readBack = readState(runDir).pending;
    assert.equal(readBack.tool, 'spine_quest', `read ${read}`);
    const wait = out(await record(f, runDir, readBack.id, pending)).action;
    assert.equal(wait.kind, 'wait');
    assert.equal(wait.waitMs, 300000);
    assert.equal(out(await record(f, runDir, wait.id, {})).action.tool, 'spine_quest');
  }
  assert.equal(out(await record(f, runDir, readState(runDir).pending.id, fixtureJson('spine-quest-answered.json'))).phase, 'spec');
  assert.equal(readState(runDir).touches[0].answer.receiptId, null);

  const g = fixture(t);
  const flow = await toSpineReadBack(g);
  await record(g, flow.runDir, flow.readBack.id, fixtureJson('spine-quest-answered-with-id.json'));
  assert.equal(readState(flow.runDir).touches[0].answer.receiptId, fixtureJson('spine-quest-answered-with-id.json').quests[0].latestReceipt.id);
});

test('delayed answer is correlated (D19.2)', async (t) => {
  const f = fixture(t);
  const { runDir, readBack } = await toSpineReadBack(f);
  const wait = out(await record(f, runDir, readBack.id, fixtureJson('spine-quest-answered-touch-2.json'))).action;
  assert.equal(readState(runDir).phase, 'preapproval');
  assert.equal(wait.kind, 'wait');
  assert.equal(wait.waitMs, 300000);
  const again = out(await record(f, runDir, wait.id, {})).action;
  assert.equal(again.tool, 'spine_quest');
  assert.equal(out(await record(f, runDir, again.id, fixtureJson('spine-quest-answered.json'))).phase, 'spec');

  // Two open touches: only one is filed at a time.
  const dir = mkdtempSync(join(tmpdir(), 'workit-conduct-touch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { slug: 'fixture-run', runDir: dir, phase: 'preapproval', seq: 0, touches: [], adapters: { spine: { on: true } }, intent: { anchor: ANCHOR_UUID }, pluginRoot: dir };
  const deps = { append: (path, value) => appendFileSync(path, value), timestamp: () => '2026-10-04T18:00:00.000Z' };
  const options = [{ key: 'a', label: 'yes', consequence: 'go' }, { key: 'b', label: 'no', consequence: 'stop' }];
  const first = openTouch(state, { kind: 'preapproval', question: 'Q1', options }, deps);
  const second = openTouch(state, { kind: 'blocked', question: 'Q2', options }, deps);
  const filing = touchAction(state, first);
  assert.equal(filing.tool, 'spine_receipt');
  recordTouch(state, first, filing, { id: 'r1' });
  assert.equal(touchAction(state, second), null);
  assert.equal(second.status, 'open');
  recordTouch(state, first, touchAction(state, first), fixtureJson('spine-quest-answered.json'));
  assert.equal(first.status, 'answered');
  const secondFiling = touchAction(state, second);
  assert.equal(secondFiling.tool, 'spine_receipt');
  assert.ok(secondFiling.args.question.startsWith('[conduct fixture-run touch 2]'));
});

test('action consumption (D19.19)', async (t) => {
  const f = fixture(t);
  const first = out(await intake(f, SPINE));
  const runDir = first.runDir;
  assert.deepEqual(out(await f.run(['next', '--run', runDir])).action, first.action);
  assert.deepEqual(out(await f.run(['next', '--run', runDir])).action, first.action);
  const receipt = out(await record(f, runDir, first.action.id, fixtureJson('spine-quest-answered.json'))).action;
  let state = readState(runDir);
  assert.equal(state.lastRecorded, first.action.id);
  assert.notEqual(state.pending.id, first.action.id);
  const lines = events(runDir).length;
  const replay = await record(f, runDir, first.action.id, fixtureJson('spine-quest-answered.json'));
  assert.equal(replay.code, 0);
  assert.equal(events(runDir).length, lines);
  assert.equal((await record(f, runDir, '99-spec', {})).code, 5);
  const readBack = out(await record(f, runDir, receipt.id, { id: 'filed' })).action;
  assert.equal((await record(f, runDir, first.action.id, {})).code, 5);
  const wait = out(await record(f, runDir, readBack.id, { quests: [{ latestReceipt: null }] })).action;
  assert.equal(wait.kind, 'wait');
  assert.equal((await record(f, runDir, wait.id, {})).code, 0);

  const g = fixture(t);
  const closed = seedRun(g, { phase: 'closed' });
  assert.equal(out(await g.run(['next', '--run', closed])).action.kind, 'done');
  state = readState(closed);
  assert.equal(state.pending, null);
});

const VOCABULARY = [
  'intake', 'anchor', 'preapproval', 'spec', 'mint', 'contract', 'admit', 'create', 'base', 'brief', 'start', 'prompt',
  'wait', 'check', 'pr-lookup', 'review', 'post', 'council', 'adjudicate', 'reply', 'rebase', 'gate-cmd', 'gate',
  'merge', 'merged', 'notify', 'spend', 'release', 'analyze', 'showcase',
  'flip', 'receipt', 'touch', 'stop', 'fallback',
  'grant', 'ruling', 'thread-ids', 'resolve',
];

test('action ids and seams (D18, D19.15)', async (t) => {
  assert.deepEqual([...STEPS].sort(), [...VOCABULARY].sort());
  assert.deepEqual(Object.keys(STEP_SEAM).sort(), [...STEPS].sort());
  const f = fixture(t);
  const flow = await toSpineSpec(f);
  const workshopDir = readState(flow.runDir).workshopDir;
  const mint = out(await record(f, flow.runDir, flow.spec.id, { depth: 'deep', workshopDir, wps: [{ id: 'WP-01' }] })).action;
  const actions = [flow.anchorAction, flow.receipt, flow.readBack, flow.spec, mint];
  const emitted = events(flow.runDir).filter((line) => line.event === 'emitted');
  for (const action of actions) {
    const [, seq, step] = /^(\d+)-(.+)$/.exec(action.id);
    assert.ok(STEPS.includes(step), action.id);
    assert.equal(action.step, step);
    assert.equal(action.seam, STEP_SEAM[step]);
    const line = emitted.find((event) => event.actionId === action.id);
    assert.equal(line.step, step);
    assert.equal(line.seam, STEP_SEAM[step]);
    assert.equal(line.seq, Number(seq));
  }
  assert.deepEqual(actions.map((action) => action.step), ['anchor', 'preapproval', 'preapproval', 'spec', 'mint']);
});

test('shell result shape (D18)', async (t) => {
  const cases = [['exit0', { stdout: '' }], ['exit0', { code: 1, stdout: '', stderr: '' }], ['json', { code: 0, stdout: 'not json', stderr: '' }]];
  for (const [type, result] of cases) {
    const f = fixture(t);
    const runDir = seedRun(f);
    const importModule = loaderWith({ 'lib/phases/build.mjs': shellHandler({ expects: { type } }) });
    const action = out(await f.run(['next', '--run', runDir], { importModule })).action;
    const recorded = await record(f, runDir, action.id, result, { importModule });
    assert.equal(recorded.code, 2, JSON.stringify(result));
    assert.equal(readState(runDir).pending.id, action.id);
  }
});

test('no verb: usage on stderr, exit 2', async () => {
  const result = await runConduct([]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^usage: conduct\.mjs/);
});

test('shellArgv (D18)', () => {
  assert.deepEqual(shellArgv('node --test', 'win32'), ['cmd.exe', '/d', '/s', '/c', 'node --test']);
  assert.deepEqual(shellArgv('node --test', 'linux'), ['sh', '-c', 'node --test']);
});

test('terminal phases (D19.5): done with no handler loaded', async (t) => {
  for (const phase of ['closed', 'declined', 'sent-back']) {
    const f = fixture(t);
    const runDir = seedRun(f, { phase });
    const result = out(await f.run(['next', '--run', runDir], { importModule: () => { throw new Error('no handler may load'); } }));
    assert.equal(result.action.kind, 'done');
  }
});

test('resume: a fresh runConduct continues from the run dir alone', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toCoreSpec(f);
  const resumed = await runConduct(['--resume', runDir], { importModule: testLoader, pluginRoot: f.deps.pluginRoot });
  assert.deepEqual(out(resumed).action, spec);
});

test('portability (WP-01 slice): every adapter off, no agent-tool action', async (t) => {
  const f = fixture(t);
  const off = ['herdr', 'notify', 'spend', 'spine', 'council', 'kb', 'verify'].flatMap((name) => ['--no-adapter', name]);
  const { runDir, touchAction: touch, spec } = await toCoreSpec(f, off);
  const after = out(await record(f, runDir, spec.id, { depth: 'deep', workshopDir: readState(runDir).workshopDir, wps: [{ id: 'WP-01' }] }));
  const kinds = [touch, spec, after.action].map((action) => action.kind);
  assert.ok(!kinds.includes('agent-tool'), kinds.join(','));
  assert.ok(!events(runDir).some((line) => line.kind === 'agent-tool'));
  assert.equal(readState(runDir).phase, 'build');
});

test('schema gate: a newer state is refused naming both versions', async (t) => {
  const f = fixture(t);
  const runDir = seedRun(f, { schemaVersion: 2 });
  const result = await f.run(['next', '--run', runDir]);
  assert.equal(result.code, 2);
  assert.match(out(result).error, /schemaVersion 2 .*\(1\)/);
});

test('analyze/lane/land missing module: exit 4 naming the module; sub-verb I/O (D19.21)', async (t) => {
  const f = fixture(t);
  const runDir = seedRun(f);
  const cases = [
    [['analyze', '--run', runDir], 'lib/analyze.mjs'],
    [['lane', 'spawn', '--run', runDir, '--wp', 'WP-01'], 'lib/lanes.mjs'],
    [['land', 'gate', '--run', runDir, '--wp', 'WP-01'], 'lib/land.mjs'],
  ];
  for (const [argv, path] of cases) {
    const result = await f.run(argv, { importModule: missingLoader });
    assert.equal(result.code, 4, argv.join(' '));
    assert.ok(out(result).error.includes(path));
  }
  let received;
  const lanes = { runLaneVerb: (...args) => { received = args.slice(0, 2); return { code: 5, out: '{"ok":false}' }; } };
  const result = await f.run(['lane', 'spawn', '--run', runDir, '--wp', 'WP-01', '--amend', 'brief.md', '--some-flag', 'x'], { importModule: loaderWith({ 'lib/lanes.mjs': lanes }) });
  assert.deepEqual(received, ['spawn', { runDir, wpId: 'WP-01', flags: { amend: 'brief.md', someFlag: 'x' } }]);
  assert.equal(result.code, 5);
  assert.equal(result.stdout, '{"ok":false}');
});

test('missing phase handler: exit 4 naming the phase', async (t) => {
  const f = fixture(t);
  const runDir = seedRun(f, { phase: 'build' });
  const result = await f.run(['next', '--run', runDir], { importModule: missingLoader });
  assert.equal(result.code, 4);
  assert.match(out(result).error, /phase handler build/);
});

const PRIVATE_PATHS = [/[A-Za-z]:[\\/]+(Users|Development)\b/i, /[\\/]Users[\\/][^\\/\s"]+[\\/]/];
const privatePathHits = (text) => PRIVATE_PATHS.filter((pattern) => pattern.test(text)).map(String);

test('fixture paths: no private-path shapes under __fixtures__/intake', (t) => {
  const files = readdirSync(FIXTURES);
  assert.ok(files.length >= 9, files.join(', '));
  for (const name of files) assert.deepEqual(privatePathHits(readFileSync(join(FIXTURES, name), 'utf8')), [], name);
  // Control: the same check flags a copy with a user-profile path inserted.
  const dir = mkdtempSync(join(tmpdir(), 'workit-conduct-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copy = join(dir, 'gh-repo-view.json');
  const text = readFileSync(join(FIXTURES, 'gh-repo-view.json'), 'utf8');
  writeFileSync(copy, text.replace('"stderr": ""', `"stderr": ${JSON.stringify(['C:', 'Users', 'someone', 'x'].join('\\'))}`));
  assert.notDeepEqual(privatePathHits(readFileSync(copy, 'utf8')), []);
});

test('spawnDetached + pidAlive', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workit-conduct-spawn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'lane.log');
  const { pid } = spawnDetached(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { cwd: dir, logPath, env: process.env });
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(pidAlive(pid), true);
  const deadline = Date.now() + 5000;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert.equal(pidAlive(pid), false);
  assert.ok(existsSync(logPath));
});
