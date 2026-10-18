// Merge, release and budget authority: what touch 1's answer recorded in
// state.authority (lib/phases/preapproval.mjs), raised by a budget touch's
// (a). Nothing is signed; the answer's `by` attribution and the core path's
// TTY guard are a procedural boundary, not proof of the operator's identity.

// "budget <USD>": digits with optional thousands commas, `$` and decimals ("budget $1,500" → 1500).
export function budgetAmount(text) {
  return Number(/\bbudget\s+\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\w.,])/i.exec(text ?? '')?.[1]?.replaceAll(',', ''));
}

// The touch whose answer set the authority: touch 1, or its blocked re-ask.
// A touch the build opened (budget, a re-plan, a halt), the showcase and the
// release anomaly's set none, though they too have no WP (council on e830d835).
export function approvingTouch(state) {
  const anomaly = state.release?.anomaly?.touch ?? null;
  return state.touches.filter((touch) => touch.status === 'answered' && touch.wpId === null && !touch.build
    && touch.kind !== 'showcase' && touch.n !== anomaly).at(-1);
}

// { merge, release, budgetUsd, scope } from state.authority.
export function runAuthority(state) {
  const a = state.authority ?? {};
  return { merge: a.merge === true, release: a.release === true, budgetUsd: a.budgetUsd ?? 0, scope: a.scope };
}

// Why a merge may not be emitted under `authority`, or null.
export function mergeRefusal(state, authority) {
  return authority.merge === true ? null : 'no merge authority';
}

// Why the release may not run under `authority`, or null.
export function releaseRefusal(state, authority) {
  return authority.release === true ? null : 'no release authority';
}
