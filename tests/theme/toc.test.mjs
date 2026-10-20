import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

function count(html, re) {
  return (html.match(re) || []).length;
}

test('long fixture renders one sidebar TOC and one collapsed TOC, both ignored by Pagefind', () => {
  const html = readPage('theme-fixture');
  const sidebars = html.match(/<nav class="toc-sidebar"[^>]*>/g) || [];
  assert.equal(sidebars.length, 1);
  assert.match(sidebars[0], /aria-label="On this page"/);
  assert.match(sidebars[0], /data-pagefind-ignore/);
  const details = html.match(/<details class="post-toc"[^>]*>/g) || [];
  assert.equal(details.length, 1);
  assert.match(details[0], /data-pagefind-ignore/);
});

test('long fixture has no TableOfContents id and no duplicate ids', () => {
  const html = readPage('theme-fixture');
  assert.equal(count(html, /id="TableOfContents"/g), 0);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, []);
});

test('short fixture with two headings renders no TOC', () => {
  const html = readPage('theme-fixture-short');
  assert.doesNotMatch(html, /toc-sidebar/);
  assert.doesNotMatch(html, /post-toc/);
});

test('Markdown output carries no TOC', () => {
  const md = readPage('theme-fixture/index.md');
  assert.doesNotMatch(md, /On this page/);
  assert.doesNotMatch(md, /toc-sidebar/);
});
