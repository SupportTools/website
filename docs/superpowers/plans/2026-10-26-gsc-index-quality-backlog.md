# GSC index quality backlog (2026-10-26)

Goal: raise the share of production support.tools pages that Google chooses to index. Search Console (sc-domain:support.tools) reports about 3.55K indexed, 2,370 "Crawled - currently not indexed" and 205 "Discovered - currently not indexed".

Out of scope here: duplicate hosts (dev/stg noindex) and broken links. Other work streams own those.

Items marked **OWNER DECISION** need a call from the site owner before anyone implements them.

## Findings

All counts come from the repo on 2026-10-26 (front matter parsed for every file under `blog/content`), the live sitemap and live pages fetched with GET, and the blog-metrics exporter `/report`.

### 1. What is published

| Page type | Count | Source |
|---|---|---|
| Live sitemap URLs (total) | 3,021 | https://support.tools/sitemap.xml |
| Tag term pages | 1,919 | sitemap `/tags/` |
| Category term pages | 157 | sitemap `/categories/` |
| Posts (published: `draft: false`, date on or before today) | 834 | `blog/content/post` |
| Training pages | 77 | `blog/content/training` |
| Known good designs | 16 | `blog/content/known-good-designs` |
| Archive section pages | 5 | `blog/content/archive` |
| Posts in the future-dated queue | 78 | Nov 2026 to Apr 2027, about 13 a month |
| Posts held as drafts | 2,000 | mostly dated 2027 to 2032 |

Posts by year (published): 2019: 6, 2020: 9, 2021: 21, 2022: 21, 2023: 33, 2024: 175, 2025: 252, 2026: 317. Between April and October 2026 the site published 32 to 44 posts a month.

URLs that exist but are not in the sitemap (these make up most of the gap between about 3K sitemap URLs and about 6.1K URLs Google knows about):

- **Markdown copies.** Every page has an `index.md` twin (`[outputs] page = ["HTML", "Markdown"]` in `blog/config.toml`), linked from every page with `<link rel="alternate" type="text/markdown">` (`blog/themes/m10c/layouts/_default/baseof.html:29`). That is about 930 URLs. Live check: `/active-directory-domain-controller-upgrade-adprep-enterprise-guide/index.md` returns 200 `text/markdown` with no `X-Robots-Tag` and no `Link: rel=canonical` header.
- **RSS feeds per term.** Every tag and category has an `index.xml` (for example `/tags/adprep/index.xml` returns 200). That is about 2,070 feed URLs.
- **Paginated lists.** Page size is 8. `/post/page/N/` has 104 pages, `/archive/page/N/` has 104 pages, tag pagination adds 308 pages, and category pagination adds more. `/post/page/3/` and `/archive/page/3/` list exactly the same posts, so 104 page pairs are duplicates of each other.

We do not have the GSC URL list for the 2,370 bucket. The breakdown above is inferred from what the site emits, so step 0 below exists to confirm it.

### 2. Thin tag pages

- 1,915 distinct tags across published pages. Each post carries 6.4 tags on average.
- **1,251 tags have exactly 1 post. 244 have exactly 2. Together that is 1,495 tag pages (78% of all tag pages) that are near-empty listings.** 1,643 tags have 3 or fewer posts and 1,746 have 5 or fewer.
- Synonym tags split the same topic: `go` (79) and `golang` (53), plus many case and spelling variants.
- Categories have an allow-list (`blog/data/categories.yaml`, `scripts/check-categories.mjs`), but 45 of 155 live categories still have 2 or fewer posts. Tags have no allow-list.
- Live check of `/tags/adprep/` (1 post): it returns `index, follow` and a self canonical, and it is in the sitemap.

### 3. Indexing hints the site emits

From `blog/themes/m10c/layouts/_default/baseof.html:27-30` and live pages:

- `<link rel="canonical" href="{{ .Permalink }}">` on every page. **On paginated pages this points to page 1.** `/tags/kubernetes/page/2/`, `/post/page/40/` and `/archive/page/2/` all declare page 1 as canonical, even though they list different posts. Google treats this as a conflicting signal and usually ignores the canonical, or drops page N.
- `robots` is `index, follow, max-image-preview:large` everywhere, unless the page front matter sets `noindex`, which emits `noindex, nofollow`. No post sets it. No taxonomy, pagination or feed rule exists.
- `robots.txt` allows everything.
- The sitemap is Hugo's built-in one. It lists every term page, including the 1,495 thin ones.
- The Markdown and RSS alternates send no indexing headers (see `src/worker.js`. Only `content-signal` and `vary` are added).

### 4. Posts likely judged thin or generic

- **Template-like titles:** 264 of 834 published posts use at least one of "Complete Guide", "Enterprise", "Best Practices", "Comprehensive", "Ultimate", "Master/Mastering". "Enterprise" alone appears in 191 titles and 127 URLs. "Advanced" appears in 116 titles and "Production" in 93. 75 titles end in a year (2023 to 2026). 250 of the 264 were published in 2025 or 2026.
- **Templated descriptions:** 476 of 834 descriptions start with "Master", "Comprehensive", "Complete" or "Learn". 76 posts have no description at all.
- **Low word count:** 71 posts have under 400 words in total and 25 have under 250. Counting prose only (code blocks excluded), 244 posts have under 300 words and 301 more have 300 to 599.
- **A published placeholder:** `blog/content/post/nginx-ingress-controller-tuning.md` (published 2026-10-10, 59 words). Its body is the literal line `[REST OF COMPREHENSIVE 3000+ WORD ARTICLE ...]`. A full article on the same topic already exists at `/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/`, and both are linked from `/post/page/3/`.
- **Duplicate titles:** 3 titles each appear on 2 posts. "Chaos Engineering Implementation with Litmus on Kubernetes" and "Contract Testing for Microservices: Pact vs Spring Cloud Contract" are both doubled. "How to enable legacy TLS versions in Rancher's ingress-nginx" is also the title of `how-to-check-default-coredns-configmap-of-rke-k8s-version.md`, which is a wrong title on a different topic.

### 5. Near-duplicate clusters

Comparing slugs (Jaccard similarity of 0.5 or more after dropping filler words such as enterprise, guide, production, advanced) found **68 clusters holding 184 published posts.** Examples:

- Chaos engineering with Litmus: 4 posts (`/chaos-engineering-litmus-kubernetes/`, `/chaos-engineering-implementation-litmus-kubernetes/`, `/chaos-engineering-litmus-kubernetes-production-guide/`, `/chaos-engineering-kubernetes-microservices-resilience/`).
- Monitoring and observability "enterprise 2025": 5 posts, including `enterprise-cloud-monitoring-observability-comprehensive-guide-2025` and `enterprise-cloud-monitoring-observability-2025-comprehensive-guide` (the same words in a different order).
- Linux kernel modules: 3 posts (`/linux-kernel-module-development/`, `/linux-kernel-module-development-enterprise/`, `/linux-kernel-development-advanced-module-programming/`).
- Pod security: 4 posts (`/kubernetes-pod-security-admission/`, `/kubernetes-pod-security-admission-deep-dive/`, and two more).
- cert-manager: 4 posts. Ingress-nginx CVE-2025-1974: 2 posts covering the same CVE.
- "advanced-linux-*-programming": an 18-post family with the same title template.
- Some clusters are real series and should stay: the RKE1 to RKE2 migration set (by backup tool), `centralized-kubernetes-logging-part1..3`, and the per-exporter Grafana monitoring posts.

By topic: 82 published titles mention Go or Golang and 27 mention RKE2.

### 6. Older and outdated posts

- 57 published posts are dated 2019 to 2022. 27 of them have under 300 words of prose.
- 124 published posts (any year) mention an end-of-life version: Kubernetes 1.25 or older (61), RKE1 (32), PodSecurityPolicy (14), Ubuntu 20.04 or older (15), CentOS (15), Rancher 2.6 or older (5), dockershim (2). 19 of these are pre-2023 posts where the old version is the main subject. Examples: `how-to-retrieve-kubeconfig-from-custom-cluster` ("RKE v0.2.x+ or Rancher v2.2.x+"), `how-to-enable-envoy-access-logging` ("Rancher v2.3+ deployed Istio"), `how-to-change-etcd-ciphers` (RKE1), `docker-bridge-for-rancher-clusters` (2019).

### 7. Search performance (blog-metrics exporter, generated 2026-10-26T17:11Z)

- Last 28 days: 955 clicks, 86,128 impressions, 1.1% CTR, average position 11.3. 4,207 query rows. Only 527 queries have 10 or more impressions, with a median position of 9.1.
- The exporter has no page-level search data, so it cannot tell which URLs earn impressions. The top PostHog pages are long-tail troubleshooting posts (`curl-host-header`, `kubernetes-cpu-limits...`, `restart-exchange-server-services-powershell`), not the "enterprise guide" batch.

### 8. Already done

- The publish queue was already slowed: commits `7af85172` (1,068 broad posts held), `104a5d56` (911 duplicate-head posts held) and `0b10047b` (11 more). The queue now runs about 13 posts a month through April 2027.
- `0b798740` removed off-list category pages and the redirecting C++ tag from the sitemap, and added `src/category-redirects.json` 301s.

## Recommendations, ranked by expected indexed-share gain per unit of effort

The "pages" column is the number of URLs each item touches. Noindexing does not add indexed pages by itself. It removes low-value URLs from the pool Google judges, which raises the indexed share directly and, over time, improves how Google rates the posts that remain.

| # | Recommendation | Pages | Effort |
|---|---|---|---|
| 0 | Get the real URL list for the 2,370 bucket | n/a | 30 min |
| 1 | Noindex and de-sitemap thin tag pages; cap new tags | about 1,495 | small |
| 2 | Keep Markdown and RSS alternates out of the index | about 930 Markdown + about 2,070 feeds | small |
| 3 | Fix pagination: self canonicals, drop the duplicate /post/ list | about 104 duplicates + about 520 canonicals | small |
| 4 | Retire the stub and fix duplicate titles | 4 | tiny |
| 5 | Consolidate near-duplicate clusters with 301s | 60 to 100 retired out of 184 | medium |
| 6 | Refresh or retire outdated posts | 19 core + up to 124 | medium |
| 7 | Rewrite templated titles and descriptions where pages earn impressions | up to 264 titles, 476 descriptions | large, incremental |
| 8 | Keep the queue slow and gate new posts on quality | 78 queued + future posts | small, ongoing |

### 0. Get the real URL list first

- **What:** In Search Console, open Pages, then "Crawled - currently not indexed", and export the list (the UI caps it at 1,000 rows, which is enough to sample). Do the same for "Discovered - currently not indexed". Bucket the rows by pattern: `/tags/`, `/categories/`, `/page/N/`, `index.md`, `index.xml`, posts, and old or redirected URLs.
- **How to decide:** the bucket shares tell you whether 1 to 3 or 5 to 7 matter most. If posts make up more than about 40% of the bucket, move 5 and 7 up.
- **Risk:** none.
- **Check:** a table of bucket counts saved next to this plan.
- **OWNER DECISION:** the owner has to pull the export, because the exporter has no page dimension. Optional follow-up: add the Search Analytics `page` dimension to the exporter so "pages with impressions in the last 28 days" becomes a tracked proxy for indexed posts.

### 1. Noindex thin tag pages and stop making new ones

- **Which pages:** tag term pages with fewer than 3 published posts. That is 1,495 today (1,251 with 1 post, 244 with 2).
- **How:**
  - In `baseof.html`, emit `noindex, follow` (not `nofollow`, so links still pass) when `.Kind` is `term`, the taxonomy is `tags`, and the term has fewer than 3 pages.
  - Add a custom `sitemap.xml` template that skips those terms. Hugo 0.168 is pinned in `.github/workflows/cloudflare-workers.yml`.
  - Add a tag check, alongside `scripts/check-categories.mjs`, that fails when a new post introduces a tag used by no other post, and that maps synonyms (`golang` to `go`).
  - Optionally, render only tags with 3 or more posts as links on post pages, so thin terms lose internal links.
- **How to decide the threshold:** 3 is the default. 5 would cover 1,746 pages. **OWNER DECISION:** the threshold, and whether to also merge synonym tags (merging needs redirects, see Risks).
- **Risks:** Noindex keeps URLs resolving, so `tests/fixtures/published-urls.txt` stays green. Merging or deleting tags removes URLs. Each removed `/tags/x/` then needs a Worker 301 (a `tag-redirects.json` modelled on `src/category-redirects.json`), or the published-URL check fails. A term crossing the threshold flips between index and noindex. That is acceptable.
- **Check:** sitemap URL count drops from 3,021 to about 1,526. Within 4 to 8 weeks, GSC "Excluded by 'noindex' tag" rises by about 1,400 and "Crawled - currently not indexed" falls by a similar amount if step 0 confirms tags make up a large share. Track the indexed/known ratio weekly.

### 2. Keep Markdown and RSS alternates out of the index

- **Which pages:** about 930 `index.md` copies, and about 2,070 term `index.xml` feeds (plus section feeds).
- **How:** In `src/worker.js`, add `X-Robots-Tag: noindex` to responses whose path ends in `/index.md` or `.md`, to the content-negotiated Markdown response, and to term feeds (`/tags/*/index.xml`, `/categories/*/index.xml`). Leave the home feed `/index.xml` alone. A gentler alternative for Markdown is a `Link: <https://support.tools/slug/>; rel="canonical"` header.
- **How to decide:** noindex is the definitive option. Neither header stops AI agents or feed readers from fetching the file, and llms.txt and `Accept: text/markdown` keep working. **OWNER DECISION:** noindex or the canonical Link header for Markdown, and whether to drop per-term RSS feeds entirely (set `[outputs] taxonomy/term = ["HTML"]`). Dropping them removes URLs, which are not in the published-URL fixture (the fixture only tracks `index.html` pages) but may have subscribers.
- **Risks:** low. Add a Worker unit test so the header cannot regress.
- **Check:** `curl -sI https://support.tools/<slug>/index.md` shows the header. In GSC, `.md` and `.xml` URLs move from "Crawled - currently not indexed" to "Excluded by 'noindex' tag".

### 3. Fix pagination signals

- **Which pages:** about 104 `/post/page/N/` pages that duplicate `/archive/page/N/`, plus all paginated pages (about 520) that canonicalize to page 1.
- **How:**
  - Make the canonical self-referencing on paginated pages: use `.Paginator.URL` when `.Paginator.PageNumber` is greater than 1.
  - Pick one full listing. `/archive/` is the documented home feed (the Worker already moves `/page/N/` there). Either 301 `/post/` and `/post/page/N/` to `/archive/` equivalents, or set `noindex, follow` on `/post/` pagination.
  - Leave tag and category pagination indexable but self-canonical.
- **How to decide:** **OWNER DECISION:** redirect or noindex `/post/`. A redirect is cleaner. Note that `/post/` itself is in the published-URL fixture, so it needs a Worker 301 rather than a removal.
- **Risks:** The fixture skips `/page/N/` URLs, so pagination changes do not trip it. Do not noindex `/archive/` pagination, because it is the crawl path to older posts and the 205 "Discovered" URLs likely depend on it.
- **Check:** `curl` of `/archive/page/2/` shows `canonical` equal to `/archive/page/2/`. GSC "Alternate page with proper canonical tag" and "Duplicate, Google chose different canonical" counts for `/page/` URLs fall.

### 4. Retire the stub and fix duplicate titles

- **Which pages:** `/nginx-ingress-controller-tuning/` (the placeholder body), plus the 3 duplicate-title pairs.
- **How:** Set the stub to `draft: true` and add `aliases: ["/nginx-ingress-controller-tuning/"]` on `/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/`, or a Worker 301. Retitle `how-to-check-default-coredns-configmap-of-rke-k8s-version.md` to match its content. Merge or retitle the Litmus and Pact duplicates (they fold into 5).
- **Risks:** `/nginx-ingress-controller-tuning/` is published, so it needs the alias or 301. Add a CI check that fails on bracketed placeholder lines (`^\[(REST OF|Continue|More )`) outside code fences. The `empty-pages` agent may already be on this, so check before starting.
- **Check:** the published-URL check passes, and a grep for placeholder markers in published posts returns 0.

### 5. Consolidate near-duplicate clusters with 301s

- **Which pages:** the 68 slug-similarity clusters (184 posts). Start with the obvious ones: Litmus chaos (4), enterprise monitoring 2025 (5), kernel modules (3), pod security (4), cert-manager (4), the ingress-nginx CVE pair, and the reordered-slug twins.
- **How to decide per cluster:** keep the post with GSC impressions or clicks (from step 0, or a page-dimension query). If none have any, keep the most complete and most recent. Merge any unique sections into the keeper. Keep real series (RKE1 to RKE2 by backup tool, logging parts 1 to 3, per-exporter monitoring) and cross-link them instead.
- **How:** Add a `src/post-redirects.json` map in the Worker (a real 301, preferred over Hugo `aliases`, which emit meta-refresh pages). Set retired posts to `draft: true`. Expect 60 to 100 URLs retired.
- **Risks:** Every retired URL is in `tests/fixtures/published-urls.txt` and must resolve through the redirect map, or CI fails. Remove retired URLs from IndexNow and social queues (`scripts/indexnow.mjs`, Buffer). Do not 301 to a page on a different topic, because Google treats that as a soft 404.
- **Check:** the published-URL check passes. After 6 to 8 weeks, impressions for the keeper URLs are at least the sum of the retired ones, and GSC shows the retired URLs as "Page with redirect".
- **OWNER DECISION:** which post survives in each cluster.

### 6. Refresh or retire outdated posts

- **Which pages:** the 19 pre-2023 posts whose subject is an end-of-life version, then the wider set of 124 posts that mention one.
- **How to decide:**
  - Has impressions or a still-supported product: refresh it. Update the versions, set `applies_to` and `last_validated`, and bump `lastmod`.
  - RKE1 only, no impressions, and an RKE2 equivalent exists: retire it with a 301 to that equivalent.
  - Historical value only: keep it, add a "legacy" note, and accept that it may stay unindexed.
- **Risks:** retirements need redirects (same as item 5). Coordinate with the `guide-refresh`, `k8s-refresh` and `page-refresh` work streams so posts are not edited twice.
- **Check:** a list of the 19 posts, each with an outcome (refreshed, retired, legacy). Six weeks after a refresh, compare that post's impressions with its earlier level.
- **OWNER DECISION:** whether RKE1 content stays at all.

### 7. Rewrite templated titles and descriptions, starting where pages already earn impressions

- **Which pages:** the 264 posts with template phrases in the title and the 476 descriptions that open with Master, Comprehensive, Complete or Learn. 76 posts have no description.
- **How:** Work in impression order, not all at once. Replace "X: Complete Enterprise Guide" with the concrete problem and outcome (for example "Ingress-nginx 502s after a config reload: causes and fixes"). Write descriptions that name the error, command or version. Keep URLs unchanged, because titles can change freely.
- **How to decide on retiring:** after the rewrite, if a post is still "Crawled - currently not indexed" after 6 months with 0 impressions, add it to the item 5 retirement list.
- **OWNER DECISION:** whether to set a time-boxed rule like "0 impressions in 6 months means noindex or retire" for the 2025 to 2026 "enterprise guide" batch (569 posts published in those two years).
- **Risks:** none for URLs. Watch CTR on posts that already rank.
- **Check:** template-phrase count in published titles falls from 264. Posts with impressions in the last 28 days (exporter, once it has a page dimension) rises.

### 8. Keep the publish queue slow and gate new posts

- **Which pages:** the 78 queued posts (Nov 2026 to Apr 2027) and anything new.
- **How:** Keep the queue at or below about 3 posts a week, which it already is. Before a queued post goes live, run the `blog-dedupe` skill against published posts, and check it for: no new single-use tags (item 1), no placeholder markers (item 4), at least 600 words of prose, and a specific title. Do not release the 2,000 held drafts without the same gate.
- **Risks:** none.
- **Check:** in GSC, new URLs reach "Indexed" within 4 weeks at a higher rate than the 2026 cohort. Track the share of each month's posts that have at least 1 impression by day 30.

## Suggested order

1. Step 0, the GSC export.
2. Items 1, 2, 3 and 4 in one PR: templates, Worker headers and a stub fix, with no content decisions needed beyond the thresholds.
3. Items 5 and 6, cluster by cluster, each with a redirect map entry.
4. Items 7 and 8 as ongoing work.

Re-measure the GSC Pages report 4 weeks and 8 weeks after the first PR deploys. Record indexed, crawled-not-indexed, discovered-not-indexed, excluded-by-noindex and sitemap URL count each time.
