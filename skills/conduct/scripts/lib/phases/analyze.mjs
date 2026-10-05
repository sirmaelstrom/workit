// Phase analyze: one shell action that runs `conduct.mjs analyze`, which
// writes run-analysis.md (lib/analyze.mjs). `next` never runs a program, so
// the analysis runs only when the agent performs this action (D19.20).
import { conductScript } from '../touch.mjs';

export function next(state) {
  return {
    kind: 'shell', step: 'analyze', command: ['node', conductScript(state), 'analyze', '--run', state.runDir], expects: { type: 'exit0' },
    instruction: 'Run this exact argv (no shell): it writes run-analysis.md in the run dir. Record its { code, stdout, stderr }.',
  };
}

export function record(state) {
  state.phase = 'showcase';
}
