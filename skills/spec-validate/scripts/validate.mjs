#!/usr/bin/env node
/**
 * spec-validate — Workshop artifact validator
 *
 * Validates workshop artifacts against the bundled pattern-library methodology.
 * Produces a terminal-style report with errors (must fix) and warnings (should fix),
 * where every message explains WHY the issue matters — not just what's wrong.
 *
 * Usage: node validate.mjs <workshop-path> [--workspace-root <abs-path>]
 * Example: node validate.mjs ./outputs/workshops/portable-spec-cli
 *
 * Target enforcement: meta.projects (non-empty array) is required — it declares
 * the workshop's target repo(s) so worktree rooting never falls back to session
 * cwd. When a workspace root is provided (--workspace-root flag, or the
 * WORKIT_WORKSPACE_ROOT env var; CLI wins), each declared project must resolve
 * to <workspace-root>/projects/<name> on disk. Without a root, the disk check
 * is skipped silently — no warning — so root-less invocations stay clean.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';

let workshopPath = null;
let cliWorkspaceRoot = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--workspace-root') {
    if (argv[i + 1] === undefined) {
      console.error('--workspace-root requires a value');
      process.exit(1);
    }
    cliWorkspaceRoot = argv[++i];
  } else if (a.startsWith('--workspace-root=')) {
    cliWorkspaceRoot = a.slice('--workspace-root='.length);
  } else if (workshopPath === null) {
    workshopPath = a;
  }
}

if (!workshopPath) {
  console.error('Usage: node validate.mjs <workshop-path> [--workspace-root <abs-path>]');
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
// Workspace root resolution — opt-in, and NEVER via cwd (M1)
// ---------------------------------------------------------------------------
// Precedence: --workspace-root CLI flag > WORKIT_WORKSPACE_ROOT env var >
// unresolved. Unresolved means the disk-resolution check is skipped entirely
// and silently — the validator cannot guess a workspace root, and resolving a
// relative root against process.cwd() would reintroduce the exact cwd
// dependency target declaration exists to remove.

let workspaceRoot = null;
{
  let rawRoot = null;
  let rootSource = null;
  if (cliWorkspaceRoot !== null) {
    rawRoot = cliWorkspaceRoot;
    rootSource = '--workspace-root';
  } else if (process.env.WORKIT_WORKSPACE_ROOT) {
    rawRoot = process.env.WORKIT_WORKSPACE_ROOT;
    rootSource = 'WORKIT_WORKSPACE_ROOT';
  }
  if (rawRoot !== null) {
    if (!isAbsolute(rawRoot)) {
      error('workspace-root', `${rootSource} must be an absolute path (got "${rawRoot}"). A relative root would have to be resolved against the session cwd — the exact dependency declared targets exist to remove. Pass the workspace root as an absolute path.`);
    } else if (!existsSync(rawRoot) || !statSync(rawRoot).isDirectory()) {
      error('workspace-root', `${rootSource} "${rawRoot}" does not exist or is not a directory. The workspace root itself is invalid — fix the flag/env value; this is not a per-project resolution failure.`);
    } else {
      workspaceRoot = rawRoot;
    }
  }
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
  if (!meta.projects || !Array.isArray(meta.projects) || meta.projects.length === 0) {
    error('meta.json', 'Missing or empty "projects" — the declared target repo(s). Worktree rooting resolves a work item\'s target from this declaration, never from session cwd; without it the workshop is undispatchable. Use "projects" (plural, non-empty array of repo names) — a singular "project" string silently resolves to empty.');
  }
  if (!meta.startedAt) warn('meta.json', 'Missing "startedAt" — captures when the workshop was initiated. Used for lifecycle cost tracking in post-mortems.');
  if (!meta.createdAt) warn('meta.json', 'Missing "createdAt" — when meta.json was written to disk.');

  ok('meta.json present and parseable');
  return meta;
}

function validateProblemStatement() {
  const content = readArtifact('problem-statement.md');
  if (!content) return;

  // Accept BOTH problem-statement vocabularies: the fuller template
  // (problem-statement.template.md: "What We're Solving" / "Current State" /
  // "What's Actually Broken") and the pattern's lightweight capture structure
  // (problem-statement.md: "The Problem" / "Open Questions" / "Hidden
  // Assumptions"). A faithful author may follow either, so a missing-section
  // warning should only fire when neither form's heading is present.
  const sections = {
    'a problem description (e.g. "What We\'re Solving" or "The Problem")':
      /^##\s+(?:What We.re Solving|The Problem|Problem|Context)\b/mi,
    'current state / grounding (e.g. "Current State")':
      /^##\s+(?:Current State|Background|Context)\b/mi,
    'what "Solved" looks like':
      /^##\s+What .Solved. Looks Like/mi,
    'specific failures or open questions (e.g. "What\'s Actually Broken" or "Open Questions")':
      /^##\s+(?:What.s Actually Broken|Open Questions|Hidden Assumptions)\b/mi,
  };

  for (const [name, regex] of Object.entries(sections)) {
    if (!regex.test(content)) {
      warn('problem-statement.md', `Missing ${name}. A grounded problem statement needs this (the template and the lightweight pattern form both count) — without it, the problem may not pass the self-containment test.`);
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

  // Verification strength: either the layered model (**Layers:** / **Unit:** /
  // **Fixture:** / **Seam:** / **Deployment:**) OR the legacy flat
  // "**Verification type**" label satisfies this. The SKILL and the
  // verification-criteria pattern now prescribe the layered model, so its
  // presence must count — warn only when NEITHER is present.
  const hasLayers = /\*\*(?:Layers|Unit|Fixture|Seam|Deployment)/i.test(content);
  const hasVerificationType = /\*\*Verification type/i.test(content);
  if (!hasVerificationType && !hasLayers && vHeaders.length > 0) {
    warn('verification.md', 'No verification strength indicated. Each V-criterion should specify either layered coverage (**Layers:** — Unit / Fixture / Seam / Deployment, the model the spec pipeline prescribes) or at minimum a **Verification type**. Without it, you can\'t tell whether seams are actually covered.');
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

  // Flat-vs-layered: a spec that uses ONLY the legacy "Verification type" label
  // without any layered coverage is underspecified — nudge it toward the layers.
  if (!hasLayers && hasVerificationType && vHeaders.length > 0) {
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

  // Classify each header line into at most one constraint category by its CORE
  // keyword. Category headers appear in many forms — "## Musts (M)",
  // "### 1. Musts — Non-Negotiable Requirements", "## Must-Nots (MN)" — so the
  // descriptive suffix ("Non-Negotiable", "Prohibitions") must NOT be required.
  // Must-Nots is checked first so a "Must-Nots" header isn't miscounted as Musts.
  const headerLines = content.split('\n').filter(l => /^#{1,6}\s/.test(l));
  const presentSet = new Set();
  for (const h of headerLines) {
    if (/must[-\s]?nots?/i.test(h)) presentSet.add('Must-Nots');
    else if (/\bmusts?\b/i.test(h)) presentSet.add('Musts');
    if (/\bpreferences?\b/i.test(h)) presentSet.add('Preferences');
    if (/\bescalation\b/i.test(h)) presentSet.add('Escalation Triggers');
  }

  const ALL_CATEGORIES = ['Musts', 'Must-Nots', 'Preferences', 'Escalation Triggers'];
  const present = ALL_CATEGORIES.filter(c => presentSet.has(c));
  const missing = ALL_CATEGORIES.filter(c => !presentSet.has(c));

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

  // Check for numbered constraints (M1, MN1, P1, E1). Accept the ID in any of
  // the forms authors actually use: a heading (`### M1`), a bullet
  // (`- **M1 — …**`, the form the pattern's examples and templates use), or
  // inline bold (`**M1**`). MN is matched before M so "MN1" isn't read as "M".
  const numbered = content.match(/(?:^\s{0,3}(?:#{2,6}\s+|[-*]\s+)\**|\*\*)(?:MN|M|P|E)\d+\b/gm) || [];
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

  // Check for work units (WP-1, WP-2...). The decomposition pattern doesn't
  // mandate `### WP-N` headers — units are commonly listed in a table
  // (`| WP-01 | … |`) or as bullets. Accept WP-NN at the start of a heading,
  // a table row, or a bullet.
  const wpHeaders = content.match(/^\s{0,3}(?:#{2,6}\s+|[-*]\s+|\|\s*)\**WP-?\d+\b/gmi) || [];
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

// ---------------------------------------------------------------------------
// Target enforcement — declared projects must be valid, resolvable, and match
// the orchestrator's per-WP Project declarations.
// ---------------------------------------------------------------------------

/**
 * Parse the markdown table under "## Package Inventory" in the orchestrator.
 * Returns an array of { package, project } rows, or null when no table with a
 * "Project" column exists under the heading.
 */
function parseInventoryRows(orch) {
  const lines = orch.split('\n');
  const headIdx = lines.findIndex(l => /^##\s+Package Inventory\b/.test(l));
  if (headIdx === -1) return null;

  const tableLines = [];
  for (let i = headIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (/^\s*\|/.test(line.trimEnd())) tableLines.push(line);
    else if (tableLines.length > 0 && line.trim() !== '') break;
  }
  if (tableLines.length < 2) return null;

  const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const header = splitRow(tableLines[0]);
  const projectCol = header.indexOf('Project'); // case-sensitive: matches the template header
  if (projectCol === -1) return null;

  const rows = [];
  for (const l of tableLines.slice(1)) {
    const cells = splitRow(l);
    if (cells.every(c => c === '' || /^:?-+:?$/.test(c))) continue; // separator row
    rows.push({ package: cells[0] ?? '', project: cells[projectCol] ?? '' });
  }
  return rows.length > 0 ? rows : null;
}

function validateTargets(meta) {
  if (!meta) return;
  const projects = Array.isArray(meta.projects) ? meta.projects : [];

  // Project-name validation — before any disk resolution, so junk names never
  // reach a filesystem path join. Names must be bare repo directory names.
  const validProjects = [];
  for (const name of projects) {
    const bad =
      typeof name !== 'string' ||
      name.length === 0 ||
      name !== name.trim() ||
      /[/\\]/.test(name) ||
      name.includes('..') ||
      isAbsolute(name) ||
      /^[A-Za-z]:/.test(name);
    if (bad) {
      error('meta.json', `Invalid project name ${JSON.stringify(name)} — project names must be bare repo directory names: no path separators, "..", absolute paths, drive letters, or leading/trailing whitespace. They are joined to <workspace-root>/projects/<name> for disk resolution; a junk name would escape the workspace.`);
    } else {
      validProjects.push(name);
    }
  }

  // Disk resolution — ONLY when a workspace root resolved. No root → skip
  // silently (not even a warning), so root-less invocations stay clean.
  if (workspaceRoot) {
    for (const name of validProjects) {
      const projectPath = join(workspaceRoot, 'projects', name);
      if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
        error('meta.json', `Project "${name}" does not resolve to a directory at ${projectPath}. The declared target must exist under the workspace root — a typo here would root worktrees in the wrong place, or nowhere.`);
      }
    }
  }

  // Inventory ↔ meta cross-check (deep specs) / multi-project nudge (lite specs).
  const wpDir = join(workshopPath, 'work-packages');
  if (!existsSync(wpDir)) {
    if (projects.length > 1) {
      warn('meta.json', `Lite spec (no work-packages/) declares ${projects.length} projects — multi-repo usually wants a deep spec: per-WP single-repo targets come from the orchestrator inventory, which lite specs don't have.`);
    }
    return;
  }

  const orchPath = join(wpDir, '_orchestrator.md');
  if (!existsSync(orchPath)) return; // missing orchestrator is reported elsewhere; nothing to cross-check

  const rows = parseInventoryRows(readFileSync(orchPath, 'utf-8'));
  if (rows === null) {
    error('_orchestrator.md', 'Missing inventory table — work-packages/ exists but no table with a "Project" column was found under "## Package Inventory". The inventory is how each WP declares its single target repo; without it, per-WP targets cannot be cross-checked against meta.projects.');
    return;
  }

  for (const row of rows) {
    if (row.project === '' || row.project === '-') continue; // no target declared for this row
    if (!projects.includes(row.project)) {
      error('_orchestrator.md', `Package "${row.package}" targets project "${row.project}" which is not declared in meta.projects (${JSON.stringify(projects)}). Every inventory target must be declared up front so multi-repo dispatch knows the full repo set before any worktree is created.`);
    }
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
      // Accept all natural field forms: `**Field:**` (colon inside the bold —
      // the most natural markdown), `**Field**` (colon outside or none), and
      // `## Field` (heading). The colon-inside form is what a faithful author
      // writes; rejecting it would make otherwise-valid WPs look undispatchable.
      const regex = new RegExp(`\\*\\*${field}:?\\*\\*|^##\\s+${field}`, 'mi');
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
validateTargets(meta);
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
