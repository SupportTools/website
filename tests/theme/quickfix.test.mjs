import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

test('quick_fix renders a labelled section with markdown code', () => {
  const html = readPage('theme-fixture');
  const m = html.match(/<section class="quick-fix"[^>]*>[\s\S]*?<\/section>/);
  assert.ok(m, 'section.quick-fix present');
  assert.match(m[0], /aria-labelledby="quick-fix-title"/);
  assert.match(m[0], /<h2 id="quick-fix-title" class="quick-fix-title">Quick fix<\/h2>/);
  assert.match(m[0], /<code>kubectl scale deploy\/app --replicas=0<\/code>/);
  assert.equal(html.match(/id="quick-fix-title"/g).length, 1, 'id appears once');
  assert.ok(!/href="#quick-fix-title"/.test(html), 'not in the TOC');
});

test('posts without quick_fix render no quick-fix box', () => {
  assert.ok(!readPage('theme-fixture-short').includes('quick-fix'));
});

test('markdown output carries the Quick fix section only when set', () => {
  const md = readPage('theme-fixture/index.md');
  assert.match(
    md,
    /\n## Quick fix\n\nScale the deployment to zero, then back to one: `kubectl scale deploy\/app --replicas=0`\n\n/,
  );
  assert.ok(!readPage('theme-fixture-short/index.md').includes('Quick fix'));
});
