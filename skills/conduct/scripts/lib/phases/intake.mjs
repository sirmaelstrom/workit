// Phase intake (spine on only): read the anchor quest, store its campaign and
// full uuid, then hand over to preapproval, which opens touch 1.
import { ConductError } from '../state.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function next(state) {
  return {
    kind: 'agent-tool', step: 'anchor', tool: 'spine_quest', args: { ids: [state.intent.anchor] },
    expects: { type: 'json' }, instruction: 'Call spine_quest with these args and record its raw result.',
  };
}

export function record(state, action, result) {
  const quest = result?.quests?.[0];
  if (typeof quest?.id !== 'string' || !quest.id.startsWith(state.intent.anchor)) {
    throw new ConductError(2, `spine_quest result does not carry the anchor ${state.intent.anchor}`);
  }
  // Every touch is signed over the full quest uuid, so a prefix never stands in for it.
  if (!UUID.test(quest.id)) throw new ConductError(2, `spine_quest returned the anchor as ${JSON.stringify(quest.id)}, not a full quest uuid`);
  if (typeof quest.campaign?.title !== 'string') throw new ConductError(2, 'the anchor quest has no campaign title');
  state.intent.anchor = quest.id;
  state.intent.campaign = { slug: quest.campaign.slug, title: quest.campaign.title };
  state.phase = 'preapproval';
}
