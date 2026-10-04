// Phase mint: with spine on and a deep spec, one spine_author call mints a
// confident quest per WP under the anchor's campaign. Depth none|lite reuses
// the anchor as WP-00's quest; spine off mints nothing.
import { basename } from 'node:path';
import { ConductError } from '../state.mjs';

function questKey(wp) {
  return wp.id.toLowerCase();
}

function resumeNote(wp) {
  return [wp.specPath ?? '(no WP path)', `precondition: ${wp.precondition ?? 'see the WP'}`, `verification: ${wp.verification ?? 'see the WP'}`,
    `review tier: ${wp.tier}`, `runtime exercise: ${wp.runtimeExercise || 'unnamed'}`].join(' · ');
}

export function next(state) {
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
        key: questKey(wp), title: `${wp.id}: ${wp.name} (${state.slug})`, provisional: false, project,
        resumeNote: resumeNote(wp), ...(wp.specPath ? { artifacts: [{ type: 'file', locator: wp.specPath }] } : {}),
      })),
      seams: state.wps.map((wp) => ({ from: state.intent.anchor, to: questKey(wp), type: 'decomposition' })),
    },
  };
}

export function record(state, action, result) {
  const ids = new Map((result?.quests ?? []).map((quest) => [quest.key, quest.id]));
  const unmapped = state.wps.filter((wp) => typeof ids.get(questKey(wp)) !== 'string').map((wp) => wp.id);
  if (unmapped.length) throw new ConductError(2, `spine_author result has no quest for ${unmapped.join(', ')}`);
  for (const wp of state.wps) wp.questId = ids.get(questKey(wp));
  state.phase = 'build';
}
