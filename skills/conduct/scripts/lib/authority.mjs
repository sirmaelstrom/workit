// Merge, release and budget authority, recomputed from the operator's signed
// grant immediately before every act (D13). With an operator passkey
// configured, each granting option of an authority touch carries its grant as
// rendered prose and a tag (`renderGrant(grant) + ' [grant <tag>]'`), the
// signature binds both, and verifiedAuthority re-verifies the stored proof and
// the grant each time. state.authority is then a display cache that no act
// reads. With no anchor nothing is signed, so the authority is state.authority
// as before (M8), and the run report says UNCONFIGURED (M7).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConductError } from './state.mjs';
import { touchTag } from './touch.mjs';
import {
  GRANT_TTL_DAYS, OperatorProofError, REASONS, canonical, checkGrant, checkRaise, grantTag, raiseTag, renderGrant, renderRaise, verifyAnswerProof,
} from '../../../_shared/operator-proof/operator-proof.mjs';

// The Spine stores at most this many characters of an option's label or consequence.
export const OPTION_MAX = 240;
// What an authority hold asks of the operator. Nothing re-files an authority
// touch mid-run, so a record that cannot be restored ends the run's authority.
export const AUTHORITY_RECOVERY = 'restore the signed record, or start a new run and sign its touch 1';
// A grant's base branch when the repo reported none. renderGrant puts the
// branch in parentheses, so the prose reads "((unknown))".
export const UNKNOWN_BRANCH = '(unknown)';
const DAY_MS = 24 * 60 * 60 * 1000;

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const nowOf = (deps) => (typeof deps?.now === 'function' ? deps.now() : Date.now());

export const scopeSha256 = (text) => sha256Hex(String(text).normalize('NFC'));
export const recipeSha256 = (recipe) => (recipe == null ? null : sha256Hex(canonical(recipe)));

// "budget <USD>": digits with optional thousands commas, `$` and decimals ("budget $1,500" → 1500).
export function budgetAmount(text) {
  return Number(/\bbudget\s+\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\w.,])/i.exec(text ?? '')?.[1]?.replaceAll(',', ''));
}

// ---- filing: the grants and tags a configured run puts on its touches ----

// What an option authorises, bound to this run, its repo, its release recipe
// and an expiry. A base branch the repo did not report is signed as unknown,
// never as a guess; it is shown in the prose and never checked at a merge.
export function runGrant(state, { budgetUsd, merge, release, scope }, filedAt) {
  const { intent } = state;
  return {
    budgetUsd, merge, release, scopeSha256: scopeSha256(scope), runId: state.runId,
    repo: { remote: intent.repo.remote, defaultBranch: intent.repo.defaultBranch ?? UNKNOWN_BRANCH },
    releaseRecipeSha256: recipeSha256(intent.release),
    notAfter: new Date(filedAt + GRANT_TTL_DAYS * DAY_MS).toISOString(),
  };
}

export const filingTime = (deps) => nowOf(deps);

export function grantConsequence(grant) {
  const prose = renderGrant(grant);
  if (prose === null) throw new ConductError(2, `E7: the grant cannot be rendered (a field has the wrong type): ${JSON.stringify(grant)}`);
  return `${prose} [grant ${grantTag(grant)}]`;
}

export function raiseConsequence(raise) {
  const prose = renderRaise(raise);
  if (prose === null) throw new ConductError(2, `E7: the budget raise cannot be rendered (a field has the wrong type): ${JSON.stringify(raise)}`);
  return `${prose} [raise ${raiseTag(raise)}]`;
}

// E7. The Spine trims an option's label and consequence and caps each at
// OPTION_MAX, and the signature covers what it stores. Every option of a
// tagged touch must therefore already be its own trim, on one line, within
// the cap; otherwise filing is refused rather than signing other words.
export function assertFileable(options, where) {
  for (const option of options) {
    for (const field of ['label', 'consequence']) {
      const text = option[field];
      const problem = text !== text.trim() ? 'has leading or trailing whitespace'
        : /[\r\n]/.test(text) ? 'is more than one line'
          : text.length > OPTION_MAX ? `is ${text.length} chars, over the ${OPTION_MAX}-char cap` : null;
      if (problem) {
        const lengths = options.map((each) => `(${each.key}) ${each.consequence.length}`).join(', ');
        throw new ConductError(2, `E7: ${where}: option (${option.key})'s ${field} ${problem}, so the Spine would store other text than the signed tag binds; consequence lengths: ${lengths}`);
      }
    }
  }
}

// ---- the authority touch ----

// The touch whose answer set the authority: touch 1, or its blocked re-ask.
// A touch the build opened (budget, a re-plan, a halt), the showcase, the
// release anomaly's and a (c) answer's confirm set none, though they too have
// no WP (council on e830d835).
export function approvingTouch(state) {
  const anomaly = state.release?.anomaly?.touch ?? null;
  return state.touches.filter((touch) => touch.status === 'answered' && touch.wpId === null && !touch.build
    && touch.kind !== 'showcase' && touch.kind !== 'preapproval-confirm' && touch.n !== anomaly).at(-1);
}

// The touch whose signed answer is the authority: the approving touch, or for
// a (c) answer its confirm, named by state.authority.confirmTouch.
function authorityTouch(state) {
  const approving = approvingTouch(state);
  if (!approving || approving.answer?.key !== 'c') return { approving, holder: approving, viaConfirm: false };
  const n = state.authority?.confirmTouch;
  return { approving, holder: Number.isInteger(n) ? state.touches[n - 1] ?? null : undefined, viaConfirm: true };
}

const ZERO = Object.freeze({ merge: false, release: false, budgetUsd: 0, scope: null, scopeSha256: null });
const zero = (reason) => ({ ...ZERO, proofMode: 'refused', reason, ignored: [], grant: null, touch: null });

function unconfigured(state) {
  const a = state.authority ?? {};
  return {
    merge: a.merge === true, release: a.release === true, budgetUsd: a.budgetUsd ?? 0, scope: a.scope, scopeSha256: null,
    proofMode: 'unconfigured', reason: null, ignored: [], grant: null, touch: null,
  };
}

// Steps 2 and 3 for one touch: its stored signed block verifies against the
// anchor, for the ask this touch filed (touch.receiptId, null when it filed
// none), and its signed question carries this touch's run correlation.
function signedRefusal(state, touch, anchor) {
  const signed = touch.answer?.signed;
  if (!isObj(signed)) return `authority proof invalid: ${REASONS.proof_absent}`;
  const verdict = verifyAnswerProof({
    answer: signed.answer, question: signed.question, ask: signed.ask,
    questId: state.intent.anchor, askReceiptId: touch.receiptId ?? null, anchor,
  });
  if (!verdict.ok) return `authority proof invalid: ${verdict.reason}`;
  const head = `${touchTag(state.slug, state.touches.indexOf(touch) + 1)} (run ${state.runId}/`;
  if (!signed.question.startsWith(head) || !/^\d+\) /.test(signed.question.slice(head.length))) return 'wrong run';
  return null;
}

function grantScope(state, approving, deps) {
  const path = join(state.runDir, 'touches', `${state.touches.indexOf(approving) + 1}-grant.json`);
  return JSON.parse(deps.read(path)).scope;
}

// A later budget-raise touch's new budget, or why it does not count.
function raiseOutcome(state, touch, anchor) {
  const refusal = signedRefusal(state, touch, anchor);
  if (refusal) return { why: refusal };
  const { raise } = touch;
  const signed = touch.answer.signed;
  if (!checkRaise(raise, signed.ask, 'a')) return { why: REASONS.raise_tag_mismatch };
  if (raise.runId !== state.runId) return { why: 'wrong run' };
  if (raise.touch !== state.touches.indexOf(touch) + 1) return { why: `wrong touch: the raise names touch ${raise.touch}` };
  if (signed.answer.key !== 'a') return { why: `answered ${signed.answer.key ?? '(no key)'}, not (a)` };
  const usd = budgetAmount(signed.answer.text);
  if (!(usd > raise.haltSpendUsd)) return { why: `amount not above the halt spend $${raise.haltSpendUsd}` };
  return { usd };
}

function signedAuthority(state, deps, anchor) {
  const { approving, holder, viaConfirm } = authorityTouch(state);
  if (!approving || holder === undefined) return zero('no approving touch');
  // The confirm pointer is agent-writable: it must name an answered confirm touch.
  if (viaConfirm && (holder?.kind !== 'preapproval-confirm' || holder.status !== 'answered')) return zero('wrong run');
  const refusal = signedRefusal(state, holder, anchor);
  if (refusal) return zero(refusal);
  const signed = holder.answer.signed;
  const key = signed.answer?.key;
  const grant = isObj(holder.grants) && typeof key === 'string' && Object.hasOwn(holder.grants, key) ? holder.grants[key] : undefined;
  if (grant === undefined || !checkGrant(grant, signed.ask, key)) return zero(REASONS.grant_tag_mismatch);
  if (grant.runId !== state.runId) return zero('wrong run');
  if (nowOf(deps) > Date.parse(grant.notAfter)) return zero(REASONS.grant_expired);
  const scope = viaConfirm ? grantScope(state, approving, deps) : state.intent.goal;
  if (typeof scope !== 'string' || scopeSha256(scope) !== grant.scopeSha256) return zero('scope mismatch');
  let budgetUsd = grant.budgetUsd;
  const ignored = [];
  for (const touch of state.touches.slice(state.touches.indexOf(holder) + 1)) {
    if (touch.status !== 'answered' || (touch.raise === undefined && touch.build !== 'budget')) continue;
    const outcome = raiseOutcome(state, touch, anchor);
    if (outcome.why) ignored.push(`raise touch ${touch.n}: ${outcome.why}`);
    else budgetUsd = outcome.usd;
  }
  return {
    merge: grant.merge, release: grant.release, budgetUsd, scope, scopeSha256: grant.scopeSha256,
    proofMode: 'verified', reason: null, ignored, grant, touch: state.touches.indexOf(holder) + 1,
  };
}

// {merge, release, budgetUsd, scope, scopeSha256, proofMode, reason, ignored,
// grant, touch}. Configured, every value comes from the signed grant (and the
// signed raises after it); any failure is zero authority with a reason, and
// state is never trusted: a throw while reading it is malformed_state (P3:
// hold, never throw). There is no default anchor reader: a caller without
// deps.readAnchor is a defect, and it fails loudly.
export function verifiedAuthority(state, deps) {
  if (typeof deps?.readAnchor !== 'function') throw new ConductError(2, 'deps.readAnchor missing');
  let anchor;
  try {
    anchor = deps.readAnchor();
  } catch (error) {
    if (error instanceof OperatorProofError && error.code === REASONS.anchor_unreadable) return zero(REASONS.anchor_unreadable);
    throw error;
  }
  if (!anchor?.configured) return unconfigured(state);
  try {
    return signedAuthority(state, deps, anchor);
  } catch {
    return zero('malformed_state');
  }
}

// ---- act-time checks (pure: they take the authority, never the anchor) ----

const because = (authority) => (authority.reason ? ` (${authority.reason})` : '');

// Why a merge to `repo` may not be emitted under `authority`, or null. A
// signed grant names its repo: the command's --repo and the run's own repo
// must both be it.
export function mergeRefusal(state, authority, repo = state.intent.repo.remote) {
  if (authority.merge !== true) return `no merge authority${because(authority)}`;
  const granted = authority.grant?.repo?.remote;
  if (authority.grant && repo !== granted) return `merge target ${repo} is not the granted ${granted}`;
  if (authority.grant && state.intent.repo.remote !== granted) return `the run's repo ${state.intent.repo.remote} is not the granted ${granted}`;
  return null;
}

// Why the release may not run under `authority`, or null. A signed grant
// names its recipe by digest, and its repo: the run's must be it.
export function releaseRefusal(state, authority) {
  if (authority.release !== true) return `no release authority${because(authority)}`;
  if (authority.grant && recipeSha256(state.intent.release) !== authority.grant.releaseRecipeSha256) {
    return 'the release recipe is not the granted one: its digest differs from the signed grant\'s';
  }
  const granted = authority.grant?.repo?.remote;
  if (authority.grant && state.intent.repo.remote !== granted) return `the run's repo ${state.intent.repo.remote} is not the granted ${granted}`;
  return null;
}

// What emission stamps or a wait counts down: never part of what an act does.
const STAMPED = new Set(['id', 'phase', 'seam', 'wpId', 'dueAt', 'remainingMs']);
const sorted = (value) => (Array.isArray(value) ? value.map(sorted)
  : isObj(value) ? Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, sorted(value[key])])) : value);
const actKey = (action) => JSON.stringify(sorted(Object.fromEntries(Object.entries(action).filter(([key]) => !STAMPED.has(key)))));

// True when two actions are the same act: every field (kind, argv, cwd, env,
// tool and args, an edit's file, slots and JSON path, the instruction) equal,
// apart from the stamped ones.
export function sameAction(a, b) {
  return isObj(a) && isObj(b) && actKey(a) === actKey(b);
}

// ---- display (never read by an act) ----

// The authority touch's stored proof, for the run report and the handoff.
export function proofLabel(state) {
  let touch;
  try {
    touch = authorityTouch(state).holder;
  } catch {
    touch = null;
  }
  const answer = touch?.answer;
  if (!answer) return '(proof: no authority answer yet)';
  if (answer.proofMode !== 'verified') return '(proof: UNCONFIGURED — answers not signed)';
  const label = `(proof: verified ••••${String(answer.credentialId ?? '').slice(-8)} epoch ${answer.epoch})`;
  return isObj(touch.grants) ? label : `${label}; touch ${touch.n} carries no signed grant: start a new run and sign its touch 1 to act`;
}

// The authority line's values and label. Beside a verified proof they are the
// verified authority's, never state.authority's; a caller without
// deps.readAnchor prints the stored values, labelled as a cached display, and
// an anchor that cannot be read for any reason labels them unverified.
export function authorityDisplay(state, deps) {
  const cached = state.authority ?? {};
  const shown = { merge: cached.merge === true, release: cached.release === true, budgetUsd: cached.budgetUsd ?? 0, scope: cached.scope };
  const label = proofLabel(state);
  if (!label.startsWith('(proof: verified')) return { ...shown, label };
  if (typeof deps?.readAnchor !== 'function') return { ...shown, label: `${label} (cached display; acts use the signed grant)` };
  const unverified = { ...shown, label: '(proof: unverified (anchor unreadable); cached display, acts hold)' };
  let verified;
  try {
    verified = verifiedAuthority(state, deps);
  } catch {
    return unverified;
  }
  if (verified.reason === REASONS.anchor_unreadable) return unverified;
  if (verified.proofMode === 'unconfigured') return { ...shown, label: '(proof: UNCONFIGURED — no anchor is configured now, so the stored answer is not checked)' };
  const { merge, release, budgetUsd, scope } = verified;
  return { merge, release, budgetUsd, scope, label: verified.reason ? `(proof: refused, ${verified.reason}; acts hold)` : label };
}
