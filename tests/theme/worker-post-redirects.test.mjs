import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../src/worker.js';
import POST_REDIRECTS from '../../src/post-redirects.json' with { type: 'json' };

// Retired posts (stubs, duplicate titles, near-duplicate clusters) are held with
// `draft: true`, so Hugo stops building them and the Worker sees the request.
// src/post-redirects.json maps each retired URL to the post that replaced it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
const fetchPath = (p, init) => worker.fetch(new Request(`https://support.tools${p}`, init), env);

test('a retired post 301s to the post that replaced it', async () => {
  const res = await fetchPath('/nginx-ingress-controller-tuning/');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'),
    'https://support.tools/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/');
});

test('the query string is kept so utm tags still attribute the visit', async () => {
  const res = await fetchPath('/nginx-ingress-controller-tuning/?utm_source=linkedin&utm_medium=social');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'),
    'https://support.tools/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/?utm_source=linkedin&utm_medium=social');
});

test('the URL without a trailing slash also redirects', async () => {
  const res = await fetchPath('/nginx-ingress-controller-tuning');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'),
    'https://support.tools/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/');
});

test('HEAD redirects too', async () => {
  const res = await fetchPath('/nginx-ingress-controller-tuning/', { method: 'HEAD' });
  assert.equal(res.status, 301);
});

test('other methods are not redirected', async () => {
  const res = await fetchPath('/nginx-ingress-controller-tuning/', { method: 'POST', body: 'x' });
  assert.notEqual(res.status, 301);
});

test('only exact paths match: deeper paths and prefixes are left alone', async () => {
  for (const p of ['/nginx-ingress-controller-tuning/extra/', '/nginx-ingress-controller-tuning-x/', '/nginx-ingress-controller-tuning/index.xml']) {
    const res = await fetchPath(p);
    assert.notEqual(res.status, 301, p);
  }
});

test('a retired /post/<slug>/ post also redirects from its shared /<slug>/ form', async () => {
  const res = await fetchPath('/how-to-check-default-coredns-configmap-of-rke-k8s-version/?utm_source=x');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://support.tools/post/how-to-enable-legacy-tls-versions/?utm_source=x');
});

// Every post's URL and whether Hugo builds it, from front matter.
function posts() {
  const dir = path.join(ROOT, 'blog/content/post');
  const today = new Date();
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== '_index.md')) {
    const fm = (fs.readFileSync(path.join(dir, f), 'utf8').match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    let url = (fm.match(/^url:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1] || `/post/${f.replace(/\.md$/, '')}/`;
    if (!url.endsWith('/')) url += '/';
    const date = new Date((fm.match(/^date:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1]);
    const draft = /^draft:\s*true\s*$/m.test(fm);
    out.set(url, { file: f, built: !draft && date <= today });
  }
  return out;
}

test('the redirect map is well formed: paths only, no chains', () => {
  for (const [from, to] of Object.entries(POST_REDIRECTS)) {
    assert.match(from, /^\/[a-z0-9][a-z0-9/._-]*\/$/, from);
    assert.match(to, /^\/[a-z0-9][a-z0-9/._-]*\/$/, to);
    assert.notEqual(from, to);
    assert.ok(!Object.hasOwn(POST_REDIRECTS, to), `${from} -> ${to} chains through another redirect`);
  }
});

test('every retired post is held as a draft and every target is a built post', () => {
  const all = posts();
  for (const [from, to] of Object.entries(POST_REDIRECTS)) {
    const src = all.get(from);
    assert.ok(src, `${from} is not the URL of any post`);
    // A built page is served before the Worker runs, so its redirect would never fire.
    assert.equal(src.built, false, `${src.file} is still built; set draft: true to retire it`);
    const dst = all.get(to);
    assert.ok(dst, `${to} is not the URL of any post`);
    assert.equal(dst.built, true, `${from} redirects to ${to} (${dst.file}), which is not published`);
  }
});
