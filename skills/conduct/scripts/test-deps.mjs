// testDeps: the deps a conduct test hands runConduct, recordTouch, acceptAnswer
// or awaitAnswer. readAnchor defaults to "no passkey configured", so no test
// reads the real operator anchor under the home directory; a test of the
// passkey path passes its own. anchor-isolation.test.mjs enforces the use.
import { createHash } from 'node:crypto';
import { anchorFromFile, canonical, grantTag, raiseTag, renderGrant, renderRaise } from '../../_shared/operator-proof/operator-proof.mjs';
import { makeTestAnchor, signAnswer } from '../../_shared/operator-proof/test-signer.mjs';

export function testDeps(overrides = {}) {
  return { readAnchor: () => ({ configured: false, epoch: 0 }), ...overrides };
}

// The configured anchor a passkey test passes as deps.readAnchor: the test key.
export const testAnchor = () => anchorFromFile(makeTestAnchor());

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

// A grant as conduct files it for this run: its id, repo and recipe digest,
// the scope's NFC hash, and an expiry 14 days after `filedAt` (ms).
export function testGrant(state, { budgetUsd, merge, release, scope = state.intent.goal, filedAt, ...over }) {
  return {
    budgetUsd, merge, release, scopeSha256: sha256Hex(scope.normalize('NFC')), runId: state.runId,
    repo: { remote: state.intent.repo.remote, defaultBranch: state.intent.repo.defaultBranch ?? 'main' },
    releaseRecipeSha256: state.intent.release == null ? null : sha256Hex(canonical(state.intent.release)),
    notAfter: new Date(filedAt + 14 * DAY_MS).toISOString(), ...over,
  };
}

export const grantConsequence = (grant) => `${renderGrant(grant)} [grant ${grantTag(grant)}]`;
export const raiseConsequence = (raise) => `${renderRaise(raise)} [raise ${raiseTag(raise)}]`;

// Appends the next touch, filed on the spine and answered with a proof the
// test key signed over exactly what it filed. `fields` lands on the touch
// (grants, raise, build, spendUsd, ...). The stored key maps a keyless typed
// answer to (c), as conduct's read-back does.
export function signedTouch(state, {
  kind = 'preapproval', options, key = 'a', text = null, body = 'synthetic question', filing = 1, allowFreeText = kind === 'preapproval',
  signer = {}, fields = {},
}) {
  const n = state.touches.length + 1;
  const tag = `[conduct ${state.slug} touch ${n}]`;
  const receiptId = `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
  const question = `${tag} (run ${state.runId}/${filing}) ${body}`;
  const ask = { options, allowFreeText };
  const proof = signAnswer({ questId: state.intent.anchor, askReceiptId: receiptId, question, ask, answerKey: key, text, ...signer });
  const answeredAt = '2026-10-04T18:00:00.000Z';
  const signedAnswer = { key, text, by: 'operator:dogan', answeredAt, askReceiptId: receiptId, proof };
  const anchor = testAnchor();
  const touch = {
    n, kind, status: 'answered', tag, wpId: null, suspendedStep: null, question: `${tag} ${body}`, options, allowFreeText, did: null,
    receiptId, file: `touches/${n}.md`, waiting: false, filings: filing, refusal: null, filed: { question, ask },
    answer: {
      key: key ?? (text ? 'c' : null), text, by: 'operator:dogan', answeredAt, source: 'spine', receiptId: null, askReceiptId: receiptId, proof,
      proofMode: 'verified', credentialId: anchor.credentials[0].credentialId, anchorSha256: anchor.sha256, epoch: anchor.epoch,
      signed: { answer: signedAnswer, question, ask },
    },
    ...fields,
  };
  state.touches.push(touch);
  return touch;
}
