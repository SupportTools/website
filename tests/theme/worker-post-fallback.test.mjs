import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.js';

// Posts without a `url:` in frontmatter live at /post/<slug>/, but links shared
// on social (and typed by hand) use /<slug>/. A root URL that 404s redirects to
// /post/<slug>/ when that page exists, keeping the query string (utm tags).
function assets(existing) {
  const calls = [];
  return {
    calls,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      calls.push(path);
      return existing.includes(path)
        ? new Response('page', { status: 200 })
        : new Response('not found', { status: 404 });
    },
  };
}

test('a root slug that 404s redirects to its /post/ page, keeping utm tags', async () => {
  const a = assets(['/post/cpu-limits/']);
  const res = await worker.fetch(new Request('https://support.tools/cpu-limits/?utm_source=linkedin&utm_medium=social'), { ASSETS: a });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://support.tools/post/cpu-limits/?utm_source=linkedin&utm_medium=social');
});

test('the slug without a trailing slash also redirects', async () => {
  const res = await worker.fetch(new Request('https://support.tools/cpu-limits'), { ASSETS: assets(['/post/cpu-limits/']) });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://support.tools/post/cpu-limits/');
});

test('a page that exists at the root is served without probing /post/', async () => {
  const a = assets(['/curl-host-header/']);
  const res = await worker.fetch(new Request('https://support.tools/curl-host-header/'), { ASSETS: a });
  assert.equal(res.status, 200);
  assert.deepEqual(a.calls, ['/curl-host-header/']);
});

test('a slug missing in both places stays a 404', async () => {
  const res = await worker.fetch(new Request('https://support.tools/no-such-post/'), { ASSETS: assets([]) });
  assert.equal(res.status, 404);
});

test('nested paths and non-GET requests are not redirected', async () => {
  const nested = await worker.fetch(new Request('https://support.tools/tags/cpu-limits/'), { ASSETS: assets(['/post/tags/cpu-limits/']) });
  assert.equal(nested.status, 404);
  const post = await worker.fetch(new Request('https://support.tools/cpu-limits/', { method: 'POST' }), { ASSETS: assets(['/post/cpu-limits/']) });
  assert.equal(post.status, 404);
});
