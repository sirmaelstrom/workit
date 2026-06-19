#!/usr/bin/env node
/**
 * Eval Scheduler — picks the next skill from the queue, generates a suite if
 * needed, and kicks off a Karpathy eval loop via nightly-run.mjs.
 *
 * Usage:
 *   node eval-scheduler.mjs                    # Process next in queue
 *   node eval-scheduler.mjs --status           # Show queue status + recent runs
 *   node eval-scheduler.mjs --notify           # Check for new results and send Discord summary
 *   node eval-scheduler.mjs --webhook <url>    # Override Discord webhook
 *
 * Queue file: eval-queue.json (same directory)
 * Pops from front of queue after completion. Writes results to skills.db.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, 'eval-queue.json');
// scripts -> eval-loop -> skills -> <plugin-repo> -> projects
const PROJECTS_ROOT = resolve(__dirname, '..', '..', '..', '..');
const LAST_NOTIFY_FILE = join(__dirname, '.last-notify-timestamp');
// Optional: a ledger endpoint to mirror results to. Unset = ledger writes are skipped.
const service_URL = process.env.service_URL || '';
const LEDGER_USER_ID = process.env.LEDGER_USER_ID || 'user';
// Plugin repos (siblings under PROJECTS_ROOT) to scan for skills.db. Comma-separated.
const EVAL_PLUGINS = (process.env.EVAL_PLUGINS || 'heathdev-workshop-plugin')
  .split(',').map(s => s.trim()).filter(Boolean);

// --- Webhook ---
function getWebhookUrl(cliWebhook) {
  if (cliWebhook) return cliWebhook;
  if (process.env.DISCORD_WEBHOOK_URL?.startsWith('https://')) return process.env.DISCORD_WEBHOOK_URL;
  const home = homedir();
  for (const f of ['claude-discord-claudehook', 'claude-discord-webhook']) {
    try {
      const p = join(home, '.cache', f);
      if (existsSync(p)) {
        const url = readFileSync(p, 'utf8').trim();
        if (url.startsWith('https://')) return url;
      }
    } catch {}
  }
  return null;
}

async function notify(webhookUrl, content) {
  if (!webhookUrl) { console.log(`[no webhook] ${content}`); return; }
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) console.warn(`Webhook returned ${resp.status}`);
  } catch (e) {
    console.warn(`Webhook error: ${e.message}`);
  }
}

async function notifyEmbed(webhookUrl, embed) {
  if (!webhookUrl) { console.log(`[no webhook] ${embed.title}`); return; }
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!resp.ok) console.warn(`Webhook returned ${resp.status}`);
  } catch (e) {
    console.warn(`Webhook error: ${e.message}`);
  }
}

// --- Optional ledger mirror ---
async function writeLedger(content) {
  if (!service_URL) return; // no endpoint configured — skip silently
  try {
    const resp = await fetch(`${service_URL}/api/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'note',
        source: 'system',
        user_id: LEDGER_USER_ID,
        payload: { content },
      }),
    });
    if (!resp.ok) console.warn(`Ledger POST returned ${resp.status}`);
    else console.log('Ledger note written to service');
  } catch (e) {
    console.warn(`Ledger POST failed: ${e.message}`);
  }
}

// --- Queue management ---
function loadQueue() {
  if (!existsSync(QUEUE_FILE)) {
    console.error(`Queue file not found: ${QUEUE_FILE}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
}

function saveQueue(data) {
  writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2) + '\n');
}

// --- Suite generation ---
function generateSuite(skill, skillFilePath, evalsDir) {
  console.log(`\nGenerating eval suite for "${skill}"...`);
  const skillContent = readFileSync(skillFilePath, 'utf-8');

  const prompt = `You are generating an eval suite for a Claude Code skill. Study this skill definition carefully:

<skill>
${skillContent}
</skill>

Generate a YAML eval suite that tests this skill's output quality. Follow this exact format:

\`\`\`yaml
# Eval Suite: ${skill}
# Tests whether the skill produces correct output matching its specification.
#
# Tiers:
#   smoke  — run every iteration for fast signal (3 cases)
#   verify — run only when smoke improves (3-4 cases)

skill: ${skill}
created_at: "${new Date().toISOString()}"
model: sonnet
iterations: 10
timeout_per_iteration_minutes: 10

test_cases:
  # --- SMOKE TIER ---
  # 3 cases covering the most critical behaviors

  - id: tc-01
    tier: smoke
    description: "<core happy path scenario>"
    input: |
      /<skill-command>
      <realistic simulated input>
    context:
      project: heathdev-service
      constraints: []
    assertions:
      format:
        - "[deterministic] Output contains '<expected string>'"
        - "<LLM-judged format assertion>"
      quality:
        - "<LLM-judged quality assertion>"
      instruction_adherence:
        - "<LLM-judged adherence assertion>"

  # ... tc-02, tc-03 (smoke), tc-04 through tc-06/07 (verify)

  # --- VERIFY TIER ---
  # 3-4 cases covering edge cases and less common paths
\`\`\`

Rules:
1. Generate 6-7 test cases total: 3 smoke, 3-4 verify
2. Smoke cases should cover the most critical/common behaviors
3. Verify cases should cover edge cases and less common paths
4. Use [deterministic] prefix for assertions that can be checked with string matching
5. Make inputs realistic — simulate actual file contents, git status, etc.
6. Each assertion should be independently verifiable (one claim per assertion)
7. Test for both what the skill SHOULD do and what it should NOT do
8. Include assertions across all 3 categories: format, quality, instruction_adherence

Output ONLY the YAML content inside the code fence. No explanation before or after.`;

  const result = spawnSync('claude', ['-p', prompt, '--model', 'sonnet', '--output-format', 'text'], {
    timeout: 120000,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 2,
    windowsHide: true,
  });

  const output = (result.stdout || '').trim();

  // Extract YAML from code fence
  const yamlMatch = output.match(/```(?:yaml)?\n([\s\S]*?)```/);
  const yaml = yamlMatch ? yamlMatch[1].trim() : output;

  if (yaml.length < 200) {
    console.error(`Suite generation produced insufficient output (${yaml.length} chars)`);
    return false;
  }

  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(join(evalsDir, 'suite.yaml'), yaml + '\n');
  console.log(`Suite written: ${join(evalsDir, 'suite.yaml')} (${yaml.length} chars)`);
  return true;
}

// --- Status command ---
async function showStatus() {
  const data = loadQueue();
  console.log(`\nEval Queue Status`);
  console.log('='.repeat(50));
  console.log(`Remaining: ${data.queue.length} skills\n`);

  for (let i = 0; i < data.queue.length; i++) {
    const s = data.queue[i];
    const projectRoot = join(PROJECTS_ROOT, s.plugin);
    const suiteCheck = s.suite_file
      ? join(projectRoot, s.suite_file)
      : join(projectRoot, 'evals', s.skill, 'suite.yaml');
    const hasSuite = existsSync(suiteCheck);
    const marker = i === 0 ? '>>> ' : '    ';
    console.log(`${marker}${i + 1}. ${s.skill} (${s.plugin}) ${hasSuite ? '[suite ready]' : '[needs suite]'}`);
  }

  // Show recent runs from DB
  console.log('\nRecent eval runs:');
  for (const plugin of EVAL_PLUGINS) {
    const dbFile = join(PROJECTS_ROOT, plugin, 'skills.db');
    if (!existsSync(dbFile)) continue;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbFile);
      const runs = db.prepare(`
        SELECT skill_id, run_at, metric_name, metric_before, metric_after, delta, duration_seconds
        FROM eval_runs ORDER BY run_at DESC LIMIT 5
      `).all();
      for (const r of runs) {
        const dur = r.duration_seconds ? `${(r.duration_seconds / 60).toFixed(0)}m` : '?';
        if (r.metric_before != null) {
          console.log(`  ${r.run_at.slice(0, 16)} | ${r.skill_id} | ${r.metric_before}% -> ${r.metric_after}% (${r.delta >= 0 ? '+' : ''}${r.delta}%) | ${dur}`);
        } else {
          console.log(`  ${r.run_at.slice(0, 16)} | ${r.skill_id} | baseline: ${r.metric_after}% | ${dur}`);
        }
      }
      db.close();
    } catch {}
  }
}

// --- Notify command: check for new results since last notification ---
async function checkAndNotify(webhookUrl) {
  let lastNotify = '2000-01-01T00:00:00Z';
  if (existsSync(LAST_NOTIFY_FILE)) {
    lastNotify = readFileSync(LAST_NOTIFY_FILE, 'utf-8').trim();
  }

  const newRuns = [];

  for (const plugin of EVAL_PLUGINS) {
    const dbFile = join(PROJECTS_ROOT, plugin, 'skills.db');
    if (!existsSync(dbFile)) continue;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbFile);
      const runs = db.prepare(`
        SELECT skill_id, run_at, metric_name, metric_before, metric_after, delta,
               duration_seconds, iterations, model, notes
        FROM eval_runs
        WHERE run_at > ?
        ORDER BY run_at ASC
      `).all(lastNotify);
      for (const r of runs) {
        newRuns.push({ ...r, plugin });
      }
      db.close();
    } catch {}
  }

  if (newRuns.length === 0) {
    console.log('No new eval runs since last notification.');
    return;
  }

  // Build notification
  for (const run of newRuns) {
    const dur = run.duration_seconds ? `${(run.duration_seconds / 60).toFixed(1)}m` : '?';
    let notes = {};
    try { notes = JSON.parse(run.notes || '{}'); } catch {}

    if (run.metric_name === 'eval-loop') {
      const color = run.delta > 0 ? 5763719 : (run.delta === 0 ? 16776960 : 15548997); // green/yellow/red
      const emoji = run.delta > 0 ? '\u2705' : (run.delta === 0 ? '\u{1F7E1}' : '\u274C');

      let catBreakdown = '';
      if (notes.baseline_categories && notes.final_categories) {
        for (const [cat, before] of Object.entries(notes.baseline_categories)) {
          const after = notes.final_categories[cat] ?? 0;
          const d = after - before;
          catBreakdown += `${cat}: ${before.toFixed(0)}% \u2192 ${after.toFixed(0)}% (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)\n`;
        }
      }

      await notifyEmbed(webhookUrl, {
        title: `${emoji} Eval Loop Complete: ${run.skill_id}`,
        description: `**${run.metric_before}% \u2192 ${run.metric_after}%** (${run.delta >= 0 ? '+' : ''}${run.delta}%)`,
        color,
        fields: [
          { name: 'Duration', value: dur, inline: true },
          { name: 'Iterations', value: `${notes.kept || 0} kept / ${notes.reverted || 0} reverted`, inline: true },
          { name: 'Exit', value: notes.exit_reason || '?', inline: true },
          ...(catBreakdown ? [{ name: 'Categories', value: '```\n' + catBreakdown + '```', inline: false }] : []),
        ],
        footer: { text: `${run.plugin} | ${run.model}` },
        timestamp: run.run_at,
      });
    } else if (run.metric_name === 'baseline') {
      await notifyEmbed(webhookUrl, {
        title: `\u{1F4CA} New Baseline: ${run.skill_id}`,
        description: `**${run.metric_after}%** overall`,
        color: 3447003,
        fields: [
          { name: 'Duration', value: dur, inline: true },
          { name: 'Model', value: run.model || '?', inline: true },
        ],
        footer: { text: run.plugin },
        timestamp: run.run_at,
      });
    }
  }

  // Write summary to service ledger
  const lines = newRuns.map(run => {
    const dur = run.duration_seconds ? `${(run.duration_seconds / 60).toFixed(0)}m` : '?';
    let notes = {};
    try { notes = JSON.parse(run.notes || '{}'); } catch {}
    if (run.metric_name === 'eval-loop') {
      const arrow = `${run.metric_before}% → ${run.metric_after}%`;
      const delta = `${run.delta >= 0 ? '+' : ''}${run.delta}%`;
      const kept = notes.kept ?? 0;
      const reverted = notes.reverted ?? 0;
      return `• ${run.skill_id}: ${arrow} (${delta}) — ${kept} kept, ${reverted} reverted, ${dur}`;
    } else if (run.metric_name === 'baseline') {
      return `• ${run.skill_id}: baseline ${run.metric_after}% — ${dur}`;
    }
    return `• ${run.skill_id}: ${run.metric_name} — ${run.metric_after}%`;
  });
  await writeLedger(`Eval loop results:\n${lines.join('\n')}`);

  // Update last notify timestamp
  const latestRun = newRuns[newRuns.length - 1];
  writeFileSync(LAST_NOTIFY_FILE, latestRun.run_at);
  console.log(`Notified ${newRuns.length} new run(s). Last: ${latestRun.run_at}`);
}

// --- Main: process next in queue ---
async function processNext(webhookUrl) {
  const data = loadQueue();

  if (data.queue.length === 0) {
    console.log('Queue is empty — all skills processed.');
    await notify(webhookUrl, '\u{1F3C1} **Eval Queue Empty** — All scheduled skills have been processed.');
    return;
  }

  const next = data.queue[0];
  const projectRoot = join(PROJECTS_ROOT, next.plugin);
  const skillFilePath = join(projectRoot, next.skill_file);
  // Support explicit suite_file in queue entry (for non-standard layouts)
  const suiteFile = next.suite_file
    ? join(projectRoot, next.suite_file)
    : join(projectRoot, 'evals', next.skill, 'suite.yaml');
  const evalsDir = dirname(suiteFile);

  console.log(`\nNext skill: ${next.skill} (${next.plugin})`);
  console.log(`Skill file: ${skillFilePath}`);

  if (!existsSync(skillFilePath)) {
    console.error(`Skill file not found: ${skillFilePath}`);
    // Skip this entry
    data.queue.shift();
    saveQueue(data);
    await notify(webhookUrl, `\u26A0\uFE0F **Eval Scheduler** — Skipped \`${next.skill}\`: skill file not found`);
    return;
  }

  // Generate suite if needed
  if (!existsSync(suiteFile)) {
    const ok = generateSuite(next.skill, skillFilePath, evalsDir);
    if (!ok) {
      console.error('Suite generation failed — skipping');
      data.queue.shift();
      saveQueue(data);
      await notify(webhookUrl, `\u26A0\uFE0F **Eval Scheduler** — Skipped \`${next.skill}\`: suite generation failed`);
      return;
    }
  }

  // Run the loop via nightly-run.mjs
  const nightlyScript = join(__dirname, 'nightly-run.mjs');

  console.log(`\nKicking off eval loop: ${next.skill} (${next.iterations} iterations, ${next.model})`);
  await notify(webhookUrl,
    `\u{1F504} **Eval Scheduler** — Starting \`${next.skill}\` (${next.plugin})\n` +
    `Iterations: ${next.iterations} | Model: ${next.model} | Queue remaining: ${data.queue.length - 1}`
  );

  const result = spawnSync('node', [
    nightlyScript,
    '--skill', next.skill,
    '--model', next.model,
    '--iterations', String(next.iterations),
    '--timeout', '10',
    '--skill-file', skillFilePath,
    '--suite-file', suiteFile,
    '--project-root', projectRoot,
    ...(webhookUrl ? ['--webhook', webhookUrl] : []),
  ], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 6 * 60 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 20,
    windowsHide: true,
    stdio: 'inherit',
  });

  // Pop from queue regardless of success (don't retry failed skills automatically)
  data.queue.shift();
  saveQueue(data);

  if (result.status !== 0) {
    console.error(`Loop exited with code ${result.status}`);
  } else {
    console.log(`\nCompleted: ${next.skill}`);
  }

  console.log(`Queue remaining: ${data.queue.length}`);
}

// --- CLI ---
const args = process.argv.slice(2);
const webhookArg = args.includes('--webhook') ? args[args.indexOf('--webhook') + 1] : null;
const webhookUrl = getWebhookUrl(webhookArg);

if (args.includes('--status')) {
  await showStatus();
} else if (args.includes('--notify')) {
  await checkAndNotify(webhookUrl);
} else {
  await processNext(webhookUrl);
}
