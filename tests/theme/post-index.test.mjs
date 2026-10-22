import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

test('post-index lists articles with their props', () => {
  const idx = JSON.parse(readPage('post-index.json'));
  const fx = idx.find((p) => p.post_slug === 'theme-fixture-error-fix');
  assert.ok(fx, 'fixture listed');
  assert.deepEqual(fx, { post_slug: 'theme-fixture-error-fix', post_section: 'post', post_category: '',
    post_kind: 'troubleshooting', post_published: '2020-01-01', post_words: fx.post_words });
  assert.ok(idx.some((p) => p.post_kind === 'reference'));
  assert.ok(!idx.some((p) => p.post_slug === 'about'));
});

test('the analytics data block and the index agree for the same page', () => {
  const idx = JSON.parse(readPage('post-index.json'));
  const block = readPage('theme-fixture').match(/id="post-analytics">([^<]*)</)[1];
  const { post_tags, ...rest } = JSON.parse(block);
  assert.deepEqual(idx.find((p) => p.post_slug === 'theme-fixture'), rest);
});
