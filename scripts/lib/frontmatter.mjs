// Shared YAML frontmatter helpers for the category scripts. Hand-rolled, line-level
// readers: they understand only the list shapes the content uses.

export function unquote(s) {
  const t = s.trim();
  const m = t.match(/^"((?:[^"\\]|\\.)*)"$/) || t.match(/^'((?:[^']|'')*)'$/);
  if (m) return t[0] === '"' ? m[1].replace(/\\(.)/g, '$1') : m[1].replace(/''/g, "'");
  return t.replace(/\s+#.*$/, '').trim();
}

export function splitInline(body) {
  const items = [];
  let cur = '';
  let quote = null;
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  return items.map(unquote).filter(Boolean);
}

export function parseCategories(text) {
  return parseFrontmatter(text).categories;
}

// Returns the parsed categories plus hard errors for frontmatter shapes this
// checker cannot read, so such posts fail instead of going unchecked.
export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() === '+++') {
    const close = lines.indexOf('+++', 1);
    const toml = lines.slice(1, close === -1 ? lines.length : close);
    if (toml.some((l) => /^\s*categories\s*=/.test(l))) {
      return { categories: [], errors: ['TOML (+++) frontmatter with categories is not supported; use YAML (---) frontmatter'] };
    }
    return { categories: [], errors: [] };
  }
  if (lines[0].trim() !== '---') return { categories: [], errors: [] };
  const end = lines.indexOf('---', 1);
  const fm = lines.slice(1, end === -1 ? lines.length : end);
  const i = fm.findIndex((l) => /^categories\s*:/.test(l));
  if (i === -1) return { categories: [], errors: [] };
  const rest = fm[i].replace(/^categories\s*:/, '').trim();
  if (rest.startsWith('[')) {
    const close = rest.lastIndexOf(']');
    if (close === -1) {
      return { categories: [], errors: ['multi-line "categories: [" list is not supported; put the list on one line or use a block list'] };
    }
    return { categories: splitInline(rest.slice(1, close)), errors: [] };
  }
  if (rest && !rest.startsWith('#')) return { categories: [unquote(rest)].filter(Boolean), errors: [] };
  const items = [];
  for (const l of fm.slice(i + 1)) {
    const m = l.match(/^\s*-\s+(.*)$/);
    if (m) items.push(unquote(m[1]));
    else if (l.trim() !== '' && !/^\s*#/.test(l)) break;
  }
  return { categories: items.filter(Boolean), errors: [] };
}
