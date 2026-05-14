#!/usr/bin/env node
/**
 * render-review-gate.mjs — /spec Phase 4 HTML review gate renderer.
 *
 * Reads review-gate.json, validates it (three-layer), and writes
 * review-gate.md + review-gate.html into --output-dir.
 *
 * Determinism: same input + same --output-dir => byte-identical output.
 * Single-file HTML: inline CSS + JS; no external assets.
 * Node built-ins only. Bounded markdown-mini converter, no markdown library.
 */

import { mdToHtml, escapeHtml } from './markdown-mini.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Public exports (unit tests target these)
// ---------------------------------------------------------------------------

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

const REVIEW_LEVELS = new Set(['full', 'light', 'none']);
const ITEM_KINDS = new Set(['DECISION', 'ASSUMPTION']);
const ACTIONS = new Set(['approve', 'revise', 'reject']);

/**
 * Three-layer validation. Throws Error on violation; returns obj on success.
 *
 * Layer 1: structural / top-level types.
 * Layer 2: per-field shape, enums.
 * Layer 3: cross-field consistency (unique ids, required template tokens).
 */
export function validateReviewGate(obj) {
  if (obj == null || typeof obj !== 'object') {
    throw new Error('review-gate must be an object');
  }

  // Layer 1.
  if (obj.schema_version !== '1.0') {
    throw new Error(`unsupported schema_version: ${JSON.stringify(obj.schema_version)} (expected "1.0")`);
  }
  const required = [
    'run_slug', 'created_at', 'spec', 'review_level', 'review_level_reason',
    'summary', 'flagged_items', 'compile_template',
  ];
  for (const f of required) {
    if (!(f in obj)) throw new Error(`missing required field: ${f}`);
  }
  if (typeof obj.run_slug !== 'string') throw new Error('run_slug must be a string');
  if (typeof obj.created_at !== 'string') throw new Error('created_at must be a string');
  if (typeof obj.review_level_reason !== 'string') throw new Error('review_level_reason must be a string');
  if (typeof obj.compile_template !== 'string') throw new Error('compile_template must be a string');

  // Layer 2.
  if (!REVIEW_LEVELS.has(obj.review_level)) {
    throw new Error(`review_level must be one of full|light|none, got ${JSON.stringify(obj.review_level)}`);
  }
  if (obj.spec == null || typeof obj.spec !== 'object') {
    throw new Error('spec must be an object');
  }
  for (const f of ['title', 'slug', 'dir']) {
    if (!(f in obj.spec)) throw new Error(`spec missing field: ${f}`);
    if (typeof obj.spec[f] !== 'string') throw new Error(`spec.${f} must be a string`);
  }

  if (obj.summary == null || typeof obj.summary !== 'object') {
    throw new Error('summary must be an object');
  }
  for (const f of ['problem', 'key_decisions', 'verification_approach', 'constraint_highlights']) {
    if (!(f in obj.summary)) throw new Error(`summary missing field: ${f}`);
  }
  if (typeof obj.summary.problem !== 'string') throw new Error('summary.problem must be a string');
  if (typeof obj.summary.verification_approach !== 'string') throw new Error('summary.verification_approach must be a string');
  if (!Array.isArray(obj.summary.key_decisions)) throw new Error('summary.key_decisions must be an array');
  if (!Array.isArray(obj.summary.constraint_highlights)) throw new Error('summary.constraint_highlights must be an array');

  if (!Array.isArray(obj.flagged_items)) {
    throw new Error('flagged_items must be an array');
  }
  for (let i = 0; i < obj.flagged_items.length; i++) {
    const it = obj.flagged_items[i];
    if (it == null || typeof it !== 'object') {
      throw new Error(`flagged_items[${i}] is not an object`);
    }
    for (const f of ['id', 'kind', 'title', 'context']) {
      if (!(f in it)) throw new Error(`flagged_items[${i}] missing field: ${f}`);
    }
    if (typeof it.id !== 'string' || it.id.length === 0) {
      throw new Error(`flagged_items[${i}].id must be a non-empty string`);
    }
    if (!ITEM_KINDS.has(it.kind)) {
      throw new Error(`flagged_items[${i}].kind must be DECISION or ASSUMPTION, got ${JSON.stringify(it.kind)}`);
    }
    if (typeof it.title !== 'string') {
      throw new Error(`flagged_items[${i}].title must be a string`);
    }
    if (typeof it.context !== 'string') {
      throw new Error(`flagged_items[${i}].context must be a string`);
    }
    if ('stage' in it && it.stage != null && typeof it.stage !== 'string') {
      throw new Error(`flagged_items[${i}].stage must be a string or null`);
    }
    if ('default_action' in it && it.default_action != null && !ACTIONS.has(it.default_action)) {
      throw new Error(`flagged_items[${i}].default_action must be one of approve|revise|reject, got ${JSON.stringify(it.default_action)}`);
    }
  }

  // Layer 3.
  const seen = new Set();
  for (let i = 0; i < obj.flagged_items.length; i++) {
    const id = obj.flagged_items[i].id;
    if (seen.has(id)) {
      throw new Error(`flagged_items[${i}].id "${id}" is duplicated`);
    }
    seen.add(id);
  }
  if (!obj.compile_template.includes('{decisions_blob}')) {
    throw new Error('compile_template must contain {decisions_blob} (otherwise per-item decisions would be lost)');
  }

  return obj;
}

/** Sanitize an arbitrary id for use as a DOM id (alphanumeric, dash, underscore). */
export function sanitizeDomId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Substitute the server-side spec metadata tokens that flow into HTML attributes. */
export function buildAttrPath(specDir) {
  return String(specDir || '').replace(/\\/g, '/');
}

/** Attribute-escape — order matters. */
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStringListHtml(items) {
  if (!Array.isArray(items) || items.length === 0) return '<ul></ul>';
  return `<ul>${items.map((s) => `<li>${escapeHtml(String(s))}</li>`).join('')}</ul>`;
}

function renderItemCard(item, mdToHtmlFn, escapeHtmlFn) {
  const id = item.id;
  const domId = sanitizeDomId(id);
  const kindClass = `kind-${item.kind}`;
  const itemClass = item.kind === 'DECISION' ? 'item-decision' : 'item-assumption';
  const stageChip = item.stage
    ? `<span class="stage-chip">${escapeHtmlFn(item.stage)}</span>`
    : '';
  const checked = (action) =>
    item.default_action === action ? ' checked' : '';
  return `<article class="item-card ${itemClass}" id="card-${escapeHtmlFn(domId)}" data-item-id="${escapeHtmlFn(domId)}">
  <header class="item-head">
    <span class="id-chip">${escapeHtmlFn(id)}</span>
    <span class="kind-badge ${kindClass}">${escapeHtmlFn(item.kind)}</span>
    ${stageChip}
    <span class="title">${escapeHtmlFn(item.title)}</span>
  </header>
  <div class="item-context">${mdToHtmlFn(item.context)}</div>
  <div class="triage-row">
    <label class="approve"><input type="radio" name="decision-${escapeHtmlFn(domId)}" value="approve"${checked('approve')}><span>✅ Approve</span></label>
    <label class="revise"><input type="radio" name="decision-${escapeHtmlFn(domId)}" value="revise"${checked('revise')}><span>✏️ Revise</span></label>
    <label class="reject"><input type="radio" name="decision-${escapeHtmlFn(domId)}" value="reject"${checked('reject')}><span>❌ Reject</span></label>
  </div>
  <textarea class="item-note" id="note-${escapeHtmlFn(domId)}" placeholder="Optional approval comment / required revision text / optional reject reason"></textarea>
</article>`;
}

/** Build the array of {id, kind} objects the inline JS needs (post-sanitization). */
function buildItemsForJs(items) {
  return items.map((it) => ({ id: sanitizeDomId(it.id), kind: it.kind }));
}

/** Pure HTML renderer. */
export function renderHtml(reviewGate, templateString, mdToHtmlFn, escapeHtmlFn) {
  const items = reviewGate.flagged_items;
  const decisionCount = items.filter((i) => i.kind === 'DECISION').length;
  const assumptionCount = items.length - decisionCount;

  const itemCards = items.map((it) => renderItemCard(it, mdToHtmlFn, escapeHtmlFn)).join('\n');

  const meta = {
    spec_slug: reviewGate.spec.slug,
    spec_title: reviewGate.spec.title,
    spec_dir: buildAttrPath(reviewGate.spec.dir),
    review_level: reviewGate.review_level,
    review_gate_path: buildAttrPath(`${reviewGate.spec.dir}/review-gate.md`),
  };

  const subs = {
    '{{spec_title}}': escapeHtmlFn(reviewGate.spec.title),
    '{{spec_slug}}': escapeHtmlFn(reviewGate.spec.slug),
    '{{spec_dir}}': escapeHtmlFn(buildAttrPath(reviewGate.spec.dir)),
    '{{created_at}}': escapeHtmlFn(reviewGate.created_at),
    '{{review_level}}': escapeHtmlFn(reviewGate.review_level),
    '{{review_level_reason}}': escapeHtmlFn(reviewGate.review_level_reason),
    '{{total_count}}': escapeHtmlFn(String(items.length)),
    '{{decision_count}}': escapeHtmlFn(String(decisionCount)),
    '{{assumption_count}}': escapeHtmlFn(String(assumptionCount)),
    '{{summary_problem_html}}': mdToHtmlFn(reviewGate.summary.problem),
    '{{summary_key_decisions_list}}': renderStringListHtml(reviewGate.summary.key_decisions),
    '{{summary_verification_html}}': mdToHtmlFn(reviewGate.summary.verification_approach),
    '{{summary_constraints_list}}': renderStringListHtml(reviewGate.summary.constraint_highlights),
    '{{item_cards}}': itemCards,
    '{{compile_template_attr}}': escapeAttr(reviewGate.compile_template),
    '{{items_for_js}}': JSON.stringify(buildItemsForJs(items)),
    '{{meta_for_js}}': JSON.stringify(meta),
  };

  let html = templateString;
  for (const [token, value] of Object.entries(subs)) {
    html = html.split(token).join(value);
  }
  return html;
}

/** Render a canonical markdown form of the review gate. */
export function renderMarkdown(reviewGate) {
  const lines = [];
  lines.push(`# Spec Review Gate — ${reviewGate.spec.title}`);
  lines.push('');
  lines.push(`Slug: \`${reviewGate.spec.slug}\` · ${reviewGate.created_at}`);
  lines.push(`Spec dir: \`${buildAttrPath(reviewGate.spec.dir)}\``);
  lines.push(`Review level: **${reviewGate.review_level}** — ${reviewGate.review_level_reason}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`**Problem:** ${reviewGate.summary.problem}`);
  lines.push('');
  lines.push('**Key decisions:**');
  for (const d of reviewGate.summary.key_decisions) lines.push(`- ${d}`);
  lines.push('');
  lines.push(`**Verification:** ${reviewGate.summary.verification_approach}`);
  lines.push('');
  lines.push('**Constraints:**');
  for (const c of reviewGate.summary.constraint_highlights) lines.push(`- ${c}`);
  lines.push('');
  lines.push('## Flagged items');
  lines.push('');
  for (const it of reviewGate.flagged_items) {
    const stageChip = it.stage ? ` [${it.stage}]` : '';
    lines.push(`### ${it.id} (${it.kind})${stageChip} — ${it.title}`);
    lines.push('');
    lines.push(it.context);
    lines.push('');
    lines.push('Triage: ✅ approve · ✏️ revise · ❌ reject');
    lines.push('');
  }
  lines.push('## Compile template');
  lines.push('');
  lines.push('```');
  lines.push(reviewGate.compile_template);
  lines.push('```');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const HELP_TEXT = `Usage: node render-review-gate.mjs --input <path>/review-gate.json --output-dir <path>

Reads a /spec Phase 4 review-gate.json, validates it, and writes
review-gate.md + review-gate.html into --output-dir.

Options:
  --input <path>       Path to review-gate.json (required)
  --output-dir <path>  Directory to write outputs (required)
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

/** Sync main returning integer exit code. */
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

  let raw;
  try {
    raw = readFileSync(opts.input, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to read --input: ${e.message}\n`);
    return 1;
  }

  let reviewGate;
  try {
    reviewGate = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Error: failed to parse JSON: ${e.message}\n`);
    return 1;
  }

  try {
    validateReviewGate(reviewGate);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }

  // Soft warnings — non-fatal.
  if (!reviewGate.compile_template.includes('{spec_slug}')) {
    process.stderr.write('Warning: compile_template does not contain {spec_slug}\n');
  }
  if (!reviewGate.compile_template.includes('{general_feedback}')) {
    process.stderr.write('Warning: compile_template does not contain {general_feedback}\n');
  }

  const outDir = resolve(opts.outputDir);
  try {
    ensureDir(outDir);
  } catch (e) {
    process.stderr.write(`Error: failed to create --output-dir: ${e.message}\n`);
    return 1;
  }

  const templatePath = fileURLToPath(new URL('./review-gate-template.html', import.meta.url));
  let templateString;
  try {
    templateString = readFileSync(templatePath, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to read template: ${e.message}\n`);
    return 1;
  }

  let mdOut, htmlOut;
  try {
    mdOut = renderMarkdown(reviewGate);
    htmlOut = renderHtml(reviewGate, templateString, mdToHtml, escapeHtml);
  } catch (e) {
    process.stderr.write(`Error: render failed: ${e.message}\n`);
    return 1;
  }

  const unresolved = [...new Set((htmlOut.match(/\{\{[a-z_]+\}\}/g) || []))];
  if (unresolved.length > 0) {
    process.stderr.write(`Error: unresolved template tokens in HTML output: ${unresolved.join(', ')}\n`);
    return 1;
  }

  try {
    writeFileSync(join(outDir, 'review-gate.md'), mdOut, 'utf8');
    writeFileSync(join(outDir, 'review-gate.html'), htmlOut, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to write output: ${e.message}\n`);
    return 1;
  }

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
