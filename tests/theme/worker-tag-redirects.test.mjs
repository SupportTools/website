import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.js';

// The C++ tag page lived at /tags/c++/. Cloudflare answers that path with a 307 to
// /tags/c%2B%2B/, which Search Console reports as a sitemap "Page with redirect".
// The page now lives at /tags/cpp/; both old spellings get one 301 to it.
const env = { ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };

for (const path of ['/tags/c++/', '/tags/c%2B%2B/', '/tags/c%2b%2b/']) {
  test(`${path} redirects to /tags/cpp/`, async () => {
    const res = await worker.fetch(new Request(`https://support.tools${path}`), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), 'https://support.tools/tags/cpp/');
  });
}
