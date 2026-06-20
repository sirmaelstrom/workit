#!/usr/bin/env node
/**
 * parallel-explore launcher — mechanical dispatch layer
 *
 * Launches N claude -p processes in parallel, each with its own prompt file.
 * Collects results to an output directory. No reasoning, no judgment — just plumbing.
 *
 * Usage:
 *   node launch.mjs --prompts <dir> --workdir <dir> [--model sonnet] [--worktree] [--timeout 600]
 *
 * --prompts    Directory containing branch prompt files (branch-1.md, branch-2.md, ...)
 * --workdir    Working directory for claude processes
 * --model      Model to use: sonnet (default), opus, haiku
 * --worktree   Use git worktrees for isolation (creates temp worktrees per branch)
 * --timeout    Per-branch timeout in seconds (default: 600)
 *
 * Output: writes results to <prompts>/../results/ with one file per branch
 * Exit: 0 if all branches complete, 1 if any fail or timeout
 */

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (typeof fallback === 'boolean') return true;
  return args[idx + 1] || fallback;
}

const promptsDir = resolve(getArg('prompts', ''));
const workdir = resolve(getArg('workdir', process.cwd()));
const model = getArg('model', 'sonnet');
const useWorktree = args.includes('--worktree');
const timeoutSec = parseInt(getArg('timeout', '600'), 10);

if (!promptsDir || !existsSync(promptsDir)) {
  console.error('Error: --prompts directory required and must exist');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Discover branch prompts
// ---------------------------------------------------------------------------

const promptFiles = readdirSync(promptsDir)
  .filter(f => f.endsWith('.md'))
  .sort();

if (promptFiles.length === 0) {
  console.error('Error: no .md prompt files found in', promptsDir);
  process.exit(1);
}

const resultsDir = join(dirname(promptsDir), 'results');
mkdirSync(resultsDir, { recursive: true });

console.log(`\n--- parallel-explore launcher ---`);
console.log(`Branches:  ${promptFiles.length}`);
console.log(`Model:     ${model}`);
console.log(`Workdir:   ${workdir}`);
console.log(`Worktree:  ${useWorktree}`);
console.log(`Timeout:   ${timeoutSec}s`);
console.log(`Results:   ${resultsDir}\n`);

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

const worktrees = [];

function createWorktree(branchName) {
  const wtPath = join(workdir, '..', `.worktree-explore-${branchName}-${Date.now()}`);
  try {
    execSync(`git worktree add "${wtPath}" HEAD --detach`, { cwd: workdir, stdio: 'pipe' });
    worktrees.push(wtPath);
    return wtPath;
  } catch (e) {
    console.error(`Warning: worktree creation failed for ${branchName}, falling back to workdir`);
    return workdir;
  }
}

function cleanupWorktrees() {
  for (const wt of worktrees) {
    try {
      execSync(`git worktree remove "${wt}" --force`, { cwd: workdir, stdio: 'pipe' });
    } catch {
      console.error(`Warning: failed to clean worktree ${wt}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Launch branches
// ---------------------------------------------------------------------------

const modelArg = model === 'opus' ? 'opus'
  : model === 'haiku' ? 'haiku'
  : 'sonnet';

function launchBranch(promptFile, index) {
  const branchName = basename(promptFile, '.md');
  const promptPath = join(promptsDir, promptFile);
  const prompt = readFileSync(promptPath, 'utf-8');
  const resultPath = join(resultsDir, `${branchName}.md`);

  const branchWorkdir = useWorktree ? createWorktree(branchName) : workdir;

  return new Promise((resolve) => {
    const startTime = Date.now();
    console.log(`[${branchName}] launching...`);

    // shell:true keeps `claude` resolvable as a Windows .cmd shim, but the
    // untrusted prompt is passed via stdin (never the shell) to avoid injection;
    // only fixed, safe flags are in argv.
    const child = spawn('claude', ['-p', '--output-format', 'text', '--model', modelArg], {
      cwd: branchWorkdir,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutSec * 1000,
    });
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const status = code === 0 ? 'done' : `failed (exit ${code})`;
      console.log(`[${branchName}] ${status} in ${elapsed}s`);

      // Write result regardless of exit code — partial results are still useful
      const header = `<!-- branch: ${branchName} | model: ${model} | exit: ${code} | time: ${elapsed}s -->\n\n`;
      writeFileSync(resultPath, header + (stdout || `[No output. stderr: ${stderr}]`), 'utf-8');

      resolve({
        branch: branchName,
        exitCode: code,
        elapsed: parseFloat(elapsed),
        resultPath,
        hasOutput: stdout.length > 0,
      });
    });

    child.on('error', (err) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${branchName}] error: ${err.message} (${elapsed}s)`);

      writeFileSync(resultPath, `<!-- branch: ${branchName} | error: ${err.message} -->\n\n[Launch error: ${err.message}]`, 'utf-8');

      resolve({
        branch: branchName,
        exitCode: -1,
        elapsed: parseFloat(elapsed),
        resultPath,
        hasOutput: false,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run all branches in parallel, collect results
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  const results = await Promise.all(
    promptFiles.map((f, i) => launchBranch(f, i))
  );

  if (useWorktree) {
    cleanupWorktrees();
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const succeeded = results.filter(r => r.exitCode === 0).length;
  const failed = results.filter(r => r.exitCode !== 0).length;

  // Write summary
  const summary = {
    totalBranches: results.length,
    succeeded,
    failed,
    totalTimeSeconds: parseFloat(totalTime),
    model,
    results: results.map(r => ({
      branch: r.branch,
      exitCode: r.exitCode,
      elapsed: r.elapsed,
      resultPath: r.resultPath,
    })),
  };

  const summaryPath = join(resultsDir, '_summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\n--- complete ---`);
  console.log(`Succeeded: ${succeeded}/${results.length}`);
  console.log(`Total:     ${totalTime}s`);
  console.log(`Results:   ${resultsDir}`);
  console.log(`Summary:   ${summaryPath}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  cleanupWorktrees();
  process.exit(1);
});
