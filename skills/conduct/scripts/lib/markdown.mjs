// Every line, with fenced lines marked. A fence closes only on the character
// that opened it, at least as long, with nothing after it (CommonMark).
export function markLines(text) {
  let fence = null;
  return String(text ?? '').split(/\r?\n/).map((raw) => {
    // Any indent, as in lane.mjs: a report nests its fenced runs inside list items.
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    let fenced = fence !== null;
    if (marker && fence === null) {
      fence = marker[1];
      fenced = true;
    } else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') {
      fence = null;
      fenced = true;
    }
    return { text: raw.replace(/\s+$/, ''), fenced };
  });
}

// CommonMark block shapes sectionText needs: an ATX heading (up to three
// spaces of indent, optional closing #s), a setext underline, a thematic
// break and a fence marker.
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
// Lines that are not paragraph text: a list item, a block quote, indented code.
const NOT_PARAGRAPH = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}>| {4}|\t)/;
const BOM = String.fromCharCode(0xfeff);

const isParagraph = (line) => Boolean(line && !line.fenced && line.text.trim() && !ATX.test(line.text) && !NOT_PARAGRAPH.test(line.text));

// The body of the first level-2 or level-3 heading (ATX `##`/`###`, or a
// setext `---` underline) whose text is `title` (case ignored), as one line:
// blank lines and fence markers dropped, the rest trimmed and joined with a
// space. The body ends at the next heading of any level (ATX or setext) or at
// a thematic break. Headings inside fences are text. A setext underline counts
// only under paragraph text (after a list item it is a thematic break), and the
// whole paragraph above it is the heading's text, not body. null when there is
// no such heading or its body is empty.
export function sectionText(text, title) {
  const want = String(title).trim().toLowerCase();
  const source = String(text ?? '');
  const lines = markLines(source.startsWith(BOM) ? source.slice(1) : source);
  const matches = (heading) => String(heading ?? '').trim().toLowerCase() === want;
  let found = false;
  const body = [];
  // Where the paragraph that runs into the current line starts in body.
  let paragraphStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const prev = lines[i - 1];
    const atx = line.fenced ? null : ATX.exec(line.text);
    const setext = !line.fenced && isParagraph(prev) ? SETEXT.exec(line.text) : null;
    if (!found) {
      found = Boolean((atx && atx[1].length >= 2 && atx[1].length <= 3 && matches(atx[2]))
        || (setext && setext[1][0] === '-' && matches(prev.text) && !isParagraph(lines[i - 2])));
      continue;
    }
    if (setext) {
      body.length = paragraphStart;
      break;
    }
    if (atx || (!line.fenced && BREAK.test(line.text))) break;
    if (line.fenced && FENCE.test(line.text)) {
      paragraphStart = body.length;
      continue;
    }
    if (!line.text.trim()) {
      paragraphStart = body.length;
      continue;
    }
    body.push(line.text.trim());
    if (!isParagraph(line)) paragraphStart = body.length;
  }
  return body.length ? body.join(' ') : null;
}

// The report's `## Amendment N` sections in order: { n, lines }, where lines
// are every line after the heading up to the next unfenced level-1/2 heading.
export function amendmentSections(text) {
  const sections = [];
  let current = null;
  for (const line of markLines(text)) {
    if (!line.fenced && /^#{1,2}\s/.test(line.text)) {
      const n = Number(/^## Amendment (\d+)\b/.exec(line.text)?.[1] ?? NaN);
      current = Number.isInteger(n) ? { n, lines: [] } : null;
      if (current) sections.push(current);
    } else current?.lines.push(line);
  }
  return sections;
}
