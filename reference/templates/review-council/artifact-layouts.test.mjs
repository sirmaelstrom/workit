import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('council contract covers every concrete deep-stage output declared by the spec producer', () => {
  const contract = JSON.parse(readFileSync(new URL('./artifact-layouts.json', import.meta.url), 'utf8'));
  const skill = readFileSync(new URL('../../../skills/spec/SKILL.md', import.meta.url), 'utf8');
  const stageLines = skill.split('\n').filter((line) => /^- Output:/.test(line));
  assert.ok(stageLines.length >= 6, 'producer output declarations must be discoverable');
  const outputs = stageLines.flatMap((line) => [...line.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1]));
  const concrete = outputs.filter((p) => !p.includes('{'));
  assert.deepEqual([...contract.workshop.required].sort(), concrete.sort());
  assert.equal(contract.version, 1);
  assert.ok(new RegExp(contract.workshop.packagePattern).test('wp-01-example.md'));
  assert.equal(contract.workshop.packagesDirectory, 'work-packages');
  assert.deepEqual(contract.lite, ['spec.md', 'spec-lite.md']);
});

test('synthesis template keeps the reviewers\' Limits under their own heading, with IDs', () => {
  const synthesis = readFileSync(new URL('./synthesis.md', import.meta.url), 'utf8');
  const contract = synthesis.split('## Output contract')[1] ?? '';
  const headings = contract.split('```')[1]?.trim().split(/\r?\n/) ?? [];
  assert.deepEqual(headings, ['## Consensus Issues', '## Majority Issues', '## Split Opinions', '## Unique Findings', '## Limits']);
  assert.match(contract, /these five markdown headings/);
  assert.match(synthesis, /Give each an ID \(`L1: does not establish …`\) and name the models that stated it/);
  assert.match(synthesis, /Keep a limit even when you drop the finding it qualified/);
  for (const placeholder of ['{{workshop_title}}', '{{round}}', '{{prior_findings}}']) assert.ok(synthesis.includes(placeholder), placeholder);
});

const challengeTemplate = () => readFileSync(new URL('./challenge.md', import.meta.url), 'utf8');

const challengeMutations = {
  threshold: (text) => text.replace('at `code-read` or better', 'at `inferred` or better'),
  inferred: (text) => text.replace('A refutation at `inferred` never demotes.', 'A refutation at `inferred` may demote.'),
  verdict: (text) => text.replace('one verdict: `confirmed`', 'one verdict: `supported`'),
  severity: (text) => text.replace('A `confirmed` verdict never raises severity', 'A `confirmed` verdict may raise severity'),
  heading: (text) => text.replace('### Demoted to Questions', '### Demoted Questions'),
  precedence: (text) => text.replace('eligible Verifier refutation takes precedence', 'ordinary challenge takes precedence'),
  intent: (text) => text.replace('Documented intent is context, not refutation', 'Documented intent alone is refutation'),
  refutation: (text) => text.replace('`refuted` (evidence contradicts the premise)', '`refuted` (the behavior is documented)'),
  grounding: (text) => text.replace('Grounding Integrity governs demotion eligibility', 'Grounding Integrity is advisory'),
  provenance: (text) => text.replace('`code-read` or better requires a tool read or run in THIS session.', '`code-read` accepts quoted source.'),
  path: (text) => text.replace('a Verifier refutation needs evidence from the actual render, resolve, or dispatch path', 'a Verifier refutation can use source alone'),
  table: (text) => text.replace('An omitted table is an incomplete challenge.', 'The table may be omitted.'),
  key: (text) => text.replace('Identify each finding by its number or quoted title and location', 'Identify each finding by its row order'),
};

function assertChallengeVerifierContract(template) {
  const [instructions, synthesis] = template.split(/^## Synthesis to Challenge\s*$/m);
  assert.ok(synthesis, 'instructions precede the inlined synthesis');
  const headings = [...instructions.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, ['Upheld', 'Downgraded', 'Overturned', 'New Concerns', 'Demoted to Questions', 'Verification']);
  assert.deepEqual([...template.matchAll(/{{([^}]+)}}/g)].map((match) => match[1]), [
    'workshop_title', 'round', 'prior_findings',
  ]);
  assert.match(instructions, /one verdict: `confirmed` .*?`refuted` .*?`unresolved`/);
  assert.match(instructions, /`refuted` \(evidence contradicts the premise\)/);
  assert.match(instructions, /Documented intent is context, not refutation/);
  assert.match(instructions, /Grounding Integrity governs demotion eligibility/);
  assert.match(instructions, /A Verifier refutation at `code-read` or better demotes only when/);
  assert.match(instructions, /A refutation at `inferred` never demotes\./);
  assert.match(instructions, /A `confirmed` verdict never raises severity/);
  assert.match(instructions, /eligible Verifier refutation takes precedence/);
  assert.match(instructions, /`code-read` or better requires a tool read or run in THIS session\./);
  assert.match(instructions, /Without that evidence, mark the Verifier verdict `unresolved` and do not demote\./);
  assert.match(instructions, /a Verifier refutation needs evidence from the actual render, resolve, or dispatch path/);
  assert.match(instructions, /Demoted to question: <finding> — <premise> — <check>/);
  assert.match(instructions, /\| Finding \| Weakest premise \| Decisive check \| Proof level \| Verdict \| Final placement \|/);
  assert.match(instructions, /\| None \| — \| — \| — \| — \| — \|/);
  assert.match(instructions, /Identify each finding by its number or quoted title and location/);
  assert.match(instructions, /An omitted table is an incomplete challenge\./);
}

test('challenge template preserves headings and enforces the refutation-only contract', () => {
  const template = challengeTemplate();
  const mutation = process.env.COUNCIL_CONTRACT_MUTATION;
  assertChallengeVerifierContract(mutation ? challengeMutations[mutation](template) : template);
});

test('weakened challenge rules fail the contract assertion', () => {
  const template = challengeTemplate();
  for (const [name, mutate] of Object.entries(challengeMutations)) {
    const weakened = mutate(template);
    assert.notEqual(weakened, template, `${name} mutation must change the template`);
    assert.throws(() => assertChallengeVerifierContract(weakened), undefined, `${name} mutation must fail`);
  }
});
