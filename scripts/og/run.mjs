#!/usr/bin/env node
// Share-card pipeline: for each post, Codex or OpenAI draws an illustration, a script adds
// the title overlay, Claude reviews the card, and passing cards are uploaded to
// cdn.support.tools and linked from the post's frontmatter "images" field.
// See scripts/og/README.md.
//
// Usage:
//   node scripts/og/run.mjs [--limit N] [--slug S] [--concurrency N] [--no-upload] [--only-drawn]
//   node scripts/og/run.mjs submit-batch [--limit N] [--slug S]  # OpenAI Batch: queue art for the next cards
//   node scripts/og/run.mjs collect-batch [batch_id] [--wait MIN] # fetch finished batch art as raw.png
//   node scripts/og/run.mjs status
//   node scripts/og/run.mjs flagged            # contact sheet of cards waiting for you
//   node scripts/og/run.mjs approve <slug>     # next run uploads it as is
//   node scripts/og/run.mjs reject <slug> [note]  # next run draws a new one (note goes to Codex)
//   node scripts/og/run.mjs recompose          # re-lay out unuploaded cards after a compose.mjs change
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPosts, prioritize, excerpt, setImages, cdnKey, readPost } from './lib/posts.mjs';
import { loadManifest, saveManifest, needsWork } from './lib/manifest.mjs';
import { composeCard } from './lib/compose.mjs';
import { imagePrompt, generateImage, reviewCard, imageProvider, PROMPT_VERSION } from './lib/ai.mjs';
import { uploadCard, verifyServed } from './lib/upload.mjs';
import { submitBatch, collectBatch, pendingBatchIds } from './lib/batch.mjs';
import { ledgerPath, imageConfig, BATCH_PENDING } from './lib/openai.mjs';
import { loadLedger, spent, capUsd, monthKey } from './lib/budget.mjs';
import { anthropicLedgerPath, anthropicCapUsd } from './lib/anthropic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENT = join(ROOT, 'blog', 'content', 'post');
// Card files, batch JSONL and the spend ledgers. OG_WORK_DIR moves them (the
// in-cluster job points it at a PVC so they survive between nightly runs).
const WORK = process.env.OG_WORK_DIR ? resolve(process.env.OG_WORK_DIR) : join(ROOT, '.og-work');
const MANIFEST = join(ROOT, 'scripts', 'og', 'manifest.json');
const LEDGER = ledgerPath(process.env, WORK);
const ATTEMPTS = 2;
// A Codex usage limit fails every card in seconds; stop instead of marking the whole queue failed.
const MAX_FAILS_IN_A_ROW = Number(process.env.OG_MAX_FAILS_IN_A_ROW || 5);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const manifest = loadManifest(MANIFEST);
const save = () => saveManifest(MANIFEST, manifest);
const now = () => new Date().toISOString();
const log = (slug, msg) => console.log(`${new Date().toTimeString().slice(0, 8)} ${slug}: ${msg}`);

let uploadsDisabled = flag('--no-upload');
let uploadsStopped = false; // Vault failed mid-run, as opposed to --no-upload
let failsInARow = 0;
let halted = '';
let haltCode = 2;

async function compose(post, dir) {
  const card = join(dir, 'card.jpg');
  await composeCard({ raw: join(dir, 'raw.png'), out: card, title: post.title, categories: post.categories });
  return card;
}

async function makeCard(post, dir, note, entry) {
  const provider = imageProvider();
  const prompt = imagePrompt(post, excerpt(post.body), note, provider);
  await generateImage({ dir, prompt, workDir: WORK });
  entry.provider = provider;
  return compose(post, dir);
}

async function publish(post, card, entry) {
  const hash = createHash('sha256').update(readFileSync(card)).digest('hex').slice(0, 10);
  const url = await uploadCard({ file: card, key: cdnKey(post.slug, hash) });
  await verifyServed(url);
  writeFileSync(post.path, setImages(readFileSync(post.path, 'utf8'), url));
  Object.assign(entry, { status: 'live', url, updated: now() });
  log(post.slug, `live ${url}`);
}

async function processPost(post) {
  const entry = manifest[post.slug] || (manifest[post.slug] = { attempts: 0 });
  const dir = join(WORK, post.slug);
  mkdirSync(dir, { recursive: true });
  const card = join(dir, 'card.jpg');
  try {
    const humanApproved = entry.status === 'approved' && existsSync(card);
    if (!(entry.status === 'ready' && existsSync(card)) && !humanApproved) {
      let note = entry.status === 'rejected' ? entry.note || entry.reason : '';
      // Art a batch already drew is composed as is; a retry draws with the configured provider.
      const drawn = entry.status === 'drawn' && existsSync(join(dir, 'raw.png'));
      let verdict;
      for (let i = 0; i < ATTEMPTS; i++) {
        if (i === 0 && drawn) {
          log(post.slug, 'composing batch art');
          await compose(post, dir);
        } else {
          log(post.slug, i ? `retry: ${note}` : 'generating');
          await makeCard(post, dir, note, entry);
          entry.attempts += 1;
        }
        verdict = await reviewCard({ card, post, workDir: WORK });
        if (verdict.verdict === 'pass') break;
        note = verdict.reason;
      }
      failsInARow = 0;
      Object.assign(entry, { promptVersion: PROMPT_VERSION, reason: verdict.reason, updated: now() });
      delete entry.note;
      if (verdict.verdict !== 'pass') {
        entry.status = 'flagged';
        log(post.slug, `flagged: ${verdict.reason}`);
        return;
      }
      entry.status = 'ready';
    }
    if (uploadsDisabled) return;
    await publish(post, card, entry);
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    if (e.halt) {
      // Monthly cap reached, no API key, or the key was refused: every further card
      // would fail the same way, so stop without marking this one failed.
      if (!halted) { halted = msg; haltCode = e.name === 'BudgetError' ? 4 : 2; console.error(`stopping: ${msg}`); }
      return;
    }
    if (/Vault|OG_WASABI_/.test(msg)) {
      uploadsDisabled = uploadsStopped = true;
      console.error(`uploads stopped: ${msg}`);
      return;
    }
    Object.assign(entry, { status: 'failed', reason: msg.slice(0, 300), updated: now() });
    log(post.slug, `failed: ${msg}`);
    if (++failsInARow >= MAX_FAILS_IN_A_ROW && !halted) {
      halted = `${failsInARow} cards failed in a row, last: ${msg}`;
      console.error(`stopping: ${halted}`);
    }
  } finally {
    save();
  }
}

async function runAll() {
  const slug = opt('--slug');
  const limit = Number(opt('--limit', Infinity));
  const concurrency = Number(opt('--concurrency', 2));
  let posts = slug ? [readPost(join(CONTENT, `${slug}.md`))] : prioritize(listPosts(CONTENT));
  posts = posts.filter((p) => p && (slug || needsWork(manifest[p.slug])));
  if (flag('--only-drawn')) posts = posts.filter((p) => manifest[p.slug]?.status === 'drawn');
  posts = posts.slice(0, limit);
  console.log(`${posts.length} posts to process, concurrency ${concurrency}${uploadsDisabled ? ', uploads off' : ''}`);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < posts.length && !halted) await processPost(posts[next++]);
  }));
  status();
  if (halted) process.exitCode = haltCode;
  else if (uploadsStopped) process.exitCode = 3;
}

function status() {
  const counts = {};
  for (const e of Object.values(manifest)) counts[e.status] = (counts[e.status] || 0) + 1;
  const total = listPosts(CONTENT).length;
  console.log(`posts ${total}, no card yet ${total - Object.keys(manifest).length},`, counts);
  const ledger = loadLedger(LEDGER);
  const month = monthKey();
  if (Object.keys(ledger.months).length) {
    console.log(`openai ${month}: estimated $${spent(ledger, month).toFixed(4)} of $${capUsd().toFixed(2)} cap`
      + `, ${ledger.months[month]?.images || 0} images, ${pendingBatchIds(manifest).length} batches pending`);
  }
  const al = loadLedger(anthropicLedgerPath(process.env, WORK));
  if (al.months[month]) {
    console.log(`anthropic ${month}: $${al.months[month].usd.toFixed(4)} of $${anthropicCapUsd().toFixed(2)} cap, ${al.months[month].requests} requests`);
  }
}

// OpenAI Batch: queue art for the next cards that need it, in the same order as a
// normal run, up to --limit and the monthly cap.
async function submit() {
  const slug = opt('--slug');
  const limit = Number(opt('--limit', Infinity));
  const posts = slug ? [readPost(join(CONTENT, `${slug}.md`))] : prioritize(listPosts(CONTENT));
  const cfg = imageConfig();
  console.log(`submit-batch: ${cfg.model} ${cfg.size} ${cfg.quality}, cap $${capUsd().toFixed(2)}/month`);
  const res = await submitBatch({
    manifest, posts, workDir: WORK, ledgerFile: LEDGER, limit, save,
    promptFor: (post, entry) => imagePrompt(post, excerpt(post.body), entry?.status === 'rejected' ? entry.note || entry.reason : '', 'openai'),
  });
  if (res.capped) process.exitCode = 4;
}

// Collects one batch, or every batch with cards still waiting. --wait MIN polls
// once a minute until each is finished or MIN minutes have passed.
async function collect() {
  const ids = argv[1] && !argv[1].startsWith('--') ? [argv[1]] : pendingBatchIds(manifest);
  if (!ids.length) { console.log('collect-batch: no batches pending'); return; }
  const deadline = Date.now() + Number(opt('--wait', 0)) * 60000;
  for (const id of ids) {
    for (;;) {
      const { state } = await collectBatch({ manifest, id, workDir: WORK, ledgerFile: LEDGER, save });
      if (!BATCH_PENDING.includes(state) || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(60000, Math.max(0, deadline - Date.now()))));
    }
  }
}

function flagged() {
  const rows = Object.entries(manifest).filter(([, e]) => e.status === 'flagged');
  const html = rows.map(([s, e]) => `<figure><img src="${s}/card.jpg" width="600"><figcaption><b>${s}</b><br>${e.reason}</figcaption></figure>`);
  const out = join(WORK, 'flagged.html');
  mkdirSync(WORK, { recursive: true });
  writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>Flagged cards</title><style>body{font:14px sans-serif;background:#111;color:#ddd}figure{display:inline-block;margin:12px;width:600px;vertical-align:top}</style>${html.join('\n')}`);
  for (const [s, e] of rows) console.log(`${s}\n  ${e.reason}`);
  console.log(`${rows.length} flagged. Contact sheet: ${out}`);
}

// Rebuilds not-yet-uploaded cards from their saved raw.png after a layout
// change, without asking Codex for new art. Live cards are left alone.
async function recompose() {
  let n = 0;
  for (const [slug, e] of Object.entries(manifest)) {
    const raw = join(WORK, slug, 'raw.png');
    if (e.status === 'live' || !existsSync(raw)) continue;
    const post = readPost(join(CONTENT, `${slug}.md`));
    await composeCard({ raw, out: join(WORK, slug, 'card.jpg'), title: post.title, categories: post.categories });
    n++;
  }
  console.log(`recomposed ${n} cards`);
}

function mark(status) {
  const slug = argv[1];
  const e = manifest[slug];
  if (!e) throw new Error(`no manifest entry for ${slug}`);
  Object.assign(e, { status, updated: now() });
  if (status === 'rejected' && argv[2]) e.note = argv.slice(2).join(' ');
  save();
  console.log(`${slug}: ${status}`);
}

const cmd = argv[0];
if (cmd === 'status') status();
else if (cmd === 'flagged') flagged();
else if (cmd === 'approve') mark('approved');
else if (cmd === 'reject') mark('rejected');
else if (cmd === 'recompose') await recompose();
else if (cmd === 'submit-batch' || cmd === 'collect-batch') {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    await (cmd === 'submit-batch' ? submit() : collect());
  } catch (e) {
    console.error(`${cmd}: ${e.message}`);
    process.exitCode = e.name === 'BudgetError' ? 4 : 1;
  }
}
else await runAll();
