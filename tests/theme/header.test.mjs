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

test('single-row header layout starts at 72rem, not 64rem', () => {
  const css = linkedCss();
  const row = css.match(/@media\s*\(min-width:\s*72rem\)\{[^@]*?\.site-header-inner\{[^}]*flex-direction:\s*row/);
  assert.ok(row, 'header row layout lives in the 72rem media query');
  assert.ok(!/@media\s*\(min-width:\s*64rem\)/.test(css), 'no 64rem header breakpoint remains');
});

test('primary nav has exactly the five reader-task links', () => {
  const nav = readPage('/').match(/<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'home page has the primary nav');
  const links = [...nav[1].matchAll(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2].trim(), new URL(m[1], 'http://localhost/').pathname]);
  assert.deepEqual(links, [
    ['Search', '/search/'],
    ['Topics', '/categories/'],
    ['Training', '/training/'],
    ['Reference Designs', '/known-good-designs/'],
    ['About', '/about/'],
  ]);
});

test('about page links to Certifications and Publications', () => {
  const html = readPage('/about/');
  assert.match(html, /<a[^>]+href="[^"]*\/certificates\/"[^>]*>Certifications<\/a>/);
  assert.match(html, /<a[^>]+href="[^"]*\/publications\/"[^>]*>Publications<\/a>/);
});
