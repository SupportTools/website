// Card review through OpenAI Chat Completions (OG_REVIEW_PROVIDER=openai), INTERIM
// until TaskForge supporttools-website-990. fetch is mocked and fails closed;
// nothing here touches the network.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCard, reviewProvider } from '../../scripts/og/lib/ai.mjs';
import { reviewUsageCost, reviewEstimateUsd, REVIEW_MODEL } from '../../scripts/og/lib/openai-review.mjs';
import { ledgerPath } from '../../scripts/og/lib/openai.mjs';
import { loadLedger, saveLedger, monthKey } from '../../scripts/og/lib/budget.mjs';
import { failClosedFetch, saveEnv, routeFetch, json } from './helpers.mjs';

const ENV = ['OG_REVIEW_PROVIDER', 'OPENAI_API_KEY', 'OG_OPENAI_LEDGER', 'OG_OPENAI_MONTHLY_CAP_USD',
  'OG_OPENAI_REVIEW_MODEL', 'OG_OPENAI_ATTEMPTS', 'OG_OPENAI_BACKOFF_MS', 'ANTHROPIC_API_KEY'];
const KEY = 'sk-test-not-a-real-openai-key';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const USAGE = { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } };
let restore;
let realFetch;
let work;
let card;
const post = { title: 'Why etcd fsync latency matters', description: 'Disk latency and etcd.' };

const isChat = (url) => {
  const u = new URL(url);
  return u.origin === 'https://api.openai.com' && u.pathname === '/v1/chat/completions';
};
const completion = ({ content = null, refusal = null, finish_reason = 'stop', usage = USAGE } = {}) => json({
  id: 'chatcmpl-test', object: 'chat.completion', model: REVIEW_MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content, refusal }, finish_reason }], usage,
});

beforeEach(() => {
  restore = saveEnv(ENV);
  realFetch = globalThis.fetch;
  failClosedFetch();
  work = mkdtempSync(join(tmpdir(), 'og-review-openai-'));
  mkdirSync(join(work, 'slug'));
  card = join(work, 'slug', 'card.jpg');
  writeFileSync(card, JPEG);
  process.env.OPENAI_API_KEY = KEY;
  process.env.OG_REVIEW_PROVIDER = 'openai';
  process.env.OG_OPENAI_BACKOFF_MS = '1';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restore();
  rmSync(work, { recursive: true, force: true });
});

test('openai is an accepted review provider; the default stays the claude CLI', () => {
  assert.equal(reviewProvider({ OG_REVIEW_PROVIDER: 'openai' }), 'openai');
  assert.equal(reviewProvider({}), 'claude-cli');
});

test('openai review sends the card as a data URL image to gpt-6-luna and parses the verdict', async () => {
  const calls = routeFetch(({ url }) => (isChat(url)
    ? completion({ content: '{"verdict":"pass","reason":"clear etcd disk scene"}' })
    : null));
  const v = await reviewCard({ card, post, workDir: work });
  assert.deepEqual(v, { verdict: 'pass', reason: 'clear etcd disk scene' });
  assert.equal(calls.length, 1);
  const { body, init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_completion_tokens, 2000);
  const [text, img] = body.messages[0].content;
  assert.equal(text.type, 'text');
  assert.match(text.text, /Why etcd fsync latency matters/);
  assert.match(text.text, /"verdict":"pass"\|"doubt"/);
  assert.doesNotMatch(text.text, /Read the image file/);
  assert.equal(img.type, 'image_url');
  assert.equal(img.image_url.url, `data:image/jpeg;base64,${JPEG.toString('base64')}`);
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${KEY}`);
  // The shared OpenAI ledger holds the cost of the reported usage, counted as a
  // review and not as an image.
  const m = loadLedger(ledgerPath(process.env, work)).months[monthKey()];
  assert.equal(m.usd, reviewUsageCost('gpt-6-luna', USAGE));
  assert.equal(m.usd, 0.0003);
  assert.equal(m.images, 0);
  assert.equal(m.reviews, 1);
});

test('OG_OPENAI_REVIEW_MODEL overrides the model; an unpriced model is refused before sending', async () => {
  process.env.OG_OPENAI_REVIEW_MODEL = 'gpt-unknown-x';
  const calls = routeFetch(() => completion({ content: '{"verdict":"pass","reason":"x"}' }));
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => e.name === 'BudgetError' && /REVIEW_PRICES/.test(e.message));
  assert.equal(calls.length, 0);
});

test('anything but a clean pass is doubt: prose, a refusal, a cut-off reply', async () => {
  routeFetch(() => completion({ content: 'looks fine to me' }));
  assert.equal((await reviewCard({ card, post, workDir: work })).verdict, 'doubt');
  routeFetch(() => completion({ refusal: 'I cannot help with that.' }));
  assert.deepEqual(await reviewCard({ card, post, workDir: work }), { verdict: 'doubt', reason: 'reviewer declined to judge the card' });
  routeFetch(() => completion({ content: '{"verdict":"pass","reason":"x"}', finish_reason: 'length' }));
  assert.equal((await reviewCard({ card, post, workDir: work })).verdict, 'doubt');
});

test('the shared OpenAI monthly cap refuses the review before anything is sent (run.mjs exit 4)', async () => {
  process.env.OG_OPENAI_MONTHLY_CAP_USD = '1';
  const file = ledgerPath(process.env, work);
  saveLedger(file, { months: { [monthKey()]: { usd: 0.9995, images: 100 } }, batches: {} });
  const calls = routeFetch(() => completion({ content: '{"verdict":"pass","reason":"x"}' }));
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => e.name === 'BudgetError' && e.halt === true && /OG_OPENAI_MONTHLY_CAP_USD/.test(e.message));
  assert.equal(calls.length, 0);
  assert.deepEqual(loadLedger(file).months[monthKey()], { usd: 0.9995, images: 100 });
});

test('a refused key halts the run, credits the estimate back and never shows the key', async () => {
  const calls = routeFetch(() => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401));
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => {
    assert.equal(e.halt, true);
    assert.equal(e.status, 401);
    assert.ok(!e.message.includes(KEY), e.message);
    return true;
  });
  assert.equal(calls.length, 1);
  const m = loadLedger(ledgerPath(process.env, work)).months[monthKey()];
  assert.equal(m.usd, 0);
});

test('a dropped connection keeps the estimate (it may have been billed) and is not retried', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError('fetch failed'); };
  await assert.rejects(reviewCard({ card, post, workDir: work }), /fetch failed/);
  assert.equal(n, 1);
  const est = reviewEstimateUsd('gpt-6-luna', { textChars: 1, images: 1, maxTokens: 2000 });
  assert.ok(loadLedger(ledgerPath(process.env, work)).months[monthKey()].usd >= est);
});

test('a missing OpenAI key halts without touching the ledger', async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(reviewCard({ card, post, workDir: work }), (e) => e.halt && /OPENAI_API_KEY is not set/.test(e.message));
  assert.deepEqual(loadLedger(ledgerPath(process.env, work)).months, {});
});

test('pricing: cached input and the long-prompt multipliers', () => {
  // $0.10/M input, $0.01/M cached, $0.125/M cache write, $0.50/M output. Uncached input
  // is charged at the cache-write price, since usage does not say what was written.
  assert.equal(reviewUsageCost('gpt-6-luna', { prompt_tokens: 200_000, completion_tokens: 200_000 }), 0.125);
  assert.equal(reviewUsageCost('gpt-6-luna', { prompt_tokens: 200_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 200_000 } }), 0.002);
  // Over 272K input tokens: 2x input, 1.5x output.
  assert.equal(reviewUsageCost('gpt-6-luna', { prompt_tokens: 300_000, completion_tokens: 1_000_000 }), 0.825);
  assert.equal(reviewEstimateUsd('gpt-6-luna', { textChars: 3000, images: 1, maxTokens: 2000 }), 0.001375);
});
