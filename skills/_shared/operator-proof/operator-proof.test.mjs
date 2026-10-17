// operator-proof.test.mjs: runs every shared vector, pins the module by its
// normalised hash, and drives the CLI under a temp home so that no result ever
// depends on the real ~/.claude/operator-passkeys.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GRANT_TTL_DAYS, OperatorProofError, REASONS, anchorFromFile, anchorPath, answerStatement, askSha256, canonical,
  challengeFor, checkGrant, checkRaise, grantTag, grantTagFor, questionSha256, raiseTag, readAnchor,
  registerBeginStatement, registerCosignStatement, renderGrant, renderRaise, verifyAnswerProof, verifyCosign,
  verifyReceiptBody, verifyRecord, verifyRegistration,
} from './operator-proof.mjs';
import { TEST_KEY_1, TEST_KEY_2, makeTestAnchor, signAnswer } from './test-signer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'operator-proof.mjs');
const PIN = join(HERE, 'operator-proof.sha256');
const MAKE_VECTORS = join(HERE, 'make-vectors.mjs');
const VECTORS_FILE = join(HERE, 'operator-proof.vectors.json');
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const byName = (name) => VECTORS.find((vector) => vector.name === name);

const BUILDERS = { answerStatement, registerBeginStatement, registerCosignStatement };
const HASHES = { askSha256, questionSha256 };
const tmpHome = () => mkdtempSync(join(tmpdir(), 'operator-proof-'));

function writeAnchorFile(home, text) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'operator-passkeys.json'), text);
}

function run(vector) {
  const { input } = vector;
  switch (vector.kind) {
    case 'answer':
      return verifyAnswerProof({
        answer: input.answer, question: input.question, ask: input.ask, questId: input.questId,
        askReceiptId: input.askReceiptId, anchor: anchorFromFile(input.anchorFile),
      });
    case 'registration':
      return verifyRegistration(input);
    case 'cosign':
      return verifyCosign({ anchor: anchorFromFile(input.anchorFile), cosign: input.cosign, expect: input.expect, now: input.now });
    case 'canonical':
      return { statement: BUILDERS[input.builder](input.args) };
    case 'hash':
      return { hash: HASHES[input.fn](input.value) };
    case 'grant':
      return {
        canonical: canonical(input.grant), tag: grantTag(input.grant), rendered: renderGrant(input.grant),
        consequence: `${renderGrant(input.grant)} [grant ${grantTag(input.grant)}]`,
      };
    case 'raise':
      return {
        canonical: canonical(input.raise), tag: raiseTag(input.raise), rendered: renderRaise(input.raise),
        consequence: `${renderRaise(input.raise)} [raise ${raiseTag(input.raise)}]`,
      };
    case 'grant-check': {
      const ok = checkGrant(input.grant, input.ask, input.key);
      return { ok, reason: ok ? null : REASONS.grant_tag_mismatch };
    }
    case 'raise-check': {
      const ok = checkRaise(input.raise, input.ask, input.key);
      return { ok, reason: ok ? null : REASONS.raise_tag_mismatch };
    }
    case 'anchor': {
      const home = tmpHome();
      writeAnchorFile(home, input.text);
      try {
        return readAnchor(join(home, '.claude', 'operator-passkeys.json'));
      } catch (err) {
        return { throws: err.code };
      }
    }
    case 'receipt':
      return verifyReceiptBody({
        body: input.body, quest: input.quest, state: input.state, goalText: input.goalText,
        anchor: anchorFromFile(input.anchorFile), now: input.now,
      });
    case 'record':
      return verifyRecord({ record: input.record, quest: input.quest, goalText: input.goalText, anchor: anchorFromFile(input.anchorFile), now: input.now });
    default:
      throw new Error(`no runner for vector kind ${vector.kind}`);
  }
}

for (const vector of VECTORS) {
  test(`vector ${vector.name}`, () => {
    const result = run(vector);
    for (const [field, want] of Object.entries(vector.expect)) {
      assert.deepEqual(result[field], want, `${vector.name}: ${field}`);
    }
  });
}

test('the vectors are well formed and cover every reason code', () => {
  const names = VECTORS.map((vector) => vector.name);
  assert.equal(new Set(names).size, names.length, 'vector names are unique');
  for (const vector of VECTORS) {
    assert.deepEqual(Object.keys(vector).sort(), ['expect', 'input', 'kind', 'name'], vector.name);
    // A valid verifier vector cannot pass vacuously as unconfigured.
    if (['answer', 'registration', 'cosign'].includes(vector.kind) && vector.expect.ok === true) {
      assert.ok(['verified', 'unconfigured'].includes(vector.expect.mode), `${vector.name} names its mode`);
    }
  }
  const covered = new Set(VECTORS.flatMap((vector) => [vector.expect.reason, vector.expect.throws]));
  const missing = Object.values(REASONS).filter((code) => !covered.has(code));
  assert.deepEqual(missing, [], 'every reason code has a vector');
  for (const kind of ['answer', 'registration', 'cosign']) {
    assert.ok(VECTORS.some((vector) => vector.kind === kind && vector.expect.mode === 'verified'), `a valid ${kind} vector`);
  }
});

test('the Chrome-captured vectors are present, on a localhost origin, and verify', () => {
  for (const [name, kind] of [['chrome-registration', 'registration'], ['chrome-answer', 'answer']]) {
    const vector = byName(name);
    assert.ok(vector, `${name} is in the vectors`);
    assert.equal(vector.kind, kind);
    const origin = kind === 'answer' ? vector.input.anchorFile.credentials[0].origin : vector.input.expectedOrigin;
    assert.match(origin, /^http:\/\/localhost:\d+$/);
    assert.equal(run(vector).mode, 'verified');
  }
});

test('the pin is the hash of the module text after CRLF -> LF', () => {
  const pinOf = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const text = readFileSync(MODULE, 'utf8');
  const pin = readFileSync(PIN, 'utf8').trim();
  assert.match(pin, /^[0-9a-f]{64}$/);
  assert.equal(pinOf(text), pin);
  assert.equal(pinOf(text.replace(/\r?\n/g, '\r\n')), pin, 'a CRLF copy hashes equal');
  const changed = text.replace('operator-proof', 'operator-pr00f');
  assert.notEqual(changed, text);
  assert.notEqual(pinOf(changed), pin, 'a changed byte does not');
});

test('the module reads no environment variable and never touches the test signer', () => {
  const text = readFileSync(MODULE, 'utf8');
  assert.doesNotMatch(text, /process\.env/);
  assert.doesNotMatch(text, /test-signer/);
  for (const key of [TEST_KEY_1, TEST_KEY_2]) {
    assert.ok(!text.includes(key.x) && !text.includes(key.d), 'no test key in the module');
  }
});

test('importing the module under node -e loads it without printing or exiting', () => {
  const href = pathToFileURL(MODULE).href;
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(href)}).then((m) => { if (typeof m.verifyAnswerProof !== 'function') process.exitCode = 3; })`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('constants: GRANT_TTL_DAYS is 14 and REASONS is a frozen code list', () => {
  assert.equal(GRANT_TTL_DAYS, 14);
  assert.ok(Object.isFrozen(REASONS));
  for (const [key, value] of Object.entries(REASONS)) assert.equal(key, value);
  for (const code of ['ask_missing', 'cosign_mismatch', 'proof_stale', 'anchor_unreadable', 'grant_tag_mismatch', 'grant_expired',
    'wrong_run', 'raise_tag_mismatch', 'quest_id_not_full', 'malformed_proof', 'unsupported_version', 'bad_key', 'bad_timestamp',
    'cross_origin', 'alg_unsupported', 'credential_id_mismatch']) assert.equal(REASONS[code], code);
});

test('readAnchor: the fixed path, missing and empty files are unconfigured, bad files throw', () => {
  assert.equal(anchorPath(), join(homedir(), '.claude', 'operator-passkeys.json'));
  const home = tmpHome();
  const path = join(home, '.claude', 'operator-passkeys.json');
  assert.deepEqual(readAnchor(path), { configured: false, epoch: 0 });
  writeAnchorFile(home, JSON.stringify(makeTestAnchor({ keys: [], epoch: 4 })));
  assert.deepEqual(readAnchor(path), { configured: false, epoch: 4 });
  const file = makeTestAnchor();
  writeAnchorFile(home, `﻿${JSON.stringify(file, null, 2)}`);
  const anchor = readAnchor(path);
  assert.equal(anchor.configured, true);
  assert.equal(anchor.sha256, anchorFromFile(file).sha256);
  assert.equal(anchor.sha256, createHash('sha256').update(canonical(file)).digest('hex'));
  writeAnchorFile(home, '{"v":1');
  assert.throws(() => readAnchor(path), (err) => err instanceof OperatorProofError && err.code === 'anchor_unreadable');
  // A directory where the file should be is unreadable, never "not configured".
  const dirHome = tmpHome();
  mkdirSync(join(dirHome, '.claude', 'operator-passkeys.json'), { recursive: true });
  assert.throws(() => readAnchor(join(dirHome, '.claude', 'operator-passkeys.json')), (err) => err.code === 'anchor_unreadable');
});

test('a file-shape anchor passed to a verifier throws TypeError', () => {
  const file = makeTestAnchor();
  const answer = byName('answer-key').input;
  assert.throws(() => verifyAnswerProof({ ...answer, anchor: file }), { name: 'TypeError', message: 'anchor object required' });
  assert.throws(() => verifyCosign({ anchor: file, cosign: null, expect: {} }), { name: 'TypeError', message: 'anchor object required' });
  assert.throws(() => verifyReceiptBody({ body: {}, quest: 'x', anchor: file }), TypeError);
  assert.throws(() => verifyRecord({ record: {}, quest: 'x', anchor: file }), TypeError);
});

const JUNK = [undefined, null, 0, 1.5, NaN, true, '', 'x', [], [1], {}, { options: 'x' }, { options: [null] }, { options: [{ key: 1 }] },
  { options: [{ key: 'a', label: 'A' }] }, { options: [], prompt: 7 }, { options: [], allowFreeText: 'yes' }, Object.create(null)];

test('helpers are total: bad shapes give null or false, never a throw', () => {
  for (const junk of JUNK) {
    if (typeof junk !== 'string') assert.equal(questionSha256(junk), null);
    if (junk !== null) assert.equal(askSha256(junk), null, 'askSha256 of a bad ask');
    assert.equal(answerStatement(junk), null);
    assert.equal(registerBeginStatement(junk), null);
    assert.equal(registerCosignStatement(junk), null);
    assert.equal(renderGrant(junk), null);
    assert.equal(grantTag(junk), null);
    assert.equal(renderRaise(junk), null);
    assert.equal(raiseTag(junk), null);
    assert.equal(grantTagFor(junk, 'a'), null);
    assert.equal(checkGrant(junk, junk, 'a'), false);
    assert.equal(checkRaise(junk, junk), false);
    const grant = byName('grant-check').input;
    assert.equal(checkGrant(grant.grant, junk, 'a'), false);
    assert.equal(checkGrant(grant.grant, grant.ask, junk), false);
  }
  const base = byName('canonical-answer-statement').input.args;
  for (const field of ['origin', 'questId', 'signedAt', 'question', 'ask']) {
    for (const junk of [undefined, 7, {}]) assert.equal(answerStatement({ ...base, [field]: junk }), null, field);
  }
  assert.equal(answerStatement({ ...base, key: 'z' }), null, 'a key with no option');
  assert.equal(answerStatement({ ...base, text: 7 }), null);
  const { grant } = byName('grant-tag').input;
  for (const field of Object.keys(grant)) {
    const { [field]: _dropped, ...partial } = grant;
    assert.equal(grantTag(partial), null, `grant without ${field}`);
  }
  assert.equal(grantTag({ ...grant, extra: 1 }), null, 'a grant with an unknown field');
  assert.equal(grantTagFor(byName('grant-check').input.ask, 'a'), grantTag(grant));
  assert.equal(grantTagFor(byName('grant-check').input.ask, 'd'), null);
});

test('askSha256 hashes the prompt, the free-text flag and the options in key order', () => {
  const ask = { options: [{ key: 'b', label: 'B', consequence: 'bee' }, { key: 'a', label: 'A', consequence: 'ay' }] };
  assert.equal(askSha256(ask), createHash('sha256').update(
    '{"allowFreeText":false,"options":[{"consequence":"ay","key":"a","label":"A"},{"consequence":"bee","key":"b","label":"B"}],"prompt":null}',
  ).digest('hex'));
  assert.equal(askSha256(null), createHash('sha256').update('null').digest('hex'));
  assert.notEqual(askSha256({ ...ask, prompt: 'Why?' }), askSha256(ask));
  assert.notEqual(askSha256({ ...ask, allowFreeText: true }), askSha256(ask));
  assert.equal(askSha256({ ...ask, extra: 'ignored', options: ask.options.map((o) => ({ ...o, extra: 1 })) }), askSha256(ask));
  assert.equal(challengeFor('abc').toString('hex'), createHash('sha256').update('abc').digest('hex'));
});

// Untrusted proofs, answers, registrations and co-signs: every one is refused
// with a stable code and none throws.
test('the verifiers never throw on untrusted input', () => {
  const anchor = anchorFromFile(makeTestAnchor());
  const good = byName('answer-key').input;
  const codes = new Set(Object.values(REASONS));
  const proofs = [...JUNK, { v: 1 }, { ...good.answer.proof, statement: 7 }, { ...good.answer.proof, statement: '[]' },
    { ...good.answer.proof, statement: 'null' }, { ...good.answer.proof, clientDataJSON: Buffer.from('[]').toString('base64url') },
    { ...good.answer.proof, clientDataJSON: Buffer.from('7').toString('base64url') }, { ...good.answer.proof, signature: '' },
    { ...good.answer.proof, signature: 'AAAA' }, { ...good.answer.proof, credentialId: 'not/base64' },
    { ...good.answer.proof, statement: JSON.stringify({ ...JSON.parse(good.answer.proof.statement), origin: 7 }) }];
  for (const proof of proofs) {
    for (const answer of [{ ...good.answer, proof }, proof]) {
      const result = verifyAnswerProof({ ...good, answer, anchor });
      assert.equal(result.ok, false);
      assert.ok(codes.has(result.reason), `reason ${result.reason}`);
    }
  }
  const registration = byName('registration').input;
  for (const field of ['clientDataJSON', 'authenticatorData', 'credentialId', 'publicKeySpki', 'alg', 'label', 'signedAt']) {
    for (const junk of [undefined, null, 7, '', {}]) {
      const result = verifyRegistration({ ...registration, [field]: junk });
      assert.equal(result.ok, false, `${field}=${JSON.stringify(junk)}`);
      assert.ok(codes.has(result.reason));
    }
  }
  const cosign = byName('cosign').input;
  for (const junk of JUNK) {
    const result = verifyCosign({ anchor, cosign: junk, expect: cosign.expect, now: cosign.now });
    assert.equal(result.ok, false);
    assert.ok(codes.has(result.reason));
  }
});

test('unconfigured: a verifier passes everything, and a co-sign never verifies', () => {
  const empty = anchorFromFile(makeTestAnchor({ keys: [] }));
  assert.deepEqual(
    { ...verifyAnswerProof({ answer: null, anchor: empty }) },
    { ok: true, mode: 'unconfigured', reason: null, credentialId: null, anchorSha256: null, epoch: 0, be: null, bs: null },
  );
  const cosign = byName('cosign').input;
  assert.equal(verifyCosign({ anchor: empty, cosign: cosign.cosign, expect: cosign.expect, now: cosign.now }).ok, false);
});

test('a verified answer reports the credential, the anchor hash, the epoch and the custody flags', () => {
  const vector = byName('answer-be');
  const anchor = anchorFromFile(vector.input.anchorFile);
  const result = run(vector);
  assert.equal(result.credentialId, vector.input.answer.proof.credentialId);
  assert.equal(result.anchorSha256, anchor.sha256);
  assert.equal(result.epoch, 0);
  assert.equal(result.be, true);
  assert.equal(result.bs, true);
});

test('a signed answer minted at test time over a fresh question verifies', () => {
  const question = '[conduct t touch 1] (run r1/1) Go?';
  const ask = { options: [{ key: 'a', label: 'Go', consequence: 'It goes.' }] };
  const questId = '22222222-3333-4444-8555-666666666666';
  const proof = signAnswer({ questId, question, ask, answerKey: 'a' });
  const result = verifyAnswerProof({ answer: { key: 'a', proof }, question, ask, questId, anchor: anchorFromFile(makeTestAnchor()) });
  assert.deepEqual([result.ok, result.mode, result.reason], [true, 'verified', null]);
});

// --- The CLI, always under a temp home (M3) -------------------------------------

function cli(args, home) {
  return spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
}

function spineQuestFile(dir, vector, patch = (receipt) => receipt) {
  const { answer, question, ask, questId } = vector.input;
  const body = { quests: [{ id: questId, title: 'Demo', latestReceipt: patch(structuredClone({ id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', outcome: 'answered', question, ask, answer })) }] };
  const file = join(dir, `quest-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

const lastLine = (result) => JSON.parse(result.stdout.trim().split('\n').at(-1));

test('CLI verify-receipt: verified, a flipped signature byte, an edited consequence', () => {
  const vector = byName('answer-key');
  const home = tmpHome();
  writeAnchorFile(home, JSON.stringify(vector.input.anchorFile));
  const quest = vector.input.questId;
  const verified = cli(['verify-receipt', '--file', spineQuestFile(home, vector), '--quest', quest], home);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(Object.keys(lastLine(verified)), ['ok', 'mode', 'reason', 'credentialId', 'epoch', 'grant']);
  assert.equal(lastLine(verified).mode, 'verified');
  const flipped = cli(['verify-receipt', '--file', spineQuestFile(home, vector, (receipt) => {
    const signature = Buffer.from(receipt.answer.proof.signature, 'base64url');
    signature[signature.length - 1] ^= 0x01;
    receipt.answer.proof.signature = signature.toString('base64url');
    return receipt;
  }), '--quest', quest], home);
  assert.equal(flipped.status, 1);
  assert.equal(lastLine(flipped).reason, 'bad_signature');
  const edited = cli(['verify-receipt', '--file', spineQuestFile(home, vector, (receipt) => {
    receipt.ask.options[0].consequence += ' And release it.';
    return receipt;
  }), '--quest', quest], home);
  assert.equal(edited.status, 1);
  assert.equal(lastLine(edited).reason, 'statement_mismatch');
});

test('CLI: no anchor file is unconfigured (exit 0); an unreadable anchor refuses', () => {
  const vector = byName('answer-key');
  const home = tmpHome();
  const file = spineQuestFile(home, vector);
  const unconfigured = cli(['verify-receipt', '--file', file, '--quest', vector.input.questId], home);
  assert.equal(unconfigured.status, 0, unconfigured.stderr);
  assert.equal(lastLine(unconfigured).mode, 'unconfigured');
  writeAnchorFile(home, 'not json');
  const unreadable = cli(['verify-receipt', '--file', file, '--quest', vector.input.questId], home);
  assert.equal(unreadable.status, 1);
  assert.equal(lastLine(unreadable).reason, 'anchor_unreadable');
});

test('CLI: there is no --anchor flag, and bad usage exits 2 without a verdict', () => {
  const home = tmpHome();
  const file = join(home, 'x.json');
  writeFileSync(file, '{}');
  for (const args of [
    ['verify-receipt', '--file', file, '--quest', 'q', '--anchor', file],
    ['verify-receipt', '--file', file],
    ['verify-record', '--file', file, '--quest', 'none', '--state', file],
    ['verify-everything'],
    [],
  ]) {
    const result = cli(args, home);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage:/);
  }
});

test('CLI: a quest prefix, a missing input file and a goal file', () => {
  const home = tmpHome();
  const answer = byName('answer-key');
  writeAnchorFile(home, JSON.stringify(answer.input.anchorFile));
  const prefix = cli(['verify-receipt', '--file', spineQuestFile(home, answer), '--quest', answer.input.questId.slice(0, 8)], home);
  assert.equal(prefix.status, 1);
  assert.equal(lastLine(prefix).reason, 'quest_id_not_full');
  const missing = cli(['verify-receipt', '--file', join(home, 'absent.json'), '--quest', answer.input.questId], home);
  assert.equal(missing.status, 1);
  assert.equal(lastLine(missing).reason, 'input_unreadable');
  const record = byName('record-touch-goal-trailing-newline');
  const recordFile = join(home, 'touch-1.json');
  writeFileSync(recordFile, JSON.stringify(record.input.record));
  const goalFile = join(home, 'goal.md');
  writeFileSync(goalFile, record.input.goalText);
  const verified = cli(['verify-record', '--file', recordFile, '--quest', record.input.quest, '--goal', goalFile], home);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.deepEqual(lastLine(verified).grant, record.expect.grant);
  assert.equal(lastLine(verified).scopeOk, true);
});

// --- make-vectors --append -----------------------------------------------------------

test('make-vectors --append adds one valid vector and leaves the others byte-identical', () => {
  const dir = tmpHome();
  const file = join(dir, 'vectors.json');
  copyFileSync(VECTORS_FILE, file);
  const before = readFileSync(file, 'utf8');
  const appended = spawnSync(process.execPath, [MAKE_VECTORS, '--append', 'pixel-flags', '--flags', '1d', '--file', file], { encoding: 'utf8' });
  assert.equal(appended.status, 0, appended.stderr);
  const after = readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before.replace(/\s*\]\s*$/, '')), 'the existing bytes are a prefix of the new file');
  const [old, now] = [JSON.parse(before), JSON.parse(after)];
  assert.equal(now.length, old.length + 1);
  assert.deepEqual(now.slice(0, -1), old);
  const added = now.at(-1);
  assert.equal(added.name, 'pixel-flags');
  assert.equal(Buffer.from(added.input.answer.proof.authenticatorData, 'base64url')[32], 0x1d);
  const result = run(added);
  assert.deepEqual([result.ok, result.mode, result.be, result.bs], [true, 'verified', true, true]);
  const duplicate = spawnSync(process.execPath, [MAKE_VECTORS, '--append', 'pixel-flags', '--flags', '1d', '--file', file], { encoding: 'utf8' });
  assert.notEqual(duplicate.status, 0);
  assert.equal(readFileSync(file, 'utf8'), after);
  const noUv = spawnSync(process.execPath, [MAKE_VECTORS, '--append', 'no-uv', '--flags', '01', '--file', file], { encoding: 'utf8' });
  assert.notEqual(noUv.status, 0);
});
