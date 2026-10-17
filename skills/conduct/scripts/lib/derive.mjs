// What a configured run may emit of a stored act (one left pending, a queue
// head, a custody step). Whether it is emitted is decided by its content,
// never by its labels (step, part, touch, phase, a stage):
// - an act that does anything (a command, a tool call, an edit, a skill) must
//   equal, whole, an act its phase derives now from the run's state and the
//   verified authority. A label may pick which derivation to compare against;
//   one that picks none, or one that differs, is a refusal.
// - a wait, which runs nothing, is accepted by its shape alone: only a wait's
//   fields, and its instruction replaced by the canonical text.
// conduct.mjs (emit and record) calls admitAct for every stored act it would
// emit or record; each phase's `derive` is the source of truth, and a phase
// without one is derived by running its `next` on a copy of the state.
import { STEPS } from './state.mjs';
import { sameAction } from './authority.mjs';

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A wait's fields: what emission stamps, what a wait counts down, and the
// wait itself. Anything else (a command, a tool, args, a cwd, a waiter) is refused.
const WAIT_FIELDS = new Set(['id', 'phase', 'seam', 'wpId', 'dueAt', 'remainingMs', 'kind', 'step', 'part', 'waitMs', 'instruction', 'yield', 'held']);
export const canonicalWaitText = (waitMs) => `Wait ${waitMs / 1000} s, then record {}.`;

export function waitVerdict(action) {
  const extra = Object.keys(action).filter((key) => !WAIT_FIELDS.has(key) && action[key] !== undefined);
  if (extra.length) return { refusal: `a wait carrying ${extra.join(', ')} runs something; it is not a wait` };
  if (!STEPS.includes(action.step)) return { refusal: `a wait at step ${JSON.stringify(action.step)}, which is not a step` };
  if (action.part !== undefined && !(typeof action.part === 'string' && /^[a-z-]{1,24}$/.test(action.part))) return { refusal: 'a wait whose part is not a step part' };
  if (!(Number.isFinite(action.waitMs) && action.waitMs >= 0)) return { refusal: 'a wait with no finite waitMs' };
  if (['yield', 'held'].some((key) => action[key] !== undefined && typeof action[key] !== 'boolean')) return { refusal: 'a wait whose yield or held is not a boolean' };
  return { action: { ...action, instruction: canonicalWaitText(action.waitMs) } };
}

// Deps under which a derivation writes, appends and runs nothing.
export function dryDeps(deps) {
  const none = () => undefined;
  return {
    ...deps, write: none, mkdir: none, append: none, rename: none, remove: none, link: none, truncate: none,
    exec: () => ({ code: 1, stdout: '', stderr: 'a derivation runs no program' }), spawnDetached: () => { throw new Error('a derivation spawns nothing'); },
  };
}

// A phase without its own `derive`: the act its `next` emits now, on a copy.
function derivedByNext(state, deps, phase, action) {
  let spec;
  try {
    spec = phase.next(structuredClone(state), dryDeps(deps));
  } catch (error) {
    return { refusal: `its phase derives no act now (${error.message})` };
  }
  if (spec && typeof spec.then === 'function') return { refusal: `${what(action)}: its phase derives asynchronously` };
  return isObj(spec) && spec.kind !== 'done' && sameAction(spec, action) ? { action } : { refusal: `${what(action)}: it is not the act its phase derives now` };
}

const what = (action) => `${action.step ?? '?'}/${action.part ?? action.kind ?? '?'}`;

// { action }: the act to emit (the stored one, or a wait with its canonical
// text); or { refusal, ...the phase's own fields }. A stored act stamped in
// another phase than the run's is refused: no phase derives it now. A phase
// that marks its refusal `final` refuses a wait too (the build emits only
// yields); otherwise a wait its phase does not derive is judged by its shape.
export function admitAct(state, deps, phase, action) {
  if (!isObj(action)) return { refusal: 'the stored act is not an object' };
  if (action.phase !== undefined && action.phase !== state.phase) return { refusal: `${what(action)}: stamped in phase ${action.phase} while the run is in ${state.phase}` };
  const derived = typeof phase?.derive === 'function' ? phase.derive(state, deps, action) : derivedByNext(state, deps, phase, action);
  if (derived.action) return derived;
  if (action.kind === 'wait' && !derived.final) {
    const wait = waitVerdict(action);
    if (wait.action) return wait;
    return { ...derived, refusal: `${what(action)}: ${wait.refusal}` };
  }
  return derived;
}
