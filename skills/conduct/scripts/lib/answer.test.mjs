import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ANSWER_ENV, LOOKUP_TIMEOUT_MS, answerArgv, awaitAnswer, parseAnswerCommand, parseAnswerOutput } from './answer.mjs';
import { execute } from './exec.mjs';
import { handBackAction, recordTouch, touchAction } from './touch.mjs';
import { detectAdapters } from './adapters.mjs';

const QUEST = '93427349-0000-4000-8000-000000000001';
const TAG = '[conduct fixture-run touch 1] (run 0a1b2c3d/1)';
const answered = (patch = {}) => ({ id: 'r-1', outcome: 'answered', question: `${TAG} DO: approve`, answer: { key: 'a', text: null, by: 'operator:dogan', answeredAt: '2026-10-05T00:00:00Z' }, ...patch });

function makeState(patch = {}) {
  return {
    slug: 'fixture-run', runId: '0a1b2c3d', runDir: join(tmpdir(), 'run'), pluginRoot: join(tmpdir(), 'plugin'),
    intent: { anchor: QUEST },
    adapters: { spine: { on: true }, answer: { on: true } },
    touches: [{ n: 1, kind: 'preapproval', status: 'filed', tag: '[conduct fixture-run touch 1]', question: '[conduct fixture-run touch 1] DO: approve',
      options: [{ key: 'a', label: 'A', consequence: 'x' }, { key: 'd', label: 'D', consequence: 'y' }], allowFreeText: true, filings: 1, waiting: false }],
    ...patch,
  };
}

test('answerArgv substitutes {quest} and {tag}, appends both when neither appears, and passes a bare path the two as arguments', () => {
  assert.deepEqual(answerArgv(JSON.stringify(['psql', '-c', "where q = '{quest}' and starts_with(x, '{tag}')"]), QUEST, TAG),
    ['psql', '-c', `where q = '${QUEST}' and starts_with(x, '${TAG}')`]);
  assert.deepEqual(answerArgv('["node","r.mjs"]', QUEST, TAG), ['node', 'r.mjs', QUEST, TAG]);
  assert.deepEqual(answerArgv('C:/tools/resolve.exe', QUEST, TAG), ['C:/tools/resolve.exe', QUEST, TAG]);
});

test('answerArgv refuses an unusable command, a short anchor, and a tag outside the conduct shape (exit 2)', () => {
  for (const spec of [undefined, '', '[]', '["ok", ""]', '[1]', '[not json']) {
    assert.throws(() => answerArgv(spec, QUEST, TAG), (error) => error.code === 2, String(spec));
  }
  assert.throws(() => answerArgv('["r"]', '93427349', TAG), /not a full quest uuid/);
  assert.throws(() => answerArgv('["r"]', QUEST, "[conduct x touch 1] (run 0a/1)'; drop table quests; --"), /not a conduct tag/);
  assert.equal(parseAnswerCommand(undefined).problem, `${ANSWER_ENV} is not set`);
});

test('parseAnswerOutput: only an answered receipt to this tag is an answer; nothing or null is none; non-JSON is a failure', () => {
  assert.deepEqual(parseAnswerOutput(`${JSON.stringify(answered())}\n`, TAG), answered());
  for (const stdout of ['', '  \n', 'null', 'null\n']) assert.equal(parseAnswerOutput(stdout, TAG), null, JSON.stringify(stdout));
  assert.equal(parseAnswerOutput(JSON.stringify(answered({ outcome: 'needs_input' })), TAG), null);
  assert.equal(parseAnswerOutput(JSON.stringify(answered({ question: '[conduct fixture-run touch 1] (run 0a1b2c3d/2) a later filing' })), TAG), null);
  assert.equal(parseAnswerOutput(JSON.stringify(answered({ answer: null })), TAG), null);
  assert.deepEqual(parseAnswerOutput(JSON.stringify(answered(), null, 2), TAG), answered(), 'a pretty-printed receipt is one object');
  assert.throws(() => parseAnswerOutput('ERROR: relation does not exist', TAG), (error) => error.code === 1);
  assert.throws(() => parseAnswerOutput('[1,2]', TAG), (error) => error.code === 1);
});

test('detectAdapters probes answer from WORKIT_TOUCH_ANSWER_CMD: off unset or unparseable, on when its program resolves', () => {
  const exec = (program, args) => (program === 'where' || program === 'sh' ? { code: args.includes('docker') || args.at(-1) === 'docker' ? 0 : 1, stdout: 'C:/bin/docker.exe' } : { code: 0, stdout: '1.0' });
  const probe = (env) => detectAdapters({ env, exec, platform: 'win32', resolveCodex: () => 'codex' }).adapters.answer;
  assert.deepEqual([probe({}).on, probe({}).detail], [false, `${ANSWER_ENV} is not set`]);
  assert.equal(probe({ [ANSWER_ENV]: '[1]' }).on, false);
  assert.equal(probe({ [ANSWER_ENV]: '["docker","exec","db","psql"]' }).on, true);
  assert.equal(probe({ [ANSWER_ENV]: '["nowhere-tool"]' }).on, false);
});

// A run dir on disk holding state.json, for the verb.
function runDir(t, state) {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-answer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 1, ...state, runDir: dir }));
  return dir;
}

function verbDeps(outputs, { now = 0 } = {}) {
  const calls = [];
  const timeouts = [];
  let clock = now;
  return {
    calls, timeouts,
    deps: {
      exists: existsSync, read: (path) => readFileSync(path, 'utf8'),
      env: { [ANSWER_ENV]: JSON.stringify(['resolve', '{quest}', '{tag}']) },
      exec: (program, args, options = {}) => {
        calls.push([program, ...args]);
        timeouts.push(options.timeout);
        const next = outputs.length > 1 ? outputs.shift() : outputs[0];
        return typeof next === 'function' ? next() : next;
      },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  };
}

test('await-answer --once is the lookup: exit 0 either way, the receipt when it is there, the tag and quest passed to the command', async (t) => {
  const dir = runDir(t, makeState());
  const hit = verbDeps([{ code: 0, stdout: JSON.stringify(answered()) }]);
  const found = await awaitAnswer({ run: dir, touch: '1', once: true }, hit.deps);
  assert.deepEqual([found.code, found.out.answered, found.out.receipt.id], [undefined, true, 'r-1']);
  assert.deepEqual(hit.calls, [['resolve', QUEST, TAG]]);
  const miss = await awaitAnswer({ run: dir, touch: '1', once: true }, verbDeps([{ code: 0, stdout: 'null' }]).deps);
  assert.deepEqual([miss.code, miss.out.answered, miss.out.receipt], [undefined, false, null]);
  await assert.rejects(awaitAnswer({ run: dir, touch: '1', once: true }, verbDeps([{ code: 3, stdout: '', stderr: 'docker: not running' }]).deps), (error) => error.code === 1);
});

test('await-answer polls until the answer lands (exit 0), stops at the timeout (exit 4), and gives up after three failed lookups in a row (exit 1)', async (t) => {
  const dir = runDir(t, makeState());
  const late = verbDeps([{ code: 0, stdout: '' }, { code: 0, stdout: 'null' }, { code: 1, stderr: 'blip' }, { code: 0, stdout: JSON.stringify(answered()) }]);
  const landed = await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '1000' }, late.deps);
  assert.deepEqual([landed.code, landed.out.answered, late.calls.length], [undefined, true, 4]);
  const never = verbDeps([{ code: 0, stdout: 'null' }]);
  const timedOut = await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '1000', 'timeout-ms': '3500' }, never.deps);
  assert.deepEqual([timedOut.code, timedOut.out.timeout, never.calls.length], [4, true, 4]);
  const broken = verbDeps([{ code: 1, stderr: 'down' }]);
  await assert.rejects(awaitAnswer({ run: dir, touch: '1', 'interval-ms': '1000' }, broken.deps), (error) => error.code === 1);
  assert.equal(broken.calls.length, 3);
});

test('every lookup is bounded: 30 s at most, never past the waiter deadline, and the real executor kills a child that outlives it', { timeout: 20000 }, async (t) => {
  const dir = runDir(t, makeState());
  const once = verbDeps([{ code: 0, stdout: 'null' }]);
  await awaitAnswer({ run: dir, touch: '1', once: true }, once.deps);
  assert.deepEqual(once.timeouts, [LOOKUP_TIMEOUT_MS]);
  const near = verbDeps([{ code: 0, stdout: 'null' }]);
  await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '2000', 'timeout-ms': '5000' }, near.deps);
  assert.ok(near.timeouts.every((ms) => ms >= 1000 && ms <= 5000), JSON.stringify(near.timeouts));
  const started = Date.now();
  const killed = execute(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 500 });
  assert.notEqual(killed.code, 0);
  assert.ok(Date.now() - started < 10000, `the hung child ran ${Date.now() - started} ms`);
});

test('await-answer refuses a touch that is not filed and reports one already answered without a lookup', async (t) => {
  const open = makeState();
  open.touches[0].status = 'open';
  await assert.rejects(awaitAnswer({ run: runDir(t, open), touch: '1', once: true }, verbDeps([]).deps), (error) => error.code === 5);
  await assert.rejects(awaitAnswer({ run: runDir(t, makeState()), touch: '2', once: true }, verbDeps([]).deps), (error) => error.code === 2);
  const done = makeState();
  done.touches[0].status = 'answered';
  const quiet = verbDeps([]);
  assert.equal((await awaitAnswer({ run: runDir(t, done), touch: '1' }, quiet.deps)).out.answered, true);
  assert.equal(quiet.calls.length, 0);
});

test('with the answer adapter the read-back is the --once lookup and the hand-back carries a background waiter; without it, neither', () => {
  const state = makeState();
  const readBack = touchAction(state, state.touches[0]);
  assert.equal(readBack.kind, 'shell');
  assert.deepEqual(readBack.command.slice(2), ['await-answer', '--run', state.runDir, '--touch', '1', '--once']);
  const back = handBackAction(state, state.touches[0]);
  assert.deepEqual([back.handBack, back.waiter.background, back.waiter.command.slice(2)], [true, true, ['await-answer', '--run', state.runDir, '--touch', '1']]);
  assert.match(back.instruction, /in the background/);
  const off = makeState({ adapters: { spine: { on: true }, answer: { on: false } } });
  assert.equal(touchAction(off, off.touches[0]).tool, 'spine_quest');
  assert.equal(handBackAction(off, off.touches[0]).waiter, undefined);
});

test('the read-back takes the answer from the lookup even when a later receipt is the latest on the anchor', () => {
  const state = makeState();
  const touch = state.touches[0];
  const action = touchAction(state, touch);
  recordTouch(state, touch, action, { code: 0, stdout: JSON.stringify({ ok: true, answered: true, receipt: answered() }), stderr: '' });
  assert.deepEqual([touch.status, touch.answer.key, touch.answer.receiptId], ['answered', 'a', 'r-1']);
  // spine_quest's view of the same anchor: a later completed receipt is the latest, so the answer is hidden there.
  const viaSpine = makeState({ adapters: { spine: { on: true }, answer: { on: false } } });
  const hidden = viaSpine.touches[0];
  recordTouch(viaSpine, hidden, touchAction(viaSpine, hidden), { quests: [{ latestReceipt: { id: 'r-2', outcome: 'completed', question: null, answer: null } }] });
  assert.deepEqual([hidden.status, hidden.waiting], ['filed', true]);
});

test('a failed or unanswered lookup is not an answer: the first is refused (the read-back stays pending), the second waits', () => {
  const state = makeState();
  const touch = state.touches[0];
  const action = touchAction(state, touch);
  assert.throws(() => recordTouch(state, touch, action, { code: 1, stdout: JSON.stringify({ ok: false, error: 'WORKIT_TOUCH_ANSWER_CMD exited 1' }), stderr: '' }), (error) => error.code === 1);
  assert.equal(touch.status, 'filed');
  recordTouch(state, touch, action, { code: 0, stdout: JSON.stringify({ ok: true, answered: false, receipt: null }), stderr: '' });
  assert.deepEqual([touch.status, touch.waiting], ['filed', true]);
  const notOperator = makeState();
  recordTouch(notOperator, notOperator.touches[0], action, { code: 0, stdout: JSON.stringify({ ok: true, answered: true, receipt: answered({ answer: { key: 'a', by: 'agent:claude' } }) }), stderr: '' });
  assert.equal(notOperator.touches[0].status, 'open');
});
