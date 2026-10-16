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
