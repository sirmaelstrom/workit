// Phase analyze: one shell action that runs `conduct.mjs analyze`, which
// writes run-analysis.md (lib/analyze.mjs). `next` never runs a program, so
// the analysis runs only when the agent performs this action (D19.20).
// A T3 run's heartbeats go first: the lanes are done, so nothing needs a wake.
import { heartbeatsToDelete, recordHeartbeatDelete } from '../lanes.mjs';
import { conductScript } from '../touch.mjs';

export function next(state) {
  const [taskId] = heartbeatsToDelete(state);
  if (taskId) {
    return {
      kind: 'agent-tool', step: 'analyze', part: 'heartbeat-stop', tool: 'delete_scheduled_task', args: { scheduledTaskId: taskId }, expects: { type: 'json' },
      instruction: 'Call delete_scheduled_task with these args and record its raw result, an error too: the build is over, so the run\'s heartbeat goes.',
    };
  }
  return {
    kind: 'shell', step: 'analyze', command: ['node', conductScript(state), 'analyze', '--run', state.runDir], expects: { type: 'exit0' },
    instruction: 'Run this exact argv (no shell): it writes run-analysis.md in the run dir. Record its { code, stdout, stderr }.',
  };
}

export function record(state, action, result) {
  // A failed delete stays owed and is emitted again, up to HEARTBEAT_DELETE_ATTEMPTS
  // per task; then the run goes on, and its analysis names what is left.
  if (action?.part === 'heartbeat-stop') return recordHeartbeatDelete(state, action.args.scheduledTaskId, result);
  state.phase = 'showcase';
}
