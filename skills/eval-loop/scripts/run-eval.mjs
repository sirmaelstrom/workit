#!/usr/bin/env node
/**
 * Eval Loop Runner — executes a skill's eval suite and scores assertions.
 *
 * Usage:
 *   node run-eval.mjs --skill diagnose --mode baseline [--model sonnet] [--project-root /path]
 *   node run-eval.mjs --skill diagnose --mode loop [--iterations 10] [--model sonnet]
 *
 * Modes:
 *   baseline — run all test cases once, score, report. No mutations.
 *   loop     — full Karpathy loop: baseline → mutate → evaluate → keep/revert → repeat.
 *
 * Requires: claude CLI on PATH, Node 24 (native SQLite)
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Arg parsing ---
const { values: args } = parseArgs({
  options: {
    skill: { type: 'string' },
    mode: { type: 'string', default: 'baseline' },
    model: { type: 'string', default: 'sonnet' },
    iterations: { type: 'string', default: '10' },
    'project-root': { type: 'string', default: resolve(__dirname, '../../..') },
    'skill-file': { type: 'string' },   // override: path to skill definition
    'suite-file': { type: 'string' },   // override: path to suite.yaml
    timeout: { type: 'string', default: '10' }, // minutes per test case execution
  },
});

const skillId = args.skill;
const mode = args.mode;
const model = args.model;
const maxIterations = parseInt(args.iterations);
const projectRoot = args['project-root'];
const timeoutMin = parseInt(args.timeout);

if (!skillId) {
  console.error('Usage: node run-eval.mjs --skill <skill-id> --mode <baseline|loop>');
  process.exit(1);
}

// --- Locate files ---
const skillDir = join(projectRoot, 'skills', skillId);
const skillFile = args['skill-file'] ? resolve(args['skill-file']) : join(skillDir, 'SKILL.md');
const suiteFile = args['suite-file'] ? resolve(args['suite-file']) : join(skillDir, 'evals', 'suite.yaml');
const dbFile = join(projectRoot, 'skills.db');
// Use the suite's parent dir for output files when using custom paths
const evalsOutputDir = dirname(suiteFile);

for (const [name, path] of [['SKILL.md', skillFile], ['suite.yaml', suiteFile], ['skills.db', dbFile]]) {
  if (!existsSync(path)) {
    console.error(`Missing ${name}: ${path}`);
    process.exit(1);
  }
}

// --- Resolve DB skill ID ---
// The --skill arg may be a short name (e.g. "commit-push-pr") but the skills table
// uses namespaced IDs (e.g. "cmd:git:commit-push-pr"). Look up by name first,
// fall back to using the raw arg as the ID if no match found.
let dbSkillId = skillId;
{
  const db = new DatabaseSync(dbFile);
  try {
    const row = db.prepare('SELECT id FROM skills WHERE name = ?').get(skillId);
    if (row) {
      dbSkillId = row.id;
      if (dbSkillId !== skillId) {
        console.log(`Resolved skill "${skillId}" -> DB id "${dbSkillId}"`);
      }
    }
  } catch {
    // skills table may not exist yet — that's fine, DB writes will just use the raw arg
  }
  db.close();
}

// --- Simple YAML parser (enough for our suite format) ---
function parseYamlSuite(content) {
  // This is deliberately simple — handles our specific suite.yaml format.
  // For anything more complex, use a real parser.
  const suite = {
    skill: '',
    model: 'sonnet',
    iterations: 10,
    timeout_per_iteration_minutes: 10,
    test_cases: [],
  };

  // Extract top-level scalar fields
  const scalarMatch = (key) => {
    const m = content.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm'));
    return m ? m[1].trim() : null;
  };
  suite.skill = scalarMatch('skill') || skillId;
  suite.model = scalarMatch('model') || 'sonnet';
  suite.iterations = parseInt(scalarMatch('iterations') || '10');
  suite.timeout_per_iteration_minutes = parseInt(scalarMatch('timeout_per_iteration_minutes') || '10');

  // Extract test cases by splitting on '  - id:'
  const caseBlocks = content.split(/\n  - id:\s*/).slice(1);
  for (const block of caseBlocks) {
    const tc = { id: '', description: '', input: '', context: {}, assertions: {} };
    const lines = block.split('\n');

    tc.id = lines[0].trim();

    // Extract tier (defaults to 'smoke' if not specified — backward compatible)
    const tierMatch = block.match(/tier:\s*(\S+)/);
    tc.tier = tierMatch ? tierMatch[1] : 'smoke';

    // Extract description
    const descMatch = block.match(/description:\s*"([^"]+)"/);
    if (descMatch) tc.description = descMatch[1];

    // Extract input (multiline block after 'input: |')
    // Indentation varies — use flexible lookahead for context: or assertions:
    const inputMatch = block.match(/input:\s*\|\n([\s\S]*?)(?=\n\s{4}context:|\n\s{4}assertions:)/);
    if (inputMatch) tc.input = inputMatch[1].replace(/^\s{6}/gm, '').trim();

    // Extract context
    const projMatch = block.match(/project:\s*(\S+)/);
    if (projMatch) tc.context = { ...tc.context, project: projMatch[1] };
    const constraintMatch = block.match(/constraints:\s*\[([^\]]*)\]/);
    if (constraintMatch && constraintMatch[1].trim()) {
      tc.context.constraints = constraintMatch[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    }

    // Extract assertions by category — match category header then collect all "- " lines until next category or end
    const assertionsBlock = block.slice(block.indexOf('assertions:'));
    for (const category of ['format', 'quality', 'instruction_adherence', 'composability']) {
      const catIdx = assertionsBlock.indexOf(`${category}:`);
      if (catIdx === -1) continue;
      const afterCat = assertionsBlock.slice(catIdx + category.length + 1);
      // Collect lines until we hit another category header or end of block
      const assertions = [];
      for (const line of afterCat.split('\n')) {
        // Stop at next category header (word followed by colon at assertion-category indent)
        if (line.match(/^\s{6}\w+:/) && !line.includes('- "')) break;
        const assertMatch = line.match(/- "(.+)"/);
        if (assertMatch) assertions.push(assertMatch[1]);
      }
      if (assertions.length > 0) tc.assertions[category] = assertions;
    }

    suite.test_cases.push(tc);
  }

  return suite;
}

// --- Run a single test case ---
function runTestCase(tc, skillContent, evalModel) {
  console.log(`\n  Running ${tc.id}: ${tc.description}`);

  // Build the prompt that simulates invoking the skill
  const prompt = `You are a Claude Code agent with the following skill loaded:

<skill>
${skillContent}
</skill>

The user has invoked the skill with this input:

${tc.input}

${tc.context.project ? `Project context: ${tc.context.project}` : ''}
${tc.context.constraints?.length ? `Constraints: ${tc.context.constraints.join(', ')}` : ''}

Execute the skill fully. Produce the complete output as specified in the skill's output schema.
Do NOT ask clarifying questions — use your best judgment and the context provided.
Simulate any commands you would run and produce realistic output.`;

  // Write prompt to temp file
  const tmpPrompt = join(evalsOutputDir, `.tmp-prompt-${tc.id}.txt`);
  writeFileSync(tmpPrompt, prompt);

  // Run claude CLI
  const startTime = Date.now();
  let output = '';
  try {
    const result = spawnSync('claude', ['-p', prompt, '--model', evalModel, '--output-format', 'text'], {
      timeout: timeoutMin * 60 * 1000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 5,
      windowsHide: true,
    });
    output = result.stdout || '';
    if (result.stderr && result.status !== 0) {
      console.log(`    WARNING: claude returned status ${result.status}`);
      console.log(`    stderr: ${result.stderr.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`    ERROR: ${e.message}`);
    output = '';
  }
  let durationSec = Math.round((Date.now() - startTime) / 1000);

  // Retry once if output is suspiciously short (truncated/broken response).
  // One retry is cheaper than a poisoned baseline dragging all scores down.
  const MIN_OUTPUT_CHARS = 1000;
  if (output.length < MIN_OUTPUT_CHARS && output.length > 0) {
    console.log(`    Output too short (${output.length} chars) — retrying once...`);
    try {
      const retryStart = Date.now();
      const result = spawnSync('claude', ['-p', prompt, '--model', evalModel, '--output-format', 'text'], {
        timeout: timeoutMin * 60 * 1000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 5,
        windowsHide: true,
      });
      const retryOutput = result.stdout || '';
      if (retryOutput.length > output.length) {
        output = retryOutput;
        console.log(`    Retry produced ${output.length} chars`);
      } else {
        console.log(`    Retry also short (${retryOutput.length} chars) — keeping original`);
      }
      durationSec += Math.round((Date.now() - retryStart) / 1000);
    } catch (e) {
      console.log(`    Retry failed: ${e.message}`);
    }
  }

  console.log(`    Output: ${output.length} chars in ${durationSec}s`);

  // Save output for debugging
  const outputFile = join(evalsOutputDir, `.output-${tc.id}.md`);
  writeFileSync(outputFile, output);

  return { output, durationSec };
}

// --- Score assertions ---
function scoreAssertions(tc, output, evalModel) {
  const results = {};
  let totalPass = 0;
  let totalFail = 0;

  for (const [category, assertions] of Object.entries(tc.assertions)) {
    results[category] = [];
    for (const assertion of assertions) {
      const isDeterministic = assertion.startsWith('[deterministic]');
      const cleanAssertion = assertion.replace('[deterministic] ', '');

      let pass = false;

      if (isDeterministic) {
        // Simple string/regex check
        const phrase = cleanAssertion.match(/contains '([^']+)'/)?.[1]
          || cleanAssertion.match(/contains (.+)/)?.[1]
          || cleanAssertion;
        pass = output.toLowerCase().includes(phrase.toLowerCase().replace(/'/g, ''));
      } else {
        // LLM-as-judge: single judge call. The min-sample threshold on the
        // degradation guard handles noise from small categories, so double-judge
        // isn't worth the 50% cost increase.
        const judgePrompt = `You are evaluating whether an AI skill's output meets a specific assertion.

<output>
${output.slice(0, 8000)}
</output>

<assertion>
${cleanAssertion}
</assertion>

Does the output satisfy this assertion? Answer ONLY "YES" or "NO" followed by a one-sentence justification.`;

        try {
          const result = spawnSync('claude', ['-p', judgePrompt, '--model', 'sonnet', '--output-format', 'text'], {
            timeout: 60000,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          });
          const judgeOutput = (result.stdout || '').trim();
          pass = judgeOutput.toUpperCase().startsWith('YES');
        } catch (e) {
          console.log(`    JUDGE ERROR for "${cleanAssertion.slice(0, 50)}...": ${e.message}`);
        }
      }

      results[category].push({ assertion: cleanAssertion, pass, deterministic: isDeterministic });
      if (pass) totalPass++;
      else totalFail++;

      const icon = pass ? '\u2713' : '\u2717';
      const tag = isDeterministic ? '[det]' : '[llm]';
      console.log(`    ${icon} ${tag} ${cleanAssertion.slice(0, 70)}${cleanAssertion.length > 70 ? '...' : ''}`);
    }
  }

  return { results, totalPass, totalFail };
}

// --- Run full suite and return structured scores ---
function runFullSuite(suite, skillContent, evalModel) {
  const startTime = Date.now();
  const allResults = {};
  const categoryTotals = {};
  let grandPass = 0;
  let grandFail = 0;

  for (const tc of suite.test_cases) {
    const { output } = runTestCase(tc, skillContent, evalModel);
    const { results, totalPass, totalFail } = scoreAssertions(tc, output, evalModel);
    allResults[tc.id] = results;
    grandPass += totalPass;
    grandFail += totalFail;

    for (const [cat, catResults] of Object.entries(results)) {
      if (!categoryTotals[cat]) categoryTotals[cat] = { pass: 0, total: 0 };
      for (const r of catResults) {
        categoryTotals[cat].total++;
        if (r.pass) categoryTotals[cat].pass++;
      }
    }
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const total = grandPass + grandFail;
  const overallRate = total > 0 ? (grandPass / total) * 100 : 0;

  // Compute per-category rates
  const categoryRates = {};
  for (const [cat, totals] of Object.entries(categoryTotals)) {
    categoryRates[cat] = totals.total > 0 ? (totals.pass / totals.total) * 100 : 0;
  }

  return {
    allResults,
    categoryTotals,
    categoryRates,
    grandPass,
    grandFail,
    overallRate,
    totalDuration,
  };
}

// --- Run smoke tier only (fast mutation signal) ---
// Returns the same shape as runFullSuite but only runs smoke-tier test cases.
// Typically 3 cases vs 8 — ~60% fewer skill invocations per iteration.
function runSmokeSuite(suite, skillContent, evalModel) {
  const startTime = Date.now();
  const smokeCases = suite.test_cases.filter(tc => tc.tier === 'smoke');
  console.log(`  Smoke eval: ${smokeCases.length}/${suite.test_cases.length} test cases`);

  const allResults = {};
  const categoryTotals = {};
  let grandPass = 0;
  let grandFail = 0;

  for (const tc of smokeCases) {
    const { output } = runTestCase(tc, skillContent, evalModel);
    const { results, totalPass, totalFail } = scoreAssertions(tc, output, evalModel);
    allResults[tc.id] = results;
    grandPass += totalPass;
    grandFail += totalFail;

    for (const [cat, catResults] of Object.entries(results)) {
      if (!categoryTotals[cat]) categoryTotals[cat] = { pass: 0, total: 0 };
      for (const r of catResults) {
        categoryTotals[cat].total++;
        if (r.pass) categoryTotals[cat].pass++;
      }
    }
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const total = grandPass + grandFail;
  const overallRate = total > 0 ? (grandPass / total) * 100 : 0;

  const categoryRates = {};
  for (const [cat, totals] of Object.entries(categoryTotals)) {
    categoryRates[cat] = totals.total > 0 ? (totals.pass / totals.total) * 100 : 0;
  }

  return {
    allResults,
    categoryTotals,
    categoryRates,
    grandPass,
    grandFail,
    overallRate,
    totalDuration,
    smokeOnly: true,
    casesRun: smokeCases.length,
  };
}

// --- Find weakest category ---
function findWeakestCategory(categoryRates) {
  let weakest = null;
  let lowestRate = 101;
  for (const [cat, rate] of Object.entries(categoryRates)) {
    if (rate < lowestRate) {
      lowestRate = rate;
      weakest = cat;
    }
  }
  return { category: weakest, rate: lowestRate };
}

// --- Build failing assertions summary for mutation prompt ---
function buildFailingSummary(allResults) {
  const failing = [];
  for (const [tcId, catResults] of Object.entries(allResults)) {
    for (const [cat, results] of Object.entries(catResults)) {
      for (const r of results) {
        if (!r.pass) {
          failing.push(`  [${cat}] ${tcId}: ${r.assertion}`);
        }
      }
    }
  }
  return failing.join('\n');
}

// --- Propose a mutation via Claude ---
function proposeMutation(skillContent, weakestCategory, failingSummary, mutationHistory) {
  const historyBlock = mutationHistory.length > 0
    ? `\n\nPrevious mutations (do NOT repeat these):\n${mutationHistory.map((m, i) =>
        `  ${i + 1}. [${m.kept ? 'KEPT' : 'REVERTED'}] ${m.hypothesis}`
      ).join('\n')}`
    : '';

  const prompt = `You are improving a Claude Code skill definition. Your goal: propose ONE specific mutation to the SKILL.md that will improve the "${weakestCategory}" assertion category.

<current_skill>
${skillContent}
</current_skill>

<failing_assertions>
${failingSummary}
</failing_assertions>
${historyBlock}

Rules:
1. Propose exactly ONE change. Not two. Not "a small set." One.
2. The change must target the weakest category: "${weakestCategory}"
3. Prefer additive changes (add example, add constraint, add explicit instruction) over removing content
4. Do NOT change the frontmatter (name/description) — that affects routing, not output quality
5. State your hypothesis clearly
6. Show the exact diff — use a fenced code block with the COMPLETE new version of only the changed section

Respond in this exact format:

HYPOTHESIS: <one sentence explaining what you're changing and why it should help>

SECTION: <which section of the SKILL.md you're modifying, e.g. "## 3. Evidence Collection">

BEFORE:
\`\`\`
<the exact current text being replaced>
\`\`\`

AFTER:
\`\`\`
<the exact new text to replace it with>
\`\`\``;

  try {
    const result = spawnSync('claude', ['-p', prompt, '--model', model, '--output-format', 'text'], {
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 2,
      windowsHide: true,
    });
    return (result.stdout || '').trim();
  } catch (e) {
    console.log(`  MUTATION ERROR: ${e.message}`);
    return null;
  }
}

// --- Apply a mutation to the skill file ---
function applyMutation(skillContent, mutationResponse) {
  // Parse the BEFORE/AFTER blocks from the response
  const hypothesisMatch = mutationResponse.match(/HYPOTHESIS:\s*(.+)/);
  const hypothesis = hypothesisMatch ? hypothesisMatch[1].trim() : 'Unknown hypothesis';

  // Extract BEFORE block
  const beforeMatch = mutationResponse.match(/BEFORE:\s*\n```[^\n]*\n([\s\S]*?)\n```/);
  // Extract AFTER block — find the AFTER: marker then grab the next fenced block
  const afterIdx = mutationResponse.indexOf('AFTER:');
  let afterContent = null;
  if (afterIdx !== -1) {
    const afterSlice = mutationResponse.slice(afterIdx);
    const afterMatch = afterSlice.match(/AFTER:\s*\n```[^\n]*\n([\s\S]*?)\n```/);
    if (afterMatch) afterContent = afterMatch[1];
  }

  if (!beforeMatch || afterContent === null) {
    console.log('  Could not parse BEFORE/AFTER blocks from mutation response');
    console.log('  Response preview:', mutationResponse.slice(0, 300));
    return { success: false, hypothesis, mutatedContent: skillContent };
  }

  const before = beforeMatch[1];
  const after = afterContent;

  // Verify the BEFORE text exists in the skill
  if (!skillContent.includes(before)) {
    // Try trimmed match (whitespace differences)
    const trimmedBefore = before.trim();
    const lines = skillContent.split('\n');
    let found = false;
    let startIdx = -1;
    let endIdx = -1;

    // Try to find a fuzzy match — look for the first and last non-empty lines
    const beforeLines = trimmedBefore.split('\n').filter(l => l.trim());
    if (beforeLines.length > 0) {
      const firstLine = beforeLines[0].trim();
      const lastLine = beforeLines[beforeLines.length - 1].trim();

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === firstLine) {
          startIdx = i;
          // Now find the last line
          for (let j = i; j < lines.length; j++) {
            if (lines[j].trim() === lastLine) {
              endIdx = j;
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
    }

    if (found && startIdx >= 0 && endIdx >= startIdx) {
      // Replace the range
      const newLines = [...lines.slice(0, startIdx), after, ...lines.slice(endIdx + 1)];
      return { success: true, hypothesis, mutatedContent: newLines.join('\n') };
    }

    console.log('  BEFORE text not found in skill (even with fuzzy match)');
    console.log('  Looking for:', before.slice(0, 100));
    return { success: false, hypothesis, mutatedContent: skillContent };
  }

  const mutatedContent = skillContent.replace(before, after);
  return { success: true, hypothesis, mutatedContent };
}

// --- Check degradation guard ---
// minSamples: categories with fewer than this many assertions are exempt from the
// degradation veto. With 1-2 assertions, a single LLM judge flip causes a 50-100%
// swing that isn't meaningful signal. Default 3.
function checkDegradation(baselineRates, currentRates, categoryTotals, threshold = 5.0, minSamples = 3) {
  const degraded = [];
  for (const [cat, baseRate] of Object.entries(baselineRates)) {
    const sampleSize = categoryTotals[cat]?.total ?? 0;
    if (sampleSize < minSamples) {
      // Too few assertions to reliably detect regression — skip
      continue;
    }
    const currentRate = currentRates[cat] ?? 0;
    const drop = baseRate - currentRate;
    if (drop > threshold) {
      degraded.push({ category: cat, baseline: baseRate, current: currentRate, drop });
    }
  }
  return degraded;
}

// --- Print score summary ---
function printScores(label, categoryRates, overallRate) {
  console.log(`\n  ${label}:`);
  for (const [cat, rate] of Object.entries(categoryRates)) {
    console.log(`    ${cat}: ${rate.toFixed(1)}%`);
  }
  console.log(`    overall: ${overallRate.toFixed(1)}%`);
}

// --- Main ---
async function main() {
  console.log(`\nEval Loop Runner`);
  console.log(`Skill: ${skillId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Model: ${model}`);
  console.log(`Project: ${projectRoot}`);
  console.log('\u2500'.repeat(60));

  const suiteContent = readFileSync(suiteFile, 'utf-8').replace(/\r\n/g, '\n');
  const suite = parseYamlSuite(suiteContent);

  console.log(`\nSuite: ${suite.test_cases.length} test cases`);
  let totalAssertions = 0;
  for (const tc of suite.test_cases) {
    for (const asserts of Object.values(tc.assertions)) {
      totalAssertions += asserts.length;
    }
  }
  console.log(`Total assertions: ${totalAssertions}`);

  if (mode === 'baseline') {
    // --- BASELINE MODE ---
    const skillContent = readFileSync(skillFile, 'utf-8');
    const scores = runFullSuite(suite, skillContent, model);

    // Report
    console.log('\n' + '\u2550'.repeat(60));
    console.log(`BASELINE REPORT \u2014 ${skillId}`);
    console.log('\u2550'.repeat(60));
    console.log(`\nOverall: ${scores.grandPass}/${scores.grandPass + scores.grandFail} (${scores.overallRate.toFixed(1)}%)`);
    console.log(`Duration: ${scores.totalDuration}s\n`);

    console.log('By category:');
    for (const [cat, totals] of Object.entries(scores.categoryTotals)) {
      const rate = totals.total > 0 ? ((totals.pass / totals.total) * 100).toFixed(1) : '0.0';
      console.log(`  ${cat}: ${totals.pass}/${totals.total} (${rate}%)`);
    }

    // Write to database
    const db = new DatabaseSync(dbFile);
    db.prepare(`
      INSERT INTO eval_runs (skill_id, run_at, metric_name, metric_before, metric_after,
        delta, iterations, duration_seconds, model, notes)
      VALUES (?, ?, 'baseline', NULL, ?, NULL, 0, ?, ?, ?)
    `).run(
      dbSkillId,
      new Date().toISOString(),
      parseFloat(scores.overallRate.toFixed(1)),
      scores.totalDuration,
      model,
      JSON.stringify({
        categories: Object.fromEntries(
          Object.entries(scores.categoryTotals).map(([k, v]) => [k, `${v.pass}/${v.total}`])
        ),
        test_cases: suite.test_cases.length,
        total_assertions: scores.grandPass + scores.grandFail,
      })
    );
    db.close();
    console.log(`\nBaseline written to skills.db eval_runs table (skill_id: ${dbSkillId}).`);

    // Write markdown report
    const reportPath = join(evalsOutputDir, `baseline-${new Date().toISOString().slice(0, 10)}.md`);
    let report = `# Baseline \u2014 ${skillId} \u2014 ${new Date().toISOString().slice(0, 10)}\n\n`;
    report += `**Overall:** ${scores.grandPass}/${scores.grandPass + scores.grandFail} (${scores.overallRate.toFixed(1)}%)\n`;
    report += `**Duration:** ${scores.totalDuration}s | **Model:** ${model}\n\n`;
    report += `## By Category\n\n`;
    report += `| Category | Pass | Total | Rate |\n|----------|------|-------|------|\n`;
    for (const [cat, totals] of Object.entries(scores.categoryTotals)) {
      report += `| ${cat} | ${totals.pass} | ${totals.total} | ${(totals.total > 0 ? (totals.pass / totals.total) * 100 : 0).toFixed(1)}% |\n`;
    }
    report += `\n## By Test Case\n\n`;
    for (const tc of suite.test_cases) {
      const tcResults = scores.allResults[tc.id];
      report += `### ${tc.id}: ${tc.description}\n\n`;
      for (const [cat, results] of Object.entries(tcResults)) {
        for (const r of results) {
          report += `- ${r.pass ? '\u2713' : '\u2717'} [${cat}] ${r.assertion}\n`;
        }
      }
      report += '\n';
    }
    writeFileSync(reportPath, report);
    console.log(`Report: ${reportPath}`);

  } else if (mode === 'loop') {
    // --- LOOP MODE ---
    const loopStart = Date.now();

    // Step 1: Run baseline
    console.log('\n\u2550'.repeat(60));
    console.log('PHASE 1: BASELINE');
    console.log('\u2550'.repeat(60));

    let currentSkillContent = readFileSync(skillFile, 'utf-8');
    const originalSkillContent = currentSkillContent;
    const baselineScores = runFullSuite(suite, currentSkillContent, model);
    printScores('Baseline scores', baselineScores.categoryRates, baselineScores.overallRate);

    // Save original as backup
    const originalBackup = join(evalsOutputDir, '.backup-original.md');
    writeFileSync(originalBackup, originalSkillContent);

    // Compute smoke-only baseline from the full baseline results (no extra invocations)
    const smokeCaseIds = new Set(suite.test_cases.filter(tc => tc.tier === 'smoke').map(tc => tc.id));
    function computeSmokeRates(allResults) {
      let pass = 0, total = 0;
      for (const [tcId, catResults] of Object.entries(allResults)) {
        if (!smokeCaseIds.has(tcId)) continue;
        for (const results of Object.values(catResults)) {
          for (const r of results) { total++; if (r.pass) pass++; }
        }
      }
      return total > 0 ? (pass / total) * 100 : 0;
    }
    let currentSmokeRate = computeSmokeRates(baselineScores.allResults);
    console.log(`  Smoke baseline (from full run): ${currentSmokeRate.toFixed(1)}% (${smokeCaseIds.size} cases)`);

    // Track state
    let currentRates = { ...baselineScores.categoryRates };
    let currentOverall = baselineScores.overallRate;
    let currentResults = baselineScores.allResults;
    const mutationHistory = []; // { iteration, hypothesis, kept, deltaOverall, categoryDeltas }
    let consecutiveReverts = 0;
    let exitReason = 'budget_exhausted';

    // Step 2: The Loop
    console.log('\n' + '\u2550'.repeat(60));
    console.log(`PHASE 2: LOOP (max ${maxIterations} iterations)`);
    console.log('\u2550'.repeat(60));

    for (let i = 1; i <= maxIterations; i++) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`ITERATION ${i}/${maxIterations}`);
      console.log('─'.repeat(50));

      // 2a: Identify weakest category
      const { category: weakestCat, rate: weakestRate } = findWeakestCategory(currentRates);
      console.log(`  Weakest category: ${weakestCat} (${weakestRate.toFixed(1)}%)`);

      // 2b: Build failing summary
      const failingSummary = buildFailingSummary(currentResults);
      console.log(`  Failing assertions:\n${failingSummary.split('\n').slice(0, 5).join('\n')}${failingSummary.split('\n').length > 5 ? '\n  ...' : ''}`);

      // 2c: Propose mutation
      console.log(`\n  Proposing mutation (targeting ${weakestCat})...`);
      const mutationResponse = proposeMutation(currentSkillContent, weakestCat, failingSummary, mutationHistory);
      if (!mutationResponse) {
        console.log('  Mutation proposal failed — counting as revert');
        consecutiveReverts++;
        mutationHistory.push({ iteration: i, hypothesis: 'PROPOSAL FAILED', kept: false, deltaOverall: 0, categoryDeltas: {} });
        if (consecutiveReverts >= 3) {
          exitReason = 'converged';
          console.log(`\n  CONVERGED: 3 consecutive reverts — stopping loop`);
          break;
        }
        continue;
      }

      // 2d: Apply mutation
      const backupFile = join(evalsOutputDir, `.backup-iter-${i}.md`);
      writeFileSync(backupFile, currentSkillContent);

      const { success, hypothesis, mutatedContent } = applyMutation(currentSkillContent, mutationResponse);
      console.log(`  Hypothesis: ${hypothesis}`);

      if (!success) {
        console.log('  Mutation application failed — counting as revert');
        consecutiveReverts++;
        mutationHistory.push({ iteration: i, hypothesis, kept: false, deltaOverall: 0, categoryDeltas: {} });
        if (consecutiveReverts >= 3) {
          exitReason = 'converged';
          console.log(`\n  CONVERGED: 3 consecutive reverts — stopping loop`);
          break;
        }
        continue;
      }

      // Write mutated skill to disk for eval
      writeFileSync(skillFile, mutatedContent);
      console.log(`  Mutation applied — running smoke eval...`);

      // 2e: Smoke eval — run only smoke-tier test cases for fast signal
      const smokeScores = runSmokeSuite(suite, mutatedContent, model);
      printScores(`Smoke scores (${smokeScores.casesRun} cases)`, smokeScores.categoryRates, smokeScores.overallRate);

      // Quick check: did smoke overall improve vs cached smoke rate?
      const smokeImproved = smokeScores.overallRate > currentSmokeRate;

      if (!smokeImproved) {
        // Smoke didn't improve — no need for full verification
        console.log(`\n  <<< REVERT (smoke): overall ${currentSmokeRate.toFixed(1)}% -> ${smokeScores.overallRate.toFixed(1)}% (no improvement)`);
        writeFileSync(skillFile, currentSkillContent);
        consecutiveReverts++;
        mutationHistory.push({ iteration: i, hypothesis, kept: false, deltaOverall: smokeScores.overallRate - currentSmokeRate, categoryDeltas: {} });

        if (consecutiveReverts >= 3) {
          exitReason = 'converged';
          console.log(`\n  CONVERGED: 3 consecutive reverts — stopping loop`);
          break;
        }
        continue;
      }

      // Smoke improved — run full verification suite to check for regressions
      console.log(`\n  Smoke improved (${currentSmokeRate.toFixed(1)}% -> ${smokeScores.overallRate.toFixed(1)}%) — running full verification...`);
      const newScores = runFullSuite(suite, mutatedContent, model);
      printScores('Full verification scores', newScores.categoryRates, newScores.overallRate);

      // 2f: Compare — keep or revert
      const overallDelta = newScores.overallRate - currentOverall;
      const degraded = checkDegradation(currentRates, newScores.categoryRates, newScores.categoryTotals);
      const improved = newScores.overallRate > currentOverall;

      const categoryDeltas = {};
      for (const cat of Object.keys(currentRates)) {
        categoryDeltas[cat] = (newScores.categoryRates[cat] ?? 0) - (currentRates[cat] ?? 0);
      }

      if (improved && degraded.length === 0) {
        // KEEP
        console.log(`\n  >>> KEEP: overall ${currentOverall.toFixed(1)}% -> ${newScores.overallRate.toFixed(1)}% (+${overallDelta.toFixed(1)}%)`);
        currentSkillContent = mutatedContent;
        currentRates = { ...newScores.categoryRates };
        currentOverall = newScores.overallRate;
        currentResults = newScores.allResults;
        currentSmokeRate = computeSmokeRates(newScores.allResults);
        consecutiveReverts = 0;
        mutationHistory.push({ iteration: i, hypothesis, kept: true, deltaOverall: overallDelta, categoryDeltas });
      } else {
        // REVERT
        const reason = degraded.length > 0
          ? `category degradation: ${degraded.map(d => `${d.category} -${d.drop.toFixed(1)}%`).join(', ')}`
          : `overall declined ${overallDelta.toFixed(1)}%`;
        console.log(`\n  <<< REVERT (verification): ${reason}`);
        writeFileSync(skillFile, currentSkillContent); // restore
        consecutiveReverts++;
        mutationHistory.push({ iteration: i, hypothesis, kept: false, deltaOverall: overallDelta, categoryDeltas });

        if (consecutiveReverts >= 3) {
          exitReason = 'converged';
          console.log(`\n  CONVERGED: 3 consecutive reverts — stopping loop`);
          break;
        }
      }
    }

    // Step 3: Finalize
    console.log('\n' + '\u2550'.repeat(60));
    console.log('PHASE 3: RESULTS');
    console.log('\u2550'.repeat(60));

    const loopDuration = Math.round((Date.now() - loopStart) / 1000);
    const iterationsRun = mutationHistory.length;
    const keptCount = mutationHistory.filter(m => m.kept).length;
    const revertedCount = mutationHistory.filter(m => !m.kept).length;
    const finalOverall = currentOverall;
    const baselineOverall = baselineScores.overallRate;
    const totalDelta = finalOverall - baselineOverall;

    console.log(`\nExit reason: ${exitReason}`);
    console.log(`Iterations: ${iterationsRun}/${maxIterations} (${keptCount} kept, ${revertedCount} reverted)`);
    console.log(`Duration: ${loopDuration}s (${(loopDuration / 60).toFixed(1)} min)`);
    console.log(`\nOverall: ${baselineOverall.toFixed(1)}% -> ${finalOverall.toFixed(1)}% (${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(1)}%)`);
    console.log('\nBy category:');
    for (const cat of Object.keys(baselineScores.categoryRates)) {
      const before = baselineScores.categoryRates[cat];
      const after = currentRates[cat] ?? 0;
      const delta = after - before;
      console.log(`  ${cat}: ${before.toFixed(1)}% -> ${after.toFixed(1)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`);
    }

    // Write to DB
    const db = new DatabaseSync(dbFile);
    db.prepare(`
      INSERT INTO eval_runs (skill_id, run_at, metric_name, metric_before, metric_after,
        delta, iterations, duration_seconds, model, notes)
      VALUES (?, ?, 'eval-loop', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dbSkillId,
      new Date().toISOString(),
      parseFloat(baselineOverall.toFixed(1)),
      parseFloat(finalOverall.toFixed(1)),
      parseFloat(totalDelta.toFixed(1)),
      iterationsRun,
      loopDuration,
      model,
      JSON.stringify({
        exit_reason: exitReason,
        kept: keptCount,
        reverted: revertedCount,
        mutations: mutationHistory,
        baseline_categories: baselineScores.categoryRates,
        final_categories: currentRates,
      })
    );
    db.close();
    console.log(`\nResults written to skills.db eval_runs table (skill_id: ${dbSkillId}).`);

    // Write debrief report
    const reportDate = new Date().toISOString().slice(0, 10);
    const reportPath = join(evalsOutputDir, `loop-${reportDate}.md`);
    let report = `# Eval Loop Report \u2014 ${skillId} \u2014 ${reportDate}\n\n`;
    report += `## Configuration\n`;
    report += `- **Model:** ${model}\n`;
    report += `- **Iterations:** ${iterationsRun} run / ${maxIterations} budgeted\n`;
    report += `- **Duration:** ${(loopDuration / 60).toFixed(1)} minutes\n`;
    report += `- **Exit reason:** ${exitReason}\n\n`;

    report += `## Results\n\n`;
    report += `| Category | Baseline | Final | Delta |\n|----------|----------|-------|-------|\n`;
    for (const cat of Object.keys(baselineScores.categoryRates)) {
      const before = baselineScores.categoryRates[cat];
      const after = currentRates[cat] ?? 0;
      const delta = after - before;
      report += `| ${cat} | ${before.toFixed(1)}% | ${after.toFixed(1)}% | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% |\n`;
    }
    report += `| **overall** | **${baselineOverall.toFixed(1)}%** | **${finalOverall.toFixed(1)}%** | **${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(1)}%** |\n\n`;

    const kept = mutationHistory.filter(m => m.kept);
    if (kept.length > 0) {
      report += `## Mutations Applied (kept)\n\n`;
      for (const m of kept) {
        const catDetail = Object.entries(m.categoryDeltas)
          .filter(([, d]) => Math.abs(d) > 0.1)
          .map(([c, d]) => `${c} ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`)
          .join(', ');
        report += `${m.iteration}. Iteration ${m.iteration}: ${m.hypothesis} \u2192 overall ${m.deltaOverall >= 0 ? '+' : ''}${m.deltaOverall.toFixed(1)}%${catDetail ? ` (${catDetail})` : ''}\n`;
      }
      report += '\n';
    }

    const reverted = mutationHistory.filter(m => !m.kept);
    if (reverted.length > 0) {
      report += `## Mutations Reverted\n\n`;
      for (const m of reverted) {
        report += `${m.iteration}. Iteration ${m.iteration}: ${m.hypothesis} \u2192 overall ${m.deltaOverall >= 0 ? '+' : ''}${m.deltaOverall.toFixed(1)}%\n`;
      }
      report += '\n';
    }

    // Remaining weak assertions
    const failing = buildFailingSummary(currentResults);
    if (failing) {
      report += `## Remaining Weak Assertions\n\n`;
      for (const line of failing.split('\n')) {
        report += `- ${line.trim()}\n`;
      }
      report += '\n';
    }

    report += `## Skill Diff\n\n`;
    if (currentSkillContent === originalSkillContent) {
      report += `No changes made \u2014 all mutations were reverted.\n`;
    } else {
      report += `Skill was modified. Original backed up at: \`${originalBackup}\`\n`;
      report += `Review the current SKILL.md for the final state.\n`;
    }

    writeFileSync(reportPath, report);
    console.log(`Report: ${reportPath}`);

    // Clean up iteration backups (keep original and final)
    for (let i = 1; i <= iterationsRun; i++) {
      const backup = join(evalsOutputDir, `.backup-iter-${i}.md`);
      if (existsSync(backup)) {
        try { unlinkSync(backup); } catch {}
      }
    }
    console.log('Iteration backups cleaned up (original preserved).');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
