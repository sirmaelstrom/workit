import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { laneWaitMonitor, runSession } from './session.mjs';
import { runStopCapture } from './session-stop-capture.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let handler = null;
  const exec = (program, args, options = {}) => {
    calls.push({ program, args: [...args], options });
    return handler ? handler(program, args, options) : { code: 0, stdout: '{"result":{}}', stderr: '' };
  };
  return { dir, log: join(dir, 'session-log.jsonl'), calls, exec, set handler(value) { handler = value; } };
}

function env(overrides = {}) { return { HERDR_ENV: '1', HERDR_PANE_ID: 'pane:caller', ...overrides }; }
function handoff(f) { const file = join(f.dir, 'handoff.md'); writeFileSync(file, 'continue', 'utf8'); return file; }
function callsFor(f, verb) { return f.calls.filter((call) => call.args[0] === verb); }
function state(f) { return JSON.parse(readFileSync(`${f.log}.state.json`, 'utf8')); }
function row(f) { return JSON.parse(readFileSync(f.log, 'utf8').trim().split(/\r?\n/).at(-1)); }

const herdrShapes = {
  envelope: (command, result, type = command.replace(/:/g, '_')) => JSON.stringify({ id: `cli:${command}`, result, type }),
  agentGet: ({ pane = 'pane:successor', state = 'idle', session = '22222222-2222-4222-8222-222222222222' } = {}) => herdrShapes.envelope('agent:get', { agent_status: state, agent_session: session ? { value: session } : null, pane_id: pane }),
  agentWait: (state = 'done') => herdrShapes.envelope('agent:wait', { agent_status: state }),
  paneGet: (context = '65') => herdrShapes.envelope('pane:get', { pane: { tokens: context === undefined ? {} : { context } } }),
  processInfo: (processes) => herdrShapes.envelope('pane:process_info', { process_info: { foreground_process_group_id: 0, foreground_processes: processes, pane_id: 'pane:fixture', shell_pid: 1 } }),
  process: ({ name = 'pwsh.exe', argv = [], argv0 = `<path>/${name}`, pid = 2 } = {}) => ({ name, argv0, argv, cmdline: argv.join(' '), cwd: '<cwd>', pid }),
  paneSplit: () => herdrShapes.envelope('pane:split', { pane_id: 'pane:successor' }),
  prompt: () => herdrShapes.envelope('agent:prompt', { accepted: true, agent_status: 'working' }),
  empty: (command) => herdrShapes.envelope(command, {}),
};

function successHerdr({ callerModel = 'claude-fable-5-1', context = '65', successorSession = '22222222-2222-4222-8222-222222222222', successorModel = 'claude-opus-5', processes = null } = {}) {
  return (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane split') return { code: 0, stdout: herdrShapes.paneSplit(), stderr: '' };
    if (key === 'agent start' || key === 'agent focus') return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
    if (key === 'agent get') {
      const caller = args[2] === 'pane:caller';
      const id = caller ? '11111111-1111-4111-8111-111111111111' : successorSession;
      return { code: 0, stdout: herdrShapes.agentGet({ pane: args[2], session: id }), stderr: '' };
    }
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(context), stderr: '' };
    if (key === 'pane process-info') {
      const model = args.at(-1) === 'pane:caller' ? callerModel : successorModel;
      return { code: 0, stdout: herdrShapes.processInfo(processes ?? [herdrShapes.process({ argv: [`<path>/claude.exe`, '--model', model], argv0: '<path>/claude.exe', name: 'claude.exe' })]), stderr: '' };
    }
    if (key === 'agent prompt') return { code: 0, stdout: herdrShapes.prompt(), stderr: '' };
    if (key === 'agent wait') return { code: 0, stdout: herdrShapes.agentWait(), stderr: '' };
    if (key === 'pane read') return { code: 0, stdout: 'Resume this session with:\nclaude --resume 33333333-3333-4333-8333-333333333333', stderr: '' };
    if (key === 'pane close') return { code: 0, stdout: herdrShapes.empty('pane:close'), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
}

test('S1: dontAsk is refused before herdr is invoked', async (t) => {
  const f = fixture(t);
  const result = await runSession(['spawn', '--name', 'x', '--model', 'claude-opus-5', '--effort', 'high', '--log', f.log, '--', '--permission-mode', 'dontAsk'], { exec: f.exec, env: env() });
  assert.equal(result.exit, 2);
  assert.equal(f.calls.length, 0);
  const equals = fixture(t);
  const equalsResult = await runSession(['spawn', '--name', 'x', '--model', 'claude-opus-5', '--effort', 'high', '--log', equals.log, '--', '--permission-mode=dontAsk'], { exec: equals.exec, env: env() });
  assert.equal(equalsResult.exit, 2); assert.equal(equals.calls.length, 0);
});

test('S2: model and effort are mandatory', async (t) => {
  const f = fixture(t);
  for (const argv of [
    ['spawn', '--name', 'x', '--effort', 'high', '--log', f.log],
    ['spawn', '--name', 'x', '--model', 'claude-opus-5', '--log', f.log],
  ]) assert.equal((await runSession(argv, { exec: f.exec, env: env() })).exit, 2);
  assert.equal(f.calls.length, 0);
  const fork = fixture(t); fork.handler = successHerdr();
  const launched = await runSession([
    'spawn', '--name', 'forked', '--model', 'claude-opus-5', '--effort', 'high',
    '--mode', 'fork', '--from-session', '11111111-1111-4111-8111-111111111111', '--log', fork.log,
  ], { exec: fork.exec, env: env() });
  assert.equal(launched.exit, 0);
  assert.ok(fork.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start').args.includes('--fork-session'));
  const rejected = fixture(t); rejected.handler = successHerdr({ processes: [herdrShapes.process()] });
  const rejectedLaunch = await runSession(['spawn', '--name', 'rejected', '--model', 'claude-opus-5', '--effort', 'high', '--log', rejected.log], { exec: rejected.exec, env: env() });
  assert.equal(rejectedLaunch.exit, 5); assert.equal(row(rejected).state, 'failed'); assert.equal(row(rejected).pane, 'pane:successor');
  assert.equal(rejected.calls.some((call) => call.args[0] === 'agent' && call.args[1] === 'focus' && call.args[2] === 'pane:caller'), true);
  const overriddenModel = fixture(t);
  const overriddenResult = await runSession(['spawn', '--name', 'x', '--model', 'claude-opus-5', '--effort', 'high', '--log', overriddenModel.log, '--', '--model=claude-fable-5-1'], { exec: overriddenModel.exec, env: env() });
  assert.equal(overriddenResult.exit, 2); assert.equal(overriddenModel.calls.length, 0);
});

test('S3: successor-not-ready never retires', async (t) => {
  const f = fixture(t); const file = handoff(f); let now = 0;
  f.handler = successHerdr({ successorSession: null });
  const failed = await runSession(['chain', '--handoff', file, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--successor-timeout', '90000', '--log', f.log], { exec: f.exec, env: env(), now: () => (now += 90_001), sleep: async () => {} });
  assert.equal(failed.exit, 4); assert.equal(row(f).outcome, 'successor-not-ready');
  assert.equal(row(f).callerContext, 65); assert.equal(row(f).callerModel, 'claude-fable-5-1');
  const start = f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start').args;
  assert.equal(start[start.indexOf('--timeout') + 1], '90000');
  assert.equal(f.calls.some((call) => call.args.includes('/exit')), false);
  const positive = fixture(t); const positiveFile = handoff(positive); positive.handler = successHerdr();
  await runSession(['chain', '--handoff', positiveFile, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--log', positive.log], { exec: positive.exec, env: env() });
  assert.equal(positive.calls.some((call) => call.args.includes('/exit')), true, 'positive chain proves the negative control can observe retirement');
});

test('S4: a live agent blocks close', async (t) => {
  const f = fixture(t); let now = 0;
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old', sessionId: '44444444-4444-4444-8444-444444444444' } }, chains: [] }), 'utf8');
  f.handler = (_program, args) => {
    if (`${args[0]} ${args[1]}` === 'agent wait') return { code: 0, stdout: herdrShapes.agentWait('done'), stderr: '' };
    if (`${args[0]} ${args[1]}` === 'pane read') return { code: 0, stdout: '', stderr: '' };
    if (`${args[0]} ${args[1]}` === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe', argv0: '<path>/claude.exe' })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty('fixture'), stderr: '' };
  };
  const blocked = await runSession(['retire', 'old', '--mode', 'close', '--timeout', '1', '--log', f.log], { exec: f.exec, now: () => (now += 2), sleep: async () => {} });
  assert.equal(blocked.exit, 3); assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'close'), false);
  const positive = fixture(t); writeFileSync(`${positive.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); positive.handler = successHerdr({ processes: [herdrShapes.process({ name: 'pwsh.exe' })] });
  await runSession(['retire', 'old', '--mode', 'close', '--log', positive.log], { exec: positive.exec });
  assert.equal(callsFor(positive, 'pane').some((call) => call.args[1] === 'close'), true, 'positive close proves the negative control can observe closure');
  const unknown = fixture(t); writeFileSync(`${unknown.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  unknown.handler = (_program, args) => {
    if (`${args[0]} ${args[1]}` === 'agent wait') return { code: 0, stdout: herdrShapes.agentWait('done'), stderr: '' };
    if (`${args[0]} ${args[1]}` === 'pane read') return { code: 0, stdout: '', stderr: '' };
    if (`${args[0]} ${args[1]}` === 'pane process-info') return { code: 0, stdout: '{not-json', stderr: '' };
    return { code: 0, stdout: herdrShapes.empty('fixture'), stderr: '' };
  };
  const failClosed = await runSession(['retire', 'old', '--mode', 'close', '--timeout', '1', '--log', unknown.log], { exec: unknown.exec, now: () => (now += 2), sleep: async () => {} });
  assert.equal(failClosed.exit, 3); assert.equal(callsFor(unknown, 'pane').some((call) => call.args[1] === 'close'), false);
});

test('S5: gone has two shapes', async (t) => {
  const done = fixture(t); done.handler = successHerdr();
  assert.equal((await runSession(['watch', 'old', '--until', 'gone', '--timeout', '1', '--log', done.log], { exec: done.exec })).exit, 0);
  const missing = fixture(t); missing.handler = (_program, args) => `${args[0]} ${args[1]}` === 'agent get'
    ? { code: 0, stdout: herdrShapes.agentGet({ pane: 'pane:old' }), stderr: '' }
    : ({ code: 1, stdout: '', stderr: 'agent_not_found' });
  assert.equal((await runSession(['watch', 'old', '--until', 'gone', '--timeout', '1', '--log', missing.log], { exec: missing.exec })).exit, 0);
  const idle = fixture(t); idle.handler = (_program, args) => `${args[0]} ${args[1]}` === 'agent get'
    ? { code: 0, stdout: herdrShapes.agentGet({ pane: 'pane:old' }), stderr: '' }
    : (`${args[0]} ${args[1]}` === 'agent wait'
      ? { code: 0, stdout: herdrShapes.agentWait('idle'), stderr: '' }
      : { code: 0, stdout: herdrShapes.empty('fixture'), stderr: '' });
  const idleWatch = await runSession(['watch', 'old', '--until', 'gone', '--timeout', '1', '--log', idle.log], { exec: idle.exec });
  assert.equal(idleWatch.output.state, 'idle'); assert.equal(idleWatch.output.state === 'gone', false);
  const close = fixture(t); writeFileSync(`${close.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); close.handler = idle.handler;
  const notGone = await runSession(['retire', 'old', '--mode', 'close', '--timeout', '1', '--log', close.log], { exec: close.exec });
  assert.equal(notGone.exit, 3); assert.equal(callsFor(close, 'pane').some((call) => call.args[1] === 'close'), false);
  assert.deepEqual(idle.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'wait').args.slice(0, 6), ['agent', 'wait', 'old', '--until', 'done', '--timeout']);
});

test('S6: resume id is parsed, never invented', async (t) => {
  const withBanner = fixture(t); writeFileSync(`${withBanner.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); withBanner.handler = successHerdr({ processes: [herdrShapes.process({ name: 'pwsh.exe' })] });
  const parsed = await runSession(['retire', 'old', '--mode', 'close', '--log', withBanner.log], { exec: withBanner.exec });
  assert.equal(parsed.output.resumeId, '33333333-3333-4333-8333-333333333333');
  const absent = fixture(t); writeFileSync(`${absent.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); absent.handler = (_program, args) => `${args[0]} ${args[1]}` === 'pane read' ? { code: 0, stdout: 'banner absent', stderr: '' } : successHerdr({ processes: [herdrShapes.process({ name: 'pwsh.exe' })] })(_program, args);
  const clean = await runSession(['retire', 'old', '--mode', 'close', '--log', absent.log], { exec: absent.exec });
  assert.equal(clean.exit, 0); assert.equal(clean.output.resumeId, null);
  const named = fixture(t); let processReads = 0; let paneReads = 0;
  named.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'agent get') return { code: 0, stdout: herdrShapes.agentGet({ pane: 'pane:named', session: '77777777-7777-4777-8777-777777777777' }), stderr: '' };
    if (key === 'agent wait') return { code: 0, stdout: herdrShapes.agentWait('done'), stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: processReads++ === 0 ? 'claude.exe' : 'pwsh.exe', argv0: '<path>/claude.exe' })]), stderr: '' };
    if (key === 'pane read') return { code: 0, stdout: paneReads++ === 0 ? 'not ready' : 'Resume this session with:\nclaude --resume 88888888-8888-4888-8888-888888888888', stderr: '' };
    return { code: 0, stdout: herdrShapes.empty('fixture'), stderr: '' };
  };
  const delayed = await runSession(['retire', 'stranger', '--mode', 'close', '--timeout', '100', '--log', named.log], { exec: named.exec, sleep: async () => {} });
  assert.equal(delayed.exit, 0); assert.equal(delayed.output.resumeId, '88888888-8888-4888-8888-888888888888');
  assert.equal(named.calls.find((call) => call.args[0] === 'pane' && call.args[1] === 'close').args[2], 'pane:named');
});

test('S7: context is null when absent', async (t) => {
  const f = fixture(t); const file = handoff(f); f.handler = successHerdr({ context: null, successorModel: 'claude-fable-5-1' });
  const absent = await runSession(['chain', '--handoff', file, '--name', 'new', '--model', 'claude-fable-5-1', '--effort', 'high', '--no-retire', '--log', f.log], { exec: f.exec, env: env() });
  assert.equal(absent.output.callerContext, null);
  const present = fixture(t); const presentFile = handoff(present); present.handler = successHerdr({ context: '65', successorModel: 'claude-fable-5-1' });
  const value = await runSession(['chain', '--handoff', presentFile, '--name', 'new', '--model', 'claude-fable-5-1', '--effort', 'high', '--no-retire', '--log', present.log], { exec: present.exec, env: env() });
  assert.equal(value.output.callerContext, 65);
});

test('S8: chain happy path is ordered and receipted', async (t) => {
  const f = fixture(t); const file = handoff(f); const root = join(f.dir, 'capture'); f.handler = successHerdr();
  const result = await runSession(['chain', '--handoff', file, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--capture-final', '--log', f.log], { exec: f.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: root }) });
  assert.equal(result.exit, 0);
  const labels = f.calls.map((call) => `${call.args[0]} ${call.args[1]}`);
  for (const label of ['pane split', 'agent start', 'agent get', 'pane process-info', 'agent prompt']) assert.ok(labels.includes(label));
  assert.ok(f.calls.findIndex((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && !call.args.includes('/exit')) < f.calls.findIndex((call) => call.args.includes('/exit')));
  for (const key of ['chainId', 'callerPane', 'callerSession', 'callerContext', 'callerModel', 'successorPane', 'successorSession', 'successorModel', 'modelChanged', 'handoff', 'ts']) assert.notEqual(result.output[key], undefined);
  assert.equal(existsSync(join(root, 'final-pending', '11111111-1111-4111-8111-111111111111')), true);
  const invalid = fixture(t); const invalidFile = handoff(invalid);
  const noRetireCapture = await runSession(['chain', '--handoff', invalidFile, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--capture-final', '--no-retire', '--log', invalid.log], { exec: invalid.exec, env: env() });
  assert.equal(noRetireCapture.exit, 2); assert.equal(invalid.calls.length, 0);
});

test('S9: a model change is flagged', async (t) => {
  const changed = fixture(t); const changedFile = handoff(changed); changed.handler = successHerdr({ callerModel: 'claude-fable-5-1' });
  const yes = await runSession(['chain', '--handoff', changedFile, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--no-retire', '--log', changed.log], { exec: changed.exec, env: env() });
  assert.equal(yes.output.modelChanged, true); assert.match(yes.output.warning, /model changed/);
  const same = fixture(t); const sameFile = handoff(same); same.handler = successHerdr({ callerModel: 'claude-fable-5-1', successorModel: 'claude-fable-5-1' });
  const no = await runSession(['chain', '--handoff', sameFile, '--name', 'new', '--model', 'claude-fable-5-1', '--effort', 'high', '--no-retire', '--log', same.log], { exec: same.exec, env: env() });
  assert.equal(no.output.modelChanged, false);
});

// 317f6cef: herdr's refusal when `agent start` lands on a pane whose shell has not
// drawn its prompt yet, verbatim from the 2026-10-01 23:59:04Z session-log row.
const paneBusy = { code: 1, stdout: '', stderr: '{"error":{"code":"agent_pane_busy","message":"agent target pane pane:successor is not an available shell"},"id":"cli:agent:start"}' };
// The fixture's process-info envelope reports shell_pid 1: a bare split is its shell alone.
const bareShell = () => ({ code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'pwsh.exe', pid: 1 })]), stderr: '' });
function busyHerdr(busyStarts, { onStart = () => {}, exitResult = null, successorInfo = bareShell } = {}) {
  const success = successHerdr();
  let starts = 0;
  return (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'agent start') {
      starts++; onStart(starts);
      if (starts > 1000) throw new Error('agent start retried without a bound');
      if (starts <= busyStarts) return paneBusy;
    }
    if (key === 'pane process-info' && args.at(-1) === 'pane:successor' && starts <= busyStarts) return successorInfo();
    if (key === 'agent prompt' && args.includes('/exit') && exitResult) return exitResult;
    return success(program, args);
  };
}
function chainArgv(f, ...extra) { return ['chain', '--handoff', handoff(f), '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--log', f.log, ...extra]; }
function clock() { const c = { now: 0 }; c.deps = { now: () => c.now, sleep: async (ms) => { c.now += ms; } }; return c; }
function startCalls(f) { return f.calls.filter((call) => call.args[0] === 'agent' && call.args[1] === 'start'); }
function exitSent(f) { return f.calls.some((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && call.args.includes('/exit')); }

test('317f6cef falsifier: agent_pane_busy once, then success — chain retries on the same pane, briefs, and retires the caller', async (t) => {
  const f = fixture(t); const c = clock(); f.handler = busyHerdr(1);
  const result = await runSession(chainArgv(f), { exec: f.exec, env: env(), ...c.deps });
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.deepEqual(startCalls(f).map((call) => call.args[call.args.indexOf('--pane') + 1]), ['pane:successor', 'pane:successor']);
  assert.equal(f.calls.filter((call) => call.args[0] === 'pane' && call.args[1] === 'split').length, 1);
  assert.ok(f.calls.some((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && call.args[2] === 'new' && /^Read .* and execute it exactly\.$/.test(call.args[3])), 'the successor is briefed');
  assert.equal(row(f).successorStartAttempts, 2);
  assert.deepEqual([exitSent(f), result.output.callerRetirement], [true, 'retiring']);
});

test('317f6cef: a chain that started on a retry reaches the same retirement path, and status --last shows the caller retiring', async (t) => {
  const f = fixture(t); const c = clock(); f.handler = busyHerdr(3);
  const result = await runSession(chainArgv(f), { exec: f.exec, env: env(), ...c.deps });
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.deepEqual(f.calls.filter((call) => call.args.includes('/exit')).map((call) => call.args), [['agent', 'prompt', 'pane:caller', '/exit']]);
  const status = await runSession(['status', '--last', '--log', f.log], { exec: f.exec, env: env() });
  const [last] = status.output.rows;
  assert.deepEqual([last.state, last.callerRetirement, last.callerPane, last.successorStartAttempts], ['chained', 'retiring', 'pane:caller', 4]);
});

test('317f6cef custody: a pane busy for the whole successor timeout leaves the caller live, closes the empty split, and reports agent_pane_busy', async (t) => {
  const f = fixture(t); const c = clock(); f.handler = busyHerdr(Infinity);
  const result = await runSession(chainArgv(f, '--successor-timeout', '5000'), { exec: f.exec, env: env(), ...c.deps });
  assert.equal(result.exit, 4, JSON.stringify(result.output));
  assert.equal(exitSent(f), false, 'no /exit reaches the caller');
  assert.match(result.output.error, /agent_pane_busy/);
  assert.deepEqual([row(f).state, row(f).reason, row(f).successorPane, row(f).successorPaneClosed], ['failed', 'agent_pane_busy', 'pane:successor', true]);
  assert.deepEqual(f.calls.filter((call) => call.args[0] === 'pane' && call.args[1] === 'close').map((call) => call.args[2]), ['pane:successor']);
  // Any other start failure is final on the first attempt and closes nothing.
  const other = fixture(t); const otherClock = clock();
  other.handler = (program, args) => (`${args[0]} ${args[1]}` === 'agent start' ? { code: 1, stdout: '', stderr: '{"error":{"code":"agent_timeout"}}' } : successHerdr()(program, args));
  const failed = await runSession(chainArgv(other), { exec: other.exec, env: env(), ...otherClock.deps });
  assert.deepEqual([failed.exit, startCalls(other).length, exitSent(other), row(other).successorPane], [1, 1, false, 'pane:successor']);
  assert.equal(other.calls.some((call) => call.args[0] === 'pane' && call.args[1] === 'close'), false);
});

// workit#132 council S1: only a pane whose foreground is its shell alone is an empty split.
test('317f6cef close predicate: busy exhaustion closes the split only when its foreground is the shell alone, and names why it kept one', async (t) => {
  const processInfo = (...processes) => () => ({ code: 0, stdout: herdrShapes.processInfo(processes), stderr: '' });
  for (const [label, successorInfo, kept] of [
    ['codex.exe (council probe)', processInfo(herdrShapes.process({ name: 'codex.exe', pid: 7 })), 'foreground-not-shell'],
    ['claude.exe', processInfo(herdrShapes.process({ name: 'claude.exe', pid: 8 })), 'foreground-not-shell'],
    ['the shell and a child', processInfo(herdrShapes.process({ name: 'pwsh.exe', pid: 1 }), herdrShapes.process({ name: 'node.exe', pid: 9 })), 'foreground-not-shell'],
    ['a shell-named child', processInfo(herdrShapes.process({ name: 'pwsh.exe', pid: 10 })), 'foreground-not-shell'],
    ['an empty foreground', processInfo(), 'foreground-not-shell'],
    ['process-info failing', () => ({ code: 1, stdout: '', stderr: 'pane_not_found' }), 'process-info-failed'],
    ['process-info unreadable', () => ({ code: 0, stdout: '{not-json', stderr: '' }), 'process-info-unreadable'],
  ]) {
    const f = fixture(t); const c = clock(); f.handler = busyHerdr(Infinity, { successorInfo });
    const result = await runSession(chainArgv(f, '--successor-timeout', '1000'), { exec: f.exec, env: env(), ...c.deps });
    assert.deepEqual([result.exit, row(f).successorPaneClosed, row(f).successorPaneKept, exitSent(f)], [4, false, kept, false], label);
    assert.equal(f.calls.some((call) => call.args[0] === 'pane' && call.args[1] === 'close'), false, label);
  }
});

// workit#132 council M1: no start attempt begins at or after the deadline, the
// sleep is capped at what remains, and a start that returns after the deadline
// is not ready, so the caller is never retired on it.
test('317f6cef bound: busy-forever retries stop at the successor timeout measured from the split', async (t) => {
  for (const timeout of [5000, 4100]) {
    const f = fixture(t); const c = clock(); let lastStartAt = null;
    f.handler = busyHerdr(Infinity, { onStart: () => { lastStartAt = c.now; } });
    const result = await runSession(chainArgv(f, '--successor-timeout', String(timeout)), { exec: f.exec, env: env(), ...c.deps });
    const attempts = Math.ceil(timeout / 250);
    assert.deepEqual([result.exit, c.now, startCalls(f).length, row(f).startAttempts], [4, timeout, attempts, attempts], `timeout ${timeout}`);
    assert.ok(lastStartAt < timeout, `timeout ${timeout}: last start at ${lastStartAt}`);
  }
});

test('317f6cef M1 astra probe: busy, then a success that would start after a 100 ms budget, never retires the caller', async (t) => {
  const f = fixture(t); const c = clock(); f.handler = busyHerdr(1);
  const result = await runSession(chainArgv(f, '--successor-timeout', '100'), { exec: f.exec, env: env(), ...c.deps });
  assert.deepEqual([result.exit, startCalls(f).length, exitSent(f), c.now], [4, 1, false, 100], JSON.stringify(result.output));
});

test('317f6cef M1 codex probe: busy twice, then a slow success that would land at 800 ms on a 500 ms budget, never retires the caller', async (t) => {
  const f = fixture(t); const c = clock(); f.handler = busyHerdr(2, { onStart: (n) => { if (n === 3) c.now += 300; } });
  const result = await runSession(chainArgv(f, '--successor-timeout', '500'), { exec: f.exec, env: env(), ...c.deps });
  assert.deepEqual([result.exit, startCalls(f).length, exitSent(f)], [4, 2, false], JSON.stringify(result.output));
});

test('317f6cef M1 latency: a start launched in the window that returns after the deadline is successor-not-ready, and the caller stays', async (t) => {
  const f = fixture(t); const c = clock(); f.handler = busyHerdr(1, { onStart: (n) => { if (n === 2) c.now += 400; } });
  const result = await runSession(chainArgv(f, '--successor-timeout', '500'), { exec: f.exec, env: env(), ...c.deps });
  assert.equal(result.exit, 4, JSON.stringify(result.output));
  assert.equal(exitSent(f), false);
  assert.deepEqual([row(f).outcome, row(f).successorStartAttempts, row(f).successorStartedLate], ['successor-not-ready', 2, true]);
  assert.deepEqual(startCalls(f).map((call) => call.args[call.args.indexOf('--timeout') + 1]), ['500', '250'], 'a retry gets only the remaining budget');
});

test('317f6cef: a refused /exit to the caller is its own row, so status --last does not read as retired', async (t) => {
  const f = fixture(t); const c = clock();
  f.handler = busyHerdr(0, { exitResult: { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found"}}' } });
  const result = await runSession(chainArgv(f), { exec: f.exec, env: env(), ...c.deps });
  assert.equal(result.exit, 1);
  assert.match(result.output.error, /\/exit failed: .*agent_not_found/);
  const status = await runSession(['status', '--last', '--log', f.log], { exec: f.exec, env: env() });
  assert.deepEqual([status.output.rows[0].state, status.output.rows[0].callerRetirement, status.output.rows[0].exit], ['retire-failed', 'exit-refused', 1]);
});

// workit#132 council U1/U2: a refused /exit leaves a live caller, so its final
// capture is disarmed and the persisted chain record agrees with the log.
test('317f6cef: a refused /exit disarms --capture-final and marks the persisted chain exit-refused', async (t) => {
  const f = fixture(t); const c = clock(); const root = join(f.dir, 'capture');
  f.handler = busyHerdr(0, { exitResult: { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found"}}' } });
  const result = await runSession(chainArgv(f, '--capture-final'), { exec: f.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: root }), ...c.deps });
  assert.equal(result.exit, 1);
  assert.equal(existsSync(join(root, 'final-pending', '11111111-1111-4111-8111-111111111111')), false, 'no marker is left armed on a live caller');
  assert.deepEqual([result.output.finalMessagePath, row(f).finalMessagePath], [null, null]);
  assert.equal(state(f).chains.at(-1).callerRetirement, 'exit-refused');
  // Positive branch: an accepted /exit keeps the marker and the persisted 'retiring'.
  const ok = fixture(t); const okClock = clock(); const okRoot = join(ok.dir, 'capture'); ok.handler = busyHerdr(0);
  await runSession(chainArgv(ok, '--capture-final'), { exec: ok.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: okRoot }), ...okClock.deps });
  assert.equal(existsSync(join(okRoot, 'final-pending', '11111111-1111-4111-8111-111111111111')), true);
  assert.equal(state(ok).chains.at(-1).callerRetirement, 'retiring');
});

const rotation4ExitDialog = `Background work is running
The following will stop when you exit:
  shell · cd /d/Development/projects/workit && node scripts…
❯ 1. Exit and stop tasks
  2. Move to background and exit
  3. Stay
Enter to confirm · Esc to cancel`;

test('R1: retire answers the recorded exit dialog when every child is an MCP server', async (t) => {
  const f = fixture(t); let waits = 0; let processReads = 0; let paneReads = 0;
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old', sessionId: '44444444-4444-4444-8444-444444444444' } }, chains: [] }), 'utf8');
  f.handler = (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 0, stdout: JSON.stringify(['run-a-mcp.js', 'run-b-mcp.js', 'run-c-mcp.js'].map((name) => ({ CommandLine: `node C:\\mcp\\${name}` }))), stderr: '' };
    if (key === 'agent wait') return waits++ === 0 ? { code: 1, stdout: '', stderr: 'timeout' } : { code: 1, stdout: '', stderr: 'agent_not_found' };
    if (key === 'pane read') return { code: 0, stdout: paneReads++ === 0 ? rotation4ExitDialog : 'Resume this session with:\nclaude --resume 33333333-3333-4333-8333-333333333333', stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: processReads++ === 0 ? 'claude.exe' : 'pwsh.exe', argv0: '<path>/claude.exe', pid: 42 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0); assert.equal(result.output.closed, true); assert.equal(result.output.resumeId, '33333333-3333-4333-8333-333333333333'); assert.equal(result.output.dialogAnswered, true); assert.equal(row(f).dialogAnswered, true);
  assert.equal(callsFor(f, 'pane').filter((call) => call.args[1] === 'send-keys' && call.args[3] === 'enter').length, 1);
  assert.match(f.calls.find((call) => call.program === 'powershell.exe').args.at(-1), /ParentProcessId -eq 42/);
});

test('R1: retire refuses the exit dialog when a non-MCP background child remains', async (t) => {
  const f = fixture(t);
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  f.handler = (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 0, stdout: JSON.stringify([{ CommandLine: 'node scripts/lane.mjs wait caller' }]), stderr: '' };
    if (key === 'agent wait') return { code: 1, stdout: '', stderr: 'timeout' };
    if (key === 'pane read') return { code: 0, stdout: rotation4ExitDialog, stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe', argv0: '<path>/claude.exe', pid: 43 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 3); assert.equal(result.output.dialog, 'background-process-live'); assert.deepEqual(result.output.argv, ['node scripts/lane.mjs wait caller']);
  assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'send-keys'), false);
});

// 68af2e33: the two background `lane wait` children that blocked a retire in
// Burn-down V (2026-09-20), in Claude Code's bash wrapper as logged (argv in
// session-log.jsonl), host paths replaced with fixture paths. Y's shape is the
// second one.
const bashWrapped = (command) => String.raw`"C:\Program Files\Git\bin\bash.exe" -c "source /x/home/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && export TEMP='X:\tmp' TMP='X:\tmp' && shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '` + command + String.raw`' < /dev/null && pwd -P >| /x/tmp/claude-defe-cwd"`;
const V_WAIT = bashWrapped(String.raw`LOG=/x/lanes/lane-log.jsonl; node /x/workit/scripts/lane.mjs wait v3-beat-guard --until blocked --until idle --until done --timeout 2400000 --plan-floor 20 --log \"$LOG\" 2>&1 | tee \"X:/scratch/v3-wait2.txt\"; echo \"WAIT_EXIT=$?\" >> \"X:/scratch/v3-wait2.txt\"`);
const Y_WAIT = bashWrapped('node X:/x/plugins/cache/workit/workit/1.24.1/scripts/lane.mjs wait yd2 --until blocked --until idle --until done --timeout 3600000 2>&1 | tail -1; date -u +%H:%M:%SZ');

test('68af2e33: a caller\'s background lane waits do not block retire — the dialog is answered and the waits counted', async (t) => {
  const f = fixture(t); let waits = 0; let processReads = 0; let paneReads = 0;
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  const children = [{ CommandLine: 'node C:\\mcp\\run-a-mcp.js' }, { CommandLine: V_WAIT }, { CommandLine: Y_WAIT }];
  f.handler = (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 0, stdout: JSON.stringify(children), stderr: '' };
    if (key === 'agent wait') return waits++ === 0 ? { code: 1, stdout: '', stderr: 'timeout' } : { code: 1, stdout: '', stderr: 'agent_not_found' };
    if (key === 'pane read') return { code: 0, stdout: paneReads++ === 0 ? rotation4ExitDialog : 'Resume this session with:\nclaude --resume 33333333-3333-4333-8333-333333333333', stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: processReads++ === 0 ? 'claude.exe' : 'pwsh.exe', argv0: '<path>/claude.exe', pid: 42 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.deepEqual([result.output.dialogAnswered, result.output.abandonedLaneWaits, result.output.closed], [true, 2, true]);
  assert.equal(callsFor(f, 'pane').filter((call) => call.args[1] === 'send-keys' && call.args[3] === 'enter').length, 1);
});

test('68af2e33: only a wait and its output plumbing are abandonable; anything else in the command refuses', () => {
  assert.equal(laneWaitMonitor(V_WAIT), true);
  assert.equal(laneWaitMonitor(Y_WAIT), true);
  for (const command of [
    'node /x/lane.mjs wait a && git push',
    'node /x/lane.mjs wait a; node /x/lane.mjs sweep --lane a',
    'node /x/lane.mjs wait a --log $(rm -rf /x/y)',
    'node /x/lane.mjs wait a --log `id`',
    'node /x/lane.mjs stop a',
    'npm test 2>&1 | tail -5',
    'echo waiting',
    // workit#129 review (codex P1, astra P2): separators the segment split does not parse.
    'node /x/lane.mjs wait a\ngit push',
    'node /x/lane.mjs wait a\r\ngit push',
    'node /x/lane.mjs wait a & npm run build',
    'node /x/lane.mjs wait a 2>&1 & npm run build',
    'node /x/lane.mjs wait a |& sh',
    'node /x/lane.mjs wait a | tee >(sh)',
    'node /x/lane.mjs wait a < <(git push)',
  ]) assert.equal(laneWaitMonitor(bashWrapped(command)), false, JSON.stringify(command));
  assert.equal(laneWaitMonitor(bashWrapped('node /x/lane.mjs wait a &>/x/w.txt; echo done >&2')), true, 'redirections are plumbing, not separators');
  assert.equal(laneWaitMonitor('node scripts/lane.mjs wait caller'), false, 'a bare node child is not the background-task shape');
  assert.equal(laneWaitMonitor(V_WAIT.replace(' < /dev/null', '')), false, 'the wrapper shape is required');
});

// 68af2e33 (reopened): the caller is ALREADY on the exit dialog when the successor
// retires it (2026-10-02, w1R:p1). herdr listed that hand-started Claude with no
// `name` (agent_list at 09:21:40Z) and refused its `/exit` with agent_blocked.
const NAMELESS_OWNER = [{ agent: 'claude', agent_status: 'blocked', pane_id: 'w1R:p1' }];
const NAMED_OWNER = [{ agent: 'claude', agent_status: 'blocked', pane_id: 'w1R:p1', name: 'conductor' }];
const BASH_LANE_WAIT = bashWrapped('node X:/x/plugins/cache/workit/workit/1.27.9/scripts/lane.mjs wait o790 --until idle --until done --timeout 3500000');
// A Claude Code PowerShell-tool background child, captured 2026-10-03 from a live
// claude.exe while `Start-Sleep 45; Write-Output 'probe-done'` ran in the background;
// host paths replaced. The command itself is not in the argv: it arrives through
// CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT, so the classifier cannot read it.
const PWSH_TOOL_CHILD = String.raw`C:\WINDOWS\System32\cmd.exe /d /s /c ""C:\WINDOWS\System32\chcp.com" 65001 >nul & "X:\pwsh\pwsh.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT = $null; Invoke-Expression -Command $__claudeCodeScript" > "X:\tmp\claude\tasks\bjrm7181g.output" 2>&1"`;
const BLOCKED_EXIT = { code: 1, stdout: '', stderr: '{"error":{"code":"agent_blocked","message":"agent w1R:p1 is blocked and requires interactive input"},"id":"cli:agent:prompt"}' };

// The pane sits on `screen` until Enter is sent; then the agent is gone and the pane
// shows the resume banner over a bare shell.
function openDialogHerdr(f, { agents = NAMELESS_OWNER, children = [{ CommandLine: BASH_LANE_WAIT }], screen = rotation4ExitDialog } = {}) {
  const answered = () => f.calls.some((call) => call.args[0] === 'pane' && call.args[1] === 'send-keys');
  return (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 0, stdout: JSON.stringify(children), stderr: '' };
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents }), stderr: '' };
    if (key === 'agent get') return { code: 0, stdout: herdrShapes.agentGet({ pane: 'w1R:p1', state: 'blocked', session: '77777777-7777-4777-8777-777777777777' }), stderr: '' };
    if (key === 'agent prompt') return answered() ? { code: 0, stdout: herdrShapes.prompt(), stderr: '' } : BLOCKED_EXIT;
    if (key === 'agent wait') return answered() ? { code: 1, stdout: '', stderr: 'agent_not_found' } : { code: 1, stdout: '', stderr: 'timeout' };
    if (key === 'pane read') return { code: 0, stdout: answered() ? 'Resume this session with:\nclaude --resume 77777777-7777-4777-8777-777777777777' : screen, stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process(answered() ? { name: 'pwsh.exe', pid: 1 } : { name: 'claude.exe', argv0: '<path>/claude.exe', pid: 42 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
}
const sendKeys = (f) => callsFor(f, 'pane').filter((call) => call.args[1] === 'send-keys');
const paneReads = (f) => callsFor(f, 'pane').filter((call) => call.args[1] === 'read').length;
const fastClock = () => { let now = 0; return { now: () => (now += 1000), sleep: async () => {} }; };

test('68af2e33: a nameless herdr owner already on the exit dialog is retired by --mode close with one Enter', async (t) => {
  const f = fixture(t); f.handler = openDialogHerdr(f);
  const result = await runSession(['retire', 'w1R:p1', '--mode', 'close', '--log', f.log], { exec: f.exec, ...fastClock() });
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.deepEqual([result.output.closed, result.output.dialogAnswered, result.output.abandonedLaneWaits, result.output.target], [true, true, 1, 'w1R:p1']);
  assert.equal(sendKeys(f).length, 1); assert.equal(sendKeys(f)[0].args[3], 'enter');
  assert.equal(f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'wait').args[2], 'w1R:p1', 'the pane id addresses the nameless owner');
});

test('68af2e33: exit+close answers an already-open exit dialog when herdr refuses /exit with agent_blocked', async (t) => {
  for (const agents of [NAMELESS_OWNER, NAMED_OWNER]) {
    const f = fixture(t); f.handler = openDialogHerdr(f, { agents });
    const result = await runSession(['retire', 'w1R:p1', '--mode', 'exit+close', '--dialog-after-ms', '3000', '--timeout', '60000', '--log', f.log], { exec: f.exec, ...fastClock() });
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    assert.deepEqual([result.output.closed, result.output.dialogAnswered, result.output.abandonedLaneWaits, result.output.resumeId], [true, true, 1, '77777777-7777-4777-8777-777777777777']);
    assert.equal(sendKeys(f).length, 1);
    assert.equal(callsFor(f, 'agent').filter((call) => call.args[1] === 'prompt').length, 1, 'the refused /exit is not resent');
  }
});

test('68af2e33: a PowerShell-tool background child on an already-open dialog refuses in both modes with its argv and no key', async (t) => {
  const outcomes = [];
  for (const mode of ['close', 'exit+close']) {
    const f = fixture(t); f.handler = openDialogHerdr(f, { children: [{ CommandLine: PWSH_TOOL_CHILD }] });
    const result = await runSession(['retire', 'w1R:p1', '--mode', mode, '--log', f.log], { exec: f.exec, ...fastClock() });
    outcomes.push({ mode, exit: result.exit, dialog: result.output.dialog, argv: result.output.argv, keys: sendKeys(f).length });
  }
  assert.deepEqual(outcomes, ['close', 'exit+close'].map((mode) => ({ mode, exit: 3, dialog: 'background-process-live', argv: [PWSH_TOOL_CHILD], keys: 0 })));
  assert.equal(laneWaitMonitor(PWSH_TOOL_CHILD), false);
  assert.equal(laneWaitMonitor(bashWrapped('Start-Sleep 8; node X:/x/lane.mjs wait o790 --until idle')), false, 'no sleep-prefix shape is recognised');
});

test('68af2e33: agent_blocked on a prompt that is not the exit dialog sends no key and returns the pane text', async (t) => {
  const prompt = 'Do you want to make this edit to session.mjs?\n❯ 1. Yes\n  2. No\nEsc to cancel';
  const f = fixture(t); f.handler = openDialogHerdr(f, { screen: prompt });
  const result = await runSession(['retire', 'w1R:p1', '--mode', 'exit+close', '--log', f.log], { exec: f.exec, ...fastClock() });
  assert.equal(result.exit, 3, JSON.stringify(result.output));
  assert.equal(result.output.dialog, 'blocked-other-prompt'); assert.equal(result.output.paneText, prompt);
  assert.equal(sendKeys(f).length, 0); assert.equal(f.calls.some((call) => call.program === 'powershell.exe'), false);
});

test('68af2e33: --mode exit alone keeps the plain agent_blocked failure and reads nothing', async (t) => {
  const f = fixture(t); f.handler = openDialogHerdr(f);
  const result = await runSession(['retire', 'w1R:p1', '--mode', 'exit', '--log', f.log], { exec: f.exec, ...fastClock() });
  assert.equal(result.exit, 1); assert.match(result.output.error, /^herdr agent prompt w1R:p1 \/exit failed: .*agent_blocked/);
  assert.equal(sendKeys(f).length, 0); assert.equal(paneReads(f), 0);
});

test('68af2e33: a pane no herdr entry claims stays gone; another pane\'s nameless entry does not claim it', async (t) => {
  const f = fixture(t); let now = 0;
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents: [{ agent: 'claude', pane_id: 'wX:p9' }] }), stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe' })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'w1R:p1', '--mode', 'close', '--timeout', '1', '--log', f.log], { exec: f.exec, now: () => (now += 2), sleep: async () => {} });
  assert.equal(result.exit, 3); assert.match(result.output.error, /still has a live Claude process/);
  assert.equal(f.calls.some((call) => call.args[0] === 'agent' && ['get', 'wait'].includes(call.args[1])), false, 'a gone pane is never waited on');
  assert.equal(paneReads(f), 0); assert.equal(sendKeys(f).length, 0);
});

test('68af2e33: a nameless owner\'s final message comes from herdr\'s live session, not a stale record on the pane', async (t) => {
  const f = fixture(t); const root = join(f.dir, 'capture');
  const stale = '55555555-5555-4555-8555-555555555555'; const live = '77777777-7777-4777-8777-777777777777';
  mkdirSync(join(root, 'final'), { recursive: true });
  for (const id of [stale, live]) writeFileSync(join(root, 'final', `${id}.md`), id, 'utf8');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'other' } }, chains: [{ callerPane: 'w1R:p1', callerSession: stale }] }), 'utf8');
  f.handler = openDialogHerdr(f);
  const result = await runSession(['retire', 'w1R:p1', '--mode', 'close', '--log', f.log], { exec: f.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: root }), ...fastClock() });
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.equal(result.output.finalMessagePath, join(root, 'final', `${live}.md`));
});

// workit#133 council r1. The exit dialog counts only as the ACTIVE prompt at the
// bottom of the read. The live shape is the w1R:p1 read of 2026-10-02 10:12:14Z,
// host paths replaced.
const LIVE_EXIT_DIALOG = `  ✻ Crunched for 2m 10s · done 5:10 AM
Background task update waiting while this panel is open
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Background work is running
   The following will stop when you exit:

   shell · Start-Sleep 8; node X:/x/.claude/plugin…
   shell · node X:/x/.claude/plugins/cache/workit/…

   ❯ 1. Exit and stop tasks
     2. Move to background and exit
     3. Stay

   Enter to confirm · Esc to cancel
`;
const EDIT_PROMPT = `⏺ Update(scripts/session.mjs)
Do you want to make this edit to session.mjs?
❯ 1. Yes
  2. Yes, allow all edits during this session (shift+tab)
  3. No, and tell Claude what to do differently (esc)`;
const MIXED_SCREENS = {
  'old dialog, current edit prompt': `${rotation4ExitDialog}\n${EDIT_PROMPT}`,
  'old dialog, current menu with the same footer': `${rotation4ExitDialog}\nSelect a model\n❯ 1. Opus\n  2. Sonnet\nEnter to confirm · Esc to cancel`,
  'dialog with the cursor on Stay': rotation4ExitDialog.replace('❯ 1. Exit and stop tasks', '  1. Exit and stop tasks').replace('  3. Stay', '❯ 3. Stay'),
};

test('#133 M1: exit dialog text that is not the active prompt is never answered, on either entry point', async (t) => {
  const outcomes = [];
  for (const [name, screen] of Object.entries(MIXED_SCREENS)) {
    for (const mode of ['close', 'exit+close']) {
      const f = fixture(t); f.handler = openDialogHerdr(f, { agents: NAMED_OWNER, screen });
      const result = await runSession(['retire', 'w1R:p1', '--mode', mode, '--log', f.log], { exec: f.exec, ...fastClock() });
      outcomes.push({ name, mode, exit: result.exit, dialog: result.output.dialog, keys: sendKeys(f).length, children: f.calls.filter((call) => call.program === 'powershell.exe').length });
    }
  }
  assert.deepEqual(outcomes, Object.keys(MIXED_SCREENS).flatMap((name) => ['close', 'exit+close'].map((mode) => ({ name, mode, exit: 3, dialog: 'exit-dialog-not-active', keys: 0, children: 0 }))));
});

test('#133 M1: the live exit dialog at the bottom of the read is still answered, on either entry point', async (t) => {
  for (const mode of ['close', 'exit+close']) {
    const f = fixture(t); f.handler = openDialogHerdr(f, { agents: NAMED_OWNER, screen: LIVE_EXIT_DIALOG });
    const result = await runSession(['retire', 'w1R:p1', '--mode', mode, '--log', f.log], { exec: f.exec, ...fastClock() });
    assert.equal(result.exit, 0, `${mode}: ${JSON.stringify(result.output)}`);
    assert.deepEqual([result.output.dialogAnswered, sendKeys(f).length], [true, 1], mode);
  }
});

test('#133 N1: a named entry beats a nameless one on the same pane, in either list order', async (t) => {
  for (const agents of [[...NAMED_OWNER, ...NAMELESS_OWNER], [...NAMELESS_OWNER, ...NAMED_OWNER]]) {
    const f = fixture(t); f.handler = openDialogHerdr(f, { agents });
    const result = await runSession(['retire', 'w1R:p1', '--mode', 'close', '--log', f.log], { exec: f.exec, ...fastClock() });
    assert.equal(result.output.target, 'conductor', JSON.stringify(agents));
    assert.equal(f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'wait').args[2], 'conductor');
  }
});

test('#133 S2: a refusal logs a bounded excerpt from the bottom of the pane', async (t) => {
  const scroll = Array.from({ length: 60 }, (_, i) => `transcript line ${i} ${'x'.repeat(300)}`).join('\n');
  const f = fixture(t); f.handler = openDialogHerdr(f, { screen: `${scroll}\n${EDIT_PROMPT}\n\n` });
  const result = await runSession(['retire', 'w1R:p1', '--mode', 'exit+close', '--log', f.log], { exec: f.exec, ...fastClock() });
  assert.equal(result.output.dialog, 'blocked-other-prompt');
  const excerpt = row(f).paneText;
  assert.equal(excerpt, result.output.paneText);
  assert.ok(excerpt.split('\n').length <= 15, `${excerpt.split('\n').length} lines`);
  assert.equal(excerpt.length, 2000);
  assert.ok(excerpt.endsWith('3. No, and tell Claude what to do differently (esc)'));
});

test('#133 S3: agent_blocked on a pane herdr lists no agent for still reads the pane and keeps the dialog guards', async (t) => {
  const outcomes = [];
  for (const [name, options] of Object.entries({
    'lane wait': {},
    'PowerShell child': { children: [{ CommandLine: PWSH_TOOL_CHILD }] },
    'other prompt': { screen: EDIT_PROMPT },
  })) {
    const f = fixture(t); f.handler = openDialogHerdr(f, { agents: [], ...options });
    const result = await runSession(['retire', 'w1R:p1', '--mode', 'exit+close', '--log', f.log], { exec: f.exec, ...fastClock() });
    outcomes.push({ name, exit: result.exit, dialog: result.output.dialog ?? null, answered: result.output.dialogAnswered ?? null, reads: paneReads(f) > 0, keys: sendKeys(f).length });
  }
  assert.deepEqual(outcomes, [
    { name: 'lane wait', exit: 0, dialog: null, answered: true, reads: true, keys: 1 },
    { name: 'PowerShell child', exit: 3, dialog: 'background-process-live', answered: null, reads: true, keys: 0 },
    { name: 'other prompt', exit: 3, dialog: 'blocked-other-prompt', answered: null, reads: true, keys: 0 },
  ]);
});

test('R1: prose containing Background is not the exit dialog', async (t) => {
  const f = fixture(t); let now = 0;
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  f.handler = (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 0, stdout: JSON.stringify([{ CommandLine: 'node C:\\mcp\\run-safe-mcp.js' }]), stderr: '' };
    if (key === 'agent wait') return { code: 1, stdout: '', stderr: 'timeout' };
    if (key === 'pane read') return { code: 0, stdout: 'Background color was discussed; no confirmation prompt is present.', stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe', pid: 44 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--timeout', '60000', '--dialog-after-ms', '15000', '--log', f.log], { exec: f.exec, now: () => (now += 15_000) });
  assert.equal(result.exit, 4); assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'send-keys'), false);
});

test('R2: an unrecorded, ownerless pane closes from Herdr resolution', async (t) => {
  const f = fixture(t);
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents: [] }), stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'pwsh.exe' })]), stderr: '' };
    if (key === 'pane read') return { code: 0, stdout: 'Resume this session with:\nclaude --resume 44444444-4444-4444-8444-444444444444', stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'wF:p13', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0); assert.equal(result.output.resolvedFrom, 'herdr'); assert.equal(result.output.resumeId, '44444444-4444-4444-8444-444444444444'); assert.equal(result.output.closed, true); assert.equal(row(f).resolvedFrom, 'herdr');
  assert.equal(callsFor(f, 'pane').filter((call) => call.args[1] === 'close').length, 1);
});

test('R2: a missing raw pane reports pane_not_found', async (t) => {
  const f = fixture(t);
  f.handler = (_program, args) => `${args[0]} ${args[1]}` === 'pane get'
    ? { code: 1, stdout: '', stderr: 'pane_not_found' }
    : { code: 0, stdout: herdrShapes.empty('fixture'), stderr: '' };
  const result = await runSession(['retire', 'wZ:p9', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 2); assert.match(result.output.error, /pane_not_found/);
});

test('R3: retire reports the final message file captured for its session', async (t) => {
  const f = fixture(t); const root = join(f.dir, 'capture'); const id = '99999999-9999-4999-8999-999999999999'; const final = join(root, 'final', `${id}.md`);
  mkdirSync(join(root, 'final'), { recursive: true }); writeFileSync(final, 'captured final', 'utf8');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [{ callerPane: 'pane:old', callerSession: id }] }), 'utf8');
  f.handler = successHerdr({ processes: [herdrShapes.process({ name: 'pwsh.exe' })] });
  const result = await runSession(['retire', 'old', '--mode', 'close', '--log', f.log], { exec: f.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: root }) });
  assert.equal(result.exit, 0); assert.equal(result.output.finalMessagePath, final);
});

test('F2: plain no-dialog timeout windows keep waiting until the full close deadline', async (t) => {
  const f = fixture(t); let waits = 0; let now = 0;
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'agent wait') return waits++ < 2 ? { code: 1, stdout: '', stderr: 'timeout' } : { code: 1, stdout: '', stderr: 'agent_not_found' };
    if (key === 'pane read') return { code: 0, stdout: 'ordinary final transcript; no exit dialog', stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'pwsh.exe' })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--timeout', '60000', '--dialog-after-ms', '1000', '--log', f.log], { exec: f.exec, now: () => (now += 1000) });
  assert.equal(result.exit, 0); assert.equal(result.output.dialogAnswered, false); assert.equal(waits, 3);
  assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'send-keys'), false);
});

test('F3: a failed child listing is reported as unknown, not a live background process', async (t) => {
  const f = fixture(t);
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  f.handler = (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 1, stdout: '', stderr: 'Access denied' };
    if (key === 'agent wait') return { code: 1, stdout: '', stderr: 'timeout' };
    if (key === 'pane read') return { code: 0, stdout: rotation4ExitDialog, stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe', pid: 45 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 3); assert.equal(result.output.dialog, 'children-unknown'); assert.equal(result.output.childrenError, 'Access denied');
  assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'send-keys'), false);
});

test('P1: an ownerless raw pane with live Claude still fails the close guard', async (t) => {
  const f = fixture(t); let now = 0;
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents: [] }), stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe' })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'wF:p13', '--mode', 'close', '--timeout', '1', '--log', f.log], { exec: f.exec, now: () => (now += 2), sleep: async () => {} });
  assert.equal(result.exit, 3); assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'close'), false);
});

test('P1: a string pane field resolves an agent owner instead of treating it as gone', async (t) => {
  const f = fixture(t);
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents: [{ name: 'caller', pane: 'wF:p13' }] }), stderr: '' };
    if (key === 'agent wait') return { code: 1, stdout: '', stderr: 'agent_not_found' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'pwsh.exe' })]), stderr: '' };
    if (key === 'pane read') return { code: 0, stdout: 'banner absent', stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'wF:p13', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0); assert.equal(result.output.target, 'caller'); assert.equal(result.output.resolvedFrom, 'herdr');
  assert.equal(f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'wait').args[2], 'caller');
});

test('7b6a5fe1: a stale sidecar record naming a dead agent loses a pane-shaped target to herdr\'s live owner', async (t) => {
  // Verbatim shape of the 2026-10-01 incident: a 09-29 chain record still claimed wF:p2A.
  const f = fixture(t);
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { 'inherited-rulings': { name: 'inherited-rulings', pane: 'wF:p2A', sessionId: '55555555-5555-4555-8555-555555555555' } }, chains: [] }), 'utf8');
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents: [{ name: 'live-owner', pane_id: 'wF:p2A' }] }), stderr: '' };
    if (key === 'agent prompt' && args[2] !== 'live-owner') return { code: 1, stdout: '', stderr: `agent target ${args[2]} not found` };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'wF:p2A', '--mode', 'exit', '--log', f.log], { exec: f.exec });
  assert.equal(result.exit, 0, result.output.error);
  assert.equal(result.output.target, 'live-owner');
  assert.equal(result.output.resolvedFrom, 'herdr');
  assert.deepEqual(f.calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'prompt').args.slice(2), ['live-owner', '/exit']);
});

// The herdr-owner branch's session identity, for the final-message path: a stale
// record on the pane, under another name or under the owner's own reused name,
// must not supply it. Both final files exist, so a wrong lookup is visible.
async function retireOwnedPane(t, staleName, liveGet) {
  const f = fixture(t); const root = join(f.dir, 'capture');
  const stale = '55555555-5555-4555-8555-555555555555'; const live = '66666666-6666-4666-8666-666666666666';
  mkdirSync(join(root, 'final'), { recursive: true });
  for (const id of [stale, live]) writeFileSync(join(root, 'final', `${id}.md`), id, 'utf8');
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { [staleName]: { name: staleName, pane: 'wF:p2A', sessionId: stale } }, chains: [{ callerPane: 'wF:p2A', callerSession: stale }] }), 'utf8');
  f.handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane get') return { code: 0, stdout: herdrShapes.paneGet(), stderr: '' };
    if (key === 'agent list') return { code: 0, stdout: herdrShapes.envelope('agent:list', { agents: [{ name: 'live-owner', pane_id: 'wF:p2A' }] }), stderr: '' };
    if (key === 'agent get') return liveGet(live);
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'wF:p2A', '--mode', 'exit', '--log', f.log], { exec: f.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: root }) });
  assert.equal(result.exit, 0, result.output.error);
  assert.equal(result.output.target, 'live-owner');
  return { result, final: (id) => join(root, 'final', `${id}.md`), live };
}

const liveGet = (live) => ({ code: 0, stdout: herdrShapes.agentGet({ pane: 'wF:p2A', session: live }), stderr: '' });
const noSession = () => ({ code: 1, stdout: '', stderr: 'agent_not_found' });

test('7b6a5fe1 owner-1: a herdr-resolved owner\'s final message comes from its live session, not a differently named stale record', async (t) => {
  const { result, final, live } = await retireOwnedPane(t, 'inherited-rulings', liveGet);
  assert.equal(result.output.finalMessagePath, final(live));
});

test('7b6a5fe1 owner-2: a stale record under the owner\'s own reused name does not lend its session', async (t) => {
  const { result, final, live } = await retireOwnedPane(t, 'live-owner', liveGet);
  assert.equal(result.output.finalMessagePath, final(live));
});

test('7b6a5fe1 owner-3: with no live session from herdr, finalMessagePath\'s pane fallback does not restore the overruled record', async (t) => {
  const { result } = await retireOwnedPane(t, 'inherited-rulings', noSession);
  assert.equal(result.output.finalMessagePath, null);
});

test('7b6a5fe1 owner-4: a reused-name record cannot stand in for an unverifiable live session', async (t) => {
  const { result } = await retireOwnedPane(t, 'live-owner', noSession);
  assert.equal(result.output.finalMessagePath, null);
});

test('P1b: an agent that already exited (agent_not_running) is gone, for retire --mode close and watch --until gone', async (t) => {
  // Verbatim herdr shape from a chain whose caller had exited before the successor retired it (2026-09-28).
  const notRunning = { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_running","message":"agent is no longer running in the target pane"},"id":"cli:agent:wait"}' };
  const handler = (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'agent get') return { code: 0, stdout: herdrShapes.agentGet({ pane: 'pane:old' }), stderr: '' };
    if (key === 'agent wait') return notRunning;
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'pwsh.exe' })]), stderr: '' };
    if (key === 'pane read') return { code: 0, stdout: 'Resume this session with:\nclaude --resume 33333333-3333-4333-8333-333333333333\n', stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const close = fixture(t); writeFileSync(`${close.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); close.handler = handler;
  const retired = await runSession(['retire', 'old', '--mode', 'close', '--log', close.log], { exec: close.exec });
  assert.equal(retired.exit, 0); assert.equal(retired.output.closed, true); assert.equal(retired.output.resumeId, '33333333-3333-4333-8333-333333333333');
  assert.equal(callsFor(close, 'pane').some((call) => call.args[1] === 'close'), true);
  const watch = fixture(t); watch.handler = handler;
  const watched = await runSession(['watch', 'old', '--until', 'gone', '--timeout', '1', '--log', watch.log], { exec: watch.exec });
  assert.equal(watched.exit, 0); assert.equal(watched.output.state, 'gone');
});

test('P2: a blank child listing is unknown and never sends Enter', async (t) => {
  const f = fixture(t);
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8');
  f.handler = (program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (program === 'powershell.exe') return { code: 0, stdout: '', stderr: '' };
    if (key === 'agent wait') return { code: 1, stdout: '', stderr: 'timeout' };
    if (key === 'pane read') return { code: 0, stdout: rotation4ExitDialog, stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: herdrShapes.processInfo([herdrShapes.process({ name: 'claude.exe', pid: 46 })]), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty(key.replace(' ', ':')), stderr: '' };
  };
  const result = await runSession(['retire', 'old', '--mode', 'close', '--log', f.log], { exec: f.exec });
  assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'send-keys'), false);
  assert.equal(result.exit, 3); assert.equal(result.output.dialog, 'children-unknown');
});

test('S10: the Stop capture is marker-gated', async (t) => {
  const f = fixture(t); const root = join(f.dir, 'capture'); const id = '55555555-5555-4555-8555-555555555555'; const marker = join(root, 'final-pending', id);
  mkdirSync(join(root, 'final-pending'), { recursive: true });
  writeFileSync(marker, 'pending\n', { encoding: 'utf8', flag: 'w' });
  const captured = runStopCapture({ session_id: id, last_assistant_message: 'final words' }, { env: { WORKIT_SESSION_CHAIN_DIR: root } });
  assert.equal(captured.captured, true); assert.equal(readFileSync(join(root, 'final', `${id}.md`), 'utf8'), 'final words'); assert.equal(existsSync(marker), false);
  const other = runStopCapture({ session_id: '66666666-6666-4666-8666-666666666666', last_assistant_message: 'must not write' }, { env: { WORKIT_SESSION_CHAIN_DIR: root } });
  assert.equal(other.captured, false); assert.equal(existsSync(join(root, 'final', '66666666-6666-4666-8666-666666666666.md')), false);
  const emptyId = '77777777-7777-4777-8777-777777777777'; const emptyMarker = join(root, 'final-pending', emptyId); writeFileSync(emptyMarker, 'pending\n', 'utf8');
  const empty = runStopCapture({ session_id: emptyId }, { env: { WORKIT_SESSION_CHAIN_DIR: root } });
  assert.deepEqual(empty, { captured: false, reason: 'no-last_assistant_message' }); assert.equal(existsSync(emptyMarker), true);
  const self = fixture(t); const selfRoot = join(self.dir, 'self-capture'); self.handler = (_program, args) => {
    if (`${args[0]} ${args[1]}` === 'agent get') return { code: 0, stdout: herdrShapes.agentGet({ pane: 'pane:caller', session: id }), stderr: '' };
    if (`${args[0]} ${args[1]}` === 'agent prompt') return { code: 0, stdout: herdrShapes.prompt(), stderr: '' };
    return { code: 0, stdout: herdrShapes.empty('fixture'), stderr: '' };
  };
  const retired = await runSession(['retire', 'self', '--mode', 'exit', '--capture-final', '--log', self.log], { exec: self.exec, env: env({ WORKIT_SESSION_CHAIN_DIR: selfRoot }) });
  assert.equal(retired.exit, 0); assert.equal(existsSync(join(selfRoot, 'final-pending', id)), true);
});
