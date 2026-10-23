#!/usr/bin/env node
// Tell IndexNow engines (Bing, Yandex, Seznam, Naver and the rest; they share
// submissions with each other) which pages changed in the build that was just
// deployed.
//
//   node scripts/indexnow.mjs [--public blog/public] [--since 26h|<ISO date>]
//                             [--url <url>]... [--include-tags] [--dry-run]
//
// Without --url, the URLs come from <public>/sitemap.xml: every <loc> whose
// <lastmod> is newer than --since (default 26h ago, so each scheduled build
// covers the posts that went live since the previous day's build, with slack
// for a late or skipped run). With --url, only the given URLs are sent.
// /tags/ pages are left out by default: every new post bumps the lastmod of
// all its tag pages, and those listings are thin. Pass --include-tags to keep
// them.
//
// The key and host live in scripts/indexnow.json; the key file is
// blog/static/<key>.txt, served at https://support.tools/<key>.txt. IndexNow
// keys are public by design.
//
// This is a runtime notification after a deploy, not a build step. It never
// exits non-zero for a network, HTTP or sitemap problem: it logs a warning and
// exits 0. Only an invalid command line exits 2.
//
// Environment (mainly for tests):
//   INDEXNOW_ENDPOINT        default https://api.indexnow.org/indexnow
//   INDEXNOW_TIMEOUT_MS      per-request timeout, default 15000
//   INDEXNOW_RETRY_DELAY_MS  base backoff between retries, default 2000
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'scripts/indexnow.json');
export const DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const MAX_BATCH = 10000;
export const RETRIES = 2;
export const DEFAULT_SINCE = '26h';
export const DEFAULT_EXCLUDES = ['/tags/'];

export function loadConfig(file = CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[A-Za-z0-9-]{8,128}$/.test(cfg.key || '')) throw new Error(`invalid IndexNow key in ${file}`);
  if (!cfg.host) throw new Error(`missing host in ${file}`);
  return { keyLocation: `https://${cfg.host}/${cfg.key}.txt`, ...cfg };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
}

// [{ loc, lastmod }] from a <urlset> sitemap, or { index: [loc] } for a
// <sitemapindex>. lastmod is a Date, or null when absent or unparseable.
export function parseSitemap(xml) {
  if (/<sitemapindex[\s>]/.test(xml)) {
    const index = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)]
      .map((m) => m[1].match(/<loc>([\s\S]*?)<\/loc>/))
      .filter(Boolean)
      .map((m) => unescapeXml(m[1]));
    return { index };
  }
  const entries = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([\s\S]*?)<\/loc>/);
    if (!loc) continue;
    const lm = m[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/);
    const d = lm ? new Date(lm[1].trim()) : null;
    entries.push({ loc: unescapeXml(loc[1]), lastmod: d && !Number.isNaN(d.getTime()) ? d : null });
  }
  return entries;
}

// Reads <publicDir>/sitemap.xml, following a sitemap index to the local files
// it names (mapped onto publicDir by URL path; nothing is fetched).
export function readSitemap(publicDir, file = 'sitemap.xml') {
  const parsed = parseSitemap(fs.readFileSync(path.join(publicDir, file), 'utf8'));
  if (!parsed.index) return parsed;
  return parsed.index.flatMap((loc) => readSitemap(publicDir, decodeURIComponent(new URL(loc).pathname)));
}

// "26h", "90m", "2d", or anything Date can parse. Returns a Date or null.
export function parseSince(value, now = new Date()) {
  const rel = String(value).match(/^(\d+(?:\.\d+)?)([mhd])$/);
  if (rel) {
    const ms = { m: 60e3, h: 3600e3, d: 86400e3 }[rel[2]];
    return new Date(now.getTime() - Number(rel[1]) * ms);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Sitemap entries changed after `since`, on `host`, outside `excludes`
// (path prefixes), deduplicated, in sitemap order. Entries with no lastmod
// are skipped: there is no way to tell whether they changed.
export function selectUrls(entries, { since, host, excludes = DEFAULT_EXCLUDES }) {
  const out = new Set();
  for (const { loc, lastmod } of entries) {
    if (!lastmod || lastmod <= since) continue;
    if (!onHost(loc, host)) continue;
    const p = new URL(loc).pathname;
    if (excludes.some((x) => p.startsWith(x))) continue;
    out.add(loc);
  }
  return [...out];
}

export function onHost(u, host) {
  try {
    return new URL(u).host === host;
  } catch {
    return false;
  }
}

export function batches(list, size = MAX_BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function payload(cfg, urlList) {
  return { host: cfg.host, key: cfg.key, keyLocation: cfg.keyLocation, urlList };
}

const MEANING = {
  200: 'OK, URLs received',
  202: 'accepted, key validation pending',
  400: 'bad request (invalid format)',
  403: 'forbidden (key not found at keyLocation, or file does not contain the key)',
  422: 'unprocessable (URLs not on host, or key does not match)',
  429: 'too many requests (treated as spam, back off)',
};
// Worth another try: timeouts, network errors, 429 and 5xx. Other 4xx will
// fail the same way again.
const retryable = (status) => status === 0 || status === 429 || status >= 500;

// POSTs one batch with a per-attempt timeout and RETRIES retries. Never
// throws; returns { ok, status, attempts }.
export async function submit(body, {
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 15000,
  retryDelayMs = 2000,
  log = console.log,
} = {}) {
  let status = 0;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    let detail = '';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      const text = (await res.text().catch(() => '')).trim().slice(0, 300);
      detail = `${MEANING[status] || res.statusText || ''}${text ? `: ${text}` : ''}`;
    } catch (err) {
      status = 0;
      detail = err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : `${err.name}: ${err.message}`;
    }
    const ok = status === 200 || status === 202;
    log(`indexnow: attempt ${attempt}: HTTP ${status || 'none'} ${detail}`.trimEnd());
    if (ok) return { ok, status, attempts: attempt };
    if (!retryable(status) || attempt > RETRIES) return { ok: false, status, attempts: attempt };
    await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
  }
  return { ok: false, status, attempts: RETRIES + 1 };
}

export function parseArgs(argv) {
  const opts = { publicDir: path.join(ROOT, 'blog/public'), since: DEFAULT_SINCE, urls: [], includeTags: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--public') opts.publicDir = path.resolve(val());
    else if (a === '--since') opts.since = val();
    else if (a === '--url') opts.urls.push(val());
    else if (a === '--include-tags') opts.includeTags = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

const warn = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning title=IndexNow::${msg}` : `indexnow: WARNING ${msg}`);

// Returns the process exit code.
export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`indexnow: ${err.message}`);
    return 2;
  }
  if (opts.help) {
    console.log('usage: node scripts/indexnow.mjs [--public dir] [--since 26h|ISO] [--url u]... [--include-tags] [--dry-run]');
    return 0;
  }
  const since = parseSince(opts.since);
  if (!since) {
    console.error(`indexnow: cannot parse --since ${opts.since}`);
    return 2;
  }

  try {
    const cfg = loadConfig(env.INDEXNOW_CONFIG || CONFIG_PATH);
    const keyFile = path.join(opts.publicDir, `${cfg.key}.txt`);
    if (!fs.existsSync(keyFile) || fs.readFileSync(keyFile, 'utf8').trim() !== cfg.key) {
      warn(`key file ${cfg.key}.txt is missing from ${opts.publicDir} or does not contain the key; engines would reject the submission (403). Not sending.`);
      return 0;
    }

    let urls;
    if (opts.urls.length) {
      urls = [...new Set(opts.urls)];
      const off = urls.filter((u) => !onHost(u, cfg.host));
      if (off.length) warn(`dropping ${off.length} URL(s) not on ${cfg.host}: ${off.join(' ')}`);
      urls = urls.filter((u) => onHost(u, cfg.host));
    } else {
      const entries = readSitemap(opts.publicDir);
      urls = selectUrls(entries, { since, host: cfg.host, excludes: opts.includeTags ? [] : DEFAULT_EXCLUDES });
      console.log(`indexnow: ${entries.length} sitemap entries, ${urls.length} changed since ${since.toISOString()}`);
    }
    if (!urls.length) {
      console.log('indexnow: nothing to submit');
      return 0;
    }

    const endpoint = env.INDEXNOW_ENDPOINT || DEFAULT_ENDPOINT;
    const all = batches(urls);
    let failed = 0;
    for (const [i, list] of all.entries()) {
      const body = payload(cfg, list);
      console.log(`indexnow: batch ${i + 1}/${all.length}: ${list.length} URL(s) to ${endpoint}${opts.dryRun ? ' (dry run, not sent)' : ''}`);
      if (opts.dryRun) {
        console.log(JSON.stringify(body, null, 2));
        continue;
      }
      for (const u of list) console.log(`  ${u}`);
      const r = await submit(body, {
        endpoint,
        timeoutMs: Number(env.INDEXNOW_TIMEOUT_MS) || 15000,
        retryDelayMs: env.INDEXNOW_RETRY_DELAY_MS !== undefined ? Number(env.INDEXNOW_RETRY_DELAY_MS) : 2000,
      });
      if (!r.ok) {
        failed++;
        warn(`batch ${i + 1} not accepted (HTTP ${r.status || 'none'} after ${r.attempts} attempt(s)); the pages will still be found by normal crawling`);
      }
    }
    if (!opts.dryRun) console.log(`indexnow: ${all.length - failed}/${all.length} batch(es) accepted`);
  } catch (err) {
    warn(`skipped: ${err.message}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
