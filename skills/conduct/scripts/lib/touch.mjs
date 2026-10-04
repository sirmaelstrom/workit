// Touches: the operator's asks. With the spine adapter a touch is a
// needs_input receipt on the anchor quest, read back with spine_quest; without
// it, a file pair under touches/ answered by `conduct.mjs answer` from a TTY.
import { join } from 'node:path';
import { ConductError, appendEvent } from './state.mjs';

export const READ_BACK_WAIT_MS = 300000;

export function touchTag(slug, n) {
  return `[conduct ${slug} touch ${n}]`;
}

export function touchStep(touch) {
  return touch.kind === 'preapproval' || touch.kind === 'showcase' ? touch.kind : 'touch';
}

function spineOn(state) {
  return state.adapters?.spine?.on === true;
}

export function conductScript(state) {
  return join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs');
}

export function answerCommand(state, touch) {
  const keys = touch.options.map((option) => option.key).join('|');
  return `node ${conductScript(state)} answer --run ${state.runDir} --touch ${touch.n} --key <${keys}> [--text "<text>"]`;
}

// touches/<n>.json is the record; touches/<n>.md is the operator's view.
export function writeTouchFiles(state, touch, deps) {
  const dir = join(state.runDir, 'touches');
  deps.mkdir(dir);
  deps.write(join(dir, `${touch.n}.json`), `${JSON.stringify(touch, null, 2)}\n`);
  const options = touch.options.map((option) => `- (${option.key}) ${option.label}: ${option.consequence}`);
  const view = [`# ${touch.tag}`, '', touch.question, '', 'Options:', ...options, '',
    'Answer from your own terminal (an agent cannot answer for you):', '', `    ${answerCommand(state, touch)}`, ''];
  deps.write(join(dir, `${touch.n}.md`), view.join('\n'));
}

export function openTouch(state, { kind, question, options, allowFreeText = true, wpId = null, suspendedStep = null, did = null }, deps) {
  const n = state.touches.length + 1;
  const tag = touchTag(state.slug, n);
  const touch = {
    n, kind, status: 'open', tag, wpId, suspendedStep,
    question: `${tag} ${question}`, options, allowFreeText,
    did, receiptId: null, file: `touches/${n}.md`, answer: null, waiting: false,
  };
  state.touches.push(touch);
  if (!spineOn(state)) writeTouchFiles(state, touch, deps);
  appendEvent(state, deps, { step: touchStep(touch), kind: 'touch', event: 'touch-opened', data: { n, kind } });
  return touch;
}

// The next action for a touch, or null when it has none: answered, or (spine)
// queued behind another touch that is filed and not yet answered.
export function touchAction(state, touch) {
  const step = touchStep(touch);
  const base = { step, touch: { n: touch.n } };
  if (touch.status === 'answered') return null;
  if (!spineOn(state)) {
    return {
      ...base, kind: 'touch', touch: { n: touch.n, question: touch.question, options: touch.options }, expects: { type: 'answer' },
      instruction: `Stop. Show the operator ${join(state.runDir, touch.file)} and ask them to run, in their own terminal: ${answerCommand(state, touch)}. Then record this action with {}.`,
    };
  }
  if (touch.waiting) {
    return {
      ...base, kind: 'wait', part: 'read-back', waitMs: READ_BACK_WAIT_MS, expects: { type: 'none' },
      instruction: `No attributed answer to ${touch.tag} yet: wait ${READ_BACK_WAIT_MS / 60000} minutes, record this action with {}, then run next.`,
    };
  }
  if (touch.status === 'filed') {
    return {
      ...base, kind: 'agent-tool', part: 'read-back', tool: 'spine_quest', args: { ids: [state.intent.anchor] },
      expects: { type: 'json' }, instruction: 'Call spine_quest with these args and record its raw result.',
    };
  }
  if (state.touches.some((other) => other !== touch && other.status === 'filed')) return null;
  return {
    ...base, kind: 'agent-tool', part: 'receipt', tool: 'spine_receipt', expects: { type: 'json' },
    instruction: 'Call spine_receipt with these args and record its raw result.',
    args: {
      questId: state.intent.anchor,
      outcome: 'needs_input',
      did: touch.did ?? `conduct ${state.slug} ran up to touch ${touch.n}`,
      stoppedAt: `touch ${touch.n} (${touch.kind}): waiting on the operator's answer`,
      question: touch.question,
      ask: { options: touch.options, allowFreeText: touch.allowFreeText },
    },
  };
}

// Refuses (exit 3) an answer that is not the operator's: a spine answer must
// be stamped operator:…, a core answer needs the TTY-attested touch record.
export function acceptAnswer(touch, answer) {
  const attributed = answer.source === 'spine'
    ? String(answer.by ?? '').startsWith('operator:')
    : touch.tty === true;
  if (!attributed) {
    throw new ConductError(3, `${touch.tag}: answer by ${answer.by ?? 'nobody'} is not attributed to the operator`);
  }
  if (!touch.options.some((option) => option.key === answer.key)) {
    throw new ConductError(3, `${touch.tag}: answer key ${answer.key} is not one of ${touch.options.map((option) => option.key).join(', ')}`);
  }
  touch.answer = {
    key: answer.key, text: answer.text ?? null, by: answer.by, answeredAt: answer.answeredAt,
    source: answer.source, receiptId: answer.receiptId ?? null,
  };
  touch.status = 'answered';
  touch.waiting = false;
}

export function recordTouch(state, touch, action, result) {
  if (action.kind === 'wait') {
    touch.waiting = false;
    return;
  }
  if (action.kind !== 'agent-tool') return;
  if (action.part === 'receipt') {
    touch.receiptId = typeof result?.id === 'string' ? result.id : null;
    touch.status = 'filed';
    return;
  }
  // The read-back: accept only an answered receipt to THIS touch's question.
  const latest = result?.quests?.[0]?.latestReceipt;
  const answered = latest?.outcome === 'answered' && latest.answer
    && typeof latest.question === 'string' && latest.question.startsWith(touch.tag);
  if (!answered) {
    touch.waiting = true;
    return;
  }
  acceptAnswer(touch, {
    key: latest.answer.key, text: latest.answer.text, by: latest.answer.by, answeredAt: latest.answer.answeredAt,
    source: 'spine', receiptId: typeof latest.id === 'string' ? latest.id : null,
  });
}
