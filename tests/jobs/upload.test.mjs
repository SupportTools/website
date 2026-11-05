// Wasabi upload from OG_WASABI_* env vars (pure-node SigV4 PUT) and the OG_WORK_DIR
// override. fetch is mocked; nothing here touches the network, Vault or aws.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { signV4, uriEncode, amzDate, putObject } from '../../scripts/og/lib/s3.mjs';
import { uploadCard, envCredentials, resetCredentials } from '../../scripts/og/lib/upload.mjs';
import { saveLedger, monthKey } from '../../scripts/og/lib/budget.mjs';
import { failClosedFetch, saveEnv, routeFetch } from './helpers.mjs';

const ENV = ['OG_WASABI_ACCESS_KEY_ID', 'OG_WASABI_SECRET_ACCESS_KEY', 'OG_WASABI_BUCKET', 'OG_WASABI_ENDPOINT',
  'OG_WASABI_REGION', 'OG_WASABI_PREFIX', 'OG_VAULT_PATH'];
const SECRET = 'not-a-real-secret/abc+123';
let restore;
let realFetch;
let work;

beforeEach(() => {
  restore = saveEnv(ENV);
  realFetch = globalThis.fetch;
  failClosedFetch();
  resetCredentials();
  work = mkdtempSync(join(tmpdir(), 'og-upload-'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restore();
  resetCredentials();
  rmSync(work, { recursive: true, force: true });
});

test('signV4 matches the AWS documentation example (GET object with Range)', () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "GET Object".
  const headers = {
    host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
    'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date': '20130524T000000Z',
  };
  const auth = signV4({
    method: 'GET', path: '/test.txt', headers, payloadHash: headers['x-amz-content-sha256'],
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,'
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,'
    + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('uriEncode and amzDate', () => {
  assert.equal(uriEncode("posts/a b/og-(1)!.jpg", true), 'posts/a%20b/og-%281%29%21.jpg');
  assert.equal(uriEncode('a/b'), 'a%2Fb');
  assert.equal(amzDate(new Date('2026-11-04T05:06:07.890Z')), '20261104T050607Z');
});

test('env credentials: defaults, and none unless both key halves are set', () => {
  assert.equal(envCredentials({ OG_WASABI_ACCESS_KEY_ID: 'AK' }), null);
  const c = envCredentials({ OG_WASABI_ACCESS_KEY_ID: 'AK', OG_WASABI_SECRET_ACCESS_KEY: 'S' });
  assert.deepEqual(
    { bucket: c.bucket, endpoint: c.endpoint, region: c.region, prefix: c.prefix },
    { bucket: 'cdn.support.tools', endpoint: 'https://s3.wasabisys.com', region: 'us-east-1', prefix: '' },
  );
});

test('uploadCard PUTs path-style to the endpoint with a signature, no aws or vault CLI', async () => {
  Object.assign(process.env, {
    OG_WASABI_ACCESS_KEY_ID: 'AKTEST', OG_WASABI_SECRET_ACCESS_KEY: SECRET, OG_WASABI_BUCKET: 'cdn.support.tools',
    OG_WASABI_ENDPOINT: 'https://s3.us-central-1.wasabisys.com', OG_WASABI_REGION: 'us-central-1', OG_WASABI_PREFIX: 'posts/',
    OG_VAULT_PATH: 'secret/does/not/matter',
  });
  const file = join(work, 'card.jpg');
  writeFileSync(file, 'jpeg-bytes');
  const calls = routeFetch(({ init }) => (init.method === 'PUT' ? new Response('', { status: 200 }) : null));
  const url = await uploadCard({ file, key: 'posts/my-post/og-abc123.jpg' });
  assert.equal(url, 'https://cdn.support.tools/posts/my-post/og-abc123.jpg');
  assert.equal(calls.length, 1);
  const { url: target, init } = calls[0];
  assert.equal(target, 'https://s3.us-central-1.wasabisys.com/cdn.support.tools/posts/my-post/og-abc123.jpg');
  assert.equal(init.headers['content-type'], 'image/jpeg');
  assert.equal(init.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\/\d{8}\/us-central-1\/s3\/aws4_request,SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(init.headers).includes(SECRET));
  assert.equal(String(init.body), 'jpeg-bytes');
});

test('a key outside OG_WASABI_PREFIX is refused before any request', async () => {
  Object.assign(process.env, { OG_WASABI_ACCESS_KEY_ID: 'AK', OG_WASABI_SECRET_ACCESS_KEY: SECRET, OG_WASABI_PREFIX: 'posts/' });
  const file = join(work, 'card.jpg');
  writeFileSync(file, 'x');
  const calls = routeFetch(() => new Response('', { status: 200 }));
  await assert.rejects(uploadCard({ file, key: 'other/og.jpg' }), /outside OG_WASABI_PREFIX/);
  assert.equal(calls.length, 0);
});

test('a refused key reads as an upload-credential failure (run.mjs stops uploads); other errors do not', async () => {
  Object.assign(process.env, { OG_WASABI_ACCESS_KEY_ID: 'AK', OG_WASABI_SECRET_ACCESS_KEY: SECRET });
  const file = join(work, 'card.jpg');
  writeFileSync(file, 'x');
  routeFetch(() => new Response('<Error><Code>InvalidAccessKeyId</Code></Error>', { status: 403 }));
  await assert.rejects(uploadCard({ file, key: 'posts/a/og-1.jpg' }), (e) => {
    assert.match(e.message, /OG_WASABI_.*HTTP 403 InvalidAccessKeyId/);
    assert.ok(!e.message.includes(SECRET));
    return true;
  });
  routeFetch(() => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }));
  await assert.rejects(uploadCard({ file, key: 'posts/a/og-1.jpg' }), (e) => !/OG_WASABI_/.test(e.message) && /HTTP 500 InternalError/.test(e.message));
});

test('putObject signs the exact bytes it sends', async () => {
  let seen;
  await putObject({
    endpoint: 'https://s3.wasabisys.com', region: 'us-east-1', bucket: 'b', key: 'k', body: Buffer.from('abc'),
    contentType: 'image/jpeg', accessKeyId: 'AK', secretAccessKey: 'S', now: new Date('2026-01-02T03:04:05Z'),
    fetch: async (u, init) => { seen = init; return new Response('', { status: 200 }); },
  });
  assert.equal(seen.headers['x-amz-content-sha256'], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(seen.headers['x-amz-date'], '20260102T030405Z');
});

test('run.mjs keeps its work files and ledgers in OG_WORK_DIR when set', () => {
  const dir = join(work, 'pvc');
  mkdirSync(dir);
  const m = monthKey();
  saveLedger(join(dir, 'openai-ledger.json'), { months: { [m]: { usd: 1.5, images: 7 } }, batches: {} });
  saveLedger(join(dir, 'anthropic-ledger.json'), { months: { [m]: { usd: 0.25, requests: 9 } }, batches: {} });
  const env = { ...process.env, OG_WORK_DIR: dir };
  for (const k of ['OG_OPENAI_LEDGER', 'OG_ANTHROPIC_LEDGER', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[k];
  const out = execFileSync(process.execPath, [resolve('scripts/og/run.mjs'), 'status'], { env, encoding: 'utf8' });
  assert.match(out, new RegExp(`openai ${m}: estimated \\$1\\.5000 .*7 images`));
  assert.match(out, new RegExp(`anthropic ${m}: \\$0\\.2500 of \\$10\\.00 cap, 9 requests`));
});
