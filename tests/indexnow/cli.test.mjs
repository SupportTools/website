import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../scripts/indexnow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = loadConfig().key;

// On a Kubernetes node, local ports 30000-32767 are NodePorts and get hijacked.
async function listen(server) {
  for (;;) {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    if (port < 30000 || port > 32767) return port;
    await new Promise((r) => server.close(r));
  }
}

// A fake IndexNow endpoint answering with `statuses` in turn (the last one
// repeats). Records every request body.
async function endpoint(statuses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: JSON.parse(body) });
      res.statusCode = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      res.end();
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/indexnow`, requests, close: () => new Promise((r) => server.close(r)) };
}

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function site({ withKey = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexnow-cli-'));
  dirs.push(dir);
  const recent = new Date(Date.now() - 3600e3).toISOString();
  fs.writeFileSync(path.join(dir, 'sitemap.xml'), '<urlset>'
    + `<url><loc>https://support.tools/fresh/</loc><lastmod>${recent}</lastmod></url>`
    + `<url><loc>https://support.tools/tags/x/</loc><lastmod>${recent}</lastmod></url>`
    + '<url><loc>https://support.tools/stale/</loc><lastmod>2020-01-01T00:00:00Z</lastmod></url>'
    + '</urlset>');
  if (withKey) fs.writeFileSync(path.join(dir, `${KEY}.txt`), KEY);
  return dir;
}

// Async spawn: spawnSync would block this process, and with it the fake server.
function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/indexnow.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_ACTIONS: '', INDEXNOW_RETRY_DELAY_MS: '0', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('sends changed sitemap URLs as one JSON POST and reports success', async () => {
  const ep = await endpoint([200]);
  const dir = site();
  const r = await run(['--public', dir], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ep.requests.length, 1);
  const req = ep.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(req.body, {
    host: 'support.tools', key: KEY, keyLocation: `https://support.tools/${KEY}.txt`, urlList: ['https://support.tools/fresh/'],
  });
  assert.match(r.stdout, /HTTP 200/);
  assert.match(r.stdout, /1\/1 batch\(es\) accepted/);
});

test('202 counts as accepted', async () => {
  const ep = await endpoint([202]);
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0);
  assert.equal(ep.requests.length, 1);
  assert.match(r.stdout, /HTTP 202 accepted, key validation pending/);
});

test('422 is logged, not retried, and the CLI still exits 0', async () => {
  const ep = await endpoint([422]);
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ep.requests.length, 1);
  assert.match(r.stdout, /HTTP 422 unprocessable/);
  assert.match(r.stdout, /WARNING batch 1 not accepted \(HTTP 422 after 1 attempt/);
});

test('5xx is retried twice, then gives up with exit 0', async () => {
  const ep = await endpoint([503]);
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ep.requests.length, 3);
  assert.match(r.stdout, /after 3 attempt/);
});

test('a retry that succeeds counts as accepted', async () => {
  const ep = await endpoint([429, 200]);
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(ep.requests.length, 2);
  assert.match(r.stdout, /1\/1 batch\(es\) accepted/);
});

test('an endpoint that never answers times out per attempt and exits 0', async () => {
  const sockets = new Set();
  const server = http.createServer(() => {}); // never responds
  server.on('connection', (s) => { sockets.add(s); });
  const port = await listen(server);
  const started = Date.now();
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: `http://127.0.0.1:${port}/indexnow`, INDEXNOW_TIMEOUT_MS: '200' });
  for (const s of sockets) s.destroy();
  await new Promise((res) => server.close(res));
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/timed out after 200ms/g) || []).length, 3);
  assert.ok(Date.now() - started < 10000);
});

test('a dropped connection is retried, logged and exits 0', async () => {
  // Reset every connection on accept. (A closed port would race with other
  // processes on a shared runner grabbing it.)
  let conns = 0;
  const server = net.createServer((s) => { conns++; s.destroy(); });
  const port = await listen(server);
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: `http://127.0.0.1:${port}/indexnow` });
  await new Promise((res) => server.close(res));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(conns, 3);
  assert.match(r.stdout, /HTTP none TypeError: fetch failed/);
  assert.match(r.stdout, /WARNING batch 1 not accepted \(HTTP none after 3 attempt/);
});

test('dry run prints the payload and sends nothing', async () => {
  const ep = await endpoint([200]);
  const r = await run(['--public', site(), '--dry-run', '--include-tags'], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0);
  assert.equal(ep.requests.length, 0);
  assert.match(r.stdout, /dry run, not sent/);
  assert.match(r.stdout, /"urlList": \[\n\s+"https:\/\/support.tools\/fresh\/",\n\s+"https:\/\/support.tools\/tags\/x\/"/);
});

test('explicit --url list replaces the sitemap and drops off-host URLs', async () => {
  const ep = await endpoint([200]);
  const r = await run(['--public', site(), '--url', 'https://support.tools/one/', '--url', 'https://evil.example/x/', '--url', 'https://support.tools/one/'],
    { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0);
  assert.deepEqual(ep.requests[0].body.urlList, ['https://support.tools/one/']);
  assert.match(r.stdout, /dropping 1 URL\(s\) not on support.tools/);
});

test('nothing changed means no request', async () => {
  const ep = await endpoint([200]);
  const r = await run(['--public', site(), '--since', '2099-01-01T00:00:00Z'], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(r.status, 0);
  assert.equal(ep.requests.length, 0);
  assert.match(r.stdout, /nothing to submit/);
});

test('missing key file or sitemap warns and exits 0 without sending', async () => {
  const ep = await endpoint([200]);
  const noKey = await run(['--public', site({ withKey: false })], { INDEXNOW_ENDPOINT: ep.url });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'indexnow-empty-'));
  dirs.push(empty);
  fs.writeFileSync(path.join(empty, `${KEY}.txt`), KEY);
  const noSitemap = await run(['--public', empty], { INDEXNOW_ENDPOINT: ep.url });
  await ep.close();
  assert.equal(noKey.status, 0);
  assert.match(noKey.stdout, /key file .* missing/);
  assert.equal(noSitemap.status, 0);
  assert.match(noSitemap.stdout, /WARNING skipped: ENOENT/);
  assert.equal(ep.requests.length, 0);
});

test('GitHub Actions gets a warning annotation on failure', async () => {
  const ep = await endpoint([403]);
  const r = await run(['--public', site()], { INDEXNOW_ENDPOINT: ep.url, GITHUB_ACTIONS: 'true' });
  await ep.close();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning title=IndexNow::batch 1 not accepted \(HTTP 403/);
});

test('bad command line exits 2', async () => {
  assert.equal((await run(['--nope'])).status, 2);
  assert.equal((await run(['--since', 'whenever'])).status, 2);
});
