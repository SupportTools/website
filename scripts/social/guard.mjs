#!/usr/bin/env node
// Social link guards for the Buffer posts that promote support.tools articles.
//
//   node scripts/social/guard.mjs preflight [--window-hours 4] [--dry-run]
//       Before a posting slot: every scheduled post due within the window whose
//       link does not return 200 right now is moved back to draft.
//   node scripts/social/guard.mjs promote [--dry-run]
//       After a rebuild: drafts tagged "approved" whose article is live are
//       scheduled (their own dueAt if still ahead, else the channel's next slot).
//   node scripts/social/guard.mjs check
//       Report problems on every scheduled post and draft; changes nothing.
//
// All three also check every link against the content files (the real page path,
// draft state, live time) and every share card. Results go to stdout, to the
// Pushgateway (job blog_social_guard, alerts in cluster-services
// monitoring/a1-ops-prd/blog-metrics-alerts.yaml) and, on problems, a desktop
// notification. Exit 0 = clean, 2 = problems found, 1 = the run failed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './lib/buffer.mjs';
import { loadPages, linkProblems } from './lib/links.mjs';
import { preflight, promote } from './lib/guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORG = process.env.BUFFER_ORG_ID || '674ab6a112a6ba07b02cc3b3';
const PUSHGATEWAY = process.env.PUSHGATEWAY_URL ?? 'http://172.28.2.22:30191';
const TOKEN_FILE = process.env.SOCIAL_VAULT_TOKEN_FILE || path.join(os.homedir(), '.config/support-tools-og/vault-token');

function apiKey() {
  if (process.env.BUFFER_API_KEY) return process.env.BUFFER_API_KEY;
  // The workstation token (policy workstation-website-og-read) can read this one key.
  const env = { ...process.env };
  if (!env.VAULT_TOKEN && fs.existsSync(TOKEN_FILE)) env.VAULT_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  env.VAULT_ADDR ||= 'https://vault.support.tools';
  return execFileSync('vault', ['kv', 'get', '-field=api_key', 'secret/infra/buffer-supporttools'], { env, encoding: 'utf8' }).trim();
}

async function pushMetrics(cmd, m) {
  if (!PUSHGATEWAY) return;
  const lines = [
    `blog_social_guard_last_run_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
    ...Object.entries(m).map(([k, v]) => `blog_social_guard_${k} ${v}`),
  ];
  try {
    await fetch(`${PUSHGATEWAY}/metrics/job/blog_social_guard/instance/${cmd}`, {
      method: 'PUT', body: `${lines.join('\n')}\n`, signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error(`pushgateway: ${e.message}`);
  }
}

function notify(summary) {
  try {
    execFileSync('notify-send', ['--urgency=critical', 'support.tools social links', summary], { stdio: 'ignore', timeout: 5000 });
  } catch { /* no desktop session */ }
}

const label = (p) => `${p.dueAt?.slice(0, 16) || 'no time'}Z ${p.channelService} ${p.id} ${p.link || '(no link)'}`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const wi = args.indexOf('--window-hours');
  const windowHours = wi >= 0 ? Number(args[wi + 1]) : 4;
  if (!['preflight', 'promote', 'check'].includes(cmd)) {
    console.error('usage: guard.mjs preflight|promote|check [--dry-run] [--window-hours N]');
    process.exit(1);
  }

  const pages = loadPages(path.join(REPO, 'blog/content'));
  const client = createClient({ apiKey: apiKey(), ...(process.env.BUFFER_URL ? { url: process.env.BUFFER_URL } : {}) });
  const now = new Date();
  let problems = 0;
  const metrics = { success: 1 };

  if (cmd === 'preflight' || cmd === 'check') {
    const scheduled = await client.posts(ORG, ['scheduled']);
    const r = await preflight(scheduled, { pages, now, windowHours: cmd === 'check' ? 0 : windowHours });
    for (const { post, problems: p } of r.problems) console.log(`PROBLEM ${label(post)}\n  ${p.join('\n  ')}`);
    for (const { post } of r.block) {
      if (dryRun || cmd === 'check') { console.log(`WOULD DRAFT ${label(post)}`); continue; }
      await client.edit(post.node, { saveToDraft: true });
      console.log(`MOVED TO DRAFT ${label(post)}`);
    }
    problems += r.problems.length;
    Object.assign(metrics, { posts_checked: r.checked, link_problems: r.problems.length, blocked_posts: r.block.length });
  }

  if (cmd === 'promote' || cmd === 'check') {
    const drafts = await client.posts(ORG, ['draft']);
    if (cmd === 'check') {
      let draftProblems = 0;
      for (const d of drafts) {
        const p = linkProblems(d, pages).filter((x) => !x.startsWith('article is not live until'));
        if (p.length) { draftProblems++; console.log(`DRAFT PROBLEM ${label(d)}\n  ${p.join('\n  ')}`); }
      }
      problems += draftProblems;
      metrics.draft_problems = draftProblems;
    } else {
      const r = await promote(drafts, { pages, now });
      for (const { post, dueAt } of r.schedule) {
        if (!dryRun) await client.edit(post.node, { mode: 'customScheduled', dueAt: dueAt.toISOString(), saveToDraft: false });
        console.log(`${dryRun ? 'WOULD SCHEDULE' : 'SCHEDULED'} ${dueAt.toISOString()} ${label(post)}`);
      }
      const real = r.skipped.filter((s) => s.reason !== 'not approved' && !s.reason.startsWith('article not live yet'));
      for (const { post, reason } of r.skipped) console.log(`SKIPPED ${label(post)}: ${reason}`);
      problems += real.length;
      Object.assign(metrics, { posts_checked: drafts.length, promoted_posts: r.schedule.length, link_problems: real.length });
    }
  }

  console.log(`${cmd}: ${problems} problem(s)`);
  await pushMetrics(cmd, metrics);
  if (problems) notify(`${cmd}: ${problems} post(s) with link problems; see ~/.cache/social-guard.log`);
  process.exit(problems ? 2 : 0);
}

main().catch(async (e) => {
  console.error(`guard failed: ${e.message}`);
  const cmd = process.argv[2] || 'unknown';
  await pushMetrics(cmd, { success: 0 });
  notify(`${cmd} failed: ${e.message}`);
  process.exit(1);
});
