// A JSON file read and written back in its own form: a leading BOM and the
// line ending it uses survive the round trip. Indentation is normalized to 2
// spaces, CRLF is chosen when the text holds any CRLF, and one final line
// ending is always written. Pure: callers do their own reads and writes.

const BOM = String.fromCharCode(0xfeff);

// { value, bom, eol } from a file's text. At most one leading BOM is read
// past; a BOM inside a string value is the value's. A parse error propagates.
export function parseJsonKeepingForm(raw) {
  const bom = raw.startsWith(BOM) ? BOM : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { value: JSON.parse(raw.slice(bom.length)), bom, eol };
}

// The text to write for value in the form parseJsonKeepingForm returned.
export function formatJsonKeepingForm(value, { bom = '', eol = '\n' } = {}) {
  return `${bom}${JSON.stringify(value, null, 2).replace(/\n/g, eol)}${eol}`;
}
