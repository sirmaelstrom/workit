// Merge, release and budget authority recomputed from the operator's signed
// grant at every act (verifiedAuthority), and the touches that carry the grant:
// touch 1's tagged options, the ambiguous-grant re-ask, the (c) confirm touch
// and the budget raise. With no anchor every path is today's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as pre from './phases/preapproval.mjs';
import * as releasePhase from './phases/release.mjs';
import * as spec from './phases/spec.mjs';
import { ADAPTERS, AGENTS } from './adapters.mjs';
import { mergeActions, recordLandStep } from './land.mjs';
import { releaseEligible } from './release.mjs';
import { QUESTION_MAX, filedLength } from './touch.mjs';
import { handoffText } from './rotate.mjs';
import { testAnchor, testDeps, testGrant, grantConsequence, raiseConsequence, signedTouch } from '../test-deps.mjs';
import { OperatorProofError, renderGrant, grantTag, verifyRecord } from '../../../_shared/operator-proof/operator-proof.mjs';
import { signAnswer } from '../../../_shared/operator-proof/test-signer.mjs';

const T0 = Date.parse('2026-10-04T18:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHOR = 'a0a0a0a0-0000-4000-8000-000000000007';
const GOAL = 'ship the widget';
const RECIPE = { level: 'patch', bump: [{ file: '.claude-plugin/plugin.json', jsonPath: 'version' }], after: [], verify: [] };
const HEAD = 'a'.repeat(40);

const IO = {
  write: (path, value) => writeFileSync(path, value), mkdir: (path) => mkdirSync(path, { recursive: true }), exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'), timestamp: () => new Date(T0).toISOString(), now: () => T0, env: {}, platform: process.platform,
};
const CONFIGURED = testDeps({ ...IO, readAnchor: testAnchor });
const UNCONFIGURED = testDeps(IO);
const authority = async () => (await import('./authority.mjs')).verifiedAuthority;

// Today's touch-1 options, verbatim (preapproval.mjs touchOne).
const TODAY = (budget, release) => [
  { key: 'a', label: 'Approve as proposed', consequence: `Merge each PR at the gate, ${release ? 'run the release recipe' : 'no release (no recipe)'}, budget $${budget}.` },
  { key: 'b', label: 'Approve, but hold at PR boundaries', consequence: 'The run builds and reviews; every PR stays open for the showcase, and nothing merges or releases.' },
  { key: 'c', label: 'Approve with changes', consequence: 'Type the changes (scope, budget, authority); they become a grant checked against (a).' },
  { key: 'd', label: 'Decline', consequence: 'The run closes with no writes to the repo.' },
];

function run(t, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, 'run');
  mkdirSync(join(runDir, 'touches'), { recursive: true });
  const off = { on: false, evidence: 'probed', detail: 'test' };
  return {
    schemaVersion: 1, slug: 'auth-run', runId: 'abcd1234', createdAt: new Date(T0).toISOString(), runDir, workshopDir: join(dir, 'ws'), pluginRoot: join(dir, 'plugin'),
    intent: {
      goal: GOAL, repo: { path: join(dir, 'repo'), remote: 'example/scratch', defaultBranch: 'main' }, anchor: ANCHOR, campaign: null,
      budgetUsd: 10, lanesCap: 2, agent: 'claude', release: RECIPE, ciWorkflows: 1, repoConfig: null, greenfield: null,
    },
    agents: Object.fromEntries(AGENTS.map((name) => [name, off])),
    adapters: Object.fromEntries(ADAPTERS.map((name) => [name, { ...off, on: name === 'spine' }])),
    phase: 'preapproval', authority: { merge: false, release: false, budgetUsd: 0, metered: false, scope: GOAL, notes: null, grant: null },
    touches: [], spec: { depth: null, reviewLevel: null, gate: null, gateCommand: null }, wps: [],
    release: { state: 'pending', reason: null, base: null, worktree: null, branch: null, pr: null, gate: null, merge: null },
    mergeLock: null, dispatchHalt: null, handover: null, sentBack: null, pending: null, lastRecorded: null, seq: 0, rev: 0, txns: [], ...over,
  };
}

const view = (a) => ({ merge: a.merge, release: a.release, budgetUsd: a.budgetUsd, scope: a.scope, proofMode: a.proofMode, reason: a.reason });
const zero = (reason) => ({ merge: false, release: false, budgetUsd: 0, scope: null, proofMode: 'refused', reason });

// Touch 1 as a configured run files it, answered and signed: (a) and (b) carry their grants.
function approved(state, { key = 'a', budgetUsd = 10, merge = true, release = false, grantOver = {} } = {}) {
  const grants = {
    a: testGrant(state, { budgetUsd, merge, release, filedAt: T0, ...grantOver }),
    b: testGrant(state, { budgetUsd, merge: false, release: false, filedAt: T0, ...grantOver }),
  };
  const [, , c, d] = TODAY(budgetUsd, release);
  const options = [
    { key: 'a', label: 'Approve as proposed', consequence: grantConsequence(grants.a) },
    { key: 'b', label: 'Approve, but hold at PR boundaries', consequence: grantConsequence(grants.b) }, c, d,
  ];
  return signedTouch(state, { options, key, fields: { grants } });
}

// A budget-raise touch the build filed at a halt, answered and signed.
function raiseTouch(state, { haltSpendUsd = 12, key = 'a', text = 'budget 30', runId = state.runId, forTouch = null, tagged = true } = {}) {
  const n = state.touches.length + 1;
  const raise = { kind: 'budget-raise', runId, touch: forTouch ?? n, haltSpendUsd };
  const options = [
    { key: 'a', label: 'Raise the budget', consequence: tagged ? raiseConsequence(raise) : 'Type "budget <USD>", above the current spend; metering continues against it.' },
    { key: 'b', label: 'Stop new paid lane work', consequence: 'No dispatch, start, prompt or fallback; PRs already up may still land.' },
  ];
  return signedTouch(state, { kind: 'blocked', options, key, text, allowFreeText: true, fields: { build: 'budget', spendUsd: haltSpendUsd, raise, applied: true } });
}

// --- driving the preapproval phase through its spine filings -----------------

let receipts = 0;
function fileTouch(state, readAnchor) {
  const d = testDeps({ ...IO, readAnchor });
  const action = pre.next(state, d);
  assert.equal(action.part, 'receipt', JSON.stringify(action));
  receipts += 1;
  pre.record(state, action, { id: `00000000-0000-4000-8000-${String(receipts).padStart(12, '0')}`, questId: ANCHOR, outcome: 'needs_input' }, d);
  return state.touches[action.touch.n - 1];
}

// The operator's answer to the filed touch, read back; signed unless `signed` is false.
function answerTouch(state, readAnchor, { key = null, text = null, signed = true } = {}) {
  const d = testDeps({ ...IO, readAnchor });
  const action = pre.next(state, d);
  assert.equal(action.part, 'read-back', JSON.stringify(action));
  const touch = state.touches[action.touch.n - 1];
  const { question, ask } = touch.filed;
  const answer = { key, text, by: 'operator:dogan', answeredAt: new Date(T0).toISOString() };
  if (signed) Object.assign(answer, { askReceiptId: touch.receiptId, proof: signAnswer({ questId: ANCHOR, askReceiptId: touch.receiptId, question, ask, answerKey: key, text }) });
  const latestReceipt = { id: '00000000-0000-4000-8000-0000000000aa', outcome: 'answered', question, ask, answer };
  return pre.record(state, action, { quests: [{ id: ANCHOR, latestReceipt }] }, d);
}

function authorGrant(state, readAnchor, grant) {
  const d = testDeps({ ...IO, readAnchor });
  const action = pre.next(state, d);
  assert.equal(action.step, 'grant', JSON.stringify(action));
  writeFileSync(action.outPath, JSON.stringify(grant));
  return pre.record(state, action, {}, d);
}

const unconfiguredAnchor = () => ({ configured: false, epoch: 0 });

// --- red test 3 ---------------------------------------------------------------

test('red test 3 (D13): a signed (a) whose grant says $10 and no release; state.json edited to $100, release, merge → no release authority and $10; an edited grant → grant_tag_mismatch', async (t) => {
  // Probe 3 measured the gap: today state.json is the authority every act reads.
  const state = run(t, { phase: 'release', wps: [{ id: 'WP-01', state: 'merged' }] });
  approved(state, { budgetUsd: 10, release: false, merge: true });
  state.authority = { merge: true, release: true, budgetUsd: 100, metered: false, scope: GOAL, notes: null, grant: null };
  const emitted = releasePhase.next(state, CONFIGURED);
  assert.deepEqual([emitted, state.release.state, state.release.reason], [null, 'not-exercised', 'no release authority']);
  const verifiedAuthority = await authority();
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), { merge: true, release: false, budgetUsd: 10, scope: GOAL, proofMode: 'verified', reason: null });
  state.touches[0].grants.a.budgetUsd = 100;
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), zero('grant_tag_mismatch'));
});

// --- the helper's contract ------------------------------------------------------

test('verifiedAuthority with no deps.readAnchor throws: a missing seam fails loudly and never reads the real anchor', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  // No reader at all; the isolation guard forbids a literal call without one.
  assert.throws(() => Reflect.apply(verifiedAuthority, null, [state, { now: () => T0 }]), { code: 2, message: 'deps.readAnchor missing' });
});

test('the three pure act functions throw "authority not passed" without an authority', (t) => {
  const state = run(t, { authority: { merge: true, release: true, budgetUsd: 10 }, wps: [{ id: 'WP-01', state: 'merged' }] });
  const wp = { id: 'WP-01', pr: { number: 7 }, gate: { ok: true, head: HEAD, door: 'two-way' }, lane: { worktree: '/w' }, reviews: [] };
  state.mergeLock = { wpId: 'WP-01' };
  assert.throws(() => mergeActions(state, wp, HEAD), { code: 2, message: 'authority not passed' });
  assert.throws(() => recordLandStep(state, wp, { step: 'gate', part: 'gate', kind: 'shell' }, { code: 5, stdout: '' }, { now: () => T0 }), { code: 2, message: 'authority not passed' });
  assert.throws(() => releaseEligible(state), { code: 2, message: 'authority not passed' });
});

test('unconfigured: verifiedAuthority returns state.authority as it is, a mirrored raise included; nothing signed is recomputed', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  state.authority = { merge: true, release: false, budgetUsd: 40, metered: false, scope: 'only the parser', notes: null, grant: null, budgetSource: { touch: 2 } };
  state.touches.push({ n: 1, kind: 'preapproval', status: 'answered', wpId: null, answer: { key: 'a', text: null } });
  state.touches.push({ n: 2, kind: 'blocked', build: 'budget', status: 'answered', wpId: null, answer: { key: 'a', text: 'budget 40' } });
  assert.deepEqual(view(verifiedAuthority(state, UNCONFIGURED)), { merge: true, release: false, budgetUsd: 40, scope: 'only the parser', proofMode: 'unconfigured', reason: null });
  // No approving touch (the build harness's shape): still state.authority.
  const bare = run(t, { authority: { merge: true, release: false, budgetUsd: 25, scope: GOAL } });
  assert.deepEqual(view(verifiedAuthority(bare, UNCONFIGURED)), { merge: true, release: false, budgetUsd: 25, scope: GOAL, proofMode: 'unconfigured', reason: null });
});

test('configured: a signed (a) is its grant; a signed (b) holds merge and release; an edited unsigned key changes nothing; an edited signed key is statement_mismatch', async (t) => {
  const verifiedAuthority = await authority();
  const a = run(t);
  approved(a, { budgetUsd: 10, release: true });
  const got = verifiedAuthority(a, CONFIGURED);
  assert.deepEqual(view(got), { merge: true, release: true, budgetUsd: 10, scope: GOAL, proofMode: 'verified', reason: null });
  assert.equal(got.scopeSha256, a.touches[0].grants.a.scopeSha256);
  assert.deepEqual(got.ignored, []);
  const b = run(t);
  approved(b, { key: 'b' });
  b.touches[0].answer.key = 'a';
  b.authority = { ...b.authority, merge: true, release: true, budgetUsd: 100 };
  assert.deepEqual(view(verifiedAuthority(b, CONFIGURED)), { merge: false, release: false, budgetUsd: 10, scope: GOAL, proofMode: 'verified', reason: null });
  b.touches[0].answer.signed.answer.key = 'a';
  assert.deepEqual(view(verifiedAuthority(b, CONFIGURED)), zero('authority proof invalid: statement_mismatch'));
});

test('configured: wrong run, scope mismatch, grant_expired, the prose binding, and a touch with no grants each give zero authority', async (t) => {
  const verifiedAuthority = await authority();
  // A whole touch copied from another run of this goal: its signed question names that run.
  const copied = run(t);
  const old = run(t, { runId: 'feedbeef' });
  approved(old);
  copied.touches.push(old.touches[0]);
  assert.deepEqual(view(verifiedAuthority(copied, CONFIGURED)), zero('wrong run'));
  // This run's question, but the grant the operator signed names another run.
  const foreign = run(t);
  approved(foreign, { grantOver: { runId: 'feedbeef' } });
  assert.deepEqual(view(verifiedAuthority(foreign, CONFIGURED)), zero('wrong run'));
  // The goal edited after approval.
  const edited = run(t);
  approved(edited);
  edited.intent.goal = 'ship the widget and delete production';
  assert.deepEqual(view(verifiedAuthority(edited, CONFIGURED)), zero('scope mismatch'));
  // Past notAfter.
  const late = run(t);
  approved(late);
  const lateDeps = testDeps({ ...IO, readAnchor: testAnchor, now: () => T0 + 15 * DAY_MS });
  assert.deepEqual(view(verifiedAuthority(late, lateDeps)), zero('grant_expired'));
  // The right tag after prose that says something else.
  const prose = run(t);
  const touch = approved(prose);
  const grant = touch.grants.a;
  const lying = `${renderGrant({ ...grant, release: true })} [grant ${grantTag(grant)}]`;
  prose.touches.pop();
  signedTouch(prose, { options: [{ ...touch.options[0], consequence: lying }, ...touch.options.slice(1)], key: 'a', fields: { grants: touch.grants } });
  assert.deepEqual(view(verifiedAuthority(prose, CONFIGURED)), zero('grant_tag_mismatch'));
  // A run started before this WP and resumed after registration: no grants on its touch.
  const legacy = run(t);
  delete approved(legacy).grants;
  assert.deepEqual(view(verifiedAuthority(legacy, CONFIGURED)), zero('grant_tag_mismatch'));
});

test('configured: no approving touch, an unreadable anchor and malformed state each give zero authority with their reason; none throws', async (t) => {
  const verifiedAuthority = await authority();
  assert.deepEqual(view(verifiedAuthority(run(t, { authority: { merge: true, release: true, budgetUsd: 25, scope: GOAL } }), CONFIGURED)), zero('no approving touch'));
  const unreadable = testDeps({ ...IO, readAnchor: () => { throw new OperatorProofError('anchor_unreadable'); } });
  const state = run(t);
  approved(state);
  assert.deepEqual(view(verifiedAuthority(state, unreadable)), zero('anchor_unreadable'));
  const broken = run(t);
  approved(broken);
  broken.touches.push(null);
  assert.deepEqual(view(verifiedAuthority(broken, CONFIGURED)), zero('malformed_state'));
  const garbled = run(t);
  approved(garbled).answer.signed = 'not a block';
  assert.deepEqual(view(verifiedAuthority(garbled, CONFIGURED)), zero('authority proof invalid: proof_absent'));
});

test('budget raises: a signed, tagged raise above the halt spend applies in touch order; tampered, keyed b, another run\'s, too small or untagged ones are ignored and named', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  approved(state, { budgetUsd: 10 });
  raiseTouch(state, { text: 'budget 30' });
  assert.deepEqual([verifiedAuthority(state, CONFIGURED).budgetUsd, verifiedAuthority(state, CONFIGURED).ignored], [30, []]);
  raiseTouch(state, { haltSpendUsd: 28, text: 'go on; budget $1,500' });
  assert.equal(verifiedAuthority(state, CONFIGURED).budgetUsd, 1500);

  const bad = run(t);
  approved(bad, { budgetUsd: 10 });
  raiseTouch(bad, { text: 'budget 30' }).answer.signed.answer.text = 'budget 3000';
  raiseTouch(bad, { key: 'b', text: null });
  raiseTouch(bad, { runId: 'feedbeef' });
  raiseTouch(bad, { haltSpendUsd: 12, text: 'budget 11' });
  raiseTouch(bad, { tagged: false });
  raiseTouch(bad, { forTouch: 2 });
  const got = verifiedAuthority(bad, CONFIGURED);
  assert.equal(got.budgetUsd, 10);
  assert.deepEqual(got.ignored.map((line) => /^raise touch (\d+): /.exec(line)?.[1]), ['2', '3', '4', '5', '6', '7']);
  assert.match(got.ignored[0], /statement_mismatch/);
  assert.match(got.ignored[2], /wrong run|raise_tag_mismatch/);
  assert.match(got.ignored[3], /not above/);
  assert.match(got.ignored[4], /raise_tag_mismatch/);
  assert.match(got.ignored[5], /raise_tag_mismatch|wrong touch/);
});

// --- touch 1, the re-ask and the confirm ----------------------------------------

test('touch 1 unconfigured: options, consequences and question byte-identical to today, and no grants written', (t) => {
  const state = run(t);
  fileTouch(state, unconfiguredAnchor);
  const touch = state.touches[0];
  assert.deepEqual(touch.options, TODAY(10, true));
  assert.equal('grants' in touch, false);
  assert.equal(touch.question.slice(touch.tag.length + 1), pre.touchOneQuestion(state, UNCONFIGURED));
});

test('touch 1 configured: (a) and (b) carry exactly renderGrant + [grant tag] over the run\'s grant; c and d, the labels and the question are today\'s; no CI → only (b) is tagged', (t) => {
  const state = run(t);
  fileTouch(state, testAnchor);
  const touch = state.touches[0];
  const grants = {
    a: testGrant(state, { budgetUsd: 10, merge: true, release: true, filedAt: T0 }),
    b: testGrant(state, { budgetUsd: 10, merge: false, release: false, filedAt: T0 }),
  };
  assert.deepEqual(touch.grants, grants);
  const today = TODAY(10, true);
  assert.deepEqual(touch.options, [{ ...today[0], consequence: grantConsequence(grants.a) }, { ...today[1], consequence: grantConsequence(grants.b) }, today[2], today[3]]);
  assert.equal(touch.question.slice(touch.tag.length + 1), pre.touchOneQuestion(state, CONFIGURED));
  // The filed ask carries the tags, so the signature binds them.
  assert.deepEqual(touch.filed.ask.options, touch.options);
  const noCi = run(t);
  noCi.intent.ciWorkflows = 0;
  noCi.intent.repo.defaultBranch = null;
  fileTouch(noCi, testAnchor);
  const held = noCi.touches[0];
  assert.deepEqual(held.options.map((option) => option.key), ['b', 'c', 'd']);
  assert.deepEqual(Object.keys(held.grants), ['b']);
  // A branch the repo did not report is signed as unknown (council r1), never as main.
  assert.match(held.options[0].consequence, /^Merge each PR to example\/scratch \(\(unknown\)\): no, release: no, budget \$10, valid until 2026-10-18\. \[grant [0-9a-f]{16}\]$/);
});

test('E7: every tagged option is its own trim, one line and at most 240 chars: a 60-char remote fits; a longer one, or a remote with a newline, is refused at filing', (t) => {
  const fits = run(t);
  fits.intent.repo.remote = `example-org/${'r'.repeat(48)}`;
  assert.equal(fits.intent.repo.remote.length, 60);
  fileTouch(fits, testAnchor);
  for (const option of fits.touches[0].options) {
    assert.ok(option.consequence.length <= 240 && option.consequence === option.consequence.trim() && !/\n/.test(option.consequence), option.consequence);
  }
  const long = run(t);
  long.intent.repo.remote = `example-org/${'r'.repeat(200)}`;
  assert.throws(() => pre.next(long, CONFIGURED), { code: 2, message: /E7/ });
  assert.equal(long.touches.length, 0, 'nothing is filed');
  const broken = run(t);
  broken.intent.repo.remote = 'example/scr\natch';
  assert.throws(() => pre.next(broken, CONFIGURED), { code: 2, message: /E7/ });
});

test('ambiguous (c), then the re-ask answered (a) and signed: the authority is touch 1\'s (a) grant, because the re-ask copied its tagged options and grants', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: 'c', text: 'something about money' });
  authorGrant(state, testAnchor, { ambiguous: true, why: 'the budget' });
  const [one, reask] = state.touches;
  assert.equal(reask.kind, 'blocked');
  assert.deepEqual(reask.options, one.options.filter((option) => option.key !== 'c'));
  assert.deepEqual(reask.grants, { a: one.grants.a, b: one.grants.b });
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: 'a' });
  assert.equal(state.phase, 'spec');
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), { merge: true, release: true, budgetUsd: 10, scope: GOAL, proofMode: 'verified', reason: null });
});

test('(c) unconfigured: today\'s flow; the grant is the authority and no confirm touch is filed', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  fileTouch(state, unconfiguredAnchor);
  answerTouch(state, unconfiguredAnchor, { key: 'c', text: 'only the parser, $5', signed: false });
  authorGrant(state, unconfiguredAnchor, { merge: true, release: false, budgetUsd: 5, scope: 'only the parser' });
  assert.equal(state.phase, 'spec');
  assert.equal(state.touches.length, 1);
  assert.deepEqual(state.authority, {
    merge: true, release: false, budgetUsd: 5, scope: 'only the parser', metered: false, notes: 'only the parser, $5',
    grant: 'touches/1-grant.json', record: 'touches/1-authority.json',
  });
  assert.deepEqual(view(verifiedAuthority(state, UNCONFIGURED)), { merge: true, release: false, budgetUsd: 5, scope: 'only the parser', proofMode: 'unconfigured', reason: null });
});

test('(c) configured: the grant becomes authority only through its signed confirm; before it, zero; the confirm (a) never runs applyAnswer; (d) declines', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: 'c', text: 'only the parser, $5, no release' });
  authorGrant(state, testAnchor, { merge: true, release: false, budgetUsd: 5, scope: 'only the parser' });
  assert.equal(state.phase, 'preapproval');
  const confirm = state.touches[1];
  const grant = testGrant(state, { budgetUsd: 5, merge: true, release: false, scope: 'only the parser', filedAt: T0 });
  assert.deepEqual([confirm.kind, confirm.allowFreeText, confirm.status], ['preapproval-confirm', false, 'open']);
  assert.deepEqual(confirm.options, [
    { key: 'a', label: 'Confirm', consequence: grantConsequence(grant) },
    { key: 'd', label: 'Decline', consequence: 'The run closes with no writes to the repo.' },
  ]);
  assert.deepEqual(confirm.grants, { a: grant });
  assert.equal(confirm.question, `${confirm.tag} Confirm grant for run abcd1234:\nScope: only the parser\nThe operator's text: "only the parser, $5, no release"`);
  assert.deepEqual(state.authority, {
    merge: false, release: false, budgetUsd: 0, scope: 'only the parser', metered: false, notes: 'only the parser, $5, no release',
    grant: 'touches/1-grant.json', record: 'touches/1-authority.json', confirmTouch: null,
  });
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), zero('no approving touch'));
  // The /spec gate's record keeps the (c) answer.
  const recordPath = join(state.runDir, 'touches', '1-authority.json');
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).answer.key, 'c');
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: 'a' });
  assert.equal(state.phase, 'spec');
  assert.equal(state.authority.confirmTouch, 2);
  // applyAnswer would have set the budget to intent.budgetUsd and the scope to the goal.
  assert.deepEqual([state.authority.budgetUsd, state.authority.scope, state.authority.grant], [5, 'only the parser', 'touches/1-grant.json']);
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), { merge: true, release: false, budgetUsd: 5, scope: 'only the parser', proofMode: 'verified', reason: null });
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.deepEqual([record.answer.key, record.scope, record.confirm.touch, record.confirm.answer.signed.answer.key], ['c', 'only the parser', 2, 'a']);
  assert.deepEqual(record.confirm.grants, { a: grant });
  // WP-01's verify-record reads the confirm and the record's own scope.
  const checked = verifyRecord({ record, quest: ANCHOR, anchor: testAnchor(), now: T0 });
  assert.deepEqual([checked.ok, checked.mode, checked.scopeOk], [true, 'verified', true], JSON.stringify(checked));
  // A pointer at a touch that is not a confirm, or at none: zero.
  state.authority.confirmTouch = 1;
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), zero('wrong run'));

  const declined = run(t);
  fileTouch(declined, testAnchor);
  answerTouch(declined, testAnchor, { key: 'c', text: 'smaller' });
  authorGrant(declined, testAnchor, { merge: false, release: false, budgetUsd: 3, scope: GOAL });
  fileTouch(declined, testAnchor);
  answerTouch(declined, testAnchor, { key: 'd' });
  assert.equal(declined.phase, 'declined');
});

test('free-text (c): a keyless typed answer (signed key null, stored c) takes the (c) path to a confirm touch', async (t) => {
  const verifiedAuthority = await authority();
  const state = run(t);
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: null, text: 'only the parser please' });
  const one = state.touches[0];
  assert.deepEqual([one.answer.key, one.answer.signed.answer.key], ['c', null]);
  authorGrant(state, testAnchor, { merge: true, release: false, budgetUsd: 4, scope: 'only the parser' });
  assert.equal(state.touches[1].kind, 'preapproval-confirm');
  assert.deepEqual(view(verifiedAuthority(state, CONFIGURED)), zero('no approving touch'));
});

test('confirm question: a long scope is cut to fit QUESTION_MAX, ending with where the full text is; a text that cannot fit even so is E7', (t) => {
  const state = run(t);
  const scope = `only ${'the parser and '.repeat(200)}nothing else`;
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: 'c', text: 'narrow it' });
  authorGrant(state, testAnchor, { merge: true, release: false, budgetUsd: 5, scope });
  const confirm = state.touches[1];
  const line = confirm.question.split('\n').find((row) => row.startsWith('Scope: '));
  assert.ok(line.endsWith('… (full text: touches/1-grant.json)'), line.slice(-60));
  assert.ok(filedLength(state, confirm.n, confirm.question.slice(confirm.tag.length + 1)) <= QUESTION_MAX);
  assert.equal(confirm.grants.a.scopeSha256, testGrant(state, { budgetUsd: 5, merge: true, release: false, scope, filedAt: T0 }).scopeSha256);
  const crowded = run(t);
  fileTouch(crowded, testAnchor);
  answerTouch(crowded, testAnchor, { key: 'c', text: 'x'.repeat(1990) });
  assert.throws(() => authorGrant(crowded, testAnchor, { merge: true, release: false, budgetUsd: 5, scope: GOAL }), { code: 2, message: /E7/ });
});

// --- the spec phase's scope ----------------------------------------------------

test('spec scope: /spec is held on zero authority, and WP-00\'s approved scope is the signed one, not state.authority.scope', (t) => {
  const state = run(t, { phase: 'spec' });
  approved(state);
  state.authority.scope = 'everything, including production';
  const result = { depth: 'none', workshopDir: state.workshopDir, gateCommand: 'node --test' };
  const action = spec.next(state, CONFIGURED);
  assert.equal(action.kind, 'skill');
  spec.record(state, action, result, CONFIGURED);
  assert.match(readFileSync(join(state.runDir, 'wp-00.md'), 'utf8'), /^\*\*Approved scope:\*\* ship the widget$/m);
  const tampered = run(t, { phase: 'spec' });
  approved(tampered).answer.signed.answer.text = 'merge everything';
  // Held is a wait the driver records, never a run-level done (council r1).
  const held = spec.next(tampered, CONFIGURED);
  assert.deepEqual([held.kind, held.step, held.held], ['wait', 'spec', true]);
  assert.ok(held.waitMs > 0);
  assert.match(held.reason, /authority proof invalid: statement_mismatch/);
  assert.match(held.instruction, /re-file the authority touch and have the operator sign it/);
  spec.record(tampered, held, {}, CONFIGURED);
  spec.record(tampered, action, { ...result, workshopDir: tampered.workshopDir }, CONFIGURED);
  assert.deepEqual([tampered.phase, existsSync(join(tampered.runDir, 'wp-00.md'))], ['spec', false]);
});

// --- release act points ----------------------------------------------------------

test('release: an edited intent.release (recipe digest) or an invalid proof holds a prepopulated release queue; nothing is emitted', async (t) => {
  for (const edit of ['recipe', 'proof']) {
    const state = run(t, { phase: 'release', wps: [{ id: 'WP-01', state: 'merged' }] });
    approved(state, { release: true });
    state.release = { ...state.release, stage: 'gate', queue: [{ kind: 'shell', step: 'release', part: 'ready', command: ['gh', 'pr', 'ready', '200', '--repo', 'example/scratch'] }], worktree: '/w', branch: 'b', pr: { number: 200 } };
    if (edit === 'recipe') state.intent.release = { ...RECIPE, verify: ['curl https://example.test/publish'] };
    else state.touches[0].answer.signed.answer.text = 'release everything';
    assert.equal(releasePhase.next(state, CONFIGURED), null, edit);
    assert.equal(state.release.state, 'failed', edit);
    assert.match(state.release.reason, edit === 'recipe' ? /recipe/ : /authority proof invalid: statement_mismatch/);
  }
});

// --- council round 1 --------------------------------------------------------------

// A configured release whose PR has squashed at HEAD, with `queue` at `stage`.
function mergedRelease(t, { recipe = RECIPE, stage = 'verify', queue = [] } = {}) {
  const state = run(t, { phase: 'release', wps: [{ id: 'WP-01', state: 'merged' }] });
  state.intent.release = recipe;
  approved(state, { release: true });
  Object.assign(state.release, {
    stage, queue, worktree: '/w', branch: 'conduct/auth-run/release', base: 'b'.repeat(40), version: { from: '0.1.0', to: '0.1.1' },
    commit: 'chore(release): 0.1.1 (conduct auth-run)', pr: { number: 200, head: HEAD }, gate: { ok: true, head: HEAD }, squashed: true, merge: { sha: 'd'.repeat(40) },
  });
  return state;
}

const recipeShell = (part, command) => ({ kind: 'shell', step: 'release', part, command, cwd: '/w', recipeCommand: command.join(' '), expects: { type: 'none' } });

test('release emission (council r1, astra): a queued command the verified recipe does not derive is never emitted, though the recipe digest matches; the merged release still removes its worktree', (t) => {
  const recipe = { ...RECIPE, after: ['echo SAFE_RECIPE'] };
  const state = mergedRelease(t, { recipe, queue: [recipeShell('after', ['echo', 'UNSIGNED_QUEUE_COMMAND'])] });
  const emitted = releasePhase.next(state, CONFIGURED);
  assert.ok(!JSON.stringify(emitted).includes('UNSIGNED_QUEUE_COMMAND'), JSON.stringify(emitted));
  assert.deepEqual(emitted.command, ['git', '-C', resolve(state.intent.repo.path), 'worktree', 'remove', '/w']);
  // The command the recipe derives is emitted as queued.
  const fair = mergedRelease(t, { recipe, queue: [recipeShell('after', ['echo', 'SAFE_RECIPE'])] });
  assert.deepEqual(releasePhase.next(fair, CONFIGURED).command, ['echo', 'SAFE_RECIPE']);
});

test('release emission (council r1, codex): every --repo a release command names is the granted repo; an edited intent.repo.remote, or a queued command naming another repo, emits nothing', (t) => {
  for (const edit of ['intent', 'queue']) {
    const state = run(t, { phase: 'release', wps: [{ id: 'WP-01', state: 'merged' }] });
    approved(state, { release: true });
    Object.assign(state.release, { stage: 'gate', queue: [], worktree: '/w', branch: 'b', pr: { number: 7, head: HEAD } });
    if (edit === 'intent') state.intent.repo.remote = 'evil/repo';
    else Object.assign(state.release, { stage: 'merge', queue: [{ kind: 'shell', step: 'release', part: 'ready', command: ['gh', 'pr', 'ready', '7', '--repo', 'evil/repo'], expects: { type: 'none' } }] });
    const emitted = releasePhase.next(state, CONFIGURED);
    assert.equal(emitted, null, `${edit}: ${JSON.stringify(emitted)}`);
    assert.deepEqual([state.release.state, state.phase], ['failed', 'analyze'], edit);
    assert.match(state.release.reason, /evil\/repo is not the granted example\/scratch/, edit);
  }
});

test('release cleanup (council r1): a cleanup part runs only the cleanup command the release derives; a queued remove with another argv is dropped and the derived removal runs', (t) => {
  const state = mergedRelease(t, { stage: 'handover', queue: [{ kind: 'shell', step: 'release', part: 'remove', command: ['curl', 'https://example.test/x'], expects: { type: 'none' } }] });
  const emitted = releasePhase.next(state, CONFIGURED);
  assert.deepEqual(emitted.command, ['git', '-C', resolve(state.intent.repo.path), 'worktree', 'remove', '/w']);
});

test('confirm (council r1): only (a) confirms and (d) declines; any other key is refused, the confirm re-opened and the phase kept at preapproval', (t) => {
  const state = run(t);
  fileTouch(state, testAnchor);
  answerTouch(state, testAnchor, { key: 'c', text: 'only the parser' });
  authorGrant(state, testAnchor, { merge: true, release: false, budgetUsd: 5, scope: 'only the parser' });
  const confirm = fileTouch(state, testAnchor);
  // The signer refuses a key outside the ask, so only an edit to state.json
  // can store one: the confirm marked answered with key b.
  Object.assign(confirm, { status: 'answered', answer: { key: 'b', text: null, by: 'operator:dogan', answeredAt: new Date(T0).toISOString(), source: 'spine' } });
  const d = testDeps({ ...IO, readAnchor: testAnchor });
  const outcome = pre.record(state, { kind: 'wait', step: 'touch', touch: { n: confirm.n } }, {}, d);
  assert.equal(state.phase, 'preapproval');
  assert.equal(state.authority.confirmTouch, null);
  assert.deepEqual([confirm.status, confirm.answer], ['open', null]);
  assert.match(confirm.refusal, /only \(a\) confirms and \(d\) declines/);
  assert.match(outcome?.refused ?? '', /only \(a\) confirms/);
});

test('display (council r1): configured, the handoff prints the verified authority, never state.json\'s; without the anchor reader it says the values are a cached display', (t) => {
  const state = run(t, { phase: 'build' });
  approved(state, { budgetUsd: 10 });
  Object.assign(state.authority, { merge: true, release: true, budgetUsd: 100 });
  const rotation = { attempt: 1, from: 1, to: 2, at: new Date(T0).toISOString(), why: 'context', caller: { pane: null }, pendingId: null };
  const line = (text) => /^- Authority: .*$/m.exec(text)[0];
  assert.match(line(handoffText(state, rotation, CONFIGURED)), /^- Authority: merge true, release false, budget \$10\.00 .*\(proof: verified ••••\S{8} epoch \d+\)$/);
  assert.match(line(handoffText(state, rotation, {})), /^- Authority: merge true, release true, budget \$100\.00 .*\(proof: verified ••••\S{8} epoch \d+\) \(cached display; acts use the signed grant\)$/);
});

test('unknown default branch (council r1): the grant carries the literal "(unknown)" and its prose names it, never main; the shared verifier renders it unchanged', (t) => {
  const state = run(t);
  state.intent.repo.defaultBranch = null;
  const touch = fileTouch(state, testAnchor);
  assert.equal(touch.grants.a.repo.defaultBranch, '(unknown)');
  assert.match(touch.options[0].consequence, /^Merge each PR to example\/scratch \(\(unknown\)\): yes, /);
  assert.doesNotMatch(touch.options[0].consequence, /main/);
});
