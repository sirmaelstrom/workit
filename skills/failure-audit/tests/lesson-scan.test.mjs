import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseMemory, runLessonScan, verdict, markdownTable } from '../scripts/lesson-scan.mjs';

const names = [
  'conduct-spec-runtime-none-must-not-be-backticked',
  'slim-review-post-before-amending-or-the-head-moves-under-the-findings',
  'trash-cli-silently-no-ops-inside-temp',
  'no-jq-in-the-bash-tool-a-jq-monitor-is-silent-forever',
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'auto-memory');
  const corpusDir = path.join(root, 'projects');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(corpusDir);
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Index\n');
  function memory(name, situation = 'OPPORTUNITY', mistake = 'ERROR', scope = 'call', origin = 'origin') {
    const p = path.join(memoryDir, `${name}.md`);
    fs.writeFileSync(p, `---\nname: ${name}\nmetadata:\n  originSessionId: ${origin}\nsituation: {regex: "${situation}", scope: ${scope}}\nmistake: {regex: "${mistake}", scope: ${scope}}\n---\nbody\n`);
    fs.appendFileSync(path.join(memoryDir, 'MEMORY.md'), `- [${name}](${name}.md)\n`);
    return p;
  }
  function session(id, day, blocks, { project = 'project', extra = [], cwd = root } = {}) {
    const dir = path.join(corpusDir, project);
    fs.mkdirSync(dir, { recursive: true });
    const iso = `${day}T12:00:00.000Z`;
    const rows = [
      { type: 'user', timestamp: iso, cwd, message: { content: [{ type: 'text', text: 'ordinary task' }] } },
      { type: 'assistant', timestamp: iso, cwd, message: { content: blocks } },
      ...extra.map((r) => ({ timestamp: iso, cwd, ...r })),
    ];
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
    return dir;
  }
  const call = (text, id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: text } });
  const run = () => runLessonScan({ memoryDir, corpusDir, dataRepo: root });
  return { root, memoryDir, corpusDir, memory, session, call, run };
}

test('positive recurrence: each recorded trap can count an after mistake', (t) => {
  const f = fixture(t);
  for (const [i, name] of names.entries()) {
    f.memory(name, `OPPORTUNITY_${i}`, `ERROR_${i}`);
    for (let n = 0; n < 2; n++) f.session(`before-${i}-${n}`, `2026-09-0${n + 2}`, [f.call(`OPPORTUNITY_${i} ERROR_${i}`)]);
    for (let n = 0; n < 3; n++) f.session(`after-${i}-${n}`, `2026-09-1${n + 1}`, [f.call(`OPPORTUNITY_${i}${n ? '' : ` ERROR_${i}`}`)]);
  }
  f.session('origin', '2026-09-10', []);
  const report = f.run();
  for (const m of report.memories) {
    assert.equal(m.before.exposed, 2, m.file);
    assert.equal(m.before.mistakes, 2, m.file);
    assert.equal(m.after.exposed, 3, m.file);
    assert.equal(m.after.mistakes, 1, m.file);
    assert.equal(m.result, 'reduced', m.file);
  }
  assert.match(markdownTable(report), /Expected mistakes/);
});

test('correct use counts opportunity without mistake; no opportunity is untested', (t) => {
  const f = fixture(t);
  f.memory('correct');
  f.memory('no-opportunity', 'IMPOSSIBLE', 'NEVER');
  f.session('origin', '2026-09-10', []);
  f.session('before-a', '2026-09-02', [f.call('OPPORTUNITY ERROR')]);
  f.session('before-b', '2026-09-03', [f.call('OPPORTUNITY ERROR')]);
  for (let n = 1; n <= 3; n++) f.session(`after-${n}`, `2026-09-1${n}`, [f.call('OPPORTUNITY')]);
  const m = f.run().memories;
  assert.equal(m.find((x) => x.file.endsWith('correct.md')).result, 'reduced');
  assert.deepEqual(m.find((x) => x.file.endsWith('correct.md')).after, { exposed: 3, mistakes: 0 });
  assert.equal(m.find((x) => x.file.endsWith('no-opportunity.md')).result, 'untested');
});

test('quotation-only tool result is excluded, while a later real call still counts', (t) => {
  const f = fixture(t);
  const mem = f.memory('quoted', 'OPPORTUNITY', 'ERROR', 'result');
  f.session('origin', '2026-09-10', []);
  f.session('quote-only', '2026-09-11', [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: mem } }], {
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'OPPORTUNITY ERROR' }] } }],
  });
  f.session('real-result', '2026-09-12', [f.call('run', 'b1')], {
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'OPPORTUNITY ERROR' }] } }],
  });
  const m = f.run().memories[0];
  assert.deepEqual(m.after, { exposed: 1, mistakes: 1 });
  assert.equal(m.sessions.find((s) => s.id === 'quote-only').delivery, 'body-read');
  assert.equal(m.sessions.find((s) => s.id === 'quote-only').exposed, false);
});

test('subagent and parent matches count once per session, including user scope', (t) => {
  const f = fixture(t);
  f.memory('dedup', 'OPPORTUNITY', 'ERROR');
  f.memory('user-scope', 'PROMPT', 'BAD', 'user');
  f.session('origin', '2026-09-10', []);
  const dir = f.session('parent', '2026-09-12', [f.call('OPPORTUNITY ERROR')]);
  const sub = path.join(dir, 'parent', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-09-12T12:01:00Z', message: { content: [f.call('OPPORTUNITY ERROR')] } }) + '\n');
  f.session('user-hit', '2026-09-13', [], { extra: [{ type: 'user', message: { content: [{ type: 'text', text: 'PROMPT BAD' }] } }] });
  const report = f.run();
  assert.deepEqual(report.memories.find((m) => m.file.endsWith('dedup.md')).after, { exposed: 1, mistakes: 1 });
  assert.deepEqual(report.memories.find((m) => m.file.endsWith('user-scope.md')).after, { exposed: 1, mistakes: 1 });
});

test('delivery, time split, and exclusion markers are explicit', (t) => {
  const f = fixture(t);
  f.memory('delivery');
  f.session('origin', '2026-08-31', []);
  f.session('before-september', '2026-08-31', [f.call('OPPORTUNITY')]);
  f.session('index', '2026-09-02', [f.call('OPPORTUNITY')], { extra: [{ type: 'attachment', attachment: { type: 'instructions', files: [{ type: 'AutoMem', path: path.join(f.memoryDir, 'MEMORY.md') }] } }] });
  f.session('council', '2026-09-03', [f.call('OPPORTUNITY ERROR')], { cwd: path.join(f.root, 'council-seats', 'seat') });
  const report = f.run();
  const m = report.memories[0];
  assert.equal(m.treatmentSource, 'origin-session');
  assert.equal(m.sessions.find((s) => s.id === 'before-september').delivery, 'unknown');
  assert.equal(m.sessions.find((s) => s.id === 'index').delivery, 'index-loaded');
  assert.equal(report.skipped['council-seat'], 1);
});

test('fleet, summarizer, and git quote results do not add hits', (t) => {
  const f = fixture(t);
  f.memory('exclusions', 'OPPORTUNITY', 'ERROR', 'result');
  f.session('origin', '2026-09-10', []);
  f.session('fleet', '2026-09-11', [], { extra: [
    { type: 'user', message: { content: [{ type: 'text', text: 'You are one auditor in a fleet reading digests' }] } },
  ] });
  // Replace the first user prompt, which is the marker used by the detector.
  const fleetFile = path.join(f.corpusDir, 'project', 'fleet.jsonl');
  const fleetRows = fs.readFileSync(fleetFile, 'utf8').trim().split('\n').map(JSON.parse);
  fleetRows[0].message.content[0].text = 'You are one auditor in a fleet reading digests';
  fleetRows[1].message.content = [f.call('run', 'f1')];
  fleetRows.push({ type: 'user', timestamp: '2026-09-11T12:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'OPPORTUNITY ERROR' }] } });
  fs.writeFileSync(fleetFile, fleetRows.map(JSON.stringify).join('\n') + '\n');
  f.session('summarizer', '2026-09-12', [f.call('run', 's1')], { extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'OPPORTUNITY ERROR' }] } }] });
  const summaryFile = path.join(f.corpusDir, 'project', 'summarizer.jsonl');
  const summaryRows = fs.readFileSync(summaryFile, 'utf8').trim().split('\n').map(JSON.parse);
  summaryRows[0].message.content[0].text = 'SessionEnd: summarize the session';
  fs.writeFileSync(summaryFile, summaryRows.map(JSON.stringify).join('\n') + '\n');
  f.session('git-quote', '2026-09-13', [f.call(`git diff -- ${path.join(f.memoryDir, 'exclusions.md')}`, 'g1')], {
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'OPPORTUNITY ERROR' }] } }],
  });
  const report = f.run();
  assert.deepEqual(report.memories[0].after, { exposed: 0, mistakes: 0 });
  assert.equal(report.skipped['failure-audit-fleet'], 1);
  assert.equal(report.skipped.summarizer, 1);
});

test('relative git diff and Read paths under the memory directory cannot quote hits', (t) => {
  const f = fixture(t);
  f.memory('relative-quote', 'OPPORTUNITY', 'ERROR', 'result');
  f.session('origin', '2026-09-10', []);
  f.session('relative-git', '2026-09-11', [f.call('git diff -- relative-quote.md', 'g1')], {
    cwd: f.memoryDir,
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'OPPORTUNITY ERROR' }] } }],
  });
  f.session('relative-read', '2026-09-12', [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'relative-quote.md' } }], {
    cwd: f.memoryDir,
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'OPPORTUNITY ERROR' }] } }],
  });
  f.session('git-c', '2026-09-13', [f.call('git -C auto-memory show HEAD:relative-quote.md', 'c1')], {
    cwd: f.root,
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'OPPORTUNITY ERROR' }] } }],
  });
  const m = f.run().memories[0];
  assert.deepEqual(m.after, { exposed: 0, mistakes: 0 });
  assert.equal(m.sessions.find((s) => s.id === 'relative-read').delivery, 'body-read');
});

test('one session can contribute on both sides of treatment', (t) => {
  const f = fixture(t);
  f.memory('straddle');
  f.session('origin', '2026-09-10', []);
  f.session('straddle', '2026-09-09', [f.call('OPPORTUNITY ERROR')], {
    extra: [{ type: 'assistant', timestamp: '2026-09-11T12:00:00Z', message: { content: [f.call('OPPORTUNITY ERROR')] } }],
  });
  const m = f.run().memories[0];
  assert.deepEqual(m.before, { exposed: 1, mistakes: 1 });
  assert.deepEqual(m.after, { exposed: 1, mistakes: 1 });
  assert.ok(m.sessions.some((s) => s.id === 'straddle'));
});

test('strict frontmatter and not-trap classification', (t) => {
  const f = fixture(t);
  const partial = path.join(f.memoryDir, 'partial.md');
  fs.writeFileSync(partial, '---\nsituation: {regex: "x", scope: call}\n---\n');
  assert.equal(parseMemory(partial).status, 'not-trap');
  const malformed = path.join(f.memoryDir, 'bad.md');
  fs.writeFileSync(malformed, '---\nsituation: {regex: "x", scope: bogus}\nmistake: {regex: "y", scope: call}\n---\n');
  assert.throws(() => parseMemory(malformed), /bad\.md:2: use situation/);
  fs.writeFileSync(malformed, '---\nsituation: {regex: "[", scope: call}\nmistake: {regex: "y", scope: call}\n---\n');
  assert.throws(() => parseMemory(malformed), /invalid situation regex/);
});

test('git first-add day is fallback when origin session is absent', (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.root]);
  execFileSync('git', ['-C', f.root, 'config', 'user.email', 'fixture@example.test']);
  execFileSync('git', ['-C', f.root, 'config', 'user.name', 'Fixture']);
  f.memory('fallback', 'OPPORTUNITY', 'ERROR', 'call', 'missing-origin');
  execFileSync('git', ['-C', f.root, 'add', 'auto-memory/fallback.md']);
  execFileSync('git', ['-C', f.root, 'commit', '-qm', 'add fixture'], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-10T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-10T12:00:00Z' } });
  f.session('before', '2026-09-09', [f.call('OPPORTUNITY ERROR')]);
  f.session('after', '2026-09-11', [f.call('OPPORTUNITY ERROR')]);
  const m = f.run().memories[0];
  assert.equal(m.treatment, '2026-09-10T00:00:00.000Z');
  assert.equal(m.treatmentSource, 'git-first-add-day');
  assert.deepEqual(m.before, { exposed: 1, mistakes: 1 });
  assert.deepEqual(m.after, { exposed: 1, mistakes: 1 });
});

test('unknown treatment isolates an untracked memory and keeps other results', (t) => {
  const f = fixture(t);
  f.memory('untracked', 'UNTRACKED_OPPORTUNITY', 'UNTRACKED_ERROR', 'call', 'missing-origin');
  f.memory('dated', 'DATED_OPPORTUNITY', 'DATED_ERROR');
  f.session('origin', '2026-09-10', []);
  f.session('after', '2026-09-11', [f.call('DATED_OPPORTUNITY DATED_ERROR')]);
  const report = f.run();
  const missing = report.memories.find((m) => m.file.endsWith('untracked.md'));
  assert.equal(missing.result, 'untested');
  assert.equal(missing.reason, 'no-treatment-time');
  assert.equal(missing.treatment, null);
  assert.equal(missing.before, null);
  assert.equal(missing.after, null);
  assert.deepEqual(report.memories.find((m) => m.file.endsWith('dated.md')).after, { exposed: 1, mistakes: 1 });
});

test('origin session teaches the lesson and is excluded from both windows', (t) => {
  const f = fixture(t);
  f.memory('source');
  f.session('before', '2026-09-09', [f.call('OPPORTUNITY ERROR')]);
  f.session('origin', '2026-09-10', [f.call('OPPORTUNITY ERROR')]);
  f.session('after', '2026-09-11', [f.call('OPPORTUNITY')]);
  const m = f.run().memories[0];
  assert.deepEqual(m.before, { exposed: 1, mistakes: 1 });
  assert.deepEqual(m.after, { exposed: 1, mistakes: 0 });
  assert.equal(m.sessions.some((s) => s.id === 'origin'), false);
});

test('transcript and memory search results are quotation, not recurrence', (t) => {
  const f = fixture(t);
  f.memory('search-quote', 'OPPORTUNITY', 'ERROR', 'result');
  f.session('origin', '2026-09-10', []);
  const cases = [
    ['rg-corpus', `rg -n ERROR ${f.corpusDir}`, f.root],
    ['grep-relative', 'grep -n ERROR after.jsonl', path.join(f.corpusDir, 'project')],
    ['select-memory', 'Select-String -Pattern ERROR -Path search-quote.md', f.memoryDir],
  ];
  for (const [id, command, cwd] of cases) f.session(id, '2026-09-11', [f.call(command, id)], {
    cwd,
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'OPPORTUNITY ERROR' }] } }],
  });
  f.session('real', '2026-09-12', [f.call('run', 'real')], {
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'real', content: 'OPPORTUNITY ERROR' }] } }],
  });
  const m = f.run().memories[0];
  assert.deepEqual(m.after, { exposed: 1, mistakes: 1 });
  for (const [id] of cases) assert.equal(m.sessions.some((s) => s.id === id), false);
});

test('a Read of another Markdown document cannot supply result-scope recurrence', (t) => {
  const f = fixture(t);
  f.memory('quoted-spec', 'OPPORTUNITY', 'ERROR', 'result');
  f.session('origin', '2026-09-10', []);
  f.session('spec', '2026-09-11', [{ type: 'tool_use', id: 'read-spec', name: 'Read', input: { file_path: path.join(f.root, 'QUEST-SPEC.md') } }], {
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-spec', content: 'OPPORTUNITY ERROR' }] } }],
  });
  f.session('real', '2026-09-12', [f.call('run', 'real')], {
    extra: [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'real', content: 'OPPORTUNITY ERROR' }] } }],
  });
  const m = f.run().memories[0];
  assert.deepEqual(m.after, { exposed: 1, mistakes: 1 });
  assert.equal(m.sessions.find((s) => s.id === 'spec').delivery, 'unknown');
});

test('a search after an in-command cd excludes the quotation session', (t) => {
  const f = fixture(t);
  f.memory('cd-search', 'OPPORTUNITY', 'ERROR', 'result');
  f.session('origin', '2026-09-10', []);
  f.session('analysis', '2026-09-11', [
    f.call(`cd "${f.corpusDir}" && rg -n ERROR --glob '*.jsonl' .`, 'search'),
    f.call('run', 'other'),
  ], {
    cwd: f.root,
    extra: [{ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'search', content: 'OPPORTUNITY ERROR' },
      { type: 'tool_result', tool_use_id: 'other', content: 'OPPORTUNITY ERROR' },
    ] } }],
  });
  const report = f.run();
  assert.deepEqual(report.memories[0].after, { exposed: 0, mistakes: 0 });
  assert.equal(report.skipped['quotation-search'], 1);
  assert.equal(report.memories[0].sessions.some((s) => s.id === 'analysis'), false);
});

test('verdict boundary and power checks', () => {
  assert.equal(verdict({ exposed: 2, mistakes: 2 }, { exposed: 2, mistakes: 0 }).result, 'untested');
  assert.equal(verdict({ exposed: 10, mistakes: 1 }, { exposed: 3, mistakes: 0 }).result, 'untested');
  assert.equal(verdict({ exposed: 4, mistakes: 2 }, { exposed: 4, mistakes: 1 }).result, 'reduced');
  assert.equal(verdict({ exposed: 4, mistakes: 2 }, { exposed: 4, mistakes: 3 }).result, 'worse');
  assert.equal(verdict({ exposed: 4, mistakes: 2 }, { exposed: 4, mistakes: 2 }).result, 'no-change');
  assert.equal(verdict({ exposed: 5, mistakes: 0 }, { exposed: 10, mistakes: 6 }).result, 'untested');
});

test('skill documents the zero-before-rate power result', () => {
  const skill = fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /A zero before rate has zero expected mistakes and remains\s+`untested` under this power rule\./);
});
