#!/usr/bin/env node
/**
 * github-ask.mjs — an unattended run's operator ask, as a GitHub comment
 * (quest 008747c2 step b). One implementation, used by conduct, burn-down and
 * pickup.
 *
 *   post — post the ask as an issue comment on the run's PR or issue. The
 *          comment carries the question, the options (recommendation first),
 *          the run's identity, the reply grammar and the ask's tag, which
 *          Observatory binds a reply to. Re-running it for the same ask finds
 *          the comment already posted and returns it instead of posting again.
 *   poll — find the operator's reply after the ask and record it through
 *          Observatory's `POST /api/spine/answers/github` route, which fetches
 *          the comment itself and writes the `answered` receipt
 *          (`by: 'operator:github'`). This script never sends the reply's text:
 *          the route takes only `{askReceiptId, commentUrl}`.
 *
 * Usage:
 *   node github-ask.mjs post --spec <file.json | ->
 *     spec: {"quest":"<uuid>","askReceiptId":"<needs_input receipt uuid>",
 *            "question":"…","options":[{"key":"a","label":"…","consequence":"…"},…],
 *            "target":"<owner/repo>#<pr or issue number>","run":"<who is asking>"}
 *     The first option is the recommendation, unless a label already ends "(recommended)".
 *   node github-ask.mjs poll (--spec <file.json> | --ask <askReceiptId> --ask-comment <ask comment URL>)
 *     [--operator <login>] [--interval <s>] [--timeout <s>] [--once] [--observatory <base URL>]
 *     With --spec, the ask comment is the one `post` left on the spec's target.
 *
 * Prints one JSON line on stdout; progress goes to stderr. `status` and the
 * exit code are what a caller branches on:
 *   0 posted (post) · answered (poll; `duplicate: true` when the route had it already)
 *   1 error: gh or the ask comment could not be read
 *   2 usage: bad arguments or spec
 *   3 conflict: 409 — the ask is answered, replaced (`stale_ask`) or not this reply's (`ask_mismatch`)
 *   4 not_operator: 403
 *   5 unconfigured: 503 — Observatory has no operator login or no GitHub token
 *   6 refused: any other 4xx from the route (the body's `error` is in `code`)
 *   7 waiting (--once) or timeout: no reply recorded yet; the ask stays open
 *
 * Which replies poll submits: issue comments after the ask, written by the
 * operator login (default: the ask comment's own author, since the run posts as
 * the operator), not by a GitHub App, carrying neither this script's marker nor
 * an unquoted ask tag (that is an ask, not a reply), earliest first. Another
 * author's comment is skipped here rather than sent, so a review bot's comment
 * on a PR cannot stop the poll with a 403.
 *
 * A reply the route reads as no ruling (422 `not_a_ruling`, 400 `unknown_option`,
 * `text_not_allowed`, `text_too_long`) leaves the ask open: poll posts one short
 * follow-up restating the grammar under that reply, unless one is already
 * there, and keeps polling. Observatory unreachable, 502 or another 5xx: the
 * reply is retried on the next pass with backoff (spec-lite D4, Spine down:
 * nothing is spooled; the comment on GitHub keeps the authority).
 *
 * Env: OBSERVATORY_BASE_URL (default http://127.0.0.1:3100).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GRAMMAR = 'Reply with the letter alone on the first line; put any notes on the lines below.';
export const DEFAULT_BASE = 'http://127.0.0.1:3100';
export const EXIT = { posted: 0, answered: 0, error: 1, usage: 2, conflict: 3, not_operator: 4, unconfigured: 5, refused: 6, waiting: 7, timeout: 7 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;
const COMMENT_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)$/;
const TAG_RE = /\[ask [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/i;
const QUOTED_RE = /^\s{0,3}>/;
// The route's codes for a reply that is not a usable ruling; the ask stays open.
const NOT_A_RULING = new Set(['not_a_ruling', 'unknown_option', 'text_not_allowed', 'text_too_long']);
const MAX_BACKOFF_S = 900;
const FETCH_TIMEOUT_MS = 10000;

const askMarker = (askReceiptId) => `<!-- workit:github-ask ask=${askReceiptId.toLowerCase()} -->`;
const followUpMarker = (askReceiptId, replyId) => `<!-- workit:github-ask follow-up ask=${askReceiptId.toLowerCase()} reply=${replyId} -->`;
const MARKER_RE = /<!-- workit:github-ask /;

class UsageError extends Error {}

/**
 * The ask comment's markdown. The tag sits alone on the last line, unquoted.
 * The first option is marked recommended, unless a label already says which
 * one is (conduct's showcase keeps a/b/c order and marks its pick's label).
 */
export function askBody(spec) {
  const marked = spec.options.some((option) => /\(recommended\)/i.test(option.label));
  const options = spec.options.map((option, i) => `- **${option.key}** — ${option.label}${i === 0 && !marked ? ' (Recommended)' : ''}: ${option.consequence}`);
  return [
    askMarker(spec.askReceiptId),
    `**Operator ask** from \`${spec.run}\` on quest \`${spec.quest}\``,
    '',
    spec.question,
    '',
    ...options,
    '',
    `${GRAMMAR} Anything else is not recorded.`,
    '',
    `[ask ${spec.askReceiptId.toLowerCase()}]`,
  ].join('\n');
}

export function followUpBody(askReceiptId, reply, code) {
  return [
    followUpMarker(askReceiptId, reply.id),
    `That reply was not recorded (\`${code}\`), so the ask is still open. ${GRAMMAR}`,
  ].join('\n');
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new UsageError('the spec is not a JSON object');
  for (const field of ['quest', 'askReceiptId', 'question', 'target', 'run']) {
    if (typeof spec[field] !== 'string' || spec[field].trim() === '') throw new UsageError(`spec.${field} is missing`);
  }
  if (!UUID_RE.test(spec.askReceiptId)) throw new UsageError('spec.askReceiptId is not a receipt uuid');
  if (!TARGET_RE.test(spec.target)) throw new UsageError('spec.target is not <owner/repo>#<number>');
  if (!Array.isArray(spec.options) || spec.options.length < 2 || spec.options.length > 6) throw new UsageError('spec.options needs 2 to 6 options');
  const keys = new Set();
  for (const option of spec.options) {
    if (!/^[a-f]$/.test(option?.key ?? '')) throw new UsageError(`option key ${JSON.stringify(option?.key)} is not one of a-f`);
    if (keys.has(option.key)) throw new UsageError(`option key ${option.key} is used twice`);
    keys.add(option.key);
    for (const field of ['label', 'consequence']) {
      if (typeof option[field] !== 'string' || option[field].trim() === '') throw new UsageError(`option ${option.key} has no ${field}`);
    }
  }
}

export function parseCommentUrl(url) {
  const m = COMMENT_URL_RE.exec(String(url ?? '').trim());
  return m ? { owner: m[1], repo: m[2], issue: Number(m[3]), commentId: Number(m[4]) } : null;
}

/** An unquoted ask tag: the comment is an ask (or a repost of one), never a reply. */
export function carriesUnquotedTag(body) {
  return String(body ?? '').split(/\r?\n/).some((line) => !QUOTED_RE.test(line) && TAG_RE.test(line));
}

function defaultGh(args, { input } = {}) {
  return execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

function listComments(deps, owner, repo, issue, since) {
  const path = `repos/${owner}/${repo}/issues/${issue}/comments?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  const jq = '.[] | {id, html_url, body, created_at, login: .user.login, type: .user.type, app: (.performed_via_github_app != null)}';
  const out = deps.gh(['api', '--paginate', path, '--jq', jq]);
  return out.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function postComment(deps, owner, repo, issue, body) {
  const out = deps.gh(['api', '--method', 'POST', `repos/${owner}/${repo}/issues/${issue}/comments`, '--input', '-'], { input: JSON.stringify({ body }) });
  const comment = JSON.parse(out);
  return { id: comment.id, url: comment.html_url };
}

export async function post(spec, deps) {
  validateSpec(spec);
  const [, owner, repo, issue] = TARGET_RE.exec(spec.target);
  const marker = askMarker(spec.askReceiptId);
  const existing = listComments(deps, owner, repo, issue).find((comment) => String(comment.body ?? '').includes(marker));
  if (existing) return { status: 'posted', existing: true, askReceiptId: spec.askReceiptId.toLowerCase(), target: spec.target, askCommentUrl: existing.html_url, askCommentId: existing.id };
  const posted = postComment(deps, owner, repo, issue, askBody(spec));
  return { status: 'posted', existing: false, askReceiptId: spec.askReceiptId.toLowerCase(), target: spec.target, askCommentUrl: posted.url, askCommentId: posted.id };
}

async function record(deps, base, askReceiptId, commentUrl) {
  try {
    const res = await deps.fetch(`${base.replace(/\/+$/, '')}/api/spine/answers/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ askReceiptId, commentUrl }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { http: res.status, body };
  } catch (err) {
    return { http: null, unreachable: err?.cause?.code ?? err?.name ?? 'fetch_failed' };
  }
}

// One pass over the thread. Returns a terminal result, or null to keep polling
// (with `retry: true` when a reply is waiting on an unreachable Observatory).
async function pass(opts, deps, state) {
  const { owner, repo, issue, commentId: askId } = state.ask;
  const comments = listComments(deps, owner, repo, issue, state.askCreatedAt);
  const followedUp = new Set(comments.flatMap((comment) => {
    const m = /<!-- workit:github-ask follow-up ask=([0-9a-f-]+) reply=(\d+) -->/.exec(String(comment.body ?? ''));
    return m && m[1] === opts.ask ? [Number(m[2])] : [];
  }));
  const candidates = comments
    .filter((comment) => comment.id > askId && !state.seen.has(comment.id))
    .filter((comment) => String(comment.login ?? '').toLowerCase() === state.operator.toLowerCase() && comment.type === 'User' && !comment.app)
    .filter((comment) => !MARKER_RE.test(String(comment.body ?? '')) && !carriesUnquotedTag(comment.body))
    .sort((x, y) => (x.created_at === y.created_at ? x.id - y.id : x.created_at < y.created_at ? -1 : 1));
  for (const reply of candidates) {
    const result = await record(deps, opts.observatory, opts.ask, reply.html_url);
    const base = { askReceiptId: opts.ask, commentUrl: reply.html_url };
    if (result.http === null || result.http >= 500 && result.http !== 503) {
      deps.log(`reply ${reply.html_url} not recorded yet: ${result.unreachable ?? `HTTP ${result.http} ${result.body?.error ?? ''}`}`);
      return { retry: true, pending: { ...base, reason: result.unreachable ?? result.body?.error ?? `http_${result.http}` } };
    }
    const code = result.body?.error ?? null;
    if (result.http === 200 || result.http === 201) {
      return { status: 'answered', ...base, receiptId: result.body?.receiptId ?? null, key: result.body?.key ?? null, label: result.body?.label ?? null, duplicate: result.body?.duplicate === true };
    }
    if (result.http === 409) return { status: 'conflict', code, message: result.body?.message ?? null, ...base };
    if (result.http === 403) return { status: 'not_operator', code, message: result.body?.message ?? null, ...base };
    if (result.http === 503) return { status: 'unconfigured', code, message: result.body?.message ?? null, ...base };
    state.seen.add(reply.id);
    if (NOT_A_RULING.has(code)) {
      deps.log(`reply ${reply.html_url} is not a ruling (${code}); the ask stays open`);
      if (!followedUp.has(reply.id)) postComment(deps, owner, repo, issue, followUpBody(opts.ask, reply, code));
      continue;
    }
    if (code === 'comment_not_found') continue;
    return { status: 'refused', code, http: result.http, message: result.body?.message ?? null, ...base };
  }
  return null;
}

// With only a target, the ask comment is the one `post` left there: found by its marker.
function findAskComment(deps, target, askReceiptId) {
  const m = TARGET_RE.exec(target ?? '');
  if (!m) throw new UsageError('the target is not <owner/repo>#<number>');
  const marker = askMarker(askReceiptId);
  return listComments(deps, m[1], m[2], m[3]).find((comment) => String(comment.body ?? '').includes(marker))?.html_url ?? null;
}

export async function poll(opts, deps) {
  if (!UUID_RE.test(opts.ask ?? '')) throw new UsageError('--ask is not a receipt uuid');
  if (!opts.askComment && opts.target) {
    let found;
    try {
      found = findAskComment(deps, opts.target, opts.ask);
    } catch (err) {
      if (err instanceof UsageError) throw err;
      return { status: 'error', error: `the thread could not be read: ${String(err?.stderr || err?.message || err).trim().slice(0, 300)}` };
    }
    if (!found) return { status: 'error', error: `no ask comment for ${opts.ask} on ${opts.target}; run post first` };
    opts = { ...opts, askComment: found };
  }
  const ask = parseCommentUrl(opts.askComment);
  if (!ask) throw new UsageError('--ask-comment is not an issue comment URL (…/issues|pull/<n>#issuecomment-<id>)');
  opts = { ...opts, ask: opts.ask.toLowerCase() };
  let askComment;
  try {
    askComment = JSON.parse(deps.gh(['api', `repos/${ask.owner}/${ask.repo}/issues/comments/${ask.commentId}`]));
  } catch (err) {
    return { status: 'error', error: `the ask comment could not be read: ${String(err?.stderr || err?.message || err).trim().slice(0, 300)}` };
  }
  const state = { ask, askCreatedAt: askComment.created_at, operator: opts.operator || askComment.user?.login, seen: new Set() };
  const deadline = deps.now() + opts.timeout * 1000;
  let failures = 0;
  for (;;) {
    let outcome;
    try {
      outcome = await pass(opts, deps, state);
    } catch (err) {
      outcome = { retry: true, ghError: String(err?.stderr || err?.message || err).trim().slice(0, 300) };
      deps.log(`gh failed: ${outcome.ghError}`);
    }
    if (outcome?.status) return outcome;
    failures = outcome?.retry ? failures + 1 : 0;
    if (opts.once) {
      if (outcome?.ghError) return { status: 'error', error: outcome.ghError };
      return { status: 'waiting', askReceiptId: opts.ask, ...(outcome?.pending ? { pending: outcome.pending } : {}) };
    }
    const waitS = Math.min(opts.interval * 2 ** Math.min(failures, 10), Math.max(MAX_BACKOFF_S, opts.interval));
    if (deps.now() + waitS * 1000 > deadline) {
      return { status: 'timeout', askReceiptId: opts.ask, ...(outcome?.pending ? { pending: outcome.pending } : {}) };
    }
    await deps.sleep(waitS * 1000);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'once') { flags.once = true; continue; }
    if (i + 1 >= rest.length) throw new UsageError(`${arg} needs a value`);
    flags[name] = rest[(i += 1)];
  }
  return { command, flags };
}

function seconds(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number of seconds`);
  return n;
}

export async function main(argv, deps) {
  try {
    const { command, flags } = parseArgs(argv);
    if (command === 'post') {
      if (!flags.spec) throw new UsageError('post needs --spec <file.json | ->');
      let spec;
      try {
        spec = JSON.parse(deps.readFile(flags.spec));
      } catch (err) {
        throw new UsageError(`the spec could not be read: ${err.message}`);
      }
      return await post(spec, deps);
    }
    if (command === 'poll') {
      let spec = {};
      if (flags.spec) {
        try {
          spec = JSON.parse(deps.readFile(flags.spec));
        } catch (err) {
          throw new UsageError(`the spec could not be read: ${err.message}`);
        }
      }
      return await poll({
        ask: flags.ask ?? spec.askReceiptId,
        askComment: flags['ask-comment'],
        target: spec.target,
        operator: flags.operator,
        once: flags.once === true,
        interval: seconds(flags.interval, 60, 'interval'),
        timeout: seconds(flags.timeout, 24 * 3600, 'timeout'),
        observatory: flags.observatory || deps.env.OBSERVATORY_BASE_URL || DEFAULT_BASE,
      }, deps);
    }
    throw new UsageError('usage: github-ask.mjs post --spec <file> | poll (--spec <file> | --ask <uuid> --ask-comment <url>) [--once]');
  } catch (err) {
    if (err instanceof UsageError) return { status: 'usage', error: err.message };
    return { status: 'error', error: String(err?.stderr || err?.message || err).trim().slice(0, 300) };
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const deps = {
    gh: defaultGh,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => process.stderr.write(`[github-ask] ${line}\n`),
    readFile: (path) => readFileSync(path === '-' ? 0 : path, 'utf8'),
    env: process.env,
  };
  const result = await main(process.argv.slice(2), deps);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = EXIT[result.status] ?? 1;
}
