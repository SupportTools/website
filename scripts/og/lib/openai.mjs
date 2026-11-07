// OpenAI images provider: the synchronous images endpoint for single cards and the
// Batch API for backfill and nightly runs. Plain global fetch, no SDK.
//
// API shapes used (developers.openai.com/api/reference, read 2026-11-03):
//   POST /v1/images/generations {model, prompt, n, size, quality, output_format}
//     -> {data: [{b64_json}], usage}; GPT image models always return base64.
//   POST /v1/files (multipart, purpose=batch) -> {id}
//   POST /v1/batches {input_file_id, endpoint, completion_window: "24h", metadata} -> {id, status}
//   GET  /v1/batches/{id} -> {status, output_file_id, error_file_id, request_counts, errors}
//   GET  /v1/files/{id}/content -> JSONL, one line per request:
//     {custom_id, response: {status_code, body}, error}
//
// OPENAI_API_KEY is read from the environment at call time. It is sent only in the
// Authorization header and is never logged or written anywhere; error text from the
// API is scrubbed of anything key-shaped before it can reach a log or the manifest.
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCost, loadLedger, saveLedger, reserve, refund, capUsd } from './budget.mjs';

export const API = 'https://api.openai.com/v1';
// gpt-image-1-mini shuts down 2026-12-01. Sunburst costs the same as flare per card
// and followed the no-text, no-logo style rules more reliably in side-by-side tests.
export const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';
// 1536x1024 is the widest standard size; compose.mjs crops it to 1200x630.
export const DEFAULT_SIZE = '1536x1024';
export const DEFAULT_QUALITY = 'medium';
export const IMAGES_ENDPOINT = '/v1/images/generations';

export function imageConfig(env = process.env) {
  return {
    model: env.OG_OPENAI_MODEL || DEFAULT_MODEL,
    size: env.OG_OPENAI_SIZE || DEFAULT_SIZE,
    quality: env.OG_OPENAI_QUALITY || DEFAULT_QUALITY,
  };
}

export function ledgerPath(env = process.env, workDir) {
  return env.OG_OPENAI_LEDGER || join(workDir, 'openai-ledger.json');
}

// Removes anything that looks like an API key (the API echoes a masked key on 401).
export function scrub(text) {
  return String(text).replace(/\bsk-[A-Za-z0-9_*.-]+/g, 'sk-[redacted]');
}

function apiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) {
    const e = new Error('OPENAI_API_KEY is not set');
    e.halt = true;
    throw e;
  }
  return k;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = (s) => s === 429 || s >= 500;

// One API call with a timeout on every attempt and bounded retries with
// exponential backoff on 429, 5xx and network errors (retryNetwork: false skips
// the last, for a generation that may have been billed). Retry-After is honoured,
// up to 60s. Other 4xx fail at once. Returns the Response (ok) or throws.
export async function apiFetch(path, {
  method = 'GET', json, form, timeoutMs = 60000, attempts = Number(process.env.OG_OPENAI_ATTEMPTS || 4),
  backoffMs = Number(process.env.OG_OPENAI_BACKOFF_MS || 1000), sleep = sleepMs, retryNetwork = true,
} = {}) {
  const headers = { Authorization: `Bearer ${apiKey()}` };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  let last;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method, headers, body: json !== undefined ? JSON.stringify(json) : form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = new Error(`OpenAI ${method} ${path}: ${e.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : scrub(e.message)}`);
      if (retryNetwork && i < attempts) { await sleep(backoffMs * 2 ** (i - 1)); continue; }
      throw last;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* not JSON */ }
    last = new Error(`OpenAI ${method} ${path}: HTTP ${res.status}: ${scrub(msg).slice(0, 300)}`);
    last.status = res.status;
    if (res.status === 401 || res.status === 403) last.halt = true; // bad key: every card would fail
    if (!RETRY_STATUS(res.status) || i === attempts) throw last;
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : backoffMs * 2 ** (i - 1));
  }
  throw last;
}

// Width and height from a PNG's IHDR chunk, without ImageMagick.
export function pngSize(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig || buf.subarray(12, 16).toString() !== 'IHDR') {
    throw new Error('image is not a PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Decodes one base64 image and writes it as raw.png, checking it is a landscape PNG
// (the same ratio rule as the Codex path).
export function writeRawPng(dir, b64) {
  if (typeof b64 !== 'string' || !b64) throw new Error('response had no b64_json image');
  const buf = Buffer.from(b64, 'base64');
  const { width, height } = pngSize(buf);
  if (!(width > height * 1.4)) throw new Error(`raw.png is not landscape (${width}x${height})`);
  const raw = join(dir, 'raw.png');
  writeFileSync(raw, buf);
  return raw;
}

export function requestBody(prompt, cfg = imageConfig()) {
  return { model: cfg.model, prompt, n: 1, size: cfg.size, quality: cfg.quality, output_format: 'png' };
}

// Synchronous generation for one card. The estimated cost is reserved in the
// ledger before the request is sent and credited back if the request fails.
export async function generateImageOpenAI({ dir, prompt, workDir, timeoutMs = 300000, ...opts }) {
  writeFileSync(join(dir, 'prompt.txt'), prompt);
  rmSync(join(dir, 'raw.png'), { force: true });
  const cfg = imageConfig();
  const path = ledgerPath(process.env, workDir || join(dir, '..'));
  const cost = estimateCost({ ...cfg, prompt });
  apiKey(); // fail on a missing key before touching the ledger
  let ledger = loadLedger(path);
  const month = reserve(ledger, cost, { cap: capUsd() });
  saveLedger(path, ledger);
  let res;
  try {
    res = await apiFetch('/images/generations', {
      method: 'POST', json: requestBody(prompt, cfg), timeoutMs, retryNetwork: false, ...opts,
    });
  } catch (e) {
    // An HTTP error is not billed; a dropped or timed out request might have been, so
    // its estimate stays (and it is not retried, so it is never billed twice).
    if (e.status) {
      ledger = loadLedger(path);
      refund(ledger, cost, { month });
      saveLedger(path, ledger);
    }
    throw e;
  }
  const body = await res.json();
  return writeRawPng(dir, body?.data?.[0]?.b64_json);
}

// ---- Batch API ----

export function batchLine(slug, prompt, cfg = imageConfig()) {
  return { custom_id: slug, method: 'POST', url: IMAGES_ENDPOINT, body: requestBody(prompt, cfg) };
}

export function batchJsonl(items, cfg = imageConfig()) {
  return `${items.map(({ slug, prompt }) => JSON.stringify(batchLine(slug, prompt, cfg))).join('\n')}\n`;
}

export async function uploadBatchFile(jsonl, name = 'og-cards.jsonl', opts = {}) {
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), name);
  const res = await apiFetch('/files', { method: 'POST', form, timeoutMs: 120000, ...opts });
  return (await res.json()).id;
}

export async function createBatch(inputFileId, metadata = {}, opts = {}) {
  const res = await apiFetch('/batches', {
    method: 'POST',
    json: { input_file_id: inputFileId, endpoint: IMAGES_ENDPOINT, completion_window: '24h', metadata },
    ...opts,
  });
  return res.json();
}

export async function getBatch(id, opts = {}) {
  const res = await apiFetch(`/batches/${encodeURIComponent(id)}`, opts);
  return res.json();
}

// Streams a JSONL file's lines: an image batch output holds a few MB of base64 per
// line, so the file is never held in memory whole.
export async function* fileLines(fileId, opts = {}) {
  const res = await apiFetch(`/files/${encodeURIComponent(fileId)}/content`, { timeoutMs: 900000, ...opts });
  let buf = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

export const BATCH_PENDING = ['validating', 'in_progress', 'finalizing', 'cancelling'];
