#!/usr/bin/env node
/**
 * spec-validate — Workshop artifact validator
 *
 * Validates workshop artifacts against the bundled pattern-library methodology.
 * Produces a terminal-style report with errors (must fix) and warnings (should fix),
 * where every message explains WHY the issue matters — not just what's wrong.
 *
 * Usage: node validate.js <workshop-path>
 * Example: node validate.js ./outputs/workshops/portable-spec-cli
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const workshopPath = process.argv[2];
if (!workshopPath) {
  console.error('Usage: node validate.js <workshop-path>');
  process.exit(1);
}

if (!existsSync(workshopPath)) {
  console.error(`Workshop path not found: ${workshopPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const errors = [];
const warnings = [];
const info = [];

function error(artifact, msg) { errors.push({ artifact, msg }); }
function warn(artifact, msg) { warnings.push({ artifact, msg }); }
function ok(msg) { info.push(msg); }

function readArtifact(name) {
  const p = join(workshopPath, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

function readJson(name) {
  const content = readArtifact(name);
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Ambiguity flag words — from decision-resolution pattern
// ---------------------------------------------------------------------------

const AMBIGUITY_FLAGS = [
  { pattern: /\bTBD\b/gi, word: 'TBD' },
  { pattern: /\bTODO\b/gi, word: 'TODO' },
  { pattern: /\bpossibly\b/gi, word: 'possibly' },
  { pattern: /\bperhaps\b/gi, word: 'perhaps' },
  { pattern: /\bmight\b/gi, word: 'might' },
  { pattern: /\bshould consider\b/gi, word: 'should consider' },
  { pattern: /\bpreferably\b/gi, word: 'preferably' },
];

// Vague verification phrases — from test-first-spec / verification-criteria patterns
const VAGUE_VERIFICATION = [
  { pattern: /\bshould work\b/gi, phrase: 'should work' },
  { pattern: /\blooks good\b/gi, phrase: 'looks good' },
  { pattern: /\bfunctions? properly\b/gi, phrase: 'functions properly' },
  { pattern: /\bworks as expected\b/gi, phrase: 'works as expected' },
  { pattern: /\bshould be fine\b/gi, phrase: 'should be fine' },
  { pattern: /\bseems right\b/gi, phrase: 'seems right' },
];

// ---------------------------------------------------------------------------
// Line-level skip helpers — reduce false positives from code blocks, quotes, etc.
// ---------------------------------------------------------------------------

/**
 * Track whether we're inside a fenced code block across lines.
 * Returns a function that, given a line, returns true if the line should be skipped.
 */
function createLineSkipper() {
  let inCodeBlock = false;
  return (line) => {
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      return true;
    }
    if (inCodeBlock) return true;
    // Skip blockquotes (quoted text, examples)
    if (/^\s*>/.test(line)) return true;
    return false;
  };
}

/**
 * Strip quoted phrases from a line before scanning for flag words.
 * Prevents false positives when a line *references* a bad phrase rather than *using* it.
 * e.g., A spec with "should work correctly" → the quoted portion is stripped before scanning.
 */
function stripQuotedPhrases(line) {
  return line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

// ---------------------------------------------------------------------------
// Pipeline stage definitions
// ---------------------------------------------------------------------------

const PIPELINE = [
  { status: 'problem-statement', artifact: 'problem-statement.md', label: 'Problem Statement' },
  { status: 'decisions', artifact: 'decisions.md', label: 'Decisions' },
  { status: 'verification', artifact: 'verification.md', label: 'Verification Criteria' },
  { status: 'constraints', artifact: 'constraints.md', label: 'Constraints' },
  { status: 'decomposition', artifact: 'decomposition.md', label: 'Decomposition' },
  { status: 'ready', artifact: null, label: 'Work Packages + Orchestrator' },
];

const STATUS_ORDER = ['captured', 'problem-statement', 'decisions', 'verification', 'constraints', 'decomposition', 'ready', 'archived'];

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateMeta() {
  const meta = readJson('meta.json');
  if (!meta) {
    error('meta.json', 'Missing meta.json — every workshop needs metadata (title, slug, status, projects). Without it, a workshop tracker cannot track or display this workshop.');
    return null;
  }

  if (!meta.title) error('meta.json', 'Missing "title" — a workshop tracker uses this to display the workshop. Without it, the workshop shows up unnamed.');
  if (!meta.slug) error('meta.json', 'Missing "slug" — must match the directory name. Required for orchestrator path derivation and workshop tracking.');
  if (!meta.status) error('meta.json', 'Missing "status" — tracks pipeline progress. Without it, resume flow cannot determine where you left off.');
  if (meta.slug && meta.slug !== basename(workshopPath)) {
    warn('meta.json', `Slug "${meta.slug}" doesn't match directory name "${basename(workshopPath)}". Workshop paths are derived from the slug — a mismatch causes confusing path errors.`);
  }
  if (!meta.projects || !Array.isArray(meta.projects)) {
    warn('meta.json', 'Missing or non-array "projects" field. Use "projects" (plural, array) — the workshop handler reads Array.isArray(meta.projects). A singular "project" string silently resolves to empty.');
  }
  if (!meta.startedAt) warn('meta.json', 'Missing "startedAt" — captures when the workshop was initiated. Used for lifecycle cost tracking in post-mortems.');
  if (!meta.createdAt) warn('meta.json', 'Missing "createdAt" — when meta.json was written to disk.');

  ok('meta.json present and parseable');
  return meta;
}

function validateProblemStatement() {
  const content = readArtifact('problem-statement.md');
  if (!content) return;

  const sections = {
    'What We\'re Solving': /^##\s+What We.re Solving/mi,
    'Current State': /^##\s+Current State/mi,
    'What "Solved" Looks Like': /^##\s+What .Solved. Looks Like/mi,
    'What\'s Actually Broken': /^##\s+What.s Actually Broken/mi,
  };

  // Check from template structure
  for (const [name, regex] of Object.entries(sections)) {
    if (!regex.test(content)) {
      warn('problem-statement.md', `Missing section: "${name}". The template expects this section — it forces grounding. Without it, the problem may not pass the self-containment test.`);
    }
  }

  // Self-containment heuristic: is it long enough to be grounded?
  const wordCount = content.split(/\s+/).length;
  if (wordCount < 100) {
    warn('problem-statement.md', `Only ~${wordCount} words. Problem statements under 100 words rarely pass the self-containment test — could a stranger begin solving this from what's written?`);
  }

  // Check for unfilled template placeholders (single identifiers like {slug}, not code like { provider, model })
  const placeholderRegex = /\{[a-zA-Z][a-zA-Z0-9_-]*\}/g;
  // Filter out matches inside code blocks or inline code
  const nonCodeContent = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  const placeholders = nonCodeContent.match(placeholderRegex) || [];
  if (placeholders.length > 0) {
    warn('problem-statement.md', `Found ${placeholders.length} unfilled template placeholder(s): ${placeholders.slice(0, 3).join(', ')}${placeholders.length > 3 ? '...' : ''}. These suggest the template was copied but not fully populated.`);
  }

  ok('problem-statement.md present');
}

function validateDecisions() {
  const content = readArtifact('decisions.md');
  if (!content) return;

  // Check for numbered decisions (D1, D2, etc.)
  const decisionHeaders = content.match(/^##\s+D\d+/gm) || [];
  if (decisionHeaders.length === 0) {
    warn('decisions.md', 'No numbered decisions found (expected D1, D2, D3... headers). Numbered decisions make cross-referencing from verification criteria (D1→V1) possible.');
  } else {
    ok(`decisions.md: ${decisionHeaders.length} numbered decision(s) found`);
  }

  // Ambiguity scan — flag words that suggest unresolved decisions
  // Skip: rejected alternatives sections, open questions, code blocks, blockquotes
  const lines = content.split('\n');
  let inSkipSection = false;
  const skipLine = createLineSkipper();
  const flaggedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skipLine(line)) continue;
    if (/rejected alternative/i.test(line) || /open questions/i.test(line)) { inSkipSection = true; continue; }
    if (/^##/.test(line)) { inSkipSection = false; }
    if (inSkipSection) continue;

    const cleanLine = stripQuotedPhrases(line);
    for (const { pattern, word } of AMBIGUITY_FLAGS) {
      pattern.lastIndex = 0;
      if (pattern.test(cleanLine)) {
        flaggedLines.push({ line: i + 1, word, text: line.trim().substring(0, 80) });
      }
    }
  }

  if (flaggedLines.length > 0) {
    for (const f of flaggedLines.slice(0, 5)) {
      warn('decisions.md', `Ambiguity flag "${f.word}" at line ${f.line}: "${f.text}" — every unresolved decision is a fork where two agents would produce different output. Decide or cut.`);
    }
    if (flaggedLines.length > 5) {
      warn('decisions.md', `...and ${flaggedLines.length - 5} more ambiguity flags. Run the full decision-resolution scan.`);
    }
  }

  // Check each decision has a "Why" or reasoning
  const decisionBlocks = content.split(/^##\s+D\d+/m).slice(1);
  let missingWhy = 0;
  for (const block of decisionBlocks) {
    if (!/\*\*Why[:\*]/i.test(block) && !/\*\*Reason/i.test(block) && !/\*\*Choice\*\*/i.test(block)) {
      missingWhy++;
    }
  }
  if (missingWhy > 0) {
    warn('decisions.md', `${missingWhy} decision(s) missing documented reasoning (no "Why:" or "Choice:" found). Decisions without reasoning can't be evaluated later — you won't remember why you chose this.`);
  }
}

function validateVerification() {
  const content = readArtifact('verification.md');
  if (!content) return;

  // Check for V-numbered sections mapping to decisions
  const vHeaders = content.match(/^##\s+V\d+/gm) || [];
  if (vHeaders.length === 0) {
    warn('verification.md', 'No numbered verification criteria found (expected V1, V2... headers). Each should map to a decision (D1→V1). Without this mapping, you can\'t trace verification back to what was decided.');
  } else {
    ok(`verification.md: ${vHeaders.length} verification criteria found`);
  }

  // Check for verification type (match both **Verification type:** and **Verification type**)
  const hasVerificationType = /\*\*Verification type/i.test(content);
  if (!hasVerificationType && vHeaders.length > 0) {
    warn('verification.md', 'No "Verification type" fields found. The verification hierarchy (automated test > build check > CLI command > Playwright > manual observation) helps prioritize — prefer stronger forms.');
  }

  // Vague verification scan (skip code blocks and blockquotes)
  const vLines = content.split('\n');
  const skipVLine = createLineSkipper();
  const vagueHits = [];
  for (let i = 0; i < vLines.length; i++) {
    if (skipVLine(vLines[i])) continue;
    const cleanVLine = stripQuotedPhrases(vLines[i]);
    for (const { pattern, phrase } of VAGUE_VERIFICATION) {
      pattern.lastIndex = 0;
      if (pattern.test(cleanVLine)) {
        vagueHits.push({ line: i + 1, phrase, text: vLines[i].trim().substring(0, 80) });
      }
    }
  }

  if (vagueHits.length > 0) {
    for (const v of vagueHits.slice(0, 5)) {
      error('verification.md', `Vague verification "${v.phrase}" at line ${v.line}: "${v.text}" — this isn't verifiable. An independent observer can't check "works as expected." Replace with a specific, observable assertion.`);
    }
  }

  // Check for "How to verify" sections
  const howToVerify = (content.match(/\*\*How to verify/gi) || []).length;
  if (howToVerify === 0 && vHeaders.length > 0) {
    warn('verification.md', 'No "How to verify" sections found. Each V-criterion should include the exact command, URL, or procedure. Without it, verification is aspirational — you wrote what success looks like but not how to check.');
  }

  // Check for verification layers (new layered model)
  const hasLayers = /\*\*(?:Layers|Unit|Fixture|Seam|Deployment)/i.test(content);
  const hasOldType = /\*\*Verification type/i.test(content);
  if (!hasLayers && hasOldType && vHeaders.length > 0) {
    warn('verification.md', 'Uses flat "Verification type" instead of layered model. Each V-criterion should specify which layers apply: Unit, Fixture-contract, Seam-integration, Deployment. A single "Automated test" label hides whether seams are actually covered.');
  }

  // Check for excessive manual observation
  const manualCount = (content.match(/manual observation/gi) || []).length;
  const verificationTypeCount = (content.match(/\*\*Verification type\*\*[^\n]*/gi) || []);
  const manualAsType = verificationTypeCount.filter(l => /manual observation/i.test(l)).length;
  if (manualAsType > 0 && vHeaders.length > 0) {
    const ratio = manualAsType / vHeaders.length;
    if (ratio > 0.3) {
      warn('verification.md', `${manualAsType} of ${vHeaders.length} criteria use "Manual observation" as primary verification type (${Math.round(ratio * 100)}%). Manual verification doesn't scale to automated dispatch. For each, ask: is this genuinely subjective, or just hard to automate?`);
    }
  }

  // Check for Verification Gaps section
  const hasGaps = /##\s+Verification Gaps/i.test(content);
  if (!hasGaps && vHeaders.length > 0) {
    warn('verification.md', 'No "Verification Gaps" section found. Every verification.md should end with an explicit list of uncovered seams and rationale for why each gap is acceptable. Unlisted gaps are invisible gaps.');
  }

  // Check for seam identification
  const hasSeamMention = /seam|handoff|integration|fixture/i.test(content);
  if (!hasSeamMention && vHeaders.length >= 3) {
    warn('verification.md', 'No mention of seams, handoffs, integration tests, or fixtures in a spec with 3+ criteria. Specs of this size almost always have service boundaries that need seam-level verification. Check whether data crosses any service boundary between V-criteria.');
  }
}

function validateConstraints() {
  const content = readArtifact('constraints.md');
  if (!content) return;

  const categories = {
    'Musts': /\bMusts?\b.*(?:Non-Negotiable|Requirements?)/i,
    'Must-Nots': /\bMust.Nots?\b.*(?:Explicit|Prohibitions?)/i,
    'Preferences': /\bPreferences?\b.*(?:Guidance|Ambiguous)/i,
    'Escalation Triggers': /\bEscalation\s+Triggers?\b/i,
  };

  const present = [];
  const missing = [];

  for (const [name, regex] of Object.entries(categories)) {
    if (regex.test(content)) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    for (const m of missing) {
      const msgs = {
        'Musts': 'Missing "Musts" category — non-negotiable requirements that apply across all work packages. Without these, agents have no global invariants to maintain.',
        'Must-Nots': 'Missing "Must-Nots" category — explicit prohibitions prevent the most expensive class of agent failure: scope violations. A single missing must-not can waste an entire dispatch.',
        'Preferences': 'Missing "Preferences" category — guidance for ambiguous situations. Without stated preferences, agents guess, and guesses diverge from intent in subtle ways.',
        'Escalation Triggers': 'Missing "Escalation Triggers" category — conditions where the agent should stop and ask. Without these, agents make judgment calls that should be yours.',
      };
      warn('constraints.md', msgs[m]);
    }
  }

  if (present.length === 4) {
    ok('constraints.md: all four constraint categories present');
  } else {
    ok(`constraints.md: ${present.length}/4 categories present (${present.join(', ')})`);
  }

  // Check for numbered constraints (M1, MN1, P1, E1)
  const numbered = content.match(/^###\s+(?:M\d+|MN\d+|P\d+|E\d+)/gm) || [];
  if (numbered.length === 0 && present.length > 0) {
    warn('constraints.md', 'No numbered constraints found (M1, MN1, P1, E1 convention). Numbering enables cross-referencing from work packages and post-mortems.');
  }
}

function validateDecomposition() {
  const content = readArtifact('decomposition.md');
  if (!content) return;

  // Check for break pattern identification
  if (!/break pattern/i.test(content)) {
    warn('decomposition.md', 'No break pattern identified. The decomposition pattern defines break patterns by work type (API/Backend, UI, Refactor, Infrastructure). Naming the pattern makes the decomposition rationale explicit and reusable.');
  }

  // Check for work units
  const wpHeaders = content.match(/^###\s+WP-?\d+/gmi) || [];
  if (wpHeaders.length === 0) {
    warn('decomposition.md', 'No work units found (expected WP-1, WP-2... headers). Decomposition should produce numbered work units that become work packages.');
  } else {
    ok(`decomposition.md: ${wpHeaders.length} work unit(s) identified`);
  }

  // Check for the decomposition test criteria
  if (!/(?:less than|<)\s*2\s*hours?/i.test(content) && !/independently verifiable/i.test(content) && !/disjoint/i.test(content)) {
    warn('decomposition.md', 'No evidence of the decomposition test being applied (< 2hrs, clear boundaries, independently verifiable, disjoint files). This test catches "multiple tasks wearing a trenchcoat."');
  }
}

function validateWorkPackages() {
  const wpDir = join(workshopPath, 'work-packages');
  if (!existsSync(wpDir)) return;

  const files = readdirSync(wpDir).filter(f => f.endsWith('.md'));
  const orchestrator = files.find(f => f === '_orchestrator.md');
  const wpFiles = files.filter(f => f !== '_orchestrator.md');

  if (!orchestrator) {
    error('work-packages/', 'Missing _orchestrator.md — the coordination layer for wave plan, package inventory, and gate commands. Without it, execution agents have no shared context or dependency ordering.');
  } else {
    const orch = readFileSync(join(wpDir, '_orchestrator.md'), 'utf-8');

    // Check coordination sections
    if (!/^## Wave Plan/m.test(orch)) error('_orchestrator.md', 'Missing "## Wave Plan" section — required to determine execution order across work packages.');
    if (!/^## Package Inventory/m.test(orch)) error('_orchestrator.md', 'Missing "## Package Inventory" section — required to map packages to projects and spec files.');
    if (!/^## Gate Commands/m.test(orch)) warn('_orchestrator.md', 'Missing "## Gate Commands" section — without explicit gates, defaults to `npx tsc --noEmit` per project.');

    // Check for spec-level constraints
    if (!/constraint/i.test(orch) && !/must/i.test(orch)) {
      warn('_orchestrator.md', 'No spec-level constraints found in orchestrator. Constraints from constraints.md should be summarized here — execution agents read the orchestrator, not the full workshop artifacts.');
    }

    ok('_orchestrator.md present');
  }

  // Validate individual work packages
  const REQUIRED_WP_FIELDS = ['Precondition', 'Goal', 'Files', 'Verification', 'Failure Criteria', 'Boundary'];

  for (const wpFile of wpFiles) {
    const content = readFileSync(join(wpDir, wpFile), 'utf-8');
    const missingFields = [];

    for (const field of REQUIRED_WP_FIELDS) {
      const regex = new RegExp(`\\*\\*${field}\\*\\*|^##\\s+${field}`, 'mi');
      if (!regex.test(content)) {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      error(wpFile, `Missing ${missingFields.length} required field(s): ${missingFields.join(', ')}. Work packages need all 6 fields to be independently dispatchable. Missing fields create ambiguity that agents resolve differently.`);
    } else {
      ok(`${wpFile}: all 6 required fields present`);
    }

    // Vague verification in WP (skip code blocks and blockquotes)
    const wpLines = content.split('\n');
    const skipWpLine = createLineSkipper();
    for (let li = 0; li < wpLines.length; li++) {
      if (skipWpLine(wpLines[li])) continue;
      const cleanWpLine = stripQuotedPhrases(wpLines[li]);
      for (const { pattern, phrase } of VAGUE_VERIFICATION) {
        pattern.lastIndex = 0;
        if (pattern.test(cleanWpLine)) {
          error(wpFile, `Vague verification phrase "${phrase}" at line ${li + 1}. Work package verification must be a specific command or observable behavior — not a judgment call. "npm test" is verification. "Should work correctly" is not.`);
        }
      }
    }
  }

  if (wpFiles.length > 0) {
    ok(`work-packages/: ${wpFiles.length} work package file(s) found`);
  }
}

// ---------------------------------------------------------------------------
// Pipeline completeness check
// ---------------------------------------------------------------------------

function validatePipelineCompleteness(meta) {
  if (!meta) return;

  const statusIdx = STATUS_ORDER.indexOf(meta.status);
  if (statusIdx === -1) {
    warn('meta.json', `Unknown status "${meta.status}". Known statuses: ${STATUS_ORDER.join(', ')}`);
    return;
  }

  // Check that artifacts exist for all stages up to current status
  for (const stage of PIPELINE) {
    const stageIdx = STATUS_ORDER.indexOf(stage.status);
    if (stageIdx > statusIdx) break; // haven't reached this stage yet
    if (!stage.artifact) continue; // work-packages handled separately

    if (!existsSync(join(workshopPath, stage.artifact))) {
      error(stage.artifact, `Status is "${meta.status}" but ${stage.artifact} is missing. The workshop claims to be past the ${stage.label} stage, but the artifact doesn't exist. Either the status is wrong or the artifact was lost.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run all validators
// ---------------------------------------------------------------------------

const slug = basename(workshopPath);
console.log(`\n  spec-validate: ${slug}`);
console.log(`  ${'─'.repeat(50)}\n`);

const meta = validateMeta();
validatePipelineCompleteness(meta);
validateProblemStatement();
validateDecisions();
validateVerification();
validateConstraints();
validateDecomposition();
validateWorkPackages();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('');

if (errors.length > 0) {
  console.log(`  \x1b[31m✖ ${errors.length} ERROR${errors.length > 1 ? 'S' : ''}\x1b[0m\n`);
  for (const e of errors) {
    console.log(`    \x1b[31m✖\x1b[0m [${e.artifact}] ${e.msg}\n`);
  }
}

if (warnings.length > 0) {
  console.log(`  \x1b[33m⚠ ${warnings.length} WARNING${warnings.length > 1 ? 'S' : ''}\x1b[0m\n`);
  for (const w of warnings) {
    console.log(`    \x1b[33m⚠\x1b[0m [${w.artifact}] ${w.msg}\n`);
  }
}

if (info.length > 0) {
  console.log(`  \x1b[32m✓ ${info.length} PASSED\x1b[0m\n`);
  for (const i of info) {
    console.log(`    \x1b[32m✓\x1b[0m ${i}`);
  }
  console.log('');
}

const total = errors.length + warnings.length + info.length;
console.log(`  ─────────────────────────────────────────────────`);
console.log(`  ${errors.length === 0 ? '\x1b[32m' : '\x1b[31m'}${errors.length} errors\x1b[0m, \x1b[33m${warnings.length} warnings\x1b[0m, \x1b[32m${info.length} passed\x1b[0m`);

if (meta) {
  const stageIdx = STATUS_ORDER.indexOf(meta.status);
  const stageLabel = PIPELINE.find(p => p.status === meta.status)?.label || meta.status;
  console.log(`  Pipeline stage: ${stageLabel} (${stageIdx}/${PIPELINE.length})`);
}

console.log('');

process.exit(errors.length > 0 ? 1 : 0);
