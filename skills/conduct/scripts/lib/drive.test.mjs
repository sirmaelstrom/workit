import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runConduct } from '../conduct.mjs';
import { BACKGROUND_TIMEOUT_MS, SHELL_TIMEOUT_MS, fillTemplate } from './drive.mjs';
import { runArgv, windowsShim } from './exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// A build phase that emits the given actions in order, then done, and keeps
// what record handed it. Nothing here runs a real program: runArgv is a fake.
function fixture(t, specs, { patch = {}, shell = () => ({ code: 0, stdout: 'ok\n', stderr: '' }), onRecord = () => {} } = {}) {
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
  const build = { next: () => queue.shift() ?? { kind: 'done' }, record: (state, action, result) => { onRecord(action, result); recorded.push({ id: action.id, result }); } };
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
    // A wake wait: the conductor ends its turn and is woken by a lane's send or a heartbeat.
    [{ kind: 'wait', step: 'wait', wake: true, waitMs: 60000, instruction: 'End your turn; a lane or the heartbeat wakes you.' }, 'needs-conductor'],
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
  // The result was saved before the record read it, and stays for the conductor.
  const saved = JSON.parse(readFileSync(join(f.runDir, 'drive-result.json'), 'utf8'));
  assert.equal(printed.saved, join(f.runDir, 'drive-result.json'));
  assert.equal(saved.id, printed.action.id);
  assert.deepEqual(saved.result, { code: 1, stdout: '', stderr: 'fail' });
  // A rerun replays the saved result: the command is not run again.
  assert.equal((await f.drive()).code, 2);
  assert.equal(f.runs.length, 1);
  assert.match(logLines(f).at(-2), / exit=1 \d+\.\ds record=2$/);
  assert.match(logLines(f).at(-1), / exit=1 \d+\.\ds replayed record=2$/);
});

test('drive: a shell timeout is a stop, not a result: nothing recorded, exit 1', async (t) => {
  const f = fixture(t, [SHELL], { shell: () => ({ code: null, stdout: 'partial', stderr: '', timedOut: true, killVerified: true }) });
  const result = await f.drive();
  assert.equal(result.code, 1);
  assert.equal(out(result).stopped, 'shell-timeout');
  assert.equal(state(f).pending.kind, 'shell');
  assert.deepEqual(f.recorded, []);
});

// A driver that dies is a raw (non-ConductError) throw out of drive: nothing
// after the throw runs, as nothing after a crash would.
test('drive: a shell that ran but was never recorded is recorded from its saved result on restart, not run again', async (t) => {
  let crash = true;
  const f = fixture(t, [SHELL, TOOL], { onRecord: () => { if (crash) throw new Error('driver died'); } });
  await assert.rejects(f.drive(), /driver died/);
  assert.equal(f.runs.length, 1);
  assert.equal(state(f).pending.kind, 'shell', 'the crash left the shell pending');
  crash = false;
  const result = await f.drive();
  assert.equal(result.code, 0, result.stdout);
  const printed = out(result);
  assert.equal(printed.stopped, 'needs-conductor');
  assert.equal(printed.action.kind, 'agent-tool');
  assert.equal(f.runs.length, 1, 'the completed command is not run again');
  assert.deepEqual(f.recorded.map(({ result: r }) => r), [{ code: 0, stdout: 'ok\n', stderr: '' }]);
  assert.equal(printed.performed[0].replayed, true);
  assert.equal(existsSync(join(f.runDir, 'drive-started.json')), false, 'a recorded step clears its markers');
  assert.equal(existsSync(join(f.runDir, 'drive-result.json')), false);
});

test('drive: a shell started with no saved result is a reconcile stop on restart, never run again', async (t) => {
  let crash = true;
  const f = fixture(t, [SHELL, TOOL], { shell: () => { if (crash) throw new Error('driver died mid-command'); return { code: 0, stdout: 'ok\n', stderr: '' }; } });
  await assert.rejects(f.drive(), /driver died mid-command/);
  crash = false;
  const pendingId = state(f).pending.id;
  const result = await f.drive();
  assert.equal(result.code, 1, result.stdout);
  const printed = out(result);
  assert.equal(printed.ok, false);
  assert.equal(printed.stopped, 'reconcile');
  assert.equal(printed.action.id, pendingId);
  assert.equal(printed.marker.path, join(f.runDir, 'drive-started.json'));
  assert.equal(printed.marker.id, pendingId);
  assert.match(printed.marker.argvHash, /^[0-9a-f]{16}$/);
  assert.equal(f.runs.length, 1, 'the half-run command is not run again');
  assert.deepEqual(f.recorded, []);
  assert.equal(state(f).pending.id, pendingId);
  assert.match(logLines(f).at(-1), new RegExp(` ${pendingId} shell/gate-cmd/run stop=reconcile$`));
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

test('drive: while a drive runs, a conductor record or next is refused (exit 5, naming the driver); a shell verb still runs', async (t) => {
  const inner = {};
  let f;
  f = fixture(t, [SHELL, TOOL], {
    shell: async () => {
      // A conductor in another process: the base deps, without the driver's token.
      const id = state(f).pending.id;
      inner.lock = JSON.parse(readFileSync(join(f.runDir, 'drive.lock'), 'utf8'));
      inner.pendingId = id;
      inner.record = await f.run(['record', '--run', f.runDir, '--action', id, '--result', '{"code":0,"stdout":"","stderr":""}']);
      inner.next = await f.run(['next', '--run', f.runDir]);
      // A shell action's own conduct.mjs verb (the gate's quiet probe) still runs.
      inner.quiet = await f.run(['quiet', '--samples', '1', '--interval-ms', '100', '--max-busy', '100']);
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  const result = await f.drive();
  assert.equal(inner.lock.action, inner.pendingId, 'drive.lock names the action it is executing');
  for (const verb of ['record', 'next']) {
    assert.equal(inner[verb].code, 5, `${verb}: ${inner[verb].stdout}`);
    assert.match(out(inner[verb]).error, new RegExp(`pid ${process.pid} on ${hostname()} since \\S+Z.*executing ${inner.pendingId}`));
  }
  // Quiet or busy (the host's load decides), but it ran: its samples, not a refusal.
  assert.ok([0, 1].includes(inner.quiet.code), inner.quiet.stdout);
  assert.equal(typeof out(inner.quiet).quiet, 'boolean');
  // The driver's own record went through, once, with the command's result.
  assert.equal(result.code, 0, result.stdout);
  assert.equal(out(result).stopped, 'needs-conductor');
  assert.deepEqual(f.recorded.map(({ result: r }) => r), [{ code: 0, stdout: 'ok\n', stderr: '' }]);
  assert.equal(f.runs.length, 1);
});

test('drive: each conductor verb that moves the run is refused while a live driver holds drive.lock, and works once it is gone', async (t) => {
  const f = fixture(t, [TOOL]);
  const at = new Date().toISOString();
  writeFileSync(join(f.runDir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at, token: 'other', action: '1-start' }));
  const plan = join(f.dir, 'plan.json');
  writeFileSync(plan, '{}');
  const verbs = [
    ['record', '--action', '1-start', '--result', '{}'], ['next'], ['rotate', '--why', 'x'],
    ['reset-wp', '--wp', 'WP-01', '--to', 'land', '--why', 'x'], ['replan', '--plan', plan],
    ['ratify', '--wp', 'WP-01', '--paths', 'a', '--why', 'x'], ['upgrade-root', '--why', 'x'],
  ];
  for (const [verb, ...rest] of verbs) {
    const result = await f.run([verb, '--run', f.runDir, ...rest]);
    assert.equal(result.code, 5, `${verb}: ${result.stdout}`);
    assert.match(out(result).error, new RegExp(`^${verb}: a drive holds this run \\(pid ${process.pid} on ${hostname()} since ${at.replace(/\./g, '\\.')}, executing 1-start\\)`));
  }
  // A dead driver's lock is stale: next works.
  writeFileSync(join(f.runDir, 'drive.lock'), JSON.stringify({ pid: 999999999, host: hostname(), at, token: 'other' }));
  assert.equal((await f.run(['next', '--run', f.runDir])).code, 0);
});

test('drive: a driver that finds pending moved under it stops before running anything', async (t) => {
  let f;
  let moved = false;
  f = fixture(t, [WAIT, SHELL, TOOL], {
    // After the wait is recorded, a conductor ignoring the lock re-emits the shell under another id.
    onRecord: (action) => { if (action.kind === 'wait') moved = true; },
  });
  const append = (path, value) => {
    writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + value);
    if (moved && path.endsWith('drive.log')) {
      moved = false;
      const s = state(f);
      writeFileSync(join(f.runDir, 'state.json'), JSON.stringify({ ...s, pending: { ...s.pending, id: '9-gate-cmd' } }));
    }
  };
  const result = await f.run(['drive', '--run', f.runDir], { append });
  assert.equal(result.code, 1, result.stdout);
  const printed = out(result);
  assert.equal(printed.stopped, 'pending-moved');
  assert.equal(printed.action.id, '2-gate-cmd');
  assert.equal(printed.found, '9-gate-cmd');
  assert.deepEqual(f.runs, []);
  assert.equal(printed.steps, 1);
});

test('windowsShim: a bare name found only as .cmd/.bat on cwd or PATH is a shim; a .exe anywhere, a path, or nothing found is not', () => {
  const files = new Set([join('C:/bin1', 'npm.cmd'), join('C:/bin1', 'node.cmd'), join('C:/bin2', 'node.exe'), join('C:/repo', 'build.bat')]);
  const exists = (path) => files.has(path);
  const env = { Path: 'C:/bin1;C:/bin2', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const shim = (name) => windowsShim(name, { env, cwd: 'C:/repo', exists });
  assert.equal(shim('npm'), true, 'npm.cmd only');
  assert.equal(shim('node'), false, 'node.exe later on PATH is what spawn runs');
  assert.equal(shim('build'), true, 'build.bat in cwd');
  assert.equal(shim('npm.cmd'), true);
  assert.equal(shim('tool.BAT'), true);
  assert.equal(shim('git'), false, 'not found: spawn reports it');
  assert.equal(shim('C:/bin1/npm'), false, 'a path is run as given');
  assert.equal(shim('node.exe'), false);
  // PATHEXT missing: the cmd.exe default list.
  assert.equal(windowsShim('npm', { env: { PATH: 'C:/bin1' }, cwd: 'C:/none', exists }), true);
});

const NPM = { ...SHELL, step: 'release', part: 'verify', command: ['npm', 'test'] };

test('drive: on Windows a command that resolves only to a .cmd shim is the conductor\'s: nothing run, nothing recorded', async (t) => {
  const f = fixture(t, [NPM, TOOL], { shell: () => ({ code: 127, stdout: '', stderr: 'spawn npm ENOENT' }) });
  const asked = [];
  const windowsShim = (name, options) => { asked.push({ name, options }); return name === 'npm'; };
  const result = await f.run(['drive', '--run', f.runDir], { platform: 'win32', windowsShim });
  assert.equal(result.code, 0, result.stdout);
  const printed = out(result);
  assert.equal(printed.stopped, 'needs-conductor');
  assert.equal(printed.reason, 'windows-shim');
  assert.deepEqual(printed.action.command, ['npm', 'test']);
  assert.deepEqual(f.runs, []);
  assert.deepEqual(f.recorded, []);
  assert.equal(state(f).pending.id, printed.action.id);
  assert.equal(existsSync(join(f.runDir, 'drive-started.json')), false);
  assert.equal(asked[0].name, 'npm');
  assert.equal(asked[0].options.cwd, '/repo');
  assert.equal(asked[0].options.env.GATE, 'x');
  assert.match(logLines(f).at(-1), / stop=needs-conductor reason=windows-shim$/);
});

test('drive: on Windows a bare name whose spawn fails ENOENT or EINVAL is a windows-shim stop, never a recorded 127', async (t) => {
  for (const spawnError of ['ENOENT', 'EINVAL']) {
    const f = fixture(t, [NPM, TOOL], { shell: () => ({ code: null, stdout: '', stderr: `spawn npm ${spawnError}`, spawnError }) });
    const result = await f.run(['drive', '--run', f.runDir], { platform: 'win32', windowsShim: () => false });
    assert.equal(result.code, 0, result.stdout);
    const printed = out(result);
    assert.equal(printed.stopped, 'needs-conductor', spawnError);
    assert.equal(printed.reason, 'windows-shim');
    assert.deepEqual(f.recorded, []);
    assert.equal(state(f).pending.kind, 'shell');
    // The command never started, so no marker holds the next drive at reconcile.
    assert.equal(existsSync(join(f.runDir, 'drive-started.json')), false);
  }
});

test('drive: a spawn failure elsewhere is a spawn-failed stop, exit 1, never a recorded 127', async (t) => {
  const f = fixture(t, [{ ...SHELL, command: ['/opt/missing/tool'] }, TOOL], { shell: () => ({ code: null, stdout: '', stderr: 'spawn ENOENT', spawnError: 'ENOENT' }) });
  const result = await f.drive();
  assert.equal(result.code, 1, result.stdout);
  const printed = out(result);
  assert.equal(printed.stopped, 'spawn-failed');
  assert.equal(printed.spawnError, 'ENOENT');
  assert.deepEqual(f.recorded, []);
  assert.equal(state(f).pending.kind, 'shell');
  assert.equal(existsSync(join(f.runDir, 'drive-started.json')), false);
});

test('drive: a pending hand-back is a stop and is never consumed', async (t) => {
  const handBack = { id: '7-touch', kind: 'touch', step: 'touch', part: 'hand-back', handBack: true, touch: { n: 1 }, phase: 'build' };
  const f = fixture(t, [], { patch: { pending: handBack, seq: 7 } });
  const printed = out(await f.drive());
  assert.equal(printed.stopped, 'hand-back');
  assert.deepEqual(state(f).pending, handBack);
});

test('runArgv: env added, exit code kept, a missing program is a spawnError with no exit code, a timeout is timedOut', async () => {
  const ran = await runArgv(process.execPath, ['-e', 'process.stdout.write(process.env.DRIVE_X); process.stderr.write("e"); process.exit(3)'], { env: { ...process.env, DRIVE_X: 'y' } });
  assert.deepEqual(ran, { code: 3, stdout: 'y', stderr: 'e' });
  const missing = await runArgv('workit-no-such-program', []);
  assert.equal(missing.spawnError, 'ENOENT');
  assert.equal(missing.code, null);
  assert.equal((await runArgv(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 })).timedOut, true);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 50))) if (check()) return true;
  return check();
};

test('runArgv: a timeout kills the process tree, a grandchild sleeper too, and verifies the root is gone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workit-tree-'));
  const pidFile = join(dir, 'grandchild.pid');
  const sleeper = join(dir, 'sleeper.js');
  writeFileSync(sleeper, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);\n");
  t.after(() => {
    if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  // A gate command's shape: a shell root whose child sleeps past the timeout.
  // Killing the root alone leaves the child running (its output goes to the
  // null device, so the old spawnSync returned rather than waiting on it).
  const [program, ...args] = process.platform === 'win32'
    ? ['cmd.exe', '/d', '/c', 'node', sleeper, pidFile, '>NUL', '2>&1']
    : ['sh', '-c', '"$0" "$1" "$2" >/dev/null 2>&1; :', process.execPath, sleeper, pidFile];
  const ran = await runArgv(program, args, { timeout: 2000 });
  assert.equal(ran.timedOut, true);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(await until(() => !alive(grandchild)), `the grandchild ${grandchild} is gone`);
  assert.equal(ran.killVerified, true);
  assert.equal(alive(ran.pid), false, 'the root is gone');
});

test('runArgv: a root that survives its kill is reported unverified', async (t) => {
  let pid = null;
  t.after(() => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} });
  const ran = await runArgv(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 200, killTree: () => {}, killGraceMs: 300 });
  pid = ran.pid;
  assert.equal(ran.timedOut, true);
  assert.equal(ran.killVerified, false);
  assert.equal(alive(pid), true);
});

test('drive: a timeout whose kill is unverified stops as timeout-unverified, nothing recorded; the next drive reconciles', async (t) => {
  const f = fixture(t, [SHELL], { shell: () => ({ code: null, stdout: '', stderr: '', timedOut: true, killVerified: false }) });
  const result = await f.drive();
  assert.equal(result.code, 1);
  assert.equal(out(result).stopped, 'timeout-unverified');
  assert.deepEqual(f.recorded, []);
  assert.equal(state(f).pending.kind, 'shell');
  assert.match(logLines(f).at(-1), / exit=timeout \d+\.\ds unverified$/);
  assert.equal(out(await f.drive()).stopped, 'reconcile');
  assert.equal(f.runs.length, 1);
});
