// markdown-mini.mjs — bounded markdown→HTML converter (P3 fallback, MN2/MN3)
// Supported: H1–H6, paragraphs, ul, ol, **bold**, *italic*, `code`, fenced blocks, links.

/** Escape HTML special characters for text content. */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for HTML attribute values (href). */
function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Process inline markdown (code→links→bold→italic) via sentinel placeholders. */
function processInline(text) {
  const slots = [];

  // Step 1: extract inline code spans → replace with sentinel
  text = text.replace(/`([^`]+)`/g, (_, inner) => {
    slots.push(`<code>${escapeHtml(inner)}</code>`);
    return `\x00${slots.length - 1}\x00`;
  });

  // Step 2: extract links → replace with sentinel
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, linkText, url) => {
    slots.push(`<a href="${escapeAttr(url)}">${escapeHtml(linkText)}</a>`);
    return `\x00${slots.length - 1}\x00`;
  });

  // Step 3: escape remaining plain text (outside sentinels)
  text = text.replace(/(\x00\d+\x00)|([^\x00]+)/g, (_, sentinel, plain) => {
    if (sentinel) return sentinel;
    return escapeHtml(plain);
  });

  // Step 4: apply bold and italic on escaped text (safe — no raw HTML in plain)
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Step 5: re-inject rendered sentinels
  text = text.replace(/\x00(\d+)\x00/g, (_, i) => slots[Number(i)]);

  return text;
}

/** Convert a markdown string to an HTML string. */
export function mdToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const fence = line.match(/^(`+)/)[1];
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // consume closing fence
      out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    // ATX headings (H1–H6)
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${processInline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list block
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        const itemContent = lines[i].slice(2);
        items.push(`<li>${processInline(itemContent)}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list block
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        const itemContent = lines[i].replace(/^\d+\. /, '');
        items.push(`<li>${processInline(itemContent)}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blank line — paragraph separator, skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-special lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^- /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i]) &&
      !/^```/.test(lines[i])
    ) {
      paraLines.push(processInline(lines[i]));
      i++;
    }
    if (paraLines.length > 0) {
      out.push(`<p>${paraLines.join('<br>')}</p>`);
    }
  }

  return out.join('\n');
}
