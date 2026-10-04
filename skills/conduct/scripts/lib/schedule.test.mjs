import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkPackages, filesDisjoint, dispatchable } from './schedule.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSHOP = join(HERE, '..', '__fixtures__', 'lanes', 'workshop');
const C = 'skills/conduct/scripts';

const EXPECTED_FILES = {
  'WP-01': [`${C}/conduct.mjs`, `${C}/lib/state.mjs`, `${C}/lib/exec.mjs`, `${C}/lib/adapters.mjs`, `${C}/lib/touch.mjs`, `${C}/lib/recipe.mjs`,
    `${C}/lib/phases/intake.mjs`, `${C}/lib/phases/preapproval.mjs`, `${C}/lib/phases/spec.mjs`, `${C}/lib/phases/mint.mjs`,
    `${C}/conduct.test.mjs`, `${C}/__fixtures__/intake/`],
  'WP-02': [`${C}/lib/schedule.mjs`, `${C}/lib/lanes.mjs`, 'skills/conduct/templates/lane-brief.md', `${C}/lib/schedule.test.mjs`,
    `${C}/lib/lanes.test.mjs`, `${C}/__fixtures__/lanes/`],
  'WP-03': [`${C}/lib/land.mjs`, `${C}/lib/release.mjs`, '.workit/conduct.json', `${C}/lib/land.test.mjs`, `${C}/lib/release.test.mjs`,
    `${C}/__fixtures__/land/`],
  'WP-04': [`${C}/lib/phases/build.mjs`, `${C}/lib/phases/build.test.mjs`, `${C}/__fixtures__/build/`],
  'WP-05': ['skills/conduct/SKILL.md', 'skills/spec/SKILL.md', 'reference/patterns/work-package.md', 'reference/templates/_orchestrator.template.md',
    'README.md', 'AGENTS.md', 'skills/_shared/delegated-skills.test.mjs', 'reference/templates/lane-contract.template.md',
    'skills/spec-validate/SKILL.md', 'skills/spec-validate/scripts/validate.mjs', 'skills/spec-validate/tests/validate.test.mjs',
    'skills/spec-validate/tests/fixtures/canonical-spec/work-packages/'],
  'WP-06': [`${C}/lib/phases/release.mjs`, `${C}/lib/phases/analyze.mjs`, `${C}/lib/phases/showcase.mjs`, `${C}/lib/analyze.mjs`,
    `${C}/lib/phases/mint.mjs`, `${C}/conduct.test.mjs`, `${C}/conduct.seam.test.mjs`, `${C}/__fixtures__/seam/`],
};

const parsed = () => new Map(parseWorkPackages(WORKSHOP).map((wp) => [wp.id, wp]));

test('parseWorkPackages: the run workshop, exact files in Files order', () => {
  const wps = parsed();
  assert.deepEqual([...wps.keys()], ['WP-01', 'WP-02', 'WP-03', 'WP-04', 'WP-05', 'WP-06']);
  for (const [id, files] of Object.entries(EXPECTED_FILES)) assert.deepEqual(wps.get(id).files, files, id);
  assert.equal(wps.get('WP-02').specPath, join(WORKSHOP, 'work-packages', 'wp-02-schedule-lanes.md'));
  assert.equal(wps.get('WP-04').name, 'The build phase');
});

test('parseWorkPackages: wave, model, dependsOn, tier and runtimeExercise', () => {
  const wps = [...parsed().values()];
  assert.deepEqual(wps.map((wp) => wp.wave), [1, 2, 2, 3, 3, 4]);
  assert.deepEqual(wps.map((wp) => wp.model), ['opus', 'opus', 'opus', 'opus', 'sonnet', 'opus']);
  assert.deepEqual(Object.fromEntries(wps.map((wp) => [wp.id, wp.dependsOn])), {
    'WP-01': [], 'WP-02': ['WP-01'], 'WP-03': ['WP-01'], 'WP-04': ['WP-02', 'WP-03'],
    'WP-05': ['WP-01', 'WP-02', 'WP-03'], 'WP-06': ['WP-04', 'WP-05'],
  });
  assert.deepEqual(wps.map((wp) => wp.tier), Array(6).fill('T2'));
  for (const wp of wps) assert.ok(wp.runtimeExercise.length > 0, wp.id);
  assert.match(parsed().get('WP-02').runtimeExercise, /^CLI \+ a real detached agent\./);
  assert.doesNotMatch(parsed().get('WP-02').runtimeExercise, /Negative controls/);
});

test('filesDisjoint on the run workshop (D17, D19.29)', () => {
  const wps = parsed();
  const files = (id) => wps.get(id).files;
  const disjoint = [['WP-02', 'WP-03'], ['WP-04', 'WP-05'], ['WP-04', 'WP-06'], ['WP-05', 'WP-06']];
  for (const n of [1, 2, 3]) disjoint.push([`WP-0${n}`, 'WP-04'], [`WP-0${n}`, 'WP-05']);
  for (const [a, b] of disjoint) assert.equal(filesDisjoint(files(a), files(b)), true, `${a} ${b}`);
  assert.equal(filesDisjoint(files('WP-01'), files('WP-06')), false);
});

test('filesDisjoint: equal after normalizing, and a directory contains its files', () => {
  assert.equal(filesDisjoint(['a/b.mjs'], ['a\\b.mjs']), false);
  assert.equal(filesDisjoint(['a/fixtures/'], ['a/fixtures/x.json']), false);
  assert.equal(filesDisjoint(['a/fixtures/x.json'], ['a/fixtures/']), false);
  assert.equal(filesDisjoint(['a/fixtures/'], ['a/fixtures-2/x.json']), true);
  assert.equal(filesDisjoint(['a/b.mjs'], ['a/b.mjs.bak']), true);
});

test('paths (C1-12): case and dot-segment aliases conflict; a path leaving the repository is refused at parse', (t) => {
  assert.equal(filesDisjoint(['src/Worker.mjs'], ['src/worker.mjs']), false);
  assert.equal(filesDisjoint(['src/../README.md'], ['README.md']), false);
  assert.equal(filesDisjoint(['./src/a.mjs'], ['src/A.MJS']), false);
  assert.equal(filesDisjoint(['SRC/'], ['src/x.mjs']), false);
  assert.equal(filesDisjoint(['../outside.mjs'], ['inside.mjs']), false, 'an escaping path conflicts with everything');
  const shared = [wp('WP-01', 'pending', ['src/Worker.mjs']), wp('WP-02', 'pending', ['src/worker.mjs'])];
  assert.deepEqual(ids(dispatchable(run(shared))), ['WP-01']);
  const dir = workshop(t, { 'WP-01': { wave: 1, model: 'opus', body: '**Files:**\n- Create `src/../lib/./a.mjs`\n- Modify `docs\\b.md`\n' } });
  assert.deepEqual(parseWorkPackages(dir)[0].files, ['lib/a.mjs', 'docs/b.md']);
  for (const bad of ['../x.mjs', '/etc/passwd', 'C:/x.mjs', 'a/../../x.mjs']) {
    const escaping = workshop(t, { 'WP-01': { wave: 1, model: 'opus', body: `**Files:**\n- Create \`${bad}\`\n` } });
    assert.throws(() => parseWorkPackages(escaping), (error) => error.code === 2 && error.message.includes('WP-01') && error.message.includes(bad), bad);
  }
});

test('wave plan (C2-5): nested brackets in a name are not wave references; a WP in two waves is a parse error', (t) => {
  const dir = workshop(t, {
    'WP-01': { wave: 1, model: 'opus', body: '**Files:**\n- Create `a.mjs`\n' },
    'WP-02': { wave: 2, model: 'opus', body: '**Files:**\n- Create `b.mjs`\n' },
  }, { waveNames: { 'WP-02': 'follows [WP-01]' } });
  const wps = parseWorkPackages(dir);
  assert.deepEqual(wps.map((item) => [item.id, item.wave, item.dependsOn]), [['WP-01', 1, []], ['WP-02', 2, ['WP-01']]]);
  assert.deepEqual(ids(dispatchable(run(wps.map((item) => ({ ...item, state: 'pending' }))))), ['WP-01']);
  const twice = workshop(t, {
    'WP-01': { wave: 1, model: 'opus', body: '**Files:**\n- Create `a.mjs`\n' },
    'WP-02': { wave: 2, model: 'opus', body: '**Files:**\n- Create `b.mjs`\n' },
  }, { waveNames: { 'WP-02': 'x] [WP-01: again' } });
  assert.throws(() => parseWorkPackages(twice), (error) => error.code === 2 && /WP-01 is in two waves/.test(error.message));
});

test('paths (C2-6): drive prefixes refused; trailing dots and spaces dropped; a directory without a slash contains its files', (t) => {
  for (const bad of ['C:x.mjs', 'C:../x.mjs', 'C:/x.mjs', 'c:\\x.mjs']) {
    const dir = workshop(t, { 'WP-01': { wave: 1, model: 'opus', body: `**Files:**\n- Create \`${bad}\`\n` } });
    assert.throws(() => parseWorkPackages(dir), (error) => error.code === 2 && error.message.includes(bad), bad);
    assert.equal(filesDisjoint([bad], ['x.mjs']), false, bad);
  }
  assert.equal(filesDisjoint(['a.mjs.'], ['a.mjs']), false);
  assert.equal(filesDisjoint(['src/lib. /a.mjs '], ['src/lib/a.mjs']), false);
  assert.equal(filesDisjoint(['src/lib'], ['src/lib/a.mjs']), false);
  assert.equal(filesDisjoint(['src/lib/a.mjs'], ['src/lib']), false);
  assert.equal(filesDisjoint(['src/lib'], ['src/library.mjs']), true);
});

test('model labels (C1-15): an unknown inventory label fails at parse, naming the WP and the label', (t) => {
  const dir = workshop(t, { 'WP-01': { wave: 1, model: 'Opus 5.5', body: '**Files:**\n- Create `a.mjs`\n' } });
  assert.throws(() => parseWorkPackages(dir), (error) => error.code === 2 && /WP-01/.test(error.message) && /Opus 5\.5/.test(error.message));
  const known = workshop(t, { 'WP-01': { wave: 1, model: 'Sonnet', body: '**Files:**\n- Create `a.mjs`\n' } });
  assert.equal(parseWorkPackages(known)[0].model, 'Sonnet');
});

test('wave plan (C1-17): a WP id inside another WP\'s name is not wave membership', (t) => {
  const dir = workshop(t, {
    'WP-01': { wave: 1, model: 'opus', body: '**Files:**\n- Create `a.mjs`\n' },
    'WP-02': { wave: 2, model: 'opus', body: '**Files:**\n- Create `b.mjs`\n' },
  }, { waveNames: { 'WP-02': 'follows WP-01' } });
  assert.deepEqual(parseWorkPackages(dir).map((item) => [item.id, item.wave]), [['WP-01', 1], ['WP-02', 2]]);
});

test('empty files fail safe (D18)', (t) => {
  assert.equal(filesDisjoint([], ['x.mjs']), false);
  assert.equal(filesDisjoint(['x.mjs'], []), false);
  assert.equal(filesDisjoint([], []), false);
  const dir = workshop(t, {
    'WP-01': { wave: 1, model: '-', body: '**Files:**\n- the state module, in prose\n- also the tests\n' },
    'WP-02': { wave: 1, model: '-', body: '**Files:**\n- write `lib/b.mjs` somewhere\n' },
  });
  const wps = parseWorkPackages(dir);
  assert.deepEqual(wps.map((wp) => [wp.files, wp.model]), [[[], 'opus'], [[], 'opus']]);
  const [a, b] = wps;
  const other = { id: 'WP-09', files: ['z.mjs'], dependsOn: [] };
  assert.deepEqual(ids(dispatchable(run([{ ...a, state: 'dispatched' }, { ...other, state: 'pending' }], 2))), []);
  assert.deepEqual(ids(dispatchable(run([{ ...other, state: 'dispatched' }, { ...b, state: 'pending' }], 2))), []);
  // Alone, an empty-files WP runs, and holds the run to itself.
  assert.deepEqual(ids(dispatchable(run([{ ...a, state: 'pending' }, { ...other, state: 'pending' }], 2))), ['WP-01']);
});

test('Files list ends at the next field label (D19)', (t) => {
  const dir = workshop(t, {
    'WP-01': {
      wave: 1, model: 'opus',
      body: '**Files:**\n- Create `a.mjs`: with **bold text** inside the bullet\n- Modify `lib/{b,c}.mjs` and `not-this.mjs`\n'
        + '**Phase behavior:**\n- Create `x.mjs`\n\n**Review tier:** T2\n',
    },
  });
  const [wp] = parseWorkPackages(dir);
  assert.deepEqual(wp.files, ['a.mjs', 'lib/b.mjs', 'lib/c.mjs']);
  assert.equal(wp.tier, 'T2');
});

test('parseWorkPackages: tier defaults to T1, a missing Model column to opus, a missing Runtime exercise to empty', (t) => {
  const dir = workshop(t, { 'WP-01': { wave: 1, body: '**Files:**\n- Create `a.mjs`\n' } }, { modelColumn: false });
  const [wp] = parseWorkPackages(dir);
  assert.deepEqual([wp.tier, wp.model, wp.runtimeExercise], ['T1', 'opus', '']);
});

// A tier a WP quotes does not supply or lower its tier (workit#155 C1-2).
const tierOf = (t, body) => parseWorkPackages(workshop(t, { 'WP-01': { wave: 1, model: 'opus', body: `**Files:**\n- Create \`a.mjs\`\n\n${body}` } }))[0].tier;

test('tier: a quoted tier does not count (fence, inline code, blockquote); a real declaration after it wins', (t) => {
  assert.equal(tierOf(t, '```\n**Review tier:** T0\n```\n'), 'T1', 'a fenced tier alone is no declaration');
  assert.equal(tierOf(t, 'Write `**Review tier:** T0|T1|T2` here.\n'), 'T1', 'an inline-code tier alone is no declaration');
  assert.equal(tierOf(t, '> **Review tier:** T0\n'), 'T1', 'a quoted tier alone is no declaration');
  assert.equal(tierOf(t, '```\n**Review tier:** T0\n```\n> **Review tier:** T0\nExample: `**Review tier:** T0`\n\n**Review tier:** T2\n'), 'T2', 'quoted T0 before a real T2: T2 wins');
  assert.equal(tierOf(t, '**Execution:** review-needed · **Review tier:** T2 (adds tests) · **Lane model:** x\n'), 'T2', 'the mid-line form stands');
});

test('tier: two different real declarations, or a value outside T0|T1|T2, is a parse error', (t) => {
  assert.throws(() => tierOf(t, '**Review tier:** T0\n\n**Review tier:** T2\n'), /conflicting \*\*Review tier:\*\* declarations \(T0, T2\)/);
  assert.throws(() => tierOf(t, '**Review tier:** T3\n'), /value "T3" is not T0, T1 or T2/);
  assert.throws(() => tierOf(t, '**Review tier:** T0|T1|T2\n'), /value "T0\|T1\|T2" is not T0, T1 or T2/);
  assert.equal(tierOf(t, '**Review tier:** T2\n\n**Review tier:** T2,\n'), 'T2', 'the same value twice is one declaration');
});

const wp = (id, state, files, dependsOn = []) => ({ id, state, files, dependsOn });
const run = (wps, lanesCap = 2, extra = {}) => ({ intent: { lanesCap }, wps, dispatchHalt: null, ...extra });
const ids = (wps) => wps.map((item) => item.id);

test('dispatchable: dependencies, shared files, the lane cap and dispatchHalt', () => {
  const wps = parsed();
  const at = (states) => [...wps.values()].map((item) => ({ ...item, state: states[item.id] ?? 'pending' }));
  assert.deepEqual(ids(dispatchable(run(at({ 'WP-01': 'merged' })))), ['WP-02', 'WP-03']);
  assert.deepEqual(ids(dispatchable(run(at({ 'WP-01': 'gate' })))), []);
  assert.deepEqual(ids(dispatchable(run(at({}), 2))), ['WP-01']);
  // Two pending WPs sharing a file: one.
  assert.deepEqual(ids(dispatchable(run([wp('WP-01', 'pending', ['a.mjs', 'b.mjs']), wp('WP-02', 'pending', ['b.mjs'])]))), ['WP-01']);
  // One live lane, cap 2: at most one more.
  const three = [wp('WP-01', 'review', ['a']), wp('WP-02', 'pending', ['b']), wp('WP-03', 'pending', ['c'])];
  assert.deepEqual(ids(dispatchable(run(three, 2))), ['WP-02']);
  assert.deepEqual(ids(dispatchable(run(three, 1))), []);
  assert.deepEqual(ids(dispatchable(run(at({ 'WP-01': 'merged' }), 2, { dispatchHalt: { reason: 'budget', since: 'x' } }))), []);
});

test('dispatchable: held and blocked WPs hold no slot (D12)', () => {
  const wps = [wp('WP-01', 'held', ['a']), wp('WP-02', 'blocked', ['b']), wp('WP-03', 'pending', ['c']), wp('WP-04', 'pending', ['d'])];
  assert.deepEqual(ids(dispatchable(run(wps, 2))), ['WP-03', 'WP-04']);
  for (const state of ['deferred', 'merged', 'refuted']) {
    assert.deepEqual(ids(dispatchable(run([wp('WP-01', state, ['a']), wp('WP-02', 'pending', ['b'])], 1))), ['WP-02'], state);
  }
});

test('dispatchable: a WP depending on a held, blocked or refuted WP is never dispatchable', () => {
  for (const state of ['held', 'blocked', 'refuted']) {
    const wps = [wp('WP-01', 'merged', ['a']), wp('WP-02', state, ['b']), wp('WP-03', 'pending', ['c'], ['WP-01', 'WP-02'])];
    assert.deepEqual(ids(dispatchable(run(wps, 2))), [], state);
  }
});

// A workshop in a temp dir: an orchestrator naming each WP's wave and model,
// and one wp-*.md per WP with the given body.
function workshop(t, wps, { modelColumn = true, waveNames = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-schedule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packages = join(dir, 'work-packages');
  mkdirSync(packages);
  const entries = Object.entries(wps);
  const plan = [...new Set(entries.map(([, spec]) => spec.wave))].map((wave) => `Wave ${wave}: ${entries.filter(([, spec]) => spec.wave === wave).map(([id]) => `[${id}: ${waveNames[id] ?? 'x'}]`).join(' ')}`);
  const rows = entries.map(([id, spec]) => (modelColumn ? `| ${id}: name ${id} | ${spec.wave} | p | s | ${spec.model} |` : `| ${id}: name ${id} | ${spec.wave} | p | s |`));
  const header = modelColumn ? ['| Package | Wave | Project | Spec | Model |', '|---|---|---|---|---|'] : ['| Package | Wave | Project | Spec |', '|---|---|---|---|'];
  writeFileSync(join(packages, '_orchestrator.md'), ['# O', '', '## Wave Plan', '', ...plan, '', '## Package Inventory', '', ...header, ...rows, ''].join('\n'));
  for (const [id, spec] of entries) writeFileSync(join(packages, `${id.toLowerCase()}-x.md`), `# ${id}: name ${id}\n\n${spec.body}`);
  return dir;
}
