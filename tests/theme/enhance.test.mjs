import test from 'node:test';
import assert from 'node:assert/strict';
import { pickActive, statusText } from '../../blog/themes/m10c/assets/js/enhance.js';

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
