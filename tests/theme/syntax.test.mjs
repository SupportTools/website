import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPage } from './site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scssPath = path.join(root, 'blog/themes/m10c/assets/css/components/_syntax.scss');

// Chroma classes that are emitted but intentionally inherit --syntax-text.
const FALLS_BACK_TO_TEXT = new Set([
  'chroma', 'line', 'cl', 'p', 'n', 'o', 'nv', 'vc', 'vg', 'vi', 'vm', 'w',
  'l', 'ld', 'ni', 'nl', 'py', 'nx', 'x', 'hl', 'lntd', 'lntable',
]);

function mappedClasses() {
  const scss = fs.readFileSync(scssPath, 'utf8');
  const out = new Set();
  for (const m of scss.matchAll(/\.chroma\s+\.([a-z0-9]+)/gi)) out.add(m[1]);
  return out;
}

test('fixture renders classed Chroma output with no inline color styles', () => {
  const html = readPage('theme-fixture');
  assert.match(html, /class="chroma"/);
  assert.doesNotMatch(html, /<span style="color:/);
});

test('every Chroma token class in the fixture is mapped or falls back to text', () => {
  const html = readPage('theme-fixture');
  const mapped = mappedClasses();
  const used = new Set();
  for (const block of html.matchAll(/<(?:pre|div|table)[^>]*class="chroma"[\s\S]*?<\/(?:pre|table)>/g)) {
    for (const m of block[0].matchAll(/<span class="([^"]+)"/g)) {
      m[1].split(/\s+/).forEach((c) => used.add(c));
    }
  }
  const unmapped = [...used].filter((c) => !mapped.has(c) && !FALLS_BACK_TO_TEXT.has(c));
  if (unmapped.length) console.log(`unmapped Chroma classes: ${unmapped.join(', ')}`);
  assert.deepEqual(unmapped, []);
});
