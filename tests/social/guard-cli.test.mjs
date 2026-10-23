import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// On a Kubernetes node, local ports 30000-32767 are NodePorts and get hijacked.
async function listen(server) {
  for (;;) {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    if (port < 30000 || port > 32767) return port;
    await new Promise((r) => server.close(r));
  }
}

function node(id, status, link, channel = 'bluesky') {
  return {
    id, status, dueAt: '2027-06-01T13:53:00.000Z', channelService: channel, text: 't', tags: [], assets: [],
    metadata: { __typename: 'BlueskyPostMetadata', linkAttachment: { url: link, title: 'T', text: 'D', thumbnail: '' } },
  };
}

test('check reports bad scheduled links and draft links without changing anything', async () => {
  const edits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const q = JSON.parse(body);
      if (q.query.includes('editPost')) edits.push(q);
      const status = q.variables.status?.[0];
      const nodes = status === 'scheduled'
        ? [node('good', 'scheduled', 'https://support.tools/curl-host-header/?utm_source=bluesky&utm_medium=social'),
           node('bad', 'scheduled', 'https://support.tools/kubernetes-cpu-limits-comprehensive-analysis-when-not-to-set-limits/?utm_source=bluesky&utm_medium=social')]
        : [node('draft1', 'draft', 'https://support.tools/no-such-article/?utm_source=bluesky')];
      res.end(JSON.stringify({ data: { posts: { edges: nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: false, endCursor: null } } } }));
    });
  });
  const port = await listen(server);
  // Async spawn: spawnSync would block this process, and with it the fake server.
  const r = await new Promise((resolve) => {
    const child = spawn('node', ['scripts/social/guard.mjs', 'check'], {
      cwd: ROOT, env: { ...process.env, BUFFER_API_KEY: 'k', BUFFER_URL: `http://127.0.0.1:${port}`, PUSHGATEWAY_URL: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  server.close();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /PROBLEM .* bad .*\n\s+no page at \/kubernetes-cpu-limits-comprehensive-analysis-when-not-to-set-limits\/; the article is at \/post\//);
  assert.doesNotMatch(r.stdout, /PROBLEM .* good /);
  assert.match(r.stdout, /DRAFT PROBLEM .* draft1/);
  assert.equal(edits.length, 0);
});
