// operator-proof.mjs: decides whether the operator's registered passkey signed
// a Spine answer. Zero dependencies (node: built-ins only). Every consumer copies
// this file byte for byte and pins it by the SHA-256 of its text after CRLF -> LF
// normalisation; README.md has the contract and the copy procedure.
//
// It is a library and a CLI. The CLI verifies against readAnchor() and nothing else:
//   node operator-proof.mjs verify-receipt --file <f> --quest <full uuid> [--state <state.json>] [--goal <file>]
//   node operator-proof.mjs verify-record --file <f> --quest <id|none> [--goal <file>]
// Each prints one JSON line {ok, mode, reason, credentialId, epoch, grant, answer, scopeOk?}
// and exits 0 only on ok (verified, or unconfigured).
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Stable refusal codes. Tests and consumers compare codes, never message text.
export const REASONS = Object.freeze(Object.fromEntries([
  'ask_missing', 'proof_absent', 'unsupported_version', 'malformed_proof', 'bad_timestamp',
  'unknown_credential', 'statement_mismatch', 'bad_authenticator_data', 'type_mismatch',
  'challenge_mismatch', 'origin_mismatch', 'cross_origin', 'rp_mismatch', 'alg_unsupported',
  'up_required', 'uv_required', 'bad_key', 'bad_signature', 'credential_id_mismatch', 'key_mismatch',
  'cosign_mismatch', 'cosign_unconfigured', 'proof_stale', 'anchor_unreadable', 'grant_tag_mismatch', 'grant_expired',
  'wrong_run', 'raise_tag_mismatch', 'quest_id_not_full', 'not_answered', 'input_unreadable', 'record_answer_mismatch',
].map((code) => [code, code])));

export class OperatorProofError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'OperatorProofError';
    this.code = code;
  }
}

// A grant's notAfter is its filing time plus this many days. No flag changes it.
export const GRANT_TTL_DAYS = 14;
// A signed registration co-sign (and, at the writer, an answer) is fresh when its
// signedAt is at most 15 minutes in the past and at most 2 minutes in the future.
export const FRESH_PAST_MS = 15 * 60 * 1000;
export const FRESH_FUTURE_MS = 2 * 60 * 1000;

const ES256 = -7;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStr = (value) => typeof value === 'string';
const nfc = (text) => text.normalize('NFC');
const sha256 = (data) => createHash('sha256').update(data).digest();
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
// A leading byte-order mark, written as an escape: an invisible literal is too easy to lose.
const stripBom = (text) => text.replace(/^\u{FEFF}/u, '');

// Sorted keys, no whitespace, NFC strings. Only JSON values: anything else is a
// programmer error and throws a TypeError.
export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical: a number must be finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(nfc(value));
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const proto = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonical: not a JSON value (${typeof value})`);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => {
    if (value[key] === undefined) throw new TypeError(`canonical: ${key} is undefined`);
    return `${JSON.stringify(key)}:${canonical(value[key])}`;
  }).join(',')}}`;
}

export function questionSha256(question) {
  return isStr(question) ? sha256Hex(nfc(question)) : null;
}

// What the operator reads of an ask: its prompt (AskCard shows prompt ?? question),
// whether free text is allowed, and every option's key, label and consequence.
// A legacy prose ask is null and hashes canonical(null). Bad shape, or two options
// with one key (which label a key names would depend on their order): null.
// Options sort by their NFC key.
function askCanonical(ask) {
  if (ask === null) return canonical(null);
  if (!isObj(ask) || !Array.isArray(ask.options)) return null;
  const prompt = ask.prompt ?? null;
  const allowFreeText = ask.allowFreeText === undefined ? false : ask.allowFreeText;
  if ((prompt !== null && !isStr(prompt)) || typeof allowFreeText !== 'boolean') return null;
  const options = [];
  const keys = new Set();
  for (const option of ask.options) {
    if (!isObj(option) || !isStr(option.key) || !isStr(option.label) || !isStr(option.consequence)) return null;
    const key = nfc(option.key);
    if (keys.has(key)) return null;
    keys.add(key);
    options.push({ key, label: option.label, consequence: option.consequence });
  }
  options.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return canonical({ allowFreeText, prompt, options });
}

export function askSha256(ask) {
  const text = askCanonical(ask);
  return text === null ? null : sha256Hex(text);
}

// The answer statement, as the exact canonical string that is signed. The label is
// derived from the ask's option for key, never supplied. Bad shape: null.
export function answerStatement(args) {
  if (!isObj(args)) return null;
  const { origin, questId, question, ask, signedAt } = args;
  const askReceiptId = args.askReceiptId ?? null;
  const key = args.key ?? null;
  const text = args.text ?? null;
  if (!isStr(origin) || !isStr(questId) || !isStr(signedAt)) return null;
  if ((askReceiptId !== null && !isStr(askReceiptId)) || (key !== null && !isStr(key)) || (text !== null && !isStr(text))) return null;
  const questionHash = questionSha256(question);
  const askHash = askSha256(ask);
  if (questionHash === null || askHash === null) return null;
  let label = null;
  if (key !== null) {
    const option = ask === null ? undefined : ask.options.find((candidate) => candidate.key === key);
    if (!option) return null;
    label = option.label;
  }
  const trimmed = text === null ? '' : nfc(text.trim());
  return canonical({
    v: 1, origin, questId, askReceiptId, questionSha256: questionHash, askSha256: askHash,
    key, label, text: trimmed === '' ? null : trimmed, signedAt,
  });
}

// The challenge preimage for navigator.credentials.create().
export function registerBeginStatement(args) {
  if (!isObj(args) || !isStr(args.origin) || !isStr(args.signedAt)) return null;
  return canonical({ v: 1, op: 'register-begin', origin: args.origin, signedAt: args.signedAt });
}

// What a registered credential signs to admit a new one.
export function registerCosignStatement(args) {
  if (!isObj(args) || !isStr(args.credentialId) || !isStr(args.publicKeySpki) || !isStr(args.origin) || !isStr(args.signedAt)) return null;
  return canonical({
    v: 1, op: 'register', credentialId: args.credentialId, publicKeySpki: args.publicKeySpki,
    origin: args.origin, signedAt: args.signedAt,
  });
}

export function challengeFor(statement) {
  if (!isStr(statement)) throw new TypeError('challengeFor: the statement must be a string');
  return sha256(Buffer.from(statement, 'utf8'));
}

// --- The anchor -------------------------------------------------------------
// File shape (on disk): {v:1, epoch, credentials:[{credentialId, publicKeySpki,
// alg, rpId, origin, registeredAt, label, be, bs}]}. Anchor object (what every
// verifier takes): {configured, epoch, credentials, sha256}.

export function anchorPath() {
  return join(homedir(), '.claude', 'operator-passkeys.json');
}

const isBool = (value) => typeof value === 'boolean';
const CREDENTIAL_FIELDS = Object.entries({
  credentialId: isStr, publicKeySpki: isStr, alg: Number.isInteger, rpId: isStr, origin: isStr,
  registeredAt: isStr, label: isStr, be: isBool, bs: isBool,
});

// An anchor that exists but cannot be read as the file shape throws: it must
// never read as "not configured", which would switch verification off. Every
// credential field is checked, and the file must canonicalise (JSON.parse turns
// 1e400 into Infinity, which canonical() refuses).
export function anchorFromFile(file) {
  const unreadable = (why) => new OperatorProofError(REASONS.anchor_unreadable, `operator anchor: ${why}`);
  if (!isObj(file) || file.v !== 1) throw unreadable('not a v1 anchor file');
  if (!Number.isInteger(file.epoch) || file.epoch < 0) throw unreadable('epoch is not an integer >= 0');
  if (!Array.isArray(file.credentials)) throw unreadable('credentials is not an array');
  for (const credential of file.credentials) {
    if (!isObj(credential)) throw unreadable('a credential is not an object');
    for (const [field, valid] of CREDENTIAL_FIELDS) {
      if (!valid(credential[field])) throw unreadable(`a credential's ${field} is missing or has the wrong type`);
    }
  }
  let hash;
  try {
    hash = sha256Hex(canonical(file));
  } catch (err) {
    throw unreadable(err.message);
  }
  if (file.credentials.length === 0) return { configured: false, epoch: file.epoch };
  return { configured: true, epoch: file.epoch, credentials: file.credentials, sha256: hash };
}

export function readAnchor(path = anchorPath()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { configured: false, epoch: 0 };
    throw new OperatorProofError(REASONS.anchor_unreadable, `operator anchor ${path}: ${err?.message}`);
  }
  let file;
  try {
    file = JSON.parse(stripBom(text));
  } catch (err) {
    throw new OperatorProofError(REASONS.anchor_unreadable, `operator anchor ${path}: ${err.message}`);
  }
  return anchorFromFile(file);
}

// --- Verifiers ----------------------------------------------------------------
// Every field of a proof, a registration and a co-sign is untrusted: a bad one is
// refused with a stable reason and never throws. Only programmer errors throw (a
// non-anchor object, a missing server-side expectation).

export function isFresh(signedAt, now = Date.now()) {
  const at = isStr(signedAt) ? Date.parse(signedAt) : Number.NaN;
  return now - at <= FRESH_PAST_MS && at - now <= FRESH_FUTURE_MS;
}

// Base64url without padding, strictly: text that does not re-encode to itself is malformed.
function fromB64url(text) {
  if (!isStr(text) || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

function jsonObject(text) {
  try {
    const value = JSON.parse(text);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

// The SPKI DER of a P-256 key, or null when it does not parse as one.
function es256Spki(spki) {
  const der = fromB64url(spki);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? der : null;
  } catch {
    return null;
  }
}

function requireAnchor(anchor) {
  if (!isObj(anchor) || typeof anchor.configured !== 'boolean') throw new TypeError('anchor object required');
}

const ASSERTION_FIELDS = ['credentialId', 'statement', 'authenticatorData', 'clientDataJSON', 'signature'];

// Absence first, then the version, then the fields. A co-sign carries no v; when
// it does, it must be 1.
function parseAssertion(proof, versioned) {
  if (proof === null || proof === undefined) return { reason: REASONS.proof_absent };
  if (isObj(proof) && proof.v !== 1 && (versioned || proof.v !== undefined)) return { reason: REASONS.unsupported_version };
  if (!isObj(proof) || !ASSERTION_FIELDS.every((field) => isStr(proof[field]))) return { reason: REASONS.malformed_proof };
  const authData = fromB64url(proof.authenticatorData);
  const clientBytes = fromB64url(proof.clientDataJSON);
  const signature = fromB64url(proof.signature);
  const client = clientBytes && jsonObject(clientBytes.toString('utf8'));
  const statement = jsonObject(proof.statement);
  if (!authData || !client || !signature || !statement || !fromB64url(proof.credentialId)) return { reason: REASONS.malformed_proof };
  if (!isStr(statement.signedAt) || Number.isNaN(Date.parse(statement.signedAt))) return { reason: REASONS.bad_timestamp };
  return { reason: null, text: proof.statement, statement, authData, clientBytes, client, signature };
}

// The WebAuthn assertion checks, in their fixed order. The statement's own origin
// must be the credential's as well as clientData's.
function assertionReason({ text, statement, authData, clientBytes, client, signature }, credential) {
  if (authData.length < 37) return REASONS.bad_authenticator_data;
  if (client.type !== 'webauthn.get') return REASONS.type_mismatch;
  if (client.challenge !== challengeFor(text).toString('base64url')) return REASONS.challenge_mismatch;
  if (client.origin !== credential.origin || statement.origin !== credential.origin) return REASONS.origin_mismatch;
  if (client.crossOrigin === true) return REASONS.cross_origin;
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(credential.rpId, 'utf8')))) return REASONS.rp_mismatch;
  if (credential.alg !== ES256) return REASONS.alg_unsupported;
  if (!(authData[32] & FLAG_UP)) return REASONS.up_required;
  if (!(authData[32] & FLAG_UV)) return REASONS.uv_required;
  const key = es256Spki(credential.publicKeySpki);
  if (!key) return REASONS.bad_key;
  const signed = Buffer.concat([authData, sha256(clientBytes)]);
  try {
    return verifySignature('sha256', signed, { key, format: 'der', type: 'spki', dsaEncoding: 'der' }, signature) ? null : REASONS.bad_signature;
  } catch {
    return REASONS.bad_signature;
  }
}

function verdict(anchor, reason, credential = null, authData = null) {
  const flags = authData && authData.length >= 37 ? authData[32] : null;
  return {
    ok: reason === null, mode: reason === null ? 'verified' : 'refused', reason,
    credentialId: credential ? credential.credentialId : null, anchorSha256: anchor.sha256 ?? null, epoch: anchor.epoch ?? null,
    be: flags === null ? null : (flags & FLAG_BE) !== 0, bs: flags === null ? null : (flags & FLAG_BS) !== 0,
  };
}

const unconfigured = (anchor) => ({
  ok: true, mode: 'unconfigured', reason: null, credentialId: null, anchorSha256: null, epoch: anchor.epoch ?? 0, be: null, bs: null,
});

const credentialFor = (anchor, credentialId) => (Array.isArray(anchor.credentials) ? anchor.credentials : [])
  .find((credential) => isObj(credential) && credential.credentialId === credentialId);

// Did a registered credential sign this answer to this ask? ask === undefined
// means the caller's row has no ask at all; ask === null is a legacy prose ask.
export function verifyAnswerProof({ answer, question, ask, questId, askReceiptId, anchor } = {}) {
  requireAnchor(anchor);
  if (!anchor.configured) return unconfigured(anchor);
  if (ask === undefined) return verdict(anchor, REASONS.ask_missing);
  const proof = isObj(answer) ? answer.proof : undefined;
  const parsed = parseAssertion(proof, true);
  if (parsed.reason) return verdict(anchor, parsed.reason);
  const credential = credentialFor(anchor, proof.credentialId);
  if (!credential) return verdict(anchor, REASONS.unknown_credential);
  const { statement } = parsed;
  const rebuilt = answerStatement({
    origin: statement.origin, questId, askReceiptId: statement.askReceiptId, question, ask,
    key: answer.key, text: answer.text, signedAt: statement.signedAt,
  });
  if (rebuilt === null) return verdict(anchor, REASONS.malformed_proof, credential);
  // The ask id must agree with the caller's expectation and with the answer's own
  // askReceiptId; only the caller's is sourced independently of the stored answer.
  const storedReceiptId = answer.askReceiptId ?? null;
  if (rebuilt !== parsed.text || (askReceiptId !== undefined && statement.askReceiptId !== askReceiptId)
    || (storedReceiptId !== null && statement.askReceiptId !== storedReceiptId)) {
    return verdict(anchor, REASONS.statement_mismatch, credential);
  }
  return verdict(anchor, assertionReason(parsed, credential), credential, parsed.authData);
}

const COSE_TRUNCATED = Symbol('truncated');

// The attested COSE_Key, read with a bounded CBOR reader that knows one form: a
// definite map of exactly {1: 2 (EC2), 3: alg, -1: 1 (P-256), -2: x, -3: y}, with x
// and y 32-byte byte strings. Running out of bytes is COSE_TRUNCATED; any other
// form is null.
function coseEc2Key(bytes, start) {
  let at = start;
  // One CBOR head: the major type and an argument held inline or in one more byte.
  const head = () => {
    if (at >= bytes.length) return COSE_TRUNCATED;
    const major = bytes[at] >> 5;
    const info = bytes[at] & 0x1f;
    at += 1;
    if (info < 24) return { major, value: info };
    if (info !== 24) return null;
    if (at >= bytes.length) return COSE_TRUNCATED;
    at += 1;
    return { major, value: bytes[at - 1] };
  };
  const int = (item) => (item.major === 0 ? item.value : item.major === 1 ? -1 - item.value : null);
  const map = head();
  if (map === COSE_TRUNCATED || map === null) return map;
  if (map.major !== 5 || map.value !== 5) return null;
  const entries = new Map();
  for (let i = 0; i < 5; i += 1) {
    const keyItem = head();
    if (keyItem === COSE_TRUNCATED || keyItem === null) return keyItem;
    const key = int(keyItem);
    if (key === null || entries.has(key)) return null;
    const valueItem = head();
    if (valueItem === COSE_TRUNCATED || valueItem === null) return valueItem;
    if (valueItem.major === 2) {
      if (at + valueItem.value > bytes.length) return COSE_TRUNCATED;
      entries.set(key, bytes.subarray(at, at + valueItem.value));
      at += valueItem.value;
    } else if (int(valueItem) !== null) {
      entries.set(key, int(valueItem));
    } else {
      return null;
    }
  }
  const [x, y] = [entries.get(-2), entries.get(-3)];
  if (entries.get(1) !== 2 || entries.get(-1) !== 1 || !Number.isInteger(entries.get(3))
    || !Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) return null;
  return { alg: entries.get(3), x, y };
}

// A create() response checked against the origin and rpId the SERVER expects. It
// shows the bytes are well formed and that the supplied SPKI is the attested key;
// it cannot show that a phone made the key.
export function verifyRegistration({
  clientDataJSON, authenticatorData, credentialId, publicKeySpki, alg, label, expectedOrigin, expectedRpId, signedAt, now = Date.now(),
} = {}) {
  if (!isStr(expectedOrigin) || !isStr(expectedRpId)) throw new TypeError('expectedOrigin and expectedRpId are required, from the server');
  const refuse = (reason) => ({ ok: false, mode: 'refused', reason, credential: null });
  const authData = fromB64url(authenticatorData);
  const clientBytes = fromB64url(clientDataJSON);
  const client = clientBytes && jsonObject(clientBytes.toString('utf8'));
  const id = fromB64url(credentialId);
  if (!authData || !client || !id || !isStr(label) || label === '') return refuse(REASONS.malformed_proof);
  if (!isStr(signedAt) || Number.isNaN(Date.parse(signedAt))) return refuse(REASONS.bad_timestamp);
  if (authData.length < 37) return refuse(REASONS.bad_authenticator_data);
  if (client.type !== 'webauthn.create') return refuse(REASONS.type_mismatch);
  if (client.challenge !== challengeFor(registerBeginStatement({ origin: expectedOrigin, signedAt })).toString('base64url')) return refuse(REASONS.challenge_mismatch);
  if (client.origin !== expectedOrigin) return refuse(REASONS.origin_mismatch);
  if (client.crossOrigin === true) return refuse(REASONS.cross_origin);
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(expectedRpId, 'utf8')))) return refuse(REASONS.rp_mismatch);
  const flags = authData[32];
  if (!(flags & FLAG_UP)) return refuse(REASONS.up_required);
  if (!(flags & FLAG_UV)) return refuse(REASONS.uv_required);
  // Attested credential data: AAGUID at 37, a 2-byte id length at 53, the id at 55,
  // then the COSE_Key.
  if (!(flags & FLAG_AT) || authData.length < 55 || authData.length < 55 + authData.readUInt16BE(53)) return refuse(REASONS.bad_authenticator_data);
  const idEnd = 55 + authData.readUInt16BE(53);
  if (!authData.subarray(55, idEnd).equals(id)) return refuse(REASONS.credential_id_mismatch);
  const cose = coseEc2Key(authData, idEnd);
  if (cose === COSE_TRUNCATED) return refuse(REASONS.malformed_proof);
  if (cose === null) return refuse(REASONS.bad_key);
  if (alg !== ES256) return refuse(REASONS.alg_unsupported);
  const spki = es256Spki(publicKeySpki);
  if (!spki) return refuse(REASONS.bad_key);
  let attested;
  try {
    attested = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: cose.x.toString('base64url'), y: cose.y.toString('base64url') }, format: 'jwk' });
  } catch {
    return refuse(REASONS.bad_key);
  }
  if (cose.alg !== ES256 || !attested.equals(createPublicKey({ key: spki, format: 'der', type: 'spki' }))) return refuse(REASONS.key_mismatch);
  if (!isFresh(signedAt, now)) return refuse(REASONS.proof_stale);
  return {
    ok: true, mode: 'verified', reason: null,
    credential: {
      credentialId, publicKeySpki, alg: ES256, rpId: expectedRpId, origin: expectedOrigin,
      registeredAt: new Date(now).toISOString(), label, be: (flags & FLAG_BE) !== 0, bs: (flags & FLAG_BS) !== 0,
    },
  };
}

// A registered credential signed registerCosignStatement for exactly the expected
// new credential and origin, recently. An unconfigured anchor has nobody to
// co-sign, so it is refused (cosign_unconfigured), not passed.
export function verifyCosign({ anchor, cosign, expect, now = Date.now() } = {}) {
  requireAnchor(anchor);
  if (!isObj(expect) || !isStr(expect.credentialId) || !isStr(expect.publicKeySpki) || !isStr(expect.origin)) {
    throw new TypeError('expect {credentialId, publicKeySpki, origin} required');
  }
  if (!anchor.configured) return verdict(anchor, REASONS.cosign_unconfigured);
  const parsed = parseAssertion(cosign, false);
  if (parsed.reason) return verdict(anchor, parsed.reason);
  const credential = credentialFor(anchor, cosign.credentialId);
  if (!credential) return verdict(anchor, REASONS.unknown_credential);
  const { statement } = parsed;
  const rebuilt = registerCosignStatement({
    credentialId: statement.credentialId, publicKeySpki: statement.publicKeySpki, origin: statement.origin, signedAt: statement.signedAt,
  });
  if (rebuilt === null) return verdict(anchor, REASONS.malformed_proof, credential);
  if (rebuilt !== parsed.text) return verdict(anchor, REASONS.statement_mismatch, credential);
  if (statement.credentialId !== expect.credentialId || statement.publicKeySpki !== expect.publicKeySpki || statement.origin !== expect.origin) {
    return verdict(anchor, REASONS.cosign_mismatch, credential);
  }
  if (!isFresh(statement.signedAt, now)) return verdict(anchor, REASONS.proof_stale, credential);
  return verdict(anchor, assertionReason(parsed, credential), credential, parsed.authData);
}

// --- Grant and raise tags ------------------------------------------------------
// The operator signs the words of a grant and a short tag over its JSON: option
// key's consequence is exactly renderGrant(grant) + ' [grant ' + grantTag(grant) + ']'.

const GRANT_KEYS = 'budgetUsd,merge,notAfter,release,releaseRecipeSha256,repo,runId,scopeSha256';
const RAISE_KEYS = 'haltSpendUsd,kind,runId,touch';
const sameKeys = (value, keys) => Object.keys(value).sort().join(',') === keys;
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isGrant(grant) {
  return isObj(grant) && sameKeys(grant, GRANT_KEYS)
    && isAmount(grant.budgetUsd) && typeof grant.merge === 'boolean' && typeof grant.release === 'boolean'
    && isStr(grant.scopeSha256) && HEX64.test(grant.scopeSha256) && isStr(grant.runId)
    && isObj(grant.repo) && sameKeys(grant.repo, 'defaultBranch,remote') && isStr(grant.repo.remote) && isStr(grant.repo.defaultBranch)
    && (grant.releaseRecipeSha256 === null || (isStr(grant.releaseRecipeSha256) && HEX64.test(grant.releaseRecipeSha256)))
    && isStr(grant.notAfter) && !Number.isNaN(Date.parse(grant.notAfter));
}

function isRaise(raise) {
  return isObj(raise) && sameKeys(raise, RAISE_KEYS) && raise.kind === 'budget-raise'
    && isStr(raise.runId) && Number.isInteger(raise.touch) && raise.touch >= 1 && isAmount(raise.haltSpendUsd);
}

const yesNo = (flag) => (flag ? 'yes' : 'no');

export function renderGrant(grant) {
  if (!isGrant(grant)) return null;
  const until = new Date(Date.parse(grant.notAfter)).toISOString().slice(0, 10);
  return `Merge each PR to ${grant.repo.remote} (${grant.repo.defaultBranch}): ${yesNo(grant.merge)}, release: ${yesNo(grant.release)}, budget $${grant.budgetUsd}, valid until ${until}.`;
}

export function grantTag(grant) {
  return isGrant(grant) ? sha256Hex(canonical(grant)).slice(0, 16) : null;
}

export function renderRaise(raise) {
  if (!isRaise(raise)) return null;
  return `Raise the budget for run ${raise.runId} at halt spend $${raise.haltSpendUsd} (type the new USD).`;
}

export function raiseTag(raise) {
  return isRaise(raise) ? sha256Hex(canonical(raise)).slice(0, 16) : null;
}

// askLike is an ask or {options}; the unconfigured fallbacks wrap touch.options.
function consequenceFor(askLike, key) {
  if (!isObj(askLike) || !Array.isArray(askLike.options) || !isStr(key)) return null;
  const option = askLike.options.find((candidate) => isObj(candidate) && candidate.key === key);
  return option && isStr(option.consequence) ? option.consequence : null;
}

export function grantTagFor(askLike, key) {
  const consequence = consequenceFor(askLike, key);
  const match = consequence === null ? null : / \[grant ([0-9a-f]{16})\]$/.exec(consequence);
  return match ? match[1] : null;
}

export function checkGrant(grant, askLike, key) {
  const consequence = consequenceFor(askLike, key);
  const rendered = renderGrant(grant);
  if (consequence === null || rendered === null) return false;
  return nfc(consequence) === nfc(`${rendered} [grant ${grantTag(grant)}]`);
}

export function checkRaise(raise, askLike, key = 'a') {
  const consequence = consequenceFor(askLike, key);
  const rendered = renderRaise(raise);
  if (consequence === null || rendered === null) return false;
  return nfc(consequence) === nfc(`${rendered} [raise ${raiseTag(raise)}]`);
}

// --- CLI commands, in process --------------------------------------------------
// Each returns the CLI's line, {ok, mode, reason, credentialId, epoch, grant, answer, scopeOk?}.
// The CLI passes readAnchor() and Date.now(); nothing on its argv or environment
// can replace either.

// conduct's run correlation in a filed question: `<tag> (run <runId>/<filing>)`.
const RUN_ID = /\(run ([^/\s)]+)\//;

const refusal = (anchor, reason) => ({
  ok: false, mode: 'refused', reason, credentialId: null, epoch: anchor.epoch ?? null, grant: null, answer: null,
});

const answerFields = (answer) => (isObj(answer) ? { key: answer.key ?? null, text: answer.text ?? null } : null);

// grant is printed only when its tag checks against the signed ask (or, when
// unconfigured, the record's options). Configured, it must also be unexpired and
// for the run the signed question names. answer is the {key, text} the proof was
// checked against, null on a refusal. scopeOk compares the NFC hash of the scope
// text with the grant's scopeSha256.
function withGrant(result, { anchor, grants, askLike, key, question, now, scopeText, answer }) {
  const out = {
    ok: result.ok, mode: result.mode, reason: result.reason, credentialId: result.credentialId, epoch: result.epoch, grant: null, answer: null,
  };
  if (!out.ok) return out;
  out.answer = answer;
  const refuse = (reason) => {
    out.reason = reason;
    if (anchor.configured) Object.assign(out, { ok: false, mode: 'refused', answer: null });
  };
  const candidate = isObj(grants) && isStr(key) && Object.hasOwn(grants, key) ? grants[key] : undefined;
  if (candidate !== undefined) {
    if (!checkGrant(candidate, askLike, key)) refuse(REASONS.grant_tag_mismatch);
    else if (anchor.configured && now > Date.parse(candidate.notAfter)) refuse(REASONS.grant_expired);
    else if (anchor.configured && (isStr(question) ? RUN_ID.exec(question)?.[1] : undefined) !== candidate.runId) refuse(REASONS.wrong_run);
    else out.grant = candidate;
  }
  if (scopeText !== undefined) {
    out.scopeOk = out.grant !== null && isStr(scopeText) && sha256Hex(nfc(scopeText)) === out.grant.scopeSha256;
  }
  return out;
}

// conduct writes goal.md as `${goal}\n`; the grant hashes the goal itself.
const goalScope = (goalText) => (isStr(goalText) ? goalText.replace(/\n$/, '') : goalText);

// body is the spine_quest tool's JSON ({quests:[{id, latestReceipt}]}) or a bare
// receipt row ({id, outcome, question, ask, answer}). state is conduct's state.json,
// whose touch for this receipt supplies the grants.
export function verifyReceiptBody({ body, quest, state, goalText, anchor, now = Date.now() } = {}) {
  requireAnchor(anchor);
  const fullQuest = isStr(quest) && UUID.test(quest);
  let receipt;
  let questId = quest;
  if (isObj(body) && Array.isArray(body.quests)) {
    if (!fullQuest) return refusal(anchor, REASONS.quest_id_not_full);
    const entry = body.quests.find((candidate) => isObj(candidate) && isStr(candidate.id) && candidate.id !== '' && quest.toLowerCase().startsWith(candidate.id.toLowerCase()));
    if (!entry) return refusal(anchor, REASONS.input_unreadable);
    if (!UUID.test(entry.id)) return refusal(anchor, REASONS.quest_id_not_full);
    questId = entry.id;
    receipt = entry.latestReceipt;
  } else if (isObj(body) && Object.hasOwn(body, 'outcome')) {
    if (!fullQuest) return refusal(anchor, REASONS.quest_id_not_full);
    receipt = body;
  } else {
    return refusal(anchor, REASONS.input_unreadable);
  }
  if (!isObj(receipt) || receipt.outcome !== 'answered') return refusal(anchor, REASONS.not_answered);
  const answer = isObj(receipt.answer) ? receipt.answer : null;
  let touch;
  if (state !== undefined) {
    const touches = isObj(state) && Array.isArray(state.touches) ? state.touches.filter(isObj) : [];
    const prefix = (candidate) => (isStr(state.runId) ? `${candidate.tag} (run ${state.runId}/` : `${candidate.tag} `);
    touch = (isStr(answer?.askReceiptId) ? touches.find((candidate) => candidate.receiptId === answer.askReceiptId) : undefined)
      ?? (isStr(receipt.question) ? touches.find((candidate) => isStr(candidate.tag) && receipt.question.startsWith(prefix(candidate))) : undefined);
  }
  const result = verifyAnswerProof({
    answer, question: receipt.question, ask: receipt.ask, questId,
    askReceiptId: isStr(touch?.receiptId) ? touch.receiptId : undefined, anchor,
  });
  const askLike = !anchor.configured && Array.isArray(touch?.options) ? { options: touch.options } : receipt.ask;
  return withGrant(result, {
    anchor, grants: touch?.grants, askLike, key: answer?.key, question: receipt.question, now, scopeText: goalScope(goalText),
    answer: answerFields(answer),
  });
}

// The record's own answer must be the signed one. The one sanctioned difference
// is conduct's: an operator's typed answer with no key is recorded as option (c).
function recordedIsSigned(recorded, signed) {
  if (!isObj(signed)) return false;
  const [key, text] = [recorded.key ?? null, recorded.text ?? null];
  const [signedKey, signedText] = [signed.key ?? null, signed.text ?? null];
  if (text !== signedText) return false;
  return key === signedKey || (signedKey === null && key === 'c' && isStr(signedText) && signedText.trim() !== '');
}

// record is a conduct touch record (touches/<n>.json) or an authority record
// (touches/<n>-authority.json). The signed block is always answer.signed; an
// authority record with a confirm block is verified through the confirm, and its
// scopeOk comes from the record's own scope, not the goal. The holder's receiptId
// (the touch's filed ask) is the expected askReceiptId.
export function verifyRecord({ record, quest, goalText, anchor, now = Date.now() } = {}) {
  requireAnchor(anchor);
  if (!isObj(record)) return refusal(anchor, REASONS.input_unreadable);
  let questId;
  if (quest === 'none') {
    // A core-only record has no anchor quest: valid only while nothing is signed.
    if (anchor.configured) return refusal(anchor, REASONS.quest_id_not_full);
  } else if (!isStr(quest) || !UUID.test(quest)) {
    return refusal(anchor, REASONS.quest_id_not_full);
  } else {
    questId = quest;
  }
  const confirm = isObj(record.confirm) ? record.confirm : null;
  const holder = confirm ?? record;
  const recorded = isObj(holder.answer) ? holder.answer : {};
  const signed = isObj(recorded.signed) ? recorded.signed : null;
  if (anchor.configured && !signed) return refusal(anchor, REASONS.proof_absent);
  const result = verifyAnswerProof({
    answer: signed?.answer, question: signed?.question, ask: signed ? signed.ask : null, questId,
    askReceiptId: isStr(holder.receiptId) ? holder.receiptId : undefined, anchor,
  });
  if (result.ok && signed && !recordedIsSigned(recorded, signed.answer)) return refusal(anchor, REASONS.record_answer_mismatch);
  const key = isObj(signed?.answer) ? signed.answer.key : recorded.key;
  const askLike = !anchor.configured && Array.isArray(holder.options) ? { options: holder.options } : signed?.ask;
  return withGrant(result, {
    anchor, grants: holder.grants, askLike, key, question: signed?.question, now,
    scopeText: confirm ? (isStr(record.scope) ? record.scope : null) : goalScope(goalText),
    answer: signed ? answerFields(signed.answer) : null,
  });
}

// --- CLI -----------------------------------------------------------------------

const USAGE = [
  'usage: node operator-proof.mjs verify-receipt --file <f> --quest <full uuid> [--state <state.json>] [--goal <file>]',
  '       node operator-proof.mjs verify-record --file <f> --quest <id|none> [--goal <file>]',
].join('\n');

function readInput(path, json) {
  let text;
  try {
    text = stripBom(readFileSync(path, 'utf8'));
    return json ? JSON.parse(text) : text;
  } catch (err) {
    throw new OperatorProofError(REASONS.input_unreadable, `${path}: ${err.message}`);
  }
}

const optional = (path, json) => (path === undefined ? undefined : readInput(path, json));

const COMMANDS = {
  'verify-receipt': {
    flags: ['--file', '--quest', '--state', '--goal'],
    run: (flags, anchor) => verifyReceiptBody({
      body: readInput(flags['--file'], true), quest: flags['--quest'], state: optional(flags['--state'], true),
      goalText: optional(flags['--goal'], false), anchor,
    }),
  },
  'verify-record': {
    flags: ['--file', '--quest', '--goal'],
    run: (flags, anchor) => verifyRecord({
      record: readInput(flags['--file'], true), quest: flags['--quest'], goalText: optional(flags['--goal'], false), anchor,
    }),
  },
};

function parseFlags(argv, allowed) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (!allowed.includes(name) || value === undefined || Object.hasOwn(flags, name)) return null;
    flags[name] = value;
  }
  return flags['--file'] !== undefined && flags['--quest'] !== undefined ? flags : null;
}

function main(argv) {
  const command = Object.hasOwn(COMMANDS, argv[0]) ? COMMANDS[argv[0]] : null;
  const flags = command && parseFlags(argv.slice(1), command.flags);
  if (!flags) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  let out;
  try {
    out = command.run(flags, readAnchor());
  } catch (err) {
    if (!(err instanceof OperatorProofError)) throw err;
    out = { ok: false, mode: 'refused', reason: err.code, credentialId: null, epoch: null, grant: null, answer: null };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  // exitCode, never process.exit(): exiting after I/O truncates piped output.
  process.exitCode = out.ok === true ? 0 : 1;
}

// Only when run as a script: importing this module never prints or exits. Under
// node -e, argv[1] is undefined, so it is checked before pathToFileURL sees it.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2));
}
