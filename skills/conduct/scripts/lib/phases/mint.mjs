// Phase mint: a deep spec's WP list comes from its workshop through
// parseWorkPackages; with spine on, one spine_author call then mints a
// confident quest per WP under the anchor's campaign. Depth none|lite reuses
// the anchor as WP-00's quest; spine off mints nothing.
import { basename, join } from 'node:path';
import { ConductError } from '../state.mjs';
import { parseWorkPackages } from '../schedule.mjs';
import { wpRecord } from './spec.mjs';

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

// The workshop's WPs replace the spec record's list, each keeping its wave,
// files, tier and dependencies. A WP the scheduler cannot parse is a spec
// defect: `next` exits 2 naming it and writes nothing, and runs again once the
// workshop is fixed. A workshop with no orchestrator keeps the spec record's
// list (conduct.test.mjs pins that path).
function workshopWps(state, deps) {
  if (state.spec.depth !== 'deep' || !deps.exists(join(state.workshopDir, 'work-packages', '_orchestrator.md'))) return;
  let parsed;
  try {
    parsed = parseWorkPackages(state.workshopDir, { read: deps.read, list: deps.list });
  } catch (error) {
    if (!(error instanceof ConductError)) throw error;
    throw new ConductError(2, `spec defect in ${state.workshopDir}: ${error.message}. Fix the work package, then run next again.`);
  }
  const prior = new Map(state.wps.map((wp) => [wp.id, wp]));
  state.wps = parsed.map((wp) => wpRecord({ ...wp, verification: prior.get(wp.id)?.verification ?? null }));
}

export function next(state, deps) {
  workshopWps(state, deps);
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
