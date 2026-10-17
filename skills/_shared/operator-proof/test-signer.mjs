// test-signer.mjs: a software authenticator for tests. It mints answer proofs,
// registrations and co-signs laid out byte for byte as Chrome lays them out, over
// two fixed P-256 test keys. Test code only: operator-proof.mjs never imports it,
// and no anchor outside a test may hold these keys.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { answerStatement, challengeFor, registerBeginStatement, registerCosignStatement } from './operator-proof.mjs';

export const TEST_ORIGIN = 'https://example.test:8443';
export const TEST_RP_ID = 'example.test';

// Synthetic keys, committed on purpose (.gitleaks.toml allowlists this file).
export const TEST_KEY_1 = Object.freeze({
  kty: 'EC', crv: 'P-256',
  x: '4vjnUwqr2cnAF0dR2uyIhaweHqiu6p1NtuguCMhu1AU',
  y: 'VcuE-oghu3jtAXtzvTbKs6T2TuKx3csXFB1srToUsUY',
  d: 'iRO9gnXvtTlTRqb5ITdEjHAAj_eRYHfl-Vqai95xBJo',
});
export const TEST_KEY_2 = Object.freeze({
  kty: 'EC', crv: 'P-256',
  x: 'yyZbcY51oWq3EkhEi9xuXJqHSTq1Ln5bJDN67mkChGg',
  y: 't6DsPEQ6iv9VFiov547KbhVxQnvEHJPkMhSCjtrNB6c',
  d: 'oy-VN4I5OgCtwPK7pLM-_YsZdoA-7nnKAemj4tFOG5s',
});

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;

const sha256 = (data) => createHash('sha256').update(data).digest();

// Seconds precision, the form the Dogan signs.
export function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function publicKeySpkiOf(key) {
  return createPublicKey({ key, format: 'jwk' }).export({ type: 'spki', format: 'der' }).toString('base64url');
}

// A fixed 16-byte id per key, so anchors and proofs agree without bookkeeping.
export function credentialIdOf(key) {
  return sha256(Buffer.from(`${key.x}.${key.y}`, 'utf8')).subarray(0, 16).toString('base64url');
}

export function makeTestAnchor({
  origin = TEST_ORIGIN, rpId = TEST_RP_ID, keys = [TEST_KEY_1], epoch = 0,
  be = false, bs = false, registeredAt = '2026-10-17T00:00:00Z', label = 'test key',
} = {}) {
  return {
    v: 1,
    epoch,
    credentials: keys.map((key, i) => ({
      credentialId: credentialIdOf(key), publicKeySpki: publicKeySpkiOf(key), alg: -7, rpId, origin,
      registeredAt, label: `${label} ${i + 1}`, be, bs,
    })),
  };
}

// rpIdHash (32) | flags (1) | signCount (4, big-endian) | attested credential data.
function authenticatorData(rpId, flags, signCount, attested = Buffer.alloc(0)) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount);
  return Buffer.concat([sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), count, attested]);
}

// Chrome's member order: type, challenge, origin, crossOrigin. An override set to
// undefined drops the member.
function clientDataJSON(type, challenge, origin, overrides) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...overrides }), 'utf8');
}

// The COSE_Key map for an EC2 P-256 ES256 key: {1:2, 3:-7, -1:1, -2:x, -3:y}.
function coseKey(key) {
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(key.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(key.y, 'base64url'),
  ]);
}

function assertion({ key, origin, rpId, statement, flags, signCount, clientData }) {
  const challenge = challengeFor(statement).toString('base64url');
  const client = clientDataJSON('webauthn.get', challenge, origin, clientData);
  const data = authenticatorData(rpId, flags, signCount);
  const signature = sign('sha256', Buffer.concat([data, sha256(client)]), { key: createPrivateKey({ key, format: 'jwk' }), dsaEncoding: 'der' });
  return {
    credentialId: credentialIdOf(key), statement, authenticatorData: data.toString('base64url'),
    clientDataJSON: client.toString('base64url'), signature: signature.toString('base64url'),
  };
}

// Returns answer.proof: {v, credentialId, statement, authenticatorData, clientDataJSON, signature}.
export function signAnswer({
  key = TEST_KEY_1, origin = TEST_ORIGIN, rpId = TEST_RP_ID, questId, askReceiptId = null, question, ask,
  answerKey = null, text = null, signedAt = nowIso(), flags = FLAG_UP | FLAG_UV, signCount = 1, clientData = {},
} = {}) {
  const statement = answerStatement({ origin, questId, askReceiptId, question, ask, key: answerKey, text, signedAt });
  if (statement === null) throw new TypeError('signAnswer: the answer does not fit the ask (or an argument has the wrong type)');
  return { v: 1, ...assertion({ key, origin, rpId, statement, flags, signCount, clientData }) };
}

// Returns the registration fields verifyRegistration takes, less the server's
// expectedOrigin, expectedRpId and now.
export function signRegistration({
  key = TEST_KEY_1, origin = TEST_ORIGIN, rpId = TEST_RP_ID, signedAt = nowIso(), label = 'test key',
  flags = FLAG_UP | FLAG_UV | FLAG_AT, clientData = {}, attestedCredentialId = credentialIdOf(key),
} = {}) {
  const challenge = challengeFor(registerBeginStatement({ origin, signedAt })).toString('base64url');
  const id = Buffer.from(attestedCredentialId, 'base64url');
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(id.length);
  const attested = Buffer.concat([Buffer.alloc(16), idLength, id, coseKey(key)]);
  return {
    clientDataJSON: clientDataJSON('webauthn.create', challenge, origin, clientData).toString('base64url'),
    authenticatorData: authenticatorData(rpId, flags, 0, attested).toString('base64url'),
    credentialId: credentialIdOf(key), publicKeySpki: publicKeySpkiOf(key), alg: -7, label, signedAt,
  };
}

// An assertion by `key` (a registered credential) admitting the new credential.
// Returns {statement, credentialId, authenticatorData, clientDataJSON, signature}.
export function signCosign({
  key = TEST_KEY_1, origin = TEST_ORIGIN, rpId = TEST_RP_ID, credentialId, publicKeySpki, signedAt = nowIso(),
  flags = FLAG_UP | FLAG_UV, signCount = 1, clientData = {},
} = {}) {
  const statement = registerCosignStatement({ credentialId, publicKeySpki, origin, signedAt });
  if (statement === null) throw new TypeError('signCosign: credentialId, publicKeySpki, origin and signedAt must be strings');
  return assertion({ key, origin, rpId, statement, flags, signCount, clientData });
}
