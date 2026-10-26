import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTag, tagUsage, checkTags } from '../../scripts/check-tags.mjs';

const post = (tags) => `---\ntitle: "T"\ntags: [${tags.map((t) => `"${t}"`).join(', ')}]\n---\nbody\n`;

test('normalizeTag folds case and spaces the way Hugo builds term URLs', () => {
  assert.equal(normalizeTag(' Cert Manager '), 'cert-manager');
  assert.equal(normalizeTag('Go'), 'go');
});

test('tagUsage counts each post once per normalized tag', () => {
  const usage = tagUsage([
    ['a.md', post(['Go', 'go', 'Kubernetes'])],
    ['b.md', post(['kubernetes'])],
  ]);
  assert.deepEqual(usage.get('go').files, ['a.md']);
  assert.deepEqual(usage.get('kubernetes').files, ['a.md', 'b.md']);
});

test('a brand-new tag on a single post fails', () => {
  const failures = checkTags(
    [['blog/content/post/new.md', post(['kubernetes', 'shiny-new'])], ['b.md', post(['kubernetes'])]],
    new Set(['kubernetes']),
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /blog\/content\/post\/new\.md: tag "shiny-new" is used by no other post/);
});

test('a known single-use tag in the baseline passes', () => {
  assert.deepEqual(checkTags([['a.md', post(['legacy-one-off'])]], new Set(['legacy-one-off'])), []);
});

test('a new tag shared by two posts passes without a baseline entry', () => {
  assert.deepEqual(checkTags([['a.md', post(['pair'])], ['b.md', post(['pair'])]], new Set()), []);
});

test('a new tag that is a spelling variant of a known tag points at the known one', () => {
  const failures = checkTags([['a.md', post(['Cert_Manager'])]], new Set(['cert-manager']));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /use "cert-manager"/);
});

test('block-list tags are read too', () => {
  const usage = tagUsage([['a.md', '---\ntags:\n  - "One"\n  - two\n---\n']]);
  assert.deepEqual([...usage.keys()].sort(), ['one', 'two']);
});

test('section index files do not count as posts', () => {
  const usage = tagUsage([['blog/content/tags/c++/_index.md', post(['solo'])]]);
  assert.equal(usage.size, 0);
});
