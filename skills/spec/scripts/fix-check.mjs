#!/usr/bin/env node
// Assemble a wave's fix check and turn its verdict into next-wave dispositions and ledger data.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

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
  const before = resolve(beforeDir);
  const after = resolve(afterDir);
  if (dirname(before) !== dirname(after)) throw new Error('before and after snapshots must be siblings');
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', basename(before), basename(after)], {
    cwd: dirname(before), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`git diff --no-index failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout || '(no spec changes)';
}

export function buildPrompt(findings, diff, afterDir, template = readFileSync(TEMPLATE, 'utf8')) {
  validateFindings(findings);
  const slots = {
    '{fixed_findings}': JSON.stringify(findings, null, 2),
    '{spec_diff}': diff,
    '{after_dir}': afterDir,
    '{after_snapshot}': basename(resolve(afterDir)),
    '{payload_json}': JSON.stringify({ fixed_findings: findings, spec_diff: diff,
      after_dir: afterDir, after_snapshot: basename(resolve(afterDir)) }, null, 2),
  };
  // Git may check the template out with CRLF. Keep the prompt's JSON boundary stable.
  return template.replace(/\r\n?/g, '\n')
    .replace(/\{fixed_findings\}|\{spec_diff\}|\{after_dir\}|\{after_snapshot\}|\{payload_json\}/g, slot => slots[slot]);
}

function quotedPostFixLine(result, afterDir) {
  const path = requireText(result.path, `result ${result.id} path`);
  if (isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error(`result ${result.id} path must be relative (drive-relative paths are forbidden)`);
  }
  const root = resolve(afterDir);
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || win32.isAbsolute(rel)
    || path.split(/[\\/]/).includes('..')) {
    throw new Error(`result ${result.id} path escapes post-fix spec directory`);
  }
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  const realRel = relative(realRoot, realFile);
  if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new Error(`result ${result.id} path escapes post-fix spec snapshot`);
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
      reason: result.reason,
      evidence: { path: result.path, line: result.line, quote: result.quote },
    });
  }
  return {
    wave,
    results: verdict.results,
    fix_check: {
      checked: verdict.results.length,
      failed: reopened.length,
      unchecked: 0,
    },
    next_dispositions: { wave: wave + 1, findings: reopened },
  };
}

export function uncheckedCheck(findings, wave) {
  validateFindings(findings);
  if (!Number.isInteger(wave) || wave < 1) throw new Error('wave must be a positive integer');
  const reason = 'Checker unavailable or invalid after two re-dispatches';
  return {
    wave,
    results: findings.map(finding => ({ id: finding.id, status: 'unchecked', reason })),
    fix_check: { checked: 0, failed: 0, unchecked: findings.length },
    next_dispositions: {
      wave: wave + 1,
      findings: findings.map(finding => ({
        ...finding,
        disposition: 'reopened',
        reopened_from_wave: wave,
        fix_check_status: 'unchecked',
        reason,
      })),
    },
  };
}

export function mergeDispositions(existing, incoming, previousReport = null) {
  if (existing == null) return incoming;
  if (existing?.wave !== incoming.wave || !Array.isArray(existing.findings)) {
    throw new Error('existing next-wave dispositions have an invalid wave or findings array');
  }
  const merged = new Map();
  for (const finding of existing.findings) {
    const id = requireText(finding?.id, 'existing disposition id');
    if (merged.has(id)) throw new Error(`duplicate existing disposition id: ${id}`);
    merged.set(id, finding);
  }
  const ownedIds = new Set();
  if (previousReport != null) {
    if (previousReport.wave !== incoming.wave - 1 || !Array.isArray(previousReport.next_dispositions?.findings)) {
      throw new Error('prior fix-check report has an invalid wave or dispositions');
    }
    for (const prior of previousReport.next_dispositions.findings) {
      if (prior.reopened_from_wave !== previousReport.wave || !prior.fix_check_status) continue;
      if (!isDeepStrictEqual(merged.get(prior.id), prior)) {
        throw new Error(`conflicting downstream disposition for ${prior.id}`);
      }
      ownedIds.add(prior.id);
      if (!incoming.findings.some(finding => finding.id === prior.id)) merged.delete(prior.id);
    }
  }
  for (const finding of incoming.findings) {
    if (merged.has(finding.id) && !ownedIds.has(finding.id)) {
      throw new Error(`conflicting downstream disposition for ${finding.id}`);
    }
    merged.set(finding.id, finding);
  }
  return { wave: incoming.wave, findings: [...merged.values()] };
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
    || !Number.isInteger(priorCheck.failed)
    || (priorCheck.unchecked !== undefined && !Number.isInteger(priorCheck.unchecked))
    || priorCheck.checked < 0 || priorCheck.failed < 0 || (priorCheck.unchecked ?? 0) < 0
    || priorCheck.checked < priorCheck.failed)) {
    throw new Error('later waves require valid prior fix_check counts');
  }
  const stage = {
    workshop_slug: slug,
    stage: `refinement_wave_${wave}`,
    actor: 'agent',
    findings: { p1: findings.p1, p2: findings.p2, p3: findings.p3 },
  };
  if (wave > 1) stage.fix_check = {
    checked: priorCheck.checked, failed: priorCheck.failed, unchecked: priorCheck.unchecked ?? 0,
  };
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

function textOption(options, name) {
  return requireText(options[name], `--${name}`);
}

function integerOption(options, name, minimum = 0) {
  const value = options[name];
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)
    || Number(value) < minimum || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} must be a ${minimum ? 'positive' : 'non-negative'} integer`);
  }
  return Number(value);
}

function stageJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return temp;
}

function writeJson(path, value) {
  const temp = stageJson(path, value);
  try { renameSync(temp, path); } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function writeReportPair(reportPath, nextPath, report) {
  if (resolve(reportPath) === resolve(nextPath)) throw new Error('report and next dispositions paths must differ');
  const existing = existsSync(nextPath) ? JSON.parse(readFileSync(nextPath, 'utf8')) : null;
  const previousReport = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const merged = mergeDispositions(existing, report.next_dispositions, previousReport);
  const complete = { ...report, next_dispositions: merged };
  // Validate and stage both artifacts before replacing either destination.
  const nextTemp = stageJson(nextPath, merged);
  let reportTemp;
  try {
    reportTemp = stageJson(reportPath, complete);
    renameSync(nextTemp, nextPath);
    renameSync(reportTemp, reportPath);
  } finally {
    if (existsSync(nextTemp)) unlinkSync(nextTemp);
    if (reportTemp && existsSync(reportTemp)) unlinkSync(reportTemp);
  }
}

export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const o = options(rest);
  if (command === 'prepare') {
    const findings = JSON.parse(readFileSync(textOption(o, 'findings'), 'utf8'));
    const prompt = buildPrompt(findings, specDiff(textOption(o, 'before'), textOption(o, 'after')), o.after);
    writeFileSync(textOption(o, 'output'), prompt);
    return;
  }
  if (command === 'complete') {
    const findings = JSON.parse(readFileSync(textOption(o, 'findings'), 'utf8'));
    const verdict = JSON.parse(readFileSync(textOption(o, 'verdict'), 'utf8'));
    const report = completeCheck(findings, verdict, textOption(o, 'after'), integerOption(o, 'wave', 1));
    writeReportPair(textOption(o, 'output'), textOption(o, 'next-dispositions'), report);
    return;
  }
  if (command === 'unchecked') {
    const findings = JSON.parse(readFileSync(textOption(o, 'findings'), 'utf8'));
    const report = uncheckedCheck(findings, integerOption(o, 'wave', 1));
    writeReportPair(textOption(o, 'output'), textOption(o, 'next-dispositions'), report);
    return;
  }
  if (command === 'empty') {
    const wave = integerOption(o, 'wave', 1);
    writeJson(textOption(o, 'output'), {
      wave, results: [], fix_check: { checked: 0, failed: 0, unchecked: 0 },
      next_dispositions: { wave: wave + 1, findings: [] },
    });
    return;
  }
  if (command === 'ledger') {
    const wave = integerOption(o, 'wave', 1);
    const counts = { p1: integerOption(o, 'p1'), p2: integerOption(o, 'p2'), p3: integerOption(o, 'p3') };
    if (wave === 1 && o['prior-report'] !== undefined) throw new Error('--prior-report is forbidden for wave 1');
    if (wave > 1 && o['prior-report'] === undefined) throw new Error('--prior-report is required for later waves');
    const check = wave > 1 ? JSON.parse(readFileSync(textOption(o, 'prior-report'), 'utf8')).fix_check : undefined;
    writeJson(textOption(o, 'output'), waveEvent(textOption(o, 'slug'), wave, counts, check));
    return;
  }
  throw new Error('usage: fix-check.mjs prepare|complete|unchecked|empty|ledger --name value ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
