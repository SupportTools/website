// Minimal Buffer GraphQL client for the social link guards: read posts with their
// link and card, and edit a post's schedule or draft state without changing its
// content. Buffer re-validates an edit as a whole post, so every edit resends the
// text, metadata, assets and tags it read.
const POST_FIELDS = `
  id status dueAt channelService text
  tags { id name }
  assets { ... on ImageAsset { source thumbnail image { altText } } }
  metadata {
    __typename
    ... on LinkedInPostMetadata { firstComment linkAttachment { url title text thumbnail } }
    ... on BlueskyPostMetadata { linkAttachment { url title text thumbnail } }
  }`;

const POSTS = `query($org: OrganizationId!, $status: [PostStatus!], $after: String) {
  posts(first: 100, after: $after, input: {organizationId: $org, filter: {status: $status}}) {
    edges { node { ${POST_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const EDIT = `mutation($input: EditPostInput!) {
  editPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt } }
    ... on NotFoundError { message }
    ... on UnauthorizedError { message }
    ... on UnexpectedError { message }
    ... on RestProxyError { message }
    ... on LimitReachedError { message }
    ... on InvalidInputError { message }
  }
}`;

const URL_RE = /https?:\/\/\S+/;

// The fields the guards work with, plus the raw node for editing.
export function normalize(node) {
  const md = node.metadata || {};
  const att = md.linkAttachment || null;
  let link = att?.url || '';
  if (!link && md.firstComment) link = (md.firstComment.match(URL_RE) || [''])[0];
  const card = att?.thumbnail || node.assets?.[0]?.source || '';
  return {
    id: node.id, status: node.status, dueAt: node.dueAt, channelService: node.channelService,
    text: node.text, link, card, tags: (node.tags || []).map((t) => t.name), node,
  };
}

function attachmentInput(a) {
  if (!a) return undefined;
  const out = { url: a.url };
  if (a.title) out.title = a.title;
  if (a.text) out.description = a.text;
  if (a.thumbnail) out.thumbnail = { url: a.thumbnail };
  return out;
}

// EditPostInput that keeps the post's content and applies `change`
// (e.g. { saveToDraft: true } or { mode: 'customScheduled', dueAt, saveToDraft: false }).
export function editInput(node, change) {
  const md = node.metadata || {};
  const metadata = {};
  if (md.__typename === 'LinkedInPostMetadata') {
    metadata.linkedin = {};
    if (md.firstComment) metadata.linkedin.firstComment = md.firstComment;
    if (md.linkAttachment) metadata.linkedin.linkAttachment = attachmentInput(md.linkAttachment);
  } else if (md.__typename === 'BlueskyPostMetadata') {
    metadata.bluesky = {};
    if (md.linkAttachment) metadata.bluesky.linkAttachment = attachmentInput(md.linkAttachment);
  }
  const assets = (node.assets || []).filter((a) => a.source).map((a) => {
    const image = { url: a.source };
    if (a.thumbnail) image.thumbnailUrl = a.thumbnail;
    image.metadata = { altText: a.image?.altText || '' };
    return { image };
  });
  return {
    id: node.id, text: node.text, metadata, assets,
    tagIds: (node.tags || []).map((t) => t.id), ...change,
  };
}

export function createClient({ apiKey, url = 'https://api.buffer.com', fetch = globalThis.fetch }) {
  async function call(query, variables) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`buffer: HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    if (body.errors?.length) throw new Error(`buffer: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  }

  return {
    async posts(orgId, status) {
      const out = [];
      let after = null;
      do {
        const data = await call(POSTS, { org: orgId, status, after });
        for (const e of data.posts.edges) out.push(normalize(e.node));
        after = data.posts.pageInfo.hasNextPage ? data.posts.pageInfo.endCursor : null;
      } while (after);
      return out;
    },
    async edit(node, change) {
      const data = await call(EDIT, { input: editInput(node, change) });
      const r = data.editPost;
      if (r.__typename !== 'PostActionSuccess') throw new Error(`buffer: ${r.__typename}: ${r.message}`);
      return r.post;
    },
  };
}
