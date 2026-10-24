#!/usr/bin/env node
// A claude lane's Stop hook: node stop-check.mjs --run <dir> --wp <id>, with the
// hook input on stdin. It runs `conduct.mjs lane stop-check` in process and
// prints {"decision":"block","reason":…} only when that verdict blocks the stop.
// It always exits 0 and prints nothing else: exit 2 would block the lane with a
// crash for its reason, and the lane cannot repair the conductor's script.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runConduct } from './conduct.mjs';

export async function stopCheck(argv, overrides = {}) {
  try {
    const result = await runConduct(['lane', 'stop-check', ...argv], overrides);
    const out = JSON.parse(result.stdout);
    return out?.block === true && typeof out.instruction === 'string' ? JSON.stringify({ decision: 'block', reason: out.instruction }) : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const decision = await stopCheck(process.argv.slice(2));
  if (decision) process.stdout.write(decision);
  process.exitCode = 0;
}
