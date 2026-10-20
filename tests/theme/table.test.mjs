import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from './site.mjs';

function fixtureTable(html) {
  const m = html.match(/<div class="table-scroll">\s*<table[\s\S]*?<\/table>\s*<\/div>/);
  assert.ok(m, 'table wrapped in .table-scroll');
  return m[0];
}

test('Markdown tables are wrapped in a scroll container', () => {
  const html = readPage('theme-fixture');
  assert.equal((html.match(/<table>/g) || []).length, 1, 'one content table');
  fixtureTable(html);
});

test('wrapped table keeps thead, th cells and column alignment', () => {
  const table = fixtureTable(readPage('theme-fixture'));
  assert.match(table, /<thead>\s*<tr>\s*<th style="text-align: left">Setting<\/th>/);
  assert.match(table, /<th style="text-align: right">Default<\/th>/);
  assert.match(table, /<th style="text-align: center">Description<\/th>/);
  assert.equal((table.match(/<tbody>/g) || []).length, 1);
  assert.equal((table.match(/<tr>/g) || []).length, 3);
  assert.match(table, /<td style="text-align: left"><code>replica-count<\/code><\/td>/);
});

test('Markdown output keeps the pipe table', () => {
  const md = readPage('theme-fixture/index.md');
  assert.match(md, /\| Setting \| Default \| Description \|/);
  assert.doesNotMatch(md, /table-scroll/);
});
