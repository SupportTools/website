import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPage, PUBLIC_DIR } from './site.mjs';
import { tagUsage } from '../../scripts/check-tags.mjs';

const robots = (html) => html.match(/<meta name="?robots"? content="?([^">]+)/)?.[1];
const canonical = (html) => html.match(/<link rel="?canonical"? href="?([^"> ]+)/)?.[1];
const sitemap = () => fs.readFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), 'utf8');

function contentFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) contentFiles(p, out);
    else if (e.name.endsWith('.md')) out.push([p, fs.readFileSync(p, 'utf8')]);
  }
  return out;
}

// A tag used by one content file in the whole repo is thin in any build.
function singleUseTag() {
  const root = path.resolve(PUBLIC_DIR, '..', 'blog', 'content');
  for (const [key, u] of tagUsage(contentFiles(root))) {
    if (u.files.length === 1 && /^[a-z0-9-]+$/.test(key) && fs.existsSync(path.join(PUBLIC_DIR, 'tags', key, 'index.html'))) return key;
  }
  throw new Error('no single-use tag with a built term page');
}

test('a thin tag page is noindex, follow, keeps a self canonical and is not in the sitemap', () => {
  const tag = singleUseTag();
  const html = readPage(`tags/${tag}`);
  assert.equal(robots(html), 'noindex, follow');
  assert.equal(canonical(html), `http://localhost/tags/${tag}/`);
  assert.ok(!sitemap().includes(`/tags/${tag}/<`), `/tags/${tag}/ left the sitemap`);
});

test('a well-used tag page stays indexable and in the sitemap', () => {
  assert.match(robots(readPage('tags/kubernetes')), /^index, follow/);
  assert.ok(sitemap().includes('/tags/kubernetes/<'));
});

test('paginated lists declare their own page as canonical', () => {
  assert.equal(canonical(readPage('archive/page/2')), 'http://localhost/archive/page/2/');
  assert.equal(canonical(readPage('tags/kubernetes/page/2')), 'http://localhost/tags/kubernetes/page/2/');
  assert.equal(canonical(readPage('archive')), 'http://localhost/archive/');
  assert.match(robots(readPage('archive/page/2')), /^index, follow/);
});

test('the /post/ list, which repeats /archive/, is noindex, follow and out of the sitemap', () => {
  assert.equal(robots(readPage('post')), 'noindex, follow');
  assert.equal(robots(readPage('post/page/2')), 'noindex, follow');
  assert.equal(canonical(readPage('post/page/2')), 'http://localhost/post/page/2/');
  assert.ok(!sitemap().includes('/post/<'));
});

test('posts keep index, follow and a permalink canonical', () => {
  const slug = 'active-directory-domain-controller-upgrade-adprep-enterprise-guide';
  const html = readPage(slug);
  assert.match(robots(html), /^index, follow/);
  assert.equal(canonical(html), `http://localhost/${slug}/`);
  assert.equal(robots(readPage('theme-fixture')), 'noindex, nofollow', 'front matter noindex still wins');
});

test('the _headers file ships in the build', () => {
  assert.match(fs.readFileSync(path.join(PUBLIC_DIR, '_headers'), 'utf8'), /^\/\*\.md\n {2}X-Robots-Tag: noindex$/m);
});
