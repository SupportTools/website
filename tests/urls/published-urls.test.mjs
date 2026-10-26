import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtPaths, unresolved, mergeBaseline } from '../../scripts/check-published-urls.mjs';

function site(paths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-'));
  for (const p of paths) {
    fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, p, 'index.html'), '<html></html>');
  }
  fs.writeFileSync(path.join(dir, '404.html'), 'not found');
  return dir;
}

test('builtPaths lists HTML pages and leaves out pagination', () => {
  const dir = site(['/', '/post/a/', '/tags/x/', '/tags/x/page/2/', '/archive/page/3/', '/categories/networking/']);
  assert.deepEqual([...builtPaths(dir)].sort(), ['/', '/categories/networking/', '/post/a/', '/tags/x/']);
});

test('a baseline URL that is still built passes', async () => {
  const dir = site(['/post/a/']);
  assert.deepEqual(await unresolved(['/post/a/'], dir), []);
});

test('a baseline URL that the Worker redirects to a built page passes', async () => {
  // /a/ -> /post/a/ (root slug fallback); /categories/http/ -> /categories/networking/ (merged category)
  const dir = site(['/post/a/', '/categories/networking/']);
  assert.deepEqual(await unresolved(['/a/', '/categories/http/'], dir), []);
});

test('a retired post passes through src/post-redirects.json only while its replacement is built', async () => {
  const keeper = '/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/';
  assert.deepEqual(await unresolved(['/nginx-ingress-controller-tuning/'], site([keeper])), []);
  const bad = await unresolved(['/nginx-ingress-controller-tuning/'], site(['/post/a/']));
  assert.match(bad[0].why, new RegExp(`redirects to ${keeper} which returns 404`));
});

test('a baseline URL that no longer resolves fails, with what it returned', async () => {
  const dir = site(['/post/a/']);
  const bad = await unresolved(['/post/removed/', '/tags/gone/'], dir);
  assert.deepEqual(bad.map((b) => b.path), ['/post/removed/', '/tags/gone/']);
  assert.match(bad[0].why, /404/);
});

test('a redirect to a page that is not built fails', async () => {
  // /categories/http/ redirects to /categories/networking/, which this build lacks.
  const bad = await unresolved(['/categories/http/'], site(['/post/a/']));
  assert.match(bad[0].why, /redirects to \/categories\/networking\/ which returns 404/);
});

test('mergeBaseline only ever adds URLs', () => {
  assert.deepEqual(mergeBaseline(['/b/', '/a/'], new Set(['/c/', '/a/'])), ['/a/', '/b/', '/c/']);
});
