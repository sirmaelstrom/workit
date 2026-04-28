#!/usr/bin/env node
/**
 * Nightly Eval Runner — wraps run-eval.mjs with Discord notification.
 *
 * Usage:
 *   node nightly-run.mjs --skill diagnose --iterations 5 --model sonnet
 *
 * Designed to be called from Windows Task Scheduler or cron.
 * Sends start/complete/error notifications to Discord via webhook.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

// --- Args ---
const { values: args } = parseArgs({
  options: {
    skill: { type: 'string' },
    model: { type: 'string', default: 'sonnet' },
    iterations: { type: 'string', default: '5' },
    timeout: { type: 'string', default: '10' },
    webhook: { type: 'string', default: '' },
  },
});

const skillId = args.skill;
if (!skillId) {
  console.error('Usage: node nightly-run.mjs --skill <skill-id> [--iterations 5] [--model sonnet]');
  process.exit(1);
}

// --- Discord webhook ---
async function getWebhookUrl() {
  if (args.webhook) return args.webhook;

  // Try bws
  try {
    const result = spawnSync('bws', ['secret', 'get', 'DISCORD_WEBHOOK_assistant', '--output', 'json'], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      if (parsed.value) return parsed.value;
    }
  } catch {}

  // Try bws list fallback
  try {
    const result = spawnSync('bws', ['secret', 'list'], {
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true,
    });
    if (result.stdout) {
      const match = result.stdout.match(/"key":\s*"DISCORD_WEBHOOK_assistant"[\s\S]*?"value":\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch {}

  console.warn('No Discord webhook found — notifications will be skipped');
  return null;
}

async function notify(webhookUrl, message) {
  if (!webhookUrl) {
    console.log(`[Discord skip] ${message}`);
    return;
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!resp.ok) {
      console.warn(`Discord webhook returned ${resp.status}`);
    }
  } catch (e) {
    console.warn(`Discord webhook failed: ${e.message}`);
  }
}

// --- Main ---
async function main() {
  const webhookUrl = await getWebhookUrl();
  const startTime = Date.now();
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

  await notify(webhookUrl,
    `🔄 **Eval Loop Starting** — \`${skillId}\`\n` +
    `Model: ${args.model} | Iterations: ${args.iterations} | ${timestamp}`
  );

  console.log(`\nNightly Eval Runner`);
  console.log(`Skill: ${skillId}`);
  console.log(`Started: ${timestamp}`);
  console.log('─'.repeat(50));

  const runScript = join(__dirname, 'run-eval.mjs');

  const result = spawnSync('node', [
    runScript,
    '--skill', skillId,
    '--mode', 'loop',
    '--model', args.model,
    '--iterations', args.iterations,
    '--timeout', args.timeout,
    '--project-root', projectRoot,
  ], {
    encoding: 'utf-8',
    timeout: 6 * 60 * 60 * 1000, // 6 hour max
    maxBuffer: 1024 * 1024 * 20,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const durationMin = ((Date.now() - startTime) / 60000).toFixed(1);
  const output = result.stdout || '';
  const stderr = result.stderr || '';

  // Write full log
  const logPath = join(projectRoot, 'skills', skillId, 'evals', `nightly-${new Date().toISOString().slice(0, 10)}.log`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(logPath, `STDOUT:\n${output}\n\nSTDERR:\n${stderr}`);

  if (result.status !== 0) {
    console.error(`Exit code: ${result.status}`);
    console.error(stderr.slice(0, 500));

    await notify(webhookUrl,
      `❌ **Eval Loop Failed** — \`${skillId}\`\n` +
      `Duration: ${durationMin} min | Exit: ${result.status}\n` +
      `\`\`\`${stderr.slice(0, 300)}\`\`\``
    );
    process.exit(1);
  }

  // Extract results from output
  const overallMatch = output.match(/Overall: ([\d.]+)% -> ([\d.]+)% \(([+-][\d.]+)%\)/);
  const exitMatch = output.match(/Exit reason: (\w+)/);
  const iterMatch = output.match(/Iterations: (\d+)\/(\d+) \((\d+) kept, (\d+) reverted\)/);

  let summary = `✅ **Eval Loop Complete** — \`${skillId}\`\n`;
  summary += `Duration: ${durationMin} min`;

  if (overallMatch) {
    summary += ` | ${overallMatch[1]}% → ${overallMatch[2]}% (**${overallMatch[3]}%**)`;
  }
  if (exitMatch) {
    summary += `\nExit: ${exitMatch[1]}`;
  }
  if (iterMatch) {
    summary += ` | ${iterMatch[1]}/${iterMatch[2]} iterations (${iterMatch[3]} kept, ${iterMatch[4]} reverted)`;
  }

  // Category breakdown
  const catLines = output.match(/  \w+: [\d.]+% -> [\d.]+% \([+-][\d.]+%\)/g);
  if (catLines) {
    summary += '\n```\n' + catLines.join('\n') + '\n```';
  }

  console.log('\n' + summary);
  await notify(webhookUrl, summary);

  console.log(`\nLog: ${logPath}`);
}

main().catch(async (e) => {
  console.error(e);
  const webhookUrl = await getWebhookUrl();
  await notify(webhookUrl, `❌ **Eval Loop Crashed** — \`${skillId}\`\n\`\`\`${e.message}\`\`\``);
  process.exit(1);
});
