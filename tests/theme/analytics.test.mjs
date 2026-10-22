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
  // The whole block, up to its own closing tag, must hold no raw '<': the
  // tag's '</script>' has to arrive escaped as \u003c, or it ends the element.
  const block = readPage('theme-fixture-error-fix').match(/id="post-analytics">([^<]*)<\/script>/);
  assert.ok(block, 'data block ends at its own closing tag');
  assert.match(block[1], /\\u003c\/script\\u003e/);
});

// Runs the before_send IIFE from the built page against a stub document.
function beforeSend(urlPath) {
  const html = readPage(urlPath);
  const block = html.match(/<script type="application\/json" id="post-analytics">([\s\S]*?)<\/script>/);
  const src = html.match(/before_send: (\(function \(\) \{[\s\S]*?\}\(\)\))/);
  assert.ok(src, 'before_send source found');
  const document = { getElementById: (id) => (id === 'post-analytics' && block ? { textContent: block[1] } : null) };
  return new Function('document', `return ${src[1]};`)(document);
}

test('before_send adds post properties without overwriting PostHog keys', () => {
  const send = beforeSend('theme-fixture');
  const ev = send({ event: '$pageview', properties: { $current_url: 'x', post_kind: 'kept' } });
  assert.equal(ev.properties.post_slug, 'theme-fixture');
  assert.equal(ev.properties.post_category, 'theme');
  assert.equal(ev.properties.$current_url, 'x');
  assert.equal(ev.properties.post_kind, 'kept');
});

test('before_send passes events through unchanged on pages without a data block', () => {
  const ev = beforeSend('about')({ event: '$pageview', properties: { a: 1 } });
  assert.deepEqual(ev.properties, { a: 1 });
});

test('non-article pages have no data block', () => {
  assert.equal(props('about'), null);
  assert.equal(props(''), null);
});

test('PostHog init merges the block through before_send', () => {
  assert.match(readPage('theme-fixture'), /before_send:[\s\S]*post-analytics/);
});
