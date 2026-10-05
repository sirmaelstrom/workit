// Phase showcase: touch 2 (D4). (a) accept or (b) accept with notes closes the
// run; (c) send back ends it as `sent-back`, terminal like `closed` (D19.5):
// nothing re-runs, and merged work and the release are never touched again.
import { join } from 'node:path';
import { ConductError, STEP_SEAM, appendEvent } from '../state.mjs';
import { judgmentLine, judgmentThreads, mergedPrs } from '../analyze.mjs';
import { openTouch, recordTouch, touchAction } from '../touch.mjs';

const SEAMS = [...new Set(Object.values(STEP_SEAM))].filter(Boolean);

// The STEP_SEAM value the operator's text names first, or null.
export function namedSeam(text) {
  const at = SEAMS.map((seam) => ({ seam, i: String(text ?? '').search(new RegExp(`(^|[^\\w-])${seam}([^\\w-]|$)`, 'i')) }))
    .filter((hit) => hit.i >= 0).sort((a, b) => a.i - b.i);
  return at[0]?.seam ?? null;
}

function question(state) {
  const url = (n) => `https://github.com/${state.intent.repo.remote}/pull/${n}`;
  const list = (items, empty) => (items.length ? items.join('; ') : empty);
  const held = state.wps.filter((wp) => wp.state === 'held');
  const deferred = state.wps.filter((wp) => wp.state === 'deferred');
  const open = (state.touches ?? []).filter((touch) => touch.kind === 'blocked' && touch.status !== 'answered');
  const r = state.release ?? {};
  return [
    `DO: read ${join(state.runDir, 'run-analysis.md')} first, then the merged PRs, then the deliverable (${state.intent.repo.path}, ${state.intent.repo.remote} at origin/${state.intent.repo.defaultBranch ?? 'main'}), and accept, accept with notes, or send back conductor run ${state.slug}. EXPECT: (a) the run closes; (b) the run closes with your notes stored verbatim; (c) the run ends as sent-back: name the seam (${SEAMS.filter((s) => s !== 'touches').join(', ')}); nothing re-runs and merged work and the release are not touched; reopening is a new /conduct run whose goal cites ${state.runDir}.`,
    `Merged PRs: ${list(mergedPrs(state).map((m) => `${m.id} ${url(m.pr)}`), 'none')}`,
    `Open PRs of held WPs: ${list(held.map((wp) => `${wp.id} ${wp.pr?.number ? url(wp.pr.number) : '(no PR)'} (${wp.reason ?? 'held'})`), 'none')}`,
    `Deferred WPs: ${list(deferred.map((wp) => `${wp.id}: ${wp.reason ?? 'no reason recorded'}`), 'none')}`,
    `Judgment threads the conductor resolved: ${list(judgmentThreads(state).map(judgmentLine), 'none')}`,
    `Blocked touches still open: ${list(open.map((touch) => `touch ${touch.n}${touch.wpId ? ` (${touch.wpId})` : ''}`), 'none')}`,
    `Release: ${r.state}${r.reason ? ` (${r.reason})` : ''}`,
    'Assumptions: the spec\'s **Assumptions:** line from /spec\'s final output, which the conductor names here by hand.',
  ].join('\n');
}

const OPTIONS = [
  { key: 'a', label: 'Accept', consequence: 'The run closes.' },
  { key: 'b', label: 'Accept with notes', consequence: 'Type your notes; they are stored verbatim and the run closes.' },
  { key: 'c', label: 'Send back', consequence: 'Name the seam; the run ends as sent-back and a new /conduct run reopens the work.' },
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
