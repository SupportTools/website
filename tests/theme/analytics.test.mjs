import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

test('no Universal Analytics tag on any page type', () => {
  for (const p of ['theme-fixture', 'about', '']) {
    const html = readPage(p);
    assert.ok(!html.includes('UA-151436906-1'), `${p || 'home'} still has the UA id`);
    assert.ok(!html.includes('googletagmanager.com/gtag/js'), `${p || 'home'} still loads gtag.js`);
  }
});

test('GTM and PostHog are still present', () => {
  const html = readPage('theme-fixture');
  assert.match(html, /GTM-TF2NG6JW/);
  assert.match(html, /posthog\.init\('phc_/);
});

function props(urlPath) {
  const m = readPage(urlPath).match(/<script type="application\/json" id="post-analytics">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

test('article pages carry the post properties', () => {
  const p = props('theme-fixture');
  assert.ok(p, 'data block present');
  assert.ok(p.post_words > 50, `post_words ${p.post_words}`);
  assert.deepEqual(p, {
    post_slug: 'theme-fixture', post_section: 'post', post_category: 'theme',
    post_tags: ['Theme'], post_kind: 'guide', post_published: '2020-01-01',
    post_words: p.post_words,
  });
});

test('post_kind: frontmatter override, troubleshooting signal, reference section', () => {
  assert.equal(props('theme-fixture-short').post_kind, 'incident');
  assert.equal(props('theme-fixture-error-fix').post_kind, 'troubleshooting');
  assert.equal(props('known-good-designs/loadbalancers/ingress-nginx-controller-on-eks').post_kind, 'reference');
});

test('no categories and a hostile tag still give valid, contained JSON', () => {
  const p = props('theme-fixture-error-fix');
  assert.equal(p.post_category, '');
  assert.deepEqual(p.post_tags, ['Theme', 'a"b</script>c']);
  const raw = readPage('theme-fixture-error-fix').split('id="post-analytics">')[1].split('</script>')[0];
  assert.ok(!raw.includes('</script'), 'tag text did not close the script element');
});

test('non-article pages have no data block', () => {
  assert.equal(props('about'), null);
  assert.equal(props(''), null);
});

test('PostHog init merges the block through before_send', () => {
  assert.match(readPage('theme-fixture'), /before_send:[\s\S]*post-analytics/);
});
