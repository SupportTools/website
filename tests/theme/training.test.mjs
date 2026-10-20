import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, readPage } from './site.mjs';

function builtPath(url) {
  return path.join(PUBLIC_DIR, url.replace(/^\/+|\/+$/g, ''), 'index.html');
}

test('fleet training path lists resources and internal links resolve', () => {
  const html = readPage('training/fleet');
  const section = html.match(/<h2[^>]*>\s*Fleet Resources[\s\S]*/);
  assert.ok(section, 'Fleet Resources section present');
  const hrefs = [...section[0].matchAll(/<li>\s*<a href="([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 4, `at least 4 resource links, got ${hrefs.length}`);
  const internal = hrefs.filter((h) => h.startsWith('/'));
  assert.ok(internal.length >= 1, 'at least one on-site article linked');
  for (const href of internal) {
    assert.ok(fs.existsSync(builtPath(href)), `link resolves in build: ${href}`);
  }
});

test('retired RKE path redirects to RKE2', () => {
  const html = readPage('training/rke');
  assert.match(html, /http-equiv="refresh"/i);
  assert.match(html, /\/training\/rke2\//);
});

test('training index no longer advertises RKE', () => {
  const html = readPage('training');
  assert.ok(!/href="\/training\/rke\/"/.test(html), 'no RKE link');
  assert.ok(html.includes('href="/training/fleet/"'), 'Fleet kept');
});

test('k3s load balancer typo URL redirects to corrected page', () => {
  assert.ok(fs.existsSync(builtPath('/training/k3s/load-balancer/')));
  const html = readPage('training/k3s/load-balanacer');
  assert.match(html, /http-equiv="refresh"/i);
  assert.match(html, /\/training\/k3s\/load-balancer\//);
});
