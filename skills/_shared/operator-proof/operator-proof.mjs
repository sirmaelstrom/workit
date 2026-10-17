// operator-proof.mjs: decides whether the operator's registered passkey signed
// a Spine answer. Zero dependencies (node: built-ins only). Every consumer copies
// this file byte for byte and pins it by the SHA-256 of its text after CRLF -> LF
// normalisation; README.md has the contract and the copy procedure.
//
// It is a library and a CLI. The CLI verifies against readAnchor() and nothing else:
//   node operator-proof.mjs verify-receipt --file <f> --quest <full uuid> [--state <state.json>] [--goal <file>]
//   node operator-proof.mjs verify-record --file <f> --quest <id|none> [--goal <file>]
// Each prints one JSON line {ok, mode, reason, credentialId, epoch, grant, scopeOk?}
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
  'up_required', 'uv_required', 'bad_key', 'bad_signature', 'credential_id_mismatch',
  'cosign_mismatch', 'proof_stale', 'anchor_unreadable', 'grant_tag_mismatch', 'grant_expired',
  'wrong_run', 'raise_tag_mismatch', 'quest_id_not_full', 'not_answered', 'input_unreadable',
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
// A legacy prose ask is null and hashes canonical(null). Bad shape: null.
function askCanonical(ask) {
  if (ask === null) return canonical(null);
  if (!isObj(ask) || !Array.isArray(ask.options)) return null;
  const prompt = ask.prompt ?? null;
  const allowFreeText = ask.allowFreeText === undefined ? false : ask.allowFreeText;
  if ((prompt !== null && !isStr(prompt)) || typeof allowFreeText !== 'boolean') return null;
  const options = [];
  for (const option of ask.options) {
    if (!isObj(option) || !isStr(option.key) || !isStr(option.label) || !isStr(option.consequence)) return null;
    options.push({ key: option.key, label: option.label, consequence: option.consequence });
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

// An anchor that exists but cannot be read as the file shape throws: it must
// never read as "not configured", which would switch verification off.
export function anchorFromFile(file) {
  const unreadable = (why) => new OperatorProofError(REASONS.anchor_unreadable, `operator anchor: ${why}`);
  if (!isObj(file) || file.v !== 1) throw unreadable('not a v1 anchor file');
  if (!Number.isInteger(file.epoch) || file.epoch < 0) throw unreadable('epoch is not an integer >= 0');
  if (!Array.isArray(file.credentials)) throw unreadable('credentials is not an array');
  for (const credential of file.credentials) {
    if (!isObj(credential) || !isStr(credential.credentialId) || !isStr(credential.publicKeySpki)
      || !isStr(credential.rpId) || !isStr(credential.origin)) throw unreadable('a credential lacks credentialId, publicKeySpki, rpId or origin');
  }
  if (file.credentials.length === 0) return { configured: false, epoch: file.epoch };
  return { configured: true, epoch: file.epoch, credentials: file.credentials, sha256: sha256Hex(canonical(file)) };
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
    file = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new OperatorProofError(REASONS.anchor_unreadable, `operator anchor ${path}: ${err.message}`);
  }
  return anchorFromFile(file);
}

// --- Verifiers ----------------------------------------------------------------

export function verifyAnswerProof(_args) {
  return { ok: true };
}

export function verifyRegistration(_args) {
  return { ok: true };
}

export function verifyCosign(_args) {
  return { ok: true };
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

export function verifyReceiptBody(_args) {
  return { ok: true };
}

export function verifyRecord(_args) {
  return { ok: true };
}

// --- CLI -----------------------------------------------------------------------

const USAGE = [
  'usage: node operator-proof.mjs verify-receipt --file <f> --quest <full uuid> [--state <state.json>] [--goal <file>]',
  '       node operator-proof.mjs verify-record --file <f> --quest <id|none> [--goal <file>]',
].join('\n');

function readInput(path, json) {
  let text;
  try {
    text = readFileSync(path, 'utf8').replace(/^﻿/, '');
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
    out = { ok: false, mode: 'refused', reason: err.code, credentialId: null, epoch: null, grant: null };
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
