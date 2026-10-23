#!/usr/bin/env node
// Guard against breaking links to published pages.
//
// tests/fixtures/published-urls.txt lists every page URL support.tools has
// published. Each URL must keep working: either the build still has the page,
// or the production Worker (src/worker.js, run here against the built files)
// redirects it to a page the build has.
//
//   node scripts/check-published-urls.mjs [blog/public]           check (CI)
//   node scripts/check-published-urls.mjs --update [blog/public]  add newly built URLs
//
// --update only ever adds. Removing or renaming a page fails the check until a
// redirect covers the old URL. Paginated pages (/page/N/) are left out: their
// count changes as posts are added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = path.join(ROOT, 'tests/fixtures/published-urls.txt');
const ORIGIN = 'https://support.tools';
const MAX_HOPS = 3;

// Every built HTML page as a URL path ending in "/", without pagination.
export function builtPaths(publicDir) {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name === 'index.html') {
        const rel = path.relative(publicDir, dir).split(path.sep).join('/');
        const p = rel ? `/${rel}/` : '/';
        if (!/\/page\/\d+\/$/.test(p)) out.add(p);
      }
    }
  };
  walk(publicDir);
  return out;
}

// The Worker's ASSETS binding, served from the built files.
function assetsFrom(publicDir) {
  return {
    fetch: async (req) => {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const file = p.endsWith('/') ? path.join(publicDir, p, 'index.html') : path.join(publicDir, p);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    },
  };
}

// Baseline paths that neither the build nor a Worker redirect resolves:
// [{ path, why }].
export async function unresolved(paths, publicDir) {
  const built = builtPaths(publicDir);
  const env = { ASSETS: assetsFrom(publicDir) };
  const bad = [];
  const log = console.log;
  console.log = () => {}; // the Worker logs every request
  try {
    for (const start of paths) {
      if (built.has(start)) continue;
      let p = start;
      let why = '';
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const res = await worker.fetch(new Request(ORIGIN + p), env);
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          const next = new URL(loc, ORIGIN);
          if (next.origin !== ORIGIN) { why = `redirects off-site to ${next.href}`; break; }
          why = `redirects to ${next.pathname}`;
          p = next.pathname;
          continue;
        }
        if (res.status === 200 && p !== start) why = '';
        else why = why ? `${why} which returns ${res.status}` : `returns ${res.status}`;
        break;
      }
      if (why) bad.push({ path: start, why });
    }
  } finally {
    console.log = log;
  }
  return bad;
}

export function mergeBaseline(existing, built) {
  return [...new Set([...existing, ...built])].sort();
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return [];
  return fs.readFileSync(BASELINE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const publicDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'blog/public'));
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    console.error(`no built site at ${publicDir}; run npm run build:hugo first`);
    process.exit(1);
  }
  const baseline = readBaseline();
  const bad = await unresolved(baseline, publicDir);
  for (const b of bad) console.log(`BROKEN ${b.path}: ${b.why}`);
  if (bad.length) {
    console.log(`${bad.length} published URL(s) no longer resolve. Restore the page, or add a redirect`
      + ' (Hugo `aliases:` in the post, or a rule in src/worker.js) that sends the old URL to the new one.');
    process.exit(1);
  }
  if (update) {
    const merged = mergeBaseline(baseline, builtPaths(publicDir));
    const header = '# Every page URL support.tools has published (scripts/check-published-urls.mjs).\n'
      + '# Generated: add with --update, never remove by hand. A URL here must keep resolving.\n';
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${header}${merged.join('\n')}\n`);
    console.log(`baseline: ${merged.length} URLs (${merged.length - baseline.length} new)`);
  } else {
    console.log(`all ${baseline.length} published URLs resolve`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
