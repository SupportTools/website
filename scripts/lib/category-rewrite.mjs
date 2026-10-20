// Pure logic for scripts/rewrite-categories.mjs: parse the category map and
// rewrite one post's frontmatter with line-level edits. Nothing outside the
// categories and tags keys is touched, and the result is idempotent.
import { unquote } from './frontmatter.mjs';

const normalizeKey = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');

// ---------------------------------------------------------------- map file

// Map file sections (see blog/data/category-map.yaml):
//   merge:   "Source": "Target"
//   demote:  "Source": "Fallback Category"   (or null for no fallback)
//   hubs:    "Hub":  followed by indented "- Category" lines
export function parseMap(text) {
  const map = { merge: new Map(), demote: new Map(), hubs: new Map() };
  let section = null;
  let hub = null;
  const errors = [];
  text.split('\n').forEach((raw, n) => {
    const line = raw.replace(/\s+#.*$/, '').replace(/\r$/, '');
    if (!line.trim() || /^\s*#/.test(raw)) return;
    const top = line.match(/^([a-z]+):\s*$/);
    if (top) {
      section = top[1];
      hub = null;
      if (!(section in map)) errors.push(`line ${n + 1}: unknown section "${section}"`);
      return;
    }
    if (section === 'hubs') {
      const h = line.match(/^\s+("(?:[^"\\]|\\.)*"):\s*$/);
      const item = line.match(/^\s+-\s+(.*)$/);
      if (h) {
        hub = unquote(h[1]);
        map.hubs.set(hub, []);
      } else if (item && hub !== null) map.hubs.get(hub).push(unquote(item[1]));
      else errors.push(`line ${n + 1}: cannot parse hub entry: ${line.trim()}`);
      return;
    }
    const kv = line.match(/^\s+("(?:[^"\\]|\\.)*"):\s*(null|~|"(?:[^"\\]|\\.)*")\s*$/);
    if (!kv || (section !== 'merge' && section !== 'demote')) {
      errors.push(`line ${n + 1}: cannot parse entry: ${line.trim()}`);
      return;
    }
    const src = unquote(kv[1]);
    const val = kv[2] === 'null' || kv[2] === '~' ? null : unquote(kv[2]);
    if (map[section].has(src) || (section === 'merge' ? map.demote : map.merge).has(src)) {
      errors.push(`line ${n + 1}: "${src}" is mapped more than once`);
      return;
    }
    if (section === 'merge' && val === null) {
      errors.push(`line ${n + 1}: merge "${src}" needs a target`);
      return;
    }
    map[section].set(src, val);
  });
  if (errors.length) throw new Error(`category map: ${errors.join('; ')}`);
  return map;
}

// Targets must be final names: a chain (A -> B -> C) would make a second run
// change files again.
export function validateMap(map) {
  const errors = [];
  const sources = new Set([...map.merge.keys(), ...map.demote.keys()]);
  for (const [s, t] of map.merge) {
    if (s === t) errors.push(`merge "${s}" maps to itself`);
    if (sources.has(t)) errors.push(`merge target "${t}" (from "${s}") is itself mapped; point at the final name`);
  }
  for (const [s, f] of map.demote) {
    if (f !== null && sources.has(f)) errors.push(`demote fallback "${f}" (from "${s}") is itself mapped`);
    if (/[/&]/.test(s)) errors.push(`demote "${s}" would become a tag containing "/" or "&"; merge it instead`);
  }
  return errors;
}

// ---------------------------------------------------------------- semantics

// Maps one post's category list. Returns the new list, the labels demoted to
// tags, and problems (a post left with no category).
export function mapCategories(cats, map) {
  const out = new Map();
  const tags = [];
  let fallback = null;
  let firstDemoted = null;
  for (const c of cats) {
    const target = map.merge.get(c) ?? (map.demote.has(c) ? null : c);
    if (target !== null) {
      if (!out.has(target)) out.set(target, c);
    } else {
      tags.push(c);
      firstDemoted ??= c;
      if (fallback === null) fallback = map.demote.get(c);
    }
  }
  let categories = [...out.keys()];
  let sources = [...out.values()];
  const problems = [];
  let usedFallback = false;
  if (categories.length === 0 && cats.length > 0) {
    if (fallback) {
      categories = [fallback];
      sources = [firstDemoted];
      usedFallback = true;
    }
    else problems.push(`no category left after demoting ${cats.map((c) => `"${c}"`).join(', ')}`);
  }
  return { categories, tags: [...new Set(tags)], problems, usedFallback, sources };
}

// ---------------------------------------------------------------- line level

const stripCR = (l) => l.replace(/\r$/, '');

function splitRaw(body) {
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
  return items.map((t) => t.trim()).filter(Boolean);
}

function frontmatterBounds(lines) {
  if (stripCR(lines[0]).trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && stripCR(l).trim() === '---');
  return { start: 1, end: end === -1 ? lines.length : end };
}

// Locates `key:` in the frontmatter and describes its list value.
function findList(lines, key) {
  const b = frontmatterBounds(lines);
  if (!b) return null;
  const re = new RegExp(`^${key}\\s*:`);
  let i = -1;
  for (let n = b.start; n < b.end; n++) if (re.test(lines[n])) { i = n; break; }
  if (i === -1) return { missing: true, bounds: b };
  const rest = stripCR(lines[i]).replace(re, '').trim();
  if (rest.startsWith('[')) {
    const close = rest.lastIndexOf(']');
    if (close === -1) return { unsupported: 'multi-line flow list', line: i, bounds: b };
    const tokens = splitRaw(rest.slice(1, close));
    return { form: 'inline', line: i, tokens, values: tokens.map(unquote).filter(Boolean), bounds: b };
  }
  if (rest && !rest.startsWith('#')) {
    return { form: 'scalar', line: i, tokens: [rest], values: [unquote(rest)].filter(Boolean), bounds: b };
  }
  const slots = [];
  let last = i;
  for (let n = i + 1; n < b.end; n++) {
    const m = stripCR(lines[n]).match(/^(\s*-\s+)(.*)$/);
    if (m) {
      slots.push({ line: n, lead: m[1], raw: m[2].trim(), value: unquote(m[2]) });
      last = n;
    } else if (stripCR(lines[n]).trim() !== '' && !/^\s*#/.test(lines[n])) break;
  }
  return { form: 'block', line: i, slots, last, values: slots.map((s) => s.value).filter(Boolean), bounds: b };
}

function needsQuotes(v) {
  return !/^[A-Za-z0-9][\w .+()/-]*$/.test(v) || /:\s|\s#|:$/.test(v);
}

function fmt(v, quote) {
  const q = needsQuotes(v) && !quote ? '"' : quote;
  if (!q) return v;
  return q === '"' ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `'${v.replace(/'/g, "''")}'`;
}

const quoteOf = (raw) => (raw && (raw[0] === '"' || raw[0] === "'") ? raw[0] : '');

// Replaces the list's contents with `values` (same length or shorter for
// categories; tags use appendTags). Reuses original raw tokens where kept.
function setCategories(lines, key, values, sources) {
  const d = findList(lines, key);
  const eol = lines[d.line].endsWith('\r') ? '\r' : '';
  if (d.form === 'inline') {
    const raw = new Map(d.tokens.map((t) => [unquote(t), t]));
    const body = values.map((v, k) => raw.get(v) ?? fmt(v, quoteOf(raw.get(sources[k])))).join(', ');
    const line = stripCR(lines[d.line]);
    lines[d.line] = line.slice(0, line.indexOf('[') + 1) + body + line.slice(line.lastIndexOf(']')) + eol;
  } else if (d.form === 'scalar') {
    const line = stripCR(lines[d.line]);
    lines[d.line] = line.slice(0, line.indexOf(':') + 1) + ' ' + fmt(values[0], quoteOf(d.tokens[0])) + eol;
  } else {
    const raw = new Map(d.slots.map((s) => [s.value, s.raw]));
    const lead = d.slots[0]?.lead ?? '- ';
    const drop = [];
    d.slots.forEach((s, k) => {
      if (k < values.length) lines[s.line] = lead + (raw.get(values[k]) ?? fmt(values[k], quoteOf(raw.get(sources[k])))) + eol;
      else drop.push(s.line);
    });
    for (const n of drop.reverse()) lines.splice(n, 1);
  }
}

function addTags(lines, tags, afterCategories) {
  const d = findList(lines, 'tags');
  const eol = lines[afterCategories.line].endsWith('\r') ? '\r' : '';
  if (d.missing) {
    const c = afterCategories;
    if (c.form === 'block') {
      const q = quoteOf(c.slots[0]?.raw);
      const lead = c.slots[0]?.lead ?? '- ';
      lines.splice(c.last + 1, 0, 'tags:' + eol, ...tags.map((t) => lead + fmt(t, q) + eol));
    } else {
      const q = quoteOf(c.tokens[0]) || '"';
      lines.splice(c.line + 1, 0, `tags: [${tags.map((t) => fmt(t, q)).join(', ')}]` + eol);
    }
    return;
  }
  if (d.unsupported) return;
  const present = new Set(d.values.map(normalizeKey));
  const fresh = tags.filter((t) => !present.has(normalizeKey(t)));
  if (!fresh.length) return;
  if (d.form === 'inline') {
    const q = quoteOf(d.tokens[0]) || '"';
    const line = stripCR(lines[d.line]);
    const close = line.lastIndexOf(']');
    const sep = d.tokens.length ? ', ' : '';
    lines[d.line] = line.slice(0, close).replace(/\s+$/, '') + sep + fresh.map((t) => fmt(t, q)).join(', ') + line.slice(close) + eol;
  } else if (d.form === 'scalar') {
    const line = stripCR(lines[d.line]);
    const q = quoteOf(d.tokens[0]) || '"';
    lines[d.line] = line.slice(0, line.indexOf(':') + 1) + ` [${[d.tokens[0], ...fresh.map((t) => fmt(t, q))].join(', ')}]` + eol;
  } else {
    const q = quoteOf(d.slots[0]?.raw);
    const lead = d.slots[0]?.lead ?? '- ';
    lines.splice(d.last + 1, 0, ...fresh.map((t) => lead + fmt(t, q) + eol));
  }
}

// Rewrites one post. Returns {text, changed, before, after, tags, problems}.
export function rewriteText(text, map) {
  const lines = text.split('\n');
  const res = { text, changed: false, before: [], after: [], tags: [], problems: [], usedFallback: false };
  const cat = findList(lines, 'categories');
  if (!cat || cat.missing) return res;
  if (cat.unsupported) {
    res.problems.push(`unsupported categories shape: ${cat.unsupported}`);
    return res;
  }
  res.before = cat.values;
  const m = mapCategories(cat.values, map);
  res.after = m.categories;
  res.problems = m.problems;
  res.usedFallback = m.usedFallback;
  if (m.problems.length) return res;
  if (m.categories.join('\n') !== cat.values.join('\n')) setCategories(lines, 'categories', m.categories, m.sources);
  if (m.tags.length) {
    const tagList = findList(lines, 'tags');
    if (tagList?.unsupported) {
      res.problems.push(`unsupported tags shape: ${tagList.unsupported}; cannot add demoted ${m.tags.map((t) => `"${t}"`).join(', ')}`);
      res.text = text;
      return res;
    }
    const prior = new Set((findList(lines, 'tags')?.values ?? []).map(normalizeKey));
    res.tags = m.tags.filter((t) => !prior.has(normalizeKey(t)));
    addTags(lines, m.tags, findList(lines, 'categories'));
  }
  res.text = lines.join('\n');
  res.changed = res.text !== text;
  return res;
}
