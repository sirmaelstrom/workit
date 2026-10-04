// Phase spec: run /spec under the touch-1 pre-approval, read back the depth it
// chose, and turn depth none|lite into the single WP-00 record.
import { join, resolve } from 'node:path';
import { ConductError } from '../state.mjs';

// The touch whose answer set the authority: touch 1, or its blocked re-ask.
function approvingTouch(state) {
  return state.touches.filter((touch) => touch.status === 'answered' && touch.wpId === null).at(-1);
}

export function preapprovedRef(state) {
  const touch = approvingTouch(state);
  if (state.adapters.spine?.on) return `spine:${state.intent.anchor}@${touch.answer.answeredAt} by ${touch.answer.by}`;
  return `core:${state.runDir}/touches/${touch.n}.json`;
}

export function next(state) {
  return {
    kind: 'skill', step: 'spec', skill: 'workit:spec',
    skillArgs: `${state.intent.goal} --workshop ${state.workshopDir} --preapproved "${preapprovedRef(state)}"`,
    expects: { type: 'json', fields: ['depth', 'workshopDir'] },
    instruction: 'Invoke the skill with these args. /spec reports in prose; record a JSON object you compose from its report: { "depth": "none|lite|deep", "workshopDir": "<the workshop it wrote to>", "reviewLevel": "<its review level, if any>", "gateCommand": "<the repo\'s gate command; required for none and lite>", "wps": [<deep only: one record per WP>] }.',
  };
}

export function wpRecord(fields) {
  return {
    id: fields.id, name: fields.name ?? '', specPath: fields.specPath ?? null, wave: fields.wave ?? 1,
    files: fields.files ?? [], dependsOn: fields.dependsOn ?? [], tier: fields.tier ?? 'T1', model: fields.model ?? 'opus',
    runtimeExercise: fields.runtimeExercise ?? '',
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
    `**Gate command:** \`${gateCommand}\``, '', `**Runtime exercise:** ${exercise}`, '',
  ].join('\n'));
  return { path, runtimeExercise: exercise };
}

export function record(state, action, result, deps) {
  const { depth, workshopDir, reviewLevel = null, gateCommand = null } = result ?? {};
  if (!['none', 'lite', 'deep'].includes(depth)) throw new ConductError(2, `spec result depth must be none, lite or deep (got ${depth})`);
  if (typeof workshopDir !== 'string' || resolve(workshopDir) !== resolve(state.workshopDir)) {
    throw new ConductError(2, `spec result workshopDir ${workshopDir} is not this run's workshop ${state.workshopDir}`);
  }
  if (depth !== 'deep' && (typeof gateCommand !== 'string' || !gateCommand.trim())) {
    throw new ConductError(2, `spec result needs a gateCommand for depth ${depth}`);
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
    // Interim: deep WPs come from the record's `wps` array until WP-06
    // switches mint to parseWorkPackages(workshopDir).
    if (!Array.isArray(result.wps) || result.wps.length === 0 || !result.wps.every((wp) => typeof wp?.id === 'string')) {
      throw new ConductError(2, 'a deep spec result needs a non-empty wps array, each with an id');
    }
    state.wps = result.wps.map(wpRecord);
  }
  state.phase = 'mint';
}
