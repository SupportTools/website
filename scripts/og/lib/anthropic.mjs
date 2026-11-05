// Anthropic Messages API client plus a monthly spend cap, for the card reviewer
// (lib/ai.mjs, OG_REVIEW_PROVIDER=anthropic) and the weekly social drafter
// (scripts/social/weekly-drafter.mjs). Mirrors lib/budget.mjs for OpenAI: every
// request is priced before it is sent and refused if the estimate would push the
// month over the cap; once the response is back the estimate is replaced by the
// cost of the usage the API reported.
//
// Ledger: OG_ANTHROPIC_LEDGER, default <work dir>/anthropic-ledger.json, where the
// work dir is OG_WORK_DIR (in the cluster a PVC) or the repo's .og-work/. Shape:
//   { "months": { "2026-11": { "usd": 0.0123, "requests": 42 } }, "batches": {} }
// Cap: OG_ANTHROPIC_MONTHLY_CAP_USD, default 10. Months are calendar months in UTC.
//
// ANTHROPIC_API_KEY is read from the environment at call time and only handed to
// the SDK; error text is scrubbed of anything key-shaped before it is logged.
import { join } from 'node:path';
import { loadLedger, saveLedger, monthKey, BudgetError } from './budget.mjs';

// USD per 1M tokens, Claude API first-party rates (claude-api skill model table,
// cached 2026-10-06, read 2026-11-04). Haiku 5.5 has a second rate card for prompts
// over 100K tokens. Cache writes (5 min) cost 1.25x input, cache reads 0.1x.
export const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, longIn: 0.50, longOut: 2.50, longAbove: 100_000 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;
// A model missing from PRICES (say a fallback the server picked) is priced at the
// most expensive known rate, so the cap can only over-count.
const MAX_PRICE = Object.values(PRICES).reduce((m, p) => (p.in > m.in ? p : m));

export const DEFAULT_ANTHROPIC_CAP_USD = 10;
export const REVIEW_MODEL = 'claude-haiku-5-5';
export const DRAFTER_MODEL = 'claude-sonnet-5-5';

const round = (n) => Math.round(n * 1e6) / 1e6;

export function anthropicCapUsd(env = process.env) {
  const raw = env.OG_ANTHROPIC_MONTHLY_CAP_USD;
  if (raw === undefined || raw === '') return DEFAULT_ANTHROPIC_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new BudgetError(`OG_ANTHROPIC_MONTHLY_CAP_USD is not a non-negative number: ${raw}`);
  return n;
}

export function anthropicLedgerPath(env = process.env, workDir) {
  return env.OG_ANTHROPIC_LEDGER || join(workDir, 'anthropic-ledger.json');
}

export function scrubKey(text) {
  return String(text).replace(/\bsk-ant-[A-Za-z0-9_*.-]+/g, 'sk-ant-[redacted]');
}

function rates(model, inputTokens = 0) {
  const p = PRICES[model];
  if (!p) return MAX_PRICE;
  if (p.longAbove && inputTokens > p.longAbove) return { in: p.longIn, out: p.longOut };
  return p;
}

// USD for one response's usage. If a server-side fallback served the response,
// the whole usage is priced at the dearest model involved.
export function usageCost(model, usage = {}) {
  const prompt = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  let r = rates(model, prompt);
  for (const it of usage.iterations || []) {
    if (it?.type !== 'fallback_message') continue;
    const f = rates(it.model, prompt);
    if (f.in > r.in) r = f;
  }
  const usd = ((usage.input_tokens || 0) * r.in
    + (usage.cache_creation_input_tokens || 0) * r.in * CACHE_WRITE
    + (usage.cache_read_input_tokens || 0) * r.in * CACHE_READ
    + (usage.output_tokens || 0) * r.out) / 1e6;
  return round(usd);
}

// Worst-case USD for a request before it is sent: every input token uncached and
// every allowed output token used.
export function estimateUsd(model, { inputTokens, maxTokens }) {
  const r = rates(model, inputTokens);
  return round((inputTokens * r.in + maxTokens * r.out) / 1e6);
}

// Rough input-token count for a request body: 3 characters per token for text,
// plus up to 1600 tokens per image (a 1200x630 card is about 1000).
export function roughInputTokens(params) {
  let images = 0;
  const text = JSON.stringify(params, (k, v) => {
    if (v && typeof v === 'object' && v.type === 'image') { images++; return '[image]'; }
    return v;
  });
  return Math.ceil(text.length / 3) + images * 1600;
}

function add(ledger, month, usd, requests) {
  const m = ledger.months[month] || (ledger.months[month] = { usd: 0, requests: 0 });
  m.usd = Math.max(0, round((m.usd || 0) + usd));
  m.requests = Math.max(0, (m.requests || 0) + requests);
}

export function spentThisMonth(ledger, month = monthKey()) {
  return ledger.months[month]?.usd || 0;
}

export function reserveAnthropic(ledger, usd, { cap = anthropicCapUsd(), month = monthKey() } = {}) {
  const before = spentThisMonth(ledger, month);
  if (round(before + usd) > cap) {
    throw new BudgetError(
      `Anthropic monthly cap reached: ${month} spend $${before.toFixed(4)} + $${usd.toFixed(4)} would exceed `
      + `the $${cap.toFixed(2)} cap (OG_ANTHROPIC_MONTHLY_CAP_USD). Nothing was sent.`,
    );
  }
  add(ledger, month, usd, 1);
  return month;
}

// The SDK is imported on first use, so the workstation paths (claude CLI reviewer,
// run.mjs status) keep working in a checkout without node_modules.
export async function makeClient({ apiKey = process.env.ANTHROPIC_API_KEY, fetch } = {}) {
  if (!apiKey) {
    const e = new Error('ANTHROPIC_API_KEY is not set');
    e.halt = true;
    throw e;
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({
    apiKey,
    // Always the current global fetch (tests replace it), unless one is passed.
    fetch: fetch || ((...a) => globalThis.fetch(...a)),
    maxRetries: Number(process.env.OG_ANTHROPIC_MAX_RETRIES || 2),
    timeout: Number(process.env.OG_ANTHROPIC_TIMEOUT_MS || 120_000),
  });
}

// Per-run spend limit on top of the monthly cap (the drafter uses it).
export class RunBudget {
  constructor(limitUsd) { this.limit = limitUsd; this.spent = 0; }
}

// Sends one request through `send(params)`, metered against the monthly ledger and
// an optional RunBudget. An HTTP error (not billed) credits the estimate back; a
// network failure keeps it, since the request may have been billed.
export async function meteredCreate({ ledgerFile, params, send, runBudget, cap = anthropicCapUsd() }) {
  const est = estimateUsd(params.model, { inputTokens: roughInputTokens(params), maxTokens: params.max_tokens });
  if (runBudget && round(runBudget.spent + est) > runBudget.limit) {
    throw new BudgetError(
      `per-run Anthropic limit reached: $${runBudget.spent.toFixed(4)} spent + $${est.toFixed(4)} estimated would exceed $${runBudget.limit.toFixed(2)}`,
    );
  }
  let ledger = loadLedger(ledgerFile);
  const month = reserveAnthropic(ledger, est, { cap });
  saveLedger(ledgerFile, ledger);
  let res;
  try {
    res = await send(params);
  } catch (e) {
    if (typeof e.status === 'number') {
      ledger = loadLedger(ledgerFile);
      add(ledger, month, -est, -1);
      saveLedger(ledgerFile, ledger);
    }
    const err = new Error(`Anthropic ${params.model}: ${e.status ? `HTTP ${e.status}: ` : ''}${scrubKey(e.message).split('\n')[0].slice(0, 300)}`);
    err.status = e.status;
    if (e.status === 401 || e.status === 403) err.halt = true; // bad key: every call would fail
    throw err;
  }
  const actual = usageCost(params.model, res.usage);
  ledger = loadLedger(ledgerFile);
  add(ledger, month, actual - est, 0);
  saveLedger(ledgerFile, ledger);
  if (runBudget) runBudget.spent = round(runBudget.spent + actual);
  return { message: res, usd: actual };
}
