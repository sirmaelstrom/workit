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

// The body of the first unfenced level-2 or level-3 heading whose text is
// `title` (case ignored), up to the next unfenced heading of any level, as one
// line: blank lines dropped, the rest trimmed and joined with a space. null
// when there is no such heading or its body is empty.
export function sectionText(text, title) {
  const want = String(title).trim().toLowerCase();
  let found = false;
  const body = [];
  for (const line of markLines(text)) {
    const heading = line.fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.text);
    if (!found) {
      found = Boolean(heading && heading[1].length >= 2 && heading[1].length <= 3 && heading[2].toLowerCase() === want);
      continue;
    }
    if (heading) break;
    if (line.text.trim()) body.push(line.text.trim());
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
