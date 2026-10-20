// Shared Markdown heading extraction. Skips frontmatter (YAML '---' or TOML
// '+++') and fenced code blocks, using the same fence rules as
// scripts/demote-headings.mjs.
const HEADING = /^(#{1,6})[ \t]+\S/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function extractHeadings(text) {
  const lines = text.split('\n');
  let i = 0;
  const delim = lines[0] && lines[0].trimEnd();
  if (delim === '---' || delim === '+++') {
    i = 1;
    while (i < lines.length && lines[i].trimEnd() !== delim) i++;
    i++;
  }
  const headings = [];
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const m = HEADING.exec(line);
    if (m) headings.push({ level: m[1].length, line: i + 1, text: line.slice(m[1].length).trim() });
  }
  return headings;
}
