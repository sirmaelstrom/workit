// render-synthesis.test.mjs — unit + integration tests for WP-03.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, statSync, readdirSync, writeFileSync,
  mkdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  slugForGoal, ensureDir, validateSynthesis, buildPickPrompt,
} from '../scripts/render-synthesis.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const RENDERER = join(__dirname, '..', 'scripts', 'render-synthesis.mjs');
const TEMPLATE = join(__dirname, '..', 'scripts', 'synthesis-template.html');

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test('slugForGoal: standard goal produces kebab + UTC timestamp', () => {
  const slug = slugForGoal(
    'Design the authentication boundary',
    new Date('2026-05-13T14:50:32Z')
  );
  assert.match(slug, /^design-the-authentication-boundary-20260513-145032$/);
});

test('slugForGoal: long goal truncates at word boundary', () => {
  const slug = slugForGoal(
    'a goal that is much much longer than forty characters total really',
    new Date('2026-05-13T14:50:32Z')
  );
  // Kebab portion should be "a-goal-that-is-much-much-longer-than" (36 chars).
  assert.equal(slug, 'a-goal-that-is-much-much-longer-than-20260513-145032');
});

test('slugForGoal: exactly-40-char kebab is NOT backed up', () => {
  const goal = 'design auth boundary admin console api v';
  // Kebab: "design-auth-boundary-admin-console-api-v" — exactly 40 chars.
  const slug = slugForGoal(goal, new Date('2026-05-13T14:50:32Z'));
  const kebab = slug.replace(/-20260513-145032$/, '');
  assert.equal(kebab.length, 40, `expected exactly 40 chars, got ${kebab.length}: ${kebab}`);
  assert.equal(kebab, 'design-auth-boundary-admin-console-api-v');
});

test('slugForGoal: empty goal yields explore- prefix', () => {
  const slug = slugForGoal('', new Date('2026-05-13T14:50:32Z'));
  assert.match(slug, /^explore-\d{8}-\d{6}$/);
});

test('slugForGoal: whitespace-only goal yields explore- prefix', () => {
  const slug = slugForGoal('   ', new Date('2026-05-13T14:50:32Z'));
  assert.match(slug, /^explore-\d{8}-\d{6}$/);
});

test('slugForGoal: differs across timestamps 1s apart', () => {
  const t1 = new Date('2026-05-13T14:50:32Z');
  const t2 = new Date('2026-05-13T14:50:33Z');
  assert.notEqual(slugForGoal('same goal', t1), slugForGoal('same goal', t2));
});

test('ensureDir: creates 3-level-deep path and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pe-ensuredir-'));
  const target = join(root, 'a', 'b', 'c');
  ensureDir(target);
  assert.ok(existsSync(target), 'directory should exist after first call');
  // Second call must not throw.
  assert.doesNotThrow(() => ensureDir(target));
  assert.ok(existsSync(target), 'directory should still exist after second call');
  rmSync(root, { recursive: true, force: true });
});

test('validateSynthesis: accepts the example fixture', () => {
  const example = JSON.parse(readFileSync(join(FIXTURES, 'synthesis-example.json'), 'utf8'));
  assert.doesNotThrow(() => validateSynthesis(example));
});

test('validateSynthesis: throws on malformed fixture (recommendation.branch_id not in branches)', () => {
  const malformed = JSON.parse(readFileSync(join(FIXTURES, 'synthesis-malformed.json'), 'utf8'));
  assert.throws(() => validateSynthesis(malformed), /branch_id/);
});

test('buildPickPrompt case A: displayIndex=1, branch-1, no off-by-one', () => {
  const branchA = {
    id: 'branch-1',
    title: 'Session-based auth',
    thesis: 'Server-side state simplifies revocation',
  };
  const output = buildPickPrompt(branchA, 1, '/tmp/x/synthesis.md', '/tmp/x/results');
  assert.match(output, /Branch 1:/);
  assert.match(output, /"Session-based auth"/);
  assert.match(output, /\/tmp\/x\/results\/branch-1\.md/);
  assert.equal(output.includes('{'), false, 'no unsubstituted { remaining');
  assert.equal(output.includes('}'), false, 'no unsubstituted } remaining');
});

test('buildPickPrompt case B: displayIndex=2, multi-word title + thesis', () => {
  const branchB = {
    id: 'branch-2',
    title: 'Token-based auth',
    thesis: 'Stateless verification scales horizontally',
  };
  const output = buildPickPrompt(branchB, 2, '/tmp/x/synthesis.md', '/tmp/x/results');
  assert.match(output, /Branch 2:/);
  assert.match(output, /"Token-based auth"/);
  assert.match(output, /Stateless verification scales horizontally/);
  assert.match(output, /\/tmp\/x\/synthesis\.md/);
  assert.match(output, /\/tmp\/x\/results\/branch-2\.md/);
  assert.equal(output.includes('{'), false);
  assert.equal(output.includes('}'), false);
});

// ---------------------------------------------------------------------------
// Integration tests (renderer end-to-end)
// ---------------------------------------------------------------------------

function runRenderer(input, outDir) {
  return spawnSync(process.execPath, [RENDERER, '--input', input, '--output-dir', outDir]);
}

test('integration: renders both files, non-empty (md > 1KB, html > 4KB)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-render-'));
  const res = runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  assert.equal(res.status, 0, `renderer exit non-zero: ${res.stderr}`);
  const mdPath = join(outDir, 'synthesis.md');
  const htmlPath = join(outDir, 'synthesis.html');
  assert.ok(existsSync(mdPath), 'synthesis.md should exist');
  assert.ok(existsSync(htmlPath), 'synthesis.html should exist');
  assert.ok(statSync(mdPath).size > 1024, `synthesis.md too small: ${statSync(mdPath).size}`);
  assert.ok(statSync(htmlPath).size > 4096, `synthesis.html too small: ${statSync(htmlPath).size}`);
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: determinism — same --output-dir, byte-identical across runs', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-det-'));
  const input = join(FIXTURES, 'synthesis-example.json');
  const r1 = runRenderer(input, outDir);
  assert.equal(r1.status, 0, `first run failed: ${r1.stderr}`);
  const html1 = readFileSync(join(outDir, 'synthesis.html'));
  const md1 = readFileSync(join(outDir, 'synthesis.md'));
  rmSync(join(outDir, 'synthesis.html'));
  rmSync(join(outDir, 'synthesis.md'));
  const r2 = runRenderer(input, outDir);
  assert.equal(r2.status, 0, `second run failed: ${r2.stderr}`);
  const html2 = readFileSync(join(outDir, 'synthesis.html'));
  const md2 = readFileSync(join(outDir, 'synthesis.md'));
  assert.ok(html1.equals(html2), 'synthesis.html must be byte-identical across runs (same output-dir)');
  assert.ok(md1.equals(md2), 'synthesis.md must be byte-identical across runs (same output-dir)');
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: no external assets (M2, MN4)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-noext-'));
  runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  const html = readFileSync(join(outDir, 'synthesis.html'), 'utf8');
  const banned = [
    '<link rel="stylesheet"',
    '<script src=',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
    'https://cdnjs.',
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
  ];
  for (const b of banned) {
    assert.equal(html.includes(b), false, `HTML must not contain "${b}"`);
  }
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: pick-branch buttons (V6) match branch count and have non-empty data-pick-prompt', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-pick-'));
  runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  const html = readFileSync(join(outDir, 'synthesis.html'), 'utf8');
  const example = JSON.parse(readFileSync(join(FIXTURES, 'synthesis-example.json'), 'utf8'));

  const buttonMatches = html.match(/<button class="pick-branch-btn"[^>]*data-pick-prompt="([^"]*)"/g) || [];
  assert.equal(buttonMatches.length, example.branches.length, 'one button per branch');

  // Extract data-pick-prompt values.
  const re = /<button class="pick-branch-btn"[^>]*data-pick-prompt="([^"]*)"/g;
  const prompts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    prompts.push(m[1]);
  }
  for (const p of prompts) {
    assert.ok(p.length > 0, 'data-pick-prompt must be non-empty');
  }
  // At least one prompt contains a branch's title text (HTML-decoded).
  const titles = example.branches.map((b) => b.title);
  const decoded = prompts.map((p) =>
    p.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );
  const anyMatch = decoded.some((d) => titles.some((t) => d.includes(t)));
  assert.ok(anyMatch, 'at least one data-pick-prompt should contain a branch title');
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: recommendation visual (V4) — exactly one ★ Recommended, recommended class, recommended-col', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-rec-'));
  runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  const html = readFileSync(join(outDir, 'synthesis.html'), 'utf8');
  const example = JSON.parse(readFileSync(join(FIXTURES, 'synthesis-example.json'), 'utf8'));
  const recId = example.recommendation.branch_id;

  const recMatches = html.match(/★ Recommended/g) || [];
  assert.equal(recMatches.length, 1, `expected exactly one ★ Recommended literal, got ${recMatches.length}`);

  // Recommended branch tile has class "recommended".
  const tileRe = new RegExp(`<article class="branch-tile ([^"]*)" data-branch-id="${recId}"`);
  const tileMatch = html.match(tileRe);
  assert.ok(tileMatch, `tile for recommended branch ${recId} should exist`);
  assert.ok(tileMatch[1].includes('recommended'), 'recommended tile must have "recommended" class');

  // Matrix has at least one td with score-? + recommended-col.
  const matrixCellRe = /<td class="matrix-cell score-\d[^"]*recommended-col[^"]*"/;
  assert.match(html, matrixCellRe, 'matrix should have at least one recommended-col cell');
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: color ramp (V3, V8) — score-1 and score-5 classes + hex codes', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-color-'));
  runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  const html = readFileSync(join(outDir, 'synthesis.html'), 'utf8');
  assert.ok(html.includes('score-1'), 'score-1 class missing');
  assert.ok(html.includes('score-5'), 'score-5 class missing');
  assert.ok(html.includes('#fca5a5'), 'score-1 hex (#fca5a5) missing');
  assert.ok(html.includes('#4ade80'), 'score-5 hex (#4ade80) missing');
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: hybrid structuring (V5) — hidden_assumptions yields <strong> and <code>', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-hybrid-'));
  runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  const html = readFileSync(join(outDir, 'synthesis.html'), 'utf8');
  assert.match(html, /<ul>/, 'expected at least one <ul> from markdown lists');
  assert.match(html, /<strong>/, 'expected at least one <strong> from hidden_assumptions bold');
  assert.match(html, /<code>/, 'expected at least one <code> from hidden_assumptions inline code');
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: malformed input — non-zero exit, stderr mentions recommendation or branch_id', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pe-bad-'));
  const res = runRenderer(join(FIXTURES, 'synthesis-malformed.json'), outDir);
  assert.notEqual(res.status, 0, 'renderer must exit non-zero on malformed input');
  const stderr = String(res.stderr);
  assert.match(stderr, /recommendation|branch_id/, `stderr must mention recommendation or branch_id, got: ${stderr}`);
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: missing flag — non-zero exit, stderr mentions --input', () => {
  const res = spawnSync(process.execPath, [RENDERER]);
  assert.notEqual(res.status, 0, 'renderer must exit non-zero with no args');
  const stderr = String(res.stderr);
  assert.match(stderr, /--input/, `stderr must mention --input, got: ${stderr}`);
});

test('integration: template separation (V10) — template file exists, renderer reads it', () => {
  // Simpler form per spec: template file exists on disk, and the renderer source
  // contains a readFileSync call referencing the template filename.
  assert.ok(existsSync(TEMPLATE), 'synthesis-template.html must exist on disk');
  const rendererSrc = readFileSync(RENDERER, 'utf8');
  assert.match(rendererSrc, /readFileSync/, 'renderer source must call readFileSync');
  assert.match(rendererSrc, /synthesis-template\.html/, 'renderer source must reference synthesis-template.html');

  // Also confirm a template-only substring appears in rendered HTML.
  const outDir = mkdtempSync(join(tmpdir(), 'pe-tmpl-'));
  runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  const html = readFileSync(join(outDir, 'synthesis.html'), 'utf8');
  assert.match(html, /<div id="toast"/, 'rendered HTML should contain template-only marker');
  rmSync(outDir, { recursive: true, force: true });
});

test('integration: MN5 run-dir scope — renderer writes only inside --output-dir', () => {
  const sentinel = mkdtempSync(join(tmpdir(), 'pe-mn5-sentinel-'));
  const outDir = join(sentinel, 'run');
  mkdirSync(outDir);
  writeFileSync(join(sentinel, 'marker.txt'), 'pre-run');
  const before = readdirSync(sentinel).sort().join('|');
  const res = runRenderer(join(FIXTURES, 'synthesis-example.json'), outDir);
  assert.equal(res.status, 0, `renderer must succeed: ${res.stderr}`);
  const after = readdirSync(sentinel).sort().join('|');
  assert.equal(before, after, 'renderer must not create or delete sibling files');
  assert.equal(
    readFileSync(join(sentinel, 'marker.txt'), 'utf8'),
    'pre-run',
    'marker file must remain unchanged'
  );
  rmSync(sentinel, { recursive: true, force: true });
});
