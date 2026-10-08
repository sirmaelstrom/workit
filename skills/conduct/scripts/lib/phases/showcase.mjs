// Phase showcase: touch 2 (D4). (a) accept or (b) accept with notes closes the
// run; (c) send back ends it as `sent-back`, terminal like `closed` (D19.5):
// nothing re-runs, and merged work and the release are never touched again.
import { join } from 'node:path';
import { ConductError, STEP_SEAM, TOUCH_SEAM, appendEvent } from '../state.mjs';
import { judgmentThreads, mergedPrs } from '../analyze.mjs';
import { QUESTION_MAX, filedLength, openTouch, recordTouch, touchAction } from '../touch.mjs';

// The seams an answer may name: the STEP_SEAM seams (not TOUCH_SEAM), the
// runtime-exercise row, and the analysis's three spec rows, which mean `spec`.
const ALIASES = { 'spec-depth': 'spec', 'workshop-scaffold': 'spec', 'spec-review': 'spec' };
const SEAMS = [...new Set(Object.values(STEP_SEAM))].filter((seam) => seam && seam !== TOUCH_SEAM).concat('runtime-exercise');
const NAMES = [...SEAMS, ...Object.keys(ALIASES)];
const canonical = (name) => ALIASES[name] ?? name;

// An explicit `seam: <token>` decides alone: its whole token (a trailing . , ;
// is punctuation) must be an accepted name, else null. Without it, a seam
// only when the text names exactly one distinct accepted seam; otherwise null.
export function namedSeam(text) {
  const words = String(text ?? '');
  const explicit = /\bseam:\s*(\S+)/i.exec(words);
  if (explicit) {
    const token = explicit[1].replace(/[.,;]+$/, '').toLowerCase();
    return NAMES.includes(token) ? canonical(token) : null;
  }
  const named = new Set(NAMES.filter((name) => new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`, 'i').test(words)).map(canonical));
  return named.size === 1 ? [...named][0] : null;
}

// ---- the briefing ----

// The operator answers the showcase from its question alone (in the Dogan), so
// the question leads with the conductor's briefing: what was delivered, the
// proof it works, what did not happen, the one thing to check, and the
// recommended answer. The conductor writes it before the touch is filed.
export const BRIEF_FIELDS = ['delivered', 'proof', 'notDone', 'check', 'why'];
export const BRIEF_FIELD_MAX = 200;
// Up to this many unfinished WPs are named in notDone; above it, their count is.
const NAMED_MAX = 6;
const briefPath = (state) => join(state.runDir, 'showcase-brief.json');
const unfinished = (state) => state.wps.filter((wp) => ['refuted', 'blocked', 'held', 'deferred'].includes(wp.state));

function briefAction(state) {
  const outPath = briefPath(state);
  const stopped = unfinished(state).map((wp) => `${wp.id} (${wp.state}: ${wp.reason ?? 'no reason recorded'})`);
  return {
    kind: 'author', step: 'showcase-brief', outPath, expects: { type: 'file' },
    instruction: `Before the showcase is filed, write ${outPath}. The operator answers from this briefing alone, in the Dogan, so it carries your judgment in plain words, not process vocabulary. JSON: { "delivered": "<what now exists that did not before>", "proof": "<the runtime evidence that it works: the command and what it showed, quoted from a lane report's ## Runtime exercise; or why there is none>", "notDone": "<what the goal asked that did not happen, and why${stopped.length > NAMED_MAX ? `; say that ${stopped.length} WPs did not finish` : stopped.length ? `; name every one of ${unfinished(state).map((wp) => wp.id).join(', ')}` : '; \\"nothing\\" when everything landed'}>", "check": "<the one thing worth checking yourself, and where>", "recommend": "a" | "b" | "c", "why": "<one sentence: why that answer>" }. Each text field is one or two sentences, at most ${BRIEF_FIELD_MAX} characters. (a) accept, (b) accept with notes, (c) send back. Sources: ${join(state.runDir, 'run-analysis.md')}, each WP's report and PR.${stopped.length ? ` Not finished: ${stopped.join('; ')}.` : ''} Record {}.`,
  };
}

// Reads and checks the briefing; every unfinished WP is named in notDone.
export function readBrief(state, deps) {
  const path = briefPath(state);
  if (!deps.exists(path)) throw new ConductError(2, `the showcase briefing ${path} was not written`);
  let brief;
  try {
    brief = JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `the showcase briefing ${path} is not valid JSON: ${error.message}`);
  }
  const problems = [];
  for (const field of BRIEF_FIELDS) {
    const value = brief?.[field];
    if (typeof value !== 'string' || !value.trim()) problems.push(`${field} is empty`);
    else if (value.length > BRIEF_FIELD_MAX) problems.push(`${field} is ${value.length} characters (at most ${BRIEF_FIELD_MAX})`);
  }
  if (!OPTIONS.some((option) => option.key === brief?.recommend)) problems.push('recommend must be "a", "b" or "c"');
  const stopped = unfinished(state);
  const notDone = String(brief?.notDone ?? '');
  if (stopped.length > NAMED_MAX) {
    if (!new RegExp(`\\b${stopped.length} WPs\\b`).test(notDone)) problems.push(`notDone does not say "${stopped.length} WPs" did not finish`);
  } else {
    // A whole-word id: WP-01 is not named by WP-010.
    const missing = stopped.filter((wp) => !new RegExp(`(^|[^\\w-])${wp.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(notDone)).map((wp) => wp.id);
    if (missing.length) problems.push(`notDone does not name ${missing.join(', ')}, which did not finish`);
  }
  if (problems.length) throw new ConductError(2, `the showcase briefing ${path}: ${problems.join('; ')}`);
  return Object.fromEntries([...BRIEF_FIELDS, 'recommend'].map((field) => [field, brief[field].trim()]));
}

function question(state) {
  const url = (n) => `https://github.com/${state.intent.repo.remote}/pull/${n}`;
  const list = (items, empty) => (items.length ? items.join('; ') : empty);
  const held = state.wps.filter((wp) => wp.state === 'held');
  const deferred = state.wps.filter((wp) => wp.state === 'deferred');
  const stopped = state.wps.filter((wp) => ['refuted', 'blocked'].includes(wp.state));
  const open = (state.touches ?? []).filter((touch) => touch.kind === 'blocked' && touch.status !== 'answered');
  const r = state.release ?? {};
  const analysis = join(state.runDir, 'run-analysis.md');
  const judgments = judgmentThreads(state).length;
  const merged = mergedPrs(state);
  // The analysis's Queue accounting lists every WP with its state, reason and
  // PR. With a briefing, its full path is given once (the DO line) and the
  // lists name the file alone, so the status lines fit under the cap.
  const file = state.showcaseBrief ? 'run-analysis.md' : analysis;
  const accounting = `under Queue accounting in ${file}`;
  // Each list, in full or (when the question would overrun the cap) by count and where it is listed.
  const lists = [
    { label: 'Merged PRs', items: merged.map((m) => `${m.id} ${url(m.pr)}`), where: `under the audit in ${file}` },
    { label: 'Open PRs of held WPs', items: held.map((wp) => `${wp.id} ${wp.pr?.number ? url(wp.pr.number) : '(no PR)'} (${wp.reason ?? 'held'})`), where: accounting },
    { label: 'Deferred WPs', items: deferred.map((wp) => `${wp.id}: ${wp.reason ?? 'no reason recorded'}`), where: accounting },
    { label: 'Refuted or blocked WPs', items: stopped.map((wp) => `${wp.id} ${wp.state}: ${wp.reason ?? 'no reason recorded'}${wp.pr?.number ? ` (${url(wp.pr.number)})` : ''}`), where: accounting },
  ];
  const line = (entry, cited) => `${entry.label}: ${!entry.items.length ? 'none' : cited ? `${entry.items.length}, each listed ${entry.where}` : list(entry.items, 'none')}`;
  const brief = state.showcaseBrief;
  // The briefing and the answer come first: the cap cuts from the end.
  const head = brief ? [
    `Recommended: (${brief.recommend}) ${OPTIONS.find((option) => option.key === brief.recommend).label}. ${brief.why}`,
    `Delivered: ${brief.delivered}`,
    `Proof it works: ${brief.proof}`,
    `Not done: ${brief.notDone}`,
    `Check yourself: ${brief.check}`,
    `DO: answer (a) accept, (b) accept with notes, or (c) send back with \`seam: <name>\` in your text (one of ${SEAMS.join(', ')}). EXPECT: (a) and (b) close the run, (b) storing your notes verbatim; (c) ends it sent-back, nothing re-runs, and a new /conduct run citing this run's folder reopens the work. Full record: ${analysis}.`,
  ] : [
    `DO: read ${analysis} first, then the merged PRs, then the deliverable (${state.intent.repo.path}, ${state.intent.repo.remote} at origin/${state.intent.repo.defaultBranch ?? 'main'}), and accept, accept with notes, or send back conductor run ${state.slug}. EXPECT: (a) the run closes; (b) the run closes with your notes stored verbatim; (c) the run ends as sent-back: write \`seam: <name>\` (one of ${SEAMS.join(', ')}) in your text; nothing re-runs and merged work and the release are not touched; reopening is a new /conduct run whose goal cites ${state.runDir}.`,
  ];
  const lines = (cited) => [
    ...head,
    ...lists.map((entry, i) => line(entry, i < cited)),
    // Cited by count and file: the list, one line per thread, is what overran spine_receipt's cap.
    `Judgment threads the conductor resolved: ${judgments ? `${judgments}, each listed under the audit in ${file}` : 'none'}`,
    `Blocked touches still open: ${list(open.map((touch) => `touch ${touch.n}${touch.wpId ? ` (${touch.wpId})` : ''}`), 'none')}`,
    `Release: ${r.state}${r.reason ? ` (${r.reason})` : ''}${r.pr?.number ? ` ${url(r.pr.number)}` : ''}`,
  ].join('\n');
  // Lists are cited by count, in order, until the question fits; whatever still
  // overruns (a very long repo path or reason) is cut at the cap, pointing at the analysis.
  const n = (state.touches ?? []).length + 1;
  for (let cited = 0; cited <= lists.length; cited += 1) {
    const text = lines(cited);
    if (filedLength(state, n, text) <= QUESTION_MAX) return text;
  }
  const cut = `… (cut at spine_receipt's cap; read ${analysis})`;
  const text = lines(lists.length);
  return `${text.slice(0, text.length - (filedLength(state, n, text) - QUESTION_MAX) - cut.length)}${cut}`;
}

const OPTIONS = [
  { key: 'a', label: 'Accept', consequence: 'The run closes.' },
  { key: 'b', label: 'Accept with notes', consequence: 'Type your notes; they are stored verbatim and the run closes.' },
  { key: 'c', label: 'Send back', consequence: 'Write seam: <name>; the run ends as sent-back and a new /conduct run reopens the work.' },
];

const showcaseTouch = (state) => (state.touches ?? []).find((touch) => touch.kind === 'showcase');

// The recommended option says so on its button.
const options = (state) => OPTIONS.map((option) => (option.key === state.showcaseBrief?.recommend ? { ...option, label: `${option.label} (recommended)` } : option));

export function next(state, deps) {
  const filed = showcaseTouch(state);
  if (!filed && !state.showcaseBrief) return briefAction(state);
  const touch = filed ?? openTouch(state, {
    kind: 'showcase', question: question(state), options: options(state), allowFreeText: true, did: `conduct ${state.slug}: built, released and analyzed`,
  }, deps);
  if (touch.status === 'answered') return apply(state, touch, deps);
  // One filed touch at a time (spine): a touch filed earlier is read back first.
  const spec = touchAction(state, touch) ?? touchAction(state, state.touches.find((other) => other !== touch && other.status === 'filed'));
  if (!spec) throw new ConductError(2, `the showcase touch ${touch.n} has no action to emit`);
  return spec;
}

function apply(state, touch, deps) {
  const { key, text } = touch.answer;
  if (key === 'c') {
    state.sentBack = { seam: namedSeam(text), text: text ?? null };
    state.phase = 'sent-back';
  } else state.phase = 'closed';
  appendEvent(state, deps, { step: 'showcase', event: 'showcase-answered', data: { n: touch.n, key, ...(key === 'c' ? { sentBack: state.sentBack } : {}) } });
  return null;
}

export function record(state, action, result, deps) {
  if (action.step === 'showcase-brief') {
    state.showcaseBrief = readBrief(state, deps);
    appendEvent(state, deps, { step: 'showcase-brief', event: 'showcase-briefed', data: { recommend: state.showcaseBrief.recommend } });
    return undefined;
  }
  const touch = state.touches[action.touch.n - 1];
  const outcome = recordTouch(state, touch, action, result);
  if (touch.kind === 'showcase' && touch.status === 'answered') apply(state, touch, deps);
  return outcome;
}
