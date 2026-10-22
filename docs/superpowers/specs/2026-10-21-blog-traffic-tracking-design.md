# Blog traffic tracking: design (2026-10-21)

## Why

The owner's goal is more traffic to support.tools. To spend effort where it pays, he needs to see,
every week: how much traffic the blog gets, which posts and topics earn readers, where readers come
from (search, social, referrals), and which search queries are rising or slipping. Today PostHog
records pageviews (project 78897, about 1,300 pageviews a week, about 62% from Google), but it
cannot answer "which topics work", Search Console data is not pulled anywhere, and social results
sit in Buffer.

## Goals

- Per-post and per-topic traffic, read-through and sources, comparable week over week.
- Search performance: queries, impressions, clicks, CTR and position per page and per topic.
- Social results per channel (LinkedIn, Bluesky) tied back to the posts they promoted.
- Three outputs, all from the same numbers (owner's choice):
  1. a PostHog dashboard (live, PostHog data only),
  2. Prometheus metrics with a Grafana dashboard and alerts,
  3. a weekly scorecard page (claude.ai dashboard) that combines all sources and adds 3 to 5
     concrete suggestions.
- Feed the results back into what gets promoted (the weekly Buffer job reads the topic ranking).

## Non-goals

- No GA4 or other new analytics vendor; PostHog stays the one tracker.
- No per-person tracking or PII. `person_profiles: identified_only` stays; nothing identifies readers.
- No real-time alerting on individual posts; weekly is the decision cadence.
- No change to how posts are written or scheduled (that is the separate growth plan in
  `docs/growth/2026-10-21-traffic-growth-opportunities.md`).

## Anti-goals (failure even if it "works")

- Metrics with unbounded label cardinality (a label per URL or per query) in Prometheus.
- A dashboard nobody reads because it shows raw tables without a conclusion.
- Tracking that slows the page (the site is about 25 KB per page today).

## Parts

### 1. Instrumentation (theme)

- Remove the dead Universal Analytics `gtag` block in `baseof.html` (UA stopped processing in 2023).
  The GTM container `GTM-TF2NG6JW` stays until the owner confirms what it contains.
- On post pages, register PostHog properties from frontmatter so every event carries them:
  `post_slug`, `post_section`, `post_category` (first category, normalized), `post_tags` (up to 5),
  `post_kind`, `post_published` (date), `post_words`.
  `post_kind` is one of `troubleshooting`, `incident`, `guide`, `reference` (builder's call on the
  rule; for example: `known-good-designs` section is `reference`; titles or slugs naming an error
  string, "fix", "troubleshooting" are `troubleshooting`; a frontmatter field can override).
- New events, sent from the existing `enhance.js`:
  - `article_read`: reader reached 75% of the article body and stayed at least 30 s. One per page view.
  - `code_copied`: the existing copy button was used (with `post_slug`).
  - outbound link clicks come from PostHog autocapture already; no new event.
- No new script files; the additions live in `enhance.js` and a small data block in the template.

### 1b. Bot filtering (found 2026-10-21)

A headless Chrome sends one pageview per visitor from a Linux 1919x992 window
(Chrome 153 to 156, with or without a `www.google.com` referrer): 3,907 of 8,310
pageviews in the 30 days to 2026-10-22. It caused the Aug 2 and Sep 20 spike weeks
and the apparent "decline". Search Console shows human search traffic flat at about
150 clicks a week.

- Every PostHog query, insight, dashboard tile and exporter metric excludes it through one shared
  definition: the HogQL expression in `analytics/bot-filter.hogql`, saved (2026-10-22) as a
  `hogql` entry in project 78897's test-account filters, plus `$host = support.tools`, with
  "filter test accounts" on by default.
- Search trends come from Search Console, never from PostHog referrers.
- The exporter publishes `blog_bot_pageviews{window}` (pageviews the filter removed) so a new or
  changed bot signature shows up as a jump in that series; re-check the signature monthly.
- Builder's call: drop it at capture time instead (skip `posthog.init` for that signature) only if
  the filter proves leaky.

### 2. Data sources and credentials

| Source | What | Access | Vault path |
|---|---|---|---|
| PostHog | pageviews, reads, sources, UTMs | personal API key, query + insight read (done, verified 2026-10-21) | `secret/infra/posthog-supporttools-read` |
| Google Search Console | queries, pages, clicks, impressions, CTR, position; sitemap indexed counts | a Google Cloud service account added to the GSC property as a Restricted user; JSON key | `secret/infra/gsc-supporttools-read` (key stored and valid; service account `gsc-supporttools-read@supporttools-502015.iam.gserviceaccount.com` still to be added to the property as Restricted) |
| Buffer | per-post impressions, clicks, engagement per channel | Buffer API key from publish.buffer.com/settings/api | `secret/infra/buffer-supporttools` (done, verified) |

Bing Webmaster Tools is optional later (about 5% of visits).

### 3. Collector: `blog-metrics-exporter`

- Small Go service in this repo (`cmd/blog-metrics-exporter/`), image pushed to Harbor like the
  site image. Deployed in the cluster the way `cluster-services/github-exporter` is: namespace
  `blog-metrics`, ExternalSecrets from the Vault paths above, a ServiceMonitor, PrometheusRules.
  Manifests live in `cluster-services/blog-metrics/`.
- It polls on its own schedule and serves cached values; scrapes never call the APIs:
  PostHog every hour, Search Console and Buffer once a day (GSC data lags 2 to 3 days).
- Metrics (all gauges over fixed windows; labels are bounded sets):

| Metric | Labels |
|---|---|
| `blog_pageviews{window}` / `blog_visitors{window}` | window = 1d, 7d, 28d |
| `blog_pageviews_by_channel{window,channel}` | channel = google, bing, other_search, direct, linkedin, bluesky, reddit, hackernews, internal, other |
| `blog_pageviews_by_topic{window,topic}` | topic = normalized category, top 20 plus `other` |
| `blog_pageviews_by_kind{window,kind}` | kind = troubleshooting, incident, guide, reference, page |
| `blog_article_reads{window,topic}` and `blog_read_rate{window,topic}` | as above |
| `blog_top_post_pageviews{window,rank,slug}` | rank 1 to 20 only (bounded) |
| `blog_search_clicks` / `_impressions` / `_ctr` / `_position{window}` | window = 7d, 28d |
| `blog_search_clicks_by_topic{window,topic}` | top 20 topics plus `other` |
| `blog_sitemap_submitted` / `blog_sitemap_indexed` | none |
| `blog_social_clicks{window,channel}` / `blog_social_impressions{window,channel}` | channel = linkedin, bluesky |
| `blog_metrics_source_up{source}`, `blog_metrics_source_last_success_timestamp_seconds{source}` | source = posthog, gsc, buffer |

- Alerts (warning severity, not paging): a source failing for more than 2 refresh intervals;
  7-day pageviews down more than 30% week over week; indexed pages down more than 10% week over week.
- Grafana dashboard JSON committed next to the other dashboards in `cluster-services/Dashboards/`.

### 4. PostHog dashboard

Built through the PostHog connector in project 78897, filtered to `$host = support.tools`:
weekly pageviews and visitors, channel mix, top posts, topics and kinds by readers (after part 1
ships), read rate by topic, social UTM traffic by channel, and web vitals.

### 5. Weekly scorecard

- A private claude.ai dashboard page, updated Sunday 17:30 (before the 18:00 Buffer job) by
  `scripts/analytics/weekly-scorecard.sh` on the workstation: it pulls the week from the exporter's
  JSON endpoint (`/report`), then `claude -p` writes the 3 to 5 suggestions and updates the page.
- Sections: headline numbers with week-over-week change, top posts, topics ranked by readers per
  post, search queries climbing or slipping, social results, suggestions.
- The weekly Buffer job reads the same topic ranking to prefer topics that earn readers.

## Order of work

1. Instrumentation (part 1), deployed; PostHog starts collecting topics immediately.
2. PostHog dashboard (part 4) with what exists today; topic tiles fill in as data arrives.
3. Exporter with PostHog first, then GSC and Buffer as their keys arrive (part 3), then Grafana and alerts.
4. Scorecard (part 5) once the exporter serves `/report`.

## Decided by the owner

- PostHog stays the tracker; data is in project 78897.
- Outputs: claude.ai dashboard, PostHog dashboard, and Prometheus.
- API keys live in Vault under `secret/infra/`.

## Builder's calls (marked as such)

- `post_kind` rules, topic normalization map, the 75%/30 s read threshold.
- Exporter in Go in this repo; deployed like github-exporter.
- Bounded label sets as listed; anything outside goes to `other`.
- Scorecard timing (Sunday 17:30).

## Open (owner)

- Search Console API access: service account JSON key into Vault.
- Buffer API key into Vault.
- What the GTM container `GTM-TF2NG6JW` is used for (keep or remove).
- Which cluster runs the exporter (default: the one running github-exporter).
