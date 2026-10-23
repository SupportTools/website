import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLink, preflight, promote, nextSlot, APPROVED_TAG } from '../../scripts/social/lib/guard.mjs';

const pages = new Map([
  ['/post/live/', { file: 'post/live.md', date: '2026-10-20T00:00:00-05:00', draft: false }],
  ['/post/today/', { file: 'post/today.md', date: '2026-10-27T09:00:00-05:00', draft: false }],
  ['/later/', { file: 'post/later.md', date: '2026-11-05T00:00:00-06:00', draft: false }],
]);
const NOW = new Date('2026-10-27T13:15:00Z'); // 08:15 Chicago
const link = (p, ch = 'bluesky') => `https://support.tools${p}?utm_source=${ch}&utm_medium=social`;
const post = (id, p, dueAt, extra = {}) => ({
  id, channelService: 'bluesky', status: 'scheduled', dueAt, link: link(p, extra.channelService || 'bluesky'),
  card: 'https://cdn.support.tools/posts/x/og-1.jpg', tags: [], node: { id }, ...extra,
});

// fake HTTP: path -> status, or { status, location }
function http(map) {
  return async (url, init) => {
    const u = new URL(url);
    const r = map[u.pathname] ?? map[url] ?? 404;
    const status = typeof r === 'number' ? r : r.status;
    const headers = typeof r === 'number' ? {} : { location: r.location };
    return new Response(null, { status, headers });
  };
}

test('checkLink follows redirects and reports the final status', async () => {
  const f = http({ '/a/': { status: 301, location: 'https://support.tools/post/a/?utm_source=x' }, '/post/a/': 200 });
  assert.deepEqual(await checkLink('https://support.tools/a/?utm_source=x', f), {
    status: 200, redirects: 1, finalUrl: 'https://support.tools/post/a/?utm_source=x',
  });
  assert.equal((await checkLink('https://support.tools/gone/', f)).status, 404);
});

test('checkLink treats network errors and redirect loops as failures', async () => {
  const boom = async () => { throw new Error('ECONNRESET'); };
  assert.equal((await checkLink('https://support.tools/x/', boom)).status, 0);
  const loop = http({ '/l/': { status: 301, location: 'https://support.tools/l/' } });
  assert.equal((await checkLink('https://support.tools/l/', loop)).status, 0);
});

test('preflight blocks a post due soon whose link does not return 200, and keeps the rest', async () => {
  const posts = [
    post('ok', '/post/live/', '2026-10-27T13:53:00Z'),
    post('dead', '/post/live-typo/', '2026-10-27T13:45:00Z'),
    post('later-bad', '/nope/', '2026-10-30T13:53:00Z'),
  ];
  const r = await preflight(posts, { pages, now: NOW, windowHours: 4, fetch: http({ '/post/live/': 200, '/posts/x/og-1.jpg': 200 }) });
  assert.deepEqual(r.block.map((x) => x.post.id), ['dead']);
  assert.deepEqual(r.problems.map((x) => x.post.id).sort(), ['dead', 'later-bad']);
  assert.equal(r.checked, 3);
});

test('preflight warns, but does not block, a due post that only works through a redirect', async () => {
  const posts = [post('redir', '/live/', '2026-10-27T13:53:00Z')];
  const f = http({ '/live/': { status: 301, location: 'https://support.tools/post/live/' }, '/post/live/': 200, '/posts/x/og-1.jpg': 200 });
  const r = await preflight(posts, { pages, now: NOW, windowHours: 4, fetch: f });
  assert.deepEqual(r.block, []);
  assert.match(r.problems[0].problems.join(' '), /no page at \/live\//);
  assert.match(r.problems[0].problems.join(' '), /redirects/);
});

test('preflight reports a broken share card', async () => {
  const r = await preflight([post('nocard', '/post/live/', '2026-10-27T13:53:00Z')], {
    pages, now: NOW, windowHours: 4, fetch: http({ '/post/live/': 200 }),
  });
  assert.deepEqual(r.block, []);
  assert.match(r.problems[0].problems.join(' '), /card .* 404/);
});

test('nextSlot gives the channel\'s next Chicago slot at least 10 minutes out', () => {
  // 08:15 CDT -> bluesky 08:53 CDT
  assert.equal(nextSlot('bluesky', new Date('2026-10-27T13:15:00Z')).toISOString(), '2026-10-27T13:53:00.000Z');
  // 08:50 CDT -> too close to 08:53, next is 16:26 CDT
  assert.equal(nextSlot('bluesky', new Date('2026-10-27T13:50:00Z')).toISOString(), '2026-10-27T21:26:00.000Z');
  // 18:00 CDT -> linkedin 08:45 next day
  assert.equal(nextSlot('linkedin', new Date('2026-10-27T23:00:00Z')).toISOString(), '2026-10-28T13:45:00.000Z');
  // after DST ends (CST, -06:00): 08:45 CST = 14:45 UTC
  assert.equal(nextSlot('linkedin', new Date('2026-11-03T12:00:00Z')).toISOString(), '2026-11-03T14:45:00.000Z');
});

test('promote schedules approved drafts whose article is live, keeping a future dueAt', async () => {
  const drafts = [
    post('a', '/post/live/', '2026-10-27T21:26:00Z', { status: 'draft', tags: [APPROVED_TAG] }),
    post('b', '/post/live/', '2026-10-26T13:53:00Z', { status: 'draft', tags: [APPROVED_TAG] }), // slot passed
    post('c', '/post/live/', '2026-10-28T13:53:00Z', { status: 'draft', tags: [] }), // not approved
    post('d', '/later/', '2026-11-05T14:53:00Z', { status: 'draft', tags: [APPROVED_TAG] }), // not live yet
  ];
  const r = await promote(drafts, { pages, now: NOW, fetch: http({ '/post/live/': 200, '/later/': 404 }) });
  assert.deepEqual(r.schedule.map((x) => [x.post.id, x.dueAt.toISOString()]), [
    ['a', '2026-10-27T21:26:00.000Z'],
    ['b', '2026-10-27T13:53:00.000Z'],
  ]);
  assert.deepEqual(r.skipped.map((x) => [x.post.id, x.reason]), [
    ['c', 'not approved'],
    ['d', 'article not live yet (HTTP 404)'],
  ]);
});

test('promote refuses an approved draft whose link has a static problem even if it resolves', async () => {
  const drafts = [post('e', '/live/', '2026-10-27T21:26:00Z', { status: 'draft', tags: [APPROVED_TAG] })];
  const f = http({ '/live/': { status: 301, location: 'https://support.tools/post/live/' }, '/post/live/': 200 });
  const r = await promote(drafts, { pages, now: NOW, fetch: f });
  assert.deepEqual(r.schedule, []);
  assert.match(r.skipped[0].reason, /no page at \/live\//);
});
