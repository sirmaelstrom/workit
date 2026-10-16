// Phase mint: a deep spec's WP list comes from its workshop through
// parseWorkPackages; with spine on, one spine_author call then mints a
// confident quest per WP under the anchor's campaign. Depth none|lite reuses
// the anchor as WP-00's quest; spine off mints nothing.
import { basename, join } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { parseDesignDirection, parseWorkPackages } from '../schedule.mjs';
import { wpRecord } from './spec.mjs';
import { bindBootstrap } from '../bootstrap.mjs';

// spine_author is idempotent per (campaign, key), so a bare `wp-01`, or one
// keyed by the goal's slug alone, would reuse another run's quest: the key
// carries the slug and the run id (persisted, so stable within the run). One
// function serves the quests, the seams and the result mapping.
export function questKey(state, wp) {
  return `${state.slug}-${state.runId}-${wp.id}`.toLowerCase();
}

function resumeNote(wp) {
  return [wp.specPath ?? '(no WP path)', `precondition: ${wp.precondition ?? 'see the WP'}`, `verification: ${wp.verification ?? 'see the WP'}`,
    `review tier: ${wp.tier}`, `runtime exercise: ${wp.runtimeExercise || 'unnamed'}`].join(' · ');
}

// A deep run's WPs come only from its workshop, each keeping its wave, files,
// tier and dependencies. A missing orchestrator, a workshop with no WP, or a
// WP the scheduler cannot parse is a spec defect: `next` exits 2 naming it and
// writes nothing, and runs again once the workshop is fixed.
function workshopWps(state, deps) {
  const defect = (why) => new ConductError(2, `spec defect in ${state.workshopDir}: ${why}. Fix the workshop, then run next again.`);
  const orchestrator = join(state.workshopDir, 'work-packages', '_orchestrator.md');
  if (!deps.exists(orchestrator)) throw defect(`${orchestrator} is missing`);
  let parsed;
  try {
    parsed = parseWorkPackages(state.workshopDir, { read: deps.read, list: deps.list });
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    throw defect(error.message);
  }
  if (!parsed.length) throw defect(`${join(state.workshopDir, 'work-packages')} holds no wp-*.md work package`);
  state.wps = parsed.map(wpRecord);
  // The rules the merge gate reads a UI WP's frames against (parseWorkPackages checked them).
  const rules = parseDesignDirection(deps.read(orchestrator), orchestrator);
  state.design = rules.length ? { source: orchestrator, rules } : null;
  appendEvent(state, deps, { step: 'mint', event: 'minted', data: { wps: parsed.length, source: 'workshop' } });
}

// A greenfield run (intake's trigger, quest 977d3efb) binds the bootstrap
// manifest's paths to WP-01 (else WP-00) once, before any quest is minted.
// A deep mint re-entered before its spine_author result re-parses the
// workshop, so the binding is recomputed; the event is written only when the
// binding differs from the one already recorded (council review 1).
function bindGreenfield(state, deps) {
  if (!state.intent.greenfield?.on || state.wps.some((wp) => wp.bootstrap)) return;
  const wp = bindBootstrap(state, deps);
  if (!wp) throw new ConductError(2, 'spec defect: a greenfield run needs a WP to carry the bootstrap, and the spec has none');
  const bound = { wp: wp.id, files: wp.bootstrap.files, failing: wp.bootstrap.failing };
  if (JSON.stringify(state.intent.greenfield.bound ?? null) === JSON.stringify(bound)) return;
  state.intent.greenfield.bound = bound;
  appendEvent(state, deps, { step: 'mint', event: 'bootstrap-bound', data: bound });
}

export function next(state, deps) {
  if (state.spec.depth === 'deep') workshopWps(state, deps);
  bindGreenfield(state, deps);
  if (!state.adapters.spine?.on || state.spec.depth !== 'deep') {
    if (state.adapters.spine?.on) state.wps[0].questId = state.intent.anchor;
    state.phase = 'build';
    return null;
  }
  const project = basename(state.intent.repo.remote ?? state.intent.repo.path);
  return {
    kind: 'agent-tool', step: 'mint', tool: 'spine_author', expects: { type: 'json' },
    instruction: 'Call spine_author with these args and record its raw result.',
    args: {
      campaign: { title: state.intent.campaign.title },
      quests: state.wps.map((wp) => ({
        key: questKey(state, wp), title: `${wp.id}: ${wp.name} (${state.slug})`, provisional: false, project,
        resumeNote: resumeNote(wp), ...(wp.specPath ? { artifacts: [{ type: 'file', locator: wp.specPath }] } : {}),
      })),
      seams: state.wps.map((wp) => ({ from: state.intent.anchor, to: questKey(state, wp), type: 'decomposition' })),
    },
  };
}

export function record(state, action, result) {
  const ids = new Map((result?.quests ?? []).map((quest) => [quest.key, quest.id]));
  const unmapped = state.wps.filter((wp) => typeof ids.get(questKey(state, wp)) !== 'string').map((wp) => wp.id);
  if (unmapped.length) throw new ConductError(2, `spine_author result has no quest for ${unmapped.join(', ')}`);
  for (const wp of state.wps) wp.questId = ids.get(questKey(state, wp));
  state.phase = 'build';
}
