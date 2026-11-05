// Uploads a card to the Wasabi bucket behind cdn.support.tools and proves it is
// served. Two credential sources:
//   - OG_WASABI_ACCESS_KEY_ID and OG_WASABI_SECRET_ACCESS_KEY in the environment (the
//     in-cluster job, from secret/publisher/wasabi-og), with OG_WASABI_BUCKET,
//     OG_WASABI_ENDPOINT, OG_WASABI_REGION and OG_WASABI_PREFIX optional. The upload
//     is a signed PUT in plain node (lib/s3.mjs): no aws or vault CLI needed.
//   - otherwise the workstation path as before: the key is read from Vault at run
//     time and the aws CLI uploads.
// Either way the key lives only in this process (and the aws child's environment);
// it is never printed, logged or written.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CDN_BASE } from './posts.mjs';
import { putObject } from './s3.mjs';

const run = promisify(execFile);

// Same schema as the other least-privilege CDN push keys (secret/infra/wasabi-*-cdn):
// IAM user svc-supporttools-og, PutObject only on posts/*/og-*.jpg.
export const VAULT_PATH = process.env.OG_VAULT_PATH || 'secret/infra/wasabi-supporttools-og';
const DEFAULT_BUCKET = 'cdn.support.tools';
const DEFAULT_ENDPOINT = 'https://s3.wasabisys.com';
const DEFAULT_REGION = 'us-east-1';

// Optional scoped token (policy workstation-website-og-read, read-only on VAULT_PATH) so a
// multi-day run outlives the operator's 24h OIDC login. Falls back to the normal login.
export const VAULT_TOKEN_FILE = process.env.OG_VAULT_TOKEN_FILE
  || join(homedir(), '.config', 'support-tools-og', 'vault-token');

let cached;

async function vaultRead(token) {
  const env = token ? { ...process.env, VAULT_TOKEN: token } : process.env;
  const { stdout } = await run('vault', ['kv', 'get', '-format=json', VAULT_PATH], { env });
  return stdout;
}

// Credentials from OG_WASABI_* when both key halves are set, else null.
// OG_WASABI_PREFIX is the key prefix the IAM user may write (for example "posts/");
// it is checked, never prepended, because the CDN URL is CDN_BASE/<key>.
export function envCredentials(env = process.env) {
  if (!env.OG_WASABI_ACCESS_KEY_ID || !env.OG_WASABI_SECRET_ACCESS_KEY) return null;
  return {
    source: 'env',
    accessKeyId: env.OG_WASABI_ACCESS_KEY_ID,
    secretAccessKey: env.OG_WASABI_SECRET_ACCESS_KEY,
    bucket: env.OG_WASABI_BUCKET || DEFAULT_BUCKET,
    endpoint: env.OG_WASABI_ENDPOINT || DEFAULT_ENDPOINT,
    region: env.OG_WASABI_REGION || DEFAULT_REGION,
    prefix: env.OG_WASABI_PREFIX || '',
  };
}

export async function wasabiCredentials() {
  if (cached) return cached;
  const fromEnv = envCredentials();
  if (fromEnv) { cached = fromEnv; return cached; }
  let raw;
  let fileToken = '';
  try { fileToken = readFileSync(VAULT_TOKEN_FILE, 'utf8').trim(); } catch { /* no token file */ }
  try {
    raw = await vaultRead(fileToken).catch((e) => (fileToken ? vaultRead('') : Promise.reject(e)));
  } catch (e) {
    const msg = String(e.stderr || '').split('\n')[0];
    throw new Error(`cannot read ${VAULT_PATH} from Vault (${msg || 'vault failed'}). Run "vault login", refresh ${VAULT_TOKEN_FILE}, or store the key there.`);
  }
  const d = JSON.parse(raw).data.data;
  if (!d.ACCESS_KEY_ID || !d.SECRET_ACCESS_KEY) throw new Error(`${VAULT_PATH} lacks ACCESS_KEY_ID / SECRET_ACCESS_KEY`);
  cached = {
    env: { AWS_ACCESS_KEY_ID: d.ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: d.SECRET_ACCESS_KEY },
    bucket: d.bucket || DEFAULT_BUCKET,
    endpoint: d.endpoint || DEFAULT_ENDPOINT,
    region: d.region || DEFAULT_REGION,
  };
  return cached;
}

// Keys carry a content hash, so a key's bytes never change and the CDN may
// cache them forever; a regenerated card gets a new key instead.
export async function uploadCard({ file, key }) {
  const c = await wasabiCredentials();
  if (c.source === 'env') {
    if (c.prefix && !key.startsWith(c.prefix)) throw new Error(`key ${key} is outside OG_WASABI_PREFIX ${c.prefix}`);
    try {
      await putObject({
        endpoint: c.endpoint, region: c.region, bucket: c.bucket, key, body: readFileSync(file),
        contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable',
        accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey,
      });
    } catch (e) {
      // A refused key fails every card the same way: say so in a form run.mjs
      // treats like a Vault failure (uploads stop, cards wait as "ready", exit 3).
      if (/HTTP (401|403)\b/.test(e.message)) throw new Error(`Wasabi refused the OG_WASABI_* key: ${e.message}`);
      throw e;
    }
    return `${CDN_BASE}/${key}`;
  }
  // Only the Wasabi key may reach aws: drop any ambient AWS profile or session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
  await run('aws', [
    's3', 'cp', file, `s3://${c.bucket}/${key}`,
    '--endpoint-url', c.endpoint, '--region', c.region,
    '--content-type', 'image/jpeg', '--cache-control', 'public, max-age=31536000, immutable',
    '--only-show-errors',
  ], { env: { ...env, ...c.env } });
  return `${CDN_BASE}/${key}`;
}

// Test hook: forget cached credentials.
export function resetCredentials() { cached = undefined; }

export async function verifyServed(url, attempts = 4) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, { method: 'HEAD' }).catch((e) => ({ status: 0, headers: new Headers(), err: e }));
    const type = r.headers.get('content-type') || '';
    if (r.status === 200 && type.startsWith('image/')) return true;
    last = `${r.status} ${type}`;
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error(`${url} not served after upload (${last})`);
}
