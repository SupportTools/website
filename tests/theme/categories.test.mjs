import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCategories, checkPost, checkFiles, normalizeKey, parseAllowlist } from '../../scripts/check-categories.mjs';

const post = (cats) => `---\ntitle: "T"\ncategories: ${cats}\n---\nbody\n`;
const allow = ['Kubernetes', 'Golang', 'Site Reliability', 'AI/ML', 'A', 'B', 'C', 'D', 'E'];

test('inline list form is parsed', () => {
  assert.deepEqual(parseCategories(post('["Kubernetes", \'Golang\']')), ['Kubernetes', 'Golang']);
});

test('block list form is parsed', () => {
  const text = '---\ntitle: "T"\ncategories:\n- Kubernetes\n  - "Site Reliability"\nauthor: x\n---\n';
  assert.deepEqual(parseCategories(text), ['Kubernetes', 'Site Reliability']);
});

test('missing categories yield none; TOML without categories is clean', () => {
  assert.deepEqual(parseCategories('---\ntitle: "T"\n---\n'), []);
  assert.deepEqual(checkFiles([['t.md', '+++\ntitle = "T"\n+++\n']], allow), []);
});

test('TOML frontmatter with categories fails hard', () => {
  const f = checkFiles([['t.md', '+++\ntitle = "T"\ncategories = ["X"]\n+++\n']], allow);
  assert.equal(f.length, 1);
  assert.match(f[0], /^t\.md: TOML/);
});

// Hugo reads front matter keys case-insensitively, so "Categories" builds category
// pages exactly like "categories". 33 old TOML posts used the capitalised key and
// went unchecked, leaving off-list category pages in the sitemap.
test('capitalised Categories key is checked in TOML and YAML', () => {
  const t = checkFiles([['t.md', '+++\ntitle = "T"\nCategories = ["X"]\n+++\n']], allow);
  assert.equal(t.length, 1);
  assert.match(t[0], /^t\.md: TOML/);
  assert.deepEqual(parseCategories('---\nCategories: ["Kubernetes"]\n---\n'), ['Kubernetes']);
});

test('multi-line flow list fails hard instead of being skipped', () => {
  const f = checkFiles([['m.md', '---\ncategories: [\n  "X",\n  "Y"\n]\n---\n']], allow);
  assert.equal(f.length, 1);
  assert.match(f[0], /multi-line/);
});

test('allow-listed categories pass', () => {
  assert.deepEqual(checkPost(['Kubernetes', 'Golang'], allow), []);
});

test('unknown category fails', () => {
  const v = checkPost(['Kubernetez'], allow);
  assert.equal(v.length, 1);
  assert.match(v[0], /Kubernetez/);
});

test('slash name not in allow-list fails, in allow-list passes', () => {
  assert.ok(checkPost(['CI/CD'], allow).length >= 1);
  assert.deepEqual(checkPost(['AI/ML'], allow), []);
});

test('ampersand name not in allow-list fails with a specific message', () => {
  assert.ok(checkPost(['Dev & Ops'], allow).some((m) => /[/&]/.test(m) && /not allowed/.test(m)));
});

test('case and hyphen variants of an allow-listed name fail', () => {
  assert.ok(checkPost(['golang'], allow).some((m) => /Golang/.test(m)));
  assert.ok(checkPost(['Site-Reliability'], allow).some((m) => /Site Reliability/.test(m)));
  assert.equal(normalizeKey('Site-Reliability'), normalizeKey('site reliability'));
});

test('more than 4 categories fails, 4 passes', () => {
  assert.deepEqual(checkPost(['A', 'B', 'C', 'D'], allow), []);
  assert.ok(checkPost(['A', 'B', 'C', 'D', 'E'], allow).some((m) => /5 categories/.test(m)));
});

test('checkFiles prefixes the path and parseAllowlist reads a yaml list', () => {
  const f = checkFiles([['a.md', post('["Nope"]')], ['b.md', post('["A"]')]], allow);
  assert.equal(f.length, 1);
  assert.match(f[0], /^a\.md:/);
  assert.deepEqual(parseAllowlist('# c\n- A\n- "B/C"\n- \'D\'\n'), ['A', 'B/C', 'D']);
});
