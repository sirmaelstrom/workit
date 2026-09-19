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

function successHerdr({ callerModel = 'claude-fable-5-1', context = '65', successorSession = '22222222-2222-4222-8222-222222222222', successorModel = 'claude-opus-5' } = {}) {
  return (_program, args) => {
    const key = `${args[0]} ${args[1]}`;
    if (key === 'pane split') return { code: 0, stdout: '{"result":{"pane_id":"pane:successor"}}', stderr: '' };
    if (key === 'agent start' || key === 'agent focus') return { code: 0, stdout: '{"result":{}}', stderr: '' };
    if (key === 'agent get') {
      const caller = args[2] === 'pane:caller';
      const id = caller ? '11111111-1111-4111-8111-111111111111' : successorSession;
      return { code: 0, stdout: JSON.stringify({ result: { state: 'idle', agent_session: { value: id } } }), stderr: '' };
    }
    if (key === 'pane get') return { code: 0, stdout: JSON.stringify({ result: { tokens: { context } } }), stderr: '' };
    if (key === 'pane process-info') return { code: 0, stdout: args.at(-1) === 'pane:caller' ? `--model ${callerModel}` : `--model ${successorModel}`, stderr: '' };
    if (key === 'agent prompt') return { code: 0, stdout: '{"result":{"accepted":true,"state":"working"}}', stderr: '' };
    if (key === 'agent wait') return { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' };
    if (key === 'pane read') return { code: 0, stdout: 'Resume this session with:\nclaude --resume 33333333-3333-4333-8333-333333333333', stderr: '' };
    if (key === 'pane close') return { code: 0, stdout: '{"result":{}}', stderr: '' };
    return { code: 0, stdout: '{"result":{}}', stderr: '' };
  };
}

test('S1: dontAsk is refused before herdr is invoked', async (t) => {
  const f = fixture(t);
  const result = await runSession(['spawn', '--name', 'x', '--model', 'claude-opus-5', '--effort', 'high', '--log', f.log, '--', '--permission-mode', 'dontAsk'], { exec: f.exec, env: env() });
  assert.equal(result.exit, 2);
  assert.equal(f.calls.length, 0);
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
});

test('S3: successor-not-ready never retires', async (t) => {
  const f = fixture(t); const file = handoff(f); let now = 0;
  f.handler = successHerdr({ successorSession: null });
  const failed = await runSession(['chain', '--handoff', file, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--successor-timeout', '1', '--log', f.log], { exec: f.exec, env: env(), now: () => (now += 16_000), sleep: async () => {} });
  assert.equal(failed.exit, 4); assert.equal(row(f).outcome, 'successor-not-ready');
  assert.equal(f.calls.some((call) => call.args.includes('/exit')), false);
  const positive = fixture(t); const positiveFile = handoff(positive); positive.handler = successHerdr();
  await runSession(['chain', '--handoff', positiveFile, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--log', positive.log], { exec: positive.exec, env: env() });
  assert.equal(positive.calls.some((call) => call.args.includes('/exit')), true, 'positive chain proves the negative control can observe retirement');
});

test('S4: a live agent blocks close', async (t) => {
  const f = fixture(t); let now = 0;
  writeFileSync(`${f.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old', sessionId: '44444444-4444-4444-8444-444444444444' } }, chains: [] }), 'utf8');
  f.handler = (_program, args) => {
    if (`${args[0]} ${args[1]}` === 'agent wait') return { code: 0, stdout: '{"result":{"state":"done"}}', stderr: '' };
    if (`${args[0]} ${args[1]}` === 'pane read') return { code: 0, stdout: '', stderr: '' };
    if (`${args[0]} ${args[1]}` === 'pane process-info') return { code: 0, stdout: 'claude.exe', stderr: '' };
    return { code: 0, stdout: '{"result":{}}', stderr: '' };
  };
  const blocked = await runSession(['retire', 'old', '--mode', 'close', '--timeout', '1', '--log', f.log], { exec: f.exec, now: () => (now += 2), sleep: async () => {} });
  assert.equal(blocked.exit, 3); assert.equal(callsFor(f, 'pane').some((call) => call.args[1] === 'close'), false);
  const positive = fixture(t); writeFileSync(`${positive.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); positive.handler = successHerdr();
  await runSession(['retire', 'old', '--mode', 'close', '--log', positive.log], { exec: positive.exec });
  assert.equal(callsFor(positive, 'pane').some((call) => call.args[1] === 'close'), true, 'positive close proves the negative control can observe closure');
});

test('S5: gone has two shapes', async (t) => {
  const done = fixture(t); done.handler = successHerdr();
  assert.equal((await runSession(['watch', 'old', '--until', 'gone', '--timeout', '1', '--log', done.log], { exec: done.exec })).exit, 0);
  const missing = fixture(t); missing.handler = () => ({ code: 1, stdout: '', stderr: 'agent_not_found' });
  assert.equal((await runSession(['watch', 'old', '--until', 'gone', '--timeout', '1', '--log', missing.log], { exec: missing.exec })).exit, 0);
});

test('S6: resume id is parsed, never invented', async (t) => {
  const withBanner = fixture(t); writeFileSync(`${withBanner.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); withBanner.handler = successHerdr();
  const parsed = await runSession(['retire', 'old', '--mode', 'close', '--log', withBanner.log], { exec: withBanner.exec });
  assert.equal(parsed.output.resumeId, '33333333-3333-4333-8333-333333333333');
  const absent = fixture(t); writeFileSync(`${absent.log}.state.json`, JSON.stringify({ sessions: { old: { name: 'old', pane: 'pane:old' } }, chains: [] }), 'utf8'); absent.handler = (_program, args) => `${args[0]} ${args[1]}` === 'pane read' ? { code: 0, stdout: 'banner absent', stderr: '' } : successHerdr()(_program, args);
  const clean = await runSession(['retire', 'old', '--mode', 'close', '--log', absent.log], { exec: absent.exec });
  assert.equal(clean.exit, 0); assert.equal(clean.output.resumeId, null);
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
  const f = fixture(t); const file = handoff(f); f.handler = successHerdr();
  const result = await runSession(['chain', '--handoff', file, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--log', f.log], { exec: f.exec, env: env() });
  assert.equal(result.exit, 0);
  const labels = f.calls.map((call) => `${call.args[0]} ${call.args[1]}`);
  for (const label of ['pane split', 'agent start', 'agent get', 'pane process-info', 'agent prompt']) assert.ok(labels.includes(label));
  assert.ok(f.calls.findIndex((call) => call.args[0] === 'agent' && call.args[1] === 'prompt' && !call.args.includes('/exit')) < f.calls.findIndex((call) => call.args.includes('/exit')));
  for (const key of ['chainId', 'callerPane', 'callerSession', 'callerContext', 'callerModel', 'successorPane', 'successorSession', 'successorModel', 'modelChanged', 'handoff', 'ts']) assert.notEqual(result.output[key], undefined);
});

test('S9: a model change is flagged', async (t) => {
  const changed = fixture(t); const changedFile = handoff(changed); changed.handler = successHerdr({ callerModel: 'claude-fable-5-1' });
  const yes = await runSession(['chain', '--handoff', changedFile, '--name', 'new', '--model', 'claude-opus-5', '--effort', 'high', '--no-retire', '--log', changed.log], { exec: changed.exec, env: env() });
  assert.equal(yes.output.modelChanged, true); assert.match(yes.output.warning, /model changed/);
  const same = fixture(t); const sameFile = handoff(same); same.handler = successHerdr({ callerModel: 'claude-fable-5-1', successorModel: 'claude-fable-5-1' });
  const no = await runSession(['chain', '--handoff', sameFile, '--name', 'new', '--model', 'claude-fable-5-1', '--effort', 'high', '--no-retire', '--log', same.log], { exec: same.exec, env: env() });
  assert.equal(no.output.modelChanged, false);
});

test('S10: the Stop capture is marker-gated', (t) => {
  const f = fixture(t); const root = join(f.dir, 'capture'); const id = '55555555-5555-4555-8555-555555555555'; const marker = join(root, 'final-pending', id);
  mkdirSync(join(root, 'final-pending'), { recursive: true });
  writeFileSync(marker, 'pending\n', { encoding: 'utf8', flag: 'w' });
  const captured = runStopCapture({ session_id: id, last_assistant_message: 'final words' }, { env: { WORKIT_SESSION_CHAIN_DIR: root } });
  assert.equal(captured.captured, true); assert.equal(readFileSync(join(root, 'final', `${id}.md`), 'utf8'), 'final words'); assert.equal(existsSync(marker), false);
  const other = runStopCapture({ session_id: '66666666-6666-4666-8666-666666666666', last_assistant_message: 'must not write' }, { env: { WORKIT_SESSION_CHAIN_DIR: root } });
  assert.equal(other.captured, false); assert.equal(existsSync(join(root, 'final', '66666666-6666-4666-8666-666666666666.md')), false);
});
