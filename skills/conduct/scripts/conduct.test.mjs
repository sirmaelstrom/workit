import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, appendFileSync, renameSync,
  linkSync, truncateSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runConduct } from './conduct.mjs';
import { STEPS, STEP_SEAM, ConductError, resolveRunDir, readEvents, saveState, appendEvent, withStateLock } from './lib/state.mjs';
import { detectAdapters, laneModel } from './lib/adapters.mjs';
import { resolveRecipe, recipeArgv } from './lib/recipe.mjs';
import { shellArgv, spawnDetached, pidAlive } from './lib/exec.mjs';
import { openTouch, touchAction, recordTouch } from './lib/touch.mjs';
import { validateGrant } from './lib/phases/preapproval.mjs';
import { samePath } from './lib/phases/spec.mjs';
import { questKey } from './lib/phases/mint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'intake');
const fixtureJson = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const captured = (name) => {
  const { code, stdout, stderr } = fixtureJson(name);
  return { code, stdout, stderr };
};

// slug `fixture-run` and run id `abcd1234` match the spine fixtures' questions.
const GOAL = 'fixture run';
const RUN_ID = 'abcd1234';
const ANCHOR = '93427349';
const ANCHOR_UUID = '93427349-2540-4d97-8437-db3af451caf2';
const ANSWERED_AT = '2026-09-27T15:56:42.000Z';
const WORKFLOWS = 'gh api --paginate repos/sirmaelstrom/workit/actions/workflows --jq .workflows[]';

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
    [`git -C ${repo} rev-parse --show-toplevel`]: { code: 0, stdout: `${repo}\n`, stderr: '' },
    [`git -C ${repo} config --get remote.origin.url`]: { code: 0, stdout: 'https://github.com/sirmaelstrom/workit.git\n', stderr: '' },
    'gh auth status --hostname github.com': captured('gh-auth-status.json'),
    'gh repo view sirmaelstrom/workit --json nameWithOwner,defaultBranchRef': captured('gh-repo-view.json'),
    [WORKFLOWS]: captured('gh-actions-workflows.json'),
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
    newRunId: () => RUN_ID, lockWaitMs: 0, importModule: testLoader, ...deps,
  };
  return { dir, repo, runs, calls, table, deps: base, run: (argv, more = {}) => runConduct(argv, { ...base, ...more }) };
}

const out = (result) => JSON.parse(result.stdout);
const readState = (runDir) => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
const fsDeps = { exists: existsSync, read: (path) => readFileSync(path, 'utf8') };
const events = (runDir) => readEvents(runDir, fsDeps, readState(runDir));
const rawEvents = (runDir) => readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
// A spine read-back result answering this run's current filing of touch n.
function answeredFor(runDir, n = 1, answerPatch = {}) {
  const result = fixtureJson('spine-quest-answered.json');
  const touch = readState(runDir).touches[n - 1];
  result.quests[0].latestReceipt.question = `${touch.tag} (run ${RUN_ID}/${touch.filings}) synthetic question`;
  Object.assign(result.quests[0].latestReceipt.answer, answerPatch);
  return result;
}
const SPINE = ['--adapter', 'spine', '--anchor', ANCHOR];

function intake(f, extra = [], more = {}, goal = GOAL) {
  return f.run(['intake', '--goal', goal, '--repo', f.repo, '--runs-root', f.runs, ...extra], more);
}
function record(f, runDir, id, result, more = {}) {
  return f.run(['record', '--run', runDir, '--action', id, '--result', JSON.stringify(result)], more);
}
function answer(f, runDir, key, { text, tty = true } = {}) {
  return f.run(['answer', '--run', runDir, '--touch', '1', '--key', key, ...(text ? ['--text', text] : [])], { stdinIsTTY: tty });
}

// intake → anchor → touch 1 filed; returns the read-back action.
async function toSpineReadBack(f, extra = [], goal = GOAL) {
  const first = out(await intake(f, [...SPINE, ...extra], {}, goal));
  const receipt = out(await record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json'))).action;
  const readBack = out(await record(f, first.runDir, receipt.id, { id: '00000000-0000-4000-8000-0000000000f1' })).action;
  return { runDir: first.runDir, anchorAction: first.action, receipt, readBack };
}
async function toSpineSpec(f, extra = [], goal = GOAL) {
  const flow = await toSpineReadBack(f, extra, goal);
  const spec = out(await record(f, flow.runDir, flow.readBack.id, answeredFor(flow.runDir))).action;
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
    schemaVersion: 1, slug: 'seeded', runId: RUN_ID, rev: 0, runDir, workshopDir: dirname(runDir), pluginRoot: f.deps.pluginRoot,
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
      f.table['gh auth status --hostname github.com'] = { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
      return intake(f);
    }],
    ['refusal 5: no agent', (f) => {
      f.table['claude --version'] = { code: 1, stdout: '', stderr: 'spawnSync claude ENOENT' };
      return intake(f);
    }],
    ['refusal 7: spine without anchor', (f) => intake(f, ['--adapter', 'spine'])],
    ['refusal 7: empty anchor (C13)', (f) => intake(f, ['--adapter', 'spine', '--anchor', ''])],
    ['refusal 7: anchor shorter than 8 hex (C13)', (f) => intake(f, ['--adapter', 'spine', '--anchor', '9342'])],
    ['refusal 7: anchor with non-hex after the prefix (D12)', (f) => intake(f, ['--adapter', 'spine', '--anchor', '93427349zzz'])],
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
    if (!on) {
      assert.match(adapters.spend.detail, /double quote/);
      assert.ok(!calls.some((call) => call.includes('spend')), calls.join('\n'));
    }
    // Resolving the program (linux: `command -v`) is allowed; running the command never is.
    assert.ok(!calls.some((call) => call.startsWith('spend') || call.includes('spend "x"')), calls.join('\n'));
  }
});

test('C2: spend and notify are on only when the program resolves (D2), looked up without running it', () => {
  const probe = (env, answers, platform = 'linux', exists = () => false) => {
    const calls = [];
    const exec = (program, args) => {
      const key = [program, ...args].join(' ');
      calls.push(key);
      return answers[key] ?? { code: key.endsWith('--version') ? 0 : 1, stdout: 'v1\n', stderr: '' };
    };
    return { ...detectAdapters({ env, exec, exists, platform, resolveCodex: () => 'codex' }).adapters, calls };
  };
  const missing = probe({ WORKIT_SPEND_CMD: 'missing-spend --since' }, {});
  assert.equal(missing.spend.on, false);
  assert.match(missing.spend.detail, /missing-spend does not resolve/);
  const found = probe({ WORKIT_SPEND_CMD: 'spend-usd --since' }, { 'sh -c command -v "$1" sh spend-usd': { code: 0, stdout: '/usr/bin/spend-usd\n', stderr: '' } });
  assert.equal(found.spend.on, true);
  assert.match(found.spend.detail, /resolves to \/usr\/bin\/spend-usd/);
  const win = probe({ WORKIT_NOTIFY_CMD: 'merge-ping --pr' }, { 'where merge-ping': { code: 0, stdout: 'C:\\tools\\merge-ping.exe\r\n', stderr: '' } }, 'win32');
  assert.equal(win.notify.on, true);
  const absolute = join(tmpdir(), 'spend.exe');
  assert.equal(probe({ WORKIT_SPEND_CMD: `${absolute} --x` }, {}, 'linux', (path) => path === absolute).spend.on, true);
  assert.ok(!missing.calls.some((call) => call.startsWith('missing-spend')));
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
  const refused = await record(f, runDir, readBack.id, result);
  assert.equal(refused.code, 3);
  assert.match(out(refused).refused, /agent:claude is not operator-attributed/);
  const touch = readState(runDir).touches[0];
  assert.equal(touch.answer, null);
  assert.equal(readState(runDir).phase, 'preapproval');
  // D7: the refusal does not block: the next `next` re-files the touch, never /spec.
  const next = out(await f.run(['next', '--run', runDir])).action;
  assert.equal(next.tool, 'spine_receipt');
  assert.ok(next.args.question.startsWith(`[conduct fixture-run touch 1] (run ${RUN_ID}/2) Your previous answer could not be used (the answer by agent:claude is not operator-attributed)`), next.args.question);
  assert.deepEqual(out(refused).action, next);
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
  g.table['sh -c command -v "$1" sh spend-usd'] = { code: 0, stdout: '/usr/local/bin/spend-usd\n', stderr: '' };
  const on = out(await intake(g));
  assert.doesNotMatch(on.action.touch.question, /unmetered|lane-only lower bound/);
  assert.equal(readState(on.runDir).authority.metered, true);
});

test('no CI offers hold only (D19.13)', async (t) => {
  const f = fixture(t);
  f.table[WORKFLOWS] = captured('gh-actions-workflows-zero.json');
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
  assert.deepEqual(state.authority, { ...granted, metered: false, notes: text, grant: 'touches/1-grant.json', record: 'touches/1-authority.json' });
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

test('mint from the workshop: parseWorkPackages supplies the WPs, each keeping its wave', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toSpineSpec(f, [], 'rc1');
  // The workshop fixture (six WPs, waves 1-4) is copied into this run's
  // workshop; the spec record carries no `wps`.
  const workshopDir = readState(runDir).workshopDir;
  const source = join(HERE, '__fixtures__', 'lanes', 'workshop', 'work-packages');
  mkdirSync(join(workshopDir, 'work-packages'), { recursive: true });
  for (const name of readdirSync(source)) writeFileSync(join(workshopDir, 'work-packages', name), readFileSync(join(source, name)));
  // The spine_author fixture is the conductor's verbatim capture, keyed
  // `rc1-wp-01` … by the run that minted it. Its keys are rewritten here, in
  // memory only, to this run's keys before mapping; ids and shape stay real.
  const minted = fixtureJson('spine-author-result.json');
  const ids = ['WP-01', 'WP-02', 'WP-03', 'WP-04', 'WP-05', 'WP-06'];
  const keys = ids.map((id) => `rc1-${RUN_ID}-${id.toLowerCase()}`);
  minted.quests.forEach((quest, i) => { quest.key = keys[i]; });
  const mint = out(await record(f, runDir, spec.id, { depth: 'deep', workshopDir })).action;
  assert.equal(mint.tool, 'spine_author');
  assert.deepEqual(mint.args.campaign, { title: fixtureJson('spine-quest-answered.json').quests[0].campaign.title });
  assert.deepEqual(mint.args.quests.map((quest) => quest.key), keys);
  assert.deepEqual(mint.args.seams.map((seam) => seam.to), keys);
  assert.ok(mint.args.seams.every((seam) => seam.from === ANCHOR_UUID && seam.type === 'decomposition'));
  // C21: the resume note carries what the consumer reads.
  assert.match(mint.args.quests[0].resumeNote, /wp-01-state-intake-protocol\.md · precondition: .+ · verification: see the WP · review tier: T2 · runtime exercise: /);
  let state = readState(runDir);
  assert.deepEqual(state.wps.map((wp) => [wp.id, wp.wave]), [['WP-01', 1], ['WP-02', 2], ['WP-03', 2], ['WP-04', 3], ['WP-05', 3], ['WP-06', 4]]);
  assert.deepEqual(state.wps.find((wp) => wp.id === 'WP-04').dependsOn, ['WP-02', 'WP-03']);
  assert.ok(state.wps.every((wp) => wp.files.length > 0 && wp.tier === 'T2' && wp.state === 'pending'));
  assert.equal((await record(f, runDir, mint.id, minted)).code, 0);
  state = readState(runDir);
  assert.deepEqual(state.wps.map((wp) => wp.questId), minted.quests.map((quest) => quest.id));
  assert.equal(state.phase, 'build');
});

test('C4, D4: mint keys carry the slug and run id: distinct across runs of one goal, stable within a run', async (t) => {
  const wp = { id: 'WP-01' };
  assert.equal(questKey({ slug: 'goal-one', runId: 'abcd1234' }, wp), 'goal-one-abcd1234-wp-01');
  assert.notEqual(questKey({ slug: 'goal-one', runId: 'abcd1234' }, wp), questKey({ slug: 'goal-two', runId: 'abcd1234' }, wp));
  assert.notEqual(questKey({ slug: 'same-goal', runId: '11111111' }, wp), questKey({ slug: 'same-goal', runId: '22222222' }, wp));
  // One run, read twice from disk: the same keys.
  const f = fixture(t);
  const { runDir } = out(await intake(f));
  assert.equal(questKey(readState(runDir), wp), questKey(readState(runDir), wp));
  assert.equal(questKey(readState(runDir), wp), `fixture-run-${RUN_ID}-wp-01`);
});

test('C24: a deep spec result listing a WP id twice is refused', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toCoreSpec(f);
  const result = await record(f, runDir, spec.id, { depth: 'deep', workshopDir: readState(runDir).workshopDir, wps: [{ id: 'WP-01' }, { id: 'wp-01' }] });
  assert.equal(result.code, 2);
  assert.match(out(result).error, /wp-01 twice/);
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
  const state = { slug: 'fixture-run', runId: RUN_ID, runDir: dir, phase: 'preapproval', seq: 0, touches: [], adapters: { spine: { on: true } }, intent: { anchor: ANCHOR_UUID }, pluginRoot: dir };
  const deps = { append: (path, value) => appendFileSync(path, value), timestamp: () => '2026-10-04T18:00:00.000Z' };
  const options = [{ key: 'a', label: 'yes', consequence: 'go' }, { key: 'b', label: 'no', consequence: 'stop' }];
  const first = openTouch(state, { kind: 'preapproval', question: 'Q1', options }, deps);
  const second = openTouch(state, { kind: 'blocked', question: 'Q2', options }, deps);
  const filing = touchAction(state, first);
  assert.equal(filing.tool, 'spine_receipt');
  recordTouch(state, first, filing, { id: '00000000-0000-4000-8000-0000000000f2' });
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
  const readBack = out(await record(f, runDir, receipt.id, { id: '00000000-0000-4000-8000-0000000000f3' })).action;
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
  // A deep mint needs its workshop (WP-06 C1-1): the seam fixture's three WPs.
  const source = join(HERE, '__fixtures__', 'seam', 'workshop', 'work-packages');
  mkdirSync(join(workshopDir, 'work-packages'), { recursive: true });
  for (const name of readdirSync(source)) writeFileSync(join(workshopDir, 'work-packages', name), readFileSync(join(source, name)));
  const mint = out(await record(f, flow.runDir, flow.spec.id, { depth: 'deep', workshopDir })).action;
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
  // The no-code case expects valid JSON on stdout, so only the code check can refuse it.
  const cases = [['json', { stdout: '{}' }], ['exit0', { code: 1, stdout: '', stderr: '' }], ['json', { code: 0, stdout: 'not json', stderr: '' }]];
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
  // A deep mint needs its workshop (WP-06 C1-1): the seam fixture's three WPs.
  const workshopDir = readState(runDir).workshopDir;
  const source = join(HERE, '__fixtures__', 'seam', 'workshop', 'work-packages');
  mkdirSync(join(workshopDir, 'work-packages'), { recursive: true });
  for (const name of readdirSync(source)) writeFileSync(join(workshopDir, 'work-packages', name), readFileSync(join(source, name)));
  const after = out(await record(f, runDir, spec.id, { depth: 'deep', workshopDir }));
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
  const result = await f.run(['lane', 'check', '--run', runDir, '--wp', 'WP-01', '--amend', 'brief.md', '--some-flag', 'x'], { importModule: loaderWith({ 'lib/lanes.mjs': lanes }) });
  assert.deepEqual(received, ['check', { runDir, wpId: 'WP-01', flags: { amend: 'brief.md', someFlag: 'x' } }]);
  assert.equal(result.code, 5);
  assert.equal(result.stdout, '{"ok":false}');
});

test('D6: lane spawn, the sub-verb that writes state, runs inside the run lock with the state loaded under it', async (t) => {
  const f = fixture(t);
  const runDir = seedRun(f);
  let seen;
  const lanes = {
    runLaneVerb: (sub, args, deps) => {
      seen = { sub, lockHeld: existsSync(join(runDir, 'state.lock')), slug: args.state?.slug, flags: args.flags };
      args.state.wps.push({ id: 'WP-01', lane: { pid: 4242 } });
      saveState(args.state, deps);
      return { code: 0, out: '{"ok":true}' };
    },
  };
  const result = await f.run(['lane', 'spawn', '--run', runDir, '--wp', 'WP-01', '--amend', 'brief.md'], { importModule: loaderWith({ 'lib/lanes.mjs': lanes }) });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(seen, { sub: 'spawn', lockHeld: true, slug: 'seeded', flags: { amend: 'brief.md' } });
  assert.equal(readState(runDir).wps[0].lane.pid, 4242);
  assert.equal(existsSync(join(runDir, 'state.lock')), false);
});

test('D10: analyze hands its module the deps readEvents needs', async (t) => {
  const f = fixture(t);
  const { runDir } = out(await intake(f));
  const analysis = { analyzeRun: (dir, deps) => ({ ok: true, events: readEvents(dir, deps).map((line) => line.event) }) };
  const result = out(await f.run(['analyze', '--run', runDir], { importModule: loaderWith({ 'lib/analyze.mjs': analysis }) }));
  assert.deepEqual(result.events, ['intake', 'touch-opened', 'emitted']);
});

test('missing phase handler: exit 4 naming the phase', async (t) => {
  const f = fixture(t);
  const runDir = seedRun(f, { phase: 'build' });
  const result = await f.run(['next', '--run', runDir], { importModule: missingLoader });
  assert.equal(result.code, 4);
  assert.match(out(result).error, /phase handler build/);
});

// ---- Amendment 1: council round 1 findings (ids C1–C24) ----

test('C1: a failed receipt filing is refused and the filing stays retryable', async (t) => {
  const f = fixture(t);
  const first = out(await intake(f, SPINE));
  const receipt = out(await record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json'))).action;
  for (const bad of [{ error: 'spine_receipt failed: 500' }, { isError: true, content: [] }, 'filed', null]) {
    const result = await record(f, first.runDir, receipt.id, bad);
    assert.equal(result.code, 2, JSON.stringify(bad));
    const state = readState(first.runDir);
    assert.equal(state.touches[0].status, 'open');
    assert.equal(state.pending.id, receipt.id);
  }
  // An unbound acknowledgement (no receipt uuid) is refused like a failure (C1-2 of WP-06).
  assert.equal((await record(f, first.runDir, receipt.id, {})).code, 2);
  assert.equal(readState(first.runDir).touches[0].status, 'open');
  const uuid = '00000000-0000-4000-8000-0000000000f4';
  assert.equal(out(await record(f, first.runDir, receipt.id, { id: uuid })).action.tool, 'spine_quest');
  assert.equal(readState(first.runDir).touches[0].receiptId, uuid);
});

test('C3: a same-tag answer from another run of the goal is not this run\'s answer', async (t) => {
  const f = fixture(t);
  const { runDir, receipt, readBack } = await toSpineReadBack(f);
  assert.ok(receipt.args.question.startsWith(`[conduct fixture-run touch 1] (run ${RUN_ID}/1) DO:`), receipt.args.question);
  const wait = out(await record(f, runDir, readBack.id, fixtureJson('spine-quest-answered-stale.json'))).action;
  assert.equal(wait.kind, 'wait');
  const state = readState(runDir);
  assert.equal(state.phase, 'preapproval');
  assert.equal(state.touches[0].status, 'filed');
  assert.equal(state.runId, RUN_ID);
});

test('C5: an answer racing a record is serialized by the state lock, never lost; a dead holder\'s lock is taken over', async (t) => {
  const f = fixture(t);
  const touch = {
    n: 1, kind: 'blocked', status: 'open', tag: '[conduct seeded touch 1]', wpId: 'WP-01', question: '[conduct seeded touch 1] Q',
    options: [{ key: 'a', label: 'go', consequence: 'go' }], allowFreeText: false, answer: null, file: 'touches/1.md',
  };
  const pending = { id: '1-gate-cmd', phase: 'build', kind: 'shell', step: 'gate-cmd', command: ['node', '--test'], expects: { type: 'exit0' }, seam: 'merge-gate' };
  const runDir = seedRun(f, { touches: [touch], pending, seq: 1 });
  const answerArgv = ['answer', '--run', runDir, '--touch', '1', '--key', 'a'];
  let nested;
  // The operator's answer lands while the agent's record is between its load and its save.
  const racer = { ...shellHandler({}), record: async () => { nested = await f.run(answerArgv, { stdinIsTTY: true }); } };
  const recorded = await record(f, runDir, '1-gate-cmd', { code: 0, stdout: '', stderr: '' }, { importModule: loaderWith({ 'lib/phases/build.mjs': racer }) });
  assert.equal(recorded.code, 0, recorded.stdout);
  assert.equal(nested.code, 2, nested.stdout);
  assert.match(out(nested).error, /locked by pid/);
  assert.equal(readState(runDir).touches[0].status, 'open');
  assert.equal((await f.run(answerArgv, { stdinIsTTY: true })).code, 0);
  assert.equal(readState(runDir).touches[0].status, 'answered');

  writeFileSync(join(runDir, 'state.lock'), JSON.stringify({ pid: 999999, host: hostname(), at: '2026-10-04T18:00:00.000Z', token: 'dead' }));
  const takenOver = await f.run(['next', '--run', runDir], { importModule: loaderWith({ 'lib/phases/build.mjs': shellHandler({}) }), pidAlive: () => false });
  assert.equal(takenOver.code, 0, takenOver.stdout);
  assert.equal(existsSync(join(runDir, 'state.lock')), false);
});

test('C6: a save that fails after its events were appended leaves no duplicate in readEvents', async (t) => {
  const f = fixture(t);
  const first = out(await intake(f, SPINE));
  let failures = 1;
  const rename = (from, to) => {
    if (failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return renameSync(from, to);
  };
  await assert.rejects(record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json'), { rename }), /EPERM/);
  assert.equal(readState(first.runDir).pending.id, first.action.id);
  assert.equal((await record(f, first.runDir, first.action.id, fixtureJson('spine-quest-answered.json'))).code, 0);
  const isRecord = (line) => line.event === 'recorded' && line.actionId === first.action.id;
  assert.equal(rawEvents(first.runDir).filter(isRecord).length, 2);
  assert.equal(events(first.runDir).filter(isRecord).length, 1);
  assert.equal(events(first.runDir).filter((line) => line.event === 'touch-opened').length, 1);
});

test('C7: after a record whose next emit failed, a replay and next both re-emit the same action', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toCoreSpec(f);
  const result = { depth: 'none', workshopDir: readState(runDir).workshopDir, gateCommand: 'node --test' };
  const missing = (relPath) => (relPath === 'lib/phases/build.mjs' ? missingLoader() : testLoader(relPath));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = await record(f, runDir, spec.id, result, { importModule: missing });
    assert.equal(failed.code, 4);
    assert.equal(out(failed).recorded, spec.id);
  }
  const build = loaderWith({ 'lib/phases/build.mjs': shellHandler({}) });
  const replay = out(await record(f, runDir, spec.id, result, { importModule: build }));
  assert.equal(replay.noop, true);
  assert.equal(replay.action.step, 'gate-cmd');
  assert.deepEqual(out(await f.run(['next', '--run', runDir], { importModule: build })).action, replay.action);
});

test('C10: a (c) grant reaches /spec through the --preapproved ref, narrowed scope included', async (t) => {
  const f = fixture(t);
  const { runDir, grant } = await toGrant(f, 'only the hello subcommand');
  writeFileSync(grant.outPath, JSON.stringify({ merge: true, release: false, budgetUsd: 10, scope: 'only the hello subcommand' }));
  const spec = out(await record(f, runDir, grant.id, {})).action;
  assert.deepEqual(spec.skillArgv, [GOAL, '--workshop', readState(runDir).workshopDir, '--preapproved', `core:${runDir}/touches/1-authority.json`]);
  const target = JSON.parse(readFileSync(join(runDir, 'touches', '1-authority.json'), 'utf8'));
  assert.equal(target.scope, 'only the hello subcommand');
  assert.equal(target.validated, true);
  assert.equal(target.answer.key, 'c');
  assert.equal((await record(f, runDir, spec.id, { depth: 'none', workshopDir: readState(runDir).workshopDir, gateCommand: 'node --test' })).code, 0);
  assert.match(readFileSync(join(runDir, 'wp-00.md'), 'utf8'), /^\*\*Approved scope:\*\* only the hello subcommand$/m);
});

test('C11: an operator answer with no usable key re-files the touch; a typed answer with no key is (c)', async (t) => {
  const f = fixture(t);
  const { runDir, readBack } = await toSpineReadBack(f);
  const refiled = out(await record(f, runDir, readBack.id, answeredFor(runDir, 1, { key: 'z' }))).action;
  assert.equal(refiled.tool, 'spine_receipt');
  assert.ok(refiled.args.question.startsWith(`[conduct fixture-run touch 1] (run ${RUN_ID}/2) Your previous answer could not be used`), refiled.args.question);
  const g = fixture(t);
  const flow = await toSpineReadBack(g);
  const grant = out(await record(g, flow.runDir, flow.readBack.id, answeredFor(flow.runDir, 1, { key: null, text: 'only alpha' }))).action;
  assert.equal(grant.step, 'grant');
  assert.equal(readState(flow.runDir).touches[0].answer.text, 'only alpha');
});

test('C12: only workflows that can gate a PR count as CI', async (t) => {
  const f = fixture(t);
  f.table[WORKFLOWS] = captured('gh-actions-workflows-dependabot-only.json');
  const first = out(await intake(f));
  assert.equal(readState(first.runDir).intent.ciWorkflows, 0);
  assert.deepEqual(first.action.touch.options.map((option) => option.key), ['b', 'c', 'd']);
  const g = fixture(t);
  assert.equal(readState(out(await intake(g)).runDir).intent.ciWorkflows, 1);
});

test('C14: recording an unanswered core touch keeps it pending, with no new id', async (t) => {
  const f = fixture(t);
  const { runDir, action } = out(await intake(f));
  const before = { seq: readState(runDir).seq, lines: rawEvents(runDir).length };
  for (let i = 0; i < 2; i += 1) {
    const again = out(await record(f, runDir, action.id, {}));
    assert.equal(again.action.id, action.id);
    assert.equal(again.answered, false);
  }
  assert.equal(readState(runDir).seq, before.seq);
  assert.equal(rawEvents(runDir).length, before.lines);
});

test('C15: validateGrant refuses a release without merge', () => {
  const checked = validateGrant({ merge: false, release: true, budgetUsd: 5, scope: GOAL }, { merge: true, release: true, budgetUsd: 25 }, GOAL);
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join(';'), /release requires merge/);
});

test('C16: any failure after a durable record reports recorded', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toCoreSpec(f);
  const broken = loaderWith({ 'lib/phases/build.mjs': { next: () => { throw new TypeError('boom'); }, record: () => {} } });
  const result = await record(f, runDir, spec.id, { depth: 'none', workshopDir: readState(runDir).workshopDir, gateCommand: 'node --test' }, { importModule: broken });
  assert.equal(result.code, 1);
  assert.equal(out(result).recorded, spec.id);
  assert.match(out(result).error, /boom/);
  assert.equal(readState(runDir).lastRecorded, spec.id);
});

test('C17: a missing --result-file is a structured exit 2 naming the path', async (t) => {
  const f = fixture(t);
  const { runDir, action } = out(await intake(f));
  const missing = join(f.dir, 'no-such-result.json');
  const result = await f.run(['record', '--run', runDir, '--action', action.id, '--result-file', missing]);
  assert.equal(result.code, 2);
  assert.ok(out(result).error.includes(missing));
});

test('C18: skillArgv carries a goal with quotes and flag-like text as one argument', async (t) => {
  const f = fixture(t);
  const goal = 'say "hi" --workshop elsewhere';
  const first = out(await intake(f, [], {}, goal));
  assert.equal((await answer(f, first.runDir, 'a')).code, 0);
  const spec = out(await record(f, first.runDir, first.action.id, {})).action;
  assert.equal(spec.skillArgv[0], goal);
  assert.equal(spec.skillArgv.filter((arg) => arg === '--workshop').length, 1);
});

test('C19, C20: gh auth is scoped to github.com; next --resume is next --run', async (t) => {
  const f = fixture(t);
  const { runDir, action } = out(await intake(f));
  assert.ok(f.calls.includes('gh auth status --hostname github.com'), f.calls.join('\n'));
  const resumed = await f.run(['next', '--resume', runDir]);
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.deepEqual(out(resumed).action, action);
});

test('C22: intake from a subdirectory uses the work-tree root; a refusal never echoes URL credentials', async (t) => {
  const f = fixture(t);
  const sub = join(f.repo, 'sub');
  f.table[`git -C ${sub} rev-parse --is-inside-work-tree`] = { code: 0, stdout: 'true\n', stderr: '' };
  f.table[`git -C ${sub} rev-parse --show-toplevel`] = { code: 0, stdout: `${f.repo}\n`, stderr: '' };
  const first = out(await f.run(['intake', '--goal', GOAL, '--repo', sub, '--runs-root', f.runs]));
  assert.equal(readState(first.runDir).intent.repo.path, f.repo);
  const g = fixture(t);
  g.table[`git -C ${g.repo} config --get remote.origin.url`] = { code: 0, stdout: 'https://deploy:s3cret-token@gitlab.example.com/a/b.git\n', stderr: '' };
  const refused = await intake(g);
  assert.equal(refused.code, 2);
  assert.ok(!refused.stdout.includes('s3cret-token') && !refused.stderr.includes('s3cret-token'), refused.stdout);
  assert.match(out(refused).error, /<redacted>@gitlab\.example\.com/);
});

test('C23: workshop paths compare case-insensitively and in Git Bash form on win32', () => {
  assert.equal(samePath('D:\\Dev\\Workshops\\Goal', '/d/dev/workshops/goal', 'win32'), true);
  assert.equal(samePath('D:\\Dev\\Goal', 'd:/DEV/goal/', 'win32'), true);
  assert.equal(samePath('D:\\Dev\\Goal', 'C:\\Dev\\Goal', 'win32'), false);
  assert.equal(samePath('/tmp/Goal', '/tmp/goal', 'linux'), false);
});

test('C24: --text keeps a value that starts with --; --agent names the missing agent', async (t) => {
  const f = fixture(t);
  const first = out(await intake(f));
  assert.equal((await answer(f, first.runDir, 'c', { text: '--skip release' })).code, 0);
  assert.equal(readState(first.runDir).touches[0].answer.text, '--skip release');
  const g = fixture(t);
  const refused = await intake(g, ['--agent', 'codex']);
  assert.equal(refused.code, 2);
  assert.match(out(refused).error, /refusal 5: --agent codex is not available: spawnSync codex ENOENT/);
});

// ---- Amendment 2: council round 2 findings (ids D1–D12) ----

function lockDeps(dir, more = {}) {
  return {
    write: (path, value) => writeFileSync(path, value), read: (path) => readFileSync(path, 'utf8'), exists: existsSync,
    link: linkSync, remove: (path) => rmSync(path, { force: true }), pidAlive, pid: process.pid, hostname: hostname(),
    now: () => Date.now(), timestamp: () => new Date().toISOString(), sleep: async () => {}, lockWaitMs: 0, ...more,
  };
}
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-conduct-a2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('D1: an unreadable lock is contention, never stale; the lock is linked whole', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'state.lock'), '');
  await assert.rejects(withStateLock(dir, lockDeps(dir), async () => 'ran'), /unreadable/);
  assert.equal(readFileSync(join(dir, 'state.lock'), 'utf8'), '');
  rmSync(join(dir, 'state.lock'));
  let atLink;
  const deps = lockDeps(dir, { link: (from, to) => { atLink = JSON.parse(readFileSync(from, 'utf8')); linkSync(from, to); } });
  assert.equal(await withStateLock(dir, deps, async () => JSON.parse(readFileSync(join(dir, 'state.lock'), 'utf8')).token), atLink.token);
  assert.deepEqual(readdirSync(dir), []);
});

test('D1: age never evicts a live holder on this host; a holder on another host ages out', async (t) => {
  const dir = tempDir(t);
  const live = { pid: process.pid, host: hostname(), at: '2020-01-01T00:00:00.000Z', token: 'live' };
  writeFileSync(join(dir, 'state.lock'), JSON.stringify(live));
  await assert.rejects(withStateLock(dir, lockDeps(dir), async () => 'ran'), /locked by pid/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.lock'), 'utf8')).token, 'live');
  writeFileSync(join(dir, 'state.lock'), JSON.stringify({ ...live, host: 'elsewhere' }));
  assert.equal(await withStateLock(dir, lockDeps(dir), async () => 'ran'), 'ran');
});

test('D1: release never removes a successor\'s lock', async (t) => {
  const dir = tempDir(t);
  const successor = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: 'successor' });
  await withStateLock(dir, lockDeps(dir), async () => { writeFileSync(join(dir, 'state.lock'), successor); });
  assert.equal(readFileSync(join(dir, 'state.lock'), 'utf8'), successor);
});

test('D12: a writer polls a held lock and takes it once the holder releases', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'state.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: 'held' }));
  let polls = 0;
  const deps = lockDeps(dir, { lockWaitMs: 1000, sleep: async () => { polls += 1; rmSync(join(dir, 'state.lock')); } });
  assert.equal(await withStateLock(dir, deps, async () => 'ran'), 'ran');
  assert.equal(polls, 1);
});

test('D2: a failed save\'s event stays invisible after an event-free retry of its rev; history stays visible; no temp is left', (t) => {
  const dir = tempDir(t);
  const deps = { ...lockDeps(dir), append: (path, value) => appendFileSync(path, value), rename: renameSync, truncate: truncateSync };
  const load = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const first = { runDir: dir, phase: 'build', seq: 0, rev: 0, txns: [] };
  appendEvent(first, deps, { event: 'kept' });
  saveState(first, deps);
  const failing = load();
  appendEvent(failing, deps, { event: 'orphan' });
  assert.throws(() => saveState(failing, { ...deps, rename: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } }), /EPERM/);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  saveState(load(), deps); // the retry of rev 2 carries no events
  const later = load();
  appendEvent(later, deps, { event: 'later' });
  saveState(later, deps);
  assert.deepEqual(rawEvents(dir).map((line) => line.event), ['kept', 'orphan', 'later']);
  assert.deepEqual(readEvents(dir, fsDeps, load()).map((line) => line.event), ['kept', 'later']);
});

test('D5: a torn trailing event line is dropped and cut before the next append; corruption elsewhere exits 2', (t) => {
  const dir = tempDir(t);
  const deps = { ...lockDeps(dir), append: (path, value) => appendFileSync(path, value), rename: renameSync, truncate: truncateSync };
  const load = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const state = { runDir: dir, phase: 'build', seq: 0, rev: 0, txns: [] };
  appendEvent(state, deps, { event: 'one' });
  saveState(state, deps);
  appendFileSync(join(dir, 'events.jsonl'), '{"ts":"2026-10-04T19:00:00.000Z","ev');
  assert.deepEqual(readEvents(dir, fsDeps, load()).map((line) => line.event), ['one']);
  const next = load();
  appendEvent(next, deps, { event: 'two' });
  saveState(next, deps);
  assert.deepEqual(readEvents(dir, fsDeps, load()).map((line) => line.event), ['one', 'two']);
  writeFileSync(join(dir, 'events.jsonl'), `not json\n${readFileSync(join(dir, 'events.jsonl'), 'utf8')}`);
  assert.throws(() => readEvents(dir, fsDeps, load()), (error) => error.code === 2 && /line 1 is not valid JSON/.test(error.message));
});

test('D3: a grant record whose save failed is retried from the authored grant, which stays as written', async (t) => {
  const f = fixture(t);
  const { runDir, grant } = await toGrant(f, 'cap it at $10');
  const authored = JSON.stringify({ merge: true, release: false, budgetUsd: 10, scope: GOAL });
  writeFileSync(grant.outPath, authored);
  let failures = 1;
  const rename = (from, to) => {
    if (failures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return renameSync(from, to);
  };
  await assert.rejects(record(f, runDir, grant.id, {}, { rename }), /EPERM/);
  assert.equal(readFileSync(grant.outPath, 'utf8'), authored);
  const retried = await record(f, runDir, grant.id, {});
  assert.equal(retried.code, 0, retried.stdout);
  assert.equal(readFileSync(grant.outPath, 'utf8'), authored);
  assert.equal(readState(runDir).authority.record, 'touches/1-authority.json');
});

test('D8: a post-record failure keeps its details and its cause', async (t) => {
  const f = fixture(t);
  const { runDir, spec } = await toCoreSpec(f);
  const result = { depth: 'none', workshopDir: readState(runDir).workshopDir, gateCommand: 'node --test' };
  const detailed = Object.assign(new ConductError(2, 'handler says no'), { details: { hint: 'look here' } });
  const g = await record(f, runDir, spec.id, result, { importModule: loaderWith({ 'lib/phases/build.mjs': { next: () => { throw detailed; }, record: () => {} } }) });
  assert.deepEqual([out(g).hint, out(g).recorded], ['look here', spec.id]);
  const h = await record(f, runDir, spec.id, result, { importModule: loaderWith({ 'lib/phases/build.mjs': { next: () => { throw new TypeError('boom'); }, record: () => {} } }) });
  assert.equal(h.code, 1);
  assert.match(h.stderr, /TypeError: boom\n\s+at /);
});

test('D9: next, record and answer on a missing run dir exit 2, structured', async (t) => {
  const f = fixture(t);
  const missing = join(f.dir, 'no-such-run');
  for (const argv of [['next', '--run', missing], ['record', '--run', missing, '--action', '1-x', '--result', '{}'], ['answer', '--run', missing, '--touch', '1', '--key', 'a']]) {
    const result = await f.run(argv, { stdinIsTTY: true });
    assert.equal(result.code, 2, argv[0]);
    assert.match(out(result).error, /no run directory at/);
  }
});

test('D11: workflow discovery reads every page', async (t) => {
  const f = fixture(t);
  const [, dependabot] = captured('gh-actions-workflows.json').stdout.split('\n');
  const ci = captured('gh-actions-workflows.json').stdout.split('\n')[0];
  const pageOne = `${Array(100).fill(dependabot).join('\n')}\n`;
  f.table[WORKFLOWS] = { code: 0, stdout: `${pageOne}${ci}\n`, stderr: '' };
  f.table[WORKFLOWS.replace(' --paginate', '')] = { code: 0, stdout: pageOne, stderr: '' };
  assert.equal(readState(out(await intake(f)).runDir).intent.ciWorkflows, 1);
});

test('D12: samePath takes a bare Git Bash drive', () => {
  assert.equal(samePath('/d', 'D:\\', 'win32'), true);
});

const PRIVATE_PATHS = [/[A-Za-z]:[\\/]+(Users|Development)\b/i, /[\\/]Users[\\/][^\\/\s"]+[\\/]/];
// C9: host names and LAN URLs. A dotless host is a LAN name; private IPv4
// ranges, `localhost:` and `.local` names are LAN addresses.
const HOST_SHAPES = [
  /:\/\/[a-z0-9-]+(?=[:/\s"]|$)/i,
  /:\/\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
  /\blocalhost:\d/i,
  /:\/\/[a-z0-9.-]+\.(local|lan|internal|home\.arpa)\b/i,
];
const privatePathHits = (text) => [...PRIVATE_PATHS, ...HOST_SHAPES].filter((pattern) => pattern.test(text)).map(String);

test('fixture paths: no private-path, host-name or LAN-URL shapes under __fixtures__/intake', (t) => {
  const files = readdirSync(FIXTURES);
  assert.ok(files.length >= 9, files.join(', '));
  for (const name of files) assert.deepEqual(privatePathHits(readFileSync(join(FIXTURES, name), 'utf8')), [], name);
  // Controls: the same check flags a copy with each shape inserted (built at
  // run time, so this file stays clean).
  const dir = mkdtempSync(join(tmpdir(), 'workit-conduct-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = readFileSync(join(FIXTURES, 'gh-repo-view.json'), 'utf8');
  const inserts = [
    ['C:', 'Users', 'someone', 'x'].join('\\'),
    ['http:', '', 'somehost:3100'].join('/'),
    ['http:', '', ['192', '168', '1', '5'].join('.')].join('/'),
    ['localhost', '8080'].join(':'),
    ['http:', '', ['printer', 'local'].join('.')].join('/'),
    ['http:', '', ['nas', 'lan'].join('.')].join('/'),
    ['https:', '', ['build', 'internal'].join('.')].join('/'),
    ['http:', '', ['router', 'home', 'arpa'].join('.')].join('/'),
  ];
  for (const [i, insert] of inserts.entries()) {
    const copy = join(dir, `copy-${i}.json`);
    writeFileSync(copy, text.replace('"stderr": ""', `"stderr": ${JSON.stringify(insert)}`));
    assert.notDeepEqual(privatePathHits(readFileSync(copy, 'utf8')), [], insert);
  }
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
