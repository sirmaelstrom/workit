import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runConduct } from './conduct.mjs';
import { askId } from './lib/phases/build.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldRoot = join(dir, 'old-plugin'), pluginRoot = join(dir, 'new-plugin');
  for (const file of ['scripts/lane.mjs', 'skills/conduct/scripts/conduct.mjs', 'skills/slim-review/scripts/pr-review.mjs']) {
    mkdirSync(dirname(join(pluginRoot, file)), { recursive: true });
    writeFileSync(join(pluginRoot, file), '// fixture');
  }
  const path = join(dir, 'state.json');
  const state = { schemaVersion: 1, runDir: dir, pluginRoot: oldRoot, phase: 'build', rev: 0, seq: 0, txns: [], pending: null,
    wps: [{ id: 'WP-01', state: 'blocked', pr: { head: 'a'.repeat(40) }, queue: [{ command: ['node', join(oldRoot, 'scripts/lane.mjs')], instruction: `Use ${oldRoot}` }], reviews: [{ path: join(oldRoot, 'receipt.md') }] }] };
  writeFileSync(path, JSON.stringify(state));
  return { dir, path, state, oldRoot, pluginRoot, deps: { pluginRoot, lockWaitMs: 0 }, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

test('upgrade-root snapshots and migrates executable queues while old drivers refuse the moved run', async (t) => {
  const h = fixture(t);
  const out = await runConduct(['upgrade-root', '--run', h.dir, '--why', 'Shopfloor recovery capability'], h.deps);
  assert.equal(out.code, 0, out.stderr);
  const state = h.read(), result = JSON.parse(out.stdout);
  assert.equal(JSON.parse(readFileSync(result.snapshot, 'utf8')).pluginRoot, h.oldRoot);
  assert.equal(state.pluginRoot, h.pluginRoot);
  assert.equal(state.wps[0].queue[0].command[1], join(h.pluginRoot, 'scripts/lane.mjs'));
  assert.equal(state.wps[0].reviews[0].path, join(h.oldRoot, 'receipt.md'));
  const old = await runConduct(['status', '--run', h.dir], { pluginRoot: h.oldRoot });
  assert.equal(old.code, 2);
  assert.match(old.stderr, /run moved to the plugin root/);
});

test('upgrade-root refuses pending actions without changing their state', async (t) => {
  const h = fixture(t);
  h.state.pending = { id: '1-merge', command: ['gh', 'pr', 'merge'] };
  writeFileSync(h.path, JSON.stringify(h.state));
  assert.equal((await runConduct(['upgrade-root', '--run', h.dir, '--why', 'upgrade'], h.deps)).code, 5);
  assert.deepEqual(h.read(), h.state);
});

test('upgrade-root migrates an emitted author action without losing its id', async (t) => {
  const h = fixture(t);
  h.state.pending = { id: '10-brief', kind: 'author', instruction: `Read ${join(h.oldRoot, 'template.md')}` };
  h.state.release = { queue: [{ command: ['node', join(h.oldRoot, 'scripts/release.mjs')] }] };
  h.state.wps[0].owed = { queue: [{ command: ['node', join(h.oldRoot, 'scripts/reply.mjs')] }] };
  writeFileSync(h.path, JSON.stringify(h.state));
  const out = await runConduct(['upgrade-root', '--run', h.dir, '--why', 'paused at author action'], h.deps);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(h.read().pending.id, '10-brief');
  assert.equal(h.read().pending.instruction, `Read ${join(h.pluginRoot, 'template.md')}`);
  assert.equal(h.read().release.queue[0].command[1], join(h.pluginRoot, 'scripts/release.mjs'));
  assert.equal(h.read().wps[0].owed.queue[0].command[1], join(h.pluginRoot, 'scripts/reply.mjs'));
});

test('ci-checks records an explicit exact-head policy and rejects stale heads', async (t) => {
  const h = fixture(t);
  h.state.pluginRoot = h.pluginRoot;
  writeFileSync(h.path, JSON.stringify(h.state));
  const args = ['ci-checks', '--run', h.dir, '--wp', 'WP-01', '--head', 'a'.repeat(40), '--checks', 'core,app,app-test', '--why', 'WP replaces scaffold workflow'];
  assert.equal((await runConduct(args, h.deps)).code, 0);
  assert.deepEqual(h.read().wps[0].ciCheckPolicy.names, ['core', 'app', 'app-test']);
  args[args.indexOf('--head') + 1] = 'b'.repeat(40);
  assert.equal((await runConduct(args, h.deps)).code, 5);
});

test('resolution annotations do not create another ask identity; different questions still do', () => {
  const original = { question: '(a) Extend the script?', text: '(a) Yes, use the shared runner' };
  assert.equal(askId({ ...original, question: `${original.question} **[resolved: ruling wp-17-1]**` }), askId(original));
  assert.equal(askId({ ...original, question: `Resolved by amendment 1: ${original.question}` }), askId(original));
  assert.equal(askId({ ...original, question: '1. **Resolved by amendment 1** (ruled (a): fixed in this PR, see `## Amendment 1`). Extend the script?' }), askId({ ...original, question: '1. Extend the script?' }));
  assert.notEqual(askId({ ...original, question: '(a) Change the simulator?' }), askId(original));
});
