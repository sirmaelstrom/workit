// Asks and gos in /spec, /burn-down and /pickup. In session an ask is a plain
// AskUserQuestion with the recommendation first, and the ruling goes in the
// next Spine receipt; a Spine `needs_input` ask is for unattended runs, and its
// go is an `answered` receipt stamped `operator:` to the ask's question. No
// proof or verifier check remains. Every acceptance sentence is checked for
// each requirement on its own, and a mutation control strips each requirement
// from an in-memory copy of the sentences to show the check then fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const skills = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (id) => readFileSync(join(skills, id, 'SKILL.md'), 'utf8');

// Blocks on blank lines and list-item starts; whitespace inside a block
// collapses to one space (a hard wrap never splits a phrase); then sentences,
// including one that ends inside bold (`.**`).
const sentences = (body) => body
  .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
  .map((block) => block.replace(/\s+/g, ' ').trim())
  .flatMap((block) => block.split(/(?<=[.!?]\**)\s+(?=[A-Z*`(])/));

const STAMP = [/`answer\.by`/, /\bbegins `operator:`/];
const QUESTION = /`question` (?:is (?:your|the) ask's, verbatim|passes the same verbatim check)/;

// Where each skill accepts a go, how many paths it has (primary and resolver,
// or spine: and core:), and what each path must say.
const GATES = {
  spec: { accepts: /\b[Tt]he ref is valid only when\b/, paths: 2, required: STAMP },
  'burn-down': { accepts: /\bIS the go\b/, paths: 2, required: [...STAMP, QUESTION] },
  pickup: { accepts: /\bIS the go\b/, paths: 2, required: [...STAMP, QUESTION] },
};

const ASKERS = ['pickup', 'burn-down', 'spec'];

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

  test(`/${id}: every acceptance path requires the operator stamp`, () => {
    const found = acceptance(id);
    assert.ok(found.length > 0, id);
    assert.deepEqual(missing(found, GATES[id].required), [], id);
    assertMutationsFail(id, found, GATES[id].required);
  });
}

const PLAIN_ASK = [/plain AskUserQuestion/, /recommendation first/, /recommended option listed first/, /label ending "\(Recommended\)"/];
const RULING = [/the chosen label verbatim/, /the session id/];

for (const id of ASKERS) {
  test(`/${id}: an in-session ask is a plain AskUserQuestion, recommendation first`, () => {
    const found = sentences(text(id)).filter((sentence) => sentence.includes('AskUserQuestion'));
    assert.equal(found.length, 1, id);
    assert.deepEqual(missing(found, PLAIN_ASK), [], id);
    assertMutationsFail(id, found, PLAIN_ASK);
  });

  test(`/${id}: the ruling goes in the next Spine receipt with the label and session id`, () => {
    const found = sentences(text(id)).filter((sentence) => /record the ruling in your next Spine receipt/i.test(sentence));
    assert.ok(found.length > 0, id);
    assert.deepEqual(missing(found, RULING), [], id);
    assertMutationsFail(id, found, RULING);
  });

  test(`/${id}: a Spine ask is for unattended runs`, () => {
    assert.match(sentences(text(id)).join(' '), /Spine (?:`needs_input` )?ask is for unattended runs/, id);
  });

  test(`/${id} carries no retired proof or ask-tag mechanism`, () => {
    const body = text(id);
    for (const retired of [
      /\[ask </, /verify-receipt/, /verify-record/, /operator-proof/, /passkey/i, /ask-mirror/, /operator:t3/,
      /on the phone|Confirm on phone/, /sitting grant/i, /\bscopeOk\b/, /statement_mismatch/, /askReceiptId/,
      /"mode":"unconfigured"/, /`mode` is `verified`/, /answers not signed/,
    ]) {
      assert.doesNotMatch(body, retired, `${id}: ${retired}`);
    }
  });
}

test('/conduct carries no retired proof, ask-tag, spend-meter or answer-adapter mechanism', () => {
  const body = sentences(text('conduct')).join(' ');
  for (const retired of [
    /\[ask </, /verify-receipt/, /operator-proof/, /passkey/i, /ask-mirror/, /operator:t3/, /on the phone|Confirm on phone/,
    /sitting grant/i, /WORKIT_SPEND_CMD/, /WORKIT_TOUCH_ANSWER_CMD/, /await-answer/, /Signed authority/, /spend adapter/,
  ]) {
    assert.doesNotMatch(body, retired, `conduct: ${retired}`);
  }
  assert.match(body, /pose it as a plain AskUserQuestion with the recommendation first/);
});

test('/conduct: a chat answer is not a touch\'s go; the channel\'s answer wins', () => {
  assert.match(sentences(text('conduct')).join(' '), /A chat answer is not a go for a touch: when it and the channel's answer differ, the channel's answer wins/);
});

// Frozen workshop text read as data, and history files, keep the retired words.
const HISTORY = (path) => /[\\/]__fixtures__[\\/]/.test(path) || /CHANGELOG|HISTORY/i.test(basename(path));
const markdown = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : markdown(path);
  return entry.name.endsWith('.md') ? [path] : [];
});
const RETIRED_EVERYWHERE = [/spend adapter/i, /verify-receipt/, /operator-proof/, /passkey/i, /\[ask </, /WORKIT_TOUCH_ANSWER_CMD/, /sitting grant/i];

test('no skill or reference doc names a retired proof, ask-tag, spend-adapter or answer-resolver mechanism', () => {
  const files = [...markdown(skills), ...markdown(join(skills, '..', 'reference'))].filter((path) => !HISTORY(path));
  assert.ok(files.length > 50, `walked ${files.length} files`);
  const hits = files.flatMap((path) => {
    const body = readFileSync(path, 'utf8');
    return RETIRED_EVERYWHERE.filter((retired) => retired.test(body)).map((retired) => `${relative(join(skills, '..'), path)}: ${retired}`);
  });
  assert.deepEqual(hits, []);
});

test('/burn-down and /pickup: in session, the operator\'s message is the go', () => {
  for (const id of ['burn-down', 'pickup']) {
    assert.match(sentences(text(id)).join(' '), /In session, (?:the operator's message is the go|the go is the operator's message)/, id);
  }
});

test('/spec keeps the run-prefix check on a spine: ref', () => {
  const spec = sentences(text('spec')).join(' ');
  assert.match(spec, /this run's correlation prefix `\(run <runId>\/`/);
  assert.match(spec, /the bare tag isn't enough/);
});

test('/spec: an authority record approves on its own (c) and binds its scope', () => {
  const spec = sentences(text('spec')).join(' ');
  assert.match(spec, /its own `answer\.key` is `c`/);
  assert.match(spec, /an authority record binds its `scope` field/);
  assert.doesNotMatch(spec, /the confirm's signed key/);
});

test('/spec defines the meta.json gate value once and every write site references it', () => {
  const spec = text('spec');
  assert.doesNotMatch(spec, /`gate` to `"preapproved <ref>"`/);
  assert.equal(spec.split('**The gate value.**').length - 1, 1);
  assert.ok(spec.split('the gate value (§').length - 1 >= 3, 'fewer than 3 write sites reference the gate value');
});

test('/spec: a decision lists its Limits with IDs, and the shipping PR carries them as Residuals', () => {
  const spec = sentences(text('spec'));
  const found = spec.filter((sentence) => sentence.includes('`L1: does not establish <what>`') && sentence.includes('numbered across the spec'));
  assert.equal(found.length, 1);
  assert.match(spec.join(' '), /The WP that ships the decision names its IDs, and its PR body lists them under `Residuals`/);
  // The lite template's Decisions slot carries the same Limits line.
  const lite = text('spec').split('\n').find((line) => line.startsWith('{Numbered D1, D2...'));
  assert.ok(lite, 'no lite Decisions template line');
  assert.match(lite, /`Limits:` \(`L1: does not establish <what>`\)/);
});

// conduct's read-back takes an answered receipt to its filing, stamped `operator:`.
test('/conduct: the read-back accepts only an answered receipt to that filing, stamped operator:', () => {
  const found = sentences(text('conduct')).filter((sentence) => sentence.includes('read-back accepts') && sentence.includes('that filing'));
  assert.ok(found.length > 0);
  const required = [/only an answered receipt to that filing/, /stamped `operator:`/];
  assert.deepEqual(missing(found, required), []);
  assertMutationsFail('conduct', found, required);
});
