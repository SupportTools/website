import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSitemap, readSitemap, parseSince, selectUrls, batches, payload, loadConfig, parseArgs, MAX_BATCH,
} from '../../scripts/indexnow.mjs';
import worker from '../../src/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SITEMAP = `<?xml version="1.0" encoding="utf-8" standalone="yes"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
  + '<url><loc>https://support.tools/new-post/</loc><lastmod>2026-10-23T09:00:00-05:00</lastmod></url>'
  + '<url><loc>https://support.tools/old-post/</loc><lastmod>2026-01-01T00:00:00-05:00</lastmod></url>'
  + '<url><loc>https://support.tools/tags/kubernetes/</loc><lastmod>2026-10-23T09:00:00-05:00</lastmod></url>'
  + '<url><loc>https://support.tools/categories/kubernetes/</loc><lastmod>2026-10-23T09:00:00-05:00</lastmod></url>'
  + '<url><loc>https://support.tools/no-lastmod/</loc></url>'
  + '<url><loc>https://support.tools/q/?a=1&amp;b=2</loc><lastmod>2026-10-23</lastmod></url>'
  + '<url><loc>https://example.com/elsewhere/</loc><lastmod>2026-10-23T09:00:00Z</lastmod></url>'
  + '<url>\n  <loc>\n    https://support.tools/new-post/\n  </loc>\n  <lastmod>2026-10-23T10:00:00Z</lastmod>\n</url>'
  + '</urlset>';

test('parseSitemap reads loc and lastmod, unescapes XML and tolerates whitespace', () => {
  const e = parseSitemap(SITEMAP);
  assert.equal(e.length, 8);
  assert.deepEqual(e[0], { loc: 'https://support.tools/new-post/', lastmod: new Date('2026-10-23T14:00:00Z') });
  assert.equal(e[4].lastmod, null);
  assert.equal(e[5].loc, 'https://support.tools/q/?a=1&b=2');
  assert.equal(e[7].loc, 'https://support.tools/new-post/');
});

test('parseSitemap returns the child list for a sitemap index, and readSitemap follows it locally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexnow-'));
  fs.writeFileSync(path.join(dir, 'sitemap.xml'),
    '<sitemapindex><sitemap><loc>https://support.tools/en/sitemap.xml</loc></sitemap></sitemapindex>');
  fs.mkdirSync(path.join(dir, 'en'));
  fs.writeFileSync(path.join(dir, 'en/sitemap.xml'), SITEMAP);
  assert.deepEqual(parseSitemap(fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8')), { index: ['https://support.tools/en/sitemap.xml'] });
  assert.equal(readSitemap(dir).length, 8);
  fs.rmSync(dir, { recursive: true });
});

test('parseSince accepts relative windows and absolute dates', () => {
  const now = new Date('2026-10-23T15:10:00Z');
  assert.equal(parseSince('26h', now).toISOString(), '2026-10-22T13:10:00.000Z');
  assert.equal(parseSince('90m', now).toISOString(), '2026-10-23T13:40:00.000Z');
  assert.equal(parseSince('2d', now).toISOString(), '2026-10-21T15:10:00.000Z');
  assert.equal(parseSince('2026-10-01T00:00:00Z', now).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(parseSince('yesterday-ish', now), null);
});

test('selectUrls keeps changed pages on the host, drops tags by default, dedupes', () => {
  const since = new Date('2026-10-22T13:10:00Z');
  const urls = selectUrls(parseSitemap(SITEMAP), { since, host: 'support.tools' });
  assert.deepEqual(urls, [
    'https://support.tools/new-post/',
    'https://support.tools/categories/kubernetes/',
    'https://support.tools/q/?a=1&b=2',
  ]);
  const withTags = selectUrls(parseSitemap(SITEMAP), { since, host: 'support.tools', excludes: [] });
  assert.ok(withTags.includes('https://support.tools/tags/kubernetes/'));
});

test('selectUrls treats lastmod equal to since as unchanged', () => {
  const entries = [{ loc: 'https://support.tools/a/', lastmod: new Date('2026-10-22T00:00:00Z') }];
  assert.deepEqual(selectUrls(entries, { since: new Date('2026-10-22T00:00:00Z'), host: 'support.tools' }), []);
});

test('batches splits at the 10,000 URL protocol limit', () => {
  const list = Array.from({ length: 20001 }, (_, i) => `https://support.tools/p${i}/`);
  const b = batches(list);
  assert.equal(MAX_BATCH, 10000);
  assert.deepEqual(b.map((x) => x.length), [10000, 10000, 1]);
  assert.equal(b[2][0], 'https://support.tools/p20000/');
  assert.deepEqual(batches([]), []);
});

test('payload has exactly the IndexNow fields', () => {
  const cfg = loadConfig();
  const body = payload(cfg, ['https://support.tools/a/']);
  assert.deepEqual(Object.keys(body).sort(), ['host', 'key', 'keyLocation', 'urlList']);
  assert.equal(body.host, 'support.tools');
  assert.equal(body.keyLocation, `https://support.tools/${cfg.key}.txt`);
  assert.deepEqual(body.urlList, ['https://support.tools/a/']);
});

test('committed key is valid and the key file at the site root contains it', () => {
  const cfg = loadConfig();
  assert.match(cfg.key, /^[0-9a-f]{32}$/);
  const file = path.join(ROOT, 'blog/static', `${cfg.key}.txt`);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), cfg.key);
});

test('the Worker serves /<key>.txt from assets with a 200, not a redirect', async () => {
  const cfg = loadConfig();
  const env = {
    ASSETS: {
      fetch: async (req) => (new URL(req.url).pathname === `/${cfg.key}.txt`
        ? new Response(cfg.key, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        : new Response('', { status: 404 })),
    },
  };
  const log = console.log;
  console.log = () => {};
  try {
    for (const method of ['GET', 'HEAD']) {
      const res = await worker.fetch(new Request(`https://support.tools/${cfg.key}.txt`, { method }), env);
      assert.equal(res.status, 200, method);
      assert.match(res.headers.get('content-type'), /^text\/plain/);
      if (method === 'GET') assert.equal(await res.text(), cfg.key);
    }
    // A client asking for Markdown still gets the key file.
    const md = await worker.fetch(new Request(`https://support.tools/${cfg.key}.txt`, { headers: { accept: 'text/markdown' } }), env);
    assert.equal(md.status, 200);
    assert.equal(await md.text(), cfg.key);
  } finally {
    console.log = log;
  }
});

test('parseArgs rejects unknown flags and missing values', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--since']), /needs a value/);
  const o = parseArgs(['--since', '2h', '--url', 'https://support.tools/a/', '--dry-run', '--include-tags']);
  assert.equal(o.since, '2h');
  assert.deepEqual(o.urls, ['https://support.tools/a/']);
  assert.equal(o.dryRun, true);
  assert.equal(o.includeTags, true);
});
