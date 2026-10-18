// sitting.test.mjs: a sitting grant (one signed answer that authorizes a sitting's
// merges and deploys) verifies only when every part of it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASONS, SITTING_MAX_MS, anchorFromFile, checkSitting, parseSittingPrompt, renderSitting, sittingTag, verifySitting,
} from './operator-proof.mjs';
import { TEST_KEY_2, makeTestAnchor, nowIso, signAnswer } from './test-signer.mjs';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), 'operator-proof.mjs');
const QUEST = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const ASK_ID = '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d';
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-18T16:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const configured = () => anchorFromFile(makeTestAnchor());
const unconfigured = () => anchorFromFile({ v: 1, epoch: 0, credentials: [] });

function grantOf(over = {}) {
  return {
    v: 1, kind: 'sitting', sittingId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    filedAt: iso(NOW - HOUR), notAfter: iso(NOW + 11 * HOUR),
    repos: [{ remote: 'heathdev-me/dogan', branch: 'main' }, { remote: 'heathdev-me/observatory', branch: 'main' }],
    merge: true, deploy: ['dogan', 'observatory'], runBudgetUsd: 25, ...over,
  };
}

function askOf(grant, { consequence } = {}) {
  return {
    prompt: `Start a sitting.\n\n\`\`\`json\n${JSON.stringify(grant)}\n\`\`\``,
    allowFreeText: false,
    options: [
      { key: 'a', label: 'Approve the sitting', consequence: consequence ?? `${renderSitting(grant)} [sitting ${sittingTag(grant)}]` },
      { key: 'b', label: 'Decline', consequence: 'Nothing is authorized; each merge and deploy asks.' },
    ],
  };
}

// An answered row as Observatory's sitting route returns it.
function rowOf({ grant = grantOf(), ask, answerKey = 'a', signedAt = iso(NOW - HOUR + 60_000), key, unsigned = false, question } = {}) {
  const theAsk = ask ?? askOf(grant);
  const q = question ?? `[sitting ${grant.sittingId}] Start a sitting until ${grant.notAfter}?`;
  const proof = signAnswer({ key, questId: QUEST, askReceiptId: ASK_ID, question: q, ask: theAsk, answerKey, signedAt });
  return {
    id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', questId: QUEST, outcome: 'answered', question: q, ask: theAsk,
    answer: { key: answerKey, text: null, askReceiptId: ASK_ID, by: 'operator:dogan', ...(unsigned ? {} : { proof }) },
  };
}

const merge = { repo: 'heathdev-me/dogan', branch: 'main', act: 'merge' };
const verify = (rows, over = {}) => verifySitting({ rows, ...merge, anchor: configured(), now: NOW, ...over });

test('a signed sitting grant authorizes a merge in a listed repo and a listed deploy', () => {
  const ok = verify(rowOf());
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'verified');
  assert.equal(ok.sittingId, grantOf().sittingId);
  assert.equal(verify(rowOf(), { act: 'deploy:observatory' }).ok, true);
});

test('the consequence is short and deterministic: under the 240-character cap at the largest grant', () => {
  const big = grantOf({
    repos: Array.from({ length: 8 }, (_, i) => ({ remote: `some-long-org-name/repository-number-${i}`, branch: 'a-long-branch-name' })),
    deploy: ['cantina', 'dogan', 'forge', 'observatory', 'synthesis-worker'], runBudgetUsd: 99999,
  });
  const consequence = `${renderSitting(big)} [sitting ${sittingTag(big)}]`;
  assert.ok(consequence.length <= 240, `${consequence.length} chars`);
  assert.match(renderSitting(grantOf()), /until 2026-10-19T03:00Z\.$/);
  assert.equal(checkSitting(big, askOf(big), 'a'), true);
});

test('control 1: unsigned, or signed by a key not on the passkey list, is refused', () => {
  assert.equal(verify(rowOf({ unsigned: true })).reason, REASONS.proof_absent);
  assert.equal(verify(rowOf({ key: TEST_KEY_2 })).reason, REASONS.unknown_credential);
});

test('control 2: an unconfigured anchor is refused, never verified', () => {
  const out = verifySitting({ rows: rowOf(), ...merge, anchor: unconfigured(), now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.reason, REASONS.sitting_unconfigured);
});

test('control 2 (CLI): an empty and an unreadable anchor both refuse with a non-zero exit', () => {
  for (const anchorText of [JSON.stringify({ v: 1, epoch: 0, credentials: [] }), '{not json']) {
    const home = mkdtempSync(join(tmpdir(), 'sitting-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'operator-passkeys.json'), anchorText);
    const rows = join(home, 'rows.json');
    writeFileSync(rows, JSON.stringify([rowOf()]));
    const r = spawnSync(process.execPath, [MODULE, 'verify-sitting', '--file', rows, '--repo', merge.repo, '--branch', 'main', '--act', 'merge'], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
    });
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok([REASONS.sitting_unconfigured, REASONS.anchor_unreadable].includes(out.reason), out.reason);
  }
});

test('control 3: expired, longer than 72 h, or signed well before filing is refused', () => {
  assert.equal(verify(rowOf(), { now: Date.parse(grantOf().notAfter) + 1 }).reason, REASONS.grant_expired);
  const long = grantOf({ notAfter: iso(NOW - HOUR + SITTING_MAX_MS + 1000) });
  assert.equal(verify(rowOf({ grant: long })).reason, REASONS.sitting_too_long);
  assert.equal(verify(rowOf({ signedAt: iso(NOW - 2 * HOUR) })).reason, REASONS.sitting_bad_time);
});

test('control 4: a repo outside the grant, or a listed repo on another branch, is refused', () => {
  assert.equal(verify(rowOf(), { repo: 'heathdev-me/forge' }).reason, REASONS.sitting_out_of_scope);
  assert.equal(verify(rowOf(), { branch: 'release' }).reason, REASONS.sitting_out_of_scope);
});

test('control 5: a deploy of a service the grant does not name is refused, and so is a merge when merge is false', () => {
  assert.equal(verify(rowOf(), { act: 'deploy:forge' }).reason, REASONS.sitting_out_of_scope);
  assert.equal(verify(rowOf({ grant: grantOf({ merge: false }) })).reason, REASONS.sitting_out_of_scope);
});

test('control 6: an edited prompt or an edited consequence is refused', () => {
  const row = rowOf();
  const editedPrompt = structuredClone(row);
  editedPrompt.ask.prompt = editedPrompt.ask.prompt.replace('"runBudgetUsd":25', '"runBudgetUsd":2500');
  assert.equal(verify(editedPrompt).ok, false);
  const editedConsequence = structuredClone(row);
  editedConsequence.ask.options[0].consequence = editedConsequence.ask.options[0].consequence.replace('$25/run', '$2500/run');
  assert.equal(verify(editedConsequence).ok, false);
  // A consequence whose tag does not match the signed grant, signed as such.
  const g = grantOf();
  const mismatched = rowOf({ ask: askOf(g, { consequence: `${renderSitting(g)} [sitting 0000000000000000]` }) });
  assert.equal(verify(mismatched).reason, REASONS.grant_tag_mismatch);
});

test('a row whose stored askReceiptId is missing or malformed is refused, never verified', () => {
  const missing = rowOf();
  delete missing.answer.askReceiptId;
  assert.equal(verify(missing).reason, REASONS.sitting_malformed);
  const malformed = rowOf();
  malformed.answer.askReceiptId = 'not-a-uuid';
  assert.equal(verify(malformed).reason, REASONS.sitting_malformed);
});

test('control 7: a signed decline (key b) authorizes nothing', () => {
  assert.equal(verify(rowOf({ answerKey: 'b' })).reason, REASONS.sitting_declined);
});

test('the question must name the grant it carries, and the prompt must hold exactly one grant', () => {
  assert.equal(verify(rowOf({ question: '[sitting 00000000-0000-4000-8000-000000000000] other' })).reason, REASONS.sitting_malformed);
  const g = grantOf();
  assert.equal(parseSittingPrompt(`\`\`\`json\n${JSON.stringify(g)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(g)}\n\`\`\``), null);
  assert.equal(parseSittingPrompt('no grant here'), null);
  assert.equal(parseSittingPrompt(`\`\`\`json\n${JSON.stringify({ ...g, deploy: ['observatory', 'dogan'] })}\n\`\`\``), null, 'deploy must be sorted');
  assert.equal(parseSittingPrompt(`\`\`\`json\n${JSON.stringify({ ...g, deploy: ['prod-db'] })}\n\`\`\``), null, 'unknown service');
});

test('the first covering candidate wins; otherwise the newest refusal is reported with every reason', () => {
  const expired = rowOf({ grant: grantOf({ sittingId: '11111111-1111-4111-8111-111111111111', filedAt: iso(NOW - 30 * HOUR), notAfter: iso(NOW - HOUR) }), signedAt: iso(NOW - 30 * HOUR + 1000) });
  const good = rowOf();
  assert.equal(verify([expired, good]).ok, true);
  const out = verify([expired, rowOf({ answerKey: 'b' })]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.reasons, [REASONS.grant_expired, REASONS.sitting_declined]);
  assert.equal(out.reason, REASONS.grant_expired);
});

test('nowIso is available to signers (sanity)', () => {
  assert.match(nowIso(NOW), /^2026-10-18T16:00:00/);
});
