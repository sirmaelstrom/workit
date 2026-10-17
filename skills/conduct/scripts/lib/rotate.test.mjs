// lib/rotate.mjs on in-memory state: the custody steps' boundaries that the
// seam tests (conduct.seam.test.mjs, "rotate (d3ce5461)") do not reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { custodyFence, custodyNext, handoffText, recordCustody, rotate } from './rotate.mjs';

const ANCHOR = 'a0a0a0a0-0000-4000-8000-000000000001';
const deps = (env = {}) => ({ env, timestamp: () => '2026-10-16T03:00:00.000Z', write: () => {}, read: () => '' });

function state(extra = {}) {
  return {
    slug: 'demo', runId: 'abcd1234', runDir: '/runs/demo/run', pluginRoot: '/plugin', phase: 'build', seq: 10,
    intent: { goal: 'the whole goal, wider than the grant', anchor: ANCHOR, repo: { path: '/projects/repo', remote: 'o/r', defaultBranch: 'main' } },
    adapters: { spine: { on: true } },
    authority: { merge: true, release: false, budgetUsd: 50, metered: false, scope: 'the goal', notes: null, grant: null },
    pending: { id: '9-wait', kind: 'shell', step: 'wait', wpId: 'WP-01', command: ['node', 'lane.mjs', 'wait'], instruction: 'Poll the lane once.' },
    wps: [], touches: [], ...extra,
  };
}

// A rotation whose predecessor is already retired, so the next step is the receipt.
function retired(s) {
  rotate(s, { why: 'context at 40%' }, deps());
  const rotation = s.rotations[0];
  rotation.retire = 'confirmed';
  return rotation;
}

test('custody receipt (d3ce5461): skipped while a touch is filed on the anchor, so the operator\'s ask stays the latest receipt; filed otherwise', () => {
  const waiting = state({ touches: [{ n: 2, kind: 'blocked', status: 'filed', tag: '[conduct demo touch 2]' }] });
  const rotation = retired(waiting);
  assert.equal(custodyNext(waiting, rotation, deps()), null);
  assert.deepEqual([rotation.receipt, rotation.status], ['skipped', 'custody']);

  const clear = state({ touches: [{ n: 1, kind: 'preapproval', status: 'answered', tag: '[conduct demo touch 1]' }] });
  const next = custodyNext(clear, retired(clear), deps());
  assert.deepEqual([next.tool, next.args.questId, next.args.outcome], ['spine_receipt', ANCHOR, 'paused']);
});

test('custody receipt (d3ce5461): a failed receipt is recorded as failed and custody is still taken', () => {
  const s = state();
  const rotation = retired(s);
  const action = { ...custodyNext(s, rotation, deps()), id: '12-custody' };
  rotation.action = action;
  recordCustody(s, rotation, action, { isError: true, content: [{ type: 'text', text: 'spine down' }] }, deps());
  assert.equal(rotation.receipt, 'failed');
  assert.equal(custodyNext(s, rotation, deps()), null);
  assert.equal(rotation.status, 'custody');
});

test('rotate (d3ce5461): refused at the showcase and in a terminal phase; the handoff carries the approved scope and the grant, not only the goal', () => {
  for (const phase of ['showcase', 'closed', 'sent-back']) {
    assert.throws(() => rotate(state({ phase }), { why: 'x' }, deps()), { code: 5 }, phase);
  }
  const s = state({ authority: { merge: true, release: false, budgetUsd: 50, metered: false, scope: 'only WP-01 and WP-02', notes: 'no release', grant: 'touches/1-grant.json' } });
  rotate(s, { why: 'context' }, deps());
  const text = handoffText(s, s.rotations[0]);
  assert.match(text, /^- Approved scope \(binding; it can be narrower than the goal\): only WP-01 and WP-02 \(grant `.+1-grant\.json`\); operator notes: no release$/m);
  assert.match(text, /next --run .+ --custody 1`/);
  // The authority line names the authority touch's stored proof (display only).
  assert.match(text, /^- Authority: merge true, release false, budget \$50\.00 \(unmetered\); lanes booked \$0\.00 \(the lane-only lower bound\) \(proof: no authority answer yet\)$/m);
  const unsigned = state({ touches: [{ n: 1, kind: 'preapproval', status: 'answered', wpId: null, answer: { key: 'a', proofMode: 'unconfigured' } }] });
  rotate(unsigned, { why: 'context' }, deps());
  assert.match(handoffText(unsigned, unsigned.rotations[0]), /^- Authority: .* \(proof: UNCONFIGURED — answers not signed\)$/m);
  const signed = state({ touches: [{ n: 1, kind: 'preapproval', status: 'answered', wpId: null, grants: {}, answer: { key: 'a', proofMode: 'verified', credentialId: 'AAAAbbbbCCCCdddd', epoch: 2 } }] });
  rotate(signed, { why: 'context' }, deps());
  assert.match(handoffText(signed, signed.rotations[0]), /^- Authority: .* \(proof: verified ••••CCCCdddd epoch 2\)$/m);
});

test('custody retire (d3ce5461): with no chain row naming r1\'s session for this handoff and pane, custody asks for confirmation instead of retiring a bare pane id; with one, the retire carries --expect-session', () => {
  const s = state();
  const rows = [];
  const io = { ...deps({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }), exists: () => rows.length > 0, read: () => rows.map((row) => `${JSON.stringify(row)}\n`).join('') };
  rotate(s, { why: 'context', model: 'm', effort: 'high' }, io);
  const rotation = s.rotations[0];
  const successor = { ...io, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' } };
  // A row for another handoff, and one for this handoff from another pane, do not count.
  rows.push({ state: 'exit-sent', callerPane: 'w1:p1', callerSession: 'other-run', handoff: '/runs/other/run/handoff-1.md' });
  rows.push({ state: 'exit-sent', callerPane: 'w9:p9', callerSession: 'other-pane', handoff: rotation.handoff });
  const confirm = custodyNext(s, rotation, successor, { custody: 1 });
  assert.equal(confirm.part, 'confirm');
  assert.match(confirm.instruction, /no chain row for .*handoff-1\.md from pane w1:p1, so r1's session is unknown/);
  const fresh = state();
  rotate(fresh, { why: 'context', model: 'm', effort: 'high' }, io);
  rows.push({ state: 'exit-sent', callerPane: 'w1:p1', callerSession: 'r1-session', handoff: fresh.rotations[0].handoff });
  const retire = custodyNext(fresh, fresh.rotations[0], successor, { custody: 1 });
  assert.deepEqual(retire.command.slice(2, 8), ['retire', 'w1:p1', '--mode', 'close', '--expect-session', 'r1-session']);
});

test('rotate (d3ce5461): a scope longer than 600 characters reaches the handoff whole', () => {
  const scope = `${'only WP-01 and WP-02; '.repeat(40)}RESTRICTION_SENTINEL_DO_NOT_DEPLOY`;
  const s = state({ authority: { merge: true, release: false, budgetUsd: 50, metered: false, scope, notes: null, grant: null } });
  rotate(s, { why: 'context' }, deps());
  assert.ok(scope.length > 600);
  assert.ok(handoffText(s, s.rotations[0]).includes('RESTRICTION_SENTINEL_DO_NOT_DEPLOY'));
});

test('custody fence (d3ce5461): next --custody n refuses a cancelled or superseded rotation and an unknown one; an open or taken one passes', () => {
  const s = state();
  rotate(s, { why: 'first' }, deps());
  assert.doesNotThrow(() => custodyFence(s, '1'));
  s.rotations[0].status = 'cancelled';
  assert.throws(() => custodyFence(s, '1'), { code: 5, message: /rotation 1 was cancelled/ });
  rotate(s, { why: 'second' }, deps());
  assert.throws(() => custodyFence(s, '1'), { code: 5 });
  s.rotations[1].status = 'custody';
  assert.doesNotThrow(() => custodyFence(s, '2'));
  rotate(s, { why: 'third' }, deps());
  assert.throws(() => custodyFence(s, '2'), { code: 5, message: /superseded by rotation 3/ });
  assert.throws(() => custodyFence(s, '9'), { code: 2 });
});
