# Traffic Tracking, Part 3: blog-metrics-exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go service polls PostHog, Google Search Console and Buffer and serves the blog's traffic, topic, search and social numbers in two forms: bounded-label Prometheus metrics and a `/report` JSON. Alerts and a Grafana dashboard are deployed on a1-ops-prd.

**Architecture:**
- **Pollers.** One poller per source refreshes an in-memory `Snapshot`: PostHog hourly, GSC and Buffer daily, and every source retries after 15 minutes when a poll fails.
- **Serving.** Scrapes and `/report` only read the last good snapshot. They never call an API.
- **Bot filter.** HogQL queries embed the same bot filter as the PostHog project, through a copy that a test keeps byte-identical to `analytics/bot-filter.hogql`.
- **Topics for search pages.** Search pages map to topics through a `post-index.json` that Hugo publishes.
- **Deployment.** Manifests follow `cluster-services/monitoring/a1-ops-prd/noc-kiosk/noc-am-alerts-exporter.yaml`, and the image build follows `cluster-services/media-server/watchdog`.

**Tech Stack:**
- Go 1.25, `github.com/prometheus/client_golang` v1.23.2, and the standard library otherwise (JWT signing for GSC uses `crypto/rsa`).
- Hugo output format for the post index.
- Kubernetes: ExternalSecret (`vault-infra`), Deployment, Service, ServiceMonitor, PrometheusRule (`release: monitoring`), and a kustomize Grafana dashboard.

**Spec:** `docs/superpowers/specs/2026-10-21-blog-traffic-tracking-design.md`, part 3 (and 1b for the bot metric, 5 for `/report`).

## Global Constraints

- Prometheus labels are bounded sets only. No label per URL or query, except `slug` on ranks 1 to 20.
- Windows: PostHog `1d`, `7d`, `28d`. GSC and Buffer `7d` and `28d`. GSC windows end 3 days before today (UTC), because GSC data lags 2 to 3 days.
- Channel set: `google, bing, other_search, ai_assistant, direct, linkedin, bluesky, reddit, hackernews, internal, other`.
  `ai_assistant` is added to the spec's list, because chatgpt.com, copilot.com and gemini already send traffic.
- Topic = `post_category` (the urlized first category). Keep the top 20 by 28-day pageviews, and sum the rest into `other`.
- Kind set: `troubleshooting, incident, guide, reference, page`. Events with no `post_kind` count as `page`.
- Every PostHog query filters `properties.$host = 'support.tools'` and the embedded bot filter. `blog_bot_pageviews` uses `NOT (<filter>)`.
- Credentials come only from env vars, which the ExternalSecrets fill from Vault: `secret/infra/posthog-supporttools-read` (`api_key`, `project_id`), `secret/infra/gsc-supporttools-read` (`key`), `secret/infra/buffer-supporttools` (`api_key`). Never log a credential.
- Fetch tiers on the build path:
  - Base images come through the Harbor proxy cache: `harbor.support.tools/dockerhub/library/golang:1.25-alpine`, then `scratch`.
  - Modules use `GOPROXY` set to the in-cluster Athens when the build runs on an ARC runner. A workstation build falls back to proxy.golang.org, checksummed by go.sum. File a follow-up to move the build onto an ARC job.
- Image: `harbor.support.tools/supporttools/blog-metrics-exporter:<semver>`, deployed by an exact tag.
- No em or en dashes in user-facing text (dashboard titles, alert summaries).

## Departures from the spec (rulings, recorded in the ledger at setup)

1. **Its own Go module** at `exporters/blog-metrics/`, not `cmd/` in the root module. The daily `pipeline.yml` still builds the root module with `golang:1.22.4`, and Go 1.25 would break it. Instead of `//go:embed` across modules, there is a copy plus a drift test.
2. **Namespace `monitoring`, not `blog-metrics`.** The `harbor-supporttools` pull secret and the other custom exporters already live there.
3. **Social metrics.** Buffer has no click data (verified 2026-10-22 through `aggregatedPostMetrics`). Social clicks are `blog_pageviews_by_channel{channel=~"linkedin|bluesky"}` from PostHog UTM. Buffer gives `postCount`, `reactions` and `comments` on both channels, and `impressions` and `reach` on LinkedIn only.
4. **No sitemap metrics, and no "indexed pages down" alert.** The Search Console API's sitemap `indexed` field is deprecated and returns no value. Task 8 Step 3 confirms this with one live call, and if it does return counts, add them as a follow-up.

## Review Focus

1. **One source is down or slow** (e.g. GSC 500s for a day). Its last good values keep being served, with `blog_metrics_source_up{source}=0`. They are not zeroed, because zeros would look like a traffic crash and fire the week-over-week alert. The other sources keep updating. (Task 6, `TestSourceFailureKeepsLastGood`.)
2. **The exporter restarts.** Before a source's first successful poll it exports `source_up 0` and none of that source's value series: never zeros. (Task 6, `TestNoValuesBeforeFirstSuccess`.)
3. **The top posts change between refreshes.** A slug that drops out of the top 20 must disappear, not stay frozen at its old value. (Task 6, `TestTopPostsChurnLeavesNoStaleSlug`.)
4. **PostHog returns null or empty category or kind**, from pre-instrumentation events, non-article pages, or `utm_source` null with `$referring_domain = '$direct'`. These must never produce an empty label value: kind falls back to `page`, the topic row is skipped, and the channel becomes `direct`. (Task 3 classify tests, and Task 4 `TestNullPropertiesBucketed`.)
5. **The GSC lag boundary.** The 7-day window is exactly 7 whole days ending today-3. A run just after midnight UTC must not shift by a day (`TestGSCWindowDates`). The token is reused until 60 s before it expires (`TestTokenCached`).

---

## File Structure

**Website repo:**

| File | Responsibility |
|---|---|
| `blog/themes/m10c/layouts/partials/post-props.html` (new) | `return`s the property dict (category, kind and so on). Single source for the data block and the index. |
| `blog/themes/m10c/layouts/partials/analytics-props.html` | Now calls `post-props.html`. Same output. |
| `blog/themes/m10c/layouts/index.postindex.json` (new) | `/post-index.json`: every published article's props. |
| `blog/config.toml` | Adds the `PostIndex` output format to the home outputs. |
| `tests/theme/post-index.test.mjs` (new) | Tests for the index. |
| `exporters/blog-metrics/go.mod` | Module `github.com/supporttools/website/exporters/blog-metrics`, go 1.25. |
| `exporters/blog-metrics/internal/botfilter/` | `bot-filter.hogql` (copy), `botfilter.go` (`//go:embed`, `Human() string`, `Bot() string`), drift test. |
| `exporters/blog-metrics/internal/classify/` | `Channel`, `Kind` and `TopN`: pure functions. |
| `exporters/blog-metrics/internal/posthog/` | HogQL API client, plus `Collect` returning `Traffic`. |
| `exporters/blog-metrics/internal/gsc/` | Service-account token, `searchAnalytics` client, `Collect` returning `Search`. |
| `exporters/blog-metrics/internal/buffer/` | GraphQL client, `Collect` returning `Social`. |
| `exporters/blog-metrics/internal/postindex/` | Fetches `post-index.json` and builds a slug-to-topic map. |
| `exporters/blog-metrics/internal/snapshot/` | `Snapshot` types, the `Store` (last-good per source, source status), the Prometheus collector, and the `/report` JSON. |
| `exporters/blog-metrics/cmd/blog-metrics-exporter/main.go` | Config from env, poller loops, HTTP server (`/metrics`, `/report`, `/healthz`). |
| `exporters/blog-metrics/Dockerfile`, `Makefile` | Image build and push. |

**cluster-services repo:**

| File | Responsibility |
|---|---|
| `monitoring/a1-ops-prd/blog-metrics-exporter.yaml` | 3 ExternalSecrets, Deployment, Service, ServiceMonitor, with a header runbook. |
| `monitoring/a1-ops-prd/blog-metrics-alerts.yaml` | PrometheusRule. |
| `rack-control/prometheusrules/blog-metrics-alerts.test.yaml` | promtool tests. |
| `Dashboards/CoreInfra/blog-traffic.json`, `Dashboards/kustomization.yaml` | Grafana dashboard. |

---

### Task 1: `post-index.json` from Hugo

**Files:** create `post-props.html`, `index.postindex.json` and `tests/theme/post-index.test.mjs`. Modify `analytics-props.html` and `blog/config.toml`.

**Interfaces:**
- Produces `https://support.tools/post-index.json`: a JSON array of `{post_slug, post_section, post_category, post_kind, post_published, post_words}` for every regular page in `post`, `known-good-designs` and `training` that Hugo builds. Future-dated and draft pages are not built in production, so they are excluded. It deliberately has no tags, to keep it small.
- `partial "post-props.html" .` returns that dict plus `post_tags`. `analytics-props.html` renders it unchanged, so the existing analytics tests stay green.

- [ ] **Step 1: Write the failing tests** in `post-index.test.mjs`. Read `post-index.json` through `readPage('post-index.json')` (`site.mjs` already serves `.json` paths only via `.md|.txt`, so extend that regex to `json`).

```js
test('post-index lists articles with their props', () => {
  const idx = JSON.parse(readPage('post-index.json'));
  const fx = idx.find((p) => p.post_slug === 'theme-fixture-error-fix');
  assert.deepEqual(fx, { post_slug: 'theme-fixture-error-fix', post_section: 'post', post_category: '',
    post_kind: 'troubleshooting', post_published: '2020-01-01', post_words: fx.post_words });
  assert.ok(idx.some((p) => p.post_kind === 'reference'));
  assert.ok(!idx.some((p) => p.post_slug === 'about'));
});

test('the analytics data block and the index agree for the same page', () => {
  const idx = JSON.parse(readPage('post-index.json'));
  const block = readPage('theme-fixture').match(/id="post-analytics">([^<]*)</)[1];
  const { post_tags, ...rest } = JSON.parse(block);
  assert.deepEqual(idx.find((p) => p.post_slug === 'theme-fixture'), rest);
});
```

- [ ] **Step 2:** `npm run test:theme`. Expected: FAIL (no file).
- [ ] **Step 3: Implement.**
  - Move the dict-building out of `analytics-props.html` into `post-props.html`, ending with `{{ return $props }}`.
  - `analytics-props.html` keeps its guard and does `{{ $props := partial "post-props.html" . }}`.
  - Config:

    ```toml
    [outputFormats.PostIndex]
      mediaType = "application/json"
      baseName = "post-index"
      isPlainText = true
      notAlternative = true
    ```

    Add `"PostIndex"` to `[outputs] home`, keeping the existing entries.
  - The template ranges over `where site.RegularPages "Section" "in" (slice "post" "known-good-designs" "training")`, deletes `post_tags` from each dict, and emits `jsonify`.
- [ ] **Step 4:** `npm run test:theme` passes. Also run `check:paths`. Then check the size: `ls -l .theme-test-public/post-index.json` should be under 300 KB.
- [ ] **Step 5:** Commit with the message `feat(theme): publish post-index.json (slug, topic, kind) for the metrics exporter`.

---

### Task 2: Exporter module, bot filter copy and drift test

**Files:** `exporters/blog-metrics/go.mod`, `internal/botfilter/{bot-filter.hogql,botfilter.go,botfilter_test.go}`. Add `exporters/blog-metrics` to `.gitignore` exclusions only if needed.

**Interfaces:**
- Produces `botfilter.Human() string`, which returns the trimmed file contents, and `botfilter.Bot() string`, which returns `"NOT (" + Human() + ")"`.

- [ ] **Step 1: Failing tests.**
  - `TestCopyMatchesCanonical`: the embedded bytes equal `os.ReadFile("../../../../analytics/bot-filter.hogql")`.
  - `TestHumanIsSingleBooleanExpression`: the result starts with `NOT (`, has balanced parentheses, and contains no `;` or newline.
- [ ] **Step 2:** `cd exporters/blog-metrics && go test ./...`. Expected: FAIL (no package).
- [ ] **Step 3: Implement.** Run `go mod init`, then `go get github.com/prometheus/client_golang@v1.23.2` (that happens in Task 6, when it is first used). Copy the filter file and embed it.
- [ ] **Step 4:** `go test ./...` passes. Then edit the canonical file with a space and confirm the drift test FAILS. Revert the edit.
- [ ] **Step 5:** Commit with the message `feat(exporter): blog-metrics module with the shared bot filter`.

---

### Task 3: Classification helpers

**Files:** `internal/classify/{classify.go,classify_test.go}`.

**Interfaces:**
- `Channel(referringDomain, utmSource string) string` returns one of the 11 channels. The rules, in order:
  1. `utm_source` (lowercased) `linkedin` or `bluesky` wins.
  2. Domain `$direct` or empty means `direct`.
  3. `support.tools` and its subdomains mean `internal`.
  4. `google.*` or `www.google.*` mean `google`. `bing.com` means `bing`.
  5. `duckduckgo|yahoo|yandex|baidu|ecosia|qwant|search.brave|startpage` mean `other_search`.
  6. `chatgpt.com|chat.openai.com|copilot.com|copilot.microsoft.com|gemini.google.com|perplexity.ai|claude.ai`, or a `utm_source` among `chatgpt.com|copilot.com|gemini|perplexity`, mean `ai_assistant`.
  7. `linkedin.com|lnkd.in` mean `linkedin`. `bsky.app` means `bluesky`. `reddit.com|old.reddit.com|out.reddit.com` mean `reddit`. `news.ycombinator.com` means `hackernews`.
  8. Anything else is `other`.

  Note that `gemini.google.com` must hit rule 6 before the `google` match in rule 4: check AI domains first.
- `Kind(v string) string` returns `v` when it is in the kind set, otherwise `page`.
- `TopN(m map[string]float64, n int, other string) map[string]float64` keeps the n largest keys. Ties break by key, ascending. The rest are summed into `other`, and `other` is omitted when it is 0. Empty keys are dropped.

- [ ] **Step 1: Failing table tests**, one row per rule. Include these cases:
  - `("gemini.google.com","")` gives `ai_assistant`.
  - `("www.google.com","linkedin")` gives `linkedin`.
  - `("$direct","")` and `("","")` give `direct`.
  - `("stg.support.tools","")` gives `internal`.
  - `Kind("")` and `Kind("weird")` give `page`.
  - `TopN` with 22 keys returns 21 entries, including `other`. `TopN` with an empty-key entry drops it.
- [ ] **Step 2:** Run the tests; they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** The tests PASS.
- [ ] **Step 5:** Commit with the message `feat(exporter): channel, kind and top-N classification`.

---

### Task 4: PostHog source

**Files:** `internal/posthog/{client.go,collect.go,*_test.go}`.

**Interfaces:**
- `Client{BaseURL, ProjectID, APIKey string; HTTP *http.Client}`.
  `func (c *Client) Query(ctx context.Context, hogql string) ([][]any, error)` sends `POST {BaseURL}/api/projects/{ProjectID}/query/` with the body `{"query":{"kind":"HogQLQuery","query":...},"name":"blog-metrics-exporter"}` and `Authorization: Bearer`. It returns `results`, errors on non-2xx with the status and the first 200 bytes of the body, and uses a 60 s timeout.
- `Collect(ctx, c *Client, host string) (snapshot.Traffic, error)` runs these queries. `F` = `properties.$host = '<host>' AND <botfilter.Human()>`. All queries use `timestamp > now() - INTERVAL 28 DAY`, and the per-window splits use `countIf(timestamp > now() - INTERVAL 1 DAY)` and so on.
  1. Totals: pageviews and visitors per window, plus bot pageviews per window using `botfilter.Bot()`.
  2. Channels: `GROUP BY properties.$referring_domain, properties.utm_source` with per-window `countIf`. These go through `classify.Channel` and are summed.
  3. Topics: for `$pageview` and `article_read`, `GROUP BY properties.post_category`, giving pageviews and reads per window. Rows with an empty or null category are skipped. `TopN(20)` uses the 28-day pageviews, and the same top set applies to the other windows.
  4. Kinds: `GROUP BY properties.post_kind`, through `classify.Kind`.
  5. Top posts: `$pageview` with `post_slug != ''`, top 20 by count for 7d and 28d (two queries, `ORDER BY c DESC, slug LIMIT 20`).
- `snapshot.Traffic` (defined in Task 6): `Pageviews, Visitors, Bot map[Window]float64`. `Channels, Topics, Reads, Kinds map[Window]map[string]float64`. `TopPosts map[Window][]Ranked{Slug string; Pageviews float64}`.

- [ ] **Step 1: Failing tests** with an `httptest.Server` that asserts the path, auth header and `$host`/bot filter text in each query, and answers canned `results`.
  - `TestQuerySendsHogQLAndParsesResults`.
  - `TestQueryErrorIncludesStatus`: a 403 response makes the error contain `403`.
  - `TestCollectBuildsTraffic`: maps the canned rows to the expected `Traffic`.
  - `TestNullPropertiesBucketed`: rows with a nil category or kind and a nil `utm_source` give `Kinds[...]["page"]` and `Channels[...]["direct"]`, with no `""` key anywhere.
- [ ] **Step 2:** Run the tests; they FAIL.
- [ ] **Step 3:** Implement. Decode numbers with a `toFloat(any) float64` helper that accepts `float64`, `json.Number` and `string`.
- [ ] **Step 4:** The tests PASS.
- [ ] **Step 5:** Commit with the message `feat(exporter): PostHog traffic, topics, kinds and top posts`.

---

### Task 5: GSC, Buffer and post index sources

**Files:** `internal/gsc/{token.go,client.go,collect.go,*_test.go}`, `internal/buffer/{client.go,*_test.go}`, `internal/postindex/{postindex.go,*_test.go}`.

**Interfaces:**
- `gsc.NewTokenSource(keyJSON []byte, tokenURL string, now func() time.Time) (*TokenSource, error)`. It parses `client_email` and `private_key` (PKCS#8 or PKCS#1 PEM).
  `(*TokenSource).Token(ctx) (string, error)` builds an RS256 JWT with `iss=client_email`, `scope=https://www.googleapis.com/auth/webmasters.readonly`, `aud=tokenURL` and `exp=iat+3600`, posts it as `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, and caches the result until 60 s before `expires_in`.
- `gsc.Windows(now time.Time) map[snapshot.Window][2]string` gives `7d` = [today-9, today-3] and `28d` = [today-30, today-3], as `YYYY-MM-DD` in UTC.
- `gsc.Client{BaseURL, Site string; Tokens *TokenSource; HTTP *http.Client}`.
  `Query(ctx, start, end string, dims []string, rowLimit int) ([]Row, error)` posts to `{BaseURL}/webmasters/v3/sites/{url.PathEscape(Site)}/searchAnalytics/query`. `Row{Keys []string; Clicks, Impressions, CTR, Position float64}`.
- `gsc.Collect(ctx, c, topics map[string]string) (snapshot.Search, error)`. For each window it fetches:
  - Totals: no dimensions.
  - By page: `["page"]`, `rowLimit 5000`. Map each page through `postindex.SlugFromURL`, then through `topics`. Unknown pages go to `other`, and the result goes through `TopN(20)` by 28-day clicks.
  - For `/report`: top 50 queries by impressions for the 7-day window and for the prior 7 days ([today-16, today-10]).
- `buffer.Client{URL, APIKey, OrgID string; HTTP *http.Client}`.
  `Aggregated(ctx, channelID string, start, end time.Time) (map[string]float64, error)` sends the GraphQL query `aggregatedPostMetrics(input:{organizationId, channelIds:[id], startDateTime, endDateTime}) { metrics { type value } }` (verified 2026-10-22) and returns `type` mapped to `value`.
  `buffer.Collect(ctx, c, channels map[string]string) (snapshot.Social, error)` runs it for 7d and 28d per channel, keeping only `postCount, reactions, comments, impressions, reach` and renaming `postCount` to `posts`.
- `postindex.Fetch(ctx, url string, hc *http.Client) (map[string]string, error)` maps slug to topic, and empty topics are skipped.
  `postindex.SlugFromURL(u string) string` maps `https://support.tools/a/b/` to `a/b`, ignoring the query string and fragment.

- [ ] **Step 1: Failing tests.**
  - `TestTokenSignsAndCaches`: the fake token endpoint verifies the JWT signature with the test key's public key, and a second `Token` call within the TTL makes no second request (that is `TestTokenCached`).
  - `TestGSCWindowDates` at `2026-10-23T00:00:30Z` gives 7d = `2026-10-14..2026-10-20`.
  - `TestSearchByTopic` maps pages through a stub index.
  - `TestBufferAggregated` asserts the GraphQL body and keeps only the 5 metric types.
  - `TestSlugFromURL`.
  - `TestFetchIndex`.
- [ ] **Step 2:** Run the tests; they FAIL.
- [ ] **Step 3:** Implement. Generate the RSA test key in the test with `rsa.GenerateKey(rand.Reader, 2048)`. Never commit a key.
- [ ] **Step 4:** The tests PASS.
- [ ] **Step 5:** Commit with the message `feat(exporter): Search Console, Buffer and post-index sources`.

---

### Task 6: Snapshot store, metrics, /report, main, image

**Files:** `internal/snapshot/{types.go,store.go,collector.go,report.go,*_test.go}`, `cmd/blog-metrics-exporter/main.go`, `Dockerfile`, `Makefile`.

**Interfaces:**
- `type Window string` with the constants `W1d`, `W7d` and `W28d`.
- `Store`:
  - `SetTraffic`, `SetSearch` and `SetSocial` each store the value, mark the source up and stamp the last success.
  - `Fail(source string)` marks the source down and keeps its value.
  - `Get()` returns a copy of the snapshot plus each source's status `{Up bool; LastSuccess time.Time; HasData bool}`.
- `NewCollector(*Store) prometheus.Collector` builds const metrics on every scrape, so no `GaugeVec` state can go stale. It emits the metric names from the spec's part 3 table, with the rulings applied:
  - `blog_pageviews`, `blog_visitors` and `blog_bot_pageviews` `{window}`.
  - `blog_pageviews_by_channel`, `blog_pageviews_by_topic`, `blog_article_reads`, `blog_read_rate` (reads / pageviews, omitted when pageviews = 0) and `blog_pageviews_by_kind`.
  - `blog_top_post_pageviews{window,rank,slug}`.
  - `blog_search_{clicks,impressions,ctr,position}{window}` and `blog_search_{clicks,impressions}_by_topic{window,topic}`.
  - `blog_social_{posts,reactions,comments,impressions,reach}{window,channel}`.
  - `blog_metrics_source_up{source}` and `blog_metrics_source_last_success_timestamp_seconds{source}`.

  A source with `HasData == false` emits only its two status series.
- `report.go`: `Report(snap, status) any` marshals to the JSON that `/report` serves. Its keys are `generated_at, sources, traffic, topics (rows: topic, pageviews, reads, read_rate, search_clicks, search_impressions, articles), kinds, top_posts, search (totals and queries with prev values), social`. `articles` is the post-index count per topic.
- `main.go`:
  - It reads env vars: `POSTHOG_URL` (default `https://us.posthog.com`), `POSTHOG_PROJECT_ID`, `POSTHOG_API_KEY`, `SITE_HOST=support.tools`, `GSC_KEY_JSON`, `GSC_SITE=sc-domain:support.tools`, `BUFFER_URL=https://api.buffer.com`, `BUFFER_API_KEY`, `BUFFER_ORG_ID`, `BUFFER_CHANNELS=linkedin=<id>,bluesky=<id>`, `POST_INDEX_URL=https://support.tools/post-index.json` and `LISTEN_ADDR=:8080`.
  - A missing required variable makes it exit 1, and the message names the variable.
  - It runs three loops: PostHog every 1 h, GSC (after the post index) every 24 h, and Buffer every 24 h, each retrying after 15 min on failure. Each runs at start.
  - It serves `/metrics` from its own registry, plus Go and process collectors, and also serves `/report` and `/healthz`.
  - It logs one line per poll with the source, duration and outcome, and never logs a key.
- `Dockerfile`: the two stages of `cluster-services/media-server/watchdog/Dockerfile`, with `FROM harbor.support.tools/dockerhub/library/golang:1.25-alpine` and `ARG GOPROXY`.
- `Makefile`: `test` runs `go test ./...` and `go vet ./...`. `image TAG=x` runs `docker build --build-arg GOPROXY=...` then `docker push harbor.support.tools/supporttools/blog-metrics-exporter:$(TAG)`.

- [ ] **Step 1: Failing tests.**
  - `TestNoValuesBeforeFirstSuccess`: an empty store scrapes to exactly 6 status series, `up` 0.
  - `TestSourceFailureKeepsLastGood`: Set, then Fail, then scrape keeps the values with `up` 0.
  - `TestTopPostsChurnLeavesNoStaleSlug`.
  - `TestReadRateOmittedWhenNoPageviews`.
  - `TestReportShape`: the JSON keys exist.
  - `TestMetricNamesMatchSpec`: compares against a golden list.

  Use `testutil.CollectAndCompare` or `CollectAndCount`.
- [ ] **Step 2:** Run the tests; they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `make test` passes. Then `go build ./cmd/...` and run the binary with no env, which must exit 1 naming `POSTHOG_API_KEY`.
- [ ] **Step 5:** Commit with the message `feat(exporter): metrics, /report and the poller service`.

---

### Task 7: Manifests, alerts, dashboard (cluster-services repo)

**Files:** listed in File Structure, cluster-services part.

- [ ] **Step 1: Alert rules and promtool tests first.** The tests file follows `rack-control/prometheusrules/*.test.yaml`. The alerts are all `severity: warning`, with no paging.
  - `BlogMetricsSourceStale`: `time() - blog_metrics_source_last_success_timestamp_seconds > on(source) group_left` 2 refresh intervals. That is 7200 s for posthog and 172800 s for gsc and buffer, expressed as two rules or a `label_replace` threshold vector, for 15m.
  - `BlogMetricsExporterDown`: `absent(up{job="blog-metrics-exporter"} == 1)` for 15m.
  - `BlogPageviewsDropWoW`: `blog_pageviews{window="7d"} < 0.7 * (blog_pageviews{window="7d"} offset 7d)` for 6h.

  Tests:
  - Each alert fires on synthetic series.
  - A source with recent success does not fire.
  - A 25% drop does not fire.
- [ ] **Step 2:** `promtool test rules rack-control/prometheusrules/blog-metrics-alerts.test.yaml` FAILS (no rules file).
- [ ] **Step 3: Write the rules**, then run `promtool check rules`. Then write `blog-metrics-exporter.yaml`, copying the noc exporter's securityContext, probes and resources:
  - Three ExternalSecrets give Secret `blog-metrics-exporter` with the keys `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`, `GSC_KEY_JSON` and `BUFFER_API_KEY`. That is one ExternalSecret with four `data` entries from three Vault keys, `refreshInterval 1h`.
  - The Deployment uses `envFrom` that Secret plus a literal env for the non-secret settings, and image `harbor.support.tools/supporttools/blog-metrics-exporter:0.1.0`.
  - The Service and ServiceMonitor scrape every 60 s, `scrapeTimeout 20s`, with `job` relabelled to `blog-metrics-exporter`.
  - The file header carries the runbook: build, push, apply, verify.
- [ ] **Step 4:** `promtool test rules` PASSES. Then run these renders (no apply yet):

  ```bash
  kubectl apply --dry-run=client -f monitoring/a1-ops-prd/blog-metrics-exporter.yaml
  kubectl kustomize Dashboards/ | grep blog-traffic
  ```
- [ ] **Step 5: Grafana dashboard** `Dashboards/CoreInfra/blog-traffic.json`, with the datasource uid copied from a sibling dashboard. Its rows:
  1. Traffic: pageviews and visitors 7d, bot share, WoW %.
  2. Channels.
  3. Topics (pageviews, read rate, search clicks).
  4. Kinds.
  5. Search totals, plus CTR and position.
  6. Social.
  7. Source status.

  Add a `configMapGenerator` entry `blog-traffic-dashboard`. Validate with `python3 -m json.tool`.
- [ ] **Step 6:** Commit in cluster-services with the message `feat(monitoring): blog-metrics-exporter, alerts and Grafana dashboard`.

---

### Task 8: Build, deploy, verify (needs the owner's logins)

The owner must provide `vault login` (to check the keys), `docker login harbor.support.tools` (to push) and a kubeconfig for a1-ops-prd (to apply). The project `supporttools` must exist on Harbor; create it if the push says it is missing.

- [ ] **Step 1:** Push the website repo. This deploys `post-index.json`. Then run `curl -s https://support.tools/post-index.json | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"`, which prints a count of 700 or more.
- [ ] **Step 2:** `make -C exporters/blog-metrics image TAG=0.1.0`.
- [ ] **Step 3:** Run a local smoke test with the real keys, loaded from Vault into env vars (never echoed). Run the binary for 2 minutes, then:
  - `curl -s localhost:8080/metrics | grep -c '^blog_'` is greater than 50.
  - `blog_metrics_source_up` is 1 for all three sources.
  - `/report` has non-empty `topics` and `search.queries`.
  - One `curl` of the GSC sitemaps endpoint with the same token confirms ruling 4.
- [ ] **Step 4:** In cluster-services:
  - `kubectl --context a1-ops-prd apply -f monitoring/a1-ops-prd/blog-metrics-exporter.yaml -f monitoring/a1-ops-prd/blog-metrics-alerts.yaml`
  - `kubectl apply -k Dashboards/`

  Then the ExternalSecret must be Ready, the rollout complete, and Prometheus `up{job="blog-metrics-exporter"}` equal to 1 within 5 minutes.
- [ ] **Step 5:** Update `memory/blog-analytics.md` (exporter live, metric names, `/report` URL in cluster) and the spec part 3 with the rulings. Push cluster-services.
