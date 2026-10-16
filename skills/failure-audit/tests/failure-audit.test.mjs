// Tests for the failure-audit skill scripts (node --test, no third-party deps).
//
// delta.mjs carries the COUNT CONTRACT — sole definition since the
// audit-backlog.ts mirror retired 2026-08-21 (scanner-first, quest c9c1c459).
// Each clause is pinned here (depth-2 only, stub floor, Temp-lane exclusion,
// manifest subtraction, epoch bound) so a refactor cannot silently drop one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeDelta, readAuditHistory, MIN_SESSION_BYTES } from '../scripts/delta.mjs';
import { aggregateResults, normalizeModel, DOCTRINE_BITE } from '../scripts/aggregate.mjs';
import { compareRuns, readRun, SEEDED_TAXONOMY } from '../scripts/compare.mjs';

const BIG = 'x'.repeat(2048);
const PRE_EPOCH = new Date(Date.UTC(2026, 7, 1));
const POST_EPOCH = new Date(Date.UTC(2026, 7, 12));

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-audit-'));
  const archiveDir = path.join(root, 'archive');
  const reviewsDir = path.join(root, 'reviews');
  const runA = path.join(reviewsDir, '2026-08-01-failure-audit-data');
  const runB = path.join(reviewsDir, '2026-08-11-failure-audit-data');
  fs.mkdirSync(runA, { recursive: true });
  fs.mkdirSync(runB, { recursive: true });
  fs.writeFileSync(path.join(runA, 'manifest.json'), JSON.stringify([{ file: 'audited-early.jsonl' }]));
  fs.writeFileSync(path.join(runB, 'manifest.json'), JSON.stringify([{ file: 'audited-late.jsonl' }]));

  const put = (rel, content, mtime) => {
    const p = path.join(archiveDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    fs.utimesSync(p, mtime, mtime);
  };
  put('proj-a/new-session.jsonl', BIG, POST_EPOCH); // the one true delta item
  put('proj-a/audited-late.jsonl', BIG, POST_EPOCH); // latest manifest → subtracted
  put('proj-a/audited-early.jsonl', BIG, POST_EPOCH); // earlier manifest → union subtracts
  put('proj-a/old-unaudited.jsonl', BIG, PRE_EPOCH); // pre-epoch carve-out
  put('proj-a/stub.jsonl', 'x', POST_EPOCH); // ≤1KB stub floor
  put('proj-a/notes.txt', BIG, POST_EPOCH); // not a session
  put('proj-a/session-x/subagents/agent-a1.jsonl', BIG, POST_EPOCH); // depth-4 sidechain
  put('C--Users-x-AppData-Local-Temp-lane/probe.jsonl', BIG, POST_EPOCH); // Temp lane
  return { root, archiveDir, reviewsDir };
}

test('delta: contract set — epoch + manifest union + stub/lane/depth exclusions', (t) => {
  const { root, archiveDir, reviewsDir } = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const history = readAuditHistory(reviewsDir);
  assert.equal(history.lastRunDate, '2026-08-11');
  assert.equal(history.runCount, 2);
  assert.deepEqual([...history.audited].sort(), ['audited-early.jsonl', 'audited-late.jsonl']);

  const { items, skipped } = computeDelta({ archiveDir, reviewsDir });
  assert.deepEqual(items.map((i) => i.name), ['new-session.jsonl']);
  assert.equal(skipped.audited, 2);
  assert.equal(skipped.stubs, 1);
  assert.equal(skipped.tempLanes, 1);
  assert.equal(skipped.preEpoch, 1);
  assert.ok(MIN_SESSION_BYTES === 1024, 'stub floor is part of the mirrored contract');
});

test('aggregate: counts valid contributions, dedups digests, reports coverage gaps', () => {
  const results = [
    {
      agent: 'W1A',
      taxonomy_notes: 'invented odd-new-label for X',
      sessions: [
        { digest: 'd1.md', verdict: 'failures_found', friction: { count: 2, kinds: ['path-form'] }, failures: [
          { label: 'shell-string-code-write', occurrences: 2, model: 'claude-opus-5', caught_by: 'self', severity: 'minor' },
          { label: 'odd-new-label', model: 'opus-5', caught_by: 'none', severity: 'serious' },
        ] },
        { digest: 'd2.md', verdict: 'clean', friction: { count: 0, kinds: [] }, failures: [] },
        { verdict: 'clean' }, // invalid: no digest — must not inflate coverage
      ],
    },
    { agent: 'W1B', sessions: [{ digest: 'd1.md', verdict: 'clean' }] }, // duplicate digest
    { agent: 'W1C', sessions: [{ digest: 'calib.md', verdict: 'failures_found', failures: [{ label: 'unverified-claim-or-premise' }] }] }, // calibration leakage: not in manifest
  ];
  const { agg, missing } = aggregateResults(results, ['d1.md', 'd2.md', 'd3.md']);
  assert.equal(agg.counts.sessions, 2);
  assert.equal(agg.counts.duplicateSessionsSkipped, 1);
  assert.equal(agg.counts.invalidEntriesSkipped, 1);
  assert.equal(agg.counts.nonManifestEntriesSkipped, 1); // skipped loudly, byClass untouched
  assert.equal(agg.byClass['unverified-claim-or-premise'], undefined);
  assert.equal(agg.counts.failureRecords, 2);
  assert.equal(agg.byClass['shell-string-code-write'], 2); // occurrences summed
  assert.equal(agg.byModel['opus-5']['shell-string-code-write'], 2); // model normalized
  assert.deepEqual(missing, ['d3.md']); // gap surfaces, never silent
  assert.equal(normalizeModel('claude-sonnet-5'), 'sonnet-5');
});

test('aggregate: doctrine_refs join — enum counted per section, malformed refs skipped loudly, absent field adds nothing', () => {
  const results = [{
    agent: 'W1A',
    sessions: [
      { digest: 'd1.md', verdict: 'failures_found', failures: [
        { label: 'unverified-claim-or-premise', occurrences: 3, doctrine_refs: [
          { section: 'Claims Carry Their Refutation', bite: 'no-bite' },
          { section: '  Specification Through Testability ', bite: 'bite' }, // trimmed
        ] },
        { label: 'incomplete-sweep-before-pr', doctrine_refs: [
          { section: 'Claims Carry Their Refutation', bite: 'n-a' },
          { section: 'Claims Carry Their Refutation', bite: 'no_bite' }, // wrong spelling: skipped, not coerced
          { section: '', bite: 'bite' }, // no section
          { bite: 'bite' }, // no section key
          null,
        ] },
        { label: 'shell-string-code-write', doctrine_refs: 'Externalized Intent' }, // not an array
        { label: 'false-completion-signal' }, // absent: legacy record
      ] },
    ],
  }];
  const { agg } = aggregateResults(results, ['d1.md']);
  assert.deepEqual(DOCTRINE_BITE, ['bite', 'no-bite', 'n-a']);
  assert.deepEqual(agg.byDoctrine, {
    'Claims Carry Their Refutation': { bite: 0, 'no-bite': 1, 'n-a': 1 }, // per record, not per occurrence
    'Specification Through Testability': { bite: 1, 'no-bite': 0, 'n-a': 0 },
  });
  assert.equal(agg.counts.doctrineRefs, 3);
  assert.equal(agg.counts.invalidDoctrineRefsSkipped, 5);
  assert.equal(agg.counts.failureRecords, 4); // a bad ref never drops its failure record
  assert.equal(agg.byClass['unverified-claim-or-premise'], 3);
});

test('aggregate: a run with no doctrine_refs anywhere yields an empty join, not a missing key', () => {
  const { agg } = aggregateResults([{ sessions: [{ digest: 'd1.md', verdict: 'clean', failures: [] }] }], ['d1.md']);
  assert.deepEqual(agg.byDoctrine, {});
  assert.equal(agg.counts.doctrineRefs, 0);
  assert.equal(agg.counts.invalidDoctrineRefsSkipped, 0);
});

test('compare: failed treatment, emergent labels, and the n basis in output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-audit-cmp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mkRun = (name, aggregate, manifest) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aggregate.json'), JSON.stringify(aggregate));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  };
  // Baseline shape: byClass at ROOT (the frozen 2026-08-11 layout).
  const baseDir = mkRun('2026-08-11-failure-audit-data',
    { byClass: { 'self-approved-gated-action': 2, 'shell-string-code-write': 13 }, byModel: { 'opus-5': { 'shell-string-code-write': 12 } } },
    Array.from({ length: 100 }, (_, i) => ({ file: `s${i}.jsonl`, models: ['claude-opus-5'], firstTs: '2026-07-12T00:00:00Z', lastTs: '2026-08-11T00:00:00Z' })));
  // Current shape: aggregate.mjs output (same keys, counts alongside).
  const currDir = mkRun('2026-09-01-failure-audit-delta',
    { counts: { sessions: 50 }, byClass: { 'self-approved-gated-action': 1, 'shell-string-code-write': 2, 'brand-new-mode': 3 }, byModel: { 'fable-5': { 'brand-new-mode': 3 } } },
    Array.from({ length: 50 }, (_, i) => ({ file: `t${i}.jsonl`, models: ['claude-fable-5'], firstTs: '2026-08-12T00:00:00Z', lastTs: '2026-09-01T00:00:00Z' })));

  const out = compareRuns(readRun(baseDir), readRun(currDir));
  assert.match(out, /self-approved-gated-action.*FAILED TREATMENT/); // expectation zero, count 1
  assert.match(out, /shell-string-code-write[^\n]*OK/); // 13/100 → 2/50: rate dropped
  assert.match(out, /`brand-new-mode` × 3 \(first appearance\)/);
  assert.match(out, /n=100 sessions/);
  assert.match(out, /n=50 sessions/);
  assert.ok(!SEEDED_TAXONOMY.includes('brand-new-mode'));
});
