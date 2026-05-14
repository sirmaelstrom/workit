import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mdToHtml, escapeHtml } from './markdown-mini.mjs';

// ─── Supported features ────────────────────────────────────────────────────

test('H1 renders', () => {
  assert.match(mdToHtml('# hello'), /<h1>hello<\/h1>/);
});

test('H2 renders', () => {
  assert.match(mdToHtml('## hello'), /<h2>hello<\/h2>/);
});

test('H3 renders', () => {
  assert.match(mdToHtml('### hello'), /<h3>hello<\/h3>/);
});

test('H4 renders', () => {
  assert.match(mdToHtml('#### hello'), /<h4>hello<\/h4>/);
});

test('H5 renders', () => {
  assert.match(mdToHtml('##### hello'), /<h5>hello<\/h5>/);
});

test('H6 renders', () => {
  assert.match(mdToHtml('###### hello'), /<h6>hello<\/h6>/);
});

test('two blank-separated lines produce two <p> elements', () => {
  const html = mdToHtml('foo\n\nbar');
  const pCount = (html.match(/<p>/g) || []).length;
  assert.equal(pCount, 2, 'expected exactly two <p> elements');
  assert.match(html, /<p>foo<\/p>/);
  assert.match(html, /<p>bar<\/p>/);
});

test('unordered list produces one <ul> with three <li> children', () => {
  const html = mdToHtml('- a\n- b\n- c');
  const ulCount = (html.match(/<ul>/g) || []).length;
  assert.equal(ulCount, 1, 'expected exactly one <ul>');
  const liCount = (html.match(/<li>/g) || []).length;
  assert.equal(liCount, 3, 'expected exactly three <li>');
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><li>c<\/li><\/ul>/);
});

test('ordered list produces one <ol> with two <li> children', () => {
  const html = mdToHtml('1. a\n2. b');
  const olCount = (html.match(/<ol>/g) || []).length;
  assert.equal(olCount, 1, 'expected exactly one <ol>');
  const liCount = (html.match(/<li>/g) || []).length;
  assert.equal(liCount, 2, 'expected exactly two <li>');
  assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
});

test('bold renders as <strong>', () => {
  assert.match(mdToHtml('**bold**'), /<strong>bold<\/strong>/);
});

test('italic renders as <em>', () => {
  assert.match(mdToHtml('*italic*'), /<em>italic<\/em>/);
});

test('inline code renders as <code>', () => {
  assert.match(mdToHtml('`code`'), /<code>code<\/code>/);
});

test('fenced code block with < inside renders escaped pre/code', () => {
  const html = mdToHtml('```\n<\n```');
  assert.match(html, /<pre><code>&lt;\n?<\/code><\/pre>/);
});

test('link renders as <a>', () => {
  const html = mdToHtml('[link](https://example.com)');
  assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
});

// ─── Escaping ──────────────────────────────────────────────────────────────

test('plain text XSS is HTML-escaped', () => {
  const html = mdToHtml('<script>alert(1)</script>');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('escapeHtml escapes all five special characters', () => {
  assert.equal(escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});

test('URL with double-quote is attribute-escaped', () => {
  const html = mdToHtml('[x](a"b)');
  assert.match(html, /<a href="a&quot;b">x<\/a>/);
});

test('ampersand inside fenced code block is escaped', () => {
  const html = mdToHtml('```\n&\n```');
  assert.match(html, /<pre><code>&amp;\n?<\/code><\/pre>/);
});

test('inline code contents are not further parsed for markdown', () => {
  const html = mdToHtml('`**bold**`');
  // Should render as <code>**bold**</code>, not <code><strong>bold</strong></code>
  assert.match(html, /<code>\*\*bold\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('fenced code block contents are not inline-parsed', () => {
  const html = mdToHtml('```\n**not bold**\n```');
  assert.match(html, /\*\*not bold\*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

// ─── Fallback / P3 ─────────────────────────────────────────────────────────

test('markdown table does not produce a <table> element', () => {
  const input = '| a | b |\n| - | - |\n| 1 | 2 |';
  const html = mdToHtml(input);
  assert.doesNotMatch(html, /<table/i, 'table syntax must not render as <table>');
  // Each line should appear as escaped text (pipes should be present)
  assert.match(html, /\|/);
});

test('nested list emits exactly one <ul>, not two', () => {
  const input = '- a\n  - b';
  const html = mdToHtml(input);
  const ulCount = (html.match(/<ul>/g) || []).length;
  assert.equal(ulCount, 1, 'nested list must not produce a second <ul>');
  // The outer list item should contain the top-level item
  assert.match(html, /<ul>/);
});

test('raw HTML input is escaped, no <div> in output', () => {
  const html = mdToHtml('<div>x</div>');
  assert.doesNotMatch(html, /<div>/i, 'raw HTML must be escaped, not rendered');
  assert.match(html, /&lt;div&gt;/);
});

test('setext-style heading falls through as paragraph', () => {
  const html = mdToHtml('Heading\n=======');
  assert.doesNotMatch(html, /<h1>/);
  assert.match(html, /<p>/);
});

test('blockquote falls through as paragraph', () => {
  const html = mdToHtml('> a quote');
  // Blockquotes are not recognized — emitted as plain text in a <p>
  assert.doesNotMatch(html, /<blockquote/i);
  assert.match(html, /<p>/);
});

test('horizontal rule falls through as paragraph', () => {
  const html = mdToHtml('---');
  assert.doesNotMatch(html, /<hr/i);
  assert.match(html, /<p>/);
});

// ─── No external dependencies ───────────────────────────────────────────────

test('no external deps', () => {
  const src = readFileSync(new URL('./markdown-mini.mjs', import.meta.url), 'utf8');
  const imports = src.match(/^import .+ from ['"](.+)['"];?\s*$/gm) || [];
  for (const imp of imports) {
    assert.match(imp, /from ['"]node:/, `all imports must be from node: built-ins, got: ${imp}`);
  }
});
