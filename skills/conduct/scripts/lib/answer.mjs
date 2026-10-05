// The answer adapter: WORKIT_TOUCH_ANSWER_CMD finds the operator's answer to a
// filed spine touch in ANY receipt on the anchor, not only the latest one, and
// lets `conduct.mjs await-answer` wait for it without a model turn. It is a
// JSON argv array with {quest} and {tag} substituted (appended in that order
// when neither appears), or a bare program path that gets both as arguments.
// No shell parses it. The command prints one JSON object, the newest
// `answered` receipt on {quest} whose question starts with {tag}
// ({ id, outcome, question, answer: { key, text, by, answeredAt } }), or
// `null` / nothing when there is none; a non-zero exit is a failure.
import { ConductError, loadState } from './state.mjs';
import { correlation } from './touch.mjs';

export const ANSWER_ENV = 'WORKIT_TOUCH_ANSWER_CMD';
export const AWAIT_INTERVAL_MS = 60000;
export const AWAIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const AWAIT_MAX_FAILURES = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The tag is `[conduct <slug> touch <n>] (run <hex>/<filing>)`: a slug is
// [a-z0-9-], so this set holds every real tag and nothing a SQL literal or a
// psql argument would read as syntax.
const TAG = /^\[conduct [a-z0-9-]+ touch [0-9]+\] \(run [0-9a-f]+\/[0-9]+\)$/;

// The argv, or null when the env holds nothing usable; `problem` says why.
export function parseAnswerCommand(spec) {
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) return { argv: null, problem: `${ANSWER_ENV} is not set` };
  if (!trimmed.startsWith('[')) return { argv: [trimmed], problem: null };
  let argv;
  try {
    argv = JSON.parse(trimmed);
  } catch {
    argv = null;
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string' && part !== '')) {
    return { argv: null, problem: `${ANSWER_ENV} is neither a program path nor a JSON array of non-empty strings` };
  }
  return { argv, problem: null };
}

export function answerArgv(spec, quest, tag) {
  const { argv, problem } = parseAnswerCommand(spec);
  if (!argv) throw new ConductError(2, problem);
  if (!UUID.test(String(quest))) throw new ConductError(2, `the anchor ${JSON.stringify(quest)} is not a full quest uuid`);
  if (!TAG.test(String(tag))) throw new ConductError(2, `the touch tag ${JSON.stringify(tag)} is not a conduct tag`);
  const placed = argv.some((part) => part.includes('{quest}') || part.includes('{tag}'));
  const filled = argv.map((part) => part.split('{quest}').join(quest).split('{tag}').join(tag));
  return placed ? filled : [...filled, quest, tag];
}

// The resolver's stdout as a receipt, or null. A receipt that is not an
// answered one to this tag is not an answer, whatever the resolver meant.
export function parseAnswerOutput(stdout, tag) {
  const text = String(stdout ?? '').trim();
  if (!text || text === 'null') return null;
  let receipt;
  try {
    receipt = JSON.parse(text.split(/\r?\n/).filter(Boolean).at(-1));
  } catch (error) {
    throw new ConductError(1, `${ANSWER_ENV} printed non-JSON: ${error.message}`);
  }
  if (receipt === null) return null;
  if (typeof receipt !== 'object' || Array.isArray(receipt)) throw new ConductError(1, `${ANSWER_ENV} printed ${typeof receipt}, not a receipt object`);
  const answered = receipt.outcome === 'answered' && receipt.answer && typeof receipt.answer === 'object'
    && typeof receipt.question === 'string' && receipt.question.startsWith(tag);
  return answered ? receipt : null;
}

// One lookup: { receipt } (null when unanswered). A failing command throws.
export function lookupAnswer(state, touch, deps) {
  const tag = correlation(state, touch);
  const [program, ...args] = answerArgv(deps.env?.[ANSWER_ENV], state.intent.anchor, tag);
  const result = deps.exec(program, args);
  if (result.code !== 0) throw new ConductError(1, `${ANSWER_ENV} exited ${result.code}: ${String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''}`);
  return { tag, receipt: parseAnswerOutput(result.stdout, tag) };
}

function intFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < 0) throw new ConductError(2, `--${name} takes a non-negative integer`);
  return value;
}

// `conduct.mjs await-answer --run <dir> --touch <n> [--once] [--interval-ms]
// [--timeout-ms]`. Reads state without its lock and writes nothing: the
// read-back that follows decides whether the answer is usable. --once is the
// read-back itself (exit 0 either way); without it the verb polls until an
// answer appears (exit 0), the timeout passes (exit 4), or the command fails
// AWAIT_MAX_FAILURES times in a row (exit 1).
export async function awaitAnswer(flags, deps) {
  const runDir = typeof flags.run === 'string' ? flags.run : null;
  if (!runDir) throw new ConductError(2, '--run <dir> is required');
  const state = loadState(runDir, deps);
  const touch = state.touches?.[Number(flags.touch) - 1];
  if (!touch) throw new ConductError(2, `--touch ${flags.touch ?? '(none)'} names no touch in this run`);
  if (touch.status === 'answered') return { out: { ok: true, answered: true, receipt: null, touch: touch.n, note: 'already answered' } };
  if (touch.status !== 'filed') throw new ConductError(5, `touch ${touch.n} is ${touch.status}, not filed`);
  if (flags.once === true) {
    const { tag, receipt } = lookupAnswer(state, touch, deps);
    return { out: { ok: true, answered: receipt !== null, receipt, tag, touch: touch.n } };
  }
  const interval = intFlag(flags, 'interval-ms', AWAIT_INTERVAL_MS);
  const timeout = intFlag(flags, 'timeout-ms', AWAIT_TIMEOUT_MS);
  const deadline = deps.now() + timeout;
  let failures = 0;
  for (;;) {
    try {
      const { tag, receipt } = lookupAnswer(state, touch, deps);
      failures = 0;
      if (receipt) return { out: { ok: true, answered: true, receipt, tag, touch: touch.n } };
    } catch (error) {
      if (error.code === 2) throw error;
      failures += 1;
      if (failures >= AWAIT_MAX_FAILURES) throw error;
    }
    if (deps.now() + interval > deadline) {
      return { code: 4, out: { ok: false, answered: false, timeout: true, touch: touch.n } };
    }
    await deps.sleep(interval);
  }
}
