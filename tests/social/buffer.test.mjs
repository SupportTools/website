import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, normalize, editInput } from '../../scripts/social/lib/buffer.mjs';

const linkedinNode = {
  id: 'li1', status: 'scheduled', dueAt: '2026-10-27T22:33:00.000Z', channelService: 'linkedin',
  text: 'Body #Kubernetes', tags: [{ id: 't1', name: 'approved' }],
  assets: [{ source: 'https://cdn.support.tools/posts/a/og-1.jpg', thumbnail: 'https://cdn.support.tools/posts/a/og-1.jpg', image: { altText: 'card' } }],
  metadata: { __typename: 'LinkedInPostMetadata', firstComment: 'Full guide: https://support.tools/post/a/?utm_source=linkedin&utm_medium=social', linkAttachment: null },
};
const blueskyNode = {
  id: 'bs1', status: 'draft', dueAt: '2026-10-27T21:26:00.000Z', channelService: 'bluesky', text: 'One line', tags: [], assets: [],
  metadata: { __typename: 'BlueskyPostMetadata', linkAttachment: { url: 'https://support.tools/post/a/?utm_source=bluesky&utm_medium=social', title: 'T', text: 'D', thumbnail: 'https://cdn.support.tools/posts/a/og-1.jpg' } },
};

test('normalize pulls the link and card from each channel shape', () => {
  const li = normalize(linkedinNode);
  assert.equal(li.link, 'https://support.tools/post/a/?utm_source=linkedin&utm_medium=social');
  assert.equal(li.card, 'https://cdn.support.tools/posts/a/og-1.jpg');
  assert.deepEqual(li.tags, ['approved']);
  const bs = normalize(blueskyNode);
  assert.equal(bs.link, 'https://support.tools/post/a/?utm_source=bluesky&utm_medium=social');
  assert.equal(bs.card, 'https://cdn.support.tools/posts/a/og-1.jpg');
});

test('editInput resends text, metadata, assets and tags so nothing is lost', () => {
  const li = editInput(linkedinNode, { saveToDraft: true });
  assert.deepEqual(li, {
    id: 'li1', text: 'Body #Kubernetes', saveToDraft: true, tagIds: ['t1'],
    assets: [{ image: { url: 'https://cdn.support.tools/posts/a/og-1.jpg', thumbnailUrl: 'https://cdn.support.tools/posts/a/og-1.jpg', metadata: { altText: 'card' } } }],
    metadata: { linkedin: { firstComment: 'Full guide: https://support.tools/post/a/?utm_source=linkedin&utm_medium=social' } },
  });
  const bs = editInput(blueskyNode, { mode: 'customScheduled', dueAt: '2026-10-27T21:26:00.000Z', saveToDraft: false });
  assert.deepEqual(bs.metadata, { bluesky: { linkAttachment: { url: 'https://support.tools/post/a/?utm_source=bluesky&utm_medium=social', title: 'T', description: 'D', thumbnail: { url: 'https://cdn.support.tools/posts/a/og-1.jpg' } } } });
  assert.equal(bs.mode, 'customScheduled');
  assert.equal(bs.saveToDraft, false);
  assert.deepEqual(bs.assets, []);
});

function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, body });
    if (body.query.includes('editPost')) {
      if (body.variables.input.id === 'bad') return new Response(JSON.stringify({ data: { editPost: { __typename: 'InvalidInputError', message: 'nope' } } }));
      return new Response(JSON.stringify({ data: { editPost: { __typename: 'PostActionSuccess', post: { id: body.variables.input.id } } } }));
    }
    const page = pages[body.variables.after || ''];
    return new Response(JSON.stringify({ data: { posts: page } }));
  };
  fn.calls = calls;
  return fn;
}

test('posts follows pagination and sends the key as a bearer token', async () => {
  const f = fakeFetch({
    '': { edges: [{ node: linkedinNode }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    c1: { edges: [{ node: blueskyNode }], pageInfo: { hasNextPage: false, endCursor: 'c2' } },
  });
  const c = createClient({ apiKey: 'k', fetch: f });
  const posts = await c.posts('org', ['scheduled', 'draft']);
  assert.deepEqual(posts.map((p) => p.id), ['li1', 'bs1']);
  assert.equal(f.calls[0].auth, 'Bearer k');
  assert.deepEqual(f.calls[0].body.variables.status, ['scheduled', 'draft']);
});

test('edit surfaces Buffer error payloads and GraphQL errors as exceptions', async () => {
  const c = createClient({ apiKey: 'k', fetch: fakeFetch({}) });
  await assert.rejects(c.edit({ ...linkedinNode, id: 'bad' }, { saveToDraft: true }), /InvalidInputError: nope/);
  const errs = createClient({ apiKey: 'k', fetch: async () => new Response(JSON.stringify({ errors: [{ message: 'Not authorized' }] })) });
  await assert.rejects(errs.posts('org', ['scheduled']), /Not authorized/);
  const http = createClient({ apiKey: 'k', fetch: async () => new Response('down', { status: 503 }) });
  await assert.rejects(http.posts('org', ['scheduled']), /HTTP 503/);
});
