// Phase preapproval: touch 1. Its answer is the run's only source of merge,
// release and budget authority; a (c) answer becomes a checked grant. With an
// operator passkey configured, each granting option carries its grant as a
// signed tag (lib/authority.mjs), and a (c) grant is authority only once its
// own confirm touch is answered (a) and signed.
import { join } from 'node:path';
import { ConductError, appendEvent } from '../state.mjs';
import { ADAPTERS, AGENTS, laneModel } from '../adapters.mjs';
import { QUESTION_MAX, filedLength, openTouch, operatorAnchor, touchAction, recordTouch } from '../touch.mjs';
import { chooseBackend } from '../lanes.mjs';
import { configLine } from '../repo-config.mjs';
import { assertFileable, filingTime, grantConsequence, runGrant } from '../authority.mjs';

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

// Touch 1's question, as intake projects it before it writes anything. Intake
// checks the cap against `bound`: the longest lane wording, with no detail.
export const touchOneQuestion = (state, deps = {}, { bound = false } = {}) => touchOne(state, deps, { bound }).question;

function touchOne(state, deps = {}, { bound = false } = {}) {
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
  const herdr = lanes.backend === 'herdr' && !bound;
  const headless = 'headless (exec), with nothing to watch while they work';
  // Why a herdr server that answers still runs headless lanes. It reads the
  // environment at `next`, after intake checked the cap, so it is dropped
  // when it would overrun the cap.
  const why = !bound && !herdr && state.adapters.herdr?.on ? lanes.detail : null;
  const lanesLine = (detail) => `Lanes: ${herdr ? 'herdr panes you can watch' : detail ? `headless (exec: ${detail}), with nothing to watch while they work` : headless}; agent ${intent.agent}.`;
  // The briefing comes first, as touch 2's does: what the run will do, with
  // what authority, at what cost, and where its lanes can be watched. The
  // probe details the answer rests on follow, under Details.
  // The workspace config's sha256 is always on touch 1 (the anchor receipt):
  // it is the run's pin. The legacy and the none lines are notes, dropped when
  // they would overrun the cap, so a repo without a workspace file is refused
  // at intake exactly when it was before.
  const pinned = intent.repoConfig ?? null;
  const pinLine = pinned?.source === 'workspace' ? configLine(pinned) : null;
  const legacyLine = pinned && pinned.source !== 'workspace' && !bound ? configLine(pinned) : null;
  const render = (detail, legacy) => [
    `Proposed: on ${intent.repo.remote}, spec the goal, build it in lanes, review each PR, then ${noCi
      ? `hold every PR open (no CI on ${intent.repo.remote} can gate a PR, so nothing merges)`
      : `merge it at the gate${release ? ' and run the release recipe' : ''}`}. Budget $${intent.budgetUsd}, ${metered ? 'metered' : 'unmetered'}.`,
    lanesLine(detail),
    goalLine(state),
    `DO: approve, hold, change or decline this run before /spec starts. EXPECT: (a) the run goes as proposed; (b) it builds and reviews, and every PR stays open; (c) your text becomes a grant no wider than (a); (d) it closes with no writes to the repo.`,
    'Details:',
    `Repo: ${intent.repo.path} (${intent.repo.remote}, default branch ${intent.repo.defaultBranch})`,
    `Adapters: ${ADAPTERS.map((name) => `${name} ${describe(state.adapters[name])}`).join('; ')}`,
    `Agents: ${AGENTS.map((name) => `${name} ${describe(state.agents[name])}`).join('; ')}`,
    `Lane agent: ${intent.agent}; models: opus = ${laneModel(intent.agent, 'opus')}, sonnet = ${laneModel(intent.agent, 'sonnet')}`,
    release ? `Release recipe: ${JSON.stringify(intent.release)}` : 'release: none',
    ...(pinLine ? [pinLine] : legacy ? [legacy] : []),
    noCi
      ? `CI workflows that can gate a PR: ${intent.ciWorkflows ?? 'unreadable, treated as 0'}. No CI workflows exist on ${intent.repo.remote} that can gate a PR, so only hold-at-PR authority is offered: (b), (c) capped at no merge and no release, or (d).`
      : `CI workflows that can gate a PR: ${ci}`,
    // The greenfield trigger widens WP-01's scope: the operator sees it before approving.
    ...(intent.greenfield?.on ? [`Greenfield (${intent.greenfield.why.join('; ')}): WP-01 (WP-00 in a one-WP run) also adds the bootstrap manifest's missing files, and its gate holds until \`conduct bootstrap --offline\` passes.`] : []),
    budget,
  ].join('\n');
  const fits = (text) => filedLength(state, 1, text) <= QUESTION_MAX;
  const candidates = [why && legacyLine ? render(why, legacyLine) : null, why ? render(why, null) : null, legacyLine ? render(null, legacyLine) : null];
  const question = candidates.find((text) => text && fits(text)) ?? render(null, null);
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

const DECLINE = 'The run closes with no writes to the repo.';

// openTouch copies a fixed field list, so the grants land on the touch after
// it; a core run's touch record is written again to carry them.
function attachGrants(state, touch, grants, deps) {
  touch.grants = grants;
  if (state.adapters?.spine?.on !== true) deps.write(join(state.runDir, 'touches', `${touch.n}.json`), `${JSON.stringify(touch, null, 2)}\n`);
}

// Touch 1 with an operator passkey configured: (a) and (b), each with the
// grant it confers, rendered and tagged. Unconfigured, the spec is today's.
function grantedTouchOne(state, spec, deps) {
  if (!operatorAnchor(deps).configured) return { spec, grants: null };
  const proposed = proposal(state);
  const confers = { a: { merge: proposed.merge, release: proposed.release }, b: { merge: false, release: false } };
  const filedAt = filingTime(deps);
  const grants = {};
  const options = spec.options.map((option) => {
    if (!Object.hasOwn(confers, option.key)) return option;
    grants[option.key] = runGrant(state, { ...confers[option.key], budgetUsd: proposed.budgetUsd, scope: state.intent.goal }, filedAt);
    return { ...option, consequence: grantConsequence(grants[option.key]) };
  });
  assertFileable(options, 'touch 1');
  return { spec: { ...spec, options }, grants };
}

function openTouchOne(state, deps) {
  const { spec, grants } = grantedTouchOne(state, touchOne(state, deps), deps);
  const touch = openTouch(state, spec, deps);
  if (grants) attachGrants(state, touch, grants, deps);
  return touch;
}

export function next(state, deps) {
  const touch = state.touches.at(-1) ?? openTouchOne(state, deps);
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
    const one = state.touches[0];
    // Touch 1's options are copied whole, their tags included, and so are their grants.
    const options = one.options.filter((option) => option.key !== 'c');
    const reask = openTouch(state, {
      kind: 'blocked',
      question: `The (c) answer to touch ${touch.n} does not settle a grant field (${grant.why ?? 'no reason given'}). The operator's text: "${text}". DO: pick one of touch ${touch.n}'s other options. EXPECT: the run continues with that authority, or closes on (d).`,
      options,
      allowFreeText: false,
      did: `conduct ${state.slug}: touch ${touch.n} answered (c), but the grant was ambiguous`,
    }, deps);
    if (one.grants) attachGrants(state, reask, Object.fromEntries(options.filter((option) => Object.hasOwn(one.grants, option.key)).map((option) => [option.key, one.grants[option.key]])), deps);
    return;
  }
  const checked = validateGrant(grant, proposal(state), state.intent.goal);
  if (!checked.ok) throw new ConductError(2, `grant ${path}: ${checked.problems.join('; ')}`);
  // Configured, the grant must be confirmed on the phone: built (and checked
  // against E7) before anything is written, so a refusal leaves no trace.
  const confirm = operatorAnchor(deps).configured ? confirmTouch(state, touch, grant, text, deps) : null;
  // The authored grant stays as written, so a retry after a failed save
  // re-validates the same input. The record /spec --preapproved names is a
  // separate file, a copy of the authority this record commits; state.json's
  // `authority` stays the authority (a file saying `validated: true` is not).
  const { merge, release, budgetUsd, scope } = grant;
  const published = `touches/${touch.n}-authority.json`;
  deps.write(join(state.runDir, published), `${JSON.stringify({ merge, release, budgetUsd, scope, validated: true, touch: touch.n, grant: `touches/${touch.n}-grant.json`, answer: touch.answer }, null, 2)}\n`);
  if (confirm) {
    // Zero until the signed confirm lands; the pointers /spec and
    // verifiedAuthority follow exist from the start.
    state.authority = {
      merge: false, release: false, budgetUsd: 0, scope,
      metered: state.authority.metered, notes: text, grant: `touches/${touch.n}-grant.json`, record: published, confirmTouch: null,
    };
    attachGrants(state, openTouch(state, confirm.spec, deps), { a: confirm.grant }, deps);
    return;
  }
  state.authority = {
    merge, release, budgetUsd, scope,
    metered: state.authority.metered, notes: text, grant: `touches/${touch.n}-grant.json`, record: published,
  };
  state.phase = 'spec';
}

// The (c) grant as the operator confirms it: the scope and their text in the
// question, the grant tagged on (a). A scope too long for the question is cut,
// naming the file that holds it whole; its hash is in the tagged grant.
function confirmTouch(state, touch, grant, text, deps) {
  const filed = runGrant(state, { budgetUsd: grant.budgetUsd, merge: grant.merge, release: grant.release, scope: grant.scope }, filingTime(deps));
  const options = [
    { key: 'a', label: 'Confirm', consequence: grantConsequence(filed) },
    { key: 'd', label: 'Decline', consequence: DECLINE },
  ];
  assertFileable(options, 'the confirm touch');
  const n = state.touches.length + 1;
  const head = `Confirm grant for run ${state.runId}:`;
  const quoted = `The operator's text: "${text}"`;
  const lines = (scope) => [head, `Scope: ${scope}`, quoted].join('\n');
  let question = lines(grant.scope);
  if (filedLength(state, n, question) > QUESTION_MAX) {
    const cut = `… (full text: touches/${touch.n}-grant.json)`;
    const room = QUESTION_MAX - filedLength(state, n, lines(cut));
    if (room < 1) {
      throw new ConductError(2, `E7: the confirm question is ${filedLength(state, n, question)} chars filed, and ${filedLength(state, n, lines(cut))} with its Scope: line cut, over spine_receipt's ${QUESTION_MAX}-char cap (the operator's text is ${text.length} chars)`);
    }
    question = lines(`${grant.scope.slice(0, room)}${cut}`);
  }
  return {
    spec: { kind: 'preapproval-confirm', question, options, allowFreeText: false, did: `conduct ${state.slug}: touch ${touch.n} answered (c); its grant waits on the operator's signed confirm` },
    grant: filed,
  };
}

// The confirm's answer: (a) makes the (c) grant the run's authority, (d)
// declines, and any other key is refused: the confirm re-opens saying why
// (exit 3). applyAnswer never runs for it. The authority record gains the
// confirm, whose signed block /spec verifies.
function recordConfirm(state, touch, deps) {
  const { key } = touch.answer;
  if (key === 'd') {
    state.phase = 'declined';
    return undefined;
  }
  if (key !== 'a') {
    const refusal = `answer ${key ?? '(no key)'} is not usable here: only (a) confirms and (d) declines`;
    Object.assign(touch, { status: 'open', answer: null, refusal, waiting: false });
    appendEvent(state, deps, { step: 'touch', event: 'answer-refused', data: { n: touch.n, why: refusal } });
    if (state.adapters?.spine?.on !== true) deps.write(join(state.runDir, 'touches', `${touch.n}.json`), `${JSON.stringify(touch, null, 2)}\n`);
    return { refused: refusal };
  }
  const path = join(state.runDir, state.authority.record);
  let record;
  try {
    record = JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `authority record ${path} cannot be read: ${error.message}`);
  }
  record.confirm = { touch: touch.n, receiptId: touch.receiptId, answer: touch.answer, options: touch.options, grants: touch.grants };
  deps.write(path, `${JSON.stringify(record, null, 2)}\n`);
  // The display cache; acts recompute it from the signed confirm.
  Object.assign(state.authority, { merge: record.merge, release: record.release, budgetUsd: record.budgetUsd, confirmTouch: touch.n });
  state.phase = 'spec';
  return undefined;
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
  const outcome = recordTouch(state, touch, action, result, deps);
  if (touch.status !== 'answered') return outcome;
  // On the touch's own kind: touchStep names every kind but preapproval and showcase 'touch'.
  if (touch.kind === 'preapproval-confirm') return recordConfirm(state, touch, deps) ?? outcome;
  applyAnswer(state, touch);
  return outcome;
}
