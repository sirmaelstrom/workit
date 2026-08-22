// Delta computation for the failure-audit cadence (quest 690bb912).
//
// COUNT CONTRACT — the session-eligibility clauses below are the single
// definition of "auditable session"; treatment-scan.mjs imports this module's
// constants for the same reason. (Historical: Observatory's briefing detector
// audit-backlog.ts mirrored this count until 2026-08-21, when scanner-first
// retired the backlog line — quest c9c1c459; the briefing collector now calls
// treatment-scan.mjs runScan() directly, so there is no mirror to keep in
// agreement anymore.) Run-dir manifest.json files remain the coverage
// interface between fleet runs. Clauses:
//   - corpus: depth-2 `<project>/<session>.jsonl` under the transcript archive
//     (`subagents/` subtrees are sidechains, never sessions)
//   - minus files <= 1 KB (empty stubs)
//   - minus Temp-scratchpad-rooted lanes (experiment probes)
//   - minus every session named in any prior run's manifest.json
//   - bounded to mtime after the LAST run's date (UTC midnight of the run-dir
//     date); older never-audited sessions are the baseline's known carve-out
//
// CLI: node delta.mjs --workspace-root <abs> [--dry-run] [--date YYYY-MM-DD]
// Exit 0: run dir created with a non-empty delta list.
// Exit 2: empty delta or unresolvable workspace — "nothing was audited" must
//         never be mistaken for a clean audit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_SESSION_BYTES = 1024;
export const TEMP_LANE_FRAGMENT = 'AppData-Local-Temp';
export const RUN_DIR_RE = /^(\d{4})-(\d{2})-(\d{2}).*failure-audit/;

/** Scan run dirs: union of audited session names + epoch of the latest run. */
export function readAuditHistory(reviewsDir) {
  const audited = new Set();
  let epochMs = 0;
  let lastRunDate = null;
  let runCount = 0;
  for (const entry of fs.readdirSync(reviewsDir)) {
    const m = RUN_DIR_RE.exec(entry);
    if (!m) continue;
    const manifestPath = path.join(reviewsDir, entry, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    for (const row of JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) {
      if (row.file) audited.add(row.file);
    }
    runCount++;
    // Explicit parts — a bare 'YYYY-MM-DD' Date parse is the previous-day trap.
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (ms > epochMs) {
      epochMs = ms;
      lastRunDate = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return { audited, epochMs, lastRunDate, runCount };
}

/** The delta set plus the skip tallies (skips are reported, never silent). */
export function computeDelta({ archiveDir, reviewsDir }) {
  const history = readAuditHistory(reviewsDir);
  const items = [];
  const skipped = { stubs: 0, tempLanes: 0, preEpoch: 0, audited: 0 };
  for (const proj of fs.readdirSync(archiveDir)) {
    const projDir = path.join(archiveDir, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    const isTempLane = proj.includes(TEMP_LANE_FRAGMENT);
    for (const name of fs.readdirSync(projDir)) {
      if (!name.endsWith('.jsonl')) continue; // depth-2 only; subagents/ never enumerated
      const p = path.join(projDir, name);
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (history.audited.has(name)) { skipped.audited++; continue; }
      if (isTempLane) { skipped.tempLanes++; continue; }
      if (st.size <= MIN_SESSION_BYTES) { skipped.stubs++; continue; }
      if (st.mtimeMs <= history.epochMs) { skipped.preEpoch++; continue; }
      items.push({ path: p, name, project: proj, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  items.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { history, items, skipped };
}

function localDateStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : (args[i + 1] ?? true)) : undefined;
  };
  const dryRun = args.includes('--dry-run');
  const workspaceRoot = (typeof flag('workspace-root') === 'string' && flag('workspace-root')) || process.env.WORKIT_WORKSPACE_ROOT;
  if (!workspaceRoot) {
    console.error('delta: no workspace root — pass --workspace-root <abs> or set WORKIT_WORKSPACE_ROOT');
    process.exit(2);
  }
  const archiveDir = path.join(workspaceRoot, 'data', 'outputs', 'transcripts', 'cli-projects');
  const reviewsDir = path.join(workspaceRoot, 'data', 'outputs', 'reviews');

  const { history, items, skipped } = computeDelta({ archiveDir, reviewsDir });
  if (history.runCount === 0) {
    console.error(`delta: no prior *failure-audit* run dir with a manifest under ${reviewsDir} — a first run needs an operator-defined corpus, not a delta`);
    process.exit(2);
  }
  console.log(`last run: ${history.lastRunDate} (${history.runCount} run(s), ${history.audited.size} sessions covered)`);
  console.log(`delta: ${items.length} session(s); skipped — already audited ${skipped.audited}, stubs ${skipped.stubs}, temp lanes ${skipped.tempLanes}, pre-epoch ${skipped.preEpoch}`);
  if (items.length === 0) {
    console.error('delta: EMPTY — nothing new to audit. This is exit 2, not a clean audit.');
    process.exit(2);
  }
  for (const it of items) console.log(`  ${it.project}/${it.name}  ${(it.size / 1024).toFixed(0)}KB`);
  if (dryRun) return;

  const stamp = typeof flag('date') === 'string' ? flag('date') : localDateStamp();
  const runDir = path.join(reviewsDir, `${stamp}-failure-audit-delta`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'delta-list.txt'), items.map((i) => i.path).join('\n') + '\n');
  fs.writeFileSync(
    path.join(runDir, 'run-meta.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), sinceRun: history.lastRunDate, deltaCount: items.length, skipped }, null, 2),
  );
  console.log(`\nrun dir: ${runDir}`);
  console.log('next: slicer.mjs <run-dir> --list=<run-dir>/delta-list.txt');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
