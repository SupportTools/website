#!/usr/bin/env node
// One-shot: demote every body heading (H1-H5) by one level in the given
// Markdown files (the page title is the H1). Levels are derived from nesting:
// a heading sits one level below its nearest shallower ancestor, so siblings
// stay siblings and a source skip (H1 straight to H3) is closed rather than
// carried over. Skips YAML frontmatter and fenced code blocks. Nothing is
// written if any heading would exceed H5.
// Usage: node scripts/demote-headings.mjs [--dry-run] <file.md> [...]
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter((a) => a !== '--dry-run');
if (files.length === 0) {
  console.error('usage: demote-headings.mjs [--dry-run] <file.md> [...]');
  process.exit(2);
}

const HEADING = /^(#{1,5}) /;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MAX_LEVEL = 5;

const plans = [];
const overflow = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') i++;
    i++;
  }
  let fence = null;
  const stack = [];
  let demoted = 0;
  let clamped = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    const orig = m[1].length;
    while (stack.length && stack[stack.length - 1].orig >= orig) stack.pop();
    const level = (stack.length ? stack[stack.length - 1].level : 1) + 1;
    if (level > MAX_LEVEL) overflow.push(`${file}:${i + 1}: ${line}`);
    if (level !== orig + 1) clamped++;
    stack.push({ orig, level });
    lines[i] = '#'.repeat(level) + line.slice(m[1].length);
    demoted++;
  }
  plans.push({ file, text: lines.join('\n'), demoted, clamped });
}

for (const p of plans) console.log(`${p.file}: ${p.demoted} headings shifted, ${p.clamped} re-leveled to close a source skip`);
if (overflow.length) {
  console.error(`ABORT: ${overflow.length} heading(s) would exceed H${MAX_LEVEL}:\n${overflow.join('\n')}`);
  process.exit(1);
}
if (!dryRun) for (const p of plans) writeFileSync(p.file, p.text);
