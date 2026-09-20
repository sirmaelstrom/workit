import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from './session.mjs';
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
