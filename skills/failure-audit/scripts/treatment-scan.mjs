// Deterministic treatment scanner for the two grep-shaped watched classes
// (quest c9c1c459, Option A of the 2026-08-21 failure-audit value review).
//
// Measures, over the whole transcript archive, per pre/post-treatment window:
//   - shell-string-code-write MECHANISM attempts in Bash/PowerShell tool-call
//     inputs (heredoc file writes, `tsx -e`, `sed -i`, Set-Content/Out-File/
//     Add-Content). This is the rate the global class rule treats. NOTE: the
//     LLM baseline (4.9/100) counted outcome-qualified failures, not attempts —
//     cross-window comparison is scanner-vs-scanner only; never compare a
//     scanner rate against the auditor rate directly.
//   - harness-protocol (edit-before-read): the harness's literal refusal
//     string in tool_result content. Reported as raw events AND as sessions
//     hitting the seeded label's 3+ bar.
//
// Session eligibility mirrors delta.mjs (depth-2 .jsonl, > 1 KB, temp lanes
// excluded) so denominators stay comparable with the audit corpus. No manifest
// or epoch exclusion — the scanner reads all windows with one instrument.
//
// Sidechain lines (isSidechain === true) are skipped: subagent activity is a
// different treatment population; tallied so the skip is never silent.
//
// CLI: node treatment-scan.mjs --workspace-root <abs>
//        [--epoch <ISO>]           default 2026-08-12T21:50:20Z (guard commit
//                                  92d77ae, shell-string class rule + lesson)
//        [--exclude-session <id>]  instrument quarantine (repeatable)
//        [--evidence <path>]       write per-hit evidence JSONL for spot-checks
// Exit 2 when a window has zero sessions — "no input" must never read as clean.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_SESSION_BYTES, TEMP_LANE_FRAGMENT } from './delta.mjs';

const EDIT_BEFORE_READ_NEEDLE = 'File has not been read yet. Read it first before writing to it.';
const DEFAULT_EPOCH = '2026-08-12T21:50:20Z';

// Redirect and opener tests run on the FIRST LINE only — a heredoc BODY full
// of `->` / `=>` arrows must never read as a file redirect (measured false
// positive: `python - <<'EOF'` bodies).
const HEREDOC_OPENER = /<<\s*-?\s*['"]?[A-Za-z_]/;
const FILE_REDIRECT = /(^|[^<>])>{1,2}\s*(?!\/dev\/null|\$null|&\d)[^\s|&;)]+/;
const firstLine = (c) => c.split('\n', 1)[0];
// Body write-indicators for interpreter-stdin heredocs (python/node/ruby code
// piped via `-` that itself writes files — the tsx -e hazard by another door).
const BODY_WRITES = /\b(open\([^)]*['"](?:w|r\+)|write_text|writeFileSync|WriteAllText|\.write\()/;

// Headline patterns — the class rule's mechanism family. Order matters only
// for the label a hit gets (first match wins).
const HEADLINE_PATTERNS = [
  { label: 'heredoc-file-write', test: (c) => HEREDOC_OPENER.test(firstLine(c)) && FILE_REDIRECT.test(firstLine(c)) },
  { label: 'interpreter-stdin-write', test: (c) => /\b(python3?|node|ruby)\s+-\s/.test(firstLine(c)) && HEREDOC_OPENER.test(firstLine(c)) && BODY_WRITES.test(c) },
  { label: 'tsx-eval', test: (c) => /\btsx\s+(-e|--eval)\b/.test(c) },
  { label: 'sed-in-place', test: (c) => /\bsed\s+(?:-[A-Za-z]+\s+)*-i\b/.test(firstLine(c)) },
  { label: 'ps-content-write', test: (c) => /\b(Set-Content|Out-File|Add-Content)\b/.test(c) },
];
// Context patterns — reported, never in the headline count.
const CONTEXT_PATTERNS = [
  { label: 'heredoc-stdin', test: (c) => HEREDOC_OPENER.test(firstLine(c)) },
  { label: 'echo-redirect', test: (c) => /\b(echo|printf)\b[^|;&]*>{1,2}\s*(?!\/dev\/null|\$null|&\d)[^\s|&;)]+/.test(firstLine(c)) },
];
// A redirect/mention of temp, scratchpad, or .tmp paths is scratch traffic —
// still in-class, but the report separates it from project-file writes.
const SCRATCH_TARGET = /(Temp|scratchpad|\.tmp|\/tmp\/|_scratch|\.scratch)/i;
// A hit inside a search command is likely the pattern-as-text trap
// (source-text-guard-matches-its-own-docs): tag it, exclude from headline.
const SEARCH_CONTEXT = /(^|[|;&]\s*)(grep|rg|Select-String)\b/;

function newWindowTally() {
  return {
    sessions: 0,
    shellString: { instances: 0, sessions: 0, byLabel: {}, searchContextSkipped: 0 },
    context: { byLabel: {} },
    editBeforeRead: { events: 0, sessions: 0, sessionsAt3Plus: 0 },
  };
}

export function scanSession(filePath, { epochMs, evidence, name, project }) {
  const out = { firstTs: null, shellHits: [], contextHits: [], searchSkips: 0, ebrEvents: [], sidechainLines: 0, parseErrors: 0 };
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { out.parseErrors++; continue; }
    if (o.isSidechain === true) { out.sidechainLines++; continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(ts) && out.firstTs === null) out.firstTs = ts;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && (block.name === 'Bash' || block.name === 'PowerShell')) {
        const cmd = String(block.input?.command ?? '');
        if (!cmd) continue;
        const head = HEADLINE_PATTERNS.find((p) => p.test(cmd));
        if (head) {
          if (SEARCH_CONTEXT.test(cmd)) out.searchSkips++;
          else out.shellHits.push({ ts, label: head.label, tool: block.name, scratch: SCRATCH_TARGET.test(cmd.split('\n', 1)[0]), cmd: cmd.slice(0, 200) });
        } else {
          const ctx = CONTEXT_PATTERNS.find((p) => p.test(cmd));
          if (ctx && !SEARCH_CONTEXT.test(cmd)) out.contextHits.push({ ts, label: ctx.label });
        }
      }
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((b) => b?.text ?? '').join('\n') : '';
        if (text.includes(EDIT_BEFORE_READ_NEEDLE)) out.ebrEvents.push({ ts });
      }
    }
  }
  if (evidence) {
    for (const h of out.shellHits) evidence.write(JSON.stringify({ kind: 'shell-string', project, session: name, ...h, ts: h.ts ? new Date(h.ts).toISOString() : null }) + '\n');
    for (const e of out.ebrEvents) evidence.write(JSON.stringify({ kind: 'edit-before-read', project, session: name, ts: e.ts ? new Date(e.ts).toISOString() : null }) + '\n');
  }
  return out;
}

function poissonPAtMost(k, lambda) {
  let term = Math.exp(-lambda); let sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return sum;
}

function main(argv) {
  const args = argv.slice(2);
  const flagAll = (n) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));
  const flag = (n) => flagAll(n)[0];
  const workspaceRoot = flag('workspace-root') || process.env.WORKIT_WORKSPACE_ROOT;
  if (!workspaceRoot) { console.error('treatment-scan: pass --workspace-root <abs> or set WORKIT_WORKSPACE_ROOT'); process.exit(2); }
  const epochMs = Date.parse(flag('epoch') || DEFAULT_EPOCH);
  const excluded = new Set(flagAll('exclude-session').map((s) => `${s}.jsonl`));
  const archiveDir = path.join(workspaceRoot, 'data', 'outputs', 'transcripts', 'cli-projects');
  const evidencePath = flag('evidence');
  const evidence = evidencePath ? fs.createWriteStream(evidencePath) : null;

  const windows = { pre: newWindowTally(), post: newWindowTally() };
  const skipped = { stubs: 0, tempLanes: 0, excludedSessions: 0, noTimestamp: 0 };
  let sidechainLines = 0; let straddlers = 0;

  for (const proj of fs.readdirSync(archiveDir)) {
    const projDir = path.join(archiveDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    if (proj.includes(TEMP_LANE_FRAGMENT)) { skipped.tempLanes++; continue; }
    for (const name of fs.readdirSync(projDir)) {
      if (!name.endsWith('.jsonl')) continue; // depth-2 only; subagents/ are sidechains
      const p = path.join(projDir, name);
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size <= MIN_SESSION_BYTES) { skipped.stubs++; continue; }
      if (excluded.has(name)) { skipped.excludedSessions++; continue; }
      const s = scanSession(p, { epochMs, evidence, name, project: proj });
      sidechainLines += s.sidechainLines;
      if (s.firstTs === null) { skipped.noTimestamp++; continue; }
      const w = windows[s.firstTs < epochMs ? 'pre' : 'post'];
      const lastHitTs = Math.max(0, ...[...s.shellHits, ...s.ebrEvents].map((h) => h.ts || 0));
      if (s.firstTs < epochMs && lastHitTs >= epochMs) straddlers++;
      w.sessions++;
      if (s.shellHits.length) {
        w.shellString.sessions++;
        w.shellString.instances += s.shellHits.length;
        for (const h of s.shellHits) {
          w.shellString.byLabel[h.label] = (w.shellString.byLabel[h.label] ?? 0) + 1;
          if (h.scratch) w.shellString.scratchTargets = (w.shellString.scratchTargets ?? 0) + 1;
        }
      }
      w.shellString.searchContextSkipped += s.searchSkips;
      for (const h of s.contextHits) w.context.byLabel[h.label] = (w.context.byLabel[h.label] ?? 0) + 1;
      if (s.ebrEvents.length) {
        w.editBeforeRead.sessions++;
        w.editBeforeRead.events += s.ebrEvents.length;
        if (s.ebrEvents.length >= 3) w.editBeforeRead.sessionsAt3Plus++;
      }
    }
  }
  if (evidence) evidence.end();

  const per100 = (n, d) => (d ? ((n / d) * 100).toFixed(2) : 'n/a');
  const report = { epoch: new Date(epochMs).toISOString(), skipped, sidechainLinesSkipped: sidechainLines, straddlers, windows: {} };
  for (const [k, w] of Object.entries(windows)) {
    report.windows[k] = {
      sessions: w.sessions,
      shellString: { ...w.shellString, sessionRatePer100: per100(w.shellString.sessions, w.sessions) },
      editBeforeRead: { ...w.editBeforeRead, sessionRatePer100: per100(w.editBeforeRead.sessions, w.sessions) },
      contextOnly: w.context.byLabel,
    };
  }
  // Treatment verdicts: observed post SESSIONS vs pre session-rate scaled to post n.
  const verdict = {};
  for (const [metric, get] of [['shellString', (w) => w.shellString.sessions], ['editBeforeRead', (w) => w.editBeforeRead.sessions]]) {
    const lambda = (get(windows.pre) / (windows.pre.sessions || 1)) * windows.post.sessions;
    const k = get(windows.post);
    verdict[metric] = { expectedIfNoEffect: +lambda.toFixed(2), observed: k, pAtMostObserved: +poissonPAtMost(k, lambda).toFixed(4) };
  }
  report.treatmentVerdict = verdict;
  console.log(JSON.stringify(report, null, 2));
  if (!windows.pre.sessions || !windows.post.sessions) {
    console.error('treatment-scan: a window has ZERO sessions — this is exit 2, not a clean result.');
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
