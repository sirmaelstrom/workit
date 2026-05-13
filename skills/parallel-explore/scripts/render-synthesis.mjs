#!/usr/bin/env node
/**
 * render-synthesis.mjs — parallel-explore HTML synthesis renderer
 *
 * Reads synthesis.json, validates it (M6 fail-loudly), and produces
 * synthesis.md + synthesis.html in the given output directory.
 *
 * Determinism (M1): same input + same --output-dir => byte-identical output.
 * Single-file HTML (M2): inline CSS + JS; no <link>, no <script src>, no CDNs.
 * Node built-ins only (MN2): no npm dependencies.
 * No markdown library (MN3): uses markdown-mini.mjs only.
 */

import { mdToHtml, escapeHtml } from './markdown-mini.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Public exports (P6 — for unit tests)
// ---------------------------------------------------------------------------

/**
 * D1 slug logic.
 *
 * 1. Trim + lowercase goal.
 * 2. Replace runs of non-alphanumeric with single '-'. Strip leading/trailing '-'.
 * 3. Truncate kebab to <=40 chars. If cut lands mid-word, back up to previous '-'.
 *    Exactly-40-char kebab: return as-is (no backup).
 * 4. Append '-YYYYMMDD-HHMMSS' from UTC date methods.
 * 5. Empty/whitespace goal => 'explore-YYYYMMDD-HHMMSS'.
 */
export function slugForGoal(goal, date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  const suffix = `-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;

  const trimmed = (goal || '').trim();
  if (trimmed === '') {
    return `explore${suffix}`;
  }

  let kebab = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (kebab.length > 40) {
    let slice = kebab.slice(0, 40);
    const charAt40 = kebab.charAt(40);
    const charAt39 = kebab.charAt(39);
    const isAlnum = (c) => /^[a-z0-9]$/.test(c);
    if (isAlnum(charAt40) && isAlnum(charAt39)) {
      // Cut lands mid-word; back up to previous '-' in the slice.
      const lastDash = slice.lastIndexOf('-');
      if (lastDash > 0) {
        slice = slice.slice(0, lastDash);
      }
    }
    kebab = slice.replace(/-+$/, '');
  }

  return `${kebab}${suffix}`;
}

/** mkdir -p semantics (D7). */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Three-layer M6 validation.
 * Throws Error on any violation; returns obj unchanged on success.
 */
export function validateSynthesis(obj) {
  if (obj == null || typeof obj !== 'object') {
    throw new Error('synthesis must be an object');
  }

  // Layer 1: structural / top-level.
  if (obj.schema_version !== '1.0') {
    throw new Error(`unsupported schema_version: ${JSON.stringify(obj.schema_version)} (expected "1.0")`);
  }
  const required = [
    'goal', 'non_goals', 'hard_constraints', 'evaluation_criteria',
    'branches', 'comparison_matrix', 'branches_agree', 'branches_disagree',
    'hidden_assumptions', 'recommendation', 'uncertainty', 'next_action',
  ];
  for (const f of required) {
    if (!(f in obj)) {
      throw new Error(`missing required field: ${f}`);
    }
  }

  // Layer 2: per-field shape.
  if (!Array.isArray(obj.branches)) {
    throw new Error('branches must be an array');
  }
  if (obj.branches.length < 1) {
    throw new Error('branches array is empty');
  }

  const branchFields = [
    'id', 'title', 'thesis', 'proposed_design', 'why_this_wins',
    'tradeoffs', 'failure_modes', 'operational_complexity',
    'verification_plan', 'first_implementation_slice', 'rejects_from_others',
  ];
  for (let i = 0; i < obj.branches.length; i++) {
    const b = obj.branches[i];
    if (b == null || typeof b !== 'object') {
      throw new Error(`branches[${i}] is not an object`);
    }
    for (const f of branchFields) {
      if (!(f in b)) {
        throw new Error(`branches[${i}] missing field: ${f}`);
      }
    }
    const oc = b.operational_complexity;
    if (oc == null || typeof oc !== 'object' || typeof oc.score !== 'number' || typeof oc.justification !== 'string') {
      throw new Error(`branches[${i}].operational_complexity must be {score:int, justification:string}`);
    }
    if (!Number.isInteger(oc.score) || oc.score < 1 || oc.score > 5) {
      throw new Error(`branches[${i}].operational_complexity.score must be integer 1..5, got ${oc.score}`);
    }
  }

  if (!Array.isArray(obj.comparison_matrix)) {
    throw new Error('comparison_matrix must be an array');
  }
  for (let r = 0; r < obj.comparison_matrix.length; r++) {
    const row = obj.comparison_matrix[r];
    if (row == null || typeof row !== 'object') {
      throw new Error(`comparison_matrix[${r}] is not an object`);
    }
    for (const f of ['criterion_id', 'criterion_label', 'cells']) {
      if (!(f in row)) {
        throw new Error(`comparison_matrix[${r}] missing field: ${f}`);
      }
    }
    if (!Array.isArray(row.cells)) {
      throw new Error(`comparison_matrix[${r}].cells must be an array`);
    }
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      if (cell == null || typeof cell !== 'object') {
        throw new Error(`comparison_matrix[${r}].cells[${c}] is not an object`);
      }
      if (typeof cell.branch_id !== 'string') {
        throw new Error(`comparison_matrix[${r}].cells[${c}].branch_id must be a string`);
      }
      if (typeof cell.characterization !== 'string') {
        throw new Error(`comparison_matrix[${r}].cells[${c}].characterization must be a string`);
      }
      if (!Number.isInteger(cell.score) || cell.score < 1 || cell.score > 5) {
        throw new Error(`comparison_matrix[${r}].cells[${c}].score must be integer 1..5, got ${cell.score}`);
      }
    }
  }

  if (obj.recommendation == null || typeof obj.recommendation !== 'object') {
    throw new Error('recommendation must be an object');
  }
  if (typeof obj.recommendation.branch_id !== 'string') {
    throw new Error('recommendation.branch_id must be a string');
  }
  if (typeof obj.recommendation.rationale !== 'string') {
    throw new Error('recommendation.rationale must be a string');
  }

  if (!Array.isArray(obj.evaluation_criteria)) {
    throw new Error('evaluation_criteria must be an array');
  }
  for (let i = 0; i < obj.evaluation_criteria.length; i++) {
    const ec = obj.evaluation_criteria[i];
    if (ec == null || typeof ec !== 'object') {
      throw new Error(`evaluation_criteria[${i}] is not an object`);
    }
    for (const f of ['id', 'name', 'weight']) {
      if (!(f in ec)) {
        throw new Error(`evaluation_criteria[${i}] missing field: ${f}`);
      }
    }
    if (!['high', 'medium', 'low'].includes(ec.weight)) {
      throw new Error(`evaluation_criteria[${i}].weight must be one of "high"|"medium"|"low", got ${JSON.stringify(ec.weight)}`);
    }
  }

  // Layer 3: cross-field consistency.
  const branchIds = new Set(obj.branches.map((b) => b.id));
  if (!branchIds.has(obj.recommendation.branch_id)) {
    throw new Error(`recommendation.branch_id "${obj.recommendation.branch_id}" does not match any branch`);
  }
  for (let r = 0; r < obj.comparison_matrix.length; r++) {
    const row = obj.comparison_matrix[r];
    const cellBranchIds = new Set();
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      if (!branchIds.has(cell.branch_id)) {
        throw new Error(`comparison_matrix[${r}].cells[${c}].branch_id "${cell.branch_id}" does not match any branch`);
      }
      cellBranchIds.add(cell.branch_id);
    }
    for (const bid of branchIds) {
      if (!cellBranchIds.has(bid)) {
        throw new Error(`matrix row "${row.criterion_id}" is missing cell for branch "${bid}"`);
      }
    }
  }

  return obj;
}

/**
 * D6 pick-prompt substitution.
 *
 * displayIndex is the 1-based display number; this function does NOT add 1.
 * Pure string substitution — no filesystem access.
 *
 * Variables substituted: {synthesis_md_path}, {N}, {branch_title}, {thesis},
 * {branch_id}, {results_path}.
 */
export function buildPickPrompt(branch, displayIndex, synthesisMdPath, resultsPath) {
  // Normalize backslashes to forward slashes (D6).
  const synth = String(synthesisMdPath).replace(/\\/g, '/');
  const results = String(resultsPath).replace(/\\/g, '/');

  const template =
    `I've reviewed the parallel-explore synthesis at {synthesis_md_path}.\n` +
    `Going with Branch {N}: "{branch_title}" — thesis: "{thesis}".\n` +
    `Proceed using this branch's Proposed Design and First Implementation Slice as the starting point. Full branch result available at {results_path}/{branch_id}.md.`;

  // Order: replace longer/more-specific tokens first to avoid partial collisions.
  // (None of these tokens are substrings of each other, so order doesn't actually matter,
  // but we use split/join per the spec's "Substitution implementation note".)
  return template
    .split('{synthesis_md_path}').join(synth)
    .split('{results_path}').join(results)
    .split('{branch_title}').join(branch.title)
    .split('{branch_id}').join(branch.id)
    .split('{thesis}').join(branch.thesis)
    .split('{N}').join(String(displayIndex));
}

/**
 * Attribute-escape for embedding inside data-pick-prompt="...".
 * Order: & first (else later &-escapes corrupt earlier output), then < > ".
 */
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a single <li> list from an array of plain strings. */
function renderStringList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<ul></ul>';
  }
  return `<ul>${items.map((s) => `<li>${escapeHtml(String(s))}</li>`).join('')}</ul>`;
}

/** Render evaluation-criteria list. */
function renderCriteriaList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<ul></ul>';
  }
  return `<ul>${items
    .map((c) => `<li>${escapeHtml(c.name)} (weight: ${escapeHtml(c.weight)})</li>`)
    .join('')}</ul>`;
}

/** Render comparison matrix as an HTML <table>. */
function renderMatrixTable(synthesis) {
  const branches = synthesis.branches;
  const recBranchId = synthesis.recommendation.branch_id;
  const recIndex = branches.findIndex((b) => b.id === recBranchId);

  const headerCells = [`<th>Criterion</th>`];
  branches.forEach((b, i) => {
    const cls = i === recIndex ? ' class="recommended-col"' : '';
    headerCells.push(`<th${cls}>${escapeHtml(b.title)}</th>`);
  });

  const rows = synthesis.comparison_matrix.map((row) => {
    const cellsByBranch = new Map();
    for (const c of row.cells) cellsByBranch.set(c.branch_id, c);
    const tds = branches.map((b, i) => {
      const cell = cellsByBranch.get(b.id);
      const recCls = i === recIndex ? ' matrix-col recommended-col' : '';
      const score = cell.score;
      return `<td class="matrix-cell score-${score}${recCls}">${escapeHtml(cell.characterization)}</td>`;
    });
    return `<tr><th>${escapeHtml(row.criterion_label)}</th>${tds.join('')}</tr>`;
  });

  return `<table class="matrix-table">\n<thead><tr>${headerCells.join('')}</tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`;
}

/** Render markdown form of the synthesis. */
export function renderMarkdown(synthesis) {
  const lines = [];
  lines.push(`# ${synthesis.goal}`);
  lines.push('');
  lines.push(`Run: \`${synthesis.run_slug}\` · ${synthesis.created_at}`);
  lines.push('');

  lines.push('## Non-goals');
  lines.push('');
  for (const ng of synthesis.non_goals) lines.push(`- ${ng}`);
  lines.push('');

  lines.push('## Hard constraints');
  lines.push('');
  for (const hc of synthesis.hard_constraints) lines.push(`- ${hc}`);
  lines.push('');

  lines.push('## Evaluation criteria');
  lines.push('');
  for (const ec of synthesis.evaluation_criteria) {
    lines.push(`- ${ec.name} (weight: ${ec.weight})`);
  }
  lines.push('');

  synthesis.branches.forEach((b, i) => {
    const n = i + 1;
    lines.push(`## Branch ${n}: ${b.title}`);
    lines.push('');
    lines.push(`**Thesis:** ${b.thesis}`);
    lines.push('');
    lines.push('### Proposed design');
    lines.push('');
    lines.push(b.proposed_design);
    lines.push('');
    lines.push('### Why this wins');
    lines.push('');
    lines.push(b.why_this_wins);
    lines.push('');
    lines.push('### Tradeoffs');
    lines.push('');
    lines.push(b.tradeoffs);
    lines.push('');
    lines.push('### Failure modes');
    lines.push('');
    lines.push(b.failure_modes);
    lines.push('');
    lines.push(`### Operational complexity: ${b.operational_complexity.score}/5`);
    lines.push('');
    lines.push(b.operational_complexity.justification);
    lines.push('');
    lines.push('### Verification plan');
    lines.push('');
    lines.push(b.verification_plan);
    lines.push('');
    lines.push('### First implementation slice');
    lines.push('');
    lines.push(b.first_implementation_slice);
    lines.push('');
    lines.push('### Rejects from others');
    lines.push('');
    lines.push(b.rejects_from_others);
    lines.push('');
  });

  // Comparison matrix as markdown table.
  lines.push('## Comparison matrix');
  lines.push('');
  const header = ['Criterion', ...synthesis.branches.map((b) => b.title)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of synthesis.comparison_matrix) {
    const cellsByBranch = new Map();
    for (const c of row.cells) cellsByBranch.set(c.branch_id, c);
    const cells = synthesis.branches.map((b) => {
      const cell = cellsByBranch.get(b.id);
      // Escape pipe characters inside table cells.
      const text = `${cell.score}/5 — ${cell.characterization}`.replace(/\|/g, '\\|');
      return text;
    });
    lines.push(`| ${row.criterion_label} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Where branches agree');
  lines.push('');
  lines.push(synthesis.branches_agree);
  lines.push('');

  lines.push('## Where branches disagree');
  lines.push('');
  lines.push(synthesis.branches_disagree);
  lines.push('');

  lines.push('## Hidden assumptions');
  lines.push('');
  lines.push(synthesis.hidden_assumptions);
  lines.push('');

  const recBranch = synthesis.branches.find((b) => b.id === synthesis.recommendation.branch_id);
  lines.push(`## Recommendation: ★ ${recBranch.title}`);
  lines.push('');
  lines.push(synthesis.recommendation.rationale);
  lines.push('');

  lines.push('## Uncertainty');
  lines.push('');
  lines.push(synthesis.uncertainty);
  lines.push('');

  lines.push('## Next action');
  lines.push('');
  lines.push(synthesis.next_action);
  lines.push('');

  return lines.join('\n');
}

/**
 * Pure renderHtml(synthesis, templateString, mdToHtmlFn, escapeHtmlFn) -> HTML string.
 *
 * Receives the template as a parameter; does NOT read the file (main() does).
 * Performs two-level substitution: per-branch tile, then outer template.
 */
export function renderHtml(synthesis, templateString, mdToHtmlFn, escapeHtmlFn, opts) {
  const synthesisMdPath = (opts && opts.synthesisMdPath) || '';
  const resultsPath = (opts && opts.resultsPath) || '';

  const branches = synthesis.branches;
  const recBranchId = synthesis.recommendation.branch_id;
  const recBranch = branches.find((b) => b.id === recBranchId);

  // Per-branch sub-template (defined here, not in a separate file).
  const BRANCH_TILE_TEMPLATE = `<article class="branch-tile {{recommended_class}}" data-branch-id="{{id}}">
  <header>
    <h3>Branch {{display_index}}: {{title_escaped}}</h3>
    {{recommended_label}}
    <p class="thesis">{{thesis_escaped}}</p>
  </header>
  <button class="pick-branch-btn" data-pick-prompt="{{pick_prompt_attr_escaped}}">Pick this branch</button>
  <details class="branch-detail"><summary>Proposed design</summary>{{proposed_design_html}}</details>
  <details class="branch-detail"><summary>Why this wins</summary>{{why_this_wins_html}}</details>
  <details class="branch-detail"><summary>Tradeoffs</summary>{{tradeoffs_html}}</details>
  <details class="branch-detail"><summary>Failure modes</summary>{{failure_modes_html}}</details>
  <details class="branch-detail"><summary>Verification plan</summary>{{verification_plan_html}}</details>
  <details class="branch-detail"><summary>First implementation slice</summary>{{first_implementation_slice_html}}</details>
  <details class="branch-detail"><summary>Rejects from others</summary>{{rejects_from_others_html}}</details>
  <p class="op-complexity">Operational complexity: <strong>{{op_score}}/5</strong> — {{op_justification_escaped}}</p>
</article>`;

  const tiles = branches.map((branch, i) => {
    const displayIndex = i + 1;
    const isRec = branch.id === recBranchId;
    const subs = {
      '{{display_index}}': String(displayIndex),
      '{{recommended_class}}': isRec ? 'recommended' : '',
      '{{recommended_label}}': isRec ? '<span class="rec-label">★ Recommended</span>' : '',
      '{{title_escaped}}': escapeHtmlFn(branch.title),
      '{{thesis_escaped}}': escapeHtmlFn(branch.thesis),
      '{{op_score}}': escapeHtmlFn(String(branch.operational_complexity.score)),
      '{{op_justification_escaped}}': escapeHtmlFn(branch.operational_complexity.justification),
      '{{proposed_design_html}}': mdToHtmlFn(branch.proposed_design),
      '{{why_this_wins_html}}': mdToHtmlFn(branch.why_this_wins),
      '{{tradeoffs_html}}': mdToHtmlFn(branch.tradeoffs),
      '{{failure_modes_html}}': mdToHtmlFn(branch.failure_modes),
      '{{verification_plan_html}}': mdToHtmlFn(branch.verification_plan),
      '{{first_implementation_slice_html}}': mdToHtmlFn(branch.first_implementation_slice),
      '{{rejects_from_others_html}}': mdToHtmlFn(branch.rejects_from_others),
      '{{pick_prompt_attr_escaped}}': escapeAttr(
        buildPickPrompt(branch, displayIndex, synthesisMdPath, resultsPath)
      ),
      '{{id}}': escapeHtmlFn(branch.id),
    };
    let tile = BRANCH_TILE_TEMPLATE;
    for (const [token, value] of Object.entries(subs)) {
      tile = tile.split(token).join(value);
    }
    return tile;
  });

  const branchTilesHtml = tiles.join('\n');

  // Outer-template substitutions.
  const outerSubs = {
    '{{goal}}': escapeHtmlFn(synthesis.goal),
    '{{run_slug}}': escapeHtmlFn(synthesis.run_slug || ''),
    '{{created_at}}': escapeHtmlFn(synthesis.created_at || ''),
    '{{non_goals_list}}': renderStringList(synthesis.non_goals),
    '{{hard_constraints_list}}': renderStringList(synthesis.hard_constraints),
    '{{evaluation_criteria_list}}': renderCriteriaList(synthesis.evaluation_criteria),
    '{{branch_tiles}}': branchTilesHtml,
    '{{comparison_matrix_table}}': renderMatrixTable(synthesis),
    '{{branches_agree_html}}': mdToHtmlFn(synthesis.branches_agree),
    '{{branches_disagree_html}}': mdToHtmlFn(synthesis.branches_disagree),
    '{{hidden_assumptions_html}}': mdToHtmlFn(synthesis.hidden_assumptions),
    '{{recommended_branch_title}}': escapeHtmlFn(recBranch.title),
    '{{recommendation_rationale_html}}': mdToHtmlFn(synthesis.recommendation.rationale),
    '{{uncertainty_html}}': mdToHtmlFn(synthesis.uncertainty),
    '{{next_action_html}}': mdToHtmlFn(synthesis.next_action),
  };

  let html = templateString;
  for (const [token, value] of Object.entries(outerSubs)) {
    html = html.split(token).join(value);
  }

  return html;
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const HELP_TEXT = `Usage: node render-synthesis.mjs --input <path>/synthesis.json --output-dir <path>

Reads a parallel-explore synthesis.json, validates it, and writes
synthesis.md + synthesis.html into the given --output-dir.

Options:
  --input <path>       Path to synthesis.json (required)
  --output-dir <path>  Directory to write synthesis.md + synthesis.html (required)
  --help               Print this message and exit 0

Determinism: same --input + same --output-dir => byte-identical output.
Single-file HTML: no external assets, system fonts only.
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { input: null, outputDir: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--input') {
      out.input = args[++i] || null;
    } else if (a === '--output-dir') {
      out.outputDir = args[++i] || null;
    }
  }
  return out;
}

/**
 * Synchronous main(argv) returning an integer exit code.
 * MUST be synchronous: the guard `process.exit(main(argv))` would coerce
 * a returned Promise to NaN and silently exit 0.
 */
export function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (!opts.input || !opts.outputDir) {
    process.stderr.write('Error: --input and --output-dir are required\n');
    return 1;
  }

  // Read and parse synthesis.json.
  let raw;
  try {
    raw = readFileSync(opts.input, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to read --input: ${e.message}\n`);
    return 1;
  }

  let synthesis;
  try {
    synthesis = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Error: failed to parse JSON: ${e.message}\n`);
    return 1;
  }

  // Validate.
  try {
    validateSynthesis(synthesis);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }

  // Ensure output directory exists.
  const outDir = resolve(opts.outputDir);
  try {
    ensureDir(outDir);
  } catch (e) {
    process.stderr.write(`Error: failed to create --output-dir: ${e.message}\n`);
    return 1;
  }

  const synthesisMdPath = join(outDir, 'synthesis.md').replace(/\\/g, '/');
  const resultsPath = join(outDir, 'results').replace(/\\/g, '/');

  // Read template (sibling of this script, regardless of CWD).
  const templatePath = fileURLToPath(new URL('./synthesis-template.html', import.meta.url));
  let templateString;
  try {
    templateString = readFileSync(templatePath, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to read template: ${e.message}\n`);
    return 1;
  }

  // Render.
  let mdOut, htmlOut;
  try {
    mdOut = renderMarkdown(synthesis);
    htmlOut = renderHtml(synthesis, templateString, mdToHtml, escapeHtml, {
      synthesisMdPath,
      resultsPath,
    });
  } catch (e) {
    process.stderr.write(`Error: render failed: ${e.message}\n`);
    return 1;
  }

  // Unresolved-token guard.
  const unresolved = [...new Set((htmlOut.match(/\{\{[a-z_]+\}\}/g) || []))];
  if (unresolved.length > 0) {
    process.stderr.write(`Error: unresolved template tokens in HTML output: ${unresolved.join(', ')}\n`);
    return 1;
  }

  // Write outputs.
  try {
    writeFileSync(join(outDir, 'synthesis.md'), mdOut, 'utf8');
    writeFileSync(join(outDir, 'synthesis.html'), htmlOut, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to write output: ${e.message}\n`);
    return 1;
  }

  return 0;
}

// CLI entrypoint guard — only runs when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
