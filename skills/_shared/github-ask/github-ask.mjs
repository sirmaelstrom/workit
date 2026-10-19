#!/usr/bin/env node
/**
 * github-ask.mjs — an unattended run's operator ask, as a GitHub comment. One
 * implementation, used by conduct, burn-down and pickup.
 *
 *   post — post the ask as an issue comment on the run's PR or issue. The
 *          comment carries the question, the options, the run's identity, the
 *          reply grammar and the ask's tag, which Observatory binds a reply to.
 *          Re-running it for the same ask finds the comment already posted and
 *          returns it instead of posting again. Either way it then mints the
 *          comment's URL on the ask's quest (`type: 'url'`, `rel: 'evidence'`,
 *          label `ask <askReceiptId>`) through Observatory's
 *          `POST /api/spine/quests/:id/update`, which is what the Dogan's
 *          read-only Asks list links to. The mint is idempotent per (type,
 *          locator), so post and poll both run it; when Observatory is down
 *          the post still succeeds with `linked: false`, and the next post or
 *          poll mints it again. A spec with no questId (one written before the
 *          field existed) posts too, with `linked: false`, `linkError:
 *          'no_quest'` and a warning.
 *   poll —find the operator's reply after the ask and record it through
 *          Observatory's `POST /api/spine/answers/github` route, which fetches
 *          the comment itself and writes the `answered` receipt
 *          (`by: 'operator:github'`), the notes below the letter as its text.
 *          This script sends the route `{askReceiptId, commentUrl}` and
 *          nothing else.
 *
 * Usage:
 *   node github-ask.mjs post --spec <file.json | -> [--observatory <base URL>]
 *     spec: {"askReceiptId":"<needs_input receipt uuid>","questId":"<the quest the receipt is filed on>","question":"…",
 *            "options":[{"key":"a","label":"…","consequence":"…"},…],
 *            "allowFreeText":<bool, as filed; default false>,"recommended":"<key, optional>",
 *            "target":"<owner/repo>#<pr or issue number>" | "<owner/repo>",
 *            "issue":{"key":"…","title":"…"} (with an <owner/repo> target),
 *            "run":"<who is asking>"}
 *     Options and allowFreeText are the ones the needs_input was filed with:
 *     1 to 6 options, keys a-f. A question with no choices is filed and posted
 *     as one option, (a), with allowFreeText true; the operator replies `a`
 *     and puts the answer on the lines below. An ask with no options is a
 *     usage error, because the route records a key.
 *     Only the `recommended` key is marked "(Recommended)", unless its label
 *     already says so; no option is marked by its position.
 *     An <owner/repo> target is the run's asks issue on that repo: the issue
 *     whose body carries the spec's issue key, opened the first time. post
 *     writes the issue's number into the spec file's target before it posts
 *     the comment, because GitHub's issue list trails a new issue by seconds:
 *     a re-run after any later failure goes to that issue and finds the
 *     comment there by its tag. With `--spec -` there is no file to pin, so
 *     a re-run may open a second issue.
 *   node github-ask.mjs poll (--spec <file.json> | --ask <askReceiptId> --ask-comment <ask comment URL>)
 *     [--quest <questId>] [--operator <login>] [--interval <s>] [--timeout <s>] [--once] [--observatory <base URL>]
 *     With --spec, the ask comment is the one `post` left on the spec's target.
 *     With a quest (the spec's questId, or --quest), poll mints the ask
 *     comment's URL on it once before its first pass, as post does, after it
 *     has read the comment and found this ask's marker or tag on it. A
 *     comment it cannot read or that is not this ask's mints nothing
 *     (`linkError` `ask_comment_unread` or `not_this_ask`).
 *
 * Prints one JSON line on stdout; progress goes to stderr. `status` and the
 * exit code are what a caller branches on. `linked` (and `linkError` when it
 * is false) reports the quest mint and changes neither:
 *   0 posted (post) · answered (poll; `duplicate: true` when the route had it already)
 *   1 error: gh or the ask comment could not be read
 *   2 usage: bad arguments or spec
 *   3 conflict: 409 `no_open_ask` or `stale_ask`, the ask itself is closed or replaced
 *   4 not_operator: 403
 *   5 unconfigured: 503, Observatory has no operator login or no GitHub token
 *   6 refused: any other 4xx from the route (the body's `error` is in `code`)
 *   7 waiting (--once) or timeout: no reply recorded yet; the ask stays open
 *   8 no_operator: poll has no operator login (--operator, or
 *     OBSERVATORY_OPERATOR_GITHUB_LOGIN in the Claude Code settings.json `env`
 *     block); `variable` names it. Configuration, not a bad spec: hand back.
 *
 * Who counts as the operator. poll submits comments by the configured
 * operator login (--operator, else OBSERVATORY_OPERATOR_GITHUB_LOGIN, the
 * variable Observatory checks), not by a GitHub App, carrying neither this
 * script's marker nor an unquoted ask tag, after the ask, earliest first. The
 * filter is a convenience: it keeps a review bot's comment from stopping the
 * poll with a 403. The authority is Observatory's own check of the login on
 * the comment it fetches. A run holding the operator's gh token can also post
 * as the operator, and neither this script nor the route can tell that comment
 * from the operator's: it is detected (it is in the repo), not prevented. That
 * is the accepted residual (spec-lite D1), and the skills forbid it.
 *
 * Replies the route turns down. A 409 `ask_mismatch` (the reply answers
 * another ask) or another per-reply 409 skips that comment and polling goes
 * on. A reply the route reads as no ruling (422 `not_a_ruling`, 400
 * `unknown_option`, `text_not_allowed`, `text_too_long`) leaves the ask open:
 * when the reply is bound to this ask (it quotes the tag, or this ask is the
 * last one before it in the thread) and reads as an attempt at it, poll posts
 * one short follow-up restating the grammar under it, unless one is already
 * there. The route binds by thread only to an ask comment posted as the
 * operator. When the ask was posted as another account or an app, a letter
 * reply under it is 400 `no_ask_tag`: poll skips it and its follow-up says to
 * quote the ask's tag line. A 404 `comment_not_found` is retried on the next
 * pass, up to three, before the reply is skipped. Observatory unreachable,
 * 502 or another 5xx: the reply is retried on the next pass with backoff
 * (spec-lite D4, Spine down: nothing is spooled; the comment on GitHub keeps
 * the authority).
 *
 * Races. Two posts of one ask at once can both create a comment: each re-reads
 * the thread after posting, and a poster deletes its own comment only when it
 * sees a lower-id comment for the same ask, so the lowest one stays. Opening
 * the asks issue has no such check, so one run posts its asks from one process
 * at a time (conduct's actions run one at a time).
 *
 * Asks issues are not closed here. A run can post another ask after any
 * answer (conduct's build halts, showcase and release touches come later), so
 * no answer is known to be the issue's last, and the issue is the run's
 * record of its asks. With the target pinned in the spec, the issue-list scan
 * runs only at a run's first post.
 *
 * Env: OBSERVATORY_BASE_URL (default http://127.0.0.1:3100),
 * OBSERVATORY_OPERATOR_GITHUB_LOGIN (poll's operator login).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GRAMMAR = 'Reply with the letter alone on the first line; put any notes on the lines below.';
export const DEFAULT_BASE = 'http://127.0.0.1:3100';
export const OPERATOR_ENV = 'OBSERVATORY_OPERATOR_GITHUB_LOGIN';
export const EXIT = { posted: 0, answered: 0, error: 1, usage: 2, conflict: 3, not_operator: 4, unconfigured: 5, refused: 6, waiting: 7, timeout: 7, no_operator: 8 };
// Where the operator login is configured for Claude sessions.
export const OPERATOR_HOME = 'the Claude Code settings.json `env` block';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A quest uuid or an 8+ char short-id prefix: the shape Observatory resolves.
const QUEST_RE = /^[0-9a-f]{8}[0-9a-f-]*$/i;
const TARGET_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;
const REPO_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const COMMENT_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)$/;
const TAG_RE = /\[ask ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;
const QUOTED_RE = /^\s{0,3}>/;
// A first line that reads as an attempt at a key: `b.`, `(b)`, `a - notes`, `b: go`, `a-ok`.
const ATTEMPT_RE = /^[([]?([a-f])(?:[)\].:,;!?\-–—]|\s+[-–—:]|\s*$)/i;
// The route's codes for a reply that is not a usable ruling; the ask stays open.
const NOT_A_RULING = new Set(['not_a_ruling', 'unknown_option', 'text_not_allowed', 'text_too_long']);
// The 409s that close the ask itself; any other 409 is about that one reply.
const ASK_CLOSED = new Set(['no_open_ask', 'stale_ask']);
// A reply GitHub could not find yet is retried this many passes before it is skipped.
const NOT_FOUND_PASSES = 3;
const MAX_BACKOFF_S = 900;
const FETCH_TIMEOUT_MS = 10000;
const NO_QUEST_WARNING = 'no questId in spec; ask link not recorded';

const askMarker = (askReceiptId) => `<!-- workit:github-ask ask=${askReceiptId.toLowerCase()} -->`;
const followUpMarker = (askReceiptId, replyId) => `<!-- workit:github-ask follow-up ask=${askReceiptId.toLowerCase()} reply=${replyId} -->`;
const issueMarker = (key) => `<!-- workit:github-ask issue=${key} -->`;
const MARKER_RE = /<!-- workit:github-ask /;
const ASK_MARKER_RE = /<!-- workit:github-ask ask=/;

class UsageError extends Error {}
// Missing configuration: its own status, so a caller hands back instead of going on.
class ConfigError extends Error {}

// What the reply grammar means for this ask's shape, after GRAMMAR.
function shapeLine(spec) {
  if (spec.options.length === 1) {
    return spec.allowFreeText === true
      ? `This ask has one option: reply with \`${spec.options[0].key}\` on the first line, then your answer on the lines below.`
      : `This ask has one option: reply with \`${spec.options[0].key}\` alone.`;
  }
  return spec.allowFreeText === true
    ? 'The lines below the letter are recorded as your answer\'s text: where an option asks you to type something, such as an amount, put it there.'
    : 'This ask takes the letter alone: notes below it are refused.';
}

/** The ask comment's markdown. The tag sits alone on the last line, unquoted. */
export function askBody(spec) {
  const options = spec.options.map((option) => {
    const mark = option.key === spec.recommended && !/\(recommended\)/i.test(option.label) ? ' (Recommended)' : '';
    return `- **${option.key}** — ${option.label}${mark}: ${option.consequence}`;
  });
  return [
    askMarker(spec.askReceiptId),
    `**Operator ask** from \`${spec.run}\``,
    '',
    spec.question,
    '',
    ...options,
    '',
    `${GRAMMAR} ${shapeLine(spec)} Anything else is not recorded.`,
    '',
    `[ask ${spec.askReceiptId.toLowerCase()}]`,
  ].join('\n');
}

export function followUpBody(askReceiptId, reply, code, { quote = false } = {}) {
  const lines = [
    followUpMarker(askReceiptId, reply.id),
    `That reply was not recorded (\`${code}\`), so the ask is still open. ${GRAMMAR}`,
  ];
  // The route binds by thread only to an ask the operator posted; any other ask is bound by its quoted tag.
  if (quote) lines.push(`This ask was not posted from the operator's account, so put its tag, quoted, above the letter: \`> [ask ${askReceiptId.toLowerCase()}]\`.`);
  return lines.join('\n');
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new UsageError('the spec is not a JSON object');
  for (const field of ['askReceiptId', 'question', 'target', 'run']) {
    if (typeof spec[field] !== 'string' || spec[field].trim() === '') throw new UsageError(`spec.${field} is missing`);
  }
  if (!UUID_RE.test(spec.askReceiptId)) throw new UsageError('spec.askReceiptId is not a receipt uuid');
  // A spec written before questId existed still posts; it is just not linked.
  if (spec.questId !== undefined && (typeof spec.questId !== 'string' || !QUEST_RE.test(spec.questId))) {
    throw new UsageError('spec.questId is not a quest uuid or an 8+ char short id');
  }
  if (!TARGET_RE.test(spec.target) && !REPO_RE.test(spec.target)) throw new UsageError('spec.target is not <owner/repo>#<number> or <owner/repo>');
  if (REPO_RE.test(spec.target) && (typeof spec.issue?.key !== 'string' || !spec.issue.key.trim() || typeof spec.issue?.title !== 'string' || !spec.issue.title.trim())) {
    throw new UsageError('an <owner/repo> target needs spec.issue {key, title}: the run\'s asks issue');
  }
  if (spec.allowFreeText !== undefined && typeof spec.allowFreeText !== 'boolean') throw new UsageError('spec.allowFreeText is not a boolean');
  if (Array.isArray(spec.options) && spec.options.length === 0) {
    throw new UsageError('spec.options is empty: the route records a key, so file and post a free-text question as one option, (a), with allowFreeText true');
  }
  if (!Array.isArray(spec.options) || spec.options.length > 6) throw new UsageError('spec.options needs 1 to 6 options');
  const keys = new Set();
  for (const option of spec.options) {
    if (!/^[a-f]$/.test(option?.key ?? '')) throw new UsageError(`option key ${JSON.stringify(option?.key)} is not one of a-f`);
    if (keys.has(option.key)) throw new UsageError(`option key ${option.key} is used twice`);
    keys.add(option.key);
    for (const field of ['label', 'consequence']) {
      if (typeof option[field] !== 'string' || option[field].trim() === '') throw new UsageError(`option ${option.key} has no ${field}`);
    }
  }
  if (spec.recommended !== undefined && !keys.has(spec.recommended)) throw new UsageError(`spec.recommended ${JSON.stringify(spec.recommended)} is not one of the option keys`);
}

export function parseCommentUrl(url) {
  const m = COMMENT_URL_RE.exec(String(url ?? '').trim());
  return m ? { owner: m[1], repo: m[2], issue: Number(m[3]), commentId: Number(m[4]) } : null;
}

const unquotedLines = (body) => String(body ?? '').split(/\r?\n/).filter((line) => !QUOTED_RE.test(line));

/** An unquoted ask tag: the comment is an ask (or a repost of one), not a reply. */
export function carriesUnquotedTag(body) {
  return unquotedLines(body).some((line) => TAG_RE.test(line));
}

function defaultGh(args, { input } = {}) {
  return execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

const jsonLines = (out) => out.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

function listComments(deps, owner, repo, issue, since) {
  const path = `repos/${owner}/${repo}/issues/${issue}/comments?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  const jq = '.[] | {id, html_url, body, created_at, login: .user.login, type: .user.type, app: (.performed_via_github_app != null)}';
  return jsonLines(deps.gh(['api', '--paginate', path, '--jq', jq]));
}

function postComment(deps, owner, repo, issue, body) {
  const out = deps.gh(['api', '--method', 'POST', `repos/${owner}/${repo}/issues/${issue}/comments`, '--input', '-'], { input: JSON.stringify({ body }) });
  const comment = JSON.parse(out);
  return { id: comment.id, url: comment.html_url };
}

// The spec's target as {owner, repo, issue}: a numbered target as it is, a
// repo target as its asks issue, found by the issue key's marker (the lowest
// number when several carry it) and opened when `create` and none does.
function resolveTarget(deps, target, issueSpec, { create }) {
  const numbered = TARGET_RE.exec(target ?? '');
  if (numbered) return { owner: numbered[1], repo: numbered[2], issue: numbered[3] };
  const repoOnly = REPO_RE.exec(target ?? '');
  if (!repoOnly || !issueSpec?.key) throw new UsageError('the target is not <owner/repo>#<number>, or <owner/repo> with an issue key');
  const [, owner, repo] = repoOnly;
  const marker = issueMarker(issueSpec.key);
  const jq = '.[] | select(.pull_request == null) | {number, body}';
  const found = jsonLines(deps.gh(['api', '--paginate', `repos/${owner}/${repo}/issues?state=all&per_page=100`, '--jq', jq]))
    .filter((issue) => String(issue.body ?? '').includes(marker))
    .sort((x, y) => x.number - y.number)[0];
  if (found) return { owner, repo, issue: String(found.number) };
  if (!create) return null;
  const body = `${marker}\nOperator asks from this run are posted here as comments. Reply under an ask with its letter alone on the first line.`;
  const opened = JSON.parse(deps.gh(['api', '--method', 'POST', `repos/${owner}/${repo}/issues`, '--input', '-'], { input: JSON.stringify({ title: issueSpec.title, body }) }));
  return { owner, repo, issue: String(opened.number) };
}

// An ask comment for this ask: one carrying its marker, or its tag unquoted
// (the tag line every ask comment ends with).
function asksFor(comment, askReceiptId) {
  const body = String(comment.body ?? '');
  const id = askReceiptId.toLowerCase();
  return body.includes(askMarker(askReceiptId)) || unquotedLines(body).some((line) => TAG_RE.exec(line)?.[1].toLowerCase() === id);
}

/**
 * Posts the ask, once, then mints its comment on the quest. `pin(target)` runs
 * when the target resolves to an asks issue, before anything is posted there,
 * so a re-run after a later failure goes to that issue and finds the comment
 * instead of opening another. Without `observatory` nothing is minted.
 */
export async function post(spec, deps, { pin = null, observatory = null } = {}) {
  validateSpec(spec);
  const where = resolveTarget(deps, spec.target, spec.issue, { create: true });
  const target = `${where.owner}/${where.repo}#${where.issue}`;
  if (target !== spec.target && pin) pin(target);
  const result = async (comment, existing) => {
    const out = { status: 'posted', existing, askReceiptId: spec.askReceiptId.toLowerCase(), target, askCommentUrl: comment.html_url ?? comment.url, askCommentId: comment.id };
    return { ...out, ...(await link(deps, observatory, spec.questId, out.askReceiptId, out.askCommentUrl)) };
  };
  const carrying = () => listComments(deps, where.owner, where.repo, where.issue)
    .filter((comment) => asksFor(comment, spec.askReceiptId)).sort((x, y) => x.id - y.id);
  const existing = carrying()[0];
  if (existing) return result(existing, true);
  const posted = postComment(deps, where.owner, where.repo, where.issue, askBody(spec));
  // A concurrent post of the same ask: a poster deletes its own comment only
  // when a lower-id one is visible, so the lowest stays whatever each one sees.
  const lower = carrying().find((comment) => comment.id < posted.id);
  if (lower) {
    deps.gh(['api', '--method', 'DELETE', `repos/${where.owner}/${where.repo}/issues/comments/${posted.id}`]);
    return result(lower, true);
  }
  return result(posted, false);
}

async function sendJson(deps, url, payload) {
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { http: res.status, body };
  } catch (err) {
    return { http: null, unreachable: err?.cause?.code ?? err?.name ?? 'fetch_failed' };
  }
}

const record = (deps, base, askReceiptId, commentUrl) => sendJson(deps, `${base.replace(/\/+$/, '')}/api/spine/answers/github`, { askReceiptId, commentUrl });

/** The ask comment as a provenance pointer on its quest: what the Dogan's Asks list links to. */
export function askArtifact(askReceiptId, askCommentUrl) {
  return { type: 'url', locator: askCommentUrl, label: `ask ${askReceiptId.toLowerCase()}`, rel: 'evidence' };
}

// Mints the ask comment on its quest. A failure is reported, not thrown: the
// ask is on GitHub either way, and the next post or poll mints it again.
async function link(deps, base, questId, askReceiptId, askCommentUrl) {
  if (!questId) {
    deps.log?.(NO_QUEST_WARNING);
    return { linked: false, linkError: 'no_quest', warning: NO_QUEST_WARNING };
  }
  if (!base) return { linked: false, linkError: 'no_observatory' };
  const result = await sendJson(deps, `${base.replace(/\/+$/, '')}/api/spine/quests/${encodeURIComponent(questId)}/update`, { artifacts: [askArtifact(askReceiptId, askCommentUrl)] });
  if (result.http === 200) return { linked: true };
  const why = result.unreachable ?? `http_${result.http}${result.body?.error ? `: ${String(result.body.error).slice(0, 200)}` : ''}`;
  deps.log?.(`ask comment not minted on quest ${questId}: ${why}`);
  return { linked: false, linkError: why };
}

// A reply is bound to this ask when it quotes the ask's tag, or when the last
// ask comment before it is this ask's: an operator comment carrying an
// unquoted tag (the route's thread binding), or one this script posted under
// another account. Only a bound reply that reads as an attempt at an answer
// gets a follow-up: a 400 from the grammar's later checks always does, a 422
// only when its first line looks like a key. The follow-up says to quote the
// tag when the ask it follows is not the operator's, because the route binds
// by thread only to the operator's. Returns false or the follow-up's options.
function wantsFollowUp(reply, code, comments, opts, isOperator) {
  const quoted = String(reply.body ?? '').split(/\r?\n/).some((line) => QUOTED_RE.test(line) && TAG_RE.exec(line)?.[1].toLowerCase() === opts.ask);
  const isAsk = (comment) => carriesUnquotedTag(comment.body) && (isOperator(comment) || ASK_MARKER_RE.test(String(comment.body ?? '')));
  const lastAsk = comments.filter((comment) => comment.id < reply.id && isAsk(comment)).sort((x, y) => x.id - y.id).at(-1);
  const threaded = lastAsk ? unquotedLines(lastAsk.body).map((line) => TAG_RE.exec(line)?.[1]).find(Boolean)?.toLowerCase() === opts.ask : false;
  if (!quoted && !threaded) return false;
  const follow = { quote: !quoted && !isOperator(lastAsk) };
  if (code !== 'not_a_ruling') return follow;
  const first = unquotedLines(reply.body).map((line) => line.trim()).find((line) => line !== '') ?? '';
  return ATTEMPT_RE.test(first) ? follow : false;
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
  const isOperator = (comment) => String(comment.login ?? '').toLowerCase() === state.operator && comment.type === 'User' && !comment.app;
  const candidates = comments
    .filter((comment) => comment.id > askId && !state.seen.has(comment.id) && isOperator(comment))
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
    if (result.http === 409 && ASK_CLOSED.has(code)) return { status: 'conflict', code, message: result.body?.message ?? null, ...base };
    if (result.http === 403) return { status: 'not_operator', code, message: result.body?.message ?? null, ...base };
    if (result.http === 503) return { status: 'unconfigured', code, message: result.body?.message ?? null, ...base };
    if (code === 'comment_not_found') {
      // GitHub can trail a new comment: retried, earliest reply first, before it is given up.
      const misses = (state.notFound.get(reply.id) ?? 0) + 1;
      state.notFound.set(reply.id, misses);
      if (misses < NOT_FOUND_PASSES) {
        deps.log(`reply ${reply.html_url} not found yet (${misses}/${NOT_FOUND_PASSES}); retried on the next pass`);
        return { retry: true, pending: { ...base, reason: code } };
      }
      deps.log(`reply ${reply.html_url} skipped: not found on ${misses} passes`);
      state.seen.add(reply.id);
      continue;
    }
    if (result.http === 409) {
      deps.log(`reply ${reply.html_url} skipped (${code}): it is not a reply to this ask`);
      state.seen.add(reply.id);
      continue;
    }
    if (NOT_A_RULING.has(code) || code === 'no_ask_tag') {
      deps.log(`reply ${reply.html_url} is not a ruling for this ask (${code}); the ask stays open`);
      // Marked seen only once its follow-up is posted: a failed post throws, and the next pass tries again.
      const follow = followedUp.has(reply.id) ? false : wantsFollowUp(reply, code, comments, opts, isOperator);
      if (follow) postComment(deps, owner, repo, issue, followUpBody(opts.ask, reply, code, follow));
      state.seen.add(reply.id);
      continue;
    }
    return { status: 'refused', code, http: result.http, message: result.body?.message ?? null, ...base };
  }
  return null;
}

// With only a target, the ask comment is the one `post` left there: found by its marker.
function findAskComment(deps, target, issueSpec, askReceiptId) {
  const where = resolveTarget(deps, target, issueSpec, { create: false });
  if (!where) return null;
  const marker = askMarker(askReceiptId);
  return listComments(deps, where.owner, where.repo, where.issue).filter((comment) => String(comment.body ?? '').includes(marker))
    .sort((x, y) => x.id - y.id)[0]?.html_url ?? null;
}

export async function poll(opts, deps) {
  if (!UUID_RE.test(opts.ask ?? '')) throw new UsageError('--ask is not a receipt uuid');
  if (opts.quest !== undefined && !QUEST_RE.test(opts.quest)) throw new UsageError('--quest is not a quest uuid or an 8+ char short id');
  const operator = String(opts.operator || deps.env?.[OPERATOR_ENV] || '').trim().toLowerCase();
  if (!operator) throw new ConfigError(`no operator login: set ${OPERATOR_ENV} to the operator's GitHub login (the login Observatory checks) in ${OPERATOR_HOME}, or pass --operator <login>`);
  if (!opts.askComment && opts.target) {
    let found;
    try {
      found = findAskComment(deps, opts.target, opts.issue, opts.ask);
    } catch (err) {
      if (err instanceof UsageError || err instanceof ConfigError) throw err;
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
    return { status: 'error', error: `the ask comment could not be read: ${String(err?.stderr || err?.message || err).trim().slice(0, 300)}`, ...(opts.quest ? { linked: false, linkError: 'ask_comment_unread' } : {}) };
  }
  // The mint post may have missed, once per poll: a mint already made is a no-op.
  // Minted only once the comment is read and is this ask's, so a stale or
  // mistyped --ask-comment leaves no pointer on the quest.
  let linked = {};
  if (opts.quest) {
    linked = asksFor(askComment, opts.ask)
      ? await link(deps, opts.observatory, opts.quest, opts.ask, askComment.html_url ?? opts.askComment)
      : { linked: false, linkError: 'not_this_ask' };
  }
  const state = { ask, askCreatedAt: askComment.created_at, operator, seen: new Set(), notFound: new Map() };
  return { ...(await watch(opts, deps, state)), ...linked };
}

async function watch(opts, deps, state) {
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
    const left = deadline - deps.now();
    if (left <= 0) return { status: 'timeout', askReceiptId: opts.ask, ...(outcome?.pending ? { pending: outcome.pending } : {}) };
    // The last sleep is cut to the deadline, so one more pass runs at it.
    const waitS = Math.min(opts.interval * 2 ** Math.min(failures, 10), Math.max(MAX_BACKOFF_S, opts.interval));
    await deps.sleep(Math.min(waitS * 1000, left));
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
      // GitHub's issue list trails a new issue by seconds, so a re-run could not find it there:
      // the spec file keeps the issue's number from before the comment is posted.
      const pin = flags.spec === '-' ? null : (target) => deps.writeFile(flags.spec, `${JSON.stringify({ ...spec, target }, null, 2)}\n`);
      return await post(spec, deps, { pin, observatory: flags.observatory || deps.env.OBSERVATORY_BASE_URL || DEFAULT_BASE });
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
        quest: flags.quest ?? spec.questId,
        askComment: flags['ask-comment'],
        target: spec.target,
        issue: spec.issue,
        operator: flags.operator,
        once: flags.once === true,
        interval: seconds(flags.interval, 60, 'interval'),
        timeout: seconds(flags.timeout, 24 * 3600, 'timeout'),
        observatory: flags.observatory || deps.env.OBSERVATORY_BASE_URL || DEFAULT_BASE,
      }, deps);
    }
    throw new UsageError('usage: github-ask.mjs post --spec <file> [--observatory <url>] | poll (--spec <file> | --ask <uuid> --ask-comment <url>) [--quest <id>] [--operator <login>] [--once]');
  } catch (err) {
    if (err instanceof UsageError) return { status: 'usage', error: err.message };
    if (err instanceof ConfigError) return { status: 'no_operator', variable: OPERATOR_ENV, error: err.message };
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
    writeFile: (path, text) => writeFileSync(path, text),
    env: process.env,
  };
  const result = await main(process.argv.slice(2), deps);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = EXIT[result.status] ?? 1;
}
