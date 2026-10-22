import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateFailureKind, quietProbe } from './gate-env.mjs';
import { runConduct } from '../conduct.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'gate-env');
const read = (name) => (existsSync(join(FIXTURES, name)) ? readFileSync(join(FIXTURES, name), 'utf8') : '');
const output = (name) => [read(`${name}.out`), read(`${name}.err`)];
const kind = (name) => gateFailureKind(...output(name));

test('gate-env (6f3a6194): a run whose every failure is a timeout is all-timeout, under node:test and vitest', () => {
  assert.deepEqual(kind('vitest-timeouts'), { runner: 'vitest', failures: 2, timeouts: 2, other: 0, allTimeout: true });
  // The child its parent's timeout cancelled counts with the timeout.
  assert.deepEqual(kind('node-timeouts'), { runner: 'node', failures: 3, timeouts: 2, other: 0, allTimeout: true });
  assert.deepEqual(kind('node-nested'), { runner: 'node', failures: 2, timeouts: 2, other: 0, allTimeout: true });
});

test('gate-env (6f3a6194): one real assertion failure among the timeouts is not all-timeout', () => {
  assert.deepEqual(kind('vitest-mixed'), { runner: 'vitest', failures: 3, timeouts: 2, other: 1, allTimeout: false });
  assert.deepEqual(kind('node-mixed'), { runner: 'node', failures: 4, timeouts: 2, other: 1, allTimeout: false });
});

test('gate-env (6f3a6194): CRLF and colour do not change the reading; a cut-short, foreign or empty output is never all-timeout', () => {
  const [out, err] = output('vitest-timeouts');
  const crlf = (text) => text.replaceAll('\n', '\r\n');
  assert.equal(gateFailureKind(crlf(out), crlf(err)).allTimeout, true);
  assert.equal(gateFailureKind(read('node-timeouts.out').replaceAll('✖ times out', '\x1b[31m✖ times out\x1b[39m')).allTimeout, true);
  // The listing announces 2 failures; a read cut after the first is unreadable.
  assert.equal(gateFailureKind(out, err.slice(0, err.indexOf('Failed Tests'))), null);
  // node:test prints its summary before the listing: without it the run did not finish.
  assert.equal(gateFailureKind(read('node-timeouts.out').replace(/^ℹ fail \d+\n/m, '')), null);
  assert.equal(gateFailureKind('not ok 1 - times out\n# fail 1\n', ''), null);
  assert.equal(gateFailureKind('', 'npm ERR! code ELIFECYCLE'), null);
  // An unhandled error outside the listing is not a timeout.
  assert.equal(gateFailureKind(out, `${err}\n⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\n\nError: ECONNREFUSED\n`), null);
});

test('quiet probe (6f3a6194): busy percent of every core over each interval; quiet only when every interval is under the limit', async () => {
  const core = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
  // 20 of 200 ticks busy, then 40 of 100: one core at 60 %, the other at 20 %.
  const reads = [[core(0, 0), core(0, 0)], [core(10, 90), core(10, 90)], [core(40, 110), core(20, 130)]];
  const slept = [];
  const deps = { cpus: () => reads.shift(), sleep: async (ms) => { slept.push(ms); } };
  assert.deepEqual(await quietProbe({ samples: 2, intervalMs: 1000, maxBusy: 30 }, deps), { quiet: false, busy: [10, 40], maxBusy: 30, intervalMs: 1000 });
  assert.deepEqual(slept, [1000, 1000]);
  const flat = { cpus: () => [core(0, 0)], sleep: async () => {} };
  assert.equal((await quietProbe({ samples: 1, intervalMs: 1 }, flat)).quiet, true);
});

test('quiet verb (6f3a6194): exit 0 quiet, 1 busy, its samples printed; bad flags exit 2', async () => {
  let t = 0;
  const busyHost = { cpus: () => [{ times: { user: (t += 50), nice: 0, sys: 0, idle: t, irq: 0 } }], sleep: async () => {} };
  const busy = await runConduct(['quiet', '--samples', '2', '--interval-ms', '100'], busyHost);
  assert.equal(busy.code, 1);
  assert.deepEqual(JSON.parse(busy.stdout), { quiet: false, busy: [50, 50], maxBusy: 30, intervalMs: 100 });
  const quiet = await runConduct(['quiet', '--max-busy', '60', '--interval-ms', '100'], busyHost);
  assert.equal(quiet.code, 0);
  assert.equal(JSON.parse(quiet.stdout).busy.length, 3);
  const bad = await runConduct(['quiet', '--samples', '0'], busyHost);
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).error, /--samples must be a whole number from 1 to 10/);
});
