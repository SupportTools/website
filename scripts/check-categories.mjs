#!/usr/bin/env node
// Category allow-list guardrail for blog/content. Every category on every post
// (including future-dated ones) must appear in blog/data/categories.yaml, a post
// may carry at most 4, and names containing "/" or "&" are only accepted when
// the allow-list names them explicitly. Case and hyphen/space variants of an
// allowed name are rejected with a pointer to the canonical spelling.
// Usage: node scripts/check-categories.mjs [--write-allowlist]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unquote, parseCategories, parseFrontmatter } from './lib/frontmatter.mjs';

export { parseCategories, parseFrontmatter };

const CONTENT_DIR = 'blog/content';
const ALLOWLIST_PATH = 'blog/data/categories.yaml';
const MAX_CATEGORIES = 4;

export function parseAllowlist(text) {
  return text
    .split('\n')
    .map((l) => l.match(/^\s*-\s+(.*)$/))
    .filter(Boolean)
    .map((m) => unquote(m[1]));
}

export function normalizeKey(name) {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

function yamlQuote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function checkPost(categories, allowlist) {
  const allowed = new Set(allowlist);
  const byKey = new Map();
  for (const a of allowlist) if (!byKey.has(normalizeKey(a))) byKey.set(normalizeKey(a), a);
  const violations = [];
  if (categories.length > MAX_CATEGORIES) {
    violations.push(`${categories.length} categories (max ${MAX_CATEGORIES}): ${categories.join(', ')}`);
  }
  for (const c of categories) {
    if (allowed.has(c)) continue;
    if (/[/&]/.test(c)) {
      violations.push(`category "${c}" contains "/" or "&", which is not allowed unless the name is listed in ${ALLOWLIST_PATH}`);
      continue;
    }
    const variant = byKey.get(normalizeKey(c));
    if (variant) violations.push(`category "${c}" is a case/hyphen variant of allowed "${variant}"; use "${variant}"`);
    else violations.push(`category "${c}" is not in ${ALLOWLIST_PATH}`);
  }
  return violations;
}

export function checkFiles(files, allowlist) {
  const failures = [];
  for (const [path, text] of files) {
    const { categories, errors } = parseFrontmatter(text);
    for (const v of [...errors, ...checkPost(categories, allowlist)]) failures.push(`${path}: ${v}`);
  }
  return failures;
}

export function collectCategories(files) {
  const set = new Set();
  for (const [, text] of files) for (const c of parseCategories(text)) set.add(c);
  return [...set].sort();
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function loadContent() {
  return walk(CONTENT_DIR).sort().map((p) => [relative('.', p).split('\\').join('/'), readFileSync(p, 'utf8')]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = loadContent();
  if (process.argv.includes('--write-allowlist')) {
    const cats = collectCategories(files);
    const body = '# Allowed post categories. Add a new name here deliberately; do not add case, hyphen, or "/" variants.\n' +
      cats.map((c) => `- ${yamlQuote(c)}`).join('\n') + '\n';
    writeFileSync(ALLOWLIST_PATH, body);
    console.log(`Wrote ${cats.length} categories to ${ALLOWLIST_PATH}`);
  } else {
    const allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));
    const failures = checkFiles(files, allowlist);
    if (failures.length) {
      console.error(`Category check failed (${failures.length}):`);
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log(`Category check passed (${files.length} files, ${allowlist.length} allowed categories)`);
  }
}
