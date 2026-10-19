// github-ask.mjs against a fake gh (in-memory issues and threads) and a fake
// Observatory (a node:http server on port 0). Nothing here calls GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askArtifact, askBody, carriesUnquotedTag, EXIT, GRAMMAR, main, poll, post } from './github-ask.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'github-ask.mjs');
const ASK = '6d0f1c3e-2b7a-4c55-9e1d-0a1b2c3d4e5f';
const QUEST = '008747c2-0000-4000-8000-000000000001';
// main's default Observatory in these tests: refused at once, so no test reaches the live one on :3100.
const NOWHERE = 'http://observatory.invalid';
const OTHER_ASK = '11111111-2222-4333-8444-555555555555';
const OPERATOR = 'sirmaelstrom';
const OPTIONS = [
  { key: 'a', label: 'Ship it', consequence: 'the run merges.' },
  { key: 'b', label: 'Hold', consequence: 'the run stops here.' },
];
const SPEC = { askReceiptId: ASK, questId: QUEST, question: 'Merge the slim-down PR?', options: OPTIONS, recommended: 'a', target: 'o/r#7', run: 'burn-down lane w2b' };

/**
 * Issues and their threads behind a fake `gh api`: lists, fetches, posts and
 * deletes comments, lists and opens issues. `onPost(comment)` runs after a
 * comment is posted (a racer can add its own there); `failPosts` makes the
 * next N comment posts fail.
 */
function fakeGh(initial = [], { issues = [], onPost = null, failPosts = 0, visible = () => true } = {}) {
  const comments = initial.map((comment) => ({ type: 'User', app: false, login: OPERATOR, issue: 7, ...comment }));
  const issueList = [...issues];
  const calls = [];
  let next = 1000;
  let failing = failPosts;
  const shape = (comment) => ({ ...comment, html_url: `https://github.com/o/r/issues/${comment.issue}#issuecomment-${comment.id}` });
  const gh = (args, { input } = {}) => {
    calls.push({ args, input });
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    const path = args.find((arg) => arg.startsWith('repos/'));
    if (method === 'POST' && /^repos\/o\/r\/issues$/.test(path)) {
      const issue = { number: 40 + issueList.length, ...JSON.parse(input) };
      issueList.push(issue);
      return JSON.stringify(issue);
    }
    const thread = /^repos\/o\/r\/issues\/(\d+)\/comments/.exec(path);
    if (method === 'POST' && thread) {
      if (failing > 0) {
        failing -= 1;
        throw Object.assign(new Error('gh: HTTP 502'), { stderr: 'gh: HTTP 502' });
      }
      next += 1;
      const comment = { id: next, body: JSON.parse(input).body, created_at: `2026-10-19T15:${String(next - 1000).padStart(2, '0')}:00Z`, login: OPERATOR, type: 'User', app: false, issue: Number(thread[1]) };
      comments.push(comment);
      onPost?.(comment, comments);
      return JSON.stringify({ id: comment.id, html_url: shape(comment).html_url });
    }
    const one = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path);
    if (method === 'DELETE' && one) {
      comments.splice(comments.findIndex((c) => c.id === Number(one[1])), 1);
      return '';
    }
    if (one) {
      const comment = comments.find((c) => c.id === Number(one[1]));
      if (!comment) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
      return JSON.stringify({ ...shape(comment), user: comment.login === null ? null : { login: comment.login, type: comment.type } });
    }
    if (thread) return comments.filter((c) => c.issue === Number(thread[1]) && visible(c)).map((comment) => JSON.stringify(shape(comment))).join('\n');
    if (/^repos\/o\/r\/issues\?state=all/.test(path)) return issueList.map((issue) => JSON.stringify({ number: issue.number, body: issue.body })).join('\n');
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  const commentPosts = () => calls.filter((call) => call.args.includes('POST') && /\/comments$/.test(call.args.find((arg) => arg.startsWith('repos/'))));
  return { gh, comments, issues: issueList, calls, posts: commentPosts, deletes: () => calls.filter((call) => call.args.includes('DELETE')) };
}

const askComment = (id = 500, body = askBody(SPEC)) => ({ id, body, created_at: '2026-10-19T14:00:00Z' });
const reply = (id, body, extra = {}) => ({ id, body, created_at: `2026-10-19T14:${String(id - 500).padStart(2, '0')}:30Z`, ...extra });
const askUrl = 'https://github.com/o/r/issues/7#issuecomment-500';

/**
 * A fake Observatory. The answers route: `respond(body)` returns [status, json]
 * per request, in `seen`. The quest update route: `link(body)` does, in `links`;
 * by default it keeps one row per (type, locator, quest), as attachRef does.
 */
async function fakeObservatory(t, respond, { link = null } = {}) {
  const seen = [];
  const links = [];
  const rows = new Set();
  const minted = (body, url) => {
    const quest = /^\/api\/spine\/quests\/([^/]+)\/update$/.exec(url)[1];
    for (const artifact of body.artifacts ?? []) rows.add(`${artifact.type} ${artifact.locator} ${quest}`);
    return [200, { questId: quest, quest: null }];
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const isLink = /\/update$/.test(req.url);
      (isLink ? links : seen).push({ method: req.method, url: req.url, body });
      const [status, json] = isLink ? (link ?? minted)(body, req.url) : respond(body, seen.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, links, rows };
}

const refused = (url, init) => (String(url).startsWith(NOWHERE)
  ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
  : globalThis.fetch(url, init));

function deps(gh, extra = {}) {
  const logs = [];
  const sleeps = [];
  const d = {
    gh, fetch: refused, logs, sleeps, clock: 0,
    log: (line) => logs.push(line),
    sleep: async (ms) => { sleeps.push(ms); d.clock += ms; },
    now: () => d.clock,
    env: { OBSERVATORY_BASE_URL: NOWHERE },
    readFile: () => { throw new Error('no file'); },
    ...extra,
  };
  return d;
}

const pollOpts = (base, extra = {}) => ({ ask: ASK, askComment: askUrl, operator: OPERATOR, once: true, interval: 60, timeout: 3600, observatory: base, ...extra });
const recorded = (key = 'b') => [201, { receiptId: 'r', key, label: `${key} — x` }];

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
  assert.ok(body.includes('This ask takes the letter alone: notes below it are refused.'));
  assert.equal(body.split('\n').at(-1), `[ask ${ASK}]`);
  assert.equal(carriesUnquotedTag(body), true);
});

test('post: only the recommended key is marked, once, and never by position', () => {
  const unmarked = askBody({ ...SPEC, recommended: undefined });
  assert.equal(/recommended/i.test(unmarked), false);
  const labelled = askBody({ ...SPEC, recommended: 'b', options: [OPTIONS[0], { ...OPTIONS[1], label: 'Hold (Recommended)' }] });
  assert.ok(labelled.includes('**a** — Ship it: the run merges.'));
  assert.ok(labelled.includes('**b** — Hold (Recommended): the run stops here.'));
  assert.equal(labelled.match(/recommended/gi).length, 1);
});

test('post: a one-option ask posts, and its instructions say to reply a, then the answer below; free text on a multi-option ask says where typed text goes', async () => {
  const one = { ...SPEC, recommended: undefined, allowFreeText: true, options: [{ key: 'a', label: 'Record the release as failed', consequence: 'the analysis names it.' }] };
  const fake = fakeGh();
  const result = await post(one, deps(fake.gh));
  assert.equal(result.status, 'posted');
  const body = JSON.parse(fake.posts()[0].input).body;
  assert.ok(body.includes('This ask has one option: reply with `a` on the first line, then your answer on the lines below.'), body);
  assert.ok(askBody({ ...one, allowFreeText: false }).includes('This ask has one option: reply with `a` alone.'));
  assert.ok(askBody({ ...SPEC, allowFreeText: true }).includes('where an option asks you to type something, such as an amount, put it there.'));
});

test('post: an ask with no options is a usage error that says how to post a free-text question', async () => {
  const fake = fakeGh();
  const result = await main(['post', '--spec', 'x.json'], deps(fake.gh, { readFile: () => JSON.stringify({ ...SPEC, options: [], allowFreeText: true }) }));
  assert.equal(result.status, 'usage');
  assert.match(result.error, /file and post a free-text question as one option, \(a\), with allowFreeText true/);
  assert.equal(fake.posts().length, 0);
});

test('post: a second post for the same ask returns the comment already there and posts nothing', async () => {
  const fake = fakeGh([askComment()]);
  const result = await post(SPEC, deps(fake.gh));
  assert.equal(result.existing, true);
  assert.equal(result.askCommentId, 500);
  assert.equal(fake.posts().length, 0);
});

test('post: a concurrent post of the same ask converges on the earliest comment, and the later poster deletes its own', async () => {
  // The racer's comment lands while ours is in flight, with the lower id.
  const fake = fakeGh([], { onPost: (comment, all) => { if (comment.id === 1001) all.push({ id: 900, body: askBody(SPEC), created_at: '2026-10-19T14:59:00Z', login: OPERATOR, type: 'User', app: false, issue: 7 }); } });
  const result = await post(SPEC, deps(fake.gh));
  assert.deepEqual([result.existing, result.askCommentId], [true, 900]);
  assert.deepEqual(fake.deletes().map((call) => call.args.at(-1)), ['repos/o/r/issues/comments/1001']);
  assert.deepEqual(fake.comments.filter((c) => c.body.includes(`ask=${ASK}`)).map((c) => c.id), [900]);
});

test('post: an <owner/repo> target opens the run\'s asks issue once, and poll --spec finds the ask there', async (t) => {
  const spec = { ...SPEC, target: 'o/r', issue: { key: 'conduct demo abcd1234', title: 'conduct demo: operator asks (run abcd1234)' } };
  const fake = fakeGh();
  const first = await post(spec, deps(fake.gh));
  assert.deepEqual([first.status, first.target, fake.issues.length], ['posted', 'o/r#40', 1]);
  assert.equal(fake.issues[0].title, 'conduct demo: operator asks (run abcd1234)');
  const again = await post({ ...spec, askReceiptId: OTHER_ASK }, deps(fake.gh));
  assert.deepEqual([again.target, again.existing, fake.issues.length], ['o/r#40', false, 1]);
  fake.comments.push({ id: 1500, body: 'b', created_at: '2026-10-19T16:00:00Z', login: OPERATOR, type: 'User', app: false, issue: 40 });
  const obs = await fakeObservatory(t, () => recorded());
  const polled = await main(['poll', '--spec', 's.json', '--once', '--operator', OPERATOR, '--observatory', obs.base], deps(fake.gh, { readFile: () => JSON.stringify(spec) }));
  assert.equal(polled.status, 'answered');
  assert.equal(obs.seen[0].body.commentUrl, 'https://github.com/o/r/issues/40#issuecomment-1500');
});

test('post --spec: the opened asks issue\'s number goes into the spec file, so a re-run finds it while GitHub\'s issue list still lags', async () => {
  const fake = fakeGh();
  // GitHub's issue list does not show a new issue yet.
  const realGh = fake.gh;
  const lagging = (args, opts) => (/issues\?state=all/.test(args.find((arg) => arg.startsWith('repos/')) ?? '') ? '' : realGh(args, opts));
  let file = JSON.stringify({ ...SPEC, target: 'o/r', issue: { key: 'conduct demo abcd1234', title: 'asks' } });
  const d = deps(lagging, { readFile: () => file, writeFile: (path, text) => { file = text; } });
  const first = await main(['post', '--spec', 's.json'], d);
  const second = await main(['post', '--spec', 's.json'], d);
  assert.deepEqual([first.target, second.target, second.existing, fake.issues.length], ['o/r#40', 'o/r#40', true, 1]);
  assert.equal(JSON.parse(file).target, 'o/r#40');
});

test('post --spec: the asks issue is pinned before the comment, so a run whose reconciliation read fails is retried into the same issue: one issue, one ask', async () => {
  const fake = fakeGh();
  let lists = 0;
  // GitHub's issue list never shows the new issue, and run 1's second comment listing fails.
  const flaky = (args, opts) => {
    const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
    if (/issues\?state=all/.test(path)) return '';
    if (/\/comments\?/.test(path) && !args.includes('POST') && (lists += 1) === 2) throw Object.assign(new Error('read fail'), { stderr: 'read fail' });
    return fake.gh(args, opts);
  };
  let file = JSON.stringify({ ...SPEC, target: 'o/r', issue: { key: 'conduct demo abcd1234', title: 'asks' } });
  const d = deps(flaky, { readFile: () => file, writeFile: (path, text) => { file = text; } });
  const first = await main(['post', '--spec', 's.json'], d);
  assert.deepEqual([first.status, first.error, JSON.parse(file).target], ['error', 'read fail', 'o/r#40']);
  const second = await main(['post', '--spec', 's.json'], d);
  assert.deepEqual([second.status, second.target, second.existing], ['posted', 'o/r#40', true]);
  assert.equal(fake.issues.length, 1);
  assert.deepEqual(fake.comments.filter((c) => c.body.includes(`[ask ${ASK}]`)).map((c) => c.issue), [40]);
});

test('post: a concurrent poster deletes its own comment only when it sees a lower-id one; a higher-id match alone never deletes ours', async () => {
  // Our comment (1001) is not in the listing yet; a racer's later 1002 is.
  const fake = fakeGh([], {
    visible: (c) => c.id !== 1001,
    onPost: (comment, all) => { if (comment.id === 1001) all.push({ id: 1002, body: askBody(SPEC), created_at: '2026-10-19T15:02:00Z', login: OPERATOR, type: 'User', app: false, issue: 7 }); },
  });
  const result = await post(SPEC, deps(fake.gh));
  assert.deepEqual([result.existing, result.askCommentId], [false, 1001]);
  assert.equal(fake.deletes().length, 0);
});

test('post: a malformed spec is a usage error (exit 2) and posts nothing', async () => {
  const fake = fakeGh();
  const cases = [
    { ...SPEC, askReceiptId: 'abc' },
    { ...SPEC, target: 'o/r' },
    { ...SPEC, options: Array.from({ length: 7 }, (_, i) => ({ key: 'abcdefg'[i], label: 'x', consequence: 'y' })) },
    { ...SPEC, options: [OPTIONS[0], { ...OPTIONS[1], key: 'a' }] },
    { ...SPEC, options: [OPTIONS[0], { ...OPTIONS[1], key: 'g' }] },
    { ...SPEC, recommended: 'c' },
    { ...SPEC, allowFreeText: 'yes' },
    { ...SPEC, run: '' },
    { ...SPEC, questId: 'quest-1' },
    { ...SPEC, questId: 42 },
  ];
  for (const spec of cases) {
    const result = await main(['post', '--spec', 'x.json'], deps(fake.gh, { readFile: () => JSON.stringify(spec) }));
    assert.equal(result.status, 'usage', JSON.stringify(spec));
    assert.equal(EXIT[result.status], 2);
  }
  assert.equal(fake.posts().length, 0);
});

test('post mint: the ask comment is minted on the spec\'s quest with exactly one url evidence artifact', async (t) => {
  const obs = await fakeObservatory(t, () => [500, {}]);
  const result = await main(['post', '--spec', 's.json', '--observatory', obs.base], deps(fakeGh().gh, { readFile: () => JSON.stringify({ ...SPEC, askReceiptId: ASK.toUpperCase() }) }));
  assert.deepEqual([result.status, result.existing, result.linked], ['posted', false, true]);
  assert.equal(obs.links.length, 1);
  assert.equal(obs.links[0].url, `/api/spine/quests/${QUEST}/update`);
  assert.deepEqual(obs.links[0].body, { artifacts: [{ type: 'url', locator: 'https://github.com/o/r/issues/7#issuecomment-1001', label: `ask ${ASK}`, rel: 'evidence' }] });
  assert.deepEqual(askArtifact(ASK.toUpperCase(), result.askCommentUrl), obs.links[0].body.artifacts[0]);
  assert.equal(obs.seen.length, 0);
});

test('post mint: Observatory unreachable or refusing leaves the post posted (exit 0) with linked false', async (t) => {
  const down = await main(['post', '--spec', 's.json'], deps(fakeGh().gh, { readFile: () => JSON.stringify(SPEC) }));
  assert.deepEqual([down.status, EXIT[down.status], down.linked, down.linkError], ['posted', 0, false, 'ECONNREFUSED']);
  const obs = await fakeObservatory(t, () => [500, {}], { link: () => [404, { error: 'quest_not_found' }] });
  const refusing = await main(['post', '--spec', 's.json', '--observatory', obs.base], deps(fakeGh().gh, { readFile: () => JSON.stringify(SPEC) }));
  assert.deepEqual([refusing.status, EXIT[refusing.status], refusing.linked, refusing.linkError], ['posted', 0, false, 'http_404: quest_not_found']);
  const noBase = await post(SPEC, deps(fakeGh().gh));
  assert.deepEqual([noBase.status, noBase.linked, noBase.linkError], ['posted', false, 'no_observatory']);
});

test('post mint: a re-post mints the same (type, locator) again, so a missed mint is retried and a made one adds no row', async (t) => {
  const fake = fakeGh();
  let up = false;
  const obs = await fakeObservatory(t, () => [500, {}], { link: null });
  const d = deps(fake.gh, { readFile: () => JSON.stringify(SPEC), fetch: (url, init) => (up ? globalThis.fetch(url, init) : refused(`${NOWHERE}/`, init)) });
  const first = await main(['post', '--spec', 's.json', '--observatory', obs.base], d);
  assert.deepEqual([first.existing, first.linked], [false, false]);
  up = true;
  const second = await main(['post', '--spec', 's.json', '--observatory', obs.base], d);
  const third = await main(['post', '--spec', 's.json', '--observatory', obs.base], d);
  assert.deepEqual([second.existing, second.linked, third.existing, third.linked], [true, true, true, true]);
  assert.equal(fake.posts().length, 1);
  assert.equal(obs.links.length, 2);
  assert.deepEqual(obs.links[0].body, obs.links[1].body);
  assert.deepEqual([...obs.rows], [`url https://github.com/o/r/issues/7#issuecomment-1001 ${QUEST}`]);
});

test('post legacy: a pending spec written before questId posts (exit 0) with linked false and the warning; a spec with questId still links', async (t) => {
  const obs = await fakeObservatory(t, () => [500, {}]);
  const { questId, ...legacy } = SPEC;
  const fake = fakeGh();
  const d = deps(fake.gh, { readFile: () => JSON.stringify(legacy) });
  const result = await main(['post', '--spec', 's.json', '--observatory', obs.base], d);
  assert.deepEqual([result.status, EXIT[result.status], result.linked, result.linkError, result.warning], ['posted', 0, false, 'no_quest', 'no questId in spec; ask link not recorded']);
  assert.equal(fake.posts().length, 1);
  assert.equal(obs.links.length, 0);
  assert.ok(d.logs.includes('no questId in spec; ask link not recorded'));
  const linked = await main(['post', '--spec', 's.json', '--observatory', obs.base], deps(fakeGh().gh, { readFile: () => JSON.stringify({ ...legacy, questId }) }));
  assert.deepEqual([linked.status, linked.linked, obs.links.length], ['posted', true, 1]);
});

test('poll mint: an --ask-comment that 404s or is not this ask\'s mints nothing; this ask\'s comment mints once', async (t) => {
  const obs = await fakeObservatory(t, () => recorded());
  const missing = await poll(pollOpts(obs.base, { quest: QUEST, askComment: 'https://github.com/o/r/issues/7#issuecomment-999' }), deps(fakeGh([askComment()]).gh));
  assert.deepEqual([missing.status, missing.linked, missing.linkError, obs.links.length], ['error', false, 'ask_comment_unread', 0]);
  const other = await poll(pollOpts(obs.base, { quest: QUEST }), deps(fakeGh([askComment(500, askBody({ ...SPEC, askReceiptId: OTHER_ASK }))]).gh));
  assert.deepEqual([other.status, other.linked, other.linkError, obs.links.length], ['waiting', false, 'not_this_ask', 0]);
  const plain = await poll(pollOpts(obs.base, { quest: QUEST }), deps(fakeGh([askComment(500, 'just a comment')]).gh));
  assert.deepEqual([plain.linked, plain.linkError, obs.links.length], [false, 'not_this_ask', 0]);
  const real = await poll(pollOpts(obs.base, { quest: QUEST }), deps(fakeGh([askComment()]).gh));
  assert.deepEqual([real.status, real.linked], ['waiting', true]);
  assert.deepEqual(obs.links.map((l) => [l.url, l.body]), [[`/api/spine/quests/${QUEST}/update`, { artifacts: [askArtifact(ASK, askUrl)] }]]);
});

test('poll mint: with the spec\'s quest, poll mints the ask comment once before its pass, and a failed mint changes nothing else', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'b')]);
  const obs = await fakeObservatory(t, () => recorded());
  const result = await main(['poll', '--spec', 's.json', '--once', '--operator', OPERATOR, '--observatory', obs.base], deps(fake.gh, { readFile: () => JSON.stringify(SPEC) }));
  assert.deepEqual([result.status, result.linked], ['answered', true]);
  assert.deepEqual(obs.links.map((l) => [l.url, l.body]), [[`/api/spine/quests/${QUEST}/update`, { artifacts: [askArtifact(ASK, askUrl)] }]]);
  assert.equal(obs.seen.length, 1);

  const failing = await fakeObservatory(t, () => recorded(), { link: () => [500, { error: 'boom' }] });
  const still = await main(['poll', '--spec', 's.json', '--once', '--operator', OPERATOR, '--observatory', failing.base], deps(fakeGh([askComment(), reply(501, 'b')]).gh, { readFile: () => JSON.stringify(SPEC) }));
  assert.deepEqual([still.status, EXIT[still.status], still.linked, still.linkError], ['answered', 0, false, 'http_500: boom']);

  const noQuest = await poll(pollOpts(obs.base), deps(fakeGh([askComment()]).gh));
  assert.deepEqual([noQuest.status, 'linked' in noQuest, obs.links.length], ['waiting', false, 1]);
  await assert.rejects(poll(pollOpts(obs.base, { quest: 'nope' }), deps(fakeGh([askComment()]).gh)), /--quest is not a quest uuid/);
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
    reply(507, 'a', { login: null }),
  ]);
  const obs = await fakeObservatory(t, () => recorded());
  const result = await poll(pollOpts(obs.base), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.deepEqual(obs.seen.map((s) => s.body.commentUrl), ['https://github.com/o/r/issues/7#issuecomment-505']);
});

test('poll: the operator is the configured login, never the ask comment\'s author; none configured is no_operator', async (t) => {
  // The ask was posted by a bot account; the operator's reply is still the one submitted.
  const fake = fakeGh([askComment(500, askBody(SPEC)), reply(501, 'a', { login: 'workit-bot' }), reply(502, 'b')]);
  fake.comments[0].login = 'workit-bot';
  const obs = await fakeObservatory(t, () => recorded());
  const viaEnv = await poll(pollOpts(obs.base, { operator: undefined }), deps(fake.gh, { env: { OBSERVATORY_OPERATOR_GITHUB_LOGIN: 'SirMaelstrom' } }));
  assert.equal(viaEnv.status, 'answered');
  assert.deepEqual(obs.seen.map((s) => s.body.commentUrl), ['https://github.com/o/r/issues/7#issuecomment-502']);
  const none = await main(['poll', '--ask', ASK, '--ask-comment', askUrl, '--once', '--observatory', obs.base], deps(fake.gh));
  assert.equal(none.status, 'no_operator');
  assert.match(none.error, /set OBSERVATORY_OPERATOR_GITHUB_LOGIN/);
});

test('poll: a reply that is not a ruling gets one follow-up restating the grammar, and the next reply is recorded', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'b. sounds good'), reply(502, 'b')]);
  const obs = await fakeObservatory(t, (body) => (body.commentUrl.endsWith('-501')
    ? [422, { error: 'not_a_ruling', message: 'no' }]
    : recorded()));
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
  const fake = fakeGh([askComment(), reply(501, 'b: thinking about it')]);
  const obs = await fakeObservatory(t, () => [422, { error: 'not_a_ruling', message: 'no' }]);
  assert.equal((await poll(pollOpts(obs.base), deps(fake.gh))).status, 'waiting');
  assert.equal((await poll(pollOpts(obs.base), deps(fake.gh))).status, 'waiting');
  assert.equal(fake.posts().length, 1);
  assert.equal(obs.seen.length, 2);
});

test('poll: a follow-up whose post fails is posted on the next pass, once', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'b.')], { failPosts: 1 });
  let calls = 0;
  const obs = await fakeObservatory(t, () => {
    calls += 1;
    return calls < 3 ? [422, { error: 'not_a_ruling', message: 'no' }] : recorded();
  });
  // The operator's corrected reply arrives after the first pass.
  const d = deps(fake.gh, { sleep: async (ms) => { d.sleeps.push(ms); d.clock += ms; if (!fake.comments.some((c) => c.id === 502)) fake.comments.push(reply(502, 'b', { login: OPERATOR, type: 'User', app: false, issue: 7 })); } });
  const result = await poll(pollOpts(obs.base, { once: false, interval: 10 }), d);
  assert.equal(result.status, 'answered');
  assert.equal(fake.posts().length, 2, 'the failed post and its retry');
  assert.equal(fake.comments.filter((c) => c.body.includes('follow-up')).length, 1);
});

test('poll: a follow-up goes only to a reply bound to this ask that reads as an attempt; unrelated discussion and replies to another ask get none', async (t) => {
  const fake = fakeGh([
    askComment(),
    reply(501, 'Looks good, merging after CI'),
    reply(502, 'A lot of thought went into this'),
    reply(503, `Next question\n\n[ask ${OTHER_ASK}]`, { body: `<!-- other ask -->\nNext question\n\n[ask ${OTHER_ASK}]` }),
    reply(504, 'b.'),
    reply(505, `> [ask ${ASK}]\n(b)`),
  ]);
  const obs = await fakeObservatory(t, () => [422, { error: 'not_a_ruling', message: 'no' }]);
  assert.equal((await poll(pollOpts(obs.base), deps(fake.gh))).status, 'waiting');
  const replied = fake.posts().map((call) => /reply=(\d+)/.exec(JSON.parse(call.input).body)[1]);
  assert.deepEqual(replied, ['505']);
});

test('poll: under an ask posted as an app, a letter reply (400 no_ask_tag) and an attempt (422) each get a follow-up saying to quote the tag, and the quoted reply is recorded', async (t) => {
  const fake = fakeGh([
    { ...askComment(), login: 'workit-helper[bot]', type: 'Bot', app: true },
    reply(501, 'b.'),
    reply(502, 'b'),
  ]);
  const obs = await fakeObservatory(t, (body) => (body.commentUrl.endsWith('-501') ? [422, { error: 'not_a_ruling', message: 'no' }]
    : body.commentUrl.endsWith('-502') ? [400, { error: 'no_ask_tag', message: 'no operator ask comment comes before it' }]
      : recorded()));
  const d = deps(fake.gh);
  assert.equal((await poll(pollOpts(obs.base), d)).status, 'waiting');
  const followUps = fake.posts().map((call) => JSON.parse(call.input).body);
  assert.deepEqual(followUps.map((body) => /reply=(\d+)/.exec(body)[1]), ['501', '502']);
  for (const body of followUps) assert.ok(body.includes(`\`> [ask ${ASK}]\``), body);
  fake.comments.push(reply(503, `> [ask ${ASK}]\nb`, { login: OPERATOR, type: 'User', app: false, issue: 7 }));
  const result = await poll(pollOpts(obs.base), d);
  assert.equal(result.status, 'answered');
  assert.equal(result.commentUrl, 'https://github.com/o/r/issues/7#issuecomment-503');
});

test('poll: a 404 comment_not_found is retried on later passes, earliest reply first, and skipped after three', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'a')]);
  let calls = 0;
  const obs = await fakeObservatory(t, () => ((calls += 1) === 1 ? [404, { error: 'comment_not_found', message: 'not yet' }] : recorded('a')));
  const result = await poll(pollOpts(obs.base, { once: false, interval: 10 }), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.deepEqual(obs.seen.map((s) => s.body.commentUrl.slice(-3)), ['501', '501']);

  const gone = fakeGh([askComment(), reply(501, 'a'), reply(502, 'b')]);
  const obs2 = await fakeObservatory(t, (body) => (body.commentUrl.endsWith('-501') ? [404, { error: 'comment_not_found', message: 'gone' }] : recorded()));
  const after = await poll(pollOpts(obs2.base, { once: false, interval: 10 }), deps(gone.gh));
  assert.equal(after.status, 'answered');
  assert.deepEqual(obs2.seen.map((s) => s.body.commentUrl.slice(-3)), ['501', '501', '501', '502']);
});

test('cli: no operator login exits 8 naming the variable and where to set it; a malformed spec still exits 2 with its own message', () => {
  const env = { ...process.env, OBSERVATORY_OPERATOR_GITHUB_LOGIN: '' };
  const none = spawnSync(process.execPath, [SCRIPT, 'poll', '--ask', ASK, '--ask-comment', askUrl, '--once'], { encoding: 'utf8', env });
  assert.equal(none.status, 8, none.stdout);
  const printed = JSON.parse(none.stdout);
  assert.deepEqual([printed.status, printed.variable], ['no_operator', 'OBSERVATORY_OPERATOR_GITHUB_LOGIN']);
  assert.match(printed.error, /set OBSERVATORY_OPERATOR_GITHUB_LOGIN to the operator's GitHub login .* in the Claude Code settings\.json `env` block/);
  const dir = mkdtempSync(join(tmpdir(), 'github-ask-spec-'));
  try {
    const specPath = join(dir, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ ...SPEC, askReceiptId: 'not-a-uuid' }));
    for (const argv of [['post', '--spec', specPath], ['poll', '--spec', specPath, '--once']]) {
      const bad = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', env });
      assert.equal(bad.status, 2, `${argv[0]}: ${bad.stdout}`);
      assert.equal(JSON.parse(bad.stdout).status, 'usage');
      assert.doesNotMatch(JSON.parse(bad.stdout).error, /OBSERVATORY_OPERATOR_GITHUB_LOGIN/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('poll: 409 no_open_ask and stale_ask, 403 and 503 stop with their status; another 4xx is refused', async (t) => {
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

test('poll: a reply the route binds to another ask (409 ask_mismatch) is skipped, and a valid reply after it is recorded', async (t) => {
  const fake = fakeGh([askComment(), reply(501, 'a'), reply(502, 'b')]);
  const obs = await fakeObservatory(t, (body) => (body.commentUrl.endsWith('-501') ? [409, { error: 'ask_mismatch', message: 'another ask' }] : recorded()));
  const result = await poll(pollOpts(obs.base), deps(fake.gh));
  assert.equal(result.status, 'answered');
  assert.deepEqual(obs.seen.map((s) => s.body.commentUrl.slice(-3)), ['501', '502']);
  assert.equal(fake.posts().length, 0);
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

test('poll: the last sleep is cut to the deadline, and a reply there is still recorded', async (t) => {
  const d = deps(null);
  const fake = fakeGh([askComment(), reply(501, 'b')], { visible: (c) => c.id !== 501 || d.clock >= 1000000 });
  d.gh = fake.gh;
  const obs = await fakeObservatory(t, () => recorded());
  const result = await poll(pollOpts(obs.base, { once: false, interval: 600, timeout: 1000 }), d);
  assert.equal(result.status, 'answered');
  assert.deepEqual(d.sleeps, [600000, 400000]);
});

test('poll --spec: finds the ask comment post left on the target by its marker, and errors when there is none', async (t) => {
  const fake = fakeGh([reply(400, 'unrelated', { created_at: '2026-10-19T13:00:00Z' }), askComment(), reply(501, 'b')]);
  const obs = await fakeObservatory(t, () => recorded());
  const run = (gh) => main(['poll', '--spec', 's.json', '--once', '--operator', OPERATOR, '--observatory', obs.base], deps(gh, { readFile: () => JSON.stringify(SPEC) }));
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
