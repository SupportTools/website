// OpenAI provider, Batch flow and monthly cap. fetch is mocked; nothing here
// touches the network.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateImage, imageProvider, imagePrompt } from '../../scripts/og/lib/ai.mjs';
import { scrub, pngSize, API, DEFAULT_MODEL, DEFAULT_SIZE, DEFAULT_QUALITY, imageConfig } from '../../scripts/og/lib/openai.mjs';
import { submitBatch, collectBatch, needsArt, pendingBatchIds } from '../../scripts/og/lib/batch.mjs';
import {
  estimateCost, loadLedger, saveLedger, reserve, spent, remaining, monthKey, capUsd, BudgetError,
} from '../../scripts/og/lib/budget.mjs';
import { needsWork } from '../../scripts/og/lib/manifest.mjs';

const KEY = 'sk-test-not-a-real-key-123';
const ENV = ['OG_IMAGE_PROVIDER', 'OPENAI_API_KEY', 'OG_OPENAI_LEDGER', 'OG_OPENAI_MONTHLY_CAP_USD',
  'OG_OPENAI_BACKOFF_MS', 'OG_OPENAI_MODEL', 'OG_OPENAI_SIZE', 'OG_OPENAI_QUALITY', 'OG_OPENAI_ATTEMPTS'];
let saved;
let realFetch;
let work;
let calls;

// A PNG signature and IHDR chunk header is all pngSize reads.
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const B64 = png(1536, 1024).toString('base64');

// Routes "METHOD /path" to a handler returning a Response (or a function that does).
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(API, '');
    calls.push({ method, path, init });
    const h = routes[`${method} ${path}`];
    if (!h) throw new Error(`unexpected fetch ${method} ${path}`);
    const r = typeof h === 'function' ? await h(init, calls.filter((c) => c.path === path).length) : h;
    return r.clone ? r.clone() : r;
  };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jsonl = (rows) => new Response(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  realFetch = globalThis.fetch;
  // Fail closed: a test that forgets to mock never reaches the network.
  globalThis.fetch = async (url) => { throw new Error(`unmocked fetch ${url}`); };
  work = mkdtempSync(join(tmpdir(), 'og-openai-'));
  process.env.OPENAI_API_KEY = KEY;
  process.env.OG_OPENAI_LEDGER = join(work, 'ledger.json');
  process.env.OG_OPENAI_BACKOFF_MS = '1';
});

afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  globalThis.fetch = realFetch;
  rmSync(work, { recursive: true, force: true });
});

const post = (slug) => ({ slug, title: `Title ${slug}: sub`, description: 'd', body: 'Opening text.', categories: ['Linux'] });

test('default provider stays codex', () => {
  delete process.env.OG_IMAGE_PROVIDER;
  assert.equal(imageProvider(), 'codex');
  assert.equal(imageProvider({ OG_IMAGE_PROVIDER: 'openai' }), 'openai');
  assert.throws(() => imageProvider({ OG_IMAGE_PROVIDER: 'dalle' }), /codex\|openai/);
  // The codex prompt is unchanged; the openai one drops the agent instructions.
  assert.match(imagePrompt(post('a'), 'x', ''), /^Use your image generation tool/);
  assert.doesNotMatch(imagePrompt(post('a'), 'x', '', 'openai'), /raw\.png|tool/);
});

test('sync: openai provider writes raw.png, sends the documented body, charges the ledger', async () => {
  process.env.OG_IMAGE_PROVIDER = 'openai';
  mockFetch({ 'POST /images/generations': () => json({ created: 1, data: [{ b64_json: B64 }], usage: {} }) });
  const dir = join(work, 'my-post');
  mkdirSync(dir);
  const raw = await generateImage({ dir, prompt: 'draw a thing', workDir: work });
  assert.equal(raw, join(dir, 'raw.png'));
  assert.deepEqual(pngSize(readFileSync(raw)), { width: 1536, height: 1024 });
  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(init.signal, 'every fetch has a timeout signal');
  assert.deepEqual(JSON.parse(init.body), {
    model: DEFAULT_MODEL, prompt: 'draw a thing', n: 1, size: '1536x1024', quality: 'medium', output_format: 'png',
  });
  assert.equal(readFileSync(join(dir, 'prompt.txt'), 'utf8'), 'draw a thing');
  const ledgerText = readFileSync(process.env.OG_OPENAI_LEDGER, 'utf8');
  assert.ok(!ledgerText.includes(KEY));
  assert.equal(spent(loadLedger(process.env.OG_OPENAI_LEDGER)), estimateCost({ model: DEFAULT_MODEL, quality: 'medium', size: '1536x1024', prompt: 'draw a thing' }));
});

test('sync: retries 429 and 5xx with backoff, then succeeds', async () => {
  process.env.OG_IMAGE_PROVIDER = 'openai';
  mockFetch({
    'POST /images/generations': (_, n) => (n === 1 ? json({ error: { message: 'slow down' } }, 429, { 'retry-after': '0' })
      : n === 2 ? json({ error: { message: 'oops' } }, 502)
        : json({ data: [{ b64_json: B64 }] })),
  });
  const dir = join(work, 'p');
  mkdirSync(dir);
  await generateImage({ dir, prompt: 'x', workDir: work });
  assert.equal(calls.length, 3);
});

test('sync: a 4xx fails at once, is credited back and never leaks the key', async () => {
  process.env.OG_IMAGE_PROVIDER = 'openai';
  mockFetch({ 'POST /images/generations': () => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401) });
  const dir = join(work, 'p');
  mkdirSync(dir);
  await assert.rejects(generateImage({ dir, prompt: 'x', workDir: work }), (e) => {
    assert.ok(e.halt, '401 halts the run');
    assert.ok(!e.message.includes(KEY));
    assert.match(e.message, /HTTP 401/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(spent(loadLedger(process.env.OG_OPENAI_LEDGER)), 0);
  assert.equal(scrub('key sk-abc***xyz here'), 'key sk-[redacted] here');
});

test('sync: refuses before any request when the cap would be crossed', async () => {
  process.env.OG_IMAGE_PROVIDER = 'openai';
  process.env.OG_OPENAI_MONTHLY_CAP_USD = '0.01';
  mockFetch({});
  const dir = join(work, 'p');
  mkdirSync(dir);
  await assert.rejects(generateImage({ dir, prompt: 'x', workDir: work }), (e) => e instanceof BudgetError && /cap/.test(e.message) && e.halt);
  assert.equal(calls.length, 0);
});

test('budget: cap env, unknown prices refused, batch discount', () => {
  assert.equal(capUsd({}), 25);
  assert.equal(capUsd({ OG_OPENAI_MONTHLY_CAP_USD: '10' }), 10);
  assert.throws(() => capUsd({ OG_OPENAI_MONTHLY_CAP_USD: 'lots' }), BudgetError);
  assert.throws(() => estimateCost({ model: 'gpt-image-9', quality: 'medium', size: '1536x1024' }), /no price/);
  const sync = estimateCost({ model: 'gpt-image-1-mini', quality: 'medium', size: '1536x1024' });
  assert.equal(sync, 0.015);
  assert.equal(estimateCost({ model: 'gpt-image-1-mini', quality: 'medium', size: '1536x1024', batch: true }), 0.0075);
});

test('budget: the default model, size and quality always have a price, sync and Batch', () => {
  // The cap refuses any unpriced combination, so an unpriced default would stop every run.
  const cfg = imageConfig({});
  assert.deepEqual(cfg, { model: DEFAULT_MODEL, size: DEFAULT_SIZE, quality: DEFAULT_QUALITY });
  assert.notEqual(DEFAULT_MODEL, 'gpt-image-1-mini', 'gpt-image-1-mini shuts down 2026-12-01');
  const sync = estimateCost({ ...cfg, prompt: 'p' });
  assert.ok(sync > 0);
  assert.equal(estimateCost({ ...cfg, prompt: 'p', batch: true }), Math.round(sync * 0.5 * 1e6) / 1e6);
});

test('budget: GPT Image 2.5 prices (343 output tokens at $30 per 1M, text $5 per 1M)', () => {
  for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
    assert.equal(estimateCost({ model, quality: 'medium', size: '1536x1024' }), 0.01029);
    assert.equal(estimateCost({ model, quality: 'medium', size: '1536x1024', batch: true }), 0.005145);
    // 4000 chars = 1000 estimated text tokens = $0.005 sync on top of the image.
    assert.equal(estimateCost({ model, quality: 'medium', size: '1536x1024', prompt: 'x'.repeat(4000) }), 0.01529);
    assert.throws(() => estimateCost({ model, quality: 'high', size: '1536x1024' }), /no price/, 'unmeasured combinations are refused');
  }
});

test('budget: ledger month rollover (UTC calendar months)', () => {
  const path = join(work, 'l.json');
  const ledger = loadLedger(path);
  const oct = new Date('2026-10-31T23:59:59Z');
  const nov = new Date('2026-11-01T00:00:00Z');
  assert.equal(monthKey(oct), '2026-10');
  assert.equal(monthKey(nov), '2026-11');
  assert.equal(monthKey(new Date('2026-10-31T20:00:00-05:00')), '2026-11', 'evening in Chicago on Oct 31 is November UTC');
  reserve(ledger, 24.99, { cap: 25, month: '2026-10' });
  assert.throws(() => reserve(ledger, 0.02, { cap: 25, month: '2026-10' }), BudgetError);
  reserve(ledger, 0.02, { cap: 25, month: '2026-11' });
  saveLedger(path, ledger);
  const back = loadLedger(path);
  assert.equal(spent(back, '2026-10'), 24.99);
  assert.equal(spent(back, '2026-11'), 0.02);
  assert.equal(remaining(back, { cap: 25, month: '2026-11' }), 24.98);
});

function batchRoutes(state = {}) {
  return {
    'POST /files': (init) => { state.form = init.body; return json({ id: 'file-in' }); },
    'POST /batches': (init) => { state.create = JSON.parse(init.body); return json({ id: 'batch_1', status: 'validating' }); },
  };
}

test('submit-batch: JSONL shape, manifest batchId, ledger reservation', async () => {
  const state = {};
  mockFetch(batchRoutes(state));
  const manifest = { live: { status: 'live' }, rej: { status: 'rejected', note: 'too busy', attempts: 1 } };
  const saves = [];
  const res = await submitBatch({
    manifest, posts: [post('new'), post('live'), post('rej')], workDir: work, ledgerFile: process.env.OG_OPENAI_LEDGER,
    promptFor: (p, e) => `prompt for ${p.slug}${e?.note ? ` (${e.note})` : ''}`, save: () => saves.push(1), log: () => {},
  });
  assert.equal(res.batches.length, 1);
  assert.equal(state.form.get('purpose'), 'batch');
  const lines = (await state.form.get('file').text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.custom_id), ['new', 'rej']);
  assert.deepEqual(lines[1], {
    custom_id: 'rej', method: 'POST', url: '/v1/images/generations',
    body: { model: DEFAULT_MODEL, prompt: 'prompt for rej (too busy)', n: 1, size: '1536x1024', quality: 'medium', output_format: 'png' },
  });
  assert.equal(state.create.input_file_id, 'file-in');
  assert.equal(state.create.endpoint, '/v1/images/generations');
  assert.equal(state.create.completion_window, '24h');
  assert.equal(manifest.new.status, 'batched');
  assert.equal(manifest.new.batchId, 'batch_1');
  assert.equal(manifest.rej.batchId, 'batch_1');
  assert.equal(manifest.live.status, 'live');
  assert.ok(saves.length);
  assert.ok(!needsWork(manifest.new), 'a normal run leaves batched cards alone');
  assert.deepEqual(pendingBatchIds(manifest), ['batch_1']);
  const ledger = loadLedger(process.env.OG_OPENAI_LEDGER);
  assert.deepEqual(Object.keys(ledger.batches.batch_1.items), ['new', 'rej']);
  assert.ok(spent(ledger) > 0);
  assert.ok(!readFileSync(process.env.OG_OPENAI_LEDGER, 'utf8').includes(KEY));
});

test('submit-batch: refuses at the cap, stops cleanly part way', async () => {
  const one = estimateCost({ model: DEFAULT_MODEL, quality: 'medium', size: '1536x1024', prompt: 'p', batch: true });
  // Room for two cards this month.
  process.env.OG_OPENAI_MONTHLY_CAP_USD = String(one * 2.5);
  mockFetch(batchRoutes());
  const manifest = {};
  const args = { manifest, workDir: work, ledgerFile: process.env.OG_OPENAI_LEDGER, promptFor: () => 'p', log: () => {} };
  const res = await submitBatch({ ...args, posts: ['a', 'b', 'c', 'd'].map(post) });
  assert.equal(res.capped, true);
  assert.equal(res.skipped, 2);
  assert.deepEqual(Object.keys(manifest).sort(), ['a', 'b']);
  calls.length = 0;
  await assert.rejects(submitBatch({ ...args, posts: [post('c')] }), (e) => e instanceof BudgetError && /Nothing was submitted/.test(e.message));
  assert.equal(calls.length, 0, 'nothing is sent once the cap is reached');
  assert.ok(spent(loadLedger(process.env.OG_OPENAI_LEDGER)) <= Number(process.env.OG_OPENAI_MONTHLY_CAP_USD));
});

test('submit-batch: a failed create credits the reservation back', async () => {
  mockFetch({ 'POST /files': () => json({ id: 'f' }), 'POST /batches': () => json({ error: { message: 'bad' } }, 400) });
  await assert.rejects(submitBatch({
    manifest: {}, posts: [post('a')], workDir: work, ledgerFile: process.env.OG_OPENAI_LEDGER, promptFor: () => 'p', log: () => {},
  }), /HTTP 400/);
  assert.equal(spent(loadLedger(process.env.OG_OPENAI_LEDGER)), 0);
});

test('collect-batch: writes raw.png per slug, marks failures with a reason, settles the ledger', async () => {
  const ledgerFile = process.env.OG_OPENAI_LEDGER;
  const ledger = loadLedger(ledgerFile);
  const month = monthKey();
  reserve(ledger, 0.04, { month, images: 4 });
  ledger.batches.batch_1 = { month, items: { ok: 0.01, bad: 0.01, err: 0.01, gone: 0.01 } };
  saveLedger(ledgerFile, ledger);
  const manifest = Object.fromEntries(['ok', 'bad', 'err', 'gone'].map((s) => [s, { status: 'batched', batchId: 'batch_1', attempts: 0 }]));
  manifest.other = { status: 'batched', batchId: 'batch_2' };
  mockFetch({
    'GET /batches/batch_1': json({ id: 'batch_1', status: 'expired', output_file_id: 'out', error_file_id: 'errs', request_counts: { total: 4 } }),
    'GET /files/out/content': () => jsonl([
      { id: 'r1', custom_id: 'ok', response: { status_code: 200, body: { data: [{ b64_json: B64 }] } }, error: null },
      { id: 'r2', custom_id: 'bad', response: { status_code: 200, body: { data: [{ b64_json: png(512, 1024).toString('base64') }] } }, error: null },
    ]),
    'GET /files/errs/content': () => jsonl([
      { id: 'r3', custom_id: 'err', response: { status_code: 400, body: { error: { message: 'Your request was rejected by the safety system.' } } }, error: null },
    ]),
  });
  const res = await collectBatch({ manifest, id: 'batch_1', workDir: work, ledgerFile, log: () => {} });
  assert.deepEqual(res, { state: 'expired', drawn: 1, failed: 3 });
  assert.equal(manifest.ok.status, 'drawn');
  assert.equal(manifest.ok.attempts, 1);
  assert.equal(manifest.ok.batchId, 'batch_1', 'batch id is kept for the record');
  assert.deepEqual(pngSize(readFileSync(join(work, 'ok', 'raw.png'))), { width: 1536, height: 1024 });
  assert.ok(needsWork(manifest.ok), 'a normal run picks drawn cards up for compose and review');
  assert.equal(manifest.bad.status, 'failed');
  assert.match(manifest.bad.reason, /not landscape/);
  assert.equal(existsSync(join(work, 'bad', 'raw.png')), false);
  assert.match(manifest.err.reason, /safety system/);
  assert.match(manifest.gone.reason, /expired/);
  assert.equal(manifest.other.status, 'batched', 'other batches are untouched');
  assert.ok(needsArt(manifest.err));
  const after = loadLedger(ledgerFile);
  // ok and bad were drawn (billed); err and gone were not, so 0.02 comes back.
  assert.equal(spent(after, month), 0.02);
  assert.equal(after.batches.batch_1, undefined);
  // Collecting again changes nothing.
  const again = await collectBatch({ manifest, id: 'batch_1', workDir: work, ledgerFile, log: () => {} });
  assert.equal(again.drawn + again.failed, 0);
  assert.equal(spent(loadLedger(ledgerFile), month), 0.02);
});

test('collect-batch: a running batch is left alone', async () => {
  const manifest = { a: { status: 'batched', batchId: 'batch_1' } };
  mockFetch({ 'GET /batches/batch_1': json({ id: 'batch_1', status: 'in_progress', request_counts: { total: 1, completed: 0 } }) });
  const res = await collectBatch({ manifest, id: 'batch_1', workDir: work, ledgerFile: process.env.OG_OPENAI_LEDGER, log: () => {} });
  assert.equal(res.state, 'in_progress');
  assert.equal(manifest.a.status, 'batched');
  assert.equal(calls.length, 1);
});

test('collect-batch: a failed batch fails every card with the batch error and credits it all back', async () => {
  const ledgerFile = process.env.OG_OPENAI_LEDGER;
  const ledger = loadLedger(ledgerFile);
  reserve(ledger, 0.02, { images: 2 });
  ledger.batches.b = { month: monthKey(), items: { a: 0.01, c: 0.01 } };
  saveLedger(ledgerFile, ledger);
  const manifest = { a: { status: 'batched', batchId: 'b' }, c: { status: 'batched', batchId: 'b' } };
  mockFetch({ 'GET /batches/b': json({ id: 'b', status: 'failed', errors: { data: [{ message: 'invalid model' }] } }) });
  await collectBatch({ manifest, id: 'b', workDir: work, ledgerFile, log: () => {} });
  assert.equal(manifest.a.status, 'failed');
  assert.match(manifest.c.reason, /failed: invalid model/);
  assert.equal(spent(loadLedger(ledgerFile)), 0);
});
