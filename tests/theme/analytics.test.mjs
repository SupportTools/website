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
