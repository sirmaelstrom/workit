// Touches: the operator's asks. With the spine adapter a touch is asked in
// session; when no operator is in the session it is filed once as a plain
// needs_input receipt on the anchor quest (the options as text lines in its
// question) and the run hands back, waiting on the operator. A resumed session
// asks it again, or the operator answers it with `conduct.mjs answer` from a
// TTY; once answered, an ordinary receipt supersedes the needs_input. Without
// the spine adapter, a file pair under touches/ answered by `conduct.mjs answer`.
import { join } from 'node:path';
import { ConductError, TERMINAL_PHASES, appendEvent } from './state.mjs';

// How long a core touch's wait lasts before the build looks at it again.
export const TOUCH_WAIT_MS = 300000;
// spine_receipt refuses a question longer than this.
export const QUESTION_MAX = 2000;

export function touchTag(slug, n) {
  return `[conduct ${slug} touch ${n}]`;
}

// A refiling names its refusal; when room is short the reason is cut, down to this.
const REFUSED_SHORT = 'Your previous answer could not be used. ';

export function touchStep(touch) {
  return touch.kind === 'preapproval' || touch.kind === 'showcase' ? touch.kind : 'touch';
}

function spineOn(state) {
  return state.adapters?.spine?.on === true;
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

// Set to 1 by a runner that knows no operator is in the session (a scheduler,
// claude -p): touches skip the session ask and are filed on the Spine.
export const UNATTENDED_ENV = 'WORKIT_UNATTENDED';

export function resumeCommand(state) {
  return `node ${shellLiteral(conductScript(state))} next --resume ${shellLiteral(state.runDir)}`;
}

export function answerCommand(state, touch) {
  const keys = touch.options.map((option) => option.key).join('|');
  return `node ${shellLiteral(conductScript(state))} answer --run ${shellLiteral(state.runDir)} --touch ${touch.n} --key <${keys}> [--text "<text>"]`;
}

// What the filed question adds to the touch's own: its options as text lines,
// the recommended one first, unless its EXPECT already letters every one, and
// how the operator answers. A needs_input carries no structured options.
function optionsBlock(question, options) {
  const recommended = (option) => /\(recommended\)\s*$/.test(String(option.label));
  const ordered = [...options.filter(recommended), ...options.filter((option) => !recommended(option))];
  const lettered = options.every((option) => question.includes(`(${option.key})`));
  return ['', ...(lettered ? [] : ['Options:', ...ordered.map((option) => `(${option.key}) ${option.label}`)]),
    'Answer: any session resumes the run (stoppedAt) and asks you.'].join('\n');
}

// The longest question a touch's filing carries, as spine_receipt measures it:
// a refiling (filing 9999) with the short refusal sentence and its options,
// which always fits once this does (filedQuestion cuts the reason to the room
// left, and drops it when even the short sentence would not fit).
export const filedLength = (state, n, question, options = []) => `${touchTag(state.slug, n)} (run ${state.runId}/9999) ${REFUSED_SHORT}${question}${optionsBlock(question, options)}`.length;

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

// A filed touch the run cannot move: it waits on the operator in a later
// session or their terminal. Its hand-back is the run's resumable stop.
export function touchParked(state, touch, env = {}) {
  return spineOn(state) && touch.status === 'filed' && (touch.waiting === true || env?.[UNATTENDED_ENV] === '1');
}

// The next action for a touch, or null when it has none: answered, or (spine)
// queued behind another touch that is filed and not yet answered. One
// needs_input waits on the anchor at a time: a second would hide the first.
export function touchAction(state, touch, deps = null) {
  const step = touchStep(touch);
  const base = { step, touch: { n: touch.n } };
  if (touch.status === 'answered') return null;
  if (!spineOn(state)) {
    return {
      ...base, kind: 'touch', touch: { n: touch.n, question: touch.question, options: touch.options }, expects: { type: 'answer' },
      instruction: `Stop. Show the operator ${join(state.runDir, touch.file)} and ask them to run, in their own terminal: ${answerCommand(state, touch)}. Then record this action with {}.`,
    };
  }
  const unattended = deps?.env?.[UNATTENDED_ENV] === '1';
  // Filed: a resumed session asks it again; in the sitting that filed it, or with no operator, the run hands back.
  if (touch.status === 'filed') return touchParked(state, touch, deps?.env) ? handBackAction(state, touch) : sessionAskAction(state, touch, base);
  if (state.touches.some((other) => other !== touch && other.status === 'filed')) return null;
  if (touch.channel !== 'unattended' && !unattended) return sessionAskAction(state, touch, base);
  return {
    ...base, kind: 'agent-tool', part: 'receipt', tool: 'spine_receipt', expects: { type: 'json' },
    instruction: 'Call spine_receipt with these args and record its raw result. The run then hands back: post nothing anywhere and wait for nothing.',
    args: {
      questId: state.intent.anchor,
      outcome: 'needs_input',
      did: touch.did ?? `conduct ${state.slug} ran up to touch ${touch.n}`,
      stoppedAt: `touch ${touch.n} (${touch.kind}): waiting on the operator's answer. Resume: ${resumeCommand(state)}`,
      question: filedQuestion(state, touch, touch.filings + 1),
    },
  };
}

// The spine path's first part: the operator is asked in this session. Only a
// session with no operator in it files the touch on the Spine, where it waits
// until a later session or the operator's terminal answers it.
function sessionAskAction(state, touch, base) {
  const keys = touch.options.map((option) => option.key).join('|');
  const refused = touch.refusal ? ` Their last answer could not be used (${touch.refusal}): say so when you ask.` : '';
  const filed = touch.status === 'filed'
    ? 'record { "unattended": true }: the touch stays filed and the run hands back again.'
    : 'record { "unattended": true }: the touch is then filed on the Spine as one needs_input receipt and the run hands back.';
  return {
    ...base, kind: 'touch', part: 'ask', touch: { n: touch.n, question: touch.question, options: touch.options, allowFreeText: touch.allowFreeText },
    expects: { type: 'json' },
    instruction: `If the operator is in this session, pose this touch as a plain AskUserQuestion (rules above) and record { "key": "<${keys}>", "text": "<their typed text, or null>" } from their answer.${refused} Record only what they chose: never an answer you inferred, and never one for a session they are not in. If no operator is in this session (a headless run, a scheduled resume, a successor no operator has spoken to), ${filed}`,
  };
}

function recordSessionAsk(state, touch, result, deps) {
  // Answered from the operator's terminal while the ask was pending.
  if (touch.status === 'answered') return;
  if (result?.unattended === true) {
    if (touch.status === 'filed') touch.waiting = true;
    else touch.channel = 'unattended';
    appendEvent(state, deps, { step: touchStep(touch), kind: 'touch', event: 'touch-unattended', data: { n: touch.n } });
    return;
  }
  const answer = { key: result?.key, text: typeof result?.text === 'string' && result.text.trim() ? result.text : null };
  answer.key = optionKey(touch, answer);
  if (!touch.options.some((option) => option.key === answer.key)) {
    throw new ConductError(2, `${touch.tag}: record { "key": "<${touch.options.map((option) => option.key).join('|')}>", "text": … } or { "unattended": true }, not ${JSON.stringify(result).slice(0, 200)}`);
  }
  touch.channel = 'session';
  acceptAnswer(state, touch, { ...answer, by: 'operator:session', answeredAt: deps.timestamp(), source: 'session' });
  // The record /spec --preapproved names (core:…/touches/<n>.json) and a
  // successor session reads: what was asked and what the operator chose.
  deps.mkdir(join(state.runDir, 'touches'));
  deps.write(join(state.runDir, 'touches', `${touch.n}.json`), `${JSON.stringify(touch, null, 2)}\n`);
  appendEvent(state, deps, { step: touchStep(touch), kind: 'touch', event: 'answered', source: 'session', data: { n: touch.n, key: touch.answer.key } });
}

// A touch filing a conduct with the GitHub asks emitted and nobody recorded:
// its spine_receipt carries `ask`, which Observatory now refuses. `next`
// drops it and the touch takes today's path (asked in session, or filed
// without `ask`). Returns the dropped action, or null.
export function dropRetiredFiling(state, deps) {
  const action = state.pending;
  if (action?.kind !== 'agent-tool' || action.part !== 'receipt' || !action.touch || !Object.hasOwn(action.args ?? {}, 'ask')) return null;
  const touch = state.touches?.[action.touch.n - 1];
  if (!touch || touch.status === 'answered') return null;
  state.pending = null;
  appendEvent(state, deps, { actionId: action.id, step: action.step, seam: action.seam, kind: action.kind, event: 'pending-dropped', phase: action.phase,
    data: { n: touch.n, why: 'an unrecorded touch filing with the retired GitHub ask\'s `ask` field' } });
  return action;
}

// The spine hand-back: a filed touch waits on the operator, so the
// conductor's turn ends here. It is never recorded (`record` returns it with
// `answered: false`); `next` consumes it on resume and asks the touch again.
export function handBackAction(state, touch) {
  return {
    step: touchStep(touch), kind: 'touch', part: 'hand-back', handBack: true,
    touch: { n: touch.n, question: touch.question, options: touch.options }, expects: { type: 'none' },
    instruction: `Stop and end your turn: ${touch.tag} is filed on quest ${state.intent.anchor} as a needs_input receipt and waits on the operator. Do not record this action, post it anywhere or wait for an answer. The operator answers in a later session, which resumes the run with ${resumeCommand(state)} and asks them there, or from their own terminal with ${answerCommand(state, touch)} and then the resume.`,
  };
}

// `next` on a pending hand-back: the touch is asked again. The `resumed`
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

function filedQuestion(state, touch, filing) {
  const head = `${touch.tag} (run ${state.runId}/${filing}) `;
  const body = touch.question.slice(touch.tag.length + 1);
  const tail = optionsBlock(body, touch.options);
  let refused = '';
  if (touch.refusal) {
    // The refusal is the one part a refiling adds: it gives way to the cap before the question does.
    const full = `Your previous answer could not be used (${touch.refusal}). `;
    const room = QUESTION_MAX - head.length - body.length - tail.length;
    const reasonRoom = room - 'Your previous answer could not be used (…). '.length;
    refused = full.length <= room ? full
      : reasonRoom > 0 ? `Your previous answer could not be used (${touch.refusal.slice(0, reasonRoom)}…). ` : room >= REFUSED_SHORT.length ? REFUSED_SHORT : '';
  }
  const text = `${head}${refused}${body}${tail}`;
  if (text.length <= QUESTION_MAX) return text;
  // A question that still overruns is cut, never its options or how to answer:
  // the cut may take its EXPECT, so the options are listed.
  const listed = optionsBlock('', touch.options);
  const keep = QUESTION_MAX - head.length - refused.length - listed.length - 1;
  return `${head}${refused}${body.slice(0, Math.max(0, keep))}…${listed}`;
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

// A call that never reached the Spine, as fetch or an MCP client words it.
const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|timed? ?out|not connected|connection closed|-32000/i;

// The text a failed tool result carries: a bare string, an error, or an MCP error's text content.
function ackText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (result.error != null) return String(result.error?.message ?? (typeof result.error === 'string' ? result.error : JSON.stringify(result.error)));
  const content = Array.isArray(result.content) ? result.content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ') : '';
  // An MCP error with no text is no answer; an `ok: false` body is one.
  return content || (result.isError ? '' : JSON.stringify(result));
}

// The stop a refused acknowledgement makes, or null: "Spine unreachable" when
// the call got no answer (nothing, or a connection error), "Spine refused"
// when it answered with an error or the wrong thing. Either way nothing is
// recorded and the action stays pending, so the same call is made again.
export function spineAckStop(action, result) {
  const failure = spineAckFailure(action, result);
  if (!failure) return null;
  const again = `Nothing was recorded; ${action.id} stays pending: call ${action.tool} again with the same args`;
  if (!failure.startsWith('failed: ')) return `Spine refused ${action.tool}: ${failure}. ${again} and record its raw result.`;
  const text = ackText(result).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text || UNREACHABLE.test(text)) {
    return `Spine unreachable: ${action.tool} got no acknowledgement (${text || 'no result'}). ${again} once Observatory answers (GET /api/health), and record its raw result.`;
  }
  return `Spine refused ${action.tool}: ${text}. ${again} and record its raw result.`;
}

// An operator's typed answer with no key is option (c), when the touch has it.
function optionKey(touch, answer) {
  if (!answer.key && answer.text && touch.allowFreeText && touch.options.some((option) => option.key === 'c')) return 'c';
  return answer.key;
}

// Refuses (exit 3) an answer that is not the operator's: a session answer is
// the operator's AskUserQuestion choice in this session, a terminal answer
// needs the TTY-attested touch record. A filed touch's answer owes the anchor
// the ordinary receipt that supersedes its needs_input.
export function acceptAnswer(state, touch, answer) {
  const attributed = answer.source === 'session' ? answer.by === 'operator:session' : touch.tty === true;
  if (!attributed) {
    throw new ConductError(3, `${touch.tag}: answer by ${answer.by ?? 'nobody'} is not attributed to the operator`);
  }
  if (!touch.options.some((option) => option.key === answer.key)) {
    throw new ConductError(3, `${touch.tag}: answer key ${answer.key} is not one of ${touch.options.map((option) => option.key).join(', ')}`);
  }
  if (touch.status === 'filed') touch.supersede = 'owed';
  touch.answer = { key: answer.key, text: answer.text ?? null, by: answer.by, answeredAt: answer.answeredAt, source: answer.source };
  touch.status = 'answered';
  touch.waiting = false;
}

// The ordinary receipt a filed touch owes once answered: it quotes the answer
// and supersedes the needs_input, so the anchor is no longer blocked-waiting.
// Emitted before any phase's next action (conduct.mjs emit).
export function supersedeAction(state) {
  if (!spineOn(state)) return null;
  const touch = (state.touches ?? []).find((candidate) => candidate.status === 'answered' && candidate.supersede === 'owed');
  if (!touch) return null;
  const { key, text, by } = touch.answer;
  const ended = TERMINAL_PHASES.includes(state.phase);
  return {
    step: touchStep(touch), kind: 'agent-tool', part: 'supersede', touch: { n: touch.n }, tool: 'spine_receipt', expects: { type: 'json' },
    instruction: 'Call spine_receipt with these args and record its raw result.',
    args: {
      questId: state.intent.anchor,
      outcome: ended ? 'completed' : 'paused',
      did: `conduct ${state.slug} (run ${state.runId}): the operator answered ${touch.tag} (needs_input receipt ${touch.receiptId}), verbatim: (${key})${text ? ` ${text}` : ''} [${by}]. ${ended ? `The run ended ${state.phase}.` : 'The run continues under that answer.'}`.slice(0, 4000),
      stoppedAt: `touch ${touch.n} answered; conduct ${state.slug} ${ended ? `ended ${state.phase}` : 'continues'}`,
    },
  };
}

// A failed or unbound acknowledgement is refused: the receipt stays owed and is emitted again.
export function recordSupersede(state, action, result, deps) {
  const touch = state.touches[action.touch.n - 1];
  const failure = spineAckFailure(action, result);
  if (failure) throw new ConductError(2, `spine_receipt did not supersede ${touch.tag}'s needs_input: ${failure}`);
  touch.supersede = result.id;
  appendEvent(state, deps, { step: action.step, kind: 'touch', event: 'touch-superseded', data: { n: touch.n, receipt: result.id } });
}

export function recordTouch(state, touch, action, result, deps) {
  if (action.kind === 'wait') {
    touch.waiting = false;
    return;
  }
  if (action.kind === 'touch' && action.part === 'ask') return recordSessionAsk(state, touch, result, deps);
  if (action.kind !== 'agent-tool' || action.part !== 'receipt') return;
  // A failed or unbound acknowledgement is refused: the touch stays open and
  // the filing action stays pending, so it is re-emitted and never filed.
  const failure = spineAckFailure(action, result);
  if (failure) throw new ConductError(2, `spine_receipt did not file ${touch.tag}: ${failure}`);
  touch.receiptId = result.id;
  touch.filedQuestion = action.args.question;
  touch.filings += 1;
  touch.status = 'filed';
  touch.refusal = null;
  touch.waiting = true;
  // The operator's terminal view: the question and the answer command.
  writeTouchFiles(state, touch, deps);
}
