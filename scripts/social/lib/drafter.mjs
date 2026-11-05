// Weekly Buffer drafter: the API port of scripts/social/weekly-buffer.sh (which runs
// `claude -p` with the Buffer MCP). The deterministic half lives here in code: which
// articles fall in the week, which channel slot each one may take, which are already
// in Buffer, what the link and dueAt are. Claude only reads articles and writes the
// copy, through two tools; every draft it asks for is checked against the same rules
// (and the same link checks as scripts/social/guard.mjs) before Buffer sees it.
// Drafts only: posts are created with saveToDraft: true and nothing is edited,
// scheduled or deleted.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listPosts, excerpt } from '../../og/lib/posts.mjs';
import { parseFrontmatter, pagePathFor, liveAt, linkProblems } from './links.mjs';
import { SLOTS, chicagoTime } from './guard.mjs';
import { meteredCreate, RunBudget } from '../../og/lib/anthropic.mjs';

export const ORG_ID = '674ab6a112a6ba07b02cc3b3';
export const CHANNELS = { linkedin: '674ab74c9be8e4e2b7ec7886', bluesky: '674ab6c69be8e4e2b7e9e909' };
export const SITE = 'https://support.tools';
const TZ = 'America/Chicago';
const MIN_LEAD_MS = 10 * 60_000;
const DASHES = /[\u2013\u2014]/;

// ---- Chicago calendar helpers ----

export function chicagoParts(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(t).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, dow };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

// ISO 8601 in Chicago wall time with that instant's UTC offset.
export function chicagoIso(t) {
  const p = chicagoParts(t);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  const off = Math.round((wall - Math.floor(t.getTime() / 60000) * 60000) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${ymd(p)}T${pad(p.hh)}:${pad(p.mm)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Next Monday (tomorrow when run on Sunday) through the Sunday after it, as
// weekly-buffer.sh computed it, or the week starting at `start` (YYYY-MM-DD).
export function weekDays(now, start) {
  let y; let m; let d;
  if (start) {
    [y, m, d] = start.split('-').map(Number);
  } else {
    const p = chicagoParts(now);
    const ahead = ((8 - p.dow) % 7) || 7;
    ({ y, m, d } = p);
    d += ahead;
  }
  return Array.from({ length: 7 }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), date: t.toISOString().slice(0, 10) };
  });
}

// ---- Articles and plan ----

export function pathOf(link) {
  try {
    const p = new URL(link).pathname;
    return p.endsWith('/') ? p : `${p}/`;
  } catch { return ''; }
}

// Posts publishing on one of `days` (Chicago dates), with page path and live card.
export function weekArticles(repo, days, manifest = {}) {
  const want = new Set(days.map((d) => d.date));
  const dir = join(repo, 'blog', 'content', 'post');
  const out = [];
  for (const post of listPosts(dir)) {
    const when = new Date(post.date);
    if (Number.isNaN(when.getTime())) continue;
    const day = ymd(chicagoParts(when));
    if (!want.has(day)) continue;
    const fm = parseFrontmatter(readFileSync(post.path, 'utf8')) || {};
    const path = pagePathFor(`post/${post.slug}.md`, fm);
    const live = manifest[post.slug]?.status === 'live' ? manifest[post.slug].url : '';
    out.push({
      slug: post.slug, title: post.title, description: post.description, date: when, day, path,
      card: live || '', publish: `${pad(chicagoParts(when).hh)}:${pad(chicagoParts(when).mm)}`, body: post.body,
    });
  }
  return out.sort((a, b) => a.date - b.date || a.slug.localeCompare(b.slug));
}

export function loadManifest(repo) {
  const p = join(repo, 'scripts', 'og', 'manifest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

function slotsOn(channel, day) {
  return SLOTS[channel].map((s) => {
    const [hh, mm] = s.split(':').map(Number);
    return chicagoTime(day.y, day.m, day.d, hh, mm);
  });
}

// What may be drafted. existing: normalized Buffer posts (drafts and scheduled).
// Rules (owner-approved, see weekly-buffer-prompt.md):
//   Bluesky: every article, up to one per slot; each takes the first slot on its day
//     that is after the article goes live (liveAt: next rebuild + deploy), so a
//     09:00 article gets the afternoon slot and a second article only takes the
//     other slot when that slot is after it goes live.
//   LinkedIn: at most one post per day; Claude picks among the day's candidates,
//     each at its first slot after it goes live.
//   An article whose page already appears in a post on that channel is skipped, and
//   a day that already has a LinkedIn post is skipped for LinkedIn.
export function planWeek({ articles, days, existing = [], now }) {
  const earliest = now.getTime() + MIN_LEAD_MS;
  const covered = (ch, path) => existing.some((p) => p.channelService === ch && pathOf(p.link) === path);
  const plan = { days: [], skipped: [] };
  for (const day of days) {
    const arts = articles.filter((a) => a.day === day.date);
    const entry = { date: day.date, bluesky: [], linkedin: [] };
    const used = new Set();
    for (const a of arts) {
      if (covered('bluesky', a.path)) { plan.skipped.push({ slug: a.slug, channel: 'bluesky', reason: 'already in Buffer' }); continue; }
      const live = liveAt(a.date)?.getTime() ?? a.date.getTime();
      const slot = slotsOn('bluesky', day).find((t) => !used.has(t.getTime()) && t.getTime() >= live && t.getTime() >= earliest);
      if (!slot) { plan.skipped.push({ slug: a.slug, channel: 'bluesky', reason: 'no free Bluesky slot after it goes live' }); continue; }
      used.add(slot.getTime());
      entry.bluesky.push({ slug: a.slug, dueAt: chicagoIso(slot) });
    }
    const liToday = existing.some((p) => p.channelService === 'linkedin' && p.dueAt && ymd(chicagoParts(new Date(p.dueAt))) === day.date);
    for (const a of arts) {
      if (liToday) { plan.skipped.push({ slug: a.slug, channel: 'linkedin', reason: 'LinkedIn already has a post that day' }); continue; }
      if (covered('linkedin', a.path)) { plan.skipped.push({ slug: a.slug, channel: 'linkedin', reason: 'already in Buffer' }); continue; }
      const live = liveAt(a.date)?.getTime() ?? a.date.getTime();
      const slot = slotsOn('linkedin', day).find((t) => t.getTime() >= live && t.getTime() >= earliest);
      if (!slot) { plan.skipped.push({ slug: a.slug, channel: 'linkedin', reason: 'no LinkedIn slot after it goes live' }); continue; }
      entry.linkedin.push({ slug: a.slug, dueAt: chicagoIso(slot) });
    }
    if (entry.bluesky.length || entry.linkedin.length) plan.days.push(entry);
  }
  return plan;
}

export function linkFor(article, channel) {
  return `${SITE}${article.path}?utm_source=${channel}&utm_medium=social`;
}

const graphemes = (s) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;

// Problems with Claude's copy for a channel; empty when it may be drafted.
export function copyProblems(channel, text) {
  const p = [];
  const t = String(text || '').trim();
  if (!t) return ['text is empty'];
  if (DASHES.test(t)) p.push('contains an em or en dash; rewrite with commas, colons, periods or parentheses');
  if (/https?:\/\//i.test(t)) p.push('contains a URL; the link is attached by the tool, leave it out of the text');
  if (channel === 'bluesky' && graphemes(t) >= 300) p.push(`is ${graphemes(t)} characters; Bluesky copy must be under 300`);
  if (channel === 'linkedin') {
    const tags = (t.match(/(^|\s)#[A-Za-z][\w]*/g) || []).length;
    if (tags < 3 || tags > 5) p.push(`has ${tags} hashtags; use 3 to 5`);
    if (t.length > 2800) p.push(`is ${t.length} characters; keep LinkedIn copy under 2800`);
  }
  return p;
}

// The CreatePostInput for one draft.
export function draftInput({ channel, article, text, dueAt }) {
  const link = linkFor(article, channel);
  const input = {
    channelId: CHANNELS[channel], schedulingType: 'automatic', mode: 'customScheduled',
    dueAt, saveToDraft: true, text: text.trim(),
  };
  if (channel === 'linkedin') {
    input.metadata = { linkedin: { firstComment: link } };
    input.assets = article.card ? [{ image: { url: article.card, metadata: { altText: article.title } } }] : [];
  } else {
    const att = { url: link, title: article.title };
    if (article.description) att.description = article.description;
    if (article.card) att.thumbnail = { url: article.card };
    input.metadata = { bluesky: { linkAttachment: att } };
  }
  return input;
}

// ---- Tools ----

export const TOOLS = [
  {
    name: 'read_article',
    description: 'Returns one planned article: title, description, publish time, URL and the opening of its body (code blocks removed). Read an article before writing copy for it.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['slug'],
      properties: { slug: { type: 'string', description: 'Article slug from the plan.' } },
    },
  },
  {
    name: 'create_draft',
    description: 'Creates one Buffer draft for a planned article on one channel. The tool sets the link, schedule time, card and draft state; you supply only the post text. Returns ok with the draft, or the problems to fix and retry.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['channel', 'slug', 'text'],
      properties: {
        channel: { type: 'string', enum: ['linkedin', 'bluesky'] },
        slug: { type: 'string', description: 'Article slug from the plan.' },
        text: { type: 'string', description: 'The post text only, without the link.' },
      },
    },
  },
];

export const SYSTEM = [
  'You write social posts that promote articles on the support.tools technical blog, for the owner to review in Buffer.',
  'Rules approved by the owner:',
  '- LinkedIn: native text with a concrete hook in the first line, a few short paragraphs of real substance from the article, then 3 to 5 hashtags. The link goes in the first comment, which the tool adds; never put a URL in the text.',
  '- Bluesky: one punchy line under 300 characters. The tool attaches the link card; never put a URL in the text.',
  '- When a day offers more than one LinkedIn candidate, draft exactly one: the stronger article (prefer war stories, incidents and opinion pieces over generic guides).',
  '- No em dashes or en dashes anywhere. No emoji walls, no "In today\'s fast-paced world" openers, no invented facts: use only what the article says.',
  'Read each article with read_article before writing for it. Create drafts only with create_draft; if it reports problems, fix the text and call it again.',
  'When every planned draft exists, end with a short plain-text summary: per day, which article went to which channel, which you skipped and why, and any errors.',
].join('\n');

export function planMessage({ today, days, plan, articles }) {
  const bySlug = Object.fromEntries(articles.map((a) => [a.slug, a]));
  const lines = [`Today is ${today}. Target week: ${days[0].date} (Monday) through ${days[6].date} (Sunday).`, ''];
  if (!plan.days.length) {
    lines.push('There is nothing to draft this week. Say so and create nothing.');
    return lines.join('\n');
  }
  lines.push('Plan (times are already chosen; you write the copy):');
  for (const d of plan.days) {
    lines.push(`\n${d.date}:`);
    for (const b of d.bluesky) lines.push(`  Bluesky draft required: ${b.slug} ("${bySlug[b.slug].title}", publishes ${bySlug[b.slug].publish}) at ${b.dueAt}`);
    if (d.linkedin.length === 1) lines.push(`  LinkedIn draft required: ${d.linkedin[0].slug} at ${d.linkedin[0].dueAt}`);
    else if (d.linkedin.length > 1) lines.push(`  LinkedIn: pick ONE of ${d.linkedin.map((c) => `${c.slug} ("${bySlug[c.slug].title}") at ${c.dueAt}`).join('; ')}`);
  }
  if (plan.skipped.length) {
    lines.push('', 'Already skipped by the planner (do not draft these):');
    for (const s of plan.skipped) lines.push(`  ${s.slug} on ${s.channel}: ${s.reason}`);
  }
  return lines.join('\n');
}

// Tool execution state for one run.
export function makeTools({ plan, articles, pages, buffer, dryRun, log = console.log }) {
  const bySlug = Object.fromEntries(articles.map((a) => [a.slug, a]));
  const created = [];
  const blueskyDone = new Set();
  const linkedinDays = new Set();
  const inPlan = (slug) => plan.days.some((d) => d.bluesky.some((b) => b.slug === slug) || d.linkedin.some((c) => c.slug === slug));

  async function run(name, input) {
    if (name === 'read_article') {
      const a = bySlug[input.slug];
      if (!a || !inPlan(input.slug)) return { error: `no planned article ${input.slug}` };
      return {
        slug: a.slug, title: a.title, description: a.description, publishes: `${a.day} ${a.publish} America/Chicago`,
        url: `${SITE}${a.path}`, has_share_card: Boolean(a.card), body: excerpt(a.body, 6000),
      };
    }
    if (name !== 'create_draft') return { error: `unknown tool ${name}` };
    const { channel, slug, text } = input;
    const a = bySlug[slug];
    let dueAt;
    if (channel === 'bluesky') {
      const b = plan.days.flatMap((d) => d.bluesky).find((x) => x.slug === slug);
      if (!b) return { error: `${slug} is not planned for Bluesky` };
      if (blueskyDone.has(slug)) return { error: `the Bluesky draft for ${slug} already exists` };
      dueAt = b.dueAt;
    } else if (channel === 'linkedin') {
      const day = plan.days.find((d) => d.linkedin.some((c) => c.slug === slug));
      if (!day) return { error: `${slug} is not a LinkedIn candidate` };
      if (linkedinDays.has(day.date)) return { error: `${day.date} already has its one LinkedIn draft` };
      dueAt = day.linkedin.find((c) => c.slug === slug).dueAt;
    } else {
      return { error: `unknown channel ${channel}` };
    }
    const problems = copyProblems(channel, text);
    const link = linkFor(a, channel);
    // The same link rules guard.mjs enforces later, checked before Buffer sees it.
    problems.push(...linkProblems({ channelService: channel, dueAt: new Date(dueAt).toISOString(), link }, pages));
    if (problems.length) return { error: 'not created', problems };
    const draft = draftInput({ channel, article: a, text, dueAt });
    let id = '(dry run)';
    if (dryRun) {
      log(`DRY RUN ${channel} ${dueAt} ${slug}\n  link: ${link}\n  card: ${a.card || '(none)'}\n  ${draft.text.replace(/\n/g, '\n  ')}`);
    } else {
      const post = await buffer.create(draft);
      id = post.id;
      if (post.status !== 'draft') {
        // Buffer did not save it as a draft (saveToDraft ignored or read differently),
        // so it may publish on its own. Stop the whole run; this is not something the
        // model can retry its way around.
        const e = new Error(`Buffer created ${channel} post ${id} for ${slug} with status ${post.status}, not draft; `
          + 'stopping. Delete or re-draft that post in Buffer by hand.');
        e.halt = true;
        throw e;
      }
      log(`DRAFTED ${channel} ${dueAt} ${slug} ${id}`);
    }
    if (channel === 'bluesky') blueskyDone.add(slug);
    else linkedinDays.add(plan.days.find((d) => d.linkedin.some((c) => c.slug === slug)).date);
    created.push({ channel, slug, dueAt, id, input: draft });
    return { ok: true, channel, slug, dueAt, id };
  }

  // Planned drafts that were not created.
  function missing() {
    const out = [];
    for (const d of plan.days) {
      for (const b of d.bluesky) if (!blueskyDone.has(b.slug)) out.push(`bluesky ${b.slug}`);
      if (d.linkedin.length && !linkedinDays.has(d.date)) out.push(`linkedin ${d.date}`);
    }
    return out;
  }
  return { run, created, missing };
}

// The agent loop: Claude reads and drafts through the tools until it ends its turn.
export async function runDrafter({
  client, model, plan, articles, pages, buffer, dryRun, ledgerFile, runCapUsd, today, days,
  maxTurns = 40, log = console.log,
}) {
  const tools = makeTools({ plan, articles, pages, buffer, dryRun, log });
  if (!plan.days.length) return { summary: 'nothing to draft this week', created: [], missing: [], usd: 0 };
  const budget = new RunBudget(runCapUsd);
  const messages = [{ role: 'user', content: planMessage({ today, days, plan, articles }) }];
  let summary = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    const params = {
      model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      // Server-side refusal fallback (routes by refusal category); the ledger prices
      // a fallback turn at the dearer model's rates.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    const { message } = await meteredCreate({ ledgerFile, params, send: (p) => client.beta.messages.create(p), runBudget: budget });
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'tool_use') {
      const results = [];
      for (const b of message.content.filter((x) => x.type === 'tool_use')) {
        let out;
        try {
          out = await tools.run(b.name, b.input || {});
        } catch (e) {
          if (e.halt) throw e;
          out = { error: e.message };
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (message.stop_reason === 'pause_turn') continue;
    if (message.stop_reason === 'refusal') throw new Error('Claude declined the request (stop_reason refusal)');
    if (message.stop_reason === 'max_tokens') throw new Error('response hit max_tokens');
    summary = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    break;
  }
  return { summary, created: tools.created, missing: tools.missing(), usd: budget.spent };
}
