// Card review through the OpenAI Chat Completions API (OG_REVIEW_PROVIDER=openai).
//
// INTERIM (TaskForge supporttools-website-990): the in-cluster nightly job has an
// OpenAI key but no Anthropic key yet, so it reviews with OpenAI until #990 brings
// the Anthropic key. The anthropic provider (lib/anthropic.mjs) stays the job's
// default and the claude CLI stays the workstation default; nothing here changes them.
//
// Same verdict structure as the other reviewers: the prompt is reviewPrompt(post)
// from lib/ai.mjs, the reply goes through parseVerdict, and anything that is not a
// clean pass (a refusal, no text, a cut-off reply) is doubt.
//
// API shape (developers.openai.com/api/reference, chat completions, read 2026-11-04):
//   POST /v1/chat/completions {model, messages, max_completion_tokens, reasoning_effort}
//     user content parts: {type: "text", text} and
//     {type: "image_url", image_url: {url: "data:image/jpeg;base64,...", detail}}
//   -> {choices: [{message: {content, refusal}, finish_reason}],
//       usage: {prompt_tokens, completion_tokens, prompt_tokens_details: {cached_tokens}}}
//
// Spend goes in the same ledger as image generation (lib/budget.mjs, OG_OPENAI_LEDGER,
// default <work dir>/openai-ledger.json) under the same OG_OPENAI_MONTHLY_CAP_USD:
// the estimate is reserved before the request goes out (refused at the cap: a
// BudgetError, which run.mjs turns into exit 4), an HTTP error credits it back, a
// network failure keeps it (it may have been billed), and a response replaces it
// with the cost of the usage OpenAI reported. Reviews add to months[m].reviews and
// never to months[m].images.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { apiFetch, ledgerPath } from './openai.mjs';
import { loadLedger, saveLedger, reserve, refund, capUsd, BudgetError } from './budget.mjs';

// gpt-6-luna: text and image input, text output, Chat Completions supported,
// reasoning effort none|low|medium|high|xhigh|max, not deprecated; the cheapest
// vision-capable text model on the pricing page. Source: the model page
// developers.openai.com/api/docs/models/gpt-6-luna and the Standard tab of
// developers.openai.com/api/docs/pricing, both read 2026-11-04. (gpt-5-mini and
// gpt-5.4-nano are cheaper or close but both are marked deprecated there.)
export const REVIEW_MODEL = 'gpt-6-luna';

// USD per 1M tokens, same sources. Prompts over 272K input tokens cost 2x input and
// 1.5x output on gpt-6-luna; a card review is a few thousand tokens, but the rule is
// applied anyway so a cap is never under-counted. Cache writes are listed at $0.125/M
// and Chat Completions usage does not say which uncached input tokens were written
// to the cache, so every uncached input token is charged at the higher of the input
// and cache-write prices: an upper bound, never an under-count (INTERIM, #990).
export const REVIEW_PRICES = {
  'gpt-6-luna': { in: 0.10, cachedIn: 0.01, cacheWrite: 0.125, out: 0.50, longAbove: 272_000, longIn: 2, longOut: 1.5 },
};

// Reasoning and visible tokens both count against this; a one-line JSON verdict at
// effort "low" needs far less. finish_reason "length" reads as doubt.
export const REVIEW_MAX_COMPLETION_TOKENS = 2000;
// Reserved per attached image before the request is sent. A 1200x630 card at
// detail "high" is well under this; the actual usage replaces it afterwards.
export const IMAGE_TOKEN_RESERVE = 2000;

const round = (n) => Math.round(n * 1e6) / 1e6;

// A model with no price is refused, as in lib/budget.mjs: a cap is only as good as
// its price, so one is never guessed.
function prices(model) {
  const p = REVIEW_PRICES[model];
  if (!p) throw new BudgetError(`no price for review model ${model}; add it to REVIEW_PRICES in scripts/og/lib/openai-review.mjs`);
  return p;
}

export function reviewUsageCost(model, usage = {}) {
  const p = prices(model);
  const prompt = usage.prompt_tokens || 0;
  const cached = Math.min(prompt, usage.prompt_tokens_details?.cached_tokens || 0);
  const long = prompt > p.longAbove;
  const inMul = long ? p.longIn : 1;
  const outMul = long ? p.longOut : 1;
  const uncachedIn = Math.max(p.in, p.cacheWrite || 0);
  return round(((prompt - cached) * uncachedIn * inMul + cached * p.cachedIn * inMul
    + (usage.completion_tokens || 0) * p.out * outMul) / 1e6);
}

// Worst case before sending: every input token uncached, every completion token used.
export function reviewEstimateUsd(model, { textChars, images, maxTokens }) {
  return reviewUsageCost(model, {
    prompt_tokens: Math.ceil(textChars / 3) + images * IMAGE_TOKEN_RESERVE,
    completion_tokens: maxTokens,
  });
}

export function reviewRequestBody({ model, prompt, jpeg }) {
  return {
    model,
    reasoning_effort: 'low',
    max_completion_tokens: REVIEW_MAX_COMPLETION_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'high' } },
      ],
    }],
  };
}

// Returns {verdict, reason}. `prompt` is reviewPrompt(post) and `parse` is
// parseVerdict, both passed in by lib/ai.mjs so the three reviewers share them.
export async function reviewCardOpenAI({ card, prompt, parse, workDir, timeoutMs = 120000, ...opts }) {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY is not set');
    e.halt = true;
    throw e;
  }
  const model = process.env.OG_OPENAI_REVIEW_MODEL || REVIEW_MODEL;
  const body = reviewRequestBody({ model, prompt, jpeg: readFileSync(card) });
  const est = reviewEstimateUsd(model, { textChars: prompt.length, images: 1, maxTokens: body.max_completion_tokens });
  const path = ledgerPath(process.env, workDir || join(dirname(card), '..'));
  let ledger = loadLedger(path);
  const month = reserve(ledger, est, { cap: capUsd(), images: 0 });
  saveLedger(path, ledger);
  let res;
  try {
    // Retries 429 and 5xx (not billed); a dropped connection is not retried, so a
    // review that may have been billed is never billed twice.
    res = await apiFetch('/chat/completions', { method: 'POST', json: body, timeoutMs, retryNetwork: false, ...opts });
  } catch (e) {
    if (e.status) {
      ledger = loadLedger(path);
      refund(ledger, est, { month, images: 0 });
      saveLedger(path, ledger);
    }
    throw e;
  }
  const out = await res.json();
  ledger = loadLedger(path);
  // refund() of (estimate - actual) leaves the actual cost in the month.
  refund(ledger, round(est - reviewUsageCost(model, out.usage)), { month, images: 0 });
  const m = ledger.months[month];
  m.reviews = (m.reviews || 0) + 1;
  saveLedger(path, ledger);

  const choice = out.choices?.[0] || {};
  if (choice.message?.refusal) return { verdict: 'doubt', reason: 'reviewer declined to judge the card' };
  if (choice.finish_reason === 'length') return { verdict: 'doubt', reason: 'reviewer ran out of tokens before a verdict' };
  return parse(choice.message?.content || '');
}
