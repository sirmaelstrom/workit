// Per-memory recurrence scan. The transcript corpus is read-only; only --out writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_MEMORY_DIR = 'D:/Development/data/auto-memory';
const DEFAULT_CORPUS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DELIVERY_CUTOFF = Date.parse('2026-09-01T00:00:00Z');
const SPEC_LINE = /^\s*(situation|mistake):\s*\{regex:\s*("(?:\\.|[^"\\])*")\s*,\s*scope:\s*(call|result|user)\s*\}\s*$/;

function normalized(p) { return path.resolve(p).replaceAll('\\', '/').toLowerCase(); }
function within(p, dir) { const n = normalized(p); const d = normalized(dir).replace(/\/$/, ''); return n === d || n.startsWith(`${d}/`); }
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => typeof b === 'string' ? b : b?.text ?? '').join('\n');
  return '';
}

export function parseMemory(file) {
  const body = fs.readFileSync(file, 'utf8');
  if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) return { file, status: 'not-trap' };
  const lines = body.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${file}: missing closing YAML frontmatter delimiter`);
  const specs = {};
  let originSessionId = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^\s*(situation|mistake):/.test(line)) {
      const m = SPEC_LINE.exec(line);
      if (!m) throw new Error(`${file}:${i + 1}: use ${'situation: {regex: "...", scope: call|result|user}'} (same form for mistake)`);
      if (specs[m[1]]) throw new Error(`${file}:${i + 1}: duplicate ${m[1]}`);
      let source;
      try { source = JSON.parse(m[2]); } catch { throw new Error(`${file}:${i + 1}: regex must be a valid JSON-quoted string`); }
      if (!source) throw new Error(`${file}:${i + 1}: regex cannot be empty`);
      let regex;
      try { regex = new RegExp(source); } catch (e) { throw new Error(`${file}:${i + 1}: invalid ${m[1]} regex: ${e.message}`); }
      specs[m[1]] = { regex, source, scope: m[3] };
    }
    const origin = /^\s*originSessionId:\s*['"]?([a-zA-Z0-9-]+)['"]?\s*$/.exec(line);
    if (origin) originSessionId = origin[1];
  }
  if (!specs.situation || !specs.mistake) return { file, status: 'not-trap' };
  return { file, status: 'trap', originSessionId, ...specs };
}

function walk(dir, accept, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, accept, out);
    else if (entry.isFile() && accept(p)) out.push(p);
  }
  return out;
}

function indexedMemories(memoryDir) {
  const seen = new Set();
  const queue = [path.join(memoryDir, 'MEMORY.md')];
  while (queue.length) {
    const file = queue.shift();
    const key = normalized(file);
    if (seen.has(key) || !fs.existsSync(file) || !within(file, memoryDir)) continue;
    seen.add(key);
    const body = fs.readFileSync(file, 'utf8');
    const links = [...body.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)|\[\[([^\]]+)\]\]/g)];
    for (const link of links) {
      const rel = link[1] ?? `${link[2]}.md`;
      const target = path.resolve(path.dirname(file), rel);
      if (within(target, memoryDir) && fs.existsSync(target)) queue.push(target);
    }
  }
  return seen;
}

function sessionFiles(corpusDir) {
  const files = [];
  for (const project of fs.readdirSync(corpusDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(corpusDir, project.name);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const main = path.join(dir, entry.name);
        const id = entry.name.slice(0, -6);
        const subDir = path.join(dir, id, 'subagents');
        const subagents = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(subDir, n)) : [];
        files.push({ id, project: project.name, main, subagents });
      }
    }
  }
  return files;
}

function records(file) {
  const out = [];
  for (const [i, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { throw new Error(`${file}:${i + 1}: invalid JSONL: ${e.message}`); }
  }
  return out;
}

function timestamp(record) {
  const n = Date.parse(record.timestamp ?? '');
  return Number.isFinite(n) ? n : null;
}

function firstTimestamp(file) {
  let first = null;
  for (const r of records(file)) { const ts = timestamp(r); if (ts !== null && (first === null || ts < first)) first = ts; }
  return first;
}

function gitFirstAdd(file, dataRepo) {
  const rel = path.relative(dataRepo, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file}: outside data repo ${dataRepo}; pass --data-repo`);
  const output = execFileSync('git', ['-C', dataRepo, 'log', '--follow', '--diff-filter=A', '--format=%aI', '--', rel], { encoding: 'utf8' }).trim();
  const first = output.split(/\r?\n/).filter(Boolean).at(-1);
  if (!first) throw new Error(`${file}: no git first-add day in ${dataRepo}`);
  return Date.parse(`${first.slice(0, 10)}T00:00:00Z`);
}

function isMemoryPath(s, memoryDir) {
  const clean = String(s).replace(/^['"]|['"]$/g, '');
  return within(clean, memoryDir);
}

function isQuoteCall(block, memoryDir) {
  if (block.type !== 'tool_use') return false;
  const input = block.input ?? {};
  if (block.name === 'Read') return isMemoryPath(input.file_path ?? input.path ?? '', memoryDir) && /\.(md|jsonl)$/i.test(input.file_path ?? input.path ?? '');
  if (!['Bash', 'PowerShell'].includes(block.name)) return false;
  const cmd = String(input.command ?? '');
  const slashCommand = cmd.replaceAll('\\', '/').toLowerCase();
  return /\bgit\s+(?:-C\s+\S+\s+)?(?:diff|show)\b/i.test(cmd)
    && /\.(?:md|jsonl)\b/i.test(cmd)
    && (slashCommand.includes(normalized(memoryDir)) || slashCommand.includes(`${path.basename(memoryDir).toLowerCase()}/`));
}

function autoMemIndex(record, indexPath) {
  if (record.type !== 'attachment' || record.attachment?.type !== 'instructions') return false;
  return (record.attachment.files ?? []).some((f) => f.type === 'AutoMem' && normalized(f.path ?? '') === normalized(indexPath));
}

function extractSession(descriptor, memoryDir, indexPath) {
  const main = records(descriptor.main);
  const all = [...main, ...descriptor.subagents.flatMap(records)];
  let firstTs = null;
  let excluded = null;
  let indexLoaded = false;
  const bodyReads = new Set();
  const parts = [];
  const quotedIds = new Set();
  const firstUser = main.find((r) => r.type === 'user');
  const firstPrompt = textOf(firstUser?.message?.content);
  if (/You are one auditor in a fleet|fleet-instructions\.md/i.test(firstPrompt)) excluded = 'failure-audit-fleet';
  if (/SessionEnd[\s\S]{0,200}summari[sz]|summari[sz][\s\S]{0,200}SessionEnd/i.test(firstPrompt)) excluded = 'summarizer';
  for (const r of all) {
    const ts = timestamp(r);
    if (ts !== null && (firstTs === null || ts < firstTs)) firstTs = ts;
    if (/(?:^|[\\/])council-seats(?:[\\/]|$)/i.test(r.cwd ?? '')) excluded = 'council-seat';
    if (autoMemIndex(r, indexPath)) indexLoaded = true;
    if (!Array.isArray(r.message?.content)) {
      if (r.type === 'user' && typeof r.message?.content === 'string') parts.push({ ts, scope: 'user', text: r.message.content });
      continue;
    }
    for (const b of r.message.content) {
      if (b.type === 'tool_use') {
        if (b.name === 'Read' && isMemoryPath(b.input?.file_path ?? b.input?.path ?? '', memoryDir)) bodyReads.add(normalized(b.input?.file_path ?? b.input?.path));
        if (isQuoteCall(b, memoryDir) && b.id) quotedIds.add(b.id);
        if (!isQuoteCall(b, memoryDir)) parts.push({ ts, scope: 'call', text: JSON.stringify({ name: b.name, input: b.input ?? {} }) });
      } else if (b.type === 'tool_result') {
        if (!quotedIds.has(b.tool_use_id)) parts.push({ ts, scope: 'result', text: textOf(b.content) });
      } else if (r.type === 'user' && b.type === 'text') {
        parts.push({ ts, scope: 'user', text: b.text ?? '' });
      }
    }
  }
  return { id: descriptor.id, project: descriptor.project, firstTs, excluded, indexLoaded, bodyReads, parts };
}

function hitTimes(session, spec) {
  const hits = [];
  for (const p of session.parts) if (p.ts !== null && p.scope === spec.scope && spec.regex.test(p.text)) hits.push(p.ts);
  return hits;
}

export function verdict(before, after) {
  const beforeRate = before.exposed ? before.mistakes / before.exposed : 0;
  const afterRate = after.exposed ? after.mistakes / after.exposed : 0;
  const expectedMistakes = after.exposed * beforeRate;
  let result = 'no-change';
  if (after.exposed < 3 || expectedMistakes < 2) result = 'untested';
  else if (after.mistakes >= 2 && (beforeRate === 0 || afterRate >= 1.5 * beforeRate)) result = 'worse';
  else if (before.mistakes >= 2 && afterRate <= 0.5 * beforeRate) result = 'reduced';
  return { result, beforeRate, afterRate, expectedMistakes };
}

export function runLessonScan({ memoryDir = DEFAULT_MEMORY_DIR, corpusDir = DEFAULT_CORPUS_DIR, dataRepo = path.dirname(memoryDir) } = {}) {
  const memories = walk(memoryDir, (p) => p.endsWith('.md') && path.basename(p) !== 'MEMORY.md').map(parseMemory);
  const descriptors = sessionFiles(corpusDir);
  const firstById = new Map(descriptors.map((d) => [d.id, firstTimestamp(d.main)]));
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  const linked = indexedMemories(memoryDir);
  const traps = memories.filter((m) => m.status === 'trap').map((m) => {
    const origin = m.originSessionId && firstById.get(m.originSessionId);
    const treatmentMs = origin ?? gitFirstAdd(m.file, dataRepo);
    return { ...m, treatmentMs, treatmentSource: origin ? 'origin-session' : 'git-first-add-day', before: { exposed: 0, mistakes: 0 }, after: { exposed: 0, mistakes: 0 }, sessions: [] };
  });
  const skipped = { 'not-trap': memories.length - traps.length, 'failure-audit-fleet': 0, 'council-seat': 0, summarizer: 0, 'no-timestamp': 0 };
  for (const d of descriptors) {
    const s = extractSession(d, memoryDir, indexPath);
    if (s.excluded) { skipped[s.excluded]++; continue; }
    if (s.firstTs === null) { skipped['no-timestamp']++; continue; }
    for (const m of traps) {
      const situations = hitTimes(s, m.situation);
      const mistakes = hitTimes(s, m.mistake);
      for (const [period, predicate] of [['before', (ts) => ts < m.treatmentMs], ['after', (ts) => ts >= m.treatmentMs]]) {
        const exposed = situations.some(predicate) || mistakes.some(predicate);
        if (exposed) m[period].exposed++;
        if (mistakes.some(predicate)) m[period].mistakes++;
      }
      const hasPostRecord = s.parts.some((p) => p.ts !== null && p.ts >= m.treatmentMs);
      if (hasPostRecord) m.sessions.push({ id: s.id, project: s.project, delivery: s.firstTs < DELIVERY_CUTOFF ? 'unknown' : s.bodyReads.has(normalized(m.file)) ? 'body-read' : s.indexLoaded && linked.has(normalized(m.file)) ? 'index-loaded' : 'unknown', exposed: situations.some((ts) => ts >= m.treatmentMs) || mistakes.some((ts) => ts >= m.treatmentMs), mistake: mistakes.some((ts) => ts >= m.treatmentMs) });
    }
  }
  return { corpusDir, memoryDir, sessionsScanned: descriptors.length, skipped, memories: [
    ...traps.map((m) => ({ file: m.file, status: 'trap', treatment: new Date(m.treatmentMs).toISOString(), treatmentSource: m.treatmentSource, before: m.before, after: m.after, ...verdict(m.before, m.after), sessions: m.sessions })),
    ...memories.filter((m) => m.status === 'not-trap').map((m) => ({ file: m.file, status: 'not-trap' })),
  ] };
}

export function markdownTable(report) {
  const lines = ['| Memory | Before exposed | Before mistakes | After exposed | After mistakes | Expected mistakes | Before rate | After rate | Verdict |', '|---|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const m of report.memories) {
    if (m.status !== 'trap') { lines.push(`| ${path.basename(m.file)} | — | — | — | — | — | — | — | not-trap |`); continue; }
    lines.push(`| ${path.basename(m.file)} | ${m.before.exposed} | ${m.before.mistakes} | ${m.after.exposed} | ${m.after.mistakes} | ${m.expectedMistakes.toFixed(2)} | ${m.beforeRate.toFixed(3)} | ${m.afterRate.toFixed(3)} | ${m.result} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--memory-dir', '--corpus-dir', '--data-repo', '--out'].includes(key) || !args[i + 1]) throw new Error('usage: node lesson-scan.mjs [--memory-dir DIR] [--corpus-dir DIR] [--data-repo DIR] [--out PREFIX]');
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  }
  const { out, ...scanOptions } = options;
  const report = runLessonScan(scanOptions);
  const json = JSON.stringify(report, null, 2);
  const md = markdownTable(report);
  if (out) { fs.writeFileSync(`${out}.json`, `${json}\n`); fs.writeFileSync(`${out}.md`, md); }
  else { console.log(json); console.log(md); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`lesson-scan: ${e.message}`); process.exitCode = 2; }
}
