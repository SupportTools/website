import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPage, PUBLIC_DIR } from './site.mjs';

function asides(html, kind) {
  const re = new RegExp(`<aside class="callout callout-${kind}"[^>]*>[\\s\\S]*?</aside>`, 'g');
  return html.match(re) || [];
}

test('alerts render as labelled callout asides', () => {
  const html = readPage('theme-fixture');
  const cases = [
    ['tip', 'Tip', 'Tips suggest'],
    ['warning', 'Warning', 'Warnings flag'],
  ];
  for (const [kind, label, text] of cases) {
    const found = asides(html, kind);
    assert.equal(found.length, 1, `one callout-${kind}`);
    assert.match(found[0], new RegExp(`aria-label="${label}"`));
    assert.match(found[0], new RegExp(`<p class="callout-label">${label}</p>`));
    assert.match(found[0], new RegExp(text));
  }
});

test('NOTE and unknown CAUTION both render as callout-note labelled Note', () => {
  const html = readPage('theme-fixture');
  const found = asides(html, 'note');
  assert.equal(found.length, 2);
  for (const a of found) {
    assert.match(a, /aria-label="Note"/);
    assert.match(a, /<p class="callout-label">Note<\/p>/);
  }
  assert.ok(found.some((a) => /Cautions render/.test(a)));
  assert.doesNotMatch(html, /callout-caution/);
});

test('plain blockquote is still a blockquote', () => {
  const html = readPage('theme-fixture');
  assert.match(html, /<blockquote>\s*<p>A plain blockquote keeps its markup\.<\/p>\s*<\/blockquote>/);
});

test('Markdown source keeps the alert syntax', () => {
  const md = fs.readFileSync(path.join(PUBLIC_DIR, 'theme-fixture', 'index.md'), 'utf8');
  assert.match(md, /> \[!WARNING\]/);
});
