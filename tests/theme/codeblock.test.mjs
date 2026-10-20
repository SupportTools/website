import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPage } from './site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const layouts = path.join(root, 'blog/themes/m10c/layouts');

// Each wrapper runs from its opening tag up to the next wrapper or the mermaid diagram.
function codeBlocks(html) {
  const starts = [...html.matchAll(/<div class="code-block"[^>]*>/g)].map((m) => m.index);
  const end = html.indexOf('class="mermaid"');
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? (end > start ? end : undefined)));
}

function copyLabel(block) {
  return block.match(/^<div class="code-block" data-copy-label="([^"]*)"/)[1];
}

test('every non-mermaid fence gets one code-block wrapper', () => {
  const html = readPage('theme-fixture');
  assert.equal(codeBlocks(html).length, 6);
  assert.match(html, /<pre class="mermaid">/);
  assert.doesNotMatch(html, /code-block-lang">mermaid/);
  assert.match(html, /<pre>raw pre block<\/pre>/);
});

test('copy labels follow the lang, filename and block-number rules', () => {
  const labels = codeBlocks(readPage('theme-fixture')).map(copyLabel);
  assert.deepEqual(labels, [
    'Copy bash code, block 1',
    'Copy yaml code from longhorn-settings.yaml',
    'Copy yaml code from a&lt;b&gt;.yaml',
    'Copy code, block 4',
    'Copy go code, block 5',
    'Copy go code, block 6',
  ]);
});

test('filename block shows lang and filename spans', () => {
  const block = codeBlocks(readPage('theme-fixture'))[1];
  assert.match(block, /<span class="code-block-lang">yaml<\/span>/);
  assert.match(block, /<span class="code-block-filename">longhorn-settings.yaml<\/span>/);
});

test('filename is HTML-escaped', () => {
  const block = codeBlocks(readPage('theme-fixture'))[2];
  assert.match(block, /<span class="code-block-filename">a&lt;b&gt;.yaml<\/span>/);
  assert.doesNotMatch(block, /<b>/);
});

test('unlabeled block has no language or filename span', () => {
  const block = codeBlocks(readPage('theme-fixture'))[3];
  assert.doesNotMatch(block, /code-block-lang/);
  assert.doesNotMatch(block, /code-block-filename/);
  assert.equal(copyLabel(block), 'Copy code, block 4');
});

test('blocks without a filename omit the filename span', () => {
  const blocks = codeBlocks(readPage('theme-fixture'));
  for (const i of [0, 3, 4, 5]) assert.doesNotMatch(blocks[i], /code-block-filename/);
});

test('every code-block header is ignored by pagefind', () => {
  const html = readPage('theme-fixture');
  const headers = [...html.matchAll(/<div class="code-block-header"([^>]*)>/g)];
  assert.equal(headers.length, 6);
  for (const h of headers) assert.match(h[1], /\bdata-pagefind-ignore\b/);
});

test('no button is rendered server side inside code blocks', () => {
  for (const block of codeBlocks(readPage('theme-fixture'))) {
    assert.doesNotMatch(block, /<button/);
  }
});

test('line-number options still apply inside the wrapper', () => {
  const blocks = codeBlocks(readPage('theme-fixture'));
  assert.match(blocks[4], /class="lntable"/);
  assert.match(blocks[5], /<span class="ln">/);
  assert.doesNotMatch(blocks[5], /lntable/);
});

test('Markdown output keeps the original filename fence', () => {
  const md = readPage('theme-fixture/index.md');
  assert.ok(md.includes('```yaml {filename="longhorn-settings.yaml"}'));
});

function assertNoLabels(text, where) {
  assert.doesNotMatch(text, /Copy/, `${where} contains Copy`);
  assert.doesNotMatch(text, /bash/, `${where} contains bash`);
}

test('summary-derived meta description omits code-block labels', () => {
  const html = readPage('theme-fixture-short');
  const meta = html.match(/<meta name="description"\s+content="([^"]*)"/);
  assert.ok(meta, 'meta description present');
  assert.match(meta[1], /Short fixture without a description/);
  assertNoLabels(meta[1], 'meta description');
});

test('summary-derived JSON-LD description omits code-block labels', () => {
  const html = readPage('theme-fixture-short');
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const article = scripts.map((m) => JSON.parse(m[1])).find((d) => d['@type'] === 'BlogPosting');
  assert.ok(article, 'BlogPosting JSON-LD present');
  assert.match(article.description, /Short fixture without a description/);
  assertNoLabels(article.description, 'JSON-LD description');
});

test('llms.txt entry for the short fixture omits code-block labels, when listed', (t) => {
  const line = readPage('llms.txt').split('\n').find((l) => l.includes('/theme-fixture-short/'));
  if (!line) {
    t.skip('theme-fixture-short is not listed in llms.txt');
    return;
  }
  assertNoLabels(line, 'llms.txt entry');
});

test('every summary consumer uses the plain-summary partial', () => {
  for (const rel of [
    'partials/posts-list.html',
    '_default/baseof.html',
    'partials/structured-data.html',
    'home.llms.txt',
  ]) {
    const src = fs.readFileSync(path.join(layouts, rel), 'utf8');
    assert.match(src, /partial "plain-summary\.html"/, rel);
    assert.doesNotMatch(src, /\.Summary \| plainify/, rel);
  }
});
