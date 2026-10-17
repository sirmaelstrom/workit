// testDeps: the deps a conduct test hands runConduct, recordTouch, acceptAnswer
// or awaitAnswer. readAnchor defaults to "no passkey configured", so no test
// reads the real operator anchor under the home directory; a test of the
// passkey path passes its own. anchor-isolation.test.mjs enforces the use.
export function testDeps(overrides = {}) {
  return { readAnchor: () => ({ configured: false, epoch: 0 }), ...overrides };
}
