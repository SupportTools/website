// Reads the post fields the share-card pipeline needs and writes the images
// field back. Line-level, like scripts/lib/frontmatter.mjs: only the frontmatter
// block is touched, and body text (which often contains YAML "images:" keys in
// code samples) is never read or edited.
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { unquote, splitInline, parseCategories } from '../../lib/frontmatter.mjs';

export const CDN_BASE = 'https://cdn.support.tools';

function split(text) {
  const t = text.replace(/\r\n/g, '\n');
  const lines = t.split('\n');
  const fence = lines[0].trim();
  if (fence !== '---' && fence !== '+++') return null;
  const end = lines.indexOf(fence, 1);
  if (end === -1) return null;
  return { format: fence === '---' ? 'yaml' : 'toml', lines, end };
}

function scalar(fm, format, key) {
  const re = format === 'yaml' ? new RegExp(`^${key}\\s*:(.*)$`) : new RegExp(`^${key}\\s*=(.*)$`);
  for (const l of fm) {
    const m = l.match(re);
    if (m) return unquote(m[1]);
  }
  return '';
}

export function readPost(path, text = readFileSync(path, 'utf8')) {
  const s = split(text);
  if (!s) return null;
  const fm = s.lines.slice(1, s.end);
  let categories = [];
  if (s.format === 'yaml') categories = parseCategories(text);
  else {
    const m = fm.map((l) => l.match(/^categories\s*=\s*\[(.*)\]\s*$/)).find(Boolean);
    if (m) categories = splitInline(m[1]);
  }
  return {
    path,
    slug: basename(path, '.md'),
    format: s.format,
    title: scalar(fm, s.format, 'title'),
    description: scalar(fm, s.format, 'description'),
    date: scalar(fm, s.format, 'date'),
    draft: scalar(fm, s.format, 'draft') === 'true',
    categories,
    body: s.lines.slice(s.end + 1).join('\n'),
  };
}

export function listPosts(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => readPost(join(dir, f)))
    .filter((p) => p && p.title && !p.draft);
}

// Order in which cards get made: posts publishing in the next `soonDays` days
// first (they feed social), then live posts newest first, then the rest of the
// queue by publish date.
export function prioritize(posts, now = new Date(), soonDays = 14) {
  const t = (p) => Date.parse(p.date) || 0;
  const soon = now.getTime() + soonDays * 86400000;
  const rank = (p) => (t(p) > now.getTime() && t(p) <= soon ? 0 : t(p) <= now.getTime() ? 1 : 2);
  return [...posts].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    return rank(a) === 1 ? t(b) - t(a) : t(a) - t(b);
  });
}

// Article text for the image brief: prose only, code blocks dropped, capped.
export function excerpt(body, max = 2500) {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

// Sets the frontmatter images field to [url], replacing any existing value
// (including a YAML block list), or adding it as the last frontmatter line.
export function setImages(text, url) {
  const s = split(text);
  if (!s) throw new Error('no frontmatter');
  const { lines, end, format } = s;
  const line = format === 'yaml' ? `images: ["${url}"]` : `images = ["${url}"]`;
  const keyRe = format === 'yaml' ? /^images\s*:/ : /^images\s*=/;
  const i = lines.slice(1, end).findIndex((l) => keyRe.test(l)) + 1;
  if (i === 0) {
    lines.splice(end, 0, line);
  } else {
    let j = i + 1;
    if (format === 'yaml') while (j < end && /^\s*-\s/.test(lines[j])) j++;
    lines.splice(i, j - i, line);
  }
  return lines.join('\n');
}

export function cdnKey(slug, hash) {
  return `posts/${slug}/og-${hash}.jpg`;
}
