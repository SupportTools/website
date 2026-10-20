import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

function panel(html) {
  const m = html.match(/<section class="applicability"[\s\S]*?<\/section>/);
  assert.ok(m, 'section.applicability present');
  return m[0];
}

test('fixture with fields renders the labelled panel with a stale badge', () => {
  const p = panel(readPage('theme-fixture-guide'));
  assert.match(p, /aria-labelledby="applicability-title"/);
  assert.match(p, /<dt>Tested with<\/dt>/);
  assert.match(p, /Rancher<\/span> 2\.9\.x/);
  assert.match(p, /cert-manager<\/span> 1\.15/);
  assert.match(p, /<time datetime="2023-01-15">Jan 15, 2023<\/time>/);
  assert.match(p, /applicability-stale/);
  assert.match(p, /<dt>Scope<\/dt>\s*<dd>Three node lab only<\/dd>/);
  assert.match(p, /<dt>Report an issue<\/dt>[\s\S]*href="https:\/\/github\.com\/supporttools\/website\/issues\/new"/);
});

test('recent validation shows no stale badge and honours feedback_url', () => {
  const p = panel(readPage('theme-fixture-guide-fresh'));
  assert.ok(!p.includes('applicability-stale'));
  assert.ok(!p.includes('<dt>Scope</dt>'));
  assert.ok(p.includes('href="https://example.com/report"'));
});

test('applies_to without a date says validation is not recorded', () => {
  const p = panel(readPage('theme-fixture-guide-undated'));
  assert.match(p, /Validation date not recorded/);
  assert.ok(!p.includes('<time'));
  assert.ok(!p.includes('applicability-stale'));
});

test('pages without the fields render no panel', () => {
  assert.ok(!readPage('theme-fixture-short').includes('class="applicability"'));
});

test('guides without applicability fields render no panel', () => {
  // Owner removed the placeholder values pending verified ones; the panel
  // must stay absent until real applies_to/last_validated fields return.
  for (const url of [
    'known-good-designs/upstream-rancher-cluster/rancher-rke2-small',
    'known-good-designs/downstream-rke2-cluster/rke2-custom-vms',
  ]) {
    assert.ok(!readPage(url).includes('class="applicability"'), url);
  }
});

function modified(url) {
  return readPage(url).match(/"dateModified":"([^"]+)"/)?.[1];
}

test('last_validated overrides dateModified when it differs from date', () => {
  assert.match(modified('theme-fixture-guide'), /^2023-01-15T/);
});

test('dateModified falls back to the page date without last_validated', () => {
  assert.match(modified('theme-fixture-short'), /^2020-01-01T/);
});

test('dateModified never precedes the publish date', () => {
  assert.match(modified('theme-fixture-guide-early'), /^2020-01-01T/);
});
