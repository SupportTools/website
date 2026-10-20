import test from 'node:test';
import assert from 'node:assert/strict';
import { pickActive, statusText, queryFromUrl, urlWithQuery } from '../../blog/themes/m10c/assets/js/enhance.js';

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
