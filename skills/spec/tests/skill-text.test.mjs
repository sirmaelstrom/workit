// The pre-approval gates in /spec, /burn-down and /pickup run the
// operator-proof verifier on the signed bytes; `answer.by` is the go only in
// unconfigured mode. conduct's prose quotes what a configured run shows.
// Every acceptance sentence is checked for each requirement on its own, and a
// mutation control strips each requirement from an in-memory copy of the
// sentences to show the check then fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHORITY_TERMINAL, AUTHORITY_WAITING } from '../../conduct/scripts/lib/authority.mjs';

const skills = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (id) => readFileSync(join(skills, id, 'SKILL.md'), 'utf8');

// Blocks on blank lines and list-item starts; whitespace inside a block
// collapses to one space (a hard wrap never splits a phrase); then sentences,
// including one that ends inside bold (`.**`).
const sentences = (body) => body
  .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
  .map((block) => block.replace(/\s+/g, ' ').trim())
  .flatMap((block) => block.split(/(?<=[.!?]\**)\s+(?=[A-Z*`(])/));

const UNCONFIGURED = [/\bunconfigured\b/i, /`answer\.by`/, /\bbegin(?:s|ning)? `operator:`/];
const FILING = [/`answer\.askReceiptId` is present/, /equals the ask receipt id retained from `spine_receipt` at filing after lowercasing both/];

// Where each skill accepts a go, how many paths it has (primary and resolver,
// or spine: and core:), and what each path must say.
const GATES = {
  spec: {
    accepts: /valid only on exit 0/, paths: 2,
    configured: [/`scopeOk: true`/, /the printed `grant\.runId` equal to `state\.json`'s `runId`/],
  },
  'burn-down': {
    accepts: /\bIS the go\b/, paths: 2,
    configured: [/verify-receipt/, /exits 0/, /--state\b/, /`mode` is `verified`/, ...FILING],
  },
  pickup: {
    accepts: /\bIS the go\b/, paths: 2,
    configured: [/verify-receipt/, /exits 0/, /--state\b/, /`mode` is `verified`/, ...FILING],
  },
};

const acceptance = (id) => sentences(text(id)).filter((sentence) => GATES[id].accepts.test(sentence));

const missing = (found, required) => found.flatMap((sentence) => required
  .filter((pattern) => !pattern.test(sentence))
  .map((pattern) => `${pattern} not in: ${sentence}`));

// Strip each requirement from each sentence in turn: the check must then fail.
function assertMutationsFail(id, found, required) {
  for (const [i, sentence] of found.entries()) {
    for (const pattern of required) {
      const copy = [...found];
      copy[i] = sentence.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '');
      assert.notDeepEqual(missing(copy, required), [], `${id}: removing ${pattern} from sentence ${i} went unnoticed`);
    }
  }
}

for (const id of Object.keys(GATES)) {
  test(`/${id} has a sentence for each acceptance path`, () => {
    assert.ok(acceptance(id).length >= GATES[id].paths, `${id}: ${acceptance(id).length} acceptance sentences, want ${GATES[id].paths}`);
  });

  test(`/${id} configured: every acceptance path names what the verifier must print`, () => {
    const found = acceptance(id);
    assert.ok(found.length > 0, id);
    assert.deepEqual(missing(found, GATES[id].configured), [], id);
    assertMutationsFail(id, found, GATES[id].configured);
  });

  test(`/${id} unconfigured: every acceptance path keeps the operator stamp`, () => {
    const found = acceptance(id);
    assert.ok(found.length > 0, id);
    assert.deepEqual(missing(found, UNCONFIGURED), [], id);
    assertMutationsFail(id, found, UNCONFIGURED);
  });
}

test('/burn-down and /pickup take the ask id from their own filing', () => {
  for (const id of ['burn-down', 'pickup']) {
    const body = sentences(text(id)).join(' ');
    assert.match(body, /keep the `id` that `spine_receipt` returns/, id);
    assert.match(body, /never from the answer/, id);
    assert.match(body, /`statement_mismatch`/, id);
    // A lost id is not recovered from the answer: the go is not verified.
    assert.match(body, /the go is not verified/, id);
    assert.match(body, /`statement_mismatch` binding applies only when a passkey is configured/, id);
    assert.match(body, /operator stamp plus the filing-id equality/, id);
  }
});

test('/spec names both verifier commands, and the run-prefix check stays', () => {
  const spec = sentences(text('spec')).join(' ');
  assert.match(spec, /verify-receipt/);
  assert.match(spec, /verify-record/);
  assert.match(spec, /does not replace this prefix check/);
});

test('/spec separates the record\'s (c) from the confirm\'s signed (a), and explains the unconfirmed record', () => {
  const spec = sentences(text('spec')).join(' ');
  assert.match(spec, /its own `answer\.key` is `c`/);
  assert.match(spec, /the confirm's signed key, which must be `a`/);
  assert.match(spec, /before the operator confirms it/);
  assert.match(spec, /no verified confirming grant, or `scopeOk: false`, means not a go/);
  assert.doesNotMatch(spec, /refuses it with `proof_absent`/);
});

test('/spec defines the meta.json gate value once and every write site references it', () => {
  const spec = text('spec');
  assert.doesNotMatch(spec, /`gate` to `"preapproved <ref>"`/);
  assert.equal(spec.split('**The gate value.**').length - 1, 1);
  assert.ok(spec.split('the gate value (§').length - 1 >= 3, 'fewer than 3 write sites reference the gate value');
});

test('/burn-down: the operator confirms on the phone, and the agent waits', () => {
  const body = sentences(text('burn-down')).join(' ');
  assert.match(body, /until the operator confirms it on the phone/);
  assert.match(body, /wait for that signed answer/);
});

// Decision D5 (spine-answer-passkey): only an authority-acting go needs the
// signed answer; any other ask may proceed on the unsigned T3 answer.
test('/burn-down and /pickup scope the phone confirm to authority, as D5 rules', () => {
  for (const id of ['burn-down', 'pickup']) {
    const [sentence, ...rest] = sentences(text(id)).filter((s) => s.includes('carries no authority'));
    assert.equal(rest.length, 0, id);
    assert.match(sentence, /merge, release, spend or pre-approve/, id);
    assert.match(sentence, /until the operator confirms it on the phone/, id);
    const exception = sentences(text(id)).filter((s) => s.includes('grants none of these'));
    assert.equal(exception.length, 1, id);
    assert.match(exception[0], /question and filing-id checks pass/, id);
    assert.doesNotMatch(text(id), /answer is not a go until/, id);
  }
});

test('/conduct: the read-back names the configured proof and the unconfigured stamp', () => {
  // Rule 6: the read-back's two sentences about "that filing".
  const found = sentences(text('conduct')).filter((sentence) => sentence.includes('that filing'));
  assert.ok(found.length > 0);
  assert.equal(found.length, 2);
  for (const sentence of found) {
    const required = sentence.includes('read-back accepts')
      ? [/only an answered receipt to that filing/, /stamped `operator:`/]
      : [/With a passkey configured/, /proof that verifies against that filing's ask/];
    assert.deepEqual(missing([sentence], required), []);
    assertMutationsFail('conduct', [sentence], required);
  }
});

test('/conduct: (d) declines the confirm, it does not re-open it', () => {
  const conduct = sentences(text('conduct'));
  const confirm = conduct.filter((sentence) => /re-opens the confirm|the confirm re-opens/.test(sentence));
  assert.ok(confirm.length > 0);
  for (const sentence of confirm) assert.doesNotMatch(sentence, /any other key re-opens/, sentence);
  assert.match(conduct.join(' '), /\(d\) declines: the run ends with `phase = 'declined'`/);
});

test('the documented answer adapter selects the ask column', () => {
  const example = text('conduct').split('\n').find((line) => line.includes('select row_to_json'));
  assert.ok(example, 'no answer-adapter example in conduct/SKILL.md');
  assert.match(example, /select id, outcome, question, ask, answer from/);
});

test('conduct quotes what a configured run shows the operator', () => {
  const conduct = text('conduct');
  for (const shown of [
    '[grant <tag>]', '[raise <tag>]', 'UNCONFIGURED — answers not signed',
    'UNCONFIGURED — no anchor is configured now, so the stored answer is not checked', AUTHORITY_WAITING, AUTHORITY_TERMINAL,
  ]) {
    assert.ok(conduct.includes(shown), shown);
  }
});
