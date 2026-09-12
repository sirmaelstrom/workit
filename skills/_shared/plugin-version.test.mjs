import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the marketplace advertises the bundled plugin version', () => {
  const plugin = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const marketplace = JSON.parse(readFileSync(new URL('../../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  const entries = marketplace.plugins.filter((entry) => entry.name === plugin.name);
  assert.equal(entries.length, 1, 'exactly one marketplace entry must name the bundled plugin');
  assert.equal(entries[0].version, plugin.version, 'bump both release manifests together');
});
