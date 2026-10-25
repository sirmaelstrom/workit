import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runConduct } from '../conduct.mjs';
import { BACKGROUND_TIMEOUT_MS, SHELL_TIMEOUT_MS, fillTemplate } from './drive.mjs';
import { runArgv } from './exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// A build phase that emits the given actions in order, then done, and keeps
// what record handed it. Nothing here runs a real program: runArgv is a fake.
function fixture(t, specs, { patch = {}, shell = () => ({ code: 0, stdout: 'ok\n', stderr: '' }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-drive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({
    schemaVersion: 1, slug: 'seeded', runId: 'abcd1234', rev: 0, runDir, workshopDir: dir, pluginRoot: join(dir, 'plugin'),
    intent: { goal: 'drive fixture', anchor: null }, agents: {}, adapters: { spine: { on: false } }, phase: 'build',
    touches: [], wps: [], handover: null, pending: null, lastRecorded: null, seq: 0, ...patch,
  }));
  const queue = [...specs];
  const recorded = [];
  const build = { next: () => queue.shift() ?? { kind: 'done' }, record: (state, action, result) => { recorded.push({ id: action.id, result }); } };
  const runs = [];
  const sleeps = [];
  let clock = Date.parse('2026-10-25T12:00:00.000Z');
  const deps = {
    env: { BASE: '1' }, platform: 'linux', home: join(dir, 'home'), stdinIsTTY: false, pluginRoot: join(dir, 'plugin'),
    now: () => clock, timestamp: () => new Date((clock += 1000)).toISOString(), lockWaitMs: 0,
    sleep: async (ms) => { sleeps.push(ms); },
    runArgv: (program, args, options) => { runs.push({ program, args, options }); return shell(program, args, options); },
    importModule: (rel) => (rel === 'lib/phases/build.mjs' ? build : import(pathToFileURL(join(HERE, '..', rel)).href)),
  };
  const run = (argv, more = {}) => runConduct(argv, { ...deps, ...more });
  return { dir, runDir, queue, recorded, runs, sleeps, run, drive: (extra = []) => run(['drive', '--run', runDir, ...extra]) };
}

const out = (result) => JSON.parse(result.stdout);
const state = (f) => JSON.parse(readFileSync(join(f.runDir, 'state.json'), 'utf8'));
const logLines = (f) => readFileSync(join(f.runDir, 'drive.log'), 'utf8').trim().split('\n');

const SHELL = { kind: 'shell', step: 'gate-cmd', part: 'run', command: ['node', '--test'], cwd: '/repo', env: { GATE: 'x' }, expects: { type: 'exit0' } };
const WAIT = { kind: 'wait', step: 'wait', waitMs: 60000, instruction: 'Wait 60 s.' };
const TOOL = { kind: 'agent-tool', step: 'start', tool: 't3_thread_launch', args: {}, expects: { type: 'json' } };

test('drive: performs shell, wait and a template author, records each, and stops at an agent-tool', async (t) => {
  const g = fixture(t, []);
  const template = join(g.dir, 'brief.template.md');
  writeFileSync(template, 'Lane <lane id>\nBase <base sha>\n');
  const outPath = join(g.dir, 'lane-wp-01.md');
  const AUTHOR = { kind: 'author', step: 'brief', part: 'brief', template, outPath, slots: { '<lane id>': 'wp-01', '<base sha>': 'abc' }, expects: { type: 'file' } };
  g.queue.push({ ...SHELL, background: true }, WAIT, AUTHOR, TOOL);
  const result = await g.drive();
  assert.equal(result.code, 0, result.stdout);
  const printed = out(result);
  assert.equal(printed.ok, true);
  assert.equal(printed.stopped, 'needs-conductor');
  assert.equal(printed.action.kind, 'agent-tool');
  assert.equal(printed.steps, 3);
  assert.deepEqual(printed.performed.map((step) => step.kind), ['shell', 'wait', 'author']);
  // The shell argv exactly, from cwd, with env added and the background timeout.
  assert.deepEqual(g.runs.map(({ program, args }) => [program, ...args]), [['node', '--test']]);
  assert.equal(g.runs[0].options.cwd, '/repo');
  assert.deepEqual(g.runs[0].options.env, { BASE: '1', GATE: 'x' });
  assert.equal(g.runs[0].options.timeout, BACKGROUND_TIMEOUT_MS);
  assert.deepEqual(g.sleeps, [60000]);
  assert.equal(readFileSync(outPath, 'utf8'), 'Lane wp-01\nBase abc\n');
  assert.deepEqual(g.recorded.map(({ result: r }) => r), [{ code: 0, stdout: 'ok\n', stderr: '' }, {}, {}]);
  // The agent-tool is left pending for the conductor.
  assert.equal(state(g).pending.kind, 'agent-tool');
  assert.equal(state(g).pending.id, printed.action.id);
  assert.equal(existsSync(join(g.runDir, 'drive.lock')), false, 'drive.lock is released');
});

test('drive: a foreground shell gets the foreground timeout', async (t) => {
  const f = fixture(t, [SHELL, TOOL]);
  assert.equal((await f.drive()).code, 0);
  assert.equal(f.runs[0].options.timeout, SHELL_TIMEOUT_MS);
});

test('drive: every conductor-owned kind is a stop, with nothing run and the action still pending', async (t) => {
  const cases = [
    [{ kind: 'skill', step: 'spec', skill: 'spec', skillArgv: [] }, 'needs-conductor'],
    [{ kind: 'touch', step: 'touch', part: 'ask', touch: { n: 1 } }, 'needs-conductor'],
    [{ kind: 'touch', step: 'touch', part: 'hand-back', handBack: true, touch: { n: 1 } }, 'hand-back'],
    [{ kind: 'inspect', step: 'gate', part: 'tail', command: ['git', 'diff'] }, 'needs-conductor'],
    [{ kind: 'author', step: 'ruling', part: 'ask', outPath: '/x/rulings/wp-01-1.json', ruling: {} }, 'needs-conductor'],
    [{ kind: 'author', step: 'grant', outPath: '/x/touches/1-grant.json' }, 'needs-conductor'],
    [{ kind: 'wait', step: 'touch', part: 'announce', yield: true, waitMs: 0, instruction: 'Stop and show the operator …' }, 'needs-conductor'],
    [TOOL, 'needs-conductor'],
  ];
  for (const [spec, why] of cases) {
    const f = fixture(t, [spec]);
    const result = await f.drive();
    assert.equal(result.code, 0, `${spec.kind}/${spec.part}: ${result.stdout}`);
    const printed = out(result);
    assert.equal(printed.stopped, why, spec.kind);
    assert.equal(printed.steps, 0);
    assert.equal(printed.action.kind, spec.kind);
    assert.deepEqual(f.runs, []);
    assert.deepEqual(f.sleeps, []);
    assert.equal(state(f).pending.id, printed.action.id);
    assert.equal(state(f).lastRecorded, null);
  }
});

test('drive: done is a stop, exit 0', async (t) => {
  const f = fixture(t, [WAIT]);
  const printed = out(await f.drive());
  assert.equal(printed.stopped, 'done');
  assert.equal(printed.action.kind, 'done');
  assert.equal(printed.steps, 1);
});

test('fillTemplate: a null slot deletes its whole line, other placeholders stay, line endings are kept, append follows', () => {
  const text = 'keep <a> here\r\ndrop <b> line\nother <c> stays\n<b> again\n';
  assert.equal(fillTemplate(text, { '<a>': 'A$&', '<b>': null }, 'TAIL\n'), 'keep A$& here\r\nother <c> stays\nTAIL\n');
  // A bump: exactly the slot replaced, the rest byte for byte.
  const json = '{\r\n  "version": "1.2.3"\r\n}\r\n';
  assert.equal(fillTemplate(json, { '"version": "1.2.3"': '"version": "1.2.4"' }), '{\r\n  "version": "1.2.4"\r\n}\r\n');
});

test('drive: a template author with a null slot writes the file without that line', async (t) => {
  const g = fixture(t, []);
  const template = join(g.dir, 'contract.template.md');
  writeFileSync(template, '# Contract <run name>\n- <repo B: second repo>\n- gate: <gate command(s)>\n- <unfilled> stays\n');
  const outPath = join(g.dir, '_lane-contract.md');
  g.queue.push({ kind: 'author', step: 'contract', template, outPath, append: '\n## Run deltas\n',
    slots: { '<run name>': 'conduct x', '<repo B: second repo>': null, '<gate command(s)>': 'node --test' }, expects: { type: 'file' } });
  assert.equal(out(await g.drive()).stopped, 'done');
  assert.equal(readFileSync(outPath, 'utf8'), '# Contract conduct x\n- gate: node --test\n- <unfilled> stays\n\n## Run deltas\n');
});

test('drive: a refused record exits nonzero, leaves the action pending, and records nothing', async (t) => {
  const f = fixture(t, [SHELL, TOOL], { shell: () => ({ code: 1, stdout: '', stderr: 'fail' }) });
  const result = await f.drive();
  assert.equal(result.code, 2, result.stdout);
  const printed = out(result);
  assert.equal(printed.ok, false);
  assert.equal(printed.stopped, 'record-failed');
  assert.match(printed.record.error, /expects exit 0, got 1/);
  assert.equal(printed.record.recorded, undefined);
  assert.equal(state(f).pending.id, printed.action.id);
  assert.equal(state(f).pending.kind, 'shell');
  assert.equal(state(f).lastRecorded, null);
  assert.deepEqual(f.recorded, []);
  // The result was written before the record read it.
  assert.deepEqual(JSON.parse(readFileSync(join(f.runDir, 'drive-result.json'), 'utf8')), { code: 1, stdout: '', stderr: 'fail' });
  assert.match(logLines(f).at(-1), / exit=1 \d+\.\ds record=2$/);
});

test('drive: a shell timeout is a stop, not a result: nothing recorded, exit 1', async (t) => {
  const f = fixture(t, [SHELL], { shell: () => ({ code: null, stdout: 'partial', stderr: '', timedOut: true }) });
  const result = await f.drive();
  assert.equal(result.code, 1);
  assert.equal(out(result).stopped, 'shell-timeout');
  assert.equal(state(f).pending.kind, 'shell');
  assert.deepEqual(f.recorded, []);
});

test('drive: --max-steps stops after n performed steps, the next one still pending', async (t) => {
  const f = fixture(t, [WAIT, WAIT, WAIT, WAIT]);
  const result = await f.drive(['--max-steps', '2']);
  assert.equal(result.code, 0);
  const printed = out(result);
  assert.equal(printed.stopped, 'max-steps');
  assert.equal(printed.steps, 2);
  assert.equal(f.sleeps.length, 2);
  assert.equal(state(f).pending.id, printed.action.id);
  assert.equal(printed.action.kind, 'wait');
  assert.equal((await f.drive(['--max-steps', 'x'])).code, 2);
});

test('drive: drive.log has one line per step (start time, id, kind/step/part, exit, duration) and the stop', async (t) => {
  const f = fixture(t, [SHELL, WAIT, TOOL]);
  const printed = out(await f.drive());
  const lines = logLines(f);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z 1-gate-cmd shell\/gate-cmd\/run exit=0 \d+\.\ds$/);
  assert.match(lines[1], /^\S+Z 2-wait wait\/wait\/- exit=- \d+\.\ds$/);
  assert.equal(lines[2].split(' ').slice(1).join(' '), `${printed.action.id} agent-tool/start/- stop=needs-conductor`);
});

test('drive: an open rotation is refused before anything runs', async (t) => {
  const f = fixture(t, [SHELL], { patch: { rotations: [{ attempt: 1, status: 'open', from: 1, to: 2, caller: { pane: null }, successor: { pane: null } }] } });
  const result = await f.drive();
  assert.equal(result.code, 5, result.stdout);
  const printed = out(result);
  assert.equal(printed.stopped, 'refused');
  assert.match(printed.refusal.error, /rotation 1 is open/);
  assert.deepEqual(f.runs, []);
});

test('drive: a second driver on the same run is refused while the first holds drive.lock', async (t) => {
  const f = fixture(t, [SHELL]);
  writeFileSync(join(f.runDir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: 'other' }));
  const result = await f.drive();
  assert.equal(result.code, 2);
  assert.match(out(result).error, /drive\.lock is held by pid/);
  assert.deepEqual(f.runs, []);
  assert.ok(existsSync(join(f.runDir, 'drive.lock')), 'the holder keeps its lock');
});

test('drive: a pending hand-back is a stop and is never consumed', async (t) => {
  const handBack = { id: '7-touch', kind: 'touch', step: 'touch', part: 'hand-back', handBack: true, touch: { n: 1 }, phase: 'build' };
  const f = fixture(t, [], { patch: { pending: handBack, seq: 7 } });
  const printed = out(await f.drive());
  assert.equal(printed.stopped, 'hand-back');
  assert.deepEqual(state(f).pending, handBack);
});

test('runArgv: env added, exit code kept, a missing program is 127, a timeout is timedOut', () => {
  const ran = runArgv(process.execPath, ['-e', 'process.stdout.write(process.env.DRIVE_X); process.stderr.write("e"); process.exit(3)'], { env: { ...process.env, DRIVE_X: 'y' } });
  assert.deepEqual(ran, { code: 3, stdout: 'y', stderr: 'e' });
  assert.equal(runArgv('workit-no-such-program', []).code, 127);
  assert.equal(runArgv(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 }).timedOut, true);
});
