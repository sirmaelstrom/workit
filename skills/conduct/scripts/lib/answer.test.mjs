import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ANSWER_ENV, LOOKUP_TIMEOUT_MS, answerArgv, awaitAnswer, parseAnswerCommand, parseAnswerOutput } from './answer.mjs';
import { execute } from './exec.mjs';
import { correlation, handBackAction, recordTouch, touchAction } from './touch.mjs';
import { detectAdapters } from './adapters.mjs';
import { testDeps } from '../test-deps.mjs';
import { anchorFromFile, readAnchor, verifyAnswerProof, verifyRecord } from '../../../_shared/operator-proof/operator-proof.mjs';
import { TEST_KEY_1, TEST_KEY_2, credentialIdOf, makeTestAnchor, signAnswer } from '../../../_shared/operator-proof/test-signer.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'intake');

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
  assert.ok(near.timeouts.every((ms) => ms >= 1 && ms <= 5000), JSON.stringify(near.timeouts));
  // Less than a second left: the lookup gets only what is left, never past the deadline.
  const tight = verbDeps([{ code: 0, stdout: 'null' }]);
  await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '50', 'timeout-ms': '200' }, tight.deps);
  assert.ok(tight.timeouts.length > 0 && tight.timeouts.every((ms) => ms >= 1 && ms <= 200), JSON.stringify(tight.timeouts));
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

test('a T3 operator answer resumes the filed touch through the Spine read-back', () => {
  const state = makeState();
  const touch = state.touches[0];
  const action = touchAction(state, touch);
  const receipt = answered({ answer: { key: 'a', text: 'Approve', by: 'operator:t3', answeredAt: '2026-10-17T00:00:00Z' } });
  recordTouch(state, touch, action, { code: 0, stdout: JSON.stringify({ ok: true, answered: true, receipt }), stderr: '' });
  assert.deepEqual([touch.status, touch.answer.key, touch.answer.by], ['answered', 'a', 'operator:t3']);

  const viaSpine = makeState({ adapters: { spine: { on: true }, answer: { on: false } } });
  const spineTouch = viaSpine.touches[0];
  recordTouch(viaSpine, spineTouch, touchAction(viaSpine, spineTouch), { quests: [{ latestReceipt: receipt }] });
  assert.deepEqual([spineTouch.status, spineTouch.answer.key, spineTouch.answer.by], ['answered', 'a', 'operator:t3']);
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

// ---- the operator's passkey proof on the read-back ----

const ASK_ID = '00000000-0000-4000-8000-0000000000a1';
const ANCHOR_FILE = makeTestAnchor();
const CONFIGURED = testDeps({ readAnchor: () => anchorFromFile(ANCHOR_FILE) });
const viaAdapter = (receipt) => ({ code: 0, stdout: JSON.stringify({ ok: true, answered: true, receipt }), stderr: '' });
const viaSpine = (receipt) => ({ quests: [{ latestReceipt: receipt }] });
// [name, answer adapter on, the read-back result carrying a receipt]
const TRANSPORTS = [['the answer adapter', true, viaAdapter], ['spine_quest', false, viaSpine]];

// A touch filed on QUEST as ask receipt ASK_ID, read back over one transport.
function filedState(answerOn, patch = {}) {
  const state = makeState({ adapters: { spine: { on: true }, answer: { on: answerOn } }, ...patch });
  state.touches[0].receiptId = ASK_ID;
  return state;
}

// The answered receipt to this filing as the Spine stores it: the filed question
// and ask, and a proof minted over them now (proof: null leaves it unsigned).
function signedReceipt(state, { key = 'a', text = null, by = 'operator:dogan', signKey = TEST_KEY_1, askReceiptId = ASK_ID, question, proof } = {}) {
  const touch = state.touches[0];
  const ask = { options: touch.options, allowFreeText: touch.allowFreeText };
  const asked = question ?? `${correlation(state, touch)} DO: approve`;
  const answer = { key, text, by, answeredAt: '2026-10-17T00:00:00Z', askReceiptId };
  if (proof !== null) answer.proof = proof ?? signAnswer({ key: signKey, questId: state.intent.anchor, askReceiptId, question: asked, ask, answerKey: key, text });
  return { id: 'r-1', outcome: 'answered', question: asked, ask, answer };
}

// Probe 3 (quest 11c2d46a): a loopback POST wrote an operator-stamped answer
// with no proof, and conduct accepted it. With an anchor it must not.
test('red test 2: with a passkey configured, the unsigned fixture answer is refused proof_absent on both transports, and an unsigned T3 answer waits for the phone', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'spine-quest-answered.json'), 'utf8'));
  const unsigned = fixture.quests[0].latestReceipt;
  const fixtureState = (answerOn) => filedState(answerOn, { runId: 'abcd1234', intent: { anchor: fixture.quests[0].id } });
  for (const [name, answerOn, wrap] of TRANSPORTS) {
    const state = fixtureState(answerOn);
    const touch = state.touches[0];
    const outcome = recordTouch(state, touch, touchAction(state, touch), wrap(unsigned), CONFIGURED);
    assert.deepEqual([touch.status, touch.refusal, outcome?.refused, touch.answer ?? null], ['open', 'proof proof_absent', 'proof proof_absent', null], name);

    const t3 = fixtureState(answerOn);
    const waiting = t3.touches[0];
    recordTouch(t3, waiting, touchAction(t3, waiting), wrap({ ...unsigned, answer: { ...unsigned.answer, by: 'operator:t3' } }), CONFIGURED);
    assert.deepEqual([waiting.status, waiting.waiting, waiting.awaiting, waiting.filings, waiting.answer ?? null], ['filed', true, 'phone-confirmation', 1, null], name);
  }
});

test('a signed answer is accepted on both transports: proofMode verified, the raw signed block stored, and verify-record re-verifies the touch record', () => {
  const anchor = anchorFromFile(ANCHOR_FILE);
  for (const [name, answerOn, wrap] of TRANSPORTS) {
    const state = filedState(answerOn);
    const touch = state.touches[0];
    const receipt = signedReceipt(state);
    assert.equal(recordTouch(state, touch, touchAction(state, touch), wrap(receipt), CONFIGURED), undefined, name);
    const { answer } = touch;
    assert.deepEqual([touch.status, answer.key, answer.by, answer.proofMode, answer.credentialId, answer.anchorSha256, answer.epoch, answer.askReceiptId, answer.receiptId],
      ['answered', 'a', 'operator:dogan', 'verified', credentialIdOf(TEST_KEY_1), anchor.sha256, 0, ASK_ID, 'r-1'], name);
    assert.deepEqual(answer.proof, receipt.answer.proof, name);
    assert.deepEqual(answer.signed, { answer: receipt.answer, question: receipt.question, ask: receipt.ask }, name);
    const record = JSON.parse(JSON.stringify(touch));
    assert.deepEqual([verifyRecord({ record, quest: QUEST, anchor }).mode, verifyRecord({ record, quest: QUEST, anchor }).ok], ['verified', true], name);
  }
});

test('a keyless free-text signed answer is accepted as option (c); the signed block keeps the signed null key and still re-verifies', () => {
  const anchor = anchorFromFile(ANCHOR_FILE);
  for (const [name, answerOn, wrap] of TRANSPORTS) {
    const state = filedState(answerOn);
    const touch = state.touches[0];
    touch.options = [{ key: 'a', label: 'A', consequence: 'x' }, { key: 'c', label: 'Something else', consequence: 'z' }];
    const receipt = signedReceipt(state, { key: null, text: 'ship the docs only' });
    recordTouch(state, touch, touchAction(state, touch), wrap(receipt), CONFIGURED);
    assert.deepEqual([touch.status, touch.answer.key, touch.answer.text, touch.answer.proofMode, touch.answer.signed.answer.key], ['answered', 'c', 'ship the docs only', 'verified', null], name);
    assert.equal(verifyRecord({ record: JSON.parse(JSON.stringify(touch)), quest: QUEST, anchor }).mode, 'verified', name);
  }
});

test('a proof by a key the anchor does not hold is refused unknown_credential, and the touch is re-filed', () => {
  for (const [name, answerOn, wrap] of TRANSPORTS) {
    const state = filedState(answerOn);
    const touch = state.touches[0];
    const outcome = recordTouch(state, touch, touchAction(state, touch), wrap(signedReceipt(state, { signKey: TEST_KEY_2 })), CONFIGURED);
    assert.deepEqual([touch.status, touch.refusal, outcome?.refused], ['open', 'proof unknown_credential', 'proof unknown_credential'], name);
  }
});

test('ask-swap control (council C2): a valid proof over another ask with the same correlation prefix, its answer.askReceiptId removed, is refused statement_mismatch', () => {
  const anchor = anchorFromFile(ANCHOR_FILE);
  for (const [name, answerOn, wrap] of TRANSPORTS) {
    const state = filedState(answerOn);
    const touch = state.touches[0];
    const swapped = signedReceipt(state, { askReceiptId: '00000000-0000-4000-8000-0000000000b2', question: `${correlation(state, touch)} DO: a different ask` });
    delete swapped.answer.askReceiptId;
    // The control: the proof is valid for its own ask, absent an expected ask id.
    assert.equal(verifyAnswerProof({ ...swapped, questId: QUEST, anchor }).mode, 'verified', name);
    const outcome = recordTouch(state, touch, touchAction(state, touch), wrap(swapped), CONFIGURED);
    assert.deepEqual([touch.status, outcome?.refused], ['open', 'proof statement_mismatch'], name);
  }
});

test('an unsigned T3 answer waits for the phone: no re-file, a confirm-on-phone hand-back, and the waiter polls on until a signed answer supersedes it', async (t) => {
  const state = filedState(true);
  const touch = state.touches[0];
  const unsigned = signedReceipt(state, { by: 'operator:t3', proof: null });
  assert.equal(recordTouch(state, touch, touchAction(state, touch), viaAdapter(unsigned), CONFIGURED), undefined);
  assert.deepEqual([touch.status, touch.waiting, touch.awaiting, touch.filings, touch.refusal ?? null], ['filed', true, 'phone-confirmation', 1, null]);
  const back = handBackAction(state, touch);
  assert.match(back.instruction, /answered in T3; confirm it on the phone \(Dogan → Confirm on phone\)/);
  assert.doesNotMatch(back.instruction, /no operator-attributed answer yet/);

  const dir = runDir(t, state);
  const signed = signedReceipt(state);
  const polls = verbDeps([{ code: 0, stdout: JSON.stringify(unsigned) }, { code: 0, stdout: JSON.stringify(unsigned) }, { code: 0, stdout: JSON.stringify(signed) }]);
  const landed = await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '1000' }, testDeps({ ...polls.deps, readAnchor: CONFIGURED.readAnchor }));
  assert.deepEqual([landed.out.answered, landed.out.receipt.answer.by, polls.calls.length], [true, 'operator:dogan', 3]);
  const stuck = verbDeps([{ code: 0, stdout: JSON.stringify(unsigned) }]);
  const timedOut = await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '1000', 'timeout-ms': '3500' }, testDeps({ ...stuck.deps, readAnchor: CONFIGURED.readAnchor }));
  assert.deepEqual([timedOut.code, timedOut.out.timeout], [4, true]);
  // --once is the read-back itself: it returns the unsigned answer, so the read-back can hand back to the phone.
  const once = await awaitAnswer({ run: dir, touch: '1', once: true }, testDeps({ ...verbDeps([{ code: 0, stdout: JSON.stringify(unsigned) }]).deps, readAnchor: CONFIGURED.readAnchor }));
  assert.equal(once.out.receipt.answer.by, 'operator:t3');
  // With no anchor the unsigned T3 answer ends the wait, as before.
  const plain = verbDeps([{ code: 0, stdout: JSON.stringify(unsigned) }]);
  assert.equal((await awaitAnswer({ run: dir, touch: '1', 'interval-ms': '1000' }, testDeps(plain.deps))).out.answered, true);
});

test('with a passkey configured, an adapter row without the ask stops the run (exit 2) with no re-file and no waiter', () => {
  const state = filedState(true);
  const touch = state.touches[0];
  const row = signedReceipt(state);
  delete row.ask;
  assert.throws(() => recordTouch(state, touch, touchAction(state, touch), viaAdapter(row), CONFIGURED),
    (error) => error.code === 2 && error.message.includes('the answer adapter must select the ask column (see conduct/SKILL.md)'));
  assert.deepEqual([touch.status, touch.waiting, touch.filings, touch.refusal ?? null], ['filed', false, 1, null]);
});

test('an unreadable anchor stops the read-back and the waiter at once (exit 2); it never reads as unconfigured', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'conduct-anchor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'operator-passkeys.json');
  writeFileSync(path, '{"v":1,');
  const broken = testDeps({ readAnchor: () => readAnchor(path) });
  const message = 'operator passkey anchor is unreadable: fix ~/.claude/operator-passkeys.json';
  const state = filedState(true);
  const touch = state.touches[0];
  assert.throws(() => recordTouch(state, touch, touchAction(state, touch), viaAdapter(signedReceipt(state)), broken), (error) => error.code === 2 && error.message === message);
  assert.deepEqual([touch.status, touch.answer ?? null], ['filed', null]);
  const polls = verbDeps([{ code: 0, stdout: 'null' }]);
  await assert.rejects(awaitAnswer({ run: runDir(t, state), touch: '1', 'interval-ms': '1000' }, testDeps({ ...polls.deps, readAnchor: broken.readAnchor })),
    (error) => error.code === 2 && error.message === message);
  assert.ok(polls.calls.length <= 1, `no retry loop: ${polls.calls.length} lookups`);
});
