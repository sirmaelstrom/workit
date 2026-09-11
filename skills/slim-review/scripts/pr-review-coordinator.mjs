/**
 * pr-review-coordinator.mjs — the writer's HTTP client for the review
 * coordinator.
 *
 * One function per coordinator endpoint, nothing else. The client owns three
 * things and refuses to own a fourth:
 *
 *   1. The wire shape. Every body is built field by field from the long
 *      snake_case names (`attempt_ref`, `worker_key`, `sender_pid`,
 *      `post_generation`, `document_path`, `document_sha256`), and an unknown
 *      or missing field is a TypeError here rather than a `bad-request` two
 *      network hops later. Two untyped repositories cannot normalise a casing
 *      they never disagree about.
 *   2. Authorization. The token travels in the `x-pr-review-token` header and
 *      is never logged, never echoed, and never part of a returned object.
 *   3. Classification. Every failure leaves as `{ok: false, code, live?, ended?}`
 *      with the code verbatim, so the caller's outcome line carries the same
 *      string the coordinator used.
 *
 * What it deliberately does not own: retries, attempt budgets, and takeover.
 * A refused call is refused. Retry authority lives with the beat and the
 * per-lens count the coordinator keeps; a client that retried a 409 would
 * duplicate the refusal it was told about.
 *
 * Failure classification, in order:
 *   - the request never reached a listener      → `coordinator-unreachable`
 *   - a JSON body carrying `code`               → that code verbatim (`live` / `ended` carried along)
 *   - HTTP 401 without a contract code          → `unauthorized`
 *   - HTTP 404 on an identity route             → `identity-unset`
 *   - anything else non-2xx, or a body that is
 *     not JSON (an error page raised ahead of
 *     the route, e.g. a body-size refusal)      → `coordinator-unreachable`, status in the message
 *
 * The last rule is why the parse is guarded: an Express-level 4xx/5xx answers
 * with HTML, and an unhandled `JSON.parse` there would surface as a stack trace
 * instead of a classified refusal.
 */

/** Route prefix the coordinator is mounted under on the bridge. */
export const COORDINATOR_BASE_PATH = '/api/pr-review';

/** Authorization header. Loopback source address is the coordinator's half. */
export const TOKEN_HEADER = 'x-pr-review-token';

/** Reasons this client raises itself (never the coordinator's). */
export const CLIENT_REASONS = Object.freeze({
  unreachable: 'coordinator-unreachable',
  unauthorized: 'unauthorized',
  identityUnset: 'identity-unset',
});

/** AttemptRef — all six fields are validated on every call that carries one. */
export const ATTEMPT_REF_FIELDS = Object.freeze(['repo', 'pr', 'head_sha', 'base_sha', 'attempt', 'run_id']);

/**
 * `source` says who named the code, which is not the same question as who
 * answered: a 404 on the identity route is the coordinator's response but
 * `identity-unset` is a client-side reason, and an HTML 502 is nobody's code at
 * all. A caller that reports `coordinator_code` needs the distinction.
 */
function refusal(code, { status, live, ended, message, source = 'client' } = {}) {
  return {
    ok: false,
    code,
    source,
    ...(live === undefined ? {} : { live }),
    ...(ended === undefined ? {} : { ended }),
    ...(status === undefined ? {} : { status }),
    message: message ?? code,
  };
}

/**
 * Build one request body from the named fields only.
 *
 * A field-by-field builder is a whitelist, and a whitelist that drops what it
 * does not recognise turns a caller's typo into a silently short body. So the
 * unknown key throws instead: the caller is a program, and a wrong field name
 * is a defect in it, not a wire condition.
 */
function buildBody(name, input, required, optional = []) {
  const known = new Set([...required, ...optional]);
  const given = input ?? {};
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      throw new TypeError(`${name}: unknown body field ${JSON.stringify(key)}; the wire fields are ${[...known].join(', ')}`);
    }
  }
  const out = {};
  for (const key of required) {
    if (given[key] === undefined) throw new TypeError(`${name}: ${key} is required`);
    out[key] = given[key];
  }
  for (const key of optional) {
    if (given[key] !== undefined) out[key] = given[key];
  }
  return out;
}

function assertAttemptRef(name, ref) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new TypeError(`${name}: attempt_ref must be an object with ${ATTEMPT_REF_FIELDS.join(', ')}`);
  }
  for (const field of ATTEMPT_REF_FIELDS) {
    if (ref[field] === undefined || ref[field] === null) {
      throw new TypeError(`${name}: attempt_ref.${field} is required — all six fields are validated on every call`);
    }
  }
  for (const key of Object.keys(ref)) {
    if (!ATTEMPT_REF_FIELDS.includes(key)) {
      throw new TypeError(`${name}: attempt_ref carries an unknown field ${JSON.stringify(key)}`);
    }
  }
  return ref;
}

/**
 * Create a coordinator client.
 *
 * @param {object} options
 * @param {string} options.coordinator base URL, e.g. `http://127.0.0.1:3100`
 * @param {string} options.token the coordinator token (never logged or returned)
 */
export function createClient({ coordinator, token } = {}) {
  if (typeof coordinator !== 'string' || coordinator.trim() === '') {
    throw new TypeError('createClient: coordinator must be a non-empty base URL');
  }
  if (typeof token !== 'string' || token === '') {
    // Fail closed rather than send an unauthenticated call that can only 401:
    // an absent token means the installation is not provisioned, which the
    // managed resolver answers before anything reaches this module.
    throw new TypeError('createClient: token must be a non-empty string');
  }
  const base = `${coordinator.replace(/\/+$/, '')}${COORDINATOR_BASE_PATH}`;

  async function request(name, method, path, { body, query, notFoundReason } = {}) {
    let url;
    try {
      url = new URL(`${base}${path}`);
    } catch (err) {
      throw new TypeError(`${name}: ${coordinator} is not a usable coordinator URL: ${err.message}`);
    }
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          [TOKEN_HEADER]: token,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          // `lens` blocks this event loop for minutes inside a synchronous
          // reviewer spawn between `lens-start` and `lens-end`; the
          // coordinator's 5s keep-alive closes the idle socket while that
          // spawn runs. Undici's default pool then reuses the dead socket for
          // `lens-end` and it dies `read ECONNRESET` (measured 4 of 4,
          // 2026-09-11) — reported here as `coordinator-unreachable` with the
          // attempt stuck in `lens_running`. One socket per call removes the
          // reuse; undici honours this header (probe: with it, two calls open
          // two connections instead of one).
          connection: 'close',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A coordinator on loopback never redirects; treating one as a
        // transport failure keeps a misrouted call from being followed
        // somewhere else with the token attached.
        redirect: 'error',
      });
    } catch (err) {
      return refusal(CLIENT_REASONS.unreachable, {
        message: `${name}: ${method} ${url.pathname} did not reach the coordinator: ${err?.message ?? String(err)}`,
      });
    }

    const text = await response.text();
    let parsed;
    let parseFailed = false;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }

    if (response.ok) {
      if (parseFailed) {
        return refusal(CLIENT_REASONS.unreachable, {
          status: response.status,
          message: `${name}: coordinator answered HTTP ${response.status} with a body that is not JSON`,
        });
      }
      return { ok: true, status: response.status, body: parsed ?? {} };
    }

    const code = !parseFailed && parsed && typeof parsed === 'object' && typeof parsed.code === 'string' && parsed.code !== ''
      ? parsed.code
      : null;
    if (code) {
      return refusal(code, {
        status: response.status,
        live: parsed.live,
        ended: parsed.ended,
        message: typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : `${name}: ${code}`,
        source: 'coordinator',
      });
    }
    if (response.status === 401) {
      return refusal(CLIENT_REASONS.unauthorized, {
        status: 401,
        message: `${name}: coordinator refused the token`,
        source: 'coordinator',
      });
    }
    if (response.status === 404 && notFoundReason) {
      return refusal(notFoundReason, {
        status: 404,
        message: `${name}: ${notFoundReason}`,
      });
    }
    return refusal(CLIENT_REASONS.unreachable, {
      status: response.status,
      message: `${name}: coordinator answered HTTP ${response.status} without a contract code`,
    });
  }

  return {
    /** POST /claim — the only path that allocates an attempt. */
    claim(input) {
      return request('claim', 'POST', '/claim', {
        body: buildBody(
          'claim',
          input,
          ['repo', 'pr', 'head_sha', 'base_sha', 'worker_key', 'owner_label', 'manifest'],
          ['required_lenses', 'exception_reason', 'supersede_review_id', 'actor', 'reason'],
        ),
      });
    },

    /**
     * GET /attempt?attempt_ref — one query parameter carrying the whole ref.
     *
     * The contract writes this endpoint `?ref` and the flat one `?repo&pr`, and
     * `ref` abbreviates the wire field `attempt_ref`; a six-field object cannot
     * ride in one parameter except as JSON, so that is what it is.
     */
    readAttempt(attemptRef) {
      return request('readAttempt', 'GET', '/attempt', {
        query: { attempt_ref: JSON.stringify(assertAttemptRef('readAttempt', attemptRef)) },
      });
    },

    /** GET /status?repo&pr — the per-PR view: heads, pointers, every attempt. */
    readStatus(input) {
      const query = buildBody('readStatus', input, ['repo', 'pr']);
      return request('readStatus', 'GET', '/status', { query });
    },

    /** POST /recognise-import — adopt a review posted outside an attempt. */
    recogniseImport(input) {
      return request('recogniseImport', 'POST', '/recognise-import', {
        body: buildBody(
          'recogniseImport',
          input,
          ['repo', 'pr', 'head_sha', 'review_id', 'author_login', 'commit_id', 'listing_checked_at'],
          ['marker'],
        ),
      });
    },

    /** GET /identity — the pinned posting login, or `identity-unset`. */
    readIdentity() {
      return request('readIdentity', 'GET', '/identity', { notFoundReason: CLIENT_REASONS.identityUnset });
    },

    /** POST /identity — pin the posting login (operator preflight). */
    identity(input) {
      return request('identity', 'POST', '/identity', {
        body: buildBody('identity', input, ['login', 'actor', 'reason']),
        notFoundReason: CLIENT_REASONS.identityUnset,
      });
    },

    /** POST /lens-start — admits one lens execution and mints its execution_id. */
    lensStart(input) {
      const body = buildBody('lensStart', input, ['attempt_ref', 'worker_key', 'lens']);
      assertAttemptRef('lensStart', body.attempt_ref);
      return request('lensStart', 'POST', '/lens-start', { body });
    },

    /** POST /lens-end — the sole exhaustion authority; answers `terminal`. */
    lensEnd(input) {
      const body = buildBody(
        'lensEnd',
        input,
        ['attempt_ref', 'worker_key', 'lens', 'execution_id', 'outcome'],
        ['reason', 'document_path', 'document_sha256', 'head_now'],
      );
      assertAttemptRef('lensEnd', body.attempt_ref);
      return request('lensEnd', 'POST', '/lens-end', { body });
    },

    /** POST /reserve-post — the reservation; the body is exactly these three. */
    reservePost(input) {
      const body = buildBody('reservePost', input, ['attempt_ref', 'worker_key', 'sender_pid']);
      assertAttemptRef('reservePost', body.attempt_ref);
      return request('reservePost', 'POST', '/reserve-post', { body });
    },

    /** POST /resolve — classify the submission under its post_generation. */
    resolve(input) {
      const body = buildBody(
        'resolve',
        input,
        ['attempt_ref', 'worker_key', 'post_generation', 'outcome'],
        ['review_id', 'reason', 'head_now'],
      );
      assertAttemptRef('resolve', body.attempt_ref);
      return request('resolve', 'POST', '/resolve', { body });
    },

    /** POST /withdraw — the single authority for a writer-initiated exit. */
    withdraw(input) {
      const body = buildBody('withdraw', input, ['attempt_ref', 'worker_key', 'reason'], ['head_now']);
      assertAttemptRef('withdraw', body.attempt_ref);
      return request('withdraw', 'POST', '/withdraw', { body });
    },

    /**
     * POST /recover/abandon — retire an attempt whose lease has expired.
     * Allocates nothing. There is no takeover: recovery frees a head, it never
     * hands the work to someone else.
     */
    recoverAbandon(input) {
      const body = buildBody('recoverAbandon', input, ['attempt_ref', 'actor', 'reason']);
      assertAttemptRef('recoverAbandon', body.attempt_ref);
      return request('recoverAbandon', 'POST', '/recover/abandon', { body });
    },

    /** POST /recover/grace-sweep — a posting attempt past the grace window. */
    recoverGraceSweep(input) {
      const body = buildBody('recoverGraceSweep', input, ['attempt_ref', 'actor', 'reason', 'post_generation']);
      assertAttemptRef('recoverGraceSweep', body.attempt_ref);
      return request('recoverGraceSweep', 'POST', '/recover/grace-sweep', { body });
    },

    /** POST /recover/delivery — the review was found; the attempt posted. */
    recoverDelivery(input) {
      const body = buildBody('recoverDelivery', input, ['attempt_ref', 'actor', 'reason', 'review_id', 'post_generation']);
      assertAttemptRef('recoverDelivery', body.attempt_ref);
      return request('recoverDelivery', 'POST', '/recover/delivery', { body });
    },

    /** POST /recover/not-delivered — proven undelivered; frees the head. */
    recoverNotDelivered(input) {
      const body = buildBody(
        'recoverNotDelivered',
        input,
        ['attempt_ref', 'actor', 'reason', 'post_generation', 'listing_checked_at'],
        ['force_unverified'],
      );
      assertAttemptRef('recoverNotDelivered', body.attempt_ref);
      return request('recoverNotDelivered', 'POST', '/recover/not-delivered', { body });
    },

    /** POST /recover/withdraw — operator or kill-switch retirement. */
    recoverWithdraw(input) {
      const body = buildBody('recoverWithdraw', input, ['attempt_ref', 'actor', 'reason']);
      assertAttemptRef('recoverWithdraw', body.attempt_ref);
      return request('recoverWithdraw', 'POST', '/recover/withdraw', { body });
    },
  };
}
