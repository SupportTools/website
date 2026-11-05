#!/usr/bin/env node
// Drafts next Monday-Sunday's LinkedIn and Bluesky posts in Buffer, as drafts with
// their intended times: the API port of weekly-buffer.sh (no claude CLI, no MCP).
// The owner reviews the drafts and tags the ones to publish "approved"; guard.mjs
// promote schedules them once their article is live. Never publishes.
//
//   node scripts/social/weekly-drafter.mjs [--dry-run] [--plan-only] [--week-start YYYY-MM-DD] [--max-turns N]
//
//   --plan-only  print the week's plan and stop: no Anthropic or Buffer calls.
//   --dry-run    Claude writes the copy and the planned drafts are printed; Buffer is
//                never called (so posts already in Buffer are not known and not skipped).
//
// Environment: ANTHROPIC_API_KEY, BUFFER_API_KEY (not needed for --dry-run or
// --plan-only), BUFFER_ORG_ID, SOCIAL_DRAFTER_MODEL (default claude-sonnet-5-5),
// SOCIAL_ANTHROPIC_RUN_CAP_USD (per-run limit, default 3), OG_ANTHROPIC_MONTHLY_CAP_USD
// and OG_ANTHROPIC_LEDGER / OG_WORK_DIR (the monthly cap shared with the card reviewer).
// Exit: 0 every planned draft exists, 2 some were not created, 4 a spend cap stopped
// it, 1 the run failed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './lib/buffer.mjs';
import { loadPages } from './lib/links.mjs';
import {
  ORG_ID, weekDays, weekArticles, loadManifest, planWeek, runDrafter, chicagoParts,
} from './lib/drafter.mjs';
import { makeClient, anthropicLedgerPath, DRAFTER_MODEL } from '../og/lib/anthropic.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

async function main() {
  const dryRun = flag('--dry-run');
  const planOnly = flag('--plan-only');
  const now = new Date();
  const p = chicagoParts(now);
  const today = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const days = weekDays(now, opt('--week-start'));
  const articles = weekArticles(REPO, days, loadManifest(REPO));
  const pages = loadPages(path.join(REPO, 'blog/content'));

  let buffer = null;
  let existing = [];
  if (!dryRun && !planOnly) {
    if (!process.env.BUFFER_API_KEY) throw new Error('BUFFER_API_KEY is not set');
    buffer = createClient({ apiKey: process.env.BUFFER_API_KEY, ...(process.env.BUFFER_URL ? { url: process.env.BUFFER_URL } : {}) });
    existing = await buffer.posts(process.env.BUFFER_ORG_ID || ORG_ID, ['draft', 'scheduled']);
  }
  const plan = planWeek({ articles, days, existing, now });
  console.log(`week ${days[0].date}..${days[6].date}: ${articles.length} articles, ${existing.length} Buffer posts checked${dryRun ? ' (dry run: Buffer not read)' : ''}`);
  for (const d of plan.days) {
    console.log(`${d.date} bluesky: ${d.bluesky.map((b) => `${b.slug}@${b.dueAt.slice(11, 16)}`).join(', ') || '-'}; linkedin: ${d.linkedin.map((c) => `${c.slug}@${c.dueAt.slice(11, 16)}`).join(' | ') || '-'}`);
  }
  for (const s of plan.skipped) console.log(`SKIP ${s.channel} ${s.slug}: ${s.reason}`);
  if (planOnly) return 0;

  const workDir = process.env.OG_WORK_DIR ? path.resolve(process.env.OG_WORK_DIR) : path.join(REPO, '.og-work');
  const runCap = Number(process.env.SOCIAL_ANTHROPIC_RUN_CAP_USD || 3);
  const r = await runDrafter({
    client: plan.days.length ? await makeClient() : null,
    model: process.env.SOCIAL_DRAFTER_MODEL || DRAFTER_MODEL,
    plan, articles, pages, buffer, dryRun, today, days,
    ledgerFile: anthropicLedgerPath(process.env, workDir),
    runCapUsd: runCap,
    maxTurns: Number(opt('--max-turns', 40)),
  });
  console.log(`\n${r.summary}\n`);
  console.log(`${dryRun ? 'planned' : 'created'} ${r.created.length} drafts, anthropic $${r.usd.toFixed(4)} this run`);
  if (r.missing.length) {
    console.log(`NOT CREATED: ${r.missing.join(', ')}`);
    return 2;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`weekly-drafter failed: ${e.message}`);
  process.exit(e.name === 'BudgetError' ? 4 : 1);
});
