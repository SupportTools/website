// Weekly Buffer drafter (scripts/social/weekly-drafter.mjs): week window, slot plan,
// copy rules, and the tool-use loop against a mocked Anthropic API and a mocked
// Buffer GraphQL API. Nothing here touches the network.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  weekDays, chicagoIso, weekArticles, planWeek, copyProblems, draftInput, runDrafter, CHANNELS, linkFor,
} from '../../scripts/social/lib/drafter.mjs';
import { loadPages } from '../../scripts/social/lib/links.mjs';
import { createClient } from '../../scripts/social/lib/buffer.mjs';
import { makeClient } from '../../scripts/og/lib/anthropic.mjs';
import { loadLedger, monthKey } from '../../scripts/og/lib/budget.mjs';
import { failClosedFetch, saveEnv, routeFetch, message, json, isMessagesApi } from './helpers.mjs';

const ENV = ['ANTHROPIC_API_KEY', 'OG_ANTHROPIC_LEDGER', 'OG_ANTHROPIC_MONTHLY_CAP_USD', 'OG_ANTHROPIC_MAX_RETRIES',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
const NOW = new Date('2026-11-08T18:00:00-06:00'); // a Sunday evening, as the old cron ran
const CARD = 'https://cdn.support.tools/posts/a-incident/og-1.jpg';
let restore;
let realFetch;
let repo;

function post(slug, date, extra = '') {
  writeFileSync(join(repo, 'blog/content/post', `${slug}.md`),
    `---\ntitle: "Title ${slug}"\ndescription: "About ${slug}"\ndate: ${date}\ncategories:\n- Kubernetes\n${extra}---\n\nThe ${slug} body says etcd needs fast disks.\n`);
}

beforeEach(() => {
  restore = saveEnv(ENV);
  realFetch = globalThis.fetch;
  failClosedFetch();
  repo = mkdtempSync(join(tmpdir(), 'drafter-'));
  mkdirSync(join(repo, 'blog/content/post'), { recursive: true });
  mkdirSync(join(repo, 'scripts/og'), { recursive: true });
  post('a-incident', '2026-11-09T09:00:00-06:00');
  post('b-guide', '2026-11-09T09:00:00-06:00');
  post('c-mid', '2026-11-10T00:00:00-06:00');
  post('d-mid', '2026-11-10T00:00:00-06:00');
  post('e-held', '2026-11-11T09:00:00-06:00', 'draft: true\n');
  post('f-custom', '2026-11-12T09:00:00-06:00', 'url: "/custom-path/"\n');
  post('g-next-week', '2026-11-16T09:00:00-06:00');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.OG_ANTHROPIC_MAX_RETRIES = '0';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restore();
  rmSync(repo, { recursive: true, force: true });
});

const manifest = { 'a-incident': { status: 'live', url: CARD }, 'c-mid': { status: 'ready' } };
const days = () => weekDays(NOW);
const articles = () => weekArticles(repo, days(), manifest);

test('the target week is next Monday through Sunday in Chicago', () => {
  assert.deepEqual(days().map((d) => d.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  // On a Monday the next Monday is a week away, like `date -d "next monday"`.
  assert.equal(weekDays(new Date('2026-11-09T12:00:00-06:00'))[0].date, '2026-11-16');
  assert.equal(weekDays(NOW, '2026-12-07')[6].date, '2026-12-13');
});

test('chicagoIso uses the offset in force on that date', () => {
  assert.equal(chicagoIso(new Date('2026-10-31T13:45:00Z')), '2026-10-31T08:45:00-05:00');
  assert.equal(chicagoIso(new Date('2026-11-02T14:45:00Z')), '2026-11-02T08:45:00-06:00');
});

test('articles: the week only, drafts excluded, real page path and live card', () => {
  const a = articles();
  assert.deepEqual(a.map((x) => x.slug), ['a-incident', 'b-guide', 'c-mid', 'd-mid', 'f-custom']);
  const bySlug = Object.fromEntries(a.map((x) => [x.slug, x]));
  assert.equal(bySlug['a-incident'].path, '/post/a-incident/');
  assert.equal(bySlug['f-custom'].path, '/custom-path/');
  assert.equal(bySlug['a-incident'].card, CARD);
  assert.equal(bySlug['c-mid'].card, ''); // ready is not live
  assert.equal(bySlug['a-incident'].publish, '09:00');
});

test('plan: 09:00 articles get the afternoon slot, a second one only a slot after it goes live', () => {
  const plan = planWeek({ articles: articles(), days: days(), now: NOW });
  const mon = plan.days.find((d) => d.date === '2026-11-09');
  assert.deepEqual(mon.bluesky, [{ slug: 'a-incident', dueAt: '2026-11-09T16:26:00-06:00' }]);
  assert.deepEqual(mon.linkedin, [
    { slug: 'a-incident', dueAt: '2026-11-09T17:33:00-06:00' },
    { slug: 'b-guide', dueAt: '2026-11-09T17:33:00-06:00' },
  ]);
  assert.ok(plan.skipped.some((s) => s.slug === 'b-guide' && s.channel === 'bluesky' && /no free Bluesky slot/.test(s.reason)));
  const tue = plan.days.find((d) => d.date === '2026-11-10');
  assert.deepEqual(tue.bluesky, [
    { slug: 'c-mid', dueAt: '2026-11-10T08:53:00-06:00' },
    { slug: 'd-mid', dueAt: '2026-11-10T16:26:00-06:00' },
  ]);
  assert.deepEqual(tue.linkedin.map((c) => c.dueAt), ['2026-11-10T08:45:00-06:00', '2026-11-10T08:45:00-06:00']);
});

test('plan: posts already in Buffer are skipped per channel, and a LinkedIn day with a post is skipped', () => {
  const existing = [
    { channelService: 'bluesky', link: 'https://support.tools/post/c-mid/?utm_source=bluesky&utm_medium=social', dueAt: '2026-11-10T14:53:00Z' },
    { channelService: 'linkedin', link: 'https://support.tools/post/zzz/?utm_source=linkedin', dueAt: '2026-11-09T23:33:00Z' },
  ];
  const plan = planWeek({ articles: articles(), days: days(), existing, now: NOW });
  const tue = plan.days.find((d) => d.date === '2026-11-10');
  assert.deepEqual(tue.bluesky, [{ slug: 'd-mid', dueAt: '2026-11-10T08:53:00-06:00' }]);
  assert.equal(plan.days.find((d) => d.date === '2026-11-09').linkedin.length, 0);
  assert.ok(plan.skipped.some((s) => s.slug === 'c-mid' && s.reason === 'already in Buffer'));
});

test('plan: nothing is planned in the past', () => {
  const late = new Date('2026-11-09T17:00:00-06:00');
  const plan = planWeek({ articles: articles(), days: weekDays(late, '2026-11-09'), now: late });
  const mon = plan.days.find((d) => d.date === '2026-11-09');
  assert.deepEqual(mon.linkedin.map((c) => c.dueAt), ['2026-11-09T17:33:00-06:00', '2026-11-09T17:33:00-06:00']);
  assert.equal(mon.bluesky.length, 0);
});

test('copy rules: dashes, URLs, Bluesky length, LinkedIn hashtags', () => {
  assert.deepEqual(copyProblems('bluesky', 'etcd wants fast disks.'), []);
  assert.match(copyProblems('bluesky', 'etcd \u2014 fast disks')[0], /em or en dash/);
  assert.match(copyProblems('bluesky', 'see https://support.tools/x')[0], /URL/);
  assert.match(copyProblems('bluesky', 'x'.repeat(300))[0], /under 300/);
  assert.deepEqual(copyProblems('linkedin', 'Hook.\n\nBody.\n\n#Kubernetes #etcd #SRE'), []);
  assert.match(copyProblems('linkedin', 'Hook. #one #two')[0], /3 to 5/);
  assert.deepEqual(copyProblems('linkedin', ''), ['text is empty']);
});

test('draft inputs: LinkedIn link in the first comment with the card, Bluesky link card with thumbnail', () => {
  const a = articles().find((x) => x.slug === 'a-incident');
  const li = draftInput({ channel: 'linkedin', article: a, text: ' Hook ', dueAt: '2026-11-09T17:33:00-06:00' });
  assert.deepEqual(li, {
    channelId: CHANNELS.linkedin, schedulingType: 'automatic', mode: 'customScheduled', dueAt: '2026-11-09T17:33:00-06:00',
    saveToDraft: true, text: 'Hook',
    metadata: { linkedin: { firstComment: 'https://support.tools/post/a-incident/?utm_source=linkedin&utm_medium=social' } },
    assets: [{ image: { url: CARD, metadata: { altText: 'Title a-incident' } } }],
  });
  const bs = draftInput({ channel: 'bluesky', article: a, text: 'Line', dueAt: '2026-11-09T16:26:00-06:00' });
  assert.deepEqual(bs.metadata, { bluesky: { linkAttachment: {
    url: 'https://support.tools/post/a-incident/?utm_source=bluesky&utm_medium=social', title: 'Title a-incident',
    description: 'About a-incident', thumbnail: { url: CARD },
  } } });
  const f = articles().find((x) => x.slug === 'f-custom');
  assert.equal(linkFor(f, 'bluesky'), 'https://support.tools/custom-path/?utm_source=bluesky&utm_medium=social');
});

// A scripted Claude: each call returns the next response in `script`.
function anthropicScript(script) {
  let i = 0;
  return (call) => {
    if (!isMessagesApi(call.url)) return null;
    const r = script[i++];
    if (!r) throw new Error('script ran out');
    return message({ model: 'claude-sonnet-5-5', usage: { input_tokens: 3000, output_tokens: 400 }, ...r });
  };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const BUFFER = 'https://buffer.test/graphql';

function smallWeek() {
  // Only Monday: a-incident (Bluesky + LinkedIn pick), b-guide (LinkedIn candidate).
  const arts = articles().filter((a) => a.day === '2026-11-09');
  const plan = planWeek({ articles: arts, days: days(), now: NOW });
  return { arts, plan };
}

test('the agent loop drafts through the tools, fixes rejected copy, and creates Buffer drafts only', async () => {
  const { arts, plan } = smallWeek();
  const created = [];
  const claude = anthropicScript([
    { stop_reason: 'tool_use', content: [toolUse('t1', 'read_article', { slug: 'a-incident' }), toolUse('t2', 'read_article', { slug: 'b-guide' })] },
    { stop_reason: 'tool_use', content: [toolUse('t3', 'create_draft', { channel: 'bluesky', slug: 'a-incident', text: 'etcd \u2014 disks' })] },
    { stop_reason: 'tool_use', content: [
      toolUse('t4', 'create_draft', { channel: 'bluesky', slug: 'a-incident', text: 'etcd falls over when disks are slow.' }),
      toolUse('t5', 'create_draft', { channel: 'linkedin', slug: 'a-incident', text: 'Slow disks broke etcd.\n\nWhat happened.\n\n#Kubernetes #etcd #SRE' }),
    ] },
    { stop_reason: 'tool_use', content: [toolUse('t6', 'create_draft', { channel: 'linkedin', slug: 'b-guide', text: 'Second pick.\n\n#a #b #c' })] },
    { content: [{ type: 'text', text: 'Mon: a-incident to Bluesky 16:26 and LinkedIn 17:33.' }] },
  ]);
  const calls = routeFetch((call) => {
    if (call.url === BUFFER) {
      assert.match(call.body.query, /createPost/);
      created.push(call.body.variables.input);
      return json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: `p${created.length}`, status: 'draft', dueAt: call.body.variables.input.dueAt } } } });
    }
    return claude(call);
  });
  const ledgerFile = join(repo, 'anthropic-ledger.json');
  const r = await runDrafter({
    client: await makeClient(), model: 'claude-sonnet-5-5', plan, articles: arts, pages: loadPages(join(repo, 'blog/content')),
    buffer: createClient({ apiKey: 'buf-test', url: BUFFER }), dryRun: false, ledgerFile, runCapUsd: 3,
    today: '2026-11-08', days: days(), log: () => {},
  });
  assert.equal(r.summary, 'Mon: a-incident to Bluesky 16:26 and LinkedIn 17:33.');
  assert.deepEqual(r.missing, []);
  assert.equal(created.length, 2);
  assert.ok(created.every((c) => c.saveToDraft === true && c.mode === 'customScheduled'));
  assert.deepEqual(created.map((c) => [c.channelId, c.dueAt]), [
    [CHANNELS.bluesky, '2026-11-09T16:26:00-06:00'], [CHANNELS.linkedin, '2026-11-09T17:33:00-06:00'],
  ]);

  const api = calls.filter((c) => isMessagesApi(c.url));
  assert.equal(api.length, 5);
  const first = api[0];
  assert.equal(first.body.model, 'claude-sonnet-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.equal(new Headers(first.init.headers).get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  assert.match(first.body.messages[0].content, /Bluesky draft required: a-incident/);
  assert.match(first.body.messages[0].content, /LinkedIn: pick ONE of a-incident/);
  assert.ok(first.body.tools.every((t) => t.strict === true));
  // The dash was sent back as an error tool_result, and the second LinkedIn draft for the day refused.
  const third = api[2].body.messages.at(-1).content[0];
  assert.equal(third.is_error, true);
  assert.match(third.content, /em or en dash/);
  const fifth = api[4].body.messages.at(-1).content[0];
  assert.equal(fifth.is_error, true);
  assert.match(fifth.content, /already has its one LinkedIn draft/);
  // Every response's usage is in the monthly ledger.
  assert.ok(loadLedger(ledgerFile).months[monthKey()].requests === 5);
  assert.ok(r.usd > 0);
});

test('--dry-run never calls Buffer and reports what it would draft', async () => {
  const { arts, plan } = smallWeek();
  const logs = [];
  routeFetch(anthropicScript([
    { stop_reason: 'tool_use', content: [toolUse('t1', 'create_draft', { channel: 'bluesky', slug: 'a-incident', text: 'One line.' })] },
    { content: [{ type: 'text', text: 'done' }] },
  ]));
  const r = await runDrafter({
    client: await makeClient(), model: 'claude-sonnet-5-5', plan, articles: arts, pages: loadPages(join(repo, 'blog/content')),
    buffer: null, dryRun: true, ledgerFile: join(repo, 'l.json'), runCapUsd: 3, today: '2026-11-08', days: days(), log: (l) => logs.push(l),
  });
  assert.equal(r.created.length, 1);
  assert.match(logs[0], /^DRY RUN bluesky 2026-11-09T16:26:00-06:00 a-incident\n {2}link: https:\/\/support\.tools\/post\/a-incident\/\?utm_source=bluesky/);
  assert.deepEqual(r.missing, ['linkedin 2026-11-09']);
});

test('the per-run cap stops the loop before an expensive turn', async () => {
  const { arts, plan } = smallWeek();
  const calls = routeFetch(anthropicScript([]));
  await assert.rejects(runDrafter({
    client: await makeClient(), model: 'claude-sonnet-5-5', plan, articles: arts, pages: loadPages(join(repo, 'blog/content')),
    buffer: null, dryRun: true, ledgerFile: join(repo, 'l.json'), runCapUsd: 0.01, today: '2026-11-08', days: days(), log: () => {},
  }), (e) => e.name === 'BudgetError' && /per-run/.test(e.message));
  assert.equal(calls.length, 0);
});

test('weekly-drafter --plan-only needs no keys and calls nothing', () => {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'BUFFER_API_KEY', 'OPENAI_API_KEY']) delete env[k];
  const out = execFileSync(process.execPath, [resolve('scripts/social/weekly-drafter.mjs'), '--plan-only', '--week-start', '2026-11-09'], { env, encoding: 'utf8' });
  assert.match(out, /^week 2026-11-09\.\.2026-11-15: \d+ articles, 0 Buffer posts checked/);
});

test('a Buffer post that was not saved as a draft stops the run; the model never sees it as a retryable error', async () => {
  const { arts, plan } = smallWeek();
  const logs = [];
  const claude = anthropicScript([
    { stop_reason: 'tool_use', content: [toolUse('t1', 'create_draft', { channel: 'bluesky', slug: 'a-incident', text: 'etcd falls over when disks are slow.' })] },
    { content: [{ type: 'text', text: 'should never be reached' }] },
  ]);
  const calls = routeFetch((call) => {
    if (call.url === BUFFER) {
      return json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p-live', status: 'scheduled', dueAt: call.body.variables.input.dueAt } } } });
    }
    return claude(call);
  });
  await assert.rejects(runDrafter({
    client: await makeClient(), model: 'claude-sonnet-5-5', plan, articles: arts, pages: loadPages(join(repo, 'blog/content')),
    buffer: createClient({ apiKey: 'buf-test', url: BUFFER }), dryRun: false, ledgerFile: join(repo, 'l.json'), runCapUsd: 3,
    today: '2026-11-08', days: days(), log: (l) => logs.push(l),
  }), (e) => e.halt === true && /post p-live .*status scheduled, not draft/.test(e.message));
  assert.equal(calls.filter((c) => isMessagesApi(c.url)).length, 1);
  assert.equal(calls.filter((c) => c.url === BUFFER).length, 1);
});

test('weekly-drafter: a per-run cap that is not a number >= 0 exits 4 before any API call', () => {
  for (const bad of ['abc', '-1']) {
    const env = { ...process.env, SOCIAL_ANTHROPIC_RUN_CAP_USD: bad, OG_ANTHROPIC_LEDGER: join(repo, 'l.json') };
    for (const k of ['ANTHROPIC_API_KEY', 'BUFFER_API_KEY', 'OPENAI_API_KEY']) delete env[k];
    const r = spawnSync(process.execPath, [resolve('scripts/social/weekly-drafter.mjs'), '--dry-run', '--week-start', '2026-11-09'], { env, encoding: 'utf8' });
    assert.equal(r.status, 4, `${bad}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`SOCIAL_ANTHROPIC_RUN_CAP_USD is not a non-negative number: ${bad}`));
  }
});
