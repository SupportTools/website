// Decisions for the two social link guards:
//   preflight: before each posting slot, pull back to draft any scheduled post that
//              is due soon and whose link does not return 200 right now.
//   promote:   after each rebuild, schedule approved drafts whose article is live.
// Both also report link problems found from the content files (links.mjs).
import { linkProblems } from './links.mjs';

export const APPROVED_TAG = 'approved';
const MAX_REDIRECTS = 3;
const MIN_LEAD_MS = 10 * 60_000;

// Posting slots per channel, America/Chicago wall time (owner-approved).
export const SLOTS = { linkedin: ['08:45', '17:33'], bluesky: ['08:53', '16:26'] };
const TZ = 'America/Chicago';

// Requests url, following up to MAX_REDIRECTS redirects. status 0 means the
// request failed or looped.
export async function checkLink(url, fetchFn = globalThis.fetch, method = 'GET') {
  const seen = new Set();
  let current = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    if (seen.has(current)) return { status: 0, redirects: hops, finalUrl: current };
    seen.add(current);
    let res;
    try {
      res = await fetchFn(current, { method, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    } catch {
      return { status: 0, redirects: hops, finalUrl: current };
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return { status: res.status, redirects: hops, finalUrl: current };
  }
  return { status: 0, redirects: MAX_REDIRECTS, finalUrl: current };
}

// The UTC instant of a Chicago wall-clock time on the given Chicago calendar day.
function chicagoTime(y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    guess -= shown - Date.UTC(y, m - 1, d, hh, mm);
  }
  return new Date(guess);
}

function chicagoDate(t) {
  const [m, d, y] = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(t).split('/').map(Number);
  return { y, m, d };
}

// The channel's next posting slot at least MIN_LEAD_MS after `after`.
export function nextSlot(channel, after) {
  const earliest = after.getTime() + MIN_LEAD_MS;
  const { y, m, d } = chicagoDate(after);
  for (let day = 0; day < 3; day++) {
    const base = new Date(Date.UTC(y, m - 1, d + day));
    for (const s of SLOTS[channel]) {
      const [hh, mm] = s.split(':').map(Number);
      const t = chicagoTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm);
      if (t.getTime() >= earliest) return t;
    }
  }
  throw new Error(`no slot for ${channel}`);
}

// posts: normalized scheduled posts. Returns { checked, block: [{post, problems}],
// problems: [{post, problems}] } where block is the subset to pull back to draft.
export async function preflight(posts, { pages, now, windowHours = 4, fetch: fetchFn = globalThis.fetch }) {
  const block = [];
  const problems = [];
  const horizon = now.getTime() + windowHours * 3_600_000;
  for (const post of posts) {
    const found = linkProblems(post, pages);
    if (post.card) {
      const c = await checkLink(post.card, fetchFn, 'HEAD');
      if (c.status !== 200) found.push(`card ${post.card} returns ${c.status || 'no response'}`);
    }
    const due = new Date(post.dueAt).getTime();
    let blocked = false;
    if (post.link && due <= horizon && due > now.getTime() - 5 * 60_000) {
      const live = await checkLink(post.link, fetchFn);
      if (live.status !== 200) {
        found.push(`link returns HTTP ${live.status || 'no response'} ${Math.round((due - now.getTime()) / 60_000)} min before it posts`);
        blocked = true;
      } else if (live.redirects > 0) {
        found.push(`link redirects to ${live.finalUrl}; link the final URL instead`);
      }
    }
    if (found.length) problems.push({ post, problems: found });
    if (blocked) block.push({ post, problems: found });
  }
  return { checked: posts.length, block, problems };
}

// drafts: normalized draft posts. Returns { schedule: [{post, dueAt}], skipped: [{post, reason}] }.
export async function promote(drafts, { pages, now, fetch: fetchFn = globalThis.fetch }) {
  const schedule = [];
  const skipped = [];
  for (const post of drafts) {
    if (!post.tags.includes(APPROVED_TAG)) { skipped.push({ post, reason: 'not approved' }); continue; }
    const wanted = post.dueAt ? new Date(post.dueAt) : null;
    const dueAt = wanted && wanted.getTime() >= now.getTime() + MIN_LEAD_MS ? wanted : nextSlot(post.channelService, now);
    // The live check below proves the article is up, so the date-based estimate is not needed.
    const found = linkProblems({ ...post, dueAt: dueAt.toISOString() }, pages).filter((p) => !p.startsWith('article is not live until'));
    if (found.length) { skipped.push({ post, reason: found.join('; ') }); continue; }
    const live = await checkLink(post.link, fetchFn);
    if (live.status !== 200) { skipped.push({ post, reason: `article not live yet (HTTP ${live.status || 'no response'})` }); continue; }
    if (live.redirects > 0) { skipped.push({ post, reason: `link redirects to ${live.finalUrl}` }); continue; }
    schedule.push({ post, dueAt });
  }
  return { schedule, skipped };
}
