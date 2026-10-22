import test from 'node:test';
import assert from 'node:assert/strict';
import { pickActive, statusText, queryFromUrl, urlWithQuery, readRatio, visibleMs, shouldSendRead, track } from '../../blog/themes/m10c/assets/js/enhance.js';

test('statusText reports success', () => {
  assert.equal(statusText(true), 'Copied to clipboard');
});

test('statusText reports failure with a manual fallback', () => {
  assert.equal(statusText(false), 'Copy failed, select the code manually');
});

test('pickActive returns the first visible heading in document order', () => {
  assert.equal(pickActive(new Set(['b', 'c']), ['a', 'b', 'c'], 'a'), 'b');
});

test('pickActive keeps the previous heading when none are visible', () => {
  assert.equal(pickActive(new Set(), ['a', 'b', 'c'], 'a'), 'a');
});

test('pickActive returns null when nothing is visible and nothing was active', () => {
  assert.equal(pickActive(new Set(), ['a', 'b', 'c'], null), null);
});

test('queryFromUrl reads the q parameter', () => {
  assert.equal(queryFromUrl('http://localhost/search/?q=rke2'), 'rke2');
});

test('queryFromUrl decodes plus signs and percent escapes', () => {
  assert.equal(queryFromUrl('http://localhost/search/?q=cilium+bgp%20peering'), 'cilium bgp peering');
});

test('queryFromUrl returns an empty string when q is absent or empty', () => {
  assert.equal(queryFromUrl('http://localhost/search/'), '');
  assert.equal(queryFromUrl('http://localhost/search/?q='), '');
});

test('queryFromUrl returns markup as plain text, unchanged', () => {
  assert.equal(queryFromUrl('http://localhost/search/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E'), '<script>alert(1)</script>');
});

test('urlWithQuery sets q and keeps the path and hash', () => {
  assert.equal(urlWithQuery('http://localhost/search/#x', 'rke2'), '/search/?q=rke2#x');
});

test('urlWithQuery encodes the query', () => {
  assert.equal(urlWithQuery('http://localhost/search/', 'a b&c'), '/search/?q=a+b%26c');
});

test('urlWithQuery removes q when the query is blank, keeping other parameters', () => {
  assert.equal(urlWithQuery('http://localhost/search/?q=rke2&x=1', '  '), '/search/?x=1');
  assert.equal(urlWithQuery('http://localhost/search/?q=rke2', ''), '/search/');
});

test('readRatio measures how far into the article body the reader has seen', () => {
  assert.equal(readRatio(0, 800, 200, 2400), 0.25);
  assert.equal(readRatio(5000, 800, 200, 2400), 1);
  assert.equal(readRatio(0, 800, 1200, 2400), 0);
  assert.equal(readRatio(0, 800, 0, 0), 1);
});

test('visibleMs only counts time while the tab is visible', () => {
  assert.equal(visibleMs(1000, 0, 5000, false), 6000);
  assert.equal(visibleMs(1000, 0, 5000, true), 1000);
});

test('shouldSendRead needs 75% and 30 s of visible time, once', () => {
  assert.equal(shouldSendRead(0.75, 30000, false), true);
  assert.equal(shouldSendRead(0.74, 60000, false), false);
  assert.equal(shouldSendRead(1, 29999, false), false);
  assert.equal(shouldSendRead(1, 30000, true), false);
});

test('track is a no-op without PostHog and calls capture when present', () => {
  delete globalThis.window;
  assert.equal(track('code_copied'), false);
  globalThis.window = {};
  assert.equal(track('code_copied'), false);
  const calls = [];
  globalThis.window = { posthog: { capture: (...a) => calls.push(a) } };
  assert.equal(track('article_read', { read_ratio: 1 }), true);
  assert.deepEqual(calls, [['article_read', { read_ratio: 1 }]]);
  delete globalThis.window;
});
