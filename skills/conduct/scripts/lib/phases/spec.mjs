// Phase spec: run /spec under the touch-1 pre-approval, read back the depth it
// chose, and turn depth none|lite into the single WP-00 record.
import { join, resolve, win32 } from 'node:path';
import { ConductError } from '../state.mjs';

// The touch whose answer set the authority: touch 1, or its blocked re-ask.
function approvingTouch(state) {
  return state.touches.filter((touch) => touch.status === 'answered' && touch.wpId === null).at(-1);
}

// The record that carries the run's authority: a (c) answer's validated grant
// (scope included), else the answering touch (scope = the goal verbatim).
export function preapprovedRef(state) {
  if (state.authority.record) return `core:${state.runDir}/${state.authority.record}`;
  const touch = approvingTouch(state);
  if (state.adapters.spine?.on) return `spine:${state.intent.anchor}@${touch.answer.answeredAt} by ${touch.answer.by}`;
  return `core:${state.runDir}/touches/${touch.n}.json`;
}

// Equal paths, allowing win32's case-insensitivity and Git Bash's /d/… form.
export function samePath(a, b, platform) {
  if (platform !== 'win32') return resolve(a) === resolve(b);
  const normalize = (path) => win32.resolve(path.replace(/^\/([a-z])(\/|$)/i, '$1:/')).toLowerCase();
  return normalize(a) === normalize(b);
}

export function next(state) {
  const ref = preapprovedRef(state);
  return {
    kind: 'skill', step: 'spec', skill: 'workit:spec',
    // skillArgv is the transport (one element per argument, nothing to quote);
    // skillArgs is its display form.
    skillArgv: [state.intent.goal, '--workshop', state.workshopDir, '--preapproved', ref],
    skillArgs: `${state.intent.goal} --workshop ${state.workshopDir} --preapproved "${ref}"`,
    expects: { type: 'json', fields: ['depth', 'workshopDir'] },
    instruction: 'Invoke the skill with skillArgv, one argument per element. /spec reports in prose; record a JSON object you compose from its report: { "depth": "none|lite|deep", "workshopDir": "<the workshop it wrote to>", "reviewLevel": "<its review level, if any>", "gateCommand": "<the repo\'s gate command; required for none and lite>", "wps": [<deep only: one record per WP, with its precondition and verification>] }.',
  };
}

export function wpRecord(fields) {
  return {
    id: fields.id, name: fields.name ?? '', specPath: fields.specPath ?? null, wave: fields.wave ?? 1,
    files: fields.files ?? [], dependsOn: fields.dependsOn ?? [], tier: fields.tier ?? 'T1', model: fields.model ?? 'opus',
    runtimeExercise: fields.runtimeExercise ?? '', precondition: fields.precondition ?? null, verification: fields.verification ?? null,
    questId: null, state: 'pending', reason: null, dispatchedAt: null, queue: [],
    lane: null, runtimeVerdict: null, rulings: [], pr: null, reviews: [], rebases: [], gate: null, merge: null,
  };
}

function runtimeExerciseField(text) {
  return /^\*\*Runtime exercise:\*\*[ \t]*(.*)$/m.exec(text)?.[1].trim() ?? '';
}

function writeWp00(state, gateCommand, deps) {
  const path = join(state.runDir, 'wp-00.md');
  const exercise = 'name the surface this change alters at runtime and the check that exercises it (the command and what it prints), or `none: <why>`.';
  deps.write(path, [
    '# WP-00', '', '**Goal (verbatim):**', '', state.intent.goal, '',
    `**Approved scope:** ${state.authority.scope}`, '',
    `**Gate command:** \`${gateCommand}\``, '', `**Runtime exercise:** ${exercise}`, '',
  ].join('\n'));
  return { path, runtimeExercise: exercise };
}

export function record(state, action, result, deps) {
  const { depth, workshopDir, reviewLevel = null, gateCommand = null } = result ?? {};
  if (!['none', 'lite', 'deep'].includes(depth)) throw new ConductError(2, `spec result depth must be none, lite or deep (got ${depth})`);
  if (typeof workshopDir !== 'string' || !samePath(workshopDir, state.workshopDir, deps.platform)) {
    throw new ConductError(2, `spec result workshopDir ${workshopDir} is not this run's workshop ${state.workshopDir}`);
  }
  if (depth !== 'deep' && (typeof gateCommand !== 'string' || !gateCommand.trim())) {
    throw new ConductError(2, `spec result needs a gateCommand for depth ${depth}`);
  }
  // A deep run's WPs come from the workshop (mint, parseWorkPackages); a
  // `wps` list in the record is optional and only checked for shape.
  if (depth === 'deep' && result.wps !== undefined) {
    if (!Array.isArray(result.wps) || !result.wps.every((wp) => typeof wp?.id === 'string')) {
      throw new ConductError(2, 'a deep spec result\'s wps, when given, is an array of records with an id');
    }
    const ids = result.wps.map((wp) => wp.id.toLowerCase());
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new ConductError(2, `the spec result lists WP id ${duplicate} twice`);
  }
  state.spec = { ...state.spec, depth, reviewLevel, gateCommand };
  if (depth === 'none') {
    const wp00 = writeWp00(state, gateCommand, deps);
    state.wps = [wpRecord({ id: 'WP-00', name: state.intent.goal, specPath: wp00.path, runtimeExercise: wp00.runtimeExercise })];
  } else if (depth === 'lite') {
    const specPath = join(state.workshopDir, 'spec.md');
    const text = deps.exists(specPath) ? deps.read(specPath) : '';
    state.wps = [wpRecord({ id: 'WP-00', name: state.intent.goal, specPath, runtimeExercise: runtimeExerciseField(text) })];
  } else {
    state.wps = [];
  }
  state.phase = 'mint';
}
