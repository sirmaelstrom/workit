// The pre-approval gates in /spec, /burn-down and /pickup run the
// operator-proof verifier on the signed bytes; `answer.by` is the go only in
// unconfigured mode. conduct's prose quotes what a configured run shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHORITY_TERMINAL, AUTHORITY_WAITING } from '../../conduct/scripts/lib/authority.mjs';

const skills = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (id) => readFileSync(join(skills, id, 'SKILL.md'), 'utf8');

// Paragraphs on blank (or whitespace-only) lines, then sentences.
const sentences = (body) => body.split(/\n\s*\n/).flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=[A-Z*`(])/));

test('/spec names both verifier commands', () => {
  const spec = text('spec');
  assert.match(spec, /verify-receipt/);
  assert.match(spec, /verify-record/);
});

test('/burn-down and /pickup read the go through verify-receipt', () => {
  for (const id of ['burn-down', 'pickup']) assert.match(text(id), /verify-receipt/, id);
});

test('every `begins operator:` or `IS the go` sentence names the verifier or the unconfigured fallback', () => {
  for (const id of ['spec', 'burn-down']) {
    const offenders = sentences(text(id))
      .filter((sentence) => sentence.includes('begins `operator:`') || sentence.includes('IS the go'))
      .filter((sentence) => !/unconfigured/i.test(sentence) && !sentence.includes('verify-receipt'));
    assert.deepEqual(offenders, [], id);
  }
});

test('the documented answer adapter selects the ask column', () => {
  const example = text('conduct').split('\n').find((line) => line.includes('select row_to_json'));
  assert.ok(example, 'no answer-adapter example in conduct/SKILL.md');
  assert.match(example, /select id, outcome, question, ask, answer from/);
});

test('conduct quotes what a configured run shows the operator', () => {
  const conduct = text('conduct');
  for (const shown of ['[grant <tag>]', '[raise <tag>]', 'UNCONFIGURED — answers not signed', AUTHORITY_WAITING, AUTHORITY_TERMINAL]) {
    assert.ok(conduct.includes(shown), shown);
  }
});
