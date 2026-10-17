// No conduct test may reach the operator's real passkey anchor. Every call
// that can read it (runConduct, recordTouch, acceptAnswer, awaitAnswer) passes
// deps with an explicit readAnchor, checked here per call on its deps argument
// alone: a testDeps( call, an object literal with a readAnchor member, or an
// identifier whose nearest binding in the same file is one of those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
// Each gated call, and the 0-based position of its deps argument.
const GATED = { runConduct: 1, recordTouch: 4, acceptAnswer: 3, awaitAnswer: 1 };
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'else', 'yield', 'await']);

// The source with the contents of strings, template text, comments and regex
// literals blanked (same length, newlines kept), so brackets and names inside
// them are not code. Template expressions stay code.
export function mask(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // Template text from `start` to its closing backtick or its next `${`.
  const template = (start) => {
    let k = start;
    while (k < src.length) {
      if (src[k] === '\\') k += 2;
      else if (src[k] === '`') { blank(start, k); return { end: k + 1, expr: false }; }
      else if (src[k] === '$' && src[k + 1] === '{') { blank(start, k); return { end: k + 2, expr: true }; }
      else k += 1;
    }
    blank(start, k);
    return { end: k, expr: false };
  };
  const braces = [];
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
      blank(i, end);
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2) < 0 ? src.length : src.indexOf('*/', i + 2) + 2;
      blank(i, end);
      i = end;
    } else if (c === '\'' || c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      blank(i + 1, k);
      i = k + 1;
      prev = c;
    } else if (c === '`') {
      const { end, expr } = template(i + 1);
      if (expr) braces.push(0);
      i = end;
      prev = '`';
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(/(\w+)\s*$/.exec(src.slice(Math.max(0, i - 12), i))?.[1]))) {
      let k = i + 1;
      let inClass = false;
      while (k < src.length && src[k] !== '\n') {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        else if (src[k] === '/' && !inClass) break;
        k += 1;
      }
      blank(i + 1, k);
      i = k + 1;
      prev = '/';
    } else {
      if (braces.length && c === '{') braces[braces.length - 1] += 1;
      if (braces.length && c === '}') {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          const { end, expr } = template(i + 1);
          if (expr) braces.push(0);
          i = end;
          prev = '`';
          continue;
        }
        braces[braces.length - 1] -= 1;
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
  }
  return out.join('');
}

// The top-level argument texts of the call whose `(` is at `open`.
function callArgs(src, masked, open) {
  const args = [];
  let from = open + 1;
  let depth = 0;
  for (let i = open + 1; i < masked.length; i += 1) {
    const c = masked[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) {
        const last = src.slice(from, i).trim();
        if (last !== '') args.push(last);
        return args;
      }
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push(src.slice(from, i).trim());
      from = i + 1;
    }
  }
  return args;
}

// Does this masked expression supply a reader: a testDeps( call, or an object
// literal with a top-level readAnchor member (key, shorthand or method)?
function suppliesReader(expr) {
  if (expr.startsWith('testDeps(')) return true;
  return expr.startsWith('{') && callArgs(expr, expr, 0).some((member) => /^(?:async\s+)?readAnchor\s*(?::|\(|$)/.test(member));
}

// The masked expression bound to `name` by its nearest `const|let|var` before `at`, or null.
function binding(masked, name, at) {
  const found = [...masked.slice(0, at).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name.replaceAll('$', '\\$')}\\s*=\\s*`, 'g'))].at(-1);
  return found ? masked.slice(found.index + found[0].length, at) : null;
}

// Every gated call in `src` whose deps argument does not supply readAnchor,
// as "line N: name(...)". Only the deps argument counts, read from the masked
// source (a name in a string or in another argument is no reader); an
// identifier is followed to its nearest binding. `calls` counts the gated calls seen.
export function violations(src) {
  const masked = mask(src);
  const bad = [];
  let calls = 0;
  for (const match of masked.matchAll(/\b(runConduct|recordTouch|acceptAnswer|awaitAnswer)\s*\(/g)) {
    if (/\bfunction\s+$/.test(masked.slice(Math.max(0, match.index - 12), match.index))) continue;
    calls += 1;
    const name = match[1];
    const open = match.index + match[0].length - 1;
    const deps = callArgs(masked, masked, open)[GATED[name]];
    const bound = deps !== undefined && /^[A-Za-z_$][\w$]*$/.test(deps) ? binding(masked, deps, match.index) : null;
    if (deps !== undefined && (suppliesReader(deps) || (bound !== null && suppliesReader(bound)))) continue;
    const text = callArgs(src, masked, open).join(', ');
    const line = src.slice(0, match.index).split('\n').length;
    bad.push(`line ${line}: ${name}(${text.length > 80 ? `${text.slice(0, 80)}…` : text})`);
  }
  return { calls, bad };
}

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
    return entry.name.endsWith('.test.mjs') && path !== SELF ? [path] : [];
  });
}

test('the checker flags a gated call without readAnchor, and passes testDeps(, a readAnchor literal, and a bound identifier', () => {
  // conduct.test.mjs's resume test before this guard: it reached the real anchor.
  assert.equal(violations("await runConduct(['--resume', runDir], { importModule: testLoader, pluginRoot: f.deps.pluginRoot });").bad.length, 1);
  assert.equal(violations('acceptAnswer(touch, answer);').bad.length, 1, 'no deps argument');
  assert.equal(violations('const deps = { exec };\nrecordTouch(s, t, a, r, deps);').bad.length, 1, 'bound without readAnchor');
  assert.equal(violations('recordTouch(s, t, a, r, h.deps);').bad.length, 1, 'a member expression is not checked through');
  // Council round 1 (codex): the name in a string, or in another argument, is not a reader in deps.
  assert.equal(violations('runConduct(argv, { note: "readAnchor" });').bad.length, 1, 'readAnchor in a string');
  assert.equal(violations('runConduct(readAnchor, { exec });').bad.length, 1, 'readAnchor as another argument');
  assert.equal(violations('const deps = { note: \'readAnchor\' };\nrecordTouch(s, t, a, r, deps);').bad.length, 1, 'bound to a literal naming it only in a string');
  assert.equal(violations('acceptAnswer(s, t, { readAnchor }, { exec });').bad.length, 1, 'a reader in the answer argument');
  assert.equal(violations('awaitAnswer(flags, { exec, nested: { readAnchor } });').bad.length, 1, 'a nested key is not a deps member');
  for (const ok of [
    'runConduct(argv, testDeps({ ...base, ...more }));',
    'awaitAnswer(flags, { ...d, readAnchor: () => anchor });',
    'const deps = testDeps({ exec });\nrecordTouch(s, t, a, r, deps);',
    'const deps = { exec, readAnchor };\nacceptAnswer(s, t, a, deps);',
    'recordTouch(s, t, a, r, { exec, readAnchor() { return anchor; } });',
  ]) assert.deepEqual(violations(ok).bad, [], ok);
  const quoted = violations("test('runConduct(x) in a title', () => {}); // recordTouch(a)\nconst re = /awaitAnswer\\(/; const s = `acceptAnswer(${'x'})`;");
  assert.equal(quoted.calls, 0, 'names in strings, comments, regexes and template text are not calls');
});

test('every conduct test passes an explicit readAnchor to each call that can read the operator anchor', () => {
  const files = testFiles(HERE);
  let calls = 0;
  const bad = [];
  for (const file of files) {
    const found = violations(readFileSync(file, 'utf8'));
    calls += found.calls;
    bad.push(...found.bad.map((line) => `${relative(HERE, file).replaceAll('\\', '/')} ${line}`));
  }
  // The scan found the suite: an empty glob would pass vacuously.
  assert.ok(files.length >= 10 && calls >= 40, `${files.length} files, ${calls} gated calls`);
  assert.deepEqual(bad, [], `calls with no explicit readAnchor (use testDeps from ./test-deps.mjs):\n${bad.join('\n')}`);
});
