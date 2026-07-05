// spec-cost.test.mjs — unit + CLI integration tests for the /spec cost collector.
//
// MUST-NOT (CI): no drive-letter literals (C:/, D:\) anywhere in this file —
// CI runs on Linux where those resolve as RELATIVE paths, not absolute ones.
// All fixture paths are built from os.tmpdir()/path.join.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createState, markPhase, slugifyCwd, collectPhaseUsage, buildReport, renderMarkdownTable, main,
} from '../scripts/spec-cost.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'scripts', 'spec-cost.mjs');

function isoAt(msFromEpoch) {
  return new Date(msFromEpoch).toISOString();
}

function usageLine(id, model, usage) {
  return JSON.stringify({ message: { id, model, usage } });
}

// ---------------------------------------------------------------------------
// markPhase — sequencing + auto-close
// ---------------------------------------------------------------------------

test('markPhase: start appends a new open entry', () => {
  const state = createState('/fake/cwd');
  const t0 = isoAt(1000);
  const { state: s1, warning } = markPhase(state, 'phase-1-setup', 'start', t0);
  assert.equal(warning, null);
  assert.equal(s1.phases.length, 1);
  assert.deepEqual(s1.phases[0], { phase: 'phase-1-setup', startedAt: t0, endedAt: null });
});

test('markPhase: starting a new phase auto-closes the prior open phase', () => {
  const state = createState('/fake/cwd');
  const t0 = isoAt(1000);
  const t1 = isoAt(2000);
  const { state: s1 } = markPhase(state, 'phase-1-setup', 'start', t0);
  const { state: s2 } = markPhase(s1, 'phase-2-pipeline', 'start', t1);
  assert.equal(s2.phases.length, 2);
  assert.equal(s2.phases[0].endedAt, t1); // auto-closed
  assert.equal(s2.phases[1].endedAt, null);
});

test('markPhase: end closes the matching open phase', () => {
  const state = createState('/fake/cwd');
  const t0 = isoAt(1000);
  const t1 = isoAt(2000);
  const { state: s1 } = markPhase(state, 'phase-1-setup', 'start', t0);
  const { state: s2, warning } = markPhase(s1, 'phase-1-setup', 'end', t1);
  assert.equal(warning, null);
  assert.equal(s2.phases[0].endedAt, t1);
});

test('markPhase: end with no matching open phase is a no-op + warning', () => {
  const state = createState('/fake/cwd');
  const { state: s1, warning } = markPhase(state, 'phase-9-final', 'end', isoAt(1000));
  assert.match(warning, /no open phase entry/);
  assert.equal(s1.phases.length, 0);
});

test('markPhase: does not mutate the input state (pure)', () => {
  const state = createState('/fake/cwd');
  const frozen = JSON.parse(JSON.stringify(state));
  markPhase(state, 'phase-1-setup', 'start', isoAt(1000));
  assert.deepEqual(state, frozen);
});

test('markPhase: throws on an invalid event', () => {
  const state = createState('/fake/cwd');
  assert.throws(() => markPhase(state, 'phase-1-setup', 'pause', isoAt(1000)), /event must be/);
});

// ---------------------------------------------------------------------------
// slugifyCwd
// ---------------------------------------------------------------------------

test('slugifyCwd replaces every non-alphanumeric char with a dash', () => {
  assert.equal(slugifyCwd('/home/user/projects/workit'), '-home-user-projects-workit');
});

// ---------------------------------------------------------------------------
// collectPhaseUsage + buildReport + renderMarkdownTable — fixture-driven
// ---------------------------------------------------------------------------

function makeFixtureProjectsDir() {
  const root = mkdtempSync(join(tmpdir(), 'spec-cost-fixtures-'));
  const sessionDir = join(root, 'session-abc', 'subagents');
  mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir };
}

test('collectPhaseUsage dedupes repeated usage blocks for the same message id', () => {
  const { root, sessionDir } = makeFixtureProjectsDir();
  try {
    const file = join(sessionDir, 'agent-a1.jsonl');
    // The same message id streams twice with growing usage — last one should win.
    const lines = [
      usageLine('msg-1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 1 }),
      usageLine('msg-1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 50 }),
    ];
    writeFileSync(file, lines.join('\n'));
    const fileTime = Date.parse('2026-01-01T00:00:30.000Z');
    utimesSync(file, fileTime / 1000, fileTime / 1000);

    const phases = [
      { phase: 'phase-1-setup', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' },
    ];
    const { perPhase, unknownModels } = collectPhaseUsage(phases, root, new Date('2026-01-01T00:02:00.000Z'));
    assert.equal(unknownModels.size, 0);
    const modelBucket = perPhase.get('phase-1-setup');
    assert.ok(modelBucket);
    const counts = modelBucket.get('claude-sonnet-5');
    assert.equal(counts.inputTokens, 100); // not 200 — deduped, last wins
    assert.equal(counts.outputTokens, 50); // last wins, not summed with first
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPhaseUsage attributes files to the phase whose window contains their mtime', () => {
  const { root, sessionDir } = makeFixtureProjectsDir();
  try {
    const inWindowFile = join(sessionDir, 'agent-in.jsonl');
    const outWindowFile = join(sessionDir, 'agent-out.jsonl');
    writeFileSync(inWindowFile, usageLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 2 }));
    writeFileSync(outWindowFile, usageLine('m2', 'claude-sonnet-5', { input_tokens: 999, output_tokens: 999 }));

    const inTime = Date.parse('2026-01-01T00:00:30.000Z') / 1000;
    const outTime = Date.parse('2026-01-01T05:00:00.000Z') / 1000; // well outside any phase window
    utimesSync(inWindowFile, inTime, inTime);
    utimesSync(outWindowFile, outTime, outTime);

    const phases = [
      { phase: 'phase-1-setup', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' },
    ];
    const { perPhase } = collectPhaseUsage(phases, root, new Date('2026-01-01T00:02:00.000Z'));
    const counts = perPhase.get('phase-1-setup').get('claude-sonnet-5');
    assert.equal(counts.inputTokens, 10); // only the in-window file counted
    assert.equal(counts.outputTokens, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPhaseUsage buckets unknown-family models separately, never as $0', () => {
  const { root, sessionDir } = makeFixtureProjectsDir();
  try {
    const file = join(sessionDir, 'agent-unknown.jsonl');
    writeFileSync(file, usageLine('m1', 'gpt-5.5', { input_tokens: 500, output_tokens: 100 }));
    const t = Date.parse('2026-01-01T00:00:30.000Z') / 1000;
    utimesSync(file, t, t);

    const phases = [
      { phase: 'phase-1-setup', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' },
    ];
    const { perPhase, unknownModels } = collectPhaseUsage(phases, root, new Date('2026-01-01T00:02:00.000Z'));
    assert.equal(perPhase.has('phase-1-setup'), false);
    assert.equal(unknownModels.get('gpt-5.5').inputTokens, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPhaseUsage on a missing projects dir returns empty maps (never throws)', () => {
  const missing = join(tmpdir(), 'spec-cost-does-not-exist-' + Date.now());
  const phases = [{ phase: 'phase-1-setup', startedAt: isoAt(0), endedAt: null }];
  const { perPhase, unknownModels } = collectPhaseUsage(phases, missing, new Date());
  assert.equal(perPhase.size, 0);
  assert.equal(unknownModels.size, 0);
});

test('buildReport + renderMarkdownTable: known-model phase produces a priced row', () => {
  const state = {
    schema_version: '1.0',
    cwd: '/fake/cwd',
    phases: [{ phase: 'phase-1-setup', startedAt: isoAt(0), endedAt: isoAt(60000) }],
  };
  const perPhase = new Map([
    ['phase-1-setup', new Map([
      ['claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 }],
    ])],
  ]);
  const report = buildReport(state, { perPhase, unknownModels: new Map() }, isoAt(70000));
  assert.equal(report.phases[0].totals.costUsd, 3); // 1M input @ $3/1M
  assert.equal(report.totals.costUsd, 3);
  assert.equal(report.unknownModels.length, 0);

  const table = renderMarkdownTable(report);
  assert.match(table, /\| Phase \| In \| Out \| CacheR \| CacheW \| Cost \|/);
  assert.match(table, /phase-1-setup/);
  assert.match(table, /\$3\.0000/);
  assert.match(table, /\*\*Total\*\*/);
});

test('buildReport: zero-file / zero-usage phases still produce a valid zero-row report', () => {
  const state = {
    schema_version: '1.0',
    cwd: '/fake/cwd',
    phases: [{ phase: 'phase-1-setup', startedAt: isoAt(0), endedAt: isoAt(60000) }],
  };
  const report = buildReport(state, { perPhase: new Map(), unknownModels: new Map() }, isoAt(70000));
  assert.equal(report.phases[0].totals.costUsd, 0);
  assert.deepEqual(report.phases[0].models, {});
  const table = renderMarkdownTable(report);
  assert.match(table, /\*\*Total\*\* \| 0 \| 0 \| 0 \| 0 \| \$0\.0000/);
});

test('buildReport: with zero phases at all, table still has header + totals row', () => {
  const state = { schema_version: '1.0', cwd: '/fake/cwd', phases: [] };
  const report = buildReport(state, { perPhase: new Map(), unknownModels: new Map() }, isoAt(0));
  const table = renderMarkdownTable(report);
  const lines = table.split('\n');
  assert.equal(lines.length, 3); // header, separator, totals row
  assert.match(lines[2], /\*\*Total\*\*/);
});

// ---------------------------------------------------------------------------
// main() — mark
// ---------------------------------------------------------------------------

test('main(): mark requires --state, --phase, --event', () => {
  const code = main(['node', 'spec-cost.mjs', 'mark', '--state', join(tmpdir(), 'x.json')]);
  assert.equal(code, 1);
});

test('main(): mark rejects an invalid --event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-cost-mark-'));
  try {
    const statePath = join(dir, 'cost-log.json');
    const code = main(['node', 'spec-cost.mjs', 'mark', '--state', statePath, '--phase', 'phase-1-setup', '--event', 'pause']);
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main(): --help prints usage and returns 0', () => {
  const code = main(['node', 'spec-cost.mjs', '--help']);
  assert.equal(code, 0);
});

test('main(): no command prints usage to stderr and returns 1', () => {
  const code = main(['node', 'spec-cost.mjs']);
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------
// CLI integration: mark x3 + report against a fixtures dir
// ---------------------------------------------------------------------------

test('CLI: mark start/end sequencing creates state file + parent dir on first mark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-cost-cli-'));
  try {
    const statePath = join(dir, 'nested', 'cost-log.json');
    const r1 = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'phase-1-setup', '--event', 'start',
    ], { encoding: 'utf8' });
    assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
    assert.ok(existsSync(statePath));

    const r2 = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'phase-1-setup', '--event', 'end',
    ], { encoding: 'utf8' });
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.phases.length, 1);
    assert.equal(state.phases[0].phase, 'phase-1-setup');
    assert.ok(state.phases[0].startedAt);
    assert.ok(state.phases[0].endedAt);
    assert.ok(state.cwd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: mark x3 (setup start, setup end/pipeline start via auto-close, pipeline end) then report against a fixtures dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-cost-cli-'));
  const projectsDir = mkdtempSync(join(tmpdir(), 'spec-cost-cli-projects-'));
  try {
    const statePath = join(dir, 'cost-log.json');

    let r = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'phase-1-setup', '--event', 'start',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    r = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'phase-2-pipeline', '--event', 'start',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    r = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'phase-2-pipeline', '--event', 'end',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.phases.length, 2);
    assert.ok(state.phases[0].endedAt); // auto-closed by phase-2 start
    assert.ok(state.phases[1].endedAt);

    // Fabricate a transcript file landing inside phase-2's window.
    const sessionDir = join(projectsDir, 'sess-1', 'subagents');
    mkdirSync(sessionDir, { recursive: true });
    const jsonlFile = join(sessionDir, 'agent-x.jsonl');
    writeFileSync(jsonlFile, usageLine('m1', 'claude-sonnet-5', { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 100 }));
    const midpoint = (Date.parse(state.phases[1].startedAt) + Date.parse(state.phases[1].endedAt)) / 2;
    utimesSync(jsonlFile, midpoint / 1000, midpoint / 1000);

    const rr = spawnSync(process.execPath, [
      CLI, 'report', '--state', statePath, '--projects-dir', projectsDir,
    ], { encoding: 'utf8' });
    assert.equal(rr.status, 0, `stderr: ${rr.stderr}`);
    assert.match(rr.stdout, /\| Phase \| In \| Out \| CacheR \| CacheW \| Cost \|/);
    assert.match(rr.stdout, /phase-2-pipeline/);
    assert.match(rr.stdout, /\*\*Total\*\*/);

    const reportPath = join(dir, 'cost-report.json');
    assert.ok(existsSync(reportPath));
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const p2 = report.phases.find((p) => p.phase === 'phase-2-pipeline');
    assert.equal(p2.models['claude-sonnet-5'].inputTokens, 2000);
    assert.ok(p2.totals.costUsd > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('CLI: report against a missing projects dir writes a zero-row report and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-cost-cli-'));
  try {
    const statePath = join(dir, 'cost-log.json');
    let r = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'lite', '--event', 'start',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'lite', '--event', 'end',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    const missingProjectsDir = join(dir, 'no-such-projects-dir');
    const rr = spawnSync(process.execPath, [
      CLI, 'report', '--state', statePath, '--projects-dir', missingProjectsDir,
    ], { encoding: 'utf8' });
    assert.equal(rr.status, 0, `stderr: ${rr.stderr}`);
    assert.match(rr.stderr, /projects dir not found/);
    assert.match(rr.stdout, /\*\*Total\*\* \| 0 \| 0 \| 0 \| 0 \| \$0\.0000/);

    const report = JSON.parse(readFileSync(join(dir, 'cost-report.json'), 'utf8'));
    assert.equal(report.totals.costUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: end with no open phase warns on stderr but exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-cost-cli-'));
  try {
    const statePath = join(dir, 'cost-log.json');
    const r = spawnSync(process.execPath, [
      CLI, 'mark', '--state', statePath, '--phase', 'phase-9-final', '--event', 'end',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no open phase entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No external deps
// ---------------------------------------------------------------------------

test('spec-cost.mjs imports only node: built-ins and the local pricing module', () => {
  const src = readFileSync(CLI, 'utf8');
  const imports = src.match(/^import .+ from ['"](.+)['"];?\s*$/gm) || [];
  for (const imp of imports) {
    const ok = /from ['"]node:/.test(imp) || /from ['"]\.\/pricing\.mjs['"]/.test(imp);
    assert.ok(ok, `disallowed import: ${imp}`);
  }
});
