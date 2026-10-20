#!/usr/bin/env node
// One-shot: demote body headings by one level (H1->H2, H2->H3, H3->H4) in the
// given Markdown files. Skips YAML frontmatter and fenced code blocks.
// Usage: node scripts/demote-headings.mjs [--dry-run] <file.md> [...]
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter((a) => a !== '--dry-run');
if (files.length === 0) {
  console.error('usage: demote-headings.mjs [--dry-run] <file.md> [...]');
  process.exit(2);
}

const HEADING = /^(#{1,3}) /;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
let tooDeep = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') i++;
    i++;
  }
  let fence = null;
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    const level = m[1].length;
    counts[level]++;
    if (level + 1 > 4) tooDeep++;
    lines[i] = '#' + line;
  }
  console.log(`${file}: H1->H2 ${counts[1]}, H2->H3 ${counts[2]}, H3->H4 ${counts[3]}`);
  if (!dryRun) writeFileSync(file, lines.join('\n'));
}
if (tooDeep) {
  console.error(`WARNING: ${tooDeep} heading(s) would exceed H4`);
  process.exit(1);
}
