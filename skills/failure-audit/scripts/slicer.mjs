// Transcript slicer — living copy for the failure-audit cadence (quest 690bb912).
// Origin: the e8e289e1 pilot slicer, frozen with the 2026-08-11 baseline run.
// Digests Claude Code session jsonl into compact per-session markdown for
// failure-mode audit agents.
// Usage: node slicer.mjs <run-dir> <jsonl-path>...   (or --list=<file>)
// Writes <run-dir>/digests/*.md + <run-dir>/manifest.json.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_TYPES = new Set(['mode', 'file-history-snapshot', 'file-history-delta', 'attachment', 'last-prompt', 'ai-title', 'custom-title', 'agent-name', 'summary', 'queued-prompt', 'thinking-budget']);

function trunc(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n) + ` …[+${s.length - n} chars]`;
}
function hhmm(ts) {
  try { return new Date(ts).toISOString().slice(5, 16).replace('T', ' '); } catch { return '??'; }
}
function toolBrief(tu) {
  const i = tu.input || {};
  if (tu.name === 'Bash' || tu.name === 'PowerShell') return trunc(i.command, 200);
  if (i.file_path) return i.file_path;
  if (i.description) return trunc(i.description, 120);
  if (i.pattern) return `pattern: ${trunc(i.pattern, 80)}`;
  if (i.prompt) return trunc(i.prompt, 120);
  return trunc(Object.keys(i).join(','), 80);
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function digest(file, { asstCap = 700, userCap = 1500 } = {}) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  const models = new Set();
  let userN = 0, asstN = 0, sidechain = 0, errN = 0, interrupts = 0;
  let firstTs = null, lastTs = null;

  for (const raw of lines) {
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (SKIP_TYPES.has(o.type)) continue;
    if (o.timestamp) { firstTs ??= o.timestamp; lastTs = o.timestamp; }
    if (o.isSidechain) { sidechain++; continue; }
    const t = hhmm(o.timestamp);

    if (o.type === 'user') {
      const c = o.message?.content;
      const blocks = Array.isArray(c) ? c : null;
      const txt = textOf(c);
      if (txt.includes('[Request interrupted by user')) {
        interrupts++;
        out.push(`[${t}] USER ⛔ INTERRUPT: ${trunc(txt, 300)}`);
        continue;
      }
      if (blocks) {
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.is_error) {
            errN++;
            out.push(`[${t}] TOOL-ERROR: ${trunc(textOf(b.content) || JSON.stringify(b.content), 300)}`);
          }
        }
      }
      if (txt.trim()) {
        // meta-injected stdout/context blocks are noise unless short
        if (o.isMeta && !txt.includes('<command-name>')) continue;
        userN++;
        out.push(`[${t}] USER: ${trunc(txt, userCap)}`);
      }
      continue;
    }

    if (o.type === 'assistant') {
      const m = o.message || {};
      if (m.model) models.add(m.model);
      const c = Array.isArray(m.content) ? m.content : [];
      const parts = [];
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) parts.push(trunc(b.text, asstCap));
        if (b.type === 'tool_use') parts.push(`→ ${b.name}(${toolBrief(b)})`);
      }
      if (m.stop_reason === 'refusal') parts.push('⚠️ STOP_REASON=refusal');
      if (parts.length) { asstN++; out.push(`[${t}] ASSISTANT: ${parts.join('\n  ')}`); }
      continue;
    }

    if (o.type === 'system') {
      const c = String(o.content ?? '');
      if (o.level === 'error' || /error|fail|denied|rejected/i.test(c.slice(0, 120))) {
        out.push(`[${t}] SYSTEM(${o.subtype ?? '?'}): ${trunc(c, 200)}`);
      }
    }
  }

  const header = [
    `# Session digest: ${path.basename(file)}`,
    `- project dir: ${path.basename(path.dirname(file))}`,
    `- span: ${firstTs?.slice(0, 16)} → ${lastTs?.slice(0, 16)} (UTC)`,
    `- models: ${[...models].join(', ') || 'none-recorded'}`,
    `- counts: ${userN} user msgs, ${asstN} assistant msgs, ${errN} tool errors, ${interrupts} user interrupts, ${sidechain} sidechain (subagent) lines OMITTED`,
    `- NOTE: text is truncated ([+N chars] markers); tool RESULTS omitted except errors. Do not infer failure from truncation alone.`,
    '', '---', '',
  ].join('\n');
  return { text: header + out.join('\n\n'), meta: { file: path.basename(file), project: path.basename(path.dirname(file)), models: [...models], userN, asstN, errN, interrupts, sidechain, firstTs, lastTs } };
}

let [outDir, ...files] = process.argv.slice(2);
if (files[0]?.startsWith('--list=')) {
  files = fs.readFileSync(files[0].slice(7), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
}
fs.mkdirSync(path.join(outDir, 'digests'), { recursive: true });
const manifest = [];
files.forEach((f, idx) => {
  let d = digest(f);
  if (d.text.length > 60_000) d = digest(f, { asstCap: 250, userCap: 800 });
  // Trim the encoded drive/workspace prefix (e.g. `D--Development-`) from the
  // digest name — cosmetic only; the manifest keeps the full project string.
  const name = `${String(idx + 1).padStart(2, '0')}-${d.meta.project.replace(/^[A-Za-z]--[A-Za-z0-9]+-?/, '').slice(0, 30) || 'root'}-${d.meta.file.slice(0, 8)}.md`;
  const p = path.join(outDir, 'digests', name);
  fs.writeFileSync(p, d.text);
  manifest.push({ digest: name, bytes: d.text.length, ...d.meta });
  console.log(`${name}  ${(d.text.length / 1024).toFixed(0)}KB  u:${d.meta.userN} a:${d.meta.asstN} err:${d.meta.errN} int:${d.meta.interrupts}`);
});
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} digests → ${outDir}/digests`);
