#!/usr/bin/env node
// Tag ratchet for blog/content. A tag used by only one post renders a near-empty
// /tags/<tag>/ page, which the theme marks noindex and drops from the sitemap.
// This check stops new ones: it fails when a tag is used by exactly one post
// (counting every content file, drafts and future-dated posts included) and
// the tag is not in scripts/tag-baseline.json.
//
// The baseline is the set of every tag known when the ratchet was introduced,
// so the existing single-use tags pass, and retiring a post never fails the
// check. A new tag passes once a second post uses it. Spelling variants of a
// known tag (case, spaces, hyphens, underscores) get a pointer to the known one.
// Usage: node scripts/check-tags.mjs [--write-baseline]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFrontmatterList } from './lib/frontmatter.mjs';

const CONTENT_DIR = 'blog/content';
const BASELINE_PATH = 'scripts/tag-baseline.json';

// Hugo builds term URLs from the lowercased, hyphenated tag name.
export function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

const looseKey = (key) => key.replace(/[\s_-]+/g, '');

export function tagUsage(files) {
  const usage = new Map();
  for (const [path, text] of files) {
    if (basename(path).startsWith('_index.')) continue;
    const seen = new Set();
    for (const name of parseFrontmatterList(text, 'tags').items) {
      const key = normalizeTag(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!usage.has(key)) usage.set(key, { name, files: [] });
      usage.get(key).files.push(path);
    }
  }
  return usage;
}

export function checkTags(files, known) {
  const byLoose = new Map();
  for (const k of known) if (!byLoose.has(looseKey(k))) byLoose.set(looseKey(k), k);
  const failures = [];
  for (const [key, { name, files: users }] of tagUsage(files)) {
    if (users.length !== 1 || known.has(key)) continue;
    const variant = byLoose.get(looseKey(key));
    const hint = variant
      ? `it is a spelling variant of existing tag "${variant}"; use "${variant}"`
      : 'reuse an existing tag, or add it only when a second post shares it';
    failures.push(`${users[0]}: tag "${name}" is used by no other post (its /tags/ page would be thin); ${hint}`);
  }
  return failures.sort();
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
  if (process.argv.includes('--write-baseline')) {
    const keys = [...tagUsage(files).keys()].sort();
    writeFileSync(BASELINE_PATH, `${JSON.stringify(keys, null, 2)}\n`);
    console.log(`Wrote ${keys.length} known tags to ${BASELINE_PATH}`);
  } else {
    const known = new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')));
    const usage = tagUsage(files);
    const failures = checkTags(files, known);
    if (failures.length) {
      console.error(`Tag check failed (${failures.length}):`);
      for (const f of failures) console.error(`  ${f}`);
      console.error(`If a single-use tag is deliberate, add it to ${BASELINE_PATH}.`);
      process.exit(1);
    }
    const single = [...usage.values()].filter((u) => u.files.length === 1).length;
    console.log(`Tag check passed (${files.length} files, ${usage.size} tags, ${single} single-use, all in the baseline)`);
  }
}
