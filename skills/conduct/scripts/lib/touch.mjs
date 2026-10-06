// Touches: the operator's asks. With the spine adapter a touch is a
// needs_input receipt on the anchor quest, read back with spine_quest; without
// it, a file pair under touches/ answered by `conduct.mjs answer` from a TTY.
import { join } from 'node:path';
import { ConductError, appendEvent } from './state.mjs';

export const READ_BACK_WAIT_MS = 300000;
// spine_receipt refuses a question longer than this.
export const QUESTION_MAX = 2000;

export function touchTag(slug, n) {
  return `[conduct ${slug} touch ${n}]`;
}

// A refiling names its refusal; when room is short the reason is cut, down to this.
const REFUSED_SHORT = 'Your previous answer could not be used. ';

// The longest question a touch's filing carries, as spine_receipt measures it:
// a refiling (filing 99) with the short refusal sentence, which always fits
// once this does (filedQuestion cuts the reason to the room left).
export const filedLength = (state, n, question) => `${touchTag(state.slug, n)} (run ${state.runId}/99) ${REFUSED_SHORT}${question}`.length;

export function touchStep(touch) {
  return touch.kind === 'preapproval' || touch.kind === 'showcase' ? touch.kind : 'touch';
}

function spineOn(state) {
  return state.adapters?.spine?.on === true;
}

// The answer adapter (lib/answer.mjs) reads every receipt on the anchor, so
// with it on the read-back and the hand-back's waiter go through it.
function answerOn(state) {
  return state.adapters?.answer?.on === true;
}

export function awaitAnswerCommand(state, touch, { once = false } = {}) {
  return ['node', conductScript(state), 'await-answer', '--run', state.runDir, '--touch', String(touch.n), ...(once ? ['--once'] : [])];
}

export function conductScript(state) {
  return join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs');
}

// One literal argument for the shell a printed command is run from:
// PowerShell on win32 (inside single quotes, '' is one '), POSIX elsewhere
// ('\'' closes the quote, adds an escaped ', reopens). Nothing inside expands.
export function shellLiteral(value, platform = process.platform) {
  const text = String(value);
  return platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
}

export function answerCommand(state, touch) {
  const keys = touch.options.map((option) => option.key).join('|');
  return `node ${shellLiteral(conductScript(state))} answer --run ${shellLiteral(state.runDir)} --touch ${touch.n} --key <${keys}> [--text "<text>"]`;
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
    did, receiptId: null, file: `touches/${n}.md`, answer: null, waiting: false, filings: 0, refusal: null,
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
  if (touch.waiting) return handBackAction(state, touch);
  if (touch.status === 'filed' && answerOn(state)) {
    return {
      ...base, kind: 'shell', part: 'read-back', command: awaitAnswerCommand(state, touch, { once: true }),
      expects: { type: 'json' }, instruction: 'Run this exact argv (no shell), and record its { code, stdout, stderr }.',
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
      question: filedQuestion(state, touch, touch.filings + 1),
      ask: { options: touch.options, allowFreeText: touch.allowFreeText },
    },
  };
}

export function resumeCommand(state) {
  return `node ${shellLiteral(conductScript(state))} next --resume ${shellLiteral(state.runDir)}`;
}

// The spine hand-back: the read-back found no attributed answer, so the
// conductor's turn ends here. It is never recorded (`record` returns it with
// `answered: false`); `next` consumes it on resume and emits the read-back.
// With the answer adapter it carries a waiter: a background process that
// exits when the answer lands, so the resume needs no operator command.
export function handBackAction(state, touch) {
  const base = {
    step: touchStep(touch), kind: 'touch', part: 'hand-back', handBack: true,
    touch: { n: touch.n, question: touch.question, options: touch.options }, expects: { type: 'none' },
  };
  const waiting = `${touch.tag} is filed on quest ${state.intent.anchor} and has no operator-attributed answer yet. Do not record this action and do not poll.`;
  if (answerOn(state)) {
    const command = awaitAnswerCommand(state, touch);
    return {
      ...base, waiter: { command, background: true },
      instruction: `${waiting} Start the waiter argv (no shell) in the background: ${JSON.stringify(command)}. Tell the operator it waits for their answer in the Dogan, then end your turn. When the waiter exits, whatever its exit code, resume with: ${resumeCommand(state)} (its first action reads the answer back; an unanswered read hands back again with a new waiter).`,
    };
  }
  return {
    ...base,
    instruction: `Stop and end your turn: ${waiting} Tell the operator it waits for their answer in the Dogan. When they have answered, resume with: ${resumeCommand(state)} (its first action reads the answer back).`,
  };
}

// `next` on a pending hand-back: the touch is read back again. The `resumed`
// event carries the hand-back's own seam, as its emitted event does
// (`release` for the release anomaly's touch, else TOUCH_SEAM).
export function resumeHandBack(state, deps) {
  const action = state.pending;
  const touch = state.touches[action.touch.n - 1];
  touch.waiting = false;
  touch.waitLeftMs = null;
  touch.waitDueAt = null;
  state.pending = null;
  appendEvent(state, deps, { actionId: action.id, step: action.step, seam: action.seam, kind: action.kind, event: 'resumed', phase: action.phase, data: { n: touch.n } });
}

// A spine answer belongs to this run's filing only when its question starts
// with the tag plus the run id and filing number: a same-tag answer from an
// earlier run of the same goal, or to an earlier filing, does not match.
export function correlation(state, touch, filing = touch.filings) {
  return `${touch.tag} (run ${state.runId}/${filing})`;
}

function filedQuestion(state, touch, filing) {
  const body = touch.question.slice(touch.tag.length + 1);
  const head = `${correlation(state, touch, filing)} `;
  if (!touch.refusal) return `${head}${body}`;
  // The refusal is the one part a refiling adds: it gives way to the cap, never the question.
  const full = `Your previous answer could not be used (${touch.refusal}). `;
  const room = QUESTION_MAX - head.length - body.length;
  if (full.length <= room) return `${head}${full}${body}`;
  const reasonRoom = room - 'Your previous answer could not be used (…). '.length;
  const refused = reasonRoom > 0 ? `Your previous answer could not be used (${touch.refusal.slice(0, reasonRoom)}…). ` : REFUSED_SHORT;
  return `${head}${refused}${body}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A spine acknowledgement must answer what was asked: no error, the same
// quest, the same outcome/state when it carries one, and a receipt uuid.
// Every spine_receipt and spine_update the conductor emits is checked here.
export function spineAckFailure(action, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.error != null || result.isError || result.ok === false || result.success === false) {
    return `failed: ${JSON.stringify(result?.error ?? result).slice(0, 200)}`;
  }
  // A carried quest id is a uuid or a hex prefix of 8+, and prefixes the one asked for (either way).
  const asked = String(action.args.questId).toLowerCase();
  const carried = String(result.questId ?? '').toLowerCase();
  if (result.questId !== undefined && (!(UUID.test(carried) || /^[0-9a-f]{8,}$/.test(carried)) || !(carried.startsWith(asked) || asked.startsWith(carried)))) {
    return `answered for quest ${JSON.stringify(result.questId)}, not ${asked}`;
  }
  for (const key of ['outcome', 'workState', 'horizon', 'currentPhase']) {
    if (action.args[key] !== undefined && result[key] !== undefined && result[key] !== action.args[key]) return `${key} is ${result[key]}, not ${action.args[key]}`;
  }
  if (action.tool === 'spine_receipt' && !UUID.test(String(result.id ?? ''))) return `no receipt uuid in the result (id ${JSON.stringify(result.id)})`;
  return null;
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

// `await-answer --once` prints { ok, answered, receipt }; a failed lookup is
// refused, so the read-back stays pending and is run again.
function answerLookup(action, result) {
  let out;
  try {
    out = JSON.parse(result?.stdout ?? '');
  } catch {
    out = null;
  }
  if (result?.code !== 0 || out?.ok !== true) {
    throw new ConductError(1, `the answer lookup failed (exit ${result?.code}): ${out?.error ?? String(result?.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''}`);
  }
  return out.receipt ?? null;
}

export function recordTouch(state, touch, action, result) {
  if (action.kind === 'wait') {
    touch.waiting = false;
    return;
  }
  if (action.kind !== 'agent-tool' && !(action.kind === 'shell' && action.part === 'read-back')) return;
  if (action.part === 'receipt') {
    // A failed or unbound acknowledgement is refused: the touch stays open and
    // the filing action stays pending, so it is re-emitted and never filed.
    const failure = spineAckFailure(action, result);
    if (failure) throw new ConductError(2, `spine_receipt did not file ${touch.tag}: ${failure}`);
    touch.receiptId = result.id;
    touch.filings += 1;
    touch.status = 'filed';
    touch.refusal = null;
    return;
  }
  // The read-back: accept only an answered receipt to THIS run's filing. The
  // answer adapter's lookup finds it in any receipt; spine_quest shows only
  // the latest, so a later receipt on the anchor hides it there.
  const latest = action.kind === 'shell' ? answerLookup(action, result) : result?.quests?.[0]?.latestReceipt;
  const answered = latest?.outcome === 'answered' && latest.answer
    && typeof latest.question === 'string' && latest.question.startsWith(correlation(state, touch));
  if (!answered) {
    touch.waiting = true;
    return;
  }
  const answer = {
    key: latest.answer.key, text: latest.answer.text, by: latest.answer.by, answeredAt: latest.answer.answeredAt,
    source: 'spine', receiptId: typeof latest.id === 'string' ? latest.id : null,
  };
  // Not the operator's: refused as an answer (no authority), and the touch is
  // re-filed so it stays answerable. The caller exits 3 for this read.
  if (!String(answer.by ?? '').startsWith('operator:')) {
    touch.status = 'open';
    touch.refusal = `the answer by ${answer.by ?? 'nobody'} is not operator-attributed`;
    return { refused: touch.refusal };
  }
  // An operator's typed answer with no key is option (c), when the touch has it.
  if (!answer.key && answer.text && touch.allowFreeText && touch.options.some((option) => option.key === 'c')) answer.key = 'c';
  if (!touch.options.some((option) => option.key === answer.key)) {
    // The operator answered, but not with a usable option: re-file the touch
    // saying why, so it stays answerable.
    touch.status = 'open';
    touch.refusal = `answer ${answer.key ?? '(no key)'} is not one of ${touch.options.map((option) => option.key).join(', ')}`;
    return;
  }
  acceptAnswer(touch, answer);
}
