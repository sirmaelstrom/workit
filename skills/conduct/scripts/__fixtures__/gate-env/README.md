# Gate-env fixtures

Suite output for `lib/gate-env.mjs`'s timeout classifier, captured from the real runners on 2026-10-22 (Node v24.13.0, vitest 5.0.5) over throwaway tests in a temp directory. Two edits at capture: CRLF became LF (`.gitattributes` keeps fixtures LF; the tests add the CRs back), and the temp directory's path became `<tmp>`.

- `node-timeouts.out`: `node --test a.test.mjs` (stdout): one test past its `timeout`, a passing test, and a suite whose `before` hook times out, which cancels its child.
- `node-mixed.out`: `node --test` over the same file plus `b.test.mjs`, a failing `assert.equal`: the timeouts with one real assertion failure.
- `node-nested.out`: `node --test c.test.mjs`: a timeout inside a `describe` and inside a `t.test` subtest; neither parent is listed.
- `vitest-timeouts.out` / `.err`: `vitest run --root . a.test.ts` (stdout / stderr): a test past its timeout and a `beforeAll` past its hook timeout.
- `vitest-mixed.out` / `.err`: `vitest run --root .` over the same file plus `b.test.ts`, a failing `expect(1).toBe(2)`.
