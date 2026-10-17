// make-vectors.mjs: writes operator-proof.vectors.json with test-signer.mjs.
// Signatures are randomized, so a re-run changes the bytes and nothing depends on
// reproducing them. Entries this script does not generate (the captured Chrome
// vectors, and --append / --import entries) are carried over on a re-run.
//
//   node make-vectors.mjs [--file <vectors.json>]
//   node make-vectors.mjs --append <name> --flags <hex> [--file <vectors.json>]
//   node make-vectors.mjs --import <entries.json> [--file <vectors.json>]
//
// --append adds one valid answer vector signed with the given authenticator flags
// byte; --import adds the entries of a JSON array. Both leave every existing byte
// of the file as it was.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answerStatement, askSha256, canonical, grantTag, questionSha256, raiseTag, registerBeginStatement, registerCosignStatement, renderGrant, renderRaise } from './operator-proof.mjs';
import {
  FLAG_AT, FLAG_BE, FLAG_BS, FLAG_UP, FLAG_UV, TEST_KEY_1, TEST_KEY_2, TEST_ORIGIN, TEST_RP_ID,
  credentialIdOf, makeTestAnchor, publicKeySpkiOf, signAnswer, signCosign, signRegistration,
} from './test-signer.mjs';

export const VECTORS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'operator-proof.vectors.json');

const QUEST = '11111111-2222-4333-8444-555555555555';
const OTHER_QUEST = '99999999-2222-4333-8444-555555555555';
const ASK_RECEIPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ANSWER_RECEIPT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN = 'r20261017-demo';
const SIGNED_AT = '2026-10-17T12:00:00Z';
const SIGNED_MS = Date.parse(SIGNED_AT);
// "Now" for the grant-expiry checks: inside the default grant, after the expired one.
const NOW = Date.parse('2026-10-18T00:00:00Z');
const MINUTE = 60 * 1000;

const QUESTION = `[conduct demo touch 2] (run ${RUN}/1) Which way should the review go?`;
const ASK = {
  prompt: 'Which way should the review go?',
  options: [
    { key: 'a', label: 'Fix and re-review', consequence: 'The lane fixes the findings and the council reviews again.' },
    { key: 'b', label: 'Ship as is', consequence: 'The PR merges and the findings are filed as follow-ups.' },
  ],
  allowFreeText: true,
};

const GOAL = 'Ship the operator-proof verifier with its vectors.';
const SCOPE_C = 'Only the README and the vectors.';
const sha256Hex = (text) => createHash('sha256').update(text.normalize('NFC')).digest('hex');

const GRANT = {
  budgetUsd: 10, merge: true, release: false, scopeSha256: sha256Hex(GOAL), runId: RUN,
  repo: { remote: 'example/demo', defaultBranch: 'main' }, releaseRecipeSha256: null, notAfter: '2026-10-31T12:00:00Z',
};
const RAISE = { kind: 'budget-raise', runId: RUN, touch: 3, haltSpendUsd: 9.5 };

const TOUCH1_TAG = '[conduct demo touch 1]';
const TOUCH1_QUESTION = `${TOUCH1_TAG} (run ${RUN}/1) Approve the plan for: ${GOAL}`;
const grantConsequence = (grant) => `${renderGrant(grant)} [grant ${grantTag(grant)}]`;
const raiseConsequence = (raise) => `${renderRaise(raise)} [raise ${raiseTag(raise)}]`;
const grantAsk = (grant) => ({
  options: [
    { key: 'a', label: 'Approve', consequence: grantConsequence(grant) },
    { key: 'd', label: 'Decline', consequence: 'The run stops here.' },
  ],
  allowFreeText: false,
});

const clone = (value) => structuredClone(value);
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const flipLastByte = (b64url) => {
  const bytes = Buffer.from(b64url, 'base64url');
  bytes[bytes.length - 1] ^= 0x01;
  return bytes.toString('base64url');
};
const withCredential = (anchorFile, patch) => {
  const file = clone(anchorFile);
  Object.assign(file.credentials[0], patch);
  return file;
};

const vector = (name, kind, input, expect) => ({ name, kind, input, expect });
const VERIFIED = { ok: true, mode: 'verified', reason: null };
const refused = (reason) => ({ ok: false, mode: 'refused', reason });

const ANCHOR = makeTestAnchor();
const EMPTY_ANCHOR = makeTestAnchor({ keys: [], epoch: 2 });

const sign = (overrides = {}) => signAnswer({
  questId: QUEST, askReceiptId: ASK_RECEIPT, question: QUESTION, ask: ASK, answerKey: 'a', signedAt: SIGNED_AT, ...overrides,
});
const answerOf = (proof, overrides = {}) => ({
  key: 'a', text: null, by: 'operator:dogan', answeredAt: SIGNED_AT, askReceiptId: ASK_RECEIPT, proof, ...overrides,
});
const answerInput = (answer, overrides = {}) => ({ answer, question: QUESTION, ask: ASK, questId: QUEST, anchorFile: ANCHOR, ...overrides });

function answerVectors() {
  const proof = sign();
  const answer = answerOf(proof);
  const withProof = (patch) => answerOf({ ...proof, ...patch });
  const editedAsk = clone(ASK);
  editedAsk.options[1].consequence = 'The PR merges and the findings are dropped.';
  const freeText = '  Fix the findings, but skip the re-review.  ';
  const { ask: _ask, ...noAsk } = answerInput(answer);
  const noSignature = { ...proof };
  delete noSignature.signature;
  const shortData = Buffer.from(proof.authenticatorData, 'base64url').subarray(0, 36).toString('base64url');
  // A second option 'a': which label the key names would depend on option order.
  const duplicateKeyAsk = { ...clone(ASK), options: [...clone(ASK.options), { key: 'a', label: 'Ship as is', consequence: 'The PR merges.' }] };
  return [
    vector('answer-key', 'answer', answerInput(answer), VERIFIED),
    vector('answer-free-text', 'answer', answerInput(answerOf(sign({ answerKey: null, text: freeText }), { key: null, text: freeText })), VERIFIED),
    vector('answer-be', 'answer', answerInput(answerOf(sign({ flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS }))), { ...VERIFIED, be: true, bs: true }),
    vector('answer-legacy-prose-ask', 'answer', answerInput(answerOf(sign({ ask: null, answerKey: null, text: 'Yes.' }), { key: null, text: 'Yes.' }), { ask: null }), VERIFIED),
    vector('answer-expected-ask-receipt', 'answer', answerInput(answer, { askReceiptId: ASK_RECEIPT }), VERIFIED),
    vector('answer-unconfigured', 'answer', answerInput(answerOf(undefined, { by: 'operator:t3' }), { anchorFile: EMPTY_ANCHOR }), { ok: true, mode: 'unconfigured', reason: null }),
    vector('ask-missing', 'answer', noAsk, refused('ask_missing')),
    vector('proof-absent', 'answer', answerInput(answerOf(undefined)), refused('proof_absent')),
    vector('proof-absent-null', 'answer', answerInput(answerOf(null)), refused('proof_absent')),
    vector('unsupported-version', 'answer', answerInput(answerOf({ v: 2 })), refused('unsupported_version')),
    vector('malformed-proof-not-object', 'answer', answerInput(answerOf('signed')), refused('malformed_proof')),
    vector('malformed-proof-missing-field', 'answer', answerInput(answerOf(noSignature)), refused('malformed_proof')),
    vector('malformed-proof-statement-not-json', 'answer', answerInput(withProof({ statement: 'not json' })), refused('malformed_proof')),
    vector('malformed-proof-client-data-not-json', 'answer', answerInput(withProof({ clientDataJSON: b64('not json') })), refused('malformed_proof')),
    vector('malformed-proof-bad-base64url', 'answer', answerInput(withProof({ authenticatorData: 'ab+/cd==' })), refused('malformed_proof')),
    vector('malformed-proof-key-not-in-ask', 'answer', answerInput(answerOf(proof, { key: 'z' })), refused('malformed_proof')),
    vector('malformed-proof-duplicate-option-keys', 'answer', answerInput(answer, { ask: duplicateKeyAsk }), refused('malformed_proof')),
    vector('bad-timestamp', 'answer', answerInput(answerOf(sign({ signedAt: 'not a time' }))), refused('bad_timestamp')),
    vector('unknown-credential', 'answer', answerInput(answerOf(sign({ key: TEST_KEY_2 }))), refused('unknown_credential')),
    vector('statement-mismatch-key', 'answer', answerInput(answerOf(proof, { key: 'b' })), refused('statement_mismatch')),
    vector('statement-mismatch-text', 'answer', answerInput(answerOf(proof, { text: 'and release it' })), refused('statement_mismatch')),
    vector('statement-mismatch-consequence', 'answer', answerInput(answer, { ask: editedAsk }), refused('statement_mismatch')),
    vector('statement-mismatch-question', 'answer', answerInput(answer, { question: `${QUESTION} Also release.` }), refused('statement_mismatch')),
    vector('statement-mismatch-quest', 'answer', answerInput(answer, { questId: OTHER_QUEST }), refused('statement_mismatch')),
    vector('statement-mismatch-ask-receipt', 'answer', answerInput(answer, { askReceiptId: ANSWER_RECEIPT }), refused('statement_mismatch')),
    vector('statement-mismatch-answer-ask-receipt', 'answer', answerInput(answerOf(proof, { askReceiptId: ANSWER_RECEIPT })), refused('statement_mismatch')),
    vector('bad-authenticator-data', 'answer', answerInput(withProof({ authenticatorData: shortData })), refused('bad_authenticator_data')),
    vector('type-mismatch', 'answer', answerInput(answerOf(sign({ clientData: { type: 'webauthn.create' } }))), refused('type_mismatch')),
    vector('challenge-mismatch', 'answer', answerInput(answerOf(sign({ clientData: { challenge: b64('another challenge') } }))), refused('challenge_mismatch')),
    vector('origin-mismatch-client-data', 'answer', answerInput(answerOf(sign({ clientData: { origin: 'https://other.example.test:8443' } }))), refused('origin_mismatch')),
    vector('origin-mismatch-statement', 'answer', answerInput(answerOf(sign({ origin: 'https://other.example.test:8443', clientData: { origin: TEST_ORIGIN } }))), refused('origin_mismatch')),
    vector('cross-origin', 'answer', answerInput(answerOf(sign({ clientData: { crossOrigin: true } }))), refused('cross_origin')),
    vector('rp-mismatch', 'answer', answerInput(answerOf(sign({ rpId: 'other.example.test' }))), refused('rp_mismatch')),
    vector('alg-unsupported', 'answer', answerInput(answer, { anchorFile: withCredential(ANCHOR, { alg: -8 }) }), refused('alg_unsupported')),
    vector('up-required', 'answer', answerInput(answerOf(sign({ flags: FLAG_UV }))), refused('up_required')),
    vector('uv-required', 'answer', answerInput(answerOf(sign({ flags: FLAG_UP }))), refused('uv_required')),
    vector('bad-key', 'answer', answerInput(answer, { anchorFile: withCredential(ANCHOR, { publicKeySpki: 'AAAA' }) }), refused('bad_key')),
    vector('bad-signature', 'answer', answerInput(withProof({ signature: flipLastByte(proof.signature) })), refused('bad_signature')),
    vector('bad-signature-wrong-key', 'answer', answerInput(answer, { anchorFile: withCredential(ANCHOR, { publicKeySpki: publicKeySpkiOf(TEST_KEY_2) }) }), refused('bad_signature')),
  ];
}

function registrationVectors() {
  const registration = signRegistration({ signedAt: SIGNED_AT });
  const input = (fields, overrides = {}) => ({ ...fields, expectedOrigin: TEST_ORIGIN, expectedRpId: TEST_RP_ID, now: SIGNED_MS + MINUTE, ...overrides });
  const credential = {
    credentialId: credentialIdOf(TEST_KEY_1), publicKeySpki: publicKeySpkiOf(TEST_KEY_1), alg: -7, rpId: TEST_RP_ID,
    origin: TEST_ORIGIN, registeredAt: new Date(SIGNED_MS + MINUTE).toISOString(), label: 'test key', be: false, bs: false,
  };
  const make = (overrides) => signRegistration({ signedAt: SIGNED_AT, ...overrides });
  // The attested COSE_Key starts after the 16-byte credential id, at 55 + 16:
  // a5 | 01 02 (kty 2) | 03 26 (alg -7) | 20 01 (crv 1) | 21 58 20 x | 22 58 20 y.
  const COSE_AT = 55 + 16;
  const withAuthData = (edit) => {
    const bytes = Buffer.from(registration.authenticatorData, 'base64url');
    return { ...registration, authenticatorData: edit(bytes).toString('base64url') };
  };
  const setByte = (offset, value) => (bytes) => {
    bytes[offset] = value;
    return bytes;
  };
  return [
    vector('registration', 'registration', input(registration), { ...VERIFIED, credential }),
    vector('registration-malformed', 'registration', input({ ...registration, clientDataJSON: '***' }), refused('malformed_proof')),
    vector('registration-bad-timestamp', 'registration', input(make({ signedAt: 'soon' })), refused('bad_timestamp')),
    vector('registration-bad-authenticator-data', 'registration', input(make({ flags: FLAG_UP | FLAG_UV })), refused('bad_authenticator_data')),
    vector('registration-type-mismatch', 'registration', input(make({ clientData: { type: 'webauthn.get' } })), refused('type_mismatch')),
    vector('registration-challenge-mismatch', 'registration', input(registration, { signedAt: '2026-10-17T12:00:01Z' }), refused('challenge_mismatch')),
    vector('registration-origin-mismatch', 'registration', input(make({ clientData: { origin: 'https://other.example.test:8443' } })), refused('origin_mismatch')),
    vector('registration-cross-origin', 'registration', input(make({ clientData: { crossOrigin: true } })), refused('cross_origin')),
    vector('registration-rp-mismatch', 'registration', input(make({ rpId: 'other.example.test' })), refused('rp_mismatch')),
    vector('registration-up-required', 'registration', input(make({ flags: FLAG_UV | FLAG_AT })), refused('up_required')),
    vector('registration-uv-required', 'registration', input(make({ flags: FLAG_UP | FLAG_AT })), refused('uv_required')),
    vector('registration-credential-id-mismatch', 'registration', input(make({ attestedCredentialId: credentialIdOf(TEST_KEY_2) })), refused('credential_id_mismatch')),
    vector('registration-alg-unsupported', 'registration', input({ ...registration, alg: -257 }), refused('alg_unsupported')),
    vector('registration-bad-key', 'registration', input({ ...registration, publicKeySpki: 'AAAA' }), refused('bad_key')),
    vector('registration-key-mismatch-spki', 'registration', input({ ...registration, publicKeySpki: publicKeySpkiOf(TEST_KEY_2) }), refused('key_mismatch')),
    vector('registration-key-mismatch-cose-alg', 'registration', input(withAuthData(setByte(COSE_AT + 4, 0x27))), refused('key_mismatch')),
    vector('registration-cose-bad-kty', 'registration', input(withAuthData(setByte(COSE_AT + 2, 0x03))), refused('bad_key')),
    vector('registration-cose-not-a-map', 'registration', input(withAuthData(setByte(COSE_AT, 0x85))), refused('bad_key')),
    vector('registration-truncated-after-credential-id', 'registration', input(withAuthData((bytes) => bytes.subarray(0, COSE_AT))), refused('malformed_proof')),
    vector('registration-truncated-cose-key', 'registration', input(withAuthData((bytes) => bytes.subarray(0, bytes.length - 1))), refused('malformed_proof')),
    vector('registration-stale', 'registration', input(registration, { now: SIGNED_MS + 16 * MINUTE }), refused('proof_stale')),
    vector('registration-future', 'registration', input(registration, { now: SIGNED_MS - 3 * MINUTE }), refused('proof_stale')),
  ];
}

function cosignVectors() {
  const admitted = { credentialId: credentialIdOf(TEST_KEY_2), publicKeySpki: publicKeySpkiOf(TEST_KEY_2), origin: TEST_ORIGIN };
  const cosign = signCosign({ ...admitted, signedAt: SIGNED_AT });
  const input = (overrides = {}) => ({ anchorFile: ANCHOR, cosign, expect: admitted, now: SIGNED_MS + MINUTE, ...overrides });
  return [
    vector('cosign', 'cosign', input(), VERIFIED),
    vector('cosign-mismatch', 'cosign', input({ expect: { ...admitted, credentialId: credentialIdOf(TEST_KEY_1) } }), refused('cosign_mismatch')),
    vector('cosign-stale', 'cosign', input({ now: SIGNED_MS + 16 * MINUTE }), refused('proof_stale')),
    vector('cosign-future', 'cosign', input({ now: SIGNED_MS - 3 * MINUTE }), refused('proof_stale')),
    vector('cosign-unknown-credential', 'cosign', input({ cosign: signCosign({ ...admitted, key: TEST_KEY_2, signedAt: SIGNED_AT }) }), refused('unknown_credential')),
    vector('cosign-bad-signature', 'cosign', input({ cosign: { ...cosign, signature: flipLastByte(cosign.signature) } }), refused('bad_signature')),
    vector('cosign-absent', 'cosign', input({ cosign: null }), refused('proof_absent')),
    vector('cosign-unconfigured', 'cosign', input({ anchorFile: EMPTY_ANCHOR }), refused('cosign_unconfigured')),
  ];
}

// The exact bytes every port (the Dogan's browser copy included) must produce.
function canonicalVectors() {
  const answerArgs = {
    origin: TEST_ORIGIN, questId: QUEST, askReceiptId: ASK_RECEIPT, question: 'Café or tea?',
    ask: { options: [{ key: 'b', label: 'Tea', consequence: 'Tea is made.' }, { key: 'a', label: 'Café', consequence: 'Coffee is made.' }] },
    key: 'a', text: '  Café, please.  ', signedAt: SIGNED_AT,
  };
  const legacyArgs = { origin: TEST_ORIGIN, questId: QUEST, question: 'Go ahead?', ask: null, text: 'yes', signedAt: SIGNED_AT };
  const beginArgs = { origin: TEST_ORIGIN, signedAt: SIGNED_AT };
  const cosignArgs = { credentialId: credentialIdOf(TEST_KEY_2), publicKeySpki: publicKeySpkiOf(TEST_KEY_2), origin: TEST_ORIGIN, signedAt: SIGNED_AT };
  const hash = (name, fn, value, result) => vector(name, 'hash', { fn, value }, { hash: result });
  return [
    vector('canonical-answer-statement', 'canonical', { builder: 'answerStatement', args: answerArgs }, { statement: answerStatement(answerArgs) }),
    vector('canonical-answer-statement-legacy', 'canonical', { builder: 'answerStatement', args: legacyArgs }, { statement: answerStatement(legacyArgs) }),
    vector('canonical-register-begin-statement', 'canonical', { builder: 'registerBeginStatement', args: beginArgs }, { statement: registerBeginStatement(beginArgs) }),
    vector('canonical-register-cosign-statement', 'canonical', { builder: 'registerCosignStatement', args: cosignArgs }, { statement: registerCosignStatement(cosignArgs) }),
    hash('hash-question-nfc', 'questionSha256', 'Café or tea?', questionSha256('Café or tea?')),
    hash('hash-ask-defaults', 'askSha256', answerArgs.ask, askSha256(answerArgs.ask)),
    hash('hash-ask', 'askSha256', ASK, askSha256(ASK)),
    hash('hash-ask-legacy-null', 'askSha256', null, askSha256(null)),
    hash('hash-ask-duplicate-keys', 'askSha256', { options: [...answerArgs.ask.options, { key: 'a', label: 'Tea', consequence: 'Tea is made.' }] }, null),
  ];
}

function tagVectors() {
  const releaseGrant = { ...GRANT, release: true, releaseRecipeSha256: sha256Hex(canonical({ steps: ['npm version patch', 'git push --tags'] })) };
  const tagged = (name, kind, input, value, render, tag, consequence) => vector(name, kind, input, {
    canonical: canonical(value), tag: tag(value), rendered: render(value), consequence: consequence(value),
  });
  const raiseAsk = { options: [{ key: 'a', label: 'Raise', consequence: raiseConsequence(RAISE) }, { key: 'd', label: 'Stop', consequence: 'The run halts.' }], allowFreeText: true };
  return [
    tagged('grant-tag', 'grant', { grant: GRANT }, GRANT, renderGrant, grantTag, grantConsequence),
    tagged('grant-tag-release', 'grant', { grant: releaseGrant }, releaseGrant, renderGrant, grantTag, grantConsequence),
    tagged('raise-tag', 'raise', { raise: RAISE }, RAISE, renderRaise, raiseTag, raiseConsequence),
    vector('grant-check', 'grant-check', { grant: GRANT, ask: grantAsk(GRANT), key: 'a' }, { ok: true, reason: null }),
    vector('grant-check-options', 'grant-check', { grant: GRANT, ask: { options: grantAsk(GRANT).options }, key: 'a' }, { ok: true, reason: null }),
    vector('grant-tag-mismatch', 'grant-check', { grant: { ...GRANT, budgetUsd: 100 }, ask: grantAsk(GRANT), key: 'a' }, { ok: false, reason: 'grant_tag_mismatch' }),
    vector('raise-check', 'raise-check', { raise: RAISE, ask: raiseAsk, key: 'a' }, { ok: true, reason: null }),
    vector('raise-tag-mismatch', 'raise-check', { raise: { ...RAISE, haltSpendUsd: 90 }, ask: raiseAsk, key: 'a' }, { ok: false, reason: 'raise_tag_mismatch' }),
  ];
}

// readAnchor over the file text: sha256 is over canonical(parsed), so formatting
// does not change it.
function anchorVectors() {
  const expected = { configured: true, epoch: 0, sha256: sha256Hex(canonical(ANCHOR)) };
  return [
    vector('anchor-configured', 'anchor', { text: `${JSON.stringify(ANCHOR, null, 2)}\n` }, expected),
    vector('anchor-configured-compact', 'anchor', { text: JSON.stringify(ANCHOR) }, expected),
    vector('anchor-empty', 'anchor', { text: JSON.stringify(EMPTY_ANCHOR) }, { configured: false, epoch: 2 }),
    vector('anchor-unreadable-json', 'anchor', { text: '{"v":1,' }, { throws: 'anchor_unreadable' }),
    vector('anchor-unreadable-shape', 'anchor', { text: '[]' }, { throws: 'anchor_unreadable' }),
    // 1e400 parses as Infinity, which canonical() cannot encode.
    vector('anchor-unreadable-alg-overflow', 'anchor', { text: JSON.stringify(ANCHOR).replace('"alg":-7', '"alg":1e400') }, { throws: 'anchor_unreadable' }),
    vector('anchor-unreadable-extra-overflow', 'anchor', { text: JSON.stringify(ANCHOR).replace('"v":1', '"v":1,"note":1e400') }, { throws: 'anchor_unreadable' }),
    vector('anchor-unreadable-field-type', 'anchor', { text: JSON.stringify(ANCHOR).replace('"be":false', '"be":"no"') }, { throws: 'anchor_unreadable' }),
  ];
}

function receiptVectors() {
  const ask = grantAsk(GRANT);
  const proof = signAnswer({ questId: QUEST, askReceiptId: ASK_RECEIPT, question: TOUCH1_QUESTION, ask, answerKey: 'a', signedAt: SIGNED_AT });
  const receipt = (answer, overrides = {}) => ({ id: ANSWER_RECEIPT, outcome: 'answered', question: TOUCH1_QUESTION, ask, answer, ...overrides });
  const row = receipt(answerOf(proof));
  const body = (latestReceipt, id = QUEST) => ({ quests: [{ id, title: 'Demo quest', latestReceipt }] });
  const state = (grant = GRANT, touch = {}) => ({
    runId: RUN, touches: [{ n: 1, tag: TOUCH1_TAG, receiptId: ASK_RECEIPT, options: ask.options, grants: { a: grant }, ...touch }],
  });
  const input = (overrides) => ({ body: body(row), quest: QUEST, anchorFile: ANCHOR, now: NOW, ...overrides });
  const signedWith = (grant) => {
    const grantedAsk = grantAsk(grant);
    const signed = signAnswer({ questId: QUEST, askReceiptId: ASK_RECEIPT, question: TOUCH1_QUESTION, ask: grantedAsk, answerKey: 'a', signedAt: SIGNED_AT });
    return { body: body(receipt(answerOf(signed), { ask: grantedAsk })), state: state(grant) };
  };
  const expiredGrant = { ...GRANT, notAfter: '2026-10-17T13:00:00Z' };
  const otherRunGrant = { ...GRANT, runId: 'r20261001-other' };
  const { askReceiptId: _id, ...unboundAnswer } = answerOf(proof);
  const signedA = { key: 'a', text: null };
  return [
    vector('receipt-spine-quest', 'receipt', input({ state: state(), goalText: `${GOAL}\n` }), { ...VERIFIED, grant: GRANT, answer: signedA, scopeOk: true }),
    vector('receipt-bare-row', 'receipt', input({ body: row }), { ...VERIFIED, grant: null, answer: signedA }),
    // The row's askReceiptId metadata must name the ask the operator signed for.
    vector('receipt-bare-row-ask-receipt-mismatch', 'receipt', input({ body: receipt(answerOf(proof, { askReceiptId: ANSWER_RECEIPT })) }), { ...refused('statement_mismatch'), grant: null, answer: null }),
    vector('receipt-state-by-tag', 'receipt', input({ body: body(receipt(unboundAnswer)), state: state() }), { ...VERIFIED, grant: GRANT }),
    vector('receipt-quest-id-not-full', 'receipt', input({ quest: QUEST.slice(0, 8) }), { ...refused('quest_id_not_full'), grant: null }),
    vector('receipt-quest-id-not-full-body', 'receipt', input({ body: body(row, QUEST.slice(0, 8)) }), { ...refused('quest_id_not_full'), grant: null }),
    vector('receipt-not-answered', 'receipt', input({ body: body(receipt(null, { outcome: 'needs_input' })) }), { ...refused('not_answered'), grant: null }),
    vector('receipt-input-unreadable', 'receipt', input({ body: 'not a receipt' }), { ...refused('input_unreadable'), grant: null }),
    vector('receipt-unsigned', 'receipt', input({ body: body(receipt(answerOf(undefined, { by: 'operator:t3' }))) }), { ...refused('proof_absent'), grant: null }),
    vector('receipt-grant-tag-mismatch', 'receipt', input({ state: state({ ...GRANT, budgetUsd: 100 }) }), { ...refused('grant_tag_mismatch'), grant: null }),
    vector('receipt-grant-expired', 'receipt', input(signedWith(expiredGrant)), { ...refused('grant_expired'), grant: null }),
    vector('receipt-wrong-run', 'receipt', input(signedWith(otherRunGrant)), { ...refused('wrong_run'), grant: null }),
    vector('receipt-unconfigured', 'receipt', input({ body: body(receipt(answerOf(undefined, { by: 'operator:t3' }))), state: state(), anchorFile: EMPTY_ANCHOR }), { ok: true, mode: 'unconfigured', reason: null, grant: GRANT, answer: signedA }),
  ];
}

function recordVectors() {
  const ask = grantAsk(GRANT);
  const proof = signAnswer({ questId: QUEST, askReceiptId: ASK_RECEIPT, question: TOUCH1_QUESTION, ask, answerKey: 'a', signedAt: SIGNED_AT });
  const signedBlock = { answer: answerOf(proof), question: TOUCH1_QUESTION, ask };
  const touchRecord = (overrides = {}) => ({
    n: 1, kind: 'preapproval', tag: TOUCH1_TAG, question: TOUCH1_QUESTION, receiptId: ASK_RECEIPT, options: ask.options, grants: { a: GRANT },
    answer: { key: 'a', text: null, by: 'operator:dogan', proofMode: 'verified', signed: signedBlock }, ...overrides,
  });
  const withOuter = (patch) => touchRecord({ answer: { ...touchRecord().answer, ...patch } });
  // A typed answer with no key: conduct records it as option (c).
  const typed = 'Narrow it to the README.';
  const askFree = {
    options: [...ask.options.slice(0, 1), { key: 'c', label: 'Narrow the scope', consequence: 'Type the narrowed scope.' }, ...ask.options.slice(1)],
    allowFreeText: true,
  };
  const typedProof = signAnswer({ questId: QUEST, askReceiptId: ASK_RECEIPT, question: TOUCH1_QUESTION, ask: askFree, answerKey: null, text: typed, signedAt: SIGNED_AT });
  const typedRecord = (outerText) => touchRecord({
    options: askFree.options,
    answer: {
      key: 'c', text: outerText, by: 'operator:dogan', proofMode: 'verified',
      signed: { answer: answerOf(typedProof, { key: null, text: typed }), question: TOUCH1_QUESTION, ask: askFree },
    },
  });
  // A (c) answer and the confirm touch that turns it into authority.
  const grantC = { ...GRANT, scopeSha256: sha256Hex(SCOPE_C) };
  const askC = grantAsk(grantC);
  const confirmQuestion = `${TOUCH1_TAG.replace('1', '2')} (run ${RUN}/1) Confirm the narrowed scope. Scope: ${SCOPE_C}`;
  const proofC = signAnswer({ questId: QUEST, askReceiptId: ASK_RECEIPT, question: confirmQuestion, ask: askC, answerKey: 'a', signedAt: SIGNED_AT });
  const freeProof = signAnswer({ questId: QUEST, askReceiptId: ASK_RECEIPT, question: TOUCH1_QUESTION, ask, answerKey: null, text: SCOPE_C, signedAt: SIGNED_AT });
  const authorityRecord = {
    kind: 'authority', scope: SCOPE_C,
    answer: { key: null, text: SCOPE_C, signed: { answer: answerOf(freeProof, { key: null, text: SCOPE_C }), question: TOUCH1_QUESTION, ask } },
    confirm: {
      question: confirmQuestion, receiptId: ASK_RECEIPT, options: askC.options, grants: { a: grantC },
      answer: { key: 'a', text: null, signed: { answer: answerOf(proofC), question: confirmQuestion, ask: askC } },
    },
  };
  const unsignedRecord = touchRecord({ answer: { key: 'a', text: null, by: 'operator:tty', proofMode: 'unconfigured' } });
  const input = (record, overrides = {}) => ({ record, quest: QUEST, anchorFile: ANCHOR, now: NOW, ...overrides });
  const signedA = { key: 'a', text: null };
  return [
    vector('record-touch', 'record', input(touchRecord()), { ...VERIFIED, grant: GRANT, answer: signedA }),
    vector('record-touch-goal-trailing-newline', 'record', input(touchRecord(), { goalText: `${GOAL}\n` }), { ...VERIFIED, grant: GRANT, scopeOk: true }),
    vector('record-touch-goal-two-newlines', 'record', input(touchRecord(), { goalText: `${GOAL}\n\n` }), { ...VERIFIED, grant: GRANT, scopeOk: false }),
    vector('record-authority-confirm-scope', 'record', input(authorityRecord, { goalText: `${GOAL}\n` }), { ...VERIFIED, grant: grantC, answer: signedA, scopeOk: true }),
    // The record's own answer must be the one the operator signed.
    vector('record-answer-mismatch-key', 'record', input(withOuter({ key: 'd' })), { ...refused('record_answer_mismatch'), grant: null, answer: null }),
    vector('record-answer-mismatch-text', 'record', input(withOuter({ text: 'and release it' })), { ...refused('record_answer_mismatch'), grant: null, answer: null }),
    vector('record-answer-typed-as-c', 'record', input(typedRecord(typed)), { ...VERIFIED, grant: null, answer: { key: null, text: typed } }),
    vector('record-answer-typed-as-c-text-differs', 'record', input(typedRecord('Release it too.')), { ...refused('record_answer_mismatch'), grant: null, answer: null }),
    // The touch's filed ask id must be the one the statement names.
    vector('record-receipt-id-mismatch', 'record', input(touchRecord({ receiptId: ANSWER_RECEIPT })), { ...refused('statement_mismatch'), grant: null, answer: null }),
    vector('record-authority-plain', 'record', input({ kind: 'authority', answer: touchRecord().answer, grants: { a: GRANT } }), { ...VERIFIED, grant: GRANT }),
    vector('record-grant-tag-mismatch', 'record', input(touchRecord({ grants: { a: { ...GRANT, merge: false } } })), { ...refused('grant_tag_mismatch'), grant: null }),
    vector('record-quest-none-configured', 'record', input(touchRecord(), { quest: 'none' }), { ...refused('quest_id_not_full'), grant: null }),
    vector('record-quest-none-unconfigured', 'record', input(unsignedRecord, { quest: 'none', anchorFile: EMPTY_ANCHOR }), { ok: true, mode: 'unconfigured', reason: null, grant: GRANT, answer: null }),
    vector('record-unconfigured-grant-mismatch', 'record', input(touchRecord({ grants: { a: { ...GRANT, merge: false } } }), { anchorFile: EMPTY_ANCHOR }), { ok: true, mode: 'unconfigured', reason: 'grant_tag_mismatch', grant: null }),
    vector('record-unsigned-configured', 'record', input(unsignedRecord), { ...refused('proof_absent'), grant: null }),
  ];
}

export function generate() {
  return [
    ...answerVectors(), ...registrationVectors(), ...cosignVectors(), ...canonicalVectors(),
    ...tagVectors(), ...anchorVectors(), ...receiptVectors(), ...recordVectors(),
  ];
}

// One valid answer vector signed with an authenticator flags byte (WP-10 uses the
// phone's), over the same example.test fixtures as the generated ones.
export function flagsVector(name, flags) {
  if ((flags & (FLAG_UP | FLAG_UV)) !== (FLAG_UP | FLAG_UV)) throw new Error(`flags 0x${flags.toString(16)} lack UP and UV: the vector would not be valid`);
  const anchorFile = makeTestAnchor({ be: (flags & FLAG_BE) !== 0, bs: (flags & FLAG_BS) !== 0 });
  return vector(name, 'answer', answerInput(answerOf(sign({ flags })), { anchorFile }), VERIFIED);
}

const isVector = (entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string'
  && typeof entry.kind === 'string' && 'input' in entry && 'expect' in entry;

// Appends textually, so every existing byte of the file stays as it was.
export function appendEntries(file, entries) {
  const text = readFileSync(file, 'utf8');
  const existing = JSON.parse(text);
  const names = new Set(existing.map((entry) => entry.name));
  for (const entry of entries) {
    if (!isVector(entry)) throw new Error('an entry is not {name, kind, input, expect}');
    if (names.has(entry.name)) throw new Error(`a vector named ${entry.name} already exists`);
    names.add(entry.name);
  }
  const head = text.replace(/\s*\]\s*$/, '');
  if (head === text) throw new Error(`${file} does not end with ]`);
  const block = entries.map((entry) => JSON.stringify(entry, null, 2).replace(/^/gm, '  ')).join(',\n');
  writeFileSync(file, `${head}${existing.length > 0 ? ',' : ''}\n${block}\n]\n`);
}

export function writeAll(file) {
  const generated = generate();
  const names = new Set(generated.map((entry) => entry.name));
  const carried = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).filter((entry) => !names.has(entry.name)) : [];
  writeFileSync(file, `${JSON.stringify([...generated, ...carried], null, 2)}\n`);
  return { generated: generated.length, carried: carried.length };
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--file', '--append', '--flags', '--import'].includes(argv[i]) || argv[i + 1] === undefined) {
      process.stderr.write('usage: node make-vectors.mjs [--file <f>] [--append <name> --flags <hex> | --import <entries.json>]\n');
      process.exitCode = 2;
      return;
    }
    flags[argv[i]] = argv[i + 1];
  }
  const file = resolve(flags['--file'] ?? VECTORS_FILE);
  if (flags['--append'] !== undefined) {
    if (!/^(0x)?[0-9a-f]{1,2}$/i.test(flags['--flags'] ?? '')) throw new Error('--append needs --flags <hex byte>');
    appendEntries(file, [flagsVector(flags['--append'], Number.parseInt(flags['--flags'].replace(/^0x/i, ''), 16))]);
    process.stdout.write(`appended ${flags['--append']} to ${file}\n`);
  } else if (flags['--import'] !== undefined) {
    const entries = JSON.parse(readFileSync(flags['--import'], 'utf8'));
    appendEntries(file, entries);
    process.stdout.write(`imported ${entries.length} vector(s) into ${file}\n`);
  } else {
    const { generated, carried } = writeAll(file);
    process.stdout.write(`wrote ${generated} generated and ${carried} carried vector(s) to ${file}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2));
}
