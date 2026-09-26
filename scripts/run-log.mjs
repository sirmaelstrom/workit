#!/usr/bin/env node
/**
 * The run doc's `## Run log` table, written and checked by one helper. `append`
 * is the sanctioned way to add a row: the date cell comes from the process clock
 * at write time, and no argument sets it. `lint` fails loud on a stamp that is
 * in the future, out of order, unparseable, or later than the commit that
 * introduced its row. One JSON document on stdout per invocation.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execute } from './lane.mjs';

// The exit contract, aligned with lane.mjs where the meaning is shared:
//   0 ok · 1 infrastructure (read/write/git could not answer)
//   2 usage, refused before any write · 5 lint failed, or the table is empty
const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, LINT_FAILED: 5 });
export const RUN_LOG_EXIT_CODES = Object.freeze({ ok: 0, error: 1, usage: 2, lintFailed: 5 });

// reference/templates/run-log.md rule 2, verbatim; run-log.test.mjs holds the
// two in step.
export const EVENTS = Object.freeze(['pickup', 'PR', 'review', 'closed', 'blocked', 'dropped', 'amended', 'run opened', 'run closed']);

export const USAGE_TEXT = `run-log <verb> [options] — one run-doc operation per invocation, JSON on stdout.

  append --doc <abs> --item <text> --event <event> --pointers <text> --teach <text>
         Appends one row as the new last row of the doc's ## Run log table. The
         date cell is the process clock at write time (UTC, ISO 8601, seconds);
         no argument sets it. Events: ${EVENTS.join(' / ')}.
  lint   --doc <abs>
         Exit 5 naming each row whose stamp is later than now, earlier than the
         row above it, unparseable, or (git-tracked, committed rows) later than
         the commit that introduced the row. Exit 5 too when the table has no rows.`;

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const FIELDS = ['item', 'event', 'pointers', 'teach'];

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

// Finds the one `## Run log` table outside fenced code. A doc with none, with
// two, or whose heading is not followed by the table header is refused: every
// one of those is a wrong --doc or a hand-broken table, not an empty log.
export function findTable(text) {
  const lines = splitLines(text);
  let fence = null;
  const headings = [];
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    if (marker && (fence === null || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) {
      fence = fence === null ? marker[1] : null;
      return;
    }
    if (fence === null && /^##\s+Run log\b/.test(line.text)) headings.push(index);
  });
  if (headings.length === 0) return { error: 'the doc has no ## Run log section' };
  if (headings.length > 1) return { error: `the doc has ${headings.length} ## Run log sections (lines ${headings.map((i) => i + 1).join(', ')})` };
  let header = headings[0] + 1;
  while (header < lines.length && lines[header].text.trim() === '') header++;
  const headerCells = lines[header] && lines[header].text.trim().startsWith('|') ? splitCells(lines[header].text) : null;
  if (!headerCells || headerCells[0].toLowerCase() !== 'date') {
    return { error: `## Run log (line ${headings[0] + 1}) is not followed by its | date | item | event | pointers | teach → | header` };
  }
  const separator = header + 1;
  if (!lines[separator] || !/^\s*\|\s*:?-{3,}/.test(lines[separator].text)) {
    return { error: `the ## Run log table header (line ${header + 1}) has no |---| separator under it` };
  }
  const rows = [];
  for (let i = separator + 1; i < lines.length && lines[i].text.trim().startsWith('|'); i++) rows.push({ ...lines[i], number: i + 1 });
  return { lines, header: lines[header], separator: { ...lines[separator], number: separator + 1 }, rows };
}

function cell(name, value) {
  if (/[\r\n]/.test(value)) usage(`--${name} must be one line: a run-log row is one table line`);
  const trimmed = value.trim();
  if (!trimmed) usage(`--${name} is empty; write — if there is nothing to say`);
  return trimmed.replace(/\|/g, '\\|');
}

function appendRow(opts, deps) {
  if (!EVENTS.includes(opts.event)) usage(`--event ${JSON.stringify(opts.event)} is outside the vocabulary: ${EVENTS.join(' / ')}`);
  const cells = FIELDS.map((name) => cell(name, opts[name]));
  if (!deps.exists(opts.doc)) usage(`doc does not exist: ${opts.doc}`);
  const before = readDoc(deps, opts.doc);
  const table = findTable(before);
  if (table.error) usage(`${table.error}: ${opts.doc}`);
  const stamp = formatStamp(deps.now());
  const row = `| ${stamp} | ${cells.join(' | ')} |`;
  const last = table.rows.at(-1) ?? table.separator;
  const eol = last.eol || table.header.eol || '\n';
  // Spliced in as one line: every byte of the doc outside the insertion is
  // untouched, which is what "never rewrites an existing row" means here.
  const after = last.eol
    ? `${before.slice(0, last.next)}${row}${last.eol}${before.slice(last.next)}`
    : `${before.slice(0, last.end)}${eol}${row}${before.slice(last.end)}`;
  // Someone else's write between our read and ours would be lost: refuse it.
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

// Clause (iv) applies only when git can say which commit introduced a row.
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
  if (table.error) usage(`${table.error}: ${opts.doc}`);
  const now = deps.now();
  const { git, times } = commitTimes(opts.doc, deps);
  const problems = [];
  let previous = null;
  let committedRowsChecked = 0;
  for (const row of table.rows) {
    const flag = (reason) => problems.push({ line: row.number, reason, row: row.text.trim().slice(0, 200) });
    const cells = splitCells(row.text);
    if (cells.length !== 5) {
      flag(`row does not parse: ${cells.length} cells, expected date | item | event | pointers | teach →`);
      continue;
    }
    const stamp = parseStamp(cells[0]);
    if (stamp === null) {
      flag(`stamp ${JSON.stringify(cells[0])} does not parse as YYYY-MM-DDTHH:MM:SSZ`);
    } else {
      if (stamp > now) flag(`stamp ${cells[0]} is later than the lint's clock ${formatStamp(now)}`);
      if (previous && stamp < previous.stamp) flag(`stamp ${cells[0]} is earlier than the row above it (line ${previous.line}, ${formatStamp(previous.stamp)})`);
      const commit = times.get(row.number);
      if (commit) {
        committedRowsChecked++;
        if (stamp > commit.ms) flag(`stamp ${cells[0]} is later than commit ${commit.sha.slice(0, 7)} that introduced the row (${formatStamp(commit.ms)})`);
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
