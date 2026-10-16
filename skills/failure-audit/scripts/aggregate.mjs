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
 * The section keys a doctrine file offers: its `##` and `###` headings, text
 * after the `#` marks, trimmed. The same lines the SKILL's step-3 grep hands
 * the auditors, so a ref copied verbatim from that list matches here.
 */
export function doctrineSectionsFrom(text) {
  return new Set(String(text).split(/\r?\n/).map((line) => /^#{2,3} (.+)$/.exec(line)?.[1]?.trim()).filter(Boolean));
}

/**
 * One failure record's doctrine refs → Map(section → bite), one entry per
 * section. Optional field: a record without it (every pre-2026-10-16 run)
 * yields nothing. Skipped LOUDLY into `counts`, never coerced:
 * - invalidDoctrineRefsSkipped: a non-array field, an empty section, an enum miss;
 * - unknownDoctrineRefsSkipped: a section outside `sections` (when a list is given);
 * - duplicateDoctrineRefsSkipped: a repeat of a section with the same bite;
 * - conflictingDoctrineRefsSkipped: every ref to a section given two different bites.
 */
export function recordDoctrineRefs(failure, sections, counts) {
  const refs = failure?.doctrine_refs;
  if (refs === undefined) return new Map();
  if (!Array.isArray(refs)) { counts.invalidDoctrineRefsSkipped++; return new Map(); }
  const bites = new Map();
  for (const ref of refs) {
    const section = typeof ref?.section === 'string' ? ref.section.trim() : '';
    if (!section || !DOCTRINE_BITE.includes(ref?.bite)) { counts.invalidDoctrineRefsSkipped++; continue; }
    if (sections && !sections.has(section)) { counts.unknownDoctrineRefsSkipped++; continue; }
    bites.set(section, [...(bites.get(section) ?? []), ref.bite]);
  }
  const out = new Map();
  for (const [section, given] of bites) {
    if (new Set(given).size > 1) { counts.conflictingDoctrineRefsSkipped += given.length; continue; }
    counts.duplicateDoctrineRefsSkipped += given.length - 1;
    out.set(section, given[0]);
  }
  return out;
}

/**
 * Pure aggregation over parsed auditor result objects.
 * `manifestDigests` (string[]) defines required coverage. `doctrineSections`
 * (a Set from doctrineSectionsFrom) validates doctrine refs; null skips that check.
 */
export function aggregateResults(results, manifestDigests, { doctrineSections = null } = {}) {
  const agg = {
    counts: { sessions: 0, duplicateSessionsSkipped: 0, invalidEntriesSkipped: 0, nonManifestEntriesSkipped: 0, failureRecords: 0, frictionEventTotal: 0,
      doctrineRefs: 0, invalidDoctrineRefsSkipped: 0, unknownDoctrineRefsSkipped: 0, duplicateDoctrineRefsSkipped: 0, conflictingDoctrineRefsSkipped: 0 },
    doctrineRefsValidated: Boolean(doctrineSections),
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
        for (const [section, bite] of recordDoctrineRefs(f, doctrineSections, agg.counts)) {
          agg.counts.doctrineRefs++;
          agg.byDoctrine[section] ??= Object.fromEntries(DOCTRINE_BITE.map((b) => [b, 0]));
          agg.byDoctrine[section][bite]++;
        }
      }
    }
  }
  const missing = (manifestDigests ?? []).filter((d) => !seen.has(d));
  return { agg, missing };
}

function main(argv) {
  const runDir = argv[2];
  const doctrineAt = argv.indexOf('--doctrine');
  const doctrinePath = doctrineAt > 2 ? argv[doctrineAt + 1] : null;
  if (!runDir || !fs.existsSync(path.join(runDir, 'manifest.json')) || (doctrineAt > 2 && !doctrinePath)) {
    console.error('usage: node aggregate.mjs <run-dir> [--doctrine <DOCTRINE.md>]   (run dir must contain manifest.json)');
    process.exit(2);
  }
  // A named doctrine file that is missing or has no headings would validate
  // every ref as unknown: refuse rather than report an empty join.
  let doctrineSections = null;
  if (doctrinePath) {
    doctrineSections = fs.existsSync(doctrinePath) ? doctrineSectionsFrom(fs.readFileSync(doctrinePath, 'utf8')) : new Set();
    if (doctrineSections.size === 0) {
      console.error(`aggregate: --doctrine ${doctrinePath} is missing or has no ## / ### headings, exit 2`);
      process.exit(2);
    }
  }
  const resultsDir = path.join(runDir, 'fleet-results');
  const resultFiles = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json')) : [];
  if (resultFiles.length === 0) {
    console.error(`aggregate: no result files under ${resultsDir} — DID NOT RUN, exit 2`);
    process.exit(2);
  }
  const results = resultFiles.map((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')));
  const manifestDigests = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')).map((e) => e.digest);
  const { agg, missing } = aggregateResults(results, manifestDigests, { doctrineSections });

  fs.writeFileSync(path.join(runDir, 'aggregate.json'), JSON.stringify(agg, null, 2));
  console.log(`aggregate.json written: ${agg.counts.sessions} sessions, ${agg.counts.failureRecords} failure records, verdicts ${JSON.stringify(agg.verdicts)}`);
  if (agg.counts.invalidEntriesSkipped) console.log(`⚠ invalid entries skipped: ${agg.counts.invalidEntriesSkipped}`);
  console.log(`doctrine refs: ${agg.counts.doctrineRefs} across ${Object.keys(agg.byDoctrine).length} section(s)`);
  if (!doctrineSections) console.log('⚠ doctrine refs NOT validated against a heading list (pass --doctrine <DOCTRINE.md>)');
  for (const [key, label] of [['invalidDoctrineRefsSkipped', 'invalid'], ['unknownDoctrineRefsSkipped', 'unknown-section'],
    ['duplicateDoctrineRefsSkipped', 'duplicate'], ['conflictingDoctrineRefsSkipped', 'conflicting-bite']]) {
    if (agg.counts[key]) console.log(`⚠ ${label} doctrine_refs entries skipped: ${agg.counts[key]}`);
  }
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
