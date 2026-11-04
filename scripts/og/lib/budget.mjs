// Monthly spend cap for OpenAI image generation. Every request is priced from the
// constants below before it is sent, and a request that would push the estimated
// month-to-date spend over the cap is refused. Months are calendar months in UTC.
//
// The ledger is a small JSON file in the gitignored .og-work/ (override with
// OG_OPENAI_LEDGER), next to run.lock and the card files: it is machine-local state
// like they are, it never makes daily-publish.sh see a dirty tree, and the
// publisher database replaces it in Phase 1. Shape:
//   { "months":  { "2026-11": { "usd": 1.234, "images": 100 } },
//     "batches": { "batch_abc": { "month": "2026-11", "items": { "<slug>": 0.0081 } } } }
// "batches" holds the per-card estimate of each batch until collect-batch settles it,
// so cards a batch did not draw (failed, expired, cancelled) are credited back.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// USD per image, by model, quality and size, from the OpenAI model page
// (developers.openai.com/api/docs/models/gpt-image-1-mini), read 2026-11-03.
// These are Standard (synchronous) prices; Batch is half (BATCH_DISCOUNT), per
// developers.openai.com/api/docs/guides/batch and the Batch tab of
// developers.openai.com/api/docs/pricing (image output $8 vs $4 per 1M tokens).
export const IMAGE_PRICES = {
  'gpt-image-1-mini': {
    low: { '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 },
    medium: { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 },
    high: { '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 },
  },
};
// Text prompt tokens are billed on top of the image: $2 per 1M for gpt-image-1-mini
// (same pricing page, read 2026-11-03). Estimated at 4 characters per token.
export const TEXT_INPUT_USD_PER_M = { 'gpt-image-1-mini': 2 };
export const BATCH_DISCOUNT = 0.5;
export const DEFAULT_CAP_USD = 25;

export class BudgetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BudgetError';
    this.halt = true; // run.mjs stops the run instead of marking cards failed
  }
}

export function capUsd(env = process.env) {
  const raw = env.OG_OPENAI_MONTHLY_CAP_USD;
  if (raw === undefined || raw === '') return DEFAULT_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new BudgetError(`OG_OPENAI_MONTHLY_CAP_USD is not a non-negative number: ${raw}`);
  return n;
}

export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // UTC YYYY-MM
}

const round = (n) => Math.round(n * 1e6) / 1e6;

// Estimated USD for one image request. Unknown combinations are refused: a cap is
// only as good as its price, so we never guess one.
export function estimateCost({ model, quality, size, prompt = '', batch = false }) {
  const per = IMAGE_PRICES[model]?.[quality]?.[size];
  if (per === undefined) {
    throw new BudgetError(`no price for ${model} quality=${quality} size=${size}; add it to IMAGE_PRICES in scripts/og/lib/budget.mjs`);
  }
  const text = (Math.ceil(String(prompt).length / 4) * (TEXT_INPUT_USD_PER_M[model] || 0)) / 1e6;
  return round((per + text) * (batch ? BATCH_DISCOUNT : 1));
}

export function loadLedger(path) {
  if (!existsSync(path)) return { months: {}, batches: {} };
  const l = JSON.parse(readFileSync(path, 'utf8'));
  return { months: l.months || {}, batches: l.batches || {} };
}

export function saveLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

export function spent(ledger, month = monthKey()) {
  return ledger.months[month]?.usd || 0;
}

// How much is left this month (never negative).
export function remaining(ledger, { cap = capUsd(), month = monthKey() } = {}) {
  return Math.max(0, round(cap - spent(ledger, month)));
}

function add(ledger, month, usd, images) {
  const m = ledger.months[month] || (ledger.months[month] = { usd: 0, images: 0 });
  m.usd = Math.max(0, round(m.usd + usd));
  m.images = Math.max(0, m.images + images);
}

// Records an estimated spend, refusing it if it would cross the cap. Call before
// the request goes out; refund() if the request is known not to have been billed.
export function reserve(ledger, usd, { cap = capUsd(), month = monthKey(), images = 1 } = {}) {
  const before = spent(ledger, month);
  if (round(before + usd) > cap) {
    throw new BudgetError(
      `OpenAI monthly cap reached: ${month} estimated spend $${before.toFixed(4)} + $${usd.toFixed(4)} would exceed `
      + `the $${cap.toFixed(2)} cap (OG_OPENAI_MONTHLY_CAP_USD). Nothing was sent.`,
    );
  }
  add(ledger, month, usd, images);
  return month;
}

export function refund(ledger, usd, { month = monthKey(), images = 1 } = {}) {
  add(ledger, month, -usd, -images);
}
