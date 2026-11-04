// Batch card art: submit-batch sends the next cards that need new art to the OpenAI
// Batch API in one JSONL file (custom_id = post slug) and marks them "batched" with
// the batch id; collect-batch downloads the results, writes each raw.png and marks
// the card "drawn" (or "failed" with the reason). A normal run then composes,
// reviews and uploads drawn cards without drawing them again.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCost, loadLedger, saveLedger, reserve, refund, remaining, capUsd, monthKey, BudgetError } from './budget.mjs';
import {
  imageConfig, batchJsonl, uploadBatchFile, createBatch, getBatch, fileLines, writeRawPng, BATCH_PENDING, scrub,
} from './openai.mjs';

// Cards that need a new illustration (ready/approved only need an upload, drawn
// only needs compose and review, batched is already waiting on a batch).
export function needsArt(entry) {
  return !entry || !entry.status || ['rejected', 'failed'].includes(entry.status);
}

// Large batches mean large output files (a few MB of base64 per image), so a
// submit is split into batches of at most this many requests.
export const DEFAULT_BATCH_MAX = 100;

export async function submitBatch({
  manifest, posts, promptFor, workDir, ledgerFile, limit = Infinity, maxPerBatch = DEFAULT_BATCH_MAX,
  save = () => {}, log = console.log, now = () => new Date(), apiOpts = {},
}) {
  const cfg = imageConfig();
  const cap = capUsd();
  const candidates = posts.filter((p) => p && needsArt(manifest[p.slug])).slice(0, limit);
  const month = monthKey(now());
  let left = remaining(loadLedger(ledgerFile), { cap, month });
  const items = [];
  for (const post of candidates) {
    const prompt = promptFor(post, manifest[post.slug]);
    const usd = estimateCost({ ...cfg, prompt, batch: true });
    if (usd > left) break;
    left -= usd;
    items.push({ slug: post.slug, prompt, usd });
  }
  const result = { batches: [], capped: items.length < candidates.length, skipped: candidates.length - items.length };
  if (!candidates.length) {
    log('submit-batch: no cards need new art');
    return result;
  }
  if (!items.length) {
    throw new BudgetError(
      `OpenAI monthly cap reached: $${(cap - left).toFixed(4)} of $${cap.toFixed(2)} estimated for ${month}; `
      + `no room for one more card. Nothing was submitted (raise OG_OPENAI_MONTHLY_CAP_USD or wait for next month).`,
    );
  }
  for (let i = 0; i < items.length; i += maxPerBatch) {
    const chunk = items.slice(i, i + maxPerBatch);
    const usd = chunk.reduce((s, x) => s + x.usd, 0);
    for (const { slug, prompt } of chunk) {
      mkdirSync(join(workDir, slug), { recursive: true });
      writeFileSync(join(workDir, slug, 'prompt.txt'), prompt);
    }
    const jsonl = batchJsonl(chunk, cfg);
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    mkdirSync(join(workDir, 'batches'), { recursive: true });
    writeFileSync(join(workDir, 'batches', `${stamp}-${i / maxPerBatch}.jsonl`), jsonl);
    // Reserve before anything is sent, so a crash after the batch is created can
    // only over-count the month, never under-count it.
    let ledger = loadLedger(ledgerFile);
    reserve(ledger, usd, { cap, month, images: chunk.length });
    saveLedger(ledgerFile, ledger);
    let batch;
    try {
      const fileId = await uploadBatchFile(jsonl, `og-cards-${stamp}.jsonl`, apiOpts);
      batch = await createBatch(fileId, { source: 'support.tools og cards', cards: String(chunk.length) }, apiOpts);
    } catch (e) {
      ledger = loadLedger(ledgerFile);
      refund(ledger, usd, { month, images: chunk.length });
      saveLedger(ledgerFile, ledger);
      throw e;
    }
    ledger = loadLedger(ledgerFile);
    ledger.batches[batch.id] = { month, items: Object.fromEntries(chunk.map((x) => [x.slug, x.usd])) };
    saveLedger(ledgerFile, ledger);
    const at = now().toISOString();
    for (const { slug } of chunk) {
      const entry = manifest[slug] || (manifest[slug] = { attempts: 0 });
      Object.assign(entry, { status: 'batched', batchId: batch.id, provider: 'openai', updated: at });
    }
    save();
    result.batches.push({ id: batch.id, count: chunk.length, usd: Math.round(usd * 1e6) / 1e6 });
    log(`submit-batch: ${batch.id} with ${chunk.length} cards, estimated $${usd.toFixed(4)}`);
  }
  if (result.capped) {
    log(`submit-batch: stopped at the $${cap.toFixed(2)} monthly cap; ${result.skipped} cards wait for next month`);
  }
  return result;
}

function failureReason(line) {
  const m = line?.error?.message || line?.response?.body?.error?.message
    || (line?.response?.status_code ? `HTTP ${line.response.status_code}` : 'no result');
  return scrub(m);
}

// Collects one batch. Returns { state, drawn, failed }; a batch still running is
// left alone (state is its status) and can be collected again later. Safe to run
// twice: only cards still "batched" on this id are touched.
export async function collectBatch({
  manifest, id, workDir, ledgerFile, save = () => {}, log = console.log, now = () => new Date(), apiOpts = {},
}) {
  const batch = await getBatch(id, apiOpts);
  const counts = batch.request_counts || {};
  if (BATCH_PENDING.includes(batch.status)) {
    log(`collect-batch: ${id} is ${batch.status} (${counts.completed || 0}/${counts.total || '?'} done)`);
    return { state: batch.status, drawn: 0, failed: 0 };
  }
  const waiting = new Set(Object.entries(manifest).filter(([, e]) => e.batchId === id && e.status === 'batched').map(([s]) => s));
  const at = () => now().toISOString();
  // Each card's estimate is settled as its result is read: kept when the card was
  // drawn (billed), credited back when the request failed (not billed). Settled
  // cards leave rec.items, so a collect that dies part way can simply be rerun.
  const ledger = loadLedger(ledgerFile);
  const rec = ledger.batches[id];
  const settle = (slug, billed) => {
    const usd = rec?.items?.[slug];
    if (usd === undefined) return;
    if (!billed) refund(ledger, usd, { month: rec.month });
    delete rec.items[slug];
  };
  let drawn = 0;
  let failed = 0;
  const fail = (slug, reason, billed = false) => {
    if (!waiting.has(slug)) return;
    Object.assign(manifest[slug], { status: 'failed', reason: `batch ${id}: ${reason}`.slice(0, 300), updated: at() });
    waiting.delete(slug);
    settle(slug, billed);
    failed++;
  };
  try {
    if (batch.output_file_id) {
      for await (const line of fileLines(batch.output_file_id, apiOpts)) {
        const slug = line.custom_id;
        if (!waiting.has(slug)) continue;
        if (line.response?.status_code !== 200) { fail(slug, failureReason(line)); continue; }
        try {
          const dir = join(workDir, slug);
          mkdirSync(dir, { recursive: true });
          writeRawPng(dir, line.response.body?.data?.[0]?.b64_json);
        } catch (e) {
          fail(slug, e.message, true); // drawn and billed, but unusable
          continue;
        }
        const entry = manifest[slug];
        entry.attempts = (entry.attempts || 0) + 1;
        delete entry.reason;
        Object.assign(entry, { status: 'drawn', updated: at() });
        waiting.delete(slug);
        settle(slug, true);
        drawn++;
      }
    }
    if (batch.error_file_id) {
      for await (const line of fileLines(batch.error_file_id, apiOpts)) fail(line.custom_id, failureReason(line));
    }
    const batchErr = batch.errors?.data?.map((e) => e.message).filter(Boolean).join('; ');
    for (const slug of [...waiting]) {
      fail(slug, batchErr ? `${batch.status}: ${scrub(batchErr)}` : `batch ${batch.status} without a result for this card`);
    }
    // Anything left in the record belongs to cards no longer waiting on this batch
    // (re-queued by hand): nothing was drawn for them, so credit it back.
    if (rec) {
      for (const slug of Object.keys(rec.items)) settle(slug, false);
      delete ledger.batches[id];
    }
  } finally {
    save();
    saveLedger(ledgerFile, ledger);
  }
  log(`collect-batch: ${id} ${batch.status}: ${drawn} drawn, ${failed} failed`);
  return { state: batch.status, drawn, failed };
}

// Every batch id that still has cards waiting on it.
export function pendingBatchIds(manifest) {
  return [...new Set(Object.values(manifest).filter((e) => e.status === 'batched' && e.batchId).map((e) => e.batchId))];
}
