import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFrontmatter, pagePathFor, loadPages, liveAt, linkProblems, expectedUtmSource,
} from '../../scripts/social/lib/links.mjs';

test('parseFrontmatter reads url, date and draft', () => {
  const fm = parseFrontmatter('---\ntitle: "X"\ndate: 2026-10-22T09:00:00-05:00\ndraft: false\nurl: "/x-y/"\n---\nbody');
  assert.deepEqual(fm, { url: '/x-y/', date: '2026-10-22T09:00:00-05:00', draft: false });
  assert.equal(parseFrontmatter('no frontmatter'), null);
});

test('pagePathFor uses url when set, else /post/<file name>/ for posts', () => {
  assert.equal(pagePathFor('post/a-b.md', { url: '/a-b/' }), '/a-b/');
  assert.equal(pagePathFor('post/a-b.md', { url: 'a-b' }), '/a-b/');
  assert.equal(pagePathFor('post/kubernetes-cpu-limits.md', {}), '/post/kubernetes-cpu-limits/');
  assert.equal(pagePathFor('known-good-designs/x/y.md', {}), null);
});

function contentTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('loadPages maps each page path to its file, date and draft flag', () => {
  const dir = contentTree({
    'post/with-url.md': '---\ndate: 2026-10-20T00:00:00-05:00\nurl: "/with-url/"\n---\n',
    'post/no-url.md': '---\ndate: 2026-10-22T09:00:00-05:00\n---\n',
    'post/drafty.md': '---\ndate: 2026-10-22T09:00:00-05:00\ndraft: true\nurl: "/drafty/"\n---\n',
  });
  const pages = loadPages(dir);
  assert.equal(pages.get('/with-url/').file, 'post/with-url.md');
  assert.equal(pages.get('/post/no-url/').file, 'post/no-url.md');
  assert.equal(pages.get('/drafty/').draft, true);
  assert.equal(pages.has('/no-url/'), false);
});

test('liveAt is the first rebuild (06:00, 14:10, 15:10 UTC) after the date, plus 15 minutes', () => {
  // 09:00 CDT = 14:00 UTC -> 14:10 rebuild -> live 14:25
  assert.equal(liveAt(new Date('2026-10-22T09:00:00-05:00')).toISOString(), '2026-10-22T14:25:00.000Z');
  // 00:00 CDT = 05:00 UTC -> 06:00 rebuild -> live 06:15
  assert.equal(liveAt(new Date('2026-10-23T00:00:00-05:00')).toISOString(), '2026-10-23T06:15:00.000Z');
  // after the last rebuild of the day -> next day's 06:00
  assert.equal(liveAt(new Date('2026-10-22T16:00:00Z')).toISOString(), '2026-10-23T06:15:00.000Z');
});

test('expectedUtmSource follows the channel', () => {
  assert.equal(expectedUtmSource('linkedin'), 'linkedin');
  assert.equal(expectedUtmSource('bluesky'), 'bluesky');
});

const pages = new Map([
  ['/good/', { file: 'post/good.md', date: '2026-10-22T00:00:00-05:00', draft: false }],
  ['/post/no-url/', { file: 'post/no-url.md', date: '2026-10-22T09:00:00-05:00', draft: false }],
  ['/draft/', { file: 'post/draft.md', date: '2026-10-20T00:00:00-05:00', draft: true }],
]);
const post = (link, dueAt, ch = 'bluesky') => ({ id: 'p1', channelService: ch, dueAt, link });

test('linkProblems: a correct link to an article live in time has no problems', () => {
  assert.deepEqual(linkProblems(post('https://support.tools/good/?utm_source=bluesky&utm_medium=social', '2026-10-22T13:53:00Z'), pages), []);
});

test('linkProblems: the incident case, a root link to a post that only exists under /post/', () => {
  const p = linkProblems(post('https://support.tools/no-url/?utm_source=linkedin&utm_medium=social', '2026-10-22T22:33:00Z', 'linkedin'), pages);
  assert.equal(p.length, 1);
  assert.match(p[0], /no page at \/no-url\/; the article is at \/post\/no-url\//);
});

test('linkProblems: post goes out before the article is live', () => {
  const p = linkProblems(post('https://support.tools/post/no-url/?utm_source=bluesky&utm_medium=social', '2026-10-22T13:53:00Z'), pages);
  assert.match(p.join(' '), /not live until 2026-10-22T14:25/);
});

test('linkProblems: draft article, missing or wrong utm, no link, wrong host', () => {
  assert.match(linkProblems(post('https://support.tools/draft/?utm_source=bluesky', '2026-10-25T00:00:00Z'), pages).join(' '), /draft/);
  assert.match(linkProblems(post('https://support.tools/good/', '2026-10-25T00:00:00Z'), pages).join(' '), /utm_source/);
  assert.match(linkProblems(post('https://support.tools/good/?utm_source=linkedin', '2026-10-25T00:00:00Z'), pages).join(' '), /utm_source=linkedin.*bluesky/);
  assert.match(linkProblems(post('', '2026-10-25T00:00:00Z'), pages).join(' '), /no link/);
  assert.match(linkProblems(post('https://example.com/good/?utm_source=bluesky', '2026-10-25T00:00:00Z'), pages).join(' '), /not a support.tools link/);
});
