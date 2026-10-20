import test from 'node:test';
import assert from 'node:assert/strict';
import { statusText } from '../../blog/themes/m10c/assets/js/enhance.js';

test('statusText reports success', () => {
  assert.equal(statusText(true), 'Copied to clipboard');
});

test('statusText reports failure with a manual fallback', () => {
  assert.equal(statusText(false), 'Copy failed, select the code manually');
});
