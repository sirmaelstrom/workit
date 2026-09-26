#!/usr/bin/env node
/**
 * The run doc's `## Run log` table, written and checked by one helper. `append`
 * is the sanctioned way to add a row: the date cell comes from the process clock
 * at write time, and no argument sets it. `lint` fails loud on a stamp that is
 * in the future, out of order, unparseable, or later than the commit that last
 * changed its row. One JSON document on stdout per invocation.
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execute } from './lane.mjs';

// The exit contract, aligned with lane.mjs where the meaning is shared:
//   0 ok · 1 infrastructure (read/write/git could not answer)
//   2 usage, refused before any write
//   5 lint failed, the table is empty, or append refused a malformed table or a
//     future-dated last row (nothing written)
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, LINT_FAILED: 5 });
export const RUN_LOG_EXIT_CODES = Object.freeze({ ok: 0, error: 1, usage: 2, lintFailed: 5 });

// reference/templates/run-log.md rule 2, verbatim; run-log.test.mjs holds the
// two in step.
export const EVENTS = Object.freeze(['pickup', 'PR', 'review', 'closed', 'refuted', 'blocked', 'dropped', 'amended', 'run opened', 'rotated', 'run closed']);

export const USAGE_TEXT = `run-log <verb> [options] — one run-doc operation per invocation, JSON on stdout.

  append --doc <abs> --item <text> --event <event> --pointers <text> --teach <text>
         Appends one row as the new last row of the doc's ## Run log table. The
         date cell is the process clock at write time (UTC, ISO 8601, seconds);
         no argument sets it. Events: ${EVENTS.join(' / ')}.
         Refuses (5) a malformed table or a last row stamped later than now.
  lint   --doc <abs>
         Exit 5 naming each row whose stamp is later than now, earlier than the
         row above it, unparseable, or (git-tracked, committed rows) later than
         the commit that last changed the row; each malformed row; each event
         outside the vocabulary. Exit 5 too when the table has no rows.`;

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const FIELDS = ['item', 'event', 'pointers', 'teach'];
const HEADER = Object.freeze(['date', 'item', 'event', 'pointers', 'teach →']);
const LOCK_STALE_MS = 30_000;

class RunLogError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function usage(message) {
  throw new RunLogError(EXIT.USAGE, message);
}

function parseArgs(argv) {
  const [verb, ...tokens] = argv;
  if (!['append', 'lint'].includes(verb)) usage('expected one verb: append, lint');
  const allowed = verb === 'append' ? ['doc', ...FIELDS] : ['doc'];
  const opts = { verb };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const name = token.startsWith('--') ? token.slice(2) : null;
    if (!name || !allowed.includes(name)) usage(`unknown argument for ${verb}: ${token}`);
    if (opts[name] !== undefined) usage(`${token} given twice`);
    const value = tokens[++i];
    if (value === undefined) usage(`${token} needs a value`);
    opts[name] = value;
  }
  for (const name of allowed) if (opts[name] === undefined) usage(`${verb} needs --${name}`);
  if (!isAbsolute(opts.doc)) usage(`--doc must be absolute: ${opts.doc}`);
  return opts;
}

export function formatStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Strict: the helper's own shape only. Built from explicit parts and checked on
// the way back, so 2026-02-30 is refused rather than rolled into March.
export function parseStamp(text) {
  const match = STAMP.exec(String(text).trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return formatStamp(ms) === String(text).trim() ? ms : null;
}

function splitLines(text) {
  const lines = [];
  const eol = /\r?\n/g;
  let start = 0;
  let match;
  while ((match = eol.exec(text))) {
    lines.push({ text: text.slice(start, match.index), start, end: match.index, next: eol.lastIndex, eol: match[0] });
    start = eol.lastIndex;
  }
  lines.push({ text: text.slice(start), start, end: text.length, next: text.length, eol: '' });
  return lines;
}

export function splitCells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// A row is one line with both outer pipes and exactly the five columns. Returns
// why it is not, or null.
export function rowShapeProblem(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('|') || !/(?<!\\)\|$/.test(trimmed)) return 'row is not a | … | table line with both outer pipes';
  const cells = splitCells(trimmed);
  if (cells.length !== 5) return `row has ${cells.length} cells, expected date | item | event | pointers | teach →`;
  return null;
}

// Finds the one `## Run log` table outside fenced code. No section, or two, is a
// wrong --doc (exit 2). A header or separator that is not the five template
// columns is a broken table (exit 5). The table runs to the first blank line or
// heading, and every line inside it is a row: a line that is not a well-formed
// row is reported, never taken as the table's end.
export function findTable(text) {
  const lines = splitLines(text);
  let fence = null;
  const headings = [];
  lines.forEach((line, index) => {
    const marker = FENCE.exec(line.text);
    if (marker && fence === null) {
      fence = marker[1];
      return;
    }
    // A closer carries nothing but whitespace after its marker.
    if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') {
      fence = null;
      return;
    }
    if (fence === null && /^##\s+Run log\b/.test(line.text)) headings.push(index);
  });
  if (headings.length === 0) return { error: 'the doc has no ## Run log section', code: EXIT.USAGE };
  if (headings.length > 1) {
    return { error: `the doc has ${headings.length} ## Run log sections (lines ${headings.map((i) => i + 1).join(', ')})`, code: EXIT.USAGE };
  }
  let header = headings[0] + 1;
  while (header < lines.length && lines[header].text.trim() === '') header++;
  const headerCells = lines[header] && lines[header].text.trim().startsWith('|') ? splitCells(lines[header].text) : null;
  if (!headerCells || headerCells.length !== HEADER.length || headerCells.some((cell, i) => cell !== HEADER[i])) {
    return {
      error: `the ## Run log header (line ${header + 1}) is not | ${HEADER.join(' | ')} |: ${lines[header]?.text.trim() || '<none>'}`,
      code: EXIT.LINT_FAILED,
    };
  }
  const separator = header + 1;
  const separatorCells = lines[separator] ? splitCells(lines[separator].text) : [];
  if (!lines[separator]?.text.trim().startsWith('|') || separatorCells.length !== HEADER.length || !separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return { error: `the ## Run log header (line ${header + 1}) is not followed by a five-column |---| separator`, code: EXIT.LINT_FAILED };
  }
  const rows = [];
  for (let i = separator + 1; i < lines.length; i++) {
    const text = lines[i].text;
    if (!text.trim() || /^ {0,3}#{1,6}(\s|$)/.test(text) || FENCE.test(text)) break;
    rows.push({ ...lines[i], number: i + 1, problem: rowShapeProblem(text) });
  }
  return { lines, header: lines[header], separator: { ...lines[separator], number: separator + 1 }, rows };
}

function cell(name, value) {
  if (/[\r\n]/.test(value)) usage(`--${name} must be one line: a run-log row is one table line`);
  const trimmed = value.trim();
  if (!trimmed) usage(`--${name} is empty; write — if there is nothing to say`);
  return trimmed.replace(/\|/g, '\\|');
}

// Serializes appends across processes: an exclusive lock file beside the doc,
// holding the owner's pid, reclaimed once it is older than any real append.
// A writer that does not take it (an Edit) is not held off by it.
function takeLock(deps, doc) {
  const lock = `${doc}.lock`;
  const receipt = JSON.stringify({ pid: deps.pid, at: formatStamp(deps.now()) });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      deps.writeNew(lock, receipt);
      return () => {
        try {
          if (deps.read(lock) === receipt) deps.remove(lock);
        } catch { /* already gone */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new RunLogError(EXIT.ERROR, `could not take the append lock (${error?.code ?? error?.message}): ${lock}`);
      let holder = '';
      let age = null;
      try {
        holder = String(deps.read(lock)).trim();
        age = deps.now() - Number(deps.stat(lock).mtimeMs);
      } catch { /* released between our write and our read */ }
      if (attempt === 0 && (age === null || age > LOCK_STALE_MS)) {
        try { deps.remove(lock); } catch { /* someone else reclaimed it */ }
        continue;
      }
      throw new RunLogError(EXIT.ERROR, `another append holds ${lock}${holder ? ` (${holder})` : ''}; nothing was written`);
    }
  }
  throw new RunLogError(EXIT.ERROR, `could not take the append lock: ${lock}`);
}

function appendRow(opts, deps) {
  if (!EVENTS.includes(opts.event)) usage(`--event ${JSON.stringify(opts.event)} is outside the vocabulary: ${EVENTS.join(' / ')}`);
  const cells = FIELDS.map((name) => cell(name, opts[name]));
  if (!deps.exists(opts.doc)) usage(`doc does not exist: ${opts.doc}`);
  const release = takeLock(deps, opts.doc);
  try {
    return appendLocked(opts, deps, cells);
  } finally {
    release();
  }
}

function appendLocked(opts, deps, cells) {
  const before = readDoc(deps, opts.doc);
  const table = findTable(before);
  if (table.error) throw new RunLogError(table.code, `${table.error}: ${opts.doc}`);
  const malformed = table.rows.filter((row) => row.problem);
  if (malformed.length > 0) {
    throw new RunLogError(EXIT.LINT_FAILED, `the table has malformed rows, so its last row is unknown; nothing was written: ${malformed.map((row) => `line ${row.number}: ${row.problem}`).join('; ')}`);
  }
  const now = deps.now();
  const lastRow = table.rows.at(-1);
  const lastStamp = lastRow ? parseStamp(splitCells(lastRow.text)[0]) : null;
  if (lastStamp !== null && lastStamp > now) {
    throw new RunLogError(EXIT.LINT_FAILED, `the last row (line ${lastRow.number}, ${formatStamp(lastStamp)}) is stamped later than now (${formatStamp(now)}); a row under it would be out of order, so nothing was written: ${lastRow.text.trim()}`);
  }
  const stamp = formatStamp(now);
  const row = `| ${stamp} | ${cells.join(' | ')} |`;
  const last = table.rows.at(-1) ?? table.separator;
  const eol = last.eol || table.header.eol || '\n';
  // Spliced in as one line: every byte of the doc outside the insertion is
  // untouched, which is what "never rewrites an existing row" means here.
  const after = last.eol
    ? `${before.slice(0, last.next)}${row}${last.eol}${before.slice(last.next)}`
    : `${before.slice(0, last.end)}${eol}${row}${before.slice(last.end)}`;
  // The lock holds off other appends; an unlocked writer (an Edit) that landed
  // since our read would be lost, so refuse. One landing between this re-read
  // and the write is not detected.
  if (readDoc(deps, opts.doc) !== before) {
    throw new RunLogError(EXIT.ERROR, `the doc changed while the row was being built; nothing was written: ${opts.doc}`);
  }
  try {
    deps.write(opts.doc, after);
  } catch (error) {
    throw new RunLogError(EXIT.ERROR, `could not write the doc (${error.code ?? error.message}): ${opts.doc}`);
  }
  return {
    exit: EXIT.OK,
    output: { ok: true, doc: opts.doc, line: (table.rows.at(-1)?.number ?? table.separator.number) + 1, row, stamp },
  };
}

function readDoc(deps, path) {
  try {
    return deps.read(path);
  } catch (error) {
    throw new RunLogError(EXIT.ERROR, `could not read the doc (${error.code ?? error.message}): ${path}`);
  }
}

// Clause (iv) applies only when git can say which commit last changed a row
// (blame's answer: a later edit to the row moves it later, never earlier).
// Not a repository, or an untracked doc, is reported and skipped; a git that
// cannot answer at all is an infrastructure failure, never a silent skip.
function commitTimes(doc, deps) {
  const cwd = dirname(doc);
  const inside = deps.exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) {
    if (/not a git repository/i.test(`${inside.stderr}\n${inside.stdout}`)) return { git: 'not-a-repo', times: new Map() };
    throw new RunLogError(EXIT.ERROR, `git could not answer for ${cwd}: ${(inside.stderr || inside.stdout).trim() || `exit ${inside.code}`}`);
  }
  const tracked = deps.exec('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', basename(doc)]);
  if (tracked.code !== 0) {
    if (/did not match any file/i.test(`${tracked.stderr}\n${tracked.stdout}`)) return { git: 'untracked', times: new Map() };
    throw new RunLogError(EXIT.ERROR, `git ls-files failed for ${doc}: ${(tracked.stderr || tracked.stdout).trim()}`);
  }
  const blame = deps.exec('git', ['-C', cwd, 'blame', '--line-porcelain', '--', basename(doc)]);
  if (blame.code !== 0) throw new RunLogError(EXIT.ERROR, `git blame failed for ${doc}: ${(blame.stderr || blame.stdout).trim()}`);
  const times = new Map();
  let line = null;
  let sha = null;
  for (const text of String(blame.stdout).split(/\r?\n/)) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(text);
    if (header) {
      [, sha] = header;
      line = Number(header[2]);
      continue;
    }
    const committed = /^committer-time (\d+)$/.exec(text);
    // An all-zero sha is a line not yet committed: there is no commit to compare.
    if (committed && line !== null && !/^0+$/.test(sha)) times.set(line, { sha, ms: Number(committed[1]) * 1000 });
  }
  return { git: 'checked', times };
}

function lintDoc(opts, deps) {
  if (!deps.exists(opts.doc)) usage(`doc does not exist: ${opts.doc}`);
  const text = readDoc(deps, opts.doc);
  const table = findTable(text);
  if (table.error) throw new RunLogError(table.code, `${table.error}: ${opts.doc}`);
  const now = deps.now();
  const { git, times } = commitTimes(opts.doc, deps);
  const problems = [];
  let previous = null;
  let committedRowsChecked = 0;
  for (const row of table.rows) {
    const flag = (reason) => problems.push({ line: row.number, reason, row: row.text.trim().slice(0, 200) });
    if (row.problem) {
      flag(`row does not parse: ${row.problem}`);
      continue;
    }
    const cells = splitCells(row.text);
    const stamp = parseStamp(cells[0]);
    if (stamp === null) {
      flag(`stamp ${JSON.stringify(cells[0])} does not parse as YYYY-MM-DDTHH:MM:SSZ`);
    } else {
      if (stamp > now) flag(`stamp ${cells[0]} is later than the lint's clock ${formatStamp(now)}`);
      if (previous && stamp < previous.stamp) {
        flag(`stamp ${cells[0]} is earlier than the row above it (line ${previous.line}, ${formatStamp(previous.stamp)}): lines ${previous.line} and ${row.number} are out of order, and either may be the wrong one`);
      }
      const commit = times.get(row.number);
      if (commit) {
        committedRowsChecked++;
        if (stamp > commit.ms) flag(`stamp ${cells[0]} is later than commit ${commit.sha.slice(0, 7)} that last changed the row (${formatStamp(commit.ms)})`);
      }
      previous = { stamp, line: row.number };
    }
    if (!EVENTS.includes(cells[2])) flag(`event ${JSON.stringify(cells[2])} is outside the vocabulary: ${EVENTS.join(' / ')}`);
  }
  const summary = { doc: opts.doc, rowsChecked: table.rows.length, git, committedRowsChecked, clock: formatStamp(now) };
  if (table.rows.length === 0) {
    return { exit: EXIT.LINT_FAILED, output: { ok: false, ...summary, problems, note: '0 rows checked: the ## Run log table has no rows, which is not a clean log' } };
  }
  if (problems.length > 0) return { exit: EXIT.LINT_FAILED, output: { ok: false, ...summary, problems } };
  return { exit: EXIT.OK, output: { ok: true, ...summary } };
}

export async function runRunLog(argv, overrides = {}) {
  const deps = {
    exec: execute,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, value) => writeFileSync(path, value, 'utf8'),
    writeNew: (path, value) => writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' }),
    remove: (path) => rmSync(path, { force: true }),
    stat: (path) => statSync(path),
    pid: process.pid,
    now: () => Date.now(),
    ...overrides,
  };
  try {
    const opts = parseArgs(argv);
    return opts.verb === 'append' ? appendRow(opts, deps) : lintDoc(opts, deps);
  } catch (error) {
    const code = error instanceof RunLogError ? error.code : EXIT.ERROR;
    return { exit: code, output: { ok: false, error: error.message, ...(code === EXIT.USAGE ? { usage: USAGE_TEXT } : {}) } };
  }
}

async function main() {
  const result = await runRunLog(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exit;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
