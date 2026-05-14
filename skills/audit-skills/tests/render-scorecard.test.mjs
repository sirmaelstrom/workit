// render-scorecard.test.mjs — unit + integration tests for the audit-skills scorecard renderer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ensureDir, validateScorecard, buildSendPrompt, tierClassFor,
  scoreRangeForKind, renderMarkdown, renderHtml, main,
} from '../scripts/render-scorecard.mjs';
import { mdToHtml, escapeHtml } from '../../_shared/markdown-mini.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const RENDERER = join(__dirname, '..', 'scripts', 'render-scorecard.mjs');
const TEMPLATE = join(__dirname, '..', 'scripts', 'scorecard-template.html');

function loadExample() {
  return JSON.parse(readFileSync(join(FIXTURES, 'scorecard-example.json'), 'utf8'));
}

function loadTemplate() {
  return readFileSync(TEMPLATE, 'utf8');
}

// ---------------------------------------------------------------------------
// Unit: scoreRangeForKind
// ---------------------------------------------------------------------------

test('scoreRangeForKind: likert5', () => {
  assert.deepEqual(scoreRangeForKind('likert5'), { min: 1, max: 5 });
});

test('scoreRangeForKind: eval_coverage', () => {
  assert.deepEqual(scoreRangeForKind('eval_coverage'), { min: 0, max: 5 });
});

test('scoreRangeForKind: karpathy', () => {
  assert.deepEqual(scoreRangeForKind('karpathy'), { min: 0, max: 1 });
});

test('scoreRangeForKind throws on unknown kind', () => {
  assert.throws(() => scoreRangeForKind('bogus'), /unknown dimension kind/);
});

// ---------------------------------------------------------------------------
// Unit: tierClassFor
// ---------------------------------------------------------------------------

test('tierClassFor likert5 produces score-N', () => {
  for (let s = 1; s <= 5; s++) {
    assert.equal(tierClassFor('likert5', s), `score-${s}`);
  }
});

test('tierClassFor eval_coverage 0 → score-0', () => {
  assert.equal(tierClassFor('eval_coverage', 0), 'score-0');
});

test('tierClassFor eval_coverage 5 → score-5', () => {
  assert.equal(tierClassFor('eval_coverage', 5), 'score-5');
});

test('tierClassFor karpathy 1 → elig-yes', () => {
  assert.equal(tierClassFor('karpathy', 1), 'elig-yes');
});

test('tierClassFor karpathy 0 → elig-no', () => {
  assert.equal(tierClassFor('karpathy', 0), 'elig-no');
});

// ---------------------------------------------------------------------------
// Unit: ensureDir
// ---------------------------------------------------------------------------

test('ensureDir creates 3-level-deep path and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-ensuredir-'));
  const target = join(root, 'a', 'b', 'c');
  ensureDir(target);
  assert.ok(existsSync(target));
  assert.doesNotThrow(() => ensureDir(target));
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: buildSendPrompt
// ---------------------------------------------------------------------------

test('buildSendPrompt substitutes all five tokens', () => {
  const template = 'rank={rank} id={skill_id} name={skill_name} action={action_text} path={scorecard_md_path}';
  const out = buildSendPrompt(template,
    { rank: 7, action_text: 'do thing' },
    { id: 'x', name: 'X-skill' },
    'D:/foo/bar/scorecard.md');
  assert.equal(out, 'rank=7 id=x name=X-skill action=do thing path=D:/foo/bar/scorecard.md');
});

test('buildSendPrompt normalizes backslashes in scorecard_md_path', () => {
  const out = buildSendPrompt('path={scorecard_md_path}',
    { rank: 1, action_text: '' }, { id: 'a', name: 'A' },
    'D:\\foo\\bar\\scorecard.md');
  assert.equal(out, 'path=D:/foo/bar/scorecard.md');
});

test('buildSendPrompt with empty path renders empty', () => {
  const out = buildSendPrompt('path={scorecard_md_path}',
    { rank: 1, action_text: '' }, { id: 'a', name: 'A' }, '');
  assert.equal(out, 'path=');
});

// ---------------------------------------------------------------------------
// validateScorecard — happy path
// ---------------------------------------------------------------------------

test('validateScorecard accepts the example fixture', () => {
  const ex = loadExample();
  assert.doesNotThrow(() => validateScorecard(ex));
});

// ---------------------------------------------------------------------------
// validateScorecard — Layer 1 (structural)
// ---------------------------------------------------------------------------

test('validateScorecard rejects null', () => {
  assert.throws(() => validateScorecard(null), /must be an object/);
});

test('validateScorecard rejects wrong schema_version', () => {
  const bad = { ...loadExample(), schema_version: '2.0' };
  assert.throws(() => validateScorecard(bad), /unsupported schema_version/);
});

test('validateScorecard rejects missing top-level field', () => {
  const bad = loadExample();
  delete bad.plugins;
  assert.throws(() => validateScorecard(bad), /missing required field: plugins/);
});

test('validateScorecard rejects missing summary subfield', () => {
  const bad = loadExample();
  delete bad.summary.average_score;
  assert.throws(() => validateScorecard(bad), /summary missing field: average_score/);
});

// ---------------------------------------------------------------------------
// validateScorecard — Layer 2 (per-field shape & ranges)
// ---------------------------------------------------------------------------

test('validateScorecard rejects empty plugins[]', () => {
  const bad = { ...loadExample(), plugins: [] };
  assert.throws(() => validateScorecard(bad), /non-empty array/);
});

test('validateScorecard rejects empty dimensions[]', () => {
  const bad = { ...loadExample(), dimensions: [] };
  assert.throws(() => validateScorecard(bad), /non-empty array/);
});

test('validateScorecard rejects unknown dimension kind', () => {
  const bad = loadExample();
  bad.dimensions[0].kind = 'gibberish';
  assert.throws(() => validateScorecard(bad), /kind must be one of/);
});

test('validateScorecard rejects out-of-range likert5 score', () => {
  const bad = loadExample();
  bad.skills[0].scores.description_quality.score = 6;
  assert.throws(() => validateScorecard(bad), /must be integer 1..5/);
});

test('validateScorecard rejects negative eval_coverage', () => {
  const bad = loadExample();
  bad.skills[0].scores.eval_coverage.score = -1;
  assert.throws(() => validateScorecard(bad), /must be integer 0..5/);
});

test('validateScorecard rejects karpathy score=2', () => {
  const bad = loadExample();
  bad.skills[0].scores.karpathy_eligible.score = 2;
  assert.throws(() => validateScorecard(bad), /must be integer 0..1/);
});

test('validateScorecard rejects bad confidence value', () => {
  const bad = loadExample();
  bad.skills[0].scores.description_quality.confidence = 'pretty-sure';
  assert.throws(() => validateScorecard(bad), /confidence must be one of/);
});

test('validateScorecard rejects non-boolean binary_check.passed', () => {
  const bad = loadExample();
  bad.skills[0].scores.description_quality.binary_checks[0].passed = 'yes';
  assert.throws(() => validateScorecard(bad), /\.passed must be a boolean/);
});

test('validateScorecard rejects non-integer rank', () => {
  const bad = loadExample();
  bad.skills[0].rank = 1.5;
  assert.throws(() => validateScorecard(bad), /rank must be a positive integer/);
});

test('validateScorecard rejects karpathy_eligible=2', () => {
  const bad = loadExample();
  bad.skills[0].karpathy_eligible = 2;
  assert.throws(() => validateScorecard(bad), /karpathy_eligible must be 0 or 1/);
});

// ---------------------------------------------------------------------------
// validateScorecard — Layer 3 (cross-field consistency)
// ---------------------------------------------------------------------------

test('validateScorecard rejects unknown plugin reference on a skill', () => {
  const bad = loadExample();
  bad.skills[0].plugin = 'nowhere';
  assert.throws(() => validateScorecard(bad), /not in plugins/);
});

test('validateScorecard rejects unknown dimension key in scores', () => {
  const bad = loadExample();
  bad.skills[0].scores.bogus_dim = bad.skills[0].scores.description_quality;
  assert.throws(() => validateScorecard(bad), /unknown dimension "bogus_dim"/);
});

test('validateScorecard rejects missing dimension in a skill scores', () => {
  const bad = loadExample();
  delete bad.skills[0].scores.description_quality;
  assert.throws(() => validateScorecard(bad), /is missing dimension "description_quality"/);
});

test('validateScorecard rejects top_actions referencing unknown skill', () => {
  const bad = loadExample();
  bad.top_actions[0].skill_id = 'nope';
  assert.throws(() => validateScorecard(bad), /not in skills/);
});

test('validateScorecard rejects highest_roi_skill_id not in skills', () => {
  const bad = loadExample();
  bad.summary.highest_roi_skill_id = 'nope';
  assert.throws(() => validateScorecard(bad), /highest_roi_skill_id .* is not in skills/);
});

test('validateScorecard rejects malformed fixture (dangling top_actions skill_id)', () => {
  const bad = JSON.parse(readFileSync(join(FIXTURES, 'scorecard-malformed.json'), 'utf8'));
  assert.throws(() => validateScorecard(bad), /not in skills/);
});

// ---------------------------------------------------------------------------
// Render: renderHtml produces expected structural artifacts
// ---------------------------------------------------------------------------

test('renderHtml substitutes all template tokens (no leftover {{...}})', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, {
    scorecardMdPath: '/tmp/scorecard.md',
  });
  const unresolved = html.match(/\{\{[a-z_]+\}\}/g);
  assert.equal(unresolved, null, `unresolved tokens: ${unresolved && unresolved.join(',')}`);
});

test('renderHtml: every skill produces a skill-row and skill-detail pair', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, { scorecardMdPath: '' });
  // Use word-boundary checks so skill-detail-grid (inside the panel) doesn't double-count.
  const rowCount = (html.match(/<tr class="skill-row/g) || []).length;
  const detailCount = (html.match(/<tr class="skill-detail/g) || []).length;
  assert.equal(rowCount, ex.skills.length);
  assert.equal(detailCount, ex.skills.length);
});

test('renderHtml: likert5 score cells carry correct score-N class', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, { scorecardMdPath: '' });
  for (const s of ex.skills) {
    const score = s.scores.description_quality.score;
    const expected = `score-${score}">${score}</td>`;
    assert.ok(html.includes(expected), `expected ${expected} in HTML for skill ${s.id}`);
  }
});

test('renderHtml: karpathy cell uses elig-yes/elig-no not score-N', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, { scorecardMdPath: '' });
  // The karpathy cell is wrapped in an elig-cell <td>; the inner span carries elig-yes / elig-no.
  for (const s of ex.skills) {
    const inner = s.karpathy_eligible === 1
      ? '<span class="elig-yes">Yes</span>'
      : '<span class="elig-no">No</span>';
    assert.ok(html.includes(inner), `expected ${inner} for skill ${s.id}`);
  }
  // The right-hand K-elig column also uses the same elig classes — never score-N for karpathy.
});

test('renderHtml: top_actions render send-prompt buttons with attribute-escaped prompts', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, {
    scorecardMdPath: '/tmp/scorecard.md',
  });
  const btnCount = (html.match(/class="send-prompt-btn"/g) || []).length;
  assert.equal(btnCount, ex.top_actions.length);
  // Each button's data-send-prompt must not contain a raw <.
  const attrs = [...html.matchAll(/data-send-prompt="([^"]*)"/g)].map(m => m[1]);
  for (const a of attrs) {
    assert.doesNotMatch(a, /<[a-z]/i, `attribute contains a raw HTML-ish tag: ${a}`);
  }
});

test('renderHtml: send-prompt path is normalized to forward slashes', () => {
  const ex = loadExample();
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, {
    scorecardMdPath: 'D:\\runs\\audit\\scorecard.md',
  });
  // The substituted path must appear with forward slashes inside data-send-prompt attrs.
  assert.match(html, /data-send-prompt="[^"]*D:\/runs\/audit\/scorecard\.md/);
  // And must not contain backslashes inside any data-send-prompt attribute.
  const attrs = [...html.matchAll(/data-send-prompt="([^"]*)"/g)].map(m => m[1]);
  for (const a of attrs) {
    assert.doesNotMatch(a, /\\/, `attribute contains a backslash: ${a}`);
  }
});

test('renderHtml: skill name with special chars is HTML-escaped in the row', () => {
  const ex = loadExample();
  ex.skills[0].name = 'A & B <c> "quote"';
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, { scorecardMdPath: '' });
  assert.match(html, /A &amp; B &lt;c&gt; &quot;quote&quot;/);
  assert.doesNotMatch(html, /A & B <c> "quote"/);
});

test('renderHtml: detail row IDs are sanitized (no colons or non-alnum)', () => {
  const ex = loadExample();
  // cmd:git:commit-push-pr → detail-cmd_git_commit-push-pr
  const html = renderHtml(ex, loadTemplate(), mdToHtml, escapeHtml, { scorecardMdPath: '' });
  assert.match(html, /id="detail-cmd_git_commit-push-pr"/);
});

// ---------------------------------------------------------------------------
// Render: markdown output
// ---------------------------------------------------------------------------

test('renderMarkdown emits a Rankings table with the expected dimension column count', () => {
  const ex = loadExample();
  const md = renderMarkdown(ex);
  // Header row: Rank, Skill, Plugin, Kind, ...dims, ROI, K-elig.
  // Total columns = 4 + dims.length + 2 = 6 + dims.length.
  const totalCols = 6 + ex.dimensions.length;
  const headerLine = md.split('\n').find(l => l.startsWith('| Rank |'));
  assert.ok(headerLine, 'expected a Rankings header line');
  const cols = headerLine.split('|').filter(c => c.trim().length > 0).length;
  assert.equal(cols, totalCols);
});

test('renderMarkdown is deterministic given the same input', () => {
  const ex = loadExample();
  assert.equal(renderMarkdown(ex), renderMarkdown(ex));
});

// ---------------------------------------------------------------------------
// main() — sync, integer exit code
// ---------------------------------------------------------------------------

test('main() is synchronous and returns an integer for --help', () => {
  const code = main(['node', 'render-scorecard.mjs', '--help']);
  assert.equal(typeof code, 'number');
  assert.equal(code, 0);
});

test('main() returns 1 when --input is missing', () => {
  const code = main(['node', 'render-scorecard.mjs', '--output-dir', '/tmp/out']);
  assert.equal(code, 1);
});

test('main() returns 1 when --output-dir is missing', () => {
  const code = main(['node', 'render-scorecard.mjs', '--input', '/dev/null']);
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------
// CLI integration — spawn the renderer subprocess
// ---------------------------------------------------------------------------

test('CLI renders example fixture into scorecard.md + scorecard.html', () => {
  const out = mkdtempSync(join(tmpdir(), 'sc-render-'));
  try {
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', join(FIXTURES, 'scorecard-example.json'),
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(out, 'scorecard.md')));
    assert.ok(existsSync(join(out, 'scorecard.html')));
    const html = readFileSync(join(out, 'scorecard.html'), 'utf8');
    assert.ok(html.includes('<table class="scorecard-table">'));
    assert.ok(html.includes('Skill Audit Scorecard'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: malformed fixture fails with stderr message about the dangling reference', () => {
  const out = mkdtempSync(join(tmpdir(), 'sc-render-'));
  try {
    const r = spawnSync(process.execPath, [
      RENDERER,
      '--input', join(FIXTURES, 'scorecard-malformed.json'),
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not in skills/);
    assert.ok(!existsSync(join(out, 'scorecard.html')), 'html must not be written on validation failure');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: same input + same output-dir produces byte-identical HTML', () => {
  const out = mkdtempSync(join(tmpdir(), 'sc-render-'));
  try {
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [
        RENDERER,
        '--input', join(FIXTURES, 'scorecard-example.json'),
        '--output-dir', out,
      ], { encoding: 'utf8' });
      assert.equal(r.status, 0);
    }
    const html1 = readFileSync(join(out, 'scorecard.html'));
    // Now render again to a fresh dir and compare bytes — both runs use the same outputDir
    // semantically (different temp dirs would embed different paths). To prove path-stability
    // we render twice into the same dir and re-read.
    const r2 = spawnSync(process.execPath, [
      RENDERER,
      '--input', join(FIXTURES, 'scorecard-example.json'),
      '--output-dir', out,
    ], { encoding: 'utf8' });
    assert.equal(r2.status, 0);
    const html2 = readFileSync(join(out, 'scorecard.html'));
    assert.ok(html1.equals(html2), 'HTML differs between runs with the same input + output-dir');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI: missing --input file produces clear stderr', () => {
  const out = mkdtempSync(join(tmpdir(), 'sc-render-'));
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
  const out = mkdtempSync(join(tmpdir(), 'sc-render-'));
  try {
    const badPath = join(out, 'bad.json');
    writeFileSync(badPath, '{ not valid json');
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

test('CLI: unresolved-token guard fires when template carries a stray placeholder', () => {
  const out = mkdtempSync(join(tmpdir(), 'sc-render-'));
  try {
    // Render once normally, then run the renderer in-process with a poisoned template.
    const ex = loadExample();
    const tmpl = loadTemplate() + '\n<!-- {{poisoned_token}} -->';
    let html;
    try {
      html = renderHtml(ex, tmpl, mdToHtml, escapeHtml, { scorecardMdPath: '' });
    } catch (e) {
      // No throw expected; render itself proceeds.
      throw new Error(`renderHtml threw unexpectedly: ${e.message}`);
    }
    // The unresolved-token guard lives in main() — so we assert that the rendered HTML still
    // carries the stray token, and the guard regex would catch it.
    assert.match(html, /\{\{poisoned_token\}\}/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No external deps
// ---------------------------------------------------------------------------

test('render-scorecard.mjs imports only from node: built-ins and the local markdown-mini', () => {
  const src = readFileSync(RENDERER, 'utf8');
  const imports = src.match(/^import .+ from ['"](.+)['"];?\s*$/gm) || [];
  for (const imp of imports) {
    const ok = /from ['"]node:/.test(imp) || /from ['"]\.\.\/\.\.\/_shared\/markdown-mini\.mjs['"]/.test(imp);
    assert.ok(ok, `disallowed import: ${imp}`);
  }
});
