// The run analysis (D3): run-analysis.md, written deterministically from
// state.json and the committed events (readEvents, never events.jsonl raw),
// plus one escape-reader run through the executor. No session is spawned;
// the conductor replaces the Recommendations placeholder afterwards.
import { join } from 'node:path';
import { STEP_SEAM, loadState, readEvents } from './state.mjs';

const VERDICT_TEXT = { exercised: 'exercised', vacuous: 'vacuous', 'not-exercised': 'not exercised', 'no-surface': 'no runtime surface', missing: 'missing' };
const SPEC_ROWS = ['spec-depth', 'workshop-scaffold', 'spec-review'];
// Every STEP_SEAM seam (the one `spec` event is cited under three rows), then
// runtime-exercise, which has no step of its own. `touches` and null are not seams.
export const SEAM_ROWS = Object.freeze([...new Set(Object.values(STEP_SEAM))].filter((seam) => seam && seam !== 'touches')
  .flatMap((seam) => (seam === 'spec' ? SPEC_ROWS : [seam])).concat('runtime-exercise'));
// A phase hand-over and a skipped step are not a seam crossed.
const NOT_EVIDENCE = new Set(['phase', 'not-exercised']);

const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
const usd = (n) => `$${Number(n).toFixed(2)}`;

function duration(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Merged PRs of the run, the release's included.
export function mergedPrs(state) {
  const wps = state.wps.filter((wp) => wp.state === 'merged' && wp.pr?.number).map((wp) => ({ id: wp.id, pr: wp.pr.number, wp }));
  const release = state.release?.merge?.sha && state.release.pr?.number ? [{ id: 'release', pr: state.release.pr.number, wp: state.release }] : [];
  return [...wps, ...release];
}

// Every `judgment` adjudication row, with its thread when it has one (D19.9).
export function judgmentThreads(state) {
  return state.wps.flatMap((wp) => (wp.reviews ?? []).flatMap((review) => (review.verdicts ?? []).filter((row) => row.verdict === 'judgment').map((row) => {
    const thread = wp.threadIds?.[row.comment] ?? null;
    return { wpId: wp.id, pr: wp.pr?.number ?? null, comment: row.comment, thread, resolved: Boolean(thread && (review.resolved ?? []).includes(thread)) };
  })));
}

export const judgmentLine = (j) => `${j.wpId} PR #${j.pr} comment ${j.comment}: ${j.thread ? `thread ${j.thread} ${j.resolved ? 'resolved' : 'not resolved'}` : 'no PR thread (council finding)'}`;

function queueAccounting(state) {
  const rows = state.wps.map((wp) => {
    const why = wp.reason ? `: ${wp.reason}` : '';
    const pr = wp.pr?.number ? `, PR #${wp.pr.number}${wp.state === 'held' ? ' open' : ''}` : '';
    return `- ${wp.id} (${wp.name || 'unnamed'}): ${wp.state}${why}${pr}`;
  });
  const r = state.release ?? {};
  const version = r.version ? `, ${r.version.from} → ${r.version.to}` : '';
  return [...rows, `- release: ${r.state}${r.reason ? `: ${r.reason}` : ''}${version}${r.pr?.number ? `, PR #${r.pr.number}` : ''}`];
}

// Counted from the touch-opened events (both modes); the showcase opens after this file.
function touches(state, events) {
  const opened = events.filter((e) => e.event === 'touch-opened');
  const rows = opened.map((e) => {
    const touch = state.touches?.[e.data.n - 1];
    const status = touch?.status === 'answered' ? `answered (${touch.answer?.key})` : touch?.status ?? 'unknown';
    return `- touch ${e.data.n} (${e.data.kind}${touch?.wpId ? `, ${touch.wpId}` : ''}): ${status}`;
  });
  const showcase = opened.find((e) => e.data.kind === 'showcase');
  return [`recorded: ${opened.length}`, ...rows,
    showcase ? `showcase: touch ${showcase.data.n}, counted above` : `showcase: opens after this file (the total at close is ${opened.length + 1})`,
    'Operator-initiated amendments are not counted: no verb records them (v1).'];
}

// Keyed on each event's `seam` field (D19.15): owned when every event came
// from next, by hand when any was recorded --manual, not exercised when none.
function seamCoverage(state, events) {
  return SEAM_ROWS.flatMap((row) => {
    const seam = SPEC_ROWS.includes(row) ? 'spec' : row;
    const evidence = events.filter((e) => e.seam === seam && !NOT_EVIDENCE.has(e.event));
    const cites = [...new Set(evidence.map((e) => e.actionId ?? e.event))];
    let status = !evidence.length ? 'not exercised' : evidence.some((e) => e.source === 'manual') ? 'by hand' : 'owned';
    let cite = cites.join(', ');
    if (row === 'runtime-exercise' && !evidence.length && state.wps.some((wp) => wp.runtimeVerdict)) {
      status = 'owned';
      cite = 'stored verdicts from lane check';
    }
    const skipped = events.filter((e) => e.event === 'not-exercised' && e.seam === seam)
      .map((e) => `  - ${e.data?.step ?? e.step} not exercised${e.data?.wpId ? ` (${e.data.wpId})` : ''}: ${e.data?.reason ?? 'no reason recorded'}`);
    return [`- ${row}: ${status}${cite ? ` (${cite})` : ''}`, ...skipped];
  });
}

function runtimeExercise(state) {
  return state.wps.map((wp) => `- ${wp.id}: ${VERDICT_TEXT[wp.runtimeVerdict] ?? 'missing'} (field: ${wp.runtimeExercise || 'none named'})`);
}

function timeWent(state, events) {
  const label = (e) => `${e.actionId ?? e.event}${e.data?.wpId ? ` ${e.data.wpId}` : ''}`;
  const gaps = events.slice(1).map((e, i) => ({ ms: Date.parse(e.ts) - Date.parse(events[i].ts), from: events[i], to: e }))
    .filter((gap) => gap.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 3);
  const last = events.at(-1)?.ts;
  const perWp = state.wps.map((wp) => {
    const moves = events.filter((e) => e.event === 'wp-state' && e.data?.wpId === wp.id);
    const spent = {};
    moves.forEach((e, i) => {
      const end = moves[i + 1]?.ts ?? last;
      spent[e.data.to] = (spent[e.data.to] ?? 0) + (Date.parse(end) - Date.parse(e.ts));
    });
    const parts = Object.entries(spent).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).map(([to, ms]) => `${to} ${duration(ms)}`);
    return `- ${wp.id}: ${parts.join(', ') || 'no state changes recorded'}`;
  });
  return [...gaps.map((gap) => `- largest gap ${duration(gap.ms)}: ${label(gap.from)} → ${label(gap.to)}`), ...perWp];
}

function catches(state, events) {
  const rows = state.wps.flatMap((wp) => (wp.reviews ?? []).map((review) => {
    const tally = {};
    for (const row of review.verdicts ?? []) tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
    const verdicts = Object.entries(tally).map(([verdict, n]) => `${verdict} ${n}`).join(', ') || 'none adjudicated';
    return `- ${wp.id} round ${review.round} (${review.scope ?? 'full'}, ${review.tier ?? '?'}; ${(review.lenses ?? []).join(' + ') || 'no lens recorded'}): findings ${review.findings ?? 'unknown'}; ${verdicts}`;
  }));
  const adjudicated = events.filter((e) => e.event === 'adjudicated');
  const conductor = adjudicated.flatMap((e) => e.data?.rows ?? []).filter((row) => row.adjudicator === 'conductor').length;
  return [...rows, `- adjudicated events: ${adjudicated.length} (${conductor} conductor row(s))`];
}

// escape-reader takes a date only (scripts/escape-reader.mjs:54): repo-wide
// since the run's start day, with the run's own PRs listed beside it (D19.27).
function escapes(state, exec) {
  const since = String(state.createdAt).slice(0, 10);
  const prs = mergedPrs(state).map((m) => `#${m.pr}`);
  const runPrs = `run PRs: ${prs.join(', ') || 'none merged'}`;
  const read = exec('node', [join(state.pluginRoot, 'scripts', 'escape-reader.mjs'), '--repo', state.intent.repo.remote, '--since', since]);
  let out = null;
  try {
    out = read.code === 0 ? JSON.parse(read.stdout) : null;
  } catch { /* unreadable: not measured */ }
  const tally = out?.ok ? out.tally?.overall : null;
  if (!tally) return [`not measured: escape-reader exit ${read.code}: ${firstLine(read.stderr) || firstLine(read.stdout)}`, runPrs];
  return [`repo-wide since ${since}: saw ${tally.saw}, missed ${tally.missed}, unreviewed ${tally.unreviewed}, unparsed ${tally.unparsed} (${out.lines} Escape lines)`,
    runPrs, 'Run-scoped attribution is a follow-up.'];
}

function preapproval(state) {
  const a = state.authority ?? {};
  const out = [`- authority: merge ${a.merge ? 'yes' : 'no'}, release ${a.release ? 'yes' : 'no'}, budget ${usd(a.budgetUsd ?? 0)}, scope: ${a.scope}`];
  if (a.grant) out.push(`- grant: ${a.grant}; the operator's text, verbatim: ${JSON.stringify(a.notes ?? '')}`);
  const merges = mergedPrs(state);
  out.push(`- merges: ${merges.length}`);
  for (const m of merges) {
    const gate = m.wp.gate ?? {};
    out.push(`  - ${m.id} PR #${m.pr} → ${m.wp.merge.sha}: head ${gate.head ?? '?'}, gate ${gate.ok ? 'ok (CI green, no unresolved threads)' : `not ok: ${(gate.failures ?? []).join('; ')}`}, unreviewedTail ${gate.unreviewedTail ?? 'none'}`);
  }
  const judgments = judgmentThreads(state);
  out.push(`- judgment threads: ${judgments.length}`, ...judgments.map((j) => `  - ${judgmentLine(j)}`));
  if (a.metered) {
    const reading = (state.touches ?? []).filter((touch) => typeof touch.spendUsd === 'number').at(-1);
    out.push(`- budget: metered by the spend adapter; spend reading: ${reading ? `${usd(reading.spendUsd)} (touch ${reading.n})` : 'none stored by the build'}`);
  } else {
    const lower = state.wps.reduce((sum, wp) => sum + (Number(wp.lane?.costUsd) || 0), 0);
    out.push(`- budget: unmetered; lane-only lower bound ${usd(lower)} (exec claude lanes' total_cost_usd; codex and herdr lanes not counted)`);
  }
  return out;
}

export async function analyzeRun(runDir, deps) {
  const state = loadState(runDir, deps);
  const events = readEvents(runDir, deps, state);
  const sections = [
    ['Queue accounting', queueAccounting(state)],
    ['Touches', touches(state, events)],
    ['Seam coverage', seamCoverage(state, events)],
    ['Runtime exercise', runtimeExercise(state)],
    ['Where the time went', timeWent(state, events)],
    ['Catches by watcher position', catches(state, events)],
    ['Escapes', escapes(state, deps.exec)],
    ['Pre-approval audit', preapproval(state)],
    ['Recommendations', ['_The conductor replaces this line with at most five recommendations._']],
  ];
  const text = [`# Run analysis: conduct ${state.slug}`, '', `Run dir: ${runDir}. Goal: ${state.intent.goal}`, '',
    ...sections.flatMap(([title, lines]) => [`## ${title}`, '', ...lines, ''])].join('\n');
  const path = join(runDir, 'run-analysis.md');
  deps.write(path, text);
  return { ok: true, path };
}
