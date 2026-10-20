import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

function crumbHrefs(html) {
  const nav = html.match(/<nav class="breadcrumbs"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'breadcrumb nav present');
  return [...nav[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

test('design guide breadcrumb links the curated hub and subsection', () => {
  const hrefs = crumbHrefs(readPage('known-good-designs/downstream-rke2-cluster/rke2-custom-vms'));
  assert.ok(hrefs.includes('/known-good-designs/'), `hub linked: ${hrefs}`);
  assert.ok(hrefs.includes('/known-good-designs/downstream-rke2-cluster/'), `subsection linked: ${hrefs}`);
  assert.ok(!hrefs.some((h) => h.startsWith('/categories/known-good-designs')), `no category archive: ${hrefs}`);
  assert.ok(hrefs.indexOf('/known-good-designs/') < hrefs.indexOf('/known-good-designs/downstream-rke2-cluster/'), 'hub precedes subsection');
});

test('ordinary posts keep the category breadcrumb', () => {
  const hrefs = crumbHrefs(readPage('theme-fixture'));
  assert.ok(hrefs.some((h) => h.startsWith('/categories/')), `category crumb kept: ${hrefs}`);
});
