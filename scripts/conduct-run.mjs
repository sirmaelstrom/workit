#!/usr/bin/env node
// Stable entry point for drivers: resolve the run's plugin on every call.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function runDriver(argv, { read = (path) => readFileSync(path, 'utf8'), spawn = spawnSync } = {}) {
  const at = argv.indexOf('--run');
  if (at < 0 || !argv[at + 1]) throw new Error('conduct-run requires <verb> --run <dir>; use conduct.mjs directly for intake or upgrade-root');
  const state = JSON.parse(read(join(resolve(argv[at + 1]), 'state.json')));
  if (typeof state.pluginRoot !== 'string' || !state.pluginRoot) throw new Error('run state has no pluginRoot');
  const result = spawn(process.execPath, [join(state.pluginRoot, 'skills/conduct/scripts/conduct.mjs'), ...argv], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = runDriver(process.argv.slice(2)); }
  catch (error) { console.error(`conduct-run: ${error.message}`); process.exitCode = 2; }
}
