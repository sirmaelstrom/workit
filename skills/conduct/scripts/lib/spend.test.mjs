// lib/spend.mjs: how every spend line words its figure (7c728631). The sites'
// own tests (build, rotate, conduct, seam) check the text where it is printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LANE_ESTIMATE_USD, analysisBudgetLine, basisPhrase, budgetHaltText, budgetTouchExpect, committedDetail, laneCount, raiseRefusalText,
  receiptSpendLine, rotateSpendText, touchOneBudgetLine, touchOneEstimate,
} from './spend.mjs';
import { budgetAuditLine } from './analyze.mjs';

const AT = '2026-10-25T19:22:53.787Z';
const lane = (backend, extra = {}) => ({ backend, startedAt: AT, exitedAt: AT, ...extra });
const run = (wps, intent = {}) => ({ intent: { agent: 'claude', backend: { name: 'exec' }, ...intent }, wps });

// One exec claude lane at $3.20 and two T3 lanes that logged nothing (one null, one with no key, as a real T3 state has).
const MIXED = run([
  { id: 'WP-01', state: 'merged', agent: 'claude', lane: lane('exec', { costUsd: 3.2 }) },
  { id: 'WP-02', state: 'merged', agent: 'claude', lane: lane('t3', { costUsd: null }) },
  { id: 'WP-03', state: 'merged', agent: 'claude', lane: lane('t3') },
]);
const ALL_T3 = run([{ id: 'WP-00', state: 'merged', agent: 'claude', lane: lane('t3') }], { backend: { name: 't3', t3Project: 'c684e0c7' } });
const EXEC_CLAUDE = run([{ id: 'WP-01', state: 'merged', agent: 'claude', lane: lane('exec', { costUsd: 3.2 }) }]);

test('laneCount (7c728631): started lanes only, by what their cost tells and by backend', () => {
  const state = run([
    { id: 'WP-01', agent: 'claude', lane: lane('exec', { costUsd: 3.2 }) },
    { id: 'WP-02', agent: 'claude', lane: lane('exec', { costUsd: 0 }) },
    { id: 'WP-03', agent: 'codex', lane: lane('exec') },
    { id: 'WP-04', agent: 'claude', lane: lane('t3', { costUsd: null }) },
    { id: 'WP-05', agent: 'claude', lane: lane('t3') },
    { id: 'WP-06', agent: 'claude', lane: lane('herdr') },
    { id: 'WP-07', agent: 'claude', lane: { backend: 'exec', startedAt: AT } },
    { id: 'WP-08', agent: 'claude', lane: { backend: 'exec' } },
    { id: 'WP-09', lane: null },
  ]);
  assert.deepEqual(laneCount(state), { metered: 2, partial: 0, pending: 1, exitedNoCost: 0, unmetered: { t3: 2, codex: 1, herdr: 1, other: 0 } });
  // No wp.lane.backend: the run's backend; no wp.agent: the run's agent.
  const inherited = run([{ id: 'WP-01', lane: { startedAt: AT } }], { agent: 'codex' });
  assert.deepEqual(laneCount(inherited).unmetered.codex, 1);
  assert.deepEqual(laneCount(run([{ id: 'WP-01', lane: { startedAt: AT } }], { backend: undefined })).unmetered.other, 1);
});

test('basisPhrase (7c728631): with started lanes it counts them; with none it names the backend, never an object', () => {
  assert.equal(basisPhrase(MIXED), '1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted');
  assert.equal(basisPhrase(ALL_T3), '1 T3 lane logs none and is not counted');
  const pending = run([{ id: 'WP-01', agent: 'claude', lane: lane('exec', { costUsd: 1 }) }, { id: 'WP-02', agent: 'claude', lane: { backend: 'exec', startedAt: AT } },
    { id: 'WP-03', agent: 'claude', lane: lane('t3') }, { id: 'WP-04', agent: 'claude', lane: lane('herdr') }]);
  assert.equal(basisPhrase(pending), '1 exec claude lane logged its cost; 1 exec claude lane not booked yet (a lane books at close); 1 T3 lane and 1 herdr lane log none and are not counted');
  assert.equal(basisPhrase(run([], { backend: { name: 't3', t3Project: 'p' } })), 'T3 lanes log no cost, so none are counted');
  assert.equal(basisPhrase(run([], { backend: { name: 'herdr' } })), 'herdr lanes log no cost, so none are counted');
  assert.equal(basisPhrase(run([], { backend: { name: 'exec' }, agent: 'codex' })), 'codex lanes log no cost, so none are counted');
  assert.equal(basisPhrase(run([], { backend: { name: 'exec' } })), 'no lane has started; exec claude lanes log their cost at close');
  assert.equal(basisPhrase({ intent: { agent: 'claude' }, wps: [] }), 'no lane has started');
  assert.equal(basisPhrase({ intent: { agent: 'claude', backend: 'herdr' }, wps: [] }), 'no lane has started');
  assert.ok(!basisPhrase(run([], { backend: { name: { nested: true } } })).includes('[object'));
});

test('exited and killed exec claude lanes (C1-1, N1): one that exited with no cost is not "not booked yet"; a killed lane\'s cost is partial', () => {
  // lanes.mjs exitedLane: costUsd only when a cost was read; costComplete false when the lane was killed.
  const exited = run([{ id: 'WP-01', state: 'merged', agent: 'claude', lane: lane('exec', { costComplete: false }) }]);
  assert.deepEqual(laneCount(exited), { metered: 0, partial: 0, pending: 0, exitedNoCost: 1, unmetered: { t3: 0, codex: 0, herdr: 0, other: 0 } });
  assert.equal(basisPhrase(exited), '1 exec claude lane exited with no logged cost and is not counted');
  const killed = run([{ id: 'WP-01', state: 'merged', agent: 'claude', lane: lane('exec', { costUsd: 1.1, costComplete: false }) },
    { id: 'WP-02', state: 'merged', agent: 'claude', lane: lane('exec', { costUsd: 2, costComplete: true }) },
    { id: 'WP-03', state: 'blocked', agent: 'claude', lane: lane('exec') }, { id: 'WP-04', state: 'blocked', agent: 'claude', lane: lane('exec') },
    { id: 'WP-05', state: 'review', agent: 'claude', lane: { backend: 'exec', startedAt: AT } }]);
  assert.deepEqual(laneCount(killed), { metered: 1, partial: 1, pending: 1, exitedNoCost: 2, unmetered: { t3: 0, codex: 0, herdr: 0, other: 0 } });
  assert.equal(basisPhrase(killed), '1 exec claude lane logged its cost; 1 exec claude lane logged a partial cost (lower bound); 1 exec claude lane not booked yet (a lane books at close); 2 exec claude lanes exited with no logged cost and are not counted');
  for (const text of [basisPhrase(exited), analysisBudgetLine(exited, '$0.00'), rotateSpendText(exited, '$0.00')]) assert.doesNotMatch(text, /not booked yet|books at close/);
});

test('receipt with nothing left (C1-4): no "adding 0 WP estimate(s)" clause', () => {
  assert.equal(receiptSpendLine(EXEC_CLAUDE, { booked: '$3.2', projected: '$3.2', wpsLeft: 0, perWp: '$3.2', basis: 'b', budget: '$25', crosses: false }),
    ' Spend: $3.2 booked, a lower bound (1 exec claude lane logged its cost); ~$3.2 projected, against $25.');
});

test('touch 1 estimate (C1-2): the pinned repo config\'s laneEstimateUsd, else the default', () => {
  assert.deepEqual(touchOneEstimate({ laneEstimateUsd: 30 }), { usd: 30, source: 'repo config' });
  assert.deepEqual(touchOneEstimate({ laneEstimateUsd: 0 }), { usd: 0, source: 'repo config' });
  for (const pinned of [null, {}, { laneEstimateUsd: -1 }, { laneEstimateUsd: 'x' }]) assert.deepEqual(touchOneEstimate(pinned), { usd: DEFAULT_LANE_ESTIMATE_USD, source: 'default' });
  assert.match(touchOneBudgetLine({ budgetUsd: 25, backend: 'herdr', agent: 'claude', estimate: touchOneEstimate({ laneEstimateUsd: 30 }) }), /at the repo config estimate \$30$/);
  assert.match(touchOneBudgetLine({ budgetUsd: 25, backend: 'herdr', agent: 'claude' }), /at the default estimate \$15$/);
});

// Every builder's text for a state, with the numbers the sites compute.
const texts = (state) => [
  analysisBudgetLine(state, '$3.20'),
  receiptSpendLine(state, { booked: '$3.2', projected: '$9.6', wpsLeft: 2, perWp: '$3.2', basis: 'the mean of 1 lane(s) with a positive logged cost', budget: '$25', crosses: false }),
  receiptSpendLine(state, { booked: '$3.2', projected: '$3.2', wpsLeft: 0, perWp: '$3.2', basis: 'the mean of 1 lane(s) with a positive logged cost', budget: '$25', crosses: false }),
  committedDetail(state, { booked: '$3.2', live: 0, liveUsd: null, nextUsd: '$3.2', perLane: '$3.2', basis: 'the mean of 1 lane(s) with a positive logged cost' }),
  budgetHaltText(state, { committed: '$6.4', detail: 'detail', budget: '$5' }),
  budgetTouchExpect(state).expect,
  budgetTouchExpect(state).consequence,
  touchOneBudgetLine({ budgetUsd: 25, backend: 't3', agent: 'claude' }),
  rotateSpendText(state, '$3.20'),
  raiseRefusalText(state, '$6.4'),
];

test('each builder (7c728631): a reported figure is a lower bound naming its lanes; a committed one is the lower bound plus estimates, with no counts', () => {
  const [analysis, receipt, , detail, halt, expect, consequence, , rotated, refusal] = texts(MIXED);
  for (const reported of [analysis, receipt, halt, rotated]) {
    assert.match(reported, /lower bound/, reported);
    assert.match(reported, /1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted/, reported);
  }
  assert.equal(analysis, 'budget: unmetered; lower bound $3.20 (1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted)');
  assert.equal(receipt, ' Spend: $3.2 booked, a lower bound (1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted); ~$9.6 projected, adding 2 WP estimate(s) at $3.2 each (the mean of 1 lane(s) with a positive logged cost) for every unfinished WP and every finished WP (merged, refuted or dropped) whose lane logged no cost, against $25.');
  assert.match(receiptSpendLine(MIXED, { booked: '$3.2', projected: '$30', wpsLeft: 2, perWp: '$13.4', basis: 'b', budget: '$25', crosses: true }), /against \$25: the projection crosses the budget\.$/);
  assert.equal(detail, '$3.2 booked + $3.2 for the next WP; lanes estimated at $3.2 each, the mean of 1 lane(s) with a positive logged cost');
  assert.equal(committedDetail(MIXED, { booked: '$0', live: 2, liveUsd: '$60', nextUsd: null, perLane: '$30', basis: 'b' }), '$0 booked + $60 for 2 live lane(s); lanes estimated at $30 each, b');
  assert.equal(halt, 'Spend is $6.4 committed (detail) against the $5 budget (unmetered; booked is a lower bound: 1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted)');
  assert.equal(rotated, 'lanes booked $3.20, a lower bound (1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted)');
  for (const committed of [expect, consequence, refusal]) {
    assert.match(committed, /the lower bound plus lane estimates/, committed);
    assert.doesNotMatch(committed, /\d+ (exec claude|T3|herdr|codex) lane/, committed);
  }
  assert.equal(refusal, '(a) needs the text "budget <USD>" above the committed spend of $6.4 (the lower bound plus lane estimates)');
  // An all-T3 receipt promises no later booking: it says the estimate covers merged lanes that logged no cost.
  const t3 = receiptSpendLine(ALL_T3, { booked: '$0', projected: '$15', wpsLeft: 1, perWp: '$15', basis: 'the default estimate', budget: '$25', crosses: false });
  assert.match(t3, /\$0 booked, a lower bound \(1 T3 lane logs none and is not counted\)/);
  assert.match(t3, /planning estimate, not a cash charge/);
  assert.match(t3, /T3 lane estimates do not consume the \$25 cash budget; recorded costs still do/);
  assert.doesNotMatch(t3, /not yet booked|books? at close|will book/);
  assert.match(analysisBudgetLine(EXEC_CLAUDE, '$3.20'), /^budget: unmetered; lower bound \$3\.20 \(1 exec claude lane logged its cost\)$/);
});

test('touchOneBudgetLine (7c728631): a lower bound naming the backend\'s uncounted lanes, no counts, at most 150 chars at a 4-digit budget', () => {
  assert.equal(touchOneBudgetLine({ budgetUsd: 25, backend: 't3', agent: 'claude' }),
    'Budget: $25 for recorded cash costs; plan-covered T3 lane estimates do not trigger a budget stop');
  assert.match(touchOneBudgetLine({ budgetUsd: 25, backend: 'herdr', agent: 'claude' }), /^Budget: \$25 unmetered: herdr lanes log no cost, so the lower bound counts none;/);
  assert.match(touchOneBudgetLine({ budgetUsd: 25, backend: 'exec', agent: 'codex' }), /^Budget: \$25 unmetered: codex lanes log no cost, so the lower bound counts none;/);
  assert.match(touchOneBudgetLine({ budgetUsd: 25, backend: 'exec', agent: 'claude' }), /^Budget: \$25 unmetered: exec claude lanes' logged cost sums to a lower bound; the gate adds each live lane at the default estimate \$15$/);
  for (const backend of ['t3', 'herdr', 'exec']) {
    for (const agent of ['claude', 'codex']) {
      for (const estimate of [undefined, touchOneEstimate({ laneEstimateUsd: 30 }), touchOneEstimate({ laneEstimateUsd: 1234.56 })]) {
        const line = touchOneBudgetLine({ budgetUsd: 9999, backend, agent, estimate });
        assert.ok(line.length <= 150, `${backend}/${agent}: ${line.length} chars`);
        assert.doesNotMatch(line, /\d+ (T3|herdr|codex|exec claude) lanes?/, line);
      }
    }
  }
});

// MN4: no spend text reads as a figure per PR or per merged WP. Only the builders' text is checked: a handoff's paths (/projects) would match the slash.
const PER_PR = /(\bper\b|\/)\s*(PR|pull request|merged|landed)\b/i;
test('no per-PR figure (MN4, 7c728631): no builder\'s text, for any fixture state, reads as a figure per PR or per merged WP', () => {
  for (const state of [MIXED, ALL_T3, EXEC_CLAUDE, run([])]) {
    for (const text of texts(state)) assert.doesNotMatch(text, PER_PR, text);
  }
  // The pattern catches the shape it names.
  for (const bad of ['$1.60 per PR', '$3 / merged WP', '$2 per pull request']) assert.match(bad, PER_PR);
});

test('the analysis line (7c728631): analyze.mjs prints the lower bound with its counted and uncounted lanes', () => {
  assert.equal(budgetAuditLine(MIXED), 'budget: unmetered; lower bound $3.20 (1 exec claude lane logged its cost; 2 T3 lanes log none and are not counted)');
  assert.equal(budgetAuditLine(ALL_T3), 'budget: unmetered; lower bound $0.00 (1 T3 lane logs none and is not counted)');
  assert.equal(budgetAuditLine(EXEC_CLAUDE), 'budget: unmetered; lower bound $3.20 (1 exec claude lane logged its cost)');
});
