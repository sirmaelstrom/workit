// How spend is described (7c728631). The run's reported figure is the sum of
// the lanes' logged cost: exec claude lanes log total_cost_usd when a session
// closes, and T3, codex and herdr lanes log none, so the figure is a lower
// bound. Every line that prints a spend figure gets its words here: a reported
// figure is called a lower bound and names the lanes it counted and the ones
// it did not; a committed figure is the lower bound plus lane estimates. The
// sites compute and format their own numbers (each keeps its money format);
// nothing here computes a figure or formats money.

// The per-lane estimate with no logged lane cost and no repo config (build.mjs laneProjection).
export const DEFAULT_LANE_ESTIMATE_USD = 15;

// The committed figure the budget gate checks: booked plus estimates.
const COMMITTED = 'the lower bound plus lane estimates';
const LABEL = { t3: 'T3', codex: 'codex', herdr: 'herdr', other: 'other' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const costed = (wp) => typeof wp.lane?.costUsd === 'number' && Number.isFinite(wp.lane.costUsd);
const backendName = (state, wp) => {
  const name = wp.lane?.backend ?? state.intent?.backend?.name;
  return typeof name === 'string' ? name : null;
};

// The run's started lanes (`wp.lane.startedAt`, the marker merged() reads),
// by what their cost tells: metered (a logged number, 0 included), partial (a
// number from a lane that was killed: `costComplete` false), pending (a live
// exec claude lane with none yet: it books at close), exitedNoCost (an exec
// claude lane that exited with none), and the rest by backend, which log none.
export function laneCount(state) {
  const count = { metered: 0, partial: 0, pending: 0, exitedNoCost: 0, unmetered: { t3: 0, codex: 0, herdr: 0, other: 0 } };
  for (const wp of state.wps ?? []) {
    if (!wp.lane?.startedAt) continue;
    if (costed(wp)) {
      if (wp.lane.costComplete === false) count.partial += 1;
      else count.metered += 1;
      continue;
    }
    const backend = backendName(state, wp);
    const agent = wp.agent ?? state.intent?.agent;
    if (backend === 'exec' && agent === 'claude') {
      if (wp.lane.exitedAt) count.exitedNoCost += 1;
      else count.pending += 1;
    } else if (backend === 't3' || backend === 'herdr') count.unmetered[backend] += 1;
    else if (backend === 'exec' && agent === 'codex') count.unmetered.codex += 1;
    else count.unmetered.other += 1;
  }
  return count;
}

// What a lower bound counted, with no "lower bound" prefix: each site adds it once.
export function basisPhrase(state) {
  const count = laneCount(state);
  const kinds = Object.entries(count.unmetered).filter(([, n]) => n > 0);
  const started = count.metered + count.partial + count.pending + count.exitedNoCost + kinds.reduce((sum, [, n]) => sum + n, 0);
  if (!started) {
    const backend = typeof state.intent?.backend?.name === 'string' ? state.intent.backend.name : null;
    if (backend === 't3' || backend === 'herdr') return `${LABEL[backend]} lanes log no cost, so none are counted`;
    if (backend === 'exec') {
      const agent = state.intent?.agent;
      return agent === 'claude' ? 'no lane has started; exec claude lanes log their cost at close' : `${agent ?? 'exec'} lanes log no cost, so none are counted`;
    }
    return 'no lane has started';
  }
  const parts = [];
  if (count.metered) parts.push(`${plural(count.metered, 'exec claude lane')} logged ${count.metered === 1 ? 'its' : 'their'} cost`);
  if (count.partial) parts.push(`${plural(count.partial, 'exec claude lane')} logged a partial cost (lower bound)`);
  if (count.pending) parts.push(`${plural(count.pending, 'exec claude lane')} not booked yet (a lane books at close)`);
  if (count.exitedNoCost) {
    const one = count.exitedNoCost === 1;
    parts.push(`${plural(count.exitedNoCost, 'exec claude lane')} exited with no logged cost and ${one ? 'is' : 'are'} not counted`);
  }
  if (kinds.length) {
    const total = kinds.reduce((sum, [, n]) => sum + n, 0);
    const named = kinds.map(([kind, n]) => plural(n, `${LABEL[kind]} lane`));
    const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
    parts.push(`${list} log${total === 1 ? 's' : ''} none and ${total === 1 ? 'is' : 'are'} not counted`);
  }
  return parts.join('; ');
}

// Each builder takes money already formatted by its site, `$` included.

// The analysis's Pre-approval audit line (analyze.mjs).
export const analysisBudgetLine = (state, lower) => `budget: unmetered; lower bound ${lower} (${basisPhrase(state)})`;

// The merge receipt's spend sentence (build.mjs mergedAfter), with its leading
// space. The estimates cover what merged()'s `unbooked` counts; with none, the
// clause is left out.
export function receiptSpendLine(state, { booked, projected, wpsLeft, perWp, basis, budget, crosses }) {
  const adding = wpsLeft ? `, adding ${wpsLeft} WP estimate(s) at ${perWp} each (${basis}) for every unfinished WP and every finished WP (merged, refuted or dropped) whose lane logged no cost` : '';
  return ` Spend: ${booked} booked, a lower bound (${basisPhrase(state)}); ~${projected} projected${adding}, against ${budget}${crosses ? ': the projection crosses the budget' : ''}.`;
}

// committed()'s detail: booked, the live lanes' and the next WP's estimates
// (each left out when null), and the per-lane estimate.
export function committedDetail(state, { booked, live, liveUsd, nextUsd, perLane, basis }) {
  const parts = [`${booked} booked`, ...(liveUsd ? [`${liveUsd} for ${live} live lane(s)`] : []), ...(nextUsd ? [`${nextUsd} for the next WP`] : [])];
  return `${parts.join(' + ')}; lanes estimated at ${perLane} each, ${basis}`;
}

// The budget halt's reason (build.mjs budgetGate).
export const budgetHaltText = (state, { committed, detail, budget }) =>
  `Spend is ${committed} committed (${detail}) against the ${budget} budget (unmetered; booked is a lower bound: ${basisPhrase(state)})`;

// The budget touch's EXPECT (a) clause and option (a)'s consequence (build.mjs haltTouch).
export const budgetTouchExpect = () => ({
  expect: `(a) answered with the text "budget <USD>" above the committed spend (${COMMITTED}) raises the ceiling to it, and the committed spend is checked against it`,
  consequence: `Type "budget <USD>", above the committed spend (${COMMITTED}); the committed spend is checked against it.`,
});

// The refusal of a raise at or under the committed figure (build.mjs answerRunTouch).
export const raiseRefusalText = (state, spend) => `(a) needs the text "budget <USD>" above the committed spend of ${spend} (${COMMITTED})`;

// The rotation handoff's spend clause (rotate.mjs).
export const rotateSpendText = (state, booked) => `lanes booked ${booked}, a lower bound (${basisPhrase(state)})`;

// The per-lane estimate touch 1 can name with no deps: the pinned repo
// config's laneEstimateUsd (as laneProjection reads it), else the default.
// `pinned` is repo-config.mjs pinnedConfig(state).
export function touchOneEstimate(pinned) {
  const configured = Number(pinned?.laneEstimateUsd);
  return pinned && Number.isFinite(configured) && configured >= 0
    ? { usd: configured, source: 'repo config' } : { usd: DEFAULT_LANE_ESTIMATE_USD, source: 'default' };
}

// Touch 1's budget detail line, before any lane exists. `backend` is the
// chooseBackend string (t3, herdr or exec); `estimate` is touchOneEstimate's;
// no deps, no counts.
export function touchOneBudgetLine({ budgetUsd, backend, agent, estimate = touchOneEstimate(null) }) {
  const gate = `the gate adds each live lane at the ${estimate.source} estimate $${Math.round(estimate.usd * 100) / 100}`;
  if (backend === 'exec' && agent === 'claude') return `Budget: $${budgetUsd} unmetered: exec claude lanes' logged cost sums to a lower bound; ${gate}`;
  const label = backend === 't3' || backend === 'herdr' ? LABEL[backend] : agent ?? 'exec';
  return `Budget: $${budgetUsd} unmetered: ${label} lanes log no cost, so the lower bound counts none; ${gate}`;
}
