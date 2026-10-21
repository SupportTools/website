import test from 'node:test';
import assert from 'node:assert/strict';
import { readPost, setImages, prioritize, excerpt, cdnKey } from '../../scripts/og/lib/posts.mjs';
import { shortTitle, chipLabel, titlePointsize } from '../../scripts/og/lib/compose.mjs';
import { parseVerdict } from '../../scripts/og/lib/ai.mjs';
import { serialize, needsWork } from '../../scripts/og/lib/manifest.mjs';

const URL1 = 'https://cdn.support.tools/posts/a/og-1.jpg';
const URL2 = 'https://cdn.support.tools/posts/a/og-2.jpg';
const yaml = (extra = '') => `---\ntitle: "A: b"\ncategories:\n- Networking\n${extra}---\n\nBody\n\`\`\`yaml\nimages:\n- name: x\n\`\`\`\n`;

test('setImages appends to YAML frontmatter and leaves body images: alone', () => {
  const out = setImages(yaml(), URL1);
  assert.match(out, /- Networking\nimages: \["https:\/\/cdn\.support\.tools\/posts\/a\/og-1\.jpg"\]\n---/);
  assert.match(out, /```yaml\nimages:\n- name: x/);
});

test('setImages replaces an existing YAML value, inline or block list', () => {
  const once = setImages(yaml(), URL1);
  assert.equal(setImages(once, URL2), setImages(yaml(), URL2));
  const block = setImages(yaml('images:\n  - /old.png\n  - /old2.png\n'), URL1);
  assert.equal(block, setImages(yaml(), URL1));
});

test('setImages handles TOML frontmatter', () => {
  const toml = '+++\ntitle = "T"\ncategories = ["Linux", "Ops"]\n+++\nbody\n';
  const out = setImages(toml, URL1);
  assert.match(out, /categories = \["Linux", "Ops"\]\nimages = \["https:.*og-1\.jpg"\]\n\+\+\+/);
  assert.equal(setImages(out, URL2).match(/images =/g).length, 1);
  assert.deepEqual(readPost('/x/t.md', toml).categories, ['Linux', 'Ops']);
});

test('readPost reads the fields the pipeline uses', () => {
  const p = readPost('/c/post/my-slug.md', yaml('date: 2026-10-25T09:00:00-05:00\ndraft: false\n'));
  assert.equal(p.slug, 'my-slug');
  assert.equal(p.title, 'A: b');
  assert.deepEqual(p.categories, ['Networking']);
  assert.equal(p.draft, false);
});

test('shortTitle keeps the hook before the colon and cuts long titles at a word', () => {
  assert.equal(shortTitle('Cilium MTU Black Hole: How a Bridge Broke VXLAN'), 'Cilium MTU Black Hole');
  const long = shortTitle('Advanced Assembly Language Optimization Techniques for Modern Processors and Some More Words');
  assert.ok(long.length <= 72);
  assert.ok(!long.endsWith(' '));
  assert.equal(chipLabel([]), 'SUPPORT.TOOLS');
  assert.equal(chipLabel(['Networking']), 'NETWORKING');
  assert.ok(titlePointsize('Short') > titlePointsize('x'.repeat(60)));
});

test('prioritize: next two weeks, then live newest first, then later queue', () => {
  const now = new Date('2026-10-21T12:00:00-05:00');
  const p = (slug, date) => ({ slug, date });
  const order = prioritize([
    p('far', '2027-03-01T00:00:00-06:00'),
    p('old', '2024-01-01T00:00:00-06:00'),
    p('soon', '2026-10-25T09:00:00-05:00'),
    p('recent', '2026-10-01T00:00:00-05:00'),
    p('later', '2026-12-01T00:00:00-06:00'),
  ], now).map((x) => x.slug);
  assert.deepEqual(order, ['soon', 'recent', 'old', 'later', 'far']);
});

test('parseVerdict fails closed', () => {
  assert.deepEqual(parseVerdict('ok {"verdict":"pass","reason":"fine"}\n'), { verdict: 'pass', reason: 'fine' });
  assert.equal(parseVerdict('looks great').verdict, 'doubt');
  assert.equal(parseVerdict('{"verdict":"PASS!"}').verdict, 'doubt');
  assert.equal(parseVerdict('{"verdict": pass}').verdict, 'doubt');
});

test('manifest helpers', () => {
  assert.equal(serialize({ b: { status: 'live' }, a: { status: 'flagged' } }), '{\n  "a": {"status":"flagged"},\n  "b": {"status":"live"}\n}\n');
  assert.ok(needsWork(undefined));
  assert.ok(needsWork({ status: 'ready' }));
  assert.ok(needsWork({ attempts: 0 }), 'run killed mid-card leaves an entry without status');
  assert.ok(!needsWork({ status: 'live' }));
  assert.ok(!needsWork({ status: 'flagged' }));
  assert.equal(cdnKey('s', 'abc'), 'posts/s/og-abc.jpg');
  assert.equal(excerpt('a\n```\ncode\n```\nb'), 'a\n\nb');
});
