// A single S3 PutObject with AWS Signature Version 4, in plain node (crypto + fetch),
// so the in-cluster job needs neither the aws CLI nor an SDK. Path-style URLs
// (https://endpoint/bucket/key): the bucket name has dots, which virtual-host
// style would put under a wildcard certificate that does not cover them.
import { createHash, createHmac } from 'node:crypto';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding, as SigV4 wants it: everything but unreserved characters.
export function uriEncode(s, keepSlash = false) {
  const enc = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? enc.replace(/%2F/g, '/') : enc;
}

export function amzDate(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Returns the Authorization header value. headers: lower-case name -> value, and
// must include host, x-amz-date and x-amz-content-sha256.
export function signV4({ method, path, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3' }) {
  const date = headers['x-amz-date'];
  const day = date.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

// PUTs body to bucket/key. Throws with the S3 error code on anything but 2xx; the
// secret is used only to sign and never appears in an error.
export async function putObject({
  endpoint, region, bucket, key, body, contentType, cacheControl, accessKeyId, secretAccessKey,
  fetch: fetchFn = (...a) => globalThis.fetch(...a), now = new Date(), timeoutMs = 60000,
}) {
  const base = new URL(endpoint);
  const path = `/${uriEncode(bucket)}/${uriEncode(key, true)}`;
  const payloadHash = sha256(body);
  const headers = {
    host: base.host,
    'x-amz-date': amzDate(now),
    'x-amz-content-sha256': payloadHash,
    'content-type': contentType,
  };
  if (cacheControl) headers['cache-control'] = cacheControl;
  const authorization = signV4({ method: 'PUT', path, headers, payloadHash, accessKeyId, secretAccessKey, region });
  const { host, ...send } = headers;
  const res = await fetchFn(`${base.protocol}//${host}${path}`, {
    method: 'PUT', headers: { ...send, authorization }, body, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
    throw new Error(`S3 PUT ${bucket}/${key}: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  }
  return res;
}
