#!/usr/bin/env node
/**
 * Reads the `Escape:` line fix PRs carry (reference/templates/lane-contract.template.md,
 * rule "A fix PR") and turns the lines into a measurement: a saw / missed /
 * unreviewed / unparsed tally, a join of each introducing PR to the T1 verdict
 * log, and the burn-down run that shipped each introducer. Read-only on GitHub
 * (`gh pr list` only). One JSON document on stdout, in run-log.mjs's shape.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { gh } from '../skills/slim-review/scripts/pr-review.mjs';
import { findTable, splitCells } from './run-log.mjs';

// 0 ok · 1 infrastructure (gh or a read failed) · 2 usage · 3 a census hit --limit
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, TRUNCATED: 3 });
export const ESCAPE_READER_EXIT_CODES = EXIT;

export const USAGE_TEXT = `escape-reader --repo <owner/name> [--repo …] [options] — JSON on stdout.

  --repo <owner/name>     repeatable; the repos whose PR bodies are read (required)
  --since <YYYY-MM-DD>    only fix PRs created on or after this UTC day (default: all)
  --limit <n>             gh pr list --limit per repo (default 5000). A repo that returns
                          exactly n PRs may be cut short: exit 3, no tallies
  --alias <word>=<slug>   repeatable; a spelling the bodies and run docs use for a repo
                          ('obs=heathdev-me/observatory'); bare repo names resolve unaided
  --measure-log <path>    the T1 verdict JSONL pr-review.mjs writes (join per introducer)
  --run-docs <dir>        repeatable; reads burn-down-session-*.md (run attribution)`;

const VALUE_FLAGS = ['repo', 'since', 'limit', 'alias', 'measure-log', 'run-docs'];
const REPEATABLE = new Set(['repo', 'alias', 'run-docs']);
const VERDICTS = ['saw', 'missed', 'unreviewed', 'unparsed'];
// A run "shipped" a PR it names in a row of one of these events (first word, so
// the older docs' `closed (landed)` counts).
const SHIPPED_EVENT = /^(PR|review|closed)\b/;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { repo: [], alias: [], 'run-docs': [], limit: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`unknown argument: ${argv[i]}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (REPEATABLE.has(name)) opts[name].push(value);
    else if (opts[name] !== undefined && name !== 'limit') throw new UsageError(`--${name} given twice`);
    else opts[name] = value;
  }
  if (opts.repo.length === 0) throw new UsageError('give at least one --repo <owner/name>');
  if (opts.repo.some((repo) => !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw new UsageError('--repo must be <owner/name>');
  if (opts.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new UsageError('--since must be YYYY-MM-DD');
  opts.limit = Number(opts.limit);
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new UsageError('--limit must be a positive integer');
  opts.aliases = new Map(opts.alias.map((pair) => {
    const [word, slug] = pair.split('=');
    if (!word || !/^[\w.-]+\/[\w.-]+$/.test(slug ?? '')) throw new UsageError(`--alias wants <word>=<owner/name>: ${pair}`);
    return [word.toLowerCase(), slug];
  }));
  return opts;
}

/** Spelling → `owner/name`, or null when nothing names it: never a guess. */
export function repoResolver(repos, aliases) {
  const known = new Map(repos.map((repo) => [repo.toLowerCase(), repo]));
  return (spelling) => {
    const lower = spelling.toLowerCase();
    if (aliases.has(lower)) return aliases.get(lower);
    if (lower.includes('/')) return known.get(lower) ?? spelling;
    const named = repos.filter((repo) => repo.toLowerCase().split('/')[1] === lower);
    return named.length === 1 ? named[0] : null;
  };
}

const keyOf = (repo, pr) => `${repo.toLowerCase()}#${pr}`;

// `owner/repo#12`, `repo#12`, a bare `#12`, or `owner/repo 8709d1e` (a commit
// needs a digit, so a word like "decade" is not one, and a repo word before it).
const REF = /(?<![\w./-])(?:([\w.-]+(?:\/[\w.-]+)?)#(\d+)|([\w.-]+(?:\/[\w.-]+)?)\s+(?=[0-9a-f]{7,40}\b)(?=[a-f]*\d)([0-9a-f]{7,40})\b|#(\d+))/g;

/** Every PR or commit named in `text`. A bare `#n` takes the previous ref's repo, else `inherit`. */
function refsIn(text, inherit, resolve) {
  const refs = [];
  let repo = inherit;
  for (const m of text.replace(/\([^)]*\)/g, ' ').matchAll(REF)) {
    const spelling = m[1] ?? m[3] ?? null;
    if (spelling) repo = resolve(spelling);
    const pr = m[2] ?? m[5];
    const ref = { repo, spelling, ...(pr ? { pr: Number(pr) } : { commit: m[4] }) };
    if (repo && pr) ref.key = keyOf(repo, pr);
    if (!refs.some((seen) => seen.key ? seen.key === ref.key : seen.commit === ref.commit && seen.repo === ref.repo)) refs.push(ref);
  }
  return refs;
}

const VERDICT_PHRASE = /\breview\s+(saw|missed)\s+it\b|\bunreviewed\b/gi;
// The template copied unfilled: all three choices joined by pipes.
const UNFILLED = /\bsaw it\s*\|\s*\**missed it\**\s*\|\s*\**unreviewed\b/i;
const BOLD_CHOICE = /\*\*\s*(?:review\s+)?(saw it|missed it|unreviewed)\s*\*\*/gi;
const canonical = (phrase) => ({ 'saw it': 'saw', 'missed it': 'missed', unreviewed: 'unreviewed' })[phrase.toLowerCase()];

/**
 * One `Escape:` line → verdict and introducers. One verdict per line: a line
 * with two different verdicts (workit#129) is `unparsed`, not first-wins. An
 * unfilled template with exactly one choice in bold (workit#133) takes the bold
 * choice, marked `parse: 'bold-choice'`; with none or several in bold it is
 * `unparsed`.
 */
export function parseEscapeLine(raw, fixRepo, resolve) {
  const text = raw.replace(/^Escape:\s*/, '');
  const phrases = [...text.matchAll(VERDICT_PHRASE)];
  const intro = /\bintroduced by\b/i.exec(text);
  const segment = intro ? text.slice(intro.index + intro[0].length, phrases[0]?.index ?? text.length) : '';
  let verdict;
  let parse = 'plain';
  let reason;
  if (UNFILLED.test(text)) {
    const bold = new Set([...text.matchAll(BOLD_CHOICE)].map((m) => canonical(m[1])));
    if (bold.size === 1) [verdict, parse] = [[...bold][0], 'bold-choice'];
    else reason = 'the template was copied with no single choice in bold';
  } else {
    const named = new Set(phrases.map((m) => (m[1] ? { saw: 'saw', missed: 'missed' }[m[1].toLowerCase()] : 'unreviewed')));
    if (named.size === 1) verdict = [...named][0];
    else reason = named.size ? `${named.size} different verdicts on one line` : 'no verdict phrase';
  }
  return { verdict: verdict ?? 'unparsed', ...(verdict ? { parse } : { reason }), introducers: refsIn(segment, fixRepo, resolve) };
}

function collect(repo, opts, deps) {
  let rows;
  try {
    rows = JSON.parse(deps.gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(opts.limit), '--json', 'number,title,body,state,mergedAt,createdAt,url']));
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    throw Object.assign(new Error(`gh pr list --repo ${repo} failed: ${stderr || error.message}`), { code: EXIT.ERROR });
  }
  return rows;
}

function indexMeasureLog(text) {
  const index = new Map();
  let unreadable = 0;
  for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
    let row;
    try { row = JSON.parse(line); } catch { unreadable++; continue; }
    if (!row.repo || row.pr == null) { unreadable++; continue; }
    const key = keyOf(row.repo, row.pr);
    const entry = index.get(key) ?? { lensRuns: 0, lenses: new Set(), findings: { p1: 0, p2: 0, p3: 0 }, verdicts: {} };
    index.set(key, entry);
    if (row.verdict) entry.verdicts[row.verdict] = (entry.verdicts[row.verdict] ?? 0) + 1;
    else if (row.p1 !== undefined) {
      entry.lensRuns++;
      entry.lenses.add(row.lens ?? 'unknown');
      for (const p of ['p1', 'p2', 'p3']) entry.findings[p] += row[p] ?? 0;
    }
  }
  return { index, unreadable };
}

/** The log's view of one PR; `lensRuns: 0` is an answer too (the PR had no T1 coverage in the log). */
function measureFor(index, key) {
  const { lenses = new Set(), ...rest } = index.get(key) ?? { lensRuns: 0, findings: { p1: 0, p2: 0, p3: 0 }, verdicts: {} };
  return { ...rest, lenses: [...lenses] };
}

function readRunDocs(dirs, deps, resolve) {
  const runs = [];
  const skipped = [];
  for (const dir of dirs) {
    for (const file of deps.readdir(dir).filter((name) => /^burn-down-session-.*\.md$/.test(name)).sort()) {
      const id = /^burn-down-session-(.+?)(?:-\d{4}-\d{2}-\d{2})?\.md$/.exec(file)[1];
      const table = findTable(deps.read(join(dir, file)));
      if (table.error) { skipped.push({ run: id, file, reason: table.error }); continue; }
      // A row stamp is a full UTC instant (run-log.mjs) or, in the older docs, a bare day:
      // a bare day opens at its 00:00:00Z and closes at its 23:59:59Z.
      const opens = [];
      const closes = [];
      const named = new Set();
      for (const row of table.rows.filter((r) => !r.problem)) {
        const [stamp, item, event, pointers] = splitCells(row.text);
        const at = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.exec(stamp)?.[0];
        if (at) { opens.push(at.length === 10 ? `${at}T00:00:00Z` : at); closes.push(at.length === 10 ? `${at}T23:59:59Z` : at); }
        if (SHIPPED_EVENT.test(event)) for (const ref of refsIn(`${item} ${pointers}`, null, resolve)) if (ref.key) named.add(ref.key);
      }
      if (opens.length === 0) { skipped.push({ run: id, file, reason: 'no row carries a date' }); continue; }
      runs.push({ id, file, from: opens.sort()[0], to: closes.sort().pop(), named });
    }
  }
  return { runs, skipped };
}

/**
 * Which run shipped an introducing PR: a run whose PR/review/closed rows name
 * it AND whose first-to-last row stamps span the instant the PR was created (a
 * later run's row for the fix names the introducer too; the span keeps that row
 * from claiming it). Two runs left is `ambiguous`; none is `unattributed`.
 */
function attribute(ref, meta, runs) {
  if (ref.commit) return { status: 'unattributed', reason: 'a commit, not a PR' };
  if (!ref.key) return { status: 'unattributed', reason: `repo ${JSON.stringify(ref.spelling)} did not resolve` };
  const namedBy = runs.filter((run) => run.named.has(ref.key));
  if (namedBy.length === 0) return { status: 'unattributed', reason: 'no run doc names it' };
  const created = meta.get(ref.key)?.createdAt;
  if (!created) return { status: 'unattributed', reason: 'no PR metadata (repo not in --repo)', namedBy: namedBy.map((run) => run.id) };
  const inSpan = namedBy.filter((run) => run.from <= created && created <= run.to);
  if (inSpan.length === 1) return { status: 'attributed', run: inSpan[0].id };
  if (inSpan.length > 1) return { status: 'ambiguous', runs: inSpan.map((run) => run.id) };
  return { status: 'unattributed', reason: 'named only by runs that were not open when it was created', namedBy: namedBy.map((run) => run.id) };
}

const emptyTally = () => Object.fromEntries(VERDICTS.map((v) => [v, 0]));

export function runEscapeReader(argv, overrides = {}) {
  const deps = { gh, read: (path) => readFileSync(path, 'utf8'), readdir: (dir) => readdirSync(dir), ...overrides };
  try {
    const opts = parseArgs(argv);
    const resolve = repoResolver(opts.repo, opts.aliases);
    const censuses = opts.repo.map((repo) => ({ repo, rows: collect(repo, opts, deps) }));
    const truncated = censuses.filter((c) => c.rows.length >= opts.limit).map((c) => c.repo);
    if (truncated.length > 0) {
      return { exit: EXIT.TRUNCATED, output: { ok: false, error: `${truncated.join(', ')} returned exactly --limit ${opts.limit} PRs, so the census may be short; raise --limit`, truncated } };
    }
    const meta = new Map(censuses.flatMap((c) => c.rows.map((row) => [keyOf(c.repo, row.number), row])));
    const measure = opts['measure-log'] ? indexMeasureLog(deps.read(opts['measure-log'])) : null;
    const runDocs = opts['run-docs'].length > 0 ? readRunDocs(opts['run-docs'], deps, resolve) : null;

    const escapes = [];
    const census = {};
    for (const { repo, rows } of censuses) {
      census[repo] = { prs: rows.length, withEscapeLine: 0 };
      for (const pr of rows.filter((row) => !opts.since || row.createdAt.slice(0, 10) >= opts.since)) {
        const lines = (pr.body ?? '').split(/\r?\n/).filter((line) => /^Escape:/.test(line));
        if (lines.length > 0) census[repo].withEscapeLine++;
        // An identical line repeated in one body is one claim (observatory#808 has two).
        for (const raw of new Set(lines)) {
          const parsed = parseEscapeLine(raw, repo, resolve);
          const introducers = parsed.introducers.map((ref) => ({
            ...ref,
            ...(measure && ref.key ? { measure: measureFor(measure.index, ref.key) } : {}),
            ...(runDocs ? { attribution: attribute(ref, meta, runDocs.runs) } : {}),
          }));
          escapes.push({
            fix: { repo, pr: pr.number, url: pr.url, state: pr.state, mergedAt: pr.mergedAt },
            raw, ...parsed, introducers, repeatedLines: lines.filter((l) => l === raw).length - 1,
          });
        }
      }
    }
    const tally = { overall: emptyTally(), byRepo: {} };
    for (const escape of escapes) {
      tally.overall[escape.verdict]++;
      tally.byRepo[escape.fix.repo] ??= emptyTally();
      tally.byRepo[escape.fix.repo][escape.verdict]++;
    }
    const output = {
      ok: true,
      census,
      tally,
      lines: escapes.length,
      escapes,
      unparsed: escapes.filter((e) => e.verdict === 'unparsed').map((e) => ({ fix: e.fix, reason: e.reason, raw: e.raw })),
    };
    if (measure) output.measureLog = { rowsUnreadable: measure.unreadable };
    if (runDocs) {
      const byRun = {};
      const status = { attributed: 0, ambiguous: 0, unattributed: 0 };
      const seen = new Set();
      for (const escape of escapes) {
        const runsHit = new Set();
        for (const ref of escape.introducers) {
          const id = ref.key ?? `${ref.spelling}@${ref.commit ?? ref.pr}`;
          if (!seen.has(id)) { seen.add(id); status[ref.attribution.status]++; }
          if (ref.attribution.status === 'attributed') runsHit.add(ref.attribution.run);
        }
        for (const run of runsHit) {
          byRun[run] ??= { escapes: 0, introducers: [] };
          byRun[run].escapes++;
          for (const ref of escape.introducers) if (ref.attribution.run === run && !byRun[run].introducers.includes(ref.key)) byRun[run].introducers.push(ref.key);
        }
      }
      output.attribution = { introducers: seen.size, ...status, byRun, runDocs: { read: runDocs.runs.map((r) => r.id), skipped: runDocs.skipped } };
    }
    return { exit: EXIT.OK, output };
  } catch (error) {
    if (error instanceof UsageError) return { exit: EXIT.USAGE, output: { ok: false, error: error.message, usage: USAGE_TEXT } };
    return { exit: EXIT.ERROR, output: { ok: false, error: error.message } };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = runEscapeReader(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exit;
}
