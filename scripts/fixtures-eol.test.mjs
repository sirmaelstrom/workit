// Fixture checkouts are byte-identical to their blobs.
//
// Tests hash and compare fixture files byte for byte. A Windows checkout with
// core.autocrlf=true materialises CRLF unless .gitattributes pins the fixture
// directories to LF, and a CRLF copy hashes differently from the committed
// blob. This test reads the working copy, so it fails on exactly that checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = /(^|\/)(__fixtures__|fixtures)\//;

test('every tracked fixture checks out with LF line endings', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((p) => FIXTURE_DIR.test(p));
  // An empty list would pass vacuously: fail instead.
  assert.ok(tracked.length > 0, 'no tracked fixture files found');
  const withCr = tracked.filter((p) => readFileSync(join(REPO_ROOT, p)).includes(0x0d));
  assert.deepEqual(withCr, [], `fixture files checked out with CR bytes (pin them in .gitattributes): ${withCr.join(', ')}`);
});
