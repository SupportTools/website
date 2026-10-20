import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

test('static pages render no chronological pager', () => {
  for (const p of ['about', 'certificates', 'publications', 'privacy', 'comment-policy']) {
    const html = readPage(p);
    assert.ok(!html.includes('post-pagination'), `${p} has no pager`);
    assert.ok(!html.includes('Older article'), `${p} has no Older article link`);
    assert.ok(!html.includes('Newer article'), `${p} has no Newer article link`);
  }
});

test('about page no longer references a CV page', () => {
  assert.ok(!/copy of my CV/.test(readPage('about')));
});

test('blog posts still render the pager', () => {
  assert.ok(readPage('theme-fixture').includes('post-pagination') || readPage('theme-fixture-short').includes('post-pagination'));
});
