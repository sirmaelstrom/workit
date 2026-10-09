// Phase preapproval: touch 1. Its answer is the run's only source of merge,
// release and budget authority; a (c) answer becomes a checked grant.
import { join } from 'node:path';
import { ConductError } from '../state.mjs';
import { ADAPTERS, AGENTS, laneModel } from '../adapters.mjs';
import { openTouch, touchAction, recordTouch } from '../touch.mjs';
import { chooseBackend } from '../lanes.mjs';

const GRANT_KEYS = ['merge', 'release', 'budgetUsd', 'scope'];

// Option (a)'s authority: the ceiling every (c) grant is checked against.
// With no CI workflows, nothing may merge or release.
export function proposal(state) {
  const ci = (state.intent.ciWorkflows ?? 0) > 0;
  return { merge: ci, release: ci && state.intent.release !== null, budgetUsd: state.intent.budgetUsd, scope: state.intent.goal };
}

export function validateGrant(grant, proposed, goal) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return { ok: false, problems: ['grant must be a JSON object'] };
  const problems = [];
  for (const key of Object.keys(grant)) if (!GRANT_KEYS.includes(key)) problems.push(`unknown key: ${key}`);
  if (typeof grant.budgetUsd !== 'number' || !Number.isFinite(grant.budgetUsd) || grant.budgetUsd < 0) {
    problems.push('budgetUsd must be a non-negative number');
  } else if (grant.budgetUsd > proposed.budgetUsd) {
    problems.push(`budgetUsd ${grant.budgetUsd} exceeds the proposed $${proposed.budgetUsd}`);
  }
  for (const key of ['merge', 'release']) {
    if (typeof grant[key] !== 'boolean') problems.push(`${key} must be a boolean`);
    else if (grant[key] && !proposed[key]) problems.push(`${key} is wider than option (a), which does not grant it`);
  }
  if (grant.release === true && grant.merge !== true) problems.push('release requires merge: the release runs only after every WP merged');
  // Whether a narrower scope really narrows the goal is the agent's reading
  // of the operator's text; no code can check it (ASSUMPTION).
  if (typeof grant.scope !== 'string' || !grant.scope.trim()) problems.push(`scope must be a non-empty string (the goal verbatim, or a narrowing of: ${goal})`);
  return { ok: problems.length === 0, problems };
}

function describe(entry) {
  return `${entry.on ? 'on' : 'off'} (${entry.evidence}: ${entry.detail})`;
}

// A goal longer than this is cited by its file, its length and its opening.
const GOAL_INLINE = 300;
export const goalPath = (state) => join(state.runDir, 'goal.md');

function goalLine(state) {
  const goal = String(state.intent.goal);
  if (goal.length <= GOAL_INLINE && !goal.includes('\n')) return `Goal: ${goal}`;
  const opening = goal.split('\n').find((line) => line.trim())?.trim() ?? '';
  return `Goal: ${goal.length} chars, in full at ${goalPath(state)}. It opens: "${opening.length > 160 ? `${opening.slice(0, 160)}…` : opening}"`;
}

// Touch 1's question, as intake projects it before it writes anything.
export const touchOneQuestion = (state, deps = {}) => touchOne(state, deps).question;

function touchOne(state, deps = {}) {
  const { intent } = state;
  const ci = intent.ciWorkflows ?? 0;
  const noCi = ci === 0;
  const release = intent.release !== null;
  const metered = state.adapters.spend?.on === true;
  const budget = metered
    ? `Budget: $${intent.budgetUsd}, metered by the spend adapter.`
    : `Budget: $${intent.budgetUsd} unmetered: no spend adapter; exec claude lanes' total_cost_usd is summed as a lane-only lower bound and enforced as one.`;
  // The backend dispatch will pick: a herdr server that answers runs headless lanes for a repo outside a projects tree.
  const lanes = chooseBackend(state, deps);
  const herdr = lanes.backend === 'herdr';
  // The briefing comes first, as touch 2's does: what the run will do, with
  // what authority, at what cost, and where its lanes can be watched. The
  // probe details the answer rests on follow, under Details.
  const question = [
    `Proposed: on ${intent.repo.remote}, spec the goal, build it in lanes, review each PR, then ${noCi
      ? `hold every PR open (no CI on ${intent.repo.remote} can gate a PR, so nothing merges)`
      : `merge it at the gate${release ? ' and run the release recipe' : ''}`}. Budget $${intent.budgetUsd}, ${metered ? 'metered' : 'unmetered'}.`,
    `Lanes: ${herdr ? 'herdr panes you can watch' : `headless (exec${state.adapters.herdr?.on ? `: ${lanes.detail}` : ''}), with nothing to watch while they work`}; agent ${intent.agent}.`,
    goalLine(state),
    `DO: approve, hold, change or decline this run before /spec starts. EXPECT: (a) the run goes as proposed; (b) it builds and reviews, and every PR stays open; (c) your text becomes a grant no wider than (a); (d) it closes with no writes to the repo.`,
    'Details:',
    `Repo: ${intent.repo.path} (${intent.repo.remote}, default branch ${intent.repo.defaultBranch})`,
    `Adapters: ${ADAPTERS.map((name) => `${name} ${describe(state.adapters[name])}`).join('; ')}`,
    `Agents: ${AGENTS.map((name) => `${name} ${describe(state.agents[name])}`).join('; ')}`,
    `Lane agent: ${intent.agent}; models: opus = ${laneModel(intent.agent, 'opus')}, sonnet = ${laneModel(intent.agent, 'sonnet')}`,
    release ? `Release recipe: ${JSON.stringify(intent.release)}` : 'release: none',
    noCi
      ? `CI workflows that can gate a PR: ${intent.ciWorkflows ?? 'unreadable, treated as 0'}. No CI workflows exist on ${intent.repo.remote} that can gate a PR, so only hold-at-PR authority is offered: (b), (c) capped at no merge and no release, or (d).`
      : `CI workflows that can gate a PR: ${ci}`,
    budget,
  ].join('\n');
  const options = [
    { key: 'a', label: 'Approve as proposed', consequence: `Merge each PR at the gate, ${release ? 'run the release recipe' : 'no release (no recipe)'}, budget $${intent.budgetUsd}.` },
    { key: 'b', label: 'Approve, but hold at PR boundaries', consequence: 'The run builds and reviews; every PR stays open for the showcase, and nothing merges or releases.' },
    { key: 'c', label: 'Approve with changes', consequence: 'Type the changes (scope, budget, authority); they become a grant checked against (a).' },
    { key: 'd', label: 'Decline', consequence: 'The run closes with no writes to the repo.' },
  ].filter((option) => !(noCi && option.key === 'a'));
  return { kind: 'preapproval', question, options, allowFreeText: true, did: `conduct ${state.slug}: intake done on ${intent.repo.remote}; nothing specced or built yet` };
}

function grantPath(state, touch) {
  return join(state.runDir, 'touches', `${touch.n}-grant.json`);
}

export function next(state, deps) {
  const touch = state.touches.at(-1) ?? openTouch(state, touchOne(state, deps), deps);
  if (touch.status === 'answered' && touch.answer.key === 'c') {
    const outPath = grantPath(state, touch);
    return {
      kind: 'author', step: 'grant', touch: { n: touch.n }, outPath, expects: { type: 'file' },
      instruction: `Write ${outPath} = { "merge": <bool>, "release": <bool>, "budgetUsd": <number>, "scope": "<the goal, or the narrowing the text states>" } from the operator's text, each field no wider than option (a) ${JSON.stringify(proposal(state))}; write { "ambiguous": true, "why": "<which field the text does not settle>" } when it does not settle a field. Then record this action with {}. The operator's text: ${touch.answer.text ?? '(none)'}`,
    };
  }
  return touchAction(state, touch);
}

function readGrant(path, deps) {
  if (!deps.exists(path)) throw new ConductError(2, `grant file ${path} was not written`);
  try {
    return JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `grant file ${path} is not valid JSON: ${error.message}`);
  }
}

function recordGrant(state, touch, deps) {
  const path = grantPath(state, touch);
  const grant = readGrant(path, deps);
  const text = touch.answer.text ?? '';
  if (grant?.ambiguous === true) {
    openTouch(state, {
      kind: 'blocked',
      question: `The (c) answer to touch ${touch.n} does not settle a grant field (${grant.why ?? 'no reason given'}). The operator's text: "${text}". DO: pick one of touch ${touch.n}'s other options. EXPECT: the run continues with that authority, or closes on (d).`,
      options: state.touches[0].options.filter((option) => option.key !== 'c'),
      allowFreeText: false,
      did: `conduct ${state.slug}: touch ${touch.n} answered (c), but the grant was ambiguous`,
    }, deps);
    return;
  }
  const checked = validateGrant(grant, proposal(state), state.intent.goal);
  if (!checked.ok) throw new ConductError(2, `grant ${path}: ${checked.problems.join('; ')}`);
  // The authored grant stays as written, so a retry after a failed save
  // re-validates the same input. The record /spec --preapproved names is a
  // separate file, a copy of the authority this record commits; state.json's
  // `authority` stays the authority (a file saying `validated: true` is not).
  const { merge, release, budgetUsd, scope } = grant;
  const published = `touches/${touch.n}-authority.json`;
  deps.write(join(state.runDir, published), `${JSON.stringify({ merge, release, budgetUsd, scope, validated: true, touch: touch.n, grant: `touches/${touch.n}-grant.json`, answer: touch.answer }, null, 2)}\n`);
  state.authority = {
    merge, release, budgetUsd, scope,
    metered: state.authority.metered, notes: text, grant: `touches/${touch.n}-grant.json`, record: published,
  };
  state.phase = 'spec';
}

function applyAnswer(state, touch) {
  const { key } = touch.answer;
  if (key === 'c') return;
  if (key === 'd') {
    state.phase = 'declined';
    return;
  }
  const merge = key === 'a' && proposal(state).merge;
  state.authority = {
    merge, release: merge && state.intent.release !== null, budgetUsd: state.intent.budgetUsd,
    metered: state.authority.metered, scope: state.intent.goal, notes: null, grant: null,
  };
  state.phase = 'spec';
}

export function record(state, action, result, deps) {
  const touch = state.touches[action.touch.n - 1];
  if (action.step === 'grant') return recordGrant(state, touch, deps);
  const outcome = recordTouch(state, touch, action, result);
  if (touch.status === 'answered') applyAnswer(state, touch);
  return outcome;
}
