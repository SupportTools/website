import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHeaders, patternMatches, productionViolations, appendNonProdNoindex } from '../../scripts/headers-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/headers-guard.mjs');
const SITE_RULES = fs.readFileSync(path.join(ROOT, 'blog/static/_headers'), 'utf8');
const HTML_PATHS = ['/', '/archive/', '/archive/page/2/', '/post/', '/tags/kubernetes/', '/some-post/', '/some-post/index.html'];

const isNoindex = (rules, p) => rules.some((r) => patternMatches(r.pattern, p)
  && r.headers.some((h) => h.name === 'x-robots-tag' && /noindex/.test(h.value)));

test('parseHeaders reads rules and headers and skips comments and detaches', () => {
  const rules = parseHeaders('# c\n/*.md\n  X-Robots-Tag: noindex\n  ! Link\n\n/a/:b\n  X-Test: 1\n');
  assert.deepEqual(rules, [
    { pattern: '/*.md', headers: [{ name: 'x-robots-tag', value: 'noindex' }] },
    { pattern: '/a/:b', headers: [{ name: 'x-test', value: '1' }] },
  ]);
});

test('patternMatches follows Cloudflare splat and placeholder rules', () => {
  assert.ok(patternMatches('/*.md', '/slug/index.md'));
  assert.ok(!patternMatches('/*.md', '/slug/'));
  assert.ok(patternMatches('/tags/*/index.xml', '/tags/adprep/index.xml'));
  assert.ok(!patternMatches('/tags/*/index.xml', '/index.xml'));
  assert.ok(!patternMatches('/tags/*/index.xml', '/tags/adprep/'));
  assert.ok(patternMatches('/movies/:title', '/movies/x'));
  assert.ok(!patternMatches('/movies/:title', '/movies/x/y'));
  assert.ok(patternMatches('/*', '/'));
  assert.ok(patternMatches('https://support.tools/*', '/a/'));
});

test('the shipped _headers marks Markdown and term feeds noindex but no HTML page', () => {
  const rules = parseHeaders(SITE_RULES);
  for (const p of ['/slug/index.md', '/tags/adprep/index.xml', '/categories/kubernetes/index.xml']) {
    assert.ok(isNoindex(rules, p), p);
  }
  for (const p of [...HTML_PATHS, '/index.xml', '/sitemap.xml', '/llms.txt', '/post-index.json']) {
    assert.ok(!isNoindex(rules, p), p);
  }
  assert.deepEqual(productionViolations(SITE_RULES, HTML_PATHS), []);
});

test('production refuses a site-wide noindex rule', () => {
  const v = productionViolations(`${SITE_RULES}\n/*\n  X-Robots-Tag: noindex\n`, HTML_PATHS);
  assert.ok(v.length > 0);
  assert.match(v[0], /site-wide/);
});

test('production refuses a noindex rule that reaches an HTML page', () => {
  const v = productionViolations('/tags/*\n  X-Robots-Tag: noindex\n', HTML_PATHS);
  assert.ok(v.some((m) => m.includes('/tags/kubernetes/')), v.join('\n'));
});

test('production accepts non-noindex headers on HTML pages', () => {
  assert.deepEqual(productionViolations('/*\n  X-Frame-Options: DENY\n', HTML_PATHS), []);
});

test('non-production append keeps the existing rules and adds a site-wide noindex', () => {
  const out = appendNonProdNoindex(SITE_RULES);
  assert.ok(out.startsWith(SITE_RULES));
  const rules = parseHeaders(out);
  assert.equal(rules.length, parseHeaders(SITE_RULES).length + 1);
  for (const p of [...HTML_PATHS, '/slug/index.md']) assert.ok(isNoindex(rules, p), p);
  assert.ok(productionViolations(out, HTML_PATHS).length > 0, 'production would refuse the non-prod file');
  assert.ok(appendNonProdNoindex('').includes('/*\n  X-Robots-Tag: noindex\n'));
  assert.ok(appendNonProdNoindex('/a\n  X-Test: 1').includes('X-Test: 1\n\n/*\n'), 'adds a separator newline');
});

test('CLI: production check passes on the shipped file and fails after the non-prod append', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headers-guard-'));
  try {
    fs.mkdirSync(path.join(dir, 'post-a'));
    fs.writeFileSync(path.join(dir, 'post-a', 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, '_headers'), SITE_RULES);
    let r = spawnSync(process.execPath, [SCRIPT, 'production', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [SCRIPT, 'nonprod', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(path.join(dir, '_headers'), 'utf8').startsWith(SITE_RULES));
    r = spawnSync(process.execPath, [SCRIPT, 'production', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: non-prod creates _headers when the build has none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headers-guard-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'nonprod', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, '_headers'), 'utf8'), appendNonProdNoindex(''));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
