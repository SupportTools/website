import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, readPage } from './site.mjs';

function linkedCss() {
  const hrefs = [...readPage('/').matchAll(/<link[^>]+href="[^"]*?(\/css\/main\.min\.[^"]+\.css)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0, 'home page links the compiled main stylesheet');
  return fs.readFileSync(path.join(PUBLIC_DIR, hrefs[0]), 'utf8');
}

test('single-row header layout starts at 84rem, not 64rem', () => {
  const css = linkedCss();
  const row = css.match(/@media\s*\(min-width:\s*84rem\)\{[^@]*?\.site-header-inner\{[^}]*flex-direction:\s*row/);
  assert.ok(row, 'header row layout lives in the 84rem media query');
  assert.ok(!/@media\s*\(min-width:\s*64rem\)/.test(css), 'no 64rem header breakpoint remains');
});
