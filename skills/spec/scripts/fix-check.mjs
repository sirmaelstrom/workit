#!/usr/bin/env node
// Assemble a wave's fix check and turn its verdict into next-wave dispositions and ledger data.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('../reference/fix-check-prompt.md', import.meta.url));
const STATUSES = new Set(['held', 'failed', 'partial']);

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text`);
  return value;
}

export function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new Error('fixed findings must be an array');
  const ids = new Set();
  for (const finding of findings) {
    if (finding == null || typeof finding !== 'object') throw new Error('finding must be an object');
    const id = requireText(finding.id, 'finding id');
    requireText(finding.finding, `finding ${id} text`);
    requireText(finding.claimed_fix, `finding ${id} claimed_fix`);
    if (ids.has(id)) throw new Error(`duplicate finding id: ${id}`);
    ids.add(id);
  }
  return findings;
}

export function specDiff(beforeDir, afterDir) {
  const result = spawnSync('git', ['diff', '--no-index', '--', beforeDir, afterDir], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`git diff --no-index failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout || '(no spec changes)';
}

export function buildPrompt(findings, diff, afterDir, template = readFileSync(TEMPLATE, 'utf8')) {
  validateFindings(findings);
  return template.replace('{fixed_findings}', JSON.stringify(findings, null, 2))
    .replace('{spec_diff}', diff)
    .replace('{after_dir}', afterDir);
}

function quotedPostFixLine(result, afterDir) {
  const path = requireText(result.path, `result ${result.id} path`);
  if (isAbsolute(path)) throw new Error(`result ${result.id} path must be relative`);
  const root = resolve(afterDir);
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`result ${result.id} path escapes post-fix spec directory`);
  }
  if (!Number.isInteger(result.line) || result.line < 1) {
    throw new Error(`result ${result.id} line must be a positive integer`);
  }
  const quote = requireText(result.quote, `result ${result.id} quote`);
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines[result.line - 1] !== quote) {
    throw new Error(`result ${result.id} quote does not match ${path}:${result.line}`);
  }
}

export function completeCheck(findings, verdict, afterDir, wave) {
  validateFindings(findings);
  if (!Number.isInteger(wave) || wave < 1) throw new Error('wave must be a positive integer');
  if (verdict == null || !Array.isArray(verdict.results)) throw new Error('verdict.results must be an array');
  const expected = new Map(findings.map(finding => [finding.id, finding]));
  const seen = new Set();
  for (const result of verdict.results) {
    const id = requireText(result?.id, 'result id');
    if (!expected.has(id) || seen.has(id)) throw new Error(`unexpected or duplicate result id: ${id}`);
    seen.add(id);
    if (!STATUSES.has(result.status)) throw new Error(`invalid status for ${id}: ${result.status}`);
    requireText(result.reason, `result ${id} reason`);
    quotedPostFixLine(result, afterDir);
  }
  if (seen.size !== findings.length) throw new Error('verdict must cover every fixed finding');
  const reopened = [];
  for (const result of verdict.results) {
    if (result.status === 'held') continue;
    reopened.push({
      id: result.id,
      finding: expected.get(result.id).finding,
      claimed_fix: expected.get(result.id).claimed_fix,
      disposition: 'reopened',
      reopened_from_wave: wave,
      fix_check_status: result.status,
      evidence: { path: result.path, line: result.line, quote: result.quote },
    });
  }
  return {
    wave,
    results: verdict.results,
    fix_check: {
      checked: verdict.results.length,
      failed: reopened.length,
    },
    next_dispositions: { wave: wave + 1, findings: reopened },
  };
}

export function waveEvent(slug, wave, findings, priorCheck) {
  requireText(slug, 'workshop slug');
  if (!Number.isInteger(wave) || wave < 1) throw new Error('wave must be a positive integer');
  for (const key of ['p1', 'p2', 'p3']) {
    if (!Number.isInteger(findings?.[key]) || findings[key] < 0) {
      throw new Error(`findings.${key} must be a non-negative integer`);
    }
  }
  if (wave === 1 && priorCheck != null) throw new Error('wave 1 has no prior fix check');
  if (wave > 1 && (priorCheck == null || !Number.isInteger(priorCheck.checked)
    || !Number.isInteger(priorCheck.failed) || priorCheck.failed < 0
    || priorCheck.checked < priorCheck.failed)) {
    throw new Error('later waves require valid prior fix_check counts');
  }
  const stage = {
    workshop_slug: slug,
    stage: `refinement_wave_${wave}`,
    actor: 'agent',
    findings: { p1: findings.p1, p2: findings.p2, p3: findings.p3 },
  };
  if (wave > 1) stage.fix_check = { checked: priorCheck.checked, failed: priorCheck.failed };
  return {
    event_type: 'note',
    payload: {
      content: `workshop_stage ${slug}: refinement_wave_${wave} completed (p1 ${findings.p1} / p2 ${findings.p2} / p3 ${findings.p3})`,
      workshop_stage: stage,
    },
  };
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] == null) throw new Error('expected --name value pairs');
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}

function writeJson(path, value, exclusive = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}

export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const o = options(rest);
  if (command === 'prepare') {
    const findings = JSON.parse(readFileSync(o.findings, 'utf8'));
    const prompt = buildPrompt(findings, specDiff(o.before, o.after), o.after);
    writeFileSync(o.output, prompt);
    return;
  }
  if (command === 'complete') {
    const findings = JSON.parse(readFileSync(o.findings, 'utf8'));
    const verdict = JSON.parse(readFileSync(o.verdict, 'utf8'));
    const report = completeCheck(findings, verdict, o.after, Number(o.wave));
    writeJson(o.output, report);
    writeJson(o['next-dispositions'], report.next_dispositions, true);
    return;
  }
  if (command === 'empty') {
    const wave = Number(o.wave);
    if (!Number.isInteger(wave) || wave < 1) throw new Error('wave must be a positive integer');
    writeJson(o.output, {
      wave, results: [], fix_check: { checked: 0, failed: 0 },
      next_dispositions: { wave: wave + 1, findings: [] },
    });
    return;
  }
  if (command === 'ledger') {
    const wave = Number(o.wave);
    const counts = { p1: Number(o.p1), p2: Number(o.p2), p3: Number(o.p3) };
    const check = wave > 1 ? JSON.parse(readFileSync(o['prior-report'], 'utf8')).fix_check : undefined;
    writeJson(o.output, waveEvent(o.slug, wave, counts, check));
    return;
  }
  throw new Error('usage: fix-check.mjs prepare|complete|empty|ledger --name value ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
