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
