// The go checks run the verifier CLI the way the prose says, under a temp home.
// /burn-down and /pickup bind a manual go to the ask they filed through the
// state file their prose spells out; /spec binds an authority record to the
// current run by comparing the printed grant.runId; unconfigured, the CLI
// checks no signature, so the operator stamp is what refuses a conductor row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantTag, renderGrant } from '../../_shared/operator-proof/operator-proof.mjs';
import { makeTestAnchor, signAnswer } from '../../_shared/operator-proof/test-signer.mjs';
import { scopeSha256 } from '../../conduct/scripts/lib/authority.mjs';

const skills = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(skills, '_shared', 'operator-proof', 'operator-proof.mjs');
const text = (id) => readFileSync(join(skills, id, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');

const ANCHOR = '11111111-2222-4333-8444-555555555555';
const QUEST = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function home(configured) {
  const dir = mkdtempSync(join(tmpdir(), 'go-binding-'));
  if (configured) {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'operator-passkeys.json'), JSON.stringify(makeTestAnchor()));
  }
  return dir;
}

function put(dir, name, value) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function cli(homeDir, args) {
  const result = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir } });
  return { exit: result.status, out: JSON.parse(result.stdout) };
}

// --- manual go: /burn-down and /pickup ---------------------------------------

const TEMPLATE = /`(\{"touches":\[\{"tag":"[^`]*"\}\]\})`/;

function stateTemplate(id) {
  const match = TEMPLATE.exec(text(id));
  assert.ok(match, `${id}: no state-file template`);
  return match[1];
}

const ask = {
  prompt: 'Merge PR 12?', allowFreeText: false,
  options: [{ key: 'a', label: 'Merge', consequence: 'Merge PR 12.' }, { key: 'b', label: 'Hold', consequence: 'Hold PR 12.' }],
};
const question = 'Merge workit PR 12 now? (a) merge (b) hold';

// The state file as the prose spells it, filled with the ask this session filed.
function stateFor(template, receiptId) {
  const tag = question.slice(0, question.indexOf(' '));
  return JSON.parse(template.replace('<question up to its first space>', tag).replace('<ask receipt id>', receiptId));
}

test('/burn-down and /pickup spell the same state file', () => {
  assert.equal(stateTemplate('burn-down'), stateTemplate('pickup'));
});

for (const id of ['burn-down', 'pickup']) {
  test(`/${id}: same wording, same quest, different filing id -> statement_mismatch`, () => {
    const dir = home(true);
    // The operator signed the first filing; the row read for the second carries that signature.
    const proof = signAnswer({ questId: QUEST, askReceiptId: 'rcpt-first-filing', question, ask, answerKey: 'a' });
    const row = put(dir, 'row.json', {
      id: 'rcpt-answer', outcome: 'answered', question, ask,
      answer: { key: 'a', text: null, by: 'operator:dogan', askReceiptId: 'rcpt-first-filing', proof },
    });
    const second = put(dir, 'state-second.json', stateFor(stateTemplate(id), 'rcpt-second-filing'));
    const replay = cli(dir, ['verify-receipt', '--file', row, '--quest', QUEST, '--state', second]);
    assert.deepEqual([replay.exit, replay.out.reason], [1, 'statement_mismatch']);

    const first = put(dir, 'state-first.json', stateFor(stateTemplate(id), 'rcpt-first-filing'));
    const own = cli(dir, ['verify-receipt', '--file', row, '--quest', QUEST, '--state', first]);
    assert.deepEqual([own.exit, own.out.mode], [0, 'verified']);
  });
}

// What /burn-down and /pickup accept: exit 0, and unconfigured the operator stamp.
const manualGo = ({ exit, out }, row) => exit === 0 && (out.mode === 'verified' || String(row.answer.by).startsWith('operator:'));

test('unconfigured: a by: conductor row exits 0 and the operator stamp refuses it', () => {
  const dir = home(false);
  const state = put(dir, 'state.json', stateFor(stateTemplate('burn-down'), 'rcpt-filing'));
  for (const [by, accepted] of [['conductor', false], ['operator:dogan', true]]) {
    const row = { id: 'rcpt-answer', outcome: 'answered', question, ask, answer: { key: 'a', text: null, by } };
    const result = cli(dir, ['verify-receipt', '--file', put(dir, `row-${by.replace(':', '-')}.json`, row), '--quest', QUEST, '--state', state]);
    assert.deepEqual([result.exit, result.out.mode], [0, 'unconfigured'], by);
    assert.equal(manualGo(result, row), accepted, by);
  }
});

// --- /spec core: authority record ---------------------------------------------

const scope = 'Fix the widget only.';

function authorityRecord(runId, receiptId) {
  const grant = {
    budgetUsd: 10, merge: true, release: false, scopeSha256: scopeSha256(scope), runId,
    repo: { remote: 'example/repo', defaultBranch: 'main' }, releaseRecipeSha256: null,
    notAfter: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const options = [
    { key: 'a', label: 'Confirm', consequence: `${renderGrant(grant)} [grant ${grantTag(grant)}]` },
    { key: 'd', label: 'Decline', consequence: 'End the run.' },
  ];
  const confirmAsk = { prompt: 'Confirm the grant', options, allowFreeText: false };
  const confirmQuestion = `[conduct fixture touch 2] (run ${runId}/1) Confirm the (c) grant. Scope: ${scope}`;
  const proof = signAnswer({ questId: ANCHOR, askReceiptId: receiptId, question: confirmQuestion, ask: confirmAsk, answerKey: 'a' });
  const signed = { answer: { key: 'a', text: null, by: 'operator:dogan', askReceiptId: receiptId, proof }, question: confirmQuestion, ask: confirmAsk };
  return {
    merge: true, release: false, budgetUsd: 10, scope, validated: true, touch: 1, grant: 'touches/1-grant.json',
    answer: { key: 'c', text: 'only the widget', by: 'operator:dogan' },
    confirm: { touch: 2, receiptId, options, grants: { a: grant }, answer: { key: 'a', text: null, by: 'operator:dogan', signed } },
  };
}

// /spec step 2, configured: exit 0, scopeOk true, and the printed grant.runId
// equal to state.json's runId.
const coreRef = ({ exit, out }, state) => exit === 0 && out.mode === 'verified' && out.scopeOk === true && out.grant?.runId === state.runId;

test('/spec core: the current run\'s confirm is accepted; another run\'s valid confirm on the same anchor is refused', () => {
  assert.match(text('spec'), /the printed `grant\.runId` equal to `state\.json`'s `runId`/);
  const dir = home(true);
  const state = { runId: 'current-run', intent: { anchor: ANCHOR } };
  put(dir, 'run/state.json', state);
  const goal = put(dir, 'run/goal.md', 'Fix the widget and the gadget.\n');
  const verify = (name, runId) => {
    const record = put(dir, `run/touches/${name}`, authorityRecord(runId, `rcpt-${runId}-confirm`));
    return cli(dir, ['verify-record', '--file', record, '--quest', ANCHOR, '--goal', goal]);
  };

  const current = verify('1-authority.json', 'current-run');
  assert.equal(coreRef(current, state), true);

  // The CLI accepts the other run's record: it checks the grant against its own
  // signed question, never against this run. The runId comparison refuses it.
  const other = verify('7-authority.json', 'old-run');
  assert.deepEqual([other.exit, other.out.mode, other.out.scopeOk, other.out.grant.runId], [0, 'verified', true, 'old-run']);
  assert.equal(coreRef(other, state), false);
});
