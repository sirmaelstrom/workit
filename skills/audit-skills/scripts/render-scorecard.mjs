#!/usr/bin/env node
/**
 * render-scorecard.mjs — audit-skills HTML scorecard renderer
 *
 * Reads scorecard.json, validates it (three-layer), and writes
 * scorecard.md + scorecard.html into --output-dir.
 *
 * Determinism: same input + same --output-dir => byte-identical output.
 * Single-file HTML: inline CSS + JS; no external assets.
 * Node built-ins only. Bounded markdown-mini converter, no markdown library.
 */

import { mdToHtml, escapeHtml } from '../../_shared/markdown-mini.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Public exports (unit tests target these)
// ---------------------------------------------------------------------------

/** mkdir -p semantics. */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

const DIMENSION_KINDS = new Set(['likert5', 'eval_coverage', 'karpathy']);
const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);

/**
 * Three-layer validation.
 * Throws Error on any violation; returns obj unchanged on success.
 *
 * Layer 1: structural / top-level fields present and types correct.
 * Layer 2: per-field shape — array/object types, numeric ranges, enums.
 * Layer 3: cross-field consistency — references resolve, dimension coverage complete.
 */
export function validateScorecard(obj) {
  if (obj == null || typeof obj !== 'object') {
    throw new Error('scorecard must be an object');
  }

  // Layer 1: top-level.
  if (obj.schema_version !== '1.0') {
    throw new Error(`unsupported schema_version: ${JSON.stringify(obj.schema_version)} (expected "1.0")`);
  }
  const required = [
    'run_slug', 'created_at', 'plugins', 'summary',
    'dimensions', 'skills', 'top_actions',
  ];
  for (const f of required) {
    if (!(f in obj)) {
      throw new Error(`missing required field: ${f}`);
    }
  }
  if (typeof obj.run_slug !== 'string') throw new Error('run_slug must be a string');
  if (typeof obj.created_at !== 'string') throw new Error('created_at must be a string');

  // Layer 2: per-field shape.
  if (!Array.isArray(obj.plugins) || obj.plugins.length === 0) {
    throw new Error('plugins must be a non-empty array');
  }
  for (let i = 0; i < obj.plugins.length; i++) {
    if (typeof obj.plugins[i] !== 'string') {
      throw new Error(`plugins[${i}] must be a string`);
    }
  }

  if (obj.summary == null || typeof obj.summary !== 'object') {
    throw new Error('summary must be an object');
  }
  for (const f of ['skills_assessed', 'average_score', 'karpathy_eligible_count', 'highest_roi_skill_id']) {
    if (!(f in obj.summary)) {
      throw new Error(`summary missing field: ${f}`);
    }
  }
  if (!Number.isInteger(obj.summary.skills_assessed)) {
    throw new Error('summary.skills_assessed must be an integer');
  }
  if (typeof obj.summary.average_score !== 'number') {
    throw new Error('summary.average_score must be a number');
  }
  if (!Number.isInteger(obj.summary.karpathy_eligible_count)) {
    throw new Error('summary.karpathy_eligible_count must be an integer');
  }
  if (typeof obj.summary.highest_roi_skill_id !== 'string') {
    throw new Error('summary.highest_roi_skill_id must be a string');
  }

  if (!Array.isArray(obj.dimensions) || obj.dimensions.length === 0) {
    throw new Error('dimensions must be a non-empty array');
  }
  for (let i = 0; i < obj.dimensions.length; i++) {
    const d = obj.dimensions[i];
    if (d == null || typeof d !== 'object') {
      throw new Error(`dimensions[${i}] is not an object`);
    }
    for (const f of ['id', 'label', 'kind']) {
      if (!(f in d)) throw new Error(`dimensions[${i}] missing field: ${f}`);
    }
    if (typeof d.id !== 'string') throw new Error(`dimensions[${i}].id must be a string`);
    if (typeof d.label !== 'string') throw new Error(`dimensions[${i}].label must be a string`);
    if (!DIMENSION_KINDS.has(d.kind)) {
      throw new Error(`dimensions[${i}].kind must be one of likert5|eval_coverage|karpathy, got ${JSON.stringify(d.kind)}`);
    }
  }

  if (!Array.isArray(obj.skills) || obj.skills.length === 0) {
    throw new Error('skills must be a non-empty array');
  }
  const skillFields = ['id', 'name', 'plugin', 'kind', 'rank', 'roi', 'karpathy_eligible', 'scores', 'notes', 'gaps', 'next_actions'];
  for (let i = 0; i < obj.skills.length; i++) {
    const s = obj.skills[i];
    if (s == null || typeof s !== 'object') {
      throw new Error(`skills[${i}] is not an object`);
    }
    for (const f of skillFields) {
      if (!(f in s)) throw new Error(`skills[${i}] missing field: ${f}`);
    }
    if (typeof s.id !== 'string') throw new Error(`skills[${i}].id must be a string`);
    if (typeof s.name !== 'string') throw new Error(`skills[${i}].name must be a string`);
    if (typeof s.plugin !== 'string') throw new Error(`skills[${i}].plugin must be a string`);
    if (typeof s.kind !== 'string') throw new Error(`skills[${i}].kind must be a string`);
    if (!Number.isInteger(s.rank) || s.rank < 1) {
      throw new Error(`skills[${i}].rank must be a positive integer, got ${s.rank}`);
    }
    if (typeof s.roi !== 'number') {
      throw new Error(`skills[${i}].roi must be a number`);
    }
    if (s.karpathy_eligible !== 0 && s.karpathy_eligible !== 1) {
      throw new Error(`skills[${i}].karpathy_eligible must be 0 or 1, got ${s.karpathy_eligible}`);
    }
    if (s.scores == null || typeof s.scores !== 'object') {
      throw new Error(`skills[${i}].scores must be an object`);
    }
    if (typeof s.notes !== 'string') throw new Error(`skills[${i}].notes must be a string`);
    if (!Array.isArray(s.gaps)) throw new Error(`skills[${i}].gaps must be an array`);
    if (!Array.isArray(s.next_actions)) throw new Error(`skills[${i}].next_actions must be an array`);
  }

  if (!Array.isArray(obj.top_actions)) {
    throw new Error('top_actions must be an array');
  }
  for (let i = 0; i < obj.top_actions.length; i++) {
    const a = obj.top_actions[i];
    if (a == null || typeof a !== 'object') {
      throw new Error(`top_actions[${i}] is not an object`);
    }
    for (const f of ['rank', 'skill_id', 'action_text', 'send_prompt_template']) {
      if (!(f in a)) throw new Error(`top_actions[${i}] missing field: ${f}`);
    }
    if (!Number.isInteger(a.rank) || a.rank < 1) {
      throw new Error(`top_actions[${i}].rank must be a positive integer, got ${a.rank}`);
    }
    if (typeof a.skill_id !== 'string') throw new Error(`top_actions[${i}].skill_id must be a string`);
    if (typeof a.action_text !== 'string') throw new Error(`top_actions[${i}].action_text must be a string`);
    if (typeof a.send_prompt_template !== 'string') {
      throw new Error(`top_actions[${i}].send_prompt_template must be a string`);
    }
  }

  // Per-score field shape + value-range checks (Layer 2 continued).
  const dimById = new Map(obj.dimensions.map((d) => [d.id, d]));
  for (let i = 0; i < obj.skills.length; i++) {
    const s = obj.skills[i];
    for (const [dimId, scoreObj] of Object.entries(s.scores)) {
      if (scoreObj == null || typeof scoreObj !== 'object') {
        throw new Error(`skills[${i}].scores.${dimId} must be an object`);
      }
      for (const f of ['score', 'confidence', 'binary_checks', 'evidence']) {
        if (!(f in scoreObj)) {
          throw new Error(`skills[${i}].scores.${dimId} missing field: ${f}`);
        }
      }
      if (!CONFIDENCE_VALUES.has(scoreObj.confidence)) {
        throw new Error(
          `skills[${i}].scores.${dimId}.confidence must be one of high|medium|low, got ${JSON.stringify(scoreObj.confidence)}`
        );
      }
      if (!Array.isArray(scoreObj.binary_checks)) {
        throw new Error(`skills[${i}].scores.${dimId}.binary_checks must be an array`);
      }
      for (let j = 0; j < scoreObj.binary_checks.length; j++) {
        const bc = scoreObj.binary_checks[j];
        if (bc == null || typeof bc !== 'object') {
          throw new Error(`skills[${i}].scores.${dimId}.binary_checks[${j}] must be an object`);
        }
        if (typeof bc.label !== 'string') {
          throw new Error(`skills[${i}].scores.${dimId}.binary_checks[${j}].label must be a string`);
        }
        if (typeof bc.passed !== 'boolean') {
          throw new Error(`skills[${i}].scores.${dimId}.binary_checks[${j}].passed must be a boolean`);
        }
      }
      if (typeof scoreObj.evidence !== 'string') {
        throw new Error(`skills[${i}].scores.${dimId}.evidence must be a string`);
      }
      // Score range depends on dimension kind. Cross-field consistency further
      // ensures dimId is known; that's checked in Layer 3 below.
      const dim = dimById.get(dimId);
      if (dim) {
        const range = scoreRangeForKind(dim.kind);
        if (!Number.isInteger(scoreObj.score) || scoreObj.score < range.min || scoreObj.score > range.max) {
          throw new Error(
            `skills[${i}].scores.${dimId}.score must be integer ${range.min}..${range.max} for kind=${dim.kind}, got ${scoreObj.score}`
          );
        }
      }
    }
  }

  // Layer 3: cross-field consistency.
  const skillIds = new Set(obj.skills.map((s) => s.id));
  const pluginSet = new Set(obj.plugins);
  const dimIds = new Set(obj.dimensions.map((d) => d.id));

  for (let i = 0; i < obj.skills.length; i++) {
    const s = obj.skills[i];
    if (!pluginSet.has(s.plugin)) {
      throw new Error(`skills[${i}].plugin "${s.plugin}" is not in plugins[]`);
    }
    // Every dimension must appear in scores.
    for (const dimId of dimIds) {
      if (!(dimId in s.scores)) {
        throw new Error(`skills[${i}].scores is missing dimension "${dimId}"`);
      }
    }
    // No unknown dimension ids in scores.
    for (const dimId of Object.keys(s.scores)) {
      if (!dimIds.has(dimId)) {
        throw new Error(`skills[${i}].scores has unknown dimension "${dimId}"`);
      }
    }
  }

  if (!skillIds.has(obj.summary.highest_roi_skill_id)) {
    throw new Error(`summary.highest_roi_skill_id "${obj.summary.highest_roi_skill_id}" is not in skills[]`);
  }
  for (let i = 0; i < obj.top_actions.length; i++) {
    const a = obj.top_actions[i];
    if (!skillIds.has(a.skill_id)) {
      throw new Error(`top_actions[${i}].skill_id "${a.skill_id}" is not in skills[]`);
    }
  }

  return obj;
}

/** Score range per dimension kind. */
export function scoreRangeForKind(kind) {
  if (kind === 'likert5') return { min: 1, max: 5 };
  if (kind === 'eval_coverage') return { min: 0, max: 5 };
  if (kind === 'karpathy') return { min: 0, max: 1 };
  throw new Error(`unknown dimension kind: ${kind}`);
}

/** CSS tier class for a cell or pill, given the dimension kind and the score value. */
export function tierClassFor(kind, score) {
  if (kind === 'karpathy') {
    return score === 1 ? 'elig-yes' : 'elig-no';
  }
  // likert5 (1..5) → score-1..score-5.
  // eval_coverage (0..5) → score-0..score-5.
  return `score-${score}`;
}

/**
 * Substitute a send-prompt template.
 *
 * Tokens: {rank}, {skill_id}, {skill_name}, {action_text}, {scorecard_md_path}.
 * Path normalization: backslashes in scorecard_md_path are converted to forward slashes.
 */
export function buildSendPrompt(template, action, skill, scorecardMdPath) {
  const path = String(scorecardMdPath || '').replace(/\\/g, '/');
  return template
    .split('{scorecard_md_path}').join(path)
    .split('{action_text}').join(action.action_text)
    .split('{skill_name}').join(skill.name)
    .split('{skill_id}').join(skill.id)
    .split('{rank}').join(String(action.rank));
}

/** Attribute-escape (matches parallel-explore convention; order matters). */
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStringList(items) {
  if (!Array.isArray(items) || items.length === 0) return '<ul></ul>';
  return `<ul>${items.map((s) => `<li>${escapeHtml(String(s))}</li>`).join('')}</ul>`;
}

function renderBinaryStrip(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return '';
  const items = checks.map((bc) => {
    const cls = bc.passed ? 'binary-check passed' : 'binary-check failed';
    return `<span class="${cls}">${escapeHtml(bc.label)}</span>`;
  });
  return `<div class="binary-strip">${items.join('')}</div>`;
}

function renderDimensionPanel(dim, scoreObj, mdToHtmlFn, escapeHtmlFn) {
  const tier = tierClassFor(dim.kind, scoreObj.score);
  const scoreText = dim.kind === 'karpathy'
    ? (scoreObj.score === 1 ? 'Eligible' : 'Not eligible')
    : `${scoreObj.score}/${scoreRangeForKind(dim.kind).max}`;
  const confidenceCls = `confidence-pill ${scoreObj.confidence}`;
  const evidenceHtml = scoreObj.evidence
    ? `<div class="evidence">${mdToHtmlFn(scoreObj.evidence)}</div>`
    : '';
  return `<details>
    <summary>${escapeHtmlFn(dim.label)} <span class="dim-score-badge ${tier}">${escapeHtmlFn(scoreText)}</span></summary>
    <span class="${confidenceCls}">${escapeHtmlFn(scoreObj.confidence)} confidence</span>
    ${renderBinaryStrip(scoreObj.binary_checks)}
    ${evidenceHtml}
  </details>`;
}

function renderSkillDetailPanel(skill, dimensions, mdToHtmlFn, escapeHtmlFn) {
  const dimPanels = dimensions.map((dim) =>
    renderDimensionPanel(dim, skill.scores[dim.id], mdToHtmlFn, escapeHtmlFn)
  );
  const notesBlock = skill.notes ? `<div class="evidence">${mdToHtmlFn(skill.notes)}</div>` : '';
  const gapsBlock = renderStringList(skill.gaps);
  const actionsBlock = renderStringList(skill.next_actions);

  return `<div class="skill-detail-grid">${dimPanels.join('')}</div>
  <div class="skill-meta-block">
    <h4>Notes</h4>
    ${notesBlock || '<p class="meta">(none)</p>'}
    <h4>Gaps</h4>
    ${gapsBlock}
    <h4>Next actions</h4>
    ${actionsBlock}
  </div>`;
}

function renderSkillRow(skill, dimensions, escapeHtmlFn) {
  const scoreCells = dimensions.map((dim) => {
    const scoreObj = skill.scores[dim.id];
    const tier = tierClassFor(dim.kind, scoreObj.score);
    if (dim.kind === 'karpathy') {
      const label = scoreObj.score === 1 ? 'Eligible' : 'No';
      return `<td class="elig-cell"><span class="${tier}">${escapeHtmlFn(label)}</span></td>`;
    }
    return `<td class="score-cell ${tier}">${scoreObj.score}</td>`;
  });

  const kindBadge = `<span class="badge kind-${escapeHtmlFn(skill.kind)}">${escapeHtmlFn(skill.kind)}</span>`;
  const pluginBadge = `<span class="badge plugin">${escapeHtmlFn(skill.plugin)}</span>`;
  const eligClass = skill.karpathy_eligible === 1 ? 'elig-yes' : 'elig-no';
  const eligText = skill.karpathy_eligible === 1 ? 'Yes' : 'No';
  const detailId = `detail-${skill.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const isEligibleClass = skill.karpathy_eligible === 1 ? ' is-eligible' : '';
  const roiFormatted = Number.isFinite(skill.roi) ? skill.roi.toFixed(2) : String(skill.roi);

  return `<tr class="skill-row${isEligibleClass}">
    <td class="rank-cell">${skill.rank}</td>
    <td class="skill-cell"><span class="skill-name">${escapeHtmlFn(skill.name)}</span><span class="badges">${kindBadge}${pluginBadge}</span></td>
    ${scoreCells.join('')}
    <td class="roi-cell">${escapeHtmlFn(roiFormatted)}</td>
    <td class="elig-cell"><span class="${eligClass}">${escapeHtmlFn(eligText)}</span></td>
    <td><button type="button" class="expand-toggle" data-target="${detailId}" aria-label="Expand ${escapeHtmlFn(skill.name)}">+</button></td>
  </tr>`;
}

function renderTopActions(scorecard, scorecardMdPath, escapeHtmlFn) {
  if (!Array.isArray(scorecard.top_actions) || scorecard.top_actions.length === 0) {
    return '<li class="empty">No improvement actions recorded.</li>';
  }
  const skillById = new Map(scorecard.skills.map((s) => [s.id, s]));
  return scorecard.top_actions.map((a) => {
    const skill = skillById.get(a.skill_id);
    const promptText = buildSendPrompt(a.send_prompt_template, a, skill, scorecardMdPath);
    const addresses = a.addresses
      ? `<span class="roi-delta"> — addresses ${escapeHtmlFn(a.addresses)}</span>`
      : '';
    const roiDelta = a.est_roi_delta != null
      ? `<span class="roi-delta"> (est. ROI Δ ${escapeHtmlFn(String(a.est_roi_delta))})</span>`
      : '';
    return `<li>
      <span class="action-rank">${a.rank}</span>
      <span class="action-text"><span class="target">${escapeHtmlFn(skill.name)}</span> — ${escapeHtmlFn(a.action_text)}${addresses}${roiDelta}</span>
      <button type="button" class="send-prompt-btn" data-send-prompt="${escapeAttr(promptText)}">Send to agent</button>
    </li>`;
  }).join('');
}

/** Render the canonical markdown form of the scorecard. */
export function renderMarkdown(scorecard) {
  const lines = [];
  lines.push(`# Skill Audit Scorecard`);
  lines.push('');
  lines.push(`Run: \`${scorecard.run_slug}\` · ${scorecard.created_at}`);
  lines.push(`Plugins: ${scorecard.plugins.join(', ')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Skills assessed: ${scorecard.summary.skills_assessed}`);
  lines.push(`- Average score: ${scorecard.summary.average_score}`);
  lines.push(`- Karpathy-eligible: ${scorecard.summary.karpathy_eligible_count}`);
  lines.push(`- Highest ROI: \`${scorecard.summary.highest_roi_skill_id}\``);
  lines.push('');

  lines.push('## Rankings');
  lines.push('');
  const header = ['Rank', 'Skill', 'Plugin', 'Kind', ...scorecard.dimensions.map((d) => d.label), 'ROI', 'K-elig'];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const s of scorecard.skills) {
    const cells = [
      String(s.rank),
      s.name,
      s.plugin,
      s.kind,
      ...scorecard.dimensions.map((d) => {
        const so = s.scores[d.id];
        if (d.kind === 'karpathy') return so.score === 1 ? 'Yes' : 'No';
        return String(so.score);
      }),
      Number.isFinite(s.roi) ? s.roi.toFixed(2) : String(s.roi),
      s.karpathy_eligible === 1 ? 'Yes' : 'No',
    ];
    lines.push(`| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Top improvement actions');
  lines.push('');
  if (!scorecard.top_actions || scorecard.top_actions.length === 0) {
    lines.push('_(none)_');
  } else {
    const skillById = new Map(scorecard.skills.map((s) => [s.id, s]));
    for (const a of scorecard.top_actions) {
      const skill = skillById.get(a.skill_id);
      const addresses = a.addresses ? ` — addresses ${a.addresses}` : '';
      const roiDelta = a.est_roi_delta != null ? ` (est. ROI Δ ${a.est_roi_delta})` : '';
      lines.push(`${a.rank}. **${skill.name}** (\`${skill.id}\`) — ${a.action_text}${addresses}${roiDelta}`);
    }
  }
  lines.push('');

  lines.push('## Per-skill details');
  lines.push('');
  for (const s of scorecard.skills) {
    lines.push(`### ${s.rank}. ${s.name}`);
    lines.push('');
    lines.push(`- Plugin: \`${s.plugin}\` · Kind: ${s.kind} · ROI: ${Number.isFinite(s.roi) ? s.roi.toFixed(2) : s.roi} · Karpathy-eligible: ${s.karpathy_eligible === 1 ? 'Yes' : 'No'}`);
    lines.push('');
    for (const dim of scorecard.dimensions) {
      const so = s.scores[dim.id];
      const scoreText = dim.kind === 'karpathy'
        ? (so.score === 1 ? 'Eligible' : 'Not eligible')
        : `${so.score}/${scoreRangeForKind(dim.kind).max}`;
      lines.push(`**${dim.label}**: ${scoreText} (${so.confidence} confidence)`);
      lines.push('');
      if (so.binary_checks && so.binary_checks.length > 0) {
        for (const bc of so.binary_checks) {
          lines.push(`- [${bc.passed ? 'x' : ' '}] ${bc.label}`);
        }
        lines.push('');
      }
      if (so.evidence) {
        lines.push(so.evidence);
        lines.push('');
      }
    }
    if (s.notes) {
      lines.push(`**Notes:** ${s.notes}`);
      lines.push('');
    }
    if (s.gaps && s.gaps.length > 0) {
      lines.push('**Gaps:**');
      for (const g of s.gaps) lines.push(`- ${g}`);
      lines.push('');
    }
    if (s.next_actions && s.next_actions.length > 0) {
      lines.push('**Next actions:**');
      for (const a of s.next_actions) lines.push(`- ${a}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Pure HTML render. Takes the template string and the markdown converter as parameters.
 */
export function renderHtml(scorecard, templateString, mdToHtmlFn, escapeHtmlFn, opts) {
  const scorecardMdPath = (opts && opts.scorecardMdPath) || '';

  const dimensionHeaders = scorecard.dimensions
    .map((d) => `<th>${escapeHtmlFn(d.label)}</th>`)
    .join('');

  const skillRows = scorecard.skills.map((skill) => {
    const row = renderSkillRow(skill, scorecard.dimensions, escapeHtmlFn);
    const detailId = `detail-${skill.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const isEligibleClass = skill.karpathy_eligible === 1 ? ' is-eligible' : '';
    const detail = renderSkillDetailPanel(skill, scorecard.dimensions, mdToHtmlFn, escapeHtmlFn);
    const detailRow = `<tr class="skill-detail${isEligibleClass}" id="${detailId}" hidden><td colspan="${scorecard.dimensions.length + 5}">${detail}</td></tr>`;
    return `${row}\n${detailRow}`;
  }).join('\n');

  const topActions = renderTopActions(scorecard, scorecardMdPath, escapeHtmlFn);

  const subs = {
    '{{run_slug}}': escapeHtmlFn(scorecard.run_slug),
    '{{created_at}}': escapeHtmlFn(scorecard.created_at),
    '{{plugins_inline}}': scorecard.plugins.map((p) => `<code>${escapeHtmlFn(p)}</code>`).join(', '),
    '{{summary_skills_assessed}}': escapeHtmlFn(String(scorecard.summary.skills_assessed)),
    '{{summary_average_score}}': escapeHtmlFn(String(scorecard.summary.average_score)),
    '{{summary_karpathy_count}}': escapeHtmlFn(String(scorecard.summary.karpathy_eligible_count)),
    '{{summary_top_roi_id}}': escapeHtmlFn(scorecard.summary.highest_roi_skill_id),
    '{{dimension_headers}}': dimensionHeaders,
    '{{skill_rows}}': skillRows,
    '{{top_actions_list}}': topActions,
  };

  let html = templateString;
  for (const [token, value] of Object.entries(subs)) {
    html = html.split(token).join(value);
  }
  return html;
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const HELP_TEXT = `Usage: node render-scorecard.mjs --input <path>/scorecard.json --output-dir <path>

Reads an audit-skills scorecard.json, validates it, and writes
scorecard.md + scorecard.html into --output-dir.

Options:
  --input <path>       Path to scorecard.json (required)
  --output-dir <path>  Directory to write scorecard.md + scorecard.html (required)
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
 * Sync main returning integer exit code.
 * MUST stay synchronous — process.exit(main(argv)) would coerce a Promise to NaN.
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

  let raw;
  try {
    raw = readFileSync(opts.input, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to read --input: ${e.message}\n`);
    return 1;
  }

  let scorecard;
  try {
    scorecard = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Error: failed to parse JSON: ${e.message}\n`);
    return 1;
  }

  try {
    validateScorecard(scorecard);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }

  const outDir = resolve(opts.outputDir);
  try {
    ensureDir(outDir);
  } catch (e) {
    process.stderr.write(`Error: failed to create --output-dir: ${e.message}\n`);
    return 1;
  }

  const scorecardMdPath = join(outDir, 'scorecard.md').replace(/\\/g, '/');

  const templatePath = fileURLToPath(new URL('./scorecard-template.html', import.meta.url));
  let templateString;
  try {
    templateString = readFileSync(templatePath, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to read template: ${e.message}\n`);
    return 1;
  }

  let mdOut, htmlOut;
  try {
    mdOut = renderMarkdown(scorecard);
    htmlOut = renderHtml(scorecard, templateString, mdToHtml, escapeHtml, {
      scorecardMdPath,
    });
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
    writeFileSync(join(outDir, 'scorecard.md'), mdOut, 'utf8');
    writeFileSync(join(outDir, 'scorecard.html'), htmlOut, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: failed to write output: ${e.message}\n`);
    return 1;
  }

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
