#!/usr/bin/env node
// Heading structure lint for blog/content. The page title is the H1, so a body
// may carry at most one H1 and must not skip levels (H2 straight to H4). The
// first body heading is measured against the page title (level 1).
// Legacy violators are listed in scripts/heading-baseline.json and exempt;
// everything else must be clean.
// Usage: node scripts/check-headings.mjs [--write-baseline]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractHeadings } from './lib/markdown-headings.mjs';

const CONTENT_DIR = 'blog/content';
const BASELINE_PATH = 'scripts/heading-baseline.json';

export function findViolations(text) {
  const headings = extractHeadings(text);
  const violations = [];
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length > 1) {
    violations.push(`${h1s.length} body H1s (lines ${h1s.map((h) => h.line).join(', ')}); the page title is the H1`);
  }
  let prev = 1;
  for (const h of headings) {
    if (h.level > prev + 1) {
      violations.push(`line ${h.line}: H${h.level} "${h.text}" skips from H${prev}`);
    }
    prev = h.level;
  }
  return violations;
}

export function checkFiles(files, baseline = []) {
  const exempt = new Set(baseline);
  const failures = [];
  for (const [path, text] of files) {
    if (exempt.has(path)) continue;
    for (const v of findViolations(text)) failures.push(`${path}: ${v}`);
  }
  return failures;
}

export function violatingPaths(files) {
  return files.filter(([, text]) => findViolations(text).length > 0).map(([path]) => path).sort();
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
    const paths = violatingPaths(files);
    writeFileSync(BASELINE_PATH, JSON.stringify(paths, null, 2) + '\n');
    console.log(`Wrote ${paths.length} legacy files to ${BASELINE_PATH}`);
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const failures = checkFiles(files, baseline);
    if (failures.length) {
      console.error(`Heading check failed (${failures.length}):`);
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log(`Heading check passed (${files.length} files, ${baseline.length} baselined)`);
  }
}
