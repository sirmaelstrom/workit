// Aggregate auditor fleet results into aggregate.json (quest 690bb912).
//
// Reads <run-dir>/fleet-results/*.json (auditor output per fleet-instructions
// schema v2) and writes <run-dir>/aggregate.json with the same shape as the
// 2026-08-11 baseline: byClass / byModel / bySeverity / byCaught / verdicts /
// friction. byClass sums `occurrences`; `failureRecords` counts records.
//
// COVERAGE IS THE POINT (a checker over zero input reports "clean"): every
// digest in manifest.json must appear in exactly one valid session entry, or
// this exits 1 listing the gaps. Duplicate digests keep the FIRST entry.
//
// CLI: node aggregate.mjs <run-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Normalize auditor-reported model strings ('claude-opus-5' → 'opus-5'). */
export function normalizeModel(model) {
  if (!model) return 'none-recorded';
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

/**
 * The doctrine liveness enum a failure record's `doctrine_refs[]` entry carries
 * (fleet-instructions.md, quest b74b4cfe). `bite`: the section's situation
 * occurred and the rule changed behavior; `no-bite`: it occurred and the rule
 * made no difference; `n-a`: the auditor checked the section and its situation
 * did not occur. Anything else is skipped and counted, never coerced.
 */
export const DOCTRINE_BITE = Object.freeze(['bite', 'no-bite', 'n-a']);

/**
 * Pure aggregation over parsed auditor result objects.
 * `manifestDigests` (string[]) defines required coverage.
 */
export function aggregateResults(results, manifestDigests) {
  const agg = {
    counts: { sessions: 0, duplicateSessionsSkipped: 0, invalidEntriesSkipped: 0, nonManifestEntriesSkipped: 0, failureRecords: 0, frictionEventTotal: 0, doctrineRefs: 0, invalidDoctrineRefsSkipped: 0 },
    verdicts: {},
    byClass: {},
    byModel: {},
    bySeverity: {},
    byCaught: {},
    // section → { bite, no-bite, n-a }, counted per failure record (not per
    // occurrence). Keyed by the section string the auditor gave; until the
    // DOCTRINE section-id grammar ships that is the heading text, so a renamed
    // heading splits its history across two keys.
    byDoctrine: {},
    taxonomyNotes: [],
  };
  const manifestSet = new Set(manifestDigests ?? []);
  const seen = new Set();
  for (const r of results) {
    if (typeof r?.taxonomy_notes === 'string' && r.taxonomy_notes.trim()) agg.taxonomyNotes.push(`${r.agent ?? '?'}: ${r.taxonomy_notes.trim()}`);
    for (const s of r?.sessions ?? []) {
      // A valid contribution needs a digest AND a verdict — count those, not raw entries.
      if (!s?.digest || !s?.verdict) { agg.counts.invalidEntriesSkipped++; continue; }
      // Calibration-leakage guard (run-1 learning): a digest outside this run's
      // manifest — e.g. a calibration hand's re-read — must not pollute the
      // aggregate. Skipped LOUDLY via the count, never silently.
      if (manifestSet.size > 0 && !manifestSet.has(s.digest)) { agg.counts.nonManifestEntriesSkipped++; continue; }
      if (seen.has(s.digest)) { agg.counts.duplicateSessionsSkipped++; continue; }
      seen.add(s.digest);
      agg.counts.sessions++;
      bump(agg.verdicts, s.verdict);
      agg.counts.frictionEventTotal += s.friction?.count || 0;
      for (const f of s.failures ?? []) {
        if (!f?.label) continue;
        agg.counts.failureRecords++;
        const occ = Number.isFinite(f.occurrences) && f.occurrences > 0 ? f.occurrences : 1;
        bump(agg.byClass, f.label, occ);
        const model = normalizeModel(f.model);
        agg.byModel[model] ??= {};
        bump(agg.byModel[model], f.label, occ);
        bump(agg.bySeverity, f.severity || 'unspecified');
        bump(agg.byCaught, f.caught_by || 'unspecified');
        // Optional field: a record without it (every pre-2026-10-16 run) adds
        // nothing. A present-but-malformed field is skipped LOUDLY.
        if (f.doctrine_refs !== undefined && !Array.isArray(f.doctrine_refs)) agg.counts.invalidDoctrineRefsSkipped++;
        for (const ref of Array.isArray(f.doctrine_refs) ? f.doctrine_refs : []) {
          const section = typeof ref?.section === 'string' ? ref.section.trim() : '';
          if (!section || !DOCTRINE_BITE.includes(ref?.bite)) { agg.counts.invalidDoctrineRefsSkipped++; continue; }
          agg.counts.doctrineRefs++;
          agg.byDoctrine[section] ??= Object.fromEntries(DOCTRINE_BITE.map((b) => [b, 0]));
          agg.byDoctrine[section][ref.bite]++;
        }
      }
    }
  }
  const missing = (manifestDigests ?? []).filter((d) => !seen.has(d));
  return { agg, missing };
}

function main(argv) {
  const runDir = argv[2];
  if (!runDir || !fs.existsSync(path.join(runDir, 'manifest.json'))) {
    console.error('usage: node aggregate.mjs <run-dir>   (run dir must contain manifest.json)');
    process.exit(2);
  }
  const resultsDir = path.join(runDir, 'fleet-results');
  const resultFiles = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json')) : [];
  if (resultFiles.length === 0) {
    console.error(`aggregate: no result files under ${resultsDir} — DID NOT RUN, exit 2`);
    process.exit(2);
  }
  const results = resultFiles.map((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')));
  const manifestDigests = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')).map((e) => e.digest);
  const { agg, missing } = aggregateResults(results, manifestDigests);

  fs.writeFileSync(path.join(runDir, 'aggregate.json'), JSON.stringify(agg, null, 2));
  console.log(`aggregate.json written: ${agg.counts.sessions} sessions, ${agg.counts.failureRecords} failure records, verdicts ${JSON.stringify(agg.verdicts)}`);
  if (agg.counts.invalidEntriesSkipped) console.log(`⚠ invalid entries skipped: ${agg.counts.invalidEntriesSkipped}`);
  console.log(`doctrine refs: ${agg.counts.doctrineRefs} across ${Object.keys(agg.byDoctrine).length} section(s)`);
  if (agg.counts.invalidDoctrineRefsSkipped) console.log(`⚠ invalid doctrine_refs entries skipped: ${agg.counts.invalidDoctrineRefsSkipped}`);
  if (agg.counts.nonManifestEntriesSkipped) console.log(`⚠ non-manifest entries skipped (calibration leakage?): ${agg.counts.nonManifestEntriesSkipped}`);
  if (missing.length > 0) {
    console.error(`COVERAGE GAP — ${missing.length} manifest digest(s) with no valid audit entry:`);
    for (const d of missing) console.error(`  ${d}`);
    console.error('Run a patch hand for these digests, then re-aggregate.');
    process.exit(1);
  }
  console.log('coverage complete: every manifest digest has a valid entry');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
