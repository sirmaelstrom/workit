// github-ask.mjs against a fake gh (an in-memory issue thread) and a fake
// Observatory (a node:http server on port 0). Nothing here calls GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askBody, carriesUnquotedTag, EXIT, GRAMMAR, main, poll, post } from './github-ask.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'github-ask.mjs');
const ASK = '6d0f1c3e-2b7a-4c55-9e1d-0a1b2c3d4e5f';
const OTHER_ASK = '11111111-2222-4333-8444-555555555555';
const OPERATOR = 'sirmaelstrom';
const OPTIONS = [
  { key: 'a', label: 'Ship it', consequence: 'the run merges.' },
  { key: 'b', label: 'Hold', consequence: 'the run stops here.' },
];
const SPEC = { quest: '008747c2-8509-48d8-bc94-d9014ce7ce21', askReceiptId: ASK, question: 'Merge the slim-down PR?', options: OPTIONS, target: 'o/r#7', run: 'burn-down lane w2b' };

/** An issue thread behind a fake `gh api`: lists, fetches and posts comments. */
function fakeGh(initial = []) {
  const comments = initial.map((comment) => ({ type: 'User', app: false, login: OPERATOR, ...comment }));
  const calls = [];
  let next = 1000;
  const shape = (comment) => ({ ...comment, html_url: `https://github.com/o/r/issues/7#issuecomment-${comment.id}` });
  const gh = (args, { input } = {}) => {
    calls.push({ args, input });
    if (args.includes('--method') && args.includes('POST')) {
      next += 1;
      const comment = { id: next, body: JSON.parse(input).body, created_at: `2026-10-19T15:${String(next - 1000).padStart(2, '0')}:00Z`, login: OPERATOR, type: 'User', app: false };
      comments.push(comment);
      return JSON.stringify({ id: comment.id, html_url: shape(comment).html_url });
    }
    const one = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(args[1]);
    if (one) {
      const comment = comments.find((c) => c.id === Number(one[1]));
      if (!comment) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
      return JSON.stringify({ ...shape(comment), user: { login: comment.login, type: comment.type } });
    }
    if (/^repos\/o\/r\/issues\/7\/comments/.test(args[2] ?? '')) {
      return comments.map((comment) => JSON.stringify(shape(comment))).join('\n');
    }
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  return { gh, comments, calls, posts: () => calls.filter((call) => call.args.includes('POST')) };
}

const askComment = (id = 500, body = askBody(SPEC)) => ({ id, body, created_at: '2026-10-19T14:00:00Z' });
const reply = (id, body, extra = {}) => ({ id, body, created_at: `2026-10-19T14:${String(id - 500).padStart(2, '0')}:30Z`, ...extra });
const askUrl = 'https://github.com/o/r/issues/7#issuecomment-500';

/** A fake Observatory route: `respond(body)` returns [status, json] per request. */
async function fakeObservatory(t, respond) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ method: req.method, url: req.url, body });
      const [status, json] = respond(body, seen.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

function deps(gh, extra = {}) {
  const logs = [];
  const sleeps = [];
  let clock = 0;
  return {
    gh, fetch: globalThis.fetch, logs, sleeps,
    log: (line) => logs.push(line),
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    env: {},
    readFile: () => { throw new Error('no file'); },
    ...extra,
  };
}

const pollOpts = (base, extra = {}) => ({ ask: ASK, askComment: askUrl, once: true, interval: 60, timeout: 3600, observatory: base, ...extra });

test('post: the ask comment carries the grammar verbatim, the recommendation first, the run and an unquoted tag', async () => {
  const fake = fakeGh();
  const result = await post(SPEC, deps(fake.gh));
  assert.equal(result.status, 'posted');
  assert.equal(result.existing, false);
  assert.match(result.askCommentUrl, /#issuecomment-1001$/);
  const [call] = fake.posts();
  assert.deepEqual(call.args.slice(0, 4), ['api', '--method', 'POST', 'repos/o/r/issues/7/comments']);
  const body = JSON.parse(call.input).body;
  assert.ok(body.includes('Reply with the letter alone on the first line; put any notes on the lines below.'));
  assert.ok(body.includes(GRAMMAR));
  assert.ok(body.includes('`burn-down lane w2b`'));
  assert.ok(body.indexOf('**a** — Ship it (Recommended): the run merges.') < body.indexOf('**b** — Hold: the run stops here.'));
  assert.equal(body.split('\n').at(-1), `[ask ${ASK}]`);
  assert.equal(carriesUnquotedTag(body), true);
});

test('post: a label that already says (recommended) is the only one marked', () => {
  const options = [OPTIONS[0], { ...OPTIONS[1], label: 'Hold (recommended)' }];
  const body = askBody({ ...SPEC, options });
  assert.ok(body.includes('**a** — Ship it: the run merges.'));
  assert.ok(body.includes('**b** — Hold (recommended): the run stops here.'));
  assert.equal(body.match(/recommended/gi).length, 1);
});

test('post: a second post for the same ask returns the comment already there and posts nothing', async () => {
  const fake = fakeGh([askComment()]);
  const result = await post(SPEC, deps(fake.gh));
  assert.equal(result.existing, true);
  assert.equal(result.askCommentId, 500);
  assert.equal(fake.posts().length, 0);
});

test('post: a malformed spec is a usage error (exit 2) and posts nothing', async () => {
  const fake = fakeGh();
  const cases = [
    { ...SPEC, askReceiptId: 'abc' },
    { ...SPEC, target: 'o/r' },
    { ...SPEC, options: [OPTIONS[0]] },
    { ...SPEC, options: [OPTIONS[0], { ...OPTIONS[1], key: 'a' }] },
    { ...SPEC, options: [OPTIONS[0], { ...OPTIONS[1], key: 'g' }] },
    { ...SPEC, run: '' },
  ];
  for (const spec of cases) {
    const result = await main(['post', '--spec', 'x.json'], deps(fake.gh, { readFile: () => JSON.stringify(spec) }));
    assert.equal(result.status, 'usage', JSON.stringify(spec));
    assert.equal(EXIT[result.status], 2);
  }
  assert.equal(fake.posts().length, 0);
});

test('poll: the operator reply is recorded with exactly {askReceiptId, commentUrl}', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'a\nsend it Monday')]);
  const obs = await fakeObservatory(t, () => [201, { receiptId: 'r-1', key: 'a', label: 'a — Ship it' }]);
  const result = await poll(pollOpts(obs.base), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.equal(result.key, 'a');
  assert.equal(result.duplicate, false);
  assert.equal(obs.seen.length, 1);
  assert.equal(obs.seen[0].url, '/api/spine/answers/github');
  assert.deepEqual(obs.seen[0].body, { askReceiptId: ASK, commentUrl: 'https://github.com/o/r/issues/7#issuecomment-501' });
});

test('poll: a 200 duplicate is answered too', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'b')]);
  const obs = await fakeObservatory(t, () => [200, { receiptId: 'r-1', key: 'b', label: 'b — Hold', duplicate: true }]);
  const result = await poll(pollOpts(obs.base), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.equal(result.duplicate, true);
});

test('poll: skips comments before the ask, other authors, apps, its own marker and asks; submits the earliest operator reply', async (t) => {
  const fake = fakeGh([
    reply(499, 'a', { created_at: '2026-10-19T13:00:00Z' }),
    askComment(),
    reply(501, 'b', { login: 'review-bot' }),
    reply(502, 'b', { app: true }),
    reply(503, '<!-- workit:github-ask follow-up ask=x reply=1 -->\nb'),
    reply(504, `b\n[ask ${OTHER_ASK}]`),
    reply(506, 'a'),
    reply(505, `> [ask ${ASK}]\nb`),
  ]);
  const obs = await fakeObservatory(t, () => [201, { receiptId: 'r', key: 'b', label: 'b — Hold' }]);
  const result = await poll(pollOpts(obs.base), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.deepEqual(obs.seen.map((s) => s.body.commentUrl), ['https://github.com/o/r/issues/7#issuecomment-505']);
});

test('poll: a reply that is not a ruling gets one follow-up restating the grammar, and the next reply is recorded', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'b. sounds good'), reply(502, 'b')]);
  const obs = await fakeObservatory(t, (body) => (body.commentUrl.endsWith('-501')
    ? [422, { error: 'not_a_ruling', message: 'no' }]
    : [201, { receiptId: 'r', key: 'b', label: 'b — Hold' }]));
  const result = await poll(pollOpts(obs.base), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.equal(result.commentUrl, 'https://github.com/o/r/issues/7#issuecomment-502');
  const followUps = fake.posts();
  assert.equal(followUps.length, 1);
  const body = JSON.parse(followUps[0].input).body;
  assert.ok(body.includes(GRAMMAR));
  assert.ok(body.includes('`not_a_ruling`'));
  assert.equal(carriesUnquotedTag(body), false);
});

test('poll: a re-run over the same rejected reply posts no second follow-up', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'thinking about it')]);
  const obs = await fakeObservatory(t, () => [422, { error: 'not_a_ruling', message: 'no' }]);
  assert.equal((await poll(pollOpts(obs.base), deps(fake.gh))).status, 'waiting');
  assert.equal((await poll(pollOpts(obs.base), deps(fake.gh))).status, 'waiting');
  assert.equal(fake.posts().length, 1);
  assert.equal(obs.seen.length, 2);
});

test('poll: 409, 403 and 503 stop with their status; another 4xx is refused', async (t) => {
  const cases = [
    [409, 'stale_ask', 'conflict', 3],
    [409, 'no_open_ask', 'conflict', 3],
    [403, 'not_operator', 'not_operator', 4],
    [503, 'operator_login_unconfigured', 'unconfigured', 5],
    [400, 'not_a_reply', 'refused', 6],
  ];
  for (const [http, error, status, exit] of cases) {
    const fake = fakeGh([askComment(), reply(501, 'a')]);
    const obs = await fakeObservatory(t, () => [http, { error, message: error }]);
    const result = await poll(pollOpts(obs.base, { once: false }), deps(fake.gh));
    assert.equal(result.status, status, error);
    assert.equal(result.code, error);
    assert.equal(EXIT[result.status], exit);
    assert.equal(fake.posts().length, 0, error);
  }
});

test('poll: Observatory unreachable keeps the reply and retries with backoff until it records', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'a')]);
  let up = 0;
  const obs = await fakeObservatory(t, () => [201, { receiptId: 'r', key: 'a', label: 'a — Ship it' }]);
  const flaky = async (url, init) => {
    up += 1;
    if (up < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return globalThis.fetch(url, init);
  };
  const d = deps(fake.gh, { fetch: flaky });
  const result = await poll(pollOpts(obs.base, { once: false, interval: 10 }), d);
  assert.equal(result.status, 'answered');
  assert.deepEqual(d.sleeps, [20000, 40000]);
  assert.equal(obs.seen.length, 1);
});

test('poll: a closed port is waiting with the pending reply under --once, never a stop', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  const fake = fakeGh([askComment(), reply(501, 'a')]);
  const result = await poll(pollOpts(base), deps(fake.gh));
  assert.equal(result.status, 'waiting');
  assert.equal(result.pending.commentUrl, 'https://github.com/o/r/issues/7#issuecomment-501');
  assert.equal(EXIT[result.status], 7);
});

test('poll: no reply before the deadline is timeout, and a 502 is retried rather than stopped', async (t) => {
  const quiet = fakeGh([askComment()]);
  const obs = await fakeObservatory(t, () => [502, { error: 'github_unavailable', message: 'x' }]);
  const d = deps(quiet.gh);
  const result = await poll(pollOpts(obs.base, { once: false, interval: 600, timeout: 1800 }), d);
  assert.equal(result.status, 'timeout');
  assert.deepEqual(d.sleeps, [600000, 600000, 600000]);

  const fake = fakeGh([askComment(), reply(501, 'a')]);
  const retried = await poll(pollOpts(obs.base, { once: false, interval: 600, timeout: 1800 }), deps(fake.gh));
  assert.equal(retried.status, 'timeout');
  assert.equal(retried.pending.reason, 'github_unavailable');
});

test('poll --spec: finds the ask comment post left on the target by its marker, and errors when there is none', async (t) => {
  const fake = fakeGh([reply(400, 'unrelated', { created_at: '2026-10-19T13:00:00Z' }), askComment(), reply(501, 'b')]);
  const obs = await fakeObservatory(t, () => [201, { receiptId: 'r', key: 'b', label: 'b — Hold' }]);
  const run = (gh) => main(['poll', '--spec', 's.json', '--once', '--observatory', obs.base], deps(gh, { readFile: () => JSON.stringify(SPEC) }));
  const result = await run(fake.gh);
  assert.equal(result.status, 'answered');
  assert.deepEqual(obs.seen[0].body, { askReceiptId: ASK, commentUrl: 'https://github.com/o/r/issues/7#issuecomment-501' });

  const none = await run(fakeGh([reply(501, 'b')]).gh);
  assert.equal(none.status, 'error');
  assert.match(none.error, /no ask comment .* run post first/);
});

test('poll: an unreadable ask comment is an error, not a wait', async () => {
  const result = await poll(pollOpts('http://127.0.0.1:9', { askComment: 'https://github.com/o/r/issues/7#issuecomment-404' }), deps(fakeGh().gh));
  assert.equal(result.status, 'error');
  assert.match(result.error, /ask comment could not be read/);
});

test('cli: bad arguments print a usage status and exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'poll', '--ask', 'nope', '--ask-comment', askUrl], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).status, 'usage');
});
