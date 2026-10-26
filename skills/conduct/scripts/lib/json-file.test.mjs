import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJsonKeepingForm, parseJsonKeepingForm } from './json-file.mjs';

const BOM = String.fromCharCode(0xfeff);
const VALUE = { env: { FOO: 'bar' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } };

test('json-file round trip: {BOM, no BOM} x {CRLF, LF} parses to the value and writes back the same bytes', () => {
  for (const bom of [BOM, '']) {
    for (const eol of ['\r\n', '\n']) {
      const raw = `${bom}${JSON.stringify(VALUE, null, 2).replace(/\n/g, eol)}${eol}`;
      const parsed = parseJsonKeepingForm(raw);
      assert.deepEqual(parsed, { value: VALUE, bom, eol }, JSON.stringify({ bom, eol }));
      assert.equal(formatJsonKeepingForm(parsed.value, parsed), raw, JSON.stringify({ bom, eol }));
    }
  }
});

test('json-file: two leading BOMs: only one is stripped, so the parse fails', () => {
  assert.throws(() => parseJsonKeepingForm(`${BOM}${BOM}{}`), SyntaxError);
});

test('json-file: a U+FEFF inside a string value survives the round trip', () => {
  const value = { name: `a${BOM}b`, lead: `${BOM}x` };
  const raw = formatJsonKeepingForm(value, { bom: BOM, eol: '\r\n' });
  assert.deepEqual(parseJsonKeepingForm(raw).value, value);
  assert.equal(raw.split(BOM).length - 1, 3, 'the leading BOM and the two inside values');
});

test('json-file: the output ends with exactly one eol, and the default form is LF with no BOM', () => {
  const crlf = formatJsonKeepingForm({ a: 1 }, { eol: '\r\n' });
  assert.ok(crlf.endsWith('}\r\n') && !crlf.endsWith('\r\n\r\n'));
  const lf = formatJsonKeepingForm({ a: 1 });
  assert.equal(lf, '{\n  "a": 1\n}\n');
  assert.equal(parseJsonKeepingForm('{"a":1}').eol, '\n');
  assert.equal(parseJsonKeepingForm('{"a":1}\n\r\n').eol, '\r\n', 'any CRLF picks CRLF');
});
