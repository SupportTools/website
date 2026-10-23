// Link rules for social posts that promote support.tools articles.
//
// The page path is the frontmatter `url:` when set; a post without one is built
// at /post/<file name>/. On 2026-10-22 a post went out linking /<slug>/ for an
// article that only exists under /post/, so every check here works from the
// content files, not from what a link is assumed to look like.
import fs from 'node:fs';
import path from 'node:path';

const SITE = 'support.tools';

// Production rebuilds (.github/workflows/cloudflare-workers.yml), UTC hour/minute,
// and how long a build takes to go live.
const REBUILDS = [[6, 0], [14, 10], [15, 10]];
const DEPLOY_MINUTES = 15;

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const field = (name) => {
    const f = m[1].match(new RegExp(`^${name}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
    return f ? f[1].trim() : undefined;
  };
  const out = {};
  const url = field('url');
  if (url) out.url = url;
  const date = field('date');
  if (date) out.date = date;
  out.draft = field('draft') === 'true';
  return out;
}

// The URL path Hugo builds for a content file (relative to blog/content), or null
// when this module does not know (non-post sections without a url:).
export function pagePathFor(rel, fm) {
  if (fm.url) return `/${fm.url.replace(/^\/+|\/+$/g, '')}/`;
  const m = rel.match(/^post\/([^/]+)\.md$/);
  return m ? `/post/${m[1]}/` : null;
}

// path -> { file, date, draft } for every content file with a known path.
export function loadPages(contentRoot) {
  const pages = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const fm = parseFrontmatter(fs.readFileSync(full, 'utf8'));
        if (!fm) continue;
        const rel = path.relative(contentRoot, full).split(path.sep).join('/');
        const p = pagePathFor(rel, fm);
        if (p) pages.set(p, { file: rel, date: fm.date, draft: fm.draft });
      }
    }
  };
  walk(contentRoot);
  return pages;
}

// When an article dated `date` is first live: the next production rebuild at or
// after that time, plus the deploy time.
export function liveAt(date) {
  const t = new Date(date);
  for (let day = 0; day < 3; day++) {
    for (const [h, m] of REBUILDS) {
      const c = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + day, h, m));
      if (c >= t) return new Date(c.getTime() + DEPLOY_MINUTES * 60_000);
    }
  }
  return null;
}

export function expectedUtmSource(channelService) {
  return channelService;
}

// Problems with a post's link that can be found without the network. post is
// { channelService, dueAt, link }; pages comes from loadPages.
export function linkProblems(post, pages) {
  if (!post.link) return ['no link to support.tools'];
  let u;
  try {
    u = new URL(post.link);
  } catch {
    return [`link is not a URL: ${post.link}`];
  }
  if (u.hostname !== SITE) return [`not a support.tools link: ${post.link}`];
  const problems = [];
  const want = expectedUtmSource(post.channelService);
  const utm = u.searchParams.get('utm_source');
  if (!utm) problems.push(`link has no utm_source (want utm_source=${want})`);
  else if (utm !== want) problems.push(`link has utm_source=${utm}, want ${want}`);

  const p = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  const page = pages.get(p);
  if (!page) {
    const slug = p.replace(/^\/+|\/+$/g, '');
    const alt = pages.has(`/post/${slug}/`) ? `; the article is at /post/${slug}/` : '';
    problems.push(`no page at ${p}${alt}`);
    return problems;
  }
  if (page.draft) problems.push(`${page.file} is a draft`);
  if (page.date && post.dueAt) {
    const live = liveAt(page.date);
    if (live && live > new Date(post.dueAt)) {
      problems.push(`article is not live until ${live.toISOString().slice(0, 16)}Z but the post goes out ${post.dueAt}`);
    }
  }
  return problems;
}
