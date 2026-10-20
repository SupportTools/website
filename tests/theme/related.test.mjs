import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

function relatedBlock(html) {
  const m = html.match(/<section class="related-guides"[\s\S]*?<\/section>/);
  return m ? m[0] : null;
}

test('post pages render 1-4 related guides without a self-link', () => {
  const html = readPage('theme-fixture');
  const block = relatedBlock(html);
  assert.ok(block, 'related guides block present');
  assert.match(block, /Related guides/);
  const links = block.match(/<a href="[^"]+"/g) || [];
  assert.ok(links.length >= 1 && links.length <= 4, `1-4 links, got ${links.length}`);
  assert.ok(!block.includes('href="/theme-fixture/"'), 'no self-link');
});

test('related block is excluded from search indexing', () => {
  assert.match(relatedBlock(readPage('theme-fixture')), /data-pagefind-ignore/);
});

test('related block sits above the chronological pager', () => {
  const html = readPage('theme-fixture');
  assert.ok(html.indexOf('related-guides') < html.indexOf('post-pagination'));
});

test('static pages render no related guides', () => {
  assert.ok(!readPage('about').includes('related-guides'));
});
