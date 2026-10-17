# operator-proof

`operator-proof.mjs` decides whether the operator's registered passkey signed a Spine answer. It has no dependencies beyond `node:` built-ins, and it is both a library and a CLI.

This directory is the source of truth. Other repos copy `operator-proof.mjs` byte for byte and pin the copy with `operator-proof.sha256`. Changing the module means changing every copy in the same run.

| File | What it is |
|---|---|
| `operator-proof.mjs` | The verifier, the statement builders, the grant and raise tags, `readAnchor`, and the CLI. |
| `operator-proof.sha256` | The hex SHA-256 of the module's text after `\r\n` → `\n`. |
| `operator-proof.vectors.json` | The shared vectors. Every copy runs them. |
| `test-signer.mjs` | A software authenticator over two fixed P-256 test keys. Tests only: the module never imports it. |
| `make-vectors.mjs` | Writes the vectors with the test signer. |
| `operator-proof.test.mjs` | Runs the vectors, the pin, and the CLI under a temp home. |

## What is signed

The challenge is `SHA-256(statement)`, where the statement is canonical JSON: sorted keys, no whitespace, NFC strings, absent optional fields as `null`.

- **Answer:** `{v:1, origin, questId, askReceiptId, questionSha256, askSha256, key, label, text, signedAt}`. `label` comes from the ask's option for `key`, never from the caller. `text` is trimmed, then NFC, then `null` when empty. `askSha256` covers `{allowFreeText, prompt, options:[{key, label, consequence}]}` with the options in key order, so editing any option's consequence breaks the signature. A legacy prose ask (`null`) hashes the string `null`.
- **Registration begin:** `{v:1, op:'register-begin', origin, signedAt}`, the challenge for `create()`.
- **Co-sign:** `{v:1, op:'register', credentialId, publicKeySpki, origin, signedAt}`, signed by a registered credential to admit a new one.

`answer.proof` is `{v:1, credentialId, statement, authenticatorData, clientDataJSON, signature}`. `statement` is the exact signed string; the other fields are base64url without padding.

**Canonicalisation order**, which a port (the Dogan's browser copy) must reproduce:

- NFC applies to string **values**. Object keys are not normalised: every key in a statement or an ask hash is a fixed ASCII field name, so they are ASCII by construction.
- An ask's options are NFC-normalised by `key` first, then sorted by that NFC key. Two options with the same NFC key make the ask unhashable: `askSha256` returns `null`, and a verifier refuses with `malformed_proof`.
- The answer's `text` is trimmed, then NFC, then `null` when empty.

**The registration challenge carries no nonce.** `registerBeginStatement` is `{origin, signedAt}`, so its challenge is predictable. That is acceptable only because registration custody does not come from these bytes: it comes from the operator-present ceremony (WP-10). `verifyRegistration` checks that the response is well formed and internally consistent, not that it is fresh from a phone.

## The anchor

The anchor is read only from `join(os.homedir(), '.claude', 'operator-passkeys.json')`. The module reads no environment variable of its own, and no flag or config key names another path or turns verification off. `os.homedir()` itself follows the process environment (`HOME`, `USERPROFILE`), so the anchor path trusts the caller's environment: a process that can set those variables for the verifier can point it at another file. That is a same-user process, which the threat model's A1 already covers; it is also how tests run the process under a temp home. Tests in process inject an anchor object as an argument instead.

- **File shape (on disk):** `{v:1, epoch, credentials:[{credentialId, publicKeySpki, alg:-7, rpId, origin, registeredAt, label, be, bs}]}`. Every credential field is checked for its type (`alg` an integer, `be`/`bs` booleans, the rest strings), and the file must canonicalise; a number such as `1e400`, which parses as `Infinity`, makes it unreadable.
- **Anchor object (what verifiers take):** `{configured, epoch, credentials, sha256}`. `anchorFromFile(file)` converts one to the other; `sha256` is SHA-256 of `canonical(file)`.

A missing file, or one with zero credentials, is **unconfigured**: every verifier returns `{ok:true, mode:'unconfigured'}` and callers behave as they did before passkeys. A file that exists but cannot be read as the file shape throws `anchor_unreadable`; it never reads as unconfigured. Passing a file-shape object where an anchor object belongs throws `TypeError('anchor object required')`.

## Verifying

`verifyAnswerProof({answer, question, ask, questId, askReceiptId?, anchor})` returns `{ok, mode, reason, credentialId, anchorSha256, epoch, be, bs}`. Against a configured anchor it refuses, in this order: `ask_missing`; the proof's absence, version and shape (`proof_absent`, `unsupported_version`, `malformed_proof`, `bad_timestamp`); `unknown_credential`; `statement_mismatch`; then the WebAuthn checks (`bad_authenticator_data`, `type_mismatch`, `challenge_mismatch`, `origin_mismatch`, `cross_origin`, `rp_mismatch`, `alg_unsupported`, `up_required`, `uv_required`, `bad_key`, `bad_signature`). The signature is ES256 over `authenticatorData ‖ SHA-256(clientDataJSON)`.

**Ask binding.** `statement_mismatch` also covers the ask id. When `answer.askReceiptId` is present it must equal the signed statement's `askReceiptId`, and when the caller passes `askReceiptId` the statement must name it too. Only the caller's value stops a replay: `answer.askReceiptId` is stored beside the proof, so whoever can swap the proof can swap it as well. The independently sourced expected id belongs to the consumer, which knows which ask it filed. WP-06 and WP-07 pass `touch.receiptId`. `verify-receipt --state` takes it from the matched touch, and `verify-record` takes it from the record's own `receiptId`.

`verifyRegistration` checks a `create()` response against the origin and rpId the **server** supplies. The browser supplies the SPKI (`getPublicKey()`). The attested COSE_Key in `authenticatorData` must also be an EC2 P-256 key, in the one map form with integer keys `{1:2, 3:-7, -1:1, -2:x, -3:y}`, where x and y are 32-byte strings, and its point and alg must equal the SPKI's: `key_mismatch` otherwise. Any other COSE form is `bad_key`. Attested data that ends early is `malformed_proof`. The check shows that the bytes are well formed and consistent with each other. It does not show that a phone made the key.

`verifyCosign` checks that a co-sign names exactly the expected credential and origin, and that it is fresh (15 minutes back, 2 minutes ahead). Against an unconfigured anchor it returns `{ok:false, mode:'refused', reason:'cosign_unconfigured'}`, because nobody is registered who could co-sign.

Untrusted input never throws. Every refusal is a code in `REASONS`; compare codes, never message text.

## Grants

A granting option's consequence is exactly `renderGrant(grant) + ' [grant ' + grantTag(grant) + ']'`, where the tag is the first 16 hex digits of SHA-256(`canonical(grant)`). The consequence is inside `askSha256`, so the signature binds both the words and the tag. `checkGrant(grant, askLike, key)` enforces the equality; budget raises use `renderRaise`, `raiseTag` and `checkRaise` the same way. `GRANT_TTL_DAYS` is 14.

## CLI

```
node operator-proof.mjs verify-receipt --file <f> --quest <full uuid> [--state <state.json>] [--goal <file>]
node operator-proof.mjs verify-record --file <f> --quest <id|none> [--goal <file>]
```

Each prints one JSON line `{ok, mode, reason, credentialId, epoch, grant, answer, scopeOk?}`. It exits 0 only on `ok`, and bad usage exits 2. Importing the module never runs the CLI.

- `verify-receipt` takes a `spine_quest` body or a bare receipt row.
- `verify-record` takes a conduct touch record or an authority record, and verifies its `answer.signed` block (the confirm's, when there is one). The record's own `answer` must agree with `answer.signed.answer` on `key` and `text`. The one allowed difference is conduct's keyless→(c) mapping: a signed `null` key may be recorded as `c` when the texts are equal. Any other difference refuses with `record_answer_mismatch`.
- `answer` is the `{key, text}` the proof was checked against. For a record that is the **signed** values, so a consumer acts on what was authenticated, not on the record's copy. On a refusal it is `null`, and so it is for an unconfigured record with no signed block.

**Unconfigured mode confers no authority.** With no anchor, both commands exit 0 with `mode:'unconfigured'`. Any `grant` they print has passed only its tag check, against the record's own options, and is not checked for expiry or run. It is informational. A consumer must not treat it as authority. It falls back to its legacy checks (WP-07, WP-08), as it did before passkeys. Unconfigured mode still refuses malformed or unanswered input.

## Vectors

Each vector is `{name, kind, input, expect}`. Anchors in `input` are in file shape (`input.anchorFile`); runners convert them with `anchorFromFile`. A runner compares only the fields `expect` names, and a valid verifier vector names `mode:'verified'`.

- `node make-vectors.mjs` regenerates the file. Signatures are randomized, so the bytes change; entries it does not generate are kept.
- `node make-vectors.mjs --append <name> --flags <hex>` adds one valid answer vector signed with that authenticator flags byte, leaving every existing byte as it was.
- `node make-vectors.mjs --import <entries.json>` adds captured entries the same way. `chrome-registration` and `chrome-answer` were captured from real Chrome through a CDP virtual authenticator on `http://localhost:47613`.

## Updating the pin

After changing the module, recompute the pin and update every copy:

```
node -e "const t=require('fs').readFileSync('operator-proof.mjs','utf8').replace(/\r\n/g,'\n');console.log(require('crypto').createHash('sha256').update(t).digest('hex'))"
```
