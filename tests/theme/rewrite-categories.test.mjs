import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap, validateMap, rewriteText, mapCategories } from '../../scripts/lib/category-rewrite.mjs';

const MAP = parseMap(`
merge:
  "Golang": "Go"
  "Go Programming": "Go"
  "AI/ML": "AI & ML"
demote:
  "Cilium": "Networking"
  "Misc": null
hubs:
  "Go & Programming":
    - "Go"
`);

const fm = (body) => `---\ntitle: "T"\n${body}\nauthor: "A"\n---\n\nBody text\n`;
const run = (text) => rewriteText(text, MAP);

test('map parser reads merge, demote and hubs', () => {
  assert.equal(MAP.merge.get('AI/ML'), 'AI & ML');
  assert.equal(MAP.demote.get('Cilium'), 'Networking');
  assert.equal(MAP.demote.get('Misc'), null);
  assert.deepEqual(MAP.hubs.get('Go & Programming'), ['Go']);
});

test('map validation rejects chains and slash tags', () => {
  const bad = parseMap('merge:\n  "A": "B"\n  "B": "C"\ndemote:\n  "X/Y": null\n');
  const errs = validateMap(bad);
  assert.equal(errs.length, 2);
  assert.match(errs.join(), /itself mapped/);
  assert.match(errs.join(), /"\/" or "&"/);
});

test('map parser rejects a source mapped twice', () => {
  assert.throws(() => parseMap('merge:\n  "A": "B"\ndemote:\n  "A": null\n'), /more than once/);
});

test('inline list: merge replaces in place and keeps quote style', () => {
  const r = run(fm('categories: ["Kubernetes", "Golang"]\ntags: ["x"]'));
  assert.equal(r.text, fm('categories: ["Kubernetes", "Go"]\ntags: ["x"]'));
  assert.deepEqual(r.after, ['Kubernetes', 'Go']);
});

test('inline list: single-quoted and bare styles are preserved for kept items', () => {
  const r = run(fm("categories: [Linux, 'Golang']"));
  assert.equal(r.text, fm("categories: [Linux, 'Go']"));
});

test('block list: merge rewrites the item line and keeps indent', () => {
  const r = run(fm('categories:\n  - Kubernetes\n  - "Golang"'));
  assert.equal(r.text, fm('categories:\n  - Kubernetes\n  - "Go"'));
});

test('dedupe: two sources of one target collapse, inline', () => {
  const r = run(fm('categories: ["Golang", "Go Programming", "Go"]'));
  assert.equal(r.text, fm('categories: ["Go"]'));
});

test('dedupe: block list drops the extra lines', () => {
  const r = run(fm('categories:\n- Go Programming\n- Linux\n- Go'));
  assert.equal(r.text, fm('categories:\n- Go\n- Linux'));
});

test('slash name becomes the ampersand name', () => {
  const r = run(fm('categories: ["AI/ML"]'));
  assert.equal(r.text, fm('categories: ["AI & ML"]'));
});

test('scalar categories value is rewritten', () => {
  assert.equal(run(fm('categories: Golang')).text, fm('categories: Go'));
});

test('demote appends the label to an existing inline tags list', () => {
  const r = run(fm('categories: ["Linux", "Cilium"]\ntags: ["a", "b"]'));
  assert.equal(r.text, fm('categories: ["Linux"]\ntags: ["a", "b", "Cilium"]'));
  assert.deepEqual(r.tags, ['Cilium']);
});

test('demote appends to a block tags list that comes first', () => {
  const r = run(fm('tags:\n- a\n- b\ncategories:\n- Linux\n- Cilium'));
  assert.equal(r.text, fm('tags:\n- a\n- b\n- Cilium\ncategories:\n- Linux'));
});

test('demote creates a tags key after an inline categories line', () => {
  const r = run(fm('categories: ["Linux", "Cilium"]'));
  assert.equal(r.text, fm('categories: ["Linux"]\ntags: ["Cilium"]'));
});

test('demote creates a block tags key after a block categories list', () => {
  const r = run(fm('categories:\n- Linux\n- Cilium'));
  assert.equal(r.text, fm('categories:\n- Linux\ntags:\n- Cilium'));
});

test('demote does not duplicate a tag that exists in another case', () => {
  const r = run(fm('categories: ["Linux", "Cilium"]\ntags: ["cilium"]'));
  assert.equal(r.text, fm('categories: ["Linux"]\ntags: ["cilium"]'));
  assert.deepEqual(r.tags, []);
});

test('demote into empty tags list and scalar tags', () => {
  assert.equal(run(fm('categories: ["Linux", "Cilium"]\ntags: []')).text, fm('categories: ["Linux"]\ntags: ["Cilium"]'));
  assert.equal(run(fm('categories: ["Linux", "Cilium"]\ntags: kube')).text, fm('categories: ["Linux"]\ntags: [kube, "Cilium"]'));
});

test('fallback category is used only when nothing else is left', () => {
  assert.equal(run(fm('categories: ["Cilium"]')).text, fm('categories: ["Networking"]\ntags: ["Cilium"]'));
  assert.equal(run(fm('categories: ["Cilium", "Linux"]')).text, fm('categories: ["Linux"]\ntags: ["Cilium"]'));
});

test('a post left with no category is reported and not rewritten', () => {
  const text = fm('categories: ["Misc"]');
  const r = run(text);
  assert.equal(r.text, text);
  assert.equal(r.changed, false);
  assert.equal(r.problems.length, 1);
});

test('lines outside categories and tags are byte-identical', () => {
  const text = '---\ntitle: "A: tricky # title"\ndate: 2025-01-01T00:00:00-00:00\ncategories:   ["Golang"]   # keep\nweird:   spacing  \nseries_rank: 3\n---\n\n```yaml\ncategories: ["Golang"]\n```\n';
  const r = run(text);
  assert.equal(r.text, text.replace('["Golang"]   # keep', '["Go"]   # keep').replace('categories:   [', 'categories:   ['));
});

test('categories text in the body is never touched', () => {
  const text = fm('categories: ["Linux"]') + '\ncategories: ["Golang"]\n';
  const r = run(text);
  assert.equal(r.changed, false);
});

test('posts without frontmatter or categories are untouched', () => {
  assert.equal(run('# no frontmatter\ncategories: ["Golang"]\n').changed, false);
  assert.equal(run(fm('tags: ["x"]')).changed, false);
});

test('CRLF line endings are preserved on edited and inserted lines', () => {
  const text = '---\r\ntitle: "T"\r\ncategories: ["Linux", "Cilium"]\r\n---\r\nbody\r\n';
  const r = run(text);
  assert.equal(r.text, '---\r\ntitle: "T"\r\ncategories: ["Linux"]\r\ntags: ["Cilium"]\r\n---\r\nbody\r\n');
});

test('unsupported multi-line flow list is reported, not rewritten', () => {
  const text = fm('categories: [\n  "Golang"\n]');
  const r = run(text);
  assert.equal(r.text, text);
  assert.equal(r.problems.length, 1);
});

test('multi-line flow tags list with a demoted category is reported, not written', () => {
  const text = fm('categories: ["Linux", "Cilium"]\ntags: [\n  "a"\n]');
  const r = run(text);
  assert.equal(r.text, text);
  assert.equal(r.changed, false);
  assert.deepEqual(r.tags, []);
  assert.match(r.problems.join(), /unsupported tags shape/);
});

test('idempotent: running twice equals running once', () => {
  const inputs = [
    fm('categories: ["Golang", "Cilium", "Go Programming"]'),
    fm('categories:\n- Go Programming\n- Cilium\n- Linux\ntags:\n- x'),
    fm('tags: ["a"]\ncategories: ["AI/ML", "Cilium"]'),
    fm('categories: ["Cilium"]'),
    fm('categories: Golang'),
  ];
  for (const t of inputs) {
    const once = run(t);
    const twice = run(once.text);
    assert.equal(twice.text, once.text);
    assert.equal(twice.changed, false);
  }
});

test('mapCategories keeps order of first appearance', () => {
  assert.deepEqual(mapCategories(['B', 'Golang', 'A', 'Go Programming'], MAP).categories, ['B', 'Go', 'A']);
});

test('the shipped draft map is valid and chain-free', () => {
  const map = parseMap(readFileSync('blog/data/category-map.yaml', 'utf8'));
  assert.deepEqual(validateMap(map), []);
  assert.ok(map.merge.size > 100 && map.demote.size > 100);
});
