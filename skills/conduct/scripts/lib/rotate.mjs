// Conductor rotation (d3ce5461). `conduct.mjs rotate` writes the successor's
// handoff from state.json and prints the session.mjs chain argv; the
// successor's first `next` emits the custody steps (retire the predecessor,
// then a paused receipt on the anchor) before the run's pending action. The
// pending action itself is never moved: custody runs in front of it, and an
// older conduct.mjs that ignores `rotations` still sees it.
import { join, resolve } from 'node:path';
import { ConductError, TERMINAL_PHASES, appendEvent } from './state.mjs';
import { LIVE_STATES, laneOccupied } from './schedule.mjs';
import { conductScript, shellLiteral, spineAckFailure } from './touch.mjs';
import { runAuthority } from './authority.mjs';
import { HEARTBEAT_INSTRUCTION, adoptHeartbeat, heartbeatArgs, recordHeartbeatDelete, releaseWakeYield, retireConductorThreads } from './lanes.mjs';

export const SESSION_LOG = 'session-chain.jsonl';

export function openRotation(state) {
  const last = state.rotations?.at(-1);
  return last?.status === 'open' ? last : null;
}

// `next --custody <attempt>`, the successor's first call (its handoff names
// it): a successor whose rotation was cancelled, or superseded by a later
// one, is not the run's conductor and is refused before anything is emitted.
export function custodyFence(state, attempt) {
  const rotations = state.rotations ?? [];
  const rotation = rotations.find((candidate) => String(candidate.attempt) === String(attempt));
  if (!rotation) throw new ConductError(2, `next --custody ${attempt}: this run has no rotation ${attempt}`);
  if (rotation.status === 'cancelled') throw new ConductError(5, `rotation ${attempt} was cancelled; r${rotation.from} kept the run, so you are not its conductor: end your turn`);
  if (rotation !== rotations.at(-1)) throw new ConductError(5, `rotation ${attempt} is superseded by rotation ${rotations.at(-1).attempt}; you are not the run's conductor: end your turn`);
}

// `next --custody <attempt> --as-thread <id>`: the first such call binds the
// open rotation's custody to that thread (lanes.mjs conductorThreadFence
// refuses every other until custody is taken). Without --as-thread nothing is bound.
export function bindCustodyThread(state, asThread, deps) {
  const rotation = openRotation(state);
  if (!rotation || rotation.thread || typeof asThread !== 'string' || !asThread.trim()) return;
  rotation.thread = asThread;
  appendEvent(state, deps, { step: 'custody', kind: 'custody', event: 'custody-thread-bound', source: 'next', data: { attempt: rotation.attempt, thread: asThread, from: rotation.fromThread ?? null } });
}

// The pane of the conductor that rotated, when it is the caller here.
export function rotatedOut(state, deps) {
  const rotation = openRotation(state);
  const here = herdrPane(deps);
  return rotation?.caller.pane && here === rotation.caller.pane ? rotation : null;
}

// Conductor numbers count rotations that took custody: r1 is the conductor
// that ran intake.
export const conductorNumber = (state) => 1 + (state.rotations ?? []).filter((rotation) => rotation.status === 'custody').length;
const sessionScript = (state) => join(state.pluginRoot, 'scripts', 'session.mjs');
const sessionLog = (state) => join(state.runDir, SESSION_LOG);
const herdrPane = (deps) => (deps.env?.HERDR_ENV === '1' && deps.env?.HERDR_PANE_ID ? deps.env.HERDR_PANE_ID : null);

// `conduct.mjs rotate --run <dir> --why <text> [--model <id> --effort <lvl>] [--name <successor>]`.
// Run it after a `record`, before performing the action that record printed
// (ASSUMPTION: the verb cannot see whether that action was started; the
// handoff tells the successor to perform it as given).
export function rotate(state, { why, model = null, effort = null, name = null }, deps) {
  if (typeof why !== 'string' || !why.trim()) throw new ConductError(2, 'rotate: --why <text> is required');
  if (TERMINAL_PHASES.includes(state.phase)) throw new ConductError(5, `rotate: the run is ${state.phase}; there is nothing to hand over`);
  // The analysis is written before the showcase opens; a rotation then would
  // be missing from it. The showcase ends the turn anyway: a fresh session
  // resumes it with next --resume.
  if (state.phase === 'showcase') throw new ConductError(5, 'rotate: the run analysis is written and the showcase waits on the operator; a fresh session resumes it with next --resume, no rotation needed');
  const open = openRotation(state);
  if (open) throw new ConductError(5, `rotate: rotation ${open.attempt} is open (handoff ${open.handoff}); its successor takes custody with next, or the conductor that rotated cancels it by running next from its own pane`);
  const pane = herdrPane(deps);
  if (pane && (typeof model !== 'string' || !model.trim() || typeof effort !== 'string' || !effort.trim())) {
    throw new ConductError(2, 'rotate: inside herdr the successor is chained, so --model <id> and --effort <level> are required');
  }
  const attempt = (state.rotations?.length ?? 0) + 1;
  const from = conductorNumber(state);
  const rotation = {
    attempt, from, to: from + 1, status: 'open', at: deps.timestamp(), why: why.trim(),
    handoff: join(state.runDir, `handoff-${attempt}.md`),
    caller: { pane, model, effort },
    successor: { name: pane ? (name || `${state.slug}-r${from + 1}`) : null, pane: null },
    pendingId: state.pending?.id ?? null,
    // A T3 run's outgoing conductor thread, refused while custody is open, and
    // the successor's, bound by its first `next --custody <n> --as-thread <id>`.
    fromThread: state.t3Wake?.conductor === from ? state.t3Wake.thread ?? null : null, thread: null,
    callerSession: null, retire: null, receipt: null, heartbeat: null, heartbeatStops: [], action: null, custodyAt: null,
  };
  (state.rotations ??= []).push(rotation);
  deps.write(rotation.handoff, handoffText(state, rotation));
  const chain = pane ? ['node', sessionScript(state), 'chain', '--handoff', rotation.handoff, '--model', model, '--effort', effort,
    '--name', rotation.successor.name, '--log', sessionLog(state)] : null;
  state.seq += 1;
  appendEvent(state, deps, {
    actionId: `${state.seq}-rotate`, step: 'rotate', kind: 'rotate', event: 'rotated', source: 'verb',
    data: { attempt, from, to: rotation.to, why: rotation.why, handoff: rotation.handoff, callerPane: pane, pendingId: rotation.pendingId },
  });
  const next = chain
    ? `Run this argv as your LAST tool call and make no tool call after it: ${JSON.stringify(chain)}. If it exits nonzero, read its output: when the successor was briefed (callerRetirement: exit-refused), end your turn with no further conduct.mjs call, since the successor takes custody; otherwise run conduct.mjs next from this pane, which cancels the rotation.`
    : `Start a fresh conductor session and give it this one line: Read ${rotation.handoff} and execute it exactly. Then end your turn with no further conduct.mjs call. If no successor starts, run conduct.mjs next --run <dir> --custody ${attempt} yourself, without --as-thread (custody refuses your thread): its custody step lets you cancel the rotation.`;
  return { rotation: attempt, from, to: rotation.to, handoff: rotation.handoff, chain: chain ? { command: chain } : null, next };
}

const line = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const money = (usd) => `$${(Math.round(Number(usd) * 100) / 100).toFixed(2)}`;

function actionLine(action) {
  const where = `${action.step}${action.part ? `/${action.part}` : ''}${action.wpId ? ` for ${action.wpId}` : ''}`;
  const argv = action.command ? `; argv ${JSON.stringify(action.command)}` : action.tool ? `; tool ${action.tool}` : '';
  return `\`${action.id}\` (${action.kind}, ${where})${argv}: ${line(action.instruction)}`;
}

function wpLine(wp) {
  const lane = wp.lane?.backend ? `; lane ${wp.lane.backend}${wp.lane.name ? ` \`${wp.lane.name}\`` : ''}${wp.lane.paneId ? ` pane ${wp.lane.paneId}` : ''}${wp.lane.pid ? ` pid ${wp.lane.pid}` : ''}${wp.lane.worktree ? `, worktree \`${wp.lane.worktree}\`` : ''}` : '';
  const pr = wp.pr?.number ? `; PR #${wp.pr.number}${wp.pr.head ? ` at ${wp.pr.head.slice(0, 12)}` : ''}` : '';
  const head = wp.queue?.[0];
  const queued = head ? `; queued next: ${head.step}${head.part ? `/${head.part}` : ''}${head.command ? ` ${JSON.stringify(head.command)}` : ''}` : '';
  return `- ${wp.id} ${wp.state}${wp.stage ? ` at ${wp.stage}` : ''}${lane}${pr}${queued}`;
}

// The successor's brief, from state alone: what is live and what to run first.
export function handoffText(state, rotation) {
  const intent = state.intent ?? {};
  const shown = runAuthority(state);
  const script = conductScript(state);
  const anchor = state.adapters?.spine?.on && intent.anchor ? intent.anchor : null;
  const on = Object.entries(state.adapters ?? {}).filter(([, adapter]) => adapter?.on).map(([name]) => name);
  const custody = [
    rotation.caller.pane ? `retire r${rotation.from} (herdr pane ${rotation.caller.pane}) with session.mjs, \`close\` then \`exit+close\`` : `confirm r${rotation.from} has ended (it ran outside herdr, so nothing can retire it for you)`,
    ...(anchor ? [`file a paused receipt on the anchor ${anchor} (skipped while a touch waits on the operator)`] : []),
  ];
  const lanes = state.wps.filter((wp) => LIVE_STATES.includes(wp.state) || laneOccupied(wp) || wp.queue?.length);
  const bookedUsd = state.wps.reduce((total, wp) => total + (Number(wp.lane?.costUsd) || 0), 0);
  const spend = `lanes booked ${money(bookedUsd)} (the lane-only lower bound)`;
  const touches = (state.touches ?? []).filter((touch) => touch.status !== 'answered');
  const earlier = (state.rotations ?? []).filter((other) => other !== rotation);
  // A T3 successor binds custody to its own thread: no other thread, the outgoing conductor's included, can then move it.
  const t3 = state.intent?.backend?.name === 't3';
  const asThread = t3 ? ' --as-thread <your own T3 thread id>' : '';
  const t3Custody = t3 ? ` The id is \`orchestrator_capabilities\`' \`parentThreadId\` (or \`t3_thread_configuration\`'s \`threadId\`): it binds custody to your thread, and until custody is taken every \`next\` and \`record\` passes the same \`--as-thread\`.` : '';
  const loop = t3 ? `\`next\` and \`record\` with \`--as-thread\`` : 'plain `next`';
  return [
    `# conduct ${state.slug}: conductor handoff r${rotation.from} → r${rotation.to}`,
    '',
    `Written by \`conduct.mjs rotate\` at ${rotation.at} (rotation ${rotation.attempt}). Why: ${line(rotation.why)}.`,
    '',
    `You are conductor r${rotation.to} of run \`${state.runId}\`. The run's state is its run dir, not this file: this file names what is live so you need not rediscover it.`,
    '',
    '## First steps',
    '',
    `1. Read \`${join(state.pluginRoot, 'skills', 'conduct', 'SKILL.md')}\` (§ The loop, § Rotating the conductor).`,
    `2. Run \`node ${shellLiteral(script)} next --run ${shellLiteral(state.runDir)} --custody ${rotation.attempt}${asThread}\`.${t3Custody} If it exits 5, this rotation was cancelled or superseded: you are not the run's conductor, so end your turn. Otherwise its first actions are custody, emitted by the run: ${custody.join('; then ')}. Perform and record each as § The loop says.`,
    wakePending(state)
      ? `3. The pending action${rotation.pendingId ? ` (\`${rotation.pendingId}\`)` : ''} is a wake wait, and its wakes go to r${rotation.from}'s thread: custody goes on, and the run's heartbeat is made again from your thread (\`schedule_task\`), then r${rotation.from}'s is deleted. The run then chooses its wait afresh. Keep looping with ${loop}.`
      : `3. The run then emits its pending action again${rotation.pendingId ? ` (\`${rotation.pendingId}\`)` : ''}, or, when that was a hand-back, asks the touch again as any resume does. r${rotation.from} ran \`rotate\` before performing it, so perform it as given, then keep looping with ${loop}.`,
    '',
    'Never edit state.json. Never run `rotate` before custody is taken.',
    '',
    '## Run',
    '',
    `- Run dir: \`${state.runDir}\`; plugin root: \`${state.pluginRoot}\``,
    `- Goal: ${line(intent.goal).slice(0, 200)} (in full: \`${join(state.runDir, 'goal.md')}\`)`,
    `- Repo: \`${intent.repo?.path ?? ''}\` (${intent.repo?.remote ?? 'no remote'}, default branch ${intent.repo?.defaultBranch ?? 'unknown'})`,
    `- Phase: ${state.phase}; anchor: ${anchor ?? 'none'}; adapters on: ${on.join(', ') || 'none'}`,
    `- Authority: merge ${shown.merge}, release ${shown.release}, budget ${money(shown.budgetUsd)} (unmetered); ${spend}`,
    `- Approved scope (binding; it can be narrower than the goal): ${line(state.authority?.scope ?? intent.goal)}${typeof state.authority?.grant === 'string' ? ` (grant \`${join(state.runDir, state.authority.grant)}\`)` : ''}${state.authority?.notes ? `; operator notes: ${line(state.authority.notes)}` : ''}`,
    '',
    '## Pending action',
    '',
    state.pending ? `- ${actionLine(state.pending)}` : '- None: `next` computes the next action.',
    '',
    '## Work packages',
    '',
    ...(state.wps.length ? state.wps.map(wpLine) : ['- None minted yet.']),
    '',
    `Live or queued: ${lanes.map((wp) => wp.id).join(', ') || 'none'}. Their lanes keep running across the rotation; the build polls each one again from its queue.`,
    '',
    '## Open touches',
    '',
    ...(touches.length ? touches.map((touch) => `- touch ${touch.n} (${touch.kind}${touch.wpId ? `, ${touch.wpId}` : ''}): ${touch.status}; ${touch.tag}`) : ['- None.']),
    ...(earlier.length ? ['', '## Earlier rotations', '', ...earlier.map((other) => `- ${other.attempt}: r${other.from} → r${other.to} at ${other.at}, ${other.status}: ${line(other.why)}`)] : []),
    '',
  ].join('\n');
}

// ---- custody: emitted by `next` while a rotation is open ----

// The predecessor's session id, from the row session.mjs chain wrote for this
// handoff from the predecessor's pane, or null. herdr reissues pane ids, so
// the retire is bound to this session (`--expect-session`), never to the pane alone.
function chainedSession(state, rotation, deps) {
  const log = sessionLog(state);
  let text = '';
  try {
    if (!deps.exists?.(log)) return null;
    text = deps.read(log);
  } catch {
    return null;
  }
  const rows = text.split(/\r?\n/).filter(Boolean).map((raw) => { try { return JSON.parse(raw); } catch { return null; } });
  const mine = rows.filter((row) => typeof row?.handoff === 'string' && resolve(row.handoff) === resolve(rotation.handoff)
    && row.callerPane === rotation.caller.pane && typeof row.callerSession === 'string' && row.callerSession);
  return mine.at(-1)?.callerSession ?? null;
}

function retireAction(state, rotation, mode) {
  return {
    kind: 'shell', step: 'custody', part: `retire-${mode === 'close' ? 'close' : 'exit-close'}`, custody: rotation.attempt,
    command: ['node', sessionScript(state), 'retire', rotation.caller.pane, '--mode', mode, '--expect-session', rotation.callerSession, '--log', sessionLog(state)],
    instruction: `Retire conductor r${rotation.from} (pane ${rotation.caller.pane}, session ${rotation.callerSession}): run this exact argv (no shell) and record its { code, stdout, stderr }, whatever its exit code.`,
  };
}

function confirmAction(state, rotation) {
  const why = !rotation.caller.pane
    ? `conductor r${rotation.from} ran outside herdr, so no command can retire it`
    : !rotation.callerSession
      ? `${SESSION_LOG} has no chain row for ${rotation.handoff} from pane ${rotation.caller.pane}, so r${rotation.from}'s session is unknown and its pane id alone could name another agent`
      : `session.mjs could not retire conductor r${rotation.from} in pane ${rotation.caller.pane} (close, then exit+close; ${SESSION_LOG} has both rows)`;
  return {
    kind: 'author', step: 'custody', part: 'confirm', custody: rotation.attempt, outPath: join(state.runDir, `custody-${rotation.attempt}.json`),
    instruction: `${why}. Two conductors must never drive one run. Confirm r${rotation.from} has ended (its pane or session is gone, or you closed it), then write ${'{ "gone": true, "evidence": "<what you observed>" }'} to outPath. If you are r${rotation.from} yourself and no successor took over, write ${'{ "cancel": true, "why": "<what happened>" }'} instead: the rotation is cancelled and you keep the run. Then record {}.`,
  };
}

function receiptAction(state, rotation) {
  const retired = { closed: 'retired with close', 'exit+close': 'retired with exit+close', confirmed: 'confirmed gone by hand' }[rotation.retire] ?? rotation.retire;
  return {
    kind: 'agent-tool', step: 'custody', part: 'receipt', custody: rotation.attempt, tool: 'spine_receipt', expects: { type: 'json' },
    instruction: 'Call spine_receipt with these args and record its raw result.',
    args: {
      questId: state.intent.anchor, outcome: 'paused',
      did: `conduct ${state.slug} (run ${state.runId}): conductor r${rotation.from} rotated to r${rotation.to} (${line(rotation.why).slice(0, 600)}). Handoff: ${rotation.handoff}. r${rotation.from} was ${retired}.${rotation.successor.pane ? ` r${rotation.to} runs in herdr pane ${rotation.successor.pane}.` : ''}`,
      stoppedAt: `custody of conduct ${state.slug} taken by r${rotation.to}; the run resumes at ${state.pending?.id && !wakePending(state) ? `its pending action ${state.pending.id}` : 'its next action'}`,
    },
  };
}

// The next custody step's spec, or null once custody is taken (or the rotation
// was cancelled). Throws when the conductor that rotated asks after its
// successor has started custody, and when custody would start without
// `next --custody <attempt>` (the fence is then never skipped).
export function custodyNext(state, rotation, deps, { custody = null } = {}) {
  const caller = rotation.caller.pane;
  const here = herdrPane(deps);
  if (caller && here === caller) {
    if (rotation.action || rotation.retire !== null || rotation.successor.pane) {
      throw new ConductError(5, `rotation ${rotation.attempt}: r${rotation.to}${rotation.successor.pane ? ` (pane ${rotation.successor.pane})` : ''} is taking custody; you are r${rotation.from}, rotated out: end your turn`);
    }
    // The chain did not hand over: the conductor that rotated keeps the run.
    rotation.status = 'cancelled';
    appendEvent(state, deps, { step: 'custody', kind: 'custody', event: 'rotation-cancelled', source: 'verb', data: { attempt: rotation.attempt, why: `r${rotation.from} ran next from its own pane ${caller}` } });
    return null;
  }
  if (rotation.action) return rotation.action;
  if (rotation.retire === null && String(custody) !== String(rotation.attempt)) {
    throw new ConductError(5, `rotation ${rotation.attempt} is open: its successor starts custody with next --custody ${rotation.attempt} (handoff ${rotation.handoff})`);
  }
  if (rotation.retire === null && here && !rotation.successor.pane) rotation.successor.pane = here;
  if (caller && rotation.retire === null && !rotation.callerSession) rotation.callerSession = chainedSession(state, rotation, deps);
  if (caller && rotation.retire === null && rotation.callerSession) return retireAction(state, rotation, 'close');
  if (caller && rotation.retire === 'close-failed') return retireAction(state, rotation, 'exit+close');
  if (['exit-close-failed', null].includes(rotation.retire)) return confirmAction(state, rotation);
  if (rotation.receipt === null && state.adapters?.spine?.on && state.intent?.anchor) {
    // A touch filed on the anchor waits on the operator: a later receipt
    // would supersede its needs_input and take the question off the board.
    // Custody then files nothing.
    const filed = (state.touches ?? []).filter((touch) => touch.status === 'filed');
    if (!filed.length) return receiptAction(state, rotation);
    rotation.receipt = 'skipped';
    appendEvent(state, deps, { step: 'custody', kind: 'custody', event: 'custody-receipt-skipped', source: 'next', data: { attempt: rotation.attempt, filed: filed.map((touch) => touch.tag) } });
  }
  // A pending wake yield would have the successor end its turn on wakes that
  // still go to its predecessor: the heartbeat and the lanes' done messages
  // both target r<from>'s thread. Custody first makes a heartbeat from the
  // successor's thread, then deletes the old one; the wait is chosen again
  // once custody is taken.
  if (wakePending(state)) {
    if (!rotation.heartbeat) return heartbeatAction(state, rotation);
    const [stop] = rotation.heartbeatStops ?? [];
    if (stop) return heartbeatStopAction(rotation, stop);
  }
  rotation.status = 'custody';
  rotation.custodyAt = deps.timestamp();
  // The outgoing conductor's thread can never adopt the run back (lanes.mjs conductorThreadFence).
  const retired = retireConductorThreads(state, rotation);
  appendEvent(state, deps, { step: 'custody', kind: 'custody', event: 'custody-taken', source: 'next', data: { attempt: rotation.attempt, from: rotation.from, to: rotation.to, retire: rotation.retire, receipt: rotation.receipt, pane: rotation.successor.pane, ...(retired ? { retiredThreads: retired } : {}) } });
  // The yield goes, and its lanes' wake waits with it: the first tick under
  // the new heartbeat reads every live T3 lane at once, then waits on wakes.
  releaseWakeYield(state, deps, { step: 'custody', kind: 'custody', data: { attempt: rotation.attempt, heartbeat: rotation.heartbeat } });
  return null;
}

const wakePending = (state) => state.pending?.kind === 'wait' && state.pending.wake === true;

function heartbeatAction(state, rotation) {
  return {
    kind: 'agent-tool', step: 'custody', part: 'heartbeat', custody: rotation.attempt, tool: 'schedule_task', expects: { type: 'json' },
    args: heartbeatArgs(state, rotation.to), instruction: HEARTBEAT_INSTRUCTION,
  };
}

function heartbeatStopAction(rotation, taskId) {
  return {
    kind: 'agent-tool', step: 'custody', part: 'heartbeat-stop', custody: rotation.attempt, tool: 'delete_scheduled_task', expects: { type: 'json' },
    args: { scheduledTaskId: taskId }, instruction: `Call delete_scheduled_task with these args and record its raw result (an error too): it is r${rotation.from}'s heartbeat, replaced by yours.`,
  };
}

function readConfirm(path, deps) {
  let value;
  try {
    value = JSON.parse(deps.read(path));
  } catch (error) {
    throw new ConductError(2, `custody: ${path} is missing or not JSON (${error.message})`);
  }
  if (value?.gone === true && typeof value.evidence === 'string' && value.evidence.trim()) return { gone: value.evidence.trim() };
  if (value?.cancel === true && typeof value.why === 'string' && value.why.trim()) return { cancel: value.why.trim() };
  throw new ConductError(2, `custody: ${path} must be { "gone": true, "evidence": "…" } or { "cancel": true, "why": "…" }`);
}

// Applies a custody action's result. An invalid result throws before anything changes.
export function recordCustody(state, rotation, action, result, deps) {
  if (action.part === 'retire-close' || action.part === 'retire-exit-close') {
    if (typeof result?.code !== 'number') throw new ConductError(2, `a shell result is { code, stdout, stderr } with a numeric code (action ${action.id})`);
    const close = action.part === 'retire-close';
    rotation.retire = result.code === 0 ? (close ? 'closed' : 'exit+close') : (close ? 'close-failed' : 'exit-close-failed');
    appendEvent(state, deps, { actionId: action.id, step: 'custody', event: 'custody-retire', data: { attempt: rotation.attempt, mode: close ? 'close' : 'exit+close', code: result.code, outcome: rotation.retire } });
  } else if (action.part === 'confirm') {
    const confirmed = readConfirm(action.outPath, deps);
    if (confirmed.cancel) {
      rotation.status = 'cancelled';
      appendEvent(state, deps, { actionId: action.id, step: 'custody', event: 'rotation-cancelled', data: { attempt: rotation.attempt, why: confirmed.cancel } });
    } else {
      rotation.retire = 'confirmed';
      appendEvent(state, deps, { actionId: action.id, step: 'custody', event: 'custody-retire', data: { attempt: rotation.attempt, mode: 'confirm', outcome: 'confirmed', evidence: confirmed.gone } });
    }
  } else if (action.part === 'receipt') {
    // A receipt that failed is named and never blocks custody: the run's
    // record is state.json and events.jsonl, the receipt is the board's copy.
    const failure = spineAckFailure(action, result);
    rotation.receipt = failure ? 'failed' : 'filed';
    appendEvent(state, deps, { actionId: action.id, step: 'custody', event: failure ? 'custody-receipt-failed' : 'custody-receipt', data: { attempt: rotation.attempt, ...(failure ? { failure } : { receipt: result.id }) } });
  } else if (action.part === 'heartbeat') {
    // A heartbeat that fails never blocks custody: the lanes poll.
    rotation.heartbeatStops = adoptHeartbeat(state, rotation.to, result, deps.timestamp());
    rotation.heartbeat = state.t3Wake.failed ? 'failed' : 'made';
    appendEvent(state, deps, { actionId: action.id, step: 'custody', event: 'custody-heartbeat', data: { attempt: rotation.attempt, outcome: rotation.heartbeat, taskId: state.t3Wake.taskId, thread: state.t3Wake.thread, stops: rotation.heartbeatStops } });
  } else if (action.part === 'heartbeat-stop') {
    // A failed delete stays owed on the run (lanes.mjs heartbeatsToDelete).
    const taskId = action.args.scheduledTaskId;
    recordHeartbeatDelete(state, taskId, result);
    rotation.heartbeatStops = (rotation.heartbeatStops ?? []).filter((id) => id !== taskId);
    appendEvent(state, deps, { actionId: action.id, step: 'custody', event: 'custody-heartbeat-stop', data: { attempt: rotation.attempt, taskId } });
  } else {
    throw new ConductError(2, `custody: unknown step ${action.part}`);
  }
  rotation.action = null;
}
