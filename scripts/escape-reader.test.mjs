import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ESCAPE_READER_EXIT_CODES, parseEscapeLine, repoResolver, runEscapeReader, stampBounds } from './escape-reader.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/escape-reader/', import.meta.url));
const RUN_DOCS = `${FIXTURES}run-docs`;
const MEASURE = `${FIXTURES}measure.jsonl`;

// ---------------------------------------------------------------------------
// The parser, on the live strings (copied from the real PR bodies, 2026-10-04)
// ---------------------------------------------------------------------------

const OBS = 'heathdev-me/observatory';
const FCA = 'sirmaelstrom/family-coordination-app';
const WORKIT = 'sirmaelstrom/workit';
const LIVE_REPOS = [OBS, 'heathdev-me/dogan', WORKIT, FCA];
const ALIASES = new Map([['heathdev-observatory', OBS]]);
const resolve = repoResolver(LIVE_REPOS, ALIASES);
const parse = (raw, fixRepo = OBS) => parseEscapeLine(raw, fixRepo, resolve);
const keys = (parsed) => parsed.introducers.map((ref) => ref.key);

test('parser: the five repo spellings resolve to owner/name', () => {
  assert.deepEqual(keys(parse('Escape: introduced by heathdev-me/observatory#806; review saw it')), ['heathdev-me/observatory#806']);
  assert.deepEqual(keys(parse('Escape: introduced by observatory#795; review saw it')), ['heathdev-me/observatory#795']);
  assert.deepEqual(keys(parse('Escape: introduced by heathdev-observatory#790; review saw it')), ['heathdev-me/observatory#790']);
  assert.deepEqual(keys(parse('Escape: introduced by dogan#256; review missed it', 'heathdev-me/dogan')), ['heathdev-me/dogan#256']);
  assert.deepEqual(keys(parse('Escape: introduced by sirmaelstrom/family-coordination-app#51; review saw it', FCA)), [`${FCA}#51`]);
  assert.deepEqual(keys(parse('Escape: introduced by workit#54; review saw it', WORKIT)), [`${WORKIT}#54`]);
});

test('parser: a spelling nothing names is left unresolved, never guessed', () => {
  const bare = parseEscapeLine('Escape: introduced by heathdev-observatory#790; review saw it', OBS, repoResolver(LIVE_REPOS, new Map()));
  assert.equal(bare.introducers[0].repo, null);
  assert.equal(bare.introducers[0].key, undefined);
  assert.equal(bare.introducers[0].spelling, 'heathdev-observatory');
});

test('parser: two introducers split, and a trailing "and #n" joins the list', () => {
  const two = parse('Escape: introduced by observatory#526 (the 30 s budget) and observatory#667 (no explicit budget); review missed it. #526 had 3 reviews and 4 inline comments, #667 had 6 reviews and 10 inline comments.');
  assert.deepEqual(keys(two), ['heathdev-me/observatory#526', 'heathdev-me/observatory#667']);
  assert.equal(two.verdict, 'missed');
  const three = parse("Escape: introduced by workit#54 (first-match pane lookup) and workit#63 (byPath before the pane lookup), and workit#98 (resolveTarget's sidecar-first lookup); review missed it. #98's 24 line comments include none on a stale record.", WORKIT);
  assert.deepEqual(keys(three), [`${WORKIT}#54`, `${WORKIT}#63`, `${WORKIT}#98`]);
});

test('parser: a bare #n inherits the previous introducer\'s repo', () => {
  const parsed = parse('Escape: introduced by sirmaelstrom/family-coordination-app#51 (meal-plan `DateTime.Today`) and #54 (dashboard `DateTime.Today`); unreviewed. Both PRs have zero reviews and zero review comments (`gh pr view <n> --json reviews`, `gh api …/pulls/<n>/comments`).', FCA);
  assert.deepEqual(keys(parsed), [`${FCA}#51`, `${FCA}#54`]);
  assert.equal(parsed.verdict, 'unreviewed');
  // Parsed as if the fix PR lived in another repo, so "previous introducer's repo" and
  // "the fix PR's repo" differ: the boundary the inheritance rule is about.
  assert.deepEqual(keys(parse('Escape: introduced by sirmaelstrom/family-coordination-app#51 and #54; unreviewed', WORKIT)), [`${FCA}#51`, `${FCA}#54`]);
  // Before any named repo, a bare #n takes the fixing PR's own repo.
  assert.deepEqual(keys(parse('Escape: introduced by #12; review saw it', WORKIT)), [`${WORKIT}#12`]);
});

test('parser: a commit introducer carries the sha, no PR key', () => {
  const parsed = parse('Escape: introduced by heathdev-me/observatory 8709d1e (direct commit, no PR); review unreviewed');
  assert.deepEqual(parsed.introducers, [{ repo: OBS, spelling: OBS, commit: '8709d1e' }]);
  assert.equal(parsed.verdict, 'unreviewed');
});

test('parser: the verdict without the word "review", with a trailing period', () => {
  const parsed = parse('Escape: introduced by heathdev-me/observatory#258; unreviewed. #258 has no GitHub review threads. #437 built the per-type split on the same false "per-turn" premise, and its one review didn\'t raise it.');
  assert.equal(parsed.verdict, 'unreviewed');
  assert.deepEqual(keys(parsed), ['heathdev-me/observatory#258']);
});

test('parser: the template copied unfilled takes the choice in bold, and says so', () => {
  const parsed = parse('Escape: introduced by workit#128; review saw it | **missed it** | unreviewed. The owner resolution is #128\'s: its codex/astra threads on `resolveTarget` (4161600192) covered stale-record session lending, not a nameless owner.', WORKIT);
  assert.equal(parsed.verdict, 'missed');
  assert.equal(parsed.parse, 'bold-choice');
  assert.deepEqual(keys(parsed), [`${WORKIT}#128`]);
});

test('parser: whichever of the three choices is in bold is the verdict, first choice included', () => {
  const cases = [
    ['Escape: introduced by workit#128; review **saw it** | missed it | unreviewed', 'saw'],
    ['Escape: introduced by workit#128; **review saw it** | missed it | unreviewed', 'saw'],
    ['Escape: introduced by workit#128; review saw it | **missed it** | unreviewed', 'missed'],
    ['Escape: introduced by workit#128; review saw it | missed it | **unreviewed**', 'unreviewed'],
  ];
  for (const [raw, verdict] of cases) {
    const parsed = parse(raw, WORKIT);
    assert.deepEqual([parsed.verdict, parsed.parse], [verdict, 'bold-choice'], raw);
    assert.deepEqual(keys(parsed), [`${WORKIT}#128`]);
  }
});

test('parser: distinct unresolved references stay distinct; the same one twice is one', () => {
  const two = parse('Escape: introduced by ghost#1 and ghost#2; review missed it');
  assert.deepEqual(two.introducers.map((ref) => ref.pr), [1, 2]);
  assert.deepEqual(parse('Escape: introduced by ghost#1 and ghost#1; review missed it').introducers.map((ref) => ref.pr), [1]);
  assert.deepEqual(parse('Escape: introduced by ghost#7 and phantom#7; review missed it').introducers.map((ref) => ref.spelling), ['ghost', 'phantom']);
  // A bare #n inheriting an unresolved repo inherits its spelling too, so the two #2s stay distinct.
  const bare = parse('Escape: introduced by ghost#1 and #2, phantom#1 and #2; review missed it');
  assert.deepEqual(bare.introducers.map((ref) => [ref.spelling, ref.pr]), [['ghost', 1], ['ghost', 2], ['phantom', 1], ['phantom', 2]]);
  const commits = parse('Escape: introduced by heathdev-me/observatory 8709d1e and heathdev-me/observatory 1a2b3c4d; review unreviewed');
  assert.deepEqual(commits.introducers.map((ref) => ref.commit), ['8709d1e', '1a2b3c4d']);
});

test('parser: the template copied with nothing (or two things) in bold is unparsed', () => {
  for (const raw of [
    'Escape: introduced by workit#128; review saw it | missed it | unreviewed',
    'Escape: introduced by workit#128; review saw it | **missed it** | **unreviewed**',
  ]) {
    const parsed = parse(raw, WORKIT);
    assert.equal(parsed.verdict, 'unparsed', raw);
    assert.match(parsed.reason, /no single choice in bold/);
  }
});

test('parser: two different verdicts on one line is unparsed, not first-wins', () => {
  const raw = "Escape: introduced by workit#54 (the one-poll settle, the stderr passthrough and the first-match `sweep --lane` resolution all date to the original helper); unreviewed (#54 has no GitHub review threads). d4480b68's basename scoping came from workit#58: review saw it (T2 synthesis item 7, deferred as not required to land #58).";
  const parsed = parse(raw, WORKIT);
  assert.equal(parsed.verdict, 'unparsed');
  assert.match(parsed.reason, /2 different verdicts/);
  assert.deepEqual(keys(parsed), [`${WORKIT}#54`], 'the introducers before the first verdict are still listed');
});

test('parser: a verdict with parenthetical detail and a line with no verdict', () => {
  const saw = parse('Escape: introduced by heathdev-me/observatory#759; review saw it (round-two comment 4114028423, unadjudicated before merge)');
  assert.equal(saw.verdict, 'saw');
  const none = parse('Escape: something went wrong somewhere');
  assert.equal(none.verdict, 'unparsed');
  assert.match(none.reason, /no verdict phrase/);
  assert.deepEqual(none.introducers, []);
});

// ---------------------------------------------------------------------------
// The collector, on a fake gh
// ---------------------------------------------------------------------------

const AT = '2026-10-03T10:00:00Z';
const pr = (number, createdAt, body = '') => ({ number, title: `PR ${number}`, body, state: 'MERGED', mergedAt: createdAt, createdAt, url: `https://example.test/${number}` });

const APP = [
  pr(10, '2026-10-01T11:00:00Z'),
  pr(11, '2026-10-01T17:00:00Z'),
  pr(12, '2026-10-01T12:00:00Z'),
  pr(13, '2026-10-01T13:00:00Z'),
  pr(14, '2026-09-01T09:00:00Z'),
  pr(15, '2026-09-15T09:00:00Z'),
  pr(16, '2026-09-01T09:00:00Z'),
  pr(30, AT, 'Fixes it.\nEscape: introduced by app#10; review saw it\n'),
  pr(31, AT, 'Escape: introduced by app#11 and #12; review missed it'),
  pr(32, AT, 'Escape: introduced by app#13; unreviewed.'),
  pr(33, AT, 'Escape: introduced by app#15; review missed it'),
  pr(34, AT, 'We looked, and there is no Escape: line here, the word is mid-line.'),
  { ...pr(35, AT), body: null },
  pr(36, AT, 'Escape: introduced by acme/app 1a2b3c4d5e (direct commit, no PR); review unreviewed'),
  pr(37, AT, 'Escape: something went wrong somewhere'),
  pr(41, AT, 'Escape: introduced by app#14; review saw it'),
  pr(42, '2026-10-05T10:00:00Z', 'Escape: introduced by ghost#3; review missed it'),
  pr(43, AT, 'Escape: introduced by app#10; review saw it\nEscape: introduced by app#10; review saw it'),
  pr(44, AT, 'Escape: introduced by app#16; review missed it'),
  // An open fix PR is pending, a closed-unmerged one is neither tallied nor listed.
  { ...pr(45, AT, 'Escape: introduced by app#10; review saw it'), state: 'OPEN', mergedAt: null },
  { ...pr(46, AT, 'Escape: introduced by app#10; review saw it'), state: 'CLOSED', mergedAt: null },
  // Introducers whose merge, not their creation, decides the run: #17 never merged; #18 was created
  // inside r1 and merged after every run closed.
  { ...pr(17, '2026-10-01T15:00:00Z'), state: 'OPEN', mergedAt: null },
  { ...pr(18, '2026-10-01T15:30:00Z'), mergedAt: '2026-10-03T00:00:00Z' },
  pr(47, AT, 'Escape: introduced by app#17; review missed it'),
  pr(48, AT, 'Escape: introduced by app#18; review missed it'),
];
const LIB = [
  // Created the day before r1 opened, merged inside it.
  { ...pr(5, '2026-09-30T09:00:00Z'), mergedAt: '2026-10-01T14:20:00Z' },
  pr(40, AT, 'Summary\r\nEscape: introduced by lib#5; review missed it\r\n'),
];

/** Like the real gh: honors --limit, and records every call so a test can show it only listed PRs. */
function fakeGh(byRepo) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const repo = args[args.indexOf('--repo') + 1];
    if (!(repo in byRepo)) throw Object.assign(new Error('Command failed'), { stderr: `GraphQL: Could not resolve to a Repository with the name '${repo}'.` });
    return JSON.stringify(byRepo[repo].slice(0, Number(args[args.indexOf('--limit') + 1])));
  };
  gh.calls = calls;
  return gh;
}

const BASE = ['--repo', 'acme/app', '--repo', 'acme/lib'];
const FULL = [...BASE, '--measure-log', MEASURE, '--run-docs', RUN_DOCS];
const read = (argv, repos = { 'acme/app': APP, 'acme/lib': LIB }) => {
  const gh = fakeGh(repos);
  const result = runEscapeReader(argv, { gh });
  return { ...result, gh };
};
const escapeFor = (output, repo, number) => output.escapes.filter((e) => e.fix.repo === repo && e.fix.pr === number);

test('collect: only a line that starts with `Escape:` counts; a mid-line mention, a null body and a CRLF body are handled', () => {
  const { exit, output } = read(BASE);
  assert.equal(exit, 0, JSON.stringify(output));
  assert.deepEqual(output.census['acme/app'], { prs: APP.length, withEscapeLine: 14, pending: 1, closedUnmerged: 1 });
  assert.deepEqual(output.census['acme/lib'], { prs: LIB.length, withEscapeLine: 1, pending: 0, closedUnmerged: 0 });
  assert.equal(escapeFor(output, 'acme/app', 34).length, 0, 'the mid-line "Escape:" is not counted');
  assert.equal(escapeFor(output, 'acme/app', 35).length, 0);
  assert.equal(escapeFor(output, 'acme/lib', 40)[0].verdict, 'missed', 'CRLF line endings do not hide the line');
});

test('collect: read-only — every gh call is `pr list` for a --repo', () => {
  const { gh } = read(BASE);
  assert.equal(gh.calls.length, 2);
  for (const args of gh.calls) assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
});

test('collect: an identical line repeated in one body is one claim, and says it was repeated', () => {
  const [escape, ...rest] = escapeFor(read(BASE).output, 'acme/app', 43);
  assert.equal(rest.length, 0);
  assert.equal(escape.repeatedLines, 1);
});

test('tally: overall and per repo, unparsed counted and listed with its raw line', () => {
  const { output } = read(BASE);
  assert.deepEqual(output.tally.overall, { saw: 3, missed: 7, unreviewed: 2, unparsed: 1 });
  assert.deepEqual(output.tally.byRepo['acme/app'], { saw: 3, missed: 6, unreviewed: 2, unparsed: 1 });
  assert.deepEqual(output.tally.byRepo['acme/lib'], { saw: 0, missed: 1, unreviewed: 0, unparsed: 0 });
  assert.equal(output.lines, 13);
  assert.equal(output.unparsed.length, 1);
  assert.equal(output.unparsed[0].raw, 'Escape: something went wrong somewhere');
  assert.equal(output.unparsed[0].fix.pr, 37);
});

test('collect: --since limits the fix PRs read, not the introducer metadata', () => {
  const { output } = read([...FULL, '--since', '2026-10-04']);
  assert.deepEqual(output.escapes.map((e) => e.fix.pr), [42]);
  assert.equal(output.census['acme/app'].prs, APP.length, 'the census still lists every PR');
  const { output: all } = read([...FULL, '--since', '2026-10-01']);
  assert.equal(all.lines, 13);
  assert.equal(escapeFor(all, 'acme/app', 30)[0].introducers[0].attribution.run, 'r1', 'a pre-window introducer keeps its metadata');
});

test('truncation: a repo that returns exactly --limit PRs is a non-zero exit with no tallies, not a short census', () => {
  const cut = read([...BASE, '--limit', String(APP.length)]);
  assert.equal(cut.exit, ESCAPE_READER_EXIT_CODES.TRUNCATED);
  assert.equal(cut.output.ok, false);
  assert.deepEqual(cut.output.truncated, ['acme/app']);
  assert.equal(cut.output.tally, undefined);
  const room = read([...BASE, '--limit', String(APP.length + 1)]);
  assert.equal(room.exit, 0, 'one row of headroom shows the census is whole');
});

// ---------------------------------------------------------------------------
// The measure-log join
// ---------------------------------------------------------------------------

test('join: an introducer with lens rows reports them; one without reports lensRuns 0', () => {
  const { output } = read(FULL);
  const covered = escapeFor(output, 'acme/app', 30)[0].introducers[0].measure;
  assert.deepEqual(covered, { lensRuns: 2, findings: { p1: 1, p2: 2, p3: 1 }, verdicts: { confirmed: 1, refuted: 1 }, lenses: ['codex', 'astra'] });
  const bare = escapeFor(output, 'acme/app', 32)[0].introducers[0].measure;
  assert.deepEqual(bare, { lensRuns: 0, findings: { p1: 0, p2: 0, p3: 0 }, verdicts: {}, lenses: [] });
  assert.equal(escapeFor(output, 'acme/app', 36)[0].introducers[0].measure, undefined, 'a commit has no PR rows to join');
  assert.deepEqual(output.measureLog, { rowsUnreadable: 0 });
});

test('join: absent --measure-log, no measure field at all (not an empty one)', () => {
  const { output } = read(BASE);
  assert.equal(escapeFor(output, 'acme/app', 30)[0].introducers[0].measure, undefined);
});

// ---------------------------------------------------------------------------
// Run attribution
// ---------------------------------------------------------------------------

const attribution = (output, pr, index = 0) => escapeFor(output, 'acme/app', pr)[0].introducers[index].attribution;

test('attribution: a PR a run\'s PR row names is that run\'s', () => {
  const { output } = read(FULL);
  assert.deepEqual(attribution(output, 30), { status: 'attributed', run: 'r1' });
  assert.deepEqual(escapeFor(output, 'acme/lib', 40)[0].introducers[0].attribution, { status: 'attributed', run: 'r1' }, 'an owner/name#n spelling in a closed row');
});

test('attribution: a PR no run names is unattributed — a pickup row and a bare #n do not name it', () => {
  const { output } = read(FULL);
  assert.deepEqual(attribution(output, 32), { status: 'unattributed', reason: 'no run doc names it' });
});

test('attribution: a commit, and a spelling that resolves to no repo, are unattributed with a reason', () => {
  const { output } = read(FULL);
  assert.deepEqual(attribution(output, 36), { status: 'unattributed', reason: 'a commit, not a PR' });
  assert.deepEqual(attribution(output, 42), { status: 'unattributed', reason: 'repo "ghost" did not resolve' });
});

test('attribution: named in two run docs — the span of the run open when the PR was created decides', () => {
  const { output } = read(FULL);
  // app#12 (created 12:00) is named by r1 and r2; r2 opened at 16:00.
  assert.deepEqual(attribution(output, 31, 1), { status: 'attributed', run: 'r1' });
  // app#14 is named by r2 and by the bare-day doc; only the day doc was open on 09-01.
  assert.deepEqual(attribution(output, 41), { status: 'attributed', run: 'day' });
});

test('attribution: named in two run docs that were both open — ambiguous, credited to neither run', () => {
  const { output } = read(FULL);
  // app#11 (created 17:10) falls inside r1 (10:00-18:00) and r2 (16:00-09:00 next day).
  assert.deepEqual(attribution(output, 31, 0), { status: 'ambiguous', runs: ['r1', 'r2'] });
  assert.deepEqual(output.attribution.byRun.r2, undefined);
});

test('attribution: a run that names the PR but was not open when it merged does not claim it', () => {
  const { output } = read(FULL);
  // app#15 (merged 09-15) is named only by r2, in the fix row for it.
  assert.deepEqual(attribution(output, 33), { status: 'unattributed', reason: 'named only by runs that were not open when it merged', namedBy: ['r2'] });
});

test('attribution: the merge decides — created before the run but merged in it is the run\'s; created in it but merged after is not; never merged is no run\'s', () => {
  const { output } = read(FULL);
  assert.deepEqual(escapeFor(output, 'acme/lib', 40)[0].introducers[0].attribution, { status: 'attributed', run: 'r1' }, 'lib#5: created 09-30, merged 10-01T14:20 inside r1');
  assert.deepEqual(attribution(output, 48), { status: 'unattributed', reason: 'named only by runs that were not open when it merged', namedBy: ['r1'] }, 'app#18: created inside r1, merged 10-03');
  assert.deepEqual(attribution(output, 47), { status: 'unattributed', reason: 'not merged', namedBy: ['r1'] }, 'app#17: r1 has a "draft app#17" PR row, the PR never merged');
});

test('tally: an open fix PR is pending, not an escape that landed; a closed-unmerged one is in neither', () => {
  const { output } = read(FULL);
  assert.deepEqual(output.pending, [{ fix: { repo: 'acme/app', pr: 45, url: 'https://example.test/45' }, raw: 'Escape: introduced by app#10; review saw it' }]);
  assert.equal(output.escapes.filter((e) => [45, 46].includes(e.fix.pr)).length, 0);
  assert.equal(output.tally.overall.saw, 3, 'saw lines: #30, #41, #43 only');
  assert.equal(output.attribution.byRun.r1.escapes, 4, 'app#10 is credited by fix PRs 30 and 43, not by the open #45 or the closed #46');
});

test('attribution: per-run counts, the fraction attributable, and the run docs that could not be read', () => {
  const { output } = read(FULL);
  const { byRun, runDocs, ...counts } = output.attribution;
  // r1: fix PRs 30, 31 and 43 (app#10, app#12) and lib 40 (lib#5). Fix 31's other introducer, app#11, is ambiguous.
  assert.deepEqual(byRun, { r1: { escapes: 4, introducers: ['acme/app#10', 'acme/app#12', 'acme/lib#5'] }, day: { escapes: 2, introducers: ['acme/app#14', 'acme/app#16'] } });
  // Distinct introducers: app#10 #11 #12 #13 #14 #15 #16 #17 #18, lib#5, the commit, ghost#3.
  assert.deepEqual(counts, { introducers: 12, attributed: 5, ambiguous: 1, unattributed: 6 });
  assert.deepEqual(runDocs.read, ['day', 'r1', 'r2']);
  assert.equal(runDocs.skipped.length, 1);
  assert.equal(runDocs.skipped[0].run, 'old');
  assert.match(runDocs.skipped[0].reason, /header/);
});

test('attribution: every run-doc stamp shape the live docs use gives a span, and a year-less one takes the file name\'s year', () => {
  assert.deepEqual(stampBounds('2026-10-04T01:26:00Z', '2026'), ['2026-10-04T01:26:00Z', '2026-10-04T01:26:00Z']);
  assert.deepEqual(stampBounds('2026-09-19 15:12:16Z', '2026'), ['2026-09-19T15:12:16Z', '2026-09-19T15:12:16Z']);
  assert.deepEqual(stampBounds('2026-09-22T19:14Z', '2026'), ['2026-09-22T19:14:00Z', '2026-09-22T19:14:59Z']);
  assert.deepEqual(stampBounds('2026-09-04 08:58Z', undefined), ['2026-09-04T08:58:00Z', '2026-09-04T08:58:59Z']);
  assert.deepEqual(stampBounds('2026-08-30', undefined), ['2026-08-30T00:00:00Z', '2026-08-30T23:59:59Z']);
  assert.deepEqual(stampBounds('09-24 02:58Z', '2026'), ['2026-09-24T02:58:00Z', '2026-09-24T02:58:59Z']);
  assert.equal(stampBounds('09-24 02:58Z', undefined), null, 'no year anywhere: no span, so the doc is skipped rather than dated by a guess');
  assert.equal(stampBounds('run opened', '2026'), null);
});

test('attribution: a repo outside --repo has no metadata, so a name is not enough', () => {
  const { output } = read(['--repo', 'acme/app', '--run-docs', RUN_DOCS]);
  assert.deepEqual(escapeFor(output, 'acme/app', 41)[0].introducers[0].attribution, { status: 'attributed', run: 'day' });
  const lib = read(['--repo', 'acme/lib', '--repo', 'acme/app', '--run-docs', RUN_DOCS], { 'acme/app': APP, 'acme/lib': LIB.filter((p) => p.number !== 5) });
  assert.equal(escapeFor(lib.output, 'acme/lib', 40)[0].introducers[0].attribution.reason, 'no PR metadata (repo not in --repo)');
});

// ---------------------------------------------------------------------------
// Arguments and failures
// ---------------------------------------------------------------------------

test('usage: no --repo, an unknown flag, a bad --since or --limit, a bad alias are exit 2 with the usage text', () => {
  for (const argv of [[], ['--bogus'], [...BASE, '--since', '10/04/2026'], [...BASE, '--limit', '0'], [...BASE, '--alias', 'nope'], ['--repo', 'noslash'], [...BASE, '--since']]) {
    const { exit, output } = read(argv);
    assert.equal(exit, ESCAPE_READER_EXIT_CODES.USAGE, JSON.stringify(argv));
    assert.equal(output.ok, false);
    assert.match(output.usage, /escape-reader --repo/);
  }
});

test('infrastructure: a gh failure is exit 1 naming the repo and gh\'s own stderr', () => {
  const { exit, output } = read(['--repo', 'acme/missing'], { 'acme/app': APP });
  assert.equal(exit, ESCAPE_READER_EXIT_CODES.ERROR);
  assert.match(output.error, /acme\/missing failed: GraphQL: Could not resolve/);
});

test('infrastructure: an --alias the run docs use (obs=) reaches the run-row spellings', () => {
  const { output } = read([...BASE, '--run-docs', RUN_DOCS, '--alias', 'obs=acme/app']);
  const names = output.attribution.runDocs.read;
  assert.ok(names.includes('r1'));
  // r1's `obs#999` row now resolves to acme/app#999, a PR that is not in the census: it names no escape.
  assert.deepEqual(attribution(output, 30), { status: 'attributed', run: 'r1' });
});
