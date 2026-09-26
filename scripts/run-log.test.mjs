import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execute } from './lane.mjs';
import { EVENTS, RUN_LOG_EXIT_CODES, findTable, formatStamp, parseStamp, runRunLog } from './run-log.mjs';

const TEMPLATE = fileURLToPath(new URL('../reference/templates/run-log.md', import.meta.url));
const T0 = Date.UTC(2026, 8, 26, 16, 0, 0);
const HOUR = 3_600_000;

const HEAD = [
  '# Burn-down Session Q', '',
  '## Run rulings', '(none)', '',
  '## Run log (append-only; one row per stop)',
  '| date | item | event | pointers | teach → |',
  '|---|---|---|---|---|',
];
const TAIL = ['', '## Run close (written once, at the operator\'s close call)', '- Queue accounting:', ''];

function row(stamp, event = 'pickup', item = 'Q-1') {
  return `| ${stamp} | ${item} | ${event} | pointer | — |`;
}

function doc(t, rows, { eol = '\n', head = HEAD, tail = TAIL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-run-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'burn-down-session-q.md');
  writeFileSync(path, [...head, ...rows, ...tail].join(eol), 'utf8');
  return { dir, path };
}

// Git is not the subject of most tests; this one says "no repository here".
const NO_GIT = () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

const append = (path, fields = {}, deps = {}) => runRunLog([
  'append', '--doc', path,
  '--item', fields.item ?? 'Q-2', '--event', fields.event ?? 'PR', '--pointers', fields.pointers ?? '#12', '--teach', fields.teach ?? '—',
], { exec: NO_GIT, ...deps });
const lint = (path, deps = {}) => runRunLog(['lint', '--doc', path], { exec: NO_GIT, ...deps });

test('207dbaf1: the event vocabulary is the run-log template\'s rule 2, verbatim', () => {
  const template = readFileSync(TEMPLATE, 'utf8');
  const line = template.split(/\r?\n/).find((text) => text.includes('Event vocabulary:'));
  const listed = /Event vocabulary: `([^`]+)`/.exec(line)[1].split(' / ');
  assert.deepEqual(listed, [...EVENTS]);
});

test('207dbaf1: the exit table', () => {
  assert.deepEqual(RUN_LOG_EXIT_CODES, { ok: 0, error: 1, usage: 2, lintFailed: 5 });
});

test('207dbaf1 / C1: append stamps the row from the clock and splices it in as the new last row', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z')]);
  const before = readFileSync(path, 'utf8');
  const result = await append(path, { pointers: 'a | b' }, { now: () => T0 + 1_234 });
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.equal(result.output.stamp, '2026-09-26T16:00:01Z');
  const after = readFileSync(path, 'utf8');
  const expected = `| 2026-09-26T16:00:01Z | Q-2 | PR | a \\| b | — |`;
  assert.equal(result.output.row, expected);
  assert.equal(after, before.replace(`${row('2026-09-26T15:00:00Z')}\n`, `${row('2026-09-26T15:00:00Z')}\n${expected}\n`));
  assert.equal(after.split('\n')[result.output.line - 1], expected);
});

test('207dbaf1: append into an empty table, a CRLF doc, and a table that ends the file', async (t) => {
  const empty = doc(t, []);
  assert.equal((await append(empty.path, {}, { now: () => T0 })).exit, 0);
  assert.match(readFileSync(empty.path, 'utf8'), /\|---\|---\|---\|---\|---\|\n\| 2026-09-26T16:00:00Z \| Q-2 \| PR \| #12 \| — \|\n\n## Run close/);

  const crlf = doc(t, [row('2026-09-26T15:00:00Z')], { eol: '\r\n' });
  const crlfBefore = readFileSync(crlf.path, 'utf8');
  await append(crlf.path, {}, { now: () => T0 });
  const crlfAfter = readFileSync(crlf.path, 'utf8');
  assert.equal(crlfAfter.length, crlfBefore.length + '| 2026-09-26T16:00:00Z | Q-2 | PR | #12 | — |\r\n'.length);
  assert.equal(crlfAfter.includes('\n') && !/[^\r]\n/.test(crlfAfter), true, 'every line ending stays CRLF');

  const last = doc(t, [row('2026-09-26T15:00:00Z')], { tail: [] });
  await append(last.path, {}, { now: () => T0 });
  assert.match(readFileSync(last.path, 'utf8'), /15:00:00Z \| Q-1 \| pickup \| pointer \| — \|\n\| 2026-09-26T16:00:00Z/);
});

test('207dbaf1: append refuses a stamp argument, an event outside the vocabulary, a multi-line or empty cell', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z')]);
  const before = readFileSync(path, 'utf8');
  for (const flag of ['--date', '--stamp', '--at']) {
    const result = await runRunLog(['append', '--doc', path, '--item', 'x', '--event', 'PR', '--pointers', 'p', '--teach', 't', flag, '2030-01-01T00:00:00Z'], { exec: NO_GIT });
    assert.equal(result.exit, 2, `${flag} is refused`);
    assert.match(result.output.error, /unknown argument/);
  }
  const offVocabulary = await append(path, { event: 'landed' });
  assert.equal(offVocabulary.exit, 2);
  assert.match(offVocabulary.output.error, /outside the vocabulary/);
  assert.equal((await append(path, { teach: 'one\ntwo' })).exit, 2);
  assert.equal((await append(path, { item: '   ' })).exit, 2);
  assert.equal((await runRunLog(['append', '--doc', 'relative.md', '--item', 'x', '--event', 'PR', '--pointers', 'p', '--teach', 't'])).exit, 2);
  assert.equal(readFileSync(path, 'utf8'), before, 'no refusal writes');
});

test('207dbaf1: append refuses a doc with no table, two tables, or a table only inside a code fence', async (t) => {
  const none = doc(t, [], { head: ['# Q', '', '## Run rulings'], tail: [''] });
  assert.match((await append(none.path)).output.error, /no ## Run log section/);
  const two = doc(t, [row('2026-09-26T15:00:00Z'), '', ...HEAD.slice(-3)]);
  assert.match((await append(two.path)).output.error, /2 ## Run log sections/);
  const fenced = doc(t, [row('2026-09-26T15:00:00Z'), '```'], { head: ['# Q', '```markdown', ...HEAD.slice(-3)] });
  assert.match((await append(fenced.path)).output.error, /no ## Run log section/);
  assert.equal(findTable(readFileSync(TEMPLATE, 'utf8')).error, 'the doc has no ## Run log section', 'the template\'s skeleton is fenced');
});

test('207dbaf1: append refuses when the doc changes between its read and its write', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z')]);
  let reads = 0;
  const read = (target) => {
    reads++;
    const text = readFileSync(target, 'utf8');
    return reads === 2 ? `${text}\nsomeone else's edit` : text;
  };
  const result = await append(path, {}, { now: () => T0, read });
  assert.equal(result.exit, 1);
  assert.match(result.output.error, /changed while/);
});

test('207dbaf1 / C2: lint names a future row, an out-of-order row, and an unparseable one; a clean doc exits 0 with its count', async (t) => {
  const future = doc(t, [row('2026-09-26T15:00:00Z'), row(formatStamp(T0 + HOUR), 'PR', 'Q-future')]);
  const red = await lint(future.path, { now: () => T0 });
  assert.equal(red.exit, 5);
  assert.equal(red.output.problems.length, 1);
  assert.equal(red.output.problems[0].line, 10);
  assert.match(red.output.problems[0].reason, /later than the lint's clock/);
  assert.match(red.output.problems[0].row, /Q-future/);

  const backwards = doc(t, [row('2026-09-26T15:30:00Z'), row('2026-09-26T15:10:00Z', 'PR', 'Q-back')]);
  const back = await lint(backwards.path, { now: () => T0 });
  assert.equal(back.exit, 5);
  assert.match(back.output.problems[0].reason, /earlier than the row above it \(line 9/);
  assert.match(back.output.problems[0].row, /Q-back/);

  const garbled = doc(t, [row('09-26 15:00Z'), row('2026-02-30T10:00:00Z'), '| 2026-09-26T15:00:00Z | only | three |']);
  const bad = await lint(garbled.path, { now: () => T0 });
  assert.deepEqual(bad.output.problems.map((problem) => problem.line), [9, 10, 11]);

  const clean = doc(t, [row('2026-09-26T15:00:00Z', 'run opened', 'run'), row('2026-09-26T15:00:00Z'), row('2026-09-26T15:59:59Z', 'closed')]);
  const green = await lint(clean.path, { now: () => T0 });
  assert.equal(green.exit, 0, JSON.stringify(green.output));
  assert.equal(green.output.rowsChecked, 3);
  assert.equal(green.output.git, 'not-a-repo');
});

test('207dbaf1: lint names an event outside the vocabulary', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z', 'chain to launcher')]);
  const result = await lint(path, { now: () => T0 });
  assert.equal(result.exit, 5);
  assert.match(result.output.problems[0].reason, /event "chain to launcher" is outside the vocabulary/);
});

test('207dbaf1: a lint that saw zero rows says so and is not clean', async (t) => {
  const { path } = doc(t, []);
  const result = await lint(path, { now: () => T0 });
  assert.equal(result.exit, 5);
  assert.equal(result.output.rowsChecked, 0);
  assert.match(result.output.note, /0 rows checked/);
});

test('207dbaf1: a git that cannot answer is an infrastructure failure, not a skipped clause', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z')]);
  const result = await lint(path, { now: () => T0, exec: () => ({ code: 1, stdout: '', stderr: 'spawnSync git ENOENT' }) });
  assert.equal(result.exit, 1);
  assert.match(result.output.error, /git could not answer/);
});

function git(dir, args, env = {}) {
  return execFileSync('git', ['-c', 'user.name=lane', '-c', 'user.email=lane@example.invalid', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

test('207dbaf1: lint compares a committed row\'s stamp with the commit that last changed it', async (t) => {
  const { dir, path } = doc(t, [row('2026-09-01T12:00:00Z'), row('2026-09-02T12:00:00Z', 'PR', 'Q-after-commit')]);
  git(dir, ['init', '-q']);
  git(dir, ['add', '--', 'burn-down-session-q.md']);
  const at = '2026-09-02T00:00:00Z';
  git(dir, ['commit', '-q', '-m', 'rows'], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });

  const red = await lint(path, { now: () => T0, exec: execute });
  assert.equal(red.output.git, 'checked');
  assert.equal(red.output.committedRowsChecked, 2);
  assert.equal(red.exit, 5, JSON.stringify(red.output));
  assert.equal(red.output.problems.length, 1);
  assert.equal(red.output.problems[0].line, 10);
  assert.match(red.output.problems[0].reason, /later than commit [0-9a-f]{7} that last changed the row \(2026-09-02T00:00:00Z\)/);

  // A row not yet committed has no commit to compare against, so only (i)–(iii) apply.
  await append(path, {}, { now: () => T0, exec: execute });
  const pending = await lint(path, { now: () => T0 + 1_000, exec: execute });
  assert.equal(pending.output.rowsChecked, 3);
  assert.equal(pending.output.committedRowsChecked, 2);

  const untracked = join(dir, 'other.md');
  writeFileSync(untracked, readFileSync(path, 'utf8'), 'utf8');
  const skipped = await lint(untracked, { now: () => T0 + 1_000, exec: execute });
  assert.equal(skipped.output.git, 'untracked');
});

test('207dbaf1 amend-1 / item 1: a refuted item has its own event', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z')]);
  assert.equal((await append(path, { event: 'refuted' }, { now: () => T0 })).exit, 0);
  assert.equal((await lint(path, { now: () => T0 })).exit, 0);
});

test('207dbaf1 amend-1 / item 3: a row without its outer pipes is a malformed row, never the table\'s end', async (t) => {
  const hidden = [row('2026-09-26T15:00:00Z'), row(formatStamp(T0 + HOUR), 'PR', 'Q-hidden').slice(1), row(formatStamp(T0 + 2 * HOUR), 'review', 'Q-after')];
  const { path } = doc(t, hidden);
  const red = await lint(path, { now: () => T0 });
  assert.equal(red.exit, 5);
  assert.equal(red.output.rowsChecked, 3, 'every line of the table is counted');
  assert.deepEqual(red.output.problems.map((problem) => problem.line), [10, 11]);
  assert.match(red.output.problems[0].reason, /row does not parse: row is not a \| … \| table line with both outer pipes/);
  assert.match(red.output.problems[1].reason, /later than the lint's clock/);

  const before = readFileSync(path, 'utf8');
  const refused = await append(path, {}, { now: () => T0 });
  assert.equal(refused.exit, 5);
  assert.match(refused.output.error, /malformed rows, so its last row is unknown; nothing was written: line 10/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('207dbaf1 amend-1 / item 8: a header or separator that is not the five template columns is exit 5 naming the header', async (t) => {
  const two = doc(t, ['| 2026-09-26T15:00:00Z | x |'], { head: ['# Q', '', '## Run log', '| date | item |', '|---|---|'] });
  const before = readFileSync(two.path, 'utf8');
  const refused = await append(two.path, {}, { now: () => T0 });
  assert.equal(refused.exit, 5);
  assert.match(refused.output.error, /the ## Run log header \(line 4\) is not \| date \| item \| event \| pointers \| teach → \|: \| date \| item \|/);
  assert.equal(readFileSync(two.path, 'utf8'), before, 'nothing written');
  assert.equal((await lint(two.path, { now: () => T0 })).exit, 5);

  const shortSeparator = doc(t, [row('2026-09-26T15:00:00Z')], { head: ['# Q', '', '## Run log', HEAD.at(-2), '|---|---|'] });
  assert.match((await lint(shortSeparator.path, { now: () => T0 })).output.error, /not followed by a five-column \|---\| separator/);
});

test('207dbaf1 amend-1 / item 9: append refuses to build on a last row stamped later than now', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z'), row('2026-09-26T16:30:00Z', 'PR', 'Q-projected')]);
  const before = readFileSync(path, 'utf8');
  const refused = await append(path, {}, { now: () => T0 });
  assert.equal(refused.exit, 5);
  assert.match(refused.output.error, /the last row \(line 10, 2026-09-26T16:30:00Z\) is stamped later than now \(2026-09-26T16:00:00Z\).*Q-projected/);
  assert.equal(readFileSync(path, 'utf8'), before);

  const later = await lint(path, { now: () => T0 + 2 * HOUR });
  assert.equal(later.exit, 0, 'once the clock passes it the row is only a projection nobody can see, which is why append refuses at write time');
});

test('207dbaf1 amend-1: the order message names both rows', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:30:00Z'), row('2026-09-26T15:10:00Z')]);
  const result = await lint(path, { now: () => T0 });
  assert.match(result.output.problems[0].reason, /lines 9 and 10 are out of order, and either may be the wrong one/);
});

test('207dbaf1 amend-1 / item 4: a held append lock is exit 1 naming its holder; a stale one is reclaimed; the lock is released', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z')]);
  const before = readFileSync(path, 'utf8');
  writeFileSync(`${path}.lock`, '{"pid":4242,"at":"2026-09-26T15:59:50Z"}', 'utf8');
  const held = await append(path, {}, { now: () => Date.now() });
  assert.equal(held.exit, 1);
  assert.match(held.output.error, /another append holds .*\.lock \(\{"pid":4242/);
  assert.equal(readFileSync(path, 'utf8'), before, 'nothing written');

  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old);
  const reclaimed = await append(path, {}, { now: () => Date.now() });
  assert.equal(reclaimed.exit, 0, JSON.stringify(reclaimed.output));
  assert.equal(existsSync(`${path}.lock`), false, 'released after the append');

  const failing = await append(path, {}, { now: () => Date.now(), write: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
  assert.equal(failing.exit, 1);
  assert.equal(existsSync(`${path}.lock`), false, 'released when the write fails too');
});

test('207dbaf1 amend-1 / item 6: a fence closer carries only whitespace', async (t) => {
  const { path } = doc(t, [row('2026-09-26T15:00:00Z'), '```'], { head: ['# Q', '```', '```markdown', ...HEAD.slice(-3)] });
  assert.match((await append(path)).output.error, /no ## Run log section/, '```markdown inside an open fence is content, not a closer');
});

test('207dbaf1: stamps are strict ISO 8601 UTC seconds', () => {
  assert.equal(parseStamp('2026-09-26T16:46:24Z'), Date.UTC(2026, 8, 26, 16, 46, 24));
  for (const text of ['2026-09-26T16:46Z', '2026-09-26 16:46:24Z', '2026-09-26T16:46:24.000Z', '09-26 16:46Z', '2026-13-01T00:00:00Z']) {
    assert.equal(parseStamp(text), null, text);
  }
});
