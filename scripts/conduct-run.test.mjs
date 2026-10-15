import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runDriver } from './conduct-run.mjs';

test('driver follows the run root on every invocation and preserves child status', () => {
  let root = join('/', 'plugins', 'before');
  const calls = [];
  const deps = { read: () => JSON.stringify({ pluginRoot: root }), spawn: (exe, args) => { calls.push([exe, args]); return { status: 5 }; } };
  assert.equal(runDriver(['next', '--run', join('/', 'runs', 'sample')], deps), 5);
  root = join('/', 'plugins', 'after');
  runDriver(['next', '--run', join('/', 'runs', 'sample')], deps);
  assert.deepEqual(calls.map((call) => call[1][0]), [join('/', 'plugins', 'before', 'skills/conduct/scripts/conduct.mjs'), join(root, 'skills/conduct/scripts/conduct.mjs')]);
});
