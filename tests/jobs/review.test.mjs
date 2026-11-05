// Card review through the Anthropic Messages API (OG_REVIEW_PROVIDER=anthropic) and
// its monthly cap. fetch is mocked; nothing here touches the network.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCard, reviewProvider } from '../../scripts/og/lib/ai.mjs';
import {
  usageCost, estimateUsd, anthropicCapUsd, anthropicLedgerPath, scrubKey, meteredCreate, RunBudget,
} from '../../scripts/og/lib/anthropic.mjs';
import { loadLedger, saveLedger, monthKey } from '../../scripts/og/lib/budget.mjs';
import { failClosedFetch, saveEnv, routeFetch, message, json } from './helpers.mjs';

const ENV = ['OG_REVIEW_PROVIDER', 'ANTHROPIC_API_KEY', 'OG_ANTHROPIC_LEDGER', 'OG_ANTHROPIC_MONTHLY_CAP_USD',
  'OG_ANTHROPIC_REVIEW_MODEL', 'OG_ANTHROPIC_MAX_RETRIES', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
const KEY = 'sk-ant-test-not-a-real-key';
let restore;
let realFetch;
let work;
let card;
const post = { title: 'Why etcd fsync latency matters', description: 'Disk latency and etcd.' };

beforeEach(() => {
  restore = saveEnv(ENV);
  realFetch = globalThis.fetch;
  failClosedFetch();
  work = mkdtempSync(join(tmpdir(), 'og-review-'));
  mkdirSync(join(work, 'slug'));
  card = join(work, 'slug', 'card.jpg');
  writeFileSync(card, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.OG_REVIEW_PROVIDER = 'anthropic';
  process.env.OG_ANTHROPIC_MAX_RETRIES = '0';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restore();
  rmSync(work, { recursive: true, force: true });
});

test('the default review provider is the local claude CLI', () => {
  delete process.env.OG_REVIEW_PROVIDER;
  assert.equal(reviewProvider(), 'claude-cli');
  assert.throws(() => reviewProvider({ OG_REVIEW_PROVIDER: 'gpt' }), /claude-cli\|anthropic/);
});

test('anthropic review sends the card as an image to claude-haiku-5-5 and parses the verdict', async () => {
  const calls = routeFetch(({ url }) => (url.startsWith('https://api.anthropic.com/v1/messages')
    ? message({ content: [{ type: 'text', text: '{"verdict":"pass","reason":"clear etcd disk scene"}' }] })
    : null));
  const v = await reviewCard({ card, post, workDir: work });
  assert.deepEqual(v, { verdict: 'pass', reason: 'clear etcd disk scene' });
  assert.equal(calls.length, 1);
  const { body, init } = calls[0];
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.temperature, undefined);
  const [img, text] = body.messages[0].content;
  assert.equal(img.type, 'image');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.equal(img.source.data, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64'));
  assert.match(text.text, /Why etcd fsync latency matters/);
  assert.doesNotMatch(text.text, /Read the image file/);
  const headers = new Headers(init.headers);
  assert.equal(headers.get('x-api-key'), KEY);
  // The ledger holds the cost of the reported usage, not the reservation.
  const l = loadLedger(anthropicLedgerPath(process.env, work));
  assert.equal(l.months[monthKey()].usd, usageCost('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 200 }));
  assert.equal(l.months[monthKey()].requests, 1);
});

test('anything but a clean pass is doubt, including a refusal', async () => {
  routeFetch(() => message({ content: [{ type: 'text', text: 'looks fine to me' }] }));
  assert.equal((await reviewCard({ card, post, workDir: work })).verdict, 'doubt');
  routeFetch(() => message({ content: [], stop_reason: 'refusal' }));
  assert.deepEqual(await reviewCard({ card, post, workDir: work }), { verdict: 'doubt', reason: 'reviewer declined to judge the card' });
});

test('the monthly cap refuses the request before anything is sent', async () => {
  process.env.OG_ANTHROPIC_MONTHLY_CAP_USD = '0.001';
  const ledgerFile = anthropicLedgerPath(process.env, work);
  saveLedger(ledgerFile, { months: { [monthKey()]: { usd: 0.0009, requests: 3 } }, batches: {} });
  const calls = routeFetch(() => message({ content: [] }));
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => e.name === 'BudgetError' && e.halt === true && /OG_ANTHROPIC_MONTHLY_CAP_USD/.test(e.message));
  assert.equal(calls.length, 0);
  assert.equal(loadLedger(ledgerFile).months[monthKey()].usd, 0.0009);
});

test('a refused key halts the run, credits the estimate back and never logs the key', async () => {
  routeFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }, 401));
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => {
    assert.equal(e.halt, true);
    assert.equal(e.status, 401);
    assert.ok(!e.message.includes(KEY), e.message);
    return true;
  });
  const l = loadLedger(anthropicLedgerPath(process.env, work));
  assert.equal(l.months[monthKey()].usd, 0);
  assert.equal(l.months[monthKey()].requests, 0);
});

test('a missing key halts without touching the ledger', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => e.halt && /ANTHROPIC_API_KEY is not set/.test(e.message));
});

test('pricing: haiku long-prompt rate card, cache tokens and fallback turns', () => {
  assert.equal(usageCost('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 1_000_000 }), 0.51);
  assert.equal(usageCost('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 0 }), 0.1); // $0.50/M above 100K
  assert.equal(usageCost('claude-sonnet-5-5', { input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 0 }), 2.7);
  // A fallback to a dearer (or unknown) model prices the whole response at that rate.
  assert.equal(usageCost('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 0, iterations: [{ type: 'fallback_message', model: 'claude-opus-5-5' }] }), 4);
  assert.equal(usageCost('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 0, iterations: [{ type: 'fallback_message', model: 'claude-new-x' }] }), 4);
  assert.equal(estimateUsd('claude-sonnet-5-5', { inputTokens: 1000, maxTokens: 16000 }), 0.162);
  assert.equal(anthropicCapUsd({}), 10);
  assert.throws(() => anthropicCapUsd({ OG_ANTHROPIC_MONTHLY_CAP_USD: 'x' }), /non-negative/);
  assert.equal(scrubKey('bad key sk-ant-api03-abc_DEF'), 'bad key sk-ant-[redacted]');
});

test('a per-run budget stops before a request that could exceed it', async () => {
  const ledgerFile = join(work, 'l.json');
  const budget = new RunBudget(0.01);
  let sent = 0;
  const send = async () => { sent++; return { usage: { input_tokens: 100, output_tokens: 100 } }; };
  const params = { model: 'claude-sonnet-5-5', max_tokens: 500, messages: [{ role: 'user', content: 'hi' }] };
  await meteredCreate({ ledgerFile, params, send, runBudget: budget });
  assert.equal(budget.spent, 0.0012);
  await assert.rejects(meteredCreate({ ledgerFile, params: { ...params, max_tokens: 16000 }, send, runBudget: budget }), /per-run Anthropic limit/);
  assert.equal(sent, 1);
});
