import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findViolations, checkFiles, violatingPaths } from '../../scripts/check-headings.mjs';
import { extractHeadings } from '../../scripts/lib/markdown-headings.mjs';

const fm = '---\ntitle: "T"\n---\n';

test('two body H1s fail, one passes', () => {
  assert.equal(findViolations(`${fm}# One\n\ntext\n\n# Two\n`).length, 1);
  assert.deepEqual(findViolations(`${fm}# One\n\n## Two\n`), []);
});

test('clean H2/H3 structure passes with no H1', () => {
  assert.deepEqual(findViolations(`${fm}## A\n\n### B\n\n## C\n`), []);
});

test('skipped level is reported with line and levels', () => {
  const v = findViolations(`${fm}## A\n\n#### B\n`);
  assert.equal(v.length, 1);
  assert.match(v[0], /H4/);
  assert.match(v[0], /skips from H2/);
});

test('first heading is measured against the page title', () => {
  assert.equal(findViolations(`${fm}### Deep start\n`).length, 1);
});

test('going back up any number of levels is fine', () => {
  assert.deepEqual(findViolations(`${fm}## A\n\n### B\n\n#### C\n\n## D\n`), []);
});

test('fenced comment lines and frontmatter comments are not headings', () => {
  const text = '---\ntitle: T\n# yaml comment\n---\n## A\n\n```bash\n# one\n# two\n```\n\n~~~\n# three\n~~~\n';
  assert.deepEqual(extractHeadings(text).map((h) => h.level), [2]);
  assert.deepEqual(findViolations(text), []);
});

test('TOML frontmatter is skipped', () => {
  assert.deepEqual(extractHeadings('+++\n# not a heading\n+++\n## A\n').map((h) => h.level), [2]);
});

test('hashtags without a space are not headings', () => {
  assert.deepEqual(extractHeadings(`${fm}#nope\n## A\n`).map((h) => h.level), [2]);
});

test('baselined path is exempt, unbaselined violator fails', () => {
  const bad = `${fm}# A\n\n# B\n`;
  const files = [['blog/content/post/old.md', bad], ['blog/content/post/new.md', bad]];
  const failures = checkFiles(files, ['blog/content/post/old.md']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^blog\/content\/post\/new\.md:/);
});

test('violatingPaths is sorted and drops files that were fixed', () => {
  const files = [
    ['b.md', `${fm}# A\n# B\n`],
    ['a.md', `${fm}## A\n#### B\n`],
    ['c.md', `${fm}## A\n`],
  ];
  assert.deepEqual(violatingPaths(files), ['a.md', 'b.md']);
});

test('baseline is sorted and holds no known-good-designs files', () => {
  const baseline = JSON.parse(readFileSync('scripts/heading-baseline.json', 'utf8'));
  assert.deepEqual(baseline, [...baseline].sort());
  assert.deepEqual(baseline.filter((p) => p.includes('known-good-designs')), []);
});
