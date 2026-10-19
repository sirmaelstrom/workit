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
// a refiling (filing 9999) with the short refusal sentence, which always fits
// once this does (filedQuestion cuts the reason to the room left, and drops it
// when even the short sentence would not fit).
export const filedLength = (state, n, question) => `${touchTag(state.slug, n)} (run ${state.runId}/9999) ${REFUSED_SHORT}${question}`.length;

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

// The spine path's channel: the filed touch is posted as a comment on the run's
// asks issue, and the operator's reply there is recorded as the answer by the
// shared github-ask script. Filing is the receipt, then the post: the touch is
// read back only once the post is recorded.
export function githubAskScript(state) {
  return join(state.pluginRoot, 'skills', '_shared', 'github-ask', 'github-ask.mjs');
}

export function githubAskSpecPath(state, touch) {
  return join(state.runDir, 'touches', `${touch.n}.github-ask.json`);
}

export function githubAskCommand(state, touch, sub, extra = '') {
  return `node ${shellLiteral(githubAskScript(state))} ${sub} --spec ${shellLiteral(githubAskSpecPath(state, touch))}${extra}`;
}

// poll's operator login, the variable Observatory checks; poll exits 8 without one.
export const OPERATOR_ENV = 'OBSERVATORY_OPERATOR_GITHUB_LOGIN';
// Failed posts in a row before the touch hands back; each resume then tries once more.
export const POST_ATTEMPTS = 3;

// The asks issue is the run's own, on its repo, until the first post names its number.
function githubAskSpec(state, touch, askReceiptId, question) {
  return {
    askReceiptId, questId: state.intent.anchor, question, options: touch.options, allowFreeText: touch.allowFreeText === true,
    run: `conduct ${state.slug} run ${state.runId}`,
    target: state.githubAsks?.target ?? state.intent.repo?.remote ?? null,
    issue: { key: `conduct ${state.slug} ${state.runId}`, title: `conduct ${state.slug}: operator asks (run ${state.runId})` },
  };
}

function writeGithubAskSpec(state, touch, deps, askReceiptId, question) {
  deps.mkdir(join(state.runDir, 'touches'));
  deps.write(githubAskSpecPath(state, touch), `${JSON.stringify(githubAskSpec(state, touch, askReceiptId, question), null, 2)}\n`);
}

const READ_BACK_EXITS = (state) => `Its exit: 0 (answered) or 7 (waiting): go on. 8 (no_operator: no operator login is configured): stop here. Call no spine_quest and record nothing. Tell the operator to set ${OPERATOR_ENV} to their GitHub login in the Claude Code settings.json \`env\` block, then end your turn; once it is set, resume with ${resumeCommand(state)}, which emits this read-back again. 3 (conflict: the ask is closed or replaced), 4 (not_operator), 5 (unconfigured), 6 (refused), 1 (error) or 2 (usage: a malformed spec or argument): tell the operator the printed status, code and error, then go on.`;

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

const postExhausted = (touch) => touch.post?.state === 'pending' && (touch.post.failures ?? 0) >= POST_ATTEMPTS;

// The next action for a touch, or null when it has none: answered, or (spine)
// queued behind another touch that is filed and not yet answered. With deps,
// a touch filed by a conduct that did not post (no touch.post) gets its spec
// and its post here, and the read-back passes the operator login conduct sees.
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
  if (deps && touch.status === 'filed' && !touch.post && touch.receiptId && filedQuestionOf(touch) !== null) {
    writeGithubAskSpec(state, touch, deps, touch.receiptId, filedQuestionOf(touch));
    touch.post = { state: 'pending', spec: `touches/${touch.n}.github-ask.json` };
  }
  if (touch.status === 'filed' && touch.post?.state === 'pending' && !(touch.waiting && postExhausted(touch))) {
    return {
      ...base, kind: 'shell', part: 'post', command: ['node', githubAskScript(state), 'post', '--spec', githubAskSpecPath(state, touch)],
      expects: { type: 'json' },
      instruction: `Run this exact argv (no shell) and record its { code, stdout, stderr }. It posts ${touch.tag} on the run's asks issue, or finds the comment a previous run of it posted; until it prints status posted, the touch is not read back and this action is emitted again, up to ${POST_ATTEMPTS} times in a row before it hands back.`,
    };
  }
  if (touch.waiting) return handBackAction(state, touch);
  if (touch.status === 'filed') {
    const login = String(deps?.env?.[OPERATOR_ENV] ?? '').trim();
    const extra = ` --once${login ? ` --operator ${shellLiteral(login)}` : ''}`;
    return {
      ...base, kind: 'agent-tool', part: 'read-back', tool: 'spine_quest', args: { ids: [state.intent.anchor] },
      expects: { type: 'json' },
      instruction: `First run ${githubAskCommand(state, touch, 'poll', extra)}: it records an operator reply to the touch's GitHub comment, if one has come. ${READ_BACK_EXITS(state)} Then call spine_quest with these args and record its raw result: the answer is what spine_quest shows, never what poll printed.`,
    };
  }
  if (state.touches.some((other) => other !== touch && other.status === 'filed')) return null;
  return {
    ...base, kind: 'agent-tool', part: 'receipt', tool: 'spine_receipt', expects: { type: 'json' },
    instruction: 'Call spine_receipt with these args and record its raw result. The next action posts it on GitHub.',
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
export function handBackAction(state, touch) {
  const base = {
    step: touchStep(touch), kind: 'touch', part: 'hand-back', handBack: true,
    touch: { n: touch.n, question: touch.question, options: touch.options }, expects: { type: 'none' },
  };
  if (postExhausted(touch)) {
    return {
      ...base,
      instruction: `Stop and end your turn: ${touch.tag} is filed on quest ${state.intent.anchor}, but github-ask post failed ${touch.post.failures} times, so it is not on GitHub and the operator cannot answer it there. The last failure: ${touch.post.lastError}. Do not record this action. Tell the operator that error. Once it is fixed, you or a scheduler resume with: ${resumeCommand(state)}, which posts it once more.`,
    };
  }
  const waiting = `${touch.tag} is filed on quest ${state.intent.anchor} and has no operator-attributed answer yet. Do not record this action.`;
  return {
    ...base,
    instruction: `Stop and end your turn: ${waiting} Tell the operator it waits for their reply to ${touch.post?.askCommentUrl ?? 'the touch\'s GitHub comment'}. Run no blocking poll. Later, you or a scheduler resume with: ${resumeCommand(state)} (its first action, the read-back, runs poll --once and reads the answer back).`,
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
  const refused = reasonRoom > 0 ? `Your previous answer could not be used (${touch.refusal.slice(0, reasonRoom)}…). ` : room >= REFUSED_SHORT.length ? REFUSED_SHORT : '';
  return `${head}${refused}${body}`;
}

// The answered receipt's question is the filed one, verbatim: touch.filedQuestion,
// or touch.filed.question on a touch filed by a conduct that kept only that.
export function filedQuestionOf(touch) {
  const filed = touch.filedQuestion ?? touch.filed?.question;
  return typeof filed === 'string' ? filed : null;
}
export function answersFiling(touch, question) {
  return typeof question === 'string' && question === filedQuestionOf(touch);
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

// An operator's typed answer with no key is option (c), when the touch has it.
function optionKey(touch, answer) {
  if (!answer.key && answer.text && touch.allowFreeText && touch.options.some((option) => option.key === 'c')) return 'c';
  return answer.key;
}

function refuse(touch, refusal) {
  touch.status = 'open';
  touch.refusal = refusal;
}

// Refuses (exit 3) an answer that is not the operator's: a spine answer must
// be stamped operator:…, a core answer needs the TTY-attested touch record.
export function acceptAnswer(state, touch, answer) {
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

export function recordTouch(state, touch, action, result, deps) {
  if (action.kind === 'wait') {
    touch.waiting = false;
    return;
  }
  if (action.kind === 'shell' && action.part === 'post') {
    // A post is accepted only when it exited 0, printed status posted, and
    // names this filing's receipt. Anything else is a failure: counted (the
    // record is saved), reported (exit 2), and the post is emitted again, up
    // to POST_ATTEMPTS in a row, then the touch hands back. The touch is not
    // read back until a post is accepted.
    let out = null;
    try { out = JSON.parse(result?.stdout ?? ''); } catch { out = null; }
    const failure = out?.status !== 'posted' ? `${out?.status ?? 'no JSON'}${out?.error ? `: ${out.error}` : ''}`
      : result?.code !== 0 ? `it printed status posted but exited ${result?.code}`
        : String(out.askReceiptId ?? '').toLowerCase() !== String(touch.receiptId ?? '').toLowerCase() ? `it posted ask ${out.askReceiptId}, not this filing's ${touch.receiptId}`
          : null;
    if (failure) {
      touch.post = { ...touch.post, failures: (touch.post?.failures ?? 0) + 1, lastError: `${failure} (exit ${result?.code})` };
      if (postExhausted(touch)) touch.waiting = true;
      return { failed: `github-ask post did not post ${touch.tag} (exit ${result?.code}): ${failure}` };
    }
    touch.post = { state: 'posted', target: out.target, askCommentUrl: out.askCommentUrl, askCommentId: out.askCommentId, existing: out.existing === true };
    touch.waiting = false;
    state.githubAsks = { ...state.githubAsks, target: out.target };
    return;
  }
  if (action.kind !== 'agent-tool') return;
  if (action.part === 'receipt') {
    // A failed or unbound acknowledgement is refused: the touch stays open and
    // the filing action stays pending, so it is re-emitted and never filed.
    const failure = spineAckFailure(action, result);
    if (failure) throw new ConductError(2, `spine_receipt did not file ${touch.tag}: ${failure}`);
    // The filing's second half: the spec is written first, so a failed write
    // leaves the touch as it was, and the post action comes next.
    writeGithubAskSpec(state, touch, deps, result.id, action.args.question);
    touch.receiptId = result.id;
    touch.filedQuestion = action.args.question;
    touch.filings += 1;
    touch.status = 'filed';
    touch.refusal = null;
    touch.post = { state: 'pending', spec: `touches/${touch.n}.github-ask.json` };
    return;
  }
  // The read-back: accept only an answered receipt to THIS run's filing.
  // spine_quest shows only the latest receipt, so a later receipt on the
  // anchor hides it there.
  if (filedQuestionOf(touch) === null) throw new ConductError(2, `touch ${touch.n} was filed before conduct kept the filed question (touch.filedQuestion), so no answer can be matched to it verbatim. Answer it in a new run (\`conduct.mjs intake\`); status and analyze still read this one.`);
  const latest = result?.quests?.[0]?.latestReceipt;
  const answered = latest?.outcome === 'answered' && latest.answer && answersFiling(touch, latest.question);
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
    refuse(touch, `the answer by ${answer.by ?? 'nobody'} is not operator-attributed`);
    return { refused: touch.refusal };
  }
  answer.key = optionKey(touch, answer);
  if (!touch.options.some((option) => option.key === answer.key)) {
    // The operator answered, but not with a usable option: re-file the touch
    // saying why, so it stays answerable.
    refuse(touch, `answer ${answer.key ?? '(no key)'} is not one of ${touch.options.map((option) => option.key).join(', ')}`);
    return;
  }
  acceptAnswer(state, touch, answer);
}
