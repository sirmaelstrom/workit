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
  const lines = (mergedLine) => [
    `DO: read ${analysis} first, then the merged PRs, then the deliverable (${state.intent.repo.path}, ${state.intent.repo.remote} at origin/${state.intent.repo.defaultBranch ?? 'main'}), and accept, accept with notes, or send back conductor run ${state.slug}. EXPECT: (a) the run closes; (b) the run closes with your notes stored verbatim; (c) the run ends as sent-back: write \`seam: <name>\` (one of ${SEAMS.join(', ')}) in your text; nothing re-runs and merged work and the release are not touched; reopening is a new /conduct run whose goal cites ${state.runDir}.`,
    mergedLine,
    `Open PRs of held WPs: ${list(held.map((wp) => `${wp.id} ${wp.pr?.number ? url(wp.pr.number) : '(no PR)'} (${wp.reason ?? 'held'})`), 'none')}`,
    `Deferred WPs: ${list(deferred.map((wp) => `${wp.id}: ${wp.reason ?? 'no reason recorded'}`), 'none')}`,
    `Refuted or blocked WPs: ${list(stopped.map((wp) => `${wp.id} ${wp.state}: ${wp.reason ?? 'no reason recorded'}${wp.pr?.number ? ` (${url(wp.pr.number)})` : ''}`), 'none')}`,
    // Cited by count and file: the list, one line per thread, is what overran spine_receipt's cap.
    `Judgment threads the conductor resolved: ${judgments ? `${judgments}, each listed under the audit in ${analysis}` : 'none'}`,
    `Blocked touches still open: ${list(open.map((touch) => `touch ${touch.n}${touch.wpId ? ` (${touch.wpId})` : ''}`), 'none')}`,
    `Release: ${r.state}${r.reason ? ` (${r.reason})` : ''}${r.pr?.number ? ` ${url(r.pr.number)}` : ''}`,
  ].join('\n');
  const full = lines(`Merged PRs: ${list(merged.map((m) => `${m.id} ${url(m.pr)}`), 'none')}`);
  // Many merged PRs can overrun the cap too: then they are cited the same way.
  if (filedLength(state, (state.touches ?? []).length + 1, full) <= QUESTION_MAX) return full;
  return lines(`Merged PRs: ${merged.length}, each listed under the audit in ${analysis}`);
}

const OPTIONS = [
  { key: 'a', label: 'Accept', consequence: 'The run closes.' },
  { key: 'b', label: 'Accept with notes', consequence: 'Type your notes; they are stored verbatim and the run closes.' },
  { key: 'c', label: 'Send back', consequence: 'Write seam: <name>; the run ends as sent-back and a new /conduct run reopens the work.' },
];

const showcaseTouch = (state) => (state.touches ?? []).find((touch) => touch.kind === 'showcase');

export function next(state, deps) {
  const touch = showcaseTouch(state) ?? openTouch(state, {
    kind: 'showcase', question: question(state), options: OPTIONS, allowFreeText: true, did: `conduct ${state.slug}: built, released and analyzed`,
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
  const touch = state.touches[action.touch.n - 1];
  const outcome = recordTouch(state, touch, action, result);
  if (touch.kind === 'showcase' && touch.status === 'answered') apply(state, touch, deps);
  return outcome;
}
