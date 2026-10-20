import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPage } from './site.mjs';
import worker from '../../src/worker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const homeData = fs.readFileSync(path.join(root, 'blog', 'data', 'home.yaml'), 'utf8');
const hubUrls = [...homeData.matchAll(/^\s+url:\s*(\S+)/gm)].map((m) => m[1]);
const featuredPaths = [...homeData.matchAll(/^\s+-\s+(known-good-designs\/\S+)/gm)].map((m) => m[1]);

const home = readPage('/');

test('homepage search is a GET form to /search/ with q', () => {
  const form = home.match(/<form[^>]*class="home-search"[^>]*>[\s\S]*?<\/form>/);
  assert.ok(form, 'search form present');
  assert.match(form[0], /action="\/search\/"/);
  assert.match(form[0], /method="get"/);
  assert.match(form[0], /<label for="home-search-q"/);
  assert.match(form[0], /<input[^>]*name="q"/);
  assert.match(form[0], /<button type="submit"/);
});

test('hub cards match the configured hubs exactly', () => {
  assert.equal(hubUrls.length, 6);
  const grid = home.match(/<ul class="hub-grid">([\s\S]*?)<\/ul>/)[1];
  const hrefs = [...grid.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, hubUrls);
  for (const u of hubUrls) assert.ok(fs.existsSync(path.join(root, '.theme-test-public', u, 'index.html')), `${u} built`);
});

test('featured reference designs are linked', () => {
  assert.equal(featuredPaths.length, 3);
  const grid = home.match(/<ul class="design-grid">([\s\S]*?)<\/ul>/)[1];
  const hrefs = [...grid.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, featuredPaths.map((p) => `/${p}/`));
});

test('homepage lists exactly 8 posts, browse-all link, and no pager', () => {
  assert.equal((home.match(/class="posts-list-item"/g) || []).length, 8);
  assert.match(home, /<a href="\/archive\/">Browse all articles<\/a>/);
  assert.ok(!home.includes('class="pagination"'));
  assert.ok(!/href="[^"]*\/page\/2\/?"/.test(home));
});

test('section order: search, start here, designs, latest', () => {
  const order = ['home-search', 'id="start-here"', 'id="reference-designs"', 'id="latest-writing"'].map((s) => home.indexOf(s));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('homepage and archive are not search-indexed', () => {
  assert.ok(!home.includes('data-pagefind-body'));
  assert.ok(!readPage('/archive/').includes('data-pagefind-body'));
});

test('archive paginates the full feed', () => {
  const a = readPage('/archive/');
  assert.equal((a.match(/class="posts-list-item"/g) || []).length, 8);
  assert.match(a, /class="pagination"/);
  assert.match(a, /href="[^"]*\/archive\/page\/2\/"/);
  assert.match(readPage('/archive/page/2/'), /Page 2 of \d+/);
});

test('legacy /page/N/ URLs redirect to the archive', async () => {
  const res = await worker.fetch(new Request('https://support.tools/page/7/'), { ASSETS: { fetch: () => assert.fail('no asset fetch') } });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://support.tools/archive/page/7/');
  const bare = await worker.fetch(new Request('https://support.tools/page/12'), { ASSETS: { fetch: () => assert.fail('no asset fetch') } });
  assert.equal(bare.headers.get('location'), 'https://support.tools/archive/page/12/');
});
