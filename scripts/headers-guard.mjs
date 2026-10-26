#!/usr/bin/env node
// Guards the Workers static-assets _headers file that ships in blog/public.
//
//   node scripts/headers-guard.mjs production <publicDir>
//     Exit 1 when any X-Robots-Tag noindex rule is site-wide (/* or a whole
//     host) or matches the URL of a built HTML page. Narrow rules for
//     alternates (/*.md, /tags/*/index.xml) pass.
//
//   node scripts/headers-guard.mjs nonprod <publicDir>
//     Append a site-wide noindex rule, keeping every existing rule, so a
//     non-production host is never indexed. Creates _headers if missing.
//
// Pattern matching follows the Cloudflare _headers rules: a single splat (*)
// matches any characters, :name matches one path segment.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const NONPROD_RULE = '/*\n  X-Robots-Tag: noindex\n';
const PROBE_ORIGIN = 'https://support.tools';

export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (line.startsWith('!')) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    current.headers.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return rules;
}

function patternRegex(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') src += '.*';
    else if (ch === ':' && /[A-Za-z]/.test(pattern[i + 1] ?? '')) {
      while (/\w/.test(pattern[i + 1] ?? '')) i++;
      src += '[^/]+';
    } else src += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`);
}

// Absolute patterns (https://host/path) are matched against the production
// origin; relative ones against the path alone.
export function patternMatches(pattern, path) {
  const target = /^https?:\/\//.test(pattern) ? `${PROBE_ORIGIN}${path}` : path;
  return patternRegex(pattern).test(target);
}

const isNoindexRule = (rule) => rule.headers.some((h) => h.name === 'x-robots-tag' && /\b(noindex|none)\b/i.test(h.value));
const isSiteWide = (pattern) => pattern === '*' || /^(https?:\/\/[^/]+)?\/\*$/.test(pattern);

export function productionViolations(text, htmlPaths) {
  const out = [];
  for (const rule of parseHeaders(text).filter(isNoindexRule)) {
    if (isSiteWide(rule.pattern)) {
      out.push(`"${rule.pattern}" is a site-wide noindex rule`);
      continue;
    }
    const hits = htmlPaths.filter((p) => patternMatches(rule.pattern, p));
    if (hits.length) out.push(`"${rule.pattern}" marks HTML pages noindex (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? `, ${hits.length - 3} more` : ''})`);
  }
  return out;
}

export function appendNonProdNoindex(text) {
  if (!text) return NONPROD_RULE;
  return `${text.endsWith('\n') ? text : `${text}\n`}\n${NONPROD_RULE}`;
}

// Each built index.html is requested as /dir/ and as /dir/index.html.
function htmlPathsIn(publicDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) {
        const rel = `/${relative(publicDir, p).split('\\').join('/')}`;
        out.push(rel);
        if (e.name === 'index.html') out.push(rel.slice(0, -'index.html'.length));
      }
    }
  };
  walk(publicDir);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, publicDir] = process.argv.slice(2);
  if (!['production', 'nonprod'].includes(mode) || !publicDir) {
    console.error('usage: headers-guard.mjs production|nonprod <publicDir>');
    process.exit(2);
  }
  const file = join(publicDir, '_headers');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (mode === 'nonprod') {
    writeFileSync(file, appendNonProdNoindex(text));
    console.log(`${file}: appended a site-wide noindex rule after ${parseHeaders(text).length} existing rule(s)`);
  } else {
    const htmlPaths = htmlPathsIn(publicDir);
    const violations = productionViolations(text, htmlPaths);
    if (violations.length) {
      console.error(`${file} would hide production pages from search; refusing to deploy it:`);
      for (const v of violations) console.error(`  ${v}`);
      process.exit(1);
    }
    console.log(`${file}: ${parseHeaders(text).length} rule(s), no noindex rule reaches any of ${htmlPaths.length} HTML paths`);
  }
}
