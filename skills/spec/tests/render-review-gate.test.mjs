// render-review-gate.test.mjs — unit + integration tests for the /spec Phase 4 review-gate renderer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ensureDir, validateReviewGate, sanitizeDomId, buildAttrPath,
  renderMarkdown, renderHtml, main,
} from '../scripts/render-review-gate.mjs';
import { mdToHtml, escapeHtml } from '../../_shared/markdown-mini.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const RENDERER = join(__dirname, '..', 'scripts', 'render-review-gate.mjs');
const TEMPLATE = join(__dirname, '..', 'scripts', 'review-gate-template.html');

function loadExample() {
  return JSON.parse(readFileSync(join(FIXTURES, 'review-gate-example.json'), 'utf8'));
}

function loadTemplate() {
  return readFileSync(TEMPLATE, 'utf8');
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

test('sanitizeDomId replaces non-alphanumeric chars with underscore', () => {
  assert.equal(sanitizeDomId('D1'), 'D1');
  assert.equal(sanitizeDomId('cmd:git:commit'), 'cmd_git_commit');
  assert.equal(sanitizeDomId('a/b\\c'), 'a_b_c');
  assert.equal(sanitizeDomId('keep-dashes_and_underscores'), 'keep-dashes_and_underscores');
});

test('buildAttrPath normalizes backslashes', () => {
  assert.equal(buildAttrPath('D:\\foo\\bar'), 'D:/foo/bar');
  assert.equal(buildAttrPath('D:/already-forward'), 'D:/already-forward');
  assert.equal(buildAttrPath(''), '');
});

test('ensureDir creates 3-level-deep path and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'rg-ensuredir-'));
  const target = join(root, 'a', 'b', 'c');
  ensureDir(target);
  assert.ok(existsSync(target));
  assert.doesNotThrow(() => ensureDir(target));
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateReviewGate — happy path
// ---------------------------------------------------------------------------

test('validateReviewGate accepts the example fixture', () => {
  const ex = loadExample();
  assert.doesNotThrow(() => validateReviewGate(ex));
});

// ---------------------------------------------------------------------------
// validateReviewGate — Layer 1
// ---------------------------------------------------------------------------

test('validateReviewGate rejects null', () => {
  assert.throws(() => validateReviewGate(null), /must be an object/);
});

test('validateReviewGate rejects wrong schema_version', () => {
  const bad = { ...loadExample(), schema_version: '2.0' };
  assert.throws(() => validateReviewGate(bad), /unsupported schema_version/);
});

test('validateReviewGate rejects missing top-level field', () => {
  const bad = loadExample();
  delete bad.flagged_items;
  assert.throws(() => validateReviewGate(bad), /missing required field: flagged_items/);
});

test('validateReviewGate rejects missing spec.dir', () => {
  const bad = loadExample();
  delete bad.spec.dir;
  assert.throws(() => validateReviewGate(bad), /spec missing field: dir/);
});

// ---------------------------------------------------------------------------
// validateReviewGate — Layer 2
// ---------------------------------------------------------------------------

test('validateReviewGate rejects invalid review_level', () => {
  const bad = { ...loadExample(), review_level: 'partial' };
  assert.throws(() => validateReviewGate(bad), /review_level must be one of/);
});

test('validateReviewGate rejects non-array flagged_items', () => {
  const bad = { ...loadExample(), flagged_items: 'not-an-array' };
  assert.throws(() => validateReviewGate(bad), /flagged_items must be an array/);
});

test('validateReviewGate rejects invalid item kind', () => {
  const bad = loadExample();
  bad.flagged_items[0].kind = 'NOTE';
  assert.throws(() => validateReviewGate(bad), /must be DECISION or ASSUMPTION/);
});

test('validateReviewGate rejects invalid default_action', () => {
  const bad = loadExample();
  bad.flagged_items[0].default_action = 'ponder';
  assert.throws(() => validateReviewGate(bad), /default_action must be one of/);
});

test('validateReviewGate rejects non-string compile_template', () => {
  const bad = { ...loadExample(), compile_template: 42 };
  assert.throws(() => validateReviewGate(bad), /compile_template must be a string/);
});

test('validateReviewGate rejects non-array summary.key_decisions', () => {
  const bad = loadExample();
  bad.summary.key_decisions = 'D1, D2, D3';
  assert.throws(() => validateReviewGate(bad), /summary\.key_decisions must be an array/);
});

test('validateReviewGate rejects empty item id', () => {
  const bad = loadExample();
  bad.flagged_items[0].id = '';
  assert.throws(() => validateReviewGate(bad), /must be a non-empty string/);
});

// ---------------------------------------------------------------------------
// validateReviewGate — Layer 3
// ---------------------------------------------------------------------------

test('validateReviewGate rejects duplicate item ids', () => {
  const bad = loadExample();
  bad.flagged_items[1].id = bad.flagged_items[0].id;
  assert.throws(() => validateReviewGate(bad), /is duplicated/);
});

test('validateReviewGate rejects compile_template missing {decisions_blob}', () => {
  const bad = loadExample();
  bad.compile_template = 'no token in this template';
  assert.throws(() => validateReviewGate(bad), /compile_template must contain \{decisions_blob\}/);
});

test('validateReviewGate rejects the malformed fixture (duplicate ids)', () => {
  const bad = JSON.parse(readFileSync(join(FIXTURES, 'review-gate-malformed.json'), 'utf8'));
  assert.throws(() => validateReviewGate(bad), /is duplicated/);
});

// ---------------------------------------------------------------------------
// renderHtml: structural artifacts
// ---------------------------------------------------------------------------

test('renderHtml substitutes all server-side template tokens (no leftover {{...}})', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  const unresolved = html.match(/\{\{[a-z_]+\}\}/g);
  assert.equal(unresolved, null, `unresolved tokens: ${unresolved && unresolved.join(',')}`);
});

test('renderHtml: every item produces an item-card', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  const count = (html.match(/class="item-card item-(decision|assumption)"/g) || []).length;
  assert.equal(count, ex.flagged_items.length);
});

test('renderHtml: DECISION items get item-decision class; ASSUMPTION items get item-assumption', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  const dCount = (html.match(/class="item-card item-decision"/g) || []).length;
  const aCount = (html.match(/class="item-card item-assumption"/g) || []).length;
  const expectedD = ex.flagged_items.filter(i => i.kind === 'DECISION').length;
  const expectedA = ex.flagged_items.filter(i => i.kind === 'ASSUMPTION').length;
  assert.equal(dCount, expectedD);
  assert.equal(aCount, expectedA);
});

test('renderHtml: default_action pre-checks the corresponding radio', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  const itemsWithDefault = ex.flagged_items.filter(i => i.default_action != null);
  assert.ok(itemsWithDefault.length >= 1);
  for (const it of itemsWithDefault) {
    const domId = sanitizeDomId(it.id);
    const re = new RegExp(`name="decision-${domId}" value="${it.default_action}" checked`);
    assert.match(html, re, `expected pre-checked ${it.default_action} for item ${it.id}`);
  }
});

test('renderHtml: items without default_action have no checked radio', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  const noDefault = ex.flagged_items.filter(i => i.default_action == null);
  assert.ok(noDefault.length >= 1);
  for (const it of noDefault) {
    const domId = sanitizeDomId(it.id);
    const re = new RegExp(`name="decision-${domId}"[^>]*checked`);
    assert.doesNotMatch(html, re, `unexpected pre-checked radio for item ${it.id}`);
  }
});

test('renderHtml: spec.title with special chars is HTML-escaped', () => {
  const ex = loadExample();
  ex.spec.title = 'Title & <b>html</b> "quote"';
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  assert.match(html, /Title &amp; &lt;b&gt;html&lt;\/b&gt; &quot;quote&quot;/);
});

test('renderHtml: compile_template is attribute-escaped inside data-compile-template', () => {
  const ex = loadExample();
  ex.compile_template = 'X & Y < Z > "quote" with {decisions_blob}';
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  // The attribute value must contain &amp; &lt; &gt; &quot; — never raw < or " inside the attribute body.
  const m = html.match(/data-compile-template="([^"]*)"/);
  assert.ok(m, 'expected data-compile-template attribute');
  assert.match(m[1], /&amp;/);
  assert.match(m[1], /&lt;/);
  assert.match(m[1], /&gt;/);
  assert.match(m[1], /&quot;/);
  assert.doesNotMatch(m[1], /[<"]/);
});

test('renderHtml: spec.dir backslashes are normalized in attribute paths', () => {
  const ex = loadExample();
  ex.spec.dir = 'D:\\foo\\bar';
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  // The meta-for-js block carries spec_dir; check forward slashes inside it.
  const m = html.match(/var META = (\{[^;]*\});/);
  assert.ok(m, 'expected META object in inline script');
  assert.match(m[1], /"spec_dir":"D:\/foo\/bar"/);
});

test('renderHtml: items_for_js carries the sanitized ids', () => {
  const ex = loadExample();
  // Push an item with a colon in its id to exercise sanitization.
  ex.flagged_items.push({
    id: 'crazy:id/path',
    kind: 'DECISION',
    title: 'Sanitization smoke',
    context: 'x',
  });
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml);
  const m = html.match(/var ITEMS = (\[[^;]*\]);/);
  assert.ok(m, 'expected ITEMS array');
  assert.match(m[1], /"crazy_id_path"/);
  assert.doesNotMatch(m[1], /crazy:id\/path/);
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

test('renderMarkdown emits a section per flagged item', () => {
  const ex = loadExample();
  const md = renderMarkdown(ex);
  for (const it of ex.flagged_items) {
    const escaped = it.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(md, new RegExp(`### ${escaped} \\(${it.kind}\\)`));
  }
});

test('renderMarkdown is deterministic', () => {
  const ex = loadExample();
  assert.equal(renderMarkdown(ex), renderMarkdown(ex));
});

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

test('main() is synchronous and returns an integer for --help', () => {
  const code = main(['node', 'render-review-gate.mjs', '--help']);
  assert.equal(typeof code, 'number');
  assert.equal(code, 0);
});

test('main() returns 1 when --input missing', () => {
  const code = main(['node', 'render-review-gate.mjs', '--output-dir', '/tmp/out']);
  assert.equal(code, 1);
});

test('main() returns 1 when --output-dir missing', () => {
  const code = main(['node', 'render-review-gate.mjs', '--input', '/dev/null']);
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

test('CLI renders example fixture into review-gate.md + review-gate.html', () => {
  const out = mkdtempSync(join(tmpdir(), 'rg-render-'));
  try {
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', join(FIXTURES, 'review-gate-example.json'),
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(out, 'review-gate.md')));
    assert.ok(existsSync(join(out, 'review-gate.html')));
    const html = readFileSync(join(out, 'review-gate.html'), 'utf8');
    assert.ok(html.includes('Spec review gate'));
    assert.ok(html.includes('id="compile-btn"'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: malformed fixture fails with stderr about duplicate id', () => {
  const out = mkdtempSync(join(tmpdir(), 'rg-render-'));
  try {
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', join(FIXTURES, 'review-gate-malformed.json'),
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is duplicated/);
    assert.ok(!existsSync(join(out, 'review-gate.html')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: same input + same output-dir produces byte-identical HTML', () => {
  const out = mkdtempSync(join(tmpdir(), 'rg-render-'));
  try {
    const args = [
      RENDERER,
      '--input', join(FIXTURES, 'review-gate-example.json'),
      '--output-dir', out,
    ];
    const r1 = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(r1.status, 0);
    const html1 = readFileSync(join(out, 'review-gate.html'));
    const r2 = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(r2.status, 0);
    const html2 = readFileSync(join(out, 'review-gate.html'));
    assert.ok(html1.equals(html2), 'HTML differs between runs with the same input + output-dir');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: missing --input file produces clear stderr', () => {
  const out = mkdtempSync(join(tmpdir(), 'rg-render-'));
  try {
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', join(out, 'does-not-exist.json'),
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /failed to read --input/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: invalid JSON produces clear stderr', () => {
  const out = mkdtempSync(join(tmpdir(), 'rg-render-'));
  try {
    const badPath = join(out, 'bad.json');
    writeFileSync(badPath, '{ broken');
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', badPath,
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /failed to parse JSON/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: compile_template missing optional tokens triggers warning (but exit 0)', () => {
  const out = mkdtempSync(join(tmpdir(), 'rg-render-'));
  try {
    const inPath = join(out, 'minimal.json');
    const ex = loadExample();
    ex.compile_template = 'Just {decisions_blob}'; // missing {spec_slug}, {general_feedback}
    writeFileSync(inPath, JSON.stringify(ex));
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', inPath,
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /does not contain \{spec_slug\}/);
    assert.match(r.stderr, /does not contain \{general_feedback\}/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No external deps
// ---------------------------------------------------------------------------

test('render-review-gate.mjs imports only node: built-ins and the local markdown-mini', () => {
  const src = readFileSync(RENDERER, 'utf8');
  const imports = src.match(/^import .+ from ['"](.+)['"];?\s*$/gm) || [];
  for (const imp of imports) {
    const ok = /from ['"]node:/.test(imp) || /from ['"]\.\.\/\.\.\/_shared\/markdown-mini\.mjs['"]/.test(imp);
    assert.ok(ok, `disallowed import: ${imp}`);
  }
});
